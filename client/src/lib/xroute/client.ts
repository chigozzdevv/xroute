import type { QuoteRequest, QuoteResponse } from "./types";

export type {
  CallQuoteRequest,
  QuoteRequest,
  QuoteResponse,
  SwapQuoteRequest,
  TransferQuoteRequest,
} from "./types";

export async function requestXRouteQuote(input: QuoteRequest, signal?: AbortSignal) {
  const response = await fetch("/api/xroute/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? `quote request failed with status ${response.status}`);
  }

  return payload as QuoteResponse;
}
