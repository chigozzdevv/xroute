import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPLOYMENT_PROFILES } from "../packages/xroute-precompile-interfaces/index.mjs";
import { deployStack } from "./deploy-stack.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "..");

const deployment = deployStack({
  deploymentProfile: DEPLOYMENT_PROFILES.LOCAL,
  hydrationDeploymentPath: resolve(
    workspaceRoot,
    "contracts/polkadot-hub-router/deployments/local/hydration.json",
  ),
  stackOutputPath: resolve(
    workspaceRoot,
    "contracts/polkadot-hub-router/devnet/local-stack.json",
  ),
});

console.log(JSON.stringify(deployment, null, 2));
