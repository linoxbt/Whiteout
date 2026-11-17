import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  ABORTS,
  ExplorerBcs,
  GRID,
  GameBcs,
  MAP_MIX,
  TILE_COUNT,
  TILE_PLAINTEXT_LEN,
  TileKind,
  chebyshev,
  checkCiphertexts,
  ctHash,
  deal,
  decodeIdentity,
  decodeTilePlaintext,
  encodeIdentity,
  encodeTilePlaintext,
  fromHex,
  generateMap,
  hasVisited,
  hazardsAt,
  identityHex,
  isEnded,
  kindMessage,
  parseAbort,
  parseExplorer,
  parseGame,
  seededRng,
  signTiles,
  thawFile,
  tileIndex,
  toHex,
  tx,
  validateMap,
  verifyDealSig,
  verifyThaw,
  verifyTile,
  visibleTiles,
  warmthAt,
} from '../src/index.js';

// --- Move fixtures (written by move/whiteout/scripts/gen_fixtures.py) -----------------

const fixtures = readFileSync(
  fileURLToPath(new URL('../../../move/whiteout/tests/fixtures.move', import.meta.url)),
  'utf8',
);
const hexConst = (name: string) => fromHex(fixtures.match(new RegExp(`const ${name}: vector<u8> = x"([0-9a-f]*)"`))![1]!);
const addrConst = (name: string) => fixtures.match(new RegExp(`const ${name}: address = @(0x[0-9a-f]+)`))![1]!;
const F = {
  gameId: addrConst('GAME_ID'),
  otherGameId: addrConst('OTHER_GAME_ID'),
  dealTs: BigInt(fixtures.match(/const DEAL_TS: u64 = (\d+)/)![1]!),
  dealerPk: hexConst('DEALER_PK'),
  ctHash: hexConst('CT_HASH'),
  dealSig: hexConst('DEAL_SIG'),
  kinds: hexConst('KINDS'),
  sigs: hexConst('SIGS'),
};

describe('message formats match the Move fixtures', () => {
  it('verifies all 576 kind signatures with the TypeScript encoder', () => {
    for (let i = 0; i < TILE_COUNT; i++) {
      const x = i % GRID;
      const y = Math.floor(i / GRID);
      const msg = kindMessage(F.gameId, F.dealTs, x, y, F.kinds[i]!);
      expect(ed25519.verify(F.sigs.slice(i * 64, i * 64 + 64), msg, F.dealerPk), `tile ${x},${y}`).toBe(true);
    }
  });

  it('verifies the deal signature and rejects it for another game', () => {
    expect(verifyDealSig(F.dealerPk, F.gameId, F.dealTs, F.ctHash, F.dealSig)).toBe(true);
    expect(verifyDealSig(F.dealerPk, F.otherGameId, F.dealTs, F.ctHash, F.dealSig)).toBe(false);
  });

  it('derives the fixture dealer key from the documented seed', () => {
    expect(toHex(ed25519.getPublicKey(new Uint8Array(32).fill(0x2a)))).toBe(toHex(F.dealerPk));
  });

  it('kind message layout is intent ‖ timestamp ‖ game_id ‖ x ‖ y ‖ kind', () => {
    const m = kindMessage(F.gameId, 1n, 3, 4, 2);
    expect(m.length).toBe(1 + 8 + 32 + 3);
    expect(m[0]).toBe(2);
    expect(Array.from(m.slice(41))).toEqual([3, 4, 2]);
  });
});

describe('identities', () => {
  it('round-trips and is 34 bytes', () => {
    const id = encodeIdentity(F.gameId, 17, 9);
    expect(id.length).toBe(34);
    expect(decodeIdentity(id)).toEqual({ gameId: F.gameId, x: 17, y: 9 });
    expect(identityHex(F.gameId, 17, 9)).toBe(toHex(id));
  });

  it('rejects bad lengths and off-grid tiles', () => {
    expect(() => decodeIdentity(new Uint8Array(33))).toThrow();
    expect(() => decodeIdentity(new Uint8Array(35))).toThrow();
    expect(() => encodeIdentity(F.gameId, 24, 0)).toThrow();
  });

  it('vision covers own tile at 0 and the 3x3 block at 1', () => {
    expect(visibleTiles(5, 5, 0)).toEqual([[5, 5]]);
    expect(visibleTiles(5, 5, 1)).toHaveLength(9);
    expect(visibleTiles(0, 0, 1)).toHaveLength(4);
    expect(chebyshev(0, 23, 23, 0)).toBe(23);
  });
});

describe('map generation', () => {
  it('produces valid, solvable maps', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const map = generateMap(seededRng(seed));
      expect(validateMap(map), `seed ${seed}`).toEqual([]);
    }
  });

  it('counts match the spec mix', () => {
    const map = generateMap(seededRng(42));
    const count = (k: number) => map.filter((v) => v === k).length;
    expect(count(TileKind.CREVASSE)).toBe(MAP_MIX.crevasses);
    expect(count(TileKind.GOGGLES)).toBe(MAP_MIX.goggles);
    expect(count(TileKind.ROPE)).toBe(MAP_MIX.ropes);
    expect(count(TileKind.RELIC)).toBe(1);
  });

  it('warmth bands and hazards follow the spec', () => {
    expect(warmthAt(0, 0, [0, 2])).toBe(5);
    expect(warmthAt(0, 0, [0, 4])).toBe(4);
    expect(warmthAt(0, 0, [0, 7])).toBe(3);
    expect(warmthAt(0, 0, [0, 11])).toBe(2);
    expect(warmthAt(0, 0, [0, 16])).toBe(1);
    expect(warmthAt(0, 0, [0, 17])).toBe(0);
    const map = new Uint8Array(TILE_COUNT);
    map[tileIndex(1, 1)] = TileKind.CREVASSE;
    map[tileIndex(2, 2)] = TileKind.CREVASSE;
    expect(hazardsAt(map, 1, 2)).toBe(2);
    expect(hazardsAt(map, 1, 1)).toBe(1); // a crevasse does not count itself
  });

  it('flags an unsolvable map', () => {
    const map = generateMap(seededRng(7));
    for (let x = 0; x < GRID; x++) if (map[tileIndex(x, 1)] !== TileKind.RELIC) map[tileIndex(x, 1)] = TileKind.CREVASSE;
    expect(validateMap(map)).toContain('crevasse count');
  });
});

describe('deal, plaintexts and the thaw', () => {
  const sk = new Uint8Array(32).fill(7);
  const map = generateMap(seededRng(99));
  // Stand-in encryptor: deterministic, varying lengths, so ct_hash framing matters.
  const fakeEncrypt = async (id: string, pt: Uint8Array) => Uint8Array.from([...fromHex(id), ...pt]);

  it('every plaintext is exactly 160 bytes and decodes back', () => {
    const tiles = signTiles(map, F.gameId, 5n, sk);
    for (const t of tiles) {
      const bytes = encodeTilePlaintext(t);
      expect(bytes.length).toBe(TILE_PLAINTEXT_LEN);
      const back = decodeTilePlaintext(t.x, t.y, bytes);
      expect(back.kind).toBe(t.kind);
      expect(verifyTile(ed25519.getPublicKey(sk), F.gameId, 5n, back)).toBe(true);
    }
  });

  it('a tampered clue fails verification (AC10)', () => {
    const [t] = signTiles(map, F.gameId, 5n, sk);
    expect(verifyTile(ed25519.getPublicKey(sk), F.gameId, 5n, { ...t!, warmth: (t!.warmth + 1) % 6 })).toBe(false);
    expect(verifyTile(ed25519.getPublicKey(sk), F.otherGameId, 5n, t!)).toBe(false);
  });

  it('deal output commits to the ciphertexts (R23, AC22)', async () => {
    const out = await deal({ map, gameId: F.gameId, dealTs: 5n, secretKey: sk, encrypt: fakeEncrypt });
    expect(out.tiles).toHaveLength(TILE_COUNT);
    expect(out.tiles[25]!.id).toBe('t-1-1');
    const cts = out.tiles.map((t) => t.ct);
    expect(checkCiphertexts(cts, out.ctHash)).toBe(true);
    expect(verifyDealSig(out.dealerPk, F.gameId, 5n, out.ctHash, out.dealSig)).toBe(true);
    const swapped = [...cts];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(checkCiphertexts(swapped, out.ctHash)).toBe(false);
    const corrupt = cts.map((c, i) => (i === 300 ? Uint8Array.from(c, (b, j) => (j === 0 ? b ^ 1 : b)) : c));
    expect(checkCiphertexts(corrupt, out.ctHash)).toBe(false);
    expect(ctHash(cts)).toEqual(out.ctHash);
  });

  it('the thaw file verifies, and any tampered byte is caught (AC27)', () => {
    const tiles = signTiles(map, F.gameId, 5n, sk);
    const thaw = thawFile(F.gameId, tiles);
    const pk = ed25519.getPublicKey(sk);
    const ok = verifyThaw(thaw, F.gameId, pk, 5n);
    expect(ok.ok).toBe(true);
    expect(ok.map).toEqual(map);
    const bad = structuredClone(thaw);
    const h = bad.tiles[10]!.plaintext_hex;
    bad.tiles[10]!.plaintext_hex = (h[0] === '0' ? '1' : '0') + h.slice(1);
    expect(verifyThaw(bad, F.gameId, pk, 5n).ok).toBe(false);
  });
});

describe('object layouts', () => {
  it('parses a Game and an Explorer from BCS', () => {
    const id = '0x' + 'ab'.repeat(32);
    const game = GameBcs.serialize({
      id,
      host: id,
      status: 1,
      dealer_kind: 1,
      dealer_pk: Array.from(F.dealerPk),
      enclave_id: id,
      deal_ts: 9n,
      quilt_id: Array.from(new TextEncoder().encode('quilt')),
      ct_hash: Array.from(F.ctHash),
      entry_stake: 10n,
      max_players: 64,
      player_count: 2,
      duration_ms: 7_200_000n,
      resolve_window_ms: 300_000n,
      open_at: 1000n,
      ends_at: 7_201_000n,
      well_fund: id,
      pot: { value: 5n },
      explorers: { id, size: 2n },
      finder: null,
      has_prize: true,
      thaw_blob: null,
    }).toBytes();
    const g = parseGame(game, '0x1::game::Game<0x2::sui::SUI>');
    expect(g.coinType).toBe('0x2::sui::SUI');
    expect(g.quiltId).toBe('quilt');
    expect(g.pot).toBe(5n);
    expect(isEnded(g, 7_200_999)).toBe(false);
    expect(isEnded(g, 7_201_000)).toBe(true);

    const visited = new Uint8Array(72);
    visited[tileIndex(3, 1) >> 3] |= 1 << (tileIndex(3, 1) & 7);
    const e = parseExplorer(
      ExplorerBcs.serialize({
        id,
        game_id: id,
        owner: id,
        x: 3,
        y: 1,
        vision: 1,
        vision_steps: 9,
        ropes: 2,
        status: 0,
        pending: { x: 3, y: 1, deadline_ms: 500n },
        last_step_ms: 100n,
        visited: Array.from(visited),
        stake: { value: 10n },
        steps: 4,
      }).toBytes(),
    );
    expect(e.pending).toEqual({ x: 3, y: 1, deadlineMs: 500 });
    expect(hasVisited(e.visited, 3, 1)).toBe(true);
    expect(hasVisited(e.visited, 3, 2)).toBe(false);
  });
});

describe('transactions', () => {
  const ctx = { packageId: '0x' + '1'.padStart(64, '0'), coinType: '0x2::sui::SUI' };
  const calls = (t: ReturnType<typeof tx.step>) =>
    t.getData().commands.flatMap((c) => (c.MoveCall ? [`${c.MoveCall.module}::${c.MoveCall.function}`] : []));

  it('routes each kind to the right resolve call', () => {
    const base = { gameId: '0x5', explorerId: '0x6', kindSig: new Uint8Array(64), prizeType: '0x9::p::P' };
    expect(calls(tx.resolveTile(ctx, { ...base, kind: TileKind.CREVASSE, ropes: 0, huntLive: true }))).toEqual(['game::resolve_fatal']);
    expect(calls(tx.resolveTile(ctx, { ...base, kind: TileKind.CREVASSE, ropes: 1, huntLive: true }))).toEqual(['game::resolve']);
    expect(calls(tx.resolveTile(ctx, { ...base, kind: TileKind.RELIC, ropes: 0, huntLive: true }))).toEqual(['game::claim_relic']);
    expect(calls(tx.resolveTile(ctx, { ...base, kind: TileKind.RELIC, ropes: 0, huntLive: false }))).toEqual(['game::resolve']);
  });

  it('a resolve and the next step can share one transaction', () => {
    const t = tx.resolveTile(ctx, {
      gameId: '0x5', explorerId: '0x6', kind: TileKind.SNOW, kindSig: new Uint8Array(64), ropes: 0, huntLive: true, prizeType: null,
    });
    tx.step(ctx, { gameId: '0x5', explorerId: '0x6', dir: 0 }, t);
    expect(calls(t)).toEqual(['game::resolve', 'game::step']);
  });

  it('a zero-stake join uses coin::zero, never the gas coin', () => {
    const t = tx.join(ctx, { gameId: '0x5', stake: 0n, column: 3 });
    expect(calls(t)).toEqual(['coin::zero', 'game::join']);
  });

  it('seal_approve batches one call per identity', () => {
    const ids = [encodeIdentity(F.gameId, 1, 1), encodeIdentity(F.gameId, 1, 2)];
    expect(calls(tx.sealApprove(ctx, { gameId: '0x5', explorerId: '0x6', identities: ids }))).toEqual([
      'policy::seal_approve',
      'policy::seal_approve',
    ]);
  });
});

describe('errors', () => {
  it('maps abort codes', () => {
    expect(parseAbort({ MoveAbort: { abortCode: '10' } })?.name).toBe('ECooldown');
    expect(parseAbort({ MoveAbort: { abortCode: '23', location: { package: '0x1' } } }, '0x2')).toBeNull();
    expect(Object.keys(ABORTS)).toHaveLength(23);
  });
});
