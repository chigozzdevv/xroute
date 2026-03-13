"use client";

import { useEffect, useMemo, useState } from "react";

import type { QuoteRequest, QuoteResponse } from "./client";
import { requestXRouteQuote } from "./client";

type UseXRouteQuoteOptions = {
  enabled?: boolean;
  debounceMs?: number;
};

export function useXRouteQuote(
  request: QuoteRequest | null,
  { enabled = true, debounceMs = 250 }: UseXRouteQuoteOptions = {},
) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serializedRequest = useMemo(
    () => (request && enabled ? JSON.stringify(request) : null),
    [enabled, request],
  );

  useEffect(() => {
    if (!serializedRequest) {
      setQuote(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setIsLoading(true);
      setError(null);

      try {
        const nextQuote = await requestXRouteQuote(
          JSON.parse(serializedRequest) as QuoteRequest,
          controller.signal,
        );
        setQuote(nextQuote);
      } catch (nextError) {
        if (controller.signal.aborted) {
          return;
        }
        setQuote(null);
        setError(nextError instanceof Error ? nextError.message : "quote failed");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [debounceMs, serializedRequest]);

  return {
    quote,
    isLoading,
    error,
    isReady: Boolean(quote) && !isLoading && !error,
  };
}
