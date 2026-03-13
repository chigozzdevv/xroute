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
  type ChainKey,
  chainLabel,
  coerceOptionValue,
  exampleRecipientForChain,
  getSwapSettlementChainOptions,
  recipientLabelForChain,
  swapAssetInOptions,
  swapAssetOutOptions,
  swapDestinationChain,
  swapSourceChainOptions,
} from "./xroute-form-options";
import { Select } from "@/components/ui/select";
import type { QuoteRequest } from "@/lib/xroute/client";
import { useXRouteQuote } from "@/lib/xroute/use-xroute-quote";

type SwapFormState = {
  sourceChain: ChainKey;
  destinationChain: "hydration";
  assetIn: "DOT";
  assetOut: "USDT" | "HDX";
  amountIn: string;
  minAmountOut: string;
  settlementChain: "hydration" | "polkadot-hub";
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

function buildQuoteRequest(form: SwapFormState): QuoteRequest | null {
  if (!form.amountIn.trim() || !form.minAmountOut.trim() || !form.recipient.trim()) {
    return null;
  }

  return {
    kind: "swap",
    sourceChain: form.sourceChain as "polkadot-hub" | "moonbeam",
    destinationChain: form.destinationChain,
    assetIn: form.assetIn,
    assetOut: form.assetOut,
    amountIn: form.amountIn,
    minAmountOut: form.minAmountOut,
    settlementChain: form.settlementChain,
    recipient: form.recipient,
  };
}

export function SwapForm() {
  const [form, setForm] = useState<SwapFormState>(createInitialSwapForm);
  const settlementChainOptions = useMemo(
    () => getSwapSettlementChainOptions(form.assetOut),
    [form.assetOut],
  );
  const quoteRequest = useMemo(() => buildQuoteRequest(form), [form]);
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
                    const assetOut = event.target.value as SwapFormState["assetOut"];
                    const nextSettlementChain = coerceOptionValue(
                      current.settlementChain,
                      getSwapSettlementChainOptions(assetOut),
                    );

                    return {
                      ...current,
                      assetOut,
                      settlementChain: nextSettlementChain,
                      recipient:
                        nextSettlementChain === "hydration"
                          ? exampleRecipientForChain("hydration")
                          : EXAMPLE_EVM_ADDRESS,
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

      <QuoteFooter quote={quote?.quote ?? null} />

      <PoweredBy />
    </div>
  );
}
