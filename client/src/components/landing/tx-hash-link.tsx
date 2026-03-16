"use client";

import { truncateAddress } from "@/lib/format";
import { getTransactionExplorerUrl, type ChainKey } from "@/lib/xroute";

type TxHashLinkProps = {
  chainKey: ChainKey;
  txHash: string;
  label: string;
  compact?: boolean;
};

export function TxHashLink({
  chainKey,
  txHash,
  label,
  compact = false,
}: TxHashLinkProps) {
  const href = getTransactionExplorerUrl(chainKey, txHash);
  const text = truncateAddress(txHash, compact ? 8 : 12, compact ? 6 : 8);

  return (
    <div className="grid gap-1 text-sm">
      <span className="text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-[14px] bg-surface px-3 py-2 text-[0.8rem] text-ink">
          {text}
        </code>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-white text-ink transition duration-150 hover:-translate-y-px hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            aria-label={`Open ${label.toLowerCase()} in explorer`}
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
  );
}
