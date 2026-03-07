import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExecuteIntent,
  createSwapIntent,
  createTransferIntent,
} from "../../xroute-intents/index.mjs";
import { createRouteEngineQuoteProvider } from "../../xroute-sdk/index.mjs";
import { buildExecutionEnvelope, getDefaultXcmCodecContext } from "../index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const testnetQuoteProvider = createRouteEngineQuoteProvider({
  cwd: workspaceRoot,
});
const aliceAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const refundAddress = "0x2222222222222222222222222222222222222222";

test("buildExecutionEnvelope encodes a transfer reserve XCM payload", async () => {
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: aliceAddress,
    },
  });
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);

  assert.equal(envelope.mode, "execute");
  assert.match(envelope.messageHex, /^0x[0-9a-f]+$/);
  assert.equal(decoded.type, "V5");
  assert.equal(decoded.value[0].type, "SetFeesMode");
  assert.equal(decoded.value[1].type, "TransferReserveAsset");
  assert.equal(decoded.value[1].value.xcm[0].type, "BuyExecution");
  assert.equal(decoded.value[1].value.xcm[1].type, "DepositAsset");
});

test("buildExecutionEnvelope encodes the hydration runtime swap path", async () => {
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      settlementChain: "hydration",
      recipient: aliceAddress,
    },
  });
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const outerTransfer = decoded.value[1];
  const remoteInstructions = outerTransfer.value.xcm;

  assert.equal(envelope.mode, "execute");
  assert.equal(decoded.type, "V5");
  assert.equal(outerTransfer.type, "TransferReserveAsset");
  assert.equal(remoteInstructions[0].type, "BuyExecution");
  assert.equal(remoteInstructions[1].type, "ExchangeAsset");
  assert.equal(remoteInstructions[1].value.maximal, true);
  assert.equal(remoteInstructions[1].value.give.type, "Definite");
  assert.equal(remoteInstructions[1].value.want[0].fun.type, "Fungible");
  assert.equal(remoteInstructions[2].type, "DepositAsset");
  assert.equal(remoteInstructions.length, 3);
});

test("buildExecutionEnvelope encodes a hydration swap that settles on polkadot hub", async () => {
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "493000000",
      settlementChain: "polkadot-hub",
      recipient: aliceAddress,
    },
  });
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = hydrationRemoteInstructions(decoded);

  assert.equal(remoteInstructions.length, 3);
  assert.equal(remoteInstructions[1].type, "ExchangeAsset");
  assert.equal(remoteInstructions[2].type, "InitiateReserveWithdraw");
  assert.equal(remoteInstructions[2].value.reserve.interior.type, "X1");
  assert.equal(remoteInstructions[2].value.xcm[0].type, "BuyExecution");
  assert.equal(remoteInstructions[2].value.xcm[1].type, "DepositAsset");
});

test("buildExecutionEnvelope encodes a runtime call via Transact", async () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "runtime-call",
      asset: "DOT",
      maxPaymentAmount: "90000000",
      callData: "0x01020304",
      fallbackWeight: {
        refTime: 250000000,
        proofSize: 4096,
      },
    },
  });
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = hydrationRemoteInstructions(decoded);

  assert.equal(remoteInstructions.length, 2);
  assert.equal(remoteInstructions[1].type, "Transact");
  assert.equal(remoteInstructions[1].value.origin_kind.type, "SovereignAccount");
});

test("buildExecutionEnvelope encodes a moonbeam runtime call via Transact", async () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
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
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const outerTransfer = decoded.value[1];
  const remoteInstructions = outerTransfer.value.xcm;

  assert.equal(outerTransfer.type, "TransferReserveAsset");
  assert.equal(remoteInstructions[0].type, "BuyExecution");
  assert.equal(remoteInstructions[1].type, "Transact");
  assert.equal(remoteInstructions[1].value.call.asHex(), "0x05060708");
});

test("buildExecutionEnvelope encodes a moonbeam evm contract call via Transact", async () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "110000000",
      contractAddress: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  });
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = decoded.value[1].value.xcm;

  assert.equal(remoteInstructions[1].type, "Transact");
  assert.match(remoteInstructions[1].value.call.asHex(), /^0x260001/);
  assert.match(remoteInstructions[1].value.call.asHex(), /1111111111111111111111111111111111111111/);
});

test("buildExecutionEnvelope encodes a bifrost vtoken order via Transact", async () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "bifrost",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "vtoken-order",
      asset: "DOT",
      amount: "250000000000",
      maxPaymentAmount: "100000000",
      operation: "mint",
      recipient: aliceAddress,
      channelId: 7,
      remark: "xroute",
      fallbackWeight: {
        refTime: 600000000,
        proofSize: 12288,
      },
    },
  });
  const quote = await testnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = decoded.value[1].value.xcm;

  assert.equal(remoteInstructions[1].type, "Transact");
  assert.match(remoteInstructions[1].value.call.asHex(), /^0x7d000800/);
  assert.match(remoteInstructions[1].value.call.asHex(), /1878726f75746507000000$/);
});

function hydrationRemoteInstructions(decoded) {
  const outerTransfer = decoded.value[1];
  const nestedTransfer = outerTransfer.value.xcm.find(
    (instruction) => instruction.type === "TransferReserveAsset",
  );

  return nestedTransfer ? nestedTransfer.value.xcm : outerTransfer.value.xcm;
}
