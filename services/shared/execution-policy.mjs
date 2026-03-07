import { readFileSync } from "node:fs";

import { ACTION_TYPES, EXECUTION_TYPES, assertAddress, assertHexString } from "../../packages/xroute-types/index.mjs";

export function loadExecutionPolicyFromFile(path) {
  return normalizeExecutionPolicy(JSON.parse(readFileSync(path, "utf8")));
}

export function normalizeExecutionPolicy(policy) {
  if (!policy) {
    return null;
  }

  const moonbeamEntries = policy?.moonbeam?.evmContractCall?.allowedContracts ?? [];
  const allowedContracts = new Map();

  for (const entry of moonbeamEntries) {
    const address = assertAddress("moonbeam.evmContractCall.allowedContracts[].address", entry.address);
    const selectors = (entry.selectors ?? []).map((selector) =>
      normalizeSelector(selector, "moonbeam.evmContractCall.allowedContracts[].selectors[]"),
    );
    if (selectors.length === 0) {
      throw new Error(`moonbeam policy for ${address} must declare at least one selector`);
    }

    allowedContracts.set(address, Object.freeze({
      address,
      selectors: Object.freeze(selectors),
      maxValue: entry.maxValue === undefined ? null : BigInt(String(entry.maxValue)),
      maxGasLimit:
        entry.maxGasLimit === undefined ? null : BigInt(String(entry.maxGasLimit)),
      maxPaymentAmount:
        entry.maxPaymentAmount === undefined
          ? null
          : BigInt(String(entry.maxPaymentAmount)),
      note: entry.note ?? null,
    }));
  }

  return Object.freeze({
    moonbeam: Object.freeze({
      evmContractCall: Object.freeze({
        allowedContracts,
      }),
    }),
  });
}

export function summarizeExecutionPolicy(policy) {
  if (!policy) {
    return Object.freeze({
      moonbeamEvmContracts: 0,
    });
  }

  return Object.freeze({
    moonbeamEvmContracts: policy.moonbeam.evmContractCall.allowedContracts.size,
  });
}

export function assertIntentAllowedByExecutionPolicy(intent, policy) {
  if (!policy || intent?.action?.type !== ACTION_TYPES.EXECUTE) {
    return;
  }

  const params = intent.action.params;
  if (params.executionType !== EXECUTION_TYPES.EVM_CONTRACT_CALL) {
    return;
  }

  const entry = policy.moonbeam.evmContractCall.allowedContracts.get(
    assertAddress("action.params.contractAddress", params.contractAddress),
  );
  if (!entry) {
    throw new Error(`moonbeam contract ${params.contractAddress} is not allowlisted`);
  }

  const selector = normalizeSelector(params.calldata.slice(0, 10), "action.params.calldata");
  if (!entry.selectors.includes(selector)) {
    throw new Error(
      `selector ${selector} is not allowlisted for moonbeam contract ${params.contractAddress}`,
    );
  }

  if (entry.maxValue !== null && BigInt(params.value) > entry.maxValue) {
    throw new Error(
      `value ${params.value} exceeds the configured maxValue for moonbeam contract ${params.contractAddress}`,
    );
  }

  if (entry.maxGasLimit !== null && BigInt(params.gasLimit) > entry.maxGasLimit) {
    throw new Error(
      `gasLimit ${params.gasLimit} exceeds the configured maxGasLimit for moonbeam contract ${params.contractAddress}`,
    );
  }

  if (
    entry.maxPaymentAmount !== null &&
    BigInt(params.maxPaymentAmount) > entry.maxPaymentAmount
  ) {
    throw new Error(
      `maxPaymentAmount ${params.maxPaymentAmount} exceeds the configured maxPaymentAmount for moonbeam contract ${params.contractAddress}`,
    );
  }
}

function normalizeSelector(value, name) {
  const normalized = assertHexString(name, value);
  if (normalized.length !== 10) {
    throw new Error(`${name} must be a 4-byte selector`);
  }

  return normalized;
}
