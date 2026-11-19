import { Inputs, Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';
import { tx } from '@whiteout/core';
import { EnokiError, parseMoveAbort } from '../src/enoki.js';
import { checkKind, checkRecipients } from '../src/policy.js';
import { MemoryStore, StoreError, type Store } from '../src/quota.js';
import { makeApp } from '../src/app.js';
import {
  DIG, EXPLORER, GAME, OTHER, PKG, SENDER, COIN, ctx, fakeEnoki, fakeGames, fakeJwt, joinKind, setup, sponsoredBytes, stepKindB64,
} from './helpers.js';

const data = (t: Transaction) => t.getData();
const ok = (t: Transaction | ReturnType<Transaction['getData']>, sender = SENDER) => {
  const v = checkKind(t instanceof Transaction ? data(t) : t, PKG);
  return v.ok ? checkRecipients(v, sender) : v;
};

describe('sponsorship policy', () => {
  it('allows a step, a resolve, and a resolve + step batch', () => {
    expect(checkKind(data(tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 })), PKG)).toMatchObject({ ok: true, gameId: GAME });
    const t = tx.resolveTile(ctx, {
      gameId: GAME, explorerId: EXPLORER, kind: 0, kindSig: new Uint8Array(64), ropes: 0, huntLive: true, prizeType: null,
    });
    tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 1 }, t);
    expect(checkKind(data(t), PKG)).toMatchObject({ ok: true, calls: ['game::resolve', 'game::step'] });
  });

  it('sponsors Phase 2 calls: a gated join and a blizzard', () => {
    expect(checkKind(data(tx.join(ctx, { gameId: GAME, stake: 0n, column: 4, allowlistId: '0x' + '7'.repeat(64) })), PKG).ok).toBe(true);
    expect(checkKind(data(tx.blizzard(ctx, { gameId: GAME })), PKG).ok).toBe(true);
  });

  it('allows a zero-stake join (coin::zero)', () => {
    expect(checkKind(data(tx.join(ctx, { gameId: GAME, stake: 0n, column: 4 })), PKG).ok).toBe(true);
  });

  it('refuses a call outside the Whiteout package (AC23)', () => {
    const t = new Transaction();
    t.moveCall({ target: '0x' + '9'.repeat(64) + '::evil::drain', arguments: [] });
    tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 }, t);
    expect(checkKind(data(t), PKG)).toMatchObject({ ok: false, status: 403 });
  });

  it('allows finalize_unclaimed (anyone may call it) but refuses the host-only publish_thaw', () => {
    expect(checkKind(data(tx.finalizeUnclaimed(ctx, { gameId: GAME })), PKG).ok).toBe(true);
    const t = tx.publishThaw(ctx, { gameId: GAME, capId: OTHER, blobId: 'x' });
    expect(checkKind(data(t), PKG).ok).toBe(false);
  });

  it('refuses anything that touches the gas coin', () => {
    const t = new Transaction();
    const [c] = t.splitCoins(t.gas, [1000]);
    t.moveCall({
      target: `${PKG}::game::join`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [t.object(GAME), c!, t.pure.u8(1), t.object.clock()],
    });
    expect(checkKind(data(t), PKG)).toMatchObject({ ok: false, reason: expect.stringMatching(/gas coin/) });
  });

  it('refuses a coin built with the gas coin allowed', () => {
    const t = new Transaction();
    t.add(coinWithBalance({ balance: 5n, useGasCoin: true }));
    // An unresolved intent is not a sponsored command either way.
    expect(checkKind(data(t), PKG).ok).toBe(false);
  });

  it('refuses a funds withdrawal from the sponsor or from an allowance', () => {
    const d = data(tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 }));
    const withdrawal = (withdrawFrom: unknown) =>
      ({ ...d, inputs: [...d.inputs, { $kind: 'FundsWithdrawal', FundsWithdrawal: { withdrawFrom } }] }) as unknown as typeof d;
    expect(checkKind(withdrawal({ $kind: 'Sponsor', Sponsor: true }), PKG)).toMatchObject({ ok: false, reason: expect.stringMatching(/sender/) });
    expect(checkKind(withdrawal({ $kind: 'SenderAllowance', SenderAllowance: { funder: OTHER, allowance: OTHER } }), PKG).ok).toBe(false);
    expect(checkKind(withdrawal({ $kind: 'Sender', Sender: true }), PKG).ok).toBe(true);
  });

  it('refuses transfers', () => {
    const t = tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 });
    t.transferObjects([t.object(OTHER)], '0x1');
    expect(checkKind(data(t), PKG).ok).toBe(false);
  });

  it('refuses calls touching two games', () => {
    const t = tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 });
    tx.step(ctx, { gameId: OTHER, explorerId: EXPLORER, dir: 0 }, t);
    expect(checkKind(data(t), PKG).ok).toBe(false);
  });

  it('refuses a Whiteout call whose first argument is not an object', () => {
    const t = new Transaction();
    t.moveCall({ target: `${PKG}::game::blizzard`, typeArguments: ['0x2::sui::SUI'], arguments: [t.pure.u8(1)] });
    expect(checkKind(data(t), PKG)).toMatchObject({ ok: false, reason: expect.stringMatching(/game object/) });
  });

  describe('real join transactions (what tx.join emits through coinWithBalance)', () => {
    const join = () => tx.join(ctx, { gameId: GAME, stake: 100n, column: 1 });
    const fns = (bytes: Uint8Array) =>
      Transaction.fromKind(bytes)
        .getData()
        .commands.map((c) => (c.MoveCall ? `${c.MoveCall.module}::${c.MoveCall.function}` : c.$kind));

    it.each([
      ['address balance only', { addressBalance: 1000n }, ['coin::redeem_funds', 'SplitCoins', 'coin::send_funds', 'game::join']],
      ['owned coins, surplus', { coinBalance: 1000n }, ['SplitCoins', 'game::join']],
      ['owned coins, exact', { coinBalance: 100n }, ['SplitCoins', 'coin::destroy_zero', 'game::join']],
      ['coins + address balance', { coinBalance: 50n, addressBalance: 50n }, ['coin::redeem_funds', 'MergeCoins', 'SplitCoins', 'coin::send_funds', 'game::join']],
    ])('accepts a join funded from %s', async (_name, balances, expected) => {
      const kind = await joinKind(join(), balances);
      expect(fns(kind)).toEqual(expected);
      expect(ok(Transaction.fromKind(kind).getData())).toMatchObject({ ok: true, gameId: GAME });
    });

    it('refuses the same join when send_funds pays anyone but the sender', async () => {
      const kind = await joinKind(join(), { addressBalance: 1000n });
      // Accepted for its real sender, refused for any other one (the change would leave the sender).
      expect(ok(Transaction.fromKind(kind).getData(), OTHER)).toMatchObject({ ok: false, reason: expect.stringMatching(/send_funds/) });
    });

    it('refuses a crafted coin::send_funds to another address', () => {
      const t = new Transaction();
      const coin = t.object(Inputs.ObjectRef({ objectId: COIN, version: '3', digest: DIG }));
      const [stake] = t.splitCoins(coin, [100]);
      t.moveCall({ target: '0x2::coin::send_funds', typeArguments: ['0x2::sui::SUI'], arguments: [coin, t.pure.address(OTHER)] });
      t.moveCall({ target: `${PKG}::game::join`, typeArguments: ['0x2::sui::SUI'], arguments: [t.object(GAME), stake!, t.pure.u8(1), t.object.clock()] });
      expect(checkKind(data(t), PKG).ok).toBe(true); // structurally fine...
      expect(ok(t)).toMatchObject({ ok: false, status: 403 }); // ...but not to someone else
    });

    it('refuses balance conversions the stake never needs', () => {
      for (const fn of ['0x2::balance::redeem_funds', '0x2::coin::into_balance', '0x2::coin::from_balance']) {
        const t = tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 });
        t.moveCall({ target: fn, typeArguments: ['0x2::sui::SUI'], arguments: [t.object(COIN)] });
        expect(checkKind(data(t), PKG).ok).toBe(false);
      }
    });
  });
});

// --- HTTP ---------------------------------------------------------------------------

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('sponsor HTTP API', () => {
  it('sponsors and executes a step', async () => {
    const { post, enoki } = setup();
    const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
    expect(r.status).toBe(200);
    const { digest } = (await r.json()) as { digest: string };
    const x = await post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null });
    expect(await x.json()).toEqual({ digest });
    // A repeated execute returns the earlier result without calling Enoki again.
    await post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null });
    expect(enoki.executed).toBe(1);
  });

  it('sponsors a real join funded from the address balance, and refuses one that sends change elsewhere', async () => {
    const { post } = setup();
    const good = await joinKind(tx.join(ctx, { gameId: GAME, stake: 100n, column: 1 }), { addressBalance: 1000n });
    // Enoki would sponsor the kind bytes; our fake builds full bytes from them, which needs resolved inputs.
    expect((await post('/sponsor', { txKindBytes: toBase64(good) })).status).toBe(200);

    const t = new Transaction();
    const coin = t.object(Inputs.ObjectRef({ objectId: COIN, version: '3', digest: DIG }));
    const [stake] = t.splitCoins(coin, [100]);
    t.moveCall({ target: '0x2::coin::send_funds', typeArguments: ['0x2::sui::SUI'], arguments: [coin, t.pure.address(OTHER)] });
    t.moveCall({
      target: `${PKG}::game::join`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [t.object(Inputs.SharedObjectRef({ objectId: GAME, initialSharedVersion: 5, mutable: true })), stake!, t.pure.u8(1),
        t.object(Inputs.SharedObjectRef({ objectId: '0x6', initialSharedVersion: 1, mutable: false }))],
    });
    const bad = await post('/sponsor', { txKindBytes: toBase64(await t.build({ onlyTransactionKind: true })) });
    expect(bad.status).toBe(403);
    expect(await json(bad)).toMatchObject({ code: 'disallowed' });
  });

  it('AC23: the 601st sponsored transaction in 24 h is refused, whatever the game', async () => {
    const { post, clock, enoki } = setup();
    const kinds = [await stepKindB64(GAME), await stepKindB64(OTHER)];
    for (let i = 0; i < 600; i++) {
      const r = await post('/sponsor', { txKindBytes: kinds[i % 2] });
      expect(r.status).toBe(200);
      clock.t += 60_000; // spread over 10 h
    }
    for (const k of kinds) {
      const r = await post('/sponsor', { txKindBytes: k });
      expect(r.status).toBe(429);
      expect(await json(r)).toMatchObject({ code: 'quota' });
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(enoki.sponsored).toBe(600);
    // Rolling window: once the first sponsorship is 24 h old, one more fits.
    clock.t = Date.parse('2026-11-19T12:00:00Z') + 24 * 3600_000 + 1;
    expect((await post('/sponsor', { txKindBytes: kinds[0] })).status).toBe(200);
    expect((await post('/sponsor', { txKindBytes: kinds[0] })).status).toBe(429);
  });

  it('does not overshoot the quota under concurrent requests', async () => {
    const { post } = setup({ addressDailyLimit: 3 });
    const kind = await stepKindB64();
    const statuses = await Promise.all(Array.from({ length: 6 }, async () => (await post('/sponsor', { txKindBytes: kind })).status));
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  it('refuses bodies over 64 KiB with 413', async () => {
    const { post } = setup();
    const r = await post('/sponsor', { txKindBytes: 'A'.repeat(70_000) });
    expect(r.status).toBe(413);
    expect(await json(r)).toMatchObject({ code: 'too_large' });
  });

  it('enforces the global daily budget (503) without charging the address', async () => {
    const { post, clock } = setup({ dailyTxBudget: 2, addressDailyLimit: 3 });
    const kind = await stepKindB64();
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
    const r = await post('/sponsor', { txKindBytes: kind });
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ code: 'daily_budget' });
    // Next UTC day: the refused attempt did not use the address's third slot.
    clock.t = Date.parse('2026-11-20T00:00:01Z');
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
  });

  it('rate-limits per IP before any Enoki or full-node call', async () => {
    const { post, enoki, games } = setup({ ipRatePerMin: 2 });
    const kind = await stepKindB64();
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
    const r = await post('/sponsor', { txKindBytes: kind });
    expect(r.status).toBe(429);
    expect(await json(r)).toMatchObject({ code: 'rate_limited' });
    expect(enoki.addressCalls).toBe(2);
    expect(games.lookups).toBe(2);
    // Another IP has its own bucket.
    expect((await post('/sponsor', { txKindBytes: kind }, { ip: '198.51.100.1' })).status).toBe(200);
  });

  it('rejects malformed input with 400 and a missing, garbage or expired token with 401, without calling Enoki', async () => {
    const { post, enoki, clock } = setup();
    const kind = await stepKindB64();
    expect((await post('/sponsor', { txKindBytes: 'not base64!!' })).status).toBe(400);
    expect((await post('/sponsor', '{nope')).status).toBe(400);
    expect((await post('/sponsor', {})).status).toBe(400);
    for (const jwt of [null, 'garbage', 'a.b.c', fakeJwt({ exp: clock.t / 1000 - 1 }, clock.t / 1000), fakeJwt({ aud: undefined }, clock.t / 1000)]) {
      const r = await post('/sponsor', { txKindBytes: kind }, { jwt });
      expect(r.status).toBe(401);
    }
    expect(enoki.addressCalls).toBe(0);
    expect((await post('/sponsor/nope', { signature: 's' }, { jwt: null })).status).toBe(404);
    expect((await post(`/sponsor/${DIG}`, { signature: 's' }, { jwt: null })).status).toBe(404);
  });

  it('refuses a first argument that is not a Game of this package, without calling Enoki', async () => {
    const { post, enoki } = setup({ deps: { games: fakeGames([OTHER]) } });
    const r = await post('/sponsor', { txKindBytes: await stepKindB64(GAME) });
    expect(r.status).toBe(403);
    expect(await json(r)).toMatchObject({ code: 'not_a_game' });
    expect(enoki.addressCalls).toBe(0);
  });

  describe('error mapping', () => {
    it('Enoki refusing the token is 401; Enoki down during the address lookup is 502', async () => {
      const { post, enoki } = setup();
      const kind = await stepKindB64();
      enoki.addressError = new EnokiError('invalid_jwt', 400, 'Invalid JWT');
      expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(401);
      enoki.addressError = new EnokiError('upstream', 503, 'Service Unavailable');
      const r = await post('/sponsor', { txKindBytes: kind });
      expect(r.status).toBe(502);
      expect(await json(r)).toMatchObject({ code: 'enoki_unavailable' });
    });

    it('a full node outage is 502', async () => {
      const games = fakeGames();
      games.down = true;
      const { post } = setup({ deps: { games } });
      const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
      expect(r.status).toBe(502);
      expect(await json(r)).toMatchObject({ code: 'rpc_unavailable' });
    });

    it('a Move abort in the dry run is 422 with the abort details, and does not use quota', async () => {
      const { post, enoki } = setup({ addressDailyLimit: 1 });
      const text =
        '{"errors":[{"code":"dry_run_failed","message":"Dry run failed: MoveAbort(MoveLocation { module: ModuleId { address: ' +
        '7'.repeat(64) +
        ', name: Identifier(\\"game\\") }, function: 12, instruction: 40, function_name: Some(\\"step\\") }, 10) in command 0"}]}';
      enoki.sponsorError = new EnokiError('move_abort', 400, text, parseMoveAbort(text, PKG)!);
      const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
      expect(r.status).toBe(422);
      expect(await json(r)).toMatchObject({
        code: 'move_abort',
        error: 'Catch your breath: 8 seconds between steps.',
        abort: { code: 10, module: 'game', function: 'step', name: 'ECooldown', action: 'wait', whiteout: true },
      });
      enoki.sponsorError = null;
      expect((await post('/sponsor', { txKindBytes: await stepKindB64() })).status).toBe(200);
    });

    it('an Enoki failure is 502, does not echo Enoki, is logged, and is refunded', async () => {
      const { post, enoki, logs } = setup({ addressDailyLimit: 1, dailyTxBudget: 1 });
      enoki.sponsorError = new EnokiError('upstream', 500, 'internal: secret pool 0xdeadbeef exhausted');
      const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
      expect(r.status).toBe(502);
      const body = JSON.stringify(await r.json());
      expect(body).not.toMatch(/secret pool|deadbeef/);
      expect(logs.at(-1)).toMatchObject({ route: 'sponsor', status: 502, code: 'enoki_unavailable', upstream: expect.stringMatching(/secret pool/) });
      enoki.sponsorError = null;
      expect((await post('/sponsor', { txKindBytes: await stepKindB64() })).status).toBe(200);
    });

    it('store errors are 503 JSON, never an unhandled 500', async () => {
      const broken = new Proxy(new MemoryStore(), {
        get: () => async () => {
          throw new StoreError('redis unreachable');
        },
      }) as Store;
      const { post, app } = setup({ store: broken });
      const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
      expect(r.status).toBe(503);
      expect(await json(r)).toMatchObject({ code: 'store_unavailable' });
      expect((await post(`/sponsor/${DIG}`, { signature: 's' }, { jwt: null })).status).toBe(503);
      expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' })).status).toBe(503);
      const h = await app.request('/health');
      expect(h.status).toBe(503);
      expect(await h.json()).toMatchObject({ ok: false });
    });

    it('an Enoki failure on execute is 502 and the digest can be retried', async () => {
      const { post, enoki } = setup();
      const { digest } = (await (await post('/sponsor', { txKindBytes: await stepKindB64() })).json()) as { digest: string };
      enoki.executeError = new EnokiError('upstream', 504, 'timeout');
      expect((await post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null })).status).toBe(502);
      enoki.executeError = null;
      expect((await post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null })).status).toBe(200);
    });
  });

  it('enforces the 0.05 SUI gas cap on the bytes Enoki returns', async () => {
    const { post, enoki } = setup({ addressDailyLimit: 1 });
    enoki.budget = 50_000_001n;
    const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
    expect(r.status).toBe(502);
    expect(await json(r)).toMatchObject({ code: 'gas_cap' });
    // Not issued, so not executable here; and the quota slot was refunded.
    const { digest } = await sponsoredBytes(await stepKindB64(), SENDER, 50_000_001n);
    expect((await post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null })).status).toBe(404);
    enoki.budget = 50_000_000n;
    expect((await post('/sponsor', { txKindBytes: await stepKindB64() })).status).toBe(200);
  });

  it('refuses sponsored bytes for another sender or with a wrong digest', async () => {
    const { post, enoki } = setup();
    const real = enoki.sponsor;
    enoki.sponsor = async (p: { kindBytes: string; sender: string }) => ({ ...(await real(p)), digest: DIG });
    const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
    expect(r.status).toBe(502);
    expect(await json(r)).toMatchObject({ code: 'bad_sponsor_reply' });
  });

  it('keeps issued digests in the shared store: create on one instance, execute on another', async () => {
    const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
    const store = new MemoryStore(() => clock.t);
    const a = setup({ store, clock });
    const b = setup({ store, clock });
    const { digest } = (await (await a.post('/sponsor', { txKindBytes: await stepKindB64() })).json()) as { digest: string };
    const x = await b.post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null });
    expect(x.status).toBe(200);
    expect(await x.json()).toEqual({ digest });
    // The repeat on the first instance returns the stored result.
    expect(await (await a.post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null })).json()).toEqual({ digest });
    expect(a.enoki.executed + b.enoki.executed).toBe(1);

    // Digests expire after 60 s.
    const { digest: d2 } = (await (await a.post('/sponsor', { txKindBytes: await stepKindB64(OTHER) })).json()) as { digest: string };
    clock.t += 61_000;
    expect((await b.post(`/sponsor/${d2}`, { signature: 'sig' }, { jwt: null })).status).toBe(404);
  });

  it('answers 409 while another instance is executing the same digest', async () => {
    const { post, store } = setup();
    const { digest } = (await (await post('/sponsor', { txKindBytes: await stepKindB64() })).json()) as { digest: string };
    await store.set(`dg:${digest}:lock`, '1', 30);
    expect((await post(`/sponsor/${digest}`, { signature: 'sig' }, { jwt: null })).status).toBe(409);
  });

  describe('beacons and stats', () => {
    it('counts anonymous beacons per hunt', async () => {
      const { app, post } = setup();
      expect((await post('/beacon', { gameId: GAME, event: 'key_fetch_error' }, { jwt: null })).status).toBe(204);
      expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' }, { jwt: null })).status).toBe(204);
      expect((await post('/beacon', { gameId: GAME.toUpperCase().replace('0X', '0x'), event: 'reveal_ok' }, { jwt: null })).status).toBe(204);
      expect(await (await app.request(`/stats/${GAME}`)).json()).toEqual({ key_fetch_error: 1, reveal_ok: 2 });
    });

    it('accepts only known events, well-formed ids and existing games', async () => {
      const { post, store, app } = setup();
      expect((await post('/beacon', { gameId: 'nope', event: 'reveal_ok' })).status).toBe(400);
      expect((await post('/beacon', { gameId: GAME, event: 'whatever' })).status).toBe(400);
      expect((await post('/beacon', { gameId: GAME, event: '__proto__' })).status).toBe(400);
      expect((await post('/beacon', 'not json')).status).toBe(400);
      expect((await post('/beacon', { gameId: '0x' + '1'.repeat(64), event: 'reveal_ok' })).status).toBe(404);
      expect(await store.get(`beacon:${'0x' + '1'.repeat(64)}:reveal_ok`)).toBeNull();
      expect((await app.request('/stats/not-an-id')).status).toBe(400);
    });

    it('rate-limits beacons and stats per IP', async () => {
      const { post, app } = setup({ beaconRatePerMin: 2 });
      expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' })).status).toBe(204);
      expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' })).status).toBe(204);
      expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' })).status).toBe(429);
      expect((await app.request(`/stats/${GAME}`, { headers: { 'x-real-ip': '203.0.113.7' } })).status).toBe(429);
      expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' }, { ip: '198.51.100.2' })).status).toBe(204);
    });
  });

  it('reports health without echoing configuration', async () => {
    const { app } = setup();
    const r = await app.request('/health');
    expect(r.status).toBe(200);
    expect(Object.keys(await json(r)).sort()).toEqual(['ok', 'version']);
  });

  it('serves monitoring counters at /metrics only with the token', async () => {
    const off = setup();
    expect((await off.app.request('/metrics')).status).toBe(404);
    const { app, post, enoki } = setup({ metricsToken: 't'.repeat(20) });
    await post('/sponsor', { txKindBytes: await stepKindB64() });
    await post('/sponsor', { txKindBytes: 'bad' });
    enoki.sponsorError = new EnokiError('upstream', 500, 'x');
    await post('/sponsor', { txKindBytes: await stepKindB64() });
    expect((await app.request('/metrics', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const m = (await (await app.request('/metrics', { headers: { authorization: `Bearer ${'t'.repeat(20)}` } })).json()) as {
      today: Record<string, number>;
    };
    expect(m.today).toMatchObject({ requests: 4, sponsored: 1, enoki_errors: 1, s2xx: 1, s4xx: 2, s5xx: 1, 'route:sponsor': 3 });
    expect(m.today.enoki_calls).toBe(4);
    expect(m.today.enoki_ms_sum).toBeGreaterThanOrEqual(0);
  });

  it('writes one JSON log line per request, without the JWT or full addresses', async () => {
    const { post, logs, jwt } = setup();
    await post('/sponsor', { txKindBytes: await stepKindB64() });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ route: 'sponsor', status: 200, ms: expect.any(Number), enokiMs: expect.any(Number) });
    const line = JSON.stringify(logs[0]);
    expect(line).not.toContain(jwt);
    expect(line).not.toContain(SENDER);
  });

  it('answers CORS only for the configured origins', async () => {
    const { app } = setup();
    const pre = (origin: string) =>
      app.request('/sponsor', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,zklogin-jwt' },
      });
    expect((await pre('https://whiteout.example')).headers.get('access-control-allow-origin')).toBe('https://whiteout.example');
    expect((await pre('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses to build an app with an empty origin list', () => {
    expect(() =>
      makeApp(
        { network: 'testnet', packageId: PKG, maxGasBudgetMist: 1n, allowedOrigins: [] },
        { enoki: fakeEnoki(), store: new MemoryStore(), games: fakeGames() },
      ),
    ).toThrow();
  });
});
