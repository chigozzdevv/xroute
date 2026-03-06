import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  AccountId,
  Binary,
  Enum,
  metadata,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";

import { getAssetLocation, getParachainId } from "../xroute-chain-registry/index.mjs";
import {
  DISPATCH_MODES,
  assertAddress,
  assertHexString,
  assertIncluded,
  assertInteger,
  assertNonEmptyString,
  toBigInt,
} from "../xroute-types/index.mjs";
import {
  ACTION_TO_CONTRACT_ENUM,
  DESTINATION_TRANSACT_DISPATCH,
  DISPATCH_MODE_TO_CONTRACT_ENUM,
  getDestinationAdapterDeployment,
  getDestinationAdapterSpec,
} from "../xroute-precompile-interfaces/index.mjs";

const VERSIONED_LOCATION_TYPE_ID = 164;
const VERSIONED_XCM_TYPE_ID = 270;
const DEFAULT_METADATA_HEX = readFileSync(
  new URL("./metadata/polkadot-asset-hub.hex", import.meta.url),
  "utf8",
).trim();

let defaultCodecContext;

export function createDispatchEnvelope({
  mode,
  destination,
  destinationHex,
  message,
  messageHex,
}) {
  const normalizedMode = assertIncluded("mode", mode, Object.values(DISPATCH_MODES));
  const normalizedMessageHex = assertHexString("message", messageHex ?? message);
  const normalizedDestinationHex = assertHexString(
    "destination",
    destinationHex ?? destination ?? "0x",
  );

  if (normalizedMode === DISPATCH_MODES.SEND && normalizedDestinationHex === "0x") {
    throw new Error("destination must be provided for send dispatches");
  }

  return Object.freeze({
    mode: normalizedMode,
    destinationHex: normalizedDestinationHex,
    messageHex: normalizedMessageHex,
  });
}

export function createXcmCodecContext({
  metadataHex = DEFAULT_METADATA_HEX,
  versionedLocationTypeId = VERSIONED_LOCATION_TYPE_ID,
  versionedXcmTypeId = VERSIONED_XCM_TYPE_ID,
} = {}) {
  const decodedMetadata = unifyMetadata(metadata.dec(metadataHex));
  const dynamicBuilder = getDynamicBuilder(getLookupFn(decodedMetadata));
  const locationCodec = dynamicBuilder.buildDefinition(versionedLocationTypeId);
  const xcmCodec = dynamicBuilder.buildDefinition(versionedXcmTypeId);

  return Object.freeze({
    encodeVersionedLocation(value) {
      return Binary.fromBytes(locationCodec.enc(value)).asHex();
    },

    decodeVersionedLocation(value) {
      return locationCodec.dec(value);
    },

    encodeVersionedXcm(value) {
      return Binary.fromBytes(xcmCodec.enc(value)).asHex();
    },

    decodeVersionedXcm(value) {
      return xcmCodec.dec(value);
    },
  });
}

export function getDefaultXcmCodecContext() {
  if (!defaultCodecContext) {
    defaultCodecContext = createXcmCodecContext();
  }

  return defaultCodecContext;
}

export function buildExecutionEnvelope({
  intent,
  quote,
  codecContext = getDefaultXcmCodecContext(),
}) {
  const message = buildVersionedXcmMessage({ quote });

  return createDispatchEnvelope({
    mode: DISPATCH_MODES.EXECUTE,
    messageHex: codecContext.encodeVersionedXcm(message),
  });
}

export function computeExecutionHash(envelope, { castBin = "cast" } = {}) {
  const normalized = createDispatchEnvelope(envelope);
  const modeValue = DISPATCH_MODE_TO_CONTRACT_ENUM[normalized.mode];

  const encoded = execFileSync(
    castBin,
    [
      "abi-encode",
      "f(uint8,bytes,bytes)",
      String(modeValue),
      normalized.destinationHex,
      normalized.messageHex,
    ],
    { encoding: "utf8" },
  ).trim();

  return execFileSync(castBin, ["keccak", encoded], { encoding: "utf8" }).trim().toLowerCase();
}

export function buildDispatchRequest(envelope) {
  const normalized = createDispatchEnvelope(envelope);

  return Object.freeze({
    mode: DISPATCH_MODE_TO_CONTRACT_ENUM[normalized.mode],
    destination: normalized.destinationHex,
    message: normalized.messageHex,
  });
}

export function buildRouterIntentRequest({
  intent,
  quote,
  envelope,
  assetAddress,
  castBin = "cast",
}) {
  const executionHash = computeExecutionHash(envelope, { castBin });
  const normalizedAddress = assertHexString("assetAddress", assetAddress);

  if (!quote?.submission) {
    throw new Error("quote.submission is required");
  }

  if (quote.quoteId !== intent.quoteId) {
    throw new Error("quote does not belong to the provided intent");
  }

  return Object.freeze({
    actionType: ACTION_TO_CONTRACT_ENUM[quote.submission.action],
    asset: normalizedAddress,
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
    executionHash,
  });
}

export function buildExplorerLabel({ sourceChain, destinationChain, mode }) {
  assertNonEmptyString("sourceChain", sourceChain);
  assertNonEmptyString("destinationChain", destinationChain);
  assertIncluded("mode", mode, Object.values(DISPATCH_MODES));

  return `${sourceChain} -> ${destinationChain} (${mode})`;
}

export function buildVersionedXcmMessage({ quote }) {
  const sendStep = getExecutionStep(quote, "send-xcm");
  const transferInstruction = getInstruction(sendStep, "transfer-reserve-asset");
  const transferAmount = toBigInt(
    transferInstruction.amount,
    "executionPlan.instructions.transfer-reserve-asset.amount",
  );

  return Enum("V5", [
    Enum("SetFeesMode", { jit_withdraw: true }),
    Enum("TransferReserveAsset", {
      assets: [
        buildAsset({
          chainKey: sendStep.origin,
          assetKey: transferInstruction.asset,
          amount: transferAmount,
        }),
      ],
      dest: buildParachainLocation(sendStep.destination),
      xcm: transferInstruction.remoteInstructions.map((instruction) =>
        buildRemoteInstruction({
          instruction,
          sendStep,
        }),
      ),
    }),
  ]);
}

function getExecutionStep(quote, stepType) {
  const step = quote?.executionPlan?.steps?.find((candidate) => candidate.type === stepType);

  if (!step) {
    throw new Error(`missing execution plan step: ${stepType}`);
  }

  return step;
}

function getInstruction(sendStep, instructionType) {
  const instruction = sendStep.instructions?.find(
    (candidate) => candidate.type === instructionType,
  );

  if (!instruction) {
    throw new Error(`missing XCM instruction: ${instructionType}`);
  }

  return instruction;
}

function buildRemoteInstruction({
  instruction,
  sendStep,
}) {
  switch (instruction.type) {
    case "buy-execution":
      return Enum("BuyExecution", {
        fees: buildAsset({
          chainKey: sendStep.destination,
          assetKey: instruction.asset,
          amount: toBigInt(instruction.amount, "buy-execution.amount"),
        }),
        weight_limit: Enum("Unlimited", undefined),
      });
    case "transact":
      assertPublishedAdapterInvocation({
        adapterId: instruction.adapter,
        chainKey: sendStep.destination,
        targetAddress: instruction.targetAddress,
        contractCall: instruction.contractCall,
      });
      return Enum("Transact", {
        origin_kind: Enum("SovereignAccount", undefined),
        fallback_max_weight: buildWeight(instruction.fallbackWeight),
        call: Binary.fromBytes(
          encodeDispatchEvmCall({
            targetAddress: instruction.targetAddress,
            contractCall: instruction.contractCall,
          }),
        ),
      });
    case "deposit-asset":
      return Enum("DepositAsset", {
        assets: Enum("Wild", Enum("AllCounted", 1)),
        beneficiary: buildBeneficiaryLocation(instruction.recipient),
      });
    default:
      throw new Error(`unsupported remote XCM instruction: ${instruction.type}`);
  }
}

function buildAsset({ chainKey, assetKey, amount }) {
  const location = getAssetLocation(assetKey, chainKey);

  return {
    id: {
      parents: location.parents,
      interior: buildInterior(location.interior),
    },
    fun: Enum("Fungible", amount),
  };
}

function buildParachainLocation(chainKey) {
  return {
    parents: 1,
    interior: Enum("X1", Enum("Parachain", getParachainId(chainKey))),
  };
}

function buildBeneficiaryLocation(address) {
  return {
    parents: 0,
    interior: Enum(
      "X1",
      Enum("AccountId32", {
        network: undefined,
        id: Binary.fromBytes(AccountId().enc(address)),
      }),
    ),
  };
}

function buildWeight(weight) {
  return {
    ref_time: toBigInt(weight.refTime, "transact.fallbackWeight.refTime"),
    proof_size: toBigInt(weight.proofSize, "transact.fallbackWeight.proofSize"),
  };
}

function buildInterior(interior) {
  switch (interior.type) {
    case "here":
      return Enum("Here", undefined);
    case "x1":
      return Enum("X1", buildJunction(interior.value));
    case "x2":
      return Enum("X2", interior.value.map(buildJunction));
    case "x3":
      return Enum("X3", interior.value.map(buildJunction));
    case "x4":
      return Enum("X4", interior.value.map(buildJunction));
    default:
      throw new Error(`unsupported XCM interior type: ${interior.type}`);
  }
}

function buildJunction(junction) {
  switch (junction.type) {
    case "parachain":
      return Enum("Parachain", junction.value);
    case "pallet-instance":
      return Enum("PalletInstance", junction.value);
    case "general-index":
      return Enum("GeneralIndex", toBigInt(junction.value, "junction.value"));
    default:
      throw new Error(`unsupported XCM junction type: ${junction.type}`);
  }
}

function hexToBytes(value) {
  return Uint8Array.from(Buffer.from(assertHexString("hex", value).slice(2), "hex"));
}

function assertPublishedAdapterInvocation({
  adapterId,
  chainKey,
  targetAddress,
  contractCall,
}) {
  const spec = getDestinationAdapterSpec(adapterId);
  const deployment = getDestinationAdapterDeployment(adapterId, chainKey);
  const normalizedAddress = assertAddress("targetAddress", targetAddress);
  const normalizedCall = assertHexString("contractCall", contractCall);

  if (!normalizedCall.startsWith(spec.selector)) {
    throw new Error(
      `contractCall for ${adapterId} must start with published selector ${spec.selector}`,
    );
  }

  if (normalizedAddress !== deployment.address) {
    throw new Error(
      `targetAddress for ${adapterId} on ${chainKey} must match published deployment ${deployment.address}`,
    );
  }

  return Object.freeze({
    targetAddress: normalizedAddress,
    contractCall: normalizedCall,
  });
}

function encodeDispatchEvmCall({ targetAddress, contractCall }) {
  const normalizedAddress = assertAddress("targetAddress", targetAddress);
  const normalizedCall = assertHexString("contractCall", contractCall);
  const selector = hexToBytes(DESTINATION_TRANSACT_DISPATCH.selector);
  const callBytes = hexToBytes(normalizedCall);
  const encoded = new Uint8Array(4 + 32 + 32 + 32 + paddedLength(callBytes.length));

  encoded.set(selector, 0);
  encoded.set(encodeAddressWord(normalizedAddress), 4);
  encoded.set(encodeUintWord(64n), 36);
  encoded.set(encodeUintWord(BigInt(callBytes.length)), 68);
  encoded.set(callBytes, 100);

  return encoded;
}

function encodeUintWord(value) {
  const normalized = toBigInt(value, "uintWord");
  const word = new Uint8Array(32);
  let remainder = normalized;

  for (let index = 31; index >= 0 && remainder > 0n; index -= 1) {
    word[index] = Number(remainder & 0xffn);
    remainder >>= 8n;
  }

  return word;
}

function encodeAddressWord(address) {
  const addressBytes = hexToBytes(assertAddress("address", address));
  const word = new Uint8Array(32);
  word.set(addressBytes, 12);
  return word;
}

function paddedLength(length) {
  const remainder = length % 32;
  return remainder === 0 ? length : length + (32 - remainder);
}
