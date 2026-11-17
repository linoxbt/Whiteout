import { useEffect, useState } from 'react';
import { getGame, listGames, type GameState } from '@whiteout/core';
import { config, configured, suiClient } from '../config';
import { amount, dealerBadge, statusLabel, timeLeft } from '../lib/format';
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

  if (!configured)
    return (
      <section className="card">
        <h2>Not deployed yet</h2>
        <p>
          Set <code>packageId</code> in <code>deploy/{config.network}.json</code> after publishing the Move package.
        </p>
      </section>
    );

  const now = Date.now();
  const live = games?.filter((g) => g.status === 1 && now < g.endsAt) ?? [];
  const lobby = games?.filter((g) => g.status === 0) ?? [];
  const past = games?.filter((g) => g.status >= 2 || (g.status === 1 && now >= g.endsAt)) ?? [];

  return (
    <>
      <section className="hero">
        <h1>Whiteout</h1>
        <p>A frozen relic is buried somewhere on the mountain. Every tile is sealed: you can only read the ground under your yeti's feet. Nobody, not even the host, knows the map.</p>
      </section>
      {error && <div className="banner error" role="alert">Could not reach the network. Retrying… <small>{error}</small></div>}
      {!games && !error && <div className="skeleton-list" aria-busy="true"><div /><div /><div /></div>}
      {games && !games.length && <p className="empty">No live hunts. Check back soon.</p>}
      <HuntList title="Live hunts" games={live} now={now} />
      <HuntList title="Upcoming" games={lobby} now={now} />
      <HuntList title="Finished" games={past} now={now} />
    </>
  );
}

function HuntList({ title, games, now }: { title: string; games: GameState[]; now: number }) {
  if (!games.length) return null;
  return (
    <section>
      <h2>{title}</h2>
      <ul className="hunts">
        {games.map((g) => {
          const badge = dealerBadge(g.dealerKind);
          return (
            <li key={g.id}>
              <a className="card hunt-card" href={`#/hunt/${g.id}`}>
                <div className="row">
                  <strong>{statusLabel(g, now)}</strong>
                  <span className={`badge ${badge.tone}`}>{badge.text}</span>
                </div>
                <div className="row small">
                  <span>Stake {g.entryStake === 0n ? 'free' : amount(g.entryStake, g.coinType)}</span>
                  <span>
                    {g.playerCount}/{g.maxPlayers} yetis
                  </span>
                  <span>Pot {amount(g.pot, g.coinType)}</span>
                  {g.status === 1 && now < g.endsAt && <span>{timeLeft(g.endsAt - now)} left</span>}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
