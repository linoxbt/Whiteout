/**
 * The only state the sponsor keeps (spec section 7: "stateless except counters"):
 * quota windows, rate-limit counters, issued digests (60 s) and monitoring counters.
 * Production uses Upstash Redis over its REST API; the in-memory store is for dev and
 * tests only and must be opted into with ALLOW_MEMORY_STORE=1 (see env.ts).
 */

/** A store call failed (network, HTTP or Redis error). The app answers 503. */
export class StoreError extends Error {
  override name = 'StoreError';
}

export interface Store {
  /** Atomically adds `by` (default 1) and returns the new value; the key gets ttlSec if it has no TTL yet. */
  incr(key: string, ttlSec: number, by?: number): Promise<number>;
  get(key: string): Promise<string | null>;
  /** Sets the key with a TTL. With nx, only when absent; returns whether it was set. */
  set(key: string, value: string, ttlSec: number, opts?: { nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /**
   * Rolling-window log: atomically drops entries older than windowMs and adds `member`
   * at nowMs if fewer than `limit` entries remain. Returns the count after the call and,
   * when refused, the time of the oldest entry (so the caller can say when to retry).
   */
  windowAdd(key: string, member: string, nowMs: number, windowMs: number, limit: number): Promise<{ ok: boolean; count: number; oldestMs: number }>;
  windowRemove(key: string, member: string): Promise<void>;
  /** Adds to several hash fields at once (monitoring counters) and refreshes the TTL. */
  hincr(key: string, fields: Record<string, number>, ttlSec: number): Promise<void>;
  hgetall(key: string): Promise<Record<string, number>>;
}

/** @deprecated name kept for older imports. */
export type QuotaStore = Store;

type Entry =
  | { kind: 'str'; v: string; exp: number }
  | { kind: 'zset'; v: Map<string, number>; exp: number }
  | { kind: 'hash'; v: Map<string, number>; exp: number };

/** In-process store for dev and tests. Two app instances can share one to simulate a shared Redis. */
export class MemoryStore implements Store {
  #m = new Map<string, Entry>();
  #ops = 0;
  constructor(private now: () => number = Date.now) {}

  #live(key: string): Entry | undefined {
    const e = this.#m.get(key);
    if (e && e.exp <= this.now()) {
      this.#m.delete(key);
      return undefined;
    }
    return e;
  }
  #sweep() {
    if (++this.#ops % 1000) return;
    const now = this.now();
    for (const [k, e] of this.#m) if (e.exp <= now) this.#m.delete(k);
  }

  async incr(key: string, ttlSec: number, by = 1) {
    this.#sweep();
    const e = this.#live(key);
    const n = (e?.kind === 'str' ? Number(e.v) : 0) + by;
    this.#m.set(key, { kind: 'str', v: String(n), exp: e?.exp ?? this.now() + ttlSec * 1000 });
    return n;
  }
  async get(key: string) {
    const e = this.#live(key);
    return e?.kind === 'str' ? e.v : null;
  }
  async set(key: string, value: string, ttlSec: number, opts: { nx?: boolean } = {}) {
    this.#sweep();
    if (opts.nx && this.#live(key)) return false;
    this.#m.set(key, { kind: 'str', v: value, exp: this.now() + ttlSec * 1000 });
    return true;
  }
  async del(key: string) {
    this.#m.delete(key);
  }
  async windowAdd(key: string, member: string, nowMs: number, windowMs: number, limit: number) {
    this.#sweep();
    const e = this.#live(key);
    const z = e?.kind === 'zset' ? e.v : new Map<string, number>();
    for (const [m, at] of z) if (at <= nowMs - windowMs) z.delete(m);
    if (z.size >= limit) return { ok: false, count: z.size, oldestMs: Math.min(...z.values()) };
    z.set(member, nowMs);
    this.#m.set(key, { kind: 'zset', v: z, exp: this.now() + windowMs });
    return { ok: true, count: z.size, oldestMs: 0 };
  }
  async windowRemove(key: string, member: string) {
    const e = this.#live(key);
    if (e?.kind === 'zset') e.v.delete(member);
  }
  async hincr(key: string, fields: Record<string, number>, ttlSec: number) {
    const e = this.#live(key);
    const h = e?.kind === 'hash' ? e.v : new Map<string, number>();
    for (const [f, n] of Object.entries(fields)) h.set(f, (h.get(f) ?? 0) + n);
    this.#m.set(key, { kind: 'hash', v: h, exp: this.now() + ttlSec * 1000 });
  }
  async hgetall(key: string) {
    const e = this.#live(key);
    return e?.kind === 'hash' ? Object.fromEntries(e.v) : {};
  }
}

/** INCRBY and EXPIRE in one atomic step (a plain INCR then EXPIRE can leave a key without TTL). */
const INCR_LUA = `local n = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return n`;

const WINDOW_LUA = `local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local n = redis.call('ZCARD', key)
if n >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, n, tonumber(oldest[2]) or now}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, n + 1, 0}`;

/** Upstash Redis over its REST API (spec section 17). Every failure throws StoreError. */
export class UpstashStore implements Store {
  constructor(
    private url: string,
    private token: string,
    private opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.url = url.replace(/\/+$/, '');
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let r: Response;
    try {
      r = await (this.opts.fetch ?? fetch)(`${this.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
    } catch (e) {
      throw new StoreError(`redis unreachable: ${(e as Error).message}`);
    }
    if (!r.ok) throw new StoreError(`redis HTTP ${r.status}`);
    try {
      return await r.json();
    } catch {
      throw new StoreError('redis sent a malformed reply');
    }
  }
  async #cmd(...args: (string | number)[]): Promise<unknown> {
    const res = (await this.#post('', args)) as { result?: unknown; error?: string };
    if (res.error) throw new StoreError(`redis: ${res.error}`);
    return res.result;
  }
  async #pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    const res = (await this.#post('/pipeline', cmds)) as { result?: unknown; error?: string }[];
    if (!Array.isArray(res)) throw new StoreError('redis sent a malformed pipeline reply');
    const err = res.find((x) => x.error);
    if (err) throw new StoreError(`redis: ${err.error}`);
    return res.map((x) => x.result);
  }

  async incr(key: string, ttlSec: number, by = 1) {
    return Number(await this.#cmd('EVAL', INCR_LUA, 1, key, by, ttlSec));
  }
  async get(key: string) {
    const v = await this.#cmd('GET', key);
    return v == null ? null : String(v);
  }
  async set(key: string, value: string, ttlSec: number, opts: { nx?: boolean } = {}) {
    const r = await this.#cmd('SET', key, value, 'EX', ttlSec, ...(opts.nx ? ['NX'] : []));
    return r === 'OK';
  }
  async del(key: string) {
    await this.#cmd('DEL', key);
  }
  async windowAdd(key: string, member: string, nowMs: number, windowMs: number, limit: number) {
    const r = (await this.#cmd('EVAL', WINDOW_LUA, 1, key, nowMs, windowMs, limit, member)) as number[];
    return { ok: Number(r[0]) === 1, count: Number(r[1]), oldestMs: Number(r[2]) };
  }
  async windowRemove(key: string, member: string) {
    await this.#cmd('ZREM', key, member);
  }
  async hincr(key: string, fields: Record<string, number>, ttlSec: number) {
    const cmds: (string | number)[][] = Object.entries(fields).map(([f, n]) => ['HINCRBY', key, f, n]);
    if (!cmds.length) return;
    cmds.push(['EXPIRE', key, ttlSec]);
    await this.#pipeline(cmds);
  }
  async hgetall(key: string) {
    const flat = ((await this.#cmd('HGETALL', key)) as string[] | null) ?? [];
    const out: Record<string, number> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = Number(flat[i + 1]);
    return out;
  }
}

/** At most 600 sponsored transactions per address in any rolling 24 h (spec section 10, AC23). */
export const ADDRESS_DAILY_LIMIT = 600;
export const DAY_MS = 24 * 3600 * 1000;
/** Default global budget of sponsored transactions per UTC day (env DAILY_TX_BUDGET). */
export const DEFAULT_DAILY_TX_BUDGET = 20_000;
/** Beacon counters live 80 h: longer than the longest hunt (72 h). */
export const GAME_TTL_SEC = 80 * 3600;
