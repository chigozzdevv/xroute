"use client";

import { useEffect, useRef, useState } from "react";

import { truncateAddress } from "@/lib/format";
import { useWallet } from "@/hooks/use-wallet";
import { cn } from "@/lib/cn";
import { disconnectXRouteWallet } from "@/lib/xroute";

export function WalletMenu() {
  const {
    account,
    availableWallets,
    connectEvm,
    connectSubstrate,
    disconnect,
    error,
    isConnecting,
    sessions,
  } = useWallet();
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleDocumentClick(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node | null)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleDocumentClick);

    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
    };
  }, []);

  function handleTriggerClick() {
    setIsOpen((current) => !current);
  }

  async function handleConnectEvm() {
    await connectEvm();
    setIsOpen(false);
  }

  async function handleConnectSubstrate() {
    await connectSubstrate();
    setIsOpen(false);
  }

  function handleDisconnect() {
    disconnect();
    disconnectXRouteWallet();
    setIsOpen(false);
  }

  const connectedSessions = Object.values(sessions);
  const walletLabel = connectedSessions.length > 1
    ? `${connectedSessions.length} wallets connected`
    : account
      ? truncateAddress(account)
      : isConnecting
        ? "Connecting..."
        : "Connect Wallet";

  return (
    <div className="relative grid justify-items-stretch gap-2 sm:justify-items-end" ref={wrapperRef}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-2 bg-transparent px-0 py-1 text-[1rem] font-extrabold tracking-[-0.02em] text-ink transition duration-150 hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-wait disabled:text-muted",
          !account && "font-bold text-muted",
        )}
        onClick={handleTriggerClick}
        disabled={isConnecting}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <span className="font-extrabold tracking-[-0.02em]">{walletLabel}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 8"
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            isOpen && "rotate-180",
          )}
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

      {isOpen ? (
        <div
          className="w-full min-w-[220px] rounded-[24px] border border-line bg-surface-strong p-3 shadow-panel backdrop-blur-xl sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-[240px]"
          role="menu"
        >
          {connectedSessions.length > 0 ? (
            <>
              <p className="mb-1 text-[0.72rem] uppercase tracking-[0.12em] text-muted">
                Connected wallets
              </p>
              <div className="mb-3.5 grid gap-2">
                {connectedSessions.map((session) => (
                  <div key={session.kind} className="grid gap-0.5">
                    <span className="text-[0.72rem] uppercase tracking-[0.12em] text-muted">
                      {session.kind === "substrate" ? "Substrate" : "EVM"}
                    </span>
                    <span className="font-extrabold tracking-[-0.03em]">
                      {truncateAddress(session.account, 8, 6)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="mb-3 text-[0.72rem] uppercase tracking-[0.12em] text-muted">
              Choose a wallet
            </p>
          )}

          <div className="grid gap-2">
            {availableWallets.evm ? (
              <button
                type="button"
                className="w-full rounded-2xl bg-teal/8 px-4 py-3 text-left font-bold transition duration-150 hover:bg-teal/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                onClick={handleConnectEvm}
                role="menuitem"
              >
                {sessions.evm ? "Reconnect EVM" : "Connect EVM"}
              </button>
            ) : null}

            {availableWallets.substrate ? (
              <button
                type="button"
                className="w-full rounded-2xl bg-orange/10 px-4 py-3 text-left font-bold transition duration-150 hover:bg-orange/16 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                onClick={handleConnectSubstrate}
                role="menuitem"
              >
                {sessions.substrate ? "Reconnect Substrate" : "Connect Substrate"}
              </button>
            ) : null}

            {connectedSessions.length > 0 ? (
              <button
                type="button"
                className="w-full rounded-2xl bg-white px-4 py-3 text-left font-bold transition duration-150 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/30 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                onClick={handleDisconnect}
                role="menuitem"
              >
                Disconnect all
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="m-0 max-w-[240px] text-left text-[0.8rem] leading-5 text-danger sm:text-right">
          {error}
        </p>
      ) : null}
    </div>
  );
}
