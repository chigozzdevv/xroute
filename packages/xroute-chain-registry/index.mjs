import { ACTION_TYPES, assertIncluded, assertNonEmptyString } from "../xroute-types/index.mjs";

export const CHAINS = Object.freeze({
  "polkadot-hub": Object.freeze({
    key: "polkadot-hub",
    label: "Polkadot Hub",
    parachainId: 1000,
    supportedActions: Object.freeze([
      ACTION_TYPES.TRANSFER,
      ACTION_TYPES.SWAP,
    ]),
  }),
  hydration: Object.freeze({
    key: "hydration",
    label: "Hydration",
    parachainId: 2034,
    supportedActions: Object.freeze([
      ACTION_TYPES.TRANSFER,
      ACTION_TYPES.SWAP,
    ]),
  }),
});

const CHAIN_ALIASES = Object.freeze({
  "asset-hub": "polkadot-hub",
});

export const ASSETS = Object.freeze({
  DOT: Object.freeze({
    symbol: "DOT",
    decimals: 10,
    supportedChains: Object.freeze(["polkadot-hub", "hydration"]),
    xcmLocations: Object.freeze({
      "polkadot-hub": Object.freeze({
        parents: 1,
        interior: Object.freeze({ type: "here" }),
      }),
      hydration: Object.freeze({
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
});

const USER_ROUTES = Object.freeze([
  Object.freeze({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    path: Object.freeze(["polkadot-hub", "hydration"]),
    actions: Object.freeze([
      ACTION_TYPES.TRANSFER,
      ACTION_TYPES.SWAP,
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
  }),
  Object.freeze({
    sourceChain: "hydration",
    destinationChain: "polkadot-hub",
    path: Object.freeze(["hydration", "polkadot-hub"]),
    actions: Object.freeze([ACTION_TYPES.TRANSFER]),
    transferableAssets: Object.freeze(["DOT", "USDT", "HDX"]),
    swapPairs: Object.freeze([]),
  }),
]);

export function getChain(chainKey) {
  const normalized = assertNonEmptyString("chainKey", chainKey);
  const canonical = CHAIN_ALIASES[normalized] ?? normalized;
  const chain = CHAINS[canonical];
  if (!chain) {
    throw new Error(`unsupported chain: ${normalized}`);
  }

  return chain;
}

export function getAsset(assetKey) {
  const normalized = assertNonEmptyString("assetKey", assetKey).toUpperCase();
  const asset = ASSETS[normalized];
  if (!asset) {
    throw new Error(`unsupported asset: ${normalized}`);
  }

  return asset;
}

export function getParachainId(chainKey) {
  return getChain(chainKey).parachainId;
}

export function getAssetLocation(assetKey, chainKey) {
  const asset = getAsset(assetKey);
  const normalizedChain = getChain(chainKey).key;
  const location = asset.xcmLocations?.[normalizedChain];

  if (!location) {
    throw new Error(`missing XCM location for ${asset.symbol} on ${normalizedChain}`);
  }

  return location;
}

export function listRoutes() {
  return USER_ROUTES.slice();
}

export function getRoute(sourceChain, destinationChain) {
  const normalizedSource = getChain(sourceChain).key;
  const normalizedDestination = getChain(destinationChain).key;

  const route = USER_ROUTES.find(
    (candidate) =>
      candidate.sourceChain === normalizedSource &&
      candidate.destinationChain === normalizedDestination,
  );

  if (!route) {
    throw new Error(`unsupported route: ${normalizedSource} -> ${normalizedDestination}`);
  }

  return route;
}

export function assertTransferRoute(sourceChain, destinationChain, assetKey) {
  const asset = getAsset(assetKey);
  const route = getRoute(sourceChain, destinationChain);
  assertIncluded("action", ACTION_TYPES.TRANSFER, route.actions);

  if (!route.transferableAssets.includes(asset.symbol)) {
    throw new Error(
      `asset ${asset.symbol} is not transferable on ${route.sourceChain} -> ${route.destinationChain}`,
    );
  }

  return route;
}

export function assertSwapRoute(
  sourceChain,
  destinationChain,
  assetInKey,
  assetOutKey,
  settlementChain = destinationChain,
) {
  const route = getRoute(sourceChain, destinationChain);
  assertIncluded("action", ACTION_TYPES.SWAP, route.actions);
  const assetIn = getAsset(assetInKey);
  const assetOut = getAsset(assetOutKey);

  const supported = route.swapPairs.some(
    (pair) =>
      pair.assetIn === assetIn.symbol &&
      pair.assetOut === assetOut.symbol &&
      pair.settlementChains.includes(getChain(settlementChain).key),
  );
  if (!supported) {
    throw new Error(
      `swap ${assetIn.symbol} -> ${assetOut.symbol} is not supported on ${route.sourceChain} -> ${route.destinationChain} for settlement on ${getChain(settlementChain).key}`,
    );
  }

  return route;
}
