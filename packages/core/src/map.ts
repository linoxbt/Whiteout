/** Map generation and clues (spec sections 8 and 12). Shared by the ceremony dealer
 * in the host CLI and the tests; the Rust enclave implements the same rules. */
import { BASE_ROW, GRID, MAP_MIX, RELIC_MIN_ROW, TILE_COUNT, TileKind } from './constants.js';
import { chebyshev, onGrid, tileIndex } from './identity.js';

/** Kinds in row-major order: index y*24+x. */
export type MapKinds = Uint8Array;

/** Returns a uniformly random integer in [0, n). */
export type Rng = (n: number) => number;

export const cryptoRng: Rng = (n) => {
  if (n <= 0 || n > 2 ** 32) throw new Error('bad range');
  const limit = Math.floor(2 ** 32 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
};

/** Deterministic RNG for tests only (xorshift32). */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

export function warmthAt(x: number, y: number, relic: [number, number]): number {
  const d = chebyshev(x, y, relic[0], relic[1]);
  if (d <= 2) return 5;
  if (d <= 4) return 4;
  if (d <= 7) return 3;
  if (d <= 11) return 2;
  if (d <= 16) return 1;
  return 0;
}

export function hazardsAt(map: MapKinds, x: number, y: number): number {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (onGrid(nx, ny) && map[tileIndex(nx, ny)] === TileKind.CREVASSE) n++;
    }
  return n;
}

export function findRelic(map: MapKinds): [number, number] {
  const i = map.indexOf(TileKind.RELIC);
  if (i < 0) throw new Error('map has no relic');
  return [i % GRID, Math.floor(i / GRID)];
}

/** True when a crevasse-free 4-way path joins row 0 to the relic (R20). */
export function relicReachable(map: MapKinds): boolean {
  const [rx, ry] = findRelic(map);
  const seen = new Uint8Array(TILE_COUNT);
  const queue: number[] = [];
  for (let x = 0; x < GRID; x++) {
    seen[tileIndex(x, BASE_ROW)] = 1;
    queue.push(tileIndex(x, BASE_ROW));
  }
  while (queue.length) {
    const i = queue.shift()!;
    const x = i % GRID;
    const y = Math.floor(i / GRID);
    if (x === rx && y === ry) return true;
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!onGrid(nx, ny)) continue;
      const j = tileIndex(nx, ny);
      if (seen[j] || map[j] === TileKind.CREVASSE) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  return false;
}

/** One candidate layout: base row snow, relic in rows 12-23, the rest shuffled in. */
function layout(rng: Rng): MapKinds {
  const map = new Uint8Array(TILE_COUNT); // all snow
  const rx = rng(GRID);
  const ry = RELIC_MIN_ROW + rng(GRID - RELIC_MIN_ROW);
  map[tileIndex(rx, ry)] = TileKind.RELIC;
  const free: number[] = [];
  for (let i = GRID; i < TILE_COUNT; i++) if (map[i] === TileKind.SNOW) free.push(i);
  // Partial Fisher-Yates: the first k entries are a uniform sample.
  const k = MAP_MIX.crevasses + MAP_MIX.goggles + MAP_MIX.ropes;
  for (let i = 0; i < k; i++) {
    const j = i + rng(free.length - i);
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  let o = 0;
  for (let n = 0; n < MAP_MIX.crevasses; n++) map[free[o++]!] = TileKind.CREVASSE;
  for (let n = 0; n < MAP_MIX.goggles; n++) map[free[o++]!] = TileKind.GOGGLES;
  for (let n = 0; n < MAP_MIX.ropes; n++) map[free[o++]!] = TileKind.ROPE;
  return map;
}

/** Generates a solvable map, retrying up to 1 000 times (spec section 12). */
export function generateMap(rng: Rng = cryptoRng): MapKinds {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const map = layout(rng);
    if (relicReachable(map)) return map;
  }
  throw new Error('no solvable map after 1000 tries');
}

/** Checks a map against every dealer rule. Returns a list of problems (empty = valid). */
export function validateMap(map: MapKinds): string[] {
  const problems: string[] = [];
  if (map.length !== TILE_COUNT) return [`map has ${map.length} tiles`];
  const count = (k: number) => map.reduce((n, v) => n + (v === k ? 1 : 0), 0);
  if (count(TileKind.RELIC) !== MAP_MIX.relic) problems.push('relic count');
  if (count(TileKind.CREVASSE) !== MAP_MIX.crevasses) problems.push('crevasse count');
  if (count(TileKind.GOGGLES) !== MAP_MIX.goggles) problems.push('goggles count');
  if (count(TileKind.ROPE) !== MAP_MIX.ropes) problems.push('rope count');
  for (let x = 0; x < GRID; x++) if (map[x] !== TileKind.SNOW) problems.push(`base row (${x}, 0) is not snow`);
  if (problems.length === 0) {
    const [, ry] = findRelic(map);
    if (ry < RELIC_MIN_ROW) problems.push('relic below row 12');
    if (!relicReachable(map)) problems.push('relic unreachable');
  }
  return problems;
}
