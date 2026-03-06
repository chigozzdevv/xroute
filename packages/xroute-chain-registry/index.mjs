import { ACTION_TYPES, assertIncluded, assertNonEmptyString } from "../xroute-types/index.mjs";

export const CHAINS = Object.freeze({
  "polkadot-hub": Object.freeze({
    key: "polkadot-hub",
    label: "Polkadot Hub",
    supportedActions: Object.freeze([
      ACTION_TYPES.TRANSFER,
      ACTION_TYPES.SWAP,
      ACTION_TYPES.STAKE,
      ACTION_TYPES.CALL,
    ]),
  }),
  hydration: Object.freeze({
    key: "hydration",
    label: "Hydration",
    supportedActions: Object.freeze([
      ACTION_TYPES.TRANSFER,
      ACTION_TYPES.SWAP,
      ACTION_TYPES.CALL,
    ]),
  }),
  "asset-hub": Object.freeze({
    key: "asset-hub",
    label: "Asset Hub",
    supportedActions: Object.freeze([ACTION_TYPES.TRANSFER]),
  }),
});

export const ASSETS = Object.freeze({
  DOT: Object.freeze({
    symbol: "DOT",
    decimals: 10,
    supportedChains: Object.freeze(["polkadot-hub", "hydration", "asset-hub"]),
  }),
  USDT: Object.freeze({
    symbol: "USDT",
    decimals: 6,
    supportedChains: Object.freeze(["hydration", "asset-hub"]),
  }),
  HDX: Object.freeze({
    symbol: "HDX",
    decimals: 12,
    supportedChains: Object.freeze(["hydration"]),
  }),
});

export const ROUTES = Object.freeze([
  Object.freeze({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    actions: Object.freeze([
      ACTION_TYPES.TRANSFER,
      ACTION_TYPES.SWAP,
      ACTION_TYPES.CALL,
    ]),
    transferableAssets: Object.freeze(["DOT"]),
    swapPairs: Object.freeze([{ assetIn: "DOT", assetOut: "USDT" }]),
  }),
  Object.freeze({
    sourceChain: "polkadot-hub",
    destinationChain: "asset-hub",
    actions: Object.freeze([ACTION_TYPES.TRANSFER]),
    transferableAssets: Object.freeze(["DOT"]),
    swapPairs: Object.freeze([]),
  }),
]);

export function getChain(chainKey) {
  const normalized = assertNonEmptyString("chainKey", chainKey);
  const chain = CHAINS[normalized];
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

export function listRoutes() {
  return ROUTES.slice();
}

export function getRoute(sourceChain, destinationChain) {
  const normalizedSource = getChain(sourceChain).key;
  const normalizedDestination = getChain(destinationChain).key;

  const route = ROUTES.find(
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

export function assertSwapRoute(sourceChain, destinationChain, assetInKey, assetOutKey) {
  const route = getRoute(sourceChain, destinationChain);
  assertIncluded("action", ACTION_TYPES.SWAP, route.actions);
  const assetIn = getAsset(assetInKey);
  const assetOut = getAsset(assetOutKey);

  const supported = route.swapPairs.some(
    (pair) => pair.assetIn === assetIn.symbol && pair.assetOut === assetOut.symbol,
  );
  if (!supported) {
    throw new Error(
      `swap ${assetIn.symbol} -> ${assetOut.symbol} is not supported on ${route.sourceChain} -> ${route.destinationChain}`,
    );
  }

  return route;
}
