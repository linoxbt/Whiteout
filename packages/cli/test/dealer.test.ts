import { EncryptedObject } from '@mysten/seal';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, deal, generateMap, seededRng, toHex } from '@whiteout/core';
import { checkDealFile, toDealFile } from '../src/dealer.js';
import { parseDuration, type Env } from '../src/env.js';

const cfg = { ...DEFAULTS.testnet, packageId: '0x' + '9'.repeat(64), enclavePackageId: '', enclaveConfigId: '' };
const env = { cfg } as unknown as Env;
const gameId = '0x' + 'ab'.repeat(32);

/** A structurally valid Seal ciphertext naming the given key servers. */
function fakeSeal(servers: string[], threshold: number) {
  return async (idHex: string, pt: Uint8Array) =>
    EncryptedObject.serialize({
      version: 0,
      packageId: cfg.packageId,
      id: idHex,
      services: servers.map((s, i) => [s, i] as [string, number]),
      threshold,
      encryptedShares: {
        BonehFranklinBLS12381: {
          nonce: new Uint8Array(96),
          encryptedShares: servers.map(() => new Uint8Array(32)),
          encryptedRandomness: new Uint8Array(32),
        },
      },
      ciphertext: { Aes256Gcm: { blob: pt, aad: null } },
    }).toBytes();
}

async function dealWith(servers: string[], threshold = cfg.sealThreshold) {
  const out = await deal({
    map: generateMap(seededRng(3)),
    gameId,
    dealTs: 1n,
    secretKey: new Uint8Array(32).fill(1),
    encrypt: fakeSeal(servers, threshold),
  });
  return toDealFile(out, 'ceremony');
}

describe('deal file checks', () => {
  const pinned = cfg.sealServers.map((s) => s.objectId);

  it('accepts a deal encrypted to exactly the pinned servers', async () => {
    const d = await dealWith(pinned);
    expect(() => checkDealFile(env, d)).not.toThrow();
  });

  it('rejects a deal that names an extra key server (MD16, AC25)', async () => {
    const d = await dealWith([...pinned, '0x' + 'ee'.repeat(32)]);
    expect(() => checkDealFile(env, d)).toThrow(/key servers/);
  });

  it('rejects a deal with the wrong threshold', async () => {
    const d = await dealWith(pinned, 2);
    expect(() => checkDealFile(env, d)).toThrow(/threshold/);
  });

  it('rejects swapped ciphertexts (R23)', async () => {
    const d = await dealWith(pinned);
    const a = d.tiles[0]!.ct;
    d.tiles[0]!.ct = d.tiles[1]!.ct;
    d.tiles[1]!.ct = a;
    expect(() => checkDealFile(env, d)).toThrow(/ct_hash/);
  });

  it('rejects a deal signed for another game', async () => {
    const d = await dealWith(pinned);
    d.gameId = '0x' + 'cd'.repeat(32);
    expect(() => checkDealFile(env, d)).toThrow();
  });

  it('rejects a forged deal signature', async () => {
    const d = await dealWith(pinned);
    d.dealSig = toHex(new Uint8Array(64));
    expect(() => checkDealFile(env, d)).toThrow(/signature/);
  });
});

describe('durations', () => {
  it('parses units', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('300s')).toBe(300_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('120000')).toBe(120_000);
    expect(() => parseDuration('soon')).toThrow();
  });
});

import { parsePcrs } from '../src/admin.js';
describe('PCR file parsing', () => {
  it('reads eif_build output', () => {
    const a = 'a'.repeat(96), b = 'b'.repeat(96), c = 'c'.repeat(96);
    expect(parsePcrs(`${a} PCR0\n${b} PCR1\n${c} PCR2\n`)).toEqual([a, b, c]);
    expect(parsePcrs(JSON.stringify({ PCR0: a, PCR1: b, PCR2: c }))).toEqual([a, b, c]);
    expect(() => parsePcrs('nothing')).toThrow();
  });
});

import { alertsFor } from '../src/alerts.js';
describe('watcher alerts', () => {
  const base = { overdue: 0, overdueFreezes: 0, keyFetchErrors: 0, reveals: 0, sponsorUp: true };
  it('raises each alert once, on change', () => {
    expect(alertsFor(null, base)).toEqual([]);
    expect(alertsFor(base, { ...base, overdue: 2 })).toHaveLength(1);
    expect(alertsFor({ ...base, overdue: 2 }, { ...base, overdue: 2 })).toEqual([]);
    expect(alertsFor(base, { ...base, overdueFreezes: 1 })[0]).toMatch(/overdue reveal/);
    expect(alertsFor(base, { ...base, sponsorUp: false })[0]).toMatch(/sponsor/);
    expect(alertsFor({ ...base, sponsorUp: false }, { ...base, sponsorUp: false })).toEqual([]);
  });
  it('alerts on a high key-fetch error rate only with enough samples', () => {
    expect(alertsFor(base, { ...base, keyFetchErrors: 3, reveals: 2 })).toEqual([]);
    expect(alertsFor(base, { ...base, keyFetchErrors: 5, reveals: 10 })[0]).toMatch(/33%/);
    expect(alertsFor(base, { ...base, keyFetchErrors: 1, reveals: 20 })).toEqual([]);
  });
});
