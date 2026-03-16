import {
  createExecuteIntent,
  createIntent,
  createSwapIntent,
  createTransferIntent,
} from "../xroute-intents/index.mjs";
import {
  EXECUTION_TYPES,
  INTENT_STATUSES,
  assertNonEmptyString,
  toPlainObject,
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
import {
  createHttpQuoteProvider,
  createQuote,
  createQuoteIntent,
  normalizeQuote,
} from "./quote/index.mjs";
import {
  createHttpStatusProvider,
  createStatusClient,
  trackStatus,
} from "./status/index.mjs";
import { createWallet } from "./wallet/index.mjs";
import { createHttpExecutorRelayerClient } from "./internal/relayer-client.mjs";

export {
  createEvmWalletAdapter,
  createSubstrateWalletAdapter,
} from "./wallets/wallet-adapters.mjs";

export { NATIVE_ASSET_ADDRESS } from "./routers/router-adapters.mjs";
export { createWallet } from "./wallet/index.mjs";
export { createQuote, createHttpQuoteProvider, normalizeQuote } from "./quote/index.mjs";
export { createHttpStatusProvider, createStatusClient, trackStatus } from "./status/index.mjs";

const TERMINAL_INTENT_STATUSES = new Set([
  INTENT_STATUSES.SETTLED,
  INTENT_STATUSES.FAILED,
  INTENT_STATUSES.REFUNDED,
  INTENT_STATUSES.CANCELLED,
]);
const DEFAULT_INTENT_DEADLINE_SECONDS = 60 * 60;
export const DEFAULT_XROUTE_API_BASE_URL = "https://xroute-api.onrender.com/v1";

export function createXRouteClient(options = {}) {
  return createHostedXRouteClient(options);
}

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
  if (!statusProvider?.getStatus || !statusProvider?.getTimeline || !statusProvider?.subscribe) {
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

    subscribe(listener) {
      return statusProvider.subscribe(listener);
    },
  };
}

function createHostedXRouteClient({
  apiKey,
  baseUrl = DEFAULT_XROUTE_API_BASE_URL,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  environment,
  fetchImpl = globalThis.fetch,
  wallet = null,
} = {}) {
  const normalizedApiKey =
    apiKey === undefined || apiKey === null
      ? undefined
      : assertNonEmptyString("apiKey", apiKey);
  const normalizedDeploymentProfile = normalizeDeploymentProfile(
    environment ?? deploymentProfile,
  );
  const normalizedBaseUrl = normalizeHostedBaseUrl(baseUrl);
  const quoteProvider = createHttpQuoteProvider({
    endpoint: `${normalizedBaseUrl}/quote`,
    apiKey: normalizedApiKey,
    fetchImpl,
    headers: {
      "x-xroute-deployment-profile": normalizedDeploymentProfile,
    },
  });
  const relayer = createHttpExecutorRelayerClient({
    endpoint: normalizedBaseUrl,
    apiKey: normalizedApiKey,
    fetchImpl,
  });
  const hostedStatusProvider = createHttpStatusProvider({
    endpoint: normalizedBaseUrl,
    apiKey: normalizedApiKey,
    fetchImpl,
  });

  const walletEntriesByChain = new Map();
  let defaultWalletEntry = null;

  function createConnectedClientForWallet(walletConnector) {
    return createConfiguredXRouteClient({
      quoteProvider,
      routerAdapter: createRelayerAwareRouterAdapter({
        walletConnector,
        relayer,
      }),
      statusProvider: hostedStatusProvider,
      assetAddressResolver: walletConnector.assetAddressResolver,
      submitRequestBuilder: walletConnector.submitRequestBuilder,
      xcmEnvelopeBuilder:
        walletConnector.xcmEnvelopeBuilder ?? buildExecutionEnvelope,
      castBin: walletConnector.castBin ?? "cast",
    });
  }

  function registerWalletEntry(walletConnector, explicitChainKey = null) {
    const connectedClient = createConnectedClientForWallet(walletConnector);
    const normalizedChainKey =
      typeof explicitChainKey === "string" && explicitChainKey.trim() !== ""
        ? explicitChainKey.trim()
        : walletConnector.chainKey ?? null;
    const entry = {
      walletConnector,
      connectedClient,
    };

    if (normalizedChainKey) {
      walletEntriesByChain.set(normalizedChainKey, entry);
    } else {
      defaultWalletEntry = entry;
    }

    return entry;
  }

  function resolveWalletEntry(sourceChain) {
    return walletEntriesByChain.get(sourceChain) ?? defaultWalletEntry;
  }

  function requireWalletEntry(sourceChain) {
    const entry = resolveWalletEntry(assertNonEmptyString("sourceChain", sourceChain));
    if (!entry) {
      throw new Error(`connectWallet(...) is required for ${sourceChain} source-chain execution`);
    }
    return entry;
  }

  async function resolveExecutionContext(sourceChain) {
    const entry = requireWalletEntry(sourceChain);
    return {
      walletConnector: entry.walletConnector,
      connectedClient: entry.connectedClient,
      owner: await resolveConnectedWalletOwner(entry.walletConnector),
    };
  }

  async function executeHostedIntent({ intent, quote, envelope, owner }) {
    const normalizedIntent = intent.quoteId
      ? intent
      : createQuoteIntent({
          ...intent,
          deploymentProfile: intent.deploymentProfile ?? normalizedDeploymentProfile,
        });
    const entry = requireWalletEntry(normalizedIntent.sourceChain);
    const resolvedOwner = owner ?? await resolveConnectedWalletOwner(entry.walletConnector);

    return entry.connectedClient.execute({
      intent: normalizedIntent,
      quote,
      envelope,
      owner: resolvedOwner,
    });
  }

  const api = {
    connectWallet(typeOrWallet, walletOptions) {
      const explicitChainKey =
        typeof walletOptions?.chainKey === "string" && walletOptions.chainKey.trim() !== ""
          ? walletOptions.chainKey.trim()
          : null;

      if (typeof typeOrWallet === "string") {
        const walletConnector = normalizeWalletConnector(
          createWallet(typeOrWallet, {
            ...walletOptions,
            deploymentProfile: normalizedDeploymentProfile,
          }),
        );
        registerWalletEntry(walletConnector, explicitChainKey);
        return api;
      }

      registerWalletEntry(normalizeWalletConnector(typeOrWallet), explicitChainKey);
      return api;
    },

    disconnectWallet(chainKey = null) {
      if (typeof chainKey === "string" && chainKey.trim() !== "") {
        walletEntriesByChain.delete(chainKey.trim());
        return api;
      }

      walletEntriesByChain.clear();
      defaultWalletEntry = null;
      return api;
    },

    async quote(intentInput) {
      const intent = intentInput.quoteId
        ? intentInput
        : createQuoteIntent({
            ...intentInput,
            deploymentProfile:
              intentInput.deploymentProfile ?? normalizedDeploymentProfile,
          });
      const quote = normalizeQuote(await quoteProvider.quote(intent));

      if (quote.quoteId !== intent.quoteId) {
        throw new Error("quote id must match the normalized intent quote id");
      }

      return { intent, quote };
    },

    async transfer(input) {
      const { connectedClient, owner } = await resolveExecutionContext(input.sourceChain);
      const intent = createTransferIntent({
        deploymentProfile: input.deploymentProfile ?? normalizedDeploymentProfile,
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain,
        senderAddress: input.senderAddress ?? input.ownerAddress ?? owner,
        deadline: input.deadline ?? defaultIntentDeadline(),
        params: input.action?.params ?? input.params ?? {
          asset: input.asset,
          amount: input.amount,
          recipient: input.recipient,
        },
      });

      return connectedClient.execute({
        intent,
        owner,
      });
    },

    async swap(input) {
      const { connectedClient, owner } = await resolveExecutionContext(input.sourceChain);
      const intent = createSwapIntent({
        deploymentProfile: input.deploymentProfile ?? normalizedDeploymentProfile,
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain,
        senderAddress: input.senderAddress ?? input.ownerAddress ?? owner,
        deadline: input.deadline ?? defaultIntentDeadline(),
        params: input.action?.params ?? input.params ?? {
          assetIn: input.assetIn,
          assetOut: input.assetOut,
          amountIn: input.amountIn,
          minAmountOut: input.minAmountOut,
          settlementChain: input.settlementChain,
          recipient: input.recipient,
        },
      });

      return connectedClient.execute({
        intent,
        owner,
      });
    },

    async execute(input) {
      const { connectedClient, owner } = await resolveExecutionContext(input.sourceChain);
      const intent = createExecuteIntent({
        deploymentProfile: input.deploymentProfile ?? normalizedDeploymentProfile,
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain ?? "moonbeam",
        senderAddress: input.senderAddress ?? input.ownerAddress ?? owner,
        deadline: input.deadline ?? defaultIntentDeadline(),
        params: input.action?.params ?? input.params ?? {
          executionType: input.executionType ?? EXECUTION_TYPES.CALL,
          asset: input.asset ?? "DOT",
          amount: input.amount,
          recipient: input.recipient,
          adapterAddress: input.adapterAddress,
          maxPaymentAmount: input.maxPaymentAmount,
          contractAddress: input.contractAddress,
          calldata: input.calldata,
          value: input.value,
          gasLimit: input.gasLimit,
          fallbackWeight:
            input.fallbackWeight ??
            ((input.fallbackRefTime !== undefined || input.fallbackProofSize !== undefined)
              ? {
                  refTime: input.fallbackRefTime,
                  proofSize: input.fallbackProofSize,
                }
              : undefined),
          remark: input.remark,
          channelId: input.channelId,
        },
      });

      return connectedClient.execute({
        intent,
        owner,
      });
    },

    async call(input) {
      return api.execute({
        ...input,
        executionType: input.executionType ?? EXECUTION_TYPES.CALL,
      });
    },

    async runFlow({
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
        const resolvedIntentInput = await resolveFlowValue(
          step?.intent ?? step?.buildIntent,
          context,
          `steps[${stepIndex}].intent`,
        );
        const normalizedIntent = resolvedIntentInput?.quoteId
          ? resolvedIntentInput
          : createQuoteIntent({
              ...resolvedIntentInput,
              deploymentProfile:
                resolvedIntentInput?.deploymentProfile ?? normalizedDeploymentProfile,
            });
        const resolvedQuote = await resolveOptionalFlowValue(step?.quote, context);
        const resolvedEnvelope = await resolveOptionalFlowValue(step?.envelope, context);
        const entry = requireWalletEntry(normalizedIntent.sourceChain);
        const resolvedOwner =
          await resolveOptionalFlowValue(step?.owner ?? owner, context)
          ?? await resolveConnectedWalletOwner(entry.walletConnector);
        const execution = await executeHostedIntent({
          intent: normalizedIntent,
          quote: resolvedQuote ?? undefined,
          envelope: resolvedEnvelope ?? undefined,
          owner: resolvedOwner,
        });
        const finalStatus = await waitForIntentStatus(hostedStatusProvider, execution.submitted.intentId, {
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
    },

    async getStatus(intentId) {
      return hostedStatusProvider.getStatus(intentId);
    },

    async getTimeline(intentId) {
      return hostedStatusProvider.getTimeline(intentId);
    },

    async wait(intentId, options) {
      return waitForIntentStatus(hostedStatusProvider, intentId, options);
    },

    track(intentId, options) {
      return trackIntentStatus(hostedStatusProvider, intentId, options);
    },

    subscribe(listener) {
      return hostedStatusProvider.subscribe(listener);
    },
  };

  if (wallet) {
    api.connectWallet(wallet);
  }

  return api;
}

function normalizeHostedBaseUrl(baseUrl) {
  const normalized = String(baseUrl ?? DEFAULT_XROUTE_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (normalized === "") {
    throw new Error("baseUrl is required");
  }
  return normalized;
}

function normalizeWalletConnector(wallet) {
  if (!wallet || typeof wallet !== "object") {
    throw new Error("connectWallet(wallet) requires a wallet connector object");
  }
  if (!wallet.routerAdapter?.submitIntent || !wallet.routerAdapter?.dispatchIntent) {
    throw new Error("wallet.routerAdapter submitIntent and dispatchIntent are required");
  }
  if (
    typeof wallet.submitRequestBuilder !== "function"
    && typeof wallet.assetAddressResolver !== "function"
  ) {
    throw new Error("wallet.assetAddressResolver or submitRequestBuilder is required");
  }

  return wallet;
}

function createRelayerAwareRouterAdapter({ walletConnector, relayer }) {
  const walletRouterAdapter = walletConnector.routerAdapter;
  const substrateDispatches = new Map();

  const hostedRouterAdapter = {
    async submitIntent(input) {
      const submitted = await walletRouterAdapter.submitIntent(input);

      if (requiresSubstrateSourceMetadata(input?.intent?.sourceChain)) {
        substrateDispatches.set(assertNonEmptyString("intentId", submitted.intentId), {
          intent: input.intent,
          quote: input.quote,
          dispatchResult: null,
          registrationResult: null,
        });
      }

      return submitted;
    },

    async dispatchIntent({ intentId, request }) {
      const normalizedIntentId = assertNonEmptyString("intentId", intentId);
      const state = substrateDispatches.get(normalizedIntentId);
      const dispatchResult =
        state?.dispatchResult
        ?? await walletRouterAdapter.dispatchIntent({ intentId: normalizedIntentId, request });

      if (!state) {
        return dispatchResult;
      }

      if (!state.dispatchResult) {
        state.dispatchResult = dispatchResult;
      }

      if (!state.registrationResult) {
        state.registrationResult = await relayer.dispatch({
          intentId: normalizedIntentId,
          intent: state.intent,
          quote: state.quote,
          request,
          dispatchResult,
        });
      }

      return {
        ...dispatchResult,
        relayerJob: state.registrationResult.job ?? state.registrationResult,
      };
    },
  };

  if (typeof walletRouterAdapter.finalizeSuccess === "function") {
    hostedRouterAdapter.finalizeSuccess =
      walletRouterAdapter.finalizeSuccess.bind(walletRouterAdapter);
  }
  if (typeof walletRouterAdapter.finalizeFailure === "function") {
    hostedRouterAdapter.finalizeFailure =
      walletRouterAdapter.finalizeFailure.bind(walletRouterAdapter);
  }
  if (typeof walletRouterAdapter.refundFailedIntent === "function") {
    hostedRouterAdapter.refundFailedIntent =
      walletRouterAdapter.refundFailedIntent.bind(walletRouterAdapter);
  }
  if (typeof walletRouterAdapter.previewRefundableAmount === "function") {
    hostedRouterAdapter.previewRefundableAmount =
      walletRouterAdapter.previewRefundableAmount.bind(walletRouterAdapter);
  }

  return hostedRouterAdapter;
}

function requireWalletConnection(wallet) {
  if (!wallet) {
    throw new Error("connectWallet(wallet) is required for source-chain execution");
  }
  return wallet;
}

function requireConnectedClient(client) {
  if (!client) {
    throw new Error("connectWallet(wallet) is required for source-chain execution");
  }
  return client;
}

async function resolveConnectedWalletOwner(wallet) {
  if (typeof wallet.getAddress === "function") {
    return assertNonEmptyString("wallet.getAddress()", await wallet.getAddress());
  }
  return assertNonEmptyString("wallet.address", wallet.owner ?? wallet.address);
}

function trackIntentStatus(
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

async function waitForIntentStatus(statusProvider, intentId, options = {}) {
  const tracker = trackIntentStatus(statusProvider, intentId, {
    ...options,
    stopOnTerminal: true,
  });
  return tracker.done;
}

function defaultIntentDeadline() {
  return Math.floor(Date.now() / 1000) + DEFAULT_INTENT_DEADLINE_SECONDS;
}

function isTerminalIntentStatus(status) {
  return TERMINAL_INTENT_STATUSES.has(status);
}

async function resolveFlowValue(value, context, name) {
  const resolved =
    typeof value === "function" ? await value(context) : value;
  if (resolved === undefined || resolved === null) {
    throw new Error(`${name} is required`);
  }
  return resolved;
}

async function resolveOptionalFlowValue(value, context) {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "function" ? value(context) : value;
}

function requiresSubstrateSourceMetadata(sourceChain) {
  return sourceChain === "hydration" || sourceChain === "bifrost";
}
