import { useEffect, useState } from 'react';
import { getGame, listGames, type GameState } from '@whiteout/core';
import { config, configured, suiClient } from '../config';
import { amount, dealerBadge, shortId, statusLabel, timeLeft } from '../lib/format';
import { useTick } from '../lib/useHunt';

export function Home() {
  const [games, setGames] = useState<GameState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTick(1000);

  useEffect(() => {
    if (!configured) return;
    let stop = false;
    const load = async () => {
      try {
        const ids = await listGames(suiClient, config.packageId, 30);
        const gs = await Promise.all(ids.map((id) => getGame(suiClient, id).catch(() => null)));
        if (!stop) setGames(gs.filter((g): g is GameState => !!g));
        setError(null);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const now = Date.now();
  const live = games?.filter((g) => g.status === 1 && now < g.endsAt) ?? [];
  const lobby = games?.filter((g) => g.status === 0) ?? [];
  const past = games?.filter((g) => g.status >= 2 || (g.status === 1 && now >= g.endsAt)) ?? [];
  const yetis = live.reduce((n, g) => n + g.playerCount, 0);
  const pot = live.reduce((n, g) => n + g.pot, 0n);
  const first = live[0];

  return (
    <>
      <section className="hero">
        <span className="pill">
          <span className="dot live" /> Live on Sui {config.network} · every tile sealed
        </span>
        <h1>A relic is buried in the snow.</h1>
        <p className="lede">
          Walk a 24×24 mountain one tile at a time. You can only read the ground under your yeti's feet, and nobody, not even
          the host, knows the map. First to reach the frozen relic takes the prize and the pot.
        </p>
        <div className="cta">
          {first ? (
            <a className="btn primary" href={`#/hunt/${first.id}`}>
              Join the live hunt →
            </a>
          ) : (
            <a className="btn primary" href="#hunts" onClick={(e) => (e.preventDefault(), document.getElementById('hunts')?.scrollIntoView({ behavior: 'smooth' }))}>
              See hunts
            </a>
          )}
          <a className="btn" href="#how" onClick={(e) => (e.preventDefault(), document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }))}>
            How it works
          </a>
        </div>
        <div className="stats" aria-label="Right now">
          <div>
            <div className="stat-label">Live hunts</div>
            <div className="stat-value">{games ? live.length : '—'}</div>
          </div>
          <div>
            <div className="stat-label">Yetis on the mountain</div>
            <div className="stat-value">{games ? yetis : '—'}</div>
          </div>
          <div>
            <div className="stat-label">Total pot</div>
            <div className="stat-value">{games ? amount(pot, '0x2::sui::SUI') : '—'}</div>
          </div>
        </div>
      </section>

      <div id="hunts" />
      {!configured && (
        <section className="card center">
          <h2>Not deployed yet</h2>
          <p className="small">
            Set <code>packageId</code> in <code>deploy/{config.network}.json</code> after publishing the Move package.
          </p>
        </section>
      )}
      {error && (
        <div className="banner error" role="alert">
          Could not reach the network. Retrying… <small>{error.slice(0, 80)}</small>
        </div>
      )}
      {configured && !games && !error && (
        <div className="skeleton-list" aria-busy="true">
          <div />
          <div />
          <div />
        </div>
      )}
      {games && !games.length && <p className="empty">No hunts yet. The next one opens soon.</p>}
      <HuntList title="Live now" games={live} now={now} />
      <HuntList title="Opening soon" games={lobby} now={now} />
      <HuntList title="Finished" games={past} now={now} />

      <div className="section-title" id="how">
        <h2>No game master</h2>
        <span className="eyebrow">How it works</span>
      </div>
      <div className="features">
        <div className="card feature">
          <div className="icon">
            <LockIcon />
          </div>
          <h3>Every tile is sealed</h3>
          <p>Each tile is encrypted with Seal. Key servers release a tile only to the player standing on it, checked on-chain.</p>
        </div>
        <div className="card feature">
          <div className="icon">
            <ChipIcon />
          </div>
          <h3>Nobody knows the map</h3>
          <p>An attested enclave deals the mountain and signs every tile. The host never sees it, and nothing can be swapped later.</p>
        </div>
        <div className="card feature">
          <div className="icon">
            <CheckIcon />
          </div>
          <h3>Verify everything</h3>
          <p>Every reveal is checked by the contract. When the hunt ends the whole map thaws, so anyone can audit every step.</p>
        </div>
      </div>
    </>
  );
}

function HuntList({ title, games, now }: { title: string; games: GameState[]; now: number }) {
  if (!games.length) return null;
  return (
    <section>
      <div className="section-title">
        <h2>{title}</h2>
        <span className="eyebrow">{games.length}</span>
      </div>
      <ul className="hunts">
        {games.map((g) => {
          const badge = dealerBadge(g.dealerKind);
          const isLive = g.status === 1 && now < g.endsAt;
          return (
            <li key={g.id}>
              <a className="card hunt-card" href={`#/hunt/${g.id}`}>
                <span className="go" aria-hidden="true">→</span>
                <div className="title">
                  <span className={`dot ${isLive ? 'live' : ''}`} />
                  {statusLabel(g, now)}
                  <span className={`badge ${badge.tone}`}>{badge.text}</span>
                </div>
                <div className="id">{shortId(g.id, 6)}</div>
                <div className="kv">
                  <div>
                    <span className="k">Entry</span>
                    <span className="v">{g.entryStake === 0n ? 'Free' : amount(g.entryStake, g.coinType)}</span>
                  </div>
                  <div>
                    <span className="k">Pot</span>
                    <span className="v">{amount(g.pot, g.coinType)}</span>
                  </div>
                  <div>
                    <span className="k">Yetis</span>
                    <span className="v">
                      {g.playerCount}/{g.maxPlayers}
                    </span>
                  </div>
                  <div>
                    <span className="k">{isLive ? 'Time left' : 'Status'}</span>
                    <span className="v">{isLive ? timeLeft(g.endsAt - now) : statusLabel(g, now)}</span>
                  </div>
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const iconProps = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const LockIcon = () => (
  <svg {...iconProps}>
    <rect x="4" y="11" width="16" height="10" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const ChipIcon = () => (
  <svg {...iconProps}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </svg>
);
const CheckIcon = () => (
  <svg {...iconProps}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </svg>
);
