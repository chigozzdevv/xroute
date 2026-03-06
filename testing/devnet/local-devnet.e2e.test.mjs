import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  FileBackedStatusIndexer,
  createCastRouterAdapter,
  createCastTransactDispatcher,
  createRouteEngineQuoteProvider,
  createStaticAssetAddressResolver,
  createXRouteClient,
  encodeAssetIdSymbol,
} from "../../packages/xroute-sdk/index.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployScriptPath = resolve(workspaceRoot, "scripts/deploy-local-devnet.mjs");
const manifestGeneratorPath = resolve(
  workspaceRoot,
  "packages/xroute-precompile-interfaces/scripts/generate-manifests.mjs",
);
const localStackPath = resolve(
  workspaceRoot,
  "contracts/polkadot-hub-router/devnet/local-stack.json",
);
const privateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

test("local devnet deploys the stack and settles a live swap through the sdk", async () => {
  const port = await getAvailablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const tempRoot = mkdtempSync(resolve(tmpdir(), "xroute-devnet-"));
  const anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337"],
    {
      cwd: workspaceRoot,
      stdio: "ignore",
    },
  );

  try {
    await waitForRpc(rpcUrl);

    execFileSync("node", [deployScriptPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        XROUTE_LOCAL_RPC_URL: rpcUrl,
        XROUTE_LOCAL_PRIVATE_KEY: privateKey,
      },
      encoding: "utf8",
    });
    execFileSync("node", [manifestGeneratorPath], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    const stack = JSON.parse(readFileSync(localStackPath, "utf8"));
    const statusProvider = new FileBackedStatusIndexer({
      eventsPath: resolve(tempRoot, "status-events.jsonl"),
    });
    const quoteProvider = createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: "local",
    });
    const routerAdapter = createCastRouterAdapter({
      rpcUrl,
      routerAddress: stack.routerAddress,
      privateKey,
      ownerAddress: stack.deployer,
      statusIndexer: statusProvider,
    });
    const transactDispatcher = createCastTransactDispatcher({
      rpcUrl,
      dispatcherAddress: stack.dispatcherAddress,
      privateKey,
    });
    const client = createXRouteClient({
      quoteProvider,
      routerAdapter,
      statusProvider,
      assetAddressResolver: createStaticAssetAddressResolver({
        "polkadot-hub": {
          DOT: stack.tokens.DOT,
        },
      }),
    });

    const { intent, quote } = await client.quote({
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      refundAddress: stack.deployer,
      deadline: Math.floor(Date.now() / 1000) + 1800,
      action: {
        type: "swap",
        params: {
          assetIn: "DOT",
          assetOut: "USDT",
          amountIn: "1000000000000",
          minAmountOut: "493000000",
          settlementChain: "asset-hub",
          recipient: stack.deployer,
        },
      },
    });

    assert.deepEqual(quote.route, [
      "polkadot-hub",
      "asset-hub",
      "hydration",
      "asset-hub",
    ]);
    assert.deepEqual(quote.estimatedSettlementFee, {
      asset: "USDT",
      amount: 35000n,
    });

    const execution = await client.execute({
      intent,
      quote,
      owner: stack.deployer,
    });
    assert.equal(execution.status.status, "executing");

    const destinationDispatch = await transactDispatcher.dispatchQuote(quote);
    assert.match(destinationDispatch.txHash, /^0x[0-9a-f]{64}$/);

    await client.settle({
      intentId: execution.submitted.intentId,
      outcomeReference:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resultAssetId: encodeAssetIdSymbol(quote.expectedOutput.asset),
      resultAmount: quote.expectedOutput.amount,
    });

    const status = client.getStatus(execution.submitted.intentId);
    assert.equal(status.status, "settled");
    assert.equal(status.result.amount, quote.expectedOutput.amount);

    const usdtBalance = readUint256({
      rpcUrl,
      contractAddress: stack.tokens.USDT,
      signature: "balanceOf(address)(uint256)",
      args: [stack.deployer],
    });
    assert.equal(usdtBalance, quote.expectedOutput.amount);
  } finally {
    anvil.kill("SIGTERM");
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function readUint256({ rpcUrl, contractAddress, signature, args = [] }) {
  const output = execFileSync(
    "cast",
    ["call", contractAddress, signature, ...args.map(String), "--rpc-url", rpcUrl],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  ).trim();

  const normalized = output.trim();
  const hexMatch = normalized.match(/^(0x[0-9a-f]+)/i);
  if (hexMatch) {
    return BigInt(hexMatch[1]);
  }

  const decimalMatch = normalized.match(/^(\d+)/);
  if (decimalMatch) {
    return BigInt(decimalMatch[1]);
  }

  throw new Error(`unable to parse uint256 from cast output: ${normalized}`);
}

async function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a local port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePort(port);
      });
    });
  });
}

async function waitForRpc(targetRpcUrl) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      execFileSync("cast", ["chain-id", "--rpc-url", targetRpcUrl], {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: "ignore",
      });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }

  throw new Error(`timed out waiting for ${targetRpcUrl}`);
}
