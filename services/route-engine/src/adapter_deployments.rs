use std::sync::OnceLock;

use crate::error::RouteError;
use crate::manifest_json::{find_array, parse_string_field, split_array_objects};
use crate::model::{ChainKey, DeploymentProfile, DestinationAdapter};

const DESTINATION_ADAPTER_DEPLOYMENTS: &str = include_str!(
    "../../../packages/xroute-precompile-interfaces/generated/destination-adapter-deployments.json"
);

static DESTINATION_ADAPTER_DEPLOYMENTS_MANIFEST: OnceLock<
    Result<DestinationAdapterDeploymentsManifest, String>,
> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DestinationAdapterDeployment<'a> {
    pub adapter_id: &'a str,
    pub chain: ChainKey,
    pub profile: DeploymentProfile,
    pub address: &'a str,
}

#[derive(Debug)]
struct DestinationAdapterDeploymentsManifest {
    deployments: Vec<GeneratedDestinationAdapterDeployment>,
}

#[derive(Debug)]
struct GeneratedDestinationAdapterDeployment {
    adapter_id: String,
    chain_key: String,
    deployment_profile: String,
    address: String,
}

pub fn lookup_destination_adapter_deployment(
    adapter: DestinationAdapter,
    chain: ChainKey,
    profile: DeploymentProfile,
) -> Result<DestinationAdapterDeployment<'static>, RouteError> {
    let adapter_id = adapter.as_str();
    let manifest = destination_adapter_deployments_manifest(adapter_id, chain, profile)?;

    if let Some(deployment) = manifest.deployments.iter().find(|deployment| {
        deployment.adapter_id == adapter_id
            && parse_chain(deployment.chain_key.as_str()) == Some(chain)
            && parse_profile(deployment.deployment_profile.as_str()) == Some(profile)
    }) {
        validate_address(adapter_id, chain, profile, deployment.address.as_str())?;
        return Ok(DestinationAdapterDeployment {
            adapter_id: deployment.adapter_id.as_str(),
            chain,
            profile,
            address: deployment.address.as_str(),
        });
    }

    Err(RouteError::MissingDestinationAdapterDeployment {
        adapter: adapter_id,
        chain,
        profile,
    })
}

fn destination_adapter_deployments_manifest(
    adapter: &'static str,
    chain: ChainKey,
    profile: DeploymentProfile,
) -> Result<&'static DestinationAdapterDeploymentsManifest, RouteError> {
    match DESTINATION_ADAPTER_DEPLOYMENTS_MANIFEST
        .get_or_init(parse_destination_adapter_deployments_manifest)
    {
        Ok(manifest) => Ok(manifest),
        Err(_) => Err(RouteError::InvalidDestinationAdapterDeployment {
            adapter,
            chain,
            profile,
        }),
    }
}

fn parse_destination_adapter_deployments_manifest(
) -> Result<DestinationAdapterDeploymentsManifest, String> {
    let deployments = find_array(DESTINATION_ADAPTER_DEPLOYMENTS, "deployments")
        .ok_or_else(|| "missing deployments array".to_owned())?;
    let deployments = split_array_objects(deployments)
        .into_iter()
        .map(parse_destination_adapter_deployment)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(DestinationAdapterDeploymentsManifest { deployments })
}

fn parse_destination_adapter_deployment(
    object: &str,
) -> Result<GeneratedDestinationAdapterDeployment, String> {
    Ok(GeneratedDestinationAdapterDeployment {
        adapter_id: parse_required_string(object, "adapterId")?,
        chain_key: parse_required_string(object, "chainKey")?,
        deployment_profile: parse_required_string(object, "deploymentProfile")?,
        address: parse_required_string(object, "address")?,
    })
}

fn parse_required_string(object: &str, key: &str) -> Result<String, String> {
    parse_string_field(object, key).ok_or_else(|| format!("missing string field: {key}"))
}

fn parse_chain(value: &str) -> Option<ChainKey> {
    match value {
        "polkadot-hub" | "asset-hub" => Some(ChainKey::PolkadotHub),
        "hydration" => Some(ChainKey::Hydration),
        _ => None,
    }
}

fn parse_profile(value: &str) -> Option<DeploymentProfile> {
    match value {
        "local" => Some(DeploymentProfile::Local),
        "testnet" => Some(DeploymentProfile::Testnet),
        "mainnet" => Some(DeploymentProfile::Mainnet),
        _ => None,
    }
}

fn validate_address(
    adapter: &'static str,
    chain: ChainKey,
    profile: DeploymentProfile,
    value: &str,
) -> Result<(), RouteError> {
    if !value.starts_with("0x") || value.len() != 42 {
        return Err(RouteError::InvalidDestinationAdapterDeployment {
            adapter,
            chain,
            profile,
        });
    }

    for byte in value.as_bytes().iter().skip(2) {
        if !matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F') {
            return Err(RouteError::InvalidDestinationAdapterDeployment {
                adapter,
                chain,
                profile,
            });
        }
    }

    Ok(())
}
