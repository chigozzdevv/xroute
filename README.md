# xroute

`xroute` is an XCM intent router for cross-chain execution on Polkadot.

## The idea

The user or dApp should be able to say:

- transfer this asset to another parachain
- swap this asset on Hydration
- stake this asset on another chain
- execute a remote call

without manually building XCM messages.

Example:

```ts
const { intent, quote } = await router.quote({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  action: {
    type: "swap",
    params: {
      assetIn: "DOT",
      assetOut: "USDT",
      amountIn: "100",
      minAmountOut: "98",
      recipient: userAddress
    }
  }
});

await router.execute({
  intent,
  quote,
  owner: userAddress
});
```

## What the implementation should actually be

Not a big contract doing everything.

The real implementation should be split like this:

- `polkadot hub router contract`
  - receives intents
  - escrows assets
  - charges platform fees
  - dispatches prebuilt XCM payloads through Hub precompiles
- `route engine`
  - computes route
  - estimates fees
  - emits destination adapter addresses, adapter calldata, deployment profiles, and XCM execution plans
  - knows destination-specific logic like Hydration swap, stake, and call execution
  - reads the shared adapter spec registry and deployment manifest for published selectors and environment-specific addresses
- `status indexer`
  - tracks submission, dispatch, destination execution, and final status
- `sdk`
  - gives dApps a clean `quote -> execute -> getStatus` API
- `studio app`
  - demo UI for quotes, execution, and tracking

That is the core idea: keep the contract thin, keep the cross-chain intelligence offchain, and make the developer experience simple.

## Why I chose that approach

After going through the docs and reference code, the main pattern is clear:

- the Polkadot Hub XCM precompile is low-level
- native assets can be used from Solidity through asset precompiles
- realistic cross-chain fee estimation belongs in route logic, not in the contract
- Hydration remote swaps are real, but they depend on specific XCM composition patterns

So the contract should not try to invent routes onchain. It should verify, hold funds, and dispatch.

## Planned repo shape

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

## What each part is for

- `apps/xroute-studio`
  - demo app
- `contracts/polkadot-hub-router`
  - Solidity router on Hub
- `packages/xroute-chain-registry`
  - chains, assets, ids, capabilities
- `packages/xroute-intents`
  - `transfer`, `swap`, `stake`, `call` schemas
- `packages/xroute-precompile-interfaces`
  - Solidity interfaces, concrete adapter contracts, generated adapter specs from Foundry artifacts, and generated deployment manifests for `local`, `testnet`, and `mainnet`
- `packages/xroute-sdk`
  - developer-facing client and route-engine bridge
- `packages/xroute-types`
  - shared types
- `packages/xroute-xcm`
  - metadata-backed XCM payload encoding from route plans, adapter addresses, and adapter calls
- `services/route-engine`
  - Rust quote and payload builder
- `services/status-indexer`
  - execution tracking
- `testing/chopsticks`
  - multi-chain local tests

## What we should implement first

The current core vertical slice is:

1. define `transfer`, `swap`, `stake`, and `call` intents
2. implement the Hub router contract surface
3. implement the Rust route engine for `polkadot-hub -> hydration` adapter-driven execution
4. expose that through a minimal SDK
5. track result status with the indexer
6. demo it in the studio app

`transfer` is the simple delivery path. `swap`, `stake`, and generic `call` now share the same adapter-driven destination execution model.

## SDK setup

The repo now includes a distributable SDK package at [packages/xroute-sdk/package.json](/Users/chigozzdev/Desktop/xroute/packages/xroute-sdk/package.json).

Build and pack it with:

```bash
npm run build:sdk-package
npm pack --dry-run ./packages/xroute-sdk
```

Runtime prerequisites:

- `Node.js 20+`
- `Foundry cast` for onchain writes and execution-hash computation
- `cargo` if you use the local Rust quote provider
- a deployed `XRouteHubRouter` address
- source-chain ERC-20 asset addresses
- an EVM `rpcUrl` and signer `privateKey`

Important: the onchain router adapter uses EVM hex addresses like `0xabc...`, not SS58 addresses like `5F...`.

## SDK usage

For local development against the Rust planner:

```js
import {
  createCastRouterAdapter,
  createRouteEngineQuoteProvider,
  createStaticAssetAddressResolver,
  createXRouteClient,
  FileBackedStatusIndexer,
} from "@xroute/sdk";

const quoteProvider = createRouteEngineQuoteProvider({
  cwd: process.cwd(),
  deploymentProfile: "local",
});

const statusProvider = new FileBackedStatusIndexer({
  eventsPath: "./.xroute/status-events.jsonl",
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

Final outcomes can now be written back to the router onchain:

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

`outcomeReference`, `resultAssetId`, and `failureReasonHash` are 32-byte hex identifiers emitted by your relayer/backend. The router now persists `submitted`, `dispatched`, `settled`, `failed`, `cancelled`, and `refunded` states onchain.

For a hosted quote service instead of the local Rust binary:

```js
import {
  createHttpQuoteProvider,
  createXRouteClient,
} from "@xroute/sdk";

const quoteProvider = createHttpQuoteProvider({
  endpoint: "https://quotes.example.com/xroute/quote",
});
```

## SDK pieces

- `createRouteEngineQuoteProvider(...)`
  - shells into the local Rust route engine
- `createHttpQuoteProvider(...)`
  - calls a remote quote API over HTTP
- `createCastRouterAdapter(...)`
  - performs real EVM writes with `cast`
  - auto-approves the input asset when needed
  - computes deterministic intent ids using the same hash path as the contract
  - exposes `finalizeSuccess`, `finalizeFailure`, and `refundFailedIntent` for onchain final state recording
- `FileBackedStatusIndexer`
  - persists indexed status events to disk and reloads them on restart
  - acts as an offchain cache/projection; the router contract is the onchain source of truth for final states
- `createStaticAssetAddressResolver(...)`
  - resolves source-chain asset contract addresses for router submission

## References I used

- [Smart Contracts on Polkadot Hub](https://docs.polkadot.com/polkadot-protocol/smart-contract-basics/)
- [XCM Precompile](https://docs.polkadot.com/develop/smart-contracts/precompiles/xcm-precompile/)
- [ERC20 Precompile](https://docs.polkadot.com/smart-contracts/precompiles/erc20/)
- [Hardhat on Polkadot Hub](https://docs.polkadot.com/develop/smart-contracts/dev-environments/hardhat)
- [Local Development Node](https://docs.polkadot.com/develop/smart-contracts/local-development-node)
- [Hydration Remote Swaps](https://docs.hydration.net/products/trading/polkadot/remote_swaps/)
- [Parity Smart Contracts DevContainer](https://github.com/paritytech/smart-contracts-devcontainer)
- [Moonbeam XCM SDK](https://github.com/moonbeam-foundation/xcm-sdk)
- [Galactic SDK](https://github.com/galacticcouncil/sdk)
- [Hydration Node](https://github.com/galacticcouncil/hydration-node)
- [polkadot-api](https://github.com/polkadot-api/polkadot-api)
