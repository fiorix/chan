//! Bridges chan-workspace watcher/progress callbacks into the shared
//! `events_tx` JSON broadcast channel.
//!
//! Both producers fan into one channel; each frame carries a `type`
//! discriminator so the frontend can route on it. Watcher events also
//! get forwarded to the indexer's raw-event channel -- the indexer
//! does NOT honor the self-write dedupe, since in-app saves must
//! reindex.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chan_workspace::{ProgressCallback, ProgressEvent, WatchCallback, WatchEvent};
use tokio::sync::{broadcast, mpsc};

use crate::self_writes::SelfWrites;

/// Construct a watcher bridge. Extracted so /api/storage/reset can
/// rebuild one cheaply when re-attaching the watcher to a fresh
/// Workspace instance.
///
/// The bridge fans out every event to two consumers:
///
///   - `events_tx`: pre-serialized JSON frames forwarded to /ws
///     subscribers. Self-write echoes (the editor saving through
///     /api/markdown PUT and then seeing its own save) are
///     suppressed here so the UI doesn't show a phantom external-
///     edit toast.
///   - `index_tx`: raw `WatchEvent` for the background indexer.
///     Self-write suppression DOES NOT apply here: in-app saves
///     must reindex, otherwise search drifts every time the user
///     types. The indexer applies its own debounce.
///
/// `root` is the workspace root: the bridge stats the event path at
/// broadcast time to carry the live user-write bit on the frame (see
/// on_event).
pub fn make_watch_bridge(
    events_tx: &broadcast::Sender<String>,
    index_tx: &broadcast::Sender<WatchEvent>,
    self_writes: &Arc<SelfWrites>,
    scopes: &Arc<ScopeRegistry>,
    root: std::path::PathBuf,
) -> Arc<dyn WatchCallback> {
    Arc::new(WatchBroadcast {
        tx: events_tx.clone(),
        index_tx: index_tx.clone(),
        self_writes: self_writes.clone(),
        scopes: scopes.clone(),
        root,
    })
}

struct WatchBroadcast {
    tx: broadcast::Sender<String>,
    index_tx: broadcast::Sender<WatchEvent>,
    self_writes: Arc<SelfWrites>,
    scopes: Arc<ScopeRegistry>,
    root: std::path::PathBuf,
}

impl WatchCallback for WatchBroadcast {
    fn on_event(&self, event: WatchEvent) {
        // Indexer always sees the event. Send-error means there are
        // no subscribers (the indexer has not subscribed yet, or has
        // shut down). Tokio drops the event in that case; a receiver
        // that subscribes later does not replay it.
        let _ = self.index_tx.send(event.clone());
        if event_is_self_echo(&event, &self.self_writes) {
            return;
        }
        // The live user-write bit rides every frame whose path stats.
        // chmod-style permission flips reach the frontend ONLY here:
        // they do not touch mtime, so neither the doc-session
        // reconciler (mtime-token echo) nor the external-change banner
        // ever surfaces them, and the locked lamp would go stale.
        let writable = event
            .to
            .as_deref()
            .or(event.path.as_deref())
            .and_then(|rel| std::fs::symlink_metadata(self.root.join(rel)).ok())
            .map(|m| !m.permissions().readonly());
        // Legacy global frame for the editor's open-document
        // external-edit toast (kept alongside the scoped `fs`
        // frame). Fans out to every /ws socket regardless of scope.
        let mut frame = serde_json::json!({"type": "watch", "event": event});
        if let Some(writable) = writable {
            frame["writable"] = serde_json::Value::from(writable);
        }
        if let Ok(s) = serde_json::to_string(&frame) {
            let _ = self.tx.send(s);
        }
        // Scoped fan-out: derive per-directory `fs` frames
        // from this single recursive feed by first-degree directory
        // match, and deliver them only to the sockets subscribed to
        // the matching scope. No extra OS watchers are attached.
        self.scopes.emit_fs(&event);
    }
}

fn event_is_self_echo(event: &WatchEvent, sw: &SelfWrites) -> bool {
    if let Some(p) = event.path.as_deref() {
        if sw.should_suppress(p) {
            return true;
        }
    }
    if let Some(p) = event.to.as_deref() {
        if sw.should_suppress(p) {
            return true;
        }
    }
    false
}

/// Unique id for one connected `/ws` socket's scope subscriptions.
/// Allocated on socket accept; every `sub`/`unsub` the socket sends is
/// recorded against this id so a disconnect can drop all of them at
/// once (no leaked scopes on an abrupt close).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SubId(u64);

/// Global refcount transitions produced by one registry lifecycle call:
/// `attach` holds directories whose refcount went 0 -> 1, `detach` those
/// that went 1 -> 0. A tenant with a real per-directory watcher (the
/// standalone Files watch manager) turns these into OS watch attach and
/// detach commands; workspace tenants derive frames from their one
/// recursive feed and ignore the deltas.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScopeDelta {
    pub attach: Vec<String>,
    pub detach: Vec<String>,
}

impl ScopeDelta {
    /// Whether this lifecycle call crossed any global refcount edge.
    /// Gated to tests like `subscriber_count` until a production caller
    /// needs to skip no-op deltas.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.attach.is_empty() && self.detach.is_empty()
    }
}

/// Per-directory scoped watcher pub/sub registry.
///
/// There is one recursive OS watcher on the workspace (it feeds the
/// indexer); this registry does NOT attach per-directory OS watchers.
/// Instead it derives per-directory `fs` frames from that single feed
/// by first-degree directory match and delivers each frame only to the
/// sockets subscribed to the matching scope. "Tearing down the
/// watcher" maps here to "drop the scope's bookkeeping and stop
/// emitting frames for it" -- the lifecycle and the
/// sub1/sub2/unsub1/unsub2 refcount are identical to the real-OS-watcher
/// design, just without the inotify-watch-count pressure on big trees.
///
/// Refcount model: each scope is keyed by a workspace-relative directory
/// path (POSIX, `""` is the workspace root). A scope's refcount is the size
/// of its subscriber set; the scope entry exists exactly while it has
/// at least one subscriber, so the last `unsub` (or socket close)
/// removes the entry. The scope is NOT tied to its creating
/// subscriber's identity: the original creator unsubscribing while a
/// later subscriber remains keeps the scope alive.
#[derive(Default)]
pub struct ScopeRegistry {
    next_id: AtomicU64,
    inner: Mutex<ScopeInner>,
}

#[derive(Default)]
struct ScopeInner {
    /// dir (workspace-relative) -> the set of subscribers watching it.
    /// Entry present iff at least one subscriber. The set size is the
    /// refcount.
    scopes: HashMap<String, HashSet<SubId>>,
    /// SubId -> that socket's scoped-frame outbox + the set of dirs it
    /// is subscribed to (so a disconnect can decrement every scope).
    subscribers: HashMap<SubId, Subscriber>,
}

struct Subscriber {
    /// Scoped `fs` frames for this socket are pushed here; `ws_pump`
    /// drains it into the socket. Unbounded because filesystem bursts
    /// must not block the watcher thread; a slow client is bounded by
    /// the socket send, not this queue.
    outbox: mpsc::UnboundedSender<String>,
    dirs: HashSet<String>,
}

impl ScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a connected socket. Returns its `SubId` and the receiver
    /// end of its scoped-frame outbox; `ws_pump` selects on the receiver
    /// to forward `fs` frames. The socket starts with no scope
    /// subscriptions; it sends `sub` frames to add them.
    pub fn register(&self) -> (SubId, mpsc::UnboundedReceiver<String>) {
        let id = SubId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.lock();
        inner.subscribers.insert(
            id,
            Subscriber {
                outbox: tx,
                dirs: HashSet::new(),
            },
        );
        (id, rx)
    }

    /// Subscribe `id` to `dir`. Idempotent: a repeat `sub` for a dir the
    /// socket already holds does not double-count (the subscriber set is
    /// keyed by `SubId`). The first subscriber for a dir creates the
    /// scope entry; later subscribers reuse it. The returned delta names
    /// `dir` in `attach` only on the global 0 -> 1 transition, computed
    /// under the same lock as the map mutation so deltas can never be
    /// observed out of order. No filesystem or notify work runs here.
    pub fn subscribe(&self, id: SubId, dir: &str) -> ScopeDelta {
        let dir = normalize_dir(dir);
        let mut inner = self.lock();
        let Some(sub) = inner.subscribers.get_mut(&id) else {
            return ScopeDelta::default(); // socket already unregistered; drop the late frame.
        };
        sub.dirs.insert(dir.clone());
        let scope = inner.scopes.entry(dir.clone()).or_default();
        let was_empty = scope.is_empty();
        scope.insert(id);
        let mut delta = ScopeDelta::default();
        if was_empty {
            delta.attach.push(dir);
        }
        delta
    }

    /// Unsubscribe `id` from `dir`. The scope stays alive while any
    /// other subscriber remains; the last unsubscribe removes the scope
    /// entry entirely and names `dir` in the returned delta's `detach`.
    pub fn unsubscribe(&self, id: SubId, dir: &str) -> ScopeDelta {
        let dir = normalize_dir(dir);
        let mut inner = self.lock();
        if let Some(sub) = inner.subscribers.get_mut(&id) {
            sub.dirs.remove(&dir);
        }
        let mut delta = ScopeDelta::default();
        if Self::drop_scope_member(&mut inner, &dir, id) {
            delta.detach.push(dir);
        }
        delta
    }

    /// Drop a socket entirely (disconnect). Removes the subscriber and
    /// decrements every scope it held, tearing down any scope whose
    /// refcount reaches zero. A disconnect therefore cannot leak scopes;
    /// the returned delta names every finally-removed directory.
    pub fn unregister(&self, id: SubId) -> ScopeDelta {
        let mut inner = self.lock();
        let Some(sub) = inner.subscribers.remove(&id) else {
            return ScopeDelta::default();
        };
        let mut delta = ScopeDelta::default();
        for dir in sub.dirs {
            if Self::drop_scope_member(&mut inner, &dir, id) {
                delta.detach.push(dir);
            }
        }
        delta
    }

    /// Current refcount for `dir` (number of distinct subscribers).
    /// Zero when the scope is not present. The test-facing assertion for
    /// the refcount invariant; gated to tests until a server-side reader
    /// (e.g. diagnostics) needs it in production.
    #[cfg(test)]
    pub fn subscriber_count(&self, dir: &str) -> usize {
        let dir = normalize_dir(dir);
        self.lock()
            .scopes
            .get(&dir)
            .map(|set| set.len())
            .unwrap_or(0)
    }

    /// True when `dir` currently has a live scope entry. The "watcher
    /// exists" predicate the sub1/sub2/unsub1/unsub2 test asserts on;
    /// in this derived-frame design the scope entry IS the watcher.
    /// Test-gated for the same reason as `subscriber_count`.
    #[cfg(test)]
    pub fn scope_exists(&self, dir: &str) -> bool {
        let dir = normalize_dir(dir);
        self.lock().scopes.contains_key(&dir)
    }

    /// Derive and deliver scoped `fs` frames for one watch event. An
    /// event affecting a path delivers to the scope of the path's
    /// IMMEDIATE parent directory (first-degree only; a subscriber to
    /// `d` sees direct children of `d`, never grandchildren). A rename
    /// whose source and destination sit in different directories
    /// surfaces on both parents' scopes, matching the contract that a
    /// straddling rename is seen by each side.
    pub fn emit_fs(&self, event: &WatchEvent) {
        self.emit_fs_attributed(event, None);
    }

    /// [`Self::emit_fs`] with an optional originating window id. A frame
    /// whose `source_w` names the receiving window is that window's own
    /// mutation echoed deterministically: it relists but does not mark its
    /// clean buffers externally changed. External changes (shell writes,
    /// the legacy transfer lane) carry no source and keep today's shape.
    pub fn emit_fs_attributed(&self, event: &WatchEvent, source_w: Option<&str>) {
        let inner = self.lock();
        if inner.scopes.is_empty() {
            return;
        }
        // The set of parent dirs this event touches. A non-rename
        // touches one; a straddling rename touches up to two.
        let mut parents: Vec<&str> = Vec::with_capacity(2);
        if let Some(p) = event.path.as_deref() {
            parents.push(parent_dir(p));
        }
        if let Some(p) = event.to.as_deref() {
            let parent = parent_dir(p);
            if !parents.contains(&parent) {
                parents.push(parent);
            }
        }
        for dir in parents {
            let Some(subs) = inner.scopes.get(dir) else {
                continue;
            };
            if subs.is_empty() {
                continue;
            }
            let mut frame = serde_json::json!({
                "type": "fs",
                "dir": dir,
                "event": event,
            });
            if let Some(source_w) = source_w {
                frame["source_w"] = source_w.into();
            }
            let Ok(serialized) = serde_json::to_string(&frame) else {
                continue;
            };
            // The outbox is an unbounded mpsc, so `send` is non-blocking;
            // delivering inside the lock keeps the critical section to a
            // few queue pushes. A closed receiver (socket gone but not
            // yet unregistered) just drops the frame.
            for id in subs {
                if let Some(sub) = inner.subscribers.get(id) {
                    let _ = sub.outbox.send(serialized.clone());
                }
            }
        }
    }

    /// Remove `id` from `dir`'s subscriber set, tearing the scope down when
    /// it was the last member. Returns whether the scope entry was removed
    /// (the 1 -> 0 transition a delta reports as `detach`).
    fn drop_scope_member(inner: &mut ScopeInner, dir: &str, id: SubId) -> bool {
        if let Some(set) = inner.scopes.get_mut(dir) {
            set.remove(&id);
            if set.is_empty() {
                inner.scopes.remove(dir);
                return true;
            }
        }
        false
    }

    /// Deliver an `fs_reset` frame to the subscribers of one directory. A
    /// reset tells them their view of `dir` may have gaps (a watch just
    /// attached, failed, overflowed, or the directory was replaced) and one
    /// authoritative one-level relist is required. `reason` is a fixed
    /// vocabulary, never a raw provider message, so backend error text can
    /// never masquerade as a path. Same delivery discipline as `emit_fs`:
    /// only unbounded channel pushes happen under the lock.
    pub fn emit_fs_reset(&self, dir: &str, reason: FsResetReason) {
        let dir = normalize_dir(dir);
        let inner = self.lock();
        let Some(subs) = inner.scopes.get(&dir) else {
            return;
        };
        if subs.is_empty() {
            return;
        }
        let frame = serde_json::json!({
            "type": "fs_reset",
            "dir": dir,
            "reason": reason.as_str(),
        });
        let Ok(serialized) = serde_json::to_string(&frame) else {
            return;
        };
        for id in subs {
            if let Some(sub) = inner.subscribers.get(id) {
                let _ = sub.outbox.send(serialized.clone());
            }
        }
    }

    /// The directories currently holding at least one subscriber. The
    /// standalone watch manager tracks its own desired scope set, so this
    /// is gated to tests like `subscriber_count` until a server-side
    /// reader needs it in production.
    #[cfg(test)]
    pub fn subscribed_dirs(&self) -> Vec<String> {
        self.lock().scopes.keys().cloned().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ScopeInner> {
        // The registry mutex guards only fast in-memory map edits; a
        // poisoned lock means a prior panic while holding it, which for
        // this bookkeeping is unrecoverable. Recover the guard rather
        // than propagate, matching the rest of chan-server's Mutex use.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Why a scope needs an authoritative relist. The wire strings are the
/// contract with the frontend's reset handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsResetReason {
    /// The scope's OS watch just became live; relist once to close the
    /// initial-list/watch-attachment race.
    Subscribed,
    /// The OS watch could not be attached; events may be missing until the
    /// bounded retry succeeds.
    WatchError,
    /// The provider reported a queue overflow or rescan; events were lost.
    Overflow,
    /// The watched directory was removed or replaced; the watch is being
    /// re-attached to whatever now sits at the path.
    DirectoryReplaced,
}

impl FsResetReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            FsResetReason::Subscribed => "subscribed",
            FsResetReason::WatchError => "watch_error",
            FsResetReason::Overflow => "overflow",
            FsResetReason::DirectoryReplaced => "directory_replaced",
        }
    }
}

/// Normalize a workspace-relative directory key: trim leading/trailing
/// slashes so `"notes/"`, `"/notes"`, and `"notes"` map to the same
/// scope, and the workspace root is always `""`.
fn normalize_dir(dir: &str) -> String {
    dir.trim_matches('/').to_string()
}

/// The immediate parent directory of a workspace-relative POSIX path. A
/// top-level entry (`"a.md"`) has parent `""` (the workspace root). Used to
/// route an event to its first-degree scope.
fn parent_dir(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(idx) => &trimmed[..idx],
        None => "",
    }
}

/// Bridge from chan-workspace's `ProgressCallback` into the shared
/// JSON-envelope broadcast channel. Every progress tick (per-file
/// during reindex, per-batch during embedding, etc.) lands on the
/// same `/ws` stream every other producer uses, with `type` set to
/// `"progress"` so the frontend can route the frame distinctly.
///
/// `Send + Sync` because `ProgressCallback` can fire from worker
/// threads inside the embedder and graph rebuilders.
pub fn make_progress_broadcast(events_tx: &broadcast::Sender<String>) -> Arc<dyn ProgressCallback> {
    Arc::new(ProgressBroadcast {
        tx: events_tx.clone(),
    })
}

struct ProgressBroadcast {
    tx: broadcast::Sender<String>,
}

impl ProgressCallback for ProgressBroadcast {
    fn on_progress(&self, event: ProgressEvent) {
        let frame = serde_json::json!({"type": "progress", "event": event});
        if let Ok(s) = serde_json::to_string(&frame) {
            // Best-effort: lagged subscribers are dropped by the
            // broadcast channel naturally; a no-subscriber send
            // returns an error we ignore for the same reason as
            // the watch bridge above.
            let _ = self.tx.send(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn broadcast_drops_events_sent_without_a_receiver() {
        let (tx, rx) = broadcast::channel(8);
        drop(rx);
        assert!(tx.send("before-subscribe").is_err());

        let mut later = tx.subscribe();
        assert!(matches!(
            later.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    fn recv_json(rx: &mut broadcast::Receiver<String>) -> Value {
        let raw = rx.try_recv().expect("broadcast frame");
        serde_json::from_str(&raw).expect("json frame")
    }

    #[test]
    fn progress_frame_serializes() {
        let (tx, mut rx) = broadcast::channel(8);
        let sink = make_progress_broadcast(&tx);
        sink.on_progress(ProgressEvent {
            stage: chan_workspace::ProgressStage::IndexFile,
            current: 1,
            total: 2,
            label: Some("a.md".into()),
            eta_secs: None,
        });

        let frame = recv_json(&mut rx);
        assert_eq!(frame["type"], "progress");
        assert_eq!(frame["event"]["stage"], "IndexFile");
    }

    use chan_workspace::WatchKind;

    fn created(path: &str) -> WatchEvent {
        WatchEvent::file(
            WatchKind::Created,
            path,
            chan_workspace::WorkspaceGeneration::default(),
        )
    }

    fn renamed(from: &str, to: &str) -> WatchEvent {
        WatchEvent::rename(
            Some(from.to_string()),
            Some(to.to_string()),
            false,
            None,
            chan_workspace::WorkspaceGeneration::default(),
        )
    }

    fn try_recv(rx: &mut mpsc::UnboundedReceiver<String>) -> Option<Value> {
        rx.try_recv()
            .ok()
            .map(|s| serde_json::from_str(&s).expect("json frame"))
    }

    // The suppression contract every write handler depends on: once a
    // path is noted, the watcher's echo of that write is recognized as
    // a self-echo (matching either the event path or a rename target)
    // and dropped instead of surfacing as a phantom "external edit".
    // The handlers note BEFORE/INSIDE the blocking write so the path is
    // recorded before this check can run; this test locks the decision
    // itself.
    #[test]
    fn self_echo_matches_noted_path_and_rename_target() {
        let sw = SelfWrites::new();
        // A path we never wrote passes through to the frontend.
        assert!(!event_is_self_echo(&created("notes/a.md"), &sw));
        // Once noted, the matching event is a self-echo.
        sw.note("notes/a.md");
        assert!(event_is_self_echo(&created("notes/a.md"), &sw));
        // Renames carry path=from, to=dest; a write that notes the
        // destination still suppresses the rename echo.
        sw.note("notes/dest.md");
        assert!(event_is_self_echo(
            &renamed("notes/src.md", "notes/dest.md"),
            &sw,
        ));
        // An unrelated rename is not suppressed.
        assert!(!event_is_self_echo(
            &renamed("notes/x.md", "notes/y.md"),
            &sw,
        ));
    }

    #[test]
    fn parent_dir_is_first_degree() {
        assert_eq!(parent_dir("a.md"), "");
        assert_eq!(parent_dir("notes/a.md"), "notes");
        assert_eq!(parent_dir("notes/recipes/a.md"), "notes/recipes");
        // A trailing slash on a directory path does not change its parent.
        assert_eq!(parent_dir("notes/recipes/"), "notes");
    }

    // chmod does not touch mtime, so the session reconciler and the
    // external-change banner both ignore it: the live user-write bit
    // must ride the watch frame itself, or the editor's locked lamp
    // never tracks OS permissions on an open file.
    #[test]
    fn watch_frame_carries_live_writable_bit() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        std::fs::write(&file, "x").unwrap();
        let (events_tx, mut events_rx) = broadcast::channel::<String>(8);
        let (index_tx, _index_rx) = broadcast::channel::<WatchEvent>(8);
        let sw = Arc::new(SelfWrites::new());
        let scopes = Arc::new(ScopeRegistry::new());
        let bridge = make_watch_bridge(
            &events_tx,
            &index_tx,
            &sw,
            &scopes,
            dir.path().to_path_buf(),
        );
        let modified = || {
            WatchEvent::file(
                WatchKind::Modified,
                "a.md",
                chan_workspace::WorkspaceGeneration::default(),
            )
        };

        bridge.on_event(modified());
        let frame = recv_json(&mut events_rx);
        assert_eq!(frame["type"], "watch");
        assert_eq!(frame["writable"], true);

        let mut perms = std::fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file, perms).unwrap();
        bridge.on_event(modified());
        let frame = recv_json(&mut events_rx);
        assert_eq!(frame["writable"], false);

        // Restore writability so the tempdir cleanup works on Windows.
        #[allow(clippy::permissions_set_readonly_false)]
        {
            let mut perms = std::fs::metadata(&file).unwrap().permissions();
            perms.set_readonly(false);
            std::fs::set_permissions(&file, perms).unwrap();
        }
    }

    #[test]
    fn normalize_dir_collapses_slashes_to_one_key() {
        assert_eq!(normalize_dir("/notes/"), "notes");
        assert_eq!(normalize_dir("notes"), "notes");
        assert_eq!(normalize_dir(""), "");
        assert_eq!(normalize_dir("/"), "");
    }

    // The required hardening matrix from the spine contract. In this design
    // the "watcher" for a directory IS its scope entry in the registry, so
    // "the watcher exists / is torn down" is asserted via `scope_exists`,
    // and refcount stability across sub2/unsub1 via `subscriber_count`.
    #[test]
    fn scope_refcount_sub1_sub2_unsub1_unsub2() {
        let reg = ScopeRegistry::new();
        let (s1, _rx1) = reg.register();
        let (s2, _rx2) = reg.register();
        let dir = "notes/recipes";

        // sub1: first subscriber creates the scope, refcount = 1. The
        // 0 -> 1 edge is the only attach a real watcher would act on.
        let delta = reg.subscribe(s1, dir);
        assert_eq!(delta.attach, vec![dir.to_string()]);
        assert!(reg.scope_exists(dir), "sub1 must create the scope");
        assert_eq!(reg.subscriber_count(dir), 1);
        assert_eq!(reg.subscribed_dirs(), vec![dir.to_string()]);

        // sub2: a different socket reuses the SAME scope, refcount = 2,
        // and the delta reports nothing (no refcount edge crossed).
        let delta = reg.subscribe(s2, dir);
        assert!(delta.is_empty(), "sub2 crosses no refcount edge");
        assert!(reg.scope_exists(dir));
        assert_eq!(reg.subscriber_count(dir), 2, "sub2 reuses, refcount = 2");

        // unsub1: the ORIGINAL creator unsubscribes. The scope STAYS
        // alive (it is not tied to the creator's identity), refcount = 1.
        reg.unsubscribe(s1, dir);
        assert!(
            reg.scope_exists(dir),
            "unsub1 by the creator must NOT tear down while s2 remains"
        );
        assert_eq!(reg.subscriber_count(dir), 1);

        // unsub2: last subscriber leaves. Refcount = 0, scope torn down.
        reg.unsubscribe(s2, dir);
        assert!(
            !reg.scope_exists(dir),
            "unsub2 (last) must tear the scope down"
        );
        assert_eq!(reg.subscriber_count(dir), 0);
        assert!(
            reg.subscribed_dirs().is_empty(),
            "a torn-down scope leaves no live directory behind"
        );
    }

    #[test]
    fn socket_close_drops_all_of_its_scopes() {
        let reg = ScopeRegistry::new();
        let (s1, _rx1) = reg.register();
        let (s2, _rx2) = reg.register();
        // s1 holds two scopes; s2 shares one of them.
        reg.subscribe(s1, "notes");
        reg.subscribe(s1, "notes/recipes");
        reg.subscribe(s2, "notes");
        assert_eq!(reg.subscriber_count("notes"), 2);
        assert_eq!(reg.subscriber_count("notes/recipes"), 1);

        // Disconnect s1: both of its scopes decrement. The shared one
        // survives (s2 still holds it); the exclusive one is torn down.
        reg.unregister(s1);
        assert_eq!(
            reg.subscriber_count("notes"),
            1,
            "s2 keeps the shared scope"
        );
        assert!(
            !reg.scope_exists("notes/recipes"),
            "s1's exclusive scope is torn down on disconnect"
        );

        // A disconnect cannot leak: dropping s2 empties the registry.
        reg.unregister(s2);
        assert!(!reg.scope_exists("notes"));
        assert_eq!(reg.subscriber_count("notes"), 0);
    }

    #[test]
    fn subscribe_is_idempotent_no_double_count() {
        let reg = ScopeRegistry::new();
        let (s1, _rx1) = reg.register();
        reg.subscribe(s1, "notes");
        reg.subscribe(s1, "notes"); // repeat sub from the same socket
        assert_eq!(
            reg.subscriber_count("notes"),
            1,
            "a repeat sub must not double-count the same socket"
        );
    }

    #[test]
    fn emit_fs_delivers_only_to_first_degree_subscribers() {
        let reg = ScopeRegistry::new();
        let (s1, mut rx1) = reg.register();
        let (s2, mut rx2) = reg.register();
        reg.subscribe(s1, "notes");
        reg.subscribe(s2, "notes/recipes");

        // A direct child of `notes` reaches s1 only (first-degree).
        reg.emit_fs(&created("notes/a.md"));
        let frame = try_recv(&mut rx1).expect("s1 sees its child");
        assert_eq!(frame["type"], "fs");
        assert_eq!(frame["dir"], "notes");
        assert_eq!(frame["event"]["path"], "notes/a.md");
        assert!(try_recv(&mut rx2).is_none(), "s2 is unrelated");

        // A grandchild of `notes` does NOT reach the `notes` subscriber
        // (first-degree only); it reaches the `notes/recipes` subscriber.
        reg.emit_fs(&created("notes/recipes/b.md"));
        assert!(
            try_recv(&mut rx1).is_none(),
            "grandchild must not reach the parent scope"
        );
        let frame = try_recv(&mut rx2).expect("s2 sees its direct child");
        assert_eq!(frame["dir"], "notes/recipes");
    }

    #[test]
    fn emit_fs_root_scope_sees_top_level_entries() {
        let reg = ScopeRegistry::new();
        let (s1, mut rx1) = reg.register();
        reg.subscribe(s1, ""); // workspace root
        reg.emit_fs(&created("README.md"));
        let frame = try_recv(&mut rx1).expect("root scope sees top-level files");
        assert_eq!(frame["dir"], "");
        assert_eq!(frame["event"]["path"], "README.md");
    }

    #[test]
    fn emit_fs_straddling_rename_surfaces_on_both_sides() {
        let reg = ScopeRegistry::new();
        let (s1, mut rx1) = reg.register();
        let (s2, mut rx2) = reg.register();
        reg.subscribe(s1, "from");
        reg.subscribe(s2, "to");

        // A rename whose source and destination sit in different dirs is
        // seen by each side's scope, carrying its own `dir`.
        reg.emit_fs(&renamed("from/a.md", "to/a.md"));
        let f1 = try_recv(&mut rx1).expect("source side sees the rename");
        assert_eq!(f1["dir"], "from");
        let f2 = try_recv(&mut rx2).expect("dest side sees the rename");
        assert_eq!(f2["dir"], "to");
    }

    #[test]
    fn emit_fs_with_no_subscribers_is_a_noop() {
        let reg = ScopeRegistry::new();
        // No panic, no work; the early-return on empty scopes covers it.
        reg.emit_fs(&created("notes/a.md"));
        assert_eq!(reg.subscriber_count("notes"), 0);
    }
}
