import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEPLOYMENT_PROFILES, XCM_PRECOMPILE_ADDRESS } from "../packages/xroute-precompile-interfaces/index.mjs";
import { getRouterDeploymentArtifactPath } from "./lib/deployment-artifacts.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const contractRoot = resolve(workspaceRoot, "contracts/polkadot-hub-router");

export function deployStack(overrides = {}) {
  const deploymentProfile = DEPLOYMENT_PROFILES.MAINNET;

  assertLiveDeploymentConfirmed(
    overrides.allowLiveDeployment ?? process.env.XROUTE_ALLOW_LIVE_DEPLOY,
    deploymentProfile,
  );

  const rpcUrl = requiredSetting("XROUTE_RPC_URL", overrides.rpcUrl ?? process.env.XROUTE_RPC_URL);
  const deployerPrivateKey = requiredSetting(
    "XROUTE_DEPLOYER_PRIVATE_KEY",
    overrides.deployerPrivateKey ?? process.env.XROUTE_DEPLOYER_PRIVATE_KEY,
  );
  const platformFeeBps =
    overrides.platformFeeBps ?? process.env.XROUTE_PLATFORM_FEE_BPS ?? "10";
  const xcmAddress =
    overrides.xcmAddress ?? process.env.XROUTE_XCM_ADDRESS ?? XCM_PRECOMPILE_ADDRESS;
  const chainKey = resolveDeploymentChainKey(
    deploymentProfile,
    overrides.chainKey ?? process.env.XROUTE_DEPLOYMENT_CHAIN_KEY,
  );
  const stackOutputPath =
    overrides.stackOutputPath ??
    process.env.XROUTE_STACK_OUTPUT_PATH ??
    getRouterDeploymentArtifactPath({
      workspaceRoot,
      deploymentProfile,
      chainKey,
    });

  const deployer = runCast(["wallet", "address", "--private-key", deployerPrivateKey], {
    rpcUrl,
  });
  const chainId = Number(
    runCast(["chain-id", "--rpc-url", rpcUrl], {
      rpcUrl,
    }),
  );
  const executorAddress = normalizeAddress(
    requiredSetting(
      "XROUTE_ROUTER_EXECUTOR",
      overrides.executorAddress ?? process.env.XROUTE_ROUTER_EXECUTOR,
    ),
    "XROUTE_ROUTER_EXECUTOR",
  );
  const treasuryAddress = normalizeAddress(
    requiredSetting(
      "XROUTE_ROUTER_TREASURY",
      overrides.treasuryAddress ?? process.env.XROUTE_ROUTER_TREASURY,
    ),
    "XROUTE_ROUTER_TREASURY",
  );
  assertSeparatedOperationalAddresses({
    deployer,
    executorAddress,
    treasuryAddress,
  });
  const routerAddress = deployContract("src/XRouteHubRouter.sol:XRouteHubRouter", [
    xcmAddress,
    executorAddress,
    treasuryAddress,
    platformFeeBps,
  ], {
    rpcUrl,
    privateKey: deployerPrivateKey,
  });

  const deploymentArtifact = {
    deploymentProfile,
    chainKey,
    chainId,
    deployer,
    deployedAt: new Date().toISOString(),
    contracts: {
      XRouteHubRouter: routerAddress,
    },
    settings: {
      adminAddress: deployer,
      xcmAddress,
      executorAddress,
      treasuryAddress,
      platformFeeBps: String(platformFeeBps),
    },
  };

  const deploymentSummary = {
    ...deploymentArtifact,
    rpcUrl,
    chainId,
    routerAddress,
    xcmAddress,
    adminAddress: deployer,
    executorAddress,
    treasuryAddress,
    artifactPath: stackOutputPath,
  };

  writeJson(stackOutputPath, deploymentArtifact);

  return deploymentSummary;
}

function deployContract(contractId, constructorArgs = [], { rpcUrl, privateKey }) {
  const args = [
    "create",
    contractId,
    "--root",
    contractRoot,
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKey,
    "--broadcast",
  ];

  if (constructorArgs.length > 0) {
    args.push("--constructor-args", ...constructorArgs);
  }

  const output = execFileSync("forge", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error(`failed to parse deployed address for ${contractId}\n${output}`);
  }

  return match[1].toLowerCase();
}

function runCast(args, { rpcUrl }) {
  return execFileSync("cast", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      XROUTE_RPC_URL: rpcUrl,
    },
  }).trim();
}

function resolveDeploymentChainKey(deploymentProfile, requestedChainKey) {
  const normalizedRequestedChainKey = String(requestedChainKey ?? "").trim().toLowerCase();
  if (normalizedRequestedChainKey) {
    if (!["polkadot-hub", "moonbeam"].includes(normalizedRequestedChainKey)) {
      throw new Error(
        `unsupported deployment chain key: ${normalizedRequestedChainKey}`,
      );
    }
    return normalizedRequestedChainKey;
  }

  switch (deploymentProfile) {
    default:
      return "polkadot-hub";
  }
}

function assertLiveDeploymentConfirmed(flag, deploymentProfile) {
  if (String(flag ?? "").trim().toLowerCase() !== "true") {
    throw new Error(
      `refusing to deploy to ${deploymentProfile} without XROUTE_ALLOW_LIVE_DEPLOY=true`,
    );
  }
}

function requiredSetting(name, value) {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    throw new Error(`missing required setting: ${name}`);
  }

  return normalized;
}

function normalizeAddress(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`invalid address for ${name}`);
  }

  return normalized;
}

function assertSeparatedOperationalAddresses({ deployer, executorAddress, treasuryAddress }) {
  if (executorAddress === deployer) {
    throw new Error("XROUTE_ROUTER_EXECUTOR must not match the deployer/admin address");
  }

  if (treasuryAddress === deployer) {
    throw new Error("XROUTE_ROUTER_TREASURY must not match the deployer/admin address");
  }

  if (treasuryAddress === executorAddress) {
    throw new Error("XROUTE_ROUTER_TREASURY must not match XROUTE_ROUTER_EXECUTOR");
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(deployStack(), null, 2));
}
