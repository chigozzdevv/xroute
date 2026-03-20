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
  type ChainKey,
  coerceOptionValue,
  createTransferQuoteRequest,
  getTransferAssetOptions,
  getTransferDestinationOptions,
  recipientPlaceholderForChain,
  recipientLabelForChain,
  resolveWalletAccountForChain,
  submitTransferWithWallet,
  transferSourceChainOptions,
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
    destinationChain: "polkadot-hub",
    asset: "DOT",
    amount: "25",
    recipient: "",
  };
}

function canBuildQuote(form: TransferFormState) {
  return form.amount.trim() && canParseAssetUnits(form.asset, form.amount) ? true : null;
}

export function TransferForm() {
  const [form, setForm] = usePersistedState(
    "xroute.form.transfer.v1",
    createInitialTransferForm,
  );
  const { sessions } = useWallet();
  useEffect(() => {
    const sourceChain =
      coerceOptionValue(form.sourceChain, transferSourceChainOptions)
      ?? transferSourceChainOptions[0]?.value;
    if (!sourceChain) {
      return;
    }
    const destinationOptions = getTransferDestinationOptions(sourceChain);
    const destinationChain =
      coerceOptionValue(form.destinationChain, destinationOptions)
      ?? destinationOptions[0]?.value;
    if (!destinationChain) {
      return;
    }
    const assetOptions = getTransferAssetOptions(sourceChain, destinationChain);
    const asset =
      coerceOptionValue(form.asset, assetOptions)
      ?? assetOptions[0]?.value;
    if (!asset) {
      return;
    }
    if (
      sourceChain !== form.sourceChain
      || destinationChain !== form.destinationChain
      || asset !== form.asset
    ) {
      setForm((current) => ({
        ...current,
        sourceChain,
        destinationChain,
        asset,
      }));
    }
  }, [form.asset, form.destinationChain, form.sourceChain, setForm]);
  const destinationOptions = getTransferDestinationOptions(form.sourceChain);
  const assetOptions = getTransferAssetOptions(form.sourceChain, form.destinationChain);
  const ownerAddress = resolveWalletAccountForChain(sessions, form.sourceChain) ?? undefined;
  const executionRecipient =
    form.recipient.trim()
    || resolveWalletAccountForChain(sessions, form.destinationChain)
    || "";
  const recipientReady = Boolean(executionRecipient);
  const quoteRequest = useMemo(
    () => {
      if (!canBuildQuote(form)) {
        return null;
      }

      return createTransferQuoteRequest({
        ...form,
        recipient: executionRecipient || undefined,
        ownerAddress,
      });
    },
    [executionRecipient, form, ownerAddress],
  );
  const {
    quote,
    sourceCosts,
    error: quoteError,
    lastUpdatedAtMs,
    refreshMs,
  } = useXRouteQuote(quoteRequest);
  const execution = useXRouteExecution();
  const walletReady = walletMatchesChain(sessions, form.sourceChain);
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

  async function handleSubmit() {
    if (!walletReady) {
      return;
    }

    try {
      await execution.execute(() =>
        submitTransferWithWallet(sessions, {
          ...form,
          recipient: executionRecipient,
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
                {transferSourceChainOptions.map((option) => (
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
            disabled={
              !walletReady
              || !recipientReady
              || !quote
              || execution.isSubmitting
              || execution.isTracking
            }
          >
            {execution.isSubmitting ? "Submitting..." : "Transfer"}
          </button>
          {!walletReady ? (
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
