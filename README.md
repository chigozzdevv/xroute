# xroute

`xroute` is a multihop XCM execution router for Polkadot.

It gives developers one intent surface for three actions:

- `transfer`
- `swap`
- `execute`

The control plane lives on `polkadot-hub`. The SDK is JS/TS. The backend services are Rust.

## Why XRoute

Polkadot Hub gives you XCM, native assets, and precompiles, but the developer surface is still low-level:

- route selection depends on the exact chain graph
- fees depend on the full path, not just the destination
- destination execution payloads are chain-specific
- settlement, refunds, and finalization need operator discipline

XRoute turns that into:

- a typed intent model
- a route engine that plans the path and fees
- a router contract that escrows and commits execution
- a relayer that dispatches and finalizes the live flow

## What Works

### Public Proof Matrix

- `paseo`
  - public Polkadot proof profile
  - live route: `polkadot-hub -> people`
  - asset: `PAS`
  - proves the Hub router lifecycle and real public XCM transfer
- `hydration-snakenet`
  - public Hydration validation profile
  - routes: `polkadot-hub <-> hydration`
  - actions: `transfer`, `swap`, `execute/runtime-call`
- `moonbase-alpha`
  - public Moonbeam validation profile
  - routes: `polkadot-hub <-> moonbeam`
  - actions: `transfer`, `execute/runtime-call`, `execute/evm-contract-call`
- `bifrost-via-hydration`
  - public Bifrost capability profile through Hydration
  - routes: `hydration <-> bifrost`
  - actions: `transfer`, `execute/runtime-call`, `execute/vtoken-order`
- `bifrost-via-moonbase-alpha`
  - public Bifrost capability profile through Moonbeam
  - routes: `moonbeam <-> bifrost`
  - actions: `transfer`, `execute/runtime-call`, `execute/vtoken-order`

These profiles are the real public-network validation targets. They are intentionally split because the ecosystem does not expose one shared four-chain public testnet fabric.

### Internal and Production Profiles

- `integration`
  - dedicated multichain lab profile for full-system regression
  - full four-chain graph
- `mainnet`
  - production graph
  - `polkadot-hub <-> hydration`
  - `polkadot-hub <-> moonbeam`
  - `moonbeam <-> bifrost`
  - `hydration <-> bifrost`

### Actions

- `transfer`
  - cross-chain asset movement
- `swap`
  - Hydration execution with optional remote settlement
- `execute`
  - typed destination execution

### Execute Types

- `runtime-call`
  - destination runtime `Transact`
- `evm-contract-call`
  - Moonbeam `ethereumXcm.transact(V2)` payload generation
- `vtoken-order`
  - Bifrost SLPx order generation
  - `mint`
  - `redeem`

### Assets

- `paseo`
  - `PAS`
- `hydration-snakenet`
  - `PAS`
  - `HDX`
- `moonbase-alpha`
  - `DOT`
- `bifrost-via-hydration`
  - `DOT`
  - `VDOT`
- `bifrost-via-moonbase-alpha`
  - `DOT`
  - `VDOT`
- `integration`
  - `DOT`
  - `USDT`
  - `HDX`
  - `VDOT`
- `mainnet`
  - `DOT`
  - `USDT`
  - `HDX`
  - `VDOT`

## Route Model

### Paseo

Supported live proof route:

- `polkadot-hub -> people`

This is the route used to prove:

- quote generation
- router submit
- relayer dispatch
- onchain settlement
- final router state

### Hydration Snakenet

Public validation target:

- `polkadot-hub -> hydration`
- `hydration -> polkadot-hub`

Supported capabilities:

- `transfer`
  - `PAS`
- `swap`
  - `PAS -> HDX`
  - settlement on `hydration`
- `execute/runtime-call`

### Moonbase Alpha

Public validation target:

- `polkadot-hub -> moonbeam`
- `moonbeam -> polkadot-hub`

Supported capabilities:

- `transfer`
- `execute/runtime-call`
- `execute/evm-contract-call`

### Bifrost Via Hydration

Public validation target:

- `hydration -> bifrost`
- `bifrost -> hydration`

Supported capabilities:

- `transfer`
- `execute/runtime-call`
- `execute/vtoken-order`

### Bifrost Via Moonbase Alpha

Public validation target:

- `moonbeam -> bifrost`
- `bifrost -> moonbeam`

Supported capabilities:

- `transfer`
- `execute/runtime-call`
- `execute/vtoken-order`

### Integration

Dedicated full-graph multihop profile:

- `polkadot-hub <-> hydration`
- `polkadot-hub <-> moonbeam`
- `moonbeam <-> bifrost`
- `hydration <-> bifrost`

This is the profile used to validate the complete four-chain `transfer + swap + execute` surface in the route engine, XCM encoder, SDK, and service test stack before mainnet deployment.

### Mainnet

Supported destination capabilities:

- `hydration`
  - `swap`
  - `execute/runtime-call`
- `moonbeam`
  - `execute/runtime-call`
  - `execute/evm-contract-call`
- `bifrost`
  - `execute/runtime-call`
  - `execute/vtoken-order`

Important constraint:

- `bifrost` is treated as a capability chain, not a generic transit hub
- XRoute can route into Bifrost through supported source environments, but it does not use Bifrost as a free-form bridge for unrelated traffic

That is why the Bifrost story is now docs-backed:

- `polkadot-hub -> moonbeam -> bifrost`
- `polkadot-hub -> hydration -> bifrost`
- `moonbeam -> bifrost`
- `hydration -> bifrost`

## Real Multihop Examples

- `moonbeam -> polkadot-hub -> hydration`
  - transfer DOT into Hydration
- `moonbeam -> polkadot-hub -> hydration -> polkadot-hub`
  - swap on Hydration and settle back on Hub
- `hydration -> polkadot-hub -> moonbeam`
  - route DOT into Moonbeam and execute an EVM contract call
- `polkadot-hub -> moonbeam -> bifrost`
  - reach Bifrost through a supported source chain and mint `VDOT`
- `moonbeam -> bifrost`
  - redeem `VDOT` back toward `DOT`

## Architecture

### Onchain

- `contracts/polkadot-hub-router`
  - Solidity router on Polkadot Hub
  - escrow
  - committed execution hash
  - dispatch
  - final onchain status

### Backend

- `services/route-engine`
  - Rust route planning core
  - path search
  - fee estimation
  - destination payload generation
- `services/quote-service`
  - Rust HTTP quote API
  - optional Moonbeam execution policy enforcement
- `services/executor-relayer`
  - Rust operator API
  - dispatch
  - settle / fail / refund jobs
- `services/shared`
  - shared request parsing, deployment loading, and policy code

### SDK

- `packages/xroute-sdk`
  - JS/TS integration layer for app developers
- `packages/xroute-intents`
  - intent creation and validation
- `packages/xroute-chain-registry`
  - graph, assets, and destination capability metadata
- `packages/xroute-xcm`
  - XCM envelope generation

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

## Setup

Requirements:

- `Node.js 20+`
- `cargo`
- `forge`
- `cast`

Core verification:

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
npm run deploy:hydration-snakenet
npm run deploy:moonbase-router
npm run deploy:moonbase-target
npm run deploy:paseo
npm run deploy:integration
npm run deploy:mainnet
npm run smoke:integration
npm run smoke:hydration-snakenet
npm run smoke:moonbase
npm run smoke:paseo
```

## Deployment

Public Hub deployment entrypoint:

- `scripts/deploy-stack.mjs`

Profiles:

- `paseo`
- `hydration-snakenet`
- `moonbase-alpha`
- `bifrost-via-hydration`
- `bifrost-via-moonbase-alpha`
- `integration`
- `mainnet`

Official Hub RPC endpoints:

- `paseo`: [https://services.polkadothub-rpc.com/testnet](https://services.polkadothub-rpc.com/testnet)
- `mainnet`: [https://services.polkadothub-rpc.com/mainnet](https://services.polkadothub-rpc.com/mainnet)

Example Paseo deploy:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true \
XROUTE_DEPLOYMENT_PROFILE=paseo \
XROUTE_RPC_URL=https://services.polkadothub-rpc.com/testnet \
XROUTE_PRIVATE_KEY=0x... \
node scripts/deploy-stack.mjs
```

Current live Paseo deployment:

- router: `0xdf5e9efd13db6ea5e37d0ee8129aeb31c3b4aa78`
- deployer / relayer: `0x2A3F3E0d1F847a43ebAF87Bb4741084CbDA0f549`
- chain id: `420420417`
- artifact: `contracts/polkadot-hub-router/deployments/paseo/polkadot-hub.json`

Current live Moonbase Alpha validation deployment:

- router: `0xa7690c47c0a8e3b6f2d67eef1834afe87c937747`
- validation target: `0xeb1c1fb9124bc9b9574fcdf7da44624d92693b3a`
- deployer / relayer: `0x2A3F3E0d1F847a43ebAF87Bb4741084CbDA0f549`
- chain id: `1287`
- router artifact: `contracts/polkadot-hub-router/deployments/moonbase-alpha/polkadot-hub.json`
- target artifact: `contracts/polkadot-hub-router/deployments/moonbase-alpha/moonbeam-validation-target.json`
- policy artifact: `contracts/polkadot-hub-router/deployments/moonbase-alpha/moonbeam-execution-policy.json`

Current live Hydration Snakenet validation deployment:

- router: `0x9976f315b74eb3f498439c487dac185334960cd2`
- deployer / relayer: `0x2A3F3E0d1F847a43ebAF87Bb4741084CbDA0f549`
- source chain id: `420420417`
- router artifact: `contracts/polkadot-hub-router/deployments/hydration-snakenet/polkadot-hub.json`

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

Artifacts are written to:

- `contracts/polkadot-hub-router/deployments/<profile>/polkadot-hub.json`

## Paseo Smoke Flow

Run:

```bash
npm run smoke:paseo
```

The public Paseo proof route uses the relayer as the live XCM origin. The relayer executes the `polkadot-hub -> people` PAS transfer from its funded EOA, then the router settles escrow onchain through `finalizeExternalSuccess(...)`.

Optional smoke variables:

- `XROUTE_PEOPLE_RECIPIENT`
- `XROUTE_PASEO_TRANSFER_AMOUNT`

## Integration Smoke Flow

Run:

```bash
npm run smoke:integration
```

This smoke path exercises the full multichain SDK stack under the dedicated `integration` profile:

- `transfer`
- `swap`
- `execute/runtime-call`
- `execute/evm-contract-call`
- `execute/vtoken-order`

This smoke path validates the full four-chain graph at the route-planning and envelope-building layer. It checks the multihop paths and destination payload generation for:

- `transfer`
- `swap`
- `execute/evm-contract-call`
- `execute/vtoken-order`

## Moonbase Validation

Run:

```bash
npm run smoke:moonbase
```

This public validation path does three things against live Moonbase Alpha:

- calls the deployed validation target onchain
- starts the Rust quote service and Rust relayer with the generated Moonbeam execution policy
- requests a real `execute/evm-contract-call` quote against the deployed allowlisted target

## Hydration Snakenet Validation

Run:

```bash
npm run smoke:hydration-snakenet
```

This public validation path runs a real Hub-origin swap flow:

- source chain: `polkadot-hub` on `Paseo`
- destination chain: `hydration`
- asset in: `PAS`
- asset out: `HDX`
- dispatch strategy: `external-source-execute`
- final router status: `settled`

The live smoke currently settles this route through the deployed Hydration Snakenet router:

- router: `0x9976f315b74eb3f498439c487dac185334960cd2`
- successful live intent: `0xc833ce48439687f9344e1e7b17c5c05dc1bdf16b46801f72740d4ad7ca8f3fc5`

## SDK Usage

### Client Setup

```ts
import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
  createXRouteClient,
} from "@xroute/sdk";
import { FileBackedStatusIndexer } from "@xroute/sdk/status-indexer";

const statusProvider = new FileBackedStatusIndexer({
  eventsPath: "./.xroute/status-events.jsonl",
});

const client = createXRouteClient({
  quoteProvider: createHttpQuoteProvider({
    endpoint: "https://quotes.example.com/quote",
    headers: {
      "x-xroute-deployment-profile": "hydration-snakenet",
    },
  }),
  routerAdapter: myWalletRouterAdapter,
  statusProvider,
  assetAddressResolver: async ({ chainKey, assetKey }) => {
    if (chainKey === "polkadot-hub" && assetKey === "PAS") {
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

Use the public validation profiles for real-network proof work, and switch to `mainnet` when you are ready to route on the live product graph.

### Paseo Transfer

```ts
const { intent, quote } = await client.quote({
  deploymentProfile: "paseo",
  sourceChain: "polkadot-hub",
  destinationChain: "people",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "transfer",
    params: {
      asset: "PAS",
      amount: "10000000000",
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    },
  },
});
```

### Hydration Swap

```ts
const { intent, quote } = await client.quote({
  deploymentProfile: "hydration-snakenet",
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "swap",
    params: {
      assetIn: "PAS",
      assetOut: "HDX",
      amountIn: "10000000000",
      minAmountOut: "1000000000000",
      settlementChain: "hydration",
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    },
  },
});
```

### Moonbeam EVM Execution

```ts
const { intent, quote } = await client.quote({
  deploymentProfile: "moonbase-alpha",
  sourceChain: "polkadot-hub",
  destinationChain: "moonbeam",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "evm-contract-call",
      asset: "DOT",
      maxPaymentAmount: "200000000",
      contractAddress: "0xeb1c1fb9124bc9b9574fcdf7da44624d92693b3a",
      calldata: "0x33d425c41111111111111111111111111111111111111111111111111111111111111111",
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

### Bifrost Mint / Redeem

```ts
const mintIntent = await client.quote({
  deploymentProfile: "bifrost-via-moonbase-alpha",
  sourceChain: "moonbeam",
  destinationChain: "bifrost",
  refundAddress: "0x1111111111111111111111111111111111111111",
  deadline: Math.floor(Date.now() / 1000) + 1800,
  action: {
    type: "execute",
    params: {
      executionType: "vtoken-order",
      asset: "DOT",
      amount: "250000000000",
      maxPaymentAmount: "200000000",
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
  deploymentProfile: "bifrost-via-moonbase-alpha",
  sourceChain: "moonbeam",
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

Moonbeam EVM execution is hardened by an allowlist enforced in both:

- `services/quote-service`
- `services/executor-relayer`

The policy caps:

- target contract
- selector
- value
- gas limit
- payment amount
