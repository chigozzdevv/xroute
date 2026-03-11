"use client";

import { useEffect, useState } from "react";

type AssetAmount = {
  asset: string;
  amount: bigint;
};

export type QuoteSnapshot = {
  totalFee: AssetAmount;
  breakdown: readonly {
    label: string;
    fee: AssetAmount;
  }[];
};

type QuoteFooterProps = {
  quotes: readonly QuoteSnapshot[];
  windowSeconds?: number;
};

const ASSET_DECIMALS: Record<string, number> = {
  DOT: 10,
  USDT: 6,
  HDX: 12,
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

export function QuoteFooter({
  quotes,
  windowSeconds = 18,
}: QuoteFooterProps) {
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(windowSeconds);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          setQuoteIndex((index) => (index + 1) % quotes.length);
          return windowSeconds;
        }

        return current - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [quotes.length, windowSeconds]);

  const activeQuote = quotes[quoteIndex] ?? quotes[0];

  return (
    <div className="rounded-[18px] border border-line bg-white/62 px-4 py-3.5 sm:px-5">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 rounded-2xl bg-transparent px-0 py-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
      >
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
            Total fee
          </p>
          <p className="mt-1 text-lg font-extrabold tracking-[-0.04em] text-ink">
            {formatAssetAmount(activeQuote.totalFee)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[0.68rem] font-medium uppercase tracking-[0.12em] text-muted">
            refresh {secondsLeft}s
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 12 8"
            className={`h-3 w-3 shrink-0 text-muted transition-transform duration-150 ${
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
        </div>
      </button>

      {isOpen ? (
        <div className="mt-3 space-y-2 border-t border-line/70 pt-3 text-sm">
          {activeQuote.breakdown.map((entry) => (
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
