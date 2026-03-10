use route_engine::DeploymentProfile;
use serde::Deserialize;
use std::fs::read_to_string;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubDeploymentArtifact {
    pub artifact_path: PathBuf,
    pub deployment_profile: DeploymentProfile,
    pub chain_key: String,
    pub chain_id: Option<u64>,
    pub deployer: Option<String>,
    pub deployed_at: Option<String>,
    pub router_address: String,
    pub xcm_address: Option<String>,
    pub executor_address: Option<String>,
    pub treasury_address: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentArtifactFile {
    deployment_profile: Option<String>,
    chain_key: Option<String>,
    chain_id: Option<u64>,
    deployer: Option<String>,
    deployed_at: Option<String>,
    contracts: DeploymentContracts,
    settings: Option<DeploymentSettings>,
}

#[derive(Debug, Deserialize)]
struct DeploymentContracts {
    #[serde(rename = "XRouteHubRouter")]
    xroute_hub_router: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentSettings {
    xcm_address: Option<String>,
    executor_address: Option<String>,
    treasury_address: Option<String>,
}

pub fn resolve_workspace_root(input: Option<&str>) -> PathBuf {
    match input.map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("shared crate must sit under services/")
            .parent()
            .expect("workspace root must exist")
            .to_path_buf(),
    }
}

pub fn get_hub_deployment_artifact_path(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
) -> PathBuf {
    workspace_root
        .join("contracts")
        .join("polkadot-hub-router")
        .join("deployments")
        .join(deployment_profile.as_str())
        .join("polkadot-hub.json")
}

pub fn load_hub_deployment_artifact(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
) -> Result<HubDeploymentArtifact, String> {
    let artifact_path = get_hub_deployment_artifact_path(workspace_root, deployment_profile);
    let raw = read_to_string(&artifact_path).map_err(|error| {
        format!(
            "failed to read deployment artifact {}: {error}",
            artifact_path.display()
        )
    })?;
    let file: DeploymentArtifactFile = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid deployment artifact: {error}"))?;
    let profile = file
        .deployment_profile
        .as_deref()
        .map(parse_deployment_profile)
        .transpose()?
        .unwrap_or(deployment_profile);

    Ok(HubDeploymentArtifact {
        artifact_path,
        deployment_profile: profile,
        chain_key: file.chain_key.unwrap_or_else(|| "polkadot-hub".to_owned()),
        chain_id: file.chain_id,
        deployer: file.deployer,
        deployed_at: file.deployed_at,
        router_address: file.contracts.xroute_hub_router,
        xcm_address: file
            .settings
            .as_ref()
            .and_then(|settings| settings.xcm_address.clone()),
        executor_address: file
            .settings
            .as_ref()
            .and_then(|settings| settings.executor_address.clone()),
        treasury_address: file
            .settings
            .as_ref()
            .and_then(|settings| settings.treasury_address.clone()),
    })
}

fn parse_deployment_profile(value: &str) -> Result<DeploymentProfile, String> {
    match value {
        "paseo" | "testnet" => Ok(DeploymentProfile::Paseo),
        "hydration-snakenet" | "hydration-testnet" => Ok(DeploymentProfile::HydrationSnakenet),
        "moonbase-alpha" | "moonbeam" | "moonbase" | "moonbeam-testnet" => {
            Ok(DeploymentProfile::MoonbaseAlpha)
        }
        "integration" | "integration-testnet" | "multihop" | "lab" | "multichain-lab" => {
            Ok(DeploymentProfile::Integration)
        }
        "mainnet" => Ok(DeploymentProfile::Mainnet),
        other => Err(format!("unsupported deployment profile: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, remove_dir_all, write};

    #[test]
    fn loads_hub_deployment_artifact() {
        let temp_root =
            std::env::temp_dir().join(format!("xroute-deployments-{}", std::process::id()));
        let artifact_path = get_hub_deployment_artifact_path(&temp_root, DeploymentProfile::Paseo);
        create_dir_all(artifact_path.parent().unwrap()).unwrap();
        write(
            &artifact_path,
            r#"{
  "deploymentProfile": "paseo",
  "chainKey": "polkadot-hub",
  "chainId": 420420,
  "deployer": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "contracts": {
    "XRouteHubRouter": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "settings": {
    "executorAddress": "0xcccccccccccccccccccccccccccccccccccccccc"
  }
}"#,
        )
        .unwrap();

        let artifact = load_hub_deployment_artifact(&temp_root, DeploymentProfile::Paseo).unwrap();
        assert_eq!(artifact.deployment_profile, DeploymentProfile::Paseo);
        assert_eq!(artifact.chain_id, Some(420420));
        assert_eq!(
            artifact.router_address,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );

        remove_dir_all(temp_root).unwrap();
    }
}
