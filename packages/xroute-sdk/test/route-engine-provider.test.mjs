import test from "node:test";
import assert from "node:assert/strict";

import { createTransferIntent, createSwapIntent, createExecuteIntent } from "../../xroute-intents/index.mjs";
import { DEPLOYMENT_PROFILES } from "../../xroute-precompile-interfaces/index.mjs";
import { createRouteEngineQuoteProvider } from "../internal.mjs";

const walletAddress = "0x1111111111111111111111111111111111111111";
const quoteProvider = createRouteEngineQuoteProvider({
  cwd: process.cwd(),
  deploymentProfile: "mainnet",
});

test("route engine quote provider exposes the mainnet bifrost spoke", async () => {
  const intent = createTransferIntent({
    deploymentProfile: "mainnet",
    sourceChain: "bifrost",
    destinationChain: "moonbeam",
    refundAddress: walletAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "5FbifrostMoonbeamRecipient",
    },
  });

  const quote = await quoteProvider.quote(intent);
  assert.equal(quote.deploymentProfile, DEPLOYMENT_PROFILES.MAINNET);
  assert.deepEqual(quote.route, ["bifrost", "polkadot-hub", "moonbeam"]);
});

test("route engine quote provider quotes moonbeam to hydration transfer and swap paths", async () => {
  const transferIntent = createTransferIntent({
    deploymentProfile: "mainnet",
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress: walletAddress,
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "5FmoonbeamHydrationRecipient",
    },
  });
  const swapIntent = createSwapIntent({
    deploymentProfile: "mainnet",
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress: walletAddress,
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      settlementChain: "polkadot-hub",
      recipient: "5FmoonbeamHydrationRecipient",
    },
  });

  const transferQuote = await quoteProvider.quote(transferIntent);
  const swapQuote = await quoteProvider.quote(swapIntent);

  assert.deepEqual(transferQuote.route, ["moonbeam", "polkadot-hub", "hydration"]);
  assert.deepEqual(swapQuote.route, ["moonbeam", "polkadot-hub", "hydration", "polkadot-hub"]);
  assert.equal(swapQuote.expectedOutput.asset, "USDT");
});

test("route engine quote provider builds a moonbeam execute quote", async () => {
  const intent = createExecuteIntent({
    deploymentProfile: "mainnet",
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    refundAddress: walletAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "call",
      asset: "DOT",
      maxPaymentAmount: "200000000",
      contractAddress: walletAddress,
      calldata: "0xdeadbeef",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  });

  const quote = await quoteProvider.quote(intent);
  assert.equal(quote.deploymentProfile, DEPLOYMENT_PROFILES.MAINNET);
  assert.deepEqual(quote.route, ["hydration", "polkadot-hub", "moonbeam"]);
  assert.equal(quote.submission.action, "execute");
});

test("route engine quote provider rejects mint-vdot until live support is re-enabled", async () => {
  assert.throws(
    () =>
      createExecuteIntent({
        deploymentProfile: "mainnet",
        sourceChain: "hydration",
        destinationChain: "moonbeam",
        refundAddress: walletAddress,
        deadline: 1_773_185_200,
        params: {
          executionType: "mint-vdot",
          amount: "10000000000",
          maxPaymentAmount: "200000000",
          recipient: walletAddress,
          adapterAddress: "0x2222222222222222222222222222222222222222",
        },
      }),
    /execution type mint-vdot is not supported on destination moonbeam/,
  );
});
