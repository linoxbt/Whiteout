/**
 * Design preview: a mock hunt that needs no wallet or chain, for reviewing every
 * gameplay screen. Only compiled in when VITE_PREVIEW=1 (see screens/Hunt.tsx); the
 * production build drops it. Open #/hunt/preview-<state>, where state is one of
 * PREVIEW_STATES. The yeti really walks: steps reveal tiles from a generated map.
 */
import {
  ExplorerStatus,
  GameStatus,
  GRID,
  STEP_COOLDOWN_MS,
  TileKind,
  emptyTrail,
  findRelics,
  DIRECTION_DELTA,
  driftAt,
  generateMap,
  hazardsAt,
  seededRng,
  tileIndex,
  warmthAt,
  type DirectionValue,
  type ExplorerState,
  type GameState,
  type Tile,
} from '@whiteout/core';
import type { Hunt, HuntView } from './hunt';

export const PREVIEW_STATES = ['login', 'lobby', 'gated', 'checking', 'session', 'play', 'blizzard', 'goggles', 'pending', 'relic', 'frozen', 'finder', 'thaw', 'spectate'] as const;
export const PREVIEW_ADDRESS = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

// Built on first use, so importing this module costs nothing.
let MAP!: Uint8Array;
let RELIC!: [number, number];
let RELICS!: Array<[number, number]>;
let PATH!: Array<[number, number]>;
let SIG!: Uint8Array;
function init() {
  if (MAP) return;
  // Phase 2: a ranked hunt with three relics. The path leads to the nearest one.
  MAP = generateMap(seededRng(20261118), 3);
  RELICS = findRelics(MAP);
  RELIC = RELICS.reduce((a, b) => (b[1] < a[1] ? b : a));
  SIG = new Uint8Array(0);
  PATH = pathToRelic();
}

function tileAt(x: number, y: number): Tile {
  return { x, y, kind: MAP[tileIndex(x, y)]!, warmth: warmthAt(x, y, RELICS), hazards: hazardsAt(MAP, x, y), kindSig: SIG, clueSig: SIG };
}

/** Shortest crevasse-free path from base camp to the relic. */
function pathToRelic(): Array<[number, number]> {
  const prev = new Map<number, number>();
  const q: number[] = [];
  for (let x = 0; x < GRID; x++) if (MAP[tileIndex(x, 0)] !== TileKind.CREVASSE) (q.push(tileIndex(x, 0)), prev.set(tileIndex(x, 0), -1));
  const goal = tileIndex(RELIC[0], RELIC[1]);
  while (q.length) {
    const i = q.shift()!;
    if (i === goal) break;
    const x = i % GRID;
    const y = Math.floor(i / GRID);
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const j = tileIndex(nx, ny);
      if (prev.has(j) || MAP[j] === TileKind.CREVASSE) continue;
      prev.set(j, i);
      q.push(j);
    }
  }
  const out: Array<[number, number]> = [];
  for (let i = goal; i !== -1; i = prev.get(i)!) out.unshift([i % GRID, Math.floor(i / GRID)]);
  return out;
}

function visitedBits(cells: Array<[number, number]>) {
  const v = new Uint8Array(72);
  for (const [x, y] of cells) {
    const i = tileIndex(x, y);
    v[i >> 3]! |= 1 << (i & 7);
  }
  return v;
}

/** Other yetis wandering the mountain, for the public trail. */
function others(trail: ReturnType<typeof emptyTrail>) {
  const r = seededRng(7);
  for (let n = 0; n < 9; n++) {
    let x = r(GRID);
    let y = 0;
    let frozen = false;
    const steps = 3 + r(12);
    for (let s = 0; s < steps; s++) {
      const d = r(4);
      const nx = Math.max(0, Math.min(GRID - 1, x + (d === 1 ? 1 : d === 3 ? -1 : 0)));
      const ny = Math.max(0, Math.min(GRID - 1, y + (d === 0 || d === 3 ? 1 : d === 2 ? -1 : 0)));
      x = nx;
      y = ny;
      const k = MAP[tileIndex(x, y)]!;
      trail.resolved.set(`${x},${y}`, k);
      if (k === TileKind.CREVASSE && r(3) === 0) {
        frozen = true;
        trail.frozenAt.push({ explorerId: `0xother${n}`, toWell: 50_000_000n, toPot: 50_000_000n, overdue: false });
        break;
      }
      if (k === TileKind.CREVASSE) {
        x = Math.max(0, x - 1);
      }
    }
    trail.explorers.set(`0xother${n}`, { owner: `0x${String(n).repeat(64)}`, x, y, frozen, finder: false, withdrawn: false, steps });
  }
}

const RIVAL = '0x' + '7'.repeat(64);

/** Twelve drifts scattered near the player's path, never on it (Phase 2 blizzard). */
function driftsNear(walked: Array<[number, number]>): number[] {
  const on = new Set(walked.map(([x, y]) => tileIndex(x, y)));
  const r = seededRng(31);
  const out: number[] = [];
  const [mx, my] = walked[walked.length - 1]!;
  while (out.length < 12) {
    const x = Math.max(0, Math.min(GRID - 1, mx - 5 + r(11)));
    const y = Math.max(1, Math.min(GRID - 1, my - 4 + r(10)));
    const i = tileIndex(x, y);
    if (!on.has(i) && !out.includes(i) && MAP[i] !== TileKind.RELIC) out.push(i);
  }
  return out;
}

export function makePreview(state: string): Hunt {
  init();
  const now = Date.now();
  const rivalRelic = RELICS.find((r) => r !== RELIC)!;
  const steps = state === 'relic' || state === 'finder' ? PATH.length - 1 : Math.min(PATH.length - 3, 14);
  const walked = PATH.slice(0, steps + 1);
  const [mx, my] = walked[walked.length - 1]!;
  const game: GameState = {
    id: `preview-${state}`,
    coinType: '0x2::sui::SUI',
    host: '0x' + 'b2'.repeat(32),
    status: state === 'finder' ? GameStatus.ENDED_FOUND : GameStatus.OPEN,
    dealerKind: 1,
    dealerPk: SIG,
    enclaveId: '0x' + 'c3'.repeat(32),
    dealTs: BigInt(now - 3_600_000),
    quiltId: 'preview',
    ctHash: SIG,
    entryStake: 100_000_000n,
    maxPlayers: 64,
    playerCount: 10,
    durationMs: 6 * 3_600_000,
    resolveWindowMs: 300_000,
    openAt: now - 3_600_000,
    endsAt: state === 'thaw' ? now - 60_000 : now + 2 * 3_600_000 + 17 * 60_000,
    wellFund: '0x' + 'd4'.repeat(32),
    pot: 450_000_000n,
    explorersTable: '0x0',
    finder: state === 'finder' ? PREVIEW_ADDRESS : RIVAL,
    hasPrize: true,
    relics: 3,
    potShares: [6000, 2500, 1500],
    prizesHeld: state === 'finder' ? 1 : 2,
    prizesDeposited: 3,
    // A rival already claimed rank 1 at another relic; the player races for rank 2.
    finders: state === 'finder' ? [RIVAL, PREVIEW_ADDRESS] : ['lobby', 'gated', 'checking', 'session'].includes(state) ? [] : [RIVAL],
    claimed: state === 'finder' ? [tileIndex(...rivalRelic), tileIndex(...RELIC)] : ['lobby', 'gated', 'checking', 'session'].includes(state) ? [] : [tileIndex(...rivalRelic)],
    allowlist: state === 'gated' ? '0x' + 'e5'.repeat(32) : null,
    blizzardEveryMs: 30 * 60_000,
    blizzardMs: 5 * 60_000,
    nextBlizzardAt: now + 21 * 60_000,
    drifts: state === 'blizzard' ? driftsNear(walked) : [],
    driftUntil: state === 'blizzard' ? now + 4 * 60_000 + 20_000 : 0,
    thawBlob: null,
  };
  const trail = emptyTrail();
  others(trail);
  [1, 2, 3].forEach((rank) => trail.prizeTypes.set(rank, '0x2::coin::Coin<0x2::sui::SUI>'));
  trail.prizeType = '0x2::coin::Coin<0x2::sui::SUI>';
  if (game.finders.length) {
    trail.finder = RIVAL;
    trail.finders.push({ rank: 1, finder: RIVAL, explorerId: '0xother0', pot: 270_000_000n, x: rivalRelic[0], y: rivalRelic[1] });
    trail.resolved.set(`${rivalRelic[0]},${rivalRelic[1]}`, TileKind.RELIC);
  }
  const tiles = new Map<string, Tile>();
  for (const [x, y] of walked) {
    tiles.set(`${x},${y}`, tileAt(x, y));
    trail.resolved.set(`${x},${y}`, MAP[tileIndex(x, y)]!);
  }
  const goggles = state === 'goggles';
  if (goggles)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = mx + dx;
        const y = my + dy;
        if (x >= 0 && y >= 0 && x < GRID && y < GRID) tiles.set(`${x},${y}`, tileAt(x, y));
      }
  const status =
    state === 'frozen' ? ExplorerStatus.FROZEN : state === 'finder' ? ExplorerStatus.FINDER : ExplorerStatus.ACTIVE;
  let me: ExplorerState | null = {
    id: '0xme',
    gameId: game.id,
    owner: PREVIEW_ADDRESS,
    x: mx,
    y: my,
    vision: goggles ? 1 : 0,
    visionSteps: goggles ? 7 : 0,
    ropes: 1,
    status,
    pending: null,
    lastStepMs: now - 3_000,
    visited: visitedBits(walked),
    stake: status === ExplorerStatus.FROZEN ? 0n : 100_000_000n,
    steps,
  };
  if (state === 'pending' || state === 'relic') {
    const [px, py] = state === 'relic' ? PATH[PATH.length - 1]! : PATH[steps + 1]!;
    me = { ...me, pending: { x: px, y: py, deadlineMs: now + 4 * 60_000 } };
    if (state === 'relic') tiles.set(`${px},${py}`, tileAt(px, py));
  }
  if (['login', 'lobby', 'gated', 'checking', 'session', 'spectate'].includes(state)) me = null;
  trail.explorers.set('0xme', { owner: PREVIEW_ADDRESS, x: mx, y: my, frozen: status === ExplorerStatus.FROZEN, finder: status === ExplorerStatus.FINDER, withdrawn: false, steps });
  if (state === 'finder') trail.finder = '0xme';

  const listeners = new Set<() => void>();
  const h = {
    gameId: game.id,
    address: PREVIEW_ADDRESS,
    view: {
      loading: false,
      error: null,
      game,
      trail,
      me,
      tiles,
      revealing: state === 'pending' && me?.pending ? `${me.pending.x},${me.pending.y}` : null,
      busy: false,
      chainNow: now,
      notice: state === 'goggles' ? { kind: 'item', text: 'Goggles! You can see the tiles around you for 10 steps.' } : null,
      integrity: state === 'checking' ? 'checking' : 'ok',
      integrityProgress: state === 'checking' ? 352 : 576,
      queuedResolve: null,
      sessionPrompt: state === 'session',
      gate: state === 'gated' ? 'not_member' : 'open',
      allowlistName: state === 'gated' ? 'Mystic Yeti holders' : null,
      thawMap: state === 'thaw' || state === 'finder' ? MAP : null,
    } as HuntView,
    ctx: { packageId: '0x0', coinType: game.coinType },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getView: () => h.view,
    set(patch: Partial<HuntView>) {
      h.view = { ...h.view, ...patch };
      listeners.forEach((l) => l());
    },
    start() {},
    stop() {},
    setPlayer() {},
    now: () => Date.now(),
    get live() {
      return h.view.game!.status === GameStatus.OPEN && Date.now() < h.view.game!.endsAt;
    },
    get ended() {
      return !h.live;
    },
    drifted(x: number, y: number, dir: DirectionValue) {
      const [dx, dy] = DIRECTION_DELTA[dir];
      return driftAt(h.view.game!, x + dx, y + dy, Date.now());
    },
    cooldownLeft() {
      const m = h.view.me;
      return m && m.steps ? Math.max(0, m.lastStepMs + STEP_COOLDOWN_MS - Date.now()) : 0;
    },
    checkIntegrity: async () => {},
    grantSession: () => h.set({ sessionPrompt: false }),
    declineSession: () => h.set({ sessionPrompt: false }),
    dismissNotice: () => h.set({ notice: null }),
    async join(column: number) {
      h.set({ busy: true });
      await wait(900);
      const t = tileAt(column, 0);
      h.set({
        busy: false,
        tiles: new Map([[`${column},0`, t]]),
        me: { ...(me ?? ({} as ExplorerState)), id: '0xme', owner: PREVIEW_ADDRESS, gameId: game.id, x: column, y: 0, vision: 0, visionSteps: 0, ropes: 0, status: 0, pending: null, lastStepMs: Date.now(), visited: visitedBits([[column, 0]]), stake: game.entryStake, steps: 0 },
        notice: { kind: 'info', text: 'You set out from base camp.' },
      });
    },
    async step(d: DirectionValue) {
      const m = h.view.me!;
      if (h.drifted(m.x, m.y, d)) {
        h.set({ notice: { kind: 'warn', text: 'A snowdrift blocks that way until the blizzard passes.' } });
        return;
      }
      const nx = Math.max(0, Math.min(GRID - 1, m.x + (d === 1 ? 1 : d === 3 ? -1 : 0)));
      const ny = Math.max(0, Math.min(GRID - 1, m.y + (d === 0 ? 1 : d === 2 ? -1 : 0)));
      const key = `${nx},${ny}`;
      h.set({ busy: true, me: { ...m, pending: { x: nx, y: ny, deadlineMs: Date.now() + 300_000 } }, revealing: key });
      await wait(1100);
      const t = tileAt(nx, ny);
      const tiles2 = new Map(h.view.tiles).set(key, t);
      const trail2 = { ...h.view.trail, resolved: new Map(h.view.trail.resolved).set(key, t.kind) };
      let next: ExplorerState = { ...m, x: nx, y: ny, steps: m.steps + 1, lastStepMs: Date.now(), pending: null, visionSteps: Math.max(0, m.visionSteps - 1) };
      next.vision = next.visionSteps > 0 ? 1 : 0;
      let notice: HuntView['notice'] = null;
      if (t.kind === TileKind.CREVASSE) {
        if (m.ropes > 0) {
          next.ropes -= 1;
          notice = { kind: 'item', text: 'Crevasse! Your rope carried you across.' };
        } else {
          next = { ...next, status: ExplorerStatus.FROZEN, stake: 0n };
          notice = { kind: 'freeze', text: 'Your yeti fell into a crevasse and froze.' };
        }
      } else if (t.kind === TileKind.ROPE) {
        next.ropes = Math.min(3, m.ropes + 1);
        notice = { kind: 'item', text: 'You picked up a rope.' };
      } else if (t.kind === TileKind.GOGGLES) {
        next = { ...next, vision: 1, visionSteps: 10 };
        notice = { kind: 'item', text: 'Goggles! You can see the tiles around you for 10 steps.' };
      } else if (t.kind === TileKind.RELIC) {
        next.pending = { x: nx, y: ny, deadlineMs: Date.now() + 300_000 };
        notice = { kind: 'relic', text: 'The frozen relic is here. Claim it!' };
      }
      h.set({ busy: false, revealing: null, tiles: tiles2, trail: trail2, me: next, notice });
    },
    async resolveNow() {
      const m = h.view.me!;
      if (!m.pending) return;
      h.set({ busy: true });
      await wait(900);
      h.set({
        busy: false,
        me: { ...m, pending: null, status: ExplorerStatus.FINDER },
        game: {
          ...h.view.game!,
          finders: [...h.view.game!.finders, PREVIEW_ADDRESS],
          claimed: [...h.view.game!.claimed, tileIndex(m.pending.x, m.pending.y)],
          prizesHeld: h.view.game!.prizesHeld - 1,
        },
        notice: { kind: 'relic', text: 'You found the frozen relic! The prize and the pot are yours.' },
      });
    },
    withdraw: async () => {},
    finalize: async () => {},
    freezeOverdue: async () => {},
  };
  return h as unknown as Hunt;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
