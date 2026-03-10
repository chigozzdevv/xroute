import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
  createXRouteClient,
} from "../packages/xroute-sdk/index.mjs";
import {
  createCastRouterAdapter,
  NATIVE_ASSET_ADDRESS,
} from "../packages/xroute-sdk/router-adapters.mjs";
import { FileBackedStatusIndexer } from "../packages/xroute-sdk/status-indexer.mjs";
import { spawnRustService } from "./lib/spawn-rust-service.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const defaultHydrationRecipient =
  "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

loadDotEnv(join(workspaceRoot, ".env"));

const settings = await resolveSettings();
const runtimeDir = mkdtempSync(join(tmpdir(), "xroute-hydration-e2e-"));
const statusEventsPath = join(runtimeDir, "sdk-status.ndjson");

let quoteService;
let relayerService;
let submittedIntentId = null;

try {
  const serviceEnv = buildServiceEnv(settings, runtimeDir);
  quoteService = await spawnRustService({
    packageName: "quote-service",
    cwd: workspaceRoot,
    env: serviceEnv,
  });
  relayerService = await spawnRustService({
    packageName: "executor-relayer",
    cwd: workspaceRoot,
    env: serviceEnv,
  });

  const quoteHealth = await requestJson(`${quoteService.url}/healthz`);
  const relayer = createHttpExecutorRelayerClient({
    endpoint: relayerService.url,
    authToken: settings.relayerAuthToken,
  });
  const relayerHealth = await relayer.health();

  assertProfileHealth("quote-service", quoteHealth, settings);
  assertProfileHealth("executor-relayer", relayerHealth, settings);

  const statusProvider = new FileBackedStatusIndexer({
    eventsPath: statusEventsPath,
  });
  const routerAdapter = createCastRouterAdapter({
    rpcUrl: settings.rpcUrl,
    routerAddress: settings.routerAddress,
    privateKey: settings.privateKey,
    ownerAddress: settings.deployerAddress,
    cwd: workspaceRoot,
    statusIndexer: statusProvider,
  });
  const client = createXRouteClient({
    quoteProvider: createHttpQuoteProvider({
      endpoint: `${quoteService.url}/quote`,
      headers: {
        "x-xroute-deployment-profile": settings.deploymentProfile,
      },
    }),
    routerAdapter,
    statusProvider,
    assetAddressResolver: async ({ chainKey, assetKey }) => {
      if (chainKey === "polkadot-hub" && assetKey === "PAS") {
        return NATIVE_ASSET_ADDRESS;
      }

      throw new Error(`unsupported source asset ${assetKey} on ${chainKey}`);
    },
  });

  const balanceBefore = await readNativeBalance(settings.deployerAddress, settings.rpcUrl);
  const intentInput = {
    deploymentProfile: settings.deploymentProfile,
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: settings.deployerAddress,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    action: {
      type: "swap",
      params: {
        assetIn: "PAS",
        assetOut: "HDX",
        amountIn: settings.amountIn,
        minAmountOut: settings.minAmountOut,
        settlementChain: "hydration",
        recipient: settings.hydrationRecipient,
      },
    },
  };

  const { intent, quote } = await client.quote(intentInput);
  const totalLocked =
    quote.submission.amount +
    quote.submission.xcmFee +
    quote.submission.destinationFee +
    quote.fees.platformFee.amount;

  if (balanceBefore < totalLocked) {
    throw new Error(
      `insufficient PAS for hydration-snakenet run: balance=${balanceBefore} required=${totalLocked}`,
    );
  }

  const submitted = await client.submit({
    intent,
    quote,
    owner: settings.deployerAddress,
  });
  submittedIntentId = submitted.intentId;

  const dispatchQueued = await relayer.dispatch({
    intentId: submitted.intentId,
    intent,
    quote,
  });
  const dispatchJob = await waitForJob({
    relayer,
    jobId: dispatchQueued.job.id,
  });
  const dispatchReceipt = await readReceipt(dispatchJob.result.txHash, settings.rpcUrl);

  const settleQueued = await relayer.settle({
    intentId: submitted.intentId,
    outcomeReference: dispatchJob.result.txHash,
    resultAssetId: await keccakUtf8(quote.expectedOutput.asset),
    resultAmount: quote.expectedOutput.amount.toString(),
  });
  const settleJob = await waitForJob({
    relayer,
    jobId: settleQueued.job.id,
  });
  const settleReceipt = await readReceipt(settleJob.result.txHash, settings.rpcUrl);

  const intentRecord = await readIntentRecord({
    routerAddress: settings.routerAddress,
    rpcUrl: settings.rpcUrl,
    intentId: submitted.intentId,
  });
  const balanceAfter = await readNativeBalance(settings.deployerAddress, settings.rpcUrl);

  if (intentRecord.status !== "settled") {
    throw new Error(`expected settled router status, received ${intentRecord.status}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        deploymentProfile: settings.deploymentProfile,
        routerAddress: settings.routerAddress,
        quoteService: quoteService.url,
        relayerService: relayerService.url,
        intentId: submitted.intentId,
        quoteId: quote.quoteId,
        route: quote.route,
        expectedOutput: {
          asset: quote.expectedOutput.asset,
          amount: quote.expectedOutput.amount.toString(),
        },
        fees: {
          xcmFee: quote.fees.xcmFee.amount.toString(),
          destinationFee: quote.fees.destinationFee.amount.toString(),
          platformFee: quote.fees.platformFee.amount.toString(),
          totalFee: quote.fees.totalFee.amount.toString(),
          totalLocked: totalLocked.toString(),
        },
        dispatch: {
          jobId: dispatchJob.id,
          txHash: dispatchJob.result.txHash,
          strategy: dispatchJob.result.strategy,
          receiptStatus: dispatchReceipt.status,
          blockNumber: dispatchReceipt.blockNumber,
        },
        settle: {
          jobId: settleJob.id,
          txHash: settleJob.result.txHash,
          receiptStatus: settleReceipt.status,
          blockNumber: settleReceipt.blockNumber,
        },
        routerIntent: intentRecord,
        balances: {
          before: balanceBefore.toString(),
          after: balanceAfter.toString(),
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (submittedIntentId) {
    await bestEffortCleanup({
      intentId: submittedIntentId,
      routerAddress: settings.routerAddress,
      rpcUrl: settings.rpcUrl,
      privateKey: settings.privateKey,
    });
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await quoteService?.close();
  await relayerService?.close();
  rmSync(runtimeDir, { recursive: true, force: true });
}

async function resolveSettings() {
  const deploymentProfile = requireEnv("XROUTE_DEPLOYMENT_PROFILE");
  if (deploymentProfile !== "hydration-snakenet") {
    throw new Error(
      `scripts/run-hydration-snakenet-validation.mjs only supports XROUTE_DEPLOYMENT_PROFILE=hydration-snakenet, received ${deploymentProfile}`,
    );
  }

  return {
    deploymentProfile,
    rpcUrl: requireEnv("XROUTE_RPC_URL"),
    privateKey: requireEnv("XROUTE_PRIVATE_KEY"),
    routerAddress:
      process.env.XROUTE_ROUTER_ADDRESS ??
      readDeploymentArtifact(deploymentProfile).contracts?.XRouteHubRouter,
    relayerAuthToken: requireEnv("XROUTE_RELAYER_AUTH_TOKEN"),
    deployerAddress:
      process.env.XROUTE_DEPLOYER_ADDRESS ??
      (await runCast(["wallet", "address", "--private-key", requireEnv("XROUTE_PRIVATE_KEY")])),
    amountIn: (process.env.XROUTE_HYDRATION_SWAP_AMOUNT_IN ?? "10000000000").trim(),
    minAmountOut: (process.env.XROUTE_HYDRATION_MIN_AMOUNT_OUT ?? "1000000000000").trim(),
    gasLimit: (process.env.XROUTE_HYDRATION_GAS_LIMIT ?? "1000000").trim(),
    hydrationRecipient:
      process.env.XROUTE_HYDRATION_RECIPIENT?.trim() || defaultHydrationRecipient,
  };
}

function buildServiceEnv(settings, runtimeDir) {
  return {
    XROUTE_DEPLOYMENT_PROFILE: settings.deploymentProfile,
    XROUTE_RPC_URL: settings.rpcUrl,
    XROUTE_PRIVATE_KEY: settings.privateKey,
    XROUTE_ROUTER_ADDRESS: settings.routerAddress,
    XROUTE_RELAYER_AUTH_TOKEN: settings.relayerAuthToken,
    XROUTE_RELAYER_GAS_LIMIT: settings.gasLimit,
    XROUTE_WORKSPACE_ROOT: workspaceRoot,
    XROUTE_QUOTE_PORT: "0",
    XROUTE_RELAYER_PORT: "0",
    XROUTE_RELAYER_JOB_STORE_PATH: join(runtimeDir, "relayer-jobs.json"),
    XROUTE_STATUS_EVENTS_PATH: join(runtimeDir, "relayer-events.ndjson"),
  };
}

function assertProfileHealth(serviceName, health, settings) {
  if (!health?.ok) {
    throw new Error(`${serviceName} health check did not return ok=true`);
  }
  if (health.deploymentProfile !== settings.deploymentProfile) {
    throw new Error(
      `${serviceName} is serving ${health.deploymentProfile}, expected ${settings.deploymentProfile}`,
    );
  }
  if (
    health.routerAddress &&
    health.routerAddress.toLowerCase() !== settings.routerAddress.toLowerCase()
  ) {
    throw new Error(
      `${serviceName} router mismatch: ${health.routerAddress} != ${settings.routerAddress}`,
    );
  }
}

async function waitForJob({ relayer, jobId, timeoutMs = 60_000 } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const { job } = await relayer.getJob(jobId);
    if (job.status === "completed") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(
        `relayer job ${jobId} failed: ${job.lastError ?? "unknown-error"}`,
      );
    }

    await sleep(1000);
  }

  throw new Error(`timed out waiting for relayer job ${jobId}`);
}

async function bestEffortCleanup({ intentId, routerAddress, rpcUrl, privateKey }) {
  try {
    const intent = await readIntentRecord({ routerAddress, rpcUrl, intentId });
    if (intent.status === "submitted") {
      await sendCastTransaction({
        to: routerAddress,
        signature: "cancelIntent(bytes32)",
        args: [intentId],
        rpcUrl,
        privateKey,
      });
      return;
    }

    if (intent.status === "failed") {
      const refundableAmount = await runCast([
        "call",
        routerAddress,
        "previewRefundableAmount(bytes32)(uint128)",
        intentId,
        "--rpc-url",
        rpcUrl,
      ]);
      if (BigInt(refundableAmount) > 0n) {
        await sendCastTransaction({
          to: routerAddress,
          signature: "refundFailedIntent(bytes32,uint128)",
          args: [intentId, refundableAmount],
          rpcUrl,
          privateKey,
        });
      }
    }
  } catch {}
}

async function readIntentRecord({ routerAddress, rpcUrl, intentId }) {
  const raw = await runCast([
    "call",
    routerAddress,
    "getIntent(bytes32)((address,address,address,uint128,uint128,uint128,uint128,uint128,uint64,uint8,uint8,bytes32,bytes32,bytes32,bytes32,uint128,uint128))",
    intentId,
    "--rpc-url",
    rpcUrl,
  ]);
  const normalized = raw.trim().replace(/^\(|\)$/g, "");
  const values = normalized.split(", ").map((value) => value.split(" ")[0]);

  return {
    owner: values[0],
    asset: values[1],
    refundAddress: values[2],
    amount: values[3],
    xcmFee: values[4],
    destinationFee: values[5],
    platformFee: values[6],
    minOutputAmount: values[7],
    deadline: values[8],
    actionType: intentAction(values[9]),
    status: intentStatus(values[10]),
    executionHash: values[11],
    outcomeReference: values[12],
    resultAssetId: values[13],
    failureReasonHash: values[14],
    resultAmount: values[15],
    refundAmount: values[16],
  };
}

function intentAction(value) {
  switch (Number(value)) {
    case 0:
      return "transfer";
    case 1:
      return "swap";
    case 2:
      return "execute";
    default:
      return `unknown:${value}`;
  }
}

function intentStatus(value) {
  switch (Number(value)) {
    case 0:
      return "none";
    case 1:
      return "submitted";
    case 2:
      return "dispatched";
    case 3:
      return "settled";
    case 4:
      return "failed";
    case 5:
      return "cancelled";
    case 6:
      return "refunded";
    default:
      return `unknown:${value}`;
  }
}

async function readNativeBalance(address, rpcUrl) {
  return BigInt(await runCast(["balance", address, "--rpc-url", rpcUrl]));
}

async function readReceipt(txHash, rpcUrl) {
  const raw = await runCast(["receipt", txHash, "--rpc-url", rpcUrl, "--json"]);
  const receipt = JSON.parse(raw);
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  };
}

async function keccakUtf8(value) {
  return runCast(["keccak", value]);
}

async function sendCastTransaction({ to, signature, args, rpcUrl, privateKey }) {
  await execFileAsync(
    "cast",
    [
      "send",
      to,
      signature,
      ...args,
      "--rpc-url",
      rpcUrl,
      "--private-key",
      privateKey,
      "--json",
    ],
    {
      cwd: workspaceRoot,
      env: process.env,
    },
  );
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${url} failed with status ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function runCast(args) {
  const { stdout } = await execFileAsync("cast", args, {
    cwd: workspaceRoot,
    env: process.env,
  });
  return stdout.trim();
}

function readDeploymentArtifact(profile) {
  const path = resolve(
    workspaceRoot,
    "contracts",
    "polkadot-hub-router",
    "deployments",
    profile,
    "polkadot-hub.json",
  );
  if (!existsSync(path)) {
    throw new Error(`missing deployment artifact at ${path}`);
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required setting: ${name}`);
  }

  return value;
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(name in process.env)) {
      process.env[name] = value;
    }
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
