use crate::adapter_deployments::lookup_destination_adapter_deployment;
use crate::adapter_specs::lookup_destination_adapter_spec;
use crate::error::RouteError;
use crate::model::{
    AssetAmount, AssetKey, DestinationAdapter, FeeBreakdown, FeeType, Intent, IntentAction,
    PlanStep, Quote, SubmissionAction, SubmissionTerms, XcmInstruction,
};
use crate::registry::{CallRoute, RouteRegistry, StakeRoute, SwapRoute, TransferRoute};

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
            IntentAction::Stake(stake) => {
                let route = self
                    .registry
                    .stake_route(
                        intent.source_chain,
                        intent.destination_chain,
                        stake.asset,
                    )
                    .ok_or(RouteError::UnsupportedStakeRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: stake.asset,
                    })?;

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    route.xcm_fee,
                    route.destination_fee,
                )?;
                let execution_plan = build_stake_plan(&intent, route, &fees)?;

                Ok(Quote {
                    quote_id,
                    route: execution_plan.route.clone(),
                    fees,
                    expected_output: AssetAmount::new(stake.asset, stake.amount),
                    min_output: None,
                    submission: SubmissionTerms {
                        action: SubmissionAction::Stake,
                        asset: stake.asset,
                        amount: stake.amount,
                        xcm_fee: route.xcm_fee.amount,
                        destination_fee: route.destination_fee.amount,
                        min_output_amount: 0,
                    },
                    execution_plan,
                })
            }
            IntentAction::Call(call) => {
                let route = self
                    .registry
                    .call_route(
                        intent.source_chain,
                        intent.destination_chain,
                        call.asset,
                    )
                    .ok_or(RouteError::UnsupportedCallRoute {
                        source: intent.source_chain,
                        destination: intent.destination_chain,
                        asset: call.asset,
                    })?;

                let fees = self.fee_breakdown(
                    intent.principal_amount().amount,
                    route.xcm_fee,
                    route.destination_fee,
                )?;
                let execution_plan = build_call_plan(&intent, route, &fees)?;

                Ok(Quote {
                    quote_id,
                    route: execution_plan.route.clone(),
                    fees,
                    expected_output: AssetAmount::new(call.asset, 0),
                    min_output: None,
                    submission: SubmissionTerms {
                        action: SubmissionAction::Call,
                        asset: call.asset,
                        amount: call.amount,
                        xcm_fee: route.xcm_fee.amount,
                        destination_fee: route.destination_fee.amount,
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
                        XcmInstruction::Transact {
                            adapter: route.adapter,
                            target_address: destination_adapter_address(
                                route.adapter,
                                route.destination,
                            )?
                            .to_owned(),
                            contract_call: encode_swap_adapter_call(
                                route.adapter,
                                swap.asset_in,
                                swap.asset_out,
                                swap.amount_in,
                                swap.min_amount_out,
                                &swap.recipient,
                            )?,
                            fallback_weight: route.transact_weight,
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

fn build_stake_plan(
    intent: &Intent,
    route: &StakeRoute,
    fees: &FeeBreakdown,
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
                    amount: stake.amount,
                    destination: route.destination,
                    remote_instructions: vec![
                        XcmInstruction::BuyExecution {
                            asset: fees.destination_fee.asset,
                            amount: fees.destination_fee.amount,
                        },
                        XcmInstruction::Transact {
                            adapter: route.adapter,
                            target_address: destination_adapter_address(
                                route.adapter,
                                route.destination,
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
                        },
                    ],
                }],
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
    route: &CallRoute,
    fees: &FeeBreakdown,
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
                    amount: call.amount,
                    destination: route.destination,
                    remote_instructions: vec![
                        XcmInstruction::BuyExecution {
                            asset: fees.destination_fee.asset,
                            amount: fees.destination_fee.amount,
                        },
                        XcmInstruction::Transact {
                            adapter: route.adapter,
                            target_address: destination_adapter_address(
                                route.adapter,
                                route.destination,
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
                        },
                    ],
                }],
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

fn encode_swap_adapter_call(
    adapter: DestinationAdapter,
    asset_in: AssetKey,
    asset_out: AssetKey,
    amount_in: u128,
    min_amount_out: u128,
    recipient: &str,
) -> Result<String, RouteError> {
    Ok(abi_encode_call(
        destination_adapter_selector(adapter)?,
        &[
            AbiToken::Bytes32(encode_asset_id(asset_in)),
            AbiToken::Bytes32(encode_asset_id(asset_out)),
            AbiToken::Uint(amount_in),
            AbiToken::Uint(min_amount_out),
            AbiToken::Bytes(recipient.as_bytes().to_vec()),
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
) -> Result<&'static str, RouteError> {
    Ok(lookup_destination_adapter_deployment(adapter, destination)?.address)
}

#[derive(Debug, Clone)]
enum AbiToken {
    Bytes32([u8; 32]),
    Uint(u128),
    Address([u8; 20]),
    Bytes(Vec<u8>),
}

fn abi_encode_call(selector: [u8; 4], tokens: &[AbiToken]) -> String {
    let head_size = tokens.len() * 32;
    let mut encoded = Vec::with_capacity(4 + head_size + 128);
    encoded.extend_from_slice(&selector);

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

    encoded.extend_from_slice(&head);
    encoded.extend_from_slice(&tail);
    hex_encode(&encoded)
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
