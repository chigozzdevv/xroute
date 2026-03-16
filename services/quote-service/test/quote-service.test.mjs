import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnRustService } from "../../../scripts/lib/spawn-rust-service.mjs";

const workspaceRoot = process.cwd();
const refundAddress = "0x1111111111111111111111111111111111111111";
const substrateRefundAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

test("quote service serves health and quote responses", async () => {
  const fixture = createLiveInputsFixture();
  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: fixture.env(),
  });

  try {
    const healthResponse = await fetch(`${service.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.deploymentProfile, "mainnet");
    assert.equal(health.quoteInputs.mode, "file");

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
    assert.equal(payload.deploymentProfile, "mainnet");
  } finally {
    await service.close();
    fixture.cleanup();
  }
});

test("quote service enforces moonbeam evm execution policy", async () => {
  const fixture = createLiveInputsFixture();
  const policyPath = join(fixture.tempDir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      moonbeam: {
        call: {
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
    env: fixture.env({
      XROUTE_EVM_POLICY_PATH: policyPath,
    }),
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
              executionType: "call",
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
    fixture.cleanup();
  }
});

test("quote service accepts substrate refund identities for hydration-source quotes", async () => {
  const fixture = createLiveInputsFixture();
  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: fixture.env(),
  });

  try {
    const quoteResponse = await fetch(`${service.url}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        intent: {
          quoteId: "0xhydrafeed",
          sourceChain: "hydration",
          destinationChain: "moonbeam",
          refundAddress: substrateRefundAddress,
          deadline: 1_773_185_200,
          action: {
            type: "transfer",
            params: {
              asset: "DOT",
              amount: "10",
              recipient: "0x1111111111111111111111111111111111111111",
            },
          },
        },
      }),
    });

    assert.equal(quoteResponse.status, 200);
    const payload = await quoteResponse.json();
    assert.equal(payload.intent.refundAddress, substrateRefundAddress);
    assert.equal(payload.quote.quoteId, "0xhydrafeed");
  } finally {
    await service.close();
    fixture.cleanup();
  }
});

test("quote service rejects oversized request bodies", async () => {
  const fixture = createLiveInputsFixture();
  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: fixture.env({
      XROUTE_QUOTE_MAX_BODY_BYTES: "64",
    }),
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
    fixture.cleanup();
  }
});

test("quote service applies live quote inputs from file overrides", async () => {
  const fixture = createLiveInputsFixture({
    generatedAt: "2026-03-11T12:00:00Z",
    transferEdges: [
      {
        sourceChain: "polkadot-hub",
        destinationChain: "hydration",
        asset: "DOT",
        transportFee: "777",
        buyExecutionFee: "333",
      },
    ],
    swapRoutes: [
      {
        destinationChain: "hydration",
        assetIn: "DOT",
        assetOut: "USDT",
        priceNumerator: "50",
        priceDenominator: "1",
        dexFeeBps: 0,
      },
    ],
    executeRoutes: [
      {
        destinationChain: "moonbeam",
        asset: "DOT",
        executionType: "mint-vdot",
        executionBudget: "555",
      },
    ],
    vdotOrders: [
      {
        poolAssetAmount: "100000000000",
        poolVassetAmount: "50000000000",
        mintFeeBps: 0,
        redeemFeeBps: 10,
      },
    ],
  });

  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: fixture.env(),
  });

  try {
    const transferResponse = await fetch(`${service.url}/quote`, {
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
              amount: "10",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(transferResponse.status, 200);
    const transferPayload = await transferResponse.json();
    assert.equal(transferPayload.quote.fees.xcmFee.amount, "777");
    assert.equal(transferPayload.quote.fees.destinationFee.amount, "333");
    assert.equal(transferPayload.quoteInputs.mode, "file");
    assert.equal(transferPayload.quoteInputs.status, "live");
    assert.equal(transferPayload.quoteInputs.generatedAt, "2026-03-11T12:00:00Z");

    const swapResponse = await fetch(`${service.url}/quote`, {
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
            type: "swap",
            params: {
              assetIn: "DOT",
              assetOut: "USDT",
              amountIn: "10000000000",
              minAmountOut: "1",
              settlementChain: "hydration",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(swapResponse.status, 200);
    const swapPayload = await swapResponse.json();
    assert.equal(swapPayload.quote.expectedOutput.amount, "50000000");

    const healthResponse = await fetch(`${service.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.quoteInputs.mode, "file");
    assert.equal(healthPayload.quoteInputs.appliedTransferEdges, 1);
    assert.equal(healthPayload.quoteInputs.appliedSwapRoutes, 1);
    assert.equal(healthPayload.quoteInputs.appliedExecuteRoutes, 1);
    assert.equal(healthPayload.quoteInputs.appliedVdotOrders, 1);

    const executeResponse = await fetch(`${service.url}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        intent: {
          sourceChain: "hydration",
          destinationChain: "moonbeam",
          refundAddress,
          deadline: 1_773_185_200,
          action: {
            type: "execute",
            params: {
              executionType: "mint-vdot",
              amount: "10000000000",
              maxPaymentAmount: "555",
              recipient: "0x1111111111111111111111111111111111111111",
              adapterAddress: "0x2222222222222222222222222222222222222222",
              gasLimit: "500000",
              fallbackWeight: {
                refTime: 650000000,
                proofSize: 12288,
              },
              remark: "xroute",
              channelId: 0,
            },
          },
        },
      }),
    });

    assert.equal(executeResponse.status, 400);
    const executePayload = await executeResponse.json();
    assert.match(executePayload.error, /unsupported execute route/i);
  } finally {
    await service.close();
    fixture.cleanup();
  }
});

test("quote service applies live quote inputs from command overrides", async () => {
  const fixture = createLiveInputsFixture({
    generatedAt: "2026-03-11T12:00:00Z",
    transferEdges: [
      {
        sourceChain: "polkadot-hub",
        destinationChain: "hydration",
        asset: "DOT",
        transportFee: "999",
        buyExecutionFee: "444",
      },
    ],
    swapRoutes: [
      {
        destinationChain: "hydration",
        assetIn: "DOT",
        assetOut: "USDT",
        priceNumerator: "25",
        priceDenominator: "1",
        dexFeeBps: 0,
      },
    ],
  });

  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: {
      XROUTE_QUOTE_PORT: "0",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
      XROUTE_LIVE_QUOTE_INPUTS_COMMAND: `cat '${fixture.liveInputsPath}'`,
    },
  });

  try {
    const transferResponse = await fetch(`${service.url}/quote`, {
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
              amount: "10",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(transferResponse.status, 200);
    const transferPayload = await transferResponse.json();
    assert.equal(transferPayload.quote.fees.xcmFee.amount, "999");
    assert.equal(transferPayload.quote.fees.destinationFee.amount, "444");
    assert.equal(transferPayload.quoteInputs.mode, "command");

    const healthResponse = await fetch(`${service.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.quoteInputs.mode, "command");
    assert.equal(healthPayload.quoteInputs.status, "live");
  } finally {
    await service.close();
    fixture.cleanup();
  }
});

test("quote service serves the last live snapshot when command refresh fails briefly", async () => {
  const fixture = createLiveInputsFixture({
    generatedAt: "2026-03-11T12:00:00Z",
    transferEdges: [
      {
        sourceChain: "polkadot-hub",
        destinationChain: "hydration",
        asset: "DOT",
        transportFee: "999",
        buyExecutionFee: "444",
      },
    ],
    swapRoutes: [],
  });

  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: {
      XROUTE_QUOTE_PORT: "0",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
      XROUTE_LIVE_QUOTE_INPUTS_COMMAND: `cat '${fixture.liveInputsPath}'`,
      XROUTE_LIVE_QUOTE_INPUTS_REFRESH_MS: "10",
      XROUTE_LIVE_QUOTE_INPUTS_MAX_STALE_MS: "1000",
    },
  });

  try {
    const firstResponse = await fetch(`${service.url}/quote`, {
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
              amount: "10",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(firstResponse.status, 200);
    const firstPayload = await firstResponse.json();
    assert.equal(firstPayload.quote.fees.xcmFee.amount, "999");
    assert.equal(firstPayload.quoteInputs.status, "live");

    rmSync(fixture.liveInputsPath, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const secondResponse = await fetch(`${service.url}/quote`, {
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
              amount: "10",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(secondResponse.status, 200);
    const secondPayload = await secondResponse.json();
    assert.equal(secondPayload.quote.fees.xcmFee.amount, "999");
    assert.equal(secondPayload.quoteInputs.status, "live-with-last-error");
    assert.match(secondPayload.quoteInputs.lastError, /live quote inputs command exited with status/i);
    assert.equal(secondPayload.quoteInputs.usingStaticFallback, false);
  } finally {
    await service.close();
    fixture.cleanup();
  }
});

test("quote service truncates live quote command stderr in 503 responses", async () => {
  const service = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: {
      XROUTE_QUOTE_PORT: "0",
      XROUTE_WORKSPACE_ROOT: workspaceRoot,
      XROUTE_LIVE_QUOTE_INPUTS_COMMAND:
        "node -e 'console.error(\"state_getMetadata failed with status 403 on https://hk.p.bifrost-rpc.liebi.com \" + \"x\".repeat(600)); process.exit(1)'",
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
              amount: "10",
              recipient: "5Frecipient",
            },
          },
        },
      }),
    });

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.match(payload.error, /live quote inputs command exited with status/i);
    assert.match(payload.error, /state_getMetadata failed with status 403 on https:\/\/hk\.p\.bifrost-rpc\.liebi\.com/i);
    assert.equal(payload.error.includes("\n"), false);
    assert.ok(payload.error.length < 420);
  } finally {
    await service.close();
  }
});

test("quote service refuses to start on mainnet without live quote inputs", async () => {
  await assert.rejects(
    () =>
      spawnRustService({
        packageName: "quote-service",
        cwd: workspaceRoot,
        env: {
          XROUTE_QUOTE_PORT: "0",
          XROUTE_WORKSPACE_ROOT: workspaceRoot,
        },
      }),
    /mainnet requires live quote inputs/i,
  );
});

test("quote service refuses fail-open live inputs on mainnet", async () => {
  const fixture = createLiveInputsFixture({
    transferEdges: [],
    swapRoutes: [],
  });

  try {
    await assert.rejects(
      () =>
        spawnRustService({
          packageName: "quote-service",
          cwd: workspaceRoot,
          env: fixture.env({
            XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN: "true",
          }),
        }),
      /mainnet quote service must fail closed/i,
    );
  } finally {
    fixture.cleanup();
  }
});

function createLiveInputsFixture(document = defaultLiveInputsDocument()) {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-live-quote-inputs-"));
  const liveInputsPath = join(tempDir, "live-inputs.json");
  writeFileSync(liveInputsPath, JSON.stringify(document));

  return {
    tempDir,
    liveInputsPath,
    env(overrides = {}) {
      return {
        XROUTE_QUOTE_PORT: "0",
        XROUTE_WORKSPACE_ROOT: workspaceRoot,
        XROUTE_LIVE_QUOTE_INPUTS_PATH: liveInputsPath,
        ...overrides,
      };
    },
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function defaultLiveInputsDocument() {
  return {
    generatedAt: "2026-03-11T12:00:00Z",
    transferEdges: [
      {
        sourceChain: "polkadot-hub",
        destinationChain: "hydration",
        asset: "DOT",
        transportFee: "150000000",
        buyExecutionFee: "90000000",
      },
    ],
    swapRoutes: [
      {
        destinationChain: "hydration",
        assetIn: "DOT",
        assetOut: "USDT",
        priceNumerator: "495",
        priceDenominator: "100",
        dexFeeBps: 30,
      },
    ],
    executeRoutes: [],
    vdotOrders: [],
  };
}
