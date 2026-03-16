import { assertAddress, assertNonEmptyString } from "../../xroute-types/index.mjs";
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

export function getBrowserWalletAvailability({
  browserWindow = globalThis.window,
} = {}) {
  return {
    evm: Boolean(browserWindow?.ethereum),
    substrate: Object.keys(browserWindow?.injectedWeb3 ?? {}).length > 0,
  };
}

export async function connectInjectedWallet(type, options = {}) {
  const normalizedType = assertNonEmptyString("type", type).toLowerCase();

  switch (normalizedType) {
    case WALLET_TYPES.EVM:
      return connectInjectedEvmWallet(options);
    case WALLET_TYPES.SUBSTRATE:
      return connectInjectedSubstrateWallet(options);
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

async function connectInjectedEvmWallet({
  provider,
  browserWindow = globalThis.window,
} = {}) {
  const resolvedProvider = provider ?? browserWindow?.ethereum;
  if (!resolvedProvider) {
    throw new Error("Install an injected EVM wallet to connect.");
  }

  const accounts = await resolvedProvider.request({
    method: "eth_requestAccounts",
  });
  const nextAccounts = Array.isArray(accounts) ? accounts : [];
  const account = nextAccounts[0];
  if (!account) {
    throw new Error("No EVM account was returned by the wallet.");
  }

  return {
    kind: WALLET_TYPES.EVM,
    account: assertAddress("evmAccount", account).toLowerCase(),
    provider: resolvedProvider,
  };
}

async function connectInjectedSubstrateWallet({
  extension,
  extensionName = null,
  accountAddress = null,
  extensionDappName = "xroute",
  browserWindow = globalThis.window,
} = {}) {
  const resolved = resolveInjectedSubstrateExtension({
    extension,
    extensionName,
    browserWindow,
  });
  const injected =
    typeof resolved.extensionSource.enable === "function"
      ? await resolved.extensionSource.enable(extensionDappName)
      : resolved.extensionSource;
  const accounts = await readInjectedExtensionAccounts(injected);
  if (accounts.length === 0) {
    throw new Error("No Substrate accounts were returned by the extension.");
  }

  const selected = selectInjectedSubstrateAccount(accounts, accountAddress);

  return {
    kind: WALLET_TYPES.SUBSTRATE,
    account: assertNonEmptyString("account.address", selected.address),
    extensionName: resolved.extensionName,
    extensionSource: resolved.extensionSource,
    accountLabel: selected.meta?.name ?? selected.name ?? null,
  };
}

function resolveHostedEvmWalletDefaults(chainKey, deploymentProfile) {
  const profileConfig = HOSTED_EVM_WALLET_DEFAULTS[deploymentProfile];
  return profileConfig?.[chainKey] ?? null;
}

function resolveHostedSubstrateWalletDefaults(chainKey, deploymentProfile) {
  const profileConfig = HOSTED_SUBSTRATE_WALLET_DEFAULTS[deploymentProfile];
  return profileConfig?.[chainKey] ?? null;
}

function resolveInjectedSubstrateExtension({
  extension,
  extensionName,
  browserWindow,
}) {
  if (extension) {
    return {
      extensionName:
        typeof extensionName === "string" && extensionName.trim() !== ""
          ? extensionName.trim()
          : "injected-substrate",
      extensionSource: extension,
    };
  }

  const entries = Object.entries(browserWindow?.injectedWeb3 ?? {}).filter(
    ([, source]) => Boolean(source) && typeof source?.enable === "function",
  );
  if (entries.length === 0) {
    throw new Error("Install a Substrate wallet extension to connect.");
  }

  const matched =
    typeof extensionName === "string" && extensionName.trim() !== ""
      ? entries.find(([name]) => name === extensionName.trim())
      : entries[0];
  if (!matched) {
    throw new Error(`No Substrate wallet extension named ${extensionName} is available.`);
  }

  const [resolvedName, extensionSource] = matched;
  return {
    extensionName: resolvedName,
    extensionSource,
  };
}

async function readInjectedExtensionAccounts(injected) {
  const accountsSource =
    injected && typeof injected === "object" && "accounts" in injected
      ? injected.accounts
      : undefined;
  if (!accountsSource) {
    return [];
  }

  if (Array.isArray(accountsSource)) {
    return accountsSource;
  }

  if (typeof accountsSource === "function") {
    const accounts = await accountsSource();
    return Array.isArray(accounts) ? accounts : [];
  }

  if (typeof accountsSource?.get === "function") {
    const accounts = await accountsSource.get();
    return Array.isArray(accounts) ? accounts : [];
  }

  return [];
}

function selectInjectedSubstrateAccount(accounts, requestedAddress) {
  if (!requestedAddress) {
    return accounts[0];
  }

  const matched = accounts.find((account) => account?.address === requestedAddress);
  if (!matched) {
    throw new Error(`No Substrate account ${requestedAddress} was returned by the extension.`);
  }

  return matched;
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
