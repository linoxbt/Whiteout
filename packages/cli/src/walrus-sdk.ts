/**
 * Walrus uploads through the TypeScript SDK and an upload relay (R17): Mainnet has no
 * public publisher. The host wallet pays storage in WAL and gas in SUI.
 */
import { WalrusClient } from '@mysten/walrus';
import type { Env } from './env.js';

function client(e: Env) {
  if (e.cfg.network !== 'mainnet' && e.cfg.network !== 'testnet') throw new Error('Walrus SDK uploads need testnet or mainnet');
  return new WalrusClient({
    network: e.cfg.network,
    suiClient: e.client,
    ...(e.cfg.walrusUploadRelay ? { uploadRelay: { host: e.cfg.walrusUploadRelay, sendTip: { max: 10_000_000 } } } : {}),
  });
}

/** Stores the 576 tiles as one Quilt, patch identifiers t-<x>-<y> (MD11). */
export async function storeQuiltSdk(e: Env, tiles: Array<{ id: string; ct: Uint8Array }>, epochs: number) {
  const res = await client(e).writeQuilt({
    blobs: tiles.map((t) => ({ contents: t.ct, identifier: t.id })),
    deletable: false,
    epochs,
    signer: e.signer,
  });
  return { quiltId: res.blobId, endEpoch: res.blobObject.storage.end_epoch };
}

export async function storeBlobSdk(e: Env, data: Uint8Array, epochs: number): Promise<string> {
  const res = await client(e).writeBlob({ blob: data, deletable: false, epochs, signer: e.signer });
  return res.blobId;
}
