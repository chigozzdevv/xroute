use crate::destination_calls::build_execute_call_data;
use crate::error::RouteError;
use crate::model::{
    AssetAmount, AssetKey, ChainKey, DeploymentProfile, ExecuteIntent, ExecutionType, FeeBreakdown,
    FeeType, Intent, IntentAction, PlanStep, Quote, RouteSegment, RouteSegmentKind,
    RuntimeCallOriginKind, SubmissionAction, SubmissionTerms, XcmInstruction,
};
use crate::registry::{RouteRegistry, SwapRoute, TransferPath};

#[derive(Debug, Clone, Copy)]
pub struct EngineSettings {
    pub platform_fee_bps: u16,
    pub deployment_profile: DeploymentProfile,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            platform_fee_bps: 10,
            deployment_profile: DeploymentProfile::Mainnet,
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
                let execution_plan =
                    build_swap_plan(&intent, &execution_path, &route, &settlement, &fees)?;

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
            IntentAction::Execute(execute) => {
                if !self.registry.supports_execute(
                    intent.destination_chain,
                    execute.asset(),
                    execute.execution_type(),
                ) {
                    return Err(RouteError::UnsupportedExecuteRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: execute.asset(),
                        execution_type: execute.execution_type(),
                    });
                }

                let path = self
                    .registry
                    .best_transfer_path(
                        intent.source_chain,
                        intent.destination_chain,
                        execute.asset(),
                    )
                    .ok_or(RouteError::UnsupportedExecuteRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: execute.asset(),
                        execution_type: execute.execution_type(),
                    })?;
                let execution_budget = self
                    .registry
                    .execute_budget(
                        intent.destination_chain,
                        execute.asset(),
                        execute.execution_type(),
                    )
                    .unwrap_or(path.destination_fee)
                    .amount;
                if execution_budget > execute.max_payment_amount() {
                    return Err(RouteError::ExecutionBudgetExceeded {
                        requested_max: execute.max_payment_amount(),
                        required: execution_budget,
                    });
                }
                let submission_amount = execute.submission_amount(execution_budget);
                let destination_fee_amount = execute.destination_fee_amount(execution_budget);

                let fees = self.fee_breakdown(
                    submission_amount,
                    path.xcm_fee,
                    AssetAmount::new(execute.asset(), destination_fee_amount),
                )?;
                let execution_plan = build_execute_plan(
                    &intent,
                    &path,
                    execute,
                    &fees,
                    self.settings.deployment_profile,
                )?;
                let expected_output = match execute {
                    ExecuteIntent::MintVdot(order) => self
                        .registry
                        .quote_vdot_order(ExecutionType::MintVdot, order.amount)
                        .ok_or(RouteError::UnsupportedExecuteRoute {
                            source: intent.source_chain,
                            destination: intent.destination_chain,
                            asset: execute.asset(),
                            execution_type: execute.execution_type(),
                        })?,
                    ExecuteIntent::RedeemVdot(order) => self
                        .registry
                        .quote_vdot_order(ExecutionType::RedeemVdot, order.amount)
                        .ok_or(RouteError::UnsupportedExecuteRoute {
                            source: intent.source_chain,
                            destination: intent.destination_chain,
                            asset: execute.asset(),
                            execution_type: execute.execution_type(),
                        })?,
                    ExecuteIntent::Call(_) => execute.expected_output(),
                };

                Ok(Quote {
                    quote_id,
                    deployment_profile: self.settings.deployment_profile,
                    route: execution_plan.route.clone(),
                    segments: vec![route_segment(RouteSegmentKind::Execution, &path)],
                    fees,
                    estimated_settlement_fee: None,
                    expected_output,
                    min_output: None,
                    submission: SubmissionTerms {
                        action: SubmissionAction::Execute,
                        asset: execute.asset(),
                        amount: submission_amount,
                        xcm_fee: path.xcm_fee.amount,
                        destination_fee: destination_fee_amount,
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
        hops: path
            .hops
            .iter()
            .copied()
            .map(|hop| hop.to_route_hop())
            .collect(),
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
        asset_count: 1,
    }];
    let send_instructions = build_multihop_transfer_instructions(
        intent.source_chain,
        path,
        principal.amount,
        final_remote_instructions,
    )?;

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
                instructions: send_instructions,
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

fn build_execute_plan(
    intent: &Intent,
    path: &TransferPath,
    execute: &ExecuteIntent,
    fees: &FeeBreakdown,
    deployment_profile: DeploymentProfile,
) -> Result<crate::model::ExecutionPlan, RouteError> {
    let execution_budget = path.destination_fee.amount;
    let submission_amount = execute.submission_amount(execution_budget);
    let transfer_amount = execute.transfer_amount(execution_budget);
    let locked = submission_amount
        .checked_add(fees.total_fee.amount)
        .ok_or(RouteError::ArithmeticOverflow)?;
    let final_remote_instructions =
        build_execute_remote_instructions(execute, intent.destination_chain, deployment_profile)?;
    let send_instructions = build_multihop_transfer_instructions(
        intent.source_chain,
        path,
        transfer_amount,
        final_remote_instructions,
    )?;

    Ok(crate::model::ExecutionPlan {
        route: path.route.clone(),
        steps: vec![
            PlanStep::LockAsset {
                chain: intent.source_chain,
                asset: execute.asset(),
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
                asset: execute.asset(),
                amount: fees.destination_fee.amount,
            },
            PlanStep::SendXcm {
                origin: intent.source_chain,
                destination: *path.route.get(1).ok_or(RouteError::ArithmeticOverflow)?,
                instructions: send_instructions,
            },
        ],
    })
}

fn build_execute_remote_instructions(
    execute: &ExecuteIntent,
    destination_chain: ChainKey,
    deployment_profile: DeploymentProfile,
) -> Result<Vec<XcmInstruction>, RouteError> {
    let transact = XcmInstruction::Transact {
        origin_kind: RuntimeCallOriginKind::SovereignAccount,
        fallback_weight: execute.fallback_weight(),
        call_data: build_execute_call_data(execute, destination_chain, deployment_profile)?,
    };

    Ok(match execute {
        ExecuteIntent::Call(_) => vec![transact],
        ExecuteIntent::MintVdot(intent) | ExecuteIntent::RedeemVdot(intent) => vec![
            XcmInstruction::DepositAsset {
                asset: execute.asset(),
                recipient: intent.adapter_address.clone(),
                asset_count: 1,
            },
            transact,
        ],
    })
}

fn build_swap_plan(
    intent: &Intent,
    execution_path: &TransferPath,
    route: &SwapRoute,
    settlement: &SwapSettlement,
    fees: &FeeBreakdown,
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
    let final_remote_instructions = build_swap_remote_instructions(route, swap, settlement)?;

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
                instructions: build_multihop_transfer_instructions(
                    intent.source_chain,
                    execution_path,
                    swap.amount_in,
                    final_remote_instructions,
                )?,
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

fn build_swap_remote_instructions(
    route: &SwapRoute,
    swap: &crate::model::SwapIntent,
    settlement: &SwapSettlement,
) -> Result<Vec<XcmInstruction>, RouteError> {
    let mut instructions = vec![XcmInstruction::ExchangeAsset {
        asset_in: route.asset_in,
        amount_in: swap.amount_in,
        asset_out: route.asset_out,
        min_amount_out: swap.min_amount_out,
        maximal: true,
    }];

    instructions.extend(build_swap_settlement_instructions(settlement)?);
    Ok(instructions)
}

fn build_swap_settlement_instructions(
    settlement: &SwapSettlement,
) -> Result<Vec<XcmInstruction>, RouteError> {
    const SWAP_OUTPUT_ASSET_COUNT: u32 = 2;

    let Some(settlement_path) = settlement.settlement_path.as_ref() else {
        return Ok(vec![XcmInstruction::DepositAsset {
            asset: settlement.asset,
            recipient: settlement.recipient.clone(),
            asset_count: SWAP_OUTPUT_ASSET_COUNT,
        }]);
    };

    let destination_hop = settlement_path
        .hops
        .first()
        .ok_or(RouteError::ArithmeticOverflow)?;
    let final_delivery = XcmInstruction::DepositAsset {
        asset: settlement.asset,
        recipient: settlement.recipient.clone(),
        asset_count: SWAP_OUTPUT_ASSET_COUNT,
    };

    let settlement_remote_instructions = vec![
        XcmInstruction::BuyExecution {
            asset: destination_hop.buy_execution_fee.asset,
            amount: destination_hop.buy_execution_fee.amount,
        },
        final_delivery,
    ];

    let instruction = match settlement.mode {
        SwapSettlementMode::LocalAccount => unreachable!(),
        SwapSettlementMode::DepositReserveAsset => XcmInstruction::DepositReserveAsset {
            asset_count: SWAP_OUTPUT_ASSET_COUNT,
            destination: settlement.settlement_chain,
            remote_instructions: settlement_remote_instructions,
        },
        SwapSettlementMode::InitiateReserveWithdraw => XcmInstruction::InitiateReserveWithdraw {
            asset_count: SWAP_OUTPUT_ASSET_COUNT,
            reserve: settlement.reserve_chain,
            remote_instructions: settlement_remote_instructions,
        },
    };

    Ok(vec![instruction])
}

fn build_multihop_transfer_instructions(
    source_chain: ChainKey,
    path: &TransferPath,
    amount: u128,
    final_remote_instructions: Vec<XcmInstruction>,
) -> Result<Vec<XcmInstruction>, RouteError> {
    let Some(first_hop) = path.hops.first() else {
        return Err(RouteError::ArithmeticOverflow);
    };
    let reserve_chain = effective_source_reserve_chain(source_chain, first_hop.asset);

    if source_chain == reserve_chain {
        return Ok(vec![build_legacy_multihop_transfer_instruction(
            &path.hops,
            0,
            amount,
            final_remote_instructions,
        )]);
    }

    if path.hops.len() <= 2
        && (path.route.get(1).copied() == Some(reserve_chain)
            || reserve_chain == ChainKey::PolkadotRelay)
    {
        return build_reserve_withdraw_transfer_instructions(
            &path.hops,
            reserve_chain,
            amount,
            final_remote_instructions,
        );
    }

    Ok(vec![build_legacy_multihop_transfer_instruction(
        &path.hops,
        0,
        amount,
        final_remote_instructions,
    )])
}

fn build_reserve_withdraw_transfer_instructions(
    hops: &[crate::registry::TransferEdge],
    reserve_chain: ChainKey,
    amount: u128,
    final_remote_instructions: Vec<XcmInstruction>,
) -> Result<Vec<XcmInstruction>, RouteError> {
    let Some(first_hop) = hops.first() else {
        return Err(RouteError::ArithmeticOverflow);
    };
    let mut reserve_remote_instructions = vec![XcmInstruction::BuyExecution {
        asset: first_hop.buy_execution_fee.asset,
        amount: first_hop.buy_execution_fee.amount,
    }];

    if hops.len() == 1 {
        if first_hop.destination == reserve_chain {
            reserve_remote_instructions.extend(final_remote_instructions);
        } else {
            reserve_remote_instructions.push(build_deposit_reserve_instruction(
                hops,
                0,
                amount,
                final_remote_instructions,
            )?);
        }
    } else {
        reserve_remote_instructions.push(build_deposit_reserve_instruction(
            &hops[1..],
            0,
            amount,
            final_remote_instructions,
        )?);
    }

    Ok(vec![
        XcmInstruction::WithdrawAsset {
            asset: first_hop.asset,
            amount,
        },
        XcmInstruction::InitiateReserveWithdraw {
            asset_count: 1,
            reserve: reserve_chain,
            remote_instructions: reserve_remote_instructions,
        },
    ])
}

fn build_deposit_reserve_instruction(
    hops: &[crate::registry::TransferEdge],
    index: usize,
    amount: u128,
    final_remote_instructions: Vec<XcmInstruction>,
) -> Result<XcmInstruction, RouteError> {
    let hop = hops[index];
    let mut remote_instructions = vec![XcmInstruction::BuyExecution {
        asset: hop.buy_execution_fee.asset,
        amount: hop.buy_execution_fee.amount,
    }];

    if index + 1 < hops.len() {
        remote_instructions.push(build_legacy_multihop_transfer_instruction(
            hops,
            index + 1,
            amount,
            final_remote_instructions,
        ));
    } else {
        remote_instructions.extend(final_remote_instructions);
    }

    Ok(XcmInstruction::DepositReserveAsset {
        asset_count: 1,
        destination: hop.destination,
        remote_instructions,
    })
}

fn build_legacy_multihop_transfer_instruction(
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
        remote_instructions.push(build_legacy_multihop_transfer_instruction(
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

fn effective_source_reserve_chain(source_chain: ChainKey, asset: AssetKey) -> ChainKey {
    if asset == AssetKey::Dot
        && source_chain != ChainKey::PolkadotHub
        && source_chain != ChainKey::PolkadotRelay
    {
        return ChainKey::PolkadotRelay;
    }

    asset.reserve_chain()
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
