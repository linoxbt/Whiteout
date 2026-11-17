//! Attestation and health endpoints, from the Nautilus template (common.rs). The
//! dealer lists no allowed endpoints, so the health check probes nothing outbound.

use std::sync::Arc;

use axum::{extract::State, Json};
use fastcrypto::traits::{KeyPair, ToFromBytes};
use serde::Serialize;

use crate::{AppState, EnclaveError};

#[derive(Serialize)]
pub struct AttestationResponse {
    /// Attestation document, hex. Its public_key field is the dealer's signing key.
    pub attestation: String,
}

#[derive(Serialize)]
pub struct HealthCheckResponse {
    pub pk: String,
    pub network: String,
    pub package_id: String,
    pub key_servers: Vec<String>,
    pub threshold: u8,
}

#[cfg(feature = "whiteout")]
pub async fn get_attestation(State(state): State<Arc<AppState>>) -> Result<Json<AttestationResponse>, EnclaveError> {
    use nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
    use nsm_api::driver;
    use serde_bytes::ByteBuf;

    let pk = state.eph_kp.public();
    let fd = driver::nsm_init();
    let request = NsmRequest::Attestation {
        user_data: None,
        nonce: None,
        public_key: Some(ByteBuf::from(pk.as_bytes().to_vec())),
    };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);
    match response {
        NsmResponse::Attestation { document } => Ok(Json(AttestationResponse { attestation: hex::encode(document) })),
        other => Err(EnclaveError::Internal(format!("NSM returned {other:?}, expected an attestation document"))),
    }
}

/// Outside an enclave there is no NSM: the endpoint says so instead of faking a document.
#[cfg(not(feature = "whiteout"))]
pub async fn get_attestation(State(_): State<Arc<AppState>>) -> Result<Json<AttestationResponse>, EnclaveError> {
    Err(EnclaveError::Internal("not running in a Nitro enclave (built without the `whiteout` feature)".into()))
}

pub async fn health_check(State(state): State<Arc<AppState>>) -> Json<HealthCheckResponse> {
    let c = &state.config;
    let mut servers: Vec<String> = c.servers.iter().map(|s| s.to_string()).collect();
    servers.dedup();
    Json(HealthCheckResponse {
        pk: hex::encode(state.eph_kp.public().as_bytes()),
        network: c.network.clone(),
        package_id: c.package_id.to_string(),
        key_servers: servers,
        threshold: c.threshold,
    })
}
