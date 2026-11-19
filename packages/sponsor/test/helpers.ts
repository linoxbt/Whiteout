import { Inputs, Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { makeApp, type Deps, type SponsorConfig } from '../src/app.js';
import { EnokiError, type Enoki } from '../src/enoki.js';
import type { GameRegistry } from '../src/games.js';
import { UpstreamError } from '../src/games.js';
import { MemoryStore, type Store } from '../src/quota.js';

export const PKG = '0x' + '7'.repeat(64);
export const GAME = '0x' + 'a'.repeat(64);
export const OTHER = '0x' + 'b'.repeat(64);
export const EXPLORER = '0x' + 'c'.repeat(64);
export const SENDER = '0x' + 'd'.repeat(64);
export const SPONSOR = '0x' + '5'.repeat(64);
export const COIN = '0x' + 'e'.repeat(64);
export const DIG = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
export const ctx = { packageId: PKG, coinType: '0x2::sui::SUI' };

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A structurally valid zkLogin JWT (Enoki is faked, so the signature is never checked). */
export function fakeJwt(p: Record<string, unknown> = {}, nowSec = Date.now() / 1000) {
  return [
    b64url({ alg: 'RS256', kid: 'k', typ: 'JWT' }),
    b64url({ iss: 'https://accounts.google.com', aud: 'client-id', sub: '1234', exp: Math.floor(nowSec) + 3600, iat: Math.floor(nowSec), ...p }),
    'c2ln',
  ].join('.');
}

/**
 * A fake full-node client, just enough for the SDK's resolver to build real transaction
 * kinds (unresolved objects, coinWithBalance) the way the web client does.
 */
export function fakeSuiClient(o: { coinBalance?: bigint; addressBalance?: bigint }) {
  const cb = o.coinBalance ?? 0n;
  const ab = o.addressBalance ?? 0n;
  const dt = (typeName: string, reference: 'mutable' | 'immutable' | null) => ({
    reference,
    body: { $kind: 'datatype', datatype: { typeName, typeParameters: [] } },
  });
  return {
    core: {
      resolveTransactionPlugin: () => undefined,
      getBalance: async (a: { coinType: string }) => ({
        balance: { coinType: a.coinType, balance: String(cb + ab), coinBalance: String(cb), addressBalance: String(ab) },
      }),
      listCoins: async () => ({
        objects: cb ? [{ objectId: COIN, version: '3', digest: DIG, balance: String(cb) }] : [],
        hasNextPage: false,
        cursor: null,
      }),
      getMoveFunction: async () => ({
        function: {
          parameters: [
            dt(`${PKG}::game::Game`, 'mutable'),
            dt('0x2::coin::Coin', null),
            { reference: null, body: { $kind: 'u8' } },
            dt('0x2::clock::Clock', 'immutable'),
          ],
        },
      }),
      getObjects: async (a: { objectIds: string[] }) => ({
        objects: a.objectIds.map((id) => ({
          objectId: id,
          version: '5',
          digest: DIG,
          owner: { $kind: 'Shared', Shared: { initialSharedVersion: '5' } },
          type: 'x',
        })),
      }),
    },
  } as never;
}

/** Builds `tx.join` exactly as the web client would, and returns its kind bytes. */
export async function joinKind(t: Transaction, balances: { coinBalance?: bigint; addressBalance?: bigint }) {
  t.setSender(SENDER);
  return t.build({ client: fakeSuiClient(balances), onlyTransactionKind: true });
}

/** A step kind with fully resolved inputs, so it serializes without a client. */
export async function stepKindB64(gameId = GAME) {
  const t = new Transaction();
  const shared = (id: string, mutable: boolean) => t.object(Inputs.SharedObjectRef({ objectId: id, initialSharedVersion: 5, mutable }));
  t.moveCall({
    target: `${PKG}::game::step`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [shared(gameId, false), shared(EXPLORER, true), t.pure.u8(0), shared('0x6', false)],
  });
  return toBase64(await t.build({ onlyTransactionKind: true }));
}

/** What Enoki would return: the full TransactionData with the sponsor's gas, and its digest. */
export async function sponsoredBytes(kindB64: string, sender: string, budget: bigint) {
  const t = Transaction.fromKind(kindB64);
  t.setSender(sender);
  t.setGasOwner(SPONSOR);
  t.setGasBudget(budget);
  t.setGasPrice(1000);
  t.setGasPayment([{ objectId: '0x' + 'f'.repeat(64), version: '1', digest: DIG }]);
  const bytes = await t.build();
  return { bytes: toBase64(bytes), digest: TransactionDataBuilder.getDigestFromBytes(bytes) };
}

export function fakeEnoki(opts: { budget?: bigint; address?: string } = {}) {
  const f = {
    addressCalls: 0,
    sponsored: 0,
    executed: 0,
    /** Set to make the next calls fail. */
    addressError: null as EnokiError | null,
    sponsorError: null as EnokiError | Error | null,
    executeError: null as EnokiError | null,
    budget: opts.budget ?? 10_000_000n,
    address: async (_jwt: string) => {
      f.addressCalls++;
      if (f.addressError) throw f.addressError;
      return opts.address ?? SENDER;
    },
    sponsor: async (p: { kindBytes: string; sender: string }): Promise<{ bytes: string; digest: string }> => {
      if (f.sponsorError) throw f.sponsorError;
      f.sponsored++;
      return sponsoredBytes(p.kindBytes, p.sender, f.budget);
    },
    execute: async (digest: string) => {
      if (f.executeError) throw f.executeError;
      f.executed++;
      return { digest };
    },
  } satisfies Enoki & Record<string, unknown>;
  return f;
}

export function fakeGames(known = [GAME, OTHER]) {
  const f = {
    lookups: 0,
    down: false,
    isGame: async (id: string) => {
      f.lookups++;
      if (f.down) throw new UpstreamError('node down');
      return known.includes(id);
    },
  } satisfies GameRegistry & Record<string, unknown>;
  return f;
}

export function setup(over: Partial<SponsorConfig> & { store?: Store; deps?: Partial<Deps>; clock?: { t: number } } = {}) {
  const clock = over.clock ?? { t: Date.parse('2026-11-19T12:00:00Z') };
  const now = () => clock.t;
  const store = over.store ?? new MemoryStore(now);
  const enoki = fakeEnoki();
  const games = fakeGames();
  const logs: Record<string, unknown>[] = [];
  const app = makeApp(
    {
      network: 'testnet',
      packageId: PKG,
      maxGasBudgetMist: 50_000_000n,
      allowedOrigins: ['https://whiteout.example'],
      ipRatePerMin: 100_000,
      beaconRatePerMin: 100_000,
      now,
      log: (l) => logs.push(l),
      ...over,
    },
    { enoki, store, games, ...over.deps },
  );
  // Valid for a week of fake time, so long-running quota tests keep a live token.
  const jwt = fakeJwt({ exp: Math.floor(clock.t / 1000) + 7 * 86400 }, clock.t / 1000);
  const post = (path: string, body: unknown, o: { jwt?: string | null; ip?: string } = {}) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': o.ip ?? '203.0.113.7',
        ...(o.jwt === null ? {} : { 'zklogin-jwt': o.jwt ?? jwt }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, enoki, games, store, post, logs, clock, jwt };
}

export const decodeB64 = fromBase64;
