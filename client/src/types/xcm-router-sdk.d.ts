declare module "@xcm-router/sdk" {
  export const createXRouteClient: (options?: any) => any;
  export const connectXRouteWallet: (typeOrWallet: any, options?: any) => any;
  export const connectInjectedWallet: (type: any, options?: any) => Promise<any>;
  export const getBrowserWalletAvailability: () => any;
  export const listInjectedEvmProviders: () => any[];
  export const listInjectedSubstrateExtensions: () => any[];
}

declare module "@xcm-router/sdk/chains" {
  export const DEFAULT_DEPLOYMENT_PROFILE: any;
  export const formatAssetAmount: (assetKey: any, value: any, deploymentProfile?: any, options?: any) => string;
  export const formatUnits: (value: any, decimals: any, options?: any) => string;
  export const getAssetDecimals: (assetKey: any, deploymentProfile?: any) => number;
  export const getChain: (chainKey: any, deploymentProfile?: any) => any;
  export const getChainWalletType: (chainKey: any, deploymentProfile?: any) => "evm" | "substrate";
  export const listAssets: (deploymentProfile?: any) => any[];
  export const listChains: (deploymentProfile?: any) => any[];
  export const parseAssetAmount: (assetKey: any, value: any, deploymentProfile?: any) => string;
}

declare module "@xcm-router/sdk/routes" {
  export const getExecuteOptions: (sourceChain: any, deploymentProfile?: any) => any[];
  export const getSwapOptions: (sourceChain: any, deploymentProfile?: any) => any[];
  export const getTransferOptions: (sourceChain: any, deploymentProfile?: any) => any[];
}
