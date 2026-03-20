import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { Binary, AccountId, metadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';

import { getAssetLocation, getParachainId } from '../packages/xroute-chain-registry/index.mjs';
import { readRouterDeploymentArtifact } from './lib/deployment-artifacts.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '..');
const defaultAccountId32 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const defaultAccountKey20 = '0x1111111111111111111111111111111111111111';
const moonbeamVdotOracleAddress = '0xEF81930Aa8ed07C17948B2E26b7bfAF20144eF2a';
const moonbeamExecuteFallbackWeight = Object.freeze({ refTime: 650000000n, proofSize: 12288n });
const rpcTimeoutMs = 5_000;
const defaultVdotOrder = Object.freeze({
  amount: 10_000_000_000n,
  gasLimit: 500_000n,
  remark: 'xroute',
  channelId: 0n,
  recipient: defaultAccountKey20,
});
const directTransferEdges = Object.freeze([
  { sourceChain: 'polkadot-hub', destinationChain: 'hydration', asset: 'DOT' },
  { sourceChain: 'hydration', destinationChain: 'polkadot-hub', asset: 'DOT' },
  { sourceChain: 'hydration', destinationChain: 'polkadot-hub', asset: 'USDT' },
  { sourceChain: 'polkadot-hub', destinationChain: 'moonbeam', asset: 'DOT' },
  { sourceChain: 'moonbeam', destinationChain: 'polkadot-hub', asset: 'DOT' },
  { sourceChain: 'polkadot-hub', destinationChain: 'bifrost', asset: 'DOT', optionalLiveInputs: true },
  { sourceChain: 'bifrost', destinationChain: 'polkadot-hub', asset: 'DOT', optionalLiveInputs: true },
  { sourceChain: 'moonbeam', destinationChain: 'bifrost', asset: 'BNC', optionalLiveInputs: true },
  { sourceChain: 'bifrost', destinationChain: 'moonbeam', asset: 'BNC', optionalLiveInputs: true },
]);
const hydrationSwapSpecs = Object.freeze([
  { assetIn: 'DOT', assetOut: 'USDT', assetInId: 5, assetOutId: 10, dexFeeBps: 30 },
  { assetIn: 'DOT', assetOut: 'HDX', assetInId: 5, assetOutId: 0, dexFeeBps: 25 },
]);

loadDotEnv(resolve(workspaceRoot, '.env'));

const runtimeClients = new Map();
const websocketTransports = new Map();
const moonbeamSlpxAdapterAddress = resolveMoonbeamSlpxAdapterAddress();

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`, () => {
    process.exit(1);
  });
});

async function main() {
  try {
    const document = {
      generatedAt: new Date().toISOString(),
      transferEdges: await collectSequentially(directTransferEdges, estimateTransferEdge, (edge) =>
        `${edge.sourceChain}->${edge.destinationChain} ${edge.asset}`,
      ),
      swapRoutes: await collectSequentially(hydrationSwapSpecs, estimateHydrationSwapRoute, (spec) =>
        `${spec.assetIn}->${spec.assetOut} on hydration`,
      ),
      executeRoutes: [],
      vdotOrders: [],
    };

    process.stdout.write(`${JSON.stringify(document)}\n`);
  } finally {
    await Promise.all(
      [...websocketTransports.values()].map(
        (transport) =>
          new Promise((resolve) => {
            if (transport.ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            const timeoutId = setTimeout(() => {
              try {
                transport.ws.terminate();
              } catch {}
              resolve();
            }, 1_000);
            transport.ws.once('close', () => {
              clearTimeout(timeoutId);
              resolve();
            });
            transport.ws.close();
          }),
      ),
    );
  }

  process.exit(0);
}

async function collectSequentially(items, worker, label) {
  const results = [];
  for (const item of items) {
    try {
      process.stderr.write(`estimating ${label(item)}...\n`);
      results.push(await worker(item));
      process.stderr.write(`  done ${label(item)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (item?.optionalLiveInputs) {
        process.stderr.write(`skipping live quote input for ${label(item)}: ${message}\n`);
        continue;
      }
      throw new Error(`${label(item)}: ${message}`);
    }
  }
  return results;
}

async function estimateTransferEdge({ sourceChain, destinationChain, asset }) {
  const sourceClient = await getRuntimeClient(sourceChain);
  const destinationClient = await getRuntimeClient(destinationChain);
  const { fullXcm, remoteXcm } = buildDirectTransferMessages({
    sourceChain,
    destinationChain,
    asset,
  });
  const transportFee = isReserveChainForAsset(sourceChain, asset)
    ? extractFungibleAmount(
        await sourceClient.queryDeliveryFees(
          buildVersionedParachainLocation(destinationChain),
          fullXcm,
        ),
      )
    : await sourceClient.queryWeightToAssetFee(
        await sourceClient.queryXcmWeight(fullXcm),
        buildVersionedAssetId(sourceChain, asset),
      );
  let buyExecutionFee = await destinationClient.queryWeightToAssetFee(
    await destinationClient.queryXcmWeight(remoteXcm),
    buildVersionedAssetId(destinationChain, asset),
  );

  if (asset === 'DOT') {
    buyExecutionFee = (buyExecutionFee * 3n);
  }

  return {
    sourceChain,
    destinationChain,
    asset,
    transportFee: transportFee.toString(),
    buyExecutionFee: buyExecutionFee.toString(),
  };
}

async function estimateHydrationSwapRoute({ assetIn, assetOut, assetInId, assetOutId, dexFeeBps }) {
  const latestAnswer = await readHydrationOraclePrice({ assetAId: assetOutId, assetBId: assetInId });

  return {
    destinationChain: 'hydration',
    assetIn,
    assetOut,
    priceNumerator: latestAnswer.toString(),
    priceDenominator: '100000000',
    dexFeeBps,
  };
}

async function estimateMoonbeamVdotExecuteRoute(executionType) {
  const moonbeamClient = await getRuntimeClient('moonbeam');
  const remoteXcm = buildMoonbeamVdotExecuteRemoteXcm(executionType);
  const executionBudget = await moonbeamClient.queryWeightToAssetFee(
    await moonbeamClient.queryXcmWeight(remoteXcm),
    buildVersionedAssetId('moonbeam', 'DOT'),
  );

  return {
    destinationChain: 'moonbeam',
    asset: 'DOT',
    executionType,
    executionBudget: executionBudget.toString(),
  };
}

async function fetchVdotOrderPricing() {
  const rpcUrl = requiredSetting('XROUTE_MOONBEAM_RPC_URL', process.env.XROUTE_MOONBEAM_RPC_URL);
  const xcDotAddress = requiredSetting(
    'XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS',
    process.env.XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS,
  );
  const currencyId = await moonbeamOracleCall({
    rpcUrl,
    selector: '0xb2306010',
    args: [encodeAddressWord(xcDotAddress)],
  });
  const bytes2CurrencyId = `0x${currencyId.slice(-4)}`;
  const pool = await moonbeamOracleCall({
    rpcUrl,
    selector: '0x1443d5b0',
    args: [encodeBytes2Word(bytes2CurrencyId)],
  });
  const rates = await moonbeamOracleCall({
    rpcUrl,
    selector: '0x690adb53',
    args: [],
  });

  return {
    poolAssetAmount: decodeUint256(pool, 0).toString(),
    poolVassetAmount: decodeUint256(pool, 32).toString(),
    mintFeeBps: Number(decodeUint256(rates, 0)),
    redeemFeeBps: Number(decodeUint256(rates, 32)),
  };
}

function resolveMoonbeamSlpxAdapterAddress() {
  const deployment = readRouterDeploymentArtifact({
    workspaceRoot,
    deploymentProfile: 'mainnet',
    chainKey: 'moonbeam',
  });
  const adapterAddress =
    deployment?.artifact?.contracts?.XRouteMoonbeamSlpxAdapter ??
    deployment?.artifact?.settings?.moonbeamSlpxAdapterAddress;

  return requiredHexAddress(
    'moonbeam mainnet XRouteMoonbeamSlpxAdapter deployment',
    adapterAddress,
  );
}

async function moonbeamOracleCall({ rpcUrl, selector, args }) {
  const data = selector + args.map(encodeCallWord).join('');
  const result = await rpcRequest(rpcUrl, 'eth_call', [
    {
      to: moonbeamVdotOracleAddress,
      data,
    },
    'latest',
  ]);
  if (typeof result !== 'string' || !result.startsWith('0x')) {
    throw new Error('moonbeam oracle returned invalid eth_call payload');
  }
  return result;
}

function encodeCallWord(word) {
  if (typeof word === 'string') {
    return word.replace(/^0x/, '');
  }

  if (typeof word === 'number' || typeof word === 'bigint') {
    return encodeU256Be(word).toString('hex');
  }

  if (Buffer.isBuffer(word) || word instanceof Uint8Array) {
    return Buffer.from(word).toString('hex');
  }

  throw new Error(`unsupported call word type: ${typeof word}`);
}

async function readHydrationOraclePrice({ assetAId, assetBId }) {
  const rpcUrl = resolveRuntimeRpcUrl('hydration');
  const to = hydrationOracleAddress(assetAId, assetBId);
  const result = await rpcRequest(rpcUrl, 'eth_call', [
    {
      to,
      data: '0x50d25bcd',
    },
    'latest',
  ]);
  return decodeUint256(result, 0);
}

function buildDirectTransferMessages({ sourceChain, destinationChain, asset }) {
  const usesReserveWithdraw =
    !isReserveChainForAsset(sourceChain, asset)
    && reserveChainForAsset(asset) === destinationChain;

  const remoteXcm = (isReserveChainForAsset(sourceChain, asset) || usesReserveWithdraw)
    ? buildVersionedXcm([
        buildBuyExecutionInstruction(destinationChain, asset),
        buildDepositAssetInstruction(destinationChain),
      ])
    : buildVersionedXcm([buildDepositAssetInstruction(destinationChain)]);

  const fullXcm = isReserveChainForAsset(sourceChain, asset)
    ? buildVersionedXcm([
        {
          type: 'SetFeesMode',
          value: { jit_withdraw: true },
        },
        {
          type: 'TransferReserveAsset',
          value: {
            assets: [buildAsset(sourceChain, asset, 1n)],
            dest: buildParachainLocation(destinationChain),
            xcm: remoteXcm.value,
          },
        },
      ])
    : usesReserveWithdraw
      ? buildVersionedXcm([
          {
            type: 'WithdrawAsset',
            value: [buildAsset(sourceChain, asset, 1n)],
          },
          {
            type: 'InitiateReserveWithdraw',
            value: {
              assets: {
                type: 'Wild',
                value: {
                  type: 'AllCounted',
                  value: 1,
                },
              },
              reserve: buildParachainLocation(destinationChain),
              xcm: remoteXcm.value,
            },
          },
        ])
    : buildVersionedXcm([
        {
          type: 'SetFeesMode',
          value: { jit_withdraw: true },
        },
        {
          type: 'WithdrawAsset',
          value: [buildAsset(sourceChain, asset, 1n)],
        },
        {
          type: 'PayFees',
          value: {
            asset: buildAsset(sourceChain, asset, 1n),
          },
        },
        {
          type: 'InitiateTransfer',
          value: {
            destination: buildParachainLocation(destinationChain),
            remote_fees: {
              type: 'Teleport',
              value: {
                type: 'Definite',
                value: [buildAsset(sourceChain, asset, 1n)],
              },
            },
            preserve_origin: false,
            assets: [
              {
                type: 'Teleport',
                value: {
                  type: 'Wild',
                  value: {
                    type: 'AllCounted',
                    value: 1,
                  },
                },
              },
            ],
            remote_xcm: remoteXcm.value,
          },
        },
      ]);

  return { fullXcm, remoteXcm };
}

function buildMoonbeamVdotExecuteRemoteXcm(executionType) {
  const selector = executionType === 'mint-vdot' ? '0x58419dbb' : '0xc8dac3f0';
  const orderCall = encodeVdotOrderCalldata({
    selector,
    amount: defaultVdotOrder.amount,
    recipient: defaultVdotOrder.recipient,
    remark: defaultVdotOrder.remark,
    channelId: defaultVdotOrder.channelId,
  });
  const runtimeCallData = encodeMoonbeamEthereumXcmCall({
    contractAddress: moonbeamSlpxAdapterAddress,
    gasLimit: defaultVdotOrder.gasLimit,
    value: 0n,
    calldata: orderCall,
  });

  return buildVersionedXcm([
    {
      type: 'DepositAsset',
      value: {
        assets: {
          type: 'Wild',
          value: {
            type: 'AllCounted',
            value: 1,
          },
        },
        beneficiary: buildAccountKey20Beneficiary(moonbeamSlpxAdapterAddress),
      },
    },
    {
      type: 'Transact',
      value: {
        origin_kind: {
          type: 'SovereignAccount',
          value: undefined,
        },
        fallback_max_weight: {
          ref_time: moonbeamExecuteFallbackWeight.refTime,
          proof_size: moonbeamExecuteFallbackWeight.proofSize,
        },
        call: Binary.fromBytes(runtimeCallData),
      },
    },
  ]);
}

function buildVersionedXcm(value) {
  return {
    type: 'V5',
    value,
  };
}

function buildVersionedParachainLocation(chainKey) {
  return {
    type: 'V5',
    value: buildParachainLocation(chainKey),
  };
}

function buildVersionedAssetId(chainKey, assetKey) {
  const location = getAssetLocation(assetKey, chainKey);
  return {
    type: 'V5',
    value: {
      parents: location.parents,
      interior: buildInterior(location.interior),
    },
  };
}

function buildAsset(chainKey, assetKey, amount) {
  const location = getAssetLocation(assetKey, chainKey);
  return {
    id: {
      parents: location.parents,
      interior: buildInterior(location.interior),
    },
    fun: {
      type: 'Fungible',
      value: BigInt(amount),
    },
  };
}

function buildBuyExecutionInstruction(chainKey, assetKey) {
  return {
    type: 'BuyExecution',
    value: {
      fees: buildAsset(chainKey, assetKey, 1n),
      weight_limit: {
        type: 'Unlimited',
        value: undefined,
      },
    },
  };
}

function buildDepositAssetInstruction(chainKey) {
  return {
    type: 'DepositAsset',
    value: {
      assets: {
        type: 'Wild',
        value: {
          type: 'AllCounted',
          value: 1,
        },
      },
      beneficiary:
        chainKey === 'moonbeam'
          ? buildAccountKey20Beneficiary(defaultAccountKey20)
          : buildAccountId32Beneficiary(defaultAccountId32),
    },
  };
}

function buildParachainLocation(chainKey) {
  return {
    parents: 1,
    interior: {
      type: 'X1',
      value: {
        type: 'Parachain',
        value: getParachainId(chainKey),
      },
    },
  };
}

function buildAccountId32Beneficiary(accountId) {
  return {
    parents: 0,
    interior: {
      type: 'X1',
      value: {
        type: 'AccountId32',
        value: {
          network: undefined,
          id: Binary.fromBytes(AccountId().enc(accountId)),
        },
      },
    },
  };
}

function buildAccountKey20Beneficiary(address) {
  return {
    parents: 0,
    interior: {
      type: 'X1',
      value: {
        type: 'AccountKey20',
        value: {
          network: undefined,
          key: Binary.fromBytes(parseHexBytes(address)),
        },
      },
    },
  };
}

function buildInterior(interior) {
  switch (interior.type) {
    case 'here':
      return { type: 'Here', value: undefined };
    case 'x1':
      return { type: 'X1', value: buildJunction(interior.value) };
    case 'x2':
      return { type: 'X2', value: interior.value.map(buildJunction) };
    case 'x3':
      return { type: 'X3', value: interior.value.map(buildJunction) };
    case 'x4':
      return { type: 'X4', value: interior.value.map(buildJunction) };
    default:
      throw new Error(`unsupported XCM interior type: ${interior.type}`);
  }
}

function buildJunction(junction) {
  switch (junction.type) {
    case 'parachain':
      return { type: 'Parachain', value: junction.value };
    case 'pallet-instance':
      return { type: 'PalletInstance', value: junction.value };
    case 'general-index':
      return { type: 'GeneralIndex', value: BigInt(junction.value) };
    default:
      throw new Error(`unsupported XCM junction type: ${junction.type}`);
  }
}

function isReserveChainForAsset(chainKey, assetKey) {
  return reserveChainForAsset(assetKey) === chainKey;
}

function reserveChainForAsset(assetKey) {
  switch (assetKey) {
    case 'DOT':
    case 'USDT':
      return 'polkadot-hub';
    case 'HDX':
      return 'hydration';
    case 'VDOT':
      return 'bifrost';
    case 'BNC':
      return 'bifrost';
    default:
      throw new Error(`unsupported asset: ${assetKey}`);
  }
}

async function getRuntimeClient(chainKey) {
  if (!runtimeClients.has(chainKey)) {
    runtimeClients.set(chainKey, await createRuntimeClient(chainKey));
  }

  return runtimeClients.get(chainKey);
}

async function createRuntimeClient(chainKey) {
  const rpcUrl = resolveRuntimeRpcUrl(chainKey);
  process.stderr.write(`    fetching metadata for ${chainKey} from ${maskUrl(rpcUrl)}...\n`);
  const metadataHex = await rpcRequest(rpcUrl, 'state_getMetadata', []);
  process.stderr.write(`    decoding metadata for ${chainKey}...\n`);
  const decodedMetadata = unifyMetadata(metadata.dec(metadataHex));
  const dynamicBuilder = getDynamicBuilder(getLookupFn(decodedMetadata));
  const versionedLocation = dynamicBuilder.buildDefinition(
    findLookupTypeId(decodedMetadata, ['xcm::VersionedLocation']),
  );
  const versionedXcm = dynamicBuilder.buildDefinition(
    findLookupTypeId(decodedMetadata, ['xcm::VersionedXcm']),
  );
  const versionedAssets = dynamicBuilder.buildDefinition(
    findLookupTypeId(decodedMetadata, ['xcm::VersionedAssets']),
  );
  const versionedAssetId = dynamicBuilder.buildDefinition(
    findLookupTypeId(decodedMetadata, ['xcm::VersionedAssetId']),
  );
  const weight = dynamicBuilder.buildDefinition(
    findLookupTypeId(decodedMetadata, ['sp_weights::weight_v2::Weight']),
  );

  return {
    async queryDeliveryFees(destinationLocation, versionedXcmValue) {
      const encodedArgs = Buffer.concat([
        Buffer.from(versionedLocation.enc(destinationLocation)),
        Buffer.from(versionedXcm.enc(versionedXcmValue)),
      ]);
      const resultHex = await rpcRequest(rpcUrl, 'state_call', [
        'XcmPaymentApi_query_delivery_fees',
        `0x${encodedArgs.toString('hex')}`,
      ]);
      return versionedAssets.dec(stripResultOk(resultHex));
    },

    async queryXcmWeight(versionedXcmValue) {
      const encodedArgs = Buffer.from(versionedXcm.enc(versionedXcmValue));
      const resultHex = await rpcRequest(rpcUrl, 'state_call', [
        'XcmPaymentApi_query_xcm_weight',
        `0x${encodedArgs.toString('hex')}`,
      ]);
      return weight.dec(stripResultOk(resultHex));
    },

    async queryWeightToAssetFee(weightValue, versionedAssetIdValue) {
      const encodedArgs = Buffer.concat([
        Buffer.from(weight.enc(weightValue)),
        Buffer.from(versionedAssetId.enc(versionedAssetIdValue)),
      ]);
      const resultHex = await rpcRequest(rpcUrl, 'state_call', [
        'XcmPaymentApi_query_weight_to_asset_fee',
        `0x${encodedArgs.toString('hex')}`,
      ]);
      return decodeU128Le(stripResultOk(resultHex));
    },
  };
}

function extractFungibleAmount(versionedAssets) {
  const assets = versionedAssets?.value ?? [];
  const fungible = assets.find((asset) => asset?.fun?.type === 'Fungible');
  return fungible?.fun?.value ?? 0n;
}

function findLookupTypeId(decodedMetadata, paths) {
  for (const path of paths) {
    const entry = decodedMetadata.lookup.find((candidate) => candidate.path?.join('::') === path);
    if (entry) {
      return entry.id;
    }
  }

  throw new Error(`missing lookup type for paths: ${paths.join(', ')}`);
}

async function rpcRequest(url, method, params) {
  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    return websocketRpcRequest(url, method, params);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), rpcTimeoutMs);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    signal: controller.signal,
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method,
      params,
    }),
  });
  clearTimeout(timeoutId);
  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status} on ${maskUrl(url)}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`${method} failed on ${maskUrl(url)}: ${json.error.message ?? JSON.stringify(json.error)}`);
  }

  return json.result;
}

function resolveRuntimeRpcUrl(chainKey) {
  switch (chainKey) {
    case 'polkadot-hub':
      return requiredSetting(
        'XROUTE_HUB_XCM_RPC_URL',
        process.env.XROUTE_HUB_XCM_RPC_URL?.trim() || 'https://polkadot-asset-hub-rpc.polkadot.io',
      );
    case 'hydration':
      return resolveReadonlyRpcUrl(
        chainKey,
        'XROUTE_HYDRATION_XCM_RPC_URL',
        'XROUTE_HYDRATION_RPC_URL',
      );
    case 'moonbeam':
      return resolveReadonlyRpcUrl(
        chainKey,
        'XROUTE_MOONBEAM_XCM_RPC_URL',
        'XROUTE_MOONBEAM_RPC_URL',
      );
    case 'bifrost':
      return resolveReadonlyRpcUrl(
        chainKey,
        'XROUTE_BIFROST_XCM_RPC_URL',
        'XROUTE_BIFROST_RPC_URL',
        'wss://hk.p.bifrost-rpc.liebi.com/ws',
      );
    default:
      throw new Error(`unsupported chain: ${chainKey}`);
  }
}

function resolveReadonlyRpcUrl(chainKey, readonlyName, fallbackName, fallbackValue = null) {
  const readonlyValue = process.env[readonlyName]?.trim();
  if (readonlyValue) {
    return normalizeRuntimeRpcUrl(chainKey, readonlyValue);
  }

  return normalizeRuntimeRpcUrl(chainKey, requiredSetting(
    fallbackValue === null ? fallbackName : `${readonlyName} or ${fallbackName}`,
    process.env[fallbackName]?.trim() || fallbackValue,
  ));
}

function normalizeRuntimeRpcUrl(chainKey, rpcUrl) {
  const normalized = String(rpcUrl ?? '').trim();
  if (chainKey === 'bifrost') {
    return normalizeKnownBifrostPublicRpcUrl(normalized);
  }

  return normalized;
}

function normalizeKnownBifrostPublicRpcUrl(rpcUrl) {
  let parsed;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return rpcUrl;
  }

  if (!parsed.hostname.endsWith('bifrost-rpc.liebi.com')) {
    return rpcUrl;
  }

  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    if (normalizedPath === '' || normalizedPath === '/') {
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      parsed.pathname = '/ws';
      return parsed.toString();
    }
  }

  return rpcUrl;
}

async function websocketRpcRequest(url, method, params) {
  const transport = await getWebsocketTransport(url);

  return new Promise((resolve, reject) => {
    const id = transport.nextId;
    transport.nextId += 1;
    const timeoutId = setTimeout(() => {
      transport.pending.delete(id);
      reject(new Error(`${method} timed out on ${maskUrl(url)}`));
    }, rpcTimeoutMs);
    transport.pending.set(id, {
      resolve(value) {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timeoutId);
        reject(error);
      },
    });
    transport.ws.send(
      JSON.stringify({
        id,
        jsonrpc: '2.0',
        method,
        params,
      }),
    );
  });
}

async function getWebsocketTransport(url) {
  if (websocketTransports.has(url)) {
    return websocketTransports.get(url);
  }

  const ws = new WebSocket(url, { handshakeTimeout: rpcTimeoutMs });
  const transport = {
    ws,
    nextId: 1,
    pending: new Map(),
  };

  ws.on('message', (raw) => {
    const payload = JSON.parse(raw.toString());
    const request = transport.pending.get(payload.id);
    if (!request) {
      return;
    }

    transport.pending.delete(payload.id);
    if (payload.error) {
      request.reject(
        new Error(
          `${payload.error.message ?? 'websocket rpc failed'} on ${maskUrl(url)}`,
        ),
      );
      return;
    }

    request.resolve(payload.result);
  });

  ws.on('error', (error) => {
    for (const request of transport.pending.values()) {
      request.reject(error);
    }
    transport.pending.clear();
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  websocketTransports.set(url, transport);
  return transport;
}

function hydrationOracleAddress(assetAId, assetBId) {
  return `0x00000101${Buffer.from('omnipool', 'utf8').toString('hex')}${encodeU32Hex(assetAId)}${encodeU32Hex(assetBId)}`;
}

function encodeU32Hex(value) {
  return Number(value).toString(16).padStart(8, '0');
}

function encodeVdotOrderCalldata({ selector, amount, recipient, remark, channelId }) {
  const remarkBytes = Buffer.from(remark, 'utf8');
  return Buffer.concat([
    parseHexBytes(selector),
    encodeU256Be(amount),
    encodeAddressWord(recipient),
    encodeU256Be(128),
    encodeU256Be(channelId),
    encodeU256Be(remarkBytes.length),
    padRight(remarkBytes),
  ]);
}

function encodeMoonbeamEthereumXcmCall({ contractAddress, gasLimit, value, calldata }) {
  return Buffer.concat([
    Buffer.from([109, 0, 1]),
    encodeU256Le(gasLimit),
    Buffer.from([0]),
    parseHexBytes(contractAddress),
    encodeU256Le(value),
    encodeBytes(calldata),
    Buffer.from([0]),
  ]);
}

function encodeBytes(value) {
  return Buffer.concat([encodeCompact(value.length), value]);
}

function padRight(value) {
  const remainder = value.length % 32;
  if (remainder === 0) {
    return value;
  }
  return Buffer.concat([value, Buffer.alloc(32 - remainder)]);
}

function encodeAddressWord(address) {
  return Buffer.concat([Buffer.alloc(12), parseHexBytes(address)]);
}

function encodeBytes2Word(bytes2) {
  return Buffer.concat([parseHexBytes(bytes2), Buffer.alloc(30)]);
}

function encodeU256Le(value) {
  const bytes = Buffer.alloc(32);
  let remaining = BigInt(value);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function encodeU256Be(value) {
  const bytes = Buffer.alloc(32);
  let remaining = BigInt(value);
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function encodeCompact(value) {
  const normalized = BigInt(value);
  if (normalized < 1n << 6n) {
    return Buffer.from([Number(normalized << 2n)]);
  }
  if (normalized < 1n << 14n) {
    const encoded = Number((normalized << 2n) | 1n);
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(encoded);
    return bytes;
  }
  if (normalized < 1n << 30n) {
    const encoded = Number((normalized << 2n) | 2n);
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(encoded);
    return bytes;
  }

  let hex = normalized.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  let bytes = Buffer.from(hex, 'hex');
  while (bytes.length > 0 && bytes[0] === 0) {
    bytes = bytes.subarray(1);
  }
  return Buffer.concat([
    Buffer.from([((bytes.length - 4) << 2) | 0b11]),
    Buffer.from(bytes).reverse(),
  ]);
}

function stripResultOk(hex) {
  const bytes = Buffer.from(requiredHex('result', hex).slice(2), 'hex');
  if (bytes.length === 0 || bytes[0] !== 0) {
    throw new Error(`runtime call failed: ${hex}`);
  }
  return `0x${bytes.subarray(1).toString('hex')}`;
}

function decodeU128Le(hex) {
  const bytes = Buffer.from(requiredHex('result', hex).slice(2), 'hex');
  let value = 0n;
  for (let index = 0; index < 16; index += 1) {
    value |= BigInt(bytes[index] ?? 0) << (8n * BigInt(index));
  }
  return value;
}

function decodeUint256(hex, offsetBytes) {
  const bytes = Buffer.from(requiredHex('result', hex).slice(2), 'hex');
  const slice = bytes.subarray(offsetBytes, offsetBytes + 32);
  let value = 0n;
  for (const byte of slice) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function parseHexBytes(value) {
  return Buffer.from(requiredHex('hex', value).slice(2), 'hex');
}

function requiredHexAddress(name, value) {
  const normalized = requiredHex(name, value);
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${name} must be a 20-byte 0x-prefixed hex address`);
  }
  return normalized;
}

function requiredHex(name, value) {
  const normalized = String(value ?? '').trim();
  if (!/^0x[0-9a-fA-F]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${name} must be a valid 0x-prefixed hex string`);
  }
  return normalized.toLowerCase();
}

function requiredSetting(name, value) {
  const normalized = String(value ?? '').trim();
  if (normalized === '') {
    throw new Error(`missing required setting: ${name}`);
  }
  return normalized;
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(name in process.env)) {
      process.env[name] = value;
    }
  }
}

function maskUrl(url) {
  return String(url ?? '').replace(/(api_?key=)[^&]+/ig, '$1***');
}
