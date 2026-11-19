/**
 * Hunt history (Phase 2): every finished expedition, who found what, and what went to
 * the wells. Built from one scan of the package's events, so no database is needed.
 */
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useEffect, useMemo, useState } from 'react';
import { GameStatus, getGame, parseEvent, sameId, type GameEvent, type GameState } from '@whiteout/core';
import { Mark } from '../components/Logo';
import { HuntTags } from '../components/Phase2';
import { config, configured, suiClient } from '../config';
import { amount, dealerBadge, shortId, statusLabel } from '../lib/format';
import { CountUp, Words } from '../lib/motion';

interface Summary {
  players: Set<string>;
  frozen: number;
  toWell: bigint;
  finders: Array<{ rank: number; finder: string; pot: bigint }>;
  blizzards: number;
  steps: number;
}

const empty = (): Summary => ({ players: new Set(), frozen: 0, toWell: 0n, finders: [], blizzards: 0, steps: 0 });

const MAX_PAGES = 120;

/**
 * Whiteout events grouped by game, newest first, up to MAX_PAGES pages: the logbook
 * shows the most recent hunts and says when older ones were left out. A game whose
 * LobbyCreated was not reached is dropped, as its summary would be partial.
 */
async function scanEvents(): Promise<{ games: Map<string, Summary>; more: boolean }> {
  const out = new Map<string, Summary>();
  const created = new Set<string>();
  let before: string | null = null;
  let more = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      more = true;
      break;
    }
    let res: { events: Array<{ eventType: string; bcs: Uint8Array }>; hasNextPage: boolean; endCursor?: string | null };
    try {
      res = await suiClient.core.listEvents({
        filter: { emitModule: `${config.packageId}::game` },
        limit: 50,
        order: 'descending',
        ...(before ? { before } : {}),
      });
    } catch (e) {
      // Older checkpoints are pruned on public nodes: show what is still readable.
      if (/earliest available|pruned|below/i.test((e as Error).message)) {
        more = true;
        break;
      }
      throw e;
    }
    for (const raw of res.events) {
      const ev = parseEvent(config.packageId, raw) as GameEvent | null;
      if (!ev) continue;
      const id = (ev.data as { game_id: string }).game_id;
      const s = out.get(id) ?? empty();
      out.set(id, s);
      switch (ev.name) {
        case 'LobbyCreated':
          created.add(id);
          break;
        case 'ExplorerJoined':
          s.players.add(ev.data.owner);
          break;
        case 'Stepped':
          s.steps += 1;
          break;
        case 'ExplorerFrozen':
          s.frozen += 1;
          s.toWell += BigInt(ev.data.to_well);
          break;
        case 'GameFinalized':
          s.toWell += BigInt(ev.data.to_well);
          break;
        case 'RelicClaimed':
          s.finders.push({ rank: ev.data.rank, finder: ev.data.finder, pot: BigInt(ev.data.pot) });
          break;
        case 'BlizzardStarted':
          s.blizzards += 1;
          break;
        default:
          break;
      }
    }
    before = res.endCursor ?? before;
    if (!res.hasNextPage) break;
  }
  for (const id of [...out.keys()]) if (!created.has(id)) out.delete(id);
  return { games: out, more };
}

export function History() {
  const account = useCurrentAccount();
  const [rows, setRows] = useState<Array<{ g: GameState; s: Summary }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!configured) {
      setError('This network has no Whiteout deployment configured.');
      return;
    }
    let stop = false;
    void (async () => {
      try {
        const { games: summaries, more } = await scanEvents();
        if (!stop) setMore(more);
        const games = await Promise.all([...summaries.keys()].map((id) => getGame(suiClient, id, config.packageId).catch(() => null)));
        const list = games
          .filter((g): g is GameState => !!g)
          .map((g) => ({ g, s: summaries.get(g.id) ?? empty() }))
          .sort((a, b) => (b.g.endsAt || b.g.openAt) - (a.g.endsAt || a.g.openAt));
        if (!stop) setRows(list);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  const now = Date.now();
  const finished = useMemo(
    () => (rows ?? []).filter(({ g }) => g.status >= GameStatus.ENDED_FOUND || (g.status === GameStatus.OPEN && now >= g.endsAt)),
    [rows, now],
  );
  const shown = mine && account ? finished.filter(({ s }) => [...s.players].some((p) => sameId(p, account.address))) : finished;
  const totals = finished.reduce(
    // The total is in SUI, so it counts SUI hunts only.
    (t, { g, s }) => ({
      hunts: t.hunts + 1,
      players: t.players + s.players.size,
      finds: t.finds + s.finders.length,
      well: t.well + (/::sui::SUI$/.test(g.coinType) ? s.toWell : 0n),
    }),
    { hunts: 0, players: 0, finds: 0, well: 0n },
  );

  return (
    <section className="history">
      <div className="history-head" data-reveal="words">
        <span className="tele ice">The logbook</span>
        <h1>
          <Words text="Past" /> <span className="thin"><Words text="expeditions" from={1} /></span>
        </h1>
        <p className="small" style={{ maxWidth: '56ch', fontSize: '1.02rem' }}>
          Every hunt that has thawed: who reached the relics, who froze, and what the frozen stakes paid into the Lofi
          wells. Rebuilt from on-chain events, nothing else.
        </p>
      </div>

      <div className="readout history-stats" data-reveal>
        <div>
          <div className="stat-label">Hunts</div>
          <div className="stat-value"><CountUp value={rows ? totals.hunts : null} /></div>
        </div>
        <div>
          <div className="stat-label">Yetis</div>
          <div className="stat-value"><CountUp value={rows ? totals.players : null} /></div>
        </div>
        <div>
          <div className="stat-label">Relics found</div>
          <div className="stat-value"><CountUp value={rows ? totals.finds : null} /></div>
        </div>
        <div>
          <div className="stat-label">To the wells</div>
          <div className="stat-value">
            <CountUp value={rows ? Number(totals.well) / 1e9 : null} format={(n) => `${n.toFixed(n < 10 ? 3 : 1)} SUI`} />
          </div>
        </div>
      </div>

      <div className="row" style={{ margin: '28px 0 14px' }}>
        <span className="tele">{shown.length} finished</span>
        {account && (
          <span className="seg" role="tablist">
            <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>All hunts</button>
            <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Hunts I played</button>
          </span>
        )}
      </div>

      {error && <div className="banner error">Could not read the logbook: {error.slice(0, 120)}</div>}
      {!rows && !error && <div className="skeleton-list" aria-busy="true"><div /><div /></div>}
      {more && rows && <p className="small">Showing the most recent hunts. Older ones are still on-chain but not listed here.</p>}
      {rows && !shown.length && (
        <div className="empty-state">
          <Mark size={40} animate={false} />
          <p>{mine ? 'You have not finished a hunt yet.' : 'No hunt has thawed yet. The first one is still out there.'}</p>
          <a className="btn arrow" href="#/">See live expeditions</a>
        </div>
      )}

      <ol className="logbook">
        {shown.map(({ g, s }, i) => {
          const badge = dealerBadge(g.dealerKind);
          const played = account && [...s.players].some((p) => sameId(p, account.address));
          return (
            <li key={g.id} data-reveal data-delay={Math.min(i, 8) * 60}>
              <a href={`#/hunt/${g.id}`} className="log-row tilt">
                <div className="log-when">
                  <span className="tele">{g.endsAt ? new Date(g.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>
                  <strong>{statusLabel(g, now)}</strong>
                </div>
                <div className="log-what">
                  <span className="tele">Expedition {shortId(g.id, 4)}</span>
                  <span className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
                    <span className={`badge ${badge.tone}`}>{badge.text}</span>
                    <HuntTags g={g} />
                    {played && <span className="tag mine">You played</span>}
                  </span>
                </div>
                <div className="log-finders">
                  {s.finders.length ? (
                    s.finders
                      .sort((a, b) => a.rank - b.rank)
                      .map((f) => (
                        <span key={f.rank} className="finder">
                          <i>{['1st', '2nd', '3rd'][f.rank - 1]}</i>
                          {account && sameId(f.finder, account.address) ? 'You' : shortId(f.finder, 4)}
                          {/* The pot share; the prize itself is a separate object. Empty on free hunts. */}
                          {f.pot > 0n && <small>+{amount(f.pot, g.coinType)} pot</small>}
                        </span>
                      ))
                  ) : (
                    <span className="small">No relic found</span>
                  )}
                </div>
                <dl className="log-nums">
                  <div><dt>Yetis</dt><dd>{s.players.size}</dd></div>
                  <div><dt>Frozen</dt><dd>{s.frozen}</dd></div>
                  <div><dt>Steps</dt><dd>{s.steps}</dd></div>
                  <div><dt>Wells</dt><dd>{amount(s.toWell, g.coinType)}</dd></div>
                </dl>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
