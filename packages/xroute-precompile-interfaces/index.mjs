import { ACTION_TYPES, DISPATCH_MODES, assertIncluded, assertNonEmptyString } from "../xroute-types/index.mjs";

export const XCM_PRECOMPILE_ADDRESS = "0x00000000000000000000000000000000000a0000";

export const DEPLOYMENT_PROFILES = Object.freeze({
  PASEO: "paseo",
  HYDRATION_SNAKENET: "hydration-snakenet",
  MOONBASE_ALPHA: "moonbase-alpha",
  INTEGRATION: "integration",
  MAINNET: "mainnet",
});

export const DEFAULT_DEPLOYMENT_PROFILE = DEPLOYMENT_PROFILES.MAINNET;
const DEPLOYMENT_PROFILE_ALIASES = Object.freeze({
  testnet: DEPLOYMENT_PROFILES.PASEO,
  "hydration-testnet": DEPLOYMENT_PROFILES.HYDRATION_SNAKENET,
  moonbeam: DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  moonbase: DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  "moonbeam-testnet": DEPLOYMENT_PROFILES.MOONBASE_ALPHA,
  lab: DEPLOYMENT_PROFILES.INTEGRATION,
  "multichain-lab": DEPLOYMENT_PROFILES.INTEGRATION,
  multihop: DEPLOYMENT_PROFILES.INTEGRATION,
  "integration-testnet": DEPLOYMENT_PROFILES.INTEGRATION,
});

export const PRECOMPILE_METADATA = Object.freeze({
  xcm: Object.freeze({
    address: XCM_PRECOMPILE_ADDRESS,
    functions: Object.freeze(["execute(bytes,(uint64,uint64))", "send(bytes,bytes)", "weighMessage(bytes)"]),
  }),
});

export const ACTION_TO_CONTRACT_ENUM = Object.freeze({
  [ACTION_TYPES.TRANSFER]: 0,
  [ACTION_TYPES.SWAP]: 1,
  [ACTION_TYPES.EXECUTE]: 2,
});

export const DISPATCH_MODE_TO_CONTRACT_ENUM = Object.freeze({
  [DISPATCH_MODES.EXECUTE]: 0,
  [DISPATCH_MODES.SEND]: 1,
});

export function normalizeDeploymentProfile(profile) {
  const normalized = assertNonEmptyString("deploymentProfile", profile);
  return assertIncluded(
    "deploymentProfile",
    DEPLOYMENT_PROFILE_ALIASES[normalized] ?? normalized,
    Object.values(DEPLOYMENT_PROFILES),
  );
}
