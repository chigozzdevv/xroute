import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnRustService } from "../../../scripts/lib/spawn-rust-service.mjs";

const workspaceRoot = process.cwd();
const refundAddress = "0x1111111111111111111111111111111111111111";

test("quote service serves health and quote responses", async () => {
  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: {
      XROUTE_QUOTE_PORT: "0",
      XROUTE_DEPLOYMENT_PROFILE: "integration",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const healthResponse = await fetch(`${service.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.deploymentProfile, "integration");

    const quoteResponse = await fetch(`${service.url}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        intent: {
          quoteId: "0xfeedface",
          sourceChain: "polkadot-hub",
          destinationChain: "hydration",
          refundAddress,
          deadline: 1_773_185_200,
          action: {
            type: "transfer",
            params: {
              asset: "DOT",
              amount: "10",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(quoteResponse.status, 200);
    const payload = await quoteResponse.json();
    assert.equal(payload.intent.action.type, "transfer");
    assert.equal(payload.quote.submission.action, "transfer");
    assert.equal(payload.quote.quoteId, "0xfeedface");
  } finally {
    await service.close();
  }
});

test("quote service enforces moonbeam evm execution policy", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-quote-policy-"));
  const policyPath = join(tempDir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      moonbeam: {
        evmContractCall: {
          allowedContracts: [
            {
              address: "0x1111111111111111111111111111111111111111",
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

  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: {
      XROUTE_QUOTE_PORT: "0",
      XROUTE_DEPLOYMENT_PROFILE: "moonbase-alpha",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
      XROUTE_EVM_POLICY_PATH: policyPath,
    },
  });

  try {
    const disallowed = await fetch(`${service.url}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        intent: {
          sourceChain: "polkadot-hub",
          destinationChain: "moonbeam",
          refundAddress,
          deadline: 1_773_185_200,
          action: {
            type: "execute",
            params: {
              executionType: "evm-contract-call",
              asset: "DOT",
              maxPaymentAmount: "110000000",
              contractAddress: "0x2222222222222222222222222222222222222222",
              calldata: "0xdeadbeef",
              value: "0",
              gasLimit: "250000",
              fallbackWeight: {
                refTime: 650000000,
                proofSize: 12288,
              },
            },
          },
        },
      }),
    });

    assert.equal(disallowed.status, 400);
    const disallowedBody = await disallowed.json();
    assert.match(disallowedBody.error, /not allowlisted|maxGasLimit|maxPaymentAmount/);
  } finally {
    await service.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quote service rejects oversized request bodies", async () => {
  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: {
      XROUTE_QUOTE_PORT: "0",
      XROUTE_QUOTE_MAX_BODY_BYTES: "64",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
    },
  });

  try {
    const response = await fetch(`${service.url}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        intent: {
          sourceChain: "polkadot-hub",
          destinationChain: "hydration",
          refundAddress,
          deadline: 1_773_185_200,
          action: {
            type: "transfer",
            params: {
              asset: "DOT",
              amount: "1000000000000",
              recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            },
          },
        },
      }),
    });

    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.error, /exceeds/);
  } finally {
    await service.close();
  }
});
