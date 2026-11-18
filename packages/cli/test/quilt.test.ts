import { encodeQuilt } from '@mysten/walrus';
import { describe, expect, it } from 'vitest';
import { decodeQuilt } from '@whiteout/core';

describe('decodeQuilt', () => {
  it('reads back every patch that the Walrus SDK encodes (1 000 shards, RS2)', () => {
    const blobs = Array.from({ length: 576 }, (_, i) => ({
      identifier: `t-${i % 24}-${Math.floor(i / 24)}`,
      contents: Uint8Array.from({ length: 300 + (i % 97) }, (_, j) => (i * 31 + j) & 0xff),
    }));
    const { quilt } = encodeQuilt({ blobs, numShards: 1000, encodingType: 'RS2' });
    const out = decodeQuilt(quilt);
    expect(out.size).toBe(576);
    for (const b of blobs) expect(Buffer.from(out.get(b.identifier)!)).toEqual(Buffer.from(b.contents));
  });
});
