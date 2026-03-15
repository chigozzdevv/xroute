import {
  createExecuteIntent,
  createIntent,
  createSwapIntent,
  createTransferIntent,
  toPlainIntent,
} from "../xroute-intents/index.mjs";
import {
  EXECUTION_TYPES,
  INTENT_STATUSES,
  toBigInt,
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
  normalizeQuote,
} from "./quote/index.mjs";
import {
  createHttpStatusProvider,
  createStatusClient,
  trackStatus,
} from "./status/index.mjs";
import { createWallet } from "./wallet/index.mjs";

export {
  createEvmWalletAdapter,
  createSubstrateWalletAdapter,
} from "./wallets/wallet-adapters.mjs";

export { NATIVE_ASSET_ADDRESS } from "./routers/router-adapters.mjs";
export { createWallet } from "./wallet/index.mjs";
export { createQuote, createHttpQuoteProvider, normalizeQuote } from "./quote/index.mjs";
export { createHttpStatusProvider, createStatusClient, trackStatus } from "./status/index.mjs";

const SUBSTRATE_SOURCE_CHAINS = new Set(["hydration", "bifrost"]);
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

export function createXRouteOperatorClient({
  apiKey,
  baseUrl = DEFAULT_XROUTE_API_BASE_URL,
  authToken,
  fetchImpl = globalThis.fetch,
  headers,
} = {}) {
  const normalizedApiKey =
    apiKey === undefined || apiKey === null
      ? undefined
      : assertNonEmptyString("apiKey", apiKey);

  return createHttpExecutorRelayerClient({
    endpoint: normalizeHostedBaseUrl(baseUrl),
    apiKey: normalizedApiKey,
    authToken,
    fetchImpl,
    headers,
  });
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
      : createIntent({
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
      : createIntent({
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
            : createIntent({
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
  authToken,
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
    authToken,
    fetchImpl,
  });
  const hostedStatusProvider = createHttpStatusProvider({
    endpoint: normalizedBaseUrl,
    apiKey: normalizedApiKey,
    fetchImpl,
  });

  let walletConnector = null;
  let connectedClient = null;

  const api = {
    connectWallet(typeOrWallet, walletOptions) {
      if (typeof typeOrWallet === "string") {
        walletConnector = normalizeWalletConnector(
          createWallet(typeOrWallet, {
            ...walletOptions,
            deploymentProfile: normalizedDeploymentProfile,
          }),
        );
      } else {
        walletConnector = normalizeWalletConnector(typeOrWallet);
      }
      connectedClient = createConfiguredXRouteClient({
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
      return api;
    },

    disconnectWallet() {
      walletConnector = null;
      connectedClient = null;
      return api;
    },

    async quote(intentInput) {
      const intent = intentInput.quoteId
        ? intentInput
        : createIntent({
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
      const owner = await resolveConnectedWalletOwner(requireWalletConnection(walletConnector));
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

      return requireConnectedClient(connectedClient).execute({
        intent,
        owner,
      });
    },

    async swap(input) {
      const owner = await resolveConnectedWalletOwner(requireWalletConnection(walletConnector));
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

      return requireConnectedClient(connectedClient).execute({
        intent,
        owner,
      });
    },

    async execute(input) {
      const owner = await resolveConnectedWalletOwner(requireWalletConnection(walletConnector));
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

      return requireConnectedClient(connectedClient).execute({
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

    async runFlow(options = {}) {
      const owner =
        options.owner ??
        await resolveConnectedWalletOwner(requireWalletConnection(walletConnector));
      return requireConnectedClient(connectedClient).runFlow({
        ...options,
        owner,
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

export function createHttpExecutorRelayerClient({
  endpoint,
  authToken,
  apiKey,
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  const normalizedEndpoint = String(endpoint ?? "").replace(/\/+$/, "");
  if (normalizedEndpoint === "") {
    throw new Error("endpoint is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const requestHeaders = {
    ...headers,
  };
  if (apiKey) {
    requestHeaders["x-api-key"] = apiKey;
  }
  if (authToken) {
    requestHeaders.authorization = `Bearer ${authToken}`;
  }

  return {
    async health() {
      return requestJson(`${normalizedEndpoint}/healthz`, {
        method: "GET",
        fetchImpl,
        headers: requestHeaders,
      });
    },

    async dispatch({ intentId, intent, quote, envelope, request, dispatchResult } = {}) {
      if (!intent) {
        throw new Error("intent is required");
      }

      const normalizedProfile = quote?.deploymentProfile ?? undefined;
      const normalizedIntent = intent.quoteId
        ? intent
        : createIntent({
            ...intent,
            deploymentProfile: intent.deploymentProfile ?? normalizedProfile,
          });
      const normalizedRequest =
        request ??
        buildDispatchRequest(
          createDispatchEnvelope(
            envelope ??
              buildExecutionEnvelope({
                intent: normalizedIntent,
                quote: normalizeQuote(quote),
                }),
          ),
        );
      const normalizedQuote = quote ? normalizeQuote(quote) : null;
      if (requiresSubstrateSourceMetadata(normalizedIntent.sourceChain) && !normalizedQuote) {
        throw new Error(
          `quote is required when dispatching ${normalizedIntent.sourceChain} source intents through the relayer`,
        );
      }
      const sourceIntent = normalizedQuote
        ? buildSourceIntentMetadata({
            intent: normalizedIntent,
            quote: normalizedQuote,
          })
        : undefined;
      const sourceDispatch = dispatchResult
        ? normalizeSourceDispatch(dispatchResult)
        : undefined;

      return requestJson(`${normalizedEndpoint}/jobs/dispatch`, {
        method: "POST",
        fetchImpl,
        headers: requestHeaders,
        body: {
          intentId,
          intent: toPlainIntent(normalizedIntent),
          request: toPlainObject(normalizedRequest),
          sourceIntent,
          sourceDispatch,
        },
      });
    },

    async settle({
      intentId,
      outcomeReference,
      resultAssetId,
      resultAmount,
    } = {}) {
      return requestJson(`${normalizedEndpoint}/jobs/settle`, {
        method: "POST",
        fetchImpl,
        headers: requestHeaders,
        body: {
          intentId,
          outcomeReference,
          resultAssetId,
          resultAmount: toBigInt(resultAmount, "resultAmount").toString(),
        },
      });
    },

    async fail({ intentId, outcomeReference, failureReasonHash } = {}) {
      return requestJson(`${normalizedEndpoint}/jobs/fail`, {
        method: "POST",
        fetchImpl,
        headers: requestHeaders,
        body: {
          intentId,
          outcomeReference,
          failureReasonHash,
        },
      });
    },

    async refund({ intentId, refundAmount, refundAsset } = {}) {
      return requestJson(`${normalizedEndpoint}/jobs/refund`, {
        method: "POST",
        fetchImpl,
        headers: requestHeaders,
        body: {
          intentId,
          refundAmount: toBigInt(refundAmount, "refundAmount").toString(),
          refundAsset: refundAsset ?? undefined,
        },
      });
    },

    async getJob(jobId) {
      return requestJson(`${normalizedEndpoint}/jobs/${encodeURIComponent(jobId)}`, {
        method: "GET",
        fetchImpl,
        headers: requestHeaders,
      });
    },

    async listJobs() {
      return requestJson(`${normalizedEndpoint}/jobs`, {
        method: "GET",
        fetchImpl,
        headers: requestHeaders,
      });
    },
  };
}

function buildSourceIntentMetadata({ intent, quote }) {
  return {
    kind: inferSourceIntentKind(intent.sourceChain),
    refundAsset: quote.submission.asset,
    refundableAmount: (
      quote.submission.amount + quote.submission.xcmFee + quote.submission.destinationFee
    ).toString(),
    minOutputAmount: quote.submission.minOutputAmount.toString(),
  };
}

function inferSourceIntentKind(sourceChain) {
  return requiresSubstrateSourceMetadata(sourceChain) ? "substrate-source" : "router-evm";
}

function requiresSubstrateSourceMetadata(sourceChain) {
  return SUBSTRATE_SOURCE_CHAINS.has(sourceChain);
}

function normalizeSourceDispatch(dispatchResult) {
  const txHash = dispatchResult?.txHash ?? dispatchResult?.transactionHash;
  if (!txHash) {
    throw new Error("dispatchResult.txHash is required");
  }

  return {
    txHash,
    strategy:
      typeof dispatchResult?.strategy === "string" && dispatchResult.strategy.trim() !== ""
        ? dispatchResult.strategy.trim()
        : undefined,
  };
}


async function requestJson(url, { method, fetchImpl, headers, body }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `${method} ${url} failed with status ${response.status}`);
  }

  return payload;
}
