import {
  createIntent,
  toPlainIntent,
} from "../xroute-intents/index.mjs";
import {
  ACTION_TYPES,
  assertIncluded,
  assertNonEmptyString,
  toBigInt,
} from "../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../xroute-precompile-interfaces/index.mjs";

export const DEFAULT_XROUTE_API_BASE_URL = "https://xroute-api.onrender.com/v1";

export function createBrowserQuoteClient({
  baseUrl = DEFAULT_XROUTE_API_BASE_URL,
  apiKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedApiKey =
    apiKey === undefined || apiKey === null
      ? undefined
      : assertNonEmptyString("apiKey", apiKey);
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);
  const quoteProvider = createHttpQuoteProvider({
    endpoint: `${normalizedBaseUrl}/quote`,
    apiKey: normalizedApiKey,
    fetchImpl,
    headers: {
      "x-xroute-deployment-profile": normalizedDeploymentProfile,
    },
  });

  return {
    async quote(intentInput) {
      const intent = intentInput?.quoteId
        ? intentInput
        : createIntent({
            ...intentInput,
            deploymentProfile:
              intentInput?.deploymentProfile ?? normalizedDeploymentProfile,
          });
      const quote = normalizeQuote(await quoteProvider.quote(intent));

      if (quote.quoteId !== intent.quoteId) {
        throw new Error("quote id must match the normalized intent quote id");
      }

      return { intent, quote };
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
      const intent = intentInput?.quoteId
        ? intentInput
        : createIntent({
            ...intentInput,
            deploymentProfile:
              intentInput?.deploymentProfile ?? normalizedDeploymentProfile ?? undefined,
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

function normalizeBaseUrl(baseUrl) {
  const normalized = String(baseUrl ?? DEFAULT_XROUTE_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (normalized === "") {
    throw new Error("baseUrl is required");
  }

  return normalized;
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
