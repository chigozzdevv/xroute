"use client";

import { useMemo, useState } from "react";

import {
  fieldClass,
  fieldFullClass,
  formClass,
  gridClass,
  inputClass,
  labelClass,
  textareaClass,
} from "./form-classes";
import { PoweredBy } from "./powered-by";
import { QuoteFooter } from "./quote-footer";
import {
  type ChainKey,
  type ExecuteType,
  chainLabel,
  coerceOptionValue,
  executeAssetForType,
  executeDestinationChain,
  executeTypeOptions,
  getExecuteSourceChainOptions,
  type QuoteRequest,
  useXRouteQuote,
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
    maxPaymentAmount: "200000000",
    contractAddress: "0x2222222222222222222222222222222222222222",
    calldata:
      "0xdeadbeef0000000000000000000000001111111111111111111111111111111111111111",
    value: "0",
    gasLimit: "250000",
    fallbackRefTime: "650000000",
    fallbackProofSize: "12288",
  };
}

function buildQuoteRequest(
  form: ExecuteFormState,
  ownerAddress?: string,
): QuoteRequest | null {
  if (form.executionType !== "call") {
    return null;
  }

  if (!form.maxPaymentAmount.trim() || !ownerAddress?.trim()) {
    return null;
  }

  if (!form.contractAddress.trim() || !form.calldata.trim()) {
    return null;
  }

  return {
    kind: "execute",
    sourceChain: form.sourceChain,
    destinationChain: form.destinationChain,
    executionType: "call",
    maxPaymentAmount: form.maxPaymentAmount,
    contractAddress: form.contractAddress,
    calldata: form.calldata,
    value: form.value,
    gasLimit: form.gasLimit,
    fallbackRefTime: form.fallbackRefTime,
    fallbackProofSize: form.fallbackProofSize,
    ownerAddress: ownerAddress.trim(),
  };
}

export function ExecuteForm() {
  const [form, setForm] = useState<ExecuteFormState>(createInitialExecuteForm);
  const { account } = useWallet();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const sourceChainOptions = useMemo(
    () => getExecuteSourceChainOptions(form.executionType),
    [form.executionType],
  );
  const executionAsset = executeAssetForType(form.executionType);
  const quoteRequest = useMemo(
    () => buildQuoteRequest(form, account ?? undefined),
    [account, form],
  );
  const { quote } = useXRouteQuote(quoteRequest);

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
                      getExecuteSourceChainOptions(executionType),
                    ) ?? current.sourceChain;

                    return {
                      ...current,
                      executionType,
                      sourceChain: nextSourceChain,
                      gasLimit: current.gasLimit || "250000",
                    };
                  })
                }
              >
                {executeTypeOptions.map((option) => (
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
                  setForm((current) => ({
                    ...current,
                    sourceChain: event.target.value as ChainKey,
                  }))
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
              <Select value={form.destinationChain} disabled>
                <option value={executeDestinationChain}>
                  {chainLabel(executeDestinationChain)}
                </option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Execution asset</span>
              <Select value={executionAsset} disabled>
                <option value={executionAsset}>{executionAsset}</option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Max payment amount</span>
              <input
                className={inputClass}
                inputMode="numeric"
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

      <PoweredBy />
    </div>
  );
}
