use std::sync::Arc;

use anyhow::Result;
use fastcrypto::{ed25519::Ed25519KeyPair, traits::KeyPair};
use nautilus_server::app::config::DealerConfig;
use nautilus_server::{router, AppState};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    // Refuse to start on an unusable pinned config (e.g. mainnet before it is pinned).
    let config = DealerConfig::pinned()?;
    // Fresh key at boot; it never leaves this process (MD4). Its public key goes
    // into the attestation document and is registered on-chain as Enclave<DEALER>.
    let eph_kp = Ed25519KeyPair::generate(&mut rand::thread_rng());
    info!(network = %config.network, package = %config.package_id, "dealer config pinned");
    let state = Arc::new(AppState::new(eph_kp, config));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, router(state).into_make_service()).await?;
    Ok(())
}
