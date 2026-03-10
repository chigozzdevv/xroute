import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { spawnRustService } from "./lib/spawn-rust-service.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const selector = "0x33d425c4";
const payload =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

loadDotEnv(join(workspaceRoot, ".env"));

const settings = resolveSettings();
const policyPath = resolve(
  workspaceRoot,
  "contracts/polkadot-hub-router/deployments/moonbase-alpha/moonbeam-execution-policy.json",
);
const targetArtifactPath = resolve(
  workspaceRoot,
  "contracts/polkadot-hub-router/deployments/moonbase-alpha/moonbeam-validation-target.json",
);

let quoteService;
let relayerService;

try {
  const targetArtifact = readJson(targetArtifactPath);
  const targetAddress = targetArtifact.contracts?.MoonbaseValidationTarget;
  if (!targetAddress) {
    throw new Error(`missing MoonbaseValidationTarget in ${targetArtifactPath}`);
  }

  const pingTxHash = await sendPing(targetAddress, settings);
  const targetState = await readTargetState(targetAddress, settings.rpcUrl);

  const serviceEnv = {
    XROUTE_DEPLOYMENT_PROFILE: "moonbase-alpha",
    XROUTE_RPC_URL: settings.rpcUrl,
    XROUTE_PRIVATE_KEY: settings.privateKey,
    XROUTE_ROUTER_ADDRESS: settings.routerAddress,
    XROUTE_RELAYER_AUTH_TOKEN: settings.relayerAuthToken,
    XROUTE_EVM_POLICY_PATH: policyPath,
    XROUTE_WORKSPACE_ROOT: workspaceRoot,
    XROUTE_QUOTE_PORT: "0",
    XROUTE_RELAYER_PORT: "0",
  };

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

  const [quoteHealth, relayerHealth, quoteResponse] = await Promise.all([
    requestJson(`${quoteService.url}/healthz`),
    requestJson(`${relayerService.url}/healthz`),
    requestJson(`${quoteService.url}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xroute-deployment-profile": "moonbase-alpha",
      },
      body: JSON.stringify({
        intent: {
          sourceChain: "polkadot-hub",
          destinationChain: "moonbeam",
          refundAddress: settings.deployerAddress,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          action: {
            type: "execute",
            params: {
              executionType: "evm-contract-call",
              asset: "DOT",
              maxPaymentAmount: "200000000",
              contractAddress: targetAddress,
              calldata: `${selector}${payload.slice(2)}`,
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
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        deploymentProfile: "moonbase-alpha",
        routerAddress: settings.routerAddress,
        targetAddress,
        policyPath,
        pingTxHash,
        targetState,
        quoteService: quoteService.url,
        relayerService: relayerService.url,
        quoteHealth,
        relayerHealth,
        quoteResponse,
      },
      null,
      2,
    ),
  );
} finally {
  await quoteService?.close();
  await relayerService?.close();
}

function resolveSettings() {
  return {
    rpcUrl: "https://rpc.api.moonbase.moonbeam.network",
    privateKey: requireEnv("XROUTE_PRIVATE_KEY"),
    deployerAddress: requireEnv("XROUTE_DEPLOYER_ADDRESS"),
    routerAddress:
      process.env.XROUTE_MOONBASE_ROUTER_ADDRESS?.trim() ||
      readJson(
        resolve(
          workspaceRoot,
          "contracts/polkadot-hub-router/deployments/moonbase-alpha/polkadot-hub.json",
        ),
      ).contracts?.XRouteHubRouter,
    relayerAuthToken: requireEnv("XROUTE_RELAYER_AUTH_TOKEN"),
  };
}

async function sendPing(targetAddress, settings) {
  const { stdout } = await execFileAsync(
    "cast",
    [
      "send",
      targetAddress,
      "ping(bytes32)",
      payload,
      "--rpc-url",
      settings.rpcUrl,
      "--private-key",
      settings.privateKey,
      "--json",
    ],
    {
      cwd: workspaceRoot,
      env: process.env,
    },
  );
  const receipt = JSON.parse(stdout);
  if (receipt.status !== "0x1") {
    throw new Error(`moonbase target ping failed with status ${receipt.status}`);
  }

  return receipt.transactionHash;
}

async function readTargetState(targetAddress, rpcUrl) {
  const [pingCount, lastCaller, lastPayload] = await Promise.all([
    runCastCall(targetAddress, "pingCount()(uint256)", rpcUrl),
    runCastCall(targetAddress, "lastCaller()(address)", rpcUrl),
    runCastCall(targetAddress, "lastPayload()(bytes32)", rpcUrl),
  ]);

  return {
    pingCount,
    lastCaller,
    lastPayload,
  };
}

async function runCastCall(targetAddress, signature, rpcUrl) {
  const { stdout } = await execFileAsync(
    "cast",
    ["call", targetAddress, signature, "--rpc-url", rpcUrl],
    {
      cwd: workspaceRoot,
      env: process.env,
    },
  );

  return stdout.trim();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${url} failed with status ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
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

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required setting: ${name}`);
  }

  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
