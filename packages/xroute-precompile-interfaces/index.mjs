import { ACTION_TYPES, DISPATCH_MODES } from "../xroute-types/index.mjs";

export const XCM_PRECOMPILE_ADDRESS = "0x00000000000000000000000000000000000a0000";

export const PRECOMPILE_METADATA = Object.freeze({
  xcm: Object.freeze({
    address: XCM_PRECOMPILE_ADDRESS,
    functions: Object.freeze(["execute(bytes,(uint64,uint64))", "send(bytes,bytes)", "weighMessage(bytes)"]),
  }),
});

export const ACTION_TO_CONTRACT_ENUM = Object.freeze({
  [ACTION_TYPES.TRANSFER]: 0,
  [ACTION_TYPES.SWAP]: 1,
  [ACTION_TYPES.STAKE]: 2,
  [ACTION_TYPES.CALL]: 3,
});

export const DISPATCH_MODE_TO_CONTRACT_ENUM = Object.freeze({
  [DISPATCH_MODES.EXECUTE]: 0,
  [DISPATCH_MODES.SEND]: 1,
});
