import { INDEXER_EVENT_TYPES } from "../../xroute-types/index.mjs";

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
