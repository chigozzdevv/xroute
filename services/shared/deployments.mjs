import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPLOYMENT_PROFILES,
  normalizeDeploymentProfile,
} from "../../packages/xroute-precompile-interfaces/index.mjs";
import { assertNonEmptyString } from "../../packages/xroute-types/index.mjs";

const sharedDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(sharedDir, "../..");

export function resolveWorkspaceRoot(input = process.env.XROUTE_WORKSPACE_ROOT) {
  const normalized = String(input ?? "").trim();
  return normalized === "" ? defaultWorkspaceRoot : normalized;
}

export function getHubDeploymentArtifactPath({
  workspaceRoot = resolveWorkspaceRoot(),
  deploymentProfile = DEPLOYMENT_PROFILES.TESTNET,
} = {}) {
  return resolve(
    workspaceRoot,
    "contracts/polkadot-hub-router/deployments",
    normalizeDeploymentProfile(deploymentProfile),
    "polkadot-hub.json",
  );
}

export function loadHubDeploymentArtifact({
  workspaceRoot = resolveWorkspaceRoot(),
  deploymentProfile = DEPLOYMENT_PROFILES.TESTNET,
  artifactPath = getHubDeploymentArtifactPath({ workspaceRoot, deploymentProfile }),
} = {}) {
  const raw = JSON.parse(readFileSync(artifactPath, "utf8"));
  const profile = normalizeDeploymentProfile(
    raw.deploymentProfile ?? deploymentProfile,
  );
  const routerAddress = assertNonEmptyString(
    "deployment.contracts.XRouteHubRouter",
    raw.contracts?.XRouteHubRouter,
  );

  return Object.freeze({
    artifactPath,
    deploymentProfile: profile,
    chainKey: raw.chainKey ?? "polkadot-hub",
    chainId: raw.chainId ?? null,
    deployer: raw.deployer ?? null,
    deployedAt: raw.deployedAt ?? null,
    routerAddress,
    xcmAddress: raw.settings?.xcmAddress ?? null,
    executorAddress: raw.settings?.executorAddress ?? null,
    treasuryAddress: raw.settings?.treasuryAddress ?? null,
    raw,
  });
}
