"use client";

import { useEffect, useMemo } from "react";

import {
  actionButtonClass,
  fieldClass,
  fieldFullClass,
  formClass,
  gridClass,
  inputClass,
  labelClass,
} from "./form-classes";
import { IntentStatusCard } from "./intent-status-card";
import { PoweredBy } from "./powered-by";
import { QuoteFooter } from "./quote-footer";
import { usePersistedState } from "@/lib/persisted-state";
import {
  type AssetKey,
  canParseAssetUnits,
  chainLabel,
  fromAssetUnits,
  type ChainKey,
  coerceOptionValue,
  createSwapQuoteRequest,
  getSwapAssetInOptions,
  getSwapAssetOutOptions,
  getSwapDestinationOptions,
  getSwapSettlementChainOptions,
  resolveWalletAccountForChain,
  submitSwapWithWallet,
  swapSourceChainOptions,
  useXRouteExecution,
  useXRouteQuote,
  walletMatchesChain,
  walletRequirementLabel,
} from "@/lib/xroute";
import { Select } from "@/components/ui/select";
import { useWallet } from "@/hooks/use-wallet";

type SwapFormState = {
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  assetIn: AssetKey;
  assetOut: AssetKey;
  amountIn: string;
  slippagePercent: string;
  settlementChain: ChainKey;
};

function createInitialSwapForm(): SwapFormState {
  return {
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    assetIn: "DOT",
    assetOut: "USDT",
    amountIn: "10",
    slippagePercent: "1",
    settlementChain: "hydration",
  };
}

function canBuildQuote(form: SwapFormState) {
  return (
    form.amountIn.trim()
    && canParseAssetUnits(form.assetIn, form.amountIn)
    && isValidSlippagePercent(form.slippagePercent)
  )
    ? true
    : null;
}

export function SwapForm() {
  const [form, setForm] = usePersistedState(
    "xroute.form.swap.v2",
    createInitialSwapForm,
  );
  const { sessions } = useWallet();
  useEffect(() => {
    const sourceChain =
      coerceOptionValue(form.sourceChain, swapSourceChainOptions)
      ?? swapSourceChainOptions[0]?.value;
    if (!sourceChain) {
      return;
    }
    const destinationOptions = getSwapDestinationOptions(sourceChain);
    const destinationChain =
      coerceOptionValue(form.destinationChain, destinationOptions)
      ?? destinationOptions[0]?.value;
    if (!destinationChain) {
      return;
    }
    const assetInOptions = getSwapAssetInOptions(sourceChain, destinationChain);
    const assetIn =
      coerceOptionValue(form.assetIn, assetInOptions)
      ?? assetInOptions[0]?.value;
    if (!assetIn) {
      return;
    }
    const assetOutOptions = getSwapAssetOutOptions(sourceChain, destinationChain, assetIn);
    const assetOut =
      coerceOptionValue(form.assetOut, assetOutOptions)
      ?? assetOutOptions[0]?.value;
    if (!assetOut) {
      return;
    }
    const settlementOptions = getSwapSettlementChainOptions(
      sourceChain,
      destinationChain,
      assetIn,
      assetOut,
    );
    const settlementChain =
      coerceOptionValue(form.settlementChain, settlementOptions)
      ?? settlementOptions[0]?.value;
    if (!settlementChain) {
      return;
    }
    if (
      sourceChain !== form.sourceChain
      || destinationChain !== form.destinationChain
      || assetIn !== form.assetIn
      || assetOut !== form.assetOut
      || settlementChain !== form.settlementChain
    ) {
      setForm((current) => ({
        ...current,
        sourceChain,
        destinationChain,
        assetIn,
        assetOut,
        settlementChain,
      }));
    }
  }, [
    form.assetIn,
    form.assetOut,
    form.destinationChain,
    form.settlementChain,
    form.sourceChain,
    setForm,
  ]);
  const destinationOptions = useMemo(
    () => getSwapDestinationOptions(form.sourceChain),
    [form.sourceChain],
  );
  const assetInOptions = useMemo(
    () => getSwapAssetInOptions(form.sourceChain, form.destinationChain),
    [form.destinationChain, form.sourceChain],
  );
  const assetOutOptions = useMemo(
    () => getSwapAssetOutOptions(form.sourceChain, form.destinationChain, form.assetIn),
    [form.assetIn, form.destinationChain, form.sourceChain],
  );
  const settlementChainOptions = useMemo(
    () =>
      getSwapSettlementChainOptions(
        form.sourceChain,
        form.destinationChain,
        form.assetIn,
        form.assetOut,
      ),
    [form.assetIn, form.assetOut, form.destinationChain, form.sourceChain],
  );
  const ownerAddress = resolveWalletAccountForChain(sessions, form.sourceChain) ?? undefined;
  const resolvedRecipient = resolveWalletAccountForChain(sessions, form.settlementChain) ?? "";
  const previewMinimumReceived = fromAssetUnits(form.assetOut, BigInt(1));
  const quoteRequest = useMemo(
    () => {
      if (!canBuildQuote(form)) {
        return null;
      }

      return createSwapQuoteRequest({
        ...form,
        minAmountOut: previewMinimumReceived,
        recipient: resolvedRecipient || undefined,
        ownerAddress,
      });
    },
    [form, ownerAddress, previewMinimumReceived, resolvedRecipient],
  );
  const {
    quote,
    sourceCosts,
    error: quoteError,
    lastUpdatedAtMs,
    refreshMs,
  } = useXRouteQuote(quoteRequest);
  const execution = useXRouteExecution();
  const sourceWalletReady = walletMatchesChain(sessions, form.sourceChain);
  const recipientWalletReady = walletMatchesChain(sessions, form.settlementChain);
  const walletReady = sourceWalletReady && recipientWalletReady;
  const hasActiveStatusCard = Boolean(
    execution.execution
    || execution.status
    || execution.isSubmitting
    || execution.isTracking,
  );
  const showReset =
    Boolean(
      hasActiveStatusCard
      || execution.error,
    );
  const inlineError =
    quoteError
    ?? (!execution.execution && !execution.status && !execution.isTracking
      ? execution.error
      : null);
  const computedMinimumReceived = quote
    ? fromAssetUnits(
        form.assetOut,
        applySlippageToAmount(quote.expectedOutput.amount, form.slippagePercent),
      )
    : "";

  async function handleSubmit() {
    if (!walletReady || !quote || !computedMinimumReceived) {
      return;
    }

    try {
      await execution.execute(() =>
        submitSwapWithWallet(sessions, {
          ...form,
          minAmountOut: computedMinimumReceived,
          recipient: resolvedRecipient,
        }),
      );
    } catch {
      // handled in hook state
    }
  }

  return (
    <div className={formClass}>
      <div className={gridClass}>
            <label className={fieldClass}>
              <span className={labelClass}>Source chain</span>
              <Select
                value={form.sourceChain}
                onChange={(event) =>
                  setForm((current) => {
                    const sourceChain = event.target.value as ChainKey;
                    const nextDestinationOptions = getSwapDestinationOptions(sourceChain);
                    const destinationChain =
                      coerceOptionValue(current.destinationChain, nextDestinationOptions) ??
                      current.destinationChain;
                    const nextAssetInOptions = getSwapAssetInOptions(sourceChain, destinationChain);
                    const assetIn =
                      coerceOptionValue(current.assetIn, nextAssetInOptions) ?? current.assetIn;
                    const nextAssetOutOptions = getSwapAssetOutOptions(
                      sourceChain,
                      destinationChain,
                      assetIn,
                    );
                    const assetOut =
                      coerceOptionValue(current.assetOut, nextAssetOutOptions) ?? current.assetOut;
                    const nextSettlementOptions = getSwapSettlementChainOptions(
                      sourceChain,
                      destinationChain,
                      assetIn,
                      assetOut,
                    );
                    const settlementChain =
                      coerceOptionValue(current.settlementChain, nextSettlementOptions) ??
                      current.settlementChain;

                    return {
                      ...current,
                      sourceChain,
                      destinationChain,
                      assetIn,
                      assetOut,
                      settlementChain,
                    };
                  })
                }
              >
                {swapSourceChainOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Destination chain</span>
              <Select
                value={form.destinationChain}
                onChange={(event) =>
                  setForm((current) => {
                    const destinationChain = event.target.value as ChainKey;
                    const nextAssetInOptions = getSwapAssetInOptions(
                      current.sourceChain,
                      destinationChain,
                    );
                    const assetIn =
                      coerceOptionValue(current.assetIn, nextAssetInOptions) ?? current.assetIn;
                    const nextAssetOutOptions = getSwapAssetOutOptions(
                      current.sourceChain,
                      destinationChain,
                      assetIn,
                    );
                    const assetOut =
                      coerceOptionValue(current.assetOut, nextAssetOutOptions) ?? current.assetOut;
                    const nextSettlementOptions = getSwapSettlementChainOptions(
                      current.sourceChain,
                      destinationChain,
                      assetIn,
                      assetOut,
                    );
                    const settlementChain =
                      coerceOptionValue(current.settlementChain, nextSettlementOptions) ??
                      current.settlementChain;

                    return {
                      ...current,
                      destinationChain,
                      assetIn,
                      assetOut,
                      settlementChain,
                    };
                  })
                }
              >
                {destinationOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Asset in</span>
              <Select
                value={form.assetIn}
                onChange={(event) =>
                  setForm((current) => {
                    const assetIn = event.target.value as AssetKey;
                    const nextAssetOutOptions = getSwapAssetOutOptions(
                      current.sourceChain,
                      current.destinationChain,
                      assetIn,
                    );
                    const assetOut =
                      coerceOptionValue(current.assetOut, nextAssetOutOptions) ?? current.assetOut;
                    const nextSettlementOptions = getSwapSettlementChainOptions(
                      current.sourceChain,
                      current.destinationChain,
                      assetIn,
                      assetOut,
                    );
                    const settlementChain =
                      coerceOptionValue(current.settlementChain, nextSettlementOptions) ??
                      current.settlementChain;

                    return {
                      ...current,
                      assetIn,
                      assetOut,
                      settlementChain,
                    };
                  })
                }
              >
                {assetInOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Asset out</span>
              <Select
                value={form.assetOut}
                onChange={(event) =>
                  setForm((current) => {
                    const assetOut = event.target.value as AssetKey;
                    const nextSettlementChain = coerceOptionValue(
                      current.settlementChain,
                      getSwapSettlementChainOptions(
                        current.sourceChain,
                        current.destinationChain,
                        current.assetIn,
                        assetOut,
                      ),
                    ) ?? current.settlementChain;

                    return {
                      ...current,
                      assetOut,
                      settlementChain: nextSettlementChain,
                    };
                  })
                }
              >
                {assetOutOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Amount in</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.amountIn}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    amountIn: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Minimum received</span>
              <div className={`${inputClass} flex items-center`}>
                {computedMinimumReceived || "Quote to see minimum"}
              </div>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Settlement chain</span>
              <Select
                value={form.settlementChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    settlementChain: event.target.value as SwapFormState["settlementChain"],
                  }))
                }
              >
                {settlementChainOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Slippage (%)</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.slippagePercent}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    slippagePercent: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>Recipient</span>
              <div className={`${inputClass} flex items-center`}>
                {resolvedRecipient || `Connect a ${walletRequirementLabel(form.settlementChain).toLowerCase()} for ${chainLabel(form.settlementChain)}.`}
              </div>
            </label>
      </div>

      <QuoteFooter
        quote={quote}
        sourceCosts={sourceCosts}
        lastUpdatedAtMs={lastUpdatedAtMs}
        refreshMs={refreshMs}
      />

      {!hasActiveStatusCard ? (
        <div className="grid justify-items-center gap-2">
          <button
            type="button"
            className={actionButtonClass}
            onClick={handleSubmit}
            disabled={!walletReady || !quote || execution.isSubmitting || execution.isTracking}
          >
            {execution.isSubmitting ? "Submitting..." : "Swap"}
          </button>
          {!sourceWalletReady ? (
            <p className="m-0 text-center text-sm leading-6 text-muted">
              {`Connect a ${walletRequirementLabel(form.sourceChain).toLowerCase()} to execute from ${chainLabel(form.sourceChain)}.`}
            </p>
          ) : null}
          {inlineError ? (
            <p className="m-0 text-center text-sm leading-6 text-danger">{inlineError}</p>
          ) : null}
        </div>
      ) : null}

      <IntentStatusCard
        execution={execution.execution}
        status={execution.status}
        timeline={execution.timeline}
        error={execution.execution ? execution.error : null}
        isSubmitting={execution.isSubmitting}
        isTracking={execution.isTracking}
      />

      {hasActiveStatusCard && showReset ? (
        <div className="flex justify-center">
          <button
            type="button"
            className={actionButtonClass}
            onClick={execution.reset}
          >
            Run again
          </button>
        </div>
      ) : null}

      <PoweredBy />
    </div>
  );
}

function isValidSlippagePercent(value: string) {
  const normalized = value.trim();
  if (normalized === "" || !/^\d+(\.\d+)?$/.test(normalized)) {
    return false;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
}

function applySlippageToAmount(amount: bigint, slippagePercent: string) {
  const basisPoints = Math.floor(Number(slippagePercent.trim()) * 100);
  const clampedBasisPoints = Number.isFinite(basisPoints)
    ? Math.min(Math.max(basisPoints, 0), 10_000)
    : 0;
  const minimum = amount * BigInt(10_000 - clampedBasisPoints) / BigInt(10_000);
  return minimum > BigInt(0) ? minimum : BigInt(1);
}
