use crate::error::RouteError;
use crate::model::DestinationAdapter;

const DESTINATION_ADAPTER_SPECS: &str =
    include_str!("../../../packages/xroute-precompile-interfaces/destination-adapter-specs.txt");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DestinationAdapterSpec<'a> {
    pub id: &'a str,
    pub target_kind: &'a str,
    pub implementation_contract: &'a str,
    pub signature: &'a str,
    pub selector: [u8; 4],
}

pub fn lookup_destination_adapter_spec(
    adapter: DestinationAdapter,
) -> Result<DestinationAdapterSpec<'static>, RouteError> {
    let adapter_id = adapter.as_str();

    for line in DESTINATION_ADAPTER_SPECS.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let mut fields = trimmed.split('|');
        let id = fields.next();
        let target_kind = fields.next();
        let implementation_contract = fields.next();
        let signature = fields.next();
        let selector = fields.next();

        if fields.next().is_some() {
            return Err(RouteError::InvalidDestinationAdapterSpec { adapter: adapter_id });
        }

        if let (
            Some(id),
            Some(target_kind),
            Some(implementation_contract),
            Some(signature),
            Some(selector),
        ) = (id, target_kind, implementation_contract, signature, selector)
        {
            if id == adapter_id {
                return Ok(DestinationAdapterSpec {
                    id,
                    target_kind,
                    implementation_contract,
                    signature,
                    selector: parse_selector(adapter_id, selector)?,
                });
            }
        } else {
            return Err(RouteError::InvalidDestinationAdapterSpec { adapter: adapter_id });
        }
    }

    Err(RouteError::MissingDestinationAdapterSpec { adapter: adapter_id })
}

fn parse_selector(adapter: &'static str, selector: &str) -> Result<[u8; 4], RouteError> {
    if !selector.starts_with("0x") || selector.len() != 10 {
        return Err(RouteError::InvalidDestinationAdapterSpec { adapter });
    }

    let bytes = selector.as_bytes();
    let mut parsed = [0u8; 4];
    let mut output_index = 0usize;
    let mut index = 2usize;
    while index < bytes.len() {
        let high = decode_nibble(bytes[index])
            .ok_or(RouteError::InvalidDestinationAdapterSpec { adapter })?;
        let low = decode_nibble(bytes[index + 1])
            .ok_or(RouteError::InvalidDestinationAdapterSpec { adapter })?;
        parsed[output_index] = (high << 4) | low;
        output_index += 1;
        index += 2;
    }

    Ok(parsed)
}

fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
