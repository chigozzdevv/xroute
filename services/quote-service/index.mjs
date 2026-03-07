import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createIntent, toPlainIntent } from "../../packages/xroute-intents/index.mjs";
import { createRouteEngineQuoteProvider } from "../../packages/xroute-sdk/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../packages/xroute-precompile-interfaces/index.mjs";
import {
  assertIntentAllowedByExecutionPolicy,
  loadExecutionPolicyFromFile,
  summarizeExecutionPolicy,
} from "../shared/execution-policy.mjs";
import {
  loadHubDeploymentArtifact,
  resolveWorkspaceRoot,
} from "../shared/deployments.mjs";
import { closeServer, readJsonBody, sendJson } from "../shared/http.mjs";

const serviceDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(serviceDir, "../..");

export async function startQuoteService({
  host = process.env.XROUTE_QUOTE_HOST ?? "127.0.0.1",
  port = Number(process.env.XROUTE_QUOTE_PORT ?? "8787"),
  maxBodyBytes = Number(process.env.XROUTE_QUOTE_MAX_BODY_BYTES ?? "262144"),
  workspaceRoot = resolveWorkspaceRoot(defaultWorkspaceRoot),
  deploymentProfile = process.env.XROUTE_DEPLOYMENT_PROFILE ?? DEFAULT_DEPLOYMENT_PROFILE,
  quoteProvider = null,
  executionPolicy = null,
  executionPolicyPath = process.env.XROUTE_EVM_POLICY_PATH,
  deployment = null,
} = {}) {
  const normalizedProfile = normalizeDeploymentProfile(deploymentProfile);
  const policy =
    executionPolicy ??
    (executionPolicyPath ? loadExecutionPolicyFromFile(executionPolicyPath) : null);
  const resolvedDeployment =
    deployment ??
    tryLoadDeploymentArtifact({
      workspaceRoot,
      deploymentProfile: normalizedProfile,
    });
  const provider =
    quoteProvider ??
    createRouteEngineQuoteProvider({
      cwd: workspaceRoot,
      deploymentProfile: normalizedProfile,
    });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return sendJson(response, 200, {
          ok: true,
          deploymentProfile: normalizedProfile,
          routerAddress: resolvedDeployment?.routerAddress ?? null,
          policy: summarizeExecutionPolicy(policy),
        });
      }

      if (request.method === "POST" && request.url === "/quote") {
        const body = await readJsonBody(request, { maxBytes: maxBodyBytes });
        const intent = createIntent(body.intent);
        assertIntentAllowedByExecutionPolicy(intent, policy);
        const quote = await provider.quote(intent);

        return sendJson(response, 200, {
          intent: toPlainIntent(intent),
          quote,
          deploymentProfile: normalizedProfile,
          routerAddress: resolvedDeployment?.routerAddress ?? null,
        });
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

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    host,
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    deploymentProfile: normalizedProfile,
    server,
    close: () => closeServer(server),
  };
}

function tryLoadDeploymentArtifact(options) {
  try {
    return loadHubDeploymentArtifact(options);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startQuoteService()
    .then(({ url, deploymentProfile }) => {
      console.log(
        JSON.stringify(
          {
            url,
            deploymentProfile,
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
