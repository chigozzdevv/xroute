use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use route_engine::{DeploymentProfile, EngineSettings, RouteEngine, RouteRegistry};
use serde_json::json;
use std::convert::Infallible;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use xroute_service_shared::{
    assert_intent_allowed_by_execution_policy, health_json, json_response,
    load_execution_policy_from_file, load_hub_deployment_artifact, quote_request_from_slice,
    quote_to_json_value, read_request_body, resolve_workspace_root, summarize_execution_policy,
    intent_to_json_value, ExecutionPolicy, HubDeploymentArtifact, HttpError,
};

#[derive(Clone)]
struct QuoteState {
    deployment_profile: DeploymentProfile,
    max_body_bytes: usize,
    policy: Option<ExecutionPolicy>,
    deployment: Option<HubDeploymentArtifact>,
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
        .map_err(|error| format!("failed to bind quote service: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("failed to read quote service address: {error}"))?;
    println!(
        "{}",
        json!({
            "url": format!("http://{}:{}", display_host(), local_addr.port()),
            "deploymentProfile": state.deployment_profile.as_str(),
            "routerAddress": state.deployment.as_ref().map(|deployment| deployment.router_address.as_str()),
        })
    );

    let server = Server::from_tcp(
        listener
            .into_std()
            .map_err(|error| format!("failed to convert quote listener: {error}"))?,
    )
    .map_err(|error| format!("failed to construct quote server: {error}"))?
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
        .map_err(|error| format!("quote service failed: {error}"))?;
    Ok(())
}

fn load_state() -> Result<QuoteState, String> {
    let deployment_profile = parse_deployment_profile(
        env::var("XROUTE_DEPLOYMENT_PROFILE")
            .ok()
            .as_deref()
            .unwrap_or("testnet"),
    )?;
    let max_body_bytes = parse_positive_usize(
        env::var("XROUTE_QUOTE_MAX_BODY_BYTES")
            .ok()
            .as_deref()
            .unwrap_or("262144"),
        "XROUTE_QUOTE_MAX_BODY_BYTES",
    )?;
    let workspace_root = resolve_workspace_root(env::var("XROUTE_WORKSPACE_ROOT").ok().as_deref());
    let policy = match env::var("XROUTE_EVM_POLICY_PATH").ok() {
        Some(path) if !path.trim().is_empty() => Some(load_execution_policy_from_file(PathBuf::from(path).as_path())?),
        _ => None,
    };
    let deployment = load_hub_deployment_artifact(&workspace_root, deployment_profile).ok();

    Ok(QuoteState {
        deployment_profile,
        max_body_bytes,
        policy,
        deployment,
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
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/healthz") => Ok(json_response(
            StatusCode::OK,
            &health_json(
                state.deployment_profile,
                state.deployment.as_ref().map(|deployment| deployment.router_address.as_str()),
                json!({
                    "policy": summarize_execution_policy(state.policy.as_ref()),
                }),
            ),
        )),
        (&Method::POST, "/quote") => {
            let body = read_request_body(request, state.max_body_bytes).await?;
            let parsed = quote_request_from_slice(&body)?;
            assert_intent_allowed_by_execution_policy(&parsed.intent, state.policy.as_ref())
                .map_err(HttpError::bad_request)?;

            let quote = RouteEngine::new(
                RouteRegistry::for_profile(state.deployment_profile),
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

fn parse_deployment_profile(value: &str) -> Result<DeploymentProfile, String> {
    match value {
        "testnet" => Ok(DeploymentProfile::Testnet),
        "mainnet" => Ok(DeploymentProfile::Mainnet),
        other => Err(format!("unsupported deployment profile: {other}")),
    }
}
