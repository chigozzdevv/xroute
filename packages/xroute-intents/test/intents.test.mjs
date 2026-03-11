import test from "node:test";
import assert from "node:assert/strict";

import { createExecuteIntent, createSwapIntent, createTransferIntent } from "../index.mjs";

test("createSwapIntent normalizes supported hydration swaps", () => {
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
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
    refundAddress: "0x1111111111111111111111111111111111111111",
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

test("createTransferIntent accepts a multihop moonbeam to hydration transfer", () => {
  const intent = createTransferIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "10",
      recipient: "5Frecipient",
    },
  });

  assert.equal(intent.sourceChain, "moonbeam");
  assert.equal(intent.destinationChain, "hydration");
  assert.equal(intent.action.type, "transfer");
  assert.equal(intent.action.params.asset, "DOT");
});

test("createSwapIntent accepts a multihop moonbeam to hydration swap", () => {
  const intent = createSwapIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      settlementChain: "polkadot-hub",
      recipient: "5Frecipient",
    },
  });

  assert.equal(intent.sourceChain, "moonbeam");
  assert.equal(intent.destinationChain, "hydration");
  assert.equal(intent.action.type, "swap");
  assert.equal(intent.action.params.settlementChain, "polkadot-hub");
});

test("createExecuteIntent normalizes a runtime call on hydration", () => {
  const intent = createExecuteIntent({
    sourceChain: "asset-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      executionType: "runtime-call",
      asset: "dot",
      maxPaymentAmount: "90000000",
      callData: "0x01020304",
      fallbackWeight: {
        refTime: 250000000,
        proofSize: 4096,
      },
    },
  });

  assert.equal(intent.sourceChain, "polkadot-hub");
  assert.equal(intent.destinationChain, "hydration");
  assert.equal(intent.action.type, "execute");
  assert.equal(intent.action.params.executionType, "runtime-call");
  assert.equal(intent.action.params.asset, "DOT");
  assert.equal(intent.action.params.maxPaymentAmount, 90000000n);
  assert.equal(intent.action.params.callData, "0x01020304");
  assert.equal(intent.action.params.originKind, "sovereign-account");
  assert.deepEqual(intent.action.params.fallbackWeight, {
    refTime: 250000000,
    proofSize: 4096,
  });
});

test("createExecuteIntent supports a runtime call on moonbeam", () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      executionType: "runtime-call",
      asset: "DOT",
      maxPaymentAmount: "110000000",
      callData: "0x05060708",
      fallbackWeight: {
        refTime: 500000000,
        proofSize: 8192,
      },
    },
  });

  assert.equal(intent.destinationChain, "moonbeam");
  assert.equal(intent.action.type, "execute");
  assert.equal(intent.action.params.executionType, "runtime-call");
  assert.equal(intent.action.params.asset, "DOT");
});

test("createExecuteIntent normalizes a moonbeam evm contract call", () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      executionType: "evm-contract-call",
      asset: "dot",
      maxPaymentAmount: "110000000",
      contractAddress: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 500000000,
        proofSize: 8192,
      },
    },
  });

  assert.equal(intent.action.params.executionType, "evm-contract-call");
  assert.equal(intent.action.params.contractAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(intent.action.params.calldata, "0xdeadbeef");
  assert.equal(intent.action.params.value, 0n);
  assert.equal(intent.action.params.gasLimit, 250000n);
});
