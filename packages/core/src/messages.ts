/**
 * Signed message formats (spec section 8). Every message is a Nautilus
 * `IntentMessage { intent: u8, timestamp_ms: u64, payload }`, BCS-encoded. The Move
 * package, this file and the Rust dealer must agree byte for byte; the fixtures
 * test checks this against move/whiteout/tests/fixtures.move.
 */
import { bcs } from '@mysten/sui/bcs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { GRID, Intent, TILE_COUNT, TILE_PLAINTEXT_LEN } from './constants.js';

export const TileKindPayload = bcs.struct('TileKind', {
  game_id: bcs.Address,
  x: bcs.u8(),
  y: bcs.u8(),
  kind: bcs.u8(),
});

export const TileCluePayload = bcs.struct('TileClue', {
  game_id: bcs.Address,
  x: bcs.u8(),
  y: bcs.u8(),
  kind: bcs.u8(),
  warmth: bcs.u8(),
  hazards: bcs.u8(),
});

export const DealPayload = bcs.struct('DealPayload', {
  game_id: bcs.Address,
  grid: bcs.u8(),
  tiles: bcs.u16(),
  relics: bcs.u8(),
  ct_hash: bcs.vector(bcs.u8()),
});

function intentMessage<T>(payload: { serialize(v: T): { toBytes(): Uint8Array } }) {
  return (intent: number, timestampMs: bigint | number, value: T): Uint8Array => {
    const head = bcs
      .struct('IntentHead', { intent: bcs.u8(), timestamp_ms: bcs.u64() })
      .serialize({ intent, timestamp_ms: BigInt(timestampMs) })
      .toBytes();
    const body = payload.serialize(value).toBytes();
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
  };
}

export function kindMessage(gameId: string, dealTs: bigint | number, x: number, y: number, kind: number) {
  return intentMessage(TileKindPayload)(Intent.TILE_KIND, dealTs, { game_id: gameId, x, y, kind });
}

export function clueMessage(
  gameId: string,
  dealTs: bigint | number,
  clue: { x: number; y: number; kind: number; warmth: number; hazards: number },
) {
  return intentMessage(TileCluePayload)(Intent.TILE_CLUE, dealTs, { game_id: gameId, ...clue });
}

/** The deal signature commits to the ciphertexts and the number of relics (= prizes). */
export function dealMessage(gameId: string, dealTs: bigint | number, ctHash: Uint8Array, relics = 1) {
  return intentMessage(DealPayload)(Intent.DEAL, dealTs, {
    game_id: gameId,
    grid: GRID,
    tiles: TILE_COUNT,
    relics,
    ct_hash: Array.from(ctHash),
  });
}

/** Decrypted tile contents: BCS `TilePlain`, zero-padded to 160 bytes. */
export const TilePlain = bcs.struct('TilePlain', {
  version: bcs.u8(),
  kind: bcs.u8(),
  warmth: bcs.u8(),
  hazards: bcs.u8(),
  kind_sig: bcs.vector(bcs.u8()),
  clue_sig: bcs.vector(bcs.u8()),
});

export interface Tile {
  x: number;
  y: number;
  kind: number;
  warmth: number;
  hazards: number;
  kindSig: Uint8Array;
  clueSig: Uint8Array;
  /** Set false by the client when the clue signature failed: warmth and hazards are not shown. */
  clueOk?: boolean;
}

export function encodeTilePlaintext(t: Tile): Uint8Array {
  const raw = TilePlain.serialize({
    version: 1,
    kind: t.kind,
    warmth: t.warmth,
    hazards: t.hazards,
    kind_sig: Array.from(t.kindSig),
    clue_sig: Array.from(t.clueSig),
  }).toBytes();
  if (raw.length > TILE_PLAINTEXT_LEN) throw new Error('tile plaintext too long');
  const out = new Uint8Array(TILE_PLAINTEXT_LEN);
  out.set(raw);
  return out;
}

export function decodeTilePlaintext(x: number, y: number, bytes: Uint8Array): Tile {
  if (bytes.length !== TILE_PLAINTEXT_LEN) throw new Error(`tile plaintext must be ${TILE_PLAINTEXT_LEN} bytes`);
  const p = TilePlain.parse(bytes);
  if (p.version !== 1) throw new Error(`unknown tile version ${p.version}`);
  return {
    x,
    y,
    kind: p.kind,
    warmth: p.warmth,
    hazards: p.hazards,
    kindSig: Uint8Array.from(p.kind_sig),
    clueSig: Uint8Array.from(p.clue_sig),
  };
}

export function verifyKindSig(dealerPk: Uint8Array, gameId: string, dealTs: bigint | number, t: Tile): boolean {
  try {
    return ed25519.verify(t.kindSig, kindMessage(gameId, dealTs, t.x, t.y, t.kind), dealerPk);
  } catch {
    return false;
  }
}

export function verifyClueSig(dealerPk: Uint8Array, gameId: string, dealTs: bigint | number, t: Tile): boolean {
  try {
    return ed25519.verify(t.clueSig, clueMessage(gameId, dealTs, t), dealerPk);
  } catch {
    return false;
  }
}

/** A tile is shown only when both its signatures verify (FR10). */
export function verifyTile(dealerPk: Uint8Array, gameId: string, dealTs: bigint | number, t: Tile): boolean {
  return verifyKindSig(dealerPk, gameId, dealTs, t) && verifyClueSig(dealerPk, gameId, dealTs, t);
}

export function verifyDealSig(
  dealerPk: Uint8Array,
  gameId: string,
  dealTs: bigint | number,
  ctHash: Uint8Array,
  sig: Uint8Array,
  relics = 1,
): boolean {
  try {
    return ed25519.verify(sig, dealMessage(gameId, dealTs, ctHash, relics), dealerPk);
  } catch {
    return false;
  }
}
