import {
  createExecuteIntent,
  createSwapIntent,
  createTransferIntent,
  toPlainIntent,
} from "../../../../packages/xroute-intents/index.mjs";
import { getAsset } from "../../../../packages/xroute-chain-registry/index.mjs";

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

const DEFAULT_OWNER_ADDRESS = "0x1111111111111111111111111111111111111111";
const DEFAULT_DEADLINE_SECONDS = 60 * 60;
const DEFAULT_QUOTE_SERVICE_URL = "http://127.0.0.1:8787/quote";

function toChainUnits(value: string, assetKey: string) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`invalid decimal amount for ${assetKey}`);
  }

  const { decimals } = getAsset(assetKey, "mainnet");
  const [wholePart, fractionPart = ""] = normalized.split(".");
  if (fractionPart.length > decimals) {
    throw new Error(`${assetKey} supports at most ${decimals} decimal places`);
  }

  const whole = wholePart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = `${fractionPart}${"0".repeat(decimals - fractionPart.length)}`;
  const joined = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return joined;
}

function deadline() {
  return Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;
}

function ownerAddress(value?: string) {
  return value?.trim() || DEFAULT_OWNER_ADDRESS;
}

function parseOptionalInteger(value?: string) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? undefined : normalized;
}

function parseOptionalNumber(value?: string) {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid integer value: ${value}`);
  }
  return parsed;
}

function buildIntent(request: QuoteRequest) {
  switch (request.kind) {
    case "transfer":
      return createTransferIntent({
        sourceChain: request.sourceChain,
        destinationChain: request.destinationChain,
        senderAddress: ownerAddress(request.ownerAddress),
        deadline: deadline(),
        params: {
          asset: request.asset,
          amount: toChainUnits(request.amount, request.asset),
          recipient: request.recipient,
        },
      });
    case "swap":
      return createSwapIntent({
        sourceChain: request.sourceChain,
        destinationChain: request.destinationChain,
        senderAddress: ownerAddress(request.ownerAddress),
        deadline: deadline(),
        params: {
          assetIn: request.assetIn,
          assetOut: request.assetOut,
          amountIn: toChainUnits(request.amountIn, request.assetIn),
          minAmountOut: toChainUnits(request.minAmountOut, request.assetOut),
          settlementChain: request.settlementChain,
          recipient: request.recipient,
        },
      });
    case "execute":
      return createExecuteIntent({
        sourceChain: request.sourceChain,
        destinationChain: request.destinationChain,
        senderAddress: ownerAddress(request.ownerAddress),
        deadline: deadline(),
        params: {
          executionType: "call",
          asset: "DOT",
          maxPaymentAmount: request.maxPaymentAmount,
          contractAddress: request.contractAddress,
          calldata: request.calldata,
          value: parseOptionalInteger(request.value),
          gasLimit: parseOptionalInteger(request.gasLimit),
          fallbackWeight: {
            refTime: parseOptionalNumber(request.fallbackRefTime),
            proofSize: parseOptionalNumber(request.fallbackProofSize),
          },
        },
      });
    default:
      throw new Error("unsupported quote request kind");
  }
}

export async function quoteRequest(request: QuoteRequest) {
  const intent = buildIntent(request);
  const endpoint = process.env.XROUTE_QUOTE_SERVICE_URL?.trim() || DEFAULT_QUOTE_SERVICE_URL;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      intent: toPlainIntent(intent),
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.quote) {
    throw new Error(payload?.error ?? `quote request failed with status ${response.status}`);
  }

  return {
    intent: toPlainIntent(intent),
    quote: payload.quote,
  };
}
