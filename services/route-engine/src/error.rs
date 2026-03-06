use crate::model::{AssetKey, ChainKey};
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
    UnsupportedAction {
        action: &'static str,
    },
    MinOutputTooHigh {
        requested: u128,
        expected: u128,
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
            Self::UnsupportedAction { action } => {
                write!(f, "unsupported action: {action}")
            }
            Self::MinOutputTooHigh {
                requested,
                expected,
            } => write!(
                f,
                "requested minimum output {requested} exceeds estimated output {expected}"
            ),
            Self::InvalidHex { field } => write!(f, "{field} must be a valid 0x-prefixed hex string"),
            Self::InvalidAddress { field } => write!(f, "{field} must be a 20-byte 0x-prefixed hex address"),
            Self::ArithmeticOverflow => write!(f, "arithmetic overflow while building quote"),
        }
    }
}

impl Error for RouteError {}
