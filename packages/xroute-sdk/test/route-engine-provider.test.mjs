import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCallIntent,
  createSwapIntent,
  createTransferIntent,
} from "../../xroute-intents/index.mjs";
import { createRouteEngineQuoteProvider, createXRouteClient, normalizeQuote } from "../index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const aliceAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

test("route engine quote provider bridges the rust planner", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
  });
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "asset-hub",
    refundAddress: "5Frefund",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "5Frecipient",
    },
  });

  const quote = normalizeQuote(await provider.quote(intent));

  assert.equal(quote.quoteId, intent.quoteId);
  assert.deepEqual(quote.route, ["polkadot-hub", "asset-hub"]);
  assert.equal(quote.submission.action, "transfer");
  assert.equal(quote.submission.amount, 250000000000n);
  assert.equal(quote.fees.totalFee.amount, 370000000n);
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
    refundAddress: aliceAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: aliceAddress,
    },
  });

  const execution = await client.execute({
    intent,
    owner: aliceAddress,
  });

  assert.equal(execution.submitted.request.actionType, 1);
  assert.match(execution.submitted.request.executionHash, /^0x[0-9a-f]{64}$/);
  assert.equal(routerAdapter.dispatched.mode, 0);
  assert.match(routerAdapter.dispatched.message, /^0x[0-9a-f]+$/);
});

test("route engine quote provider returns adapter-backed remote calls", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
  });
  const intent = createCallIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: aliceAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "50000000000",
      target: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
    },
  });

  const quote = normalizeQuote(await provider.quote(intent));
  const remoteInstructions = quote.executionPlan.steps[4].instructions[0].remoteInstructions;

  assert.equal(quote.submission.action, "call");
  assert.equal(remoteInstructions[1].type, "transact");
  assert.equal(remoteInstructions[1].adapter, "hydration-call-v1");
  assert.match(remoteInstructions[1].encodedCall, /^0x7db7dbf6[0-9a-f]+$/);
});
