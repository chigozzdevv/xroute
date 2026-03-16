import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnRustService } from "../../../scripts/lib/spawn-rust-service.mjs";

const workspaceRoot = process.cwd();
const refundAddress = "0x1111111111111111111111111111111111111111";

test("xroute api serves quote and relayer routes from one base url", async () => {
  const fixture = createLiveInputsFixture();
  const anvil = await spawnAnvil();
  const service = await spawnRustService({
    packageName: "xroute-api",
    cwd: workspaceRoot,
    env: {
      ...fixture.env(),
      XROUTE_API_PORT: "0",
      XROUTE_RELAYER_AUTH_TOKEN: "secret-token",
      XROUTE_HUB_RPC_URL: anvil.rpcUrl,
      XROUTE_HUB_PRIVATE_KEY: anvil.privateKey,
      XROUTE_ROUTER_ADDRESS: "0x2222222222222222222222222222222222222222",
    },
  });

  try {
    const healthResponse = await fetch(`${service.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.quote.ok, true);
    assert.equal(health.relayer.ok, true);

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
    const quotePayload = await quoteResponse.json();
    assert.equal(quotePayload.quote.quoteId, "0xfeedface");

    const jobsResponse = await fetch(`${service.url}/jobs`);
    assert.equal(jobsResponse.status, 401);
  } finally {
    await service.close();
    await anvil.close();
    fixture.cleanup();
  }
});

function createLiveInputsFixture(document = defaultLiveInputsDocument()) {
  const tempDir = mkdtempSync(join(tmpdir(), "xroute-api-live-inputs-"));
  const liveInputsPath = join(tempDir, "live-inputs.json");
  writeFileSync(liveInputsPath, JSON.stringify(document));

  return {
    env(overrides = {}) {
      return {
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
    swapRoutes: [],
    executeRoutes: [],
    vdotOrders: [],
  };
}

async function spawnAnvil({ host = "127.0.0.1" } = {}) {
  const port = await reservePort(host);
  const configDir = mkdtempSync(join(tmpdir(), "xroute-api-anvil-"));
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
