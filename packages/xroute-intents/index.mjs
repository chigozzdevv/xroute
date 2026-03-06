import {
  ACTION_TYPES,
  assertInteger,
  assertNonEmptyString,
  assertPositiveBigInt,
  assertIncluded,
  deterministicId,
  toPlainObject,
} from "../xroute-types/index.mjs";
import {
  assertSwapRoute,
  assertTransferRoute,
  getChain,
  getRoute,
} from "../xroute-chain-registry/index.mjs";

export function createTransferIntent(input) {
  return createIntent({
    ...input,
    action: {
      type: ACTION_TYPES.TRANSFER,
      params: input.action?.params ?? input.params,
    },
  });
}

export function createSwapIntent(input) {
  return createIntent({
    ...input,
    action: {
      type: ACTION_TYPES.SWAP,
      params: input.action?.params ?? input.params,
    },
  });
}

export function createStakeIntent(input) {
  return createIntent({
    ...input,
    action: {
      type: ACTION_TYPES.STAKE,
      params: input.action?.params ?? input.params,
    },
  });
}

export function createCallIntent(input) {
  return createIntent({
    ...input,
    action: {
      type: ACTION_TYPES.CALL,
      params: input.action?.params ?? input.params,
    },
  });
}

export function createIntent(input) {
  const sourceChain = getChain(input.sourceChain).key;
  const destinationChain = getChain(input.destinationChain).key;
  const refundAddress = assertNonEmptyString("refundAddress", input.refundAddress);
  const deadline = assertInteger("deadline", input.deadline);
  const actionType = assertIncluded(
    "action.type",
    input.action?.type,
    Object.values(ACTION_TYPES),
  );

  const action = normalizeAction(actionType, sourceChain, destinationChain, input.action.params);
  const canonical = {
    sourceChain,
    destinationChain,
    refundAddress,
    deadline,
    action: toPlainObject(action),
  };

  return Object.freeze({
    quoteId: deterministicId(canonical),
    sourceChain,
    destinationChain,
    refundAddress,
    deadline,
    action,
  });
}

export function validateIntent(intent) {
  return createIntent(intent);
}

export function toPlainIntent(intent) {
  return toPlainObject({
    quoteId: intent.quoteId,
    sourceChain: intent.sourceChain,
    destinationChain: intent.destinationChain,
    refundAddress: intent.refundAddress,
    deadline: intent.deadline,
    action: intent.action,
  });
}

function normalizeAction(actionType, sourceChain, destinationChain, params) {
  switch (actionType) {
    case ACTION_TYPES.TRANSFER:
      return normalizeTransfer(sourceChain, destinationChain, params);
    case ACTION_TYPES.SWAP:
      return normalizeSwap(sourceChain, destinationChain, params);
    case ACTION_TYPES.STAKE:
      return normalizeStake(sourceChain, destinationChain, params);
    case ACTION_TYPES.CALL:
      return normalizeCall(sourceChain, destinationChain, params);
    default:
      throw new Error(`unsupported action type: ${actionType}`);
  }
}

function normalizeTransfer(sourceChain, destinationChain, params) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  assertTransferRoute(sourceChain, destinationChain, asset);

  return Object.freeze({
    type: ACTION_TYPES.TRANSFER,
    params: Object.freeze({
      asset,
      amount: assertPositiveBigInt("action.params.amount", params.amount),
      recipient: assertNonEmptyString("action.params.recipient", params.recipient),
    }),
  });
}

function normalizeSwap(sourceChain, destinationChain, params) {
  const assetIn = assertNonEmptyString("action.params.assetIn", params.assetIn).toUpperCase();
  const assetOut = assertNonEmptyString("action.params.assetOut", params.assetOut).toUpperCase();
  assertSwapRoute(sourceChain, destinationChain, assetIn, assetOut);

  const minAmountOut = assertPositiveBigInt(
    "action.params.minAmountOut",
    params.minAmountOut,
  );

  return Object.freeze({
    type: ACTION_TYPES.SWAP,
    params: Object.freeze({
      assetIn,
      assetOut,
      amountIn: assertPositiveBigInt("action.params.amountIn", params.amountIn),
      minAmountOut,
      recipient: assertNonEmptyString("action.params.recipient", params.recipient),
    }),
  });
}

function normalizeStake(sourceChain, destinationChain, params) {
  const route = getRoute(sourceChain, destinationChain);
  if (!route.actions.includes(ACTION_TYPES.STAKE)) {
    throw new Error(`stake is not supported on ${sourceChain} -> ${destinationChain}`);
  }

  return Object.freeze({
    type: ACTION_TYPES.STAKE,
    params: Object.freeze({
      asset: assertNonEmptyString("action.params.asset", params.asset).toUpperCase(),
      amount: assertPositiveBigInt("action.params.amount", params.amount),
      validator: assertNonEmptyString("action.params.validator", params.validator),
      recipient: assertNonEmptyString("action.params.recipient", params.recipient),
    }),
  });
}

function normalizeCall(sourceChain, destinationChain, params) {
  const route = getRoute(sourceChain, destinationChain);
  if (!route.actions.includes(ACTION_TYPES.CALL)) {
    throw new Error(`call is not supported on ${sourceChain} -> ${destinationChain}`);
  }

  return Object.freeze({
    type: ACTION_TYPES.CALL,
    params: Object.freeze({
      asset: assertNonEmptyString("action.params.asset", params.asset).toUpperCase(),
      amount: assertPositiveBigInt("action.params.amount", params.amount),
      target: assertNonEmptyString("action.params.target", params.target),
      calldata: assertNonEmptyString("action.params.calldata", params.calldata),
    }),
  });
}
