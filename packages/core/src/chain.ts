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

export async function getGame(client: Client, gameId: string): Promise<GameState> {
  const { object } = await client.core.getObject({ objectId: gameId, include: { content: true } });
  return parseGame(object.content, object.type);
}

export async function getExplorer(client: Client, explorerId: string): Promise<ExplorerState> {
  const { object } = await client.core.getObject({ objectId: explorerId, include: { content: true } });
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
 * All Whiteout events for one game, oldest first. Events are filtered by module and
 * then by game ID (every Whiteout event carries it). `after` resumes a poll.
 */
export async function listGameEvents(
  client: Client,
  packageId: string,
  gameId: string,
  after: string | null = null,
): Promise<{ events: GameEvent[]; cursor: string | null }> {
  const out: GameEvent[] = [];
  let cursor = after;
  for (let page = 0; page < 200; page++) {
    const res = await client.core.listEvents({
      filter: { emitModule: `${packageId}::game` },
      limit: 50,
      ...(cursor ? { after: cursor } : {}),
    });
    for (const e of res.events) {
      const parsed = parseEvent(packageId, e);
      if (parsed && sameId((parsed.data as { game_id: string }).game_id, gameId)) out.push(parsed);
    }
    cursor = res.endCursor ?? cursor;
    if (!res.hasNextPage) break;
  }
  return { events: out, cursor };
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
  } catch {
    return false;
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
  };
}

export function applyEvents(trail: Trail, events: GameEvent[]): Trail {
  for (const ev of events) {
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
