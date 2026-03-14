const textEncoder = new TextEncoder();
const SHA256_WORDS = Object.freeze([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]);

export const ACTION_TYPES = Object.freeze({
  TRANSFER: "transfer",
  SWAP: "swap",
  EXECUTE: "execute",
});

export const EXECUTION_TYPES = Object.freeze({
  CALL: "call",
  MINT_VDOT: "mint-vdot",
  REDEEM_VDOT: "redeem-vdot",
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
  return `0x${sha256Hex(serializeForHash(value))}`;
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

function sha256Hex(input) {
  const inputBytes = textEncoder.encode(input);
  const paddedLength = Math.ceil((inputBytes.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  const view = new DataView(bytes.buffer);
  const words = new Uint32Array(64);
  const bitLength = inputBytes.length * 8;

  bytes.set(inputBytes);
  bytes[inputBytes.length] = 0x80;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      words[index] = addUint32(
        smallSigma1(words[index - 2]),
        words[index - 7],
        smallSigma0(words[index - 15]),
        words[index - 16],
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const t1 = addUint32(
        h,
        bigSigma1(e),
        choose(e, f, g),
        SHA256_WORDS[index],
        words[index],
      );
      const t2 = addUint32(bigSigma0(a), majority(a, b, c));

      h = g;
      g = f;
      f = e;
      e = addUint32(d, t1);
      d = c;
      c = b;
      b = a;
      a = addUint32(t1, t2);
    }

    h0 = addUint32(h0, a);
    h1 = addUint32(h1, b);
    h2 = addUint32(h2, c);
    h3 = addUint32(h3, d);
    h4 = addUint32(h4, e);
    h5 = addUint32(h5, f);
    h6 = addUint32(h6, g);
    h7 = addUint32(h7, h);
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

function addUint32(...values) {
  let total = 0;
  for (const value of values) {
    total = (total + (value >>> 0)) >>> 0;
  }
  return total;
}

function rotateRight(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

function choose(x, y, z) {
  return (x & y) ^ (~x & z);
}

function majority(x, y, z) {
  return (x & y) ^ (x & z) ^ (y & z);
}

function bigSigma0(value) {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22);
}

function bigSigma1(value) {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25);
}

function smallSigma0(value) {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
}

function smallSigma1(value) {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10);
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
