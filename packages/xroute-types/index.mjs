import { createHash } from "node:crypto";

export const ACTION_TYPES = Object.freeze({
  TRANSFER: "transfer",
  SWAP: "swap",
  STAKE: "stake",
  CALL: "call",
});

export const DISPATCH_MODES = Object.freeze({
  EXECUTE: "execute",
  SEND: "send",
});

export const INTENT_STATUSES = Object.freeze({
  SUBMITTED: "submitted",
  DISPATCHED: "dispatched",
  EXECUTING: "executing",
  SETTLED: "settled",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
});

export const INDEXER_EVENT_TYPES = Object.freeze({
  INTENT_SUBMITTED: "intent-submitted",
  INTENT_DISPATCHED: "intent-dispatched",
  DESTINATION_EXECUTION_STARTED: "destination-execution-started",
  DESTINATION_EXECUTION_SUCCEEDED: "destination-execution-succeeded",
  DESTINATION_EXECUTION_FAILED: "destination-execution-failed",
  INTENT_CANCELLED: "intent-cancelled",
  REFUND_ISSUED: "refund-issued",
});

export function assertIncluded(name, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${name} must be one of: ${allowedValues.join(", ")}`);
  }

  return value;
}

export function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

export function assertInteger(name, value) {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }

  return value;
}

export function toBigInt(value, name = "value") {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }

  throw new Error(`${name} must be a non-negative integer-like value`);
}

export function assertPositiveBigInt(name, value) {
  const normalized = toBigInt(value, name);
  if (normalized <= 0n) {
    throw new Error(`${name} must be greater than zero`);
  }

  return normalized;
}

export function assertHexString(name, value) {
  const normalized = assertNonEmptyString(name, value).toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(normalized) || (normalized.length - 2) % 2 !== 0) {
    throw new Error(`${name} must be a 0x-prefixed even-length hex string`);
  }

  return normalized;
}

export function assertAddress(name, value) {
  const normalized = assertHexString(name, value);
  if (normalized.length !== 42) {
    throw new Error(`${name} must be a 20-byte 0x-prefixed hex address`);
  }

  return normalized;
}

export function assertBytes32Hex(name, value) {
  const normalized = assertHexString(name, value);
  if (normalized.length !== 66) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed hex value`);
  }

  return normalized;
}

export function serializeForHash(value) {
  return JSON.stringify(sortValue(value));
}

export function deterministicId(value) {
  return `0x${createHash("sha256").update(serializeForHash(value)).digest("hex")}`;
}

export function toPlainObject(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPlainObject(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, toPlainObject(nested)]),
    );
  }

  return value;
}

function sortValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }

  return value;
}
