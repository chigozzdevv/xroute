import test from "node:test";
import assert from "node:assert/strict";

import { createExecuteIntent } from "../../../packages/xroute-intents/index.mjs";
import {
  assertIntentAllowedByExecutionPolicy,
  normalizeExecutionPolicy,
} from "../execution-policy.mjs";

const refundAddress = "0x1111111111111111111111111111111111111111";

test("execution policy allows allowlisted moonbeam selectors", () => {
  const policy = normalizeExecutionPolicy({
    moonbeam: {
      evmContractCall: {
        allowedContracts: [
          {
            address: "0x2222222222222222222222222222222222222222",
            selectors: ["0xdeadbeef"],
            maxValue: "0",
            maxGasLimit: "300000",
            maxPaymentAmount: "200000000",
          },
        ],
      },
    },
  });

  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "110000000",
      contractAddress: "0x2222222222222222222222222222222222222222",
      calldata: "0xdeadbeef00000000",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  });

  assert.doesNotThrow(() => {
    assertIntentAllowedByExecutionPolicy(intent, policy);
  });
});

test("execution policy rejects disallowed moonbeam selectors", () => {
  const policy = normalizeExecutionPolicy({
    moonbeam: {
      evmContractCall: {
        allowedContracts: [
          {
            address: "0x2222222222222222222222222222222222222222",
            selectors: ["0xdeadbeef"],
            maxValue: "0",
            maxGasLimit: "300000",
            maxPaymentAmount: "200000000",
          },
        ],
      },
    },
  });

  const intent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "110000000",
      contractAddress: "0x2222222222222222222222222222222222222222",
      calldata: "0xaaaaaaaa00000000",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  });

  assert.throws(() => {
    assertIntentAllowedByExecutionPolicy(intent, policy);
  }, /not allowlisted/);
});

test("execution policy rejects moonbeam gas and payment amounts above configured caps", () => {
  const policy = normalizeExecutionPolicy({
    moonbeam: {
      evmContractCall: {
        allowedContracts: [
          {
            address: "0x2222222222222222222222222222222222222222",
            selectors: ["0xdeadbeef"],
            maxValue: "0",
            maxGasLimit: "200000",
            maxPaymentAmount: "100000000",
          },
        ],
      },
    },
  });

  const gasIntent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "100000000",
      contractAddress: "0x2222222222222222222222222222222222222222",
      calldata: "0xdeadbeef00000000",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  });

  const paymentIntent = createExecuteIntent({
    sourceChain: "polkadot-hub",
    destinationChain: "moonbeam",
    refundAddress,
    deadline: 1_773_185_200,
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "110000000",
      contractAddress: "0x2222222222222222222222222222222222222222",
      calldata: "0xdeadbeef00000000",
      value: "0",
      gasLimit: "200000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  });

  assert.throws(() => {
    assertIntentAllowedByExecutionPolicy(gasIntent, policy);
  }, /maxGasLimit/);

  assert.throws(() => {
    assertIntentAllowedByExecutionPolicy(paymentIntent, policy);
  }, /maxPaymentAmount/);
});
