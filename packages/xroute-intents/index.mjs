import { AccountId } from "@polkadot-api/substrate-bindings";

import {
  ACTION_TYPES,
  EXECUTION_TYPES,
  RUNTIME_CALL_ORIGIN_KINDS,
  VTOKEN_ORDER_OPERATIONS,
  assertAddress,
  assertBytes32Hex,
  assertInteger,
  assertIncluded,
  assertHexString,
  assertNonEmptyString,
  assertPositiveBigInt,
  deterministicId,
  toBigInt,
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
    case EXECUTION_TYPES.EVM_CONTRACT_CALL:
      return normalizeEvmContractCall(sourceChain, destinationChain, params);
    case EXECUTION_TYPES.VTOKEN_ORDER:
      return normalizeVtokenOrder(sourceChain, destinationChain, params);
    default:
      throw new Error(`unsupported execution type: ${executionType}`);
  }
}

function normalizeRuntimeCall(sourceChain, destinationChain, params) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  assertExecuteRoute(
    sourceChain,
    destinationChain,
    asset,
    EXECUTION_TYPES.RUNTIME_CALL,
  );

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

function normalizeEvmContractCall(sourceChain, destinationChain, params) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  assertExecuteRoute(
    sourceChain,
    destinationChain,
    asset,
    EXECUTION_TYPES.EVM_CONTRACT_CALL,
  );

  return Object.freeze({
    type: ACTION_TYPES.EXECUTE,
    params: Object.freeze({
      executionType: EXECUTION_TYPES.EVM_CONTRACT_CALL,
      asset,
      maxPaymentAmount: assertPositiveBigInt(
        "action.params.maxPaymentAmount",
        params.maxPaymentAmount,
      ),
      contractAddress: assertAddress(
        "action.params.contractAddress",
        params.contractAddress,
      ),
      calldata: assertHexString("action.params.calldata", params.calldata),
      value: params.value === undefined ? 0n : assertPositiveOrZeroBigInt("action.params.value", params.value),
      gasLimit: assertPositiveBigInt("action.params.gasLimit", params.gasLimit),
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

function normalizeVtokenOrder(sourceChain, destinationChain, params) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  const operation = assertIncluded(
    "action.params.operation",
    params.operation,
    Object.values(VTOKEN_ORDER_OPERATIONS),
  );
  assertValidVtokenOrderAsset(asset, operation);
  assertExecuteRoute(
    sourceChain,
    destinationChain,
    asset,
    EXECUTION_TYPES.VTOKEN_ORDER,
  );
  const recipient = assertNonEmptyString("action.params.recipient", params.recipient);

  return Object.freeze({
    type: ACTION_TYPES.EXECUTE,
    params: Object.freeze({
      executionType: EXECUTION_TYPES.VTOKEN_ORDER,
      asset,
      amount: assertPositiveBigInt("action.params.amount", params.amount),
      maxPaymentAmount: assertPositiveBigInt(
        "action.params.maxPaymentAmount",
        params.maxPaymentAmount,
      ),
      operation,
      recipient,
      recipientAccountIdHex: encodeAccountIdHex(
        "action.params.recipient",
        recipient,
      ),
      channelId:
        params.channelId === undefined
          ? 0
          : assertInteger("action.params.channelId", params.channelId),
      remark: normalizeRemark(params.remark),
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

function encodeAccountIdHex(name, value) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
    return assertBytes32Hex(name, value);
  }

  try {
    return `0x${Buffer.from(AccountId().enc(value)).toString("hex")}`;
  } catch {
    throw new Error(`${name} must be a valid SS58 or 32-byte hex account id`);
  }
}

function assertPositiveOrZeroBigInt(name, value) {
  const normalized = toBigInt(value, name);
  if (normalized < 0n) {
    throw new Error(`${name} must be zero or greater`);
  }

  return normalized;
}

function normalizeRemark(value) {
  if (value === undefined) {
    return "";
  }

  const normalized = String(value);
  if (Buffer.byteLength(normalized, "utf8") > 32) {
    throw new Error("action.params.remark must be at most 32 bytes");
  }

  return normalized;
}

function assertValidVtokenOrderAsset(asset, operation) {
  if (operation === VTOKEN_ORDER_OPERATIONS.MINT && asset !== "DOT") {
    throw new Error("action.params.asset must be DOT for vtoken-order mint");
  }
  if (operation === VTOKEN_ORDER_OPERATIONS.REDEEM && asset !== "VDOT") {
    throw new Error("action.params.asset must be VDOT for vtoken-order redeem");
  }
}
