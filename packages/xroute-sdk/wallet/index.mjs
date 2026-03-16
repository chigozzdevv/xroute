import { assertNonEmptyString } from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../xroute-precompile-interfaces/index.mjs";
import {
  createEvmWalletAdapter,
  createSubstrateWalletAdapter,
} from "../wallets/wallet-adapters.mjs";
import { NATIVE_ASSET_ADDRESS } from "../routers/router-adapters.mjs";

const WALLET_TYPES = Object.freeze({
  EVM: "evm",
  SUBSTRATE: "substrate",
});

export { WALLET_TYPES };

const HOSTED_EVM_WALLET_DEFAULTS = Object.freeze({
  mainnet: Object.freeze({
    "polkadot-hub": Object.freeze({
      routerAddress: "0xaa696e1929b0284f3a0bbc2cab2653cae6c8f7a8",
      assetAddresses: Object.freeze({
        "polkadot-hub": Object.freeze({
          DOT: NATIVE_ASSET_ADDRESS,
        }),
      }),
    }),
    moonbeam: Object.freeze({
      routerAddress: "0x33810619b522ee56dcd0cfba53822fad5ff48fdd",
      assetAddresses: Object.freeze({
        moonbeam: Object.freeze({
          DOT: "0xffffffff1fcacbd218edc0eba20fc2308c778080",
        }),
      }),
    }),
  }),
});

const HOSTED_SUBSTRATE_WALLET_DEFAULTS = Object.freeze({
  mainnet: Object.freeze({
    hydration: Object.freeze({
      rpcUrl: "wss://rpc.hydradx.cloud",
    }),
    bifrost: Object.freeze({
      rpcUrl: "wss://hk.p.bifrost-rpc.liebi.com/ws",
    }),
  }),
});

export function createWallet(type, options = {}) {
  const normalizedType = assertNonEmptyString("type", type).toLowerCase();

  switch (normalizedType) {
    case WALLET_TYPES.EVM:
      return createEvmWallet(options);
    case WALLET_TYPES.SUBSTRATE:
      return createSubstrateWallet(options);
    default:
      throw new Error(
        `unsupported wallet type: ${normalizedType}; expected "evm" or "substrate"`,
      );
  }
}

function createEvmWallet({
  provider,
  chainKey,
  routerAddress,
  statusProvider,
  assetAddresses,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  gasLimit,
  autoApprove,
  receiptPollIntervalMs,
  receiptTimeoutMs,
} = {}) {
  if (!provider) {
    throw new Error(
      'createWallet("evm") requires a provider (window.ethereum or EIP-1193 compatible)',
    );
  }

  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);
  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const defaultConfig = normalizedChainKey
    ? resolveHostedEvmWalletDefaults(normalizedChainKey, normalizedDeploymentProfile)
    : null;

  return createEvmWalletAdapter({
    provider,
    chainKey: normalizedChainKey,
    routerAddress: routerAddress ?? defaultConfig?.routerAddress,
    statusProvider,
    assetAddresses: mergeAssetAddressMaps(
      defaultConfig?.assetAddresses,
      normalizeAssetAddressOverrides(assetAddresses, normalizedChainKey),
    ),
    gasLimit,
    autoApprove,
    receiptPollIntervalMs,
    receiptTimeoutMs,
  });
}

function createSubstrateWallet({
  extension,
  account,
  accountAddress,
  chainKey,
  rpcUrl,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  statusProvider,
  assetAddresses,
  codecContext,
  eventClock,
  xcmPalletNames,
  xcmWeightRuntimeApis,
  extensionDappName,
} = {}) {
  if (!extension && !account) {
    throw new Error(
      'createWallet("substrate") requires an extension or account',
    );
  }
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);
  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const defaultConfig = resolveHostedSubstrateWalletDefaults(
    normalizedChainKey,
    normalizedDeploymentProfile,
  );

  return createSubstrateWalletAdapter({
    extension,
    account,
    accountAddress,
    chainKey: normalizedChainKey,
    rpcUrl: rpcUrl ?? defaultConfig?.rpcUrl,
    statusProvider,
    assetAddresses,
    codecContext,
    eventClock,
    xcmPalletNames,
    xcmWeightRuntimeApis,
    extensionDappName,
  });
}

function resolveHostedEvmWalletDefaults(chainKey, deploymentProfile) {
  const profileConfig = HOSTED_EVM_WALLET_DEFAULTS[deploymentProfile];
  return profileConfig?.[chainKey] ?? null;
}

function resolveHostedSubstrateWalletDefaults(chainKey, deploymentProfile) {
  const profileConfig = HOSTED_SUBSTRATE_WALLET_DEFAULTS[deploymentProfile];
  return profileConfig?.[chainKey] ?? null;
}

function normalizeAssetAddressOverrides(assetAddresses, chainKey) {
  if (!assetAddresses || !isRecord(assetAddresses) || !chainKey) {
    return assetAddresses;
  }

  const values = Object.values(assetAddresses);
  const looksFlat = values.length > 0 && values.every((value) => typeof value === "string");
  return looksFlat ? { [chainKey]: assetAddresses } : assetAddresses;
}

function mergeAssetAddressMaps(defaults, overrides) {
  if (!defaults) {
    return overrides;
  }
  if (!overrides) {
    return defaults;
  }
  if (!isRecord(defaults) || !isRecord(overrides)) {
    return overrides;
  }

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (isRecord(value) && isRecord(defaults[key])) {
      merged[key] = {
        ...defaults[key],
        ...value,
      };
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
