import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createExecuteIntent,
  createSwapIntent,
  createTransferIntent,
} from "../packages/xroute-intents/index.mjs";
import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
  createXRouteClient,
  NATIVE_ASSET_ADDRESS,
} from "../packages/xroute-sdk/index.mjs";
import {
  createCastRouterAdapter,
  createSourceAwareRouterAdapter,
  createSubstrateXcmAdapter,
} from "../packages/xroute-sdk/router-adapters.mjs";
import { FileBackedStatusIndexer } from "../packages/xroute-sdk/status-indexer.mjs";
import { resolveRouterAddressFromArtifact } from "./lib/deployment-artifacts.mjs";
import { spawnRustService } from "./lib/spawn-rust-service.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const proofsDir = resolve(workspaceRoot, ".xroute", "proofs");
const defaultRecipient = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const dryRun = process.argv.includes("--dry-run");
const deploymentProfile = process.env.XROUTE_PROOF_PROFILE?.trim() || "mainnet";
const proofLabel = "mainnet";

loadDotEnv(join(workspaceRoot, ".env"));

const settings = await resolveSettings();
const runtimeDir = mkdtempSync(join(tmpdir(), "xroute-mainnet-proof-"));
const statusEventsPath = join(runtimeDir, "sdk-status.ndjson");
const startedAt = new Date().toISOString();
const report = {
  ok: true,
  deploymentProfile,
  startedAt,
  mode: dryRun ? "dry-run" : "live",
  scenarios: [],
};

let quoteService;
let relayerService;

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

  report.quoteService = quoteService.url;
  report.relayerService = relayerService.url;
  report.quoteHealth = await requestJson(`${quoteService.url}/healthz`);
  report.relayerHealth = await requestJson(`${relayerService.url}/healthz`);

  const relayer = createHttpExecutorRelayerClient({
    endpoint: relayerService.url,
    authToken: settings.relayerAuthToken,
  });
  const statusProvider = new FileBackedStatusIndexer({
    eventsPath: statusEventsPath,
  });
  const routerAdapter = createSourceAwareRouterAdapter({
    adaptersByChain: await createSourceAdapters(settings, statusProvider),
  });
  const client = createXRouteClient({
    quoteProvider: createHttpQuoteProvider({
      endpoint: `${quoteService.url}/quote`,
      headers: {
        "x-xroute-deployment-profile": deploymentProfile,
      },
    }),
    routerAdapter,
    statusProvider,
    assetAddressResolver: async ({ chainKey, assetKey }) =>
      resolveAssetAddress({ chainKey, assetKey, settings }),
  });

  for (const scenario of buildScenarios(settings)) {
    report.scenarios.push(await runScenario({ scenario, settings, client, relayer }));
  }
} catch (error) {
  report.ok = false;
  report.fatalError = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  mkdirSync(proofsDir, { recursive: true });
  const reportPath = join(proofsDir, `${proofLabel}-${timestampLabel()}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await quoteService?.close();
  await relayerService?.close();
  rmSync(runtimeDir, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        reportPath,
        scenarios: report.scenarios.map((scenario) => ({
          name: scenario.name,
          status: scenario.status,
          reason: scenario.reason ?? null,
          route: scenario.route ?? null,
          intentId: scenario.intentId ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

async function runScenario({ scenario, settings, client, relayer }) {
  const base = {
    name: scenario.name,
    sourceChain: scenario.sourceChain,
    destinationChain: scenario.destinationChain,
  };

  if (dryRun) {
    return {
      ...base,
      status: "skipped",
      reason: "dry-run mode",
    };
  }

  if (scenario.missing.length > 0) {
    return {
      ...base,
      status: "skipped",
      reason: `missing required settings: ${scenario.missing.join(", ")}`,
    };
  }

  let submittedIntentId = null;

  try {
    const { intent, quote } = await client.quote(scenario.createIntent());
    const submitted = await client.submit({
      intent,
      quote,
      owner: scenario.owner ?? undefined,
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

    return {
      ...base,
      status: "completed",
      quoteId: quote.quoteId,
      intentId: submitted.intentId,
      route: quote.route,
      submission: {
        action: quote.submission.action,
        asset: quote.submission.asset,
        amount: quote.submission.amount.toString(),
        xcmFee: quote.submission.xcmFee.toString(),
        destinationFee: quote.submission.destinationFee.toString(),
      },
      expectedOutput: {
        asset: quote.expectedOutput.asset,
        amount: quote.expectedOutput.amount.toString(),
      },
      dispatch: {
        jobId: dispatchJob.id,
        txHash: dispatchJob.result.txHash,
        strategy: dispatchJob.result.strategy ?? null,
      },
      settle: {
        jobId: settleJob.id,
        txHash: settleJob.result.txHash,
      },
    };
  } catch (error) {
    if (submittedIntentId && scenario.cleanup) {
      await scenario.cleanup({ intentId: submittedIntentId, settings }).catch(() => {});
    }

    return {
      ...base,
      status: "failed",
      intentId: submittedIntentId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createSourceAdapters(settings, statusProvider) {
  const adapters = {};

  if (settings.moonbeam.ready) {
    adapters.moonbeam = createCastRouterAdapter({
      rpcUrl: settings.moonbeam.rpcUrl,
      routerAddress: settings.moonbeam.routerAddress,
      privateKey: settings.moonbeam.privateKey,
      ownerAddress: settings.moonbeam.ownerAddress,
      cwd: workspaceRoot,
      statusIndexer: statusProvider,
    });
  }

  if (settings.hydration.ready) {
    adapters.hydration = createSubstrateXcmAdapter({
      chainKey: "hydration",
      rpcUrl: settings.hydration.rpcUrl,
      privateKey: settings.hydration.privateKey,
      statusIndexer: statusProvider,
    });
  }

  if (settings.bifrost.ready) {
    adapters.bifrost = createSubstrateXcmAdapter({
      chainKey: "bifrost",
      rpcUrl: settings.bifrost.rpcUrl,
      privateKey: settings.bifrost.privateKey,
      statusIndexer: statusProvider,
    });
  }

  return adapters;
}

function buildScenarios(settings) {
  const moonbeamMissing = [];
  if (!settings.moonbeam.ready) {
    moonbeamMissing.push(...settings.moonbeam.missing);
  }
  if (!settings.moonbeam.dotAssetAddress) {
    moonbeamMissing.push(
      "XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS or XROUTE_MOONBEAM_DOT_ASSET_ADDRESS or XROUTE_MOONBEAM_DOT_IS_NATIVE=true",
    );
  }

  const hydrationMissing = [];
  if (!settings.hydration.ready) {
    hydrationMissing.push(...settings.hydration.missing);
  }

  const scenarios = [
    {
      name: "transfer moonbeam -> polkadot-hub -> hydration",
      sourceChain: "moonbeam",
      destinationChain: "hydration",
      missing: moonbeamMissing,
      owner: settings.moonbeam.ownerAddress,
      createIntent() {
        return createTransferIntent({
          deploymentProfile,
          sourceChain: "moonbeam",
          destinationChain: "hydration",
          refundAddress: settings.hub.ownerAddress,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          params: {
            asset: "DOT",
            amount: "250000000000",
            recipient: defaultRecipient,
          },
        });
      },
      cleanup: cleanupEvmSourceIntent,
    },
    {
      name: "swap moonbeam -> polkadot-hub -> hydration -> polkadot-hub",
      sourceChain: "moonbeam",
      destinationChain: "hydration",
      missing: moonbeamMissing,
      owner: settings.moonbeam.ownerAddress,
      createIntent() {
        return createSwapIntent({
          deploymentProfile,
          sourceChain: "moonbeam",
          destinationChain: "hydration",
          refundAddress: settings.hub.ownerAddress,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          params: {
            assetIn: "DOT",
            assetOut: "USDT",
            amountIn: "1000000000000",
            minAmountOut: "490000000",
            settlementChain: "polkadot-hub",
            recipient: defaultRecipient,
          },
        });
      },
      cleanup: cleanupEvmSourceIntent,
    },
    {
      name: "execute hydration -> polkadot-hub -> moonbeam",
      sourceChain: "hydration",
      destinationChain: "moonbeam",
      missing: hydrationMissing,
      createIntent() {
        return createExecuteIntent({
          deploymentProfile,
          sourceChain: "hydration",
          destinationChain: "moonbeam",
          refundAddress: settings.hub.ownerAddress,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          params: {
            executionType: "evm-contract-call",
            asset: "DOT",
            maxPaymentAmount: "200000000",
            contractAddress:
              process.env.XROUTE_MOONBEAM_EXECUTE_TARGET?.trim() ||
              "0x1111111111111111111111111111111111111111",
            calldata: process.env.XROUTE_MOONBEAM_EXECUTE_CALLDATA?.trim() || "0xdeadbeef",
            value: process.env.XROUTE_MOONBEAM_EXECUTE_VALUE?.trim() || "0",
            gasLimit: process.env.XROUTE_MOONBEAM_EXECUTE_GAS_LIMIT?.trim() || "250000",
            fallbackWeight: {
              refTime: 650000000,
              proofSize: 12288,
            },
          },
        });
      },
    },
  ];

  if (deploymentProfile === "mainnet") {
    const bifrostMissing = [];
    if (!settings.bifrost.ready) {
      bifrostMissing.push(...settings.bifrost.missing);
    }

    scenarios.push({
      name: "transfer bifrost -> polkadot-hub -> moonbeam",
      sourceChain: "bifrost",
      destinationChain: "moonbeam",
      missing: bifrostMissing,
      createIntent() {
        return createTransferIntent({
          deploymentProfile,
          sourceChain: "bifrost",
          destinationChain: "moonbeam",
          refundAddress: settings.hub.ownerAddress,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          params: {
            asset: "DOT",
            amount: "250000000000",
            recipient: defaultRecipient,
          },
        });
      },
    });
  }

  return scenarios;
}

function buildServiceEnv(settings, runtimeDir) {
  const env = {
    XROUTE_RPC_URL: settings.hub.rpcUrl,
    XROUTE_PRIVATE_KEY: settings.hub.privateKey,
    XROUTE_ROUTER_ADDRESS: settings.hub.routerAddress,
    XROUTE_RELAYER_AUTH_TOKEN: settings.relayerAuthToken,
    XROUTE_WORKSPACE_ROOT: workspaceRoot,
    XROUTE_QUOTE_PORT: "0",
    XROUTE_RELAYER_PORT: "0",
    XROUTE_RELAYER_JOB_STORE_PATH: join(runtimeDir, "relayer-jobs.json"),
    XROUTE_STATUS_EVENTS_PATH: join(runtimeDir, "relayer-events.ndjson"),
  };

  if (settings.moonbeam.ready) {
    env.XROUTE_MOONBEAM_RPC_URL = settings.moonbeam.rpcUrl;
    env.XROUTE_MOONBEAM_ROUTER_ADDRESS = settings.moonbeam.routerAddress;
    env.XROUTE_MOONBEAM_PRIVATE_KEY = settings.moonbeam.privateKey;
  }

  if (settings.hydration.ready) {
    env.XROUTE_HYDRATION_RPC_URL = settings.hydration.rpcUrl;
    env.XROUTE_HYDRATION_PRIVATE_KEY = settings.hydration.privateKey;
  }

  if (settings.bifrost.ready) {
    env.XROUTE_BIFROST_RPC_URL = settings.bifrost.rpcUrl;
    env.XROUTE_BIFROST_PRIVATE_KEY = settings.bifrost.privateKey;
  }

  forwardOptionalEnv(env, "XROUTE_XCM_ADDRESS");
  forwardOptionalEnv(env, "XROUTE_MOONBEAM_XCM_ADDRESS");
  forwardOptionalEnv(env, "XROUTE_LIVE_QUOTE_INPUTS_PATH");
  forwardOptionalEnv(env, "XROUTE_LIVE_QUOTE_INPUTS_COMMAND");
  forwardOptionalEnv(env, "XROUTE_LIVE_QUOTE_INPUTS_REFRESH_MS");
  forwardOptionalEnv(env, "XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN");

  return env;
}

function resolveAssetAddress({ chainKey, assetKey, settings }) {
  if (chainKey === "hydration" || chainKey === "bifrost") {
    return NATIVE_ASSET_ADDRESS;
  }

  if (chainKey === "moonbeam" && assetKey === "DOT") {
    if (settings.moonbeam.dotAssetAddress) {
      return settings.moonbeam.dotAssetAddress;
    }
    throw new Error(
      "missing XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS or XROUTE_MOONBEAM_DOT_ASSET_ADDRESS or XROUTE_MOONBEAM_DOT_IS_NATIVE=true",
    );
  }

  throw new Error(`unsupported source asset ${assetKey} on ${chainKey}`);
}

async function resolveSettings() {
  const hubPrivateKey = requireEnv("XROUTE_PRIVATE_KEY");
  const hubRouterAddress =
    process.env.XROUTE_ROUTER_ADDRESS?.trim() ||
    resolveRouterAddressFromArtifact({
      workspaceRoot,
      deploymentProfile,
      chainKey: "polkadot-hub",
    });
  const hubOwnerAddress =
    process.env.XROUTE_DEPLOYER_ADDRESS?.trim() ||
    (await runCast(["wallet", "address", "--private-key", hubPrivateKey]));

  const moonbeamPrivateKey =
    process.env.XROUTE_MOONBEAM_PRIVATE_KEY?.trim() || hubPrivateKey;
  const moonbeamRouterAddress =
    process.env.XROUTE_MOONBEAM_ROUTER_ADDRESS?.trim() ||
    resolveRouterAddressFromArtifact({
      workspaceRoot,
      deploymentProfile,
      chainKey: "moonbeam",
    });
  const moonbeamMissing = [];
  if (!process.env.XROUTE_MOONBEAM_RPC_URL?.trim()) {
    moonbeamMissing.push("XROUTE_MOONBEAM_RPC_URL");
  }
  if (!moonbeamRouterAddress) {
    moonbeamMissing.push(
      `XROUTE_MOONBEAM_ROUTER_ADDRESS or ${deploymentProfile} deployment artifact moonbeam.json`,
    );
  }

  const hydrationMissing = [];
  if (!process.env.XROUTE_HYDRATION_RPC_URL?.trim()) {
    hydrationMissing.push("XROUTE_HYDRATION_RPC_URL");
  }
  if (!process.env.XROUTE_HYDRATION_PRIVATE_KEY?.trim()) {
    hydrationMissing.push("XROUTE_HYDRATION_PRIVATE_KEY");
  }

  const bifrostMissing = [];
  if (!process.env.XROUTE_BIFROST_RPC_URL?.trim()) {
    bifrostMissing.push("XROUTE_BIFROST_RPC_URL");
  }
  if (!process.env.XROUTE_BIFROST_PRIVATE_KEY?.trim()) {
    bifrostMissing.push("XROUTE_BIFROST_PRIVATE_KEY");
  }

  return {
    relayerAuthToken: requireEnv("XROUTE_RELAYER_AUTH_TOKEN"),
    hub: {
      rpcUrl: requireEnv("XROUTE_RPC_URL"),
      privateKey: hubPrivateKey,
      routerAddress:
        hubRouterAddress ||
        requireEnv("XROUTE_ROUTER_ADDRESS"),
      ownerAddress: hubOwnerAddress,
    },
    moonbeam: {
      ready: moonbeamMissing.length === 0,
      missing: moonbeamMissing,
      rpcUrl: process.env.XROUTE_MOONBEAM_RPC_URL?.trim() || null,
      routerAddress: moonbeamRouterAddress,
      privateKey: moonbeamPrivateKey,
      ownerAddress: await runCast(["wallet", "address", "--private-key", moonbeamPrivateKey]),
      dotAssetAddress: resolveMoonbeamDotAssetAddress(),
    },
    hydration: {
      ready: hydrationMissing.length === 0,
      missing: hydrationMissing,
      rpcUrl: process.env.XROUTE_HYDRATION_RPC_URL?.trim() || null,
      privateKey: process.env.XROUTE_HYDRATION_PRIVATE_KEY?.trim() || null,
    },
    bifrost: {
      ready: bifrostMissing.length === 0,
      missing: bifrostMissing,
      rpcUrl: process.env.XROUTE_BIFROST_RPC_URL?.trim() || null,
      privateKey: process.env.XROUTE_BIFROST_PRIVATE_KEY?.trim() || null,
    },
  };
}

function resolveMoonbeamDotAssetAddress() {
  const explicit =
    process.env.XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS?.trim() ||
    process.env.XROUTE_MOONBEAM_DOT_ASSET_ADDRESS?.trim();
  if (explicit) {
    return explicit;
  }

  if (parseBool(process.env.XROUTE_MOONBEAM_DOT_IS_NATIVE ?? "false")) {
    return NATIVE_ASSET_ADDRESS;
  }

  return null;
}

async function cleanupEvmSourceIntent({ intentId, settings }) {
  await bestEffortCleanup({
    intentId,
    routerAddress: settings.moonbeam.routerAddress,
    rpcUrl: settings.moonbeam.rpcUrl,
    privateKey: settings.moonbeam.privateKey,
  });
}

async function bestEffortCleanup({ intentId, routerAddress, rpcUrl, privateKey }) {
  if (!intentId || !routerAddress || !rpcUrl || !privateKey) {
    return;
  }

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
    status: intentStatus(values[10]),
  };
}

function intentStatus(value) {
  switch (Number(value)) {
    case 1:
      return "submitted";
    case 4:
      return "failed";
    default:
      return `unknown:${value}`;
  }
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

function forwardOptionalEnv(target, name) {
  const value = process.env[name]?.trim();
  if (value) {
    target[name] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required setting: ${name}`);
  }

  return value;
}

function timestampLabel() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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
