use crate::adapter_deployments::lookup_destination_adapter_deployment;
use crate::adapter_specs::lookup_destination_adapter_spec;
use crate::error::RouteError;
use crate::model::{
    AssetAmount, AssetKey, ChainKey, DeploymentProfile, DestinationAdapter, FeeBreakdown, FeeType,
    Intent, IntentAction, PlanStep, Quote, RouteSegment, RouteSegmentKind, SubmissionAction,
    SubmissionTerms, XcmInstruction,
};
use crate::registry::{CallRoute, RouteRegistry, StakeRoute, SwapRoute, TransferPath};

#[derive(Debug, Clone, Copy)]
pub struct EngineSettings {
    pub platform_fee_bps: u16,
    pub deployment_profile: DeploymentProfile,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            platform_fee_bps: 10,
            deployment_profile: DeploymentProfile::Local,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RouteEngine {
    registry: RouteRegistry,
    settings: EngineSettings,
}

impl RouteEngine {
    pub fn new(registry: RouteRegistry, settings: EngineSettings) -> Self {
        Self { registry, settings }
    }

    pub fn quote(&self, intent: Intent) -> Result<Quote, RouteError> {
        let quote_id = intent.canonical_id();

        match &intent.action {
            IntentAction::Transfer(transfer) => {
                let path = self
                    .registry
                    .best_transfer_path(
                        intent.source_chain,
                        intent.destination_chain,
                        transfer.asset,
                    )
                    .ok_or(RouteError::UnsupportedTransferRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: transfer.asset,
                    })?;

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    path.xcm_fee,
                    path.destination_fee,
                )?;
                let execution_plan = build_transfer_plan(&intent, &path, &fees)?;

                Ok(Quote {
                    quote_id,
                    deployment_profile: self.settings.deployment_profile,
                    route: execution_plan.route.clone(),
                    segments: vec![route_segment(RouteSegmentKind::Execution, &path)],
                    fees,
                    estimated_settlement_fee: None,
                    expected_output: AssetAmount::new(transfer.asset, transfer.amount),
                    min_output: Some(AssetAmount::new(transfer.asset, transfer.amount)),
                    submission: SubmissionTerms {
                        action: SubmissionAction::Transfer,
                        asset: transfer.asset,
                        amount: transfer.amount,
                        xcm_fee: path.xcm_fee.amount,
                        destination_fee: path.destination_fee.amount,
                        min_output_amount: transfer.amount,
                    },
                    execution_plan,
                })
            }
            IntentAction::Swap(swap) => {
                let execution_path = self
                    .registry
                    .best_transfer_path(
                        intent.source_chain,
                        intent.destination_chain,
                        swap.asset_in,
                    )
                    .ok_or(RouteError::UnsupportedSwapRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset_in: swap.asset_in,
                        asset_out: swap.asset_out,
                    })?;
                let route = self
                    .registry
                    .swap_route(intent.destination_chain, swap.asset_in, swap.asset_out)
                    .ok_or(RouteError::UnsupportedSwapRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset_in: swap.asset_in,
                        asset_out: swap.asset_out,
                    })?;

                let settlement = build_swap_settlement(
                    &self.registry,
                    route.destination,
                    swap.asset_out,
                    swap.settlement_chain,
                    &swap.recipient,
                )?;
                let gross_output = quote_swap_output(&route, swap.amount_in)?;
                let expected_output = settlement.apply_to_output(gross_output)?;
                if swap.min_amount_out > expected_output.amount {
                    return Err(RouteError::MinOutputTooHigh {
                        requested: swap.min_amount_out,
                        expected: expected_output.amount,
                    });
                }

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    execution_path.xcm_fee,
                    execution_path.destination_fee,
                )?;
                let execution_plan = build_swap_plan(
                    &intent,
                    &execution_path,
                    &route,
                    &settlement,
                    &fees,
                    self.settings.deployment_profile,
                )?;

                Ok(Quote {
                    quote_id,
                    deployment_profile: self.settings.deployment_profile,
                    route: execution_plan.route.clone(),
                    segments: swap_segments(&execution_path, &settlement),
                    fees,
                    estimated_settlement_fee: settlement.estimated_fee,
                    expected_output,
                    min_output: Some(AssetAmount::new(swap.asset_out, swap.min_amount_out)),
                    submission: SubmissionTerms {
                        action: SubmissionAction::Swap,
                        asset: swap.asset_in,
                        amount: swap.amount_in,
                        xcm_fee: execution_path.xcm_fee.amount,
                        destination_fee: execution_path.destination_fee.amount,
                        min_output_amount: swap.min_amount_out,
                    },
                    execution_plan,
                })
            }
            IntentAction::Stake(stake) => {
                let path = self
                    .registry
                    .best_transfer_path(intent.source_chain, intent.destination_chain, stake.asset)
                    .ok_or(RouteError::UnsupportedStakeRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: stake.asset,
                    })?;
                let route = self
                    .registry
                    .stake_route(intent.destination_chain, stake.asset)
                    .ok_or(RouteError::UnsupportedStakeRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: stake.asset,
                    })?;

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    path.xcm_fee,
                    path.destination_fee,
                )?;
                let execution_plan = build_stake_plan(
                    &intent,
                    &path,
                    &route,
                    &fees,
                    self.settings.deployment_profile,
                )?;

                Ok(Quote {
                    quote_id,
                    deployment_profile: self.settings.deployment_profile,
                    route: execution_plan.route.clone(),
                    segments: vec![route_segment(RouteSegmentKind::Execution, &path)],
                    fees,
                    estimated_settlement_fee: None,
                    expected_output: AssetAmount::new(stake.asset, stake.amount),
                    min_output: None,
                    submission: SubmissionTerms {
                        action: SubmissionAction::Stake,
                        asset: stake.asset,
                        amount: stake.amount,
                        xcm_fee: path.xcm_fee.amount,
                        destination_fee: path.destination_fee.amount,
                        min_output_amount: 0,
                    },
                    execution_plan,
                })
            }
            IntentAction::Call(call) => {
                let path = self
                    .registry
                    .best_transfer_path(intent.source_chain, intent.destination_chain, call.asset)
                    .ok_or(RouteError::UnsupportedCallRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: call.asset,
                    })?;
                let route = self
                    .registry
                    .call_route(intent.destination_chain, call.asset)
                    .ok_or(RouteError::UnsupportedCallRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: call.asset,
                    })?;

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    path.xcm_fee,
                    path.destination_fee,
                )?;
                let execution_plan = build_call_plan(
                    &intent,
                    &path,
                    &route,
                    &fees,
                    self.settings.deployment_profile,
                )?;

                Ok(Quote {
                    quote_id,
                    deployment_profile: self.settings.deployment_profile,
                    route: execution_plan.route.clone(),
                    segments: vec![route_segment(RouteSegmentKind::Execution, &path)],
                    fees,
                    estimated_settlement_fee: None,
                    expected_output: AssetAmount::new(call.asset, 0),
                    min_output: None,
                    submission: SubmissionTerms {
                        action: SubmissionAction::Call,
                        asset: call.asset,
                        amount: call.amount,
                        xcm_fee: path.xcm_fee.amount,
                        destination_fee: path.destination_fee.amount,
                        min_output_amount: 0,
                    },
                    execution_plan,
                })
            }
        }
    }

    fn fee_breakdown(
        &self,
        amount: u128,
        xcm_fee: AssetAmount,
        destination_fee: AssetAmount,
    ) -> Result<FeeBreakdown, RouteError> {
        let platform_amount = percentage_fee(amount, self.settings.platform_fee_bps);
        let platform_fee = AssetAmount::new(xcm_fee.asset, platform_amount);

        let total_amount = xcm_fee
            .amount
            .checked_add(destination_fee.amount)
            .and_then(|value| value.checked_add(platform_fee.amount))
            .ok_or(RouteError::ArithmeticOverflow)?;

        Ok(FeeBreakdown {
            xcm_fee,
            destination_fee,
            platform_fee,
            total_fee: AssetAmount::new(xcm_fee.asset, total_amount),
        })
    }
}

#[derive(Debug, Clone)]
struct SwapSettlement {
    asset: AssetKey,
    mode: SwapSettlementMode,
    settlement_chain: ChainKey,
    reserve_chain: ChainKey,
    recipient: String,
    estimated_fee: Option<AssetAmount>,
    settlement_path: Option<TransferPath>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwapSettlementMode {
    LocalAccount = 0,
    DepositReserveAsset = 1,
    InitiateReserveWithdraw = 2,
}

impl SwapSettlement {
    fn apply_to_output(&self, gross_output: AssetAmount) -> Result<AssetAmount, RouteError> {
        let Some(fee) = self.estimated_fee else {
            return Ok(gross_output);
        };

        let amount = gross_output.amount.checked_sub(fee.amount).ok_or(
            RouteError::SettlementFeeExceedsOutput {
                gross_output: gross_output.amount,
                settlement_fee: fee.amount,
            },
        )?;

        Ok(AssetAmount::new(gross_output.asset, amount))
    }
}

fn build_swap_settlement(
    registry: &RouteRegistry,
    execution_chain: ChainKey,
    asset_out: AssetKey,
    settlement_chain: ChainKey,
    recipient: &str,
) -> Result<SwapSettlement, RouteError> {
    if settlement_chain == execution_chain {
        return Ok(SwapSettlement {
            asset: asset_out,
            mode: SwapSettlementMode::LocalAccount,
            settlement_chain,
            reserve_chain: asset_out.reserve_chain(),
            recipient: recipient.to_owned(),
            estimated_fee: None,
            settlement_path: None,
        });
    }

    let settlement_path = registry
        .best_transfer_path(execution_chain, settlement_chain, asset_out)
        .ok_or(RouteError::UnsupportedSettlementRoute {
            execution: execution_chain,
            settlement: settlement_chain,
            asset: asset_out,
        })?;

    let estimated_fee = AssetAmount::new(
        asset_out,
        settlement_path
            .xcm_fee
            .amount
            .saturating_add(settlement_path.destination_fee.amount),
    );
    let reserve_chain = asset_out.reserve_chain();
    let mode = if reserve_chain == execution_chain {
        SwapSettlementMode::DepositReserveAsset
    } else if reserve_chain == settlement_chain {
        SwapSettlementMode::InitiateReserveWithdraw
    } else {
        return Err(RouteError::UnsupportedSettlementRoute {
            execution: execution_chain,
            settlement: settlement_chain,
            asset: asset_out,
        });
    };

    Ok(SwapSettlement {
        asset: asset_out,
        mode,
        settlement_chain,
        reserve_chain,
        recipient: recipient.to_owned(),
        estimated_fee: Some(estimated_fee),
        settlement_path: Some(settlement_path),
    })
}

fn composed_route(
    execution_route: &[ChainKey],
    settlement_path: Option<&TransferPath>,
) -> Vec<ChainKey> {
    let mut route = execution_route.to_vec();

    if let Some(path) = settlement_path {
        route.extend(path.route.iter().copied().skip(1));
    }

    route
}

fn route_segment(kind: RouteSegmentKind, path: &TransferPath) -> RouteSegment {
    RouteSegment {
        kind,
        route: path.route.clone(),
        hops: path.hops.iter().copied().map(|hop| hop.to_route_hop()).collect(),
        xcm_fee: path.xcm_fee,
        destination_fee: path.destination_fee,
    }
}

fn swap_segments(execution_path: &TransferPath, settlement: &SwapSettlement) -> Vec<RouteSegment> {
    let mut segments = vec![route_segment(RouteSegmentKind::Execution, execution_path)];

    if let Some(path) = settlement.settlement_path.as_ref() {
        segments.push(route_segment(RouteSegmentKind::Settlement, path));
    }

    segments
}

fn build_transfer_plan(
    intent: &Intent,
    path: &TransferPath,
    fees: &FeeBreakdown,
) -> Result<crate::model::ExecutionPlan, RouteError> {
    let principal = intent.principal_amount();
    let locked = principal
        .amount
        .checked_add(fees.total_fee.amount)
        .ok_or(RouteError::ArithmeticOverflow)?;

    let recipient = match &intent.action {
        IntentAction::Transfer(transfer) => transfer.recipient.clone(),
        _ => unreachable!(),
    };
    let final_remote_instructions = vec![XcmInstruction::DepositAsset {
        asset: principal.asset,
        recipient: recipient.clone(),
    }];

    Ok(crate::model::ExecutionPlan {
        route: path.route.clone(),
        steps: vec![
            PlanStep::LockAsset {
                chain: intent.source_chain,
                asset: principal.asset,
                amount: locked,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Platform,
                asset: fees.platform_fee.asset,
                amount: fees.platform_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Xcm,
                asset: fees.xcm_fee.asset,
                amount: fees.xcm_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Destination,
                asset: fees.destination_fee.asset,
                amount: fees.destination_fee.amount,
            },
            PlanStep::SendXcm {
                origin: intent.source_chain,
                destination: *path.route.get(1).ok_or(RouteError::ArithmeticOverflow)?,
                instructions: vec![build_multihop_transfer_instruction(
                    &path.hops,
                    0,
                    principal.amount,
                    final_remote_instructions,
                )],
            },
            PlanStep::ExpectSettlement {
                chain: intent.destination_chain,
                asset: principal.asset,
                recipient,
                minimum_amount: Some(principal.amount),
            },
        ],
    })
}

fn build_swap_plan(
    intent: &Intent,
    execution_path: &TransferPath,
    route: &SwapRoute,
    settlement: &SwapSettlement,
    fees: &FeeBreakdown,
    deployment_profile: DeploymentProfile,
) -> Result<crate::model::ExecutionPlan, RouteError> {
    let principal = intent.principal_amount();
    let locked = principal
        .amount
        .checked_add(fees.total_fee.amount)
        .ok_or(RouteError::ArithmeticOverflow)?;

    let swap = match &intent.action {
        IntentAction::Swap(swap) => swap,
        _ => unreachable!(),
    };
    let final_remote_instructions = vec![XcmInstruction::Transact {
        adapter: route.adapter,
        target_address: destination_adapter_address(
            route.adapter,
            route.destination,
            deployment_profile,
        )?
        .to_owned(),
        contract_call: encode_swap_adapter_call(
            route.adapter,
            swap.asset_in,
            swap.asset_out,
            swap.amount_in,
            swap.min_amount_out,
            settlement,
        )?,
        fallback_weight: route.transact_weight,
    }];

    Ok(crate::model::ExecutionPlan {
        route: composed_route(&execution_path.route, settlement.settlement_path.as_ref()),
        steps: vec![
            PlanStep::LockAsset {
                chain: intent.source_chain,
                asset: route.asset_in,
                amount: locked,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Platform,
                asset: fees.platform_fee.asset,
                amount: fees.platform_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Xcm,
                asset: fees.xcm_fee.asset,
                amount: fees.xcm_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Destination,
                asset: fees.destination_fee.asset,
                amount: fees.destination_fee.amount,
            },
            PlanStep::SendXcm {
                origin: intent.source_chain,
                destination: *execution_path
                    .route
                    .get(1)
                    .ok_or(RouteError::ArithmeticOverflow)?,
                instructions: vec![build_multihop_transfer_instruction(
                    &execution_path.hops,
                    0,
                    swap.amount_in,
                    final_remote_instructions,
                )],
            },
            PlanStep::ExpectSettlement {
                chain: settlement.settlement_chain,
                asset: swap.asset_out,
                recipient: swap.recipient.clone(),
                minimum_amount: Some(swap.min_amount_out),
            },
        ],
    })
}

fn build_stake_plan(
    intent: &Intent,
    path: &TransferPath,
    route: &StakeRoute,
    fees: &FeeBreakdown,
    deployment_profile: DeploymentProfile,
) -> Result<crate::model::ExecutionPlan, RouteError> {
    let principal = intent.principal_amount();
    let locked = principal
        .amount
        .checked_add(fees.total_fee.amount)
        .ok_or(RouteError::ArithmeticOverflow)?;

    let stake = match &intent.action {
        IntentAction::Stake(stake) => stake,
        _ => unreachable!(),
    };
    let final_remote_instructions = vec![XcmInstruction::Transact {
        adapter: route.adapter,
        target_address: destination_adapter_address(
            route.adapter,
            route.destination,
            deployment_profile,
        )?
        .to_owned(),
        contract_call: encode_stake_adapter_call(
            route.adapter,
            stake.asset,
            stake.amount,
            &stake.validator,
            &stake.recipient,
        )?,
        fallback_weight: route.transact_weight,
    }];

    Ok(crate::model::ExecutionPlan {
        route: path.route.clone(),
        steps: vec![
            PlanStep::LockAsset {
                chain: intent.source_chain,
                asset: route.asset,
                amount: locked,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Platform,
                asset: fees.platform_fee.asset,
                amount: fees.platform_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Xcm,
                asset: fees.xcm_fee.asset,
                amount: fees.xcm_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Destination,
                asset: fees.destination_fee.asset,
                amount: fees.destination_fee.amount,
            },
            PlanStep::SendXcm {
                origin: intent.source_chain,
                destination: *path.route.get(1).ok_or(RouteError::ArithmeticOverflow)?,
                instructions: vec![build_multihop_transfer_instruction(
                    &path.hops,
                    0,
                    stake.amount,
                    final_remote_instructions,
                )],
            },
            PlanStep::ExpectSettlement {
                chain: route.destination,
                asset: stake.asset,
                recipient: stake.recipient.clone(),
                minimum_amount: None,
            },
        ],
    })
}

fn build_call_plan(
    intent: &Intent,
    path: &TransferPath,
    route: &CallRoute,
    fees: &FeeBreakdown,
    deployment_profile: DeploymentProfile,
) -> Result<crate::model::ExecutionPlan, RouteError> {
    let principal = intent.principal_amount();
    let locked = principal
        .amount
        .checked_add(fees.total_fee.amount)
        .ok_or(RouteError::ArithmeticOverflow)?;

    let call = match &intent.action {
        IntentAction::Call(call) => call,
        _ => unreachable!(),
    };
    let final_remote_instructions = vec![XcmInstruction::Transact {
        adapter: route.adapter,
        target_address: destination_adapter_address(
            route.adapter,
            route.destination,
            deployment_profile,
        )?
        .to_owned(),
        contract_call: encode_call_adapter_call(
            route.adapter,
            call.asset,
            call.amount,
            &call.target,
            &call.calldata,
        )?,
        fallback_weight: route.transact_weight,
    }];

    Ok(crate::model::ExecutionPlan {
        route: path.route.clone(),
        steps: vec![
            PlanStep::LockAsset {
                chain: intent.source_chain,
                asset: route.asset,
                amount: locked,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Platform,
                asset: fees.platform_fee.asset,
                amount: fees.platform_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Xcm,
                asset: fees.xcm_fee.asset,
                amount: fees.xcm_fee.amount,
            },
            PlanStep::ChargeFee {
                fee_type: FeeType::Destination,
                asset: fees.destination_fee.asset,
                amount: fees.destination_fee.amount,
            },
            PlanStep::SendXcm {
                origin: intent.source_chain,
                destination: *path.route.get(1).ok_or(RouteError::ArithmeticOverflow)?,
                instructions: vec![build_multihop_transfer_instruction(
                    &path.hops,
                    0,
                    call.amount,
                    final_remote_instructions,
                )],
            },
        ],
    })
}

fn build_multihop_transfer_instruction(
    hops: &[crate::registry::TransferEdge],
    index: usize,
    amount: u128,
    final_remote_instructions: Vec<XcmInstruction>,
) -> XcmInstruction {
    let hop = hops[index];
    let mut remote_instructions = vec![XcmInstruction::BuyExecution {
        asset: hop.buy_execution_fee.asset,
        amount: hop.buy_execution_fee.amount,
    }];

    if index + 1 < hops.len() {
        remote_instructions.push(build_multihop_transfer_instruction(
            hops,
            index + 1,
            amount,
            final_remote_instructions,
        ));
    } else {
        remote_instructions.extend(final_remote_instructions);
    }

    XcmInstruction::TransferReserveAsset {
        asset: hop.asset,
        amount,
        destination: hop.destination,
        remote_instructions,
    }
}

fn quote_swap_output(route: &SwapRoute, amount_in: u128) -> Result<AssetAmount, RouteError> {
    let numerator = amount_in
        .checked_mul(route.price_numerator)
        .and_then(|value| value.checked_mul(route.asset_out.one()))
        .ok_or(RouteError::ArithmeticOverflow)?;
    let denominator = route
        .price_denominator
        .checked_mul(route.asset_in.one())
        .ok_or(RouteError::ArithmeticOverflow)?;

    let gross = numerator / denominator;
    let net = gross
        .checked_mul(u128::from(10_000u16.saturating_sub(route.dex_fee_bps)))
        .ok_or(RouteError::ArithmeticOverflow)?
        / 10_000;

    Ok(AssetAmount::new(route.asset_out, net))
}

fn percentage_fee(amount: u128, bps: u16) -> u128 {
    if amount == 0 || bps == 0 {
        return 0;
    }

    let fee = amount.saturating_mul(u128::from(bps)) / 10_000;
    if fee == 0 {
        1
    } else {
        fee
    }
}

fn encode_swap_adapter_call(
    adapter: DestinationAdapter,
    asset_in: AssetKey,
    asset_out: AssetKey,
    amount_in: u128,
    min_amount_out: u128,
    settlement: &SwapSettlement,
) -> Result<String, RouteError> {
    Ok(abi_encode_call(
        destination_adapter_selector(adapter)?,
        &[
            AbiToken::Bytes32(encode_asset_id(asset_in)),
            AbiToken::Bytes32(encode_asset_id(asset_out)),
            AbiToken::Uint(amount_in),
            AbiToken::Uint(min_amount_out),
            AbiToken::Bytes(encode_swap_settlement_plan(settlement)),
        ],
    ))
}

fn encode_stake_adapter_call(
    adapter: DestinationAdapter,
    asset: AssetKey,
    amount: u128,
    validator: &str,
    recipient: &str,
) -> Result<String, RouteError> {
    Ok(abi_encode_call(
        destination_adapter_selector(adapter)?,
        &[
            AbiToken::Bytes32(encode_asset_id(asset)),
            AbiToken::Uint(amount),
            AbiToken::Bytes(validator.as_bytes().to_vec()),
            AbiToken::Bytes(recipient.as_bytes().to_vec()),
        ],
    ))
}

fn encode_call_adapter_call(
    adapter: DestinationAdapter,
    asset: AssetKey,
    amount: u128,
    target: &str,
    calldata: &str,
) -> Result<String, RouteError> {
    Ok(abi_encode_call(
        destination_adapter_selector(adapter)?,
        &[
            AbiToken::Bytes32(encode_asset_id(asset)),
            AbiToken::Uint(amount),
            AbiToken::Address(parse_evm_address("call.target", target)?),
            AbiToken::Bytes(parse_hex_bytes("call.calldata", calldata)?),
        ],
    ))
}

fn destination_adapter_selector(adapter: DestinationAdapter) -> Result<[u8; 4], RouteError> {
    Ok(lookup_destination_adapter_spec(adapter)?.selector)
}

fn destination_adapter_address(
    adapter: DestinationAdapter,
    destination: crate::model::ChainKey,
    deployment_profile: DeploymentProfile,
) -> Result<&'static str, RouteError> {
    Ok(lookup_destination_adapter_deployment(adapter, destination, deployment_profile)?.address)
}

#[derive(Debug, Clone)]
enum AbiToken {
    Bytes32([u8; 32]),
    Uint(u128),
    Address([u8; 20]),
    Bytes(Vec<u8>),
}

fn abi_encode_call(selector: [u8; 4], tokens: &[AbiToken]) -> String {
    let mut encoded = Vec::with_capacity(4 + tokens.len() * 32 + 128);
    encoded.extend_from_slice(&selector);
    encoded.extend_from_slice(&abi_encode_tokens(tokens));
    hex_encode(&encoded)
}

fn abi_encode_tokens(tokens: &[AbiToken]) -> Vec<u8> {
    let head_size = tokens.len() * 32;
    let mut head = Vec::with_capacity(head_size);
    let mut tail = Vec::new();

    for token in tokens {
        match token {
            AbiToken::Bytes32(value) => head.extend_from_slice(value),
            AbiToken::Uint(value) => head.extend_from_slice(&encode_u128_word(*value)),
            AbiToken::Address(value) => head.extend_from_slice(&encode_address_word(value)),
            AbiToken::Bytes(value) => {
                head.extend_from_slice(&encode_u128_word((head_size + tail.len()) as u128));
                tail.extend_from_slice(&encode_u128_word(value.len() as u128));
                tail.extend_from_slice(value);

                let padded_length = padded_len(value.len());
                if padded_length > value.len() {
                    tail.resize(tail.len() + padded_length - value.len(), 0);
                }
            }
        }
    }

    let mut encoded = Vec::with_capacity(head.len() + tail.len());
    encoded.extend_from_slice(&head);
    encoded.extend_from_slice(&tail);
    encoded
}

fn encode_asset_id(asset: AssetKey) -> [u8; 32] {
    let mut word = [0u8; 32];
    let symbol = asset.symbol().as_bytes();
    word[..symbol.len()].copy_from_slice(symbol);
    word
}

fn encode_u128_word(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

fn encode_address_word(value: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(value);
    word
}

fn encode_swap_settlement_plan(settlement: &SwapSettlement) -> Vec<u8> {
    let estimated_fee = settlement.estimated_fee.map(|fee| fee.amount).unwrap_or(0);

    let tokens = [
        AbiToken::Uint(settlement.mode as u128),
        AbiToken::Bytes32(encode_asset_id(settlement.asset)),
        AbiToken::Uint(u128::from(parachain_id(settlement.reserve_chain))),
        AbiToken::Uint(u128::from(parachain_id(settlement.settlement_chain))),
        AbiToken::Uint(estimated_fee),
        AbiToken::Bytes(settlement.recipient.as_bytes().to_vec()),
    ];

    abi_encode_tokens(&tokens)
}

fn parachain_id(chain: ChainKey) -> u32 {
    match chain {
        ChainKey::PolkadotHub => 1000,
        ChainKey::Hydration => 2034,
    }
}

fn parse_evm_address(field: &'static str, value: &str) -> Result<[u8; 20], RouteError> {
    let bytes = parse_hex_bytes(field, value)?;
    if bytes.len() != 20 {
        return Err(RouteError::InvalidAddress { field });
    }

    let mut address = [0u8; 20];
    address.copy_from_slice(&bytes);
    Ok(address)
}

fn parse_hex_bytes(field: &'static str, value: &str) -> Result<Vec<u8>, RouteError> {
    if !value.starts_with("0x") || value.len() % 2 != 0 {
        return Err(RouteError::InvalidHex { field });
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity((bytes.len() - 2) / 2);
    let mut index = 2usize;
    while index < bytes.len() {
        let high = decode_nibble(bytes[index]).ok_or(RouteError::InvalidHex { field })?;
        let low = decode_nibble(bytes[index + 1]).ok_or(RouteError::InvalidHex { field })?;
        decoded.push((high << 4) | low);
        index += 2;
    }

    Ok(decoded)
}

fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn padded_len(length: usize) -> usize {
    let remainder = length % 32;
    if remainder == 0 {
        length
    } else {
        length + (32 - remainder)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(2 + bytes.len() * 2);
    encoded.push_str("0x");

    for byte in bytes {
        encoded.push(hex_char(byte >> 4));
        encoded.push(hex_char(byte & 0x0f));
    }

    encoded
}

fn hex_char(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'a' + (value - 10)) as char,
        _ => unreachable!(),
    }
}
