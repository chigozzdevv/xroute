import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getHubDeploymentArtifactPath,
  loadHubDeploymentArtifact,
} from "../deployments.mjs";

test("loadHubDeploymentArtifact reads the hub deployment manifest", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "xroute-deployments-"));
  const artifactPath = getHubDeploymentArtifactPath({
    workspaceRoot: tempRoot,
    deploymentProfile: "testnet",
  });

  mkdirSync(join(tempRoot, "contracts/polkadot-hub-router/deployments/testnet"), {
    recursive: true,
  });
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        deploymentProfile: "testnet",
        chainKey: "polkadot-hub",
        deployer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        chainId: 420420,
        contracts: {
          XRouteHubRouter: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        settings: {
          xcmAddress: "0x00000000000000000000000000000000000a0000",
          executorAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
          treasuryAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
        },
      },
      null,
      2,
    ),
  );

  try {
    const deployment = loadHubDeploymentArtifact({
      workspaceRoot: tempRoot,
      deploymentProfile: "testnet",
    });

    assert.equal(deployment.deploymentProfile, "testnet");
    assert.equal(deployment.chainId, 420420);
    assert.equal(deployment.routerAddress, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(deployment.chainKey, "polkadot-hub");
    assert.equal(deployment.executorAddress, "0xcccccccccccccccccccccccccccccccccccccccc");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
