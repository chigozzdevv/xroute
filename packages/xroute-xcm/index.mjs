import { execFileSync } from "node:child_process";

import {
  DISPATCH_MODES,
  assertHexString,
  assertIncluded,
  assertInteger,
  assertNonEmptyString,
  toBigInt,
} from "../xroute-types/index.mjs";
import {
  ACTION_TO_CONTRACT_ENUM,
  DISPATCH_MODE_TO_CONTRACT_ENUM,
} from "../xroute-precompile-interfaces/index.mjs";

export function createDispatchEnvelope({
  mode,
  destination,
  destinationHex,
  message,
  messageHex,
}) {
  const normalizedMode = assertIncluded("mode", mode, Object.values(DISPATCH_MODES));
  const normalizedMessageHex = assertHexString("message", messageHex ?? message);
  const normalizedDestinationHex = assertHexString(
    "destination",
    destinationHex ?? destination ?? "0x",
  );

  if (normalizedMode === DISPATCH_MODES.SEND && normalizedDestinationHex === "0x") {
    throw new Error("destination must be provided for send dispatches");
  }

  return Object.freeze({
    mode: normalizedMode,
    destinationHex: normalizedDestinationHex,
    messageHex: normalizedMessageHex,
  });
}

export function computeExecutionHash(envelope, { castBin = "cast" } = {}) {
  const normalized = createDispatchEnvelope(envelope);
  const modeValue = DISPATCH_MODE_TO_CONTRACT_ENUM[normalized.mode];

  const encoded = execFileSync(
    castBin,
    [
      "abi-encode",
      "f(uint8,bytes,bytes)",
      String(modeValue),
      normalized.destinationHex,
      normalized.messageHex,
    ],
    { encoding: "utf8" },
  ).trim();

  return execFileSync(castBin, ["keccak", encoded], { encoding: "utf8" }).trim().toLowerCase();
}

export function buildDispatchRequest(envelope) {
  const normalized = createDispatchEnvelope(envelope);

  return Object.freeze({
    mode: DISPATCH_MODE_TO_CONTRACT_ENUM[normalized.mode],
    destination: normalized.destinationHex,
    message: normalized.messageHex,
  });
}

export function buildRouterIntentRequest({
  intent,
  quote,
  envelope,
  assetAddress,
  castBin = "cast",
}) {
  const executionHash = computeExecutionHash(envelope, { castBin });
  const normalizedAddress = assertHexString("assetAddress", assetAddress);

  if (!quote?.submission) {
    throw new Error("quote.submission is required");
  }

  if (quote.quoteId !== intent.quoteId) {
    throw new Error("quote does not belong to the provided intent");
  }

  return Object.freeze({
    actionType: ACTION_TO_CONTRACT_ENUM[quote.submission.action],
    asset: normalizedAddress,
    amount: toBigInt(quote.submission.amount, "quote.submission.amount"),
    xcmFee: toBigInt(quote.submission.xcmFee, "quote.submission.xcmFee"),
    destinationFee: toBigInt(
      quote.submission.destinationFee,
      "quote.submission.destinationFee",
    ),
    minOutputAmount: toBigInt(
      quote.submission.minOutputAmount,
      "quote.submission.minOutputAmount",
    ),
    deadline: assertInteger("intent.deadline", intent.deadline),
    executionHash,
  });
}

export function buildExplorerLabel({ sourceChain, destinationChain, mode }) {
  assertNonEmptyString("sourceChain", sourceChain);
  assertNonEmptyString("destinationChain", destinationChain);
  assertIncluded("mode", mode, Object.values(DISPATCH_MODES));

  return `${sourceChain} -> ${destinationChain} (${mode})`;
}
