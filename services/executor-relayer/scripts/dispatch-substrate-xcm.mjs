import { readFileSync } from "node:fs";

import { createSubstrateXcmAdapter } from "../../../packages/xroute-sdk/routers/router-adapters.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
const request = input?.request;
const sourceChain = input?.sourceChain;
const refundAsset = input?.refundAsset ?? "DOT";
const intentId = input?.intentId;

const adapter = createSubstrateXcmAdapter({
  chainKey: sourceChain,
  rpcUrl: input?.rpcUrl,
  privateKey: input?.privateKey,
});

const submitted = await adapter.submitIntent({
  intent: {
    sourceChain,
    destinationChain: sourceChain,
  },
  quote: {
    quoteId: intentId,
    fees: {
      platformFee: {
        amount: "0",
      },
    },
    submission: {
      asset: refundAsset,
    },
  },
  request: {},
});

const dispatched = await adapter.dispatchIntent({
  intentId: submitted.intentId,
  request,
});

process.stdout.write(
  JSON.stringify({
    txHash: dispatched.txHash,
    strategy: dispatched.strategy,
  }),
);
