import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExecuteIntent,
  createSwapIntent,
  createTransferIntent,
} from "../../xroute-intents/index.mjs";
import { createRouteEngineQuoteProvider } from "../../xroute-sdk/internal/route-engine.mjs";
import {
  buildExecutionEnvelope,
  buildMoonbeamDispatchMetadata,
  getDefaultXcmCodecContext,
} from "../index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mainnetQuoteProvider = createRouteEngineQuoteProvider({
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
  const quote = await mainnetQuoteProvider.quote(intent);

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

test("buildExecutionEnvelope encodes a reserve-withdraw multihop transfer from moonbeam to hydration", async () => {
  const intent = createTransferIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "50000000000",
      recipient: aliceAddress,
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const reserveWithdraw = decoded.value[2];
  const reserveDelivery = reserveWithdraw.value.xcm[1];

  assert.equal(decoded.value[1].type, "WithdrawAsset");
  assert.equal(reserveWithdraw.type, "InitiateReserveWithdraw");
  assert.equal(reserveWithdraw.value.reserve.interior.type, "Here");
  assert.equal(reserveWithdraw.value.xcm[0].type, "BuyExecution");
  assert.equal(reserveDelivery.type, "DepositReserveAsset");
  assert.equal(reserveDelivery.value.dest.parents, 0);
  assert.equal(reserveDelivery.value.dest.interior.type, "X1");
  assert.equal(reserveDelivery.value.xcm[0].type, "BuyExecution");
  assert.equal(reserveDelivery.value.xcm[1].type, "DepositAsset");
});

test("buildExecutionEnvelope encodes a reserve-withdraw multihop transfer from bifrost to moonbeam", async () => {
  const intent = createTransferIntent({
    sourceChain: "bifrost",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "10000000000",
      recipient: aliceAddress,
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const reserveWithdraw = decoded.value[2];
  const reserveDelivery = reserveWithdraw.value.xcm[1];

  assert.equal(envelope.mode, "execute");
  assert.equal(decoded.type, "V5");
  assert.equal(decoded.value[1].type, "WithdrawAsset");
  assert.equal(reserveWithdraw.type, "InitiateReserveWithdraw");
  assert.equal(reserveWithdraw.value.reserve.interior.type, "X1");
  assert.equal(reserveWithdraw.value.xcm[0].type, "BuyExecution");
  assert.equal(reserveDelivery.type, "DepositReserveAsset");
  assert.equal(reserveDelivery.value.xcm[0].type, "BuyExecution");
  assert.equal(reserveDelivery.value.xcm[1].type, "DepositAsset");
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
  const quote = await mainnetQuoteProvider.quote(intent);

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
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = finalRemoteInstructions(decoded);

  assert.equal(remoteInstructions.length, 3);
  assert.equal(remoteInstructions[1].type, "ExchangeAsset");
  assert.equal(remoteInstructions[2].type, "InitiateReserveWithdraw");
  assert.equal(remoteInstructions[2].value.reserve.interior.type, "X1");
  assert.equal(remoteInstructions[2].value.xcm[0].type, "BuyExecution");
  assert.equal(remoteInstructions[2].value.xcm[1].type, "DepositAsset");
});

test("buildExecutionEnvelope encodes a reserve-withdraw multihop swap with hub settlement", async () => {
  const intent = createSwapIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "100000000000",
      minAmountOut: "49000000",
      settlementChain: "polkadot-hub",
      recipient: "0x1111111111111111111111111111111111111111",
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const reserveWithdraw = decoded.value[2];
  const reserveDelivery = reserveWithdraw.value.xcm[1];
  const destinationInstructions = reserveDelivery.value.xcm;
  const beneficiary = destinationInstructions[2].value.xcm[1].value.beneficiary;

  assert.equal(decoded.value[1].type, "WithdrawAsset");
  assert.equal(reserveWithdraw.type, "InitiateReserveWithdraw");
  assert.equal(reserveDelivery.type, "DepositReserveAsset");
  assert.equal(reserveDelivery.value.dest.parents, 0);
  assert.equal(destinationInstructions[1].type, "ExchangeAsset");
  assert.equal(destinationInstructions[2].type, "InitiateReserveWithdraw");
  assert.equal(destinationInstructions[2].value.xcm[0].type, "BuyExecution");
  assert.equal(destinationInstructions[2].value.xcm[1].type, "DepositAsset");
  assert.equal(beneficiary.interior.type, "X1");
  assert.equal(beneficiary.interior.value.type, "AccountKey20");
  assert.equal(
    beneficiary.interior.value.value.key.asHex(),
    "0x1111111111111111111111111111111111111111",
  );
});

test("buildExecutionEnvelope encodes a moonbeam call via Transact", async () => {
  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "call",
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
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = finalRemoteInstructions(decoded);

  assert.equal(remoteInstructions[1].type, "Transact");
  assert.match(remoteInstructions[1].value.call.asHex(), /^0x6d0001/);
  assert.match(remoteInstructions[1].value.call.asHex(), /1111111111111111111111111111111111111111/);
});

test("buildExecutionEnvelope encodes a reserve-withdraw multihop moonbeam contract call", async () => {
  const intent = createExecuteIntent({
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "call",
      asset: "DOT",
      maxPaymentAmount: "200000000",
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
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const reserveWithdraw = decoded.value[2];
  const reserveDelivery = reserveWithdraw.value.xcm[1];

  assert.equal(decoded.value[1].type, "WithdrawAsset");
  assert.equal(reserveWithdraw.type, "InitiateReserveWithdraw");
  assert.equal(reserveDelivery.type, "DepositReserveAsset");
  assert.equal(reserveDelivery.value.xcm[0].type, "BuyExecution");
  assert.equal(reserveDelivery.value.xcm[1].type, "Transact");
  assert.match(reserveDelivery.value.xcm[1].value.call.asHex(), /^0x6d0001/);
});

test("buildExecutionEnvelope encodes Moonbeam transfer recipients as AccountKey20", async () => {
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "0x1111111111111111111111111111111111111111",
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = finalRemoteInstructions(decoded);
  const beneficiary = remoteInstructions[1].value.beneficiary;

  assert.equal(remoteInstructions[1].type, "DepositAsset");
  assert.equal(beneficiary.interior.type, "X1");
  assert.equal(beneficiary.interior.value.type, "AccountKey20");
  assert.equal(
    beneficiary.interior.value.value.key.asHex(),
    "0x1111111111111111111111111111111111111111",
  );
});

function finalRemoteInstructions(decoded) {
  const outerInstruction = decoded.value[1];

  if (outerInstruction.type === "WithdrawAsset") {
    const reserveWithdraw = decoded.value[2];
    if (reserveWithdraw?.type === "InitiateReserveWithdraw") {
      const reserveDelivery = reserveWithdraw.value.xcm.find(
        (instruction) => instruction.type === "DepositReserveAsset",
      );

      return reserveDelivery ? reserveDelivery.value.xcm : reserveWithdraw.value.xcm;
    }
  }

  const nestedTransfer = outerInstruction.value.xcm.find(
    (instruction) => instruction.type === "TransferReserveAsset",
  );

  return nestedTransfer ? nestedTransfer.value.xcm : outerInstruction.value.xcm;
}

test("buildMoonbeamDispatchMetadata derives reserve-side custom XCM for moonbeam to hydration transfers", async () => {
  const intent = createTransferIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "50000000000",
      recipient: aliceAddress,
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const moonbeamDispatch = buildMoonbeamDispatchMetadata({ quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(
    moonbeamDispatch.customXcmOnDest,
  );

  assert.equal(moonbeamDispatch.asset, "DOT");
  assert.equal(moonbeamDispatch.destinationChain, "hydration");
  assert.equal(moonbeamDispatch.remoteReserveChain, "polkadot-relay");
  assert.equal(decoded.type, "V5");
  assert.equal(decoded.value[0].type, "BuyExecution");
  assert.equal(decoded.value[1].type, "DepositAsset");
});

test("buildMoonbeamDispatchMetadata derives reserve-side custom XCM for moonbeam swaps", async () => {
  const intent = createSwapIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "100000000000",
      minAmountOut: "49000000",
      settlementChain: "polkadot-hub",
      recipient: "0x1111111111111111111111111111111111111111",
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const moonbeamDispatch = buildMoonbeamDispatchMetadata({ quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(
    moonbeamDispatch.customXcmOnDest,
  );

  assert.equal(moonbeamDispatch.asset, "DOT");
  assert.equal(moonbeamDispatch.destinationChain, "hydration");
  assert.equal(moonbeamDispatch.remoteReserveChain, "polkadot-relay");
  assert.equal(decoded.value[0].type, "BuyExecution");
  assert.equal(decoded.value[1].type, "ExchangeAsset");
  assert.equal(decoded.value[2].type, "InitiateReserveWithdraw");
});

test("buildMoonbeamDispatchMetadata derives reserve-side custom XCM for moonbeam to bifrost BNC transfers", async () => {
  const intent = createTransferIntent({
    sourceChain: "moonbeam",
    destinationChain: "bifrost",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "BNC",
      amount: "1000000000000",
      recipient: aliceAddress,
    },
  });
  const quote = await mainnetQuoteProvider.quote(intent);

  const moonbeamDispatch = buildMoonbeamDispatchMetadata({ quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(
    moonbeamDispatch.customXcmOnDest,
  );

  assert.equal(moonbeamDispatch.asset, "BNC");
  assert.equal(moonbeamDispatch.destinationChain, "bifrost");
  assert.equal(moonbeamDispatch.remoteReserveChain, "bifrost");
  assert.equal(decoded.value[0].type, "BuyExecution");
  assert.equal(decoded.value[1].type, "DepositAsset");
});
