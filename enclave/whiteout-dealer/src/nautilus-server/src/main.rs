use std::sync::Arc;

use anyhow::Result;
use axum::{routing::get, routing::post, Router};
use fastcrypto::{ed25519::Ed25519KeyPair, traits::KeyPair};
use nautilus_server::app::{config::DealerConfig, deal_handler};
use nautilus_server::common::{get_attestation, health_check};
use nautilus_server::AppState;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    // Fresh key at boot; it never leaves this process (MD4). Its public key goes
    // into the attestation document and is registered on-chain as Enclave<DEALER>.
    let eph_kp = Ed25519KeyPair::generate(&mut rand::thread_rng());
    let config = DealerConfig::pinned()?;
    info!(network = %config.network, package = %config.package_id, "dealer config pinned");
    let state = Arc::new(AppState { eph_kp, config });

    let app = Router::new()
        .route("/", get(|| async { "Pong!" }))
        .route("/get_attestation", get(get_attestation))
        .route("/health_check", get(health_check))
        .route("/deal", post(deal_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app.into_make_service()).await?;
    Ok(())
}
