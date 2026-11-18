/** End of the hunt (MD10, FR18-FR20): the full map, the finder, payouts, stake withdrawal. */
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useEffect, useState } from 'react';
import {
  ExplorerStatus,
  GameStatus,
  decryptTiles,
  findRelic,
  findRelics,
  makeSealClient,
  readAllTiles,
  readBlob,
  sameId,
  tileIndex,
  verifyThaw,
} from '@whiteout/core';
import { Legend, Mountain } from '../components/Mountain';
import { PrizeLadder } from '../components/Phase2';
import { config, suiClient } from '../config';
import { createSession, loadSession } from '../lib/session';
import type { Hunt, HuntView } from '../lib/hunt';
import { amount, shortId } from '../lib/format';

export function Thaw({ hunt, v }: { hunt: Hunt; v: HuntView }) {
  const g = v.game!;
  const account = useCurrentAccount();
  const [map, setMap] = useState<Uint8Array | null>(v.thawMap ?? null);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    if (!g.thawBlob || map) return;
    setStatus('Loading the thaw file…');
    readBlob(config.walrusAggregators, g.thawBlob)
      .then((bytes) => {
        const check = verifyThaw(JSON.parse(new TextDecoder().decode(bytes)), g.id, g.dealerPk, g.dealTs);
        if (check.ok) {
          setMap(check.map!);
          setStatus('Thaw file verified: every tile carries the dealer\'s signature.');
        } else setStatus(`The thaw file failed verification: ${check.problems.slice(0, 3).join('; ')}`);
      })
      .catch((e) => setStatus(`Could not load the thaw file: ${(e as Error).message}`));
  }, [g, map]);

  /** Anyone can thaw the map themselves once the hunt has ended. */
  async function thawMyself() {
    if (!account) return;
    try {
      setStatus('Downloading 576 tiles…');
      const cts = await readAllTiles(config.walrusAggregators, g.quiltId);
      const sessionKey = (await loadSession(account.address)) ?? (await createSession(account.address));
      const seal = makeSealClient(suiClient, config);
      const kinds = new Uint8Array(576);
      for (let i = 0; i < 576; i += 48) {
        const batch = cts.slice(i, i + 48).map((ct, j) => ({ x: (i + j) % 24, y: Math.floor((i + j) / 24), ct }));
        const res = await decryptTiles({
          seal, suiClient, ctx: hunt.ctx, gameId: g.id, dealerPk: g.dealerPk, dealTs: g.dealTs,
          threshold: config.sealThreshold, sessionKey, tiles: batch,
        });
        for (const r of res) {
          if (!r.verified) throw new Error(`tile (${r.tile.x}, ${r.tile.y}) failed verification`);
          kinds[tileIndex(r.tile.x, r.tile.y)] = r.tile.kind;
        }
        setStatus(`Thawing… ${Math.min(576, i + 48)}/576`);
      }
      setMap(kinds);
      setStatus('You thawed and verified the whole map yourself.');
    } catch (e) {
      setStatus(`Thaw failed: ${(e as Error).message}`);
    }
  }

  const me = v.me;
  const toWell = v.trail.frozenAt.reduce((n, f) => n + f.toWell, 0n);
  const relic = map ? findRelic(map) : null;
  const relics = map ? findRelics(map) : null;
  const canWithdraw = me && me.status === ExplorerStatus.ACTIVE && !me.pending && hunt.ended;
  const unfinalized = g.status === GameStatus.OPEN;

  return (
    <section className="play-layout thaw">
      <div>
        <Mountain trail={v.trail} me={me} address={hunt.address} tiles={v.tiles} revealing={null} thaw={map} relic={relic} relics={relics} claimed={g.claimed} label="The whole map after the thaw" />
        <Legend />
      </div>
      <aside className="side">
        <div className={`card result ${g.finder ? 'found' : ''}`}>
          <span className="eyebrow">{g.finder ? 'Relic found' : 'Hunt over'}</span>
          <h2 style={{ marginTop: 10 }}>
            {g.relics > 1 && g.finders.length ? `${g.finders.length} of ${g.relics} relics found` : g.finder ? 'The relic was found' : 'The mountain thaws'}
          </h2>
          <p className="small" style={{ margin: '10px 0 0' }}>
            {g.relics > 1 ? (
              g.finders.length < g.relics ? (
                `${g.relics - g.finders.length} relic(s) stayed frozen: the rest of the pot went to the Lofi well fund, and the host takes back the unwon prizes.`
              ) : (
                'Every relic was claimed. Each finder took a prize, a share of the pot and their stake.'
              )
            ) : g.finder ? (
              <>
                <strong>{account && sameId(g.finder, account.address) ? 'You' : shortId(g.finder)}</strong> reached it first and took the prize, the pot and
                their stake.
              </>
            ) : (
              'Nobody reached the relic. The pot goes to the Lofi well fund.'
            )}
          </p>
        </div>
        <PrizeLadder g={g} me={account?.address} compact />
        <div className="items" aria-label="Results">
          <div>
            <div className="stat-label">Yetis</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>{v.trail.explorers.size}</div>
          </div>
          <div>
            <div className="stat-label">Frozen</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>{v.trail.frozenAt.length}</div>
          </div>
          <div>
            <div className="stat-label">To wells</div>
            <div className="stat-value" style={{ fontSize: '1rem' }}>{amount(toWell, g.coinType).split(' ')[0]}</div>
          </div>
        </div>
        <div className="card">
          <span className="eyebrow">The thaw</span>
          <p className="small" role="status" style={{ margin: '10px 0 0' }}>
            {status || (map ? 'The whole map is open. Every tile can be checked against the dealer signature.' : 'Waiting for the thaw file.')}
          </p>
          {g.thawBlob && <p className="small" style={{ margin: '8px 0 0' }}>File <code>{shortId(g.thawBlob, 8)}</code></p>}
          <div className="actions" style={{ marginBottom: 0 }}>
            {canWithdraw && <button className="primary" disabled={v.busy} onClick={() => void hunt.withdraw()}>Collect your stake</button>}
            {unfinalized && account && <button disabled={v.busy} onClick={() => void hunt.finalize()}>Settle the hunt</button>}
            {!map && account && <button onClick={() => void thawMyself()}>Thaw the map myself</button>}
            <a className="btn arrow" href={`#/hunt/${g.id}/verify`}>Verify</a>
          </div>
        </div>
      </aside>
      {v.notice && <p className={`notice ${v.notice.kind}`}>{v.notice.text}</p>}
    </section>
  );
}
