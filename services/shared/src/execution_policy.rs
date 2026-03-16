use route_engine::{ExecutionType, Intent, IntentAction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::read_to_string;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionPolicy {
    pub moonbeam_allowed_contracts: HashMap<String, AllowedMoonbeamContract>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedMoonbeamContract {
    pub address: String,
    pub selectors: Vec<String>,
    pub max_value: Option<u128>,
    pub max_gas_limit: Option<u64>,
    pub max_payment_amount: Option<u128>,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExecutionPolicyFile {
    moonbeam: Option<MoonbeamPolicyFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoonbeamPolicyFile {
    call: Option<CallPolicyFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallPolicyFile {
    allowed_contracts: Vec<AllowedContractFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AllowedContractFile {
    address: String,
    selectors: Vec<String>,
    max_value: Option<String>,
    max_gas_limit: Option<u64>,
    max_payment_amount: Option<String>,
    note: Option<String>,
}

pub fn load_execution_policy_from_file(path: &Path) -> Result<ExecutionPolicy, String> {
    let raw = read_to_string(path).map_err(|error| {
        format!(
            "failed to read execution policy {}: {error}",
            path.display()
        )
    })?;
    let file: ExecutionPolicyFile =
        serde_json::from_str(&raw).map_err(|error| format!("invalid execution policy: {error}"))?;

    let mut allowed_contracts = HashMap::new();
    for contract in file
        .moonbeam
        .and_then(|moonbeam| moonbeam.call)
        .map(|policy| policy.allowed_contracts)
        .unwrap_or_default()
    {
        let address = normalize_address(&contract.address, "moonbeam contract address")?;
        if contract.selectors.is_empty() {
            return Err(format!(
                "moonbeam policy for {address} must declare at least one selector"
            ));
        }

        let selectors = contract
            .selectors
            .iter()
            .map(|selector| normalize_selector(selector))
            .collect::<Result<Vec<_>, _>>()?;
        allowed_contracts.insert(
            address.clone(),
            AllowedMoonbeamContract {
                address,
                selectors,
                max_value: contract
                    .max_value
                    .as_deref()
                    .map(|value| parse_u128(value, "maxValue"))
                    .transpose()?,
                max_gas_limit: contract.max_gas_limit,
                max_payment_amount: contract
                    .max_payment_amount
                    .as_deref()
                    .map(|value| parse_u128(value, "maxPaymentAmount"))
                    .transpose()?,
                note: contract.note,
            },
        );
    }

    Ok(ExecutionPolicy {
        moonbeam_allowed_contracts: allowed_contracts,
    })
}

pub fn summarize_execution_policy(policy: Option<&ExecutionPolicy>) -> Value {
    json!({
        "moonbeamEvmContracts": policy
            .map(|policy| policy.moonbeam_allowed_contracts.len())
            .unwrap_or(0),
    })
}

pub fn assert_intent_allowed_by_execution_policy(
    intent: &Intent,
    policy: Option<&ExecutionPolicy>,
) -> Result<(), String> {
    let Some(policy) = policy else {
        return Ok(());
    };

    let IntentAction::Execute(execute_intent) = &intent.action else {
        return Ok(());
    };

    if execute_intent.execution_type() != ExecutionType::Call {
        return Ok(());
    }

    let route_engine::ExecuteIntent::Call(call) = execute_intent else {
        unreachable!();
    };

    let address = normalize_address(&call.contract_address, "action.params.contractAddress")?;
    let entry = policy
        .moonbeam_allowed_contracts
        .get(&address)
        .ok_or_else(|| format!("moonbeam contract {address} is not allowlisted"))?;
    let selector = normalize_selector(
        call.calldata
            .get(..10)
            .ok_or_else(|| "action.params.calldata must contain a selector".to_owned())?,
    )?;
    if !entry
        .selectors
        .iter()
        .any(|candidate| candidate == &selector)
    {
        return Err(format!(
            "selector {selector} is not allowlisted for moonbeam contract {address}"
        ));
    }
    if let Some(max_value) = entry.max_value {
        if call.value > max_value {
            return Err(format!(
                "value {} exceeds the configured maxValue for moonbeam contract {address}",
                call.value
            ));
        }
    }
    if let Some(max_gas_limit) = entry.max_gas_limit {
        if call.gas_limit > max_gas_limit {
            return Err(format!(
                "gasLimit {} exceeds the configured maxGasLimit for moonbeam contract {address}",
                call.gas_limit
            ));
        }
    }
    if let Some(max_payment_amount) = entry.max_payment_amount {
        if call.max_payment_amount > max_payment_amount {
            return Err(format!(
                "maxPaymentAmount {} exceeds the configured maxPaymentAmount for moonbeam contract {address}",
                call.max_payment_amount
            ));
        }
    }

    Ok(())
}

fn normalize_address(value: &str, name: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if normalized.len() != 42
        || !normalized.starts_with("0x")
        || !normalized[2..].chars().all(|char| char.is_ascii_hexdigit())
    {
        return Err(format!("{name} must be a 20-byte 0x-prefixed hex address"));
    }

    Ok(normalized)
}

fn normalize_selector(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if normalized.len() != 10
        || !normalized.starts_with("0x")
        || !normalized[2..].chars().all(|char| char.is_ascii_hexdigit())
    {
        return Err("selector must be a 4-byte 0x-prefixed hex string".to_owned());
    }

    Ok(normalized)
}

fn parse_u128(value: &str, name: &str) -> Result<u128, String> {
    value
        .parse::<u128>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use route_engine::{
        CallExecuteIntent, ChainKey, ExecuteIntent, Intent, IntentAction, XcmWeight,
    };
    use std::fs::{remove_file, write};

    #[test]
    fn validates_allowlisted_moonbeam_contracts() {
        let path = std::env::temp_dir().join(format!("xroute-policy-{}.json", std::process::id()));
        write(
            &path,
            r#"{
  "moonbeam": {
    "call": {
      "allowedContracts": [
        {
          "address": "0x2222222222222222222222222222222222222222",
          "selectors": ["0xdeadbeef"],
          "maxValue": "0",
          "maxGasLimit": 200000,
          "maxPaymentAmount": "100000000"
        }
      ]
    }
  }
}"#,
        )
        .unwrap();
        let policy = load_execution_policy_from_file(&path).unwrap();
        let intent = Intent {
            source_chain: ChainKey::PolkadotHub,
            destination_chain: ChainKey::Moonbeam,
            refund_address: "0x1111111111111111111111111111111111111111".to_owned(),
            deadline: 1_773_185_200,
            action: IntentAction::Execute(ExecuteIntent::Call(CallExecuteIntent {
                asset: route_engine::AssetKey::Dot,
                max_payment_amount: 100_000_000,
                contract_address: "0x2222222222222222222222222222222222222222".to_owned(),
                calldata: "0xdeadbeef00000000".to_owned(),
                value: 0,
                gas_limit: 200_000,
                fallback_weight: XcmWeight {
                    ref_time: 650_000_000,
                    proof_size: 12_288,
                },
            })),
        };

        assert!(assert_intent_allowed_by_execution_policy(&intent, Some(&policy)).is_ok());
        remove_file(path).unwrap();
    }
}
