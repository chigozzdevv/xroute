"use client";

import { Fragment, useState } from "react";

import {
  type AssetKey,
  type ChainKey,
  type ExecuteType,
  EXAMPLE_ADAPTER_ADDRESS,
  EXAMPLE_EVM_ADDRESS,
  chainOptions,
  chainLabel,
  coerceOptionValue,
  exampleRecipientForChain,
  executeAssetForType,
  executeDestinationChain,
  executeTypeOptions,
  getExecuteSourceChainOptions,
  getSwapAssetOutOptions,
  getSwapSettlementChainOptions,
  getTransferAssetOptions,
  getTransferDestinationOptions,
  recipientLabelForChain,
  swapAssetInOptions,
  swapDestinationChain,
  swapSourceChainOptions,
} from "@/lib/xroute";
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
import { Select } from "@/components/ui/select";

type WorkflowActionType = "transfer" | "swap" | "execute";

type TransferWorkflowStep = {
  id: string;
  kind: "transfer";
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  asset: AssetKey;
  amount: string;
  recipient: string;
};

type SwapWorkflowStep = {
  id: string;
  kind: "swap";
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  assetIn: AssetKey;
  assetOut: AssetKey;
  amountIn: string;
  minAmountOut: string;
  settlementChain: ChainKey;
  recipient: string;
};

type ExecuteWorkflowStep = {
  id: string;
  kind: "execute";
  executionType: ExecuteType;
  sourceChain: ChainKey;
  destinationChain: ChainKey;
  maxPaymentAmount: string;
  contractAddress: string;
  calldata: string;
  amount: string;
  recipient: string;
  adapterAddress: string;
  value: string;
  gasLimit: string;
  fallbackRefTime: string;
  fallbackProofSize: string;
  remark: string;
  channelId: string;
  showAdvanced: boolean;
};

type WorkflowStep = TransferWorkflowStep | SwapWorkflowStep | ExecuteWorkflowStep;

const WORKFLOW_ACTION_OPTIONS: readonly { value: WorkflowActionType; label: string }[] = [
  { value: "transfer", label: "Transfer" },
  { value: "swap", label: "Swap" },
  { value: "execute", label: "Execute" },
];

let nextWorkflowStepId = 0;

function createWorkflowStepId() {
  nextWorkflowStepId += 1;
  return `workflow-step-${nextWorkflowStepId}`;
}

function createTransferStep(): TransferWorkflowStep {
  return {
    id: createWorkflowStepId(),
    kind: "transfer",
    sourceChain: "moonbeam",
    destinationChain: "hydration",
    asset: "DOT",
    amount: "25",
    recipient: exampleRecipientForChain("hydration"),
  };
}

function createSwapStep(): SwapWorkflowStep {
  return {
    id: createWorkflowStepId(),
    kind: "swap",
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

function createExecuteStep(): ExecuteWorkflowStep {
  return {
    id: createWorkflowStepId(),
    kind: "execute",
    executionType: "call",
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    maxPaymentAmount: "200000000",
    contractAddress: "0x2222222222222222222222222222222222222222",
    calldata:
      "0xdeadbeef0000000000000000000000001111111111111111111111111111111111111111",
    amount: "10000000000",
    recipient: EXAMPLE_EVM_ADDRESS,
    adapterAddress: EXAMPLE_ADAPTER_ADDRESS,
    value: "0",
    gasLimit: "250000",
    fallbackRefTime: "650000000",
    fallbackProofSize: "12288",
    remark: "xroute",
    channelId: "0",
    showAdvanced: false,
  };
}

function createStep(kind: WorkflowActionType): WorkflowStep {
  switch (kind) {
    case "transfer":
      return createTransferStep();
    case "swap":
      return createSwapStep();
    case "execute":
      return createExecuteStep();
    default:
      throw new Error(`unsupported workflow step type: ${kind satisfies never}`);
  }
}

function WorkflowConnector() {
  return (
    <div className="-my-1 flex justify-center py-0" aria-hidden="true">
      <div className="flex flex-col items-center">
        <span className="h-px w-px bg-line/90" />
        <span className="flex h-3 w-3 items-center justify-center rounded-full border border-line bg-white/82 text-muted shadow-[0_2px_6px_rgba(15,23,20,0.03)]">
          <svg viewBox="0 0 12 8" className="h-1.5 w-1.5" fill="none">
            <path
              d="M1 1.5L6 6.5L11 1.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="h-px w-px bg-line/90" />
      </div>
    </div>
  );
}

function workflowActionLabel(step: WorkflowStep) {
  switch (step.kind) {
    case "transfer":
      return "Transfer";
    case "swap":
      return "Swap";
    case "execute":
      if (step.executionType === "call") return "Call";
      if (step.executionType === "mint-vdot") return "Mint vDOT";
      if (step.executionType === "redeem-vdot") return "Redeem vDOT";
      return step.executionType;
    default:
      throw new Error("unsupported workflow step type");
  }
}

export function WorkflowForm() {
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const isEditable = true;

  const replaceStep = (stepId: string, nextStep: WorkflowStep) => {
    setSteps((current) =>
      current.map((candidate) => (candidate.id === stepId ? nextStep : candidate)),
    );
  };

  const removeStep = (stepId: string) => {
    setSteps((current) => current.filter((candidate) => candidate.id !== stepId));
    setOpenStepId((current) => (current === stepId ? null : current));
  };

  const addStep = (kind: WorkflowActionType) => {
    const nextStep = createStep(kind);
    setSteps((current) => [...current, nextStep]);
    setOpenStepId(nextStep.id);
    setShowPicker(false);
  };

  const toggleStep = (stepId: string) => {
    setShowPicker(false);
    setOpenStepId((current) => (current === stepId ? null : stepId));
  };

  const togglePicker = () => {
    setOpenStepId(null);
    setShowPicker((current) => !current);
  };

  return (
    <div className={formClass}>
      <>
          {steps.map((step, index) => {
            const isOpen = openStepId === step.id;

            if (step.kind === "transfer") {
              const destinationOptions = getTransferDestinationOptions(step.sourceChain);
              const assetOptions = getTransferAssetOptions(
                step.sourceChain,
                step.destinationChain,
              );

              return (
                <Fragment key={step.id}>
                  <div
                    className="grid gap-4 rounded-[22px] border border-line bg-white/62 p-4 sm:p-5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => {
                          if (isEditable) {
                            toggleStep(step.id);
                          }
                        }}
                        aria-expanded={isOpen}
                      >
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-teal/12 text-sm font-semibold text-teal">
                          {index + 1}
                        </span>
                        <span className="min-w-0 text-sm font-semibold tracking-tight text-ink">
                          Transfer
                        </span>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 12 8"
                          className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 ${
                            isOpen ? "rotate-180" : ""
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
                      <button
                        type="button"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fbe8e7] text-[#c85b52] transition duration-150 hover:-translate-y-px hover:bg-[#f7d9d7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c85b52]/25 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                        onClick={() => removeStep(step.id)}
                        aria-label={`Remove transfer step ${index + 1}`}
                      >
                        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none">
                          <path
                            d="M2 2L10 10M10 2L2 10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>

                    {isOpen ? (
                      <div className={gridClass}>
                        <label className={fieldClass}>
                          <span className={labelClass}>Source chain</span>
                          <Select
                            value={step.sourceChain}
                            onChange={(event) => {
                              const sourceChain = event.target.value as ChainKey;
                              const nextDestinationOptions =
                                getTransferDestinationOptions(sourceChain);
                              const destinationChain =
                                coerceOptionValue(step.destinationChain, nextDestinationOptions) ??
                                nextDestinationOptions[0].value;
                              const nextAssetOptions = getTransferAssetOptions(
                                sourceChain,
                                destinationChain,
                              );

                              replaceStep(step.id, {
                                ...step,
                                sourceChain,
                                destinationChain,
                                asset:
                                  coerceOptionValue(step.asset, nextAssetOptions) ??
                                  nextAssetOptions[0].value,
                                recipient: exampleRecipientForChain(destinationChain),
                              });
                            }}
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
                            value={step.destinationChain}
                            onChange={(event) => {
                              const destinationChain = event.target.value as ChainKey;
                              replaceStep(step.id, {
                                ...step,
                                destinationChain,
                                asset:
                                  coerceOptionValue(
                                    step.asset,
                                    getTransferAssetOptions(step.sourceChain, destinationChain),
                                  ) ?? step.asset,
                                recipient: exampleRecipientForChain(destinationChain),
                              });
                            }}
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
                            value={step.asset}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                asset: event.target.value as AssetKey,
                              })
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
                            value={step.amount}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                amount: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldFullClass}>
                          <span className={labelClass}>
                            {recipientLabelForChain(step.destinationChain)}
                          </span>
                          <input
                            className={inputClass}
                            value={step.recipient}
                            placeholder={exampleRecipientForChain(step.destinationChain)}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                recipient: event.target.value,
                              })
                            }
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                  {index < steps.length - 1 ? <WorkflowConnector /> : null}
                </Fragment>
              );
            }

            if (step.kind === "swap") {
              const assetOutOptions = getSwapAssetOutOptions(step.assetIn);
              const settlementChainOptions = getSwapSettlementChainOptions(step.assetOut);

              return (
                <Fragment key={step.id}>
                <div
                  className="grid gap-4 rounded-[22px] border border-line bg-white/62 p-4 sm:p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => {
                          if (isEditable) {
                            toggleStep(step.id);
                          }
                        }}
                        aria-expanded={isOpen}
                      >
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-orange/12 text-sm font-semibold text-orange">
                        {index + 1}
                      </span>
                      <span className="min-w-0 text-sm font-semibold tracking-tight text-ink">
                        Swap
                      </span>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 12 8"
                          className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 ${
                            isOpen ? "rotate-180" : ""
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
                      <button
                        type="button"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fbe8e7] text-[#c85b52] transition duration-150 hover:-translate-y-px hover:bg-[#f7d9d7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c85b52]/25 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                        onClick={() => removeStep(step.id)}
                        aria-label={`Remove swap step ${index + 1}`}
                      >
                        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none">
                          <path
                            d="M2 2L10 10M10 2L2 10"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                  </div>

                  {isOpen ? (
                    <div className={gridClass}>
                    <label className={fieldClass}>
                      <span className={labelClass}>Source chain</span>
                      <Select
                        value={step.sourceChain}
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            sourceChain: event.target.value as SwapWorkflowStep["sourceChain"],
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
                      <Select value={step.destinationChain} disabled>
                        <option value={swapDestinationChain}>
                          {chainLabel(swapDestinationChain)}
                        </option>
                      </Select>
                    </label>

                    <label className={fieldClass}>
                      <span className={labelClass}>Asset in</span>
                      <Select value={step.assetIn} disabled>
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
                        value={step.assetOut}
                        onChange={(event) => {
                          const assetOut = event.target.value as AssetKey;
                          const nextSettlementChain = coerceOptionValue(
                            step.settlementChain,
                            getSwapSettlementChainOptions(assetOut),
                          ) ?? step.settlementChain;

                          replaceStep(step.id, {
                            ...step,
                            assetOut,
                            settlementChain: nextSettlementChain,
                            recipient: exampleRecipientForChain(nextSettlementChain),
                          });
                        }}
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
                        value={step.amountIn}
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            amountIn: event.target.value,
                          })
                        }
                      />
                    </label>

                    <label className={fieldClass}>
                      <span className={labelClass}>Minimum received</span>
                      <input
                        className={inputClass}
                        inputMode="decimal"
                        value={step.minAmountOut}
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            minAmountOut: event.target.value,
                          })
                        }
                      />
                    </label>

                    <label className={fieldClass}>
                      <span className={labelClass}>Settlement chain</span>
                      <Select
                        value={step.settlementChain}
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            settlementChain:
                              event.target.value as SwapWorkflowStep["settlementChain"],
                    recipient:
                      event.target.value === "hydration"
                        ? exampleRecipientForChain("hydration")
                        : EXAMPLE_EVM_ADDRESS,
                  })
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
                        {recipientLabelForChain(step.settlementChain)}
                      </span>
                      <input
                        className={inputClass}
                        value={step.recipient}
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            recipient: event.target.value,
                          })
                        }
                      />
                    </label>
                    </div>
                  ) : null}
                </div>
                {index < steps.length - 1 ? <WorkflowConnector /> : null}
                </Fragment>
              );
            }

            return (
              <Fragment key={step.id}>
              <div
                className="grid gap-4 rounded-[22px] border border-line bg-white/62 p-4 sm:p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => {
                      if (isEditable) {
                        toggleStep(step.id);
                      }
                    }}
                    aria-expanded={isOpen}
                  >
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink/10 text-sm font-semibold text-ink">
                      {index + 1}
                    </span>
                    <span className="min-w-0 text-sm font-semibold tracking-tight text-ink">
                      {workflowActionLabel(step)}
                    </span>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 12 8"
                      className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 ${
                        isOpen ? "rotate-180" : ""
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
                  <button
                    type="button"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fbe8e7] text-[#c85b52] transition duration-150 hover:-translate-y-px hover:bg-[#f7d9d7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c85b52]/25 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                    onClick={() => removeStep(step.id)}
                    aria-label={`Remove execute step ${index + 1}`}
                  >
                    <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none">
                      <path
                        d="M2 2L10 10M10 2L2 10"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>

                {isOpen ? (
                  <div className={gridClass}>
                    <label className={fieldClass}>
                      <span className={labelClass}>Type</span>
                      <Select
                        value={step.executionType}
                        onChange={(event) => {
                          const executionType = event.target.value as ExecuteType;
                          const nextSourceChain = coerceOptionValue(
                            step.sourceChain,
                            getExecuteSourceChainOptions(executionType),
                          ) ?? step.sourceChain;

                          replaceStep(step.id, {
                            ...(step.kind === "execute" ? step : createExecuteStep()),
                            executionType,
                            sourceChain: nextSourceChain,
                            gasLimit: executionType === "call" ? "250000" : "500000",
                          });
                        }}
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
                        value={step.sourceChain}
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            sourceChain: event.target.value as ExecuteWorkflowStep["sourceChain"],
                          })
                        }
                      >
                        {getExecuteSourceChainOptions(step.executionType).map((option) => (
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
                      <Select value={step.destinationChain} disabled>
                        <option value={executeDestinationChain}>
                          {chainLabel(executeDestinationChain)}
                        </option>
                      </Select>
                    </label>

                    <label className={fieldClass}>
                      <span className={labelClass}>Execution asset</span>
                      <Select value={executeAssetForType(step.executionType)} disabled>
                        <option value={executeAssetForType(step.executionType)}>
                          {executeAssetForType(step.executionType)}
                        </option>
                      </Select>
                    </label>

                    {step.executionType === "call" ? (
                      <>
                        <label className={fieldClass}>
                          <span className={labelClass}>Max payment amount</span>
                          <input
                            className={inputClass}
                            inputMode="numeric"
                            value={step.maxPaymentAmount}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                maxPaymentAmount: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldFullClass}>
                          <span className={labelClass}>Target contract</span>
                          <input
                            className={inputClass}
                            value={step.contractAddress}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                contractAddress: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldFullClass}>
                          <span className={labelClass}>Calldata</span>
                          <textarea
                            className={textareaClass}
                            rows={3}
                            value={step.calldata}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                calldata: event.target.value,
                              })
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label className={fieldClass}>
                          <span className={labelClass}>Amount</span>
                          <input
                            className={inputClass}
                            inputMode="numeric"
                            value={step.amount}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                amount: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldClass}>
                          <span className={labelClass}>Max payment amount</span>
                          <input
                            className={inputClass}
                            inputMode="numeric"
                            value={step.maxPaymentAmount}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                maxPaymentAmount: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldFullClass}>
                          <span className={labelClass}>Recipient</span>
                          <input
                            className={inputClass}
                            value={step.recipient}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                recipient: event.target.value,
                              })
                            }
                          />
                        </label>
                      </>
                    )}

                    <div className={fieldFullClass}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between rounded-[18px] border border-line bg-white/62 px-4 py-3 text-left text-sm font-semibold tracking-tight text-ink transition duration-150 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                        onClick={() =>
                          replaceStep(step.id, {
                            ...step,
                            showAdvanced: !step.showAdvanced,
                          })
                        }
                        aria-expanded={step.showAdvanced}
                      >
                        <span>Advanced</span>
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 12 8"
                          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${
                            step.showAdvanced ? "rotate-180" : ""
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

                    {step.showAdvanced ? (
                      <>
                        {step.executionType === "call" ? (
                          <label className={fieldClass}>
                            <span className={labelClass}>Native value</span>
                            <input
                              className={inputClass}
                              inputMode="numeric"
                              value={step.value}
                              onChange={(event) =>
                                replaceStep(step.id, {
                                  ...step,
                                  value: event.target.value,
                                })
                              }
                            />
                          </label>
                        ) : (
                          <>
                            <label className={fieldClass}>
                              <span className={labelClass}>Order adapter</span>
                              <input
                                className={inputClass}
                                value={step.adapterAddress}
                                onChange={(event) =>
                                  replaceStep(step.id, {
                                    ...step,
                                    adapterAddress: event.target.value,
                                  })
                                }
                              />
                            </label>

                            <label className={fieldClass}>
                              <span className={labelClass}>Remark</span>
                              <input
                                className={inputClass}
                                value={step.remark}
                                onChange={(event) =>
                                  replaceStep(step.id, {
                                    ...step,
                                    remark: event.target.value,
                                  })
                                }
                              />
                            </label>

                            <label className={fieldClass}>
                              <span className={labelClass}>Channel ID</span>
                              <input
                                className={inputClass}
                                inputMode="numeric"
                                value={step.channelId}
                                onChange={(event) =>
                                  replaceStep(step.id, {
                                    ...step,
                                    channelId: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </>
                        )}

                        <label className={fieldClass}>
                          <span className={labelClass}>Gas limit</span>
                          <input
                            className={inputClass}
                            inputMode="numeric"
                            value={step.gasLimit}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                gasLimit: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldClass}>
                          <span className={labelClass}>Fallback ref time</span>
                          <input
                            className={inputClass}
                            inputMode="numeric"
                            value={step.fallbackRefTime}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                fallbackRefTime: event.target.value,
                              })
                            }
                          />
                        </label>

                        <label className={fieldClass}>
                          <span className={labelClass}>Fallback proof size</span>
                          <input
                            className={inputClass}
                            inputMode="numeric"
                            value={step.fallbackProofSize}
                            onChange={(event) =>
                              replaceStep(step.id, {
                                ...step,
                                fallbackProofSize: event.target.value,
                              })
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {index < steps.length - 1 ? <WorkflowConnector /> : null}
              </Fragment>
            );
          })}

          {showPicker ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {WORKFLOW_ACTION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="rounded-[18px] border border-line bg-white/62 px-4 py-4 text-left text-sm font-semibold tracking-tight text-ink transition duration-150 hover:-translate-y-px hover:bg-teal/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                  onClick={() => addStep(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid gap-3">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-full bg-transparent px-2 py-2 text-sm font-semibold tracking-tight text-ink transition duration-150 hover:-translate-y-px hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
              onClick={togglePicker}
            >
              + Add step
            </button>
          </div>
      </>

      <PoweredBy />
    </div>
  );
}
