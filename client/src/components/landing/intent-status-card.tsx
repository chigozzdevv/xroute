"use client";

import { truncateAddress } from "@/lib/format";
import type {
  IntentExecutionResult,
  IntentStatus,
  IntentTimeline,
} from "@/lib/xroute";
import { TxHashLink } from "./tx-hash-link";

type IntentStatusCardProps = {
  execution: IntentExecutionResult | null;
  status: IntentStatus | null;
  timeline: IntentTimeline;
  error: string | null;
  isSubmitting: boolean;
  isTracking: boolean;
  idleTitle?: string | null;
  idleMessage?: string | null;
};

function formatTimelineAt(at: unknown) {
  if (typeof at !== "number") {
    return null;
  }

  return new Date(at * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function IntentStatusCard({
  execution,
  status,
  timeline,
  error,
  isSubmitting,
  isTracking,
  idleTitle = null,
  idleMessage = null,
}: IntentStatusCardProps) {
  const intentId = execution?.submitted?.intentId ?? status?.intentId ?? null;
  const sourceChain = execution?.intent?.sourceChain ?? execution?.dispatched?.sourceChain ?? null;
  const submittedTxHash = execution?.submitted?.txHash ?? null;
  const dispatchTxHash = execution?.dispatched?.txHash ?? null;

  if (!execution && !status && !error && !isSubmitting && !idleMessage) {
    return null;
  }

  return (
    <div className="grid gap-3 rounded-[18px] border border-line bg-white/62 px-4 py-3.5 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
            Intent status
          </p>
          <p className="mt-1 text-lg font-extrabold tracking-[-0.04em] text-ink">
            {isSubmitting
              ? "Submitting..."
              : status?.status
                ? status.status
                : error
                  ? "Error"
                  : idleTitle ?? idleMessage ?? "Ready"}
          </p>
        </div>
        {isTracking ? (
          <span className="rounded-full bg-teal/10 px-3 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-teal">
            Tracking
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="m-0 text-sm leading-6 text-danger">{error}</p>
      ) : null}

      {!error && !execution && idleMessage ? (
        <p className="m-0 text-sm leading-6 text-muted">{idleMessage}</p>
      ) : null}

      {intentId ? (
        <div className="grid gap-1 text-sm">
          <span className="text-muted">Intent ID</span>
          <code className="break-all rounded-[14px] bg-surface px-3 py-2 text-[0.8rem] text-ink">
            {intentId}
          </code>
        </div>
      ) : null}

      {sourceChain && submittedTxHash ? (
        <TxHashLink
          chainKey={sourceChain}
          txHash={submittedTxHash}
          label="Submit tx"
        />
      ) : null}

      {sourceChain && dispatchTxHash && dispatchTxHash !== submittedTxHash ? (
        <TxHashLink
          chainKey={sourceChain}
          txHash={dispatchTxHash}
          label="Dispatch tx"
        />
      ) : null}

      {execution?.dispatched?.relayerJob?.id ? (
        <p className="m-0 text-sm leading-6 text-muted">
          Relayer job: {truncateAddress(execution.dispatched.relayerJob.id, 10, 6)}
        </p>
      ) : null}

      {timeline.length > 0 ? (
        <div className="grid gap-2 border-t border-line/70 pt-3">
          {timeline.map((entry: IntentTimeline[number], index: number) => (
            <div
              key={`${entry.type}-${entry.at}-${index}`}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <span className="font-semibold capitalize tracking-tight text-ink">
                {String(entry.type).replace(/-/g, " ")}
              </span>
              <span className="text-muted">{formatTimelineAt(entry.at) ?? "Pending"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
