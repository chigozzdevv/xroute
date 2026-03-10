import {
  DEFAULT_DEPLOYMENT_PROFILE,
  DEPLOYMENT_PROFILES,
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

function capability(executionType, assets) {
  return Object.freeze({
    executionType,
    assets: Object.freeze([...assets]),
  });
}

function route({
  sourceChain,
  destinationChain,
  actions,
  transferableAssets = [],
  swapPairs = [],
  executeCapabilities = [],
}) {
  return Object.freeze({
    sourceChain,
    destinationChain,
    path: Object.freeze([sourceChain, destinationChain]),
    actions: Object.freeze([...actions]),
    transferableAssets: Object.freeze([...transferableAssets]),
    swapPairs: Object.freeze(
      swapPairs.map((pair) =>
        Object.freeze({
          ...pair,
          settlementChains: Object.freeze([...pair.settlementChains]),
        }),
      ),
    ),
    executeCapabilities: Object.freeze([...executeCapabilities]),
  });
}

const PASEO_PROFILE = Object.freeze({
  chains: Object.freeze({
    "polkadot-hub": Object.freeze({
      key: "polkadot-hub",
      label: "Polkadot Hub",
      parachainId: 1000,
      transitEnabled: true,
      supportedActions: Object.freeze([ACTION_TYPES.TRANSFER]),
    }),
    people: Object.freeze({
      key: "people",
      label: "People Chain",
      parachainId: 1004,
      transitEnabled: false,
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
    route({
      sourceChain: "polkadot-hub",
      destinationChain: "people",
      actions: [ACTION_TYPES.TRANSFER],
      transferableAssets: ["PAS"],
    }),
  ]),
});

const FULL_GRAPH_CHAINS = Object.freeze({
    "polkadot-hub": Object.freeze({
      key: "polkadot-hub",
      label: "Polkadot Hub",
      parachainId: 1000,
      transitEnabled: true,
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
      transitEnabled: true,
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
      transitEnabled: true,
      supportedActions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.EXECUTE,
      ]),
    }),
    bifrost: Object.freeze({
      key: "bifrost",
      label: "Bifrost",
      parachainId: 2030,
      transitEnabled: false,
      supportedActions: Object.freeze([
        ACTION_TYPES.TRANSFER,
        ACTION_TYPES.EXECUTE,
      ]),
    }),
  });

const FULL_GRAPH_ASSETS = Object.freeze({
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
      supportedChains: Object.freeze(["bifrost", "moonbeam", "hydration"]),
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
        moonbeam: Object.freeze({
          parents: 1,
          interior: Object.freeze({
            type: "x2",
            value: Object.freeze([
              Object.freeze({ type: "parachain", value: 2030 }),
              Object.freeze({ type: "general-key", value: "0x0900" }),
            ]),
          }),
        }),
        hydration: Object.freeze({
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
  });

const FULL_GRAPH_ROUTES = Object.freeze([
  route({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    actions: [ACTION_TYPES.TRANSFER, ACTION_TYPES.EXECUTE],
    transferableAssets: ["DOT"],
    executeCapabilities: [
      capability(EXECUTION_TYPES.RUNTIME_CALL, ["DOT"]),
      capability(EXECUTION_TYPES.EVM_CONTRACT_CALL, ["DOT"]),
    ],
  }),
  route({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    actions: [ACTION_TYPES.TRANSFER, ACTION_TYPES.SWAP, ACTION_TYPES.EXECUTE],
    transferableAssets: ["DOT"],
    swapPairs: [
      {
        assetIn: "DOT",
        assetOut: "USDT",
        settlementChains: ["hydration", "polkadot-hub"],
      },
      {
        assetIn: "DOT",
        assetOut: "HDX",
        settlementChains: ["hydration", "polkadot-hub"],
      },
    ],
    executeCapabilities: [
      capability(EXECUTION_TYPES.RUNTIME_CALL, ["DOT"]),
    ],
  }),
  route({
    sourceChain: "hydration",
    destinationChain: "polkadot-hub",
    actions: [ACTION_TYPES.TRANSFER],
    transferableAssets: ["DOT", "USDT", "HDX"],
  }),
  route({
    sourceChain: "moonbeam",
    destinationChain: "polkadot-hub",
    actions: [ACTION_TYPES.TRANSFER],
    transferableAssets: ["DOT"],
  }),
  route({
    sourceChain: "moonbeam",
    destinationChain: "bifrost",
    actions: [ACTION_TYPES.TRANSFER, ACTION_TYPES.EXECUTE],
    transferableAssets: ["DOT", "VDOT"],
    executeCapabilities: [
      capability(EXECUTION_TYPES.RUNTIME_CALL, ["DOT"]),
      capability(EXECUTION_TYPES.VTOKEN_ORDER, ["DOT", "VDOT"]),
    ],
  }),
  route({
    sourceChain: "bifrost",
    destinationChain: "moonbeam",
    actions: [ACTION_TYPES.TRANSFER],
    transferableAssets: ["DOT", "VDOT"],
  }),
  route({
    sourceChain: "hydration",
    destinationChain: "bifrost",
    actions: [ACTION_TYPES.TRANSFER, ACTION_TYPES.EXECUTE],
    transferableAssets: ["DOT", "VDOT"],
    executeCapabilities: [
      capability(EXECUTION_TYPES.RUNTIME_CALL, ["DOT"]),
      capability(EXECUTION_TYPES.VTOKEN_ORDER, ["DOT", "VDOT"]),
    ],
  }),
  route({
    sourceChain: "bifrost",
    destinationChain: "hydration",
    actions: [ACTION_TYPES.TRANSFER],
    transferableAssets: ["DOT", "VDOT"],
  }),
]);

const FULL_GRAPH_PROFILE = Object.freeze({
  chains: FULL_GRAPH_CHAINS,
  assets: FULL_GRAPH_ASSETS,
  routes: FULL_GRAPH_ROUTES,
});

function subsetProfile({ chains, assets, routes }) {
  return Object.freeze({
    chains: Object.freeze(
      Object.fromEntries(chains.map((chainKey) => [chainKey, FULL_GRAPH_CHAINS[chainKey]])),
    ),
    assets: Object.freeze(
      Object.fromEntries(assets.map((assetKey) => [assetKey, FULL_GRAPH_ASSETS[assetKey]])),
    ),
    routes: Object.freeze(
      FULL_GRAPH_ROUTES.filter((candidate) =>
        routes.some(
          (routeKey) =>
            routeKey.sourceChain === candidate.sourceChain &&
            routeKey.destinationChain === candidate.destinationChain,
        ),
      ),
    ),
  });
}

const HYDRATION_SNAKENET_PROFILE = subsetProfile({
  chains: ["polkadot-hub", "hydration"],
  assets: ["DOT", "USDT", "HDX"],
  routes: [
    { sourceChain: "polkadot-hub", destinationChain: "hydration" },
    { sourceChain: "hydration", destinationChain: "polkadot-hub" },
  ],
});

const MOONBASE_ALPHA_PROFILE = subsetProfile({
  chains: ["polkadot-hub", "moonbeam"],
  assets: ["DOT"],
  routes: [
    { sourceChain: "polkadot-hub", destinationChain: "moonbeam" },
    { sourceChain: "moonbeam", destinationChain: "polkadot-hub" },
  ],
});

const BIFROST_VIA_HYDRATION_PROFILE = subsetProfile({
  chains: ["hydration", "bifrost"],
  assets: ["DOT", "VDOT"],
  routes: [
    { sourceChain: "hydration", destinationChain: "bifrost" },
    { sourceChain: "bifrost", destinationChain: "hydration" },
  ],
});

const BIFROST_VIA_MOONBASE_ALPHA_PROFILE = subsetProfile({
  chains: ["moonbeam", "bifrost"],
  assets: ["DOT", "VDOT"],
  routes: [
    { sourceChain: "moonbeam", destinationChain: "bifrost" },
    { sourceChain: "bifrost", destinationChain: "moonbeam" },
  ],
});

const INTEGRATION_PROFILE = FULL_GRAPH_PROFILE;
const MAINNET_PROFILE = FULL_GRAPH_PROFILE;

const ROUTE_PROFILES = Object.freeze({
  [DEPLOYMENT_PROFILES.PASEO]: PASEO_PROFILE,
  [DEPLOYMENT_PROFILES.HYDRATION_SNAKENET]: HYDRATION_SNAKENET_PROFILE,
  [DEPLOYMENT_PROFILES.MOONBASE_ALPHA]: MOONBASE_ALPHA_PROFILE,
  [DEPLOYMENT_PROFILES.BIFROST_VIA_HYDRATION]: BIFROST_VIA_HYDRATION_PROFILE,
  [DEPLOYMENT_PROFILES.BIFROST_VIA_MOONBASE_ALPHA]: BIFROST_VIA_MOONBASE_ALPHA_PROFILE,
  [DEPLOYMENT_PROFILES.INTEGRATION]: INTEGRATION_PROFILE,
  [DEPLOYMENT_PROFILES.MAINNET]: MAINNET_PROFILE,
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

  const routeMatch = listRoutes(deploymentProfile).find(
    (candidate) =>
      candidate.sourceChain === normalizedSource &&
      candidate.destinationChain === normalizedDestination,
  );

  if (!routeMatch) {
    throw new Error(`unsupported route: ${normalizedSource} -> ${normalizedDestination}`);
  }

  return routeMatch;
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

  const routeMatch = listRoutes(deploymentProfile).find(
    (candidate) =>
      candidate.destinationChain === normalizedDestination &&
      candidate.actions.includes(ACTION_TYPES.SWAP),
  );
  if (!routeMatch) {
    throw new Error(`unsupported swap destination: ${normalizedDestination}`);
  }

  const supported = routeMatch.swapPairs.some(
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

  const routeMatch = listRoutes(deploymentProfile).find(
    (candidate) =>
      candidate.destinationChain === normalizedDestination &&
      candidate.actions.includes(ACTION_TYPES.EXECUTE),
  );
  if (!routeMatch) {
    throw new Error(
      `execution type ${executionType} is not supported on destination ${normalizedDestination}`,
    );
  }

  const executeCapability = routeMatch.executeCapabilities.find(
    (candidate) => candidate.executionType === executionType,
  );
  if (!executeCapability) {
    throw new Error(
      `execution type ${executionType} is not supported on destination ${normalizedDestination}`,
    );
  }
  if (!executeCapability.assets.includes(asset.symbol)) {
    throw new Error(
      `asset ${asset.symbol} is not supported for ${executionType} on ${normalizedSource} -> ${normalizedDestination}`,
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
    if (
      current.chain !== normalizedSource &&
      current.chain !== normalizedDestination &&
      !getChain(current.chain, deploymentProfile).transitEnabled
    ) {
      continue;
    }

    const nextRoutes = routes.filter(
      (candidate) =>
        candidate.sourceChain === current.chain &&
        candidate.actions.includes(ACTION_TYPES.TRANSFER) &&
        candidate.transferableAssets.includes(asset.symbol),
    );

    for (const transferRoute of nextRoutes) {
      if (visited.has(transferRoute.destinationChain)) {
        continue;
      }

      const nextPath = current.path.concat(transferRoute.destinationChain);
      if (transferRoute.destinationChain === normalizedDestination) {
        return Object.freeze(nextPath);
      }

      visited.add(transferRoute.destinationChain);
      queue.push({
        chain: transferRoute.destinationChain,
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
