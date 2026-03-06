import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCallIntent,
  createStakeIntent,
  createSwapIntent,
  createTransferIntent,
} from "../../xroute-intents/index.mjs";
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

test("buildExecutionEnvelope encodes the hydration swap adapter path", async () => {
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
  assert.equal(remoteInstructions[1].type, "Transact");
  assert.equal(remoteInstructions[2].type, "DepositAsset");
  assert.equal(remoteInstructions[1].value.origin_kind.type, "SovereignAccount");
  assert.equal(remoteInstructions[1].value.fallback_max_weight.ref_time, 3500000000n);
  assert.equal(remoteInstructions[1].value.fallback_max_weight.proof_size, 120000n);
  assert.ok(toHex(remoteInstructions[1].value.call).startsWith("0x00986153"));
  assert.ok(
    toHex(remoteInstructions[1].value.call).includes(
      "0000000000000000000000000000000000000000000000000000000000001001",
    ),
  );
});

test("buildExecutionEnvelope encodes the hydration stake adapter path", async () => {
  const intent = createStakeIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: bobAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "400000000000",
      validator: "validator-01",
      recipient: aliceAddress,
    },
  });
  const quote = await quoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = decoded.value[1].value.xcm;

  assert.equal(remoteInstructions[0].type, "BuyExecution");
  assert.equal(remoteInstructions[1].type, "Transact");
  assert.ok(toHex(remoteInstructions[1].value.call).startsWith("0x00986153"));
  assert.ok(
    toHex(remoteInstructions[1].value.call).includes(
      "0000000000000000000000000000000000000000000000000000000000001002",
    ),
  );
});

test("buildExecutionEnvelope encodes the hydration generic call adapter path", async () => {
  const intent = createCallIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: bobAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "50000000000",
      target: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
    },
  });
  const quote = await quoteProvider.quote(intent);

  const envelope = buildExecutionEnvelope({ intent, quote });
  const decoded = getDefaultXcmCodecContext().decodeVersionedXcm(envelope.messageHex);
  const remoteInstructions = decoded.value[1].value.xcm;

  assert.equal(remoteInstructions[0].type, "BuyExecution");
  assert.equal(remoteInstructions[1].type, "Transact");
  assert.ok(toHex(remoteInstructions[1].value.call).startsWith("0x00986153"));
  assert.ok(
    toHex(remoteInstructions[1].value.call).includes(
      "0000000000000000000000000000000000000000000000000000000000001003",
    ),
  );
});

test("buildExecutionEnvelope rejects a transact payload with a mismatched published selector", async () => {
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
  const badQuote = {
    ...quote,
    executionPlan: {
      ...quote.executionPlan,
      steps: quote.executionPlan.steps.map((step, stepIndex) =>
        stepIndex !== 4
          ? step
          : {
              ...step,
              instructions: step.instructions.map((instruction, instructionIndex) =>
                instructionIndex !== 0
                  ? instruction
                  : {
                      ...instruction,
                      remoteInstructions: instruction.remoteInstructions.map(
                        (remoteInstruction, remoteIndex) =>
                          remoteIndex !== 1
                            ? remoteInstruction
                            : {
                                ...remoteInstruction,
                                contractCall: "0xdeadbeef",
                              },
                      ),
                    },
              ),
            },
      ),
    },
  };

  assert.throws(
    () => buildExecutionEnvelope({ intent, quote: badQuote }),
    /must start with published selector 0x670b1f29/,
  );
});

test("buildExecutionEnvelope rejects a transact payload with a mismatched published target address", async () => {
  const intent = createStakeIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: bobAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "400000000000",
      validator: "validator-01",
      recipient: aliceAddress,
    },
  });
  const quote = await quoteProvider.quote(intent);
  const badQuote = {
    ...quote,
    executionPlan: {
      ...quote.executionPlan,
      steps: quote.executionPlan.steps.map((step, stepIndex) =>
        stepIndex !== 4
          ? step
          : {
              ...step,
              instructions: step.instructions.map((instruction, instructionIndex) =>
                instructionIndex !== 0
                  ? instruction
                  : {
                      ...instruction,
                      remoteInstructions: instruction.remoteInstructions.map(
                        (remoteInstruction, remoteIndex) =>
                          remoteIndex !== 1
                            ? remoteInstruction
                            : {
                                ...remoteInstruction,
                                targetAddress: "0x0000000000000000000000000000000000001999",
                              },
                      ),
                    },
              ),
            },
      ),
    },
  };

  assert.throws(
    () => buildExecutionEnvelope({ intent, quote: badQuote }),
    /must match published deployment 0x0000000000000000000000000000000000001002/,
  );
});

function toHex(value) {
  if (typeof value === "string") {
    return value.toLowerCase();
  }

  if (value?.asHex) {
    return value.asHex().toLowerCase();
  }

  return `0x${Buffer.from(value).toString("hex")}`;
}
