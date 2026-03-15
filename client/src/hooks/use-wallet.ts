"use client";

import { useEffect, useSyncExternalStore } from "react";

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

type WalletState = {
  session: WalletSession | null;
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
  session: null,
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
  if (typeof window === "undefined") {
    return {
      evm: false,
      substrate: false,
    };
  }

  return {
    evm: Boolean(window.ethereum),
    substrate: Object.keys(window.injectedWeb3 ?? {}).length > 0,
  };
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
      setState({
        session: null,
        error: null,
      });
      return;
    }

    setState({
      session: {
        kind: "evm",
        account: nextAccount,
        provider,
      },
      error: null,
    });
  };

  provider.on?.("accountsChanged", boundAccountsListener);
  boundEvmProvider = provider;
}

async function connectEvmWallet() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("Install an injected EVM wallet to connect.");
  }

  setState({
    isConnecting: true,
    error: null,
  });

  try {
    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    const nextAccounts = Array.isArray(accounts) ? (accounts as string[]) : [];
    const account = nextAccounts[0] ?? null;
    if (!account) {
      throw new Error("No EVM account was returned by the wallet.");
    }

    bindEvmProvider(window.ethereum);
    setState({
      session: {
        kind: "evm",
        account,
        provider: window.ethereum,
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
  if (typeof window === "undefined") {
    throw new Error("Substrate wallet extensions are only available in the browser.");
  }

  const entries = Object.entries(window.injectedWeb3 ?? {}).filter(
    ([, source]) => Boolean(source) && typeof source?.enable === "function",
  );
  if (entries.length === 0) {
    throw new Error("Install a Substrate wallet extension to connect.");
  }

  setState({
    isConnecting: true,
    error: null,
  });

  try {
    const [extensionName, rawExtensionSource] = entries[0];
    if (!rawExtensionSource || typeof rawExtensionSource.enable !== "function") {
      throw new Error("No Substrate wallet extension is available.");
    }

    const extensionSource = rawExtensionSource as InjectedSubstrateExtensionSource;
    const injected = await extensionSource.enable(DAPP_NAME);
    const accounts = await readSubstrateAccounts(injected);
    const account = accounts[0];
    if (!account?.address) {
      throw new Error("No Substrate accounts were returned by the extension.");
    }

    setState({
      session: {
        kind: "substrate",
        account: account.address,
        extensionName,
        extensionSource,
        accountLabel: account.meta?.name ?? account.name ?? null,
      },
      error: null,
    });
  } finally {
    setState({
      isConnecting: false,
    });
  }
}

async function readSubstrateAccounts(injected: unknown) {
  const accountsSource =
    injected && typeof injected === "object" && "accounts" in injected
      ? (injected as InjectedSubstrateExtension).accounts
      : undefined;
  if (!accountsSource) {
    return [];
  }

  if (Array.isArray(accountsSource)) {
    return accountsSource;
  }

  if (typeof accountsSource === "function") {
    const accounts = await accountsSource();
    return Array.isArray(accounts) ? accounts : [];
  }

  if (
    accountsSource
    && typeof accountsSource === "object"
    && "get" in accountsSource
    && typeof (accountsSource as InjectedSubstrateAccountsSource).get === "function"
  ) {
    const accounts = await (accountsSource as InjectedSubstrateAccountsSource).get?.();
    return Array.isArray(accounts) ? accounts : [];
  }

  return [];
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

function disconnect() {
  setState({
    session: null,
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

  useEffect(() => {
    initializeStore();
  }, []);

  return {
    ...snapshot,
    account: snapshot.session?.account ?? null,
    kind: snapshot.session?.kind ?? null,
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
