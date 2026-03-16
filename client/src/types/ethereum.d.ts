export {};

declare global {
  interface InjectedSubstrateAccount {
    address: string;
    name?: string;
    meta?: {
      name?: string;
    };
  }

  interface InjectedSubstrateAccountsSource {
    get?(): Promise<InjectedSubstrateAccount[]>;
  }

  interface InjectedSubstrateExtension {
    accounts?: unknown;
    signer?: unknown;
  }

  interface InjectedSubstrateExtensionSource {
    enable(originName?: string): Promise<unknown>;
  }

  interface EthereumProvider {
    isMetaMask?: boolean;
    isRabby?: boolean;
    isCoinbaseWallet?: boolean;
    isBraveWallet?: boolean;
    isTrust?: boolean;
    providers?: EthereumProvider[];
    request(args: {
      method: string;
      params?: unknown[] | Record<string, unknown>;
    }): Promise<unknown>;
    on?(
      event: "accountsChanged" | "chainChanged",
      listener: (...args: unknown[]) => void,
    ): void;
    removeListener?(
      event: "accountsChanged" | "chainChanged",
      listener: (...args: unknown[]) => void,
    ): void;
  }

  interface Window {
    ethereum?: EthereumProvider;
    injectedWeb3?: Record<string, InjectedSubstrateExtensionSource | undefined>;
  }
}
