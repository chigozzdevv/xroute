import {
  getAsset,
  getChain,
  listAssets,
  listChains,
  getParachainId,
  getAssetLocation,
  findTransferPath,
  assertSupportedDeploymentProfile,
} from "../../xroute-chain-registry/index.mjs";

export {
  getAsset,
  getChain,
  listAssets,
  listChains,
  getParachainId,
  getAssetLocation,
  findTransferPath,
  assertSupportedDeploymentProfile,
};

export {
  DEFAULT_DEPLOYMENT_PROFILE,
  DEPLOYMENT_PROFILES,
} from "../../xroute-precompile-interfaces/index.mjs";

const EVM_CHAIN_KEYS = new Set(["polkadot-hub", "moonbeam"]);

export function getAssetDecimals(assetKey, deploymentProfile) {
  return getAsset(assetKey, deploymentProfile).decimals;
}

export function getAssetSupportedChains(assetKey, deploymentProfile) {
  return getAsset(assetKey, deploymentProfile).supportedChains.slice();
}

export function getChainWalletType(chainKey, deploymentProfile) {
  return EVM_CHAIN_KEYS.has(getChain(chainKey, deploymentProfile).key) ? "evm" : "substrate";
}

export function isEvmChain(chainKey, deploymentProfile) {
  return getChainWalletType(chainKey, deploymentProfile) === "evm";
}

export function isSubstrateChain(chainKey, deploymentProfile) {
  return getChainWalletType(chainKey, deploymentProfile) === "substrate";
}
