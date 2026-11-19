import { describe, expect, it } from 'vitest';
import { enokiHttp, parseMoveAbort, EnokiError } from '../src/enoki.js';
import { EnvError, loadEnv } from '../src/env.js';
import { CachedGameRegistry, UpstreamError } from '../src/games.js';
import { precheckJwt } from '../src/jwt.js';
import { MemoryStore, StoreError, UpstashStore } from '../src/quota.js';
import { GAME, PKG, fakeEnoki, fakeGames, fakeJwt } from './helpers.js';

describe('JWT pre-check', () => {
  const now = 1_800_000_000;
  it('accepts a well-formed unexpired token', () => {
    expect(precheckJwt(fakeJwt({}, now), now)).toMatchObject({ ok: true, iss: 'https://accounts.google.com' });
    expect(precheckJwt(fakeJwt({ aud: ['a', 'b'] }, now), now).ok).toBe(true);
  });
  it.each([
    ['garbage', 'hello'],
    ['two parts', 'a.b'],
    ['bad json', 'e30.bm9wZQ.c2ln'],
    ['expired', fakeJwt({ exp: now - 1 }, now)],
    ['no exp', fakeJwt({ exp: undefined }, now)],
    ['no iss', fakeJwt({ iss: undefined }, now)],
    ['no sub', fakeJwt({ sub: '' }, now)],
    ['no aud', fakeJwt({ aud: [] }, now)],
    ['future nbf', fakeJwt({ nbf: now + 3600 }, now)],
    ['too long', 'a'.repeat(9000) + '.b.c'],
  ])('refuses %s', (_n, jwt) => {
    expect(precheckJwt(jwt, now).ok).toBe(false);
  });
  it('refuses alg none', () => {
    const [, p] = fakeJwt({}, now).split('.');
    const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(precheckJwt(`${h}.${p}.x`, now).ok).toBe(false);
  });
});

describe('Upstash store', () => {
  function fakeUpstash(reply: (body: unknown, url: string) => unknown, status = 200) {
    const calls: { url: string; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return new Response(JSON.stringify(reply(body, url)), { status });
    }) as unknown as typeof fetch;
    return { calls, store: new UpstashStore('https://x.upstash.io/', 'tok', { fetch: f }) };
  }

  it('increments and sets the TTL in one atomic EVAL', async () => {
    const { calls, store } = fakeUpstash(() => ({ result: 1 }));
    expect(await store.incr('k', 60)).toBe(1);
    expect(calls).toHaveLength(1);
    const [cmd, script, nkeys, key, by, ttl] = calls[0]!.body as unknown[];
    expect([cmd, nkeys, key, by, ttl]).toEqual(['EVAL', 1, 'k', 1, 60]);
    expect(script).toMatch(/INCRBY[\s\S]*TTL[\s\S]*EXPIRE/);
    expect(calls[0]!.url).toBe('https://x.upstash.io');
  });

  it('runs the rolling window as one EVAL and parses its reply', async () => {
    const { calls, store } = fakeUpstash(() => ({ result: [0, 600, 1234] }));
    expect(await store.windowAdd('q', 'm', 5000, 1000, 600)).toEqual({ ok: false, count: 600, oldestMs: 1234 });
    expect((calls[0]!.body as unknown[])[0]).toBe('EVAL');
  });

  it('writes counters through one pipeline', async () => {
    const { calls, store } = fakeUpstash(() => [{ result: 1 }, { result: 2 }, { result: 1 }]);
    await store.hincr('m', { a: 1, b: 2 }, 99);
    expect(calls).toEqual([{ url: 'https://x.upstash.io/pipeline', body: [['HINCRBY', 'm', 'a', 1], ['HINCRBY', 'm', 'b', 2], ['EXPIRE', 'm', 99]] }]);
  });

  it('throws StoreError on HTTP errors, Redis errors and network failures', async () => {
    await expect(fakeUpstash(() => ({}), 500).store.get('k')).rejects.toBeInstanceOf(StoreError);
    await expect(fakeUpstash(() => ({ error: 'WRONGTYPE' })).store.get('k')).rejects.toBeInstanceOf(StoreError);
    const down = new UpstashStore('https://x', 't', { fetch: (async () => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch });
    await expect(down.incr('k', 1)).rejects.toBeInstanceOf(StoreError);
  });

  it('SET NX reports whether it set the key', async () => {
    expect(await fakeUpstash(() => ({ result: 'OK' })).store.set('k', 'v', 5, { nx: true })).toBe(true);
    expect(await fakeUpstash(() => ({ result: null })).store.set('k', 'v', 5, { nx: true })).toBe(false);
  });
});

describe('memory store', () => {
  it('expires keys and keeps a rolling window', async () => {
    const clock = { t: 0 };
    const s = new MemoryStore(() => clock.t);
    expect(await s.incr('a', 10)).toBe(1);
    expect(await s.incr('a', 10)).toBe(2);
    clock.t = 10_001;
    expect(await s.incr('a', 10)).toBe(1);
    expect((await s.windowAdd('w', 'x', 0, 100, 1)).ok).toBe(true);
    expect((await s.windowAdd('w', 'y', 50, 100, 1)).ok).toBe(false);
    expect((await s.windowAdd('w', 'z', 101, 100, 1)).ok).toBe(true);
  });
});

describe('game registry', () => {
  it('accepts only Game<T> of the package, caches, and reports outages', async () => {
    let calls = 0;
    const types: Record<string, string | null> = {
      [GAME]: `0x${'0'.repeat(8)}${'7'.repeat(56)}::game::Game<0x2::sui::SUI>`, // other package
    };
    const r = new CachedGameRegistry(async (id) => {
      calls++;
      if (id === '0x' + '9'.repeat(64)) throw new Error('down');
      return types[id] ?? `${PKG}::game::Game<0x2::sui::SUI>`;
    }, PKG);
    expect(await r.isGame(GAME)).toBe(false);
    expect(await r.isGame('0x' + '1'.repeat(64))).toBe(true);
    expect(await r.isGame('0x' + '1'.repeat(64))).toBe(true);
    expect(calls).toBe(2);
    await expect(r.isGame('0x' + '9'.repeat(64))).rejects.toBeInstanceOf(UpstreamError);
    const explorer = new CachedGameRegistry(async () => `${PKG}::game::Explorer<0x2::sui::SUI>`, PKG);
    expect(await explorer.isGame(GAME)).toBe(false);
    const missing = new CachedGameRegistry(async () => null, PKG);
    expect(await missing.isGame(GAME)).toBe(false);
  });
});

describe('Enoki client', () => {
  const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const enoki = (f: typeof fetch) => enokiHttp('key', { packageId: PKG, fetch: f });

  it('maps a refused token to invalid_jwt and an outage or key problem to upstream', async () => {
    await expect(enoki(reply(400, '{"errors":[{"message":"Invalid JWT"}]}')).address('j')).rejects.toMatchObject({ kind: 'invalid_jwt' });
    await expect(enoki(reply(401, 'expired token')).address('j')).rejects.toMatchObject({ kind: 'invalid_jwt' });
    await expect(enoki(reply(503, 'unavailable')).address('j')).rejects.toMatchObject({ kind: 'upstream' });
    await expect(enoki(reply(429, 'slow down')).address('j')).rejects.toMatchObject({ kind: 'upstream' });
    await expect(enoki(reply(401, 'Invalid API key')).address('j')).rejects.toMatchObject({ kind: 'upstream' });
    const down = (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(enoki(down).address('j')).rejects.toBeInstanceOf(EnokiError);
  });

  it('turns a dry-run Move abort into move_abort with details', async () => {
    const text = `{"errors":[{"message":"Dry run failed: MoveAbort(MoveLocation { module: ModuleId { address: ${'7'.repeat(64)}, name: Identifier(\\"game\\") }, function: 3, instruction: 9, function_name: Some(\\"join\\") }, 7) in command 1"}]}`;
    const e = await enoki(reply(400, text))
      .sponsor({ network: 'testnet', kindBytes: 'AA', sender: '0x1', jwt: 'j', targets: [] })
      .catch((x) => x as EnokiError);
    expect(e).toMatchObject({ kind: 'move_abort', abort: { code: 7, module: 'game', function: 'join', name: 'EFull', whiteout: true } });
    await expect(enoki(reply(500, 'boom')).execute('d', 's')).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('parses framework aborts without claiming they are Whiteout ones', () => {
    const a = parseMoveAbort('MoveAbort(MoveLocation { module: ModuleId { address: 0000000000000000000000000000000000000000000000000000000000000002, name: Identifier("balance") }, function: 6, instruction: 10, function_name: Some("split") }, 2) in command 0', PKG);
    expect(a).toMatchObject({ code: 2, module: 'balance', function: 'split', whiteout: false });
    expect(a!.message).toMatch(/balance::split/);
    expect(parseMoveAbort('InsufficientGas', PKG)).toBeNull();
  });
});

describe('environment loader', () => {
  const base = { PACKAGE_ID: PKG, ENOKI_PRIVATE_KEY: 'enoki_private_x', REDIS_URL: 'https://r.upstash.io', REDIS_TOKEN: 't', ALLOWED_ORIGINS: 'https://whiteout.example' };
  const problems = (env: Record<string, string | undefined>, runtime: 'node' | 'vercel' = 'node') => {
    try {
      loadEnv(env, runtime, { deps: { enoki: fakeEnoki(), games: fakeGames() } });
      return [];
    } catch (e) {
      if (!(e instanceof EnvError)) throw e;
      return e.problems;
    }
  };

  it('loads a complete production environment', () => {
    const l = loadEnv(base, 'vercel');
    expect(l.memoryStore).toBe(false);
    expect(l.trustProxy).toBe(true);
    expect(l.config.allowedOrigins).toEqual(['https://whiteout.example']);
    expect(l.config.maxGasBudgetMist).toBe(50_000_000n);
  });

  it('fails fast on a missing package id or Enoki key', () => {
    expect(problems({ ...base, PACKAGE_ID: undefined, ENOKI_PRIVATE_KEY: '' })).toEqual([
      'PACKAGE_ID is required',
      'ENOKI_PRIVATE_KEY is required',
    ]);
    expect(problems({ ...base, PACKAGE_ID: 'nope' })).toEqual(['PACKAGE_ID is not a Sui address']);
  });

  it('requires Redis unless ALLOW_MEMORY_STORE=1, and never on a production deployment', () => {
    expect(problems({ ...base, REDIS_URL: undefined, REDIS_TOKEN: undefined })[0]).toMatch(/REDIS_URL and REDIS_TOKEN are required/);
    expect(problems({ ...base, REDIS_TOKEN: undefined })[0]).toMatch(/together/);
    expect(problems({ ...base, REDIS_URL: 'redis://x:6379' })[0]).toMatch(/REST URL/);
    expect(problems({ ...base, REDIS_URL: undefined, REDIS_TOKEN: undefined, ALLOW_MEMORY_STORE: '1' })).toEqual([]);
    expect(problems({ ...base, REDIS_URL: undefined, REDIS_TOKEN: undefined, ALLOW_MEMORY_STORE: '1', VERCEL_ENV: 'production' }, 'vercel')[0]).toMatch(
      /ALLOW_MEMORY_STORE/,
    );
  });

  it('refuses to start without explicit CORS origins in production', () => {
    expect(problems({ ...base, ALLOWED_ORIGINS: undefined })[0]).toMatch(/ALLOWED_ORIGINS is required/);
    expect(problems({ ...base, ALLOWED_ORIGINS: '*' })[0]).toMatch(/may not contain "\*"/);
    expect(problems({ ...base, ALLOWED_ORIGINS: 'whiteout.example' })[0]).toMatch(/not an origin/);
    const dev = loadEnv({ ...base, REDIS_URL: undefined, REDIS_TOKEN: undefined, ALLOWED_ORIGINS: undefined, ALLOW_MEMORY_STORE: '1' }, 'node');
    expect(dev.config.allowedOrigins).toBe('*');
    expect(dev.memoryStore).toBe(true);
  });

  it('validates numeric limits and the metrics token', () => {
    expect(problems({ ...base, DAILY_TX_BUDGET: '-3' })[0]).toMatch(/DAILY_TX_BUDGET/);
    expect(problems({ ...base, METRICS_TOKEN: 'short' })[0]).toMatch(/METRICS_TOKEN/);
    expect(loadEnv({ ...base, DAILY_TX_BUDGET: '500' }, 'node').config.dailyTxBudget).toBe(500);
  });
});
