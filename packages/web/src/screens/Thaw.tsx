/** End of the hunt (MD10, FR18-FR20): the full map, the finder, payouts, stake withdrawal. */
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useEffect, useState } from 'react';
import {
  ExplorerStatus,
  GameStatus,
  SessionKey,
  decryptTiles,
  findRelic,
  makeSealClient,
  readAllTiles,
  readBlob,
  sameId,
  tileIndex,
  verifyThaw,
} from '@whiteout/core';
import { Mountain } from '../components/Mountain';
import { config, suiClient } from '../config';
import { dAppKit } from '../dappkit';
import type { Hunt, HuntView } from '../lib/hunt';
import { amount, shortId } from '../lib/format';

export function Thaw({ hunt, v }: { hunt: Hunt; v: HuntView }) {
  const g = v.game!;
  const account = useCurrentAccount();
  const [map, setMap] = useState<Uint8Array | null>(null);
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
      const sessionKey = await SessionKey.create({ address: account.address, packageId: config.packageId, ttlMin: 30, suiClient });
      const { signature } = await dAppKit.signPersonalMessage({ message: sessionKey.getPersonalMessage() });
      await sessionKey.setPersonalMessageSignature(signature);
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
  const canWithdraw = me && me.status === ExplorerStatus.ACTIVE && !me.pending && hunt.ended;
  const unfinalized = g.status === GameStatus.OPEN;

  return (
    <section className="thaw">
      <h2>{g.finder ? 'The relic was found' : 'The mountain thaws'}</h2>
      <Mountain trail={v.trail} me={me} address={hunt.address} tiles={v.tiles} revealing={null} thaw={map} relic={relic} label="The whole map after the thaw" />
      <ul className="payouts">
        {g.finder ? (
          <li>
            Finder: <strong>{account && sameId(g.finder, account.address) ? 'you!' : shortId(g.finder)}</strong> took the prize and the pot.
          </li>
        ) : (
          <li>Nobody reached the relic. The pot goes to the Lofi well fund.</li>
        )}
        <li>Frozen stakes sent to the well fund: {amount(toWell, g.coinType)}</li>
        <li>{v.trail.explorers.size} yetis took part; {v.trail.frozenAt.length} froze.</li>
      </ul>
      {status && <p className="small" role="status">{status}</p>}
      {g.thawBlob && <p className="small">Thaw file: <code>{g.thawBlob}</code></p>}
      <div className="actions">
        {canWithdraw && <button className="primary" disabled={v.busy} onClick={() => void hunt.withdraw()}>Collect your stake</button>}
        {unfinalized && account && <button disabled={v.busy} onClick={() => void hunt.finalize()}>Settle the hunt</button>}
        {!map && account && <button onClick={() => void thawMyself()}>Thaw the map myself</button>}
      </div>
      {v.notice && <p className={`notice ${v.notice.kind}`}>{v.notice.text}</p>}
    </section>
  );
}
