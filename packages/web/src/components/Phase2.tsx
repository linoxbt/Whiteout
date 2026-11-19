/**
 * Phase 2 panels: the prize ladder for ranked relics, the weather (blizzards), the
 * allowlist gate, and the deadline-alert toggle.
 */
import { useState } from 'react';
import { nextPotShare, sameId, type GameState } from '@whiteout/core';
import { amount, shortId, timeLeft } from '../lib/format';
import { disableNotify, enableNotify, notifyEnabled, notifySupported } from '../lib/notify';

const RANK = ['1st', '2nd', '3rd'];

/** Ranks, pot shares and who took them. The next open rank shows its live payout. */
export function PrizeLadder({ g, me, compact = false }: { g: GameState; me?: string | null; compact?: boolean }) {
  if (g.relics <= 1) return null;
  const next = g.finders.length;
  const nextPot = nextPotShare(g);
  return (
    <div className={`card ladder ${compact ? 'compact' : ''}`}>
      <div className="row">
        <span className="eyebrow">Ranked relics</span>
        <span className="tele">
          {g.finders.length}/{g.relics} found
        </span>
      </div>
      <ol>
        {g.potShares.map((bps, i) => {
          const finder = g.finders[i];
          const mine = !!finder && !!me && sameId(finder, me);
          return (
            <li key={i} className={`${finder ? 'taken' : ''} ${i === next ? 'next' : ''} ${mine ? 'mine' : ''}`}>
              <span className="rank">{RANK[i]}</span>
              <span className="what">
                <strong>Prize {i + 1}</strong>
                <small>{bps / 100}% of the pot</small>
              </span>
              <span className="who">
                {finder ? (mine ? 'You' : shortId(finder, 4)) : i === next ? (nextPot > 0n ? `+ ${amount(nextPot, g.coinType)}` : 'Prize + stake') : 'Open'}
              </span>
            </li>
          );
        })}
      </ol>
      {!compact && (
        <p className="small" style={{ margin: '10px 0 0' }}>
          Each find takes the next prize and its share of the pot at that moment. The hunt ends when every relic is claimed.
        </p>
      )}
    </div>
  );
}

/** Blizzard status: drifts melting, or the next blizzard's countdown. */
export function Weather({ g, now, onStart, busy }: { g: GameState; now: number; onStart?: () => void; busy?: boolean }) {
  if (!g.blizzardEveryMs) return null;
  const drifting = now < g.driftUntil && g.drifts.length > 0;
  const live = g.status === 1 && now < g.endsAt;
  if (!live && !drifting) return null;
  return (
    <div className={`weather ${drifting ? 'storm' : ''}`} role="status">
      <span className="weather-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8" />
        </svg>
      </span>
      <span>
        {drifting ? (
          <>
            <strong>Blizzard.</strong> {g.drifts.length} drifts melt in <span className="mono">{timeLeft(g.driftUntil - now)}</span>
          </>
        ) : now >= g.nextBlizzardAt && now + g.blizzardMs <= g.endsAt ? (
          <>
            <strong>A blizzard is brewing.</strong> Anyone may start it.{' '}
            {onStart && (
              <button className="link-button" disabled={busy} onClick={onStart}>
                Start it
              </button>
            )}
          </>
        ) : now >= g.nextBlizzardAt ? (
          <>The skies stay clear until the thaw.</>
        ) : (
          <>
            Next blizzard in <span className="mono">{timeLeft(g.nextBlizzardAt - now)}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** Lobby notice for a gated hunt. */
export function GateNotice({ gate, name }: { gate: 'open' | 'checking' | 'member' | 'not_member'; name: string | null }) {
  if (gate === 'open') return null;
  const label = name ? `"${name}"` : 'its allowlist';
  if (gate === 'member') return <div className="banner info">You are on {label}. You can join.</div>;
  if (gate === 'checking') return <div className="banner info">Checking {label} for your address…</div>;
  return (
    <div className="banner warn">
      This hunt is for holders on {label}. Your address is not on it, so the contract will refuse the join.
    </div>
  );
}

/** Opt in to browser alerts for reveal deadlines, blizzards and rival finds. */
export function NotifyToggle() {
  const [on, setOn] = useState(notifyEnabled());
  if (!notifySupported()) return null;
  return (
    <button
      className={`notify-toggle ${on ? 'on' : ''}`}
      onClick={async () => {
        if (on) {
          disableNotify();
          setOn(false);
        } else setOn(await enableNotify());
      }}
      aria-pressed={on}
      title="Browser alerts for your reveal deadline, blizzards and rival finds, while this hunt is open in a tab"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" />
      </svg>
      {on ? 'Alerts on' : 'Alert me'}
    </button>
  );
}

/** Short tags for an expedition: ranked, gated, blizzards. */
export function HuntTags({ g }: { g: GameState }) {
  const tags = [
    g.relics > 1 && `${g.relics} relics`,
    g.allowlist && 'Holders only',
    g.blizzardEveryMs > 0 && 'Blizzards',
  ].filter(Boolean) as string[];
  if (!tags.length) return null;
  return (
    <span className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
    </span>
  );
}

