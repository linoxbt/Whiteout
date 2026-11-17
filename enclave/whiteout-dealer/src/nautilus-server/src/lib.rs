// Whiteout dealer, built on the Nautilus template (https://github.com/MystenLabs/nautilus).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use fastcrypto::ed25519::Ed25519KeyPair;
use serde_json::json;
use std::fmt;

pub mod apps {
    pub mod whiteout;
}
pub use apps::whiteout as app;

pub mod common;

/// The ephemeral signing key (generated at boot, never leaves memory) and the pinned config.
pub struct AppState {
    pub eph_kp: Ed25519KeyPair,
    pub config: app::config::DealerConfig,
}

#[derive(Debug)]
pub enum EnclaveError {
    /// Bad request (400).
    GenericError(String),
    /// Generation or encryption failure (500).
    Internal(String),
}

impl IntoResponse for EnclaveError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            EnclaveError::GenericError(e) => (StatusCode::BAD_REQUEST, e),
            EnclaveError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl fmt::Display for EnclaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnclaveError::GenericError(e) | EnclaveError::Internal(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EnclaveError {}
