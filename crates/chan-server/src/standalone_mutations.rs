//! Deterministic mutation attribution for the standalone filesystem surface.
//!
//! A tenant-global suppressor like [`crate::self_writes::SelfWrites`] would
//! hide one window's save from every other window on the shared tenant, and
//! those windows must relist. This bus replaces drop-the-echo
//! with tag-and-forward: a mutating route opens a ticket BEFORE touching the
//! disk, the watch manager suppresses the raw OS echoes matched to that live
//! ticket, and a successful commit emits deterministic synthetic `fs` frames
//! carrying the writer's window id (`source_w`). Every receiving window
//! relists; only the writer skips the external-change marking on its own
//! clean buffers. A failed mutation cancels the ticket immediately so a real
//! external event can never hide behind a write that did not happen.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chan_workspace::WatchEvent;

use crate::bus::ScopeRegistry;

/// How long a ticket keeps suppressing raw echoes after its last activity
/// (begin, a matched echo, or commit). Matches the window the workspace
/// self-write dedupe uses: notify delivers a logical write's echoes well
/// inside it, and anything later is treated as a genuine external change.
const TICKET_WINDOW: Duration = Duration::from_millis(1500);

/// Raw-echo allowance per expected path. notify emits two to three events
/// per logical write (create, modify, close-write flavors); the per-path
/// count bounds over-suppression so a stale ticket cannot swallow a stream
/// of genuine external edits to the same path.
const ECHOES_PER_PATH: u32 = 3;

/// One in-flight mutation, returned by [`StandaloneMutationBus::begin`] and
/// consumed by `commit` or `cancel`.
#[derive(Debug)]
pub struct MutationTicket {
    id: u64,
}

struct TicketState {
    /// The writer's window id, stamped on the synthetic frames at commit.
    source_w: String,
    /// Remaining raw-echo allowance per expected wire path.
    remaining: HashMap<String, u32>,
    /// Last activity; the sweep drops tickets idle past [`TICKET_WINDOW`].
    touched: Instant,
}

#[derive(Default)]
struct BusInner {
    tickets: HashMap<u64, TicketState>,
}

/// The begin/commit/cancel transaction the standalone mutation routes wrap
/// around their disk work. Shared between those routes and the watch
/// manager's event path.
pub struct StandaloneMutationBus {
    next_id: AtomicU64,
    inner: Mutex<BusInner>,
    registry: Arc<ScopeRegistry>,
}

impl StandaloneMutationBus {
    pub fn new(registry: Arc<ScopeRegistry>) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            inner: Mutex::new(BusInner::default()),
            registry,
        }
    }

    /// Open a ticket for a mutation `source_w` is about to perform on
    /// `expected_paths` (wire-relative; a rename passes BOTH endpoints).
    /// Must run before the first disk syscall so the watcher thread cannot
    /// observe an untracked echo.
    pub fn begin(&self, source_w: &str, expected_paths: &[String]) -> MutationTicket {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let remaining = expected_paths
            .iter()
            .map(|path| (path.clone(), ECHOES_PER_PATH))
            .collect();
        let mut inner = self.lock();
        Self::sweep(&mut inner);
        inner.tickets.insert(
            id,
            TicketState {
                source_w: source_w.to_string(),
                remaining,
                touched: Instant::now(),
            },
        );
        MutationTicket { id }
    }

    /// The mutation succeeded: emit one deterministic attributed `fs` frame
    /// per change, then leave the ticket live (echo suppression only) until
    /// its idle window expires. The synthetic frames are the authoritative
    /// signal every subscribed window relists on; the raw OS echoes for the
    /// same change are redundant and stay suppressed.
    pub fn commit(&self, ticket: MutationTicket, changes: Vec<WatchEvent>) {
        let source_w = {
            let mut inner = self.lock();
            let Some(state) = inner.tickets.get_mut(&ticket.id) else {
                return;
            };
            state.touched = Instant::now();
            state.source_w.clone()
        };
        for change in &changes {
            self.registry.emit_fs_attributed(change, Some(&source_w));
        }
    }

    /// The mutation failed: drop the suppression state immediately so a
    /// concurrent genuine change to the same paths surfaces as external.
    pub fn cancel(&self, ticket: MutationTicket) {
        self.lock().tickets.remove(&ticket.id);
    }

    /// Whether a raw OS event is the echo of a live ticket's mutation. A
    /// match decrements that path's allowance; an unmatched event (no live
    /// ticket, an exhausted allowance, or an unexpected path) always passes
    /// through as external.
    ///
    /// The atomic writer also churns a same-directory temporary, which the
    /// watcher sees as a file appearing and vanishing beside the target. That
    /// noise is suppressed by name shape, but ONLY in a directory where a
    /// mutation is actually in flight, so a user file that merely looks like
    /// a temporary still reports its own changes.
    pub fn suppress_raw(&self, event: &WatchEvent) -> bool {
        let mut inner = self.lock();
        Self::sweep(&mut inner);
        if Self::is_temp_churn(&inner, event) {
            return true;
        }
        let mut suppressed = false;
        for state in inner.tickets.values_mut() {
            for path in [event.path.as_deref(), event.to.as_deref()]
                .into_iter()
                .flatten()
            {
                if let Some(remaining) = state.remaining.get_mut(path) {
                    if *remaining > 0 {
                        *remaining -= 1;
                        state.touched = Instant::now();
                        suppressed = true;
                    }
                }
            }
            if suppressed {
                break;
            }
        }
        suppressed
    }

    /// Whether every path this event names is an atomic-write temporary in a
    /// directory that currently has a live ticket.
    fn is_temp_churn(inner: &BusInner, event: &WatchEvent) -> bool {
        let paths: Vec<&str> = [event.path.as_deref(), event.to.as_deref()]
            .into_iter()
            .flatten()
            .collect();
        if paths.is_empty() {
            return false;
        }
        paths.iter().all(|path| {
            let (dir, name) = match path.rsplit_once('/') {
                Some((dir, name)) => (dir, name),
                None => ("", *path),
            };
            chan_workspace::fs_ops::is_atomic_write_temp_name(name)
                && inner.tickets.values().any(|state| {
                    state.remaining.keys().any(|expected| {
                        let expected_dir = match expected.rsplit_once('/') {
                            Some((expected_dir, _)) => expected_dir,
                            None => "",
                        };
                        expected_dir == dir
                    })
                })
        })
    }

    fn sweep(inner: &mut BusInner) {
        let now = Instant::now();
        inner
            .tickets
            .retain(|_, state| now.duration_since(state.touched) < TICKET_WINDOW);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BusInner> {
        // Map bookkeeping only; recover a poisoned lock like the rest of
        // chan-server's registries.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_workspace::{WatchKind, WorkspaceGeneration};
    use tokio::sync::mpsc;

    fn modified(path: &str) -> WatchEvent {
        WatchEvent::file(WatchKind::Modified, path, WorkspaceGeneration::default())
    }

    fn bus_with_subscriber(dir: &str) -> (StandaloneMutationBus, mpsc::UnboundedReceiver<String>) {
        let registry = Arc::new(ScopeRegistry::new());
        let (id, rx) = registry.register();
        registry.subscribe(id, dir);
        (StandaloneMutationBus::new(registry), rx)
    }

    #[test]
    fn commit_emits_attributed_frames_and_keeps_suppressing_echoes() {
        let (bus, mut rx) = bus_with_subscriber("home/u");
        let ticket = bus.begin("w-writer", &["home/u/note.md".to_string()]);
        // The raw echo racing the write is suppressed while the ticket lives.
        assert!(bus.suppress_raw(&modified("home/u/note.md")));
        bus.commit(ticket, vec![modified("home/u/note.md")]);
        let frame: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("synthetic frame")).unwrap();
        assert_eq!(frame["type"], "fs");
        assert_eq!(frame["dir"], "home/u");
        assert_eq!(frame["source_w"], "w-writer");
        assert_eq!(frame["event"]["path"], "home/u/note.md");
        // Post-commit echoes of the same write stay suppressed.
        assert!(bus.suppress_raw(&modified("home/u/note.md")));
    }

    #[test]
    fn cancel_removes_suppression_immediately() {
        let (bus, mut rx) = bus_with_subscriber("home/u");
        let ticket = bus.begin("w-writer", &["home/u/note.md".to_string()]);
        bus.cancel(ticket);
        assert!(
            !bus.suppress_raw(&modified("home/u/note.md")),
            "a cancelled mutation must not swallow a genuine external event"
        );
        assert!(rx.try_recv().is_err(), "cancel emits nothing");
    }

    #[test]
    fn atomic_write_temporaries_are_suppressed_only_while_a_write_is_in_flight() {
        let (bus, _rx) = bus_with_subscriber("home/u");
        // cap-tempfile's named temporary and the backend's unlinked-handle
        // form, both beside the file being written.
        let uuid_temp = modified("home/u/025cbbfa-88ee-49f1-92bc-630000cb6294");
        let inode_temp = modified("home/u/#429785");
        // With no write in flight they are ordinary files: a user may really
        // have one named like this, and its changes must reach the browser.
        assert!(!bus.suppress_raw(&uuid_temp));
        assert!(!bus.suppress_raw(&inode_temp));

        let ticket = bus.begin("w-writer", &["home/u/note.md".to_string()]);
        assert!(bus.suppress_raw(&uuid_temp));
        assert!(bus.suppress_raw(&inode_temp));
        // A temporary-shaped name in a DIFFERENT directory is unrelated to
        // this write and still reports.
        assert!(!bus.suppress_raw(&modified("etc/025cbbfa-88ee-49f1-92bc-630000cb6294")));
        // Ordinary neighbours keep reporting throughout.
        assert!(!bus.suppress_raw(&modified("home/u/other.md")));
        bus.cancel(ticket);
        assert!(!bus.suppress_raw(&uuid_temp));
    }

    #[test]
    fn unmatched_paths_always_pass_through() {
        let (bus, _rx) = bus_with_subscriber("home/u");
        let _ticket = bus.begin("w-writer", &["home/u/note.md".to_string()]);
        assert!(
            !bus.suppress_raw(&modified("home/u/other.md")),
            "an unexpected path is external even while a ticket is live"
        );
    }

    #[test]
    fn per_path_allowance_bounds_suppression() {
        let (bus, _rx) = bus_with_subscriber("home/u");
        let _ticket = bus.begin("w-writer", &["home/u/note.md".to_string()]);
        for _ in 0..ECHOES_PER_PATH {
            assert!(bus.suppress_raw(&modified("home/u/note.md")));
        }
        assert!(
            !bus.suppress_raw(&modified("home/u/note.md")),
            "an exhausted allowance passes further events through as external"
        );
    }

    #[test]
    fn rename_tickets_cover_both_endpoints() {
        let (bus, _rx) = bus_with_subscriber("home/u");
        let _ticket = bus.begin(
            "w-writer",
            &["home/u/from.md".to_string(), "home/u/to.md".to_string()],
        );
        let rename = WatchEvent::rename(
            Some("home/u/from.md".to_string()),
            Some("home/u/to.md".to_string()),
            false,
            None,
            WorkspaceGeneration::default(),
        );
        assert!(bus.suppress_raw(&rename));
    }
}
