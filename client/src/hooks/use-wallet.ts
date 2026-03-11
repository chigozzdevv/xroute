"use client";

import { useEffect, useState } from "react";

const DISCONNECTED_KEY = "xroute.wallet.disconnected";

function shouldSyncProvider() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(DISCONNECTED_KEY) !== "true";
}

export function useWallet() {
  const [account, setAccount] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum || !shouldSyncProvider()) {
      return;
    }

    let cancelled = false;

    window.ethereum
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (!cancelled && shouldSyncProvider()) {
          const nextAccounts = accounts as string[];

          setAccount(nextAccounts[0] ?? null);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAccount(null);
        }
      });

    const handleAccountsChanged = (...args: unknown[]) => {
      if (shouldSyncProvider()) {
        const nextAccounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];

        setAccount(nextAccounts[0] ?? null);
        setError(null);
      }
    };

    window.ethereum.on?.("accountsChanged", handleAccountsChanged);

    return () => {
      cancelled = true;
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
    };
  }, []);

  async function connect() {
    if (typeof window === "undefined" || !window.ethereum) {
      setError("Install an injected EVM wallet to connect.");
      return;
    }

    try {
      setIsConnecting(true);
      setError(null);
      window.localStorage.removeItem(DISCONNECTED_KEY);

      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      const nextAccounts = accounts as string[];

      setAccount(nextAccounts[0] ?? null);
      setError(null);
    } catch (walletError) {
      const message =
        walletError instanceof Error
          ? walletError.message
          : "Wallet connection was cancelled.";

      setError(message);
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnect() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DISCONNECTED_KEY, "true");
    }

    setAccount(null);
    setError(null);
  }

  return {
    account,
    connect,
    disconnect,
    error,
    isConnecting,
  };
}
