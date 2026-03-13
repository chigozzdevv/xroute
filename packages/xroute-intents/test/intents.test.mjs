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

test("createTransferIntent falls back to senderAddress for refunds", () => {
  const intent = createTransferIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    senderAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "10",
      recipient: "5Frecipient",
    },
  });

  assert.equal(intent.refundAddress, "0x1111111111111111111111111111111111111111");
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

test("createExecuteIntent rejects runtime-call execution types", () => {
  assert.throws(
    () =>
      createExecuteIntent({
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
      }),
    /action\.params\.executionType must be one of: call, mint-vdot, redeem-vdot/,
  );
});

test("createExecuteIntent applies default moonbeam call controls", () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      executionType: "call",
      asset: "dot",
      maxPaymentAmount: "110000000",
      contractAddress: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
    },
  });

  assert.equal(intent.action.params.executionType, "call");
  assert.equal(intent.action.params.contractAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(intent.action.params.calldata, "0xdeadbeef");
  assert.equal(intent.action.params.value, 0n);
  assert.equal(intent.action.params.gasLimit, 250000n);
  assert.equal(intent.action.params.fallbackWeight.refTime, 650000000);
  assert.equal(intent.action.params.fallbackWeight.proofSize, 12288);
});

test("createExecuteIntent lets callers override default moonbeam call controls", () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      executionType: "call",
      asset: "dot",
      maxPaymentAmount: "110000000",
      contractAddress: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
      value: "25",
      gasLimit: "310000",
      fallbackWeight: {
        refTime: 500000000,
        proofSize: 8192,
      },
    },
  });

  assert.equal(intent.action.params.value, 25n);
  assert.equal(intent.action.params.gasLimit, 310000n);
  assert.equal(intent.action.params.fallbackWeight.refTime, 500000000);
  assert.equal(intent.action.params.fallbackWeight.proofSize, 8192);
});

test("createExecuteIntent rejects mint-vdot until live support is re-enabled", () => {
  assert.throws(
    () =>
      createExecuteIntent({
        sourceChain: "hydration",
        destinationChain: "moonbeam",
        refundAddress: "0x1111111111111111111111111111111111111111",
        deadline: 1_773_185_200,
        params: {
          executionType: "mint-vdot",
          amount: "10000000000",
          maxPaymentAmount: "200000000",
          recipient: "0x1111111111111111111111111111111111111111",
          adapterAddress: "0x2222222222222222222222222222222222222222",
        },
      }),
    /execution type mint-vdot is not supported on destination moonbeam/,
  );
});

test("createExecuteIntent rejects redeem-vdot until the fee asset model supports it", () => {
  assert.throws(
    () =>
      createExecuteIntent({
        sourceChain: "bifrost",
        destinationChain: "moonbeam",
        refundAddress: "0x1111111111111111111111111111111111111111",
        deadline: 1_773_185_200,
        params: {
          executionType: "redeem-vdot",
          amount: "10000000000",
          maxPaymentAmount: "200000000",
          recipient: "0x1111111111111111111111111111111111111111",
          adapterAddress: "0x2222222222222222222222222222222222222222",
          gasLimit: "650000",
          remark: "OmniLS",
          channelId: 7,
          fallbackWeight: {
            refTime: 700000000,
            proofSize: 16384,
          },
        },
      }),
    /asset VDOT cannot reach moonbeam from bifrost/,
  );
});
