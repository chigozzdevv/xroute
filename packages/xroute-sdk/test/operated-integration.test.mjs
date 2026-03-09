import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runOperatedIntegration } from "../../../scripts/lib/run-operated-integration.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("operated integration stack settles transfer, swap, and execute flows end to end", async () => {
  const summary = await runOperatedIntegration({
    workspaceRoot,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.deploymentProfile, "integration");
  assert.equal(summary.scenarios.length, 5);
  assert.deepEqual(
    summary.scenarios.map((scenario) => scenario.name),
    [
      "transfer",
      "swap",
      "execute-runtime-call",
      "execute-evm-contract-call",
      "execute-vtoken-order",
    ],
  );
  assert(summary.scenarios.every((scenario) => scenario.routerStatus === "settled"));
});
