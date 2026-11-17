/** Per-address, per-game sponsorship quota (review fix: 1 200 per address per game). */

export interface QuotaStore {
  /** Increments the counter and returns the new value; the key expires after ttlSec. */
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<number>;
}

export class MemoryStore implements QuotaStore {
  #m = new Map<string, { n: number; exp: number }>();
  async incr(key: string, ttlSec: number) {
    const now = Date.now();
    const cur = this.#m.get(key);
    const next = cur && cur.exp > now ? { n: cur.n + 1, exp: cur.exp } : { n: 1, exp: now + ttlSec * 1000 };
    this.#m.set(key, next);
    return next.n;
  }
  async get(key: string) {
    const cur = this.#m.get(key);
    return cur && cur.exp > Date.now() ? cur.n : 0;
  }
}

/** Upstash Redis over its REST API (spec section 17). */
export class UpstashStore implements QuotaStore {
  constructor(
    private url: string,
    private token: string,
  ) {}
  async #cmd(...args: (string | number)[]): Promise<unknown> {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    return ((await r.json()) as { result: unknown }).result;
  }
  async incr(key: string, ttlSec: number) {
    const n = Number(await this.#cmd('INCR', key));
    if (n === 1) await this.#cmd('EXPIRE', key, ttlSec);
    return n;
  }
  async get(key: string) {
    return Number((await this.#cmd('GET', key)) ?? 0);
  }
}

export const PER_GAME_LIMIT = 1_200;
/** Keys live 80 h: longer than the longest hunt (72 h). */
export const GAME_TTL_SEC = 80 * 3600;
