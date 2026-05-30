//! HTTP + WebSocket surface for chan.
//!
//! Wraps `chan-workspace`'s Library / Workspace handles in axum routes,
//! gates every `/api/*` route behind a per-launch bearer token,
//! exposes a watcher WebSocket, and serves the embedded
//! frontend.
//!
//! Auth: every `/api/*` route is gated by a per-launch token. The
//! token is persisted at `<state>/tokens/<workspace-key>` (mode 0600 on
//! Unix) so a `cargo build && chan serve` cycle does not invalidate
//! the browser's cached sessionStorage token. Clients pass it as
//! `?t=TOKEN` query string or `Authorization: Bearer TOKEN` header.
//! Pass `--no-token` to disable; loopback bind is the only check
//! left in that mode (test / desktop-shell only).

#![forbid(unsafe_code)]

mod agent_inbox;
mod auth;
mod bus;
mod config;
mod control_socket;
mod embed_seed;
mod error;
/// macOS CLI-to-desktop workspace handoff over a well-known per-user UDS.
/// Public so both the `chan` CLI (client) and `chan-desktop`
/// (listener) consume it; both already depend on chan-server.
pub mod handoff;
mod host;
mod indexer;
mod mcp_bridge;
mod preferences;
mod qr;
mod routes;
mod self_writes;
mod signal;
mod state;
mod static_assets;
mod store;
mod terminal_sessions;
mod tunnel_guard;
mod util;

pub use config::{ServerConfig, TeamWorkConfig};
pub use error::Error;
pub use host::{HostedWorkspace, WorkspaceHost};
pub use preferences::{
    BrowserSidePanes, EditorPrefs, EditorTheme, HybridSurfaceThemes, LineSpacing, PaneWidths,
    SurfaceThemeChoice, ThemeChoice,
};
pub use routes::{build_fs_graph, FsGraphResponse, FsGraphScope};

use auth::{auth_middleware, load_or_create_token};
use bus::{make_progress_broadcast, make_watch_bridge};
use routes::{
    api_backlinks, api_build_info, api_cloud_workspaces, api_create_draft, api_create_file,
    api_create_terminal, api_delete_file, api_delete_session, api_delete_terminal,
    api_discard_draft, api_fonts_source_code_pro_download, api_fs_graph, api_fs_transfer,
    api_get_config, api_get_contacts, api_get_mentions, api_get_server_config, api_get_session,
    api_get_workspace, api_graph, api_headings, api_health, api_index_rebuild, api_index_status,
    api_indexing_state, api_inspect_draft, api_inspector, api_language_graph, api_link_targets,
    api_links, api_list_files, api_list_sessions, api_metadata_export, api_metadata_import,
    api_move, api_patch_config, api_patch_server_config, api_patch_workspace, api_post_attachment,
    api_post_contacts_import, api_preflight, api_preflight_decision, api_promote_draft,
    api_put_session, api_read_file, api_report_dir, api_report_file, api_report_prefix,
    api_reports_disable, api_reports_enable, api_reports_state, api_resolve_link,
    api_restart_terminal, api_screensaver_clear_pin, api_screensaver_patch,
    api_screensaver_set_pin, api_screensaver_state, api_screensaver_verify, api_search_content,
    api_search_files, api_storage_reset, api_team_config_read, api_team_config_write,
    api_terminal_ws, api_upload_file, api_workspace_bootstrap, api_write_file, ws_upgrade,
};
#[cfg(feature = "embeddings")]
use routes::{
    api_semantic_disable, api_semantic_download, api_semantic_enable, api_semantic_model_patch,
    api_semantic_models, api_semantic_state,
};
use signal::{now_unix_secs, print_qr_if_tty, spawn_idle_watcher, spawn_signal_watcher};
use state::{AppState, WorkspaceCell};
use static_assets::{serve_font, serve_static};
use terminal_sessions::{Registry as TerminalRegistry, RegistryConfig as TerminalRegistryConfig};

/// Tunnel workspace-name helpers re-exported from chan-tunnel-proto so
/// the `chan` binary can pre-validate / pre-sanitize without taking
/// a direct dep on the tunnel proto crate.
pub mod tunnel {
    pub use chan_tunnel_proto::{
        is_valid_workspace_name, sanitize_workspace_name, MAX_WORKSPACE_NAME_LEN,
    };
}

use self_writes::SelfWrites;

use std::net::SocketAddr;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{delete, get, patch, post};
use axum::Router;
use chan_workspace::{Library, SearchAggression, WatchEvent, Workspace};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use tower_http::trace::TraceLayer;

/// Configuration the binary hands the server at boot. Kept terse on
/// purpose; expand only when a route demands it.
#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub addr: SocketAddr,
    /// When true, the server skips the per-launch token gate. For
    /// tests and local dev only. Loopback bind is the only check
    /// left; do not flip this in production.
    pub no_token: bool,
    /// URL path prefix all routes are served under. Canonical form:
    /// empty (no prefix) or `/seg[/seg...]` (leading slash, no
    /// trailing). Use `sanitize_prefix` to canonicalize untrusted
    /// input.
    pub prefix: String,
    /// Idle-shutdown window. When set, the server triggers a
    /// graceful shutdown if no HTTP request or WebSocket frame is
    /// observed inside the window. Intended for systemd
    /// socket-activated deployments where many idle instances
    /// stack on one host. `None` keeps the server resident
    /// indefinitely (today's default).
    pub idle_timeout: Option<Duration>,
    /// Open the launch URL in the user's default browser after the
    /// listener binds. Set by the CLI for the default `chan serve`
    /// flow; suppressed for tunnel mode (no local URL to open).
    pub open_browser: bool,
    /// Optional one-shot override for the search indexer's resource
    /// profile. When absent, the persisted server config decides.
    pub search_aggression: Option<SearchAggression>,
    /// Tell the SPA shell to grey out the Settings entry point so a
    /// non-owner viewer can't open the settings panel. Surfaced to
    /// the frontend as `<meta name="chan-settings-disabled">`, and
    /// mirrored on `AppState::settings_disabled` so the
    /// `tunnel_guard::settings_guard` middleware can refuse the
    /// matching write routes server-side. Set to true on
    /// `--tunnel-public` runs (anonymous viewers must not mutate
    /// owner config) and left false on OAuth-gated tunnel runs (the
    /// gateway has proven the viewer is the workspace owner). The
    /// local-serve path always leaves it false.
    pub settings_disabled: bool,
    /// Treat every inbound request as anonymous: the server is
    /// publicly tunneled (`--tunnel-public`), the gateway is not
    /// authenticating visitors, and the workspace owner cannot be
    /// distinguished from a hostile third party. Stricter than
    /// `settings_disabled`:
    ///
    ///   - read-only handlers that expose host-level data
    ///     (`GET /api/workspace`, `GET /api/config`, `GET /api/cloud-workspaces`)
    ///     redact paths before serializing.
    ///
    /// Hosted (OAuth-gated) tunnel runs leave this false: the gateway
    /// has already proven the viewer is the workspace owner, so host-level
    /// reads stay available.
    pub tunnel_public: bool,
}

/// Resolved at boot for the launch banner / browser handoff.
#[derive(Debug, Clone)]
pub struct ServeHandle {
    pub addr: SocketAddr,
    /// Canonical prefix (matches `ServeConfig::prefix`).
    pub prefix: String,
    pub token: Option<String>,
}

impl ServeHandle {
    pub fn launch_url(&self) -> String {
        let path = if self.prefix.is_empty() {
            "/".to_string()
        } else {
            format!("{}/index.html", self.prefix)
        };
        match &self.token {
            Some(t) => format!("http://{}{}?t={}", self.addr, path, t),
            None => format!("http://{}{}", self.addr, path),
        }
    }
}

/// Canonicalize a user-supplied URL path prefix.
///
/// Returns `Ok("")` for the empty / "no prefix" case, or
/// `Ok("/seg[/seg...]")` for a non-empty prefix with leading slash
/// and no trailing slash. Each segment must match `[A-Za-z0-9-]+`.
///
/// Strict on purpose: the whole point is that a reverse proxy in
/// front of `chan serve` can pin the location to a simple, unambiguous
/// path. Anything that needs URL encoding, `..` traversal, or
/// non-ASCII gets rejected up front.
pub fn sanitize_prefix(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    // Strip leading and trailing slashes; collapse internal `//` runs
    // implicitly via the segment split that drops empty pieces.
    let core = trimmed.trim_matches('/');
    if core.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::with_capacity(core.len() + 1);
    for segment in core.split('/') {
        if segment.is_empty() {
            // From a `//` run inside the prefix: collapse silently.
            continue;
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(format!(
                "invalid prefix segment {segment:?}: only [A-Za-z0-9-] allowed"
            ));
        }
        out.push('/');
        out.push_str(segment);
    }
    Ok(out)
}

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

/// True iff the tunnel dial endpoint points at the production
/// `workspace.chan.app` terminator. On that path chan-serve can predict
/// the public visitor URL (wildcard subdomain shape); anywhere else
/// the terminator (chan-desktop, dev gateway, third-party host)
/// owns the URL scheme so we can't fabricate one. The QR and
/// browser-open paths key on this so we never advertise a
/// hallucinated `tunnel.workspace.chan.app`-style URL for a dial that
/// went to a local loopback or an unrelated host.
fn is_production_tunnel_url(tunnel_url: &str) -> bool {
    url::Url::parse(tunnel_url)
        .map(|u| u.scheme() == "https" && u.host_str() == Some("workspace.chan.app"))
        .unwrap_or(false)
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
    /// Background idle-prune/shutdown task for long-lived terminal
    /// sessions. Held so dropping AppArtifacts aborts it if serve()
    /// exits without the shutdown channel firing.
    _terminal_pruner: tokio::task::JoinHandle<()>,
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
    /// Shutdown signal sender. Fed by SIGINT/SIGTERM and (optionally)
    /// the idle-timeout watcher. Receivers live on `AppState` and in
    /// `serve()` / `serve_via_tunnel()` for the runloop select.
    shutdown_tx: Arc<watch::Sender<bool>>,
}

/// Build the full axum app: state assembly, channels, watcher,
/// indexer, config loads, router. Shared by `serve()` (local TCP
/// listener) and `serve_via_tunnel()` (chan-tunnel-client transport)
/// so the two paths serve byte-identical request handling.
async fn build_app(
    library: Library,
    workspace: Arc<Workspace>,
    config: &ServeConfig,
) -> Result<AppArtifacts, Error> {
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
    // runtime resolver + the systacean-7 download flow instead.
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
    // phase-11 Slice C: the scoped pub/sub registry is created here so
    // the watcher bridge can route scoped `fs` frames into it; the same
    // Arc is stored on AppState for the /ws handler and survives a
    // storage reset (the rebuilt bridge re-references it).
    let scope_registry = Arc::new(bus::ScopeRegistry::new());
    let bridge = make_watch_bridge(&events_tx, &index_events_tx, &self_writes, &scope_registry);
    let watch_handle = workspace.watch(bridge)?;
    let workspace_root = workspace.root().to_path_buf();
    // Background indexer: subscribes to index_events_tx, runs the
    // initial build if the index is empty, debounces incremental
    // reindexes 1s per path. Lives for the server's lifetime.
    // Progress fan-out: every `Workspace::reindex_with` tick (per-file
    // index, graph rebuild, embed batch) lands on the same /ws
    // stream as watch + LLM frames, with `type: "progress"`. The
    // status bar in the web app subscribes to workspace the live
    // indexer pill.
    let progress_sink = make_progress_broadcast(&events_tx);
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

    let state_for_bridge: Arc<RwLock<Option<WorkspaceCell>>> =
        Arc::new(RwLock::new(Some(WorkspaceCell {
            workspace,
            watch_handle: Some(watch_handle),
            indexer,
        })));
    let agent_inbox = Arc::new(agent_inbox::AgentInbox::new(
        server_config.team_work.inbox_depth,
    ));
    let control_socket_path = control_socket::pick_socket_path();
    let control = control_socket::start(
        control_socket_path.clone(),
        state_for_bridge.clone(),
        events_tx.clone(),
        self_writes.clone(),
    );
    let (control_socket_path, control_socket) = match control {
        Ok(handle) => (Some(handle.socket_path().to_path_buf()), Some(handle)),
        Err(e) => {
            tracing::warn!(
                "control socket bind failed at {}: {e}",
                control_socket_path.display()
            );
            (None, None)
        }
    };

    // Try to bring up the MCP socket bridge before building
    // AppState, so the resolved socket path (or `None` on failure)
    // is part of the immutable state every handler observes.
    let socket_path = mcp_bridge::pick_socket_path();
    let terminal_sessions_with_mcp = Arc::new(TerminalRegistry::new(TerminalRegistryConfig {
        workspace_root: workspace_root.clone(),
        mcp_socket_path: Some(socket_path.clone()),
        control_socket_path: control_socket_path.clone(),
        terminal: server_config.terminal.clone(),
    }));
    let provider_workspace_cell = state_for_bridge.clone();
    let agent_inbox_provider = Arc::new(agent_inbox::ServerAgentInboxProvider::new(
        agent_inbox.clone(),
        terminal_sessions_with_mcp.clone(),
        move || {
            let cell = match provider_workspace_cell.read() {
                Ok(cell) => cell,
                Err(_) => {
                    tracing::warn!(
                        "agent inbox cannot snapshot workspace: workspace_cell poisoned"
                    );
                    return None;
                }
            };
            let Some(cell) = cell.as_ref() else {
                tracing::warn!("agent inbox cannot snapshot workspace: workspace_cell missing");
                return None;
            };
            Some(cell.workspace.clone())
        },
    ));
    let bridge_workspace_cell = state_for_bridge.clone();
    let bridge = mcp_bridge::start(
        socket_path.clone(),
        move || {
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
        },
        Some(agent_inbox_provider),
    );
    let (mcp_bridge, terminal_sessions) = match bridge {
        Ok(handle) => (Some(handle), terminal_sessions_with_mcp),
        Err(e) => {
            tracing::warn!("mcp bridge bind failed at {}: {e}", socket_path.display());
            (
                None,
                Arc::new(TerminalRegistry::new(TerminalRegistryConfig {
                    workspace_root: workspace_root.clone(),
                    mcp_socket_path: None,
                    control_socket_path: control_socket_path.clone(),
                    terminal: server_config.terminal.clone(),
                })),
            )
        }
    };
    let terminal_pruner = terminal_sessions.clone().spawn_pruner(shutdown_rx.clone());

    let state = Arc::new(AppState {
        library,
        workspace_root,
        workspace_cell: state_for_bridge.clone(),
        token: token.clone(),
        prefix: prefix.clone(),
        settings_disabled: config.settings_disabled,
        tunnel_public: config.tunnel_public,
        events_tx,
        index_events_tx,
        server_config: Mutex::new(server_config),
        editor_prefs: Mutex::new(editor_prefs),
        self_writes,
        last_activity: last_activity.clone(),
        terminal_sessions,
        agent_inbox,
        shutdown_rx,
        scope_registry,
    });
    // Nest under the prefix so `--prefix=/foo` makes every existing
    // route reachable at `/foo<route>` without changing any handler.
    // axum strips the prefix from the inner URI, so handlers continue
    // to see paths starting with `/api`, `/ws`, etc.
    let inner = router(state);
    let app = if config.prefix.is_empty() {
        inner
    } else {
        Router::new().nest(&config.prefix, inner)
    };

    Ok(AppArtifacts {
        app,
        token,
        last_activity,
        workspace_cell: state_for_bridge.clone(),
        _terminal_pruner: terminal_pruner,
        prefix,
        mcp_bridge,
        control_socket,
        shutdown_tx,
    })
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
    let listener = TcpListener::bind(config.addr).await?;
    let addr = listener.local_addr()?;
    let artifacts = build_app(library, workspace, &config).await?;
    let handle = ServeHandle {
        addr,
        prefix: config.prefix.clone(),
        token: artifacts.token.clone(),
    };
    let url = handle.launch_url();
    eprintln!("chan is ready:\n{url}");
    if should_open_browser(config.open_browser) {
        // Best-effort: on a headless host (no `xdg-open`/no display)
        // this returns an error; log a NOTE and keep serving.
        if let Err(e) = open::that_detached(&url) {
            eprintln!("NOTE: could not open browser ({e}); visit the URL above.");
        }
    }

    let app = artifacts.app;
    let last_activity = artifacts.last_activity;
    let workspace_cell = artifacts.workspace_cell.clone();
    // Keep the MCP bridge alive for the duration of `serve()`. Dropping
    // it at the end of this function unlinks the socket and aborts the
    // accept loop. Bound to a `let _` so clippy doesn't warn on
    // `let _ = artifacts.mcp_bridge` discarding the guard prematurely.
    let _mcp_bridge = artifacts.mcp_bridge;
    let _control_socket = artifacts.control_socket;

    // Single shutdown channel fed by both the idle-timeout watcher
    // (when --timeout is set) and SIGINT/SIGTERM. axum's
    // with_graceful_shutdown awaits a `changed()` on it, then stops
    // accepting new connections and drains in-flight ones. The
    // channel itself was created inside build_app so AppState (for
    // ws_pump and other long-lived handlers) shares the same signal.
    let signal_tx = artifacts.shutdown_tx;
    let mut signal_rx = signal_tx.subscribe();

    if let Some(timeout) = config.idle_timeout {
        spawn_idle_watcher(timeout, last_activity.clone(), signal_tx.clone());
    }
    spawn_signal_watcher(signal_tx.clone());

    // Side task: when the shutdown signal fires, cancel any in-flight
    // reindex. The flag is checked at per-file boundaries inside
    // `Workspace::reindex`, so the blocking task lands within at most one
    // file's worth of work and the runtime drop can return cleanly.
    let cancel_workspace_cell = workspace_cell.clone();
    let mut cancel_rx = signal_rx.clone();
    tokio::spawn(async move {
        let _ = cancel_rx.changed().await;
        if let Ok(cell) = cancel_workspace_cell.read() {
            if let Some(cell) = cell.as_ref() {
                cell.indexer.cancel();
            }
        }
    });

    let mut graceful_rx = signal_rx.clone();
    let server_future = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = graceful_rx.changed().await;
    });

    // Hard deadline after the shutdown signal: long-lived WebSocket
    // subscribers won't return on their own, so axum's graceful
    // drain alone could hang forever. We `select!` the server
    // future against "signal fired, then sleep GRACE seconds" and
    // force exit on grace expiry. tokio drops in-flight tasks when
    // we return.
    const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
    tokio::select! {
        res = server_future => {
            res.map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;
        }
        _ = async move {
            let _ = signal_rx.changed().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => {
            eprintln!("chan: graceful shutdown exceeded {SHUTDOWN_GRACE:?}; forcing exit");
        }
    }
    Ok(())
}

/// Build the same axum app as `serve()` but hand it to
/// `chan_tunnel_client::run` instead of binding a local TCP listener.
/// `chan serve --tunnel-token ...` calls this; the tunnel client
/// dials `tunnel_url`, runs Hello/HelloAck, and serves yamux
/// substreams with our router until the future is dropped.
///
/// Tunnel mode forces `no_token=true`: the gateway in front of
/// workspace.chan.app is the trust boundary, and the per-launch bearer
/// would otherwise have to be embedded in any URL the user shares.
///
/// `public` is forwarded to workspace-proxy via the Hello frame. When
/// false (the default), workspace-proxy bounces anonymous visitors to
/// id.chan.app; only the workspace owner's signed-in session can reach
/// the tunneled workspace. When true, workspace-proxy skips the OAuth gate
/// and anyone with the URL can read/write.
///
/// The Settings panel follows `public`: an OAuth-gated tunnel run
/// leaves it live (the gateway proves the viewer is the workspace owner,
/// even on a different device), while `--tunnel-public` greys it out
/// because anonymous visitors must not mutate owner config.
#[derive(Debug, Clone)]
pub struct TunnelServeConfig<'a> {
    pub tunnel_url: &'a str,
    pub token: String,
    pub workspace_name: String,
    pub public: bool,
    pub open_browser: bool,
    pub search_aggression: Option<SearchAggression>,
}

pub async fn serve_via_tunnel(
    library: Library,
    workspace: Arc<Workspace>,
    config: TunnelServeConfig<'_>,
) -> Result<(), Error> {
    let TunnelServeConfig {
        tunnel_url,
        token,
        workspace_name,
        public,
        open_browser,
        search_aggression,
    } = config;
    // The addr field is unused in tunnel mode (no local listener);
    // any parseable SocketAddr works. Prefix is empty: the public
    // gateway strips /{user}/{workspace} before forwarding, so handlers
    // see workspace-relative paths just like the local case.
    let server_config = ServeConfig {
        addr: SocketAddr::from(([127, 0, 0, 1], 0)),
        no_token: true,
        prefix: String::new(),
        idle_timeout: None,
        // Unused on this path: the tunnel browser-open fires from
        // the Connected event handler below, gated by the
        // `open_browser` parameter on serve_via_tunnel. The local
        // serve() open path is never reached in tunnel mode.
        open_browser: false,
        search_aggression,
        // Settings track `public`: OAuth-gated runs leave the panel
        // live (the gateway has proven the viewer is the workspace
        // owner), `--tunnel-public` greys it out so anonymous
        // visitors can't mutate owner config.
        settings_disabled: public,
        // Forward the public-tunnel flag verbatim. Handlers consume
        // this for restrictions that only apply when the gateway is
        // not authenticating the viewer (terminal gate, host-path
        // redactions).
        tunnel_public: public,
    };
    let artifacts = build_app(library, workspace, &server_config).await?;
    let prefix_handle = artifacts.prefix.clone();
    // Keep the MCP bridge alive for the tunnel session; bound here
    // so the socket file is unlinked when serve_via_tunnel returns.
    let _mcp_bridge = artifacts.mcp_bridge;
    let _control_socket = artifacts.control_socket;
    let workspace_cell = artifacts.workspace_cell.clone();

    // Same shutdown wiring as `serve()`: signal_watcher workspaces a
    // tokio::watch channel, and a side task cancels any in-flight
    // reindex when shutdown fires so the runtime doesn't have to
    // wait for the rebuild to finish naturally. Channel was created
    // inside build_app so AppState shares the receiver.
    let signal_tx = artifacts.shutdown_tx;
    let mut signal_rx = signal_tx.subscribe();
    spawn_signal_watcher(signal_tx.clone());

    let cancel_workspace_cell = workspace_cell.clone();
    let mut cancel_rx = signal_rx.clone();
    tokio::spawn(async move {
        let _ = cancel_rx.changed().await;
        if let Ok(cell) = cancel_workspace_cell.read() {
            if let Some(cell) = cell.as_ref() {
                cell.indexer.cancel();
            }
        }
    });

    // Lifecycle events from chan-tunnel-client: drained on a side
    // task so we can print a human-readable "your workspace is at ..."
    // line on first connect and a reconnect notice on disconnect.
    // The channel is bounded; chan-tunnel-client uses try_send so a
    // slow drainer drops events instead of stalling the run loop.
    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(8);
    // Capture for the spawned task: the hostname / scheme of the
    // tunnel dial endpoint decides whether we know the public URL
    // shape on the visitor side. The production `workspace.chan.app`
    // gateway uses wildcard subdomains; any other terminator
    // (embedded chan-tunnel-server, local dev, third-party host)
    // owns its own URL scheme and chan-serve has no way to predict
    // the visitor URL from this side of the dial.
    let production_public = is_production_tunnel_url(tunnel_url);
    tokio::spawn(async move {
        // First-connect-only flag: print the QR + open the browser
        // once. Reconnect storms must not re-trigger either side
        // effect (would spam the screen and re-open tabs).
        let mut greeted = false;
        while let Some(ev) = events_rx.recv().await {
            match ev {
                chan_tunnel_client::TunnelEvent::Connected(reg) => {
                    // Update the SPA-facing prefix so /index.html gets a
                    // <meta name="chan-prefix" content="/{workspace}"> tag and
                    // the frontend prepends the public path to its API and
                    // WebSocket URLs. The router itself is mounted at
                    // root: the public gateway strips the prefix before
                    // forwarding into the tunnel substream.
                    match prefix_handle.write() {
                        Ok(mut prefix) => *prefix = reg.prefix.clone(),
                        Err(_) => {
                            tracing::warn!("prefix lock poisoned; tunnel prefix update skipped");
                            continue;
                        }
                    }
                    if production_public {
                        // Wildcard-subdomain shape on workspace.chan.app:
                        // `{user}.workspace.chan.app/{workspace}/`. User is in
                        // the host; reg.prefix is `/{workspace}`. Trailing
                        // slash matches the canonical form so the chan
                        // SPA's vite `base: "./"` resolves asset URLs
                        // relative to the workspace.
                        let public_url = format!(
                            "https://{user}.workspace.chan.app{prefix}/",
                            user = reg.user,
                            prefix = reg.prefix,
                        );
                        eprintln!("chan tunnel connected: {public_url}");
                        if !greeted {
                            greeted = true;
                            print_qr_if_tty(&public_url);
                            if should_open_browser(open_browser) {
                                if let Err(e) = open::that_detached(&public_url) {
                                    eprintln!(
                                        "NOTE: could not open browser ({e}); visit the URL above."
                                    );
                                }
                            }
                        }
                    } else {
                        // Non-production terminator: we know `reg.user`
                        // and `reg.workspace` from HelloAck but the visitor
                        // URL belongs to whoever is hosting the tunnel
                        // server (e.g. chan-desktop maps each label to a
                        // per-tenant loopback port the desktop chose).
                        // Print identity only and skip the QR / browser
                        // open; those would point at a wrong URL.
                        eprintln!(
                            "chan tunnel connected as {user}/{workspace}",
                            user = reg.user,
                            workspace = reg.workspace,
                        );
                        greeted = true;
                    }
                }
                chan_tunnel_client::TunnelEvent::Disconnected { retry_in } => {
                    eprintln!("chan tunnel disconnected; reconnecting in {retry_in:?}");
                }
                chan_tunnel_client::TunnelEvent::DialFailed { error, retry_in } => {
                    eprintln!("chan tunnel dial failed: {error} (retry in {retry_in:?})");
                }
            }
        }
    });

    let cfg = chan_tunnel_client::ClientConfig {
        tunnel_url: tunnel_url
            .parse()
            .map_err(|e: url::ParseError| Error::Config(format!("invalid tunnel URL: {e}")))?,
        token,
        workspace: workspace_name,
        client_version: format!("chan/{}", env!("CARGO_PKG_VERSION")),
        public,
        initial_backoff: Duration::from_millis(500),
        max_backoff: Duration::from_secs(30),
        // chan-tunnel-client 0.5.1 added a per-dial wall-clock cap.
        // 30s matches the upstream default and covers the trans-
        // pacific case; black-holed routes fail fast instead of
        // hanging on the OS TCP timeout.
        dial_timeout: Duration::from_secs(30),
        // chan-tunnel-client 0.6 added an optional outbound proxy.
        // We don't surface it through chan's CLI yet; default to
        // direct dial.
        proxy: None,
        // Keep the substream concurrency cap aligned with
        // chan-tunnel-client's default.
        max_concurrent_substreams: chan_tunnel_client::ClientConfig::default()
            .max_concurrent_substreams,
        events: Some(events_tx),
    };
    // Race the tunnel run loop against the shutdown signal. The
    // tunnel client doesn't observe SIGINT/SIGTERM itself; without
    // this select! a Ctrl-C would only terminate the process via the
    // outer runtime drop. With it, the future cancellation drops the
    // tunnel client cleanly: yamux substreams close (which terminates
    // all client HTTP and WS connections), MCP bridge drop unlinks
    // its socket, indexer cancel has already fired.
    tokio::select! {
        res = chan_tunnel_client::run(cfg, artifacts.app) => {
            res.map_err(|e| Error::Config(e.to_string()))?;
        }
        _ = signal_rx.changed() => {
            // Dropping the tunnel future via select! cancellation
            // closes the yamux session immediately. No drain window
            // needed: there's no axum-level connection pool here, so
            // unlike serve()'s graceful_shutdown there's nothing
            // outstanding to wait on.
        }
    }
    Ok(())
}

fn router(state: Arc<AppState>) -> Router {
    // ---- Settings-write gate ----------------------------------------
    //
    // Refused with 403 by `tunnel_guard::settings_guard` on any
    // tunnel run (hosted OR public). Reads of the same areas stay
    // open via the main router below; the SPA can still populate
    // values in view mode. The middleware runs as a route_layer on
    // this sub-router so it fires before the JSON / query extractors
    // and a malformed body cannot leak the request schema via 422.
    let settings_writes = Router::new()
        .route("/api/workspace", patch(api_patch_workspace))
        .route("/api/config", patch(api_patch_config))
        .route("/api/server/config", patch(api_patch_server_config))
        .route("/api/storage/reset", post(api_storage_reset))
        .route("/api/index/rebuild", post(api_index_rebuild));
    // systacean-7: per-workspace semantic-search write endpoints. Same
    // settings-gated lane as `/api/index/rebuild` since flipping
    // the workspace's `semantic_enabled` is a settings change and the
    // download path mutates the per-machine model cache.
    #[cfg(feature = "embeddings")]
    let settings_writes = settings_writes
        .route("/api/index/semantic/enable", post(api_semantic_enable))
        .route("/api/index/semantic/disable", post(api_semantic_disable))
        .route("/api/index/semantic/download", post(api_semantic_download))
        .route("/api/index/semantic/model", patch(api_semantic_model_patch));
    // systacean-39: reports feature toggle endpoints. Mirror the
    // semantic shape but NOT gated on `embeddings`; reports are
    // part of the BM25-only baseline. Settings-writes lane because
    // flipping the toggle is a settings change.
    let settings_writes = settings_writes
        .route("/api/index/reports/enable", post(api_reports_enable))
        .route("/api/index/reports/disable", post(api_reports_disable));
    // systacean-40: screensaver overlay state + PIN endpoints.
    // PATCH/state, POST/pin, DELETE/pin land in settings-writes.
    // POST/verify is a read-side action (checks the stored hash)
    // so it stays in the unrestricted lane below; non-owners
    // can still trigger the verify path to dismiss the overlay.
    let settings_writes = settings_writes
        .route("/api/screensaver/state", patch(api_screensaver_patch))
        .route("/api/screensaver/pin", post(api_screensaver_set_pin))
        .route("/api/screensaver/pin", delete(api_screensaver_clear_pin));
    // `fullstack-b-30` slice b: Source Code Pro download endpoint.
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
            post(api_upload_file).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        // `fullstack-a-66`: New Draft action. Creates
        // `Drafts/<next-untitled>/draft.md` + indexes via the
        // chan-workspace unified-path API (`systacean-25`/`-26`).
        // SPA Cmd+N chord routes here; response path opens via
        // the existing /api/files/Drafts/.../draft.md GET path.
        .route("/api/drafts/new", post(api_create_draft))
        .route("/api/drafts/inspect", post(api_inspect_draft))
        .route("/api/drafts/discard", post(api_discard_draft))
        .route("/api/drafts/promote", post(api_promote_draft))
        // phase-13-r2 `lane-a-A3`: path-based chan-team.toml
        // read/write for the Team Work dialog's New/Load flow.
        // Deliberately outside the workspace sandbox (user path,
        // default /tmp); see routes/team_config.rs module docs.
        .route("/api/team-config/read", post(api_team_config_read))
        .route("/api/team-config/write", post(api_team_config_write))
        .route(
            "/api/files/*path",
            get(api_read_file)
                .put(api_write_file)
                .delete(api_delete_file),
        )
        .route("/api/move", post(api_move))
        .route("/api/fs/transfer", post(api_fs_transfer))
        .route("/api/search/files", get(api_search_files))
        .route("/api/search/content", get(api_search_content))
        .route("/api/index/status", get(api_index_status))
        .route("/api/indexing/state", get(api_indexing_state))
        // First-boot workspace readiness for the locked OverlayShell
        // (contracts §2): poll the snapshot, submit a step decision.
        .route("/api/preflight", get(api_preflight))
        .route("/api/preflight/decision", post(api_preflight_decision))
        .route("/api/link-targets", get(api_link_targets))
        .route("/api/resolve-link", get(api_resolve_link))
        .route("/api/headings/*path", get(api_headings))
        .route("/api/links", get(api_links))
        .route("/api/graph", get(api_graph))
        .route("/api/graph/languages", get(api_language_graph))
        .route("/api/fs-graph", get(api_fs_graph))
        .route("/api/inspector", get(api_inspector))
        // systacean-35: prefix-matched mention completion. Editor
        // queries this to surface `@@<Name>` references across the
        // broader markdown corpus (not just contacts).
        .route("/api/mentions", get(api_get_mentions))
        .route("/api/backlinks/*path", get(api_backlinks))
        .route("/api/report/file", get(api_report_file))
        .route("/api/report/prefix", get(api_report_prefix))
        .route("/api/report/dir", get(api_report_dir))
        .route("/api/server/config", get(api_get_server_config))
        .route("/api/config", get(api_get_config))
        .route("/api/build-info", get(api_build_info))
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
        .route("/api/terminals", post(api_create_terminal))
        .route("/api/terminals/:session", delete(api_delete_terminal))
        .route(
            "/api/terminals/:session/restart",
            post(api_restart_terminal),
        )
        .route("/ws", get(ws_upgrade))
        // `fullstack-b-12`: bundled font assets (Source Code Pro
        // Regular + OFL.txt) served from chan-server's rust-embed.
        // The SPA's `@font-face` declaration points at this path; a
        // future expansion (italic / bold weights, additional faces)
        // drops more entries into `crates/chan-server/resources/fonts/`
        // and the same `:name` segment serves them.
        .route("/static/fonts/:name", get(serve_font));
    // systacean-7: read-only semantic-search state. Gated on
    // `embeddings` because the SemanticState payload + the
    // `chan-workspace` resolver behind it only exist when the candle
    // stack compiles in. Write routes (`enable` / `disable` /
    // `download`) sit in `settings_writes` and merge below.
    #[cfg(feature = "embeddings")]
    let api = api
        .route("/api/index/semantic/state", get(api_semantic_state))
        .route("/api/index/semantic/models", get(api_semantic_models));
    // systacean-39: reports state is read-only + not settings-
    // gated (read-only views can land in any lane).
    let api = api.route("/api/index/reports/state", get(api_reports_state));
    // systacean-40: screensaver state + verify are read-side.
    // /verify is unrestricted so non-owners can still unlock the
    // overlay on shared-machine scenarios.
    let api = api
        .route("/api/screensaver/state", get(api_screensaver_state))
        .route("/api/screensaver/verify", post(api_screensaver_verify));
    let api = api.merge(settings_writes);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_prefix_empty_inputs() {
        assert_eq!(sanitize_prefix("").unwrap(), "");
        assert_eq!(sanitize_prefix("   ").unwrap(), "");
        assert_eq!(sanitize_prefix("/").unwrap(), "");
        assert_eq!(sanitize_prefix("///").unwrap(), "");
    }

    #[test]
    fn sanitize_prefix_canonicalizes() {
        assert_eq!(sanitize_prefix("foo").unwrap(), "/foo");
        assert_eq!(sanitize_prefix("/foo").unwrap(), "/foo");
        assert_eq!(sanitize_prefix("/foo/").unwrap(), "/foo");
        assert_eq!(sanitize_prefix("foo/").unwrap(), "/foo");
        assert_eq!(sanitize_prefix("/foo/bar").unwrap(), "/foo/bar");
        assert_eq!(sanitize_prefix("//foo//bar//").unwrap(), "/foo/bar");
        assert_eq!(sanitize_prefix("  /foo/  ").unwrap(), "/foo");
    }

    #[test]
    fn sanitize_prefix_allowed_chars() {
        assert_eq!(sanitize_prefix("/abc-123").unwrap(), "/abc-123");
        assert_eq!(sanitize_prefix("/A-B/c-D").unwrap(), "/A-B/c-D");
    }

    #[test]
    fn sanitize_prefix_rejects_bad_segments() {
        for bad in [
            "/foo/..",
            "/foo bar",
            "/foo?",
            "/foo#",
            "/a%20b",
            "/foo.bar",
            "/foo_bar",
            "/foo~bar",
            "/cafe\u{0301}",
            "/foo\\bar",
        ] {
            assert!(sanitize_prefix(bad).is_err(), "expected error for {bad:?}");
        }
    }

    #[test]
    fn launch_url_uses_index_for_prefixed_serves() {
        let handle = ServeHandle {
            addr: "127.0.0.1:1234".parse().unwrap(),
            prefix: "/workspace-abcd".to_string(),
            token: Some("token".to_string()),
        };
        assert_eq!(
            handle.launch_url(),
            "http://127.0.0.1:1234/workspace-abcd/index.html?t=token"
        );
    }

    #[test]
    fn launch_url_preserves_root_for_unprefixed_serves() {
        let handle = ServeHandle {
            addr: "127.0.0.1:1234".parse().unwrap(),
            prefix: String::new(),
            token: Some("token".to_string()),
        };
        assert_eq!(handle.launch_url(), "http://127.0.0.1:1234/?t=token");
    }
}
