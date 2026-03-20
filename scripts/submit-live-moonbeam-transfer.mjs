import { createXRouteClient } from "../packages/xroute-sdk/index.mjs";
import { createCastRouterAdapter } from "../packages/xroute-sdk/routers/router-adapters.mjs";

const apiBaseUrl = process.env.XROUTE_API_BASE_URL?.trim();
const moonbeamRpcUrl = process.env.XROUTE_MOONBEAM_RPC_URL?.trim();
const deployerPrivateKey = process.env.XROUTE_DEPLOYER_PRIVATE_KEY?.trim();
const moonbeamXcDot = process.env.XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS?.trim();
const moonbeamXcBnc = process.env.XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS?.trim();
const transferAmount = process.env.XROUTE_TRANSFER_AMOUNT?.trim() || "100000000";

if (!apiBaseUrl || !moonbeamRpcUrl || !deployerPrivateKey || !moonbeamXcDot) {
  throw new Error("missing required env for live moonbeam transfer");
}

const owner = "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb";
const routerAddress = "0xe90d4bf9155d6fd843844253a647f63ed9d57a54";

const client = createXRouteClient();
client.connectWallet({
  chainKey: "moonbeam",
  async getAddress() {
    return owner;
  },
  routerAdapter: createCastRouterAdapter({
    rpcUrl: moonbeamRpcUrl,
    routerAddress,
    privateKey: deployerPrivateKey,
    ownerAddress: owner,
  }),
  async assetAddressResolver({ chainKey, assetKey }) {
    if (chainKey !== "moonbeam") {
      throw new Error(`unsupported chain ${chainKey}`);
    }
    if (assetKey === "DOT") {
      return moonbeamXcDot;
    }
    if (assetKey === "BNC" && moonbeamXcBnc) {
      return moonbeamXcBnc;
    }
    throw new Error(`unsupported ${assetKey} on ${chainKey}`);
  },
});

const input = {
  sourceChain: "moonbeam",
  destinationChain: "hydration",
  senderAddress: owner,
  ownerAddress: owner,
  asset: "DOT",
  amount: transferAmount,
  recipient: "12hEyt1RjSsnFTYrht4aaa2aatUHK47cHyz2Ptdi6PyAiJay",
};

process.stdout.write("stage: quote:start\n");
const quote = await client.quote(input);
process.stdout.write(`stage: quote:done ${quote.intent.quoteId}\n`);

process.stdout.write("stage: transfer:start\n");
const execution = await client.transfer(input);

process.stdout.write("stage: transfer:done\n");

process.stdout.write(
  `${JSON.stringify(execution, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
);
