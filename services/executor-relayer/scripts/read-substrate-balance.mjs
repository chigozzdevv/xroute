import { readFileSync } from "node:fs";
import WebSocket from "ws";

import {
  AccountId,
  Blake2128Concat,
  Struct,
  Twox128,
  Twox64Concat,
  u128,
  u32,
} from "@polkadot-api/substrate-bindings";

const input = JSON.parse(readFileSync(0, "utf8"));
const chainKey = requiredString(input?.chainKey, "chainKey").trim().toLowerCase();
const rpcUrl = requiredString(input?.rpcUrl, "rpcUrl");
const asset = requiredString(input?.asset, "asset").trim().toUpperCase();
const recipient = requiredString(input?.recipient, "recipient").trim();

const encoder = new TextEncoder();
const balance = await readBalance({ chainKey, rpcUrl, asset, recipient });
process.stdout.write(JSON.stringify({ balance: balance.toString() }));

async function readBalance({ chainKey, rpcUrl, asset, recipient }) {
  if (chainKey === "hydration") {
    if (asset === "HDX") {
      return readNativeBalance(rpcUrl, recipient);
    }
    if (asset === "DOT") {
      return readHydrationTokenBalance(rpcUrl, recipient, 5);
    }
    if (asset === "USDT") {
      return readHydrationTokenBalance(rpcUrl, recipient, 10);
    }
  }

  if (chainKey === "bifrost" && asset === "BNC") {
    return readNativeBalance(rpcUrl, recipient);
  }

  throw new Error(`unsupported substrate balance target: ${chainKey} ${asset}`);
}

async function readNativeBalance(rpcUrl, recipient) {
  const key = systemAccountStorageKey(recipient);
  const raw = await rpcStateGetStorage(rpcUrl, key);
  if (!raw) {
    return 0n;
  }

  const codec = Struct({
    nonce: u32,
    consumers: u32,
    providers: u32,
    sufficients: u32,
    data: Struct({
      free: u128,
      reserved: u128,
      frozen: u128,
      flags: u128,
    }),
  });
  const decoded = codec.dec(hexToBytes(raw));
  return decoded.data.free;
}

async function readHydrationTokenBalance(rpcUrl, recipient, assetId) {
  const key = hydrationTokensAccountStorageKey(recipient, assetId);
  const raw = await rpcStateGetStorage(rpcUrl, key);
  if (!raw) {
    return 0n;
  }

  const codec = Struct({
    free: u128,
    reserved: u128,
    frozen: u128,
  });
  const decoded = codec.dec(hexToBytes(raw));
  return decoded.free;
}

function systemAccountStorageKey(recipient) {
  return (
    "0x"
    + bytesToHex(Twox128(encoder.encode("System")))
    + bytesToHex(Twox128(encoder.encode("Account")))
    + bytesToHex(Blake2128Concat(AccountId().enc(recipient)))
  );
}

function hydrationTokensAccountStorageKey(recipient, assetId) {
  return (
    "0x"
    + bytesToHex(Twox128(encoder.encode("Tokens")))
    + bytesToHex(Twox128(encoder.encode("Accounts")))
    + bytesToHex(Blake2128Concat(AccountId().enc(recipient)))
    + bytesToHex(Twox64Concat(u32.enc(assetId)))
  );
}

async function rpcStateGetStorage(rpcUrl, key) {
  if (rpcUrl.startsWith("http://") || rpcUrl.startsWith("https://")) {
    return rpcOverHttp(rpcUrl, "state_getStorage", [key]);
  }
  if (rpcUrl.startsWith("ws://") || rpcUrl.startsWith("wss://")) {
    return rpcOverWebSocket(rpcUrl, "state_getStorage", [key]);
  }

  throw new Error(`unsupported substrate rpc url: ${rpcUrl}`);
}

async function rpcOverHttp(rpcUrl, method, params) {
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

  return payload?.result ?? null;
}

async function rpcOverWebSocket(rpcUrl, method, params) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(rpcUrl, { handshakeTimeout: 15_000 });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`${method} websocket timed out`));
    }, 15_000);

    const cleanup = () => {
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        }),
      );
    });

    ws.on("message", (event) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        const payload = JSON.parse(String(event));
        if (payload?.error) {
          reject(new Error(payload.error?.message || `${method} failed`));
        } else {
          resolve(payload?.result ?? null);
        }
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    });

    ws.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error ?? new Error(`${method} websocket error`));
    });

    ws.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${method} websocket closed before response`));
    });
  });
}

function hexToBytes(value) {
  const normalized = normalizeHex(value, "storage value");
  const bytes = new Uint8Array((normalized.length - 2) / 2);
  for (let index = 2; index < normalized.length; index += 2) {
    bytes[(index - 2) / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function normalizeHex(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("0x") || normalized.length % 2 !== 0) {
    throw new Error(`${field} must be 0x-prefixed even-length hex`);
  }
  if (!/^[0-9a-f]+$/i.test(normalized.slice(2))) {
    throw new Error(`${field} must be valid hex`);
  }
  return normalized;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing required field: ${field}`);
  }
  return value;
}
