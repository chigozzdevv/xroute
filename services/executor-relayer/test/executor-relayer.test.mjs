import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

import { createTransferIntent, createExecuteIntent } from "../../../packages/xroute-intents/index.mjs";
import {
  createHttpExecutorRelayerClient,
  createRouteEngineQuoteProvider,
} from "../../../packages/xroute-sdk/index.mjs";
import { spawnRustService } from "../../../scripts/lib/spawn-rust-service.mjs";

const workspaceRoot = process.cwd();
const refundAddress = "0x1111111111111111111111111111111111111111";
const ss58Recipient = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const routerAddress = "0x2222222222222222222222222222222222222222";
const defaultAnvilPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
      deploymentProfile: "integration",
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
      deploymentProfile: "moonbase-alpha",
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

async function spawnAnvil({ host = "127.0.0.1" } = {}) {
  const port = await reservePort(host);
  const child = spawn("anvil", ["--host", host, "--port", String(port)], {
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

  return {
    child,
    rpcUrl: `http://${host}:${port}`,
    privateKey: defaultAnvilPrivateKey,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
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
