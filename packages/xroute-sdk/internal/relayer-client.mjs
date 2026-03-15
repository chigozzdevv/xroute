import {
  createIntent,
  toPlainIntent,
} from "../../xroute-intents/index.mjs";
import {
  toBigInt,
  toPlainObject,
} from "../../xroute-types/index.mjs";
import {
  buildExecutionEnvelope,
  buildDispatchRequest,
  createDispatchEnvelope,
} from "../../xroute-xcm/index.mjs";
import { normalizeQuote } from "../quote/index.mjs";

const SUBSTRATE_SOURCE_CHAINS = new Set(["hydration", "bifrost"]);

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
