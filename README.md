# xroute

`xroute` is an XCM intent router for cross-chain execution on Polkadot.

It gives developers a higher-level interface for cross-chain actions such as:

- `transfer` native assets across chains
- `swap` on Hydration from Polkadot Hub
- `stake` through a destination adapter
- `call` a destination contract or adapter

Instead of asking a user or dApp to hand-build low-level XCM, XRoute lets them ask for an outcome and pushes the routing, payload construction, and execution details into dedicated infrastructure.

## Why XRoute

Polkadot Hub exposes powerful primitives, but they are still low-level from a product perspective:

- XCM dispatch is byte-oriented and runtime-specific
- fee estimation depends on chain context
- destination execution needs chain-specific adapters
- cross-chain UX gets messy fast if every dApp has to learn raw XCM

XRoute exists to solve that gap.

The design goal is simple:

- keep the onchain router thin and verifiable
- keep route planning and payload construction offchain
- make the developer API look like `quote -> execute -> track`

## What Is Implemented

Current supported vertical slices:

- `polkadot-hub -> asset-hub` native `transfer`
- `polkadot-hub -> asset-hub -> hydration` native `transfer`
- `polkadot-hub -> asset-hub -> hydration` `swap`
- `polkadot-hub -> asset-hub -> hydration` `stake`
- `polkadot-hub -> asset-hub -> hydration` generic `call`

Current implemented layers:

- Solidity Hub router contract
- Rust route engine
- metadata-backed XCM envelope builder
- publishable SDK package at `@xroute/sdk`
- destination adapter specs and deployment manifests
- persistent status indexer
- Foundry, Rust, and Node end-to-end tests

## How It Works

XRoute is split into four main runtime pieces.

`1. SDK / app layer`

The app creates an intent and asks for a quote.

```ts
const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  refundAddress: ownerAddress,
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: ownerAddress,
    },
  },
});
```

`2. Route engine`

The Rust route engine:

- validates the intent
- searches the supported route graph
- estimates `xcmFee`, `destinationFee`, and `platformFee`
- resolves the deployment profile
- emits destination adapter target addresses and calldata
- builds nested multihop execution plans consumed by the XCM layer

`3. Hub router`

The Hub router contract:

- escrows the source asset
- charges the platform fee
- verifies the committed dispatch payload hash
- dispatches the XCM payload through the Hub precompile
- persists onchain lifecycle state

Current onchain lifecycle states:

- `submitted`
- `dispatched`
- `settled`
- `failed`
- `cancelled`
- `refunded`

`4. Status tracking`

Final execution outcomes can be written back onchain by the executor or relayer, and the SDK indexer maintains an offchain projection for timelines and app-friendly reads.

Important distinction:

- the router contract is the onchain source of truth for final state
- the status indexer is an offchain cache and timeline projection

## Execution Flow

Typical swap flow:

1. User creates a `swap` intent on `polkadot-hub`.
2. The route engine resolves the multihop path `polkadot-hub -> asset-hub -> hydration`.
3. The SDK converts that nested plan into the committed router request and XCM envelope.
4. The router escrows funds and dispatches the exact payload.
5. The XCM message executes across the intermediate hop and reaches the destination adapter.
6. The executor records `settled` or `failed` onchain.
7. If needed, the executor records a `refund`.

## Project Structure

```text
xroute/
  apps/
    xroute-studio/
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
    status-indexer/
  testing/
    chopsticks/
```

What each directory is for:

- `contracts/polkadot-hub-router`
  - Solidity router and destination adapter contracts
- `services/route-engine`
  - Rust quote engine and execution-plan builder
- `packages/xroute-sdk`
  - publishable SDK package
- `packages/xroute-xcm`
  - metadata-backed XCM encoding from route-engine output
- `packages/xroute-intents`
  - intent creation and normalization
- `packages/xroute-precompile-interfaces`
  - generated adapter specs and deployment manifests
- `packages/xroute-chain-registry`
  - chain and asset metadata used by the SDK/XCM layer
- `packages/xroute-types`
  - shared constants and assertions
- `services/status-indexer`
  - status projection layer used by apps and tests
- `testing/chopsticks`
  - local multi-chain testing area

## Setup

Requirements:

- `Node.js 20+`
- `cargo`
- `forge` and `cast`

Install and verify the repo:

```bash
npm test
```

Useful commands:

```bash
npm run generate:manifests
npm run test:rust
npm run test:solidity
npm run test:node
npm run build:sdk-package
npm run build
```

The SDK package is built from:

- [packages/xroute-sdk/package.json](/Users/chigozzdev/Desktop/xroute/packages/xroute-sdk/package.json)

Dry-run packing:

```bash
npm pack --dry-run ./packages/xroute-sdk
```

## SDK Usage

Use the local Rust planner:

```js
import {
  FileBackedStatusIndexer,
  createCastRouterAdapter,
  createRouteEngineQuoteProvider,
  createStaticAssetAddressResolver,
  createXRouteClient,
} from "@xroute/sdk";

const statusProvider = new FileBackedStatusIndexer({
  eventsPath: "./.xroute/status-events.jsonl",
});

const quoteProvider = createRouteEngineQuoteProvider({
  cwd: process.cwd(),
  deploymentProfile: "local",
});

const routerAdapter = createCastRouterAdapter({
  rpcUrl: process.env.XROUTE_RPC_URL,
  routerAddress: process.env.XROUTE_ROUTER_ADDRESS,
  privateKey: process.env.XROUTE_PRIVATE_KEY,
  ownerAddress: process.env.XROUTE_OWNER_ADDRESS,
  statusIndexer: statusProvider,
});

const assetAddressResolver = createStaticAssetAddressResolver({
  "polkadot-hub": {
    DOT: "0x0000000000000000000000000000000000000401",
  },
});

const client = createXRouteClient({
  quoteProvider,
  routerAdapter,
  statusProvider,
  assetAddressResolver,
});

const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  refundAddress: process.env.XROUTE_OWNER_ADDRESS,
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "490000000",
      recipient: process.env.XROUTE_OWNER_ADDRESS,
    },
  },
});

const execution = await client.execute({
  intent,
  quote,
  owner: process.env.XROUTE_OWNER_ADDRESS,
});

console.log(execution.submitted.intentId);
console.log(client.getStatus(execution.submitted.intentId));
```

Record final onchain outcomes:

```js
await client.settle({
  intentId: execution.submitted.intentId,
  outcomeReference: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  resultAssetId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  resultAmount: 493515000n,
});

await client.fail({
  intentId: execution.submitted.intentId,
  outcomeReference: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  failureReasonHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
});

await client.refund({
  intentId: execution.submitted.intentId,
  refundAmount: 1000250000000n,
  refundAsset: "DOT",
});
```

Use a hosted quote service instead of the local Rust binary:

```js
import { createHttpQuoteProvider } from "@xroute/sdk";

const quoteProvider = createHttpQuoteProvider({
  endpoint: "https://quotes.example.com/xroute/quote",
});
```

## SDK Surface

Main SDK helpers:

- `createXRouteClient(...)`
- `createRouteEngineQuoteProvider(...)`
- `createHttpQuoteProvider(...)`
- `createCastRouterAdapter(...)`
- `createStaticAssetAddressResolver(...)`
- `FileBackedStatusIndexer`

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

Important runtime notes:

- the cast-backed router adapter expects EVM hex addresses, not SS58 addresses
- the local quote provider is server-side because it shells into the Rust route engine
- the file-backed indexer is persistent, but it is still an offchain projection

## Trust Model

The current implementation uses a trusted executor or relayer for final outcome reporting.

That means:

- dispatch payload commitment is onchain
- escrow and router lifecycle state are onchain
- final settlement, failure, and refund recording are onchain
- destination outcome reporting is still trusted, not proof-verified

So the system is robust within its current trust model, but it is not yet a trustless cross-chain proof system.
