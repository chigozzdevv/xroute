import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "../../..");
const registrySourcePath = resolve(scriptDir, "../source/adapter-registry.json");
const generatedDir = resolve(scriptDir, "../generated");
const adapterSpecsOutputPath = resolve(generatedDir, "destination-adapter-specs.json");
const adapterDeploymentsOutputPath = resolve(
  generatedDir,
  "destination-adapter-deployments.json",
);
const deploymentsRoot = resolve(
  workspaceRoot,
  "contracts/polkadot-hub-router/deployments",
);

const shouldCheck = process.argv.includes("--check");
const registrySource = readJson(registrySourcePath);

const generatedSpecs = buildAdapterSpecsManifest(registrySource);
const generatedDeployments = buildAdapterDeploymentsManifest(registrySource);

writeJson(adapterSpecsOutputPath, generatedSpecs, shouldCheck);
writeJson(adapterDeploymentsOutputPath, generatedDeployments, shouldCheck);

function buildAdapterSpecsManifest(source) {
  return {
    dispatch: resolveFunctionSpec(source.dispatch),
    adapters: source.adapters
      .map(resolveFunctionSpec)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function buildAdapterDeploymentsManifest(source) {
  const deploymentFiles = listDeploymentFiles();
  const deployments = [];

  for (const deploymentPath of deploymentFiles) {
    const deployment = readJson(deploymentPath);
    validateDeploymentFile(deploymentPath, deployment);
    const contracts = deployment.contracts ?? {};

    for (const adapter of source.adapters) {
      const address = contracts[adapter.implementationContract];
      if (!address) {
        throw new Error(
          `missing deployment for ${adapter.implementationContract} in ${deploymentPath}`,
        );
      }

      deployments.push({
        adapterId: adapter.id,
        chainKey: deployment.chainKey,
        deploymentProfile: deployment.deploymentProfile,
        implementationContract: adapter.implementationContract,
        address: normalizeAddress(address),
      });
    }
  }

  return {
    deployments: deployments.sort(compareDeployments),
  };
}

function resolveFunctionSpec(definition) {
  const artifact = readJson(resolve(workspaceRoot, definition.artifact));
  const entry = findFunction(artifact, definition.functionName);
  const signature = buildFunctionSignature(entry);
  const selector = artifact.methodIdentifiers?.[signature];

  if (!selector) {
    throw new Error(
      `missing selector for ${definition.functionName} in ${definition.artifact}`,
    );
  }

  const resolved = {
    signature,
    selector: normalizeSelector(selector),
  };

  if (definition.id) {
    return {
      id: definition.id,
      targetKind: definition.targetKind,
      implementationContract: definition.implementationContract,
      ...resolved,
    };
  }

  return {
    interfaceContract: definition.interfaceContract,
    ...resolved,
  };
}

function findFunction(artifact, functionName) {
  const matches = (artifact.abi ?? []).filter(
    (entry) => entry.type === "function" && entry.name === functionName,
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one function named ${functionName}`);
  }

  return matches[0];
}

function buildFunctionSignature(entry) {
  const inputs = (entry.inputs ?? []).map((input) => canonicalAbiType(input));
  return `${entry.name}(${inputs.join(",")})`;
}

function canonicalAbiType(input) {
  if (!input.type.startsWith("tuple")) {
    return input.type;
  }

  const suffix = input.type.slice("tuple".length);
  const components = (input.components ?? []).map((component) => canonicalAbiType(component));
  return `(${components.join(",")})${suffix}`;
}

function listDeploymentFiles() {
  return readdirSync(deploymentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const profileDir = resolve(deploymentsRoot, entry.name);
      return readdirSync(profileDir, { withFileTypes: true })
        .filter((child) => child.isFile() && extname(child.name) === ".json")
        .map((child) => resolve(profileDir, child.name));
    })
    .sort();
}

function validateDeploymentFile(path, deployment) {
  if (typeof deployment.chainKey !== "string" || deployment.chainKey.length === 0) {
    throw new Error(`missing chainKey in ${path}`);
  }

  if (
    typeof deployment.deploymentProfile !== "string" ||
    deployment.deploymentProfile.length === 0
  ) {
    throw new Error(`missing deploymentProfile in ${path}`);
  }

  if (!deployment.contracts || typeof deployment.contracts !== "object") {
    throw new Error(`missing contracts map in ${path}`);
  }
}

function normalizeSelector(selector) {
  const normalized = selector.startsWith("0x") ? selector.toLowerCase() : `0x${selector.toLowerCase()}`;
  if (!/^0x[0-9a-f]{8}$/.test(normalized)) {
    throw new Error(`invalid selector: ${selector}`);
  }

  return normalized;
}

function normalizeAddress(address) {
  const normalized = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`invalid address: ${address}`);
  }

  return normalized;
}

function compareDeployments(left, right) {
  return (
    left.adapterId.localeCompare(right.adapterId) ||
    left.chainKey.localeCompare(right.chainKey) ||
    left.deploymentProfile.localeCompare(right.deploymentProfile)
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value, checkOnly) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (checkOnly) {
    const current = readFileSync(path, "utf8");
    if (current !== next) {
      throw new Error(`${path} is out of date`);
    }
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}
