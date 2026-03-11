# xroute

`xroute` is a multihop XCM router for Polkadot.

It exposes one intent surface for:

- `transfer`
- `swap`
- `execute`

The supported production graph in this repo is:

- `polkadot-hub`
- `hydration`
- `moonbeam`
- `bifrost`

## Supported Routes

Transfers:

- `polkadot-hub -> hydration`
- `hydration -> polkadot-hub`
- `polkadot-hub -> moonbeam`
- `moonbeam -> polkadot-hub`
- `polkadot-hub -> bifrost`
- `bifrost -> polkadot-hub`
- multihop `moonbeam -> polkadot-hub -> hydration`
- multihop `bifrost -> polkadot-hub -> moonbeam`

Swaps:

- `DOT -> USDT` on `hydration`
- `DOT -> HDX` on `hydration`
- settlement on `hydration` or `polkadot-hub`
- multihop `moonbeam -> polkadot-hub -> hydration -> polkadot-hub`

Execute:

- `runtime-call` on `hydration`
- `runtime-call` on `moonbeam`
- `evm-contract-call` on `moonbeam`
- multihop `hydration -> polkadot-hub -> moonbeam`

Assets:

- `DOT`
- `USDT`
- `HDX`

## Architecture

Onchain:

- `contracts/polkadot-hub-router`
  - Hub router contract
  - escrow, dispatch commitment, settlement, refunds

Backend:

- `services/route-engine`
  - Rust route planning and fee construction
- `services/quote-service`
  - Rust quote API
  - mainnet requires live quote inputs
- `services/executor-relayer`
  - Rust relayer API for dispatch, settle, fail, refund
- `services/shared`
  - request parsing, deployment loading, policy handling

SDK:

- `packages/xroute-sdk`
- `packages/xroute-intents`
- `packages/xroute-chain-registry`
- `packages/xroute-xcm`
- `packages/xroute-precompile-interfaces`
- `packages/xroute-types`

## Setup

Requirements:

- `Node.js 20+`
- `cargo`
- `forge`
- `cast`
- `anvil`

Install:

```bash
npm install
```

## Scripts

Build and test:

```bash
npm test
npm run build
```

Deploy contracts:

```bash
npm run deploy:mainnet-hub
npm run deploy:mainnet-moonbeam
```

Smoke and proof runs:

```bash
npm run smoke:mainnet
npm run proof:mainnet
```

Services:

```bash
npm run serve:quote
npm run serve:executor-relayer
```

## Deployment Artifacts

Canonical artifact paths are:

- `contracts/polkadot-hub-router/deployments/mainnet/polkadot-hub.json`
- `contracts/polkadot-hub-router/deployments/mainnet/moonbeam.json`

These are written by `scripts/deploy-stack.mjs` when you deploy with:

- `XROUTE_DEPLOYMENT_CHAIN_KEY=polkadot-hub` or `moonbeam`

## Contract Deployment

Hub router:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true \
XROUTE_DEPLOYMENT_CHAIN_KEY=polkadot-hub \
XROUTE_RPC_URL="<POLKADOT_HUB_RPC>" \
XROUTE_PRIVATE_KEY="<HUB_DEPLOYER_KEY>" \
node scripts/deploy-stack.mjs
```

Moonbeam router:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true \
XROUTE_DEPLOYMENT_CHAIN_KEY=moonbeam \
XROUTE_RPC_URL="<MOONBEAM_RPC>" \
XROUTE_PRIVATE_KEY="<MOONBEAM_DEPLOYER_KEY>" \
node scripts/deploy-stack.mjs
```

## Service Configuration

`quote-service` requirements:

- `XROUTE_WORKSPACE_ROOT`
- one of:
  - `XROUTE_LIVE_QUOTE_INPUTS_PATH`
  - `XROUTE_LIVE_QUOTE_INPUTS_COMMAND`
- optional:
  - `XROUTE_EVM_POLICY_PATH`

The quote service is fail-closed. `XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN=true` is rejected.

`executor-relayer` requirements:

- `XROUTE_WORKSPACE_ROOT`
- `XROUTE_RELAYER_AUTH_TOKEN`
- Hub execution context:
  - `XROUTE_RPC_URL`
  - `XROUTE_PRIVATE_KEY`
- Moonbeam execution context:
  - `XROUTE_MOONBEAM_RPC_URL`
  - `XROUTE_MOONBEAM_PRIVATE_KEY`
- Hydration execution context:
  - `XROUTE_HYDRATION_RPC_URL`
  - `XROUTE_HYDRATION_PRIVATE_KEY`
- Bifrost execution context:
  - `XROUTE_BIFROST_RPC_URL`
  - `XROUTE_BIFROST_PRIVATE_KEY`
- optional:
  - `XROUTE_EVM_POLICY_PATH`
  - `XROUTE_SUBSTRATE_DISPATCH_SCRIPT`

## Example Service Runs

Quote service:

```bash
XROUTE_WORKSPACE_ROOT="$(pwd)" \
XROUTE_LIVE_QUOTE_INPUTS_COMMAND="<YOUR_LIVE_INPUT_GENERATOR>" \
cargo run -q -p quote-service --
```

Executor relayer:

```bash
XROUTE_WORKSPACE_ROOT="$(pwd)" \
XROUTE_RELAYER_AUTH_TOKEN="<RELAYER_TOKEN>" \
XROUTE_RPC_URL="<POLKADOT_HUB_RPC>" \
XROUTE_PRIVATE_KEY="<HUB_OPERATOR_KEY>" \
XROUTE_MOONBEAM_RPC_URL="<MOONBEAM_RPC>" \
XROUTE_MOONBEAM_PRIVATE_KEY="<MOONBEAM_OPERATOR_KEY>" \
XROUTE_HYDRATION_RPC_URL="<HYDRATION_RPC>" \
XROUTE_HYDRATION_PRIVATE_KEY="<HYDRATION_OPERATOR_KEY>" \
XROUTE_BIFROST_RPC_URL="<BIFROST_RPC>" \
XROUTE_BIFROST_PRIVATE_KEY="<BIFROST_OPERATOR_KEY>" \
cargo run -q -p executor-relayer --
```

## Operational Notes

- Refunds are full-refund only for failed intents.
- Mainnet quote inputs must be live; static fallback is not allowed.
- `execute/evm-contract-call` should be protected with a Moonbeam execution allowlist policy.
- The relayer should stay behind auth, rate limits, and your own control plane.
