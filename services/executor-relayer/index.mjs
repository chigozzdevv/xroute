import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createIntent, toPlainIntent } from "../../packages/xroute-intents/index.mjs";
import {
  normalizeQuote,
  createHttpExecutorRelayerClient,
} from "../../packages/xroute-sdk/index.mjs";
import { createCastRouterAdapter } from "../../packages/xroute-sdk/router-adapters.mjs";
import { FileBackedStatusIndexer } from "../../packages/xroute-sdk/status-indexer.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../packages/xroute-precompile-interfaces/index.mjs";
import {
  buildDispatchRequest,
  buildExecutionEnvelope,
  createDispatchEnvelope,
} from "../../packages/xroute-xcm/index.mjs";
import {
  assertBytes32Hex,
  assertHexString,
  assertNonEmptyString,
  deterministicId,
  toBigInt,
  toPlainObject,
} from "../../packages/xroute-types/index.mjs";
import {
  assertIntentAllowedByExecutionPolicy,
  loadExecutionPolicyFromFile,
  summarizeExecutionPolicy,
} from "../shared/execution-policy.mjs";
import {
  loadHubDeploymentArtifact,
  resolveWorkspaceRoot,
} from "../shared/deployments.mjs";
import {
  assertBearerToken,
  closeServer,
  readJsonBody,
  sendJson,
} from "../shared/http.mjs";
import { createFileBackedJobStore } from "./store.mjs";

const serviceDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(serviceDir, "../..");

const JOB_TYPES = Object.freeze({
  DISPATCH: "dispatch",
  SETTLE: "settle",
  FAIL: "fail",
  REFUND: "refund",
});

const JOB_STATUSES = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
});

export async function startExecutorRelayer({
  host = process.env.XROUTE_RELAYER_HOST ?? "127.0.0.1",
  port = Number(process.env.XROUTE_RELAYER_PORT ?? "8788"),
  maxBodyBytes = Number(process.env.XROUTE_RELAYER_MAX_BODY_BYTES ?? "262144"),
  workspaceRoot = resolveWorkspaceRoot(defaultWorkspaceRoot),
  deploymentProfile = process.env.XROUTE_DEPLOYMENT_PROFILE ?? DEFAULT_DEPLOYMENT_PROFILE,
  authToken = process.env.XROUTE_RELAYER_AUTH_TOKEN,
  rpcUrl = process.env.XROUTE_RPC_URL,
  privateKey = process.env.XROUTE_PRIVATE_KEY,
  routerAddress = process.env.XROUTE_ROUTER_ADDRESS,
  routerAdapter = null,
  executionPolicy = null,
  executionPolicyPath = process.env.XROUTE_EVM_POLICY_PATH,
  deployment = null,
  jobStore = null,
  jobStorePath = process.env.XROUTE_RELAYER_JOB_STORE_PATH,
  statusIndexer = null,
  statusEventsPath = process.env.XROUTE_STATUS_EVENTS_PATH,
  pollIntervalMs = Number(process.env.XROUTE_RELAYER_POLL_INTERVAL_MS ?? "1000"),
  maxAttempts = Number(process.env.XROUTE_RELAYER_MAX_ATTEMPTS ?? "5"),
  retryDelayMs = Number(process.env.XROUTE_RELAYER_RETRY_DELAY_MS ?? "3000"),
  now = () => Date.now(),
} = {}) {
  const normalizedProfile = normalizeDeploymentProfile(deploymentProfile);
  const normalizedAuthToken = assertNonEmptyString(
    "authToken",
    authToken,
  );
  const policy =
    executionPolicy ??
    (executionPolicyPath ? loadExecutionPolicyFromFile(executionPolicyPath) : null);
  const resolvedDeployment =
    deployment ??
    tryLoadDeploymentArtifact({
      workspaceRoot,
      deploymentProfile: normalizedProfile,
    });
  const resolvedRouterAddress =
    routerAddress ??
    resolvedDeployment?.routerAddress ??
    (() => {
      throw new Error("routerAddress or a deployment artifact is required");
    })();
  const resolvedStatusIndexer =
    statusIndexer ??
    new FileBackedStatusIndexer({
      eventsPath:
        statusEventsPath ??
        resolve(
          workspaceRoot,
          "services/executor-relayer/data",
          `${normalizedProfile}-status.ndjson`,
        ),
    });
  const resolvedJobStore =
    jobStore ??
    createFileBackedJobStore({
      path:
        jobStorePath ??
        resolve(
          workspaceRoot,
          "services/executor-relayer/data",
          `${normalizedProfile}-jobs.json`,
        ),
    });
  const adapter =
    routerAdapter ??
    createCastRouterAdapter({
      rpcUrl: assertNonEmptyString("rpcUrl", rpcUrl),
      routerAddress: resolvedRouterAddress,
      privateKey: assertHexString("privateKey", privateKey),
      statusIndexer: resolvedStatusIndexer,
      cwd: workspaceRoot,
    });

  let processing = false;
  let closed = false;
  let timer;

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return sendJson(response, 200, {
          ok: true,
          deploymentProfile: normalizedProfile,
          routerAddress: resolvedRouterAddress,
          policy: summarizeExecutionPolicy(policy),
          jobs: summarizeJobs(resolvedJobStore.list()),
        });
      }

      assertBearerToken(request, normalizedAuthToken);

      if (request.method === "GET" && request.url === "/jobs") {
        return sendJson(response, 200, {
          jobs: resolvedJobStore.list().sort(compareJobs),
        });
      }

      if (request.method === "GET" && request.url?.startsWith("/jobs/")) {
        const jobId = decodeURIComponent(request.url.slice("/jobs/".length));
        const job = resolvedJobStore.get(jobId);
        if (!job) {
          return sendJson(response, 404, { error: "job-not-found" });
        }

        return sendJson(response, 200, { job });
      }

      if (request.method === "POST" && request.url === "/jobs/dispatch") {
        const body = await readJsonBody(request, { maxBytes: maxBodyBytes });
        const job = enqueueJob(
          resolvedJobStore,
          buildDispatchJobPayload(body, policy),
          now,
          maxAttempts,
        );
        void processJobs();
        return sendJson(response, 202, { job });
      }

      if (request.method === "POST" && request.url === "/jobs/settle") {
        const body = await readJsonBody(request, { maxBytes: maxBodyBytes });
        const job = enqueueJob(
          resolvedJobStore,
          buildSettleJobPayload(body),
          now,
          maxAttempts,
        );
        void processJobs();
        return sendJson(response, 202, { job });
      }

      if (request.method === "POST" && request.url === "/jobs/fail") {
        const body = await readJsonBody(request, { maxBytes: maxBodyBytes });
        const job = enqueueJob(
          resolvedJobStore,
          buildFailJobPayload(body),
          now,
          maxAttempts,
        );
        void processJobs();
        return sendJson(response, 202, { job });
      }

      if (request.method === "POST" && request.url === "/jobs/refund") {
        const body = await readJsonBody(request, { maxBytes: maxBodyBytes });
        const job = enqueueJob(
          resolvedJobStore,
          buildRefundJobPayload(body),
          now,
          maxAttempts,
        );
        void processJobs();
        return sendJson(response, 202, { job });
      }

      return sendJson(response, 404, { error: "not-found" });
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, {
        error: error.message,
      });
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  timer = setInterval(() => {
    void processJobs();
  }, pollIntervalMs);
  timer.unref?.();
  void processJobs();

  async function processJobs() {
    if (processing || closed) {
      return;
    }

    processing = true;
    try {
      const readyJobs = resolvedJobStore
        .list()
        .filter((job) => isReady(job, now()))
        .sort(compareJobs);

      for (const job of readyJobs) {
        if (closed) {
          return;
        }

        const current = resolvedJobStore.get(job.id);
        if (!current || !isReady(current, now())) {
          continue;
        }

        resolvedJobStore.upsert({
          ...current,
          status: JOB_STATUSES.RUNNING,
          attempts: current.attempts + 1,
          updatedAt: now(),
          lastError: null,
        });

        try {
          const result = await runJob(adapter, current);
          resolvedJobStore.upsert({
            ...resolvedJobStore.get(job.id),
            status: JOB_STATUSES.COMPLETED,
            updatedAt: now(),
            completedAt: now(),
            result: toPlainObject(result),
            lastError: null,
          });
        } catch (error) {
          const failedJob = resolvedJobStore.get(job.id);
          const shouldRetry = failedJob.attempts < failedJob.maxAttempts;
          resolvedJobStore.upsert({
            ...failedJob,
            status: JOB_STATUSES.FAILED,
            updatedAt: now(),
            nextAttemptAt: shouldRetry ? now() + retryDelayMs : null,
            lastError: error.message,
          });
        }
      }
    } finally {
      processing = false;
    }
  }

  async function drain({
    timeoutMs = 15_000,
    idleMs = 50,
  } = {}) {
    const startedAt = now();
    while (true) {
      const jobs = resolvedJobStore.list();
      const pending = jobs.some(
        (job) =>
          job.status === JOB_STATUSES.QUEUED ||
          job.status === JOB_STATUSES.RUNNING ||
          (job.status === JOB_STATUSES.FAILED && job.nextAttemptAt !== null),
      );
      if (!pending && !processing) {
        return jobs;
      }
      if (now() - startedAt > timeoutMs) {
        throw new Error("relayer did not drain within timeout");
      }

      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, idleMs);
      });
    }
  }

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    host,
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    deploymentProfile: normalizedProfile,
    routerAddress: resolvedRouterAddress,
    jobStore: resolvedJobStore,
    statusIndexer: resolvedStatusIndexer,
    close: async () => {
      closed = true;
      clearInterval(timer);
      await closeServer(server);
    },
    drain,
    client: createHttpExecutorRelayerClient({
      endpoint: `http://${host}:${resolvedPort}`,
      authToken: normalizedAuthToken,
    }),
  };
}

function enqueueJob(store, payload, now, maxAttempts) {
  const id = deterministicId({
    type: payload.type,
    payload: toPlainObject(payload.payload),
  });
  const existing = store.get(id);
  if (existing) {
    return existing;
  }

  const timestamp = now();
  const job = Object.freeze({
    id,
    type: payload.type,
    status: JOB_STATUSES.QUEUED,
    attempts: 0,
    maxAttempts,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    payload: payload.payload,
    result: null,
    lastError: null,
    completedAt: null,
  });

  return store.upsert(job);
}

function buildDispatchJobPayload(body, policy) {
  const intent = createIntent(body.intent);
  assertIntentAllowedByExecutionPolicy(intent, policy);
  const quote = normalizeQuote(body.quote);
  if (quote.quoteId !== intent.quoteId) {
    throw new Error("quote does not belong to the provided intent");
  }

  const envelope = body.envelope
    ? createDispatchEnvelope(body.envelope)
    : buildExecutionEnvelope({ intent, quote });

  return {
    type: JOB_TYPES.DISPATCH,
    payload: Object.freeze({
      intentId: assertBytes32Hex("intentId", body.intentId),
      intent: toPlainIntent(intent),
      quote: toPlainObject(quote),
      request: buildDispatchRequest(envelope),
    }),
  };
}

function buildSettleJobPayload(body) {
  return {
    type: JOB_TYPES.SETTLE,
    payload: Object.freeze({
      intentId: assertBytes32Hex("intentId", body.intentId),
      outcomeReference: assertBytes32Hex("outcomeReference", body.outcomeReference),
      resultAssetId: assertBytes32Hex("resultAssetId", body.resultAssetId),
      resultAmount: toBigInt(body.resultAmount, "resultAmount").toString(),
    }),
  };
}

function buildFailJobPayload(body) {
  return {
    type: JOB_TYPES.FAIL,
    payload: Object.freeze({
      intentId: assertBytes32Hex("intentId", body.intentId),
      outcomeReference: assertBytes32Hex("outcomeReference", body.outcomeReference),
      failureReasonHash: assertBytes32Hex(
        "failureReasonHash",
        body.failureReasonHash,
      ),
    }),
  };
}

function buildRefundJobPayload(body) {
  return {
    type: JOB_TYPES.REFUND,
    payload: Object.freeze({
      intentId: assertBytes32Hex("intentId", body.intentId),
      refundAmount: toBigInt(body.refundAmount, "refundAmount").toString(),
      refundAsset:
        body.refundAsset === undefined
          ? null
          : assertNonEmptyString("refundAsset", body.refundAsset),
    }),
  };
}

async function runJob(routerAdapter, job) {
  switch (job.type) {
    case JOB_TYPES.DISPATCH:
      return routerAdapter.dispatchIntent({
        intentId: job.payload.intentId,
        request: job.payload.request,
      });
    case JOB_TYPES.SETTLE:
      return routerAdapter.finalizeSuccess({
        intentId: job.payload.intentId,
        outcomeReference: job.payload.outcomeReference,
        resultAssetId: job.payload.resultAssetId,
        resultAmount: job.payload.resultAmount,
      });
    case JOB_TYPES.FAIL:
      return routerAdapter.finalizeFailure({
        intentId: job.payload.intentId,
        outcomeReference: job.payload.outcomeReference,
        failureReasonHash: job.payload.failureReasonHash,
      });
    case JOB_TYPES.REFUND:
      return routerAdapter.refundFailedIntent({
        intentId: job.payload.intentId,
        refundAmount: job.payload.refundAmount,
        refundAsset: job.payload.refundAsset ?? undefined,
      });
    default:
      throw new Error(`unsupported job type: ${job.type}`);
  }
}

function isReady(job, nowMs) {
  if (job.status === JOB_STATUSES.RUNNING || job.status === JOB_STATUSES.COMPLETED) {
    return false;
  }

  return job.nextAttemptAt === null || job.nextAttemptAt <= nowMs;
}

function compareJobs(left, right) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }

  return left.id.localeCompare(right.id);
}

function summarizeJobs(jobs) {
  const summary = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  for (const job of jobs) {
    summary[job.status] = (summary[job.status] ?? 0) + 1;
  }

  return summary;
}

function tryLoadDeploymentArtifact(options) {
  try {
    return loadHubDeploymentArtifact(options);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startExecutorRelayer()
    .then(({ url, deploymentProfile, routerAddress }) => {
      console.log(
        JSON.stringify(
          {
            url,
            deploymentProfile,
            routerAddress,
          },
          null,
          2,
        ),
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
