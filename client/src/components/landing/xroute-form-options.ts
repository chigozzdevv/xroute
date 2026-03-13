import {
  ACTION_TYPES,
  EXECUTION_TYPES,
} from "../../../../packages/xroute-types/index.mjs";
import {
  assertExecuteRoute,
  assertSwapRoute,
  assertTransferRoute,
  getChain,
  listAssets,
  listChains,
  listRoutes,
} from "../../../../packages/xroute-chain-registry/index.mjs";

export type ChainKey = "polkadot-hub" | "hydration" | "moonbeam" | "bifrost";
export type AssetKey = "DOT" | "USDT" | "HDX" | "VDOT";
export type ExecuteType = "call" | "mint-vdot" | "redeem-vdot";

export type Option<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

const DEPLOYMENT_PROFILE = "mainnet";
const ROUTES = listRoutes(DEPLOYMENT_PROFILE);
const DISABLED_CHAINS = new Set<ChainKey>(["bifrost"]);
const DISABLED_EXECUTION_TYPES = new Set<ExecuteType>(["mint-vdot", "redeem-vdot"]);
const EXECUTE_LABELS: Record<ExecuteType, string> = {
  call: "Call",
  "mint-vdot": "Mint vDOT",
  "redeem-vdot": "Redeem vDOT",
};

function option<T extends string>(value: T, label: string, disabled = false): Option<T> {
  return Object.freeze({ value, label, disabled });
}

function isChainDisabled(chainKey: ChainKey) {
  return DISABLED_CHAINS.has(chainKey);
}

function isExecuteTypeDisabled(executionType: ExecuteType) {
  return DISABLED_EXECUTION_TYPES.has(executionType);
}

function canUseTransferSurface(sourceChain: ChainKey, destinationChain: ChainKey) {
  return ALL_ASSET_KEYS.some((assetKey) => canTransferAsset(assetKey, sourceChain, destinationChain));
}

function supportsExecuteRoute(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  assetKey: AssetKey,
  executionType: ExecuteType,
) {
  if (executionType !== "call") {
    return false;
  }

  try {
    assertExecuteRoute(
      sourceChain,
      destinationChain,
      assetKey,
      executionType,
      DEPLOYMENT_PROFILE,
    );
    return true;
  } catch {
    return false;
  }
}

function supportsSwapRoute(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  assetIn: AssetKey,
  assetOut: AssetKey,
  settlementChain: ChainKey,
) {
  try {
    assertSwapRoute(
      sourceChain,
      destinationChain,
      assetIn,
      assetOut,
      settlementChain,
      DEPLOYMENT_PROFILE,
    );
    return true;
  } catch {
    return false;
  }
}

const ALL_CHAIN_KEYS = listChains(DEPLOYMENT_PROFILE).map(
  (chain) => chain.key as ChainKey,
);
const ALL_ASSET_KEYS = listAssets(DEPLOYMENT_PROFILE).map(
  (asset) => asset.symbol as AssetKey,
);
const SWAP_DESTINATIONS = [
  ...new Set(
    ROUTES.filter((route) => route.actions.includes(ACTION_TYPES.SWAP)).map(
      (route) => route.destinationChain as ChainKey,
    ),
  ),
];
const SWAP_DESTINATION = (SWAP_DESTINATIONS[0] ?? "hydration") as "hydration";
const SWAP_PAIRS = ROUTES.filter(
  (route) =>
    route.destinationChain === SWAP_DESTINATION &&
    route.actions.includes(ACTION_TYPES.SWAP),
).flatMap((route) => route.swapPairs);

export const chainOptions: readonly Option<ChainKey>[] = Object.freeze(
  ALL_CHAIN_KEYS.map((chainKey) => {
    const chain = getChain(chainKey, DEPLOYMENT_PROFILE);
    return option(chain.key, chain.label, isChainDisabled(chain.key));
  }),
);

export const assetOptions: readonly Option<AssetKey>[] = Object.freeze(
  ALL_ASSET_KEYS.map((assetKey) => {
    const asset = listAssets(DEPLOYMENT_PROFILE).find(
      (candidate) => candidate.symbol === assetKey,
    );
    return option(assetKey, asset?.symbol ?? assetKey);
  }),
);

export const swapDestinationChain: "hydration" = SWAP_DESTINATION;
const derivedSwapSourceChains = [
  ...new Set(
    ROUTES.filter(
      (route) =>
        route.destinationChain === SWAP_DESTINATION &&
        route.actions.includes(ACTION_TYPES.SWAP),
    ).map((route) => route.sourceChain as "polkadot-hub" | "moonbeam"),
  ),
];

export const swapSourceChainOptions: readonly Option<
  "polkadot-hub" | "moonbeam"
>[] = Object.freeze(
  derivedSwapSourceChains.map((chainKey) => {
    const chain = getChain(chainKey, DEPLOYMENT_PROFILE);
    return option(chain.key, chain.label, isChainDisabled(chain.key));
  }),
);

export const swapAssetInOptions: readonly Option<"DOT">[] = Object.freeze(
  [...new Set(SWAP_PAIRS.map((pair) => pair.assetIn as "DOT"))].map((assetKey) =>
    option(assetKey, assetKey),
  ),
);

export function getSwapAssetOutOptions(
  assetIn: "DOT" = "DOT",
): readonly Option<"USDT" | "HDX">[] {
  return Object.freeze(
    [...new Set(
      SWAP_PAIRS.filter((pair) => pair.assetIn === assetIn).map(
        (pair) => pair.assetOut as "USDT" | "HDX",
      ),
    )].map((assetKey) => option(assetKey, assetKey)),
  );
}

export const swapAssetOutOptions = getSwapAssetOutOptions();

export const swapSettlementChainOptions: readonly Option<
  "hydration" | "polkadot-hub"
>[] = Object.freeze(
  [...new Set(
    SWAP_PAIRS.flatMap((pair) => pair.settlementChains as ("hydration" | "polkadot-hub")[]),
  )].map((chainKey) => {
    const chain = getChain(chainKey, DEPLOYMENT_PROFILE);
    return option(chain.key, chain.label, isChainDisabled(chain.key));
  }),
);

export function getSwapSettlementChainOptions(assetOut: "USDT" | "HDX") {
  return Object.freeze(
    swapSettlementChainOptions.map((candidate) => ({
      ...candidate,
      disabled:
        candidate.disabled ||
        !derivedSwapSourceChains.some((sourceChain) =>
          supportsSwapRoute(sourceChain, SWAP_DESTINATION, "DOT", assetOut, candidate.value),
        ),
    })),
  );
}

export const executeDestinationChain = "moonbeam" as const;
export const executeTypeOptions: readonly Option<ExecuteType>[] = Object.freeze(
  (Object.values(EXECUTION_TYPES) as ExecuteType[]).map((executionType) =>
    option(
      executionType,
      EXECUTE_LABELS[executionType],
      isExecuteTypeDisabled(executionType) ||
        !ALL_CHAIN_KEYS.some((sourceChain) =>
          sourceChain !== executeDestinationChain &&
          supportsExecuteRoute(sourceChain, executeDestinationChain, executeAssetForType(executionType), executionType),
        ),
    ),
  ),
);

export const EXAMPLE_EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
export const EXAMPLE_SS58_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const EXAMPLE_ADAPTER_ADDRESS = "0x2222222222222222222222222222222222222222";

export function chainLabel(chainKey: ChainKey) {
  return getChain(chainKey, DEPLOYMENT_PROFILE).label;
}

export function executeAssetForType(executionType: ExecuteType): AssetKey {
  return executionType === "redeem-vdot" ? "VDOT" : "DOT";
}

export function getExecuteSourceChainOptions(
  executionType: ExecuteType,
): readonly Option<"polkadot-hub" | "hydration" | "bifrost">[] {
  const destinationChain = executeDestinationChain;

  return Object.freeze(
    chainOptions
      .filter(
        (
          candidate,
        ): candidate is Option<"polkadot-hub" | "hydration" | "bifrost"> =>
          candidate.value !== destinationChain,
      )
      .map((candidate) => {
        const chainKey = candidate.value;
        return {
          ...candidate,
          disabled:
            candidate.disabled ||
            !supportsExecuteRoute(
              chainKey,
              destinationChain,
              executeAssetForType(executionType),
              executionType,
            ),
        };
      }),
  );
}

export function getTransferDestinationOptions(sourceChain: ChainKey) {
  return Object.freeze(
    chainOptions
      .filter((candidate) => candidate.value !== sourceChain)
      .map((candidate) => ({
        ...candidate,
        disabled:
          candidate.disabled || !canUseTransferSurface(sourceChain, candidate.value),
      })),
  );
}

export function getTransferAssetOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
) {
  return Object.freeze(
    assetOptions.map((candidate) => ({
      ...candidate,
      disabled:
        candidate.disabled || !canTransferAsset(candidate.value, sourceChain, destinationChain),
    })),
  );
}

export function canTransferAsset(
  asset: AssetKey,
  sourceChain: ChainKey,
  destinationChain: ChainKey,
) {
  if (sourceChain === destinationChain) {
    return false;
  }
  if (isChainDisabled(sourceChain) || isChainDisabled(destinationChain)) {
    return false;
  }

  try {
    assertTransferRoute(sourceChain, destinationChain, asset, DEPLOYMENT_PROFILE);
    return true;
  } catch {
    return false;
  }
}

export function evmAddressLabelForChain(chainKey: ChainKey) {
  return chainKey === "polkadot-hub" || chainKey === "moonbeam";
}

export function recipientLabelForChain(chainKey: ChainKey) {
  return evmAddressLabelForChain(chainKey)
    ? "Recipient (EVM address)"
    : "Recipient (SS58 address)";
}

export function exampleRecipientForChain(chainKey: ChainKey) {
  return evmAddressLabelForChain(chainKey) ? EXAMPLE_EVM_ADDRESS : EXAMPLE_SS58_ADDRESS;
}

export function coerceOptionValue<T extends string>(
  currentValue: T,
  options: readonly Option<T>[],
) {
  const currentOption = options.find((candidate) => candidate.value === currentValue);
  if (currentOption && !currentOption.disabled) {
    return currentValue;
  }

  return options.find((candidate) => !candidate.disabled)?.value ?? options[0]?.value;
}
