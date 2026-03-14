import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FileBackedStatusIndexer,
  createDestinationExecutionSucceededEvent,
  createIntentSubmittedEvent,
} from "../indexers/status-indexer.mjs";

test("file-backed status indexer reloads persisted events", () => {
  const directory = mkdtempSync(join(tmpdir(), "xroute-status-"));
  const eventsPath = join(directory, "events.jsonl");

  try {
    const writer = new FileBackedStatusIndexer({ eventsPath });
    writer.ingest(
      createIntentSubmittedEvent({
        at: 1,
        intentId: "0xintent",
        quoteId: "0xquote",
        owner: "0x1111111111111111111111111111111111111111",
        sourceChain: "polkadot-hub",
        destinationChain: "hydration",
        actionType: "swap",
        asset: "DOT",
        amount: 1000000000000n,
      }),
    );
    writer.ingest(
      createDestinationExecutionSucceededEvent({
        at: 2,
        intentId: "0xintent",
        resultAsset: "USDT",
        resultAmount: 490000000n,
        destinationTxHash: "0xfeed",
      }),
    );

    const reader = new FileBackedStatusIndexer({ eventsPath });
    const status = reader.getStatus("0xintent");

    assert.equal(status.status, "settled");
    assert.equal(status.result.asset, "USDT");
    assert.equal(status.result.amount, 490000000n);
    assert.equal(reader.getTimeline("0xintent").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
