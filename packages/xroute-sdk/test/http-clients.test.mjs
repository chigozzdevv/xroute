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
              deploymentProfile: "mainnet",
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

test("createHttpExecutorRelayerClient builds and sends dispatch requests", async () => {
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
            job: {
              id: "job-2",
              status: "queued",
            },
          };
        },
      };
    },
  });

  const intent = {
    quoteId: "0xfeedface",
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    action: {
      type: "transfer",
      params: {
        asset: "DOT",
        amount: "10",
        recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      },
    },
  };
  const quote = {
    quoteId: "0xfeedface",
    deploymentProfile: "mainnet",
    route: ["polkadot-hub", "hydration"],
    segments: [
      {
        kind: "execution",
        route: ["polkadot-hub", "hydration"],
        hops: [
          {
            source: "polkadot-hub",
            destination: "hydration",
            asset: "DOT",
            transportFee: { asset: "DOT", amount: "1" },
            buyExecutionFee: { asset: "DOT", amount: "2" },
          },
        ],
        xcmFee: { asset: "DOT", amount: "1" },
        destinationFee: { asset: "DOT", amount: "2" },
      },
    ],
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
      steps: [
        {
          type: "send-xcm",
          origin: "polkadot-hub",
          destination: "hydration",
          instructions: [
            {
              type: "transfer-reserve-asset",
              asset: "DOT",
              amount: "10",
              destination: "hydration",
              remoteInstructions: [
                {
                  type: "buy-execution",
                  asset: "DOT",
                  amount: "2",
                },
                {
                  type: "deposit-asset",
                  asset: "DOT",
                  recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                  assetCount: 1,
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const response = await client.dispatch({
    intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    intent,
    quote,
  });

  assert.equal(response.job.id, "job-2");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "https://example.test/jobs/dispatch");
  const payload = JSON.parse(seen[0][1].body);
  assert.equal(payload.intent.quoteId, "0xfeedface");
  assert.equal(payload.request.mode, 0);
  assert.match(payload.request.message, /^0x[0-9a-f]+$/);
});
