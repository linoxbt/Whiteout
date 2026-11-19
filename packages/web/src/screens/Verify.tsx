/** Trust page (FR23): everything a sceptic needs to check, in one place. */
import { useEffect, useState } from 'react';
import {
  DealerKind,
  EnclaveBcs,
  EnclaveConfigBcs,
  checkCiphertexts,
  ciphertextServers,
  getGame,
  readAllTiles,
  toHex,
  type GameState,
} from '@whiteout/core';
import { config, suiClient } from '../config';
import { shortId } from '../lib/format';

interface Report {
  game: GameState;
  pcrs?: string[];
  enclavePk?: string;
  enclaveCurrent?: boolean;
  ctHash: 'checking' | 'ok' | 'mismatch' | 'error';
  servers?: { ids: string[]; threshold: number; pinned: boolean };
  immutable: 'yes' | 'no' | 'unknown';
}

export function Verify({ gameId }: { gameId: string }) {
  const [r, setR] = useState<Report | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    void (async () => {
      let game: GameState;
      try {
        game = await getGame(suiClient, gameId, config.packageId);
      } catch (e) {
        if (!stop) setError((e as Error).message);
        return;
      }
      const base: Report = { game, ctHash: 'checking', immutable: 'unknown' };
      if (game.enclaveId && config.enclaveConfigId) try {
        const [{ object: enc }, { object: cfg }] = await Promise.all([
          suiClient.core.getObject({ objectId: game.enclaveId, include: { content: true } }),
          suiClient.core.getObject({ objectId: config.enclaveConfigId, include: { content: true } }),
        ]);
        const e = EnclaveBcs.parse(enc.content);
        const c = EnclaveConfigBcs.parse(cfg.content);
        base.pcrs = c.pcrs.map((p) => toHex(Uint8Array.from(p)));
        base.enclavePk = toHex(Uint8Array.from(e.pk));
        // The enclave that dealt must be the one whose key signed the deal.
        base.enclaveCurrent = e.config_version === c.version && toHex(Uint8Array.from(e.pk)) === toHex(game.dealerPk);
      } catch {
        base.enclaveCurrent = false;
      }
      if (config.upgradeCapIds.length) {
        try {
          const { objects } = await suiClient.core.getObjects({ objectIds: config.upgradeCapIds });
          // Only a cap that no longer exists proves immutability; any other error is "unknown".
          const gone = (o: unknown) => o instanceof Error && /not.?found|deleted|does not exist|NotExists/i.test(o.message);
          base.immutable = objects.every(gone) ? 'yes' : objects.some((o) => !(o instanceof Error)) ? 'no' : 'unknown';
        } catch {
          base.immutable = 'unknown';
        }
      }
      if (!stop) setR(base);
      try {
        const cts = await readAllTiles(config.walrusAggregators, game.quiltId, (n) => !stop && setProgress(n));
        const s = ciphertextServers(cts[0]!);
        const pinned = new Set(config.sealServers.map((x) => x.objectId.toLowerCase()));
        if (!stop)
          setR({
            ...base,
            ctHash: checkCiphertexts(cts, game.ctHash) ? 'ok' : 'mismatch',
            servers: { ids: s.ids, threshold: s.threshold, pinned: s.ids.every((i) => pinned.has(i.toLowerCase())) },
          });
      } catch {
        if (!stop) setR({ ...base, ctHash: 'error' });
      }
    })();
    return () => {
      stop = true;
    };
  }, [gameId]);

  if (error) {
    return (
      <section className="card verify">
        <p><a href={`#/hunt/${gameId}`}>← Back to the hunt</a></p>
        <div className="banner error" role="alert">Could not read this hunt: {error.slice(0, 160)}</div>
      </section>
    );
  }
  if (!r) return <div className="skeleton-grid" aria-busy="true" />;
  const g = r.game;
  return (
    <section className="card verify">
      <p><a href={`#/hunt/${gameId}`}>← Back to the hunt</a></p>
      <h2>Verify this hunt</h2>
      <dl>
        <dt>Dealer</dt>
        <dd>
          {g.dealerKind === DealerKind.ENCLAVE && 'Attested Nautilus enclave (AWS Nitro). No human saw the map.'}
          {g.dealerKind === DealerKind.CEREMONY && <strong className="warn">Host-dealt. The host could know this map; entry is free.</strong>}
          {g.dealerKind === DealerKind.NONE && 'Not dealt yet.'}
        </dd>
        {g.enclaveId && (<><dt>Enclave object</dt><dd><code>{g.enclaveId}</code></dd></>)}
        {r.pcrs && (
          <>
            <dt>Expected PCRs</dt>
            <dd>
              {r.pcrs.map((p, i) => (<div key={i}><code>PCR{i} {p.slice(0, 24)}…</code></div>))}
              {config.dealerSourceUrl && <a href={config.dealerSourceUrl} target="_blank" rel="noreferrer">Rebuild from source</a>}
              {r.enclaveCurrent === false && <div className="warn">This enclave does not match the current PCRs or the key that signed the deal.</div>}
            </dd>
          </>
        )}
        <dt>Dealer key</dt>
        <dd><code>{shortId(toHex(g.dealerPk), 10)}</code></dd>
        <dt>Ciphertext hash</dt>
        <dd>
          {r.ctHash === 'checking' && `Downloading tiles… ${progress}/576`}
          {r.ctHash === 'ok' && 'Matches the hash the dealer signed. The host has not swapped any tile.'}
          {r.ctHash === 'mismatch' && <strong className="warn">MISMATCH. Do not join this hunt.</strong>}
          {r.ctHash === 'error' && 'Could not download the tiles.'}
        </dd>
        {r.servers && (
          <>
            <dt>Seal key servers</dt>
            <dd>
              {r.servers.threshold}-of-{r.servers.ids.length}: {r.servers.ids.map((i) => shortId(i)).join(', ')}{' '}
              {r.servers.pinned ? '(the configured servers)' : <strong className="warn">(unexpected servers)</strong>}
            </dd>
          </>
        )}
        <dt>Package</dt>
        <dd>
          <code>{shortId(config.packageId, 8)}</code> ·{' '}
          {r.immutable === 'yes' ? 'immutable' : r.immutable === 'no' ? <strong className="warn">upgradeable</strong> : 'immutability unknown (could not read the UpgradeCap)'}
        </dd>
        {g.thawBlob && (<><dt>Thaw file</dt><dd><code>{g.thawBlob}</code></dd></>)}
      </dl>
    </section>
  );
}
