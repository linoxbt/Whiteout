/**
 * Host console (Phase 2): everything the `whiteout` CLI does, in the browser. The
 * host signs with their own wallet and pays gas; nothing here is sponsored.
 */
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  Blizzard,
  ExplorerStatus,
  GameStatus,
  applyEvents,
  blizzardDue,
  emptyTrail,
  fromHex,
  getAllowlist,
  getExplorers,
  getGame,
  isEnded,
  listGameEvents,
  tx,
  type AllowlistState,
  type GameState,
  type Trail,
} from '@whiteout/core';
import { HuntTags, PrizeLadder, Weather } from '../components/Phase2';
import { WalletHelp } from '../components/WalletHelp';
import { config, configured, suiClient } from '../config';
import { amount, dealerBadge, shortId, statusLabel, timeLeft } from '../lib/format';
import {
  ceremonyDealInBrowser,
  depositSuiPrize,
  enclaveDealInBrowser,
  loadDeal,
  myAllowlistCaps,
  myHostCaps,
  runHost,
  thawInBrowser,
  type StoredDeal,
} from '../lib/host';
import { Words } from '../lib/motion';
import { useTick } from '../lib/useHunt';

const SUI = '0x2::sui::SUI';
const ctx = { packageId: config.packageId, coinType: SUI };
const toMist = (s: string) => BigInt(Math.round(Number(s || '0') * 1e9));

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const act = useCallback(async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setMsg(null);
    try {
      const done = await fn();
      if (done) setMsg({ kind: 'ok', text: done });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, msg, setMsg, act };
}

export function Host({ gameId }: { gameId?: string }) {
  const account = useCurrentAccount();
  if (!configured) return <p className="empty">Not deployed on this network yet.</p>;
  if (!account) {
    return (
      <section className="host">
        <HostHead />
        <div className="card host-connect">
          <h2>Connect the host wallet</h2>
          <p className="small">
            Hosting needs a Sui wallet with some SUI for gas and prizes. Host actions are never sponsored.
          </p>
          <ConnectButton />
          <WalletHelp />
        </div>
      </section>
    );
  }
  return gameId ? <Manage gameId={gameId} address={account.address} /> : <Console address={account.address} />;
}

function HostHead({ title = 'Host console' }: { title?: string }) {
  return (
    <div className="history-head" data-reveal="words">
      <span className="tele ice">Base camp / host</span>
      <h1>
        <Words text={title.split(' ')[0]!} /> <span className="thin"><Words text={title.split(' ').slice(1).join(' ')} from={1} /></span>
      </h1>
    </div>
  );
}

// =====================================================================
// Console: my hunts, a new hunt, allowlists
// =====================================================================

function Console({ address }: { address: string }) {
  const [hunts, setHunts] = useState<Array<{ capId: string; g: GameState }> | null>(null);
  const reload = useCallback(async () => {
    const caps = await myHostCaps(address);
    const games = await Promise.all(caps.map(async (c) => ({ capId: c.capId, g: await getGame(suiClient, c.gameId).catch(() => null) })));
    setHunts(games.filter((x): x is { capId: string; g: GameState } => !!x.g).sort((a, b) => (b.g.openAt || 9e15) - (a.g.openAt || 9e15)));
  }, [address]);
  useEffect(() => void reload(), [reload]);
  const now = Date.now();

  return (
    <section className="host">
      <HostHead />
      <div className="host-grid">
        <div>
          <div className="section-head" style={{ marginBottom: 14 }}>
            <h3>Your hunts</h3>
            <span className="tele">{hunts?.length ?? '…'} hosted</span>
          </div>
          {!hunts && <div className="skeleton-list" aria-busy="true"><div style={{ height: 120 }} /></div>}
          {hunts && !hunts.length && <p className="small">No hunts yet. Create the first one.</p>}
          <ul className="host-list">
            {hunts?.map(({ g }) => (
              <li key={g.id}>
                <a className="log-row compact tilt" href={`#/host/${g.id}`}>
                  <div className="log-when">
                    <span className="tele">{shortId(g.id, 4)}</span>
                    <strong>{statusLabel(g, now)}</strong>
                  </div>
                  <div className="log-what">
                    <span className="row" style={{ gap: 6, justifyContent: 'flex-start' }}>
                      <span className={`badge ${dealerBadge(g.dealerKind).tone}`}>{dealerBadge(g.dealerKind).text}</span>
                      <HuntTags g={g} />
                    </span>
                    <span className="small">{nextStep(g, now)}</span>
                  </div>
                  <span className="arrow" />
                </a>
              </li>
            ))}
          </ul>
          <Allowlists address={address} />
        </div>
        <CreateHunt address={address} onCreated={reload} />
      </div>
    </section>
  );
}

function nextStep(g: GameState, now: number): string {
  if (g.status === GameStatus.LOBBY) return g.prizesDeposited < g.relics ? `Deposit prize ${g.prizesDeposited + 1} of ${g.relics}` : 'Deal and open';
  if (g.status === GameStatus.OPEN && now < g.endsAt) return `Live · ${timeLeft(g.endsAt - now)} left · ${g.playerCount} yetis`;
  if (g.status === GameStatus.OPEN) return 'Ended: settle the hunt';
  if (g.status === GameStatus.CANCELLED) return g.prizesHeld ? 'Cancelled: reclaim prizes' : 'Cancelled';
  if (!g.thawBlob) return g.prizesHeld ? 'Reclaim unwon prizes, then publish the thaw' : 'Publish the thaw file';
  return 'Done';
}

function CreateHunt({ address, onCreated }: { address: string; onCreated: () => void }) {
  const { busy, msg, act } = useAction();
  const [well, setWell] = useState('');
  const [stake, setStake] = useState('0');
  const [players, setPlayers] = useState(64);
  const [hours, setHours] = useState(2);
  const [windowS, setWindowS] = useState(300);
  const [relics, setRelics] = useState(1);
  const [shares, setShares] = useState<number[]>([100]);
  const [blizzards, setBlizzards] = useState(false);
  const [everyMin, setEveryMin] = useState(30);
  const [lastsMin, setLastsMin] = useState(5);
  const [listId, setListId] = useState('');
  const [lists, setLists] = useState<AllowlistState[]>([]);
  useEffect(() => {
    void myAllowlistCaps(address).then((caps) => Promise.all(caps.map((c) => getAllowlist(suiClient, c.listId)))).then(setLists).catch(() => {});
  }, [address]);

  const pickRelics = (n: number) => {
    setRelics(n);
    setShares(n === 1 ? [100] : n === 2 ? [70, 30] : [60, 25, 15]);
  };
  const sum = shares.reduce((a, b) => a + b, 0);
  const lastsOk = !blizzards || (everyMin >= 10 && lastsMin >= 1 && lastsMin <= 15 && lastsMin * 3 <= everyMin);
  const valid = /^0x[0-9a-fA-F]{1,64}$/.test(well.trim()) && sum === 100 && lastsOk && hours >= 1 && hours <= 72;

  return (
    <form
      className="card create-hunt"
      onSubmit={(e) => {
        e.preventDefault();
        void act('create', async () => {
          const base = {
            entryStake: toMist(stake),
            maxPlayers: players,
            durationMs: hours * 3_600_000,
            resolveWindowMs: windowS * 1000,
            wellFund: well.trim(),
            host: address,
          };
          const ranked = relics > 1 || blizzards;
          const t = ranked
            ? tx.createRankedLobby(ctx, {
                ...base,
                relics,
                potShares: shares.map((p) => p * 100),
                blizzardEveryMs: blizzards ? everyMin * 60_000 : 0,
                blizzardMs: blizzards ? lastsMin * 60_000 : 0,
              })
            : tx.createLobby(ctx, base);
          const r = await runHost(t, address);
          const game = r.created.find((c) => c.type.includes('::game::Game<'));
          const cap = r.created.find((c) => c.type.endsWith('::game::HostCap'));
          if (!game || !cap) throw new Error('Created, but the new Game was not in the effects. Refresh.');
          if (listId) await runHost(tx.setAllowlist(ctx, { gameId: game.id, capId: cap.id, listId }), address);
          onCreated();
          location.hash = `#/host/${game.id}`;
        });
      }}
    >
      <span className="eyebrow">New hunt</span>
      <h2 style={{ margin: '8px 0 18px' }}>Draw a mountain</h2>
      <label className="field">
        <span>Well-fund address</span>
        <input value={well} onChange={(e) => setWell(e.target.value)} placeholder="0x… (Lofi well fund)" spellCheck={false} required />
        <small>Half of every frozen stake and any unclaimed pot is paid here, on-chain.</small>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Entry stake (SUI)</span>
          <input type="number" min="0" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} />
          <small>{stake === '0' || !Number(stake) ? 'Free entry: a ceremony deal is allowed.' : 'Staked hunts need an enclave deal.'}</small>
        </label>
        <label className="field">
          <span>Max yetis</span>
          <input type="number" min="1" max="128" value={players} onChange={(e) => setPlayers(Number(e.target.value))} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Length (hours)</span>
          <input type="number" min="1" max="72" value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Reveal window (s)</span>
          <input type="number" min="120" max="3600" value={windowS} onChange={(e) => setWindowS(Number(e.target.value))} />
        </label>
      </div>

      <div className="field">
        <span>Relics and prizes</span>
        <span className="seg">
          {[1, 2, 3].map((n) => (
            <button type="button" key={n} className={relics === n ? 'on' : ''} onClick={() => pickRelics(n)}>
              {n === 1 ? 'One relic' : `${n} ranked`}
            </button>
          ))}
        </span>
        {relics > 1 && (
          <div className="shares">
            {shares.map((p, i) => (
              <label key={i}>
                <i>{['1st', '2nd', '3rd'][i]}</i>
                <input type="number" min="0" max="100" value={p} onChange={(e) => setShares(shares.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
                <b>%</b>
              </label>
            ))}
            <small className={sum === 100 ? '' : 'warn'}>Pot split · {sum}%{sum !== 100 && ' (must be 100%)'}</small>
          </div>
        )}
      </div>

      <div className="field">
        <label className="check">
          <input type="checkbox" checked={blizzards} onChange={(e) => setBlizzards(e.target.checked)} />
          <span>Blizzards: drifts block {Blizzard.MAX_DRIFTS} random tiles for a while, then melt</span>
        </label>
        {blizzards && (
          <div className="field-row">
            <label className="field">
              <span>Every (min)</span>
              <input type="number" min="10" value={everyMin} onChange={(e) => setEveryMin(Number(e.target.value))} />
            </label>
            <label className="field">
              <span>Drifts last (min)</span>
              <input type="number" min="1" max="15" value={lastsMin} onChange={(e) => setLastsMin(Number(e.target.value))} />
              {!lastsOk && <small className="warn">1-15 min, at most a third of the interval.</small>}
            </label>
          </div>
        )}
      </div>

      <label className="field">
        <span>Holders only (optional)</span>
        <select value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">Anyone may join</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.size})
            </option>
          ))}
        </select>
      </label>

      <button className="primary big" disabled={!valid || !!busy}>{busy ? 'Creating…' : 'Create the lobby →'}</button>
      {msg && <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'}`}>{msg.text}</div>}
    </form>
  );
}

function Allowlists({ address }: { address: string }) {
  const { busy, msg, act } = useAction();
  const [lists, setLists] = useState<Array<{ capId: string; list: AllowlistState }>>([]);
  const [name, setName] = useState('');
  const [paste, setPaste] = useState<Record<string, string>>({});
  const reload = useCallback(async () => {
    const caps = await myAllowlistCaps(address);
    setLists(await Promise.all(caps.map(async (c) => ({ capId: c.capId, list: await getAllowlist(suiClient, c.listId) }))));
  }, [address]);
  useEffect(() => void reload().catch(() => {}), [reload]);

  return (
    <div className="card allowlists" style={{ marginTop: 24 }}>
      <span className="eyebrow">Holder allowlists</span>
      <p className="small" style={{ margin: '8px 0 14px' }}>
        Gate a hunt to Mystic Yeti or $LOFI holders: paste a snapshot of their addresses. Only you can edit your lists.
      </p>
      {lists.map(({ capId, list }) => (
        <div key={list.id} className="allowlist">
          <div className="row">
            <strong>{list.name}</strong>
            <span className="tele">{list.size} members</span>
          </div>
          <textarea
            rows={3}
            placeholder="0x… one address per line, or comma-separated"
            value={paste[list.id] ?? ''}
            onChange={(e) => setPaste({ ...paste, [list.id]: e.target.value })}
            spellCheck={false}
          />
          <div className="actions" style={{ margin: '8px 0 0' }}>
            {(['add', 'remove'] as const).map((verb) => (
              <button
                key={verb}
                disabled={!!busy || !(paste[list.id] ?? '').trim()}
                onClick={() =>
                  void act(verb, async () => {
                    const addrs = [...new Set((paste[list.id] ?? '').split(/[\s,]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{1,64}$/.test(a)))];
                    if (!addrs.length) throw new Error('No valid addresses.');
                    for (let i = 0; i < addrs.length; i += 4000) {
                      await runHost(tx.editAllowlist(ctx, { listId: list.id, capId, [verb]: addrs.slice(i, i + 4000) }), address);
                    }
                    setPaste({ ...paste, [list.id]: '' });
                    await reload();
                    return `${verb === 'add' ? 'Added' : 'Removed'} ${addrs.length} address${addrs.length === 1 ? '' : 'es'}.`;
                  })
                }
              >
                {verb === 'add' ? 'Add' : 'Remove'}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="New list, e.g. Mystic Yeti holders, Dec snapshot" />
        <button
          disabled={!name.trim() || !!busy}
          onClick={() =>
            void act('list', async () => {
              await runHost(tx.createAllowlist(ctx, { name: name.trim(), owner: address }), address);
              setName('');
              await reload();
              return 'Allowlist created.';
            })
          }
        >
          Create list
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'}`}>{msg.text}</div>}
    </div>
  );
}

// =====================================================================
// Manage one hunt
// =====================================================================

function Manage({ gameId, address }: { gameId: string; address: string }) {
  useTick(1000);
  const { busy, msg, setMsg, act } = useAction();
  const [g, setG] = useState<GameState | null>(null);
  const [trail, setTrail] = useState<Trail>(emptyTrail());
  const [capId, setCapId] = useState<string | null | undefined>(undefined);
  const [deal, setDeal] = useState<StoredDeal | null>(null);
  const [overdue, setOverdue] = useState<string[]>([]);
  const [progress, setProgress] = useState('');

  const reload = useCallback(async () => {
    const [game, page] = await Promise.all([getGame(suiClient, gameId), listGameEvents(suiClient, config.packageId, gameId)]);
    const t = applyEvents(emptyTrail(), page.events);
    setG(game);
    setTrail(t);
    if (game.status === GameStatus.OPEN) {
      const xs = await getExplorers(suiClient, [...t.explorers.keys()]).catch(() => []);
      setOverdue(xs.filter((x) => x.status === ExplorerStatus.ACTIVE && x.pending && Date.now() > x.pending.deadlineMs).map((x) => x.id));
    }
  }, [gameId]);
  useEffect(() => {
    void reload();
    void myHostCaps(address).then((caps) => setCapId(caps.find((c) => c.gameId === gameId)?.capId ?? null));
    void loadDeal(gameId).then((d) => setDeal(d ?? null));
    const t = setInterval(() => void reload(), 6000);
    return () => clearInterval(t);
  }, [reload, address, gameId]);

  if (!g || capId === undefined) return <div className="skeleton-grid" aria-busy="true" />;
  if (!capId) {
    return (
      <section className="host">
        <HostHead title="Not yours" />
        <p className="small">This wallet does not hold the host pass for this hunt. <a href={`#/hunt/${gameId}`}>Open it as a player →</a></p>
      </section>
    );
  }
  const now = Date.now();
  const live = g.status === GameStatus.OPEN && now < g.endsAt;
  const ended = isEnded(g, now);
  const run = (label: string, t: Parameters<typeof runHost>[0], done: string) =>
    act(label, async () => {
      await runHost(t, address);
      await reload();
      return done;
    });

  const steps: Array<{ title: string; done: boolean; active: boolean; body: React.ReactNode }> = [
    {
      title: `Prizes (${g.prizesDeposited}/${g.relics})`,
      done: g.prizesDeposited === g.relics,
      active: g.status === GameStatus.LOBBY && g.prizesDeposited < g.relics,
      body: <PrizeStep g={g} capId={capId} busy={busy} onRun={run} />,
    },
    {
      title: 'Deal',
      done: !!deal || g.status !== GameStatus.LOBBY,
      active: g.status === GameStatus.LOBBY && g.prizesDeposited === g.relics && !deal,
      body: (
        <DealStep
          g={g}
          busy={busy}
          progress={progress}
          onDeal={(how) =>
            act('deal', async () => {
              const d =
                how.kind === 'ceremony'
                  ? await ceremonyDealInBrowser(g.id, g.relics, g.durationMs, setProgress)
                  : await enclaveDealInBrowser(g.id, g.relics, how.url, how.enclaveId, g.durationMs, setProgress);
              setDeal(d);
              setProgress('');
              return 'Deal checked and uploaded. Open the hunt when you are ready: that starts the clock.';
            })
          }
        />
      ),
    },
    {
      title: 'Open',
      done: g.status !== GameStatus.LOBBY,
      active: g.status === GameStatus.LOBBY && !!deal,
      body: deal && g.status === GameStatus.LOBBY && (
        <div>
          <p className="small">Submits the sealed deal on-chain. The hunt opens and runs for {Math.round(g.durationMs / 3_600_000)} hours.</p>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => {
              const common = { gameId: g.id, capId, dealTs: BigInt(deal.dealTs), ctHash: fromHex(deal.ctHash), quiltId: deal.quiltId };
              const t =
                deal.kind === 'enclave'
                  ? tx.sealDealEnclave(ctx, { ...common, enclaveId: deal.enclaveId!, dealSig: fromHex(deal.dealSig) })
                  : tx.sealDealCeremony(ctx, { ...common, dealerPk: fromHex(deal.dealerPk) });
              void run('open', t, 'The hunt is open.');
            }}
          >
            Open the hunt now
          </button>
        </div>
      ),
    },
    {
      title: 'Live',
      done: ended,
      active: live,
      body: live && (
        <div className="live-ops">
          <Weather g={g} now={now} />
          <div className="actions">
            {blizzardDue(g, now) && (
              <button disabled={!!busy} onClick={() => void run('blizzard', tx.blizzard(ctx, { gameId: g.id }), 'A blizzard started.')}>
                Start the due blizzard
              </button>
            )}
            {overdue.map((id) => (
              <button key={id} disabled={!!busy} onClick={() => void run('freeze', tx.freezeOverdue(ctx, { gameId: g.id, explorerId: id }), 'Overdue yeti frozen.')}>
                Freeze overdue {shortId(id, 3)}
              </button>
            ))}
            <a className="btn" href={`#/hunt/${g.id}/spectate`}>Watch the trail</a>
          </div>
        </div>
      ),
    },
    {
      title: 'Settle',
      done: ended && g.status !== GameStatus.OPEN && g.prizesHeld === 0,
      active: (ended && (g.status === GameStatus.OPEN || g.prizesHeld > 0)) || (g.status === GameStatus.CANCELLED && g.prizesHeld > 0),
      body: (ended || g.status === GameStatus.CANCELLED) && (
        <div className="actions">
          {g.status === GameStatus.OPEN && (
            <button className="primary" disabled={!!busy} onClick={() => void run('finalize', tx.finalizeUnclaimed(ctx, { gameId: g.id }), 'Settled: the rest of the pot went to the well fund.')}>
              Settle the hunt
            </button>
          )}
          {g.status !== GameStatus.OPEN && g.prizesHeld > 0 && (
            <button
              disabled={!!busy}
              onClick={() => {
                const t = new Transaction();
                for (let rank = g.finders.length + g.prizesHeld; rank > g.finders.length; rank--) {
                  tx.reclaimPrize(ctx, { gameId: g.id, capId, prizeType: trail.prizeTypes.get(rank) ?? '', host: address }, t);
                }
                void run('reclaim', t, `${g.prizesHeld} unwon prize(s) are back in your wallet.`);
              }}
            >
              Reclaim {g.prizesHeld} unwon prize{g.prizesHeld === 1 ? '' : 's'}
            </button>
          )}
        </div>
      ),
    },
    {
      title: 'Thaw',
      done: !!g.thawBlob,
      active: ended && !g.thawBlob && g.status !== GameStatus.CANCELLED,
      body: ended && !g.thawBlob && g.status !== GameStatus.CANCELLED && (
        <div>
          <p className="small">Decrypts all 576 tiles, checks every signature, and publishes the thaw file for anyone to audit.</p>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() =>
              void act('thaw', async () => {
                const { blobId, relics } = await thawInBrowser(g, address, setProgress);
                await runHost(tx.publishThaw(ctx, { gameId: g.id, capId, blobId }), address);
                setProgress('');
                await reload();
                return `Thaw file published. Relics were at ${relics.map((r) => `(${r[0] + 1}, ${r[1] + 1})`).join(', ')}.`;
              })
            }
          >
            Thaw and publish
          </button>
          {progress && busy === 'thaw' && <p className="small mono">{progress}</p>}
        </div>
      ),
    },
  ];

  return (
    <section className="host">
      <div className="crumbs" style={{ marginBottom: 18 }}>
        <a href="#/host">← All your hunts</a>
        <span className="row" style={{ gap: 8 }}>
          <HuntTags g={g} />
          <a className="pill" href={`#/hunt/${g.id}`}>Player view ↗</a>
        </span>
      </div>
      <div className="manage-head">
        <div>
          <span className="tele ice">Hosting / {shortId(g.id, 4)}</span>
          <h1>{statusLabel(g, now)}</h1>
        </div>
        <dl className="log-nums">
          <div><dt>Stake</dt><dd>{g.entryStake ? amount(g.entryStake, g.coinType) : 'Free'}</dd></div>
          <div><dt>Pot</dt><dd>{amount(g.pot, g.coinType)}</dd></div>
          <div><dt>Yetis</dt><dd>{g.playerCount}/{g.maxPlayers}</dd></div>
          <div><dt>{live ? 'Left' : 'Ends'}</dt><dd>{live ? timeLeft(g.endsAt - now) : g.endsAt ? new Date(g.endsAt).toLocaleTimeString() : '—'}</dd></div>
        </dl>
      </div>
      <div className="host-grid">
        <ol className="stepper">
          {steps.map((s, i) => (
            <li key={s.title} className={`${s.done ? 'done' : ''} ${s.active ? 'active' : ''}`}>
              <span className="dot-n">{s.done ? '✓' : i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                {s.active || (s.title === 'Live' && live) ? s.body : null}
              </div>
            </li>
          ))}
        </ol>
        <aside className="side">
          <PrizeLadder g={g} />
          {g.status === GameStatus.LOBBY && (
            <div className="card">
              <span className="eyebrow">Change of plan</span>
              <p className="small">Cancel the lobby and take every prize back.</p>
              <button
                disabled={!!busy}
                onClick={() => {
                  const t = tx.cancel(ctx, { gameId: g.id, capId, prizeType: g.prizesHeld ? (trail.prizeTypes.get(g.prizesHeld) ?? null) : null, host: address });
                  for (let rank = g.prizesHeld - 1; rank >= 1; rank--) tx.reclaimPrize(ctx, { gameId: g.id, capId, prizeType: trail.prizeTypes.get(rank)!, host: address }, t);
                  void run('cancel', t, 'Cancelled. Your prizes are back.');
                }}
              >
                Cancel the lobby
              </button>
            </div>
          )}
        </aside>
      </div>
      {msg && (
        <div className={`notice ${msg.kind === 'error' ? 'error' : ''}`} role="status" onClick={() => setMsg(null)}>
          {msg.text}
        </div>
      )}
    </section>
  );
}

function PrizeStep({
  g,
  capId,
  busy,
  onRun,
}: {
  g: GameState;
  capId: string;
  busy: string | null;
  onRun: (label: string, t: Parameters<typeof runHost>[0], done: string) => Promise<void>;
}) {
  const [sui, setSui] = useState('0.1');
  const [objectId, setObjectId] = useState('');
  const rank = g.prizesDeposited + 1;
  return (
    <div className="prize-step">
      <p className="small">Prize {rank} of {g.relics} is held in escrow until someone claims rank {rank}, or comes back to you.</p>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-start' }}>
        <input type="number" min="0.001" step="0.01" value={sui} onChange={(e) => setSui(e.target.value)} style={{ width: 110 }} />
        <span className="small">SUI</span>
        <button className="primary" disabled={!!busy || !Number(sui)} onClick={() => void onRun('prize', depositSuiPrize(g.id, capId, toMist(sui), g.coinType), `Prize ${rank} is in escrow.`)}>
          Deposit as prize {rank}
        </button>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-start', marginTop: 10 }}>
        <input className="grow" value={objectId} onChange={(e) => setObjectId(e.target.value)} placeholder="…or any object you own (an NFT): 0x…" spellCheck={false} />
        <button
          disabled={!!busy || !/^0x[0-9a-fA-F]{1,64}$/.test(objectId.trim())}
          onClick={async () => {
            const { object } = await suiClient.core.getObject({ objectId: objectId.trim() });
            void onRun('prize', tx.depositPrize(ctx, { gameId: g.id, capId, prizeId: objectId.trim(), prizeType: object.type }), `Prize ${rank} is in escrow.`);
          }}
        >
          Deposit object
        </button>
      </div>
    </div>
  );
}

function DealStep({
  g,
  busy,
  progress,
  onDeal,
}: {
  g: GameState;
  busy: string | null;
  progress: string;
  onDeal: (how: { kind: 'ceremony' } | { kind: 'enclave'; url: string; enclaveId: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [enclaveId, setEnclaveId] = useState(config.dealerEnclaveId ?? '');
  const free = g.entryStake === 0n;
  return (
    <div className="deal-step">
      <div className="deal-options">
        <div className={`deal-option ${free ? '' : 'disabled'}`}>
          <strong>Ceremony, in this browser</strong>
          <p className="small">
            Draws and seals the map here. You could know the map, so the contract only allows this for free hunts and labels
            them host-dealt.
          </p>
          <button disabled={!free || !!busy} onClick={() => onDeal({ kind: 'ceremony' })}>
            {busy === 'deal' ? 'Dealing…' : 'Deal here'}
          </button>
        </div>
        <div className="deal-option">
          <strong>Attested enclave</strong>
          <p className="small">Nobody sees the map: the dealer enclave draws and seals it. Needed for staked hunts.</p>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Enclave URL, https://…" />
          <input value={enclaveId} onChange={(e) => setEnclaveId(e.target.value)} placeholder="Enclave object ID 0x…" style={{ marginTop: 6 }} />
          <button disabled={!url || !enclaveId || !!busy} onClick={() => onDeal({ kind: 'enclave', url, enclaveId })} style={{ marginTop: 8 }}>
            Request a deal
          </button>
        </div>
      </div>
      {progress && busy === 'deal' && <p className="small mono">{progress}</p>}
      <p className="small" style={{ marginTop: 8 }}>
        The deal is checked here (tile order, ciphertext hash, signature over {g.relics} relic{g.relics > 1 ? 's' : ''}, key servers) and kept on this device
        until you open the hunt.
      </p>
    </div>
  );
}
