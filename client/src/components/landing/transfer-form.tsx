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
} from "./form-classes";
import { JourneyStatus } from "./journey-status";
import { PoweredBy } from "./powered-by";
import { QuoteFooter, type QuoteSnapshot } from "./quote-footer";
import { useJourneyProgress } from "./use-journey-progress";
import { Select } from "@/components/ui/select";

const TRANSFER_QUOTES: readonly QuoteSnapshot[] = [
  {
    totalFee: { asset: "DOT", amount: BigInt("780000000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("330000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("200000000") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("250000000") } },
    ],
  },
  {
    totalFee: { asset: "DOT", amount: BigInt("760000000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("320000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("190000000") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("250000000") } },
    ],
  },
  {
    totalFee: { asset: "DOT", amount: BigInt("800000000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("340000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("210000000") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("250000000") } },
    ],
  },
];

const TRANSFER_STEPS = [
  "Validating route",
  "Locking fee quote",
  "Submitting transfer",
  "Confirming receipt",
] as const;

function createInitialTransferForm() {
  return {
    fromChain: "Ethereum",
    toChain: "Base",
    asset: "USDC",
    amount: "1250",
    recipient: "0x2C4Bf3fbA41E34F7f88fD7c12a57F9E6A9B01472",
  };
}

export function TransferForm() {
  const [form, setForm] = useState(createInitialTransferForm);
  const journey = useJourneyProgress({ stepCount: TRANSFER_STEPS.length });

  return (
    <div className={formClass}>
      {journey.phase === "idle" ? (
        <>
          <div className={gridClass}>
            <label className={fieldClass}>
              <span className={labelClass}>From chain</span>
              <Select
                value={form.fromChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    fromChain: event.target.value,
                  }))
                }
              >
                <option>Ethereum</option>
                <option>Base</option>
                <option>Arbitrum</option>
                <option>Moonbeam</option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>To chain</span>
              <Select
                value={form.toChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    toChain: event.target.value,
                  }))
                }
              >
                <option>Base</option>
                <option>Ethereum</option>
                <option>Arbitrum</option>
                <option>Moonbeam</option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Asset</span>
              <Select
                value={form.asset}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    asset: event.target.value,
                  }))
                }
              >
                <option>USDC</option>
                <option>USDT</option>
                <option>WETH</option>
                <option>DOT</option>
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
              <span className={labelClass}>Recipient</span>
              <input
                className={inputClass}
                value={form.recipient}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    recipient: event.target.value,
                  }))
                }
              />
            </label>
          </div>

          <QuoteFooter quotes={TRANSFER_QUOTES} />

          <div className="flex justify-center">
            <button type="button" className={actionButtonClass} onClick={journey.startJourney}>
              Transfer
            </button>
          </div>
        </>
      ) : (
        <JourneyStatus
          actionLabel="Transfer"
          activeStep={journey.activeStep}
          phase={journey.phase}
          steps={TRANSFER_STEPS}
        />
      )}

      {journey.phase === "success" ? (
        <div className="flex justify-center">
          <button
            type="button"
            className={actionButtonClass}
            onClick={() => {
              setForm(createInitialTransferForm());
              journey.resetJourney();
            }}
          >
            Transfer again
          </button>
        </div>
      ) : null}

      <PoweredBy />
    </div>
  );
}
