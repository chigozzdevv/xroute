import { spawn } from "node:child_process";

export async function spawnRustService({
  packageName,
  cwd,
  env = {},
  startupTimeoutMs = 30_000,
} = {}) {
  if (!packageName) {
    throw new Error("packageName is required");
  }

  const child = spawn("cargo", ["run", "-q", "-p", packageName, "--"], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let resolved = false;

  const ready = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(
        new Error(
          `timed out waiting for ${packageName} startup\n${stderr.trim()}`,
        ),
      );
    }, startupTimeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    function onStdout(chunk) {
      const lines = String(chunk)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.url) {
            resolved = true;
            cleanup();
            resolvePromise(parsed);
            return;
          }
        } catch {}
      }
    }

    function onStderr(chunk) {
      stderr += String(chunk);
    }

    function onExit(code, signal) {
      if (resolved) {
        return;
      }
      cleanup();
      rejectPromise(
        new Error(
          `${packageName} exited before startup (code=${code}, signal=${signal})\n${stderr.trim()}`,
        ),
      );
    }

    function onError(error) {
      cleanup();
      rejectPromise(error);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });

  return {
    child,
    ...ready,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise((resolvePromise) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolvePromise();
        });
      });
    },
  };
}
