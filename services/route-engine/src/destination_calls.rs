use crate::error::RouteError;
use crate::model::{ChainKey, DeploymentProfile, ExecuteIntent, ExecutionType};

const MOONBEAM_ETHEREUM_XCM_PALLET_MAINNET: u8 = 109;
const MOONBEAM_ETHEREUM_XCM_TRANSACT_CALL_INDEX: u8 = 0;

pub fn build_execute_call_data(
    execute: &ExecuteIntent,
    destination_chain: ChainKey,
    deployment_profile: DeploymentProfile,
) -> Result<String, RouteError> {
    match execute {
        ExecuteIntent::RuntimeCall(intent) => Ok(intent.call_data.clone()),
        ExecuteIntent::EvmContractCall(intent) => {
            if destination_chain != ChainKey::Moonbeam {
                return Err(RouteError::InvalidExecutionTarget {
                    execution_type: ExecutionType::EvmContractCall,
                    destination: destination_chain,
                });
            }

            let mut encoded = vec![
                moonbeam_ethereum_xcm_pallet_index(deployment_profile),
                MOONBEAM_ETHEREUM_XCM_TRANSACT_CALL_INDEX,
                1,
            ];
            encoded.extend(encode_u256(u128::from(intent.gas_limit)));
            encoded.push(0);
            encoded.extend(parse_h160(&intent.contract_address, "contract_address")?);
            encoded.extend(encode_u256(intent.value));
            encoded.extend(encode_bytes(&parse_hex_bytes(
                &intent.calldata,
                "calldata",
            )?));
            encoded.push(0);

            Ok(bytes_to_hex(&encoded))
        }
    }
}

fn moonbeam_ethereum_xcm_pallet_index(profile: DeploymentProfile) -> u8 {
    let _ = profile;
    MOONBEAM_ETHEREUM_XCM_PALLET_MAINNET
}

fn parse_hex_bytes(value: &str, field: &'static str) -> Result<Vec<u8>, RouteError> {
    let normalized = value.trim();
    if !normalized.starts_with("0x") || normalized.len() % 2 != 0 {
        return Err(RouteError::InvalidHex { field });
    }

    (2..normalized.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&normalized[index..index + 2], 16)
                .map_err(|_| RouteError::InvalidHex { field })
        })
        .collect()
}

fn parse_h160(value: &str, field: &'static str) -> Result<[u8; 20], RouteError> {
    let bytes = parse_hex_bytes(value, field)?;
    if bytes.len() != 20 {
        return Err(RouteError::InvalidAddress { field });
    }

    let mut result = [0u8; 20];
    result.copy_from_slice(&bytes);
    Ok(result)
}

fn encode_u256(value: u128) -> [u8; 32] {
    let mut encoded = [0u8; 32];
    encoded[..16].copy_from_slice(&value.to_le_bytes());
    encoded
}

fn encode_bytes(value: &[u8]) -> Vec<u8> {
    let mut encoded = encode_compact(value.len() as u128);
    encoded.extend(value);
    encoded
}

fn encode_compact(value: u128) -> Vec<u8> {
    if value < 1 << 6 {
        return vec![(value as u8) << 2];
    }

    if value < 1 << 14 {
        let encoded = ((value as u16) << 2) | 0b01;
        return encoded.to_le_bytes().to_vec();
    }

    if value < 1 << 30 {
        let encoded = ((value as u32) << 2) | 0b10;
        return encoded.to_le_bytes().to_vec();
    }

    let mut bytes = value.to_le_bytes().to_vec();
    while bytes.last() == Some(&0) {
        bytes.pop();
    }
    let mut encoded = vec![(((bytes.len() - 4) as u8) << 2) | 0b11];
    encoded.extend(bytes);
    encoded
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity((bytes.len() * 2) + 2);
    hex.push_str("0x");

    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }

    hex
}

#[cfg(test)]
mod tests {
    use super::build_execute_call_data;
    use crate::model::{
        AssetKey, ChainKey, DeploymentProfile, EvmContractCallExecuteIntent, ExecuteIntent,
        XcmWeight,
    };

    #[test]
    fn encodes_moonbeam_evm_contract_call() {
        let call_data = build_execute_call_data(
            &ExecuteIntent::EvmContractCall(EvmContractCallExecuteIntent {
                asset: AssetKey::Dot,
                max_payment_amount: 110_000_000,
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                calldata: "0xdeadbeef".to_owned(),
                value: 0,
                gas_limit: 250_000,
                fallback_weight: XcmWeight {
                    ref_time: 500_000_000,
                    proof_size: 8_192,
                },
            }),
            ChainKey::Moonbeam,
            DeploymentProfile::Mainnet,
        )
        .expect("moonbeam call should encode");

        assert!(call_data.starts_with("0x6d0001"));
        assert!(call_data.contains("1111111111111111111111111111111111111111"));
        assert!(call_data.ends_with("10deadbeef00"));
    }
}
