use std::sync::OnceLock;

use crate::error::RouteError;
use crate::manifest_json::{find_array, parse_string_field, split_array_objects};
use crate::model::DestinationAdapter;

const DESTINATION_ADAPTER_SPECS: &str = include_str!(
    "../../../packages/xroute-precompile-interfaces/generated/destination-adapter-specs.json"
);

static DESTINATION_ADAPTER_SPECS_MANIFEST: OnceLock<
    Result<DestinationAdapterSpecsManifest, String>,
> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DestinationAdapterSpec<'a> {
    pub id: &'a str,
    pub target_kind: &'a str,
    pub implementation_contract: &'a str,
    pub signature: &'a str,
    pub selector: [u8; 4],
}

#[derive(Debug)]
struct DestinationAdapterSpecsManifest {
    adapters: Vec<GeneratedDestinationAdapterSpec>,
}

#[derive(Debug)]
struct GeneratedDestinationAdapterSpec {
    id: String,
    target_kind: String,
    implementation_contract: String,
    signature: String,
    selector: String,
}

pub fn lookup_destination_adapter_spec(
    adapter: DestinationAdapter,
) -> Result<DestinationAdapterSpec<'static>, RouteError> {
    let adapter_id = adapter.as_str();
    let manifest = destination_adapter_specs_manifest(adapter_id)?;

    if let Some(spec) = manifest.adapters.iter().find(|spec| spec.id == adapter_id) {
        return Ok(DestinationAdapterSpec {
            id: spec.id.as_str(),
            target_kind: spec.target_kind.as_str(),
            implementation_contract: spec.implementation_contract.as_str(),
            signature: spec.signature.as_str(),
            selector: parse_selector(adapter_id, spec.selector.as_str())?,
        });
    }

    Err(RouteError::MissingDestinationAdapterSpec {
        adapter: adapter_id,
    })
}

fn destination_adapter_specs_manifest(
    adapter: &'static str,
) -> Result<&'static DestinationAdapterSpecsManifest, RouteError> {
    match DESTINATION_ADAPTER_SPECS_MANIFEST.get_or_init(parse_destination_adapter_specs_manifest) {
        Ok(manifest) => Ok(manifest),
        Err(_) => Err(RouteError::InvalidDestinationAdapterSpec { adapter }),
    }
}

fn parse_destination_adapter_specs_manifest() -> Result<DestinationAdapterSpecsManifest, String> {
    let adapters = find_array(DESTINATION_ADAPTER_SPECS, "adapters")
        .ok_or_else(|| "missing adapters array".to_owned())?;
    let adapters = split_array_objects(adapters)
        .into_iter()
        .map(parse_destination_adapter_spec)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(DestinationAdapterSpecsManifest { adapters })
}

fn parse_destination_adapter_spec(object: &str) -> Result<GeneratedDestinationAdapterSpec, String> {
    Ok(GeneratedDestinationAdapterSpec {
        id: parse_required_string(object, "id")?,
        target_kind: parse_required_string(object, "targetKind")?,
        implementation_contract: parse_required_string(object, "implementationContract")?,
        signature: parse_required_string(object, "signature")?,
        selector: parse_required_string(object, "selector")?,
    })
}

fn parse_required_string(object: &str, key: &str) -> Result<String, String> {
    parse_string_field(object, key).ok_or_else(|| format!("missing string field: {key}"))
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
