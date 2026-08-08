//! HTTP + WebSocket surface for chan.
//!
//! Wraps `chan-workspace`'s Library / Workspace handles in axum routes,
//! gates every `/api/*` route behind a persisted bearer token,
//! exposes a watcher WebSocket, and serves the embedded
//! frontend.
//!
//! Auth: every `/api/*` route is gated by a bearer token. The
//! token is persisted at `<state>/tokens/<workspace-key>` (mode 0600 on
//! Unix) so a `cargo build && chan open` cycle does not invalidate
//! the browser's cached sessionStorage token. Clients pass it as
//! `?t=TOKEN` query string or `Authorization: Bearer TOKEN` header.
//! Pass `--no-token` to disable; loopback bind is the only check
//! left in that mode (test / desktop-shell only).

#![forbid(unsafe_code)]

mod atomic_file;
mod auth;
pub mod bulk_transfer;
mod bus;
mod collab_sessions;
mod config;
mod config_watch;
mod control_socket;
mod devserver;
/// Devserver management-API wire contract (HTTP/JSON), public so a
/// chan-desktop client and the server build against the exact shapes.
pub mod devserver_api;
/// CLI-to-devserver workspace-registration RPC over a well-known per-user
/// UDS. Public so the `chan` CLI (client) and the devserver (listener)
/// share it; both already depend on chan-server.
pub mod devserver_handoff;
mod disk_echo;
mod doc_sessions;
mod embed_seed;
mod error;
mod extensions;
/// macOS CLI-to-desktop workspace handoff over a well-known per-user UDS.
/// Public so both the `chan` CLI (client) and `chan-desktop`
/// (listener) consume it; both already depend on chan-server.
pub mod handoff;
mod handover_bus;
mod indexer;
mod mcp_bridge;
mod preferences;
mod routes;
mod scene_sessions;
mod self_writes;
mod session_roster;
mod signal;
mod state;
mod static_assets;
mod store;
mod submit_config;
mod survey;
mod terminal_blob;
mod tunnel_guard;
mod util;
mod window_bus;

pub use config::ServerConfig;
// Desktop window-ops, window presence, and the title map live in chan-library.
// Re-export the modules so internal `crate::…::` paths resolve unchanged, and
// the public types so chan-desktop keeps reaching them via `chan_server::`.
pub use chan_library::desktop_window_ops::{
    DesktopBridge, DesktopWindowOp, DesktopWindowSender, NewWindowKind, SetWorkspaceOnOutcome,
    NO_DESKTOP,
};
pub use chan_library::terminal_sessions::TerminalExit;
/// Re-export the single-sourced shell resolver so the desktop (which deps
/// chan-server, not chan-library directly) can call `chan_server::user_shell()`
/// for its PATH-harvest helper. Unix-only, matching the chan-library gate.
#[cfg(unix)]
pub use chan_library::user_shell;
pub use chan_library::window_titles::{SharedWindowTitles, WindowMeta, WindowTitles};
pub use chan_library::windows::{CreateWindow, WindowKind, WindowOrigin, WindowRecord, WindowSet};
pub(crate) use chan_library::{
    desktop_window_ops, session_presence, window_presence, window_titles, window_transfers,
};
pub use chan_library::{
    CollapsedMachinesStore, DevserverEntry, DevserverFeedSource, DevserverInput, DevserverRegistry,
    DevserverStatus, GatewayEntry, GatewayInput, GatewayRegistry, GatewayStatus, HostedWorkspace,
    LauncherWorkspace, LocalColorStore, LocalThemeStore, PersistedWorkspace, WorkspaceHost,
    WorkspaceLifecycleOutcome, WorkspaceOverlay, WorkspaceStatus,
};
pub use devserver::{
    persisted_devserver_port, persisted_devserver_token, rotate_persisted_devserver_token,
    run_devserver, DevserverConfig, DevserverTunnel, DEVSERVER_TOKEN_MARKER,
    DEVSERVER_TOKEN_MAX_AGE_SECS,
};
pub use error::Error;
pub use extensions::{ExtensionRuntime, EXTENSION_HANDSHAKE_MARKER};
pub use mcp_bridge::run_stdio_proxy as run_mcp_stdio_proxy;
pub use preferences::{
    BrowserSidePanes, EditorPrefs, EditorTheme, HybridSurfaceThemes, LineSpacing, PaneWidths,
    ShortcutOverride, SurfaceThemeChoice, TerminalColorMode, TerminalColorPrefs, TerminalContrast,
    TerminalCustomColors, ThemeChoice, EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN,
};
pub use routes::{build_fs_graph, FsGraphResponse, FsGraphScope};

use crate::terminal_sessions::{
    Registry as TerminalRegistry, RegistryConfig as TerminalRegistryConfig, TerminalBackendResolver,
};
use auth::{auth_middleware, load_or_create_token, random_token};
use bus::{make_progress_broadcast, make_watch_bridge};
use routes::{
    api_backlinks, api_build_info, api_cloud_workspaces, api_create_diagram, api_create_draft,
    api_create_file, api_create_terminal, api_cs_link_create, api_delete_file, api_delete_session,
    api_delete_terminal, api_discard_draft, api_doc_ws, api_excluded_dirs_get,
    api_excluded_dirs_put, api_extensions, api_fonts_source_code_pro_download, api_fs_graph,
    api_fs_transfer, api_get_config, api_get_contacts, api_get_mentions, api_get_session,
    api_get_workspace, api_graph, api_headings, api_health, api_index_rebuild, api_index_status,
    api_indexing_state, api_inspect_draft, api_inspector, api_language_graph, api_link_targets,
    api_links, api_list_files, api_list_sessions, api_list_windows, api_metadata_export,
    api_metadata_import, api_move, api_open, api_patch_config, api_post_attachment,
    api_post_contacts_import, api_preflight, api_preflight_decision, api_promote_draft,
    api_put_session, api_read_file, api_report_dir, api_report_file, api_report_prefix,
    api_reports_disable, api_reports_enable, api_reports_state, api_resolve_link,
    api_resolve_session_conflict, api_restart_terminal, api_scene_ws, api_screensaver_clear_pin,
    api_screensaver_patch, api_screensaver_set_pin, api_screensaver_state, api_screensaver_verify,
    api_search_content, api_search_files, api_search_workspace, api_session_handover_reply,
    api_set_terminal_broadcast, api_storage_reset, api_survey_reply, api_team_config_read,
    api_team_config_write, api_terminal_next_name, api_terminal_ws, api_terminals_roster,
    api_upload_file, api_window_reply, api_workspace_bootstrap, api_write_file,
    extension_response_policy, proxy_extension, proxy_extension_root, require_local_mutation,
    spawn_roster_broadcaster, ws_upgrade,
};
#[cfg(feature = "embeddings")]
use routes::{
    api_semantic_disable, api_semantic_download, api_semantic_enable, api_semantic_model_patch,
    api_semantic_models, api_semantic_state,
};
use signal::{graceful_serve, now_unix_secs, spawn_idle_watcher};
use state::{AppState, WorkspaceCell};
use static_assets::{serve_font, serve_static};
// The terminal-session registry lives in chan-library. Re-export it at the
// crate root so the route layer reaches it as `crate::terminal_sessions::…`.
pub(crate) use chan_library::terminal_sessions;

/// Tunnel workspace-name helpers re-exported from chan-tunnel-proto so
/// the `chan` binary can pre-validate / pre-sanitize without taking
/// a direct dep on the tunnel proto crate.
pub mod tunnel {
    pub use chan_tunnel_proto::{
        is_valid_workspace_name, sanitize_workspace_name, MAX_WORKSPACE_NAME_LEN,
    };
}

use self_writes::SelfWrites;

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{any, delete, get, patch, post, put};
use axum::Router;
use chan_workspace::{
    Library, ProgressCallback, ProgressEvent, ProgressStage, WatchEvent, Workspace,
};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use tower_http::trace::TraceLayer;

// `ServeConfig` / `ServeHandle` / `sanitize_prefix` live in chan-library (the
// host lifecycle + tenant builder take them). Re-exported so the route layer,
// the devserver, and the `chan` binary keep naming them via `crate::` /
// `chan_server::` unchanged.
//
// `allocate_workspace_prefix` is re-exported for the same reason: chan-desktop
// depends on chan-server but not on chan-library, and it needs the one
// authoritative `{slug}-{8hex}` computation to resolve a workspace id a client
// sent. Recomputing that string in the shell would make a fourth copy of an
// algorithm that must stay byte-identical, and a drift would surface as a
// workspace that cannot be opened rather than as a build failure.
pub use chan_library::{allocate_workspace_prefix, sanitize_prefix, ServeConfig, ServeHandle};

/// Combine the `open_browser` config flag with the `BROWSER` env
/// var. Returns false if the flag is off or if `BROWSER` is set to
/// an empty string. The empty-string case is a Unix convention
/// (python's `webbrowser`, several CLIs) for "I have no browser;
/// don't try". A non-empty `BROWSER` falls through: the `open`
/// crate honors it on Linux, and we leave macOS/Windows to their
/// platform default opener.
fn should_open_browser(open_browser: bool) -> bool {
    if !open_browser {
        return false;
    }
    !matches!(std::env::var("BROWSER"), Ok(v) if v.is_empty())
}

/// Bundle returned by `build_app`: the prefixed axum app plus the
/// pieces `serve()` needs out-of-band (token for the launch URL,
/// last_activity for the idle watcher). The watch handle and
/// indexer live inside the router's state, so dropping the router
/// drops them; callers do not need to keep a separate handle.
struct AppArtifacts {
    app: Router,
    token: Option<String>,
    last_activity: Arc<AtomicU64>,
    /// Live workspace cell so the serve loop can cancel the current
    /// indexer on shutdown without keeping stale indexer handles
    /// alive across storage reset or metadata import swaps.
    workspace_cell: Arc<RwLock<Option<WorkspaceCell>>>,
    /// Bounded owner for the terminal/session/document/scene background
    /// tasks. Hosted and standalone teardown both await it before the
    /// workspace cell and route state can drop.
    tasks: chan_library::TenantTaskOwner,
    /// The bulk transfer lane's lifecycle owner, held here so the lane
    /// outlives every route that can submit to it. `AppState` deliberately
    /// carries only a tenant handle, so this is the only thing keeping the
    /// workers alive; dropping the last one shuts the lane down and joins
    /// them.
    bulk_transfer: Arc<crate::bulk_transfer::BulkTransferLane>,
    /// Mutable handle to the URL prefix injected into the SPA shell
    /// as `<meta name="chan-prefix">`. Local serve sets it once at
    /// build time from `ServeConfig::prefix`; tunnel mode swaps in
    /// the registration prefix (`/{user}/{workspace}`) on Connected so
    /// the SPA's API calls pick up the public path. Shared with
    /// `AppState::prefix` (same Arc).
    prefix: Arc<RwLock<String>>,
    /// MCP socket bridge handle. Held here (not on AppState) so the
    /// accept-loop closures don't have to keep the AppState alive
    /// past serve() unwind. Drop = abort accept loop + unlink socket.
    /// `None` when the bridge failed to bind (best-effort: agents
    /// fall back to v1 black-box mode).
    mcp_bridge: Option<mcp_bridge::BridgeHandle>,
    /// First-party control socket for local CLI helpers. Held for
    /// the same lifetime as the MCP bridge.
    control_socket: Option<control_socket::ControlHandle>,
    /// Live PTY registry handle. The router's state owns it too; this
    /// copy lets a host (chan-desktop's embedded server) answer
    /// "does window X still have shells?" without going through HTTP
    /// (see `WorkspaceHost::tenant_has_window_sessions`).
    terminal_sessions: Arc<TerminalRegistry>,
    /// The router's state, the same `Arc` the router serves from.
    state: Arc<AppState>,
    /// Shutdown signal sender. Fed by SIGINT/SIGTERM and (optionally)
    /// the idle-timeout watcher. Receivers live on `AppState` and in
    /// `serve()` for the runloop select.
    shutdown_tx: Arc<watch::Sender<bool>>,
}

/// Fan one `ProgressEvent` out to several sinks. Used by `build_app`
/// to tee the indexer's progress to both the WebSocket broadcast (the
/// web UI's indexer pill) and stderr (so a foreground `chan open` on
/// a large tree isn't silent).
struct TeeProgress(Vec<Arc<dyn ProgressCallback>>);

impl ProgressCallback for TeeProgress {
    fn on_progress(&self, event: ProgressEvent) {
        for sink in &self.0 {
            sink.on_progress(event.clone());
        }
    }
}

/// Don't surface a single stderr line until the initial build has been
/// running this long: a small or already-warm workspace indexes in a
/// blink and should stay silent. Only a genuinely long build (the
/// large-tree case) crosses this threshold and starts streaming.
const STDERR_PROGRESS_MIN_ELAPSED: Duration = Duration::from_millis(800);
/// Minimum spacing between stderr progress lines once they start, so a
/// fast index loop emits a readable trickle rather than a flood.
const STDERR_PROGRESS_INTERVAL: Duration = Duration::from_millis(750);

/// Concise indexing progress on stderr for a cold-start `chan open`.
/// The launch URL is printed immediately (the server is usable at
/// once); these lines stream underneath it so the user can see what
/// chan is doing on a large tree. Self-gates on elapsed time so fast
/// builds print nothing, and throttles once active.
struct StderrIndexProgress {
    verbose: bool,
    started: Instant,
    last_emit: Mutex<Option<Instant>>,
}

impl ProgressCallback for StderrIndexProgress {
    fn on_progress(&self, event: ProgressEvent) {
        let now = Instant::now();
        if now.duration_since(self.started) < STDERR_PROGRESS_MIN_ELAPSED {
            return;
        }
        {
            let mut last = self.last_emit.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(prev) = *last {
                if now.duration_since(prev) < STDERR_PROGRESS_INTERVAL {
                    return;
                }
            }
            *last = Some(now);
        }
        eprintln!("{}", format_index_progress(&event, self.verbose));
    }
}

/// One concise stderr line for an indexing `ProgressEvent`. Phase +
/// counts (+ percent / ETA when known); `--verbose` appends the
/// current item label.
fn format_index_progress(event: &ProgressEvent, verbose: bool) -> String {
    let pct = match event.current.saturating_mul(100).checked_div(event.total) {
        Some(p) => format!(" ({p}%)"),
        None => String::new(),
    };
    let mut line = match event.stage {
        ProgressStage::GraphRebuild => {
            format!(
                "chan: building graph {}/{}{pct}",
                event.current, event.total
            )
        }
        ProgressStage::IndexFile => {
            format!(
                "chan: indexing {}/{} files{pct}",
                event.current, event.total
            )
        }
        ProgressStage::EmbedBatch => format!("chan: embedding ({} chunks)", event.current),
        ProgressStage::ModelLoad => "chan: loading embedding model".to_string(),
        ProgressStage::Heartbeat => {
            format!("chan: {}", event.label.as_deref().unwrap_or("indexing"))
        }
        ProgressStage::RenameRewrite => {
            format!("chan: rewriting links {}/{}", event.current, event.total)
        }
        ProgressStage::Import => format!("chan: importing {}/{}", event.current, event.total),
        ProgressStage::Reset => {
            format!("chan: resetting {}", event.label.as_deref().unwrap_or(""))
        }
    };
    if let Some(secs) = event.eta_secs {
        line.push_str(&format!(", ~{secs}s left"));
    }
    if verbose {
        if let Some(label) = &event.label {
            line.push_str("  ");
            line.push_str(label);
        }
    }
    line
}

/// Build the full axum app: state assembly, channels, watcher,
/// indexer, config loads, router. Shared by `serve()` (local TCP
/// listener) and the `WorkspaceHost` tenant builder (the devserver and
/// chan-desktop mount their tenants through it) so every path serves
/// byte-identical request handling.
/// Prime the Windows default-shell resolution cache off the async request path.
/// Resolution may shell out (`where pwsh`) with a blocking process spawn;
/// resolving it lazily on the first terminal create would run that on a tokio
/// worker and freeze the embedded SPA. Fire it on a blocking thread at
/// server-build time -- before the router accepts any request -- so the
/// command-builder cache read is instant. A no-op off Windows.
fn prime_terminal_shell() {
    #[cfg(windows)]
    {
        // Detached on purpose: the blocking prime runs to completion on the
        // blocking pool regardless of the dropped handle (spawn_blocking is not
        // cancellable), and we never need its result -- the warm cache is read
        // later through the `OnceLock`. `drop` rather than `let _` keeps clippy's
        // `let_underscore_future` happy.
        drop(tokio::task::spawn_blocking(
            crate::terminal_sessions::prime_windows_shell,
        ));
    }
}

/// Bind the tenant's control socket: a path stable across server restarts
/// (with the no-clobber takeover) when the host installed a control identity
/// (the devserver), else the pid-scoped fresh-per-process path. A bind
/// failure degrades to no control socket -- shells then simply lack
/// `$CHAN_CONTROL_SOCKET` -- rather than failing the tenant.
fn start_control_socket(
    control_identity: Option<&str>,
    prefix: &str,
    ctx: control_socket::ControlSocketCtx,
) -> (Option<PathBuf>, Option<control_socket::ControlHandle>) {
    let (path, bound) = match control_identity {
        Some(identity) => {
            let path = control_socket::stable_socket_path(identity, prefix);
            let bound = control_socket::start_stable(path.clone(), ctx);
            (path, bound)
        }
        None => {
            let path = control_socket::pick_socket_path();
            let bound = control_socket::start(path.clone(), ctx);
            (path, bound)
        }
    };
    match bound {
        Ok(handle) => (Some(handle.socket_path().to_path_buf()), Some(handle)),
        Err(e) => {
            tracing::warn!("control socket bind failed at {}: {e}", path.display());
            (None, None)
        }
    }
}

/// Everything one workspace tenant's app is built from, other than the serve
/// config. Grouped rather than passed positionally: the set is long enough
/// that a caller reading a bare argument list cannot tell which `Option` or
/// which `Arc` is which, and every caller supplies all of it.
struct AppBuild {
    library: Library,
    workspace: Arc<Workspace>,
    extension_catalog: Arc<extensions::ExtensionCatalog>,
    desktop: crate::desktop_window_ops::DesktopBridge,
    unserve: chan_library::UnserveMode,
    control_identity: Option<String>,
    /// The process lane this tenant admits bulk transfers against. Passed in
    /// rather than created here so every tenant in a hosted process shares one
    /// allocation and one bound.
    bulk_transfer: Arc<crate::bulk_transfer::BulkTransferLane>,
}

#[cfg(test)]
async fn build_app(
    library: Library,
    workspace: Arc<Workspace>,
    config: &ServeConfig,
    desktop: crate::desktop_window_ops::DesktopBridge,
    unserve: chan_library::UnserveMode,
    control_identity: Option<String>,
) -> Result<AppArtifacts, Error> {
    build_app_with_extensions(
        AppBuild {
            library,
            workspace,
            extension_catalog: extensions::empty_catalog(),
            desktop,
            unserve,
            control_identity,
            bulk_transfer: crate::bulk_transfer::BulkTransferLane::new(),
        },
        config,
    )
    .await
}

async fn build_app_with_extensions(
    build: AppBuild,
    config: &ServeConfig,
) -> Result<AppArtifacts, Error> {
    let AppBuild {
        library,
        workspace,
        extension_catalog,
        desktop,
        unserve,
        control_identity,
        bulk_transfer,
    } = build;
    // Captured before `workspace` is moved into AppState below; the standalone
    // unserve scope names this root.
    let unserve_root = workspace.root().to_path_buf();
    let token = if config.no_token {
        None
    } else {
        Some(load_or_create_token(workspace.paths())?)
    };

    // Seed the per-machine model cache from the embedded bundle if
    // this build shipped one (`--features embed-model`). Cheap on
    // every launch: skipped if the default model is already laid out
    // at the target. No-op (compile-gated out) on default builds;
    // they ship without the bundle and rely on the chan-workspace
    // runtime resolver + the model download flow instead.
    #[cfg(feature = "embed-model")]
    embed_seed::seed_models_from_bundle();

    // Server config: same fall-back-on-malformed policy as the
    // editor preferences. Load before spawning the indexer so its
    // resource profile applies from the initial boot rebuild.
    let server_config = ServerConfig::load().unwrap_or_else(|e| {
        tracing::warn!("malformed server config, falling back to defaults: {e}");
        ServerConfig::default()
    });
    let search_aggression = server_config.effective_search_aggression(config.search_aggression);

    // Install any per-agent submit-chord overrides from
    // `<config>/chan/submit.toml` into chan-shell, so a client changing its
    // submit behavior is a config edit, not a rebuild. Missing/malformed
    // file falls back to the built-in defaults. Env CHAN_SUBMIT_<AGENT>
    // still wins at chord-application time.
    submit_config::install();

    // Unified event stream: every /ws subscriber gets watcher and
    // progress events from the same channel. Producers serialize to
    // JSON strings (with a `type` field as the discriminator); the WS
    // pump just forwards strings as text frames. Buffer of 256 is
    // enough headroom for typical bursts (mass rename, reindex
    // progress); slow subscribers see Lagged and skip ahead rather
    // than blocking the sender.
    let (events_tx, _) = broadcast::channel::<String>(256);
    // Indexer feed: raw WatchEvent for the background indexer
    // task. Larger buffer than the JSON channel because the
    // indexer's debounce loop drains every 200ms; bursts during
    // git pull / mass rsync land here without lagging.
    let (index_events_tx, _) = broadcast::channel::<WatchEvent>(1024);
    // Shared dedupe queue: server writes note their path here, the
    // watcher bridge consults it before forwarding so save->reload
    // echoes don't fire spurious external-edit prompts in the
    // editor. Indexer is NOT subject to this gate; in-app saves
    // must reindex.
    let self_writes = Arc::new(SelfWrites::new());
    // The scoped pub/sub registry is created here so the watcher
    // bridge can route scoped `fs` frames into it; the same
    // Arc is stored on AppState for the /ws handler and survives a
    // storage reset (the rebuilt bridge re-references it).
    let scope_registry = Arc::new(bus::ScopeRegistry::new());
    // Detect a cold (empty) index before the potentially slow pre-URL work
    // (the watcher registration on a large tree). On a cold start, print one
    // heads-up line here so a foreground `chan open` on a large tree shows a
    // sign of life instead of a silent gap before the URL. A warm restart
    // leaves the index non-empty and stays quiet. The same flag gates the
    // stderr progress tee below.
    let cold_index = workspace.num_indexed().map(|n| n == 0).unwrap_or(false);
    if cold_index {
        eprintln!(
            "chan: first run on this workspace; the search index builds in the \
             background after the URL below, so the editor and terminal are \
             usable right away even on a large tree."
        );
    }
    // The watch bridge fans filesystem events onto the /ws broadcast and the
    // indexer feed. Registering the watcher is the one repo-size-scaling step on
    // the boot path: `notify`'s recursive registration walks the whole tree, and
    // on Linux inotify has no native recursive watch, so it installs one watch
    // per directory. The report's content scan, the larger cost, stays off this
    // path (it runs lazily on the first report query). Registration runs just
    // below, after the cell exists.
    let bridge = make_watch_bridge(
        &events_tx,
        &index_events_tx,
        &self_writes,
        &scope_registry,
        workspace.root().to_path_buf(),
    );
    let workspace_root = workspace.root().to_path_buf();
    // Background indexer: subscribes to index_events_tx, runs the
    // initial build if the index is empty, debounces incremental
    // reindexes 1s per path. Lives for the server's lifetime.
    // Progress fan-out: every `Workspace::reindex_with` tick (per-file
    // index, graph rebuild, embed batch) lands on the same /ws
    // stream as watch + LLM frames, with `type: "progress"`. The
    // status bar in the web app subscribes to workspace the live
    // indexer pill. On a cold start we also tee that progress to stderr
    // so the background build isn't silent in the terminal.
    let broadcast_sink = make_progress_broadcast(&events_tx);
    let progress_sink: Arc<dyn ProgressCallback> = if cold_index {
        Arc::new(TeeProgress(vec![
            broadcast_sink,
            Arc::new(StderrIndexProgress {
                verbose: config.verbose,
                started: Instant::now(),
                last_emit: Mutex::new(None),
            }),
        ]))
    } else {
        broadcast_sink
    };
    let indexer = Arc::new(indexer::Indexer::spawn(
        workspace.clone(),
        index_events_tx.subscribe(),
        true,
        search_aggression,
        progress_sink,
    ));
    // Editor preferences: fonts / theme / pane widths / line spacing /
    // date format. The unified view returned over /api/workspace and
    // /api/config joins these with ServerConfig.
    let editor_prefs = EditorPrefs::load().unwrap_or_else(|e| {
        tracing::warn!("malformed editor preferences, falling back to defaults: {e}");
        EditorPrefs::default()
    });

    let last_activity = Arc::new(AtomicU64::new(now_unix_secs()));
    let prefix = Arc::new(RwLock::new(config.prefix.clone()));
    // Shutdown channel: sender lives in artifacts so the serve loop
    // can fire it from SIGINT and the idle watcher; receivers live on
    // AppState (for ws_pump et al) and in serve() itself for the
    // graceful-shutdown select.
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let shutdown_tx = Arc::new(shutdown_tx);

    // Try to bring up the MCP socket bridge before building
    // AppState, so the resolved socket path (or `None` on failure)
    // is part of the immutable state every handler observes.
    let socket_path = mcp_bridge::pick_socket_path();
    // Clone the workspace handle for the watcher registration before the cell
    // takes ownership of the original below.
    let watch_workspace = workspace.clone();
    let state_for_bridge: Arc<RwLock<Option<WorkspaceCell>>> =
        Arc::new(RwLock::new(Some(WorkspaceCell {
            workspace,
            // Filled by the registration step immediately below.
            watch_handle: None,
            indexer,
        })));
    // Register the filesystem watcher on the blocking pool and await it, so the
    // cell carries a live handle before this function returns and no detached
    // task is left holding a strong workspace handle (and its writer flock)
    // across a later close. This step is the notify registration only: the
    // report's content scan is lazy (first report query), so the awaited work
    // is bounded by `notify`'s recursive directory registration. A registration
    // failure (most often the Linux inotify watch limit,
    // fs.inotify.max_user_watches) leaves the watcher absent and external edits
    // reconcile on demand, rather than failing the boot.
    let watch_cell = state_for_bridge.clone();
    // Boot-timing anchor: on Linux this recursive registration installs one
    // inotify watch per directory, so it is the step most sensitive to tree
    // size now that the report scan is off this path.
    let watch_t0 = Instant::now();
    match tokio::task::spawn_blocking(move || watch_workspace.watch(bridge)).await {
        Ok(Ok(handle)) => {
            tracing::debug!(
                t_watch_registered_ms = watch_t0.elapsed().as_millis() as u64,
                "boot: filesystem watcher registered"
            );
            if let Ok(mut cell) = watch_cell.write() {
                if let Some(cell) = cell.as_mut() {
                    cell.watch_handle = Some(handle);
                }
            }
        }
        Ok(Err(e)) => {
            tracing::warn!("filesystem watcher registration failed: {e}");
            eprintln!(
                "NOTE: live file-watching is unavailable ({e}); external edits \
                 reconcile on demand. On Linux, raise fs.inotify.max_user_watches \
                 to re-enable it."
            );
        }
        Err(join_err) => {
            tracing::warn!("filesystem watcher registration task panicked: {join_err}");
        }
    }
    let bridge_workspace_cell = state_for_bridge.clone();
    let bridge = mcp_bridge::start(socket_path.clone(), move || {
        let cell = match bridge_workspace_cell.read() {
            Ok(cell) => cell,
            Err(_) => {
                tracing::warn!("mcp bridge cannot snapshot workspace: workspace_cell poisoned");
                return None;
            }
        };
        let Some(cell) = cell.as_ref() else {
            tracing::warn!("mcp bridge cannot snapshot workspace: workspace_cell missing");
            return None;
        };
        Some(cell.workspace.clone())
    });
    let (mcp_socket_path, mcp_bridge) = match bridge {
        Ok(handle) => (Some(handle.socket_path().to_path_buf()), Some(handle)),
        Err(e) => {
            tracing::warn!("mcp bridge bind failed at {}: {e}", socket_path.display());
            (None, None)
        }
    };
    // The terminal registry is built below (it needs the resolved control
    // socket path for $CHAN_CONTROL_SOCKET), so the control socket gets an
    // empty cell now and we fill it once the registry exists. Category-2
    // control requests (cs term write / list) read it.
    let terminal_registry_cell: control_socket::TerminalRegistryCell =
        Arc::new(std::sync::OnceLock::new());
    // Survey bus: shared between the control socket (the blocked
    // `cs terminal survey` side) and AppState (the SPA reply route's
    // `complete_survey` side). Created before the control socket so the
    // accept loop can park surveys, and cloned onto AppState below.
    let survey_bus = Arc::new(survey::SurveyBus::new());
    // Window bus: same shape as the survey bus, for the blocked `cs pane`
    // layout query. The control socket parks the query oneshot; the SPA's
    // `POST /api/window/reply` route completes it through AppState below.
    let window_bus = Arc::new(crate::window_bus::WindowBus::new());
    // Handover bus: same shape again, for the blocked `cs session handover`.
    // The requester parks a oneshot here; the leader's answer (the SPA's
    // `POST /api/session/handover/reply` or its own CLI) completes it.
    let handover_bus = Arc::new(handover_bus::HandoverBus::new());
    // Shared by the `/ws` route (presence updates) and the host's window-set
    // assembly (cloned onto AppState below).
    let window_presence = Arc::new(window_presence::WindowPresence::new());
    // Per-window in-flight transfer count; shared with the host's close guard
    // the same way as presence (cloned into TenantArtifacts off AppState below).
    let window_transfers = Arc::new(window_transfers::WindowTransfers::new());
    // The leader/followers session for this tenant; the `/ws` pump joins it per
    // socket and the reaper below ages out disconnected participants.
    let session_registry = Arc::new(session_presence::SessionRegistry::new());
    let session_reaper = session_roster::spawn_session_reaper(
        session_registry.clone(),
        events_tx.clone(),
        shutdown_rx.clone(),
    );
    // A standalone serve unserves by exiting the process (its shutdown
    // signal); a hosted tenant unserves by unmounting itself from the host.
    let unserve_scope = match unserve {
        chan_library::UnserveMode::Standalone => chan_library::UnserveScope::Standalone {
            root: unserve_root,
            shutdown_tx: shutdown_tx.clone(),
        },
        chan_library::UnserveMode::Host(weak) => chan_library::UnserveScope::Host(weak),
        chan_library::UnserveMode::Unsupported => chan_library::UnserveScope::Unsupported,
    };
    let (control_socket_path, control_socket) = start_control_socket(
        control_identity.as_deref(),
        &config.prefix,
        control_socket::ControlSocketCtx {
            workspace_cell: state_for_bridge.clone(),
            events_tx: events_tx.clone(),
            self_writes: self_writes.clone(),
            terminal_registry: terminal_registry_cell.clone(),
            survey_bus: survey_bus.clone(),
            window_bus: window_bus.clone(),
            session_registry: session_registry.clone(),
            handover_bus: handover_bus.clone(),
            desktop: desktop.clone(),
            tenant: control_socket::ControlTenant::Workspace,
            unserve: unserve_scope,
        },
    );
    prime_terminal_shell();
    let terminal_sessions = Arc::new(TerminalRegistry::new(TerminalRegistryConfig {
        workspace_root: workspace_root.clone(),
        mcp_socket_path: mcp_socket_path.clone(),
        control_socket_path: control_socket_path.clone(),
        terminal: server_config.terminal.clone(),
    }));
    // Hand the live registry to the control socket so cs term write / list
    // can resolve sessions. Set-once; ignore a second set (never happens).
    let _ = terminal_registry_cell.set(terminal_sessions.clone());
    let terminal_sessions_handle = terminal_sessions.clone();
    let terminal_pruner = terminal_sessions.clone().spawn_pruner(shutdown_rx.clone());
    // Drain the per-session `cs terminal write` queues (deliver each next
    // poke when its agent goes idle). Sibling of the pruner.
    let terminal_drainer = terminal_sessions.clone().spawn_drainer(shutdown_rx.clone());
    // Push cross-window roster snapshots onto `/ws` on every change.
    let terminal_roster_broadcaster = spawn_roster_broadcaster(
        terminal_sessions.clone(),
        events_tx.clone(),
        shutdown_rx.clone(),
    );

    let state = Arc::new(AppState {
        library,
        workspace_root,
        workspace_cell: state_for_bridge.clone(),
        token: token.clone(),
        prefix: prefix.clone(),
        settings_disabled: config.settings_disabled,
        events_tx,
        index_events_tx,
        server_config: Mutex::new(server_config),
        editor_prefs: Mutex::new(editor_prefs),
        config_revision: AtomicU64::new(1),
        config_write_serial: Mutex::new(()),
        self_writes,
        last_activity: last_activity.clone(),
        terminal_sessions,
        doc_sessions: Arc::new(doc_sessions::DocRegistry::new()),
        scene_sessions: Arc::new(scene_sessions::SceneRegistry::new()),
        shutdown_rx,
        scope_registry,
        survey_bus,
        window_bus,
        handover_bus,
        ephemeral_sessions: Mutex::new(std::collections::HashMap::new()),
        terminal_session_dir: None,
        window_presence,
        session_registry,
        window_transfers,
        window_titles: desktop.window_titles.clone(),
        bulk_transfer: bulk_transfer.tenant(),
        instance_id: random_token(),
    });
    // Doc-session background tasks: the flusher debounces dirty
    // sessions to atomic CAS disk writes and runs the detach-grace
    // reaper; the reconciler folds raw watcher events back into live
    // sessions as synthetic `$disk` updates. Workspace apps only: the
    // terminal-only app has no workspace, no doc route, nothing to
    // flush.
    let doc_flusher = doc_sessions::spawn_flusher(
        state.doc_sessions.clone(),
        state.workspace_cell.clone(),
        state.self_writes.clone(),
        state.shutdown_rx.clone(),
    );
    let doc_reconciler = doc_sessions::spawn_reconciler(
        state.doc_sessions.clone(),
        state.workspace_cell.clone(),
        state.index_events_tx.subscribe(),
        state.shutdown_rx.clone(),
    );
    // Scene-session background tasks: the same flusher/reconciler shape
    // for the Excalidraw authority (element-level sessions instead of
    // update logs). Workspace apps only, like the doc tasks above.
    let scene_flusher = scene_sessions::spawn_flusher(
        state.scene_sessions.clone(),
        state.workspace_cell.clone(),
        state.self_writes.clone(),
        state.shutdown_rx.clone(),
    );
    let scene_reconciler = scene_sessions::spawn_reconciler(
        state.scene_sessions.clone(),
        state.workspace_cell.clone(),
        state.index_events_tx.subscribe(),
        state.shutdown_rx.clone(),
    );
    // Nest under the prefix so `--prefix=/foo` makes every existing
    // route reachable at `/foo<route>` without changing any handler.
    // axum strips the prefix from the inner URI, so handlers continue
    // to see paths starting with `/api`, `/ws`, etc.
    let inner = router_with_extensions(state.clone(), extension_catalog);
    let app = if config.prefix.is_empty() {
        inner
    } else {
        Router::new().nest(&config.prefix, inner)
    };
    let tasks = chan_library::TenantTaskOwner::new(
        shutdown_tx.clone(),
        vec![
            terminal_pruner,
            terminal_drainer,
            terminal_roster_broadcaster,
            session_reaper,
            doc_flusher,
            doc_reconciler,
            scene_flusher,
            scene_reconciler,
        ],
    );

    Ok(AppArtifacts {
        app,
        token,
        last_activity,
        workspace_cell: state_for_bridge.clone(),
        tasks,
        bulk_transfer,
        prefix,
        mcp_bridge,
        control_socket,
        terminal_sessions: terminal_sessions_handle,
        state,
        shutdown_tx,
    })
}

/// Build a workspace-less "terminal-only" tenant: the same axum
/// surface a [`WorkspaceHost`] mounts, minus everything that needs an
/// `Arc<Workspace>`. Sibling to [`build_app`]; the embedded host calls
/// this from `open_terminal_session` to back a standalone terminal
/// window (a desktop webview loading the chan SPA in `?kind=terminal`
/// mode).
///
/// Deliberately omits the watcher, indexer, and MCP bridge: there is
/// no workspace to watch / index / expose. It DOES start a control
/// socket so `cs` works inside standalone terminals -- terminal / pane
/// / survey / window commands; workspace commands refuse with the
/// terminal-only message. The terminal registry's PTY cwd is `$HOME`,
/// so a new pane lands in the user's home directory rather than a
/// workspace root. The SLIM router (see [`terminal_router`]) mounts only the
/// terminal + window-session routes, so a workspace-content request
/// (`/api/files`, `/api/graph`, ...) 404s instead of panicking on the
/// missing `workspace_cell`.
async fn build_terminal_app(
    library: Library,
    config: &ServeConfig,
    desktop: crate::desktop_window_ops::DesktopBridge,
    unserve: chan_library::UnserveMode,
    session_dir: Option<std::path::PathBuf>,
    control_identity: Option<String>,
    bulk_transfer: Arc<crate::bulk_transfer::BulkTransferLane>,
) -> Result<AppArtifacts, Error> {
    let token = if config.no_token {
        None
    } else {
        // In-memory only: a terminal tenant has no workspace token dir
        // to persist into, and each window mints a fresh tenant anyway.
        Some(random_token())
    };

    // Same fall-back-on-malformed policy as `build_app`. Only the
    // `terminal` sub-config is consumed here (it seeds the registry);
    // the indexer profile / editor prefs join is irrelevant with no
    // workspace.
    let server_config = ServerConfig::load().unwrap_or_else(|e| {
        tracing::warn!("malformed server config, falling back to defaults: {e}");
        ServerConfig::default()
    });
    // Install submit-chord overrides for the terminal poke path, same
    // as `build_app`; this is workspace-independent config.
    submit_config::install();

    // Editor preferences still seed the SPA shell (theme / fonts) even
    // in terminal mode, so load them with the same fall-back policy.
    let editor_prefs = EditorPrefs::load().unwrap_or_else(|e| {
        tracing::warn!("malformed editor preferences, falling back to defaults: {e}");
        EditorPrefs::default()
    });

    // Same unified event channels as `build_app`: `/ws` subscribers get
    // the JSON-envelope broadcast (pane bus, terminal frames), and the
    // raw WatchEvent feed exists so AppState stays shape-compatible even
    // though no watcher producer is wired in terminal mode.
    let (events_tx, _) = broadcast::channel::<String>(256);
    let (index_events_tx, _) = broadcast::channel::<WatchEvent>(1024);
    let self_writes = Arc::new(SelfWrites::new());
    let scope_registry = Arc::new(bus::ScopeRegistry::new());

    let last_activity = Arc::new(AtomicU64::new(now_unix_secs()));
    let prefix = Arc::new(RwLock::new(config.prefix.clone()));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let shutdown_tx = Arc::new(shutdown_tx);

    // PTY cwd = $HOME (fallback "/"): a terminal window is not anchored
    // to a workspace, so new sessions open in the user's home dir. No
    // MCP bridge (nothing to expose without a workspace).
    let workspace_root = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));

    // Workspace-less cell: `try_workspace` reports `Missing`, and the slim
    // router mounts no workspace-content route. The serve loop's
    // indexer-cancel side task tolerates a `None` cell (it no-ops), so the
    // shared shutdown wiring is safe.
    // Created before the control socket, which shares it (and reports
    // the terminal-only refusal for workspace commands).
    let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));

    // Control socket: same first-party `cs` surface as a workspace
    // serve, scoped to what a terminal tenant can answer. Terminal /
    // pane / survey / window commands work, and so do the cwd-scoped
    // upload / download; workspace-content commands (open / graph /
    // search / team) refuse with the terminal-only message, except
    // `cs open` which points at `chan open {path}`. The buses are shared with AppState below
    // so SPA replies (`/api/window/reply`, `/api/survey/reply`)
    // complete the blocked `cs pane` / `cs terminal survey` calls.
    // Socket paths are pid+random-suffixed (`/tmp/chan-control-<pid>-
    // <8hex>.sock`) so concurrent serves and the desktop's workspace
    // tenants can't collide, except on a host with a stable control
    // identity (the devserver), whose per-tenant paths are stable
    // across restarts instead (see `start_control_socket`).
    let survey_bus = Arc::new(survey::SurveyBus::new());
    let window_bus = Arc::new(window_bus::WindowBus::new());
    let handover_bus = Arc::new(handover_bus::HandoverBus::new());
    let window_presence = Arc::new(window_presence::WindowPresence::new());
    let window_transfers = Arc::new(window_transfers::WindowTransfers::new());
    let session_registry = Arc::new(session_presence::SessionRegistry::new());
    let session_reaper = session_roster::spawn_session_reaper(
        session_registry.clone(),
        events_tx.clone(),
        shutdown_rx.clone(),
    );
    let terminal_registry_cell: control_socket::TerminalRegistryCell =
        Arc::new(std::sync::OnceLock::new());
    // A terminal tenant has no workspace to unserve, so a standalone
    // terminal refuses; a hosted terminal still carries the host handle so an
    // Unserve that lands on its socket can unmount the right WORKSPACE tenant.
    let unserve_scope = match unserve {
        chan_library::UnserveMode::Host(weak) => chan_library::UnserveScope::Host(weak),
        chan_library::UnserveMode::Standalone | chan_library::UnserveMode::Unsupported => {
            chan_library::UnserveScope::Unsupported
        }
    };
    let (control_socket_path, control_socket) = start_control_socket(
        control_identity.as_deref(),
        &config.prefix,
        control_socket::ControlSocketCtx {
            workspace_cell: workspace_cell.clone(),
            events_tx: events_tx.clone(),
            self_writes: self_writes.clone(),
            terminal_registry: terminal_registry_cell.clone(),
            survey_bus: survey_bus.clone(),
            window_bus: window_bus.clone(),
            session_registry: session_registry.clone(),
            handover_bus: handover_bus.clone(),
            desktop: desktop.clone(),
            tenant: control_socket::ControlTenant::TerminalOnly,
            unserve: unserve_scope,
        },
    );
    prime_terminal_shell();
    let terminal_sessions = Arc::new(TerminalRegistry::new(TerminalRegistryConfig {
        workspace_root: workspace_root.clone(),
        mcp_socket_path: None,
        // Injected into every PTY as $CHAN_CONTROL_SOCKET so `cs`
        // works inside standalone terminals.
        control_socket_path,
        terminal: server_config.terminal.clone(),
    }));
    // A terminal-only tenant is long-lived but has neither the workspace
    // settings route nor its config-change push path. Pull the preference at
    // each PTY spawn instead. `ServerConfig::load` reads the same
    // `config::default_path()` that the workspace PATCH persists through
    // `ServerConfig::save`; that path has one authority,
    // `chan_workspace::paths::config_dir()`, including its CHAN_HOME override.
    // A malformed or unreadable store returns None, so the registry keeps its
    // last good value and creation stays available (possibly stale until the
    // store becomes readable again).
    terminal_sessions.install_terminal_backend_resolver(TerminalBackendResolver::new(|| {
        ServerConfig::load()
            .ok()
            .map(|config| config.terminal.ghostty)
    }));
    // Hand the live registry to the control socket so cs term
    // write / list can resolve sessions (mirrors build_app).
    let _ = terminal_registry_cell.set(terminal_sessions.clone());
    // A durable layout store (the launcher's devserver terminal session dir)
    // means this tenant's window layouts live in `terminal_blob`. Wire the blob
    // reaper so an EXPLICIT window discard (cs window rm / a watcher reconcile)
    // drops the window's saved layout too -- the host's reap can't reach this
    // chan-server store directly. Ephemeral / control tenants (`None`) leave it
    // unset; their layout is in-memory and dies with the process.
    if let Some(dir) = session_dir.clone() {
        terminal_sessions.install_blob_reaper(terminal_sessions::BlobReaper::new(
            move |window_id: &str| {
                let _ = crate::terminal_blob::delete(&dir, window_id);
            },
        ));
    }
    let terminal_sessions_handle = terminal_sessions.clone();
    let terminal_pruner = terminal_sessions.clone().spawn_pruner(shutdown_rx.clone());
    let terminal_drainer = terminal_sessions.clone().spawn_drainer(shutdown_rx.clone());
    let terminal_roster_broadcaster = spawn_roster_broadcaster(
        terminal_sessions.clone(),
        events_tx.clone(),
        shutdown_rx.clone(),
    );

    let state = Arc::new(AppState {
        // The host's shared registry handle: no terminal route reaches it,
        // but `/api/config` joins the workspace list into the global config
        // view, so reuse the live handle rather than leaking a throwaway per
        // window.
        library,
        workspace_root,
        workspace_cell: workspace_cell.clone(),
        token: token.clone(),
        prefix: prefix.clone(),
        settings_disabled: config.settings_disabled,
        events_tx,
        index_events_tx,
        server_config: Mutex::new(server_config),
        editor_prefs: Mutex::new(editor_prefs),
        config_revision: AtomicU64::new(1),
        config_write_serial: Mutex::new(()),
        self_writes,
        last_activity: last_activity.clone(),
        terminal_sessions,
        doc_sessions: Arc::new(doc_sessions::DocRegistry::new()),
        scene_sessions: Arc::new(scene_sessions::SceneRegistry::new()),
        shutdown_rx,
        scope_registry,
        survey_bus,
        window_bus,
        handover_bus,
        ephemeral_sessions: Mutex::new(std::collections::HashMap::new()),
        // A persisted devserver terminal sets this (its launcher session
        // store); a control / desktop-local terminal passes None.
        terminal_session_dir: session_dir,
        window_presence,
        session_registry,
        window_transfers,
        window_titles: desktop.window_titles.clone(),
        bulk_transfer: bulk_transfer.tenant(),
        instance_id: random_token(),
    });

    // Nest under the prefix exactly like `build_app` so the host's
    // prefix dispatch reaches `/terminal-<seq><route>` and handlers
    // still see workspace-relative paths (`/api/...`, `/ws`).
    let inner = terminal_router(state.clone());
    let app = if config.prefix.is_empty() {
        inner
    } else {
        Router::new().nest(&config.prefix, inner)
    };
    let tasks = chan_library::TenantTaskOwner::new(
        shutdown_tx.clone(),
        vec![
            terminal_pruner,
            terminal_drainer,
            terminal_roster_broadcaster,
            session_reaper,
        ],
    );

    Ok(AppArtifacts {
        app,
        token,
        last_activity,
        workspace_cell,
        tasks,
        bulk_transfer,
        prefix,
        // No workspace to MCP-bridge; the control socket above IS the
        // local CLI surface (terminal-scoped).
        mcp_bridge: None,
        control_socket,
        terminal_sessions: terminal_sessions_handle,
        state,
        shutdown_tx,
    })
}

/// Slim sibling of [`router`] for a workspace-less terminal tenant.
///
/// Mounts ONLY the routes a terminal-only SPA needs: the terminal PTY
/// surface (ws + CRUD + restart), the per-window session blob, the
/// event/pane `/ws` bus, build-info / health, and the SPA shell
/// fallback. No file / graph / index / drafts / contacts / inspector /
/// settings route is present (they all require a live workspace), so a stray
/// workspace-content request 404s. Auth + serve_static are layered identically to
/// [`router`] so `/api/*` stays tokened -- a PTY is shell access.
fn terminal_router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/api/terminal/ws", get(api_terminal_ws))
        // Per-tenant Terminal-N name sequence: standalone terminal windows
        // share this one tenant -> one global sequence. The full router
        // mounts the same route for per-workspace sequences.
        .route("/api/terminal/next-name", get(api_terminal_next_name))
        // Cross-window roster seed; live updates ride the `/ws` bus.
        .route("/api/terminals/roster", get(api_terminals_roster))
        .route("/api/terminals", post(api_create_terminal))
        .route("/api/terminals/{session}", delete(api_delete_terminal))
        .route(
            "/api/terminals/{session}/restart",
            post(api_restart_terminal),
        )
        // Cross-window broadcast toggle (Select All / per-row, other windows).
        .route(
            "/api/terminals/{session}/broadcast",
            post(api_set_terminal_broadcast),
        )
        // Standalone-terminal file transfer: `cs upload` / `cs download` from a
        // workspace-less terminal land here (cwd / shell-uid scoped). Same URLs
        // as the workspace router so the SPA's transfer bubble is unchanged; the
        // handlers re-root the path at `/` and pre-flight read/write access.
        .route(
            "/api/files/upload",
            post(crate::routes::transfer::api_terminal_upload_file)
                .layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/files/{*path}",
            get(crate::routes::transfer::api_terminal_read_file),
        )
        .route("/api/build-info", get(api_build_info))
        .route("/api/health", get(api_health))
        // Global preferences: Settings opens the shared configuration surface,
        // which reads and writes the `terminal` sub-config here. Both handlers
        // are workspace-free (editor_prefs + server_config + the registry
        // view), so they are safe on the slim tenant. PATCH skips the tunnel
        // settings_guard: a terminal window is always a local desktop mount,
        // never a tunnel run.
        .route("/api/config", get(api_get_config).patch(api_patch_config))
        // Per-window layout blob: the terminal SPA persists its split /
        // tab layout here keyed by `?w=<window-label>`, same contract as
        // workspace mode.
        .route(
            "/api/session",
            get(api_get_session)
                .put(api_put_session)
                .delete(api_delete_session),
        )
        .route("/api/sessions", get(api_list_sessions))
        // Window enumeration (connected / saved): the desktop's
        // remote Window menu and `cs window list` read this.
        .route("/api/windows", get(api_list_windows))
        // Blocked-CLI reply routes: the SPA completes `cs pane`
        // (window bus) and `cs terminal survey` (survey bus) round
        // trips here. Both buses are workspace-free, and the terminal
        // tenant's control socket parks on the same Arcs. `cs paste`
        // rides the same window bus and its reply carries a base64 image,
        // so the body limit is raised past axum's 2 MiB default to clear
        // a `MAX_CLIPBOARD_BYTES` payload (else a normal photo 413s).
        .route(
            "/api/window/reply",
            post(api_window_reply).layer(DefaultBodyLimit::max(
                chan_shell::MAX_CONTROL_REQUEST_BYTES as usize,
            )),
        )
        .route("/api/survey/reply", post(api_survey_reply))
        // cs session handover reply: the leader accepts/rejects a parked
        // `cs session handover`, unblocking the requester's CLI.
        .route(
            "/api/session/handover/reply",
            post(api_session_handover_reply),
        )
        // Events / broadcast / pane bus.
        .route("/ws", get(ws_upgrade));
    Router::new()
        .merge(api)
        .fallback(serve_static)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

/// chan-server's implementation of chan-library's tenant-construction boundary.
/// `WorkspaceHost` holds an `Arc<dyn TenantBuilder>` and calls these to mount a
/// tenant; they wrap [`build_app`]/[`build_terminal_app`] and adapt the
/// route-layer `AppArtifacts` to the host-facing `TenantArtifacts`.
pub(crate) struct RouteLayer {
    extension_catalog: Arc<extensions::ExtensionCatalog>,
    /// One lane for the whole hosted process, shared into every workspace and
    /// terminal tenant this builder mounts. The bound is process-wide, so a
    /// second mounted workspace must not get a second allocation.
    bulk_transfer: Arc<crate::bulk_transfer::BulkTransferLane>,
}

/// The route layer's tenant constructor, as an `Arc<dyn TenantBuilder>` for a
/// `WorkspaceHost`. Embedders (the devserver, chan-desktop) pass this to
/// `WorkspaceHost::new`/`with_desktop_bridge` so the host builds tenants over
/// chan-server's routes without naming `RouteLayer`.
pub fn route_builder() -> Arc<dyn chan_library::TenantBuilder> {
    Arc::new(RouteLayer {
        extension_catalog: extensions::empty_catalog(),
        bulk_transfer: crate::bulk_transfer::BulkTransferLane::new(),
    })
}

/// Build workspace tenants over one process-owned extension runtime. The
/// devserver and chan-desktop use this form so every mounted workspace sees
/// the same catalog without spawning duplicate subprocesses.
pub fn route_builder_with_extensions(
    runtime: &ExtensionRuntime,
) -> Arc<dyn chan_library::TenantBuilder> {
    Arc::new(RouteLayer {
        extension_catalog: runtime.catalog(),
        bulk_transfer: crate::bulk_transfer::BulkTransferLane::new(),
    })
}

/// Install the local-disk library's window registry on chan-desktop's embedded
/// `host`: the persisted window set at `~/.chan/windows.json`, library id
/// `"local"`. The window feed has no data until a registry is installed; this is
/// the desktop's counterpart to the devserver's `~/.chan/devserver/windows.json`.
pub fn install_local_window_registry(host: &WorkspaceHost) {
    // Single chan-home authority so `CHAN_HOME` relocates the local window store.
    let store = chan_workspace::paths::config_dir().join("windows.json");
    host.install_window_registry(
        Arc::new(chan_library::windows::WindowRegistry::open(store)),
        "local".to_string(),
    );
}

/// Install the local-disk library's workspace on/off overlay on chan-desktop's
/// embedded `host`: the persisted on/off set at `~/.chan/workspaces.json`,
/// co-located with the window registry. The desktop's counterpart to the
/// devserver's `~/.chan/devserver/workspaces.json`; the boot path reads it to
/// re-serve the workspaces the user left on.
pub fn install_local_workspace_overlay(host: &WorkspaceHost) {
    // Single chan-home authority so `CHAN_HOME` relocates the local overlay store.
    let store = chan_workspace::paths::config_dir().join("workspaces.json");
    host.install_workspace_overlay(Arc::new(WorkspaceOverlay::open(store)));
}

/// Install the launcher SPA as the host's root fallback: the devserver/library
/// root `/` then serves `web-launcher` (and its `/api/library/*` data surface)
/// instead of 404ing. Both embedders call this once after wrapping the host in
/// an `Arc` -- chan-desktop's loopback (`embedded.rs`) and the headless devserver
/// (`build_devserver_app`) -- so the one launcher is reached on every surface
/// through the existing transparent proxy.
///
/// `bearer` gates `/api/library/*`: the desktop loopback passes its per-window
/// token and the devserver passes its rotatable devserver token. Tunnel-origin
/// requests bypass the local bearer only after the gateway proxy authenticates
/// the browser (the request carries a signed gateway assertion). The static SPA
/// shell is always public regardless, so it loads before it holds the token.
///
/// `serve_addr` is the read-only/full discriminator AND the mount enabler for
/// workspace mutation (which is loopback-only):
///   - `Some(cell)` -- the loopback: workspace add/on/off/rm is served, and the
///     mount path reads the listen address from the `OnceLock`. The embedder
///     fills it AFTER it binds (the install happens before the bind), so it is
///     read at request time, not install time.
///   - `None` -- the tunnel-trust devserver/gateway surface: workspaces are
///     read-only (mutation handlers answer 403, and the SPA shell is served with
///     a read-only hint so it hides those controls).
pub fn install_launcher_root_fallback(
    host: &Arc<WorkspaceHost>,
    bearer: Option<routes::LauncherBearer>,
    serve_addr: Option<Arc<std::sync::OnceLock<std::net::SocketAddr>>>,
) {
    host.install_root_fallback(routes::launcher_router(host.clone(), bearer, serve_addr));
}

/// Request-extension marker inserted by the devserver's tunnel layer on every
/// request that arrived over the gateway tunnel (not the loopback bind).
/// Verified gateway caller claims are present only when devserver-proxy signed
/// the request with this tunnel's assertion key.
#[derive(Clone)]
pub(crate) struct TunnelOrigin {
    pub caller: Option<chan_tunnel_proto::gateway_assertion::Claims>,
}

impl TunnelOrigin {
    pub fn owner(&self) -> bool {
        self.caller
            .as_ref()
            .is_some_and(chan_tunnel_proto::gateway_assertion::Claims::is_owner)
    }
}

#[async_trait::async_trait]
impl chan_library::TenantBuilder for RouteLayer {
    async fn build_workspace(
        &self,
        library: Library,
        workspace: Arc<Workspace>,
        config: &ServeConfig,
        desktop: DesktopBridge,
        unserve: chan_library::UnserveMode,
        control_identity: Option<String>,
    ) -> Result<chan_library::TenantArtifacts, Error> {
        let artifacts = build_app_with_extensions(
            AppBuild {
                library,
                workspace,
                extension_catalog: self.extension_catalog.clone(),
                desktop,
                unserve,
                control_identity,
                bulk_transfer: self.bulk_transfer.clone(),
            },
            config,
        )
        .await?;
        Ok(into_tenant_artifacts(artifacts))
    }

    async fn build_terminal(
        &self,
        library: Library,
        config: &ServeConfig,
        desktop: DesktopBridge,
        unserve: chan_library::UnserveMode,
        command: Option<String>,
        session_dir: Option<PathBuf>,
        control_identity: Option<String>,
    ) -> Result<chan_library::TenantArtifacts, Error> {
        let artifacts = build_terminal_app(
            library,
            config,
            desktop,
            unserve,
            session_dir,
            control_identity,
            self.bulk_transfer.clone(),
        )
        .await?;
        // The tenant's terminals run `command` (when set) rather than the
        // default shell; applied before the SPA can open the first one.
        artifacts.terminal_sessions.set_default_command(command);
        Ok(into_tenant_artifacts(artifacts))
    }
}

/// Reduce a route-layer `AppArtifacts` to the host-facing `TenantArtifacts`:
/// surface what the host routes / reconciles / tears down with, and stash the
/// rest (MCP bridge, control socket, and the AppState the router owns) in the
/// opaque keepalive. The task owner remains explicit so the host can join it
/// before clearing the workspace cell.
fn into_tenant_artifacts(a: AppArtifacts) -> chan_library::TenantArtifacts {
    let AppArtifacts {
        app,
        token,
        last_activity,
        workspace_cell,
        tasks,
        bulk_transfer,
        prefix,
        mcp_bridge,
        control_socket,
        terminal_sessions,
        state,
        shutdown_tx: _,
    } = a;
    let window_presence = state.window_presence.clone();
    // The SAME Arc the AppState holds, so the `/ws` route's transfer updates
    // and the host's close-guard query read one shared count (mirror presence).
    let window_transfers = state.window_transfers.clone();
    // The SAME registry the `/ws` pump drives, so the host reads this tenant's
    // leader and installs the watch-feed change signal on it (mirror presence).
    let session_registry = state.session_registry.clone();
    // The SAME broadcast channel the `/ws` pump forwards, so the host can send a
    // targeted window_command teardown frame to a window's socket.
    let events_tx = state.events_tx.clone();
    let cell: Arc<dyn chan_library::WorkspaceCellHandle> = Arc::new(CellHandle(workspace_cell));
    chan_library::TenantArtifacts {
        app,
        token,
        terminal_sessions,
        tasks,
        prefix,
        window_presence,
        window_transfers,
        session_registry,
        events_tx,
        cell,
        // `bulk_transfer` rides here as the tenant's lane lifetime: the host
        // drops this box when it unmounts the tenant, which is what releases
        // the hosted process lane once its last tenant is gone.
        keepalive: Box::new((
            last_activity,
            mcp_bridge,
            control_socket,
            state,
            bulk_transfer,
        )),
    }
}

/// Route-layer implementation of chan-library's `WorkspaceCellHandle`: drives a
/// tenant's `WorkspaceCell` (which owns the search indexer) on the host's
/// behalf without exposing the concrete cell type.
struct CellHandle(Arc<RwLock<Option<WorkspaceCell>>>);

impl chan_library::WorkspaceCellHandle for CellHandle {
    fn workspace(&self) -> Option<Arc<Workspace>> {
        let cell = self.0.read().ok()?;
        Some(cell.as_ref()?.workspace.clone())
    }

    fn cancel_reindex(&self) {
        if let Ok(cell) = self.0.read() {
            if let Some(cell) = cell.as_ref() {
                cell.indexer.cancel();
            }
        }
    }

    fn clear(&self) -> Option<(Weak<Workspace>, PathBuf)> {
        let cell = self.0.write().ok()?.take()?;
        let WorkspaceCell {
            workspace,
            watch_handle,
            indexer,
        } = cell;
        // Clear the shared cell before socket accept loops finish aborting;
        // otherwise their stale Arc can keep the workspace marked open.
        indexer.cancel();
        workspace.stop_open_recovery();
        drop(watch_handle);
        drop(indexer);
        // Capture the lock dir before dropping the workspace: the flock-free
        // wait needs it, and the workspace is gone by then.
        let lock_dir = workspace.paths().lock.clone();
        let weak = Arc::downgrade(&workspace);
        drop(workspace);
        Some((weak, lock_dir))
    }
}

/// Spawn the listener, build the router, and serve forever.
/// Returns when the server stops (e.g. on SIGINT).
///
/// `library` is held alongside `workspace` so handlers that mutate
/// the registry (rename, etc.) operate against the same state the
/// CLI sees. Both are `Arc`-able and cheap to clone.
pub async fn serve(
    library: Library,
    workspace: Arc<Workspace>,
    config: ServeConfig,
) -> Result<(), Error> {
    // Boot-timing anchor: the listener bind is the first observable step, and
    // the gap from here to the "ready" URL below is the cold-boot latency that
    // a large workspace stresses. Logged so a slow boot can be attributed to
    // the bind vs. the router build vs. the watcher registration.
    let boot_t0 = Instant::now();
    let listener = TcpListener::bind(config.addr).await?;
    let addr = listener.local_addr()?;
    tracing::debug!(
        t_listener_ms = boot_t0.elapsed().as_millis() as u64,
        "boot: listener bound"
    );
    let extension_runtime = ExtensionRuntime::start().await;
    // Standalone `chan open`: no desktop attached, so no window-ops
    // bridge and an empty (unwritten) title map. No stable control
    // identity either -- a window-spawned serve's control socket dies
    // with the process by design.
    let mut artifacts = build_app_with_extensions(
        AppBuild {
            library,
            workspace,
            extension_catalog: extension_runtime.catalog(),
            desktop: crate::desktop_window_ops::DesktopBridge::default(),
            unserve: chan_library::UnserveMode::Standalone,
            control_identity: None,
            // A standalone serve is its own process, so it owns its own lane
            // rather than sharing a host's.
            bulk_transfer: crate::bulk_transfer::BulkTransferLane::new(),
        },
        &config,
    )
    .await?;
    // External / CLI edits to the per-library config (`chan config`, a
    // hand-edit, a synced dotfile) refresh open windows, on top of the
    // PATCH path's push-on-write. Held for serve()'s lifetime; dropping it
    // stops the watch. A registration failure is non-fatal: external edits
    // then reconcile on the next reload.
    let _config_watcher = match config_watch::start(artifacts.state.clone()) {
        Ok(watcher) => Some(watcher),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "config watch registration failed; external config edits reconcile on reload"
            );
            None
        }
    };
    let handle = ServeHandle {
        addr,
        prefix: config.prefix.clone(),
        token: artifacts.token.clone(),
    };
    let url = handle.launch_url();
    eprintln!("chan is ready:\n{url}");
    tracing::info!(
        t_url_ms = boot_t0.elapsed().as_millis() as u64,
        "boot: ready, URL printed"
    );
    if should_open_browser(config.open_browser) {
        // Best-effort: on a headless host (no `xdg-open`/no display)
        // this returns an error; log a NOTE and keep serving.
        if let Err(e) = open::that_detached(&url) {
            eprintln!("NOTE: could not open browser ({e}); visit the URL above.");
        }
    }

    let app = artifacts.app.clone();
    let last_activity = artifacts.last_activity.clone();
    let workspace_cell = artifacts.workspace_cell.clone();

    // Single shutdown channel fed by both the idle-timeout watcher
    // (when --timeout is set) and SIGINT/SIGTERM. axum's
    // with_graceful_shutdown awaits a `changed()` on it, then stops
    // accepting new connections and drains in-flight ones. The
    // channel itself was created inside build_app so AppState (for
    // ws_pump and other long-lived handlers) shares the same signal.
    let signal_tx = artifacts.shutdown_tx.clone();

    if let Some(timeout) = config.idle_timeout {
        spawn_idle_watcher(timeout, last_activity.clone(), signal_tx.clone());
    }

    // Side task: when the shutdown signal fires, cancel any in-flight
    // reindex. The flag is checked at per-file boundaries inside
    // `Workspace::reindex`, so the blocking task lands within at most one
    // file's worth of work and the runtime drop can return cleanly.
    let cancel_workspace_cell = workspace_cell.clone();
    let mut cancel_rx = signal_tx.subscribe();
    tokio::spawn(async move {
        let _ = cancel_rx.changed().await;
        if let Ok(cell) = cancel_workspace_cell.read() {
            if let Some(cell) = cell.as_ref() {
                cell.indexer.cancel();
            }
        }
    });

    // Shared drain: spawns the SIGINT/SIGTERM watcher, hands axum the
    // graceful-shutdown receiver, and force-exits after the grace window so
    // a lingering WebSocket can't hang the process.
    let serve_result = graceful_serve(listener, app, signal_tx).await;
    artifacts.tasks.shutdown().await;
    extension_runtime.shutdown().await;
    serve_result.map_err(Error::Io)?;
    Ok(())
}

#[cfg(test)]
fn router(state: Arc<AppState>) -> Router {
    router_with_extensions(state, extensions::empty_catalog())
}

fn router_with_extensions(
    state: Arc<AppState>,
    extension_catalog: Arc<extensions::ExtensionCatalog>,
) -> Router {
    let extension_tenant = extensions::ExtensionTenantContext {
        scope: state.instance_id.clone(),
        shutdown_rx: state.shutdown_rx.clone(),
    };
    // ---- Settings-write gate ----------------------------------------
    //
    // Refused with 403 by `tunnel_guard::settings_guard` on a
    // `--no-settings` serve (kiosk / shared workstation). Reads of the
    // same areas stay open via the main router below; the SPA can still
    // populate values in view mode. The middleware runs as a route_layer
    // on this sub-router so it fires before the JSON / query extractors
    // and a malformed body cannot leak the request schema via 422.
    let settings_writes = Router::new()
        .route("/api/config", patch(api_patch_config))
        .route("/api/storage/reset", post(api_storage_reset))
        .route("/api/index/rebuild", post(api_index_rebuild));
    // Per-workspace semantic-search write endpoints. Same
    // settings-gated lane as `/api/index/rebuild` since flipping
    // the workspace's `semantic_enabled` is a settings change and the
    // download path mutates the per-machine model cache.
    #[cfg(feature = "embeddings")]
    let settings_writes = settings_writes
        .route("/api/index/semantic/enable", post(api_semantic_enable))
        .route("/api/index/semantic/disable", post(api_semantic_disable))
        .route("/api/index/semantic/download", post(api_semantic_download))
        .route("/api/index/semantic/model", patch(api_semantic_model_patch));
    // Reports feature toggle endpoints. Mirror the
    // semantic shape but NOT gated on `embeddings`; reports are
    // part of the BM25-only baseline. Settings-writes lane because
    // flipping the toggle is a settings change.
    let settings_writes = settings_writes
        .route("/api/index/reports/enable", post(api_reports_enable))
        .route("/api/index/reports/disable", post(api_reports_disable));
    // Screensaver overlay state + PIN endpoints.
    // PATCH/state, POST/pin, DELETE/pin land in settings-writes.
    // POST/verify is a read-side action (checks the stored hash)
    // so it stays in the unrestricted lane below; non-owners
    // can still trigger the verify path to dismiss the overlay.
    let settings_writes = settings_writes
        .route("/api/screensaver/state", patch(api_screensaver_patch))
        .route("/api/screensaver/pin", post(api_screensaver_set_pin))
        .route("/api/screensaver/pin", delete(api_screensaver_clear_pin));
    // Source Code Pro download endpoint.
    // Settings-gated lane because activating the font is a
    // preference write + the download mutates the per-machine
    // user-config dir.
    let settings_writes = settings_writes.route(
        "/api/fonts/source-code-pro/download",
        post(api_fonts_source_code_pro_download),
    );
    let settings_writes = settings_writes.route("/api/metadata/export", post(api_metadata_export));
    let settings_writes = settings_writes.route(
        "/api/metadata/import",
        post(api_metadata_import).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
    );
    let settings_writes = settings_writes.route_layer(middleware::from_fn_with_state(
        state.clone(),
        tunnel_guard::settings_guard,
    ));

    // ---- Open routes ------------------------------------------------
    //
    // Everything not in the gated sub-router above: read-only
    // endpoints, workspace-content writes (allowed in tunnel mode by
    // design), and per-window session storage.
    let api = Router::new()
        .route("/api/workspace", get(api_get_workspace))
        .route("/api/workspace/bootstrap", get(api_workspace_bootstrap))
        .route("/api/cloud-workspaces", get(api_cloud_workspaces))
        .route("/api/files", get(api_list_files).post(api_create_file))
        .route(
            "/api/files/upload",
            post(api_upload_file).layer(DefaultBodyLimit::disable()),
        )
        // New Draft action. Creates `<drafts_dir>/<next-untitled>/draft.md`
        // in the in-root drafts dir (`.Drafts/` by default) as ordinary
        // workspace content; it indexes and graphs through the normal walk.
        // SPA Cmd+N chord routes here; the response path opens via the
        // existing /api/files/<path> GET path like any other file.
        .route("/api/drafts/new", post(api_create_draft))
        .route("/api/diagrams/new", post(api_create_diagram))
        .route("/api/drafts/inspect", post(api_inspect_draft))
        .route("/api/drafts/discard", post(api_discard_draft))
        .route("/api/drafts/promote", post(api_promote_draft))
        .route(
            "/api/session-conflicts/resolve",
            post(api_resolve_session_conflict),
        )
        // Path-based chan-team.toml read/write for the Team Work
        // dialog's New/Load flow.
        // Deliberately outside the workspace sandbox (user path,
        // default /tmp); see routes/team_config.rs module docs.
        .route("/api/team-config/read", post(api_team_config_read))
        .route("/api/team-config/write", post(api_team_config_write))
        // cs terminal survey reply: completes the parked survey
        // oneshot on the survey bus.
        .route("/api/survey/reply", post(api_survey_reply))
        // cs pane / cs paste reply: completes the parked window-bus oneshot
        // with the SPA's layout snapshot or clipboard payload. The clipboard
        // reply carries a base64 image, so the body limit clears a
        // `MAX_CLIPBOARD_BYTES` payload past axum's 2 MiB default.
        .route(
            "/api/window/reply",
            post(api_window_reply).layer(DefaultBodyLimit::max(
                chan_shell::MAX_CONTROL_REQUEST_BYTES as usize,
            )),
        )
        // Command-launcher Open: `cs open` semantics over HTTP (Contract C).
        // Workspace tenants only (a standalone terminal has no workspace to
        // open into); tunnel-reachable by design, see routes/open.rs.
        .route("/api/open", post(api_open))
        // cs session handover reply: the leader accepts/rejects a parked
        // `cs session handover`, unblocking the requester's CLI.
        .route(
            "/api/session/handover/reply",
            post(api_session_handover_reply),
        )
        .route(
            "/api/files/{*path}",
            get(api_read_file).delete(api_delete_file),
        )
        // The progressive raw-text sink owns the semantic limit:
        // max(existing size, TEXT_WRITE_LIMIT). Any fixed framework
        // cap would reject a valid legacy-file shrink before it reaches
        // that policy and its atomic cleanup path.
        .route(
            "/api/files/{*path}",
            put(api_write_file).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/move", post(api_move))
        .route("/api/fs/transfer", post(api_fs_transfer))
        .route("/api/search/files", get(api_search_files))
        .route("/api/search/content", get(api_search_content))
        .route("/api/search/workspace", post(api_search_workspace))
        .route("/api/index/status", get(api_index_status))
        .route("/api/indexing/state", get(api_indexing_state))
        // Per-workspace directory blocklist (additions on top of the global
        // baseline). PUT re-walks off the executor via the indexer.
        .route(
            "/api/index/excluded-dirs",
            get(api_excluded_dirs_get).put(api_excluded_dirs_put),
        )
        // First-boot workspace readiness for the locked OverlayShell:
        // poll the snapshot, submit a step decision.
        .route("/api/preflight", get(api_preflight))
        .route("/api/preflight/decision", post(api_preflight_decision))
        // Non-blocking `cs` terminal-alias offer surfaced on the pre-flight
        // snapshot; this creates the sibling symlink on the owner's request.
        .route("/api/preflight/cs-link", post(api_cs_link_create))
        .route("/api/link-targets", get(api_link_targets))
        .route("/api/resolve-link", get(api_resolve_link))
        .route("/api/headings/{*path}", get(api_headings))
        .route("/api/links", get(api_links))
        .route("/api/graph", get(api_graph))
        .route("/api/graph/languages", get(api_language_graph))
        .route("/api/fs-graph", get(api_fs_graph))
        .route("/api/inspector", get(api_inspector))
        // Prefix-matched mention completion. Editor
        // queries this to surface `@@<Name>` references across the
        // broader markdown corpus (not just contacts).
        .route("/api/mentions", get(api_get_mentions))
        .route("/api/backlinks/{*path}", get(api_backlinks))
        .route("/api/report/file", get(api_report_file))
        .route("/api/report/prefix", get(api_report_prefix))
        .route("/api/report/dir", get(api_report_dir))
        .route("/api/config", get(api_get_config))
        .route("/api/build-info", get(api_build_info))
        .route("/api/extensions", get(api_extensions))
        // Session blob keyed by window id (?w=<id>). The frontend
        // sends the window id as a query string (path-segment encode
        // would force special-character escaping for free-form ids);
        // the server matches that contract. GET on a missing key
        // returns 204, not 404, since "no session yet" is the normal
        // first-launch state.
        .route(
            "/api/session",
            get(api_get_session)
                .put(api_put_session)
                .delete(api_delete_session),
        )
        .route("/api/sessions", get(api_list_sessions))
        // Window enumeration (connected / saved): the desktop's remote
        // Window menu and `cs window list` read this.
        .route("/api/windows", get(api_list_windows))
        .route(
            "/api/attachments",
            // Image attachments cap. Axum's default body limit is
            // 2 MiB, which rejects routine phone photos and
            // screenshots; 50 MiB matches the editor's client-side
            // pre-flight in `imageBubble.ts` so an upload that
            // passes the browser check also passes here.
            post(api_post_attachment).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route("/api/contacts", get(api_get_contacts))
        // Google Contacts CSV exports run a few hundred KB for normal
        // address books and into the low MB for power users. axum's
        // 2 MB default would silently 413 the larger ones; cap at
        // 32 MiB so we cover the realistic ceiling without inviting
        // accidental DoS via huge uploads.
        .route(
            "/api/contacts/import",
            post(api_post_contacts_import).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/api/health", get(api_health))
        .route("/api/terminal/ws", get(api_terminal_ws))
        // Live co-editing doc sessions: one duplex socket per (editor
        // mount, document). Wire contract pinned in routes/doc.rs.
        .route("/api/doc/ws", get(api_doc_ws))
        // Live Excalidraw scene sessions: one duplex socket per (canvas
        // mount, scene). Wire contract pinned in routes/scene.rs.
        .route("/api/scene/ws", get(api_scene_ws))
        // Per-workspace Terminal-N sequence + cross-window roster seed.
        // Same handlers as the slim terminal router; the per-tenant registry
        // gives each workspace its own name sequence and roster.
        .route("/api/terminal/next-name", get(api_terminal_next_name))
        .route("/api/terminals/roster", get(api_terminals_roster))
        .route("/api/terminals", post(api_create_terminal))
        .route("/api/terminals/{session}", delete(api_delete_terminal))
        .route(
            "/api/terminals/{session}/restart",
            post(api_restart_terminal),
        )
        .route(
            "/api/terminals/{session}/broadcast",
            post(api_set_terminal_broadcast),
        )
        .route("/ws", get(ws_upgrade))
        // Bundled font assets (Source Code Pro Regular + OFL.txt)
        // served from chan-server's rust-embed.
        // The SPA's `@font-face` declaration points at this path; a
        // future expansion (italic / bold weights, additional faces)
        // drops more entries into `crates/chan-server/resources/fonts/`
        // and the same `{name}` segment serves them.
        .route("/static/fonts/{name}", get(serve_font));
    // Read-only semantic-search state. Gated on
    // `embeddings` because the SemanticState payload + the
    // `chan-workspace` resolver behind it only exist when the candle
    // stack compiles in. Write routes (`enable` / `disable` /
    // `download`) sit in `settings_writes` and merge below.
    #[cfg(feature = "embeddings")]
    let api = api
        .route("/api/index/semantic/state", get(api_semantic_state))
        .route("/api/index/semantic/models", get(api_semantic_models));
    // Reports state is read-only + not settings-
    // gated (read-only views can land in any lane).
    let api = api.route("/api/index/reports/state", get(api_reports_state));
    // Screensaver state + verify are read-side.
    // /verify is unrestricted so non-owners can still unlock the
    // overlay on shared-machine scenarios.
    let api = api
        .route("/api/screensaver/state", get(api_screensaver_state))
        .route("/api/screensaver/verify", post(api_screensaver_verify));
    let api = api.merge(settings_writes);
    // Extension capability proxy. Non-owner tunnel guests are read-only
    // here: the shared `require_local_mutation` lane 403s their
    // POST/PUT/DELETE, mirroring the launcher routes. GETs — including
    // WebSocket upgrades — still pass for guests (accepted v1 caveat:
    // the extension document itself loads via GET).
    let extension_proxy = Router::new()
        .route(
            "/_chan/extensions/{id}/{capability}/",
            any(proxy_extension_root),
        )
        .route(
            "/_chan/extensions/{id}/{capability}/{*path}",
            any(proxy_extension),
        )
        .route_layer(middleware::from_fn(require_local_mutation))
        // Outermost on the namespace: every response leaving these
        // routes, the guest 403 included, carries the extension
        // response policy so the opaque-origin frame reads true
        // statuses instead of a CORS mask.
        .route_layer(middleware::from_fn(extension_response_policy));
    let api = api.merge(extension_proxy);
    Router::new()
        .merge(api)
        .fallback(serve_static)
        .layer(axum::Extension(extension_tenant))
        .layer(axum::Extension(extension_catalog))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

// `sanitize_prefix` + `ServeHandle::launch_url` tests live in chan-library
// (`serve_config`) alongside the moved types.

#[cfg(test)]
mod bulk_transfer_construction_tests {
    use super::*;
    use crate::bulk_transfer::{BulkTransferLane, ACTIVE_CAPACITY, WAITING_CAPACITY};

    /// A hosted process holds one `RouteLayer`, and both tenant constructors
    /// mint from its single `bulk_transfer` field. If that field were
    /// allocated per tenant instead, a second mounted workspace would double
    /// the machine's concurrent transfer load, which is the failure the
    /// process-wide bound exists to prevent.
    #[test]
    fn one_route_layer_holds_one_lane_for_every_tenant_it_mounts() {
        let layer = RouteLayer {
            extension_catalog: extensions::empty_catalog(),
            bulk_transfer: BulkTransferLane::new(),
        };
        // Stand in for the two tenants a hosted process mounts; both come
        // from the same field the real constructors read.
        let workspace_tenant = layer.bulk_transfer.tenant();
        let terminal_tenant = layer.bulk_transfer.tenant();

        // Fill the whole process budget from one tenant, holding every job so
        // nothing drains, then prove the sibling tenant is refused.
        let mut releases = Vec::new();
        let mut held = Vec::new();
        for _ in 0..(ACTIVE_CAPACITY + WAITING_CAPACITY) {
            let (release, park) = std::sync::mpsc::channel::<()>();
            releases.push(release);
            held.push(
                workspace_tenant
                    .submit(move |_| {
                        let _ = park.recv();
                    })
                    .expect("within the process budget"),
            );
        }

        assert!(
            terminal_tenant.submit(|_| ()).is_err(),
            "a second tenant of the same process must not get its own budget"
        );

        drop(releases);
    }
}

#[cfg(test)]
mod terminal_router_tests {
    use super::*;
    use crate::terminal_sessions::{
        AttachHandle, CloseReason, CreateOptions, RestartOverrides, SessionEvent,
    };
    use portable_pty::PtySize;

    const HOSTED_BACKEND_CHILD: &str = "CHAN_TEST_HOSTED_TERMINAL_BACKEND_CHILD";
    const HOSTED_BACKEND_TEST: &str =
        "terminal_router_tests::hosted_terminal_registry_resolves_backend_on_each_spawn";

    fn terminal_create_options(command: Option<&str>) -> CreateOptions {
        CreateOptions {
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
            command: command.map(str::to_owned),
            env: Default::default(),
        }
    }

    async fn collect_terminal_output(
        handle: &mut AttachHandle,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let deadline = Instant::now() + timeout;
        let mut out = String::new();
        while !out.contains(needle) && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, handle.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(data))) => {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Ok(SessionEvent::Error(message))) => {
                    out.push_str(&format!("\n__ERROR__{message}\n"));
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        out
    }

    async fn run_hosted_backend_child() {
        // Match the repository-wide real-PTY/FS timing gate used by the route
        // and workspace tests. This child is its own process, so an in-process
        // mutex would not keep the shell probe out of their critical sections.
        let gate = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(std::env::temp_dir().join("chan-fs-timing-test.gate"))
            .expect("open PTY timing gate");
        gate.lock().expect("acquire PTY timing gate");

        let chan_home = std::env::var_os("CHAN_HOME").expect("isolated CHAN_HOME");
        let chan_home = std::path::PathBuf::from(chan_home);
        let mut stored = ServerConfig::default();
        stored.terminal.ghostty = false;
        stored.save().expect("save initial xterm preference");
        assert_eq!(
            crate::config::default_path(),
            chan_home.join("server.toml"),
            "the hosted resolver test must use its isolated config store"
        );

        let library = Library::open_at(chan_home.join("library.toml")).expect("open library");
        let config = ServeConfig {
            addr: "127.0.0.1:0".parse().unwrap(),
            no_token: true,
            prefix: "/terminal-hosted-proof".into(),
            idle_timeout: None,
            open_browser: false,
            search_aggression: None,
            settings_disabled: false,
            verbose: false,
        };
        let mut artifacts = build_terminal_app(
            library,
            &config,
            DesktopBridge::default(),
            chan_library::UnserveMode::Unsupported,
            None,
            None,
            crate::bulk_transfer::BulkTransferLane::new(),
        )
        .await
        .expect("build terminal app");
        let registry = artifacts.terminal_sessions.clone();
        let mut original = registry
            .create(terminal_create_options(None))
            .expect("create original hosted terminal");
        let original_id = original.id().to_owned();

        stored.terminal.ghostty = true;
        stored.save().expect("flip stored preference to ghostty");

        original.send_input(b"printf 'EXISTING=<%s>\\n' \"$CHAN_TERMINAL\"\n");
        let existing =
            collect_terminal_output(&mut original, "EXISTING=<xterm>", Duration::from_secs(30))
                .await;
        assert!(
            existing.contains("EXISTING=<xterm>"),
            "config flip changed an already-running hosted child: {existing:?}"
        );

        let mut created = registry
            .create(terminal_create_options(Some(
                "printf 'CREATED=<%s>\\n' \"$CHAN_TERMINAL\"",
            )))
            .expect("create hosted terminal after config flip");
        let created_out =
            collect_terminal_output(&mut created, "CREATED=<ghostty>", Duration::from_secs(30))
                .await;
        assert!(
            created_out.contains("CREATED=<ghostty>"),
            "new hosted child did not resolve the stored preference: {created_out:?}"
        );

        assert!(
            registry
                .restart(&original_id, RestartOverrides::default())
                .expect("restart hosted terminal"),
            "original hosted terminal disappeared before restart"
        );
        let mut restarted = registry
            .attach(&original_id, None)
            .expect("attach restarted hosted terminal");
        restarted.send_input(b"printf 'RESTARTED=<%s>\\n' \"$CHAN_TERMINAL\"\n");
        let restarted_out = collect_terminal_output(
            &mut restarted,
            "RESTARTED=<ghostty>",
            Duration::from_secs(30),
        )
        .await;
        assert!(
            restarted_out.contains("RESTARTED=<ghostty>"),
            "hosted restart did not resolve the stored preference: {restarted_out:?}"
        );

        registry.close(created.id(), CloseReason::Explicit);
        registry.close(&original_id, CloseReason::Explicit);
        artifacts.tasks.shutdown().await;
    }

    #[tokio::test]
    async fn hosted_terminal_registry_resolves_backend_on_each_spawn() {
        if std::env::var_os(HOSTED_BACKEND_CHILD).is_some() {
            run_hosted_backend_child().await;
            return;
        }

        // CHAN_HOME is process-global. Run the behavioral body in an exact-
        // filtered child test process so the real default-path load/save pair
        // is isolated without racing unrelated tests in this binary.
        let home = tempfile::tempdir().expect("isolated chan home");
        let output = tokio::process::Command::new(std::env::current_exe().expect("test binary"))
            .arg("--exact")
            .arg(HOSTED_BACKEND_TEST)
            .arg("--nocapture")
            .env(HOSTED_BACKEND_CHILD, "1")
            .env("CHAN_HOME", home.path())
            .output()
            .await
            .expect("run isolated hosted terminal test");
        assert!(
            output.status.success(),
            "isolated hosted terminal proof failed (status={}):\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    // Constructing the slim terminal router asserts its routes assemble without
    // an axum conflict -- in particular the standalone-transfer pair
    // (`/api/files/upload` POST + `/api/files/{*path}` GET) coexisting on this
    // tenant. A conflict panics at build time, which would otherwise only
    // surface when a real standalone-terminal window opens.
    #[tokio::test]
    async fn terminal_router_assembles_with_standalone_transfer_routes() {
        let state = crate::state::test_support::make_test_state(false);
        let _router = terminal_router(state);
    }

    // The terminal tenant's transfer route re-roots its wildcard capture at
    // the filesystem root, so `/api/files/<abs-path>` must resolve and serve
    // the absolute target. Serving real bytes through the assembled router
    // pins the capture shape the handler depends on.
    #[tokio::test]
    async fn terminal_router_serves_absolute_paths_via_wildcard_capture() {
        use axum::body::to_bytes;
        use tower::ServiceExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("probe.txt");
        std::fs::write(&file, b"wildcard capture probe").expect("write probe");

        let state = crate::state::test_support::make_test_state(false);
        let app = terminal_router(state);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/api/files{}?download=1", file.display()))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1 << 20).await.expect("body");
        assert_eq!(&bytes[..], b"wildcard capture probe");
    }
}

#[cfg(test)]
mod wildcard_capture_tests {
    use super::*;

    // api_headings and api_backlinks feed their wildcard capture verbatim
    // into graph lookups keyed by workspace-relative paths WITHOUT a leading
    // slash; a capture that included the slash would silently return empty
    // results instead of erroring. This reflector pins axum's side of that
    // contract: the catch-all capture excludes the slash separating it from
    // the route prefix.
    #[tokio::test]
    async fn wildcard_capture_excludes_the_leading_slash() {
        use tower::ServiceExt;

        let app: Router = Router::new().route(
            "/api/headings/{*path}",
            axum::routing::get(
                |axum::extract::Path(path): axum::extract::Path<String>| async move { path },
            ),
        );
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/headings/notes/a.md")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .expect("body");
        assert_eq!(&bytes[..], b"notes/a.md");
    }
}
