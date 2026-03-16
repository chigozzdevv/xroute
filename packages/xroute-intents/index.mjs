import {
  ACTION_TYPES,
  EXECUTION_TYPES,
  assertAddress,
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
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../xroute-precompile-interfaces/index.mjs";

const DEFAULT_CALL_VALUE = 0n;
const DEFAULT_CALL_GAS_LIMIT = 250000n;
const DEFAULT_CALL_FALLBACK_WEIGHT = Object.freeze({
  refTime: 650000000,
  proofSize: 12288,
});
const DEFAULT_VDOT_ORDER_GAS_LIMIT = 500000n;
const DEFAULT_VDOT_ORDER_REMARK = "xroute";
const DEFAULT_VDOT_ORDER_CHANNEL_ID = 0;
const EVM_SOURCE_CHAINS = new Set(["moonbeam"]);

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
  const deploymentProfile = normalizeDeploymentProfile(
    input.deploymentProfile ?? DEFAULT_DEPLOYMENT_PROFILE,
  );
  const sourceChain = getChain(input.sourceChain, deploymentProfile).key;
  const destinationChain = getChain(input.destinationChain, deploymentProfile).key;
  const refundAddress = resolveRefundAddress(input, sourceChain);
  const deadline = assertInteger("deadline", input.deadline);
  const actionType = assertIncluded(
    "action.type",
    input.action?.type,
    Object.values(ACTION_TYPES),
  );

  const action = normalizeAction(
    actionType,
    sourceChain,
    destinationChain,
    input.action.params,
    deploymentProfile,
  );
  const canonical = {
    deploymentProfile,
    sourceChain,
    destinationChain,
    refundAddress,
    deadline,
    action: toPlainObject(action),
  };

  return Object.freeze({
    quoteId: deterministicId(canonical),
    deploymentProfile,
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
    deploymentProfile: intent.deploymentProfile,
    sourceChain: intent.sourceChain,
    destinationChain: intent.destinationChain,
    refundAddress: intent.refundAddress,
    deadline: intent.deadline,
    action: intent.action,
  });
}

function normalizeAction(actionType, sourceChain, destinationChain, params, deploymentProfile) {
  switch (actionType) {
    case ACTION_TYPES.TRANSFER:
      return normalizeTransfer(sourceChain, destinationChain, params, deploymentProfile);
    case ACTION_TYPES.SWAP:
      return normalizeSwap(sourceChain, destinationChain, params, deploymentProfile);
    case ACTION_TYPES.EXECUTE:
      return normalizeExecute(sourceChain, destinationChain, params, deploymentProfile);
    default:
      throw new Error(`unsupported action type: ${actionType}`);
  }
}

function normalizeTransfer(sourceChain, destinationChain, params, deploymentProfile) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  assertTransferRoute(sourceChain, destinationChain, asset, deploymentProfile);

  return Object.freeze({
    type: ACTION_TYPES.TRANSFER,
    params: Object.freeze({
      asset,
      amount: assertPositiveBigInt("action.params.amount", params.amount),
      recipient: assertNonEmptyString("action.params.recipient", params.recipient),
    }),
  });
}

function normalizeSwap(sourceChain, destinationChain, params, deploymentProfile) {
  const assetIn = assertNonEmptyString("action.params.assetIn", params.assetIn).toUpperCase();
  const assetOut = assertNonEmptyString("action.params.assetOut", params.assetOut).toUpperCase();
  const settlementChain = params.settlementChain
    ? getChain(params.settlementChain, deploymentProfile).key
    : destinationChain;
  assertSwapRoute(
    sourceChain,
    destinationChain,
    assetIn,
    assetOut,
    settlementChain,
    deploymentProfile,
  );

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

function normalizeExecute(sourceChain, destinationChain, params, deploymentProfile) {
  const executionType = assertIncluded(
    "action.params.executionType",
    params.executionType,
    Object.values(EXECUTION_TYPES),
  );

  switch (executionType) {
    case EXECUTION_TYPES.CALL:
      return normalizeCall(sourceChain, destinationChain, params, deploymentProfile);
    case EXECUTION_TYPES.MINT_VDOT:
      return normalizeVdotOrder(
        sourceChain,
        destinationChain,
        params,
        deploymentProfile,
        EXECUTION_TYPES.MINT_VDOT,
      );
    case EXECUTION_TYPES.REDEEM_VDOT:
      return normalizeVdotOrder(
        sourceChain,
        destinationChain,
        params,
        deploymentProfile,
        EXECUTION_TYPES.REDEEM_VDOT,
      );
    default:
      throw new Error(`unsupported execution type: ${executionType}`);
  }
}

function normalizeCall(sourceChain, destinationChain, params, deploymentProfile) {
  const asset = assertNonEmptyString("action.params.asset", params.asset).toUpperCase();
  assertExecuteRoute(
    sourceChain,
    destinationChain,
    asset,
    EXECUTION_TYPES.CALL,
    deploymentProfile,
  );

  return Object.freeze({
    type: ACTION_TYPES.EXECUTE,
    params: Object.freeze({
      executionType: EXECUTION_TYPES.CALL,
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
      value:
        params.value === undefined
          ? DEFAULT_CALL_VALUE
          : assertPositiveOrZeroBigInt("action.params.value", params.value),
      gasLimit:
        params.gasLimit === undefined
          ? DEFAULT_CALL_GAS_LIMIT
          : assertPositiveBigInt("action.params.gasLimit", params.gasLimit),
      fallbackWeight: Object.freeze({
        refTime:
          params.fallbackWeight?.refTime === undefined
            ? DEFAULT_CALL_FALLBACK_WEIGHT.refTime
            : assertInteger(
                "action.params.fallbackWeight.refTime",
                params.fallbackWeight?.refTime,
              ),
        proofSize:
          params.fallbackWeight?.proofSize === undefined
            ? DEFAULT_CALL_FALLBACK_WEIGHT.proofSize
            : assertInteger(
                "action.params.fallbackWeight.proofSize",
                params.fallbackWeight?.proofSize,
              ),
      }),
    }),
  });
}

function normalizeVdotOrder(
  sourceChain,
  destinationChain,
  params,
  deploymentProfile,
  executionType,
) {
  const inputAsset =
    executionType === EXECUTION_TYPES.MINT_VDOT ? "DOT" : "VDOT";
  assertExecuteRoute(
    sourceChain,
    destinationChain,
    inputAsset,
    executionType,
    deploymentProfile,
  );

  return Object.freeze({
    type: ACTION_TYPES.EXECUTE,
    params: Object.freeze({
      executionType,
      amount: assertPositiveBigInt("action.params.amount", params.amount),
      maxPaymentAmount: assertPositiveBigInt(
        "action.params.maxPaymentAmount",
        params.maxPaymentAmount,
      ),
      recipient: assertAddress("action.params.recipient", params.recipient),
      adapterAddress: assertAddress(
        "action.params.adapterAddress",
        params.adapterAddress,
      ),
      gasLimit:
        params.gasLimit === undefined
          ? DEFAULT_VDOT_ORDER_GAS_LIMIT
          : assertPositiveBigInt("action.params.gasLimit", params.gasLimit),
      fallbackWeight: Object.freeze({
        refTime:
          params.fallbackWeight?.refTime === undefined
            ? DEFAULT_CALL_FALLBACK_WEIGHT.refTime
            : assertInteger(
                "action.params.fallbackWeight.refTime",
                params.fallbackWeight?.refTime,
              ),
        proofSize:
          params.fallbackWeight?.proofSize === undefined
            ? DEFAULT_CALL_FALLBACK_WEIGHT.proofSize
            : assertInteger(
                "action.params.fallbackWeight.proofSize",
                params.fallbackWeight?.proofSize,
              ),
      }),
      remark:
        params.remark === undefined
          ? DEFAULT_VDOT_ORDER_REMARK
          : assertRemark("action.params.remark", params.remark),
      channelId:
        params.channelId === undefined
          ? DEFAULT_VDOT_ORDER_CHANNEL_ID
          : assertPositiveOrZeroInteger("action.params.channelId", params.channelId),
    }),
  });
}

function assertPositiveOrZeroBigInt(name, value) {
  const normalized = toBigInt(value, name);
  if (normalized < 0n) {
    throw new Error(`${name} must be zero or greater`);
  }

  return normalized;
}

function assertPositiveOrZeroInteger(name, value) {
  const normalized = assertInteger(name, value);
  if (normalized < 0) {
    throw new Error(`${name} must be zero or greater`);
  }

  return normalized;
}

function assertRemark(name, value) {
  const normalized = assertNonEmptyString(name, value);
  if (normalized.length > 32) {
    throw new Error(`${name} must be 32 characters or fewer`);
  }

  return normalized;
}

function resolveRefundAddress(input, sourceChain) {
  const value = input.refundAddress ?? input.senderAddress ?? input.ownerAddress;
  if (EVM_SOURCE_CHAINS.has(sourceChain)) {
    return assertAddress("refundAddress", value);
  }

  return assertNonEmptyString("refundAddress", value);
}
