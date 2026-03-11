import test from "node:test";
import assert from "node:assert/strict";

import {
  assertExecuteRoute,
  assertSwapRoute,
  findTransferPath,
  getAsset,
  getChain,
  listRoutes,
} from "../index.mjs";

test("mainnet exposes hub, hydration, moonbeam, and bifrost", () => {
  assert.equal(getChain("polkadot-hub").key, "polkadot-hub");
  assert.equal(getChain("hydration").key, "hydration");
  assert.equal(getChain("moonbeam").key, "moonbeam");
  assert.equal(getChain("bifrost").key, "bifrost");
  assert.equal(getAsset("DOT").symbol, "DOT");
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
});

test("assertExecuteRoute accepts mainnet execute targets and rejects unsupported ones", () => {
  assert.deepEqual(
    assertExecuteRoute("hydration", "moonbeam", "DOT", "evm-contract-call"),
    {
      sourceChain: "hydration",
      destinationChain: "moonbeam",
      path: ["hydration", "polkadot-hub", "moonbeam"],
      executionType: "evm-contract-call",
      action: "execute",
    },
  );

  assert.throws(() => assertExecuteRoute("bifrost", "hydration", "DOT", "evm-contract-call"));
});
