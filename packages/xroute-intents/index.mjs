import {
  ACTION_TYPES,
  EXECUTION_TYPES,
  RUNTIME_CALL_ORIGIN_KINDS,
  assertAddress,
  assertInteger,
  assertIncluded,
  assertHexString,
  assertNonEmptyString,
  assertPositiveBigInt,
  deterministicId,
  toPlainObject,
} from "../xroute-types/index.mjs";
import {
  assertExecuteRoute,
  assertSwapRoute,
  assertTransferRoute,
  getChain,
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

export function createExecuteIntent(input) {
  return createIntent({
    ...input,
    action: {
      type: ACTION_TYPES.EXECUTE,
      params: input.action?.params ?? input.params,
    },
  });
}

export function createIntent(input) {
  const sourceChain = getChain(input.sourceChain).key;
  const destinationChain = getChain(input.destinationChain).key;
  const refundAddress = assertAddress("refundAddress", input.refundAddress);
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
    case ACTION_TYPES.EXECUTE:
      return normalizeExecute(sourceChain, destinationChain, params);
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
  const settlementChain = params.settlementChain
    ? getChain(params.settlementChain).key
    : destinationChain;
  assertSwapRoute(sourceChain, destinationChain, assetIn, assetOut, settlementChain);

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
      settlementChain,
      recipient: assertNonEmptyString("action.params.recipient", params.recipient),
    }),
  });
}

function normalizeExecute(sourceChain, destinationChain, params) {
  const executionType = assertIncluded(
    "action.params.executionType",
    params.executionType,
    Object.values(EXECUTION_TYPES),
  );

  switch (executionType) {
    case EXECUTION_TYPES.RUNTIME_CALL:
      return normalizeRuntimeCall(sourceChain, destinationChain, params);
    default:
      throw new Error(`unsupported execution type: ${executionType}`);
  }
}

function normalizeRuntimeCall(sourceChain, destinationChain, params) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  assertExecuteRoute(sourceChain, destinationChain, asset);

  const originKind = params.originKind
    ? assertIncluded(
        "action.params.originKind",
        params.originKind,
        Object.values(RUNTIME_CALL_ORIGIN_KINDS),
      )
    : RUNTIME_CALL_ORIGIN_KINDS.SOVEREIGN_ACCOUNT;

  return Object.freeze({
    type: ACTION_TYPES.EXECUTE,
    params: Object.freeze({
      executionType: EXECUTION_TYPES.RUNTIME_CALL,
      asset,
      maxPaymentAmount: assertPositiveBigInt(
        "action.params.maxPaymentAmount",
        params.maxPaymentAmount,
      ),
      callData: assertHexString("action.params.callData", params.callData),
      originKind,
      fallbackWeight: Object.freeze({
        refTime: assertInteger(
          "action.params.fallbackWeight.refTime",
          params.fallbackWeight?.refTime,
        ),
        proofSize: assertInteger(
          "action.params.fallbackWeight.proofSize",
          params.fallbackWeight?.proofSize,
        ),
      }),
    }),
  });
}
