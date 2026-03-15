# @xroute/sdk

XRoute is a multihop cross-chain execution router on Polkadot that gives apps one SDK to transfer assets, swap, and execute calls across Polkadot Hub, Hydration, Moonbeam, and other supported routes.

`@xroute/sdk` is the integration package for XRoute.

It gives integrators one main entrypoint:

```js
const client = createXRouteClient({ apiKey });
```

Then:

```js
client.connectWallet("evm", {
  provider: window.ethereum,
  chainKey: "moonbeam",
});

await client.quote(...);
await client.transfer(...);
await client.swap(...);
await client.call(...);
await client.runFlow(...);
await client.getStatus(intentId);
await client.getTimeline(intentId);
await client.wait(intentId);
```

## Intent Surface

Current public intent surface:

- `transfer`
- `swap`
- `execute`
  - current public execution type: `call`

## Hosted Access

XRoute is designed as a **hosted integration**.

That means:

- XRoute runs the quote and relayer services
- integrators use `@xroute/sdk`
- API keys control access and limits

Base hosted API:

- `https://xroute-api.onrender.com/v1`

Recommended access model:

- free tier: limited quote volume for evaluation and integration work
- higher limits / production access: [xroute@muwa.io](mailto:xroute@muwa.io)

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

You can also override the hosted base URL explicitly:

```js
const client = createXRouteClient({
  apiKey: process.env.XROUTE_API_KEY,
  baseUrl: "https://xroute-api.onrender.com/v1",
});
```

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
} from "@xroute/sdk/chains";
import {
  getTransferOptions,
  getSwapOptions,
  getExecuteOptions,
} from "@xroute/sdk/routes";
```

These helpers are the intended source of truth for your UI option state.

## Other Exports

- `createStatusClient(...)`
- `createXRouteOperatorClient(...)`
- `createHttpQuoteProvider(...)`
- `createHttpExecutorRelayerClient(...)`
- `normalizeQuote(...)`
- `NATIVE_ASSET_ADDRESS`
- `DEFAULT_XROUTE_API_BASE_URL`

## Build And Pack

Build:

```bash
npm --prefix packages/xroute-sdk run build
```

Dry-run the npm tarball:

```bash
npm --cache ./.npm-cache pack --dry-run ./packages/xroute-sdk
```

Publish:

```bash
npm publish ./packages/xroute-sdk --access public
```
