import test from "node:test";
import assert from "node:assert/strict";

import {
  formatAssetAmount,
  formatUnits,
  getChainWalletType,
  parseAssetAmount,
  parseUnits,
} from "../chains/index.mjs";

test("parseUnits converts decimal display values into base units", () => {
  assert.equal(parseUnits("25", 10), "250000000000");
  assert.equal(parseUnits("1.5", 6), "1500000");
  assert.equal(parseUnits(0.25, 4), "2500");
});

test("parseUnits rejects unsupported precision", () => {
  assert.throws(() => parseUnits("1.234", 2), /more decimal places/);
});

test("formatUnits converts base units into display values", () => {
  assert.equal(formatUnits("250000000000", 10), "25");
  assert.equal(formatUnits("1500000", 6), "1.5");
  assert.equal(formatUnits("1234000", 6), "1.234");
});

test("asset amount helpers use registry decimals", () => {
  assert.equal(parseAssetAmount("DOT", "25"), "250000000000");
  assert.equal(parseAssetAmount("USDT", "49"), "49000000");
  assert.equal(formatAssetAmount("DOT", "250000000000"), "25");
  assert.equal(formatAssetAmount("USDT", "49000000"), "49");
});

test("chain wallet types classify Polkadot Hub as substrate and Moonbeam as evm", () => {
  assert.equal(getChainWalletType("polkadot-hub"), "substrate");
  assert.equal(getChainWalletType("moonbeam"), "evm");
});
