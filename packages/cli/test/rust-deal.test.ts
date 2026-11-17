// Cross-language check: a deal produced by the Rust dealer passes every check the
// host CLI applies (ct_hash, deal signature, Seal key servers, identities).
// Runs when RUST_DEAL points at a saved /deal response.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '@whiteout/core';
import { checkDealFile, type DealFile } from '../src/dealer.js';
import type { Env } from '../src/env.js';

const file = process.env.RUST_DEAL;
(file ? describe : describe.skip)('Rust dealer output', () => {
  it('passes the host CLI checks', () => {
    const body = JSON.parse(readFileSync(file!, 'utf8'));
    const d: DealFile = {
      kind: 'enclave',
      gameId: process.env.RUST_DEAL_GAME ?? '0x' + '01'.repeat(32),
      dealTs: String(body.deal_ts),
      dealerPk: body.dealer_pk,
      ctHash: body.ct_hash,
      dealSig: body.deal_sig,
      tiles: body.tiles,
    };
    const env = { cfg: { ...DEFAULTS.testnet, packageId: '0x0', enclavePackageId: '', enclaveConfigId: '' } } as unknown as Env;
    expect(() => checkDealFile(env, d)).not.toThrow();
  });
});
