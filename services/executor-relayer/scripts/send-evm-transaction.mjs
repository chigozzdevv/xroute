import { readFileSync } from "node:fs";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const rpcUrl = requiredString(input?.rpcUrl, "rpcUrl");
const privateKey = normalizePrivateKey(requiredString(input?.privateKey, "privateKey"));
const to = normalizeAddress(requiredString(input?.to, "to"));
const data = normalizeHex(requiredString(input?.data, "data"), "data");

const privateKeyBytes = hexToBytes(privateKey.slice(2));
const from = deriveAddress(privateKeyBytes);
const chainId = hexToBigInt(await rpc(rpcUrl, "eth_chainId", []));
const nonce = hexToBigInt(await rpc(rpcUrl, "eth_getTransactionCount", [from, "pending"]));
const gasPrice = hexToBigInt(await rpc(rpcUrl, "eth_gasPrice", []));
const gasLimit =
  input?.gasLimit == null
    ? hexToBigInt(
        await rpc(rpcUrl, "eth_estimateGas", [
          {
            from,
            to,
            data,
            value: "0x0",
          },
        ]),
      )
    : BigInt(String(input.gasLimit));

const unsignedTx = [
  bigintToBytes(nonce),
  bigintToBytes(gasPrice),
  bigintToBytes(gasLimit),
  hexToBytes(to.slice(2)),
  new Uint8Array([]),
  hexToBytes(data.slice(2)),
  bigintToBytes(chainId),
  new Uint8Array([]),
  new Uint8Array([]),
];

const signingPayload = rlpEncodeList(unsignedTx);
const signature = secp256k1.sign(keccak_256(signingPayload), privateKeyBytes, {
  format: "recovered",
  prehash: false,
});
const recovery = BigInt(signature[0]);
const r = trimLeadingZeroBytes(signature.slice(1, 33));
const s = trimLeadingZeroBytes(signature.slice(33, 65));
const v = chainId * 2n + 35n + recovery;

const signedTx = [
  bigintToBytes(nonce),
  bigintToBytes(gasPrice),
  bigintToBytes(gasLimit),
  hexToBytes(to.slice(2)),
  new Uint8Array([]),
  hexToBytes(data.slice(2)),
  bigintToBytes(v),
  r,
  s,
];

const rawTransaction = `0x${bytesToHex(rlpEncodeList(signedTx))}`;
const txHash = await rpc(rpcUrl, "eth_sendRawTransaction", [rawTransaction]);

process.stdout.write(JSON.stringify({ txHash }));

async function rpc(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new Error(payload.error?.message || `${method} failed`);
  }

  return payload?.result;
}

function deriveAddress(privateKeyBytes) {
  const publicKey = secp256k1.getPublicKey(privateKeyBytes, false).slice(1);
  const addressBytes = keccak_256(publicKey).slice(-20);
  return `0x${bytesToHex(addressBytes)}`;
}

function rlpEncodeList(items) {
  const encodedItems = items.map((item) => rlpEncodeBytes(item));
  const payload = concatBytes(...encodedItems);
  return concatBytes(encodeLength(payload.length, 0xc0), payload);
}

function rlpEncodeBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("rlp bytes must be Uint8Array");
  }

  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes;
  }

  return concatBytes(encodeLength(bytes.length, 0x80), bytes);
}

function encodeLength(length, offset) {
  if (length < 56) {
    return Uint8Array.of(offset + length);
  }

  const lengthBytes = bigintToBytes(BigInt(length));
  return concatBytes(Uint8Array.of(offset + 55 + lengthBytes.length), lengthBytes);
}

function bigintToBytes(value) {
  if (value < 0n) {
    throw new Error("negative bigint is not supported");
  }
  if (value === 0n) {
    return new Uint8Array([]);
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return hexToBytes(hex);
}

function trimLeadingZeroBytes(bytes) {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) {
    start += 1;
  }
  return bytes.slice(start);
}

function hexToBigInt(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized.startsWith("0x")) {
    throw new Error("rpc hex result must be 0x-prefixed");
  }

  const hex = normalized.slice(2);
  if (!/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("rpc hex result must be valid hex");
  }

  return BigInt(hex.length === 0 ? "0x0" : normalized);
}

function normalizePrivateKey(value) {
  const normalized = normalizeHex(value, "privateKey");
  if (normalized.length !== 66) {
    throw new Error("privateKey must be 32 bytes");
  }
  return normalized;
}

function normalizeAddress(value) {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.startsWith("0x") ? normalized.slice(2) : normalized;
  if (hex.length !== 40 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`invalid address: ${value}`);
  }
  return `0x${hex}`;
}

function normalizeHex(value, field) {
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("0x")) {
    throw new Error(`${field} must be 0x-prefixed hex`);
  }
  const hex = normalized.slice(2);
  if (hex.length % 2 !== 0) {
    throw new Error(`${field} must contain an even number of hex digits`);
  }
  if (!/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`${field} must be valid hex`);
  }
  return `0x${hex}`;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing required field: ${field}`);
  }
  return value;
}
