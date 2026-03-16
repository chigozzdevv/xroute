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
  textareaClass,
} from "./form-classes";
import { IntentStatusCard } from "./intent-status-card";
import { PoweredBy } from "./powered-by";
import { QuoteFooter } from "./quote-footer";
import {
  type ChainKey,
  type ExecuteType,
  coerceOptionValue,
  createExecuteQuoteRequest,
  getExecuteAssetOptions,
  getExecuteDestinationOptions,
  getExecuteSourceChainOptions,
  getExecuteTypeOptions,
  resolveWalletAccountForChain,
  submitCallWithWallet,
  useXRouteExecution,
  useXRouteQuote,
  walletMatchesChain,
  walletRequirementLabel,
} from "@/lib/xroute";
import { Select } from "@/components/ui/select";
import { useWallet } from "@/hooks/use-wallet";

type ExecuteFormState = {
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  executionType: ExecuteType;
  maxPaymentAmount: string;
  contractAddress: string;
  calldata: string;
  value: string;
  gasLimit: string;
  fallbackRefTime: string;
  fallbackProofSize: string;
};

function createInitialExecuteForm(): ExecuteFormState {
  return {
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    executionType: "call",
    maxPaymentAmount: "0.02",
    contractAddress: "0x2222222222222222222222222222222222222222",
    calldata:
      "0xdeadbeef0000000000000000000000001111111111111111111111111111111111111111",
    value: "0",
    gasLimit: "250000",
    fallbackRefTime: "650000000",
    fallbackProofSize: "12288",
  };
}

function canBuildQuote(form: ExecuteFormState, ownerAddress?: string) {
  if (form.executionType !== "call") {
    return null;
  }

  if (!form.maxPaymentAmount.trim() || !ownerAddress?.trim()) {
    return null;
  }

  if (!form.contractAddress.trim() || !form.calldata.trim()) {
    return null;
  }
  return ownerAddress.trim();
}

export function ExecuteForm() {
  const [form, setForm] = useState<ExecuteFormState>(createInitialExecuteForm);
  const { sessions } = useWallet();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const executionTypeOptions = useMemo(
    () => getExecuteTypeOptions(form.sourceChain, form.destinationChain),
    [form.destinationChain, form.sourceChain],
  );
  const sourceChainOptions = useMemo(
    () => getExecuteSourceChainOptions(form.executionType, form.destinationChain),
    [form.destinationChain, form.executionType],
  );
  const destinationOptions = useMemo(
    () => getExecuteDestinationOptions(form.sourceChain, form.executionType),
    [form.executionType, form.sourceChain],
  );
  const executionAssetOptions = useMemo(
    () => getExecuteAssetOptions(form.sourceChain, form.destinationChain, form.executionType),
    [form.destinationChain, form.executionType, form.sourceChain],
  );
  const executionAsset =
    executionAssetOptions.find((candidate) => !candidate.disabled)?.value ?? "DOT";
  const ownerAddress = resolveWalletAccountForChain(sessions, form.sourceChain) ?? undefined;
  const quoteRequest = useMemo(
    () => {
      const walletAddress = canBuildQuote(form, ownerAddress);
      if (!walletAddress) {
        return null;
      }

      return createExecuteQuoteRequest({
        ...form,
        asset: executionAsset,
        ownerAddress: walletAddress,
      });
    },
    [executionAsset, form, ownerAddress],
  );
  const { quote, error: quoteError } = useXRouteQuote(quoteRequest);
  const execution = useXRouteExecution();
  const walletReady = walletMatchesChain(sessions, form.sourceChain);

  async function handleSubmit() {
    if (!walletReady || form.executionType !== "call") {
      return;
    }

    try {
      await execution.execute(() =>
        submitCallWithWallet(sessions, {
          ...form,
          asset: executionAsset,
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
              <span className={labelClass}>Type</span>
              <Select
                value={form.executionType}
                onChange={(event) =>
                  setForm((current) => {
                    const executionType = event.target.value as ExecuteType;
                    const nextSourceChain = coerceOptionValue(
                      current.sourceChain,
                      getExecuteSourceChainOptions(executionType, current.destinationChain),
                    ) ?? current.sourceChain;
                    const nextDestinationChain = coerceOptionValue(
                      current.destinationChain,
                      getExecuteDestinationOptions(nextSourceChain, executionType),
                    ) ?? current.destinationChain;

                    return {
                      ...current,
                      executionType,
                      sourceChain: nextSourceChain,
                      destinationChain: nextDestinationChain,
                      gasLimit: current.gasLimit || "250000",
                    };
                  })
                }
              >
                {executionTypeOptions.map((option) => (
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
              <span className={labelClass}>Source chain</span>
              <Select
                value={form.sourceChain}
                onChange={(event) =>
                  setForm((current) => {
                    const sourceChain = event.target.value as ChainKey;
                    const destinationChain = coerceOptionValue(
                      current.destinationChain,
                      getExecuteDestinationOptions(sourceChain, current.executionType),
                    ) ?? current.destinationChain;

                    return {
                      ...current,
                      sourceChain,
                      destinationChain,
                    };
                  })
                }
              >
                {sourceChainOptions.map((option) => (
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
              <span className={labelClass}>Execution asset</span>
              <Select value={executionAsset} disabled>
                {executionAssetOptions.map((option) => (
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
              <span className={labelClass}>Max payment amount</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.maxPaymentAmount}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    maxPaymentAmount: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>Target contract</span>
              <input
                className={inputClass}
                value={form.contractAddress}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    contractAddress: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>Calldata</span>
              <textarea
                className={textareaClass}
                rows={3}
                value={form.calldata}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    calldata: event.target.value,
                  }))
                }
              />
            </label>

            <div className={fieldFullClass}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-[18px] border border-line bg-white/62 px-4 py-3 text-left text-sm font-semibold tracking-tight text-ink transition duration-150 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                onClick={() => setShowAdvanced((current) => !current)}
                aria-expanded={showAdvanced}
              >
                <span>Advanced</span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 12 8"
                  className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${
                    showAdvanced ? "rotate-180" : ""
                  }`}
                  fill="none"
                >
                  <path
                    d="M1 1.5L6 6.5L11 1.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            {showAdvanced ? (
              <>
                <label className={fieldClass}>
                  <span className={labelClass}>Native value</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={form.value}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        value: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className={fieldClass}>
                  <span className={labelClass}>Gas limit</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={form.gasLimit}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        gasLimit: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className={fieldClass}>
                  <span className={labelClass}>Fallback ref time</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={form.fallbackRefTime}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        fallbackRefTime: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className={fieldClass}>
                  <span className={labelClass}>Fallback proof size</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={form.fallbackProofSize}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        fallbackProofSize: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            ) : null}
      </div>

      <QuoteFooter quote={quote} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm leading-6 text-muted">
          {walletReady
            ? "Quote ready. Submit to execute the contract call."
            : `Connect a ${walletRequirementLabel(form.sourceChain).toLowerCase()} to quote and execute from ${form.sourceChain}.`}
        </p>
        <button
          type="button"
          className={actionButtonClass}
          onClick={handleSubmit}
          disabled={
            form.executionType !== "call"
            || !walletReady
            || !quote
            || execution.isSubmitting
            || execution.isTracking
          }
        >
          {execution.isSubmitting ? "Submitting..." : "Call"}
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
