import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const distRoot = resolve(packageRoot, "dist");

rmSync(distRoot, { recursive: true, force: true });

const textCopies = [
  {
    from: resolve(packageRoot, "index.mjs"),
    to: resolve(distRoot, "index.mjs"),
    replacements: [
      ["../xroute-intents/index.mjs", "./vendor/xroute-intents/index.mjs"],
      ["../xroute-types/index.mjs", "./vendor/xroute-types/index.mjs"],
      ["../xroute-xcm/index.mjs", "./vendor/xroute-xcm/index.mjs"],
      ["../xroute-precompile-interfaces/index.mjs", "./vendor/xroute-precompile-interfaces/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "quote/index.mjs"),
    to: resolve(distRoot, "quote/index.mjs"),
    replacements: [
      ["../../xroute-intents/index.mjs", "../vendor/xroute-intents/index.mjs"],
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-precompile-interfaces/index.mjs", "../vendor/xroute-precompile-interfaces/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "quote/normalize.mjs"),
    to: resolve(distRoot, "quote/normalize.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-precompile-interfaces/index.mjs", "../vendor/xroute-precompile-interfaces/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "wallet/index.mjs"),
    to: resolve(distRoot, "wallet/index.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-precompile-interfaces/index.mjs", "../vendor/xroute-precompile-interfaces/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "status/index.mjs"),
    to: resolve(distRoot, "status/index.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "internal/constants.mjs"),
    to: resolve(distRoot, "internal/constants.mjs"),
    replacements: [],
  },
  {
    from: resolve(packageRoot, "internal/client-core.mjs"),
    to: resolve(distRoot, "internal/client-core.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-xcm/index.mjs", "../vendor/xroute-xcm/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "chains/index.mjs"),
    to: resolve(distRoot, "chains/index.mjs"),
    replacements: [
      ["../../xroute-chain-registry/index.mjs", "../vendor/xroute-chain-registry/index.mjs"],
      ["../../xroute-precompile-interfaces/index.mjs", "../vendor/xroute-precompile-interfaces/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "routes/index.mjs"),
    to: resolve(distRoot, "routes/index.mjs"),
    replacements: [
      ["../../xroute-chain-registry/index.mjs", "../vendor/xroute-chain-registry/index.mjs"],
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-precompile-interfaces/index.mjs", "../vendor/xroute-precompile-interfaces/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "wallets/wallet-adapters.mjs"),
    to: resolve(distRoot, "wallets/wallet-adapters.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-xcm/index.mjs", "../vendor/xroute-xcm/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "routers/router-adapters.mjs"),
    to: resolve(distRoot, "routers/router-adapters.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-xcm/index.mjs", "../vendor/xroute-xcm/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "internal/relayer-client.mjs"),
    to: resolve(distRoot, "internal/relayer-client.mjs"),
    replacements: [
      ["../../xroute-intents/index.mjs", "../vendor/xroute-intents/index.mjs"],
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
      ["../../xroute-xcm/index.mjs", "../vendor/xroute-xcm/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "indexers/status-indexer.mjs"),
    to: resolve(distRoot, "indexers/status-indexer.mjs"),
    replacements: [
      ["../../xroute-types/index.mjs", "../vendor/xroute-types/index.mjs"],
    ],
  },
  {
    from: resolve(workspaceRoot, "packages/xroute-intents/index.mjs"),
    to: resolve(distRoot, "vendor/xroute-intents/index.mjs"),
    replacements: [
      ["../xroute-types/index.mjs", "../xroute-types/index.mjs"],
      ["../xroute-chain-registry/index.mjs", "../xroute-chain-registry/index.mjs"],
    ],
  },
  {
    from: resolve(workspaceRoot, "packages/xroute-types/index.mjs"),
    to: resolve(distRoot, "vendor/xroute-types/index.mjs"),
    replacements: [],
  },
  {
    from: resolve(workspaceRoot, "packages/xroute-chain-registry/index.mjs"),
    to: resolve(distRoot, "vendor/xroute-chain-registry/index.mjs"),
    replacements: [
      ["../xroute-types/index.mjs", "../xroute-types/index.mjs"],
    ],
  },
  {
    from: resolve(workspaceRoot, "packages/xroute-precompile-interfaces/index.mjs"),
    to: resolve(distRoot, "vendor/xroute-precompile-interfaces/index.mjs"),
    replacements: [
      ["../xroute-types/index.mjs", "../xroute-types/index.mjs"],
    ],
  },
  {
    from: resolve(workspaceRoot, "packages/xroute-xcm/index.mjs"),
    to: resolve(distRoot, "vendor/xroute-xcm/index.mjs"),
    replacements: [
      ["../xroute-chain-registry/index.mjs", "../xroute-chain-registry/index.mjs"],
      ["../xroute-types/index.mjs", "../xroute-types/index.mjs"],
      ["../xroute-precompile-interfaces/index.mjs", "../xroute-precompile-interfaces/index.mjs"],
    ],
  },
];

for (const file of textCopies) {
  let contents = readFileSync(file.from, "utf8");
  for (const [from, to] of file.replacements) {
    contents = contents.replaceAll(from, to);
  }

  mkdirSync(dirname(file.to), { recursive: true });
  writeFileSync(file.to, contents);
}

const binaryCopies = [
  {
    from: resolve(
      workspaceRoot,
      "packages/xroute-xcm/metadata/polkadot-asset-hub.hex",
    ),
    to: resolve(distRoot, "vendor/xroute-xcm/metadata/polkadot-asset-hub.hex"),
  },
];

for (const file of binaryCopies) {
  mkdirSync(dirname(file.to), { recursive: true });
  cpSync(file.from, file.to);
}
