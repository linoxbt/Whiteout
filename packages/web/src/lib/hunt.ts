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
  DIRECTION_DELTA,
  blizzardDue,
  canBatchWithStep,
  driftAt,
  getAllowlist,
  onAllowlist,
  relicClaimed,
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
import { run, TxError, willSponsor } from './exec';
import { kvGet, kvSet } from './store';
import { createSession, hadSession, loadSession } from './session';
import { notify } from './notify';

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
  integrity: 'unknown' | 'checking' | 'ok' | 'failed' | 'error';
  integrityError?: string;
  integrityProgress: number;
  /** A verified resolve waiting to ride along with the next step (spec review: batching). */
  queuedResolve: Tile | null;
  /** The first reading session needs the player's consent (spec section 11, Session). */
  sessionPrompt: boolean;
  /** Phase 2: the connected address against the hunt's allowlist. */
  gate: 'open' | 'checking' | 'member' | 'not_member';
  allowlistName: string | null;
  /** The player declined the reading session; tiles stay hidden until they allow it. */
  readingDeclined: boolean;
  /** Preview builds only: a map to show as already thawed. */
  thawMap?: Uint8Array | null;
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
    gate: 'open',
    allowlistName: null,
    readingDeclined: false,
  };
  #listeners = new Set<() => void>();
  #cursor: string | null = null;
  #clockOffset = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
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
    if (this.#running) return;
    this.#running = true;
    void this.refresh();
    this.#poll();
    // A reveal queued before the player left the page still has to reach the chain.
    if (this.view.queuedResolve) this.#armHold(this.view.queuedResolve);
  }
  stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#timer = null;
    this.#holdTimer = null;
  }

  /** Polls every 4 s while the hunt is live and visible; slower when hidden or over. */
  #poll() {
    if (!this.#running) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const pending = !!this.view.me?.pending;
    const delay = hidden && !pending ? 20_000 : this.view.game && this.ended && !pending ? 15_000 : 4000;
    this.#timer = setTimeout(() => {
      void this.refresh().finally(() => this.#poll());
    }, delay);
  }

  setPlayer(address: string | null, wallet: UiWallet | null) {
    if (address === this.address) return;
    this.address = address;
    this.wallet = wallet;
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    this.#gateFor = null;
    this.#set({ me: null, tiles: new Map(), queuedResolve: null, readingDeclined: false });
    void this.refresh();
  }

  // --- Reads ------------------------------------------------------------------

  #refreshing: Promise<void> | null = null;
  #refreshAgain = false;

  /**
   * Single flight: a refresh asked for while one runs makes that one run again when
   * it ends, and both callers wait for the second pass. Reads never overlap, so
   * events are never applied twice and a slow, older read never lands last.
   */
  refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      try {
        do {
          this.#refreshAgain = false;
          await this.#refreshOnce();
        } while (this.#refreshAgain);
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async #refreshOnce() {
    const address = this.address;
    try {
      const [game, page, clock] = await Promise.all([
        getGame(suiClient, this.gameId, config.packageId),
        listGameEvents(suiClient, config.packageId, this.gameId, this.#cursor),
        readClock(),
      ]);
      this.#cursor = page.cursor;
      this.#clockOffset = clock - Date.now();
      const trail = applyEvents(this.view.trail, page.events);
      let me: ExplorerState | null = null;
      if (address) {
        const mine = [...trail.explorers.entries()].find(([, e]) => sameId(e.owner, address));
        if (mine) me = await getExplorer(suiClient, mine[0], config.packageId);
      }
      // The player switched accounts mid-read: the next pass reads for the new one.
      if (address !== this.address) return;
      const tiles = this.view.tiles.size || !me ? this.view.tiles : await this.#loadSavedTiles();
      const before = this.view.game;
      this.#set({ loading: false, error: null, game, trail: { ...trail }, me, tiles, chainNow: this.now() });
      if (me) void this.#autoReveal();
      this.#watch(before, game, me);
      void this.#checkGate(game);
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

  // --- Phase 2: gating, blizzards, alerts ---------------------------------------

  #gateFor: string | null = null;

  async #checkGate(game: GameState) {
    if (!game.allowlist) return this.view.gate !== 'open' && this.#set({ gate: 'open' });
    const key = `${game.allowlist}:${this.address}`;
    if (this.#gateFor === key) return;
    this.#gateFor = key;
    try {
      const list = await getAllowlist(suiClient, game.allowlist);
      this.#set({ allowlistName: list.name, gate: this.address ? 'checking' : 'not_member' });
      if (!this.address) return;
      this.#set({ gate: (await onAllowlist(suiClient, list, this.address)) ? 'member' : 'not_member' });
    } catch {
      this.#gateFor = null;
    }
  }

  #warned = new Set<string>();

  /** Changes since the last read: blizzards, rival finds, deadlines. */
  #watch(before: GameState | null, game: GameState, me: ExplorerState | null) {
    const now = this.now();
    if (before && game.driftUntil > before.driftUntil) {
      const mins = Math.round(game.blizzardMs / 60_000);
      this.#set({ notice: { kind: 'warn', text: `Blizzard! ${game.drifts.length} snowdrifts block the way for ${mins} min.` } });
      notify(`blizzard:${game.id}:${game.driftUntil}`, 'Blizzard on the mountain', `Snowdrifts block ${game.drifts.length} tiles for ${mins} minutes.`);
    }
    if (before && game.finders.length > before.finders.length && me && !game.finders.some((f) => sameId(f, me.owner))) {
      const left = game.relics - game.finders.length;
      const text = left > 0 ? `A rival claimed a relic. ${left} still frozen out there.` : 'The last relic was claimed.';
      this.#set({ notice: { kind: 'relic', text } });
      notify(`claim:${game.id}:${game.finders.length}`, 'A relic was claimed', text);
    }
    if (me?.pending && me.status === ExplorerStatus.ACTIVE) {
      const left = me.pending.deadlineMs - now;
      if (left < 60_000 && left > 0) {
        const key = `deadline:${me.id}:${me.pending.deadlineMs}`;
        const shown = notify(key, 'Reveal your tile', 'Under a minute left to reveal your tile, or your yeti freezes.');
        if (!shown && !this.#warned.has(key) && document.visibilityState === 'visible') {
          this.#warned.add(key);
          this.#set({ notice: { kind: 'warn', text: 'Under a minute left to reveal this tile, or your yeti freezes.' } });
        }
      }
    }
    if (me && isLive(game, now) && game.endsAt - now < 10 * 60_000) {
      notify(`ending:${game.id}`, 'The hunt is ending', 'Less than 10 minutes until the mountain thaws.');
    }
  }

  /**
   * Anyone may start a due blizzard. Players are never asked to sign one behind their
   * back: the host console, the CLI watcher, or a player's own tap starts it.
   */
  async startBlizzard() {
    const g = this.view.game;
    if (!g || !blizzardDue(g, this.now())) return;
    await this.#act(async () => {
      await run(tx.blizzard(this.ctx, { gameId: this.gameId }), this.wallet, this.address!);
      await this.refresh();
    });
  }

  /** Whether stepping `dir` from (x, y) would walk into a drift right now. */
  drifted(x: number, y: number, dir: DirectionValue): boolean {
    const g = this.view.game;
    if (!g) return false;
    const [dx, dy] = DIRECTION_DELTA[dir];
    return driftAt(g, x + dx, y + dy, this.now());
  }

  // --- Integrity (R23, AC22) --------------------------------------------------

  async checkIntegrity(): Promise<boolean> {
    const game = this.view.game;
    if (!game) return false;
    this.#set({ integrity: 'checking', integrityProgress: 0 });
    try {
      const cts = await readAllTiles(config.walrusAggregators, game.quiltId, (n) => this.#set({ integrityProgress: n }));
      const servers = new Set(config.sealServers.map((s) => s.objectId.toLowerCase()));
      const info = ciphertextServers(cts[0]!);
      const named = info.ids.map((s) => s.toLowerCase());
      // Tiles sealed for another package could never be read here: refuse to join.
      const ok = checkCiphertexts(cts, game.ctHash) && named.every((s) => servers.has(s)) && sameId(info.packageId, config.packageId);
      if (ok) cts.forEach((ct, i) => this.#cts.set(`${i % 24},${Math.floor(i / 24)}`, ct));
      this.#set({ integrity: ok ? 'ok' : 'failed' });
      return ok;
    } catch (e) {
      this.#set({ integrity: 'error', integrityError: (e as Error).message });
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
      if (game.allowlist && this.view.gate === 'not_member') {
        throw new TxError(`This hunt is for members of "${this.view.allowlistName ?? 'its allowlist'}" only.`, null);
      }
      await run(
        tx.join(this.ctx, { gameId: this.gameId, stake: game.entryStake, column, allowlistId: game.allowlist, sponsored: willSponsor(this.wallet) }),
        this.wallet,
        this.address!,
      );
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
    // Single flight: joining and the first reveal both ask at once. A second prompt
    // would replace the first one's consent callback and leave that caller (and the
    // reveal lock it holds) waiting forever, stuck in the fog.
    this.#pendingSession ??= (async () => {
      try {
        if (!(await hadSession(address))) {
          this.#set({ sessionPrompt: true });
          await new Promise<void>((resolve, reject) => (this.#consent = { resolve, reject }));
        }
        return await createSession(address);
      } finally {
        this.#pendingSession = null;
      }
    })();
    return this.#pendingSession;
  }

  #pendingSession: Promise<SessionKey> | null = null;

  /** The player tapped "Allow" on the session prompt. */
  grantSession() {
    this.#set({ sessionPrompt: false });
    this.#consent?.resolve();
    this.#consent = null;
  }

  declineSession() {
    this.#set({ sessionPrompt: false, readingDeclined: true });
    this.#consent?.reject(new Error('Reading session declined'));
    this.#consent = null;
  }

  /** The player changed their mind: ask for the reading session again. */
  allowReading() {
    this.#set({ readingDeclined: false });
    void this.#autoReveal();
  }

  async step(dir: DirectionValue) {
    const me = this.view.me;
    if (!me || this.view.busy) return;
    if (this.drifted(me.x, me.y, dir)) {
      this.#set({ notice: { kind: 'warn', text: 'A snowdrift blocks that way until the blizzard passes.' } });
      return;
    }
    await this.#act(async () => {
      const t = new Transaction();
      const q = this.view.queuedResolve;
      if (q && me.pending && q.x === me.pending.x && q.y === me.pending.y) {
        this.#resolveInto(t, q, me);
      } else if (me.pending) {
        throw new TxError('Reveal the tile you are on first.', null);
      }
      tx.step(this.ctx, { gameId: this.gameId, explorerId: me.id, dir }, t);
      // The queued resolve rides with this step; the hold timer must not send it too.
      if (this.#holdTimer) clearTimeout(this.#holdTimer);
      this.#holdTimer = null;
      try {
        await run(t, this.wallet, this.address!);
      } catch (e) {
        if (this.view.queuedResolve) this.#armHold(this.view.queuedResolve);
        throw e;
      }
      this.#set({ queuedResolve: null });
      await this.refresh();
    });
  }

  /** Sends a verified resolve on its own (the hold timer, or the relic claim). */
  async resolveNow() {
    const me = this.view.me;
    const tile = this.view.queuedResolve ?? (me?.pending ? this.view.tiles.get(`${me.pending.x},${me.pending.y}`) : undefined);
    if (!me?.pending || !tile || tile.x !== me.pending.x || tile.y !== me.pending.y) return;
    if (this.view.busy) {
      // Another action is on its way; try again when it lands (it may carry this resolve).
      setTimeout(() => void this.resolveNow(), 750);
      return;
    }
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    await this.#act(async () => {
      const t = new Transaction();
      this.#resolveInto(t, tile, me);
      await run(t, this.wallet, this.address!);
      this.#set({ queuedResolve: null });
      await this.refresh();
      this.#afterResolve(tile);
      const g = this.view.game;
      if (tile.kind === TileKind.RELIC && this.view.me?.status === ExplorerStatus.FINDER && g) {
        const rank = g.finders.findIndex((f) => sameId(f, me.owner));
        const text = g.relics > 1 ? `You claimed the ${['1st', '2nd', '3rd'][Math.max(0, rank)]} prize, your share of the pot and your stake.` : 'You claimed the relic: the prize and the pot are yours.';
        this.#set({ notice: { kind: 'relic', text } });
      }
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
    if (!me || !game || this.#revealing || me.status !== ExplorerStatus.ACTIVE || this.view.readingDeclined) return;
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
        if (!r.kindOk) {
          this.#set({ notice: { kind: 'error', text: `Tile (${r.tile.x}, ${r.tile.y}) failed verification and is hidden.` } });
          continue;
        }
        if (!r.clueOk) {
          // The kind is signed, so the tile can still be resolved; its clue is not shown.
          this.#set({ notice: { kind: 'warn', text: `The clue on tile (${r.tile.x}, ${r.tile.y}) failed verification and is hidden.` } });
          tiles.set(`${r.tile.x},${r.tile.y}`, { ...r.tile, clueOk: false });
          continue;
        }
        tiles.set(`${r.tile.x},${r.tile.y}`, r.tile);
      }
      this.#set({ tiles, revealing: null });
      void beacon(this.gameId, 'reveal_ok');
      void kvSet(`tiles:${this.gameId}:${this.address}`, [...tiles.values()]);
      this.#maybeQueueResolve();
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (msg === 'Reading session declined' || /reject|denied|declin|cancel/i.test(msg)) {
        // Do not nag: wait until the player taps "Allow reading" again.
        this.#set({
          revealing: null,
          readingDeclined: true,
          notice: { kind: 'warn', text: 'Your tiles stay in the fog until you allow this device to read them.' },
        });
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
    const claimed = !!this.view.game && relicClaimed(this.view.game, tile.x, tile.y);
    if (tile.kind === TileKind.RELIC && live && !claimed) {
      // Keep a failed claim's error on screen: the Claim button stays for a retry.
      if (this.view.notice?.kind !== 'error') this.#set({ notice: { kind: 'relic', text: 'You found a frozen relic!' } });
      return; // the player taps Claim
    }
    if (tile.kind === TileKind.RELIC && claimed) {
      this.#set({ notice: { kind: 'info', text: 'A relic was here, but someone already claimed it.' } });
    }
    if (!canBatchWithStep(tile.kind, me.ropes, live, claimed)) {
      void this.resolveNow();
      return;
    }
    this.#set({ queuedResolve: tile });
    this.#afterResolve(tile, true);
    this.#armHold(tile);
  }

  /**
   * Sends the queued resolve on its own if no step carries it first. The wait is
   * counted from the on-chain deadline, never from when the reveal finished, and
   * keeps a safety margin for the transaction itself.
   */
  #armHold(tile: Tile) {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    const me = this.view.me;
    if (!me?.pending) return;
    const margin = 20_000;
    const byDeadline = me.pending.deadlineMs - this.now() - margin;
    const hold = Math.max(0, Math.min(60_000, (this.view.game?.resolveWindowMs ?? 300_000) / 2, byDeadline));
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      if (this.view.queuedResolve === tile) void this.resolveNow();
    }, hold);
  }

  /** Milliseconds until the queued resolve is sent on its own (for the UI). */
  holdLeft(): number | null {
    const me = this.view.me;
    if (!this.view.queuedResolve || !me?.pending) return null;
    return Math.max(0, me.pending.deadlineMs - 20_000 - this.now());
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
        // The claim takes the next rank's prize.
        prizeType: this.view.trail.prizeTypes.get((this.view.game?.finders.length ?? 0) + 1) ?? this.view.trail.prizeType,
        relicClaimed: !!this.view.game && relicClaimed(this.view.game, tile.x, tile.y),
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

  /** One chain action at a time: a second one while busy is ignored (callers retry). */
  async #act(fn: () => Promise<void>) {
    if (this.view.busy) return;
    this.#set({ busy: true });
    try {
      await fn();
    } catch (e) {
      const err = e as TxError;
      if (err.status === 401) {
        this.#set({ notice: { kind: 'auth', text: 'Your Google session expired. Log in again: your yeti and its countdown are safe on-chain.' } });
      } else {
        const text =
          err.status === 429 ? 'You have used today\'s free moves (600 a day). Connect a Sui wallet to keep playing.' :
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

