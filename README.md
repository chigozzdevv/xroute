# xroute

`xroute` is an XCM intent router for cross-chain execution on Polkadot.

It gives developers a higher-level interface for cross-chain actions such as:

- `transfer` native assets across chains
- `swap` on Hydration from Polkadot Hub
- local-only `stake` and generic `call` adapter experiments

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

- live `polkadot-hub -> hydration` native `transfer`
- live `hydration -> polkadot-hub` native `transfer`
- live `polkadot-hub -> hydration` `swap`
- live `polkadot-hub -> hydration -> polkadot-hub` remote-settlement `swap`
- local/dev-only `polkadot-hub -> hydration` `stake`
- local/dev-only `polkadot-hub -> hydration` generic `call`

Current swap capabilities:

- `DOT -> USDT` on Hydration
- `DOT -> HDX` on Hydration
- settlement on `hydration` or on `polkadot-hub`

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
const refundAddress = "0x1111111111111111111111111111111111111111";
const recipientAccount = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  refundAddress,
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "493000000",
      settlementChain: "polkadot-hub",
      recipient: recipientAccount,
    },
  },
});
```

Important address distinction:

- `refundAddress` is the source-chain refund recipient on the Hub EVM side, so it must be an EVM hex address
- `recipient` is the XCM beneficiary on the destination or settlement chain, so it is typically an SS58 account

`2. Route engine`

The Rust route engine:

- validates the intent
- searches the supported route graph
- estimates `xcmFee`, `destinationFee`, and `platformFee`
- estimates output-side settlement fees for remote-settlement swaps
- emits explicit execution and settlement route segments with per-hop fee data
- resolves the deployment profile
- emits real Hydration runtime `ExchangeAsset` instructions for live swaps
- uses destination adapters only for local/dev-only `stake` and generic `call`
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

Typical remote-settlement swap flow:

1. User creates a `swap` intent on `polkadot-hub`.
2. The route engine resolves the execution path `polkadot-hub -> hydration`.
3. If the output should land on another chain, the route engine also resolves the settlement path from the execution chain to the settlement chain.
4. The route engine builds a real Hydration runtime `ExchangeAsset` step and any required reserve-settlement instructions.
5. The SDK converts that plan into the committed router request and XCM envelope.
6. The router escrows funds and dispatches the exact payload.
7. The XCM message executes across the route and reaches the Hydration runtime.
8. Hydration executes the swap and either deposits locally or routes the reserve-backed output to the settlement chain.
9. The executor records `settled` or `failed` onchain.
10. If needed, the executor records a `refund`.

For live swaps:

- `destinationChain` is the execution chain
- `settlementChain` is where the user finally receives the result

For local/dev-only adapter actions:

- `stake` and generic `call` still use destination adapters
- they are not part of the current live `testnet` or `mainnet` integration surface

Example route shapes:

- `polkadot-hub -> hydration`
- `hydration -> polkadot-hub`
- `polkadot-hub -> hydration -> polkadot-hub`

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
  testing/
    devnet/
```

What each directory is for:

- `contracts/polkadot-hub-router`
  - Solidity router and local/dev-only adapter contracts
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
- `testing/devnet`
  - internal end-to-end verification only

Compatibility note:

- `asset-hub` is accepted as an input alias and canonicalized to `polkadot-hub`
- the public route graph and quote output use `polkadot-hub`

## Setup

The public integration surface is:

- `@xroute/sdk`
- hosted quote infrastructure
- deployed router addresses and live chain metadata on `testnet` or `mainnet`

Repo requirements:

- `Node.js 20+`
- `cargo`
- `forge` and `cast`
- `anvil` only if you want to run the internal devnet harness

Install and verify the public repo surface:

```bash
npm test
```

Run the internal devnet end-to-end harness only when you want to verify the local stack:

```bash
npm run test:devnet
```

Run the full maintainer verification suite:

```bash
npm run check
```

Useful commands:

```bash
npm run generate:manifests
npm run test:rust
npm run test:solidity
npm run test:node
npm run test:all
npm run build:sdk-package
npm run build
```

The SDK package is built from:

- [packages/xroute-sdk/package.json](/Users/chigozzdev/Desktop/xroute/packages/xroute-sdk/package.json)

Dry-run packing:

```bash
npm pack --dry-run ./packages/xroute-sdk
```

## Deployment

Public deployment entrypoint:

- `scripts/deploy-stack.mjs`
  - profile-aware deployment for `testnet` or `mainnet`

Deployment commands:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true XROUTE_RPC_URL=https://... XROUTE_PRIVATE_KEY=0x... XROUTE_ROUTER_EXECUTOR=0x... XROUTE_ROUTER_TREASURY=0x... XROUTE_XCM_ADDRESS=0x... npm run deploy:testnet
XROUTE_ALLOW_LIVE_DEPLOY=true XROUTE_RPC_URL=https://... XROUTE_PRIVATE_KEY=0x... XROUTE_ROUTER_EXECUTOR=0x... XROUTE_ROUTER_TREASURY=0x... XROUTE_XCM_ADDRESS=0x... npm run deploy:mainnet
```

Important environment variables:

- `XROUTE_RPC_URL`
  - target EVM RPC for the deployment
- `XROUTE_PRIVATE_KEY`
  - deployer key used by `forge create` and `cast send`
- `XROUTE_DEPLOYMENT_PROFILE`
  - normally `testnet` or `mainnet`; `local` is reserved for the internal harness
- `XROUTE_ALLOW_LIVE_DEPLOY`
  - must be `true` for non-local deployments
- `XROUTE_XCM_ADDRESS`
  - required for non-local deployments
- `XROUTE_ROUTER_EXECUTOR`
  - required for non-local deployments; executor allowed to dispatch and finalize intents on the Hub router
- `XROUTE_ROUTER_TREASURY`
  - required for non-local deployments; treasury that receives platform fees
- `XROUTE_PLATFORM_FEE_BPS`
  - router platform fee in basis points
- `XROUTE_STACK_OUTPUT_PATH`
  - optional output file for the deployed stack summary

Published adapter deployments consumed by the SDK:

- [destination-adapter-deployments.json](/Users/chigozzdev/Desktop/xroute/packages/xroute-precompile-interfaces/generated/destination-adapter-deployments.json)

Note:

- live Hydration swaps do not depend on a destination EVM adapter deployment
- the published adapter manifest is still used by the local/dev-only `stake` and `call` paths

Current verification status:

- `testnet` and `mainnet`
  - these are the intended integration targets
  - this repo only publishes manifests after a real deployment exists

Internal devnet:

- local/devnet deployment is kept under [testing/devnet](/Users/chigozzdev/Desktop/xroute/testing/devnet)
- it is used for end-to-end verification only
- it is not part of the public integration surface

## SDK Usage

Use a hosted quote service in production:

```js
import {
  createHttpQuoteProvider,
  createXRouteClient,
} from "@xroute/sdk";
import {
  createCastRouterAdapter,
  createStaticAssetAddressResolver,
} from "@xroute/sdk/router-adapters";
import { FileBackedStatusIndexer } from "@xroute/sdk/status-indexer";

const statusProvider = new FileBackedStatusIndexer({
  eventsPath: "./.xroute/status-events.jsonl",
});

const quoteProvider = createHttpQuoteProvider({
  endpoint: "https://quotes.example.com/xroute/quote",
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

const refundAddress = process.env.XROUTE_OWNER_ADDRESS;
const recipientAccount = process.env.XROUTE_RECIPIENT_ACCOUNT;

const { intent, quote } = await client.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  refundAddress,
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "1000000000000",
      minAmountOut: "493000000",
      settlementChain: "polkadot-hub",
      recipient: recipientAccount,
    },
  },
});

console.log(quote.route);
console.log(quote.estimatedSettlementFee);

const execution = await client.execute({
  intent,
  quote,
  owner: process.env.XROUTE_OWNER_ADDRESS,
});

console.log(execution.submitted.intentId);
console.log(client.getStatus(execution.submitted.intentId));
```

Use the local Rust planner only for development, CI, or operator-controlled environments:

```js
import {
  createRouteEngineQuoteProvider,
  createXRouteClient,
} from "@xroute/sdk";
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

## SDK Surface

Main SDK helpers:

- `createXRouteClient(...)`
- `createRouteEngineQuoteProvider(...)`
- `createHttpQuoteProvider(...)`

Router adapter helpers:

- `createCastRouterAdapter(...)`
- `createCastTransactDispatcher(...)`
- `createStaticAssetAddressResolver(...)`

Status indexing helpers:

- `FileBackedStatusIndexer`
- `InMemoryStatusIndexer`

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

- import router adapters from `@xroute/sdk/router-adapters`
- import status indexing helpers from `@xroute/sdk/status-indexer`
- `refundAddress` and router `owner` are EVM hex addresses on the source Hub chain
- `recipient` is the beneficiary account on the destination or settlement chain and is typically SS58
- `createRouteEngineQuoteProvider(...)` is a local/dev operator helper because it shells into the Rust route engine
- `createHttpQuoteProvider(...)` is the production-facing SDK quote path
- the intended network surface for integrators is `testnet` or `mainnet`
- swap quotes may include `estimatedSettlementFee` when the final delivery happens off the execution chain
- live Hydration swaps are encoded as runtime `ExchangeAsset` XCM, not destination EVM adapter calls
- live `stake` and generic `call` are intentionally not exposed yet because they do not have a real Hydration runtime target
- the file-backed indexer is persistent, but it is still an offchain projection

## Trust Model

The current implementation uses a trusted executor or relayer for final outcome reporting.

That means:

- dispatch payload commitment is onchain
- escrow and router lifecycle state are onchain
- final settlement, failure, and refund recording are onchain
- destination outcome reporting is still trusted, not proof-verified

So the system is robust within its current trust model, but it is not yet a trustless cross-chain proof system.
