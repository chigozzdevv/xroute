import test from "node:test";
import assert from "node:assert/strict";

import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
} from "../index.mjs";

test("createHttpQuoteProvider returns the nested quote payload", async () => {
  const provider = createHttpQuoteProvider({
    endpoint: "https://example.test/quote",
    fetchImpl: async (_url, request) => {
      assert.equal(request.method, "POST");
      return {
        ok: true,
        async json() {
          return {
            intent: {
              quoteId: "ignored",
            },
            quote: {
              quoteId: "ignored",
              deploymentProfile: "testnet",
              route: ["polkadot-hub", "hydration"],
              segments: [],
              fees: {
                xcmFee: { asset: "DOT", amount: "1" },
                destinationFee: { asset: "DOT", amount: "2" },
                platformFee: { asset: "DOT", amount: "3" },
                totalFee: { asset: "DOT", amount: "6" },
              },
              expectedOutput: { asset: "DOT", amount: "10" },
              minOutput: { asset: "DOT", amount: "10" },
              submission: {
                action: "transfer",
                asset: "DOT",
                amount: "10",
                xcmFee: "1",
                destinationFee: "2",
                minOutputAmount: "10",
              },
              executionPlan: {
                route: ["polkadot-hub", "hydration"],
                steps: [],
              },
            },
            routerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          };
        },
      };
    },
  });

  const quote = await provider.quote({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    action: {
      type: "transfer",
      params: {
        asset: "DOT",
        amount: "10",
        recipient: "5Frecipient",
      },
    },
  });

  assert.equal(quote.submission.action, "transfer");
  assert.equal(quote.route[0], "polkadot-hub");
});

test("createHttpExecutorRelayerClient sends relayer job requests", async () => {
  const seen = [];
  const client = createHttpExecutorRelayerClient({
    endpoint: "https://example.test",
    authToken: "secret-token",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            job: {
              id: "job-1",
            },
          };
        },
      };
    },
  });

  const response = await client.refund({
    intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    refundAmount: "10",
    refundAsset: "DOT",
  });

  assert.equal(response.job.id, "job-1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "https://example.test/jobs/refund");
  assert.equal(seen[0][1].headers.authorization, "Bearer secret-token");
});
