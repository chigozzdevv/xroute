import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  ACTION_TYPES,
  DISPATCH_MODES,
  INDEXER_EVENT_TYPES,
  INTENT_STATUSES,
  assertIncluded,
  assertInteger,
  assertNonEmptyString,
  deterministicId,
  toBigInt,
  toPlainObject,
} from "../xroute-types/index.mjs";

export class InMemoryStatusIndexer {
  #eventStores = new Map();
  #records = new Map();
  #listeners = new Set();

  ingest(event) {
    return this.#applyEvent(normalizeEvent(event));
  }

  getStatus(intentId) {
    const record = this.#records.get(intentId);
    return record ? clone(record) : null;
  }

  getTimeline(intentId) {
    const record = this.#records.get(intentId);
    return record ? clone(record.timeline) : [];
  }

  ingestBatch(events) {
    return events.map((event) => this.ingest(event));
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #applyEvent(normalized) {
    const store = this.#getEventStore(normalized.intentId);
    if (store.eventIds.has(normalized.eventId)) {
      return clone(this.#records.get(normalized.intentId) ?? createEmptyRecord(normalized.intentId));
    }

    insertEvent(store.events, normalized);
    store.eventIds.add(normalized.eventId);
    const next = rebuildRecord(normalized.intentId, store.events);

    this.#records.set(normalized.intentId, next);
    for (const listener of this.#listeners) {
      listener(clone(next), clone(normalized));
    }

    return clone(next);
  }

  #getEventStore(intentId) {
    const existing = this.#eventStores.get(intentId);
    if (existing) {
      return existing;
    }

    const created = {
      events: [],
      eventIds: new Set(),
    };
    this.#eventStores.set(intentId, created);
    return created;
  }
}

export class FileBackedStatusIndexer {
  #eventStores = new Map();
  #records = new Map();
  #listeners = new Set();
  #eventsPath;

  constructor({ eventsPath }) {
    this.#eventsPath = assertNonEmptyString("eventsPath", eventsPath);
    mkdirSync(dirname(this.#eventsPath), { recursive: true });

    if (existsSync(this.#eventsPath)) {
      const persisted = readFileSync(this.#eventsPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      for (const event of persisted) {
        this.#applyEvent(normalizeEvent(event), false);
      }
    }
  }

  ingest(event) {
    return this.#applyEvent(normalizeEvent(event), true);
  }

  getStatus(intentId) {
    const record = this.#records.get(intentId);
    return record ? clone(record) : null;
  }

  getTimeline(intentId) {
    const record = this.#records.get(intentId);
    return record ? clone(record.timeline) : [];
  }

  ingestBatch(events) {
    return events.map((event) => this.ingest(event));
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #applyEvent(normalized, persist) {
    const store = this.#getEventStore(normalized.intentId);
    if (store.eventIds.has(normalized.eventId)) {
      return clone(this.#records.get(normalized.intentId) ?? createEmptyRecord(normalized.intentId));
    }

    insertEvent(store.events, normalized);
    store.eventIds.add(normalized.eventId);
    const next = rebuildRecord(normalized.intentId, store.events);

    this.#records.set(normalized.intentId, next);
    if (persist) {
      appendFileSync(this.#eventsPath, `${JSON.stringify(toPlainObject(normalized))}\n`);
    }

    for (const listener of this.#listeners) {
      listener(clone(next), clone(normalized));
    }

    return clone(next);
  }

  #getEventStore(intentId) {
    const existing = this.#eventStores.get(intentId);
    if (existing) {
      return existing;
    }

    const created = {
      events: [],
      eventIds: new Set(),
    };
    this.#eventStores.set(intentId, created);
    return created;
  }
}

export function createIntentSubmittedEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.INTENT_SUBMITTED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
    quoteId: input.quoteId,
    owner: input.owner,
    sourceChain: input.sourceChain,
    destinationChain: input.destinationChain,
    actionType: input.actionType,
    asset: input.asset,
    amount: input.amount,
  };
}

export function createIntentDispatchedEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.INTENT_DISPATCHED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
    dispatchMode: input.dispatchMode,
    executionHash: input.executionHash,
  };
}

export function createDestinationExecutionStartedEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_STARTED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
  };
}

export function createDestinationExecutionSucceededEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_SUCCEEDED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
    resultAsset: input.resultAsset,
    resultAmount: input.resultAmount,
    destinationTxHash: input.destinationTxHash ?? null,
  };
}

export function createDestinationExecutionFailedEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_FAILED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
    reason: input.reason,
  };
}

export function createIntentCancelledEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.INTENT_CANCELLED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
  };
}

export function createRefundIssuedEvent(input) {
  return {
    type: INDEXER_EVENT_TYPES.REFUND_ISSUED,
    at: input.at,
    sequence: input.sequence,
    eventId: input.eventId,
    intentId: input.intentId,
    refundAsset: input.refundAsset,
    refundAmount: input.refundAmount,
  };
}

function createEmptyRecord(intentId) {
  return {
    intentId,
    status: null,
    quoteId: null,
    owner: null,
    sourceChain: null,
    destinationChain: null,
    actionType: null,
    asset: null,
    amount: null,
    executionHash: null,
    dispatchMode: null,
    result: null,
    refund: null,
    failureReason: null,
    timeline: [],
  };
}

function normalizeEvent(event) {
  const type = assertIncluded("event.type", event.type, Object.values(INDEXER_EVENT_TYPES));
  const at = assertInteger("event.at", event.at);
  const intentId = assertNonEmptyString("event.intentId", event.intentId);
  const sequence =
    event.sequence === undefined ? 0 : assertInteger("event.sequence", event.sequence);

  let normalized;
  switch (type) {
    case INDEXER_EVENT_TYPES.INTENT_SUBMITTED:
      normalized = {
        type,
        at,
        sequence,
        intentId,
        quoteId: assertNonEmptyString("event.quoteId", event.quoteId),
        owner: assertNonEmptyString("event.owner", event.owner),
        sourceChain: assertNonEmptyString("event.sourceChain", event.sourceChain),
        destinationChain: assertNonEmptyString("event.destinationChain", event.destinationChain),
        actionType: assertIncluded(
          "event.actionType",
          event.actionType,
          Object.values(ACTION_TYPES),
        ),
        asset: assertNonEmptyString("event.asset", event.asset),
        amount: toBigInt(event.amount, "event.amount"),
      };
      break;
    case INDEXER_EVENT_TYPES.INTENT_DISPATCHED:
      normalized = {
        type,
        at,
        sequence,
        intentId,
        dispatchMode: assertIncluded(
          "event.dispatchMode",
          event.dispatchMode,
          Object.values(DISPATCH_MODES),
        ),
        executionHash: assertNonEmptyString("event.executionHash", event.executionHash),
      };
      break;
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_STARTED:
      normalized = { type, at, sequence, intentId };
      break;
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_SUCCEEDED:
      normalized = {
        type,
        at,
        sequence,
        intentId,
        resultAsset: assertNonEmptyString("event.resultAsset", event.resultAsset),
        resultAmount: toBigInt(event.resultAmount, "event.resultAmount"),
        destinationTxHash: event.destinationTxHash,
      };
      break;
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_FAILED:
      normalized = {
        type,
        at,
        sequence,
        intentId,
        reason: assertNonEmptyString("event.reason", event.reason),
      };
      break;
    case INDEXER_EVENT_TYPES.INTENT_CANCELLED:
      normalized = { type, at, sequence, intentId };
      break;
    case INDEXER_EVENT_TYPES.REFUND_ISSUED:
      normalized = {
        type,
        at,
        sequence,
        intentId,
        refundAsset: assertNonEmptyString("event.refundAsset", event.refundAsset),
        refundAmount: toBigInt(event.refundAmount, "event.refundAmount"),
      };
      break;
    default:
      throw new Error(`unsupported event type: ${type}`);
  }

  return {
    ...normalized,
    eventId:
      event.eventId && event.eventId.trim() !== ""
        ? assertNonEmptyString("event.eventId", event.eventId)
        : deterministicId(normalized),
  };
}

function reduceRecord(current, event) {
  const next = {
    ...current,
    timeline: current.timeline.concat({
      eventId: event.eventId,
      type: event.type,
      at: event.at,
      sequence: event.sequence,
      details: extractDetails(event),
    }),
  };

  switch (event.type) {
    case INDEXER_EVENT_TYPES.INTENT_SUBMITTED:
      return {
        ...next,
        status: INTENT_STATUSES.SUBMITTED,
        quoteId: event.quoteId,
        owner: event.owner,
        sourceChain: event.sourceChain,
        destinationChain: event.destinationChain,
        actionType: event.actionType,
        asset: event.asset,
        amount: event.amount,
      };
    case INDEXER_EVENT_TYPES.INTENT_DISPATCHED:
      return {
        ...next,
        status: INTENT_STATUSES.DISPATCHED,
        dispatchMode: event.dispatchMode,
        executionHash: event.executionHash,
      };
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_STARTED:
      return {
        ...next,
        status: INTENT_STATUSES.EXECUTING,
      };
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_SUCCEEDED:
      return {
        ...next,
        status: INTENT_STATUSES.SETTLED,
        result: {
          asset: event.resultAsset,
          amount: event.resultAmount,
          destinationTxHash: event.destinationTxHash,
        },
        failureReason: null,
      };
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_FAILED:
      return {
        ...next,
        status: INTENT_STATUSES.FAILED,
        failureReason: event.reason,
      };
    case INDEXER_EVENT_TYPES.INTENT_CANCELLED:
      return {
        ...next,
        status: INTENT_STATUSES.CANCELLED,
      };
    case INDEXER_EVENT_TYPES.REFUND_ISSUED:
      return {
        ...next,
        refund: {
          asset: event.refundAsset,
          amount: event.refundAmount,
        },
      };
    default:
      return next;
  }
}

function extractDetails(event) {
  switch (event.type) {
    case INDEXER_EVENT_TYPES.INTENT_SUBMITTED:
      return {
        quoteId: event.quoteId,
        owner: event.owner,
        sourceChain: event.sourceChain,
        destinationChain: event.destinationChain,
        actionType: event.actionType,
        asset: event.asset,
        amount: event.amount,
      };
    case INDEXER_EVENT_TYPES.INTENT_DISPATCHED:
      return {
        dispatchMode: event.dispatchMode,
        executionHash: event.executionHash,
      };
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_SUCCEEDED:
      return {
        resultAsset: event.resultAsset,
        resultAmount: event.resultAmount,
        destinationTxHash: event.destinationTxHash,
      };
    case INDEXER_EVENT_TYPES.DESTINATION_EXECUTION_FAILED:
      return { reason: event.reason };
    case INDEXER_EVENT_TYPES.REFUND_ISSUED:
      return {
        refundAsset: event.refundAsset,
        refundAmount: event.refundAmount,
      };
    default:
      return {};
  }
}

function clone(value) {
  return structuredClone(value);
}

function rebuildRecord(intentId, events) {
  return events.reduce(reduceRecord, createEmptyRecord(intentId));
}

function insertEvent(events, event) {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareEvents(event, events[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  events.splice(low, 0, event);
}

function compareEvents(left, right) {
  if (left.at !== right.at) {
    return left.at - right.at;
  }

  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  if (left.type !== right.type) {
    return left.type.localeCompare(right.type);
  }

  return left.eventId.localeCompare(right.eventId);
}
