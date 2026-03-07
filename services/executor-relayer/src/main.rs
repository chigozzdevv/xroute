mod store;

use crate::store::{Job, JobPayload, JobStatus, JobStore, JobType};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::env;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task;
use tokio::time::sleep;
use xroute_service_shared::{
    assert_bearer_token, assert_intent_allowed_by_execution_policy, dispatch_job_request_from_slice,
    fail_job_request_from_slice, health_json, json_response, load_execution_policy_from_file,
    load_hub_deployment_artifact, read_request_body, refund_job_request_from_slice,
    resolve_workspace_root, settle_job_request_from_slice, summarize_execution_policy, summary_json,
    DispatchRequest, ExecutionPolicy, HttpError,
};
use route_engine::DeploymentProfile;

const DISPATCH_INTENT_SIGNATURE: &str = "dispatchIntent(bytes32,(uint8,bytes,bytes))";
const FINALIZE_SUCCESS_SIGNATURE: &str = "finalizeSuccess(bytes32,bytes32,bytes32,uint128)";
const FINALIZE_FAILURE_SIGNATURE: &str = "finalizeFailure(bytes32,bytes32,bytes32)";
const REFUND_FAILED_INTENT_SIGNATURE: &str = "refundFailedIntent(bytes32,uint128)";

#[derive(Clone)]
struct RelayerState {
    deployment_profile: DeploymentProfile,
    max_body_bytes: usize,
    auth_token: String,
    rpc_url: String,
    private_key: String,
    router_address: String,
    policy: Option<ExecutionPolicy>,
    job_store: Arc<JobStore>,
    event_log_path: PathBuf,
    max_attempts: u32,
    retry_delay_ms: u64,
    poll_interval_ms: u64,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let state = Arc::new(load_state()?);
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
            "deploymentProfile": state.deployment_profile.as_str(),
            "routerAddress": state.router_address,
        })
    );

    let worker_state = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            if let Err(error) = process_ready_jobs(Arc::clone(&worker_state)).await {
                eprintln!("{error}");
            }
            sleep(Duration::from_millis(worker_state.poll_interval_ms)).await;
        }
    });

    let server = Server::from_tcp(
        listener
            .into_std()
            .map_err(|error| format!("failed to convert relayer listener: {error}"))?,
    )
    .map_err(|error| format!("failed to construct relayer server: {error}"))?
    .serve(make_service_fn(move |_| {
        let state = Arc::clone(&state);
        async move {
            Ok::<_, Infallible>(service_fn(move |request| {
                let state = Arc::clone(&state);
                async move { Ok::<_, Infallible>(handle_request(request, state).await) }
            }))
        }
    }));

    server
        .await
        .map_err(|error| format!("executor relayer failed: {error}"))?;
    Ok(())
}

fn load_state() -> Result<RelayerState, String> {
    let deployment_profile = parse_deployment_profile(
        env::var("XROUTE_DEPLOYMENT_PROFILE")
            .ok()
            .as_deref()
            .unwrap_or("testnet"),
    )?;
    let max_body_bytes = parse_positive_usize(
        env::var("XROUTE_RELAYER_MAX_BODY_BYTES")
            .ok()
            .as_deref()
            .unwrap_or("262144"),
        "XROUTE_RELAYER_MAX_BODY_BYTES",
    )?;
    let auth_token = required_env("XROUTE_RELAYER_AUTH_TOKEN")?;
    let rpc_url = required_env("XROUTE_RPC_URL")?;
    let private_key = required_env("XROUTE_PRIVATE_KEY")?;
    let workspace_root = resolve_workspace_root(env::var("XROUTE_WORKSPACE_ROOT").ok().as_deref());
    let deployment = load_hub_deployment_artifact(&workspace_root, deployment_profile).ok();
    let router_address = env::var("XROUTE_ROUTER_ADDRESS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| deployment.as_ref().map(|artifact| artifact.router_address.clone()))
        .ok_or_else(|| "routerAddress or a deployment artifact is required".to_owned())?;
    let policy = match env::var("XROUTE_EVM_POLICY_PATH").ok() {
        Some(path) if !path.trim().is_empty() => Some(load_execution_policy_from_file(Path::new(&path))?),
        _ => None,
    };
    let data_root = workspace_root.join("services").join("executor-relayer").join("data");
    let job_store_path = env::var("XROUTE_RELAYER_JOB_STORE_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join(format!("{}-jobs.json", deployment_profile.as_str())));
    let event_log_path = env::var("XROUTE_STATUS_EVENTS_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join(format!("{}-status.ndjson", deployment_profile.as_str())));

    Ok(RelayerState {
        deployment_profile,
        max_body_bytes,
        auth_token,
        rpc_url,
        private_key,
        router_address,
        policy,
        job_store: Arc::new(JobStore::load(job_store_path)?),
        event_log_path,
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
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/healthz") => {
            let jobs = state.job_store.list().await;
            let summary = summarize_jobs(&jobs);
            Ok(json_response(
                StatusCode::OK,
                &health_json(
                    state.deployment_profile,
                    Some(&state.router_address),
                    json!({
                        "policy": summarize_execution_policy(state.policy.as_ref()),
                        "jobs": summary_json(summary.0, summary.1, summary.2, summary.3),
                    }),
                ),
            ))
        }
        _ => {
            assert_bearer_token(&request, &state.auth_token)?;
            route_authenticated_request(request, state).await
        }
    }
}

async fn route_authenticated_request(
    request: Request<Body>,
    state: Arc<RelayerState>,
) -> Result<Response<Body>, HttpError> {
    match (request.method(), request.uri().path()) {
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

            let job = enqueue_job(
                &state.job_store,
                JobType::Dispatch,
                JobPayload::Dispatch {
                    intent_id: parsed.intent_id,
                    request: parsed.request,
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
    let rpc_url = state.rpc_url.clone();
    let private_key = state.private_key.clone();
    let router_address = state.router_address.clone();
    let payload = job.payload.clone();
    task::spawn_blocking(move || run_job_blocking(&rpc_url, &private_key, &router_address, payload))
        .await
        .map_err(|error| format!("job worker failed: {error}"))?
}

fn run_job_blocking(
    rpc_url: &str,
    private_key: &str,
    router_address: &str,
    payload: JobPayload,
) -> Result<Value, String> {
    match payload {
        JobPayload::Dispatch { intent_id, request } => {
            let tx_hash = send_transaction(
                router_address,
                DISPATCH_INTENT_SIGNATURE,
                &[
                    intent_id.clone(),
                    format_dispatch_request_tuple(&request),
                ],
                rpc_url,
                private_key,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "txHash": tx_hash,
                "request": request,
            }))
        }
        JobPayload::Settle {
            intent_id,
            outcome_reference,
            result_asset_id,
            result_amount,
        } => {
            let tx_hash = send_transaction(
                router_address,
                FINALIZE_SUCCESS_SIGNATURE,
                &[
                    intent_id.clone(),
                    outcome_reference.clone(),
                    result_asset_id.clone(),
                    result_amount.clone(),
                ],
                rpc_url,
                private_key,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "txHash": tx_hash,
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
            let tx_hash = send_transaction(
                router_address,
                FINALIZE_FAILURE_SIGNATURE,
                &[
                    intent_id.clone(),
                    outcome_reference.clone(),
                    failure_reason_hash.clone(),
                ],
                rpc_url,
                private_key,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "txHash": tx_hash,
                "outcomeReference": outcome_reference,
                "failureReasonHash": failure_reason_hash,
            }))
        }
        JobPayload::Refund {
            intent_id,
            refund_amount,
            refund_asset,
        } => {
            let tx_hash = send_transaction(
                router_address,
                REFUND_FAILED_INTENT_SIGNATURE,
                &[intent_id.clone(), refund_amount.clone()],
                rpc_url,
                private_key,
            )?;
            Ok(json!({
                "intentId": intent_id,
                "txHash": tx_hash,
                "refundAmount": refund_amount,
                "refundAsset": refund_asset,
            }))
        }
    }
}

fn send_transaction(
    contract_address: &str,
    signature: &str,
    args: &[String],
    rpc_url: &str,
    private_key: &str,
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
        .arg(private_key)
        .arg("--json");
    let output = command
        .output()
        .map_err(|error| format!("failed to run cast send: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }

    extract_transaction_hash(String::from_utf8_lossy(&output.stdout).trim())
}

fn format_dispatch_request_tuple(request: &DispatchRequest) -> String {
    format!(
        "({},{},{})",
        request.mode, request.destination, request.message
    )
}

fn extract_transaction_hash(value: &str) -> Result<String, String> {
    if let Ok(parsed) = serde_json::from_str::<Value>(value) {
        if let Some(candidate) = parsed
            .get("transactionHash")
            .or_else(|| parsed.get("txHash"))
            .or_else(|| parsed.get("hash"))
            .or_else(|| parsed.get("receipt").and_then(|receipt| receipt.get("transactionHash")))
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

fn append_status_event(path: &Path, event: Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)
            .map_err(|error| format!("failed to create event log directory {}: {error}", parent.display()))?;
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

fn parse_deployment_profile(value: &str) -> Result<DeploymentProfile, String> {
    match value {
        "testnet" => Ok(DeploymentProfile::Testnet),
        "mainnet" => Ok(DeploymentProfile::Mainnet),
        other => Err(format!("unsupported deployment profile: {other}")),
    }
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
