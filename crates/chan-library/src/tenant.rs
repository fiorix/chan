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
use std::time::Duration;

use async_trait::async_trait;
use chan_workspace::{Library, Workspace};
use tokio::sync::{broadcast, watch};
use tokio::task::{JoinError, JoinHandle};

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
/// A tenant's standalone filesystem surface, as the host reaches it.
///
/// The host routes but never resolves: when `cs open` names a path outside its
/// workspace, the workspace tenant hands the absolute path to the host, and the
/// host hands it to whichever tenant actually mounted a filesystem. That tenant
/// resolves it through its own capability root and returns the `/ws` frame to
/// deliver, pre-serialized -- chan-library owns neither `MiniWorkspace` nor
/// `WindowCommand`, and does not need to.
///
/// Installed on [`TenantArtifacts`] only by a tenant that constructed the
/// surface, so `Option::is_some` IS the capability answer: no separate probe to
/// keep in sync with the thing it describes.
pub trait StandaloneFiles: Send + Sync {
    /// Resolve `requested` against this tenant's capability root and produce
    /// the frame that opens it in `window_id`, plus the path to name in the
    /// acknowledgement. `Err` when the path cannot be expressed there (outside
    /// the root, unresolvable, non-UTF-8) -- the caller refuses rather than
    /// opening something other than what was named.
    fn open_frame(&self, window_id: &str, requested: &Path) -> Result<StandaloneOpenFrame, String>;
}

/// What [`StandaloneFiles::open_frame`] hands back: the wire frame to deliver
/// and the resolved path, so the acknowledgement can name what was opened
/// without the host parsing the frame.
pub struct StandaloneOpenFrame {
    /// A serialized `/ws` `window_command` frame addressed to the window.
    pub frame: String,
    /// The resolved path, for the acknowledgement text.
    pub path: String,
}

/// host type.
#[async_trait]
pub trait HostControl: Send + Sync {
    /// Unmount the hosted tenant whose root matches `root` (the `chan close`
    /// over-the-host path).
    async fn close_workspace_for_root(
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
    async fn remove_workspace_for_root(
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

    /// The host's reverse-tunnel registry. `cs tunnel` registers here through
    /// this weak while the desktop-dialed WebSocket routes attach on the
    /// host's launcher router; the shared registry is where a tenant-scoped
    /// command and the host-scoped routes meet.
    fn tunnel_registry(&self) -> Arc<chan_revtunnel::server::TunnelRegistry>;

    /// Open `requested` -- an absolute path outside the calling workspace -- in
    /// a standalone window of this host, reusing a live one and minting one
    /// when there is none. The workspace tenant calls this INSTEAD of refusing
    /// an escaping `cs open`, and never resolves the path itself: only the
    /// tenant that mounted a filesystem knows what that path means.
    ///
    /// `Err` when this host serves no filesystem surface, when the path cannot
    /// be expressed there, or when no window could be minted. Async because
    /// raising the target window goes through the desktop bridge.
    async fn open_outside_workspace(
        &self,
        requested: &Path,
        caller_window_id: &str,
    ) -> Result<OpenOutsideAck, Error>;
}

/// The outcome of [`HostControl::open_outside_workspace`], for the CLI line.
pub struct OpenOutsideAck {
    /// The resolved path, as the standalone surface spells it.
    pub path: String,
    /// The window the open went to.
    pub window_id: String,
    /// True when that window was minted for this open (so it has no socket yet
    /// and the frame was parked for its first attach).
    pub minted: bool,
    /// The workspace this path belongs to, when the library already serves one
    /// containing it. Named in the acknowledgement so the user knows an indexed
    /// view exists; the open still lands on the machine surface.
    pub inside_workspace: Option<String>,
    /// Where the window the file went to can be reached, when it was MINTED by
    /// a browser-origin caller: the surface that asked for it is the one that
    /// has to open it, and a browser tab is what a desktop window is there. The
    /// tenant prefix and bearer, so the calling page can compose a URL against
    /// its own origin (which behind a gateway the server cannot know).
    pub open_in_browser: Option<BrowserWindowTarget>,
}

/// Enough for a browser tab to be opened onto a freshly minted window.
pub struct BrowserWindowTarget {
    /// Route prefix of the tenant serving the window.
    pub prefix: String,
    /// That tenant's bearer.
    pub token: String,
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

const TENANT_TASK_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Owns the background tasks whose lifetime is bounded by one tenant.
///
/// The route layer supplies only its eight existing terminal/session/document/
/// scene task handles (four for a terminal-only tenant) plus a clone of their
/// existing shutdown watch sender. Socket guards, the indexer, router state, and
/// domain session state retain their existing owners.
pub struct TenantTaskOwner {
    shutdown_tx: Arc<watch::Sender<bool>>,
    handles: Vec<JoinHandle<()>>,
    cancelled: bool,
}

impl TenantTaskOwner {
    /// Bind the existing tenant tasks to their existing cooperative shutdown
    /// signal.
    pub fn new(shutdown_tx: Arc<watch::Sender<bool>>, handles: Vec<JoinHandle<()>>) -> Self {
        Self {
            shutdown_tx,
            handles,
            cancelled: false,
        }
    }

    /// Cancel cooperatively, then join every task against one common deadline.
    ///
    /// At the deadline every unfinished task is aborted before any of them is
    /// awaited again. The borrowing guard keeps all not-yet-reaped handles
    /// abort-on-drop if this future itself is cancelled.
    pub async fn shutdown(&mut self) {
        self.shutdown_with_grace(TENANT_TASK_SHUTDOWN_GRACE).await;
    }

    async fn shutdown_with_grace(&mut self, grace: Duration) {
        let mut shutdown = TenantTaskShutdownGuard::new(self);
        shutdown.owner.cancel();
        let deadline = tokio::time::Instant::now() + grace;
        let timed_out = {
            let cooperative = async {
                while !shutdown.owner.handles.is_empty() {
                    let result = (&mut shutdown.owner.handles[0]).await;
                    report_join_error(result);
                    drop(shutdown.owner.handles.swap_remove(0));
                }
            };
            tokio::time::timeout_at(deadline, cooperative)
                .await
                .is_err()
        };

        if timed_out {
            for handle in &shutdown.owner.handles {
                if !handle.is_finished() {
                    handle.abort();
                }
            }
            while !shutdown.owner.handles.is_empty() {
                let result = (&mut shutdown.owner.handles[0]).await;
                report_join_error(result);
                drop(shutdown.owner.handles.swap_remove(0));
            }
        }
        shutdown.disarm();
    }

    /// Synchronous fallback for an unwinding or cancelled hosted teardown.
    ///
    /// Callers that also clear a workspace cell invoke this first so no
    /// background task can observe the cleared cell after the fallback begins.
    pub fn cancel_and_abort(&mut self) {
        self.cancel();
        for handle in &self.handles {
            handle.abort();
        }
    }

    fn cancel(&mut self) {
        if self.cancelled {
            return;
        }
        self.cancelled = true;
        if !*self.shutdown_tx.borrow() {
            let _ = self.shutdown_tx.send(true);
        }
    }
}

impl Drop for TenantTaskOwner {
    fn drop(&mut self) {
        self.cancel_and_abort();
    }
}

struct TenantTaskShutdownGuard<'a> {
    owner: &'a mut TenantTaskOwner,
    armed: bool,
}

impl<'a> TenantTaskShutdownGuard<'a> {
    fn new(owner: &'a mut TenantTaskOwner) -> Self {
        Self { owner, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TenantTaskShutdownGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.owner.cancel_and_abort();
        }
    }
}

fn report_join_error(result: Result<(), JoinError>) {
    if let Err(error) = result {
        if !error.is_cancelled() {
            tracing::error!(%error, "tenant background task panicked during shutdown");
        }
    }
}

/// What the route layer hands back per mounted tenant -- everything the host
/// needs to route to it, reconcile its windows, and tear it down. The
/// router-construction boundary: the host owns these; the route layer builds them
/// via [`TenantBuilder`]. This is the ex-`AppArtifacts`, reduced to the
/// host-facing surface, plus an opaque keep-alive for the route-layer pieces
/// the host only owns for lifetime (the MCP bridge and control socket).
pub struct TenantArtifacts {
    /// The tenant's axum app, dispatched under its route prefix.
    pub app: axum::Router,
    /// Persisted bearer for this tenant (`None` with `--no-token`).
    pub token: Option<String>,
    /// The tenant's PTY registry (window-session checks, scrollback, reap).
    pub terminal_sessions: Arc<TerminalRegistry>,
    /// The bounded owner of the existing terminal/session/document/scene tasks
    /// and their existing cooperative shutdown sender.
    pub tasks: TenantTaskOwner,
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
    /// Window commands parked for a window of this tenant that has no socket
    /// YET, drained by its first `/ws` attach. The host parks here when it
    /// routes an open into a window it just minted; the same map the tenant's
    /// `/ws` handler drains, so the frame reaches the window that was created
    /// for it.
    pub pending_window_commands: Arc<crate::pending_window_commands::PendingWindowCommands>,
    /// This tenant's standalone filesystem surface, when it mounted one. The
    /// host routes an escaping `cs open` through it; `None` is the capability
    /// answer for every tenant that serves terminals alone (and for every
    /// workspace tenant, whose files are its workspace).
    pub standalone_files: Option<Arc<dyn StandaloneFiles>>,
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
    /// bridge, control socket, and app state). Opaque: the host never calls
    /// them. Dropping it unlinks or aborts the custom socket guards.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::pending;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct DropCount(Arc<AtomicUsize>);

    impl Drop for DropCount {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn shutdown_joins_all_eight_cooperative_tasks() {
        let (shutdown_tx, _) = watch::channel(false);
        let shutdown_tx = Arc::new(shutdown_tx);
        let completed = Arc::new(AtomicUsize::new(0));
        let handles = (0..8)
            .map(|_| {
                let mut shutdown_rx = shutdown_tx.subscribe();
                let completed = Arc::clone(&completed);
                tokio::spawn(async move {
                    let _ = shutdown_rx.changed().await;
                    completed.fetch_add(1, Ordering::SeqCst);
                })
            })
            .collect();
        let mut owner = TenantTaskOwner::new(shutdown_tx, handles);

        owner.shutdown().await;

        assert_eq!(completed.load(Ordering::SeqCst), 8);
        assert!(owner.handles.is_empty());
    }

    // The paused clock makes the grace bound exact on any host: the
    // deadline below fires at precisely `grace` of virtual time, so a
    // loaded CI box cannot stretch `elapsed` into a red. tokio's
    // Instant rides the same paused clock; std's would not.
    #[tokio::test(start_paused = true)]
    async fn one_deadline_aborts_and_joins_every_stuck_task() {
        let (shutdown_tx, _) = watch::channel(false);
        let shutdown_tx = Arc::new(shutdown_tx);
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        let mut cooperative_rx = shutdown_tx.subscribe();
        handles.push(tokio::spawn(async move {
            let _ = cooperative_rx.changed().await;
        }));
        for _ in 0..4 {
            let dropped = Arc::clone(&dropped);
            handles.push(tokio::spawn(async move {
                let _drop = DropCount(dropped);
                pending::<()>().await;
            }));
        }
        let mut owner = TenantTaskOwner::new(shutdown_tx, handles);
        let start = tokio::time::Instant::now();
        let grace = Duration::from_millis(100);

        owner.shutdown_with_grace(grace).await;

        let elapsed = start.elapsed();
        assert!(elapsed >= grace, "deadline fired early: {elapsed:?}");
        assert!(
            elapsed < grace * 3,
            "shutdown multiplied grace by stuck handle count: {elapsed:?}"
        );
        assert_eq!(dropped.load(Ordering::SeqCst), 4);
        assert!(owner.handles.is_empty());
    }

    #[tokio::test]
    async fn cancelling_after_one_reap_keeps_only_unreaped_handles_guarded() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let shutdown_tx = Arc::new(shutdown_tx);
        let dropped = Arc::new(AtomicUsize::new(0));
        let task_dropped = Arc::clone(&dropped);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let fast = tokio::spawn(async {});
        let stuck = tokio::spawn(async move {
            let _drop = DropCount(task_dropped);
            let _ = entered_tx.send(());
            pending::<()>().await;
        });
        entered_rx.await.expect("task entered");
        while !fast.is_finished() {
            tokio::task::yield_now().await;
        }
        let mut owner = TenantTaskOwner::new(shutdown_tx, vec![fast, stuck]);
        let mut shutdown = Box::pin(owner.shutdown_with_grace(Duration::from_secs(60)));
        tokio::select! {
            biased;
            _ = shutdown.as_mut() => panic!("stuck task completed shutdown"),
            _ = tokio::task::yield_now() => {}
        }

        drop(shutdown);
        shutdown_rx.changed().await.expect("shutdown signal");
        assert_eq!(
            owner.handles.len(),
            1,
            "completed handles must be removed before the next cancellable await"
        );
        owner.shutdown_with_grace(Duration::ZERO).await;

        assert!(*shutdown_rx.borrow());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(owner.handles.is_empty());
    }

    #[tokio::test]
    async fn owner_drop_cancels_and_aborts() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let shutdown_tx = Arc::new(shutdown_tx);
        let dropped = Arc::new(AtomicUsize::new(0));
        let task_dropped = Arc::clone(&dropped);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _drop = DropCount(task_dropped);
            let _ = entered_tx.send(());
            pending::<()>().await;
        });
        entered_rx.await.expect("task entered");
        let owner = TenantTaskOwner::new(shutdown_tx, vec![handle]);

        drop(owner);
        shutdown_rx.changed().await.expect("shutdown signal");
        tokio::time::timeout(Duration::from_secs(1), async {
            while dropped.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("aborted task dropped");

        assert!(*shutdown_rx.borrow());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }
}
