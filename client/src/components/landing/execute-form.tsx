"use client";

import { useState } from "react";

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
import { JourneyStatus } from "./journey-status";
import { PoweredBy } from "./powered-by";
import { QuoteFooter, type QuoteSnapshot } from "./quote-footer";
import { useJourneyProgress } from "./use-journey-progress";
import { Select } from "@/components/ui/select";

const EXECUTE_QUOTES: readonly QuoteSnapshot[] = [
  {
    totalFee: { asset: "DOT", amount: BigInt("260180000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("260000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("0") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("180000") } },
    ],
  },
  {
    totalFee: { asset: "DOT", amount: BigInt("262180000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("262000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("0") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("180000") } },
    ],
  },
  {
    totalFee: { asset: "DOT", amount: BigInt("258180000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("258000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("0") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("180000") } },
    ],
  },
];

const EXECUTE_STEPS = [
  "Preparing execution",
  "Submitting intent",
  "Executing call",
  "Confirming result",
] as const;

function createInitialExecuteForm() {
  return {
    chain: "Moonbeam",
    target: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    method: "settleIntent(bytes)",
    value: "0",
    payload:
      "0x7ab300000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  };
}

export function ExecuteForm() {
  const [form, setForm] = useState(createInitialExecuteForm);
  const journey = useJourneyProgress({ stepCount: EXECUTE_STEPS.length });

  return (
    <div className={formClass}>
      {journey.phase === "idle" ? (
        <>
          <div className={gridClass}>
            <label className={fieldClass}>
              <span className={labelClass}>Execution chain</span>
              <Select
                value={form.chain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    chain: event.target.value,
                  }))
                }
              >
                <option>Moonbeam</option>
                <option>Ethereum</option>
                <option>Base</option>
                <option>Arbitrum</option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Native value</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.value}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    value: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>Target contract</span>
              <input
                className={inputClass}
                value={form.target}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    target: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>Function</span>
              <input
                className={inputClass}
                value={form.method}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    method: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldFullClass}>
              <span className={labelClass}>Payload or calldata</span>
              <textarea
                className={textareaClass}
                rows={3}
                value={form.payload}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    payload: event.target.value,
                  }))
                }
              />
            </label>
          </div>

          <QuoteFooter quotes={EXECUTE_QUOTES} />

          <div className="flex justify-center">
            <button type="button" className={actionButtonClass} onClick={journey.startJourney}>
              Execute
            </button>
          </div>
        </>
      ) : (
        <JourneyStatus
          actionLabel="Execution"
          activeStep={journey.activeStep}
          phase={journey.phase}
          steps={EXECUTE_STEPS}
        />
      )}

      {journey.phase === "success" ? (
        <div className="flex justify-center">
          <button
            type="button"
            className={actionButtonClass}
            onClick={() => {
              setForm(createInitialExecuteForm());
              journey.resetJourney();
            }}
          >
            Execute again
          </button>
        </div>
      ) : null}

      <PoweredBy />
    </div>
  );
}
