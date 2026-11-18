/**
 * Host console helpers (Phase 2: "a web host console replacing the CLI"). The host
 * signs with their own wallet and pays their own gas: none of these calls are
 * sponsored. Everything here mirrors a `whiteout` CLI command.
 */
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  checkCiphertexts,
  ciphertextServers,
  deal,
  decryptTiles,
  fromBase64,
  fromHex,
  generateMap,
  identityHex,
  makeSealClient,
  parseAbort,
  readAllTiles,
  sealEncryptor,
  storeBlob,
  storeQuilt,
  thawFile,
  toHex,
  verifyDealSig,
  verifyThaw,
  type Tile,
} from '@whiteout/core';
import { config, suiClient } from '../config';
import { dAppKit } from '../dappkit';
import { createSession, loadSession } from './session';
import { kvGet, kvSet } from './store';

export interface HostResult {
  digest: string;
  created: Array<{ id: string; type: string }>;
}

/** Signs and executes with the connected wallet, and returns the created objects. */
export async function runHost(transaction: Transaction, sender: string): Promise<HostResult> {
  transaction.setSenderIfNotSet(sender);
  let digest: string;
  try {
    const r = await dAppKit.signAndExecuteTransaction({ transaction });
    digest = (r.Transaction ?? r.FailedTransaction!).digest;
  } catch (e) {
    const a = parseAbort(e, config.packageId);
    throw new Error(a ? `${a.name}: ${a.message}` : (e as Error).message);
  }
  const res = await suiClient.core.waitForTransaction({ digest, include: { effects: true, objectTypes: true } });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (!t.status.success) {
    const a = parseAbort(t.status.error, config.packageId);
    throw new Error(a ? `${a.name}: ${a.message}` : t.status.error.message);
  }
  const created = (t.effects?.changedObjects ?? [])
    .filter((c) => c.idOperation === 'Created')
    .map((c) => ({ id: c.objectId, type: t.objectTypes?.[c.objectId] ?? '' }));
  return { digest, created };
}

const HostCapBcs = bcs.struct('HostCap', { id: bcs.Address, game_id: bcs.Address });
const AllowlistCapBcs = bcs.struct('AllowlistCap', { id: bcs.Address, list_id: bcs.Address });

/** The HostCaps this address holds: one per hunt it hosts. */
export async function myHostCaps(owner: string): Promise<Array<{ capId: string; gameId: string }>> {
  const out: Array<{ capId: string; gameId: string }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r: { objects: Array<{ content: Uint8Array }>; hasNextPage: boolean; cursor: string | null } = await suiClient.core.listOwnedObjects({
      owner,
      type: `${config.packageId}::game::HostCap`,
      include: { content: true },
      ...(cursor ? { cursor } : {}),
    });
    for (const o of r.objects) {
      const c = HostCapBcs.parse(o.content);
      out.push({ capId: c.id, gameId: c.game_id });
    }
    if (!r.hasNextPage) break;
    cursor = r.cursor;
  }
  return out;
}

export async function myAllowlistCaps(owner: string): Promise<Array<{ capId: string; listId: string }>> {
  const r = await suiClient.core.listOwnedObjects({
    owner,
    type: `${config.packageId}::allowlist::AllowlistCap`,
    include: { content: true },
  });
  return r.objects.map((o) => {
    const c = AllowlistCapBcs.parse(o.content);
    return { capId: c.id, listId: c.list_id };
  });
}

/** Deposits `amountMist` of the host's SUI, split off the gas coin, as the next prize. */
export function depositSuiPrize(gameId: string, capId: string, amountMist: bigint, coinType: string) {
  const t = new Transaction();
  const [coin] = t.splitCoins(t.gas, [amountMist]);
  t.moveCall({
    target: `${config.packageId}::game::deposit_prize`,
    typeArguments: [coinType, '0x2::coin::Coin<0x2::sui::SUI>'],
    arguments: [t.object(gameId), t.object(capId), coin!],
  });
  return t;
}

/** A deal kept on this device between `deal` and `open`, like the CLI's deal.json. */
export interface StoredDeal {
  kind: 'enclave' | 'ceremony';
  gameId: string;
  dealTs: string;
  dealerPk: string;
  ctHash: string;
  dealSig: string;
  relics: number;
  enclaveId?: string;
  quiltId: string;
}

export const loadDeal = (gameId: string) => kvGet<StoredDeal>(`deal:${gameId}`);

/**
 * Ceremony deal in the browser (MD5): generate the map here, sign, Seal-encrypt and
 * upload the Quilt. The host could know this map, so the contract only allows it for
 * zero-stake hunts and labels them host-dealt.
 */
export async function ceremonyDealInBrowser(
  gameId: string,
  relics: number,
  durationMs: number,
  onProgress: (msg: string) => void,
): Promise<StoredDeal> {
  const secretKey = ed25519.utils.randomSecretKey();
  const seal = makeSealClient(suiClient, config);
  onProgress('Drawing a solvable mountain…');
  const map = generateMap(undefined, relics);
  onProgress('Signing and sealing 576 tiles…');
  let done = 0;
  const encrypt = sealEncryptor(seal, config.packageId, config.sealThreshold);
  const out = await deal({
    map,
    gameId,
    dealTs: BigInt(Date.now()),
    secretKey,
    encrypt: async (id, pt) => {
      const ct = await encrypt(id, pt);
      if (++done % 48 === 0) onProgress(`Sealed ${done}/576 tiles…`);
      return ct;
    },
  });
  secretKey.fill(0);
  return upload(
    { kind: 'ceremony', gameId, dealTs: out.dealTs.toString(), dealerPk: toHex(out.dealerPk), ctHash: toHex(out.ctHash), dealSig: toHex(out.dealSig), relics: out.relics },
    out.tiles,
    durationMs,
    onProgress,
  );
}

/** Asks an attested dealer enclave for the deal, checks it, and uploads it. */
export async function enclaveDealInBrowser(
  gameId: string,
  relics: number,
  enclaveUrl: string,
  enclaveId: string,
  durationMs: number,
  onProgress: (msg: string) => void,
): Promise<StoredDeal> {
  onProgress('Requesting a deal from the enclave…');
  const res = await fetch(`${enclaveUrl.replace(/\/$/, '')}/deal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game_id: gameId, relics }),
  });
  if (!res.ok) throw new Error(`enclave /deal ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { deal_ts: number; dealer_pk: string; ct_hash: string; deal_sig: string; relics?: number; tiles: Array<{ id: string; ct: string }> };
  const tiles = body.tiles.map((t) => {
    const [, x, y] = t.id.split('-').map(Number) as [unknown, number, number];
    return { id: t.id, x, y, ct: fromBase64(t.ct) };
  });
  return upload(
    {
      kind: 'enclave',
      gameId,
      dealTs: String(body.deal_ts),
      dealerPk: body.dealer_pk.replace(/^0x/, ''),
      ctHash: body.ct_hash.replace(/^0x/, ''),
      dealSig: body.deal_sig.replace(/^0x/, ''),
      relics: body.relics ?? relics,
      enclaveId,
    },
    tiles,
    durationMs,
    onProgress,
  );
}

async function upload(
  d: Omit<StoredDeal, 'quiltId'>,
  tiles: Array<{ id: string; x: number; y: number; ct: Uint8Array }>,
  durationMs: number,
  onProgress: (msg: string) => void,
): Promise<StoredDeal> {
  // The same checks as `whiteout deal`: order, ct_hash, signature, pinned servers.
  if (tiles.length !== 576) throw new Error(`deal has ${tiles.length} tiles`);
  if (!checkCiphertexts(tiles.map((t) => t.ct), fromHex(d.ctHash))) throw new Error('ct_hash does not match the ciphertexts');
  if (!verifyDealSig(fromHex(d.dealerPk), d.gameId, BigInt(d.dealTs), fromHex(d.ctHash), fromHex(d.dealSig), d.relics)) {
    throw new Error('the deal signature does not verify');
  }
  const pinned = new Set(config.sealServers.map((s) => s.objectId.toLowerCase()));
  for (const t of tiles) {
    const info = ciphertextServers(t.ct);
    if (!info.ids.every((s) => pinned.has(s.toLowerCase()))) throw new Error(`tile ${t.id} names unpinned key servers`);
    if (info.id.replace(/^0x/, '').toLowerCase() !== identityHex(d.gameId, t.x, t.y)) throw new Error(`tile ${t.id} has the wrong identity`);
  }
  if (!config.walrusPublisher) throw new Error('This network has no public Walrus publisher: deal with the CLI.');
  onProgress('Uploading the Quilt to Walrus…');
  const epochs = Math.ceil((durationMs + 30 * 86_400_000) / 86_400_000) + 1;
  const { quiltId } = await storeQuilt(config.walrusPublisher, tiles, epochs);
  const stored: StoredDeal = { ...d, quiltId };
  await kvSet(`deal:${d.gameId}`, stored);
  onProgress(`Uploaded. Quilt ${quiltId.slice(0, 12)}…`);
  return stored;
}

/**
 * The thaw (FR18, FR20): decrypt all 576 tiles once the hunt ended, verify every
 * signature, publish the thaw file to Walrus. Returns the blob ID for publish_thaw.
 */
export async function thawInBrowser(
  g: { id: string; quiltId: string; dealerPk: Uint8Array; dealTs: bigint; coinType: string },
  address: string,
  onProgress: (msg: string) => void,
): Promise<{ blobId: string; relics: Array<[number, number]> }> {
  onProgress('Downloading 576 tiles…');
  const cts = await readAllTiles(config.walrusAggregators, g.quiltId);
  const sessionKey = (await loadSession(address)) ?? (await createSession(address));
  const seal = makeSealClient(suiClient, config);
  const tiles: Tile[] = [];
  for (let i = 0; i < 576; i += 48) {
    const batch = cts.slice(i, i + 48).map((ct, j) => ({ x: (i + j) % 24, y: Math.floor((i + j) / 24), ct }));
    const res = await decryptTiles({
      seal, suiClient, ctx: { packageId: config.packageId, coinType: g.coinType }, gameId: g.id,
      dealerPk: g.dealerPk, dealTs: g.dealTs, threshold: config.sealThreshold, sessionKey, tiles: batch,
    });
    for (const r of res) {
      if (!r.verified) throw new Error(`tile (${r.tile.x}, ${r.tile.y}) failed verification`);
      tiles.push(r.tile);
    }
    onProgress(`Thawed ${tiles.length}/576…`);
  }
  const file = thawFile(g.id, tiles);
  const check = verifyThaw(file, g.id, g.dealerPk, g.dealTs);
  if (!check.ok) throw new Error(`thaw check failed: ${check.problems.slice(0, 3).join('; ')}`);
  if (!config.walrusPublisher) throw new Error('This network has no public Walrus publisher: thaw with the CLI.');
  onProgress('Publishing the thaw file…');
  const blobId = await storeBlob(config.walrusPublisher, new TextEncoder().encode(JSON.stringify(file)), 31);
  return { blobId, relics: check.relics ?? [] };
}
