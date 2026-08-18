//! Multi-workspace host runtime.
//!
//! `WorkspaceHost` is the in-process owner that chan-desktop can embed
//! instead of spawning one `chan open` child per local workspace. Each
//! mounted workspace still gets its own `AppState`, watcher, indexer,
//! MCP bridge, control socket, terminal registry, and route prefix.

#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Router;
use chan_workspace::{ChanError, Library, Workspace};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tower::ServiceExt;

use crate::desktop_window_ops::DesktopBridge;
#[cfg(test)]
use crate::tenant::TenantTaskOwner;
use crate::tenant::{
    BrowserWindowTarget, HostControl, OpenOutsideAck, TenantArtifacts, TenantBuilder, UnserveMode,
};
use crate::terminal_sessions::{CloseReason, TerminalExit};
#[cfg(target_os = "linux")]
use crate::terminal_sessions::{
    FdStoreManifestEntry, FdStoreParker, FdStoreRestoreReport, FdStoreSessionImport,
    FdStoreSkippedSession,
};
use crate::windows::{PersistedWindow, WindowKind, WindowOrigin, WindowRecord, WindowRegistry};
use crate::{
    allocate_workspace_prefix, sanitize_prefix, DevserverRegistry, Error, GatewayRegistry,
    ServeConfig, ServeHandle, WorkspaceOverlay,
};

/// One workspace mounted into a [`WorkspaceHost`].
#[derive(Debug, Clone)]
pub struct HostedWorkspace {
    /// Workspace root for diagnostics and desktop state correlation.
    pub root: PathBuf,
    /// Canonical route prefix where the workspace is mounted.
    pub prefix: String,
    /// Launch handle for browser/webview clients.
    pub handle: ServeHandle,
}

/// The launcher's workspace row: one registered workspace as the launcher lists
/// it. `workspace_id` is the route prefix without its leading slash -- a single
/// legible segment the launcher addresses by and treats as opaque. `on` =
/// currently mounted/served. No token: the launcher opens a workspace's tenant
/// separately (which carries its own per-tenant token).
///
/// Local rows (the host's own library) carry `devserver_id: None` and route
/// their on/off/remove by `workspace_id` (the by-root path). Rows merged
/// in from a connected devserver via [`DevserverFeedSource::workspaces`] carry
/// `devserver_id: Some(..)` + the remote `library_id`, and the SPA groups them by
/// `devserver_id` and routes their on/off/forget by `prefix`.
///
/// Defined here, not in chan-server's route module, because
/// [`DevserverFeedSource`] returns it and that trait is a chan-library type the
/// host holds; chan-server re-exports it for its route handlers (the same
/// define-in-library / re-export-from-server shape as `DevserverEntry`).
/// A workspace's live lifecycle state, distinct from the persisted desired
/// `on`. The launcher drives spinners and disables toggles off this REAL
/// backend state instead of an optimistic timer: a row spins while `starting`,
/// settles solid on `running`/`stopped`, and surfaces `error` (with
/// [`LauncherWorkspace::error`]) when a mount fails.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    /// Not mounted: desired off, or off and idle. The launcher shows OFF, solid.
    #[default]
    Stopped,
    /// Mount requested / in flight (flock + tenant build not yet complete). The
    /// launcher spins the row and disables the toggle.
    Starting,
    /// Mounted and serving. The launcher shows ON, solid.
    Running,
    /// Held by another live or indeterminate Chan writer. The launcher shows a
    /// disabled locked control and leaves `on` false for this process.
    Locked,
    /// Unmount requested / in flight. The launcher shows a spinner and locks
    /// power/remove controls until the close settles.
    Closing,
    /// Remove requested / in flight. The launcher shows a spinner and locks
    /// power/remove controls until the row disappears or settles.
    Removing,
    /// The last mount attempt failed; [`LauncherWorkspace::error`] carries the
    /// reason. The launcher clears the spinner and surfaces the reason.
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceLifecycleOutcome {
    Completed,
    NotFound,
    Refused { active_terminals: usize },
}

/// Result of [`WorkspaceHost::drain_terminal_sessions`]. `lingering` pids
/// were still observably running when the bounded wait expired; the
/// response is honest about them rather than claiming completion.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalDrainOutcome {
    /// Sessions drained from the registries.
    pub closed: usize,
    /// Child processes whose pid disappeared within the wait.
    pub dead: usize,
    /// Child pids still running at the deadline.
    pub lingering: Vec<u32>,
}

/// Whether `pid` still has a process-table entry. Drain completion requires the
/// owning controller to reap the child, not merely leave a zombie behind.
#[cfg(target_os = "linux")]
fn child_process_running(pid: u32) -> bool {
    std::fs::metadata(format!("/proc/{pid}")).is_ok()
}

/// Non-Linux Unix best effort: signal-0 observes zombies until their parent waits.
#[cfg(all(unix, not(target_os = "linux")))]
fn child_process_running(pid: u32) -> bool {
    let Ok(raw_pid) = i32::try_from(pid) else {
        return false;
    };
    let Some(pid) = rustix::process::Pid::from_raw(raw_pid) else {
        return false;
    };
    rustix::process::test_kill_process(pid).is_ok()
}

/// Non-Unix: no `/proc` and no `rustix::process`, and the systemd-only
/// drain path that consumes this can never run here. Rather than fabricate
/// a death confirmation (or pull in a platform subsystem for an unreachable
/// verification), report the pid as still running: a hypothetical direct
/// drain call sees its children as `lingering` -- unconfirmed -- which is
/// the honest answer on a target with no probe.
#[cfg(not(unix))]
fn child_process_running(_pid: u32) -> bool {
    true
}

impl WorkspaceLifecycleOutcome {
    pub fn completed(self) -> bool {
        matches!(self, Self::Completed)
    }

    pub fn not_found(self) -> bool {
        matches!(self, Self::NotFound)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LauncherWorkspace {
    /// Route prefix without its leading slash -- the launcher's opaque local key.
    pub workspace_id: String,
    /// Absolute workspace root path (display + the add/open argument).
    pub path: String,
    /// Display label (the directory basename).
    pub label: String,
    /// Currently mounted/served.
    pub on: bool,
    /// Owning library identity: the host's own id (`"local"` for desktop, or a
    /// stable `lib-<hex>` for a headless devserver) for local rows; the remote
    /// `lib-<hex>` for a devserver row. Older local rows may omit it; the SPA
    /// treats absence as the legacy `"local"` id.
    #[serde(default)]
    pub library_id: Option<String>,
    /// `Some(devserver id)` for a row merged in from a connected devserver;
    /// `None` for a local row. The discriminator the SPA groups + routes on.
    #[serde(default)]
    pub devserver_id: Option<String>,
    /// The mounted route prefix, ALWAYS the slash-free slug (leading slash
    /// stripped) -- local AND devserver rows alike. For local rows it equals
    /// `workspace_id`; for devserver rows the feed must strip the remote prefix's
    /// leading slash before tagging so the on/off/forget ops carry a clean slug.
    /// (Prefixes are single-segment `[a-z0-9-]` slugs, so `%2F` never arises;
    /// the devserver workspace ops can safely round-trip `prefix` as a value.)
    #[serde(default)]
    pub prefix: String,
    /// Live lifecycle state, distinct from the persisted desired `on`. The
    /// launcher spins a row while `starting` and surfaces `error`; it reads
    /// `status` directly rather than inferring from `on`. `#[serde(default)]`:
    /// a row without the field reads `stopped`.
    #[serde(default)]
    pub status: WorkspaceStatus,
    /// Short human reason, present only when `status == error` (an open
    /// failure). Omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Supplies the launcher's connected-devserver feed: the window records and
/// served workspaces of every devserver the desktop currently holds open, merged
/// into the local launcher surface so one launcher lists local + remote alike.
///
/// Inverted onto [`WorkspaceHost`] like [`DevserverRegistry`] /
/// [`WorkspaceOverlay`]: the connection state lives in chan-desktop (invisible
/// from chan-library), so the desktop installs an `Arc<dyn DevserverFeedSource>`
/// and the host reads it at assembly time. A host that installs none (the
/// headless devserver / plain `chan open`) merges nothing -- its launcher is
/// local-only. The desktop fires [`WorkspaceHost::signal_library_change`] when
/// its feed changes so the watch feed re-pushes.
pub trait DevserverFeedSource: Send + Sync {
    /// Connected devservers' window records (each carries its remote
    /// `library_id`), appended to the local window set by
    /// [`WorkspaceHost::assemble_window_records`].
    fn windows(&self) -> Vec<WindowRecord>;
    /// Connected devservers' served workspaces, already tagged with their
    /// `devserver_id` + remote `library_id`, appended to the local workspace
    /// rows by the launcher's list-workspaces route. Each row's `prefix` MUST be
    /// the slash-free slug (leading slash stripped), so on/off/forget routes carry
    /// a clean single segment.
    fn workspaces(&self) -> Vec<LauncherWorkspace>;
    /// The pane-highlight colour of the connected devserver whose library is
    /// `library_id` -- its own `LocalColorStore` value, fetched from the devserver
    /// (`GET /api/library/local-color`) and cached desktop-side. `None` when no
    /// such devserver is connected or it has no colour set (default accent).
    /// [`WorkspaceHost::pane_color`] resolves a `lib-<hex>` window through this.
    fn pane_color(&self, library_id: &str) -> Option<String>;
}

/// The local library's pane-highlight colour, injected onto [`WorkspaceHost`]
/// like [`DevserverRegistry`]: the value lives in chan-desktop's config
/// (`<chan_home>/desktop`, invisible from chan-library), so the desktop installs an
/// `Arc<dyn LocalColorStore>` and the launcher's local-color routes read/write it
/// through the host. A host that installs none (the headless devserver / plain
/// `chan open`) reports `None` (the default accent) and ignores writes -- the
/// local colour belongs to the desktop's own library.
///
/// The colour is a hex string (`#rrggbb`); `None` is the default accent. The
/// desktop injects it per-window at mint time, mirroring a devserver row's
/// [`DevserverEntry::color`](crate::DevserverEntry).
pub trait LocalColorStore: Send + Sync {
    /// The local library's pane-highlight colour, or `None` for the default accent.
    fn get(&self) -> Option<String>;
    /// Persist the local library's pane-highlight colour; `None` clears it back to
    /// the default. `Err` only on a real persist failure.
    fn set(&self, color: Option<String>) -> Result<(), String>;
}

/// The local machine's launcher theme (`"dark"` / `"light"`), or `None` to
/// follow the OS. Like [`LocalColorStore`] it belongs to the desktop's own
/// library and is invisible from chan-library, so the desktop installs an
/// `Arc<dyn LocalThemeStore>` and the launcher's local-theme routes read/write
/// it through the host. A host that installs none (the headless devserver /
/// plain `chan open`) reports `None` and ignores writes, so a devserver or
/// remote terminal window keeps following the OS.
pub trait LocalThemeStore: Send + Sync {
    /// The launcher's chosen theme, or `None` to follow the OS.
    fn get(&self) -> Option<String>;
    /// Persist the launcher's theme; `None` clears it back to OS-follow. `Err`
    /// only on a real persist failure.
    fn set(&self, theme: Option<String>) -> Result<(), String>;
}

/// The set of collapsed launcher machine cards -- the `"local"` card and each
/// devserver keyed by its id. Like [`LocalThemeStore`] the value belongs to the
/// desktop's own config and is invisible from chan-library, so the desktop
/// installs an `Arc<dyn CollapsedMachinesStore>` and the launcher's
/// `collapsed-machines` routes read/write it through the host. A host that
/// installs none (the headless devserver / plain `chan open`) has no store, so
/// the launcher keeps its localStorage-only collapse and the route reports "no
/// store". Unlike the theme there is no watch: the launcher owns the live UI
/// state and only reconciles on boot.
pub trait CollapsedMachinesStore: Send + Sync {
    /// The persisted collapsed machine keys (empty = nothing collapsed).
    fn get(&self) -> Vec<String>;
    /// Persist the collapsed machine keys. `Err` only on a real persist failure.
    fn set(&self, collapsed: Vec<String>) -> Result<(), String>;
}

/// In-process multi-workspace host.
///
/// This is intentionally a thin owner around the existing per-workspace
/// server runtime. It does not share route state across workspaces:
/// mounting two workspaces builds two independent `AppState` instances
/// and dispatches by URL prefix.
pub struct WorkspaceHost {
    library: Library,
    workspaces: RwLock<HashMap<String, HostedWorkspaceRuntime>>,
    /// Desktop integration shared by every tenant this host mounts: the
    /// window-ops channel and the title map. `DesktopBridge::default()`
    /// (no channel, empty map) when the embedder is not chan-desktop.
    desktop: DesktopBridge,
    /// Serializes idempotent re-registration so two callers racing the same
    /// root resolve to one mount. The winner holds the per-workspace flock
    /// from its `Library::open_workspace` but only lands in `workspaces`
    /// after `build_app`; without this gate a concurrent loser would see
    /// neither the flock-free map nor the not-yet-inserted winner and fail
    /// its own open. Held across the open's `.await`, so it is a tokio
    /// mutex; registration is infrequent, so serializing it is cheap.
    register_lock: tokio::sync::Mutex<()>,
    /// The route layer's tenant constructor, inverted so the host builds tenants
    /// without depending on chan-server. chan-server's `RouteLayer` implements
    /// it; `open_*` call through it.
    builder: Arc<dyn TenantBuilder>,
    /// The host's own `Arc`, downgraded, registered by
    /// [`install_self`](Self::install_self). Lets a per-tenant control socket
    /// reach back for a `chan close` of a hosted path (unmount that tenant).
    /// Empty until an embedder opts in; a host that never does answers
    /// `Unserve` with an "unsupported" message (correct for chan-desktop,
    /// which tears workspaces down in-process).
    self_weak: OnceLock<Weak<dyn HostControl>>,
    /// The library's persisted window registry -- the source of truth for which
    /// windows exist. Installed once via
    /// [`install_window_registry`](Self::install_window_registry); the window
    /// feed (`assemble_window_records`) reads it. Empty on a host that never
    /// installs one (its window set is empty).
    window_registry: OnceLock<Arc<WindowRegistry>>,
    /// The library's persisted workspace on/off overlay -- which registered
    /// workspaces were mounted (`on`) at the last save. Installed once via
    /// [`install_workspace_overlay`](Self::install_workspace_overlay); the boot/
    /// restore path reads it to re-serve, toggles write it. The registry stays
    /// the existence source; this is the on/off overlay over it. Empty on a host
    /// that never installs one (nothing persisted on, so nothing re-serves).
    workspace_overlay: OnceLock<Arc<WorkspaceOverlay>>,
    /// The launcher's devserver registry, inverted like
    /// [`workspace_overlay`](Self::workspace_overlay): the devserver set lives in
    /// chan-desktop's config (invisible from chan-library), so the embedder
    /// installs an `Arc<dyn DevserverRegistry>` and the launcher routes read it at
    /// request time. Empty on the headless devserver / plain `chan open` -- the
    /// routes then serve an empty devserver list and 404 mutation.
    devserver_registry: OnceLock<Arc<dyn DevserverRegistry>>,
    /// The launcher's gateway registry, inverted like
    /// [`devserver_registry`](Self::devserver_registry): the gateway set lives
    /// in chan-desktop's config, so the embedder installs an
    /// `Arc<dyn GatewayRegistry>` and the launcher's gateway routes read it at
    /// request time. Empty on the headless devserver / plain `chan open` -- the
    /// routes then serve an empty gateway list and 404 mutation.
    gateway_registry: OnceLock<Arc<dyn GatewayRegistry>>,
    /// The launcher's connected-devserver feed, inverted like
    /// [`devserver_registry`](Self::devserver_registry): chan-desktop installs an
    /// `Arc<dyn DevserverFeedSource>` over its live connections, and
    /// [`assemble_window_records`](Self::assemble_window_records) + the
    /// list-workspaces route merge its windows/workspaces into the local launcher
    /// surface. Empty on the headless devserver / plain `chan open` -- the launcher
    /// is then local-only.
    devserver_feed: OnceLock<Arc<dyn DevserverFeedSource>>,
    /// The local library's pane-highlight colour store, inverted like
    /// [`devserver_registry`](Self::devserver_registry): the value lives in
    /// chan-desktop's config, so the embedder installs an `Arc<dyn
    /// LocalColorStore>` and the launcher's local-color routes read/write it.
    /// Empty on the headless devserver / plain `chan open` -- the local colour is
    /// then the default accent and writes are ignored.
    local_color: OnceLock<Arc<dyn LocalColorStore>>,
    /// The local machine's launcher theme store, an analogue of
    /// [`local_color`](Self::local_color) for the light/dark choice. Backs the
    /// launcher's `local-theme` routes: the launcher toggle writes it, and local
    /// standalone terminal windows read + watch it. Empty on the headless
    /// devserver / plain `chan open`, so those keep following the OS.
    local_theme: OnceLock<Arc<dyn LocalThemeStore>>,
    /// The set of collapsed launcher machine cards, an analogue of
    /// [`local_theme`](Self::local_theme) for the launcher's per-machine collapse.
    /// Backs the launcher's `collapsed-machines` routes: the collapse toggle
    /// writes it and the launcher reconciles against it on boot. Empty on the
    /// headless devserver / plain `chan open`, so those keep their localStorage
    /// collapse only. No watch: the launcher owns the live UI state.
    collapsed_machines: OnceLock<Arc<dyn CollapsedMachinesStore>>,
    /// This library's identity: `"local"` for the baked-in local-disk library,
    /// `lib-<hex>` for a devserver. Stamped on every window record. Set with the
    /// registry; defaults to `"local"` when unset.
    library_id: OnceLock<String>,
    /// Stable control-socket identity, installed only by a server whose
    /// tenants must stay reachable across restarts (the devserver, via
    /// [`install_control_identity`](Self::install_control_identity)). When
    /// set, every tenant this host mounts binds its control socket at a path
    /// derived from it (plus the tenant prefix) instead of the pid-scoped
    /// path, so `$CHAN_CONTROL_SOCKET` in already-open shells survives a
    /// restart. Unset on window-spawned servers (desktop, `chan open`),
    /// whose sockets SHOULD die with the process.
    control_identity: OnceLock<String>,
    /// Systemd fd-store parking hook, handed to every tenant terminal
    /// registry at mount (see
    /// [`install_terminal_fd_parker`](Self::install_terminal_fd_parker)).
    /// Set only by a devserver running under systemd notify, BEFORE its
    /// first mount; absent everywhere else.
    #[cfg(target_os = "linux")]
    terminal_fd_parker: OnceLock<FdStoreParker>,
    /// Route prefix of this library's shared terminal tenant -- the one
    /// standalone-terminal tenant mounted via [`open_terminal_session`](
    /// Self::open_terminal_session) that every terminal window attaches to.
    /// Recorded on first mount so [`window_live_state`](Self::window_live_state)
    /// resolves a terminal window's `(prefix, token)` to it (the terminal
    /// analogue of a workspace tenant). Unset until the tenant mounts.
    terminal_tenant_prefix: OnceLock<String>,
    /// The standalone window this host last routed an escaping `cs open` to.
    /// Read before liveness so a burst of opens fills one window instead of
    /// minting one per file, since the first window is still opening when the
    /// second call arrives.
    last_routed_standalone: Mutex<Option<String>>,
    /// Control-terminal window_id → its LOCAL `/control-N` tenant prefix. A
    /// devserver control row runs on its OWN command tenant (not the shared
    /// terminal tenant), so [`control_window_live`](Self::control_window_live)
    /// resolves its `(prefix, token, connected)` through this map. Populated by
    /// [`mint_control_window`](Self::mint_control_window), cleared by
    /// [`reap_control_window`](Self::reap_control_window). In-memory only (the
    /// control row is per-connection).
    control_tenants: RwLock<HashMap<String, String>>,
    /// Fires on any change that affects the window set -- registry mint/discard,
    /// `WindowPresence` connect/disconnect, tenant on/off -- so the watch feed
    /// pushes a fresh snapshot. The aggregate every client's reconcile awaits.
    library_change_notify: Arc<Notify>,
    /// Fires ONLY when the library's pane-highlight colour changes, so
    /// the `local-color/watch` feed re-pushes `{ color }`. Dedicated (not
    /// `library_change_notify`) so a colour watcher never wakes on unrelated
    /// window-set churn, and window watchers never wake on a colour change.
    local_color_notify: Arc<Notify>,
    /// Fires ONLY when the launcher theme changes, so the `local-theme/watch`
    /// feed re-pushes `{ theme }`. Dedicated for the same reason as
    /// [`local_color_notify`](Self::local_color_notify).
    local_theme_notify: Arc<Notify>,
    /// The library root's fallback router, served when no tenant prefix matches
    /// a request (the launcher SPA + its `/api/library/*` surface live here).
    /// Installed once via [`install_root_fallback`](Self::install_root_fallback);
    /// chan-library cannot depend on chan-server, so the embedder (devserver /
    /// desktop loopback) builds the launcher router in chan-server and hands it
    /// in. Empty on a host with no root surface -- the root `/` then 404s, the
    /// prior behavior.
    root_fallback: OnceLock<Router>,
    /// Live reverse tunnels (`cs tunnel`) across every tenant this host
    /// serves. Host-owned because the two desktop-dialed WebSocket legs
    /// terminate on the host's launcher router while the registering
    /// `cs tunnel` runs on a tenant control socket: one shared registry is
    /// where they meet. In-memory only -- a tunnel's lifetime is its
    /// foreground command's.
    tunnels: Arc<chan_revtunnel::server::TunnelRegistry>,
    /// Transient mount-lifecycle overlay keyed by canonical workspace root: a
    /// root being mounted (`Starting`) or whose last mount failed (`Error`).
    /// The `workspaces` map is the running source of truth (presence = running);
    /// this carries the two transient states it cannot express, so the launcher
    /// can spin a row (`starting`) and show a failure reason (`error`). Marked
    /// on mount START in [`open_registered_workspace`](Self::open_registered_workspace),
    /// cleared when the mount settles to running, dropped to stopped on turn-off.
    mount_state: Mutex<HashMap<PathBuf, MountState>>,
}

/// The transient lifecycle of a workspace root that the `workspaces` map (the
/// running set) cannot express: a mount in flight, or why the last one failed.
/// Held in [`WorkspaceHost::mount_state`] and projected into
/// [`WorkspaceStatus`] by [`WorkspaceHost::workspace_status`].
#[derive(Clone)]
enum MountState {
    /// A mount is in flight (flock + tenant build not yet complete).
    Starting,
    /// An unmount is in flight.
    Closing,
    /// A remove/unregister is in flight.
    Removing,
    /// The last mount attempt failed; the string is the short human reason.
    Error(String),
}

struct HostedWorkspaceRuntime {
    root: PathBuf,
    /// Launch handle captured at mount time (addr, prefix, token). Lets the
    /// host hand back the existing mount on an idempotent re-register and
    /// list every tenant without rebuilding one.
    handle: ServeHandle,
    artifacts: TenantArtifacts,
}

impl HostedWorkspaceRuntime {
    fn router(&self) -> Router {
        self.artifacts.app.clone()
    }

    /// Stop and join the tenant tasks before clearing the workspace cell, then
    /// verify the workspace flock is released before returning.
    async fn shutdown(mut self) {
        self.artifacts.tasks.shutdown().await;
        let released = self.artifacts.cell.clear();
        if let Some((weak, lock_dir)) = released {
            let wait = tokio::task::spawn_blocking(move || {
                wait_for_workspace_release(&weak, &lock_dir);
            });
            if let Err(error) = wait.await {
                tracing::warn!(%error, "workspace flock-release verifier panicked");
            }
        }
    }
}

impl Drop for HostedWorkspaceRuntime {
    fn drop(&mut self) {
        // Cancellation/unwind fallback: no async join is possible here. Abort
        // the tasks explicitly before clearing the cell so field declaration
        // order can never expose a cleared cell to a detached flusher.
        self.artifacts.tasks.cancel_and_abort();
        let _ = self.artifacts.cell.clear();
    }
}

impl WorkspaceHost {
    /// Create an empty host backed by the caller's `Library`, with no
    /// desktop attached (window-lifecycle ops refuse; the title map stays
    /// empty). The standalone and test path.
    pub fn new(library: Library, builder: Arc<dyn TenantBuilder>) -> Self {
        Self::with_desktop_bridge(library, DesktopBridge::default(), builder)
    }

    /// Create a host whose tenants share `desktop` -- chan-desktop passes a
    /// bridge carrying the window-ops channel and the title map so
    /// `cs window <op>` reaches the Tauri app and `cs window list` shows
    /// real titles. `builder` is the route layer's tenant constructor
    /// (chan-server's `RouteLayer`).
    pub fn with_desktop_bridge(
        library: Library,
        desktop: DesktopBridge,
        builder: Arc<dyn TenantBuilder>,
    ) -> Self {
        Self {
            library,
            workspaces: RwLock::new(HashMap::new()),
            desktop,
            register_lock: tokio::sync::Mutex::new(()),
            builder,
            self_weak: OnceLock::new(),
            window_registry: OnceLock::new(),
            workspace_overlay: OnceLock::new(),
            devserver_registry: OnceLock::new(),
            gateway_registry: OnceLock::new(),
            devserver_feed: OnceLock::new(),
            local_color: OnceLock::new(),
            local_theme: OnceLock::new(),
            collapsed_machines: OnceLock::new(),
            library_id: OnceLock::new(),
            control_identity: OnceLock::new(),
            #[cfg(target_os = "linux")]
            terminal_fd_parker: OnceLock::new(),
            terminal_tenant_prefix: OnceLock::new(),
            last_routed_standalone: Mutex::new(None),
            control_tenants: RwLock::new(HashMap::new()),
            library_change_notify: Arc::new(Notify::new()),
            local_color_notify: Arc::new(Notify::new()),
            local_theme_notify: Arc::new(Notify::new()),
            root_fallback: OnceLock::new(),
            tunnels: chan_revtunnel::server::TunnelRegistry::new(),
            mount_state: Mutex::new(HashMap::new()),
        }
    }

    /// The host's reverse-tunnel registry. The launcher router's tunnel
    /// WebSocket routes attach control/data sockets here, and the tenant
    /// control-socket handler registers a tunnel per foreground `cs tunnel`
    /// (through the [`HostControl`] weak).
    pub fn tunnel_registry(&self) -> Arc<chan_revtunnel::server::TunnelRegistry> {
        Arc::clone(&self.tunnels)
    }

    /// Install this library's persisted window registry + its identity
    /// (`"local"` / `lib-<hex>`). Idempotent set-once; the window feed reads the
    /// registry, and `library_id` is stamped on every record. The embedder
    /// (devserver / desktop) builds the registry at its store path and calls
    /// this once after wrapping the host in an `Arc`.
    pub fn install_window_registry(&self, registry: Arc<WindowRegistry>, library_id: String) {
        // Bridge the registry's own change signal (it fires on every
        // create/remove) into the aggregate library notify, so the watch feed
        // pushes on a mint/discard without the caller having to fire it. Skipped
        // outside a tokio runtime (unit tests don't run the feed); the task
        // lives for the host's lifetime.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let reg_notify = registry.change_notify();
            let lib_notify = Arc::clone(&self.library_change_notify);
            handle.spawn(async move {
                // Re-arm the registry waiter before fanning out so a change
                // during the fan-out is not dropped (`Notify` keeps no permit
                // for `notify_waiters`).
                let notified = reg_notify.notified();
                tokio::pin!(notified);
                loop {
                    notified.as_mut().await;
                    notified.set(reg_notify.notified());
                    lib_notify.notify_waiters();
                }
            });
        }
        let _ = self.window_registry.set(registry);
        let _ = self.library_id.set(library_id);
    }

    /// Install the stable control-socket identity every tenant of this host
    /// binds under (the devserver's persisted `lib-<hex>`). Idempotent
    /// set-once, called before the first mount. A host that never installs
    /// one keeps pid-scoped control sockets, which is correct for
    /// window-spawned servers: their shells' `$CHAN_CONTROL_SOCKET` going
    /// stale on process death is the truth, not a bug.
    pub fn install_control_identity(&self, identity: String) {
        let _ = self.control_identity.set(identity);
    }

    /// Install the systemd fd-store parking hook. Must run before the first
    /// mount: the hook reaches tenant registries only at their mount wiring,
    /// so an earlier-mounted tenant would never park.
    #[cfg(target_os = "linux")]
    pub fn install_terminal_fd_parker(&self, parker: FdStoreParker) {
        let _ = self.terminal_fd_parker.set(parker);
    }

    /// The installed stable control-socket identity, cloned per mount for the
    /// tenant builder. `None` on hosts that keep pid-scoped sockets.
    fn control_identity(&self) -> Option<String> {
        self.control_identity.get().cloned()
    }

    /// Fire the aggregate window-set change signal that the watch feed awaits.
    /// Called when a tenant mounts/unmounts (a workspace window's liveness in
    /// [`assemble_window_records`](Self::assemble_window_records) shifts);
    /// registry mint/discard fire it via the bridge in
    /// [`install_window_registry`](Self::install_window_registry).
    fn notify_window_change(&self) {
        self.library_change_notify.notify_waiters();
    }

    /// This library's persisted window registry, once installed.
    pub fn window_registry(&self) -> Option<&Arc<WindowRegistry>> {
        self.window_registry.get()
    }

    /// Install this library's persisted workspace on/off overlay. Idempotent
    /// set-once; the embedder (devserver / desktop) builds it at its store path
    /// (co-located with the window registry) and calls this once after wrapping
    /// the host in an `Arc`. The boot/restore path reads it to re-serve the
    /// workspaces that were on; toggles write it.
    pub fn install_workspace_overlay(&self, overlay: Arc<WorkspaceOverlay>) {
        let _ = self.workspace_overlay.set(overlay);
    }

    /// This library's persisted workspace on/off overlay, once installed.
    pub fn workspace_overlay(&self) -> Option<&Arc<WorkspaceOverlay>> {
        self.workspace_overlay.get()
    }

    /// Install the launcher's devserver registry. Idempotent set-once; chan-desktop
    /// calls this once (next to [`install_workspace_overlay`](
    /// Self::install_workspace_overlay)) with an impl over its config. A host that
    /// never installs one answers [`devserver_registry`](Self::devserver_registry)
    /// with `None` -- the headless devserver / plain `chan open`.
    pub fn install_devserver_registry(&self, registry: Arc<dyn DevserverRegistry>) {
        let _ = self.devserver_registry.set(registry);
    }

    /// The launcher's devserver registry, once installed. `None` on a host whose
    /// embedder installed none; the launcher routes then serve an empty devserver
    /// list and 404 mutation.
    pub fn devserver_registry(&self) -> Option<&Arc<dyn DevserverRegistry>> {
        self.devserver_registry.get()
    }

    /// Install the launcher's gateway registry. Idempotent set-once; chan-desktop
    /// calls this once (next to [`install_devserver_registry`](
    /// Self::install_devserver_registry)) with an impl over its config. A host
    /// that never installs one answers [`gateway_registry`](
    /// Self::gateway_registry) with `None` -- the headless devserver / plain
    /// `chan open`.
    pub fn install_gateway_registry(&self, registry: Arc<dyn GatewayRegistry>) {
        let _ = self.gateway_registry.set(registry);
    }

    /// The launcher's gateway registry, once installed. `None` on a host whose
    /// embedder installed none; the launcher routes then serve an empty gateway
    /// list and 404 mutation.
    pub fn gateway_registry(&self) -> Option<&Arc<dyn GatewayRegistry>> {
        self.gateway_registry.get()
    }

    /// Install the launcher's connected-devserver feed. Idempotent set-once;
    /// chan-desktop calls this once with an impl over its live connections, so the
    /// launcher merges connected devservers' windows + workspaces. A host that
    /// never installs one (headless devserver / plain `chan open`) merges nothing.
    pub fn install_devserver_feed(&self, feed: Arc<dyn DevserverFeedSource>) {
        let _ = self.devserver_feed.set(feed);
    }

    /// The launcher's connected-devserver feed, once installed. `None` on a host
    /// whose embedder installed none -- the launcher is then local-only.
    pub fn devserver_feed(&self) -> Option<&Arc<dyn DevserverFeedSource>> {
        self.devserver_feed.get()
    }

    /// Install the local library's pane-highlight colour store. Idempotent
    /// set-once; chan-desktop calls this once with an impl over its config. A host
    /// that never installs one reports the default accent and ignores writes.
    pub fn install_local_color_store(&self, store: Arc<dyn LocalColorStore>) {
        let _ = self.local_color.set(store);
    }

    /// The local library's pane-highlight colour store, once installed. `None` on
    /// a host whose embedder installed none (headless devserver / plain
    /// `chan open`) -- the local colour is then the default accent.
    pub fn local_color_store(&self) -> Option<&Arc<dyn LocalColorStore>> {
        self.local_color.get()
    }

    /// Install the local machine's launcher-theme store. Idempotent set-once;
    /// chan-desktop calls this once with an impl over its config. A host that
    /// never installs one reports OS-follow and ignores writes.
    pub fn install_local_theme_store(&self, store: Arc<dyn LocalThemeStore>) {
        let _ = self.local_theme.set(store);
    }

    /// The launcher-theme store, once installed. `None` on a host whose embedder
    /// installed none (headless devserver / plain `chan open`); the theme then
    /// follows the OS.
    pub fn local_theme_store(&self) -> Option<&Arc<dyn LocalThemeStore>> {
        self.local_theme.get()
    }

    /// Install the collapsed-machines store. Idempotent set-once; chan-desktop
    /// calls this once with an impl over its config. A host that never installs
    /// one has no collapse persistence, so the launcher keeps localStorage only.
    pub fn install_collapsed_machines_store(&self, store: Arc<dyn CollapsedMachinesStore>) {
        let _ = self.collapsed_machines.set(store);
    }

    /// The collapsed-machines store, once installed. `None` on a host whose
    /// embedder installed none (headless devserver / plain `chan open`); the
    /// launcher then persists collapse in localStorage only.
    pub fn collapsed_machines_store(&self) -> Option<&Arc<dyn CollapsedMachinesStore>> {
        self.collapsed_machines.get()
    }

    /// The pane-highlight colour for a window of `library_id`, resolving each
    /// chan-library's own colour behind one accessor so the desktop injects it at
    /// mint time without knowing where each colour lives. `"local"` resolves to
    /// the local-library colour (the installed [`local_color_store`](
    /// Self::local_color_store)); a `lib-<hex>` id resolves to that connected
    /// devserver's own colour -- its remote `LocalColorStore`, fetched + cached by
    /// the desktop and surfaced through [`DevserverFeedSource::pane_color`]. (Each
    /// library's colour lives in THAT library's host, set from a pane's
    /// focus-border menu; there is no desktop-side per-devserver colour.) `None`  --
    /// no source installed, no matching devserver, or an unset colour -- means the
    /// editor falls back to the default accent.
    pub fn pane_color(&self, library_id: &str) -> Option<String> {
        if library_id == "local" {
            return self.local_color_store().and_then(|store| store.get());
        }
        self.devserver_feed()?.pane_color(library_id)
    }

    /// Install the library root's fallback router -- served by `host_dispatch`
    /// when no tenant prefix matches (the launcher SPA + its `/api/library/*`
    /// surface). Idempotent set-once; the embedder (devserver / desktop
    /// loopback) builds the launcher router in chan-server and calls this once
    /// after wrapping the host in an `Arc`, before `router()`. A host that never
    /// installs one keeps the prior behavior: the root `/` 404s.
    pub fn install_root_fallback(&self, router: Router) {
        let _ = self.root_fallback.set(router);
    }

    /// This library's identity (`"local"` until a devserver installs its own).
    pub fn library_id(&self) -> &str {
        self.library_id.get().map(String::as_str).unwrap_or("local")
    }

    /// Whether a desktop window bridge is attached (chan-desktop embeds this
    /// host with a live `window_ops` channel). Distinguishes the desktop loopback
    /// surface from a headless devserver loopback so the launcher meta can
    /// advertise the right capabilities: a desktop drives native windows through
    /// the bridge, a devserver browser manages its own.
    pub fn has_desktop_bridge(&self) -> bool {
        self.desktop.window_ops.is_some()
    }

    /// The aggregate change signal the window-set watch feed awaits: fires on
    /// registry mint/discard, presence connect/disconnect, and tenant on/off.
    pub fn library_change_notify(&self) -> Arc<Notify> {
        self.library_change_notify.clone()
    }

    /// The colour-change signal the `local-color/watch` feed awaits.
    pub fn local_color_notify(&self) -> Arc<Notify> {
        self.local_color_notify.clone()
    }

    /// Fire the colour-change signal -- called after the local-colour store is
    /// written (`handle_set_local_color`), so every `local-color/watch`
    /// subscriber re-reads + re-applies the new colour.
    pub fn notify_local_color_change(&self) {
        self.local_color_notify.notify_waiters();
    }

    /// The theme-change signal the `local-theme/watch` feed awaits.
    pub fn local_theme_notify(&self) -> Arc<Notify> {
        self.local_theme_notify.clone()
    }

    /// Fire the theme-change signal, called after the launcher-theme store is
    /// written (`handle_set_local_theme`), so every `local-theme/watch`
    /// subscriber re-reads + re-applies the new theme.
    pub fn notify_local_theme_change(&self) {
        self.local_theme_notify.notify_waiters();
    }

    /// Fire the aggregate library-change signal so the window-set watch feed
    /// re-pushes a fresh snapshot. The public entry point chan-desktop calls when
    /// its connected-devserver feed or workspace cache changes (a devserver
    /// connects/disconnects, a remote window appears) -- the merged-in windows and
    /// workspaces shift without any local registry event to drive the push.
    pub fn signal_library_change(&self) {
        self.library_change_notify.notify_waiters();
    }

    /// Register the host's own `Arc` so per-tenant control sockets can reach it
    /// for a `chan close` of a hosted path. Idempotent; an embedder that
    /// wants control-socket unserve of hosted workspaces calls this once after
    /// wrapping the host in an `Arc` (the devserver does). A host that never
    /// calls it answers `Unserve` with an "unsupported" message -- correct for
    /// chan-desktop, which tears workspaces down in-process, not over the
    /// control socket.
    pub fn install_self(self: &Arc<Self>) {
        // Unsize the concrete `Weak<WorkspaceHost>` to `Weak<dyn HostControl>`
        // (WorkspaceHost impls HostControl) so the control socket reaches the
        // host without naming the concrete type. Downgrade concretely first,
        // then coerce -- inferring the trait object from `set`'s type would make
        // `downgrade` expect `&Arc<dyn HostControl>` and fail.
        let weak_self: Weak<WorkspaceHost> = Arc::downgrade(self);
        let _ = self.self_weak.set(weak_self);
    }

    /// The unserve mode tenants built by this host carry: `Host(weak)` once
    /// [`install_self`](Self::install_self) ran, else `Unsupported`.
    fn unserve_mode(&self) -> UnserveMode {
        match self.self_weak.get() {
            Some(weak) => UnserveMode::Host(weak.clone()),
            None => UnserveMode::Unsupported,
        }
    }

    /// Return the shared workspace registry handle.
    pub fn library(&self) -> &Library {
        &self.library
    }

    /// The desktop bridge shared across this host's tenants. chan-desktop
    /// uses it to write window titles as it builds/destroys webviews.
    pub fn desktop_bridge(&self) -> &DesktopBridge {
        &self.desktop
    }

    /// Open a registered workspace path and mount it under
    /// `config.prefix`.
    ///
    /// The path must already be registered with this host's
    /// `Library`. Desktop first-launch code can create/register the
    /// workspace before calling this method; the CLI compatibility path
    /// keeps its existing auto-create behavior outside the host.
    pub async fn open_registered_workspace(
        &self,
        root: impl AsRef<Path>,
        config: ServeConfig,
    ) -> Result<HostedWorkspace, Error> {
        let root = root.as_ref();
        // Mark the mount in flight (status `starting`) and fire the watch feed
        // so the launcher spins this row before the (possibly slow) tenant build
        // completes. This is the SHARED inner mount every entry point funnels
        // through -- the `open_or_get` wrapper, the desktop's direct boot-restore
        // (embedded.rs), the devserver `mount_at` -- so all of them surface
        // `starting`/`error` without each routing the lifecycle themselves.
        self.mark_mount_starting(root);
        let result = self.open_registered_workspace_inner(root, config).await;
        self.settle_mount(root, &result);
        result
    }

    /// The raw mount: open the per-workspace handle (acquiring the flock) and
    /// mount its tenant. Split from [`open_registered_workspace`](
    /// Self::open_registered_workspace) so the lifecycle bookkeeping wraps a
    /// single fallible body.
    async fn open_registered_workspace_inner(
        &self,
        root: &Path,
        config: ServeConfig,
    ) -> Result<HostedWorkspace, Error> {
        let workspace = self.library.open_workspace(root)?;
        self.open_workspace(workspace, config).await
    }

    /// Mount the workspace at `root` under `config.prefix`, or return the
    /// existing mount when that root is already mounted.
    ///
    /// Idempotent on the workspace ROOT: a root already mounted (under any
    /// prefix) returns its existing [`HostedWorkspace`] without re-opening
    /// it, so the per-workspace single-writer flock the running tenant
    /// holds is never contended (a second `Library::open_workspace` on a
    /// mounted root would fail `WorkspaceAlreadyOpen` anyway). A different
    /// root that collides on `config.prefix` is still an error.
    ///
    /// Race-safe via the host's registration lock: callers racing the same
    /// root serialize, so the first mounts and the rest observe that mount
    /// in the pre-check and return it. A distinct root that collides on
    /// `config.prefix` falls through to `open_registered_workspace` and its
    /// duplicate-prefix error.
    pub async fn open_or_get_registered_workspace(
        &self,
        root: impl AsRef<Path>,
        config: ServeConfig,
    ) -> Result<HostedWorkspace, Error> {
        let root = root.as_ref();
        let _registering = self.register_lock.lock().await;
        if let Some(existing) = self.hosted_for_root(root)? {
            return Ok(existing);
        }
        self.open_registered_workspace(root, config).await
    }

    /// The existing mount for `root`, matched by canonical form, or `None`
    /// when no tenant owns that path. One read lock; the returned
    /// [`HostedWorkspace`] is rebuilt from the handle captured at mount.
    fn hosted_for_root(&self, root: &Path) -> Result<Option<HostedWorkspace>, Error> {
        let target = canonical_key(root);
        let workspaces = self
            .workspaces
            .read()
            .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
        Ok(workspaces
            .values()
            .find(|runtime| canonical_key(&runtime.root) == target)
            .map(hosted_from_runtime))
    }

    /// Mount an already-open workspace under `config.prefix`.
    pub async fn open_workspace(
        &self,
        workspace: Arc<Workspace>,
        mut config: ServeConfig,
    ) -> Result<HostedWorkspace, Error> {
        config.prefix = sanitize_prefix(&config.prefix).map_err(Error::Config)?;
        let prefix = config.prefix.clone();
        let root = workspace.root().to_path_buf();

        {
            let workspaces = self
                .workspaces
                .read()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            if workspaces.contains_key(&prefix) {
                return Err(Error::Config(format!(
                    "workspace prefix already mounted: {}",
                    display_prefix(&prefix)
                )));
            }
            if workspaces.values().any(|runtime| runtime.root == root) {
                return Err(Error::Config(format!(
                    "workspace already mounted: {}",
                    root.display()
                )));
            }
        }

        let artifacts = self
            .builder
            .build_workspace(
                self.library.clone(),
                Arc::clone(&workspace),
                &config,
                self.desktop.clone(),
                self.unserve_mode(),
                self.control_identity(),
            )
            .await?;
        // Presence transitions (a window's first socket connecting / last one
        // dropping) shift its `connected` flag with no registry change, so feed
        // the tenant's presence the aggregate signal the watch awaits.
        artifacts
            .window_presence
            .install_change_notify(self.library_change_notify.clone());
        // A leader change (election, reaper promotion, handover) shifts the
        // watch feed's per-tenant leaders map with no registry change, so feed
        // the tenant's session registry the same aggregate signal.
        artifacts
            .session_registry
            .install_change_notify(self.library_change_notify.clone());
        // Continuous fd parking spans every tenant's registry (workspace
        // panes park exactly like standalone terminals).
        #[cfg(target_os = "linux")]
        if let Some(parker) = self.terminal_fd_parker.get() {
            artifacts
                .terminal_sessions
                .install_fd_parker(parker.clone());
        }
        let handle = ServeHandle {
            addr: config.addr,
            prefix: prefix.clone(),
            token: artifacts.token.clone(),
        };
        let hosted = HostedWorkspace {
            root: root.clone(),
            prefix: prefix.clone(),
            handle: handle.clone(),
        };
        let runtime = HostedWorkspaceRuntime {
            root,
            handle,
            artifacts,
        };

        let mut workspaces = self
            .workspaces
            .write()
            .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
        // Workspace::open validates the root before the asynchronous tenant
        // build starts. Validate it again at the publication boundary: on Unix
        // the capability dir + writer lock stay alive after `rm -rf`, so a
        // builder that was awaiting could otherwise publish a deleted root as
        // a healthy running tenant. The host map lock makes this check and
        // insertion one synchronous publication step.
        let root_available = workspace.ensure_root_available();
        drop(workspace);
        if let Err(error) = root_available {
            drop(workspaces);
            runtime.shutdown().await;
            return Err(error.into());
        }
        if workspaces.contains_key(&prefix) {
            return Err(Error::Config(format!(
                "workspace prefix already mounted: {}",
                display_prefix(&prefix)
            )));
        }
        workspaces.insert(prefix, runtime);
        drop(workspaces);
        self.notify_window_change();
        Ok(hosted)
    }

    /// Mount a workspace-less "terminal-only" tenant whose terminals run
    /// the user's default interactive shell. Shorthand for
    /// [`open_terminal_session_with_command`](Self::open_terminal_session_with_command)
    /// with no command.
    pub async fn open_terminal_session(
        &self,
        config: ServeConfig,
        session_dir: Option<PathBuf>,
    ) -> Result<HostedWorkspace, Error> {
        // This is THE library's shared terminal tenant (every standalone
        // terminal window attaches here, sharing its prefix+token). Record its
        // sanitized prefix -- matching the `workspaces` map key -- so
        // `window_live_state(Terminal)` resolves terminal windows to it. With
        // `session_dir = Some(dir)` the tenant persists each window's pane
        // layout on disk, so a standalone terminal window restores its layout on
        // relaunch (with fresh shells -- the PTYs don't survive); `None` keeps
        // layout in-memory (`ephemeral_sessions`). Either way the terminal
        // WINDOWS persist as registry rows. Set-once: the shared tenant mounts
        // once per library.
        let prefix = sanitize_prefix(&config.prefix).map_err(Error::Config)?;
        let hosted = self
            .open_terminal_session_with_command(config, None, session_dir)
            .await?;
        let _ = self.terminal_tenant_prefix.set(prefix);
        Ok(hosted)
    }

    /// Mount a workspace-less "terminal-only" tenant under
    /// `config.prefix`, optionally running `command` on its PTY.
    ///
    /// Mirrors [`open_workspace`](Self::open_workspace) but backs the
    /// mount with `build_terminal_app` instead of `build_app`: no
    /// `Arc<Workspace>`, no watcher / indexer / MCP bridge / control
    /// socket. The slim tenant serves only the terminal + window-session
    /// routes plus the SPA shell, so a standalone terminal window
    /// (desktop webview in `?kind=terminal` mode) gets a PTY surface
    /// without a workspace behind it.
    ///
    /// `command` is one shell command line, run through the login shell so
    /// an interactive script (host-key / password prompts) gets a real
    /// PTY; `None` keeps the default shell. It is the tenant default, so
    /// every terminal opened in this tenant that names no command of its
    /// own runs it (a single-purpose terminal window, e.g. one that runs a
    /// connect script).
    ///
    /// The tenant lands in the SAME `workspaces` map as workspace mounts
    /// and is reached by the same `host_dispatch` prefix routing, so the
    /// duplicate-prefix guard and `close_workspace` apply uniformly. The
    /// returned [`HostedWorkspace::root`] is the PTY cwd (the user's home
    /// dir) since there is no workspace root; `handle.launch_url()`
    /// resolves against `config.addr`/`prefix`/token exactly like a
    /// workspace mount.
    pub async fn open_terminal_session_with_command(
        &self,
        mut config: ServeConfig,
        command: Option<String>,
        session_dir: Option<PathBuf>,
    ) -> Result<HostedWorkspace, Error> {
        config.prefix = sanitize_prefix(&config.prefix).map_err(Error::Config)?;
        let prefix = config.prefix.clone();

        // Duplicate-prefix guard only: unlike a workspace mount there is
        // no filesystem root to collide on, so two terminal tenants are
        // free to share the home-dir PTY cwd. The check mirrors
        // `open_workspace` so a prefix already serving a workspace can't
        // be shadowed.
        {
            let workspaces = self
                .workspaces
                .read()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            if workspaces.contains_key(&prefix) {
                return Err(Error::Config(format!(
                    "workspace prefix already mounted: {}",
                    display_prefix(&prefix)
                )));
            }
        }

        // A command-less tenant is the SHARED terminal tenant (the one
        // standalone terminal windows attach to); a command-carrying one is a
        // control / single-purpose tenant the desktop exit-watcher manages.
        // Only the former gets the window-reap hook below.
        let is_shared_terminal = command.is_none();
        // The builder applies `command` as the tenant's default before the SPA
        // can open the first terminal.
        let artifacts = self
            .builder
            .build_terminal(
                self.library.clone(),
                &config,
                self.desktop.clone(),
                self.unserve_mode(),
                command,
                session_dir,
                self.control_identity(),
            )
            .await?;
        // Feed the tenant's presence the aggregate change signal (see
        // `open_workspace`); a terminal window's `connected` is presence-driven.
        artifacts
            .window_presence
            .install_change_notify(self.library_change_notify.clone());
        // Same for the session registry, so a terminal-tenant leader change
        // refreshes the watch feed's leaders map (see `open_workspace`).
        artifacts
            .session_registry
            .install_change_notify(self.library_change_notify.clone());
        #[cfg(target_os = "linux")]
        if let Some(parker) = self.terminal_fd_parker.get() {
            artifacts
                .terminal_sessions
                .install_fd_parker(parker.clone());
        }
        // A standalone terminal window IS its PTY. When the shell exits and
        // no client is attached, the registry's `reap_exited` closes the session;
        // hook it so the window-feed row leaves with it instead of lingering as a
        // ghost. Scoped to the shared terminal tenant + non-control terminal rows
        // (`remove_terminal`), so a workspace window's pane death never closes it.
        if is_shared_terminal {
            if let Some(window_registry) = self.window_registry().cloned() {
                let notify = Arc::clone(&self.library_change_notify);
                artifacts.terminal_sessions.install_window_reaper(
                    crate::terminal_sessions::WindowReaper::new(move |window_id: &str| {
                        if window_registry.remove_terminal(window_id) {
                            // Fire the feed change directly too, so the push does
                            // not hinge on the registry-bridge task's scheduling
                            // (mirrors `mint_window`).
                            notify.notify_waiters();
                        }
                    }),
                );
            }
        }
        // Root reported for diagnostics / desktop correlation: the PTY
        // cwd is the user's home dir, so surface that. Falls back to "/"
        // to match `build_terminal_app`'s registry root resolution.
        let root = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let handle = ServeHandle {
            addr: config.addr,
            prefix: prefix.clone(),
            token: artifacts.token.clone(),
        };
        let hosted = HostedWorkspace {
            root: root.clone(),
            prefix: prefix.clone(),
            handle: handle.clone(),
        };
        let runtime = HostedWorkspaceRuntime {
            root,
            handle,
            artifacts,
        };

        let mut workspaces = self
            .workspaces
            .write()
            .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
        if workspaces.contains_key(&prefix) {
            return Err(Error::Config(format!(
                "workspace prefix already mounted: {}",
                display_prefix(&prefix)
            )));
        }
        workspaces.insert(prefix, runtime);
        drop(workspaces);
        self.notify_window_change();
        Ok(hosted)
    }

    /// True when the tenant mounted at `prefix` has at least one live
    /// terminal session bound to `window_id` (the desktop window label
    /// the SPA forwards from its `?w=` query param).
    ///
    /// chan-desktop's close handler asks this before letting a
    /// standalone terminal window really close: a window whose shells
    /// are still alive gets hidden ("buried") instead, so the PTYs stay
    /// reachable. Sync and cheap (one read lock + a roster snapshot);
    /// safe to call from the Tauri event-loop thread. `false` when no
    /// tenant is mounted at `prefix`.
    pub fn tenant_has_window_sessions(&self, prefix: &str, window_id: &str) -> bool {
        let Ok(prefix) = sanitize_prefix(prefix) else {
            return false;
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return false;
        };
        let Some(runtime) = workspaces.get(&prefix) else {
            return false;
        };
        runtime
            .artifacts
            .terminal_sessions
            .roster()
            .iter()
            .any(|entry| entry.window_id.as_deref() == Some(window_id))
    }

    /// True when the tenant mounted at `prefix` has at least one file
    /// transfer (upload / download) in flight for `window_id`.
    ///
    /// chan-desktop's close handler asks this -- alongside
    /// [`Self::tenant_has_window_sessions`] -- before letting a window close:
    /// a window with a transfer running gets a hold/cancel prompt instead of
    /// closing out from under the transfer. The count is reported by the SPA
    /// over `/ws` and RAII-cleared when the socket drops, so a reloaded
    /// window reads inactive without any client message. Sync and cheap (one
    /// read lock + a map lookup); safe to call from the Tauri event-loop
    /// thread. `false` when no tenant is mounted at `prefix`.
    pub fn tenant_has_active_transfer(&self, prefix: &str, window_id: &str) -> bool {
        let Ok(prefix) = sanitize_prefix(prefix) else {
            return false;
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return false;
        };
        let Some(runtime) = workspaces.get(&prefix) else {
            return false;
        };
        runtime
            .artifacts
            .window_transfers
            .window_has_active_transfer(window_id)
    }

    /// How many live terminal sessions the tenant mounted at `prefix` is
    /// running, or `0` when nothing is mounted there. The reversible
    /// workspace-off path reads this to refuse an unmount that would kill
    /// running terminals unless the caller forces it. Sync and cheap (one read
    /// lock + a roster snapshot), like
    /// [`tenant_has_window_sessions`](Self::tenant_has_window_sessions).
    pub fn tenant_terminal_session_count(&self, prefix: &str) -> usize {
        let Ok(prefix) = sanitize_prefix(prefix) else {
            return 0;
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return 0;
        };
        workspaces
            .get(&prefix)
            .map(|runtime| runtime.artifacts.terminal_sessions.roster().len())
            .unwrap_or(0)
    }

    /// Manifest entries for every PARKED session across every mounted
    /// tenant: the restart manifest's content. Host-wide because the store
    /// is process-level; the bound is the number of parked fds (ceilinged by
    /// the unit's FileDescriptorStoreMax), never one tenant's session cap.
    #[cfg(target_os = "linux")]
    pub fn fdstore_manifest_sessions(&self) -> Vec<FdStoreManifestEntry> {
        let Ok(workspaces) = self.workspaces.read() else {
            return Vec::new();
        };
        workspaces
            .values()
            .flat_map(|runtime| {
                runtime
                    .artifacts
                    .terminal_sessions
                    .fdstore_manifest_sessions(&runtime.handle.prefix)
            })
            .collect()
    }

    /// Activation reconcile: park every live windowed unparked session in
    /// every tenant. Covers sessions spawned while the parker was still
    /// disabled during boot.
    #[cfg(target_os = "linux")]
    pub fn park_unparked_windowed_terminal_sessions(&self) {
        // Clone the registry handles and RELEASE the workspaces lock before
        // parking: each park's synchronous manifest commit re-enters
        // `fdstore_manifest_sessions`, and a recursive read on the std
        // RwLock can deadlock once a writer queues between the two reads.
        let registries: Vec<Arc<crate::terminal_sessions::Registry>> = {
            let Ok(workspaces) = self.workspaces.read() else {
                return;
            };
            workspaces
                .values()
                .map(|runtime| runtime.artifacts.terminal_sessions.clone())
                .collect()
        };
        for registry in registries {
            registry.park_unparked_windowed_sessions();
        }
    }

    /// Removes and detaches every parked session in every tenant (no kill,
    /// no unpark). The devserver's graceful-shutdown sweep: runs AFTER the
    /// final manifest write and BEFORE `shutdown_all`, so tenant teardown
    /// finds the preserved sessions already gone and kills only the rest.
    #[cfg(target_os = "linux")]
    pub fn detach_parked_terminal_sessions(&self) -> usize {
        let Ok(workspaces) = self.workspaces.read() else {
            return 0;
        };
        workspaces
            .values()
            .map(|runtime| runtime.artifacts.terminal_sessions.detach_parked_sessions())
            .sum()
    }

    /// Explicitly end every terminal session in every tenant and wait,
    /// bounded, until each child process is observably dead. Backs the
    /// devserver drain endpoint (`chan devserver --stop` / `--restart
    /// --force`): the response must not claim completion before the
    /// children are gone, HUP-immune ones included.
    pub async fn drain_terminal_sessions(&self) -> TerminalDrainOutcome {
        self.drain_terminal_sessions_with(child_process_running, Duration::from_secs(5))
            .await
    }

    /// Liveness- and deadline-injectable body of
    /// [`drain_terminal_sessions`](Self::drain_terminal_sessions), so tests
    /// can force the lingering arm without an unkillable process.
    async fn drain_terminal_sessions_with(
        &self,
        alive: impl Fn(u32) -> bool,
        wait: Duration,
    ) -> TerminalDrainOutcome {
        let (registries, mut pids) = {
            let Ok(workspaces) = self.workspaces.read() else {
                return TerminalDrainOutcome::default();
            };
            let registries: Vec<_> = workspaces
                .values()
                .map(|runtime| runtime.artifacts.terminal_sessions.clone())
                .collect();
            let pids: Vec<u32> = registries
                .iter()
                .flat_map(|registry| registry.live_child_pids())
                .collect();
            (registries, pids)
        };
        let mut closed = 0;
        for registry in registries {
            closed += registry.close_all(CloseReason::Shutdown);
        }
        let total = pids.len();
        let deadline = std::time::Instant::now() + wait;
        loop {
            pids.retain(|pid| alive(*pid));
            if pids.is_empty() || std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        TerminalDrainOutcome {
            closed,
            dead: total - pids.len(),
            lingering: pids,
        }
    }

    /// Restores inherited fdstore PTYs into their original mounted tenants.
    ///
    /// Guardrails are deliberately conservative: a PTY is restored only when its
    /// tenant prefix is mounted and its owning `window_id` is still present in
    /// the persisted window registry. If `.chan` metadata or a workspace mount
    /// disappeared during the restart, the fd is dropped instead of reviving a
    /// session into a layout the client can no longer reconcile.
    #[cfg(target_os = "linux")]
    pub fn restore_fdstore_terminal_sessions(
        &self,
        imports: Vec<FdStoreSessionImport>,
    ) -> FdStoreRestoreReport {
        let mut report = FdStoreRestoreReport::default();
        let Some(registry) = self.window_registry() else {
            for import in imports {
                report.skip_session(&import.meta, "window registry not installed");
            }
            return report;
        };
        let valid_windows: HashSet<String> = registry
            .snapshot()
            .into_iter()
            .map(|row| row.window_id)
            .collect();
        let mut by_prefix: HashMap<String, Vec<FdStoreSessionImport>> = HashMap::new();
        for import in imports {
            let Some(window_id) = import.meta.window_id.as_deref() else {
                report.skip_session(&import.meta, "missing window id");
                continue;
            };
            if !valid_windows.contains(window_id) {
                report.skip_session(
                    &import.meta,
                    format!("window {window_id} is no longer persisted"),
                );
                continue;
            }
            by_prefix
                .entry(import.meta.tenant_prefix.clone())
                .or_default()
                .push(import);
        }

        let Ok(workspaces) = self.workspaces.read() else {
            for import in by_prefix.into_values().flatten() {
                report.skip_session(&import.meta, "workspace host lock poisoned");
            }
            return report;
        };
        for (prefix, imports) in by_prefix {
            let Some(runtime) = workspaces.get(&prefix) else {
                for import in imports {
                    report.skip_session(
                        &import.meta,
                        format!("tenant prefix {prefix} is not mounted"),
                    );
                }
                continue;
            };
            let tenant_report = runtime
                .artifacts
                .terminal_sessions
                .restore_fdstore_sessions(imports);
            report.restored += tenant_report.restored;
            report.skipped.extend(tenant_report.skipped);
            report
                .skipped_sessions
                .extend(tenant_report.skipped_sessions);
        }
        if report.restored > 0 {
            self.notify_window_change();
        }
        report
    }

    /// Cleans persisted standalone terminal windows whose fdstore PTY could not
    /// be restored. Workspace windows are deliberately not removed here: a lost
    /// pane PTY must not discard the user's workspace window/layout.
    #[cfg(target_os = "linux")]
    pub fn cleanup_skipped_fdstore_sessions(
        &self,
        skipped_sessions: &[FdStoreSkippedSession],
    ) -> Vec<String> {
        let Some(registry) = self.window_registry() else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        let mut removed = Vec::new();
        for skipped in skipped_sessions {
            let Some(window_id) = skipped.window_id.as_deref() else {
                continue;
            };
            if !seen.insert(window_id.to_string()) {
                continue;
            }
            if registry.remove_terminal(window_id) {
                let reaped = self.reap_discarded_window_state(window_id);
                self.notify_window_change();
                removed.push(format!(
                    "window {window_id}: removed dangling terminal window after fdstore restore skip (reaped {reaped} session(s))"
                ));
            }
        }
        removed
    }

    /// Cleans all standalone terminal window rows after inherited fdstore FDs
    /// arrive without a readable restart manifest. With no trustworthy
    /// session-to-window mapping left, terminal rows are the only safe rows to
    /// reap; workspace and control windows remain under their normal owners.
    #[cfg(target_os = "linux")]
    pub fn cleanup_fdstore_metadata_loss_terminal_windows(&self) -> Vec<String> {
        let Some(registry) = self.window_registry() else {
            return Vec::new();
        };
        let window_ids: Vec<String> = registry
            .snapshot()
            .into_iter()
            .filter(|row| matches!(row.kind, WindowKind::Terminal) && !row.control)
            .map(|row| row.window_id)
            .collect();
        let mut removed = Vec::new();
        for window_id in window_ids {
            if registry.remove_terminal(&window_id) {
                let reaped = self.reap_discarded_window_state(&window_id);
                self.notify_window_change();
                removed.push(format!(
                    "window {window_id}: removed terminal window after fdstore metadata loss (reaped {reaped} session(s))"
                ));
            }
        }
        removed
    }

    /// Whether `accept` matches SOME live tenant's bearer token (workspace,
    /// terminal, or control tenant -- every tenant carries its mint token in its
    /// `ServeHandle`). The caller supplies the comparison so the constant-time
    /// primitive stays in chan-server (where the launcher gate lives) and no
    /// token is cloned out of the host. Used by the local-color routes to admit
    /// a window's OWN per-tenant token (not just the launcher token) -- a window
    /// is served with its tenant token, so a launcher-only gate would 401 every
    /// window's colour GET/PUT/watch.
    pub fn any_tenant_token(&self, accept: impl Fn(&str) -> bool) -> bool {
        let Ok(workspaces) = self.workspaces.read() else {
            return false;
        };
        workspaces
            .values()
            .filter_map(|runtime| runtime.handle.token.as_deref())
            .any(accept)
    }

    /// True when the named tenant currently has a `/ws` presence for
    /// `window_id`. This is the liveness half of the browser command-launcher
    /// capability binding: a scoped capability dies with its invoking window
    /// instead of becoming a reusable library credential.
    pub fn tenant_has_live_window(&self, prefix: &str, window_id: &str) -> bool {
        let Ok(prefix) = sanitize_prefix(prefix) else {
            return false;
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return false;
        };
        workspaces.get(&prefix).is_some_and(|runtime| {
            runtime
                .artifacts
                .window_presence
                .connected_ids()
                .iter()
                .any(|id| id == window_id)
        })
    }

    /// Token-authenticated form of [`tenant_has_live_window`](Self::tenant_has_live_window).
    /// The token never leaves the host; chan-server supplies its constant-time
    /// comparator. Requiring the same tenant to satisfy BOTH token and presence
    /// prevents a valid token for workspace A from minting a capability bound
    /// to a live window in workspace B.
    pub fn tenant_token_has_live_window(
        &self,
        prefix: &str,
        window_id: &str,
        accept: impl Fn(&str) -> bool,
    ) -> bool {
        let Ok(prefix) = sanitize_prefix(prefix) else {
            return false;
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return false;
        };
        workspaces.get(&prefix).is_some_and(|runtime| {
            runtime.handle.token.as_deref().is_some_and(accept)
                && runtime
                    .artifacts
                    .window_presence
                    .connected_ids()
                    .iter()
                    .any(|id| id == window_id)
        })
    }

    /// Test-only stand-in for the tenant `/ws` guard. Route tests use this to
    /// prove that scoped browser authority is born and revoked with one live
    /// invoking window without opening a real network listener.
    #[cfg(any(test, feature = "test-util"))]
    pub fn test_connect_window_presence(
        &self,
        prefix: &str,
        window_id: &str,
    ) -> Option<crate::window_presence::PresenceGuard> {
        let prefix = sanitize_prefix(prefix).ok()?;
        let workspaces = self.workspaces.read().ok()?;
        Some(
            workspaces
                .get(&prefix)?
                .artifacts
                .window_presence
                .connect(window_id),
        )
    }

    /// Whether a persisted window row appears in the LIVE window feed. A workspace
    /// window shows only while its workspace is currently MOUNTED/ON: turning the
    /// workspace OFF leaves the record on disk (so ON restores the same
    /// windows/panes/tabs) but hides it from the live Open-windows, so an off
    /// workspace never shows ghost windows. A terminal window is never
    /// workspace-gated; a workspace row missing its path is included defensively.
    fn window_in_live_feed(&self, row: &PersistedWindow) -> bool {
        match (row.kind, row.workspace_path.as_deref()) {
            (WindowKind::Workspace, Some(path)) => self.is_root_mounted(Path::new(path)),
            _ => true,
        }
    }

    /// The full library window set: the records the launcher, `cs window list`,
    /// and the desktop watcher reconcile to. Joins each persisted registry row
    /// with its serving tenant's live state (prefix/token/`connected`), and
    /// includes a workspace window only while its workspace is mounted (an off
    /// workspace's records are filtered out -- preserved on disk, hidden from the
    /// live feed; see `window_in_live_feed`). Empty
    /// when no registry is installed (a host that never opened one has no windows).
    pub fn assemble_window_records(&self) -> Vec<WindowRecord> {
        let Some(registry) = self.window_registry() else {
            // No local registry installed: still surface a connected devserver's
            // windows, so a desktop holding only remote connections lists them.
            return self
                .devserver_feed()
                .map(|feed| feed.windows())
                .unwrap_or_default();
        };
        let library_id = self.library_id();
        let mut records: Vec<WindowRecord> = registry
            .snapshot()
            .into_iter()
            // An OFF workspace's window records stay on disk (so turning it back
            // ON restores them) but are filtered OUT of the live feed -- they must
            // not show as ghosts pointing at an unmounted workspace.
            .filter(|row| self.window_in_live_feed(row))
            .map(|row| {
                let (prefix, token, connected) = self.window_live_state(&row);
                // Overlay the volatile transfer bit from the serving tenant: the
                // remote feed is the only channel a desktop webview onto a
                // devserver has to learn a window is mid-transfer.
                let active_transfer = self.tenant_has_active_transfer(&prefix, &row.window_id);
                // A control row carries a FOREIGN library_id (the devserver it
                // groups under); every other row belongs to this host's library.
                let row_library_id = row
                    .library_id
                    .clone()
                    .unwrap_or_else(|| library_id.to_string());
                let mut record = row.to_record(row_library_id, prefix, token, connected);
                record.active_transfer = active_transfer;
                record
            })
            .collect();
        // Append connected devservers' windows after the local set. Each record
        // carries its own remote `library_id`, so the desktop groups them under
        // the right per-library window-menu section.
        if let Some(feed) = self.devserver_feed() {
            records.extend(feed.windows());
        }
        records
    }

    /// The leader window_id of the tenant that governs an operation on `kind` /
    /// `workspace_path` (mint, discard, visibility), or `None` when that tenant
    /// is unmounted or currently leaderless. A workspace resolves to its mounted
    /// tenant by canonical root; a terminal resolves to the shared terminal
    /// tenant. Honest-client input only: the leader gate compares a CLAIMED
    /// acting window_id against this and is not a security boundary (every window
    /// of a tenant shares the one tenant token, and the mint route sits behind
    /// the shared launcher bearer), so it double-enforces a UI affordance rather
    /// than proving identity.
    pub fn tenant_leader(&self, kind: WindowKind, workspace_path: Option<&str>) -> Option<String> {
        let workspaces = self.workspaces.read().ok()?;
        let runtime = match kind {
            WindowKind::Terminal => workspaces.get(self.terminal_tenant_prefix.get()?)?,
            WindowKind::Workspace => {
                let target = canonical_key(Path::new(workspace_path?));
                workspaces
                    .values()
                    .find(|runtime| canonical_key(&runtime.root) == target)?
            }
        };
        runtime.artifacts.session_registry.leader()
    }

    /// The per-tenant leaders map the window watch feed publishes: tenant route
    /// `prefix` -> that tenant's leader window_id, for every mounted tenant with
    /// a live leader. Keyed by prefix (the value on each [`WindowRecord::prefix`])
    /// so a launcher correlates `leaders[record.prefix]`; leaderless or unmounted
    /// tenants are simply absent.
    pub fn tenant_leaders(&self) -> BTreeMap<String, String> {
        let mut leaders = BTreeMap::new();
        if let Ok(workspaces) = self.workspaces.read() {
            for (prefix, runtime) in workspaces.iter() {
                if let Some(leader) = runtime.artifacts.session_registry.leader() {
                    leaders.insert(prefix.clone(), leader);
                }
            }
        }
        leaders
    }

    /// The leader window_id of the tenant that governs the EXISTING window
    /// `window_id` (the discard / visibility gate), or `None` when the window is
    /// unknown, its tenant is unmounted, or the tenant is leaderless. Resolves the
    /// window's registry row to its kind + workspace path, then reuses
    /// [`tenant_leader`](Self::tenant_leader). Same honest-client caveat.
    pub fn window_tenant_leader(&self, window_id: &str) -> Option<String> {
        let row = self
            .window_registry()?
            .snapshot()
            .into_iter()
            .find(|w| w.window_id == window_id)?;
        self.tenant_leader(row.kind, row.workspace_path.as_deref())
    }

    /// Mint a NATIVE window: persist a new registry row and return its assembled
    /// [`WindowRecord`] (the same shape the feed serves, so a `POST` handler
    /// returns it directly). The registry's create fires the watch via the
    /// bridge; this also fires it directly so the push does not hinge on the
    /// bridge task's scheduling. The tenant side ensures a serving tenant exists
    /// for the new window. The desktop and CLI mint through here; the launcher's
    /// browser mint uses [`Self::mint_window_with_origin`].
    pub fn mint_window(
        &self,
        kind: WindowKind,
        workspace_path: Option<String>,
    ) -> Result<WindowRecord, Error> {
        self.mint_window_with_origin(kind, workspace_path, WindowOrigin::Native)
    }

    /// Mint a window with an explicit client `origin` (stamped at creation).
    /// A `browser` origin marks a browser-tab mint that chan-desktop must not
    /// reconcile into a native twin. Otherwise identical to [`Self::mint_window`].
    pub fn mint_window_with_origin(
        &self,
        kind: WindowKind,
        workspace_path: Option<String>,
        origin: WindowOrigin,
    ) -> Result<WindowRecord, Error> {
        let registry = self
            .window_registry()
            .ok_or_else(|| Error::Config("window registry not installed".into()))?;
        let row = registry.create_with_origin(kind, workspace_path, origin);
        // A Terminal window's session lives in the shared terminal tenant and is
        // auto-opened by the watcher, so the SPA never PUTs a layout blob to
        // persist it -- without a durable blob it would be orphan-reaped on the
        // first client disconnect (the window shows but loses its session on
        // reconnect). Mark every Terminal window persisted in the shared terminal
        // tenant so the pruner spares its session -- uniformly across libraries
        // (local and devserver both mount the shared terminal tenant). A no-op
        // until that tenant is mounted (its prefix OnceLock is still unset). A
        // workspace window persists through its own workspace tenant's PUT, not
        // here.
        if matches!(row.kind, WindowKind::Terminal) {
            self.persist_terminal_window(&row.window_id);
        }
        self.notify_window_change();
        let library_id = self.library_id().to_string();
        let (prefix, token, connected) = self.window_live_state(&row);
        Ok(row.to_record(library_id, prefix, token, connected))
    }

    /// Mint a devserver CONTROL terminal as a real registry row:
    /// `kind = Terminal`, `control = true`, tagged with the FOREIGN devserver
    /// `library_id` so it GROUPS under that devserver, but its session is the
    /// LOCAL command tenant at `control_tenant_prefix` (the connect script). The
    /// desktop supplies `window_id` (the stable native control-window label) so
    /// the launcher hide/open resolves to the live window. Records the
    /// window_id → local-prefix mapping so assembly resolves its live
    /// `(prefix, token, connected)` from that tenant. Returns the assembled
    /// record; reaped by [`reap_control_window`](Self::reap_control_window).
    pub fn mint_control_window(
        &self,
        window_id: String,
        devserver_library_id: String,
        control_tenant_prefix: String,
    ) -> Result<WindowRecord, Error> {
        let registry = self
            .window_registry()
            .ok_or_else(|| Error::Config("window registry not installed".into()))?;
        let row = registry.create_control(window_id.clone(), devserver_library_id.clone());
        if let Ok(mut map) = self.control_tenants.write() {
            map.insert(window_id.clone(), control_tenant_prefix);
        }
        self.notify_window_change();
        let (prefix, token, connected) = self.control_window_live(&window_id);
        Ok(row.to_record(devserver_library_id, prefix, token, connected))
    }

    /// Set a window's persisted visibility: `hidden=true` buries it,
    /// `false` un-buries. The devserver is the source of truth, so a desktop
    /// connect mirrors the saved layout. Returns whether a row matched (a route
    /// maps `false` to 404). Works on any registry row incl. the control row
    /// (its hidden is in-memory/per-connection, like the row itself). The
    /// registry fires the feed notify on a real change.
    pub fn set_window_hidden(&self, window_id: &str, hidden: bool) -> Result<bool, Error> {
        let registry = self
            .window_registry()
            .ok_or_else(|| Error::Config("window registry not installed".into()))?;
        let matched = registry.set_hidden(window_id, hidden);
        // Tell the affected window's socket it was hidden by the leader. Only on
        // a hide: un-hiding brings the window back, so it is not a teardown.
        // Idempotent-safe on a re-hide (a follower just re-shows the overlay).
        if matched && hidden {
            self.emit_window_teardown(window_id, "window_hidden");
        }
        Ok(matched)
    }

    /// Set the separately persisted user caption for one local window. The
    /// route validates that the row is a workspace window and normalizes the
    /// text before this storage operation. Returns false when this host does not
    /// own the row (the desktop route then forwards it to a connected
    /// devserver).
    pub fn set_window_label(&self, window_id: &str, label: String) -> Result<bool, Error> {
        let registry = self
            .window_registry()
            .ok_or_else(|| Error::Config("window registry not installed".into()))?;
        let matched = registry.set_label(window_id, label.clone());
        // The window's own SPA titles its browser tab from this text, and it has
        // no view of the window feed (its library access is the short-lived
        // command capability), so tell it directly. Native desktop windows are
        // retitled by the window watcher's reconcile instead and ignore this.
        if matched {
            self.emit_window_command(window_id, "window_labeled", Some(&label));
        }
        Ok(matched)
    }

    /// Reap a control terminal: drop its registry row, forget its tenant
    /// mapping, and tear down its LOCAL command tenant (kills the connect-script
    /// PTY). The registry remove + `close_terminal_tenant` each fire the change
    /// notify, so the feed drops the row. Returns whether a row existed. Called
    /// on control PTY exit (the server-side reap) and on explicit
    /// disconnect/forget; idempotent.
    pub async fn reap_control_window(&self, window_id: &str) -> bool {
        let prefix = self
            .control_tenants
            .write()
            .ok()
            .and_then(|mut map| map.remove(window_id));
        let removed = self
            .window_registry()
            .map(|registry| registry.remove(window_id))
            .unwrap_or(false);
        if let Some(prefix) = prefix {
            // Best-effort: an already-unmounted tenant returns Ok(false).
            let _ = self.close_terminal_tenant(&prefix).await;
        }
        removed
    }

    /// The library's first-open rule: mint EXACTLY ONE Terminal window the very
    /// first time a library is opened with an empty window registry, then record
    /// it so it never happens again. Returns the minted record, or `None` when
    /// nothing was minted (the registry already has windows, the first-open
    /// marker is already set, or no registry is installed).
    ///
    /// Both the desktop local boot and the headless `run_devserver` open path
    /// route through here, so "opening a chan-library spawns one terminal" is a
    /// property of the library, identical local and remote. Behavior 2 (the user
    /// closes the only terminal, then closes + reopens the library → no terminal)
    /// falls out: once the marker is set, an emptied registry never re-mints. The
    /// marker is persisted BEFORE returning so a crash right after the mint
    /// cannot mint a second terminal on the next boot.
    pub fn ensure_first_open_terminal(&self) -> Result<Option<WindowRecord>, Error> {
        let Some(registry) = self.window_registry() else {
            return Ok(None);
        };
        // The marker is the one-shot floor: once set, an emptied registry never
        // re-mints. The empty check spares a fresh library that already restored
        // persisted windows (a workspace turned on at boot) an extra terminal.
        if registry.first_open_done() || !registry.is_empty() {
            return Ok(None);
        }
        let record = self.mint_window(WindowKind::Terminal, None)?;
        registry.mark_first_open_done();
        Ok(Some(record))
    }

    /// Mark a Terminal `window_id` persisted in the SHARED terminal tenant (its
    /// serving tenant), so the orphan-grace pruner spares its session and it
    /// survives a client disconnect+reconnect with its state. Applies to every
    /// library (local and devserver alike); a no-op until the shared terminal
    /// tenant is mounted (both the desktop boot and `run_devserver` mount it at
    /// startup, before any terminal window is minted, so the prefix is set by
    /// then).
    fn persist_terminal_window(&self, window_id: &str) {
        let Some(prefix) = self.terminal_tenant_prefix.get() else {
            return;
        };
        if let Ok(workspaces) = self.workspaces.read() {
            if let Some(runtime) = workspaces.get(prefix) {
                runtime
                    .artifacts
                    .terminal_sessions
                    .mark_window_persisted(window_id);
            }
        }
    }

    /// Open an absolute path that lies OUTSIDE the calling workspace, in a
    /// standalone window of this host. The workspace tenant routes here instead
    /// of refusing; the path is resolved by the tenant that mounted a
    /// filesystem, never here.
    ///
    /// Reuses a live standalone window when there is one and mints one when
    /// there is not, so a loop of opens lands in one window rather than a
    /// window each. A minted window has no socket yet, so its frame is parked
    /// for its first `/ws` attach.
    ///
    /// Lock discipline: every step that follows takes `self.workspaces` again
    /// (window assembly, the mint's persist), so the surface handles are cloned
    /// out and the read guard is dropped before anything else runs. Holding it
    /// across those calls deadlocks against a queued writer from
    /// `open_workspace` / `close_workspace`.
    pub async fn open_outside_workspace(
        &self,
        requested: &Path,
        caller_window_id: &str,
    ) -> Result<OpenOutsideAck, Error> {
        let (files, pending, session_registry, events_tx) =
            {
                let prefix = self.terminal_tenant_prefix.get().ok_or_else(|| {
                    Error::Config("this host serves no standalone filesystem".into())
                })?;
                let workspaces = self
                    .workspaces
                    .read()
                    .map_err(|_| Error::Config("workspace map poisoned".into()))?;
                let runtime = workspaces.get(prefix).ok_or_else(|| {
                    Error::Config("this host serves no standalone filesystem".into())
                })?;
                let files = runtime.artifacts.standalone_files.clone().ok_or_else(|| {
                    Error::Config("this host serves no standalone filesystem".into())
                })?;
                (
                    files,
                    runtime.artifacts.pending_window_commands.clone(),
                    runtime.artifacts.session_registry.clone(),
                    runtime.artifacts.events_tx.clone(),
                )
            };

        // A minted window is created by the surface that asked for it: a
        // browser-origin caller gets a browser-origin row, which the desktop
        // watcher deliberately never opens a native twin for, and which the
        // calling page opens as a tab -- the browser's equivalent of a window.
        // A native caller gets a native row, which the watcher opens for it.
        let caller_origin = self
            .assemble_window_records()
            .into_iter()
            .find(|row| row.window_id == caller_window_id)
            .map(|row| row.origin)
            .unwrap_or_default();
        let (window_id, minted, browser_target) = match self.select_standalone_window() {
            Some(id) => (id, false, None),
            None => {
                let record =
                    self.mint_window_with_origin(WindowKind::Terminal, None, caller_origin)?;
                // The window seeds no default terminal: its content is the
                // frame parked below, arriving on its first `/ws` attach.
                pending.mark_routed(&record.window_id);
                let target = (!caller_origin.is_native()).then(|| BrowserWindowTarget {
                    prefix: record.prefix.clone(),
                    token: record.token.clone(),
                });
                (record.window_id, true, target)
            }
        };
        self.remember_routed_standalone(&window_id);
        let open = files
            .open_frame(&window_id, requested)
            .map_err(Error::BadRequest)?;

        // Deliver to a live window, or park for the one that is opening. The
        // re-check after the park closes the window between the liveness test
        // and the park, where an attach could drain an empty map and then miss
        // the frame.
        let delivered = session_registry
            .dispatch_if_live(&window_id, || events_tx.send(open.frame.clone()))
            .is_some();
        if !delivered {
            pending
                .park(&window_id, open.frame.clone())
                .map_err(Error::BadRequest)?;
            if session_registry
                .dispatch_if_live(&window_id, || events_tx.send(open.frame.clone()))
                .is_some()
            {
                let _ = pending.take(&window_id);
            }
        }

        // Best effort: raise the window that now holds the file. A window the
        // desktop has not opened yet, or no desktop at all, simply stays where
        // it is.
        let _ = self
            .desktop
            .dispatch(|reply| crate::desktop_window_ops::DesktopWindowOp::Open {
                id: window_id.clone(),
                reply,
            })
            .await;

        Ok(OpenOutsideAck {
            path: open.path,
            window_id,
            minted,
            inside_workspace: self.workspace_containing(requested),
            open_in_browser: browser_target,
        })
    }

    /// The standalone window an escaping open should land in: this library's
    /// own (never a connected devserver's, whose rows ride the same feed), not
    /// a control terminal, not hidden. `None` mints.
    ///
    /// The window this host last routed to wins even while it is still
    /// OPENING, which is what keeps `for f in *; do cs open "$f"; done` in one
    /// window: the second call arrives long before the first window's webview
    /// connects, and a liveness-only rule would mint a window per file.
    /// Otherwise the lowest-ordinal connected window takes it, so repeated
    /// opens keep landing in the same place.
    fn select_standalone_window(&self) -> Option<String> {
        let rows: Vec<WindowRecord> = self
            .assemble_window_records()
            .into_iter()
            .filter(|row| {
                row.library_id == self.library_id()
                    && matches!(row.kind, WindowKind::Terminal)
                    && !row.control
                    && !row.hidden
            })
            .collect();
        let sticky = self
            .last_routed_standalone
            .lock()
            .ok()
            .and_then(|last| last.clone());
        if let Some(sticky) = sticky {
            if rows.iter().any(|row| row.window_id == sticky) {
                return Some(sticky);
            }
        }
        let mut connected: Vec<WindowRecord> =
            rows.into_iter().filter(|row| row.connected).collect();
        connected.sort_by_key(|row| row.ordinal);
        connected.into_iter().next().map(|row| row.window_id)
    }

    /// Remember the window an escaping open just went to, so the opens that
    /// follow it land there too. Cleared implicitly: a window that leaves the
    /// registry stops matching and the next open picks again.
    /// Whether this window was minted by a routed `cs open` and has not yet
    /// been handed its frame, so the surface opening it should not seed a
    /// default terminal. False for every window on a host that serves no
    /// standalone filesystem, and false again once the frame is drained or
    /// expires.
    pub fn is_routed_mint(&self, window_id: &str) -> bool {
        let Some(prefix) = self.terminal_tenant_prefix.get() else {
            return false;
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return false;
        };
        workspaces
            .get(prefix)
            .map(|runtime| {
                runtime
                    .artifacts
                    .pending_window_commands
                    .is_routed(window_id)
            })
            .unwrap_or(false)
    }

    fn remember_routed_standalone(&self, window_id: &str) {
        if let Ok(mut last) = self.last_routed_standalone.lock() {
            *last = Some(window_id.to_string());
        }
    }

    /// The registered workspace whose root contains `path`, if any. Named in
    /// the acknowledgement so a user opening a file that belongs to another
    /// workspace learns an indexed view of it exists; the open still lands on
    /// the machine surface, which is the one that can show any path at all.
    fn workspace_containing(&self, path: &Path) -> Option<String> {
        let canonical = path.canonicalize().ok()?;
        self.library
            .list_workspaces()
            .into_iter()
            .filter(|known| {
                known
                    .root_path
                    .canonicalize()
                    .is_ok_and(|root| canonical.starts_with(root))
            })
            // Longest root wins: nested workspaces resolve to the innermost.
            .max_by_key(|known| known.root_path.as_os_str().len())
            .map(|known| {
                known.display_name.clone().unwrap_or_else(|| {
                    known
                        .root_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| known.root_path.to_string_lossy().into_owned())
                })
            })
    }

    /// Discard a window: drop its registry row, reap its terminal sessions, and
    /// fire the watch. Returns whether a row existed (a `DELETE` handler maps
    /// `false` to 404). Reaping on discard frees the fds a busy detached session
    /// would otherwise keep alive. A terminal window's sessions reap once terminal
    /// tenant wiring is present; until then only that tenant is absent, so the reap
    /// is simply a no-op for terminal windows (workspace windows reap their panes
    /// today).
    pub fn discard_window(&self, window_id: &str) -> Result<bool, Error> {
        let registry = self
            .window_registry()
            .ok_or_else(|| Error::Config("window registry not installed".into()))?;
        let removed = registry.remove(window_id);
        if removed {
            self.reap_discarded_window_state(window_id);
            // The record is gone but the window's `/ws` socket outlives it, so
            // tell that socket its window was discarded (a browser follower shows
            // the leader-close overlay; a native window is reconciled away).
            self.emit_window_teardown(window_id, "window_discarded");
            self.notify_window_change();
        }
        Ok(removed)
    }

    /// Broadcast a targeted teardown frame for `window_id`. See
    /// [`Self::emit_window_command`] for the delivery model.
    fn emit_window_teardown(&self, window_id: &str, command: &'static str) {
        self.emit_window_command(window_id, command, None);
    }

    /// Broadcast a targeted `window_command` frame (see
    /// [`window_command_frame`]) for `window_id`. It rides EVERY mounted
    /// tenant's `/ws` channel; each tenant's pump forwards it only to the socket
    /// serving `window_id` and drops it otherwise, so a browser follower hears
    /// about its own window without the host resolving which tenant serves it
    /// (which matters for a discard, where the record is already gone). This is
    /// honest-client courtesy, not enforcement: a native desktop window is torn
    /// down (and retitled) by the window watcher's reconcile instead and ignores
    /// the frame.
    fn emit_window_command(&self, window_id: &str, command: &'static str, label: Option<&str>) {
        let Some(frame) = window_command_frame(window_id, command, label) else {
            return;
        };
        if let Ok(workspaces) = self.workspaces.read() {
            for runtime in workspaces.values() {
                let _ = runtime.artifacts.events_tx.send(frame.clone());
            }
        }
    }

    /// Discard every persisted window rooted at `root` -- a workspace turned OFF
    /// or FORGOTTEN must not leave ghost windows in the launcher feed (the windows
    /// persist in the registry, so without this they survive the unmount and, on a
    /// devserver, a disconnect→reconnect). Matches a window's `workspace_path` to
    /// `root` by canonical form (the same join [`assemble_window_records`](
    /// Self::assemble_window_records) uses), discarding each via
    /// [`discard_window`](Self::discard_window) so its tenant state is reaped too.
    /// Returns the count discarded; a no-op with no registry or no match. Fires
    /// only on explicit off/forget (via [`close_workspace`](Self::close_workspace)
    /// / [`remove_workspace_for_root`](Self::remove_workspace_for_root)), NOT on
    /// host shutdown (which drops runtimes without closing), so windows still
    /// restore across a restart.
    pub fn discard_workspace_windows(&self, root: &Path) -> usize {
        let Some(registry) = self.window_registry() else {
            return 0;
        };
        let target = canonical_key(root);
        let ids: Vec<String> = registry
            .snapshot()
            .into_iter()
            .filter(|row| {
                row.workspace_path
                    .as_deref()
                    .is_some_and(|p| canonical_key(Path::new(p)) == target)
            })
            .map(|row| row.window_id)
            .collect();
        for id in &ids {
            let _ = self.discard_window(id);
        }
        ids.len()
    }

    /// Reap all state a discarded `window_id` owns across mounted tenants, so a
    /// registry discard is the SINGLE authoritative cleanup -- even a non-SPA
    /// discard (cs-driven, a watcher reconcile, a crashed client) that never
    /// sends the SPA `DELETE /api/session`: the terminal sessions (PTYs + fds)
    /// AND the durable workspace session/layout blob
    /// (`<chan_home>/workspaces/<metadata_key>/sessions/<id>`) AND the standalone terminal window's
    /// layout blob (the chan-server `terminal_blob`, reached via the host-
    /// installed `BlobReaper` hook). The id is library-unique, so only its owning
    /// tenant has anything; the rest are no-ops. Handles are cloned out under the
    /// lock and the reap/delete run after releasing it, so the blocking I/O never
    /// stalls a concurrent tenant mount/unmount. Returns the session count reaped.
    fn reap_discarded_window_state(&self, window_id: &str) -> usize {
        let (registries, workspaces) = {
            let tenants = match self.workspaces.read() {
                Ok(tenants) => tenants,
                Err(_) => return 0,
            };
            let registries: Vec<_> = tenants
                .values()
                .map(|runtime| runtime.artifacts.terminal_sessions.clone())
                .collect();
            let workspaces: Vec<_> = tenants
                .values()
                .filter_map(|runtime| runtime.artifacts.cell.workspace())
                .collect();
            (registries, workspaces)
        };
        let reaped = registries
            .iter()
            .map(|sessions| {
                // Drop this window's durable terminal layout blob too (the
                // chan-server `terminal_blob`, reachable only via the installed
                // hook); a no-op on tenants without one.
                sessions.reap_window_layout(window_id);
                sessions.forget_window(window_id)
            })
            .sum();
        // Delete the durable workspace session/layout blob too (best-effort; a
        // no-op when this window has none), so a non-SPA discard never orphans
        // `<chan_home>/workspaces/<metadata_key>/sessions/<id>`.
        for workspace in workspaces {
            let _ = workspace.delete_session(window_id);
        }
        reaped
    }

    /// Total LIVE terminal sessions owned by `window_id` across this host's
    /// mounted tenants. The read-only basis for the `cs window rm` `--force`
    /// guard; mirrors the tenant iteration in [`reap_discarded_window_state`](
    /// Self::reap_discarded_window_state) but counts instead of reaping.
    pub fn live_terminal_count(&self, window_id: &str) -> usize {
        let registries: Vec<_> = {
            let Ok(tenants) = self.workspaces.read() else {
                return 0;
            };
            tenants
                .values()
                .map(|runtime| runtime.artifacts.terminal_sessions.clone())
                .collect()
        };
        registries
            .iter()
            .map(|sessions| sessions.count_for_window(window_id))
            .sum()
    }

    /// Resolve a persisted window's live `(prefix, token, connected)` from its
    /// serving tenant. A terminal window resolves to the library's shared
    /// terminal tenant (via [`terminal_window_live`](Self::terminal_window_live)),
    /// a workspace window through
    /// [`workspace_window_live`](Self::workspace_window_live).
    fn window_live_state(&self, row: &PersistedWindow) -> (String, String, bool) {
        // A control row's session is its OWN command tenant, not the shared
        // terminal tenant -- resolve it through the control-tenant map. (`kind` is
        // still Terminal, so this must precede the kind match.)
        if row.control {
            return self.control_window_live(&row.window_id);
        }
        match row.kind {
            WindowKind::Workspace => {
                self.workspace_window_live(row.workspace_path.as_deref(), &row.window_id)
            }
            WindowKind::Terminal => self.terminal_window_live(&row.window_id),
        }
    }

    /// The `(prefix, token, connected)` for a devserver CONTROL window: its LOCAL
    /// command tenant (the connect script), looked up by the window_id → prefix
    /// map [`mint_control_window`](Self::mint_control_window) populated. Mirrors
    /// [`terminal_window_live`](Self::terminal_window_live) but per-control-tenant
    /// (each control window has its own tenant, vs the one shared terminal
    /// tenant). Empty when the mapping or tenant is gone (e.g. mid-reap).
    fn control_window_live(&self, window_id: &str) -> (String, String, bool) {
        let Some(prefix) = self
            .control_tenants
            .read()
            .ok()
            .and_then(|map| map.get(window_id).cloned())
        else {
            return (String::new(), String::new(), false);
        };
        if let Ok(workspaces) = self.workspaces.read() {
            if let Some(runtime) = workspaces.get(&prefix) {
                let connected = runtime
                    .artifacts
                    .window_presence
                    .connected_ids()
                    .iter()
                    .any(|id| id == window_id);
                return (
                    runtime.handle.prefix.clone(),
                    runtime.handle.token.clone().unwrap_or_default(),
                    connected,
                );
            }
        }
        (String::new(), String::new(), false)
    }

    /// The `(prefix, token, connected)` for a terminal window: the library's
    /// shared terminal tenant, once mounted. Every terminal window attaches to
    /// the one tenant, so they all share its prefix+token; `connected` reflects
    /// this `window_id`'s live `/ws` presence. Empty until the tenant is mounted
    /// -- boot ordering mounts it before the watcher reconciles persisted
    /// terminal windows, so they resolve and reopen on relaunch.
    fn terminal_window_live(&self, window_id: &str) -> (String, String, bool) {
        let Some(prefix) = self.terminal_tenant_prefix.get() else {
            return (String::new(), String::new(), false);
        };
        if let Ok(workspaces) = self.workspaces.read() {
            if let Some(runtime) = workspaces.get(prefix) {
                let connected = runtime
                    .artifacts
                    .window_presence
                    .connected_ids()
                    .iter()
                    .any(|id| id == window_id);
                return (
                    runtime.handle.prefix.clone(),
                    runtime.handle.token.clone().unwrap_or_default(),
                    connected,
                );
            }
        }
        (String::new(), String::new(), false)
    }

    /// The `(prefix, token, connected)` for a workspace window. A mounted
    /// workspace carries its live tenant's prefix and token plus the window's
    /// `/ws` presence; an off workspace carries its stable derived prefix with
    /// no token, since the client turns it on before attaching.
    fn workspace_window_live(
        &self,
        workspace_path: Option<&str>,
        window_id: &str,
    ) -> (String, String, bool) {
        let Some(path) = workspace_path else {
            return (String::new(), String::new(), false);
        };
        let path = Path::new(path);
        let target = canonical_key(path);
        if let Ok(workspaces) = self.workspaces.read() {
            if let Some(runtime) = workspaces
                .values()
                .find(|runtime| canonical_key(&runtime.root) == target)
            {
                let connected = runtime
                    .artifacts
                    .window_presence
                    .connected_ids()
                    .iter()
                    .any(|id| id == window_id);
                return (
                    runtime.handle.prefix.clone(),
                    runtime.handle.token.clone().unwrap_or_default(),
                    connected,
                );
            }
        }
        let prefix = allocate_workspace_prefix(path).unwrap_or_default();
        (prefix, String::new(), false)
    }

    /// Raw replay-ring PTY bytes for the terminal tenant mounted at
    /// `prefix` (empty when none is mounted there). Reaches into that
    /// tenant's terminal registry like [`tenant_has_window_sessions`](
    /// Self::tenant_has_window_sessions). Lets a desktop read a CONTROL
    /// TERMINAL's output to scrape a token a connect script printed, in the
    /// case where that output never reaches the desktop another way.
    pub fn terminal_tenant_scrollback(&self, prefix: &str) -> Vec<u8> {
        let Ok(prefix) = sanitize_prefix(prefix) else {
            return Vec::new();
        };
        let Ok(workspaces) = self.workspaces.read() else {
            return Vec::new();
        };
        workspaces
            .get(&prefix)
            .map(|runtime| runtime.artifacts.terminal_sessions.all_scrollback())
            .unwrap_or_default()
    }

    /// The exit state of the terminal tenant (mounted at `prefix`)'s connect
    /// script once its PTY has exited, or `None` while it runs / when no tenant
    /// is mounted there. Sibling to [`terminal_tenant_scrollback`](
    /// Self::terminal_tenant_scrollback): the desktop polls BOTH while scraping
    /// a control terminal -- a token in the scrollback means connected, a
    /// `Some(exit)` here means the script died, so the scrape can stop at once
    /// (instead of waiting out the full timeout) and a tab closed mid-connect
    /// can survey on a real failure instead of stranding an empty window.
    pub fn terminal_tenant_last_exit(&self, prefix: &str) -> Option<TerminalExit> {
        let prefix = sanitize_prefix(prefix).ok()?;
        let workspaces = self.workspaces.read().ok()?;
        workspaces
            .get(&prefix)
            .and_then(|runtime| runtime.artifacts.terminal_sessions.last_exit())
    }

    /// Close the mounted workspace whose root matches `root` (by canonical
    /// form), returning a typed lifecycle outcome. The control-socket `Close`
    /// handler uses this to unmount a single hosted tenant by path without
    /// disturbing the rest of the host. A terminal tenant (no workspace root)
    /// never matches a real workspace root.
    ///
    /// On a successful unmount it also records the workspace OFF in the on/off
    /// overlay, so a devserver restart (which re-mounts from the overlay) does
    /// not bring a just-closed workspace back up. The launcher's in-memory view
    /// already reflects the unmount; this persists it.
    pub async fn close_workspace_for_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        self.close_workspace_for_root_impl(root, force, true).await
    }

    /// Shutdown-flavored close: unmount the workspace at `root` WITHOUT recording
    /// it off in the on/off overlay. The desired-state overlay must survive
    /// teardown so the next boot restores the same on-set. The process-shutdown
    /// paths (the desktop Exit handler and the panic-unwind `Drop`) snapshot the
    /// on-set first, then close every mounted workspace this way, so a slow
    /// per-workspace teardown racing process death can never flip a workspace off
    /// for the next boot. Every other close is genuine user intent and records
    /// off through [`close_workspace_for_root`](Self::close_workspace_for_root).
    pub async fn close_workspace_for_root_preserving_overlay(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        self.close_workspace_for_root_impl(root, force, false).await
    }

    /// Shared body for the close-by-root variants. `record_off` gates the off
    /// write to the on/off overlay: a user-intent close (`chan close`, the
    /// launcher off-toggle, the control-socket close) records off so a devserver
    /// restart does not bring the just-closed workspace back up; a shutdown close
    /// preserves the overlay so the next boot restores the same on-set.
    async fn close_workspace_for_root_impl(
        &self,
        root: &Path,
        force: bool,
        record_off: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        let _registering = self.register_lock.lock().await;
        self.close_workspace_for_root_locked(root, force, record_off)
            .await
    }

    /// Close-by-root body while [`register_lock`](Self::register_lock) is held.
    ///
    /// Serializing registration with teardown prevents a close from observing
    /// the gap after a mount starts but before its runtime enters `workspaces`.
    /// `remove_workspace_for_root` also calls this body under the same guard so
    /// unregister cannot race a workspace open.
    async fn close_workspace_for_root_locked(
        &self,
        root: &Path,
        force: bool,
        record_off: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        let target = canonical_key(root);
        let prefix = {
            let workspaces = self
                .workspaces
                .read()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            workspaces
                .values()
                .find(|runtime| canonical_key(&runtime.root) == target)
                .map(|runtime| runtime.handle.prefix.clone())
        };
        match prefix {
            Some(prefix) => {
                let outcome = self.close_workspace(&prefix, force).await?;
                if record_off && (outcome.completed() || outcome.not_found()) {
                    if let Some(overlay) = self.workspace_overlay() {
                        overlay.set(&target.to_string_lossy(), false);
                    }
                }
                Ok(outcome)
            }
            None => {
                let registered = self.library.workspace_paths_for(root).is_some();
                let starting = self
                    .mount_state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&target)
                    .is_some_and(|state| matches!(state, MountState::Starting));
                if record_off && registered {
                    if let Some(overlay) = self.workspace_overlay() {
                        overlay.set(&target.to_string_lossy(), false);
                    }
                }
                self.clear_workspace_lifecycle(root);
                if registered && starting {
                    Ok(WorkspaceLifecycleOutcome::Completed)
                } else {
                    Ok(WorkspaceLifecycleOutcome::NotFound)
                }
            }
        }
    }

    /// Remove the workspace at `root`: unmount it if mounted, UNREGISTER it from
    /// the host library, then forget it from the on/off overlay. The
    /// over-the-control-socket equivalent of the launcher's `DELETE
    /// /api/library/workspaces/{id}` (`handle_remove_workspace`), so `chan close
    /// --remove` / `chan workspace rm` of a workspace this host serves removes
    /// it everywhere -- not just from the caller's local `config.toml`. Runs in
    /// the host process so the host's in-memory library + the persisted overlay
    /// stay consistent (a CLI-side `config.toml` edit alone would leave them
    /// stale, so the workspace lingers in the launcher and survives a restart).
    pub async fn remove_workspace_for_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        let _registering = self.register_lock.lock().await;
        let target = canonical_key(root);
        // Unmount first (releases the per-workspace flock before the unregister's
        // reset); a no-op when the workspace is registered-but-off or not held
        // here. Refusal leaves the runtime, registry, overlay, and windows intact.
        match self
            .close_workspace_for_root_locked(root, force, true)
            .await?
        {
            WorkspaceLifecycleOutcome::Refused { active_terminals } => {
                return Ok(WorkspaceLifecycleOutcome::Refused { active_terminals });
            }
            WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound => {}
        }

        self.mark_mount_removing(root);
        let removed = self.library().unregister_workspace(root)?;
        // Forget the on/off state so a devserver restart doesn't re-mount it.
        if let Some(overlay) = self.workspace_overlay() {
            overlay.forget(&target.to_string_lossy());
        }
        // FORGET is the ONLY path that purges the window records: the workspace is
        // gone for good, so drop its layout too. (OFF, by contrast, just unmounts
        // and leaves the records -- filtered from the live feed until ON restores
        // them.) A no-op when the workspace had no windows.
        self.discard_workspace_windows(root);
        self.clear_mount_state(root);
        self.notify_window_change();
        if removed {
            Ok(WorkspaceLifecycleOutcome::Completed)
        } else {
            Ok(WorkspaceLifecycleOutcome::NotFound)
        }
    }

    /// Close the workspace mounted at `prefix`.
    ///
    /// Returns [`WorkspaceLifecycleOutcome::NotFound`] when no workspace is
    /// mounted there. With `force == false`, refuses before teardown when the
    /// tenant owns live terminal sessions. Closing sends the shared shutdown
    /// signal before dropping the runtime, so active WebSockets and terminal
    /// sessions get a clean exit path.
    ///
    /// This does not call the terminal registry's `close_all` directly: the
    /// per-tenant prune task closes it during the bounded joined shutdown. A
    /// terminal-only tenant whose PTY must receive its kill before that joined
    /// task runs -- a control terminal running a connect script -- should be
    /// closed with [`close_terminal_tenant`](Self::close_terminal_tenant).
    pub async fn close_workspace(
        &self,
        prefix: &str,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        let prefix = sanitize_prefix(prefix).map_err(Error::Config)?;
        let (root, active_terminals) = {
            let workspaces = self
                .workspaces
                .read()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            let Some(runtime) = workspaces.get(&prefix) else {
                return Ok(WorkspaceLifecycleOutcome::NotFound);
            };
            (
                runtime.root.clone(),
                runtime.artifacts.terminal_sessions.roster().len(),
            )
        };
        if active_terminals > 0 && !force {
            return Ok(WorkspaceLifecycleOutcome::Refused { active_terminals });
        }
        self.mark_mount_closing(&root);
        let runtime = {
            let mut workspaces = self
                .workspaces
                .write()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            workspaces.remove(&prefix)
        };
        let Some(runtime) = runtime else {
            self.clear_workspace_lifecycle(&root);
            return Ok(WorkspaceLifecycleOutcome::NotFound);
        };
        // Turning a workspace OFF (unmount) PRESERVES its persisted window records
        // so turning it back ON restores the same windows/panes/tabs (the PTYs
        // restart). The records are merely filtered out of the LIVE feed while the
        // workspace is off (see `window_in_live_feed`); only FORGET purges them.
        // Tear down explicitly (rather than leaving it to Drop) so tenant
        // tasks finish while the workspace cell is live, then the cell clears
        // and the per-workspace flock is verified released.
        let runtime_root = runtime.root.clone();
        runtime.shutdown().await;
        // A running workspace carries no transient lifecycle state, but clear
        // defensively so a leftover `error`/`starting` can never outlive a
        // close. No feed push here -- the `notify_window_change` below covers it.
        self.clear_mount_state(&runtime_root);
        self.notify_window_change();
        Ok(WorkspaceLifecycleOutcome::Completed)
    }

    /// Close the terminal-only tenant mounted at `prefix`, reaping its PTYs.
    ///
    /// Returns `Ok(false)` when nothing is mounted there. chan-desktop calls
    /// this on Disconnect AND Forget of a scripted devserver: destroying the
    /// webview window alone leaves the control terminal's connect script
    /// RUNNING on the host, because the tenant (mounted via
    /// [`open_terminal_session_with_command`](Self::open_terminal_session_with_command))
    /// outlives the window that drove it.
    ///
    /// This explicitly `close_all`s the tenant's terminal registry so every
    /// PTY child is sent its `Kill` synchronously -- the script process is
    /// gone by the time this returns -- rather than leaning on the per-tenant
    /// prune task to later observe the shutdown signal. The shared shutdown
    /// signal then stops the accept loops and background tasks before the
    /// runtime drops. The flock-release tail mirrors
    /// [`close_workspace`](Self::close_workspace) so pointing this at a
    /// workspace tenant by mistake still tears it down race-free; a terminal
    /// tenant has no workspace cell, so that wait is skipped.
    pub async fn close_terminal_tenant(&self, prefix: &str) -> Result<bool, Error> {
        let prefix = sanitize_prefix(prefix).map_err(Error::Config)?;
        let runtime = {
            let mut workspaces = self
                .workspaces
                .write()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            workspaces.remove(&prefix)
        };
        let Some(runtime) = runtime else {
            return Ok(false);
        };
        // Reap every PTY now: an explicit Disconnect/Forget must stop the
        // connect script's process at once, not whenever the prune task next
        // wakes on the shutdown signal. `close_all` drains the session map
        // and Kills each child; it is idempotent, so the shutdown-driven
        // prune that follows is a no-op.
        runtime
            .artifacts
            .terminal_sessions
            .close_all(CloseReason::Shutdown);
        runtime.shutdown().await;
        self.notify_window_change();
        Ok(true)
    }

    /// Drain every mounted tenant for normal process shutdown without changing
    /// the persisted workspace overlay.
    ///
    /// Every runtime starts its bounded shutdown before this method awaits any
    /// one of them, so a stuck tenant cannot multiply the per-tenant grace by
    /// the number of workspace, shared-terminal, or control-terminal tenants.
    pub async fn shutdown_all(&self) -> Result<(), Error> {
        let runtimes: Vec<HostedWorkspaceRuntime> = {
            let mut workspaces = self
                .workspaces
                .write()
                .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
            workspaces.drain().map(|(_, runtime)| runtime).collect()
        };
        let mut shutdowns = tokio::task::JoinSet::new();
        for runtime in runtimes {
            shutdowns.spawn(runtime.shutdown());
        }
        while let Some(result) = shutdowns.join_next().await {
            if let Err(error) = result {
                if !error.is_cancelled() {
                    tracing::error!(%error, "hosted tenant shutdown panicked");
                }
            }
        }
        self.notify_window_change();
        Ok(())
    }

    /// Cancel any in-flight reindex on every mounted tenant.
    ///
    /// On shutdown the devserver calls this so each tenant's blocking reindex
    /// drops its `Arc<Workspace>` at the next per-file cancel check, releasing
    /// the per-workspace flock promptly instead of waiting for the rebuild to
    /// run to completion. Mirrors the single-tenant `indexer.cancel()` in
    /// `WorkspaceCellHandle::clear`. Read-only over the map and best-effort per
    /// tenant: a poisoned cell or a terminal tenant (no workspace cell) is
    /// skipped.
    pub fn cancel_all_reindex(&self) {
        let Ok(workspaces) = self.workspaces.read() else {
            return;
        };
        for runtime in workspaces.values() {
            runtime.artifacts.cell.cancel_reindex();
        }
    }

    /// Snapshot the mounted prefixes.
    pub fn mounted_prefixes(&self) -> Result<Vec<String>, Error> {
        let workspaces = self
            .workspaces
            .read()
            .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
        let mut prefixes: Vec<String> = workspaces.keys().cloned().collect();
        prefixes.sort();
        Ok(prefixes)
    }

    /// Build a dynamic router for all mounted workspaces.
    ///
    /// The returned router consults the host map on every request, so
    /// later `open_*` and `close_workspace` calls are visible without
    /// rebuilding the outer axum app.
    pub fn router(self: Arc<Self>) -> Router {
        Router::new().fallback(host_dispatch).with_state(self)
    }

    /// Return the live `Arc<Workspace>` for a mounted workspace whose root
    /// matches `root`, or `None` when no mounted runtime owns that
    /// path.
    ///
    /// Desktop feature toggles need the SAME handle the runtime
    /// holds: a second `Library::open_workspace` for a mounted path
    /// returns `WorkspaceAlreadyOpen` because `Workspace::open` keeps a
    /// lifetime flock. Comparison is by canonical form so a
    /// symlinked or non-normalized caller path still matches the
    /// canonical root the runtime stored at mount time. Lock
    /// poisoning and a drained workspace cell both read as "not live"
    /// (mirrors `AppState::try_workspace`); the caller then falls back
    /// to a transient open against the registry.
    pub fn live_workspace(&self, root: &Path) -> Option<Arc<Workspace>> {
        let target = canonical_key(root);
        let workspaces = self.workspaces.read().ok()?;
        let runtime = workspaces
            .values()
            .find(|runtime| canonical_key(&runtime.root) == target)?;
        runtime.artifacts.cell.workspace()
    }

    /// True iff a workspace with this canonical root is mounted (under ANY
    /// prefix). The launcher's `on` state reads this so it reflects the real
    /// mount regardless of the prefix scheme that mounted it -- the desktop
    /// mounts at `workspace-<hash>` while the devserver mounts at the slug, so a
    /// slug-prefix membership check reads `off` on the desktop.
    pub fn is_root_mounted(&self, root: &Path) -> bool {
        self.live_workspace(root).is_some()
    }

    /// The prefix string this canonical root is CURRENTLY mounted at (the
    /// `workspaces` map key), regardless of which scheme mounted it (slug vs
    /// `workspace-<hash>`), or `None` when it is not mounted. The launcher's
    /// off/remove path targets this so it closes the REAL tenant on the desktop,
    /// not the slug prefix the desktop never mounted at.
    pub fn mounted_prefix_for_root(&self, root: &Path) -> Option<String> {
        let target = canonical_key(root);
        let workspaces = self.workspaces.read().ok()?;
        workspaces
            .iter()
            .find(|(_, runtime)| canonical_key(&runtime.root) == target)
            .map(|(prefix, _)| prefix.clone())
    }

    /// The launcher row's live `(status, error)` for a workspace root. `running`
    /// when mounted unless a teardown state is active; else the transient
    /// overlay's `starting`/`error`; else a foreign writer lock reports
    /// `locked`; else `stopped`. The launcher drives its spinner and
    /// toggle-disable off this, not an optimistic timer.
    pub fn workspace_status(&self, root: &Path) -> (WorkspaceStatus, Option<String>) {
        let key = canonical_key(root);
        let state = self
            .mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned();
        match state {
            Some(MountState::Closing) => return (WorkspaceStatus::Closing, None),
            Some(MountState::Removing) => return (WorkspaceStatus::Removing, None),
            _ => {}
        }
        if self.is_root_mounted(root) {
            return (WorkspaceStatus::Running, None);
        }
        match state {
            Some(MountState::Starting) => (WorkspaceStatus::Starting, None),
            Some(MountState::Error(reason)) => (WorkspaceStatus::Error, Some(reason)),
            Some(MountState::Closing) | Some(MountState::Removing) => {
                (WorkspaceStatus::Stopped, None)
            }
            None if self.root_has_foreign_lock(root) => (WorkspaceStatus::Locked, None),
            None => (WorkspaceStatus::Stopped, None),
        }
    }

    fn root_has_foreign_lock(&self, root: &Path) -> bool {
        self.library.workspace_paths_for(root).is_some_and(|paths| {
            chan_workspace::lock::is_locked_by_foreign_holder(&paths.lock, root)
        })
    }

    /// Drop a workspace root's transient lifecycle overlay and fire the watch
    /// feed when something changed. The launcher's turn-OFF calls this so a row
    /// left `starting` or `error` settles to `stopped` even when nothing was
    /// mounted to close (a failed mount is not in the `workspaces` map, so
    /// `close_workspace` is a no-op for it).
    pub fn clear_workspace_lifecycle(&self, root: &Path) {
        let key = canonical_key(root);
        let had = self
            .mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key)
            .is_some();
        if had {
            self.notify_window_change();
        }
    }

    /// Publish `starting` before an owner spawns a mount future.
    ///
    /// The devserver uses this pre-spawn edge so persistence and serving status
    /// cannot observe a desired-on row as stopped during background restore.
    pub fn mark_workspace_starting(&self, root: &Path) {
        self.mark_mount_starting(root);
    }

    /// Publish a terminal mount failure supplied by an external lifecycle
    /// owner, such as the devserver's bounded-attempt timeout.
    pub fn mark_workspace_failed(&self, root: &Path, reason: String) {
        self.mark_mount_error(root, reason);
    }

    /// Mark a workspace root's mount as in flight (`starting`) and fire the
    /// watch feed so the launcher spins the row before the (possibly slow)
    /// tenant build completes. No-op when the root is already mounted (`running`
    /// wins), so a retry of an already-served workspace never spuriously flips
    /// it to `starting`. Overwrites a prior `error` -- a fresh attempt clears it.
    fn mark_mount_starting(&self, root: &Path) {
        if self.is_root_mounted(root) {
            return;
        }
        let key = canonical_key(root);
        self.mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, MountState::Starting);
        self.notify_window_change();
    }

    fn mark_mount_closing(&self, root: &Path) {
        let key = canonical_key(root);
        self.mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, MountState::Closing);
        self.notify_window_change();
    }

    fn mark_mount_removing(&self, root: &Path) {
        let key = canonical_key(root);
        self.mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, MountState::Removing);
        self.notify_window_change();
    }

    /// Record that a workspace root's last mount failed (`error` + reason) and
    /// fire the watch feed so the launcher clears the spinner and surfaces the
    /// reason.
    fn mark_mount_error(&self, root: &Path, reason: String) {
        let key = canonical_key(root);
        self.mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, MountState::Error(reason));
        self.notify_window_change();
    }

    /// Drop a workspace root's transient lifecycle state (it settled to running,
    /// or was torn down). No feed push: the settling transition already fired
    /// one (mount success in `open_workspace`, close in `close_workspace`).
    fn clear_mount_state(&self, root: &Path) {
        let key = canonical_key(root);
        self.mount_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key);
    }

    /// Project a finished mount onto the lifecycle overlay: clear on success
    /// (the `workspaces` map now reports `running`); leave `starting` on our own
    /// in-flight contention (`WorkspaceAlreadyOpen` -- a concurrent task of THIS
    /// process is mounting the same root and will settle it, so it is not a
    /// failure); clear to the live lock probe on a foreign writer lock; record
    /// `error` for a real open failure.
    fn settle_mount(&self, root: &Path, result: &Result<HostedWorkspace, Error>) {
        match result {
            Ok(_) => self.clear_mount_state(root),
            Err(Error::Core(ChanError::WorkspaceAlreadyOpen)) => {}
            Err(Error::Core(ChanError::WorkspaceLocked)) => self.clear_workspace_lifecycle(root),
            Err(e) => self.mark_mount_error(root, e.to_string()),
        }
    }

    fn router_for_path(&self, path: &str) -> Result<Option<Router>, Error> {
        let workspaces = self
            .workspaces
            .read()
            .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
        Ok(workspaces
            .iter()
            .filter(|(prefix, _)| path_matches_prefix(path, prefix))
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, runtime)| runtime.router()))
    }

    /// Whether `path` belongs to a tenant currently mounted in this host.
    ///
    /// Devserver startup uses this narrow query to keep its root management
    /// surface responsive while temporarily refusing tenant traffic until
    /// inherited terminal sessions have been restored.
    pub fn owns_mounted_tenant_path(&self, path: &str) -> Result<bool, Error> {
        let workspaces = self
            .workspaces
            .read()
            .map_err(|_| Error::Config("workspace host lock poisoned".into()))?;
        Ok(workspaces
            .keys()
            .any(|prefix| path_matches_prefix(path, prefix)))
    }

    /// If `path` is exactly a mounted tenant prefix `/{prefix}` or its trailing-
    /// slash form `/{prefix}/`, return the bare prefix. `host_dispatch` uses it
    /// to canonicalize the tenant root (axum's nest 404s the exact `/{prefix}/`).
    /// The empty (root) prefix is excluded -- it serves at `/`, no slash dance.
    fn exact_tenant_root(&self, path: &str) -> Option<String> {
        let bare = path.strip_suffix('/').unwrap_or(path);
        if bare.is_empty() {
            return None;
        }
        let workspaces = self.workspaces.read().ok()?;
        workspaces.contains_key(bare).then(|| bare.to_string())
    }

    /// Resolve the tenant owning `req`'s path and forward to it; 404 when none
    /// does. The shared tail of `host_dispatch`, called pre- and post-rewrite.
    async fn dispatch_to(&self, req: Request<Body>) -> Response {
        let Some(router) = (match self.router_for_path(req.uri().path()) {
            Ok(router) => router,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        }) else {
            // No tenant prefix owns this path. Serve the library root fallback
            // (the launcher SPA + `/api/library/*`) when one is installed;
            // otherwise 404, the prior behavior.
            if let Some(fallback) = self.root_fallback.get() {
                return match fallback.clone().oneshot(req).await {
                    Ok(response) => response,
                    Err(e) => match e {},
                };
            }
            return StatusCode::NOT_FOUND.into_response();
        };
        match router.oneshot(req).await {
            Ok(response) => response,
            Err(e) => match e {},
        }
    }
}

/// The control socket reaches the host through `Weak<dyn HostControl>` (the
/// `install_self` back-reference), so it never names the concrete host type.
#[async_trait::async_trait]
impl HostControl for WorkspaceHost {
    async fn close_workspace_for_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        self.close_workspace_for_root(root, force).await
    }

    async fn remove_workspace_for_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error> {
        self.remove_workspace_for_root(root, force).await
    }

    fn assemble_window_records(&self) -> Vec<WindowRecord> {
        self.assemble_window_records()
    }

    fn discard_window(&self, window_id: &str) -> Result<bool, Error> {
        self.discard_window(window_id)
    }

    fn live_terminal_count(&self, window_id: &str) -> usize {
        self.live_terminal_count(window_id)
    }

    async fn open_outside_workspace(
        &self,
        requested: &Path,
        caller_window_id: &str,
    ) -> Result<OpenOutsideAck, Error> {
        self.open_outside_workspace(requested, caller_window_id)
            .await
    }

    fn tunnel_registry(&self) -> Arc<chan_revtunnel::server::TunnelRegistry> {
        self.tunnel_registry()
    }
}

async fn host_dispatch(State(host): State<Arc<WorkspaceHost>>, req: Request<Body>) -> Response {
    // Tenant-root trailing-slash canonicalization. A tenant nests at its prefix
    // (`Router::new().nest(prefix, inner)`), and axum's nest serves
    // `/{prefix}` and `/{prefix}/<rest>` but 404s the EXACT `/{prefix}/`. The
    // canonical public URL is `/{prefix}/` (the SPA's vite `base: "./"` resolves
    // its relative asset URLs against the document path, so it must end in `/`
    // for assets to land under the tenant). So at a tenant ROOT:
    //   - bare `/{prefix}` 308-redirects to `/{prefix}/`;
    //   - `/{prefix}/` is routed internally as `/{prefix}` so the nest serves the
    //     SPA root, while the browser keeps the trailing-slash URL.
    // Deeper paths (`/{prefix}/<rest>`) are untouched; the nest handles them.
    if let Some(prefix) = host.exact_tenant_root(req.uri().path()) {
        if req.uri().path().len() == prefix.len() {
            let location = match req.uri().query() {
                Some(q) => format!("{prefix}/?{q}"),
                None => format!("{prefix}/"),
            };
            return Redirect::permanent(&location).into_response();
        }
        return host.dispatch_to(rewrite_request_path(req, &prefix)).await;
    }
    host.dispatch_to(req).await
}

/// Rewrite a request's URI path (keeping the query) so the trailing-slash tenant
/// root (`/{prefix}/`) routes as the bare prefix the nest matches. A parse
/// failure leaves the request unchanged (it then 404s, the prior behavior).
fn rewrite_request_path(req: Request<Body>, new_path: &str) -> Request<Body> {
    let (mut parts, body) = req.into_parts();
    let target = match parts.uri.query() {
        Some(q) => format!("{new_path}?{q}"),
        None => new_path.to_string(),
    };
    if let Ok(uri) = target.parse::<Uri>() {
        parts.uri = uri;
    }
    Request::from_parts(parts, body)
}

fn path_matches_prefix(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Rebuild the public [`HostedWorkspace`] view of a mounted runtime from
/// the handle captured at mount time, for the idempotent re-register
/// return and any tenant listing.
fn hosted_from_runtime(runtime: &HostedWorkspaceRuntime) -> HostedWorkspace {
    HostedWorkspace {
        root: runtime.root.clone(),
        prefix: runtime.handle.prefix.clone(),
        handle: runtime.handle.clone(),
    }
}

/// Serialize a server-originated window notification as a `window_command`
/// frame. It rides the same envelope as the control socket's window commands so
/// the `/ws` pump's fixed-prefix target scan
/// (`{"type":"window_command","window_id":"<id>",`) delivers it to the affected
/// window's socket only. Built here in the library because the dependency flows
/// chan-server -> chan-library, so the control socket's `WindowCommand` enum is
/// unreachable; the byte shape is pinned by `window_command_frame_matches_pump_prefix`.
/// `command` is `"window_discarded"`, `"window_hidden"`, or `"window_labeled"`.
fn window_command_frame(
    window_id: &str,
    command: &'static str,
    label: Option<&str>,
) -> Option<String> {
    #[derive(serde::Serialize)]
    struct WindowCommandFrame<'a> {
        #[serde(rename = "type")]
        frame_type: &'static str,
        window_id: &'a str,
        command: &'static str,
        /// Only `window_labeled` carries text, and it carries the empty string
        /// when the user clears the caption. Skipping the key entirely when
        /// absent keeps a teardown frame's bytes unchanged.
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<&'a str>,
    }
    serde_json::to_string(&WindowCommandFrame {
        frame_type: "window_command",
        window_id,
        command,
        label,
    })
    .ok()
}

/// Canonical-form key for matching a caller path against a mounted
/// runtime's root, via [`chan_workspace::paths::canonicalize_normalized`]:
/// it strips any Windows `\\?\` verbatim prefix so a path the caller resolved
/// WITH the prefix and a runtime root resolved WITHOUT it (or vice versa)
/// collapse to one key -- otherwise `chan ps` reads no serving PID and
/// `chan close` finds no mounted runtime. Falls back to the (stripped) input
/// when the filesystem can't canonicalize (workspace root missing or asleep).
/// Mirrors the private `canonical_key` in `chan_workspace::library`.
fn canonical_key(root: &Path) -> PathBuf {
    chan_workspace::paths::canonicalize_normalized(root)
}

fn display_prefix(prefix: &str) -> &str {
    if prefix.is_empty() {
        "/"
    } else {
        prefix
    }
}

// The workspace-cell teardown (cancel indexer, drop watcher + workspace, return
// the flock-release info) lives in the route layer's `WorkspaceCellHandle::clear`
// impl, which owns the concrete cell; the host reaches it via `artifacts.cell`.

/// Block (bounded) until the last strong `Arc<Workspace>` drops after
/// teardown, which releases the per-workspace flock. The straggler is an
/// in-flight reindex on the blocking pool: `WorkspaceCellHandle::clear`
/// set the indexer's cancel flag, and the reindex drops its `Arc` at its
/// next per-file cancel check, on a separate blocking-pool thread that
/// makes progress regardless of this wait. Close is an infrequent
/// teardown and the wait is typically a few milliseconds. Bounded so a
/// wedged reindex cannot hang close: past the deadline the caller sees
/// the same lingering-flock behavior it would have had without the wait.
fn wait_for_workspace_release(weak: &Weak<Workspace>, lock_dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    // Two conditions, not one: the last strong `Arc` must drop, AND the
    // per-workspace flock must actually release. An `Arc`'s strong count hits
    // zero *before* `Workspace::drop` runs the `_lock` field's drop, so
    // `strong_count()==0` alone leaves a window where an immediate reopen
    // races the in-flight Drop and trips `WorkspaceLocked` with no live
    // competitor (the on→off→on wedge). `lock::is_free` try-acquires the flock
    // (and releases it), proving the prior holder's Drop completed.
    while weak.strong_count() > 0 || !chan_workspace::lock::is_free(lock_dir) {
        if Instant::now() >= deadline {
            tracing::warn!("close_workspace: workspace flock still held 5s after teardown");
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tenant::WorkspaceCellHandle;
    use crate::terminal_sessions::CreateOptions;
    use axum::body::to_bytes;
    use portable_pty::PtySize;

    #[test]
    fn canonical_key_strips_verbatim_prefix() {
        // A caller path resolved WITH the Windows `\\?\` verbatim prefix and a
        // runtime root resolved WITHOUT it must collapse to one key, or
        // `chan ps` reads no serving PID and `chan close` finds no mounted
        // runtime. Neither input is a real path on the test host, so both take
        // the normalized fallback; the key must strip the prefix identically to
        // `canonicalize_normalized`, the same helper the registry keys under.
        let prefixed = Path::new(r"\\?\C:\Users\me\proj");
        let plain = Path::new(r"C:\Users\me\proj");
        assert_eq!(canonical_key(prefixed), canonical_key(plain));
        assert_eq!(
            canonical_key(prefixed),
            chan_workspace::paths::canonicalize_normalized(plain)
        );
    }

    fn serve_config(prefix: &str) -> ServeConfig {
        ServeConfig {
            addr: ([127, 0, 0, 1], 0).into(),
            no_token: true,
            prefix: prefix.to_string(),
            idle_timeout: None,
            open_browser: false,
            search_aggression: None,
            verbose: false,
            settings_disabled: false,
        }
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let (parts, body) = response.into_parts();
        assert_eq!(parts.status, StatusCode::OK);
        let bytes = to_bytes(body, 1024 * 1024).await.expect("read body");
        serde_json::from_slice(&bytes).expect("json response")
    }

    /// A minimal `TenantBuilder` standing in for chan-server's route layer:
    /// a tiny router (`/api/workspace` echoes the root, `/api/build-info` 200,
    /// a catch-all SPA fallback like the real layer), a real terminal registry,
    /// and a fake cell that
    /// holds the real `Arc<Workspace>` so the flock-release lifecycle behaves
    /// like the route layer's. Lets the host's dispatch + teardown be unit-
    /// tested in isolation.
    struct FakeBuilder;

    struct GatedWorkspaceBuilder {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Arc<tokio::sync::Semaphore>,
    }

    fn fake_builder() -> Arc<dyn TenantBuilder> {
        Arc::new(FakeBuilder)
    }

    #[cfg(unix)]
    fn hold_foreign_lock(lib: &Library, root: &Path) -> chan_workspace::lock::WorkspaceLock {
        let paths = lib.workspace_paths_for(root).expect("workspace paths");
        let lock = chan_workspace::lock::WorkspaceLock::acquire(&paths.lock, root).expect("lock");
        let record = chan_workspace::lock::LockRecord {
            pid: 1,
            path: root
                .canonicalize()
                .unwrap_or_else(|_| root.to_path_buf())
                .to_string_lossy()
                .into_owned(),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        std::fs::write(
            paths.lock.join("writer.lock"),
            serde_json::to_vec(&record).expect("record json"),
        )
        .expect("write foreign lock record");
        lock
    }

    fn fake_registry() -> Arc<crate::terminal_sessions::Registry> {
        Arc::new(crate::terminal_sessions::Registry::new(
            crate::terminal_sessions::RegistryConfig {
                workspace_root: PathBuf::from("/"),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: crate::config::TerminalConfig::default(),
            },
        ))
    }

    fn fake_artifacts(app: Router, cell: Arc<dyn WorkspaceCellHandle>) -> TenantArtifacts {
        let (shutdown_tx, _rx) = tokio::sync::watch::channel(false);
        let shutdown_tx = Arc::new(shutdown_tx);
        TenantArtifacts {
            app,
            token: None,
            terminal_sessions: fake_registry(),
            tasks: TenantTaskOwner::new(shutdown_tx, Vec::new()),
            prefix: Arc::new(RwLock::new(String::new())),
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            pending_window_commands: Arc::new(Default::default()),
            standalone_files: None,
            events_tx: tokio::sync::broadcast::channel(16).0,
            cell,
            keepalive: Box::new(()),
        }
    }

    fn fake_artifacts_with_gated_shutdown(
        entered_tx: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Semaphore>,
        completed: Arc<std::sync::atomic::AtomicUsize>,
    ) -> TenantArtifacts {
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        let shutdown_tx = Arc::new(shutdown_tx);
        let task = tokio::spawn(async move {
            let _ = shutdown_rx.changed().await;
            let _ = entered_tx.send(());
            let _permit = release.acquire().await.expect("shutdown release semaphore");
            completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let mut artifacts = fake_artifacts(Router::new(), Arc::new(FakeTerminalCell));
        artifacts.tasks = TenantTaskOwner::new(shutdown_tx, vec![task]);
        artifacts
    }

    #[test]
    fn window_command_frame_matches_pump_prefix() {
        // The frame MUST start with the exact prefix the /ws pump scans
        // (routes::ws::window_command_target) or it is not routed to the
        // affected window's socket. Fields serialize in declaration order:
        // type, window_id, command, label.
        let discarded = window_command_frame("w-abc", "window_discarded", None).unwrap();
        assert_eq!(
            discarded,
            r#"{"type":"window_command","window_id":"w-abc","command":"window_discarded"}"#,
        );

        let hidden = window_command_frame("w-xyz", "window_hidden", None).unwrap();
        assert_eq!(
            hidden,
            r#"{"type":"window_command","window_id":"w-xyz","command":"window_hidden"}"#,
        );

        // The caption rides the same envelope, so the same prefix scan targets
        // it. An empty label is the CLEAR signal and must stay on the wire; only
        // a teardown omits the key.
        let labeled =
            window_command_frame("w-def", "window_labeled", Some("release checks")).unwrap();
        assert_eq!(
            labeled,
            r#"{"type":"window_command","window_id":"w-def","command":"window_labeled","label":"release checks"}"#,
        );
        let cleared = window_command_frame("w-def", "window_labeled", Some("")).unwrap();
        assert_eq!(
            cleared,
            r#"{"type":"window_command","window_id":"w-def","command":"window_labeled","label":""}"#,
        );
    }

    fn nest(prefix: &str, inner: Router) -> Router {
        if prefix.is_empty() {
            inner
        } else {
            Router::new().nest(prefix, inner)
        }
    }

    struct FakeWorkspaceCell(std::sync::Mutex<Option<Arc<Workspace>>>);
    impl WorkspaceCellHandle for FakeWorkspaceCell {
        fn workspace(&self) -> Option<Arc<Workspace>> {
            self.0.lock().ok()?.clone()
        }
        fn cancel_reindex(&self) {}
        fn clear(&self) -> Option<(Weak<Workspace>, PathBuf)> {
            let ws = self.0.lock().ok()?.take()?;
            let lock_dir = ws.paths().lock.clone();
            let weak = Arc::downgrade(&ws);
            drop(ws);
            Some((weak, lock_dir))
        }
    }

    struct FakeTerminalCell;
    impl WorkspaceCellHandle for FakeTerminalCell {
        fn workspace(&self) -> Option<Arc<Workspace>> {
            None
        }
        fn cancel_reindex(&self) {}
        fn clear(&self) -> Option<(Weak<Workspace>, PathBuf)> {
            None
        }
    }

    #[async_trait::async_trait]
    impl TenantBuilder for FakeBuilder {
        async fn build_workspace(
            &self,
            _library: Library,
            workspace: Arc<Workspace>,
            config: &ServeConfig,
            _desktop: DesktopBridge,
            _unserve: UnserveMode,
            _control_identity: Option<String>,
        ) -> Result<TenantArtifacts, Error> {
            let root = workspace.root().to_string_lossy().to_string();
            let inner = Router::new()
                .route(
                    "/api/workspace",
                    axum::routing::get(move || {
                        let root = root.clone();
                        async move { axum::Json(serde_json::json!({ "root": root })) }
                    }),
                )
                .route(
                    "/api/build-info",
                    axum::routing::get(|| async { StatusCode::OK }),
                )
                // Mimic the real route layer's SPA fallback: any non-api GET
                // (including the tenant root `/`) returns the shell, so the
                // tenant-root trailing-slash dispatch is testable.
                .fallback(|| async { (StatusCode::OK, "spa") });
            let cell: Arc<dyn WorkspaceCellHandle> =
                Arc::new(FakeWorkspaceCell(std::sync::Mutex::new(Some(workspace))));
            Ok(fake_artifacts(nest(&config.prefix, inner), cell))
        }

        async fn build_terminal(
            &self,
            _library: Library,
            config: &ServeConfig,
            _desktop: DesktopBridge,
            _unserve: UnserveMode,
            command: Option<String>,
            _session_dir: Option<PathBuf>,
            _control_identity: Option<String>,
        ) -> Result<TenantArtifacts, Error> {
            let inner = Router::new().route(
                "/api/build-info",
                axum::routing::get(|| async { StatusCode::OK }),
            );
            let artifacts = fake_artifacts(nest(&config.prefix, inner), Arc::new(FakeTerminalCell));
            artifacts.terminal_sessions.set_default_command(command);
            Ok(artifacts)
        }
    }

    #[async_trait::async_trait]
    impl TenantBuilder for GatedWorkspaceBuilder {
        async fn build_workspace(
            &self,
            library: Library,
            workspace: Arc<Workspace>,
            config: &ServeConfig,
            desktop: DesktopBridge,
            unserve: UnserveMode,
            control_identity: Option<String>,
        ) -> Result<TenantArtifacts, Error> {
            if let Some(entered) = self.entered.lock().expect("entered lock").take() {
                let _ = entered.send(());
            }
            let _permit = self
                .release
                .acquire()
                .await
                .expect("mount release semaphore");
            FakeBuilder
                .build_workspace(
                    library,
                    workspace,
                    config,
                    desktop,
                    unserve,
                    control_identity,
                )
                .await
        }

        async fn build_terminal(
            &self,
            library: Library,
            config: &ServeConfig,
            desktop: DesktopBridge,
            unserve: UnserveMode,
            command: Option<String>,
            session_dir: Option<PathBuf>,
            control_identity: Option<String>,
        ) -> Result<TenantArtifacts, Error> {
            FakeBuilder
                .build_terminal(
                    library,
                    config,
                    desktop,
                    unserve,
                    command,
                    session_dir,
                    control_identity,
                )
                .await
        }
    }

    #[tokio::test]
    async fn tunnel_registry_is_shared_across_both_access_paths() {
        // `cs tunnel` registers through the control socket's `Weak<dyn
        // HostControl>`, while the desktop's WebSocket legs attach through the
        // launcher router's direct `Arc<WorkspaceHost>`. Both must land on ONE
        // registry or a registered tunnel is invisible to its own control
        // socket.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        let control: Arc<dyn HostControl> = host.clone();
        let spec =
            chan_revtunnel::parse_spec("8080:3000", chan_revtunnel::Proto::Tcp).expect("spec");
        let _registration = control.tunnel_registry().register("tun-wire", &spec);
        assert!(host.tunnel_registry().attach_control("tun-wire").is_ok());
    }

    #[tokio::test]
    async fn host_canonicalizes_tenant_root_trailing_slash() {
        // A tenant nests at its slug, and axum's nest serves
        // `/blog` and `/blog/<rest>` but 404s the EXACT `/blog/` -- yet `/blog/`
        // is the canonical open URL (the SPA's `base: "./"` needs the trailing
        // slash). host_dispatch fixes it: `/blog/` serves the root, `/blog`
        // 308s to `/blog/`.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        std::fs::write(root.path().join("note.md"), "# n\n").expect("write");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/blog"))
            .await
            .expect("open");
        let app = host.router();

        let status = |uri: &'static str| {
            let app = app.clone();
            async move {
                app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap()
            }
        };

        // `/blog/` (the canonical root) serves the SPA shell (the fallback).
        assert_eq!(status("/blog/").await.status(), StatusCode::OK);
        // Deep tenant paths are untouched by the canonicalization.
        assert_eq!(
            status("/blog/api/build-info").await.status(),
            StatusCode::OK
        );
        assert_eq!(status("/blog/anything").await.status(), StatusCode::OK);

        // Bare `/blog` 308-redirects to the canonical `/blog/` (preserving query).
        let bare = status("/blog").await;
        assert_eq!(bare.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(bare.headers()["location"], "/blog/");
        let bare_q = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/blog?t=tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bare_q.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(bare_q.headers()["location"], "/blog/?t=tok");

        // `/blog/` with a query is rewritten to the bare prefix (keeping query)
        // so the nest serves the root -- still 200, not a 404.
        assert_eq!(status("/blog/?t=tok").await.status(), StatusCode::OK);

        // An unmounted path still 404s (no tenant owns it).
        assert_eq!(status("/nope/").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn host_root_fallback_covers_only_unmatched_prefixes() {
        // The launcher root fallback answers ONLY paths no tenant prefix owns.
        // An unknown path UNDER a mounted prefix stays with the tenant (its own
        // SPA fallback), never the launcher: host_dispatch hands each request
        // to exactly one router, so the launcher fallback cannot bleed into
        // tenant misses regardless of axum's nest fallback-inheritance
        // semantics.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        std::fs::write(root.path().join("note.md"), "# n\n").expect("write");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/blog"))
            .await
            .expect("open");
        host.install_root_fallback(
            Router::new().fallback(|| async { (StatusCode::OK, "launcher") }),
        );
        let app = host.router();

        let body_of = |uri: &'static str| {
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK, "{uri}");
                let bytes = to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .expect("read body");
                String::from_utf8(bytes.to_vec()).expect("utf8 body")
            }
        };

        // Unknown paths under the mounted prefix: the tenant's own fallback.
        assert_eq!(body_of("/blog/nonexistent").await, "spa");
        assert_eq!(body_of("/blog/api/nonexistent").await, "spa");
        // Unknown paths outside every prefix: the installed root fallback.
        assert_eq!(body_of("/nonexistent").await, "launcher");
        assert_eq!(body_of("/").await, "launcher");
    }

    #[tokio::test]
    async fn host_routes_requests_to_the_matching_workspace_prefix() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root_a = tempfile::tempdir().expect("workspace a");
        let root_b = tempfile::tempdir().expect("workspace b");
        std::fs::write(root_a.path().join("a.md"), "# A\n").expect("write a");
        std::fs::write(root_b.path().join("b.md"), "# B\n").expect("write b");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root_a.path()).expect("register a");
        lib.register_workspace(root_b.path()).expect("register b");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        host.open_registered_workspace(root_a.path(), serve_config("/a"))
            .await
            .expect("open a");
        host.open_registered_workspace(root_b.path(), serve_config("/b"))
            .await
            .expect("open b");

        let app = host.router();
        let a = response_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/a/api/workspace")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        let b = response_json(
            app.oneshot(
                Request::builder()
                    .uri("/b/api/workspace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;

        // Hosted roots carry the crate's normalized canonical form, which
        // strips the Windows verbatim prefix std's canonicalize returns.
        let root_a = chan_workspace::paths::canonicalize_normalized(root_a.path());
        let root_b = chan_workspace::paths::canonicalize_normalized(root_b.path());
        assert_eq!(a["root"], root_a.to_string_lossy().as_ref());
        assert_eq!(b["root"], root_b.to_string_lossy().as_ref());
    }

    #[tokio::test]
    async fn host_close_workspace_removes_the_route() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("open");
        let app = host.clone().router();

        assert!(host
            .close_workspace("/workspace", false)
            .await
            .expect("close")
            .completed());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/workspace/api/workspace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn host_workspace_status_tracks_mount_lifecycle() {
        // The launcher reads `workspace_status` for each row: `stopped` when
        // unmounted, `running` once mounted, back to `stopped` after close. The
        // running `workspaces` map is authoritative for `running`.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Stopped, None)
        );

        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("open");
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Running, None)
        );

        assert!(host
            .close_workspace("/workspace", false)
            .await
            .expect("close")
            .completed());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Stopped, None)
        );
    }

    #[test]
    fn workspace_status_locked_wire_tag_is_pinned() {
        assert_eq!(
            serde_json::to_string(&WorkspaceStatus::Locked).expect("serialize"),
            r#""locked""#
        );
        assert_eq!(
            serde_json::from_str::<WorkspaceStatus>(r#""locked""#).expect("deserialize"),
            WorkspaceStatus::Locked
        );
    }

    #[tokio::test]
    async fn host_workspace_status_surfaces_starting_and_error() {
        // The transient overlay drives `starting` (mount in flight) and `error`
        // (last mount failed) -- the two states the running `workspaces` map
        // can't express. A turn-off clears a non-mounted errored row to stopped.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        host.mark_mount_starting(root.path());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Starting, None)
        );

        host.mark_mount_error(root.path(), "open failed".into());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Error, Some("open failed".to_string()))
        );

        host.clear_workspace_lifecycle(root.path());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Stopped, None)
        );
    }

    #[tokio::test]
    async fn host_workspace_status_surfaces_closing_and_removing() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        host.mark_mount_closing(root.path());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Closing, None)
        );

        host.mark_mount_removing(root.path());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Removing, None)
        );
    }

    #[tokio::test]
    async fn host_workspace_status_running_overrides_stale_overlay() {
        // `running` (presence in the workspaces map) wins over a stale `starting`
        // overlay entry, so a row never spins while it is actually served.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("open");
        // Force a stale overlay entry behind the running mount; running must win.
        host.mount_state
            .lock()
            .unwrap()
            .insert(canonical_key(root.path()), MountState::Starting);
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Running, None)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn host_workspace_status_reports_foreign_lock_until_release() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        let foreign = hold_foreign_lock(&lib, root.path());
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Locked, None)
        );

        drop(foreign);
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Stopped, None)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_locked_mount_clears_starting_overlay() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        let foreign = hold_foreign_lock(&lib, root.path());
        let err = host
            .open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect_err("foreign lock");
        assert!(matches!(err, Error::Core(ChanError::WorkspaceLocked)));
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Locked, None)
        );

        drop(foreign);
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Stopped, None)
        );
    }

    #[tokio::test]
    async fn host_close_workspace_releases_handle_for_immediate_reopen() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));

        host.open_registered_workspace(root.path(), serve_config("/first"))
            .await
            .expect("open first");
        assert!(host
            .close_workspace("/first", false)
            .await
            .expect("close first")
            .completed());

        host.open_registered_workspace(root.path(), serve_config("/second"))
            .await
            .expect("reopen after close");
    }

    #[tokio::test]
    async fn off_filters_windows_from_feed_but_preserves_them_for_on_restore() {
        // Turning a workspace OFF must HIDE its windows from the live feed
        // (finding #1) but PRESERVE the persisted records so turning it back ON
        // restores them. A terminal window is never workspace-gated. Only FORGET
        // purges (covered by `forget_purges_the_workspaces_windows`).
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("open");

        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        let ws = registry.create(
            WindowKind::Workspace,
            Some(root.path().to_string_lossy().into_owned()),
        );
        let term = registry.create(WindowKind::Terminal, None);
        host.install_window_registry(registry.clone(), "local".into());

        let feed_ids = || {
            host.assemble_window_records()
                .into_iter()
                .map(|r| r.window_id)
                .collect::<Vec<_>>()
        };
        // Mounted: both the workspace window and the terminal are in the feed.
        assert!(feed_ids().contains(&ws.window_id) && feed_ids().contains(&term.window_id));

        // OFF: the workspace window is FILTERED from the live feed, the terminal
        // is unaffected, and the record is STILL persisted in the registry.
        assert!(host
            .close_workspace("/workspace", false)
            .await
            .expect("close")
            .completed());
        assert!(
            !feed_ids().contains(&ws.window_id),
            "off workspace window is hidden from the live feed"
        );
        assert!(feed_ids().contains(&term.window_id), "terminal unaffected");
        assert!(
            registry
                .snapshot()
                .iter()
                .any(|r| r.window_id == ws.window_id),
            "off PRESERVES the record (not purged) so ON can restore it"
        );

        // ON: re-mount → the workspace window re-appears in the feed.
        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("reopen");
        assert!(
            feed_ids().contains(&ws.window_id),
            "ON re-includes the preserved window record"
        );
    }

    #[tokio::test]
    async fn forget_purges_the_workspaces_windows() {
        // FORGET (remove) is the only path that purges the records -- unlike OFF,
        // they do not come back.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("open");

        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        registry.create(
            WindowKind::Workspace,
            Some(root.path().to_string_lossy().into_owned()),
        );
        host.install_window_registry(registry.clone(), "local".into());
        assert_eq!(registry.snapshot().len(), 1);

        assert!(host
            .remove_workspace_for_root(root.path(), false)
            .await
            .expect("forget")
            .completed());
        assert!(
            registry.snapshot().is_empty(),
            "forget purges the window record"
        );
    }

    #[tokio::test]
    async fn close_workspace_releases_the_flock_before_returning() {
        // The on→off→on wedge fix: `close_workspace` must not return until the
        // per-workspace flock is genuinely released, not merely once the last
        // `Arc`'s strong count hits zero (which happens BEFORE `Workspace::drop`
        // runs the `_lock` drop). Asserted deterministically: the flock is free
        // the instant close returns.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/ws"))
            .await
            .expect("open");

        // Capture the lock dir from the live workspace; while mounted, held.
        let lock_dir = host
            .live_workspace(root.path())
            .expect("live workspace")
            .paths()
            .lock
            .clone();
        assert!(
            !chan_workspace::lock::is_free(&lock_dir),
            "flock is held while the workspace is mounted"
        );

        assert!(host
            .close_workspace("/ws", false)
            .await
            .expect("close")
            .completed());
        assert!(
            chan_workspace::lock::is_free(&lock_dir),
            "flock is free the moment close_workspace returns"
        );
    }

    #[tokio::test]
    async fn close_workspace_for_root_unmounts_by_path() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/ws"))
            .await
            .expect("open");

        // The `chan close` host path: unmount the matching tenant by root.
        assert!(host
            .close_workspace_for_root(root.path(), false)
            .await
            .expect("close by root")
            .completed());
        assert!(host.mounted_prefixes().expect("prefixes").is_empty());

        // An already-unmounted root and an unknown root both report false
        // (no panic, no error) so unserve is idempotent / 404-able.
        assert!(host
            .close_workspace_for_root(root.path(), false)
            .await
            .expect("absent root")
            .not_found());
        let other = tempfile::tempdir().expect("other");
        assert!(host
            .close_workspace_for_root(other.path(), false)
            .await
            .expect("unknown root")
            .not_found());
    }

    #[tokio::test]
    async fn close_for_root_accepts_registered_starting_before_runtime_lands() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let key = lib
            .register_workspace(root.path())
            .expect("register")
            .root_path
            .to_string_lossy()
            .into_owned();
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        let overlay = Arc::new(WorkspaceOverlay::open(cfg.path().join("workspaces.json")));
        overlay.set(&key, true);
        host.install_workspace_overlay(Arc::clone(&overlay));

        // DevserverState publishes this edge before spawning its mount future.
        // `chan close` must accept the registered intent even though no runtime
        // has landed in the host map yet.
        host.mark_workspace_starting(root.path());
        assert_eq!(
            host.workspace_status(root.path()).0,
            WorkspaceStatus::Starting
        );
        assert!(host
            .close_workspace_for_root(root.path(), false)
            .await
            .expect("close starting root")
            .completed());

        assert_eq!(
            host.workspace_status(root.path()).0,
            WorkspaceStatus::Stopped
        );
        assert!(host.mounted_prefixes().expect("prefixes").is_empty());
        assert!(
            host.library().workspace_paths_for(root.path()).is_some(),
            "plain close keeps the registry row"
        );
        let row = overlay
            .entries()
            .into_iter()
            .find(|row| row.path == key)
            .expect("overlay row");
        assert!(!row.desired_on, "close persists the pending row off");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn close_and_remove_use_one_overlay_row_through_a_symlink_alias() {
        use std::os::unix::fs::symlink;

        let cfg = tempfile::tempdir().expect("config dir");
        let roots = tempfile::tempdir().expect("workspace parent");
        let root = roots.path().join("workspace");
        let alias = roots.path().join("alias");
        std::fs::create_dir(&root).expect("workspace");
        symlink(&root, &alias).expect("workspace alias");

        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let registered = lib.register_workspace(&alias).expect("register");
        let key = registered.root_path.to_string_lossy().into_owned();
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        let overlay = Arc::new(WorkspaceOverlay::open(cfg.path().join("workspaces.json")));
        overlay.set(&key, true);
        host.install_workspace_overlay(Arc::clone(&overlay));

        host.mark_workspace_starting(&registered.root_path);
        assert!(host
            .close_workspace_for_root(&alias, false)
            .await
            .expect("close through alias")
            .completed());
        let rows = overlay.entries();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, key);
        assert!(!rows[0].desired_on);

        assert!(host
            .remove_workspace_for_root(&alias, false)
            .await
            .expect("remove through alias")
            .completed());
        assert!(overlay.entries().is_empty());
        assert!(host.library().list_workspaces().is_empty());
    }

    #[tokio::test]
    async fn shutdown_close_preserves_the_overlay_on_state() {
        // The desktop Exit handler snapshots the on-set (persist_workspaces) and
        // THEN tears every mounted workspace down. Teardown must not touch the
        // overlay, or a slow close racing process death flips a just-persisted
        // workspace off for the next boot. The shutdown close unmounts but leaves
        // the on row intact.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let key = lib
            .register_workspace(root.path())
            .expect("register")
            .root_path
            .to_string_lossy()
            .into_owned();
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        let overlay = Arc::new(WorkspaceOverlay::open(cfg.path().join("workspaces.json")));
        overlay.set(&key, true);
        host.install_workspace_overlay(Arc::clone(&overlay));

        host.open_registered_workspace(root.path(), serve_config("/ws"))
            .await
            .expect("open");

        assert!(host
            .close_workspace_for_root_preserving_overlay(root.path(), false)
            .await
            .expect("shutdown close")
            .completed());

        // Unmounted, but the desired-state row is still on for the next boot.
        assert!(host.mounted_prefixes().expect("prefixes").is_empty());
        assert_eq!(overlay.on_paths(), vec![key]);
    }

    #[tokio::test]
    async fn host_wide_shutdown_drains_all_tenant_kinds_concurrently_and_preserves_overlay() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let key = canonical_key(root.path()).to_string_lossy().into_owned();
        let library = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(library, fake_builder());
        let overlay = Arc::new(WorkspaceOverlay::open(cfg.path().join("workspaces.json")));
        overlay.set(&key, true);
        host.install_workspace_overlay(Arc::clone(&overlay));

        let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let prefixes = ["/workspace", "/terminal", "/control-0"];
        {
            let mut workspaces = host.workspaces.write().expect("host map");
            for prefix in prefixes {
                workspaces.insert(
                    prefix.to_string(),
                    HostedWorkspaceRuntime {
                        root: root.path().to_path_buf(),
                        handle: ServeHandle {
                            addr: ([127, 0, 0, 1], 0).into(),
                            prefix: prefix.to_string(),
                            token: None,
                        },
                        artifacts: fake_artifacts_with_gated_shutdown(
                            entered_tx.clone(),
                            Arc::clone(&release),
                            Arc::clone(&completed),
                        ),
                    },
                );
            }
        }
        drop(entered_tx);
        let mut shutdown = Box::pin(host.shutdown_all());
        for _ in prefixes {
            tokio::select! {
                biased;
                entered = entered_rx.recv() => entered.expect("tenant shutdown started"),
                result = shutdown.as_mut() => panic!("host shutdown serialized tenants: {result:?}"),
            }
        }
        release.add_permits(prefixes.len());
        shutdown.await.expect("host-wide shutdown");

        assert_eq!(
            completed.load(std::sync::atomic::Ordering::SeqCst),
            prefixes.len()
        );
        assert!(host.mounted_prefixes().expect("prefixes").is_empty());
        assert_eq!(overlay.on_paths(), vec![key]);
    }

    #[tokio::test]
    async fn close_for_root_records_off_in_the_overlay() {
        // The default close is genuine user intent (`chan close`, the launcher
        // off-toggle, the control-socket close): it records the workspace off so a
        // devserver restart does not bring it back up.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let key = lib
            .register_workspace(root.path())
            .expect("register")
            .root_path
            .to_string_lossy()
            .into_owned();
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        let overlay = Arc::new(WorkspaceOverlay::open(cfg.path().join("workspaces.json")));
        overlay.set(&key, true);
        host.install_workspace_overlay(Arc::clone(&overlay));

        host.open_registered_workspace(root.path(), serve_config("/ws"))
            .await
            .expect("open");

        assert!(host
            .close_workspace_for_root(root.path(), false)
            .await
            .expect("close by root")
            .completed());

        // No longer on, and the row persists as an explicit off (remembered-off),
        // not merely absent.
        assert!(overlay.on_paths().is_empty());
        assert!(overlay
            .entries()
            .iter()
            .any(|row| row.path == key && !row.desired_on));
    }

    #[tokio::test]
    async fn live_workspace_returns_the_mounted_runtime_handle() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/workspace"))
            .await
            .expect("open");

        // The live handle must be the SAME Arc the runtime holds, so a
        // feature toggle off it reaches the flock-holding workspace rather
        // than tripping WorkspaceAlreadyOpen on a re-open.
        let live = host
            .live_workspace(root.path())
            .expect("live workspace present");
        // The crate's normalized canonical form, not std's Windows verbatim.
        let canonical = chan_workspace::paths::canonicalize_normalized(root.path());
        assert_eq!(live.root(), canonical.as_path());

        // A path that no runtime mounts reads as not live.
        let other = tempfile::tempdir().expect("other dir");
        assert!(host.live_workspace(other.path()).is_none());

        // After close, the handle is no longer live.
        assert!(host
            .close_workspace("/workspace", false)
            .await
            .expect("close")
            .completed());
        assert!(host.live_workspace(root.path()).is_none());
    }

    #[tokio::test]
    async fn by_root_resolution_sees_a_non_slug_mount() {
        // B1b regression: the desktop mounts a workspace tenant at
        // `workspace-<hash>`, NOT at its slug prefix, so the old slug-membership
        // on-check read `off` there. `is_root_mounted` / `mounted_prefix_for_root`
        // resolve by canonical ROOT, so they see the real mount whatever scheme
        // mounted it.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        // Mount at a desktop-style prefix that is NOT the workspace's slug.
        let mount_prefix = "/workspace-deadbeef";
        let slug = allocate_workspace_prefix(root.path()).expect("slug prefix");
        assert_ne!(slug, mount_prefix, "test needs a non-slug mount prefix");
        host.open_registered_workspace(root.path(), serve_config(mount_prefix))
            .await
            .expect("open");

        // On-state and the off/rm target both resolve by root, not by the slug.
        assert!(host.is_root_mounted(root.path()));
        assert_eq!(
            host.mounted_prefix_for_root(root.path()).as_deref(),
            Some(mount_prefix)
        );

        // An unknown root is not mounted (no panic) -- the launcher shows `off`.
        let other = tempfile::tempdir().expect("other dir");
        assert!(!host.is_root_mounted(other.path()));
        assert!(host.mounted_prefix_for_root(other.path()).is_none());

        // Closing the REAL prefix unmounts it; by-root resolution then reads off.
        assert!(host
            .close_workspace(mount_prefix, false)
            .await
            .expect("close")
            .completed());
        assert!(!host.is_root_mounted(root.path()));
        assert!(host.mounted_prefix_for_root(root.path()).is_none());
    }

    #[tokio::test]
    async fn fresh_in_process_register_opens_without_workspace_not_registered() {
        // Regression guard for the desktop "workspace not registered" bug.
        // Registering a brand-new directory must go through the SAME
        // `Library` the host owns, in-process: mutating only the on-disk
        // registry (e.g. by spawning `chan add`) leaves the host's
        // `Library` snapshot without the row, and the immediately-following
        // open returns WorkspaceNotRegistered. This test registers a
        // never-before-seen dir, then opens it on the same handle with no
        // intervening reload.
        let cfg = tempfile::tempdir().expect("config dir");
        let fresh = tempfile::tempdir().expect("fresh workspace dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(fresh.path())
            .expect("register fresh dir");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        let hosted = host
            .open_registered_workspace(fresh.path(), serve_config("/fresh"))
            .await
            .expect("fresh dir opens immediately after in-process register");
        // The crate's normalized canonical form, not std's Windows verbatim.
        let canonical = chan_workspace::paths::canonicalize_normalized(fresh.path());
        assert_eq!(hosted.root, canonical);
    }

    #[tokio::test]
    async fn open_or_get_re_register_is_idempotent_on_root() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        let first = host
            .open_or_get_registered_workspace(root.path(), serve_config("/first"))
            .await
            .expect("first mount");
        assert_eq!(first.prefix, "/first");

        // Re-registering the same root returns the EXISTING mount (its
        // original prefix + token) without re-opening the flocked
        // workspace, even when a different prefix is requested.
        let again = host
            .open_or_get_registered_workspace(root.path(), serve_config("/second"))
            .await
            .expect("idempotent re-register");
        assert_eq!(
            again.prefix, "/first",
            "existing prefix, not the requested /second"
        );
        assert_eq!(
            again.handle.token, first.handle.token,
            "same tenant, same token"
        );
        assert_eq!(
            host.mounted_prefixes().expect("prefixes"),
            vec!["/first".to_string()],
            "still one tenant"
        );
    }

    #[tokio::test]
    async fn open_or_get_duplicate_prefix_on_different_root_still_errors() {
        let cfg = tempfile::tempdir().expect("config dir");
        let a = tempfile::tempdir().expect("ws a");
        let b = tempfile::tempdir().expect("ws b");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(a.path()).expect("register a");
        lib.register_workspace(b.path()).expect("register b");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        host.open_or_get_registered_workspace(a.path(), serve_config("/shared"))
            .await
            .expect("mount a at /shared");

        // A DIFFERENT root requesting an already-taken prefix is a genuine
        // collision (not the same-root idempotent case) and still errors.
        let err = host
            .open_or_get_registered_workspace(b.path(), serve_config("/shared"))
            .await
            .expect_err("duplicate prefix on a different root must error");
        assert!(matches!(err, Error::Config(_)));
    }

    #[tokio::test]
    async fn open_or_get_concurrent_same_root_resolves_to_one_mount() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        // Two callers race the same fresh root. The registration lock
        // serializes them: one mounts, the other observes that mount in the
        // pre-check. Both resolve to a single tenant with the same prefix.
        let (a, b) = tokio::join!(
            host.open_or_get_registered_workspace(root.path(), serve_config("/race")),
            host.open_or_get_registered_workspace(root.path(), serve_config("/race")),
        );
        assert_eq!(a.expect("first resolves").prefix, "/race");
        assert_eq!(b.expect("second resolves").prefix, "/race");
        assert_eq!(
            host.mounted_prefixes().expect("prefixes"),
            vec!["/race".to_string()],
            "exactly one tenant mounted despite the race"
        );
    }

    #[tokio::test]
    async fn close_for_root_waits_for_inflight_registration_then_unmounts() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let key = lib
            .register_workspace(root.path())
            .expect("register")
            .root_path
            .to_string_lossy()
            .into_owned();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let host = Arc::new(WorkspaceHost::new(
            lib,
            Arc::new(GatedWorkspaceBuilder {
                entered: std::sync::Mutex::new(Some(entered_tx)),
                release: Arc::clone(&release),
            }),
        ));
        let overlay = Arc::new(WorkspaceOverlay::open(cfg.path().join("workspaces.json")));
        overlay.set(&key, true);
        host.install_workspace_overlay(Arc::clone(&overlay));

        let mount_host = Arc::clone(&host);
        let mount_root = root.path().to_path_buf();
        let mount = tokio::spawn(async move {
            mount_host
                .open_or_get_registered_workspace(mount_root, serve_config("/inflight"))
                .await
        });
        entered_rx.await.expect("tenant build entered");

        let mut close = std::pin::pin!(host.close_workspace_for_root(root.path(), false));
        let close_was_pending = std::future::poll_fn(|cx| {
            let pending = std::future::Future::poll(close.as_mut(), cx).is_pending();
            std::task::Poll::Ready(pending)
        })
        .await;
        assert!(
            close_was_pending,
            "close bypassed the in-flight registration boundary"
        );

        release.add_permits(1);
        mount
            .await
            .expect("mount task")
            .expect("in-flight mount completes");
        assert!(close.await.expect("close after mount").completed());
        assert!(host.mounted_prefixes().expect("prefixes").is_empty());
        let row = overlay
            .entries()
            .into_iter()
            .find(|row| row.path == key)
            .expect("overlay row");
        assert!(!row.desired_on, "the serialized close persists off");
    }

    // The removal this simulates cannot be constructed on Windows:
    // Workspace::open holds an open handle on the writer lock inside the
    // root, and Windows refuses to delete a tree with open handles, so the
    // harness's own remove_dir_all fails with a sharing violation before the
    // scenario exists.
    #[cfg(unix)]
    #[tokio::test]
    async fn mount_rejects_root_removed_while_tenant_builds() {
        let cfg = tempfile::tempdir().expect("config dir");
        let parent = tempfile::tempdir().expect("workspace parent");
        let root = parent.path().join("workspace");
        std::fs::create_dir(&root).expect("workspace");
        std::fs::write(root.join("note.md"), "# still booting\n").expect("seed workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let registered_root = lib.register_workspace(&root).expect("register").root_path;
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let host = Arc::new(WorkspaceHost::new(
            lib,
            Arc::new(GatedWorkspaceBuilder {
                entered: std::sync::Mutex::new(Some(entered_tx)),
                release: Arc::clone(&release),
            }),
        ));

        let mount_host = Arc::clone(&host);
        let mount_root = root.clone();
        let mount = tokio::spawn(async move {
            mount_host
                .open_or_get_registered_workspace(mount_root, serve_config("/vanished"))
                .await
        });
        entered_rx
            .await
            .expect("workspace opened and tenant build entered");

        // The root disappears after Workspace::open acquired its capability
        // handle and writer lock, but before the tenant can be published.
        std::fs::remove_dir_all(&root).expect("remove harness-owned workspace");
        assert!(!root.exists(), "test root survived recursive deletion");
        release.add_permits(1);

        let error = mount
            .await
            .expect("mount task")
            .expect_err("a vanished root must not publish a running tenant");
        assert!(
            matches!(
                error,
                Error::Core(ChanError::WorkspaceRootMissing(ref missing))
                    if missing == &registered_root
            ),
            "unexpected mount error: {error}"
        );
        assert!(
            host.mounted_prefixes().expect("prefixes").is_empty(),
            "deleted root was published as a tenant"
        );
        assert!(!root.exists(), "failed mount recreated the workspace root");
    }

    #[tokio::test]
    async fn open_terminal_session_mounts_slim_tenant() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        // No workspace path, no registration: a terminal tenant is
        // backed by nothing but the embedded host.
        host.open_terminal_session(serve_config("/terminal-x"), None)
            .await
            .expect("open terminal session");

        let app = host.router();

        // A workspace-free terminal-surface route is mounted and
        // reachable. `build-info` is state-free, so it serves 200 even
        // with no workspace cell. (`/api/health` is mounted too but
        // reports 503 on a terminal tenant since it snapshots the
        // absent indexer -- mounted, but workspace-dependent.)
        let build_info = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/terminal-x/api/build-info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(build_info.status(), StatusCode::OK);

        // A tenant with no standalone Files state refuses the filesystem
        // surface with 404 rather than reaching for its missing workspace.
        let files = app
            .oneshot(
                Request::builder()
                    .uri("/terminal-x/api/fs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(files.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn open_terminal_session_rejects_duplicate_prefix() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        host.open_terminal_session(serve_config("/terminal-1"), None)
            .await
            .expect("open first terminal");
        // Same prefix is refused by the shared duplicate-prefix guard.
        let err = host
            .open_terminal_session(serve_config("/terminal-1"), None)
            .await
            .expect_err("duplicate prefix must be rejected");
        assert!(matches!(err, Error::Config(_)));
    }

    #[tokio::test]
    async fn open_terminal_session_with_command_mounts_tenant() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        // A command-carrying terminal tenant mounts like a default-shell
        // one; the command becomes the tenant's PTY default (the running of
        // it is covered by the registry tests).
        host.open_terminal_session_with_command(
            serve_config("/terminal-cmd"),
            Some("printf hi".into()),
            None,
        )
        .await
        .expect("open terminal session with command");

        let app = host.router();
        let build_info = app
            .oneshot(
                Request::builder()
                    .uri("/terminal-cmd/api/build-info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(build_info.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn terminal_tenant_scrollback_empty_when_no_output() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        // No tenant mounted at the prefix -> empty (no panic).
        assert!(host.terminal_tenant_scrollback("/absent").is_empty());

        // A mounted terminal tenant with no session opened yet -> empty.
        // (The actual byte capture is covered by the registry's
        // `all_scrollback` test, which drives a session.)
        host.open_terminal_session(serve_config("/term-sb"), None)
            .await
            .expect("open terminal tenant");
        assert!(host.terminal_tenant_scrollback("/term-sb").is_empty());
    }

    #[tokio::test]
    async fn close_terminal_tenant_reaps_ptys_and_frees_the_prefix() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));

        host.open_terminal_session(serve_config("/control"), None)
            .await
            .expect("open terminal tenant");

        // Start a real PTY on the tenant's registry, standing in for the
        // connect script the desktop runs in a control terminal. Reach the
        // registry through the host's private map (same crate module).
        let registry = {
            let workspaces = host.workspaces.read().expect("host lock");
            workspaces
                .get("/control")
                .expect("tenant mounted")
                .artifacts
                .terminal_sessions
                .clone()
        };
        registry
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                profile: None,
                env: Default::default(),
            })
            .expect("spawn control PTY");
        assert_eq!(registry.len(), 1, "one live PTY before close");

        // Closing the tenant reaps the PTY synchronously: the registry is
        // already drained on return, not eventually via the prune task. This
        // An explicit Disconnect must stop the script now.
        assert!(host
            .close_terminal_tenant("/control")
            .await
            .expect("close terminal tenant"));
        assert_eq!(registry.len(), 0, "PTY reaped on tenant close");

        // The prefix tore down cleanly and can be re-mounted at once.
        host.open_terminal_session(serve_config("/control"), None)
            .await
            .expect("remount after close");

        // An absent prefix is a no-op false, so Disconnect/Forget is
        // idempotent (a second teardown call doesn't error).
        assert!(!host
            .close_terminal_tenant("/absent")
            .await
            .expect("absent close is false"));
    }

    #[tokio::test]
    async fn tenant_terminal_session_count_tracks_live_ptys() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_terminal_session(serve_config("/count"), None)
            .await
            .expect("open terminal tenant");

        // A mounted tenant with no PTYs and an absent prefix both count zero.
        assert_eq!(host.tenant_terminal_session_count("/count"), 0);
        assert_eq!(host.tenant_terminal_session_count("/absent"), 0);

        // A live PTY lifts the count: this is what the off path consults to
        // refuse a terminal-killing unmount unless the caller forces it.
        let registry = {
            let workspaces = host.workspaces.read().expect("host lock");
            workspaces
                .get("/count")
                .expect("tenant mounted")
                .artifacts
                .terminal_sessions
                .clone()
        };
        registry
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                profile: None,
                env: Default::default(),
            })
            .expect("spawn PTY");
        assert_eq!(host.tenant_terminal_session_count("/count"), 1);
    }

    #[tokio::test]
    async fn close_workspace_refuses_live_terminals_until_forced() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/ws"))
            .await
            .expect("open");

        let registry = {
            let workspaces = host.workspaces.read().expect("host lock");
            workspaces
                .get("/ws")
                .expect("workspace mounted")
                .artifacts
                .terminal_sessions
                .clone()
        };
        registry
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                profile: None,
                env: Default::default(),
            })
            .expect("spawn PTY");

        assert_eq!(
            host.close_workspace("/ws", false).await.expect("close"),
            WorkspaceLifecycleOutcome::Refused {
                active_terminals: 1
            }
        );
        assert!(host.is_root_mounted(root.path()));
        assert_eq!(
            host.workspace_status(root.path()),
            (WorkspaceStatus::Running, None)
        );

        assert!(host
            .close_workspace("/ws", true)
            .await
            .expect("force close")
            .completed());
        assert!(!host.is_root_mounted(root.path()));
    }

    #[tokio::test]
    async fn remove_workspace_refuses_live_terminals_and_keeps_registration() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/ws"))
            .await
            .expect("open");

        let registry = {
            let workspaces = host.workspaces.read().expect("host lock");
            workspaces
                .get("/ws")
                .expect("workspace mounted")
                .artifacts
                .terminal_sessions
                .clone()
        };
        registry
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                profile: None,
                env: Default::default(),
            })
            .expect("spawn PTY");

        assert_eq!(
            host.remove_workspace_for_root(root.path(), false)
                .await
                .expect("remove"),
            WorkspaceLifecycleOutcome::Refused {
                active_terminals: 1
            }
        );
        assert!(host.is_root_mounted(root.path()));
        assert!(
            host.library()
                .list_workspaces()
                .iter()
                .any(|ws| canonical_key(&ws.root_path) == canonical_key(root.path())),
            "refused remove keeps the registration"
        );

        assert!(host
            .remove_workspace_for_root(root.path(), true)
            .await
            .expect("force remove")
            .completed());
        assert!(host.library().list_workspaces().is_empty());
    }

    // Runs on Windows too since the library answers the startup DSR itself;
    // before that, ConPTY's own cursor-position query went unanswered in a
    // headless run and the spawned `exit 7` never started.
    #[tokio::test]
    async fn terminal_tenant_last_exit_reports_the_script_exit_code() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_terminal_session(serve_config("/ctl"), None)
            .await
            .expect("open terminal tenant");

        // No PTY spawned yet (and an absent tenant): nothing has exited.
        assert!(host.terminal_tenant_last_exit("/ctl").is_none());
        assert!(host.terminal_tenant_last_exit("/absent").is_none());

        // A PTY that exits non-zero stands in for a FAILING connect script.
        let registry = {
            let workspaces = host.workspaces.read().expect("host lock");
            workspaces
                .get("/ctl")
                .expect("tenant mounted")
                .artifacts
                .terminal_sessions
                .clone()
        };
        registry
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("exit 7".to_string()),
                profile: None,
                env: Default::default(),
            })
            .expect("spawn exiting PTY");

        // Poll the exit code the way the desktop scrape loop would. The
        // ceiling is 30 seconds because PowerShell's cold start on a loaded
        // Windows runner takes several seconds before `exit` even runs. On
        // timeout the assertion carries the tenant scrollback, which is the
        // diagnosis: empty means the child never produced output, a shell
        // banner or prompt means it started and never ran the command.
        let mut exit = None;
        for _ in 0..1200 {
            if let Some(c) = host.terminal_tenant_last_exit("/ctl") {
                exit = Some(c);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert_eq!(
            exit,
            Some(TerminalExit::Code { code: 7 }),
            "the failing script's exit code surfaces; scrollback: {:?}",
            String::from_utf8_lossy(&host.terminal_tenant_scrollback("/ctl"))
        );
        assert!(host
            .close_terminal_tenant("/ctl")
            .await
            .expect("close tenant"));
        assert!(host.terminal_tenant_last_exit("/ctl").is_none());
    }

    #[tokio::test]
    async fn cancel_all_reindex_is_safe_across_tenants() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root_a = tempfile::tempdir().expect("workspace a");
        let root_b = tempfile::tempdir().expect("workspace b");
        std::fs::write(root_a.path().join("a.md"), "# A\n").expect("write a");
        std::fs::write(root_b.path().join("b.md"), "# B\n").expect("write b");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root_a.path()).expect("register a");
        lib.register_workspace(root_b.path()).expect("register b");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_registered_workspace(root_a.path(), serve_config("/a"))
            .await
            .expect("open a");
        host.open_registered_workspace(root_b.path(), serve_config("/b"))
            .await
            .expect("open b");
        // A terminal tenant has no workspace cell; cancelling must skip it
        // without panicking.
        host.open_terminal_session(serve_config("/term"), None)
            .await
            .expect("open terminal tenant");

        // Cancels every workspace tenant's indexer across the map.
        host.cancel_all_reindex();

        // Idempotent: still a no-op after a tenant is closed, and with an
        // empty map.
        assert!(host
            .close_workspace("/a", false)
            .await
            .expect("close a")
            .completed());
        host.cancel_all_reindex();
    }

    #[test]
    fn path_prefix_matching_uses_segment_boundaries() {
        assert!(path_matches_prefix("/workspace", "/workspace"));
        assert!(path_matches_prefix(
            "/workspace/api/workspace",
            "/workspace"
        ));
        assert!(!path_matches_prefix(
            "/driveway/api/workspace",
            "/workspace"
        ));
        assert!(path_matches_prefix("/anything", ""));
    }

    #[test]
    fn assemble_window_records_joins_registry_with_live_state() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());

        // No registry installed: the window set is empty.
        assert!(host.assemble_window_records().is_empty());

        // Install a registry + identity, then mint a terminal and an (unmounted)
        // workspace window.
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        let term = registry.create(WindowKind::Terminal, None);
        let ws = registry.create(WindowKind::Workspace, Some("/tmp/notes".into()));
        host.install_window_registry(registry, "lib-abc".into());

        // The off (unmounted) workspace window is FILTERED out of the live feed:
        // its record is preserved on disk, hidden until the workspace is ON;
        // only the terminal shows.
        let records = host.assemble_window_records();
        assert_eq!(records.len(), 1, "off workspace filtered; terminal stays");
        assert!(
            !records.iter().any(|r| r.window_id == ws.window_id),
            "off workspace window is hidden from the live feed"
        );
        // The terminal row is stamped with the library id and persisted. No
        // terminal tenant is mounted here, so it has no live prefix/token and is
        // not connected; durable fields carry through. (When the shared tenant IS
        // mounted it resolves -- see
        // `assemble_resolves_a_terminal_window_to_the_shared_tenant`.)
        assert!(records
            .iter()
            .all(|r| r.library_id == "lib-abc" && r.persisted));
        let term_rec = records
            .iter()
            .find(|r| r.window_id == term.window_id)
            .expect("terminal row");
        assert_eq!(term_rec.kind, WindowKind::Terminal);
        assert_eq!(term_rec.prefix, "");
        assert_eq!(term_rec.token, "");
        assert!(!term_rec.connected);
        assert_eq!(term_rec.title, term.title);
    }

    #[tokio::test]
    async fn control_window_mints_under_foreign_id_resolves_local_tenant_and_reaps() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());
        let store = tempfile::tempdir().expect("store dir");
        host.install_window_registry(
            Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
            "local".into(),
        );

        // Mount the LOCAL control tenant (the connect script lives here), then
        // mint the control window tagged with the FOREIGN devserver library_id.
        host.open_terminal_session_with_command(
            serve_config("/control-0"),
            Some("sleep 30".into()),
            None,
        )
        .await
        .expect("mount control tenant");
        let rec = host
            .mint_control_window(
                "control-terminal-ds1".into(),
                "lib-remote".into(),
                "/control-0".into(),
            )
            .expect("mint control window");
        assert!(rec.control);
        assert!(!rec.persisted, "control window is transient");
        assert_eq!(
            rec.library_id, "lib-remote",
            "grouped under the FOREIGN devserver id, not the host's local id"
        );
        assert_eq!(
            rec.prefix, "/control-0",
            "session resolves to the LOCAL control tenant (open routing keys off control)"
        );

        // It rides assemble from the REGISTRY (not desktop synthesis), under the
        // foreign id, alongside the host's own "local" rows.
        let records = host.assemble_window_records();
        let c = records
            .iter()
            .find(|r| r.window_id == "control-terminal-ds1")
            .expect("control row in the feed");
        assert!(c.control && c.library_id == "lib-remote" && !c.persisted);

        // Reap (server-side, on PTY exit): the row leaves the feed AND the control
        // tenant is unmounted (a second close is the idempotent no-op).
        assert!(host.reap_control_window("control-terminal-ds1").await);
        assert!(
            !host
                .assemble_window_records()
                .iter()
                .any(|r| r.window_id == "control-terminal-ds1"),
            "control row reaped from the feed"
        );
        assert!(
            !host
                .close_terminal_tenant("/control-0")
                .await
                .expect("close is idempotent"),
            "reap already unmounted the control tenant"
        );
    }

    #[tokio::test]
    async fn assemble_resolves_a_terminal_window_to_the_shared_tenant() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());

        // Mount the shared terminal tenant (records its prefix), install a
        // registry, then mint a terminal window.
        host.open_terminal_session(serve_config("/terminal"), None)
            .await
            .expect("open terminal session");
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        let term = registry.create(WindowKind::Terminal, None);
        host.install_window_registry(registry, "local".into());

        // The terminal window now resolves to the shared tenant's prefix -- the
        // old empty stub is gone -- so the desktop watcher can open it. (token is
        // empty here only because the test serve_config sets no_token; in
        // production the tenant carries a token so should_show opens the window.)
        let records = host.assemble_window_records();
        let term_rec = records
            .iter()
            .find(|r| r.window_id == term.window_id)
            .expect("terminal row");
        assert_eq!(
            term_rec.prefix, "/terminal",
            "terminal resolves to the shared tenant prefix",
        );
        assert!(
            !term_rec.connected,
            "no live /ws socket for this window yet"
        );
    }

    #[test]
    fn mint_and_discard_window_round_trip() {
        // Minting before a registry is installed is an error, not a panic.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let no_reg = WorkspaceHost::new(lib, fake_builder());
        assert!(no_reg.mint_window(WindowKind::Terminal, None).is_err());

        let cfg2 = tempfile::tempdir().expect("config dir");
        let lib2 = Library::open_at(cfg2.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib2, fake_builder());
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        host.install_window_registry(registry, "lib-mint".into());

        // Mint returns the assembled record, and the row lands in the feed.
        let term = host
            .mint_window(WindowKind::Terminal, None)
            .expect("mint terminal");
        assert_eq!(term.kind, WindowKind::Terminal);
        assert_eq!(term.library_id, "lib-mint");
        assert!(term.persisted);
        let ws = host
            .mint_window(WindowKind::Workspace, Some("/tmp/notes".into()))
            .expect("mint workspace");
        assert_eq!(ws.workspace_path.as_deref(), Some("/tmp/notes"));

        // The terminal lands in the live feed. The unmounted workspace window is
        // minted + persisted but FILTERED out until its workspace is on, so
        // the feed shows only the terminal.
        let ids: Vec<String> = host
            .assemble_window_records()
            .into_iter()
            .map(|r| r.window_id)
            .collect();
        assert_eq!(ids, vec![term.window_id.clone()]);

        // Discard drops the row and reports it existed; a second discard is a
        // no-op (the handler's 404 path), as is an unknown id.
        assert!(host.discard_window(&term.window_id).expect("discard"));
        assert!(!host.discard_window(&term.window_id).expect("re-discard"));
        assert!(!host.discard_window("w-doesnotexist0000").expect("unknown"));

        // Feed now empty: the terminal is discarded and the off workspace window
        // is still filtered. Its record nonetheless persists -- discarding it
        // (the FORGET-style explicit discard) returns true the first time.
        assert!(host.assemble_window_records().is_empty());
        assert!(host.discard_window(&ws.window_id).expect("discard ws"));
        assert!(!host.discard_window(&ws.window_id).expect("re-discard ws"));
    }

    #[test]
    fn first_open_mints_one_terminal_sets_marker_and_persists() {
        // (a) First open on an empty, unmarked registry mints exactly one
        // Terminal window, sets the marker, and persists both.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());
        let store = tempfile::tempdir().expect("store dir");
        let store_path = store.path().join("windows.json");
        let registry = Arc::new(WindowRegistry::open(store_path.clone()));
        host.install_window_registry(registry, "lib-fo".into());

        let minted = host
            .ensure_first_open_terminal()
            .expect("first open")
            .expect("mints exactly one terminal");
        assert_eq!(minted.kind, WindowKind::Terminal);
        let records = host.assemble_window_records();
        assert_eq!(records.len(), 1, "exactly one window after first open");
        assert_eq!(records[0].kind, WindowKind::Terminal);

        // The marker and the window both persist: a fresh registry over the
        // same store sees the window AND the marker set, so a re-run mints none.
        let reopened = WindowRegistry::open(store_path);
        assert!(reopened.first_open_done(), "marker persisted");
        assert_eq!(reopened.snapshot().len(), 1, "window persisted");

        // Calling first-open again on the same host mints nothing (marker set).
        assert!(host
            .ensure_first_open_terminal()
            .expect("re-open")
            .is_none());
        assert_eq!(host.assemble_window_records().len(), 1, "still one window");
    }

    #[test]
    fn first_open_after_marker_and_emptied_registry_mints_none() {
        // (b) The close→reopen rule: once the marker is set, an emptied registry
        // does NOT re-mint, even though it is empty again. Simulate the user
        // having closed their only terminal: marker set, no windows.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        registry.mark_first_open_done();
        assert!(registry.is_empty());
        host.install_window_registry(registry, "lib-emptied".into());

        assert!(
            host.ensure_first_open_terminal().expect("open").is_none(),
            "marker set + empty registry → no re-mint"
        );
        assert!(
            host.assemble_window_records().is_empty(),
            "still no windows"
        );
    }

    #[test]
    fn first_open_with_existing_windows_mints_none() {
        // (c) A registry that already has windows (a fresh library whose boot
        // restored a turned-on workspace, say) gets no extra terminal.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        registry.create(WindowKind::Workspace, Some("/tmp/notes".into()));
        assert!(!registry.first_open_done(), "unmarked, but non-empty");
        host.install_window_registry(registry, "lib-haswins".into());

        assert!(
            host.ensure_first_open_terminal().expect("open").is_none(),
            "non-empty registry → no first-open mint"
        );
        // The pre-existing workspace is unmounted, so its window is filtered from
        // the live feed; crucially, NO first-open terminal was minted into it.
        assert!(
            !host
                .assemble_window_records()
                .iter()
                .any(|r| r.kind == WindowKind::Terminal),
            "no first-open terminal was minted"
        );
    }

    #[test]
    fn first_open_without_registry_is_a_noop() {
        // No registry installed: first-open mints nothing rather than erroring.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());
        assert!(host
            .ensure_first_open_terminal()
            .expect("noop without registry")
            .is_none());
    }

    #[tokio::test]
    async fn discard_window_deletes_the_durable_workspace_session_blob() {
        // P1a: a registry discard is the single authoritative cleanup -- it also
        // deletes the durable workspace session/layout blob, so a non-SPA
        // discard (one that never sends `DELETE /api/session`) never orphans
        // `<chan_home>/workspaces/<metadata_key>/sessions/<id>` on disk.
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace");
        std::fs::write(root.path().join("a.md"), "# A\n").expect("write a");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path()).expect("register");
        let host = Arc::new(WorkspaceHost::new(lib.clone(), fake_builder()));
        host.open_registered_workspace(root.path(), serve_config("/a"))
            .await
            .expect("open");

        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        host.install_window_registry(registry, "lib-blob".into());
        let win = host
            .mint_window(
                WindowKind::Workspace,
                Some(root.path().to_string_lossy().into_owned()),
            )
            .expect("mint workspace window");

        // Reach the tenant's real workspace and write the durable layout blob
        // keyed by the window id (what the SPA would PUT).
        let workspace = {
            let tenants = host.workspaces.read().unwrap();
            tenants
                .values()
                .next()
                .expect("workspace tenant")
                .artifacts
                .cell
                .workspace()
                .expect("real workspace handle")
        };
        workspace
            .put_session(&win.window_id, b"{\"layout\":1}")
            .expect("put session blob");
        assert!(
            workspace
                .get_session(&win.window_id)
                .expect("get")
                .is_some(),
            "blob must exist before discard"
        );

        assert!(host.discard_window(&win.window_id).expect("discard"));

        assert!(
            workspace
                .get_session(&win.window_id)
                .expect("get")
                .is_none(),
            "discard_window must delete the durable session blob"
        );
    }

    #[tokio::test]
    async fn discard_window_fires_the_terminal_blob_reaper() {
        // P1b: discard runs the installed blob reaper so a discarded terminal
        // window's durable layout blob (the chan-server `terminal_blob`, which
        // the host cannot reach directly) is dropped too -- the standalone-
        // terminal analogue of the workspace session-blob delete above.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_terminal_session(serve_config("/api/terminal"), None)
            .await
            .expect("mount shared terminal tenant");
        // Record what the blob reaper is asked to delete (chan-server installs the
        // real one; here we stub it on the shared terminal tenant's registry).
        let reaped: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let tenants = host.workspaces.read().unwrap();
            let sink = Arc::clone(&reaped);
            tenants
                .values()
                .next()
                .expect("shared terminal tenant")
                .artifacts
                .terminal_sessions
                .install_blob_reaper(crate::terminal_sessions::BlobReaper::new(
                    move |window_id: &str| {
                        sink.lock().unwrap().push(window_id.to_string());
                    },
                ));
        }
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        host.install_window_registry(registry, "local".into());
        let rec = host
            .mint_window(WindowKind::Terminal, None)
            .expect("mint terminal");

        assert!(host.discard_window(&rec.window_id).expect("discard"));
        assert_eq!(*reaped.lock().unwrap(), vec![rec.window_id.clone()]);
    }

    #[tokio::test]
    async fn a_burst_of_routed_opens_fills_one_window() {
        // The window a routed open mints has no socket for a second or two,
        // and the next `cs open` of a loop arrives long before it connects. A
        // liveness-only pick would mint a window per file, which is what this
        // remembers not to do.
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_terminal_session(serve_config("/api/terminal"), None)
            .await
            .expect("mount shared terminal tenant");
        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        host.install_window_registry(registry.clone(), "local".into());

        // Nothing open yet: the first routed open has to mint.
        assert_eq!(host.select_standalone_window(), None);
        let first = host
            .mint_window(WindowKind::Terminal, None)
            .expect("mint")
            .window_id;
        host.remember_routed_standalone(&first);

        // The next open lands in that same window even though it never
        // connected, and even with a second (also disconnected) window around.
        let _second = host.mint_window(WindowKind::Terminal, None).expect("mint");
        assert_eq!(host.select_standalone_window(), Some(first.clone()));

        // A window that leaves the registry stops winning: the pick falls back
        // rather than routing into a row that no longer exists.
        registry.remove(&first);
        assert_eq!(host.select_standalone_window(), None);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn fdstore_skip_cleanup_reaps_only_terminal_windows() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
        host.open_terminal_session(serve_config("/api/terminal"), None)
            .await
            .expect("mount shared terminal tenant");

        let reaped: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        {
            let tenants = host.workspaces.read().unwrap();
            let sink = Arc::clone(&reaped);
            tenants
                .values()
                .next()
                .expect("shared terminal tenant")
                .artifacts
                .terminal_sessions
                .install_blob_reaper(crate::terminal_sessions::BlobReaper::new(
                    move |window_id: &str| {
                        sink.lock().unwrap().push(window_id.to_string());
                    },
                ));
        }

        let store = tempfile::tempdir().expect("store dir");
        let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
        host.install_window_registry(registry.clone(), "local".into());
        let term = host
            .mint_window(WindowKind::Terminal, None)
            .expect("mint terminal");
        let workspace = host
            .mint_window(WindowKind::Workspace, Some("/tmp/fdstore-notes".into()))
            .expect("mint workspace");
        let skipped = vec![
            crate::terminal_sessions::FdStoreSkippedSession {
                tenant_prefix: "/api/terminal".into(),
                session_id: "s-term".into(),
                window_id: Some(term.window_id.clone()),
                child_pid: Some(4242),
                reason: "fd was not inherited".into(),
            },
            crate::terminal_sessions::FdStoreSkippedSession {
                tenant_prefix: "/workspace".into(),
                session_id: "s-workspace".into(),
                window_id: Some(workspace.window_id.clone()),
                child_pid: Some(4243),
                reason: "fd was not inherited".into(),
            },
        ];
        let cleanup = host.cleanup_skipped_fdstore_sessions(&skipped);

        assert!(cleanup.iter().any(|line| line.contains(&term.window_id)));
        let rows = registry.snapshot();
        assert!(!rows.iter().any(|row| row.window_id == term.window_id));
        assert!(rows.iter().any(|row| row.window_id == workspace.window_id));
        assert_eq!(*reaped.lock().unwrap(), vec![term.window_id.clone()]);

        let term2 = host
            .mint_window(WindowKind::Terminal, None)
            .expect("mint second terminal");
        let cleanup = host.cleanup_fdstore_metadata_loss_terminal_windows();
        assert!(cleanup.iter().any(|line| line.contains(&term2.window_id)));
        let rows = registry.snapshot();
        assert!(!rows.iter().any(|row| row.window_id == term2.window_id));
        assert!(rows.iter().any(|row| row.window_id == workspace.window_id));
    }

    #[tokio::test]
    async fn terminal_window_persists_in_shared_tenant_uniformly() {
        // A Terminal window's session lives in the shared terminal tenant and is
        // auto-opened (it never PUTs a layout blob), so every library marks it
        // persisted at mint -- local and devserver alike, no library_id branch  --
        // and the orphan-grace pruner spares its session on a disconnect. Returns
        // whether the minted terminal window is persisted in the shared tenant.
        async fn mint_terminal_marks_persisted(library_id: &str) -> bool {
            let cfg = tempfile::tempdir().expect("config dir");
            let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
            let host = Arc::new(WorkspaceHost::new(lib, fake_builder()));
            // Mount the shared terminal tenant (records terminal_tenant_prefix),
            // matching the devserver startup path.
            host.open_terminal_session(serve_config("/api/terminal"), None)
                .await
                .expect("mount shared terminal tenant");
            let store = tempfile::tempdir().expect("store dir");
            let registry = Arc::new(WindowRegistry::open(store.path().join("windows.json")));
            host.install_window_registry(registry, library_id.into());
            let rec = host
                .mint_window(WindowKind::Terminal, None)
                .expect("mint terminal");
            // The shared terminal tenant is the only mount; inspect its registry.
            // Bind the read guard so it drops before `host` at fn end.
            let tenants = host.workspaces.read().unwrap();
            tenants
                .values()
                .next()
                .expect("shared terminal tenant")
                .artifacts
                .terminal_sessions
                .is_window_persisted(&rec.window_id)
        }

        assert!(
            mint_terminal_marks_persisted("lib-test").await,
            "devserver terminal window must be persisted in the shared terminal tenant"
        );
        assert!(
            mint_terminal_marks_persisted("local").await,
            "local terminal window must ALSO be persisted (uniform, no library_id branch)"
        );
    }

    /// A fixed-value `LocalColorStore` for the `pane_color` resolution test.
    struct FixedLocalColor(Option<String>);
    impl LocalColorStore for FixedLocalColor {
        fn get(&self) -> Option<String> {
            self.0.clone()
        }
        fn set(&self, _color: Option<String>) -> Result<(), String> {
            Ok(())
        }
    }

    /// A `DevserverFeedSource` that resolves one library's colour through
    /// `pane_color`; windows/workspaces are inert (unused by this test).
    struct FixedFeed {
        library_id: String,
        color: String,
    }
    impl DevserverFeedSource for FixedFeed {
        fn windows(&self) -> Vec<WindowRecord> {
            Vec::new()
        }
        fn workspaces(&self) -> Vec<LauncherWorkspace> {
            Vec::new()
        }
        fn pane_color(&self, library_id: &str) -> Option<String> {
            (library_id == self.library_id).then(|| self.color.clone())
        }
    }

    #[test]
    fn pane_color_resolves_local_from_store_and_devserver_from_feed() {
        let cfg = tempfile::tempdir().expect("config dir");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        let host = WorkspaceHost::new(lib, fake_builder());

        // Nothing installed: every lookup is the default accent (None).
        assert_eq!(host.pane_color("local"), None);
        assert_eq!(host.pane_color("lib-abc"), None);

        host.install_local_color_store(Arc::new(FixedLocalColor(Some("#111".into()))));
        host.install_devserver_feed(Arc::new(FixedFeed {
            library_id: "lib-abc".into(),
            color: "#abc".into(),
        }));

        // "local" → the local-colour store; a devserver lib id → that devserver's
        // own colour, surfaced through the feed (NOT a desktop-side field).
        assert_eq!(host.pane_color("local"), Some("#111".into()));
        assert_eq!(host.pane_color("lib-abc"), Some("#abc".into()));
        // An unknown devserver library id falls back to the default accent.
        assert_eq!(host.pane_color("lib-missing"), None);
    }

    #[cfg(target_os = "linux")]
    mod fdstore_host {
        use super::*;
        use crate::terminal_sessions::{
            CreateOptions, FdStorePark, FdStoreParker, Registry as TerminalRegistry,
        };
        use portable_pty::PtySize;

        #[derive(Default)]
        struct HostProbeState {
            host: std::sync::Mutex<Option<Arc<WorkspaceHost>>>,
            calls: std::sync::Mutex<Vec<String>>,
            snapshot_seen: std::sync::Mutex<Vec<String>>,
        }

        #[derive(Clone, Default)]
        struct HostProbePark(Arc<HostProbeState>);

        impl HostProbePark {
            fn parker(&self) -> FdStoreParker {
                FdStoreParker::new(self.clone())
            }

            fn calls(&self) -> Vec<String> {
                self.0.calls.lock().unwrap().clone()
            }
        }

        impl FdStorePark for HostProbePark {
            fn park(&self, fd_name: &str, _fd: std::os::fd::BorrowedFd<'_>) -> bool {
                // The devserver commit path: snapshot HOST-wide from inside
                // the hook. This re-enters both the workspaces RwLock and
                // the registry sessions mutex, so completing at all proves
                // the caller holds neither.
                if let Some(host) = self.0.host.lock().unwrap().clone() {
                    let seen: Vec<String> = host
                        .fdstore_manifest_sessions()
                        .into_iter()
                        .map(|entry| entry.fd_name)
                        .collect();
                    self.0.snapshot_seen.lock().unwrap().extend(seen);
                }
                self.0.calls.lock().unwrap().push(format!("park:{fd_name}"));
                true
            }

            fn unpark(&self, fd_name: &str) {
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push(format!("unpark:{fd_name}"));
            }

            fn adopt(&self, _fd_name: &str) -> bool {
                true
            }

            fn changed(&self) {
                self.0.calls.lock().unwrap().push("changed".to_string());
            }
        }

        fn host_with_terminal_runtime() -> (Arc<WorkspaceHost>, Arc<TerminalRegistry>) {
            let cfg = tempfile::tempdir().expect("config dir");
            let library = Library::open_at(cfg.path().join("config.toml")).expect("library");
            std::mem::forget(cfg);
            let host = Arc::new(WorkspaceHost::new(library, fake_builder()));
            let artifacts = fake_artifacts(Router::new(), Arc::new(FakeTerminalCell));
            let registry = artifacts.terminal_sessions.clone();
            host.workspaces.write().expect("host map").insert(
                "/terminal".to_string(),
                HostedWorkspaceRuntime {
                    root: PathBuf::from("/"),
                    handle: ServeHandle {
                        addr: ([127, 0, 0, 1], 0).into(),
                        prefix: "/terminal".to_string(),
                        token: None,
                    },
                    artifacts,
                },
            );
            (host, registry)
        }

        fn windowed_opts(window_id: &str, command: Option<&str>) -> CreateOptions {
            CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: Some(window_id.to_string()),
                mcp_env: false,
                cwd: Some(std::env::temp_dir()),
                command: command.map(str::to_string),
                env: Default::default(),
                profile: None,
            }
        }

        /// The activation reconcile must not hold the workspaces lock (nor
        /// any registry lock) across the park callback: the callback
        /// re-enters both for its manifest snapshot, and the snapshot must
        /// already see the session being parked.
        #[tokio::test]
        async fn activation_reconcile_parks_without_lock_recursion() {
            let hook = HostProbePark::default();
            let (host, registry) = host_with_terminal_runtime();
            *hook.0.host.lock().unwrap() = Some(host.clone());

            // Spawn BEFORE the parker exists (the pre-activation boot
            // window), so the reconcile below is what parks it.
            let windowed = registry
                .create(windowed_opts("w1", None))
                .expect("windowed create");
            registry.install_fd_parker(hook.parker());
            assert!(hook.calls().is_empty(), "nothing may park before reconcile");

            host.park_unparked_windowed_terminal_sessions();

            let parks: Vec<String> = hook
                .calls()
                .into_iter()
                .filter(|c| c.starts_with("park:"))
                .collect();
            assert_eq!(parks.len(), 1, "reconcile must park the boot spawn once");
            let name = parks[0].strip_prefix("park:").unwrap().to_string();
            let seen = hook.0.snapshot_seen.lock().unwrap().clone();
            assert!(
                seen.contains(&name),
                "the in-callback host-wide snapshot must see the session \
                 being parked (and completing at all proves no host or \
                 registry lock was held across the callback): {seen:?}"
            );

            // A second reconcile is a no-op: everything is parked already.
            host.park_unparked_windowed_terminal_sessions();
            assert_eq!(
                hook.calls()
                    .iter()
                    .filter(|c| c.starts_with("park:"))
                    .count(),
                1,
                "reconcile re-parked an already-parked session"
            );
            drop(windowed);
            registry.close_all(crate::terminal_sessions::CloseReason::Shutdown);
        }

        /// Placement updates republish the manifest: crash restore must not
        /// resurrect an arbitrarily old pane placement.
        #[tokio::test]
        async fn placement_updates_notify_the_parker() {
            let hook = HostProbePark::default();
            let (_host, registry) = host_with_terminal_runtime();
            registry.install_fd_parker(hook.parker());

            let handle = registry
                .create(windowed_opts("w1", None))
                .expect("windowed create");
            let id = handle.id().to_string();
            let before = hook.calls().iter().filter(|c| *c == "changed").count();

            assert!(registry.update_session_layout(
                &id,
                Some("pane-1".into()),
                None,
                Some("tab-1".into()),
            ));
            let after = hook.calls().iter().filter(|c| *c == "changed").count();
            assert!(
                after > before,
                "placement update did not republish the manifest"
            );
            registry.close_all(crate::terminal_sessions::CloseReason::Shutdown);
        }

        /// Drain kills a REAL child and only reports it dead once its pid is
        /// fully reaped; a zombie still counts as running.
        #[tokio::test]
        async fn drain_confirms_a_real_child_death() {
            let (host, registry) = host_with_terminal_runtime();
            let _handle = registry
                .create(windowed_opts("w1", Some("exec sleep 600")))
                .expect("windowed create");
            let pid = registry.live_child_pids();
            assert_eq!(pid.len(), 1, "expected one live child");

            let outcome = host.drain_terminal_sessions().await;
            assert_eq!(outcome.closed, 1);
            assert_eq!(outcome.dead, 1, "lingering: {:?}", outcome.lingering);
            assert!(outcome.lingering.is_empty());
        }

        /// A successful restore ADOPTS its retained store entry (no second
        /// store call) and lands in the manifest snapshot -- the exact set
        /// the activation rewrite serializes after apply.
        #[tokio::test]
        async fn restore_adopts_into_the_activation_manifest_set() {
            let hook = HostProbePark::default();
            let (host, registry) = host_with_terminal_runtime();
            registry.install_fd_parker(hook.parker());
            let windows = tempfile::tempdir().expect("windows dir");
            host.install_window_registry(
                Arc::new(WindowRegistry::open(windows.path().join("windows.json"))),
                "lib-test".into(),
            );
            let row = host
                .mint_window(WindowKind::Terminal, None)
                .expect("terminal window");

            let pty = portable_pty::native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("openpty");
            let raw = pty.master.as_raw_fd().expect("master raw fd");
            let master_fd = crate::terminal_sessions::clone_master_fd(raw).expect("dup master");
            let meta = crate::terminal_sessions::FdStoreSessionMeta {
                tenant_prefix: "/terminal".into(),
                session_id: "restored1".into(),
                tab_name: None,
                tab_group: None,
                spawn_name: None,
                spawn_group: None,
                window_id: Some(row.window_id.clone()),
                pane_id: None,
                side: None,
                tab_id: None,
                cwd: None,
                command: None,
                env: Default::default(),
                profile: None,
                mcp_env: false,
                child_pid: Some(4242),
                size: crate::terminal_sessions::StoredPtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                seq: 3,
                generation: 1,
                alt_screen: false,
                private_modes: Vec::new(),
            };
            let expected_name = crate::terminal_sessions::fdstore_fd_name("restored1", Some(4242));
            let report = host.restore_fdstore_terminal_sessions(vec![
                crate::terminal_sessions::FdStoreSessionImport {
                    meta,
                    master_fd,
                    replay: b"replay".to_vec(),
                },
            ]);
            assert_eq!(report.restored, 1, "skipped: {:?}", report.skipped);

            let calls = hook.calls();
            assert!(
                !calls.iter().any(|c| c.starts_with("park:")),
                "adoption must not re-store a retained fd: {calls:?}"
            );
            let manifested: Vec<String> = host
                .fdstore_manifest_sessions()
                .into_iter()
                .map(|entry| entry.fd_name)
                .collect();
            assert_eq!(
                manifested,
                vec![expected_name],
                "the adopted session must be in the activation write set"
            );
            registry.close_all(crate::terminal_sessions::CloseReason::Shutdown);
        }

        /// A child the liveness probe never sees die is reported lingering,
        /// not silently claimed dead.
        #[tokio::test]
        async fn drain_reports_forced_lingering_honestly() {
            let (host, registry) = host_with_terminal_runtime();
            let _handle = registry
                .create(windowed_opts("w1", Some("exec sleep 600")))
                .expect("windowed create");
            let pids = registry.live_child_pids();
            assert_eq!(pids.len(), 1);

            let outcome = host
                .drain_terminal_sessions_with(|_| true, Duration::from_millis(300))
                .await;
            assert_eq!(outcome.closed, 1);
            assert_eq!(outcome.dead, 0);
            assert_eq!(outcome.lingering, pids);
        }
    }
}
