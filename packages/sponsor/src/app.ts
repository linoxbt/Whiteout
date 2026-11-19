/**
 * The sponsor service: a thin proxy over Enoki's two-step sponsorship (spec section 12).
 *   POST /sponsor          { txKindBytes }  + header zklogin-jwt  -> { bytes, digest }
 *   POST /sponsor/:digest  { signature }                          -> { digest }
 * It never sees a player's key and cannot change a transaction: players sign the
 * sponsored bytes themselves. All state (quotas, issued digests, counters) lives in the
 * shared store, so any instance can serve either step.
 *
 * HTTP status contract. Every error body is JSON `{ error: string, code: string, ... }`;
 * `error` is safe to show, raw upstream messages are only logged.
 *
 *   POST /sponsor
 *     200  { bytes, digest }
 *     400  malformed          bad JSON, missing/undecodable txKindBytes
 *     401  missing_jwt | invalid_jwt   no token, garbage, expired (local check) or refused by Enoki
 *     403  disallowed | not_a_game     policy refusal (call, gas coin, withdrawal, send_funds
 *                                      recipient) or the game argument is not a Game of PACKAGE_ID
 *     413  too_large          body over 64 KiB
 *     422  move_abort         Enoki's dry run aborted in Move; `abort` has code/module/function/
 *                             name/message/action. Do not retry.
 *     429  rate_limited       per-IP limit (before any Enoki call)        + Retry-After
 *     429  quota              600 per address in any rolling 24 h (AC23)  + Retry-After
 *     502  enoki_unavailable | rpc_unavailable | gas_cap | bad_sponsor_reply   upstream failure
 *                             (retryable, the client retries 502 up to 3 times)
 *     503  daily_budget       global DAILY_TX_BUDGET spent for this UTC day + Retry-After
 *     503  store_unavailable  Redis unreachable
 *   POST /sponsor/:digest
 *     200  { digest }         (a repeated call returns the earlier result)
 *     400  malformed          missing signature
 *     404  unknown_digest     not issued here, or older than 60 s
 *     409  in_progress        another call is executing this digest; retry
 *     422  move_abort         as above
 *     429  rate_limited
 *     502  enoki_unavailable
 *     503  store_unavailable
 *   POST /beacon   204 | 400 bad_beacon | 404 unknown_game | 429 rate_limited | 503
 *   GET /stats/:gameId   200 { key_fetch_error, reveal_ok } | 400 bad_game_id | 429 | 503
 *   GET /health    200 { ok: true, version } | 503 { ok: false, version } (store down)
 *   GET /metrics   200 counters (Bearer METRICS_TOKEN) | 401 | 404 when METRICS_TOKEN is unset
 *   anything else  404 not_found; unexpected errors 500 internal
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';
import { EnokiError, type Enoki, type MoveAbortDetails } from './enoki.js';
import { UpstreamError, type GameRegistry } from './games.js';
import { precheckJwt } from './jwt.js';
import { checkKind, checkRecipients } from './policy.js';
import { ADDRESS_DAILY_LIMIT, DAY_MS, DEFAULT_DAILY_TX_BUDGET, GAME_TTL_SEC, StoreError, type Store } from './quota.js';

export { enokiHttp, EnokiError, type Enoki } from './enoki.js';

export const VERSION = '0.2.0';

export interface SponsorConfig {
  network: string;
  packageId: string;
  /** 0.05 SUI (spec section 10). Sponsored bytes with a larger budget are refused (502). */
  maxGasBudgetMist: bigint;
  /** Exact origins, or '*' (dev only: env.ts refuses '*' and an empty list in production). */
  allowedOrigins: string[] | '*';
  addressDailyLimit?: number;
  dailyTxBudget?: number;
  /** Requests per minute per IP on /sponsor and /sponsor/:digest together. */
  ipRatePerMin?: number;
  /** Requests per minute per IP on /beacon and /stats together. */
  beaconRatePerMin?: number;
  /** Enables GET /metrics with this Bearer token. */
  metricsToken?: string;
  version?: string;
  /** Client IP for rate limits. Default: x-real-ip, then the first x-forwarded-for hop. */
  clientIp?: (c: Context) => string;
  now?: () => number;
  /** One JSON object per request. Default: console.log(JSON.stringify(line)). */
  log?: (line: Record<string, unknown>) => void;
}

export interface Deps {
  enoki: Enoki;
  store: Store;
  games: GameRegistry;
}

export const BEACON_EVENTS = new Set(['key_fetch_error', 'reveal_ok']);

/** What the store keeps per issued digest (60 s; 5 min once executed). */
interface Issued {
  sender: string;
  at: number;
  result?: { digest: string };
}

const ISSUED_TTL_SEC = 60;
const RESULT_TTL_SEC = 300;
const METRICS_TTL_SEC = 8 * 24 * 3600;
const MAX_BODY = 64 * 1024;

type Vars = {
  /** Monitoring counters for this request, flushed to the store in one call. */
  m: Record<string, number>;
  /** Extra fields for this request's log line. */
  log: Record<string, unknown>;
};
type C = Context<{ Variables: Vars }>;

export function headerIp(c: Context): string {
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || 'unknown';
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export function makeApp(cfg: SponsorConfig, deps: Deps) {
  const { enoki, store, games } = deps;
  const app = new Hono<{ Variables: Vars }>();
  const now = cfg.now ?? Date.now;
  const addressLimit = cfg.addressDailyLimit ?? ADDRESS_DAILY_LIMIT;
  const budget = cfg.dailyTxBudget ?? DEFAULT_DAILY_TX_BUDGET;
  const ipRate = cfg.ipRatePerMin ?? 120;
  const beaconRate = cfg.beaconRatePerMin ?? 30;
  const ipOf = cfg.clientIp ?? headerIp;
  const log = cfg.log ?? ((l) => console.log(JSON.stringify(l)));
  const version = cfg.version ?? VERSION;
  const pkg = normalizeSuiAddress(cfg.packageId);

  const count = (c: C, name: string, by = 1) => {
    const m = c.get('m');
    m[name] = (m[name] ?? 0) + by;
  };
  const fail = (c: C, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503, code: string, error: string, extra: Record<string, unknown> = {}) => {
    c.get('log').code = code;
    return c.json({ error, code, ...extra }, status);
  };
  /** Logs the raw upstream text (redacted, truncated), never returned to the client. */
  const logUpstream = (c: C, text: string) => {
    c.get('log').upstream = text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>').slice(0, 500);
  };
  async function timedEnoki<T>(c: C, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      const ms = Math.round(performance.now() - t0);
      const l = c.get('log');
      l.enokiMs = ((l.enokiMs as number | undefined) ?? 0) + ms;
      count(c, 'enoki_calls');
      count(c, 'enoki_ms_sum', ms);
      count(c, ms <= 250 ? 'enoki_ms_le250' : ms <= 1000 ? 'enoki_ms_le1000' : ms <= 2500 ? 'enoki_ms_le2500' : 'enoki_ms_gt2500');
    }
  }
  /** Fixed one-minute window per IP and bucket. */
  async function rateLimited(c: C, bucket: string, limit: number): Promise<Response | null> {
    const t = now();
    const n = await store.incr(`rl:${bucket}:${ipOf(c)}:${Math.floor(t / 60_000)}`, 61);
    if (n <= limit) return null;
    count(c, `rl_${bucket}`);
    c.header('Retry-After', String(60 - Math.floor((t % 60_000) / 1000)));
    return fail(c, 429, 'rate_limited', 'Too many requests, slow down.');
  }
  const enokiFailure = (c: C, e: unknown, what: string) => {
    if (e instanceof EnokiError) {
      logUpstream(c, e.detail);
      if (e.kind === 'move_abort' && e.abort) {
        count(c, 'move_aborts');
        return fail(c, 422, 'move_abort', e.abort.message, { abort: e.abort satisfies MoveAbortDetails });
      }
    } else {
      logUpstream(c, String((e as Error)?.message ?? e));
    }
    count(c, 'enoki_errors');
    return fail(c, 502, 'enoki_unavailable', `The gas service could not ${what}. Please retry.`);
  };

  // --- middleware ------------------------------------------------------------------

  app.use('*', async (c, next) => {
    const t0 = performance.now();
    c.set('m', {});
    c.set('log', {});
    await next();
    const status = c.res.status;
    const route = routeOf(c.req.method, c.req.path);
    const m = c.get('m');
    m.requests = (m.requests ?? 0) + 1;
    m[`route:${route}`] = (m[`route:${route}`] ?? 0) + 1;
    m[`status:${status}`] = (m[`status:${status}`] ?? 0) + 1;
    m[`s${Math.floor(status / 100)}xx`] = (m[`s${Math.floor(status / 100)}xx`] ?? 0) + 1;
    try {
      await store.hincr(`m:${day(now())}`, m, METRICS_TTL_SEC);
    } catch (e) {
      c.get('log').metricsError = (e as Error).message;
    }
    log({ t: new Date(now()).toISOString(), route, method: c.req.method, status, ms: Math.round(performance.now() - t0), ...c.get('log') });
  });

  if (cfg.allowedOrigins !== '*' && !cfg.allowedOrigins.length) throw new Error('allowedOrigins is empty');
  app.use(
    '*',
    cors({
      origin: cfg.allowedOrigins,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'zklogin-jwt', 'authorization'],
      maxAge: 600,
    }),
  );

  app.use(
    '*',
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'Request body too large.', code: 'too_large' }, 413) }),
  );

  app.onError((err, c) => {
    const l = (c as C).get('log') ?? {};
    if (err instanceof StoreError) {
      l.code = 'store_unavailable';
      l.storeError = err.message;
      return c.json({ error: 'The gas service is temporarily unavailable. Please retry.', code: 'store_unavailable' }, 503);
    }
    l.code = 'internal';
    l.error = String(err?.stack ?? err).slice(0, 500);
    return c.json({ error: 'Internal error.', code: 'internal' }, 500);
  });

  app.notFound((c) => c.json({ error: 'Not found.', code: 'not_found' }, 404));

  // --- routes ----------------------------------------------------------------------

  app.get('/health', async (c) => {
    try {
      await store.get('health');
      return c.json({ ok: true, version });
    } catch (e) {
      c.get('log').storeError = (e as Error).message;
      return c.json({ ok: false, version }, 503);
    }
  });

  app.get('/metrics', async (c) => {
    if (!cfg.metricsToken) return fail(c, 404, 'not_found', 'Not found.');
    const auth = c.req.header('authorization') ?? '';
    if (!safeEqual(auth, `Bearer ${cfg.metricsToken}`)) return fail(c, 401, 'unauthorized', 'Unauthorized.');
    const t = now();
    const [today, yesterday] = await Promise.all([store.hgetall(`m:${day(t)}`), store.hgetall(`m:${day(t - DAY_MS)}`)]);
    return c.json({ version, today: { day: day(t), ...today }, yesterday: { day: day(t - DAY_MS), ...yesterday } });
  });

  app.post('/sponsor', async (c) => {
    const limited = await rateLimited(c, 'sponsor', ipRate);
    if (limited) return limited;

    const jwt = c.req.header('zklogin-jwt');
    if (!jwt) return fail(c, 401, 'missing_jwt', 'Log in again: the zklogin-jwt header is missing.');
    const pre = precheckJwt(jwt, now() / 1000);
    if (!pre.ok) {
      c.get('log').reason = pre.reason;
      return fail(c, 401, 'invalid_jwt', 'Your login has expired or is invalid. Please log in again.');
    }

    let body: { txKindBytes?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'malformed', 'Malformed request body.');
    }
    if (typeof body?.txKindBytes !== 'string' || !body.txKindBytes) return fail(c, 400, 'malformed', 'Missing txKindBytes.');
    const kindBytes = body.txKindBytes;

    let data;
    try {
      data = Transaction.fromKind(fromBase64(kindBytes)).getData();
    } catch {
      return fail(c, 400, 'malformed', 'Could not decode the transaction kind.');
    }
    const first = checkKind(data, cfg.packageId);
    if (!first.ok) {
      count(c, 'refused');
      c.get('log').reason = first.reason;
      return fail(c, first.status, 'disallowed', first.reason);
    }

    try {
      if (!(await games.isGame(first.gameId))) {
        count(c, 'refused');
        return fail(c, 403, 'not_a_game', 'That object is not a Whiteout hunt.');
      }
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      count(c, 'rpc_errors');
      logUpstream(c, e.message);
      return fail(c, 502, 'rpc_unavailable', 'Could not reach the Sui network. Please retry.');
    }

    let sender: string;
    try {
      sender = normalizeSuiAddress(await timedEnoki(c, () => enoki.address(jwt)));
    } catch (e) {
      if (e instanceof EnokiError && e.kind === 'invalid_jwt') {
        logUpstream(c, e.detail);
        return fail(c, 401, 'invalid_jwt', 'Your login has expired or is invalid. Please log in again.');
      }
      return enokiFailure(c, e, 'check your login');
    }
    c.get('log').sender = short(sender);

    const verdict = checkRecipients(first, sender);
    if (!verdict.ok) {
      count(c, 'refused');
      c.get('log').reason = verdict.reason;
      return fail(c, verdict.status, 'disallowed', verdict.reason);
    }

    // Quota: reserve first (so concurrent requests cannot overshoot), refund if Enoki fails.
    const t = now();
    const qKey = `q:addr:${sender}`;
    const member = `${t}:${Math.random().toString(36).slice(2, 10)}`;
    const q = await store.windowAdd(qKey, member, t, DAY_MS, addressLimit);
    if (!q.ok) {
      count(c, 'rl_address');
      c.header('Retry-After', String(Math.max(1, Math.ceil((q.oldestMs + DAY_MS - t) / 1000))));
      return fail(c, 429, 'quota', `Sponsorship quota reached (${addressLimit} transactions per 24 h).`);
    }
    const gKey = `q:day:${day(t)}`;
    let gUsed: number;
    try {
      gUsed = await store.incr(gKey, 2 * 24 * 3600);
    } catch (e) {
      await store.windowRemove(qKey, member).catch(() => {});
      throw e;
    }
    const refund = async (global = true) => {
      await Promise.all([store.windowRemove(qKey, member), global ? store.incr(gKey, 2 * 24 * 3600, -1) : null]).catch((e) => {
        c.get('log').refundError = (e as Error).message;
      });
    };
    if (gUsed > budget) {
      await refund();
      count(c, 'rl_budget');
      const midnight = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate() + 1);
      c.header('Retry-After', String(Math.ceil((midnight - t) / 1000)));
      return fail(c, 503, 'daily_budget', 'Free gas is used up for today. Try again later or play with a wallet.');
    }

    let res: { bytes: string; digest: string };
    try {
      res = await timedEnoki(c, () =>
        enoki.sponsor({
          network: cfg.network,
          kindBytes,
          sender,
          jwt,
          targets: [...new Set(verdict.calls.map((f) => (f.startsWith('0x2::') ? f : `${pkg}::${f}`)))],
        }),
      );
    } catch (e) {
      await refund();
      return enokiFailure(c, e, 'sponsor this move');
    }

    // Enforce the gas cap and sanity-check Enoki's reply before we let anyone execute it.
    const problem = inspectSponsored(res, sender, cfg.maxGasBudgetMist);
    if (problem) {
      await refund();
      count(c, 'enoki_errors');
      c.get('log').reason = problem.reason;
      return fail(c, 502, problem.code, 'The gas service returned an unusable transaction. Please retry.');
    }

    try {
      const rec: Issued = { sender, at: t };
      await store.set(`dg:${res.digest}`, JSON.stringify(rec), ISSUED_TTL_SEC);
    } catch (e) {
      await refund();
      throw e;
    }
    count(c, 'sponsored');
    return c.json({ bytes: res.bytes, digest: res.digest });
  });

  app.post('/sponsor/:digest', async (c) => {
    const limited = await rateLimited(c, 'sponsor', ipRate);
    if (limited) return limited;
    const digest = c.req.param('digest');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(digest)) return fail(c, 404, 'unknown_digest', 'Unknown or expired transaction.');
    const key = `dg:${digest}`;
    const read = async () => {
      const raw = await store.get(key);
      return raw ? (JSON.parse(raw) as Issued) : null;
    };
    const rec = await read();
    if (!rec || (!rec.result && now() - rec.at > ISSUED_TTL_SEC * 1000)) {
      return fail(c, 404, 'unknown_digest', 'Unknown or expired transaction.');
    }
    if (rec.result) return c.json(rec.result); // a repeated call returns the earlier result
    c.get('log').sender = short(rec.sender);

    const b = (await c.req.json().catch(() => ({}))) as { signature?: unknown };
    if (typeof b?.signature !== 'string' || !b.signature || b.signature.length > 4096) {
      return fail(c, 400, 'malformed', 'Missing signature.');
    }
    const signature = b.signature;

    const lockKey = `${key}:lock`;
    if (!(await store.set(lockKey, '1', 30, { nx: true }))) {
      const again = await read();
      if (again?.result) return c.json(again.result);
      return fail(c, 409, 'in_progress', 'This transaction is already being executed. Retry in a moment.');
    }
    let result: { digest: string };
    try {
      result = await timedEnoki(c, () => enoki.execute(digest, signature));
    } catch (e) {
      await store.del(lockKey).catch(() => {});
      return enokiFailure(c, e, 'execute this move');
    }
    count(c, 'executed');
    try {
      await store.set(key, JSON.stringify({ ...rec, result } satisfies Issued), RESULT_TTL_SEC);
    } catch (e) {
      // The transaction went through; do not turn that into an error for the player.
      c.get('log').storeError = (e as Error).message;
    }
    return c.json(result);
  });

  /**
   * Anonymous client counters (spec section 7, Monitoring): which hunt and what
   * happened, never who. Used by `whiteout status --watch` for the key-fetch error rate.
   * Only real games of this package can get counters, so the key space stays bounded.
   */
  app.post('/beacon', async (c) => {
    const limited = await rateLimited(c, 'beacon', beaconRate);
    if (limited) return limited;
    const b = (await c.req.json().catch(() => ({}))) as { gameId?: unknown; event?: unknown };
    const gameId = typeof b?.gameId === 'string' ? gameIdOf(b.gameId) : null;
    if (!gameId || typeof b.event !== 'string' || !BEACON_EVENTS.has(b.event)) {
      return fail(c, 400, 'bad_beacon', 'Bad beacon.');
    }
    let known: boolean;
    try {
      known = await games.isGame(gameId);
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      logUpstream(c, e.message);
      return fail(c, 503, 'rpc_unavailable', 'Try again later.');
    }
    if (!known) return fail(c, 404, 'unknown_game', 'Unknown hunt.');
    await store.incr(`beacon:${gameId}:${b.event}`, GAME_TTL_SEC);
    count(c, `beacon:${b.event}`);
    return c.body(null, 204);
  });

  app.get('/stats/:gameId', async (c) => {
    const limited = await rateLimited(c, 'beacon', beaconRate);
    if (limited) return limited;
    const id = gameIdOf(c.req.param('gameId'));
    if (!id) return fail(c, 400, 'bad_game_id', 'Bad game id.');
    const counts = Object.fromEntries(
      await Promise.all([...BEACON_EVENTS].map(async (e) => [e, Number((await store.get(`beacon:${id}:${e}`)) ?? 0)] as const)),
    );
    return c.json(counts);
  });

  return app;
}

function gameIdOf(raw: string): string | null {
  return /^0x[0-9a-fA-F]{1,64}$/.test(raw) ? normalizeSuiAddress(raw) : null;
}

function routeOf(method: string, path: string): string {
  if (path === '/sponsor') return 'sponsor';
  if (path.startsWith('/sponsor/')) return 'execute';
  if (path === '/beacon') return 'beacon';
  if (path.startsWith('/stats/')) return 'stats';
  if (path === '/health') return 'health';
  if (path === '/metrics') return 'metrics';
  return method === 'OPTIONS' ? 'preflight' : 'other';
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Parses Enoki's sponsored TransactionData: the gas budget cap, the sender and the digest. */
export function inspectSponsored(
  res: { bytes?: unknown; digest?: unknown },
  sender: string,
  maxGasBudgetMist: bigint,
): { code: 'gas_cap' | 'bad_sponsor_reply'; reason: string } | null {
  if (typeof res?.bytes !== 'string' || typeof res.digest !== 'string') return { code: 'bad_sponsor_reply', reason: 'no bytes or digest' };
  let raw: Uint8Array;
  let data: TransactionDataBuilder;
  try {
    raw = fromBase64(res.bytes);
    data = TransactionDataBuilder.fromBytes(raw);
  } catch {
    return { code: 'bad_sponsor_reply', reason: 'undecodable bytes' };
  }
  const budget = data.gasData.budget;
  if (budget === null || budget === undefined) return { code: 'gas_cap', reason: 'no gas budget' };
  if (BigInt(budget) > maxGasBudgetMist) return { code: 'gas_cap', reason: `gas budget ${budget} > ${maxGasBudgetMist}` };
  if (!data.sender || normalizeSuiAddress(data.sender) !== normalizeSuiAddress(sender)) {
    return { code: 'bad_sponsor_reply', reason: 'sender mismatch' };
  }
  if (TransactionDataBuilder.getDigestFromBytes(raw) !== res.digest) return { code: 'bad_sponsor_reply', reason: 'digest mismatch' };
  return null;
}
