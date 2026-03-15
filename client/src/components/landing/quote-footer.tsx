"use client";

import { useState } from "react";

import {
  formatAssetAmount as formatSdkAssetAmount,
  type Quote,
  type QuoteAssetAmount,
} from "@/lib/xroute";

type QuoteFooterProps = {
  quote: Quote | null;
};

function formatAssetAmount({ asset, amount }: QuoteAssetAmount) {
  return `${formatSdkAssetAmount(asset, amount)} ${asset}`;
}

export function QuoteFooter({ quote }: QuoteFooterProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  if (!quote) {
    return null;
  }

  const totalFee = quote.fees.totalFee;
  const xcmFee = quote.fees.xcmFee;
  const destinationFee = quote.fees.destinationFee;
  const platformFee = quote.fees.platformFee;

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
