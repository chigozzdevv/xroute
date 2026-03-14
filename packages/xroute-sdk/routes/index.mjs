import {
  assertTransferRoute,
  assertSwapRoute,
  assertExecuteRoute,
  getChain,
  getAsset,
  listAssets,
  listChains,
  listRoutes,
  getRoute,
} from "../../xroute-chain-registry/index.mjs";
import {
  ACTION_TYPES,
  EXECUTION_TYPES,
} from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
} from "../../xroute-precompile-interfaces/index.mjs";

export {
  assertTransferRoute,
  assertSwapRoute,
  assertExecuteRoute,
  listRoutes,
  getRoute,
};

export function getTransferOptions(sourceChain, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const chains = listChains(deploymentProfile);
  const assets = listAssets(deploymentProfile);
  const source = getChain(sourceChain, deploymentProfile);
  const destinations = [];

  for (const chain of chains) {
    if (chain.key === source.key) continue;

    const transferableAssets = [];
    for (const asset of assets) {
      try {
        assertTransferRoute(source.key, chain.key, asset.symbol, deploymentProfile);
        transferableAssets.push(asset.symbol);
      } catch {
        // route not supported
      }
    }

    if (transferableAssets.length > 0) {
      destinations.push({
        chain: chain.key,
        label: chain.label,
        assets: transferableAssets,
      });
    }
  }

  return destinations;
}

export function getSwapOptions(sourceChain, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const routes = listRoutes(deploymentProfile);
  const source = getChain(sourceChain, deploymentProfile);
  const results = [];

  for (const route of routes) {
    if (!route.actions.includes(ACTION_TYPES.SWAP)) continue;
    if (route.swapPairs.length === 0) continue;

    const destinationChain = route.destinationChain;
    const chain = getChain(destinationChain, deploymentProfile);

    const pairs = [];
    for (const pair of route.swapPairs) {
      const settlementChains = [];
      for (const settlement of pair.settlementChains) {
        try {
          assertSwapRoute(
            source.key,
            destinationChain,
            pair.assetIn,
            pair.assetOut,
            settlement,
            deploymentProfile,
          );
          settlementChains.push(settlement);
        } catch {
          // route not supported from this source
        }
      }

      if (settlementChains.length > 0) {
        pairs.push({
          assetIn: pair.assetIn,
          assetOut: pair.assetOut,
          settlementChains,
        });
      }
    }

    if (pairs.length > 0) {
      results.push({
        chain: chain.key,
        label: chain.label,
        pairs,
      });
    }
  }

  return results;
}

export function getExecuteOptions(sourceChain, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const routes = listRoutes(deploymentProfile);
  const source = getChain(sourceChain, deploymentProfile);
  const results = [];

  for (const route of routes) {
    if (!route.actions.includes(ACTION_TYPES.EXECUTE)) continue;
    if (route.executeCapabilities.length === 0) continue;

    const destinationChain = route.destinationChain;
    const chain = getChain(destinationChain, deploymentProfile);

    const capabilities = [];
    for (const cap of route.executeCapabilities) {
      const supportedAssets = [];
      for (const asset of cap.assets) {
        try {
          assertExecuteRoute(
            source.key,
            destinationChain,
            asset,
            cap.executionType,
            deploymentProfile,
          );
          supportedAssets.push(asset);
        } catch {
          // route not supported from this source
        }
      }

      if (supportedAssets.length > 0) {
        capabilities.push({
          executionType: cap.executionType,
          assets: supportedAssets,
        });
      }
    }

    if (capabilities.length > 0) {
      results.push({
        chain: chain.key,
        label: chain.label,
        capabilities,
      });
    }
  }

  return results;
}
