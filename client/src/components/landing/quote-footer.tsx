"use client";

import { useEffect, useMemo, useState } from "react";

import {
  formatEstimatedTotalSpend,
  formatAssetAmount as formatSdkAssetAmount,
  type Quote,
  type QuoteAssetAmount,
  type QuoteSourceCosts,
  formatSourceCostAmount,
} from "@/lib/xroute";

type QuoteFooterProps = {
  quote: Quote | null;
  sourceCosts?: QuoteSourceCosts | null;
  lastUpdatedAtMs?: number | null;
  refreshMs?: number | null;
};

function formatAssetAmount({ asset, amount }: QuoteAssetAmount, compact = false) {
  const formatted = formatSdkAssetAmount(asset, amount);
  return `${compact ? compactDecimal(formatted) : formatted} ${asset}`;
}

export function QuoteFooter({
  quote,
  sourceCosts = null,
  lastUpdatedAtMs = null,
  refreshMs = null,
}: QuoteFooterProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!quote || !refreshMs || refreshMs <= 0) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [quote, refreshMs]);

  const refreshIn = useMemo(() => {
    if (!quote || !refreshMs || !lastUpdatedAtMs) {
      return null;
    }

    const elapsedSeconds = Math.floor((now * 1000 - lastUpdatedAtMs) / 1000);
    const refreshWindowSeconds = Math.max(Math.floor(refreshMs / 1000), 1);
    return Math.max(refreshWindowSeconds - Math.max(elapsedSeconds, 0), 0);
  }, [lastUpdatedAtMs, now, quote, refreshMs]);

  if (!quote) {
    return null;
  }

  const totalFee = quote.fees.totalFee;
  const xcmFee = quote.fees.xcmFee;
  const destinationFee = quote.fees.destinationFee;
  const platformFee = quote.fees.platformFee;
  const estimatedTotalSpend = formatEstimatedTotalSpend(sourceCosts);
  const summaryLabel = estimatedTotalSpend ? "Estimated total spend" : "Fees";
  const summaryValue = estimatedTotalSpend
    ? `${compactDecimal(formatSourceCostAmount(estimatedTotalSpend.value))} ${estimatedTotalSpend.value.asset}`
    : formatAssetAmount(totalFee, true);

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
            {summaryLabel}
          </p>
          <p className="mt-1 text-lg font-extrabold tracking-[-0.04em] text-ink">
            {summaryValue}
          </p>
          {refreshIn !== null ? (
            <p className="mt-1 text-[0.62rem] font-semibold tracking-[0.05em] text-muted/90">
              Requote in {formatCountdown(refreshIn)}
            </p>
          ) : null}
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
                {formatAssetAmount(entry.fee, true)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted">Source gas (est.)</span>
            <span className="font-bold tracking-[-0.02em] text-ink">
              {sourceCosts
                ? `${compactDecimal(
                    formatSourceCostAmount(sourceCosts.gasFee),
                  )} ${sourceCosts.gasFee.asset}`
                : "Connect source wallet"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function compactDecimal(value: string) {
  const [whole, fraction = ""] = value.split(".");
  if (!fraction) {
    return whole;
  }

  const precision = whole === "0" ? 6 : 4;
  const shortenedFraction = fraction.slice(0, precision).replace(/0+$/, "");
  return shortenedFraction ? `${whole}.${shortenedFraction}` : whole;
}

function formatCountdown(remainingSeconds: number) {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
