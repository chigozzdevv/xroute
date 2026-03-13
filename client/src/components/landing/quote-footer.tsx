"use client";

import { useState } from "react";

import type { QuoteResponse } from "@/lib/xroute/client";

type AssetAmount = {
  asset: string;
  amount: bigint;
};

type QuoteFooterProps = {
  quote: QuoteResponse["quote"] | null;
};

const ASSET_DECIMALS: Record<string, number> = {
  DOT: 10,
  USDT: 6,
  HDX: 12,
  VDOT: 10,
};

function formatAssetAmount({ asset, amount }: AssetAmount) {
  const decimals = ASSET_DECIMALS[asset] ?? 6;
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;

  if (fraction === BigInt(0)) {
    return `${whole.toString()} ${asset}`;
  }

  const paddedFraction = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");

  return `${whole.toString()}.${paddedFraction} ${asset}`;
}

function toAmount(input?: { asset: string; amount: string } | null): AssetAmount | null {
  if (!input?.asset || input.amount === undefined) {
    return null;
  }

  return {
    asset: input.asset,
    amount: BigInt(input.amount),
  };
}

export function QuoteFooter({ quote }: QuoteFooterProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  if (!quote) {
    return null;
  }

  const totalFee = toAmount(quote.fees.totalFee);
  const xcmFee = toAmount(quote.fees.xcmFee);
  const destinationFee = toAmount(quote.fees.destinationFee);
  const platformFee = toAmount(quote.fees.platformFee);

  if (!totalFee || !xcmFee || !destinationFee || !platformFee) {
    return null;
  }

  const breakdown = [
    { label: "XCM fee", fee: xcmFee },
    { label: "Destination fee", fee: destinationFee },
    { label: "Platform fee", fee: platformFee },
  ];

  return (
    <div className="rounded-[18px] border border-line bg-white/62 px-4 py-3.5 sm:px-5">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 text-left"
        onClick={() => setShowBreakdown((current) => !current)}
        aria-expanded={showBreakdown}
      >
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
            Total fee
          </p>
          <p className="mt-1 text-lg font-extrabold tracking-[-0.04em] text-ink">
            {formatAssetAmount(totalFee)}
          </p>
        </div>

        <svg
          aria-hidden="true"
          viewBox="0 0 12 8"
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-150 ${
            showBreakdown ? "rotate-180" : ""
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

      {showBreakdown ? (
        <div className="mt-3 space-y-2 border-t border-line/70 pt-3 text-sm">
          {breakdown.map((entry) => (
            <div
              key={`${entry.label}-${entry.fee.asset}-${entry.fee.amount.toString()}`}
              className="flex items-center justify-between gap-4"
            >
              <span className="text-muted">{entry.label}</span>
              <span className="font-bold tracking-[-0.02em] text-ink">
                {formatAssetAmount(entry.fee)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
