import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../xroute-precompile-interfaces/index.mjs";
import {
  ACTION_TYPES,
  EXECUTION_TYPES,
  assertIncluded,
  assertNonEmptyString,
} from "../xroute-types/index.mjs";

const CHAIN_ALIASES = Object.freeze({
  "asset-hub": "polkadot-hub",
});

const TESTNET_PROFILE = Object.freeze({
  chains: Object.freeze({
    "polkadot-hub": Object.freeze({
      key: "polkadot-hub",
      label: "Polkadot Hub",
      parachainId: 1000,
      supportedActions: Object.freeze([ACTION_TYPES.TRANSFER]),
    }),
    people: Object.freeze({
      key: "people",
      label: "People Chain",
      parachainId: 1004,
      supportedActions: Object.freeze([ACTION_TYPES.TRANSFER]),
    }),
  }),
  assets: Object.freeze({
    PAS: Object.freeze({
      symbol: "PAS",
      decimals: 10,
      supportedChains: Object.freeze(["polkadot-hub", "people"]),
      xcmLocations: Object.freeze({
        "polkadot-hub": Object.freeze({
          parents: 1,
          interior: Object.freeze({ type: "here" }),
        }),
        people: Object.freeze({
          parents: 1,
          interior: Object.freeze({ type: "here" }),
        }),
      }),
    }),
  }),
  routes: Object.freeze([
    Object.freeze({
      sourceChain: "polkadot-hub",
      destinationChain: "people",
      path: Object.freeze(["polkadot-hub", "people"]),
      actions: Object.freeze([ACTION_TYPES.TRANSFER]),
      transferableAssets: Object.freeze(["PAS"]),
      swapPairs: Object.freeze([]),
      executeAssets: Object.freeze([]),
      executeTypes: Object.freeze([]),
    }),
  ]),
});

const MAINNET_PROFILE = Object.freeze({
  chains: Object.freeze({
    "polkadot-hub": Object.freeze({
      key: "polkadot-hub",
      label: "Polkadot Hub",
      parachainId: 1000,
      supportedActions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.SWAP,
        ACTION_TYPES.EXECUTE,
      ]),
    }),
    hydration: Object.freeze({
      key: "hydration",
      label: "Hydration",
      parachainId: 2034,
      supportedActions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.SWAP,
        ACTION_TYPES.EXECUTE,
      ]),
    }),
    moonbeam: Object.freeze({
      key: "moonbeam",
      label: "Moonbeam",
      parachainId: 2004,
      supportedActions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.EXECUTE,
      ]),
    }),
    bifrost: Object.freeze({
      key: "bifrost",
      label: "Bifrost",
      parachainId: 2030,
      supportedActions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.EXECUTE,
      ]),
    }),
  }),
  assets: Object.freeze({
    DOT: Object.freeze({
      symbol: "DOT",
      decimals: 10,
      supportedChains: Object.freeze([
        "polkadot-hub",
        "hydration",
        "moonbeam",
        "bifrost",
      ]),
      xcmLocations: Object.freeze({
        "polkadot-hub": Object.freeze({
          parents: 1,
          interior: Object.freeze({ type: "here" }),
        }),
        hydration: Object.freeze({
          parents: 1,
          interior: Object.freeze({ type: "here" }),
        }),
        moonbeam: Object.freeze({
          parents: 1,
          interior: Object.freeze({ type: "here" }),
        }),
        bifrost: Object.freeze({
          parents: 1,
          interior: Object.freeze({ type: "here" }),
        }),
      }),
    }),
    USDT: Object.freeze({
      symbol: "USDT",
      decimals: 6,
      supportedChains: Object.freeze(["hydration", "polkadot-hub"]),
      xcmLocations: Object.freeze({
        hydration: Object.freeze({
          parents: 1,
          interior: Object.freeze({
            type: "x3",
            value: Object.freeze([
              Object.freeze({ type: "parachain", value: 1000 }),
              Object.freeze({ type: "pallet-instance", value: 50 }),
              Object.freeze({ type: "general-index", value: 1984n }),
            ]),
          }),
        }),
        "polkadot-hub": Object.freeze({
          parents: 0,
          interior: Object.freeze({
            type: "x2",
            value: Object.freeze([
              Object.freeze({ type: "pallet-instance", value: 50 }),
              Object.freeze({ type: "general-index", value: 1984n }),
            ]),
          }),
        }),
      }),
    }),
    HDX: Object.freeze({
      symbol: "HDX",
      decimals: 12,
      supportedChains: Object.freeze(["hydration", "polkadot-hub"]),
      xcmLocations: Object.freeze({
        hydration: Object.freeze({
          parents: 0,
          interior: Object.freeze({
            type: "x1",
            value: Object.freeze({
              type: "general-index",
              value: 0n,
            }),
          }),
        }),
        "polkadot-hub": Object.freeze({
          parents: 1,
          interior: Object.freeze({
            type: "x2",
            value: Object.freeze([
              Object.freeze({ type: "parachain", value: 2034 }),
              Object.freeze({ type: "general-index", value: 0n }),
            ]),
          }),
        }),
      }),
    }),
    VDOT: Object.freeze({
      symbol: "VDOT",
      decimals: 10,
      supportedChains: Object.freeze(["bifrost", "polkadot-hub"]),
      xcmLocations: Object.freeze({
        bifrost: Object.freeze({
          parents: 0,
          interior: Object.freeze({
            type: "x1",
            value: Object.freeze({
              type: "general-key",
              value: "0x0900",
            }),
          }),
        }),
        "polkadot-hub": Object.freeze({
          parents: 1,
          interior: Object.freeze({
            type: "x2",
            value: Object.freeze([
              Object.freeze({ type: "parachain", value: 2030 }),
              Object.freeze({ type: "general-key", value: "0x0900" }),
            ]),
          }),
        }),
      }),
    }),
  }),
  routes: Object.freeze([
    Object.freeze({
      sourceChain: "polkadot-hub",
      destinationChain: "hydration",
      path: Object.freeze(["polkadot-hub", "hydration"]),
      actions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.SWAP,
        ACTION_TYPES.EXECUTE,
      ]),
      transferableAssets: Object.freeze(["DOT"]),
      swapPairs: Object.freeze([
        Object.freeze({
          assetIn: "DOT",
          assetOut: "USDT",
          settlementChains: Object.freeze(["hydration", "polkadot-hub"]),
        }),
        Object.freeze({
          assetIn: "DOT",
          assetOut: "HDX",
          settlementChains: Object.freeze(["hydration", "polkadot-hub"]),
        }),
      ]),
      executeAssets: Object.freeze(["DOT"]),
      executeTypes: Object.freeze([EXECUTION_TYPES.RUNTIME_CALL]),
    }),
    Object.freeze({
      sourceChain: "hydration",
      destinationChain: "polkadot-hub",
      path: Object.freeze(["hydration", "polkadot-hub"]),
      actions: Object.freeze([ACTION_TYPES.TRANSFER]),
      transferableAssets: Object.freeze(["DOT", "USDT", "HDX"]),
      swapPairs: Object.freeze([]),
      executeAssets: Object.freeze([]),
      executeTypes: Object.freeze([]),
    }),
    Object.freeze({
      sourceChain: "polkadot-hub",
      destinationChain: "moonbeam",
      path: Object.freeze(["polkadot-hub", "moonbeam"]),
      actions: Object.freeze([ACTION_TYPES.TRANSFER, ACTION_TYPES.EXECUTE]),
      transferableAssets: Object.freeze(["DOT"]),
      swapPairs: Object.freeze([]),
      executeAssets: Object.freeze(["DOT"]),
      executeTypes: Object.freeze([
        EXECUTION_TYPES.RUNTIME_CALL,
        EXECUTION_TYPES.EVM_CONTRACT_CALL,
      ]),
    }),
    Object.freeze({
      sourceChain: "moonbeam",
      destinationChain: "polkadot-hub",
      path: Object.freeze(["moonbeam", "polkadot-hub"]),
      actions: Object.freeze([ACTION_TYPES.TRANSFER]),
      transferableAssets: Object.freeze(["DOT"]),
      swapPairs: Object.freeze([]),
      executeAssets: Object.freeze([]),
      executeTypes: Object.freeze([]),
    }),
    Object.freeze({
      sourceChain: "polkadot-hub",
      destinationChain: "bifrost",
      path: Object.freeze(["polkadot-hub", "bifrost"]),
      actions: Object.freeze([ACTION_TYPES.TRANSFER, ACTION_TYPES.EXECUTE]),
      transferableAssets: Object.freeze(["DOT", "VDOT"]),
      swapPairs: Object.freeze([]),
      executeAssets: Object.freeze(["DOT", "VDOT"]),
      executeTypes: Object.freeze([
        EXECUTION_TYPES.RUNTIME_CALL,
        EXECUTION_TYPES.VTOKEN_ORDER,
      ]),
    }),
    Object.freeze({
      sourceChain: "bifrost",
      destinationChain: "polkadot-hub",
      path: Object.freeze(["bifrost", "polkadot-hub"]),
      actions: Object.freeze([ACTION_TYPES.TRANSFER]),
      transferableAssets: Object.freeze(["DOT"]),
      swapPairs: Object.freeze([]),
      executeAssets: Object.freeze([]),
      executeTypes: Object.freeze([]),
    }),
  ]),
});

const ROUTE_PROFILES = Object.freeze({
  testnet: TESTNET_PROFILE,
  mainnet: MAINNET_PROFILE,
});

function resolveProfile(deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  return normalizeDeploymentProfile(deploymentProfile);
}

function getProfile(deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const normalized = resolveProfile(deploymentProfile);
  return ROUTE_PROFILES[normalized];
}

export function getChain(chainKey, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const normalized = assertNonEmptyString("chainKey", chainKey);
  const canonical = CHAIN_ALIASES[normalized] ?? normalized;
  const profile = getProfile(deploymentProfile);
  const chain = profile.chains[canonical];
  if (!chain) {
    throw new Error(`unsupported chain: ${normalized}`);
  }

  return chain;
}

export function getAsset(assetKey, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  const normalized = assertNonEmptyString("assetKey", assetKey).toUpperCase();
  const profile = getProfile(deploymentProfile);
  const asset = profile.assets[normalized];
  if (!asset) {
    throw new Error(`unsupported asset: ${normalized}`);
  }

  return asset;
}

export function getParachainId(chainKey, deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  return getChain(chainKey, deploymentProfile).parachainId;
}

export function getAssetLocation(
  assetKey,
  chainKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const asset = getAsset(assetKey, deploymentProfile);
  const normalizedChain = getChain(chainKey, deploymentProfile).key;
  const location = asset.xcmLocations?.[normalizedChain];

  if (!location) {
    throw new Error(`missing XCM location for ${asset.symbol} on ${normalizedChain}`);
  }

  return location;
}

export function listRoutes(deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE) {
  return getProfile(deploymentProfile).routes.slice();
}

export function getRoute(
  sourceChain,
  destinationChain,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const normalizedSource = getChain(sourceChain, deploymentProfile).key;
  const normalizedDestination = getChain(destinationChain, deploymentProfile).key;

  const route = listRoutes(deploymentProfile).find(
    (candidate) =>
      candidate.sourceChain === normalizedSource &&
      candidate.destinationChain === normalizedDestination,
  );

  if (!route) {
    throw new Error(`unsupported route: ${normalizedSource} -> ${normalizedDestination}`);
  }

  return route;
}

export function assertTransferRoute(
  sourceChain,
  destinationChain,
  assetKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const asset = getAsset(assetKey, deploymentProfile);
  const path = findTransferPath(sourceChain, destinationChain, asset.symbol, deploymentProfile);
  if (!path) {
    throw new Error(
      `asset ${asset.symbol} is not transferable on ${getChain(sourceChain, deploymentProfile).key} -> ${getChain(destinationChain, deploymentProfile).key}`,
    );
  }

  return Object.freeze({
    sourceChain: path[0],
    destinationChain: path[path.length - 1],
    path,
    action: ACTION_TYPES.TRANSFER,
  });
}

export function assertSwapRoute(
  sourceChain,
  destinationChain,
  assetInKey,
  assetOutKey,
  settlementChain = destinationChain,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const normalizedSource = getChain(sourceChain, deploymentProfile).key;
  const normalizedDestination = getChain(destinationChain, deploymentProfile).key;
  const normalizedSettlement = getChain(settlementChain, deploymentProfile).key;
  const assetIn = getAsset(assetInKey, deploymentProfile);
  const assetOut = getAsset(assetOutKey, deploymentProfile);
  const executionPath = findTransferPath(
    normalizedSource,
    normalizedDestination,
    assetIn.symbol,
    deploymentProfile,
  );
  if (!executionPath) {
    throw new Error(
      `asset ${assetIn.symbol} cannot reach ${normalizedDestination} from ${normalizedSource}`,
    );
  }

  const route = listRoutes(deploymentProfile).find(
    (candidate) =>
      candidate.destinationChain === normalizedDestination &&
      candidate.actions.includes(ACTION_TYPES.SWAP),
  );
  if (!route) {
    throw new Error(`unsupported swap destination: ${normalizedDestination}`);
  }

  const supported = route.swapPairs.some(
    (pair) =>
      pair.assetIn === assetIn.symbol &&
      pair.assetOut === assetOut.symbol &&
      pair.settlementChains.includes(normalizedSettlement),
  );
  if (!supported) {
    throw new Error(
      `swap ${assetIn.symbol} -> ${assetOut.symbol} is not supported on ${normalizedSource} -> ${normalizedDestination} for settlement on ${normalizedSettlement}`,
    );
  }

  if (normalizedSettlement !== normalizedDestination) {
    const settlementPath = findTransferPath(
      normalizedDestination,
      normalizedSettlement,
      assetOut.symbol,
      deploymentProfile,
    );
    if (!settlementPath) {
      throw new Error(
        `asset ${assetOut.symbol} cannot settle from ${normalizedDestination} to ${normalizedSettlement}`,
      );
    }
  }

  return Object.freeze({
    sourceChain: normalizedSource,
    destinationChain: normalizedDestination,
    settlementChain: normalizedSettlement,
    executionPath,
    action: ACTION_TYPES.SWAP,
  });
}

export function assertExecuteRoute(
  sourceChain,
  destinationChain,
  assetKey,
  executionType = EXECUTION_TYPES.RUNTIME_CALL,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const asset = getAsset(assetKey, deploymentProfile);
  const normalizedSource = getChain(sourceChain, deploymentProfile).key;
  const normalizedDestination = getChain(destinationChain, deploymentProfile).key;
  const transferPath = findTransferPath(
    normalizedSource,
    normalizedDestination,
    asset.symbol,
    deploymentProfile,
  );
  if (!transferPath) {
    throw new Error(
      `asset ${asset.symbol} cannot reach ${normalizedDestination} from ${normalizedSource}`,
    );
  }

  const route = listRoutes(deploymentProfile).find(
    (candidate) =>
      candidate.destinationChain === normalizedDestination &&
      candidate.actions.includes(ACTION_TYPES.EXECUTE) &&
      candidate.executeTypes.includes(executionType),
  );
  if (!route) {
    throw new Error(
      `execution type ${executionType} is not supported on destination ${normalizedDestination}`,
    );
  }
  if (!route.executeAssets.includes(asset.symbol)) {
    throw new Error(
      `asset ${asset.symbol} is not supported for execute on ${normalizedSource} -> ${normalizedDestination}`,
    );
  }

  return Object.freeze({
    sourceChain: normalizedSource,
    destinationChain: normalizedDestination,
    path: transferPath,
    executionType,
    action: ACTION_TYPES.EXECUTE,
  });
}

export function findTransferPath(
  sourceChain,
  destinationChain,
  assetKey,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const normalizedSource = getChain(sourceChain, deploymentProfile).key;
  const normalizedDestination = getChain(destinationChain, deploymentProfile).key;
  const asset = getAsset(assetKey, deploymentProfile);
  if (normalizedSource === normalizedDestination) {
    return Object.freeze([normalizedSource]);
  }

  const queue = [
    {
      chain: normalizedSource,
      path: [normalizedSource],
    },
  ];
  const visited = new Set([normalizedSource]);
  const routes = listRoutes(deploymentProfile);

  while (queue.length > 0) {
    const current = queue.shift();
    const nextRoutes = routes.filter(
      (candidate) =>
        candidate.sourceChain === current.chain &&
        candidate.actions.includes(ACTION_TYPES.TRANSFER) &&
        candidate.transferableAssets.includes(asset.symbol),
    );

    for (const route of nextRoutes) {
      if (visited.has(route.destinationChain)) {
        continue;
      }

      const nextPath = current.path.concat(route.destinationChain);
      if (route.destinationChain === normalizedDestination) {
        return Object.freeze(nextPath);
      }

      visited.add(route.destinationChain);
      queue.push({
        chain: route.destinationChain,
        path: nextPath,
      });
    }
  }

  return null;
}

export function assertSupportedDeploymentProfile(profile) {
  return assertIncluded(
    "deploymentProfile",
    resolveProfile(profile),
    Object.keys(ROUTE_PROFILES),
  );
}
