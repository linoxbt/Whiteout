//! HTTP middleware: CORS for browser hosts and the request log.
//!
//! Every response carries only public data (ciphertexts, signatures, the dealer's
//! public key, the pinned config), and no endpoint uses cookies or credentials, so
//! any origin may read them. Browsers still require the page and the enclave to be
//! reached over HTTPS: TLS is terminated on the parent instance (see
//! expose_enclave.sh); the enclave itself serves plain HTTP on port 3000.

use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tracing::info;

pub const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// Answers the CORS preflight a browser sends before `fetch(POST /deal)` with a JSON body.
pub async fn preflight() -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("content-type"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    res
}

/// Lets any origin read the (public) responses. No credentials are allowed.
pub async fn cors(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("x-request-id, retry-after"));
    res
}

/// One log line per request: a random request id, the route, the status and the
/// time taken (spec section 12, Logging). Never the body, the game, the map, seeds,
/// keys or plaintexts. The id is also returned in `x-request-id` for correlation.
pub async fn request_log(req: Request, next: Next) -> Response {
    let started = Instant::now();
    let request_id = format!("{:016x}", rand::random::<u64>());
    let route = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned()).unwrap_or_else(|| "-".into());
    let mut res = next.run(req).await;
    info!(
        request_id = %request_id,
        route = %route,
        status = res.status().as_u16(),
        ms = started.elapsed().as_millis() as u64,
        "request served"
    );
    if let Ok(v) = HeaderValue::from_str(&request_id) {
        res.headers_mut().insert(REQUEST_ID, v);
    }
    res
}
