import { createClient, AccountId } from "polkadot-api";
import { getWsProvider as getWebWsProvider } from "polkadot-api/ws-provider/web";
import { getPolkadotSignerFromPjs } from "polkadot-api/pjs-signer";

import {
  toBigInt,
  assertAddress,
  assertBytes32Hex,
  assertHexString,
  assertIncluded,
  assertInteger,
  assertNonEmptyString,
} from "../../xroute-types/index.mjs";
import { computeExecutionHash } from "../../xroute-xcm/index.mjs";
import { NATIVE_ASSET_ADDRESS as ROUTER_NATIVE_ASSET_ADDRESS } from "../routers/constants.mjs";
import { createSubstrateXcmAdapter } from "../routers/substrate-xcm-adapter.mjs";

const EVM_SUBMIT_INTENT_SELECTOR = "0xdf260bc0";
const EVM_DISPATCH_INTENT_SELECTOR = "0xa65e5b7d";
const EVM_FINALIZE_SUCCESS_SELECTOR = "0x9151239f";
const EVM_FINALIZE_FAILURE_SELECTOR = "0x18b3be94";
const EVM_REFUND_SELECTOR = "0xef836308";
const EVM_PREVIEW_LOCKED_AMOUNT_SELECTOR = "0x12747753";
const EVM_PREVIEW_REFUNDABLE_SELECTOR = "0xbeb8511f";
const EVM_ALLOWANCE_SELECTOR = "0xdd62ed3e";
const EVM_BALANCE_OF_SELECTOR = "0x70a08231";
const EVM_APPROVE_SELECTOR = "0x095ea7b3";
const EVM_INTENT_SUBMITTED_TOPIC =
  "0x958ded10bf7c27600499d19f87c591832d502b52c7439827fabc5c4fe5d7d028";
const DEFAULT_EVM_SUBMIT_GAS_LIMITS = Object.freeze({
  "polkadot-hub": 250000n,
  moonbeam: 250000n,
});

export function createEvmWalletAdapter({
  provider,
  chainKey = "polkadot-hub",
  routerAddress,
  expectedNetwork = null,
  statusProvider = null,
  assetAddresses = {},
  gasLimit = null,
  autoApprove = true,
  receiptPollIntervalMs = 1_000,
  receiptTimeoutMs = 120_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!provider) {
    throw new Error("provider is required (window.ethereum or EIP-1193 compatible provider)");
  }
  if (!routerAddress) {
    throw new Error("routerAddress is required");
  }

  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const normalizedRouterAddress = assertAddress("routerAddress", routerAddress).toLowerCase();
  const normalizedGasLimit =
    gasLimit === null || gasLimit === undefined
      ? null
      : toBigInt(gasLimit, "gasLimit");
  const normalizedExpectedNetwork = normalizeExpectedEvmNetwork(expectedNetwork);
  const normalizedPollIntervalMs = assertPositiveInteger(
    "receiptPollIntervalMs",
    receiptPollIntervalMs,
  );
  const normalizedReceiptTimeoutMs = assertPositiveInteger(
    "receiptTimeoutMs",
    receiptTimeoutMs,
  );
  const normalizedFetchImpl =
    typeof fetchImpl === "function"
      ? fetchImpl
      : null;
  const readOnlyRpcUrl = normalizedExpectedNetwork?.rpcUrls?.[0] ?? null;
  const assetAddressResolver = createWalletAssetAddressResolver(assetAddresses);

  let cachedAddress = null;
  let ensuredChainId = null;

  async function ensureExpectedChain() {
    if (!normalizedExpectedNetwork) {
      return null;
    }

    const currentChainId = await provider.request({
      method: "eth_chainId",
    });
    const normalizedCurrentChainId = normalizeRpcHex(currentChainId, "eth_chainId");
    if (normalizedCurrentChainId === normalizedExpectedNetwork.chainIdHex) {
      ensuredChainId = normalizedCurrentChainId;
      return normalizedCurrentChainId;
    }

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: normalizedExpectedNetwork.chainIdHex }],
      });
    } catch (error) {
      if (isUnknownChainError(error)) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [buildAddEthereumChainParams(normalizedExpectedNetwork)],
        });
      } else {
        throw createUnexpectedNetworkError(normalizedChainKey, normalizedExpectedNetwork.chainName);
      }
    }

    const resolvedChainId = normalizeRpcHex(
      await provider.request({ method: "eth_chainId" }),
      "eth_chainId",
    );
    if (resolvedChainId !== normalizedExpectedNetwork.chainIdHex) {
      throw createUnexpectedNetworkError(normalizedChainKey, normalizedExpectedNetwork.chainName);
    }

    ensuredChainId = resolvedChainId;
    return resolvedChainId;
  }

  async function getAddress() {
    if (cachedAddress) {
      return cachedAddress;
    }

    if (ensuredChainId !== normalizedExpectedNetwork?.chainIdHex) {
      await ensureExpectedChain();
    }

    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts || accounts.length === 0) {
      throw new Error("no EVM accounts available");
    }

    cachedAddress = assertAddress("evmAccount", accounts[0]).toLowerCase();
    return cachedAddress;
  }

  async function sendTransaction({ to, data, value = null }) {
    if (ensuredChainId !== normalizedExpectedNetwork?.chainIdHex) {
      await ensureExpectedChain();
    }
    const from = await getAddress();
    const baseTxParams = {
      from,
      to: assertAddress("transaction.to", to),
      data: assertHexString("transaction.data", data),
      ...(value !== null ? { value: toRpcQuantity(value, "value") } : {}),
    };
    const gas =
      normalizedGasLimit
      ?? await estimateGasWithHeadroom(baseTxParams);
    const gasPrice = await readGasPrice();
    await ensureSufficientNativeBalanceForTransaction({
      ownerAddress: from,
      value: value ?? 0n,
      gas,
      gasPrice,
    });
    const txParams = {
      ...baseTxParams,
      gas: toRpcQuantity(gas, "gasLimit"),
    };

    const txHash = assertHexString(
      "eth_sendTransaction.txHash",
      await provider.request({
        method: "eth_sendTransaction",
        params: [txParams],
      }),
    );

    const receipt = await waitForEvmReceipt({
      provider,
      txHash,
      pollIntervalMs: normalizedPollIntervalMs,
      timeoutMs: normalizedReceiptTimeoutMs,
    });
    assertEvmReceiptSucceeded(receipt, txHash);

    return { txHash, receipt };
  }

  async function readUintFromRouter(calldata) {
    const response = await requestViaWalletProvider({
      method: "eth_call",
      params: [
        {
          to: normalizedRouterAddress,
          data: assertHexString("eth_call.data", calldata),
        },
        "latest",
      ],
    });

    return parseRpcUint256(response, "eth_call result");
  }

  async function readUintFromRouterWith(requestImpl, calldata) {
    const response = await requestImpl({
      method: "eth_call",
      params: [
        {
          to: normalizedRouterAddress,
          data: assertHexString("eth_call.data", calldata),
        },
        "latest",
      ],
    });

    return parseRpcUint256(response, "eth_call result");
  }

  async function previewLockedAmount(request) {
    return readUintFromRouter(encodePreviewLockedAmountCalldata(request));
  }

  async function previewRefundableAmount(intentId) {
    return readUintFromRouter(encodePreviewRefundableAmountCalldata(intentId));
  }

  async function readAllowance({ assetAddress, ownerAddress, spenderAddress }) {
    if (ensuredChainId !== normalizedExpectedNetwork?.chainIdHex) {
      await ensureExpectedChain();
    }
    const result = await provider.request({
      method: "eth_call",
      params: [
        {
          to: assertAddress("assetAddress", assetAddress),
          data: encodeAllowanceCalldata({ ownerAddress, spenderAddress }),
        },
        "latest",
      ],
    });

    return parseRpcUint256(result, "allowance");
  }

  async function readTokenBalance({ assetAddress, ownerAddress }) {
    if (ensuredChainId !== normalizedExpectedNetwork?.chainIdHex) {
      await ensureExpectedChain();
    }
    const result = await provider.request({
      method: "eth_call",
      params: [
        {
          to: assertAddress("assetAddress", assetAddress),
          data: encodeBalanceOfCalldata({ ownerAddress }),
        },
        "latest",
      ],
    });

    return parseRpcUint256(result, "balanceOf");
  }

  async function readNativeBalance(ownerAddress) {
    if (ensuredChainId !== normalizedExpectedNetwork?.chainIdHex) {
      await ensureExpectedChain();
    }
    const result = await provider.request({
      method: "eth_getBalance",
      params: [assertAddress("ownerAddress", ownerAddress), "latest"],
    });

    return parseRpcUint256(result, "eth_getBalance");
  }

  async function readGasPrice() {
    const result = await requestViaWalletProvider({
      method: "eth_gasPrice",
      params: [],
    });

    return parseRpcUint256(result, "eth_gasPrice");
  }

  async function readGasPriceWith(requestImpl) {
    const result = await requestImpl({
      method: "eth_gasPrice",
      params: [],
    });

    return parseRpcUint256(result, "eth_gasPrice");
  }

  async function ensureSufficientAssetBalance({ assetAddress, ownerAddress, requiredAmount }) {
    if (isNativeAddress(assetAddress)) {
      const balance = await readNativeBalance(ownerAddress);
      if (balance < requiredAmount) {
        throw createInsufficientBalanceError({
          chainKey: normalizedChainKey,
          assetAddress,
          ownerAddress,
          balance,
          needed: requiredAmount,
        });
      }
      return balance;
    }

    const balance = await readTokenBalance({ assetAddress, ownerAddress });
    if (balance < requiredAmount) {
      throw createInsufficientBalanceError({
        chainKey: normalizedChainKey,
        assetAddress,
        ownerAddress,
        balance,
        needed: requiredAmount,
      });
    }
    return balance;
  }

  async function estimateGasWithHeadroom(txParams) {
    try {
      const estimate = parseRpcUint256(
        await requestViaWalletProvider({
          method: "eth_estimateGas",
          params: [txParams],
        }),
        "eth_estimateGas",
      );
      return (estimate * 12n + 9n) / 10n;
    } catch (error) {
      throw describeRpcPreflightError(error, normalizedChainKey);
    }
  }

  async function estimateGasWithHeadroomUsing(requestImpl, txParams) {
    try {
      const estimate = parseRpcUint256(
        await requestImpl({
          method: "eth_estimateGas",
          params: [txParams],
        }),
        "eth_estimateGas",
      );
      return (estimate * 12n + 9n) / 10n;
    } catch (error) {
      throw describeRpcPreflightError(error, normalizedChainKey);
    }
  }

  async function ensureSufficientNativeBalanceForTransaction({
    ownerAddress,
    value,
    gas,
    gasPrice,
  }) {
    const balance = await readNativeBalance(ownerAddress);
    const required = value + (gas * gasPrice);
    if (balance < required) {
      throw new Error(
        `Insufficient native balance for gas on ${normalizedChainKey}. Wallet ${ownerAddress} has ${balance.toString()} units but needs ${required.toString()} including gas.`,
      );
    }
  }

  async function ensureAllowance({ assetAddress, ownerAddress, requiredAmount }) {
    if (!autoApprove || isNativeAddress(assetAddress)) {
      return null;
    }

    const currentAllowance = await readAllowance({
      assetAddress,
      ownerAddress,
      spenderAddress: normalizedRouterAddress,
    });
    if (currentAllowance >= requiredAmount) {
      return null;
    }

    const { txHash } = await sendTransaction({
      to: assetAddress,
      data: encodeApproveCalldata({
        spenderAddress: normalizedRouterAddress,
        amount: requiredAmount,
      }),
    });

    return txHash;
  }

  function resolveGasAssetMetadata() {
    const nativeCurrency = normalizedExpectedNetwork?.nativeCurrency;
    if (nativeCurrency?.symbol) {
      return {
        asset: assertNonEmptyString("nativeCurrency.symbol", nativeCurrency.symbol),
        decimals:
          Number.isInteger(nativeCurrency.decimals) && nativeCurrency.decimals >= 0
            ? nativeCurrency.decimals
            : 18,
      };
    }

    switch (normalizedChainKey) {
      case "moonbeam":
        return { asset: "GLMR", decimals: 18 };
      case "polkadot-hub":
        return { asset: "DOT", decimals: 18 };
      default:
        return { asset: "native", decimals: 18 };
    }
  }

  function resolveDefaultSubmitGasLimit() {
    return DEFAULT_EVM_SUBMIT_GAS_LIMITS[normalizedChainKey] ?? 250000n;
  }

  async function requestViaWalletProvider({ method, params }) {
    if (ensuredChainId !== normalizedExpectedNetwork?.chainIdHex) {
      await ensureExpectedChain();
    }

    return provider.request({
      method,
      params,
    });
  }

  async function requestViaReadonlyRpc({ method, params }) {
    if (!readOnlyRpcUrl || !normalizedFetchImpl) {
      throw new Error("readonly RPC transport is unavailable");
    }

    const response = await normalizedFetchImpl(readOnlyRpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    if (!response?.ok) {
      throw new Error(`readonly RPC ${method} request failed with status ${response?.status ?? "unknown"}`);
    }

    const payload = await response.json();
    if (payload?.error) {
      throw new Error(payload.error.message ?? `readonly RPC ${method} request failed`);
    }

    return payload?.result;
  }

  function createEstimationRequestTransport() {
    if (!readOnlyRpcUrl || !normalizedFetchImpl) {
      return requestViaWalletProvider;
    }

    return async ({ method, params }) => {
      try {
        return await requestViaReadonlyRpc({ method, params });
      } catch {
        return requestViaWalletProvider({ method, params });
      }
    };
  }

  const routerAdapter = {
    async estimateSubmissionCost({ owner, request }) {
      const normalizedRequest = normalizeRouterIntentRequest(request);
      const signerAddress = await getAddress();
      if (owner) {
        const normalizedOwner = assertAddress("owner", owner).toLowerCase();
        if (normalizedOwner !== signerAddress) {
          throw new Error(`owner ${normalizedOwner} does not match signer ${signerAddress}`);
        }
      }

      const estimateRequest = createEstimationRequestTransport();
      const lockedAmount = await readUintFromRouterWith(
        estimateRequest,
        encodePreviewLockedAmountCalldata(normalizedRequest),
      );
      const value = isNativeAddress(normalizedRequest.asset) ? lockedAmount : 0n;
      const gasLimit =
        normalizedGasLimit
        ?? await (async () => {
          try {
            return await estimateGasWithHeadroomUsing(estimateRequest, {
              from: signerAddress,
              to: normalizedRouterAddress,
              data: encodeSubmitIntentCalldata(normalizedRequest),
              ...(value > 0n ? { value: toRpcQuantity(value, "value") } : {}),
            });
          } catch {
            return resolveDefaultSubmitGasLimit();
          }
        })();
      const gasPrice = await readGasPriceWith(estimateRequest);
      const gasAsset = resolveGasAssetMetadata();

      return Object.freeze({
        chainKey: normalizedChainKey,
        lockedAmount,
        gasLimit,
        gasPrice,
        gasFee: gasLimit * gasPrice,
        gasAsset: gasAsset.asset,
        gasAssetDecimals: gasAsset.decimals,
        value,
      });
    },

    async submitIntent({ owner, request }) {
      const normalizedRequest = normalizeRouterIntentRequest(request);
      const signerAddress = await getAddress();
      if (owner) {
        const normalizedOwner = assertAddress("owner", owner).toLowerCase();
        if (normalizedOwner !== signerAddress) {
          throw new Error(`owner ${normalizedOwner} does not match signer ${signerAddress}`);
        }
      }

      const lockedAmount = await previewLockedAmount(normalizedRequest);
      await ensureSufficientAssetBalance({
        assetAddress: normalizedRequest.asset,
        ownerAddress: signerAddress,
        requiredAmount: lockedAmount,
      });
      const approvalTxHash = await ensureAllowance({
        assetAddress: normalizedRequest.asset,
        ownerAddress: signerAddress,
        requiredAmount: lockedAmount,
      });
      const { txHash, receipt } = await sendTransaction({
        to: normalizedRouterAddress,
        data: encodeSubmitIntentCalldata(normalizedRequest),
        value: isNativeAddress(normalizedRequest.asset) ? lockedAmount : null,
      });
      const intentId = extractIntentIdFromSubmitReceipt({
        receipt,
        routerAddress: normalizedRouterAddress,
        txHash,
      });

      return {
        intentId,
        txHash,
        lockedAmount,
        approvalTxHash,
        request: normalizedRequest,
      };
    },

    async dispatchIntent({ intentId, request }) {
      const normalizedIntentId = assertBytes32Hex("intentId", intentId);
      const normalizedRequest = normalizeDispatchRequestPayload(request);
      const { txHash } = await sendTransaction({
        to: normalizedRouterAddress,
        data: encodeDispatchIntentCalldata(normalizedIntentId, normalizedRequest),
      });
      return { intentId: normalizedIntentId, txHash, request: normalizedRequest };
    },

    async finalizeSuccess({ intentId, outcomeReference, resultAssetId, resultAmount }) {
      const normalizedIntentId = assertBytes32Hex("intentId", intentId);
      const normalizedOutcomeReference = assertBytes32Hex(
        "outcomeReference",
        outcomeReference,
      );
      const normalizedResultAssetId = assertBytes32Hex("resultAssetId", resultAssetId);
      const normalizedResultAmount = toBigInt(resultAmount, "resultAmount");
      const { txHash } = await sendTransaction({
        to: normalizedRouterAddress,
        data: encodeFinalizeSuccessCalldata(
          normalizedIntentId,
          normalizedOutcomeReference,
          normalizedResultAssetId,
          normalizedResultAmount,
        ),
      });

      return {
        intentId: normalizedIntentId,
        txHash,
        outcomeReference: normalizedOutcomeReference,
        resultAssetId: normalizedResultAssetId,
        resultAmount: normalizedResultAmount,
      };
    },

    async finalizeFailure({ intentId, outcomeReference, failureReasonHash }) {
      const normalizedIntentId = assertBytes32Hex("intentId", intentId);
      const normalizedOutcomeReference = assertBytes32Hex(
        "outcomeReference",
        outcomeReference,
      );
      const normalizedFailureReasonHash = assertBytes32Hex(
        "failureReasonHash",
        failureReasonHash,
      );
      const { txHash } = await sendTransaction({
        to: normalizedRouterAddress,
        data: encodeFinalizeFailureCalldata(
          normalizedIntentId,
          normalizedOutcomeReference,
          normalizedFailureReasonHash,
        ),
      });

      return {
        intentId: normalizedIntentId,
        txHash,
        outcomeReference: normalizedOutcomeReference,
        failureReasonHash: normalizedFailureReasonHash,
      };
    },

    async refundFailedIntent({ intentId, refundAmount }) {
      const normalizedIntentId = assertBytes32Hex("intentId", intentId);
      const normalizedRefundAmount = toBigInt(refundAmount, "refundAmount");
      const { txHash } = await sendTransaction({
        to: normalizedRouterAddress,
        data: encodeRefundCalldata(normalizedIntentId, normalizedRefundAmount),
      });

      return {
        intentId: normalizedIntentId,
        txHash,
        refundAmount: normalizedRefundAmount,
      };
    },

    async previewRefundableAmount(intentId) {
      return previewRefundableAmount(assertBytes32Hex("intentId", intentId));
    },
  };

  return {
    address: null,
    async getAddress() {
      return getAddress();
    },
    routerAdapter,
    statusProvider,
    assetAddressResolver,
    chainKey: normalizedChainKey,
  };
}

export function createSubstrateWalletAdapter({
  extension,
  account,
  accountAddress,
  chainKey = "hydration",
  rpcUrl,
  statusProvider = null,
  assetAddresses,
  codecContext = null,
  eventClock,
  xcmPalletNames,
  xcmWeightRuntimeApis,
  extensionDappName = "xroute",
} = {}) {
  if (!extension && !account) {
    throw new Error("extension or account is required");
  }

  const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
  const normalizedRpcUrl = assertNonEmptyString("rpcUrl", rpcUrl);
  const assetAddressResolver = assetAddresses
    ? createWalletAssetAddressResolver(assetAddresses)
    : undefined;

  let accountContextPromise = null;
  let substrateAdapterPromise = null;

  async function getAccountContext() {
    accountContextPromise ??= resolveSubstrateAccountContext({
      extension,
      account,
      accountAddress,
      extensionDappName,
    });

    return accountContextPromise;
  }

  async function getSubstrateAdapter() {
    substrateAdapterPromise ??= (async () => {
      const context = await getAccountContext();
      return createSubstrateXcmAdapter({
        chainKey: normalizedChainKey,
        rpcUrl: normalizedRpcUrl,
        ownerAddress: context.address,
        statusIndexer: statusProvider ?? undefined,
        codecContext: codecContext ?? undefined,
        eventClock: eventClock ?? undefined,
        xcmPalletNames: xcmPalletNames ?? undefined,
        xcmWeightRuntimeApis: xcmWeightRuntimeApis ?? undefined,
        clientFactory({ rpcUrl: targetRpcUrl }) {
          return createClient(getWebWsProvider(assertNonEmptyString("rpcUrl", targetRpcUrl)));
        },
        signerFactory() {
          return {
            address: context.address,
            accountIdHex: context.accountIdHex,
            signer: context.signer,
          };
        },
      });
    })();

    return substrateAdapterPromise;
  }

  const routerAdapter = {
    async estimateSubmissionCost(input) {
      const adapter = await getSubstrateAdapter();
      return adapter.estimateSubmissionCost(input);
    },

    async submitIntent(input) {
      const adapter = await getSubstrateAdapter();
      return adapter.submitIntent(input);
    },

    async dispatchIntent(input) {
      const adapter = await getSubstrateAdapter();
      return adapter.dispatchIntent(input);
    },

    async finalizeSuccess(input) {
      const adapter = await getSubstrateAdapter();
      return adapter.finalizeSuccess(input);
    },

    async finalizeFailure(input) {
      const adapter = await getSubstrateAdapter();
      return adapter.finalizeFailure(input);
    },

    async refundFailedIntent(input) {
      const adapter = await getSubstrateAdapter();
      return adapter.refundFailedIntent(input);
    },

    async previewRefundableAmount(intentId) {
      const adapter = await getSubstrateAdapter();
      return adapter.previewRefundableAmount(intentId);
    },
  };

  return {
    address: null,
    async getAddress() {
      const context = await getAccountContext();
      return context.address;
    },
    routerAdapter,
    statusProvider,
    assetAddressResolver,
    submitRequestBuilder({ intent, quote, envelope, castBin = "cast" }) {
      return buildSubstrateSubmitRequest({
        intent,
        quote,
        envelope,
        castBin,
      });
    },
    chainKey: normalizedChainKey,
  };
}

function createWalletAssetAddressResolver(assetAddresses) {
  return async ({ chainKey, assetKey }) => {
    const normalizedChainKey = assertNonEmptyString("chainKey", chainKey);
    const normalizedAssetKey = assertNonEmptyString("assetKey", assetKey);
    const chainScoped = assetAddresses?.[normalizedChainKey];
    const lookup =
      chainScoped && typeof chainScoped === "object" ? chainScoped : assetAddresses;
    const address = lookup?.[normalizedAssetKey];
    if (!address) {
      throw new Error(`missing asset address for ${normalizedAssetKey} on ${normalizedChainKey}`);
    }

    return assertAddress("assetAddress", address);
  };
}

function buildSubstrateSubmitRequest({
  intent,
  quote,
  envelope,
  castBin = "cast",
}) {
  if (!quote?.submission) {
    throw new Error("quote.submission is required");
  }
  if (quote.quoteId !== intent.quoteId) {
    throw new Error("quote does not belong to the provided intent");
  }

  return Object.freeze({
    sourceKind: "substrate-source",
    refundAddress: assertNonEmptyString("intent.refundAddress", intent.refundAddress),
    asset: assertNonEmptyString("quote.submission.asset", quote.submission.asset),
    amount: toBigInt(quote.submission.amount, "quote.submission.amount"),
    xcmFee: toBigInt(quote.submission.xcmFee, "quote.submission.xcmFee"),
    destinationFee: toBigInt(
      quote.submission.destinationFee,
      "quote.submission.destinationFee",
    ),
    minOutputAmount: toBigInt(
      quote.submission.minOutputAmount,
      "quote.submission.minOutputAmount",
    ),
    deadline: assertInteger("intent.deadline", intent.deadline),
    executionHash: computeExecutionHash(envelope, { castBin }),
  });
}

async function resolveSubstrateAccountContext({
  extension,
  account,
  accountAddress,
  extensionDappName,
}) {
  const requestedAddress =
    accountAddress === undefined || accountAddress === null
      ? null
      : assertNonEmptyString("accountAddress", accountAddress);

  if (account) {
    return normalizeProvidedSubstrateAccount({ account, requestedAddress });
  }

  if (!extension) {
    throw new Error("extension or account is required");
  }

  const injected =
    typeof extension.enable === "function"
      ? await extension.enable(extensionDappName)
      : extension;
  const accounts = await readInjectedExtensionAccounts(injected);
  if (accounts.length === 0) {
    throw new Error("no Substrate accounts available from the extension");
  }

  const selected = selectSubstrateAccount(accounts, requestedAddress);
  if (!injected?.signer?.signPayload || !injected?.signer?.signRaw) {
    throw new Error("extension signer with signPayload/signRaw is required");
  }

  const address = assertNonEmptyString("account.address", selected.address);
  return {
    address,
    accountIdHex: substrateAddressToAccountIdHex(address),
    signer: getPolkadotSignerFromPjs(
      address,
      injected.signer.signPayload,
      injected.signer.signRaw,
    ),
  };
}

function normalizeProvidedSubstrateAccount({ account, requestedAddress }) {
  if (!account || typeof account !== "object") {
    throw new Error("account must be an object");
  }

  const address = assertNonEmptyString("account.address", account.address);
  if (requestedAddress && requestedAddress !== address) {
    throw new Error(
      `accountAddress ${requestedAddress} does not match provided account ${address}`,
    );
  }

  const signer = resolveProvidedSubstrateSigner(account, address);
  return {
    address,
    accountIdHex: substrateAddressToAccountIdHex(address),
    signer,
  };
}

function resolveProvidedSubstrateSigner(account, address) {
  if (account.polkadotSigner) {
    return account.polkadotSigner;
  }

  if (account.signer?.signPayload && account.signer?.signRaw) {
    return getPolkadotSignerFromPjs(
      address,
      account.signer.signPayload,
      account.signer.signRaw,
    );
  }

  if (account.signer) {
    return account.signer;
  }

  throw new Error(
    "account signer is required (polkadotSigner or signer with signPayload/signRaw)",
  );
}

async function readInjectedExtensionAccounts(injected) {
  const accountsSource = injected?.accounts;
  if (!accountsSource) {
    throw new Error("extension.accounts is required");
  }

  if (typeof accountsSource.get === "function") {
    const accounts = await accountsSource.get();
    return Array.isArray(accounts) ? accounts : [];
  }

  if (typeof accountsSource === "function") {
    const accounts = await accountsSource();
    return Array.isArray(accounts) ? accounts : [];
  }

  if (Array.isArray(accountsSource)) {
    return accountsSource;
  }

  throw new Error("extension.accounts must expose get() or return an array");
}

function selectSubstrateAccount(accounts, requestedAddress) {
  if (!requestedAddress) {
    return accounts[0];
  }

  const selected = accounts.find((entry) => entry?.address === requestedAddress);
  if (!selected) {
    throw new Error(`unable to find account ${requestedAddress} in extension accounts`);
  }

  return selected;
}

function substrateAddressToAccountIdHex(address) {
  return uint8ArrayToHex(AccountId().enc(assertNonEmptyString("address", address)));
}

function isNativeAddress(address) {
  return (
    assertAddress("assetAddress", address).toLowerCase()
    === ROUTER_NATIVE_ASSET_ADDRESS.toLowerCase()
  );
}

function normalizeRouterIntentRequest(request) {
  const normalized = {
    actionType: assertInteger("request.actionType", request?.actionType),
    asset: assertAddress("request.asset", request?.asset),
    refundAddress: assertAddress("request.refundAddress", request?.refundAddress),
    amount: toBigInt(request?.amount, "request.amount"),
    xcmFee: toBigInt(request?.xcmFee, "request.xcmFee"),
    destinationFee: toBigInt(request?.destinationFee, "request.destinationFee"),
    minOutputAmount: toBigInt(request?.minOutputAmount, "request.minOutputAmount"),
    deadline: BigInt(assertInteger("request.deadline", request?.deadline)),
    executionHash: assertBytes32Hex("request.executionHash", request?.executionHash),
  };

  if (normalized.actionType < 0 || normalized.actionType > 255) {
    throw new Error("request.actionType must fit in uint8");
  }
  if (normalized.deadline < 0n) {
    throw new Error("request.deadline must be positive");
  }

  return normalized;
}

function normalizeDispatchRequestPayload(request) {
  return {
    mode: normalizeDispatchModeValue(request?.mode),
    destination: assertHexString("request.destination", request?.destination ?? "0x"),
    message: assertHexString("request.message", request?.message),
  };
}

function encodeSubmitIntentCalldata(request) {
  const normalized = normalizeOrReuseRouterIntentRequest(request);
  return (
    `${EVM_SUBMIT_INTENT_SELECTOR}`
    + `${encodeUint256Word(BigInt(normalized.actionType))}`
    + `${encodeAddressWord(normalized.asset)}`
    + `${encodeAddressWord(normalized.refundAddress)}`
    + `${encodeUint256Word(normalized.amount)}`
    + `${encodeUint256Word(normalized.xcmFee)}`
    + `${encodeUint256Word(normalized.destinationFee)}`
    + `${encodeUint256Word(normalized.minOutputAmount)}`
    + `${encodeUint256Word(normalized.deadline)}`
    + `${encodeBytes32Word(normalized.executionHash)}`
  );
}

function encodePreviewLockedAmountCalldata(request) {
  const normalized = normalizeOrReuseRouterIntentRequest(request);
  return (
    `${EVM_PREVIEW_LOCKED_AMOUNT_SELECTOR}`
    + `${encodeUint256Word(BigInt(normalized.actionType))}`
    + `${encodeAddressWord(normalized.asset)}`
    + `${encodeAddressWord(normalized.refundAddress)}`
    + `${encodeUint256Word(normalized.amount)}`
    + `${encodeUint256Word(normalized.xcmFee)}`
    + `${encodeUint256Word(normalized.destinationFee)}`
    + `${encodeUint256Word(normalized.minOutputAmount)}`
    + `${encodeUint256Word(normalized.deadline)}`
    + `${encodeBytes32Word(normalized.executionHash)}`
  );
}

function encodeDispatchIntentCalldata(intentId, request) {
  const normalizedIntentId = assertBytes32Hex("intentId", intentId);
  const normalizedRequest = normalizeDispatchRequestPayload(request);
  const encodedDestination = encodeAbiBytes(normalizedRequest.destination);
  const encodedMessage = encodeAbiBytes(normalizedRequest.message);
  const destinationOffset = 96n;
  const messageOffset = destinationOffset + encodedDestination.byteLength;

  return (
    `${EVM_DISPATCH_INTENT_SELECTOR}`
    + `${encodeBytes32Word(normalizedIntentId)}`
    + `${encodeUint256Word(64n)}`
    + `${encodeUint256Word(BigInt(normalizedRequest.mode))}`
    + `${encodeUint256Word(destinationOffset)}`
    + `${encodeUint256Word(messageOffset)}`
    + `${encodedDestination.encoded}`
    + `${encodedMessage.encoded}`
  );
}

function encodeFinalizeSuccessCalldata(intentId, outcomeReference, resultAssetId, resultAmount) {
  return (
    `${EVM_FINALIZE_SUCCESS_SELECTOR}`
    + `${encodeBytes32Word(intentId)}`
    + `${encodeBytes32Word(outcomeReference)}`
    + `${encodeBytes32Word(resultAssetId)}`
    + `${encodeUint256Word(resultAmount)}`
  );
}

function encodeFinalizeFailureCalldata(intentId, outcomeReference, failureReasonHash) {
  return (
    `${EVM_FINALIZE_FAILURE_SELECTOR}`
    + `${encodeBytes32Word(intentId)}`
    + `${encodeBytes32Word(outcomeReference)}`
    + `${encodeBytes32Word(failureReasonHash)}`
  );
}

function encodeRefundCalldata(intentId, refundAmount) {
  return `${EVM_REFUND_SELECTOR}${encodeBytes32Word(intentId)}${encodeUint256Word(refundAmount)}`;
}

function encodePreviewRefundableAmountCalldata(intentId) {
  return `${EVM_PREVIEW_REFUNDABLE_SELECTOR}${encodeBytes32Word(intentId)}`;
}

function encodeAllowanceCalldata({ ownerAddress, spenderAddress }) {
  return (
    `${EVM_ALLOWANCE_SELECTOR}`
    + `${encodeAddressWord(ownerAddress)}`
    + `${encodeAddressWord(spenderAddress)}`
  );
}

function encodeBalanceOfCalldata({ ownerAddress }) {
  return `${EVM_BALANCE_OF_SELECTOR}${encodeAddressWord(ownerAddress)}`;
}

function encodeApproveCalldata({ spenderAddress, amount }) {
  return (
    `${EVM_APPROVE_SELECTOR}`
    + `${encodeAddressWord(spenderAddress)}`
    + `${encodeUint256Word(amount)}`
  );
}

function encodeAbiBytes(value) {
  const normalized = stripHexPrefix(assertHexString("bytes", value));
  const paddedLength = Math.ceil(normalized.length / 64) * 64;
  const padded = normalized.padEnd(paddedLength, "0");
  return {
    encoded: `${encodeUint256Word(BigInt(normalized.length / 2))}${padded}`,
    byteLength: 32n + BigInt(padded.length / 2),
  };
}

function encodeUint256Word(value) {
  const normalized = toBigInt(value, "uint256");
  if (normalized < 0n) {
    throw new Error("uint256 cannot be negative");
  }

  return normalized.toString(16).padStart(64, "0");
}

function encodeAddressWord(address) {
  return stripHexPrefix(assertAddress("address", address)).padStart(64, "0");
}

function encodeBytes32Word(value) {
  return stripHexPrefix(assertBytes32Hex("bytes32", value)).padStart(64, "0");
}

function stripHexPrefix(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function parseRpcUint256(value, name) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed hex value`);
  }

  return BigInt(value);
}

function normalizeExpectedEvmNetwork(network) {
  if (!network) {
    return null;
  }

  const chainId = assertPositiveInteger("expectedNetwork.chainId", network.chainId);
  const chainName = assertNonEmptyString("expectedNetwork.chainName", network.chainName);
  const rpcUrls = normalizeStringArray("expectedNetwork.rpcUrls", network.rpcUrls);
  const blockExplorerUrls = normalizeOptionalStringArray(
    "expectedNetwork.blockExplorerUrls",
    network.blockExplorerUrls,
  );
  const nativeCurrency = network.nativeCurrency
    ? {
        name: assertNonEmptyString("expectedNetwork.nativeCurrency.name", network.nativeCurrency.name),
        symbol: assertNonEmptyString(
          "expectedNetwork.nativeCurrency.symbol",
          network.nativeCurrency.symbol,
        ),
        decimals: assertPositiveInteger(
          "expectedNetwork.nativeCurrency.decimals",
          network.nativeCurrency.decimals,
        ),
      }
    : null;

  return {
    chainId,
    chainIdHex: `0x${chainId.toString(16)}`,
    chainName,
    rpcUrls,
    ...(blockExplorerUrls ? { blockExplorerUrls } : {}),
    ...(nativeCurrency ? { nativeCurrency } : {}),
  };
}

function normalizeRpcHex(value, name) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed hex value`);
  }

  return `0x${stripHexPrefix(value).toLowerCase()}`;
}

function normalizeStringArray(name, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }

  return values.map((value, index) => assertNonEmptyString(`${name}[${index}]`, value));
}

function normalizeOptionalStringArray(name, values) {
  if (values === null || values === undefined) {
    return null;
  }

  return normalizeStringArray(name, values);
}

function buildAddEthereumChainParams(network) {
  return {
    chainId: network.chainIdHex,
    chainName: network.chainName,
    rpcUrls: network.rpcUrls,
    ...(network.blockExplorerUrls ? { blockExplorerUrls: network.blockExplorerUrls } : {}),
    ...(network.nativeCurrency ? { nativeCurrency: network.nativeCurrency } : {}),
  };
}

function isUnknownChainError(error) {
  return Number(error?.code) === 4902;
}

function createUnexpectedNetworkError(chainKey, chainName) {
  return new Error(`Switch your EVM wallet to ${chainName} to execute from ${chainKey}.`);
}

function createInsufficientBalanceError({
  chainKey,
  assetAddress,
  ownerAddress,
  balance,
  needed,
}) {
  return new Error(
    `Insufficient balance on ${chainKey}. Wallet ${ownerAddress} has ${balance.toString()} units of ${assetAddress} but needs ${needed.toString()}.`,
  );
}

function describeRpcPreflightError(error, chainKey) {
  const decoded = decodeKnownRpcRevert(error);
  if (decoded) {
    return decoded;
  }

  const message = error instanceof Error ? error.message.trim() : "";
  return new Error(message || `Transaction simulation failed on ${chainKey}.`);
}

function decodeKnownRpcRevert(error) {
  const data = extractRpcErrorData(error);
  if (!data) {
    return null;
  }

  if (data.startsWith("0xe450d38c") && data.length >= 202) {
    const owner = `0x${data.slice(34, 74)}`.toLowerCase();
    const balance = BigInt(`0x${data.slice(74, 138)}`);
    const needed = BigInt(`0x${data.slice(138, 202)}`);
    return new Error(
      `Insufficient token balance. Wallet ${owner} has ${balance.toString()} units but needs ${needed.toString()}.`,
    );
  }

  if (data.startsWith("0xfb8f41b2") && data.length >= 202) {
    const spender = `0x${data.slice(34, 74)}`.toLowerCase();
    const allowance = BigInt(`0x${data.slice(74, 138)}`);
    const needed = BigInt(`0x${data.slice(138, 202)}`);
    return new Error(
      `Insufficient token allowance. Spender ${spender} has ${allowance.toString()} approved units but needs ${needed.toString()}.`,
    );
  }

  if (data.startsWith("0x5274afe7") && data.length >= 74) {
    const token = `0x${data.slice(34, 74)}`.toLowerCase();
    return new Error(`Token transfer simulation failed for ${token}.`);
  }

  return null;
}

function extractRpcErrorData(error) {
  const rawData = error?.data?.data ?? error?.data;
  if (typeof rawData !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawData)) {
    return null;
  }

  return rawData.toLowerCase();
}

function extractIntentIdFromSubmitReceipt({ receipt, routerAddress, txHash }) {
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const normalizedRouterAddress = assertAddress("routerAddress", routerAddress).toLowerCase();
  for (const log of logs) {
    const topics = Array.isArray(log?.topics) ? log.topics : [];
    if (topics.length < 2) {
      continue;
    }
    const topic0 = String(topics[0]).toLowerCase();
    const topic1 = String(topics[1]);
    const logAddress =
      typeof log?.address === "string" ? log.address.toLowerCase() : null;
    if (logAddress !== normalizedRouterAddress || topic0 !== EVM_INTENT_SUBMITTED_TOPIC) {
      continue;
    }

    return assertBytes32Hex("intentId", topic1);
  }

  throw new Error(
    `unable to extract intentId from submit receipt for transaction ${txHash}`,
  );
}

async function waitForEvmReceipt({ provider, txHash, pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });
    if (receipt) {
      return receipt;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`timed out waiting for transaction receipt ${txHash}`);
}

function assertEvmReceiptSucceeded(receipt, txHash) {
  const status = receipt?.status;
  if (status === undefined || status === null) {
    return;
  }

  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    if (normalized === "0x1" || normalized === "1") {
      return;
    }
  } else if (typeof status === "number" && status === 1) {
    return;
  }

  throw new Error(`transaction ${txHash} reverted`);
}

function toRpcQuantity(value, name) {
  const normalized = toBigInt(value, name);
  if (normalized < 0n) {
    throw new Error(`${name} must be positive`);
  }

  return `0x${normalized.toString(16)}`;
}

function normalizeDispatchModeValue(mode) {
  if (mode === 0 || mode === 1) {
    return mode;
  }

  return assertIncluded("request.mode", mode, [0, 1]);
}

function assertPositiveInteger(name, value) {
  const normalized = assertInteger(name, value);
  if (normalized <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return normalized;
}

function normalizeOrReuseRouterIntentRequest(request) {
  if (
    request
    && typeof request === "object"
    && typeof request.actionType === "number"
    && typeof request.amount === "bigint"
    && typeof request.xcmFee === "bigint"
    && typeof request.destinationFee === "bigint"
    && typeof request.minOutputAmount === "bigint"
    && typeof request.deadline === "bigint"
  ) {
    return request;
  }

  return normalizeRouterIntentRequest(request);
}

function uint8ArrayToHex(bytes) {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
