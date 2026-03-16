import {
  AccountId,
  Binary,
  Enum,
  metadata,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes as hexToBytesRaw } from "@noble/hashes/utils.js";

import { DEFAULT_METADATA_HEX } from "./metadata/polkadot-asset-hub.hex.mjs";
import { getAssetLocation, getParachainId } from "../xroute-chain-registry/index.mjs";
import {
  DISPATCH_MODES,
  assertAddress,
  assertBytes32Hex,
  assertHexString,
  assertIncluded,
  assertInteger,
  assertNonEmptyString,
  toBigInt,
} from "../xroute-types/index.mjs";
import {
  ACTION_TO_CONTRACT_ENUM,
  DEFAULT_DEPLOYMENT_PROFILE,
  DISPATCH_MODE_TO_CONTRACT_ENUM,
  normalizeDeploymentProfile,
} from "../xroute-precompile-interfaces/index.mjs";

const VERSIONED_LOCATION_TYPE_ID = 164;
const VERSIONED_XCM_TYPE_ID = 270;

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
  void castBin;
  const normalized = createDispatchEnvelope(envelope);
  const modeValue = DISPATCH_MODE_TO_CONTRACT_ENUM[normalized.mode];
  const encoded = encodeDispatchExecutionHashTuple({
    mode: modeValue,
    destinationHex: normalized.destinationHex,
    messageHex: normalized.messageHex,
  });

  return `0x${bytesToHex(keccak_256(hexToBytesRaw(encoded)))}`;
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
    refundAddress: assertAddress("intent.refundAddress", intent.refundAddress),
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

function encodeDispatchExecutionHashTuple({
  mode,
  destinationHex,
  messageHex,
}) {
  const encodedDestination = encodeAbiBytes(destinationHex);
  const encodedMessage = encodeAbiBytes(messageHex);
  const destinationOffset = 96n;
  const messageOffset = destinationOffset + encodedDestination.byteLength;

  return (
    `${encodeUint256Word(BigInt(mode))}`
    + `${encodeUint256Word(destinationOffset)}`
    + `${encodeUint256Word(messageOffset)}`
    + `${encodedDestination.encoded}`
    + `${encodedMessage.encoded}`
  );
}

function encodeAbiBytes(value) {
  const normalized = stripHexPrefix(assertHexString("bytes", value));
  const paddedLength = Math.ceil(normalized.length / 64) * 64;
  const padded = normalized.padEnd(paddedLength, "0");

  return {
    encoded: `${encodeUint256Word(BigInt(normalized.length / 2))}${padded}`,
    byteLength: 32n + BigInt(padded.length / 2),
  };
}

function encodeUint256Word(value) {
  const normalized = toBigInt(value, "uint256");
  if (normalized < 0n) {
    throw new Error("uint256 cannot be negative");
  }

  return normalized.toString(16).padStart(64, "0");
}

function stripHexPrefix(value) {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function buildExplorerLabel({ sourceChain, destinationChain, mode }) {
  assertNonEmptyString("sourceChain", sourceChain);
  assertNonEmptyString("destinationChain", destinationChain);
  assertIncluded("mode", mode, Object.values(DISPATCH_MODES));

  return `${sourceChain} -> ${destinationChain} (${mode})`;
}

export function buildVersionedXcmMessage({ quote }) {
  const deploymentProfile = normalizeDeploymentProfile(
    quote?.deploymentProfile ?? DEFAULT_DEPLOYMENT_PROFILE,
  );
  assertQuoteSegmentsMatchExecutionPlan(quote);
  const sendStep = getExecutionStep(quote, "send-xcm");

  return Enum("V5", [
    Enum("SetFeesMode", { jit_withdraw: true }),
    ...sendStep.instructions.map((instruction) =>
      buildInstruction({
        instruction,
        currentChain: sendStep.origin,
        deploymentProfile,
      }),
    ),
  ]);
}

function getExecutionStep(quote, stepType) {
  const step = quote?.executionPlan?.steps?.find((candidate) => candidate.type === stepType);

  if (!step) {
    throw new Error(`missing execution plan step: ${stepType}`);
  }

  return step;
}

function assertQuoteSegmentsMatchExecutionPlan(quote) {
  const segments = quote?.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("quote.segments must describe the multihop execution path");
  }

  const executionSegment = segments.find((segment) => segment.kind === "execution");
  if (!executionSegment) {
    throw new Error("quote.segments must include an execution segment");
  }

  const composedRoute = composeSegmentRoute(segments);
  if (JSON.stringify(composedRoute) !== JSON.stringify(quote.route)) {
    throw new Error("quote.route must match the composed route segments");
  }

  if (executionSegment.hops.length + 1 !== executionSegment.route.length) {
    throw new Error("execution segment route must contain exactly one more chain than its hops");
  }

  const sendStep = getExecutionStep(quote, "send-xcm");
  if (sendStep.origin !== executionSegment.route[0]) {
    throw new Error("send-xcm origin must match the execution segment origin");
  }
  if (sendStep.destination !== executionSegment.route[1]) {
    throw new Error("send-xcm destination must match the first execution hop");
  }

  const topInstruction = sendStep.instructions?.[0];
  if (!topInstruction) {
    throw new Error("send-xcm must begin with an XCM transfer instruction");
  }

  if (topInstruction.type === "transfer-reserve-asset") {
    const transferChain = collectTransferChain(topInstruction);
    if (transferChain.length !== executionSegment.hops.length) {
      throw new Error("execution segment hop count must match the nested transfer instruction chain");
    }

    executionSegment.hops.forEach((hop, index) => {
      const instruction = transferChain[index];
      if (instruction.asset !== hop.asset) {
        throw new Error(`execution hop ${index} asset does not match the XCM instruction chain`);
      }
      if (instruction.destination !== hop.destination) {
        throw new Error(
          `execution hop ${index} destination does not match the XCM instruction chain`,
        );
      }

      const buyExecution = instruction.remoteInstructions?.[0];
      if (!buyExecution || buyExecution.type !== "buy-execution") {
        throw new Error(`execution hop ${index} must start with a buy-execution instruction`);
      }
      if (buyExecution.asset !== hop.buyExecutionFee.asset) {
        throw new Error(`execution hop ${index} buy-execution asset must match the segment fee`);
      }
      if (
        toBigInt(buyExecution.amount, "buy-execution.amount") !==
        toBigInt(
          hop.buyExecutionFee.amount,
          `segments[${index}].hops[${index}].buyExecutionFee.amount`,
        )
      ) {
        throw new Error(`execution hop ${index} buy-execution amount must match the segment fee`);
      }
    });
    return;
  }

  if (topInstruction.type === "withdraw-asset") {
    const nextInstruction = sendStep.instructions?.[1];
    if (!nextInstruction) {
      throw new Error("withdraw-asset must be followed by a routing instruction");
    }

    if (nextInstruction.type === "pay-fees") {
      if (executionSegment.hops.length !== 1) {
        throw new Error("withdraw-asset plus pay-fees supports exactly one execution hop");
      }

      const [hop] = executionSegment.hops;
      const payFees = nextInstruction;
      const initiateTransfer = sendStep.instructions?.[2];

      if (!initiateTransfer || initiateTransfer.type !== "initiate-transfer") {
        throw new Error(
          "withdraw-asset must be followed by an initiate-transfer instruction",
        );
      }
      if (initiateTransfer.destination !== hop.destination) {
        throw new Error(
          "initiate-transfer destination must match the execution segment destination",
        );
      }
      if (payFees.asset !== hop.transportFee.asset) {
        throw new Error("pay-fees asset must match the execution segment transport fee asset");
      }
      if (
        toBigInt(payFees.amount, "pay-fees.amount") !==
        toBigInt(hop.transportFee.amount, "segments[0].hops[0].transportFee.amount")
      ) {
        throw new Error("pay-fees amount must match the execution segment transport fee");
      }
      if (initiateTransfer.remoteFeeAsset !== hop.buyExecutionFee.asset) {
        throw new Error(
          "initiate-transfer remote fee asset must match the execution segment fee asset",
        );
      }
      if (
        toBigInt(initiateTransfer.remoteFeeAmount, "initiate-transfer.remoteFeeAmount") !==
        toBigInt(
          hop.buyExecutionFee.amount,
          "segments[0].hops[0].buyExecutionFee.amount",
        )
      ) {
        throw new Error(
          "initiate-transfer remote fee amount must match the execution segment fee",
        );
      }
      return;
    }

    if (nextInstruction.type === "initiate-reserve-withdraw") {
      assertReserveWithdrawExecutionChain(executionSegment.hops, topInstruction, nextInstruction);
      return;
    }

    throw new Error(
      `withdraw-asset must be followed by pay-fees or initiate-reserve-withdraw, got ${nextInstruction.type}`,
    );
  }

  if (topInstruction.type === "initiate-teleport") {
    if (executionSegment.hops.length !== 1) {
      throw new Error("initiate-teleport currently supports exactly one execution hop");
    }
    const [hop] = executionSegment.hops;
    if (topInstruction.destination !== hop.destination) {
      throw new Error(
        "initiate-teleport destination must match the execution segment destination",
      );
    }
    const buyExecution = topInstruction.remoteInstructions?.[0];
    if (!buyExecution || buyExecution.type !== "buy-execution") {
      throw new Error("initiate-teleport must start with a buy-execution instruction");
    }
    if (buyExecution.asset !== hop.buyExecutionFee.asset) {
      throw new Error("initiate-teleport buy-execution asset must match the segment fee");
    }
    if (
      toBigInt(buyExecution.amount, "buy-execution.amount") !==
      toBigInt(
        hop.buyExecutionFee.amount,
        "segments[0].hops[0].buyExecutionFee.amount",
      )
    ) {
      throw new Error("initiate-teleport buy-execution amount must match the segment fee");
    }
    return;
  }

  throw new Error(`unsupported send-xcm instruction chain: ${topInstruction.type}`);
}

function composeSegmentRoute(segments) {
  const [first, ...rest] = segments;
  const route = first.route.slice();
  for (const segment of rest) {
    route.push(...segment.route.slice(1));
  }

  return route;
}

function collectTransferChain(instruction) {
  const chain = [instruction];
  let current = instruction;

  while (true) {
    const nestedTransfer = current.remoteInstructions?.find(
      (candidate) => candidate.type === "transfer-reserve-asset",
    );
    if (!nestedTransfer) {
      return chain;
    }

    chain.push(nestedTransfer);
    current = nestedTransfer;
  }
}

function assertReserveWithdrawExecutionChain(hops, withdrawInstruction, reserveWithdrawInstruction) {
  if (hops.length === 0 || hops.length > 2) {
    throw new Error(
      "withdraw-asset plus initiate-reserve-withdraw supports one or two execution hops",
    );
  }

  const [firstHop, secondHop] = hops;
  if (withdrawInstruction.asset !== firstHop.asset) {
    throw new Error("withdraw-asset asset must match the first execution hop asset");
  }
  if (reserveWithdrawInstruction.reserve !== firstHop.destination) {
    throw new Error(
      "initiate-reserve-withdraw reserve must match the first execution hop destination",
    );
  }

  const reserveBuyExecution = reserveWithdrawInstruction.remoteInstructions?.[0];
  if (!reserveBuyExecution || reserveBuyExecution.type !== "buy-execution") {
    throw new Error(
      "initiate-reserve-withdraw must start with a reserve-side buy-execution instruction",
    );
  }
  assertBuyExecutionMatchesHop(reserveBuyExecution, firstHop, 0);

  if (!secondHop) {
    return;
  }

  const depositReserve = reserveWithdrawInstruction.remoteInstructions?.[1];
  if (!depositReserve || depositReserve.type !== "deposit-reserve-asset") {
    throw new Error(
      "reserve-withdraw multihop routes must forward with a deposit-reserve-asset instruction",
    );
  }
  if (depositReserve.destination !== secondHop.destination) {
    throw new Error(
      "deposit-reserve-asset destination must match the second execution hop destination",
    );
  }

  const destinationBuyExecution = depositReserve.remoteInstructions?.[0];
  if (!destinationBuyExecution || destinationBuyExecution.type !== "buy-execution") {
    throw new Error("deposit-reserve-asset must start with a buy-execution instruction");
  }
  assertBuyExecutionMatchesHop(destinationBuyExecution, secondHop, 1);
}

function assertBuyExecutionMatchesHop(buyExecution, hop, index) {
  if (buyExecution.asset !== hop.buyExecutionFee.asset) {
    throw new Error(`execution hop ${index} buy-execution asset must match the segment fee`);
  }
  if (
    toBigInt(buyExecution.amount, "buy-execution.amount") !==
    toBigInt(
      hop.buyExecutionFee.amount,
      `segments[0].hops[${index}].buyExecutionFee.amount`,
    )
  ) {
    throw new Error(`execution hop ${index} buy-execution amount must match the segment fee`);
  }
}

function buildInstruction({
  instruction,
  currentChain,
  deploymentProfile,
}) {
  switch (instruction.type) {
    case "withdraw-asset":
      return Enum("WithdrawAsset", [
        buildAsset({
          chainKey: currentChain,
          assetKey: instruction.asset,
          deploymentProfile,
          amount: toBigInt(
            instruction.amount,
            "executionPlan.instructions.withdraw-asset.amount",
          ),
        }),
      ]);
    case "pay-fees":
      return Enum("PayFees", {
        asset: buildAsset({
          chainKey: currentChain,
          assetKey: instruction.asset,
          deploymentProfile,
          amount: toBigInt(instruction.amount, "pay-fees.amount"),
        }),
      });
    case "transfer-reserve-asset":
      return Enum("TransferReserveAsset", {
        assets: [
          buildAsset({
            chainKey: currentChain,
            assetKey: instruction.asset,
            deploymentProfile,
            amount: toBigInt(
              instruction.amount,
              "executionPlan.instructions.transfer-reserve-asset.amount",
            ),
          }),
        ],
        dest: buildParachainLocation(instruction.destination, deploymentProfile),
        xcm: instruction.remoteInstructions.map((nestedInstruction) =>
          buildInstruction({
            instruction: nestedInstruction,
            currentChain: instruction.destination,
            deploymentProfile,
          }),
        ),
      });
    case "buy-execution":
      return Enum("BuyExecution", {
        fees: buildAsset({
          chainKey: currentChain,
          assetKey: instruction.asset,
          deploymentProfile,
          amount: toBigInt(instruction.amount, "buy-execution.amount"),
        }),
        weight_limit: Enum("Unlimited", undefined),
      });
    case "exchange-asset":
      return Enum("ExchangeAsset", {
        give: Enum("Definite", [
          buildAsset({
            chainKey: currentChain,
            assetKey: instruction.assetIn,
            deploymentProfile,
            amount: toBigInt(
              instruction.amountIn,
              "executionPlan.instructions.exchange-asset.amountIn",
            ),
          }),
        ]),
        want: [
          buildAsset({
            chainKey: currentChain,
            assetKey: instruction.assetOut,
            deploymentProfile,
            amount: toBigInt(
              instruction.minAmountOut,
              "executionPlan.instructions.exchange-asset.minAmountOut",
            ),
          }),
        ],
        maximal: Boolean(instruction.maximal),
      });
    case "deposit-reserve-asset":
      return Enum("DepositReserveAsset", {
        assets: buildCountedAssetFilter(instruction.assetCount),
        dest: buildParachainLocation(instruction.destination, deploymentProfile),
        xcm: instruction.remoteInstructions.map((nestedInstruction) =>
          buildInstruction({
            instruction: nestedInstruction,
            currentChain: instruction.destination,
            deploymentProfile,
          }),
        ),
      });
    case "initiate-teleport":
      return Enum("InitiateTeleport", {
        assets: buildCountedAssetFilter(instruction.assetCount),
        dest: buildParachainLocation(instruction.destination, deploymentProfile),
        xcm: instruction.remoteInstructions.map((nestedInstruction) =>
          buildInstruction({
            instruction: nestedInstruction,
            currentChain: instruction.destination,
            deploymentProfile,
          }),
        ),
      });
    case "initiate-transfer":
      return Enum("InitiateTransfer", {
        destination: buildParachainLocation(instruction.destination, deploymentProfile),
        remote_fees: Enum(
          "Teleport",
          Enum("Definite", [
            buildAsset({
              chainKey: currentChain,
              assetKey: instruction.remoteFeeAsset,
              deploymentProfile,
              amount: toBigInt(
                instruction.remoteFeeAmount,
                "initiate-transfer.remoteFeeAmount",
              ),
            }),
          ]),
        ),
        preserve_origin: Boolean(instruction.preserveOrigin),
        assets: [
          Enum("Teleport", buildCountedAssetFilter(1)),
        ],
        remote_xcm: instruction.remoteInstructions.map((nestedInstruction) =>
          buildInstruction({
            instruction: nestedInstruction,
            currentChain: instruction.destination,
            deploymentProfile,
          }),
        ),
      });
    case "initiate-reserve-withdraw":
      return Enum("InitiateReserveWithdraw", {
        assets: buildCountedAssetFilter(instruction.assetCount),
        reserve: buildParachainLocation(instruction.reserve, deploymentProfile),
        xcm: instruction.remoteInstructions.map((nestedInstruction) =>
          buildInstruction({
            instruction: nestedInstruction,
            currentChain: instruction.reserve,
            deploymentProfile,
          }),
        ),
      });
    case "transact":
      return Enum("Transact", {
        origin_kind: buildRuntimeCallOriginKind(instruction.originKind),
        fallback_max_weight: buildWeight(instruction.fallbackWeight),
        call: Binary.fromBytes(
          hexToBytes(assertHexString("executionPlan.instructions.transact.callData", instruction.callData)),
        ),
      });
    case "deposit-asset":
      return Enum("DepositAsset", {
        assets: buildCountedAssetFilter(instruction.assetCount ?? 1),
        beneficiary: buildBeneficiaryLocation(currentChain, instruction.recipient),
      });
    default:
      throw new Error(`unsupported remote XCM instruction: ${instruction.type}`);
  }
}

function buildAsset({ chainKey, assetKey, amount, deploymentProfile }) {
  const location = getAssetLocation(assetKey, chainKey, deploymentProfile);

  return {
    id: {
      parents: location.parents,
      interior: buildInterior(location.interior),
    },
    fun: Enum("Fungible", amount),
  };
}

function buildCountedAssetFilter(assetCount) {
  return Enum(
    "Wild",
    Enum("AllCounted", assertInteger("assetCount", assetCount)),
  );
}

function buildParachainLocation(chainKey, deploymentProfile) {
  return {
    parents: 1,
    interior: Enum("X1", Enum("Parachain", getParachainId(chainKey, deploymentProfile))),
  };
}

function buildBeneficiaryLocation(chainKey, recipient) {
  const normalizedRecipient = assertNonEmptyString("recipient", recipient);

  return {
    parents: 0,
    interior: Enum(
      "X1",
      buildBeneficiaryJunction(chainKey, normalizedRecipient),
    ),
  };
}

function buildBeneficiaryJunction(chainKey, recipient) {
  if (supportsAccountKey20(chainKey) && looksLikeAccountKey20(recipient)) {
    return {
      type: "AccountKey20",
      value: {
        network: undefined,
        key: Binary.fromBytes(hexToBytes(assertAddress("recipient", recipient))),
      },
    };
  }

  if (looksLikeAccountKey20(recipient)) {
    throw new Error(
      `20-byte recipients are not supported on destination chain ${chainKey}`,
    );
  }

  return {
    type: "AccountId32",
    value: {
      network: undefined,
      id: Binary.fromBytes(encodeAccountId32(recipient)),
    },
  };
}

function supportsAccountKey20(chainKey) {
  return chainKey === "moonbeam" || chainKey === "polkadot-hub";
}

function looksLikeAccountKey20(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value).trim());
}

function encodeAccountId32(value) {
  const normalized = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    return hexToBytes(assertBytes32Hex("recipient", normalized));
  }

  try {
    return AccountId().enc(normalized);
  } catch (error) {
    throw new Error(`recipient must be a valid SS58 or 32-byte hex account id`);
  }
}

function buildRuntimeCallOriginKind(originKind) {
  switch (originKind) {
    case "sovereign-account":
      return Enum("SovereignAccount", undefined);
    case "xcm":
      return Enum("Xcm", undefined);
    case "native":
      return Enum("Native", undefined);
    case "superuser":
      return Enum("Superuser", undefined);
    default:
      throw new Error(`unsupported runtime call origin kind: ${originKind}`);
  }
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
    case "general-key":
      {
        const raw = hexToBytes(junction.value);
        const data = new Uint8Array(32);
        data.set(raw.slice(0, 32));
        return Enum("GeneralKey", {
          length: raw.length,
          data: Binary.fromBytes(data),
        });
      }
    default:
      throw new Error(`unsupported XCM junction type: ${junction.type}`);
  }
}

function hexToBytes(value) {
  const normalized = assertHexString("hex", value);
  return hexToBytesRaw(normalized.startsWith("0x") ? normalized.slice(2) : normalized);
}
