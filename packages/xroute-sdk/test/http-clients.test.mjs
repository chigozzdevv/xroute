import test from "node:test";
import assert from "node:assert/strict";

import * as publicSdk from "../index.mjs";
import {
  connectInjectedWallet,
  createQuote,
  createStatusClient,
  createXRouteClient,
  getBrowserWalletAvailability,
} from "../index.mjs";
import {
  DEFAULT_XROUTE_API_BASE_URL,
  resolveDefaultXRouteApiBaseUrl,
} from "../internal/constants.mjs";
import {
  createHttpExecutorRelayerClient,
  createHttpQuoteProvider,
  createHttpStatusProvider,
} from "../internal/http.mjs";
import { createEvmWalletAdapter } from "../wallets/wallet-adapters.mjs";
import { createWallet } from "../wallet/index.mjs";

test("createHttpStatusProvider fetches hosted status and timeline", async () => {
  const seen = [];
  const provider = createHttpStatusProvider({
    endpoint: "https://example.test/v1",
    apiKey: "public-test-key",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      if (url.endsWith("/status")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              intentId:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              status: "settled",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            timeline: [
              {
                type: "intent-dispatched",
                at: 123,
              },
            ],
          };
        },
      };
    },
  });

  const status = await provider.getStatus(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const timeline = await provider.getTimeline(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );

  assert.equal(status.status, "settled");
  assert.equal(timeline.length, 1);
  assert.equal(
    seen[0][0],
    "https://example.test/v1/intents/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/status",
  );
  assert.equal(
    seen[1][0],
    "https://example.test/v1/intents/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/timeline",
  );
  assert.equal(seen[0][1].headers["x-api-key"], "public-test-key");
});

test("hosted createXRouteClient resolves status without wallet connection", async () => {
  const seen = [];
  const client = createXRouteClient({
    apiKey: "public-test-key",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      if (url.endsWith("/status")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              intentId:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              status: "executing",
            };
          },
        };
      }

      if (url.endsWith("/timeline")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              timeline: [
                {
                  type: "intent-dispatched",
                  at: 123,
                },
              ],
            };
          },
        };
      }

      throw new Error(`unexpected request to ${url}`);
    },
  });

  const status = await client.getStatus(
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  const timeline = await client.getTimeline(
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );

  assert.equal(status.status, "executing");
  assert.equal(timeline.length, 1);
  assert.equal(
    seen[0][0],
    `${DEFAULT_XROUTE_API_BASE_URL}/intents/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status`,
  );
  assert.equal(
    seen[1][0],
    `${DEFAULT_XROUTE_API_BASE_URL}/intents/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/timeline`,
  );
});

test("hosted createXRouteClient works without apiKey", async () => {
  const seen = [];
  const client = createXRouteClient({
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      if (url.endsWith("/status")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              intentId:
                "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              status: "settled",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            timeline: [],
          };
        },
      };
    },
  });

  const status = await client.getStatus(
    "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  );

  assert.equal(status.status, "settled");
  assert.equal(
    seen[0][0],
    `${DEFAULT_XROUTE_API_BASE_URL}/intents/0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/status`,
  );
  assert.equal(seen[0][1].headers["x-api-key"], undefined);
});

test("sdk resolves the local api base url automatically for localhost browsers", () => {
  assert.equal(
    resolveDefaultXRouteApiBaseUrl({
      env: {},
      location: { hostname: "localhost" },
    }),
    "http://127.0.0.1:8788/v1",
  );
});

test("sdk resolves the configured server api base url without public client env", () => {
  assert.equal(
    resolveDefaultXRouteApiBaseUrl({
      env: {
        XROUTE_API_BASE_URL: "http://127.0.0.1:8788/v1/",
      },
      location: undefined,
    }),
    "http://127.0.0.1:8788/v1",
  );
});

test("getBrowserWalletAvailability inspects injected browser wallets", () => {
  const availability = getBrowserWalletAvailability({
    browserWindow: {
      ethereum: {
        request: async () => [],
      },
      injectedWeb3: {
        talisman: {
          async enable() {
            return {};
          },
        },
      },
    },
  });

  assert.deepEqual(availability, {
    evm: true,
    substrate: true,
  });
});

test("connectInjectedWallet resolves an injected evm account", async () => {
  const session = await connectInjectedWallet("evm", {
    browserWindow: {
      ethereum: {
        async request({ method }) {
          assert.equal(method, "eth_requestAccounts");
          return ["0x1111111111111111111111111111111111111111"];
        },
      },
    },
  });

  assert.equal(session.kind, "evm");
  assert.equal(session.account, "0x1111111111111111111111111111111111111111");
});

test("connectInjectedWallet resolves an injected substrate account", async () => {
  const session = await connectInjectedWallet("substrate", {
    extensionDappName: "xroute-test",
    browserWindow: {
      injectedWeb3: {
        talisman: {
          async enable(originName) {
            assert.equal(originName, "xroute-test");
            return {
              accounts: [
                {
                  address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                  meta: {
                    name: "Alice",
                  },
                },
              ],
            };
          },
        },
      },
    },
  });

  assert.equal(session.kind, "substrate");
  assert.equal(session.extensionName, "talisman");
  assert.equal(session.account, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
});

test("hosted createXRouteClient executes hydration-source transfers through custom wallet submit builders", async () => {
  const seen = [];
  const walletAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const intentId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const dispatchTxHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const submitted = [];
  const dispatched = [];
  const client = createXRouteClient({
    apiKey: "public-test-key",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      if (url.endsWith("/status")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              intentId,
              status: "dispatched",
            };
          },
        };
      }

      if (!url.endsWith("/quote")) {
        if (!url.endsWith("/jobs/dispatch")) {
          throw new Error(`unexpected request to ${url}`);
        }

        return {
          ok: true,
          async json() {
            return {
              job: {
                id: "job-1",
                status: "queued",
              },
            };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return {
            quote: {
              quoteId: "ignored",
              deploymentProfile: "mainnet",
              route: ["hydration", "polkadot-hub", "moonbeam"],
              segments: [],
              fees: {
                xcmFee: { asset: "DOT", amount: "1" },
                destinationFee: { asset: "DOT", amount: "2" },
                platformFee: { asset: "DOT", amount: "3" },
                totalFee: { asset: "DOT", amount: "6" },
              },
              expectedOutput: { asset: "DOT", amount: "0" },
              minOutput: null,
              submission: {
                action: "transfer",
                asset: "DOT",
                amount: "10000000000",
                xcmFee: "1",
                destinationFee: "2",
                minOutputAmount: "10000000000",
              },
              executionPlan: {
                route: ["hydration", "polkadot-hub", "moonbeam"],
                steps: [],
              },
            },
          };
        },
      };
    },
  });

  client.connectWallet({
    async getAddress() {
      return walletAddress;
    },
    xcmEnvelopeBuilder() {
      return {
        mode: "execute",
        messageHex: "0x1234",
      };
    },
    submitRequestBuilder({ intent, quote, envelope }) {
      assert.equal(intent.sourceChain, "hydration");
      assert.equal(intent.refundAddress, walletAddress);
      assert.equal(quote.submission.asset, "DOT");
      assert.equal(envelope.mode, "execute");

      return {
        sourceKind: "substrate-source",
        refundAddress: intent.refundAddress,
        asset: quote.submission.asset,
        amount: quote.submission.amount,
        xcmFee: quote.submission.xcmFee,
        destinationFee: quote.submission.destinationFee,
        minOutputAmount: quote.submission.minOutputAmount,
        deadline: intent.deadline,
        executionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      };
    },
    routerAdapter: {
      async submitIntent({ owner, intent, quote, request }) {
        submitted.push({ owner, intent, quote, request });
        return {
          intentId,
          request,
        };
      },
      async dispatchIntent({ intentId: dispatchedIntentId, request }) {
        dispatched.push({ intentId: dispatchedIntentId, request });
        return {
          intentId: dispatchedIntentId,
          txHash: dispatchTxHash,
          request,
        };
      },
    },
  });

  const execution = await client.transfer({
    sourceChain: "hydration",
    destinationChain: "moonbeam",
    asset: "DOT",
    amount: "10000000000",
    recipient: "0x1111111111111111111111111111111111111111",
  });

  assert.equal(execution.intent.refundAddress, walletAddress);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].owner, walletAddress);
  assert.equal(submitted[0].request.sourceKind, "substrate-source");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].request.mode, 0);
  assert.equal(execution.dispatched.relayerJob.id, "job-1");
  assert.equal(execution.status.status, "dispatched");

  const quoteBody = JSON.parse(seen[0][1].body);
  const relayerBody = JSON.parse(seen[1][1].body);
  assert.equal(quoteBody.intent.sourceChain, "hydration");
  assert.equal(quoteBody.intent.refundAddress, walletAddress);
  assert.equal(seen[1][0], `${DEFAULT_XROUTE_API_BASE_URL}/jobs/dispatch`);
  assert.equal(relayerBody.intent.refundAddress, walletAddress);
  assert.equal(relayerBody.sourceIntent.kind, "substrate-source");
  assert.equal(relayerBody.sourceDispatch.txHash, dispatchTxHash);
});

test("hosted createXRouteClient waits for terminal status via the hosted status provider", async () => {
  const statuses = ["submitted", "executing", "settled"];
  const seen = [];
  const client = createXRouteClient({
    apiKey: "public-test-key",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      if (!url.endsWith("/status")) {
        throw new Error(`unexpected request to ${url}`);
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            intentId:
              "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            status: statuses.shift() ?? "settled",
          };
        },
      };
    },
  });

  const status = await client.wait(
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    },
  );

  assert.equal(status.status, "settled");
  assert.ok(seen.length >= 2);
});

test("hosted createXRouteClient tracks status changes until settlement", async () => {
  const pendingStatuses = ["submitted", "executing", "settled"];
  const seenUpdates = [];
  const client = createXRouteClient({
    apiKey: "public-test-key",
    fetchImpl: async (url) => {
      if (url.endsWith("/timeline")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              timeline: seenUpdates.map((status, index) => ({
                type: status,
                at: index + 1,
              })),
            };
          },
        };
      }
      if (!url.endsWith("/status")) {
        throw new Error(`unexpected request to ${url}`);
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            intentId:
              "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            status: pendingStatuses.shift() ?? "settled",
          };
        },
      };
    },
  });

  const tracker = client.track(
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    {
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      includeTimeline: true,
      onUpdate(snapshot) {
        seenUpdates.push(snapshot.status?.status ?? null);
      },
    },
  );

  const finalStatus = await tracker.done;
  assert.equal(finalStatus.status, "settled");
  assert.deepEqual(seenUpdates, ["submitted", "executing", "settled"]);
});

test("public SDK root does not expose internal transport or relayer helpers", () => {
  assert.equal("createHttpExecutorRelayerClient" in publicSdk, false);
  assert.equal("createXRouteOperatorClient" in publicSdk, false);
  assert.equal("createConfiguredXRouteClient" in publicSdk, false);
  assert.equal("createHttpQuoteProvider" in publicSdk, false);
  assert.equal("createHttpStatusProvider" in publicSdk, false);
  assert.equal("createEvmWalletAdapter" in publicSdk, false);
  assert.equal("createSubstrateWalletAdapter" in publicSdk, false);
  assert.equal("createWallet" in publicSdk, false);
  assert.equal("FileBackedStatusIndexer" in publicSdk, false);
  assert.equal("InMemoryStatusIndexer" in publicSdk, false);
  assert.equal("DEFAULT_XROUTE_API_BASE_URL" in publicSdk, false);
  assert.equal("normalizeQuote" in publicSdk, false);
  assert.equal("NATIVE_ASSET_ADDRESS" in publicSdk, false);
  assert.equal("trackStatus" in publicSdk, false);
});

test("createEvmWalletAdapter submits intents with approval and extracts intent id from receipt", async () => {
  const calls = [];
  const routerAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const tokenAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ownerAddress = "0x1111111111111111111111111111111111111111";
  const intentId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const txHashes = {
    approve: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    submit: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    dispatch: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  };

  const provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
          return [ownerAddress];
        case "eth_call": {
          const data = params?.[0]?.data ?? "";
          if (data.startsWith("0x12747753")) {
            return "0x01f4";
          }
          if (data.startsWith("0xdd62ed3e")) {
            return "0x0";
          }
          throw new Error(`unexpected eth_call payload: ${data}`);
        }
        case "eth_sendTransaction": {
          const tx = params?.[0];
          if (tx.data.startsWith("0x095ea7b3")) {
            return txHashes.approve;
          }
          if (tx.data.startsWith("0xdf260bc0")) {
            return txHashes.submit;
          }
          if (tx.data.startsWith("0xa65e5b7d")) {
            return txHashes.dispatch;
          }
          throw new Error(`unexpected tx payload: ${tx.data}`);
        }
        case "eth_getTransactionReceipt": {
          const txHash = params?.[0];
          if (txHash === txHashes.approve) {
            return { status: "0x1", logs: [] };
          }
          if (txHash === txHashes.submit) {
            return {
              status: "0x1",
              logs: [
                {
                  address: routerAddress,
                  topics: [
                    "0x958ded10bf7c27600499d19f87c591832d502b52c7439827fabc5c4fe5d7d028",
                    intentId,
                  ],
                },
              ],
            };
          }
          if (txHash === txHashes.dispatch) {
            return {
              status: "0x1",
              logs: [],
            };
          }
          return null;
        }
        default:
          throw new Error(`unexpected rpc method: ${method}`);
      }
    },
  };

  const wallet = createEvmWalletAdapter({
    provider,
    chainKey: "polkadot-hub",
    routerAddress,
    assetAddresses: {
      "polkadot-hub": {
        DOT: tokenAddress,
      },
    },
  });

  const submitted = await wallet.routerAdapter.submitIntent({
    owner: ownerAddress,
    request: {
      actionType: 0,
      asset: tokenAddress,
      refundAddress: ownerAddress,
      amount: 100n,
      xcmFee: 20n,
      destinationFee: 5n,
      minOutputAmount: 100n,
      deadline: 1_773_185_200,
      executionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    },
  });

  assert.equal(submitted.intentId, intentId);
  assert.equal(submitted.lockedAmount, 500n);

  const dispatch = await wallet.routerAdapter.dispatchIntent({
    intentId,
    request: {
      mode: 0,
      destination: "0x1234",
      message: "0xabcd",
    },
  });
  assert.equal(dispatch.intentId, intentId);

  const sentTxs = calls
    .filter((call) => call.method === "eth_sendTransaction")
    .map((call) => call.params[0]);
  assert.equal(sentTxs.length, 3);
  assert.equal(sentTxs[0].to.toLowerCase(), tokenAddress);
  assert.ok(sentTxs[0].data.startsWith("0x095ea7b3"));
  assert.equal(sentTxs[1].to.toLowerCase(), routerAddress);
  assert.ok(sentTxs[1].data.startsWith("0xdf260bc0"));
  assert.equal(sentTxs[2].to.toLowerCase(), routerAddress);
  assert.ok(sentTxs[2].data.startsWith("0xa65e5b7d"));
});

test("createWallet resolves hosted mainnet defaults for moonbeam evm wallets", async () => {
  const calls = [];
  const ownerAddress = "0x1111111111111111111111111111111111111111";
  const routerAddress = "0x33810619b522ee56dcd0cfba53822fad5ff48fdd";
  const tokenAddress = "0xffffffff1fcacbd218edc0eba20fc2308c778080";
  const intentId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const txHashes = {
    approve: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    submit: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };

  const provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
          return [ownerAddress];
        case "eth_call": {
          const data = params?.[0]?.data ?? "";
          if (data.startsWith("0x12747753")) {
            return "0x01f4";
          }
          if (data.startsWith("0xdd62ed3e")) {
            return "0x0";
          }
          throw new Error(`unexpected eth_call payload: ${data}`);
        }
        case "eth_sendTransaction": {
          const tx = params?.[0];
          if (tx.data.startsWith("0x095ea7b3")) {
            return txHashes.approve;
          }
          if (tx.data.startsWith("0xdf260bc0")) {
            return txHashes.submit;
          }
          throw new Error(`unexpected tx payload: ${tx.data}`);
        }
        case "eth_getTransactionReceipt": {
          const txHash = params?.[0];
          if (txHash === txHashes.approve) {
            return { status: "0x1", logs: [] };
          }
          if (txHash === txHashes.submit) {
            return {
              status: "0x1",
              logs: [
                {
                  address: routerAddress,
                  topics: [
                    "0x958ded10bf7c27600499d19f87c591832d502b52c7439827fabc5c4fe5d7d028",
                    intentId,
                  ],
                },
              ],
            };
          }
          return null;
        }
        default:
          throw new Error(`unexpected rpc method: ${method}`);
      }
    },
  };

  const wallet = createWallet("evm", {
    provider,
    chainKey: "moonbeam",
    deploymentProfile: "mainnet",
  });

  const submitted = await wallet.routerAdapter.submitIntent({
    owner: ownerAddress,
    request: {
      actionType: 0,
      asset: tokenAddress,
      refundAddress: ownerAddress,
      amount: 100n,
      xcmFee: 20n,
      destinationFee: 5n,
      minOutputAmount: 100n,
      deadline: 1_773_185_200,
      executionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    },
  });

  assert.equal(submitted.intentId, intentId);

  const sentTxs = calls
    .filter((call) => call.method === "eth_sendTransaction")
    .map((call) => call.params[0]);
  assert.equal(sentTxs[0].to.toLowerCase(), tokenAddress);
  assert.equal(sentTxs[1].to.toLowerCase(), routerAddress);
});

test("createWallet resolves hosted mainnet defaults for hydration substrate wallets", () => {
  const wallet = createWallet("substrate", {
    chainKey: "hydration",
    account: {
      address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      signer: {
        async signPayload() {
          return { signature: "0x11" };
        },
        async signRaw() {
          return { signature: "0x11" };
        },
      },
    },
  });

  assert.equal(wallet.chainKey, "hydration");
  assert.equal(typeof wallet.routerAdapter.submitIntent, "function");
});

test("hosted createXRouteClient runs mixed-source flows across registered wallets", async () => {
  const seenQuotes = [];
  const submitOwners = [];
  const dispatches = [];
  const intentIds = {
    moonbeam: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    hydration: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  };
  const client = createXRouteClient({
    apiKey: "public-test-key",
    fetchImpl: async (url, request) => {
      if (url.endsWith("/quote")) {
        const body = JSON.parse(request.body);
        seenQuotes.push(body.intent);

        if (body.intent.sourceChain === "moonbeam") {
          return {
            ok: true,
            async json() {
              return {
                quote: {
                  quoteId: "ignored",
                  deploymentProfile: "mainnet",
                  route: ["moonbeam", "polkadot-hub", "hydration"],
                  segments: [],
                  fees: {
                    xcmFee: { asset: "DOT", amount: "1" },
                    destinationFee: { asset: "DOT", amount: "2" },
                    platformFee: { asset: "DOT", amount: "3" },
                    totalFee: { asset: "DOT", amount: "6" },
                  },
                  expectedOutput: { asset: "DOT", amount: "10000000000" },
                  minOutput: { asset: "DOT", amount: "10000000000" },
                  submission: {
                    action: "transfer",
                    asset: "DOT",
                    amount: "10000000000",
                    xcmFee: "1",
                    destinationFee: "2",
                    minOutputAmount: "10000000000",
                  },
                  executionPlan: {
                    route: ["moonbeam", "polkadot-hub", "hydration"],
                    steps: [],
                  },
                },
              };
            },
          };
        }

        return {
          ok: true,
          async json() {
            return {
              quote: {
                quoteId: "ignored",
                deploymentProfile: "mainnet",
                route: ["hydration", "polkadot-hub", "moonbeam"],
                segments: [],
                fees: {
                  xcmFee: { asset: "DOT", amount: "1" },
                  destinationFee: { asset: "DOT", amount: "2" },
                  platformFee: { asset: "DOT", amount: "3" },
                  totalFee: { asset: "DOT", amount: "6" },
                },
                expectedOutput: { asset: "DOT", amount: "0" },
                minOutput: null,
                submission: {
                  action: "execute",
                  asset: "DOT",
                  amount: "100000000",
                  xcmFee: "1",
                  destinationFee: "2",
                  minOutputAmount: "0",
                },
                executionPlan: {
                  route: ["hydration", "polkadot-hub", "moonbeam"],
                  steps: [],
                },
              },
            };
          },
        };
      }

      if (url.endsWith("/status")) {
        const intentId = url.split("/intents/")[1]?.split("/")[0];
        return {
          ok: true,
          async json() {
            return {
              intentId,
              status: "settled",
            };
          },
        };
      }

      if (url.endsWith("/jobs/dispatch")) {
        return {
          ok: true,
          async json() {
            return {
              job: {
                id: `job-${dispatches.length + 1}`,
                status: "queued",
              },
            };
          },
        };
      }

      throw new Error(`unexpected request to ${url}`);
    },
  });

  client.connectWallet({
    chainKey: "moonbeam",
    async getAddress() {
      return "0x1111111111111111111111111111111111111111";
    },
    xcmEnvelopeBuilder() {
      return {
        mode: "execute",
        messageHex: "0x1234",
      };
    },
    submitRequestBuilder() {
      return {
        sourceKind: "router-evm",
      };
    },
    routerAdapter: {
      async submitIntent({ owner, intent }) {
        submitOwners.push([intent.sourceChain, owner]);
        return {
          intentId: intentIds.moonbeam,
          txHash: "0x0101010101010101010101010101010101010101010101010101010101010101",
        };
      },
      async dispatchIntent({ intentId, request }) {
        dispatches.push([intentId, request]);
        return {
          intentId,
          txHash: "0x0202020202020202020202020202020202020202020202020202020202020202",
          request,
        };
      },
    },
  });

  client.connectWallet({
    chainKey: "hydration",
    async getAddress() {
      return "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    },
    xcmEnvelopeBuilder() {
      return {
        mode: "execute",
        messageHex: "0x5678",
      };
    },
    submitRequestBuilder() {
      return {
        sourceKind: "substrate-source",
      };
    },
    routerAdapter: {
      async submitIntent({ owner, intent }) {
        submitOwners.push([intent.sourceChain, owner]);
        return {
          intentId: intentIds.hydration,
        };
      },
      async dispatchIntent({ intentId, request }) {
        dispatches.push([intentId, request]);
        return {
          intentId,
          txHash: "0x0303030303030303030303030303030303030303030303030303030303030303",
          request,
        };
      },
    },
  });

  const flow = await client.runFlow({
    pollIntervalMs: 1,
    timeoutMs: 1_000,
    steps: [
      {
        name: "transfer",
        intent: {
          sourceChain: "moonbeam",
          destinationChain: "hydration",
          ownerAddress: "0x1111111111111111111111111111111111111111",
          asset: "DOT",
          amount: "10000000000",
          recipient: "5Frecipient",
        },
      },
      {
        name: "call",
        intent: {
          sourceChain: "hydration",
          destinationChain: "moonbeam",
          ownerAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          executionType: "call",
          asset: "DOT",
          maxPaymentAmount: "100000000",
          contractAddress: "0x2222222222222222222222222222222222222222",
          calldata: "0xdeadbeef",
          value: "0",
          gasLimit: "250000",
          fallbackRefTime: 650000000,
          fallbackProofSize: 12288,
        },
      },
    ],
  });

  assert.equal(flow.steps.length, 2);
  assert.deepEqual(
    submitOwners,
    [
      ["moonbeam", "0x1111111111111111111111111111111111111111"],
      ["hydration", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"],
    ],
  );
  assert.equal(seenQuotes[0].sourceChain, "moonbeam");
  assert.equal(seenQuotes[1].sourceChain, "hydration");
  assert.equal(dispatches.length, 2);
  assert.equal(flow.steps[0].dispatched.txHash.startsWith("0x02"), true);
  assert.equal(flow.steps[1].dispatched.txHash.startsWith("0x03"), true);
});

test("createXRouteClient uses the hosted endpoint for quote requests", async () => {
  const seen = [];
  const client = createXRouteClient({
    apiKey: "public-test-key",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            quote: {
              quoteId: "ignored",
              deploymentProfile: "mainnet",
              route: ["polkadot-hub", "hydration"],
              segments: [],
              fees: {
                xcmFee: { asset: "DOT", amount: "1" },
                destinationFee: { asset: "DOT", amount: "2" },
                platformFee: { asset: "DOT", amount: "3" },
                totalFee: { asset: "DOT", amount: "6" },
              },
              expectedOutput: { asset: "DOT", amount: "10" },
              minOutput: { asset: "DOT", amount: "10" },
              submission: {
                action: "transfer",
                asset: "DOT",
                amount: "10",
                xcmFee: "1",
                destinationFee: "2",
                minOutputAmount: "10",
              },
              executionPlan: {
                route: ["polkadot-hub", "hydration"],
                steps: [],
              },
            },
          };
        },
      };
    },
  });

  const quoted = await client.quote({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    ownerAddress: "0x1111111111111111111111111111111111111111",
    asset: "DOT",
    amount: "10",
    recipient: "5Frecipient",
  });

  assert.equal(quoted.quote.submission.action, "transfer");
  assert.equal(seen[0][0], `${DEFAULT_XROUTE_API_BASE_URL}/quote`);
  assert.equal(seen[0][1].headers["x-api-key"], "public-test-key");
});

test("public hosted helpers reject base url overrides", async () => {
  assert.throws(
    () => createXRouteClient({ baseUrl: "https://example.test/v1" }),
    /does not support baseUrl overrides/,
  );
  assert.throws(
    () => createQuote({ baseUrl: "https://example.test/v1" }),
    /does not support baseUrl overrides/,
  );
  assert.throws(
    () => createStatusClient({ baseUrl: "https://example.test/v1" }),
    /does not support baseUrl overrides/,
  );
});

test("createHttpQuoteProvider returns the nested quote payload", async () => {
  const provider = createHttpQuoteProvider({
    endpoint: "https://example.test/quote",
    apiKey: "public-test-key",
    fetchImpl: async (_url, request) => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-api-key"], "public-test-key");
      return {
        ok: true,
        async json() {
          return {
            intent: {
              quoteId: "ignored",
            },
            quote: {
              quoteId: "ignored",
              deploymentProfile: "mainnet",
              route: ["polkadot-hub", "hydration"],
              segments: [],
              fees: {
                xcmFee: { asset: "DOT", amount: "1" },
                destinationFee: { asset: "DOT", amount: "2" },
                platformFee: { asset: "DOT", amount: "3" },
                totalFee: { asset: "DOT", amount: "6" },
              },
              expectedOutput: { asset: "DOT", amount: "10" },
              minOutput: { asset: "DOT", amount: "10" },
              submission: {
                action: "transfer",
                asset: "DOT",
                amount: "10",
                xcmFee: "1",
                destinationFee: "2",
                minOutputAmount: "10",
              },
              executionPlan: {
                route: ["polkadot-hub", "hydration"],
                steps: [],
              },
            },
            routerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          };
        },
      };
    },
  });

  const quote = await provider.quote({
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    ownerAddress: "0x1111111111111111111111111111111111111111",
    asset: "DOT",
    amount: "10",
    recipient: "5Frecipient",
  });

  assert.equal(quote.submission.action, "transfer");
  assert.equal(quote.route[0], "polkadot-hub");
});

test("createHttpExecutorRelayerClient sends relayer job requests", async () => {
  const seen = [];
  const client = createHttpExecutorRelayerClient({
    endpoint: "https://example.test",
    apiKey: "public-test-key",
    authToken: "secret-token",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            job: {
              id: "job-1",
            },
          };
        },
      };
    },
  });

  const response = await client.refund({
    intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    refundAmount: "10",
    refundAsset: "DOT",
  });

  assert.equal(response.job.id, "job-1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "https://example.test/jobs/refund");
  assert.equal(seen[0][1].headers["x-api-key"], "public-test-key");
  assert.equal(seen[0][1].headers.authorization, "Bearer secret-token");
});

test("createHttpExecutorRelayerClient builds and sends dispatch requests", async () => {
  const seen = [];
  const client = createHttpExecutorRelayerClient({
    endpoint: "https://example.test",
    authToken: "secret-token",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            job: {
              id: "job-2",
              status: "queued",
            },
          };
        },
      };
    },
  });

  const intent = {
    quoteId: "0xfeedface",
    sourceChain: "polkadot-hub",
    destinationChain: "hydration",
    refundAddress: "0x1111111111111111111111111111111111111111",
    deadline: 1_773_185_200,
    action: {
      type: "transfer",
      params: {
        asset: "DOT",
        amount: "10",
        recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      },
    },
  };
  const quote = {
    quoteId: "0xfeedface",
    deploymentProfile: "mainnet",
    route: ["polkadot-hub", "hydration"],
    segments: [
      {
        kind: "execution",
        route: ["polkadot-hub", "hydration"],
        hops: [
          {
            source: "polkadot-hub",
            destination: "hydration",
            asset: "DOT",
            transportFee: { asset: "DOT", amount: "1" },
            buyExecutionFee: { asset: "DOT", amount: "2" },
          },
        ],
        xcmFee: { asset: "DOT", amount: "1" },
        destinationFee: { asset: "DOT", amount: "2" },
      },
    ],
    fees: {
      xcmFee: { asset: "DOT", amount: "1" },
      destinationFee: { asset: "DOT", amount: "2" },
      platformFee: { asset: "DOT", amount: "3" },
      totalFee: { asset: "DOT", amount: "6" },
    },
    expectedOutput: { asset: "DOT", amount: "10" },
    minOutput: { asset: "DOT", amount: "10" },
    submission: {
      action: "transfer",
      asset: "DOT",
      amount: "10",
      xcmFee: "1",
      destinationFee: "2",
      minOutputAmount: "10",
    },
    executionPlan: {
      route: ["polkadot-hub", "hydration"],
      steps: [
        {
          type: "send-xcm",
          origin: "polkadot-hub",
          destination: "hydration",
          instructions: [
            {
              type: "transfer-reserve-asset",
              asset: "DOT",
              amount: "10",
              destination: "hydration",
              remoteInstructions: [
                {
                  type: "buy-execution",
                  asset: "DOT",
                  amount: "2",
                },
                {
                  type: "deposit-asset",
                  asset: "DOT",
                  recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                  assetCount: 1,
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const response = await client.dispatch({
    intentId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    intent,
    quote,
  });

  assert.equal(response.job.id, "job-2");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "https://example.test/jobs/dispatch");
  const payload = JSON.parse(seen[0][1].body);
  assert.equal(payload.intent.quoteId, "0xfeedface");
  assert.equal(payload.request.mode, 0);
  assert.equal(payload.sourceIntent.kind, "router-evm");
  assert.equal(payload.sourceIntent.refundAsset, "DOT");
  assert.equal(payload.sourceIntent.refundableAmount, "13");
  assert.equal(payload.sourceIntent.minOutputAmount, "10");
  assert.match(payload.request.message, /^0x[0-9a-f]+$/);
});

test("createHttpExecutorRelayerClient registers pre-broadcast hydration dispatch metadata", async () => {
  const seen = [];
  const client = createHttpExecutorRelayerClient({
    endpoint: "https://example.test",
    authToken: "secret-token",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            job: {
              id: "job-3",
              status: "queued",
            },
          };
        },
      };
    },
  });

  await client.dispatch({
    intentId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    intent: {
      quoteId: "0xfeedf00d",
      sourceChain: "hydration",
      destinationChain: "moonbeam",
      refundAddress: "0x1111111111111111111111111111111111111111",
      deadline: 1_773_185_200,
      action: {
        type: "execute",
        params: {
          executionType: "call",
          asset: "DOT",
          maxPaymentAmount: "200000000",
          contractAddress: "0x1111111111111111111111111111111111111111",
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
    quote: {
      quoteId: "0xfeedf00d",
      deploymentProfile: "mainnet",
      route: ["hydration", "polkadot-hub", "moonbeam"],
      segments: [],
      fees: {
        xcmFee: { asset: "DOT", amount: "1" },
        destinationFee: { asset: "DOT", amount: "2" },
        platformFee: { asset: "DOT", amount: "3" },
        totalFee: { asset: "DOT", amount: "6" },
      },
      expectedOutput: { asset: "DOT", amount: "10" },
      minOutput: { asset: "DOT", amount: "10" },
      submission: {
        action: "execute",
        asset: "DOT",
        amount: "10",
        xcmFee: "1",
        destinationFee: "2",
        minOutputAmount: "0",
      },
      executionPlan: {
        route: ["hydration", "polkadot-hub", "moonbeam"],
        steps: [],
      },
    },
    request: {
      mode: 0,
      destination: "0x",
      message: "0x1234",
    },
    dispatchResult: {
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      strategy: "substrate-xcm-execute",
    },
  });

  const payload = JSON.parse(seen[0][1].body);
  assert.equal(payload.sourceIntent.kind, "substrate-source");
  assert.equal(
    payload.sourceDispatch.txHash,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(payload.sourceDispatch.strategy, "substrate-xcm-execute");
});

test("createHttpExecutorRelayerClient sends hydration source metadata without sourceDispatch when the relayer owns broadcast", async () => {
  const seen = [];
  const client = createHttpExecutorRelayerClient({
    endpoint: "https://example.test",
    authToken: "secret-token",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            job: {
              id: "job-4",
              status: "queued",
            },
          };
        },
      };
    },
  });

  await client.dispatch({
    intentId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    intent: {
      quoteId: "0xfeedf11d",
      sourceChain: "hydration",
      destinationChain: "moonbeam",
      refundAddress: "0x1111111111111111111111111111111111111111",
      deadline: 1_773_185_200,
      action: {
        type: "execute",
        params: {
          executionType: "call",
          asset: "DOT",
          maxPaymentAmount: "200000000",
          contractAddress: "0x1111111111111111111111111111111111111111",
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
    quote: {
      quoteId: "0xfeedf11d",
      deploymentProfile: "mainnet",
      route: ["hydration", "polkadot-hub", "moonbeam"],
      segments: [],
      fees: {
        xcmFee: { asset: "DOT", amount: "1" },
        destinationFee: { asset: "DOT", amount: "2" },
        platformFee: { asset: "DOT", amount: "3" },
        totalFee: { asset: "DOT", amount: "6" },
      },
      expectedOutput: { asset: "DOT", amount: "10" },
      minOutput: { asset: "DOT", amount: "10" },
      submission: {
        action: "execute",
        asset: "DOT",
        amount: "10",
        xcmFee: "1",
        destinationFee: "2",
        minOutputAmount: "0",
      },
      executionPlan: {
        route: ["hydration", "polkadot-hub", "moonbeam"],
        steps: [],
      },
    },
    request: {
      mode: 0,
      destination: "0x",
      message: "0x1234",
    },
  });

  const payload = JSON.parse(seen[0][1].body);
  assert.equal(payload.sourceIntent.kind, "substrate-source");
  assert.equal(payload.sourceDispatch, undefined);
});

test("createHttpExecutorRelayerClient registers pre-broadcast bifrost dispatch metadata", async () => {
  const seen = [];
  const client = createHttpExecutorRelayerClient({
    endpoint: "https://example.test",
    authToken: "secret-token",
    fetchImpl: async (url, request) => {
      seen.push([url, request]);
      return {
        ok: true,
        async json() {
          return {
            job: {
              id: "job-5",
              status: "queued",
            },
          };
        },
      };
    },
  });

  await client.dispatch({
    intentId: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    intent: {
      quoteId: "0xfeedf22d",
      sourceChain: "bifrost",
      destinationChain: "moonbeam",
      refundAddress: "0x1111111111111111111111111111111111111111",
      deadline: 1_773_185_200,
      action: {
        type: "transfer",
        params: {
          asset: "DOT",
          amount: "10",
          recipient: "5Frecipient",
        },
      },
    },
    quote: {
      quoteId: "0xfeedf22d",
      deploymentProfile: "mainnet",
      route: ["bifrost", "polkadot-hub", "moonbeam"],
      segments: [],
      fees: {
        xcmFee: { asset: "DOT", amount: "1" },
        destinationFee: { asset: "DOT", amount: "2" },
        platformFee: { asset: "DOT", amount: "3" },
        totalFee: { asset: "DOT", amount: "6" },
      },
      expectedOutput: { asset: "DOT", amount: "10" },
      minOutput: { asset: "DOT", amount: "10" },
      submission: {
        action: "transfer",
        asset: "DOT",
        amount: "10",
        xcmFee: "1",
        destinationFee: "2",
        minOutputAmount: "10",
      },
      executionPlan: {
        route: ["bifrost", "polkadot-hub", "moonbeam"],
        steps: [],
      },
    },
    request: {
      mode: 0,
      destination: "0x",
      message: "0x1234",
    },
    dispatchResult: {
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      strategy: "substrate-xcm-send",
    },
  });

  const payload = JSON.parse(seen[0][1].body);
  assert.equal(payload.sourceIntent.kind, "substrate-source");
  assert.equal(
    payload.sourceDispatch.txHash,
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(payload.sourceDispatch.strategy, "substrate-xcm-send");
});
