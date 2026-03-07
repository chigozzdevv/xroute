use std::collections::HashMap;

use route_engine::{
    AssetAmount, AssetKey, ChainKey, DeploymentProfile, EngineSettings,
    EvmContractCallExecuteIntent, ExecuteIntent, ExecutionPlan, ExecutionType, FeeBreakdown,
    FeeType, Intent, IntentAction, PlanStep, Quote, RouteHop, RouteEngine, RouteRegistry,
    RouteSegment, RouteSegmentKind, RuntimeCallExecuteIntent, RuntimeCallOriginKind,
    SubmissionAction, SwapIntent, TransferIntent, VtokenOrderExecuteIntent, VtokenOrderOperation,
    XcmInstruction, XcmWeight,
};

pub fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        return Err(usage());
    };

    match command.as_str() {
        "quote" => run_quote(args.collect()),
        other => Err(format!("unsupported command: {other}\n\n{}", usage())),
    }
}

fn run_quote(args: Vec<String>) -> Result<(), String> {
    let options = parse_options(args)?;
    let deployment_profile = options
        .get("deployment-profile")
        .map(String::as_str)
        .map(parse_deployment_profile)
        .transpose()?
        .unwrap_or(DeploymentProfile::Testnet);
    let intent = build_intent(&options)?;
    let quote = RouteEngine::new(
        RouteRegistry::default(),
        EngineSettings {
            platform_fee_bps: 10,
            deployment_profile,
        },
    )
    .quote(intent)
    .map_err(|error| error.to_string())?;

    println!("{}", quote_to_json(&quote));
    Ok(())
}

fn parse_options(args: Vec<String>) -> Result<HashMap<String, String>, String> {
    if args.len() % 2 != 0 {
        return Err("flags must be provided as --name value pairs".to_owned());
    }

    let mut options = HashMap::new();
    let mut index = 0usize;
    while index < args.len() {
        let flag = &args[index];
        if !flag.starts_with("--") {
            return Err(format!("unexpected argument: {flag}"));
        }

        let key = flag.trim_start_matches("--").to_owned();
        let value = args[index + 1].clone();
        options.insert(key, value);
        index += 2;
    }

    Ok(options)
}

fn build_intent(options: &HashMap<String, String>) -> Result<Intent, String> {
    let source_chain = parse_chain(required(options, "source-chain")?)?;
    let destination_chain = parse_chain(required(options, "destination-chain")?)?;
    let refund_address = required(options, "refund-address")?.to_owned();
    let deadline = parse_u64(required(options, "deadline")?, "deadline")?;
    let action = match required(options, "action")? {
        "transfer" => IntentAction::Transfer(TransferIntent {
            asset: parse_asset(required(options, "asset")?)?,
            amount: parse_u128(required(options, "amount")?, "amount")?,
            recipient: required(options, "recipient")?.to_owned(),
        }),
        "swap" => IntentAction::Swap(SwapIntent {
            asset_in: parse_asset(required(options, "asset-in")?)?,
            asset_out: parse_asset(required(options, "asset-out")?)?,
            amount_in: parse_u128(required(options, "amount-in")?, "amount-in")?,
            min_amount_out: parse_u128(required(options, "min-amount-out")?, "min-amount-out")?,
            settlement_chain: options
                .get("settlement-chain")
                .map(String::as_str)
                .map(parse_chain)
                .transpose()?
                .unwrap_or(destination_chain),
            recipient: required(options, "recipient")?.to_owned(),
        }),
        "execute" => IntentAction::Execute(build_execute_intent(options)?),
        other => {
            return Err(format!(
                "unsupported action: {other} (expected transfer, swap, or execute)"
            ))
        }
    };

    Ok(Intent {
        source_chain,
        destination_chain,
        action,
        refund_address,
        deadline,
    })
}

fn required<'a>(options: &'a HashMap<String, String>, key: &str) -> Result<&'a str, String> {
    options
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("missing required flag --{key}"))
}

fn parse_chain(value: &str) -> Result<ChainKey, String> {
    match value {
        "polkadot-hub" | "asset-hub" => Ok(ChainKey::PolkadotHub),
        "hydration" => Ok(ChainKey::Hydration),
        "moonbeam" => Ok(ChainKey::Moonbeam),
        "bifrost" => Ok(ChainKey::Bifrost),
        other => Err(format!("unsupported chain: {other}")),
    }
}

fn parse_asset(value: &str) -> Result<AssetKey, String> {
    match value {
        "DOT" => Ok(AssetKey::Dot),
        "USDT" => Ok(AssetKey::Usdt),
        "HDX" => Ok(AssetKey::Hdx),
        "VDOT" => Ok(AssetKey::Vdot),
        other => Err(format!("unsupported asset: {other}")),
    }
}

fn parse_deployment_profile(value: &str) -> Result<DeploymentProfile, String> {
    match value {
        "testnet" => Ok(DeploymentProfile::Testnet),
        "mainnet" => Ok(DeploymentProfile::Mainnet),
        other => Err(format!("unsupported deployment profile: {other}")),
    }
}

fn parse_execution_type(value: &str) -> Result<ExecutionType, String> {
    match value {
        "runtime-call" => Ok(ExecutionType::RuntimeCall),
        "evm-contract-call" => Ok(ExecutionType::EvmContractCall),
        "vtoken-order" => Ok(ExecutionType::VtokenOrder),
        other => Err(format!("unsupported execution type: {other}")),
    }
}

fn parse_vtoken_order_operation(value: &str) -> Result<VtokenOrderOperation, String> {
    match value {
        "mint" => Ok(VtokenOrderOperation::Mint),
        other => Err(format!("unsupported vtoken order operation: {other}")),
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

fn parse_u64(value: &str, name: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn parse_u128(value: &str, name: &str) -> Result<u128, String> {
    value
        .parse::<u128>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn parse_hex_string(value: &str, name: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if normalized.len() < 2
        || !normalized.starts_with("0x")
        || !normalized[2..].chars().all(|char| char.is_ascii_hexdigit())
        || normalized[2..].len() % 2 != 0
    {
        return Err(format!("{name} must be a 0x-prefixed even-length hex string"));
    }

    Ok(normalized)
}

fn parse_h160_string(value: &str, name: &str) -> Result<String, String> {
    let normalized = parse_hex_string(value, name)?;
    if normalized.len() != 42 {
        return Err(format!("{name} must be a 20-byte 0x-prefixed hex string"));
    }

    Ok(normalized)
}

fn parse_h256_string(value: &str, name: &str) -> Result<String, String> {
    let normalized = parse_hex_string(value, name)?;
    if normalized.len() != 66 {
        return Err(format!("{name} must be a 32-byte 0x-prefixed hex string"));
    }

    Ok(normalized)
}

fn parse_u32(value: &str, name: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

fn parse_ascii_remark(value: &str, name: &str) -> Result<String, String> {
    if value.as_bytes().len() > 32 {
        return Err(format!("{name} must be at most 32 bytes"));
    }

    Ok(value.to_owned())
}

fn build_execute_intent(options: &HashMap<String, String>) -> Result<ExecuteIntent, String> {
    let execution_type = parse_execution_type(required(options, "execution-type")?)?;
    let fallback_weight = XcmWeight {
        ref_time: parse_u64(required(options, "fallback-ref-time")?, "fallback-ref-time")?,
        proof_size: parse_u64(
            required(options, "fallback-proof-size")?,
            "fallback-proof-size",
        )?,
    };

    match execution_type {
        ExecutionType::RuntimeCall => Ok(ExecuteIntent::RuntimeCall(RuntimeCallExecuteIntent {
            asset: parse_asset(required(options, "asset")?)?,
            max_payment_amount: parse_u128(
                required(options, "max-payment-amount")?,
                "max-payment-amount",
            )?,
            call_data: parse_hex_string(required(options, "call-data")?, "call-data")?,
            origin_kind: options
                .get("origin-kind")
                .map(String::as_str)
                .map(parse_origin_kind)
                .transpose()?
                .unwrap_or(RuntimeCallOriginKind::SovereignAccount),
            fallback_weight,
        })),
        ExecutionType::EvmContractCall => {
            Ok(ExecuteIntent::EvmContractCall(EvmContractCallExecuteIntent {
                asset: parse_asset(required(options, "asset")?)?,
                max_payment_amount: parse_u128(
                    required(options, "max-payment-amount")?,
                    "max-payment-amount",
                )?,
                contract_address: parse_h160_string(
                    required(options, "contract-address")?,
                    "contract-address",
                )?,
                calldata: parse_hex_string(required(options, "calldata")?, "calldata")?,
                value: options
                    .get("value")
                    .map(String::as_str)
                    .map(|value| parse_u128(value, "value"))
                    .transpose()?
                    .unwrap_or(0),
                gas_limit: parse_u64(required(options, "gas-limit")?, "gas-limit")?,
                fallback_weight,
            }))
        }
        ExecutionType::VtokenOrder => Ok(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
            asset: parse_asset(required(options, "asset")?)?,
            amount: parse_u128(required(options, "amount")?, "amount")?,
            max_payment_amount: parse_u128(
                required(options, "max-payment-amount")?,
                "max-payment-amount",
            )?,
            operation: parse_vtoken_order_operation(required(options, "operation")?)?,
            recipient: required(options, "recipient")?.to_owned(),
            recipient_account_id_hex: parse_h256_string(
                required(options, "recipient-account-id")?,
                "recipient-account-id",
            )?,
            channel_id: options
                .get("channel-id")
                .map(String::as_str)
                .map(|value| parse_u32(value, "channel-id"))
                .transpose()?
                .unwrap_or(0),
            remark: options
                .get("remark")
                .map(String::as_str)
                .map(|value| parse_ascii_remark(value, "remark"))
                .transpose()?
                .unwrap_or_else(String::new),
            fallback_weight,
        })),
    }
}

fn quote_to_json(quote: &Quote) -> String {
    format!(
        "{{\"quoteId\":{},\"deploymentProfile\":{},\"route\":{},\"segments\":[{}],\"fees\":{},\"estimatedSettlementFee\":{},\"expectedOutput\":{},\"minOutput\":{},\"submission\":{},\"executionPlan\":{}}}",
        json_string(&quote.quote_id),
        json_string(quote.deployment_profile.as_str()),
        chain_array_json(&quote.route),
        quote
            .segments
            .iter()
            .map(route_segment_json)
            .collect::<Vec<_>>()
            .join(","),
        fee_breakdown_json(&quote.fees),
        option_asset_amount_json(quote.estimated_settlement_fee.as_ref()),
        asset_amount_json(&quote.expected_output),
        option_asset_amount_json(quote.min_output.as_ref()),
        submission_terms_json(quote),
        execution_plan_json(&quote.execution_plan),
    )
}

fn fee_breakdown_json(fees: &FeeBreakdown) -> String {
    format!(
        "{{\"xcmFee\":{},\"destinationFee\":{},\"platformFee\":{},\"totalFee\":{}}}",
        asset_amount_json(&fees.xcm_fee),
        asset_amount_json(&fees.destination_fee),
        asset_amount_json(&fees.platform_fee),
        asset_amount_json(&fees.total_fee),
    )
}

fn submission_terms_json(quote: &Quote) -> String {
    format!(
        "{{\"action\":{},\"asset\":{},\"amount\":{},\"xcmFee\":{},\"destinationFee\":{},\"minOutputAmount\":{}}}",
        json_string(submission_action_label(quote.submission.action)),
        json_string(quote.submission.asset.symbol()),
        json_string(&quote.submission.amount.to_string()),
        json_string(&quote.submission.xcm_fee.to_string()),
        json_string(&quote.submission.destination_fee.to_string()),
        json_string(&quote.submission.min_output_amount.to_string()),
    )
}

fn execution_plan_json(plan: &ExecutionPlan) -> String {
    format!(
        "{{\"route\":{},\"steps\":[{}]}}",
        chain_array_json(&plan.route),
        plan.steps
            .iter()
            .map(plan_step_json)
            .collect::<Vec<_>>()
            .join(","),
    )
}

fn route_segment_json(segment: &RouteSegment) -> String {
    format!(
        "{{\"kind\":{},\"route\":{},\"hops\":[{}],\"xcmFee\":{},\"destinationFee\":{}}}",
        json_string(route_segment_kind_label(segment.kind)),
        chain_array_json(&segment.route),
        segment
            .hops
            .iter()
            .map(route_hop_json)
            .collect::<Vec<_>>()
            .join(","),
        asset_amount_json(&segment.xcm_fee),
        asset_amount_json(&segment.destination_fee),
    )
}

fn route_hop_json(hop: &RouteHop) -> String {
    format!(
        "{{\"source\":{},\"destination\":{},\"asset\":{},\"transportFee\":{},\"buyExecutionFee\":{}}}",
        json_string(hop.source.as_str()),
        json_string(hop.destination.as_str()),
        json_string(hop.asset.symbol()),
        asset_amount_json(&hop.transport_fee),
        asset_amount_json(&hop.buy_execution_fee),
    )
}

fn plan_step_json(step: &PlanStep) -> String {
    match step {
        PlanStep::LockAsset {
            chain,
            asset,
            amount,
        } => format!(
            "{{\"type\":\"lock-asset\",\"chain\":{},\"asset\":{},\"amount\":{}}}",
            json_string(chain.as_str()),
            json_string(asset.symbol()),
            json_string(&amount.to_string()),
        ),
        PlanStep::ChargeFee {
            fee_type,
            asset,
            amount,
        } => format!(
            "{{\"type\":\"charge-fee\",\"feeType\":{},\"asset\":{},\"amount\":{}}}",
            json_string(fee_type_label(*fee_type)),
            json_string(asset.symbol()),
            json_string(&amount.to_string()),
        ),
        PlanStep::SendXcm {
            origin,
            destination,
            instructions,
        } => format!(
            "{{\"type\":\"send-xcm\",\"origin\":{},\"destination\":{},\"instructions\":[{}]}}",
            json_string(origin.as_str()),
            json_string(destination.as_str()),
            instructions
                .iter()
                .map(xcm_instruction_json)
                .collect::<Vec<_>>()
                .join(","),
        ),
        PlanStep::ExpectSettlement {
            chain,
            asset,
            recipient,
            minimum_amount,
        } => format!(
            "{{\"type\":\"expect-settlement\",\"chain\":{},\"asset\":{},\"recipient\":{},\"minimumAmount\":{}}}",
            json_string(chain.as_str()),
            json_string(asset.symbol()),
            json_string(recipient),
            option_amount_json(minimum_amount),
        ),
    }
}

fn xcm_instruction_json(instruction: &XcmInstruction) -> String {
    match instruction {
        XcmInstruction::TransferReserveAsset {
            asset,
            amount,
            destination,
            remote_instructions,
        } => format!(
            "{{\"type\":\"transfer-reserve-asset\",\"asset\":{},\"amount\":{},\"destination\":{},\"remoteInstructions\":[{}]}}",
            json_string(asset.symbol()),
            json_string(&amount.to_string()),
            json_string(destination.as_str()),
            remote_instructions
                .iter()
                .map(xcm_instruction_json)
                .collect::<Vec<_>>()
                .join(","),
        ),
        XcmInstruction::BuyExecution { asset, amount } => format!(
            "{{\"type\":\"buy-execution\",\"asset\":{},\"amount\":{}}}",
            json_string(asset.symbol()),
            json_string(&amount.to_string()),
        ),
        XcmInstruction::ExchangeAsset {
            asset_in,
            amount_in,
            asset_out,
            min_amount_out,
            maximal,
        } => format!(
            "{{\"type\":\"exchange-asset\",\"assetIn\":{},\"amountIn\":{},\"assetOut\":{},\"minAmountOut\":{},\"maximal\":{}}}",
            json_string(asset_in.symbol()),
            json_string(&amount_in.to_string()),
            json_string(asset_out.symbol()),
            json_string(&min_amount_out.to_string()),
            if *maximal { "true" } else { "false" },
        ),
        XcmInstruction::DepositReserveAsset {
            asset_count,
            destination,
            remote_instructions,
        } => format!(
            "{{\"type\":\"deposit-reserve-asset\",\"assetCount\":{},\"destination\":{},\"remoteInstructions\":[{}]}}",
            asset_count,
            json_string(destination.as_str()),
            remote_instructions
                .iter()
                .map(xcm_instruction_json)
                .collect::<Vec<_>>()
                .join(","),
        ),
        XcmInstruction::InitiateReserveWithdraw {
            asset_count,
            reserve,
            remote_instructions,
        } => format!(
            "{{\"type\":\"initiate-reserve-withdraw\",\"assetCount\":{},\"reserve\":{},\"remoteInstructions\":[{}]}}",
            asset_count,
            json_string(reserve.as_str()),
            remote_instructions
                .iter()
                .map(xcm_instruction_json)
                .collect::<Vec<_>>()
                .join(","),
        ),
        XcmInstruction::DepositAsset {
            asset,
            recipient,
            asset_count,
        } => format!(
            "{{\"type\":\"deposit-asset\",\"asset\":{},\"recipient\":{},\"assetCount\":{}}}",
            json_string(asset.symbol()),
            json_string(recipient),
            asset_count,
        ),
        XcmInstruction::Transact {
            origin_kind,
            fallback_weight,
            call_data,
        } => format!(
            "{{\"type\":\"transact\",\"originKind\":{},\"fallbackWeight\":{{\"refTime\":{},\"proofSize\":{}}},\"callData\":{}}}",
            json_string(origin_kind.as_str()),
            fallback_weight.ref_time,
            fallback_weight.proof_size,
            json_string(call_data),
        ),
    }
}

fn asset_amount_json(asset_amount: &AssetAmount) -> String {
    format!(
        "{{\"asset\":{},\"amount\":{}}}",
        json_string(asset_amount.asset.symbol()),
        json_string(&asset_amount.amount.to_string()),
    )
}

fn option_asset_amount_json(asset_amount: Option<&AssetAmount>) -> String {
    asset_amount
        .map(asset_amount_json)
        .unwrap_or_else(|| "null".to_owned())
}

fn option_amount_json(amount: &Option<u128>) -> String {
    amount
        .map(|value| json_string(&value.to_string()))
        .unwrap_or_else(|| "null".to_owned())
}

fn chain_array_json(chains: &[ChainKey]) -> String {
    format!(
        "[{}]",
        chains
            .iter()
            .map(|chain| json_string(chain.as_str()))
            .collect::<Vec<_>>()
            .join(","),
    )
}

fn json_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{escaped}\"")
}

fn submission_action_label(action: SubmissionAction) -> &'static str {
    match action {
        SubmissionAction::Transfer => "transfer",
        SubmissionAction::Swap => "swap",
        SubmissionAction::Execute => "execute",
    }
}

fn fee_type_label(fee_type: FeeType) -> &'static str {
    match fee_type {
        FeeType::Xcm => "xcm",
        FeeType::Destination => "destination",
        FeeType::Platform => "platform",
    }
}

fn route_segment_kind_label(kind: RouteSegmentKind) -> &'static str {
    match kind {
        RouteSegmentKind::Execution => "execution",
        RouteSegmentKind::Settlement => "settlement",
    }
}

fn usage() -> String {
    [
        "usage:",
        "  route-engine quote --source-chain <chain> --destination-chain <chain> --refund-address <address> --deadline <unix-seconds> --action <transfer|swap|execute> [action flags] [--deployment-profile <testnet|mainnet>]",
        "",
        "action flags:",
        "  transfer: --asset <symbol> --amount <units> --recipient <address>",
        "  swap: --asset-in <symbol> --asset-out <symbol> --amount-in <units> --min-amount-out <units> --recipient <address> [--settlement-chain <chain>]",
        "  execute/runtime-call: --execution-type runtime-call --asset <symbol> --max-payment-amount <units> --call-data <hex> --fallback-ref-time <u64> --fallback-proof-size <u64> [--origin-kind <sovereign-account|xcm|native|superuser>]",
        "  execute/evm-contract-call: --execution-type evm-contract-call --asset <symbol> --max-payment-amount <units> --contract-address <0x...> --calldata <hex> --gas-limit <u64> [--value <u128>] --fallback-ref-time <u64> --fallback-proof-size <u64>",
        "  execute/vtoken-order: --execution-type vtoken-order --asset <symbol> --amount <units> --max-payment-amount <units> --operation mint --recipient <address> --recipient-account-id <0x...> [--channel-id <u32>] [--remark <text>] --fallback-ref-time <u64> --fallback-proof-size <u64>",
    ]
    .join("\n")
}
