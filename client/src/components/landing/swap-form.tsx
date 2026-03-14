"use client";

import { useMemo, useState } from "react";

import {
  fieldClass,
  fieldFullClass,
  formClass,
  gridClass,
  inputClass,
  labelClass,
} from "./form-classes";
import { PoweredBy } from "./powered-by";
import { QuoteFooter } from "./quote-footer";
import {
  EXAMPLE_EVM_ADDRESS,
  type AssetKey,
  type ChainKey,
  chainLabel,
  coerceOptionValue,
  exampleRecipientForChain,
  getSwapSettlementChainOptions,
  type QuoteRequest,
  recipientLabelForChain,
  swapAssetInOptions,
  swapAssetOutOptions,
  swapDestinationChain,
  swapSourceChainOptions,
  useXRouteQuote,
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
    recipient: EXAMPLE_EVM_ADDRESS,
  };
}

function buildQuoteRequest(form: SwapFormState, ownerAddress?: string): QuoteRequest | null {
  if (
    !form.amountIn.trim() ||
    !form.minAmountOut.trim() ||
    !form.recipient.trim() ||
    !ownerAddress?.trim()
  ) {
    return null;
  }

  return {
    kind: "swap",
    sourceChain: form.sourceChain,
    destinationChain: form.destinationChain,
    assetIn: form.assetIn,
    assetOut: form.assetOut,
    amountIn: form.amountIn,
    minAmountOut: form.minAmountOut,
    settlementChain: form.settlementChain,
    recipient: form.recipient,
    ownerAddress: ownerAddress.trim(),
  };
}

export function SwapForm() {
  const [form, setForm] = useState<SwapFormState>(createInitialSwapForm);
  const { account } = useWallet();
  const settlementChainOptions = useMemo(
    () => getSwapSettlementChainOptions(form.assetOut),
    [form.assetOut],
  );
  const quoteRequest = useMemo(
    () => buildQuoteRequest(form, account ?? undefined),
    [account, form],
  );
  const { quote } = useXRouteQuote(quoteRequest);

  return (
    <div className={formClass}>
      <div className={gridClass}>
            <label className={fieldClass}>
              <span className={labelClass}>Source chain</span>
              <Select
                value={form.sourceChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    sourceChain: event.target.value as ChainKey,
                  }))
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
              <Select value={form.destinationChain} disabled>
                <option value={swapDestinationChain}>
                  {chainLabel(swapDestinationChain)}
                </option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Asset in</span>
              <Select value={form.assetIn} disabled>
                {swapAssetInOptions.map((option) => (
                  <option key={option.value} value={option.value}>
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
                      getSwapSettlementChainOptions(assetOut),
                    ) ?? current.settlementChain;

                    return {
                      ...current,
                      assetOut,
                      settlementChain: nextSettlementChain,
                      recipient: exampleRecipientForChain(nextSettlementChain),
                    };
                  })
                }
              >
                {swapAssetOutOptions.map((option) => (
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
                      event.target.value === "hydration"
                        ? exampleRecipientForChain("hydration")
                        : EXAMPLE_EVM_ADDRESS,
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

      <PoweredBy />
    </div>
  );
}
