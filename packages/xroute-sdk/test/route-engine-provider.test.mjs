import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSwapIntent,
  createTransferIntent,
} from "../../xroute-intents/index.mjs";
import { DEPLOYMENT_PROFILES } from "../../xroute-precompile-interfaces/index.mjs";
import {
  createHttpQuoteProvider,
  createRouteEngineQuoteProvider,
  createXRouteClient,
  normalizeQuote,
} from "../index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const recipientAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const walletAddress = "0x1111111111111111111111111111111111111111";

test("route engine quote provider bridges the rust planner", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
  });
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "5Frecipient",
    },
  });

  const quote = normalizeQuote(await provider.quote(intent));

  assert.equal(quote.quoteId, intent.quoteId);
  assert.equal(quote.deploymentProfile, DEPLOYMENT_PROFILES.TESTNET);
  assert.deepEqual(quote.route, ["polkadot-hub", "hydration"]);
  assert.equal(quote.segments.length, 1);
  assert.equal(quote.submission.action, "transfer");
  assert.equal(quote.submission.amount, 250000000000n);
  assert.equal(quote.fees.totalFee.amount, 490000000n);
});

test("sdk execute derives the XCM envelope from the route-engine quote", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
  });

  class MemoryRouterAdapter {
    async submitIntent({ request }) {
      this.submitted = request;
      return {
        intentId: "0xintent",
        request,
      };
    }

    async dispatchIntent({ request }) {
      this.dispatched = request;
      return {
        intentId: "0xintent",
        request,
      };
    }
  }

  const routerAdapter = new MemoryRouterAdapter();
  const client = createXRouteClient({
    quoteProvider: provider,
    routerAdapter,
    statusProvider: {
      getStatus() {
        return null;
      },
      getTimeline() {
        return [];
      },
      subscribe() {
        return () => {};
      },
    },
    assetAddressResolver: async () => "0x0000000000000000000000000000000000000401",
  });
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: walletAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      settlementChain: "hydration",
      recipient: recipientAddress,
    },
  });

  const execution = await client.execute({
    intent,
    owner: walletAddress,
  });

  assert.equal(execution.submitted.request.actionType, 1);
  assert.match(execution.submitted.request.executionHash, /^0x[0-9a-f]{64}$/);
  assert.equal(routerAdapter.dispatched.mode, 0);
  assert.match(routerAdapter.dispatched.message, /^0x[0-9a-f]+$/);
});

test("route engine quote provider quotes a hydration swap that settles on polkadot hub", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
  });
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: walletAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "493000000",
      settlementChain: "polkadot-hub",
      recipient: recipientAddress,
    },
  });

  const quote = normalizeQuote(await provider.quote(intent));
  const remoteInstructions = finalRemoteInstructions(quote);

  assert.deepEqual(quote.route, ["polkadot-hub", "hydration", "polkadot-hub"]);
  assert.equal(quote.segments.length, 2);
  assert.deepEqual(quote.segments[1].route, ["hydration", "polkadot-hub"]);
  assert.deepEqual(quote.estimatedSettlementFee, {
    asset: "USDT",
    amount: 35000n,
  });
  assert.equal(quote.expectedOutput.amount, 493480000n);
  assert.equal(remoteInstructions.length, 3);
  assert.equal(remoteInstructions[1].type, "exchange-asset");
  assert.equal(remoteInstructions[2].type, "initiate-reserve-withdraw");
});

test("http quote provider forwards normalized intents and returns quotes", async () => {
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "5Frecipient",
    },
  });
  const provider = createHttpQuoteProvider({
    endpoint: "https://quote.example.test/quote",
    async fetchImpl(url, init) {
      assert.equal(url, "https://quote.example.test/quote");
      const body = JSON.parse(init.body);
      assert.equal(body.intent.quoteId, intent.quoteId);
      assert.equal(body.intent.action.type, "transfer");

      return {
        ok: true,
        async json() {
          return {
            deploymentProfile: "testnet",
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
                    transportFee: { asset: "DOT", amount: "150000000" },
                    buyExecutionFee: { asset: "DOT", amount: "90000000" },
                  },
                ],
                xcmFee: { asset: "DOT", amount: "150000000" },
                destinationFee: { asset: "DOT", amount: "90000000" },
              },
            ],
            fees: {
              xcmFee: { asset: "DOT", amount: "150000000" },
              destinationFee: { asset: "DOT", amount: "90000000" },
              platformFee: { asset: "DOT", amount: "250000000" },
              totalFee: { asset: "DOT", amount: "490000000" },
            },
            expectedOutput: { asset: "DOT", amount: "250000000000" },
            minOutput: { asset: "DOT", amount: "250000000000" },
            submission: {
              action: "transfer",
              asset: "DOT",
              amount: "250000000000",
              xcmFee: "150000000",
              destinationFee: "90000000",
              minOutputAmount: "250000000000",
            },
            executionPlan: {
              route: ["polkadot-hub", "hydration"],
              steps: [],
            },
          };
        },
      };
    },
  });

  const quote = normalizeQuote(await provider.quote(intent));

  assert.equal(quote.quoteId, intent.quoteId);
  assert.equal(quote.submission.action, "transfer");
  assert.equal(quote.fees.totalFee.amount, 490000000n);
});

function finalRemoteInstructions(quote) {
  const sendStep = quote.executionPlan.steps.find((step) => step.type === "send-xcm");
  const outerTransfer = sendStep.instructions[0];
  const nestedTransfer = outerTransfer.remoteInstructions.find(
    (instruction) => instruction.type === "transfer-reserve-asset",
  );

  return nestedTransfer ? nestedTransfer.remoteInstructions : outerTransfer.remoteInstructions;
}
