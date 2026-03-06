import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTransferIntent } from "../../xroute-intents/index.mjs";
import { createRouteEngineQuoteProvider, normalizeQuote } from "../index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("route engine quote provider bridges the rust planner", async () => {
  const provider = createRouteEngineQuoteProvider({
    cwd: workspaceRoot,
  });
  const intent = createTransferIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "asset-hub",
    refundAddress: "5Frefund",
    deadline: 1_773_185_200,
    params: {
      asset: "DOT",
      amount: "250000000000",
      recipient: "5Frecipient",
    },
  });

  const quote = normalizeQuote(await provider.quote(intent));

  assert.equal(quote.quoteId, intent.quoteId);
  assert.deepEqual(quote.route, ["polkadot-hub", "asset-hub"]);
  assert.equal(quote.submission.action, "transfer");
  assert.equal(quote.submission.amount, 250000000000n);
  assert.equal(quote.fees.totalFee.amount, 370000000n);
});
