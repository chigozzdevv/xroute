import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDispatchRequest,
  buildRouterIntentRequest,
  computeExecutionHash,
  createDispatchEnvelope,
} from "../index.mjs";
import { createSwapIntent } from "../../xroute-intents/index.mjs";

test("computeExecutionHash is deterministic for the same envelope", () => {
  const envelope = createDispatchEnvelope({
    mode: "execute",
    message: "0x1234",
  });

  const first = computeExecutionHash(envelope);
  const second = computeExecutionHash(envelope);

  assert.equal(first, second);
  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(buildDispatchRequest(envelope), {
    mode: 0,
    destination: "0x",
    message: "0x1234",
  });
});

test("buildRouterIntentRequest matches the contract-facing request shape", () => {
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: "5Frecipient",
    },
  });
  const quote = {
    quoteId: intent.quoteId,
    route: ["polkadot-hub", "hydration"],
    fees: {
      xcmFee: { asset: "DOT", amount: 150000000n },
      destinationFee: { asset: "DOT", amount: 100000000n },
      platformFee: { asset: "DOT", amount: 1000000000n },
      totalFee: { asset: "DOT", amount: 1250000000n },
    },
    expectedOutput: { asset: "USDT", amount: 493515000n },
    minOutput: { asset: "USDT", amount: 490000000n },
    submission: {
      action: "swap",
      asset: "DOT",
      amount: 1000000000000n,
      xcmFee: 150000000n,
      destinationFee: 100000000n,
      minOutputAmount: 490000000n,
    },
    executionPlan: { route: ["polkadot-hub", "hydration"], steps: [] },
  };
  const envelope = createDispatchEnvelope({
    mode: "execute",
    message: "0x1234",
  });

  const request = buildRouterIntentRequest({
    intent,
    quote,
    envelope,
    assetAddress: "0x0000000000000000000000000000000000000000",
  });

  assert.equal(request.actionType, 1);
  assert.equal(request.asset, "0x0000000000000000000000000000000000000000");
  assert.equal(request.refundAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(request.amount, 1000000000000n);
  assert.equal(request.deadline, 1773185200);
  assert.match(request.executionHash, /^0x[0-9a-f]{64}$/);
});
