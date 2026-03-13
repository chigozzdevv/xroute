import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createExecuteIntent,
  createIntent,
  createSwapIntent,
  createTransferIntent,
  toPlainIntent,
} from "../xroute-intents/index.mjs";
import {
  ACTION_TYPES,
  EXECUTION_TYPES,
  INTENT_STATUSES,
  toBigInt,
  assertIncluded,
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

export { NATIVE_ASSET_ADDRESS } from "./router-adapters.mjs";

const execFileAsync = promisify(execFile);
let serializedCommandQueue = Promise.resolve();
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
  if (isHostedClientOptions(options)) {
    return createHostedXRouteClient(options);
  }

  return createConfiguredXRouteClient(options);
}

function createConfiguredXRouteClient({
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

  async function waitForCompletion(
    intentId,
    {
      timeoutMs = 300_000,
      pollIntervalMs = 1_000,
    } = {},
  ) {
    const normalizedIntentId = assertNonEmptyString("intentId", intentId);
    const existing = statusProvider.getStatus(normalizedIntentId);
    if (isTerminalIntentStatus(existing?.status)) {
      return existing;
    }

    return new Promise((resolve, reject) => {
      let timeoutId = null;
      let pollId = null;
      let unsubscribe = null;

      const cleanup = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        if (pollId !== null) {
          clearInterval(pollId);
        }
        if (typeof unsubscribe === "function") {
          unsubscribe();
        }
      };

      const finish = (handler, value) => {
        cleanup();
        handler(value);
      };

      const inspect = (record) => {
        if (!record || record.intentId !== normalizedIntentId) {
          return;
        }
        if (isTerminalIntentStatus(record.status)) {
          finish(resolve, record);
        }
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          finish(
            reject,
            new Error(
              `timed out waiting for terminal status on intent ${normalizedIntentId}`,
            ),
          );
        }, timeoutMs);
      }

      if (typeof statusProvider.subscribe === "function") {
        unsubscribe = statusProvider.subscribe((record) => {
          inspect(record);
        });
      }

      if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
        pollId = setInterval(() => {
          inspect(statusProvider.getStatus(normalizedIntentId));
        }, pollIntervalMs);
      }

      inspect(statusProvider.getStatus(normalizedIntentId));
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

function createHostedXRouteClient({
  apiKey,
  baseUrl = DEFAULT_XROUTE_API_BASE_URL,
  authToken,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  environment,
  fetchImpl = globalThis.fetch,
  wallet = null,
} = {}) {
  const normalizedApiKey = assertNonEmptyString("apiKey", apiKey);
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

  let walletConnector = null;
  let connectedClient = null;

  const api = {
    connectWallet(nextWallet) {
      walletConnector = normalizeHostedWalletConnector(nextWallet);
      connectedClient = createConfiguredXRouteClient({
        quoteProvider,
        routerAdapter: walletConnector.routerAdapter,
        statusProvider: walletConnector.statusProvider,
        assetAddressResolver: walletConnector.assetAddressResolver,
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
      const owner = await resolveConnectedWalletOwner(requireHostedWallet(walletConnector));
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

      return requireHostedConnectedClient(connectedClient).execute({
        intent,
        owner,
      });
    },

    async swap(input) {
      const owner = await resolveConnectedWalletOwner(requireHostedWallet(walletConnector));
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

      return requireHostedConnectedClient(connectedClient).execute({
        intent,
        owner,
      });
    },

    async call(input) {
      const owner = await resolveConnectedWalletOwner(requireHostedWallet(walletConnector));
      const intent = createExecuteIntent({
        deploymentProfile: input.deploymentProfile ?? normalizedDeploymentProfile,
        sourceChain: input.sourceChain,
        destinationChain: input.destinationChain ?? "moonbeam",
        senderAddress: input.senderAddress ?? input.ownerAddress ?? owner,
        deadline: input.deadline ?? defaultIntentDeadline(),
        params: input.action?.params ?? input.params ?? {
          executionType: EXECUTION_TYPES.CALL,
          asset: input.asset ?? "DOT",
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
        },
      });

      return requireHostedConnectedClient(connectedClient).execute({
        intent,
        owner,
      });
    },

    async runFlow(options = {}) {
      const owner =
        options.owner ??
        await resolveConnectedWalletOwner(requireHostedWallet(walletConnector));
      return requireHostedConnectedClient(connectedClient).runFlow({
        ...options,
        owner,
      });
    },

    getStatus(intentId) {
      return requireHostedConnectedClient(connectedClient).getStatus(intentId);
    },

    getTimeline(intentId) {
      return requireHostedConnectedClient(connectedClient).getTimeline(intentId);
    },

    subscribe(listener) {
      return requireHostedConnectedClient(connectedClient).subscribe(listener);
    },

    jobs: relayer,
    relayer,
    quoteProvider,
  };

  if (wallet) {
    api.connectWallet(wallet);
  }

  return api;
}

function isHostedClientOptions(options) {
  return (
    !options.quoteProvider &&
    (options.apiKey !== undefined ||
      options.baseUrl !== undefined ||
      options.wallet !== undefined ||
      options.authToken !== undefined ||
      options.fetchImpl !== undefined)
  );
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

function normalizeHostedWalletConnector(wallet) {
  if (!wallet || typeof wallet !== "object") {
    throw new Error("connectWallet(wallet) requires a wallet connector object");
  }
  if (!wallet.routerAdapter?.submitIntent || !wallet.routerAdapter?.dispatchIntent) {
    throw new Error("wallet.routerAdapter submitIntent and dispatchIntent are required");
  }
  if (
    !wallet.statusProvider?.getStatus ||
    !wallet.statusProvider?.getTimeline ||
    !wallet.statusProvider?.subscribe
  ) {
    throw new Error("wallet.statusProvider is required");
  }
  if (typeof wallet.assetAddressResolver !== "function") {
    throw new Error("wallet.assetAddressResolver is required");
  }

  return wallet;
}

function requireHostedWallet(wallet) {
  if (!wallet) {
    throw new Error("connectWallet(wallet) is required for source-chain execution");
  }
  return wallet;
}

function requireHostedConnectedClient(client) {
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
    deploymentProfile: normalizedDeploymentProfile,
    async quote(intentInput) {
      const intent = intentInput.quoteId
        ? intentInput
        : createIntent({
            ...intentInput,
            deploymentProfile:
              intentInput.deploymentProfile ?? normalizedDeploymentProfile,
          });
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
  apiKey,
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

  const normalizedDeploymentProfile =
    headers["x-xroute-deployment-profile"] ?? headers["X-XRoute-Deployment-Profile"] ?? null;

  const requestHeaders = {
    ...headers,
  };
  if (apiKey) {
    requestHeaders["x-api-key"] = apiKey;
  }

  return {
    deploymentProfile: normalizedDeploymentProfile ?? undefined,
    async quote(intentInput) {
      const intent = intentInput.quoteId
        ? intentInput
        : createIntent({
            ...intentInput,
            deploymentProfile:
              intentInput.deploymentProfile ?? normalizedDeploymentProfile ?? undefined,
          });
      const response = await fetchImpl(normalizedEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...requestHeaders,
        },
        body: JSON.stringify({
          intent: toPlainIntent(intent),
        }),
      });

      if (!response.ok) {
        throw new Error(`http quote failed with status ${response.status}`);
      }

      const payload = await response.json();
      const resolvedQuote = payload?.quote ?? payload;
      if (!resolvedQuote?.submission) {
        throw new Error("http quote response is missing quote");
      }

      return {
        ...resolvedQuote,
        quoteId: intent.quoteId,
      };
    },
  };
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
      return buildExecuteQuoteArgs(shared, intent.action.params);
    default:
      throw new Error(`unsupported action type: ${intent.action.type}`);
  }
}

function buildExecuteQuoteArgs(shared, params) {
  switch (params.executionType) {
    case EXECUTION_TYPES.CALL:
      return shared.concat([
        "--execution-type",
        params.executionType,
        "--asset",
        params.asset,
        "--max-payment-amount",
        params.maxPaymentAmount.toString(),
        "--contract-address",
        params.contractAddress,
        "--calldata",
        params.calldata,
        "--value",
        params.value.toString(),
        "--gas-limit",
        params.gasLimit.toString(),
        "--fallback-ref-time",
        String(params.fallbackWeight.refTime),
        "--fallback-proof-size",
        String(params.fallbackWeight.proofSize),
      ]);
    case EXECUTION_TYPES.MINT_VDOT:
    case EXECUTION_TYPES.REDEEM_VDOT:
      return shared.concat([
        "--execution-type",
        params.executionType,
        "--amount",
        params.amount.toString(),
        "--max-payment-amount",
        params.maxPaymentAmount.toString(),
        "--recipient",
        params.recipient,
        "--adapter-address",
        params.adapterAddress,
        "--gas-limit",
        params.gasLimit.toString(),
        "--fallback-ref-time",
        String(params.fallbackWeight.refTime),
        "--fallback-proof-size",
        String(params.fallbackWeight.proofSize),
        "--remark",
        params.remark,
        "--channel-id",
        String(params.channelId),
      ]);
    default:
      throw new Error(`unsupported execution type: ${params.executionType}`);
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
