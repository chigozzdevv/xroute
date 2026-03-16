"use client";

import { useMemo, useState } from "react";

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
import {
  type AssetKey,
  type ChainKey,
  coerceOptionValue,
  createSwapQuoteRequest,
  getSwapAssetInOptions,
  getSwapAssetOutOptions,
  getSwapDestinationOptions,
  getSwapSettlementChainOptions,
  recipientPlaceholderForChain,
  recipientLabelForChain,
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
  minAmountOut: string;
  settlementChain: ChainKey;
  recipient: string;
};

function createInitialSwapForm(): SwapFormState {
  return {
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    assetIn: "DOT",
    assetOut: "USDT",
    amountIn: "10",
    minAmountOut: "49",
    settlementChain: "polkadot-hub",
    recipient: "",
  };
}

function canBuildQuote(form: SwapFormState, ownerAddress?: string) {
  if (
    !form.amountIn.trim() ||
    !form.minAmountOut.trim() ||
    !form.recipient.trim() ||
    !ownerAddress?.trim()
  ) {
    return null;
  }
  return ownerAddress.trim();
}

export function SwapForm() {
  const [form, setForm] = useState<SwapFormState>(createInitialSwapForm);
  const { sessions } = useWallet();
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
  const quoteRequest = useMemo(
    () => {
      const walletAddress = canBuildQuote(form, ownerAddress);
      if (!walletAddress) {
        return null;
      }

      return createSwapQuoteRequest({
        ...form,
        ownerAddress: walletAddress,
      });
    },
    [form, ownerAddress],
  );
  const { quote, error: quoteError } = useXRouteQuote(quoteRequest);
  const execution = useXRouteExecution();
  const walletReady = walletMatchesChain(sessions, form.sourceChain);

  async function handleSubmit() {
    if (!walletReady) {
      return;
    }

    try {
      await execution.execute(() =>
        submitSwapWithWallet(sessions, {
          ...form,
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
                      recipient: resolveWalletAccountForChain(sessions, settlementChain) ?? "",
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
                      recipient: resolveWalletAccountForChain(sessions, settlementChain) ?? "",
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
                      recipient: resolveWalletAccountForChain(sessions, settlementChain) ?? "",
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
                      recipient:
                        resolveWalletAccountForChain(sessions, nextSettlementChain) ?? "",
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
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.minAmountOut}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    minAmountOut: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Settlement chain</span>
              <Select
                value={form.settlementChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    settlementChain: event.target.value as SwapFormState["settlementChain"],
                    recipient:
                      resolveWalletAccountForChain(
                        sessions,
                        event.target.value as SwapFormState["settlementChain"],
                      ) ?? "",
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

            <label className={fieldFullClass}>
              <span className={labelClass}>
                {recipientLabelForChain(form.settlementChain)}
              </span>
              <input
                className={inputClass}
                value={form.recipient}
                placeholder={recipientPlaceholderForChain(form.settlementChain)}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    recipient: event.target.value,
                  }))
                }
              />
            </label>
      </div>

      <QuoteFooter quote={quote} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {!walletReady ? (
          <p className="m-0 text-sm leading-6 text-muted">
            {`Connect a ${walletRequirementLabel(form.sourceChain).toLowerCase()} to quote and execute from ${form.sourceChain}.`}
          </p>
        ) : <span />}
        <button
          type="button"
          className={actionButtonClass}
          onClick={handleSubmit}
          disabled={!walletReady || !quote || execution.isSubmitting || execution.isTracking}
        >
          {execution.isSubmitting ? "Submitting..." : "Swap"}
        </button>
      </div>

      <IntentStatusCard
        execution={execution.execution}
        status={execution.status}
        timeline={execution.timeline}
        error={execution.error ?? quoteError}
        isSubmitting={execution.isSubmitting}
        isTracking={execution.isTracking}
        idleMessage={
          walletReady
            ? null
            : `This route requires a ${walletRequirementLabel(form.sourceChain).toLowerCase()}.`
        }
      />

      <PoweredBy />
    </div>
  );
}
