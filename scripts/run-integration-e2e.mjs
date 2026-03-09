import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runOperatedIntegration } from "./lib/run-operated-integration.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await runOperatedIntegration({
  workspaceRoot,
  printSummary: true,
});
