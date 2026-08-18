//! Server-wide state shared across handlers.
//!
//! `AppState` is the immutable boot bundle every route reaches into.
//! `WorkspaceCell` wraps the live `Arc<Workspace>` plus its watcher and indexer
//! so `/api/storage/reset` can swap them wholesale without restarting
//! the process.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard, TryLockError};

use chan_workspace::{Library, WatchEvent, WatchHandle, Workspace};
use tokio::sync::{broadcast, watch};

use crate::indexer;
use crate::self_writes::SelfWrites;
use crate::terminal_sessions::Registry as TerminalRegistry;
use crate::{EditorPrefs, ServerConfig};

/// Server state shared across all handlers.
pub struct AppState {
    pub library: Library,
    /// Workspace root resolved at boot. Stays stable for the server's
    /// lifetime even when `workspace_cell` is swapped during a reset
    /// (the swap reopens against the same root).
    pub workspace_root: PathBuf,
    /// Live workspace + its watcher, behind an RwLock so /api/storage/
    /// reset can drop and reopen them without restarting the
    /// process. Always `Some` outside the brief swap window inside
    /// reset itself; handlers take a fallible nonblocking snapshot
    /// so reset contention never parks an async worker.
    pub workspace_cell: Arc<RwLock<Option<WorkspaceCell>>>,
    pub token: Option<String>,
    /// Canonical URL prefix the SPA prepends to fetch and WebSocket
    /// URLs, injected into the shell as `<meta name="chan-prefix">`.
    /// Mutable so tunnel mode can swap in the registration prefix
    /// (`/{user}/{workspace}`) on Connected; the local-serve path sets
    /// it once at build time from `ServeConfig::prefix` and never
    /// touches it again. Empty when no prefix.
    ///
    /// Note: this is the SPA-facing prefix only; the axum router is
    /// already nested under `ServeConfig::prefix` at build time, so
    /// changing this value does not re-route handlers. In tunnel
    /// mode the public gateway strips the prefix before forwarding,
    /// which is why the router stays mounted at root.
    pub prefix: Arc<RwLock<String>>,
    /// Snapshot of `ServeConfig::settings_disabled`. Immutable for
    /// the server's lifetime: true only on a `--no-settings` serve (the
    /// kiosk / shared-workstation mode where the operator at the keyboard
    /// is not the workspace owner), false everywhere else, including
    /// devserver tenants (which run settings-enabled and authenticate the
    /// owner through the gateway) and ordinary local serves. `serve_static`
    /// reads it to inject the `<meta name="chan-settings-disabled">`
    /// tag, and the `tunnel_guard::settings_guard` middleware reads
    /// it to refuse the settings-write routes server-side.
    pub settings_disabled: bool,
    /// Last activity timestamp (unix seconds). Bumped by HTTP
    /// middleware on every request, by `ws_upgrade` on connect,
    /// and by `ws_pump` on every successful frame send. The idle
    /// watcher task compares this against `now` to decide when to
    /// trigger a graceful shutdown. Always present; the watcher
    /// task only runs when `--timeout` is set.
    pub last_activity: Arc<AtomicU64>,
    /// Pre-serialized JSON-envelope frames: `{"type": "watch",
    /// "event": ...}`, `{"type": "progress", "event": ...}`, etc.
    /// One channel; the `type` field tells the frontend what to do.
    pub events_tx: broadcast::Sender<String>,
    /// Raw watcher events feeding the background indexer. Lives at
    /// AppState scope (not just inside WorkspaceCell) so the bridge
    /// constructor at /api/storage/reset time can reuse the same
    /// channel without resubscribing the indexer to a fresh one.
    pub index_events_tx: broadcast::Sender<WatchEvent>,
    /// chan-server's own preferences (attachments_dir, etc).
    pub server_config: Mutex<ServerConfig>,
    /// Editor preferences: fonts / theme / pane widths / line
    /// spacing / date format. Persisted to
    /// `<config>/chan/preferences.toml`; mutated through the
    /// /api/config PATCH path.
    pub editor_prefs: Mutex<EditorPrefs>,
    pub config_revision: AtomicU64,
    pub config_write_serial: Mutex<()>,
    /// Recently-written paths for the watcher dedupe. Every server-
    /// side write notes its target here; WatchBroadcast checks the
    /// queue before forwarding so an editor save doesn't bounce
    /// back as an "external edit" event.
    pub self_writes: Arc<SelfWrites>,
    /// Long-lived PTY session registry. WebSocket terminal routes
    /// attach/detach to entries here; the PTY itself outlives a
    /// browser reload until explicit close, workspace close, shutdown,
    /// cap eviction, or idle prune.
    pub terminal_sessions: Arc<TerminalRegistry>,
    /// Live co-editing document sessions. The doc WebSocket route
    /// attaches editors here; the flusher and reconciler tasks keep
    /// the sessions and the disk in step. Survives `/api/storage/
    /// reset` structurally (the registry object persists) but reset
    /// closes every session via `close_all` before the cell swap.
    pub doc_sessions: Arc<crate::doc_sessions::DocRegistry>,
    /// Live Excalidraw scene sessions. The scene WebSocket route
    /// attaches canvases here; the scene flusher and reconciler tasks
    /// keep the sessions and the disk in step. Same reset semantics as
    /// `doc_sessions`.
    pub scene_sessions: Arc<crate::scene_sessions::SceneRegistry>,
    /// Process-wide shutdown signal. Fires once SIGINT/SIGTERM or
    /// the idle-timeout watcher trip. Long-lived handlers (e.g.
    /// `/ws`) observe this to close their sockets promptly so axum's
    /// graceful drain returns in milliseconds instead of holding
    /// open until the hard deadline.
    pub shutdown_rx: watch::Receiver<bool>,
    /// Per-directory scoped watcher pub/sub. The File Browser /
    /// Graph send `sub`/`unsub` frames over `/ws`; this registry
    /// refcounts subscribers per directory and the watcher bridge
    /// routes scoped `fs` frames here (derived from the single
    /// recursive feed). Survives `/api/storage/reset`:
    /// the rebuilt bridge re-references the same registry so live
    /// subscriptions keep flowing onto the new workspace's events.
    pub scope_registry: Arc<crate::bus::ScopeRegistry>,
    /// `cs terminal survey` blocked-transport registry. The control
    /// socket parks a oneshot here per in-flight survey and awaits it;
    /// the SPA reply route (`POST /api/survey/reply`) completes it. Shared
    /// so both ends reach the same map. Survives nothing in particular: a
    /// survey is in-memory and transient by nature.
    ///
    /// Read only by the `POST /api/survey/reply` route; the producer
    /// side (the control socket's `register`/`cancel`) gets its own
    /// clone in `build_app`.
    pub survey_bus: Arc<crate::survey::SurveyBus>,
    /// `cs pane` blocked-transport registry. Same shape + lifecycle as
    /// `survey_bus`: the control socket parks a oneshot here per in-flight
    /// `cs pane` query and awaits it; the SPA reply route (`POST
    /// /api/window/reply`) completes it with the layout snapshot. Shared so
    /// both ends reach the same map; transient in-memory state.
    pub window_bus: Arc<crate::window_bus::WindowBus>,
    /// `cs session handover` blocked-transport registry. Same shape and
    /// lifecycle as `survey_bus`/`window_bus`: the control socket parks the
    /// requester's oneshot here and the leader's answer (`POST
    /// /api/session/handover/reply`, or the leader's own CLI) completes it.
    pub handover_bus: Arc<crate::handover_bus::HandoverBus>,
    /// In-memory per-window session-blob store for workspace-LESS tenants
    /// (standalone terminal windows). A workspace tenant persists layout via
    /// `Workspace::{put,get}_session` on disk; a terminal tenant has no
    /// workspace dir, so its `/api/session` blobs live here, keyed by the
    /// `?w=<window-label>` id. Tenant-scoped: survives a webview reload
    /// (Cmd+R re-attaches to the surviving PTYs) and is dropped when the
    /// window closes and the tenant is torn down. Unused on workspace
    /// tenants, which take the disk path in the session handlers.
    pub ephemeral_sessions: Mutex<HashMap<String, Vec<u8>>>,
    /// The filesystem sibling of `ephemeral_sessions`: in-memory layout blobs
    /// for windows holding browser/editor tabs on a store-less terminal
    /// tenant, addressed with `?app=files`. A separate map (and, on disk, a
    /// separate `files/` child of the terminal blob dir) keeps those layouts
    /// out of the plain namespace, so the same window booted against a host
    /// that serves no filesystem never restores tabs whose routes are not
    /// there.
    pub ephemeral_files_sessions: Mutex<HashMap<String, Vec<u8>>>,
    /// On-disk per-window session-blob store for a PERSISTED terminal tenant  --
    /// the desktop's standalone `/terminal` tenant and a standalone devserver
    /// terminal -- so its pane/tab layout survives a relaunch (with fresh shells;
    /// the PTYs themselves don't survive). `Some(dir)` ⇒ the session handlers
    /// read/write [`crate::terminal_blob`] at `dir`, keyed by the
    /// `?w=<window-label>`, instead of `ephemeral_sessions`; `None` ⇒ the
    /// in-memory store above (control terminals, whose layout is ephemeral by
    /// design).
    pub terminal_session_dir: Option<std::path::PathBuf>,
    /// Which window ids currently hold a `/ws` socket (refcounted; see
    /// the module docs). Feeds `GET /api/windows` and `cs window list`
    /// with the connected/saved split.
    pub window_presence: Arc<crate::window_presence::WindowPresence>,
    /// The per-tenant leader/followers session: who is connected, who
    /// leads, and the live/disconnecting/disconnected/gone lifecycle. The
    /// `/ws` pump joins it per socket; `cs session` reads and drives it.
    /// Layered over `window_presence` (which still backs the connected
    /// flag); see the `session_presence` module docs.
    pub session_registry: Arc<crate::session_presence::SessionRegistry>,
    /// Window commands parked for a window that has no socket YET, drained by
    /// its first `/ws` attach. Only the routed-open path parks (a `cs open`
    /// whose path belongs to a window the server just minted); every other
    /// window command still refuses a disconnected target, because there the
    /// caller named the window and a missing one is the caller's mistake.
    pub pending_window_commands: Arc<chan_library::pending_window_commands::PendingWindowCommands>,
    /// Per-window in-flight transfer count (refcounted; see the module
    /// docs). Reported by the SPA over `/ws` and read by the desktop close
    /// guard (`WorkspaceHost::tenant_has_active_transfer`).
    pub window_transfers: Arc<crate::window_transfers::WindowTransfers>,
    /// Desktop-written, server-read map of window id -> OS title + kind.
    /// Empty unless chan-desktop is the embedder; `GET /api/windows` and
    /// `cs window list` read it to show the real OS title alongside each
    /// `{id, connected, saved}` row.
    pub window_titles: crate::window_titles::SharedWindowTitles,
    /// This tenant's admission handle onto the process-wide bulk transfer
    /// lane. Deliberately the tenant handle and not the lane itself: routes
    /// must be able to submit and cancel without being able to shut the lane
    /// down or to observe another tenant's queue.
    pub bulk_transfer: crate::bulk_transfer::BulkTransferTenant,
    /// Random id minted when this tenant was built, exposed via
    /// `GET /api/health`. The SPA compares it across `/ws` reconnects:
    /// a CHANGED id means the process behind the window was restarted
    /// (a remote `chan open` bounced) -- its PTYs and in-memory state
    /// are gone, so the SPA reloads itself instead of sitting on a
    /// stale view with stuck terminals until a manual Cmd+R.
    pub instance_id: String,
    /// The standalone filesystem surface's state bundle, present only on a
    /// shared terminal tenant that constructed a supported one. Workspace
    /// tenants and unsupported terminal tenants carry `None`; the file routes
    /// and the `/ws` scope plumbing read it directly and never touch
    /// `workspace_cell`. Its presence is also what the served SPA shell
    /// advertises, so a standalone terminal window knows whether it can offer
    /// the file browser and the editor.
    pub standalone_files: Option<Arc<StandaloneFilesState>>,
}

/// Everything the standalone filesystem surface owns beyond the plain
/// terminal tenant: the `/`-rooted capability filesystem, the scoped
/// non-recursive watch manager producing this tenant's `fs` frames, and the
/// mutation bus attributing its own writes.
pub struct StandaloneFilesState {
    pub fs: Arc<chan_workspace::MiniWorkspace>,
    pub watcher: Arc<crate::standalone_watch::ScopedWatchManager>,
    pub mutations: Arc<crate::standalone_mutations::StandaloneMutationBus>,
}

/// Workspace + its notify watcher. Replaced wholesale by /api/storage/
/// reset: drop the cell, run chan-workspace's reset_workspace, reopen, store
/// a fresh cell. The watch_handle is `Option` only because reset
/// must take it out before dropping the inner Workspace (the watcher
/// holds a callback that references the same broadcast channel; we
/// keep it tidy by dropping the handle first).
pub struct WorkspaceCell {
    pub workspace: Arc<Workspace>,
    pub watch_handle: Option<WatchHandle>,
    /// Background indexer for the live workspace. Replaced wholesale
    /// on /api/storage/reset (the new workspace needs a fresh indexer
    /// pinned to its `Arc<Workspace>`). Drop = abort = workers stop.
    pub indexer: Arc<indexer::Indexer>,
}

#[derive(Debug, thiserror::Error)]
pub enum StateAccessError {
    #[error("workspace cell busy")]
    Busy,
    #[error("workspace cell lock poisoned")]
    Poisoned,
    #[error("workspace cell missing outside a reset or import window")]
    Missing,
}

impl AppState {
    fn try_workspace_cell(
        &self,
    ) -> Result<RwLockReadGuard<'_, Option<WorkspaceCell>>, StateAccessError> {
        match self.workspace_cell.try_read() {
            Ok(cell) => Ok(cell),
            Err(TryLockError::WouldBlock) => Err(StateAccessError::Busy),
            Err(TryLockError::Poisoned(_)) => Err(StateAccessError::Poisoned),
        }
    }

    /// Snapshot the current workspace Arc without waiting for a reset
    /// writer. The read guard lives only for the duration of the clone. The
    /// returned Arc keeps the workspace alive even if a reset swaps
    /// the cell out a moment later, so callers don't need to hold
    /// the lock through their I/O.
    pub fn try_workspace(&self) -> Result<Arc<Workspace>, StateAccessError> {
        let cell = self.try_workspace_cell()?;
        let Some(cell) = cell.as_ref() else {
            return Err(StateAccessError::Missing);
        };
        Ok(cell.workspace.clone())
    }

    /// Snapshot the live indexer Arc without waiting for a reset writer.
    pub fn try_indexer(&self) -> Result<Arc<indexer::Indexer>, StateAccessError> {
        let cell = self.try_workspace_cell()?;
        let Some(cell) = cell.as_ref() else {
            return Err(StateAccessError::Missing);
        };
        Ok(cell.indexer.clone())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Minimal `AppState` builder for tests that exercise the
    //! middleware / handlers but don't need a real workspace on disk.
    //! The `workspace_cell` is intentionally left `None`: callers that
    //! try to reach into it receive `StateAccessError::Missing`.
    //!
    //! The `Library` is opened against a tempfile so that
    //! `list_workspaces` returns an empty Vec and registry writes don't
    //! pollute the developer's `~/.chan/config.toml`.

    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::{mpsc, Arc, Barrier, Mutex, OnceLock, RwLock};
    use std::time::Duration;

    use chan_workspace::Library;
    use tokio::sync::{broadcast, oneshot, watch};

    use super::AppState;
    use crate::self_writes::SelfWrites;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    /// A distinct tenant handle over one lane shared by the whole test
    /// binary. Per-call lanes would spawn two OS threads for every test that
    /// builds an `AppState` and never join them, since a test state has no
    /// teardown point. Sharing one lane keeps that bounded while still giving
    /// each caller its own tenant identity, which is the property the
    /// admission contract actually depends on.
    pub fn make_test_bulk_transfer_tenant() -> crate::bulk_transfer::BulkTransferTenant {
        static LANE: OnceLock<Arc<crate::bulk_transfer::BulkTransferLane>> = OnceLock::new();
        LANE.get_or_init(crate::bulk_transfer::BulkTransferLane::new)
            .tenant()
    }

    /// Build an `AppState` with the two policy bools set to the
    /// requested values and everything else stubbed to defaults.
    /// The returned `AppState` is safe to wrap in `Arc` and hand to
    /// axum extractors; workspace access returns `StateAccessError::Missing`.
    pub fn make_test_state(settings_disabled: bool) -> Arc<AppState> {
        make_test_state_with_transfer_max_bytes(settings_disabled, None)
    }

    /// Build a workspace-less test state with an explicit transfer ceiling.
    pub fn make_test_state_with_transfer_max_bytes(
        settings_disabled: bool,
        transfer_max_bytes: Option<u64>,
    ) -> Arc<AppState> {
        // The TempDir's path is what Library::open_at uses for any
        // later registry writes (register_workspace, ...). Letting it
        // drop here would delete the directory and
        // make those writes fail with ENOENT, which is a subtle
        // footgun for any future test that uses make_test_state and
        // mutates the registry. Leak the guard so the directory
        // outlives the test process: cheap (`#[cfg(test)]` only,
        // the process exits in seconds), avoids the footgun, and is
        // simpler than threading a lifetime through AppState.
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("config.toml");
        if let Some(max_bytes) = transfer_max_bytes {
            std::fs::write(
                &config_path,
                format!("workspaces = []\n[transfer]\nmax_bytes = {max_bytes}\n"),
            )
            .expect("write transfer config");
        }
        let lib = Library::open_at(config_path).expect("open library");
        std::mem::forget(tmp);
        let (events_tx, _) = broadcast::channel::<String>(1);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        // A never-tripped shutdown channel: tests don't run the
        // signal watcher, so the receiver stays parked on the
        // initial `false` value for the lifetime of the AppState.
        // Sender is leaked so the rx isn't seen as closed.
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        std::mem::forget(shutdown_tx);
        Arc::new(AppState {
            library: lib,
            workspace_root: PathBuf::from("/dev/null"),
            workspace_cell: Arc::new(RwLock::new(None)),
            token: None,
            prefix: Arc::new(RwLock::new(String::new())),
            settings_disabled,
            events_tx,
            index_events_tx,
            server_config: Mutex::new(ServerConfig::default()),
            editor_prefs: Mutex::new(EditorPrefs::default()),
            config_revision: AtomicU64::new(1),
            config_write_serial: Mutex::new(()),
            self_writes: Arc::new(SelfWrites::new()),
            last_activity: Arc::new(AtomicU64::new(0)),
            terminal_sessions: Arc::new(TerminalRegistry::new(RegistryConfig {
                workspace_root: PathBuf::from("/dev/null"),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            doc_sessions: Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: Arc::new(crate::survey::SurveyBus::new()),
            window_bus: Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: Mutex::new(HashMap::new()),
            ephemeral_files_sessions: Mutex::new(HashMap::new()),
            terminal_session_dir: None,
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            pending_window_commands: std::sync::Arc::new(Default::default()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: make_test_bulk_transfer_tenant(),
            instance_id: "test-instance".to_string(),
            standalone_files: None,
        })
    }

    #[test]
    fn try_workspace_reports_missing_cell() {
        let state = make_test_state(false);

        assert!(matches!(
            state.try_workspace(),
            Err(super::StateAccessError::Missing)
        ));
    }

    #[test]
    fn try_indexer_reports_poisoned_workspace_cell() {
        let state = make_test_state(false);
        let workspace_cell = state.workspace_cell.clone();
        let _ = std::thread::spawn(move || {
            let _guard = workspace_cell.write().expect("poison setup");
            panic!("poison workspace cell");
        })
        .join();

        assert!(matches!(
            state.try_indexer(),
            Err(super::StateAccessError::Poisoned)
        ));
    }

    #[test]
    fn try_workspace_does_not_wait_for_a_writer() {
        let state = make_test_state(false);
        let reader_state = state.clone();
        let writer = state.workspace_cell.write().expect("workspace cell writer");
        let ready = Arc::new(Barrier::new(2));
        let reader_ready = ready.clone();
        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            reader_ready.wait();
            tx.send(reader_state.try_workspace())
                .expect("send snapshot result");
        });

        ready.wait();
        let result = rx.recv_timeout(Duration::from_millis(100));
        drop(writer);
        reader.join().expect("reader thread");

        assert!(
            matches!(result, Ok(Err(super::StateAccessError::Busy))),
            "workspace snapshot waited for the writer instead of returning a state access error"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reset_contention_does_not_starve_single_worker_runtime() {
        let state = make_test_state(false);
        let workspace_cell = state.workspace_cell.clone();
        let (writer_ready_tx, writer_ready_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let _guard = workspace_cell.write().expect("workspace cell writer");
            writer_ready_tx.send(()).expect("signal held write lock");
            let _ = release_rx.recv_timeout(Duration::from_millis(500));
        });
        writer_ready_rx.recv().expect("writer holds workspace cell");

        // Schedule the access task first. A blocking read here parks the only
        // runtime worker, so the independent timer cannot fire before its
        // deadline. The nonblocking accessor returns Busy and leaves the
        // worker free to make unrelated async progress.
        let access_state = state.clone();
        let access = tokio::spawn(async move { access_state.try_workspace() });
        let (progress_tx, progress_rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = progress_tx.send(());
        });

        let progress = tokio::time::timeout(Duration::from_millis(100), progress_rx).await;
        let access = tokio::time::timeout(Duration::from_millis(100), access).await;
        let _ = release_tx.send(());
        writer.join().expect("workspace cell writer");

        assert!(
            matches!(progress, Ok(Ok(()))),
            "workspace contention starved unrelated async progress"
        );
        assert!(matches!(access, Ok(Ok(Err(super::StateAccessError::Busy)))));
    }

    #[test]
    fn try_indexer_reports_busy_cell() {
        let state = make_test_state(false);
        let _writer = state.workspace_cell.write().expect("workspace cell writer");

        assert!(matches!(
            state.try_indexer(),
            Err(super::StateAccessError::Busy)
        ));
    }
}
