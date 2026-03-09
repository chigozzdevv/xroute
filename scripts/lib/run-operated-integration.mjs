import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import {
  createExecuteIntent,
  createSwapIntent,
  createTransferIntent,
} from "../../packages/xroute-intents/index.mjs";
import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
  createXRouteClient,
  normalizeQuote,
} from "../../packages/xroute-sdk/index.mjs";
import {
  createCastRouterAdapter,
  NATIVE_ASSET_ADDRESS,
  encodeAssetIdSymbol,
} from "../../packages/xroute-sdk/router-adapters.mjs";
import { InMemoryStatusIndexer } from "../../packages/xroute-sdk/status-indexer.mjs";
import { deployStack } from "../deploy-stack.mjs";
import { spawnRustService } from "./spawn-rust-service.mjs";
import { spawnAnvil } from "../../testing/spawn-anvil.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_RELAYER_TOKEN = "integration-relayer-token";
const DEFAULT_OWNER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const DEFAULT_REFUND_ADDRESS = DEFAULT_OWNER;
const DEFAULT_RECIPIENT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const STATUS_ENUM = Object.freeze({
  NONE: 0,
  SUBMITTED: 1,
  DISPATCHED: 2,
  SETTLED: 3,
  FAILED: 4,
  CANCELLED: 5,
  REFUNDED: 6,
});

export async function runOperatedIntegration({
  workspaceRoot = resolve(new URL("../..", import.meta.url).pathname),
  authToken = DEFAULT_RELAYER_TOKEN,
  owner = DEFAULT_OWNER,
  printSummary = false,
} = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "xroute-operated-integration-"));
  const anvil = await spawnAnvil();
  let quoteService;
  let relayerService;

  try {
    const xcmAddress = await deployForgeContract({
      workspaceRoot,
      contractId: "src/mocks/MockXcmPrecompile.sol:MockXcmPrecompile",
      rpcUrl: anvil.rpcUrl,
      privateKey: anvil.privateKey,
    });

    const deployment = deployStack({
      deploymentProfile: "integration",
      allowLiveDeployment: "true",
      rpcUrl: anvil.rpcUrl,
      privateKey: anvil.privateKey,
      xcmAddress,
      stackOutputPath: join(runtimeDir, "polkadot-hub.json"),
    });

    quoteService = await spawnRustService({
      packageName: "quote-service",
      cwd: workspaceRoot,
      env: {
        XROUTE_QUOTE_PORT: "0",
        XROUTE_DEPLOYMENT_PROFILE: "integration",
        XROUTE_WORKSPACE_ROOT: workspaceRoot,
      },
    });

    relayerService = await spawnRustService({
      packageName: "executor-relayer",
      cwd: workspaceRoot,
      env: {
        XROUTE_RELAYER_PORT: "0",
        XROUTE_DEPLOYMENT_PROFILE: "integration",
        XROUTE_RELAYER_AUTH_TOKEN: authToken,
        XROUTE_RPC_URL: anvil.rpcUrl,
        XROUTE_PRIVATE_KEY: anvil.privateKey,
        XROUTE_ROUTER_ADDRESS: deployment.routerAddress,
        XROUTE_XCM_ADDRESS: xcmAddress,
        XROUTE_RELAYER_JOB_STORE_PATH: join(runtimeDir, "jobs.json"),
        XROUTE_STATUS_EVENTS_PATH: join(runtimeDir, "status.ndjson"),
        XROUTE_RELAYER_POLL_INTERVAL_MS: "25",
        XROUTE_RELAYER_RETRY_DELAY_MS: "25",
        XROUTE_RELAYER_MAX_ATTEMPTS: "2",
        XROUTE_WORKSPACE_ROOT: workspaceRoot,
      },
    });

    const statusIndexer = new InMemoryStatusIndexer();
    const quoteProvider = createHttpQuoteProvider({
      endpoint: `${quoteService.url}/quote`,
      headers: {
        "x-xroute-deployment-profile": "integration",
      },
    });
    const routerAdapter = createCastRouterAdapter({
      rpcUrl: anvil.rpcUrl,
      routerAddress: deployment.routerAddress,
      privateKey: anvil.privateKey,
      ownerAddress: owner,
      statusIndexer,
    });
    const client = createXRouteClient({
      quoteProvider,
      routerAdapter,
      statusProvider: statusIndexer,
      assetAddressResolver: async () => NATIVE_ASSET_ADDRESS,
    });
    const relayer = createHttpExecutorRelayerClient({
      endpoint: relayerService.url,
      authToken,
    });

    const scenarios = [
      {
        name: "transfer",
        createIntent() {
          return createTransferIntent({
            deploymentProfile: "integration",
            sourceChain: "moonbeam",
            destinationChain: "hydration",
            refundAddress: DEFAULT_REFUND_ADDRESS,
            deadline: 1_773_185_200,
            params: {
              asset: "DOT",
              amount: "250000000000",
              recipient: DEFAULT_RECIPIENT,
            },
          });
        },
      },
      {
        name: "swap",
        createIntent() {
          return createSwapIntent({
            deploymentProfile: "integration",
            sourceChain: "moonbeam",
            destinationChain: "hydration",
            refundAddress: DEFAULT_REFUND_ADDRESS,
            deadline: 1_773_185_200,
            params: {
              assetIn: "DOT",
              assetOut: "USDT",
              amountIn: "1000000000000",
              minAmountOut: "490000000",
              settlementChain: "polkadot-hub",
              recipient: DEFAULT_RECIPIENT,
            },
          });
        },
      },
      {
        name: "execute-runtime-call",
        createIntent() {
          return createExecuteIntent({
            deploymentProfile: "integration",
            sourceChain: "polkadot-hub",
            destinationChain: "hydration",
            refundAddress: DEFAULT_REFUND_ADDRESS,
            deadline: 1_773_185_200,
            params: {
              executionType: "runtime-call",
              asset: "DOT",
              maxPaymentAmount: "90000000",
              callData: "0x01020304",
              fallbackWeight: {
                refTime: 250000000,
                proofSize: 4096,
              },
            },
          });
        },
      },
      {
        name: "execute-evm-contract-call",
        createIntent() {
          return createExecuteIntent({
            deploymentProfile: "integration",
            sourceChain: "hydration",
            destinationChain: "moonbeam",
            refundAddress: DEFAULT_REFUND_ADDRESS,
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
        },
      },
      {
        name: "execute-vtoken-order",
        createIntent() {
          return createExecuteIntent({
            deploymentProfile: "integration",
            sourceChain: "polkadot-hub",
            destinationChain: "bifrost",
            refundAddress: DEFAULT_REFUND_ADDRESS,
            deadline: 1_773_185_200,
            params: {
              executionType: "vtoken-order",
              asset: "DOT",
              amount: "250000000000",
              maxPaymentAmount: "200000000",
              operation: "mint",
              recipient: DEFAULT_RECIPIENT,
              channelId: 7,
              remark: "xroute",
              fallbackWeight: {
                refTime: 600000000,
                proofSize: 12288,
              },
            },
          });
        },
      },
    ];

    const results = [];

    for (const [index, scenario] of scenarios.entries()) {
      const intent = scenario.createIntent();
      const { quote } = await client.quote(intent);
      const submitted = await client.submit({
        intent,
        quote,
        owner,
      });

      const dispatchResponse = await relayer.dispatch({
        intentId: submitted.intentId,
        intent,
        quote,
      });
      const completedDispatch = await waitForCompletedJob(relayer, dispatchResponse.job.id);

      const outcomeReference = deterministicBytes32(`${scenario.name}-outcome-${index}`);
      const normalizedQuote = normalizeQuote(quote);
      const settleResponse = await relayer.settle({
        intentId: submitted.intentId,
        outcomeReference,
        resultAssetId: encodeAssetIdSymbol(normalizedQuote.expectedOutput.asset),
        resultAmount: normalizedQuote.expectedOutput.amount,
      });
      const completedSettlement = await waitForCompletedJob(relayer, settleResponse.job.id);
      const onchain = await readIntentRecord({
        rpcUrl: anvil.rpcUrl,
        routerAddress: deployment.routerAddress,
        intentId: submitted.intentId,
      });

      assert.equal(onchain.status, STATUS_ENUM.SETTLED);
      assert.equal(onchain.resultAmount, normalizedQuote.expectedOutput.amount.toString());

      results.push({
        name: scenario.name,
        quoteId: normalizedQuote.quoteId,
        intentId: submitted.intentId,
        route: normalizedQuote.route,
        expectedOutput: {
          asset: normalizedQuote.expectedOutput.asset,
          amount: normalizedQuote.expectedOutput.amount.toString(),
        },
        dispatchTxHash: completedDispatch.result.txHash,
        settlementTxHash: completedSettlement.result.txHash,
        routerStatus: "settled",
      });
    }

    const summary = {
      ok: true,
      deploymentProfile: "integration",
      rpcUrl: anvil.rpcUrl,
      routerAddress: deployment.routerAddress,
      xcmAddress,
      quoteServiceUrl: quoteService.url,
      relayerUrl: relayerService.url,
      scenarios: results,
    };

    if (printSummary) {
      console.log(JSON.stringify(summary, null, 2));
    }

    return summary;
  } finally {
    await quoteService?.close?.().catch(() => {});
    await relayerService?.close?.().catch(() => {});
    await anvil.close().catch(() => {});
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function deployForgeContract({
  workspaceRoot,
  contractId,
  rpcUrl,
  privateKey,
  constructorArgs = [],
} = {}) {
  const args = [
    "create",
    contractId,
    "--root",
    resolve(workspaceRoot, "contracts/polkadot-hub-router"),
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKey,
    "--broadcast",
  ];
  if (constructorArgs.length > 0) {
    args.push("--constructor-args", ...constructorArgs);
  }

  const { stdout } = await execFileAsync("forge", args, {
    cwd: workspaceRoot,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error(`failed to parse deployed address for ${contractId}\n${stdout}`);
  }

  return match[1].toLowerCase();
}

async function waitForCompletedJob(relayer, jobId, timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const { job } = await relayer.getJob(jobId);
    if (job.status === "completed") {
      return job;
    }
    if (job.status === "failed" && !job.nextAttemptAt) {
      throw new Error(job.lastError ?? `job ${jobId} failed`);
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });
  }

  throw new Error(`timed out waiting for job ${jobId}`);
}

async function readIntentRecord({ rpcUrl, routerAddress, intentId } = {}) {
  const { stdout } = await execFileAsync(
    "cast",
    [
      "call",
      routerAddress,
      "getIntent(bytes32)((address,address,address,uint128,uint128,uint128,uint128,uint128,uint64,uint8,uint8,bytes32,bytes32,bytes32,bytes32,uint128,uint128))",
      intentId,
      "--rpc-url",
      rpcUrl,
    ],
    {
      maxBuffer: 1024 * 1024,
    },
  );

  const normalized = stdout.trim().replace(/^\(/, "").replace(/\)$/, "");
  const fields = normalized.split(",").map((value) => value.trim().split(/\s+/)[0]);
  if (fields.length !== 17) {
    throw new Error(`unexpected getIntent tuple: ${stdout.trim()}`);
  }

  return {
    status: Number(fields[10]),
    resultAmount: fields[15],
  };
}

function deterministicBytes32(label) {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}
