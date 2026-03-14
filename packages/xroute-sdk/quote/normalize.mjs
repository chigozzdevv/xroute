import {
  ACTION_TYPES,
  assertIncluded,
  toBigInt,
} from "../../xroute-types/index.mjs";
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  normalizeDeploymentProfile,
} from "../../xroute-precompile-interfaces/index.mjs";

export function normalizeQuote(quote) {
  const action = assertIncluded(
    "quote.submission.action",
    quote?.submission?.action,
    Object.values(ACTION_TYPES),
  );

  return Object.freeze({
    quoteId: quote.quoteId,
    deploymentProfile: normalizeDeploymentProfile(
      quote?.deploymentProfile ?? DEFAULT_DEPLOYMENT_PROFILE,
    ),
    route: Object.freeze([...(quote?.route ?? [])]),
    segments: normalizeRouteSegments(quote?.segments ?? []),
    fees: normalizeFeeBreakdown(quote?.fees),
    estimatedSettlementFee: quote?.estimatedSettlementFee
      ? normalizeAssetAmount(quote.estimatedSettlementFee)
      : null,
    expectedOutput: normalizeAssetAmount(quote?.expectedOutput),
    minOutput: quote?.minOutput ? normalizeAssetAmount(quote.minOutput) : null,
    submission: Object.freeze({
      action,
      asset: quote.submission.asset,
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
    }),
    executionPlan: quote.executionPlan,
  });
}

function normalizeFeeBreakdown(fees) {
  return Object.freeze({
    xcmFee: normalizeAssetAmount(fees.xcmFee),
    destinationFee: normalizeAssetAmount(fees.destinationFee),
    platformFee: normalizeAssetAmount(fees.platformFee),
    totalFee: normalizeAssetAmount(fees.totalFee),
  });
}

function normalizeAssetAmount(assetAmount) {
  return Object.freeze({
    asset: assetAmount.asset,
    amount: toBigInt(assetAmount.amount, `${assetAmount.asset} amount`),
  });
}

function normalizeRouteSegments(segments) {
  return Object.freeze(
    segments.map((segment, index) =>
      Object.freeze({
        kind: assertIncluded(
          `segments[${index}].kind`,
          segment.kind,
          ["execution", "settlement"],
        ),
        route: Object.freeze([...(segment.route ?? [])]),
        hops: Object.freeze(
          (segment.hops ?? []).map((hop) =>
            Object.freeze({
              source: hop.source,
              destination: hop.destination,
              asset: hop.asset,
              transportFee: normalizeAssetAmount(hop.transportFee),
              buyExecutionFee: normalizeAssetAmount(hop.buyExecutionFee),
            }),
          ),
        ),
        xcmFee: normalizeAssetAmount(segment.xcmFee),
        destinationFee: normalizeAssetAmount(segment.destinationFee),
      }),
    ),
  );
}
