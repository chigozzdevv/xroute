import WebSocket from "ws";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";

const [, , rpcUrl, startIso, minutesBeforeArg = "5", minutesAfterArg = "15", recipient = ""] =
  process.argv;

if (!rpcUrl || !startIso) {
  process.stderr.write(
    "usage: node scripts/debug-substrate-events.mjs <rpcUrl> <startIso> [minutesBefore] [minutesAfter] [recipient]\n",
  );
  process.exit(1);
}

const targetTime = Date.parse(startIso);
if (!Number.isFinite(targetTime)) {
  process.stderr.write(`invalid startIso: ${startIso}\n`);
  process.exit(1);
}

const minutesBefore = Number(minutesBeforeArg);
const minutesAfter = Number(minutesAfterArg);
const lowerBound = targetTime - minutesBefore * 60_000;
const upperBound = targetTime + minutesAfter * 60_000;
const replacer = (_, value) => (typeof value === "bigint" ? value.toString() : value);

const ws = new WebSocket(rpcUrl, { handshakeTimeout: 15_000 });
let nextId = 1;
const pending = new Map();

ws.on("message", (raw) => {
  const payload = JSON.parse(raw.toString());
  const handler = pending.get(payload.id);
  if (handler == null) {
    return;
  }
  pending.delete(payload.id);
  if (payload.error) {
    handler.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    return;
  }
  handler.resolve(payload.result);
});

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

const rpc = (method, params = []) =>
  new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    );
  });

const metadataHex = await rpc("state_getMetadata", []);
const decodedMetadata = unifyMetadata(metadata.dec(metadataHex));
const builder = getDynamicBuilder(getLookupFn(decodedMetadata));
const systemEvents = builder.buildStorage("System", "Events");
const timestampNow = builder.buildStorage("Timestamp", "Now");
const systemEventsKey = systemEvents.keys.enc();
const timestampNowKey = timestampNow.keys.enc();

let blockHash = await rpc("chain_getFinalizedHead", []);
let scanned = 0;

while (blockHash && scanned < 2_000) {
  const header = await rpc("chain_getHeader", [blockHash]);
  const timestampRaw = await rpc("state_getStorage", [timestampNowKey, blockHash]);
    const timestamp = timestampRaw == null ? 0 : Number(timestampNow.value.dec(timestampRaw));

  if (timestamp && timestamp < lowerBound) {
    break;
  }

  if (timestamp && timestamp <= upperBound) {
    const eventsRaw = await rpc("state_getStorage", [systemEventsKey, blockHash]);
    const events = eventsRaw == null ? [] : systemEvents.value.dec(eventsRaw);
    const interesting = events.filter((record) => {
      const pallet = record?.event?.type;
      if (
        pallet === "PolkadotXcm"
        || pallet === "MessageQueue"
        || pallet === "XcmpQueue"
        || pallet === "DmpQueue"
        || pallet === "Balances"
        || pallet === "Tokens"
        || pallet === "Currencies"
      ) {
        return true;
      }
      if (!recipient) {
        return false;
      }
      return JSON.stringify(record, replacer).includes(recipient);
    });

    if (interesting.length > 0) {
      process.stdout.write(
        `BLOCK ${Number.parseInt(header.number, 16)} ${blockHash} ${new Date(timestamp).toISOString()}\n`,
      );
      for (const record of interesting) {
        process.stdout.write(`${JSON.stringify(record, replacer)}\n`);
      }
    }
  }

  blockHash = header.parentHash;
  scanned += 1;
}

ws.close();
