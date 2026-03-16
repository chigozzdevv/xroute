use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use route_engine::{
    AssetKey, ChainKey, DeploymentProfile, EngineSettings, ExecutionType, RouteEngine,
    RouteRegistry,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::Mutex;
use xroute_service_shared::{
    assert_intent_allowed_by_execution_policy, health_json, intent_to_json_value, json_response,
    load_execution_policy_from_file, load_hub_deployment_artifact, quote_request_from_slice,
    quote_to_json_value, read_request_body, resolve_workspace_root, summarize_execution_policy,
    ExecutionPolicy, HttpError, HubDeploymentArtifact,
};

#[derive(Clone)]
struct QuoteState {
    deployment_profile: DeploymentProfile,
    max_body_bytes: usize,
    api_key: Option<String>,
    policy: Option<ExecutionPolicy>,
    deployment: Option<HubDeploymentArtifact>,
    live_inputs: Option<Arc<Mutex<LiveQuoteInputsCache>>>,
}

#[derive(Clone)]
struct LiveQuoteInputsConfig {
    source: LiveQuoteInputsSource,
    refresh_interval_ms: u64,
    max_stale_ms: u64,
    fail_open: bool,
    workspace_root: PathBuf,
    deployment_profile: DeploymentProfile,
}

const MAX_LIVE_INPUTS_ERROR_CHARS: usize = 280;

#[derive(Clone)]
enum LiveQuoteInputsSource {
    File(PathBuf),
    Command(String),
}

struct LiveQuoteInputsCache {
    config: LiveQuoteInputsConfig,
    snapshot: Option<LoadedLiveQuoteInputs>,
    last_error: Option<String>,
    last_attempt_at_ms: Option<u64>,
}

#[derive(Clone)]
struct LoadedLiveQuoteInputs {
    document: LiveQuoteInputsDocument,
    loaded_at_ms: u64,
    applied_transfer_edges: usize,
    applied_swap_routes: usize,
    applied_execute_routes: usize,
    applied_vdot_orders: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveQuoteInputsDocument {
    #[serde(default)]
    generated_at: Option<String>,
    #[serde(default)]
    transfer_edges: Vec<TransferEdgeInput>,
    #[serde(default)]
    swap_routes: Vec<SwapRouteInput>,
    #[serde(default)]
    execute_routes: Vec<ExecuteRouteInput>,
    #[serde(default)]
    vdot_orders: Vec<VdotOrderInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferEdgeInput {
    source_chain: String,
    destination_chain: String,
    asset: String,
    transport_fee: String,
    buy_execution_fee: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwapRouteInput {
    destination_chain: String,
    asset_in: String,
    asset_out: String,
    price_numerator: String,
    price_denominator: String,
    dex_fee_bps: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteRouteInput {
    destination_chain: String,
    asset: String,
    execution_type: String,
    execution_budget: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VdotOrderInput {
    pool_asset_amount: String,
    pool_vasset_amount: String,
    mint_fee_bps: u16,
    redeem_fee_bps: u16,
}

#[derive(Clone)]
pub struct QuoteApp {
    state: Arc<QuoteState>,
}

impl QuoteApp {
    pub fn load() -> Result<Self, String> {
        Ok(Self {
            state: Arc::new(load_state()?),
        })
    }

    pub async fn handle(&self, request: Request<Body>) -> Response<Body> {
        handle_request(request, Arc::clone(&self.state)).await
    }

    pub fn startup_summary(&self) -> Value {
        json!({
            "deploymentProfile": self.state.deployment_profile.as_str(),
            "routerAddress": self
                .state
                .deployment
                .as_ref()
                .map(|deployment| deployment.router_address.as_str()),
        })
    }
}

pub async fn run() -> Result<(), String> {
    serve(QuoteApp::load()?).await
}

pub async fn serve(app: QuoteApp) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(bind_addr()?)
        .await
        .map_err(|error| format!("failed to bind quote service: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("failed to read quote service address: {error}"))?;
    println!(
        "{}",
        json!({
            "url": format!("http://{}:{}", display_host(), local_addr.port()),
            "deploymentProfile": app.state.deployment_profile.as_str(),
            "routerAddress": app
                .state
                .deployment
                .as_ref()
                .map(|deployment| deployment.router_address.as_str()),
        })
    );

    let server = Server::from_tcp(
        listener
            .into_std()
            .map_err(|error| format!("failed to convert quote listener: {error}"))?,
    )
    .map_err(|error| format!("failed to construct quote server: {error}"))?
    .serve(make_service_fn(move |_| {
        let app = app.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request| {
                let app = app.clone();
                async move { Ok::<_, Infallible>(app.handle(request).await) }
            }))
        }
    }));

    server
        .await
        .map_err(|error| format!("quote service failed: {error}"))?;
    Ok(())
}

fn load_state() -> Result<QuoteState, String> {
    let deployment_profile = DeploymentProfile::Mainnet;
    let max_body_bytes = parse_positive_usize(
        env::var("XROUTE_QUOTE_MAX_BODY_BYTES")
            .ok()
            .as_deref()
            .unwrap_or("262144"),
        "XROUTE_QUOTE_MAX_BODY_BYTES",
    )?;
    let workspace_root = resolve_workspace_root(env::var("XROUTE_WORKSPACE_ROOT").ok().as_deref());
    let policy = match env::var("XROUTE_EVM_POLICY_PATH").ok() {
        Some(path) if !path.trim().is_empty() => Some(load_execution_policy_from_file(
            PathBuf::from(path).as_path(),
        )?),
        _ => None,
    };
    let deployment = load_hub_deployment_artifact(&workspace_root, deployment_profile).ok();
    let live_inputs = load_live_inputs_config(&workspace_root, deployment_profile)?.map(|config| {
        Arc::new(Mutex::new(LiveQuoteInputsCache {
            config,
            snapshot: None,
            last_error: None,
            last_attempt_at_ms: None,
        }))
    });
    if deployment_profile == DeploymentProfile::Mainnet && live_inputs.is_none() {
        return Err(
            "mainnet requires live quote inputs; configure XROUTE_LIVE_QUOTE_INPUTS_PATH or XROUTE_LIVE_QUOTE_INPUTS_COMMAND"
                .to_owned(),
        );
    }

    Ok(QuoteState {
        deployment_profile,
        max_body_bytes,
        api_key: env::var("XROUTE_API_KEY")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        policy,
        deployment,
        live_inputs,
    })
}

async fn handle_request(request: Request<Body>, state: Arc<QuoteState>) -> Response<Body> {
    match route_request(request, state).await {
        Ok(response) => response,
        Err(error) => json_response(
            error.status_code,
            &json!({
                "error": error.message,
            }),
        ),
    }
}

async fn route_request(
    request: Request<Body>,
    state: Arc<QuoteState>,
) -> Result<Response<Body>, HttpError> {
    match (
        request.method(),
        normalize_public_path(request.uri().path()),
    ) {
        (&Method::GET, "/healthz") => {
            let quote_inputs = live_inputs_metadata(state.live_inputs.as_ref()).await;
            Ok(json_response(
                StatusCode::OK,
                &health_json(
                    state.deployment_profile,
                    state
                        .deployment
                        .as_ref()
                        .map(|deployment| deployment.router_address.as_str()),
                    json!({
                        "policy": summarize_execution_policy(state.policy.as_ref()),
                        "quoteInputs": quote_inputs,
                    }),
                ),
            ))
        }
        (&Method::POST, "/quote") => {
            assert_api_key(&request, state.api_key.as_deref())?;
            let body = read_request_body(request, state.max_body_bytes).await?;
            let parsed = quote_request_from_slice(&body)?;
            assert_intent_allowed_by_execution_policy(&parsed.intent, state.policy.as_ref())
                .map_err(HttpError::bad_request)?;

            let (registry, quote_inputs) = resolve_quote_registry(&state).await?;
            let quote = RouteEngine::new(
                registry,
                EngineSettings {
                    platform_fee_bps: 10,
                    deployment_profile: state.deployment_profile,
                },
            )
            .quote(parsed.intent.clone())
            .map_err(|error| HttpError::bad_request(error.to_string()))?;

            Ok(json_response(
                StatusCode::OK,
                &json!({
                    "intent": intent_to_json_value(&parsed.intent, &parsed.quote_id),
                    "quote": quote_to_json_value(&quote, &parsed.quote_id),
                    "deploymentProfile": state.deployment_profile.as_str(),
                    "routerAddress": state.deployment.as_ref().map(|deployment| deployment.router_address.as_str()),
                    "quoteInputs": quote_inputs,
                }),
            ))
        }
        _ => Ok(json_response(
            StatusCode::NOT_FOUND,
            &json!({
                "error": "not-found",
            }),
        )),
    }
}

fn normalize_public_path(path: &str) -> &str {
    if let Some(stripped) = path.strip_prefix("/v1") {
        if stripped.is_empty() {
            "/"
        } else {
            stripped
        }
    } else {
        path
    }
}

fn assert_api_key(request: &Request<Body>, expected: Option<&str>) -> Result<(), HttpError> {
    let Some(expected) = expected else {
        return Ok(());
    };

    let provided = request
        .headers()
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if provided == Some(expected) {
        Ok(())
    } else {
        Err(HttpError::new(StatusCode::UNAUTHORIZED, "invalid-api-key"))
    }
}

async fn resolve_quote_registry(state: &QuoteState) -> Result<(RouteRegistry, Value), HttpError> {
    let mut registry = RouteRegistry::for_profile(state.deployment_profile);
    let quote_inputs = match &state.live_inputs {
        Some(cache) => {
            let mut guard = cache.lock().await;
            guard
                .refresh_if_needed()
                .await
                .map_err(|error| HttpError::new(StatusCode::SERVICE_UNAVAILABLE, error))?;

            if let Some(snapshot) = &guard.snapshot {
                apply_live_quote_inputs(&mut registry, &snapshot.document)
                    .map_err(|error| HttpError::new(StatusCode::SERVICE_UNAVAILABLE, error))?;
            } else if !guard.config.fail_open {
                return Err(HttpError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "live quote inputs are required but no snapshot is loaded",
                ));
            }

            guard.metadata_json()
        }
        None => static_quote_inputs_json(),
    };

    Ok((registry, quote_inputs))
}

fn load_live_inputs_config(
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
) -> Result<Option<LiveQuoteInputsConfig>, String> {
    let file_path = env::var("XROUTE_LIVE_QUOTE_INPUTS_PATH")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let command = env::var("XROUTE_LIVE_QUOTE_INPUTS_COMMAND")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    let source = match (file_path, command) {
        (Some(_), Some(_)) => {
            return Err(
                "configure only one of XROUTE_LIVE_QUOTE_INPUTS_PATH or XROUTE_LIVE_QUOTE_INPUTS_COMMAND"
                    .to_owned(),
            )
        }
        (Some(path), None) => {
            let resolved = if Path::new(&path).is_absolute() {
                PathBuf::from(path)
            } else {
                workspace_root.join(path)
            };
            LiveQuoteInputsSource::File(resolved)
        }
        (None, Some(command)) => LiveQuoteInputsSource::Command(command),
        (None, None) => return Ok(None),
    };

    let fail_open = match env::var("XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN")
        .ok()
        .as_deref()
    {
        Some(value) => parse_bool(value, "XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN")?,
        None => deployment_profile != DeploymentProfile::Mainnet,
    };
    if deployment_profile == DeploymentProfile::Mainnet && fail_open {
        return Err(
            "mainnet quote service must fail closed; set XROUTE_LIVE_QUOTE_INPUTS_FAIL_OPEN=false"
                .to_owned(),
        );
    }

    Ok(Some(LiveQuoteInputsConfig {
        source,
        refresh_interval_ms: parse_non_negative_u64(
            env::var("XROUTE_LIVE_QUOTE_INPUTS_REFRESH_MS")
                .ok()
                .as_deref()
                .unwrap_or("30000"),
            "XROUTE_LIVE_QUOTE_INPUTS_REFRESH_MS",
        )?,
        max_stale_ms: parse_non_negative_u64(
            env::var("XROUTE_LIVE_QUOTE_INPUTS_MAX_STALE_MS")
                .ok()
                .as_deref()
                .unwrap_or("300000"),
            "XROUTE_LIVE_QUOTE_INPUTS_MAX_STALE_MS",
        )?,
        fail_open,
        workspace_root: workspace_root.to_path_buf(),
        deployment_profile,
    }))
}

impl LiveQuoteInputsCache {
    async fn refresh_if_needed(&mut self) -> Result<(), String> {
        let now_ms = unix_timestamp_ms();
        if !self.should_refresh(now_ms) {
            return Ok(());
        }

        self.last_attempt_at_ms = Some(now_ms);
        match load_live_quote_inputs(&self.config).await {
            Ok(snapshot) => {
                self.snapshot = Some(snapshot);
                self.last_error = None;
                Ok(())
            }
            Err(error) => {
                self.last_error = Some(error.clone());
                if self.can_serve_stale_snapshot(now_ms) {
                    Ok(())
                } else if self.config.fail_open && self.snapshot.is_some() {
                    Ok(())
                } else if self.config.fail_open {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }

    fn should_refresh(&self, now_ms: u64) -> bool {
        let Some(snapshot) = &self.snapshot else {
            return true;
        };

        self.config.refresh_interval_ms == 0
            || now_ms.saturating_sub(snapshot.loaded_at_ms) >= self.config.refresh_interval_ms
    }

    fn can_serve_stale_snapshot(&self, now_ms: u64) -> bool {
        let Some(snapshot) = &self.snapshot else {
            return false;
        };

        self.config.max_stale_ms == 0
            || now_ms.saturating_sub(snapshot.loaded_at_ms) <= self.config.max_stale_ms
    }

    fn metadata_json(&self) -> Value {
        let source_mode = self.config.source.mode();
        match &self.snapshot {
            Some(snapshot) => json!({
                "configured": true,
                "mode": source_mode,
                "status": if self.last_error.is_some() { "live-with-last-error" } else { "live" },
                "failOpen": self.config.fail_open,
                "refreshIntervalMs": self.config.refresh_interval_ms,
                "maxStaleMs": self.config.max_stale_ms,
                "generatedAt": snapshot.document.generated_at,
                "loadedAtMs": snapshot.loaded_at_ms,
                "appliedTransferEdges": snapshot.applied_transfer_edges,
                "appliedSwapRoutes": snapshot.applied_swap_routes,
                "appliedExecuteRoutes": snapshot.applied_execute_routes,
                "appliedVdotOrders": snapshot.applied_vdot_orders,
                "lastAttemptAtMs": self.last_attempt_at_ms,
                "lastError": self.last_error,
                "usingStaticFallback": false,
            }),
            None => json!({
                "configured": true,
                "mode": source_mode,
                "status": if self.last_error.is_some() {
                    if self.config.fail_open { "static-fallback" } else { "error" }
                } else {
                    "pending"
                },
                "failOpen": self.config.fail_open,
                "refreshIntervalMs": self.config.refresh_interval_ms,
                "maxStaleMs": self.config.max_stale_ms,
                "generatedAt": Value::Null,
                "loadedAtMs": Value::Null,
                "appliedTransferEdges": 0,
                "appliedSwapRoutes": 0,
                "appliedExecuteRoutes": 0,
                "appliedVdotOrders": 0,
                "lastAttemptAtMs": self.last_attempt_at_ms,
                "lastError": self.last_error,
                "usingStaticFallback": true,
            }),
        }
    }
}

async fn live_inputs_metadata(live_inputs: Option<&Arc<Mutex<LiveQuoteInputsCache>>>) -> Value {
    let Some(cache) = live_inputs else {
        return static_quote_inputs_json();
    };

    let guard = cache.lock().await;
    guard.metadata_json()
}

async fn load_live_quote_inputs(
    config: &LiveQuoteInputsConfig,
) -> Result<LoadedLiveQuoteInputs, String> {
    let raw = match &config.source {
        LiveQuoteInputsSource::File(path) => {
            tokio::fs::read_to_string(path).await.map_err(|error| {
                format!(
                    "failed to read live quote inputs from {}: {error}",
                    path.display()
                )
            })?
        }
        LiveQuoteInputsSource::Command(command) => {
            let output = Command::new("/bin/sh")
                .arg("-lc")
                .arg(command)
                .current_dir(&config.workspace_root)
                .output()
                .await
                .map_err(|error| format!("failed to execute live quote inputs command: {error}"))?;

            if !output.status.success() {
                let stderr = summarize_live_inputs_error(&String::from_utf8_lossy(&output.stderr));
                return Err(format!(
                    "live quote inputs command exited with status {}{}",
                    output.status,
                    if stderr.is_empty() {
                        "".to_owned()
                    } else {
                        format!(": {stderr}")
                    },
                ));
            }

            String::from_utf8(output.stdout).map_err(|error| {
                format!("live quote inputs command returned invalid utf8: {error}")
            })?
        }
    };

    let document: LiveQuoteInputsDocument = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse live quote inputs json: {error}"))?;
    let mut registry = RouteRegistry::for_profile(config.deployment_profile);
    let applied = apply_live_quote_inputs(&mut registry, &document)?;

    Ok(LoadedLiveQuoteInputs {
        document,
        loaded_at_ms: unix_timestamp_ms(),
        applied_transfer_edges: applied.0,
        applied_swap_routes: applied.1,
        applied_execute_routes: applied.2,
        applied_vdot_orders: applied.3,
    })
}

fn summarize_live_inputs_error(stderr: &str) -> String {
    let flattened = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_error_message(&flattened, MAX_LIVE_INPUTS_ERROR_CHARS)
}

fn truncate_error_message(message: &str, max_chars: usize) -> String {
    let normalized = message.trim();
    if normalized.is_empty() {
        return String::new();
    }

    let mut truncated = String::new();
    let mut count = 0usize;
    for ch in normalized.chars() {
        if count == max_chars {
            truncated.push_str("...");
            return truncated;
        }
        truncated.push(ch);
        count += 1;
    }

    truncated
}

fn apply_live_quote_inputs(
    registry: &mut RouteRegistry,
    document: &LiveQuoteInputsDocument,
) -> Result<(usize, usize, usize, usize), String> {
    let mut applied_transfer_edges = 0usize;
    for edge in &document.transfer_edges {
        registry.override_transfer_edge(
            ChainKey::from_str(&edge.source_chain)?,
            ChainKey::from_str(&edge.destination_chain)?,
            AssetKey::from_str(&edge.asset)?,
            parse_u128_value(&edge.transport_fee, "transportFee")?,
            parse_u128_value(&edge.buy_execution_fee, "buyExecutionFee")?,
        )?;
        applied_transfer_edges += 1;
    }

    let mut applied_swap_routes = 0usize;
    for route in &document.swap_routes {
        let price_denominator = parse_u128_value(&route.price_denominator, "priceDenominator")?;
        if price_denominator == 0 {
            return Err("priceDenominator must be greater than zero".to_owned());
        }
        registry.override_swap_route(
            ChainKey::from_str(&route.destination_chain)?,
            AssetKey::from_str(&route.asset_in)?,
            AssetKey::from_str(&route.asset_out)?,
            parse_u128_value(&route.price_numerator, "priceNumerator")?,
            price_denominator,
            route.dex_fee_bps,
        )?;
        applied_swap_routes += 1;
    }

    let mut applied_execute_routes = 0usize;
    for route in &document.execute_routes {
        registry.override_execute_route(
            ChainKey::from_str(&route.destination_chain)?,
            AssetKey::from_str(&route.asset)?,
            ExecutionType::from_str(&route.execution_type)?,
            parse_u128_value(&route.execution_budget, "executionBudget")?,
        )?;
        applied_execute_routes += 1;
    }

    let mut applied_vdot_orders = 0usize;
    for order in &document.vdot_orders {
        registry.override_vdot_order_pricing(
            parse_u128_value(&order.pool_asset_amount, "poolAssetAmount")?,
            parse_u128_value(&order.pool_vasset_amount, "poolVassetAmount")?,
            order.mint_fee_bps,
            order.redeem_fee_bps,
        )?;
        applied_vdot_orders += 1;
    }

    Ok((
        applied_transfer_edges,
        applied_swap_routes,
        applied_execute_routes,
        applied_vdot_orders,
    ))
}

fn static_quote_inputs_json() -> Value {
    json!({
        "configured": false,
        "mode": "static",
        "status": "static",
        "failOpen": true,
        "refreshIntervalMs": Value::Null,
        "generatedAt": Value::Null,
        "loadedAtMs": Value::Null,
        "appliedTransferEdges": 0,
        "appliedSwapRoutes": 0,
        "appliedExecuteRoutes": 0,
        "appliedVdotOrders": 0,
        "lastAttemptAtMs": Value::Null,
        "lastError": Value::Null,
        "usingStaticFallback": false,
    })
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_millis(0))
        .as_millis() as u64
}

fn bind_addr() -> Result<SocketAddr, String> {
    let host = display_host();
    let port = env::var("XROUTE_QUOTE_PORT")
        .ok()
        .as_deref()
        .map(|value| parse_port(value, "XROUTE_QUOTE_PORT"))
        .transpose()?
        .unwrap_or(8787);
    format!("{host}:{port}")
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid quote bind address {host}:{port}: {error}"))
}

fn display_host() -> String {
    env::var("XROUTE_QUOTE_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_owned())
}

fn parse_port(value: &str, name: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("{name} must be a valid TCP port"))
}

fn parse_positive_usize(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_non_negative_u64(value: &str, name: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be a non-negative integer"))
}

fn parse_bool(value: &str, name: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!("{name} must be a boolean")),
    }
}

fn parse_u128_value(value: &str, name: &str) -> Result<u128, String> {
    value
        .trim()
        .parse::<u128>()
        .map_err(|_| format!("{name} must be an unsigned integer"))
}

impl LiveQuoteInputsSource {
    fn mode(&self) -> &'static str {
        match self {
            Self::File(_) => "file",
            Self::Command(_) => "command",
        }
    }
}
