use hyper::body::to_bytes;
use hyper::{header, Body, Request, Response, StatusCode};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct HttpError {
    pub status_code: StatusCode,
    pub message: String,
}

impl HttpError {
    pub fn new(status_code: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status_code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }
}

pub async fn read_request_body(
    request: Request<Body>,
    max_bytes: usize,
) -> Result<Vec<u8>, HttpError> {
    if max_bytes == 0 {
        return Err(HttpError::bad_request(
            "request body size limit must be greater than zero",
        ));
    }

    if let Some(content_length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if content_length > max_bytes {
            return Err(HttpError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("request body exceeds the {max_bytes} byte limit"),
            ));
        }
    }

    let bytes = to_bytes(request.into_body())
        .await
        .map_err(|error| HttpError::bad_request(format!("failed to read request body: {error}")))?;
    if bytes.len() > max_bytes {
        return Err(HttpError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("request body exceeds the {max_bytes} byte limit"),
        ));
    }

    Ok(bytes.to_vec())
}

pub fn json_response<T: Serialize>(status_code: StatusCode, value: &T) -> Response<Body> {
    let body = serde_json::to_vec(value).expect("json response encoding must succeed");
    Response::builder()
        .status(status_code)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("json response must be constructible")
}

pub fn assert_bearer_token(request: &Request<Body>, expected_token: &str) -> Result<(), HttpError> {
    let normalized_expected = expected_token.trim();
    if normalized_expected.is_empty() {
        return Err(HttpError::bad_request("expected bearer token is required"));
    }

    let actual = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);

    match actual {
        Some(candidate) if candidate == normalized_expected => Ok(()),
        _ => Err(HttpError::unauthorized()),
    }
}
