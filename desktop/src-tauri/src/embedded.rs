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
        // Install the local library's window registry so the window feed has
        // data (~/.chan/windows.json, library id "local").
        chan_server::install_local_window_registry(&host);
        // Install the local library's workspace on/off overlay
        // (~/.chan/workspaces.json), so the boot path re-serves what was on and
        // toggles persist their on/off -- the same store the devserver uses.
        chan_server::install_local_workspace_overlay(&host);
        // Install the launcher's devserver registry over the desktop config so
        // the `/api/library/devservers` CRUD persists to the SAME config the
        // desktop reads (the shared store handle) -- mirror of the workspace
        // overlay above. The headless devserver / plain `chan open` install
        // none (empty list, 404 mutation).
        host.install_devserver_registry(Arc::new(DevserverConfigRegistry::new(
            Arc::clone(&config_store),
            devserver_remove_hook,
            devserver_conns,
            devserver_connecting,
            devserver_feed,
            Arc::clone(&gateway_manager),
        )));
        // Install the launcher's gateway registry over the SAME shared config,
        // so the `/api/library/gateways` CRUD persists beside the devserver
        // rows. Headless surfaces install none (empty list, 404 mutation).
        host.install_gateway_registry(Arc::new(GatewayConfigRegistry::new(
            Arc::clone(&config_store),
            gateway_remove_hook,
            gateway_manager,
        )));
        // Install the local-library pane-highlight colour store over the
        // SAME shared desktop config the devserver registry uses, so the host reads
        // the local colour when minting local windows and the launcher's
        // local-colour route writes it.
        host.install_local_color_store(Arc::new(crate::config::LocalColorConfig::new(Arc::clone(
            &config_store,
        ))));
        // Install the launcher-theme store over the SAME shared config, so a
        // local standalone terminal window reads + watches the launcher's
        // light/dark choice and the launcher's local-theme route writes it.
        host.install_local_theme_store(Arc::new(crate::config::LocalThemeConfig::new(Arc::clone(
            &config_store,
        ))));
        // Install the collapsed-machines store over the SAME shared config, so
        // the launcher reconciles its per-machine collapse against it on boot and
        // the collapse toggle writes it (surviving a desktop restart, which the
        // per-launch loopback origin makes localStorage alone unable to do).
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
        Ok(Self {
            host,
            extension_runtime,
            addr,
            shutdown_tx,
            terminal_url: tokio::sync::Mutex::new(None),
            pending_window_ops: tokio::sync::Mutex::new(Some(window_ops_rx)),
            launcher_token,
        })
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

    /// True when the workspace mounted for `key` still has at least one
    /// live PTY session bound to `window_label`. The `cs window rm`
    /// confirmation uses this (alongside the terminal-tenant variant) to
    /// decide whether to prompt before killing a window's shells.
    pub fn workspace_window_has_live_shells(&self, key: &str, window_label: &str) -> bool {
        self.host
            .tenant_has_window_sessions(&prefix_for_key(key), window_label)
    }

    /// True when the window whose `?w=` session id is `window_id` has ≥1
    /// in-flight file transfer (upload/download). The transfer-close guard
    /// (serve.rs `CloseRequested`) queries it to prompt before closing a window
    /// mid-transfer -- the mirror of `workspace_window_has_live_shells`.
    ///
    /// Keyed on the `?w=` window id (NOT the native window label: they diverge
    /// for watcher-opened windows, where the label is `{library_id}::{window_id}`
    /// -- serve.rs:750). The serving tenant's prefix isn't on the close handler
    /// (`config_key` is empty for watcher windows), so resolve it from the live
    /// window records here. Local library only: a remote/devserver window's
    /// transfers live on that server, so it's absent from these records and reads
    /// `false` -- correct, it's not ours to guard.
    pub fn window_has_active_transfer(&self, window_id: &str) -> bool {
        let records = self.local_window_records();
        match tenant_prefix_for_window(&records, window_id) {
            Some(prefix) => self.host.tenant_has_active_transfer(&prefix, window_id),
            None => false,
        }
    }

    pub async fn open_workspace(&self, key: &str) -> Result<String, String> {
        use chan_workspace::ChanError;
        // A workspace just turned OFF can keep its flock for a beat: a
        // background indexer / in-flight request still holding an
        // `Arc<Workspace>` releases it shortly after the runtime is dropped.
        // A quick OFF -> ON would otherwise spuriously hit
        // `WorkspaceAlreadyOpen` (our own releasing handle) or
        // `WorkspaceLocked`. Retry briefly so the toggle settles instead of
        // erroring; a genuine other-process lock still surfaces after the
        // short budget. Mirrors `unregister_with_retry` on the close side.
        //
        // Mount through the idempotent `open_or_get_registered_workspace`
        // wrapper (its `register_lock` + `hosted_for_root` precheck): a
        // redundant turn-on of an ALREADY-mounted root returns `Ok(existing)`
        // rather than `WorkspaceAlreadyOpen`, so a click that lands in the gap
        // before the launcher's `status:starting` disables the toggle settles
        // to success instead of the wrong "open in another chan process"
        // message. The retry loop still covers the OFF->ON releasing-handle
        // case (root unregistered, flock not yet dropped), which surfaces as
        // `WorkspaceAlreadyOpen` from the inner mount until the handle releases.
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
                Err(
                    e @ chan_server::Error::Core(
                        ChanError::WorkspaceLocked | ChanError::WorkspaceAlreadyOpen,
                    ),
                ) => {
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

    /// True iff a workspace with this canonical root is mounted right now (under
    /// any prefix). The launcher's `on` state and the workspace-overlay snapshot
    /// read this so they reflect the REAL mount, not a stale shadow.
    pub fn is_root_mounted(&self, root: &std::path::Path) -> bool {
        self.host.is_root_mounted(root)
    }

    pub async fn close_prefix(
        &self,
        prefix: &str,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, String> {
        self.host
            .close_workspace(prefix, force)
            .await
            .map_err(|e| format!("closing embedded route {prefix}: {e}"))
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
            .map_err(|e| format!("removing embedded workspace {}: {e}", root.display()))
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
        const PREFIX: &str = "/terminal";
        let mut cached = self.terminal_url.lock().await;
        if let Some(url) = cached.as_ref() {
            return Ok(url.clone());
        }
        // Persist each standalone-terminal window's pane layout on disk (keyed
        // by `?w=<window_id>`) so it restores across a desktop relaunch -- with
        // fresh shells, since the PTYs don't survive. Best-effort: if the dir
        // can't be made the tenant falls back to its in-memory layout store.
        let session_dir = local_terminal_session_dir().await;
        let hosted = self
            .host
            .open_terminal_session(
                serve_config(self.addr, PREFIX),
                session_dir,
                // The desktop host's per-library draft store roots at the
                // chan home itself (`~/.chan/Drafts`); a same-machine
                // devserver keeps a disjoint store under its own
                // `~/.chan/devserver/` state dir.
                Some(chan_workspace::paths::config_dir()),
            )
            .await
            .map_err(|e| format!("opening the shared embedded terminal tenant: {e}"))?;
        let url = hosted.handle.launch_url();
        *cached = Some(url.clone());
        Ok(url)
    }

    /// True when the shared `/terminal` tenant still has at least one
    /// live PTY session bound to `window_label` (sessions carry the
    /// SPA's `?w=` window id, which IS the Tauri label for desktop
    /// windows). The close handler uses this to decide bury-vs-close
    /// for a standalone terminal window: shells running -> hide the
    /// window and keep them; none -> let the window really close.
    /// Sync (read lock + roster snapshot), safe on the event-loop
    /// thread. `false` when the tenant was never mounted.
    pub fn terminal_window_has_live_shells(&self, window_label: &str) -> bool {
        self.host
            .tenant_has_window_sessions("/terminal", window_label)
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
    /// directly (it does NOT route through the fragile `close_prefix` prune-task
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
    /// never be double-opened). A workspace window resolves its live tenant
    /// (the workspace must be running) for a prefix/token to attach to.
    pub fn mint_window(
        &self,
        kind: chan_server::WindowKind,
        workspace_path: Option<String>,
    ) -> Result<WindowRecord, String> {
        self.host
            .mint_window(kind, workspace_path)
            .map_err(|e| format!("minting a window: {e}"))
    }

    /// Mint a BROWSER-affinity window: the watcher never opens a native twin for
    /// it (the origin filter, D4), so the record exists purely for a browser tab
    /// that holds its own `window_id`. Backs the Window menu's "Open in Browser".
    pub fn mint_browser_window(
        &self,
        kind: chan_server::WindowKind,
        workspace_path: Option<String>,
    ) -> Result<WindowRecord, String> {
        self.host
            .mint_window_with_origin(kind, workspace_path, chan_server::WindowOrigin::Browser)
            .map_err(|e| format!("minting a browser window: {e}"))
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
/// `chan open <workspace>` started before the desktop tried to mount
/// it) surfaces as `WorkspaceLocked`; an in-process handle that hasn't
/// dropped yet surfaces as `WorkspaceAlreadyOpen`. Both reach the SPA
/// verbatim and revert the row's On toggle, so they must read as a
/// clear, non-fatal instruction rather than a raw error chain.
fn map_open_error(key: &str, e: chan_server::Error) -> String {
    use chan_workspace::ChanError;
    match e {
        chan_server::Error::Core(ChanError::WorkspaceLocked | ChanError::WorkspaceAlreadyOpen) => {
            "This workspace is open in another chan process. Quit it and try again.".to_string()
        }
        other => format!("opening embedded workspace {key}: {other}"),
    }
}

/// On-disk dir for the standalone `/terminal` tenant's per-window layout blobs
/// (`~/.chan/terminal-sessions`, created on first use). Routed through
/// `chan_workspace::paths::config_dir` (the single config-dir authority) so a
/// `CHAN_HOME` override isolates a smoke instance -- byte-identical to the old
/// inlined `~/.chan/terminal-sessions` when `CHAN_HOME` is unset. `None` only if
/// the dir can't be created -- the tenant then keeps layout in-memory (it just
/// won't persist across relaunch).
async fn local_terminal_session_dir() -> Option<std::path::PathBuf> {
    let dir = chan_workspace::paths::config_dir().join("terminal-sessions");
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
