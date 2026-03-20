import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTransferIntent } from "../packages/xroute-intents/index.mjs";
import { createConfiguredXRouteClient } from "../packages/xroute-sdk/internal.mjs";
import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
  normalizeQuote,
} from "../packages/xroute-sdk/internal/http.mjs";
import { FileBackedStatusIndexer } from "../packages/xroute-sdk/internal/status.mjs";
import {
  createCastRouterAdapter,
  createSourceAwareRouterAdapter,
} from "../packages/xroute-sdk/routers/router-adapters.mjs";
import { spawnRustService } from "./lib/spawn-rust-service.mjs";
import { resolveRouterAddressFromArtifact } from "./lib/deployment-artifacts.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(resolve(workspaceRoot, ".env"));

const runtimeDir = mkdtempSync(join(tmpdir(), "xroute-live-debug-"));
const statusEventsPath = join(runtimeDir, "sdk-status.ndjson");

const moonbeamPrivateKey = requireEnv("XROUTE_MOONBEAM_PRIVATE_KEY");
const moonbeamRpcUrl = requireEnv("XROUTE_MOONBEAM_RPC_URL");
const hubPrivateKey = requireEnv("XROUTE_HUB_PRIVATE_KEY");
const hubRpcUrl = requireEnv("XROUTE_HUB_RPC_URL");
const relayerAuthToken = process.env.XROUTE_RELAYER_AUTH_TOKEN?.trim() || "xroute-local-dev";
const moonbeamRouterAddress =
  process.env.XROUTE_MOONBEAM_ROUTER_ADDRESS?.trim()
  || resolveRouterAddressFromArtifact({
    workspaceRoot,
    deploymentProfile: "mainnet",
    chainKey: "moonbeam",
  });
const hubRouterAddress =
  process.env.XROUTE_ROUTER_ADDRESS?.trim()
  || resolveRouterAddressFromArtifact({
    workspaceRoot,
    deploymentProfile: "mainnet",
    chainKey: "polkadot-hub",
  });

if (!moonbeamRouterAddress) {
  throw new Error("missing moonbeam router address");
}
if (!hubRouterAddress) {
  throw new Error("missing polkadot-hub router address");
}

const serviceEnv = {
  XROUTE_WORKSPACE_ROOT: workspaceRoot,
  XROUTE_HUB_RPC_URL: hubRpcUrl,
  XROUTE_HUB_PRIVATE_KEY: hubPrivateKey,
  XROUTE_ROUTER_ADDRESS: hubRouterAddress,
  XROUTE_MOONBEAM_RPC_URL: moonbeamRpcUrl,
  XROUTE_MOONBEAM_PRIVATE_KEY: moonbeamPrivateKey,
  XROUTE_MOONBEAM_ROUTER_ADDRESS: moonbeamRouterAddress,
  XROUTE_RELAYER_AUTH_TOKEN: relayerAuthToken,
  XROUTE_API_PORT: "0",
  XROUTE_QUOTE_PORT: "0",
  XROUTE_RELAYER_PORT: "0",
  XROUTE_RELAYER_JOB_STORE_PATH: join(runtimeDir, "relayer-jobs.json"),
  XROUTE_STATUS_EVENTS_PATH: join(runtimeDir, "relayer-events.ndjson"),
};

forwardOptionalEnv(serviceEnv, "XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS");
forwardOptionalEnv(serviceEnv, "XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS");
forwardOptionalEnv(serviceEnv, "XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS");
forwardOptionalEnv(serviceEnv, "XROUTE_LIVE_QUOTE_INPUTS_PATH");
serviceEnv.XROUTE_LIVE_QUOTE_INPUTS_COMMAND =
  `node ${resolve(workspaceRoot, "scripts/fetch-live-quote-inputs.mjs")}`;
forwardOptionalEnv(serviceEnv, "XROUTE_LIVE_QUOTE_INPUTS_REFRESH_MS");
forwardOptionalEnv(serviceEnv, "XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN");

let apiService;

try {
  apiService = await spawnRustService({
    packageName: "xroute-api",
    cwd: workspaceRoot,
    env: serviceEnv,
  });

  const statusProvider = new FileBackedStatusIndexer({
    eventsPath: statusEventsPath,
  });
  const routerAdapter = createSourceAwareRouterAdapter({
    adaptersByChain: {
      moonbeam: createCastRouterAdapter({
        rpcUrl: moonbeamRpcUrl,
        routerAddress: moonbeamRouterAddress,
        privateKey: moonbeamPrivateKey,
        ownerAddress: "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
        cwd: workspaceRoot,
        statusIndexer: statusProvider,
      }),
    },
  });
  const client = createConfiguredXRouteClient({
    quoteProvider: createHttpQuoteProvider({
      endpoint: `${apiService.url}/quote`,
      headers: {
        "x-xroute-deployment-profile": "mainnet",
      },
    }),
    routerAdapter,
    statusProvider,
    assetAddressResolver: async ({ chainKey, assetKey }) => {
      if (chainKey === "moonbeam" && assetKey === "DOT") {
        return requireEnv("XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS");
      }
      throw new Error(`unsupported source asset ${assetKey} on ${chainKey}`);
    },
  });
  const relayer = createHttpExecutorRelayerClient({
    endpoint: apiService.url,
    authToken: relayerAuthToken,
  });

  console.log("api", apiService.url);
  console.log("stage", "quote:start");
  const intent = createTransferIntent({
    deploymentProfile: "mainnet",
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    refundAddress: "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    params: {
      asset: "DOT",
      amount: "100000000",
      recipient: "12hEyt1RjSsnFTYrht4aaa2aatUHK47cHyz2Ptdi6PyAiJay",
    },
  });
  const { intent: quotedIntent, quote } = await client.quote(intent);
  const normalizedQuote = normalizeQuote(quote);
  console.log("stage", "quote:done", normalizedQuote.quoteId);
  console.log("stage", "submit:start");
  const submitted = await client.submit({
    intent: quotedIntent,
    quote: normalizedQuote,
    owner: "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
  });
  console.log("stage", "submit:done", submitted.intentId);
  console.log("stage", "dispatch:start");
  const dispatchQueued = await relayer.dispatch({
    intentId: submitted.intentId,
    intent: quotedIntent,
    quote: normalizedQuote,
    owner: "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
  });
  console.log("stage", "dispatch:queued", dispatchQueued.job.id);
  const dispatchJob = await waitForJob(relayer, dispatchQueued.job.id);
  console.log("stage", "dispatch:finished", dispatchJob.status);

  process.stdout.write(
    `${JSON.stringify({
      api: apiService.url,
      intentId: submitted.intentId,
      dispatchJobId: dispatchJob.id,
      dispatchStatus: dispatchJob.status,
      dispatchResult: dispatchJob.result,
      dispatchError: dispatchJob.error,
    }, null, 2)}\n`,
  );
} finally {
  await apiService?.close();
  rmSync(runtimeDir, { recursive: true, force: true });
}

async function waitForJob(relayer, jobId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await relayer.getJob(jobId);
    if (job?.status === "completed" || job?.status === "failed") {
      return job;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing environment variable ${name}`);
  }
  return value;
}

function forwardOptionalEnv(target, name) {
  const value = process.env[name]?.trim();
  if (value) {
    target[name] = value;
  }
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
