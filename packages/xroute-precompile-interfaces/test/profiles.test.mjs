import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TO_CONTRACT_ENUM,
  DEFAULT_DEPLOYMENT_PROFILE,
  DEPLOYMENT_PROFILES,
  DISPATCH_MODE_TO_CONTRACT_ENUM,
  normalizeDeploymentProfile,
} from "../index.mjs";

test("deployment profiles cover public validation, integration, and mainnet surfaces", () => {
  assert.equal(DEFAULT_DEPLOYMENT_PROFILE, DEPLOYMENT_PROFILES.MAINNET);
  assert.equal(normalizeDeploymentProfile("testnet"), DEPLOYMENT_PROFILES.PASEO);
  assert.equal(normalizeDeploymentProfile("paseo"), DEPLOYMENT_PROFILES.PASEO);
  assert.equal(
    normalizeDeploymentProfile("hydration-snakenet"),
    DEPLOYMENT_PROFILES.HYDRATION_SNAKENET,
  );
  assert.equal(
    normalizeDeploymentProfile("moonbase-alpha"),
    DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  );
  assert.equal(normalizeDeploymentProfile("multihop"), DEPLOYMENT_PROFILES.INTEGRATION);
  assert.equal(normalizeDeploymentProfile("integration"), DEPLOYMENT_PROFILES.INTEGRATION);
  assert.equal(normalizeDeploymentProfile("mainnet"), DEPLOYMENT_PROFILES.MAINNET);
  assert.throws(() => normalizeDeploymentProfile("staging"));
});

test("contract enums stay stable for the live action surface", () => {
  assert.deepEqual(ACTION_TO_CONTRACT_ENUM, {
    transfer: 0,
    swap: 1,
    execute: 2,
  });
  assert.deepEqual(DISPATCH_MODE_TO_CONTRACT_ENUM, {
    execute: 0,
    send: 1,
  });
});
