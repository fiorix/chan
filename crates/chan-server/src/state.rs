//! Server-wide state shared across handlers.
//!
//! `AppState` is the immutable boot bundle every route reaches into.
//! `WorkspaceCell` wraps the live `Arc<Workspace>` plus its watcher and indexer
//! so `/api/storage/reset` can swap them wholesale without restarting
//! the process.

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use chan_workspace::{Library, WatchEvent, WatchHandle, Workspace};
use tokio::sync::{broadcast, watch};

use crate::agent_inbox::AgentInbox;
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
    /// reset itself; handlers reach the inner Arc<Workspace> via
    /// `state.workspace()` which clones it under a read lock.
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
    /// the server's lifetime: set to true on `--tunnel-public` runs
    /// (anonymous visitors must not mutate owner config), false on
    /// OAuth-gated tunnel runs and on local serve. `serve_static`
    /// reads it to inject the `<meta name="chan-settings-disabled">`
    /// tag, and the `tunnel_guard::settings_guard` middleware reads
    /// it to refuse the settings-write routes server-side.
    pub settings_disabled: bool,
    /// Snapshot of `ServeConfig::tunnel_public`. Stricter than
    /// `settings_disabled`: only true on `--tunnel-public` runs
    /// where the gateway is NOT authenticating the viewer. Read by:
    ///
    ///   - the read-only handlers that would otherwise leak host
    ///     state (`api_get_workspace`, `api_get_config`,
    ///     `api_cloud_workspaces`): they strip absolute paths and the
    ///     workspace registry before serializing.
    pub tunnel_public: bool,
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
    /// chan-server's own preferences (attachments_dir, etc). Mutable
    /// via PATCH /api/server/config; reads route through the get
    /// handler.
    pub server_config: Mutex<ServerConfig>,
    /// Editor preferences: fonts / theme / pane widths / line
    /// spacing / date format. Persisted to
    /// `<config>/chan/preferences.toml`; mutated through the
    /// /api/config PATCH path.
    pub editor_prefs: Mutex<EditorPrefs>,
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
    pub agent_inbox: Arc<AgentInbox>,
    /// Process-wide shutdown signal. Fires once SIGINT/SIGTERM or
    /// the idle-timeout watcher trip. Long-lived handlers (e.g.
    /// `/ws`) observe this to close their sockets promptly so axum's
    /// graceful drain returns in milliseconds instead of holding
    /// open until the hard deadline.
    pub shutdown_rx: watch::Receiver<bool>,
    /// phase-11 Slice C: per-directory scoped watcher pub/sub. The
    /// File Browser / Graph send `sub`/`unsub` frames over `/ws`; this
    /// registry refcounts subscribers per directory and the watcher
    /// bridge routes scoped `fs` frames here (derived from the single
    /// recursive feed, Decision D1(b)). Survives `/api/storage/reset`:
    /// the rebuilt bridge re-references the same registry so live
    /// subscriptions keep flowing onto the new workspace's events.
    pub scope_registry: Arc<crate::bus::ScopeRegistry>,
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
    #[error("workspace cell lock poisoned")]
    WorkspaceCellPoisoned,
    #[error("workspace cell missing outside reset window")]
    WorkspaceCellMissing,
}

impl AppState {
    /// Snapshot the current workspace Arc. Acquires the RwLock read
    /// guard for the duration of the clone (microseconds). The
    /// returned Arc keeps the workspace alive even if a reset swaps
    /// the cell out a moment later, so callers don't need to hold
    /// the lock through their I/O.
    ///
    pub fn try_workspace(&self) -> Result<Arc<Workspace>, StateAccessError> {
        let cell = self
            .workspace_cell
            .read()
            .map_err(|_| StateAccessError::WorkspaceCellPoisoned)?;
        let Some(cell) = cell.as_ref() else {
            return Err(StateAccessError::WorkspaceCellMissing);
        };
        Ok(cell.workspace.clone())
    }

    /// Legacy infallible accessor for call sites that have not yet
    /// been converted to explicit HTTP errors. New route code should
    /// prefer `try_workspace`.
    pub fn workspace(&self) -> Arc<Workspace> {
        self.try_workspace().expect("workspace state unavailable")
    }

    /// Snapshot the live indexer Arc. Same RwLock pattern as
    /// `workspace()`: held only for the duration of the clone.
    pub fn try_indexer(&self) -> Result<Arc<indexer::Indexer>, StateAccessError> {
        let cell = self
            .workspace_cell
            .read()
            .map_err(|_| StateAccessError::WorkspaceCellPoisoned)?;
        let Some(cell) = cell.as_ref() else {
            return Err(StateAccessError::WorkspaceCellMissing);
        };
        Ok(cell.indexer.clone())
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Minimal `AppState` builder for tests that exercise the
    //! middleware / handlers but don't need a real workspace on disk.
    //! The `workspace_cell` is intentionally left `None`: callers that
    //! try to reach into it will hit the `workspace_cell missing` panic
    //! from `AppState::workspace()`, which is the right failure mode
    //! (the test isn't supposed to touch the workspace).
    //!
    //! The `Library` is opened against a tempfile so that
    //! `list_workspaces` returns an empty Vec and registry writes don't
    //! pollute the developer's `~/.chan/config.toml`.

    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex, RwLock};

    use chan_workspace::Library;
    use tokio::sync::{broadcast, watch};

    use super::AppState;
    use crate::agent_inbox::AgentInbox;
    use crate::self_writes::SelfWrites;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    /// Build an `AppState` with the two policy bools set to the
    /// requested values and everything else stubbed to defaults.
    /// The returned `AppState` is safe to wrap in `Arc` and hand to
    /// axum extractors; reading any workspace-bearing field will panic
    /// (by design).
    pub fn make_test_state(settings_disabled: bool, tunnel_public: bool) -> Arc<AppState> {
        // The TempDir's path is what Library::open_at uses for any
        // later registry writes (register_workspace, set_default_workspace_root,
        // ...). Letting it drop here would delete the directory and
        // make those writes fail with ENOENT, which is a subtle
        // footgun for any future test that uses make_test_state and
        // mutates the registry. Leak the guard so the directory
        // outlives the test process: cheap (`#[cfg(test)]` only,
        // the process exits in seconds), avoids the footgun, and is
        // simpler than threading a lifetime through AppState.
        let tmp = tempfile::tempdir().expect("tempdir");
        let lib = Library::open_at(tmp.path().join("config.toml")).expect("open library");
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
            tunnel_public,
            events_tx,
            index_events_tx,
            server_config: Mutex::new(ServerConfig::default()),
            editor_prefs: Mutex::new(EditorPrefs::default()),
            self_writes: Arc::new(SelfWrites::new()),
            last_activity: Arc::new(AtomicU64::new(0)),
            terminal_sessions: Arc::new(TerminalRegistry::new(RegistryConfig {
                workspace_root: PathBuf::from("/dev/null"),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            agent_inbox: Arc::new(AgentInbox::new(
                ServerConfig::default().team_work.inbox_depth,
            )),
            shutdown_rx,
            scope_registry: Arc::new(crate::bus::ScopeRegistry::new()),
        })
    }

    #[test]
    fn try_workspace_reports_missing_cell() {
        let state = make_test_state(false, false);

        assert!(matches!(
            state.try_workspace(),
            Err(super::StateAccessError::WorkspaceCellMissing)
        ));
    }

    #[test]
    fn try_indexer_reports_poisoned_workspace_cell() {
        let state = make_test_state(false, false);
        let workspace_cell = state.workspace_cell.clone();
        let _ = std::thread::spawn(move || {
            let _guard = workspace_cell.write().expect("poison setup");
            panic!("poison workspace cell");
        })
        .join();

        assert!(matches!(
            state.try_indexer(),
            Err(super::StateAccessError::WorkspaceCellPoisoned)
        ));
    }
}
