import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCallIntent,
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
  assert.equal(quote.deploymentProfile, DEPLOYMENT_PROFILES.LOCAL);
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
  const remoteInstructions = finalRemoteInstructions(quote);

  assert.equal(quote.deploymentProfile, DEPLOYMENT_PROFILES.LOCAL);
  assert.deepEqual(quote.route, ["polkadot-hub", "asset-hub", "hydration"]);
  assert.equal(quote.submission.action, "call");
  assert.equal(remoteInstructions[0].type, "buy-execution");
  assert.equal(remoteInstructions[1].type, "transact");
  assert.equal(remoteInstructions[1].adapter, "hydration-call-v1");
  assert.equal(remoteInstructions[1].targetAddress, "0x0000000000000000000000000000000000001003");
  assert.match(remoteInstructions[1].contractCall, /^0x7db7dbf6[0-9a-f]+$/);
});

test("route engine quote provider selects published testnet deployments", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
    deploymentProfile: DEPLOYMENT_PROFILES.TESTNET,
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
  const remoteInstructions = finalRemoteInstructions(quote);

  assert.equal(quote.deploymentProfile, DEPLOYMENT_PROFILES.TESTNET);
  assert.equal(remoteInstructions[1].targetAddress, "0x0000000000000000000000000000000000002003");
});

test("http quote provider forwards normalized intents and returns quotes", async () => {
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
            deploymentProfile: "local",
            route: ["polkadot-hub", "asset-hub"],
            fees: {
              xcmFee: { asset: "DOT", amount: "100000000" },
              destinationFee: { asset: "DOT", amount: "20000000" },
              platformFee: { asset: "DOT", amount: "250000000" },
              totalFee: { asset: "DOT", amount: "370000000" },
            },
            expectedOutput: { asset: "DOT", amount: "250000000000" },
            minOutput: { asset: "DOT", amount: "250000000000" },
            submission: {
              action: "transfer",
              asset: "DOT",
              amount: "250000000000",
              xcmFee: "100000000",
              destinationFee: "20000000",
              minOutputAmount: "250000000000",
            },
            executionPlan: {
              route: ["polkadot-hub", "asset-hub"],
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
  assert.equal(quote.fees.totalFee.amount, 370000000n);
});

function finalRemoteInstructions(quote) {
  const sendStep = quote.executionPlan.steps.find((step) => step.type === "send-xcm");
  const outerTransfer = sendStep.instructions[0];
  const innerTransfer = outerTransfer.remoteInstructions[1];

  return innerTransfer.remoteInstructions;
}
