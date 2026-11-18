import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Direction,
  ExplorerStatus,
  GameStatus,
  GRID,
  TileKind,
  sameId,
  type DirectionValue,
} from '@whiteout/core';
import { Backdrop, Clouds } from '../components/Backdrop';
import { Legend, Mountain } from '../components/Mountain';
import { GateNotice, HuntTags, NotifyToggle, PrizeLadder, Weather } from '../components/Phase2';
import { Mark } from '../components/Logo';
import { WalletHelp } from '../components/WalletHelp';
import type { Hunt as HuntModel, HuntView } from '../lib/hunt';
import { amount, dealerBadge, kindName, shortId, statusLabel, timeLeft, warmthWord } from '../lib/format';
import { useHunt, useTick } from '../lib/useHunt';
import { makePreview, PREVIEW_ADDRESS } from '../lib/preview';
import { Thaw } from './Thaw';

/** Design preview (#/hunt/preview-<state>): compiled in only when VITE_PREVIEW=1. */
const PREVIEW = import.meta.env.VITE_PREVIEW === '1';

export function Hunt({ gameId, mode }: { gameId: string; mode?: string }) {
  if (PREVIEW && gameId.startsWith('preview-')) return <PreviewHunt gameId={gameId} mode={mode} />;
  return <LiveHunt gameId={gameId} mode={mode} />;
}

function PreviewHunt({ gameId, mode }: { gameId: string; mode?: string }) {
  const state = gameId.slice('preview-'.length);
  const [hunt] = useState(() => makePreview(state));
  const v = useSyncExternalStore(hunt.subscribe, hunt.getView);
  return <HuntScreen hunt={hunt} v={v} gameId={gameId} mode={state === 'spectate' ? 'spectate' : mode} account={state === 'login' ? null : { address: PREVIEW_ADDRESS }} />;
}

function LiveHunt({ gameId, mode }: { gameId: string; mode?: string }) {
  const [hunt, v] = useHunt(gameId);
  const account = useCurrentAccount();
  return <HuntScreen hunt={hunt} v={v} gameId={gameId} mode={mode} account={account} />;
}

function HuntScreen({ hunt, v, gameId, mode, account }: { hunt: HuntModel; v: HuntView; gameId: string; mode?: string; account: { address: string } | null }) {
  useTick(1000);

  if (v.loading) return <div className="skeleton-grid" aria-busy="true" />;
  if (!v.game) return <div className="banner error">Hunt not found. {v.error}</div>;

  const g = v.game;
  const now = hunt.now();
  const badge = dealerBadge(g.dealerKind);
  const isLive = g.status === GameStatus.OPEN && now < g.endsAt;
  const header = (
    <div className="hunt-head">
      <div className="crumbs">
        <a href="#/">← All expeditions</a>
        <span className="row" style={{ gap: 8 }}>
          <HuntTags g={g} />
          <span className={`badge ${badge.tone}`}>{badge.text}</span>
          <a className="pill" href={`#/hunt/${gameId}/verify`}>Verify ↗</a>
          {mode !== 'spectate' && <a className="pill" href={`#/hunt/${gameId}/spectate`}>Spectate</a>}
        </span>
      </div>
      <div className="hunt-banner">
        <Backdrop seed={seedOf(gameId)} yeti={false} align="xMidYMid" />
        <Clouds seed={seedOf(gameId)} count={5} fog={false} top={[0, 40]} />
        <div className="hunt-title">
          <div>
            <span className="tele ice">{g.dealerKind === 1 ? 'Sealed by enclave' : 'Host-dealt'} / Grid 24 × 24</span>
            <h1>Expedition <span className="thin">{shortId(gameId, 4)}</span></h1>
          </div>
          {isLive && (
            <span className="countdown">
              <span className="tele">Thaws in</span>
              <strong>{timeLeft(g.endsAt - now)}</strong>
            </span>
          )}
        </div>
      </div>
      <div className="strip">
        <div>
          <div className="stat-label">Status</div>
          <div className="stat-value" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`dot ${isLive ? 'live' : ''}`} />
            {statusLabel(g, now)}
          </div>
        </div>
        <div>
          <div className="stat-label">Entry</div>
          <div className="stat-value">{g.entryStake === 0n ? 'Free' : amount(g.entryStake, g.coinType)}</div>
        </div>
        <div>
          <div className="stat-label">Pot</div>
          <div className="stat-value">{amount(g.pot, g.coinType)}</div>
        </div>
        <div>
          <div className="stat-label">Yetis</div>
          <div className="stat-value">
            {g.playerCount}/{g.maxPlayers}
          </div>
        </div>
      </div>
      {v.error && <div className="banner error" role="alert">Network trouble: retrying. Actions are paused.</div>}
      {g.dealerKind === 2 && (
        <div className="banner warn">This hunt was dealt by its host, who could know the map. It is free to enter.</div>
      )}
    </div>
  );

  if (g.status === GameStatus.CANCELLED) return <>{header}<p className="empty">This hunt was cancelled.</p></>;
  if (g.status === GameStatus.LOBBY) return <>{header}<p className="empty">This hunt opens soon. The prize is in escrow.</p></>;
  if (mode === 'spectate') return <>{header}<Spectate v={v} /></>;
  if (hunt.ended && !v.me?.pending) return <>{header}<Thaw hunt={hunt} v={v} /></>;
  if (!account) return <>{header}<Login v={v} /></>;
  const prompt = v.sessionPrompt && <SessionPrompt hunt={hunt} />;
  if (!v.me) return <>{header}{prompt}<Lobby hunt={hunt} v={v} /></>;
  return <>{header}{prompt}<Play hunt={hunt} v={v} /></>;
}

/** Spec section 11, Session: one signature, explained before the wallet asks. */
function SessionPrompt({ hunt }: { hunt: HuntModel }) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="session-title">
      <div className="card">
        <div className="modal-icon"><Mark size={34} /></div>
        <h2 id="session-title">Let this device read your tiles</h2>
        <p className="small" style={{ fontSize: '1rem' }}>
          Your wallet will ask for one signature, good for 30 minutes. It cannot move funds: it only lets this browser read the
          ground under your yeti.
        </p>
        <div className="actions">
          <button className="primary" onClick={() => hunt.grantSession()}>Allow</button>
          <button onClick={() => hunt.declineSession()}>Not now</button>
        </div>
      </div>
    </div>
  );
}

function AuthNotice({ text }: { text: string }) {
  const dAppKit = useDAppKit();
  return (
    <div className="banner error" role="alert">
      {text}
      <button onClick={() => void dAppKit.disconnectWallet()}>Log in again</button>
    </div>
  );
}

function Login({ v }: { v: HuntView }) {
  return (
    <div className="lobby-grid">
      <section className="card">
        <span className="eyebrow">Join the hunt</span>
        <h2 style={{ marginTop: 10 }}>Step onto the mountain</h2>
        <p className="small" style={{ lineHeight: 1.6 }}>
          Play with Google, no crypto needed, gas is on us. Or connect any Sui wallet.
        </p>
        <div className="actions">
          <ConnectButton />
          <a className="btn" href={`#/hunt/${v.game!.id}/spectate`}>Just watch</a>
        </div>
        <WalletHelp />
        <ul className="facts">
          <li><span className="k">Entry</span><span>{v.game!.entryStake === 0n ? 'Free' : amount(v.game!.entryStake, v.game!.coinType)}</span></li>
          <li><span className="k">Pot so far</span><span>{amount(v.game!.pot, v.game!.coinType)}</span></li>
          <li><span className="k">On the mountain</span><span>{v.trail.explorers.size} yetis</span></li>
          <li><span className="k">Step cooldown</span><span>8 seconds</span></li>
        </ul>
      </section>
      <MiniTrail v={v} />
    </div>
  );
}

function MiniTrail({ v }: { v: HuntView }) {
  return (
    <section className="card" style={{ padding: 14 }}>
      <Mountain trail={v.trail} me={null} address={null} tiles={new Map()} revealing={null} label="Public trail of the hunt" />
      <p className="small center" style={{ margin: '8px 0 0' }}>
        {v.trail.explorers.size} yetis · {v.trail.resolved.size} tiles walked
      </p>
    </section>
  );
}

function Lobby({ hunt, v }: { hunt: HuntModel; v: HuntView }) {
  const g = v.game!;
  const [column, setColumn] = useState(12);
  useEffect(() => {
    if (v.integrity === 'unknown') void hunt.checkIntegrity();
  }, [hunt, v.integrity]);
  if (!hunt.live) return <p className="empty">Joining is closed.</p>;
  const pct = Math.round((v.integrityProgress / 576) * 100);
  return (
    <div className="lobby-grid">
      <section className="card">
        <span className="eyebrow">How to play</span>
        <h2 style={{ marginTop: 10 }}>Find the frozen relic</h2>
        <ol className="rules">
          <li>Your yeti starts at base camp, at the bottom of the mountain.</li>
          <li>Each step reveals only the tile you land on. Warmth tells you how close the relic is: 5 means within 2 tiles.</li>
          <li>The red number counts crevasses next to you. Step on one without a rope and your yeti freezes.</li>
          <li>Goggles let you see one tile further for 10 steps. A rope carries you over one crevasse.</li>
          {g.relics > 1 ? (
            <li>{g.relics} relics are hidden. Finders rank in the order they claim: each takes the next prize and a share of the pot.</li>
          ) : (
            <li>First to reach the relic wins the prize and the whole pot.</li>
          )}
          {g.blizzardEveryMs > 0 && (
            <li>Every {Math.round(g.blizzardEveryMs / 60_000)} minutes a blizzard drops snowdrifts that block tiles for {Math.round(g.blizzardMs / 60_000)} minutes. Nobody is moved.</li>
          )}
        </ol>
      </section>
      <section className="card">
        <span className="eyebrow">Your entry</span>
        <div className="kv" style={{ borderTop: 0, paddingTop: 0, marginTop: 12 }}>
          <div>
            <span className="k">Stake</span>
            <span className="v">{g.entryStake === 0n ? 'Free' : amount(g.entryStake, g.coinType)}</span>
          </div>
          <div>
            <span className="k">If you freeze</span>
            <span className="v">½ wells · ½ pot</span>
          </div>
        </div>
        <label className="column-picker">
          <span className="row">
            <span className="small">Base camp column</span>
            <span className="mono" style={{ fontSize: '1rem' }}>{String(column + 1).padStart(2, '0')}</span>
          </span>
          <div className="camp-strip" aria-hidden="true">
            {Array.from({ length: GRID }, (_, i) => (
              <i key={i} className={i === column ? 'on' : ''} onClick={() => setColumn(i)} />
            ))}
          </div>
          <input type="range" min={0} max={GRID - 1} value={column} onChange={(e) => setColumn(Number(e.target.value))} aria-label="Base camp column" />
        </label>
        {v.integrity === 'checking' && (
          <>
            <p className="small" style={{ margin: 0 }}>Checking the hunt's integrity… {v.integrityProgress}/576</p>
            <div className="progress"><i style={{ width: `${pct}%` }} /></div>
          </>
        )}
        {v.integrity === 'ok' && <p className="small" style={{ color: 'var(--good)', margin: '0 0 10px' }}>✓ All 576 tiles match what the dealer signed</p>}
        {v.integrity === 'failed' && <div className="banner error">This hunt failed its integrity check. Do not join.</div>}
        <GateNotice gate={v.gate} name={v.allowlistName} />
        <button className="primary big" disabled={v.busy || v.integrity !== 'ok' || v.gate === 'not_member' || v.gate === 'checking'} onClick={() => void hunt.join(column)}>
          {v.busy ? 'Joining…' : 'Set out →'}
        </button>
        {g.relics > 1 && <div style={{ marginTop: 16 }}><PrizeLadder g={g} compact /></div>}
        {v.notice && <div className={`notice ${v.notice.kind}`} onClick={() => hunt.dismissNotice()}>{v.notice.text}</div>}
      </section>
    </div>
  );
}

function Play({ hunt, v }: { hunt: HuntModel; v: HuntView }) {
  const me = v.me!;
  const g = v.game!;
  const now = hunt.now();
  const cooldown = hunt.cooldownLeft();
  const pendingTile = me.pending ? v.tiles.get(`${me.pending.x},${me.pending.y}`) : undefined;
  const here = v.tiles.get(`${me.x},${me.y}`);
  const canStep =
    me.status === ExplorerStatus.ACTIVE && !v.busy && !v.error && cooldown === 0 && hunt.live &&
    (!me.pending || (!!v.queuedResolve && v.queuedResolve.x === me.pending.x && v.queuedResolve.y === me.pending.y));

  const move = useCallback((d: DirectionValue) => canStep && void hunt.step(d), [canStep, hunt]);
  useEffect(() => {
    const keys: Record<string, DirectionValue> = {
      ArrowUp: Direction.NORTH, ArrowRight: Direction.EAST, ArrowDown: Direction.SOUTH, ArrowLeft: Direction.WEST,
      w: Direction.NORTH, d: Direction.EAST, s: Direction.SOUTH, a: Direction.WEST,
    };
    const on = (e: KeyboardEvent) => {
      const d = keys[e.key];
      if (d !== undefined && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        move(d);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [move]);

  const frozen = me.status === ExplorerStatus.FROZEN;
  const finder = me.status === ExplorerStatus.FINDER;
  const deadlineLeft = me.pending ? me.pending.deadlineMs - now : 0;
  const description = here
    ? `You are at column ${me.x + 1}, row ${me.y + 1}: ${kindName(here.kind)}, ${warmthWord(here.warmth)} (${here.warmth}), ${here.hazards} crevasses nearby.`
    : `You are at column ${me.x + 1}, row ${me.y + 1}.`;

  return (
    <section className="play-layout">
      <div>
        <Mountain
          trail={v.trail}
          me={me}
          address={hunt.address}
          tiles={v.tiles}
          revealing={v.revealing}
          claimed={g.claimed}
          drifts={g.drifts}
          driftUntil={g.driftUntil}
          now={now}
          label={description}
        />
        <Legend />
        <p className="sr-only" aria-live="polite">{description}</p>
      </div>

      <aside className="side">
        <Weather g={g} now={now} />
        <div className="card">
          <div className="row">
            <span className="eyebrow">You are here</span>
            <NotifyToggle />
          </div>
          <div className="here" style={{ marginTop: 10 }}>
            <div className={`tile-chip w${here?.kind === 0 ? here.warmth : ''} k${here?.kind ?? ''}`}>{here ? (KIND_GLYPH[here.kind] ?? '') || here.warmth : '?'}</div>
            <div className="meta">
              <strong>{here ? kindName(here.kind) : 'In the fog'}</strong>
              <span className="small mono">
                col {String(me.x + 1).padStart(2, '0')} · row {String(me.y + 1).padStart(2, '0')}
              </span>
              {here && (
                <>
                  <div className="meter" aria-label={`Warmth ${here.warmth} of 5`}>
                    {[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= here.warmth ? 'on' : ''} />)}
                  </div>
                  <span className="small">
                    {warmthWord(here.warmth)} · <span style={{ color: here.hazards ? 'var(--danger)' : undefined }}>{here.hazards} crevasse{here.hazards === 1 ? '' : 's'} near</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="items" aria-label="Items">
          <div>
            <div className="stat-label">Goggles</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>{me.visionSteps > 0 ? `${me.visionSteps}` : '—'}</div>
          </div>
          <div>
            <div className="stat-label">Ropes</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>{me.ropes}/3</div>
          </div>
          <div>
            <div className="stat-label">Stake</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>{me.stake === 0n ? '0' : amount(me.stake, g.coinType).split(' ')[0]}</div>
          </div>
        </div>

        {me.pending && (
          <div className={`banner ${deadlineLeft < 60_000 ? 'error' : 'info'}`} role="status">
            <span>
              {pendingTile ? `Revealed: ${kindName(pendingTile.kind)}` : 'Thawing…'}
              <span className="mono" style={{ marginLeft: 8, opacity: 0.8 }}>{timeLeft(deadlineLeft)}</span>
            </span>
            {deadlineLeft < 60_000 && <button onClick={() => void hunt.resolveNow()}>Retry</button>}
          </div>
        )}

        {pendingTile?.kind === TileKind.RELIC && hunt.live && !g.claimed.includes(pendingTile.y * GRID + pendingTile.x) && (
          <button className="primary big" disabled={v.busy} onClick={() => void hunt.resolveNow()}>
            {g.relics > 1 ? `Claim the relic · ${['1st', '2nd', '3rd'][g.finders.length]} prize` : 'Claim the frozen relic'}
          </button>
        )}

        {frozen && (
          <div className="banner freeze">
            Your yeti fell into a crevasse and froze. Half your stake went to the Lofi well fund, half to the pot. You can keep watching.
          </div>
        )}
        {finder && (
          <div className="banner relic">
            {g.relics > 1
              ? `You claimed a relic: ${['1st', '2nd', '3rd'][Math.max(0, g.finders.findIndex((f) => hunt.address && sameId(f, hunt.address)))]} prize, with your share of the pot and your stake.`
              : 'You found the frozen relic! The prize and the pot are yours.'}
          </div>
        )}
        <PrizeLadder g={g} me={hunt.address} compact />

        {!frozen && !finder && (
          <div className="card" style={{ padding: 14 }}>
            <div className="dpad" aria-label="Move">
              <button aria-label="North" onClick={() => move(Direction.NORTH)} disabled={!canStep || hunt.drifted(me.x, me.y, Direction.NORTH)}>↑</button>
              <button aria-label="West" onClick={() => move(Direction.WEST)} disabled={!canStep || hunt.drifted(me.x, me.y, Direction.WEST)}>←</button>
              <Cooldown ms={cooldown} busy={v.busy} />
              <button aria-label="East" onClick={() => move(Direction.EAST)} disabled={!canStep || hunt.drifted(me.x, me.y, Direction.EAST)}>→</button>
              <button aria-label="South" onClick={() => move(Direction.SOUTH)} disabled={!canStep || hunt.drifted(me.x, me.y, Direction.SOUTH)}>↓</button>
            </div>
            <p className="small center" style={{ margin: '6px 0 0' }}>Arrow keys or WASD</p>
          </div>
        )}

        {v.notice?.kind === 'auth' && <AuthNotice text={v.notice.text} />}
        <Overdue hunt={hunt} v={v} />
      </aside>
      {v.notice && v.notice.kind !== 'auth' && (
        <div className={`notice ${v.notice.kind}`} role="status" onClick={() => hunt.dismissNotice()}>
          {v.notice.text}
        </div>
      )}
    </section>
  );
}

const KIND_GLYPH: Record<number, string> = { 1: '⚠', 2: '◎', 3: '∞', 4: '◆' };

function seedOf(id: string) {
  return parseInt(id.slice(-6), 16) || id.length * 7919;
}

function Cooldown({ ms, busy }: { ms: number; busy: boolean }) {
  const frac = Math.min(1, ms / 8000);
  return (
    <div className="cooldown" aria-label={busy ? 'Moving' : ms ? `Ready in ${Math.ceil(ms / 1000)} s` : 'Ready'}>
      <svg viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15" className="track" />
        <circle cx="18" cy="18" r="15" className="ring" strokeDasharray={`${(1 - frac) * 94.2} 94.2`} />
      </svg>
      <span>{busy ? '…' : ms ? Math.ceil(ms / 1000) : '✓'}</span>
    </div>
  );
}

/** Anyone may freeze an overdue yeti (FR14); shown so the hunt never stalls. */
function Overdue({ hunt, v }: { hunt: HuntModel; v: HuntView }) {
  const [overdue, setOverdue] = useState<string[]>([]);
  useEffect(() => {
    let stop = false;
    void (async () => {
      const { getExplorers } = await import('@whiteout/core');
      const { suiClient } = await import('../config');
      const ids = [...v.trail.explorers.entries()].filter(([, e]) => !e.frozen && !e.finder && !e.withdrawn).map(([id]) => id);
      const xs = await getExplorers(suiClient, ids).catch(() => []);
      if (!stop) setOverdue(xs.filter((x) => x.status === 0 && x.pending && hunt.now() > x.pending.deadlineMs).map((x) => x.id));
    })();
    return () => {
      stop = true;
    };
  }, [hunt, v.trail]);
  if (!overdue.length) return null;
  return (
    <div className="small">
      {overdue.length} yeti{overdue.length > 1 ? 's' : ''} stopped revealing.{' '}
      <button disabled={v.busy} onClick={() => void hunt.freezeOverdue(overdue[0]!)}>Freeze one</button>
    </div>
  );
}

function Spectate({ v }: { v: HuntView }) {
  const frozen = [...v.trail.explorers.values()].filter((e) => e.frozen).length;
  return (
    <section className="play-layout">
      <div>
        <Mountain
          trail={v.trail}
          me={null}
          address={null}
          tiles={new Map()}
          revealing={null}
          claimed={v.game?.claimed}
          drifts={v.game?.drifts}
          driftUntil={v.game?.driftUntil}
          label="Public trail of the hunt"
        />
        <Legend />
      </div>
      <aside className="side">
        {v.game && <Weather g={v.game} now={Date.now()} />}
        <div className="card">
          <span className="eyebrow">Public trail</span>
          <p className="small" style={{ lineHeight: 1.6 }}>
            Spectators see where every yeti is and what each walked-on tile turned out to be. Clues stay sealed until the thaw.
          </p>
          <div className="kv">
            <div><span className="k">Yetis</span><span className="v">{v.trail.explorers.size}</span></div>
            <div><span className="k">Tiles walked</span><span className="v">{v.trail.resolved.size}</span></div>
            <div><span className="k">Frozen</span><span className="v">{frozen}</span></div>
            <div><span className="k">{(v.game?.relics ?? 1) > 1 ? 'Relics' : 'Relic'}</span><span className="v">{(v.game?.relics ?? 1) > 1 ? `${v.game!.finders.length}/${v.game!.relics} found` : v.trail.finder ? 'Found' : 'Hidden'}</span></div>
          </div>
        </div>
        {v.game && <PrizeLadder g={v.game} />}
      </aside>
    </section>
  );
}
