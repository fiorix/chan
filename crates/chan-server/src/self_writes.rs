//! Track watcher events that echo our own writes.
//!
//! Every successful chan-server write to the workspace (the editor's
//! save, file create, attachment upload, answer save, rename) fires
//! a notify event right back at us via the watcher. A save echoed as
//! an external edit makes the frontend try to reload the buffer the
//! user is still typing in.
//!
//! Each chan-server write notes its path here; WatchBroadcast checks
//! the newest live note before forwarding. A create, removal or rename
//! that names its writer's window reaches the other windows with that
//! source, while windowless notes and other event kinds are suppressed.
//! Entries expire after 1500 ms, empirically enough for the watcher burst
//! after an atomic rename on macOS FSEvents and Linux inotify.
//!
//! A genuine external event inside that window can inherit the newest
//! note: a windowless note hides it, and a name event may carry a window
//! even if another writer caused it. The editor's save flow still checks
//! conflicts with CAS.
//!
//! The note lookup is read-only: an entry is NOT consumed on
//! first match. notify often emits 2-3 events per logical write
//! (especially on macOS); a pop-on-match strategy would let the
//! second/third event through and re-trigger the bad behavior.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after a self-write the matching watcher event(s) are
/// suppressed. notify's coalesced delivery is well under 500 ms in
/// practice; 1500 ms is comfortable headroom for slow IO + a busy
/// CPU without swallowing too many external edits.
const SELF_WRITE_WINDOW: Duration = Duration::from_millis(1500);

#[derive(Debug)]
pub struct SelfWrites {
    inner: Mutex<VecDeque<SelfWriteEntry>>,
    window: Duration,
    next_id: AtomicU64,
}

#[derive(Debug)]
struct SelfWriteEntry {
    id: u64,
    path: String,
    source_w: Option<String>,
    noted_at: Instant,
}

/// What the newest live note for a path says about its writer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SelfWriteOrigin {
    Unnoted,
    Windowless,
    Window(String),
}

impl SelfWriteOrigin {
    #[cfg(test)]
    pub(crate) fn is_noted(&self) -> bool {
        !matches!(self, Self::Unnoted)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SelfWriteReservation {
    id: u64,
}

/// Open-time concurrency metadata carried by a raw text write.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct WritePreconditions {
    pub expected_mtime: Option<i64>,
    pub expected_mtime_ns: Option<i64>,
    pub authority_version: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WritePreconditionError {
    Required,
    Conflict,
}

/// Apply the one raw-text CAS matrix used by disk, document-session,
/// and scene-session writes.
///
/// Equal authority content is always safe to retry: callers still
/// force or confirm durability before returning success. Changed
/// content under a live authority requires both its version and an
/// open-time disk token. A disk-only write uses no-token last-write-wins
/// behavior.
pub(crate) fn check_write_preconditions(
    current_mtime_ns: Option<i64>,
    current_authority_version: Option<u64>,
    content_equal: bool,
    requested: WritePreconditions,
) -> Result<(), WritePreconditionError> {
    if content_equal {
        return Ok(());
    }
    if let Some(current_version) = current_authority_version {
        let Some(expected_version) = requested.authority_version else {
            return Err(WritePreconditionError::Required);
        };
        if expected_version != current_version {
            return Err(WritePreconditionError::Conflict);
        }
        if requested.expected_mtime_ns.is_none() && requested.expected_mtime.is_none() {
            return Err(WritePreconditionError::Required);
        }
    }
    let conflict = if let Some(expected) = requested.expected_mtime_ns {
        current_mtime_ns != Some(expected)
    } else if let Some(expected) = requested.expected_mtime {
        current_mtime_ns.map(|ns| ns / 1_000_000_000) != Some(expected)
    } else {
        false
    };
    if conflict {
        Err(WritePreconditionError::Conflict)
    } else {
        Ok(())
    }
}

impl Default for SelfWrites {
    fn default() -> Self {
        Self::with_window(SELF_WRITE_WINDOW)
    }
}

impl SelfWrites {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct with a custom window. Tests use a short window
    /// (microseconds / milliseconds) so eviction can be observed
    /// without sleeping past the production 1500 ms.
    pub fn with_window(window: Duration) -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
            window,
            next_id: AtomicU64::new(1),
        }
    }

    /// Record a server-side write. The path is the workspace-relative
    /// POSIX form returned by Workspace's accessors; the dedupe queue
    /// lives in that same coordinate system since the watcher's
    /// `WatchEvent.path` is also workspace-relative.
    pub fn note(&self, rel: &str) {
        self.note_from(rel, None);
    }

    /// Record a write made for a window. A missing writer keeps the legacy
    /// suppression behavior for server work with no requesting window.
    pub(crate) fn note_from(&self, rel: &str, source_w: Option<&str>) {
        self.reserve_from(rel, source_w);
    }

    /// `note` against an explicit clock reading, so tests drive
    /// synthetic times instead of sleeping.
    #[cfg(test)]
    fn note_at(&self, rel: &str, now: Instant) {
        self.reserve_from_at(rel, None, now);
    }

    /// Reserve after the caller has completed the canonical strict
    /// writability preflight. Streaming writers call this at the end
    /// of the body feed, immediately before fsync + rename, so the
    /// suppression window starts near the actual watcher event.
    pub(crate) fn reserve_after_preflight(&self, rel: &str) -> SelfWriteReservation {
        self.reserve(rel)
    }

    /// Reserve a suppression window for a write the caller is about to make,
    /// to be [`cancel`](Self::cancel)led if the write does not happen.
    pub(crate) fn reserve(&self, rel: &str) -> SelfWriteReservation {
        self.reserve_from(rel, None)
    }

    pub(crate) fn reserve_from(&self, rel: &str, source_w: Option<&str>) -> SelfWriteReservation {
        self.reserve_from_at(rel, source_w, Instant::now())
    }

    fn reserve_from_at(
        &self,
        rel: &str,
        source_w: Option<&str>,
        now: Instant,
    ) -> SelfWriteReservation {
        let mut q = self.inner.lock().expect("self-writes queue poisoned");
        evict_expired(&mut q, now, self.window);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        q.push_back(SelfWriteEntry {
            id,
            path: rel.to_string(),
            source_w: source_w.map(str::to_string),
            noted_at: now,
        });
        SelfWriteReservation { id }
    }

    /// Remove a reservation for a write that did not commit.
    pub(crate) fn cancel(&self, reservation: SelfWriteReservation) {
        let mut q = self.inner.lock().expect("self-writes queue poisoned");
        q.retain(|entry| entry.id != reservation.id);
    }

    /// True when `rel` has a live self-write note. Lookup does not consume
    /// the entry, so every event in a watcher's burst sees the same note.
    #[cfg(test)]
    pub fn should_suppress(&self, rel: &str) -> bool {
        self.should_suppress_at(rel, Instant::now())
    }

    /// `should_suppress` against an explicit clock reading, so tests
    /// drive synthetic times instead of sleeping.
    #[cfg(test)]
    fn should_suppress_at(&self, rel: &str, now: Instant) -> bool {
        self.origin_at(rel, now).is_noted()
    }

    pub(crate) fn origin(&self, rel: &str) -> SelfWriteOrigin {
        self.origin_at(rel, Instant::now())
    }

    /// The last live note for this path decides its writer.
    fn origin_at(&self, rel: &str, now: Instant) -> SelfWriteOrigin {
        let mut q = self.inner.lock().expect("self-writes queue poisoned");
        evict_expired(&mut q, now, self.window);
        match q.iter().rev().find(|entry| entry.path == rel) {
            None => SelfWriteOrigin::Unnoted,
            Some(entry) => match &entry.source_w {
                None => SelfWriteOrigin::Windowless,
                Some(window) => SelfWriteOrigin::Window(window.clone()),
            },
        }
    }
}

fn evict_expired(q: &mut VecDeque<SelfWriteEntry>, now: Instant, window: Duration) {
    while let Some(entry) = q.front() {
        if now.duration_since(entry.noted_at) > window {
            q.pop_front();
        } else {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_self_write_origin_decides_until_expiry() {
        let sw = SelfWrites::with_window(Duration::from_millis(20));
        let base = Instant::now();
        assert_eq!(sw.origin_at("notes/foo.md", base), SelfWriteOrigin::Unnoted);
        sw.reserve_from_at("notes/foo.md", Some("w-1"), base);
        assert_eq!(
            sw.origin_at("notes/foo.md", base),
            SelfWriteOrigin::Window("w-1".into())
        );
        sw.reserve_from_at("notes/foo.md", None, base + Duration::from_millis(1));
        assert_eq!(
            sw.origin_at("notes/foo.md", base + Duration::from_millis(1)),
            SelfWriteOrigin::Windowless
        );
        assert_eq!(
            sw.origin_at("notes/foo.md", base + Duration::from_millis(40)),
            SelfWriteOrigin::Unnoted
        );
    }

    #[test]
    fn unrecorded_path_passes_through() {
        let sw = SelfWrites::new();
        assert!(!sw.should_suppress("notes/foo.md"));
    }

    #[test]
    fn recorded_path_is_suppressed_within_window() {
        let sw = SelfWrites::new();
        sw.note("notes/foo.md");
        assert!(sw.should_suppress("notes/foo.md"));
        // Second lookup still suppresses (no consume-on-match): the
        // burst of notify events for one logical write all collapse.
        assert!(sw.should_suppress("notes/foo.md"));
    }

    #[test]
    fn unrelated_path_not_suppressed() {
        let sw = SelfWrites::new();
        sw.note("notes/foo.md");
        assert!(!sw.should_suppress("notes/bar.md"));
    }

    #[test]
    fn entry_expires_after_window() {
        let sw = SelfWrites::with_window(Duration::from_millis(20));
        let base = Instant::now();
        sw.note_at("notes/foo.md", base);
        assert!(!sw.should_suppress_at("notes/foo.md", base + Duration::from_millis(40)));
    }

    #[test]
    fn fresh_note_after_expiry_resuppresses() {
        let sw = SelfWrites::with_window(Duration::from_millis(20));
        let base = Instant::now();
        sw.note_at("notes/foo.md", base);
        sw.note_at("notes/foo.md", base + Duration::from_millis(40));
        assert!(sw.should_suppress_at("notes/foo.md", base + Duration::from_millis(45)));
    }

    #[test]
    fn live_changed_write_requires_version_and_disk_token() {
        let current = WritePreconditions {
            expected_mtime_ns: Some(10),
            authority_version: Some(3),
            ..WritePreconditions::default()
        };
        assert_eq!(
            check_write_preconditions(10.into(), 3.into(), false, WritePreconditions::default()),
            Err(WritePreconditionError::Required)
        );
        assert_eq!(
            check_write_preconditions(
                10.into(),
                3.into(),
                false,
                WritePreconditions {
                    authority_version: Some(3),
                    ..WritePreconditions::default()
                },
            ),
            Err(WritePreconditionError::Required)
        );
        assert_eq!(
            check_write_preconditions(10.into(), 3.into(), false, current),
            Ok(())
        );
    }

    #[test]
    fn stale_tokens_conflict_but_equal_content_is_retry_safe() {
        let stale = WritePreconditions {
            expected_mtime_ns: Some(9),
            authority_version: Some(2),
            ..WritePreconditions::default()
        };
        assert_eq!(
            check_write_preconditions(10.into(), 3.into(), false, stale),
            Err(WritePreconditionError::Conflict)
        );
        assert_eq!(
            check_write_preconditions(10.into(), 3.into(), true, stale),
            Ok(())
        );
    }
}
