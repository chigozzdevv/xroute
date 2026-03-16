import {
  getAsset,
  getChain,
  listAssets,
  listChains,
  getParachainId,
  getAssetLocation,
  findTransferPath,
  assertSupportedDeploymentProfile,
} from "../../xroute-chain-registry/index.mjs";

export {
  getAsset,
  getChain,
  listAssets,
  listChains,
  getParachainId,
  getAssetLocation,
  findTransferPath,
  assertSupportedDeploymentProfile,
};

export {
  DEFAULT_DEPLOYMENT_PROFILE,
  DEPLOYMENT_PROFILES,
} from "../../xroute-precompile-interfaces/index.mjs";

const EVM_CHAIN_KEYS = new Set(["moonbeam"]);

export function getAssetDecimals(assetKey, deploymentProfile) {
  return getAsset(assetKey, deploymentProfile).decimals;
}

export function getAssetSupportedChains(assetKey, deploymentProfile) {
  return getAsset(assetKey, deploymentProfile).supportedChains.slice();
}

export function parseUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("value must be a non-negative number");
    }
    value = value.toString();
  }

  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    throw new Error("value is required");
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("value must be a non-negative decimal string");
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`value has more decimal places than supported (${decimals})`);
  }

  const wholeUnits = BigInt(whole || "0") * 10n ** BigInt(decimals);
  const fractionUnits =
    decimals === 0
      ? 0n
      : BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");

  return (wholeUnits + fractionUnits).toString();
}

export function formatUnits(
  value,
  decimals,
  {
    trimTrailingZeros = true,
  } = {},
) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }

  const normalized = BigInt(value);
  const divisor = 10n ** BigInt(decimals);
  const whole = normalized / divisor;
  const fraction = normalized % divisor;

  if (decimals === 0 || fraction === 0n) {
    return whole.toString();
  }

  let fractionText = fraction.toString().padStart(decimals, "0");
  if (trimTrailingZeros) {
    fractionText = fractionText.replace(/0+$/, "");
  }

  return fractionText === ""
    ? whole.toString()
    : `${whole.toString()}.${fractionText}`;
}

export function parseAssetAmount(assetKey, value, deploymentProfile) {
  return parseUnits(value, getAssetDecimals(assetKey, deploymentProfile));
}

export function formatAssetAmount(assetKey, value, deploymentProfile, options) {
  return formatUnits(value, getAssetDecimals(assetKey, deploymentProfile), options);
}

export function getChainWalletType(chainKey, deploymentProfile) {
  return EVM_CHAIN_KEYS.has(getChain(chainKey, deploymentProfile).key) ? "evm" : "substrate";
}

export function isEvmChain(chainKey, deploymentProfile) {
  return getChainWalletType(chainKey, deploymentProfile) === "evm";
}

export function isSubstrateChain(chainKey, deploymentProfile) {
  return getChainWalletType(chainKey, deploymentProfile) === "substrate";
}
