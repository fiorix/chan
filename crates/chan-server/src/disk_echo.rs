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
//! Each session keeps a ring of hashes of content it has put on, or
//! adopted from, disk. A disk read whose hash is in the ring is bytes
//! this session has already accounted for, no matter what the mtime
//! says. The reconciler adopts the token and keeps the authority while
//! the entry is live. A divergent observation remains scheduled so
//! bytes that persist past expiry fold as durable external state.
//!
//! A RING, not just the last entry: a stale read can serve content
//! from several writes ago (upload queues), so recent history must
//! match too.
//!
//! Entries carry their ORIGIN, because the two kinds age differently.
//! An async-committing filesystem can replay bytes this session WROTE
//! for as long as its upload queue runs, so those need a wide window.
//! Bytes this session merely ADOPTED from disk can only come back via a
//! stale read racing the watcher event that announced them, which is a
//! burst-scale effect. Holding adopted bytes for the write window is
//! what makes an external edit that restores recently-seen content look
//! like an echo: `# Hello` -> `# Hello world` -> `# Hello` is the shape
//! every undo, revert, and git checkout takes, and agents editing files
//! through the filesystem hit it constantly. Separating the windows
//! keeps the lying-filesystem defense where it is earned and lets an
//! honest restore converge at watcher speed.
//!
//! Not thread-safe by design: each ring lives inside its session's
//! state mutex.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// How long content this session WROTE keeps matching. Flushes are at
/// least the flush debounce (800 ms) apart, so the cap covers far more
/// history than any plausible echo lag; this TTL is what bounds the
/// window in which our own bytes can come back under a re-stamped
/// mtime.
const DISK_ECHO_WRITE_TTL: Duration = Duration::from_secs(60);

/// How long content this session ADOPTED from disk keeps matching.
/// Only a stale read racing the announcing watcher event can serve
/// these back, so this covers an event burst rather than an upload
/// queue. It also bounds how long an honest external restore is
/// deferred, which is why it is small.
const DISK_ECHO_ADOPT_TTL: Duration = Duration::from_millis(1500);

/// Entry cap; eviction is oldest-first. 16 entries at the 800 ms
/// flush floor is ~13 s of maximum-rate history, plenty for watcher
/// echo bursts while keeping the ring trivially small.
const DISK_ECHO_CAP: usize = 16;

/// Where a ring entry's bytes came from. Written bytes are the ones an
/// async-committing filesystem can replay; adopted bytes are not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EchoOrigin {
    /// This session wrote these bytes to disk.
    Written,
    /// This session read these bytes from disk and took them as truth.
    Adopted,
}

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
    inner: VecDeque<(u64, EchoOrigin, Instant)>,
    write_ttl: Duration,
    adopt_ttl: Duration,
}

impl Default for DiskEchoRing {
    fn default() -> Self {
        Self::with_ttls(DISK_ECHO_WRITE_TTL, DISK_ECHO_ADOPT_TTL)
    }
}

impl DiskEchoRing {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct with custom TTLs. Tests use short ones and explicit
    /// instants to exercise expiry without wall-clock waits.
    pub fn with_ttls(write_ttl: Duration, adopt_ttl: Duration) -> Self {
        Self {
            inner: VecDeque::new(),
            write_ttl,
            adopt_ttl,
        }
    }

    /// Record content this session just wrote to disk.
    pub fn note_written(&mut self, hash: u64) {
        self.note_at(hash, EchoOrigin::Written, Instant::now());
    }

    /// Record content this session just adopted from disk.
    pub fn note_adopted(&mut self, hash: u64) {
        self.note_at(hash, EchoOrigin::Adopted, Instant::now());
    }

    fn note_at(&mut self, hash: u64, origin: EchoOrigin, now: Instant) {
        self.evict(now);
        while self.inner.len() >= DISK_ECHO_CAP {
            self.inner.pop_front();
        }
        self.inner.push_back((hash, origin, now));
    }

    /// True when `hash` matches content this session wrote or adopted
    /// within that entry's window. Lookup does not consume or refresh
    /// the entry: refreshing on match would let a repeating echo extend
    /// its own window indefinitely.
    pub fn contains(&mut self, hash: u64) -> bool {
        self.contains_at(hash, Instant::now())
    }

    fn contains_at(&mut self, hash: u64, now: Instant) -> bool {
        self.evict(now);
        self.inner.iter().any(|(h, _, _)| *h == hash)
    }

    /// True when this session wrote to disk recently enough that a
    /// suspicious observation (an empty read) may be an in-flight-write
    /// artifact rather than a real external edit. Adopted entries do
    /// not count: reading bytes never put an upload queue in flight, so
    /// they are no reason to distrust a truncation.
    pub fn any_recent_write(&mut self) -> bool {
        self.any_recent_write_at(Instant::now())
    }

    fn any_recent_write_at(&mut self, now: Instant) -> bool {
        self.evict(now);
        self.inner
            .iter()
            .any(|(_, origin, _)| *origin == EchoOrigin::Written)
    }

    #[cfg(test)]
    pub(crate) fn test_age_by(&mut self, age: Duration) {
        self.evict(Instant::now() + age);
    }

    fn evict(&mut self, now: Instant) {
        // Mixed windows mean age order is not expiry order, so this
        // cannot pop from the front the way a single-TTL ring would.
        let (write_ttl, adopt_ttl) = (self.write_ttl, self.adopt_ttl);
        self.inner.retain(|(_, origin, t)| {
            let ttl = match origin {
                EchoOrigin::Written => write_ttl,
                EchoOrigin::Adopted => adopt_ttl,
            };
            now.duration_since(*t) <= ttl
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_hash_does_not_match() {
        let mut ring = DiskEchoRing::new();
        assert!(!ring.contains(content_hash("x")));
        assert!(!ring.any_recent_write());
    }

    #[test]
    fn content_hash_is_stable_across_toolchains_and_restarts() {
        assert_eq!(content_hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(content_hash("hello"), 0xa430_d846_80aa_bd0b);
    }

    #[test]
    fn noted_hash_matches_and_is_not_consumed() {
        let mut ring = DiskEchoRing::new();
        ring.note_written(content_hash("hello"));
        assert!(ring.contains(content_hash("hello")));
        assert!(ring.contains(content_hash("hello")));
        assert!(!ring.contains(content_hash("other")));
        assert!(ring.any_recent_write());
    }

    #[test]
    fn history_matches_not_just_last() {
        let mut ring = DiskEchoRing::new();
        ring.note_written(content_hash("v1"));
        ring.note_written(content_hash("v2"));
        ring.note_written(content_hash("v3"));
        assert!(ring.contains(content_hash("v1")));
        assert!(ring.contains(content_hash("v3")));
    }

    #[test]
    fn entries_expire_after_ttl() {
        let mut ring =
            DiskEchoRing::with_ttls(Duration::from_millis(20), Duration::from_millis(20));
        let now = Instant::now();
        ring.note_at(content_hash("v1"), EchoOrigin::Written, now);
        let after_ttl = now + Duration::from_millis(40);
        assert!(!ring.contains_at(content_hash("v1"), after_ttl));
        assert!(!ring.any_recent_write_at(after_ttl));
    }

    #[test]
    fn cap_evicts_oldest_first() {
        let mut ring = DiskEchoRing::new();
        for i in 0..(DISK_ECHO_CAP + 1) {
            ring.note_written(content_hash(&format!("v{i}")));
        }
        assert!(!ring.contains(content_hash("v0")), "oldest evicted");
        assert!(ring.contains(content_hash(&format!("v{DISK_ECHO_CAP}"))));
    }

    #[test]
    fn adopted_entries_expire_before_written_ones() {
        // The reported bug: an external edit restoring recently adopted
        // content was held for the full write window, so `# Hello` ->
        // `# Hello world` -> `# Hello` never converged in the editor.
        let mut ring =
            DiskEchoRing::with_ttls(Duration::from_millis(400), Duration::from_millis(20));
        let now = Instant::now();
        ring.note_at(content_hash("flushed"), EchoOrigin::Written, now);
        ring.note_at(content_hash("restored"), EchoOrigin::Adopted, now);
        let after_adopt_ttl = now + Duration::from_millis(60);
        assert!(
            !ring.contains_at(content_hash("restored"), after_adopt_ttl),
            "an adopted entry stops protecting quickly so restores converge"
        );
        assert!(
            ring.contains_at(content_hash("flushed"), after_adopt_ttl),
            "our own written bytes keep the wide replay window"
        );
    }

    #[test]
    fn adopted_entries_never_justify_distrusting_a_truncation() {
        let mut ring = DiskEchoRing::new();
        ring.note_adopted(content_hash("read from disk"));
        assert!(ring.contains(content_hash("read from disk")));
        assert!(
            !ring.any_recent_write(),
            "reading bytes puts no write in flight, so an empty read is not suspect"
        );
        ring.note_written(content_hash("we wrote this"));
        assert!(ring.any_recent_write());
    }

    #[test]
    fn eviction_handles_mixed_windows_out_of_age_order() {
        // Written-then-adopted insertion order means the older entry
        // outlives the newer one; a front-popping evictor would stop at
        // the live written entry and leak the expired adopted one.
        let mut ring =
            DiskEchoRing::with_ttls(Duration::from_millis(400), Duration::from_millis(20));
        let now = Instant::now();
        ring.note_at(content_hash("early written"), EchoOrigin::Written, now);
        ring.note_at(
            content_hash("late adopted"),
            EchoOrigin::Adopted,
            now + Duration::from_millis(1),
        );
        let after_adopt_ttl = now + Duration::from_millis(60);
        assert!(!ring.contains_at(content_hash("late adopted"), after_adopt_ttl));
        assert!(ring.contains_at(content_hash("early written"), after_adopt_ttl));
    }
}
