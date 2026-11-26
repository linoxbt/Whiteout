/** Chain reads: Game, Explorer, events and the public trail. Sui is the only source of truth. */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { NetworkConfig } from './config.js';
import { ExplorerStatus } from './constants.js';
import { bcs } from '@mysten/sui/bcs';
import { normalizeStructTag } from '@mysten/sui/utils';
import {
  AllowlistEventBcs,
  parseAllowlist,
  parseEvent,
  parseExplorer,
  parseGame,
  type AllowlistState,
  type ExplorerState,
  type GameEvent,
  type GameState,
} from './state.js';

export type Client = SuiGrpcClient;

export function makeClient(cfg: Pick<NetworkConfig, 'network' | 'rpcUrl'>): Client {
  return new SuiGrpcClient({ network: cfg.network, baseUrl: cfg.rpcUrl });
}

/** Throws unless `type` is `<packageId>::<module>::<name>` (any type arguments). */
function assertType(type: string | undefined, packageId: string | undefined, module: string, name: string, id: string) {
  if (!packageId) return;
  const m = (type ?? '').match(/^(0x[0-9a-fA-F]+)::(\w+)::(\w+)/);
  if (!m || !sameId(m[1]!, packageId) || m[2] !== module || m[3] !== name) {
    throw new Error(`${id} is not a Whiteout ${name} of this deployment (${type ?? 'unknown type'})`);
  }
}

/** Reads a Game. With `packageId`, refuses a look-alike object from another package. */
export async function getGame(client: Client, gameId: string, packageId?: string): Promise<GameState> {
  const { object } = await client.core.getObject({ objectId: gameId, include: { content: true } });
  assertType(object.type, packageId, 'game', 'Game', gameId);
  return parseGame(object.content, object.type);
}

export async function getExplorer(client: Client, explorerId: string, packageId?: string): Promise<ExplorerState> {
  const { object } = await client.core.getObject({ objectId: explorerId, include: { content: true } });
  assertType(object.type, packageId, 'game', 'Explorer', explorerId);
  return parseExplorer(object.content);
}

export async function getExplorers(client: Client, ids: string[]): Promise<ExplorerState[]> {
  const out: ExplorerState[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { objects } = await client.core.getObjects({ objectIds: ids.slice(i, i + 50), include: { content: true } });
    for (const o of objects) if (!(o instanceof Error)) out.push(parseExplorer(o.content));
  }
  return out;
}

/**
 * All Whiteout events for one game, oldest first, and a cursor to poll for newer ones.
 *
 * Full nodes cannot filter events by game, so a first read (`after` null) scans the
 * package's events newest-first and stops at this game's LobbyCreated: the scan covers
 * the game's own lifetime, not the package's whole history. Later polls pass the
 * returned cursor and read forward from it. `complete` is false only when the page
 * budget ran out; the cursor still moves forward, so the next poll continues.
 * `fromStart` is false when the node no longer has the game's oldest events: call
 * `reconcileTrail` to fill in what they would have said.
 */
export async function listGameEvents(
  client: Client,
  packageId: string,
  gameId: string,
  after: string | null = null,
  maxPages = 400,
): Promise<{ events: GameEvent[]; cursor: string | null; complete: boolean; fromStart: boolean }> {
  const mine = (e: Parameters<typeof parseEvent>[1]) => {
    const parsed = parseEvent(packageId, e);
    return parsed && sameId((parsed.data as { game_id: string }).game_id, gameId) ? parsed : null;
  };
  const filter = { emitModule: `${packageId}::game` };
  if (after) {
    const out: GameEvent[] = [];
    let cursor = after;
    for (let page = 0; page < maxPages; page++) {
      const res = await client.core.listEvents({ filter, limit: 50, after: cursor });
      for (const e of res.events) {
        const p = mine(e);
        if (p) out.push(p);
      }
      cursor = res.endCursor ?? cursor;
      if (!res.hasNextPage) return { events: out, cursor, complete: true, fromStart: true };
    }
    return { events: out, cursor, complete: false, fromStart: true };
  }
  // Newest first, back to the game's creation.
  const back: GameEvent[] = [];
  let newest: string | null = null;
  let before: string | null = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const res = await client.core.listEvents({ filter, limit: 50, order: 'descending', ...(before ? { before } : {}) });
      if (page === 0) newest = res.startCursor ?? null;
      for (const e of res.events) {
        const p = mine(e);
        if (!p) continue;
        back.push(p);
        if (p.name === 'LobbyCreated') return { events: back.reverse(), cursor: newest, complete: true, fromStart: true };
      }
      before = res.endCursor ?? before;
      if (!res.hasNextPage) return { events: back.reverse(), cursor: newest, complete: true, fromStart: false };
    }
    return { events: back.reverse(), cursor: newest, complete: false, fromStart: false };
  } catch (e) {
    // A newest-first scan errors once it has to look past the node's pruned edge (on a
    // quiet package that can be the very first page). Read everything the node still
    // keeps oldest-first instead; the caller fills what was pruned from the game's own
    // objects (reconcileTrail).
    if (!isPrunedError(e)) throw e;
  }
  return forwardFromEarliest(client, filter, mine, maxPages);
}

/** True for the error a full node returns for data older than it keeps. */
export function isPrunedError(e: unknown): boolean {
  return /earliest available|below (the )?earliest|pruned/i.test((e as Error)?.message ?? '');
}

async function forwardFromEarliest(
  client: Client,
  filter: { emitModule: string },
  mine: (e: Parameters<typeof parseEvent>[1]) => GameEvent | null,
  maxPages: number,
): Promise<{ events: GameEvent[]; cursor: string | null; complete: boolean; fromStart: boolean }> {
  const out: GameEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.core.listEvents({ filter, limit: 50, ...(cursor ? { after: cursor } : {}) });
    for (const e of res.events) {
      const p = mine(e);
      if (p) out.push(p);
    }
    cursor = res.endCursor ?? cursor;
    if (!res.hasNextPage) break;
    if (page === maxPages - 1) return { events: out, cursor, complete: false, fromStart: out.some((e) => e.name === 'LobbyCreated') };
  }
  return { events: out, cursor, complete: true, fromStart: out.some((e) => e.name === 'LobbyCreated') };
}

/**
 * Lobbies and hunts created by this package, newest first. Public full nodes prune old
 * checkpoints, and a descending scan that runs past the pruned edge errors, so this
 * falls back to an ascending scan from the earliest checkpoint the node still has.
 */
export async function listGames(client: Client, packageId: string, limit = 50): Promise<string[]> {
  const type = `${packageId}::game::LobbyCreated`;
  const ids = (events: Array<{ eventType: string; bcs: Uint8Array }>) =>
    events
      .map((e) => parseEvent(packageId, e))
      .filter((e): e is GameEvent => !!e && e.name === 'LobbyCreated')
      .map((e) => (e.data as { game_id: string }).game_id);
  try {
    const res = await client.core.listEvents({ filter: { eventType: type }, limit, order: 'descending' });
    return ids(res.events);
  } catch (e) {
    if (!isPrunedError(e)) throw e;
  }
  const found: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page++) {
    const res = await client.core.listEvents({ filter: { eventType: type }, limit: 50, ...(after ? { after } : {}) });
    found.push(...ids(res.events));
    after = res.endCursor ?? after;
    if (!res.hasNextPage) break;
  }
  return found.reverse().slice(0, limit);
}

// === State without events ===
// Public full nodes prune old events (testnet keeps days, not weeks), so a long hunt
// cannot rely on its event history alone. The Game keeps what matters on-chain: an
// address -> Explorer table, and each held prize under a PrizeKey dynamic field.

const FieldAddressId = bcs.struct('Field', { id: bcs.Address, name: bcs.Address, value: bcs.Address });

const isMissing = (e: unknown) => /not.?found|does not exist|NotExists|DynamicFieldNotFound/i.test((e as Error)?.message ?? '');

/** The Explorer `owner` holds in `game`, read from the game's table, or null. */
export async function findExplorerId(client: Client, game: Pick<GameState, 'explorersTable'>, owner: string): Promise<string | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: game.explorersTable,
      name: { type: 'address', bcs: bcs.Address.serialize(owner).toBytes() },
    });
    return bcs.Address.parse(dynamicField.value.bcs);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Every Explorer of `game` (owner -> Explorer ID), read from the game's table. */
export async function listExplorerIds(client: Client, game: Pick<GameState, 'explorersTable'>): Promise<Map<string, string>> {
  const fieldIds: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const res = await client.core.listDynamicFields({ parentId: game.explorersTable, limit: 50, ...(cursor ? { cursor } : {}) });
    fieldIds.push(...res.dynamicFields.map((f) => f.fieldId));
    cursor = res.cursor;
    if (!res.hasNextPage) break;
  }
  const out = new Map<string, string>();
  for (let i = 0; i < fieldIds.length; i += 50) {
    const { objects } = await client.core.getObjects({ objectIds: fieldIds.slice(i, i + 50), include: { content: true } });
    for (const o of objects) {
      if (o instanceof Error) continue;
      const f = FieldAddressId.parse(o.content);
      out.set(f.name, f.value);
    }
  }
  return out;
}

/** Prize types still held by the game, by rank (PrizeKey dynamic object fields). */
export async function prizeTypesOf(client: Client, gameId: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await client.core.listDynamicFields({ parentId: gameId, limit: 50, ...(cursor ? { cursor } : {}) });
    for (const f of res.dynamicFields) {
      if (!/::game::PrizeKey$/.test(f.name.type)) continue;
      out.set(f.name.bcs[0]!, normalizeStructTag(f.valueType));
    }
    cursor = res.cursor;
    if (!res.hasNextPage) break;
  }
  return out;
}

/**
 * Fills the trail's explorers from the game's own table, for when the event history
 * no longer reaches back to the game's creation. Positions and outcomes come from the
 * Explorer objects; newer events then keep them current.
 */
export async function reconcileTrail(client: Client, game: GameState, trail: Trail): Promise<Trail> {
  const ids = await listExplorerIds(client, game);
  const missing = [...ids.values()].filter((id) => !trail.explorers.has(id));
  if (missing.length) {
    for (const x of await getExplorers(client, missing)) {
      trail.explorers.set(x.id, {
        owner: x.owner,
        x: x.x,
        y: x.y,
        frozen: x.status === ExplorerStatus.FROZEN,
        finder: x.status === ExplorerStatus.FINDER,
        withdrawn: x.status === ExplorerStatus.WITHDRAWN,
        steps: x.steps,
      });
    }
  }
  if (game.prizesHeld > 0) {
    for (const [rank, type] of await prizeTypesOf(client, game.id)) {
      trail.prizeTypes.set(rank, type);
      if (rank === 1) trail.prizeType = type;
    }
  }
  return trail;
}

// === Phase 2: allowlists ===

export async function getAllowlist(client: Client, listId: string): Promise<AllowlistState> {
  const { object } = await client.core.getObject({ objectId: listId, include: { content: true } });
  return parseAllowlist(object.content);
}

/** Whether `address` is on the list (a lookup in the list's members table). */
export async function onAllowlist(client: Client, list: AllowlistState, address: string): Promise<boolean> {
  try {
    await client.core.getDynamicField({
      parentId: list.membersTable,
      name: { type: 'address', bcs: bcs.Address.serialize(address).toBytes() },
    });
    return true;
  } catch (e) {
    // Only a missing field means "not a member"; a network error must not lock a member out.
    if (/not.?found|does not exist|NotExists|dynamic field/i.test((e as Error).message)) return false;
    throw e;
  }
}

/** Allowlists created by this package, newest first. */
export async function listAllowlists(client: Client, packageId: string, limit = 50): Promise<Array<{ id: string; name: string }>> {
  const res = await client.core.listEvents({
    filter: { eventType: `${packageId}::allowlist::AllowlistCreated` },
    limit,
    order: 'descending',
  });
  return res.events.map((e) => {
    const d = AllowlistEventBcs.AllowlistCreated.parse(e.bcs);
    return { id: d.list_id, name: d.name };
  });
}

export function sameId(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return n(a) === n(b);
}

/** The public trail (FR24): positions, resolved kinds and freezes, from events alone. */
export interface Trail {
  explorers: Map<
    string,
    { owner: string; x: number; y: number; frozen: boolean; finder: boolean; withdrawn: boolean; steps: number }
  >;
  resolved: Map<string, number>; // "x,y" -> kind
  frozenAt: Array<{ explorerId: string; toWell: bigint; toPot: bigint; overdue: boolean }>;
  /** First finder (rank 1). */
  finder: string | null;
  /** Prize type of rank 1 (single-relic games). */
  prizeType: string | null;
  /** Phase 2: prize type by rank, finders in rank order, and blizzards seen. */
  prizeTypes: Map<number, string>;
  finders: Array<{ rank: number; finder: string; explorerId: string; pot: bigint; x: number; y: number }>;
  blizzards: number;
  dealt: { dealerKind: number; enclaveId: string | null; openAt: number; endsAt: number } | null;
  /** Event ids already applied: applying the same event twice changes nothing. */
  seen: Set<string>;
}

export function emptyTrail(): Trail {
  return {
    explorers: new Map(),
    resolved: new Map(),
    frozenAt: [],
    finder: null,
    prizeType: null,
    prizeTypes: new Map(),
    finders: [],
    blizzards: 0,
    dealt: null,
    seen: new Set(),
  };
}

export function applyEvents(trail: Trail, events: GameEvent[]): Trail {
  trail.seen ??= new Set();
  for (const ev of events) {
    if (ev.id && trail.seen.has(ev.id)) continue;
    if (ev.id) trail.seen.add(ev.id);
    switch (ev.name) {
      case 'PrizeDeposited': {
        // type_name::into_string omits every 0x, including inside type arguments.
        const t = ev.data.prize_type.includes('::') ? normalizeStructTag(ev.data.prize_type.replace(/(^|[<,\s])(?!0x)([0-9a-fA-F]{64})::/g, '$10x$2::')) : ev.data.prize_type;
        trail.prizeTypes.set(ev.data.rank, t);
        if (ev.data.rank === 1) trail.prizeType = t;
        break;
      }
      case 'BlizzardStarted':
        trail.blizzards += 1;
        break;
      case 'GameDealt':
        trail.dealt = {
          dealerKind: ev.data.dealer_kind,
          enclaveId: ev.data.enclave_id ?? null,
          openAt: Number(ev.data.open_at),
          endsAt: Number(ev.data.ends_at),
        };
        break;
      case 'ExplorerJoined':
        trail.explorers.set(ev.data.explorer_id, {
          owner: ev.data.owner,
          x: ev.data.column,
          y: 0,
          frozen: false,
          finder: false,
          withdrawn: false,
          steps: 0,
        });
        break;
      case 'Stepped': {
        const e = trail.explorers.get(ev.data.explorer_id);
        if (e) Object.assign(e, { x: ev.data.x, y: ev.data.y, steps: e.steps + 1 });
        break;
      }
      case 'TileResolved':
        trail.resolved.set(`${ev.data.x},${ev.data.y}`, ev.data.kind);
        break;
      case 'ExplorerFrozen': {
        const e = trail.explorers.get(ev.data.explorer_id);
        if (e) e.frozen = true;
        trail.frozenAt.push({
          explorerId: ev.data.explorer_id,
          toWell: BigInt(ev.data.to_well),
          toPot: BigInt(ev.data.to_pot),
          overdue: ev.data.overdue,
        });
        break;
      }
      case 'RelicClaimed': {
        if (ev.data.rank === 1) trail.finder = ev.data.finder;
        trail.finders.push({
          rank: ev.data.rank,
          finder: ev.data.finder,
          explorerId: ev.data.explorer_id,
          pot: BigInt(ev.data.pot),
          x: ev.data.x,
          y: ev.data.y,
        });
        const e = trail.explorers.get(ev.data.explorer_id);
        if (e) e.finder = true;
        break;
      }
      case 'StakeWithdrawn': {
        const e = trail.explorers.get(ev.data.explorer_id);
        if (e) e.withdrawn = true;
        break;
      }
      default:
        break;
    }
  }
  return trail;
}
