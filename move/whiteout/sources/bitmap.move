/// A 576-bit visited set over `vector<u8>` (spec section 8: 72 bytes, bit y*24+x).
module whiteout::bitmap;

const GRID: u64 = 24;
const BYTES: u64 = 72;

/// An empty 72-byte set.
public fun new(): vector<u8> {
    vector::tabulate!(BYTES, |_| 0u8)
}

/// Bit index of tile (x, y).
public fun index(x: u8, y: u8): u64 {
    (y as u64) * GRID + (x as u64)
}

public fun contains(set: &vector<u8>, x: u8, y: u8): bool {
    let i = index(x, y);
    (set[i / 8] >> ((i % 8) as u8)) & 1 == 1
}

public fun insert(set: &mut vector<u8>, x: u8, y: u8) {
    let i = index(x, y);
    let byte = &mut set[i / 8];
    *byte = *byte | (1u8 << ((i % 8) as u8));
}
