import { assertNonEmptyString } from "../../xroute-types/index.mjs";
import {
  createEvmWalletAdapter,
  createSubstrateWalletAdapter,
} from "../wallets/wallet-adapters.mjs";

const WALLET_TYPES = Object.freeze({
  EVM: "evm",
  SUBSTRATE: "substrate",
});

export { WALLET_TYPES };

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

  return createEvmWalletAdapter({
    provider,
    chainKey,
    routerAddress,
    statusProvider,
    assetAddresses,
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

  return createSubstrateWalletAdapter({
    extension,
    account,
    accountAddress,
    chainKey,
    rpcUrl,
    statusProvider,
    assetAddresses,
    codecContext,
    eventClock,
    xcmPalletNames,
    xcmWeightRuntimeApis,
    extensionDappName,
  });
}
