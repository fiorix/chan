//! Per-key token bucket with a bounded map of in-flight keys.
//!
//! Shared by `devserver-proxy::throttle_validator` (wraps a `Validator`)
//! and `identity::token_throttle` (called directly from the validate
//! handler). Both throttles run the same shape: hash the candidate
//! token to a 64-bit fingerprint, look up its bucket, refill at a
//! constant rate, and admit one request when the bucket has >= 1
//! token. The map is capped so a brute-force loop with random tokens
//! cannot exhaust memory; the LRU-style eviction picks the
//! least-recently-touched bucket at saturation.
//!
//! Hashing uses `std::collections::hash_map::DefaultHasher` (SipHash).
//! Not cryptographic. The map only lives in-process and the hashed
//! key never leaves; we just need a well-distributed bucket id.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Default refill rate (tokens per second) per fingerprint, shared by
/// the two validate throttles (devserver-proxy's, which meters tunnel
/// dial validation and lease refresh, and identity's
/// `/internal/v1/tokens/validate`). The two are documented
/// defense-in-depth twins; sourcing the limits here keeps them from
/// drifting apart.
pub const DEFAULT_REFILL_PER_SEC: f32 = 4.0;

/// Default bucket capacity (burst) per fingerprint.
pub const DEFAULT_CAPACITY: f32 = 16.0;

/// Default cap on tracked fingerprints. An attacker hammering with
/// random tokens can fill the map; the cap bounds memory and the
/// eviction step. 4096 is well above the steady-state working set
/// (one entry per active PAT in the wild) and small enough that the
/// O(n) eviction scan is negligible.
pub const DEFAULT_MAP_CAP: usize = 4096;

#[derive(Clone)]
pub struct TokenBucket {
    state: Arc<Mutex<State>>,
    refill_per_sec: f32,
    capacity: f32,
    map_cap: usize,
}

struct State {
    buckets: HashMap<u64, Bucket>,
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f32,
    last: Instant,
}

impl TokenBucket {
    /// `refill_per_sec`: tokens added per second per fingerprint.
    /// `capacity`: bucket size (burst).
    /// `map_cap`: maximum distinct fingerprints tracked at once.
    pub fn new(refill_per_sec: f32, capacity: f32, map_cap: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                buckets: HashMap::new(),
            })),
            refill_per_sec,
            capacity,
            map_cap,
        }
    }

    /// 64-bit SipHash of the candidate token. Exposed so callers can
    /// pre-fingerprint (e.g. for log lines) without re-hashing.
    pub fn fingerprint(token: &str) -> u64 {
        let mut h = DefaultHasher::new();
        token.hash(&mut h);
        h.finish()
    }

    /// Returns `true` when a token has been consumed for `fp`,
    /// `false` when the bucket is empty. Callers map `false` to the
    /// same on-the-wire shape "unknown token" returns, so the
    /// throttle is not observable.
    pub fn try_admit_fp(&self, fp: u64, now: Instant) -> bool {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !st.buckets.contains_key(&fp) && st.buckets.len() >= self.map_cap {
            // O(n) over the map; `map_cap` is small and this only
            // fires at saturation, well past what a real attacker
            // would bear at this rate.
            if let Some(oldest) = st
                .buckets
                .iter()
                .min_by_key(|(_, b)| b.last)
                .map(|(k, _)| *k)
            {
                st.buckets.remove(&oldest);
            }
        }
        // New fingerprints start with one token, not a full burst. An
        // attacker rotating fingerprints would otherwise re-enter at
        // `capacity` after each LRU eviction, accumulating `map_cap *
        // capacity` accepted requests against the upstream. Starting
        // at 1.0 admits the first request and forces every subsequent
        // request from the same fingerprint to wait for refill.
        let b = st.buckets.entry(fp).or_insert(Bucket {
            tokens: 1.0,
            last: now,
        });
        let elapsed = now.saturating_duration_since(b.last).as_secs_f32();
        b.tokens = (b.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Convenience: fingerprint + admit at `Instant::now()`.
    pub fn try_admit(&self, token: &str) -> bool {
        self.try_admit_fp(Self::fingerprint(token), Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn fresh_fingerprint_admits_once_then_requires_refill() {
        // New buckets start at 1.0, not capacity. First request admits;
        // subsequent immediate requests must wait for refill.
        let t = TokenBucket::new(4.0, 3.0, 16);
        assert!(t.try_admit("pat_a"));
        assert!(!t.try_admit("pat_a"));
    }

    #[test]
    fn refilled_bucket_can_burst_up_to_capacity() {
        let t = TokenBucket::new(1.0, 3.0, 16);
        let fp = TokenBucket::fingerprint("pat_a");
        // Seed past-burst state so this test does not need a sleep.
        {
            let mut st = t.state.lock().unwrap();
            st.buckets.insert(
                fp,
                Bucket {
                    tokens: 3.0,
                    last: Instant::now(),
                },
            );
        }
        for _ in 0..3 {
            assert!(t.try_admit("pat_a"));
        }
        assert!(!t.try_admit("pat_a"));
    }

    #[test]
    fn distinct_tokens_have_distinct_buckets() {
        let t = TokenBucket::new(4.0, 1.0, 16);
        assert!(t.try_admit("pat_a"));
        assert!(!t.try_admit("pat_a"));
        assert!(t.try_admit("pat_b"));
    }

    #[test]
    fn idle_bucket_clamps_at_capacity() {
        // Regression guard: a dormant fingerprint must not accumulate
        // more than `capacity` tokens.
        let t = TokenBucket::new(1.0, 2.0, 16);
        assert!(t.try_admit("pat_z"));
        {
            let mut st = t.state.lock().unwrap();
            let fp = TokenBucket::fingerprint("pat_z");
            let b = st.buckets.get_mut(&fp).unwrap();
            b.last = Instant::now() - Duration::from_secs(3600);
            b.tokens = 0.0;
        }
        assert!(t.try_admit("pat_z"));
        assert!(t.try_admit("pat_z"));
        assert!(!t.try_admit("pat_z"));
    }

    #[test]
    fn map_eviction_preserves_admission() {
        let t = TokenBucket::new(4.0, 1.0, 4);
        for i in 0..8 {
            let key = format!("pat_{i}");
            assert!(t.try_admit(&key), "token {key} should admit");
        }
    }
}
