# xroute

`xroute` is a multihop XCM execution router for Polkadot.

It gives developers one intent surface for three actions:

- `transfer`
- `swap`
- `execute`

The router lives on `polkadot-hub`, but the route engine composes execution across a real Hub-centered graph:

- `polkadot-hub <-> hydration`
- `polkadot-hub <-> moonbeam`
- `polkadot-hub <-> bifrost`

That means XRoute is not a generic router for arbitrary parachains. It is a production-shaped router for the routes, assets, and execution surfaces it explicitly models.

## Why XRoute

Building directly on Polkadot Hub still means dealing with low-level XCM details:

- route selection is chain- and asset-specific
- fees depend on the exact path
- remote execution payloads are runtime-specific
- finalization, refunds, and settlement tracking need operator discipline

XRoute splits that into clean layers:

- `contracts/polkadot-hub-router`
  - thin onchain trust boundary
- `services/route-engine`
  - Rust route-planning core
- `services/quote-service`
  - Rust quote API with execution policy enforcement
- `services/executor-relayer`
  - Rust dispatch/finalization/refund operator service
- `services/shared`
  - shared Rust API parsing, deployment loading, and policy validation
- `packages/xroute-sdk`
  - JS/TS developer-facing SDK

## Supported Surface

### Actions

- `transfer`
  - cross-chain asset movement
- `swap`
  - swap on Hydration, with optional remote settlement
- `execute`
  - typed destination execution

### Execute Types

- `runtime-call`
  - raw destination runtime call bytes
- `evm-contract-call`
  - Moonbeam `ethereumXcm.transact(V2)` payload generation
- `vtoken-order`
  - Bifrost SLPx order generation
  - supports `mint`
  - supports `redeem`

### Assets

- `DOT`
- `USDT`
- `HDX`
- `VDOT`

### Current Capability Map

- `transfer`
  - any supported DOT route across the Hub star
  - `VDOT` from `polkadot-hub -> bifrost`
- `swap`
  - Hydration execution for:
    - `DOT -> USDT`
    - `DOT -> HDX`
  - settlement on:
    - `hydration`
    - `polkadot-hub`
- `execute/runtime-call`
  - destination capability on:
    - `hydration`
    - `moonbeam`
    - `bifrost`
  - source can be any chain with a valid transfer path into that destination
- `execute/evm-contract-call`
  - destination: `moonbeam`
  - source can be any chain with a valid DOT path into `moonbeam`
- `execute/vtoken-order`
  - destination: `bifrost`
  - `mint`: `DOT -> VDOT`
  - `redeem`: `VDOT -> DOT`

## Real Multihop Examples

These are real routes the planner now builds:

- `moonbeam -> polkadot-hub -> hydration`
  - DOT transfer
- `moonbeam -> polkadot-hub -> hydration -> polkadot-hub`
  - swap on Hydration, settle back on Hub
- `hydration -> polkadot-hub -> moonbeam`
  - execute a Moonbeam EVM contract call after routing DOT through Hub
- `moonbeam -> polkadot-hub -> bifrost`
  - execute a Bifrost runtime call or vToken mint after routing through Hub
- `polkadot-hub -> bifrost`
  - redeem `VDOT` through Bifrost using teleport-style destination execution

That is the multihop story for XRoute:

- route the asset where it needs to go
- execute on the specialized destination chain
- optionally settle somewhere else

## How It Works

### 1. Intent

The app creates an intent:

```ts
const { intent, quote } = await client.quote({
  sourceChain: "moonbeam",
  destinationChain: "hydration",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "493000000",
      settlementChain: "polkadot-hub",
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    },
  },
});
```

Address model:

- `refundAddress`
  - source-side EVM address on Hub
- `recipient`
  - destination or settlement beneficiary account

### 2. Route Engine

The Rust route engine:

- validates the intent
- searches the supported graph
- chooses the lowest-cost supported path
- emits explicit route segments and hops
- calculates:
  - `xcmFee`
  - `destinationFee`
  - `platformFee`
- builds the exact destination call payload

### 3. XCM Builder

The XCM layer converts the route-engine plan into the exact `VersionedXcm` payload that the router commits to.

Current instruction families include:

- `TransferReserveAsset`
- `BuyExecution`
- `ExchangeAsset`
- `InitiateReserveWithdraw`
- `InitiateTeleport`
- `Transact`
- `DepositAsset`

### 4. Hub Router

The Solidity router:

- escrows the source asset
- verifies the committed dispatch payload hash
- dispatches through the Hub XCM precompile
- persists final outcome state onchain

Onchain statuses:

- `submitted`
- `dispatched`
- `settled`
- `failed`
- `cancelled`
- `refunded`

### 5. Operator Services

`services/quote-service`

- Rust HTTP quote endpoint
- optional Moonbeam EVM policy enforcement
- profile-aware deployment artifact loading

`services/executor-relayer`

- Rust authenticated operator API
- persistent dispatch/finalize/refund job store
- retryable background processing
- persistent status event stream
- same execution policy enforcement before dispatch

The SDK builds the exact dispatch request client-side from `intent + quote`, then the relayer only validates policy and submits the committed router call.

### 6. Status Projection

The SDK exposes:

- in-memory status indexing
- file-backed status indexing
- timelines and app-friendly reads

The contract remains the onchain source of truth for final intent state.

## Project Structure

```text
xroute/
  contracts/
    polkadot-hub-router/
  packages/
    xroute-chain-registry/
    xroute-intents/
    xroute-precompile-interfaces/
    xroute-sdk/
    xroute-types/
    xroute-xcm/
  services/
    executor-relayer/
    quote-service/
    route-engine/
    shared/
  scripts/
```

Main responsibilities:

- `contracts/polkadot-hub-router`
  - Hub router contract and Solidity tests
- `services/route-engine`
  - Rust route planning and destination payload encoding
- `services/quote-service`
  - Rust quote API
- `services/executor-relayer`
  - Rust operator dispatch/finalization surface
- `services/shared`
  - shared Rust service support code
- `packages/xroute-sdk`
  - publishable JS/TS SDK
- `packages/xroute-intents`
  - intent creation and validation
- `packages/xroute-chain-registry`
  - graph, assets, and destination capability metadata
- `packages/xroute-xcm`
  - metadata-backed XCM encoding

Compatibility note:

- `asset-hub` is accepted as an input alias and canonicalized to `polkadot-hub`

## Setup

Requirements:

- `Node.js 20+`
- `cargo`
- `forge`
- `cast`

Install and verify:

```bash
npm test
```

Useful commands:

```bash
npm run test:rust
npm run test:solidity
npm run test:node
npm run test:package
npm run build
npm run serve:quote
npm run serve:executor-relayer
```

Service environment variables:

- `XROUTE_EVM_POLICY_PATH`
  - Moonbeam EVM allowlist and execution caps
- `XROUTE_QUOTE_MAX_BODY_BYTES`
  - max JSON request size for the quote service
- `XROUTE_ROUTER_ADDRESS`
  - explicit live Hub router address for the relayer when not reading from the deployment artifact
- `XROUTE_RELAYER_AUTH_TOKEN`
  - bearer token required by the relayer API
- `XROUTE_RELAYER_MAX_BODY_BYTES`
  - max JSON request size for the relayer API
- `XROUTE_RELAYER_JOB_STORE_PATH`
  - persistent relayer job store path
- `XROUTE_STATUS_EVENTS_PATH`
  - persistent status event log path

## Deployment

Public Hub deployment entrypoint:

- [scripts/deploy-stack.mjs](/Users/chigozzdev/Desktop/xroute/scripts/deploy-stack.mjs)

Profiles:

- `testnet`
- `mainnet`

Official Hub RPC endpoints:

- `testnet`: [https://services.polkadothub-rpc.com/testnet](https://services.polkadothub-rpc.com/testnet)
- `mainnet`: [https://services.polkadothub-rpc.com/mainnet](https://services.polkadothub-rpc.com/mainnet)

Example deploy:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true \
XROUTE_DEPLOYMENT_PROFILE=testnet \
XROUTE_RPC_URL=https://services.polkadothub-rpc.com/testnet \
XROUTE_PRIVATE_KEY=0x... \
node scripts/deploy-stack.mjs
```

Current live testnet deployment:

- router: `0xb1ff3980f0193a98b5a4536ac3f34acfc0d3b322`
- deployer / relayer: `0x2A3F3E0d1F847a43ebAF87Bb4741084CbDA0f549`
- chain id: `420420417`
- artifact: [contracts/polkadot-hub-router/deployments/testnet/polkadot-hub.json](/Users/chigozzdev/Desktop/xroute/contracts/polkadot-hub-router/deployments/testnet/polkadot-hub.json)

Required deploy variables:

- `XROUTE_ALLOW_LIVE_DEPLOY`
- `XROUTE_RPC_URL`
- `XROUTE_PRIVATE_KEY`

Optional deploy variables:

- `XROUTE_ROUTER_EXECUTOR`
- `XROUTE_ROUTER_TREASURY`
- `XROUTE_XCM_ADDRESS`
- `XROUTE_PLATFORM_FEE_BPS`
- `XROUTE_STACK_OUTPUT_PATH`

Deployment artifacts are written to:

- `contracts/polkadot-hub-router/deployments/<profile>/polkadot-hub.json`

Artifacts include:

- deployed router address
- deployer
- chain id
- deployment profile
- executor/treasury/XCM settings
- deployment timestamp

The repo does not ship fake `testnet` or `mainnet` artifacts. Those files should only appear after a real deployment.

## SDK Usage

### Quote + Submit + Relay

Production SDK shape:

```ts
import { createHttpExecutorRelayerClient, createHttpQuoteProvider, createXRouteClient } from "@xroute/sdk";
import { FileBackedStatusIndexer } from "@xroute/sdk/status-indexer";

const statusProvider = new FileBackedStatusIndexer({
  eventsPath: "./.xroute/status-events.jsonl",
});

const client = createXRouteClient({
  quoteProvider: createHttpQuoteProvider({
    endpoint: "https://quotes.example.com/quote",
  }),
  routerAdapter: myWalletRouterAdapter,
  statusProvider,
  assetAddressResolver: async ({ chainKey, assetKey }) => {
    if (chainKey === "polkadot-hub" && assetKey === "DOT") {
      return "0x0000000000000000000000000000000000000000";
    }

    throw new Error(`unsupported ${assetKey} on ${chainKey}`);
  },
});

const relayer = createHttpExecutorRelayerClient({
  endpoint: "https://relayer.example.com",
  authToken: process.env.XROUTE_RELAYER_TOKEN,
});
```

`createHttpExecutorRelayerClient().dispatch(...)` builds the committed dispatch request in JS from the normalized `intent + quote` pair, then submits that request to the Rust relayer API.

### Example: Multihop Swap

```ts
const { intent, quote } = await client.quote({
  sourceChain: "moonbeam",
  destinationChain: "hydration",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "493000000",
      settlementChain: "polkadot-hub",
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    },
  },
});

const submitted = await client.submit({
  intent,
  quote,
  owner: "0x1111111111111111111111111111111111111111",
});

await relayer.dispatch({
  intentId: submitted.intentId,
  intent,
  quote,
});
```

### Example: Moonbeam EVM Execution

```ts
const { intent, quote } = await client.quote({
  sourceChain: "hydration",
  destinationChain: "moonbeam",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "200000000",
      contractAddress: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650000000,
        proofSize: 12288,
      },
    },
  },
});
```

### Example: Bifrost Mint / Redeem

```ts
const mintIntent = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "bifrost",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "vtoken-order",
      asset: "DOT",
      amount: "250000000000",
      maxPaymentAmount: "100000000",
      operation: "mint",
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      channelId: 7,
      remark: "xroute",
      fallbackWeight: {
        refTime: 600000000,
        proofSize: 12288,
      },
    },
  },
});

const redeemIntent = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "bifrost",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "vtoken-order",
      asset: "VDOT",
      amount: "250000000000",
      maxPaymentAmount: "100000000",
      operation: "redeem",
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      fallbackWeight: {
        refTime: 600000000,
        proofSize: 12288,
      },
    },
  },
});
```

## Execution Policy

Moonbeam EVM execution is hardened by an allowlist/policy layer in both the quote service and relayer.

Policy shape:

```json
{
  "moonbeam": {
    "evmContractCall": {
      "allowedContracts": [
        {
          "address": "0x1111111111111111111111111111111111111111",
          "selectors": ["0xdeadbeef"],
          "maxValue": "0",
          "maxGasLimit": "250000",
          "maxPaymentAmount": "200000000"
        }
      ]
    }
  }
}
```

Use:

- `XROUTE_EVM_POLICY_PATH=/abs/path/policy.json`

Moonbeam EVM execution is restricted by:

- allowlisted contract address
- allowlisted selector
- max call value
- max gas limit
- max payment amount

## Reliability Model

What is onchain:

- escrow
- payload-hash commitment
- dispatch
- final success / failure / refund state

What is offchain:

- quote generation
- operator dispatch/finalization service
- app-facing status projection

Current trust boundary:

- the router contract is the onchain source of truth
- outcome reporting still depends on a trusted executor/relayer
- this is robust within that trust model, but it is not proof-verified cross-chain finality
