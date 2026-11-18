import { Inputs, Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';
import { tx } from '@whiteout/core';
import { makeApp, type Enoki } from '../src/app.js';
import { checkKind } from '../src/policy.js';
import { MemoryStore } from '../src/quota.js';

const PKG = '0x' + '7'.repeat(64);
const ctx = { packageId: PKG, coinType: '0x2::sui::SUI' };
const GAME = '0x' + 'a'.repeat(64);
const OTHER = '0x' + 'b'.repeat(64);
const EXPLORER = '0x' + 'c'.repeat(64);

const data = (t: Transaction) => t.getData();

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

  it('refuses host-only and Seal functions', () => {
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

  it('refuses a funds withdrawal from the sponsor', () => {
    const d = data(tx.step(ctx, { gameId: GAME, explorerId: EXPLORER, dir: 0 }));
    const withSponsorFunds = {
      ...d,
      inputs: [
        ...d.inputs,
        { $kind: 'FundsWithdrawal', FundsWithdrawal: { withdrawFrom: { $kind: 'Sponsor', Sponsor: true } } },
      ],
    } as unknown as typeof d;
    expect(checkKind(withSponsorFunds, PKG)).toMatchObject({ ok: false, reason: expect.stringMatching(/sponsor/) });
    const withSenderFunds = {
      ...d,
      inputs: [...d.inputs, { $kind: 'FundsWithdrawal', FundsWithdrawal: { withdrawFrom: { $kind: 'Sender', Sender: true } } }],
    } as unknown as typeof d;
    expect(checkKind(withSenderFunds, PKG).ok).toBe(true);
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
});

// --- HTTP ---------------------------------------------------------------------------

function fakeEnoki(): Enoki & { sponsored: number; executed: number } {
  const f = {
    sponsored: 0,
    executed: 0,
    address: async (jwt: string) => (jwt === 'bad' ? Promise.reject(new Error('bad')) : '0x' + 'd'.repeat(64)),
    sponsor: async () => {
      f.sponsored++;
      return { bytes: 'AAAA', digest: `digest${f.sponsored}` };
    },
    execute: async (digest: string) => {
      f.executed++;
      return { digest };
    },
  };
  return f;
}

/** A step kind with fully resolved inputs, so it serializes without a client. */
async function stepKindB64(gameId = GAME) {
  const t = new Transaction();
  const shared = (id: string, mutable: boolean) =>
    t.object(Inputs.SharedObjectRef({ objectId: id, initialSharedVersion: 5, mutable }));
  t.moveCall({
    target: `${PKG}::game::step`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [shared(gameId, false), shared(EXPLORER, true), t.pure.u8(0), shared('0x6', false)],
  });
  return toBase64(await t.build({ onlyTransactionKind: true }));
}

describe('sponsor HTTP API', () => {
  const setup = (limit = 1200) => {
    const enoki = fakeEnoki();
    const app = makeApp({ network: 'testnet', packageId: PKG, maxGasBudgetMist: 1n, perGameLimit: limit }, enoki, new MemoryStore());
    const post = (path: string, body: unknown, jwt: string | null = 'jwt') =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(jwt ? { 'zklogin-jwt': jwt } : {}) },
        body: JSON.stringify(body),
      });
    return { app, enoki, post };
  };

  it('sponsors and executes a step', async () => {
    const { post, enoki } = setup();
    const r = await post('/sponsor', { txKindBytes: await stepKindB64() });
    expect(r.status).toBe(200);
    const { digest } = (await r.json()) as { digest: string };
    const x = await post(`/sponsor/${digest}`, { signature: 'sig' }, null);
    expect(await x.json()).toEqual({ digest });
    // A repeated execute returns the earlier result without calling Enoki again.
    await post(`/sponsor/${digest}`, { signature: 'sig' }, null);
    expect(enoki.executed).toBe(1);
  });

  it('enforces the per-hunt quota (429)', async () => {
    const { post } = setup(2);
    const kind = await stepKindB64();
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(200);
    expect((await post('/sponsor', { txKindBytes: kind })).status).toBe(429);
    // Another hunt has its own quota.
    expect((await post('/sponsor', { txKindBytes: await stepKindB64(OTHER) })).status).toBe(200);
  });

  it('rejects malformed input, a missing token and unknown digests', async () => {
    const { post } = setup();
    expect((await post('/sponsor', { txKindBytes: 'not base64!!' })).status).toBe(400);
    expect((await post('/sponsor', { txKindBytes: await stepKindB64() }, null)).status).toBe(400);
    expect((await post('/sponsor', { txKindBytes: await stepKindB64() }, 'bad')).status).toBe(400);
    expect((await post('/sponsor/nope', { signature: 's' }, null)).status).toBe(404);
  });

  it('counts anonymous beacons per hunt', async () => {
    const { app, post } = setup();
    expect((await post('/beacon', { gameId: GAME, event: 'key_fetch_error' }, null)).status).toBe(204);
    expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' }, null)).status).toBe(204);
    expect((await post('/beacon', { gameId: GAME, event: 'reveal_ok' }, null)).status).toBe(204);
    expect((await post('/beacon', { gameId: 'nope', event: 'reveal_ok' }, null)).status).toBe(400);
    expect((await post('/beacon', { gameId: GAME, event: 'whatever' }, null)).status).toBe(400);
    expect(await (await app.request(`/stats/${GAME}`)).json()).toEqual({ key_fetch_error: 1, reveal_ok: 2 });
  });

  it('reports health', async () => {
    const { app } = setup();
    expect(((await (await app.request('/health')).json()) as { ok: boolean }).ok).toBe(true);
  });
});
