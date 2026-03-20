import WebSocket from "ws";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";

const [, , rpcUrl, targetIso, beforeArg = "5", afterArg = "10", filterArg = ""] = process.argv;

if (!rpcUrl || !targetIso) {
  process.stderr.write(
    "usage: node scripts/trace-substrate-window.mjs <rpcUrl> <targetIso> [minutesBefore] [minutesAfter] [filter]\n",
  );
  process.exit(1);
}

const targetTime = Date.parse(targetIso);
if (!Number.isFinite(targetTime)) {
  process.stderr.write(`invalid targetIso: ${targetIso}\n`);
  process.exit(1);
}

const minutesBefore = Number(beforeArg);
const minutesAfter = Number(afterArg);
const textFilter = String(filterArg ?? "").trim();
const replacer = (_, value) => (typeof value === "bigint" ? value.toString() : value);

const ws = new WebSocket(rpcUrl, { handshakeTimeout: 15_000 });
let nextId = 1;
const pending = new Map();

ws.on("message", (raw) => {
  const payload = JSON.parse(raw.toString());
  const handler = pending.get(payload.id);
  if (!handler) {
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

async function getBlockData(blockNumber) {
  const blockHash = await rpc("chain_getBlockHash", [`0x${blockNumber.toString(16)}`]);
  const header = await rpc("chain_getHeader", [blockHash]);
  const timestampRaw = await rpc("state_getStorage", [timestampNowKey, blockHash]);
  const timestamp = timestampRaw == null ? 0 : Number(timestampNow.value.dec(timestampRaw));
  return {
    blockNumber,
    blockHash,
    header,
    timestamp,
  };
}

const finalizedHead = await rpc("chain_getFinalizedHead", []);
const finalizedHeader = await rpc("chain_getHeader", [finalizedHead]);
let low = 1;
let high = Number.parseInt(finalizedHeader.number, 16);

while (low < high) {
  const middle = Math.floor((low + high + 1) / 2);
  const { timestamp } = await getBlockData(middle);
  if (!timestamp || timestamp <= targetTime) {
    low = middle;
  } else {
    high = middle - 1;
  }
}

const centerBlock = low;
const lowerBound = targetTime - minutesBefore * 60_000;
const upperBound = targetTime + minutesAfter * 60_000;

process.stdout.write(
  `${JSON.stringify({ centerBlock, targetIso, minutesBefore, minutesAfter, filter: textFilter || null })}\n`,
);

for (let blockNumber = Math.max(1, centerBlock - 12); blockNumber <= centerBlock + 30; blockNumber += 1) {
  const { blockHash, timestamp } = await getBlockData(blockNumber);
  if (timestamp && (timestamp < lowerBound || timestamp > upperBound)) {
    continue;
  }
  const eventsRaw = await rpc("state_getStorage", [systemEventsKey, blockHash]);
  const events = eventsRaw == null ? [] : systemEvents.value.dec(eventsRaw);
  const interesting = events.filter((record) => {
    const pallet = record?.event?.type;
    const palletInteresting =
      pallet === "PolkadotXcm"
      || pallet === "XcmPallet"
      || pallet === "MessageQueue"
      || pallet === "XcmpQueue"
      || pallet === "DmpQueue"
      || pallet === "Balances"
      || pallet === "Tokens"
      || pallet === "Currencies";
    if (!textFilter) {
      return palletInteresting;
    }
    const rendered = JSON.stringify(record, replacer);
    return palletInteresting && rendered.includes(textFilter);
  });

  if (interesting.length === 0) {
    continue;
  }

  process.stdout.write(
    `\nBLOCK ${blockNumber} ${new Date(timestamp).toISOString()} ${blockHash}\n`,
  );
  for (const record of interesting) {
    process.stdout.write(`${JSON.stringify(record, replacer)}\n`);
  }
}

ws.close();
