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
    load_chain_deployment_artifact, load_execution_policy_from_file, load_hub_deployment_artifact,
    read_request_body, refund_job_request_from_slice, resolve_workspace_root,
    settle_job_request_from_slice, summarize_execution_policy, summary_json, DispatchRequest,
    ExecutionPolicy, HttpError, WireIntent,
};

const DISPATCH_INTENT_SIGNATURE: &str = "dispatchIntent(bytes32,(uint8,bytes,bytes))";
const FINALIZE_SUCCESS_SIGNATURE: &str = "finalizeSuccess(bytes32,bytes32,bytes32,uint128)";
const FINALIZE_EXTERNAL_SUCCESS_SIGNATURE: &str =
    "finalizeExternalSuccess(bytes32,bytes32,bytes32,uint128)";
const FINALIZE_FAILURE_SIGNATURE: &str = "finalizeFailure(bytes32,bytes32,bytes32)";
const REFUND_FAILED_INTENT_SIGNATURE: &str = "refundFailedIntent(bytes32,uint128)";

const XCM_PRECOMPILE_ADDRESS: &str = "0x00000000000000000000000000000000000a0000";
const SUPPORTED_EXECUTION_CHAINS: &[&str] = &["polkadot-hub", "hydration", "moonbeam", "bifrost"];

#[derive(Clone)]
struct ExecutionContext {
    chain_key: String,
    rpc_url: String,
    private_key: String,
    router_address: String,
    xcm_address: String,
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
        router_address,
        xcm_address: default_xcm_address,
    };
    let mut execution_contexts = load_chain_specific_execution_contexts(
        &base_execution_context,
        &workspace_root,
        deployment_profile,
    )?;
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
            if let Some(source_intent) = parsed
                .source_intent
                .as_ref()
                .filter(|metadata| metadata.kind == "substrate-source")
            {
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
    task::spawn_blocking(move || {
        run_job_blocking(
            deployment_profile,
            &source_chain,
            execution_context,
            gas_limit,
            payload,
            source_intent,
            &node_bin,
            &substrate_dispatch_script,
        )
    })
    .await
    .map_err(|error| format!("job worker failed: {error}"))?
}

fn run_job_blocking(
    deployment_profile: DeploymentProfile,
    chain_key: &str,
    execution_context: Option<ExecutionContext>,
    gas_limit: Option<u64>,
    payload: JobPayload,
    source_intent: Option<SourceIntentRecord>,
    node_bin: &str,
    substrate_dispatch_script: &Path,
) -> Result<Value, String> {
    match payload {
        JobPayload::Dispatch {
            intent_id,
            wire_intent,
            request,
            source_intent,
            source_dispatch,
        } => {
            if is_substrate_source_metadata(source_intent.as_ref()) {
                if let Some(registered_dispatch) = source_dispatch {
                    return Ok(json!({
                        "intentId": intent_id,
                        "sourceChain": chain_key,
                        "txHash": registered_dispatch.tx_hash,
                        "strategy": registered_dispatch
                            .strategy
                            .unwrap_or_else(|| "substrate-source-dispatch".to_owned()),
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
                    node_bin,
                    substrate_dispatch_script,
                );
            }

            let execution_context = execution_context
                .as_ref()
                .ok_or_else(|| format!("missing execution context for source chain {chain_key}"))?;
            let tx_hash = send_transaction(
                &execution_context.router_address,
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
                "targetAddress": &execution_context.router_address,
                "request": request,
            }))
        }
        JobPayload::Settle {
            intent_id,
            outcome_reference,
            result_asset_id,
            result_amount,
        } => {
            if is_substrate_source_record(source_intent.as_ref()) {
                let record = require_substrate_source_intent(source_intent.as_ref(), &intent_id)?;
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
            let settle_signature = if should_use_external_settlement(
                &execution_context.router_address,
                &execution_context.rpc_url,
                &intent_id,
            )? {
                FINALIZE_EXTERNAL_SUCCESS_SIGNATURE
            } else {
                FINALIZE_SUCCESS_SIGNATURE
            };
            let tx_hash = send_transaction(
                &execution_context.router_address,
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
                "routerAddress": &execution_context.router_address,
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
            if is_substrate_source_record(source_intent.as_ref()) {
                let record = require_substrate_source_intent(source_intent.as_ref(), &intent_id)?;
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
            let tx_hash = send_transaction(
                &execution_context.router_address,
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
                "routerAddress": &execution_context.router_address,
                "outcomeReference": outcome_reference,
                "failureReasonHash": failure_reason_hash,
            }))
        }
        JobPayload::Refund {
            intent_id,
            refund_amount,
            refund_asset,
        } => {
            if is_substrate_source_record(source_intent.as_ref()) {
                let record = require_substrate_source_intent(source_intent.as_ref(), &intent_id)?;
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
            let tx_hash = send_transaction(
                &execution_context.router_address,
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
                "routerAddress": &execution_context.router_address,
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
        } if is_substrate_source_metadata(source_intent.as_ref()) => {
            let tx_hash = result
                .get("txHash")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("missing txHash in dispatch result for {intent_id}"))?;
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
                )
                .await
        }
        JobPayload::Settle {
            intent_id,
            outcome_reference,
            result_asset_id,
            result_amount,
        } => {
            if let Some(record) = job_store.source_intent(intent_id).await {
                if record.kind == "substrate-source" {
                    job_store
                        .mark_source_intent_settled(
                            intent_id,
                            outcome_reference,
                            result_asset_id,
                            result_amount,
                        )
                        .await?;
                }
            }
            Ok(())
        }
        JobPayload::Fail {
            intent_id,
            outcome_reference,
            failure_reason_hash,
        } => {
            if let Some(record) = job_store.source_intent(intent_id).await {
                if record.kind == "substrate-source" {
                    job_store
                        .mark_source_intent_failed(
                            intent_id,
                            outcome_reference,
                            failure_reason_hash,
                        )
                        .await?;
                }
            }
            Ok(())
        }
        JobPayload::Refund {
            intent_id,
            refund_amount,
            refund_asset,
        } => {
            if let Some(record) = job_store.source_intent(intent_id).await {
                if record.kind == "substrate-source" {
                    job_store
                        .mark_source_intent_refunded(
                            intent_id,
                            refund_amount,
                            refund_asset.as_deref(),
                        )
                        .await?;
                }
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
    matches!(chain_key, "hydration" | "bifrost")
}

fn resolve_substrate_refund_asset(
    record: &SourceIntentRecord,
    refund_asset: Option<&str>,
) -> String {
    refund_asset
        .map(str::to_owned)
        .unwrap_or_else(|| record.refund_asset.clone())
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
    let tx_hash = extract_transaction_hash(&stdout)?;
    let receipt = read_transaction_receipt(&tx_hash, rpc_url)?;

    if !receipt_status_succeeded(&receipt).unwrap_or(false) {
        let revert_reason = extract_revert_reason(&receipt)
            .or_else(|| extract_revert_reason_from_output(&stdout))
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

fn load_chain_specific_execution_contexts(
    base_execution_context: &ExecutionContext,
    workspace_root: &Path,
    deployment_profile: DeploymentProfile,
) -> Result<BTreeMap<String, ExecutionContext>, String> {
    let mut contexts = BTreeMap::new();

    for chain_key in SUPPORTED_EXECUTION_CHAINS {
        let env_prefix = env_prefix_for_chain(chain_key);
        if !has_chain_specific_execution_context(&env_prefix) {
            continue;
        }
        let deployment =
            load_chain_deployment_artifact(workspace_root, deployment_profile, chain_key).ok();

        contexts.insert(
            (*chain_key).to_owned(),
            ExecutionContext {
                chain_key: (*chain_key).to_owned(),
                rpc_url: required_chain_env(&env_prefix, "RPC_URL")?,
                private_key: required_chain_env(&env_prefix, "PRIVATE_KEY")?,
                router_address: if chain_uses_substrate_dispatch(chain_key) {
                    optional_chain_env(&env_prefix, "ROUTER_ADDRESS")
                        .or_else(|| deployment.as_ref().map(|artifact| artifact.router_address.clone()))
                        .unwrap_or_else(|| base_execution_context.router_address.clone())
                } else {
                    optional_chain_env(&env_prefix, "ROUTER_ADDRESS")
                        .or_else(|| deployment.as_ref().map(|artifact| artifact.router_address.clone()))
                        .ok_or_else(|| {
                            format!(
                                "missing required setting: {}; configure {} for this source chain or add {}",
                                chain_env_name(&env_prefix, "ROUTER_ADDRESS"),
                                chain_env_name(&env_prefix, "ROUTER_ADDRESS"),
                                deployment
                                    .as_ref()
                                    .map(|artifact| artifact.artifact_path.display().to_string())
                                    .unwrap_or_else(|| {
                                        workspace_root
                                            .join("contracts")
                                            .join("polkadot-hub-router")
                                            .join("deployments")
                                            .join(deployment_profile.as_str())
                                            .join(format!("{chain_key}.json"))
                                            .display()
                                            .to_string()
                                    }),
                            )
                        })?
                },
                xcm_address: optional_chain_env(&env_prefix, "XCM_ADDRESS")
                    .or_else(|| deployment.as_ref().and_then(|artifact| artifact.xcm_address.clone()))
                    .unwrap_or_else(|| base_execution_context.xcm_address.clone()),
            },
        );
    }

    Ok(contexts)
}

fn has_chain_specific_execution_context(env_prefix: &str) -> bool {
    ["RPC_URL", "ROUTER_ADDRESS", "PRIVATE_KEY", "XCM_ADDRESS"]
        .iter()
        .any(|suffix| env::var(chain_env_name(env_prefix, suffix)).is_ok())
}

fn required_chain_env(env_prefix: &str, suffix: &str) -> Result<String, String> {
    optional_chain_env(env_prefix, suffix).ok_or_else(|| {
        format!(
            "missing required setting: {}; configure {} for this source chain",
            chain_env_name(env_prefix, suffix),
            chain_env_name(env_prefix, suffix),
        )
    })
}

fn optional_chain_env(env_prefix: &str, suffix: &str) -> Option<String> {
    env::var(chain_env_name(env_prefix, suffix))
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn chain_env_name(env_prefix: &str, suffix: &str) -> String {
    format!("XROUTE_{env_prefix}_{suffix}")
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

fn dispatch_substrate_source_intent(
    intent_id: &str,
    chain_key: &str,
    execution_context: &ExecutionContext,
    request: &DispatchRequest,
    source_intent: Option<&xroute_service_shared::SourceIntentMetadata>,
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
        "request": request,
    }))
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
