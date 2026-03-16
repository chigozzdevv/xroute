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
  chainOptions,
  coerceOptionValue,
  createTransferQuoteRequest,
  getTransferAssetOptions,
  getTransferDestinationOptions,
  recipientPlaceholderForChain,
  recipientLabelForChain,
  resolveWalletAccountForChain,
  submitTransferWithWallet,
  useXRouteQuote,
  useXRouteExecution,
  walletMatchesChain,
  walletRequirementLabel,
} from "@/lib/xroute";
import { Select } from "@/components/ui/select";
import { useWallet } from "@/hooks/use-wallet";

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
    recipient: "",
  };
}

function canBuildQuote(form: TransferFormState, ownerAddress?: string) {
  if (!form.amount.trim() || !form.recipient.trim() || !ownerAddress?.trim()) {
    return null;
  }
  return ownerAddress.trim();
}

export function TransferForm() {
  const [form, setForm] = useState(createInitialTransferForm);
  const { sessions } = useWallet();
  const destinationOptions = getTransferDestinationOptions(form.sourceChain);
  const assetOptions = getTransferAssetOptions(form.sourceChain, form.destinationChain);
  const ownerAddress = resolveWalletAccountForChain(sessions, form.sourceChain) ?? undefined;
  const quoteRequest = useMemo(
    () => {
      const walletAddress = canBuildQuote(form, ownerAddress);
      if (!walletAddress) {
        return null;
      }

      return createTransferQuoteRequest({
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
        submitTransferWithWallet(sessions, {
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
                      recipient: resolveWalletAccountForChain(sessions, destinationChain) ?? "",
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
                    recipient:
                      resolveWalletAccountForChain(
                        sessions,
                        event.target.value as ChainKey,
                      ) ?? "",
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
                placeholder={recipientPlaceholderForChain(form.destinationChain)}
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
          {execution.isSubmitting ? "Submitting..." : "Transfer"}
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
