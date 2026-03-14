export type TransferQuoteRequest = {
  kind: "transfer";
  sourceChain: "polkadot-hub" | "hydration" | "moonbeam" | "bifrost";
  destinationChain: "polkadot-hub" | "hydration" | "moonbeam" | "bifrost";
  asset: "DOT" | "USDT" | "HDX" | "VDOT";
  amount: string;
  recipient: string;
  ownerAddress?: string;
};

export type SwapQuoteRequest = {
  kind: "swap";
  sourceChain: "polkadot-hub" | "moonbeam";
  destinationChain: "hydration";
  assetIn: "DOT";
  assetOut: "USDT" | "HDX";
  amountIn: string;
  minAmountOut: string;
  settlementChain: "hydration" | "polkadot-hub";
  recipient: string;
  ownerAddress?: string;
};

export type CallQuoteRequest = {
  kind: "execute";
  sourceChain: "polkadot-hub" | "hydration" | "bifrost";
  destinationChain: "moonbeam";
  executionType: "call";
  maxPaymentAmount: string;
  contractAddress: string;
  calldata: string;
  value?: string;
  gasLimit?: string;
  fallbackRefTime?: string;
  fallbackProofSize?: string;
  ownerAddress?: string;
};

export type QuoteRequest = TransferQuoteRequest | SwapQuoteRequest | CallQuoteRequest;

export type QuoteResponse = {
  intent: {
    quoteId: string;
    deploymentProfile: string;
    sourceChain: string;
    destinationChain: string;
    refundAddress: string;
    deadline: number;
    action: {
      type: string;
      params: Record<string, unknown>;
    };
  };
  quote: {
    quoteId: string;
    deploymentProfile: string;
    route: string[];
    segments?: {
      kind: "execution" | "settlement";
      route: string[];
      hops: {
        source: string;
        destination: string;
        asset: string;
        transportFee: { asset: string; amount: string };
        buyExecutionFee: { asset: string; amount: string };
      }[];
      xcmFee: { asset: string; amount: string };
      destinationFee: { asset: string; amount: string };
    }[];
    fees: {
      xcmFee: { asset: string; amount: string };
      destinationFee: { asset: string; amount: string };
      platformFee: { asset: string; amount: string };
      totalFee: { asset: string; amount: string };
    };
    estimatedSettlementFee?: { asset: string; amount: string } | null;
    expectedOutput?: { asset: string; amount: string };
    minOutput?: { asset: string; amount: string };
    executionPlan?: unknown;
    submission: {
      action: string;
      asset: string;
      amount: string;
      xcmFee: string;
      destinationFee: string;
      minOutputAmount: string;
    };
  };
};
