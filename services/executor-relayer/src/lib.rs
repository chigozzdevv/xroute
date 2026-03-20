mod store;

use crate::store::{Job, JobPayload, JobStatus, JobStore, JobType, SourceIntentRecord};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use route_engine::DeploymentProfile;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::env;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task;
use tokio::time::sleep;
use xroute_service_shared::{
    assert_bearer_token, assert_intent_allowed_by_execution_policy,
    dispatch_job_request_from_slice, fail_job_request_from_slice, health_json, json_response,
    load_execution_policy_from_file, load_hub_deployment_artifact,
    read_request_body, refund_job_request_from_slice, resolve_workspace_root,
    settle_job_request_from_slice, summarize_execution_policy, summary_json, DispatchRequest,
    ExecutionPolicy, HttpError, MoonbeamDispatchMetadata, SourceIntentMetadata,
};

const DISPATCH_INTENT_SIGNATURE: &str = "dispatchIntent(bytes32,(uint8,bytes,bytes))";
const FINALIZE_SUCCESS_SIGNATURE: &str = "finalizeSuccess(bytes32,bytes32,bytes32,uint128)";
const FINALIZE_EXTERNAL_SUCCESS_SIGNATURE: &str =
    "finalizeExternalSuccess(bytes32,bytes32,bytes32,uint128)";
const FINALIZE_FAILURE_SIGNATURE: &str = "finalizeFailure(bytes32,bytes32,bytes32)";
const REFUND_FAILED_INTENT_SIGNATURE: &str = "refundFailedIntent(bytes32,uint128)";
const XCM_PRECOMPILE_ADDRESS: &str = "0x00000000000000000000000000000000000a0000";
const MOONBEAM_BATCH_PRECOMPILE_ADDRESS: &str = "0x0000000000000000000000000000000000000808";
const MOONBEAM_XCM_UTILS_ADDRESS: &str = "0x000000000000000000000000000000000000080c";
const MOONBEAM_BATCH_ALL_SELECTOR: &str = "0x96e292b8";
const DISPATCH_INTENT_WITHOUT_XCM_SELECTOR: &str = "0x7b458b58";
const MOONBEAM_TRANSFER_ASSETS_SELECTOR: &str = "0xaaecfc62";
const SUPPORTED_EXECUTION_CHAINS: &[&str] = &["polkadot-hub", "hydration", "moonbeam", "bifrost"];

#[derive(Clone)]
struct ExecutionContext {
    chain_key: String,
    rpc_url: String,
    private_key: String,
    router_address: String,
    xcm_address: String,
    moonbeam_xcdot_asset_address: Option<String>,
    moonbeam_vdot_asset_address: Option<String>,
    moonbeam_xcbnc_asset_address: Option<String>,
    observation_rpc_url: Option<String>,
}

#[derive(Clone)]
struct RelayerState {
    deployment_profile: DeploymentProfile,
    max_body_bytes: usize,
    auth_token: String,
    api_key: Option<String>,
    primary_chain_key: String,
    primary_execution_context: ExecutionContext,
    execution_contexts: BTreeMap<String, ExecutionContext>,
    policy: Option<ExecutionPolicy>,
    job_store: Arc<JobStore>,
    event_log_path: PathBuf,
    gas_limit: Option<u64>,
    max_attempts: u32,
    retry_delay_ms: u64,
    poll_interval_ms: u64,
    node_bin: String,
    substrate_dispatch_script: PathBuf,
    substrate_balance_script: PathBuf,
    evm_transaction_script: PathBuf,
}

#[derive(Clone)]
pub struct RelayerApp {
    state: Arc<RelayerState>,
    worker_started: Arc<AtomicBool>,
}

impl RelayerApp {
    pub fn load() -> Result<Self, String> {
        Ok(Self {
            state: Arc::new(load_state()?),
            worker_started: Arc::new(AtomicBool::new(false)),
        })
    }

    pub async fn handle(&self, request: Request<Body>) -> Response<Body> {
        handle_request(request, Arc::clone(&self.state)).await
    }

    pub fn start_worker(&self) {
        if self.worker_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let worker_state = Arc::clone(&self.state);
        tokio::spawn(async move {
            loop {
                if let Err(error) = process_ready_jobs(Arc::clone(&worker_state)).await {
                    eprintln!("{error}");
                }
                if let Err(error) = monitor_dispatched_source_intents(Arc::clone(&worker_state)).await
                {
                    eprintln!("{error}");
                }
                sleep(Duration::from_millis(worker_state.poll_interval_ms)).await;
            }
        });
    }

    pub fn startup_summary(&self) -> Value {
        json!({
            "deploymentProfile": self.state.deployment_profile.as_str(),
            "routerAddress": self.state.primary_execution_context.router_address,
            "primarySourceChain": self.state.primary_chain_key,
            "executionContexts": self.state.execution_context_summary(),
        })
    }
}

pub async fn run() -> Result<(), String> {
    serve(RelayerApp::load()?).await
}

pub async fn serve(app: RelayerApp) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(bind_addr()?)
        .await
        .map_err(|error| format!("failed to bind executor relayer: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("failed to read relayer address: {error}"))?;

    println!(
        "{}",
        json!({
            "url": format!("http://{}:{}", display_host(), local_addr.port()),
            "deploymentProfile": app.state.deployment_profile.as_str(),
            "routerAddress": app.state.primary_execution_context.router_address,
            "executionContexts": app.state.execution_context_summary(),
        })
    );

    app.start_worker();

    let server = Server::from_tcp(
        listener
            .into_std()
            .map_err(|error| format!("failed to convert relayer listener: {error}"))?,
    )
    .map_err(|error| format!("failed to construct relayer server: {error}"))?
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
        .map_err(|error| format!("executor relayer failed: {error}"))?;
    Ok(())
}

fn load_state() -> Result<RelayerState, String> {
    let deployment_profile = DeploymentProfile::Mainnet;
    let max_body_bytes = parse_positive_usize(
        env::var("XROUTE_RELAYER_MAX_BODY_BYTES")
            .ok()
            .as_deref()
            .unwrap_or("262144"),
        "XROUTE_RELAYER_MAX_BODY_BYTES",
    )?;
    let auth_token = required_env("XROUTE_RELAYER_AUTH_TOKEN")?;
    let api_key = env::var("XROUTE_API_KEY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let rpc_url = required_env("XROUTE_HUB_RPC_URL")?;
    let private_key = required_env("XROUTE_HUB_PRIVATE_KEY")?;
    let workspace_root = resolve_workspace_root(env::var("XROUTE_WORKSPACE_ROOT").ok().as_deref());
    let deployment = load_hub_deployment_artifact(&workspace_root, deployment_profile).ok();
    let primary_chain_key = env::var("XROUTE_DEFAULT_SOURCE_CHAIN")
        .ok()
        .as_deref()
        .map(normalize_chain_key)
        .transpose()?
        .or_else(|| {
            deployment
                .as_ref()
                .and_then(|artifact| normalize_chain_key(&artifact.chain_key).ok())
        })
        .unwrap_or_else(|| "polkadot-hub".to_owned());
    let router_address = env::var("XROUTE_ROUTER_ADDRESS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            deployment
                .as_ref()
                .map(|artifact| artifact.router_address.clone())
        })
        .ok_or_else(|| "routerAddress or a deployment artifact is required".to_owned())?;
    let policy = match env::var("XROUTE_EVM_POLICY_PATH").ok() {
        Some(path) if !path.trim().is_empty() => {
            Some(load_execution_policy_from_file(Path::new(&path))?)
        }
        _ => None,
    };
    let default_xcm_address = env::var("XROUTE_XCM_ADDRESS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            deployment
                .as_ref()
                .and_then(|artifact| artifact.xcm_address.clone())
        })
        .unwrap_or_else(|| XCM_PRECOMPILE_ADDRESS.to_owned());
    let base_execution_context = ExecutionContext {
        chain_key: primary_chain_key.clone(),
        rpc_url,
        private_key,
        router_address: router_address.clone(),
        xcm_address: default_xcm_address.clone(),
        moonbeam_xcdot_asset_address: env::var("XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS").ok(),
        moonbeam_vdot_asset_address: env::var("XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS").ok(),
        moonbeam_xcbnc_asset_address: env::var("XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS").ok(),
        observation_rpc_url: env::var("XROUTE_HUB_XCM_RPC_URL").ok(),
    };

    let mut execution_contexts = BTreeMap::new();
    execution_contexts.insert(primary_chain_key.clone(), base_execution_context.clone());

    for chain_key in SUPPORTED_EXECUTION_CHAINS {
        if *chain_key == primary_chain_key {
            continue;
        }

        let prefix = chain_key.to_uppercase().replace('-', "_");
        let rpc_url_key = format!("XROUTE_{}_RPC_URL", prefix);
        let private_key_key = format!("XROUTE_{}_PRIVATE_KEY", prefix);
        let router_address_key = format!("XROUTE_{}_ROUTER_ADDRESS", prefix);
        let xcm_address_key = format!("XROUTE_{}_XCM_ADDRESS", prefix);
        let observation_rpc_url_key = format!("XROUTE_{}_XCM_RPC_URL", prefix);

        if let (Some(rpc_url), Some(private_key)) = (env::var(&rpc_url_key).ok(), env::var(&private_key_key).ok()) {
             let router_address = env::var(&router_address_key).ok().unwrap_or_else(|| router_address.clone());
             let xcm_address = env::var(&xcm_address_key).ok().unwrap_or_else(|| default_xcm_address.clone());
             let observation_rpc_url = env::var(&observation_rpc_url_key).ok();

             execution_contexts.insert(chain_key.to_string(), ExecutionContext {
                 chain_key: chain_key.to_string(),
                 rpc_url,
                 private_key,
                 router_address,
                 xcm_address,
                 moonbeam_xcdot_asset_address: env::var("XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS").ok(),
                 moonbeam_vdot_asset_address: env::var("XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS").ok(),
                 moonbeam_xcbnc_asset_address: env::var("XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS").ok(),
                 observation_rpc_url,
             });
        }
    }
    let primary_execution_context = execution_contexts
        .remove(&primary_chain_key)
        .unwrap_or_else(|| base_execution_context.clone());
    let data_root = workspace_root
        .join("services")
        .join("executor-relayer")
        .join("data");
    let job_store_path = env::var("XROUTE_RELAYER_JOB_STORE_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join(format!("{}-jobs.json", deployment_profile.as_str())));
    let event_log_path = env::var("XROUTE_STATUS_EVENTS_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            data_root.join(format!("{}-status.ndjson", deployment_profile.as_str()))
        });
    let node_bin = env::var("XROUTE_NODE_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "node".to_owned());
    let substrate_dispatch_script = env::var("XROUTE_SUBSTRATE_DISPATCH_SCRIPT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace_root
                .join("services")
                .join("executor-relayer")
                .join("scripts")
                .join("dispatch-substrate-xcm.mjs")
        });
    let substrate_balance_script = env::var("XROUTE_SUBSTRATE_BALANCE_SCRIPT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace_root
                .join("services")
                .join("executor-relayer")
                .join("scripts")
                .join("read-substrate-balance.mjs")
        });
    let evm_transaction_script = env::var("XROUTE_EVM_TRANSACTION_SCRIPT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace_root
                .join("services")
                .join("executor-relayer")
                .join("scripts")
                .join("send-evm-transaction.mjs")
        });

    Ok(RelayerState {
        deployment_profile,
        max_body_bytes,
        auth_token,
        api_key,
        primary_chain_key,
        primary_execution_context,
        execution_contexts,
        policy,
        job_store: Arc::new(JobStore::load(job_store_path)?),
        event_log_path,
        gas_limit: env::var("XROUTE_RELAYER_GAS_LIMIT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| parse_positive_u64(&value, "XROUTE_RELAYER_GAS_LIMIT"))
            .transpose()?,
        max_attempts: parse_positive_u32(
            env::var("XROUTE_RELAYER_MAX_ATTEMPTS")
                .ok()
                .as_deref()
                .unwrap_or("5"),
            "XROUTE_RELAYER_MAX_ATTEMPTS",
        )?,
        retry_delay_ms: parse_positive_u64(
            env::var("XROUTE_RELAYER_RETRY_DELAY_MS")
                .ok()
                .as_deref()
                .unwrap_or("3000"),
            "XROUTE_RELAYER_RETRY_DELAY_MS",
        )?,
        poll_interval_ms: parse_positive_u64(
            env::var("XROUTE_RELAYER_POLL_INTERVAL_MS")
                .ok()
                .as_deref()
                .unwrap_or("1000"),
            "XROUTE_RELAYER_POLL_INTERVAL_MS",
        )?,
        node_bin,
        substrate_dispatch_script,
        substrate_balance_script,
        evm_transaction_script,
    })
}

async fn handle_request(request: Request<Body>, state: Arc<RelayerState>) -> Response<Body> {
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
    state: Arc<RelayerState>,
) -> Result<Response<Body>, HttpError> {
    let normalized_path = normalize_public_path(request.uri().path()).to_owned();
    match (request.method(), normalized_path.as_str()) {
        (&Method::GET, "/healthz") => {
            let jobs = state.job_store.list().await;
            let summary = summarize_jobs(&jobs);
            Ok(json_response(
                StatusCode::OK,
                &health_json(
                    state.deployment_profile,
                    Some(&state.primary_execution_context.router_address),
                    json!({
                        "primarySourceChain": state.primary_chain_key,
                        "executionContexts": state.execution_context_summary(),
                        "policy": summarize_execution_policy(state.policy.as_ref()),
                        "jobs": summary_json(summary.0, summary.1, summary.2, summary.3),
                    }),
                ),
            ))
        }
        (&Method::GET, path) if path.starts_with("/intents/") && path.ends_with("/status") => {
            assert_request_read_auth(&request, state.api_key.as_deref())?;
            let intent_id = path
                .strip_prefix("/intents/")
                .and_then(|rest| rest.strip_suffix("/status"))
                .unwrap_or("");
            handle_intent_status(intent_id, &state).await
        }
        (&Method::GET, path) if path.starts_with("/intents/") && path.ends_with("/timeline") => {
            assert_request_read_auth(&request, state.api_key.as_deref())?;
            let intent_id = path
                .strip_prefix("/intents/")
                .and_then(|rest| rest.strip_suffix("/timeline"))
                .unwrap_or("");
            handle_intent_timeline(intent_id, &state).await
        }
        _ => {
            assert_request_auth(&request, &state.auth_token, state.api_key.as_deref())?;
            route_authenticated_request(request, state, normalized_path).await
        }
    }
}

async fn route_authenticated_request(
    request: Request<Body>,
    state: Arc<RelayerState>,
    normalized_path: String,
) -> Result<Response<Body>, HttpError> {
    match (request.method(), normalized_path.as_str()) {
        (&Method::GET, "/jobs") => {
            let mut jobs = state.job_store.list().await;
            jobs.sort_by(compare_jobs);
            Ok(json_response(StatusCode::OK, &json!({ "jobs": jobs })))
        }
        (&Method::GET, path) if path.starts_with("/jobs/") => {
            let job_id = path.trim_start_matches("/jobs/");
            let job = state
                .job_store
                .get(job_id)
                .await
                .ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, "job-not-found"))?;
            Ok(json_response(StatusCode::OK, &json!({ "job": job })))
        }
        (&Method::POST, "/jobs/dispatch") => {
            let body = read_request_body(request, state.max_body_bytes).await?;
            let parsed = dispatch_job_request_from_slice(&body)?;
            assert_intent_allowed_by_execution_policy(&parsed.intent, state.policy.as_ref())
                .map_err(HttpError::bad_request)?;
            let normalized_source_chain = normalize_chain_key(&parsed.wire_intent.source_chain)
                .map_err(HttpError::bad_request)?;
            if source_chain_requires_source_intent_metadata(&normalized_source_chain)
                && parsed.source_intent.is_none()
            {
                return Err(HttpError::bad_request(format!(
                    "{} source dispatch requires sourceIntent metadata",
                    normalized_source_chain
                )));
            }
            if normalized_source_chain == "moonbeam" && parsed.moonbeam_dispatch.is_none() {
                return Err(HttpError::bad_request(
                    "moonbeam source dispatch requires moonbeamDispatch metadata",
                ));
            }
            if let Some(source_intent) = parsed.source_intent.as_ref() {
                state
                    .job_store
                    .record_source_intent_submission(
                        &parsed.intent_id,
                        &normalized_source_chain,
                        source_intent,
                    )
                    .await
                    .map_err(|error| HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, error))?;
            }

            let job = enqueue_job(
                &state.job_store,
                JobType::Dispatch,
                JobPayload::Dispatch {
                    intent_id: parsed.intent_id,
                    wire_intent: parsed.wire_intent,
                    request: parsed.request,
                    source_intent: parsed.source_intent,
                    moonbeam_dispatch: parsed.moonbeam_dispatch,
                    source_dispatch: parsed.source_dispatch,
                },
                state.max_attempts,
            )
            .await
            .map_err(HttpError::bad_request)?;

            Ok(json_response(StatusCode::ACCEPTED, &json!({ "job": job })))
        }
        (&Method::POST, "/jobs/settle") => {
            let body = read_request_body(request, state.max_body_bytes).await?;
            let parsed = settle_job_request_from_slice(&body)?;
            let job = enqueue_job(
                &state.job_store,
                JobType::Settle,
                JobPayload::Settle {
                    intent_id: parsed.intent_id,
                    outcome_reference: parsed.outcome_reference,
                    result_asset_id: parsed.result_asset_id,
                    result_amount: parsed.result_amount,
                },
                state.max_attempts,
            )
            .await
            .map_err(HttpError::bad_request)?;

            Ok(json_response(StatusCode::ACCEPTED, &json!({ "job": job })))
        }
        (&Method::POST, "/jobs/fail") => {
            let body = read_request_body(request, state.max_body_bytes).await?;
            let parsed = fail_job_request_from_slice(&body)?;
            let job = enqueue_job(
                &state.job_store,
                JobType::Fail,
                JobPayload::Fail {
                    intent_id: parsed.intent_id,
                    outcome_reference: parsed.outcome_reference,
                    failure_reason_hash: parsed.failure_reason_hash,
                },
                state.max_attempts,
            )
            .await
            .map_err(HttpError::bad_request)?;

            Ok(json_response(StatusCode::ACCEPTED, &json!({ "job": job })))
        }
        (&Method::POST, "/jobs/refund") => {
            let body = read_request_body(request, state.max_body_bytes).await?;
            let parsed = refund_job_request_from_slice(&body)?;
            let job = enqueue_job(
                &state.job_store,
                JobType::Refund,
                JobPayload::Refund {
                    intent_id: parsed.intent_id,
                    refund_amount: parsed.refund_amount,
                    refund_asset: parsed.refund_asset,
                },
                state.max_attempts,
            )
            .await
            .map_err(HttpError::bad_request)?;

            Ok(json_response(StatusCode::ACCEPTED, &json!({ "job": job })))
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

fn assert_request_auth(
    request: &Request<Body>,
    auth_token: &str,
    api_key: Option<&str>,
) -> Result<(), HttpError> {
    if assert_bearer_token(request, auth_token).is_ok() {
        return Ok(());
    }

    if let Some(expected_api_key) = api_key {
        let provided = request
            .headers()
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if provided == Some(expected_api_key) {
            return Ok(());
        }
    }

    Err(HttpError::new(StatusCode::UNAUTHORIZED, "unauthorized"))
}

fn assert_request_read_auth(
    request: &Request<Body>,
    api_key: Option<&str>,
) -> Result<(), HttpError> {
    if let Some(expected_api_key) = api_key {
        let provided = request
            .headers()
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if provided == Some(expected_api_key) {
            return Ok(());
        }

        return Err(HttpError::new(StatusCode::UNAUTHORIZED, "unauthorized"));
    }

    Ok(())
}

async fn handle_intent_status(
    intent_id: &str,
    state: &RelayerState,
) -> Result<Response<Body>, HttpError> {
    if intent_id.is_empty() {
        return Err(HttpError::bad_request("intentId is required"));
    }

    let events = read_intent_events_from_log(&state.event_log_path, intent_id);
    let source_intent = state.job_store.source_intent(intent_id).await;

    if events.is_empty() && source_intent.is_none() {
        return Err(HttpError::new(StatusCode::NOT_FOUND, "intent-not-found"));
    }

    let status = build_intent_status(intent_id, &events, source_intent.as_ref());
    Ok(json_response(StatusCode::OK, &status))
}

async fn handle_intent_timeline(
    intent_id: &str,
    state: &RelayerState,
) -> Result<Response<Body>, HttpError> {
    if intent_id.is_empty() {
        return Err(HttpError::bad_request("intentId is required"));
    }

    let events = read_intent_events_from_log(&state.event_log_path, intent_id);
    let source_intent = state.job_store.source_intent(intent_id).await;

    if events.is_empty() && source_intent.is_none() {
        return Err(HttpError::new(StatusCode::NOT_FOUND, "intent-not-found"));
    }

    Ok(json_response(
        StatusCode::OK,
        &json!({ "timeline": events }),
    ))
}

fn read_intent_events_from_log(event_log_path: &Path, intent_id: &str) -> Vec<Value> {
    let raw = match std::fs::read_to_string(event_log_path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };

    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| {
            event
                .get("intentId")
                .and_then(Value::as_str)
                .map(|id| id == intent_id)
                .unwrap_or(false)
        })
        .collect()
}

fn build_intent_status(
    intent_id: &str,
    events: &[Value],
    source_intent: Option<&SourceIntentRecord>,
) -> Value {
    let mut status = "unknown";
    let mut result: Option<Value> = None;
    let mut failure_reason: Option<String> = None;
    let mut refund: Option<Value> = None;

    for event in events {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "intent-submitted" => status = "submitted",
            "intent-dispatched" => status = "dispatched",
            "destination-execution-started" => status = "executing",
            "destination-execution-succeeded" => {
                status = "settled";
                result = event.get("result").cloned().or_else(|| {
                    Some(json!({
                        "asset": event.get("resultAsset").or_else(|| event.get("result").and_then(|r| r.get("resultAssetId"))),
                        "amount": event.get("resultAmount").or_else(|| event.get("result").and_then(|r| r.get("resultAmount"))),
                    }))
                });
                failure_reason = None;
            }
            "destination-execution-failed" => {
                status = "failed";
                failure_reason = event
                    .get("reason")
                    .or_else(|| event.get("result").and_then(|r| r.get("failureReasonHash")))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            "intent-cancelled" => status = "cancelled",
            "refund-issued" => {
                status = "refunded";
                refund = Some(json!({
                    "asset": event.get("refundAsset").or_else(|| event.get("result").and_then(|r| r.get("refundAsset"))),
                    "amount": event.get("refundAmount").or_else(|| event.get("result").and_then(|r| r.get("refundAmount"))),
                }));
            }
            _ => {}
        }
    }

    if let Some(record) = source_intent {
        if status == "unknown" {
            status = source_intent_status_label(&record.status);
        }
    }

    json!({
        "intentId": intent_id,
        "status": status,
        "result": result,
        "failureReason": failure_reason,
        "refund": refund,
    })
}

async fn enqueue_job(
    job_store: &JobStore,
    job_type: JobType,
    payload: JobPayload,
    max_attempts: u32,
) -> Result<Job, String> {
    let job_id = deterministic_job_id(&job_type, &payload)?;
    if let Some(existing) = job_store.get(&job_id).await {
        return Ok(existing);
    }

    let timestamp = now_millis();
    job_store
        .upsert(Job {
            id: job_id,
            job_type,
            status: JobStatus::Queued,
            attempts: 0,
            max_attempts,
            created_at: timestamp,
            updated_at: timestamp,
            next_attempt_at: Some(timestamp),
            payload,
            result: None,
            last_error: None,
            completed_at: None,
        })
        .await
}

async fn process_ready_jobs(state: Arc<RelayerState>) -> Result<(), String> {
    let mut jobs = state.job_store.list().await;
    jobs.sort_by(compare_jobs);
    let now = now_millis();

    for job in jobs.into_iter().filter(|job| is_ready(job, now)) {
        let Some(mut current) = state.job_store.get(&job.id).await else {
            continue;
        };
        if !is_ready(&current, now) {
            continue;
        }

        current.status = JobStatus::Running;
        current.attempts += 1;
        current.updated_at = now_millis();
        current.last_error = None;
        state.job_store.upsert(current.clone()).await?;

        match run_job(Arc::clone(&state), &current).await {
            Ok(result) => {
                if let Err(error) =
                    record_source_intent_progress(&state.job_store, &current.payload, &result).await
                {
                    let should_retry = current.attempts < current.max_attempts;
                    let failed = Job {
                        status: JobStatus::Failed,
                        updated_at: now_millis(),
                        next_attempt_at: should_retry
                            .then(|| now_millis().saturating_add(state.retry_delay_ms)),
                        last_error: Some(error),
                        ..current.clone()
                    };
                    state.job_store.upsert(failed).await?;
                    continue;
                }
                let finished = Job {
                    status: JobStatus::Completed,
                    updated_at: now_millis(),
                    completed_at: Some(now_millis()),
                    next_attempt_at: None,
                    result: Some(result.clone()),
                    ..current.clone()
                };
                state.job_store.upsert(finished.clone()).await?;
                append_status_event(&state.event_log_path, status_event(&finished, &result))?;
                if let Some(event) = destination_execution_started_event(&current.payload, &result) {
                    append_status_event(&state.event_log_path, event)?;
                }
            }
            Err(error) => {
                let should_retry = current.attempts < current.max_attempts;
                let failed = Job {
                    status: JobStatus::Failed,
                    updated_at: now_millis(),
                    next_attempt_at: should_retry
                        .then(|| now_millis().saturating_add(state.retry_delay_ms)),
                    last_error: Some(error.clone()),
                    ..current
                };
                state.job_store.upsert(failed).await?;
            }
        }
    }

    Ok(())
}

async fn monitor_dispatched_source_intents(state: Arc<RelayerState>) -> Result<(), String> {
    let records = state.job_store.list_source_intents().await;
    for record in records {
        if record.status != crate::store::SourceIntentStatus::Dispatched {
            continue;
        }

        let Some(target) = settlement_target_from_record(&record)? else {
            continue;
        };
        if !supports_destination_balance_observation(&target) {
            continue;
        }
        if state
            .job_store
            .has_job_for_intent_type(JobType::Settle, &record.intent_id)
            .await
        {
            continue;
        }

        let rpc_url = state
            .observation_rpcs()
            .get(&target.chain_key)
            .cloned()
            .ok_or_else(|| format!("missing destination observation rpc for {}", target.chain_key))?;
        let current_balance = read_substrate_destination_balance(
            &state.node_bin,
            &state.substrate_balance_script,
            &rpc_url,
            &target.chain_key,
            &target.asset,
            &target.recipient,
        )?;
        let delivered_amount = current_balance.saturating_sub(target.balance_before.unwrap_or(0));
        if delivered_amount < target.minimum_amount {
            continue;
        }

        enqueue_job(
            &state.job_store,
            JobType::Settle,
            JobPayload::Settle {
                intent_id: record.intent_id.clone(),
                outcome_reference: settlement_outcome_reference(&record),
                result_asset_id: settlement_result_asset_id(&target.asset),
                result_amount: delivered_amount.to_string(),
            },
            state.max_attempts,
        )
        .await?;
    }

    Ok(())
}

async fn run_job(state: Arc<RelayerState>, job: &Job) -> Result<Value, String> {
    let deployment_profile = state.deployment_profile;
    let payload = job.payload.clone();
    let source_chain = resolve_source_chain_for_payload(&state.job_store, &payload).await?;
    let source_intent = source_intent_for_payload(&state.job_store, &payload).await;
    let execution_context = if job_requires_execution_context(&payload, source_intent.as_ref()) {
        Some(state.execution_context_for_chain(&source_chain)?)
    } else {
        None
    };
    let gas_limit = state.gas_limit;
    let node_bin = state.node_bin.clone();
    let substrate_dispatch_script = state.substrate_dispatch_script.clone();
    let substrate_balance_script = state.substrate_balance_script.clone();
    let evm_transaction_script = state.evm_transaction_script.clone();
    let observation_rpcs = state.observation_rpcs();
    task::spawn_blocking(move || {
        run_job_blocking(
            deployment_profile,
            &source_chain,
            execution_context,
            observation_rpcs,
            gas_limit,
            payload,
            source_intent,
            &node_bin,
            &substrate_dispatch_script,
            &substrate_balance_script,
            &evm_transaction_script,
        )
    })
    .await
    .map_err(|error| format!("job worker failed: {error}"))?
}

fn run_job_blocking(
    _deployment_profile: DeploymentProfile,
    chain_key: &str,
    execution_context: Option<ExecutionContext>,
    observation_rpcs: BTreeMap<String, String>,
    gas_limit: Option<u64>,
    payload: JobPayload,
    source_intent_record: Option<SourceIntentRecord>,
    node_bin: &str,
    substrate_dispatch_script: &Path,
    substrate_balance_script: &Path,
    evm_transaction_script: &Path,
) -> Result<Value, String> {
    match payload {
        JobPayload::Dispatch {
            intent_id,
            wire_intent: _,
            request,
            source_intent,
            moonbeam_dispatch,
            source_dispatch,
        } => {
            let settlement_balance_before = read_settlement_balance_before(
                source_intent.as_ref(),
                &observation_rpcs,
                node_bin,
                substrate_balance_script,
            )?;
            if is_substrate_source_metadata(source_intent.as_ref()) {
                if let Some(registered_dispatch) = source_dispatch {
                    return Ok(json!({
                        "intentId": intent_id,
                        "sourceChain": chain_key,
                        "txHash": registered_dispatch.tx_hash,
                        "strategy": registered_dispatch
                            .strategy
                            .unwrap_or_else(|| "substrate-source-dispatch".to_owned()),
                        "settlementBalanceBefore": settlement_balance_before.map(|value| value.to_string()),
                        "request": request,
                    }));
                }

                let execution_context = execution_context.as_ref().ok_or_else(|| {
                    format!("missing execution context for source chain {chain_key}")
                })?;
                return dispatch_substrate_source_intent(
                    &intent_id,
                    chain_key,
                    execution_context,
                    &request,
                    source_intent.as_ref(),
                    settlement_balance_before,
                    node_bin,
                    substrate_dispatch_script,
                );
            }

            let execution_context = execution_context
                .as_ref()
                .ok_or_else(|| format!("missing execution context for source chain {chain_key}"))?;
            let router_address = resolve_source_router_address(
                execution_context,
                source_intent_record.as_ref(),
                source_intent.as_ref(),
            );

            if chain_key == "moonbeam" {
                let source_intent = source_intent.as_ref().ok_or_else(|| {
                    format!("moonbeam source dispatch requires sourceIntent metadata for {intent_id}")
                })?;
                let moonbeam_dispatch = moonbeam_dispatch.as_ref().ok_or_else(|| {
                    format!("moonbeam source dispatch requires moonbeamDispatch metadata for {intent_id}")
                })?;
                return dispatch_moonbeam_intent_with_batch(
                    &intent_id,
                    execution_context,
                    router_address,
                    &request,
                    source_intent,
                    moonbeam_dispatch,
                    settlement_balance_before,
                    node_bin,
                    evm_transaction_script,
                    gas_limit,
                );
            }

            let tx_hash = send_transaction(
                router_address,
                DISPATCH_INTENT_SIGNATURE,
                &[intent_id.clone(), format_dispatch_request_tuple(&request)],
                &execution_context.rpc_url,
                &execution_context.private_key,
                gas_limit,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "sourceChain": chain_key,
                "txHash": tx_hash,
                "strategy": "router-dispatch",
                "targetAddress": router_address,
                "settlementBalanceBefore": settlement_balance_before.map(|value| value.to_string()),
                "request": request,
            }))
        }
        JobPayload::Settle {
            intent_id,
            outcome_reference,
            result_asset_id,
            result_amount,
        } => {
            if is_substrate_source_record(source_intent_record.as_ref()) {
                let record =
                    require_substrate_source_intent(source_intent_record.as_ref(), &intent_id)?;
                assert_source_intent_status(&record, &intent_id, "dispatched")?;
                assert_result_amount_meets_minimum(&record, &result_amount)?;
                return Ok(json!({
                    "intentId": intent_id,
                    "sourceChain": chain_key,
                    "strategy": "substrate-source-settlement",
                    "outcomeReference": outcome_reference,
                    "resultAssetId": result_asset_id,
                    "resultAmount": result_amount,
                }));
            }

            let execution_context = execution_context
                .as_ref()
                .ok_or_else(|| format!("missing execution context for source chain {chain_key}"))?;
            let router_address =
                resolve_source_router_address(execution_context, source_intent_record.as_ref(), None);
            let settle_signature = if chain_key == "moonbeam"
                || should_use_external_settlement(
                    router_address,
                    &execution_context.rpc_url,
                    &intent_id,
                )?
            {
                FINALIZE_EXTERNAL_SUCCESS_SIGNATURE
            } else {
                FINALIZE_SUCCESS_SIGNATURE
            };
            let tx_hash = send_transaction(
                router_address,
                settle_signature,
                &[
                    intent_id.clone(),
                    outcome_reference.clone(),
                    result_asset_id.clone(),
                    result_amount.clone(),
                ],
                &execution_context.rpc_url,
                &execution_context.private_key,
                gas_limit,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "sourceChain": chain_key,
                "txHash": tx_hash,
                "routerAddress": router_address,
                "settlementStrategy": if settle_signature == FINALIZE_EXTERNAL_SUCCESS_SIGNATURE {
                    "external-success"
                } else {
                    "router-success"
                },
                "outcomeReference": outcome_reference,
                "resultAssetId": result_asset_id,
                "resultAmount": result_amount,
            }))
        }
        JobPayload::Fail {
            intent_id,
            outcome_reference,
            failure_reason_hash,
        } => {
            if is_substrate_source_record(source_intent_record.as_ref()) {
                let record =
                    require_substrate_source_intent(source_intent_record.as_ref(), &intent_id)?;
                assert_source_intent_status(&record, &intent_id, "dispatched")?;
                return Ok(json!({
                    "intentId": intent_id,
                    "sourceChain": chain_key,
                    "strategy": "substrate-source-failure",
                    "outcomeReference": outcome_reference,
                    "failureReasonHash": failure_reason_hash,
                }));
            }

            let execution_context = execution_context
                .as_ref()
                .ok_or_else(|| format!("missing execution context for source chain {chain_key}"))?;
            let router_address =
                resolve_source_router_address(execution_context, source_intent_record.as_ref(), None);
            let tx_hash = send_transaction(
                router_address,
                FINALIZE_FAILURE_SIGNATURE,
                &[
                    intent_id.clone(),
                    outcome_reference.clone(),
                    failure_reason_hash.clone(),
                ],
                &execution_context.rpc_url,
                &execution_context.private_key,
                gas_limit,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "sourceChain": chain_key,
                "txHash": tx_hash,
                "routerAddress": router_address,
                "outcomeReference": outcome_reference,
                "failureReasonHash": failure_reason_hash,
            }))
        }
        JobPayload::Refund {
            intent_id,
            refund_amount,
            refund_asset,
        } => {
            if is_substrate_source_record(source_intent_record.as_ref()) {
                let record =
                    require_substrate_source_intent(source_intent_record.as_ref(), &intent_id)?;
                assert_source_intent_status(&record, &intent_id, "failed")?;
                let resolved_refund_asset =
                    resolve_substrate_refund_asset(&record, refund_asset.as_deref());
                assert_refund_amount_allowed(&record, &refund_amount)?;
                return Ok(json!({
                    "intentId": intent_id,
                    "sourceChain": chain_key,
                    "strategy": "substrate-source-refund",
                    "refundAmount": refund_amount,
                    "refundAsset": resolved_refund_asset,
                }));
            }

            let execution_context = execution_context
                .as_ref()
                .ok_or_else(|| format!("missing execution context for source chain {chain_key}"))?;
            let router_address =
                resolve_source_router_address(execution_context, source_intent_record.as_ref(), None);
            let tx_hash = send_transaction(
                router_address,
                REFUND_FAILED_INTENT_SIGNATURE,
                &[intent_id.clone(), refund_amount.clone()],
                &execution_context.rpc_url,
                &execution_context.private_key,
                gas_limit,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "sourceChain": chain_key,
                "txHash": tx_hash,
                "routerAddress": router_address,
                "refundAmount": refund_amount,
                "refundAsset": refund_asset,
            }))
        }
    }
}

async fn source_intent_for_payload(
    job_store: &JobStore,
    payload: &JobPayload,
) -> Option<SourceIntentRecord> {
    match payload {
        JobPayload::Dispatch { intent_id, .. }
        | JobPayload::Settle { intent_id, .. }
        | JobPayload::Fail { intent_id, .. }
        | JobPayload::Refund { intent_id, .. } => job_store.source_intent(intent_id).await,
    }
}

async fn record_source_intent_progress(
    job_store: &JobStore,
    payload: &JobPayload,
    result: &Value,
) -> Result<(), String> {
    match payload {
        JobPayload::Dispatch {
            intent_id,
            source_intent,
            ..
        } if source_intent.is_some() => {
            let tx_hash = result
                .get("txHash")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("missing txHash in dispatch result for {intent_id}"))?;
            let settlement_balance_before = result
                .get("settlementBalanceBefore")
                .and_then(Value::as_str);
            let strategy = result
                .get("strategy")
                .and_then(Value::as_str)
                .map(str::to_owned);
            job_store
                .mark_source_intent_dispatched(
                    intent_id,
                    Some(&xroute_service_shared::SourceDispatchMetadata {
                        tx_hash: tx_hash.to_owned(),
                        strategy,
                    }),
                    settlement_balance_before,
                )
                .await
        }
        JobPayload::Settle {
            intent_id,
            outcome_reference,
            result_asset_id,
            result_amount,
        } => {
            if job_store.source_intent(intent_id).await.is_some() {
                job_store
                    .mark_source_intent_settled(
                        intent_id,
                        outcome_reference,
                        result_asset_id,
                        result_amount,
                    )
                    .await?;
            }
            Ok(())
        }
        JobPayload::Fail {
            intent_id,
            outcome_reference,
            failure_reason_hash,
        } => {
            if job_store.source_intent(intent_id).await.is_some() {
                job_store
                    .mark_source_intent_failed(
                        intent_id,
                        outcome_reference,
                        failure_reason_hash,
                    )
                    .await?;
            }
            Ok(())
        }
        JobPayload::Refund {
            intent_id,
            refund_amount,
            refund_asset,
        } => {
            if job_store.source_intent(intent_id).await.is_some() {
                job_store
                    .mark_source_intent_refunded(
                        intent_id,
                        refund_amount,
                        refund_asset.as_deref(),
                    )
                    .await?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn job_requires_execution_context(
    payload: &JobPayload,
    source_intent: Option<&SourceIntentRecord>,
) -> bool {
    match payload {
        JobPayload::Dispatch {
            source_intent,
            source_dispatch,
            ..
        } => {
            if is_substrate_source_metadata(source_intent.as_ref()) {
                source_dispatch.is_none()
            } else {
                true
            }
        }
        _ => !is_substrate_source_record(source_intent),
    }
}

fn is_substrate_source_metadata(
    metadata: Option<&xroute_service_shared::SourceIntentMetadata>,
) -> bool {
    metadata
        .map(|value| value.kind == "substrate-source")
        .unwrap_or(false)
}

fn is_substrate_source_record(record: Option<&SourceIntentRecord>) -> bool {
    record
        .map(|value| value.kind == "substrate-source")
        .unwrap_or(false)
}

fn require_substrate_source_intent(
    record: Option<&SourceIntentRecord>,
    intent_id: &str,
) -> Result<SourceIntentRecord, String> {
    record
        .cloned()
        .ok_or_else(|| format!("missing substrate source intent record for {intent_id}"))
}

fn assert_source_intent_status(
    record: &SourceIntentRecord,
    intent_id: &str,
    expected_status: &str,
) -> Result<(), String> {
    let current_status = source_intent_status_label(&record.status);
    if current_status == expected_status {
        return Ok(());
    }

    Err(format!(
        "source intent {intent_id} is {current_status}; expected {expected_status}"
    ))
}

fn source_intent_status_label(status: &crate::store::SourceIntentStatus) -> &'static str {
    match status {
        crate::store::SourceIntentStatus::Submitted => "submitted",
        crate::store::SourceIntentStatus::Dispatched => "dispatched",
        crate::store::SourceIntentStatus::Settled => "settled",
        crate::store::SourceIntentStatus::Failed => "failed",
        crate::store::SourceIntentStatus::Refunded => "refunded",
    }
}

fn assert_result_amount_meets_minimum(
    record: &SourceIntentRecord,
    result_amount: &str,
) -> Result<(), String> {
    let minimum = parse_stored_u128(&record.min_output_amount, "minOutputAmount")?;
    let candidate = parse_stored_u128(result_amount, "resultAmount")?;
    if candidate < minimum {
        return Err(format!(
            "resultAmount {candidate} is below minOutputAmount {minimum}"
        ));
    }

    Ok(())
}

fn assert_refund_amount_allowed(
    record: &SourceIntentRecord,
    refund_amount: &str,
) -> Result<(), String> {
    let candidate = parse_stored_u128(refund_amount, "refundAmount")?;
    let refundable = parse_stored_u128(&record.refundable_amount, "refundableAmount")?;
    let already_refunded = parse_stored_u128(&record.refund_amount, "storedRefundAmount")?;
    let remaining = refundable.saturating_sub(already_refunded);
    if candidate == 0 || candidate != remaining {
        return Err(format!(
            "refundAmount {candidate} must equal refundable amount {remaining}"
        ));
    }

    Ok(())
}

fn source_chain_requires_source_intent_metadata(chain_key: &str) -> bool {
    matches!(chain_key, "hydration" | "bifrost" | "moonbeam")
}

fn resolve_substrate_refund_asset(
    record: &SourceIntentRecord,
    refund_asset: Option<&str>,
) -> String {
    refund_asset
        .map(str::to_owned)
        .unwrap_or_else(|| record.refund_asset.clone())
}

#[derive(Debug, Clone)]
struct SettlementObservationTarget {
    chain_key: String,
    asset: String,
    recipient: String,
    minimum_amount: u128,
    balance_before: Option<u128>,
}

fn read_settlement_balance_before(
    metadata: Option<&SourceIntentMetadata>,
    observation_rpcs: &BTreeMap<String, String>,
    node_bin: &str,
    substrate_balance_script: &Path,
) -> Result<Option<u128>, String> {
    let Some(target) = settlement_target_from_metadata(metadata)? else {
        return Ok(None);
    };
    if !supports_destination_balance_observation(&target) {
        return Ok(None);
    }
    let rpc_url = observation_rpcs
        .get(&target.chain_key)
        .ok_or_else(|| format!("missing destination observation rpc for {}", target.chain_key))?;

    read_substrate_destination_balance(
        node_bin,
        substrate_balance_script,
        rpc_url,
        &target.chain_key,
        &target.asset,
        &target.recipient,
    )
    .map(Some)
}

fn settlement_target_from_metadata(
    metadata: Option<&SourceIntentMetadata>,
) -> Result<Option<SettlementObservationTarget>, String> {
    let Some(metadata) = metadata else {
        return Ok(None);
    };
    let (Some(chain_key), Some(asset), Some(recipient)) = (
        metadata.settlement_chain.as_deref(),
        metadata.settlement_asset.as_deref(),
        metadata.settlement_recipient.as_deref(),
    ) else {
        return Ok(None);
    };
    let minimum_amount = metadata
        .minimum_settlement_amount
        .as_deref()
        .map(|value| parse_stored_u128(value, "minimumSettlementAmount"))
        .transpose()?
        .unwrap_or(0);

    Ok(Some(SettlementObservationTarget {
        chain_key: normalize_chain_key(chain_key)?,
        asset: asset.trim().to_ascii_uppercase(),
        recipient: recipient.trim().to_owned(),
        minimum_amount,
        balance_before: None,
    }))
}

fn settlement_target_from_record(
    record: &SourceIntentRecord,
) -> Result<Option<SettlementObservationTarget>, String> {
    let (Some(chain_key), Some(asset), Some(recipient), Some(balance_before)) = (
        record.settlement_chain.as_deref(),
        record.settlement_asset.as_deref(),
        record.settlement_recipient.as_deref(),
        record.settlement_balance_before.as_deref(),
    ) else {
        return Ok(None);
    };

    Ok(Some(SettlementObservationTarget {
        chain_key: normalize_chain_key(chain_key)?,
        asset: asset.trim().to_ascii_uppercase(),
        recipient: recipient.trim().to_owned(),
        minimum_amount: record
            .minimum_settlement_amount
            .as_deref()
            .map(|value| parse_stored_u128(value, "minimumSettlementAmount"))
            .transpose()?
            .unwrap_or(0),
        balance_before: Some(parse_stored_u128(balance_before, "settlementBalanceBefore")?),
    }))
}

fn supports_destination_balance_observation(target: &SettlementObservationTarget) -> bool {
    if target.recipient.starts_with("0x") {
        return false;
    }

    matches!(
        (target.chain_key.as_str(), target.asset.as_str()),
        ("hydration", "DOT")
            | ("hydration", "USDT")
            | ("hydration", "HDX")
            | ("bifrost", "BNC")
            | ("polkadot-hub", "DOT")
    )
}

fn resolve_source_router_address<'a>(
    execution_context: &'a ExecutionContext,
    record: Option<&'a SourceIntentRecord>,
    metadata: Option<&'a xroute_service_shared::SourceIntentMetadata>,
) -> &'a str {
    record
        .and_then(|value| value.router_address.as_deref())
        .or_else(|| metadata.and_then(|value| value.router_address.as_deref()))
        .unwrap_or(&execution_context.router_address)
}

fn parse_stored_u128(value: &str, field: &str) -> Result<u128, String> {
    value
        .trim()
        .parse::<u128>()
        .map_err(|error| format!("invalid {field}: {error}"))
}

fn send_transaction(
    contract_address: &str,
    signature: &str,
    args: &[String],
    rpc_url: &str,
    private_key: &str,
    gas_limit: Option<u64>,
) -> Result<String, String> {
    let mut command = Command::new("cast");
    command.arg("send");
    command.arg(contract_address);
    command.arg(signature);
    for arg in args {
        command.arg(arg);
    }
    command
        .arg("--rpc-url")
        .arg(rpc_url)
        .arg("--private-key")
        .arg(private_key);
    if let Some(gas_limit) = gas_limit {
        command.arg("--gas-limit").arg(gas_limit.to_string());
    }
    command.arg("--json");
    let output = command
        .output()
        .map_err(|error| format!("failed to run cast send: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    finalize_transaction_result(&stdout, rpc_url)
}

fn finalize_transaction_result(stdout: &str, rpc_url: &str) -> Result<String, String> {
    let tx_hash = extract_transaction_hash(stdout)?;
    let receipt = read_transaction_receipt(&tx_hash, rpc_url)?;

    if !receipt_status_succeeded(&receipt).unwrap_or(false) {
        let revert_reason = extract_revert_reason(&receipt)
            .or_else(|| extract_revert_reason_from_output(stdout))
            .unwrap_or_else(|| format!("transaction {tx_hash} reverted"));
        return Err(revert_reason);
    }

    Ok(tx_hash)
}

fn should_use_external_settlement(
    router_address: &str,
    rpc_url: &str,
    intent_id: &str,
) -> Result<bool, String> {
    if !contract_has_code(router_address, rpc_url)? {
        return Ok(false);
    }

    let output = Command::new("cast")
        .arg("call")
        .arg(router_address)
        .arg("getIntent(bytes32)((address,address,address,uint128,uint128,uint128,uint128,uint128,uint64,uint8,uint8,bytes32,bytes32,bytes32,bytes32,uint128,uint128))")
        .arg(intent_id)
        .arg("--rpc-url")
        .arg(rpc_url)
        .output()
        .map_err(|error| format!("failed to run cast call getIntent: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    let tuple = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let fields = tuple
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(", ")
        .map(|value| {
            value
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_owned()
        })
        .collect::<Vec<_>>();
    if fields.len() != 17 {
        return Err(format!("unexpected getIntent tuple: {tuple}"));
    }

    let asset = fields[1].to_ascii_lowercase();
    let status = fields[10]
        .parse::<u8>()
        .map_err(|error| format!("invalid status in getIntent tuple: {error}"))?;

    Ok(status == 1 && asset == "0x0000000000000000000000000000000000000000")
}

fn contract_has_code(contract_address: &str, rpc_url: &str) -> Result<bool, String> {
    let output = Command::new("cast")
        .arg("code")
        .arg(contract_address)
        .arg("--rpc-url")
        .arg(rpc_url)
        .output()
        .map_err(|error| format!("failed to run cast code: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    let code = String::from_utf8_lossy(&output.stdout).trim().to_ascii_lowercase();
    Ok(!code.is_empty() && code != "0x")
}

impl RelayerState {
    fn execution_context_for_chain(&self, chain_key: &str) -> Result<ExecutionContext, String> {
        let normalized_chain_key = normalize_chain_key(chain_key)?;
        if normalized_chain_key == self.primary_chain_key {
            return Ok(self.primary_execution_context.clone());
        }

        self.execution_contexts
            .get(&normalized_chain_key)
            .cloned()
            .ok_or_else(|| missing_execution_context_message(&normalized_chain_key))
    }

    fn observation_rpcs(&self) -> BTreeMap<String, String> {
        let mut rpc_by_chain = BTreeMap::new();
        rpc_by_chain.insert(
            self.primary_chain_key.clone(),
            self.primary_execution_context
                .observation_rpc_url
                .clone()
                .unwrap_or_else(|| self.primary_execution_context.rpc_url.clone()),
        );
        for (chain_key, context) in &self.execution_contexts {
            rpc_by_chain.insert(
                chain_key.clone(),
                context
                    .observation_rpc_url
                    .clone()
                    .unwrap_or_else(|| context.rpc_url.clone()),
            );
        }

        rpc_by_chain
    }

    fn execution_context_summary(&self) -> Value {
        let mut contexts = BTreeMap::new();
        contexts.insert(
            self.primary_chain_key.clone(),
            execution_context_to_json(&self.primary_execution_context),
        );
        for (chain_key, context) in &self.execution_contexts {
            contexts.insert(chain_key.clone(), execution_context_to_json(context));
        }

        json!(contexts)
    }
}

async fn resolve_source_chain_for_payload(
    job_store: &JobStore,
    payload: &JobPayload,
) -> Result<String, String> {
    match payload {
        JobPayload::Dispatch { wire_intent, .. } => normalize_chain_key(&wire_intent.source_chain),
        JobPayload::Settle { intent_id, .. }
        | JobPayload::Fail { intent_id, .. }
        | JobPayload::Refund { intent_id, .. } => job_store
            .dispatch_source_chain(intent_id)
            .await
            .ok_or_else(|| {
                format!(
                    "missing source-chain context for intent {intent_id}; dispatch this intent before running settlement jobs",
                )
            })
            .and_then(|chain_key| normalize_chain_key(&chain_key)),
    }
}

fn env_prefix_for_chain(chain_key: &str) -> String {
    chain_key
        .trim()
        .chars()
        .map(|character| match character {
            'a'..='z' => character.to_ascii_uppercase(),
            'A'..='Z' | '0'..='9' => character,
            _ => '_',
        })
        .collect()
}

fn normalize_chain_key(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("source chain must not be empty".to_owned());
    }

    Ok(match normalized.as_str() {
        "asset-hub" => "polkadot-hub".to_owned(),
        "relay" | "polkadot-relay" => "polkadot-relay".to_owned(),
        "bifrost" => "bifrost".to_owned(),
        other => other.to_owned(),
    })
}

fn missing_execution_context_message(chain_key: &str) -> String {
    let env_prefix = env_prefix_for_chain(chain_key);
    if chain_uses_substrate_dispatch(chain_key) {
        return format!(
            "missing execution context for source chain {chain_key}; configure {}",
            chain_env_name(&env_prefix, "RPC_URL"),
        );
    }

    format!(
        "missing execution context for source chain {chain_key}; configure {} and {}",
        chain_env_name(&env_prefix, "RPC_URL"),
        chain_env_name(&env_prefix, "ROUTER_ADDRESS"),
    )
}

fn chain_uses_substrate_dispatch(chain_key: &str) -> bool {
    matches!(chain_key, "hydration" | "bifrost")
}

fn chain_env_name(env_prefix: &str, suffix: &str) -> String {
    format!("XROUTE_{}_{}", env_prefix, suffix)
}

fn execution_context_to_json(context: &ExecutionContext) -> Value {
    json!({
        "chainKey": context.chain_key,
        "rpcUrl": context.rpc_url,
        "routerAddress": context.router_address,
        "xcmAddress": context.xcm_address,
    })
}

fn format_dispatch_request_tuple(request: &DispatchRequest) -> String {
    format!(
        "({},{},{})",
        request.mode, request.destination, request.message
    )
}

fn dispatch_moonbeam_intent_with_batch(
    intent_id: &str,
    execution_context: &ExecutionContext,
    router_address: &str,
    request: &xroute_service_shared::DispatchRequest,
    source_intent: &SourceIntentMetadata,
    moonbeam_dispatch: &MoonbeamDispatchMetadata,
    settlement_balance_before: Option<u128>,
    node_bin: &str,
    evm_transaction_script: &Path,
    gas_limit: Option<u64>,
) -> Result<Value, String> {

    let parsed_weight = estimate_moonbeam_message_weight(
        &execution_context.rpc_url,
        &request.message,
    )
    .unwrap_or(0);
    let refundable_amount = source_intent
        .refundable_amount
        .trim()
        .parse::<u128>()
        .map_err(|error| format!("invalid sourceIntent.refundableAmount: {error}"))?;
    let source_asset_address =
        resolve_moonbeam_source_asset_address(execution_context, &moonbeam_dispatch.asset)?;
    let remote_reserve_chain = resolve_moonbeam_remote_reserve_chain(
        &moonbeam_dispatch.asset,
        &moonbeam_dispatch.remote_reserve_chain,
    )?;
    let executor_address = derive_evm_address_from_private_key(&execution_context.private_key)?;
    assert_moonbeam_executor_asset_balance(
        &execution_context.rpc_url,
        &source_asset_address,
        &executor_address,
        refundable_amount,
    )?;

    let router_calldata =
        encode_dispatch_intent_without_xcm_calldata(intent_id, request, parsed_weight)?;
    let xcm_calldata = encode_moonbeam_transfer_assets_calldata(
        &moonbeam_dispatch.destination_chain,
        &source_asset_address,
        refundable_amount,
        &moonbeam_dispatch.custom_xcm_on_dest,
        &remote_reserve_chain,
    )?;
    let batch_calldata = encode_moonbeam_batch_all_calldata(
        router_address,
        &execution_context.xcm_address,
        &router_calldata,
        &xcm_calldata,
    )?;

    let tx_hash = send_raw_evm_transaction_with_helper(
        node_bin,
        evm_transaction_script,
        MOONBEAM_BATCH_PRECOMPILE_ADDRESS,
        &batch_calldata,
        &execution_context.rpc_url,
        &execution_context.private_key,
        gas_limit,
    )?;

    Ok(json!({
        "intentId": intent_id,
        "sourceChain": "moonbeam",
        "txHash": tx_hash,
        "strategy": "moonbeam-batch-dispatch",
        "routerAddress": router_address,
        "targetAddress": MOONBEAM_BATCH_PRECOMPILE_ADDRESS,
        "xcmAddress": execution_context.xcm_address.to_ascii_lowercase(),
        "asset": moonbeam_dispatch.asset,
        "destinationChain": moonbeam_dispatch.destination_chain,
        "remoteReserveChain": remote_reserve_chain,
        "settlementBalanceBefore": settlement_balance_before.map(|value| value.to_string()),
        "request": request,
    }))
}

fn resolve_moonbeam_source_asset_address(
    execution_context: &ExecutionContext,
    asset_symbol: &str,
) -> Result<String, String> {
    match asset_symbol.trim().to_ascii_uppercase().as_str() {
        "DOT" => execution_context
            .moonbeam_xcdot_asset_address
            .clone()
            .ok_or_else(|| {
                "missing moonbeam xcDOT asset address; configure XROUTE_MOONBEAM_XCDOT_ASSET_ADDRESS or moonbeam deployment settings".to_owned()
            }),
        "VDOT" => execution_context
            .moonbeam_vdot_asset_address
            .clone()
            .ok_or_else(|| {
                "missing moonbeam VDOT asset address; configure XROUTE_MOONBEAM_VDOT_ASSET_ADDRESS or moonbeam deployment settings".to_owned()
            }),
        "BNC" => execution_context
            .moonbeam_xcbnc_asset_address
            .clone()
            .ok_or_else(|| {
                "missing moonbeam xcBNC asset address; configure XROUTE_MOONBEAM_XCBNC_ASSET_ADDRESS or moonbeam deployment settings".to_owned()
            }),
        other => Err(format!("unsupported moonbeam source asset: {other}")),
    }
}

fn resolve_moonbeam_remote_reserve_chain(
    asset_symbol: &str,
    requested_remote_reserve_chain: &str,
) -> Result<String, String> {
    match asset_symbol.trim().to_ascii_uppercase().as_str() {
        "DOT" => Ok("polkadot-relay".to_owned()),
        "BNC" | "VDOT" => Ok("bifrost".to_owned()),
        _ => normalize_chain_key(requested_remote_reserve_chain),
    }
}

fn encode_moonbeam_transfer_assets_calldata(
    destination_chain: &str,
    asset_address: &str,
    refundable_amount: u128,
    custom_xcm_on_dest: &str,
    remote_reserve_chain: &str,
) -> Result<String, String> {
    encode_abi_call(
        MOONBEAM_TRANSFER_ASSETS_SELECTOR,
        &[
            AbiArg::Dynamic(encode_moonbeam_multilocation_relative(
                remote_reserve_chain,
                "moonbeam",
            )?),
            AbiArg::Dynamic(encode_moonbeam_asset_array(asset_address, refundable_amount)?),
            AbiArg::Static(encode_u256_word(0)),
            AbiArg::Dynamic(encode_abi_bytes(custom_xcm_on_dest)?),
            AbiArg::Dynamic(encode_moonbeam_multilocation_relative(
                remote_reserve_chain,
                "moonbeam",
            )?),
        ],
    )
}

fn encode_dispatch_intent_without_xcm_calldata(
    intent_id: &str,
    request: &DispatchRequest,
    weight: u64,
) -> Result<String, String> {
    encode_abi_call(
        DISPATCH_INTENT_WITHOUT_XCM_SELECTOR,
        &[
            AbiArg::Static(encode_bytes32_word(intent_id, "intentId")?),
            AbiArg::Dynamic(encode_dispatch_request_tuple(request)?),
            AbiArg::Static(encode_u256_word(weight as u128)),
        ],
    )
}

fn encode_moonbeam_batch_all_calldata(
    router_address: &str,
    xcm_address: &str,
    router_calldata: &str,
    xcm_calldata: &str,
) -> Result<String, String> {
    encode_abi_call(
        MOONBEAM_BATCH_ALL_SELECTOR,
        &[
            AbiArg::Dynamic(encode_address_array(&[
                router_address.to_owned(),
                xcm_address.to_owned(),
            ])?),
            AbiArg::Dynamic(encode_u256_array(&[0, 0])),
            AbiArg::Dynamic(encode_abi_bytes_array(&[
                router_calldata.to_owned(),
                xcm_calldata.to_owned(),
            ])?),
            AbiArg::Dynamic(encode_u256_array(&[0, 0])),
        ],
    )
}

enum AbiArg {
    Static(String),
    Dynamic(String),
}

fn encode_abi_call(selector: &str, args: &[AbiArg]) -> Result<String, String> {
    let selector = selector.trim_start_matches("0x");
    if selector.len() != 8 {
        return Err(format!("invalid ABI selector: 0x{selector}"));
    }

    let mut head = String::new();
    let mut tail = String::new();
    let mut next_offset = 32usize
        .checked_mul(args.len())
        .ok_or_else(|| "ABI head overflow".to_owned())?;

    for arg in args {
        match arg {
            AbiArg::Static(word) => head.push_str(word),
            AbiArg::Dynamic(encoded) => {
                head.push_str(&encode_u256_word(next_offset as u128));
                next_offset = next_offset
                    .checked_add(encoded.len() / 2)
                    .ok_or_else(|| "ABI tail overflow".to_owned())?;
                tail.push_str(encoded);
            }
        }
    }

    Ok(format!("0x{selector}{head}{tail}"))
}

fn encode_moonbeam_multilocation_relative(
    target_chain: &str,
    current_chain: &str,
) -> Result<String, String> {
    let normalized_target_chain = normalize_chain_key(target_chain)?;
    let normalized_current_chain = normalize_chain_key(current_chain)?;

    let (parents, interior) = if normalized_target_chain == normalized_current_chain {
        (0u128, encode_abi_bytes_array(&[])?)
    } else {
        let parents = match normalized_current_chain.as_str() {
            "moonbeam" => 1u128,
            "polkadot-relay" => 0u128,
            "polkadot-hub" | "hydration" | "bifrost" => 1u128,
            other => {
                return Err(format!(
                    "unsupported moonbeam multilocation current chain: {other}"
                ))
            }
        };

        let junction = match normalized_target_chain.as_str() {
            "polkadot-relay" => None,
            "polkadot-hub" => Some(1000u32),
            "hydration" => Some(2034u32),
            "bifrost" => Some(2030u32),
            "moonbeam" => Some(2004u32),
            other => {
                return Err(format!(
                    "unsupported moonbeam destination/reserve chain: {other}"
                ))
            }
        };

        let interior = match junction {
            Some(parachain_id) => encode_abi_bytes_array(&[format!(
                "0x00{}",
                bytes_to_lower_hex(&parachain_id.to_be_bytes()),
            )])?,
            None => encode_abi_bytes_array(&[])?,
        };

        (parents, interior)
    };
    let tuple_tail = format!(
        "{}{}{}",
        encode_u256_word(parents),
        encode_u256_word(64),
        interior
    );
    Ok(tuple_tail)
}

fn encode_dispatch_request_tuple(request: &DispatchRequest) -> Result<String, String> {
    let destination = encode_abi_bytes(&request.destination)?;
    let message = encode_abi_bytes(&request.message)?;
    let message_offset = 96usize
        .checked_add(destination.len() / 2)
        .ok_or_else(|| "dispatch request tuple overflow".to_owned())?;

    Ok(format!(
        "{}{}{}{}{}",
        encode_u256_word(u128::from(request.mode)),
        encode_u256_word(96),
        encode_u256_word(message_offset as u128),
        destination,
        message,
    ))
}

fn estimate_moonbeam_message_weight(rpc_url: &str, message: &str) -> Result<u64, String> {
    let mut weight_cmd = Command::new("cast");
    weight_cmd
        .arg("call")
        .arg(MOONBEAM_XCM_UTILS_ADDRESS)
        .arg("weightMessage(bytes)")
        .arg(message)
        .arg("--rpc-url")
        .arg(rpc_url);

    let output = weight_cmd
        .output()
        .map_err(|error| format!("failed to estimate Moonbeam weight: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Moonbeam weight estimation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    parse_u64_scalar(
        String::from_utf8_lossy(&output.stdout).trim(),
        "moonbeam weight",
    )
}

fn encode_moonbeam_asset_array(asset_address: &str, amount: u128) -> Result<String, String> {
    let normalized_address = normalize_evm_address(asset_address, "moonbeam source asset address")?;
    Ok(format!(
        "{}{}{}",
        encode_u256_word(1),
        encode_address_word(&normalized_address)?,
        encode_u256_word(amount),
    ))
}

fn encode_address_array(values: &[String]) -> Result<String, String> {
    let mut encoded = encode_u256_word(values.len() as u128);
    for value in values {
        encoded.push_str(&encode_address_word(value)?);
    }

    Ok(encoded)
}

fn encode_u256_array(values: &[u128]) -> String {
    let mut encoded = encode_u256_word(values.len() as u128);
    for value in values {
        encoded.push_str(&encode_u256_word(*value));
    }

    encoded
}

fn encode_abi_bytes_array(values: &[String]) -> Result<String, String> {
    let mut head = String::new();
    let mut tail = String::new();
    let mut next_offset = 32usize
        .checked_mul(values.len())
        .ok_or_else(|| "ABI bytes[] head overflow".to_owned())?;

    for value in values {
        let encoded = encode_abi_bytes(value)?;
        head.push_str(&encode_u256_word(next_offset as u128));
        next_offset = next_offset
            .checked_add(encoded.len() / 2)
            .ok_or_else(|| "ABI bytes[] tail overflow".to_owned())?;
        tail.push_str(&encoded);
    }

    Ok(format!("{}{}{}", encode_u256_word(values.len() as u128), head, tail))
}

fn encode_abi_bytes(value: &str) -> Result<String, String> {
    let normalized = strip_hex_prefix(value);
    if normalized.len() % 2 != 0 {
        return Err(format!("invalid hex bytes length: 0x{normalized}"));
    }
    if !normalized.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("invalid hex bytes value: 0x{normalized}"));
    }

    let padded_len = if normalized.is_empty() {
        0
    } else {
        ((normalized.len() + 63) / 64) * 64
    };
    let padded = if padded_len == 0 {
        String::new()
    } else {
        let mut value = normalized.to_owned();
        value.push_str(&"0".repeat(padded_len - normalized.len()));
        value
    };

    Ok(format!(
        "{}{}",
        encode_u256_word((normalized.len() / 2) as u128),
        padded,
    ))
}

fn encode_address_word(value: &str) -> Result<String, String> {
    let normalized = strip_hex_prefix(value);
    if normalized.len() != 40 || !normalized.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(format!("invalid EVM address: {value}"));
    }

    Ok(format!("{normalized:0>64}"))
}

fn encode_bytes32_word(value: &str, field: &str) -> Result<String, String> {
    let normalized = strip_hex_prefix(value);
    if normalized.len() != 64 || !normalized.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err(format!("invalid {field}: {value}"));
    }

    Ok(normalized.to_ascii_lowercase())
}

fn encode_u256_word(value: u128) -> String {
    format!("{value:0>64x}")
}

fn bytes_to_lower_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn normalize_evm_address(value: &str, field: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    let hex = strip_hex_prefix(&normalized);
    if hex.len() != 40 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("invalid {field}: {value}"));
    }

    Ok(format!("0x{hex}"))
}

fn strip_hex_prefix(value: &str) -> &str {
    value.strip_prefix("0x").unwrap_or(value)
}

fn parse_u64_scalar(value: &str, field: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    if let Some(hex) = trimmed.strip_prefix("0x") {
        if hex.is_empty() {
            return Ok(0);
        }
        return u64::from_str_radix(hex, 16)
            .map_err(|error| format!("invalid {field}: {error}"));
    }

    trimmed
        .parse::<u64>()
        .map_err(|error| format!("invalid {field}: {error}"))
}

fn parse_u128_scalar(value: &str, field: &str) -> Result<u128, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(0);
    }
    if let Some(hex) = trimmed.strip_prefix("0x") {
        if hex.is_empty() {
            return Ok(0);
        }
        return u128::from_str_radix(hex, 16)
            .map_err(|error| format!("invalid {field}: {error}"));
    }

    trimmed
        .parse::<u128>()
        .map_err(|error| format!("invalid {field}: {error}"))
}

fn derive_evm_address_from_private_key(private_key: &str) -> Result<String, String> {
    let output = Command::new("cast")
        .arg("wallet")
        .arg("address")
        .arg("--private-key")
        .arg(private_key)
        .output()
        .map_err(|error| format!("failed to derive EVM address from private key: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    normalize_evm_address(
        String::from_utf8_lossy(&output.stdout).trim(),
        "derived executor address",
    )
}

fn read_erc20_balance(rpc_url: &str, asset_address: &str, account_address: &str) -> Result<u128, String> {
    let output = Command::new("cast")
        .arg("call")
        .arg(asset_address)
        .arg("balanceOf(address)")
        .arg(account_address)
        .arg("--rpc-url")
        .arg(rpc_url)
        .output()
        .map_err(|error| format!("failed to run cast call balanceOf: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    parse_u128_scalar(
        String::from_utf8_lossy(&output.stdout).trim(),
        "moonbeam executor asset balance",
    )
}

fn assert_moonbeam_executor_asset_balance(
    rpc_url: &str,
    asset_address: &str,
    executor_address: &str,
    required_amount: u128,
) -> Result<(), String> {
    if !contract_has_code(asset_address, rpc_url)? {
        return Ok(());
    }

    let available_amount = read_erc20_balance(rpc_url, asset_address, executor_address)?;
    if available_amount < required_amount {
        return Err(format!(
            "insufficient moonbeam executor asset balance: need {required_amount}, have {available_amount}, asset {asset_address}, executor {executor_address}"
        ));
    }

    Ok(())
}

fn dispatch_substrate_source_intent(
    intent_id: &str,
    chain_key: &str,
    execution_context: &ExecutionContext,
    request: &xroute_service_shared::DispatchRequest,
    source_intent: Option<&xroute_service_shared::SourceIntentMetadata>,
    settlement_balance_before: Option<u128>,
    node_bin: &str,
    substrate_dispatch_script: &Path,
) -> Result<Value, String> {
    let script_path = substrate_dispatch_script;
    let payload = json!({
        "intentId": intent_id,
        "sourceChain": chain_key,
        "rpcUrl": execution_context.rpc_url,
        "privateKey": execution_context.private_key,
        "request": request,
        "refundAsset": source_intent.map(|metadata| metadata.refund_asset.clone()),
    });

    let mut child = Command::new(node_bin)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to start substrate dispatch helper {} with {}: {error}",
                script_path.display(),
                node_bin
            )
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| {
                format!(
                    "failed to write substrate dispatch payload to {}: {error}",
                    script_path.display()
                )
            })?;
    }

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "failed to read substrate dispatch helper output from {}: {error}",
            script_path.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "substrate dispatch helper {} failed: {}",
            script_path.display(),
            detail
        ));
    }

    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "failed to decode substrate dispatch helper output from {}: {error}",
            script_path.display()
        )
    })?;
    let tx_hash = parsed
        .get("txHash")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "substrate dispatch helper {} did not return txHash",
                script_path.display()
            )
        })?;
    let strategy = parsed
        .get("strategy")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if request.mode == 0 {
                "substrate-xcm-execute"
            } else {
                "substrate-xcm-send"
            }
        });

    Ok(json!({
        "intentId": intent_id,
        "sourceChain": chain_key,
        "txHash": tx_hash,
        "strategy": strategy,
        "settlementBalanceBefore": settlement_balance_before.map(|value| value.to_string()),
        "request": request,
    }))
}

fn send_raw_evm_transaction_with_helper(
    node_bin: &str,
    script_path: &Path,
    to: &str,
    data: &str,
    rpc_url: &str,
    private_key: &str,
    gas_limit: Option<u64>,
) -> Result<String, String> {
    let payload = json!({
        "to": to,
        "data": data,
        "rpcUrl": rpc_url,
        "privateKey": private_key,
        "gasLimit": gas_limit,
    });

    let mut child = Command::new(node_bin)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to start evm transaction helper {} with {}: {error}",
                script_path.display(),
                node_bin
            )
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| {
                format!(
                    "failed to write evm transaction payload to {}: {error}",
                    script_path.display()
                )
            })?;
    }

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "failed to read evm transaction helper output from {}: {error}",
            script_path.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "evm transaction helper {} failed: {}",
            script_path.display(),
            detail
        ));
    }

    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "failed to decode evm transaction helper output from {}: {error}",
            script_path.display()
        )
    })?;
    let tx_hash = parsed
        .get("txHash")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "evm transaction helper {} did not return txHash",
                script_path.display()
            )
        })?;
    Ok(tx_hash.to_ascii_lowercase())
}

fn read_substrate_destination_balance(
    node_bin: &str,
    script_path: &Path,
    rpc_url: &str,
    chain_key: &str,
    asset: &str,
    recipient: &str,
) -> Result<u128, String> {
    let payload = json!({
        "chainKey": chain_key,
        "rpcUrl": rpc_url,
        "asset": asset,
        "recipient": recipient,
    });

    let mut child = Command::new(node_bin)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "failed to start substrate balance helper {} with {}: {error}",
                script_path.display(),
                node_bin
            )
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.to_string().as_bytes())
            .map_err(|error| {
                format!(
                    "failed to write substrate balance payload to {}: {error}",
                    script_path.display()
                )
            })?;
    }

    let output = child.wait_with_output().map_err(|error| {
        format!(
            "failed to read substrate balance helper output from {}: {error}",
            script_path.display()
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "substrate balance helper {} failed: {}",
            script_path.display(),
            detail
        ));
    }

    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "failed to decode substrate balance helper output from {}: {error}",
            script_path.display()
        )
    })?;
    let balance = parsed
        .get("balance")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            format!(
                "substrate balance helper {} did not return balance",
                script_path.display()
            )
        })?;

    parse_stored_u128(balance, "destination balance")
}

fn extract_transaction_hash(value: &str) -> Result<String, String> {
    if let Ok(parsed) = serde_json::from_str::<Value>(value) {
        if let Some(candidate) = parsed
            .get("transactionHash")
            .or_else(|| parsed.get("txHash"))
            .or_else(|| parsed.get("hash"))
            .or_else(|| {
                parsed
                    .get("receipt")
                    .and_then(|receipt| receipt.get("transactionHash"))
            })
            .and_then(Value::as_str)
        {
            return Ok(candidate.to_lowercase());
        }
    }

    value
        .split_whitespace()
        .find(|token| token.starts_with("0x") && token.len() == 66)
        .map(|hash| hash.to_lowercase())
        .ok_or_else(|| format!("unable to parse transaction hash from cast output: {value}"))
}

fn read_transaction_receipt(tx_hash: &str, rpc_url: &str) -> Result<Value, String> {
    let output = Command::new("cast")
        .arg("receipt")
        .arg(tx_hash)
        .arg("--rpc-url")
        .arg(rpc_url)
        .arg("--json")
        .output()
        .map_err(|error| format!("failed to run cast receipt: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("failed to decode cast receipt output: {error}"))
}

fn receipt_status_succeeded(value: &Value) -> Option<bool> {
    let status = value.get("status").or_else(|| {
        value
            .get("receipt")
            .and_then(|receipt| receipt.get("status"))
    })?;

    match status {
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "0x1" | "1" => Some(true),
            "0x0" | "0" => Some(false),
            _ => None,
        },
        Value::Number(number) => number.as_u64().map(|candidate| candidate == 1),
        _ => None,
    }
}

fn extract_revert_reason(value: &Value) -> Option<String> {
    value
        .get("revertReason")
        .or_else(|| {
            value
                .get("receipt")
                .and_then(|receipt| receipt.get("revertReason"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(str::to_owned)
}

fn extract_revert_reason_from_output(value: &str) -> Option<String> {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|parsed| extract_revert_reason(&parsed))
}

fn append_status_event(path: &Path, event: Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create event log directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open event log {}: {error}", path.display()))?;
    writeln!(file, "{event}")
        .map_err(|error| format!("failed to append event log {}: {error}", path.display()))
}

fn destination_execution_started_event(payload: &JobPayload, result: &Value) -> Option<Value> {
    let JobPayload::Dispatch {
        intent_id,
        source_intent: Some(source_intent),
        ..
    } = payload
    else {
        return None;
    };
    let (Some(chain), Some(asset), Some(recipient)) = (
        source_intent.settlement_chain.as_deref(),
        source_intent.settlement_asset.as_deref(),
        source_intent.settlement_recipient.as_deref(),
    ) else {
        return None;
    };

    Some(json!({
        "type": "destination-execution-started",
        "intentId": intent_id,
        "at": now_millis(),
        "result": {
            "chain": chain,
            "asset": asset,
            "recipient": recipient,
            "minimumAmount": source_intent.minimum_settlement_amount,
            "dispatchTxHash": result.get("txHash").and_then(Value::as_str),
        },
    }))
}

fn status_event(job: &Job, result: &Value) -> Value {
    let event_type = match job.job_type {
        JobType::Dispatch => "intent-dispatched",
        JobType::Settle => "destination-execution-succeeded",
        JobType::Fail => "destination-execution-failed",
        JobType::Refund => "refund-issued",
    };

    json!({
        "type": event_type,
        "intentId": intent_id_from_payload(&job.payload),
        "at": now_millis(),
        "result": result,
    })
}

fn intent_id_from_payload(payload: &JobPayload) -> &str {
    match payload {
        JobPayload::Dispatch { intent_id, .. }
        | JobPayload::Settle { intent_id, .. }
        | JobPayload::Fail { intent_id, .. }
        | JobPayload::Refund { intent_id, .. } => intent_id,
    }
}

fn settlement_outcome_reference(record: &SourceIntentRecord) -> String {
    record
        .dispatch_tx_hash
        .clone()
        .unwrap_or_else(|| padded_bytes32_from_text(&format!("settlement:{}", record.intent_id)))
}

fn settlement_result_asset_id(asset_symbol: &str) -> String {
    let normalized = asset_symbol.trim().to_ascii_uppercase();
    let mut bytes = [0u8; 32];
    let asset_bytes = normalized.as_bytes();
    let copy_len = asset_bytes.len().min(bytes.len());
    bytes[..copy_len].copy_from_slice(&asset_bytes[..copy_len]);
    format!("0x{}", bytes_to_lower_hex(&bytes))
}

fn padded_bytes32_from_text(value: &str) -> String {
    let mut bytes = [0u8; 32];
    let value_bytes = value.as_bytes();
    let copy_len = value_bytes.len().min(bytes.len());
    bytes[..copy_len].copy_from_slice(&value_bytes[..copy_len]);
    format!("0x{}", bytes_to_lower_hex(&bytes))
}

fn deterministic_job_id(job_type: &JobType, payload: &JobPayload) -> Result<String, String> {
    let raw = serde_json::to_vec(&(job_type, payload))
        .map_err(|error| format!("failed to encode job payload: {error}"))?;
    Ok(format!("job-{:016x}", fnv1a64(&raw)))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

fn summarize_jobs(jobs: &[Job]) -> (usize, usize, usize, usize) {
    let mut queued = 0usize;
    let mut running = 0usize;
    let mut completed = 0usize;
    let mut failed = 0usize;

    for job in jobs {
        match job.status {
            JobStatus::Queued => queued += 1,
            JobStatus::Running => running += 1,
            JobStatus::Completed => completed += 1,
            JobStatus::Failed => failed += 1,
        }
    }

    (queued, running, completed, failed)
}

fn compare_jobs(left: &Job, right: &Job) -> std::cmp::Ordering {
    left.created_at
        .cmp(&right.created_at)
        .then_with(|| left.id.cmp(&right.id))
}

fn is_ready(job: &Job, now: u64) -> bool {
    match job.status {
        JobStatus::Running | JobStatus::Completed => false,
        JobStatus::Queued | JobStatus::Failed => job
            .next_attempt_at
            .map(|next_attempt_at| next_attempt_at <= now)
            .unwrap_or(false),
    }
}

fn bind_addr() -> Result<SocketAddr, String> {
    let host = display_host();
    let port = env::var("XROUTE_RELAYER_PORT")
        .ok()
        .as_deref()
        .map(|value| parse_port(value, "XROUTE_RELAYER_PORT"))
        .transpose()?
        .unwrap_or(8788);
    format!("{host}:{port}")
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid relayer bind address {host}:{port}: {error}"))
}

fn display_host() -> String {
    env::var("XROUTE_RELAYER_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_owned())
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("missing required setting: {name}"))
}

fn parse_positive_usize(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_positive_u32(value: &str, name: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_positive_u64(value: &str, name: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_port(value: &str, name: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("{name} must be a valid TCP port"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must be after unix epoch")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{
        default_xcm_address_for_chain, encode_moonbeam_batch_all_calldata,
        encode_moonbeam_multilocation_relative, encode_u256_word,
        resolve_moonbeam_remote_reserve_chain, resolve_moonbeam_source_asset_address,
        ExecutionContext, MOONBEAM_BATCH_ALL_SELECTOR,
    };

    fn test_context() -> ExecutionContext {
        ExecutionContext {
            chain_key: "moonbeam".to_owned(),
            rpc_url: "http://127.0.0.1:8545".to_owned(),
            private_key: "0x11".repeat(32),
            router_address: "0x3333333333333333333333333333333333333333".to_owned(),
            xcm_address: "0x000000000000000000000000000000000000081a".to_owned(),
            moonbeam_xcdot_asset_address: Some(
                "0xffffffff1fcacbd218edc0eba20fc2308c778080".to_owned(),
            ),
            moonbeam_vdot_asset_address: Some(
                "0xffffffff15e1b7e3df971dd813bc394deb899abf".to_owned(),
            ),
            moonbeam_xcbnc_asset_address: None,
            observation_rpc_url: None,
        }
    }

    #[test]
    fn moonbeam_batch_all_calldata_uses_expected_selector() {
        let calldata = encode_moonbeam_batch_all_calldata(
            "0x3333333333333333333333333333333333333333",
            "0x000000000000000000000000000000000000081a",
            "0x1234",
            "0xabcd",
        )
        .expect("batch calldata should encode");

        assert!(calldata.starts_with(MOONBEAM_BATCH_ALL_SELECTOR));
    }

    #[test]
    fn moonbeam_multilocation_prefixes_parachain_selector() {
        let encoded = encode_moonbeam_multilocation_relative("polkadot-hub", "moonbeam")
            .expect("multilocation should encode");

        let expected_prefix = format!(
            "{}{}{}{}",
            encode_u256_word(1),
            encode_u256_word(64),
            encode_u256_word(1),
            encode_u256_word(32)
        );
        assert!(encoded.starts_with(&expected_prefix));
        assert!(encoded.contains("00e8030000"));
    }

    #[test]
    fn moonbeam_multilocation_supports_relay_chain_here() {
        let encoded = encode_moonbeam_multilocation_relative("polkadot-relay", "moonbeam")
            .expect("relay multilocation should encode");

        let expected = format!(
            "{}{}{}",
            encode_u256_word(1),
            encode_u256_word(64),
            encode_u256_word(0)
        );
        assert_eq!(encoded, expected);
    }

    #[test]
    fn resolve_moonbeam_source_asset_address_supports_bnc() {
        let resolved = resolve_moonbeam_source_asset_address(&test_context(), "BNC")
            .expect("BNC address should resolve");

        assert_eq!(resolved, "0xffffffff7cc06abdf7201b350a1265c62c8601d2");
    }

    #[test]
    fn resolve_moonbeam_remote_reserve_chain_overrides_dot_to_relay() {
        let resolved = resolve_moonbeam_remote_reserve_chain("DOT", "polkadot-hub")
            .expect("DOT reserve should resolve");

        assert_eq!(resolved, "polkadot-relay");
    }

    #[test]
    fn moonbeam_destination_multilocation_is_relative_to_relay_reserve() {
        let encoded = encode_moonbeam_multilocation_relative("hydration", "polkadot-relay")
            .expect("destination multilocation should encode");

        let expected_prefix = format!(
            "{}{}{}{}",
            encode_u256_word(0),
            encode_u256_word(64),
            encode_u256_word(1),
            encode_u256_word(32)
        );
        assert!(encoded.starts_with(&expected_prefix));
        assert!(encoded.contains("00f2070000"));
    }

    #[test]
    fn moonbeam_destination_multilocation_is_here_when_reserve_equals_destination() {
        let encoded = encode_moonbeam_multilocation_relative("bifrost", "bifrost")
            .expect("same-chain multilocation should encode");

        let expected = format!(
            "{}{}{}",
            encode_u256_word(0),
            encode_u256_word(64),
            encode_u256_word(0)
        );
        assert_eq!(encoded, expected);
    }

    #[test]
    fn moonbeam_uses_dedicated_xcm_default() {
        assert_eq!(
            default_xcm_address_for_chain("moonbeam", "0x00000000000000000000000000000000000a0000"),
            "0x000000000000000000000000000000000000081A"
        );
    }
}
