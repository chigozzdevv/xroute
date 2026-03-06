import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryStatusIndexer,
  createDestinationExecutionSucceededEvent,
  createDestinationExecutionFailedEvent,
  createDestinationExecutionStartedEvent,
  createIntentCancelledEvent,
  createIntentDispatchedEvent,
  createIntentSubmittedEvent,
  createRefundIssuedEvent,
} from "../index.mjs";

test("status indexer tracks a failed execution and refund timeline", () => {
  const indexer = new InMemoryStatusIndexer();
  const snapshots = [];
  const unsubscribe = indexer.subscribe((snapshot) => snapshots.push(snapshot));

  indexer.ingest(
    createIntentSubmittedEvent({
      at: 1,
      intentId: "intent-1",
      quoteId: "quote-1",
      owner: "5Fowner",
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      actionType: "swap",
      asset: "DOT",
      amount: 1000000000000n,
    }),
  );
  indexer.ingest(
    createIntentDispatchedEvent({
      at: 2,
      intentId: "intent-1",
      dispatchMode: "execute",
      executionHash: "0xabc",
    }),
  );
  indexer.ingest(
    createDestinationExecutionStartedEvent({
      at: 3,
      intentId: "intent-1",
    }),
  );
  indexer.ingest(
    createDestinationExecutionFailedEvent({
      at: 4,
      intentId: "intent-1",
      reason: "slippage exceeded",
    }),
  );
  indexer.ingest(
    createRefundIssuedEvent({
      at: 5,
      intentId: "intent-1",
      refundAsset: "DOT",
      refundAmount: 1000125000000n,
    }),
  );
  unsubscribe();

  const status = indexer.getStatus("intent-1");

  assert.equal(status.status, "failed");
  assert.equal(status.failureReason, "slippage exceeded");
  assert.equal(status.refund.asset, "DOT");
  assert.equal(status.refund.amount, 1000125000000n);
  assert.equal(status.timeline.length, 5);
  assert.equal(snapshots.length, 5);
});

test("status indexer records cancellations", () => {
  const indexer = new InMemoryStatusIndexer();

  indexer.ingest(
    createIntentSubmittedEvent({
      at: 10,
      intentId: "intent-2",
      quoteId: "quote-2",
      owner: "5Fowner",
      sourceChain: "polkadot-hub",
      destinationChain: "asset-hub",
      actionType: "transfer",
      asset: "DOT",
      amount: 250000000000n,
    }),
  );
  indexer.ingest(
    createIntentCancelledEvent({
      at: 11,
      intentId: "intent-2",
    }),
  );

  const status = indexer.getStatus("intent-2");

  assert.equal(status.status, "cancelled");
  assert.equal(status.timeline.length, 2);
});

test("status indexer reorders events and ignores duplicates", () => {
  const indexer = new InMemoryStatusIndexer();
  const snapshots = [];
  indexer.subscribe((snapshot) => snapshots.push(snapshot));

  const submitted = createIntentSubmittedEvent({
    at: 10,
    sequence: 0,
    intentId: "intent-3",
    quoteId: "quote-3",
    owner: "5Fowner",
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    actionType: "swap",
    asset: "DOT",
    amount: 1000000000000n,
  });
  const dispatched = createIntentDispatchedEvent({
    at: 11,
    sequence: 0,
    intentId: "intent-3",
    dispatchMode: "execute",
    executionHash: "0xabc",
  });
  const started = createDestinationExecutionStartedEvent({
    at: 12,
    sequence: 0,
    intentId: "intent-3",
  });
  const settled = createDestinationExecutionSucceededEvent({
    at: 13,
    sequence: 0,
    intentId: "intent-3",
    resultAsset: "USDT",
    resultAmount: 493515000n,
    destinationTxHash: "0xfeed",
  });

  indexer.ingest(settled);
  indexer.ingest(started);
  indexer.ingest(submitted);
  indexer.ingest(dispatched);
  indexer.ingest(dispatched);

  const status = indexer.getStatus("intent-3");

  assert.equal(status.status, "settled");
  assert.equal(status.timeline.length, 4);
  assert.deepEqual(
    status.timeline.map((entry) => entry.type),
    [
      "intent-submitted",
      "intent-dispatched",
      "destination-execution-started",
      "destination-execution-succeeded",
    ],
  );
  assert.equal(snapshots.length, 4);
});
