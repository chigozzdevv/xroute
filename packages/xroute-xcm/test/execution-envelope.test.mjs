import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTransferIntent, createSwapIntent } from "../../xroute-intents/index.mjs";
import { createRouteEngineQuoteProvider } from "../../xroute-sdk/index.mjs";
import { buildExecutionEnvelope, getDefaultXcmCodecContext } from "../index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const quoteProvider = createRouteEngineQuoteProvider({
  cwd: workspaceRoot,
});
const aliceAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const bobAddress = "5FHneW46xGXgs5mUiveU4sbTyGBzmto4mKc9UEQx7JjvqSg";

test("buildExecutionEnvelope encodes a transfer reserve XCM payload", async () => {
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "asset-hub",
    refundAddress: bobAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: aliceAddress,
    },
  });
  const quote = await quoteProvider.quote(intent);

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

test("buildExecutionEnvelope encodes the hydration remote swap path", async () => {
  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: bobAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: aliceAddress,
    },
  });
  const quote = await quoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = decoded.value[1].value.xcm;

  assert.equal(envelope.mode, "execute");
  assert.equal(decoded.type, "V5");
  assert.equal(decoded.value[1].type, "TransferReserveAsset");
  assert.equal(remoteInstructions[0].type, "BuyExecution");
  assert.equal(remoteInstructions[1].type, "ExchangeAsset");
  assert.equal(remoteInstructions[2].type, "DepositAsset");
  assert.equal(remoteInstructions[1].value.maximal, true);
});
