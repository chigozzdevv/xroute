import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEPLOYMENT_PROFILES,
  normalizeDeploymentProfile,
} from "../packages/xroute-precompile-interfaces/index.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const contractRoot = resolve(workspaceRoot, "contracts/polkadot-hub-router");
const defaultArtifactPath = resolve(
  contractRoot,
  "deployments",
  DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  "moonbeam-validation-target.json",
);
const defaultPolicyPath = resolve(
  contractRoot,
  "deployments",
  DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  "moonbeam-execution-policy.json",
);

export function deployMoonbaseValidationTarget(overrides = {}) {
  const deploymentProfile = normalizeDeploymentProfile(
    overrides.deploymentProfile ??
      process.env.XROUTE_DEPLOYMENT_PROFILE ??
      DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  );
  if (deploymentProfile !== DEPLOYMENT_PROFILES.MOONBASE_ALPHA) {
    throw new Error(
      `deploy-moonbase-validation-target only supports ${DEPLOYMENT_PROFILES.MOONBASE_ALPHA}, received ${deploymentProfile}`,
    );
  }

  assertLiveDeploymentConfirmed(
    overrides.allowLiveDeployment ?? process.env.XROUTE_ALLOW_LIVE_DEPLOY,
    deploymentProfile,
  );

  const rpcUrl = requiredSetting("XROUTE_RPC_URL", overrides.rpcUrl ?? process.env.XROUTE_RPC_URL);
  const privateKey = requiredSetting(
    "XROUTE_PRIVATE_KEY",
    overrides.privateKey ?? process.env.XROUTE_PRIVATE_KEY,
  );
  const artifactPath =
    overrides.artifactPath ?? process.env.XROUTE_MOONBASE_TARGET_ARTIFACT_PATH ?? defaultArtifactPath;
  const policyPath =
    overrides.policyPath ?? process.env.XROUTE_EVM_POLICY_PATH ?? defaultPolicyPath;
  const maxGasLimit = String(
    overrides.maxGasLimit ?? process.env.XROUTE_MOONBASE_MAX_GAS_LIMIT ?? "250000",
  ).trim();
  const maxPaymentAmount = String(
    overrides.maxPaymentAmount ?? process.env.XROUTE_MOONBASE_MAX_PAYMENT_AMOUNT ?? "200000000",
  ).trim();
  const maxValue = String(
    overrides.maxValue ?? process.env.XROUTE_MOONBASE_MAX_VALUE ?? "0",
  ).trim();

  const deployer = runCast(["wallet", "address", "--private-key", privateKey], { rpcUrl });
  const chainId = Number(runCast(["chain-id", "--rpc-url", rpcUrl], { rpcUrl }));
  const contractAddress = deployContract("src/MoonbaseValidationTarget.sol:MoonbaseValidationTarget", {
    rpcUrl,
    privateKey,
  });
  const selector = runCast(["sig", "ping(bytes32)"], { rpcUrl }).trim().toLowerCase();

  const artifact = {
    deploymentProfile,
    chainKey: "moonbeam",
    chainId,
    deployer,
    deployedAt: new Date().toISOString(),
    contracts: {
      MoonbaseValidationTarget: contractAddress,
    },
    settings: {
      selector,
      maxGasLimit,
      maxPaymentAmount,
      maxValue,
    },
  };

  const policy = {
    moonbeam: {
      evmContractCall: {
        allowedContracts: [
          {
            address: contractAddress,
            selectors: [selector],
            maxValue,
            maxGasLimit: Number(maxGasLimit),
            maxPaymentAmount,
            note: "Moonbase Alpha validation target",
          },
        ],
      },
    },
  };

  writeJson(artifactPath, artifact);
  writeJson(policyPath, policy);

  return {
    ...artifact,
    artifactPath,
    policyPath,
  };
}

function deployContract(contractId, { rpcUrl, privateKey }) {
  const output = execFileSync(
    "forge",
    [
      "create",
      contractId,
      "--root",
      contractRoot,
      "--rpc-url",
      rpcUrl,
      "--private-key",
      privateKey,
      "--broadcast",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(deployMoonbaseValidationTarget(), null, 2));
}
