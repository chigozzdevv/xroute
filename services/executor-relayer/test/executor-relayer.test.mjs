import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExecuteIntent, createTransferIntent } from "../../../packages/xroute-intents/index.mjs";
import {
  createRouteEngineQuoteProvider,
} from "../../../packages/xroute-sdk/index.mjs";
import { startExecutorRelayer } from "../index.mjs";

const refundAddress = "0x1111111111111111111111111111111111111111";
const ss58Recipient = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

test("executor relayer authenticates and dispatches a queued job", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-"));
  const calls = [];
  const quoteProvider = createRouteEngineQuoteProvider({
    cwd: process.cwd(),
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

  const service = await startExecutorRelayer({
    port: 0,
    authToken: "secret-token",
    routerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    routerAdapter: {
      async dispatchIntent(input) {
        calls.push(["dispatch", input]);
        return {
          intentId: input.intentId,
          txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        };
      },
      async finalizeSuccess(input) {
        calls.push(["settle", input]);
        return input;
      },
      async finalizeFailure(input) {
        calls.push(["fail", input]);
        return input;
      },
      async refundFailedIntent(input) {
        calls.push(["refund", input]);
        return input;
      },
    },
    jobStorePath: join(tempDir, "jobs.json"),
    statusEventsPath: join(tempDir, "events.ndjson"),
    pollIntervalMs: 10,
    retryDelayMs: 25,
  });

  try {
    const unauthorized = await fetch(`${service.url}/jobs`, {
      method: "GET",
    });
    assert.equal(unauthorized.status, 401);

    const queued = await service.client.dispatch({
      intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      intent,
      quote,
    });
    assert.equal(queued.job.status, "queued");

    await service.drain();

    const jobs = await fetch(`${service.url}/jobs`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    }).then((response) => response.json());

    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].status, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "dispatch");
    assert.equal(
      calls[0][1].intentId,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  } finally {
    await service.close();
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
              maxGasLimit: "200000",
              maxPaymentAmount: "100000000",
            },
          ],
        },
      },
    }),
  );

  const service = await startExecutorRelayer({
    port: 0,
    authToken: "secret-token",
    executionPolicyPath: policyPath,
    routerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    routerAdapter: {
      async dispatchIntent() {
        throw new Error("dispatch should not be called");
      },
      async finalizeSuccess() {
        throw new Error("settle should not be called");
      },
      async finalizeFailure() {
        throw new Error("fail should not be called");
      },
      async refundFailedIntent() {
        throw new Error("refund should not be called");
      },
    },
    jobStorePath: join(tempDir, "jobs.json"),
    statusEventsPath: join(tempDir, "events.ndjson"),
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
      cwd: process.cwd(),
      deploymentProfile: "testnet",
    }).quote(intent);

    await assert.rejects(
      () =>
        service.client.dispatch({
          intentId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          intent,
          quote,
        }),
      /not allowlisted/,
    );
  } finally {
    await service.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executor relayer rejects oversized request bodies", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-relayer-oversized-"));
  const service = await startExecutorRelayer({
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 64,
    routerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    routerAdapter: {
      async dispatchIntent() {
        throw new Error("dispatch should not be called");
      },
      async finalizeSuccess() {
        throw new Error("settle should not be called");
      },
      async finalizeFailure() {
        throw new Error("fail should not be called");
      },
      async refundFailedIntent() {
        throw new Error("refund should not be called");
      },
    },
    jobStorePath: join(tempDir, "jobs.json"),
    statusEventsPath: join(tempDir, "events.ndjson"),
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
        refundAmount: "1000000000000000000000000000000000000000000000000000000000000000",
      }),
    });

    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.error, /exceeds/);
  } finally {
    await service.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
