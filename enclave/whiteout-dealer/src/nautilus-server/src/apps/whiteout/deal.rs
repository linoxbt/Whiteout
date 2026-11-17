//! The deal (spec section 12): sign every tile, pad to 160 bytes, Seal-encrypt each
//! under game_id ‖ x ‖ y, hash the ciphertexts into ct_hash, sign the deal.
//! Message layouts match move/whiteout/sources/tiles.move and packages/core/src/messages.ts.

use anyhow::{anyhow, Result};
use fastcrypto::ed25519::Ed25519KeyPair;
use fastcrypto::hash::{Blake2b256, HashFunction};
use fastcrypto::traits::{KeyPair, Signer, ToFromBytes};
use seal_crypto::{seal_encrypt, EncryptionInput, IBEPublicKeys};
use serde::Serialize;

use super::config::DealerConfig;
use super::map::{find_relic, hazards, idx, warmth, Map, GRID, TILES};

pub const INTENT_DEAL: u8 = 1;
pub const INTENT_TILE_KIND: u8 = 2;
pub const INTENT_TILE_CLUE: u8 = 3;
pub const TILE_PLAINTEXT_LEN: usize = 160;

#[derive(Serialize)]
pub struct IntentMessage<T: Serialize> {
    pub intent: u8,
    pub timestamp_ms: u64,
    pub payload: T,
}

#[derive(Serialize)]
pub struct TileKind {
    pub game_id: [u8; 32],
    pub x: u8,
    pub y: u8,
    pub kind: u8,
}

#[derive(Serialize)]
pub struct TileClue {
    pub game_id: [u8; 32],
    pub x: u8,
    pub y: u8,
    pub kind: u8,
    pub warmth: u8,
    pub hazards: u8,
}

#[derive(Serialize)]
pub struct DealPayload {
    pub game_id: [u8; 32],
    pub grid: u8,
    pub tiles: u16,
    pub ct_hash: Vec<u8>,
}

#[derive(Serialize)]
pub struct TilePlain {
    pub version: u8,
    pub kind: u8,
    pub warmth: u8,
    pub hazards: u8,
    pub kind_sig: Vec<u8>,
    pub clue_sig: Vec<u8>,
}

pub fn intent_bytes<T: Serialize>(intent: u8, timestamp_ms: u64, payload: T) -> Vec<u8> {
    bcs::to_bytes(&IntentMessage { intent, timestamp_ms, payload }).expect("bcs never fails for these types")
}

pub fn kind_message(game_id: [u8; 32], deal_ts: u64, x: u8, y: u8, kind: u8) -> Vec<u8> {
    intent_bytes(INTENT_TILE_KIND, deal_ts, TileKind { game_id, x, y, kind })
}

pub fn clue_message(game_id: [u8; 32], deal_ts: u64, x: u8, y: u8, kind: u8, warmth: u8, hazards: u8) -> Vec<u8> {
    intent_bytes(INTENT_TILE_CLUE, deal_ts, TileClue { game_id, x, y, kind, warmth, hazards })
}

pub fn deal_message(game_id: [u8; 32], deal_ts: u64, ct_hash: &[u8]) -> Vec<u8> {
    intent_bytes(INTENT_DEAL, deal_ts, DealPayload { game_id, grid: GRID as u8, tiles: TILES as u16, ct_hash: ct_hash.to_vec() })
}

pub fn sign(kp: &Ed25519KeyPair, msg: &[u8]) -> Vec<u8> {
    kp.sign(msg).as_bytes().to_vec()
}

/// One signed tile, before encryption.
pub struct SignedTile {
    pub x: u8,
    pub y: u8,
    pub plaintext: Vec<u8>,
}

/// Builds the 576 padded, signed plaintexts in row-major order (y, then x).
pub fn sign_tiles(map: &Map, game_id: [u8; 32], deal_ts: u64, kp: &Ed25519KeyPair) -> Vec<SignedTile> {
    let relic = find_relic(map);
    let mut out = Vec::with_capacity(TILES);
    for y in 0..GRID {
        for x in 0..GRID {
            let kind = map[idx(x, y)];
            let w = warmth(x, y, relic);
            let h = hazards(map, x, y);
            let (xb, yb) = (x as u8, y as u8);
            let plain = TilePlain {
                version: 1,
                kind,
                warmth: w,
                hazards: h,
                kind_sig: sign(kp, &kind_message(game_id, deal_ts, xb, yb, kind)),
                clue_sig: sign(kp, &clue_message(game_id, deal_ts, xb, yb, kind, w, h)),
            };
            let mut bytes = bcs::to_bytes(&plain).expect("bcs");
            assert!(bytes.len() <= TILE_PLAINTEXT_LEN);
            bytes.resize(TILE_PLAINTEXT_LEN, 0);
            out.push(SignedTile { x: xb, y: yb, plaintext: bytes });
        }
    }
    out
}

/// Seal identity without the package prefix.
pub fn identity(game_id: [u8; 32], x: u8, y: u8) -> Vec<u8> {
    let mut id = game_id.to_vec();
    id.push(x);
    id.push(y);
    id
}

pub fn encrypt_tile(cfg: &DealerConfig, game_id: [u8; 32], t: &SignedTile) -> Result<Vec<u8>> {
    let (obj, _key) = seal_encrypt(
        cfg.package_id,
        identity(game_id, t.x, t.y),
        cfg.servers.clone(),
        &IBEPublicKeys::BonehFranklinBLS12381(cfg.public_keys.clone()),
        cfg.threshold,
        EncryptionInput::Aes256Gcm { data: t.plaintext.clone(), aad: None },
    )
    .map_err(|e| anyhow!("seal encryption failed: {e:?}"))?;
    // The symmetric key is dropped here: nothing outside the ciphertext leaves.
    Ok(bcs::to_bytes(&obj)?)
}

/// Blake2b-256 over the ciphertexts in row-major order, each prefixed with its u32 LE length.
pub fn ct_hash(cts: &[Vec<u8>]) -> Vec<u8> {
    let mut h = Blake2b256::default();
    for ct in cts {
        h.update((ct.len() as u32).to_le_bytes());
        h.update(ct);
    }
    h.finalize().digest.to_vec()
}

pub struct Deal {
    pub deal_ts: u64,
    pub dealer_pk: Vec<u8>,
    pub ct_hash: Vec<u8>,
    pub deal_sig: Vec<u8>,
    /// (x, y, ciphertext) in row-major order.
    pub tiles: Vec<(u8, u8, Vec<u8>)>,
}

pub fn deal(cfg: &DealerConfig, map: &Map, game_id: [u8; 32], deal_ts: u64, kp: &Ed25519KeyPair) -> Result<Deal> {
    let signed = sign_tiles(map, game_id, deal_ts, kp);
    let mut tiles = Vec::with_capacity(TILES);
    for t in &signed {
        tiles.push((t.x, t.y, encrypt_tile(cfg, game_id, t)?));
    }
    let cts: Vec<Vec<u8>> = tiles.iter().map(|(_, _, ct)| ct.clone()).collect();
    let hash = ct_hash(&cts);
    Ok(Deal {
        deal_ts,
        dealer_pk: kp.public().as_bytes().to_vec(),
        deal_sig: sign(kp, &deal_message(game_id, deal_ts, &hash)),
        ct_hash: hash,
        tiles,
    })
}
