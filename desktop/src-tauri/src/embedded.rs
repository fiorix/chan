//! Embedded local-workspace server for chan-desktop.
//!
//! This owns one loopback listener for the desktop process and
//! mounts local workspaces into chan-server's multi-workspace host.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use chan_server::{
    DesktopBridge, DesktopWindowOp, SharedWindowTitles, WindowRecord, WindowTitles,
    WorkspaceLifecycleOutcome,
};
use tokio::sync::{mpsc, watch, Notify};

use crate::config::{
    ConfigStore, DevserverConfigRegistry, DevserverRemoveHook, GatewayConfigRegistry,
    GatewayRemoveHook,
};
use crate::devserver::DevserverConns;
use crate::serve;

/// Bound on the window-ops channel: interactive `cs window` calls are
/// low-rate, so 32 is far above any real concurrency while still capping a
/// runaway caller.
const WINDOW_OPS_CHANNEL_CAPACITY: usize = 32;

pub struct EmbeddedServer {
    host: Arc<chan_server::WorkspaceHost>,
    extension_runtime: chan_server::ExtensionRuntime,
    addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    /// Cached launch URL of the single shared `/terminal` tenant that backs
    /// ALL standalone terminal windows, so their PTYs live in one registry
    /// (cross-window terminal moves work) under one global Terminal-N
    /// namespace. `None` until the first terminal window opens it; reused
    /// thereafter. The async lock serializes concurrent first-opens so two
    /// windows can't double-mount the prefix.
    terminal_url: tokio::sync::Mutex<Option<String>>,
    /// Receiver end of the `cs window <op>` bridge, parked here until Tauri
    /// `.setup()` (where the `AppHandle` exists) takes it and spawns the
    /// consumer task. `None` once taken, so a double-take can't spawn two
    /// consumers. The sender lives inside the host's [`DesktopBridge`].
    pending_window_ops: tokio::sync::Mutex<Option<mpsc::Receiver<DesktopWindowOp>>>,
    /// Per-launch bearer minted at startup. The launcher main window carries it
    /// in its URL as `?t=`, and the SPA presents it on every `/api/library/*`
    /// call; it gates that loopback surface (see [`launcher_token`](Self::launcher_token)).
    launcher_token: String,
}

/// Everything the launcher's registries and stores need from the desktop,
/// bundled so [`EmbeddedServer::start`] stays one readable argument as the
/// registry surface grows. All handles are shared with `AppState`.
pub struct RegistryDeps {
    pub config_store: Arc<Mutex<ConfigStore>>,
    pub devserver_remove_hook: Arc<OnceLock<DevserverRemoveHook>>,
    pub gateway_remove_hook: Arc<OnceLock<GatewayRemoveHook>>,
    pub gateway_manager: Arc<crate::gateway::GatewayManager>,
    pub devserver_conns: Arc<DevserverConns>,
    pub devserver_connecting: Arc<Mutex<HashSet<String>>>,
    pub devserver_feed: Arc<crate::DevserverFeed>,
}

impl EmbeddedServer {
    pub async fn start(deps: RegistryDeps) -> Result<Self, String> {
        let RegistryDeps {
            config_store,
            devserver_remove_hook,
            gateway_remove_hook,
            gateway_manager,
            devserver_conns,
            devserver_connecting,
            devserver_feed,
        } = deps;
        let library = chan_workspace::Library::open()
            .map_err(|e| format!("opening chan workspace registry for embedded server: {e}"))?;
        // Install the desktop bridge: a window-ops channel (the consumer
        // is spawned in Tauri `.setup()` once the AppHandle exists) plus a
        // shared title map every tenant reads and the desktop writes as it
        // builds/destroys webviews.
        let (window_ops_tx, window_ops_rx) = mpsc::channel(WINDOW_OPS_CHANNEL_CAPACITY);
        let bridge = DesktopBridge {
            window_ops: Some(window_ops_tx),
            window_titles: Arc::new(WindowTitles::new()),
        };
        let extension_runtime = chan_server::ExtensionRuntime::start().await;
        let host = Arc::new(chan_server::WorkspaceHost::with_desktop_bridge(
            library,
            bridge,
            chan_server::route_builder_with_extensions(&extension_runtime),
        ));
        // Register the host's self-handle so its per-tenant control sockets can
        // reach it for teardown -- otherwise the desktop's tenants report
        // `UnserveMode::Unsupported` and `chan close` fails. Parity with the
        // devserver path's `host.install_self()`.
        host.install_self();
        // The local library's stores: the window registry
        // (~/.chan/windows.json, library id "local") feeds the window list, and
        // the workspace on/off overlay (~/.chan/workspaces.json) lets the boot
        // path re-serve what was on -- the same store the devserver uses.
        chan_server::install_local_window_registry(&host);
        chan_server::install_local_workspace_overlay(&host);
        // Every launcher store below is installed over the one shared desktop
        // `ConfigStore`, so the launcher's `/api/library/*` CRUD and the
        // desktop's own reads agree: devservers, gateways, the local pane
        // colour, the launcher theme, and the collapsed machines (which
        // survive a desktop restart; the per-launch loopback origin keeps
        // localStorage from doing that). The headless devserver and plain
        // `chan serve` install no devserver or gateway registry (empty list,
        // 404 mutation).
        host.install_devserver_registry(Arc::new(DevserverConfigRegistry::new(
            Arc::clone(&config_store),
            devserver_remove_hook,
            devserver_conns,
            devserver_connecting,
            devserver_feed,
            Arc::clone(&gateway_manager),
        )));
        host.install_gateway_registry(Arc::new(GatewayConfigRegistry::new(
            Arc::clone(&config_store),
            gateway_remove_hook,
            gateway_manager,
        )));
        host.install_local_color_store(Arc::new(crate::config::LocalColorConfig::new(Arc::clone(
            &config_store,
        ))));
        host.install_local_theme_store(Arc::new(crate::config::LocalThemeConfig::new(Arc::clone(
            &config_store,
        ))));
        host.install_collapsed_machines_store(Arc::new(
            crate::config::CollapsedMachinesConfig::new(config_store),
        ));
        // Install the launcher SPA as the loopback's root fallback so the
        // desktop launcher loads the same web-launcher served at `/` on every
        // surface -- parity with the devserver's `build_devserver_app`. Without
        // it the root `/` 404s (`host_dispatch` only matches tenant prefixes).
        //
        // The loopback serves the FULL launcher surface, workspace mutation
        // included: `Some(&launcher_token)` gates `/api/library/*` on a per-launch
        // bearer (the main-window URL carries it as `?t=`; the SPA presents it on
        // every data call), and `serve_addr` lets the workspace-mount path read
        // this server's own listen address. The install runs before the bind, so
        // the address is delivered through a cell filled right after `local_addr()`.
        let launcher_token = uuid::Uuid::new_v4().to_string();
        let addr_cell: Arc<OnceLock<SocketAddr>> = Arc::new(OnceLock::new());
        // The bearer parameter is a shared cell (the devserver rotates its
        // token live through it); this per-launch token never rotates, so
        // the cell is written once here.
        chan_server::install_launcher_root_fallback(
            &host,
            Some(Arc::new(std::sync::RwLock::new(launcher_token.clone()))),
            Some(addr_cell.clone()),
        );
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| format!("binding embedded chan server: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("setting embedded listener nonblocking: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("reading embedded listener addr: {e}"))?;
        // The mount path can now resolve tenant URLs against this server.
        let _ = addr_cell.set(addr);
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|e| format!("adopting embedded listener: {e}"))?;
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let app = host.clone().router();
        tauri::async_runtime::spawn(async move {
            let result = serve_router(listener, app, async move {
                let _ = shutdown_rx.changed().await;
            })
            .await;
            if let Err(e) = result {
                tracing::warn!(error = %e, "embedded chan server stopped");
            }
        });
        Ok(Self::assemble(
            host,
            extension_runtime,
            addr,
            shutdown_tx,
            Some(window_ops_rx),
            launcher_token,
        ))
    }

    /// Assemble the server around a built host and start the lifecycle work
    /// every embedded server owns however it was constructed.
    ///
    /// The root health probe starts here rather than in each constructor
    /// because serving the launcher routes means owning their root health:
    /// nothing in the request path re-checks a mounted root while the user is
    /// idle, so a construction path that skipped the probe would report a gone
    /// or replaced workspace as `running` until a redundant add or on, and one
    /// degraded by a transient outage would stay degraded with minting refused.
    /// A single owner is also what keeps that true, since a second construction
    /// path is exactly where the probe would be forgotten. It stops when the
    /// server is dropped: `Drop` sends on `shutdown_tx` and the probe returns
    /// on that signal.
    fn assemble(
        host: Arc<chan_server::WorkspaceHost>,
        extension_runtime: chan_server::ExtensionRuntime,
        addr: SocketAddr,
        shutdown_tx: watch::Sender<bool>,
        pending_window_ops: Option<mpsc::Receiver<DesktopWindowOp>>,
        launcher_token: String,
    ) -> Self {
        let _root_health =
            chan_server::spawn_root_health_probe(host.clone(), shutdown_tx.subscribe());
        Self {
            host,
            extension_runtime,
            addr,
            shutdown_tx,
            terminal_url: tokio::sync::Mutex::new(None),
            pending_window_ops: tokio::sync::Mutex::new(pending_window_ops),
            launcher_token,
        }
    }

    /// A host-only server for tests: a real `WorkspaceHost` over `library`,
    /// with no loopback listener, no registries and no root fallback. Enough to
    /// mount and unmount real tenants, which is what the serve-lifecycle tests
    /// drive; anything that needs the HTTP surface is out of its reach.
    #[cfg(test)]
    pub async fn for_tests(library: chan_workspace::Library) -> Self {
        let host = Arc::new(chan_server::WorkspaceHost::new(
            library,
            chan_server::route_builder(),
        ));
        host.install_self();
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        // Through the same assembly the real constructor uses, so a test
        // observes the production wiring instead of a copy made for it.
        Self::assemble(
            host,
            chan_server::ExtensionRuntime::start().await,
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            shutdown_tx,
            None,
            String::new(),
        )
    }

    /// Install a workspace overlay at `store`, which
    /// [`for_tests`](Self::for_tests) leaves out, so a test can observe the
    /// on-set snapshot the desktop writes there.
    #[cfg(test)]
    pub fn install_workspace_overlay_for_tests(&self, store: std::path::PathBuf) {
        self.host
            .install_workspace_overlay(Arc::new(chan_server::WorkspaceOverlay::open(store)));
    }

    /// Install the local window registry, which [`for_tests`](Self::for_tests)
    /// leaves out, at its production store under the chan home. That store is
    /// `CHAN_HOME`'s, and the user's `~/.chan/windows.json` when none is set,
    /// so only a test running under [`in_own_chan_home`] may install it.
    #[cfg(test)]
    pub fn install_local_window_registry_for_tests(&self) {
        assert!(
            std::env::var_os("CHAN_HOME").is_some(),
            "a test that installs the local window registry runs in its own chan home"
        );
        chan_server::install_local_window_registry(&self.host);
    }

    /// Every workspace window record in the local registry, as its window id
    /// and the path it stores, the ones the live feed hides included, so a
    /// test sees what a mint stored whether or not the feed shows it.
    #[cfg(test)]
    pub fn workspace_window_paths_for_tests(&self) -> Vec<(String, String)> {
        self.host
            .window_registry()
            .map(|registry| {
                registry
                    .snapshot()
                    .into_iter()
                    .filter(|row| row.kind == chan_server::WindowKind::Workspace)
                    .filter_map(|row| Some((row.window_id, row.workspace_path?)))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The shared window-title map the desktop writes (on window build /
    /// rename / destroy) and the server reads for `cs window list`.
    pub fn window_titles(&self) -> SharedWindowTitles {
        self.host.desktop_bridge().window_titles.clone()
    }

    /// The per-launch launcher bearer. The desktop bakes it into the launcher
    /// main-window URL as `?t=`, so the loopback `/api/library/*` surface
    /// accepts the launcher's calls.
    pub fn launcher_token(&self) -> &str {
        &self.launcher_token
    }

    /// Take the `cs window <op>` receiver exactly once (in Tauri
    /// `.setup()`). Returns `None` on a second call so a re-entrant setup
    /// can't spawn two consumer tasks.
    pub fn take_window_ops_rx(&self) -> Option<mpsc::Receiver<DesktopWindowOp>> {
        self.pending_window_ops
            .try_lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    /// True when the window whose `?w=` session id is `window_id` has ≥1
    /// in-flight file transfer (upload/download). The transfer-close guard
    /// (serve.rs `CloseRequested`) queries it to prompt before closing a window
    /// mid-transfer.
    ///
    /// Keyed on the `?w=` window id (NOT the native window label: they diverge
    /// for watcher-opened windows, where the label is `{library_id}::{window_id}`
    /// -- see `window_watcher::native_label`). Resolve the serving tenant's
    /// prefix from the live window records here. Local library only: a remote/devserver window's
    /// transfers live on that server, so it's absent from these records and reads
    /// `false` -- correct, it's not ours to guard.
    pub fn window_has_active_transfer(&self, window_id: &str) -> bool {
        let records = self.local_window_records();
        match tenant_prefix_for_window(&records, window_id) {
            Some(prefix) => self.host.tenant_has_active_transfer(&prefix, window_id),
            None => false,
        }
    }

    /// Mount the registered workspace at `key` and answer its launch URL.
    ///
    /// Every attempt and the waits between them share the devserver mount's
    /// bound, counted from the call: a root that stops answering is refused at
    /// the bound in [`chan_server::mount_timed_out`]'s words, and an open
    /// waiting on it gives the root's lock back to a close or a removal when
    /// it is dropped there.
    pub async fn open_workspace(&self, key: &str) -> Result<String, String> {
        tokio::time::timeout(
            chan_server::WORKSPACE_MOUNT_TIMEOUT,
            self.open_workspace_attempts(key),
        )
        .await
        .unwrap_or_else(|_| Err(chan_server::mount_timed_out(Path::new(key))))
    }

    /// [`open_workspace`](Self::open_workspace)'s attempts, unbounded.
    async fn open_workspace_attempts(&self, key: &str) -> Result<String, String> {
        use chan_workspace::ChanError;
        // The host waits for in-process owners while publishing Starting.
        // Retry WorkspaceLocked here, which can also be the tail of a local
        // release. Repeating the host's AlreadyOpen budget would multiply
        // the wait and publish an error between attempts.
        // The idempotent host wrapper returns an existing mount for redundant
        // turn-on requests and serializes concurrent registrations.
        const MAX_ATTEMPTS: usize = 8;
        const BACKOFF: std::time::Duration = std::time::Duration::from_millis(150);
        let prefix = prefix_for_key(key);
        for attempt in 1..=MAX_ATTEMPTS {
            match self
                .host
                .open_or_get_registered_workspace(Path::new(key), serve_config(self.addr, &prefix))
                .await
            {
                Ok(hosted) => return Ok(hosted.handle.launch_url()),
                Err(e @ chan_server::Error::Core(ChanError::WorkspaceLocked)) => {
                    if attempt == MAX_ATTEMPTS {
                        return Err(map_open_error(key, e));
                    }
                    tokio::time::sleep(BACKOFF).await;
                }
                Err(other) => return Err(map_open_error(key, other)),
            }
        }
        unreachable!("retry loop returns on the final attempt")
    }

    /// Shared workspace registry handle owned by the embedded host.
    /// Every desktop registry mutation and feature toggle routes
    /// through this single `Library` so the in-memory registry the
    /// host opens workspaces against never goes stale relative to disk.
    pub fn library(&self) -> &chan_workspace::Library {
        self.host.library()
    }

    /// True iff a workspace with this root is mounted right now (under any
    /// prefix), resolving `root` first, so a test can ask by the path it made.
    #[cfg(test)]
    pub fn is_root_mounted(&self, root: &std::path::Path) -> bool {
        self.host.is_root_mounted(root)
    }

    /// True iff a workspace tenant goes by `key`, its canonical root or the
    /// registry row's root it was opened at, under any prefix. Answered from
    /// the keys the host stores, touching no filesystem, so the
    /// workspace-overlay snapshot can ask it of every registered row without
    /// waiting on a root that has stopped answering.
    pub fn is_workspace_mounted_by_key(&self, key: &std::path::Path) -> bool {
        self.host.is_workspace_mounted_by_key(key)
    }

    /// The root the workspace runtime `key` names was opened at, by its
    /// canonical root or by that root, which is the root its registry row
    /// stores; `None` when no workspace runtime goes by `key`. Answered from
    /// the keys the host stores, touching no filesystem.
    pub fn mounted_root(&self, key: &Path) -> Option<std::path::PathBuf> {
        self.host.mounted_root(key)
    }

    /// The canonical root the workspace runtime `key` names was mounted at,
    /// found as [`mounted_root`](Self::mounted_root) finds it; `None` when no
    /// workspace runtime goes by `key`. Answered from the keys the host
    /// stores, touching no filesystem.
    pub fn mounted_canonical_root(&self, key: &Path) -> Option<std::path::PathBuf> {
        self.host.mounted_canonical_root(key)
    }

    pub async fn close_workspace_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, String> {
        self.host
            .close_workspace_for_root(root, force)
            .await
            .map_err(|e| format!("closing embedded workspace {}: {e}", root.display()))
    }

    pub async fn remove_workspace_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, String> {
        self.host
            .remove_workspace_for_root(root, force)
            .await
            .map_err(|e| match e {
                chan_server::Error::Core(chan_workspace::ChanError::WorkspaceAlreadyOpen) => {
                    format!(
                        "removing {}: {}",
                        root.display(),
                        chan_server::WORKSPACE_STILL_RELEASING
                    )
                }
                other => format!("removing embedded workspace {}: {other}", root.display()),
            })
    }

    /// Drain every hosted workspace, shared-terminal, and control-terminal
    /// tenant concurrently while preserving the persisted workspace overlay.
    pub async fn shutdown_all(&self) -> Result<(), String> {
        let hosted = self
            .host
            .shutdown_all()
            .await
            .map_err(|e| format!("shutting down embedded tenants: {e}"));
        self.extension_runtime.shutdown().await;
        hosted
    }

    /// Return the tokened launch URL of the single shared `/terminal` tenant
    /// (`http://<addr>/terminal/index.html?t=<token>`), mounting it on first
    /// use. ALL standalone terminal windows load this one URL (each with its
    /// own `?w=<label>` appended by the caller), so their PTYs share a single
    /// registry: cross-window terminal moves work and a global Terminal-N
    /// sequence is possible. The tenant lives for the process lifetime; there
    /// is no per-window teardown (orphaned PTYs idle-prune). The async lock is
    /// held across the mount so two simultaneous first-opens can't both try to
    /// mount `/terminal`.
    pub async fn open_terminal(&self) -> Result<String, String> {
        self.open_terminal_in(chan_workspace::paths::config_dir())
            .await
    }

    /// [`open_terminal`](Self::open_terminal) with the tenant's on-disk
    /// state, the per-window layouts and the draft store, under `chan_home`.
    pub(crate) async fn open_terminal_in(
        &self,
        chan_home: std::path::PathBuf,
    ) -> Result<String, String> {
        const PREFIX: &str = "/terminal";
        let mut cached = self.terminal_url.lock().await;
        if let Some(url) = cached.as_ref() {
            return Ok(url.clone());
        }
        // Persist each standalone-terminal window's pane layout on disk (keyed
        // by `?w=<window_id>`) so it restores across a desktop relaunch -- with
        // fresh shells, since the PTYs don't survive. Best-effort: if the dir
        // can't be made the tenant falls back to its in-memory layout store.
        let session_dir = local_terminal_session_dir(&chan_home).await;
        let hosted = self
            .host
            .open_terminal_session(
                serve_config(self.addr, PREFIX),
                session_dir,
                // The desktop host's per-library draft store roots at the
                // chan home itself (`~/.chan/Drafts`); a same-machine
                // devserver keeps a disjoint store under its own
                // `~/.chan/devserver/` state dir.
                Some(chan_home),
            )
            .await
            .map_err(|e| format!("opening the shared embedded terminal tenant: {e}"))?;
        let url = hosted.handle.launch_url();
        *cached = Some(url.clone());
        Ok(url)
    }

    /// Mount a fresh terminal tenant whose PTY runs `command` (a single
    /// shell command line, through the login shell so an interactive
    /// script gets a real PTY) and return its tokened launch URL. Each
    /// call mounts its own tenant under a unique prefix, so a control
    /// terminal running one devserver's connect script stays separate
    /// from the shared standalone-terminal tenant and from other control
    /// terminals.
    pub async fn open_terminal_with_command(
        &self,
        command: String,
    ) -> Result<(String, String), String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let prefix = format!("/control-{}", SEQ.fetch_add(1, Ordering::Relaxed));
        let hosted = self
            .host
            .open_terminal_session_with_command(
                serve_config(self.addr, &prefix),
                Some(command),
                None,
            )
            .await
            .map_err(|e| format!("opening a command terminal tenant: {e}"))?;
        Ok((hosted.handle.launch_url(), prefix))
    }

    /// Close an unregistered control tenant when its native window cannot open.
    pub async fn close_terminal_tenant(&self, prefix: &str) -> Result<bool, String> {
        self.host
            .close_terminal_tenant(prefix)
            .await
            .map_err(|e| format!("closing a command terminal tenant: {e}"))
    }

    /// Raw output (replay-ring scrollback) of the control-terminal tenant
    /// mounted at `prefix`, decoded lossily. Lets the connect flow scrape a
    /// token the connect script printed; empty when no such tenant exists.
    pub fn read_control_terminal_output(&self, prefix: &str) -> String {
        String::from_utf8_lossy(&self.host.terminal_tenant_scrollback(prefix)).into_owned()
    }

    /// Exit state of the control-terminal tenant's PTY (the connect script),
    /// or `None` while it is still running. The connect flow polls this beside
    /// the scrollback scrape: `Some(exit)` means the script exited (a failed
    /// connect) so the scrape can fail fast instead of waiting out its full
    /// budget. The status is the tenant's, independent of the control window,
    /// so it still reports after the window is closed.
    pub fn control_terminal_exit(&self, prefix: &str) -> Option<chan_server::TerminalExit> {
        self.host.terminal_tenant_last_exit(prefix)
    }

    /// Mint the connect-script control terminal as a real (`persisted:false`)
    /// chan-library registry row under the DEVSERVER's `library_id`.
    /// The row rides `/api/library/windows` with a real library_id so the launcher
    /// shows the devserver group on a zero-window connect, and is reaped by
    /// [`reap_control_window`](Self::reap_control_window) on the connect-script PTY
    /// exit. The native window is still opened imperatively by
    /// `serve::spawn_control_terminal_window`; this furnishes only the feed row.
    /// The row's `(prefix, token, connected)` are resolved at read time
    /// from the control tenant, so no token crosses here.
    pub fn mint_control_window(
        &self,
        window_id: String,
        devserver_library_id: String,
        control_tenant_prefix: String,
    ) -> Result<WindowRecord, String> {
        self.host
            .mint_control_window(window_id, devserver_library_id, control_tenant_prefix)
            .map_err(|e| format!("minting control window: {e}"))
    }

    /// Reap a control terminal's registry row AND its `/control-N` tenant (kills
    /// the connect-script PTY), firing the feed change so the launcher drops the
    /// row. Returns whether a row existed. Called on the control PTY exit (the
    /// desktop-triggered reap) and on disconnect/forget; idempotent. The host's
    /// `reap_control_window` removes the registry row and unmounts the tenant
    /// directly (it does NOT route through the host's prefix-close prune-task
    /// drop race).
    pub async fn reap_control_window(&self, window_id: &str) -> bool {
        self.host.reap_control_window(window_id).await
    }

    /// Set the server-persisted visibility of a window in the LOCAL embedded
    /// registry: a LOCAL window (`local::<window_id>`) or the control
    /// terminal row (whose `window_id` is its `control_terminal_label`). Persists
    /// to `~/.chan/windows.json` (control rows in-memory) and fires the feed change
    /// so `should_show` + the launcher mirror it. Returns whether a row matched.
    /// DEVSERVER windows persist on their OWN devserver (see
    /// `devserver::set_window_visibility`), not here.
    pub fn set_window_hidden(&self, window_id: &str, hidden: bool) -> Result<bool, String> {
        self.host
            .set_window_hidden(window_id, hidden)
            .map_err(|e| format!("setting window visibility: {e}"))
    }

    /// The loopback address the embedded server listens on. The window
    /// watcher assembles a window's tenant URL (`http://{addr}{prefix}…`)
    /// from this plus the record's prefix/token.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The library's authoritative window set, each persisted
    /// registry row joined with its serving tenant's live `prefix`/`token`/
    /// `connected`. This MERGES connected devservers' windows for
    /// the launcher, so it is the right source only for surfaces that want the
    /// full set (the launcher feed and the Window menu). Empty until a window is
    /// minted.
    pub fn assemble_window_records(&self) -> Vec<WindowRecord> {
        self.host.assemble_window_records()
    }

    /// The LOCAL library's window records only -- the merged set
    /// ([`assemble_window_records`](Self::assemble_window_records)) minus
    /// connected devservers' rows. THE source for consumers that reason about
    /// local windows (the local native watcher, the active-transfer close guard,
    /// the first-window mint check): a remote row with a colliding `window_id` or
    /// `workspace_path` would otherwise false-match and drive a wrong
    /// open/close/mint. Filters to this host's library id.
    pub fn local_window_records(&self) -> Vec<WindowRecord> {
        let local = self.host.library_id();
        self.host
            .assemble_window_records()
            .into_iter()
            .filter(|r| r.library_id == local)
            .collect()
    }

    /// The aggregate window-set change signal (registry mint/discard +
    /// tenant on/off + presence) the watcher's feed awaits. NOT the raw
    /// registry change signal -- that misses tenant transitions.
    pub fn library_change_notify(&self) -> Arc<Notify> {
        self.host.library_change_notify()
    }

    /// Install the launcher's connected-devserver feed source so
    /// `assemble_window_records` + the list-workspaces route merge connected
    /// devservers' windows + workspaces into the local launcher surface.
    pub fn install_devserver_feed(&self, feed: Arc<dyn chan_server::DevserverFeedSource>) {
        self.host.install_devserver_feed(feed);
    }

    /// Fire the library-change signal so the launcher's window + workspace watch
    /// feeds re-push -- the desktop calls this when its devserver feed (window
    /// snapshot or workspace cache) changes.
    pub fn signal_library_change(&self) {
        self.host.signal_library_change();
    }

    /// Reload the local workspace registry snapshot from `~/.chan/config.toml`.
    ///
    /// The embedded server holds a long-lived [`chan_workspace::Library`]. When
    /// another process updates the shared registry, the desktop watcher calls this
    /// before waking launcher clients so `/api/library/workspaces` serves the fresh
    /// rows.
    pub fn reload_library_registry(&self) -> chan_workspace::Result<()> {
        self.host.library().reload_registry()
    }

    /// The pane-highlight colour for a window of `library_id`: the host
    /// resolves the two sources behind one call -- local (the installed
    /// [`LocalColorStore`](chan_server::LocalColorStore)) vs a devserver
    /// (`DevserverEntry.color` matched by `library_id` in the devserver registry).
    /// `None` -> the editor falls back to the default accent. Injected as `?pane=`
    /// at mint time.
    pub fn pane_color(&self, library_id: &str) -> Option<String> {
        self.host.pane_color(library_id)
    }

    /// Whether this window was minted by a routed `cs open` and is still
    /// waiting for the frame parked for it. The watcher appends `seed=0` for
    /// such a window so the SPA does not seed a default terminal beside the
    /// tab it is about to be handed.
    pub fn is_routed_mint(&self, window_id: &str) -> bool {
        self.host.is_routed_mint(window_id)
    }

    /// The launcher's light/dark choice from the local theme store, or `None`
    /// to follow the OS. Reads the same store the launcher's `local-theme`
    /// route writes; used to theme the desktop's own notice windows.
    pub fn local_theme(&self) -> Option<String> {
        self.host.local_theme_store().and_then(|store| store.get())
    }

    /// Mint a window into the local library registry and return its assembled
    /// record. The minted record fires the aggregate change signal, so the
    /// window watcher's feed surfaces it and opens its native window -- the
    /// registry is the sole window-creation authority (a minted window can
    /// never be double-opened). A workspace record gets its live prefix and
    /// token when a matching tenant is mounted; minting does not require one.
    pub fn mint_window(
        &self,
        kind: chan_server::WindowKind,
        workspace_path: Option<String>,
    ) -> Result<WindowRecord, String> {
        self.host
            .mint_window(kind, workspace_path)
            .map_err(|e| format!("minting a window: {e}"))
    }

    /// Mint a native window of the workspace whose runtime `key` names, by
    /// its canonical root or by the root it was opened at. The record stores
    /// the root the runtime was opened at, the registry row's, which is the
    /// path the launcher lists the workspace by and nests its windows under,
    /// whichever of the two keys the caller holds. The host answers from the
    /// keys it stores, so no root's filesystem is asked.
    pub fn mint_workspace_window(&self, key: &Path) -> Result<WindowRecord, String> {
        self.mint_workspace_window_with_origin(key, chan_server::WindowOrigin::Native)
    }

    /// [`mint_workspace_window`](Self::mint_workspace_window) with the client
    /// `origin` to stamp. A browser origin marks a record that exists purely
    /// for a browser tab holding its own `window_id`: the watcher never opens
    /// a native twin for it (it skips non-native origins). Backs the Window
    /// menu's New Window and "Open in Browser".
    pub fn mint_workspace_window_with_origin(
        &self,
        key: &Path,
        origin: chan_server::WindowOrigin,
    ) -> Result<WindowRecord, String> {
        self.host
            .mint_workspace_window(key, origin)
            .map_err(|e| format!("minting a window: {e}"))
    }

    /// The library's first-open rule: mint exactly one boot terminal the first
    /// time this library is opened with an empty window registry, then persist a
    /// marker so it never re-mints. Returns the minted record, or `None` when
    /// nothing was minted (the registry already has windows, or the marker is set
    /// -- the user closed the only terminal, so reopening comes up with none). The
    /// minted record fires the aggregate change signal, so the watcher opens its
    /// native window. The boot path calls this instead of an unconditional mint.
    pub fn ensure_first_open_terminal(&self) -> Result<Option<WindowRecord>, String> {
        self.host
            .ensure_first_open_terminal()
            .map_err(|e| format!("ensuring the first-open terminal: {e}"))
    }

    /// The local library's persisted workspace on/off overlay (installed at
    /// start). The boot path reads its `on_paths()` to re-serve; the toggle
    /// commands write it on each on/off so a restart comes back as the user left
    /// it.
    pub fn workspace_overlay(&self) -> Option<&Arc<chan_server::WorkspaceOverlay>> {
        self.host.workspace_overlay()
    }

    /// Discard a window: remove its registry row and reap its terminal
    /// sessions, then fire the aggregate change signal so the watcher reconciles
    /// the native window closed (`^W`/`^D`/empty-pane). The
    /// record is gone, so the watcher never reopens it. Returns whether a row
    /// existed.
    pub fn discard_window(&self, window_id: &str) -> Result<bool, String> {
        self.host
            .discard_window(window_id)
            .map_err(|e| format!("discarding window {window_id}: {e}"))
    }
}

impl Drop for EmbeddedServer {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
    }
}

/// Map an embedded open error to a user-facing string. A workspace
/// already held by another chan process (typically a standalone
/// `chan serve <workspace>` started before the desktop tried to mount
/// it) surfaces as `WorkspaceLocked` and reads as an instruction to quit
/// that process. An in-process handle that hasn't dropped yet surfaces as
/// `WorkspaceAlreadyOpen` and reads as the words the root's row reads.
/// Both reach the user verbatim in the notice of the `chan serve` handoff
/// or of the restore at boot, so they must read as clear, non-fatal
/// sentences rather than a raw error chain.
fn map_open_error(key: &str, e: chan_server::Error) -> String {
    use chan_workspace::ChanError;
    match e {
        chan_server::Error::Core(ChanError::WorkspaceLocked) => {
            "This workspace is open in another chan process. Quit it and try again.".to_string()
        }
        chan_server::Error::Core(ChanError::WorkspaceAlreadyOpen) => {
            chan_server::WORKSPACE_STILL_RELEASING.to_string()
        }
        other => format!("opening embedded workspace {key}: {other}"),
    }
}

/// On-disk dir for the standalone `/terminal` tenant's per-window layout blobs
/// (`terminal-sessions` under `chan_home`, created on first use). The desktop
/// passes `chan_workspace::paths::config_dir` (the single config-dir authority)
/// so a `CHAN_HOME` override isolates a smoke instance and an unset override
/// resolves to `~/.chan/terminal-sessions`. `None` only if the dir can't be
/// created -- the tenant then keeps layout in-memory (it just won't persist
/// across relaunch).
async fn local_terminal_session_dir(chan_home: &Path) -> Option<std::path::PathBuf> {
    let dir = chan_home.join("terminal-sessions");
    // `tokio::fs` keeps the dir-create off the runtime thread:
    // `open_terminal` is async, so a blocking `std::fs::create_dir_all` would
    // stall the event loop.
    tokio::fs::create_dir_all(&dir).await.ok()?;
    Some(dir)
}

fn serve_config(addr: SocketAddr, prefix: &str) -> chan_server::ServeConfig {
    chan_server::ServeConfig {
        addr,
        no_token: false,
        prefix: prefix.to_string(),
        idle_timeout: None,
        open_browser: false,
        search_aggression: None,
        settings_disabled: false,
        // The embedded desktop server has no controlling terminal for the
        // serve-progress stream, so it stays quiet like open_browser.
        verbose: false,
    }
}

fn prefix_for_key(key: &str) -> String {
    format!("/{}", serve::workspace_window_prefix(key))
}

/// The serving tenant prefix for the window whose `?w=` id is `window_id`, found
/// in a window-record snapshot. The active-transfer guard resolves a closing
/// window's tenant this way because the close handler doesn't carry it. `None`
/// when no record matches (a remote/other-library window, or already gone).
fn tenant_prefix_for_window(records: &[WindowRecord], window_id: &str) -> Option<String> {
    records
        .iter()
        .find(|r| r.window_id == window_id)
        .map(|r| r.prefix.clone())
}

async fn serve_router(
    listener: tokio::net::TcpListener,
    app: Router,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), std::io::Error> {
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))
}

/// Run the test whose full path in the test binary is `test` in a child
/// process of that binary whose `CHAN_HOME` is a fresh temporary directory,
/// and answer whether this process is that child. The chan home's stores,
/// the local window registry among them, are found through `CHAN_HOME`
/// alone, so a test that installs one in this process would share it with
/// every other test, and with the user's own home when none is set; a child
/// gives each such test a private home without racing other tests' reads of
/// the environment. The parent answers `false` once the child has run exactly
/// that one test and it passed.
#[cfg(test)]
pub(crate) fn in_own_chan_home(test: &str) -> bool {
    const CHILD: &str = "CHAN_TEST_OWN_HOME";
    if std::env::var(CHILD).as_deref() == Ok(test) {
        return true;
    }
    let home = tempfile::tempdir().expect("chan home");
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", test, "--nocapture"])
        .env(CHILD, test)
        .env("CHAN_HOME", home.path())
        .output()
        .expect("run the test in its own chan home");
    let stdout = String::from_utf8_lossy(&output.stdout);
    print!("{stdout}");
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(
        output.status.success(),
        "{test} failed in its own chan home"
    );
    assert!(
        stdout.contains("test result: ok. 1 passed; 0 failed;"),
        "the child did not run exactly {test}"
    );
    false
}

/// A clock a test holds, for the pins of a bound on a root that stops
/// answering under `chan_workspace::paths::root_stall`. A paused clock moves
/// only when the test advances it: a blocking task holds tokio's auto-advance
/// off while it is outstanding, and a call held on the root keeps one
/// outstanding. So a bound expires when the test says and at no other time,
/// and the one real-clock bound, the hang guard, only decides how soon a
/// scenario that never ends is reported.
#[cfg(all(test, unix))]
pub(crate) mod paused_clock {
    use std::future::Future;
    use std::sync::mpsc::RecvTimeoutError;
    use std::sync::Arc;
    use std::time::Duration;

    use chan_workspace::paths::root_stall::RootStall;

    /// Far above what a scenario that needs only a healthy root costs on a
    /// loaded host; it decides only how soon a hang is reported.
    pub(crate) const HANG_GUARD: Duration = Duration::from_secs(30);

    /// Run `scenario` on a current-thread runtime whose clock starts paused,
    /// on a thread of its own, and panic naming `what` and the calls `stall`
    /// holds when it has not ended within [`HANG_GUARD`] of real time. The
    /// stall goes before the thread is joined: dropping the scenario's
    /// runtime waits for its blocking tasks, and a held call is one.
    pub(crate) fn on_a_paused_clock(
        stall: Arc<RootStall>,
        what: &str,
        scenario: impl Future<Output = ()> + Send + 'static,
    ) {
        let (done, finished) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .start_paused(true)
                .build()
                .expect("paused runtime");
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                runtime.block_on(scenario)
            }));
            let _ = done.send(outcome);
        });
        match finished.recv_timeout(HANG_GUARD) {
            Ok(outcome) => {
                drop(stall);
                worker.join().expect("scenario thread");
                if let Err(panic) = outcome {
                    std::panic::resume_unwind(panic);
                }
            }
            Err(RecvTimeoutError::Disconnected) => panic!("{what} ended without an outcome"),
            Err(RecvTimeoutError::Timeout) => panic!(
                "{what} did not finish; calls held on the root: {:#?}",
                stall.entered()
            ),
        }
    }

    /// Wait until a call on the root is held, from a blocking thread, so the
    /// runtime's one thread keeps serving the task that makes it.
    pub(crate) async fn held(stall: &Arc<RootStall>, what: &str) {
        let waiting = Arc::clone(stall);
        let entered =
            tokio::task::spawn_blocking(move || waiting.wait_entered(Duration::from_secs(10)))
                .await
                .expect("wait task");
        assert!(entered, "fixture: {what} never reached its root");
    }

    /// Give the runtime room to fire a timer that is due and to run whatever
    /// it wakes.
    pub(crate) async fn settle() {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod home_workspace {
        use super::*;

        fn isolated(test: &str) -> bool {
            in_own_chan_home(&format!("embedded::tests::home_workspace::{test}"))
        }

        async fn with_terminal() -> (EmbeddedServer, std::path::PathBuf, String) {
            let config = chan_workspace::paths::config_dir();
            let library = chan_workspace::Library::open_at(config.join("config.toml")).unwrap();
            let embedded = EmbeddedServer::for_tests(library).await;
            embedded.install_local_window_registry_for_tests();
            embedded.install_workspace_overlay_for_tests(config.join("workspaces.json"));
            embedded.open_terminal_in(config).await.unwrap();
            let row = embedded
                .library()
                .register_workspace(&dirs::home_dir().unwrap())
                .unwrap();
            let terminal = embedded
                .mint_window(chan_server::WindowKind::Terminal, None)
                .unwrap();
            assert_eq!(terminal.prefix, "/terminal");
            assert!(!terminal.token.is_empty());
            (embedded, row.root_path, terminal.window_id)
        }

        fn assert_terminal_resolves(embedded: &EmbeddedServer, window_id: &str) {
            assert_eq!(
                embedded.host.mounted_prefixes().unwrap(),
                ["/terminal"],
                "the home operation closed the shared terminal tenant"
            );
            let records = embedded.assemble_window_records();
            let terminal = records
                .iter()
                .find(|record| record.window_id == window_id)
                .unwrap();
            assert_eq!(terminal.prefix, "/terminal");
            assert!(
                !terminal.token.is_empty(),
                "the terminal window lost its tenant token"
            );
        }

        #[tokio::test]
        async fn an_unmounted_home_reads_stopped_and_off() {
            if !isolated("an_unmounted_home_reads_stopped_and_off") {
                return;
            }
            let (embedded, root, window_id) = with_terminal().await;
            let key = root.to_string_lossy().into_owned();
            let overlay = embedded.workspace_overlay().unwrap();
            overlay.set(&key, true);
            assert_eq!(overlay.on_paths(), [key]);
            assert_eq!(
                embedded.host.workspace_status(&root),
                (chan_server::WorkspaceStatus::Stopped, None),
                "the terminal tenant made the home row running"
            );
            let state = crate::AppState::with_store(Arc::new(Mutex::new(ConfigStore::at_path(
                chan_workspace::paths::config_dir().join("desktop.json"),
            ))));
            assert!(state.embedded.set(embedded).is_ok());
            let embedded = state.embedded().unwrap();
            crate::snapshot_workspaces(&state);
            assert!(
                embedded.workspace_overlay().unwrap().on_paths().is_empty(),
                "the terminal tenant kept the home row on in the snapshot"
            );
            assert_terminal_resolves(embedded, &window_id);
            embedded.shutdown_all().await.unwrap();
        }

        #[tokio::test]
        async fn closing_an_unmounted_home_keeps_terminal_windows() {
            if !isolated("closing_an_unmounted_home_keeps_terminal_windows") {
                return;
            }
            let (embedded, root, window_id) = with_terminal().await;
            let outcome = embedded.close_workspace_root(&root, false).await.unwrap();
            assert!(
                outcome.not_found(),
                "an unmounted home close found the terminal tenant: {outcome:?}"
            );
            assert_terminal_resolves(&embedded, &window_id);
            assert_eq!(embedded.library().list_workspaces().len(), 1);
            embedded.shutdown_all().await.unwrap();
        }

        #[tokio::test]
        async fn forgetting_an_unmounted_home_keeps_terminal_windows() {
            if !isolated("forgetting_an_unmounted_home_keeps_terminal_windows") {
                return;
            }
            let (embedded, root, window_id) = with_terminal().await;
            assert!(embedded
                .remove_workspace_root(&root, false)
                .await
                .unwrap()
                .completed());
            assert_terminal_resolves(&embedded, &window_id);
            assert!(embedded.library().list_workspaces().is_empty());
            embedded.shutdown_all().await.unwrap();
        }
    }

    /// One probe period, written out rather than read from the cadence
    /// constant. A bound that takes its limit from the thing under test moves
    /// with it, so a slower cadence would pass; this one has to fail.
    #[cfg(unix)]
    const ONE_PROBE_PERIOD: std::time::Duration = std::time::Duration::from_secs(15);

    /// Wait for the probe's next root health transition and return how much
    /// virtual time it took to arrive.
    ///
    /// Completion is observed, not inferred: the wait is on the host's own
    /// change notification, which `reconcile_root_health` fires when it
    /// publishes or clears a degraded row. Nothing advances the clock by hand.
    /// It is paused, so tokio moves it to the next pending timer, which is the
    /// probe's own tick, and the elapsed time returned is when that tick
    /// actually published.
    ///
    /// The timeout is a safety guard only, and it is deliberately ten periods
    /// long. It has to outlast any late probe a regression could introduce, so
    /// that such a probe still arrives and is rejected by the caller's elapsed
    /// bound, where the failure names how late it was, rather than being cut
    /// off here, where it could only report that nothing arrived.
    #[cfg(unix)]
    async fn next_transition(embedded: &EmbeddedServer) -> std::time::Duration {
        let notify = embedded.host.library_change_notify();
        let changed = notify.notified();
        let start = tokio::time::Instant::now();
        tokio::time::timeout(ONE_PROBE_PERIOD * 10, changed)
            .await
            .expect("the probe published no root health transition at all");
        start.elapsed()
    }

    /// The desktop's own library reports a replaced root as `unavailable`
    /// without an add or an on, and clears it when the original directory is
    /// back. Nothing here calls the probe: the embedded server drives it.
    ///
    /// Unix-only for the two reasons the library's own probe tests record.
    /// Windows refuses to delete a tree while the tenant holds handles inside
    /// it, so the scenario cannot be built, and `RootedFs::revalidate`'s
    /// non-unix arm has no inode check, so a directory swapped in at the same
    /// path is not a condition it can report.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn the_embedded_host_reports_a_replaced_root_without_an_operator_verb() {
        let cfg = tempfile::tempdir().expect("config dir");
        let parent = tempfile::tempdir().expect("workspace parent");
        let root = parent.path().join("workspace");
        std::fs::create_dir(&root).expect("workspace");
        let library =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        library.register_workspace(&root).expect("register");
        let embedded = EmbeddedServer::for_tests(library).await;
        embedded
            .open_workspace(root.to_str().expect("utf-8 root"))
            .await
            .expect("mount");
        assert_eq!(
            embedded.host.workspace_status(&root).0,
            chan_server::WorkspaceStatus::Running,
            "the fixture did not publish a running tenant"
        );

        // Move the original aside rather than deleting it: `revalidate` adopts
        // a root only when its inode matches the handle's, so a freshly created
        // directory at this path can never clear the degraded row, and only the
        // original coming back can.
        let aside = parent.path().join("workspace-aside");
        std::fs::rename(&root, &aside).expect("move the original root aside");
        std::fs::create_dir(&root).expect("a different directory takes the path");

        let elapsed = next_transition(&embedded).await;
        assert!(
            elapsed <= ONE_PROBE_PERIOD,
            "the replaced root was reported after {elapsed:?}, later than one probe period"
        );
        let (status, reason) = embedded.host.workspace_status(&root);
        assert_eq!(status, chan_server::WorkspaceStatus::Unavailable);
        // A status alone pins nothing: more than one writer can publish this
        // row, so the assertion names the reason the probe writes.
        let reason = reason.expect("a degraded row carries a reason");
        // The reason names the registry's canonical root, and the impostor now
        // at this path canonicalizes to that same spelling (on macOS `/var` is
        // a symlink to `/private/var`, so the raw temp path would not).
        let registered = chan_workspace::paths::canonicalize_normalized(&root);
        assert!(
            reason.contains(&registered.display().to_string()),
            "the reason must name the root as the registry spells it ({}): {reason}",
            registered.display()
        );

        std::fs::remove_dir(&root).expect("remove the impostor");
        std::fs::rename(&aside, &root).expect("put the original root back");
        let elapsed = next_transition(&embedded).await;
        assert!(
            elapsed <= ONE_PROBE_PERIOD,
            "the restored root was reported after {elapsed:?}, later than one probe period"
        );
        assert_eq!(
            embedded.host.workspace_status(&root).0,
            chan_server::WorkspaceStatus::Running,
            "the original directory is back and the row is still degraded"
        );
        assert!(
            embedded.host.is_root_mounted(&root),
            "the probe unmounted the tenant"
        );
    }

    #[test]
    fn prefix_for_key_uses_workspace_window_prefix() {
        let key = "/tmp/chan notes";
        let prefix = prefix_for_key(key);
        assert!(prefix.starts_with("/workspace-"));
        assert_eq!(prefix, format!("/{}", serve::workspace_window_prefix(key)));
    }

    fn rec(window_id: &str, prefix: &str) -> WindowRecord {
        WindowRecord {
            window_id: window_id.into(),
            library_id: "local".into(),
            kind: chan_server::WindowKind::Workspace,
            title: String::new(),
            ordinal: 1,
            label: String::new(),
            workspace_path: Some("/tmp/notes".into()),
            prefix: prefix.into(),
            token: "tok".into(),
            persisted: true,
            connected: true,
            holders: None,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }
    }

    #[test]
    fn tenant_prefix_for_window_resolves_by_session_id_not_label() {
        // The active-transfer guard keys on the `?w=` window id, which diverges
        // from the native `local::w-2` label -- resolution is by window_id.
        let records = vec![rec("w-1", "/workspace-aaa"), rec("w-2", "/workspace-bbb")];
        assert_eq!(
            tenant_prefix_for_window(&records, "w-2").as_deref(),
            Some("/workspace-bbb")
        );
        // A native label (not a bare window id) must NOT match.
        assert_eq!(tenant_prefix_for_window(&records, "local::w-2"), None);
        // An unknown / already-gone window resolves to no tenant.
        assert_eq!(tenant_prefix_for_window(&records, "missing"), None);
    }

    /// A lock another chan process holds keeps its own sentence, apart from a
    /// root this process is still releasing.
    #[test]
    fn a_lock_another_process_holds_keeps_its_own_sentence() {
        assert_eq!(
            map_open_error(
                "/w",
                chan_server::Error::Core(chan_workspace::ChanError::WorkspaceLocked)
            ),
            "This workspace is open in another chan process. Quit it and try again."
        );
    }

    /// The embedded open shares the devserver mount's bound over all its
    /// attempts. The bound's pin runs on [`paused_clock`]'s clock, so the
    /// bound expires when the test says and at no other time.
    #[cfg(unix)]
    mod open_bound {
        use std::time::Duration;

        use chan_workspace::paths::root_stall;

        use super::*;
        use crate::embedded::paused_clock::{held, on_a_paused_clock, settle, HANG_GUARD};

        /// The bound, written out so that moving it is a deliberate edit here.
        const MOUNT_BOUND: Duration = Duration::from_secs(60);
        const JUST_SHORT: Duration = Duration::from_millis(1);
        const STILL_RELEASING: &str = "workspace is still releasing; retry";

        /// A registered root and a desktop over its library: the root as the
        /// registry stores it, the key the desktop opens it by, and the dirs.
        fn registered_root() -> (
            chan_workspace::Library,
            std::path::PathBuf,
            String,
            [tempfile::TempDir; 2],
        ) {
            let cfg = tempfile::tempdir().expect("config dir");
            let root = tempfile::tempdir().expect("root");
            let library =
                chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
            let stored = library
                .register_workspace(root.path())
                .expect("register")
                .root_path;
            let key = stored.to_str().expect("utf-8 root").to_string();
            (library, stored, key, [cfg, root])
        }

        /// An open whose root answers its key and then hangs in its open is
        /// refused at the bound with the root's name, and gives the root's
        /// lock back: a close and a removal of that root answer after it.
        #[test]
        fn an_open_whose_root_hangs_answers_at_the_mount_bound() {
            let (library, stored, key, _dirs) = registered_root();
            let stall = Arc::new(root_stall::stall_matching(
                &stored,
                &[root_stall::OPEN_WORKSPACE],
            ));
            let open = Arc::clone(&stall);
            on_a_paused_clock(stall, "an open whose root hangs", async move {
                let embedded = Arc::new(EmbeddedServer::for_tests(library).await);
                let opening = Arc::clone(&embedded);
                let opened_key = key.clone();
                let opened = tokio::spawn(async move { opening.open_workspace(&opened_key).await });
                held(&open, "the open").await;
                tokio::time::advance(MOUNT_BOUND - JUST_SHORT).await;
                settle().await;
                assert!(
                    !opened.is_finished(),
                    "the open answered before the mount bound"
                );
                tokio::time::advance(JUST_SHORT).await;
                let refused = opened
                    .await
                    .expect("open task")
                    .expect_err("the open of a root that hangs mounted it");
                assert_eq!(
                    refused,
                    format!("mount timed out after 60 seconds: {key} did not answer")
                );
                assert_eq!(
                    embedded.host.workspace_status(&stored).1.as_deref(),
                    Some(STILL_RELEASING),
                    "the row after the bound"
                );
                assert_eq!(
                    embedded.close_workspace_root(&stored, false).await,
                    Ok(WorkspaceLifecycleOutcome::NotFound)
                );
                assert_eq!(
                    embedded.remove_workspace_root(&stored, false).await,
                    Ok(WorkspaceLifecycleOutcome::Completed)
                );
            });
        }

        /// An open beside an earlier open whose caller left, and which still
        /// holds the root, answers the words the root's row reads.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn an_open_beside_an_abandoned_open_answers_the_rows_words() {
            let (library, stored, key, _dirs) = registered_root();
            let embedded = Arc::new(EmbeddedServer::for_tests(library).await);
            let stall = root_stall::stall_matching(&stored, &[root_stall::OPEN_WORKSPACE]);
            let first = {
                let embedded = Arc::clone(&embedded);
                let key = key.clone();
                tokio::spawn(async move { embedded.open_workspace(&key).await })
            };
            assert!(
                stall.wait_entered(Duration::from_secs(10)),
                "fixture: the first open never reached its root"
            );
            first.abort();
            assert!(
                first.await.unwrap_err().is_cancelled(),
                "fixture: the first open answered"
            );
            let refused = tokio::time::timeout(HANG_GUARD, embedded.open_workspace(&key))
                .await
                .expect("an open beside an abandoned open did not answer")
                .expect_err("an open beside an abandoned open mounted the root");
            assert_eq!(refused, STILL_RELEASING);
            assert_eq!(
                embedded.host.workspace_status(&stored).1.as_deref(),
                Some(refused.as_str()),
                "the answer is not the row's words"
            );
        }

        #[tokio::test]
        async fn a_removal_of_a_workspace_still_open_here_answers_releasing() {
            let (library, stored, _key, _dirs) = registered_root();
            let held = library.open_workspace(&stored).expect("hold the workspace");
            let embedded = EmbeddedServer::for_tests(library).await;
            let answer = embedded
                .remove_workspace_root(&stored, false)
                .await
                .expect_err("a held workspace was removed");
            assert!(answer.ends_with(STILL_RELEASING), "{answer}");
            drop(held);
        }
    }
}
