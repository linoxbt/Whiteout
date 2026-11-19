import { normalizeSuiAddress } from '@mysten/sui/utils';
/** On-chain object and event layouts (BCS), parsed from gRPC object content. */
import { bcs } from '@mysten/sui/bcs';
import { ExplorerStatus, GameStatus, VISITED_BYTES } from './constants.js';
import { tileIndex } from './identity.js';

const Balance = bcs.struct('Balance', { value: bcs.u64() });
const Table = bcs.struct('Table', { id: bcs.Address, size: bcs.u64() });

export const GameBcs = bcs.struct('Game', {
  id: bcs.Address,
  host: bcs.Address,
  status: bcs.u8(),
  dealer_kind: bcs.u8(),
  dealer_pk: bcs.vector(bcs.u8()),
  enclave_id: bcs.option(bcs.Address),
  deal_ts: bcs.u64(),
  quilt_id: bcs.vector(bcs.u8()),
  ct_hash: bcs.vector(bcs.u8()),
  entry_stake: bcs.u64(),
  max_players: bcs.u16(),
  player_count: bcs.u16(),
  duration_ms: bcs.u64(),
  resolve_window_ms: bcs.u64(),
  open_at: bcs.u64(),
  ends_at: bcs.u64(),
  well_fund: bcs.Address,
  pot: Balance,
  explorers: Table,
  finder: bcs.option(bcs.Address),
  thaw_blob: bcs.option(bcs.vector(bcs.u8())),
  relics: bcs.u8(),
  pot_shares: bcs.vector(bcs.u16()),
  prizes_held: bcs.u8(),
  prizes_deposited: bcs.u8(),
  finders: bcs.vector(bcs.Address),
  claimed: bcs.vector(bcs.u16()),
  allowlist: bcs.option(bcs.Address),
  blizzard_every_ms: bcs.u64(),
  blizzard_ms: bcs.u64(),
  next_blizzard_at: bcs.u64(),
  drifts: bcs.vector(bcs.u16()),
  drift_until: bcs.u64(),
});

const Pending = bcs.struct('Pending', { x: bcs.u8(), y: bcs.u8(), deadline_ms: bcs.u64() });

export const ExplorerBcs = bcs.struct('Explorer', {
  id: bcs.Address,
  game_id: bcs.Address,
  owner: bcs.Address,
  x: bcs.u8(),
  y: bcs.u8(),
  vision: bcs.u8(),
  vision_steps: bcs.u8(),
  ropes: bcs.u8(),
  status: bcs.u8(),
  pending: bcs.option(Pending),
  last_step_ms: bcs.u64(),
  visited: bcs.vector(bcs.u8()),
  stake: Balance,
  steps: bcs.u32(),
});

export interface GameState {
  id: string;
  /** The coin type T of Game<T>, e.g. 0x2::sui::SUI. */
  coinType: string;
  host: string;
  status: number;
  dealerKind: number;
  dealerPk: Uint8Array;
  enclaveId: string | null;
  dealTs: bigint;
  quiltId: string;
  ctHash: Uint8Array;
  entryStake: bigint;
  maxPlayers: number;
  playerCount: number;
  durationMs: number;
  resolveWindowMs: number;
  openAt: number;
  endsAt: number;
  wellFund: string;
  pot: bigint;
  explorersTable: string;
  /** First finder (rank 1). */
  finder: string | null;
  hasPrize: boolean;
  thawBlob: string | null;
  /** Phase 2: relics (= prizes) and the pot share of each rank, in basis points. */
  relics: number;
  potShares: number[];
  prizesHeld: number;
  prizesDeposited: number;
  /** Finders in rank order, and the tile index (y*24+x) each claimed. */
  finders: string[];
  claimed: number[];
  /** Allowlist object ID when the game is gated. */
  allowlist: string | null;
  blizzardEveryMs: number;
  blizzardMs: number;
  nextBlizzardAt: number;
  /** Tile indices covered by drifts until `driftUntil`. */
  drifts: number[];
  driftUntil: number;
}

export interface ExplorerState {
  id: string;
  gameId: string;
  owner: string;
  x: number;
  y: number;
  vision: number;
  visionSteps: number;
  ropes: number;
  status: number;
  pending: { x: number; y: number; deadlineMs: number } | null;
  lastStepMs: number;
  visited: Uint8Array;
  stake: bigint;
  steps: number;
}

const utf8 = new TextDecoder();

/** Extracts T from `0x..::game::Game<T>`. */
export function typeArg(objectType: string): string {
  const m = objectType.match(/<(.+)>$/);
  if (!m) throw new Error(`no type argument in ${objectType}`);
  return m[1]!;
}

export function parseGame(content: Uint8Array, objectType: string): GameState {
  const g = GameBcs.parse(content);
  return {
    id: g.id,
    coinType: typeArg(objectType),
    host: g.host,
    status: g.status,
    dealerKind: g.dealer_kind,
    dealerPk: Uint8Array.from(g.dealer_pk),
    enclaveId: g.enclave_id ?? null,
    dealTs: BigInt(g.deal_ts),
    quiltId: utf8.decode(Uint8Array.from(g.quilt_id)),
    ctHash: Uint8Array.from(g.ct_hash),
    entryStake: BigInt(g.entry_stake),
    maxPlayers: g.max_players,
    playerCount: g.player_count,
    durationMs: Number(g.duration_ms),
    resolveWindowMs: Number(g.resolve_window_ms),
    openAt: Number(g.open_at),
    endsAt: Number(g.ends_at),
    wellFund: g.well_fund,
    pot: BigInt(g.pot.value),
    explorersTable: g.explorers.id,
    finder: g.finder ?? null,
    hasPrize: g.prizes_held > 0,
    thawBlob: g.thaw_blob ? utf8.decode(Uint8Array.from(g.thaw_blob)) : null,
    relics: g.relics,
    potShares: g.pot_shares.map(Number),
    prizesHeld: g.prizes_held,
    prizesDeposited: g.prizes_deposited,
    finders: g.finders,
    claimed: g.claimed.map(Number),
    allowlist: g.allowlist ?? null,
    blizzardEveryMs: Number(g.blizzard_every_ms),
    blizzardMs: Number(g.blizzard_ms),
    nextBlizzardAt: Number(g.next_blizzard_at),
    drifts: g.drifts.map(Number),
    driftUntil: Number(g.drift_until),
  };
}

export function parseExplorer(content: Uint8Array): ExplorerState {
  const e = ExplorerBcs.parse(content);
  return {
    id: e.id,
    gameId: e.game_id,
    owner: e.owner,
    x: e.x,
    y: e.y,
    vision: e.vision,
    visionSteps: e.vision_steps,
    ropes: e.ropes,
    status: e.status,
    pending: e.pending
      ? { x: e.pending.x, y: e.pending.y, deadlineMs: Number(e.pending.deadline_ms) }
      : null,
    lastStepMs: Number(e.last_step_ms),
    visited: Uint8Array.from(e.visited),
    stake: BigInt(e.stake.value),
    steps: e.steps,
  };
}

export function hasVisited(visited: Uint8Array, x: number, y: number): boolean {
  if (visited.length !== VISITED_BYTES) return false;
  const i = tileIndex(x, y);
  return ((visited[i >> 3]! >> (i & 7)) & 1) === 1;
}

/** Ended for the Seal policy and settlement (mirrors game::is_ended). */
export function isEnded(g: GameState, nowMs: number): boolean {
  return (
    g.status === GameStatus.ENDED_FOUND ||
    g.status === GameStatus.ENDED_UNCLAIMED ||
    (g.status === GameStatus.OPEN && nowMs >= g.endsAt)
  );
}

export function isLive(g: GameState, nowMs: number): boolean {
  return g.status === GameStatus.OPEN && nowMs < g.endsAt;
}

export const isActive = (e: ExplorerState) => e.status === ExplorerStatus.ACTIVE;

/** Phase 2: whether a drift covers (x, y) at `nowMs` (mirrors game::drift_at). */
export function driftAt(g: GameState, x: number, y: number, nowMs: number): boolean {
  return nowMs < g.driftUntil && g.drifts.includes(tileIndex(x, y));
}

/** Phase 2: a blizzard can be started now (mirrors game::blizzard_internal's checks). */
export function blizzardDue(g: GameState, nowMs: number): boolean {
  // The contract refuses a blizzard whose drifts would outlast the hunt.
  return g.status === GameStatus.OPEN && nowMs + g.blizzardMs <= g.endsAt && g.blizzardEveryMs > 0 && nowMs >= g.nextBlizzardAt;
}

/** Phase 2: the relic at (x, y) was already claimed, so it is plain ground. */
export function relicClaimed(g: GameState, x: number, y: number): boolean {
  return g.claimed.includes(tileIndex(x, y));
}

/** Phase 2: the pot share the next finder would take now (mirrors game::pot_share). */
export function nextPotShare(g: GameState): bigint {
  const i = g.finders.length;
  if (i >= g.relics) return 0n;
  const rest = g.potShares.slice(i).reduce((a, b) => a + b, 0);
  return rest === 0 ? 0n : (g.pot * BigInt(g.potShares[i]!)) / BigInt(rest);
}

// === Events ===

const Id = bcs.Address;

export const EventBcs = {
  LobbyCreated: bcs.struct('LobbyCreated', {
    game_id: Id,
    host: bcs.Address,
    coin_type: bcs.string(),
    entry_stake: bcs.u64(),
    max_players: bcs.u16(),
    duration_ms: bcs.u64(),
    resolve_window_ms: bcs.u64(),
    well_fund: bcs.Address,
    relics: bcs.u8(),
    pot_shares: bcs.vector(bcs.u16()),
    blizzard_every_ms: bcs.u64(),
    blizzard_ms: bcs.u64(),
  }),
  PrizeDeposited: bcs.struct('PrizeDeposited', { game_id: Id, prize_id: Id, prize_type: bcs.string(), rank: bcs.u8() }),
  AllowlistSet: bcs.struct('AllowlistSet', { game_id: Id, list_id: Id }),
  BlizzardStarted: bcs.struct('BlizzardStarted', {
    game_id: Id,
    drifts: bcs.vector(bcs.u16()),
    until_ms: bcs.u64(),
    next_ms: bcs.u64(),
  }),
  LobbyCancelled: bcs.struct('LobbyCancelled', { game_id: Id }),
  GameDealt: bcs.struct('GameDealt', {
    game_id: Id,
    dealer_kind: bcs.u8(),
    enclave_id: bcs.option(Id),
    quilt_id: bcs.vector(bcs.u8()),
    ct_hash: bcs.vector(bcs.u8()),
    open_at: bcs.u64(),
    ends_at: bcs.u64(),
  }),
  ExplorerJoined: bcs.struct('ExplorerJoined', {
    game_id: Id,
    explorer_id: Id,
    owner: bcs.Address,
    column: bcs.u8(),
  }),
  Stepped: bcs.struct('Stepped', {
    game_id: Id,
    explorer_id: Id,
    x: bcs.u8(),
    y: bcs.u8(),
    pending: bcs.bool(),
  }),
  TileResolved: bcs.struct('TileResolved', {
    game_id: Id,
    explorer_id: Id,
    x: bcs.u8(),
    y: bcs.u8(),
    kind: bcs.u8(),
  }),
  ItemGained: bcs.struct('ItemGained', { game_id: Id, explorer_id: Id, item: bcs.u8() }),
  RopeUsed: bcs.struct('RopeUsed', { game_id: Id, explorer_id: Id, x: bcs.u8(), y: bcs.u8() }),
  ExplorerFrozen: bcs.struct('ExplorerFrozen', {
    game_id: Id,
    explorer_id: Id,
    to_well: bcs.u64(),
    to_pot: bcs.u64(),
    overdue: bcs.bool(),
  }),
  RelicClaimed: bcs.struct('RelicClaimed', {
    game_id: Id,
    explorer_id: Id,
    finder: bcs.Address,
    prize_id: Id,
    pot: bcs.u64(),
    rank: bcs.u8(),
    x: bcs.u8(),
    y: bcs.u8(),
  }),
  GameFinalized: bcs.struct('GameFinalized', { game_id: Id, to_well: bcs.u64() }),
  StakeWithdrawn: bcs.struct('StakeWithdrawn', { game_id: Id, explorer_id: Id, amount: bcs.u64() }),
  PrizeReclaimed: bcs.struct('PrizeReclaimed', { game_id: Id, prize_id: Id, rank: bcs.u8() }),
  ThawPublished: bcs.struct('ThawPublished', { game_id: Id, blob_id: bcs.vector(bcs.u8()) }),
} as const;

export type EventName = keyof typeof EventBcs;

export type GameEvent = {
  [K in EventName]: {
    name: K;
    data: ReturnType<(typeof EventBcs)[K]['parse']>;
    digest: string;
    checkpoint: string | null;
    /** `digest:index`, unique per event: replaying a page never counts an event twice. */
    id: string;
  };
}[EventName];

const normalizeEventType = (t: string) => t.replace(/^(0x[0-9a-fA-F]+)::/, (_, a: string) => `${normalizeSuiAddress(a)}::`);

/** Parses a raw event if it is one of Whiteout's. */
export function parseEvent(
  packageId: string,
  e: { eventType: string; bcs: Uint8Array; transactionDigest?: string; checkpoint?: string | null; eventIndex?: number },
): GameEvent | null {
  // Event types carry the full 64-hex package ID; accept a short form in config too.
  const prefix = `${normalizeSuiAddress(packageId)}::game::`;
  if (!normalizeEventType(e.eventType).startsWith(prefix)) return null;
  const name = normalizeEventType(e.eventType).slice(prefix.length).replace(/<.*$/, '') as EventName;
  const layout = EventBcs[name];
  if (!layout) return null;
  return {
    name,
    data: layout.parse(e.bcs),
    digest: e.transactionDigest ?? '',
    checkpoint: e.checkpoint ?? null,
    id: `${e.transactionDigest ?? ''}:${e.eventIndex ?? 0}`,
  } as GameEvent;
}

// === Phase 2: allowlists (whiteout::allowlist) ===

export const AllowlistBcs = bcs.struct('Allowlist', {
  id: bcs.Address,
  name: bcs.string(),
  members: Table,
  size: bcs.u64(),
});

export interface AllowlistState {
  id: string;
  name: string;
  membersTable: string;
  size: number;
}

export function parseAllowlist(content: Uint8Array): AllowlistState {
  const l = AllowlistBcs.parse(content);
  return { id: l.id, name: l.name, membersTable: l.members.id, size: Number(l.size) };
}

export const AllowlistEventBcs = {
  AllowlistCreated: bcs.struct('AllowlistCreated', { list_id: Id, name: bcs.string() }),
  AllowlistChanged: bcs.struct('AllowlistChanged', {
    list_id: Id,
    added: bcs.u64(),
    removed: bcs.u64(),
    size: bcs.u64(),
  }),
} as const;

// === Nautilus enclave objects (vendored move/enclave) ===

export const EnclaveBcs = bcs.struct('Enclave', {
  id: bcs.Address,
  pk: bcs.vector(bcs.u8()),
  config_version: bcs.u64(),
  owner: bcs.Address,
});

export const EnclaveConfigBcs = bcs.struct('EnclaveConfig', {
  id: bcs.Address,
  name: bcs.string(),
  pcrs: bcs.tuple([bcs.vector(bcs.u8()), bcs.vector(bcs.u8()), bcs.vector(bcs.u8())]),
  capability_id: bcs.Address,
  version: bcs.u64(),
});
