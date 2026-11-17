//! POST /deal (spec section 12). Input is only a game ID; the map rules, package ID
//! and key servers are compiled in, so a request cannot change them (MD16, AC25).
//! No endpoint or log line returns plaintext, seeds or signing keys (MD4).

pub mod config;
pub mod deal;
pub mod map;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{extract::State, Json};
use base64::Engine;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::{AppState, EnclaveError};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DealRequest {
    pub game_id: String,
}

#[derive(Debug, Serialize)]
pub struct DealTileOut {
    pub id: String,
    pub ct: String,
}

#[derive(Debug, Serialize)]
pub struct DealResponse {
    pub deal_ts: u64,
    pub dealer_pk: String,
    pub ct_hash: String,
    pub deal_sig: String,
    pub tiles: Vec<DealTileOut>,
}

pub fn parse_game_id(s: &str) -> Result<[u8; 32], EnclaveError> {
    let hex = s.strip_prefix("0x").unwrap_or(s);
    if hex.len() != 64 {
        return Err(EnclaveError::GenericError("game_id must be 32 bytes of hex".into()));
    }
    let bytes = hex::decode(hex).map_err(|_| EnclaveError::GenericError("game_id is not hex".into()))?;
    Ok(bytes.try_into().expect("length checked"))
}

pub async fn deal_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DealRequest>,
) -> Result<Json<DealResponse>, EnclaveError> {
    let started = std::time::Instant::now();
    let game_id = parse_game_id(&req.game_id)?;
    let deal_ts = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| EnclaveError::GenericError(e.to_string()))?.as_millis() as u64;
    let st = state.clone();
    // Map generation and 576 encryptions are CPU-bound: keep them off the async runtime.
    let d = tokio::task::spawn_blocking(move || -> anyhow::Result<deal::Deal> {
        let map = map::generate(&mut OsRng).ok_or_else(|| anyhow::anyhow!("no solvable map after 1000 tries"))?;
        deal::deal(&st.config, &map, game_id, deal_ts, &st.eph_kp)
    })
    .await
    .map_err(|e| EnclaveError::Internal(e.to_string()))?
    .map_err(|e| EnclaveError::Internal(e.to_string()))?;

    let b64 = base64::engine::general_purpose::STANDARD;
    let resp = DealResponse {
        deal_ts: d.deal_ts,
        dealer_pk: hex::encode(&d.dealer_pk),
        ct_hash: hex::encode(&d.ct_hash),
        deal_sig: hex::encode(&d.deal_sig),
        tiles: d.tiles.iter().map(|(x, y, ct)| DealTileOut { id: format!("t-{x}-{y}"), ct: b64.encode(ct) }).collect(),
    };
    // Request timing only (spec section 12, Logging).
    info!(ms = started.elapsed().as_millis() as u64, "deal served");
    Ok(Json(resp))
}
