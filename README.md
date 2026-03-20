# xroute

**Cross-chain multihop intent execution router for the Polkadot ecosystem.**

`xroute` is a cross-chain multihop intent execution router for the Polkadot ecosystem. It provides a single intent surface (@xcm-router/sdk) for moving assets, routing swaps, and executing destination-side actions across a selected Polkadot parachain graph. It combines on-chain router contracts, route planning and quote services, relayer infrastructure, and a JavaScript SDK so applications can work with `transfer`, `swap`, and `execute` flows through one consistent interface.

---

## How It Works

```text
App or wallet creates an intent
        ↓
Quote service normalizes the intent and plans the route
        ↓
XCM builder turns the plan into the source-chain execution envelope
        ↓
Source wallet or relayer submits the source-chain transaction
        ↓
Destination execution completes on the target chain
        ↓
Relayer records settlement or refund state through the router
```

**Key flow**

1. A client creates a typed intent for `transfer`, `swap`, or `execute`.
2. The quote layer validates the route and returns a normalized execution plan.
3. The XCM builder converts that execution plan into the source-chain payload.
4. The source-chain wallet or relayer submits the dispatch transaction.
5. The destination-side action completes through the planned reserve or multihop route.
6. The relayer finalizes success or refund state so the intent has a stable status timeline.

---

## Action Surface

| Action | What it does | Current execution model |
|-------|---------------|-------------------------|
| `transfer` | Moves an asset cross-chain to a recipient | Direct and multihop routes across the supported graph |
| `swap` | Routes an input asset to the swap venue and returns the output asset | Swap execution is currently on `hydration` |
| `execute` | Delivers funds and a destination-side action payload | Destination-side execution is currently on `moonbeam` |

This is an intentionally explicit route graph, not a generic any-chain-to-any-chain router. The supported paths are defined in the registry and SDK, and unsupported combinations are rejected at intent creation time.

---

## Supported Chains and Assets

### Chains

- `polkadot-hub`
- `hydration`
- `moonbeam`
- `bifrost`

### Assets

- `DOT`
- `USDT`
- `HDX`
- `VDOT`
- `BNC`

### Current Route Surface

| Route Type | Supported Surface |
|-----------|-------------------|
| Transfer | `polkadot-hub <-> hydration`, `polkadot-hub <-> moonbeam`, `polkadot-hub <-> bifrost`, direct `moonbeam <-> bifrost` for `BNC`, plus supported multihop spoke routes |
| Swap | `DOT -> USDT` and `DOT -> HDX` with swap execution on `hydration` |
| Execute | Moonbeam-targeted execution, including contract call flows and supported adapter-driven flows |

---

## Multihop Routes

`xroute` treats multihop delivery as a first-class path instead of a fallback. Current examples in the production graph include:

- `moonbeam -> polkadot-hub -> hydration` for `DOT` transfer
- `bifrost -> polkadot-hub -> moonbeam` for `DOT` transfer
- `moonbeam -> polkadot-hub -> hydration` for swaps that execute on `hydration`
- `hydration -> polkadot-hub -> moonbeam` for execute flows targeting `moonbeam`
- `bifrost -> polkadot-hub -> moonbeam` for execute flows targeting `moonbeam`
- direct `moonbeam -> bifrost` and `bifrost -> moonbeam` transfer for `BNC`

From a product perspective:

- swaps are multihop into `hydration`, because `hydration` is the swap venue
- execute flows are multihop into `moonbeam`, because `moonbeam` is the current execution destination
- transfers can be direct or reserve-routed depending on the asset and source chain

---

## On-Chain and Off-Chain Responsibilities

### On-chain

- intent escrow and accounting on EVM router chains
- dispatch commitment validation via execution hashes
- settlement, failure, and refund state transitions
- Moonbeam adapter-based execution support where applicable

### Off-chain

- route discovery
- quote construction
- XCM message planning
- relayer job execution
- status and timeline aggregation

---

## Project Structure

```text
xroute/
├── contracts/
│   └── polkadot-hub-router/          # Solidity router contracts and tests
├── services/
│   ├── xroute-api/                   # Unified public API
│   ├── route-engine/                 # Route planning and XCM execution planning
│   ├── quote-service/                # Quote HTTP surface
│   ├── executor-relayer/             # Dispatch, settlement, and refund job execution
│   └── shared/                       # Shared Rust types, API parsing, deployment loading
├── packages/
│   ├── xroute-sdk/                   # High-level JS SDK
│   ├── xroute-intents/               # Typed intent builders and validation
│   ├── xroute-chain-registry/        # Supported chains, assets, and route graph
│   ├── xroute-xcm/                   # XCM envelope construction
│   ├── xroute-precompile-interfaces/ # Deployment profile and precompile metadata
│   └── xroute-types/                 # Shared assertions, enums, and utilities
└── scripts/                          # Deployment, proof, and local service helpers
```

### Contracts

- **`XcmRouterHubRouter.sol`** — core router contract for intent submission, dispatch tracking, settlement, and refunds
- **`XcmRouterMoonbeamSlpxAdapter.sol`** — Moonbeam-side adapter used for supported destination execution flows

### Services

| Service | Responsibility |
|--------|-----------------|
| `xroute-api` | Unified `/v1` API surface for quote, status, timeline, and relayer-backed execution flows |
| `route-engine` | Canonical route planning, fee construction, and destination call planning |
| `quote-service` | Quote API built on top of the route engine |
| `executor-relayer` | Dispatch, settlement, failure, and refund job execution |
| `shared` | Shared request parsing, deployment loading, and execution policy utilities |

### SDK Components

| Package | Responsibility |
|--------|-----------------|
| `@xcm-router/sdk` | High-level client for quoting, wallet connection, execution, and status tracking |
| `xroute-intents` | Public intent constructors such as `createTransferIntent`, `createSwapIntent`, and `createExecuteIntent` |
| `xroute-chain-registry` | Supported chains, assets, and route assertions |
| `xroute-xcm` | Source-chain envelope construction and Moonbeam dispatch metadata derivation |
| `xroute-precompile-interfaces` | Deployment profile helpers and precompile metadata |
| `xroute-types` | Shared constants, validators, and deterministic ID helpers |

---

## OpenZeppelin Usage

The Solidity contracts in `contracts/polkadot-hub-router/src` build on OpenZeppelin primitives:

- `AccessControlDefaultAdminRules` for admin and executor role management
- `SafeERC20` and `IERC20` for ERC-20 asset transfers
- `Pausable` for circuit-breaker controls
- `ReentrancyGuard` for dispatch, settlement, and refund entrypoints

This keeps the router focused on XCM and intent lifecycle logic while relying on established access control and token safety primitives.

---

## SDK Usage

### 1. Create a Client

```js
import { createXRouteClient } from "@xcm-router/sdk";

const client = createXRouteClient();
```

You can also pass an `apiKey` for higher limits:

```js
const client = createXRouteClient({
  apiKey: process.env.XROUTE_API_KEY,
});
```

For higher-rate or production access details, contact [xroute@muwa.io](mailto:xroute@muwa.io).

### 2. Connect a Wallet

For quote-only usage, no wallet connection is required.

For source-chain execution, connect the source wallet:

```js
client.connectWallet("evm", {
  provider: window.ethereum,
  chainKey: "moonbeam",
});
```

You can also connect a Substrate wallet for supported Substrate source chains:

```js
client.connectWallet("substrate", {
  extension: injectedExtension,
  chainKey: "hydration",
});
```

### 3. Quote

`client.quote(...)` returns the normalized intent, the quote, and any available source-cost estimate.

```js
const { intent, quote, sourceCosts } = await client.quote({
  sourceChain: "moonbeam",
  destinationChain: "hydration",
  ownerAddress: "0x1111111111111111111111111111111111111111",
  assetIn: "DOT",
  assetOut: "USDT",
  amountIn: "1000000000000",
  minAmountOut: "490000000",
  settlementChain: "polkadot-hub",
  recipient: "0x1111111111111111111111111111111111111111",
});
```

All asset amounts are base-unit integer strings.

### 4. Transfer

`client.transfer(...)` expects the source chain, destination chain, asset, amount, and recipient. When a wallet is connected, the SDK fills the sender and refund identity automatically.

```js
const execution = await client.transfer({
  sourceChain: "moonbeam",
  destinationChain: "bifrost",
  asset: "BNC",
  amount: "1000000000000",
  recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
});
```

### 5. Swap

```js
const execution = await client.swap({
  sourceChain: "moonbeam",
  destinationChain: "hydration",
  assetIn: "DOT",
  assetOut: "USDT",
  amountIn: "1000000000000",
  minAmountOut: "490000000",
  settlementChain: "polkadot-hub",
  recipient: "0x1111111111111111111111111111111111111111",
});
```

### 6. Execute

For contract call flows, use `client.call(...)` or `client.execute(...)`.

```js
const execution = await client.call({
  sourceChain: "hydration",
  destinationChain: "moonbeam",
  asset: "DOT",
  maxPaymentAmount: "200000000",
  contractAddress: "0x2222222222222222222222222222222222222222",
  calldata: "0xdeadbeef",
  value: "0",
  gasLimit: "250000",
  fallbackWeight: {
    refTime: 650000000,
    proofSize: 12288,
  },
});
```

### 7. Run a Flow

`runFlow(...)` sequences multiple intents. It is not a single atomic on-chain batch; each step is quoted, submitted, dispatched, and awaited independently.

```js
const flow = await client.runFlow({
  steps: [
    {
      name: "swap",
      intent: {
        sourceChain: "moonbeam",
        destinationChain: "hydration",
        refundAddress: "0x1111111111111111111111111111111111111111",
        deadline: 1773185200,
        action: {
          type: "swap",
          params: {
            assetIn: "DOT",
            assetOut: "USDT",
            amountIn: "1000000000000",
            minAmountOut: "490000000",
            settlementChain: "polkadot-hub",
            recipient: "0x1111111111111111111111111111111111111111",
          },
        },
      },
    },
    {
      name: "call",
      intent: {
        sourceChain: "hydration",
        destinationChain: "moonbeam",
        refundAddress: "0x1111111111111111111111111111111111111111",
        deadline: 1773185200,
        action: {
          type: "execute",
          params: {
            executionType: "call",
            asset: "DOT",
            maxPaymentAmount: "200000000",
            contractAddress: "0x2222222222222222222222222222222222222222",
            calldata: "0xdeadbeef",
            value: "0",
            gasLimit: "250000",
            fallbackWeight: {
              refTime: 650000000,
              proofSize: 12288,
            },
          },
        },
      },
    },
  ],
});
```

### 8. Track Status

```js
const status = await client.getStatus(execution.submitted.intentId);
const timeline = await client.getTimeline(execution.submitted.intentId);
const finalStatus = await client.wait(execution.submitted.intentId);
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Rust and Cargo
- Foundry (`forge`, `cast`, `anvil`)

### Install

```bash
npm install
```

### Run the test suite

```bash
npm test
```

### Run the unified API locally

```bash
npm run serve:api
```

### Build

```bash
npm run build
```

---

## Deployment Artifacts

Canonical deployment artifacts live under `contracts/polkadot-hub-router/deployments/mainnet/`. 

### `polkadot-hub.json`

```json
{
  "deploymentProfile": "mainnet",
  "chainKey": "polkadot-hub",
  "chainId": 420420419,
  "deployer": "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
  "deployedAt": "2026-03-19T15:27:34.488Z",
  "contracts": {
    "XcmRouterHubRouter": "0x2a9566d5ce6526797fb9be174b1b07db8bc30d2f"
  },
  "settings": {
    "adminAddress": "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
    "xcmAddress": "0x00000000000000000000000000000000000a0000",
    "executorAddress": "0xdacb0a265deafbc7dc5679b699819a43cc3e8a48",
    "treasuryAddress": "0xbc3aa247c4fdbd30e94dd86513d80092deeb1fef",
    "platformFeeBps": "10"
  }
}
```

### `moonbeam.json`

```json
{
  "deploymentProfile": "mainnet",
  "chainKey": "moonbeam",
  "chainId": 1284,
  "deployer": "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
  "deployedAt": "2026-03-19T10:41:31.431Z",
  "contracts": {
    "XcmRouterHubRouter": "0xe90d4bf9155d6fd843844253a647f63ed9d57a54",
    "XcmRouterMoonbeamSlpxAdapter": "0x3695618908fb0d390be082a4de8874571d89d104",
    "XRouteMoonbeamGuestbookDemo": "0xb80d44181941f6993ecb0378dd29b301dc3d85ca"
  },
  "settings": {
    "adminAddress": "0x7a0a4D513f328FbC800328d8A98BC55cb34a5Feb",
    "xcmAddress": "0x000000000000000000000000000000000000081A",
    "executorAddress": "0x65b938c83990b254228d4a44435d44d488466083",
    "treasuryAddress": "0xbc3aa247c4fdbd30e94dd86513d80092deeb1fef",
    "platformFeeBps": "10",
    "moonbeamSlpxAddress": "0xf1d4797e51a4640a76769a50b57abe7479add3d8",
    "moonbeamXcDotAssetAddress": "0xffffffff1fcacbd218edc0eba20fc2308c778080",
    "moonbeamVdotAssetAddress": "0xffffffff15e1b7e3df971dd813bc394deb899abf",
    "moonbeamXcBncAssetAddress": "0xffffffff7cc06abdf7201b350a1265c62c8601d2",
    "moonbeamSlpxDestinationChainId": "1284"
  }
}
```
These artifacts provide the deployed router addresses, executor addresses, treasury configuration, and chain-specific settings used by the services and SDK.