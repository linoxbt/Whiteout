//! POST /deal (spec section 12). Input is only a game ID and a relic count; the map
//! rules, package ID and key servers are compiled in, so a request cannot change
//! them (MD16, AC25). No endpoint or log line returns plaintext, seeds or signing
//! keys (MD4). Every deal gets a deal_ts no other deal by this key shares (see
//! registry.rs), and at most
//! `MAX_CONCURRENT_DEALS` deals run at once.

pub mod config;
pub mod deal;
pub mod map;
pub mod registry;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::rejection::JsonRejection;
use axum::{extract::State, Json};
use base64::Engine;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

use crate::{AppState, EnclaveError};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DealRequest {
    pub game_id: String,
    /// Phase 2: relics (= prizes) for a ranked game, 1-3. The deal signature commits
    /// to it, so a wrong count only produces a deal the contract rejects.
    #[serde(default = "one_relic")]
    pub relics: u8,
}

fn one_relic() -> u8 {
    1
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
    pub relics: u8,
    pub deal_sig: String,
    pub tiles: Vec<DealTileOut>,
}

/// A Sui object ID: exactly 64 hex digits, optionally after a lowercase `0x`. Nothing
/// else is accepted (no whitespace, no short form, no all-zero ID).
pub fn parse_game_id(s: &str) -> Result<[u8; 32], EnclaveError> {
    let hex = s.strip_prefix("0x").unwrap_or(s);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(EnclaveError::GenericError("game_id must be 32 bytes of hex (64 hex digits, optional 0x)".into()));
    }
    let bytes: [u8; 32] = hex::decode(hex)
        .map_err(|_| EnclaveError::GenericError("game_id is not hex".into()))?
        .try_into()
        .expect("length checked");
    if bytes == [0u8; 32] {
        return Err(EnclaveError::GenericError("game_id must not be zero".into()));
    }
    Ok(bytes)
}

/// The relic count of a ranked game: 1 to 3.
pub fn parse_relics(relics: u8) -> Result<usize, EnclaveError> {
    let relics = relics as usize;
    if !(1..=map::MAX_RELICS).contains(&relics) {
        return Err(EnclaveError::GenericError(format!("relics must be 1 to {}", map::MAX_RELICS)));
    }
    Ok(relics)
}

fn now_ms() -> Result<u64, EnclaveError> {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| EnclaveError::Internal(e.to_string()))?;
    Ok(d.as_millis() as u64)
}

pub async fn deal_handler(
    State(state): State<Arc<AppState>>,
    body: Result<Json<DealRequest>, JsonRejection>,
) -> Result<Json<DealResponse>, EnclaveError> {
    let Json(req) = body?;
    let game_id = parse_game_id(&req.game_id)?;
    let relics = parse_relics(req.relics)?;
    // Bounded concurrency: refuse rather than queue. The permit moves into the
    // blocking task so it is held until the CPU work ends, even if the client
    // disconnects and this future is dropped.
    let permit = state
        .deal_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| EnclaveError::Busy("the dealer is busy; retry shortly".into()))?;
    // A deal_ts no other deal by this key shares, so kind signatures from two deals
    // (even for the same game) can never be mixed.
    let deal_ts = state.deals.next_deal_ts(now_ms()?);
    let st = state.clone();
    // Map generation and 576 encryptions are CPU-bound: keep them off the async runtime.
    let d = tokio::task::spawn_blocking(move || -> anyhow::Result<deal::Deal> {
        let _permit = permit;
        let map = map::generate(&mut OsRng, relics).ok_or_else(|| anyhow::anyhow!("no solvable map after 1000 tries"))?;
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
        relics: d.relics,
        deal_sig: hex::encode(&d.deal_sig),
        tiles: d.tiles.iter().map(|(x, y, ct)| DealTileOut { id: format!("t-{x}-{y}"), ct: b64.encode(ct) }).collect(),
    };
    // The request log line (request id + timing) is written by web::request_log.
    Ok(Json(resp))
}
