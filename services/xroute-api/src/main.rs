use executor_relayer::RelayerApp;
use hyper::body::to_bytes;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use quote_service::QuoteApp;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::env;
use std::net::SocketAddr;
use xroute_service_shared::json_response;

#[derive(Clone)]
struct ApiApp {
    quote: QuoteApp,
    relayer: RelayerApp,
}

impl ApiApp {
    fn load() -> Result<Self, String> {
        let quote = QuoteApp::load()?;
        let relayer = RelayerApp::load()?;
        relayer.start_worker();

        Ok(Self { quote, relayer })
    }

    async fn handle(&self, request: Request<Body>) -> Response<Body> {
        let normalized_path = normalize_public_path(request.uri().path());

        match (request.method(), normalized_path.as_str()) {
            (&Method::GET, "/healthz") => self.handle_health().await,
            (_, "/quote") => self.quote.handle(request).await,
            _ => self.relayer.handle(request).await,
        }
    }

    async fn handle_health(&self) -> Response<Body> {
        let quote = read_json_response(self.quote.handle(empty_get("/healthz")).await).await;
        let relayer = read_json_response(self.relayer.handle(empty_get("/healthz")).await).await;

        match (quote, relayer) {
            (Ok(quote), Ok(relayer)) => json_response(
                StatusCode::OK,
                &json!({
                    "ok": quote["ok"].as_bool().unwrap_or(false)
                        && relayer["ok"].as_bool().unwrap_or(false),
                    "deploymentProfile": quote["deploymentProfile"]
                        .as_str()
                        .or_else(|| relayer["deploymentProfile"].as_str()),
                    "quote": quote,
                    "relayer": relayer,
                }),
            ),
            (Err(error), _) | (_, Err(error)) => json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({
                    "ok": false,
                    "error": error,
                }),
            ),
        }
    }

    fn startup_summary(&self) -> Value {
        let quote = self.quote.startup_summary();
        let relayer = self.relayer.startup_summary();

        json!({
            "deploymentProfile": relayer["deploymentProfile"]
                .as_str()
                .or_else(|| quote["deploymentProfile"].as_str()),
            "routerAddress": relayer["routerAddress"],
            "quote": quote,
            "relayer": relayer,
        })
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let app = ApiApp::load()?;
    let listener = tokio::net::TcpListener::bind(bind_addr()?)
        .await
        .map_err(|error| format!("failed to bind xroute api: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("failed to read xroute api address: {error}"))?;

    println!(
        "{}",
        json!({
            "url": format!("http://{}:{}/v1", display_host(), local_addr.port()),
            "deploymentProfile": app
                .startup_summary()["deploymentProfile"]
                .as_str()
                .unwrap_or("mainnet"),
            "routerAddress": app.startup_summary()["routerAddress"],
        })
    );

    let server = Server::from_tcp(
        listener
            .into_std()
            .map_err(|error| format!("failed to convert xroute api listener: {error}"))?,
    )
    .map_err(|error| format!("failed to construct xroute api server: {error}"))?
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
        .map_err(|error| format!("xroute api failed: {error}"))?;
    Ok(())
}

fn bind_addr() -> Result<SocketAddr, String> {
    let host = display_host();
    let port = env::var("XROUTE_API_PORT")
        .ok()
        .or_else(|| env::var("PORT").ok())
        .as_deref()
        .map(|value| parse_port(value, "XROUTE_API_PORT"))
        .transpose()?
        .unwrap_or(8788);
    format!("{host}:{port}")
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid api bind address {host}:{port}: {error}"))
}

fn display_host() -> String {
    env::var("XROUTE_API_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("PORT").ok().map(|_| "0.0.0.0".to_owned()))
        .unwrap_or_else(|| "127.0.0.1".to_owned())
}

fn normalize_public_path(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix("/v1") {
        return if stripped.is_empty() {
            "/".to_owned()
        } else {
            stripped.to_owned()
        };
    }

    path.to_owned()
}

fn parse_port(value: &str, name: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("{name} must be a valid TCP port"))
}

fn empty_get(path: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(path)
        .body(Body::empty())
        .expect("empty GET request should be valid")
}

async fn read_json_response(response: Response<Body>) -> Result<Value, String> {
    let status = response.status();
    let body = to_bytes(response.into_body())
        .await
        .map_err(|error| format!("failed to read downstream response: {error}"))?;
    let parsed: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("failed to parse downstream response: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "downstream healthz failed with status {}: {}",
            status.as_u16(),
            parsed
        ));
    }

    Ok(parsed)
}
