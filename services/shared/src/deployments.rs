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
    pub moonbeam_slpx_adapter_address: Option<String>,
    pub xcm_address: Option<String>,
    pub executor_address: Option<String>,
    pub treasury_address: Option<String>,
    pub moonbeam_slpx_address: Option<String>,
    pub moonbeam_xcdot_asset_address: Option<String>,
    pub moonbeam_vdot_asset_address: Option<String>,
    pub moonbeam_slpx_destination_chain_id: Option<u64>,
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
    #[serde(rename = "XRouteMoonbeamSlpxAdapter")]
    xroute_moonbeam_slpx_adapter: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentSettings {
    xcm_address: Option<String>,
    executor_address: Option<String>,
    treasury_address: Option<String>,
    moonbeam_slpx_address: Option<String>,
    moonbeam_xc_dot_asset_address: Option<String>,
    moonbeam_vdot_asset_address: Option<String>,
    moonbeam_slpx_destination_chain_id: Option<u64>,
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
    get_chain_deployment_artifact_path(workspace_root, deployment_profile, "polkadot-hub")
}

pub fn get_chain_deployment_artifact_path(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
    chain_key: &str,
) -> PathBuf {
    workspace_root
        .join("contracts")
        .join("polkadot-hub-router")
        .join("deployments")
        .join(deployment_profile.as_str())
        .join(format!("{chain_key}.json"))
}

pub fn load_hub_deployment_artifact(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
) -> Result<HubDeploymentArtifact, String> {
    load_chain_deployment_artifact(workspace_root, deployment_profile, "polkadot-hub")
}

pub fn load_chain_deployment_artifact(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
    chain_key: &str,
) -> Result<HubDeploymentArtifact, String> {
    let (artifact_path, raw) =
        read_chain_deployment_artifact(workspace_root, deployment_profile, chain_key)?;
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
        moonbeam_slpx_adapter_address: file.contracts.xroute_moonbeam_slpx_adapter,
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
        moonbeam_slpx_address: file
            .settings
            .as_ref()
            .and_then(|settings| settings.moonbeam_slpx_address.clone()),
        moonbeam_xcdot_asset_address: file
            .settings
            .as_ref()
            .and_then(|settings| settings.moonbeam_xc_dot_asset_address.clone()),
        moonbeam_vdot_asset_address: file
            .settings
            .as_ref()
            .and_then(|settings| settings.moonbeam_vdot_asset_address.clone()),
        moonbeam_slpx_destination_chain_id: file
            .settings
            .as_ref()
            .and_then(|settings| settings.moonbeam_slpx_destination_chain_id),
    })
}

fn read_chain_deployment_artifact(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
    chain_key: &str,
) -> Result<(PathBuf, String), String> {
    let mut attempted_paths = Vec::new();

    for artifact_path in deployment_artifact_candidate_paths(workspace_root, deployment_profile, chain_key) {
        attempted_paths.push(artifact_path.display().to_string());
        match read_to_string(&artifact_path) {
            Ok(raw) => return Ok((artifact_path, raw)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to read deployment artifact {}: {error}",
                    artifact_path.display()
                ))
            }
        }
    }

    Err(format!(
        "failed to read deployment artifact for {chain_key}; checked {}",
        attempted_paths.join(", ")
    ))
}

fn deployment_artifact_candidate_paths(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
    chain_key: &str,
) -> Vec<PathBuf> {
    vec![get_chain_deployment_artifact_path(
        workspace_root,
        deployment_profile,
        chain_key,
    )]
}

fn parse_deployment_profile(value: &str) -> Result<DeploymentProfile, String> {
    match value {
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
        let artifact_path =
            get_hub_deployment_artifact_path(&temp_root, DeploymentProfile::Mainnet);
        create_dir_all(artifact_path.parent().unwrap()).unwrap();
        write(
            &artifact_path,
            r#"{
  "deploymentProfile": "mainnet",
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

        let artifact =
            load_hub_deployment_artifact(&temp_root, DeploymentProfile::Mainnet).unwrap();
        assert_eq!(artifact.deployment_profile, DeploymentProfile::Mainnet);
        assert_eq!(artifact.chain_id, Some(420420));
        assert_eq!(
            artifact.router_address,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );

        remove_dir_all(temp_root).unwrap();
    }

    #[test]
    fn loads_chain_deployment_artifact_from_canonical_path() {
        let temp_root = std::env::temp_dir().join(format!(
            "xroute-deployments-chain-{}",
            std::process::id()
        ));
        let artifact_path =
            get_chain_deployment_artifact_path(&temp_root, DeploymentProfile::Mainnet, "moonbeam");
        create_dir_all(artifact_path.parent().unwrap()).unwrap();
        write(
            &artifact_path,
            r#"{
  "deploymentProfile": "mainnet",
  "chainKey": "moonbeam",
  "contracts": {
    "XRouteHubRouter": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}"#,
        )
        .unwrap();

        let artifact =
            load_chain_deployment_artifact(&temp_root, DeploymentProfile::Mainnet, "moonbeam")
                .unwrap();
        assert_eq!(artifact.deployment_profile, DeploymentProfile::Mainnet);
        assert_eq!(artifact.chain_key, "moonbeam");
        assert_eq!(
            artifact.router_address,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );

        remove_dir_all(temp_root).unwrap();
    }
}
