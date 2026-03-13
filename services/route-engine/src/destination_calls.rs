use crate::error::RouteError;
use crate::model::{ChainKey, DeploymentProfile, ExecuteIntent, ExecutionType};

const MOONBEAM_ETHEREUM_XCM_PALLET_MAINNET: u8 = 109;
const MOONBEAM_ETHEREUM_XCM_TRANSACT_CALL_INDEX: u8 = 0;
const MINT_VDOT_SELECTOR: [u8; 4] = [0x58, 0x41, 0x9d, 0xbb];
const REDEEM_VDOT_SELECTOR: [u8; 4] = [0xc8, 0xda, 0xc3, 0xf0];

pub fn build_execute_call_data(
    execute: &ExecuteIntent,
    destination_chain: ChainKey,
    deployment_profile: DeploymentProfile,
) -> Result<String, RouteError> {
    match execute {
        ExecuteIntent::Call(intent) => {
            if destination_chain != ChainKey::Moonbeam {
                return Err(RouteError::InvalidExecutionTarget {
                    execution_type: ExecutionType::Call,
                    destination: destination_chain,
                });
            }

            encode_moonbeam_call(
                deployment_profile,
                &intent.contract_address,
                intent.gas_limit,
                intent.value,
                parse_hex_bytes(&intent.calldata, "calldata")?,
            )
        }
        ExecuteIntent::MintVdot(intent) => {
            if destination_chain != ChainKey::Moonbeam {
                return Err(RouteError::InvalidExecutionTarget {
                    execution_type: ExecutionType::MintVdot,
                    destination: destination_chain,
                });
            }

            encode_moonbeam_call(
                deployment_profile,
                &intent.adapter_address,
                intent.gas_limit,
                0,
                encode_vdot_order_call(MINT_VDOT_SELECTOR, intent, "recipient")?,
            )
        }
        ExecuteIntent::RedeemVdot(intent) => {
            if destination_chain != ChainKey::Moonbeam {
                return Err(RouteError::InvalidExecutionTarget {
                    execution_type: ExecutionType::RedeemVdot,
                    destination: destination_chain,
                });
            }

            encode_moonbeam_call(
                deployment_profile,
                &intent.adapter_address,
                intent.gas_limit,
                0,
                encode_vdot_order_call(REDEEM_VDOT_SELECTOR, intent, "recipient")?,
            )
        }
    }
}

fn encode_moonbeam_call(
    deployment_profile: DeploymentProfile,
    contract_address: &str,
    gas_limit: u64,
    value: u128,
    calldata: Vec<u8>,
) -> Result<String, RouteError> {
    let mut encoded = vec![
        moonbeam_ethereum_xcm_pallet_index(deployment_profile),
        MOONBEAM_ETHEREUM_XCM_TRANSACT_CALL_INDEX,
        1,
    ];
    encoded.extend(encode_u256(u128::from(gas_limit)));
    encoded.push(0);
    encoded.extend(parse_h160(contract_address, "contract_address")?);
    encoded.extend(encode_u256(value));
    encoded.extend(encode_bytes(&calldata));
    encoded.push(0);

    Ok(bytes_to_hex(&encoded))
}

fn encode_vdot_order_call(
    selector: [u8; 4],
    intent: &crate::model::VdotOrderExecuteIntent,
    recipient_field: &'static str,
) -> Result<Vec<u8>, RouteError> {
    let remark = intent.remark.as_bytes();
    let mut encoded = Vec::with_capacity(4 + (32 * 6));
    encoded.extend(selector);
    encoded.extend(encode_abi_u256(intent.amount));
    encoded.extend(encode_address_word(&parse_h160(&intent.recipient, recipient_field)?));
    encoded.extend(encode_abi_u256(128));
    encoded.extend(encode_abi_u256(u128::from(intent.channel_id)));
    encoded.extend(encode_abi_u256(remark.len() as u128));
    encoded.extend(pad_right(remark));
    Ok(encoded)
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

fn encode_address_word(value: &[u8; 20]) -> [u8; 32] {
    let mut encoded = [0u8; 32];
    encoded[12..].copy_from_slice(value);
    encoded
}

fn encode_abi_u256(value: u128) -> [u8; 32] {
    let mut encoded = [0u8; 32];
    encoded[16..].copy_from_slice(&value.to_be_bytes());
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

fn pad_right(value: &[u8]) -> Vec<u8> {
    let mut encoded = value.to_vec();
    let remainder = encoded.len() % 32;
    if remainder != 0 {
        encoded.resize(encoded.len() + (32 - remainder), 0);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::build_execute_call_data;
    use crate::model::{
        AssetKey, CallExecuteIntent, ChainKey, DeploymentProfile, ExecuteIntent,
        VdotOrderExecuteIntent, XcmWeight,
    };

    #[test]
    fn encodes_moonbeam_evm_contract_call() {
        let call_data = build_execute_call_data(
            &ExecuteIntent::Call(CallExecuteIntent {
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

    #[test]
    fn encodes_moonbeam_mint_vdot_order_call() {
        let call_data = build_execute_call_data(
            &ExecuteIntent::MintVdot(VdotOrderExecuteIntent {
                amount: 10_000_000_000,
                max_payment_amount: 110_000_000,
                recipient: "0x1111111111111111111111111111111111111111".to_owned(),
                adapter_address: "0x2222222222222222222222222222222222222222".to_owned(),
                gas_limit: 500_000,
                fallback_weight: XcmWeight {
                    ref_time: 650_000_000,
                    proof_size: 12_288,
                },
                remark: "xroute".to_owned(),
                channel_id: 0,
            }),
            ChainKey::Moonbeam,
            DeploymentProfile::Mainnet,
        )
        .expect("moonbeam mint-vdot should encode");

        assert!(call_data.starts_with("0x6d0001"));
        assert!(call_data.contains("2222222222222222222222222222222222222222"));
        assert!(call_data.contains("58419dbb"));
    }
}
