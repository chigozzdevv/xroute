import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TO_CONTRACT_ENUM,
  DEFAULT_DEPLOYMENT_PROFILE,
  DEPLOYMENT_PROFILES,
  DISPATCH_MODE_TO_CONTRACT_ENUM,
  normalizeDeploymentProfile,
} from "../index.mjs";

test("deployment profile support accepts the configured production profile", () => {
  assert.equal(DEFAULT_DEPLOYMENT_PROFILE, DEPLOYMENT_PROFILES.MAINNET);
  assert.equal(normalizeDeploymentProfile("mainnet"), DEPLOYMENT_PROFILES.MAINNET);
  assert.throws(() => normalizeDeploymentProfile("staging"));
  assert.throws(() => normalizeDeploymentProfile("testnet"));
  assert.throws(() => normalizeDeploymentProfile("sandbox"));
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
