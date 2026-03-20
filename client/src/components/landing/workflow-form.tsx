"use client";

import { Fragment, useEffect, useState } from "react";

import {
  type AssetKey,
  type ChainKey,
  type ExecuteType,
  EXAMPLE_ADAPTER_ADDRESS,
  type IntentExecutionResult,
  type IntentStatus,
  type IntentTimeline,
  coerceOptionValue,
  connectWalletSessionForChain,
  getTransactionExplorerUrl,
  getXRouteIntentStatus,
  getXRouteIntentTimeline,
  getExecuteAssetOptions,
  getExecuteDestinationOptions,
  getExecuteSourceChainOptions,
  getExecuteTypeOptions,
  getSwapAssetInOptions,
  getSwapAssetOutOptions,
  getSwapDestinationOptions,
  getSwapSettlementChainOptions,
  getTransferAssetOptions,
  getTransferDestinationOptions,
  recipientPlaceholderForChain,
  recipientLabelForChain,
  resolveWalletAccountForChain,
  submitCallWithWallet,
  submitSwapWithWallet,
  submitTransferWithWallet,
  swapSourceChainOptions,
  transferSourceChainOptions,
  useXRouteExecution,
  waitForXRouteIntent,
  walletMatchesChain,
} from "@/lib/xroute";
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
import { usePersistedState } from "@/lib/persisted-state";
import { Select } from "@/components/ui/select";
import { useWallet } from "@/hooks/use-wallet";

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

type WorkflowStepSnapshot = {
  execution: IntentExecutionResult;
  status: IntentStatus | null;
  timeline: IntentTimeline;
  error: string | null;
};

const WORKFLOW_ACTION_OPTIONS: readonly { value: WorkflowActionType; label: string }[] = [
  { value: "transfer", label: "Transfer" },
  { value: "swap", label: "Swap" },
  { value: "execute", label: "Execute" },
];

let nextWorkflowStepId = 0;

function createWorkflowStepId() {
  nextWorkflowStepId += 1;
  return `workflow-step-${Date.now()}-${nextWorkflowStepId}`;
}

function createTransferStep(): TransferWorkflowStep {
  return {
    id: createWorkflowStepId(),
    kind: "transfer",
    sourceChain: "moonbeam",
    destinationChain: "polkadot-hub",
    asset: "DOT",
    amount: "25",
    recipient: "",
  };
}

function createSwapStep(): SwapWorkflowStep {
  return {
    id: createWorkflowStepId(),
    kind: "swap",
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    assetIn: "DOT",
    assetOut: "USDT",
    amountIn: "10",
    minAmountOut: "49",
    settlementChain: "hydration",
    recipient: "",
  };
}

function createExecuteStep(): ExecuteWorkflowStep {
  return {
    id: createWorkflowStepId(),
    kind: "execute",
    executionType: "call",
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    maxPaymentAmount: "0.02",
    contractAddress: "0x2222222222222222222222222222222222222222",
    calldata:
      "0xdeadbeef0000000000000000000000001111111111111111111111111111111111111111",
    amount: "10000000000",
    recipient: "",
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

function getWorkflowExecuteAsset(step: ExecuteWorkflowStep) {
  return (
    getExecuteAssetOptions(step.sourceChain, step.destinationChain, step.executionType).find(
      (candidate) => !candidate.disabled,
    )?.value ?? "DOT"
  );
}

function ExplorerArrow({
  chainKey,
  txHash,
}: {
  chainKey: ChainKey | null | undefined;
  txHash: string | null | undefined;
}) {
  if (!chainKey || !txHash) {
    return null;
  }

  const href = getTransactionExplorerUrl(chainKey, txHash);
  if (!href) {
    return null;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink transition duration-150 hover:-translate-y-px hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      aria-label="Open in explorer"
      title="Open in explorer"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
        <path
          d="M6 4H12V10M11.5 4.5L4 12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

function workflowStepStateClasses(state: "completed" | "active" | "pending" | "failed") {
  switch (state) {
    case "completed":
      return {
        dot: "border-[#16a34a] bg-[#16a34a] text-white",
        line: "bg-[#16a34a]/25",
        row: "px-1 py-0.5",
        title: "text-[#15803d]",
        meta: "text-[#15803d]/80",
      };
    case "active":
      return {
        dot: "border-teal bg-white text-teal",
        line: "bg-teal/18",
        row: "rounded-[18px] border border-teal/20 bg-white px-4 py-3 shadow-[0_18px_36px_rgba(14,116,108,0.08)]",
        title: "text-ink",
        meta: "text-teal",
      };
    case "failed":
      return {
        dot: "border-danger bg-danger text-white",
        line: "bg-danger/18",
        row: "rounded-[18px] border border-danger/18 bg-[#fff6f6] px-4 py-3",
        title: "text-ink",
        meta: "text-danger",
      };
    default:
      return {
        dot: "border-line bg-white text-muted",
        line: "bg-line/80",
        row: "px-1 py-0.5",
        title: "text-muted",
        meta: "text-muted",
      };
  }
}

function WorkflowStepMarker({
  state,
}: {
  state: "completed" | "active" | "pending" | "failed";
}) {
  const classes = workflowStepStateClasses(state);

  return (
    <span
      className={`relative z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border text-[0.7rem] font-semibold ${classes.dot}`}
    >
      {state === "completed" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
          <path
            d="M3.5 8.5L6.5 11.5L12.5 4.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : state === "failed" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
          <path
            d="M5 5L11 11M11 5L5 11"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : state === "active" ? (
        <span className="h-2.5 w-2.5 rounded-full bg-teal" />
      ) : (
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
      )}
    </span>
  );
}

export function WorkflowForm() {
  const [steps, setSteps] = usePersistedState<WorkflowStep[]>(
    "xroute.form.workflow.steps.v1",
    () => [],
  );
  const [showPicker, setShowPicker] = useState(false);
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [completedSnapshots, setCompletedSnapshots] = useState<Record<string, WorkflowStepSnapshot>>({});
  const [activeRunStepId, setActiveRunStepId] = useState<string | null>(null);
  const { sessions } = useWallet();
  const activeExecution = useXRouteExecution();
  const isEditable = true;
  const workflowSourceChains = [...new Set(steps.map((step) => step.sourceChain))];
  const walletReady =
    workflowSourceChains.length > 0
    && workflowSourceChains.every((sourceChain) => walletMatchesChain(sessions, sourceChain));

  useEffect(() => {
    const normalizedSteps = steps.map((step) => {
      if (step.kind === "transfer") {
        const sourceChain =
          coerceOptionValue(step.sourceChain, transferSourceChainOptions)
          ?? transferSourceChainOptions[0]?.value;
        if (!sourceChain) {
          return step;
        }
        const destinationOptions = getTransferDestinationOptions(sourceChain);
        const destinationChain =
          coerceOptionValue(step.destinationChain, destinationOptions)
          ?? destinationOptions[0]?.value;
        if (!destinationChain) {
          return step;
        }
        const assetOptions = getTransferAssetOptions(sourceChain, destinationChain);
        const asset =
          coerceOptionValue(step.asset, assetOptions)
          ?? assetOptions[0]?.value;
        if (!asset) {
          return step;
        }
        return {
          ...step,
          sourceChain,
          destinationChain,
          asset,
        };
      }

      if (step.kind === "swap") {
        const sourceChain =
          coerceOptionValue(step.sourceChain, swapSourceChainOptions)
          ?? swapSourceChainOptions[0]?.value;
        if (!sourceChain) {
          return step;
        }
        const destinationOptions = getSwapDestinationOptions(sourceChain);
        const destinationChain =
          coerceOptionValue(step.destinationChain, destinationOptions)
          ?? destinationOptions[0]?.value;
        if (!destinationChain) {
          return step;
        }
        const assetInOptions = getSwapAssetInOptions(sourceChain, destinationChain);
        const assetIn =
          coerceOptionValue(step.assetIn, assetInOptions)
          ?? assetInOptions[0]?.value;
        if (!assetIn) {
          return step;
        }
        const assetOutOptions = getSwapAssetOutOptions(sourceChain, destinationChain, assetIn);
        const assetOut =
          coerceOptionValue(step.assetOut, assetOutOptions)
          ?? assetOutOptions[0]?.value;
        if (!assetOut) {
          return step;
        }
        const settlementOptions = getSwapSettlementChainOptions(
          sourceChain,
          destinationChain,
          assetIn,
          assetOut,
        );
        const settlementChain =
          coerceOptionValue(step.settlementChain, settlementOptions)
          ?? settlementOptions[0]?.value;
        if (!settlementChain) {
          return step;
        }
        return {
          ...step,
          sourceChain,
          destinationChain,
          assetIn,
          assetOut,
          settlementChain,
        };
      }

      const executionType =
        coerceOptionValue(step.executionType, getExecuteTypeOptions(step.sourceChain, step.destinationChain))
        ?? getExecuteTypeOptions(step.sourceChain, step.destinationChain)[0]?.value;
      if (!executionType) {
        return step;
      }
      const sourceChainOptions = getExecuteSourceChainOptions(executionType, step.destinationChain);
      const sourceChain =
        coerceOptionValue(step.sourceChain, sourceChainOptions)
        ?? sourceChainOptions[0]?.value;
      if (!sourceChain) {
        return step;
      }
      const destinationOptions = getExecuteDestinationOptions(sourceChain, executionType);
      const destinationChain =
        coerceOptionValue(step.destinationChain, destinationOptions)
        ?? destinationOptions[0]?.value;
      if (!destinationChain) {
        return step;
      }
      return {
        ...step,
        executionType,
        sourceChain,
        destinationChain,
      };
    });

    if (JSON.stringify(normalizedSteps) !== JSON.stringify(steps)) {
      setSteps(normalizedSteps);
    }
  }, [steps, setSteps]);

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

  async function submitWorkflowStep(step: WorkflowStep) {
    switch (step.kind) {
      case "transfer": {
        const recipient =
          step.recipient.trim()
          || resolveWalletAccountForChain(sessions, step.destinationChain)
          || "";
        if (!recipient) {
          throw new Error(`Enter a recipient for ${workflowActionLabel(step).toLowerCase()}.`);
        }

        return submitTransferWithWallet(sessions, {
          sourceChain: step.sourceChain,
          destinationChain: step.destinationChain,
          asset: step.asset,
          amount: step.amount,
          recipient,
        });
      }
      case "swap": {
        const recipient =
          step.recipient.trim()
          || resolveWalletAccountForChain(sessions, step.settlementChain)
          || "";
        if (!recipient) {
          throw new Error(`Enter a recipient for ${workflowActionLabel(step).toLowerCase()}.`);
        }

        return submitSwapWithWallet(sessions, {
          sourceChain: step.sourceChain,
          destinationChain: step.destinationChain,
          assetIn: step.assetIn,
          assetOut: step.assetOut,
          amountIn: step.amountIn,
          minAmountOut: step.minAmountOut,
          settlementChain: step.settlementChain,
          recipient,
        });
      }
      case "execute":
        if (step.executionType !== "call") {
          throw new Error("Only call workflow steps are currently supported.");
        }

        return submitCallWithWallet(sessions, {
          sourceChain: step.sourceChain,
          destinationChain: step.destinationChain,
          asset: getWorkflowExecuteAsset(step),
          executionType: step.executionType,
          maxPaymentAmount: step.maxPaymentAmount,
          contractAddress: step.contractAddress,
          calldata: step.calldata,
          value: step.value,
          gasLimit: step.gasLimit,
          fallbackRefTime: step.fallbackRefTime,
          fallbackProofSize: step.fallbackProofSize,
        });
      default:
        throw new Error("unsupported workflow step type");
    }
  }

  async function handleRunWorkflow() {
    if (!walletReady || workflowSourceChains.length === 0) {
      return;
    }

    setIsRunning(true);
    setFlowError(null);
    setCompletedSnapshots({});
    setActiveRunStepId(null);

    try {
      for (const sourceChain of workflowSourceChains) {
        connectWalletSessionForChain(sessions, sourceChain);
      }

      for (const [index, step] of steps.entries()) {
        const ownerAddress = resolveWalletAccountForChain(sessions, step.sourceChain);
        if (!ownerAddress) {
          throw new Error(
            `Connect the required wallet for ${step.sourceChain} before running the workflow.`,
          );
        }

        setActiveRunStepId(step.id);
        const execution = await activeExecution.execute(() => submitWorkflowStep(step));
        const finalStatus = await waitForXRouteIntent(execution.submitted.intentId);
        const [statusSnapshot, timelineSnapshot] = await Promise.all([
          getXRouteIntentStatus(execution.submitted.intentId),
          getXRouteIntentTimeline(execution.submitted.intentId),
        ]);
        const snapshot: WorkflowStepSnapshot = {
          execution,
          status: statusSnapshot ?? finalStatus ?? null,
          timeline: timelineSnapshot,
          error: null,
        };

        setCompletedSnapshots((current) => ({
          ...current,
          [step.id]: snapshot,
        }));

        if (finalStatus?.status !== "settled") {
          throw new Error(
            `Workflow step ${index + 1} (${workflowActionLabel(step)}) ended with status ${
              finalStatus?.status ?? "unknown"
            }.`,
          );
        }

        activeExecution.reset();
      }

      setActiveRunStepId(null);
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : "Workflow execution failed.");
    } finally {
      setIsRunning(false);
    }
  }

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
                                recipient:
                                  resolveWalletAccountForChain(sessions, destinationChain) ?? "",
                              });
                            }}
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
                                recipient:
                                  resolveWalletAccountForChain(sessions, destinationChain) ?? "",
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
                            placeholder={recipientPlaceholderForChain(step.destinationChain)}
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
              const destinationOptions = getSwapDestinationOptions(step.sourceChain);
              const assetInOptions = getSwapAssetInOptions(step.sourceChain, step.destinationChain);
              const assetOutOptions = getSwapAssetOutOptions(
                step.sourceChain,
                step.destinationChain,
                step.assetIn,
              );
              const settlementChainOptions = getSwapSettlementChainOptions(
                step.sourceChain,
                step.destinationChain,
                step.assetIn,
                step.assetOut,
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
                        onChange={(event) => {
                          const sourceChain = event.target.value as SwapWorkflowStep["sourceChain"];
                          const nextDestinationOptions = getSwapDestinationOptions(sourceChain);
                          const destinationChain =
                            coerceOptionValue(step.destinationChain, nextDestinationOptions) ??
                            step.destinationChain;
                          const nextAssetInOptions = getSwapAssetInOptions(
                            sourceChain,
                            destinationChain,
                          );
                          const assetIn =
                            coerceOptionValue(step.assetIn, nextAssetInOptions) ?? step.assetIn;
                          const nextAssetOutOptions = getSwapAssetOutOptions(
                            sourceChain,
                            destinationChain,
                            assetIn,
                          );
                          const assetOut =
                            coerceOptionValue(step.assetOut, nextAssetOutOptions) ?? step.assetOut;
                          const nextSettlementOptions = getSwapSettlementChainOptions(
                            sourceChain,
                            destinationChain,
                            assetIn,
                            assetOut,
                          );
                          const settlementChain =
                            coerceOptionValue(step.settlementChain, nextSettlementOptions) ??
                            step.settlementChain;

                          replaceStep(step.id, {
                            ...step,
                            sourceChain,
                            destinationChain,
                            assetIn,
                            assetOut,
                            settlementChain,
                            recipient:
                              resolveWalletAccountForChain(sessions, settlementChain) ?? "",
                          });
                        }}
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
                        value={step.destinationChain}
                        onChange={(event) => {
                          const destinationChain =
                            event.target.value as SwapWorkflowStep["destinationChain"];
                          const nextAssetInOptions = getSwapAssetInOptions(
                            step.sourceChain,
                            destinationChain,
                          );
                          const assetIn =
                            coerceOptionValue(step.assetIn, nextAssetInOptions) ?? step.assetIn;
                          const nextAssetOutOptions = getSwapAssetOutOptions(
                            step.sourceChain,
                            destinationChain,
                            assetIn,
                          );
                          const assetOut =
                            coerceOptionValue(step.assetOut, nextAssetOutOptions) ?? step.assetOut;
                          const nextSettlementOptions = getSwapSettlementChainOptions(
                            step.sourceChain,
                            destinationChain,
                            assetIn,
                            assetOut,
                          );
                          const settlementChain =
                            coerceOptionValue(step.settlementChain, nextSettlementOptions) ??
                            step.settlementChain;

                          replaceStep(step.id, {
                            ...step,
                            destinationChain,
                            assetIn,
                            assetOut,
                            settlementChain,
                            recipient:
                              resolveWalletAccountForChain(sessions, settlementChain) ?? "",
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
                      <span className={labelClass}>Asset in</span>
                      <Select
                        value={step.assetIn}
                        onChange={(event) => {
                          const assetIn = event.target.value as AssetKey;
                          const nextAssetOutOptions = getSwapAssetOutOptions(
                            step.sourceChain,
                            step.destinationChain,
                            assetIn,
                          );
                          const assetOut =
                            coerceOptionValue(step.assetOut, nextAssetOutOptions) ?? step.assetOut;
                          const nextSettlementOptions = getSwapSettlementChainOptions(
                            step.sourceChain,
                            step.destinationChain,
                            assetIn,
                            assetOut,
                          );
                          const settlementChain =
                            coerceOptionValue(step.settlementChain, nextSettlementOptions) ??
                            step.settlementChain;

                          replaceStep(step.id, {
                            ...step,
                            assetIn,
                            assetOut,
                            settlementChain,
                            recipient:
                              resolveWalletAccountForChain(sessions, settlementChain) ?? "",
                          });
                        }}
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
                        value={step.assetOut}
                        onChange={(event) => {
                          const assetOut = event.target.value as AssetKey;
                          const nextSettlementChain = coerceOptionValue(
                            step.settlementChain,
                            getSwapSettlementChainOptions(
                              step.sourceChain,
                              step.destinationChain,
                              step.assetIn,
                              assetOut,
                            ),
                          ) ?? step.settlementChain;

                          replaceStep(step.id, {
                            ...step,
                            assetOut,
                            settlementChain: nextSettlementChain,
                            recipient:
                              resolveWalletAccountForChain(sessions, nextSettlementChain) ?? "",
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
                              resolveWalletAccountForChain(
                                sessions,
                                event.target.value as SwapWorkflowStep["settlementChain"],
                              ) ?? "",
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
                        placeholder={recipientPlaceholderForChain(step.settlementChain)}
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

            const executionTypeOptions = getExecuteTypeOptions(
              step.sourceChain,
              step.destinationChain,
            );
            const executeSourceChainOptions = getExecuteSourceChainOptions(
              step.executionType,
              step.destinationChain,
            );
            const executeDestinationOptions = getExecuteDestinationOptions(
              step.sourceChain,
              step.executionType,
            );
            const executeAssetOptions = getExecuteAssetOptions(
              step.sourceChain,
              step.destinationChain,
              step.executionType,
            );
            const executionAsset =
              executeAssetOptions.find((candidate) => !candidate.disabled)?.value ?? "DOT";

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
                            getExecuteSourceChainOptions(executionType, step.destinationChain),
                          ) ?? step.sourceChain;
                          const nextDestinationChain = coerceOptionValue(
                            step.destinationChain,
                            getExecuteDestinationOptions(nextSourceChain, executionType),
                          ) ?? step.destinationChain;

                          replaceStep(step.id, {
                            ...(step.kind === "execute" ? step : createExecuteStep()),
                            executionType,
                            sourceChain: nextSourceChain,
                            destinationChain: nextDestinationChain,
                            gasLimit: executionType === "call" ? "250000" : "500000",
                          });
                        }}
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
                        value={step.sourceChain}
                        onChange={(event) => {
                          const sourceChain =
                            event.target.value as ExecuteWorkflowStep["sourceChain"];
                          const destinationChain = coerceOptionValue(
                            step.destinationChain,
                            getExecuteDestinationOptions(sourceChain, step.executionType),
                          ) ?? step.destinationChain;

                          replaceStep(step.id, {
                            ...step,
                            sourceChain,
                            destinationChain,
                          });
                        }}
                      >
                        {executeSourceChainOptions.map((option) => (
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
                        onChange={(event) =>
                          replaceStep(step.id, {
                            ...step,
                            destinationChain:
                              event.target.value as ExecuteWorkflowStep["destinationChain"],
                          })
                        }
                      >
                        {executeDestinationOptions.map((option) => (
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
                        {executeAssetOptions.map((option) => (
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

                    {step.executionType === "call" ? (
                      <>
                        <label className={fieldClass}>
                          <span className={labelClass}>Max payment amount</span>
                          <input
                            className={inputClass}
                            inputMode="decimal"
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

            <button
              type="button"
              className={actionButtonClass}
              onClick={handleRunWorkflow}
              disabled={!walletReady || steps.length === 0 || isRunning}
            >
              {isRunning ? "Running workflow..." : "Run workflow"}
            </button>
          </div>

          {steps.length === 0 ? (
            <p className="m-0 text-sm leading-6 text-muted">
              Add at least one step to run a workflow.
            </p>
          ) : null}

          {steps.length > 0 && !walletReady ? (
            <p className="m-0 text-sm leading-6 text-muted">
              Connect the required source wallets for every step in this workflow.
            </p>
          ) : null}

          {flowError ? (
            <div className="rounded-[18px] border border-line bg-white/62 px-4 py-3.5 sm:px-5">
              <p className="m-0 text-sm leading-6 text-danger">{flowError}</p>
            </div>
          ) : null}

          {(isRunning
            || activeRunStepId !== null
            || flowError !== null
            || Object.keys(completedSnapshots).length > 0) ? (
            <div className="grid gap-3 rounded-[18px] border border-line bg-white/62 px-4 py-3.5 sm:px-5">
              <div>
                <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
                  Workflow status
                </p>
                <p className="mt-1 text-lg font-extrabold tracking-[-0.04em] text-ink">
                  {isRunning
                    ? "Running"
                    : flowError
                      ? "Failed"
                      : steps.length > 0 && Object.keys(completedSnapshots).length === steps.length
                        ? "Completed"
                        : "Ready"}
                </p>
              </div>

              <div className="grid gap-3 border-t border-line/70 pt-3">
                {steps.map((step, index) => {
                  const completedSnapshot = completedSnapshots[step.id] ?? null;
                  const isActive = activeRunStepId === step.id;
                  const state =
                    completedSnapshot
                      ? completedSnapshot.status?.status === "settled"
                        ? "completed"
                        : completedSnapshot.status?.status === "failed"
                          ? "failed"
                          : "completed"
                      : isActive
                        ? activeExecution.error || activeExecution.status?.status === "failed"
                          ? "failed"
                          : "active"
                        : "pending";
                  const classes = workflowStepStateClasses(state);
                  const summaryStatus = completedSnapshot
                    ? completedSnapshot.status?.status === "failed"
                      ? "Failed"
                      : "Completed"
                    : isActive
                      ? activeExecution.error
                        ? "Failed"
                        : activeExecution.isSubmitting
                          ? "Submitting"
                          : "Running"
                      : "Pending";
                  const summaryMeta = completedSnapshot
                    ? null
                    : isActive
                      ? activeExecution.error ?? null
                      : null;
                  const explorerChain = completedSnapshot
                    ? completedSnapshot.execution.intent?.sourceChain
                    : activeExecution.execution?.intent?.sourceChain ?? null;
                  const explorerTxHash = completedSnapshot
                    ? completedSnapshot.execution.dispatched?.txHash
                      ?? completedSnapshot.execution.submitted?.txHash
                      ?? null
                    : activeExecution.execution?.dispatched?.txHash
                      ?? activeExecution.execution?.submitted?.txHash
                      ?? null;

                  return (
                    <div key={step.id} className="flex items-start gap-4">
                      <div className="relative flex w-6 shrink-0 justify-center">
                        <WorkflowStepMarker state={state} />
                        {index < steps.length - 1 ? (
                          <span className={`absolute left-1/2 top-6 bottom-[-1.1rem] w-px -translate-x-1/2 ${classes.line}`} />
                        ) : null}
                      </div>
                      <div className={`min-w-0 flex-1 ${classes.row}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`m-0 text-sm font-semibold tracking-tight ${classes.title}`}>
                              {workflowActionLabel(step)}
                            </p>
                            <p className={`mt-1 m-0 text-xs leading-5 ${classes.meta}`}>
                              {summaryStatus}
                            </p>
                            {summaryMeta ? (
                              <p className={`mt-1 m-0 break-words text-xs leading-5 ${classes.meta}`}>
                                {summaryMeta}
                              </p>
                            ) : null}
                          </div>
                          <ExplorerArrow
                            chainKey={explorerChain}
                            txHash={explorerTxHash}
                          />
                        </div>

                        {isActive ? (
                          <IntentStatusCard
                            execution={activeExecution.execution}
                            status={activeExecution.status}
                            timeline={activeExecution.timeline}
                            error={activeExecution.error}
                            isSubmitting={activeExecution.isSubmitting}
                            isTracking={activeExecution.isTracking}
                            showHeader={false}
                            embedded
                            className="mt-3"
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
      </>

      <PoweredBy />
    </div>
  );
}
