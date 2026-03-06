import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  DEPLOYMENT_PROFILES,
  DESTINATION_ADAPTER_DEPLOYMENTS,
  DESTINATION_ADAPTER_SPECS,
  DESTINATION_TRANSACT_DISPATCH,
  DESTINATION_ADAPTER_TARGET_KINDS,
  getDestinationAdapterDeployment,
  getDestinationAdapterSpec,
} from "../index.mjs";

test("destination adapter specs are published with supported target kinds", () => {
  const swap = getDestinationAdapterSpec("hydration-swap-v1");

  assert.equal(swap.id, "hydration-swap-v1");
  assert.equal(swap.targetKind, DESTINATION_ADAPTER_TARGET_KINDS.EVM_CONTRACT);
  assert.equal(swap.implementationContract, "HydrationSwapAdapterV1");
  assert.equal(swap.selector, "0x670b1f29");
});

test("destination adapter selectors match their published function signatures", () => {
  for (const spec of Object.values(DESTINATION_ADAPTER_SPECS)) {
    const selector = execFileSync("cast", ["sig", spec.signature], {
      encoding: "utf8",
    }).trim();

    assert.equal(selector, spec.selector, `${spec.id} selector drifted from ${spec.signature}`);
  }
});

test("destination adapter deployments are published per chain and profile", () => {
  const local = getDestinationAdapterDeployment(
    "hydration-swap-v1",
    "hydration",
    DEPLOYMENT_PROFILES.LOCAL,
  );
  const testnet = getDestinationAdapterDeployment(
    "hydration-swap-v1",
    "hydration",
    DEPLOYMENT_PROFILES.TESTNET,
  );
  const mainnet = getDestinationAdapterDeployment(
    "hydration-call-v1",
    "hydration",
    DEPLOYMENT_PROFILES.MAINNET,
  );

  assert.match(local.address, /^0x[0-9a-f]{40}$/);
  assert.match(testnet.address, /^0x[0-9a-f]{40}$/);
  assert.match(mainnet.address, /^0x[0-9a-f]{40}$/);
  assert.notEqual(local.address, testnet.address);
  assert.equal(
    DESTINATION_ADAPTER_DEPLOYMENTS["hydration-stake-v1:hydration:testnet"].chainKey,
    "hydration",
  );
});

test("destination transact dispatcher selector matches the published signature", () => {
  const selector = execFileSync("cast", ["sig", DESTINATION_TRANSACT_DISPATCH.signature], {
    encoding: "utf8",
  }).trim();

  assert.equal(selector, DESTINATION_TRANSACT_DISPATCH.selector);
});
