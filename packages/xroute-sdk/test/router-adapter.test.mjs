import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createSwapIntent } from "../../xroute-intents/index.mjs";
import { buildDispatchRequest, createDispatchEnvelope } from "../../xroute-xcm/index.mjs";
import {
  createCastRouterAdapter,
  createSubstrateXcmAdapter,
  NATIVE_ASSET_ADDRESS,
  createSourceAwareRouterAdapter,
  createStaticAssetAddressResolver,
} from "../router-adapters.mjs";
import { InMemoryStatusIndexer } from "../status-indexer.mjs";

const signerAddress = "0x1111111111111111111111111111111111111111";
const recipientAccount = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const routerAddress = "0x2222222222222222222222222222222222222222";
const dotAddress = "0x3333333333333333333333333333333333333333";
const privateKey = `0x${randomBytes(32).toString("hex")}`;

test("static asset address resolver returns configured addresses", async () => {
  const resolveAssetAddress = createStaticAssetAddressResolver({
    "polkadot-hub": {
      DOT: dotAddress,
    },
  });

  assert.equal(
    await resolveAssetAddress({ chainKey: "polkadot-hub", assetKey: "DOT" }),
    dotAddress,
  );
});

test("cast router adapter approves, submits, dispatches, and persists status events", async () => {
  const calls = [];
  const statusIndexer = new InMemoryStatusIndexer();
  const adapter = createCastRouterAdapter({
    rpcUrl: "http://127.0.0.1:8545",
    routerAddress,
    privateKey,
    ownerAddress: signerAddress,
    statusIndexer,
    eventClock: () => 100,
    async commandRunner({ args }) {
      calls.push(args);
      const [command, ...rest] = args;

      if (command === "call" && rest[1] === "previewLockedAmount((uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32))(uint128)") {
        return { stdout: "1001250000000\n" };
      }
      if (command === "call" && rest[1] === "allowance(address,address)(uint256)") {
        return { stdout: "0\n" };
      }
      if (command === "call" && rest[1] === "nextIntentNonce()(uint256)") {
        return { stdout: "7\n" };
      }
      if (command === "send" && rest[0] === dotAddress) {
        return { stdout: "{\"transactionHash\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n" };
      }
      if (command === "send" && rest[0] === routerAddress && rest[1] === "submitIntent((uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32))") {
        return { stdout: "{\"transactionHash\":\"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}\n" };
      }
      if (command === "send" && rest[0] === routerAddress && rest[1] === "dispatchIntent(bytes32,(uint8,bytes,bytes))") {
        return { stdout: "{\"transactionHash\":\"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"}\n" };
      }
      if (command === "abi-encode") {
        return { stdout: "0x1234\n" };
      }
      if (command === "keccak") {
        return { stdout: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n" };
      }

      throw new Error(`unexpected cast call: ${args.join(" ")}`);
    },
  });

  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: signerAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: recipientAccount,
    },
  });
  const quote = {
    quoteId: intent.quoteId,
    deploymentProfile: "mainnet",
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
  const request = {
    actionType: 1,
    asset: dotAddress,
    refundAddress: signerAddress,
    amount: 1000000000000n,
    xcmFee: 150000000n,
    destinationFee: 100000000n,
    minOutputAmount: 490000000n,
    deadline: 1773185200,
    executionHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };

  const submitted = await adapter.submitIntent({
    owner: signerAddress,
    intent,
    quote,
    request,
  });
  const dispatched = await adapter.dispatchIntent({
    intentId: submitted.intentId,
    request: buildDispatchRequest(
      createDispatchEnvelope({
        mode: "execute",
        message: "0x1234",
      }),
    ),
  });

  assert.equal(submitted.intentId, "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
  assert.equal(submitted.lockedAmount, 1001250000000n);
  assert.equal(dispatched.txHash, "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
  assert.equal(statusIndexer.getStatus(submitted.intentId).status, "executing");
  assert.deepEqual(
    calls.filter((args) => args[0] === "send").map((args) => args[1]),
    [dotAddress, routerAddress, routerAddress],
  );
});

test("cast router adapter submits a native asset intent with value instead of approval", async () => {
  const calls = [];
  const adapter = createCastRouterAdapter({
    rpcUrl: "http://127.0.0.1:8545",
    routerAddress,
    privateKey,
    ownerAddress: signerAddress,
    async commandRunner({ args }) {
      calls.push(args);
      const [command, ...rest] = args;

      if (command === "call" && rest[1] === "previewLockedAmount((uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32))(uint128)") {
        return { stdout: "12345\n" };
      }
      if (command === "call" && rest[1] === "nextIntentNonce()(uint256)") {
        return { stdout: "8\n" };
      }
      if (command === "send" && rest[0] === routerAddress && rest[1] === "submitIntent((uint8,address,address,uint128,uint128,uint128,uint128,uint64,bytes32))") {
        return { stdout: "{\"transactionHash\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n" };
      }
      if (command === "abi-encode") {
        return { stdout: "0x1234\n" };
      }
      if (command === "keccak") {
        return { stdout: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" };
      }

      throw new Error(`unexpected cast call: ${args.join(" ")}`);
    },
  });

  const request = {
    actionType: 0,
    asset: NATIVE_ASSET_ADDRESS,
    refundAddress: signerAddress,
    amount: 10000n,
    xcmFee: 2000n,
    destinationFee: 300n,
    minOutputAmount: 10000n,
    deadline: 1773185200,
    executionHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };

  const submitted = await adapter.submitIntent({
    owner: signerAddress,
    intent: {
      quoteId: "quote-1",
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      refundAddress: signerAddress,
      deadline: 1773185200,
      action: { type: "transfer", params: { asset: "DOT", amount: 10000n, recipient: recipientAccount } },
    },
    quote: {
      quoteId: "quote-1",
      submission: {
        action: "transfer",
        asset: "DOT",
        amount: 10000n,
        xcmFee: 2000n,
        destinationFee: 300n,
        minOutputAmount: 10000n,
      },
    },
    request,
  });

  assert.equal(submitted.lockedAmount, 12345n);
  assert.equal(
    calls.some((args) => args[0] === "send" && args.includes("--value") && args.includes("12345")),
    true,
  );
  assert.equal(calls.some((args) => args[0] === "send" && args[1] === NATIVE_ASSET_ADDRESS), false);
});

test("cast router adapter finalizes and refunds intents onchain", async () => {
  const calls = [];
  const statusIndexer = new InMemoryStatusIndexer();
  const settledIntentId = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const failedIntentId = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  statusIndexer.ingest({
    type: "intent-submitted",
    at: 1,
    intentId: settledIntentId,
    quoteId: "quote-1",
    owner: signerAddress,
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    actionType: "swap",
    asset: "DOT",
    amount: "1000000000000",
  });
  statusIndexer.ingest({
    type: "intent-submitted",
    at: 2,
    intentId: failedIntentId,
    quoteId: "quote-2",
    owner: signerAddress,
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    actionType: "swap",
    asset: "DOT",
    amount: "1000000000000",
  });
  const adapter = createCastRouterAdapter({
    rpcUrl: "http://127.0.0.1:8545",
    routerAddress,
    privateKey,
    ownerAddress: signerAddress,
    statusIndexer,
    eventClock: () => 200,
    async commandRunner({ args }) {
      calls.push(args);
      const [command, ...rest] = args;

      if (command === "send" && rest[0] === routerAddress && rest[1] === "finalizeSuccess(bytes32,bytes32,bytes32,uint128)") {
        return { stdout: "{\"transactionHash\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\n" };
      }
      if (command === "send" && rest[0] === routerAddress && rest[1] === "finalizeFailure(bytes32,bytes32,bytes32)") {
        return { stdout: "{\"transactionHash\":\"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}\n" };
      }
      if (command === "send" && rest[0] === routerAddress && rest[1] === "refundFailedIntent(bytes32,uint128)") {
        return { stdout: "{\"transactionHash\":\"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"}\n" };
      }
      if (command === "call" && rest[1] === "previewRefundableAmount(bytes32)(uint128)") {
        return { stdout: "1000250000000\n" };
      }

      throw new Error(`unexpected cast call: ${args.join(" ")}`);
    },
  });

  const finalized = await adapter.finalizeSuccess({
    intentId: settledIntentId,
    outcomeReference: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    resultAssetId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    resultAmount: 493515000n,
  });
  const settledStatus = statusIndexer.getStatus(finalized.intentId);

  assert.equal(finalized.txHash, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(settledStatus.status, "settled");
  assert.equal(
    settledStatus.result.asset,
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(settledStatus.result.amount, 493515000n);

  const failedFinalization = await adapter.finalizeFailure({
    intentId: failedIntentId,
    outcomeReference: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    failureReasonHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  });
  const refundable = await adapter.previewRefundableAmount(failedIntentId);
  const refunded = await adapter.refundFailedIntent({
    intentId: failedFinalization.intentId,
    refundAmount: 1000250000000n,
  });
  const refundedStatus = statusIndexer.getStatus(refunded.intentId);

  assert.equal(refundable, 1000250000000n);
  assert.equal(refunded.txHash, "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
  assert.equal(refundedStatus.status, "refunded");
  assert.equal(refundedStatus.failureReason, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  assert.equal(refundedStatus.refund.asset, "DOT");
  assert.equal(refundedStatus.refund.amount, 1000250000000n);
});

test("source-aware router adapter routes calls by source chain and remembers intent mappings", async () => {
  const calls = [];
  const moonbeamIntentId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const hubIntentId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function makeAdapter(chainKey, intentId) {
    return {
      async submitIntent({ intent }) {
        calls.push(`submit:${chainKey}:${intent.sourceChain}`);
        return { intentId };
      },
      async dispatchIntent({ intentId: dispatchedIntentId }) {
        calls.push(`dispatch:${chainKey}:${dispatchedIntentId}`);
        return { intentId: dispatchedIntentId };
      },
      async finalizeSuccess({ intentId: finalizedIntentId }) {
        calls.push(`settle:${chainKey}:${finalizedIntentId}`);
        return { intentId: finalizedIntentId };
      },
      async refundFailedIntent({ intentId: refundedIntentId }) {
        calls.push(`refund:${chainKey}:${refundedIntentId}`);
        return { intentId: refundedIntentId };
      },
      async previewRefundableAmount(intentIdToPreview) {
        calls.push(`preview:${chainKey}:${intentIdToPreview}`);
        return 123n;
      },
    };
  }

  const adapter = createSourceAwareRouterAdapter({
    adaptersByChain: {
      moonbeam: makeAdapter("moonbeam", moonbeamIntentId),
      "polkadot-hub": makeAdapter("polkadot-hub", hubIntentId),
    },
  });

  const moonbeamIntent = createSwapIntent({
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress: signerAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: recipientAccount,
    },
  });
  const hubIntent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: signerAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: recipientAccount,
    },
  });

  await adapter.submitIntent({ intent: moonbeamIntent, quote: {}, request: {} });
  await adapter.submitIntent({ intent: hubIntent, quote: {}, request: {} });
  await adapter.dispatchIntent({ intentId: moonbeamIntentId, request: { mode: 0, destination: "0x", message: "0x1234" } });
  await adapter.finalizeSuccess({
    intentId: hubIntentId,
    outcomeReference: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    resultAssetId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    resultAmount: 1n,
  });
  assert.equal(await adapter.previewRefundableAmount(moonbeamIntentId), 123n);
  await adapter.refundFailedIntent({ intentId: moonbeamIntentId, refundAmount: 1n });

  assert.deepEqual(calls, [
    "submit:moonbeam:moonbeam",
    "submit:polkadot-hub:polkadot-hub",
    `dispatch:moonbeam:${moonbeamIntentId}`,
    `settle:polkadot-hub:${hubIntentId}`,
    `preview:moonbeam:${moonbeamIntentId}`,
    `refund:moonbeam:${moonbeamIntentId}`,
  ]);
});

test("source-aware router adapter requires a known adapter when intent mapping is missing", async () => {
  const adapter = createSourceAwareRouterAdapter({
    adaptersByChain: {
      moonbeam: {
        async submitIntent() {
          return {
            intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          };
        },
      },
    },
  });

  await assert.rejects(
    () =>
      adapter.dispatchIntent({
        intentId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        request: { mode: 0, destination: "0x", message: "0x1234" },
      }),
    /missing source-chain router mapping/,
  );
  await assert.rejects(
    () =>
      adapter.dispatchIntent({
        intentId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        chainKey: "polkadot-hub",
        request: { mode: 0, destination: "0x", message: "0x1234" },
      }),
    /missing router adapter for source chain polkadot-hub/,
  );
});

test("substrate XCM adapter submits hydration intents and dispatches through PolkadotXcm.execute", async () => {
  const statusIndexer = new InMemoryStatusIndexer();
  const runtimeCalls = [];
  const signAndSubmitCalls = [];
  const codecContext = {
    decodeVersionedXcm(messageHex) {
      assert.equal(messageHex, "0xfeedface");
      return { type: "V5", program: "hydration-xcm" };
    },
    decodeVersionedLocation() {
      throw new Error("decodeVersionedLocation should not be used for execute mode");
    },
  };
  const adapter = createSubstrateXcmAdapter({
    chainKey: "hydration",
    rpcUrl: "wss://hydration.example.org",
    privateKey: `0x${"11".repeat(32)}`,
    codecContext,
    statusIndexer,
    eventClock: () => 300,
    signerFactory() {
      return {
        address: recipientAccount,
        accountIdHex: `0x${"22".repeat(32)}`,
        signer: { role: "test-signer" },
      };
    },
    clientFactory() {
      return {
        getUnsafeApi() {
          return {
            apis: {
              XcmPaymentApi: {
                async query_xcm_weight(message) {
                  runtimeCalls.push(["query_xcm_weight", message]);
                  return {
                    success: true,
                    value: {
                      ref_time: 555n,
                      proof_size: 777n,
                    },
                  };
                },
              },
            },
            tx: {
              PolkadotXcm: {
                execute({ message, max_weight }) {
                  runtimeCalls.push(["execute", message, max_weight]);
                  return {
                    async signAndSubmit(signer) {
                      signAndSubmitCalls.push(signer);
                      return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                    },
                  };
                },
                send() {
                  throw new Error("send should not be used for execute mode");
                },
              },
            },
          };
        },
      };
    },
  });

  const intent = {
    quoteId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    refundAddress: signerAddress,
    deadline: 1_773_185_200,
    action: { type: "execute", params: {} },
  };
  const quote = {
    quoteId: intent.quoteId,
    fees: {
      platformFee: { asset: "DOT", amount: 180000n },
    },
    submission: {
      asset: "DOT",
      amount: 180000000n,
      xcmFee: 260000000n,
      destinationFee: 0n,
    },
  };
  const submitRequest = {
    amount: 180000000n,
    xcmFee: 260000000n,
    destinationFee: 0n,
  };

  const submitted = await adapter.submitIntent({
    owner: `0x${"22".repeat(32)}`,
    intent,
    quote,
    request: submitRequest,
  });
  const dispatched = await adapter.dispatchIntent({
    intentId: submitted.intentId,
    request: buildDispatchRequest(
      createDispatchEnvelope({
        mode: "execute",
        message: "0xfeedface",
      }),
    ),
  });
  const settled = await adapter.finalizeSuccess({
    intentId: submitted.intentId,
    outcomeReference: `0x${"aa".repeat(32)}`,
    resultAssetId: `0x${"bb".repeat(32)}`,
    resultAmount: 180000000n,
  });

  assert.equal(submitted.lockedAmount, 440180000n);
  assert.equal(dispatched.sourceChain, "hydration");
  assert.equal(
    dispatched.txHash,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(settled.strategy, "substrate-source-settlement");
  assert.deepEqual(runtimeCalls, [
    ["query_xcm_weight", { type: "V5", program: "hydration-xcm" }],
    [
      "execute",
      { type: "V5", program: "hydration-xcm" },
      { ref_time: 555n, proof_size: 777n },
    ],
  ]);
  assert.deepEqual(signAndSubmitCalls, [{ role: "test-signer" }]);
  assert.equal(statusIndexer.getStatus(submitted.intentId).status, "settled");
  assert.equal(
    statusIndexer.getStatus(submitted.intentId).result.destinationTxHash,
    `0x${"aa".repeat(32)}`,
  );
});

test("substrate XCM adapter finalizes failures and refunds hydration intents", async () => {
  const statusIndexer = new InMemoryStatusIndexer();
  const adapter = createSubstrateXcmAdapter({
    chainKey: "hydration",
    rpcUrl: "wss://hydration.example.org",
    privateKey: `0x${"11".repeat(32)}`,
    codecContext: {
      decodeVersionedXcm() {
        return { type: "V5", program: "hydration-xcm" };
      },
      decodeVersionedLocation() {
        throw new Error("decodeVersionedLocation should not be used for execute mode");
      },
    },
    statusIndexer,
    eventClock: () => 301,
    signerFactory() {
      return {
        address: recipientAccount,
        accountIdHex: `0x${"22".repeat(32)}`,
        signer: { role: "test-signer" },
      };
    },
    clientFactory() {
      return {
        getUnsafeApi() {
          return {
            apis: {
              XcmPaymentApi: {
                async query_xcm_weight() {
                  return {
                    success: true,
                    value: {
                      ref_time: 555n,
                      proof_size: 777n,
                    },
                  };
                },
              },
            },
            tx: {
              PolkadotXcm: {
                execute() {
                  return {
                    async signAndSubmit() {
                      return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
                    },
                  };
                },
                send() {
                  throw new Error("send should not be used for execute mode");
                },
              },
            },
          };
        },
      };
    },
  });

  const intent = {
    quoteId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    refundAddress: signerAddress,
    deadline: 1_773_185_200,
    action: { type: "transfer", params: {} },
  };
  const quote = {
    quoteId: intent.quoteId,
    fees: {
      platformFee: { asset: "DOT", amount: 180000n },
    },
    submission: {
      asset: "DOT",
      amount: 180000000n,
      xcmFee: 260000000n,
      destinationFee: 0n,
    },
  };
  const request = {
    amount: 180000000n,
    xcmFee: 260000000n,
    destinationFee: 0n,
    minOutputAmount: 0n,
  };

  const submitted = await adapter.submitIntent({
    owner: `0x${"22".repeat(32)}`,
    intent,
    quote,
    request,
  });
  await adapter.dispatchIntent({
    intentId: submitted.intentId,
    request: buildDispatchRequest(
      createDispatchEnvelope({
        mode: "execute",
        message: "0xfeedface",
      }),
    ),
  });
  assert.equal(await adapter.previewRefundableAmount(submitted.intentId), 0n);

  const failed = await adapter.finalizeFailure({
    intentId: submitted.intentId,
    outcomeReference: `0x${"cc".repeat(32)}`,
    failureReasonHash: `0x${"dd".repeat(32)}`,
  });
  const refundable = await adapter.previewRefundableAmount(submitted.intentId);
  await assert.rejects(
    () =>
      adapter.refundFailedIntent({
        intentId: submitted.intentId,
        refundAmount: refundable - 1n,
      }),
    /must equal refundable amount/i,
  );
  const refunded = await adapter.refundFailedIntent({
    intentId: submitted.intentId,
    refundAmount: refundable,
  });

  assert.equal(failed.strategy, "substrate-source-failure");
  assert.equal(refundable, 440000000n);
  assert.equal(refunded.strategy, "substrate-source-refund");
  assert.equal(refunded.refundAsset, "DOT");
  assert.equal(await adapter.previewRefundableAmount(submitted.intentId), 0n);
  assert.equal(statusIndexer.getStatus(submitted.intentId).status, "refunded");
  assert.equal(
    statusIndexer.getStatus(submitted.intentId).failureReason,
    `0x${"dd".repeat(32)}`,
  );
  assert.equal(statusIndexer.getStatus(submitted.intentId).refund.asset, "DOT");
  assert.equal(statusIndexer.getStatus(submitted.intentId).refund.amount, 440000000n);
});

test("substrate XCM adapter rejects owners that do not match the substrate signer", async () => {
  const adapter = createSubstrateXcmAdapter({
    chainKey: "hydration",
    rpcUrl: "wss://hydration.example.org",
    privateKey: `0x${"11".repeat(32)}`,
    signerFactory() {
      return {
        address: recipientAccount,
        accountIdHex: `0x${"22".repeat(32)}`,
        signer: { role: "test-signer" },
      };
    },
    clientFactory() {
      return {
        getUnsafeApi() {
          throw new Error("client should not be used");
        },
      };
    },
  });

  await assert.rejects(
    () =>
      adapter.submitIntent({
        owner: `0x${"33".repeat(32)}`,
        intent: {
          quoteId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sourceChain: "hydration",
          destinationChain: "moonbeam",
          refundAddress: signerAddress,
          deadline: 1_773_185_200,
          action: { type: "execute", params: {} },
        },
        quote: {
          quoteId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          fees: { platformFee: { asset: "DOT", amount: 1n } },
          submission: {
            asset: "DOT",
            amount: 1n,
            xcmFee: 1n,
            destinationFee: 1n,
          },
        },
        request: {
          amount: 1n,
          xcmFee: 1n,
          destinationFee: 1n,
        },
      }),
    /does not match signer/i,
  );
});
