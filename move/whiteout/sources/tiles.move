/// Tile and deal message formats, Seal identities, and the on-chain kind check.
///
/// Every signed message is a Nautilus `IntentMessage { intent, timestamp_ms, payload }`
/// BCS-encoded and signed with Ed25519 (spec section 8, "Off-chain tile format").
/// The Rust dealer and `packages/core` must produce byte-identical messages.
module whiteout::tiles;

use enclave::enclave;
use std::bcs;
use sui::ed25519;

// === Grid ===
const GRID: u8 = 24;
const TILES: u16 = 576;

// === Tile kinds ===
const SNOW: u8 = 0;
const CREVASSE: u8 = 1;
const GOGGLES: u8 = 2;
const ROPE: u8 = 3;
const RELIC: u8 = 4;

// === Intent scopes (domain separation) ===
const INTENT_DEAL: u8 = 1;
const INTENT_TILE_KIND: u8 = 2;

// === Identity ===
const ID_LEN: u64 = 32;
const IDENTITY_LEN: u64 = 34;

const EBadIdentity: u64 = 1;

/// Signed at deal time; verified on-chain at resolve. Never carries clues (MD9).
public struct TileKind has copy, drop {
    game_id: ID,
    x: u8,
    y: u8,
    kind: u8,
}

/// Signed by the dealer over the whole deal; commits to the ciphertexts (R23).
public struct DealPayload has copy, drop {
    game_id: ID,
    grid: u8,
    tiles: u16,
    ct_hash: vector<u8>,
}

public fun grid(): u8 { GRID }

public fun tiles(): u16 { TILES }

public fun snow(): u8 { SNOW }

public fun crevasse(): u8 { CREVASSE }

public fun goggles(): u8 { GOGGLES }

public fun rope(): u8 { ROPE }

public fun relic(): u8 { RELIC }

public fun intent_deal(): u8 { INTENT_DEAL }

public fun intent_tile_kind(): u8 { INTENT_TILE_KIND }

public fun deal_payload(game_id: ID, ct_hash: vector<u8>): DealPayload {
    DealPayload { game_id, grid: GRID, tiles: TILES, ct_hash }
}

/// The exact bytes the dealer signs for a tile's kind.
public fun kind_message(game_id: ID, deal_ts: u64, x: u8, y: u8, kind: u8): vector<u8> {
    bcs::to_bytes(
        &enclave::create_intent_message(
            INTENT_TILE_KIND,
            deal_ts,
            TileKind { game_id, x, y, kind },
        ),
    )
}

/// True when `sig` is the dealer's signature over `kind` at (x, y) of this game.
public fun verify_kind(
    dealer_pk: &vector<u8>,
    game_id: ID,
    deal_ts: u64,
    x: u8,
    y: u8,
    kind: u8,
    sig: &vector<u8>,
): bool {
    if (kind > RELIC) return false;
    ed25519::ed25519_verify(sig, dealer_pk, &kind_message(game_id, deal_ts, x, y, kind))
}

/// Seal identity without the package prefix: game_id (32 bytes) ‖ x ‖ y.
public fun encode_identity(game_id: ID, x: u8, y: u8): vector<u8> {
    let mut id = game_id.to_bytes();
    id.push_back(x);
    id.push_back(y);
    id
}

/// Inverse of `encode_identity`. Aborts unless the identity is exactly 34 bytes
/// and names a tile on the grid.
public fun decode_identity(id: &vector<u8>): (ID, u8, u8) {
    assert!(id.length() == IDENTITY_LEN, EBadIdentity);
    let mut gid = vector[];
    ID_LEN.do!(|i| gid.push_back(id[i]));
    let x = id[ID_LEN];
    let y = id[ID_LEN + 1];
    assert!(x < GRID && y < GRID, EBadIdentity);
    (object::id_from_bytes(gid), x, y)
}

/// Chebyshev (king-move) distance between two tiles.
public fun chebyshev(x1: u8, y1: u8, x2: u8, y2: u8): u8 {
    x1.diff(x2).max(y1.diff(y2))
}
