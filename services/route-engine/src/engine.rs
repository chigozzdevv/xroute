use crate::error::RouteError;
use crate::model::{
    AssetAmount, FeeBreakdown, FeeType, Intent, IntentAction, PlanStep, Quote, SubmissionAction,
    SubmissionTerms, XcmInstruction,
};
use crate::registry::{RouteRegistry, SwapRoute, TransferRoute};

#[derive(Debug, Clone, Copy)]
pub struct EngineSettings {
    pub platform_fee_bps: u16,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            platform_fee_bps: 10,
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
                let route = self
                    .registry
                    .transfer_route(
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
                    route.xcm_fee,
                    route.destination_fee,
                )?;
                let execution_plan = build_transfer_plan(&intent, route, &fees)?;

                Ok(Quote {
                    quote_id,
                    route: execution_plan.route.clone(),
                    fees,
                    expected_output: AssetAmount::new(transfer.asset, transfer.amount),
                    min_output: Some(AssetAmount::new(transfer.asset, transfer.amount)),
                    submission: SubmissionTerms {
                        action: SubmissionAction::Transfer,
                        asset: transfer.asset,
                        amount: transfer.amount,
                        xcm_fee: route.xcm_fee.amount,
                        destination_fee: route.destination_fee.amount,
                        min_output_amount: transfer.amount,
                    },
                    execution_plan,
                })
            }
            IntentAction::Swap(swap) => {
                let route = self
                    .registry
                    .swap_route(
                        intent.source_chain,
                        intent.destination_chain,
                        swap.asset_in,
                        swap.asset_out,
                    )
                    .ok_or(RouteError::UnsupportedSwapRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset_in: swap.asset_in,
                        asset_out: swap.asset_out,
                    })?;

                let expected_output = quote_swap_output(route, swap.amount_in)?;
                if swap.min_amount_out > expected_output.amount {
                    return Err(RouteError::MinOutputTooHigh {
                        requested: swap.min_amount_out,
                        expected: expected_output.amount,
                    });
                }

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    route.xcm_fee,
                    route.destination_fee,
                )?;
                let execution_plan = build_swap_plan(&intent, route, &fees)?;

                Ok(Quote {
                    quote_id,
                    route: execution_plan.route.clone(),
                    fees,
                    expected_output,
                    min_output: Some(AssetAmount::new(swap.asset_out, swap.min_amount_out)),
                    submission: SubmissionTerms {
                        action: SubmissionAction::Swap,
                        asset: swap.asset_in,
                        amount: swap.amount_in,
                        xcm_fee: route.xcm_fee.amount,
                        destination_fee: route.destination_fee.amount,
                        min_output_amount: swap.min_amount_out,
                    },
                    execution_plan,
                })
            }
            IntentAction::Stake(_) => Err(RouteError::UnsupportedAction { action: "stake" }),
            IntentAction::Call(_) => Err(RouteError::UnsupportedAction { action: "call" }),
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

fn build_transfer_plan(
    intent: &Intent,
    route: &TransferRoute,
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

    Ok(crate::model::ExecutionPlan {
        route: vec![route.source, route.destination],
        steps: vec![
            PlanStep::LockAsset {
                chain: route.source,
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
                origin: route.source,
                destination: route.destination,
                instructions: vec![XcmInstruction::TransferReserveAsset {
                    asset: route.asset,
                    amount: principal.amount,
                    destination: route.destination,
                    remote_instructions: vec![
                        XcmInstruction::BuyExecution {
                            asset: fees.destination_fee.asset,
                            amount: fees.destination_fee.amount,
                        },
                        XcmInstruction::DepositAsset {
                            asset: route.asset,
                            recipient: recipient.clone(),
                        },
                    ],
                }],
            },
            PlanStep::ExpectSettlement {
                chain: route.destination,
                asset: route.asset,
                recipient,
                minimum_amount: Some(principal.amount),
            },
        ],
    })
}

fn build_swap_plan(
    intent: &Intent,
    route: &SwapRoute,
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

    Ok(crate::model::ExecutionPlan {
        route: vec![route.source, route.destination],
        steps: vec![
            PlanStep::LockAsset {
                chain: route.source,
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
                origin: route.source,
                destination: route.destination,
                instructions: vec![XcmInstruction::TransferReserveAsset {
                    asset: route.asset_in,
                    amount: swap.amount_in,
                    destination: route.destination,
                    remote_instructions: vec![
                        XcmInstruction::BuyExecution {
                            asset: fees.destination_fee.asset,
                            amount: fees.destination_fee.amount,
                        },
                        XcmInstruction::ExchangeAsset {
                            asset_in: swap.asset_in,
                            asset_out: swap.asset_out,
                            min_amount_out: swap.min_amount_out,
                        },
                        XcmInstruction::DepositAsset {
                            asset: swap.asset_out,
                            recipient: swap.recipient.clone(),
                        },
                    ],
                }],
            },
            PlanStep::ExpectSettlement {
                chain: route.destination,
                asset: swap.asset_out,
                recipient: swap.recipient.clone(),
                minimum_amount: Some(swap.min_amount_out),
            },
        ],
    })
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
