use crate::http::HttpError;
use route_engine::{
    AssetAmount, AssetKey, CallExecuteIntent, ChainKey, DeploymentProfile,
    ExecuteIntent, ExecutionPlan, ExecutionType, FeeBreakdown, FeeType, Intent, IntentAction,
    PlanStep, Quote, RouteHop, RouteSegment, RouteSegmentKind, SubmissionAction, SwapIntent,
    TransferIntent, VdotOrderExecuteIntent, XcmInstruction, XcmWeight,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WireIntent {
    #[serde(default)]
    pub quote_id: Option<String>,
    pub source_chain: String,
    pub destination_chain: String,
    pub refund_address: String,
    pub deadline: u64,
    pub action: WireAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WireAction {
    #[serde(rename = "type")]
    pub action_type: String,
    pub params: Value,
}

#[derive(Debug, Clone)]
pub struct QuoteRequest {
    pub quote_id: String,
    pub wire_intent: WireIntent,
    pub intent: Intent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    pub mode: u8,
    pub destination: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceIntentMetadata {
    pub kind: String,
    pub refund_asset: String,
    pub refundable_amount: String,
    pub min_output_amount: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceDispatchMetadata {
    pub tx_hash: String,
    pub strategy: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DispatchJobRequest {
    pub intent_id: String,
    pub wire_intent: WireIntent,
    pub intent: Intent,
    pub request: DispatchRequest,
    pub source_intent: Option<SourceIntentMetadata>,
    pub source_dispatch: Option<SourceDispatchMetadata>,
}

#[derive(Debug, Clone)]
pub struct SettleJobRequest {
    pub intent_id: String,
    pub outcome_reference: String,
    pub result_asset_id: String,
    pub result_amount: String,
}

#[derive(Debug, Clone)]
pub struct FailJobRequest {
    pub intent_id: String,
    pub outcome_reference: String,
    pub failure_reason_hash: String,
}

#[derive(Debug, Clone)]
pub struct RefundJobRequest {
    pub intent_id: String,
    pub refund_amount: String,
    pub refund_asset: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QuoteBody {
    intent: WireIntent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchJobBody {
    intent_id: String,
    intent: WireIntent,
    request: DispatchRequest,
    source_intent: Option<SourceIntentMetadata>,
    source_dispatch: Option<SourceDispatchMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettleJobBody {
    intent_id: String,
    outcome_reference: String,
    result_asset_id: String,
    result_amount: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FailJobBody {
    intent_id: String,
    outcome_reference: String,
    failure_reason_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefundJobBody {
    intent_id: String,
    refund_amount: String,
    refund_asset: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferParams {
    asset: String,
    amount: String,
    recipient: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwapParams {
    asset_in: String,
    asset_out: String,
    amount_in: String,
    min_amount_out: String,
    settlement_chain: String,
    recipient: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FallbackWeight {
    ref_time: u64,
    proof_size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallParams {
    #[serde(rename = "executionType")]
    _execution_type: String,
    asset: String,
    max_payment_amount: String,
    contract_address: String,
    calldata: String,
    value: String,
    gas_limit: String,
    fallback_weight: FallbackWeight,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdotOrderParams {
    #[serde(rename = "executionType")]
    _execution_type: String,
    amount: String,
    max_payment_amount: String,
    recipient: String,
    adapter_address: String,
    gas_limit: String,
    fallback_weight: FallbackWeight,
    remark: String,
    channel_id: u32,
}

pub fn quote_request_from_slice(body: &[u8]) -> Result<QuoteRequest, HttpError> {
    let payload: QuoteBody = serde_json::from_slice(body)
        .map_err(|error| HttpError::bad_request(format!("invalid quote request: {error}")))?;
    let quote_id = payload
        .intent
        .quote_id
        .clone()
        .unwrap_or_else(|| payload.intent.clone().into_internal_id());
    let intent = wire_intent_to_internal(&payload.intent).map_err(HttpError::bad_request)?;

    Ok(QuoteRequest {
        quote_id,
        wire_intent: payload.intent,
        intent,
    })
}

pub fn dispatch_job_request_from_slice(body: &[u8]) -> Result<DispatchJobRequest, HttpError> {
    let payload: DispatchJobBody = serde_json::from_slice(body).map_err(|error| {
        HttpError::bad_request(format!("invalid dispatch job request: {error}"))
    })?;
    let intent = wire_intent_to_internal(&payload.intent).map_err(HttpError::bad_request)?;

    Ok(DispatchJobRequest {
        intent_id: normalize_bytes32(&payload.intent_id, "intentId")
            .map_err(HttpError::bad_request)?,
        wire_intent: payload.intent,
        intent,
        request: DispatchRequest {
            mode: normalize_dispatch_mode(payload.request.mode).map_err(HttpError::bad_request)?,
            destination: normalize_hex(&payload.request.destination, "request.destination")
                .map_err(HttpError::bad_request)?,
            message: normalize_hex(&payload.request.message, "request.message")
                .map_err(HttpError::bad_request)?,
        },
        source_intent: payload
            .source_intent
            .map(normalize_source_intent_metadata)
            .transpose()
            .map_err(HttpError::bad_request)?,
        source_dispatch: payload
            .source_dispatch
            .map(normalize_source_dispatch_metadata)
            .transpose()
            .map_err(HttpError::bad_request)?,
    })
}

pub fn settle_job_request_from_slice(body: &[u8]) -> Result<SettleJobRequest, HttpError> {
    let payload: SettleJobBody = serde_json::from_slice(body)
        .map_err(|error| HttpError::bad_request(format!("invalid settle job request: {error}")))?;
    parse_u128(&payload.result_amount, "resultAmount").map_err(HttpError::bad_request)?;

    Ok(SettleJobRequest {
        intent_id: normalize_bytes32(&payload.intent_id, "intentId")
            .map_err(HttpError::bad_request)?,
        outcome_reference: normalize_bytes32(&payload.outcome_reference, "outcomeReference")
            .map_err(HttpError::bad_request)?,
        result_asset_id: normalize_bytes32(&payload.result_asset_id, "resultAssetId")
            .map_err(HttpError::bad_request)?,
        result_amount: payload.result_amount,
    })
}

pub fn fail_job_request_from_slice(body: &[u8]) -> Result<FailJobRequest, HttpError> {
    let payload: FailJobBody = serde_json::from_slice(body)
        .map_err(|error| HttpError::bad_request(format!("invalid fail job request: {error}")))?;

    Ok(FailJobRequest {
        intent_id: normalize_bytes32(&payload.intent_id, "intentId")
            .map_err(HttpError::bad_request)?,
        outcome_reference: normalize_bytes32(&payload.outcome_reference, "outcomeReference")
            .map_err(HttpError::bad_request)?,
        failure_reason_hash: normalize_bytes32(&payload.failure_reason_hash, "failureReasonHash")
            .map_err(HttpError::bad_request)?,
    })
}

pub fn refund_job_request_from_slice(body: &[u8]) -> Result<RefundJobRequest, HttpError> {
    let payload: RefundJobBody = serde_json::from_slice(body)
        .map_err(|error| HttpError::bad_request(format!("invalid refund job request: {error}")))?;
    parse_u128(&payload.refund_amount, "refundAmount").map_err(HttpError::bad_request)?;

    Ok(RefundJobRequest {
        intent_id: normalize_bytes32(&payload.intent_id, "intentId")
            .map_err(HttpError::bad_request)?,
        refund_amount: payload.refund_amount,
        refund_asset: payload.refund_asset,
    })
}

pub fn intent_to_json_value(intent: &Intent, quote_id: &str) -> Value {
    json!({
        "quoteId": quote_id,
        "sourceChain": intent.source_chain.as_str(),
        "destinationChain": intent.destination_chain.as_str(),
        "refundAddress": intent.refund_address,
        "deadline": intent.deadline,
        "action": action_to_json_value(&intent.action),
    })
}

pub fn quote_to_json_value(quote: &Quote, quote_id: &str) -> Value {
    json!({
        "quoteId": quote_id,
        "deploymentProfile": quote.deployment_profile.as_str(),
        "route": quote.route.iter().map(|chain| chain.as_str()).collect::<Vec<_>>(),
        "segments": quote.segments.iter().map(route_segment_to_json_value).collect::<Vec<_>>(),
        "fees": fee_breakdown_to_json_value(&quote.fees),
        "estimatedSettlementFee": quote.estimated_settlement_fee.as_ref().map(asset_amount_to_json_value),
        "expectedOutput": asset_amount_to_json_value(&quote.expected_output),
        "minOutput": quote.min_output.as_ref().map(asset_amount_to_json_value),
        "submission": json!({
            "action": submission_action_label(quote.submission.action),
            "asset": quote.submission.asset.symbol(),
            "amount": quote.submission.amount.to_string(),
            "xcmFee": quote.submission.xcm_fee.to_string(),
            "destinationFee": quote.submission.destination_fee.to_string(),
            "minOutputAmount": quote.submission.min_output_amount.to_string(),
        }),
        "executionPlan": execution_plan_to_json_value(&quote.execution_plan),
    })
}

pub fn health_json(
    deployment_profile: DeploymentProfile,
    router_address: Option<&str>,
    extra: Value,
) -> Value {
    let mut value = json!({
        "ok": true,
        "deploymentProfile": deployment_profile.as_str(),
        "routerAddress": router_address,
    });
    if let Value::Object(object) = &mut value {
        if let Value::Object(extra_object) = extra {
            object.extend(extra_object);
        }
    }

    value
}

pub fn summary_json(queued: usize, running: usize, completed: usize, failed: usize) -> Value {
    json!({
        "queued": queued,
        "running": running,
        "completed": completed,
        "failed": failed,
    })
}

impl WireIntent {
    fn into_internal_id(self) -> String {
        wire_intent_to_internal(&self)
            .map(|intent| intent.canonical_id())
            .unwrap_or_else(|_| "0x0000000000000000".to_owned())
    }
}

fn wire_intent_to_internal(wire: &WireIntent) -> Result<Intent, String> {
    let source_chain = parse_chain(&wire.source_chain)?;
    let destination_chain = parse_chain(&wire.destination_chain)?;
    let refund_address =
        normalize_refund_address(source_chain, &wire.refund_address, "refundAddress")?;
    let action = parse_action(&wire.action, source_chain, destination_chain)?;

    Ok(Intent {
        source_chain,
        destination_chain,
        action,
        refund_address,
        deadline: wire.deadline,
    })
}

fn parse_action(
    action: &WireAction,
    source_chain: ChainKey,
    destination_chain: ChainKey,
) -> Result<IntentAction, String> {
    match action.action_type.as_str() {
        "transfer" => {
            let params: TransferParams = serde_json::from_value(action.params.clone())
                .map_err(|error| format!("invalid transfer params: {error}"))?;
            Ok(IntentAction::Transfer(TransferIntent {
                asset: parse_asset(&params.asset)?,
                amount: parse_u128(&params.amount, "action.params.amount")?,
                recipient: require_non_empty(&params.recipient, "action.params.recipient")?,
            }))
        }
        "swap" => {
            let params: SwapParams = serde_json::from_value(action.params.clone())
                .map_err(|error| format!("invalid swap params: {error}"))?;
            Ok(IntentAction::Swap(SwapIntent {
                asset_in: parse_asset(&params.asset_in)?,
                asset_out: parse_asset(&params.asset_out)?,
                amount_in: parse_u128(&params.amount_in, "action.params.amountIn")?,
                min_amount_out: parse_u128(&params.min_amount_out, "action.params.minAmountOut")?,
                settlement_chain: parse_chain(&params.settlement_chain)?,
                recipient: require_non_empty(&params.recipient, "action.params.recipient")?,
            }))
        }
        "execute" => Ok(IntentAction::Execute(parse_execute_intent(
            &action.params,
            source_chain,
            destination_chain,
        )?)),
        other => Err(format!("unsupported action type: {other}")),
    }
}

fn parse_execute_intent(
    params: &Value,
    _source_chain: ChainKey,
    destination_chain: ChainKey,
) -> Result<ExecuteIntent, String> {
    let execution_type = require_field(params, "executionType")?;
    match execution_type.as_str() {
        "call" => {
            let params: CallParams = serde_json::from_value(params.clone())
                .map_err(|error| format!("invalid call params: {error}"))?;
            ensure_supported_execute_destination(
                destination_chain,
                ExecutionType::Call,
            )?;
            Ok(ExecuteIntent::Call(
                CallExecuteIntent {
                    asset: parse_asset(&params.asset)?,
                    max_payment_amount: parse_u128(
                        &params.max_payment_amount,
                        "action.params.maxPaymentAmount",
                    )?,
                    contract_address: normalize_address(
                        &params.contract_address,
                        "action.params.contractAddress",
                    )?,
                    calldata: normalize_hex(&params.calldata, "action.params.calldata")?,
                    value: parse_u128(&params.value, "action.params.value")?,
                    gas_limit: parse_u64(&params.gas_limit, "action.params.gasLimit")?,
                    fallback_weight: XcmWeight {
                        ref_time: params.fallback_weight.ref_time,
                        proof_size: params.fallback_weight.proof_size,
                    },
                },
            ))
        }
        "mint-vdot" => parse_vdot_order_intent(
            params,
            destination_chain,
            ExecutionType::MintVdot,
        ),
        "redeem-vdot" => parse_vdot_order_intent(
            params,
            destination_chain,
            ExecutionType::RedeemVdot,
        ),
        other => Err(format!("unsupported execution type: {other}")),
    }
}

fn parse_vdot_order_intent(
    params: &Value,
    destination_chain: ChainKey,
    execution_type: ExecutionType,
) -> Result<ExecuteIntent, String> {
    let params: VdotOrderParams = serde_json::from_value(params.clone())
        .map_err(|error| format!("invalid {} params: {error}", execution_type.as_str()))?;
    ensure_supported_execute_destination(destination_chain, execution_type)?;

    let intent = VdotOrderExecuteIntent {
        amount: parse_u128(&params.amount, "action.params.amount")?,
        max_payment_amount: parse_u128(
            &params.max_payment_amount,
            "action.params.maxPaymentAmount",
        )?,
        recipient: normalize_address(&params.recipient, "action.params.recipient")?,
        adapter_address: normalize_address(
            &params.adapter_address,
            "action.params.adapterAddress",
        )?,
        gas_limit: parse_u64(&params.gas_limit, "action.params.gasLimit")?,
        fallback_weight: XcmWeight {
            ref_time: params.fallback_weight.ref_time,
            proof_size: params.fallback_weight.proof_size,
        },
        remark: normalize_remark(&params.remark, "action.params.remark")?,
        channel_id: params.channel_id,
    };

    Ok(match execution_type {
        ExecutionType::MintVdot => ExecuteIntent::MintVdot(intent),
        ExecutionType::RedeemVdot => ExecuteIntent::RedeemVdot(intent),
        ExecutionType::Call => unreachable!(),
    })
}

fn ensure_supported_execute_destination(
    destination: ChainKey,
    execution_type: ExecutionType,
) -> Result<(), String> {
    match (destination, execution_type) {
        (ChainKey::Moonbeam, ExecutionType::Call)
        | (ChainKey::Moonbeam, ExecutionType::MintVdot)
        | (ChainKey::Moonbeam, ExecutionType::RedeemVdot) => Ok(()),
        _ => Err(format!(
            "{} is not supported on {}",
            execution_type.as_str(),
            destination.as_str()
        )),
    }
}

fn action_to_json_value(action: &IntentAction) -> Value {
    match action {
        IntentAction::Transfer(transfer) => json!({
            "type": "transfer",
            "params": {
                "asset": transfer.asset.symbol(),
                "amount": transfer.amount.to_string(),
                "recipient": transfer.recipient,
            },
        }),
        IntentAction::Swap(swap) => json!({
            "type": "swap",
            "params": {
                "assetIn": swap.asset_in.symbol(),
                "assetOut": swap.asset_out.symbol(),
                "amountIn": swap.amount_in.to_string(),
                "minAmountOut": swap.min_amount_out.to_string(),
                "settlementChain": swap.settlement_chain.as_str(),
                "recipient": swap.recipient,
            },
        }),
        IntentAction::Execute(execute) => json!({
            "type": "execute",
            "params": execute_to_json_value(execute),
        }),
    }
}

fn execute_to_json_value(execute: &ExecuteIntent) -> Value {
    match execute {
        ExecuteIntent::Call(call) => json!({
            "executionType": "call",
            "asset": call.asset.symbol(),
            "maxPaymentAmount": call.max_payment_amount.to_string(),
            "contractAddress": call.contract_address,
            "calldata": call.calldata,
            "value": call.value.to_string(),
            "gasLimit": call.gas_limit.to_string(),
            "fallbackWeight": {
                "refTime": call.fallback_weight.ref_time,
                "proofSize": call.fallback_weight.proof_size,
            },
        }),
        ExecuteIntent::MintVdot(order) => vdot_order_to_json_value("mint-vdot", order),
        ExecuteIntent::RedeemVdot(order) => vdot_order_to_json_value("redeem-vdot", order),
    }
}

fn vdot_order_to_json_value(execution_type: &str, order: &VdotOrderExecuteIntent) -> Value {
    json!({
        "executionType": execution_type,
        "amount": order.amount.to_string(),
        "maxPaymentAmount": order.max_payment_amount.to_string(),
        "recipient": order.recipient,
        "adapterAddress": order.adapter_address,
        "gasLimit": order.gas_limit.to_string(),
        "fallbackWeight": {
            "refTime": order.fallback_weight.ref_time,
            "proofSize": order.fallback_weight.proof_size,
        },
        "remark": order.remark,
        "channelId": order.channel_id,
    })
}

fn route_segment_to_json_value(segment: &RouteSegment) -> Value {
    json!({
        "kind": route_segment_kind_label(segment.kind),
        "route": segment.route.iter().map(|chain| chain.as_str()).collect::<Vec<_>>(),
        "hops": segment.hops.iter().map(route_hop_to_json_value).collect::<Vec<_>>(),
        "xcmFee": asset_amount_to_json_value(&segment.xcm_fee),
        "destinationFee": asset_amount_to_json_value(&segment.destination_fee),
    })
}

fn route_hop_to_json_value(hop: &RouteHop) -> Value {
    json!({
        "source": hop.source.as_str(),
        "destination": hop.destination.as_str(),
        "asset": hop.asset.symbol(),
        "transportFee": asset_amount_to_json_value(&hop.transport_fee),
        "buyExecutionFee": asset_amount_to_json_value(&hop.buy_execution_fee),
    })
}

fn fee_breakdown_to_json_value(fees: &FeeBreakdown) -> Value {
    json!({
        "xcmFee": asset_amount_to_json_value(&fees.xcm_fee),
        "destinationFee": asset_amount_to_json_value(&fees.destination_fee),
        "platformFee": asset_amount_to_json_value(&fees.platform_fee),
        "totalFee": asset_amount_to_json_value(&fees.total_fee),
    })
}

fn execution_plan_to_json_value(plan: &ExecutionPlan) -> Value {
    json!({
        "route": plan.route.iter().map(|chain| chain.as_str()).collect::<Vec<_>>(),
        "steps": plan.steps.iter().map(plan_step_to_json_value).collect::<Vec<_>>(),
    })
}

fn plan_step_to_json_value(step: &PlanStep) -> Value {
    match step {
        PlanStep::LockAsset {
            chain,
            asset,
            amount,
        } => json!({
            "type": "lock-asset",
            "chain": chain.as_str(),
            "asset": asset.symbol(),
            "amount": amount.to_string(),
        }),
        PlanStep::ChargeFee {
            fee_type,
            asset,
            amount,
        } => json!({
            "type": "charge-fee",
            "feeType": fee_type_label(*fee_type),
            "asset": asset.symbol(),
            "amount": amount.to_string(),
        }),
        PlanStep::SendXcm {
            origin,
            destination,
            instructions,
        } => json!({
            "type": "send-xcm",
            "origin": origin.as_str(),
            "destination": destination.as_str(),
            "instructions": instructions.iter().map(xcm_instruction_to_json_value).collect::<Vec<_>>(),
        }),
        PlanStep::ExpectSettlement {
            chain,
            asset,
            recipient,
            minimum_amount,
        } => json!({
            "type": "expect-settlement",
            "chain": chain.as_str(),
            "asset": asset.symbol(),
            "recipient": recipient,
            "minimumAmount": minimum_amount.map(|value| value.to_string()),
        }),
    }
}

fn xcm_instruction_to_json_value(instruction: &XcmInstruction) -> Value {
    match instruction {
        XcmInstruction::WithdrawAsset { asset, amount } => json!({
            "type": "withdraw-asset",
            "asset": asset.symbol(),
            "amount": amount.to_string(),
        }),
        XcmInstruction::PayFees { asset, amount } => json!({
            "type": "pay-fees",
            "asset": asset.symbol(),
            "amount": amount.to_string(),
        }),
        XcmInstruction::TransferReserveAsset {
            asset,
            amount,
            destination,
            remote_instructions,
        } => json!({
            "type": "transfer-reserve-asset",
            "asset": asset.symbol(),
            "amount": amount.to_string(),
            "destination": destination.as_str(),
            "remoteInstructions": remote_instructions.iter().map(xcm_instruction_to_json_value).collect::<Vec<_>>(),
        }),
        XcmInstruction::BuyExecution { asset, amount } => json!({
            "type": "buy-execution",
            "asset": asset.symbol(),
            "amount": amount.to_string(),
        }),
        XcmInstruction::ExchangeAsset {
            asset_in,
            amount_in,
            asset_out,
            min_amount_out,
            maximal,
        } => json!({
            "type": "exchange-asset",
            "assetIn": asset_in.symbol(),
            "amountIn": amount_in.to_string(),
            "assetOut": asset_out.symbol(),
            "minAmountOut": min_amount_out.to_string(),
            "maximal": maximal,
        }),
        XcmInstruction::DepositReserveAsset {
            asset_count,
            destination,
            remote_instructions,
        } => json!({
            "type": "deposit-reserve-asset",
            "assetCount": asset_count,
            "destination": destination.as_str(),
            "remoteInstructions": remote_instructions.iter().map(xcm_instruction_to_json_value).collect::<Vec<_>>(),
        }),
        XcmInstruction::InitiateTeleport {
            asset_count,
            destination,
            remote_instructions,
        } => json!({
            "type": "initiate-teleport",
            "assetCount": asset_count,
            "destination": destination.as_str(),
            "remoteInstructions": remote_instructions.iter().map(xcm_instruction_to_json_value).collect::<Vec<_>>(),
        }),
        XcmInstruction::InitiateTransfer {
            asset,
            amount,
            destination,
            remote_fee_asset,
            remote_fee_amount,
            preserve_origin,
            remote_instructions,
        } => json!({
            "type": "initiate-transfer",
            "asset": asset.symbol(),
            "amount": amount.to_string(),
            "destination": destination.as_str(),
            "remoteFeeAsset": remote_fee_asset.symbol(),
            "remoteFeeAmount": remote_fee_amount.to_string(),
            "preserveOrigin": preserve_origin,
            "remoteInstructions": remote_instructions.iter().map(xcm_instruction_to_json_value).collect::<Vec<_>>(),
        }),
        XcmInstruction::InitiateReserveWithdraw {
            asset_count,
            reserve,
            remote_instructions,
        } => json!({
            "type": "initiate-reserve-withdraw",
            "assetCount": asset_count,
            "reserve": reserve.as_str(),
            "remoteInstructions": remote_instructions.iter().map(xcm_instruction_to_json_value).collect::<Vec<_>>(),
        }),
        XcmInstruction::Transact {
            origin_kind,
            fallback_weight,
            call_data,
        } => json!({
            "type": "transact",
            "originKind": origin_kind.as_str(),
            "fallbackWeight": {
                "refTime": fallback_weight.ref_time,
                "proofSize": fallback_weight.proof_size,
            },
            "callData": call_data,
        }),
        XcmInstruction::DepositAsset {
            asset,
            recipient,
            asset_count,
        } => json!({
            "type": "deposit-asset",
            "asset": asset.symbol(),
            "recipient": recipient,
            "assetCount": asset_count,
        }),
    }
}

fn asset_amount_to_json_value(amount: &AssetAmount) -> Value {
    json!({
        "asset": amount.asset.symbol(),
        "amount": amount.amount.to_string(),
    })
}

fn parse_chain(value: &str) -> Result<ChainKey, String> {
    match value.trim() {
        "polkadot-hub" | "asset-hub" => Ok(ChainKey::PolkadotHub),
        "hydration" => Ok(ChainKey::Hydration),
        "bifrost" => Ok(ChainKey::Bifrost),
        "moonbeam" => Ok(ChainKey::Moonbeam),
        other => Err(format!("unsupported chain: {other}")),
    }
}

fn parse_asset(value: &str) -> Result<AssetKey, String> {
    match value.trim().to_uppercase().as_str() {
        "DOT" => Ok(AssetKey::Dot),
        "USDT" => Ok(AssetKey::Usdt),
        "HDX" => Ok(AssetKey::Hdx),
        "VDOT" => Ok(AssetKey::Vdot),
        other => Err(format!("unsupported asset: {other}")),
    }
}

fn parse_u128(value: &str, name: &str) -> Result<u128, String> {
    value
        .parse::<u128>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn normalize_source_intent_metadata(
    metadata: SourceIntentMetadata,
) -> Result<SourceIntentMetadata, String> {
    Ok(SourceIntentMetadata {
        kind: normalize_source_intent_kind(&metadata.kind)?,
        refund_asset: metadata.refund_asset.trim().to_owned(),
        refundable_amount: parse_u128(&metadata.refundable_amount, "sourceIntent.refundableAmount")?
            .to_string(),
        min_output_amount: parse_u128(&metadata.min_output_amount, "sourceIntent.minOutputAmount")?
            .to_string(),
    })
}

fn normalize_source_dispatch_metadata(
    metadata: SourceDispatchMetadata,
) -> Result<SourceDispatchMetadata, String> {
    Ok(SourceDispatchMetadata {
        tx_hash: normalize_bytes32(&metadata.tx_hash, "sourceDispatch.txHash")?,
        strategy: metadata
            .strategy
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
    })
}

fn normalize_source_intent_kind(value: &str) -> Result<String, String> {
    match value.trim() {
        "router-evm" => Ok("router-evm".to_owned()),
        "substrate-source" => Ok("substrate-source".to_owned()),
        other => Err(format!(
            "sourceIntent.kind must be one of router-evm or substrate-source, received {other}"
        )),
    }
}

fn parse_u64(value: &str, name: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn normalize_dispatch_mode(value: u8) -> Result<u8, String> {
    match value {
        0 | 1 => Ok(value),
        other => Err(format!("request.mode must be 0 or 1, received {other}")),
    }
}

fn normalize_hex(value: &str, name: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if normalized.len() < 2
        || !normalized.starts_with("0x")
        || normalized[2..].len() % 2 != 0
        || !normalized[2..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(format!(
            "{name} must be a 0x-prefixed even-length hex string"
        ));
    }

    Ok(normalized)
}

fn normalize_address(value: &str, name: &str) -> Result<String, String> {
    let normalized = normalize_hex(value, name)?;
    if normalized.len() != 42 {
        return Err(format!("{name} must be a 20-byte 0x-prefixed hex address"));
    }

    Ok(normalized)
}

fn normalize_refund_address(
    source_chain: ChainKey,
    value: &str,
    name: &str,
) -> Result<String, String> {
    match source_chain {
        ChainKey::PolkadotHub | ChainKey::Moonbeam => normalize_address(value, name),
        ChainKey::Hydration | ChainKey::Bifrost => require_non_empty(value, name),
    }
}

fn normalize_bytes32(value: &str, name: &str) -> Result<String, String> {
    let normalized = normalize_hex(value, name)?;
    if normalized.len() != 66 {
        return Err(format!("{name} must be a 32-byte 0x-prefixed hex value"));
    }

    Ok(normalized)
}

fn require_non_empty(value: &str, name: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("{name} is required"));
    }

    Ok(normalized.to_owned())
}

fn normalize_remark(value: &str, name: &str) -> Result<String, String> {
    let normalized = require_non_empty(value, name)?;
    if normalized.len() > 32 {
        return Err(format!("{name} must be 32 characters or fewer"));
    }

    Ok(normalized)
}

fn require_field(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing required field {name}"))
}

fn submission_action_label(action: SubmissionAction) -> &'static str {
    match action {
        SubmissionAction::Transfer => "transfer",
        SubmissionAction::Swap => "swap",
        SubmissionAction::Execute => "execute",
    }
}

fn route_segment_kind_label(kind: RouteSegmentKind) -> &'static str {
    match kind {
        RouteSegmentKind::Execution => "execution",
        RouteSegmentKind::Settlement => "settlement",
    }
}

fn fee_type_label(fee_type: FeeType) -> &'static str {
    match fee_type {
        FeeType::Xcm => "xcm",
        FeeType::Destination => "destination",
        FeeType::Platform => "platform",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quote_request_accepts_substrate_refund_address_for_hydration_sources() {
        let body = serde_json::to_vec(&json!({
            "intent": {
                "sourceChain": "hydration",
                "destinationChain": "moonbeam",
                "refundAddress": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                "deadline": 1_773_185_200u64,
                "action": {
                    "type": "transfer",
                    "params": {
                        "asset": "DOT",
                        "amount": "10",
                        "recipient": "0x1111111111111111111111111111111111111111",
                    }
                }
            }
        }))
        .expect("request body should encode");

        let parsed = quote_request_from_slice(&body).expect("hydration refund address should parse");
        assert_eq!(parsed.intent.source_chain, ChainKey::Hydration);
        assert_eq!(
            parsed.intent.refund_address,
            "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
        );
    }

    #[test]
    fn quote_request_rejects_non_evm_refund_address_for_evm_sources() {
        let body = serde_json::to_vec(&json!({
            "intent": {
                "sourceChain": "moonbeam",
                "destinationChain": "hydration",
                "refundAddress": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                "deadline": 1_773_185_200u64,
                "action": {
                    "type": "transfer",
                    "params": {
                        "asset": "DOT",
                        "amount": "10",
                        "recipient": "5Frecipient",
                    }
                }
            }
        }))
        .expect("request body should encode");

        let error = quote_request_from_slice(&body).expect_err("moonbeam refund address must stay evm");
        assert!(
            error
                .message
                .contains("refundAddress must be a 0x-prefixed even-length hex string"),
            "unexpected error: {}",
            error.message
        );
    }
}
