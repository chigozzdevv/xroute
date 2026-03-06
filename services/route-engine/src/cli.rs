use std::collections::HashMap;

use route_engine::{
    AssetAmount, AssetKey, CallIntent, ChainKey, DeploymentProfile, DestinationAdapter,
    EngineSettings, ExecutionPlan, FeeBreakdown, FeeType, Intent, IntentAction, PlanStep, Quote,
    RouteEngine, RouteRegistry, StakeIntent, SubmissionAction, SwapIntent, TransferIntent,
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
        .unwrap_or(DeploymentProfile::Local);
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
            recipient: required(options, "recipient")?.to_owned(),
        }),
        "stake" => IntentAction::Stake(StakeIntent {
            asset: parse_asset(required(options, "asset")?)?,
            amount: parse_u128(required(options, "amount")?, "amount")?,
            validator: required(options, "validator")?.to_owned(),
            recipient: required(options, "recipient")?.to_owned(),
        }),
        "call" => IntentAction::Call(CallIntent {
            asset: parse_asset(required(options, "asset")?)?,
            amount: parse_u128(required(options, "amount")?, "amount")?,
            target: required(options, "target")?.to_owned(),
            calldata: required(options, "calldata")?.to_owned(),
        }),
        other => {
            return Err(format!(
                "unsupported action: {other} (expected transfer, swap, stake, or call)"
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
        "polkadot-hub" => Ok(ChainKey::PolkadotHub),
        "hydration" => Ok(ChainKey::Hydration),
        "asset-hub" => Ok(ChainKey::AssetHub),
        other => Err(format!("unsupported chain: {other}")),
    }
}

fn parse_asset(value: &str) -> Result<AssetKey, String> {
    match value {
        "DOT" => Ok(AssetKey::Dot),
        "USDT" => Ok(AssetKey::Usdt),
        "HDX" => Ok(AssetKey::Hdx),
        other => Err(format!("unsupported asset: {other}")),
    }
}

fn parse_deployment_profile(value: &str) -> Result<DeploymentProfile, String> {
    match value {
        "local" => Ok(DeploymentProfile::Local),
        "testnet" => Ok(DeploymentProfile::Testnet),
        "mainnet" => Ok(DeploymentProfile::Mainnet),
        other => Err(format!("unsupported deployment profile: {other}")),
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

fn quote_to_json(quote: &Quote) -> String {
    format!(
        "{{\"quoteId\":{},\"deploymentProfile\":{},\"route\":{},\"fees\":{},\"expectedOutput\":{},\"minOutput\":{},\"submission\":{},\"executionPlan\":{}}}",
        json_string(&quote.quote_id),
        json_string(quote.deployment_profile.as_str()),
        chain_array_json(&quote.route),
        fee_breakdown_json(&quote.fees),
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
        XcmInstruction::Transact {
            adapter,
            target_address,
            contract_call,
            fallback_weight,
        } => format!(
            "{{\"type\":\"transact\",\"adapter\":{},\"targetAddress\":{},\"contractCall\":{},\"fallbackWeight\":{}}}",
            json_string(destination_adapter_label(*adapter)),
            json_string(target_address),
            json_string(contract_call),
            xcm_weight_json(fallback_weight),
        ),
        XcmInstruction::DepositAsset { asset, recipient } => format!(
            "{{\"type\":\"deposit-asset\",\"asset\":{},\"recipient\":{}}}",
            json_string(asset.symbol()),
            json_string(recipient),
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

fn xcm_weight_json(weight: &XcmWeight) -> String {
    format!(
        "{{\"refTime\":{},\"proofSize\":{}}}",
        json_string(&weight.ref_time.to_string()),
        json_string(&weight.proof_size.to_string()),
    )
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
        SubmissionAction::Stake => "stake",
        SubmissionAction::Call => "call",
    }
}

fn fee_type_label(fee_type: FeeType) -> &'static str {
    match fee_type {
        FeeType::Xcm => "xcm",
        FeeType::Destination => "destination",
        FeeType::Platform => "platform",
    }
}

fn destination_adapter_label(adapter: DestinationAdapter) -> &'static str {
    adapter.as_str()
}

fn usage() -> String {
    [
        "usage:",
        "  route-engine quote --source-chain <chain> --destination-chain <chain> --refund-address <address> --deadline <unix-seconds> --action <transfer|swap|stake|call> [action flags] [--deployment-profile <local|testnet|mainnet>]",
        "",
        "action flags:",
        "  transfer: --asset <symbol> --amount <units> --recipient <address>",
        "  swap: --asset-in <symbol> --asset-out <symbol> --amount-in <units> --min-amount-out <units> --recipient <address>",
        "  stake: --asset <symbol> --amount <units> --validator <id> --recipient <address>",
        "  call: --asset <symbol> --amount <units> --target <address> --calldata <hex>",
    ]
    .join("\n")
}
