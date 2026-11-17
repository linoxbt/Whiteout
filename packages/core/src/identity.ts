/** Seal identities: game_id (32 bytes) ‖ x ‖ y, without the package prefix. */
import { concatBytes, idBytes, idFromBytes, toHex, fromHex } from './bytes.js';
import { GRID } from './constants.js';

export function encodeIdentity(gameId: string, x: number, y: number): Uint8Array {
  if (!onGrid(x, y)) throw new Error(`tile (${x}, ${y}) is off the grid`);
  return concatBytes(idBytes(gameId), new Uint8Array([x, y]));
}

/** Hex form, as Seal's `encrypt({ id })` and `fetchKeys({ ids })` take it. */
export function identityHex(gameId: string, x: number, y: number): string {
  return toHex(encodeIdentity(gameId, x, y));
}

export function decodeIdentity(id: Uint8Array | string): { gameId: string; x: number; y: number } {
  const b = typeof id === 'string' ? fromHex(id.replace(/^0x/, '')) : id;
  if (b.length !== 34) throw new Error('identity must be 34 bytes');
  const x = b[32]!;
  const y = b[33]!;
  if (!onGrid(x, y)) throw new Error('identity names a tile off the grid');
  return { gameId: idFromBytes(b.slice(0, 32)), x, y };
}

export function onGrid(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID && y < GRID;
}

export function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

/** Tiles a player may decrypt: their own, plus the 8 neighbours with goggles (FR9). */
export function visibleTiles(x: number, y: number, vision: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = -vision; dy <= vision; dy++)
    for (let dx = -vision; dx <= vision; dx++) if (onGrid(x + dx, y + dy)) out.push([x + dx, y + dy]);
  return out;
}

export function tileIndex(x: number, y: number): number {
  return y * GRID + x;
}

/** Walrus Quilt patch identifier for a tile (MD11). */
export function quiltPatchId(x: number, y: number): string {
  return `t-${x}-${y}`;
}
