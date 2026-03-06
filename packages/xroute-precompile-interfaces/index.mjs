import { readFileSync } from "node:fs";

import { ACTION_TYPES, DISPATCH_MODES } from "../xroute-types/index.mjs";
import {
  assertAddress,
  assertHexString,
  assertIncluded,
  assertNonEmptyString,
} from "../xroute-types/index.mjs";

export const XCM_PRECOMPILE_ADDRESS = "0x00000000000000000000000000000000000a0000";
export const DEPLOYMENT_PROFILES = Object.freeze({
  LOCAL: "local",
  TESTNET: "testnet",
  MAINNET: "mainnet",
});
export const DEFAULT_DEPLOYMENT_PROFILE = DEPLOYMENT_PROFILES.LOCAL;
export const DESTINATION_ADAPTER_TARGET_KINDS = Object.freeze({
  EVM_CONTRACT: "evm-contract",
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
  [ACTION_TYPES.STAKE]: 2,
  [ACTION_TYPES.CALL]: 3,
});

export const DISPATCH_MODE_TO_CONTRACT_ENUM = Object.freeze({
  [DISPATCH_MODES.EXECUTE]: 0,
  [DISPATCH_MODES.SEND]: 1,
});

const GENERATED_DESTINATION_ADAPTER_SPECS = JSON.parse(readFileSync(
  new URL("./generated/destination-adapter-specs.json", import.meta.url),
  "utf8",
));
const GENERATED_DESTINATION_ADAPTER_DEPLOYMENTS = JSON.parse(readFileSync(
  new URL("./generated/destination-adapter-deployments.json", import.meta.url),
  "utf8",
));

export const DESTINATION_TRANSACT_DISPATCH = Object.freeze({
  interfaceContract: assertNonEmptyString(
    "dispatch.interfaceContract",
    GENERATED_DESTINATION_ADAPTER_SPECS.dispatch.interfaceContract,
  ),
  signature: assertNonEmptyString(
    "dispatch.signature",
    GENERATED_DESTINATION_ADAPTER_SPECS.dispatch.signature,
  ),
  selector: normalizeSelector(GENERATED_DESTINATION_ADAPTER_SPECS.dispatch.selector),
});

export const DESTINATION_ADAPTER_SPECS = Object.freeze(parseDestinationAdapterSpecs());
export const DESTINATION_ADAPTER_DEPLOYMENTS = Object.freeze(parseDestinationAdapterDeployments());

export function getDestinationAdapterSpec(adapterId) {
  const normalized = assertNonEmptyString("adapterId", adapterId);
  const spec = DESTINATION_ADAPTER_SPECS[normalized];
  if (!spec) {
    throw new Error(`unsupported destination adapter: ${normalized}`);
  }

  return spec;
}

export function normalizeDeploymentProfile(profile) {
  return assertIncluded(
    "deploymentProfile",
    assertNonEmptyString("deploymentProfile", profile),
    Object.values(DEPLOYMENT_PROFILES),
  );
}

export function getDestinationAdapterDeployment(
  adapterId,
  chainKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const normalizedAdapterId = assertNonEmptyString("adapterId", adapterId);
  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);
  const deployment =
    DESTINATION_ADAPTER_DEPLOYMENTS[
      `${normalizedAdapterId}:${normalizedChainKey}:${normalizedDeploymentProfile}`
    ];

  if (!deployment) {
    throw new Error(
      `missing destination adapter deployment for ${normalizedAdapterId} on ${normalizedChainKey} (${normalizedDeploymentProfile})`,
    );
  }

  return deployment;
}

function parseDestinationAdapterSpecs() {
  const entries = GENERATED_DESTINATION_ADAPTER_SPECS.adapters.map((spec) => {
    const adapterId = assertNonEmptyString("adapterId", spec.id);
    return [
      adapterId,
      Object.freeze({
        id: adapterId,
        targetKind: assertIncluded(
          "targetKind",
          spec.targetKind,
          Object.values(DESTINATION_ADAPTER_TARGET_KINDS),
        ),
        implementationContract: assertNonEmptyString(
          "implementationContract",
          spec.implementationContract,
        ),
        signature: assertNonEmptyString("signature", spec.signature),
        selector: normalizeSelector(spec.selector),
      }),
    ];
  });

  return Object.fromEntries(entries);
}

function parseDestinationAdapterDeployments() {
  const entries = GENERATED_DESTINATION_ADAPTER_DEPLOYMENTS.deployments.map((deployment) => {
    const normalizedAdapterId = assertNonEmptyString("adapterId", deployment.adapterId);
    const normalizedChainKey = assertNonEmptyString("chainKey", deployment.chainKey);
    const normalizedDeploymentProfile = normalizeDeploymentProfile(
      deployment.deploymentProfile,
    );

    return [
      `${normalizedAdapterId}:${normalizedChainKey}:${normalizedDeploymentProfile}`,
      Object.freeze({
        adapterId: normalizedAdapterId,
        chainKey: normalizedChainKey,
        deploymentProfile: normalizedDeploymentProfile,
        implementationContract: assertNonEmptyString(
          "implementationContract",
          deployment.implementationContract,
        ),
        address: assertAddress("address", deployment.address),
      }),
    ];
  });

  return Object.fromEntries(entries);
}

function normalizeSelector(selector) {
  const normalized = assertHexString("selector", selector);
  if (normalized.length !== 10) {
    throw new Error("selector must be a 4-byte 0x-prefixed hex string");
  }

  return normalized;
}
