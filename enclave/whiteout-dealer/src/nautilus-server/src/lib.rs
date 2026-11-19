// Whiteout dealer, built on the Nautilus template (https://github.com/MystenLabs/nautilus).

use std::fmt;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{middleware, Json, Router};
use fastcrypto::ed25519::Ed25519KeyPair;
use serde_json::json;
use tokio::sync::Semaphore;

pub mod apps {
    pub mod whiteout;
}
pub use apps::whiteout as app;

pub mod common;
pub mod web;

/// Deals generated at once. Each one is CPU-bound (map generation and 576 Seal
/// encryptions on a blocking thread); the enclave has 2 vCPUs (Makefile). Requests
/// past this limit are refused with 503 instead of queueing blocking tasks.
pub const MAX_CONCURRENT_DEALS: usize = 4;

/// Largest accepted request body. A deal request is about 100 bytes of JSON.
pub const MAX_BODY_BYTES: usize = 1024;

/// The ephemeral signing key (generated at boot, never leaves memory), the pinned
/// config, the per-process deal clock and the /deal concurrency limit.
pub struct AppState {
    pub eph_kp: Ed25519KeyPair,
    pub config: app::config::DealerConfig,
    /// Strictly increasing deal_ts.
    pub deals: app::registry::DealRegistry,
    /// Concurrency limit for /deal.
    pub deal_slots: Arc<Semaphore>,
}

impl AppState {
    pub fn new(eph_kp: Ed25519KeyPair, config: app::config::DealerConfig) -> Self {
        Self::with_limit(eph_kp, config, MAX_CONCURRENT_DEALS)
    }

    pub fn with_limit(eph_kp: Ed25519KeyPair, config: app::config::DealerConfig, max_concurrent_deals: usize) -> Self {
        Self {
            eph_kp,
            config,
            deals: app::registry::DealRegistry::default(),
            deal_slots: Arc::new(Semaphore::new(max_concurrent_deals)),
        }
    }
}

/// The HTTP service: routes, request-body limit, CORS and the request log.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(|| async { "Pong!" }))
        .route("/get_attestation", get(common::get_attestation))
        .route("/health_check", get(common::health_check))
        .route("/deal", post(app::deal_handler).options(web::preflight))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(web::cors))
        .layer(middleware::from_fn(web::request_log))
        .with_state(state)
}

#[derive(Debug)]
pub enum EnclaveError {
    /// Bad request (400).
    GenericError(String),
    /// Generation or encryption failure (500).
    Internal(String),
    /// Every deal slot is busy (503, with Retry-After).
    Busy(String),
    /// The body could not be read as a deal request (400, 413, 415 or 422).
    Rejected(StatusCode, String),
}

impl From<JsonRejection> for EnclaveError {
    fn from(r: JsonRejection) -> Self {
        EnclaveError::Rejected(r.status(), r.body_text())
    }
}

impl IntoResponse for EnclaveError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            EnclaveError::GenericError(e) => (StatusCode::BAD_REQUEST, e),
            EnclaveError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
            EnclaveError::Busy(e) => {
                let mut res = (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e }))).into_response();
                res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
                return res;
            }
            EnclaveError::Rejected(status, e) => (status, e),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl fmt::Display for EnclaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnclaveError::GenericError(e)
            | EnclaveError::Internal(e)
            | EnclaveError::Busy(e)
            | EnclaveError::Rejected(_, e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EnclaveError {}
