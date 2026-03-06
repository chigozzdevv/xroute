import { readFileSync } from "node:fs";

import { ACTION_TYPES, DISPATCH_MODES } from "../xroute-types/index.mjs";
import {
  assertHexString,
  assertIncluded,
  assertNonEmptyString,
} from "../xroute-types/index.mjs";

export const XCM_PRECOMPILE_ADDRESS = "0x00000000000000000000000000000000000a0000";
export const DESTINATION_ADAPTER_TARGET_KINDS = Object.freeze({
  EVM_CONTRACT: "evm-contract",
});

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

const RAW_DESTINATION_ADAPTER_SPECS = readFileSync(
  new URL("./destination-adapter-specs.txt", import.meta.url),
  "utf8",
);

export const DESTINATION_ADAPTER_SPECS = Object.freeze(parseDestinationAdapterSpecs());

export function getDestinationAdapterSpec(adapterId) {
  const normalized = assertNonEmptyString("adapterId", adapterId);
  const spec = DESTINATION_ADAPTER_SPECS[normalized];
  if (!spec) {
    throw new Error(`unsupported destination adapter: ${normalized}`);
  }

  return spec;
}

function parseDestinationAdapterSpecs() {
  const entries = RAW_DESTINATION_ADAPTER_SPECS.split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [adapterId, targetKind, implementationContract, signature, selector, extra] =
        line.split("|");
      if (!adapterId || !targetKind || !implementationContract || !signature || !selector || extra) {
        throw new Error(`invalid destination adapter spec line: ${line}`);
      }

      return [
        assertNonEmptyString("adapterId", adapterId),
        Object.freeze({
          id: assertNonEmptyString("adapterId", adapterId),
          targetKind: assertIncluded(
            "targetKind",
            targetKind,
            Object.values(DESTINATION_ADAPTER_TARGET_KINDS),
          ),
          implementationContract: assertNonEmptyString(
            "implementationContract",
            implementationContract,
          ),
          signature: assertNonEmptyString("signature", signature),
          selector: normalizeSelector(selector),
        }),
      ];
    });

  return Object.fromEntries(entries);
}

function normalizeSelector(selector) {
  const normalized = assertHexString("selector", selector);
  if (normalized.length !== 10) {
    throw new Error("selector must be a 4-byte 0x-prefixed hex string");
  }

  return normalized;
}
