# xroute multichain lab

This is the real no-mock four-chain lab for `xroute`.

It uses the published chain binaries for:

- `polkadot-hub` through `asset-hub-polkadot-local`
- `hydration`
- `moonbeam`
- `bifrost`

and runs them on one shared `polkadot-local` relay family with Zombienet. The Hub EVM RPC is exposed through the official `paritypr/eth-rpc` adapter image.

## Why this exists

There is no single public shared testnet that cleanly gives us:

- `polkadot-hub`
- `hydration`
- `moonbeam`
- `bifrost`

on one live public fabric.

So the dedicated lab is the clean no-mock way to test the real four-chain graph locally.

## Topology

- `polkadot-hub <-> hydration`
- `polkadot-hub <-> moonbeam`
- `moonbeam <-> bifrost`
- `hydration <-> bifrost`

This matches the current `integration` profile in the route engine and SDK.

## Files

- `Dockerfile`
- `compose.yml`
- `zombienet/multichain.json`
- `build-image.sh`
- `up.sh`
- `down.sh`
- `logs.sh`
- `doctor.sh`

## Commands

```bash
bash testing/lab/doctor.sh
bash testing/lab/up.sh
bash testing/lab/logs.sh
bash testing/lab/down.sh
```

Exposed ports:

- `9944` relaychain RPC
- `9910` Hub RPC
- `8545` Hub Ethereum RPC sidecar
- `8800` Moonbeam RPC
- `9999` Hydration RPC
- `9244` Bifrost RPC
