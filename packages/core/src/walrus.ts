import { bcs } from '@mysten/sui/bcs';
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

/** Downloads all 576 tiles, 32 at a time (integrity check before join, spec section 12). */
/**
 * All 576 ciphertexts in row-major order. The whole Quilt is fetched in one request
 * and decoded here: aggregators throttle per-patch reads, so 576 separate requests
 * take minutes, while the blob arrives in about a second. Falls back to per-tile
 * reads if the blob cannot be read or decoded. Callers check ct_hash either way.
 */
export async function readAllTiles(
  aggregators: string[],
  quiltId: string,
  onProgress?: (done: number) => void,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array[]> {
  try {
    const blob = await readWithFailover(aggregators, `/v1/blobs/${quiltId}`, fetchFn);
    const patches = decodeQuilt(blob);
    const out: Uint8Array[] = [];
    for (let i = 0; i < 576; i++) {
      const ct = patches.get(quiltPatchId(i % 24, Math.floor(i / 24)));
      if (!ct) throw new Error(`quilt has no ${quiltPatchId(i % 24, Math.floor(i / 24))}`);
      out.push(ct);
    }
    onProgress?.(576);
    return out;
  } catch {
    return readTilesOneByOne(aggregators, quiltId, onProgress, fetchFn);
  }
}

async function readTilesOneByOne(
  aggregators: string[],
  quiltId: string,
  onProgress: ((done: number) => void) | undefined,
  fetchFn: typeof fetch,
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
  await Promise.all(Array.from({ length: 32 }, worker));
  return out;
}

// === Quilt decoding (Walrus QuiltV1, as in @mysten/walrus QuiltReader) ===

const QuiltPatchTags = bcs.map(bcs.string(), bcs.string());
const QuiltIndexV1 = bcs.struct('QuiltIndexV1', {
  patches: bcs.vector(bcs.struct('QuiltPatchV1', { endIndex: bcs.u16(), identifier: bcs.string(), tags: QuiltPatchTags })),
});
const QuiltPatchBlobHeader = bcs.struct('QuiltPatchBlobHeader', { version: bcs.u8(), length: bcs.u32(), mask: bcs.u8() });

/** Source symbols for RS2 encoding over `nShards` shards (rows, columns of the blob matrix). */
function sourceSymbols(nShards: number) {
  const maxFaulty = Math.floor((nShards - 1) / 3);
  const minCorrect = nShards - maxFaulty;
  return { rows: minCorrect - maxFaulty, cols: minCorrect };
}

/**
 * Decodes a QuiltV1 blob into its patches by identifier. The blob is a matrix of
 * rows x cols symbols stored row by row; each patch occupies whole columns, read top
 * to bottom. Walrus Testnet and Mainnet both run 1 000 shards.
 */
export function decodeQuilt(blob: Uint8Array, nShards = 1000): Map<string, Uint8Array> {
  const { rows, cols } = sourceSymbols(nShards);
  if (blob.length % (rows * cols) !== 0) throw new Error('blob size does not fit the quilt matrix');
  const symbolSize = blob.length / (rows * cols);
  const rowSize = symbolSize * cols;
  const columnSize = symbolSize * rows;

  const read = (startColumn: number, length: number, offset = 0) => {
    const out = new Uint8Array(length);
    const skip = Math.floor(offset / symbolSize);
    let inSymbol = offset % symbolSize;
    let col = startColumn + Math.floor(skip / rows);
    let row = skip % rows;
    let n = 0;
    while (n < length) {
      const base = row * rowSize + col * symbolSize;
      const from = base + inSymbol;
      const to = Math.min(base + symbolSize, from + length - n, blob.length);
      if (from >= blob.length) throw new Error('quilt read out of bounds');
      out.set(blob.subarray(from, to), n);
      n += to - from;
      inSymbol = 0;
      row = (row + 1) % rows;
      if (row === 0) col += 1;
    }
    return out;
  };
  const u16 = (b: Uint8Array) => b[0]! | (b[1]! << 8);

  const head = read(0, 5);
  if (head[0] !== 1) throw new Error(`unsupported quilt version ${head[0]}`);
  const indexSize = new DataView(head.buffer, head.byteOffset).getUint32(1, true);
  const index = QuiltIndexV1.parse(read(0, indexSize, 5));
  const indexColumns = Math.ceil(indexSize / columnSize);

  const out = new Map<string, Uint8Array>();
  index.patches.forEach((patch, i) => {
    const start = i === 0 ? indexColumns : index.patches[i - 1]!.endIndex;
    const header = QuiltPatchBlobHeader.parse(read(start, 6));
    let offset = 6;
    const idLength = u16(read(start, 2, offset));
    offset += 2 + idLength;
    let size = header.length - 2 - idLength;
    if (header.mask & 1) {
      const tagsSize = u16(read(start, 2, offset));
      offset += 2 + tagsSize;
      size -= 2 + tagsSize;
    }
    out.set(patch.identifier, read(start, size, offset));
  });
  return out;
}
