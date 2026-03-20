"use client";

import { useEffect, useMemo, useState } from "react";

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
import { usePersistedState } from "@/lib/persisted-state";
import {
  canParseAssetUnits,
  chainLabel,
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

type ExecuteMode = "demo" | "custom";

type ExecuteFormState = {
  mode: ExecuteMode;
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  executionType: ExecuteType;
  maxPaymentAmount: string;
  demoLabel: string;
  contractAddress: string;
  calldata: string;
  value: string;
  gasLimit: string;
  fallbackRefTime: string;
  fallbackProofSize: string;
};

const DEMO_MODE_OPTIONS = Object.freeze([
  { value: "demo", label: "Demo" },
  { value: "custom", label: "Custom" },
]);
const DEMO_CONTRACT_ADDRESS =
  process.env.NEXT_PUBLIC_XROUTE_MOONBEAM_EXECUTE_DEMO_CONTRACT_ADDRESS?.trim() ?? "";
const DEMO_CALldata_SELECTOR = "0x4662d1dd";
const DEMO_DEFAULT_LABEL = "xroute-demo";
const DEMO_DEFAULT_GAS_LIMIT = "180000";

function encodeDemoLabel(label?: string | null) {
  const normalized = typeof label === "string" ? label.trim() || DEMO_DEFAULT_LABEL : DEMO_DEFAULT_LABEL;
  const encoded = new TextEncoder().encode(normalized);
  const bytes = encoded.slice(0, 32);
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return `0x${Array.from(padded, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function buildDemoCalldata(label: string) {
  return `${DEMO_CALldata_SELECTOR}${encodeDemoLabel(label).slice(2)}`;
}

function resolveExecutePayload(form: ExecuteFormState) {
  if (form.mode === "demo") {
    return {
      contractAddress: DEMO_CONTRACT_ADDRESS,
      calldata: buildDemoCalldata(form.demoLabel),
    };
  }

  return {
    contractAddress: form.contractAddress.trim(),
    calldata: form.calldata.trim(),
  };
}

function createInitialExecuteForm(): ExecuteFormState {
  return {
    mode: "demo",
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    executionType: "call",
    maxPaymentAmount: "0.02",
    demoLabel: DEMO_DEFAULT_LABEL,
    contractAddress: DEMO_CONTRACT_ADDRESS,
    calldata: buildDemoCalldata(DEMO_DEFAULT_LABEL),
    value: "0",
    gasLimit: DEMO_DEFAULT_GAS_LIMIT,
    fallbackRefTime: "650000000",
    fallbackProofSize: "12288",
  };
}

function canBuildQuote(
  form: ExecuteFormState,
  resolvedContractAddress: string,
  resolvedCalldata: string,
) {
  if (form.executionType !== "call") {
    return null;
  }

  if (!form.maxPaymentAmount.trim()) {
    return null;
  }

  if (!resolvedContractAddress || !resolvedCalldata) {
    return null;
  }
  return true;
}

export function ExecuteForm() {
  const [form, setForm] = usePersistedState(
    "xroute.form.execute.v1",
    createInitialExecuteForm,
  );
  const { sessions } = useWallet();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const hasLegacyPersistedState =
    typeof (form as Partial<ExecuteFormState>).mode !== "string"
    || typeof (form as Partial<ExecuteFormState>).demoLabel !== "string";
  const effectiveForm = useMemo(
    () => (hasLegacyPersistedState ? createInitialExecuteForm() : form),
    [form, hasLegacyPersistedState],
  );
  useEffect(() => {
    if (hasLegacyPersistedState) {
      setForm(createInitialExecuteForm());
    }
  }, [hasLegacyPersistedState, setForm]);

  useEffect(() => {
    const executionType =
      coerceOptionValue(
        effectiveForm.executionType,
        getExecuteTypeOptions(effectiveForm.sourceChain, effectiveForm.destinationChain),
      )
      ?? getExecuteTypeOptions(effectiveForm.sourceChain, effectiveForm.destinationChain)[0]?.value;
    if (!executionType) {
      return;
    }
    const sourceChainOptions = getExecuteSourceChainOptions(executionType, effectiveForm.destinationChain);
    const sourceChain =
      coerceOptionValue(effectiveForm.sourceChain, sourceChainOptions)
      ?? sourceChainOptions[0]?.value;
    if (!sourceChain) {
      return;
    }
    const destinationOptions = getExecuteDestinationOptions(sourceChain, executionType);
    const destinationChain =
      coerceOptionValue(effectiveForm.destinationChain, destinationOptions)
      ?? destinationOptions[0]?.value;
    if (!destinationChain) {
      return;
    }
    if (
      executionType !== effectiveForm.executionType
      || sourceChain !== effectiveForm.sourceChain
      || destinationChain !== effectiveForm.destinationChain
    ) {
      setForm((current) => ({
        ...current,
        executionType,
        sourceChain,
        destinationChain,
      }));
    }
  }, [
    effectiveForm.destinationChain,
    effectiveForm.executionType,
    effectiveForm.sourceChain,
    setForm,
  ]);
  const sourceChainOptions = useMemo(
    () => getExecuteSourceChainOptions(effectiveForm.executionType, effectiveForm.destinationChain),
    [effectiveForm.destinationChain, effectiveForm.executionType],
  );
  const destinationOptions = useMemo(
    () => getExecuteDestinationOptions(effectiveForm.sourceChain, effectiveForm.executionType),
    [effectiveForm.executionType, effectiveForm.sourceChain],
  );
  const executionAssetOptions = useMemo(
    () =>
      getExecuteAssetOptions(
        effectiveForm.sourceChain,
        effectiveForm.destinationChain,
        effectiveForm.executionType,
      ),
    [
      effectiveForm.destinationChain,
      effectiveForm.executionType,
      effectiveForm.sourceChain,
    ],
  );
  const executionAsset =
    executionAssetOptions.find((candidate) => !candidate.disabled)?.value ?? "DOT";
  const ownerAddress = resolveWalletAccountForChain(sessions, effectiveForm.sourceChain) ?? undefined;
  const resolvedPayload = useMemo(() => resolveExecutePayload(effectiveForm), [effectiveForm]);
  const quoteRequest = useMemo(
    () => {
      if (
        !canBuildQuote(effectiveForm, resolvedPayload.contractAddress, resolvedPayload.calldata)
        || !canParseAssetUnits(executionAsset, effectiveForm.maxPaymentAmount)
      ) {
        return null;
      }

      return createExecuteQuoteRequest({
        ...effectiveForm,
        asset: executionAsset,
        contractAddress: resolvedPayload.contractAddress,
        calldata: resolvedPayload.calldata,
        ownerAddress,
      });
    },
    [
      executionAsset,
      effectiveForm,
      ownerAddress,
      resolvedPayload.calldata,
      resolvedPayload.contractAddress,
    ],
  );
  const {
    quote,
    sourceCosts,
    error: quoteError,
    lastUpdatedAtMs,
    refreshMs,
  } = useXRouteQuote(quoteRequest);
  const execution = useXRouteExecution();
  const walletReady = walletMatchesChain(sessions, effectiveForm.sourceChain);
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
    if (!walletReady || effectiveForm.executionType !== "call") {
      return;
    }

    try {
      await execution.execute(() =>
        submitCallWithWallet(sessions, {
          ...effectiveForm,
          asset: executionAsset,
          contractAddress: resolvedPayload.contractAddress,
          calldata: resolvedPayload.calldata,
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
              <span className={labelClass}>Mode</span>
              <Select
                value={effectiveForm.mode}
                onChange={(event) =>
                  setForm((current) => {
                    return {
                      ...current,
                      mode: event.target.value as ExecuteMode,
                      gasLimit: current.gasLimit || DEMO_DEFAULT_GAS_LIMIT,
                    };
                  })
                }
              >
                {DEMO_MODE_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Source chain</span>
              <Select
                value={effectiveForm.sourceChain}
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
                value={effectiveForm.destinationChain}
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
                value={effectiveForm.maxPaymentAmount}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    maxPaymentAmount: event.target.value,
                  }))
                }
              />
            </label>

            {effectiveForm.mode === "demo" ? (
              <>
                <label className={fieldFullClass}>
                  <span className={labelClass}>Check-in label</span>
                  <input
                    className={inputClass}
                    value={effectiveForm.demoLabel}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        demoLabel: event.target.value,
                      }))
                    }
                  />
                </label>

                <label className={fieldFullClass}>
                  <span className={labelClass}>Target contract</span>
                  <input
                    className={inputClass}
                    value={resolvedPayload.contractAddress}
                    readOnly
                  />
                </label>

                <label className={fieldFullClass}>
                  <span className={labelClass}>Calldata</span>
                  <textarea
                    className={textareaClass}
                    rows={3}
                    value={resolvedPayload.calldata}
                    readOnly
                  />
                </label>
              </>
            ) : (
              <>
                <label className={fieldFullClass}>
                  <span className={labelClass}>Target contract</span>
                  <input
                    className={inputClass}
                    value={effectiveForm.contractAddress}
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
                    value={effectiveForm.calldata}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        calldata: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}

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
                    value={effectiveForm.value}
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
                    value={effectiveForm.gasLimit}
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
                    value={effectiveForm.fallbackRefTime}
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
                    value={effectiveForm.fallbackProofSize}
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
              effectiveForm.executionType !== "call"
              || !walletReady
              || !quote
              || execution.isSubmitting
              || execution.isTracking
            }
          >
            {execution.isSubmitting ? "Submitting..." : "Call"}
          </button>
          {!walletReady ? (
            <p className="m-0 text-center text-sm leading-6 text-muted">
              {`Connect a ${walletRequirementLabel(effectiveForm.sourceChain).toLowerCase()} to execute from ${chainLabel(effectiveForm.sourceChain)}.`}
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
