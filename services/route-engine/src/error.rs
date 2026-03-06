use crate::model::{AssetKey, ChainKey, DeploymentProfile};
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
    UnsupportedStakeRoute {
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
    },
    UnsupportedCallRoute {
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
    },
    UnsupportedSettlementRoute {
        execution: ChainKey,
        settlement: ChainKey,
        asset: AssetKey,
    },
    UnsupportedAction {
        action: &'static str,
    },
    MissingDestinationAdapterSpec {
        adapter: &'static str,
    },
    InvalidDestinationAdapterSpec {
        adapter: &'static str,
    },
    MissingDestinationAdapterDeployment {
        adapter: &'static str,
        chain: ChainKey,
        profile: DeploymentProfile,
    },
    InvalidDestinationAdapterDeployment {
        adapter: &'static str,
        chain: ChainKey,
        profile: DeploymentProfile,
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
            Self::UnsupportedStakeRoute {
                source,
                destination,
                asset,
            } => write!(
                f,
                "unsupported stake route: {} -> {} for {}",
                source.as_str(),
                destination.as_str(),
                asset.symbol()
            ),
            Self::UnsupportedCallRoute {
                source,
                destination,
                asset,
            } => write!(
                f,
                "unsupported call route: {} -> {} for {}",
                source.as_str(),
                destination.as_str(),
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
            Self::UnsupportedAction { action } => {
                write!(f, "unsupported action: {action}")
            }
            Self::MissingDestinationAdapterSpec { adapter } => {
                write!(f, "missing destination adapter spec for {adapter}")
            }
            Self::InvalidDestinationAdapterSpec { adapter } => {
                write!(f, "invalid destination adapter spec for {adapter}")
            }
            Self::MissingDestinationAdapterDeployment {
                adapter,
                chain,
                profile,
            } => write!(
                f,
                "missing destination adapter deployment for {} on {} ({})",
                adapter,
                chain.as_str(),
                profile.as_str()
            ),
            Self::InvalidDestinationAdapterDeployment {
                adapter,
                chain,
                profile,
            } => write!(
                f,
                "invalid destination adapter deployment for {} on {} ({})",
                adapter,
                chain.as_str(),
                profile.as_str()
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
            Self::ArithmeticOverflow => write!(f, "arithmetic overflow while building quote"),
        }
    }
}

impl Error for RouteError {}
