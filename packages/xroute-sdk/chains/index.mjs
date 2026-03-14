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

export function getAssetDecimals(assetKey, deploymentProfile) {
  return getAsset(assetKey, deploymentProfile).decimals;
}

export function getAssetSupportedChains(assetKey, deploymentProfile) {
  return getAsset(assetKey, deploymentProfile).supportedChains.slice();
}
