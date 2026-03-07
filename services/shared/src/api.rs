use crate::http::HttpError;
use route_engine::{
    AssetAmount, AssetKey, ChainKey, DeploymentProfile, EvmContractCallExecuteIntent,
    ExecuteIntent, ExecutionPlan, ExecutionType, FeeBreakdown, FeeType, Intent, IntentAction,
    PlanStep, Quote, RouteHop, RouteSegment, RouteSegmentKind, RuntimeCallExecuteIntent,
    RuntimeCallOriginKind, SubmissionAction, SwapIntent, TransferIntent,
    VtokenOrderExecuteIntent, VtokenOrderOperation, XcmInstruction, XcmWeight,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone)]
pub struct DispatchJobRequest {
    pub intent_id: String,
    pub wire_intent: WireIntent,
    pub intent: Intent,
    pub request: DispatchRequest,
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
struct RuntimeCallParams {
    #[serde(rename = "executionType")]
    _execution_type: String,
    asset: String,
    max_payment_amount: String,
    call_data: String,
    origin_kind: String,
    fallback_weight: FallbackWeight,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvmContractCallParams {
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
struct VtokenOrderParams {
    #[serde(rename = "executionType")]
    _execution_type: String,
    asset: String,
    amount: String,
    max_payment_amount: String,
    operation: String,
    recipient: String,
    recipient_account_id_hex: String,
    channel_id: u32,
    remark: String,
    fallback_weight: FallbackWeight,
}

pub fn quote_request_from_slice(body: &[u8]) -> Result<QuoteRequest, HttpError> {
    let payload: QuoteBody = serde_json::from_slice(body)
        .map_err(|error| HttpError::bad_request(format!("invalid quote request: {error}")))?;
    let quote_id = payload
        .intent
        .quote_id
        .clone()
        .unwrap_or_else(|| payload.intent.clone().into_internal_id());
    let intent = wire_intent_to_internal(&payload.intent)
        .map_err(HttpError::bad_request)?;

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
        failure_reason_hash: normalize_bytes32(
            &payload.failure_reason_hash,
            "failureReasonHash",
        )
        .map_err(HttpError::bad_request)?,
    })
}

pub fn refund_job_request_from_slice(body: &[u8]) -> Result<RefundJobRequest, HttpError> {
    let payload: RefundJobBody = serde_json::from_slice(body).map_err(|error| {
        HttpError::bad_request(format!("invalid refund job request: {error}"))
    })?;
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

pub fn summary_json(
    queued: usize,
    running: usize,
    completed: usize,
    failed: usize,
) -> Value {
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
    let refund_address = normalize_address(&wire.refund_address, "refundAddress")?;
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
                min_amount_out: parse_u128(
                    &params.min_amount_out,
                    "action.params.minAmountOut",
                )?,
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
        "runtime-call" => {
            let params: RuntimeCallParams = serde_json::from_value(params.clone())
                .map_err(|error| format!("invalid runtime-call params: {error}"))?;
            ensure_supported_execute_destination(destination_chain, ExecutionType::RuntimeCall)?;
            Ok(ExecuteIntent::RuntimeCall(RuntimeCallExecuteIntent {
                asset: parse_asset(&params.asset)?,
                max_payment_amount: parse_u128(
                    &params.max_payment_amount,
                    "action.params.maxPaymentAmount",
                )?,
                call_data: normalize_hex(&params.call_data, "action.params.callData")?,
                origin_kind: parse_origin_kind(&params.origin_kind)?,
                fallback_weight: XcmWeight {
                    ref_time: params.fallback_weight.ref_time,
                    proof_size: params.fallback_weight.proof_size,
                },
            }))
        }
        "evm-contract-call" => {
            let params: EvmContractCallParams = serde_json::from_value(params.clone())
                .map_err(|error| format!("invalid evm-contract-call params: {error}"))?;
            ensure_supported_execute_destination(
                destination_chain,
                ExecutionType::EvmContractCall,
            )?;
            Ok(ExecuteIntent::EvmContractCall(EvmContractCallExecuteIntent {
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
            }))
        }
        "vtoken-order" => {
            let params: VtokenOrderParams = serde_json::from_value(params.clone())
                .map_err(|error| format!("invalid vtoken-order params: {error}"))?;
            ensure_supported_execute_destination(destination_chain, ExecutionType::VtokenOrder)?;
            Ok(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
                asset: parse_asset(&params.asset)?,
                amount: parse_u128(&params.amount, "action.params.amount")?,
                max_payment_amount: parse_u128(
                    &params.max_payment_amount,
                    "action.params.maxPaymentAmount",
                )?,
                operation: parse_vtoken_operation(&params.operation)?,
                recipient: require_non_empty(&params.recipient, "action.params.recipient")?,
                recipient_account_id_hex: normalize_bytes32(
                    &params.recipient_account_id_hex,
                    "action.params.recipientAccountIdHex",
                )?,
                channel_id: params.channel_id,
                remark: normalize_remark(&params.remark)?,
                fallback_weight: XcmWeight {
                    ref_time: params.fallback_weight.ref_time,
                    proof_size: params.fallback_weight.proof_size,
                },
            }))
        }
        other => Err(format!("unsupported execution type: {other}")),
    }
}

fn ensure_supported_execute_destination(
    destination: ChainKey,
    execution_type: ExecutionType,
) -> Result<(), String> {
    match (destination, execution_type) {
        (_, ExecutionType::RuntimeCall) => Ok(()),
        (ChainKey::Moonbeam, ExecutionType::EvmContractCall) => Ok(()),
        (ChainKey::Bifrost, ExecutionType::VtokenOrder) => Ok(()),
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
        ExecuteIntent::RuntimeCall(runtime_call) => json!({
            "executionType": "runtime-call",
            "asset": runtime_call.asset.symbol(),
            "maxPaymentAmount": runtime_call.max_payment_amount.to_string(),
            "callData": runtime_call.call_data,
            "originKind": runtime_call.origin_kind.as_str(),
            "fallbackWeight": {
                "refTime": runtime_call.fallback_weight.ref_time,
                "proofSize": runtime_call.fallback_weight.proof_size,
            },
        }),
        ExecuteIntent::EvmContractCall(evm_call) => json!({
            "executionType": "evm-contract-call",
            "asset": evm_call.asset.symbol(),
            "maxPaymentAmount": evm_call.max_payment_amount.to_string(),
            "contractAddress": evm_call.contract_address,
            "calldata": evm_call.calldata,
            "value": evm_call.value.to_string(),
            "gasLimit": evm_call.gas_limit.to_string(),
            "fallbackWeight": {
                "refTime": evm_call.fallback_weight.ref_time,
                "proofSize": evm_call.fallback_weight.proof_size,
            },
        }),
        ExecuteIntent::VtokenOrder(vtoken_order) => json!({
            "executionType": "vtoken-order",
            "asset": vtoken_order.asset.symbol(),
            "amount": vtoken_order.amount.to_string(),
            "maxPaymentAmount": vtoken_order.max_payment_amount.to_string(),
            "operation": vtoken_order.operation.as_str(),
            "recipient": vtoken_order.recipient,
            "recipientAccountIdHex": vtoken_order.recipient_account_id_hex,
            "channelId": vtoken_order.channel_id,
            "remark": vtoken_order.remark,
            "fallbackWeight": {
                "refTime": vtoken_order.fallback_weight.ref_time,
                "proofSize": vtoken_order.fallback_weight.proof_size,
            },
        }),
    }
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
        PlanStep::LockAsset { chain, asset, amount } => json!({
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
        "moonbeam" => Ok(ChainKey::Moonbeam),
        "bifrost" => Ok(ChainKey::Bifrost),
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

fn parse_origin_kind(value: &str) -> Result<RuntimeCallOriginKind, String> {
    match value {
        "sovereign-account" => Ok(RuntimeCallOriginKind::SovereignAccount),
        "xcm" => Ok(RuntimeCallOriginKind::Xcm),
        "native" => Ok(RuntimeCallOriginKind::Native),
        "superuser" => Ok(RuntimeCallOriginKind::Superuser),
        other => Err(format!("unsupported origin kind: {other}")),
    }
}

fn parse_vtoken_operation(value: &str) -> Result<VtokenOrderOperation, String> {
    match value {
        "mint" => Ok(VtokenOrderOperation::Mint),
        "redeem" => Ok(VtokenOrderOperation::Redeem),
        other => Err(format!("unsupported vtoken order operation: {other}")),
    }
}

fn parse_u128(value: &str, name: &str) -> Result<u128, String> {
    value
        .parse::<u128>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
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
        || !normalized[2..].chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(format!("{name} must be a 0x-prefixed even-length hex string"));
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

fn normalize_bytes32(value: &str, name: &str) -> Result<String, String> {
    let normalized = normalize_hex(value, name)?;
    if normalized.len() != 66 {
        return Err(format!("{name} must be a 32-byte 0x-prefixed hex value"));
    }

    Ok(normalized)
}

fn normalize_remark(value: &str) -> Result<String, String> {
    if value.as_bytes().len() > 32 {
        return Err("action.params.remark must be at most 32 bytes".to_owned());
    }

    Ok(value.to_owned())
}

fn require_non_empty(value: &str, name: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("{name} is required"));
    }

    Ok(normalized.to_owned())
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
