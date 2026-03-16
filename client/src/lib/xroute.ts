"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createXRouteClient } from "@xroute/sdk";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  formatAssetAmount,
  formatUnits,
  getAssetDecimals,
  getChain,
  getChainWalletType,
  listAssets,
  listChains,
  parseAssetAmount,
} from "@xroute/sdk/chains";
import {
  getExecuteOptions,
  getSwapOptions,
  getTransferOptions,
} from "@xroute/sdk/routes";
import type { WalletKind, WalletSession, WalletSessions } from "@/hooks/use-wallet";

export type ChainKey = string;
export type AssetKey = string;
export type ExecuteType = string;
export type XRouteWalletKind = WalletKind;

export type Option<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

const PREVIEW_EVM_ACCOUNT_ADDRESS = "0x1111111111111111111111111111111111111111";
const PREVIEW_SUBSTRATE_ACCOUNT_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

export const xrouteClient = createXRouteClient({
  apiKey: process.env.NEXT_PUBLIC_XROUTE_API_KEY?.trim() || undefined,
});

const TX_EXPLORER_BASE_URLS = Object.freeze({
  "polkadot-hub":
    process.env.NEXT_PUBLIC_XROUTE_POLKADOT_HUB_EXPLORER_TX_URL?.trim()
    || "https://assethub-polkadot.subscan.io/extrinsic/",
  hydration:
    process.env.NEXT_PUBLIC_XROUTE_HYDRATION_EXPLORER_TX_URL?.trim()
    || "https://hydration.subscan.io/extrinsic/",
  moonbeam:
    process.env.NEXT_PUBLIC_XROUTE_MOONBEAM_EXPLORER_TX_URL?.trim()
    || "https://moonbeam.moonscan.io/tx/",
  bifrost:
    process.env.NEXT_PUBLIC_XROUTE_BIFROST_EXPLORER_TX_URL?.trim()
    || "https://bifrost-polkadot.subscan.io/extrinsic/",
});

export type QuoteClient = typeof xrouteClient;
export type QuoteRequest = Parameters<QuoteClient["quote"]>[0];
export type QuoteResponse = Awaited<ReturnType<QuoteClient["quote"]>>;
export type QuoteIntent = QuoteResponse["intent"];
export type Quote = QuoteResponse["quote"];
export type QuoteAssetAmount = Quote["fees"]["totalFee"];
export type QuoteSourceCosts = QuoteResponse["sourceCosts"];
export type SourceCostAmount = NonNullable<QuoteSourceCosts>["lockedAmount"];
export type XRouteWalletConnection = Parameters<QuoteClient["connectWallet"]>;
export type TransferRequest = Parameters<QuoteClient["transfer"]>[0];
export type TransferResponse = Awaited<ReturnType<QuoteClient["transfer"]>>;
export type SwapRequest = Parameters<QuoteClient["swap"]>[0];
export type SwapResponse = Awaited<ReturnType<QuoteClient["swap"]>>;
export type ExecuteRequest = Parameters<QuoteClient["execute"]>[0];
export type ExecuteResponse = Awaited<ReturnType<QuoteClient["execute"]>>;
export type CallRequest = Parameters<QuoteClient["call"]>[0];
export type CallResponse = Awaited<ReturnType<QuoteClient["call"]>>;
export type FlowRequest = Parameters<QuoteClient["runFlow"]>[0];
export type FlowResponse = Awaited<ReturnType<QuoteClient["runFlow"]>>;
export type IntentStatus = Awaited<ReturnType<QuoteClient["getStatus"]>>;
export type IntentTimeline = Awaited<ReturnType<QuoteClient["getTimeline"]>>;
type IntentTrackingSnapshot = {
  status?: IntentStatus | null;
  timeline?: IntentTimeline;
};

export function connectXRouteWallet(...args: XRouteWalletConnection) {
  xrouteClient.connectWallet(...args);
  return xrouteClient;
}

export function disconnectXRouteWallet() {
  xrouteClient.disconnectWallet();
  return xrouteClient;
}

export function disconnectXRouteWalletChain(chainKey: ChainKey) {
  (xrouteClient.disconnectWallet as (chainKey?: string | null) => QuoteClient)(chainKey);
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

export function requestXRouteFlow(input: FlowRequest) {
  return xrouteClient.runFlow(input);
}

export function trackXRouteIntent(intentId: string, options?: Parameters<QuoteClient["track"]>[1]) {
  return xrouteClient.track(intentId, options);
}

export function getXRouteIntentStatus(intentId: string) {
  return xrouteClient.getStatus(intentId);
}

export function getXRouteIntentTimeline(intentId: string) {
  return xrouteClient.getTimeline(intentId);
}

export function waitForXRouteIntent(intentId: string, options?: Parameters<QuoteClient["wait"]>[1]) {
  return xrouteClient.wait(intentId, options);
}

export function walletKindForChain(chainKey: ChainKey): XRouteWalletKind {
  return getChainWalletType(chainKey, DEFAULT_DEPLOYMENT_PROFILE);
}

export function getWalletSessionForChain(
  sessions: WalletSessions | null | undefined,
  chainKey: ChainKey,
): WalletSession | null {
  if (!sessions) {
    return null;
  }

  return sessions[walletKindForChain(chainKey)] ?? null;
}

export function walletMatchesChain(
  sessions: WalletSessions | null | undefined,
  chainKey: ChainKey,
) {
  return Boolean(getWalletSessionForChain(sessions, chainKey));
}

export function resolveWalletAccountForChain(
  sessions: WalletSessions | null | undefined,
  chainKey: ChainKey,
) {
  return getWalletSessionForChain(sessions, chainKey)?.account ?? null;
}

export function walletRequirementLabel(chainKey: ChainKey) {
  return walletKindForChain(chainKey) === "evm" ? "EVM wallet" : "Substrate wallet";
}

export function chainKeysForWalletKind(kind: XRouteWalletKind) {
  return ALL_CHAIN_KEYS.filter((chainKey) => walletKindForChain(chainKey) === kind);
}

export function previewAccountForChain(chainKey: ChainKey) {
  return walletKindForChain(chainKey) === "evm"
    ? PREVIEW_EVM_ACCOUNT_ADDRESS
    : PREVIEW_SUBSTRATE_ACCOUNT_ADDRESS;
}

export function connectWalletSessionForChain(
  sessions: WalletSessions,
  sourceChain: ChainKey,
) {
  const session = getWalletSessionForChain(sessions, sourceChain);
  const requiredKind = walletKindForChain(sourceChain);
  if (!session || session.kind !== requiredKind) {
    throw new Error(`Connect a ${walletRequirementLabel(sourceChain).toLowerCase()} for ${chainLabel(sourceChain)}.`);
  }

  if (session.kind === "evm") {
    return connectXRouteWallet("evm", {
      provider: session.provider,
      chainKey: sourceChain,
    });
  }

  return connectXRouteWallet("substrate", {
    extension: session.extensionSource,
    accountAddress: session.account,
    chainKey: sourceChain,
  });
}

export function toAssetUnits(assetKey: AssetKey, value: string) {
  return parseAssetAmount(assetKey, value, DEFAULT_DEPLOYMENT_PROFILE);
}

export function fromAssetUnits(assetKey: AssetKey, value: string | bigint) {
  return formatAssetAmount(assetKey, value, DEFAULT_DEPLOYMENT_PROFILE);
}

export function formatSourceCostAmount(
  amount: SourceCostAmount,
  options: { trimTrailingZeros?: boolean } = {},
) {
  return formatUnits(amount.amount, amount.decimals, options);
}

export function formatEstimatedTotalSpend(sourceCosts: QuoteSourceCosts) {
  if (!sourceCosts) {
    return null;
  }

  const { lockedAmount, gasFee } = sourceCosts;
  if (lockedAmount.asset === gasFee.asset) {
    const targetDecimals = Math.max(lockedAmount.decimals, gasFee.decimals);
    const lockedScale = BigInt(10) ** BigInt(targetDecimals - lockedAmount.decimals);
    const gasScale = BigInt(10) ** BigInt(targetDecimals - gasFee.decimals);

    return {
      kind: "single",
      value: {
        asset: lockedAmount.asset,
        amount: (lockedAmount.amount * lockedScale) + (gasFee.amount * gasScale),
        decimals: targetDecimals,
      },
    } as const;
  }

  return null;
}

export function canParseAssetUnits(assetKey: AssetKey, value: string) {
  try {
    toAssetUnits(assetKey, value);
    return true;
  } catch {
    return false;
  }
}

export function createTransferQuoteRequest({
  sourceChain,
  destinationChain,
  asset,
  amount,
  recipient,
  ownerAddress,
  deadline,
}: {
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  asset: AssetKey;
  amount: string;
  recipient?: string;
  ownerAddress?: string;
  deadline?: number;
}): QuoteRequest {
  return {
    sourceChain,
    destinationChain,
    ownerAddress: ownerAddress ?? previewAccountForChain(sourceChain),
    ...(deadline === undefined ? {} : { deadline }),
    asset,
    amount: toAssetUnits(asset, amount),
    recipient: recipient?.trim() || previewAccountForChain(destinationChain),
  };
}

export function createSwapQuoteRequest({
  sourceChain,
  destinationChain,
  assetIn,
  assetOut,
  amountIn,
  minAmountOut,
  settlementChain,
  recipient,
  ownerAddress,
  deadline,
}: {
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  assetIn: AssetKey;
  assetOut: AssetKey;
  amountIn: string;
  minAmountOut: string;
  settlementChain: ChainKey;
  recipient?: string;
  ownerAddress?: string;
  deadline?: number;
}): QuoteRequest {
  return {
    sourceChain,
    destinationChain,
    ownerAddress: ownerAddress ?? previewAccountForChain(sourceChain),
    ...(deadline === undefined ? {} : { deadline }),
    assetIn,
    assetOut,
    amountIn: toAssetUnits(assetIn, amountIn),
    minAmountOut: toAssetUnits(assetOut, minAmountOut),
    settlementChain,
    recipient: recipient?.trim() || previewAccountForChain(settlementChain),
  };
}

export function createExecuteQuoteRequest({
  sourceChain,
  destinationChain,
  executionType,
  asset,
  maxPaymentAmount,
  contractAddress,
  calldata,
  value,
  gasLimit,
  fallbackRefTime,
  fallbackProofSize,
  ownerAddress,
  deadline,
}: {
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  executionType: ExecuteType;
  asset: AssetKey;
  maxPaymentAmount: string;
  contractAddress: string;
  calldata: string;
  value: string;
  gasLimit: string;
  fallbackRefTime: string;
  fallbackProofSize: string;
  ownerAddress?: string;
  deadline?: number;
}): QuoteRequest {
  return {
    sourceChain,
    destinationChain,
    ownerAddress: ownerAddress ?? previewAccountForChain(sourceChain),
    ...(deadline === undefined ? {} : { deadline }),
    executionType,
    asset,
    maxPaymentAmount: toAssetUnits(asset, maxPaymentAmount),
    contractAddress,
    calldata,
    value,
    gasLimit,
    fallbackRefTime: Number.parseInt(fallbackRefTime, 10),
    fallbackProofSize: Number.parseInt(fallbackProofSize, 10),
  };
}

export async function submitTransferWithWallet(
  sessions: WalletSessions,
  input: {
    sourceChain: ChainKey;
    destinationChain: ChainKey;
    asset: AssetKey;
    amount: string;
    recipient: string;
  },
) {
  connectWalletSessionForChain(sessions, input.sourceChain);
  return requestXRouteTransfer({
    ...input,
    amount: toAssetUnits(input.asset, input.amount),
  });
}

export async function submitSwapWithWallet(
  sessions: WalletSessions,
  input: {
    sourceChain: ChainKey;
    destinationChain: ChainKey;
    assetIn: AssetKey;
    assetOut: AssetKey;
    amountIn: string;
    minAmountOut: string;
    settlementChain: ChainKey;
    recipient: string;
  },
) {
  connectWalletSessionForChain(sessions, input.sourceChain);
  return requestXRouteSwap({
    ...input,
    amountIn: toAssetUnits(input.assetIn, input.amountIn),
    minAmountOut: toAssetUnits(input.assetOut, input.minAmountOut),
  });
}

export async function submitCallWithWallet(
  sessions: WalletSessions,
  input: {
    sourceChain: ChainKey;
    destinationChain: ChainKey;
    asset: AssetKey;
    executionType: ExecuteType;
    maxPaymentAmount: string;
    contractAddress: string;
    calldata: string;
    value: string;
    gasLimit: string;
    fallbackRefTime: string;
    fallbackProofSize: string;
  },
) {
  connectWalletSessionForChain(sessions, input.sourceChain);
  return requestXRouteCall({
    sourceChain: input.sourceChain,
    destinationChain: input.destinationChain,
    executionType: input.executionType,
    asset: input.asset,
    maxPaymentAmount: toAssetUnits(input.asset, input.maxPaymentAmount),
    contractAddress: input.contractAddress,
    calldata: input.calldata,
    value: input.value,
    gasLimit: input.gasLimit,
    fallbackRefTime: Number.parseInt(input.fallbackRefTime, 10),
    fallbackProofSize: Number.parseInt(input.fallbackProofSize, 10),
  });
}

export type IntentExecutionResult =
  | TransferResponse
  | SwapResponse
  | ExecuteResponse
  | CallResponse;

export type IntentExecutionState = {
  execution: IntentExecutionResult | null;
  status: IntentStatus | null;
  timeline: IntentTimeline;
  error: string | null;
  isSubmitting: boolean;
  isTracking: boolean;
};

const INITIAL_INTENT_EXECUTION_STATE: IntentExecutionState = Object.freeze({
  execution: null,
  status: null,
  timeline: [],
  error: null,
  isSubmitting: false,
  isTracking: false,
});

export function useXRouteExecution() {
  const [state, setState] = useState<IntentExecutionState>(INITIAL_INTENT_EXECUTION_STATE);
  const trackerRef = useRef<ReturnType<typeof trackXRouteIntent> | null>(null);
  const executionRef = useRef(0);

  useEffect(() => {
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
    };
  }, []);

  async function execute(runExecution: () => Promise<IntentExecutionResult>) {
    executionRef.current += 1;
    const currentExecutionId = executionRef.current;

    trackerRef.current?.stop();
    trackerRef.current = null;

    setState({
      ...INITIAL_INTENT_EXECUTION_STATE,
      isSubmitting: true,
    });

    try {
      const execution = await runExecution();
      if (executionRef.current !== currentExecutionId) {
        return execution;
      }

      setState({
        execution,
        status: execution.status ?? null,
        timeline: [],
        error: null,
        isSubmitting: false,
        isTracking: Boolean(execution.submitted?.intentId),
      });

      if (execution.submitted?.intentId) {
        trackerRef.current = trackXRouteIntent(execution.submitted.intentId, {
          includeTimeline: true,
          onUpdate(snapshot: IntentTrackingSnapshot) {
            if (executionRef.current !== currentExecutionId) {
              return;
            }

            setState((current) => ({
              ...current,
              execution,
              status: snapshot.status ?? current.status,
              timeline: snapshot.timeline ?? current.timeline,
              isTracking: true,
            }));
          },
        });

        trackerRef.current.done
          .then((finalStatus) => {
            if (executionRef.current !== currentExecutionId) {
              return;
            }

            setState((current) => ({
              ...current,
              status: finalStatus ?? current.status,
              isTracking: false,
            }));
          })
          .catch((error) => {
            if (executionRef.current !== currentExecutionId) {
              return;
            }

            setState((current) => ({
              ...current,
              error: describeXRouteClientError(error, "Tracking failed."),
              isTracking: false,
            }));
          });
      }

      return execution;
    } catch (error) {
      if (executionRef.current === currentExecutionId) {
        setState({
          ...INITIAL_INTENT_EXECUTION_STATE,
          error: describeXRouteClientError(error, "Execution failed."),
        });
      }

      throw error;
    }
  }

  function reset() {
    executionRef.current += 1;
    trackerRef.current?.stop();
    trackerRef.current = null;
    setState(INITIAL_INTENT_EXECUTION_STATE);
  }

  return {
    ...state,
    execute,
    reset,
  };
}

type UseXRouteQuoteOptions = {
  enabled?: boolean;
  debounceMs?: number;
  refreshMs?: number;
};

export function useXRouteQuote(
  request: QuoteRequest | null,
  { enabled = true, debounceMs = 250, refreshMs = 30_000 }: UseXRouteQuoteOptions = {},
) {
  const [result, setResult] = useState<QuoteResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAtMs, setLastUpdatedAtMs] = useState<number | null>(null);
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
      setLastUpdatedAtMs(null);
      return;
    }

    let cancelled = false;
    let activeRequestId = 0;

    async function runQuoteRequest() {
      const nextRequest = requestRef.current;
      if (!nextRequest || cancelled) {
        return;
      }
      const currentRequestId = ++activeRequestId;

      setIsLoading(true);
      setError(null);

      try {
        const nextResult = await requestXRouteQuote(nextRequest);
        if (cancelled || currentRequestId !== activeRequestId) {
          return;
        }
        setResult(nextResult);
        setLastUpdatedAtMs(Date.now());
      } catch (nextError) {
        if (cancelled || currentRequestId !== activeRequestId) {
          return;
        }
        setResult(null);
        setError(describeXRouteClientError(nextError, "Quote failed."));
        setLastUpdatedAtMs(null);
      } finally {
        if (!cancelled && currentRequestId === activeRequestId) {
          setIsLoading(false);
        }
      }
    }

    const timeoutId = window.setTimeout(() => {
      void runQuoteRequest();
    }, debounceMs);
    const intervalId =
      refreshMs > 0
        ? window.setInterval(() => {
            void runQuoteRequest();
          }, refreshMs)
        : null;

    return () => {
      cancelled = true;
      activeRequestId += 1;
      window.clearTimeout(timeoutId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [debounceMs, refreshMs, requestKey]);

  return {
    result,
    intent: result?.intent ?? null,
    quote: result?.quote ?? null,
    sourceCosts: result?.sourceCosts ?? null,
    isLoading,
    error,
    lastUpdatedAtMs,
    refreshMs,
    isReady: Boolean(result) && !isLoading && !error,
  };
}

const EXECUTE_LABELS: Record<string, string> = {
  call: "Call",
  "mint-vdot": "Mint vDOT",
  "redeem-vdot": "Redeem vDOT",
};

const CHAINS = listChains(DEFAULT_DEPLOYMENT_PROFILE);
const ASSETS = listAssets(DEFAULT_DEPLOYMENT_PROFILE);
const ALL_CHAIN_KEYS = CHAINS.map((chain) => chain.key as ChainKey);
const ALL_ASSET_KEYS = ASSETS.map((asset) => asset.symbol as AssetKey);

const SWAP_SOURCE_CHAINS = ALL_CHAIN_KEYS.filter(
  (sourceChain) => getSwapOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).length > 0,
);

const EXECUTION_TYPES = [
  ...new Set(
    ALL_CHAIN_KEYS.flatMap((sourceChain) =>
      getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).flatMap((destination) =>
        destination.capabilities.map((capability) => capability.executionType),
      ),
    ),
  ),
] as ExecuteType[];

function option<T extends string>(value: T, label: string, disabled = false): Option<T> {
  return Object.freeze({ value, label, disabled });
}

function createDisabledOptions<T extends string>(
  options: readonly Option<T>[],
  supportedValues: ReadonlySet<T>,
  excludeValue?: T,
) {
  return Object.freeze(
    options
      .filter((candidate) => candidate.value !== excludeValue)
      .map((candidate) => ({
        ...candidate,
        disabled: candidate.disabled || !supportedValues.has(candidate.value),
      })),
  );
}

function getTransferDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getTransferOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).find(
    (candidate) => candidate.chain === destinationChain,
  );
}

function getSwapDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getSwapOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).find(
    (candidate) => candidate.chain === destinationChain,
  );
}

function getExecuteDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).find(
    (candidate) => candidate.chain === destinationChain,
  );
}

function getExecuteTypeLabel(executionType: ExecuteType) {
  return EXECUTE_LABELS[executionType] ?? executionType;
}

export const chainOptions: readonly Option<ChainKey>[] = Object.freeze(
  CHAINS.map((chain) => option(chain.key, chain.label)),
);

export const assetOptions: readonly Option<AssetKey>[] = Object.freeze(
  ASSETS.map((asset) => option(asset.symbol, asset.symbol)),
);

export const swapSourceChainOptions: readonly Option<ChainKey>[] = Object.freeze(
  SWAP_SOURCE_CHAINS.map((chainKey) => option(chainKey, chainLabel(chainKey))),
);

export function getSwapDestinationOptions(sourceChain: ChainKey) {
  const supportedDestinations = new Set<ChainKey>(
    getSwapOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).map((candidate) => candidate.chain),
  );

  return createDisabledOptions(chainOptions, supportedDestinations, sourceChain);
}

export function getSwapAssetInOptions(sourceChain: ChainKey, destinationChain: ChainKey) {
  const supportedAssets = new Set<AssetKey>(
    (getSwapDestinationRecord(sourceChain, destinationChain)?.pairs ?? []).map(
      (pair) => pair.assetIn as AssetKey,
    ),
  );

  return createDisabledOptions(assetOptions, supportedAssets);
}

export function getSwapAssetOutOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  assetIn: AssetKey,
) {
  const supportedAssets = new Set<AssetKey>(
    (getSwapDestinationRecord(sourceChain, destinationChain)?.pairs ?? [])
      .filter((pair) => pair.assetIn === assetIn)
      .map((pair) => pair.assetOut as AssetKey),
  );

  return createDisabledOptions(assetOptions, supportedAssets);
}

export function getSwapSettlementChainOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  assetIn: AssetKey,
  assetOut: AssetKey,
) {
  const supportedSettlementChains = new Set<ChainKey>(
    (getSwapDestinationRecord(sourceChain, destinationChain)?.pairs ?? [])
      .filter((pair) => pair.assetIn === assetIn && pair.assetOut === assetOut)
      .flatMap((pair) => pair.settlementChains as ChainKey[]),
  );

  return createDisabledOptions(chainOptions, supportedSettlementChains);
}

export function getExecuteTypeOptions(
  sourceChain?: ChainKey,
  destinationChain?: ChainKey,
) {
  const supportedExecutionTypes = new Set<ExecuteType>(
    (sourceChain
      ? getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE)
      : ALL_CHAIN_KEYS.flatMap((chainKey) => getExecuteOptions(chainKey, DEFAULT_DEPLOYMENT_PROFILE))
    )
      .filter((candidate) => !destinationChain || candidate.chain === destinationChain)
      .flatMap((candidate) =>
        candidate.capabilities.map((capability) => capability.executionType as ExecuteType),
      ),
  );

  return Object.freeze(
    EXECUTION_TYPES.map((executionType) =>
      option(
        executionType,
        getExecuteTypeLabel(executionType),
        !supportedExecutionTypes.has(executionType),
      ),
    ),
  );
}

export function getExecuteDestinationOptions(
  sourceChain: ChainKey,
  executionType: ExecuteType,
) {
  const supportedDestinations = new Set<ChainKey>(
    getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE)
      .filter((candidate) =>
        candidate.capabilities.some((capability) => capability.executionType === executionType),
      )
      .map((candidate) => candidate.chain),
  );

  return createDisabledOptions(chainOptions, supportedDestinations, sourceChain);
}

export const EVM_RECIPIENT_PLACEHOLDER = "0x...";
export const SS58_RECIPIENT_PLACEHOLDER = "5...";
export const EXAMPLE_ADAPTER_ADDRESS = "0x2222222222222222222222222222222222222222";

export function chainLabel(chainKey: ChainKey) {
  return getChain(chainKey, DEFAULT_DEPLOYMENT_PROFILE).label;
}

export function executeAssetForType(executionType: ExecuteType): AssetKey {
  const defaultSourceChain =
    getExecuteSourceChainOptions(executionType).find((candidate) => !candidate.disabled)?.value ??
    ALL_CHAIN_KEYS[0] ??
    "hydration";
  const defaultDestinationChain =
    getExecuteDestinationOptions(defaultSourceChain, executionType).find(
      (candidate) => !candidate.disabled,
    )?.value ??
    "moonbeam";

  return (
    getExecuteAssetOptions(defaultSourceChain, defaultDestinationChain, executionType).find(
      (candidate) => !candidate.disabled,
    )?.value ??
    ALL_ASSET_KEYS[0] ??
    "DOT"
  );
}

export function getExecuteSourceChainOptions(
  executionType: ExecuteType,
  destinationChain?: ChainKey,
) {
  const supportedSources = new Set<ChainKey>(
    ALL_CHAIN_KEYS.filter((sourceChain) =>
      getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).some(
        (candidate) =>
          (!destinationChain || candidate.chain === destinationChain)
          && candidate.capabilities.some((capability) => capability.executionType === executionType),
      ),
    ),
  );

  return createDisabledOptions(chainOptions, supportedSources, destinationChain);
}

export function getExecuteAssetOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  executionType: ExecuteType,
) {
  const supportedAssets = new Set<AssetKey>(
    (
      getExecuteDestinationRecord(sourceChain, destinationChain)?.capabilities.find(
        (candidate) => candidate.executionType === executionType,
      )?.assets ?? []
    ).map((assetKey) => assetKey as AssetKey),
  );

  return createDisabledOptions(assetOptions, supportedAssets);
}

export function getTransferDestinationOptions(sourceChain: ChainKey) {
  const supportedDestinations = new Set<ChainKey>(
    getTransferOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE).map((candidate) => candidate.chain),
  );

  return createDisabledOptions(chainOptions, supportedDestinations, sourceChain);
}

export function getTransferAssetOptions(sourceChain: ChainKey, destinationChain: ChainKey) {
  const supportedAssets = new Set<AssetKey>(
    getTransferDestinationRecord(sourceChain, destinationChain)?.assets ?? [],
  );

  return createDisabledOptions(assetOptions, supportedAssets);
}

export function isEvmChain(chainKey: ChainKey) {
  return getChainWalletType(chainKey, DEFAULT_DEPLOYMENT_PROFILE) === "evm";
}

export function recipientLabelForChain(chainKey: ChainKey) {
  return isEvmChain(chainKey)
    ? "Recipient (EVM address)"
    : "Recipient (SS58 address)";
}

export function recipientPlaceholderForChain(chainKey: ChainKey) {
  return isEvmChain(chainKey) ? EVM_RECIPIENT_PLACEHOLDER : SS58_RECIPIENT_PLACEHOLDER;
}

function describeXRouteClientError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (isNetworkFetchError(error)) {
    return "Unable to reach the XRoute API. If issue persist, reach us here xroute@muwa.io";
  }

  return message || fallback;
}

function isNetworkFetchError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.trim().toLowerCase();
  return message === "failed to fetch" || message.includes("networkerror") || message.includes("load failed");
}


export function coerceOptionValue<T extends string>(currentValue: T, options: readonly Option<T>[]) {
  const currentOption = options.find((candidate) => candidate.value === currentValue);
  if (currentOption && !currentOption.disabled) {
    return currentValue;
  }

  return options.find((candidate) => !candidate.disabled)?.value ?? options[0]?.value;
}

export function getTransactionExplorerUrl(chainKey: ChainKey, txHash: string) {
  const baseUrl = TX_EXPLORER_BASE_URLS[chainKey as keyof typeof TX_EXPLORER_BASE_URLS];
  if (!baseUrl) {
    return null;
  }

  return `${baseUrl}${txHash}`;
}

export {
  formatAssetAmount,
  getAssetDecimals,
  parseAssetAmount,
};
