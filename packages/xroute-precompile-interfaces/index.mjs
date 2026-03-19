import { ACTION_TYPES, DISPATCH_MODES, assertIncluded, assertNonEmptyString } from "../xroute-types/index.mjs";

export const XCM_PRECOMPILE_ADDRESS = "0x00000000000000000000000000000000000a0000";
export const MOONBEAM_XCM_PRECOMPILE_ADDRESS = "0x000000000000000000000000000000000000081A";

export const DEPLOYMENT_PROFILES = Object.freeze({
  MAINNET: "mainnet",
});

export const DEFAULT_DEPLOYMENT_PROFILE = DEPLOYMENT_PROFILES.MAINNET;

export const XCM_PRECOMPILE = Object.freeze({
  addresses: Object.freeze({
    default: XCM_PRECOMPILE_ADDRESS,
    moonbeam: MOONBEAM_XCM_PRECOMPILE_ADDRESS,
  }),
  interfaces: Object.freeze({
    Xcm: Object.freeze({
      functions: Object.freeze([
        "execute(bytes,(uint64,uint64))",
        "send(bytes,bytes)",
        "weighMessage(bytes)",
      ]),
    }),
    MoonbeamXcm: Object.freeze({
      functions: Object.freeze([
        "transferAssetsUsingTypeAndThenAddress((uint8,bytes[]),(address,uint256)[],uint8,bytes,(uint8,bytes[]))",
        "weightMessage(bytes)",
      ]),
    }),
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
    normalized,
    Object.values(DEPLOYMENT_PROFILES),
  );
}
