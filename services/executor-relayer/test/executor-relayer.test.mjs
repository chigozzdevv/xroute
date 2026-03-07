import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTransferIntent, createExecuteIntent } from "../../../packages/xroute-intents/index.mjs";
import {
  createHttpExecutorRelayerClient,
  createRouteEngineQuoteProvider,
} from "../../../packages/xroute-sdk/index.mjs";
import { spawnAnvil } from "../../../testing/spawn-anvil.mjs";
import { spawnRustService } from "../../../testing/spawn-rust-service.mjs";

const workspaceRoot = process.cwd();
const refundAddress = "0x1111111111111111111111111111111111111111";
const ss58Recipient = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const routerAddress = "0x2222222222222222222222222222222222222222";

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
      XROUTE_ROUTER_ADDRESS: routerAddress,
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
      deploymentProfile: "testnet",
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
    const quote = await quoteProvider.quote(intent);
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
      XROUTE_ROUTER_ADDRESS: routerAddress,
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
      deploymentProfile: "testnet",
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
      XROUTE_ROUTER_ADDRESS: routerAddress,
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

async function waitForJob({ relayer, jobId, timeoutMs = 10000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { job } = await relayer.getJob(jobId);
    if (job.status === "completed") {
      return job;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error(`timed out waiting for job ${jobId}`);
}
