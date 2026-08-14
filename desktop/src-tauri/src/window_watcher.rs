//! The desktop window watcher -- chan-desktop as a pure view of the library.
//!
//! Every native window is a reconciled reflection of the library's authoritative
//! window set. A `LibraryWatcher` per connected library (the embedded
//! local library + each devserver) holds the latest [`WindowRecord`] snapshot and
//! [`reconcile`]s the native surface to it: open a native window for every library
//! window that lacks one, close every native window the library no longer lists.
//!
//! This replaces the old imperative open/close paths (`reopen_devserver_terminal_
//! windows` / `teardown_devserver_windows` / `track_devserver_window` + the in-memory
//! `devserver_windows` map). Because the reconcile is an idempotent diff keyed by the
//! library-minted id, **reconnect = resubscribe + reconcile can never mint a
//! duplicate** by construction.
//!
//! Wiring: the local library feeds in-process via
//! `host.assemble_window_records()` + the registry's change `Notify`; a devserver
//! feeds over `GET /api/library/windows` + its watch socket. Both drive the same
//! [`reconcile`]. This module is the surface-agnostic core; the Tauri-side
//! [`NativeSurface`] impl and the per-library watcher tasks bind to it.
//!
//! The reconcile core + loop are consumed by the per-library watcher wiring (the
//! `WindowFeed` impls, the Tauri `NativeSurface` impl, the `watch_loop` spawn) and
//! the close handlers (bury/unbury through the view state).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

use chan_server::WindowRecord;
use tokio::sync::Notify;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchLoopStop {
    /// Reconcile this watcher's known native windows away before stopping.
    CloseWindows,
    /// Stop the watcher and leave native windows for a replacement watcher.
    KeepWindows,
}

/// The composite native-window key. `window_id` is unique only within its minting
/// library (libraries mint independently; there is no global authority), so the
/// globally-unique native key is `{library_id}::{window_id}`. This string IS the
/// Tauri window label; the `?w=` value is the **bare** `window_id` (decoupled -- the
/// per-library SPA/session/presence key). `library_id` ∈ {`local`, `lib-<hex>`} and
/// `window_id` = `w-<hex>`, so `::` never appears inside either part.
pub fn native_label(record: &WindowRecord) -> String {
    format!("{}::{}", record.library_id, record.window_id)
}

/// Maximum number of DELETE attempts for one closed devserver window. The
/// first attempt runs at close time; later attempts run when the window feed
/// reconnects.
pub(crate) const MAX_PENDING_DELETE_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingDeleteAttempt {
    pub label: String,
    pub window_id: String,
    pub window_name: String,
    pub attempt: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PendingDeleteFinish {
    AwaitingRetry,
    AwaitingFeed,
    Exhausted {
        window_id: String,
        window_name: String,
        attempts: u8,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingDeletePhase {
    Ready,
    InFlight,
    Landed,
    Exhausted,
}

#[derive(Debug, Clone)]
struct PendingDelete {
    devserver_id: String,
    label: String,
    window_id: String,
    window_name: String,
    attempts: u8,
    phase: PendingDeletePhase,
}

/// Process-local close intents whose remote registry DELETE has not yet been
/// confirmed by an authoritative feed snapshot. Pending labels stay suppressed
/// from the native surface in every phase, including after the retry budget is
/// exhausted. This keeps "closed" truthful even when the server cannot accept
/// the DELETE during the desktop process lifetime.
#[derive(Default)]
pub(crate) struct PendingDeleteState {
    entries: Mutex<HashMap<String, PendingDelete>>,
}

impl PendingDeleteState {
    pub fn queue(&self, devserver_id: &str, record: &WindowRecord) {
        let label = native_label(record);
        let window_name = if record.title.trim().is_empty() {
            record.window_id.clone()
        } else {
            record.title.clone()
        };
        self.entries
            .lock()
            .unwrap()
            .entry(label.clone())
            .or_insert_with(|| PendingDelete {
                devserver_id: devserver_id.to_string(),
                label,
                window_id: record.window_id.clone(),
                window_name,
                attempts: 0,
                phase: PendingDeletePhase::Ready,
            });
    }

    pub fn begin(&self, label: &str) -> Option<PendingDeleteAttempt> {
        let mut entries = self.entries.lock().unwrap();
        begin_pending_delete(entries.get_mut(label)?)
    }

    pub fn begin_for_devserver(&self, devserver_id: &str) -> Vec<PendingDeleteAttempt> {
        let mut entries = self.entries.lock().unwrap();
        let mut attempts: Vec<_> = entries
            .values_mut()
            .filter(|entry| entry.devserver_id == devserver_id)
            .filter_map(begin_pending_delete)
            .collect();
        attempts.sort_by(|a, b| a.label.cmp(&b.label));
        attempts
    }

    pub fn finish(&self, label: &str, landed: bool) -> Option<PendingDeleteFinish> {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.get_mut(label)?;
        if entry.phase != PendingDeletePhase::InFlight {
            return None;
        }
        if landed {
            entry.phase = PendingDeletePhase::Landed;
            return Some(PendingDeleteFinish::AwaitingFeed);
        }
        if entry.attempts >= MAX_PENDING_DELETE_ATTEMPTS {
            entry.phase = PendingDeletePhase::Exhausted;
            return Some(PendingDeleteFinish::Exhausted {
                window_id: entry.window_id.clone(),
                window_name: entry.window_name.clone(),
                attempts: entry.attempts,
            });
        }
        entry.phase = PendingDeletePhase::Ready;
        Some(PendingDeleteFinish::AwaitingRetry)
    }

    /// Remove close intents whose record is absent from a full feed snapshot.
    /// DELETE success alone is not enough: retaining suppression until this
    /// observation prevents a stale pre-delete snapshot from reopening the
    /// native window between the response and the feed update.
    pub fn settle_snapshot(&self, devserver_id: &str, records: &[WindowRecord]) {
        let present: HashSet<String> = records.iter().map(native_label).collect();
        self.entries.lock().unwrap().retain(|_, entry| {
            entry.devserver_id != devserver_id || present.contains(&entry.label)
        });
    }

    #[cfg(test)]
    pub fn contains(&self, label: &str) -> bool {
        self.entries.lock().unwrap().contains_key(label)
    }

    fn labels_snapshot(&self) -> HashSet<String> {
        self.entries.lock().unwrap().keys().cloned().collect()
    }
}

fn begin_pending_delete(entry: &mut PendingDelete) -> Option<PendingDeleteAttempt> {
    if entry.phase != PendingDeletePhase::Ready || entry.attempts >= MAX_PENDING_DELETE_ATTEMPTS {
        return None;
    }
    entry.attempts += 1;
    entry.phase = PendingDeletePhase::InFlight;
    Some(PendingDeleteAttempt {
        label: entry.label.clone(),
        window_id: entry.window_id.clone(),
        window_name: entry.window_name.clone(),
        attempt: entry.attempts,
    })
}

/// The native window surface a reconcile drives. Abstracted behind a trait so the
/// reconcile is unit-testable without a live Tauri app (the production impl wraps
/// the `AppHandle` + the renamed `remote_*` window builder).
pub trait NativeSurface {
    /// Native window labels (`{library_id}::{window_id}`) currently open for
    /// `library_id` -- visible OR buried; the reconcile owns the bury filter.
    fn open_labels(&self, library_id: &str) -> HashSet<String>;
    /// Open (or rebuild-in-place at the same label) a native window for `record`:
    /// native label = [`native_label`]; the loaded tenant URL carries `?w=<window_id>`.
    fn open(&self, record: &WindowRecord);
    /// Synchronize a native window that already exists for `record`. The default
    /// is a no-op; surfaces that encode launch-only data in the webview URL can
    /// rebuild in place when the authoritative record's launch data changes.
    fn refresh(&self, _record: &WindowRecord) {}
    /// Close the native window labelled `label`.
    fn close(&self, label: &str);
}

/// Whether the reconcile surfaces `record` as a native window: persisted,
/// **native-origin** (a browser-minted window is never opened as a native twin),
/// not **server-hidden**, not **locally buried**, and backed by a **live
/// tenant** (a non-empty `token`).
/// `record.hidden` is the server-persisted visibility, the source of
/// truth a connect MIRRORS, so a window hidden last session stays hidden on the
/// next connect/relaunch. Bury is the desktop-local view state layered on
/// top for immediate in-session feedback before the persist round-trips through
/// the feed; the browser has no native windows, so it lives only in this
/// process's `buried` set. The token gate IS the workspace on/off lifecycle: an
/// off workspace's window carries an empty token (no tenant to attach to), so the
/// reconcile CLOSES it while the library KEEPS the record -- turning the workspace
/// back on re-tokens it and the reconcile reopens it at the same window_id (the
/// SPA restores its tabs). Discard is the library op (the record leaves the
/// snapshot entirely).
fn should_show(record: &WindowRecord, buried: &HashSet<String>) -> bool {
    record.persisted
        && record.origin.is_native()
        && !record.hidden
        && !buried.contains(&native_label(record))
        && !record.token.is_empty()
}

/// One idempotent reconcile pass for `library_id`: open every shown record that
/// lacks a native window; close every native window no longer shown (the library
/// discarded it, or it was buried locally). Re-applying the same snapshot is a
/// no-op -- which is *why* reconnect (resubscribe → same snapshot) can never spawn a
/// duplicate. A dropped watch frame self-heals on the next full snapshot.
pub fn reconcile(
    library_id: &str,
    snapshot: &[WindowRecord],
    buried: &HashSet<String>,
    surface: &impl NativeSurface,
) {
    debug_assert!(
        snapshot.iter().all(|r| r.library_id == library_id),
        "reconcile got a record from a different library than {library_id}",
    );
    let desired: HashSet<String> = snapshot
        .iter()
        .filter(|r| should_show(r, buried))
        .map(native_label)
        .collect();
    let actual = surface.open_labels(library_id);

    // Open every desired window that has no native surface yet (reattach reuses the
    // existing label -- the builder rebuilds in place, never a second window).
    // Existing windows still get a refresh hook: a devserver restart can keep the
    // same stable label while rotating the per-window tenant token embedded in the
    // launch URL.
    for record in snapshot.iter().filter(|r| should_show(r, buried)) {
        if actual.contains(&native_label(record)) {
            surface.refresh(record);
        } else {
            surface.open(record);
        }
    }
    // Close every native window that is no longer desired (discarded or buried).
    for label in actual.difference(&desired) {
        surface.close(label);
    }
}

/// A library's window-set feed: the current snapshot plus the change signal the
/// loop waits on. The local library implements this in-process
/// (`host.assemble_window_records()` + `host.library_change_notify()`).
///
/// **Why a `Notify`, not an `async fn changed()`:** tokio's `Notified` captures
/// the `notify_waiters()` generation at CREATION (not at first poll), so a
/// `Notified` created BEFORE the snapshot catches a change fired during the
/// snapshot -- the next poll sees the advanced generation. The hazard an opaque
/// `async fn changed()` would introduce is creating its `Notified` only when
/// first polled (i.e. AFTER the snapshot), where a same-instant change could be
/// missed. Handing the loop the raw `Notify` lets it guarantee
/// create-before-snapshot, which is the actual correctness property.
pub trait WindowFeed {
    /// The library's current full window set.
    fn snapshot(&self) -> Vec<WindowRecord>;
    /// The change signal, fired (via `notify_waiters`) on every window-set
    /// change. The loop creates this future before snapshotting.
    fn change_notify(&self) -> Arc<Notify>;
}

/// Desktop-local view state the watcher reconciles around. **Bury is
/// desktop-local**: the browser has no native windows, so a buried window lives
/// only in this set, never in the authoritative window set. Mutating it fires
/// `changed` so the loop re-reconciles without waiting on a feed change.
pub struct WatcherViewState {
    buried: Mutex<HashSet<String>>,
    pending_deletes: Arc<PendingDeleteState>,
    changed: Notify,
}

impl Default for WatcherViewState {
    fn default() -> Self {
        Self::with_pending_deletes(Arc::new(PendingDeleteState::default()))
    }
}

impl WatcherViewState {
    pub(crate) fn with_pending_deletes(pending_deletes: Arc<PendingDeleteState>) -> Self {
        Self {
            buried: Mutex::new(HashSet::new()),
            pending_deletes,
            changed: Notify::new(),
        }
    }

    /// Bury a native window (the standalone-terminal close button): the next
    /// reconcile closes it, and it surfaces in the Window menu for reopen.
    pub fn bury(&self, native_label: &str) {
        self.buried.lock().unwrap().insert(native_label.to_string());
        self.changed.notify_one();
    }

    /// Un-bury (reopen from the menu): the next reconcile re-opens it.
    pub fn unbury(&self, native_label: &str) {
        self.buried.lock().unwrap().remove(native_label);
        self.changed.notify_one();
    }

    fn buried_snapshot(&self) -> HashSet<String> {
        self.buried.lock().unwrap().clone()
    }

    fn suppressed_snapshot(&self) -> HashSet<String> {
        let mut suppressed = self.buried_snapshot();
        suppressed.extend(self.pending_deletes.labels_snapshot());
        suppressed
    }

    /// Whether `native_label` is currently buried. Lets the desktop's window
    /// teardown distinguish a watcher bury (keep the window in the reopen menu)
    /// from a real discard/teardown (drop it).
    pub fn is_buried(&self, native_label: &str) -> bool {
        self.buried.lock().unwrap().contains(native_label)
    }
}

/// Drive a library's native surface to its window set: reconcile on every feed
/// change AND every local view change (bury/unbury), until `cancel` resolves
/// with an explicit stop action. The reconcile is idempotent (snapshot-not-delta),
/// so reconnect = resubscribe + reconcile can never spawn a duplicate. A real
/// disconnect reconciles to empty (detach, not reap); a watcher handoff can retire
/// without closing native windows so the replacement watcher refreshes them in
/// place.
///
/// Correctness: both change `Notified`s are created BEFORE the snapshot. tokio
/// captures the `notify_waiters()` generation at creation, so a change firing in
/// the snapshot↔await window advances the generation and the first poll catches
/// it -- not missed. (Each is also `enable()`d to register the waiter eagerly;
/// belt-and-suspenders -- the generation capture is what's load-bearing here.)
pub async fn watch_loop<F, S, C>(
    initial_library_id: Option<&str>,
    feed: F,
    surface: S,
    view: Arc<WatcherViewState>,
    cancel: C,
) where
    F: WindowFeed,
    S: NativeSurface,
    C: Future<Output = WatchLoopStop>,
{
    // The library id is LAZY. A devserver whose feed is EMPTY (the user deleted
    // every window before disconnecting -- a valid state) has no record to read it
    // from. Learn/refresh it from the feed records; the local library passes it
    // eagerly (its id is constant). While it is unknown there are NO windows, so
    // reconcile is a no-op -- skip it. Once learned it is REMEMBERED, so a feed
    // that later empties still closes the library's windows.
    let mut library_id = initial_library_id.map(str::to_string);
    let feed_notify = feed.change_notify();
    tokio::pin!(cancel);
    loop {
        // Create both change futures BEFORE the snapshot so each captures the
        // current notify_waiters generation; a change during the snapshot then
        // advances it and the next poll catches it. (enable() arms the waiter
        // eagerly too -- harmless belt-and-suspenders.)
        let feed_changed = feed_notify.notified();
        tokio::pin!(feed_changed);
        feed_changed.as_mut().enable();
        let view_changed = view.changed.notified();
        tokio::pin!(view_changed);
        view_changed.as_mut().enable();

        let snapshot = feed.snapshot();
        if let Some(record) = snapshot.first() {
            library_id = Some(record.library_id.clone());
        }
        if let Some(library_id) = &library_id {
            reconcile(library_id, &snapshot, &view.suppressed_snapshot(), &surface);
        }

        tokio::select! {
            _ = feed_changed => {}
            _ = view_changed => {}
            stop = &mut cancel => {
                if stop == WatchLoopStop::CloseWindows {
                    // Disconnect: reconcile to empty so the library's native
                    // windows close (detach, NOT reap -- the library keeps its set
                    // server-side, so a reconnect restores them). A no-op if
                    // nothing was opened.
                    if let Some(library_id) = &library_id {
                        reconcile(library_id, &[], &view.suppressed_snapshot(), &surface);
                    }
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_server::{WindowKind, WindowOrigin};
    use std::cell::RefCell;

    /// A test surface: a settable "currently open" set + a recording of the
    /// `open`/`close` calls a reconcile makes.
    struct FakeSurface {
        open_now: RefCell<HashSet<String>>,
        opened: RefCell<Vec<String>>,
        refreshed: RefCell<Vec<String>>,
        closed: RefCell<Vec<String>>,
    }
    impl FakeSurface {
        fn with(open_now: &[&str]) -> Self {
            Self {
                open_now: RefCell::new(open_now.iter().map(|s| s.to_string()).collect()),
                opened: RefCell::new(Vec::new()),
                refreshed: RefCell::new(Vec::new()),
                closed: RefCell::new(Vec::new()),
            }
        }
    }
    impl NativeSurface for FakeSurface {
        fn open_labels(&self, _library_id: &str) -> HashSet<String> {
            self.open_now.borrow().clone()
        }
        fn open(&self, record: &WindowRecord) {
            self.opened.borrow_mut().push(native_label(record));
        }
        fn refresh(&self, record: &WindowRecord) {
            self.refreshed.borrow_mut().push(native_label(record));
        }
        fn close(&self, label: &str) {
            self.closed.borrow_mut().push(label.to_string());
        }
    }

    fn rec(library_id: &str, window_id: &str, kind: WindowKind) -> WindowRecord {
        WindowRecord {
            window_id: window_id.into(),
            library_id: library_id.into(),
            kind,
            app: None,
            title: "🏠 Terminal Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: "tok".into(),
            persisted: true,
            connected: false,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: WindowOrigin::Native,
        }
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn opens_a_new_window() {
        let s = FakeSurface::with(&[]);
        let snap = vec![rec("local", "w-1", WindowKind::Terminal)];
        reconcile("local", &snap, &none(), &s);
        assert_eq!(*s.opened.borrow(), vec!["local::w-1"]);
        assert!(s.closed.borrow().is_empty());
    }

    #[test]
    fn browser_minted_window_is_never_opened_natively() {
        // A browser-origin record must not open a native twin even though it is
        // persisted, visible, and tokened (D4: the desktop skips non-native rows).
        let s = FakeSurface::with(&[]);
        let mut r = rec("local", "w-browser", WindowKind::Workspace);
        r.origin = WindowOrigin::Browser;
        reconcile("local", &[r], &none(), &s);
        assert!(s.opened.borrow().is_empty(), "browser window not opened");
        assert!(s.closed.borrow().is_empty());
    }

    #[test]
    fn server_hidden_record_is_not_opened_and_is_closed() {
        // A record with the server-persisted `hidden` flag is NOT
        // surfaced -- `should_show` is false, so the reconcile neither opens it on
        // connect nor keeps a native window for it (the mirror: hidden last
        // session stays hidden). The local `buried` set is empty here, so `hidden`
        // alone gates it.
        let mut r = rec("local", "w-1", WindowKind::Terminal);
        r.hidden = true;
        let s = FakeSurface::with(&[]);
        reconcile("local", std::slice::from_ref(&r), &none(), &s);
        assert!(s.opened.borrow().is_empty(), "hidden record must not open");
        let s2 = FakeSurface::with(&["local::w-1"]);
        reconcile("local", std::slice::from_ref(&r), &none(), &s2);
        assert_eq!(*s2.closed.borrow(), vec!["local::w-1"]);
    }

    #[test]
    fn reattach_is_idempotent_no_duplicate() {
        // A native window already exists for the id, and the same snapshot
        // re-applies (reconnect = resubscribe + reconcile).
        let s = FakeSurface::with(&["local::w-1"]);
        let snap = vec![rec("local", "w-1", WindowKind::Terminal)];
        reconcile("local", &snap, &none(), &s);
        assert!(s.opened.borrow().is_empty(), "must NOT open a duplicate");
        assert!(s.closed.borrow().is_empty(), "must NOT close the live one");
    }

    #[test]
    fn refreshes_an_existing_desired_window() {
        // Same label still exists, but launch-only metadata can have changed
        // underneath it (notably a devserver's per-window token after restart).
        // Reconcile gives the surface a chance to rebuild in place without
        // treating it as a duplicate open.
        let s = FakeSurface::with(&["local::w-1"]);
        let snap = vec![rec("local", "w-1", WindowKind::Terminal)];
        reconcile("local", &snap, &none(), &s);
        assert_eq!(*s.refreshed.borrow(), vec!["local::w-1"]);
        assert!(s.opened.borrow().is_empty());
        assert!(s.closed.borrow().is_empty());
    }

    #[test]
    fn closes_a_discarded_window() {
        // Library no longer lists the window (discarded server-side) -> close it.
        let s = FakeSurface::with(&["local::w-1"]);
        reconcile("local", &[], &none(), &s);
        assert_eq!(*s.closed.borrow(), vec!["local::w-1"]);
        assert!(s.opened.borrow().is_empty());
    }

    #[test]
    fn off_workspace_window_is_closed_and_not_opened() {
        // A workspace turned OFF: its window record persists but carries an empty
        // token (no live tenant). The reconcile must NOT open it, and must CLOSE
        // it if already open -- the library keeps the record so a re-on reopens it
        // at the same window_id.
        let mut off = rec("local", "w-1", WindowKind::Workspace);
        off.token = String::new();
        // Not yet open -> stays closed.
        let s = FakeSurface::with(&[]);
        reconcile("local", std::slice::from_ref(&off), &none(), &s);
        assert!(
            s.opened.borrow().is_empty(),
            "off-tenant window must not open"
        );
        // Already open -> reconcile closes it (record kept; tenant gone).
        let s2 = FakeSurface::with(&["local::w-1"]);
        reconcile("local", std::slice::from_ref(&off), &none(), &s2);
        assert_eq!(*s2.closed.borrow(), vec!["local::w-1"]);
    }

    /// Models the real Tauri surface's ASYNC build: `open` does not immediately
    /// surface the window in `open_labels` (the build is dispatched to the main
    /// thread), but the label is tracked in-flight and folded into `open_labels`
    /// so a reconcile in the dispatch→build gap treats it as open. Mirrors
    /// `TauriNativeSurface`'s in-flight set.
    #[derive(Default)]
    struct AsyncGapSurface {
        built: RefCell<HashSet<String>>,
        in_flight: RefCell<HashSet<String>>,
        opens: RefCell<Vec<String>>,
    }
    impl NativeSurface for AsyncGapSurface {
        fn open_labels(&self, _library_id: &str) -> HashSet<String> {
            let built = self.built.borrow().clone();
            self.in_flight.borrow_mut().retain(|l| !built.contains(l));
            let mut labels = built;
            labels.extend(self.in_flight.borrow().iter().cloned());
            labels
        }
        fn open(&self, record: &WindowRecord) {
            let label = native_label(record);
            self.in_flight.borrow_mut().insert(label.clone());
            self.opens.borrow_mut().push(label);
            // Deliberately NOT added to `built` -- the build is async.
        }
        fn close(&self, label: &str) {
            self.built.borrow_mut().remove(label);
            self.in_flight.borrow_mut().remove(label);
        }
    }

    #[test]
    fn reconcile_does_not_double_open_across_the_async_build_gap() {
        // Two reconcile passes fire before the dispatched build lands in the
        // surface (the multi-notify boot burst). The in-flight tracking must make
        // the 2nd pass a no-op -- otherwise both build the SAME label ("webview
        // label already exists" + a stuck/duplicate window).
        let s = AsyncGapSurface::default();
        let snap = vec![rec("local", "w-1", WindowKind::Terminal)];
        reconcile("local", &snap, &none(), &s);
        reconcile("local", &snap, &none(), &s);
        assert_eq!(
            s.opens.borrow().len(),
            1,
            "must open the label exactly once across the async build gap",
        );
        // Once the build lands, the same snapshot stays a no-op.
        s.built.borrow_mut().insert("local::w-1".to_string());
        reconcile("local", &snap, &none(), &s);
        assert_eq!(
            s.opens.borrow().len(),
            1,
            "no re-open after the build lands"
        );
    }

    #[test]
    fn buried_window_is_not_opened_and_is_closed() {
        let mut buried = HashSet::new();
        buried.insert("local::w-1".to_string());
        // Buried + not yet open -> stays closed.
        let s = FakeSurface::with(&[]);
        let snap = vec![rec("local", "w-1", WindowKind::Terminal)];
        reconcile("local", &snap, &buried, &s);
        assert!(s.opened.borrow().is_empty(), "buried window must not open");
        // Buried + currently open -> reconcile closes it (bury hides the surface).
        let s2 = FakeSurface::with(&["local::w-1"]);
        reconcile("local", &snap, &buried, &s2);
        assert_eq!(*s2.closed.borrow(), vec!["local::w-1"]);
    }

    #[test]
    fn pending_delete_is_not_reopened_by_reconcile() {
        let record = rec("lib-test", "w-1", WindowKind::Terminal);
        let pending = Arc::new(PendingDeleteState::default());
        pending.queue("devserver-1", &record);
        let view = WatcherViewState::with_pending_deletes(Arc::clone(&pending));

        let closed = FakeSurface::with(&[]);
        reconcile(
            "lib-test",
            std::slice::from_ref(&record),
            &view.suppressed_snapshot(),
            &closed,
        );
        assert!(closed.opened.borrow().is_empty());

        let still_open = FakeSurface::with(&["lib-test::w-1"]);
        reconcile(
            "lib-test",
            std::slice::from_ref(&record),
            &view.suppressed_snapshot(),
            &still_open,
        );
        assert_eq!(*still_open.closed.borrow(), vec!["lib-test::w-1"]);
    }

    #[test]
    fn pending_delete_retries_then_settles_from_the_feed() {
        let record = rec("lib-test", "w-1", WindowKind::Terminal);
        let pending = PendingDeleteState::default();
        pending.queue("devserver-1", &record);

        let first = pending.begin("lib-test::w-1").unwrap();
        assert_eq!(first.attempt, 1);
        assert_eq!(
            pending.finish(&first.label, false),
            Some(PendingDeleteFinish::AwaitingRetry),
        );

        let retries = pending.begin_for_devserver("devserver-1");
        assert_eq!(retries.len(), 1);
        assert_eq!(retries[0].attempt, 2);
        assert_eq!(
            pending.finish(&retries[0].label, true),
            Some(PendingDeleteFinish::AwaitingFeed),
        );

        pending.settle_snapshot("devserver-1", std::slice::from_ref(&record));
        assert!(pending.contains("lib-test::w-1"));
        pending.settle_snapshot("devserver-1", &[]);
        assert!(!pending.contains("lib-test::w-1"));
    }

    #[test]
    fn pending_delete_exhausts_without_becoming_visible() {
        let record = rec("lib-test", "w-1", WindowKind::Terminal);
        let pending = PendingDeleteState::default();
        pending.queue("devserver-1", &record);

        for attempt_number in 1..MAX_PENDING_DELETE_ATTEMPTS {
            let attempt = pending.begin("lib-test::w-1").unwrap();
            assert_eq!(attempt.attempt, attempt_number);
            assert_eq!(
                pending.finish(&attempt.label, false),
                Some(PendingDeleteFinish::AwaitingRetry),
            );
        }
        let final_attempt = pending.begin("lib-test::w-1").unwrap();
        assert_eq!(final_attempt.attempt, MAX_PENDING_DELETE_ATTEMPTS);
        assert_eq!(
            pending.finish(&final_attempt.label, false),
            Some(PendingDeleteFinish::Exhausted {
                window_id: "w-1".to_string(),
                window_name: "🏠 Terminal Window 1".to_string(),
                attempts: MAX_PENDING_DELETE_ATTEMPTS,
            }),
        );
        assert!(pending.begin("lib-test::w-1").is_none());
        assert!(pending.contains("lib-test::w-1"));
    }

    #[test]
    fn opens_missing_keeps_existing_closes_extra() {
        // w-1 already open (keep), w-2 new (open), w-9 open but gone from snap (close).
        let s = FakeSurface::with(&["local::w-1", "local::w-9"]);
        let snap = vec![
            rec("local", "w-1", WindowKind::Terminal),
            rec("local", "w-2", WindowKind::Workspace),
        ];
        reconcile("local", &snap, &none(), &s);
        assert_eq!(*s.opened.borrow(), vec!["local::w-2"]);
        assert_eq!(*s.closed.borrow(), vec!["local::w-9"]);
    }

    #[test]
    fn library_id_scopes_the_native_key() {
        // The same window_id in two libraries are distinct native windows.
        let a = rec("local", "w-1", WindowKind::Terminal);
        let b = rec("lib-abc", "w-1", WindowKind::Terminal);
        assert_ne!(native_label(&a), native_label(&b));
        assert_eq!(native_label(&b), "lib-abc::w-1");
    }

    /// Guards the create-before-snapshot property against a REAL `notify_waiters()`
    /// (not the fake feed). The feed fires its change signal SYNCHRONOUSLY during
    /// the first `snapshot()` -- inside the snapshot↔await window -- then returns the
    /// window on the next snapshot. Because the change future is created before the
    /// snapshot, it captures the pre-fire generation; the fire advances it and the
    /// next poll catches it, so the loop re-reconciles and opens `w-1`. A loop that
    /// created its change future only AFTER the snapshot (e.g. an opaque
    /// `async fn changed()`) would capture the post-fire generation, block forever,
    /// and never open `w-1` -- so this assertion fails if that regression slips in.
    #[tokio::test]
    async fn watch_loop_catches_a_change_fired_in_the_snapshot_gap() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Default)]
        struct ShareSurface {
            opened: std::sync::Mutex<Vec<String>>,
        }
        impl NativeSurface for Arc<ShareSurface> {
            fn open_labels(&self, _library_id: &str) -> HashSet<String> {
                self.opened.lock().unwrap().iter().cloned().collect()
            }
            fn open(&self, record: &WindowRecord) {
                self.opened.lock().unwrap().push(native_label(record));
            }
            fn close(&self, label: &str) {
                self.opened.lock().unwrap().retain(|l| l != label);
            }
        }

        struct GapFeed {
            notify: Arc<Notify>,
            calls: AtomicUsize,
        }
        impl WindowFeed for GapFeed {
            fn snapshot(&self) -> Vec<WindowRecord> {
                if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    // Fire a change DURING the snapshot -- the snapshot↔await gap.
                    self.notify.notify_waiters();
                    Vec::new()
                } else {
                    vec![rec("local", "w-1", WindowKind::Terminal)]
                }
            }
            fn change_notify(&self) -> Arc<Notify> {
                self.notify.clone()
            }
        }

        let notify = Arc::new(Notify::new());
        let feed = GapFeed {
            notify: notify.clone(),
            calls: AtomicUsize::new(0),
        };
        let surface = Arc::new(ShareSurface::default());
        let view = Arc::new(WatcherViewState::default());
        let cancel = Arc::new(Notify::new());

        let surface_in = Arc::clone(&surface);
        let cancel_in = Arc::clone(&cancel);
        let task = tokio::spawn(async move {
            watch_loop(Some("local"), feed, surface_in, view, async move {
                cancel_in.notified().await;
                WatchLoopStop::CloseWindows
            })
            .await;
        });

        // Give the loop time to run the gap iteration + the re-reconcile, then
        // capture the open set WHILE it is parked in select. Cancel now makes the
        // loop reconcile its windows away (the disconnect semantics -- the watcher
        // is the sole driver of both open and close), so the gap-catch's open must
        // be observed BEFORE tearing the loop down, not after.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let opened_during_run = surface.opened.lock().unwrap().clone();
        cancel.notify_waiters();
        let _ = task.await;

        assert_eq!(
            opened_during_run,
            vec!["local::w-1".to_string()],
            "create-before-snapshot must catch the gap-fired notify_waiters and reconcile",
        );
    }

    /// Disconnect semantics: flipping the loop's cancel makes it reconcile to an
    /// EMPTY set, closing every window it opened (detach, NOT reap -- the library
    /// keeps the records server-side, so a reconnect reopens them). The watcher
    /// being the sole driver of CLOSE is what lets `disconnect_devserver` just fire
    /// the cancel instead of reaching for the windows imperatively.
    #[tokio::test]
    async fn watch_loop_closes_its_windows_on_cancel() {
        #[derive(Default)]
        struct RecordSurface {
            open_now: std::sync::Mutex<HashSet<String>>,
            closed: std::sync::Mutex<Vec<String>>,
        }
        impl NativeSurface for Arc<RecordSurface> {
            fn open_labels(&self, _library_id: &str) -> HashSet<String> {
                self.open_now.lock().unwrap().clone()
            }
            fn open(&self, record: &WindowRecord) {
                self.open_now.lock().unwrap().insert(native_label(record));
            }
            fn close(&self, label: &str) {
                self.open_now.lock().unwrap().remove(label);
                self.closed.lock().unwrap().push(label.to_string());
            }
        }

        struct StaticFeed {
            notify: Arc<Notify>,
        }
        impl WindowFeed for StaticFeed {
            fn snapshot(&self) -> Vec<WindowRecord> {
                vec![rec("local", "w-1", WindowKind::Terminal)]
            }
            fn change_notify(&self) -> Arc<Notify> {
                self.notify.clone()
            }
        }

        let notify = Arc::new(Notify::new());
        let feed = StaticFeed {
            notify: notify.clone(),
        };
        let surface = Arc::new(RecordSurface::default());
        let view = Arc::new(WatcherViewState::default());
        let cancel = Arc::new(Notify::new());

        let surface_in = Arc::clone(&surface);
        let cancel_in = Arc::clone(&cancel);
        let task = tokio::spawn(async move {
            watch_loop(Some("local"), feed, surface_in, view, async move {
                cancel_in.notified().await;
                WatchLoopStop::CloseWindows
            })
            .await;
        });

        // The loop opens w-1 and parks in select.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(
            surface
                .open_now
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["local::w-1".to_string()],
            "the loop opens the library's window before cancel",
        );

        cancel.notify_waiters();
        let _ = task.await;

        assert!(
            surface.open_now.lock().unwrap().is_empty(),
            "cancel reconciles the loop's windows away",
        );
        assert_eq!(
            *surface.closed.lock().unwrap(),
            vec!["local::w-1".to_string()],
            "cancel closes exactly the window the loop opened",
        );
    }

    /// Watcher handoff semantics: token rotation starts a replacement watcher for
    /// the same library labels. The retired watcher must stop without reconciling
    /// to empty, or it can destroy windows the replacement watcher just refreshed.
    #[tokio::test]
    async fn watch_loop_keeps_its_windows_on_handoff_cancel() {
        #[derive(Default)]
        struct RecordSurface {
            open_now: std::sync::Mutex<HashSet<String>>,
            closed: std::sync::Mutex<Vec<String>>,
        }
        impl NativeSurface for Arc<RecordSurface> {
            fn open_labels(&self, _library_id: &str) -> HashSet<String> {
                self.open_now.lock().unwrap().clone()
            }
            fn open(&self, record: &WindowRecord) {
                self.open_now.lock().unwrap().insert(native_label(record));
            }
            fn close(&self, label: &str) {
                self.open_now.lock().unwrap().remove(label);
                self.closed.lock().unwrap().push(label.to_string());
            }
        }

        struct StaticFeed {
            notify: Arc<Notify>,
        }
        impl WindowFeed for StaticFeed {
            fn snapshot(&self) -> Vec<WindowRecord> {
                vec![rec("local", "w-1", WindowKind::Terminal)]
            }
            fn change_notify(&self) -> Arc<Notify> {
                self.notify.clone()
            }
        }

        let notify = Arc::new(Notify::new());
        let feed = StaticFeed {
            notify: notify.clone(),
        };
        let surface = Arc::new(RecordSurface::default());
        let view = Arc::new(WatcherViewState::default());
        let cancel = Arc::new(Notify::new());

        let surface_in = Arc::clone(&surface);
        let cancel_in = Arc::clone(&cancel);
        let task = tokio::spawn(async move {
            watch_loop(Some("local"), feed, surface_in, view, async move {
                cancel_in.notified().await;
                WatchLoopStop::KeepWindows
            })
            .await;
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(
            surface
                .open_now
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["local::w-1".to_string()],
            "the loop opens the library's window before handoff",
        );

        cancel.notify_waiters();
        let _ = task.await;

        assert_eq!(
            surface
                .open_now
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["local::w-1".to_string()],
            "handoff cancel leaves existing windows for the replacement watcher",
        );
        assert!(
            surface.closed.lock().unwrap().is_empty(),
            "handoff cancel must not close windows",
        );
    }

    #[test]
    fn view_state_bury_unbury_tracks_local_set() {
        let view = WatcherViewState::default();
        assert!(view.buried_snapshot().is_empty());
        view.bury("local::w-1");
        view.bury("local::w-2");
        assert_eq!(view.buried_snapshot().len(), 2);
        assert!(view.buried_snapshot().contains("local::w-1"));
        view.unbury("local::w-1");
        assert_eq!(
            view.buried_snapshot().into_iter().collect::<Vec<_>>(),
            vec!["local::w-2".to_string()]
        );
        assert!(view.is_buried("local::w-2"));
        assert!(!view.is_buried("local::w-1"));
    }
}
