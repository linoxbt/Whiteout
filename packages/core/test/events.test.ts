import { describe, expect, it } from 'vitest';
import { EventBcs, applyEvents, emptyTrail, listGameEvents } from '../src/index.js';

const PKG = '0x' + 'ab'.repeat(32);
const G = '0x' + '01'.repeat(32);
const OTHER = '0x' + '02'.repeat(32);
const X = '0x' + '03'.repeat(32);

const lobby = (game: string) =>
  EventBcs.LobbyCreated.serialize({
    game_id: game, host: X, coin_type: '0x2::sui::SUI', entry_stake: 0n, max_players: 8, duration_ms: 1n,
    resolve_window_ms: 1n, well_fund: X, relics: 1, pot_shares: [10000], blizzard_every_ms: 0n, blizzard_ms: 0n,
  }).toBytes();
const frozen = (game: string) =>
  EventBcs.ExplorerFrozen.serialize({ game_id: game, explorer_id: X, to_well: 5n, to_pot: 5n, overdue: false }).toBytes();
const ev = (name: string, bcs: Uint8Array, n: number) => ({
  eventType: `${PKG}::game::${name}`, bcs, transactionDigest: `d${n}`, eventIndex: 0, checkpoint: String(n),
  packageId: PKG, module: 'game', sender: X, json: null,
});

// Ledger, oldest first: an older game, then ours, then noise from another game.
const ledger = [
  ev('LobbyCreated', lobby(OTHER), 1),
  ev('LobbyCreated', lobby(G), 2),
  ev('ExplorerFrozen', frozen(OTHER), 3),
  ev('ExplorerFrozen', frozen(G), 4),
];

function fakeClient(log: string[]) {
  return {
    core: {
      async listEvents(o: { order?: string; before?: string; after?: string; limit?: number }) {
        const desc = o.order === 'descending';
        log.push(desc ? `desc:${o.before ?? ''}` : `asc:${o.after ?? ''}`);
        if (desc) {
          const end = o.before ? Number(o.before) : ledger.length;
          const page = ledger.slice(Math.max(0, end - 1), end).reverse(); // one per page
          return { events: page, hasNextPage: end - 1 > 0, startCursor: String(end), endCursor: String(end - 1) };
        }
        const start = o.after ? Number(o.after) : 0;
        const page = ledger.slice(start, start + 1);
        return { events: page, hasNextPage: start + 1 < ledger.length, startCursor: String(start), endCursor: String(start + page.length) };
      },
    },
  } as never;
}

describe('game events', () => {
  it('a first read scans back only to the game creation, then polls forward', async () => {
    const log: string[] = [];
    const first = await listGameEvents(fakeClient(log), PKG, G);
    expect(first.events.map((e) => e.name)).toEqual(['LobbyCreated', 'ExplorerFrozen']);
    expect(first.complete).toBe(true);
    // Stopped at our LobbyCreated (entry 2): never read the older game's lobby.
    expect(log.filter((l) => l.startsWith('desc')).length).toBe(3);
    ledger.push(ev('ExplorerFrozen', frozen(G), 5));
    const next = await listGameEvents(fakeClient(log), PKG, G, first.cursor);
    expect(next.events.map((e) => e.digest)).toEqual(['d5']);
    ledger.pop();
  });

  it('applying the same events twice changes nothing', async () => {
    const { events } = await listGameEvents(fakeClient([]), PKG, G);
    const t = applyEvents(emptyTrail(), events);
    applyEvents(t, events);
    expect(t.frozenAt.length).toBe(1);
  });
});

describe('reading a hunt the node has partly pruned', () => {
  it('falls back to a forward scan when the newest-first scan hits the pruned edge', async () => {
    const log: string[] = [];
    const client = {
      core: {
        async listEvents(o: { order?: string; after?: string }) {
          if (o.order === 'descending') {
            log.push('desc');
            throw new Error('requested data below earliest available; lowest available checkpoint is 405511841');
          }
          log.push(`asc:${o.after ?? ''}`);
          // The node only keeps our game's freeze; its lobby event is pruned.
          return { events: [ev('ExplorerFrozen', frozen(G), 4)], hasNextPage: false, startCursor: '0', endCursor: '1' };
        },
      },
    } as never;
    const r = await listGameEvents(client, PKG, G);
    expect(r.events.map((e) => e.name)).toEqual(['ExplorerFrozen']);
    expect(r.fromStart).toBe(false);
    expect(r.cursor).toBe('1');
    expect(log).toEqual(['desc', 'asc:']);
  });

  it('finds a player and the prizes from the game objects', async () => {
    const { bcs } = await import('@mysten/sui/bcs');
    const { findExplorerId, prizeTypesOf } = await import('../src/index.js');
    const EXPLORER = '0x' + '0e'.repeat(32);
    const client = {
      core: {
        async getDynamicField(o: { name: { bcs: Uint8Array } }) {
          if (bcs.Address.parse(o.name.bcs) !== X) throw new Error('Object 0xabc not found');
          return { dynamicField: { value: { type: '0x2::object::ID', bcs: bcs.Address.serialize(EXPLORER).toBytes() } } };
        },
        async listDynamicFields() {
          return {
            hasNextPage: false,
            cursor: null,
            dynamicFields: [
              { fieldId: '0x1', type: '', $kind: 'DynamicObject', childId: '0x5', name: { type: `${PKG}::game::PrizeKey`, bcs: Uint8Array.of(2) }, valueType: '0x2::coin::Coin<0x2::sui::SUI>' },
              { fieldId: '0x2', type: '', $kind: 'DynamicField', name: { type: '0x2::object::ID', bcs: new Uint8Array(32) }, valueType: 'u64' },
            ],
          };
        },
      },
    } as never;
    expect(await findExplorerId(client, { explorersTable: '0x9' }, X)).toBe(EXPLORER);
    expect(await findExplorerId(client, { explorersTable: '0x9' }, OTHER)).toBeNull();
    const types = await prizeTypesOf(client, G);
    expect([...types.keys()]).toEqual([2]);
    expect(types.get(2)).toMatch(/^0x0+2::coin::Coin<0x0+2::sui::SUI>$/);
  });
});
