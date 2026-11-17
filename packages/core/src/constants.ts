/** Rules and on-chain constants. Mirrors move/whiteout/sources (spec section 8). */

export const GRID = 24;
export const TILE_COUNT = GRID * GRID; // 576
export const BASE_ROW = 0;
export const STEP_COOLDOWN_MS = 8_000;
export const GOGGLE_STEPS = 10;
export const MAX_ROPES = 3;
export const MAX_PLAYERS_CAP = 128;
export const MAX_STAKE = 1n << 56n;
export const TILE_PLAINTEXT_LEN = 160;
export const VISITED_BYTES = 72;

export const MIN_DURATION_MS = 3_600_000;
export const MAX_DURATION_MS = 259_200_000;
export const MIN_RESOLVE_WINDOW_MS = 120_000;
export const MAX_RESOLVE_WINDOW_MS = 3_600_000;
export const DEFAULT_RESOLVE_WINDOW_MS = 300_000;
export const DEFAULT_DURATION_MS = 7_200_000;
export const DEFAULT_MAX_PLAYERS = 64;

/** Intent scopes: domain separation for every dealer signature. */
export const Intent = { DEAL: 1, TILE_KIND: 2, TILE_CLUE: 3 } as const;

export const TileKind = { SNOW: 0, CREVASSE: 1, GOGGLES: 2, ROPE: 3, RELIC: 4 } as const;
export type TileKindValue = (typeof TileKind)[keyof typeof TileKind];
export const TILE_KIND_NAMES: Record<number, string> = {
  0: 'Snow',
  1: 'Crevasse',
  2: 'Goggles',
  3: 'Rope',
  4: 'Frozen relic',
};

/** Map mix (spec section 8). */
export const MAP_MIX = { relic: 1, crevasses: 70, goggles: 12, ropes: 13 } as const;
export const RELIC_MIN_ROW = 12;

export const GameStatus = {
  LOBBY: 0,
  OPEN: 1,
  ENDED_FOUND: 2,
  ENDED_UNCLAIMED: 3,
  CANCELLED: 4,
} as const;

export const DealerKind = { NONE: 0, ENCLAVE: 1, CEREMONY: 2 } as const;

export const ExplorerStatus = { ACTIVE: 0, FROZEN: 1, WITHDRAWN: 2, FINDER: 3 } as const;

export const Direction = { NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3 } as const;
export type DirectionValue = (typeof Direction)[keyof typeof Direction];

/** Move step for each direction: north is y+1 (away from base camp). */
export const DIRECTION_DELTA: Record<DirectionValue, [number, number]> = {
  0: [0, 1],
  1: [1, 0],
  2: [0, -1],
  3: [-1, 0],
};

export const CLOCK_ID = '0x6';
