import { AccountId } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes as hexToBytesRaw } from "@noble/hashes/utils.js";
import { getPublicKey, secretFromSeed, sign as signSr25519 } from "@scure/sr25519";

import {
  DISPATCH_MODES,
  assertBytes32Hex,
  assertHexString,
  assertIncluded,
  assertInteger,
  assertNonEmptyString,
  toBigInt,
} from "../../xroute-types/index.mjs";
import {
  getDefaultXcmCodecContext,
} from "../../xroute-xcm/index.mjs";
import {
  createDestinationExecutionFailedEvent,
  createDestinationExecutionStartedEvent,
  createDestinationExecutionSucceededEvent,
  createIntentDispatchedEvent,
  createIntentSubmittedEvent,
  createRefundIssuedEvent,
} from "../indexers/status-events.mjs";

const textEncoder = new TextEncoder();
const SUBSTRATE_FEE_ASSET_METADATA = Object.freeze({
  hydration: Object.freeze({
    asset: "HDX",
    decimals: 12,
  }),
  bifrost: Object.freeze({
    asset: "BNC",
    decimals: 12,
  }),
});

export function createSubstrateXcmAdapter({
  chainKey,
  rpcUrl,
  privateKey,
  ownerAddress = null,
  codecContext = getDefaultXcmCodecContext(),
  statusIndexer = null,
  eventClock = () => Math.floor(Date.now() / 1000),
  clientFactory,
  signerFactory = createSr25519SignerContext,
  xcmPalletNames = ["PolkadotXcm", "XcmPallet"],
  xcmWeightRuntimeApis = ["XcmPaymentApi"],
} = {}) {
  if (typeof clientFactory !== "function") {
    throw new Error("clientFactory is required");
  }

  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const normalizedRpcUrl = assertNonEmptyString("rpcUrl", rpcUrl);
  const signerContext = signerFactory({
    privateKey,
    ownerAddress,
  });
  const submissionsByIntentId = new Map();
  let nextSequence = 0;
  let clientPromise;

  async function getUnsafeApi() {
    clientPromise ??= Promise.resolve(clientFactory({ rpcUrl: normalizedRpcUrl }));
    const client = await clientPromise;
    if (!client?.getUnsafeApi) {
      throw new Error("clientFactory must return an object with getUnsafeApi()");
    }
    return client.getUnsafeApi();
  }

  async function submitIntent({ owner, intent, quote, request }) {
    assertSubstrateOwnerMatches(owner, signerContext.accountIdHex);
    const platformFee = toBigInt(
      quote?.fees?.platformFee?.amount ?? 0n,
      "quote.fees.platformFee.amount",
    );
    const normalizedIntentId = deriveSubstrateIntentId({
      ownerAccountIdHex: signerContext.accountIdHex,
      quoteId: assertBytes32Hex("quote.quoteId", quote?.quoteId ?? intent?.quoteId),
      sequence: nextSequence,
      at: eventClock(),
    });
    const lockedAmount = sumLockedAmount({
      amount: request?.amount,
      xcmFee: request?.xcmFee,
      destinationFee: request?.destinationFee,
      platformFee,
    });
    const refundableAmount = sumLockedAmount({
      amount: request?.amount,
      xcmFee: request?.xcmFee,
      destinationFee: request?.destinationFee,
      platformFee: 0n,
    });
    const refundAsset = assertNonEmptyString(
      "quote.submission.asset",
      quote?.submission?.asset,
    );

    submissionsByIntentId.set(normalizedIntentId, {
      intentId: normalizedIntentId,
      intent,
      quote,
      request,
      refundAsset,
      platformFee,
      lockedAmount,
      refundableAmount,
      dispatchRequest: null,
      dispatchTxHash: null,
      outcomeReference: null,
      resultAssetId: null,
      resultAmount: null,
      failureReasonHash: null,
      refundAmount: 0n,
      lifecycleStatus: "submitted",
    });

    if (statusIndexer) {
      statusIndexer.ingest(
        createIntentSubmittedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          quoteId: quote.quoteId,
          owner: signerContext.address,
          sourceChain: intent.sourceChain,
          destinationChain: intent.destinationChain,
          actionType: intent.action.type,
          asset: quote.submission.asset,
          amount: quote.submission.amount,
        }),
      );
    } else {
      nextSequence += 1;
    }

    return {
      intentId: normalizedIntentId,
      lockedAmount,
      request,
      strategy: "substrate-xcm-dispatch",
    };
  }

  async function dispatchIntent({ intentId, request }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const submission = requireSubstrateSubmission(normalizedIntentId);
    assertSubmissionLifecycleStatus(submission, normalizedIntentId, ["submitted"]);
    const { normalizedRequest, tx } = await prepareDispatchTransaction(request);

    const txHash = normalizeSubmittedTxHash(await tx.signAndSubmit(signerContext.signer));
    submission.dispatchRequest = normalizedRequest;
    submission.dispatchTxHash = txHash;
    submission.lifecycleStatus = "dispatched";

    if (statusIndexer) {
      statusIndexer.ingest(
        createIntentDispatchedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          dispatchMode:
            normalizedRequest.mode === 0 ? DISPATCH_MODES.EXECUTE : DISPATCH_MODES.SEND,
          executionHash: deriveDispatchExecutionHash(normalizedRequest),
        }),
      );

      if (normalizedRequest.mode === 0) {
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
      sourceChain: normalizedChainKey,
      request: normalizedRequest,
      strategy:
        normalizedRequest.mode === 0 ? "substrate-xcm-execute" : "substrate-xcm-send",
    };
  }

  async function finalizeSuccess({
    intentId,
    outcomeReference,
    resultAssetId,
    resultAmount,
  }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const submission = requireSubstrateSubmission(normalizedIntentId);
    assertSubmissionLifecycleStatus(submission, normalizedIntentId, ["dispatched"]);

    const normalizedOutcomeReference = assertBytes32Hex(
      "outcomeReference",
      outcomeReference,
    );
    const normalizedResultAssetId = assertBytes32Hex("resultAssetId", resultAssetId);
    const normalizedResultAmount = toBigInt(resultAmount, "resultAmount");
    const minimumOutput = toBigInt(
      submission.request?.minOutputAmount ?? 0n,
      "submission.request.minOutputAmount",
    );
    if (normalizedResultAmount < minimumOutput) {
      throw new Error(
        `resultAmount ${normalizedResultAmount} is below minOutputAmount ${minimumOutput}`,
      );
    }

    submission.lifecycleStatus = "settled";
    submission.outcomeReference = normalizedOutcomeReference;
    submission.resultAssetId = normalizedResultAssetId;
    submission.resultAmount = normalizedResultAmount;
    submission.failureReasonHash = null;

    if (statusIndexer) {
      statusIndexer.ingest(
        createDestinationExecutionSucceededEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          resultAsset: normalizedResultAssetId,
          resultAmount: normalizedResultAmount,
          destinationTxHash: normalizedOutcomeReference,
        }),
      );
    }

    return {
      intentId: normalizedIntentId,
      sourceChain: normalizedChainKey,
      outcomeReference: normalizedOutcomeReference,
      resultAssetId: normalizedResultAssetId,
      resultAmount: normalizedResultAmount,
      strategy: "substrate-source-settlement",
    };
  }

  async function finalizeFailure({ intentId, outcomeReference, failureReasonHash }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const submission = requireSubstrateSubmission(normalizedIntentId);
    assertSubmissionLifecycleStatus(submission, normalizedIntentId, ["dispatched"]);

    const normalizedOutcomeReference = assertBytes32Hex(
      "outcomeReference",
      outcomeReference,
    );
    const normalizedFailureReasonHash = assertBytes32Hex(
      "failureReasonHash",
      failureReasonHash,
    );
    submission.lifecycleStatus = "failed";
    submission.outcomeReference = normalizedOutcomeReference;
    submission.failureReasonHash = normalizedFailureReasonHash;
    submission.resultAssetId = null;
    submission.resultAmount = null;

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
      sourceChain: normalizedChainKey,
      outcomeReference: normalizedOutcomeReference,
      failureReasonHash: normalizedFailureReasonHash,
      strategy: "substrate-source-failure",
    };
  }

  async function refundFailedIntent({ intentId, refundAmount, refundAsset }) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const submission = requireSubstrateSubmission(normalizedIntentId);
    assertSubmissionLifecycleStatus(submission, normalizedIntentId, ["failed"]);

    const normalizedRefundAmount = toBigInt(refundAmount, "refundAmount");
    const remainingRefundable = submission.refundableAmount - submission.refundAmount;
    if (normalizedRefundAmount <= 0n || normalizedRefundAmount !== remainingRefundable) {
      throw new Error(
        `refundAmount ${normalizedRefundAmount} must equal refundable amount ${remainingRefundable}`,
      );
    }

    submission.lifecycleStatus = "refunded";
    submission.refundAmount += normalizedRefundAmount;
    const normalizedRefundAsset = resolveSubstrateRefundAsset({
      intentId: normalizedIntentId,
      submission,
      refundAsset,
    });

    if (statusIndexer) {
      statusIndexer.ingest(
        createRefundIssuedEvent({
          at: eventClock(),
          sequence: nextSequence++,
          intentId: normalizedIntentId,
          refundAsset: normalizedRefundAsset,
          refundAmount: normalizedRefundAmount,
        }),
      );
    }

    return {
      intentId: normalizedIntentId,
      sourceChain: normalizedChainKey,
      refundAmount: normalizedRefundAmount,
      refundAsset: normalizedRefundAsset,
      strategy: "substrate-source-refund",
    };
  }

  async function previewRefundableAmount(intentId) {
    const normalizedIntentId = assertBytes32Hex("intentId", intentId);
    const submission = requireSubstrateSubmission(normalizedIntentId);
    if (submission.lifecycleStatus !== "failed") {
      return 0n;
    }

    return submission.refundableAmount - submission.refundAmount;
  }

  async function estimateSubmissionCost({ owner, quote, request, dispatchRequest }) {
    assertSubstrateOwnerMatches(owner, signerContext.accountIdHex);
    const normalizedRequest = normalizeSubstrateSubmissionRequest({
      ...request,
      platformFee: quote?.fees?.platformFee?.amount ?? request?.platformFee ?? 0n,
    });
    const normalizedDispatchRequest = normalizeDispatchRequest(dispatchRequest);
    const { tx } = await prepareDispatchTransaction(normalizedDispatchRequest);
    const gasFee = toBigInt(
      await tx.getEstimatedFees(signerContext.address),
      "dispatch.getEstimatedFees",
    );
    const feeAsset = resolveSubstrateFeeAssetMetadata(normalizedChainKey);

    return Object.freeze({
      chainKey: normalizedChainKey,
      lockedAmount: sumLockedAmount({
        amount: normalizedRequest.amount,
        xcmFee: normalizedRequest.xcmFee,
        destinationFee: normalizedRequest.destinationFee,
        platformFee: normalizedRequest.platformFee,
      }),
      gasFee,
      gasAsset: feeAsset.asset,
      gasAssetDecimals: feeAsset.decimals,
      gasLimit: null,
      gasPrice: null,
      value: 0n,
    });
  }

  return {
    submitIntent,
    estimateSubmissionCost,
    dispatchIntent,
    finalizeSuccess,
    finalizeFailure,
    refundFailedIntent,
    previewRefundableAmount,
    getSignerAddress() {
      return signerContext.address;
    },
  };

  function requireSubstrateSubmission(intentId) {
    const submission = submissionsByIntentId.get(intentId);
    if (!submission) {
      throw new Error(
        `missing substrate submission context for intent ${intentId}; submit with this adapter first`,
      );
    }

    return submission;
  }

  function assertSubmissionLifecycleStatus(submission, intentId, expectedStatuses) {
    if (expectedStatuses.includes(submission.lifecycleStatus)) {
      return;
    }

    throw new Error(
      `intent ${intentId} is ${submission.lifecycleStatus}; expected ${expectedStatuses.join(" or ")}`,
    );
  }

  function resolveSubstrateRefundAsset({ intentId, submission, refundAsset }) {
    if (refundAsset) {
      return assertNonEmptyString("refundAsset", refundAsset);
    }

    if (submission.refundAsset) {
      return submission.refundAsset;
    }

    const indexedAsset = statusIndexer?.getStatus?.(intentId)?.asset;
    if (indexedAsset) {
      return assertNonEmptyString("status.asset", indexedAsset);
    }

    throw new Error("refundAsset is required when the substrate submission has no tracked source asset");
  }

  async function prepareDispatchTransaction(request) {
    const normalizedRequest = normalizeDispatchRequest(request);
    const unsafeApi = await getUnsafeApi();
    const xcmApi = resolveXcmTransactionApi(unsafeApi, xcmPalletNames);
    const message = codecContext.decodeVersionedXcm(normalizedRequest.message);
    let tx;

    if (normalizedRequest.mode === 0) {
      const maxWeight = await queryXcmWeight({
        unsafeApi,
        message,
        runtimeApis: xcmWeightRuntimeApis,
      });
      tx = xcmApi.execute({
        message,
        max_weight: maxWeight,
      });
    } else {
      tx = xcmApi.send({
        dest: codecContext.decodeVersionedLocation(normalizedRequest.destination),
        message,
      });
    }

    if (typeof tx?.signAndSubmit !== "function") {
      throw new Error("resolved substrate XCM transaction is missing signAndSubmit()");
    }

    return {
      normalizedRequest,
      tx,
    };
  }
}

export function createSr25519SignerContext({ privateKey, ownerAddress } = {}) {
  const secretKey = normalizeSr25519SecretKey(privateKey);
  const publicKey = getPublicKey(secretKey);
  const accountIdHex = `0x${bytesToHex(publicKey)}`;
  const address = AccountId().dec(publicKey);

  if (ownerAddress) {
    assertSubstrateOwnerMatches(ownerAddress, accountIdHex);
  }

  return Object.freeze({
    address,
    accountIdHex,
    signer: getPolkadotSigner(
      publicKey,
      "Sr25519",
      async (input) => signSr25519(secretKey, input),
    ),
  });
}

function normalizeSr25519SecretKey(privateKey) {
  const raw = hexToBytesRaw(assertHexString("privateKey", privateKey));
  if (raw.length === 32) {
    return secretFromSeed(raw);
  }
  if (raw.length === 64) {
    return raw;
  }

  throw new Error("privateKey must be a 32-byte seed or 64-byte sr25519 secret key");
}

function assertSubstrateOwnerMatches(owner, accountIdHex) {
  if (!owner) {
    return;
  }

  const normalizedOwner = normalizeSubstrateAccountId(assertNonEmptyString("owner", owner));
  if (normalizedOwner !== accountIdHex) {
    throw new Error(`owner ${owner} does not match signer ${accountIdHex}`);
  }
}

function normalizeSubstrateAccountId(value) {
  const normalized = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    return normalized.toLowerCase();
  }

  return `0x${bytesToHex(AccountId().enc(normalized))}`;
}

function deriveSubstrateIntentId({ ownerAccountIdHex, quoteId, sequence, at }) {
  const material = [
    assertBytes32Hex("quoteId", quoteId),
    assertHexString("ownerAccountIdHex", ownerAccountIdHex),
    String(assertInteger("sequence", sequence)),
    String(assertInteger("at", at)),
  ].join("|");

  return `0x${bytesToHex(sha256(textEncoder.encode(material)))}`;
}

function sumLockedAmount({ amount, xcmFee, destinationFee, platformFee }) {
  return (
    toBigInt(amount ?? 0n, "amount") +
    toBigInt(xcmFee ?? 0n, "xcmFee") +
    toBigInt(destinationFee ?? 0n, "destinationFee") +
    toBigInt(platformFee ?? 0n, "platformFee")
  );
}

function normalizeSubstrateSubmissionRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request is required");
  }

  return Object.freeze({
    amount: toBigInt(request.amount ?? 0n, "request.amount"),
    xcmFee: toBigInt(request.xcmFee ?? 0n, "request.xcmFee"),
    destinationFee: toBigInt(request.destinationFee ?? 0n, "request.destinationFee"),
    platformFee: toBigInt(request.platformFee ?? 0n, "request.platformFee"),
  });
}

function normalizeDispatchRequest(request) {
  return Object.freeze({
    mode: normalizeDispatchMode(request?.mode),
    destination: assertHexString("request.destination", request?.destination ?? "0x"),
    message: assertHexString("request.message", request?.message),
  });
}

function resolveSubstrateFeeAssetMetadata(chainKey) {
  return SUBSTRATE_FEE_ASSET_METADATA[chainKey] ?? Object.freeze({
    asset: "native",
    decimals: 12,
  });
}

function resolveXcmTransactionApi(unsafeApi, palletNames) {
  for (const palletName of palletNames) {
    const pallet = unsafeApi?.tx?.[palletName];
    if (pallet?.execute && pallet?.send) {
      return pallet;
    }
  }

  throw new Error(
    `unable to find an XCM transaction pallet with execute/send; tried ${palletNames.join(", ")}`,
  );
}

async function queryXcmWeight({ unsafeApi, message, runtimeApis }) {
  for (const apiName of runtimeApis) {
    const runtimeApi = unsafeApi?.apis?.[apiName];
    if (!runtimeApi?.query_xcm_weight) {
      continue;
    }

    const result = await runtimeApi.query_xcm_weight(message);
    if (result?.success === false) {
      throw new Error(`runtime ${apiName}.query_xcm_weight returned an error`);
    }

    const weight = result?.value ?? result;
    if (weight?.ref_time === undefined || weight?.proof_size === undefined) {
      throw new Error(`runtime ${apiName}.query_xcm_weight returned an invalid weight`);
    }

    return {
      ref_time: toBigInt(weight.ref_time, "ref_time"),
      proof_size: toBigInt(weight.proof_size, "proof_size"),
    };
  }

  throw new Error(
    `unable to find a runtime XCM weight API; tried ${runtimeApis.join(", ")}`,
  );
}

function normalizeSubmittedTxHash(value) {
  if (typeof value === "string") {
    return assertHexString("txHash", value);
  }

  if (value && typeof value === "object") {
    const candidate =
      value.txHash ??
      value.transactionHash ??
      value.hash ??
      value.extrinsicHash;
    if (candidate) {
      return assertHexString("txHash", candidate);
    }
  }

  throw new Error(`unable to parse transaction hash from substrate submission result: ${String(value)}`);
}

function deriveDispatchExecutionHash(request) {
  return `0x${bytesToHex(
    sha256(
      textEncoder.encode(
        JSON.stringify({
          mode: normalizeDispatchMode(request.mode),
          destination: assertHexString("request.destination", request.destination),
          message: assertHexString("request.message", request.message),
        }),
      ),
    ),
  )}`;
}

function normalizeDispatchMode(mode) {
  if (mode === 0 || mode === 1) {
    return mode;
  }

  return assertIncluded("request.mode", mode, [0, 1]);
}
