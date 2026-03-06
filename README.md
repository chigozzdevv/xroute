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
const quote = await router.quote({
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

await router.execute(quote);
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
  - builds SCALE/XCM payloads
  - knows destination-specific logic like Hydration swap execution
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
  - Solidity interfaces for Hub precompiles
- `packages/xroute-sdk`
  - developer-facing client
- `packages/xroute-types`
  - shared types
- `packages/xroute-xcm`
  - shared execution-plan models and decode helpers
- `services/route-engine`
  - Rust quote and payload builder
- `services/status-indexer`
  - execution tracking
- `testing/chopsticks`
  - multi-chain local tests

## What we should implement first

The first real vertical slice should be:

1. define `transfer` and `swap` intents
2. implement the Hub router contract surface
3. implement the Rust route engine for `polkadot-hub -> hydration swap`
4. expose that through a minimal SDK
5. track result status with the indexer
6. demo it in the studio app

`stake` and generic `call` should use the same intent model, but come after the swap path is solid.

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
