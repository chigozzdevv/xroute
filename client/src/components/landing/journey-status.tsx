"use client";

import type { JourneyPhase } from "./use-journey-progress";

type JourneyStatusProps = {
  actionLabel: string;
  activeStep: number;
  phase: JourneyPhase;
  steps: readonly string[];
};

export function JourneyStatus({
  actionLabel,
  activeStep,
  phase,
  steps,
}: JourneyStatusProps) {
  const title = phase === "success" ? `${actionLabel} successful` : `${actionLabel} in progress`;
  const summary = phase === "success" ? null : `Step ${Math.max(activeStep + 1, 1)} of ${steps.length}`;

  return (
    <div className="rounded-[20px] border border-line bg-white/68 px-4 py-4 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight text-ink">{title}</p>
          {summary ? (
            <p className="mt-1 text-xs uppercase tracking-[0.12em] text-muted">{summary}</p>
          ) : null}
        </div>

        <span
          className={`inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[0.68rem] font-semibold uppercase tracking-[0.12em] ${
            phase === "success"
              ? "bg-teal/12 text-teal"
              : "bg-orange/12 text-orange"
          }`}
        >
          {phase === "success" ? "done" : "live"}
        </span>
      </div>

      <div className="mt-5">
        {steps.map((step, index) => {
          const state =
            phase === "success"
              ? "done"
              : index < activeStep
                ? "done"
                : index === activeStep
                  ? "active"
                  : "pending";

          return (
            <div
              key={step}
              className="grid grid-cols-[2rem_1fr] gap-3"
            >
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition ${
                    state === "done"
                      ? "border-teal bg-teal text-white shadow-[0_8px_18px_rgba(13,122,115,0.18)]"
                      : state === "active"
                        ? "border-orange bg-white text-orange shadow-[0_0_0_4px_rgba(201,116,62,0.12)]"
                        : "border-line bg-white text-transparent"
                  }`}
                >
                  {state === "done" ? (
                    <svg aria-hidden="true" viewBox="0 0 12 10" className="h-3 w-3" fill="none">
                      <path
                        d="M1.5 5L4.5 8L10.5 1.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        state === "active" ? "bg-orange" : "bg-line"
                      }`}
                    />
                  )}
                </span>

                {index < steps.length - 1 ? (
                  <span
                    className={`mt-2 h-10 w-px rounded-full transition ${
                      state === "done" ? "bg-teal/60" : "bg-line"
                    }`}
                  />
                ) : null}
              </div>

              <div className={`pb-6 ${index === steps.length - 1 ? "pb-0" : ""}`}>
                <p
                  className={`text-sm ${
                    state === "pending" ? "text-muted" : "font-medium text-ink"
                  }`}
                >
                  {step}
                </p>
                <p className="mt-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
                  {state === "done" ? "Completed" : state === "active" ? "In progress" : "Queued"}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
