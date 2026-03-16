import { assertNonEmptyString } from "../../xroute-types/index.mjs";
import {
  DEFAULT_XROUTE_API_BASE_URL,
  assertNoBaseUrlOverride,
} from "../internal/constants.mjs";

export function createStatusClient({ apiKey, fetchImpl, ...options } = {}) {
  assertNoBaseUrlOverride("createStatusClient", options);
  return createHttpStatusProvider({
    endpoint: DEFAULT_XROUTE_API_BASE_URL,
    apiKey,
    fetchImpl,
  });
}

export const trackStatus = createStatusClient;

export function createHttpStatusProvider({
  endpoint,
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedEndpoint = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (normalizedEndpoint === "") {
    throw new Error("endpoint is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const requestHeaders = {};
  if (apiKey) {
    requestHeaders["x-api-key"] = apiKey;
  }

  return {
    async getStatus(intentId) {
      const normalizedIntentId = assertNonEmptyString("intentId", intentId);
      const response = await fetchImpl(
        `${normalizedEndpoint}/intents/${encodeURIComponent(normalizedIntentId)}/status`,
        { method: "GET", headers: requestHeaders },
      );

      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`status request failed with status ${response.status}`);
      }

      return response.json();
    },

    async getTimeline(intentId) {
      const normalizedIntentId = assertNonEmptyString("intentId", intentId);
      const response = await fetchImpl(
        `${normalizedEndpoint}/intents/${encodeURIComponent(normalizedIntentId)}/timeline`,
        { method: "GET", headers: requestHeaders },
      );

      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new Error(`timeline request failed with status ${response.status}`);
      }

      const payload = await response.json();
      return payload?.timeline ?? payload ?? [];
    },

    subscribe(_listener) {
      return () => {};
    },
  };
}
