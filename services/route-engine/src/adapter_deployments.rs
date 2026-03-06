use crate::error::RouteError;
use crate::model::{ChainKey, DestinationAdapter};

const DESTINATION_ADAPTER_DEPLOYMENTS: &str = include_str!(
    "../../../packages/xroute-precompile-interfaces/destination-adapter-deployments.txt"
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DestinationAdapterDeployment<'a> {
    pub adapter_id: &'a str,
    pub chain: ChainKey,
    pub address: &'a str,
}

pub fn lookup_destination_adapter_deployment(
    adapter: DestinationAdapter,
    chain: ChainKey,
) -> Result<DestinationAdapterDeployment<'static>, RouteError> {
    let adapter_id = adapter.as_str();

    for line in DESTINATION_ADAPTER_DEPLOYMENTS.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let mut fields = trimmed.split('|');
        let id = fields.next();
        let chain_key = fields.next();
        let address = fields.next();

        if fields.next().is_some() {
            return Err(RouteError::InvalidDestinationAdapterDeployment { adapter: adapter_id, chain });
        }

        if let (Some(id), Some(chain_key), Some(address)) = (id, chain_key, address) {
            if id == adapter_id && parse_chain(chain_key) == Some(chain) {
                validate_address(adapter_id, chain, address)?;
                return Ok(DestinationAdapterDeployment {
                    adapter_id: id,
                    chain,
                    address,
                });
            }
        } else {
            return Err(RouteError::InvalidDestinationAdapterDeployment { adapter: adapter_id, chain });
        }
    }

    Err(RouteError::MissingDestinationAdapterDeployment { adapter: adapter_id, chain })
}

fn parse_chain(value: &str) -> Option<ChainKey> {
    match value {
        "polkadot-hub" => Some(ChainKey::PolkadotHub),
        "hydration" => Some(ChainKey::Hydration),
        "asset-hub" => Some(ChainKey::AssetHub),
        _ => None,
    }
}

fn validate_address(
    adapter: &'static str,
    chain: ChainKey,
    value: &str,
) -> Result<(), RouteError> {
    if !value.starts_with("0x") || value.len() != 42 {
        return Err(RouteError::InvalidDestinationAdapterDeployment { adapter, chain });
    }

    for byte in value.as_bytes().iter().skip(2) {
        if !matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F') {
            return Err(RouteError::InvalidDestinationAdapterDeployment { adapter, chain });
        }
    }

    Ok(())
}
