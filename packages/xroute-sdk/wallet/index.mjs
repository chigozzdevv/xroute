import { assertAddress, assertNonEmptyString } from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../xroute-precompile-interfaces/index.mjs";
import {
  createEvmWalletAdapter,
  createSubstrateWalletAdapter,
} from "../wallets/wallet-adapters.mjs";
import { NATIVE_ASSET_ADDRESS } from "../routers/constants.mjs";

const WALLET_TYPES = Object.freeze({
  EVM: "evm",
  SUBSTRATE: "substrate",
});

export { WALLET_TYPES };

const HOSTED_EVM_WALLET_DEFAULTS = Object.freeze({
  mainnet: Object.freeze({
    "polkadot-hub": Object.freeze({
      routerAddress: "0xaa696e1929b0284f3a0bbc2cab2653cae6c8f7a8",
      // Polkadot Hub route amounts use 10-decimal DOT in the route registry, while the
      // EVM execution layer exposes native gas/accounting in 18-decimal units.
      gasAssetMetadata: Object.freeze({
        asset: "DOT",
        decimals: 18,
        unitDomain: "polkadot-hub-evm-native",
      }),
      network: Object.freeze({
        chainId: 420420419,
        chainName: "Polkadot Hub",
        nativeCurrency: Object.freeze({
          name: "DOT",
          symbol: "DOT",
          decimals: 18,
        }),
        rpcUrls: Object.freeze([
          "https://eth-rpc.polkadot.io/",
        ]),
        blockExplorerUrls: Object.freeze([
          "https://blockscout.polkadot.io/",
        ]),
      }),
      assetAddresses: Object.freeze({
        "polkadot-hub": Object.freeze({
          DOT: NATIVE_ASSET_ADDRESS,
        }),
      }),
    }),
    moonbeam: Object.freeze({
      routerAddress: "0x377bea6e8cb4a1ed418cbcb99b5608abb9970f7c",
      gasAssetMetadata: Object.freeze({
        asset: "GLMR",
        decimals: 18,
        unitDomain: "evm-native",
      }),
      network: Object.freeze({
        chainId: 1284,
        chainName: "Moonbeam",
        nativeCurrency: Object.freeze({
          name: "GLMR",
          symbol: "GLMR",
          decimals: 18,
        }),
        rpcUrls: Object.freeze([
          "https://rpc.api.moonbeam.network",
        ]),
        blockExplorerUrls: Object.freeze([
          "https://moonbeam.moonscan.io/",
        ]),
      }),
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
    "polkadot-hub": Object.freeze({
      rpcUrl: "wss://polkadot-asset-hub-rpc.polkadot.io",
    }),
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
    evm: listInjectedEvmProviders({ browserWindow }).length > 0,
    substrate: listInjectedSubstrateExtensions({ browserWindow }).length > 0,
  };
}

export function listInjectedEvmProviders({
  browserWindow = globalThis.window,
} = {}) {
  const rootProvider = browserWindow?.ethereum;
  if (!rootProvider) {
    return [];
  }

  const candidates = Array.isArray(rootProvider.providers) && rootProvider.providers.length > 0
    ? rootProvider.providers
    : [rootProvider];
  const uniqueProviders = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    uniqueProviders.push(candidate);
  }

  return uniqueProviders.map((provider, index) => ({
    ...describeInjectedEvmProvider(provider, index),
    provider,
  }));
}

export function listInjectedSubstrateExtensions({
  browserWindow = globalThis.window,
} = {}) {
  return Object.entries(browserWindow?.injectedWeb3 ?? {})
    .filter(([, source]) => Boolean(source) && typeof source?.enable === "function")
    .map(([extensionName], index) => ({
      ...describeInjectedSubstrateExtension(extensionName, index),
    }));
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
  gasAssetMetadata,
  autoApprove,
  debugTransactions = false,
  debugLogger = null,
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
    expectedNetwork: defaultConfig?.network ?? null,
    statusProvider,
    assetAddresses: mergeAssetAddressMaps(
      defaultConfig?.assetAddresses,
      normalizeAssetAddressOverrides(assetAddresses, normalizedChainKey),
    ),
    gasLimit,
    gasAssetMetadata: gasAssetMetadata ?? defaultConfig?.gasAssetMetadata ?? null,
    autoApprove,
    debugTransactions,
    debugLogger,
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
  providerId = null,
  browserWindow = globalThis.window,
  requestAccess = true,
} = {}) {
  const resolved = resolveInjectedEvmProvider({
    provider,
    providerId,
    browserWindow,
  });
  if (!resolved) {
    throw new Error("Install an injected EVM wallet to connect.");
  }

  const accounts = await resolved.provider.request({
    method: requestAccess ? "eth_requestAccounts" : "eth_accounts",
  });
  const nextAccounts = Array.isArray(accounts) ? accounts : [];
  const account = nextAccounts[0];
  if (!account) {
    throw new Error(
      requestAccess
        ? "No EVM account was returned by the wallet."
        : "No connected EVM account is available.",
    );
  }

  return {
    kind: WALLET_TYPES.EVM,
    account: assertAddress("evmAccount", account).toLowerCase(),
    provider: resolved.provider,
    providerId: resolved.id,
    providerLabel: resolved.label,
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
    extensionLabel: resolved.extensionLabel,
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
      extensionLabel: describeInjectedSubstrateExtension(
        typeof extensionName === "string" && extensionName.trim() !== ""
          ? extensionName.trim()
          : "injected-substrate",
        0,
      ).label,
      extensionSource: extension,
    };
  }

  const entries = listInjectedSubstrateExtensions({ browserWindow })
    .map(({ id }) => [id, browserWindow?.injectedWeb3?.[id]])
    .filter(([, source]) => Boolean(source) && typeof source?.enable === "function");
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
    extensionLabel: describeInjectedSubstrateExtension(
      resolvedName,
      entries.findIndex(([name]) => name === resolvedName),
    ).label,
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

function resolveInjectedEvmProvider({
  provider,
  providerId,
  browserWindow,
}) {
  if (provider) {
    return {
      ...describeInjectedEvmProvider(provider, 0),
      provider,
    };
  }

  const providers = listInjectedEvmProviders({ browserWindow });
  if (providers.length === 0) {
    return null;
  }

  if (typeof providerId === "string" && providerId.trim() !== "") {
    const matched = providers.find((candidate) => candidate.id === providerId.trim());
    if (!matched) {
      throw new Error(`No injected EVM wallet named ${providerId} is available.`);
    }
    return matched;
  }

  return providers[0];
}

function describeInjectedEvmProvider(provider, index) {
  if (provider?.isRabby) {
    return { id: "rabby", label: "Rabby" };
  }
  if (provider?.isMetaMask) {
    return { id: "metamask", label: "MetaMask" };
  }
  if (provider?.isCoinbaseWallet) {
    return { id: "coinbase", label: "Coinbase Wallet" };
  }
  if (provider?.isBraveWallet) {
    return { id: "brave", label: "Brave Wallet" };
  }
  if (provider?.isTrust) {
    return { id: "trust", label: "Trust Wallet" };
  }

  return {
    id: `injected-evm-${index + 1}`,
    label: `Injected EVM Wallet ${index + 1}`,
  };
}

function describeInjectedSubstrateExtension(extensionName, index) {
  const normalized = String(extensionName ?? "").trim();
  const lower = normalized.toLowerCase();
  if (lower === "subwallet-js" || lower === "subwallet") {
    return { id: normalized, label: "SubWallet" };
  }
  if (lower === "polkadot-js" || lower === "polkadot{.js}") {
    return { id: normalized, label: "polkadot.js" };
  }
  if (lower === "talisman") {
    return { id: normalized, label: "Talisman" };
  }
  if (lower === "enkrypt") {
    return { id: normalized, label: "Enkrypt" };
  }
  if (normalized !== "") {
    return { id: normalized, label: normalized };
  }

  return {
    id: `injected-substrate-${index + 1}`,
    label: `Injected Substrate Wallet ${index + 1}`,
  };
}
