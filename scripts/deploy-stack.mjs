import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEPLOYMENT_PROFILES, XCM_PRECOMPILE_ADDRESS, MOONBEAM_XCM_PRECOMPILE_ADDRESS } from "../packages/xroute-precompile-interfaces/index.mjs";
import { getRouterDeploymentArtifactPath } from "./lib/deployment-artifacts.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const contractRoot = resolve(workspaceRoot, "contracts/polkadot-hub-router");

export function deployStack(overrides = {}) {
  const deploymentProfile = DEPLOYMENT_PROFILES.MAINNET;
  const chainKey = resolveDeploymentChainKey(
    deploymentProfile,
    overrides.chainKey ?? process.env.XROUTE_DEPLOYMENT_CHAIN_KEY,
  );
  const rpcUrlEnvName = resolveRpcUrlEnvName(chainKey);

  assertLiveDeploymentConfirmed(
    overrides.allowLiveDeployment ?? process.env.XROUTE_ALLOW_LIVE_DEPLOY,
    deploymentProfile,
  );

  const rpcUrl = requiredSetting(rpcUrlEnvName, overrides.rpcUrl ?? process.env[rpcUrlEnvName]);
  const deployerPrivateKey = requiredSetting(
    "XROUTE_DEPLOYER_PRIVATE_KEY",
    overrides.deployerPrivateKey ?? process.env.XROUTE_DEPLOYER_PRIVATE_KEY,
  );
  const platformFeeBps =
    overrides.platformFeeBps ?? process.env.XROUTE_PLATFORM_FEE_BPS ?? "10";
  const xcmAddress =
    overrides.xcmAddress ?? process.env.XROUTE_XCM_ADDRESS ?? resolveDefaultXcmAddress(chainKey);
  const moonbeamXcBncAssetAddress =
    chainKey === "moonbeam"
      ? normalizeOptionalAddress(
          overrides.moonbeamXcBncAssetAddress ?? process.env.XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS,
          "XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS",
        )
      : null;
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
  const executorPrivateKeyEnvName = resolveExecutorPrivateKeyEnvName(chainKey);
  const executorPrivateKey = requiredSetting(
    executorPrivateKeyEnvName,
    overrides.executorPrivateKey ?? process.env[executorPrivateKeyEnvName],
  );
  const executorAddress = normalizeAddress(
    runCast(["wallet", "address", "--private-key", executorPrivateKey], {
      rpcUrl,
    }),
    executorPrivateKeyEnvName,
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
  const slpxAdapter = chainKey === "moonbeam"
    ? deployMoonbeamSlpxAdapter({
        rpcUrl,
        deployerPrivateKey,
        moonbeamXcDotAssetAddress:
          overrides.moonbeamXcDotAssetAddress ??
          process.env.XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS,
        moonbeamVdotAssetAddress:
          overrides.moonbeamVdotAssetAddress ??
          process.env.XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS,
        moonbeamSlpxAddress:
          overrides.moonbeamSlpxAddress ??
          process.env.XROUTE_MOONBEAM_SLPX_ADDRESS,
        destinationChainId:
          overrides.destinationChainId ??
          process.env.XROUTE_MOONBEAM_SLPX_DEST_CHAIN_ID ??
          "1284",
      })
    : null;

  const deploymentArtifact = {
    deploymentProfile,
    chainKey,
    chainId,
    deployer,
    deployedAt: new Date().toISOString(),
    contracts: {
      XRouteHubRouter: routerAddress,
      ...(slpxAdapter ? { XRouteMoonbeamSlpxAdapter: slpxAdapter.adapterAddress } : {}),
    },
    settings: {
      adminAddress: deployer,
      xcmAddress,
      executorAddress,
      treasuryAddress,
      platformFeeBps: String(platformFeeBps),
      ...(slpxAdapter
        ? {
            moonbeamSlpxAddress: slpxAdapter.slpxAddress,
            moonbeamXcDotAssetAddress: slpxAdapter.dotAssetAddress,
            moonbeamVdotAssetAddress: slpxAdapter.vdotAssetAddress,
            moonbeamSlpxDestinationChainId: String(slpxAdapter.destinationChainId),
          }
        : {}),
      ...(moonbeamXcBncAssetAddress
        ? {
            moonbeamXcBncAssetAddress,
          }
        : {}),
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
    slpxAdapterAddress: slpxAdapter?.adapterAddress ?? null,
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
    env: process.env,
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

function resolveRpcUrlEnvName(chainKey) {
  switch (chainKey) {
    case "polkadot-hub":
      return "XROUTE_HUB_RPC_URL";
    case "moonbeam":
      return "XROUTE_MOONBEAM_RPC_URL";
    default:
      throw new Error(`unsupported deployment chain key: ${chainKey}`);
  }
}

function resolveDefaultXcmAddress(chainKey) {
  switch (chainKey) {
    case "moonbeam":
      return MOONBEAM_XCM_PRECOMPILE_ADDRESS;
    default:
      return XCM_PRECOMPILE_ADDRESS;
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

function normalizeOptionalAddress(value, name) {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    return null;
  }

  return normalizeAddress(normalized, name);
}

function resolveExecutorPrivateKeyEnvName(chainKey) {
  switch (chainKey) {
    case "polkadot-hub":
      return "XROUTE_HUB_PRIVATE_KEY";
    case "moonbeam":
      return "XROUTE_MOONBEAM_PRIVATE_KEY";
    default:
      throw new Error(`unsupported deployment chain key: ${chainKey}`);
  }
}

function deployMoonbeamSlpxAdapter({
  rpcUrl,
  deployerPrivateKey,
  moonbeamXcDotAssetAddress,
  moonbeamVdotAssetAddress,
  moonbeamSlpxAddress,
  destinationChainId,
}) {
  const slpxAddress = normalizeAddress(
    requiredSetting("XROUTE_MOONBEAM_SLPX_ADDRESS", moonbeamSlpxAddress),
    "XROUTE_MOONBEAM_SLPX_ADDRESS",
  );
  const dotAssetAddress = normalizeAddress(
    requiredSetting("XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS", moonbeamXcDotAssetAddress),
    "XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS",
  );
  const vdotAssetAddress = normalizeAddress(
    requiredSetting("XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS", moonbeamVdotAssetAddress),
    "XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS",
  );
  const normalizedDestinationChainId = Number.parseInt(
    requiredSetting("XROUTE_MOONBEAM_SLPX_DEST_CHAIN_ID", String(destinationChainId)),
    10,
  );
  if (!Number.isInteger(normalizedDestinationChainId) || normalizedDestinationChainId <= 0) {
    throw new Error("invalid XROUTE_MOONBEAM_SLPX_DEST_CHAIN_ID");
  }

  return {
    adapterAddress: deployContract(
      "src/XRouteMoonbeamSlpxAdapter.sol:XRouteMoonbeamSlpxAdapter",
      [
        slpxAddress,
        dotAssetAddress,
        vdotAssetAddress,
        String(normalizedDestinationChainId),
      ],
      {
        rpcUrl,
        privateKey: deployerPrivateKey,
      },
    ),
    slpxAddress,
    dotAssetAddress,
    vdotAssetAddress,
    destinationChainId: normalizedDestinationChainId,
  };
}

function assertSeparatedOperationalAddresses({
  deployer,
  executorAddress,
  treasuryAddress,
}) {
  if (executorAddress === deployer) {
    throw new Error("router executor must not match the deployer/admin address");
  }

  if (treasuryAddress === deployer) {
    throw new Error("XROUTE_ROUTER_TREASURY must not match the deployer/admin address");
  }

  if (treasuryAddress === executorAddress) {
    throw new Error("XROUTE_ROUTER_TREASURY must not match the router executor address");
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(deployStack(), null, 2));
}
