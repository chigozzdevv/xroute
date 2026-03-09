use crate::error::RouteError;
use crate::model::{
    ChainKey, DeploymentProfile, ExecuteIntent, ExecutionType, VtokenOrderExecuteIntent,
    VtokenOrderOperation,
};

const MOONBEAM_ETHEREUM_XCM_PALLET_MAINNET: u8 = 109;
const MOONBEAM_ETHEREUM_XCM_PALLET_TESTNET: u8 = 38;
const BIFROST_SLPX_PALLET_INDEX: u8 = 125;
const BIFROST_SLPX_MINT_CALL_INDEX: u8 = 0;
const BIFROST_SLPX_REDEEM_CALL_INDEX: u8 = 2;
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
        ExecuteIntent::VtokenOrder(intent) => {
            build_bifrost_vtoken_order_call(intent, destination_chain)
        }
    }
}

fn build_bifrost_vtoken_order_call(
    intent: &VtokenOrderExecuteIntent,
    destination_chain: ChainKey,
) -> Result<String, RouteError> {
    if destination_chain != ChainKey::Bifrost {
        return Err(RouteError::InvalidExecutionTarget {
            execution_type: ExecutionType::VtokenOrder,
            destination: destination_chain,
        });
    }

    match intent.operation {
        VtokenOrderOperation::Mint => {
            let mut encoded = vec![BIFROST_SLPX_PALLET_INDEX, BIFROST_SLPX_MINT_CALL_INDEX];
            encoded.extend([8, 0]);
            encoded.extend(intent.amount.to_le_bytes());
            encoded.push(6);
            encoded.extend(parse_h256(
                &intent.recipient_account_id_hex,
                "recipient_account_id_hex",
            )?);
            encoded.extend(encode_bytes(intent.remark.as_bytes()));
            encoded.extend(intent.channel_id.to_le_bytes());
            Ok(bytes_to_hex(&encoded))
        }
        VtokenOrderOperation::Redeem => {
            let mut encoded = vec![BIFROST_SLPX_PALLET_INDEX, BIFROST_SLPX_REDEEM_CALL_INDEX];
            encoded.push(0);
            encoded.extend([9, 0]);
            encoded.extend(intent.amount.to_le_bytes());
            encoded.push(6);
            encoded.extend(parse_h256(
                &intent.recipient_account_id_hex,
                "recipient_account_id_hex",
            )?);
            Ok(bytes_to_hex(&encoded))
        }
    }
}

fn moonbeam_ethereum_xcm_pallet_index(profile: DeploymentProfile) -> u8 {
    match profile {
        DeploymentProfile::Paseo
        | DeploymentProfile::HydrationSnakenet
        | DeploymentProfile::MoonbaseAlpha
        | DeploymentProfile::Integration => MOONBEAM_ETHEREUM_XCM_PALLET_TESTNET,
        DeploymentProfile::Mainnet => MOONBEAM_ETHEREUM_XCM_PALLET_MAINNET,
    }
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

fn parse_h256(value: &str, field: &'static str) -> Result<[u8; 32], RouteError> {
    let bytes = parse_hex_bytes(value, field)?;
    if bytes.len() != 32 {
        return Err(RouteError::InvalidBytes32 { field });
    }

    let mut result = [0u8; 32];
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
        VtokenOrderExecuteIntent, VtokenOrderOperation, XcmWeight,
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
            DeploymentProfile::Paseo,
        )
        .expect("moonbeam call should encode");

        assert!(call_data.starts_with("0x260001"));
        assert!(call_data.contains("1111111111111111111111111111111111111111"));
        assert!(call_data.ends_with("10deadbeef00"));
    }

    #[test]
    fn encodes_bifrost_vtoken_order() {
        let call_data = build_execute_call_data(
            &ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
                asset: AssetKey::Dot,
                amount: 1_000_000_000_000,
                max_payment_amount: 100_000_000,
                operation: VtokenOrderOperation::Mint,
                recipient: "5Frecipient".to_owned(),
                recipient_account_id_hex:
                    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                channel_id: 7,
                remark: "xroute".to_owned(),
                fallback_weight: XcmWeight {
                    ref_time: 600_000_000,
                    proof_size: 12_288,
                },
            }),
            ChainKey::Bifrost,
            DeploymentProfile::Paseo,
        )
        .expect("bifrost order should encode");

        assert!(call_data.starts_with("0x7d000800"));
        assert!(
            call_data.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert!(call_data.ends_with("1878726f75746507000000"));
    }

    #[test]
    fn encodes_bifrost_vtoken_redeem_order() {
        let call_data = build_execute_call_data(
            &ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
                asset: AssetKey::Vdot,
                amount: 1_000_000_000_000,
                max_payment_amount: 100_000_000,
                operation: VtokenOrderOperation::Redeem,
                recipient: "5Frecipient".to_owned(),
                recipient_account_id_hex:
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
                channel_id: 0,
                remark: String::new(),
                fallback_weight: XcmWeight {
                    ref_time: 600_000_000,
                    proof_size: 12_288,
                },
            }),
            ChainKey::Bifrost,
            DeploymentProfile::Paseo,
        )
        .expect("bifrost redeem should encode");

        assert!(call_data.starts_with("0x7d02000900"));
        assert!(
            call_data.contains("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
    }
}
