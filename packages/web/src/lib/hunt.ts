/**
 * One hunt as the browser sees it: chain state (the only truth), the public trail,
 * the player's decrypted tiles (local only), and every player action.
 */
import type { UiWallet } from '@mysten/dapp-kit-react';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import {
  ExplorerStatus,
  GameStatus,
  STEP_COOLDOWN_MS,
  type SessionKey,
  TileKind,
  applyEvents,
  canBatchWithStep,
  checkCiphertexts,
  ciphertextServers,
  decryptTiles,
  emptyTrail,
  getExplorer,
  getGame,
  isEnded,
  isLive,
  listGameEvents,
  makeSealClient,
  readAllTiles,
  readTile,
  sameId,
  tileIndex,
  tx,
  visibleTiles,
  type DirectionValue,
  type ExplorerState,
  type GameState,
  type Tile,
  type Trail,
} from '@whiteout/core';
import { config, suiClient } from '../config';
import { dAppKit } from '../dappkit';
import { run, TxError } from './exec';
import { kvGet, kvSet } from './store';
import { createSession, hadSession, loadSession } from './session';

export interface Notice {
  kind: 'info' | 'warn' | 'error' | 'item' | 'freeze' | 'relic' | 'auth';
  text: string;
}

export interface HuntView {
  loading: boolean;
  error: string | null;
  game: GameState | null;
  trail: Trail;
  me: ExplorerState | null;
  /** Tiles this browser has decrypted and verified, by "x,y". */
  tiles: Map<string, Tile>;
  /** Tile being revealed, or null. */
  revealing: string | null;
  busy: boolean;
  chainNow: number;
  notice: Notice | null;
  integrity: 'unknown' | 'checking' | 'ok' | 'failed';
  integrityProgress: number;
  /** A verified resolve waiting to ride along with the next step (spec review: batching). */
  queuedResolve: Tile | null;
  /** The first reading session needs the player's consent (spec section 11, Session). */
  sessionPrompt: boolean;
}

const seal = makeSealClient(suiClient, config);

export class Hunt {
  view: HuntView = {
    loading: true,
    error: null,
    game: null,
    trail: emptyTrail(),
    me: null,
    tiles: new Map(),
    revealing: null,
    busy: false,
    chainNow: Date.now(),
    notice: null,
    integrity: 'unknown',
    integrityProgress: 0,
    queuedResolve: null,
    sessionPrompt: false,
  };
  #listeners = new Set<() => void>();
  #cursor: string | null = null;
  #clockOffset = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #holdTimer: ReturnType<typeof setTimeout> | null = null;
  #cts = new Map<string, Uint8Array>();
  address: string | null = null;
  wallet: UiWallet | null = null;

  constructor(readonly gameId: string) {}

  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
  getView = () => this.view;
  #set(patch: Partial<HuntView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.#listeners) l();
  }

  get ctx(): tx.Ctx {
    return { packageId: config.packageId, coinType: this.view.game?.coinType ?? '0x2::sui::SUI' };
  }

  start() {
    void this.refresh();
    this.#timer ??= setInterval(() => void this.refresh(), 4000);
  }
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#timer = null;
  }

  setPlayer(address: string | null, wallet: UiWallet | null) {
    if (address === this.address) return;
    this.address = address;
    this.wallet = wallet;
    this.#set({ me: null, tiles: new Map() });
    void this.refresh();
  }

  // --- Reads ------------------------------------------------------------------

  async refresh() {
    try {
      const [game, page, clock] = await Promise.all([
        getGame(suiClient, this.gameId),
        listGameEvents(suiClient, config.packageId, this.gameId, this.#cursor),
        readClock(),
      ]);
      this.#cursor = page.cursor;
      this.#clockOffset = clock - Date.now();
      const trail = applyEvents(this.view.trail, page.events);
      let me: ExplorerState | null = null;
      if (this.address) {
        const mine = [...trail.explorers.entries()].find(([, e]) => sameId(e.owner, this.address!));
        if (mine) me = await getExplorer(suiClient, mine[0]);
      }
      const tiles = this.view.tiles.size || !me ? this.view.tiles : await this.#loadSavedTiles();
      this.#set({ loading: false, error: null, game, trail: { ...trail }, me, tiles, chainNow: this.now() });
      if (me) void this.#autoReveal();
    } catch (e) {
      this.#set({ loading: false, error: navigator.onLine === false ? 'You are offline.' : (e as Error).message });
    }
  }

  /** Chain time from the latest Clock reading (F20). */
  now() {
    return Date.now() + this.#clockOffset;
  }

  get live() {
    return !!this.view.game && isLive(this.view.game, this.now());
  }
  get ended() {
    return !!this.view.game && isEnded(this.view.game, this.now());
  }

  cooldownLeft(): number {
    const me = this.view.me;
    if (!me || me.steps === 0) return 0;
    return Math.max(0, me.lastStepMs + STEP_COOLDOWN_MS - this.now());
  }

  // --- Integrity (R23, AC22) --------------------------------------------------

  async checkIntegrity(): Promise<boolean> {
    const game = this.view.game;
    if (!game) return false;
    this.#set({ integrity: 'checking', integrityProgress: 0 });
    try {
      const cts = await readAllTiles(config.walrusAggregators, game.quiltId, (n) => this.#set({ integrityProgress: n }));
      const servers = new Set(config.sealServers.map((s) => s.objectId.toLowerCase()));
      const named = ciphertextServers(cts[0]!).ids.map((s) => s.toLowerCase());
      const ok = checkCiphertexts(cts, game.ctHash) && named.every((s) => servers.has(s));
      if (ok) cts.forEach((ct, i) => this.#cts.set(`${i % 24},${Math.floor(i / 24)}`, ct));
      this.#set({ integrity: ok ? 'ok' : 'failed' });
      return ok;
    } catch (e) {
      this.#set({ integrity: 'unknown', error: `Could not download the hunt: ${(e as Error).message}` });
      return false;
    }
  }

  // --- Player actions ---------------------------------------------------------

  async join(column: number) {
    const game = this.view.game!;
    await this.#act(async () => {
      if (this.view.integrity !== 'ok' && !(await this.checkIntegrity())) {
        throw new TxError('This hunt failed its integrity check.', null);
      }
      await run(tx.join(this.ctx, { gameId: this.gameId, stake: game.entryStake, column }), this.wallet, this.address!);
      await this.refresh();
      await this.ensureSession();
      await this.#autoReveal();
    });
  }

  #consent: { resolve: () => void; reject: (e: Error) => void } | null = null;

  /**
   * One signature starts a 30-minute reading session. The first time, the player sees
   * why before the wallet asks; after an expiry the re-prompt is silent (spec section 11).
   */
  async ensureSession(): Promise<SessionKey> {
    const address = this.address!;
    const cached = await loadSession(address);
    if (cached) return cached;
    if (!(await hadSession(address))) {
      this.#set({ sessionPrompt: true });
      await new Promise<void>((resolve, reject) => (this.#consent = { resolve, reject }));
    }
    return createSession(address);
  }

  /** The player tapped "Allow" on the session prompt. */
  grantSession() {
    this.#set({ sessionPrompt: false });
    this.#consent?.resolve();
    this.#consent = null;
  }

  declineSession() {
    this.#set({ sessionPrompt: false });
    this.#consent?.reject(new Error('Reading session declined'));
    this.#consent = null;
  }

  async step(dir: DirectionValue) {
    const me = this.view.me;
    if (!me || this.view.busy) return;
    await this.#act(async () => {
      const t = new Transaction();
      const q = this.view.queuedResolve;
      if (q && me.pending && q.x === me.pending.x && q.y === me.pending.y) {
        this.#resolveInto(t, q, me);
      } else if (me.pending) {
        throw new TxError('Reveal the tile you are on first.', null);
      }
      tx.step(this.ctx, { gameId: this.gameId, explorerId: me.id, dir }, t);
      await run(t, this.wallet, this.address!);
      this.#set({ queuedResolve: null });
      await this.refresh();
    });
  }

  /** Sends a verified resolve on its own (the hold timer, or the relic claim). */
  async resolveNow() {
    const me = this.view.me;
    const tile = this.view.queuedResolve ?? (me?.pending ? this.view.tiles.get(`${me.pending.x},${me.pending.y}`) : undefined);
    if (!me?.pending || !tile) return;
    await this.#act(async () => {
      const t = new Transaction();
      this.#resolveInto(t, tile, me);
      await run(t, this.wallet, this.address!);
      this.#set({ queuedResolve: null });
      await this.refresh();
      this.#afterResolve(tile);
    });
  }

  async withdraw() {
    const me = this.view.me!;
    await this.#act(async () => {
      await run(tx.withdrawStake(this.ctx, { gameId: this.gameId, explorerId: me.id }), this.wallet, this.address!);
      await this.refresh();
      this.#set({ notice: { kind: 'info', text: 'Your stake is back in your wallet.' } });
    });
  }

  async freezeOverdue(explorerId: string) {
    await this.#act(async () => {
      await run(tx.freezeOverdue(this.ctx, { gameId: this.gameId, explorerId }), this.wallet, this.address!);
      await this.refresh();
    });
  }

  async finalize() {
    await this.#act(async () => {
      await run(tx.finalizeUnclaimed(this.ctx, { gameId: this.gameId }), this.wallet, this.address!);
      await this.refresh();
    });
  }

  dismissNotice() {
    this.#set({ notice: null });
  }

  // --- Reveal -----------------------------------------------------------------

  #revealing = false;

  /** Decrypts whatever the player may now see and has not decrypted yet. */
  async #autoReveal() {
    const me = this.view.me;
    const game = this.view.game;
    if (!me || !game || this.#revealing || me.status !== ExplorerStatus.ACTIVE) return;
    const want = visibleTiles(me.x, me.y, me.vision).filter(([x, y]) => !this.view.tiles.has(`${x},${y}`));
    if (!want.length) {
      this.#maybeQueueResolve();
      return;
    }
    this.#revealing = true;
    const pendingKey = me.pending ? `${me.pending.x},${me.pending.y}` : null;
    this.#set({ revealing: pendingKey });
    try {
      const sessionKey = await this.ensureSession();
      const cts = await Promise.all(want.map(async ([x, y]) => ({ x, y, ct: await this.#ciphertext(x, y) })));
      const res = await decryptTiles({
        seal, suiClient, ctx: this.ctx, gameId: this.gameId, explorerId: me.id,
        dealerPk: game.dealerPk, dealTs: game.dealTs, threshold: config.sealThreshold, sessionKey, tiles: cts,
      });
      const tiles = new Map(this.view.tiles);
      for (const r of res) {
        if (!r.verified) {
          this.#set({ notice: { kind: 'error', text: `Tile (${r.tile.x}, ${r.tile.y}) failed verification and is hidden.` } });
          continue;
        }
        tiles.set(`${r.tile.x},${r.tile.y}`, r.tile);
      }
      this.#set({ tiles, revealing: null });
      void beacon(this.gameId, 'reveal_ok');
      void kvSet(`tiles:${this.gameId}:${this.address}`, [...tiles.values()]);
      this.#maybeQueueResolve();
    } catch (e) {
      if ((e as Error).message === 'Reading session declined') {
        this.#set({ revealing: null, notice: { kind: 'warn', text: 'Your tiles stay in the fog until you allow this device to read them.' } });
        return;
      }
      void beacon(this.gameId, 'key_fetch_error');
      this.#set({ revealing: null, notice: { kind: 'warn', text: 'The fog is thick. Retrying the reveal...' } });
      setTimeout(() => void this.#autoReveal(), 3000);
      console.warn('reveal failed', e);
    } finally {
      this.#revealing = false;
    }
  }

  async #ciphertext(x: number, y: number): Promise<Uint8Array> {
    const key = `${x},${y}`;
    const hit = this.#cts.get(key) ?? (await kvGet<Uint8Array>(`ct:${this.view.game!.quiltId}:${key}`));
    if (hit) return hit;
    const ct = await readTile(config.walrusAggregators, this.view.game!.quiltId, x, y);
    this.#cts.set(key, ct);
    void kvSet(`ct:${this.view.game!.quiltId}:${key}`, ct);
    return ct;
  }

  async #loadSavedTiles(): Promise<Map<string, Tile>> {
    const saved = await kvGet<Tile[]>(`tiles:${this.gameId}:${this.address}`);
    return new Map((saved ?? []).map((t) => [`${t.x},${t.y}`, t]));
  }

  /**
   * After the pending tile is revealed: a fatal crevasse or a live relic is handled
   * at once; anything else waits to ride with the next step, but never longer than
   * half the resolve window (or 60 s), so the player cannot be frozen by waiting.
   */
  #maybeQueueResolve() {
    const me = this.view.me;
    if (!me?.pending || this.view.busy) return;
    const tile = this.view.tiles.get(`${me.pending.x},${me.pending.y}`);
    if (!tile || this.view.queuedResolve) return;
    const live = this.live;
    if (tile.kind === TileKind.RELIC && live) {
      this.#set({ notice: { kind: 'relic', text: 'You found the frozen relic!' } });
      return; // the player taps Claim
    }
    if (!canBatchWithStep(tile.kind, me.ropes, live)) {
      void this.resolveNow();
      return;
    }
    this.#set({ queuedResolve: tile });
    this.#afterResolve(tile, true);
    const hold = Math.min(60_000, (this.view.game?.resolveWindowMs ?? 300_000) / 2);
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = setTimeout(() => {
      if (this.view.queuedResolve === tile) void this.resolveNow();
    }, hold);
  }

  #resolveInto(t: Transaction, tile: Tile, me: ExplorerState) {
    tx.resolveTile(
      this.ctx,
      {
        gameId: this.gameId,
        explorerId: me.id,
        kind: tile.kind,
        kindSig: tile.kindSig,
        ropes: me.ropes,
        huntLive: this.live,
        prizeType: this.view.trail.prizeType,
      },
      t,
    );
  }

  #afterResolve(tile: Tile, early = false) {
    if (tile.kind === TileKind.GOGGLES) this.#set({ notice: { kind: 'item', text: 'Goggles! You can see one tile further for 10 steps.' } });
    else if (tile.kind === TileKind.ROPE) this.#set({ notice: { kind: 'item', text: 'A rope. It will carry you over one crevasse.' } });
    else if (tile.kind === TileKind.CREVASSE && !early) {
      const me = this.view.me;
      if (me?.status === ExplorerStatus.FROZEN) this.#set({ notice: { kind: 'freeze', text: 'A crevasse. Your yeti is frozen.' } });
    } else if (tile.kind === TileKind.CREVASSE) this.#set({ notice: { kind: 'item', text: 'A crevasse! Your rope holds.' } });
  }

  async #act(fn: () => Promise<void>) {
    this.#set({ busy: true });
    try {
      await fn();
    } catch (e) {
      const err = e as TxError;
      if (err.status === 401) {
        this.#set({ notice: { kind: 'auth', text: 'Your Google session expired. Log in again: your yeti and its countdown are safe on-chain.' } });
      } else {
        const text =
          err.status === 429 ? 'You have used this hunt\'s free moves. Connect a Sui wallet to keep playing.' :
          err.abort?.action === 'thaw' ? 'The hunt is over.' :
          err.message;
        this.#set({ notice: { kind: 'error', text } });
      }
      await this.refresh();
    } finally {
      this.#set({ busy: false });
    }
  }
}

const ClockBcs = bcs.struct('Clock', { id: bcs.Address, timestamp_ms: bcs.u64() });

async function readClock(): Promise<number> {
  const { object } = await suiClient.core.getObject({ objectId: '0x6', include: { content: true } });
  return Number(ClockBcs.parse(object.content).timestamp_ms);
}

/** Anonymous counters for monitoring (spec section 7): no address, only the hunt and the event. */
async function beacon(gameId: string, event: 'key_fetch_error' | 'reveal_ok') {
  if (!config.sponsorUrl) return;
  try {
    await fetch(`${config.sponsorUrl}/beacon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId, event }),
      keepalive: true,
    });
  } catch {
    /* monitoring must never break play */
  }
}

const hunts = new Map<string, Hunt>();
export function huntFor(gameId: string): Hunt {
  let h = hunts.get(gameId);
  if (!h) hunts.set(gameId, (h = new Hunt(gameId)));
  return h;
}

export { GameStatus, ExplorerStatus, tileIndex };
