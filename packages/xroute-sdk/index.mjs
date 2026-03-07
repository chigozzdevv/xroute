import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createIntent, toPlainIntent } from "../xroute-intents/index.mjs";
import {
  ACTION_TYPES,
  EXECUTION_TYPES,
  toBigInt,
  assertIncluded,
} from "../xroute-types/index.mjs";
import {
  buildExecutionEnvelope,
  buildDispatchRequest,
  buildRouterIntentRequest,
  createDispatchEnvelope,
} from "../xroute-xcm/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../xroute-precompile-interfaces/index.mjs";

const execFileAsync = promisify(execFile);
let serializedCommandQueue = Promise.resolve();

export function createXRouteClient({
  quoteProvider,
  routerAdapter,
  statusProvider,
  assetAddressResolver,
  xcmEnvelopeBuilder = buildExecutionEnvelope,
  castBin = "cast",
}) {
  if (!quoteProvider?.quote) {
    throw new Error("quoteProvider.quote is required");
  }
  if (!routerAdapter?.submitIntent || !routerAdapter?.dispatchIntent) {
    throw new Error("routerAdapter submitIntent and dispatchIntent are required");
  }
  if (!statusProvider?.getStatus || !statusProvider?.getTimeline || !statusProvider?.subscribe) {
    throw new Error("statusProvider is incomplete");
  }
  if (typeof assetAddressResolver !== "function") {
    throw new Error("assetAddressResolver is required");
  }

  async function quoteIntent(intentInput) {
    const intent = intentInput.quoteId ? intentInput : createIntent(intentInput);
    const quote = normalizeQuote(await quoteProvider.quote(intent));

    if (quote.quoteId !== intent.quoteId) {
      throw new Error("quote id must match the normalized intent quote id");
    }

    return { intent, quote };
  }

  async function submitIntent({ intent, quote, envelope, owner }) {
    const normalizedIntent = intent.quoteId ? intent : createIntent(intent);
    const normalizedQuote = normalizeQuote(quote);
    const normalizedEnvelope = createDispatchEnvelope(
      envelope ?? xcmEnvelopeBuilder({ intent: normalizedIntent, quote: normalizedQuote }),
    );
    const assetAddress = await assetAddressResolver({
      chainKey: normalizedIntent.sourceChain,
      assetKey: normalizedQuote.submission.asset,
    });
    const request = buildRouterIntentRequest({
      intent: normalizedIntent,
      quote: normalizedQuote,
      envelope: normalizedEnvelope,
      assetAddress,
      castBin,
    });

    return routerAdapter.submitIntent({
      owner,
      intent: normalizedIntent,
      quote: normalizedQuote,
      request,
    });
  }

  async function dispatchIntent({ intentId, envelope }) {
    return routerAdapter.dispatchIntent({
      intentId,
      request: buildDispatchRequest(envelope),
    });
  }

  async function executeIntent({ intent, quote, envelope, owner }) {
    const quoted = quote
      ? {
          intent: intent.quoteId ? intent : createIntent(intent),
          quote: normalizeQuote(quote),
        }
      : await quoteIntent(intent);

    if (quoted.quote.quoteId !== quoted.intent.quoteId) {
      throw new Error("quote id must match the normalized intent quote id");
    }

    const resolvedEnvelope =
      envelope ?? xcmEnvelopeBuilder({ intent: quoted.intent, quote: quoted.quote });
    const submitted = await submitIntent({
      intent: quoted.intent,
      quote: quoted.quote,
      envelope: resolvedEnvelope,
      owner,
    });
    const dispatched = await dispatchIntent({
      intentId: submitted.intentId,
      envelope: resolvedEnvelope,
    });

    return {
      intent: quoted.intent,
      quote: quoted.quote,
      submitted,
      dispatched,
      status: statusProvider.getStatus(submitted.intentId),
    };
  }

  async function settleIntent({ intentId, outcomeReference, resultAssetId, resultAmount }) {
    if (!routerAdapter.finalizeSuccess) {
      throw new Error("routerAdapter.finalizeSuccess is required for settle");
    }

    return routerAdapter.finalizeSuccess({
      intentId,
      outcomeReference,
      resultAssetId,
      resultAmount,
    });
  }

  async function failIntent({ intentId, outcomeReference, failureReasonHash }) {
    if (!routerAdapter.finalizeFailure) {
      throw new Error("routerAdapter.finalizeFailure is required for fail");
    }

    return routerAdapter.finalizeFailure({
      intentId,
      outcomeReference,
      failureReasonHash,
    });
  }

  async function refundIntent({ intentId, refundAmount, refundAsset }) {
    if (!routerAdapter.refundFailedIntent) {
      throw new Error("routerAdapter.refundFailedIntent is required for refund");
    }

    return routerAdapter.refundFailedIntent({
      intentId,
      refundAmount,
      refundAsset,
    });
  }

  return {
    quote: quoteIntent,
    submit: submitIntent,
    dispatch: dispatchIntent,
    execute: executeIntent,
    settle: settleIntent,
    fail: failIntent,
    refund: refundIntent,

    getStatus(intentId) {
      return statusProvider.getStatus(intentId);
    },

    getTimeline(intentId) {
      return statusProvider.getTimeline(intentId);
    },

    subscribe(listener) {
      return statusProvider.subscribe(listener);
    },
  };
}

export function createRouteEngineQuoteProvider({
  command = "cargo",
  commandArgs = ["run", "-q", "-p", "route-engine", "--"],
  cwd,
  env,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  serializeCommands = command === "cargo",
} = {}) {
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);

  return {
    async quote(intentInput) {
      const intent = intentInput.quoteId ? intentInput : createIntent(intentInput);
      const args = commandArgs.concat(
        buildRouteEngineQuoteArgs(intent, normalizedDeploymentProfile),
      );

      try {
        const { stdout } = await execSerializedCommand({
          command,
          args,
          cwd,
          env,
          serializeCommands,
        });
        return {
          ...JSON.parse(stdout),
          quoteId: intent.quoteId,
        };
      } catch (error) {
        const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
        throw new Error(`route engine quote failed: ${detail}`);
      }
    },
  };
}

export function createHttpQuoteProvider({
  endpoint,
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  const normalizedEndpoint = String(endpoint ?? "").trim();
  if (normalizedEndpoint === "") {
    throw new Error("endpoint is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  return {
    async quote(intentInput) {
      const intent = intentInput.quoteId ? intentInput : createIntent(intentInput);
      const response = await fetchImpl(normalizedEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          intent: toPlainIntent(intent),
        }),
      });

      if (!response.ok) {
        throw new Error(`http quote failed with status ${response.status}`);
      }

      return {
        ...(await response.json()),
        quoteId: intent.quoteId,
      };
    },
  };
}

export function normalizeQuote(quote) {
  const action = assertIncluded(
    "quote.submission.action",
    quote?.submission?.action,
    Object.values(ACTION_TYPES),
  );

  return Object.freeze({
    quoteId: quote.quoteId,
    deploymentProfile: normalizeDeploymentProfile(
      quote?.deploymentProfile ?? DEFAULT_DEPLOYMENT_PROFILE,
    ),
    route: quote.route.slice(),
    segments: normalizeRouteSegments(quote.segments ?? []),
    fees: normalizeFeeBreakdown(quote.fees),
    estimatedSettlementFee: quote.estimatedSettlementFee
      ? normalizeAssetAmount(quote.estimatedSettlementFee)
      : null,
    expectedOutput: normalizeAssetAmount(quote.expectedOutput),
    minOutput: quote.minOutput ? normalizeAssetAmount(quote.minOutput) : null,
    submission: Object.freeze({
      action,
      asset: quote.submission.asset,
      amount: toBigInt(quote.submission.amount, "quote.submission.amount"),
      xcmFee: toBigInt(quote.submission.xcmFee, "quote.submission.xcmFee"),
      destinationFee: toBigInt(
        quote.submission.destinationFee,
        "quote.submission.destinationFee",
      ),
      minOutputAmount: toBigInt(
        quote.submission.minOutputAmount,
        "quote.submission.minOutputAmount",
      ),
    }),
    executionPlan: quote.executionPlan,
  });
}

function normalizeFeeBreakdown(fees) {
  return Object.freeze({
    xcmFee: normalizeAssetAmount(fees.xcmFee),
    destinationFee: normalizeAssetAmount(fees.destinationFee),
    platformFee: normalizeAssetAmount(fees.platformFee),
    totalFee: normalizeAssetAmount(fees.totalFee),
  });
}

function normalizeAssetAmount(assetAmount) {
  return Object.freeze({
    asset: assetAmount.asset,
    amount: toBigInt(assetAmount.amount, `${assetAmount.asset} amount`),
  });
}

function normalizeRouteSegments(segments) {
  return Object.freeze(
    segments.map((segment, index) =>
      Object.freeze({
        kind: assertIncluded(
          `segments[${index}].kind`,
          segment.kind,
          ["execution", "settlement"],
        ),
        route: Object.freeze(segment.route.slice()),
        hops: Object.freeze(
          segment.hops.map((hop) =>
            Object.freeze({
              source: hop.source,
              destination: hop.destination,
              asset: hop.asset,
              transportFee: normalizeAssetAmount(hop.transportFee),
              buyExecutionFee: normalizeAssetAmount(hop.buyExecutionFee),
            }),
          ),
        ),
        xcmFee: normalizeAssetAmount(segment.xcmFee),
        destinationFee: normalizeAssetAmount(segment.destinationFee),
      }),
    ),
  );
}

function buildRouteEngineQuoteArgs(
  intent,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const shared = [
    "quote",
    "--source-chain",
    intent.sourceChain,
    "--destination-chain",
    intent.destinationChain,
    "--refund-address",
    intent.refundAddress,
    "--deadline",
    String(intent.deadline),
    "--deployment-profile",
    normalizeDeploymentProfile(deploymentProfile),
    "--action",
    intent.action.type,
  ];

  switch (intent.action.type) {
    case ACTION_TYPES.TRANSFER:
      return shared.concat([
        "--asset",
        intent.action.params.asset,
        "--amount",
        intent.action.params.amount.toString(),
        "--recipient",
        intent.action.params.recipient,
      ]);
    case ACTION_TYPES.SWAP:
      return shared.concat([
        "--asset-in",
        intent.action.params.assetIn,
        "--asset-out",
        intent.action.params.assetOut,
        "--amount-in",
        intent.action.params.amountIn.toString(),
        "--min-amount-out",
        intent.action.params.minAmountOut.toString(),
        "--recipient",
        intent.action.params.recipient,
        "--settlement-chain",
        intent.action.params.settlementChain,
      ]);
    case ACTION_TYPES.EXECUTE:
      if (intent.action.params.executionType !== EXECUTION_TYPES.RUNTIME_CALL) {
        throw new Error(`unsupported execution type: ${intent.action.params.executionType}`);
      }

      return shared.concat([
        "--execution-type",
        intent.action.params.executionType,
        "--asset",
        intent.action.params.asset,
        "--max-payment-amount",
        intent.action.params.maxPaymentAmount.toString(),
        "--call-data",
        intent.action.params.callData,
        "--origin-kind",
        intent.action.params.originKind,
        "--fallback-ref-time",
        String(intent.action.params.fallbackWeight.refTime),
        "--fallback-proof-size",
        String(intent.action.params.fallbackWeight.proofSize),
      ]);
    default:
      throw new Error(`unsupported action type: ${intent.action.type}`);
  }
}

function execSerializedCommand({
  command,
  args,
  cwd,
  env,
  serializeCommands,
}) {
  const invoke = () =>
    execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 1024 * 1024,
    });

  if (!serializeCommands) {
    return invoke();
  }

  const queued = serializedCommandQueue.then(invoke);
  serializedCommandQueue = queued.catch(() => {});
  return queued;
}
