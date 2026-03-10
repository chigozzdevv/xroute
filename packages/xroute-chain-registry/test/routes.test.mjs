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
    "bifrost",
  ]);
  assert.deepEqual(findTransferPath("polkadot-hub", "bifrost", "DOT"), [
    "polkadot-hub",
    "moonbeam",
    "bifrost",
  ]);
  assert.equal(findTransferPath("polkadot-hub", "bifrost", "VDOT"), null);
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
    "bifrost",
  ]);
});

test("findTransferPath exposes the paseo proof route", () => {
  assert.deepEqual(findTransferPath("polkadot-hub", "people", "PAS", "paseo"), [
    "polkadot-hub",
    "people",
  ]);
});

test("hydration-snakenet stays focused on Hub and Hydration swap flows", () => {
  assert.deepEqual(
    findTransferPath("polkadot-hub", "hydration", "DOT", "hydration-snakenet"),
    ["polkadot-hub", "hydration"],
  );
  const route = assertSwapRoute(
    "polkadot-hub",
    "hydration",
    "DOT",
    "USDT",
    "polkadot-hub",
    "hydration-snakenet",
  );

  assert.deepEqual(route.executionPath, ["polkadot-hub", "hydration"]);
});

test("moonbase-alpha exposes Moonbeam execute capabilities without Bifrost edges", () => {
  const route = assertExecuteRoute(
    "polkadot-hub",
    "moonbeam",
    "DOT",
    "evm-contract-call",
    "moonbase-alpha",
  );

  assert.deepEqual(route.path, ["polkadot-hub", "moonbeam"]);
  assert.throws(
    () => findTransferPath("polkadot-hub", "bifrost", "DOT", "moonbase-alpha"),
    /unsupported chain/,
  );
});

test("bifrost-via-hydration exposes only the docs-backed Hydration to Bifrost capability path", () => {
  assert.deepEqual(findTransferPath("hydration", "bifrost", "DOT", "bifrost-via-hydration"), [
    "hydration",
    "bifrost",
  ]);
  const route = assertExecuteRoute(
    "hydration",
    "bifrost",
    "DOT",
    "vtoken-order",
    "bifrost-via-hydration",
  );

  assert.deepEqual(route.path, ["hydration", "bifrost"]);
  assert.throws(
    () => findTransferPath("polkadot-hub", "bifrost", "DOT", "bifrost-via-hydration"),
    /unsupported chain/,
  );
});

test("bifrost-via-moonbase-alpha exposes only the docs-backed Moonbeam to Bifrost capability path", () => {
  assert.deepEqual(findTransferPath("moonbeam", "bifrost", "DOT", "bifrost-via-moonbase-alpha"), [
    "moonbeam",
    "bifrost",
  ]);
  const route = assertExecuteRoute(
    "moonbeam",
    "bifrost",
    "DOT",
    "vtoken-order",
    "bifrost-via-moonbase-alpha",
  );

  assert.deepEqual(route.path, ["moonbeam", "bifrost"]);
  assert.throws(
    () => findTransferPath("polkadot-hub", "bifrost", "DOT", "bifrost-via-moonbase-alpha"),
    /unsupported chain/,
  );
});

test("integration exposes the full four-chain multihop graph", () => {
  assert.deepEqual(findTransferPath("polkadot-hub", "bifrost", "DOT", "integration"), [
    "polkadot-hub",
    "moonbeam",
    "bifrost",
  ]);
  assert.deepEqual(findTransferPath("moonbeam", "hydration", "DOT", "integration"), [
    "moonbeam",
    "polkadot-hub",
    "hydration",
  ]);
});
