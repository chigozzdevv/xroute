import test from "node:test";
import assert from "node:assert/strict";

import { createSwapIntent } from "../../xroute-intents/index.mjs";
import { buildDispatchRequest, createDispatchEnvelope } from "../../xroute-xcm/index.mjs";
import {
  createCastRouterAdapter,
  createStaticAssetAddressResolver,
  InMemoryStatusIndexer,
} from "../index.mjs";

const signerAddress = "0x1111111111111111111111111111111111111111";
const routerAddress = "0x2222222222222222222222222222222222222222";
const dotAddress = "0x3333333333333333333333333333333333333333";
const privateKey = "0x0123456789012345678901234567890123456789012345678901234567890123";

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

      if (command === "call" && rest[1] === "previewLockedAmount((uint8,address,uint128,uint128,uint128,uint128,uint64,bytes32))(uint128)") {
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
      if (command === "send" && rest[0] === routerAddress && rest[1] === "submitIntent((uint8,address,uint128,uint128,uint128,uint128,uint64,bytes32))") {
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
      recipient: signerAddress,
    },
  });
  const quote = {
    quoteId: intent.quoteId,
    deploymentProfile: "local",
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
