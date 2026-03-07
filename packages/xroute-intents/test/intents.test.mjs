import test from "node:test";
import assert from "node:assert/strict";

import { createSwapIntent, createTransferIntent } from "../index.mjs";

test("createSwapIntent normalizes supported hydration swaps", () => {
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "5Frefund",
    deadline: 1_773_185_200,
    params: {
      assetIn: "dot",
      assetOut: "usdt",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      settlementChain: "asset-hub",
      recipient: "5Frecipient",
    },
  });

  assert.equal(intent.sourceChain, "polkadot-hub");
  assert.equal(intent.destinationChain, "hydration");
  assert.equal(intent.action.type, "swap");
  assert.equal(intent.action.params.assetIn, "DOT");
  assert.equal(intent.action.params.assetOut, "USDT");
  assert.equal(intent.action.params.settlementChain, "polkadot-hub");
  assert.equal(intent.action.params.amountIn, 1000000000000n);
  assert.match(intent.quoteId, /^0x[0-9a-f]{64}$/);
});

test("createTransferIntent canonicalizes asset-hub to polkadot-hub", () => {
  const intent = createTransferIntent({
    sourceChain: "asset-hub",
    destinationChain: "hydration",
    refundAddress: "5Frefund",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "10",
      recipient: "5Frecipient",
    },
  });

  assert.equal(intent.sourceChain, "polkadot-hub");
  assert.equal(intent.destinationChain, "hydration");
  assert.equal(intent.action.type, "transfer");
  assert.equal(intent.action.params.asset, "DOT");
  assert.equal(intent.action.params.amount, 10n);
});
