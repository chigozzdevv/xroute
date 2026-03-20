"use client";

import type {
  ChainKey,
  IntentExecutionResult,
  IntentStatus,
  IntentTimeline,
  QuoteIntent,
} from "@/lib/xroute";
import { getTransactionExplorerUrl } from "@/lib/xroute";

type IntentStatusCardProps = {
  execution: IntentExecutionResult | null;
  status: IntentStatus | null;
  timeline: IntentTimeline;
  error: string | null;
  isSubmitting: boolean;
  isTracking: boolean;
  idleTitle?: string | null;
  idleMessage?: string | null;
  showHeader?: boolean;
  showIntentId?: boolean;
  embedded?: boolean;
  className?: string;
};

type JourneyStepStatus = "completed" | "active" | "pending" | "failed";

type JourneyStep = {
  key: string;
  title: string;
  status: JourneyStepStatus;
  meta?: string | null;
  chainKey?: ChainKey | null;
  txHash?: string | null;
};

function formatStatusLabel(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getActionTitle(
  actionType: QuoteIntent["actionType"] | undefined,
  executionType: string | null,
) {
  if (actionType === "swap") {
    return "Swap";
  }

  if (actionType === "execute") {
    return executionType === "call" ? "Execute" : formatStatusLabel(executionType) ?? "Execute";
  }

  return "Deliver";
}

function getEventEntry(timeline: IntentTimeline, type: string) {
  return timeline.find((entry: IntentTimeline[number]) => entry.type === type) ?? null;
}

function getCurrentExecutionType(execution: IntentExecutionResult | null) {
  if (!execution || !("intent" in execution)) {
    return null;
  }

  const intent = execution.intent as Record<string, unknown>;
  return typeof intent.executionType === "string" ? intent.executionType : null;
}

function getJourneySteps({
  execution,
  status,
  timeline,
  error,
  isSubmitting,
}: Pick<
  IntentStatusCardProps,
  "execution" | "status" | "timeline" | "error" | "isSubmitting"
>): JourneyStep[] {
  const sourceChain =
    execution?.intent?.sourceChain
    ?? execution?.dispatched?.sourceChain
    ?? status?.sourceChain
    ?? null;
  const destinationChain =
    execution?.intent?.destinationChain
    ?? status?.destinationChain
    ?? null;
  const executionType = getCurrentExecutionType(execution);
  const actionType = execution?.intent?.actionType ?? status?.actionType ?? undefined;
  const submittedTxHash = execution?.submitted?.txHash ?? null;
  const dispatchTxHash = execution?.dispatched?.txHash ?? null;
  const destinationTxHash = status?.result?.destinationTxHash ?? null;
  const relayerStatus = execution?.dispatched?.relayerJob?.status ?? null;
  const relayerError = execution?.dispatched?.relayerJob?.lastError ?? null;
  const failureReason = status?.failureReason ?? relayerError ?? error ?? null;
  const currentStatus = status?.status ?? null;

  const submittedEvent = getEventEntry(timeline, "intent-submitted");
  const dispatchedEvent = getEventEntry(timeline, "intent-dispatched");
  const executionStartedEvent = getEventEntry(timeline, "destination-execution-started");
  const executionSucceededEvent = getEventEntry(timeline, "destination-execution-succeeded");
  const executionFailedEvent = getEventEntry(timeline, "destination-execution-failed");
  const refundEvent = getEventEntry(timeline, "refund-issued");
  const cancelledEvent = getEventEntry(timeline, "intent-cancelled");

  const hasSubmitted = Boolean(execution?.submitted?.intentId || submittedEvent);
  const hasDispatched = Boolean(dispatchTxHash || dispatchedEvent);
  const hasExecutionStarted = Boolean(executionStartedEvent);
  const hasExecutionSucceeded = Boolean(executionSucceededEvent || currentStatus === "settled");
  const hasExecutionFailed = Boolean(executionFailedEvent || currentStatus === "failed");
  const isRefunded = Boolean(refundEvent || currentStatus === "refunded");
  const isCancelled = Boolean(cancelledEvent || currentStatus === "cancelled");

  return [
    {
      key: "submit",
      title: "Submit",
      status:
        isSubmitting
          ? "active"
          : hasSubmitted
            ? "completed"
            : "pending",
      meta: isSubmitting ? "Waiting for wallet" : null,
      chainKey: sourceChain,
      txHash: submittedTxHash,
    },
    {
      key: "dispatch",
      title: "Dispatch",
      status:
        relayerStatus === "failed"
          ? "failed"
          : hasDispatched
            ? "completed"
            : hasSubmitted
              ? "active"
              : "pending",
      meta:
        relayerStatus === "failed"
          ? relayerError
          : hasDispatched
            ? null
            : relayerStatus
              ? formatStatusLabel(relayerStatus)
              : hasSubmitted
                ? "Queued"
                : null,
      chainKey: sourceChain,
      txHash: dispatchTxHash && dispatchTxHash !== submittedTxHash ? dispatchTxHash : null,
    },
    {
      key: "destination",
      title: getActionTitle(actionType, executionType),
      status:
        hasExecutionFailed
          ? "failed"
          : hasExecutionSucceeded
            ? "completed"
            : hasExecutionStarted || currentStatus === "executing"
              ? "active"
              : hasDispatched
                ? "active"
                : "pending",
      meta:
        hasExecutionFailed
          ? failureReason
          : hasDispatched && !hasExecutionSucceeded
            ? "Processing"
            : null,
      chainKey: destinationChain,
      txHash: destinationTxHash,
    },
    {
      key: "final",
      title:
        isRefunded
          ? "Refunded"
          : isCancelled
            ? "Cancelled"
            : "Complete",
      status:
        currentStatus === "settled"
          ? "completed"
          : isRefunded || isCancelled
            ? "completed"
            : currentStatus === "failed"
              ? "active"
              : "pending",
      meta: currentStatus === "failed" ? "Waiting" : null,
    },
  ];
}

function explorerHref(chainKey: ChainKey | null | undefined, txHash: string | null | undefined) {
  if (!chainKey || !txHash) {
    return null;
  }

  return getTransactionExplorerUrl(chainKey, txHash);
}

function statusClasses(status: JourneyStepStatus) {
  switch (status) {
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
        line: "bg-teal/22",
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

function StepMarker({ status }: { status: JourneyStepStatus }) {
  const styles = statusClasses(status);

  return (
    <span
      className={`relative z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border text-[0.7rem] font-semibold ${styles.dot}`}
    >
      {status === "completed" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
          <path
            d="M3.5 8.5L6.5 11.5L12.5 4.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : status === "failed" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
          <path
            d="M5 5L11 11M11 5L5 11"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : status === "active" ? (
        <span className="h-2.5 w-2.5 rounded-full bg-teal" />
      ) : (
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
      )}
    </span>
  );
}

function JourneyStepRow({
  step,
  isLast,
}: {
  step: JourneyStep;
  isLast: boolean;
}) {
  const styles = statusClasses(step.status);
  const href = explorerHref(step.chainKey, step.txHash);

  return (
    <div className="flex items-start gap-4">
      <div className="relative flex w-6 shrink-0 justify-center">
        <StepMarker status={step.status} />
        {!isLast ? (
          <span className={`absolute left-1/2 top-6 bottom-[-1.1rem] w-px -translate-x-1/2 ${styles.line}`} />
        ) : null}
      </div>
      <div className={`min-w-0 flex-1 ${styles.row}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`m-0 text-sm font-semibold tracking-tight ${styles.title}`}>
              {step.title}
            </p>
            {step.meta ? (
              <p className={`mt-1 m-0 break-words text-xs leading-5 ${styles.meta}`}>
                {step.meta}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink transition duration-150 hover:-translate-y-px hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                aria-label={`Open ${step.title.toLowerCase()} in explorer`}
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
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function IntentStatusCard({
  execution,
  status,
  timeline,
  error,
  isSubmitting,
  isTracking,
  idleMessage = null,
  showHeader = true,
  showIntentId = true,
  embedded = false,
  className = "",
}: IntentStatusCardProps) {
  const intentId = execution?.submitted?.intentId ?? status?.intentId ?? null;
  const steps = getJourneySteps({
    execution,
    status,
    timeline,
    error,
    isSubmitting,
  });
  const hasInlineFailure = steps.some((step) => step.status === "failed" && step.meta);

  if (!execution && !status && !error && !isSubmitting && !idleMessage) {
    return null;
  }

  const containerClass = embedded
    ? `grid gap-3 ${className}`.trim()
    : `grid gap-3 rounded-[18px] border border-line bg-white/62 px-4 py-3.5 sm:px-5 ${className}`.trim();

  return (
    <div className={containerClass}>
      {showHeader ? (
        <div className="flex items-start justify-between gap-4">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
            Progress
          </p>
          {isTracking ? (
            <span className="rounded-full bg-teal/10 px-3 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-teal">
              Tracking
            </span>
          ) : null}
        </div>
      ) : null}

      {error && !hasInlineFailure ? (
        <p className="m-0 break-words text-sm leading-6 text-danger">{error}</p>
      ) : null}

      {!error && !execution && idleMessage ? (
        <p className="m-0 text-sm leading-6 text-muted">{idleMessage}</p>
      ) : null}

      {showIntentId && intentId ? (
        <div className="grid gap-1 text-sm">
          <span className="text-muted">Intent ID</span>
          <code className="break-all rounded-[14px] bg-surface px-3 py-2 text-[0.8rem] text-ink">
            {intentId}
          </code>
        </div>
      ) : null}

      <div className="grid gap-3 border-t border-line/70 pt-3">
        {steps.map((step, index) => (
          <JourneyStepRow
            key={step.key}
            step={step}
            isLast={index === steps.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
