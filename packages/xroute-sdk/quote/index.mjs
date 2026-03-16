import {
  createExecuteIntent,
  createIntent,
  createSwapIntent,
  createTransferIntent,
  toPlainIntent,
} from "../../xroute-intents/index.mjs";
import { EXECUTION_TYPES, assertNonEmptyString } from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../xroute-precompile-interfaces/index.mjs";
import {
  assertNoBaseUrlOverride,
  resolveDefaultXRouteApiBaseUrl,
} from "../internal/constants.mjs";
import { normalizeQuote } from "./normalize.mjs";

export const DEFAULT_INTENT_DEADLINE_SECONDS = 60 * 60;

export { normalizeQuote } from "./normalize.mjs";

export function createQuote({
  apiKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  fetchImpl = globalThis.fetch,
  ...options
} = {}) {
  assertNoBaseUrlOverride("createQuote", options);
  const normalizedApiKey =
    apiKey === undefined || apiKey === null
      ? undefined
      : assertNonEmptyString("apiKey", apiKey);
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);
  const apiBaseUrl = resolveDefaultXRouteApiBaseUrl();
  const quoteProvider = createHttpQuoteProvider({
    endpoint: `${apiBaseUrl}/quote`,
    apiKey: normalizedApiKey,
    fetchImpl,
    headers: {
      "x-xroute-deployment-profile": normalizedDeploymentProfile,
    },
  });

  return {
    deploymentProfile: normalizedDeploymentProfile,

    async quote(input, requestOptions = {}) {
      const intent = createQuoteIntent(input, normalizedDeploymentProfile);
      const quote = normalizeQuote(await quoteProvider.quote(intent, requestOptions));

      if (quote.quoteId !== intent.quoteId) {
        throw new Error("quote id must match the normalized intent quote id");
      }

      return { intent, quote };
    },
  };
}

export function createQuoteIntent(input, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const normalizedDeploymentProfile = normalizeDeploymentProfile(
    input?.deploymentProfile ?? deploymentProfile,
  );

  if (input?.quoteId) {
    return input;
  }

  const inferredKind = input?.kind ?? inferQuoteIntentKind(input);

  if (inferredKind === "transfer") {
    return createTransferIntent({
      ...buildBaseIntentInput(input, normalizedDeploymentProfile),
      params: input.action?.params ?? input.params ?? {
        asset: input.asset,
        amount: input.amount,
        recipient: input.recipient,
      },
    });
  }

  if (inferredKind === "swap") {
    return createSwapIntent({
      ...buildBaseIntentInput(input, normalizedDeploymentProfile),
      params: input.action?.params ?? input.params ?? {
        assetIn: input.assetIn,
        assetOut: input.assetOut,
        amountIn: input.amountIn,
        minAmountOut: input.minAmountOut,
        settlementChain: input.settlementChain,
        recipient: input.recipient,
      },
    });
  }

  if (inferredKind === "execute") {
    const executionType =
      input.executionType ??
      input.action?.params?.executionType ??
      input.params?.executionType ??
      EXECUTION_TYPES.CALL;

    return createExecuteIntent({
      ...buildBaseIntentInput(input, normalizedDeploymentProfile),
      params: input.action?.params ?? input.params ?? {
        executionType,
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
  }

  return createIntent({
    ...input,
    deploymentProfile: normalizedDeploymentProfile,
    deadline: input?.deadline ?? defaultIntentDeadline(),
  });
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
    async quote(intentInput, requestOptions = {}) {
      const intent = createQuoteIntent(intentInput, normalizedDeploymentProfile ?? undefined);
      const response = await fetchImpl(normalizedEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...requestHeaders,
        },
        body: JSON.stringify({
          intent: toPlainIntent(intent),
        }),
        signal: requestOptions.signal,
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

function buildBaseIntentInput(input, deploymentProfile) {
  return {
    deploymentProfile,
    sourceChain: input.sourceChain,
    destinationChain: input.destinationChain,
    refundAddress: input.refundAddress,
    senderAddress: input.senderAddress,
    ownerAddress: input.ownerAddress,
    deadline: input.deadline ?? defaultIntentDeadline(),
  };
}

function defaultIntentDeadline() {
  return Math.floor(Date.now() / 1000) + DEFAULT_INTENT_DEADLINE_SECONDS;
}

function inferQuoteIntentKind(input) {
  if (!input || typeof input !== "object" || input.action?.type) {
    return null;
  }

  if (hasAnyDefined(input, [
    "contractAddress",
    "calldata",
    "maxPaymentAmount",
    "executionType",
    "adapterAddress",
    "remark",
    "channelId",
  ])) {
    return "execute";
  }

  if (hasAnyDefined(input, [
    "assetIn",
    "assetOut",
    "amountIn",
    "minAmountOut",
    "settlementChain",
  ])) {
    return "swap";
  }

  if (hasAnyDefined(input, ["asset", "amount", "recipient"])) {
    return "transfer";
  }

  return null;
}

function hasAnyDefined(input, keys) {
  return keys.some((key) => input[key] !== undefined && input[key] !== null);
}
