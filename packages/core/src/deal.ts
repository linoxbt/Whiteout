/**
 * The deal: sign every tile, pad, Seal-encrypt, hash the ciphertexts, sign the deal.
 * The host CLI uses this for ceremony (host-dealt, zero-stake) games and to check an
 * enclave's output; the Rust enclave implements the same steps.
 */
import { blake2b } from '@noble/hashes/blake2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { concatBytes, u32le, bytesEqual } from './bytes.js';
import { GRID, TILE_COUNT, TileKind } from './constants.js';
import { identityHex, quiltPatchId, tileIndex } from './identity.js';
import { findRelic, findRelics, hazardsAt, validateMap, warmthAt, type MapKinds } from './map.js';

const sameId = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return n(a) === n(b);
};
import {
  clueMessage,
  dealMessage,
  decodeTilePlaintext,
  encodeTilePlaintext,
  kindMessage,
  verifyTile,
  type Tile,
} from './messages.js';

/** Encrypts one tile plaintext under its Seal identity (hex, no package prefix). */
export type TileEncryptor = (identityHex: string, plaintext: Uint8Array) => Promise<Uint8Array>;

export interface DealTile {
  id: string; // Quilt patch identifier t-<x>-<y>
  x: number;
  y: number;
  ct: Uint8Array;
}

export interface DealOutput {
  gameId: string;
  dealTs: bigint;
  dealerPk: Uint8Array;
  ctHash: Uint8Array;
  /** Relics on the map; the deal signature commits to this count. */
  relics: number;
  dealSig: Uint8Array;
  tiles: DealTile[]; // row-major: y, then x
}

/** Blake2b-256 over the 576 ciphertexts in row-major order, each prefixed with its
 * u32 little-endian length (spec section 8, `ct_hash`). */
export function ctHash(ciphertexts: Uint8Array[]): Uint8Array {
  if (ciphertexts.length !== TILE_COUNT) throw new Error(`expected ${TILE_COUNT} ciphertexts`);
  const h = blake2b.create({ dkLen: 32 });
  for (const ct of ciphertexts) {
    h.update(u32le(ct.length));
    h.update(ct);
  }
  return h.digest();
}

/** Builds and signs the 576 plaintext tiles of a map. */
export function signTiles(map: MapKinds, gameId: string, dealTs: bigint, secretKey: Uint8Array): Tile[] {
  const relics = findRelics(map);
  const tiles: Tile[] = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const kind = map[tileIndex(x, y)]!;
      const warmth = warmthAt(x, y, relics);
      const hazards = hazardsAt(map, x, y);
      tiles.push({
        x,
        y,
        kind,
        warmth,
        hazards,
        kindSig: ed25519.sign(kindMessage(gameId, dealTs, x, y, kind), secretKey),
        clueSig: ed25519.sign(clueMessage(gameId, dealTs, { x, y, kind, warmth, hazards }), secretKey),
      });
    }
  return tiles;
}

export async function deal(opts: {
  map: MapKinds;
  gameId: string;
  dealTs: bigint;
  secretKey: Uint8Array;
  encrypt: TileEncryptor;
  /** Parallel encryptions. */
  concurrency?: number;
}): Promise<DealOutput> {
  const { map, gameId, dealTs, secretKey, encrypt } = opts;
  const tiles = signTiles(map, gameId, dealTs, secretKey);
  const cts: Uint8Array[] = new Array(TILE_COUNT);
  const limit = opts.concurrency ?? 16;
  let next = 0;
  async function worker() {
    while (next < tiles.length) {
      const i = next++;
      const t = tiles[i]!;
      cts[i] = await encrypt(identityHex(gameId, t.x, t.y), encodeTilePlaintext(t));
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  const hash = ctHash(cts);
  const relics = findRelics(map).length;
  return {
    gameId,
    dealTs,
    dealerPk: ed25519.getPublicKey(secretKey),
    ctHash: hash,
    relics,
    dealSig: ed25519.sign(dealMessage(gameId, dealTs, hash, relics), secretKey),
    tiles: tiles.map((t, i) => ({ id: quiltPatchId(t.x, t.y), x: t.x, y: t.y, ct: cts[i]! })),
  };
}

/** The thaw file (FR20): every plaintext tile, published after the game ends. */
export interface ThawFile {
  game_id: string;
  tiles: Array<{ x: number; y: number; plaintext_hex: string }>;
}

export interface ThawCheck {
  ok: boolean;
  problems: string[];
  map?: MapKinds;
  /** First relic (single-relic games). */
  relic?: [number, number];
  relics?: Array<[number, number]>;
}

/** Verifies every tile of a thaw file against the dealer key (AC27). */
export function verifyThaw(
  thaw: ThawFile,
  gameId: string,
  dealerPk: Uint8Array,
  dealTs: bigint,
  /** The game's relic count: the thawed map must have exactly this many. */
  relics?: number,
): ThawCheck {
  const problems: string[] = [];
  const map = new Uint8Array(TILE_COUNT).fill(255);
  const clues = new Map<number, { warmth: number; hazards: number }>();
  if (!sameId(thaw.game_id, gameId)) problems.push('thaw file is for another game');
  if (thaw.tiles.length !== TILE_COUNT) problems.push(`thaw file has ${thaw.tiles.length} tiles`);
  for (const entry of thaw.tiles) {
    try {
      const hex = entry.plaintext_hex.replace(/^0x/, '');
      const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
      const t = decodeTilePlaintext(entry.x, entry.y, bytes);
      if (!verifyTile(dealerPk, gameId, dealTs, t)) problems.push(`tile (${entry.x}, ${entry.y}) signature`);
      map[tileIndex(entry.x, entry.y)] = t.kind;
      clues.set(tileIndex(entry.x, entry.y), { warmth: t.warmth, hazards: t.hazards });
    } catch (e) {
      problems.push(`tile (${entry.x}, ${entry.y}): ${(e as Error).message}`);
    }
  }
  if (map.includes(255)) problems.push('thaw file is missing tiles');
  else {
    // Signatures prove the dealer signed each tile; the rules prove the map is a fair one.
    const found = findRelics(map).length;
    if (relics !== undefined && found !== relics) problems.push(`the map has ${found} relic(s), the game ${relics}`);
    try {
      problems.push(...validateMap(map, relics ?? Math.max(1, found)).map((p) => `map rule: ${p}`));
    } catch (e) {
      problems.push(`map rule: ${(e as Error).message}`);
    }
    // Every clue must be the one the map implies.
    const rel = findRelics(map);
    if (rel.length) {
      for (const [i, c] of clues) {
        const x = i % GRID;
        const y = Math.floor(i / GRID);
        if (c.warmth !== warmthAt(x, y, rel) || c.hazards !== hazardsAt(map, x, y)) {
          problems.push(`tile (${x}, ${y}) clue does not match the map`);
        }
      }
    }
  }
  const ok = problems.length === 0;
  return ok ? { ok, problems, map, relic: findRelic(map), relics: findRelics(map) } : { ok, problems };
}

export function thawFile(gameId: string, tiles: Tile[]): ThawFile {
  return {
    game_id: gameId,
    tiles: tiles.map((t) => ({
      x: t.x,
      y: t.y,
      plaintext_hex: Array.from(encodeTilePlaintext(t), (b) => b.toString(16).padStart(2, '0')).join(''),
    })),
  };
}

/** Recomputes ct_hash from downloaded ciphertexts and compares it (R23, AC22). */
export function checkCiphertexts(ciphertexts: Uint8Array[], expected: Uint8Array): boolean {
  return bytesEqual(ctHash(ciphertexts), expected);
}

