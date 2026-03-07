# xroute

`xroute` is a multihop XCM execution router for Polkadot.

It gives developers a higher-level SDK for three live actions:

- `transfer`: move native assets across supported chains
- `swap`: execute a Hydration swap and optionally settle the output on another chain
- `execute`: fund and dispatch a typed destination execution request

The current live route graph uses a Hub-centered star topology:

- `polkadot-hub <-> hydration`
- `polkadot-hub <-> moonbeam`
- `polkadot-hub <-> bifrost`
- `polkadot-hub -> hydration -> polkadot-hub` for remote-settlement swaps

This is not a generic router for arbitrary parachains. It is a production-shaped router for the routes and assets it explicitly models.

## Why XRoute

Polkadot Hub exposes powerful primitives, but integrating them directly is still low-level:

- XCM dispatch is byte-oriented and runtime-specific
- fees depend on the exact route and asset
- remote execution and settlement logic are easy to get wrong
- every dApp should not have to build and encode XCM by hand

XRoute pushes that complexity into a small set of clean layers:

- a thin onchain Hub router
- an offchain route engine
- an SDK that exposes `quote -> execute -> track`

## What Is Implemented

Live runtime surface:

- `transfer` between `polkadot-hub` and `hydration`
- `transfer` between `polkadot-hub` and `moonbeam`
- `transfer` between `polkadot-hub` and `bifrost`
- `swap` on `hydration`
- remote-settlement swaps back to `polkadot-hub`
- `execute/runtime-call` from `polkadot-hub` to `hydration`
- `execute/runtime-call` from `polkadot-hub` to `moonbeam`
- `execute/runtime-call` from `polkadot-hub` to `bifrost`
- `execute/evm-contract-call` from `polkadot-hub` to `moonbeam`
- `execute/vtoken-order` from `polkadot-hub` to `bifrost`
- onchain intent lifecycle persistence
- offchain status projection for app-facing reads

Current swap pairs:

- `DOT -> USDT`
- `DOT -> HDX`

Current profiles:

- `testnet`
- `mainnet`

## How It Works

### 1. Intent

The app creates an intent through the SDK.

```ts
const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
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

- `refundAddress` is an EVM address on the source Hub side
- `recipient` is the beneficiary account on the destination or settlement chain

### 2. Route Engine

The Rust route engine:

- validates the intent
- searches the supported route graph
- chooses the lowest-cost supported path
- estimates `xcmFee`, `destinationFee`, and `platformFee`
- emits explicit multihop route segments
- builds a concrete execution plan

For live swaps, the planner emits runtime-oriented XCM instructions such as:

- `TransferReserveAsset`
- `BuyExecution`
- `ExchangeAsset`
- `DepositAsset`
- `InitiateReserveWithdraw`

For live runtime execution, the planner emits:

- `TransferReserveAsset`
- `BuyExecution`
- `Transact`

Destination execution types:

- `runtime-call`
  - raw destination runtime call bytes
- `evm-contract-call`
  - Moonbeam `ethereumXcm.transact(V2)` payload generation
- `vtoken-order`
  - Bifrost `Slpx::mint` order generation for `vDOT`

### 3. XCM Builder

The XCM layer turns the route-engine plan into the exact payload committed by the router contract.

That keeps one important boundary clean:

- the planner decides the route and instructions
- the router only accepts the exact committed payload hash

### 4. Hub Router

The Solidity router on Polkadot Hub:

- escrows the input asset
- charges the platform fee
- verifies the dispatch payload hash
- dispatches through the XCM precompile
- stores the intent lifecycle onchain

Onchain statuses:

- `submitted`
- `dispatched`
- `settled`
- `failed`
- `cancelled`
- `refunded`

### 5. Status Projection

The SDK also exposes a persistent offchain indexer for:

- timelines
- app-friendly reads
- local persistence across restarts

The contract remains the onchain source of truth for final state.

## Multihop Model

XRoute is multihop for the routes it explicitly publishes.

Examples:

- direct transfer: `polkadot-hub -> hydration`
- direct transfer: `polkadot-hub -> moonbeam`
- direct transfer: `polkadot-hub -> bifrost`
- direct swap: `polkadot-hub -> hydration`
- direct execute/runtime-call: `polkadot-hub -> hydration`
- direct execute/runtime-call: `polkadot-hub -> moonbeam`
- direct execute/runtime-call: `polkadot-hub -> bifrost`
- direct execute/evm-contract-call: `polkadot-hub -> moonbeam`
- direct execute/vtoken-order: `polkadot-hub -> bifrost`
- remote-settlement swap: `polkadot-hub -> hydration -> polkadot-hub`

That means the route engine does not just hardcode one destination action. It models:

- execution path
- settlement path
- per-hop fee data
- nested XCM for reserve-based delivery

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
    route-engine/
  scripts/
```

Directory roles:

- `contracts/polkadot-hub-router`
  - Hub router contract and Solidity tests
- `services/route-engine`
  - Rust route planner and quote engine
- `packages/xroute-sdk`
  - publishable SDK package
- `packages/xroute-xcm`
  - metadata-backed XCM encoding
- `packages/xroute-intents`
  - intent creation and validation
- `packages/xroute-chain-registry`
  - chain, asset, and supported route metadata
- `packages/xroute-precompile-interfaces`
  - shared Hub/XCM integration constants
- `packages/xroute-types`
  - common assertions and constants
- `scripts`
  - deployment entrypoints

Compatibility note:

- `asset-hub` is accepted as an input alias and canonicalized to `polkadot-hub`
- the current public SDK entrypoint still assumes the source-side router lives on `polkadot-hub`

## Setup

Requirements:

- `Node.js 20+`
- `cargo`
- `forge`
- `cast`

Verification:

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
npm pack --dry-run ./packages/xroute-sdk
```

## Deployment

Public deployment entrypoint:

- [deploy-stack.mjs](/Users/chigozzdev/Desktop/xroute/scripts/deploy-stack.mjs)

Deployment profiles:

- `testnet`
- `mainnet`

Example:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true \
XROUTE_DEPLOYMENT_PROFILE=testnet \
XROUTE_RPC_URL=https://services.polkadothub-rpc.com/testnet \
XROUTE_PRIVATE_KEY=0x... \
XROUTE_XCM_ADDRESS=0x... \
node scripts/deploy-stack.mjs
```

Official public RPC endpoints:

- `testnet`: `https://services.polkadothub-rpc.com/testnet`
- `mainnet`: `https://services.polkadothub-rpc.com/mainnet`

Required variables:

- `XROUTE_ALLOW_LIVE_DEPLOY`
- `XROUTE_RPC_URL`
- `XROUTE_PRIVATE_KEY`

Optional:

- `XROUTE_ROUTER_EXECUTOR`
- `XROUTE_ROUTER_TREASURY`
- `XROUTE_XCM_ADDRESS`
- `XROUTE_PLATFORM_FEE_BPS`
- `XROUTE_STACK_OUTPUT_PATH`

If `XROUTE_ROUTER_EXECUTOR` or `XROUTE_ROUTER_TREASURY` are omitted, they default to the deployer address derived from `XROUTE_PRIVATE_KEY`.

For a first `testnet` deployment, fund the deployer with testnet tokens from the official faucet:

- [Polkadot smart contracts faucet](https://docs.polkadot.com/smart-contracts/faucet)

Deployment artifacts are written under:

- `contracts/polkadot-hub-router/deployments/testnet/`
- `contracts/polkadot-hub-router/deployments/mainnet/`

Only real deployments should be published there.

## SDK Usage

Production quote path:

```ts
import { createHttpQuoteProvider, createXRouteClient } from "@xroute/sdk";
import {
  createCastRouterAdapter,
  createStaticAssetAddressResolver,
} from "@xroute/sdk/router-adapters";
import { FileBackedStatusIndexer } from "@xroute/sdk/status-indexer";

const statusProvider = new FileBackedStatusIndexer({
  eventsPath: "./.xroute/status-events.jsonl",
});

const client = createXRouteClient({
  quoteProvider: createHttpQuoteProvider({
    endpoint: "https://quotes.example.com/xroute/quote",
  }),
  routerAdapter: createCastRouterAdapter({
    rpcUrl: process.env.XROUTE_RPC_URL,
    routerAddress: process.env.XROUTE_ROUTER_ADDRESS,
    privateKey: process.env.XROUTE_PRIVATE_KEY,
    ownerAddress: process.env.XROUTE_OWNER_ADDRESS,
    statusIndexer: statusProvider,
  }),
  statusProvider,
  assetAddressResolver: createStaticAssetAddressResolver({
    "polkadot-hub": {
      DOT: "0x0000000000000000000000000000000000000401",
    },
  }),
});
```

Main client methods:

- `client.quote(...)`
- `client.submit(...)`
- `client.dispatch(...)`
- `client.execute(...)`
- `client.settle(...)`
- `client.fail(...)`
- `client.refund(...)`
- `client.getStatus(...)`
- `client.getTimeline(...)`

Runtime notes:

- use `createHttpQuoteProvider(...)` in production
- `createRouteEngineQuoteProvider(...)` is a local operator/dev helper
- `routerAddress` is the deployed Hub router address
- `refundAddress` and `owner` are EVM addresses
- `recipient` is the destination or settlement-chain beneficiary
- `execute/vtoken-order` currently supports the Bifrost `mint` flow
- `execute/evm-contract-call` builds a Moonbeam Ethereum XCM call; `value` spends the destination EVM account balance

Runtime-call example:

```ts
const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "runtime-call",
      asset: "DOT",
      maxPaymentAmount: "10000000000",
      callData: "0x01020304",
      originKind: "sovereign-account",
      fallbackWeight: {
        refTime: 4_000_000_000,
        proofSize: 64_000,
      },
    },
  },
});
```

Moonbeam EVM contract call example:

```ts
const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "moonbeam",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "110000000",
      contractAddress: "0x1111111111111111111111111111111111111111",
      calldata: "0xdeadbeef",
      value: "0",
      gasLimit: "250000",
      fallbackWeight: {
        refTime: 650_000_000,
        proofSize: 12_288,
      },
    },
  },
});
```

Bifrost vToken order example:

```ts
const { intent, quote } = await client.quote({
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
        refTime: 600_000_000,
        proofSize: 12_288,
      },
    },
  },
});
```

## Reliability Model

The current design is intentionally conservative:

- the route graph is explicit
- every quote includes a concrete route and fee breakdown
- the router commits to the exact dispatch payload hash
- final success, failure, and refund states are persisted onchain
- the SDK indexer is a projection layer, not the source of truth

Current trust boundary:

- dispatch, escrow, and final intent state are onchain
- destination outcome reporting still depends on a trusted executor or relayer

So the system is robust within its current trust model, but it is not a proof-verified cross-chain finality system.
