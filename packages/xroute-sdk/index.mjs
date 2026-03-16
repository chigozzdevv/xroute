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
} from "../xroute-types/index.mjs";
import {
  buildExecutionEnvelope,
} from "../xroute-xcm/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../xroute-precompile-interfaces/index.mjs";
import {
  createHttpQuoteProvider,
  createQuoteIntent,
  normalizeQuote,
} from "./quote/index.mjs";
import { createHttpStatusProvider } from "./status/index.mjs";
import { createWallet } from "./wallet/index.mjs";
import {
  assertNoBaseUrlOverride,
  resolveDefaultXRouteApiBaseUrl,
} from "./internal/constants.mjs";
import {
  createConfiguredXRouteClient,
  resolveFlowValue,
  resolveOptionalFlowValue,
  trackIntentStatus,
  waitForIntentStatus,
} from "./internal/client-core.mjs";
import { createHttpExecutorRelayerClient } from "./internal/relayer-client.mjs";

export {
  connectInjectedWallet,
  getBrowserWalletAvailability,
  listInjectedEvmProviders,
  listInjectedSubstrateExtensions,
} from "./wallet/index.mjs";
export { createQuote } from "./quote/index.mjs";
export { createStatusClient } from "./status/index.mjs";
const DEFAULT_INTENT_DEADLINE_SECONDS = 60 * 60;

export function createXRouteClient(options = {}) {
  assertNoBaseUrlOverride("createXRouteClient", options);
  return createHostedXRouteClient(options);
}

function createHostedXRouteClient({
  apiKey,
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
  const apiBaseUrl = resolveDefaultXRouteApiBaseUrl();
  const quoteProvider = createHttpQuoteProvider({
    endpoint: `${apiBaseUrl}/quote`,
    apiKey: normalizedApiKey,
    fetchImpl,
    headers: {
      "x-xroute-deployment-profile": normalizedDeploymentProfile,
    },
  });
  const relayer = createHttpExecutorRelayerClient({
    endpoint: apiBaseUrl,
    apiKey: normalizedApiKey,
    fetchImpl,
  });
  const hostedStatusProvider = createHttpStatusProvider({
    endpoint: apiBaseUrl,
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

  async function maybeEstimateSourceCosts({ intent, quote, owner }) {
    const entry = resolveWalletEntry(intent.sourceChain);
    if (!entry?.connectedClient?.estimateSourceCosts) {
      return null;
    }

    try {
      return await entry.connectedClient.estimateSourceCosts({
        intent,
        quote,
        owner,
      });
    } catch {
      return null;
    }
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

      return {
        intent,
        quote,
        sourceCosts: await maybeEstimateSourceCosts({ intent, quote }),
      };
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
  };

  if (wallet) {
    api.connectWallet(wallet);
  }

  return api;
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
  const trackedDispatches = new Map();

  const hostedRouterAdapter = {
    async submitIntent(input) {
      const submitted = await walletRouterAdapter.submitIntent(input);
      trackedDispatches.set(assertNonEmptyString("intentId", submitted.intentId), {
        intent: input.intent,
        quote: input.quote,
        dispatchResult: null,
        registrationResult: null,
      });

      return submitted;
    },

    async dispatchIntent({ intentId, request }) {
      const normalizedIntentId = assertNonEmptyString("intentId", intentId);
      const state = trackedDispatches.get(normalizedIntentId);
      if (!state) {
        return walletRouterAdapter.dispatchIntent({ intentId: normalizedIntentId, request });
      }

      if (!requiresSubstrateSourceMetadata(state.intent?.sourceChain)) {
        if (!state.registrationResult) {
          state.registrationResult = await relayer.dispatch({
            intentId: normalizedIntentId,
            intent: state.intent,
            quote: state.quote,
            request,
          });
        }

        return {
          intentId: normalizedIntentId,
          request,
          strategy: "relayer-owned-dispatch",
          relayerJob: state.registrationResult.job ?? state.registrationResult,
        };
      }

      const dispatchResult =
        state.dispatchResult
        ?? await walletRouterAdapter.dispatchIntent({ intentId: normalizedIntentId, request });
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
  if (typeof walletRouterAdapter.estimateSubmissionCost === "function") {
    hostedRouterAdapter.estimateSubmissionCost =
      walletRouterAdapter.estimateSubmissionCost.bind(walletRouterAdapter);
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

function defaultIntentDeadline() {
  return Math.floor(Date.now() / 1000) + DEFAULT_INTENT_DEADLINE_SECONDS;
}

function requiresSubstrateSourceMetadata(sourceChain) {
  return sourceChain === "polkadot-hub" || sourceChain === "hydration" || sourceChain === "bifrost";
}
