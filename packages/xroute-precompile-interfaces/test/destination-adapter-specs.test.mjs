import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  DESTINATION_ADAPTER_SPECS,
  DESTINATION_ADAPTER_TARGET_KINDS,
  getDestinationAdapterSpec,
} from "../index.mjs";

test("destination adapter specs are published with supported target kinds", () => {
  const swap = getDestinationAdapterSpec("hydration-swap-v1");

  assert.equal(swap.id, "hydration-swap-v1");
  assert.equal(swap.targetKind, DESTINATION_ADAPTER_TARGET_KINDS.EVM_CONTRACT);
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
