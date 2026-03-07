import test from "node:test";
import assert from "node:assert/strict";

import { findTransferPath, assertExecuteRoute, assertSwapRoute } from "../index.mjs";

test("findTransferPath composes hub-centered multihop spokes", () => {
  assert.deepEqual(findTransferPath("moonbeam", "hydration", "DOT"), [
    "moonbeam",
    "polkadot-hub",
    "hydration",
  ]);
  assert.deepEqual(findTransferPath("hydration", "bifrost", "DOT"), [
    "hydration",
    "polkadot-hub",
    "bifrost",
  ]);
  assert.deepEqual(findTransferPath("polkadot-hub", "bifrost", "VDOT"), [
    "polkadot-hub",
    "bifrost",
  ]);
});

test("assertSwapRoute accepts multihop source paths into hydration", () => {
  const route = assertSwapRoute(
    "moonbeam",
    "hydration",
    "DOT",
    "USDT",
    "polkadot-hub",
  );

  assert.deepEqual(route.executionPath, [
    "moonbeam",
    "polkadot-hub",
    "hydration",
  ]);
});

test("assertExecuteRoute accepts multihop execution into destination capabilities", () => {
  const route = assertExecuteRoute(
    "moonbeam",
    "bifrost",
    "DOT",
    "vtoken-order",
  );

  assert.deepEqual(route.path, [
    "moonbeam",
    "polkadot-hub",
    "bifrost",
  ]);
});
