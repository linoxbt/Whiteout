//! Per-process deal clock (audit finding: interchangeable kind signatures).
//!
//! A tile's kind signature binds only (game_id, deal_ts, x, y, kind) under the
//! process's signing key. Two deals for the same game with the same deal_ts would
//! therefore produce interchangeable signatures, letting a colluding host swap tiles
//! between them. `next_deal_ts` hands out strictly increasing timestamps for the
//! life of the process, so no two deals signed by this key ever share a deal_ts, and
//! a Game (which stores the deal_ts of the deal that opened it) accepts kind
//! signatures from that one deal only. A second deal for the same game is therefore
//! harmless and is allowed. (A restart generates a new key, so timestamps need not
//! be unique across processes.)

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub struct DealRegistry {
    last_ts: AtomicU64,
}

impl DealRegistry {
    /// A deal_ts strictly greater than every one issued before by this process:
    /// `max(now_ms, last + 1)`. Safe to call from many threads at once.
    pub fn next_deal_ts(&self, now_ms: u64) -> u64 {
        let prev = self
            .last_ts
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |last| Some(now_ms.max(last.saturating_add(1))))
            .expect("the update closure always returns Some");
        now_ms.max(prev.saturating_add(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn timestamps_strictly_increase_even_within_one_millisecond() {
        let r = DealRegistry::default();
        let a = r.next_deal_ts(1_000);
        let b = r.next_deal_ts(1_000);
        let c = r.next_deal_ts(999); // the clock stepped back
        let d = r.next_deal_ts(5_000);
        assert_eq!((a, b, c, d), (1_000, 1_001, 1_002, 5_000));
    }

    #[test]
    fn concurrent_timestamps_are_all_distinct() {
        let r = Arc::new(DealRegistry::default());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let r = r.clone();
                std::thread::spawn(move || (0..2_000).map(|_| r.next_deal_ts(42)).collect::<Vec<_>>())
            })
            .collect();
        let mut all: Vec<u64> = threads.into_iter().flat_map(|t| t.join().unwrap()).collect();
        let n = all.len();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), n, "two deals shared a deal_ts");
    }
}
