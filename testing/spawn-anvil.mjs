import { createServer } from "node:net";
import { spawn } from "node:child_process";

const DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export async function spawnAnvil({ host = "127.0.0.1" } = {}) {
  const port = await reservePort(host);
  const child = spawn("anvil", ["--host", host, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`timed out waiting for anvil\n${stderr.trim()}`));
    }, 15_000);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    function onStdout(chunk) {
      const text = String(chunk);
      if (text.includes("Listening on")) {
        cleanup();
        resolvePromise();
      }
    }

    function onStderr(chunk) {
      stderr += String(chunk);
    }

    function onExit(code, signal) {
      cleanup();
      rejectPromise(
        new Error(`anvil exited before startup (code=${code}, signal=${signal})\n${stderr.trim()}`),
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
    rpcUrl: `http://${host}:${port}`,
    privateKey: DEFAULT_PRIVATE_KEY,
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

function reservePort(host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("failed to reserve an ephemeral port"));
        return;
      }

      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise(address.port);
      });
    });
  });
}
