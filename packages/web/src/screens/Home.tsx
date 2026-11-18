import { useEffect, useState } from 'react';
import { TILE_COUNT, getGame, listGames, type GameState } from '@whiteout/core';
import { Backdrop } from '../components/Backdrop';
import { config, configured, suiClient } from '../config';
import { amount, dealerBadge, shortId, statusLabel, timeLeft } from '../lib/format';
import { useTick } from '../lib/useHunt';

const FIELD_GUIDE = [
  { word: 'Snow', desc: 'Safe ground. Every tile you reach tells you how warm you are and how many crevasses lie next to you.' },
  { word: 'Crevasse', desc: 'Step in without a rope and your yeti freezes. Half its stake goes to the Lofi well fund, half to the pot.' },
  { word: 'Goggles', desc: 'For ten steps you can read the eight tiles around you, not just the one under your feet.' },
  { word: 'Rope', desc: 'Carries you over one crevasse. Hold up to three.' },
  { word: 'Relic', desc: 'Frozen somewhere above row twelve. The first yeti to reach it takes the prize and the whole pot.', relic: true },
];

function seedOf(id: string) {
  return parseInt(id.slice(-6), 16) || 1;
}

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
  const shown = [...live, ...lobby, ...past];
  const yetis = live.reduce((n, g) => n + g.playerCount, 0);
  const pot = live.reduce((n, g) => n + g.pot, 0n);
  const first = live[0];
  const go = (id: string) => (e: React.MouseEvent) => (e.preventDefault(), document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }));

  return (
    <>
      <section className="hero">
        <Backdrop seed={7} />
        <span className="coords tele">27°59′N / 86°55′E — {TILE_COUNT} tiles sealed</span>
        <div className="wrap hero-inner">
          <span className="tele ice">An expedition on Sui / {new Date().getFullYear()}</span>
          <h1>
            White
            <br />
            out
          </h1>
          <p className="tagline">The relic is still out there. Nobody knows where.</p>
          <div className="cta">
            {first ? (
              <a className="btn primary arrow" href={`#/hunt/${first.id}`}>
                Join the hunt
              </a>
            ) : (
              <a className="btn primary arrow" href="#expeditions" onClick={go('expeditions')}>
                See expeditions
              </a>
            )}
            <a className="btn arrow" href="#field-guide" onClick={go('field-guide')}>
              Field guide
            </a>
          </div>
          <div className="hero-bar">
            <span className="tele">Mountain / Grid 24 × 24</span>
            <span className="tele signal">
              <span className={`blip ${live.length ? '' : 'off'}`} />
              {games ? (live.length ? `Signal detected · ${live.length} live` : 'No signal') : 'Scanning…'}
            </span>
            <span className="tele">{games ? `${yetis} yetis on the mountain` : '—'}</span>
          </div>
        </div>
      </section>

      <div className="wrap">
        <section className="section" id="expeditions">
          <div className="split">
            <div className="intro">
              <span className="tele ice">The mountain / 01</span>
              <h2 style={{ marginTop: 14 }}>
                A mountain that
                <br />
                <span className="accent">keeps secrets</span>.
              </h2>
              <p>
                Every hunt is a fresh 24 × 24 mountain, dealt in the dark. Each tile is sealed: you can read only the
                ground under your yeti. Warmth tells you how close the relic is.
              </p>
              <div className="readout">
                <div>
                  <div className="stat-label">Live</div>
                  <div className="stat-value">{games ? live.length : '—'}</div>
                </div>
                <div>
                  <div className="stat-label">Yetis</div>
                  <div className="stat-value">{games ? yetis : '—'}</div>
                </div>
                <div>
                  <div className="stat-label">Pot</div>
                  <div className="stat-value">{games ? amount(pot, '0x2::sui::SUI').replace(' SUI', '') : '—'}</div>
                </div>
              </div>
            </div>
            <div>
              {!configured && <p className="empty">Not deployed yet: set packageId in deploy/{config.network}.json</p>}
              {error && (
                <div className="banner error" role="alert">
                  Signal lost. Retrying… <small className="mono">{error.slice(0, 70)}</small>
                </div>
              )}
              {configured && !games && !error && (
                <div className="skeleton-list" aria-busy="true">
                  <div />
                  <div />
                </div>
              )}
              {games && !shown.length && <p className="empty">No expeditions yet. The next one sets out soon.</p>}
              <ul className="expeditions">
                {shown.map((g, i) => (
                  <Expedition key={g.id} g={g} n={i + 1} now={now} />
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="section" id="field-guide">
          <div className="section-head">
            <h2>Field guide</h2>
            <span className="tele">What lies under the snow / 02</span>
          </div>
          <ol className="field-guide">
            {FIELD_GUIDE.map((f, i) => (
              <li key={f.word} className={f.relic ? 'relic' : ''}>
                <span className="num">{String(i + 1).padStart(3, '0')}</span>
                <span className="word">{f.word}</span>
                <span className="desc">{f.desc}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="section" id="protocol">
          <div className="section-head">
            <h2>
              No game <span className="accent">master</span>
            </h2>
            <span className="tele">Protocol / 03</span>
          </div>
          <div className="protocol">
            <div>
              <span className="tele ice">01 — Sealed</span>
              <h3 style={{ marginTop: 12 }}>Every tile is locked</h3>
              <p>Each tile is encrypted with Seal. Key servers release it only to the yeti standing on it, checked against the chain.</p>
            </div>
            <div>
              <span className="tele ice">02 — Dealt in the dark</span>
              <h3 style={{ marginTop: 12 }}>Nobody knows the map</h3>
              <p>An attested enclave deals the mountain and signs every tile. The host never sees it, and nothing can be swapped later.</p>
            </div>
            <div>
              <span className="tele ice">03 — Thawed in the open</span>
              <h3 style={{ marginTop: 12 }}>Verify every step</h3>
              <p>The contract checks every reveal. When the hunt ends the whole mountain thaws, and anyone can audit it.</p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Expedition({ g, n, now }: { g: GameState; n: number; now: number }) {
  const badge = dealerBadge(g.dealerKind);
  const isLive = g.status === 1 && now < g.endsAt;
  return (
    <li>
      <a className="exp-card" href={`#/hunt/${g.id}`}>
        <Backdrop seed={seedOf(g.id)} yeti={false} />
        <div className="exp-top">
          <span className="tele signal">
            <span className={`blip ${isLive ? '' : 'off'}`} />
            {statusLabel(g, now)}
          </span>
          <span className={`badge ${badge.tone}`}>{badge.text}</span>
        </div>
        <div className="exp-body">
          <span className="tele">Expedition {String(n).padStart(2, '0')} / {shortId(g.id, 4)}</span>
          <h3>{isLive ? timeLeft(g.endsAt - now) : statusLabel(g, now)}</h3>
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
              <span className="k">Enter</span>
              <span className="v arrow" />
            </div>
          </div>
        </div>
      </a>
    </li>
  );
}
