import { INTENT_STATUSES, assertNonEmptyString, toPlainObject } from "../../xroute-types/index.mjs";
import {
  buildExecutionEnvelope,
  buildDispatchRequest,
  buildRouterIntentRequest,
  createDispatchEnvelope,
} from "../../xroute-xcm/index.mjs";
import { getAssetDecimals } from "../chains/index.mjs";
import { createQuoteIntent, normalizeQuote } from "../quote/index.mjs";

const TERMINAL_INTENT_STATUSES = new Set([
  INTENT_STATUSES.SETTLED,
  INTENT_STATUSES.FAILED,
  INTENT_STATUSES.REFUNDED,
  INTENT_STATUSES.CANCELLED,
]);

export function createConfiguredXRouteClient({
  quoteProvider,
  routerAdapter,
  statusProvider,
  assetAddressResolver,
  submitRequestBuilder = null,
  xcmEnvelopeBuilder = buildExecutionEnvelope,
  castBin = "cast",
}) {
  if (!quoteProvider?.quote) {
    throw new Error("quoteProvider.quote is required");
  }
  if (!routerAdapter?.submitIntent || !routerAdapter?.dispatchIntent) {
    throw new Error("routerAdapter submitIntent and dispatchIntent are required");
  }
  if (!statusProvider?.getStatus || !statusProvider?.getTimeline) {
    throw new Error("statusProvider is incomplete");
  }
  if (
    typeof submitRequestBuilder !== "function"
    && typeof assetAddressResolver !== "function"
  ) {
    throw new Error("assetAddressResolver or submitRequestBuilder is required");
  }

  async function quoteIntent(intentInput) {
    const intent = intentInput.quoteId
      ? intentInput
      : createQuoteIntent({
          ...intentInput,
          deploymentProfile:
            intentInput.deploymentProfile ?? quoteProvider.deploymentProfile,
        });
    const quote = normalizeQuote(await quoteProvider.quote(intent));

    if (quote.quoteId !== intent.quoteId) {
      throw new Error("quote id must match the normalized intent quote id");
    }

    return { intent, quote };
  }

  async function submitIntent({ intent, quote, envelope, owner }) {
    const prepared = await prepareSubmission({
      intent,
      quote,
      envelope,
    });

    return routerAdapter.submitIntent({
      owner,
      intent: prepared.intent,
      quote: prepared.quote,
      request: prepared.request,
    });
  }

  async function estimateSourceCosts({ intent, quote, envelope, owner }) {
    if (typeof routerAdapter.estimateSubmissionCost !== "function") {
      return null;
    }

    const prepared = await prepareSubmission({
      intent,
      quote,
      envelope,
    });
    const estimate = await routerAdapter.estimateSubmissionCost({
      owner,
      intent: prepared.intent,
      quote: prepared.quote,
      request: prepared.request,
    });

    return Object.freeze({
      chainKey: prepared.intent.sourceChain,
      lockedAmount: Object.freeze({
        asset: prepared.quote.submission.asset,
        amount: estimate.lockedAmount,
        decimals: getAssetDecimals(
          prepared.quote.submission.asset,
          prepared.quote.deploymentProfile,
        ),
      }),
      gasFee: Object.freeze({
        asset: estimate.gasAsset,
        amount: estimate.gasFee,
        decimals: estimate.gasAssetDecimals,
      }),
      gasLimit: estimate.gasLimit,
      gasPrice: estimate.gasPrice,
      value: estimate.value,
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
          intent: intent.quoteId
            ? intent
            : createQuoteIntent({
                ...intent,
                deploymentProfile:
                  intent.deploymentProfile ?? quoteProvider.deploymentProfile,
              }),
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
      status: await statusProvider.getStatus(submitted.intentId),
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

  async function waitForCompletion(
    intentId,
    {
      timeoutMs = 300_000,
      pollIntervalMs = 1_000,
    } = {},
  ) {
    return waitForIntentStatus(statusProvider, intentId, {
      timeoutMs,
      pollIntervalMs,
    });
  }

  async function runFlow({
    steps,
    owner,
    timeoutMs = 300_000,
    pollIntervalMs = 1_000,
  } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("steps must contain at least one flow step");
    }

    const results = [];

    for (const [stepIndex, step] of steps.entries()) {
      const context = Object.freeze({
        stepIndex,
        previousStep: results.at(-1) ?? null,
        previousSteps: Object.freeze(results.slice()),
      });
      const resolvedIntent = await resolveFlowValue(
        step?.intent ?? step?.buildIntent,
        context,
        `steps[${stepIndex}].intent`,
      );
      const resolvedQuote = await resolveOptionalFlowValue(step?.quote, context);
      const resolvedEnvelope = await resolveOptionalFlowValue(step?.envelope, context);
      const resolvedOwner = await resolveOptionalFlowValue(
        step?.owner ?? owner,
        context,
      );
      const execution = await executeIntent({
        intent: resolvedIntent,
        quote: resolvedQuote ?? undefined,
        envelope: resolvedEnvelope ?? undefined,
        owner: resolvedOwner ?? undefined,
      });
      const finalStatus = await waitForCompletion(execution.submitted.intentId, {
        timeoutMs,
        pollIntervalMs,
      });
      const stepResult = Object.freeze({
        name:
          typeof step?.name === "string" && step.name.trim() !== ""
            ? step.name.trim()
            : `step-${stepIndex + 1}`,
        stepIndex,
        intent: execution.intent,
        quote: execution.quote,
        submitted: execution.submitted,
        dispatched: execution.dispatched,
        initialStatus: execution.status,
        finalStatus,
      });

      results.push(stepResult);

      if (finalStatus.status !== INTENT_STATUSES.SETTLED) {
        const error = new Error(
          `flow step ${stepIndex + 1} (${stepResult.name}) ended with status ${finalStatus.status}`,
        );
        error.step = stepResult;
        error.steps = results.slice();
        throw error;
      }
    }

    return Object.freeze({
      steps: Object.freeze(results),
      finalStep: results.at(-1) ?? null,
    });
  }

  return {
    quote: quoteIntent,
    submit: submitIntent,
    dispatch: dispatchIntent,
    execute: executeIntent,
    estimateSourceCosts,
    runFlow,
    waitForCompletion,
    wait: waitForCompletion,
    settle: settleIntent,
    fail: failIntent,
    refund: refundIntent,
    track(intentId, options) {
      return trackIntentStatus(statusProvider, intentId, options);
    },

    getStatus(intentId) {
      return statusProvider.getStatus(intentId);
    },

    getTimeline(intentId) {
      return statusProvider.getTimeline(intentId);
    },
  };

  async function prepareSubmission({ intent, quote, envelope }) {
    const normalizedIntent = intent.quoteId
      ? intent
      : createQuoteIntent({
          ...intent,
          deploymentProfile: intent.deploymentProfile ?? quoteProvider.deploymentProfile,
        });
    const normalizedQuote = normalizeQuote(quote);
    const normalizedEnvelope = createDispatchEnvelope(
      envelope ?? xcmEnvelopeBuilder({ intent: normalizedIntent, quote: normalizedQuote }),
    );
    const request =
      typeof submitRequestBuilder === "function"
        ? await submitRequestBuilder({
            intent: normalizedIntent,
            quote: normalizedQuote,
            envelope: normalizedEnvelope,
            castBin,
          })
        : buildRouterIntentRequest({
            intent: normalizedIntent,
            quote: normalizedQuote,
            envelope: normalizedEnvelope,
            assetAddress: await assetAddressResolver({
              chainKey: normalizedIntent.sourceChain,
              assetKey: normalizedQuote.submission.asset,
            }),
            castBin,
          });

    return Object.freeze({
      intent: normalizedIntent,
      quote: normalizedQuote,
      envelope: normalizedEnvelope,
      request,
    });
  }
}

export function trackIntentStatus(
  statusProvider,
  intentId,
  {
    pollIntervalMs = 1_000,
    timeoutMs = null,
    includeTimeline = false,
    onUpdate = null,
    stopOnTerminal = true,
    signal,
  } = {},
) {
  const normalizedIntentId = assertNonEmptyString("intentId", intentId);
  let stopped = false;
  let inFlight = false;
  let timeoutId = null;
  let pollId = null;
  let abortListener = null;
  let lastSnapshot = null;
  let lastSerializedSnapshot = null;
  let resolveDone;
  let rejectDone;

  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const cleanup = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (pollId !== null) {
      clearTimeout(pollId);
      pollId = null;
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
  };

  const stop = () => {
    if (stopped) {
      return lastSnapshot;
    }
    stopped = true;
    cleanup();
    resolveDone(lastSnapshot?.status ?? null);
    return lastSnapshot;
  };

  const fail = (error) => {
    if (stopped) {
      return;
    }
    stopped = true;
    cleanup();
    rejectDone(error);
  };

  const scheduleNextPoll = () => {
    if (stopped || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      return;
    }
    pollId = setTimeout(() => {
      void poll();
    }, pollIntervalMs);
  };

  const publish = (snapshot) => {
    lastSnapshot = snapshot;
    const serialized = JSON.stringify(toPlainObject({
      status: snapshot.status,
      timeline: snapshot.timeline ?? null,
    }));
    if (serialized === lastSerializedSnapshot) {
      return;
    }
    lastSerializedSnapshot = serialized;
    if (typeof onUpdate === "function") {
      onUpdate(snapshot);
    }
  };

  const poll = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;

    try {
      const status = await statusProvider.getStatus(normalizedIntentId);
      const timeline =
        includeTimeline
          ? await statusProvider.getTimeline(normalizedIntentId)
          : undefined;
      const snapshot = Object.freeze({
        intentId: normalizedIntentId,
        status,
        ...(includeTimeline ? { timeline } : {}),
      });

      publish(snapshot);

      if (stopOnTerminal && isTerminalIntentStatus(status?.status)) {
        stop();
        return;
      }
    } catch (error) {
      fail(error);
      return;
    } finally {
      inFlight = false;
    }

    scheduleNextPoll();
  };

  if (signal?.aborted) {
    fail(new Error(`tracking aborted for intent ${normalizedIntentId}`));
    return {
      stop,
      done,
    };
  }

  if (signal) {
    abortListener = () => {
      fail(new Error(`tracking aborted for intent ${normalizedIntentId}`));
    };
    signal.addEventListener("abort", abortListener, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      fail(new Error(`timed out tracking intent ${normalizedIntentId}`));
    }, timeoutMs);
  }

  void poll();

  return {
    stop,
    done,
  };
}

export async function waitForIntentStatus(statusProvider, intentId, options = {}) {
  const tracker = trackIntentStatus(statusProvider, intentId, {
    ...options,
    stopOnTerminal: true,
  });
  return tracker.done;
}

export async function resolveFlowValue(value, context, name) {
  const resolved =
    typeof value === "function" ? await value(context) : value;
  if (resolved === undefined || resolved === null) {
    throw new Error(`${name} is required`);
  }
  return resolved;
}

export async function resolveOptionalFlowValue(value, context) {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "function" ? value(context) : value;
}

function isTerminalIntentStatus(status) {
  return TERMINAL_INTENT_STATUSES.has(status);
}
