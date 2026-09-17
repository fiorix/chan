//! Local-workspace runtime and workspace-window helpers.
//!
//! chan-desktop opens local workspaces through the embedded chan-server
//! `WorkspaceHost`. Each running workspace is tracked in `AppState.serves`
//! with its route prefix and token-bearing URL. chan-desktop links
//! `chan-workspace` and `chan-server` directly; there is no `chan`
//! binary at runtime. Registry mutations and feature toggles run
//! in-process against the embedded host's shared `Library`, and
//! local serving never spawns `chan serve`.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use chan_server::{WindowKind, WindowRecord, WorkspaceLifecycleOutcome};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};

use crate::config::{self, WindowGeometry};
use crate::AppState;

/// Tauri event emitted when any local runtime starts or stops. The
/// frontend reacts by re-fetching the workspace list.
pub const SERVES_CHANGED: &str = "serves-changed";

/// Window-title kind glyphs. A workspace window's title leads with one of
/// these so the OS title bar + window switcher encode the kind at a glance,
/// then the locator (path / URL). Emoji render as color glyphs in the macOS
/// title bar; named constants so swapping the glyph set is a one-line change
/// each. Monochrome line-art: the house mirrors the launcher's lucide House; the
/// remote is an up-right arrow that stays legible in title-bar fonts.
const ICON_LOCAL_HOME: &str = "\u{2302}"; // ⌂ house: any local-disk workspace
const ICON_REMOTE: &str = "\u{2197}\u{FE0E}"; // ↗ up-right arrow: a remote devserver

/// Live state for one running serve. Held in `AppState.serves`
/// keyed by canonical workspace path.
pub struct ServeHandle {
    pub url: Option<String>,
}

impl ServeHandle {
    fn embedded(url: String) -> Self {
        Self { url: Some(url) }
    }
}

/// Whether mounting a workspace should also mint a native window.
///
/// User-requested opens always mint one window, including when persisted
/// windows already exist. Boot restore mounts the workspace without minting so
/// an empty persisted set stays empty.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkspaceOpenMode {
    OpenWindow,
    RestoreOnly,
}

impl WorkspaceOpenMode {
    fn should_mint(self) -> bool {
        matches!(self, Self::OpenWindow)
    }
}

/// Open a local workspace through the embedded chan-server host.
///
/// [`WorkspaceOpenMode::OpenWindow`] mints one window after mounting, even when
/// persisted windows already exist. [`WorkspaceOpenMode::RestoreOnly`] restores
/// only the persisted set, so a workspace whose windows were all closed stays
/// windowless on boot. A buried or hidden window keeps its record, so the
/// watcher restores it while honoring `should_show`'s `!hidden`.
pub async fn start<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: Arc<AppState>,
    key: String,
    open_mode: WorkspaceOpenMode,
) -> Result<(), String> {
    if state.serves.lock().unwrap().contains_key(&key) {
        return Ok(());
    }
    let Some(embedded) = state.embedded.get() else {
        return Err("embedded local server is unavailable".to_string());
    };
    let url = embedded.open_workspace(&key).await?;
    {
        let mut serves = state.serves.lock().unwrap();
        if serves.contains_key(&key) {
            // A concurrent `start` for this key won the race across the mount
            // await (the pre-check above guards only the pre-await instant).
            // Both callers are holding the SAME tenant: the prefix is derived
            // from the key alone and `open_or_get_registered_workspace` returns
            // the EXISTING mount for an already-mounted root, so the loser
            // mounted nothing of its own and has nothing to clean up. Closing
            // the shared prefix here would tear down the tenant the winner just
            // published and minted a window for, and a forced close skips the
            // live-terminal refusal, so it would kill the user's running
            // terminals too. Report the workspace as running, which it is.
            return Ok(());
        }
        serves.insert(key.clone(), ServeHandle::embedded(url.clone()));
    }
    let _ = app.emit(SERVES_CHANGED, ());
    // A user-requested open always mints after the mount. Persisted rows became
    // live when the mount fired the library change signal, and the registry
    // orders the fresh row last for this workspace. Boot restore skips this
    // block so an empty persisted set stays empty. The registry remains the
    // sole window-creation authority; there is no imperative window build.
    if open_mode.should_mint() {
        if let Err(e) = embedded.mint_window(WindowKind::Workspace, Some(key.clone())) {
            let removed = { state.serves.lock().unwrap().remove(&key) };
            if let Some(handle) = removed {
                drop(handle);
                let _ = stop_handle(None, &state, &key, true).await;
            }
            let _ = app.emit(SERVES_CHANGED, ());
            return Err(e);
        }
    }
    Ok(())
}

/// Drain every embedded tenant on normal process shutdown while preserving the
/// workspace overlay. The host starts all tenant shutdowns together, so shared
/// terminal and control-terminal tenants are included without multiplying the
/// grace period by the tenant count.
pub async fn stop_all(state: &AppState) {
    let count = {
        let mut serves = state.serves.lock().unwrap();
        let count = serves.len();
        serves.clear();
        count
    };
    tracing::info!(
        "shutdown: draining {count} workspace serves and all embedded tenants (overlay preserved)"
    );
    if let Some(embedded) = state.embedded.get() {
        if let Err(error) = embedded.shutdown_all().await {
            tracing::warn!(%error, "embedded tenant shutdown failed");
        }
    }
}

async fn stop_handle(
    app: Option<&AppHandle>,
    state: &AppState,
    key: &str,
    force: bool,
) -> Result<WorkspaceLifecycleOutcome, String> {
    let mut outcome = WorkspaceLifecycleOutcome::NotFound;
    if let Some(embedded) = state.embedded.get() {
        outcome = embedded.close_workspace_root(Path::new(key), force).await?;
    }
    if let Some(app) = app {
        if matches!(
            outcome,
            WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound
        ) {
            // No imperative window teardown: unmounting fired the library change
            // signal, so the watcher reconciles the now-tenant-less windows closed
            // (their token emptied → not shown) while KEEPING the persisted records,
            // so turning the workspace back on reopens them at the same window_id.
            let _ = app.emit(SERVES_CHANGED, ());
        }
    }
    Ok(outcome)
}

/// Stable Tauri window-label prefix for a local workspace. Used to
/// recognise every window that belongs to the workspace when the user
/// has opened more than one (close-all on serve exit, capability
/// matching). Tauri labels must match `[a-zA-Z0-9_-]+`, and workspace
/// keys are filesystem paths, so we hash the key.
pub fn workspace_window_prefix(key: &str) -> String {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    format!("workspace-{:016x}", h.finish())
}

/// Window title for a local-workspace webview: the house glyph then the
/// workspace path. Every local-disk workspace uses the house glyph regardless
/// of where on disk it lives. The path is the locator (the disambiguating
/// signal in the OS window switcher); the glyph prefix makes the kind read at
/// a glance.
fn workspace_title(key: &str) -> String {
    format!("{ICON_LOCAL_HOME} {key}")
}

/// Title for a devserver (remote) webview, per spec `icon devserver / repo`:
/// the remote glyph, the devserver's display name, then the workspace's repo
/// (the path basename). `build_workspace_window_with_completion` appends
/// ` Window {N}`. A terminal carries no workspace, so it reads
/// `icon devserver Terminal`. The
/// full remote path is NOT used (it would read as a meaningless local path --
/// `workspace_title`'s local house glyph is wrong for a remote box).
fn devserver_window_title(devserver_name: &str, record: &WindowRecord) -> String {
    match record.kind {
        WindowKind::Terminal => format!("{ICON_REMOTE} {devserver_name} Terminal"),
        WindowKind::Workspace => {
            let repo = record
                .workspace_path
                .as_deref()
                .and_then(|p| Path::new(p).file_name())
                .and_then(|n| n.to_str());
            match repo {
                Some(repo) => format!("{ICON_REMOTE} {devserver_name} / {repo}"),
                None => format!("{ICON_REMOTE} {devserver_name}"),
            }
        }
    }
}

/// The base title of a watcher-opened window: the devserver form when the
/// window belongs to a connected devserver (`devserver_name`), else the local
/// form. Shared by the open path and the watcher's retitle so both start from
/// the same base.
pub(crate) fn watched_window_base_title(
    record: &WindowRecord,
    devserver_name: Option<&str>,
) -> String {
    match devserver_name {
        Some(name) => devserver_window_title(name, record),
        None => match record.kind {
            WindowKind::Terminal => "Terminal".to_string(),
            WindowKind::Workspace => record
                .workspace_path
                .as_deref()
                .map(workspace_title)
                .unwrap_or_else(|| "Workspace".to_string()),
        },
    }
}

/// The SPA boot mode for a watcher-opened window. Never `control`: a control
/// row is not `persisted`, so the reconcile's show test excludes it and the
/// watcher never opens one.
pub(crate) fn watched_window_kind(record: &WindowRecord) -> Option<&'static str> {
    match record.kind {
        WindowKind::Terminal => Some("terminal"),
        WindowKind::Workspace => None,
    }
}

/// The full OS titlebar string a watcher-opened window should currently carry.
/// The retitle path compares against this, so it must reproduce exactly what
/// [`build_workspace_window_with_completion`] composed at open time.
pub(crate) fn watched_window_title(record: &WindowRecord, devserver_name: Option<&str>) -> String {
    compose_window_title(
        &watched_window_base_title(record, devserver_name),
        watched_window_kind(record).unwrap_or("workspace"),
        u64::from(record.ordinal),
        &record.label,
    )
}

/// The OS titlebar string for a window: its base title, the display number as
/// ` Window {N}`, then the user's caption in brackets when there is one.
///
/// The one composer for both the build path and the watcher's retitle. They MUST
/// agree byte-for-byte: the retitle compares against the live `window.title()`
/// to decide whether to write, so a second, subtly different formatter would
/// make every reconcile rewrite the title.
///
/// A control terminal keeps its bare base (it is a singleton per devserver, so a
/// number would be noise) and carries no caption -- the label route refuses to
/// set one on a control row.
pub(crate) fn compose_window_title(
    base: &str,
    kind: &str,
    display_number: u64,
    caption: &str,
) -> String {
    if kind == "control" {
        return base.to_string();
    }
    let caption = caption.trim();
    if caption.is_empty() {
        format!("{base} Window {display_number}")
    } else {
        format!("{base} Window {display_number} [{caption}]")
    }
}

/// True when a Tauri label belongs to a watcher-opened SPA webview that accepts
/// the `chan:command` dispatch bridge.
pub fn is_workspace_webview_label(label: &str) -> bool {
    // Watcher-opened local windows carry the composite native label
    // `local::<window_id>`; they host the same embedded SPA.
    label.starts_with("local::")
        // Watcher-opened devserver windows carry `lib-<hex>::<window_id>` -- the
        // same SPA, served by the remote devserver.
        || label.starts_with("lib-")
}

/// Open (or rebuild-in-place at the same label) a native window for a
/// library-minted local window `record`, driven by the window watcher (the
/// SOLE caller). The Tauri label is the composite native key
/// `{library_id}::{window_id}`; the loaded SPA carries `?w=<window_id>` -- the
/// bare per-library session key, decoupled from the OS-window label. Local
/// tenants are always up, so the tenant URL loads directly (no connecting
/// screen). An off workspace carries an empty token and the SPA turns it on
/// before attaching.
pub(crate) fn open_watched_local_window(
    app: &AppHandle,
    addr: SocketAddr,
    record: &WindowRecord,
    completion: WindowBuildCompletion,
) -> Result<(), String> {
    let label = crate::window_watcher::native_label(record);
    let url = format!(
        "http://{addr}{}/index.html?t={}",
        record.prefix, record.token
    );
    let title = watched_window_base_title(record, None);
    let kind = watched_window_kind(record);
    build_workspace_window_with_completion(
        app,
        WindowSpec {
            label: &label,
            session_id: &record.window_id,
            library_id: &record.library_id,
            title: &title,
            ordinal: Some(record.ordinal),
            caption: &record.label,
            url: &url,
            connecting: None,
            kind,
        },
        completion,
    )
}

/// Open a watched REMOTE (devserver) window -- the watcher's analog of
/// [`open_watched_local_window`], but the SPA is served by the remote devserver
/// at `host:port`, so the navigate target is the assembled tenant URL and the
/// window routes through the connecting screen (the remote may be down). The
/// native label is the composite `{library_id}::{window_id}`; `?w=` is the bare
/// `window_id` (decoupled), carried as the SPA session id.
pub(crate) fn open_watched_remote_window(
    app: &AppHandle,
    url: &str,
    devserver_name: &str,
    record: &WindowRecord,
    completion: WindowBuildCompletion,
) -> Result<(), String> {
    let label = crate::window_watcher::native_label(record);
    let title = watched_window_base_title(record, Some(devserver_name));
    let kind = watched_window_kind(record);
    build_workspace_window_with_completion(
        app,
        WindowSpec {
            label: &label,
            session_id: &record.window_id,
            library_id: &record.library_id,
            title: &title,
            ordinal: Some(record.ordinal),
            caption: &record.label,
            url,
            connecting: Some(url),
            kind,
        },
        completion,
    )
}

/// Retarget a live watched REMOTE window in place after its devserver rotated
/// tenant tokens. This keeps the same native window and lets the existing
/// reconnecting/retry surface navigate to the fresh target instead of destroying
/// the webview and rebuilding it under the same label.
pub(crate) fn retarget_watched_remote_window(
    app: &AppHandle,
    url: &str,
    record: &WindowRecord,
) -> Result<bool, String> {
    let label = crate::window_watcher::native_label(record);
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    let kind = watched_window_kind(record);
    let target = workspace_window_target_url(
        app,
        &label,
        &record.window_id,
        &record.library_id,
        url,
        kind,
    )?;
    window
        .navigate(target)
        .map_err(|e| format!("retargeting {label}: {e}"))?;
    if let Err(e) = window.show() {
        tracing::warn!(label = %label, error = %e, "showing retargeted devserver window failed");
    }
    Ok(true)
}

/// Mint a standalone terminal window. Like every local window it is a library
/// registry row (`local::<id>`), so it persists and restores across quit/reopen;
/// the watcher opens it (in `?kind=terminal` mode) at the ONE shared `/terminal`
/// tenant, mounted on first use. All terminal windows share that tenant -- so a
/// terminal moved between windows keeps its live PTY -- and it lives for the
/// process lifetime (orphaned PTYs idle-prune). Returns the new window's
/// composite native label.
pub async fn spawn_local_terminal_window(state: Arc<AppState>) -> Result<String, String> {
    let Some(embedded) = state.embedded.get() else {
        return Err("embedded local server is unavailable".to_string());
    };
    // Ensure the shared terminal tenant is mounted (records its prefix so the
    // minted record resolves to it); cached after the first mount.
    embedded.open_terminal().await?;
    // Mint the window; the watcher opens it. The registry is the sole window
    // authority, so the terminal can never be double-opened and it persists.
    let record = embedded.mint_window(WindowKind::Terminal, None)?;
    Ok(crate::window_watcher::native_label(&record))
}

/// A spawned control terminal: its terminal tenant prefix, used to scrape the
/// token the connect script prints, to mint the control window's chan-library
/// registry row, and to reap the tenant on disconnect. The window is
/// addressed by its deterministic `control_terminal_label`, so the struct doesn't
/// carry the label.
pub struct ControlTerminal {
    pub prefix: String,
}

/// Spawn a control terminal: a standalone terminal window whose PTY runs a
/// devserver's connect script. The script brings the devserver up, possibly
/// over an interactive ssh session whose prompts the user answers in the
/// window. The label is stable per devserver so the connect flow can tuck
/// the window away once connected and a later reopen finds the same window.
pub async fn spawn_control_terminal_window(
    app: AppHandle,
    state: Arc<AppState>,
    devserver_id: &str,
    script: String,
    display_name: &str,
) -> Result<ControlTerminal, String> {
    let Some(embedded) = state.embedded.get() else {
        return Err("embedded local server is unavailable".to_string());
    };
    let label = control_terminal_label(devserver_id);
    let title = if display_name.trim().is_empty() {
        "Control Terminal".to_string()
    } else {
        format!("Control Terminal - {}", display_name.trim())
    };
    build_control_terminal(embedded, script, |url| async move {
        let (built_tx, built_rx) = tokio::sync::oneshot::channel();
        build_workspace_window_with_completion(
            &app,
            WindowSpec {
                label: &label,
                session_id: &label,
                // The control terminal runs on the local embedded library's shared
                // terminal tenant, so it belongs to the `local` library.
                library_id: "local",
                title: &title,
                ordinal: None,
                caption: "",
                url: &url,
                connecting: None,
                // `control` (not `terminal`) puts the SPA in the singleton
                // control sub-mode: terminal-only, but with the tab strip / pane
                // chrome hidden and Cmd+T / splits disabled so it never spawns a
                // second tab. It also tags the window kind in `cs window list`,
                // keeping it distinct from persisted standalone terminals.
                kind: Some("control"),
            },
            Box::new(move |result| {
                let _ = built_tx.send(result);
            }),
        )?;
        built_rx
            .await
            .map_err(|_| "control window build was cancelled".to_string())??;
        Ok(())
    })
    .await
}

/// Keep ownership of the tenant until its native window has been built.
async fn build_control_terminal<F, Fut>(
    embedded: &crate::embedded::EmbeddedServer,
    script: String,
    build: F,
) -> Result<ControlTerminal, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let (url, prefix) = embedded.open_terminal_with_command(script).await?;
    if let Err(error) = build(url).await {
        if let Err(cleanup_error) = embedded.close_terminal_tenant(&prefix).await {
            tracing::warn!(%prefix, %cleanup_error, "closing a failed control window's tenant failed");
        }
        return Err(error);
    }
    Ok(ControlTerminal { prefix })
}

/// Stable window label for a devserver's control terminal.
pub fn control_terminal_label(devserver_id: &str) -> String {
    format!("control-terminal-{devserver_id}")
}

/// `cs window open`: focus a live window or un-hide a buried one. Errors when
/// the id names nothing the desktop can act on.
/// Resolve the id an open/hide op carries to a native window label. The
/// launcher's window affordance sends a BARE library-minted `window_id`
/// (e.g. `w-1a2b`), but a watched window's native label is the composite
/// `{library_id}::{window_id}` ([`crate::window_watcher::native_label`]) -- so a
/// bare id never matches `get_webview_window` directly. `cs window` callers
/// pass the full composite label already, so an id that is itself a live label
/// or already contains `::` is
/// used verbatim. Otherwise match the native window whose label ends with
/// `::{id}` -- among the OPEN windows, the buried list, and the connected
/// devserver feed. A buried WATCHED window (local:: and the devserver
/// `lib-<hex>::` family) has no live webview -- the reconcile destroyed it on
/// bury -- so it can't be found among the open windows; its full composite label
/// lives in the buried list. A server-hidden devserver window from a previous
/// session may not be locally buried either; its composite label still lives in
/// the feed. The view-driven un-bury in [`open_window_by_label`] needs the real
/// `lib-<hex>::` label. Only a bare `w-` id matching none of these falls back to
/// the `local::` composite.
pub(crate) fn resolve_window_label(app: &AppHandle, id: &str) -> String {
    // A live window whose exact label IS `id` wins.
    if app.get_webview_window(id).is_some() {
        return id.to_string();
    }
    let mut candidates: Vec<String> = app.webview_windows().into_keys().collect();
    let state = app.state::<Arc<AppState>>();
    candidates.extend(state.buried_snapshot().into_iter().map(|(label, _)| label));
    candidates.extend(state.devserver_feed.window_labels());
    resolve_label_from(id, &candidates)
}

/// Pure resolution core (unit-testable without a live Tauri app): pick the
/// native label for `id` given the candidate native labels (the caller passes the
/// OPEN windows plus the buried list). A composite label (one containing `::`) is
/// used verbatim; a bare `window_id` matches the `{library_id}::{id}` candidate
/// (open or buried -- a buried watched window has no live webview but its composite
/// label is in the buried list). A full `control-terminal-` label is used
/// verbatim. A bare library-minted id (`w-<hex>`) matching no candidate resolves
/// to the `local::` composite as a last resort; any other unknown id stays
/// unchanged so the open path returns its ordinary "isn't open" error.
fn resolve_label_from(id: &str, candidates: &[String]) -> String {
    if id.contains("::") {
        return id.to_string();
    }
    let suffix = format!("::{id}");
    if let Some(label) = candidates.iter().find(|l| l.ends_with(&suffix)) {
        return label.clone();
    }
    // A control terminal has no `{library_id}::` prefix, so its full native
    // label is used verbatim.
    if id.starts_with("control-terminal-") {
        return id.to_string();
    }
    if id.starts_with("w-") {
        format!("local::{id}")
    } else {
        id.to_string()
    }
}

pub fn open_window_by_label(app: &AppHandle, label: &str) -> Result<(), String> {
    let label = resolve_window_label(app, label);
    let label = label.as_str();
    // A watched window -- LOCAL (`local::`) OR a DEVSERVER (`lib-<hex>::`) -- un-buries
    // through its watcher view: its bury DESTROYED the native window (the reconcile
    // closed it -- `local::` locally, `lib-` via the devserver view), so there
    // is NO webview to `show()`. `unbury_window` flips the right view and the
    // reconcile reopens it at its `window_id`. This must run even when there is no
    // live webview, so it precedes the `get_webview_window` check below. The
    // dot-show of a buried devserver STANDALONE terminal is `lib-<hex>::…` with a
    // destroyed webview -- without the `lib-` arm it missed this AND the
    // `get_webview_window` check and resolved as a local label, reopening nothing.
    // The Window menu worked because it calls `unbury_window` directly.
    if label.starts_with("local::") || label.starts_with("lib-") {
        crate::unbury_window(app, label);
        return Ok(());
    }
    if app.get_webview_window(label).is_some() {
        // Live (visible or hidden-alive -- e.g. a devserver window): `unbury_window`
        // shows + focuses, and drops it from the buried list / Window menu if it
        // was hidden.
        crate::unbury_window(app, label);
        return Ok(());
    }
    Err(format!("window {label} isn't open"))
}

/// True when the webview is still showing the bundled connecting/retry
/// screen (`connecting.html`, the remote pre-navigation page). Such a
/// window has no per-window session, no shells, and nothing to restore,
/// so close affordances treat it as cancel-and-really-close instead of
/// burying. Guard the URL read because a dead webview's `url()` can panic on a
/// nil URL; any failure reads as "not the connecting screen".
pub fn window_on_connecting_screen(app: &AppHandle, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else {
        return false;
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| window.url())) {
        Ok(Ok(url)) => url.path().ends_with("connecting.html"),
        _ => false,
    }
}

/// Inputs for one SPA webview window build: identity (label/title),
/// where to point it, what to restore, and how to load.
struct WindowSpec<'a> {
    /// Unique Tauri window label: the OS-window identity, decoupled from the
    /// SPA session key (`session_id`). For most windows the two are equal; the
    /// window watcher's composite native label (`{library_id}::{window_id}`)
    /// differs from its bare `?w=` (`window_id`).
    label: &'a str,
    /// The `?w=` per-window SPA session key appended to the loaded URL -- what
    /// the SPA keys its session blob / `/ws` presence on. Equals `label`
    /// except for watcher-opened windows, which pass the bare `window_id`.
    session_id: &'a str,
    /// The owning chan-library's id, appended as `?lib=` so the SPA can scope
    /// cross-window tab drag-and-drop to the same library (`local` for the
    /// baked-in local disk library, `lib-<hex>` for a devserver).
    library_id: &'a str,
    /// Base title; the builder suffixes a reused " Window N" display number.
    title: &'a str,
    /// The library's persisted per-(kind, workspace) ordinal -- the same number
    /// `cs window list` prints as `#`. When `Some`, it is the displayed
    /// " Window N" suffix, so the titlebar and the registry agree. `None` for
    /// the control terminal, whose transient in-memory row has no persisted
    /// ordinal.
    ordinal: Option<u32>,
    /// The library record's optional user caption (`WindowRecord::label`),
    /// appended to the composed title in brackets so the OS titlebar and window
    /// switcher name the window the way the launcher does. Empty when the
    /// library record has no caption, including for control terminals.
    caption: &'a str,
    /// The workspace/terminal URL the webview ultimately shows.
    url: &'a str,
    /// Load strategy. `None` (local) loads `url` directly via
    /// `WebviewUrl::External`: that backend is up before the window
    /// opens. `Some(display_url)` (remote) instead loads the bundled
    /// `connecting.html` and hands it the display URL plus the assembled
    /// navigate target through an injected `window.__CHAN_CONNECTING__`;
    /// the page probes the remote via `probe_url` and navigates on
    /// success. A direct External load of a down remote paints a blank white
    /// webview, which is why the connecting screen owns the first load.
    connecting: Option<&'a str>,
    /// `Some("terminal")` makes the SPA boot without a workspace (no
    /// workspace fetch; the file browser and editor ride the same tenant
    /// wherever it serves a filesystem); `Some("control")` is the stricter
    /// singleton control sub-mode (hidden chrome, one PTY); `None` is full
    /// workspace mode. Also the kind `cs window list` shows.
    kind: Option<&'a str>,
}

pub(crate) type WindowBuildCompletion = Box<dyn FnOnce(Result<(), String>) + Send>;

/// The scheduling result does not describe native window creation. Completion
/// runs after the main-thread builder has either installed the window or failed.
fn build_workspace_window_with_completion(
    app: &AppHandle,
    spec: WindowSpec<'_>,
    completion: WindowBuildCompletion,
) -> Result<(), String> {
    let WindowSpec {
        label: window_label,
        session_id,
        library_id,
        title,
        ordinal,
        caption,
        url,
        connecting,
        kind,
    } = spec;
    if !library_id.is_empty() {
        let pane = app
            .state::<Arc<AppState>>()
            .embedded()
            .and_then(|embedded| embedded.pane_color(library_id));
        // Diagnostic: log whether `?pane=` is injected at build. A
        // `Some` here proves the desktop injects the colour at mint time (so a
        // new window blue-flashing is the web/ live-null revert, not a missing
        // injection); a `None` means the colour source (local store / devserver
        // colour cache) was empty at build (timing / consume).
        tracing::debug!(
            library_id,
            window = %window_label,
            pane_color = ?pane,
            "build_workspace_window_with_completion: ?pane= injection at mint time",
        );
    }
    let parsed = workspace_window_target_url(app, window_label, session_id, library_id, url, kind)?;
    // The connecting page receives its inputs before any page script runs
    // (same mechanism as KEY_BRIDGE_JS). `target` is the fully-assembled
    // navigate URL (remote + ?w=<label>) so the SPA's per-window state survives
    // the success navigation.
    // The window kind rides the init script the same way so KEY_BRIDGE_JS
    // can route kind-dependent chords -- a control terminal's New-terminal
    // chord spawns a standalone window instead of toggling a tab it does
    // not have -- without scraping the kind off a URL the SPA is free to
    // rewrite.
    let kind_global = format!(
        "window.__CHAN_WINDOW_KIND__ = {};\n",
        serde_json::json!(kind.unwrap_or("workspace"))
    );
    let (webview_url, init_script) = match connecting {
        Some(display_url) => {
            // Follow the launcher's local light/dark choice; null follows the
            // OS. The connecting screen is local desktop chrome.
            let theme = app
                .state::<Arc<AppState>>()
                .embedded()
                .and_then(|e| e.local_theme());
            let payload = serde_json::json!({
                "url": display_url,
                "target": parsed.as_str(),
                "theme": theme,
            });
            let script =
                format!("window.__CHAN_CONNECTING__ = {payload};\n{kind_global}{KEY_BRIDGE_JS}");
            (WebviewUrl::App("connecting.html".into()), script)
        }
        None => (
            WebviewUrl::External(parsed),
            format!("{kind_global}{KEY_BRIDGE_JS}"),
        ),
    };
    let app_owned = app.clone();
    let label_owned = window_label.to_string();
    let title_owned = title.to_string();
    // The SPA's `?w=` session id (= `WindowRecord.window_id` for a watcher
    // window), owned so the 'static close handler can query the active-transfer
    // guard by it -- it diverges from the native label for watcher windows.
    let session_owned = session_id.to_string();
    // The passed kind (`terminal` / `control`) for terminal windows, else
    // "workspace" -- the kind `cs window list` shows.
    // Captured owned so the 'static main-thread closure can hold it.
    let kind_owned = kind.unwrap_or("workspace").to_string();
    // The library ordinal (Copy) to display as " Window N", or None for the
    // control terminal, whose transient row has no persisted ordinal.
    let ordinal_owned = ordinal;
    let caption_owned = caption.to_string();
    let res = app.run_on_main_thread(move || {
        // Defensive: window labels are unique-per-instance now, so
        // a collision shouldn't happen. If it ever does (e.g. some
        // future code reusing a stable label), destroy the stale
        // window so `build` doesn't panic.
        if let Some(old) = app_owned.get_webview_window(&label_owned) {
            let _ = old.destroy();
        }
        // Suffix a reused, lowest-free display number so the OS Window
        // menu disambiguates windows that share a base title (two
        // windows on one workspace, several standalone terminals). The
        // number is freed on close (Ok branch handler / Err branch
        // below) so the next same-base window reuses it.
        let state = app_owned.state::<Arc<AppState>>();
        let window_number = state.assign_window_number(&label_owned, &title_owned);
        // Prefer the library's persisted ordinal (the `#` in `cs window list`)
        // so the titlebar number and the registry agree. The control terminal's
        // transient row has no persisted ordinal, so it falls back to the local
        // counter; `compose_window_title` omits that number, and the counter only
        // keeps reservation and release-on-close bookkeeping balanced.
        let display_number = ordinal_owned.map(u64::from).unwrap_or(window_number);
        // A `cs window title` override (kept across the bury/reopen cycle)
        // wins over the auto "{base} Window {N} [caption]" scheme; otherwise use
        // the default. The resolved title is registered below once the window
        // builds, so `cs window list` shows what the title bar shows.
        let display_title = state
            .window_title_override(&label_owned)
            .unwrap_or_else(|| {
                compose_window_title(&title_owned, &kind_owned, display_number, &caption_owned)
            });
        // Resolve the desktop-local OS geometry to restore for this window
        // (keyed by the native label, matched against the live monitor
        // signature). When we will reposition / resize, the window builds HIDDEN
        // and the physical geometry is applied post-build before it shows
        // (`apply_geometry_plan` in the Ok arm) -- flash-free, and physical
        // desktop coordinates sidestep the builder's logical-pixel cross-DPI
        // ambiguity. A `Default` plan keeps the visible 1200x800 build below.
        let geometry_plan = resolve_geometry_plan(&app_owned, &label_owned);
        let builder = WebviewWindowBuilder::new(&app_owned, &label_owned, webview_url)
            .title(display_title.clone())
            .inner_size(1200.0, 800.0)
            .min_inner_size(640.0, 400.0)
            .resizable(true)
            .initialization_script(init_script.as_str())
            // The explicit `zoom_in` / `zoom_out` / `zoom_reset`
            // IPC commands fired from KEY_BRIDGE_JS
            // are the primary path; this Tauri-level polyfill stays
            // on as a mousewheel + pinch fallback (the chord
            // overlap is harmless because KEY_BRIDGE_JS's capture-
            // phase listener calls preventDefault before the
            // polyfill's bubble-phase listener sees the keydown).
            // Requires `core:webview:allow-set-webview-zoom` on SPA windows per
            // capabilities/workspace.json.
            .zoom_hotkeys_enabled(true)
            // Hand HTML5 drag-and-drop to the page -- this must stay
            // disabled. With wry's native handler enabled, WebKit
            // never sees ANY drag on macOS (wry forwards to the OS
            // default only when the handler returns false, and
            // tauri-runtime-wry's handler returns true
            // unconditionally), which kills the editor/file-browser
            // drop zones AND in-page pane-to-pane tab moves. The
            // SPA's window-level drop guard owns the no-takeover
            // guarantee for stray OS file drops, and the terminal
            // path-print reads the drag pasteboard via
            // `read_dropped_paths` (dropped_paths.rs) instead of
            // native drag events.
            .disable_drag_drop_handler();
        // Build hidden when restored geometry will be applied, so the window
        // never flashes at the default size/position before it is repositioned.
        let builder = if geometry_plan.builds_hidden() {
            builder.visible(false)
        } else {
            builder
        };
        let result = match builder.build() {
            Ok(window) => {
                // Apply the restored OS geometry (physical px) and reveal the
                // window at its final size/position before anything else.
                apply_geometry_plan(&window, &label_owned, geometry_plan);
                // The window set changed, so the launcher menubar's
                // dynamic Window-submenu tail (open/hidden/remote
                // sections) is due a rebuild -- off-mac the launcher's
                // bar is the only menubar.
                #[cfg(not(target_os = "macos"))]
                crate::rebuild_window_menu(&app_owned);
                // Register the OS title + kind so `cs window list` shows
                // the same title the title bar does. The `Destroyed` arm
                // below drops the entry. No-op without an embedded server
                // (there always is one in the desktop).
                if let Some(embedded) = state.embedded.get() {
                    embedded.window_titles().set(
                        &label_owned,
                        chan_server::WindowMeta {
                            title: display_title.clone(),
                            kind: Some(kind_owned.clone()),
                        },
                    );
                }
                let app_for_close = app_owned.clone();
                let label_for_close = label_owned.clone();
                let session_for_close = session_owned.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => on_close_requested(
                        &app_for_close,
                        &label_for_close,
                        &session_for_close,
                        api,
                    ),
                    WindowEvent::Destroyed => on_destroyed(&app_for_close, &label_for_close),
                    _ => {}
                });
                Ok(())
            }
            Err(e) => {
                // Build failed: hand the just-assigned number back so it
                // isn't leaked out of the live set.
                app_owned
                    .state::<Arc<AppState>>()
                    .release_window_number(&label_owned);
                tracing::warn!(label = %label_owned, error = %e, "opening workspace window failed");
                Err(format!("opening workspace window {label_owned}: {e}"))
            }
        };
        completion(result);
    });
    res.map_err(|e| format!("scheduling workspace window for {window_label}: {e}"))
}

/// The OS close (red) button on a live SPA
/// window PROMPTS before acting: hold the close and eval an
/// `app.window.confirmClose` into the still-alive webview,
/// where the SPA shows a Hide / Close / Cancel overlay and
/// calls back (`hide_window_from_close_confirm` for Hide,
/// `request_close_window` for Close). No bury happens here
/// until the SPA decides. A few cases REAL-close with no
/// prompt when there is no live SPA to ask, such as a control terminal
/// still connecting or a window still on the pre-SPA connecting screen.
/// Programmatic closes (the SPA's empty-window cascade,
/// workspace-off teardown) call `destroy()`
/// and never reach this handler.
fn on_close_requested(
    app: &AppHandle,
    label: &str,
    session_id: &str,
    api: &tauri::CloseRequestApi,
) {
    let state = app.state::<Arc<AppState>>();
    // A launcher Hide action (or `cs window hide`) routes
    // through this same close path but is an explicit hide
    // gesture, not a red-dot: consume its one-shot flag here
    // and, once the transfer guards below clear, bury directly,
    // skipping the prompt. A genuine red-dot finds no flag and
    // asks. Read (not act) first so the transfer guards below
    // still run for a silent hide -- a hide mid-transfer must
    // not tear the transfer down without the prompt.
    let silent_hide = state.take_silent_hide(label);
    // Active-transfer guard (BEFORE any bury/close path): a
    // window with an in-flight upload/download must never close
    // silently and kill the transfer. A LOCAL window reports its
    // count through the embedded host (keyed on the `?w=` session
    // id), and its red-dot close DESTROYS it -- so the prompt
    // offers "Cancel transfer & close" vs "Keep open". A
    // connected-DEVSERVER window's transfer lives in the remote
    // SPA + server, surfaced via the `active_transfer` feed bit
    // (cached, keyed by composite label); its red-dot close only
    // HIDES it (the transfer keeps running in the live webview),
    // so that prompt is "Hide" vs "Keep open" -- the desktop never
    // cancels a remote transfer (the user does, from the SPA).
    if state
        .embedded
        .get()
        .map(|e| e.window_has_active_transfer(session_id))
        .unwrap_or(false)
    {
        api.prevent_close();
        prompt_transfer_close(app, &state, label);
        return;
    }
    if state.devserver_window_has_active_transfer(label) {
        api.prevent_close();
        prompt_devserver_transfer_close(app, &state, label);
        return;
    }
    // The explicit hide gesture buries directly, no prompt.
    // HOLD the close first: a connected control terminal buries via
    // `window.hide()` and needs the webview alive to reopen. An un-prevented close
    // proceeds to destroy it the moment this handler returns,
    // and the launcher eye's `/open` then 409s on a window
    // that no longer exists. The watcher families bury through
    // their view's reconcile, which closes the native window
    // itself, so holding the OS close is correct for them too.
    if silent_hide {
        api.prevent_close();
        bury_window_now(app, &state, label);
        return;
    }
    // A devserver window still on the connecting page has no
    // SPA command handler to answer a prompt. Route its OS
    // close through the same pending-delete path as the
    // page's close chords and Disconnect button.
    let on_connecting = window_on_connecting_screen(app, label);
    if on_connecting && label.starts_with("lib-") {
        api.prevent_close();
        if let Some(window) = app.get_webview_window(label) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::request_close_window(app, window).await {
                    tracing::warn!(error = %e, "closing connecting devserver window failed");
                }
            });
        }
        return;
    }
    // Decide whether there is a live workspace SPA to ASK. A
    // `local::` or connected `lib-` watcher window has one. A
    // `control-terminal-` still connecting and any window
    // still on the pre-SPA connecting screen have nothing to
    // keep or no SPA to ask, so they real-close (return without
    // prevent_close; the Destroyed branch cleans up).
    let ask = if label.starts_with("local::") || label.starts_with("lib-") {
        true
    } else if let Some(id) = label.strip_prefix("control-terminal-") {
        // A control terminal KEPT at "process exited" (its
        // devserver's reconnect is blocked on it): the red
        // button IS the explicit close that unblocks
        // reconnect. Run the same cleanup as Cmd+W / the SPA
        // Close (reaps the row + tenant, clears the block),
        // then let the real close proceed. Without this the
        // destroy leaves the block set with no terminal left
        // to close, and connect stays walled off.
        let control_terminal_dead = state.control_terminal_dead.lock().unwrap().contains(id);
        if control_terminal_dead {
            let app_for_terminal_close = app.clone();
            let state_for_terminal_close = Arc::clone(&state);
            let id_for_terminal_close = id.to_string();
            tauri::async_runtime::spawn(async move {
                crate::close_devserver_control_terminal(
                    &app_for_terminal_close,
                    &state_for_terminal_close,
                    &id_for_terminal_close,
                )
                .await;
            });
            false
        } else {
            // Closed (red button) WHILE STILL CONNECTING: must
            // NOT prompt or bury. A hidden control window
            // leaves the connect script running and strands
            // the launcher on "Connecting..." (the connect
            // flow's scrape loop keeps polling a window it can
            // still see). Destroy instead so the scrape loop
            // sees it gone, aborts, and surveys
            // (abandon/edit/retry). Once connected, the
            // overlay is fine: the PTY is the live connection
            // endpoint and stays warm, hidden, reopenable;
            // only an actual Close (^W / script exit) takes
            // the connection down via request_close_window.
            state.devservers.is_connected(id)
        }
    } else {
        !on_connecting
    };
    if !ask {
        // Real close; the Destroyed branch cleans up.
        return;
    }
    // A live workspace SPA: hold the OS close and hand the
    // decision to it. `w.eval` dispatches the host-agnostic
    // `chan:command` bridge (origin-agnostic, no ACL -- the same
    // channel the menu chords use); the SPA shows the Hide /
    // Close / Cancel overlay and calls back. Nothing is buried
    // until it does.
    api.prevent_close();
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.unminimize();
    if let Err(e) = window.show() {
        tracing::warn!(label = %label, error = %e, "raising close-confirm window failed");
    }
    if let Err(e) = window.set_focus() {
        tracing::warn!(label = %label, error = %e, "focusing close-confirm window failed");
    }
    let _ = window.eval(CONFIRM_CLOSE_DISPATCH_JS);
}

/// Single cleanup point for EVERY destroy path: the
/// real-close branch in `on_close_requested`, the SPA cascade destroy,
/// workspace teardown, and app exit. Frees the display number,
/// drops the zoom entry, and clears a stale buried
/// registry entry if the window died while hidden.
fn on_destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<Arc<AppState>>();
    state.release_window_number(label);
    // Drop the registered OS title so `cs window list`
    // stops showing one for a window that's gone. The
    // `cs window title` override is intentionally KEPT:
    // a best-effort reopen reuses the same label and
    // should restore the custom title.
    if let Some(embedded) = state.embedded.get() {
        embedded.window_titles().remove(label);
    }
    state.live_window_zooms.lock().unwrap().remove(label);
    let _cleanup = crate::download::drop_generated_downloads_for_window(label);
    // A watcher-buried window destroyed here was buried by its
    // reconcile (the user hid it); KEEP it in the reopen menu.
    // Check the LOCAL view for `local::` windows and the owning
    // DEVSERVER view for `lib-<hex>::...` windows; a hidden
    // devserver window is reopenable while connected. Only a
    // real teardown/discard (in NO watcher bury set -- e.g. the
    // view was already dropped on disconnect) drops it.
    let watcher_buried = if label.starts_with("lib-") {
        let library_id = label.split("::").next().unwrap_or(label);
        state
            .devserver_feed
            .devserver_id_for_library(library_id)
            .and_then(|ds_id| {
                state
                    .devserver_watcher_views
                    .lock()
                    .unwrap()
                    .get(&ds_id)
                    .map(|v| v.is_buried(label))
            })
            .unwrap_or(false)
    } else {
        state
            .local_watcher_view()
            .map(|v| v.is_buried(label))
            .unwrap_or(false)
    };
    if !watcher_buried && state.remove_buried(label) {
        crate::rebuild_window_menu(app);
    }
}

/// Compose the browser-facing URL for a freshly minted BROWSER window record:
/// the loopback base for its serving tenant plus the `?w=` / `?lib=` params the
/// SPA keys its per-window session on. The Window menu's "Open in Browser" hands
/// this to the system browser; the record carries browser affinity, so the
/// watcher never opens it as a native window.
pub(crate) fn browser_window_url(
    app: &AppHandle,
    addr: SocketAddr,
    record: &WindowRecord,
) -> Result<tauri::Url, String> {
    let label = crate::window_watcher::native_label(record);
    let url = format!(
        "http://{addr}{}/index.html?t={}",
        record.prefix, record.token
    );
    let kind = watched_window_kind(record);
    workspace_window_target_url(
        app,
        &label,
        &record.window_id,
        &record.library_id,
        &url,
        kind,
    )
}

fn append_renderer_signal(url: &mut tauri::Url, webgl_renderer: Option<bool>) {
    let Some(webgl_renderer) = webgl_renderer else {
        if !url.query_pairs().any(|(key, _)| key == "chan-renderer") {
            return;
        }
        let retained = url
            .query_pairs()
            .filter(|(key, _)| key != "chan-renderer")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(retained);
        return;
    };
    url.query_pairs_mut().append_pair(
        "chan-renderer",
        if webgl_renderer { "webgl" } else { "dom" },
    );
}

fn workspace_window_target_url(
    app: &AppHandle,
    window_label: &str,
    session_id: &str,
    library_id: &str,
    url: &str,
    kind: Option<&str>,
) -> Result<tauri::Url, String> {
    let Ok(mut parsed) = url.parse::<tauri::Url>() else {
        return Err(format!("bad chan URL for {window_label}: {url}"));
    };
    // The SPA keys its per-window session (panes/tabs, `/ws` presence) on
    // `?w=`; that is the `session_id`, NOT the Tauri label (they diverge only
    // for watcher-opened windows, where the label is the composite native key).
    parsed.query_pairs_mut().append_pair("w", session_id);
    // The desktop GUI bootstrap has already decided whether WebKit's
    // accelerated renderer is usable. Carry that one result to whichever
    // tenant serves the shell, including a remote devserver, so the SPA never
    // repeats driver detection or guesses from the operating system.
    append_renderer_signal(
        &mut parsed,
        crate::linux_gui_stack::webgl_renderer_available(),
    );
    // `kind=terminal` / `kind=control` are the SPA's only signal that this
    // window has no workspace (no workspace fetch); `control` additionally
    // selects the singleton control sub-mode. There is no third spelling: what
    // a standalone window can reach beyond its terminals -- the file browser
    // and the editor -- is the serving tenant's answer, declared in the shell
    // it serves. Workspace windows pass `None` and the SPA stays in full
    // workspace mode.
    if let Some(kind) = kind {
        parsed.query_pairs_mut().append_pair("kind", kind);
    }
    // `lib=<library_id>` next to `?w=`/`?kind=` tells the SPA which chan-library
    // this window belongs to, so cross-window tab d&d accepts a drop only from
    // the same library. Current builders pass an id, including `local` for
    // control terminals. Keep the empty case as a defensive no-stamp guard.
    if !library_id.is_empty() {
        parsed.query_pairs_mut().append_pair("lib", library_id);
    }
    // `pane=<hex>` is the window's library pane-highlight colour: the
    // host's `pane_color` resolves the two sources behind one call -- local
    // (the installed `LocalColorStore`) vs a devserver (`DevserverEntry.color`
    // matched by `library_id`). The editor reads it on boot to tint the
    // active-pane highlight; absent -> the default accent. v1 = mint-time (no
    // live recolour of already-open windows).
    if !library_id.is_empty() {
        let pane = app
            .state::<Arc<AppState>>()
            .embedded()
            .and_then(|embedded| embedded.pane_color(library_id));
        if let Some(color) = pane {
            parsed.query_pairs_mut().append_pair("pane", &color);
        }
    }
    // `seed=0` tells a standalone window not to open its default terminal: it
    // was minted BY a routed `cs open`, and its content is the frame parked for
    // its first `/ws` attach. Without it the window opens a terminal the user
    // never asked for and the routed tab lands beside it. Deliberately its own
    // parameter rather than a third `kind=`: this is not a different KIND of
    // window, it is the same standalone window told what it will be handed.
    // Absent for every other window, including `cs window new`, which keeps
    // seeding a terminal because that is what it means.
    if !session_id.is_empty() {
        let routed = app
            .state::<Arc<AppState>>()
            .embedded()
            .map(|embedded| embedded.is_routed_mint(session_id))
            .unwrap_or(false);
        if routed {
            parsed.query_pairs_mut().append_pair("seed", "0");
        }
    }
    Ok(parsed)
}

/// Host-to-webview dispatch that asks the live workspace SPA to confirm an OS
/// red-dot close. Rides the same origin-agnostic `chan:command` DOM bridge the
/// menu chords use (`App.svelte`'s `onChanCommand`), so it needs no ACL and
/// reaches loopback and tunnel-served webviews alike. The SPA answers with a
/// Hide / Close / Cancel overlay.
const CONFIRM_CLOSE_DISPATCH_JS: &str = "window.dispatchEvent(new CustomEvent('chan:command', { detail: { name: 'app.window.confirmClose' } }));";

/// Bury an SPA window -- hide it, keep its record warm and reopenable -- WITHOUT
/// asking or teaching. The label prefix selects the mechanism, mirroring the
/// window classes `build_workspace_window_with_completion` mints:
///   - `local::<id>`: bury through the local watcher view (its reconcile closes
///     the native window) plus the legacy buried list; persist hidden=true.
///   - `lib-<hex>::<id>`: bury through the owning devserver's watcher view,
///     override the feed `connected` bit to hidden and re-push; persist.
///   - a connected `control-terminal-`: hide the webview in place and persist
///     hidden=true for its registry row.
///
/// Two callers reach here: an explicit hide gesture (`cs window hide` / the
/// launcher Hide action) and the SPA's Hide choice from the close-confirm
/// overlay. Close is the sibling choice and rides the existing
/// `request_close_window` discard/destroy cascade.
pub(crate) fn bury_window_now(app: &AppHandle, state: &Arc<AppState>, label: &str) {
    // A watcher-managed local window (`local::<id>`): bury it through the
    // watcher view state (should_show false -> the reconcile closes the native
    // window; the record stays, reopenable from the Window menu). Mirror into
    // the legacy buried list so the menu lists it.
    if label.starts_with("local::") {
        // Capture OS geometry while the window is still alive -- the watcher
        // reconcile destroys the native window on bury.
        capture_window_geometry(app, label);
        let title = app
            .get_webview_window(label)
            .and_then(|w| w.title().ok())
            .unwrap_or_else(|| label.to_string());
        if let Some(view) = state.local_watcher_view() {
            view.bury(label);
        }
        state.bury_window(label, &title);
        // Persist hidden=true so the local window menu's Open/Hidden split and a
        // relaunch mirror it (routes local:: -> embedded).
        crate::persist_window_hidden(state, label, true);
        crate::rebuild_window_menu(app);
        return;
    }
    // A watcher-managed DEVSERVER window (`lib-<hex>::<id>`): bury it through
    // THAT devserver's watcher view (mirror local:: above) so its reconcile
    // CLOSES the webview -- dropping the `/ws`, so the remote pushes
    // `connected:false` and the launcher dot reflects hidden. The record stays,
    // reopenable from the Window menu / the dot.
    if label.starts_with("lib-") {
        // Capture OS geometry before the devserver reconcile closes the webview
        // on bury (a devserver window restoring its own size).
        capture_window_geometry(app, label);
        let title = app
            .get_webview_window(label)
            .and_then(|w| w.title().ok())
            .unwrap_or_else(|| label.to_string());
        let library_id = label.split("::").next().unwrap_or(label);
        if let Some(ds_id) = state.devserver_feed.devserver_id_for_library(library_id) {
            if let Some(view) = state.devserver_watcher_views.lock().unwrap().get(&ds_id) {
                view.bury(label);
            }
        }
        // Override the feed `connected` to hidden and re-push, so the launcher
        // dot flips even for a standalone terminal whose remote `/ws` never
        // reports disconnected.
        if state.devserver_feed.set_buried(label, true) {
            if let Some(embedded) = state.embedded() {
                embedded.signal_library_change();
            }
        }
        state.bury_window(label, &title);
        // Persist hidden=true to the owning devserver (routes lib-<hex>:: -> its
        // remote /visibility route) so the next connect mirrors it.
        crate::persist_window_hidden(state, label, true);
        crate::rebuild_window_menu(app);
        return;
    }
    // A connected control terminal is the only non-watcher SPA window. Hide it
    // in place so the live connection endpoint stays warm and reopenable.
    capture_window_geometry(app, label);
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let title = window.title().unwrap_or_else(|_| label.to_string());
    let _ = window.hide();
    state.bury_window(label, &title);
    // Persist hidden=true for the control terminal registry row.
    crate::persist_window_hidden(state, label, true);
    crate::rebuild_window_menu(app);
}

/// The active-transfer close guard's prompt (mirror of the live-shells confirm).
/// The caller has ALREADY `prevent_close`d, so:
/// - "Keep open" (the safe default / Escape) leaves the window untouched and
///   VISIBLE so the user watches the transfer's bubble finish -- a hold, NOT a
///   bury.
/// - "Cancel transfer & close" buries the watcher view (so the reconcile won't
///   reopen it) + keeps it in the Window menu, then DESTROYS the webview now.
///   That teardown triggers the SPA's pagehide cancellation for native and
///   browser transfers (server upload cleanup is already safe -- no
///   orphan/partial); the workspace's terminal PTYs survive server-side, so a
///   later reopen reconnects them with no transfer.
///
/// The result callback runs on the main thread (where the view/menu/destroy
/// mutations are safe); on macOS `native_dialog::confirm` defers the modal to a
/// later main-loop turn so this close handler stays non-blocking.
fn prompt_transfer_close(app: &AppHandle, state: &Arc<AppState>, label: &str) {
    let title = app
        .get_webview_window(label)
        .and_then(|w| w.title().ok())
        .unwrap_or_else(|| label.to_string());
    let app_cb = app.clone();
    let state_cb = Arc::clone(state);
    let label_cb = label.to_string();
    crate::native_dialog::confirm(
        app,
        "Transfer in progress",
        &format!(
            "\"{title}\" has a file transfer in progress. Cancel it and close the \
             window, or keep the window open until the transfer finishes?"
        ),
        "Cancel transfer & close",
        "Keep open",
        move |cancel_and_close| {
            if !cancel_and_close {
                // Keep open: `prevent_close` already kept it open + visible.
                return;
            }
            // Cancel: bury the view so the watcher reconcile won't reopen it,
            // keep it in the reopen menu, then destroy the webview now to
            // cancel its transfers (the PTYs survive server-side for a later
            // reopen).
            if let Some(view) = state_cb.local_watcher_view() {
                view.bury(&label_cb);
            }
            state_cb.bury_window(&label_cb, &title);
            crate::rebuild_window_menu(&app_cb);
            if let Some(w) = app_cb.get_webview_window(&label_cb) {
                let _ = w.destroy();
            }
        },
    );
}

/// Active-transfer guard prompt for a CONNECTED-DEVSERVER window. The transfer
/// lives in the remote SPA the webview hosts (and on the remote server), so the
/// desktop can't cancel it cleanly -- and DESTROYING the webview would just make
/// the devserver watcher reopen the window on its next feed push. So the choice
/// is hold vs hide, never "cancel": "Keep open" (default/Escape) stays visible to
/// watch it; "Hide" buries the window the normal devserver way (the webview stays
/// ALIVE and hidden, so the transfer keeps running, reopenable from the Window
/// menu). To actually cancel, the user uses the SPA's transfer bar. The result
/// callback runs on the main thread (where the hide/menu mutations are safe); on
/// macOS `native_dialog::confirm` defers the modal so this handler stays
/// non-blocking.
fn prompt_devserver_transfer_close(app: &AppHandle, state: &Arc<AppState>, label: &str) {
    let title = app
        .get_webview_window(label)
        .and_then(|w| w.title().ok())
        .unwrap_or_else(|| label.to_string());
    let app_cb = app.clone();
    let state_cb = Arc::clone(state);
    let label_cb = label.to_string();
    crate::native_dialog::confirm(
        app,
        "Transfer in progress",
        &format!(
            "\"{title}\" has a file transfer in progress. Keep the window open to \
             watch it finish, or hide it; the transfer keeps running in the \
             background (cancel it from the transfer bar if you need to)."
        ),
        "Hide window",
        "Keep open",
        move |hide| {
            if !hide {
                // Keep open: `prevent_close` already kept it open + visible.
                return;
            }
            // Hide the normal devserver way: the webview stays alive (so the
            // transfer continues), buried into the Window menu for reopen. Mirrors
            // the `else`-branch bury in the close handler, minus the second bury
            // notice (this prompt already explained the hide).
            if let Some(w) = app_cb.get_webview_window(&label_cb) {
                let t = w.title().unwrap_or_else(|_| label_cb.clone());
                let _ = w.hide();
                state_cb.bury_window(&label_cb, &t);
                crate::rebuild_window_menu(&app_cb);
            }
        },
    );
}

/// Map the live monitors to plain [`config::MonitorDesc`]s (full bounds + scale
/// for the signature; work area for the clamp). Empty on a monitor-query error,
/// which yields the degenerate `"0|"` signature -- a window then restores
/// size-only (no off-screen position) rather than crashing the open.
fn current_monitors(app: &AppHandle) -> Vec<config::MonitorDesc> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_desc)
        .collect()
}

/// One `tauri::Monitor` -> the plain descriptor the geometry math consumes.
fn monitor_desc(m: &tauri::Monitor) -> config::MonitorDesc {
    let pos = m.position();
    let size = m.size();
    let area = m.work_area();
    config::MonitorDesc {
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        work_x: area.position.x,
        work_y: area.position.y,
        work_w: area.size.width,
        work_h: area.size.height,
        scale: m.scale_factor(),
    }
}

/// What to do with a window's geometry at build time. `Restore` re-applies a
/// stored rect in LOGICAL points (clamped to the monitor it belongs to, position
/// preserved when on-screen); `Default` leaves the builder's 1200x800 + OS
/// position. A `Restore` builds the window hidden and applies the points geometry
/// post-build (see [`apply_geometry_plan`]). `Debug` is logged in the `WINGEO`
/// diagnostics.
#[derive(Debug)]
pub(crate) enum GeometryPlan {
    Default,
    /// Logical-points restore rect. Points are the global AppKit window space, so
    /// a hidden window whose scale falls back to the main display still lands at
    /// the right size on its own monitor once the value is applied as logical.
    Restore {
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    },
}

impl GeometryPlan {
    /// Whether the builder should start hidden (a `Restore` repositions /
    /// resizes post-build, so the window doesn't flash at the default first).
    pub(crate) fn builds_hidden(&self) -> bool {
        !matches!(self, GeometryPlan::Default)
    }
}

/// Build a `Restore` plan from a stored geometry: clamp it to the WORK area of
/// the monitor the stored rect belongs to (so the position is preserved when
/// on-screen, and the size is bounded to that monitor, not the primary). Falls
/// back to the union work-area box, then to the stored rect verbatim when no
/// monitors are known. Stored geometry is LOGICAL points, so the monitors are
/// converted to points first ([`config::to_points`]): physical monitor bounds
/// overlap across mixed DPI and would misattribute a window on a secondary
/// display to the primary, centering + shrinking it; points tile cleanly and
/// identify the right monitor.
fn plan_for_geometry(mons: &[config::MonitorDesc], g: &WindowGeometry) -> GeometryPlan {
    let pmons: Vec<config::MonitorDesc> = mons.iter().map(config::to_points).collect();
    let bbox = config::monitor_for_rect(&pmons, g.x, g.y, g.w, g.h)
        .map(|i| config::work_area_bbox(&pmons[i]))
        .or_else(|| config::union_work_bbox(&pmons));
    match bbox {
        Some(b) => {
            let (x, y, w, h) = config::clamp_rect_to_bbox(g.x, g.y, g.w, g.h, b);
            GeometryPlan::Restore { x, y, w, h }
        }
        None => GeometryPlan::Restore {
            x: g.x,
            y: g.y,
            w: g.w,
            h: g.h,
        },
    }
}

/// Resolve the geometry to apply for `label` against the CURRENT monitor
/// signature. An exact-signature match and a layout-changed fallback both
/// restore the stored rect clamped to its monitor, never centered and shrunk on
/// the primary (which would misplace a window saved on an external monitor);
/// nothing stored -> default. Desktop-local and read-only -- never blocks the
/// open. Logs a `WINGEO` line so the behaviour can be checked on real
/// multi-monitor hardware.
pub(crate) fn resolve_geometry_plan(app: &AppHandle, label: &str) -> GeometryPlan {
    let mons = current_monitors(app);
    let sig = config::monitor_signature(&mons);
    let state = app.state::<Arc<AppState>>();
    let (matched, stored_sig, plan) = match state.lookup_window_geometry(label, &sig) {
        None => ("none", String::new(), GeometryPlan::Default),
        Some(config::GeometryMatch::Exact(g)) => {
            ("exact", g.monitor_sig.clone(), plan_for_geometry(&mons, &g))
        }
        Some(config::GeometryMatch::Fallback(g)) => (
            "fallback",
            g.monitor_sig.clone(),
            plan_for_geometry(&mons, &g),
        ),
    };
    tracing::info!(
        label = %label,
        current_sig = %sig,
        stored_sig = %stored_sig,
        matched = matched,
        plan = ?plan,
        monitors = ?mons,
        "WINGEO resolve",
    );
    plan
}

/// Apply a resolved [`GeometryPlan`] to a freshly-built (hidden, for a `Restore`)
/// window, then reveal it. Logical points throughout (the stored geometry is
/// points); every step is best-effort so a geometry error degrades to a
/// default-placed visible window rather than a stuck-hidden one. Logs the
/// intended points vs ACTUAL physical geometry (`WINGEO applied`) so the host can
/// see whether macOS placed the window where asked.
pub(crate) fn apply_geometry_plan(window: &tauri::WebviewWindow, label: &str, plan: GeometryPlan) {
    let GeometryPlan::Restore { x, y, w, h } = plan else {
        return;
    };
    // Apply LOGICAL points. A hidden or ordered-out NSWindow has no screen, so
    // tao's scale_factor() falls back to the main display; a physical apply would
    // then be divided by the wrong scale and shrink the window. dpi passes a
    // Logical value through unchanged, so the window lands at the stored points
    // (and thus the right physical size) on its own monitor once shown, and the
    // size / position order does not matter.
    if let Err(e) = window.set_size(LogicalSize::new(w as f64, h as f64)) {
        tracing::warn!(label = %label, error = %e, "restoring window size failed");
    }
    if let Err(e) = window.set_position(LogicalPosition::new(x as f64, y as f64)) {
        tracing::warn!(label = %label, error = %e, "restoring window position failed");
    }
    reveal_window(window, label);
    tracing::info!(
        label = %label,
        want_x = x,
        want_y = y,
        want_w = w,
        want_h = h,
        got_pos = ?window.outer_position().ok(),
        got_size = ?window.inner_size().ok(),
        "WINGEO applied",
    );
}

/// Show + focus a window that was built hidden for geometry restore. Always
/// runs for a `Restore` so the window can never stay invisible.
fn reveal_window(window: &tauri::WebviewWindow, label: &str) {
    if let Err(e) = window.show() {
        tracing::warn!(label = %label, error = %e, "showing restored window failed");
    }
    let _ = window.set_focus();
}

/// Capture a window's CURRENT OS geometry (outer position + inner size) as
/// LOGICAL points under the live monitor signature and upsert it into the
/// desktop-local geometry LRU keyed by `label`. Called at every bury arm BEFORE
/// the window is hidden / destroyed, so a reopen restores the size + position the
/// user left. The window is still shown here, so `scale_factor()` is its real
/// monitor scale; converting the physical OS values to points makes the restore
/// scale-independent. Best-effort: skips on a query error or a degenerate (zero)
/// size; geometry is desktop-owned, so this runs for local and devserver windows
/// alike. Logs a `WINGEO capture` line (signature + points + scale +
/// monitors) for the host.
pub(crate) fn capture_window_geometry(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let (Ok(pos), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    // Store points, not physical: points tile across mixed-DPI monitors and apply
    // scale-independently, so a window rebuilt hidden on a different-scale display
    // still restores at the right size (see `apply_geometry_plan`).
    let lpos = pos.to_logical::<f64>(scale);
    let lsize = size.to_logical::<f64>(scale);
    let px = lpos.x.round() as i32;
    let py = lpos.y.round() as i32;
    let pw = lsize.width.round() as u32;
    let ph = lsize.height.round() as u32;
    let mons = current_monitors(app);
    let monitor_sig = config::monitor_signature(&mons);
    let on_monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| (m.name().cloned(), m.scale_factor()));
    tracing::info!(
        label = %label,
        sig = %monitor_sig,
        x = px,
        y = py,
        w = pw,
        h = ph,
        scale = scale,
        on_monitor = ?on_monitor,
        monitors = ?mons,
        "WINGEO capture",
    );
    app.state::<Arc<AppState>>().push_window_geometry(
        label,
        WindowGeometry {
            monitor_sig,
            x: px,
            y: py,
            w: pw,
            h: ph,
            saved_at: 0,
        },
    );
}

/// Destroy a window by its exact label, if it exists. Best-effort; used to
/// tear down a devserver's control terminal on disconnect. Window operations
/// run on the main thread.
pub fn close_window_by_label(app: &AppHandle, label: &str) {
    let app_owned = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_owned.get_webview_window(&label) {
            let _ = w.destroy();
        }
    });
}

/// Native keyboard shortcuts for workspace webviews. Translates chords
/// into the host-agnostic `chan:command` window event that chan's
/// App.svelte listens for. Runs before any page script, in capture
/// phase with stopImmediatePropagation, so this script is the sole
/// authority on every chord it claims, so chan's onWindowKey doesn't
/// fire for these even if its keymap drifts.
///
/// Layout mirrors VS Code; chords that browsers reserve at OS level
/// (Cmd+W, Cmd+N, Cmd+Shift+[/], Cmd+1..9) are bound here because
/// the native webview doesn't have those reservations. chan's web
/// fallbacks (Alt+Shift, Ctrl+Alt) keep working independently.
///
/// Off macOS these windows carry no menubar (only the launcher has one),
/// so the bridge also owns the chords the retired per-window menubars
/// claimed -- New Window (Ctrl+Shift+N) and Quit (Ctrl+Q), routed over
/// IPC like reload/zoom because the SPA command bus is dead on the
/// connecting screen. The launcher itself never loads this script (it
/// gets LAUNCHER_RELOAD_BRIDGE_JS), so its native menu chords can never
/// double-fire against the bridge.
const KEY_BRIDGE_JS: &str = r#"
(() => {
  function fire(e, name, detail) {
    e.preventDefault();
    e.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent('chan:command',
      { detail: Object.assign({ name: name }, detail || {}) }));
  }
  // Cmd+R reloads the webview, Cmd+Opt+I opens
  // DevTools. Both bypass the SPA event bus and invoke their
  // Tauri IPC commands directly so a frozen Svelte runtime or a
  // broken chord registry can't lock the dev affordances away.
  // GUARD the bridge BEFORE swallowing the event: when window.__TAURI__ is
  // absent (e.g. a devserver window where the bridge did not survive the
  // connecting -> external navigation), do NOT preventDefault -- let the event
  // bubble to the SPA's own handler (Cmd+R -> location.reload()) so the chord
  // degrades to a working fallback instead of dying. Swallowing first then
  // finding no bridge killed Cmd+R/devtools/zoom outright (no IPC, no fallback).
  function invokeIpc(e, cmd, args) {
    const tauri = window.__TAURI__;
    if (!(tauri && tauri.core && typeof tauri.core.invoke === 'function')) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    tauri.core.invoke(cmd, args).catch((err) => {
      console.error('[chan] IPC ' + cmd + ' failed:', err);
    });
  }
  // Chord policy: actions reachable through Hybrid Nav (Cmd+.) stay
  // unbound here so the native layer claims as little as possible.
  // The command-launcher chords (Cmd+K, Cmd+Shift+K, and the Ctrl+Alt
  // variants off-mac) stay page-owned too: the SPA's inline command deck
  // binds them identically on every surface, so no native claim exists.
  // Direct chords exist where Hybrid Nav is no substitute: Cmd+W (close
  // tab; pairs with the SPA's context-aware Ctrl+D), Cmd+Shift+W (close
  // window), Cmd+F/G (find on page), Cmd+1..9 (jump to tab), Cmd+[/Cmd+]
  // (pane nav), Cmd+/ and Cmd+Shift+/ (split right / down), Cmd+Shift+[/]
  // (tab nav), Cmd+Shift+G (find prev), plus New terminal (Cmd+T on
  // macOS, Ctrl+Shift+T off-mac) and Reopen closed tab (Cmd+Shift+T on
  // macOS, Ctrl+Alt+Shift+T off-mac), which route through the
  // context-aware helpers in App.svelte. Off-mac the bridge additionally
  // claims New Window (Ctrl+Shift+N) and Quit (Ctrl+Q) -- the chords the
  // retired per-window menubars owned -- gated on !metaKey so macOS,
  // whose menubar still owns them, never double-fires.
  function onKey(e) {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const shift = e.shiftKey;
    const alt = e.altKey;
    const code = e.code;
    if (alt) {
      // Windows delivers an AltGr keydown as ctrlKey+altKey, so on
      // layouts where AltGr composes text (US-International AltGr+W
      // types 'å') the chords below would swallow character entry and
      // KeyW would close the window mid-word. No chord in this branch
      // can be legitimately formed with AltGr, so bail without
      // preventDefault and let the key reach the webview. Gated on
      // ctrlKey so an engine that flags macOS Option as AltGraph
      // cannot break Cmd+Opt+I.
      if (e.ctrlKey && e.getModifierState('AltGraph')) return;
      // Cmd+Opt+I (macOS) / Ctrl+Alt+I (Linux/Windows) → DevTools.
      // Ctrl+Alt+Shift+T reopens the last closed tab on the Linux /
      // Windows desktop, where Ctrl+Shift+T is the New-terminal chord.
      // Ctrl+Alt+W closes the window on the Linux / Windows desktop,
      // where Ctrl+Shift+W is tab close; macOS keeps Cmd+Shift+W (the
      // shift branch below) so this is gated on !metaKey.
      // Other meta+alt chords are left to the webview defaults.
      if (!shift && code === 'KeyI') {
        invokeIpc(e, 'open_devtools');
      } else if (!e.metaKey && shift && code === 'KeyT') {
        fire(e, 'app.tab.reopenClosed');
      } else if (!e.metaKey && !shift && code === 'KeyW') {
        // On the connecting screen the SPA command bus is dead, so
        // destroy the window directly to cancel the connect, exactly
        // as the other two KeyW routings do.
        if (location.pathname.endsWith('/connecting.html')) {
          invokeIpc(e, 'request_close_window');
        } else {
          fire(e, 'app.window.close');
        }
      }
      return;
    }
    // Zoom chords route regardless of shift so
    // Cmd+= (US) and Cmd+Shift+= (= Cmd++) both fire zoom_in.
    // NumpadAdd / NumpadSubtract similarly. Cmd+0 / Cmd+Numpad0
    // reset to 100 %.
    switch (code) {
      case 'Equal':
      case 'NumpadAdd':
        invokeIpc(e, 'zoom_in');
        return;
      case 'Minus':
      case 'NumpadSubtract':
        invokeIpc(e, 'zoom_out');
        return;
      case 'Digit0':
      case 'Numpad0':
        invokeIpc(e, 'zoom_reset');
        return;
    }
    if (!shift) {
      switch (code) {
        // Quit on Linux/Windows: Ctrl+Q. The native Quit item owned this
        // chord while these windows had menubars; with the bars gone the
        // bridge claims it and routes to the same confirm-then-quit flow
        // the launcher's Quit item runs. Routed over IPC (like reload/
        // zoom) so a frozen SPA can't lock it away, and gated on
        // !metaKey so macOS Cmd+Q stays with the menubar. Claiming Ctrl+Q
        // costs a focused terminal its XON chord exactly as the menu
        // accelerator already did.
        case 'KeyQ': if (!e.metaKey) invokeIpc(e, 'request_app_quit'); return;
        // Reload. macOS binds Cmd+R (metaKey); Linux/Windows moves to
        // Ctrl+Shift+R (shift branch below) so plain Ctrl+R reaches a
        // focused terminal's shell reverse-search. Gating on metaKey
        // here leaves Linux/macOS plain Ctrl+R untouched (no
        // preventDefault -> falls through to xterm), mirroring the
        // Cmd+W idiom below.
        case 'KeyR': if (e.metaKey) invokeIpc(e, 'reload_window'); return;
        // New terminal: Cmd+T on macOS. Off-mac the chord is Ctrl+Shift+T
        // (shift branch below), so gate on metaKey and leave plain Ctrl+T
        // to a focused terminal, mirroring the reload idiom above.
        case 'KeyT': if (e.metaKey) fire(e, 'app.terminal.toggle'); return;
        // Cmd+W closes the tab
        // on macOS. On Linux the platform mod is Ctrl and Ctrl+W is
        // readline delete-word inside a focused terminal, so DON'T
        // claim it - let it reach xterm. Linux closes tabs with
        // Ctrl+Shift+W (the shift branch below) or Ctrl+D
        // (context-aware via the SPA's onCtrlDCapture, which leaves a
        // focused terminal to its EOF). Gating on metaKey (Cmd) leaves
        // Linux Ctrl+W untouched (no preventDefault -> reaches xterm).
        case 'KeyW':
          if (e.metaKey) {
            // On the connecting/retry page there are no tabs and the
            // app.tab.close dispatch is dead: Cmd+W means cancel, so
            // close the window for real (request_close_window
            // destroys, bypassing bury-on-close). The bridge claims
            // KeyW with stopImmediatePropagation BEFORE the page's own
            // listener AND before the File menu accelerator gets a
            // look-in, so the routing must happen here. Gate on the
            // CURRENT document (this init script re-runs after the
            // success navigation, where Cmd+W must stay tab-close).
            if (location.pathname.endsWith('/connecting.html')) {
              invokeIpc(e, 'request_close_window');
              return;
            }
            fire(e, 'app.tab.close');
          }
          return;
        case 'KeyF': fire(e, 'app.find.open');        return;
        case 'KeyG': fire(e, 'app.find.next');        return;
        // Cmd+I does NOT open Dashboard; it is reserved for the editor's
        // italic chord (bound in Wysiwyg.svelte's CM6 keymap). Dashboard
        // is reachable via the launcher + the Dashboard hamburger. With
        // no `KeyI` case here, Cmd+I falls through to the focused webview
        // (the editor toggles italic; otherwise inert). Cmd+Opt+I opens
        // DevTools (the alt branch above).
        case 'BracketLeft':  fire(e, 'app.pane.prev'); return;
        case 'BracketRight': fire(e, 'app.pane.next'); return;
        // Cmd+/ split right. Split
        // bottom is Cmd+Shift+/ (shift branch below). Cmd+\ is
        // deliberately NOT used: 1Password's system-wide Cmd+\
        // hotkey is dispatched by macOS before the key reaches this
        // webview, so chan never receives it. Web reaches splits via
        // Hybrid Nav `/` and `?`.
        case 'Slash':        fire(e, 'app.pane.splitRight'); return;
      }
      const m = code.match(/^Digit([1-9])$/);
      if (m) {
        fire(e, 'app.tab.jump', { index: Number(m[1]) - 1 });
        return;
      }
    } else {
      switch (code) {
        // New Window on Linux/Windows: Ctrl+Shift+N -- another chord the
        // retired per-window menubars owned. The IPC routes by the
        // INVOKING window's label (another window of its connection, a
        // standalone terminal from a control window), which is
        // focus-proof and works on the connecting screen, where the SPA
        // command bus is dead. !metaKey: macOS Cmd+Shift+N stays with
        // the menubar.
        case 'KeyN': if (!e.metaKey) invokeIpc(e, 'open_new_window'); return;
        // Reload on Linux/Windows: Ctrl+Shift+R. Gate on !metaKey so
        // macOS Cmd+Shift+R does NOT reload (macOS reloads on Cmd+R in
        // the !shift branch above); the !metaKey form fires only for the
        // Ctrl+Shift+R that Linux/Windows users press.
        case 'KeyR': if (!e.metaKey) invokeIpc(e, 'reload_window'); return;
        // Cmd+Shift+W (macOS) stays window close (app.window.close).
        // Ctrl+Shift+W (Linux, Windows) is the chord a user reaches for
        // to close a TAB, so it fires app.tab.close; window close moved
        // to Ctrl+Alt+W (the alt branch above). app.tab.close cannot
        // carry escapeTerminal (the flag is per entry and would also
        // escape the entry's web Ctrl+D, breaking shell EOF in a
        // browser), so what stands between Ctrl+Shift+W and a focused
        // shell is this listener's window-capture
        // stopImmediatePropagation. On the connecting screen the SPA
        // command bus is dead, so destroy the window directly to cancel
        // the connect.
        case 'KeyW':
          if (location.pathname.endsWith('/connecting.html')) {
            invokeIpc(e, 'request_close_window');
            return;
          }
          if (e.metaKey) fire(e, 'app.window.close');
          else fire(e, 'app.tab.close');
          return;
        case 'KeyG':         fire(e, 'app.find.prev');     return;
        // Reopen closed tab: Cmd+Shift+T on macOS. Off-mac Ctrl+Shift+T is
        // New terminal (bare Ctrl+T being a terminal chord), so reopen
        // moves to Ctrl+Alt+Shift+T (the alt branch above).
        case 'KeyT':
          if (e.metaKey) fire(e, 'app.tab.reopenClosed');
          // A control terminal is a singleton (no tabs; the SPA blocks
          // app.terminal.toggle there), so off-mac its New-terminal chord
          // spawns a standalone terminal window -- the claim its retired
          // per-window menubar held. The kind rides the init script
          // (window.__CHAN_WINDOW_KIND__).
          else if (!e.metaKey && window.__CHAN_WINDOW_KIND__ === 'control') invokeIpc(e, 'open_new_window');
          else fire(e, 'app.terminal.toggle');
          return;
        case 'BracketLeft':  fire(e, 'app.tab.prev');      return;
        case 'BracketRight': fire(e, 'app.tab.next');      return;
        // Cmd+Shift+/ (= Cmd+?) splits the active pane
        // bottom, pairing with Cmd+/ split-right above. Cmd+\ is
        // avoided - 1Password's global hotkey shadows it.
        case 'Slash':        fire(e, 'app.pane.splitDown');  return;
      }
    }
  }
  window.addEventListener('keydown', onKey, true);
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_open_mode_mints_only_for_explicit_opens() {
        assert!(WorkspaceOpenMode::OpenWindow.should_mint());
        assert!(!WorkspaceOpenMode::RestoreOnly.should_mint());
    }

    #[tokio::test]
    async fn failed_control_window_build_reaps_unregistered_tenant() {
        let config = tempfile::tempdir().expect("config dir");
        let library =
            chan_workspace::Library::open_at(config.path().join("config.toml")).expect("library");
        let embedded = crate::embedded::EmbeddedServer::for_tests(library).await;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            for build_fails in [true, false] {
                let mut mounted_prefix = String::new();
                let result = build_control_terminal(&embedded, "true".to_string(), |url| {
                    mounted_prefix = url::Url::parse(&url)
                        .expect("launch URL")
                        .path()
                        .strip_suffix("/index.html")
                        .expect("prefixed launch path")
                        .to_string();
                    std::future::ready(if build_fails {
                        Err("injected native build error".to_string())
                    } else {
                        Ok(())
                    })
                })
                .await;
                // The real host returns true only if this test removed a tenant
                // still owned by the failed/successful build. Also clean up the
                // fixture before asserting, including on the failing baseline.
                let retained = embedded
                    .close_terminal_tenant(&mounted_prefix)
                    .await
                    .expect("close fixture tenant");
                if build_fails {
                    assert_eq!(result.err().as_deref(), Some("injected native build error"));
                    assert!(!retained, "failed build retained its unregistered tenant");
                } else {
                    assert_eq!(result.expect("built window").prefix, mounted_prefix);
                    assert!(
                        retained,
                        "successful build must retain its tenant for tracking"
                    );
                }
            }
        })
        .await
        .expect("control tenant lifecycle must finish");
    }

    /// Fresh `AppState` over a throwaway config store. The tempdir is leaked
    /// so the store path outlives the test body.
    fn empty_state() -> Arc<AppState> {
        let dir = tempfile::tempdir().expect("config dir");
        let store = std::sync::Arc::new(std::sync::Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        std::mem::forget(dir);
        Arc::new(AppState::with_store(store))
    }

    /// Two `start` calls for one key, both past the `serves` pre-check before
    /// either can mount.
    ///
    /// Determinism comes from the library's own in-process guard: while the
    /// test holds an `Arc<Workspace>` for the root, the host polls inside its
    /// one-second release budget while holding `register_lock`. Both callers
    /// remain past the pre-check with `serves` empty: one waits for release,
    /// the other for registration. Dropping the handle lets both use one
    /// mount, and whichever inserts second takes the duplicate branch.
    #[tokio::test]
    async fn a_lost_duplicate_open_leaves_the_shared_tenant_live() {
        let config = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::write(root.path().join("note.md"), "# n\n").expect("seed note");
        let library =
            chan_workspace::Library::open_at(config.path().join("config.toml")).expect("library");
        library.register_workspace(root.path()).expect("register");

        let state = empty_state();
        let embedded = crate::embedded::EmbeddedServer::for_tests(library.clone()).await;
        assert!(state.embedded.set(embedded).is_ok(), "fresh state");
        let app = tauri::test::mock_app();
        let key = root.path().to_string_lossy().into_owned();

        // Park the callers at workspace release and serialized registration.
        let blocker = library.open_workspace(root.path()).expect("hold the root");

        let first = tokio::spawn(start(
            app.handle().clone(),
            Arc::clone(&state),
            key.clone(),
            WorkspaceOpenMode::RestoreOnly,
        ));
        let second = tokio::spawn(start(
            app.handle().clone(),
            Arc::clone(&state),
            key.clone(),
            WorkspaceOpenMode::RestoreOnly,
        ));
        // Long enough for both spawned tasks to run their (synchronous)
        // pre-check and reach the host's release wait, within its one-second
        // budget.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert!(
            state.serves.lock().unwrap().is_empty(),
            "neither caller can have published while the root is held",
        );
        drop(blocker);

        first.await.expect("first join").expect("first start");
        second.await.expect("second join").expect("second start");

        let embedded = state.embedded.get().expect("embedded");
        assert!(
            embedded.is_root_mounted(root.path()),
            "the loser must not close the tenant both callers share",
        );
        assert!(
            state.serves.lock().unwrap().contains_key(&key),
            "serves must agree with the live mount",
        );

        // And the recorded state is usable: a normal close drains the tenant.
        let outcome = stop_handle(None, &state, &key, false).await.expect("stop");
        assert_eq!(outcome, WorkspaceLifecycleOutcome::Completed);
        assert!(!embedded.is_root_mounted(root.path()));
    }

    #[test]
    fn cli_handoff_mints_for_running_and_stopped_workspaces() {
        const MAIN_RS: &str = include_str!("main.rs");
        let handoff = MAIN_RS
            .split("fn open_workspace_from_handoff(")
            .nth(1)
            .expect("handoff function exists")
            .split("async fn close_workspace_from_handoff(")
            .next()
            .expect("handoff section ends before close");

        assert!(
            handoff.contains(".mint_window(chan_server::WindowKind::Workspace"),
            "an already-running workspace must mint immediately",
        );
        assert!(
            handoff.contains("serve::WorkspaceOpenMode::OpenWindow"),
            "a stopped workspace must mint after mounting",
        );
    }

    #[test]
    fn boot_restore_requests_no_window_mint() {
        const MAIN_RS: &str = include_str!("main.rs");
        let boot = MAIN_RS
            .split("// Boot matrix.")
            .nth(1)
            .expect("boot matrix exists")
            .split("// On-launch self-update check")
            .next()
            .expect("boot matrix ends before update check");

        assert!(boot.contains("serve::WorkspaceOpenMode::RestoreOnly"));
        assert!(!boot.contains("serve::WorkspaceOpenMode::OpenWindow"));
    }

    #[test]
    fn renderer_signal_is_appended_for_the_serving_tenant() {
        let mut url: tauri::Url = "https://example.test/workspace/index.html?existing=1"
            .parse()
            .unwrap();
        append_renderer_signal(&mut url, Some(false));
        assert_eq!(
            url.query(),
            Some("existing=1&chan-renderer=dom"),
            "the DOM decision must reach the served shell",
        );

        append_renderer_signal(&mut url, Some(true));
        assert!(url.query().unwrap().ends_with("chan-renderer=webgl"));

        let mut undecided: tauri::Url =
            "https://example.test/workspace/index.html?chan-renderer=webgl&existing=1"
                .parse()
                .unwrap();
        append_renderer_signal(&mut undecided, None);
        assert_eq!(undecided.query(), Some("existing=1"));
    }

    #[test]
    fn compose_window_title_appends_the_caption_in_brackets() {
        // The unlabelled shape is what every existing window carries; adding a
        // caption must not disturb it.
        assert_eq!(
            compose_window_title("\u{2302} /w/notes", "workspace", 2, ""),
            "\u{2302} /w/notes Window 2",
        );
        assert_eq!(
            compose_window_title("\u{2302} /w/notes", "workspace", 2, "release checks"),
            "\u{2302} /w/notes Window 2 [release checks]",
        );
        assert_eq!(
            compose_window_title("Terminal", "terminal", 1, "deploy shell"),
            "Terminal Window 1 [deploy shell]",
        );
        // The server trims before persisting, but the desktop composes from
        // whatever the record carries, so whitespace-only must not open an empty
        // pair of brackets.
        assert_eq!(
            compose_window_title("Terminal", "terminal", 1, "   "),
            "Terminal Window 1",
        );
        assert_eq!(
            compose_window_title("Terminal", "terminal", 1, "  spaced  "),
            "Terminal Window 1 [spaced]",
        );
        // The control-window shape is pinned by
        // `control_terminal_titles_do_not_use_window_number_suffix`.
    }

    #[test]
    fn every_watched_url_reads_the_boot_mode_from_one_switch() {
        // The open, retarget, and open-in-browser paths must agree on a
        // record's `?kind=`: a window that retargeted (token rotation) or
        // opened in the browser through its own copy of the switch would drift
        // from the one the watcher opened it with.
        const SERVE_RS: &str = include_str!("serve.rs");
        for (function, ends_before) in [
            (
                "fn retarget_watched_remote_window",
                "/// Mint a standalone terminal window",
            ),
            ("fn browser_window_url", "fn workspace_window_target_url"),
        ] {
            let body = SERVE_RS
                .split(function)
                .nth(1)
                .expect("the function exists")
                .split(ends_before)
                .next()
                .expect("the section ends before the next item");
            assert!(
                body.contains("watched_window_kind(record)"),
                "{function} must read the boot mode from watched_window_kind",
            );
        }
        // The watcher stamps the same projection into the title map, so
        // `GET /api/windows` and `cs window list` report the mode the window
        // actually booted in.
        const WIRING_RS: &str = include_str!("window_watcher_wiring.rs");
        let sync = WIRING_RS
            .split("fn sync_title(&self, record")
            .nth(1)
            .expect("sync_title exists")
            .split("impl NativeSurface")
            .next()
            .expect("sync_title section ends before the surface impl");
        assert!(sync.contains("serve::watched_window_kind(record)"));
    }

    #[test]
    fn the_build_and_retitle_paths_share_one_title_composer() {
        // The watcher's retitle compares its composed title against the live
        // `window.title()` to decide whether to write. A second formatter that
        // drifted by even a space would make every reconcile rewrite the title
        // (and rebuild the Window menu) forever, so both paths must funnel
        // through `compose_window_title`.
        const SERVE_RS: &str = include_str!("serve.rs");
        const WIRING_RS: &str = include_str!("window_watcher_wiring.rs");
        // Bounded before the test module, or this test's own source would
        // satisfy the assertion.
        let build = SERVE_RS
            .split("fn build_workspace_window_with_completion(")
            .nth(1)
            .expect("build_workspace_window_with_completion exists")
            .split("#[cfg(test)]")
            .next()
            .expect("build section ends before the tests");
        assert!(build.contains("compose_window_title("));
        let sync = WIRING_RS
            .split("fn sync_title(&self, record")
            .nth(1)
            .expect("sync_title exists")
            .split("impl NativeSurface")
            .next()
            .expect("sync_title section ends before the surface impl");
        assert!(sync.contains("serve::watched_window_title("));
        assert!(
            !sync.contains("format!("),
            "sync_title must not compose a title of its own",
        );
    }

    fn test_mon(x: i32, y: i32, w: u32, h: u32, scale: f64) -> config::MonitorDesc {
        // Work area == full bounds so the clamp is a no-op for on-screen rects,
        // isolating these assertions to the monitor identification.
        config::MonitorDesc {
            x,
            y,
            w,
            h,
            work_x: x,
            work_y: y,
            work_w: w,
            work_h: h,
            scale,
        }
    }

    fn test_geom(x: i32, y: i32, w: u32, h: u32) -> WindowGeometry {
        WindowGeometry {
            monitor_sig: String::new(),
            x,
            y,
            w,
            h,
            saved_at: 0,
        }
    }

    #[test]
    fn plan_for_geometry_restores_points_on_the_correct_monitor() {
        // Physical monitors: a 2x built-in main at the origin and a 1x external to
        // its right. In tao's physical space the external's origin lands inside the
        // main's doubled extent, so a naive physical plan would misattribute an
        // external window to the main and shrink it. plan_for_geometry converts to
        // points, where the monitors tile cleanly.
        let mons = [
            test_mon(0, 0, 3024, 1964, 2.0),
            test_mon(1512, 0, 1920, 1080, 1.0),
        ];

        // Points window on the external, fully on-screen: the plan passes the
        // points through unchanged (a physical plan would clamp it to the main).
        let GeometryPlan::Restore { x, y, w, h } =
            plan_for_geometry(&mons, &test_geom(1900, 200, 800, 600))
        else {
            panic!("on-screen rect must produce a Restore plan");
        };
        assert_eq!((x, y, w, h), (1900, 200, 800, 600));

        // Points window on the 2x main stays put too.
        let GeometryPlan::Restore { x, y, w, h } =
            plan_for_geometry(&mons, &test_geom(100, 100, 600, 400))
        else {
            panic!("main-monitor rect must produce a Restore plan");
        };
        assert_eq!((x, y, w, h), (100, 100, 600, 400));
    }

    #[test]
    fn resolve_label_matches_a_bare_window_id_to_its_composite_native_label() {
        // The launcher's window open/hide actions send the BARE library-minted
        // `window_id`; the desktop must resolve it to the composite native label
        // the watcher actually opened (`{library_id}::{window_id}`).
        let open = vec!["local::w-1".to_string(), "lib-abc::w-2".to_string()];
        assert_eq!(resolve_label_from("w-1", &open), "local::w-1");
        assert_eq!(resolve_label_from("w-2", &open), "lib-abc::w-2");
    }

    #[test]
    fn resolve_label_matches_a_bare_id_to_a_buried_devserver_label() {
        // A buried DEVSERVER standalone terminal's webview was destroyed, so it is
        // NOT in the open set. `resolve_window_label` adds the buried list to the
        // candidates, so the bare id resolves to its real `lib-<hex>::` label (not
        // the `local::` fallback), letting the dot-show un-bury via the devserver
        // view instead of falling to the workspace-only path. The buried composite
        // is the only candidate here (no open webview).
        let candidates = vec!["lib-abc::w-7".to_string()];
        assert_eq!(resolve_label_from("w-7", &candidates), "lib-abc::w-7");
    }

    #[test]
    fn resolve_label_matches_a_server_hidden_devserver_feed_label() {
        // A server-hidden devserver window from a previous desktop session may
        // have no live webview and no local buried-menu entry. The devserver
        // window feed is still enough to recover the composite label.
        let candidates = vec!["lib-dev1::w-hidden".to_string()];
        assert_eq!(
            resolve_label_from("w-hidden", &candidates),
            "lib-dev1::w-hidden"
        );
    }

    #[test]
    fn resolve_label_falls_back_to_local_for_an_unmatched_bare_id() {
        // A bare id matching NO candidate (neither an open window nor a buried
        // composite) resolves to the `local::` composite as a last resort -- the
        // local watcher's view-driven un-bury then no-ops gracefully if it names
        // nothing.
        let candidates = vec!["lib-abc::w-9".to_string()];
        assert_eq!(resolve_label_from("w-1", &candidates), "local::w-1");
        assert_eq!(resolve_label_from("w-1", &[]), "local::w-1");
    }

    #[test]
    fn resolve_label_qualifies_only_library_minted_bare_ids() {
        // A control terminal has no `library_id::` prefix, so it is its own
        // native label even with no live candidate.
        assert_eq!(
            resolve_label_from("control-terminal-ds1", &[]),
            "control-terminal-ds1"
        );
        // Unrecognized label families have no parser exception and do not look
        // like library-minted ids. Leaving them unmatched makes open return the
        // ordinary "isn't open" error rather than routing into the local watcher.
        assert_eq!(resolve_label_from("terminal-3", &[]), "terminal-3");
        assert_eq!(
            resolve_label_from("workspace-abc-1", &[]),
            "workspace-abc-1"
        );
        assert_eq!(resolve_label_from("w-1", &[]), "local::w-1");
    }

    #[test]
    fn resolve_label_passes_a_full_composite_label_through_verbatim() {
        // `cs window open/hide` passes the full label already; a composite is used
        // verbatim even when its native window was destroyed (not in the open set),
        // so `cs window open <composite>` reaches the view-driven reopen too.
        let open = vec!["local::w-5".to_string()];
        assert_eq!(resolve_label_from("local::w-1", &open), "local::w-1");
        assert_eq!(resolve_label_from("lib-z::w-3", &[]), "lib-z::w-3");
    }

    #[test]
    fn devserver_token_refresh_retargets_existing_window_before_rebuild() {
        const SERVE_RS: &str = include_str!("serve.rs");
        const WIRING_RS: &str = include_str!("window_watcher_wiring.rs");
        let retarget = SERVE_RS
            .split("fn retarget_watched_remote_window")
            .nth(1)
            .expect("retarget_watched_remote_window exists")
            .split("/// Mint a standalone terminal window")
            .next()
            .expect("retarget section ends before terminal builder");
        assert!(retarget.contains(".navigate(target)"));
        assert!(
            !retarget.contains(concat!(".", "destroy")),
            "retarget must not destroy the reconnecting webview",
        );

        // The refresh path routes through the async navigator, which
        // retargets in place; a vanished webview mid-gap means a close raced
        // the retarget, so that arm BAILS (rebuilding would resurrect a
        // window the user just closed) and leaves reopening to the nudged
        // reconcile.
        let refresh = WIRING_RS
            .split("fn refresh(&self, record")
            .nth(1)
            .expect("surface refresh exists")
            .split("fn close(&self, label")
            .next()
            .expect("refresh section ends before close");
        assert!(refresh.contains("navigate_remote(record, true)"));
        let navigator = WIRING_RS
            .split("fn navigate_remote(&self, record")
            .nth(1)
            .expect("navigate_remote exists")
            .split("impl NativeSurface")
            .next()
            .expect("navigate_remote section ends before the surface impl");
        assert!(navigator.contains("retarget_watched_remote_window"));
        // Dispatch-time remember: reconciles during the mint gap see the
        // intended key and do not spawn duplicate navigate tasks.
        let pre_spawn = navigator
            .split("async_runtime::spawn")
            .next()
            .expect("navigator has a pre-spawn section");
        assert!(pre_spawn.contains("RemoteLaunchKey::from_record"));
        // Open-path cancellation: a close() during the mint removes the
        // in-flight marker and the task must bail instead of building.
        assert!(navigator.contains("if !builds.contains(&label)"));
        // Vanished-retarget arm bails without a rebuild.
        let vanished = navigator
            .split("Ok(false) => {")
            .nth(1)
            .expect("vanished-retarget arm exists")
            .split("Ok(true)")
            .next()
            .expect("vanished arm ends before Ok(true)");
        assert!(vanished.contains("return;"));
        assert!(
            !vanished.contains("open_watched_remote_window"),
            "a vanished retarget must not rebuild (resurrects closed windows)",
        );

        // The Cmd+R / tab-Reload path resolves its navigation URL the same
        // way (a fresh gateway mint), never a bare origin.
        const MAIN_RS: &str = include_str!("main.rs");
        let reload = MAIN_RS
            .split("fn reload_devserver_window_from_feed")
            .nth(1)
            .expect("reload_devserver_window_from_feed exists")
            .split("fn open_devtools")
            .next()
            .expect("reload section ends before open_devtools");
        assert!(reload.contains("window_navigation_url"));
        assert!(!reload.contains("conn_base_origin"));
    }

    #[test]
    fn refresh_library_transfers_replaces_only_that_librarys_slice() {
        use std::collections::HashSet;
        let mut set: HashSet<String> = ["lib-a::w1", "lib-a::w2", "lib-b::w9"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // A fresh lib-a push: only w3 is transferring now -- its old slice drops,
        // the other library is untouched.
        crate::refresh_library_transfers(&mut set, "lib-a", &["lib-a::w3".to_string()]);
        assert!(set.contains("lib-a::w3"));
        assert!(!set.contains("lib-a::w1"));
        assert!(!set.contains("lib-a::w2"));
        assert!(set.contains("lib-b::w9"));
        // A lib-a push with nothing transferring clears its slice only.
        crate::refresh_library_transfers(&mut set, "lib-a", &[]);
        assert!(!set.iter().any(|l| l.starts_with("lib-a::")));
        assert!(set.contains("lib-b::w9"));
    }

    #[test]
    fn invoke_handler_registers_reload_window_and_open_devtools() {
        // The IPC commands `reload_window` and
        // `open_devtools` MUST be in the `tauri::generate_handler!`
        // list so the SPA's tab context-menu and the
        // accelerator path can reach them. The generate_handler!
        // macro does not catch a missing handler at compile time,
        // so we pin it here against the source file. Tests live in
        // serve.rs because main.rs has no test module today; using
        // `include_str!` keeps the pin source-of-truth-correct.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("reload_window,"));
        assert!(MAIN_RS.contains("open_devtools,"));
        assert!(MAIN_RS.contains("fn reload_window("));
        assert!(MAIN_RS.contains("state: State<Arc<AppState>>"));
        assert!(MAIN_RS.contains("reload_devserver_window_from_feed"));
        assert!(MAIN_RS.contains("fn open_devtools(window: tauri::WebviewWindow)"));
    }

    #[test]
    fn key_bridge_wires_zoom_chords_to_ipc() {
        // Cmd+= / Cmd+- / Cmd+0 (and their
        // Numpad variants) route directly to the chan-desktop
        // zoom IPC commands. Routed BEFORE the shift branch so
        // Cmd+Shift+= (= Cmd++) also zooms in. Capture-phase
        // listener stops the keydown so Tauri's `zoom_hotkeys_enabled`
        // polyfill (still on as a mousewheel + pinch fallback)
        // doesn't double-fire.
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'zoom_in')"));
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'zoom_out')"));
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'zoom_reset')"));
        assert!(KEY_BRIDGE_JS.contains("case 'Equal':"));
        assert!(KEY_BRIDGE_JS.contains("case 'Minus':"));
        assert!(KEY_BRIDGE_JS.contains("case 'Digit0':"));
        assert!(KEY_BRIDGE_JS.contains("case 'NumpadAdd':"));
        assert!(KEY_BRIDGE_JS.contains("case 'NumpadSubtract':"));
        assert!(KEY_BRIDGE_JS.contains("case 'Numpad0':"));
    }

    #[test]
    fn invoke_handler_registers_zoom_commands() {
        // zoom_in / zoom_out / zoom_reset must be
        // in `tauri::generate_handler!` so KEY_BRIDGE_JS's IPC
        // invocations reach a registered command. generate_handler!
        // doesn't catch missing entries at compile time; pin here.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("zoom_in,"));
        assert!(MAIN_RS.contains("zoom_out,"));
        assert!(MAIN_RS.contains("zoom_reset,"));
    }

    #[test]
    fn remote_devserver_windows_load_the_connecting_page_not_the_remote() {
        // A direct WebviewUrl::External(remote) paints white when the remote is
        // down. Remote devserver windows load the
        // bundled connecting page instead, which probes via `probe_url` and
        // navigates on success. Needles are built at runtime so this test's
        // own source text doesn't satisfy the `contains` checks (the
        // bin_status test uses the same trick).
        let serve_rs = include_str!("serve.rs");
        let app_load = format!("WebviewUrl::App({q}connecting.html", q = '"');
        let handoff = format!("__CHAN{u}CONNECTING__", u = '_');
        assert!(
            serve_rs.contains(&app_load),
            "remote devserver windows must load connecting.html, not the remote directly",
        );
        assert!(
            serve_rs.contains(&handoff),
            "the connecting page must receive its inputs via window.__CHAN_CONNECTING__",
        );
    }

    #[test]
    fn invoke_handler_registers_probe_url() {
        // The connecting screen's retry loop calls `probe_url` each attempt;
        // it must be in `tauri::generate_handler!` or the IPC denies and the
        // screen never detects a reachable remote. generate_handler! doesn't
        // catch a missing entry at compile time, so pin it here.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("probe_url,"));
        assert!(MAIN_RS.contains("fn probe_url("));
    }

    #[test]
    fn registry_commands_run_in_process_not_via_chan_cli() {
        // chan-desktop runs without a `chan` binary: a registry add
        // writes through the embedded host's shared `Library`, and a
        // remove routes through the embedded host lifecycle.
        // Pin the in-process call shape so a future change can't silently
        // reintroduce a subprocess dependency, and assert the deleted
        // subprocess argument shapes are gone.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains("embedded.library()"),
            "registry commands must route through the embedded shared Library",
        );
        assert!(
            MAIN_RS.contains("register_workspace") && MAIN_RS.contains("remove_workspace_root"),
            "registry add/remove must use embedded in-process registry operations",
        );
        assert!(
            !MAIN_RS.contains("read_features_via_chan_index_status"),
            "the `chan index status --json` read path must be gone",
        );
        assert!(
            !MAIN_RS.contains("\"--semantic-search\"") && !MAIN_RS.contains("\"enable-semantic\""),
            "no chan CLI feature-flag arguments may remain",
        );
    }

    #[test]
    fn bin_status_machinery_is_gone() {
        // chan-desktop has no bundled-binary preflight or gating
        // (no subprocess paths). Pin the absence so a future change can't
        // quietly re-add a `chan` binary dependency or its gating.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            !MAIN_RS.contains("chan_bin_status"),
            "chan_bin_status command + registration must be gone",
        );
        assert!(
            !MAIN_RS.contains("fn require_bin"),
            "require_bin gating helper must be gone",
        );
        assert!(
            !MAIN_RS.contains("struct BinStatus"),
            "BinStatus struct must be gone",
        );
        // serve.rs must not carry the binary resolver either. Build
        // the needle at runtime so this assertion's own source text
        // doesn't satisfy the `contains` check it performs.
        let serve_rs = include_str!("serve.rs");
        let resolver_sig = format!("fn resolve{}binary", "_chan_");
        assert!(
            !serve_rs.contains(&resolver_sig),
            "binary resolution helpers must be gone from serve.rs",
        );
    }

    #[test]
    fn new_window_accelerator_uses_cmd_shift_n() {
        // The "New Window" menu item binds
        // `CmdOrCtrl+Shift+N`; plain Cmd+N belongs to
        // the SPA's New Draft handler. Pin the
        // chord so a future menu edit can't silently land on
        // plain Cmd+N and clash with the SPA chord.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains(".accelerator(\"CmdOrCtrl+Shift+N\")"),
            "main.rs must bind the New Window menu item to CmdOrCtrl+Shift+N"
        );
        assert!(
            !MAIN_RS.contains(".accelerator(\"CmdOrCtrl+N\")"),
            "main.rs must NOT bind any menu item to plain CmdOrCtrl+N (reserved for SPA New Draft)"
        );
    }

    #[test]
    fn key_bridge_wires_reload_and_devtools_ipc() {
        // Cmd+R fires the `reload_window` IPC and
        // Cmd+Opt+I fires `open_devtools`, bypassing the SPA event
        // bus so a frozen Svelte runtime can't lock the dev
        // affordances away. The accelerator path goes through
        // `invokeIpc(...)` (not the `chan:command` `fire(...)`
        // bridge), so the contract pin checks both the IPC command
        // names and the case-label they're bound from.
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'reload_window')"));
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'open_devtools')"));
        // Reload is per-OS: Cmd+R (metaKey, no-shift branch) on macOS and
        // Ctrl+Shift+R (!metaKey, shift branch) on Linux/Windows, so plain
        // Ctrl+R is never claimed and reaches the terminal's reverse-search.
        assert!(KEY_BRIDGE_JS.contains("case 'KeyR': if (e.metaKey) invokeIpc(e, 'reload_window')"));
        assert!(
            KEY_BRIDGE_JS.contains("case 'KeyR': if (!e.metaKey) invokeIpc(e, 'reload_window')")
        );
        assert!(KEY_BRIDGE_JS.contains("code === 'KeyI'"));
    }

    #[test]
    fn key_bridge_serves_the_retired_menu_chords_off_mac() {
        // With no per-window menubars off-mac, the chords the menus owned
        // move into the bridge, gated on !metaKey so macOS (whose menubar
        // still owns them) never double-fires. New Window / Quit route
        // over IPC (not the SPA bus) so the connecting screen can serve
        // them too; a control terminal's New-terminal chord spawns a
        // standalone window instead of toggling a tab it does not have.
        assert!(
            KEY_BRIDGE_JS.contains("case 'KeyN': if (!e.metaKey) invokeIpc(e, 'open_new_window')")
        );
        assert!(
            KEY_BRIDGE_JS.contains("case 'KeyQ': if (!e.metaKey) invokeIpc(e, 'request_app_quit')")
        );
        assert!(KEY_BRIDGE_JS.contains("window.__CHAN_WINDOW_KIND__ === 'control'"));
        // The kind global is stamped per window at build time, ahead of
        // the bridge in both init-script shapes (direct load and the
        // connecting screen).
        const SERVE_RS: &str = include_str!("serve.rs");
        assert!(SERVE_RS.contains("window.__CHAN_WINDOW_KIND__ = "));
    }

    #[test]
    fn off_mac_workspace_windows_are_born_menu_less() {
        // Off-mac only the launcher carries a menubar (main.rs attaches
        // it per-window with `Window::set_menu`; there is no app-wide
        // default), so `build_workspace_window_with_completion` must attach NO menu: a
        // window built without one then has no bar at all. concat! so
        // the absence pin doesn't match this test's own source.
        const SERVE_RS: &str = include_str!("serve.rs");
        assert!(
            !SERVE_RS.contains(concat!("builder.", "menu(")),
            "build_workspace_window_with_completion must not attach a per-window menu",
        );
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains("main.set_menu(menu)"),
            "the launcher menu must be attached per-window on the main window",
        );
    }

    #[test]
    fn key_bridge_invokes_tauri_ipc_via_core_invoke() {
        // The `invokeIpc` helper calls `window.__TAURI__.core.invoke`, Tauri 2's
        // invoke surface, for the native `reload_window` and `open_devtools`
        // commands. When that surface is missing, the helper returns before
        // swallowing the Cmd+R / Cmd+Opt+I event.
        assert!(KEY_BRIDGE_JS.contains("window.__TAURI__"));
        assert!(KEY_BRIDGE_JS.contains("tauri.core.invoke"));
    }

    #[test]
    fn key_bridge_drops_chords_covered_by_pane_mode() {
        // Chords handled by the SPA keymap or Hybrid Nav stay out of the
        // native bridge so user assignments can replace their defaults.
        // The absences here catch accidental native interception.
        assert!(!KEY_BRIDGE_JS.contains("app.file.new"));
        assert!(!KEY_BRIDGE_JS.contains("Backquote"));
        assert!(!KEY_BRIDGE_JS.contains("app.settings.open"));
        assert!(!KEY_BRIDGE_JS.contains("app.search.toggle"));
        // File Browser, Graph, Team Work, and the broadcast toggle remain
        // command-only or Hybrid Nav driven.
        assert!(!KEY_BRIDGE_JS.contains("app.files.toggle"));
        assert!(!KEY_BRIDGE_JS.contains("app.graph.toggle"));
        assert!(!KEY_BRIDGE_JS.contains("app.terminal.teamWork"));
        assert!(!KEY_BRIDGE_JS.contains("app.terminal.broadcastToggle"));
    }

    #[test]
    fn key_bridge_keeps_independent_chords() {
        // Tab close + reopen + close window + Find on page + tab nav +
        // tab jump + splits are NOT duplicated by Hybrid Nav and must
        // stay reachable through the native bridge. The command-launcher
        // chords stay page-owned (the SPA's inline deck binds them on
        // every surface), so the bridge must never claim them; pin the
        // absence. New terminal is the context-aware spawn chord
        // (Cmd+T on macOS, Ctrl+Shift+T off-mac).
        assert!(!KEY_BRIDGE_JS.contains("open_command_launcher"));
        assert!(!KEY_BRIDGE_JS.contains("function commandLauncherChord"));
        assert!(KEY_BRIDGE_JS.contains("app.terminal.toggle"));
        assert!(KEY_BRIDGE_JS.contains("app.pane.prev"));
        assert!(KEY_BRIDGE_JS.contains("app.pane.next"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.close"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.reopenClosed"));
        assert!(KEY_BRIDGE_JS.contains("app.window.close"));
        assert!(KEY_BRIDGE_JS.contains("app.find.open"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.jump"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.next"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.prev"));
        assert!(KEY_BRIDGE_JS.contains("app.pane.splitRight"));
        assert!(KEY_BRIDGE_JS.contains("app.pane.splitDown"));
        // Cmd+I is reserved for the editor's italic chord, so the native
        // bridge must not map it to Dashboard. Pin the absence so a
        // regression that re-adds the case is caught.
        assert!(!KEY_BRIDGE_JS.contains("app.dashboard.open"));
    }

    #[test]
    fn key_bridge_alt_branch_lets_altgr_character_entry_through() {
        // Windows delivers an AltGr keydown with ctrlKey and altKey both
        // set, so on layouts where AltGr composes text (US-International
        // AltGr+W types 'å') the alt-branch chords would swallow
        // character entry, with Ctrl+Alt+W closing the window and
        // discarding its session with no confirmation. None of the
        // alt-branch chords can be legitimately formed with AltGr, so
        // the branch bails on AltGraph before any chord fires.
        let alt_branch = KEY_BRIDGE_JS
            .split("if (alt) {")
            .nth(1)
            .expect("alt branch exists")
            .split("// Zoom chords")
            .next()
            .expect("alt branch ends before the zoom chords");
        assert!(
            alt_branch.contains("if (e.ctrlKey && e.getModifierState('AltGraph')) return;"),
            "the alt branch must bail on AltGr without preventDefault",
        );
        let guard = alt_branch
            .find("e.getModifierState('AltGraph')")
            .expect("alt branch carries the AltGraph guard");
        let first_chord = alt_branch
            .find("code === 'KeyI'")
            .expect("alt branch handles the DevTools chord");
        assert!(
            guard < first_chord,
            "the AltGraph bail must precede every alt-branch chord",
        );
    }

    #[test]
    fn workspace_title_prefixes_house_glyph_then_path() {
        // Every local-disk workspace leads with the house glyph then the path
        // verbatim (the path is the disambiguating window-switcher signal),
        // regardless of where on disk it lives.
        assert_eq!(
            workspace_title("/home/hacker/dev/github.com/fiorix/chan"),
            format!("{ICON_LOCAL_HOME} /home/hacker/dev/github.com/fiorix/chan"),
        );
        // Outside $HOME still gets the house glyph. Trailing slash passed through.
        assert_eq!(
            workspace_title("/tmp/scratch/"),
            format!("{ICON_LOCAL_HOME} /tmp/scratch/"),
        );
    }

    // Watcher-opened webviews host the SPA, which
    // routes external http(s) link clicks through tauri-plugin-opener
    // via the `plugin:opener|open_url` IPC. Without these permissions
    // the IPC denies, the SPA falls back to the clipboard-copy notify
    // branch, and "click external link" looks like a no-op to the
    // user. Pin the capability
    // shape here so a future capability-file edit can't silently drop
    // the permissions without the test catching it.
    const WORKSPACE_CAPABILITY_JSON: &str = include_str!("../capabilities/workspace.json");
    const DEFAULT_CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");
    const LOCAL_DROP_CAPABILITY_JSON: &str = include_str!("../capabilities/local-drop.json");
    const LAUNCHER_EVENTS_CAPABILITY_JSON: &str =
        include_str!("../capabilities/launcher-events.json");
    const LAUNCHER_UPDATE_CAPABILITY_JSON: &str =
        include_str!("../capabilities/launcher-update.json");
    const LAUNCHER_CONTROL_CAPABILITY_JSON: &str =
        include_str!("../capabilities/launcher-control.json");
    const ABOUT_CAPABILITY_JSON: &str = include_str!("../capabilities/about.json");
    const LOCAL_UPLOAD_CAPABILITY_JSON: &str = include_str!("../capabilities/local-upload.json");
    const APP_PERMISSIONS_TOML: &str = include_str!("../permissions/app.toml");

    // The SPA side of the IPC bridge: api/desktop.ts is the single
    // tauriInvoke dispatch site (a workspace-app vitest pins that), and
    // editor/external_links.ts carries the one plugin invoke that rides
    // its own thin wrapper. The cross-tree include_str! deliberately ties
    // this crate's tests to the repo layout: the invoke vocabulary must be
    // the shipped SPA source, not a hand-copied list that rots.
    const WORKSPACE_APP_DESKTOP_TS: &str =
        include_str!("../../../web/packages/workspace-app/src/api/desktop.ts");
    const WORKSPACE_APP_EXTERNAL_LINKS_TS: &str =
        include_str!("../../../web/packages/workspace-app/src/editor/external_links.ts");
    /// The launcher SPA's own IPC dispatch site, included the same way and for
    /// the same reason: its invoke vocabulary must be the shipped source.
    const LAUNCHER_DESKTOP_TS: &str =
        include_str!("../../../web/packages/launcher/src/api/desktop.ts");

    fn capability_permissions(raw: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(raw).expect("capability JSON parses");
        v["permissions"]
            .as_array()
            .expect("permissions is an array")
            .iter()
            .map(|p| p.as_str().expect("permission is a string").to_string())
            .collect()
    }

    fn capability_windows(raw: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(raw).expect("capability JSON parses");
        v["windows"]
            .as_array()
            .expect("windows is an array")
            .iter()
            .map(|w| w.as_str().expect("window glob is a string").to_string())
            .collect()
    }

    fn capability_remote_urls(raw: &str) -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(raw).expect("capability JSON parses");
        let Some(urls) = v
            .get("remote")
            .and_then(|remote| remote.get("urls"))
            .and_then(serde_json::Value::as_array)
        else {
            return Vec::new();
        };
        urls.iter()
            .map(|u| {
                u.as_str()
                    .expect("remote URL pattern is a string")
                    .to_string()
            })
            .collect()
    }

    fn app_permission_set(id: &str) -> Vec<String> {
        let v: toml::Value = toml::from_str(APP_PERMISSIONS_TOML).expect("app permissions parse");
        v["set"]
            .as_array()
            .expect("permission sets is an array")
            .iter()
            .find(|set| set["identifier"].as_str() == Some(id))
            .unwrap_or_else(|| panic!("missing app permission set {id}"))["permissions"]
            .as_array()
            .expect("permission set entries are an array")
            .iter()
            .map(|p| p.as_str().expect("permission id is a string").to_string())
            .collect()
    }

    /// Every command a permission set grants, resolved through the
    /// `[[permission]]` blocks it references. Panics if the set names a
    /// permission identifier that has no block (also a parity failure).
    fn app_permission_set_commands(set_id: &str) -> Vec<String> {
        let v: toml::Value = toml::from_str(APP_PERMISSIONS_TOML).expect("app permissions parse");
        let blocks = v["permission"].as_array().expect("permission blocks");
        app_permission_set(set_id)
            .iter()
            .flat_map(|id| {
                let block = blocks
                    .iter()
                    .find(|p| p["identifier"].as_str() == Some(id))
                    .unwrap_or_else(|| panic!("set references missing permission {id}"));
                block["commands"]["allow"]
                    .as_array()
                    .expect("commands.allow is an array")
                    .iter()
                    .map(|c| c.as_str().expect("command is a string").to_string())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Command identifiers registered in `generate_handler![]`, module paths
    /// stripped (`devserver::gateway_csrf_token` -> `gateway_csrf_token`),
    /// comments and cfg attributes dropped.
    fn invoke_handler_commands(main_rs: &str) -> Vec<String> {
        let marker = "generate_handler![";
        let start = main_rs.find(marker).expect("generate_handler! present") + marker.len();
        // The macro closes with `])`; a bare `]` would match a comment's `[]`
        // (e.g. "returns [] off macOS") or a cfg attribute's `)]` first.
        let len = main_rs[start..]
            .find("])")
            .expect("generate_handler! closes");
        main_rs[start..start + len]
            .lines()
            .filter_map(|l| l.split("//").next())
            .collect::<Vec<_>>()
            .join("\n")
            .split(',')
            .map(|t| t.rsplit("::").next().unwrap_or(t).trim().to_string())
            .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .collect()
    }

    /// Every command any `[[permission]]` block grants (regardless of which
    /// set references it).
    fn all_granted_app_commands() -> Vec<String> {
        let v: toml::Value = toml::from_str(APP_PERMISSIONS_TOML).expect("app permissions parse");
        v["permission"]
            .as_array()
            .expect("permission blocks")
            .iter()
            .flat_map(|p| {
                p["commands"]["allow"]
                    .as_array()
                    .expect("commands.allow is an array")
                    .iter()
                    .map(|c| c.as_str().expect("command is a string").to_string())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn workspace_capability_grants_app_commands_and_opener() {
        let perms = capability_permissions(WORKSPACE_CAPABILITY_JSON);
        assert!(
            perms.iter().any(|p| p == "workspace-window"),
            "workspace capability must include workspace-window app commands: {perms:?}",
        );
        assert!(
            perms.iter().any(|p| p == "opener:allow-open-url"),
            "workspace capability must include opener:allow-open-url: {perms:?}",
        );
    }

    #[test]
    fn workspace_capability_covers_control_terminal_windows() {
        // A control terminal's window label is `control-terminal-<id>`
        // (`control_terminal_label`). Without this glob the control window has no
        // capability and Tauri denies every IPC from it, including the
        // request_close_window that rules (b)/(c) of the control-terminal dialog
        // (Cmd+W / the not-connected close button) route through. Pin the grant
        // so a glob rename can't silently strand the control window again.
        let windows = capability_windows(WORKSPACE_CAPABILITY_JSON);
        assert!(
            windows.iter().any(|w| w == "control-terminal-*"),
            "workspace capability must target control-terminal-* windows so the connect-script \
             window can request_close_window: {windows:?}",
        );
        let label = control_terminal_label("abc123");
        assert!(
            label.starts_with("control-terminal-"),
            "control terminal label must keep the control-terminal- prefix the glob matches: {label}",
        );
    }

    #[test]
    fn control_terminal_titles_do_not_use_window_number_suffix() {
        // A control terminal is a singleton per devserver, so its title is its
        // devserver-specific base verbatim: no " Window N", and no caption
        // either (the label route refuses to set one on a control row).
        assert_eq!(
            compose_window_title("Control Terminal - box", "control", 3, ""),
            "Control Terminal - box",
            "control windows should use their devserver-specific title verbatim",
        );
        assert_eq!(
            compose_window_title("Control Terminal - box", "control", 3, "ignored"),
            "Control Terminal - box",
        );
        const SERVE_RS: &str = include_str!("serve.rs");
        assert!(
            SERVE_RS.contains("Control Terminal -"),
            "control window titles should include the devserver label/address"
        );
    }

    #[test]
    fn close_requested_arm_prompts_a_buryable_window_and_real_closes_the_rest() {
        const SERVE_RS: &str = include_str!("serve.rs");
        // bury_window_now is the one bury body the two callers (the silent-hide
        // gesture, the SPA Hide callback) share.
        assert!(
            SERVE_RS.contains("pub(crate) fn bury_window_now("),
            "bury_window_now must exist for the silent-hide + Hide-callback paths",
        );
        // The host-to-webview confirm dispatch rides the chan:command bridge.
        assert!(
            SERVE_RS.contains("name: 'app.window.confirmClose'"),
            "the close-confirm eval must dispatch app.window.confirmClose",
        );
        // Isolate on_close_requested, the body of the CloseRequested arm. The
        // slice runs from its signature line to its closing brace at column 0,
        // so it covers that one function and the scoped absence check never
        // self-matches this test module. Both bounds must be found: a missing
        // end would otherwise stretch the slice to the end of the file.
        let (_, rest) = SERVE_RS
            .split_once("\nfn on_close_requested(")
            .expect("on_close_requested exists");
        let (arm, _) = rest
            .split_once("\n}\n")
            .expect("on_close_requested ends at a column-0 brace");
        // The arm must not bury and then show a hidden-window notice: the
        // close-confirm prompt asks before anything is hidden.
        assert!(
            !arm.contains("show_bury_notice"),
            "the CloseRequested arm must not call the removed hidden-window notice",
        );
        // An explicit hide gesture still buries directly, no prompt -- but only
        // after the active-transfer guards run (read the flag, act later).
        assert!(arm.contains("let silent_hide = state.take_silent_hide(label);"));
        assert!(arm.contains("if silent_hide {"));
        assert!(arm.contains("bury_window_now("));
        // The silent-hide bury must HOLD the close before burying. A connected
        // control terminal buries via window.hide(), and an
        // un-prevented close destroys the webview right after the handler
        // returns, leaving the launcher eye pointing at a missing window.
        assert!(
            arm.contains("if silent_hide {\n        api.prevent_close();"),
            "the silent-hide branch must prevent_close before bury_window_now",
        );
        // A live SPA is HELD (prevent_close) and ASKED via the confirm eval;
        // nothing buries here until the SPA calls back.
        assert!(arm.contains("api.prevent_close();"));
        assert!(arm.contains("window.eval(CONFIRM_CLOSE_DISPATCH_JS)"));
        let raise = arm
            .find("window.show()")
            .expect("the prompt owner is raised");
        let focus = arm
            .find("window.set_focus()")
            .expect("the prompt owner is focused");
        let eval = arm
            .find("window.eval(CONFIRM_CLOSE_DISPATCH_JS)")
            .expect("the close prompt is evaluated");
        assert!(raise < focus && focus < eval);
        // The real-close cases (control terminal still connecting and pre-SPA
        // connecting screen) return WITHOUT prevent_close.
        assert!(arm.contains("if !ask {"));
        assert!(arm.contains("strip_prefix(\"control-terminal-\")"));
        assert!(arm.contains("window_on_connecting_screen"));
        // A kept-dead control terminal's red button routes through the same
        // explicit-close cleanup as Cmd+W / the SPA Close, clearing the
        // reconnect block instead of stranding it on a destroyed window.
        assert!(arm.contains("control_terminal_dead"));
        assert!(arm.contains("close_devserver_control_terminal"));
    }

    #[test]
    fn destroyed_window_drops_its_generated_downloads() {
        const SERVE_RS: &str = include_str!("serve.rs");
        // on_destroyed is the body of the Destroyed arm; the slice runs from
        // its signature line to its closing brace at column 0.
        let (_, rest) = SERVE_RS
            .split_once("\nfn on_destroyed(")
            .expect("on_destroyed exists");
        let (arm, _) = rest
            .split_once("\n}\n")
            .expect("on_destroyed ends at a column-0 brace");
        assert!(arm.contains("drop_generated_downloads_for_window("));
    }

    #[test]
    fn the_window_event_closure_only_delegates_to_its_handlers() {
        // The closure build_workspace_window_with_completion registers on each
        // window is a dispatch table: the CloseRequested arm is one call into
        // on_close_requested and the Destroyed arm one call into on_destroyed,
        // so the close and destroy behaviour lives entirely in the two
        // functions the other pins slice. An arm that grew a body of its own
        // would sit outside them.
        const SERVE_RS: &str = include_str!("serve.rs");
        let (_, rest) = SERVE_RS
            .split_once("\nfn build_workspace_window_with_completion(")
            .expect("build_workspace_window_with_completion exists");
        let (build, _) = rest
            .split_once("\n}\n")
            .expect("build_workspace_window_with_completion ends at a column-0 brace");
        let (_, rest) = build
            .split_once("window.on_window_event(move |event| match event {")
            .expect("the build function registers the window-event closure");
        let (closure, _) = rest
            .split_once("_ => {}")
            .expect("the closure ends with the fallback arm");
        assert!(closure.contains("WindowEvent::CloseRequested { api, .. } =>"));
        assert!(closure.contains("on_close_requested("));
        assert!(closure.contains("WindowEvent::Destroyed =>"));
        assert!(closure.contains("on_destroyed("));
        for inlined in ["take_silent_hide", "prevent_close", "release_window_number"] {
            assert!(
                !closure.contains(inlined),
                "the window-event closure must delegate, not carry {inlined} itself",
            );
        }
    }

    #[test]
    fn workspace_capability_covers_watcher_opened_local_windows() {
        // Watcher-opened local windows carry the composite native label
        // `local::<window_id>` (`window_watcher::native_label`), which matches
        // no other current label glob, so without `local::*` a minted window gets
        // no capability and Tauri denies every
        // SPA IPC (the command bridge, opener, drag). Pin the grant so a glob
        // change can't silently strand minted windows.
        let windows = capability_windows(WORKSPACE_CAPABILITY_JSON);
        assert!(
            windows.iter().any(|w| w == "local::*"),
            "workspace capability must target local::* watcher-opened windows: {windows:?}",
        );
    }

    #[test]
    fn workspace_capability_covers_loopback_server_urls() {
        // Workspace windows load chan-server through loopback HTTP
        // origins. Without a remote URL match, Tauri omits the IPC
        // bridge and workspace-window app commands such as reload_window
        // or the zoom chords never reach Rust.
        let remote_urls = capability_remote_urls(WORKSPACE_CAPABILITY_JSON);
        assert!(
            remote_urls.iter().any(|u| u == "http://127.0.0.1:*"),
            "workspace capability must include 127.0.0.1 loopback: {remote_urls:?}",
        );
        assert!(
            remote_urls.iter().any(|u| u == "http://localhost:*"),
            "workspace capability must include localhost loopback: {remote_urls:?}",
        );
    }

    #[test]
    fn local_upload_capability_covers_every_locally_served_window_kind() {
        // cs upload runs wherever a terminal runs: connect-script control
        // terminals and watcher-opened windows (local:: and lib-*). A kind
        // missing from this list silently loses the native picker.
        let windows = capability_windows(LOCAL_UPLOAD_CAPABILITY_JSON);
        for expected in ["control-terminal-*", "local::*", "lib-*"] {
            assert!(
                windows.iter().any(|w| w == expected),
                "local-upload capability must cover {expected} windows: {windows:?}",
            );
        }
    }

    #[test]
    fn app_acl_allows_workspace_window_commands() {
        let workspace_set = app_permission_set("workspace-window");
        for expected in [
            "allow-reload-window",
            "allow-open-devtools",
            "allow-zoom-in",
            "allow-zoom-out",
            "allow-zoom-reset",
            // The connecting screen for remote devserver windows probes the remote
            // through this command; without the ACL grant the IPC denies and
            // the screen never detects a reachable remote.
            "allow-probe-url",
            // `cs tunnel` reaches the desktop through the SPA of a
            // devserver-served window; the grant rides this shared set so
            // loopback and gateway lib windows both carry it.
            "allow-open-reverse-tunnel",
        ] {
            assert!(
                workspace_set.iter().any(|p| p == expected),
                "workspace-window app permission set must include {expected}: {workspace_set:?}",
            );
        }
    }

    // Tauri's ACL denies any `generate_handler!` command that no granted
    // permission allows. The gate and the mock smoke both bypass the ACL (unit
    // tests call the Rust fns directly; a mocked Tauri has no ACL), so a
    // registered-but-ungranted command only fails in the real app. These two
    // tests pin the command/ACL parity so drift reds the gate instead.

    #[test]
    fn app_acl_grants_every_registered_command() {
        // Complete coverage: every command in generate_handler! must have an
        // explicit app permission block. Capability-set and origin parity are
        // checked separately below. This catches an overlay-only command just
        // as reliably as a workspace command without pretending both belong in
        // the broad main-window/workspace-window sets.
        const MAIN_RS: &str = include_str!("main.rs");
        let granted: std::collections::HashSet<String> =
            all_granted_app_commands().into_iter().collect();
        for command in invoke_handler_commands(MAIN_RS) {
            assert!(
                granted.contains(&command),
                "`{command}` is in generate_handler! but granted by no permission set or capability; \
                 the launcher or workspace SPA invokes it and Tauri denies it at runtime",
            );
        }
    }

    #[test]
    fn app_acl_has_no_stale_grants() {
        // Reverse parity: every command app.toml grants must still exist in
        // generate_handler!, so a removed command's grant doesn't linger.
        const MAIN_RS: &str = include_str!("main.rs");
        let registered: std::collections::HashSet<String> =
            invoke_handler_commands(MAIN_RS).into_iter().collect();
        for command in all_granted_app_commands() {
            assert!(
                registered.contains(&command),
                "permissions/app.toml grants `{command}` but it is not in generate_handler! (a stale \
                 grant; remove its permission)",
            );
        }
    }

    #[test]
    fn invoke_handler_registers_read_dropped_paths() {
        // The SPA's terminal drop handler invokes `read_dropped_paths`
        // at DOM drop time; it must be in `tauri::generate_handler!`
        // or the IPC denies and the terminal path-print silently
        // no-ops. generate_handler! doesn't catch missing entries at
        // compile time, so pin it here.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("dropped_paths::read_dropped_paths,"));
        const DROPPED_PATHS_RS: &str = include_str!("dropped_paths.rs");
        assert!(DROPPED_PATHS_RS.contains("pub async fn read_dropped_paths("));
        // NSPasteboard is AppKit state: the read must run on the main
        // thread, not the IPC worker thread.
        assert!(DROPPED_PATHS_RS.contains("run_on_main_thread"));
    }

    #[test]
    fn drag_pasteboard_read_is_scoped_to_locally_served_windows() {
        // The macOS drag pasteboard is system-wide and persists after
        // the drag ends: a devserver-served `lib-*` SPA, whether loopback or
        // gateway, must
        // NOT be able to poll `read_dropped_paths` and harvest paths the
        // user drags around in other applications.
        // The grant therefore lives in its own capability targeting
        // only the locally-served window kinds...
        let windows = capability_windows(LOCAL_DROP_CAPABILITY_JSON);
        assert!(windows.iter().any(|w| w == "local::*"));
        assert!(
            windows.iter().all(|w| w != "lib-*" && w != "main"),
            "local-drop capability must stay off devserver-served and launcher windows: {windows:?}",
        );
        let perms = capability_permissions(LOCAL_DROP_CAPABILITY_JSON);
        assert!(
            perms.iter().any(|p| p == "allow-read-dropped-paths"),
            "local-drop capability must grant allow-read-dropped-paths: {perms:?}",
        );
        // ...and must not leak in through the workspace command set that
        // gateway-served windows receive through their runtime capability.
        let workspace_perms = capability_permissions(WORKSPACE_CAPABILITY_JSON);
        assert!(
            workspace_perms
                .iter()
                .all(|p| p != "allow-read-dropped-paths"),
            "workspace capability must not carry the drag-pasteboard grant: {workspace_perms:?}",
        );
        let workspace_set = app_permission_set("workspace-window");
        assert!(
            workspace_set.iter().all(|p| p != "allow-read-dropped-paths"),
            "workspace-window permission set must not carry the drag-pasteboard grant: {workspace_set:?}",
        );
        // Belt symmetry: the launcher (default capability) is
        // remote-served from the embedded loopback but has no drop
        // surface -- pin the grant off it too so it can't drift in
        // through the third broad capability.
        let default_perms = capability_permissions(DEFAULT_CAPABILITY_JSON);
        assert!(
            default_perms.iter().all(|p| p != "allow-read-dropped-paths"),
            "launcher default capability must not carry the drag-pasteboard grant: {default_perms:?}",
        );
        let main_set = app_permission_set("main-window");
        assert!(
            main_set.iter().all(|p| p != "allow-read-dropped-paths"),
            "main-window permission set must not carry the drag-pasteboard grant: {main_set:?}",
        );
    }

    #[test]
    fn connecting_screen_windows_close_for_real() {
        // A window still on connecting.html must be closable. A devserver
        // window's red button routes through request_close_window so its remote
        // record becomes a pending delete, while the page offers the same path
        // from Cmd/Ctrl+W, Ctrl+D, and Disconnect.
        const SERVE_RS: &str = include_str!("serve.rs");
        let (_, rest) = SERVE_RS
            .split_once("\nfn on_close_requested(")
            .expect("on_close_requested exists");
        let (close_arm, _) = rest
            .split_once("\n}\n")
            .expect("on_close_requested ends at a column-0 brace");
        assert!(close_arm.contains("if on_connecting && label.starts_with(\"lib-\")"));
        assert!(close_arm.contains("crate::request_close_window(app, window)"));
        // KEY_BRIDGE_JS claims the close chord (window capture +
        // stopImmediatePropagation) before BOTH the page's listener and
        // the File-menu accelerator, so the bridge itself must route
        // KeyW to request_close_window while on connecting.html -- a
        // page-level chord alone never sees the key (dead Cmd+W).
        // THREE routings: macOS plain Cmd+W (!shift branch), the
        // Linux/Windows Ctrl+Shift+W (shift branch), and the
        // Linux/Windows Ctrl+Alt+W window close (alt branch).
        let close_invoke = concat!("invokeIpc(e, 'request_close", "_window')");
        assert_eq!(SERVE_RS.matches(close_invoke).count(), 3);
        assert!(SERVE_RS.contains("location.pathname.endsWith('/connecting.html')"));
        const CONNECTING_JS: &str = include_str!("../../src/connecting.js");
        assert!(CONNECTING_JS.contains("request_close_window"));
        assert!(CONNECTING_JS.contains("key === 'd'"));
        assert!(CONNECTING_JS.contains("key === 'w'"));
    }

    #[test]
    fn default_capability_covers_extra_launcher_windows() {
        // The default capability covers `main-*` alongside the
        // singleton `main`: any launcher-class window must inherit
        // the same capability as `main`, or external link handling
        // and other plugin IPCs break the moment one exists.
        let windows = capability_windows(DEFAULT_CAPABILITY_JSON);
        assert!(
            windows.iter().any(|w| w == "main"),
            "default capability must still target main: {windows:?}",
        );
        assert!(
            windows.iter().any(|w| w == "main-*"),
            "default capability must target additional main-N launchers: {windows:?}",
        );
        let perms = capability_permissions(DEFAULT_CAPABILITY_JSON);
        assert!(
            perms.iter().any(|p| p == "main-window"),
            "default capability must include main-window app commands: {perms:?}",
        );
        assert!(
            perms.iter().any(|p| p == "opener:allow-open-url"),
            "default capability must include opener:allow-open-url: {perms:?}",
        );
        assert!(
            perms.iter().all(|p| !p.starts_with("process:")),
            "default capability must not grant broad process plugin permissions: {perms:?}",
        );
    }

    #[test]
    fn launcher_event_capability_grants_listen_to_remote_served_launcher() {
        // The launcher SPA is REMOTELY served from the embedded
        // chan-server loopback (the main window loads `WebviewUrl::External
        // http://127.0.0.1:<port>/`). A Tauri capability reaches remotely-loaded
        // content only when it declares `remote.urls`; default.json has none, so
        // its `core:default` (which DOES carry `core:event:default`) never reached
        // the launcher and `onTauriEvent('devserver-control-attention', …)` was denied
        // with `plugin:event|listen not allowed by ACL`. The dedicated
        // launcher-events capability restores the listen/unlisten grant on the
        // remote launcher windows -- pin it so a capability refactor can't silently
        // re-break the devserver control-attention signal.
        let windows = capability_windows(LAUNCHER_EVENTS_CAPABILITY_JSON);
        assert!(
            windows.iter().any(|w| w == "main"),
            "launcher-events capability must target the main launcher window: {windows:?}",
        );
        assert!(
            windows.iter().any(|w| w == "main-*"),
            "launcher-events capability must target additional main-N launchers: {windows:?}",
        );
        // It MUST be remote-scoped, or the grant is inert against the loopback-served
        // launcher (the whole reason the listener was dead).
        let remote_urls = capability_remote_urls(LAUNCHER_EVENTS_CAPABILITY_JSON);
        assert!(
            remote_urls.iter().any(|u| u == "http://127.0.0.1:*"),
            "launcher-events must cover the loopback origin the launcher is served from: {remote_urls:?}",
        );
        let perms = capability_permissions(LAUNCHER_EVENTS_CAPABILITY_JSON);
        assert!(
            perms.iter().any(|p| p == "core:event:default"),
            "launcher-events must grant the core event listen/unlisten ACL: {perms:?}",
        );
        // Least privilege: it carries ONLY the event grant. The launcher is pure
        // HTTP otherwise, so the powerful local-only default.json grants (updater,
        // process restart, dialog) must NOT leak onto remote content through here.
        assert_eq!(
            perms.len(),
            1,
            "launcher-events must stay scoped to the event grant only: {perms:?}",
        );
        for forbidden in [
            "process:allow-restart",
            "updater:allow-download-and-install",
            "dialog:allow-open",
        ] {
            assert!(
                perms.iter().all(|p| p != forbidden),
                "launcher-events must not broaden {forbidden} onto remote content: {perms:?}",
            );
        }
    }

    #[test]
    fn launcher_update_capability_grants_only_restart_update_command_to_remote_launcher() {
        let windows = capability_windows(LAUNCHER_UPDATE_CAPABILITY_JSON);
        assert!(
            windows.iter().any(|w| w == "main"),
            "launcher-update capability must target main: {windows:?}",
        );
        assert!(
            windows.iter().any(|w| w == "main-*"),
            "launcher-update capability must target additional launchers: {windows:?}",
        );
        let remote_urls = capability_remote_urls(LAUNCHER_UPDATE_CAPABILITY_JSON);
        assert!(
            remote_urls.iter().any(|u| u == "http://127.0.0.1:*"),
            "launcher-update must cover the loopback launcher origin: {remote_urls:?}",
        );
        let perms = capability_permissions(LAUNCHER_UPDATE_CAPABILITY_JSON);
        assert_eq!(
            perms,
            vec!["allow-restart-desktop-after-update".to_string()],
            "launcher-update must grant only the narrow restart command: {perms:?}",
        );
        let permissions = APP_PERMISSIONS_TOML;
        assert!(permissions.contains("identifier = \"allow-restart-desktop-after-update\""));
        assert!(permissions.contains("commands.allow = [\"restart_desktop_after_update\"]"));
    }

    #[test]
    fn launcher_control_capability_is_narrow() {
        let windows = capability_windows(LAUNCHER_CONTROL_CAPABILITY_JSON);
        assert_eq!(windows, vec!["main".to_string(), "main-*".to_string()]);
        let remote_urls = capability_remote_urls(LAUNCHER_CONTROL_CAPABILITY_JSON);
        assert!(remote_urls.iter().any(|url| url == "http://127.0.0.1:*"));
        assert_eq!(
            capability_permissions(LAUNCHER_CONTROL_CAPABILITY_JSON),
            vec!["allow-request-app-quit".to_string()],
        );
    }

    // ---- origin-aware ACL parity ------------------------------------
    //
    // Tauri resolves a window's effective grants from BOTH its label
    // (capability `windows` globs) and the origin its content loaded from
    // (`remote.urls`): a capability with no matching remote pattern never
    // reaches remotely-served content, and every chan window is remotely
    // served (the loopback embedded server included). The ACL itself only
    // exists in the shipped app -- unit tests call the Rust fns directly
    // and a mocked webview has no ACL -- so vocabulary/grant drift shows
    // up as runtime denials unless these tests recompute the per-class
    // grants from the capability files and pin the SPA's invoke
    // vocabulary as a subset.

    /// Every capability file, by name. `capability_walk_covers_every_capability_file`
    /// pins this table against the directory listing so a new capability
    /// cannot land without joining the origin-aware walk.
    const CAPABILITY_FILES: [(&str, &str); 8] = [
        ("about.json", ABOUT_CAPABILITY_JSON),
        ("default.json", DEFAULT_CAPABILITY_JSON),
        ("launcher-events.json", LAUNCHER_EVENTS_CAPABILITY_JSON),
        ("launcher-control.json", LAUNCHER_CONTROL_CAPABILITY_JSON),
        ("launcher-update.json", LAUNCHER_UPDATE_CAPABILITY_JSON),
        ("local-drop.json", LOCAL_DROP_CAPABILITY_JSON),
        ("local-upload.json", LOCAL_UPLOAD_CAPABILITY_JSON),
        ("workspace.json", WORKSPACE_CAPABILITY_JSON),
    ];

    /// The window/origin classes the desktop actually opens for workspace
    /// SPA content. Labels mirror the library minting scheme; origins are the
    /// loopback embedded server and the gateway tunnel entry URL
    /// (`window_navigation_url`).
    const ORIGIN_CLASSES: [(&str, &str, &str); 4] = [
        (
            "loopback local window",
            "local::w-1",
            "http://127.0.0.1:4090",
        ),
        (
            "loopback lib window",
            "lib-0a1b::w-1",
            "http://127.0.0.1:4090",
        ),
        (
            "official exact-origin lib window",
            "lib-0a1b::w-1",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
        ),
        (
            "custom exact-origin lib window",
            "lib-0a1b::w-1",
            "https://ws1.proxy.gw-test.example",
        ),
    ];

    /// (class, invoke) pairs the ACL withholds ON PURPOSE. Every entry is
    /// enforced in both directions: the invoke must stay in the SPA
    /// vocabulary-checked set, and if a capability ever grants an excluded
    /// pair the parity test fails, so this table cannot go stale.
    ///
    /// read_dropped_paths: the macOS drag pasteboard is system-wide and
    /// outlives the drag, so the command stays off lib-* windows on EVERY
    /// origin -- local-drop.json's windows list deliberately has no lib-*.
    ///
    /// gateway_csrf_token: only exact-origin gateway lib-* windows receive
    /// the runtime grant. The loopback classes run the same SPA but stay
    /// ungranted, and the handler's label, origin, and live-connection checks
    /// independently refuse callers outside that gateway binding.
    const DELIBERATE_EXCLUSIONS: [(&str, &str); 5] = [
        ("loopback local window", "gateway_csrf_token"),
        ("loopback lib window", "gateway_csrf_token"),
        ("loopback lib window", "read_dropped_paths"),
        ("official exact-origin lib window", "read_dropped_paths"),
        ("custom exact-origin lib window", "read_dropped_paths"),
    ];

    /// Minimal window-label glob: `*` matches any run of characters
    /// (labels never contain `/`, so this agrees with Tauri for every
    /// glob in capabilities/); no `*` means exact match.
    fn label_glob_matches(pattern: &str, text: &str) -> bool {
        let mut pieces = pattern.split('*');
        let first = pieces.next().expect("split yields at least one piece");
        let Some(mut rest) = text.strip_prefix(first) else {
            return false;
        };
        let mut middle: Vec<&str> = pieces.collect();
        let Some(last) = middle.pop() else {
            return rest.is_empty();
        };
        for piece in middle {
            if piece.is_empty() {
                continue;
            }
            match rest.find(piece) {
                Some(at) => rest = &rest[at + piece.len()..],
                None => return false,
            }
        }
        rest.ends_with(last)
    }

    /// Minimal remote-URL pattern match for the origins these tests use:
    /// exact scheme, glob host, glob port (a pattern without a port only
    /// matches an origin without one, which is how the tunnel origin's
    /// default https port reads). Not a general URLPattern engine.
    fn remote_url_matches(pattern: &str, origin: &str) -> bool {
        fn parts(url: &str) -> Option<(&str, &str, Option<&str>)> {
            let (scheme, rest) = url.split_once("://")?;
            Some(match rest.split_once(':') {
                Some((host, port)) => (scheme, host, Some(port)),
                None => (scheme, rest, None),
            })
        }
        let Some((pattern_scheme, pattern_host, pattern_port)) = parts(pattern) else {
            return false;
        };
        let Some((origin_scheme, origin_host, origin_port)) = parts(origin) else {
            return false;
        };
        if pattern_scheme != origin_scheme || !label_glob_matches(pattern_host, origin_host) {
            return false;
        }
        match (pattern_port, origin_port) {
            (None, None) => true,
            (Some(port_pattern), Some(port)) => label_glob_matches(port_pattern, port),
            _ => false,
        }
    }

    /// Every `tauriInvoke(` command literal in a SPA module. Tolerates a
    /// generic parameter list (`tauriInvoke<T>(`) and multi-line calls
    /// whose command literal sits on the line after the open paren; call
    /// sites without a leading string literal (the wrapper's own
    /// declaration, template-literal error strings) are skipped.
    fn tauri_invoke_commands(source: &str) -> Vec<String> {
        let mut commands = Vec::new();
        for (idx, _) in source.match_indices("tauriInvoke") {
            let rest = &source[idx + "tauriInvoke".len()..];
            let rest = match rest.strip_prefix('<') {
                Some(generics) => match generics.find(">(") {
                    Some(close) => &generics[close + 1..],
                    None => continue,
                },
                None => rest,
            };
            let Some(args) = rest.strip_prefix('(') else {
                continue;
            };
            let Some(quoted) = args.trim_start().strip_prefix('"') else {
                continue;
            };
            let Some(end) = quoted.find('"') else {
                continue;
            };
            commands.push(quoted[..end].to_string());
        }
        commands
    }

    /// Plugin invokes fired through a module's own thin invoke wrapper
    /// (editor/external_links.ts): `invoke("plugin:...")` literals.
    fn plugin_invoke_commands(source: &str) -> Vec<String> {
        source
            .match_indices("invoke(\"plugin:")
            .map(|(idx, _)| {
                let quoted = &source[idx + "invoke(\"".len()..];
                let end = quoted.find('"').expect("plugin invoke literal closes");
                quoted[..end].to_string()
            })
            .collect()
    }

    /// Commands KEY_BRIDGE_JS fires from inside every desktop-opened
    /// window. The chord bridge is an initialization script, so it runs on
    /// tunnel origins too and its invokes face the same origin-aware ACL
    /// as the SPA's. Parses only the KEY_BRIDGE_JS raw-string body: other
    /// tests mention the invoke pattern inside assertion strings, and
    /// scanning the whole file would collect those as garbage commands.
    fn key_bridge_invoke_commands(serve_rs: &str) -> Vec<String> {
        // concat! so the markers never match this function's own source.
        let marker = concat!("const KEY_BRIDGE", "_JS: &str = r#\"");
        let start = serve_rs.find(marker).expect("KEY_BRIDGE_JS const present") + marker.len();
        let body = &serve_rs[start..];
        let body = &body[..body.find("\"#").expect("KEY_BRIDGE_JS raw string closes")];
        let needle = concat!("invokeIpc", "(e, '");
        body.match_indices(needle)
            .map(|(idx, _)| {
                let quoted = &body[idx + needle.len()..];
                let end = quoted.find('\'').expect("invokeIpc literal closes");
                quoted[..end].to_string()
            })
            .collect()
    }

    /// Permission identifiers that grant a given plugin-channel invoke.
    /// app.toml expansion cannot resolve these (they are Tauri core/plugin
    /// permissions, not app commands), so the mapping is explicit; the
    /// parity test fails on any unmapped plugin invoke, so a new plugin
    /// call site cannot bypass the walk.
    fn plugin_permission_candidates(invoke: &str) -> Option<&'static [&'static str]> {
        match invoke {
            "plugin:window|set_fullscreen" => Some(&["core:window:allow-set-fullscreen"]),
            // opener:default alone does not name open_url; every capability
            // in this tree that means to grant it carries the explicit
            // allow-open-url, so that is the identifier the walk requires.
            "plugin:opener|open_url" => Some(&["opener:allow-open-url"]),
            _ => None,
        }
    }

    /// How one capability `permissions` entry lands at the ACL: app.toml
    /// set names and `[[permission]]` identifiers expand to app command
    /// names; anything else is a Tauri core/plugin permission string that
    /// gates plugin invokes rather than app commands.
    enum GrantExpansion {
        AppCommands(Vec<String>),
        PluginPermission(String),
    }

    fn expand_capability_permission(id: &str) -> GrantExpansion {
        let v: toml::Value = toml::from_str(APP_PERMISSIONS_TOML).expect("app permissions parse");
        let is_set = v["set"]
            .as_array()
            .expect("permission sets is an array")
            .iter()
            .any(|s| s["identifier"].as_str() == Some(id));
        if is_set {
            return GrantExpansion::AppCommands(app_permission_set_commands(id));
        }
        let block_commands = v["permission"]
            .as_array()
            .expect("permission blocks")
            .iter()
            .find(|p| p["identifier"].as_str() == Some(id))
            .map(|p| {
                p["commands"]["allow"]
                    .as_array()
                    .expect("commands.allow is an array")
                    .iter()
                    .map(|c| c.as_str().expect("command is a string").to_string())
                    .collect::<Vec<_>>()
            });
        match block_commands {
            Some(commands) => GrantExpansion::AppCommands(commands),
            None => GrantExpansion::PluginPermission(id.to_string()),
        }
    }

    /// Runtime-minted capabilities, produced by the SAME builders the
    /// desktop hands to add_capability, so the walk recomputes exactly
    /// what ships. NEVER files in capabilities/: the dir-pin test keeps
    /// CAPABILITY_FILES pinned to the directory on purpose, and a runtime
    /// capability landing there would get baked statically by tauri_build
    /// too. The origin mirrors ORIGIN_CLASSES' gateway class.
    fn runtime_capabilities() -> Vec<String> {
        [
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://ws1.proxy.gw-test.example",
        ]
        .into_iter()
        .map(|origin| {
            crate::runtime_capability::exact_origin_capability_json(origin)
                .expect("exact gateway origin parses")
        })
        .collect()
    }

    /// The app commands + plugin permissions a window with this label,
    /// serving content from this origin, can actually reach - through the
    /// static capability files AND the runtime-minted set.
    fn effective_grants(
        label: &str,
        origin: &str,
    ) -> (
        std::collections::HashSet<String>,
        std::collections::HashSet<String>,
    ) {
        let mut app_commands = std::collections::HashSet::new();
        let mut plugin_permissions = std::collections::HashSet::new();
        let mut raws: Vec<String> = CAPABILITY_FILES
            .iter()
            .map(|(_, raw)| raw.to_string())
            .collect();
        raws.extend(runtime_capabilities());
        for raw in &raws {
            let cap: serde_json::Value = serde_json::from_str(raw).expect("capability JSON parses");
            let windows_match = cap["windows"]
                .as_array()
                .expect("windows is an array")
                .iter()
                .any(|w| label_glob_matches(w.as_str().expect("window glob is a string"), label));
            if !windows_match {
                continue;
            }
            // No remote.urls means the capability never reaches
            // remotely-served content, which is every class here.
            let Some(urls) = cap["remote"]["urls"].as_array() else {
                continue;
            };
            if !urls.iter().any(|u| {
                remote_url_matches(u.as_str().expect("remote URL pattern is a string"), origin)
            }) {
                continue;
            }
            for p in cap["permissions"]
                .as_array()
                .expect("permissions is an array")
            {
                match expand_capability_permission(p.as_str().expect("permission is a string")) {
                    GrantExpansion::AppCommands(commands) => app_commands.extend(commands),
                    GrantExpansion::PluginPermission(id) => {
                        plugin_permissions.insert(id);
                    }
                }
            }
        }
        (app_commands, plugin_permissions)
    }

    #[test]
    fn capability_walk_covers_every_capability_file() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .expect("capabilities dir reads")
            .map(|e| {
                e.expect("dir entry reads")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|n| n.ends_with(".json"))
            .collect();
        on_disk.sort();
        let mut in_table: Vec<String> = CAPABILITY_FILES
            .iter()
            .map(|(name, _)| name.to_string())
            .collect();
        in_table.sort();
        assert_eq!(
            in_table, on_disk,
            "CAPABILITY_FILES must list exactly the files in capabilities/ so the \
             origin-aware ACL walk cannot silently skip a capability",
        );
    }

    #[test]
    fn no_static_or_runtime_capability_grants_a_gateway_wildcard() {
        for (name, raw) in CAPABILITY_FILES {
            for url in capability_remote_urls(raw) {
                assert!(
                    !url.contains("*.chan.app"),
                    "static capability {name} carries a chan.app wildcard: {url}"
                );
            }
        }
        for raw in runtime_capabilities() {
            let urls = capability_remote_urls(&raw);
            assert_eq!(urls.len(), 1, "each runtime grant has one exact origin");
            assert!(
                !urls[0].contains('*'),
                "runtime capability carries a discovery-apex wildcard: {}",
                urls[0]
            );
        }
    }

    #[test]
    fn label_glob_and_remote_url_matchers_cover_the_capability_patterns() {
        assert!(label_glob_matches("lib-*", "lib-0a1b::w-1"));
        assert!(!label_glob_matches("lib-*", "library"));
        assert!(label_glob_matches("local::*", "local::w-1"));
        assert!(label_glob_matches("main-*", "main-2"));
        assert!(!label_glob_matches("main", "main-2"));
        assert!(remote_url_matches(
            "http://127.0.0.1:*",
            "http://127.0.0.1:4090"
        ));
        assert!(!remote_url_matches(
            "http://127.0.0.1:*",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app"
        ));
        assert!(remote_url_matches(
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app"
        ));
        assert!(!remote_url_matches(
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://bob--1a2b3c4d5e6f.p1.proxy.chan.app"
        ));
        assert!(!remote_url_matches(
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://p1.proxy.chan.app"
        ));
        assert!(!remote_url_matches(
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://evil.example.com"
        ));
    }

    /// The advertisement must equal the gateway grant recomputed from the
    /// capability sources: a page suppresses an affordance because the host
    /// did not advertise the command, so drift in either direction turns
    /// into a wrong version statement on a live page.
    #[test]
    fn native_vocabulary_advertises_the_gateway_window_grant() {
        let (granted, _) = effective_grants(
            "lib-0a1b::w-1",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
        );
        let granted: std::collections::BTreeSet<&str> =
            granted.iter().map(String::as_str).collect();
        let advertised: std::collections::BTreeSet<&str> =
            crate::runtime_capability::GATEWAY_WINDOW_COMMANDS
                .iter()
                .copied()
                .collect();
        assert_eq!(
            advertised, granted,
            "GATEWAY_WINDOW_COMMANDS must match the recomputed gateway-window grant",
        );
    }

    /// The real regression proof for item-1-class breakage: for every
    /// window/origin class, every command the SPA can invoke must be
    /// granted by some capability, minus the DELIBERATE_EXCLUSIONS.
    #[test]
    fn origin_aware_acl_grants_spa_invoke_vocabulary_per_window_class() {
        let mut vocabulary: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        vocabulary.extend(tauri_invoke_commands(WORKSPACE_APP_DESKTOP_TS));
        vocabulary.extend(plugin_invoke_commands(WORKSPACE_APP_EXTERNAL_LINKS_TS));
        const SERVE_RS: &str = include_str!("serve.rs");
        vocabulary.extend(key_bridge_invoke_commands(SERVE_RS));

        // Parser honesty: the hard forms must have parsed (the generic and
        // multi-line native transfer calls, both plugin channels, a
        // KEY_BRIDGE chord). If any is missing the subset assertion below
        // is hollow, so fail here first.
        for expected in [
            "download_file_native",
            "upload_files_native",
            "native_transfer_status",
            "read_clipboard_text",
            "read_dropped_paths",
            "plugin:window|set_fullscreen",
            "plugin:opener|open_url",
            "zoom_in",
        ] {
            assert!(
                vocabulary.contains(expected),
                "invoke-vocabulary parser lost `{expected}`; fix the parser before trusting \
                 this test",
            );
        }

        // Every app command in the vocabulary must be a registered
        // handler: catches both parser garbage and SPA calls to commands
        // the desktop does not ship.
        const MAIN_RS: &str = include_str!("main.rs");
        let registered: std::collections::HashSet<String> =
            invoke_handler_commands(MAIN_RS).into_iter().collect();
        for command in vocabulary.iter().filter(|c| !c.starts_with("plugin:")) {
            assert!(
                registered.contains(command),
                "SPA invokes `{command}` but generate_handler! does not register it",
            );
        }

        let mut violations: Vec<String> = Vec::new();
        for (class, label, origin) in ORIGIN_CLASSES {
            let (app_commands, plugin_permissions) = effective_grants(label, origin);
            for invoke in &vocabulary {
                let granted = match plugin_permission_candidates(invoke.as_str()) {
                    Some(candidates) => candidates
                        .iter()
                        .any(|candidate| plugin_permissions.contains(*candidate)),
                    None if invoke.starts_with("plugin:") => {
                        violations.push(format!(
                            "{class}: `{invoke}` has no plugin_permission_candidates entry; \
                             map it to the permission that grants it",
                        ));
                        continue;
                    }
                    None => app_commands.contains(invoke.as_str()),
                };
                let excluded = DELIBERATE_EXCLUSIONS
                    .iter()
                    .any(|(c, x)| *c == class && *x == invoke.as_str());
                match (excluded, granted) {
                    (true, true) => violations.push(format!(
                        "{class}: `{invoke}` is in DELIBERATE_EXCLUSIONS but a capability \
                         grants it; drop the stale exclusion or the grant",
                    )),
                    (false, false) => violations.push(format!(
                        "{class}: the SPA can invoke `{invoke}` but no capability grants it \
                         on this label/origin",
                    )),
                    _ => {}
                }
            }
        }
        assert!(
            violations.is_empty(),
            "origin-aware ACL parity violations:\n{}",
            violations.join("\n"),
        );
    }

    /// The launcher is a remotely-served window like every other: it runs under
    /// the `main` / `main-*` labels and loads from the embedded loopback server
    /// (`WebviewUrl::External(http://{addr}/?t=...)` in main.rs), so a
    /// capability reaches it only by naming that label AND matching that origin
    /// in `remote.urls`. Grant parity alone does not cover this. A command added
    /// to the `main-window` permission set passes
    /// `app_acl_grants_every_registered_command` and
    /// `app_acl_has_no_stale_grants` while default.json, which is where
    /// `main-window` is bound, carries no `remote` key at all and therefore
    /// hands the launcher nothing. This test walks the launcher's own invokes
    /// against the grant recomputed for its label and origin, so a command that
    /// is grantable in name only fails here instead of at runtime.
    #[test]
    fn origin_aware_acl_grants_the_launcher_invoke_vocabulary() {
        const LAUNCHER_ORIGIN: &str = "http://127.0.0.1:4090";
        let vocabulary = tauri_invoke_commands(LAUNCHER_DESKTOP_TS);
        // Parser honesty: both of the launcher's own invokes must have parsed,
        // or the walk below is hollow.
        for expected in ["restart_desktop_after_update", "request_app_quit"] {
            assert!(
                vocabulary.iter().any(|command| command == expected),
                "launcher invoke-vocabulary parser lost `{expected}`; fix the parser before \
                 trusting this test",
            );
        }
        const MAIN_RS: &str = include_str!("main.rs");
        let registered: std::collections::HashSet<String> =
            invoke_handler_commands(MAIN_RS).into_iter().collect();
        // Both launcher-class labels: the `main-*` glob exists so a second
        // launcher window runs on the same permission set as the singleton.
        for label in ["main", "main-2"] {
            let (app_commands, _) = effective_grants(label, LAUNCHER_ORIGIN);
            for command in &vocabulary {
                assert!(
                    registered.contains(command),
                    "the launcher invokes `{command}` but generate_handler! does not register it",
                );
                assert!(
                    app_commands.contains(command),
                    "the launcher invokes `{command}` but no capability grants it to `{label}` \
                     served from {LAUNCHER_ORIGIN}; a permission set bound by a capability with \
                     no `remote` key never reaches the loopback-served launcher",
                );
            }
        }
        // Why the walk above can fail at all: default.json binds the broad
        // main-window set to the launcher labels with no remote scope, which is
        // what keeps the updater, dialog and process grants off remote content.
        // Widening it would hand the launcher all of them at once.
        assert!(
            capability_remote_urls(DEFAULT_CAPABILITY_JSON).is_empty(),
            "default.json must stay local-only: its main-window set carries the updater, dialog \
             and process grants, and a remote scope would hand every one of them to remotely \
             served launcher content",
        );
    }
}
