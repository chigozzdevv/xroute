import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEPLOYMENT_PROFILES,
  XCM_PRECOMPILE_ADDRESS,
  normalizeDeploymentProfile,
} from "../packages/xroute-precompile-interfaces/index.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const contractRoot = resolve(workspaceRoot, "contracts/polkadot-hub-router");

const defaultPrivateKey =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const defaultHydrationDeploymentPathByProfile = Object.freeze({
  [DEPLOYMENT_PROFILES.LOCAL]: resolve(contractRoot, "deployments/local/hydration.json"),
  [DEPLOYMENT_PROFILES.TESTNET]: resolve(contractRoot, "deployments/testnet/hydration.json"),
  [DEPLOYMENT_PROFILES.MAINNET]: resolve(contractRoot, "deployments/mainnet/hydration.json"),
});
const defaultStackOutputPathByProfile = Object.freeze({
  [DEPLOYMENT_PROFILES.LOCAL]: resolve(
    workspaceRoot,
    "testing/devnet/.artifacts/local-stack.json",
  ),
});

export function deployStack(overrides = {}) {
  const deploymentProfile = normalizeDeploymentProfile(
    overrides.deploymentProfile ??
      process.env.XROUTE_DEPLOYMENT_PROFILE ??
      DEPLOYMENT_PROFILES.LOCAL,
  );
  const isLocalDeployment = deploymentProfile === DEPLOYMENT_PROFILES.LOCAL;
  if (!isLocalDeployment) {
    assertLiveDeploymentConfirmed(
      overrides.allowLiveDeployment ?? process.env.XROUTE_ALLOW_LIVE_DEPLOY,
      deploymentProfile,
    );
  }

  const rpcUrl = isLocalDeployment
    ? overrides.rpcUrl ??
      process.env.XROUTE_RPC_URL ??
      process.env.XROUTE_LOCAL_RPC_URL ??
      "http://127.0.0.1:8545"
    : requiredSetting("XROUTE_RPC_URL", overrides.rpcUrl ?? process.env.XROUTE_RPC_URL);
  const privateKey = isLocalDeployment
    ? overrides.privateKey ??
      process.env.XROUTE_PRIVATE_KEY ??
      process.env.XROUTE_LOCAL_PRIVATE_KEY ??
      defaultPrivateKey
    : requiredSetting(
        "XROUTE_PRIVATE_KEY",
        overrides.privateKey ?? process.env.XROUTE_PRIVATE_KEY,
      );
  const chainKey =
    overrides.chainKey ?? process.env.XROUTE_DESTINATION_CHAIN_KEY ?? "hydration";
  const platformFeeBps =
    overrides.platformFeeBps ?? process.env.XROUTE_PLATFORM_FEE_BPS ?? "10";
  const refTime = overrides.refTime ?? process.env.XROUTE_DEVNET_REF_TIME ?? "3500000000";
  const proofSize = overrides.proofSize ?? process.env.XROUTE_DEVNET_PROOF_SIZE ?? "120000";
  const hydrationDeploymentPath =
    overrides.hydrationDeploymentPath ??
    process.env.XROUTE_HYDRATION_DEPLOYMENT_PATH ??
    defaultHydrationDeploymentPathByProfile[deploymentProfile];
  const stackOutputPath =
    overrides.stackOutputPath ??
    process.env.XROUTE_STACK_OUTPUT_PATH ??
    defaultStackOutputPathByProfile[deploymentProfile] ??
    "";
  const deployLocalInfrastructure =
    overrides.deployLocalInfrastructure ??
    (isLocalDeployment &&
      process.env.XROUTE_DEPLOY_LOCAL_INFRASTRUCTURE !== "false");

  if (!isLocalDeployment) {
    if (privateKey === defaultPrivateKey) {
      throw new Error(
        `refusing to deploy to ${deploymentProfile} with the local default private key`,
      );
    }

    if (rpcUrl === "http://127.0.0.1:8545") {
      throw new Error(
        `refusing to deploy to ${deploymentProfile} with the default local RPC URL`,
      );
    }
  }

  const deployer = runCast(["wallet", "address", "--private-key", privateKey], {
    rpcUrl,
  });
  const executorAddress =
    isLocalDeployment
      ? overrides.executorAddress ?? process.env.XROUTE_ROUTER_EXECUTOR ?? deployer
      : requiredSetting(
          "XROUTE_ROUTER_EXECUTOR",
          overrides.executorAddress ?? process.env.XROUTE_ROUTER_EXECUTOR,
        );
  const treasuryAddress =
    isLocalDeployment
      ? overrides.treasuryAddress ?? process.env.XROUTE_ROUTER_TREASURY ?? deployer
      : requiredSetting(
          "XROUTE_ROUTER_TREASURY",
          overrides.treasuryAddress ?? process.env.XROUTE_ROUTER_TREASURY,
        );

  const xcmAddress =
    overrides.xcmAddress ??
    process.env.XROUTE_XCM_ADDRESS ??
    (deployLocalInfrastructure
      ? deployContract("src/devnet/DevnetXcm.sol:DevnetXcm", [refTime, proofSize], {
          rpcUrl,
          privateKey,
        })
      : isLocalDeployment
        ? XCM_PRECOMPILE_ADDRESS
        : requiredSetting("XROUTE_XCM_ADDRESS", null));

  const dispatcherAddress = deployContract(
    "src/dispatcher/DestinationTransactDispatcherV1.sol:DestinationTransactDispatcherV1",
    [deployer],
    {
      rpcUrl,
      privateKey,
    },
  );
  const swapExecutorAddress = deployContract(
    "src/executors/HydrationSwapExecutorV1.sol:HydrationSwapExecutorV1",
    [deployer],
    {
      rpcUrl,
      privateKey,
    },
  );
  const stakeExecutorAddress = deployContract(
    "src/executors/HydrationStakeExecutorV1.sol:HydrationStakeExecutorV1",
    [deployer],
    {
      rpcUrl,
      privateKey,
    },
  );
  const swapAdapterAddress = deployContract(
    "src/adapters/HydrationSwapAdapterV1.sol:HydrationSwapAdapterV1",
    [dispatcherAddress, swapExecutorAddress],
    {
      rpcUrl,
      privateKey,
    },
  );
  const stakeAdapterAddress = deployContract(
    "src/adapters/HydrationStakeAdapterV1.sol:HydrationStakeAdapterV1",
    [dispatcherAddress, stakeExecutorAddress],
    {
      rpcUrl,
      privateKey,
    },
  );
  const callAdapterAddress = deployContract(
    "src/adapters/HydrationCallAdapterV1.sol:HydrationCallAdapterV1",
    [dispatcherAddress],
    {
      rpcUrl,
      privateKey,
    },
  );
  const routerAddress = deployContract("src/XRouteHubRouter.sol:XRouteHubRouter", [
    xcmAddress,
    executorAddress,
    treasuryAddress,
    platformFeeBps,
  ], {
    rpcUrl,
    privateKey,
  });

  sendTransaction(swapExecutorAddress, "setAdapter(address)", [swapAdapterAddress], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(stakeExecutorAddress, "setAdapter(address)", [stakeAdapterAddress], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(dispatcherAddress, "setTargetAllowed(address,bool)", [swapAdapterAddress, "true"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(dispatcherAddress, "setTargetAllowed(address,bool)", [stakeAdapterAddress, "true"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(dispatcherAddress, "setTargetAllowed(address,bool)", [callAdapterAddress, "true"], {
    rpcUrl,
    privateKey,
  });

  const tokens = deployLocalInfrastructure
    ? deployLocalTokenInfrastructure({
        deployer,
        rpcUrl,
        privateKey,
        swapExecutorAddress,
      })
    : {};

  writeJson(hydrationDeploymentPath, {
    chainKey,
    deploymentProfile,
    contracts: {
      HydrationSwapAdapterV1: swapAdapterAddress,
      HydrationStakeAdapterV1: stakeAdapterAddress,
      HydrationCallAdapterV1: callAdapterAddress,
    },
  });

  const deploymentSummary = {
    deploymentProfile,
    chainKey,
    rpcUrl,
    deployer,
    routerAddress,
    dispatcherAddress,
    xcmAddress,
    tokens,
    executors: {
      hydrationSwapExecutorV1: swapExecutorAddress,
      hydrationStakeExecutorV1: stakeExecutorAddress,
    },
    adapters: {
      hydrationSwapAdapterV1: swapAdapterAddress,
      hydrationStakeAdapterV1: stakeAdapterAddress,
      hydrationCallAdapterV1: callAdapterAddress,
    },
  };

  if (stackOutputPath !== "") {
    writeJson(stackOutputPath, deploymentSummary);
  }

  return deploymentSummary;
}

function deployLocalTokenInfrastructure({
  deployer,
  rpcUrl,
  privateKey,
  swapExecutorAddress,
}) {
  const dotAddress = deployContract("src/devnet/DevnetMintableToken.sol:DevnetMintableToken", [
    "Polkadot",
    "DOT",
    "10",
    deployer,
  ], {
    rpcUrl,
    privateKey,
  });
  const usdtAddress = deployContract("src/devnet/DevnetMintableToken.sol:DevnetMintableToken", [
    "Tether USD",
    "USDT",
    "6",
    deployer,
  ], {
    rpcUrl,
    privateKey,
  });
  const hdxAddress = deployContract("src/devnet/DevnetMintableToken.sol:DevnetMintableToken", [
    "Hydration",
    "HDX",
    "12",
    deployer,
  ], {
    rpcUrl,
    privateKey,
  });

  sendTransaction(swapExecutorAddress, "setAsset(bytes32,address,uint8)", [assetId("DOT"), dotAddress, "10"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(swapExecutorAddress, "setAsset(bytes32,address,uint8)", [assetId("USDT"), usdtAddress, "6"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(swapExecutorAddress, "setAsset(bytes32,address,uint8)", [assetId("HDX"), hdxAddress, "12"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(
    swapExecutorAddress,
    "setPair(bytes32,bytes32,uint128,uint128,uint16)",
    [assetId("DOT"), assetId("USDT"), "495", "100", "30"],
    {
      rpcUrl,
      privateKey,
    },
  );
  sendTransaction(
    swapExecutorAddress,
    "setPair(bytes32,bytes32,uint128,uint128,uint16)",
    [assetId("DOT"), assetId("HDX"), "150", "1", "25"],
    {
      rpcUrl,
      privateKey,
    },
  );
  sendTransaction(usdtAddress, "setMinter(address,bool)", [swapExecutorAddress, "true"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(hdxAddress, "setMinter(address,bool)", [swapExecutorAddress, "true"], {
    rpcUrl,
    privateKey,
  });
  sendTransaction(dotAddress, "mint(address,uint256)", [deployer, "1000000000000000"], {
    rpcUrl,
    privateKey,
  });

  return {
    DOT: dotAddress,
    USDT: usdtAddress,
    HDX: hdxAddress,
  };
}

function deployContract(contractId, constructorArgs = [], { rpcUrl, privateKey }) {
  const args = [
    "create",
    contractId,
    "--root",
    contractRoot,
    "--rpc-url",
    rpcUrl,
    "--private-key",
    privateKey,
    "--broadcast",
  ];

  if (constructorArgs.length > 0) {
    args.push("--constructor-args", ...constructorArgs);
  }

  const output = execFileSync("forge", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) {
    throw new Error(`failed to parse deployed address for ${contractId}\n${output}`);
  }

  return match[1].toLowerCase();
}

function sendTransaction(contractAddress, signature, args = [], { rpcUrl, privateKey }) {
  execFileSync(
    "cast",
    [
      "send",
      contractAddress,
      signature,
      ...args.map(String),
      "--rpc-url",
      rpcUrl,
      "--private-key",
      privateKey,
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
    },
  );
}

function runCast(args, { rpcUrl }) {
  return execFileSync("cast", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      XROUTE_RPC_URL: rpcUrl,
    },
  }).trim();
}

function assetId(symbol) {
  const bytes = Buffer.alloc(32);
  Buffer.from(symbol, "utf8").copy(bytes);
  return `0x${bytes.toString("hex")}`;
}

function assertLiveDeploymentConfirmed(flag, deploymentProfile) {
  if (String(flag ?? "").trim().toLowerCase() !== "true") {
    throw new Error(
      `refusing to deploy to ${deploymentProfile} without XROUTE_ALLOW_LIVE_DEPLOY=true`,
    );
  }
}

function requiredSetting(name, value) {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    throw new Error(`missing required setting: ${name}`);
  }

  return normalized;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(deployStack(), null, 2));
}
