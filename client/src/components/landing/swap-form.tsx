"use client";

import { useState } from "react";

import {
  actionButtonClass,
  fieldClass,
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

const SWAP_QUOTES: readonly QuoteSnapshot[] = [
  {
    totalFee: { asset: "DOT", amount: BigInt("1250000000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("150000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("100000000") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("1000000000") } },
    ],
  },
  {
    totalFee: { asset: "DOT", amount: BigInt("1180000000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("140000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("90000000") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("950000000") } },
    ],
  },
  {
    totalFee: { asset: "DOT", amount: BigInt("1295000000") },
    breakdown: [
      { label: "XCM fee", fee: { asset: "DOT", amount: BigInt("155000000") } },
      { label: "Destination fee", fee: { asset: "DOT", amount: BigInt("110000000") } },
      { label: "Platform fee", fee: { asset: "DOT", amount: BigInt("1030000000") } },
    ],
  },
];

const SWAP_STEPS = [
  "Validating route",
  "Locking quote",
  "Executing swap",
  "Settling asset",
] as const;

function createInitialSwapForm() {
  return {
    sourceChain: "Base",
    destinationChain: "Ethereum",
    sellAsset: "ETH",
    buyAsset: "USDC",
    sellAmount: "3.2",
    slippage: "0.50",
  };
}

export function SwapForm() {
  const [form, setForm] = useState(createInitialSwapForm);
  const journey = useJourneyProgress({ stepCount: SWAP_STEPS.length });

  return (
    <div className={formClass}>
      {journey.phase === "idle" ? (
        <>
          <div className={gridClass}>
            <label className={fieldClass}>
              <span className={labelClass}>Source chain</span>
              <Select
                value={form.sourceChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    sourceChain: event.target.value,
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
              <span className={labelClass}>Destination chain</span>
              <Select
                value={form.destinationChain}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    destinationChain: event.target.value,
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
              <span className={labelClass}>Sell asset</span>
              <Select
                value={form.sellAsset}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    sellAsset: event.target.value,
                  }))
                }
              >
                <option>ETH</option>
                <option>USDC</option>
                <option>WETH</option>
                <option>DOT</option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Buy asset</span>
              <Select
                value={form.buyAsset}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    buyAsset: event.target.value,
                  }))
                }
              >
                <option>USDC</option>
                <option>ETH</option>
                <option>DAI</option>
                <option>DOT</option>
              </Select>
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Sell amount</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.sellAmount}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    sellAmount: event.target.value,
                  }))
                }
              />
            </label>

            <label className={fieldClass}>
              <span className={labelClass}>Max slippage (%)</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={form.slippage}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    slippage: event.target.value,
                  }))
                }
              />
            </label>
          </div>

          <QuoteFooter quotes={SWAP_QUOTES} />

          <div className="flex justify-center">
            <button type="button" className={actionButtonClass} onClick={journey.startJourney}>
              Swap
            </button>
          </div>
        </>
      ) : (
        <JourneyStatus
          actionLabel="Swap"
          activeStep={journey.activeStep}
          phase={journey.phase}
          steps={SWAP_STEPS}
        />
      )}

      {journey.phase === "success" ? (
        <div className="flex justify-center">
          <button
            type="button"
            className={actionButtonClass}
            onClick={() => {
              setForm(createInitialSwapForm());
              journey.resetJourney();
            }}
          >
            Swap again
          </button>
        </div>
      ) : null}

      <PoweredBy />
    </div>
  );
}
