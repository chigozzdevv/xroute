import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function getRouterDeploymentArtifactPath({
  workspaceRoot,
  deploymentProfile,
  chainKey,
}) {
  return resolve(
    workspaceRoot,
    "contracts",
    "polkadot-hub-router",
    "deployments",
    deploymentProfile,
    `${chainKey}.json`,
  );
}

export function getRouterDeploymentArtifactCandidatePaths({
  workspaceRoot,
  deploymentProfile,
  chainKey,
}) {
  return [
    getRouterDeploymentArtifactPath({
      workspaceRoot,
      deploymentProfile,
      chainKey,
    }),
  ];
}

export function readRouterDeploymentArtifact({
  workspaceRoot,
  deploymentProfile,
  chainKey,
}) {
  for (const artifactPath of getRouterDeploymentArtifactCandidatePaths({
    workspaceRoot,
    deploymentProfile,
    chainKey,
  })) {
    if (!existsSync(artifactPath)) {
      continue;
    }

    return {
      artifactPath,
      artifact: JSON.parse(readFileSync(artifactPath, "utf8")),
    };
  }

  return null;
}

export function resolveRouterAddressFromArtifact({
  workspaceRoot,
  deploymentProfile,
  chainKey,
}) {
  const loaded = readRouterDeploymentArtifact({
    workspaceRoot,
    deploymentProfile,
    chainKey,
  });
  return loaded?.artifact?.contracts?.XRouteHubRouter ?? null;
}
