/** Chain reads: Game, Explorer, events and the public trail. Sui is the only source of truth. */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { NetworkConfig } from './config.js';
import { parseEvent, parseExplorer, parseGame, type ExplorerState, type GameEvent, type GameState } from './state.js';

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

/** Every lobby or hunt ever created by this package, newest first. */
export async function listGames(client: Client, packageId: string, limit = 50): Promise<string[]> {
  const res = await client.core.listEvents({
    filter: { eventType: `${packageId}::game::LobbyCreated` },
    limit,
    order: 'descending',
  });
  return res.events
    .map((e) => parseEvent(packageId, e))
    .filter((e): e is GameEvent => !!e && e.name === 'LobbyCreated')
    .map((e) => (e.data as { game_id: string }).game_id);
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
  finder: string | null;
  prizeType: string | null;
  dealt: { dealerKind: number; enclaveId: string | null; openAt: number; endsAt: number } | null;
}

export function emptyTrail(): Trail {
  return { explorers: new Map(), resolved: new Map(), frozenAt: [], finder: null, prizeType: null, dealt: null };
}

export function applyEvents(trail: Trail, events: GameEvent[]): Trail {
  for (const ev of events) {
    switch (ev.name) {
      case 'PrizeDeposited':
        trail.prizeType = ev.data.prize_type.includes('::') ? `0x${ev.data.prize_type.replace(/^0x/, '')}` : ev.data.prize_type;
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
        trail.finder = ev.data.finder;
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
