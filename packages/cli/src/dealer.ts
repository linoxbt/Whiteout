/** Getting a deal: from the enclave over HTTP, or dealt locally (ceremony mode). */
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  bytesEqual,
  checkCiphertexts,
  ciphertextServers,
  deal,
  EnclaveBcs,
  fromBase64,
  fromHex,
  generateMap,
  identityHex,
  makeSealClient,
  sealEncryptor,
  toBase64,
  toHex,
  verifyDealSig,
  TILE_COUNT,
  type DealOutput,
} from '@whiteout/core';
import type { Env } from './env.js';

/** On-disk form of a deal. Holds only ciphertext and public data, so it is safe to keep (F12). */
export interface DealFile {
  kind: 'enclave' | 'ceremony';
  gameId: string;
  dealTs: string;
  dealerPk: string;
  ctHash: string;
  dealSig: string;
  enclaveId?: string;
  tiles: Array<{ id: string; ct: string }>;
}

export function toDealFile(out: DealOutput, kind: DealFile['kind'], enclaveId?: string): DealFile {
  return {
    kind,
    gameId: out.gameId,
    dealTs: out.dealTs.toString(),
    dealerPk: toHex(out.dealerPk),
    ctHash: toHex(out.ctHash),
    dealSig: toHex(out.dealSig),
    ...(enclaveId ? { enclaveId } : {}),
    tiles: out.tiles.map((t) => ({ id: t.id, ct: toBase64(t.ct) })),
  };
}

export function tilesOf(d: DealFile) {
  return d.tiles.map((t) => {
    const [, x, y] = t.id.split('-').map(Number) as [unknown, number, number];
    return { id: t.id, x, y, ct: fromBase64(t.ct) };
  });
}

/** Response of the enclave's POST /deal (spec section 12). */
interface EnclaveDealResponse {
  deal_ts: number | string;
  dealer_pk: string;
  ct_hash: string;
  deal_sig: string;
  tiles: Array<{ id: string; ct: string }>;
}

/**
 * Requests a deal from the attested enclave and checks everything the chain will
 * check, plus what it cannot: every ciphertext names exactly the pinned key servers.
 */
export async function requestEnclaveDeal(env: Env, gameId: string, url: string, enclaveId: string): Promise<DealFile> {
  const res = await fetch(`${url.replace(/\/$/, '')}/deal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game_id: gameId }),
  });
  if (!res.ok) throw new Error(`enclave /deal ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as EnclaveDealResponse;

  const { object } = await env.client.core.getObject({ objectId: enclaveId, include: { content: true } });
  const enclave = EnclaveBcs.parse(object.content);
  const dealerPk = fromHex(body.dealer_pk.replace(/^0x/, ''));
  if (!bytesEqual(Uint8Array.from(enclave.pk), dealerPk)) {
    throw new Error('The enclave answered with a key that is not the registered Enclave key.');
  }
  const file: DealFile = {
    kind: 'enclave',
    gameId,
    dealTs: String(body.deal_ts),
    dealerPk: toHex(dealerPk),
    ctHash: body.ct_hash.replace(/^0x/, ''),
    dealSig: body.deal_sig.replace(/^0x/, ''),
    enclaveId,
    tiles: body.tiles,
  };
  checkDealFile(env, file);
  return file;
}

/** Checks a deal file: tile set, ct_hash, deal signature and Seal key servers. */
export function checkDealFile(env: Env, d: DealFile): void {
  const tiles = tilesOf(d);
  if (tiles.length !== TILE_COUNT) throw new Error(`deal has ${tiles.length} tiles`);
  tiles.forEach((t, i) => {
    if (t.x !== i % 24 || t.y !== Math.floor(i / 24)) throw new Error(`tile ${t.id} is out of order`);
  });
  const ctHash = fromHex(d.ctHash);
  if (!checkCiphertexts(tiles.map((t) => t.ct), ctHash)) throw new Error('ct_hash does not match the ciphertexts');
  if (!verifyDealSig(fromHex(d.dealerPk), d.gameId, BigInt(d.dealTs), ctHash, fromHex(d.dealSig))) {
    throw new Error('deal signature does not verify');
  }
  const pinned = new Set(env.cfg.sealServers.map((s) => s.objectId.toLowerCase()));
  for (const t of tiles) {
    const info = ciphertextServers(t.ct);
    const ids = info.ids.map((s) => s.toLowerCase());
    if (ids.length !== pinned.size || !ids.every((s) => pinned.has(s))) {
      throw new Error(`tile ${t.id} is encrypted to key servers other than the configured ones (MD16)`);
    }
    if (info.threshold !== env.cfg.sealThreshold) throw new Error(`tile ${t.id} has threshold ${info.threshold}`);
    if (info.id.replace(/^0x/, '').toLowerCase() !== identityHex(d.gameId, t.x, t.y)) {
      throw new Error(`tile ${t.id} is encrypted under the wrong identity`);
    }
  }
}

/**
 * Ceremony deal (MD5): the host generates and signs the map here, so the host can
 * know it. Only allowed for zero-stake games, which Move enforces.
 */
export async function ceremonyDeal(env: Env, gameId: string): Promise<DealFile> {
  const secretKey = ed25519.utils.randomSecretKey();
  const seal = makeSealClient(env.client, env.cfg);
  const out = await deal({
    map: generateMap(),
    gameId,
    dealTs: BigInt(Date.now()),
    secretKey,
    encrypt: sealEncryptor(seal, env.cfg.packageId, env.cfg.sealThreshold),
  });
  secretKey.fill(0); // the key is not needed again: tiles are already signed
  return toDealFile(out, 'ceremony');
}
