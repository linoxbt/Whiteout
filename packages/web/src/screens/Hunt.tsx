import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  Direction,
  ExplorerStatus,
  GameStatus,
  GRID,
  TileKind,
  type DirectionValue,
} from '@whiteout/core';
import { Mountain } from '../components/Mountain';
import type { Hunt as HuntModel, HuntView } from '../lib/hunt';
import { amount, dealerBadge, kindName, statusLabel, timeLeft, warmthWord } from '../lib/format';
import { useHunt, useTick } from '../lib/useHunt';
import { Thaw } from './Thaw';

export function Hunt({ gameId, mode }: { gameId: string; mode?: string }) {
  const [hunt, v] = useHunt(gameId);
  const account = useCurrentAccount();
  useTick(1000);

  if (v.loading) return <div className="skeleton-grid" aria-busy="true" />;
  if (!v.game) return <div className="banner error">Hunt not found. {v.error}</div>;

  const g = v.game;
  const now = hunt.now();
  const badge = dealerBadge(g.dealerKind);
  const header = (
    <div className="hunt-head">
      <div className="row">
        <a href="#/">← Hunts</a>
        <span className={`badge ${badge.tone}`}>{badge.text}</span>
        <a href={`#/hunt/${gameId}/verify`}>Verify</a>
      </div>
      <div className="row small">
        <span>{statusLabel(g, now)}</span>
        {g.status === GameStatus.OPEN && now < g.endsAt && <span>{timeLeft(g.endsAt - now)} left</span>}
        <span>Pot {amount(g.pot, g.coinType)}</span>
        <span>{g.playerCount} yetis</span>
      </div>
      {v.error && <div className="banner error" role="alert">Network trouble: retrying. Actions are paused.</div>}
      {g.dealerKind === 2 && <div className="banner warn">This hunt was dealt by its host, who could know the map. It is free to enter.</div>}
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
        <h2 id="session-title">Allow this device to read your tiles for 30 min</h2>
        <p>Your wallet will ask for one signature. It cannot move funds: it only lets this browser read the ground under your yeti.</p>
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
    <section className="card center">
      <h2>Join the hunt</h2>
      <p>Play with Google (no crypto needed) or connect a Sui wallet.</p>
      <ConnectButton />
      <p className="small"><a href={`#/hunt/${v.game!.id}/spectate`}>Just watch</a></p>
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
  return (
    <section className="card">
      <h2>How it works</h2>
      <ol className="rules">
        <li>Your yeti starts at base camp, at the bottom of the mountain.</li>
        <li>Each step reveals only the tile you land on. The number shows how warm you are (5 = within 2 tiles of the relic).</li>
        <li>The red number counts crevasses next to you. Step on one without a rope and your yeti freezes.</li>
        <li>Goggles let you see one tile further for 10 steps. Ropes carry you over one crevasse.</li>
        <li>First to reach the frozen relic wins the prize and the pot.</li>
      </ol>
      <p>
        Entry stake: <strong>{g.entryStake === 0n ? 'free' : amount(g.entryStake, g.coinType)}</strong>. If you freeze,
        half goes to the Lofi well fund and half to the pot. Otherwise you get it back when the hunt ends.
      </p>
      <label className="column-picker">
        Base camp column: <strong>{column + 1}</strong>
        <input type="range" min={0} max={GRID - 1} value={column} onChange={(e) => setColumn(Number(e.target.value))} aria-label="Base camp column" />
      </label>
      {v.integrity === 'checking' && <p className="small">Checking the hunt's integrity… {v.integrityProgress}/576</p>}
      {v.integrity === 'failed' && <div className="banner error">This hunt failed its integrity check. Do not join.</div>}
      <button className="primary" disabled={v.busy || v.integrity !== 'ok'} onClick={() => void hunt.join(column)}>
        {v.busy ? 'Joining…' : 'Join'}
      </button>
      {v.notice && <p className={`notice ${v.notice.kind}`}>{v.notice.text}</p>}
    </section>
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
    <section className="play">
      <Mountain trail={v.trail} me={me} address={hunt.address} tiles={v.tiles} revealing={v.revealing} label={description} />
      <p className="sr-only" aria-live="polite">{description}</p>

      <div className="hud">
        <div className="items" aria-label="Items">
          <span title="Goggles">👓 {me.visionSteps > 0 ? `${me.visionSteps} steps` : '—'}</span>
          <span title="Ropes">🪢 {me.ropes}/3</span>
          <span title="Stake">Stake {amount(me.stake, g.coinType)}</span>
        </div>
        {here && (
          <div className="here">
            <strong>{kindName(here.kind)}</strong> · warmth {here.warmth} ({warmthWord(here.warmth)}) · {here.hazards} crevasse{here.hazards === 1 ? '' : 's'} near
          </div>
        )}
      </div>

      {me.pending && (
        <div className={`banner ${deadlineLeft < 60_000 ? 'error' : 'info'}`} role="status">
          {pendingTile ? `Revealed: ${kindName(pendingTile.kind)}.` : 'Thawing…'} Reveal in progress, {timeLeft(deadlineLeft)} left.
          {deadlineLeft < 60_000 && <button onClick={() => void hunt.resolveNow()}>Retry</button>}
        </div>
      )}

      {pendingTile?.kind === TileKind.RELIC && hunt.live && (
        <button className="primary big" disabled={v.busy} onClick={() => void hunt.resolveNow()}>
          Claim the frozen relic
        </button>
      )}

      {frozen && (
        <div className="banner freeze">
          Your yeti fell into a crevasse and froze. You can keep watching. Half your stake went to the Lofi well fund, half to the pot.
        </div>
      )}
      {finder && <div className="banner relic">You found the frozen relic! The prize and the pot are yours.</div>}

      {!frozen && !finder && (
        <div className="dpad" aria-label="Move">
          <button aria-label="North" onClick={() => move(Direction.NORTH)} disabled={!canStep}>▲</button>
          <button aria-label="West" onClick={() => move(Direction.WEST)} disabled={!canStep}>◀</button>
          <Cooldown ms={cooldown} busy={v.busy} />
          <button aria-label="East" onClick={() => move(Direction.EAST)} disabled={!canStep}>▶</button>
          <button aria-label="South" onClick={() => move(Direction.SOUTH)} disabled={!canStep}>▼</button>
        </div>
      )}

      {v.notice?.kind === 'auth' && <AuthNotice text={v.notice.text} />}
      {v.notice && v.notice.kind !== 'auth' && (
        <div className={`notice ${v.notice.kind}`} role="status" onClick={() => hunt.dismissNotice()}>
          {v.notice.text}
        </div>
      )}
      <Overdue hunt={hunt} v={v} />
    </section>
  );
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
    <section>
      <Mountain trail={v.trail} me={null} address={null} tiles={new Map()} revealing={null} label="Public trail of the hunt" />
      <p className="small">
        {v.trail.explorers.size} yetis · {v.trail.resolved.size} tiles walked · {frozen} frozen
        {v.trail.finder ? ` · relic found by ${v.trail.finder.slice(0, 10)}…` : ''}
      </p>
    </section>
  );
}
