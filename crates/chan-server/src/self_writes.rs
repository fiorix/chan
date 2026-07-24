//! Suppress watcher events that echo our own writes.
//!
//! Every successful chan-server write to the workspace (the editor's
//! save, file create, attachment upload, answer save, rename) fires
//! a notify event right back at us via the watcher. Forwarding those
//! over the WebSocket would make every save look like an external
//! edit to the frontend, which then tries to reload the buffer the
//! user is still typing in. Bad UX.
//!
//! Each chan-server write notes its path here; WatchBroadcast checks
//! membership before forwarding. Entries TTL out after 1500 ms,
//! which is the empirical headroom on macOS FSEvents + Linux inotify
//! for the OS-delivered Modify event after our atomic rename.
//!
//! Trade-off: a genuine external edit landing within 1500 ms of our
//! own write also gets suppressed. The next watcher event from the
//! external edit (if any) surfaces normally, and the editor's save
//! flow already does a CAS check on top, so the worst case is "the
//! conflict prompt fires on the user's next save instead of the
//! moment the external edit arrived".
//!
//! The membership check is read-only: an entry is NOT consumed on
//! first match. notify often emits 2-3 events per logical write
//! (especially on macOS); a pop-on-match strategy would let the
//! second/third event through and re-trigger the bad behavior.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chan_workspace::{ChanError, Workspace};

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
    noted_at: Instant,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SelfWriteReservation {
    id: u64,
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
        self.reserve(rel);
    }

    /// Verify that an atomic replacement can create its temporary
    /// file, then reserve watcher suppression before the real write.
    /// The caller cancels the reservation if the write later fails.
    pub(crate) fn reserve_if_writable(
        &self,
        workspace: &Workspace,
        rel: &str,
    ) -> chan_workspace::Result<SelfWriteReservation> {
        let target = workspace.resolve_physical_path(rel)?;
        let parent = target.parent().ok_or(ChanError::PathEmpty)?;
        crate::routes::transfer::verify_writable_dir(parent).map_err(ChanError::Io)?;
        Ok(self.reserve(rel))
    }

    fn reserve(&self, rel: &str) -> SelfWriteReservation {
        let now = Instant::now();
        let mut q = self.inner.lock().expect("self-writes queue poisoned");
        evict_expired(&mut q, now, self.window);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        q.push_back(SelfWriteEntry {
            id,
            path: rel.to_string(),
            noted_at: now,
        });
        SelfWriteReservation { id }
    }

    /// Remove a reservation for a write that did not commit.
    pub(crate) fn cancel(&self, reservation: SelfWriteReservation) {
        let mut q = self.inner.lock().expect("self-writes queue poisoned");
        q.retain(|entry| entry.id != reservation.id);
    }

    /// True when `rel` was written by chan-server within the dedupe
    /// window. Idempotent: lookup does NOT consume the entry, so
    /// notify's per-write event burst (often 2-3 events on macOS)
    /// is suppressed in full.
    pub fn should_suppress(&self, rel: &str) -> bool {
        let now = Instant::now();
        let mut q = self.inner.lock().expect("self-writes queue poisoned");
        evict_expired(&mut q, now, self.window);
        q.iter().any(|entry| entry.path == rel)
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
    use std::thread::sleep;

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
        sw.note("notes/foo.md");
        sleep(Duration::from_millis(40));
        assert!(!sw.should_suppress("notes/foo.md"));
    }

    #[test]
    fn fresh_note_after_expiry_resuppresses() {
        let sw = SelfWrites::with_window(Duration::from_millis(20));
        sw.note("notes/foo.md");
        sleep(Duration::from_millis(40));
        sw.note("notes/foo.md");
        assert!(sw.should_suppress("notes/foo.md"));
    }
}
