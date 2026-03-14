import {
  createIntent,
  toPlainIntent,
} from "../../xroute-intents/index.mjs";
import {
  assertNonEmptyString,
} from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../xroute-precompile-interfaces/index.mjs";
import { normalizeQuote } from "../quotes/normalize-quote.mjs";

export const DEFAULT_XROUTE_API_BASE_URL = "https://xroute-api.onrender.com/v1";

export function createQuote({
  baseUrl = DEFAULT_XROUTE_API_BASE_URL,
  apiKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = String(baseUrl ?? DEFAULT_XROUTE_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (normalizedBaseUrl === "") {
    throw new Error("baseUrl is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const normalizedApiKey =
    apiKey === undefined || apiKey === null
      ? undefined
      : assertNonEmptyString("apiKey", apiKey);
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);
  const endpoint = `${normalizedBaseUrl}/quote`;

  const requestHeaders = {};
  if (normalizedApiKey) {
    requestHeaders["x-api-key"] = normalizedApiKey;
  }
  if (normalizedDeploymentProfile) {
    requestHeaders["x-xroute-deployment-profile"] = normalizedDeploymentProfile;
  }

  return {
    deploymentProfile: normalizedDeploymentProfile,

    async quote(intentInput) {
      const intent = intentInput?.quoteId
        ? intentInput
        : createIntent({
            ...intentInput,
            deploymentProfile:
              intentInput?.deploymentProfile ?? normalizedDeploymentProfile,
          });
      const response = await fetchImpl(endpoint, {
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
        throw new Error(`quote request failed with status ${response.status}`);
      }

      const payload = await response.json();
      const resolvedQuote = payload?.quote ?? payload;
      if (!resolvedQuote?.submission) {
        throw new Error("quote response is missing quote data");
      }

      const quote = normalizeQuote({
        ...resolvedQuote,
        quoteId: intent.quoteId,
      });

      if (quote.quoteId !== intent.quoteId) {
        throw new Error("quote id must match the normalized intent quote id");
      }

      return { intent, quote };
    },
  };
}
