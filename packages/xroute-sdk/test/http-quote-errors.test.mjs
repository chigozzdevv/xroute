import test from "node:test";
import assert from "node:assert/strict";

import { createHttpQuoteProvider } from "../internal/http.mjs";

test("createHttpQuoteProvider includes backend error details for non-OK responses", async () => {
  const provider = createHttpQuoteProvider({
    endpoint: "https://example.test/quote",
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() {
        return {
          error: "live quote inputs are required but no snapshot is loaded",
        };
      },
    }),
  });

  await assert.rejects(
    provider.quote({
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      asset: "DOT",
      amount: "10",
      recipient: "5Frecipient",
    }),
    /http quote failed with status 503: live quote inputs are required but no snapshot is loaded/,
  );
});
