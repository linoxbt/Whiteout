/**
 * The sponsor service: a thin proxy over Enoki's two-step sponsorship (spec section 12).
 *   POST /sponsor          { txKindBytes }  + header zklogin-jwt  -> { bytes, digest }
 *   POST /sponsor/:digest  { signature }                          -> { digest }
 * It never sees a player's key and cannot change a transaction: players sign the
 * sponsored bytes themselves.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { checkKind } from './policy.js';
import { GAME_TTL_SEC, PER_GAME_LIMIT, type QuotaStore } from './quota.js';

export interface Enoki {
  /** Resolves the zkLogin address for a JWT (Enoki GET /v1/zklogin). */
  address(jwt: string): Promise<string>;
  sponsor(p: { network: string; kindBytes: string; sender: string; jwt: string; targets: string[] }): Promise<{ bytes: string; digest: string }>;
  execute(digest: string, signature: string): Promise<{ digest: string }>;
}

export interface SponsorConfig {
  network: string;
  packageId: string;
  maxGasBudgetMist: bigint;
  perGameLimit?: number;
  allowedOrigins?: string[];
}

interface Issued {
  at: number;
  sender: string;
  result?: { digest: string };
}

export function makeApp(cfg: SponsorConfig, enoki: Enoki, quota: QuotaStore) {
  const app = new Hono();
  const issued = new Map<string, Issued>();
  const stats = { sponsored: 0, refused: 0, quotaHits: 0, enokiErrors: 0 };
  const limit = cfg.perGameLimit ?? PER_GAME_LIMIT;

  app.use('*', cors({ origin: cfg.allowedOrigins?.length ? cfg.allowedOrigins : '*' }));

  app.get('/health', (c) => c.json({ ok: true, network: cfg.network, packageId: cfg.packageId, ...stats }));

  app.post('/sponsor', async (c) => {
    const jwt = c.req.header('zklogin-jwt');
    if (!jwt) return c.json({ error: 'missing zklogin-jwt header' }, 400);
    let body: { txKindBytes?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'malformed body' }, 400);
    }
    if (!body.txKindBytes) return c.json({ error: 'missing txKindBytes' }, 400);

    let data;
    try {
      data = Transaction.fromKind(fromBase64(body.txKindBytes)).getData();
    } catch {
      return c.json({ error: 'could not decode the transaction kind' }, 400);
    }
    const verdict = checkKind(data, cfg.packageId);
    if (!verdict.ok) {
      stats.refused++;
      return c.json({ error: verdict.reason }, verdict.status);
    }

    let sender: string;
    try {
      sender = await enoki.address(jwt);
    } catch {
      return c.json({ error: 'invalid zkLogin token' }, 400);
    }
    const key = `wo:${sender}:${verdict.gameId ?? 'none'}`;
    const used = await quota.incr(key, GAME_TTL_SEC);
    if (used > limit) {
      stats.quotaHits++;
      return c.json({ error: `sponsorship quota reached (${limit} per hunt)` }, 429);
    }

    try {
      const res = await enoki.sponsor({
        network: cfg.network,
        kindBytes: body.txKindBytes,
        sender,
        jwt,
        targets: verdict.calls.map((f) => (f.startsWith('0x2::') ? f : `${cfg.packageId}::${f}`)),
      });
      issued.set(res.digest, { at: Date.now(), sender });
      pruneIssued(issued);
      stats.sponsored++;
      return c.json(res);
    } catch (e) {
      stats.enokiErrors++;
      return c.json({ error: `Enoki: ${(e as Error).message}` }, 502);
    }
  });

  app.post('/sponsor/:digest', async (c) => {
    const digest = c.req.param('digest');
    const entry = issued.get(digest);
    if (!entry || Date.now() - entry.at > 60_000) return c.json({ error: 'unknown or expired digest' }, 404);
    if (entry.result) return c.json(entry.result); // a repeated call returns the earlier result
    const { signature } = (await c.req.json().catch(() => ({}))) as { signature?: string };
    if (!signature) return c.json({ error: 'missing signature' }, 400);
    try {
      entry.result = await enoki.execute(digest, signature);
      return c.json(entry.result);
    } catch (e) {
      stats.enokiErrors++;
      return c.json({ error: `Enoki: ${(e as Error).message}` }, 502);
    }
  });

  return app;
}

function pruneIssued(m: Map<string, Issued>) {
  const cutoff = Date.now() - 120_000;
  for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
}

/** Enoki's HTTP API with the private key (spec section 12). */
export function enokiHttp(privateKey: string, base = 'https://api.enoki.mystenlabs.com/v1'): Enoki {
  async function call<T>(path: string, init: RequestInit, jwt?: string): Promise<T> {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${privateKey}`,
        'content-type': 'application/json',
        ...(jwt ? { 'zklogin-jwt': jwt } : {}),
      },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
    return (JSON.parse(text) as { data: T }).data;
  }
  return {
    address: async (jwt) => (await call<{ address: string }>('/zklogin', { method: 'GET' }, jwt)).address,
    sponsor: (p) =>
      call<{ bytes: string; digest: string }>(
        '/transaction-blocks/sponsor',
        {
          method: 'POST',
          body: JSON.stringify({
            network: p.network,
            transactionBlockKindBytes: p.kindBytes,
            sender: p.sender,
            allowedMoveCallTargets: p.targets,
          }),
        },
        p.jwt,
      ),
    execute: (digest, signature) =>
      call<{ digest: string }>(`/transaction-blocks/sponsor/${digest}`, { method: 'POST', body: JSON.stringify({ signature }) }),
  };
}
