import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createExecuteIntent, createSwapIntent } from "../../xroute-intents/index.mjs";
import { createDispatchEnvelope } from "../../xroute-xcm/index.mjs";
import { createConfiguredXRouteClient } from "../internal.mjs";
import {
  InMemoryStatusIndexer,
  createDestinationExecutionFailedEvent,
  createDestinationExecutionStartedEvent,
  createDestinationExecutionSucceededEvent,
  createIntentDispatchedEvent,
  createIntentSubmittedEvent,
  createRefundIssuedEvent,
} from "../indexers/status-indexer.mjs";

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

  const client = createConfiguredXRouteClient({
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

test("sdk runFlow sequences swap then execute as separate settled intents", async () => {
  const indexer = new InMemoryStatusIndexer();
  let nextAt = 1;
  let nextSequence = 0;
  let nextNonce = 0;
  const records = new Map();

  const quoteProvider = {
    async quote(intent) {
      if (intent.action.type === "swap") {
        return {
          quoteId: intent.quoteId,
          deploymentProfile: "mainnet",
          route: ["moonbeam", "polkadot-hub", "hydration"],
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
            route: ["moonbeam", "polkadot-hub", "hydration"],
            steps: [],
          },
        };
      }

      return {
        quoteId: intent.quoteId,
        deploymentProfile: "mainnet",
        route: ["hydration", "polkadot-hub", "moonbeam"],
        fees: {
          xcmFee: { asset: "DOT", amount: 150000000n },
          destinationFee: { asset: "DOT", amount: 200000000n },
          platformFee: { asset: "DOT", amount: 0n },
          totalFee: { asset: "DOT", amount: 350000000n },
        },
        expectedOutput: { asset: "DOT", amount: 0n },
        minOutput: null,
        submission: {
          action: "execute",
          asset: "DOT",
          amount: 200000000n,
          xcmFee: 150000000n,
          destinationFee: 200000000n,
          minOutputAmount: 0n,
        },
        executionPlan: {
          route: ["hydration", "polkadot-hub", "moonbeam"],
          steps: [],
        },
      };
    },
  };

  const routerAdapter = {
    async submitIntent({ owner, intent, quote, request }) {
      const intentId = `0x${createHash("sha256")
        .update(`${owner}|${quote.quoteId}|${nextNonce++}|${request.executionHash}`)
        .digest("hex")}`;
      records.set(intentId, { owner, intent, quote, request });
      indexer.ingest(
        createIntentSubmittedEvent({
          at: nextAt++,
          sequence: nextSequence++,
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
    },

    async dispatchIntent({ intentId, request }) {
      const stored = records.get(intentId);
      assert.ok(stored, "intent must exist before dispatch");

      indexer.ingest(
        createIntentDispatchedEvent({
          at: nextAt++,
          sequence: nextSequence++,
          intentId,
          dispatchMode: request.mode === 0 ? "execute" : "send",
          executionHash: stored.request.executionHash,
        }),
      );
      indexer.ingest(
        createDestinationExecutionStartedEvent({
          at: nextAt++,
          sequence: nextSequence++,
          intentId,
        }),
      );

      queueMicrotask(() => {
        indexer.ingest(
          createDestinationExecutionSucceededEvent({
            at: nextAt++,
            sequence: nextSequence++,
            intentId,
            resultAsset: stored.quote.expectedOutput.asset,
            resultAmount: stored.quote.expectedOutput.amount,
            destinationTxHash: `0x${"ab".repeat(32)}`,
          }),
        );
      });

      return { intentId };
    },
  };

  const client = createConfiguredXRouteClient({
    quoteProvider,
    routerAdapter,
    statusProvider: indexer,
    assetAddressResolver: async () => "0x0000000000000000000000000000000000000000",
  });

  const owner = "0x1111111111111111111111111111111111111111";
  const flow = await client.runFlow({
    owner,
    timeoutMs: 5_000,
    pollIntervalMs: 10,
    steps: [
      {
        name: "swap",
        intent: createSwapIntent({
          sourceChain: "moonbeam",
          destinationChain: "hydration",
          refundAddress: owner,
          deadline: 1_773_185_200,
          params: {
            assetIn: "DOT",
            assetOut: "USDT",
            amountIn: "1000000000000",
            minAmountOut: "490000000",
            settlementChain: "hydration",
            recipient: "5Frecipient",
          },
        }),
        envelope: createDispatchEnvelope({
          mode: "execute",
          message: "0x1234",
        }),
      },
      {
        name: "record",
        intent: ({ previousStep }) => {
          const amountHex = previousStep.finalStatus.result.amount
            .toString(16)
            .padStart(64, "0");
          return createExecuteIntent({
            sourceChain: "hydration",
            destinationChain: "moonbeam",
            refundAddress: owner,
            deadline: 1_773_185_200,
            params: {
              executionType: "call",
              asset: "DOT",
              maxPaymentAmount: "200000000",
              contractAddress: owner,
              calldata: `0xdeadbeef${amountHex}`,
              value: "0",
              gasLimit: "250000",
              fallbackWeight: {
                refTime: 650000000,
                proofSize: 12288,
              },
            },
          });
        },
        envelope: createDispatchEnvelope({
          mode: "execute",
          message: "0x5678",
        }),
      },
    ],
  });

  assert.equal(flow.steps.length, 2);
  assert.equal(flow.steps[0].name, "swap");
  assert.equal(flow.steps[0].finalStatus.status, "settled");
  assert.equal(flow.steps[0].finalStatus.result.amount, 493515000n);
  assert.equal(flow.steps[1].name, "record");
  assert.equal(flow.steps[1].intent.action.type, "execute");
  assert.match(flow.steps[1].intent.action.params.calldata, /^0xdeadbeef[0-9a-f]{64}$/);
  assert.equal(flow.steps[1].finalStatus.status, "settled");
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

  const client = createConfiguredXRouteClient({
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
