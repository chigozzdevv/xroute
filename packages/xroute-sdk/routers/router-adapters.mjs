import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";

import {
  DISPATCH_MODES,
  assertAddress,
  assertBytes32Hex,
  assertHexString,
  assertIncluded,
  assertNonEmptyString,
  toBigInt,
} from "../../xroute-types/index.mjs";
import { createDispatchEnvelope, getDefaultXcmCodecContext } from "../../xroute-xcm/index.mjs";
import {
  createDestinationExecutionFailedEvent,
  createDestinationExecutionStartedEvent,
  createDestinationExecutionSucceededEvent,
  createIntentDispatchedEvent,
  createIntentSubmittedEvent,
  createRefundIssuedEvent,
} from "../indexers/status-events.mjs";
import { NATIVE_ASSET_ADDRESS } from "./constants.mjs";
import {
  createSr25519SignerContext,
  createSubstrateXcmAdapter as createSharedSubstrateXcmAdapter,
} from "./substrate-xcm-adapter.mjs";

export { NATIVE_ASSET_ADDRESS } from "./constants.mjs";

const execFileAsync = promisify(execFile);
const SUBMIT_INTENT_SIGNATURE =
  "submitIntent((uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32))";
const DISPATCH_INTENT_SIGNATURE = "dispatchIntent(bytes32,(uint8,bytes,bytes))";
const FINALIZE_SUCCESS_SIGNATURE = "finalizeSuccess(bytes32,bytes32,bytes32,uint128)";
const FINALIZE_FAILURE_SIGNATURE = "finalizeFailure(bytes32,bytes32,bytes32)";
const REFUND_FAILED_INTENT_SIGNATURE = "refundFailedIntent(bytes32,uint128)";
const APPROVE_SIGNATURE = "approve(address,uint256)";
const ALLOWANCE_SIGNATURE = "allowance(address,address)(uint256)";
const PREVIEW_LOCKED_AMOUNT_SIGNATURE =
  "previewLockedAmount((uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32))(uint128)";
const PREVIEW_REFUNDABLE_AMOUNT_SIGNATURE = "previewRefundableAmount(bytes32)(uint128)";
const NEXT_INTENT_NONCE_SIGNATURE = "nextIntentNonce()(uint256)";
const HASH_INTENT_SIGNATURE =
  "f(address,uint256,uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32)";
const HASH_DISPATCH_SIGNATURE = "f(uint8,bytes,bytes)";

export function createSourceAwareRouterAdapter({ adaptersByChain } = {}) {
  const entries = Object.entries(adaptersByChain ?? {}).map(([chainKey, adapter]) => [
    assertNonEmptyString("chainKey", chainKey),
    adapter,
  ]);

  if (entries.length === 0) {
    throw new Error("adaptersByChain must contain at least one router adapter");
  }

  const adapterMap = new Map(entries);
  const intentChainById = new Map();

  return {
    async submitIntent({ intent, ...rest }) {
      const chainKey = assertNonEmptyString("intent.sourceChain", intent?.sourceChain);
      const adapter = requireRouterAdapter(chainKey);
      const submitted = await adapter.submitIntent({ intent, ...rest });
      const intentId = assertBytes32Hex("intentId", submitted?.intentId);
      intentChainById.set(intentId, chainKey);
      return submitted;
    },

    async dispatchIntent({ intentId, chainKey, ...rest }) {
      const adapter = resolveAdapterForIntent({ intentId, chainKey });
      return adapter.dispatchIntent({
        intentId: assertBytes32Hex("intentId", intentId),
        ...rest,
      });
    },

    async finalizeSuccess({ intentId, chainKey, ...rest }) {
      const adapter = resolveAdapterForIntent({ intentId, chainKey });
      return adapter.finalizeSuccess({
        intentId: assertBytes32Hex("intentId", intentId),
        ...rest,
      });
    },

    async finalizeFailure({ intentId, chainKey, ...rest }) {
      const adapter = resolveAdapterForIntent({ intentId, chainKey });
      return adapter.finalizeFailure({
        intentId: assertBytes32Hex("intentId", intentId),
        ...rest,
      });
    },

    async refundFailedIntent({ intentId, chainKey, ...rest }) {
      const adapter = resolveAdapterForIntent({ intentId, chainKey });
      return adapter.refundFailedIntent({
        intentId: assertBytes32Hex("intentId", intentId),
        ...rest,
      });
    },

    async previewRefundableAmount(intentId, { chainKey } = {}) {
      const adapter = resolveAdapterForIntent({ intentId, chainKey });
      if (!adapter.previewRefundableAmount) {
        throw new Error("previewRefundableAmount is not supported by the selected router adapter");
      }
      return adapter.previewRefundableAmount(assertBytes32Hex("intentId", intentId));
    },
  };

  function resolveAdapterForIntent({ intentId, chainKey }) {
    if (chainKey) {
      return requireRouterAdapter(assertNonEmptyString("chainKey", chainKey));
    }

    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const storedChainKey = intentChainById.get(normalizedIntentId);
    if (!storedChainKey) {
      throw new Error(
        `missing source-chain router mapping for intent ${normalizedIntentId}; submit with this adapter first or provide chainKey`,
      );
    }

    return requireRouterAdapter(storedChainKey);
  }

  function requireRouterAdapter(chainKey) {
    const adapter = adapterMap.get(chainKey);
    if (!adapter) {
      throw new Error(`missing router adapter for source chain ${chainKey}`);
    }
    return adapter;
  }
}

export function createSubstrateXcmAdapter({
  clientFactory = defaultSubstrateClientFactory,
  signerFactory = createSr25519SignerContext,
  codecContext = getDefaultXcmCodecContext(),
  ...options
} = {}) {
  return createSharedSubstrateXcmAdapter({
    ...options,
    clientFactory,
    signerFactory,
    codecContext,
  });
}

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
  gasLimit = null,
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
    if (autoApprove && !isNativeAssetAddress(request.asset)) {
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
      { value: isNativeAssetAddress(request.asset) ? lockedAmount : null },
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
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
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

  async function finalizeSuccess({
    intentId,
    outcomeReference,
    resultAssetId,
    resultAmount,
  }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const normalizedOutcomeReference = assertBytes32Hex(
      "outcomeReference",
      outcomeReference,
    );
    const normalizedResultAssetId = assertBytes32Hex("resultAssetId", resultAssetId);
    const normalizedResultAmount = toUintString(resultAmount);
    const txHash = await sendTransaction(normalizedRouterAddress, FINALIZE_SUCCESS_SIGNATURE, [
      normalizedIntentId,
      normalizedOutcomeReference,
      normalizedResultAssetId,
      normalizedResultAmount,
    ]);

    if (statusIndexer) {
      statusIndexer.ingest(
        createDestinationExecutionSucceededEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          resultAsset: normalizedResultAssetId,
          resultAmount: toBigInt(resultAmount, "resultAmount"),
          destinationTxHash: normalizedOutcomeReference,
        }),
      );
    }

    return {
      intentId: normalizedIntentId,
      txHash,
      outcomeReference: normalizedOutcomeReference,
      resultAssetId: normalizedResultAssetId,
      resultAmount: toBigInt(resultAmount, "resultAmount"),
    };
  }

  async function finalizeFailure({ intentId, outcomeReference, failureReasonHash }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const normalizedOutcomeReference = assertBytes32Hex(
      "outcomeReference",
      outcomeReference,
    );
    const normalizedFailureReasonHash = assertBytes32Hex(
      "failureReasonHash",
      failureReasonHash,
    );
    const txHash = await sendTransaction(normalizedRouterAddress, FINALIZE_FAILURE_SIGNATURE, [
      normalizedIntentId,
      normalizedOutcomeReference,
      normalizedFailureReasonHash,
    ]);

    if (statusIndexer) {
      statusIndexer.ingest(
        createDestinationExecutionFailedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          reason: normalizedFailureReasonHash,
        }),
      );
    }

    return {
      intentId: normalizedIntentId,
      txHash,
      outcomeReference: normalizedOutcomeReference,
      failureReasonHash: normalizedFailureReasonHash,
    };
  }

  async function refundFailedIntent({ intentId, refundAmount, refundAsset }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const normalizedRefundAmount = toBigInt(refundAmount, "refundAmount");
    const txHash = await sendTransaction(normalizedRouterAddress, REFUND_FAILED_INTENT_SIGNATURE, [
      normalizedIntentId,
      normalizedRefundAmount.toString(),
    ]);

    if (statusIndexer) {
      statusIndexer.ingest(
        createRefundIssuedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          refundAsset: resolveRefundAsset({ intentId: normalizedIntentId, refundAsset }),
          refundAmount: normalizedRefundAmount,
        }),
      );
    }

    return {
      intentId: normalizedIntentId,
      txHash,
      refundAmount: normalizedRefundAmount,
    };
  }

  async function previewLockedAmount(request) {
    return readUint256(
      normalizedRouterAddress,
      PREVIEW_LOCKED_AMOUNT_SIGNATURE,
      [formatIntentRequestTuple(request)],
    );
  }

  async function previewRefundableAmount(intentId) {
    return readUint256(normalizedRouterAddress, PREVIEW_REFUNDABLE_AMOUNT_SIGNATURE, [
      assertBytes32Hex("intentId", intentId),
    ]);
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
      assertAddress("request.refundAddress", request.refundAddress),
      toUintString(request.amount),
      toUintString(request.xcmFee),
      toUintString(request.destinationFee),
      toUintString(request.minOutputAmount),
      String(request.deadline),
      assertHexString("request.executionHash", request.executionHash),
    ]);

    return assertBytes32Hex("intentId", await runCast(["keccak", encoded]));
  }

  async function computeDispatchExecutionHash(request) {
    const encoded = await runCast([
      "abi-encode",
      HASH_DISPATCH_SIGNATURE,
      String(normalizeDispatchMode(request.mode)),
      assertHexString("request.destination", request.destination),
      assertHexString("request.message", request.message),
    ]);

    return assertBytes32Hex("executionHash", await runCast(["keccak", encoded]));
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

  async function sendTransaction(contractAddress, signature, args = [], options = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const command = [
        "send",
        assertAddress("contractAddress", contractAddress),
        signature,
        ...args.map(String),
        "--rpc-url",
        normalizedRpcUrl,
        "--private-key",
        normalizedPrivateKey,
        "--json",
      ];
      if (options.value !== undefined && options.value !== null) {
        command.push("--value", toUintString(options.value));
      }
      if (gasLimit !== undefined && gasLimit !== null) {
        command.push("--gas-limit", toUintString(gasLimit));
      }

      try {
        const output = await runCast(command);
        assertTransactionDidNotRevert(output);

        return extractTransactionHash(output);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && /nonce too low/i.test(message)) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error("failed to send transaction");
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
    routerAddress: normalizedRouterAddress,
    submitIntent,
    dispatchIntent,
    finalizeSuccess,
    finalizeFailure,
    refundFailedIntent,
    previewLockedAmount,
    previewRefundableAmount,
    getSignerAddress,
  };

  function resolveRefundAsset({ intentId, refundAsset }) {
    if (refundAsset) {
      return assertNonEmptyString("refundAsset", refundAsset);
    }

    const indexedStatus = statusIndexer?.getStatus?.(intentId);
    if (indexedStatus?.asset) {
      return assertNonEmptyString("status.asset", indexedStatus.asset);
    }

    throw new Error("refundAsset is required when the status indexer has no source asset for the intent");
  }
}

function defaultSubstrateClientFactory({ rpcUrl }) {
  return createClient(getWsProvider(assertNonEmptyString("rpcUrl", rpcUrl)));
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

function isNativeAssetAddress(address) {
  return assertAddress("assetAddress", address) === NATIVE_ASSET_ADDRESS;
}

export function encodeAssetIdSymbol(assetSymbol) {
  const normalized = assertNonEmptyString("assetSymbol", assetSymbol).toUpperCase();
  const bytes = Buffer.alloc(32);
  Buffer.from(normalized, "utf8").copy(bytes, 0, 0, Math.min(32, normalized.length));
  return `0x${bytes.toString("hex")}`;
}

function formatIntentRequestTuple(request) {
  return `(${String(request.actionType)},${assertAddress("request.asset", request.asset)},${assertAddress(
    "request.refundAddress",
    request.refundAddress,
  )},${toUintString(request.amount)},${toUintString(request.xcmFee)},${toUintString(
    request.destinationFee,
  )},${toUintString(request.minOutputAmount)},${String(request.deadline)},${assertHexString(
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
  const hexMatch = normalized.match(/^(0x[0-9a-f]+)/i);
  if (hexMatch) {
    return BigInt(hexMatch[1]);
  }

  const decimalMatch = normalized.match(/^(\d+)/);
  if (decimalMatch) {
    return BigInt(decimalMatch[1]);
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

function assertTransactionDidNotRevert(value) {
  const normalized = value.trim();

  try {
    const parsed = JSON.parse(normalized);
    const status = parsed.status ?? parsed.receipt?.status;
    if (status === undefined || status === null) {
      return;
    }

    const normalizedStatus =
      typeof status === "string" ? status.trim().toLowerCase() : String(status);
    if (normalizedStatus === "0x1" || normalizedStatus === "1") {
      return;
    }

    const revertReason =
      parsed.revertReason ?? parsed.receipt?.revertReason ?? "transaction reverted";
    throw new Error(revertReason);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return;
    }
    throw error;
  }
}

async function defaultCommandRunner({ command, args, cwd, env }) {
  return execFileAsync(command, args, {
    cwd,
    env,
    maxBuffer: 1024 * 1024,
  });
}
