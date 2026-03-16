import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createIntent } from "../../xroute-intents/index.mjs";
import {
  ACTION_TYPES,
  EXECUTION_TYPES,
} from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../xroute-precompile-interfaces/index.mjs";

const execFileAsync = promisify(execFile);
let serializedCommandQueue = Promise.resolve();

export function createRouteEngineQuoteProvider({
  command = "cargo",
  commandArgs = ["run", "-q", "-p", "route-engine", "--"],
  cwd,
  env,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
  serializeCommands = command === "cargo",
} = {}) {
  const normalizedDeploymentProfile = normalizeDeploymentProfile(deploymentProfile);

  return {
    deploymentProfile: normalizedDeploymentProfile,
    async quote(intentInput) {
      const intent = intentInput.quoteId
        ? intentInput
        : createIntent({
            ...intentInput,
            deploymentProfile:
              intentInput.deploymentProfile ?? normalizedDeploymentProfile,
          });
      const args = commandArgs.concat(
        buildRouteEngineQuoteArgs(intent, normalizedDeploymentProfile),
      );

      try {
        const { stdout } = await execSerializedCommand({
          command,
          args,
          cwd,
          env,
          serializeCommands,
        });
        return {
          ...JSON.parse(stdout),
          quoteId: intent.quoteId,
        };
      } catch (error) {
        const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
        throw new Error(`route engine quote failed: ${detail}`);
      }
    },
  };
}

function buildRouteEngineQuoteArgs(
  intent,
  deploymentProfile = DEFAULT_DEPLOYMENT_PROFILE,
) {
  const shared = [
    "quote",
    "--source-chain",
    intent.sourceChain,
    "--destination-chain",
    intent.destinationChain,
    "--refund-address",
    intent.refundAddress,
    "--deadline",
    String(intent.deadline),
    "--deployment-profile",
    normalizeDeploymentProfile(deploymentProfile),
    "--action",
    intent.action.type,
  ];

  switch (intent.action.type) {
    case ACTION_TYPES.TRANSFER:
      return shared.concat([
        "--asset",
        intent.action.params.asset,
        "--amount",
        intent.action.params.amount.toString(),
        "--recipient",
        intent.action.params.recipient,
      ]);
    case ACTION_TYPES.SWAP:
      return shared.concat([
        "--asset-in",
        intent.action.params.assetIn,
        "--asset-out",
        intent.action.params.assetOut,
        "--amount-in",
        intent.action.params.amountIn.toString(),
        "--min-amount-out",
        intent.action.params.minAmountOut.toString(),
        "--recipient",
        intent.action.params.recipient,
        "--settlement-chain",
        intent.action.params.settlementChain,
      ]);
    case ACTION_TYPES.EXECUTE:
      return buildExecuteQuoteArgs(shared, intent.action.params);
    default:
      throw new Error(`unsupported action type: ${intent.action.type}`);
  }
}

function buildExecuteQuoteArgs(shared, params) {
  switch (params.executionType) {
    case EXECUTION_TYPES.CALL:
      return shared.concat([
        "--execution-type",
        params.executionType,
        "--asset",
        params.asset,
        "--max-payment-amount",
        params.maxPaymentAmount.toString(),
        "--contract-address",
        params.contractAddress,
        "--calldata",
        params.calldata,
        "--value",
        params.value.toString(),
        "--gas-limit",
        params.gasLimit.toString(),
        "--fallback-ref-time",
        String(params.fallbackWeight.refTime),
        "--fallback-proof-size",
        String(params.fallbackWeight.proofSize),
      ]);
    case EXECUTION_TYPES.MINT_VDOT:
    case EXECUTION_TYPES.REDEEM_VDOT:
      return shared.concat([
        "--execution-type",
        params.executionType,
        "--amount",
        params.amount.toString(),
        "--max-payment-amount",
        params.maxPaymentAmount.toString(),
        "--recipient",
        params.recipient,
        "--adapter-address",
        params.adapterAddress,
        "--gas-limit",
        params.gasLimit.toString(),
        "--fallback-ref-time",
        String(params.fallbackWeight.refTime),
        "--fallback-proof-size",
        String(params.fallbackWeight.proofSize),
        "--remark",
        params.remark,
        "--channel-id",
        String(params.channelId),
      ]);
    default:
      throw new Error(`unsupported execution type: ${params.executionType}`);
  }
}

function execSerializedCommand({
  command,
  args,
  cwd,
  env,
  serializeCommands,
}) {
  const invoke = () =>
    execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 1024 * 1024,
    });

  if (!serializeCommands) {
    return invoke();
  }

  const queued = serializedCommandQueue.then(invoke);
  serializedCommandQueue = queued.catch(() => {});
  return queued;
}
