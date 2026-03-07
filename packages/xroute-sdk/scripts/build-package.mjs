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
    from: resolve(packageRoot, "router-adapters.mjs"),
    to: resolve(distRoot, "router-adapters.mjs"),
    replacements: [
      ["../xroute-types/index.mjs", "./vendor/xroute-types/index.mjs"],
      ["../xroute-xcm/index.mjs", "./vendor/xroute-xcm/index.mjs"],
    ],
  },
  {
    from: resolve(packageRoot, "status-indexer.mjs"),
    to: resolve(distRoot, "status-indexer.mjs"),
    replacements: [
      ["../xroute-types/index.mjs", "./vendor/xroute-types/index.mjs"],
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
