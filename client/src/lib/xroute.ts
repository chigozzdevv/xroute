"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createXRouteClient } from "@xroute/sdk";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  getAssetDecimals,
  getChain,
  getChainWalletType,
  listAssets,
  listChains,
} from "@xroute/sdk/chains";
import {
  getExecuteOptions,
  getSwapOptions,
  getTransferOptions,
} from "@xroute/sdk/routes";

export type ChainKey = string;
export type AssetKey = string;
export type ExecuteType = string;

export type Option<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export const xrouteClient = createXRouteClient({
  apiKey: process.env.NEXT_PUBLIC_XROUTE_API_KEY?.trim() || undefined,
});

export type QuoteClient = typeof xrouteClient;
export type QuoteRequest = Parameters<QuoteClient["quote"]>[0];
export type QuoteResponse = Awaited<ReturnType<QuoteClient["quote"]>>;
export type QuoteIntent = QuoteResponse["intent"];
export type Quote = QuoteResponse["quote"];
export type QuoteAssetAmount = Quote["fees"]["totalFee"];
export type XRouteWalletConnection = Parameters<QuoteClient["connectWallet"]>;
export type TransferRequest = Parameters<QuoteClient["transfer"]>[0];
export type TransferResponse = Awaited<ReturnType<QuoteClient["transfer"]>>;
export type SwapRequest = Parameters<QuoteClient["swap"]>[0];
export type SwapResponse = Awaited<ReturnType<QuoteClient["swap"]>>;
export type ExecuteRequest = Parameters<QuoteClient["execute"]>[0];
export type ExecuteResponse = Awaited<ReturnType<QuoteClient["execute"]>>;
export type CallRequest = Parameters<QuoteClient["call"]>[0];
export type CallResponse = Awaited<ReturnType<QuoteClient["call"]>>;

export function connectXRouteWallet(...args: XRouteWalletConnection) {
  xrouteClient.connectWallet(...args);
  return xrouteClient;
}

export function disconnectXRouteWallet() {
  xrouteClient.disconnectWallet();
  return xrouteClient;
}

export function requestXRouteQuote(input: QuoteRequest) {
  return xrouteClient.quote(input);
}

export function requestXRouteTransfer(input: TransferRequest) {
  return xrouteClient.transfer(input);
}

export function requestXRouteSwap(input: SwapRequest) {
  return xrouteClient.swap(input);
}

export function requestXRouteExecute(input: ExecuteRequest) {
  return xrouteClient.execute(input);
}

export function requestXRouteCall(input: CallRequest) {
  return xrouteClient.call(input);
}

type UseXRouteQuoteOptions = {
  enabled?: boolean;
  debounceMs?: number;
};

export function useXRouteQuote(
  request: QuoteRequest | null,
  { enabled = true, debounceMs = 250 }: UseXRouteQuoteOptions = {},
) {
  const [result, setResult] = useState<QuoteResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<QuoteRequest | null>(request);

  const requestKey = useMemo(
    () => (request && enabled ? JSON.stringify(request) : null),
    [enabled, request],
  );

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    if (!requestKey) {
      setResult(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      const nextRequest = requestRef.current;
      if (!nextRequest || cancelled) {
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const nextResult = await requestXRouteQuote(nextRequest);
        if (cancelled) {
          return;
        }
        setResult(nextResult);
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        setResult(null);
        setError(nextError instanceof Error ? nextError.message : "quote failed");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [debounceMs, requestKey]);

  return {
    result,
    intent: result?.intent ?? null,
    quote: result?.quote ?? null,
    isLoading,
    error,
    isReady: Boolean(result) && !isLoading && !error,
  };
}

const DISABLED_CHAINS = new Set<ChainKey>(["bifrost"]);
const EXECUTE_LABELS: Record<string, string> = {
  call: "Call",
  "mint-vdot": "Mint vDOT",
  "redeem-vdot": "Redeem vDOT",
};

const CHAINS = listChains(DEFAULT_DEPLOYMENT_PROFILE);
const ASSETS = listAssets(DEFAULT_DEPLOYMENT_PROFILE);
const ALL_CHAIN_KEYS = CHAINS.map((chain) => chain.key as ChainKey);
const ALL_ASSET_KEYS = ASSETS.map((asset) => asset.symbol as AssetKey);

const SWAP_SOURCE_DETAILS = ALL_CHAIN_KEYS.map((sourceChain) => ({
  sourceChain,
  destinations: getSwapOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE),
})).filter((entry) => entry.destinations.length > 0);

const SWAP_DESTINATION =
  SWAP_SOURCE_DETAILS.flatMap((entry) => entry.destinations.map((destination) => destination.chain))[0] ??
  "hydration";

const SWAP_SOURCE_CHAINS = SWAP_SOURCE_DETAILS
  .filter((entry) => entry.destinations.some((destination) => destination.chain === SWAP_DESTINATION))
  .map((entry) => entry.sourceChain);

const SWAP_PAIR_RECORDS = SWAP_SOURCE_DETAILS.flatMap((entry) =>
  entry.destinations
    .filter((destination) => destination.chain === SWAP_DESTINATION)
    .flatMap((destination) =>
      destination.pairs.map((pair) => ({
        sourceChain: entry.sourceChain,
        ...pair,
      })),
    ),
);

const EXECUTE_SOURCE_DETAILS = ALL_CHAIN_KEYS.map((sourceChain) => ({
  sourceChain,
  destinations: getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE),
})).filter((entry) => entry.destinations.length > 0);

const EXECUTE_DESTINATION =
  EXECUTE_SOURCE_DETAILS.flatMap((entry) => entry.destinations.map((destination) => destination.chain))[0] ??
  "moonbeam";

const EXECUTE_CAPABILITY_RECORDS = EXECUTE_SOURCE_DETAILS.flatMap((entry) =>
  entry.destinations
    .filter((destination) => destination.chain === EXECUTE_DESTINATION)
    .flatMap((destination) =>
      destination.capabilities.map((capability) => ({
        sourceChain: entry.sourceChain,
        ...capability,
      })),
    ),
);

const EXECUTION_TYPES = [
  ...new Set(EXECUTE_CAPABILITY_RECORDS.map((record) => record.executionType)),
] as ExecuteType[];

function option<T extends string>(value: T, label: string, disabled = false): Option<T> {
  return Object.freeze({ value, label, disabled });
}

function isChainDisabled(chainKey: ChainKey) {
  return DISABLED_CHAINS.has(chainKey);
}

function getTransferDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getTransferOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).find(
    (candidate) => candidate.chain === destinationChain,
  );
}

function getExecuteTypeLabel(executionType: ExecuteType) {
  return EXECUTE_LABELS[executionType] ?? executionType;
}

export const chainOptions: readonly Option<ChainKey>[] = Object.freeze(
  CHAINS.map((chain) => option(chain.key, chain.label, isChainDisabled(chain.key))),
);

export const assetOptions: readonly Option<AssetKey>[] = Object.freeze(
  ASSETS.map((asset) => option(asset.symbol, asset.symbol)),
);

export const swapDestinationChain = SWAP_DESTINATION;
export const swapSourceChainOptions: readonly Option<ChainKey>[] = Object.freeze(
  SWAP_SOURCE_CHAINS.map((chainKey) => option(chainKey, chainLabel(chainKey), isChainDisabled(chainKey))),
);

export const swapAssetInOptions: readonly Option<AssetKey>[] = Object.freeze(
  [...new Set(SWAP_PAIR_RECORDS.map((pair) => pair.assetIn as AssetKey))].map((assetKey) =>
    option(assetKey, assetKey),
  ),
);

export function getSwapAssetOutOptions(assetIn = swapAssetInOptions[0]?.value ?? "DOT") {
  return Object.freeze(
    [
      ...new Set(
        SWAP_PAIR_RECORDS.filter((pair) => pair.assetIn === assetIn).map(
          (pair) => pair.assetOut as AssetKey,
        ),
      ),
    ].map((assetKey) => option(assetKey, assetKey)),
  );
}

export const swapAssetOutOptions = getSwapAssetOutOptions();
export const swapSettlementChainOptions: readonly Option<ChainKey>[] = Object.freeze(
  [...new Set(SWAP_PAIR_RECORDS.flatMap((pair) => pair.settlementChains as ChainKey[]))].map((chainKey) =>
    option(chainKey, chainLabel(chainKey), isChainDisabled(chainKey)),
  ),
);

export function getSwapSettlementChainOptions(assetOut: AssetKey) {
  const supportedSettlementChains = new Set<ChainKey>(
    SWAP_PAIR_RECORDS.filter((pair) => pair.assetOut === assetOut).flatMap(
      (pair) => pair.settlementChains,
    ),
  );

  return Object.freeze(
    swapSettlementChainOptions.map((candidate) => ({
      ...candidate,
      disabled: candidate.disabled || !supportedSettlementChains.has(candidate.value),
    })),
  );
}

export const executeDestinationChain = EXECUTE_DESTINATION;
export const executeTypeOptions: readonly Option<ExecuteType>[] = Object.freeze(
  EXECUTION_TYPES.map((executionType) =>
    option(
      executionType,
      getExecuteTypeLabel(executionType),
      !EXECUTE_CAPABILITY_RECORDS.some((record) => record.executionType === executionType),
    ),
  ),
);

export const EXAMPLE_EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
export const EXAMPLE_SS58_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const EXAMPLE_ADAPTER_ADDRESS = "0x2222222222222222222222222222222222222222";

export function chainLabel(chainKey: ChainKey) {
  return getChain(chainKey, DEFAULT_DEPLOYMENT_PROFILE).label;
}

export function executeAssetForType(executionType: ExecuteType): AssetKey {
  return (
    EXECUTE_CAPABILITY_RECORDS.find((record) => record.executionType === executionType)?.assets[0] ??
    ALL_ASSET_KEYS[0] ??
    "DOT"
  );
}

export function getExecuteSourceChainOptions(executionType: ExecuteType) {
  const supportedSources = new Set<ChainKey>(
    EXECUTE_CAPABILITY_RECORDS.filter((record) => record.executionType === executionType).map(
      (record) => record.sourceChain,
    ),
  );

  return Object.freeze(
    chainOptions
      .filter((candidate) => candidate.value !== executeDestinationChain)
      .map((candidate) => ({
        ...candidate,
        disabled: candidate.disabled || !supportedSources.has(candidate.value),
      })),
  );
}

export function getTransferDestinationOptions(sourceChain: ChainKey) {
  const supportedDestinations = new Set<ChainKey>(
    getTransferOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).map((candidate) => candidate.chain),
  );

  return Object.freeze(
    chainOptions
      .filter((candidate) => candidate.value !== sourceChain)
      .map((candidate) => ({
        ...candidate,
        disabled: candidate.disabled || !supportedDestinations.has(candidate.value),
      })),
  );
}

export function getTransferAssetOptions(sourceChain: ChainKey, destinationChain: ChainKey) {
  const supportedAssets = new Set<AssetKey>(
    getTransferDestinationRecord(sourceChain, destinationChain)?.assets ?? [],
  );

  return Object.freeze(
    assetOptions.map((candidate) => ({
      ...candidate,
      disabled: candidate.disabled || !supportedAssets.has(candidate.value),
    })),
  );
}

export function isEvmChain(chainKey: ChainKey) {
  return getChainWalletType(chainKey, DEFAULT_DEPLOYMENT_PROFILE) === "evm";
}

export function recipientLabelForChain(chainKey: ChainKey) {
  return isEvmChain(chainKey)
    ? "Recipient (EVM address)"
    : "Recipient (SS58 address)";
}

export function exampleRecipientForChain(chainKey: ChainKey) {
  return isEvmChain(chainKey) ? EXAMPLE_EVM_ADDRESS : EXAMPLE_SS58_ADDRESS;
}

export function coerceOptionValue<T extends string>(currentValue: T, options: readonly Option<T>[]) {
  const currentOption = options.find((candidate) => candidate.value === currentValue);
  if (currentOption && !currentOption.disabled) {
    return currentValue;
  }

  return options.find((candidate) => !candidate.disabled)?.value ?? options[0]?.value;
}

export { getAssetDecimals };
