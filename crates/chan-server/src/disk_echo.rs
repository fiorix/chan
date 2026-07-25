//! Content-hash ring for telling a session's own disk writes apart
//! from external edits.
//!
//! The doc/scene reconcilers fold "the disk changed" back into live
//! sessions. Their mtime token alone cannot be trusted for that
//! decision: filesystems exist (Google Drive FUSE clients among them)
//! that re-stamp mtime asynchronously after a write commits upstream,
//! and that serve stale or empty content for a read that follows a
//! write. Both make the session's OWN flush echo look like an external
//! edit, and folding that echo back in destroys live user state.
//!
//! Each session keeps a ring of hashes of every content it has itself
//! put on (or adopted from) disk: the attach seed, every successful
//! flush, every reconciled merge. A disk read whose hash is in the
//! ring is our own bytes coming back, no matter what the mtime says.
//! The reconciler adopts the token and keeps the authority while the
//! entry is live. A divergent observation remains scheduled so bytes
//! that persist past expiry fold as durable external state.
//!
//! A RING, not just the last flush: a stale read can serve content
//! from several writes ago (upload queues), so recent history must
//! match too. Entries expire so the window in which an external edit
//! that byte-exactly restores recently-flushed content is deferred
//! stays bounded; that temporary over-suppression is the same class as
//! the coarser `SelfWrites` path dedupe.
//!
//! Not thread-safe by design: each ring lives inside its session's
//! state mutex.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How long a self-written content hash keeps matching. Flushes are
/// at least the flush debounce (800 ms) apart, so the default cap
/// covers far more history than any plausible echo lag; the TTL is
/// what bounds the external-restore swallow window.
const DISK_ECHO_TTL: Duration = Duration::from_secs(60);

/// Entry cap; eviction is oldest-first. 16 entries at the 800 ms
/// flush floor is ~13 s of maximum-rate history, plenty for watcher
/// echo bursts while keeping the ring trivially small.
const DISK_ECHO_CAP: usize = 16;

/// Version-stable FNV-1a hash of session/file content. The durable recovery
/// record persists baseline hashes across processes and toolchain upgrades, so
/// the algorithm cannot depend on `DefaultHasher`. Collision resistance is not
/// a security requirement here: a collision only defers one external fold-in.
pub(crate) fn content_hash(text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[derive(Debug)]
pub(crate) struct DiskEchoRing {
    inner: VecDeque<(u64, Instant)>,
    ttl: Duration,
}

impl Default for DiskEchoRing {
    fn default() -> Self {
        Self::with_ttl(DISK_ECHO_TTL)
    }
}

impl DiskEchoRing {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct with a custom TTL. Tests use a short TTL so expiry
    /// can be observed without sleeping through the production 60 s.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: VecDeque::new(),
            ttl,
        }
    }

    /// Record content this session just put on (or adopted from) disk.
    pub fn note(&mut self, hash: u64) {
        let now = Instant::now();
        self.evict(now);
        while self.inner.len() >= DISK_ECHO_CAP {
            self.inner.pop_front();
        }
        self.inner.push_back((hash, now));
    }

    /// True when `hash` matches content this session wrote or adopted
    /// within the TTL. Lookup does not consume or refresh the entry:
    /// refreshing on match would let a repeating echo extend its own
    /// window indefinitely.
    pub fn contains(&mut self, hash: u64) -> bool {
        self.evict(Instant::now());
        self.inner.iter().any(|(h, _)| *h == hash)
    }

    /// True when any entry is still live: the session wrote to disk
    /// recently, so a suspicious observation (an empty read) may be an
    /// in-flight-write artifact rather than a real external edit.
    pub fn any_recent(&mut self) -> bool {
        self.evict(Instant::now());
        !self.inner.is_empty()
    }

    fn evict(&mut self, now: Instant) {
        while let Some(&(_, t)) = self.inner.front() {
            if now.duration_since(t) > self.ttl {
                self.inner.pop_front();
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn unknown_hash_does_not_match() {
        let mut ring = DiskEchoRing::new();
        assert!(!ring.contains(content_hash("x")));
        assert!(!ring.any_recent());
    }

    #[test]
    fn content_hash_is_stable_across_toolchains_and_restarts() {
        assert_eq!(content_hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(content_hash("hello"), 0xa430_d846_80aa_bd0b);
    }

    #[test]
    fn noted_hash_matches_and_is_not_consumed() {
        let mut ring = DiskEchoRing::new();
        ring.note(content_hash("hello"));
        assert!(ring.contains(content_hash("hello")));
        assert!(ring.contains(content_hash("hello")));
        assert!(!ring.contains(content_hash("other")));
        assert!(ring.any_recent());
    }

    #[test]
    fn history_matches_not_just_last() {
        let mut ring = DiskEchoRing::new();
        ring.note(content_hash("v1"));
        ring.note(content_hash("v2"));
        ring.note(content_hash("v3"));
        assert!(ring.contains(content_hash("v1")));
        assert!(ring.contains(content_hash("v3")));
    }

    #[test]
    fn entries_expire_after_ttl() {
        let mut ring = DiskEchoRing::with_ttl(Duration::from_millis(20));
        ring.note(content_hash("v1"));
        sleep(Duration::from_millis(40));
        assert!(!ring.contains(content_hash("v1")));
        assert!(!ring.any_recent());
    }

    #[test]
    fn cap_evicts_oldest_first() {
        let mut ring = DiskEchoRing::new();
        for i in 0..(DISK_ECHO_CAP + 1) {
            ring.note(content_hash(&format!("v{i}")));
        }
        assert!(!ring.contains(content_hash("v0")), "oldest evicted");
        assert!(ring.contains(content_hash(&format!("v{DISK_ECHO_CAP}"))));
    }
}
