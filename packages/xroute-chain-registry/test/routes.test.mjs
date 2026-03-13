import test from "node:test";
import assert from "node:assert/strict";

import {
  assertExecuteRoute,
  assertSwapRoute,
  findTransferPath,
  getAsset,
  getChain,
  listAssets,
  listChains,
  listRoutes,
} from "../index.mjs";

test("mainnet exposes hub, hydration, moonbeam, and bifrost", () => {
  assert.equal(getChain("polkadot-hub").key, "polkadot-hub");
  assert.equal(getChain("hydration").key, "hydration");
  assert.equal(getChain("moonbeam").key, "moonbeam");
  assert.equal(getChain("bifrost").key, "bifrost");
  assert.equal(getAsset("DOT").symbol, "DOT");
  assert.equal(getAsset("VDOT").symbol, "VDOT");
  assert.equal(listChains().length, 4);
  assert.equal(listAssets().length, 4);
  assert.equal(listRoutes().length, 6);
});

test("findTransferPath composes the supported mainnet multihop spokes", () => {
  assert.deepEqual(findTransferPath("moonbeam", "hydration", "DOT"), [
    "moonbeam",
    "polkadot-hub",
    "hydration",
  ]);
  assert.deepEqual(findTransferPath("bifrost", "moonbeam", "DOT"), [
    "bifrost",
    "polkadot-hub",
    "moonbeam",
  ]);
  assert.equal(findTransferPath("hydration", "moonbeam", "VDOT"), null);
});

test("assertSwapRoute accepts hydration swaps with local or hub settlement", () => {
  assert.deepEqual(assertSwapRoute("polkadot-hub", "hydration", "DOT", "USDT"), {
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    settlementChain: "hydration",
    executionPath: ["polkadot-hub", "hydration"],
    action: "swap",
  });

  assert.deepEqual(
    assertSwapRoute("moonbeam", "hydration", "DOT", "USDT", "polkadot-hub"),
    {
      sourceChain: "moonbeam",
      destinationChain: "hydration",
      settlementChain: "polkadot-hub",
      executionPath: ["moonbeam", "polkadot-hub", "hydration"],
      action: "swap",
    },
  );

  assert.deepEqual(
    assertSwapRoute("polkadot-hub", "hydration", "DOT", "HDX"),
    {
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      settlementChain: "hydration",
      executionPath: ["polkadot-hub", "hydration"],
      action: "swap",
    },
  );

  assert.throws(() =>
    assertSwapRoute("moonbeam", "hydration", "DOT", "HDX", "polkadot-hub"),
  );
});

test("assertExecuteRoute accepts mainnet execute targets and rejects unsupported ones", () => {
  assert.deepEqual(
    assertExecuteRoute("hydration", "moonbeam", "DOT", "call"),
    {
      sourceChain: "hydration",
      destinationChain: "moonbeam",
      path: ["hydration", "polkadot-hub", "moonbeam"],
      executionType: "call",
      action: "execute",
    },
  );

  assert.deepEqual(
    assertExecuteRoute("bifrost", "moonbeam", "DOT", "call"),
    {
      sourceChain: "bifrost",
      destinationChain: "moonbeam",
      path: ["bifrost", "polkadot-hub", "moonbeam"],
      executionType: "call",
      action: "execute",
    },
  );

  assert.throws(() => assertExecuteRoute("bifrost", "hydration", "DOT", "call"));
  assert.throws(() => assertExecuteRoute("hydration", "moonbeam", "DOT", "mint-vdot"));
  assert.throws(() => assertExecuteRoute("bifrost", "moonbeam", "VDOT", "redeem-vdot"));
});
