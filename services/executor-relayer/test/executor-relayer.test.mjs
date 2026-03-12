import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

import { createTransferIntent, createExecuteIntent } from "../../../packages/xroute-intents/index.mjs";
import {
  createHttpExecutorRelayerClient,
  createRouteEngineQuoteProvider,
  normalizeQuote,
} from "../../../packages/xroute-sdk/index.mjs";
import { spawnRustService } from "../../../scripts/lib/spawn-rust-service.mjs";

const workspaceRoot = process.cwd();
const refundAddress = "0x1111111111111111111111111111111111111111";
const ss58Recipient = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const hubRouterAddress = "0x2222222222222222222222222222222222222222";
const moonbeamRouterAddress = "0x3333333333333333333333333333333333333333";

test("executor relayer authenticates and dispatches a queued job", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-"));
  const anvil = await spawnAnvil();
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: anvil.rpcUrl,
      XROUTE_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_RELAYER_POLL_INTERVAL_MS: "25",
      XROUTE_RELAYER_RETRY_DELAY_MS: "25",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const unauthorized = await fetch(`${service.url}/jobs`, {
      method: "GET",
    });
    assert.equal(unauthorized.status, 401);

    const quoteProvider = createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "mainnet",
    });
    const intent = createTransferIntent({
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      refundAddress,
      deadline: 1_773_185_200,
      params: {
        asset: "DOT",
        amount: "1000000000000",
        recipient: ss58Recipient,
      },
    });
    const quote = normalizeQuote(await quoteProvider.quote(intent));
    const relayer = createHttpExecutorRelayerClient({
      endpoint: service.url,
      authToken: "secret-token",
    });

    const queued = await relayer.dispatch({
      intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intent,
      quote,
    });
    assert.equal(queued.job.status, "queued");

    const completed = await waitForJob({
      relayer,
      jobId: queued.job.id,
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.intentId, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.match(completed.result.txHash, /^0x[0-9a-f]{64}$/);

    const jobs = await relayer.listJobs();
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].status, "completed");
  } finally {
    await service.close();
    await anvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer enforces moonbeam evm execution policy before dispatch", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-policy-"));
  const policyPath = join(tempDir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      moonbeam: {
        evmContractCall: {
          allowedContracts: [
            {
              address: "0x2222222222222222222222222222222222222222",
              selectors: ["0xdeadbeef"],
              maxValue: "0",
              maxGasLimit: 200000,
              maxPaymentAmount: "100000000",
            },
          ],
        },
      },
    }),
  );

  const anvil = await spawnAnvil();
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: anvil.rpcUrl,
      XROUTE_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_EVM_POLICY_PATH: policyPath,
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const intent = createExecuteIntent({
      sourceChain: "polkadot-hub",
      destinationChain: "moonbeam",
      refundAddress,
      deadline: 1_773_185_200,
      params: {
        executionType: "evm-contract-call",
        asset: "DOT",
        maxPaymentAmount: "110000000",
        contractAddress: "0x3333333333333333333333333333333333333333",
        calldata: "0xdeadbeef00000000",
        value: "0",
        gasLimit: "250000",
        fallbackWeight: {
          refTime: 650000000,
          proofSize: 12288,
        },
      },
    });
    const quote = await createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "mainnet",
    }).quote(intent);
    const relayer = createHttpExecutorRelayerClient({
      endpoint: service.url,
      authToken: "secret-token",
    });

    await assert.rejects(
      () =>
        relayer.dispatch({
          intentId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          intent,
          quote,
        }),
      /not allowlisted|maxGasLimit|maxPaymentAmount/,
    );
  } finally {
    await service.close();
    await anvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer rejects oversized request bodies", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-oversized-"));
  const anvil = await spawnAnvil();
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: anvil.rpcUrl,
      XROUTE_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_RELAYER_MAX_BODY_BYTES: "64",
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const response = await fetch(`${service.url}/jobs/refund`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        intentId:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        refundAmount:
          "1000000000000000000000000000000000000000000000000000000000000000",
      }),
    });

    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.error, /exceeds/);
  } finally {
    await service.close();
    await anvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer routes moonbeam-origin dispatch and failure jobs through the moonbeam execution context", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-moonbeam-"));
  const hubAnvil = await spawnAnvil();
  const moonbeamAnvil = await spawnAnvil();
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: hubAnvil.rpcUrl,
      XROUTE_PRIVATE_KEY: hubAnvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_MOONBEAM_RPC_URL: moonbeamAnvil.rpcUrl,
      XROUTE_MOONBEAM_PRIVATE_KEY: moonbeamAnvil.privateKey,
      XROUTE_MOONBEAM_ROUTER_ADDRESS: moonbeamRouterAddress,
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_RELAYER_POLL_INTERVAL_MS: "25",
      XROUTE_RELAYER_RETRY_DELAY_MS: "25",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const relayer = createHttpExecutorRelayerClient({
      endpoint: service.url,
      authToken: "secret-token",
    });
    const health = await relayer.health();
    assert.equal(health.primarySourceChain, "polkadot-hub");
    assert.equal(health.executionContexts.moonbeam.routerAddress, moonbeamRouterAddress);

    const quoteProvider = createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "mainnet",
    });
    const intent = createTransferIntent({
      sourceChain: "moonbeam",
      destinationChain: "hydration",
      refundAddress,
      deadline: 1_773_185_200,
      params: {
        asset: "DOT",
        amount: "1000000000000",
        recipient: ss58Recipient,
      },
    });
    const quote = normalizeQuote(await quoteProvider.quote(intent));

    const queuedDispatch = await relayer.dispatch({
      intentId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      intent,
      quote,
    });
    const dispatched = await waitForJob({
      relayer,
      jobId: queuedDispatch.job.id,
    });
    assert.equal(dispatched.status, "completed");
    assert.equal(dispatched.result.sourceChain, "moonbeam");
    assert.equal(dispatched.result.targetAddress, moonbeamRouterAddress);

    const moonbeamDispatchTx = await getTransactionByHash(moonbeamAnvil.rpcUrl, dispatched.result.txHash);
    const hubDispatchTx = await getTransactionByHash(hubAnvil.rpcUrl, dispatched.result.txHash);
    assert.equal(moonbeamDispatchTx?.to?.toLowerCase(), moonbeamRouterAddress);
    assert.equal(hubDispatchTx, null);

    const queuedFailure = await relayer.fail({
      intentId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      outcomeReference: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      failureReasonHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    const failedIntent = await waitForJob({
      relayer,
      jobId: queuedFailure.job.id,
    });
    assert.equal(failedIntent.status, "completed");
    assert.equal(failedIntent.result.sourceChain, "moonbeam");
    assert.equal(failedIntent.result.routerAddress, moonbeamRouterAddress);

    const moonbeamFailureTx = await getTransactionByHash(moonbeamAnvil.rpcUrl, failedIntent.result.txHash);
    const hubFailureTx = await getTransactionByHash(hubAnvil.rpcUrl, failedIntent.result.txHash);
    assert.equal(moonbeamFailureTx?.to?.toLowerCase(), moonbeamRouterAddress);
    assert.equal(hubFailureTx, null);
  } finally {
    await service.close();
    await moonbeamAnvil.close();
    await hubAnvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer fails moonbeam-origin jobs when no moonbeam execution context is configured", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-missing-context-"));
  const anvil = await spawnAnvil();
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: anvil.rpcUrl,
      XROUTE_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_RELAYER_MAX_ATTEMPTS: "1",
      XROUTE_RELAYER_POLL_INTERVAL_MS: "25",
      XROUTE_RELAYER_RETRY_DELAY_MS: "25",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const quoteProvider = createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "mainnet",
    });
    const intent = createTransferIntent({
      sourceChain: "moonbeam",
      destinationChain: "hydration",
      refundAddress,
      deadline: 1_773_185_200,
      params: {
        asset: "DOT",
        amount: "1000000000000",
        recipient: ss58Recipient,
      },
    });
    const quote = normalizeQuote(await quoteProvider.quote(intent));
    const relayer = createHttpExecutorRelayerClient({
      endpoint: service.url,
      authToken: "secret-token",
    });

    const queued = await relayer.dispatch({
      intentId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      intent,
      quote,
    });
    const failed = await waitForJob({
      relayer,
      jobId: queued.job.id,
      statuses: ["failed"],
    });
    assert.equal(failed.status, "failed");
    assert.match(failed.lastError, /missing execution context for source chain moonbeam/i);
  } finally {
    await service.close();
    await anvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer dispatches hydration source intents and completes substrate-source settlement lifecycles", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-hydration-source-"));
  const anvil = await spawnAnvil();
  const substrateDispatchScript = join(tempDir, "mock-substrate-dispatch.mjs");
  writeFileSync(
    substrateDispatchScript,
    [
      'import { readFileSync } from "node:fs";',
      'const payload = JSON.parse(readFileSync(0, "utf8"));',
      'process.stdout.write(JSON.stringify({',
      '  txHash: payload.intentId,',
      '  strategy: Number(payload.request?.mode ?? 0) === 0 ? "substrate-xcm-execute" : "substrate-xcm-send",',
      '}));',
      "",
    ].join("\n"),
  );
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: anvil.rpcUrl,
      XROUTE_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_HYDRATION_RPC_URL: "ws://127.0.0.1:9944",
      XROUTE_HYDRATION_PRIVATE_KEY:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      XROUTE_SUBSTRATE_DISPATCH_SCRIPT: substrateDispatchScript,
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_RELAYER_POLL_INTERVAL_MS: "25",
      XROUTE_RELAYER_RETRY_DELAY_MS: "25",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const relayer = createHttpExecutorRelayerClient({
      endpoint: service.url,
      authToken: "secret-token",
    });
    const quoteProvider = createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "mainnet",
    });
    const intent = createExecuteIntent({
      deploymentProfile: "mainnet",
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
    const quote = normalizeQuote(await quoteProvider.quote(intent));

    const settledIntentId =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const failedIntentId =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const queuedSettledDispatch = await relayer.dispatch({
      intentId: settledIntentId,
      intent,
      quote,
    });
    const settledDispatch = await waitForJob({
      relayer,
      jobId: queuedSettledDispatch.job.id,
    });
    assert.equal(settledDispatch.status, "completed");
    assert.equal(settledDispatch.result.sourceChain, "hydration");
    assert.equal(settledDispatch.result.strategy, "substrate-xcm-execute");
    assert.equal(settledDispatch.result.txHash, settledIntentId);

    const queuedSettled = await relayer.settle({
      intentId: settledIntentId,
      outcomeReference:
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      resultAssetId:
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      resultAmount: quote.expectedOutput.amount,
    });
    const settled = await waitForJob({
      relayer,
      jobId: queuedSettled.job.id,
    });
    assert.equal(settled.status, "completed");
    assert.equal(settled.result.strategy, "substrate-source-settlement");

    const queuedFailedDispatch = await relayer.dispatch({
      intentId: failedIntentId,
      intent,
      quote,
    });
    const failedDispatch = await waitForJob({
      relayer,
      jobId: queuedFailedDispatch.job.id,
    });
    assert.equal(failedDispatch.status, "completed");
    assert.equal(failedDispatch.result.txHash, failedIntentId);

    const queuedFailure = await relayer.fail({
      intentId: failedIntentId,
      outcomeReference:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      failureReasonHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
    });
    const failed = await waitForJob({
      relayer,
      jobId: queuedFailure.job.id,
    });
    assert.equal(failed.status, "completed");
    assert.equal(failed.result.strategy, "substrate-source-failure");

    const refundableAmount =
      quote.submission.amount +
      quote.submission.xcmFee +
      quote.submission.destinationFee;
    const queuedRefund = await relayer.refund({
      intentId: failedIntentId,
      refundAmount: refundableAmount,
    });
    const refunded = await waitForJob({
      relayer,
      jobId: queuedRefund.job.id,
    });
    assert.equal(refunded.status, "completed");
    assert.equal(refunded.result.strategy, "substrate-source-refund");
    assert.equal(refunded.result.refundAsset, quote.submission.asset);

    const snapshot = JSON.parse(readFileSync(join(tempDir, "jobs.json"), "utf8"));
    assert.equal(snapshot.source_intents[settledIntentId].status, "settled");
    assert.equal(
      snapshot.source_intents[settledIntentId].dispatchTxHash,
      settledIntentId,
    );
    assert.equal(snapshot.source_intents[failedIntentId].status, "refunded");
    assert.equal(
      snapshot.source_intents[failedIntentId].refundAmount,
      refundableAmount.toString(),
    );
    assert.equal(snapshot.source_intents[failedIntentId].refundAsset, "DOT");
  } finally {
    await service.close();
    await anvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer dispatches bifrost source intents on mainnet and records refund lifecycles", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-bifrost-source-"));
  const anvil = await spawnAnvil();
  const substrateDispatchScript = join(tempDir, "mock-substrate-dispatch.mjs");
  writeFileSync(
    substrateDispatchScript,
    [
      'import { readFileSync } from "node:fs";',
      'const payload = JSON.parse(readFileSync(0, "utf8"));',
      'process.stdout.write(JSON.stringify({',
      '  txHash: payload.intentId,',
      '  strategy: Number(payload.request?.mode ?? 0) === 0 ? "substrate-xcm-execute" : "substrate-xcm-send",',
      '}));',
      "",
    ].join("\n"),
  );
  const service = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: {
      XROUTE_RELAYER_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_RPC_URL: anvil.rpcUrl,
      XROUTE_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: hubRouterAddress,
      XROUTE_BIFROST_RPC_URL: "ws://127.0.0.1:9944",
      XROUTE_BIFROST_PRIVATE_KEY:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      XROUTE_SUBSTRATE_DISPATCH_SCRIPT: substrateDispatchScript,
      XROUTE_RELAYER_JOB_STORE_PATH: join(tempDir, "jobs.json"),
      XROUTE_STATUS_EVENTS_PATH: join(tempDir, "events.ndjson"),
      XROUTE_RELAYER_POLL_INTERVAL_MS: "25",
      XROUTE_RELAYER_RETRY_DELAY_MS: "25",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const relayer = createHttpExecutorRelayerClient({
      endpoint: service.url,
      authToken: "secret-token",
    });
    const quoteProvider = createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "mainnet",
    });
    const intent = createTransferIntent({
      deploymentProfile: "mainnet",
      sourceChain: "bifrost",
      destinationChain: "moonbeam",
      refundAddress,
      deadline: 1_773_185_200,
      params: {
        asset: "DOT",
        amount: "250000000000",
        recipient: ss58Recipient,
      },
    });
    const quote = normalizeQuote(await quoteProvider.quote(intent));
    const intentId =
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    const queuedDispatch = await relayer.dispatch({
      intentId,
      intent,
      quote,
    });
    const dispatched = await waitForJob({
      relayer,
      jobId: queuedDispatch.job.id,
    });
    assert.equal(dispatched.status, "completed");
    assert.equal(dispatched.result.sourceChain, "bifrost");
    assert.equal(dispatched.result.strategy, "substrate-xcm-execute");
    assert.equal(dispatched.result.txHash, intentId);

    const queuedFailure = await relayer.fail({
      intentId,
      outcomeReference:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      failureReasonHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
    });
    const failed = await waitForJob({
      relayer,
      jobId: queuedFailure.job.id,
    });
    assert.equal(failed.status, "completed");
    assert.equal(failed.result.strategy, "substrate-source-failure");

    const refundableAmount =
      quote.submission.amount +
      quote.submission.xcmFee +
      quote.submission.destinationFee;
    const queuedPartialRefund = await relayer.refund({
      intentId,
      refundAmount: refundableAmount - 1n,
    });
    const rejectedRefund = await waitForJob({
      relayer,
      jobId: queuedPartialRefund.job.id,
      statuses: ["failed"],
    });
    assert.equal(rejectedRefund.status, "failed");
    assert.match(rejectedRefund.lastError, /must equal refundable amount/i);

    const queuedRefund = await relayer.refund({
      intentId,
      refundAmount: refundableAmount,
    });
    const refunded = await waitForJob({
      relayer,
      jobId: queuedRefund.job.id,
    });
    assert.equal(refunded.status, "completed");
    assert.equal(refunded.result.strategy, "substrate-source-refund");
    assert.equal(refunded.result.refundAsset, quote.submission.asset);

    const snapshot = JSON.parse(readFileSync(join(tempDir, "jobs.json"), "utf8"));
    assert.equal(snapshot.source_intents[intentId].sourceChain, "bifrost");
    assert.equal(snapshot.source_intents[intentId].status, "refunded");
    assert.equal(
      snapshot.source_intents[intentId].refundAmount,
      refundableAmount.toString(),
    );
  } finally {
    await service.close();
    await anvil.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function waitForJob({ relayer, jobId, timeoutMs = 10000, statuses = ["completed"] } = {}) {
  const terminalStatuses = new Set(statuses);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { job } = await relayer.getJob(jobId);
    if (terminalStatuses.has(job.status)) {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(`job ${jobId} failed: ${job.lastError ?? "unknown-error"}`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error(`timed out waiting for job ${jobId}`);
}

async function getTransactionByHash(rpcUrl, txHash) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [txHash],
    }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? "rpc request failed");
  }

  return payload.result;
}

async function spawnAnvil({ host = "127.0.0.1" } = {}) {
  const port = await reservePort(host);
  const configDir = mkdtempSync(join(tmpdir(), "xroute-anvil-"));
  const configPath = join(configDir, "config.json");
  const child = spawn("anvil", ["--host", host, "--port", String(port), "--config-out", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`timed out waiting for anvil\n${stderr.trim()}`));
    }, 15_000);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    function onStdout(chunk) {
      if (String(chunk).includes("Listening on")) {
        cleanup();
        resolvePromise();
      }
    }

    function onStderr(chunk) {
      stderr += String(chunk);
    }

    function onExit(code, signal) {
      cleanup();
      rejectPromise(
        new Error(`anvil exited before startup (code=${code}, signal=${signal})\n${stderr.trim()}`),
      );
    }

    function onError(error) {
      cleanup();
      rejectPromise(error);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const privateKey = config.private_keys?.[0];
  if (typeof privateKey !== "string" || !privateKey.startsWith("0x")) {
    throw new Error("anvil config did not expose a usable private key");
  }

  return {
    child,
    rpcUrl: `http://${host}:${port}`,
    privateKey,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
        rmSync(configDir, { recursive: true, force: true });
        return;
      }

      child.kill("SIGTERM");
      await new Promise((resolvePromise) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolvePromise();
        });
      });
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function reservePort(host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("failed to reserve an ephemeral port"));
        return;
      }

      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise(address.port);
      });
    });
  });
}
