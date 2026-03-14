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
  type AssetKey,
  type ChainKey,
  chainOptions,
  coerceOptionValue,
  exampleRecipientForChain,
  getTransferAssetOptions,
  getTransferDestinationOptions,
  recipientLabelForChain,
} from "./xroute-form-options";
import { Select } from "@/components/ui/select";
import { useWallet } from "@/hooks/use-wallet";
import type { QuoteRequest } from "@/lib/xroute/client";
import { useXRouteQuote } from "@/lib/xroute/use-xroute-quote";

type TransferFormState = {
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  asset: AssetKey;
  amount: string;
  recipient: string;
};

function createInitialTransferForm(): TransferFormState {
  return {
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    asset: "DOT",
    amount: "25",
    recipient: exampleRecipientForChain("hydration"),
  };
}

function buildQuoteRequest(
  form: TransferFormState,
  ownerAddress?: string,
): QuoteRequest | null {
  if (!form.amount.trim() || !form.recipient.trim() || !ownerAddress?.trim()) {
    return null;
  }

  return {
    kind: "transfer",
    sourceChain: form.sourceChain,
    destinationChain: form.destinationChain,
    asset: form.asset,
    amount: form.amount,
    recipient: form.recipient,
    ownerAddress: ownerAddress.trim(),
  };
}

export function TransferForm() {
  const [form, setForm] = useState(createInitialTransferForm);
  const { account } = useWallet();
  const destinationOptions = getTransferDestinationOptions(form.sourceChain);
  const assetOptions = getTransferAssetOptions(form.sourceChain, form.destinationChain);
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
                  setForm((current) => {
                    const sourceChain = event.target.value as ChainKey;
                    const nextDestinationOptions = getTransferDestinationOptions(sourceChain);
                    const destinationChain =
                      coerceOptionValue(current.destinationChain, nextDestinationOptions) ??
                      nextDestinationOptions[0].value;
                    const nextAssetOptions = getTransferAssetOptions(sourceChain, destinationChain);
                    return {
                      ...current,
                      sourceChain,
                      destinationChain,
                      asset:
                        coerceOptionValue(current.asset, nextAssetOptions) ??
                        nextAssetOptions[0].value,
                      recipient: exampleRecipientForChain(destinationChain),
                    };
                  })
                }
              >
                {chainOptions.map((option) => (
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
                  setForm((current) => ({
                    ...current,
                    destinationChain: event.target.value as ChainKey,
                    asset:
                      coerceOptionValue(
                        current.asset,
                        getTransferAssetOptions(
                          current.sourceChain,
                          event.target.value as ChainKey,
                        ),
                      ) ?? current.asset,
                    recipient: exampleRecipientForChain(event.target.value as ChainKey),
                  }))
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
              <span className={labelClass}>Asset</span>
              <Select
                value={form.asset}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    asset: event.target.value as AssetKey,
                  }))
                }
              >
                {assetOptions.map((option) => (
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
              <span className={labelClass}>Amount</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.amount}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>
                {recipientLabelForChain(form.destinationChain)}
              </span>
              <input
                className={inputClass}
                value={form.recipient}
                placeholder={exampleRecipientForChain(form.destinationChain)}
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
