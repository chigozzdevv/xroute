import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DISPATCH_MODES,
  assertAddress,
  assertHexString,
  assertIncluded,
  assertNonEmptyString,
  toBigInt,
} from "../xroute-types/index.mjs";
import { createDispatchEnvelope } from "../xroute-xcm/index.mjs";
import {
  createDestinationExecutionStartedEvent,
  createIntentDispatchedEvent,
  createIntentSubmittedEvent,
} from "./status-indexer.mjs";

const execFileAsync = promisify(execFile);
const SUBMIT_INTENT_SIGNATURE =
  "submitIntent((uint8,address,uint128,uint128,uint128,uint128,uint64,bytes32))";
const DISPATCH_INTENT_SIGNATURE = "dispatchIntent(bytes32,(uint8,bytes,bytes))";
const APPROVE_SIGNATURE = "approve(address,uint256)";
const ALLOWANCE_SIGNATURE = "allowance(address,address)(uint256)";
const PREVIEW_LOCKED_AMOUNT_SIGNATURE =
  "previewLockedAmount((uint8,address,uint128,uint128,uint128,uint128,uint64,bytes32))(uint128)";
const NEXT_INTENT_NONCE_SIGNATURE = "nextIntentNonce()(uint256)";
const HASH_INTENT_SIGNATURE = "f(address,uint256,uint8,address,uint128,uint128,uint128,uint128,uint64,bytes32)";
const HASH_DISPATCH_SIGNATURE = "f(uint8,bytes,bytes)";

export function createCastRouterAdapter({
  rpcUrl,
  routerAddress,
  privateKey,
  ownerAddress,
  castBin = "cast",
  cwd,
  env,
  statusIndexer = null,
  eventClock = () => Math.floor(Date.now() / 1000),
  commandRunner = defaultCommandRunner,
  autoApprove = true,
} = {}) {
  const normalizedRpcUrl = assertNonEmptyString("rpcUrl", rpcUrl);
  const normalizedRouterAddress = assertAddress("routerAddress", routerAddress);
  const normalizedPrivateKey = assertHexString("privateKey", privateKey);
  const normalizedOwnerAddress = ownerAddress
    ? assertAddress("ownerAddress", ownerAddress)
    : null;

  let nextSequence = 0;
  let cachedSignerAddress = normalizedOwnerAddress;

  async function getSignerAddress() {
    if (cachedSignerAddress) {
      return cachedSignerAddress;
    }

    cachedSignerAddress = assertAddress(
      "signerAddress",
      await runCast(["wallet", "address", "--private-key", normalizedPrivateKey]),
    );
    return cachedSignerAddress;
  }

  async function submitIntent({ owner, intent, quote, request }) {
    const signerAddress = await getSignerAddress();
    if (owner) {
      const normalizedOwner = assertAddress("owner", owner);
      if (normalizedOwner !== signerAddress) {
        throw new Error(`owner ${normalizedOwner} does not match signer ${signerAddress}`);
      }
    }

    const lockedAmount = await previewLockedAmount(request);
    if (autoApprove) {
      await ensureAllowance({
        assetAddress: request.asset,
        ownerAddress: signerAddress,
        spenderAddress: normalizedRouterAddress,
        requiredAmount: lockedAmount,
      });
    }

    const nonce = await readUint256(normalizedRouterAddress, NEXT_INTENT_NONCE_SIGNATURE);
    const txHash = await sendTransaction(
      normalizedRouterAddress,
      SUBMIT_INTENT_SIGNATURE,
      [formatIntentRequestTuple(request)],
    );
    const intentId = await computeIntentId({
      ownerAddress: signerAddress,
      nonce,
      request,
    });

    if (statusIndexer) {
      statusIndexer.ingest(
        createIntentSubmittedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId,
          quoteId: quote.quoteId,
          owner: signerAddress,
          sourceChain: intent.sourceChain,
          destinationChain: intent.destinationChain,
          actionType: intent.action.type,
          asset: quote.submission.asset,
          amount: quote.submission.amount,
        }),
      );
    }

    return {
      intentId,
      txHash,
      lockedAmount,
      request,
    };
  }

  async function dispatchIntent({ intentId, request }) {
    const normalizedIntentId = assertHexString("intentId", intentId);
    const txHash = await sendTransaction(
      normalizedRouterAddress,
      DISPATCH_INTENT_SIGNATURE,
      [normalizedIntentId, formatDispatchRequestTuple(request)],
    );

    if (statusIndexer) {
      const envelope = createDispatchEnvelope({
        mode: request.mode === 0 ? DISPATCH_MODES.EXECUTE : DISPATCH_MODES.SEND,
        destinationHex: request.destination,
        messageHex: request.message,
      });
      statusIndexer.ingest(
        createIntentDispatchedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          dispatchMode: envelope.mode,
          executionHash: await computeDispatchExecutionHash(request),
        }),
      );

      if (envelope.mode === DISPATCH_MODES.EXECUTE) {
        statusIndexer.ingest(
          createDestinationExecutionStartedEvent({
            at: eventClock(),
            sequence: nextSequence++,
            intentId: normalizedIntentId,
          }),
        );
      }
    }

    return {
      intentId: normalizedIntentId,
      txHash,
      request,
    };
  }

  async function previewLockedAmount(request) {
    return readUint256(
      normalizedRouterAddress,
      PREVIEW_LOCKED_AMOUNT_SIGNATURE,
      [formatIntentRequestTuple(request)],
    );
  }

  async function ensureAllowance({
    assetAddress,
    ownerAddress: tokenOwner,
    spenderAddress,
    requiredAmount,
  }) {
    const currentAllowance = await readUint256(assetAddress, ALLOWANCE_SIGNATURE, [
      assertAddress("tokenOwner", tokenOwner),
      assertAddress("spenderAddress", spenderAddress),
    ]);

    if (currentAllowance >= requiredAmount) {
      return null;
    }

    return sendTransaction(assetAddress, APPROVE_SIGNATURE, [
      assertAddress("spenderAddress", spenderAddress),
      requiredAmount.toString(),
    ]);
  }

  async function computeIntentId({ ownerAddress: owner, nonce, request }) {
    const encoded = await runCast([
      "abi-encode",
      HASH_INTENT_SIGNATURE,
      assertAddress("ownerAddress", owner),
      nonce.toString(),
      String(request.actionType),
      assertAddress("request.asset", request.asset),
      toUintString(request.amount),
      toUintString(request.xcmFee),
      toUintString(request.destinationFee),
      toUintString(request.minOutputAmount),
      String(request.deadline),
      assertHexString("request.executionHash", request.executionHash),
    ]);

    return assertHexString("intentId", await runCast(["keccak", encoded]));
  }

  async function computeDispatchExecutionHash(request) {
    const encoded = await runCast([
      "abi-encode",
      HASH_DISPATCH_SIGNATURE,
      String(normalizeDispatchMode(request.mode)),
      assertHexString("request.destination", request.destination),
      assertHexString("request.message", request.message),
    ]);

    return assertHexString("executionHash", await runCast(["keccak", encoded]));
  }

  async function readUint256(contractAddress, signature, args = []) {
    const output = await runCast([
      "call",
      assertAddress("contractAddress", contractAddress),
      signature,
      ...args.map(String),
      "--rpc-url",
      normalizedRpcUrl,
    ]);

    return parseUint256(output);
  }

  async function sendTransaction(contractAddress, signature, args = []) {
    const output = await runCast([
      "send",
      assertAddress("contractAddress", contractAddress),
      signature,
      ...args.map(String),
      "--rpc-url",
      normalizedRpcUrl,
      "--private-key",
      normalizedPrivateKey,
      "--json",
    ]);

    return extractTransactionHash(output);
  }

  async function runCast(args) {
    const result = await commandRunner({
      command: castBin,
      args,
      cwd,
      env,
    });
    return String(result?.stdout ?? result ?? "").trim();
  }

  return {
    submitIntent,
    dispatchIntent,
    previewLockedAmount,
    getSignerAddress,
  };
}

export function createStaticAssetAddressResolver(addressesByChain) {
  return async ({ chainKey, assetKey }) => {
    const chainAddresses = addressesByChain?.[assertNonEmptyString("chainKey", chainKey)];
    if (!chainAddresses) {
      throw new Error(`missing asset address map for chain ${chainKey}`);
    }

    const address = chainAddresses[assertNonEmptyString("assetKey", assetKey)];
    if (!address) {
      throw new Error(`missing asset address for ${assetKey} on ${chainKey}`);
    }

    return assertAddress("assetAddress", address);
  };
}

function formatIntentRequestTuple(request) {
  return `(${String(request.actionType)},${assertAddress("request.asset", request.asset)},${toUintString(
    request.amount,
  )},${toUintString(request.xcmFee)},${toUintString(request.destinationFee)},${toUintString(
    request.minOutputAmount,
  )},${String(request.deadline)},${assertHexString(
    "request.executionHash",
    request.executionHash,
  )})`;
}

function formatDispatchRequestTuple(request) {
  const mode = normalizeDispatchMode(request.mode);
  return `(${mode},${assertHexString("request.destination", request.destination)},${assertHexString(
    "request.message",
    request.message,
  )})`;
}

function normalizeDispatchMode(mode) {
  if (mode === 0 || mode === 1) {
    return mode;
  }

  return assertIncluded("request.mode", mode, [0, 1]);
}

function toUintString(value) {
  return toBigInt(value, "uint256").toString();
}

function parseUint256(value) {
  const normalized = value.trim();
  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return BigInt(normalized);
  }
  if (/^\d+$/.test(normalized)) {
    return BigInt(normalized);
  }

  throw new Error(`unable to parse uint256 from cast output: ${normalized}`);
}

function extractTransactionHash(value) {
  const normalized = value.trim();
  try {
    const parsed = JSON.parse(normalized);
    const candidate =
      parsed.transactionHash ?? parsed.txHash ?? parsed.hash ?? parsed.receipt?.transactionHash;
    if (candidate) {
      return assertHexString("transactionHash", candidate);
    }
  } catch {}

  const matched = normalized.match(/0x[0-9a-fA-F]{64}/);
  if (!matched) {
    throw new Error(`unable to parse transaction hash from cast output: ${normalized}`);
  }

  return matched[0].toLowerCase();
}

async function defaultCommandRunner({ command, args, cwd, env }) {
  return execFileAsync(command, args, {
    cwd,
    env,
    maxBuffer: 1024 * 1024,
  });
}
