"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  connectInjectedWallet,
  getBrowserWalletAvailability,
  listInjectedEvmProviders,
  listInjectedSubstrateExtensions,
} from "@xcm-router/sdk";
import {
  chainKeysForWalletKind,
  connectXRouteWallet,
  disconnectXRouteWalletChain,
} from "@/lib/xroute";

export type WalletKind = "evm" | "substrate";

export type AvailableEvmWallet = {
  id: string;
  label: string;
};

export type AvailableSubstrateWallet = {
  id: string;
  label: string;
};

export type WalletSession =
  | {
      kind: "evm";
      account: string;
      provider: EthereumProvider;
      providerId: string;
      providerLabel: string;
    }
  | {
      kind: "substrate";
      account: string;
      extensionName: string;
      extensionLabel: string;
      extensionSource: InjectedSubstrateExtensionSource;
      accountLabel: string | null;
    };

export type WalletSessions = Partial<Record<WalletKind, WalletSession>>;

type WalletState = {
  sessions: WalletSessions;
  isConnecting: boolean;
  isRestoring: boolean;
  error: string | null;
  availableWallets: {
    evm: AvailableEvmWallet[];
    substrate: AvailableSubstrateWallet[];
  };
};

const DAPP_NAME = "xroute";
const WALLET_PREFERENCES_STORAGE_KEY = "xroute.wallet.preferences.v1";
const listeners = new Set<() => void>();

let state: WalletState = {
  sessions: {},
  isConnecting: false,
  isRestoring: false,
  error: null,
  availableWallets: {
    evm: [],
    substrate: [],
  },
};

let boundEvmProvider: EthereumProvider | null = null;
let boundAccountsListener: ((...args: unknown[]) => void) | null = null;
let boundEvmProviderInfo: AvailableEvmWallet | null = null;
let initialized = false;
let restoreRunId = 0;
let connectRunId = 0;

type PersistedWalletPreferences = {
  evm?: {
    enabled: true;
    providerId?: string;
  };
  substrate?: {
    extensionName: string;
    accountAddress: string;
  };
};

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
  if (partial.sessions !== undefined) {
    persistWalletPreferences(state.sessions);
  }
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
  const browserAvailability = getBrowserWalletAvailability();
  return {
    evm: listInjectedEvmProviders().map(({ id, label }) => ({ id, label })),
    substrate:
      browserAvailability.substrate
        ? listInjectedSubstrateExtensions().map(({ id, label }) => ({ id, label }))
        : [],
  };
}

function syncAvailableWallets() {
  setState({
    availableWallets: resolveAvailableWallets(),
  });
}

function bindEvmProvider(provider: EthereumProvider, providerInfo: AvailableEvmWallet) {
  if (boundEvmProvider === provider && boundAccountsListener) {
    boundEvmProviderInfo = providerInfo;
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

    const activeProviderInfo = boundEvmProviderInfo ?? providerInfo;
    setState({
      sessions: {
        ...state.sessions,
        evm: {
          kind: "evm",
          account: nextAccount,
          provider,
          providerId: activeProviderInfo.id,
          providerLabel: activeProviderInfo.label,
        },
      },
      error: null,
    });
  };

  provider.on?.("accountsChanged", boundAccountsListener);
  boundEvmProvider = provider;
  boundEvmProviderInfo = providerInfo;
}

async function connectEvmWallet(providerId: string | null = null) {
  const currentConnectRunId = ++connectRunId;
  setState({
    isConnecting: true,
    error: null,
  });

  try {
    const session = await connectInjectedWallet("evm", {
      providerId: providerId ?? undefined,
    });
    if (session.kind !== "evm") {
      throw new Error("Expected an EVM wallet session.");
    }
    bindEvmProvider(session.provider, {
      id: session.providerId,
      label: session.providerLabel,
    });
    setState({
      sessions: {
        ...state.sessions,
        evm: session,
      },
      error: null,
    });
  } finally {
    if (connectRunId === currentConnectRunId) {
      setState({
        isConnecting: false,
      });
    }
  }
}

async function connectSubstrateWallet(extensionName: string | null = null) {
  const currentConnectRunId = ++connectRunId;
  setState({
    isConnecting: true,
    error: null,
  });

  try {
    const session = await connectInjectedWallet("substrate", {
      extensionName: extensionName ?? undefined,
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
    if (connectRunId === currentConnectRunId) {
      setState({
        isConnecting: false,
      });
    }
  }
}

async function connect(
  kind: WalletKind,
  providerId: string | null = null,
  extensionName: string | null = null,
) {
  try {
    if (kind === "evm") {
      await connectEvmWallet(providerId);
      return;
    }

    await connectSubstrateWallet(extensionName);
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
  void restorePersistedWalletSessions();

  const handleWindowFocus = () => {
    syncAvailableWallets();
  };

  window.addEventListener("focus", handleWindowFocus);
}

async function restorePersistedWalletSessions() {
  const currentRestoreRunId = ++restoreRunId;
  const preferences = readPersistedWalletPreferences();
  if (!preferences) {
    setState({
      isRestoring: false,
    });
    return;
  }

  setState({
    isRestoring: true,
  });

  const restoredSessions: WalletSessions = {};

  if (preferences.evm) {
    try {
      const session = await connectInjectedWallet("evm", {
        providerId: preferences.evm.providerId ?? undefined,
        requestAccess: false,
      });
      if (session.kind === "evm") {
        bindEvmProvider(session.provider, {
          id: session.providerId,
          label: session.providerLabel,
        });
        restoredSessions.evm = session;
      }
    } catch {
      // ignore missing/disconnected provider during restore
    }
  }

  if (preferences.substrate) {
    try {
      const session = await connectInjectedWallet("substrate", {
        extensionName: preferences.substrate.extensionName,
        accountAddress: preferences.substrate.accountAddress,
        extensionDappName: DAPP_NAME,
      });
      if (session.kind !== "substrate") {
        throw new Error("Expected a Substrate wallet session.");
      }
      restoredSessions.substrate = session;
    } catch {
      // ignore missing extension/account during restore
    }
  }

  if (Object.keys(restoredSessions).length > 0) {
    if (restoreRunId !== currentRestoreRunId) {
      return;
    }

    setState({
      sessions: {
        ...restoredSessions,
        ...state.sessions,
      },
      isRestoring: false,
      error: null,
    });
    return;
  }

  if (restoreRunId !== currentRestoreRunId) {
    return;
  }

  if (Object.keys(state.sessions).length === 0) {
    clearPersistedWalletPreferences();
  }
  setState({
    isRestoring: false,
  });
}

function persistWalletPreferences(sessions: WalletSessions) {
  if (typeof window === "undefined") {
    return;
  }

  const preferences: PersistedWalletPreferences = {};
  if (sessions.evm?.kind === "evm") {
    preferences.evm = {
      enabled: true,
      providerId: sessions.evm.providerId,
    };
  }
  if (sessions.substrate?.kind === "substrate") {
    preferences.substrate = {
      extensionName: sessions.substrate.extensionName,
      accountAddress: sessions.substrate.account,
    };
  }

  try {
    if (Object.keys(preferences).length === 0) {
      window.localStorage.removeItem(WALLET_PREFERENCES_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      WALLET_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
  }
}

function readPersistedWalletPreferences(): PersistedWalletPreferences | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WALLET_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as PersistedWalletPreferences;
  } catch {
    return null;
  }
}

function clearPersistedWalletPreferences() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(WALLET_PREFERENCES_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function useWallet() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const primarySession = snapshot.sessions.evm ?? snapshot.sessions.substrate ?? null;

  useEffect(() => {
    initializeStore();
  }, []);

  useEffect(() => {
    for (const chainKey of chainKeysForWalletKind("evm")) {
      disconnectXRouteWalletChain(chainKey);
    }
    for (const chainKey of chainKeysForWalletKind("substrate")) {
      disconnectXRouteWalletChain(chainKey);
    }

    if (snapshot.sessions.evm?.kind === "evm") {
      for (const chainKey of chainKeysForWalletKind("evm")) {
        connectXRouteWallet("evm", {
          provider: snapshot.sessions.evm.provider,
          chainKey,
          debugTransactions: isXRouteDebugTransactionsEnabled(),
        });
      }
    }

    if (snapshot.sessions.substrate?.kind === "substrate") {
      for (const chainKey of chainKeysForWalletKind("substrate")) {
        connectXRouteWallet("substrate", {
          extension: snapshot.sessions.substrate.extensionSource,
          accountAddress: snapshot.sessions.substrate.account,
          chainKey,
        });
      }
    }
  }, [snapshot.sessions.evm, snapshot.sessions.substrate]);

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
    connectEvmProvider(providerId: string) {
      return connect("evm", providerId);
    },
    connectSubstrate(extensionName?: string) {
      return connect("substrate", null, extensionName ?? null);
    },
    disconnect,
  };
}

function isXRouteDebugTransactionsEnabled() {
  return process.env.NEXT_PUBLIC_XROUTE_DEBUG_TX?.trim() === "true";
}
