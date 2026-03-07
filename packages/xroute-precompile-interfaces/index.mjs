import { readFileSync, statSync } from "node:fs";

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

const GENERATED_DESTINATION_ADAPTER_SPECS_PATH = new URL(
  "./generated/destination-adapter-specs.json",
  import.meta.url,
);
const GENERATED_DESTINATION_ADAPTER_DEPLOYMENTS_PATH = new URL(
  "./generated/destination-adapter-deployments.json",
  import.meta.url,
);

const manifestCache = {
  specsManifest: { mtimeMs: -1, value: null },
  deploymentsManifest: { mtimeMs: -1, value: null },
  specsMap: { mtimeMs: -1, value: null },
  deploymentsMap: { mtimeMs: -1, value: null },
  dispatchSpec: { mtimeMs: -1, value: null },
};

export const DESTINATION_TRANSACT_DISPATCH = createLiveObjectProxy(
  getDestinationTransactDispatch,
);
export const DESTINATION_ADAPTER_SPECS = createLiveObjectProxy(getDestinationAdapterSpecsMap);
export const DESTINATION_ADAPTER_DEPLOYMENTS = createLiveObjectProxy(
  getDestinationAdapterDeploymentsMap,
);

export function getDestinationAdapterSpec(adapterId) {
  const normalized = assertNonEmptyString("adapterId", adapterId);
  const spec = getDestinationAdapterSpecsMap()[normalized];
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
    getDestinationAdapterDeploymentsMap()[
      `${normalizedAdapterId}:${normalizedChainKey}:${normalizedDeploymentProfile}`
    ];

  if (!deployment) {
    throw new Error(
      `missing destination adapter deployment for ${normalizedAdapterId} on ${normalizedChainKey} (${normalizedDeploymentProfile})`,
    );
  }

  return deployment;
}

export function hasDestinationAdapterDeployment(
  adapterId,
  chainKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const normalizedAdapterId = assertNonEmptyString("adapterId", adapterId);
  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);

  return (
    getDestinationAdapterDeploymentsMap()[
      `${normalizedAdapterId}:${normalizedChainKey}:${normalizedDeploymentProfile}`
    ] !== undefined
  );
}

function getDestinationTransactDispatch() {
  const manifest = loadSpecsManifest();
  const cache = manifestCache.dispatchSpec;
  if (cache.value && cache.mtimeMs === manifestCache.specsManifest.mtimeMs) {
    return cache.value;
  }

  cache.mtimeMs = manifestCache.specsManifest.mtimeMs;
  cache.value = Object.freeze({
    interfaceContract: assertNonEmptyString(
      "dispatch.interfaceContract",
      manifest.dispatch.interfaceContract,
    ),
    signature: assertNonEmptyString("dispatch.signature", manifest.dispatch.signature),
    selector: normalizeSelector(manifest.dispatch.selector),
  });

  return cache.value;
}

function getDestinationAdapterSpecsMap() {
  const manifest = loadSpecsManifest();
  const cache = manifestCache.specsMap;
  if (cache.value && cache.mtimeMs === manifestCache.specsManifest.mtimeMs) {
    return cache.value;
  }

  const entries = manifest.adapters.map((spec) => {
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

  cache.mtimeMs = manifestCache.specsManifest.mtimeMs;
  cache.value = Object.freeze(Object.fromEntries(entries));
  return cache.value;
}

function getDestinationAdapterDeploymentsMap() {
  const manifest = loadDeploymentsManifest();
  const cache = manifestCache.deploymentsMap;
  if (cache.value && cache.mtimeMs === manifestCache.deploymentsManifest.mtimeMs) {
    return cache.value;
  }

  const entries = manifest.deployments.map((deployment) => {
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

  cache.mtimeMs = manifestCache.deploymentsManifest.mtimeMs;
  cache.value = Object.freeze(Object.fromEntries(entries));
  return cache.value;
}

function loadSpecsManifest() {
  return readCachedJson(
    GENERATED_DESTINATION_ADAPTER_SPECS_PATH,
    manifestCache.specsManifest,
  );
}

function loadDeploymentsManifest() {
  return readCachedJson(
    GENERATED_DESTINATION_ADAPTER_DEPLOYMENTS_PATH,
    manifestCache.deploymentsManifest,
  );
}

function readCachedJson(path, cache) {
  const mtimeMs = statSync(path).mtimeMs;
  if (!cache.value || cache.mtimeMs !== mtimeMs) {
    cache.mtimeMs = mtimeMs;
    cache.value = JSON.parse(readFileSync(path, "utf8"));
  }

  return cache.value;
}

function createLiveObjectProxy(loader) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      return loader()[property];
    },
    has(_target, property) {
      return property in loader();
    },
    ownKeys() {
      return Reflect.ownKeys(loader());
    },
    getOwnPropertyDescriptor(_target, property) {
      const value = loader()[property];
      if (value === undefined) {
        return undefined;
      }

      return {
        configurable: true,
        enumerable: true,
        value,
      };
    },
  });
}

function normalizeSelector(selector) {
  const normalized = assertHexString("selector", selector);
  if (normalized.length !== 10) {
    throw new Error("selector must be a 4-byte 0x-prefixed hex string");
  }

  return normalized;
}
