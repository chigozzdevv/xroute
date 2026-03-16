import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const dotEnvPath = resolve(workspaceRoot, ".env");
const liveQuoteInputsScript = resolve(workspaceRoot, "scripts/fetch-live-quote-inputs.mjs");

export function resolveServeApiLaunch() {
  const loadedEnv = loadDotEnv(dotEnvPath);
  const env = {
    ...loadedEnv,
    ...process.env,
  };

  if (!env.XROUTE_WORKSPACE_ROOT?.trim()) {
    env.XROUTE_WORKSPACE_ROOT = workspaceRoot;
  }

  if (
    !env.XROUTE_LIVE_QUOTE_INPUTS_PATH?.trim()
    && !env.XROUTE_LIVE_QUOTE_INPUTS_COMMAND?.trim()
    && existsSync(liveQuoteInputsScript)
  ) {
    env.XROUTE_LIVE_QUOTE_INPUTS_COMMAND = `node ${liveQuoteInputsScript}`;
  }

  return {
    command: "cargo",
    args: ["run", "-q", "-p", "xroute-api", "--"],
    cwd: workspaceRoot,
    env,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const launch = resolveServeApiLaunch();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`failed to start xroute-api: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return {};
  }

  const loaded = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (key === "") {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    loaded[key] = normalizeEnvValue(rawValue);
  }

  return loaded;
}

function normalizeEnvValue(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" || first === "'") && last === first) {
      return value.slice(1, -1);
    }
  }

  return value;
}
