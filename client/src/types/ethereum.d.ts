export {};

declare global {
  interface EthereumProvider {
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
  }
}
