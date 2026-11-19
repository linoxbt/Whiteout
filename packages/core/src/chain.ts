/** Chain reads: Game, Explorer, events and the public trail. Sui is the only source of truth. */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { NetworkConfig } from './config.js';
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
 */
export async function listGameEvents(
  client: Client,
  packageId: string,
  gameId: string,
  after: string | null = null,
  maxPages = 400,
): Promise<{ events: GameEvent[]; cursor: string | null; complete: boolean }> {
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
      if (!res.hasNextPage) return { events: out, cursor, complete: true };
    }
    return { events: out, cursor, complete: false };
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
        if (p.name === 'LobbyCreated') return { events: back.reverse(), cursor: newest, complete: true };
      }
      before = res.endCursor ?? before;
      if (!res.hasNextPage) return { events: back.reverse(), cursor: newest, complete: true };
    }
    return { events: back.reverse(), cursor: newest, complete: false };
  } catch (e) {
    // Past the node's pruned edge: read forward from the earliest event it still has.
    if (!/earliest available|pruned|below/i.test((e as Error).message)) throw e;
  }
  const out: GameEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.core.listEvents({ filter, limit: 50, ...(cursor ? { after: cursor } : {}) });
    for (const e of res.events) {
      const p = mine(e);
      if (p) out.push(p);
    }
    cursor = res.endCursor ?? cursor;
    if (!res.hasNextPage) return { events: out, cursor, complete: true };
  }
  return { events: out, cursor, complete: false };
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
    if (!/earliest available|pruned|below/i.test((e as Error).message)) throw e;
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
