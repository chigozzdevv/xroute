use crate::model::{AssetKey, ChainKey, ExecutionType};
use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    UnsupportedTransferRoute {
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
    },
    UnsupportedSwapRoute {
        source: ChainKey,
        destination: ChainKey,
        asset_in: AssetKey,
        asset_out: AssetKey,
    },
    UnsupportedExecuteRoute {
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
        execution_type: ExecutionType,
    },
    UnsupportedSettlementRoute {
        execution: ChainKey,
        settlement: ChainKey,
        asset: AssetKey,
    },
    ExecutionBudgetExceeded {
        requested_max: u128,
        required: u128,
    },
    MinOutputTooHigh {
        requested: u128,
        expected: u128,
    },
    SettlementFeeExceedsOutput {
        gross_output: u128,
        settlement_fee: u128,
    },
    InvalidHex {
        field: &'static str,
    },
    InvalidAddress {
        field: &'static str,
    },
    InvalidBytes32 {
        field: &'static str,
    },
    InvalidExecutionTarget {
        execution_type: ExecutionType,
        destination: ChainKey,
    },
    ArithmeticOverflow,
}

impl Display for RouteError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedTransferRoute {
                source,
                destination,
                asset,
            } => write!(
                f,
                "unsupported transfer route: {} -> {} for {}",
                source.as_str(),
                destination.as_str(),
                asset.symbol()
            ),
            Self::UnsupportedSwapRoute {
                source,
                destination,
                asset_in,
                asset_out,
            } => write!(
                f,
                "unsupported swap route: {} -> {} for {} -> {}",
                source.as_str(),
                destination.as_str(),
                asset_in.symbol(),
                asset_out.symbol()
            ),
            Self::UnsupportedExecuteRoute {
                source,
                destination,
                asset,
                execution_type,
            } => write!(
                f,
                "unsupported execute route: {} -> {} for {} on {}",
                source.as_str(),
                destination.as_str(),
                execution_type.as_str(),
                asset.symbol()
            ),
            Self::UnsupportedSettlementRoute {
                execution,
                settlement,
                asset,
            } => write!(
                f,
                "unsupported settlement route: {} -> {} for {}",
                execution.as_str(),
                settlement.as_str(),
                asset.symbol()
            ),
            Self::ExecutionBudgetExceeded {
                requested_max,
                required,
            } => write!(
                f,
                "execution budget {requested_max} is below the required payment amount {required}"
            ),
            Self::MinOutputTooHigh {
                requested,
                expected,
            } => write!(
                f,
                "requested minimum output {requested} exceeds estimated output {expected}"
            ),
            Self::SettlementFeeExceedsOutput {
                gross_output,
                settlement_fee,
            } => write!(
                f,
                "estimated settlement fee {settlement_fee} exceeds gross output {gross_output}"
            ),
            Self::InvalidHex { field } => {
                write!(f, "{field} must be a valid 0x-prefixed hex string")
            }
            Self::InvalidAddress { field } => {
                write!(f, "{field} must be a 20-byte 0x-prefixed hex address")
            }
            Self::InvalidBytes32 { field } => {
                write!(f, "{field} must be a 32-byte 0x-prefixed hex value")
            }
            Self::InvalidExecutionTarget {
                execution_type,
                destination,
            } => write!(
                f,
                "{} is not supported on {}",
                execution_type.as_str(),
                destination.as_str()
            ),
            Self::ArithmeticOverflow => write!(f, "arithmetic overflow while building quote"),
        }
    }
}

impl Error for RouteError {}
