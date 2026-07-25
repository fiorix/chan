//! The seams between the library core and the route layer that builds tenants.
//!
//! Two traits keep `chan-server → chan-library` acyclic while the host and the
//! control socket live here:
//!
//! - [`WorkspaceCellHandle`] -- how the host and the control socket reach a
//!   tenant's live workspace + its indexer, without naming `chan-server`'s
//!   `WorkspaceCell` / `Indexer` (which stay in the route layer). The route
//!   layer hands back an `Arc<dyn WorkspaceCellHandle>` over the shared cell.
//! - [`HostControl`] -- the slice of the host a control-socket connection
//!   reaches through a `Weak` back-reference: unmount a tenant (`chan close`)
//!   and read the library window set (`cs window list`). Lets the control
//!   socket hold `Weak<dyn HostControl>` instead of a concrete `WorkspaceHost`.

use std::any::Any;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock, Weak};

use async_trait::async_trait;
use chan_workspace::{Library, Workspace};
use tokio::sync::{broadcast, watch};

use crate::desktop_window_ops::DesktopBridge;
use crate::session_presence::SessionRegistry;
use crate::terminal_sessions::Registry as TerminalRegistry;
use crate::window_presence::WindowPresence;
use crate::window_transfers::WindowTransfers;
use crate::windows::WindowRecord;
use crate::{Error, ServeConfig, WorkspaceLifecycleOutcome};

/// A handle to one tenant's live workspace cell, owned by the route layer
/// (it wraps `chan-server`'s `WorkspaceCell`, which holds the search indexer).
/// The host drives tenant teardown + reindex cancellation through this without
/// depending on the route layer's concrete cell type.
pub trait WorkspaceCellHandle: Send + Sync {
    /// The live `Arc<Workspace>`, or `None` for a terminal-only tenant or the
    /// brief `/api/storage/reset` swap window.
    fn workspace(&self) -> Option<Arc<Workspace>>;

    /// Cancel any in-flight reindex (host shutdown / `cancel_all_reindex`).
    fn cancel_reindex(&self);

    /// Tear the cell down -- cancel the indexer, drop the watcher + the strong
    /// `Arc<Workspace>` -- and return a `Weak` to the workspace plus its lock
    /// directory so the host can wait for the per-workspace flock to release
    /// before an immediate reopen. `None` when the cell was already cleared.
    fn clear(&self) -> Option<(Weak<Workspace>, PathBuf)>;
}

/// The host operations a control-socket connection reaches through a `Weak`
/// back-reference (`WorkspaceHost` registers itself via `install_self`). Held
/// as `Weak<dyn HostControl>` so the control socket never names the concrete
/// host type.
pub trait HostControl: Send + Sync {
    /// Unmount the hosted tenant whose root matches `root` (the `chan close`
    /// over-the-host path).
    fn close_workspace_for_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error>;

    /// Remove the workspace at `root` from this host: unmount it, UNREGISTER it
    /// from the host library, and forget it from the on/off overlay -- the
    /// over-the-control-socket equivalent of the launcher's `DELETE
    /// /api/library/workspaces/{id}` (`chan close --remove` / `chan workspace
    /// rm` of a workspace this host serves). Runs IN the host process so the
    /// host's in-memory library + the persisted overlay both reflect it (a
    /// CLI-local `config.toml` edit would leave the host's caches stale and the
    /// workspace lingering in the launcher / surviving a restart).
    fn remove_workspace_for_root(
        &self,
        root: &Path,
        force: bool,
    ) -> Result<WorkspaceLifecycleOutcome, Error>;

    /// The full library window set -- every window across every tenant, as the
    /// authoritative records `cs window list` and the launcher render. Assembled
    /// from the window registry + live tenant + presence state.
    fn assemble_window_records(&self) -> Vec<WindowRecord>;

    /// Authoritatively discard window `window_id`: drop its persisted registry
    /// row, reap its terminal sessions + layout blob, and fire the window watch
    /// so any live native window closes. `Ok(false)` when this host owns no such
    /// row (e.g. the row lives on a connected devserver). The single cleanup
    /// behind `cs window rm`, reached through the host weak so an offline/dead
    /// row is removable even with no desktop attached.
    fn discard_window(&self, window_id: &str) -> Result<bool, Error>;

    /// How many LIVE terminal sessions window `window_id` owns across this host's
    /// tenants -- the read-only count behind the `cs window rm` `--force` guard, so
    /// a removal that would kill running shells is refused unless forced.
    fn live_terminal_count(&self, window_id: &str) -> usize;
}

/// How a control socket's process tears down the workspace named by a
/// `ControlRequest::Close` -- the server-decides-scope half of `chan close`.
/// The route layer's tenant builder builds it from an [`UnserveMode`] the
/// embedder picks, and it rides in the control socket's context.
#[derive(Clone)]
pub enum UnserveScope {
    /// A standalone `chan open <root>`: unserve of `root` fires the process
    /// graceful-shutdown signal, so the whole process exits and releases the
    /// flock. `root` guards against unserving a path this server does not serve.
    Standalone {
        root: PathBuf,
        shutdown_tx: Arc<watch::Sender<bool>>,
    },
    /// A multi-tenant host (`chan devserver` / chan-desktop) that opted in via
    /// `WorkspaceHost::install_self`: unserve unmounts the matching tenant only
    /// and keeps the process alive. Held as `Weak<dyn HostControl>` so the
    /// control socket never names the concrete host type.
    Host(Weak<dyn HostControl>),
    /// A tenant whose process can't honor a control-socket unserve (a host that
    /// never registered a self-handle, or a standalone terminal with no
    /// workspace): the handler refuses rather than guess.
    Unsupported,
}

/// The embedder's choice of [`UnserveScope`] kind, passed to the tenant builder
/// (which fills in the standalone shutdown handle). A standalone `chan open`
/// passes [`UnserveMode::Standalone`]; a `WorkspaceHost` passes
/// [`UnserveMode::Host`] once it registered its self-handle, else
/// [`UnserveMode::Unsupported`].
pub enum UnserveMode {
    Standalone,
    Host(Weak<dyn HostControl>),
    Unsupported,
}

/// What the route layer hands back per mounted tenant -- everything the host
/// needs to route to it, reconcile its windows, and tear it down. The
/// router-construction boundary: the host owns these; the route layer builds them
/// via [`TenantBuilder`]. This is the ex-`AppArtifacts`, reduced to the
/// host-facing surface, plus an opaque keep-alive for the route-layer pieces
/// the host only owns for lifetime (the MCP bridge, the control socket, the
/// background prune/drain/broadcast tasks).
pub struct TenantArtifacts {
    /// The tenant's axum app, dispatched under its route prefix.
    pub app: axum::Router,
    /// Per-launch bearer for this tenant (`None` with `--no-token`).
    pub token: Option<String>,
    /// The tenant's PTY registry (window-session checks, scrollback, reap).
    pub terminal_sessions: Arc<TerminalRegistry>,
    /// Shutdown signal; the host fires it on tenant close so background tasks
    /// can exit cooperatively. The current raw task handles are not joined.
    pub shutdown_tx: Arc<watch::Sender<bool>>,
    /// SPA-facing URL prefix (tunnel mode swaps it on Connected). Shared Arc
    /// with the tenant's `AppState`.
    pub prefix: Arc<RwLock<String>>,
    /// Which window ids hold a live `/ws` socket -- the `connected` source for
    /// the window-record assembly.
    pub window_presence: Arc<WindowPresence>,
    /// The tenant's session registry (leader + followers). The host reads its
    /// `leader()` to gate leader-only mint/discard/visibility per target tenant
    /// and to publish the per-tenant leaders map in the window watch feed; the
    /// host also installs the aggregate change signal on it so a leader change
    /// wakes that feed.
    pub session_registry: Arc<SessionRegistry>,
    /// The tenant's `/ws` broadcast channel. The host sends targeted
    /// `window_command` teardown frames on it so a discarded / hidden window's
    /// own socket learns its record was torn down and shows the leader-close
    /// overlay (a native desktop window is reconciled away instead).
    pub events_tx: broadcast::Sender<String>,
    /// Per-window in-flight transfer count -- the desktop close handler's
    /// "is a transfer running?" query (`tenant_has_active_transfer`).
    pub window_transfers: Arc<WindowTransfers>,
    /// Reach the tenant's live workspace + drive teardown/reindex-cancel
    /// without naming the route layer's `WorkspaceCell`.
    pub cell: Arc<dyn WorkspaceCellHandle>,
    /// Route-layer pieces the host only owns for the tenant's lifetime (MCP
    /// bridge, control socket, raw background-task handles). Opaque: the host
    /// never calls them. Dropping it unlinks or aborts the custom socket guards;
    /// raw Tokio handles detach after the cooperative shutdown signal.
    pub keepalive: Box<dyn Any + Send + Sync>,
}

/// The route layer's tenant constructor, inverted so `chan-library`'s host
/// drives it without depending on `chan-server`. The route layer
/// (`chan-server`) implements this; the host holds an `Arc<dyn TenantBuilder>`
/// and calls it from `open_*`.
#[async_trait]
pub trait TenantBuilder: Send + Sync {
    /// Build a workspace tenant mounted under `config.prefix`.
    ///
    /// `control_identity` is the host's stable control-socket identity (see
    /// [`WorkspaceHost::install_control_identity`](
    /// crate::WorkspaceHost::install_control_identity)): `Some` makes the
    /// tenant bind its control socket at a path stable across server
    /// restarts, `None` keeps the pid-scoped path of a window-spawned server.
    async fn build_workspace(
        &self,
        library: Library,
        workspace: Arc<Workspace>,
        config: &ServeConfig,
        desktop: DesktopBridge,
        unserve: UnserveMode,
        control_identity: Option<String>,
    ) -> Result<TenantArtifacts, Error>;

    /// Build a workspace-less terminal tenant, optionally running `command` on
    /// its PTYs, with an optional persisted per-window session dir.
    /// `control_identity` as in [`build_workspace`](Self::build_workspace).
    #[allow(clippy::too_many_arguments)]
    async fn build_terminal(
        &self,
        library: Library,
        config: &ServeConfig,
        desktop: DesktopBridge,
        unserve: UnserveMode,
        command: Option<String>,
        session_dir: Option<PathBuf>,
        control_identity: Option<String>,
    ) -> Result<TenantArtifacts, Error>;
}
