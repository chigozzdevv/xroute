import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createExecuteIntent,
  createSwapIntent,
  createTransferIntent,
} from "../packages/xroute-intents/index.mjs";
import {
  createRouteEngineQuoteProvider,
  normalizeQuote,
} from "../packages/xroute-sdk/index.mjs";
import { buildExecutionEnvelope } from "../packages/xroute-xcm/index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quoteProvider = createRouteEngineQuoteProvider({
  cwd: workspaceRoot,
  deploymentProfile: "core-multihop",
});
const refundAddress = "0x1111111111111111111111111111111111111111";
const recipientAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const scenarios = [
  {
    name: "transfer moonbeam -> polkadot-hub -> hydration",
    expectedRoute: ["moonbeam", "polkadot-hub", "hydration"],
    createIntent() {
      return createTransferIntent({
        deploymentProfile: "core-multihop",
        sourceChain: "moonbeam",
        destinationChain: "hydration",
        refundAddress,
        deadline: 1_773_185_200,
        params: {
          asset: "DOT",
          amount: "250000000000",
          recipient: recipientAddress,
        },
      });
    },
  },
  {
    name: "swap moonbeam -> polkadot-hub -> hydration -> polkadot-hub",
    expectedRoute: ["moonbeam", "polkadot-hub", "hydration", "polkadot-hub"],
    createIntent() {
      return createSwapIntent({
        deploymentProfile: "core-multihop",
        sourceChain: "moonbeam",
        destinationChain: "hydration",
        refundAddress,
        deadline: 1_773_185_200,
        params: {
          assetIn: "DOT",
          assetOut: "USDT",
          amountIn: "1000000000000",
          minAmountOut: "490000000",
          settlementChain: "polkadot-hub",
          recipient: recipientAddress,
        },
      });
    },
  },
  {
    name: "execute hydration -> polkadot-hub -> moonbeam",
    expectedRoute: ["hydration", "polkadot-hub", "moonbeam"],
    createIntent() {
      return createExecuteIntent({
        deploymentProfile: "core-multihop",
        sourceChain: "hydration",
        destinationChain: "moonbeam",
        refundAddress,
        deadline: 1_773_185_200,
        params: {
          executionType: "evm-contract-call",
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
    },
  },
];

const results = [];

for (const scenario of scenarios) {
  const intent = scenario.createIntent();
  const quote = normalizeQuote(await quoteProvider.quote(intent));
  const envelope = buildExecutionEnvelope({ intent, quote });

  assert.equal(quote.deploymentProfile, "core-multihop");
  assert.deepEqual(quote.route, scenario.expectedRoute);
  assert.equal(envelope.mode, "execute");
  assert.match(envelope.messageHex, /^0x[0-9a-f]+$/);

  results.push({
    name: scenario.name,
    route: quote.route,
    action: quote.submission.action,
    amount: quote.submission.amount.toString(),
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      deploymentProfile: "core-multihop",
      scenarios: results,
    },
    null,
    2,
  ),
);
