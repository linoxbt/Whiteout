/** Walrus Quilt storage over the HTTP publisher/aggregator APIs (spec section 12). */
import { quiltPatchId } from './identity.js';
import { withRetry } from './errors.js';

export interface QuiltUpload {
  quiltId: string;
  /** Walrus storage end epoch, when the publisher reports it. */
  endEpoch?: number;
}

/**
 * Stores all tiles as one Quilt: one multipart field per tile, named t-<x>-<y>
 * (MD11). Testnet only; Mainnet has no public publisher.
 */
export async function storeQuilt(
  publisher: string,
  tiles: Array<{ id: string; ct: Uint8Array }>,
  epochs: number,
  fetchFn: typeof fetch = fetch,
): Promise<QuiltUpload> {
  const form = new FormData();
  for (const t of tiles) form.append(t.id, new Blob([t.ct as BlobPart]), t.id);
  const res = await withRetry(async () => {
    const r = await fetchFn(`${publisher.replace(/\/$/, '')}/v1/quilts?epochs=${epochs}`, {
      method: 'PUT',
      body: form,
    });
    if (!r.ok) throw new Error(`Walrus publisher ${r.status}: ${await r.text()}`);
    return r.json() as Promise<WalrusStoreResponse>;
  });
  const blob = res.blobStoreResult?.newlyCreated?.blobObject ?? res.blobStoreResult?.alreadyCertified;
  const quiltId = res.blobStoreResult?.newlyCreated?.blobObject?.blobId ?? res.blobStoreResult?.alreadyCertified?.blobId;
  if (!quiltId) throw new Error(`unexpected Walrus response: ${JSON.stringify(res).slice(0, 300)}`);
  const endEpoch = (blob as { storage?: { endEpoch?: number }; endEpoch?: number } | undefined)?.storage?.endEpoch ??
    (blob as { endEpoch?: number } | undefined)?.endEpoch;
  return endEpoch === undefined ? { quiltId } : { quiltId, endEpoch };
}

interface WalrusStoreResponse {
  blobStoreResult?: {
    newlyCreated?: { blobObject?: { blobId?: string; storage?: { endEpoch?: number } } };
    alreadyCertified?: { blobId?: string; endEpoch?: number };
  };
}

/** Stores one blob (the thaw file). */
export async function storeBlob(
  publisher: string,
  data: Uint8Array,
  epochs: number,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const r = await withRetry(async () => {
    const res = await fetchFn(`${publisher.replace(/\/$/, '')}/v1/blobs?epochs=${epochs}`, {
      method: 'PUT',
      body: data as BodyInit,
    });
    if (!res.ok) throw new Error(`Walrus publisher ${res.status}: ${await res.text()}`);
    return res.json() as Promise<{
      newlyCreated?: { blobObject?: { blobId?: string } };
      alreadyCertified?: { blobId?: string };
    }>;
  });
  const id = r.newlyCreated?.blobObject?.blobId ?? r.alreadyCertified?.blobId;
  if (!id) throw new Error('unexpected Walrus response');
  return id;
}

/** Reads one tile, failing over across aggregators (F5). */
export async function readTile(
  aggregators: string[],
  quiltId: string,
  x: number,
  y: number,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  return readWithFailover(aggregators, `/v1/blobs/by-quilt-id/${quiltId}/${quiltPatchId(x, y)}`, fetchFn);
}

export async function readBlob(aggregators: string[], blobId: string, fetchFn: typeof fetch = fetch) {
  return readWithFailover(aggregators, `/v1/blobs/${blobId}`, fetchFn);
}

async function readWithFailover(aggregators: string[], path: string, fetchFn: typeof fetch): Promise<Uint8Array> {
  let last: unknown;
  for (const base of aggregators) {
    try {
      return await withRetry(
        async () => {
          const r = await fetchFn(`${base.replace(/\/$/, '')}${path}`);
          if (r.status === 404) throw Object.assign(new Error('not found'), { fatal: true });
          if (!r.ok) throw new Error(`aggregator ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        },
        { tries: 3, retryIf: (e) => !(e as { fatal?: boolean }).fatal },
      );
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Downloads all 576 tiles, 16 at a time (integrity check before join, spec section 12). */
export async function readAllTiles(
  aggregators: string[],
  quiltId: string,
  onProgress?: (done: number) => void,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(576);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < 576) {
      const i = next++;
      out[i] = await readTile(aggregators, quiltId, i % 24, Math.floor(i / 24), fetchFn);
      onProgress?.(++done);
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  return out;
}
