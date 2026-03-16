"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  connectInjectedWallet,
  getBrowserWalletAvailability,
} from "@xroute/sdk";

export type WalletKind = "evm" | "substrate";

export type WalletSession =
  | {
      kind: "evm";
      account: string;
      provider: EthereumProvider;
    }
  | {
      kind: "substrate";
      account: string;
      extensionName: string;
      extensionSource: InjectedSubstrateExtensionSource;
      accountLabel: string | null;
    };

export type WalletSessions = Partial<Record<WalletKind, WalletSession>>;

type WalletState = {
  sessions: WalletSessions;
  isConnecting: boolean;
  error: string | null;
  availableWallets: {
    evm: boolean;
    substrate: boolean;
  };
};

const DAPP_NAME = "xroute";
const listeners = new Set<() => void>();

let state: WalletState = {
  sessions: {},
  isConnecting: false,
  error: null,
  availableWallets: {
    evm: false,
    substrate: false,
  },
};

let boundEvmProvider: EthereumProvider | null = null;
let boundAccountsListener: ((...args: unknown[]) => void) | null = null;
let initialized = false;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(partial: Partial<WalletState>) {
  state = {
    ...state,
    ...partial,
  };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function resolveAvailableWallets() {
  return getBrowserWalletAvailability();
}

function syncAvailableWallets() {
  setState({
    availableWallets: resolveAvailableWallets(),
  });
}

function bindEvmProvider(provider: EthereumProvider) {
  if (boundEvmProvider === provider && boundAccountsListener) {
    return;
  }

  if (boundEvmProvider && boundAccountsListener) {
    boundEvmProvider.removeListener?.("accountsChanged", boundAccountsListener);
  }

  boundAccountsListener = (...args: unknown[]) => {
    const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
    const nextAccount = accounts[0] ?? null;

    if (!nextAccount) {
      const sessions = { ...state.sessions };
      delete sessions.evm;
      setState({
        sessions,
        error: null,
      });
      return;
    }

    setState({
      sessions: {
        ...state.sessions,
        evm: {
          kind: "evm",
          account: nextAccount,
          provider,
        },
      },
      error: null,
    });
  };

  provider.on?.("accountsChanged", boundAccountsListener);
  boundEvmProvider = provider;
}

async function connectEvmWallet() {
  setState({
    isConnecting: true,
    error: null,
  });

  try {
    const session = await connectInjectedWallet("evm");
    if (session.kind !== "evm") {
      throw new Error("Expected an EVM wallet session.");
    }
    bindEvmProvider(session.provider);
    setState({
      sessions: {
        ...state.sessions,
        evm: session,
      },
      error: null,
    });
  } finally {
    setState({
      isConnecting: false,
    });
  }
}

async function connectSubstrateWallet() {
  setState({
    isConnecting: true,
    error: null,
  });

  try {
    const session = await connectInjectedWallet("substrate", {
      extensionDappName: DAPP_NAME,
    });
    if (session.kind !== "substrate") {
      throw new Error("Expected a Substrate wallet session.");
    }
    setState({
      sessions: {
        ...state.sessions,
        substrate: session,
      },
      error: null,
    });
  } finally {
    setState({
      isConnecting: false,
    });
  }
}

async function connect(kind: WalletKind) {
  try {
    if (kind === "evm") {
      await connectEvmWallet();
      return;
    }

    await connectSubstrateWallet();
  } catch (error) {
    setState({
      error: error instanceof Error ? error.message : "Wallet connection failed.",
    });
  }
}

function disconnect(kind: WalletKind | null = null) {
  if (kind) {
    const sessions = { ...state.sessions };
    delete sessions[kind];
    setState({
      sessions,
      error: null,
    });
    return;
  }

  setState({
    sessions: {},
    error: null,
  });
}

function initializeStore() {
  if (initialized || typeof window === "undefined") {
    return;
  }

  initialized = true;
  syncAvailableWallets();

  const handleWindowFocus = () => {
    syncAvailableWallets();
  };

  window.addEventListener("focus", handleWindowFocus);
}

export function useWallet() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const primarySession = snapshot.sessions.evm ?? snapshot.sessions.substrate ?? null;

  useEffect(() => {
    initializeStore();
  }, []);

  return {
    ...snapshot,
    session: primarySession,
    account: primarySession?.account ?? null,
    kind: primarySession?.kind ?? null,
    evmSession: snapshot.sessions.evm ?? null,
    substrateSession: snapshot.sessions.substrate ?? null,
    connect,
    connectEvm() {
      return connect("evm");
    },
    connectSubstrate() {
      return connect("substrate");
    },
    disconnect,
  };
}
