# @xroute/sdk

XRoute is a multihop cross-chain execution router on Polkadot that gives apps one SDK to transfer assets, swap, and execute calls across Polkadot Hub, Hydration, Moonbeam, and other supported routes.

`@xroute/sdk` is the integration package for XRoute.

## Intent Surface

Supported intent surface:

- `transfer`: move one supported asset from a source chain to a recipient on a destination chain.
- `swap`: route an input asset from the source chain and receive a different asset on the destination path.
- `execute`: pay to perform a supported action on the destination chain.
  - `call`: execute contract calldata on the destination chain.

## Install

```bash
npm install @xroute/sdk
```

## Main Setup

```js
import { createXRouteClient } from "@xroute/sdk";

const client = createXRouteClient({
  apiKey: process.env.XROUTE_API_KEY,
});
```

Leave the `apiKey` field empty to use at no cost with limits. If you need more usage, pls reach [xroute@muwa.io](mailto:xroute@muwa.io) to discuss usage.

## Wallet Connection

For quote-only usage, no wallet connection is needed.

For source-chain execution, connect the user's source wallet:

```js
client.connectWallet("evm", {
  provider: window.ethereum,
  chainKey: "moonbeam",
});
```

or:

```js
client.connectWallet("substrate", {
  extension: injectedExtension,
  chainKey: "hydration",
  rpcUrl: "wss://hydration-rpc.example",
});
```

You can still pass an XRoute-compatible wallet connector object directly when needed.

## Quote

```js
const { intent, quote } = await client.quote({
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
});
```

All asset amount fields are base-unit integers as strings.

- DOT: `1 DOT` -> `"10000000000"`
- USDT (6 decimals): `49 USDT` -> `"49000000"`

## Transfer

`transfer(...)` is the high-level helper for transfer intents.

```js
const execution = await client.transfer({
  sourceChain: "polkadot-hub",
  destinationChain: "hydration",
  asset: "DOT",
  amount: "10000000000",
  recipient: "5Frecipient",
});
```

The SDK fills:

- `deploymentProfile`
- `senderAddress`
- `refundAddress` through the connected wallet
- a default deadline if you do not provide one

## Swap

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

## Execute (`call`)

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

## `runFlow(...)`

`runFlow(...)` is the high-level helper for sequencing multiple intents.

It is not one atomic onchain batch.

Each step is still:

- quoted independently
- submitted independently
- dispatched independently
- awaited independently

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

## Status And Timeline

Hosted status lookups do not require a wallet connection:

```js
const status = await client.getStatus(intentId);
const timeline = await client.getTimeline(intentId);
const finalStatus = await client.wait(intentId);
```

For polling-based tracking:

```js
const tracker = client.track(intentId, {
  pollIntervalMs: 1000,
  onUpdate(snapshot) {
    console.log(snapshot.status?.status);
  },
});

const finalStatus = await tracker.done;
```

## Form Options From The SDK

Use the SDK to drive chain, asset, and route options:

```js
import {
  listChains,
  listAssets,
  getChainWalletType,
  getAssetDecimals,
  parseAssetAmount,
  formatAssetAmount,
} from "@xroute/sdk/chains";
import {
  getTransferOptions,
  getSwapOptions,
  getExecuteOptions,
} from "@xroute/sdk/routes";
```

These helpers are the intended source of truth for UI option state.

`listChains()` returns the chain catalog.

```js
[
  { key: "moonbeam", label: "Moonbeam", ... },
  { key: "hydration", label: "Hydration", ... },
]
```

`listAssets()` returns the asset catalog, not route-filtered form options.

```js
[
  { symbol: "DOT", decimals: 10, supportedChains: ["polkadot-hub", "hydration", "moonbeam"] },
]
```

`getChainWalletType(chainKey)` tells you which wallet UX to show for a selected source chain.

```js
getChainWalletType("moonbeam"); // "evm"
getChainWalletType("hydration"); // "substrate"
```

`getAssetDecimals(assetKey)` gives you the asset precision. `parseAssetAmount(...)` and `formatAssetAmount(...)` are the SDK helpers for converting between human form values and base units.

`getTransferOptions(sourceChain)` returns transfer-valid destinations for the selected source chain.

```js
[
  {
    chain: "hydration",
    label: "Hydration",
    assets: ["DOT", "USDT"],
  },
]
```

`getSwapOptions(sourceChain)` returns swap-valid destinations and pairs.

```js
[
  {
    chain: "hydration",
    label: "Hydration",
    pairs: [
      {
        assetIn: "DOT",
        assetOut: "USDT",
        settlementChains: ["polkadot-hub"],
      },
    ],
  },
]
```

`getExecuteOptions(sourceChain)` returns execute-valid destinations and capabilities.

```js
[
  {
    chain: "moonbeam",
    label: "Moonbeam",
    capabilities: [
      {
        executionType: "call",
        assets: ["DOT"],
      },
    ],
  },
]
```

Typical form flow:

```js
const chains = listChains();
const sourceChain = chains[0].key;
const walletType = getChainWalletType(sourceChain);

const transferDestinations = getTransferOptions(sourceChain);
const destinationChain = transferDestinations[0].chain;
const transferAssets =
  transferDestinations.find((option) => option.chain === destinationChain)?.assets ?? [];

const decimals = getAssetDecimals(transferAssets[0]);
```

Use `listAssets()` when you need general asset metadata.
Use `getTransferOptions(...)`, `getSwapOptions(...)`, and `getExecuteOptions(...)` when you need route-valid dependent selects.

## Amount Conversion

The wire format still uses base-unit integers. If your UI collects human decimal input, use the SDK helpers to convert before calling the client.

Example:

```js
import { parseAssetAmount, formatAssetAmount } from "@xroute/sdk/chains";

const amount = parseAssetAmount("DOT", "25");

await client.transfer({
  sourceChain: "moonbeam",
  destinationChain: "hydration",
  asset: "DOT",
  amount,
  recipient: "5Frecipient",
});

const received = formatAssetAmount("USDT", "49000000"); // "49"
```

Made with love ❤️ by Muwa Team.
