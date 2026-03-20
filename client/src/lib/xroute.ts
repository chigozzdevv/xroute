"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createXRouteClient } from "@xcm-router/sdk";
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
} from "@xcm-router/sdk/chains";
import {
  getExecuteOptions,
  getSwapOptions,
  getTransferOptions,
} from "@xcm-router/sdk/routes";
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
export type AssetUsdPrice = {
  usd: number;
  lastUpdatedAt: number | null;
};
export type AssetUsdPrices = Partial<Record<AssetKey, AssetUsdPrice>>;
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
  return ALL_CHAIN_KEYS.filter((chainKey: any) => walletKindForChain(chainKey) === kind);
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
      debugTransactions: isXRouteDebugTransactionsEnabled(),
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

export function sourceCostUsesDifferentUnitDomains(sourceCosts: QuoteSourceCosts) {
  if (!sourceCosts) {
    return false;
  }

  return sourceCosts.lockedAmount.asset === sourceCosts.gasFee.asset
    && (
      sourceCosts.lockedAmount.unitDomain !== sourceCosts.gasFee.unitDomain
      || sourceCosts.lockedAmount.decimals !== sourceCosts.gasFee.decimals
    );
}

export function getQuotedFeeAssets(
  quote: Quote | null,
  sourceCosts: QuoteSourceCosts = null,
): AssetKey[] {
  const symbols = new Set<AssetKey>();

  if (quote) {
    symbols.add(quote.fees.xcmFee.asset as AssetKey);
    symbols.add(quote.fees.destinationFee.asset as AssetKey);
    symbols.add(quote.fees.platformFee.asset as AssetKey);
  }
  if (sourceCosts) {
    symbols.add(sourceCosts.lockedAmount.asset as AssetKey);
    symbols.add(sourceCosts.gasFee.asset as AssetKey);
  }

  return [...symbols];
}

export function getUsdValueForQuoteAmount(
  amount: QuoteAssetAmount,
  prices: AssetUsdPrices,
) {
  const price = prices[amount.asset as AssetKey]?.usd;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }

  const numericAmount = Number.parseFloat(
    formatAssetAmount(amount.asset, amount.amount, DEFAULT_DEPLOYMENT_PROFILE, {
      trimTrailingZeros: false,
    }),
  );
  if (!Number.isFinite(numericAmount)) {
    return null;
  }

  return numericAmount * price;
}

export function getUsdValueForSourceCostAmount(
  amount: SourceCostAmount,
  prices: AssetUsdPrices,
) {
  const price = prices[amount.asset as AssetKey]?.usd;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }

  const numericAmount = Number.parseFloat(
    formatUnits(amount.amount, amount.decimals, {
      trimTrailingZeros: false,
    }),
  );
  if (!Number.isFinite(numericAmount)) {
    return null;
  }

  return numericAmount * price;
}

export function estimateQuoteUsdTotal(
  quote: Quote | null,
  sourceCosts: QuoteSourceCosts = null,
  prices: AssetUsdPrices = {},
) {
  if (!quote) {
    return null;
  }

  if (sourceCosts) {
    const lockedUsd = getUsdValueForSourceCostAmount(sourceCosts.lockedAmount, prices);
    const gasUsd = getUsdValueForSourceCostAmount(sourceCosts.gasFee, prices);
    if (lockedUsd === null || gasUsd === null) {
      return null;
    }

    return lockedUsd + gasUsd;
  }

  const feeAmounts = [
    quote.fees.xcmFee,
    quote.fees.destinationFee,
    quote.fees.platformFee,
  ];
  const feeUsdValues = feeAmounts.map((fee) => getUsdValueForQuoteAmount(fee, prices));
  const resolvedFeeUsdValues = feeUsdValues.filter((value): value is number => value !== null);
  if (resolvedFeeUsdValues.length !== feeUsdValues.length) {
    return null;
  }

  return resolvedFeeUsdValues.reduce((sum, value) => sum + value, 0);
}

function isXRouteDebugTransactionsEnabled() {
  return process.env.NEXT_PUBLIC_XROUTE_DEBUG_TX?.trim() === "true";
}

export function useAssetUsdPrices(
  assets: readonly AssetKey[],
  {
    refreshMs = 60_000,
  }: {
    refreshMs?: number;
  } = {},
) {
  const [prices, setPrices] = useState<AssetUsdPrices>({});
  const emptyPrices = useMemo<AssetUsdPrices>(() => ({}), []);
  const assetKey = useMemo(
    () =>
      [...new Set(assets.map((asset: any) => asset.trim()).filter(Boolean))]
        .sort()
        .join(","),
    [assets],
  );

  useEffect(() => {
    if (!assetKey) {
      return;
    }

    let cancelled = false;

    async function loadPrices() {
      try {
        const response = await fetch(`/api/asset-prices?assets=${encodeURIComponent(assetKey)}`);
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        if (cancelled) {
          return;
        }

        setPrices(payload?.prices ?? {});
      } catch {
        if (!cancelled) {
          setPrices({});
        }
      }
    }

    void loadPrices();

    if (refreshMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const intervalId = window.setInterval(() => {
      void loadPrices();
    }, refreshMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [assetKey, refreshMs]);

  return assetKey ? prices : emptyPrices;
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

const RELAYER_JOB_TERMINAL_STATUSES = new Set(["completed", "failed"]);

function isRelayerJobTerminal(status: string | undefined | null): boolean {
  return RELAYER_JOB_TERMINAL_STATUSES.has(status ?? "");
}

async function fetchRelayerJobStatus(jobId: string): Promise<{
  status?: string;
  lastError?: string | null;
} | null> {
  try {
    return await (xrouteClient as unknown as { getJob(id: string): Promise<Record<string, unknown>> }).getJob(jobId);
  } catch (err) {
    console.error("Failed to fetch relayer job status:", err);
    return null;
  }
}

function mergeRelayerJobStatus(
  execution: IntentExecutionResult,
  jobUpdate: { status?: string; lastError?: string | null },
): IntentExecutionResult {
  const dispatched = (execution as Record<string, unknown>).dispatched as
    | Record<string, unknown>
    | undefined;
  if (!dispatched?.relayerJob) {
    return execution;
  }

  return {
    ...execution,
    dispatched: {
      ...dispatched,
      relayerJob: {
        ...(dispatched.relayerJob as Record<string, unknown>),
        status: jobUpdate.status,
        lastError: jobUpdate.lastError ?? null,
      },
    },
  } as IntentExecutionResult;
}

export function useXRouteExecution() {
  const [state, setState] = useState<IntentExecutionState>(INITIAL_INTENT_EXECUTION_STATE);
  const trackerRef = useRef<ReturnType<typeof trackXRouteIntent> | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executionRef = useRef(0);

  useEffect(() => {
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      if (jobPollRef.current !== null) {
        clearTimeout(jobPollRef.current);
        jobPollRef.current = null;
      }
    };
  }, []);

  function startRelayerJobPolling(
    execution: IntentExecutionResult,
    executionId: number,
  ) {
    const jobId = (execution as Record<string, unknown> & {
      dispatched?: { relayerJob?: { id?: string } };
    }).dispatched?.relayerJob?.id;
    if (!jobId) {
      return;
    }

    const resolvedJobId: string = jobId;
    const pollInterval = 2_000;
    let stopped = false;

    async function poll() {
      if (stopped || executionRef.current !== executionId) {
        return;
      }

      const jobUpdate = await fetchRelayerJobStatus(resolvedJobId);
      if (stopped || executionRef.current !== executionId || !jobUpdate) {
        return;
      }

      const updated = mergeRelayerJobStatus(execution, jobUpdate);
      execution = updated;

      setState((current) => ({
        ...current,
        execution: updated,
      }));

      if (
        jobUpdate.status === "failed" &&
        jobUpdate.lastError
      ) {
        setState((current) => ({
          ...current,
          execution: updated,
          error: current.error ?? `Relayer job failed: ${jobUpdate.lastError}`,
        }));
      }

      if (!isRelayerJobTerminal(jobUpdate.status)) {
        jobPollRef.current = setTimeout(poll, pollInterval);
      }
    }

    jobPollRef.current = setTimeout(poll, pollInterval);

    return () => {
      stopped = true;
      if (jobPollRef.current !== null) {
        clearTimeout(jobPollRef.current);
        jobPollRef.current = null;
      }
    };
  }

  async function execute(runExecution: () => Promise<IntentExecutionResult>) {
    executionRef.current += 1;
    const currentExecutionId = executionRef.current;

    trackerRef.current?.stop();
    trackerRef.current = null;
    if (jobPollRef.current !== null) {
      clearTimeout(jobPollRef.current);
      jobPollRef.current = null;
    }

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

      startRelayerJobPolling(execution, currentExecutionId);

      if (execution.submitted?.intentId) {
        trackerRef.current = trackXRouteIntent(execution.submitted.intentId, {
          includeTimeline: true,
          onUpdate(snapshot: IntentTrackingSnapshot) {
            if (executionRef.current !== currentExecutionId) {
              return;
            }

            setState((current) => ({
              ...current,
              execution: current.execution,
              status: snapshot.status ?? current.status,
              timeline: snapshot.timeline ?? current.timeline,
              isTracking: true,
            }));
          },
        });

        trackerRef.current.done
          .then((finalStatus: any) => {
            if (executionRef.current !== currentExecutionId) {
              return;
            }

            setState((current) => ({
              ...current,
              status: finalStatus ?? current.status,
              isTracking: false,
            }));
          })
          .catch((error: any) => {
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
    if (jobPollRef.current !== null) {
      clearTimeout(jobPollRef.current);
      jobPollRef.current = null;
    }
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

const CLIENT_TRANSFER_MATRIX: Readonly<
  Partial<Record<ChainKey, Partial<Record<ChainKey, readonly AssetKey[]>>>>
> = Object.freeze({
  moonbeam: Object.freeze({
    "polkadot-hub": Object.freeze(["DOT"]),
    bifrost: Object.freeze(["BNC"]),
  }),
  "polkadot-hub": Object.freeze({
    hydration: Object.freeze(["DOT"]),
  }),
});

const CLIENT_SWAP_MATRIX: Readonly<
  Partial<
    Record<
      ChainKey,
      Partial<
        Record<
          ChainKey,
          readonly { assetIn: AssetKey; assetOut: AssetKey; settlementChains: readonly ChainKey[] }[]
        >
      >
    >
  >
> = Object.freeze({
  "polkadot-hub": Object.freeze({
    hydration: Object.freeze([
      Object.freeze({
        assetIn: "DOT",
        assetOut: "USDT",
        settlementChains: Object.freeze(["hydration"]),
      }),
    ]),
  }),
});

const CLIENT_EXECUTE_MATRIX: Readonly<
  Partial<Record<ChainKey, Partial<Record<ChainKey, Partial<Record<ExecuteType, readonly AssetKey[]>>>>>>
> = Object.freeze({
  "polkadot-hub": Object.freeze({
    moonbeam: Object.freeze({
      call: Object.freeze(["DOT"]),
    }),
  }),
  hydration: Object.freeze({
    moonbeam: Object.freeze({
      call: Object.freeze(["DOT"]),
    }),
  }),
  bifrost: Object.freeze({
    moonbeam: Object.freeze({
      call: Object.freeze(["DOT"]),
    }),
  }),
});

const CHAINS = listChains(DEFAULT_DEPLOYMENT_PROFILE);
const ASSETS = listAssets(DEFAULT_DEPLOYMENT_PROFILE);
const ALL_CHAIN_KEYS = CHAINS.map((chain: any) => chain.key as ChainKey);
const ALL_ASSET_KEYS = ASSETS.map((asset: any) => asset.symbol as AssetKey);

function option<T extends string>(value: T, label: string, disabled = false): Option<T> {
  return Object.freeze({ value, label, disabled });
}

function createOptions<T extends string>(
  values: readonly T[],
  labelFor: (value: T) => string,
) {
  return Object.freeze(
    values.map((value) => option(value, labelFor(value))),
  );
}

function filterAssets(
  assets: readonly string[],
  allowedAssets: readonly AssetKey[],
) {
  const supportedAssets = new Set<AssetKey>(allowedAssets);
  return assets.filter((asset: any) => supportedAssets.has(asset as AssetKey)) as AssetKey[];
}

function getClientTransferRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return CLIENT_TRANSFER_MATRIX[sourceChain]?.[destinationChain] ?? [];
}

function getClientSwapPairs(sourceChain: ChainKey, destinationChain: ChainKey) {
  return CLIENT_SWAP_MATRIX[sourceChain]?.[destinationChain] ?? [];
}

function getClientExecuteAssets(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  executionType: ExecuteType,
) {
  return CLIENT_EXECUTE_MATRIX[sourceChain]?.[destinationChain]?.[executionType] ?? [];
}

function getFilteredTransferOptions(sourceChain: ChainKey) {
  return getTransferOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE)
    .map((candidate: any) => {
      const assets = filterAssets(
        candidate.assets,
        getClientTransferRecord(sourceChain, candidate.chain as ChainKey),
      );
      return assets.length > 0 ? { ...candidate, assets } : null;
    })
    .filter((candidate: any): candidate is NonNullable<typeof candidate> => candidate !== null);
}

function getFilteredSwapOptions(sourceChain: ChainKey) {
  return getSwapOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE)
    .map((candidate: any) => {
      const allowedPairs = getClientSwapPairs(sourceChain, candidate.chain as ChainKey);
      const pairs = candidate.pairs
        .map((pair: any) => {
          const allowedPair = allowedPairs.find(
            (allowed: any) =>
              allowed.assetIn === pair.assetIn
              && allowed.assetOut === pair.assetOut,
          );
          if (!allowedPair) {
            return null;
          }

          const allowedSettlements = new Set<ChainKey>(allowedPair.settlementChains);
          const settlementChains = (pair.settlementChains as ChainKey[]).filter(
            (settlementChain) => allowedSettlements.has(settlementChain),
          );
          return settlementChains.length > 0 ? { ...pair, settlementChains } : null;
        })
        .filter((pair: any): pair is NonNullable<typeof pair> => pair !== null);
      return pairs.length > 0 ? { ...candidate, pairs } : null;
    })
    .filter((candidate: any): candidate is NonNullable<typeof candidate> => candidate !== null);
}

function getFilteredExecuteOptions(sourceChain: ChainKey) {
  return getExecuteOptions(sourceChain, DEFAULT_DEPLOYMENT_PROFILE)
    .map((candidate: any) => {
      const capabilities = candidate.capabilities
        .map((capability: any) => {
          const assets = filterAssets(
            capability.assets,
            getClientExecuteAssets(
              sourceChain,
              candidate.chain as ChainKey,
              capability.executionType as ExecuteType,
            ),
          );
          return assets.length > 0 ? { ...capability, assets } : null;
        })
        .filter((capability: any): capability is NonNullable<typeof capability> => capability !== null);
      return capabilities.length > 0 ? { ...candidate, capabilities } : null;
    })
    .filter((candidate: any): candidate is NonNullable<typeof candidate> => candidate !== null);
}

const TRANSFER_SOURCE_CHAINS = Object.freeze(
  ALL_CHAIN_KEYS.filter((sourceChain) => getFilteredTransferOptions(sourceChain).length > 0),
);

const SWAP_SOURCE_CHAINS = Object.freeze(
  ALL_CHAIN_KEYS.filter((sourceChain) => getFilteredSwapOptions(sourceChain).length > 0),
);

function getTransferDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getFilteredTransferOptions(sourceChain).find(
    (candidate: any) => candidate.chain === destinationChain,
  );
}

function getSwapDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getFilteredSwapOptions(sourceChain).find(
    (candidate: any) => candidate.chain === destinationChain,
  );
}

function getExecuteDestinationRecord(sourceChain: ChainKey, destinationChain: ChainKey) {
  return getFilteredExecuteOptions(sourceChain).find(
    (candidate: any) => candidate.chain === destinationChain,
  );
}

function getExecuteTypeLabel(executionType: ExecuteType) {
  return EXECUTE_LABELS[executionType] ?? executionType;
}

export const chainOptions: readonly Option<ChainKey>[] = Object.freeze(
  CHAINS.map((chain: any) => option(chain.key, chain.label)),
);

export const assetOptions: readonly Option<AssetKey>[] = Object.freeze(
  ASSETS.map((asset: any) => option(asset.symbol, asset.symbol)),
);

export const transferSourceChainOptions: readonly Option<ChainKey>[] = createOptions(
  TRANSFER_SOURCE_CHAINS,
  chainLabel,
);

export const swapSourceChainOptions: readonly Option<ChainKey>[] = Object.freeze(
  createOptions(SWAP_SOURCE_CHAINS, chainLabel),
);

export function getSwapDestinationOptions(sourceChain: ChainKey) {
  const destinations = getFilteredSwapOptions(sourceChain).map(
    (candidate: any) => candidate.chain as ChainKey,
  );
  return createOptions(destinations as any, chainLabel);
}

export function getSwapAssetInOptions(sourceChain: ChainKey, destinationChain: ChainKey) {
  const assets = [
    ...new Set(
      (getSwapDestinationRecord(sourceChain, destinationChain)?.pairs ?? []).map(
        (pair: any) => pair.assetIn as AssetKey,
      ),
    ),
  ];
  return createOptions(assets as any, (assetKey: any) => assetKey);
}

export function getSwapAssetOutOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  assetIn: AssetKey,
) {
  const assets = [
    ...new Set(
      (getSwapDestinationRecord(sourceChain, destinationChain)?.pairs ?? [])
        .filter((pair: any) => pair.assetIn === assetIn)
        .map((pair: any) => pair.assetOut as AssetKey),
    ),
  ];
  return createOptions(assets as any, (assetKey: any) => assetKey);
}

export function getSwapSettlementChainOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  assetIn: AssetKey,
  assetOut: AssetKey,
) {
  const settlementChains = [
    ...new Set(
      (getSwapDestinationRecord(sourceChain, destinationChain)?.pairs ?? [])
        .filter((pair: any) => pair.assetIn === assetIn && pair.assetOut === assetOut)
        .flatMap((pair: any) => pair.settlementChains as ChainKey[]),
    ),
  ];
  return createOptions(settlementChains as any, chainLabel);
}

export function getExecuteTypeOptions(
  sourceChain?: ChainKey,
  destinationChain?: ChainKey,
) {
  const executionTypes = [
    ...new Set(
      (sourceChain
        ? getFilteredExecuteOptions(sourceChain)
        : ALL_CHAIN_KEYS.flatMap((chainKey: any) => getFilteredExecuteOptions(chainKey))
      )
      .filter((candidate: any) => !destinationChain || candidate.chain === destinationChain)
      .flatMap((candidate: any) =>
        candidate.capabilities.map((capability: any) => capability.executionType as ExecuteType),
      ),
    ),
  ];

  return createOptions(executionTypes as any, getExecuteTypeLabel);
}

export function getExecuteDestinationOptions(
  sourceChain: ChainKey,
  executionType: ExecuteType,
) {
  const destinations = getFilteredExecuteOptions(sourceChain)
      .filter((candidate: any) =>
        candidate.capabilities.some((capability: any) => capability.executionType === executionType),
      )
      .map((candidate: any) => candidate.chain as ChainKey);

  return createOptions(destinations as any, chainLabel);
}

export const EVM_RECIPIENT_PLACEHOLDER = "0x...";
export const SS58_RECIPIENT_PLACEHOLDER = "5...";
export const EXAMPLE_ADAPTER_ADDRESS = "0x2222222222222222222222222222222222222222";

export function chainLabel(chainKey: ChainKey) {
  return getChain(chainKey, DEFAULT_DEPLOYMENT_PROFILE).label;
}

export function executeAssetForType(executionType: ExecuteType): AssetKey {
  const defaultSourceChain =
    getExecuteSourceChainOptions(executionType).find((candidate: any) => !candidate.disabled)?.value ??
    ALL_CHAIN_KEYS[0] ??
    "hydration";
  const defaultDestinationChain =
    getExecuteDestinationOptions(defaultSourceChain, executionType).find(
      (candidate: any) => !candidate.disabled,
    )?.value ??
    "moonbeam";

  return (
    getExecuteAssetOptions(defaultSourceChain, defaultDestinationChain, executionType).find(
      (candidate: any) => !candidate.disabled,
    )?.value ??
    ALL_ASSET_KEYS[0] ??
    "DOT"
  );
}

export function getExecuteSourceChainOptions(
  executionType: ExecuteType,
  destinationChain?: ChainKey,
) {
  const sources = ALL_CHAIN_KEYS.filter((sourceChain) =>
      getFilteredExecuteOptions(sourceChain).some(
        (candidate: any) =>
          (!destinationChain || candidate.chain === destinationChain)
          && candidate.capabilities.some((capability: any) => capability.executionType === executionType),
      ),
  );

  return createOptions(sources as any, chainLabel);
}

export function getExecuteAssetOptions(
  sourceChain: ChainKey,
  destinationChain: ChainKey,
  executionType: ExecuteType,
) {
  const assets = [
    ...new Set(
    (
      getExecuteDestinationRecord(sourceChain, destinationChain)?.capabilities.find(
        (candidate: any) => candidate.executionType === executionType,
      )?.assets ?? []
    ).map((assetKey: any) => assetKey as AssetKey),
    ),
  ];

  return createOptions(assets as any, (assetKey: any) => assetKey);
}

export function getTransferDestinationOptions(sourceChain: ChainKey) {
  const destinations = getFilteredTransferOptions(sourceChain).map(
    (candidate: any) => candidate.chain as ChainKey,
  );
  return createOptions(destinations as any, chainLabel);
}

export function getTransferAssetOptions(sourceChain: ChainKey, destinationChain: ChainKey) {
  const assets = getTransferDestinationRecord(sourceChain, destinationChain)?.assets ?? [];
  return createOptions(assets as any, (assetKey: any) => assetKey);
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
  const currentOption = options.find((candidate: any) => candidate.value === currentValue);
  if (currentOption && !currentOption.disabled) {
    return currentValue;
  }

  return options.find((candidate: any) => !candidate.disabled)?.value ?? options[0]?.value;
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
