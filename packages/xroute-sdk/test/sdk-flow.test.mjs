import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createSwapIntent } from "../../xroute-intents/index.mjs";
import { createDispatchEnvelope } from "../../xroute-xcm/index.mjs";
import { createXRouteClient } from "../index.mjs";
import {
  InMemoryStatusIndexer,
  createDestinationExecutionFailedEvent,
  createDestinationExecutionStartedEvent,
  createDestinationExecutionSucceededEvent,
  createIntentDispatchedEvent,
  createIntentSubmittedEvent,
  createRefundIssuedEvent,
} from "../status-indexer.mjs";

test("sdk coordinates quote, submit, dispatch, and status tracking", async () => {
  const indexer = new InMemoryStatusIndexer();
  const quoteProvider = {
    async quote(intent) {
      return {
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
        executionPlan: {
          route: ["polkadot-hub", "hydration"],
          steps: [],
        },
      };
    },
  };

  class MemoryRouterAdapter {
    constructor(statusIndexer) {
      this.statusIndexer = statusIndexer;
      this.records = new Map();
      this.nextNonce = 0;
    }

    async submitIntent({ owner, intent, quote, request }) {
      const intentId = `0x${createHash("sha256")
        .update(`${owner}|${quote.quoteId}|${this.nextNonce++}|${request.executionHash}`)
        .digest("hex")}`;

      this.records.set(intentId, { owner, intent, quote, request });
      this.statusIndexer.ingest(
        createIntentSubmittedEvent({
          at: 1,
          intentId,
          quoteId: quote.quoteId,
          owner,
          sourceChain: intent.sourceChain,
          destinationChain: intent.destinationChain,
          actionType: intent.action.type,
          asset: quote.submission.asset,
          amount: quote.submission.amount,
        }),
      );

      return { intentId, request };
    }

    async dispatchIntent({ intentId, request }) {
      const stored = this.records.get(intentId);
      assert.ok(stored, "intent must exist before dispatch");

      this.statusIndexer.ingest(
        createIntentDispatchedEvent({
          at: 2,
          intentId,
          dispatchMode: request.mode === 0 ? "execute" : "send",
          executionHash: stored.request.executionHash,
        }),
      );
      this.statusIndexer.ingest(
        createDestinationExecutionStartedEvent({
          at: 3,
          intentId,
        }),
      );

      return { intentId };
    }

    async finalizeSuccess({ intentId, outcomeReference, resultAssetId, resultAmount }) {
      assert.ok(this.records.has(intentId), "intent must exist before settlement");

      this.statusIndexer.ingest(
        createDestinationExecutionSucceededEvent({
          at: 4,
          intentId,
          resultAsset: resultAssetId,
          resultAmount,
          destinationTxHash: outcomeReference,
        }),
      );

      return { intentId, outcomeReference, resultAssetId, resultAmount };
    }

    async finalizeFailure({ intentId, outcomeReference, failureReasonHash }) {
      assert.ok(this.records.has(intentId), "intent must exist before failure");

      this.statusIndexer.ingest(
        createDestinationExecutionFailedEvent({
          at: 4,
          intentId,
          reason: failureReasonHash,
        }),
      );

      return { intentId, outcomeReference, failureReasonHash };
    }

    async refundFailedIntent({ intentId, refundAmount, refundAsset }) {
      assert.ok(this.records.has(intentId), "intent must exist before refund");

      this.statusIndexer.ingest(
        createRefundIssuedEvent({
          at: 5,
          intentId,
          refundAsset,
          refundAmount,
        }),
      );

      return { intentId, refundAmount };
    }
  }

  const client = createXRouteClient({
    quoteProvider,
    routerAdapter: new MemoryRouterAdapter(indexer),
    statusProvider: indexer,
    assetAddressResolver: async ({ chainKey, assetKey }) => {
      assert.equal(chainKey, "polkadot-hub");
      assert.equal(assetKey, "DOT");
      return "0x0000000000000000000000000000000000000000";
    },
  });

  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: "5Frecipient",
    },
  });
  const { quote } = await client.quote(intent);
  const envelope = createDispatchEnvelope({
    mode: "execute",
    message: "0x1234",
  });

  const execution = await client.execute({
    intent,
    quote,
    envelope,
    owner: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(execution.submitted.request.actionType, 1);
  assert.equal(execution.submitted.request.amount, 1000000000000n);
  assert.equal(execution.status.status, "executing");

  await client.settle({
    intentId: execution.submitted.intentId,
    outcomeReference:
      "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
    resultAssetId:
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    resultAmount: 493515000n,
  });

  const status = client.getStatus(execution.submitted.intentId);
  const timeline = client.getTimeline(execution.submitted.intentId);

  assert.equal(status.status, "settled");
  assert.equal(
    status.result.asset,
    "0x5555555555555555555555555555555555555555555555555555555555555555",
  );
  assert.equal(status.result.amount, 493515000n);
  assert.equal(timeline.length, 4);
});

test("sdk coordinates fail and refund helpers", async () => {
  const indexer = new InMemoryStatusIndexer();
  const quoteProvider = {
    async quote(intent) {
      return {
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
        executionPlan: {
          route: ["polkadot-hub", "hydration"],
          steps: [],
        },
      };
    },
  };

  class MemoryRouterAdapter {
    constructor(statusIndexer) {
      this.statusIndexer = statusIndexer;
      this.records = new Map();
      this.nextNonce = 0;
    }

    async submitIntent({ owner, intent, quote, request }) {
      const intentId = `0x${createHash("sha256")
        .update(`${owner}|${quote.quoteId}|${this.nextNonce++}|${request.executionHash}`)
        .digest("hex")}`;
      this.records.set(intentId, { owner, intent, quote, request });

      this.statusIndexer.ingest(
        createIntentSubmittedEvent({
          at: 1,
          intentId,
          quoteId: quote.quoteId,
          owner,
          sourceChain: intent.sourceChain,
          destinationChain: intent.destinationChain,
          actionType: intent.action.type,
          asset: quote.submission.asset,
          amount: quote.submission.amount,
        }),
      );

      return { intentId, request };
    }

    async dispatchIntent({ intentId, request }) {
      const stored = this.records.get(intentId);
      assert.ok(stored, "intent must exist before dispatch");

      this.statusIndexer.ingest(
        createIntentDispatchedEvent({
          at: 2,
          intentId,
          dispatchMode: request.mode === 0 ? "execute" : "send",
          executionHash: stored.request.executionHash,
        }),
      );
      this.statusIndexer.ingest(
        createDestinationExecutionStartedEvent({
          at: 3,
          intentId,
        }),
      );

      return { intentId };
    }

    async finalizeFailure({ intentId, failureReasonHash }) {
      this.statusIndexer.ingest(
        createDestinationExecutionFailedEvent({
          at: 4,
          intentId,
          reason: failureReasonHash,
        }),
      );

      return { intentId, failureReasonHash };
    }

    async refundFailedIntent({ intentId, refundAmount, refundAsset }) {
      this.statusIndexer.ingest(
        createRefundIssuedEvent({
          at: 5,
          intentId,
          refundAsset,
          refundAmount,
        }),
      );

      return { intentId, refundAmount };
    }
  }

  const client = createXRouteClient({
    quoteProvider,
    routerAdapter: new MemoryRouterAdapter(indexer),
    statusProvider: indexer,
    assetAddressResolver: async () => "0x0000000000000000000000000000000000000000",
  });

  const intent = createSwapIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: "5Frecipient",
    },
  });
  const execution = await client.execute({
    intent,
    owner: "0x1111111111111111111111111111111111111111",
    envelope: createDispatchEnvelope({
      mode: "execute",
      message: "0x1234",
    }),
  });

  await client.fail({
    intentId: execution.submitted.intentId,
    outcomeReference:
      "0x6666666666666666666666666666666666666666666666666666666666666666",
    failureReasonHash:
      "0x7777777777777777777777777777777777777777777777777777777777777777",
  });
  await client.refund({
    intentId: execution.submitted.intentId,
    refundAmount: 1000250000000n,
    refundAsset: "DOT",
  });

  const status = client.getStatus(execution.submitted.intentId);

  assert.equal(status.status, "refunded");
  assert.equal(
    status.failureReason,
    "0x7777777777777777777777777777777777777777777777777777777777777777",
  );
  assert.equal(status.refund.asset, "DOT");
  assert.equal(status.refund.amount, 1000250000000n);
});
