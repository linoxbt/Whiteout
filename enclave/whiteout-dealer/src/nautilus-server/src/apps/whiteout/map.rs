//! Map generation and clues. Same rules as packages/core/src/map.ts (spec sections 8, 12).

use rand::seq::SliceRandom;
use rand::Rng;

pub const GRID: usize = 24;
pub const TILES: usize = GRID * GRID;
pub const RELIC_MIN_ROW: usize = 12;
pub const CREVASSES: usize = 70;
pub const GOGGLES: usize = 12;
pub const ROPES: usize = 13;

pub const SNOW: u8 = 0;
pub const CREVASSE: u8 = 1;
pub const GOGGLE: u8 = 2;
pub const ROPE: u8 = 3;
pub const RELIC: u8 = 4;

pub type Map = [u8; TILES];

#[inline]
pub fn idx(x: usize, y: usize) -> usize {
    y * GRID + x
}

pub fn find_relic(map: &Map) -> (usize, usize) {
    let i = map.iter().position(|&k| k == RELIC).expect("map has a relic");
    (i % GRID, i / GRID)
}

fn chebyshev(x1: usize, y1: usize, x2: usize, y2: usize) -> usize {
    x1.abs_diff(x2).max(y1.abs_diff(y2))
}

pub fn warmth(x: usize, y: usize, relic: (usize, usize)) -> u8 {
    match chebyshev(x, y, relic.0, relic.1) {
        0..=2 => 5,
        3..=4 => 4,
        5..=7 => 3,
        8..=11 => 2,
        12..=16 => 1,
        _ => 0,
    }
}

pub fn hazards(map: &Map, x: usize, y: usize) -> u8 {
    let mut n = 0;
    for dy in -1i32..=1 {
        for dx in -1i32..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if (0..GRID as i32).contains(&nx) && (0..GRID as i32).contains(&ny) && map[idx(nx as usize, ny as usize)] == CREVASSE {
                n += 1;
            }
        }
    }
    n
}

/// A crevasse-free 4-way path joins row 0 to the relic (R20).
pub fn relic_reachable(map: &Map) -> bool {
    let (rx, ry) = find_relic(map);
    let mut seen = [false; TILES];
    let mut queue: std::collections::VecDeque<(usize, usize)> = (0..GRID).map(|x| (x, 0)).collect();
    for x in 0..GRID {
        seen[idx(x, 0)] = true;
    }
    while let Some((x, y)) = queue.pop_front() {
        if (x, y) == (rx, ry) {
            return true;
        }
        let neighbours = [(x as i32, y as i32 + 1), (x as i32 + 1, y as i32), (x as i32, y as i32 - 1), (x as i32 - 1, y as i32)];
        for (nx, ny) in neighbours {
            if !(0..GRID as i32).contains(&nx) || !(0..GRID as i32).contains(&ny) {
                continue;
            }
            let j = idx(nx as usize, ny as usize);
            if !seen[j] && map[j] != CREVASSE {
                seen[j] = true;
                queue.push_back((nx as usize, ny as usize));
            }
        }
    }
    false
}

fn layout<R: Rng>(rng: &mut R) -> Map {
    let mut map = [SNOW; TILES];
    let rx = rng.gen_range(0..GRID);
    let ry = rng.gen_range(RELIC_MIN_ROW..GRID);
    map[idx(rx, ry)] = RELIC;
    let mut free: Vec<usize> = (GRID..TILES).filter(|&i| map[i] == SNOW).collect();
    let (chosen, _) = free.partial_shuffle(rng, CREVASSES + GOGGLES + ROPES);
    for (n, &i) in chosen.iter().enumerate() {
        map[i] = if n < CREVASSES { CREVASSE } else if n < CREVASSES + GOGGLES { GOGGLE } else { ROPE };
    }
    map
}

/// A solvable map, retrying up to 1 000 times (spec section 12). The enclave passes
/// the OS RNG; tests pass a seeded one.
pub fn generate<R: Rng>(rng: &mut R) -> Option<Map> {
    (0..1000).map(|_| layout(rng)).find(relic_reachable)
}

pub fn validate(map: &Map) -> Vec<String> {
    let mut problems = vec![];
    let count = |k: u8| map.iter().filter(|&&v| v == k).count();
    if count(RELIC) != 1 {
        return vec!["relic count".into()];
    }
    if count(CREVASSE) != CREVASSES {
        problems.push("crevasse count".into());
    }
    if count(GOGGLE) != GOGGLES {
        problems.push("goggles count".into());
    }
    if count(ROPE) != ROPES {
        problems.push("rope count".into());
    }
    if map[..GRID].iter().any(|&k| k != SNOW) {
        problems.push("base row is not all snow".into());
    }
    if find_relic(map).1 < RELIC_MIN_ROW {
        problems.push("relic below row 12".into());
    }
    if !relic_reachable(map) {
        problems.push("relic unreachable".into());
    }
    problems
}
