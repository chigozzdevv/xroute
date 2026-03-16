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
- `DOT -> USDT` settles on `hydration` or `polkadot-hub`
- `DOT -> HDX` settles on `hydration`
- multihop `moonbeam -> polkadot-hub -> hydration -> polkadot-hub`

Execute:

- `call` on `moonbeam`
- `mint-vdot` on `moonbeam` via the Moonbeam SLPx adapter
- multihop `hydration -> polkadot-hub -> moonbeam`
- multihop `bifrost -> polkadot-hub -> moonbeam`

Assets:

- `DOT`
- `USDT`
- `HDX`
- `VDOT`

## Architecture

Onchain:

- `contracts/polkadot-hub-router`
  - Hub router contract
  - escrow, dispatch commitment, settlement, refunds

Backend:

- `services/xroute-api`
  - single public HTTP API surface
  - mounts quote, status, timeline, and relayer job routes under one `/v1`
- `services/route-engine`
  - Rust route planning and fee construction
- `services/quote-service`
  - internal quote module used by `xroute-api`
- `services/executor-relayer`
  - internal relayer/status module used by `xroute-api`
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

Moonbeam adapter deployment inputs:

- `XROUTE_MOONBEAM_SLPX_ADDRESS`
- `XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS`
- `XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS`
- `XROUTE_MOONBEAM_SLPX_DEST_CHAIN_ID`

Smoke and proof runs:

```bash
npm run smoke:mainnet
npm run proof:mainnet
```

Services:

```bash
npm run serve:api
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
XROUTE_HUB_RPC_URL="<POLKADOT_HUB_RPC>" \
XROUTE_DEPLOYER_PRIVATE_KEY="<HUB_ADMIN_DEPLOYER_KEY>" \
XROUTE_HUB_PRIVATE_KEY="<HUB_EXECUTOR_KEY>" \
XROUTE_ROUTER_TREASURY="<TREASURY_ADDRESS>" \
node scripts/deploy-stack.mjs
```

Moonbeam router:

```bash
XROUTE_ALLOW_LIVE_DEPLOY=true \
XROUTE_DEPLOYMENT_CHAIN_KEY=moonbeam \
XROUTE_MOONBEAM_RPC_URL="<MOONBEAM_RPC>" \
XROUTE_DEPLOYER_PRIVATE_KEY="<MOONBEAM_ADMIN_DEPLOYER_KEY>" \
XROUTE_MOONBEAM_PRIVATE_KEY="<MOONBEAM_EXECUTOR_KEY>" \
XROUTE_ROUTER_TREASURY="<TREASURY_ADDRESS>" \
node scripts/deploy-stack.mjs
```

The deployer/admin key is not the executor. Deployments derive the router executor address from the chain executor key and reject overlapping admin, executor, and treasury roles.

## Service Configuration

`xroute-api` requirements:

- `XROUTE_WORKSPACE_ROOT`
- one of:
  - `XROUTE_LIVE_QUOTE_INPUTS_PATH`
  - `XROUTE_LIVE_QUOTE_INPUTS_COMMAND`
- `XROUTE_RELAYER_AUTH_TOKEN`
- Hub execution context:
  - `XROUTE_HUB_RPC_URL`
  - `XROUTE_HUB_PRIVATE_KEY` (`HUB_EXECUTOR_KEY`)
- Moonbeam execution context:
  - `XROUTE_MOONBEAM_RPC_URL`
  - `XROUTE_MOONBEAM_PRIVATE_KEY` (`MOONBEAM_EXECUTOR_KEY`)
- Hydration execution context:
  - `XROUTE_HYDRATION_RPC_URL`
  - `XROUTE_HYDRATION_PRIVATE_KEY` (`HYDRATION_EXECUTOR_KEY`)
- Bifrost execution context:
  - `XROUTE_BIFROST_RPC_URL`
  - `XROUTE_BIFROST_PRIVATE_KEY` (`BIFROST_EXECUTOR_KEY`)
- optional:
  - `XROUTE_EVM_POLICY_PATH`
  - `XROUTE_SUBSTRATE_DISPATCH_SCRIPT`

The quote path is fail-closed. `XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN=true` is rejected.

## Example Service Run

```bash
XROUTE_WORKSPACE_ROOT="$(pwd)" \
XROUTE_LIVE_QUOTE_INPUTS_COMMAND="node $(pwd)/scripts/fetch-live-quote-inputs.mjs" \
XROUTE_RELAYER_AUTH_TOKEN="<RELAYER_TOKEN>" \
XROUTE_HUB_RPC_URL="<POLKADOT_HUB_RPC>" \
XROUTE_HUB_PRIVATE_KEY="<HUB_OPERATOR_KEY>" \
XROUTE_MOONBEAM_RPC_URL="<MOONBEAM_RPC>" \
XROUTE_MOONBEAM_PRIVATE_KEY="<MOONBEAM_OPERATOR_KEY>" \
XROUTE_HYDRATION_RPC_URL="<HYDRATION_RPC>" \
XROUTE_HYDRATION_PRIVATE_KEY="<HYDRATION_OPERATOR_KEY>" \
XROUTE_BIFROST_RPC_URL="<BIFROST_RPC>" \
XROUTE_BIFROST_PRIVATE_KEY="<BIFROST_OPERATOR_KEY>" \
cargo run -q -p xroute-api --
```

## Operational Notes

- Refunds are full-refund only for failed intents.
- Mainnet quote inputs must be live; static fallback is not allowed.
- `scripts/fetch-live-quote-inputs.mjs` pulls live inputs from:
  - Polkadot Hub `XcmPaymentApi`
  - Hydration Omnipool oracle precompiles
  - Moonbeam XCM payment APIs
  - Bifrost vDOT pricing via the official Moonbeam XCM oracle mirror
- `execute/call` should be protected with a Moonbeam execution allowlist policy.
- `execute/mint-vdot` submits a Moonbeam SLPx order; it is an async asset-order flow, not immediate final asset settlement.
- The relayer should stay behind auth, rate limits, and your own control plane.
- Keep the deployer/admin key cold and separate from the relayer executor keys.
