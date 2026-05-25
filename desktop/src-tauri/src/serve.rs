//! Local-drive runtime and drive-window helpers.
//!
//! chan-desktop opens local drives through the embedded chan-server
//! `DriveHost`. Each running drive is tracked in `AppState.serves`
//! with its route prefix and token-bearing URL. The bundled `chan`
//! binary remains available for registry mutations, feature
//! toggles, upgrades, and the hidden MCP proxy, but local desktop
//! serving does not spawn `chan serve`.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Per-process monotonic counter appended to every drive-window
/// label so the user can open more than one window for the same
/// drive (local or tunneled). Tauri requires unique window labels
/// per process; the prefix encodes the drive identity and the seq
/// disambiguates instances.
static WINDOW_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_window_seq() -> u64 {
    WINDOW_SEQ.fetch_add(1, Ordering::Relaxed)
}

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::config::{self, WindowConfig};
use crate::AppState;

/// Tauri event emitted when any local runtime starts or stops. The
/// frontend reacts by re-fetching the drive list.
pub const SERVES_CHANGED: &str = "serves-changed";

const MAX_WINDOWS_PER_DRIVE: usize = 10;

/// Live state for one running serve. Held in `AppState.serves`
/// keyed by canonical drive path.
pub struct ServeHandle {
    prefix: String,
    pub url: Option<String>,
}

impl ServeHandle {
    fn embedded(prefix: String, url: String) -> Self {
        Self {
            prefix,
            url: Some(url),
        }
    }
}

/// Open a local drive through the embedded chan-server host.
pub async fn start(app: AppHandle, state: Arc<AppState>, key: String) -> Result<(), String> {
    if state.serves.lock().unwrap().contains_key(&key) {
        return Ok(());
    }
    let Some(embedded) = state.embedded.get() else {
        return Err("embedded local server is unavailable".to_string());
    };
    let url = embedded.open_drive(&key).await?;
    let prefix = url_prefix_from_local_url(&url)?;
    {
        let mut serves = state.serves.lock().unwrap();
        if serves.contains_key(&key) {
            drop(serves);
            if let Err(e) = embedded.close_prefix(&prefix) {
                tracing::warn!(key = %key, error = %e, "closing duplicate embedded drive failed");
            }
            return Ok(());
        }
        serves.insert(key.clone(), ServeHandle::embedded(prefix, url.clone()));
    }
    let _ = app.emit(SERVES_CHANGED, ());
    if let Err(e) = spawn_local_drive_window(&app, &key, &url) {
        if let Some(handle) = state.serves.lock().unwrap().remove(&key) {
            stop_handle(None, &state, &key, handle);
        }
        let _ = app.emit(SERVES_CHANGED, ());
        return Err(e);
    }
    Ok(())
}

fn url_prefix_from_local_url(url: &str) -> Result<String, String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("parsing embedded drive URL: {e}"))?;
    let path = parsed.path().trim_end_matches('/');
    let path = path.strip_suffix("/index.html").unwrap_or(path);
    if path.is_empty() {
        Ok(String::new())
    } else {
        Ok(path.to_string())
    }
}

/// Stop a running serve. No-op if the drive isn't running. Removes
/// the live entry before waiting so an immediate stop -> start can
/// mount a fresh runtime instead of observing stale map state.
pub fn stop(app: Option<&AppHandle>, state: &AppState, key: &str) {
    let handle = state.serves.lock().unwrap().remove(key);
    if let Some(h) = handle {
        stop_handle(app, state, key, h);
    }
}

/// Stop every running serve. Called from the Tauri Exit hook so
/// embedded drive state shuts down before the desktop exits.
pub fn stop_all(state: &AppState) {
    let handles: Vec<(String, ServeHandle)> = state.serves.lock().unwrap().drain().collect();
    for (key, h) in handles {
        stop_handle(None, state, &key, h);
    }
}

fn stop_handle(app: Option<&AppHandle>, state: &AppState, key: &str, handle: ServeHandle) {
    if let Some(embedded) = state.embedded.get() {
        if let Err(e) = embedded.close_prefix(&handle.prefix) {
            tracing::warn!(key = %key, error = %e, "closing embedded drive failed");
        }
    }
    if let Some(app) = app {
        close_local_drive_windows(app, key);
        let _ = app.emit(SERVES_CHANGED, ());
    }
}

/// Stable Tauri window-label prefix for a local drive. Used to
/// recognise every window that belongs to the drive when the user
/// has opened more than one (close-all on serve exit, capability
/// matching). Tauri labels must match `[a-zA-Z0-9_-]+`, and drive
/// keys are filesystem paths, so we hash the key.
pub fn drive_window_prefix(key: &str) -> String {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    format!("drive-{:016x}", h.finish())
}

/// Fresh, unique window label for a new local-drive webview.
/// Every call yields a distinct label so multi-window works; the
/// prefix is still identifiable for cleanup. Format:
/// `drive-<hash>-<seq>` where `seq` is a per-process atomic.
pub fn new_drive_window_label(key: &str) -> String {
    format!("{}-{}", drive_window_prefix(key), next_window_seq())
}

/// Window title for a local-drive webview: the drive path verbatim.
/// `fullstack-b-14` swapped the earlier "chan drive: <basename>"
/// shape after @@Alex flagged that the path is the more useful
/// signal in the OS window switcher than the prefix + basename.
fn drive_title(key: &str) -> String {
    key.to_string()
}

/// Resolve the absolute path of the bundled `chan` binary.
///
/// The helper binary is for CLI-owned surfaces, not local serving.
/// Normal local drives run through the embedded chan-server host.
/// `desktop/Makefile` stages the per-target-triple binary under
/// `src-tauri/binaries/`; the Tauri bundle config copies it next to
/// chan-desktop's own executable with the triple suffix stripped:
///
///   * dev (`make run`):           staged before `cargo tauri dev`
///   * release bundle on macOS:    `Chan.app/Contents/MacOS/chan`
///   * release on Linux/Windows:   pending per-platform bundle files
///
/// The resolver is pure path math over `current_exe()`; it does NOT
/// check that the binary actually exists on disk. The boot-time
/// preflight in `crate::compute_bin_status` performs the existence
/// and version check exactly once and stores the verdict in
/// `AppState::bin_status`, gating every IPC that would spawn chan.
pub fn bundled_chan_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locating chan-desktop binary: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "chan-desktop binary has no parent directory".to_string())?;
    let name = if cfg!(target_os = "windows") {
        "chan.exe"
    } else {
        "chan"
    };
    Ok(dir.join(name))
}

/// Probe a `chan` binary's `--version` output and confirm it
/// matches chan-desktop's own version exactly.
///
/// Used by both the boot-time preflight (validating the bundled
/// binary at `bundled_chan_path()`) and the PATH-first resolver
/// (deciding whether a `chan` on the user's `PATH` is usable as a
/// substitute for the bundled binary). The exact-match contract
/// is the locked Round-2 decision 3 (round-2-plan decisions
/// table): bundled chan ships from the same workspace checkout
/// as chan-desktop so the versions are always identical in a
/// clean build, and any PATH chan that doesn't match the same
/// version is rejected in favour of the bundled fallback.
pub fn probe_chan_version(bin: &Path) -> Result<(), String> {
    let out = std::process::Command::new(bin)
        .arg("--version")
        .output()
        .map_err(|e| format!("probing chan version at {}: {e}", bin.display()))?;
    if !out.status.success() {
        return Err(format!(
            "chan at {} failed `--version`: {}",
            bin.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let version = stdout
        .split_whitespace()
        .find_map(|part| semver::Version::parse(part.trim_start_matches('v')).ok())
        .ok_or_else(|| format!("could not parse chan version from {:?}", stdout.trim()))?;
    let expected = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|e| format!("invalid chan-desktop version: {e}"))?;
    if version != expected {
        return Err(format!(
            "chan at {} reports v{version}, but Chan Desktop expects v{expected}.",
            bin.display()
        ));
    }
    Ok(())
}

/// Resolve which `chan` binary chan-desktop should spawn.
///
/// PATH-first with bundled fallback. Locked Round-2 decision 3
/// (`docs/journals/phase-8/architect/round-2-plan.md`).
///
/// Algorithm:
///   1. Look up `chan` (or `chan.exe`) on the user's `PATH`. If
///      found, probe its `--version` and check it matches
///      chan-desktop's `env!("CARGO_PKG_VERSION")` exactly. On
///      match, return the resolved PATH path.
///   2. Any failure (no chan on `PATH`, spawn error, `--version`
///      error, version mismatch) falls through to the bundled
///      binary at `bundled_chan_path()`.
///
/// Why PATH-first: a power user who runs their own chan build
/// from this checkout and `cargo install --path crates/chan`
/// expects chan-desktop to use their build. Why exact-match: a
/// stale PATH chan (vN-1) running against chan-desktop vN, or a
/// vN+1 prerelease, produces weird-state crashes the locked
/// decision was designed to prevent; falling back to bundled
/// keeps the app launchable.
///
/// The resolver does NOT existence-check the bundled fallback;
/// the boot-time preflight in `crate::compute_bin_status` owns
/// the file + version check on whatever path is picked, and
/// surfaces "bundled missing AND PATH missing" via the
/// `BinStatus::missing` kind that the frontend already handles.
pub fn resolve_chan_binary() -> Result<PathBuf, String> {
    resolve_chan_binary_with(which_chan(), probe_chan_version, bundled_chan_path)
}

/// Testable core of `resolve_chan_binary`. The `path_candidate`
/// is the `which`-style lookup result; `probe` is the
/// `--version`-and-exact-match check (real implementation:
/// `probe_chan_version`); `bundled_fn` is the fallback path
/// resolver (real implementation: `bundled_chan_path`). Pure
/// composition over its three inputs so the five acceptance
/// branches in `fullstack-b-16` can be covered by unit tests
/// without spawning real binaries.
fn resolve_chan_binary_with<P, B>(
    path_candidate: Option<PathBuf>,
    probe: P,
    bundled_fn: B,
) -> Result<PathBuf, String>
where
    P: FnOnce(&Path) -> Result<(), String>,
    B: FnOnce() -> Result<PathBuf, String>,
{
    if let Some(path_chan) = path_candidate {
        if probe(&path_chan).is_ok() {
            return Ok(path_chan);
        }
    }
    bundled_fn()
}

/// `which chan` for the current process: walk `PATH` and return
/// the first executable entry named `chan` (or `chan.exe` on
/// Windows). Returns None when `PATH` is unset, empty, or has
/// no matching entry. Pure-environment lookup; does not spawn a
/// subprocess.
fn which_chan() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exe_name = if cfg!(target_os = "windows") {
        "chan.exe"
    } else {
        "chan"
    };
    which_chan_in(&path_var, exe_name)
}

/// `which_chan` factored over the `PATH` value + binary name so
/// tests can drive it with synthetic fixtures without mutating
/// the live process environment (which would race across the
/// test binary's threads).
fn which_chan_in(path_var: &std::ffi::OsStr, name: &str) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_var) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match path.metadata() {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    // Windows: PATHEXT decides what counts as executable. We only
    // ever look for `chan.exe`, so file-exists is sufficient.
    path.is_file()
}

/// Stable window-label prefix for a tunneled drive, namespaced
/// separately from `drive-*` so a local drive path and a tunneled
/// drive slug don't collide.
pub fn tunnel_window_prefix(tenant_label: &str, drive: &str) -> String {
    let mut h = DefaultHasher::new();
    tenant_label.hash(&mut h);
    drive.hash(&mut h);
    format!("tunnel-{:016x}", h.finish())
}

/// Fresh, unique window label for a tunneled drive webview. Same
/// shape as `new_drive_window_label`.
pub fn new_tunnel_window_label(tenant_label: &str, drive: &str) -> String {
    format!(
        "{}-{}",
        tunnel_window_prefix(tenant_label, drive),
        next_window_seq()
    )
}

/// Stable window-label prefix for an outbound URL attachment.
pub fn outbound_window_prefix(id: &str) -> String {
    let mut h = DefaultHasher::new();
    id.hash(&mut h);
    format!("outbound-{:016x}", h.finish())
}

/// Fresh, unique window label for an outbound URL webview.
pub fn new_outbound_window_label(id: &str) -> String {
    format!("{}-{}", outbound_window_prefix(id), next_window_seq())
}

/// True when a Tauri label belongs to a per-drive webview.
pub fn is_drive_webview_label(label: &str) -> bool {
    label.starts_with("drive-") || label.starts_with("tunnel-") || label.starts_with("outbound-")
}

/// Spawn a new local-drive webview window pointing at `url`. Each
/// call opens an independent window; multiple windows per drive are
/// supported. Pops the most-recent WindowConfig for this drive (if
/// any) so the new window reuses the previous `?w=<label>` and URL
/// hash, restoring panes / tabs (via `session.json`) and overlay
/// state across the close/reopen cycle. A user-initiated close
/// pushes the closing window's state back to the stack so the next
/// open repeats the restore. The Tauri close handler does NOT stop
/// the underlying local runtime; the On toggle (plus
/// `close_local_drive_windows` on runtime teardown) remains the single
/// authority on drive lifecycle.
pub fn spawn_local_drive_window(app: &AppHandle, key: &str, url: &str) -> Result<(), String> {
    ensure_window_capacity(app, &drive_window_prefix(key))?;
    let config_key = config::local_window_key(key);
    let restore = pop_compatible_config(app, &config_key, &drive_window_prefix(key));
    let label = match restore.as_ref() {
        Some(c) => c.window_label.clone(),
        None => new_drive_window_label(key),
    };
    let url_hash = restore
        .as_ref()
        .map(|c| c.url_hash.clone())
        .unwrap_or_default();
    let zoom_level = restore.as_ref().map(|c| c.zoom_level).unwrap_or(1.0);
    let title = drive_title(key);
    build_drive_window(app, &label, &title, url, &url_hash, config_key, zoom_level)
}

/// Spawn a new tunneled-drive webview window. Same multi-window
/// semantics and config-stack restore as the local variant.
pub fn spawn_tunneled_drive_window(
    app: &AppHandle,
    tenant_label: &str,
    drive: &str,
    url: &str,
) -> Result<(), String> {
    ensure_window_capacity(app, &tunnel_window_prefix(tenant_label, drive))?;
    let config_key = config::tunnel_window_key(tenant_label, drive);
    let prefix = tunnel_window_prefix(tenant_label, drive);
    let restore = pop_compatible_config(app, &config_key, &prefix);
    let label = match restore.as_ref() {
        Some(c) => c.window_label.clone(),
        None => new_tunnel_window_label(tenant_label, drive),
    };
    let url_hash = restore
        .as_ref()
        .map(|c| c.url_hash.clone())
        .unwrap_or_default();
    let zoom_level = restore.as_ref().map(|c| c.zoom_level).unwrap_or(1.0);
    // `fullstack-b-14`: matches the local-drive title shape; the
    // tunneled drive has no local filesystem path, so we use the
    // closest analog ("<tenant>·<drive>") with no prefix.
    let title = format!("{tenant_label} \u{00b7} {drive}");
    build_drive_window(app, &label, &title, url, &url_hash, config_key, zoom_level)
}

/// Spawn a new outbound URL webview window. The desktop does not own
/// the remote process; this only creates another webview pointed at
/// the persisted URL.
pub fn spawn_outbound_drive_window(
    app: &AppHandle,
    id: &str,
    title: &str,
    url: &str,
) -> Result<(), String> {
    ensure_window_capacity(app, &outbound_window_prefix(id))?;
    let config_key = config::outbound_window_key(id);
    let prefix = outbound_window_prefix(id);
    let restore = pop_compatible_config(app, &config_key, &prefix);
    let label = match restore.as_ref() {
        Some(c) => c.window_label.clone(),
        None => new_outbound_window_label(id),
    };
    let url_hash = restore
        .as_ref()
        .map(|c| c.url_hash.clone())
        .unwrap_or_default();
    let zoom_level = restore.as_ref().map(|c| c.zoom_level).unwrap_or(1.0);
    build_drive_window(app, &label, title, url, &url_hash, config_key, zoom_level)
}

/// Pop the top-of-stack window config for `config_key` only if the
/// stored label is safe to reuse. The label must still match the
/// drive's current hash prefix (defends against the drive key
/// changing canonicalisation under us) and must not already be
/// live in this process (Tauri requires unique labels per
/// process). When the popped entry fails either check, it gets
/// dropped on the floor; we don't keep cycling through stale
/// stack entries trying to find a usable one, since the next
/// close will push a fresh entry anyway.
fn pop_compatible_config(
    app: &AppHandle,
    config_key: &str,
    expected_prefix: &str,
) -> Option<WindowConfig> {
    let state = app.state::<Arc<AppState>>();
    let entry = state.pop_window_config(config_key)?;
    if !entry.window_label.starts_with(expected_prefix) {
        tracing::debug!(
            label = %entry.window_label,
            prefix = %expected_prefix,
            "discarding window config with stale prefix",
        );
        return None;
    }
    if app.get_webview_window(&entry.window_label).is_some() {
        tracing::debug!(
            label = %entry.window_label,
            "discarding window config; label still live",
        );
        return None;
    }
    Some(entry)
}

/// Build and show a chan-style drive webview window on the main
/// thread. Internal: call `spawn_local_drive_window` /
/// `spawn_tunneled_drive_window` / `spawn_outbound_drive_window`
/// from outside. Centralising the
/// key-bridge JS, the size defaults, the zoom-hotkey polyfill, and
/// the drag-drop handler off in one place means drive UX changes
/// don't fork between the local and tunneled paths.
///
/// `url_hash_seed` carries any popped URL hash from the
/// window-config stack: applied verbatim to the URL fragment so
/// overlay state (file browser path, search query, graph scope)
/// restores alongside the panes/tabs that come back from
/// `session.json`. Empty when there's nothing to restore.
///
/// `config_key` is the WindowConfig identity key (`local_window_key`
/// or `tunnel_window_key`). Stamped onto the close handler so a
/// user-initiated close pushes the window's final URL hash back
/// into the LRU stack.
fn build_drive_window(
    app: &AppHandle,
    window_label: &str,
    title: &str,
    url: &str,
    url_hash_seed: &str,
    config_key: String,
    zoom_seed: f64,
) -> Result<(), String> {
    let Ok(mut parsed) = url.parse::<tauri::Url>() else {
        return Err(format!("bad chan URL for {window_label}: {url}"));
    };
    parsed.query_pairs_mut().append_pair("w", window_label);
    if !url_hash_seed.is_empty() {
        parsed.set_fragment(Some(url_hash_seed));
    }
    let app_owned = app.clone();
    let label_owned = window_label.to_string();
    let title_owned = title.to_string();
    let res = app.run_on_main_thread(move || {
        // Defensive: window labels are unique-per-instance now, so
        // a collision shouldn't happen. If it ever does (e.g. some
        // future code reusing a stable label), destroy the stale
        // window so `build` doesn't panic.
        if let Some(old) = app_owned.get_webview_window(&label_owned) {
            let _ = old.destroy();
        }
        match WebviewWindowBuilder::new(&app_owned, &label_owned, WebviewUrl::External(parsed))
            .title(title_owned)
            .inner_size(1200.0, 800.0)
            .min_inner_size(640.0, 400.0)
            .resizable(true)
            .initialization_script(KEY_BRIDGE_JS)
            // `fullstack-b-19`: explicit `zoom_in` / `zoom_out` /
            // `zoom_reset` IPC commands fired from KEY_BRIDGE_JS
            // are the primary path; this Tauri-level polyfill stays
            // on as a mousewheel + pinch fallback (the chord
            // overlap is harmless because KEY_BRIDGE_JS's capture-
            // phase listener calls preventDefault before the
            // polyfill's bubble-phase listener sees the keydown).
            // Requires `core:webview:allow-set-webview-zoom` on
            // drive-* / tunnel-* / outbound-* windows per
            // capabilities/drive.json.
            .zoom_hotkeys_enabled(true)
            // Hand HTML5 drag-and-drop to the page. Tauri's OS-level
            // drag handler swallows dragover events otherwise, so
            // chan's pane-to-pane tab moves never see the highlight /
            // drop the receiving pane expects.
            .disable_drag_drop_handler()
            .build()
        {
            Ok(window) => {
                // `fullstack-b-19`: restore the persisted zoom level from
                // the popped WindowConfig (if any). 1.0 is the chan-
                // desktop default; skip the IPC round-trip when there's
                // nothing to apply. Best-effort: a Tauri set_zoom error
                // here just leaves the new window at default zoom; the
                // user can re-press Cmd++/Cmd+- to recover.
                if (zoom_seed - 1.0).abs() > f64::EPSILON {
                    if let Err(e) = window.set_zoom(zoom_seed) {
                        tracing::warn!(
                            label = %label_owned,
                            error = %e,
                            "restoring window zoom level failed",
                        );
                    } else {
                        let state = app_owned.state::<Arc<AppState>>();
                        state
                            .live_window_zooms
                            .lock()
                            .unwrap()
                            .insert(label_owned.clone(), zoom_seed);
                    }
                }
                let app_for_close = app_owned.clone();
                let label_for_close = label_owned.clone();
                let key_for_close = config_key.clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::CloseRequested { .. }) {
                        capture_window_config_on_close(
                            &app_for_close,
                            &label_for_close,
                            &key_for_close,
                        );
                    }
                });
            }
            Err(e) => {
                tracing::warn!(label = %label_owned, error = %e, "opening drive window failed")
            }
        }
    });
    res.map_err(|e| format!("scheduling drive window for {window_label}: {e}"))
}

/// Snapshot the closing window's URL hash and push the resulting
/// WindowConfig onto the LRU stack. Best-effort: a webview that's
/// already torn down reports no URL and we skip the push. The
/// hash is read from `WebviewWindow::url()` because the webview
/// SPA writes the latest state to `location.hash` via
/// `persistStateToHash`, and Tauri's URL reflection picks that up
/// on platforms with the WKWebView / WebView2 backends.
///
/// `fullstack-b-19`: also drains the live zoom level for this
/// window into `WindowConfig.zoom_level` so the next open of the
/// same drive restores the zoom.
fn capture_window_config_on_close(app: &AppHandle, window_label: &str, config_key: &str) {
    let Some(window) = app.get_webview_window(window_label) else {
        return;
    };
    let url_hash = match window.url() {
        Ok(u) => u.fragment().unwrap_or("").to_string(),
        Err(e) => {
            tracing::debug!(
                label = %window_label,
                error = %e,
                "could not read url for closing window; pushing empty hash",
            );
            String::new()
        }
    };
    let state = app.state::<Arc<AppState>>();
    let zoom_level = state
        .live_window_zooms
        .lock()
        .unwrap()
        .remove(window_label)
        .unwrap_or(1.0);
    state.push_window_config(WindowConfig {
        key: config_key.to_string(),
        window_label: window_label.to_string(),
        url_hash,
        zoom_level,
        saved_at: 0,
    });
}

fn ensure_window_capacity(app: &AppHandle, prefix: &str) -> Result<(), String> {
    let count = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(prefix))
        .count();
    if count >= MAX_WINDOWS_PER_DRIVE {
        return Err(format!(
            "Drive already has {MAX_WINDOWS_PER_DRIVE} open windows; close one before opening another."
        ));
    }
    Ok(())
}

/// Destroy every webview window opened for this local drive when
/// the local runtime is closed. Walks `webview_windows()` and
/// matches by prefix because the user may have opened several
/// windows for the same drive.
pub fn close_local_drive_windows(app: &AppHandle, key: &str) {
    close_windows_with_prefix(app, &drive_window_prefix(key))
}

/// Destroy every webview window opened for this tunneled drive.
/// Used by the tunnel supervisor when a (label, drive) pair drops
/// out of the registry; the remote has gone away, so the per-tenant
/// listener no longer routes for it and any open window now points
/// at nothing useful.
pub fn close_tunneled_drive_windows(app: &AppHandle, tenant_label: &str, drive: &str) {
    close_windows_with_prefix(app, &tunnel_window_prefix(tenant_label, drive))
}

/// Destroy every webview window opened for this outbound URL
/// attachment. Used when the user forgets the attachment row.
pub fn close_outbound_drive_windows(app: &AppHandle, id: &str) {
    close_windows_with_prefix(app, &outbound_window_prefix(id))
}

/// Destroy every tunneled-drive webview window in the process,
/// regardless of which (label, drive) it belongs to. Used by the
/// tunnel module on `stop_listening`: the tunnel listener and
/// every per-tenant listener are about to be cancelled, so the
/// open windows would all error on their next request anyway.
pub fn close_all_tunneled_drive_windows(app: &AppHandle) {
    close_windows_with_prefix(app, "tunnel-")
}

fn close_windows_with_prefix(app: &AppHandle, prefix: &str) {
    let app_owned = app.clone();
    let prefix_owned = prefix.to_string();
    let _ = app.run_on_main_thread(move || {
        // Snapshot first; destroying inside the iterator would
        // mutate the underlying map mid-walk.
        let labels: Vec<String> = app_owned
            .webview_windows()
            .keys()
            .filter(|l| l.starts_with(&prefix_owned))
            .cloned()
            .collect();
        for l in labels {
            if let Some(w) = app_owned.get_webview_window(&l) {
                let _ = w.destroy();
            }
        }
    });
}

/// Native keyboard shortcuts for drive webviews. Translates chords
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
const KEY_BRIDGE_JS: &str = r#"
(() => {
  function fire(e, name, detail) {
    e.preventDefault();
    e.stopImmediatePropagation();
    window.dispatchEvent(new CustomEvent('chan:command',
      { detail: Object.assign({ name: name }, detail || {}) }));
  }
  // `fullstack-b-17`: Cmd+R reloads the webview, Cmd+Opt+I opens
  // DevTools. Both bypass the SPA event bus and invoke their
  // Tauri IPC commands directly so a frozen Svelte runtime or a
  // broken chord registry can't lock the dev affordances away.
  function invokeIpc(e, cmd) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      tauri.core.invoke(cmd).catch((err) => {
        console.error('[chan] IPC ' + cmd + ' failed:', err);
      });
    }
  }
  // `fullstack-42` pruned every native chord whose action is now
  // covered by Pane Mode (Cmd+K). Dropped: Cmd+P, Cmd+N, Cmd+`,
  // Cmd+[/Cmd+], Cmd+Shift+M, Cmd+Shift+F. Kept: Cmd+W (close
  // tab; pairs with Ctrl+D from fullstack-41), Cmd+F/G (find on page),
  // Cmd+1..9 (jump to tab), Cmd+Shift+T (reopen closed),
  // Cmd+Shift+[/] (tab nav), Cmd+Shift+G (find prev).
  // `fullstack-b-2`: Cmd+T comes back as a direct chord for
  // "new terminal in active pane".
  // `fullstack-a-32`: Cmd+O / Cmd+P / Cmd+Shift+M added as direct
  // chords for File Browser / Rich Prompt / Graph (with the
  // matching `app.files.toggle` / `app.terminal.richPrompt` /
  // `app.graph.toggle` commands routed through the context-aware
  // helpers in App.svelte). Universal Hybrid NAV `t/o/p/v` covers
  // the web/Win/Linux fallback path.
  function onKey(e) {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const shift = e.shiftKey;
    const alt = e.altKey;
    const code = e.code;
    if (alt) {
      // Cmd+Opt+I (macOS) / Ctrl+Alt+I (Linux/Windows) → DevTools.
      // No other meta+alt chord today; bail out for everything else
      // so we don't shadow the webview's defaults.
      if (!shift && code === 'KeyI') {
        invokeIpc(e, 'open_devtools');
      }
      return;
    }
    // `fullstack-b-19`: zoom chords route regardless of shift so
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
        case 'KeyR': invokeIpc(e, 'reload_window'); return;
        case 'KeyT': fire(e, 'app.terminal.toggle'); return;
        case 'KeyO': fire(e, 'app.files.toggle');    return;
        case 'KeyP': fire(e, 'app.terminal.richPrompt'); return;
        case 'KeyW': fire(e, 'app.tab.close');        return;
        case 'KeyF': fire(e, 'app.find.open');        return;
        case 'KeyG': fire(e, 'app.find.next');        return;
        case 'BracketLeft':  fire(e, 'app.pane.prev'); return;
        case 'BracketRight': fire(e, 'app.pane.next'); return;
      }
      const m = code.match(/^Digit([1-9])$/);
      if (m) {
        fire(e, 'app.tab.jump', { index: Number(m[1]) - 1 });
        return;
      }
    } else {
      switch (code) {
        case 'KeyG':         fire(e, 'app.find.prev');     return;
        case 'KeyT':         fire(e, 'app.tab.reopenClosed'); return;
        case 'KeyM':         fire(e, 'app.graph.toggle');  return;
        case 'BracketLeft':  fire(e, 'app.tab.prev');      return;
        case 'BracketRight': fire(e, 'app.tab.next');      return;
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
    fn invoke_handler_registers_reload_window_and_open_devtools() {
        // `fullstack-b-17`: the IPC commands `reload_window` and
        // `open_devtools` MUST be in the `tauri::generate_handler!`
        // list so the SPA's tab context-menu (via -a-36) and the
        // accelerator path can reach them. The generate_handler!
        // macro does not catch a missing handler at compile time,
        // so we pin it here against the source file. Tests live in
        // serve.rs because main.rs has no test module today; using
        // `include_str!` keeps the pin source-of-truth-correct.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("reload_window,"));
        assert!(MAIN_RS.contains("open_devtools,"));
        assert!(MAIN_RS.contains("fn reload_window(window: tauri::WebviewWindow)"));
        assert!(MAIN_RS.contains("fn open_devtools(window: tauri::WebviewWindow)"));
    }

    #[test]
    fn invoke_handler_registers_file_browser_drag_out_ipc() {
        const MAIN_RS: &str = include_str!("main.rs");
        const DRAG_OUT_RS: &str = include_str!("drag_out.rs");
        assert!(MAIN_RS.contains("mod drag_out;"));
        assert!(MAIN_RS.contains("drag_out::start_file_browser_drag_out,"));
        assert!(DRAG_OUT_RS.contains("pub async fn start_file_browser_drag_out("));
    }

    #[test]
    fn key_bridge_wires_zoom_chords_to_ipc() {
        // `fullstack-b-19`: Cmd+= / Cmd+- / Cmd+0 (and their
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
        // `fullstack-b-19`: zoom_in / zoom_out / zoom_reset must be
        // in `tauri::generate_handler!` so KEY_BRIDGE_JS's IPC
        // invocations reach a registered command. generate_handler!
        // doesn't catch missing entries at compile time; pin here.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("zoom_in,"));
        assert!(MAIN_RS.contains("zoom_out,"));
        assert!(MAIN_RS.contains("zoom_reset,"));
    }

    #[test]
    fn invoke_handler_registers_drive_features_ipcs() {
        // `fullstack-b-28a`: the launcher's expand panel calls
        // `get_drive_features` on first open + `set_drive_features`
        // on every checkbox flip. Pin both sides so a future rename
        // gets caught.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("get_drive_features,"));
        assert!(MAIN_RS.contains("set_drive_features,"));
        assert!(MAIN_RS.contains("fn get_drive_features("));
        assert!(MAIN_RS.contains("fn set_drive_features("));
    }

    #[test]
    fn invoke_handler_registers_outbound_attach_ipcs() {
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("add_outbound_drive,"));
        assert!(MAIN_RS.contains("open_outbound_drive,"));
        assert!(MAIN_RS.contains("remove_outbound_drive,"));
        assert!(MAIN_RS.contains("fn add_outbound_drive("));
        assert!(MAIN_RS.contains("fn open_outbound_drive("));
        assert!(MAIN_RS.contains("fn remove_outbound_drive("));
    }

    #[test]
    fn invoke_handler_registers_default_drive_ipcs() {
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("default_drive_status,"));
        assert!(MAIN_RS.contains("choose_default_drive,"));
        assert!(MAIN_RS.contains("create_default_drive,"));
        assert!(MAIN_RS.contains("factory_reset_default_drive,"));
        assert!(MAIN_RS.contains("fn default_drive_status("));
        assert!(MAIN_RS.contains("fn choose_default_drive("));
        assert!(MAIN_RS.contains("fn create_default_drive("));
        assert!(MAIN_RS.contains("fn factory_reset_default_drive("));
    }

    #[test]
    fn add_drive_passes_feature_flags_to_chan_cli() {
        // `fullstack-b-28b` slice iii: the pre-flight modal
        // collects feature choices BEFORE registration; `add_drive`
        // must forward them as `--semantic-search` /
        // `--reports` flags to `chan add`. systacean-27's
        // BOOT process picks the flags up + activates the layers
        // on the first open, so the user doesn't need to toggle
        // post-add to get the chosen state.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains("features: Option<DriveFeatures>"),
            "add_drive must accept the pre-flight feature pair as an optional arg",
        );
        assert!(
            MAIN_RS.contains("\"--semantic-search\""),
            "add_drive must pass --semantic-search to chan add when bge is enabled",
        );
        assert!(
            MAIN_RS.contains("\"--reports\""),
            "add_drive must pass --reports to chan add when reports is enabled",
        );
    }

    #[test]
    fn pick_and_add_shows_preflight_dialog_before_add_drive() {
        // `fullstack-b-28b` slice iii: pickAndAdd MUST gate the
        // add_drive invocation behind the pre-flight modal so the
        // user always sees the round-2-plan explanatory copy +
        // the feature toggles BEFORE chan-drive's BOOT runs.
        const MAIN_JS: &str = include_str!("../../src/main.js");
        assert!(
            MAIN_JS.contains("showPreflightDialog("),
            "main.js must call showPreflightDialog from pickAndAdd",
        );
        assert!(
            MAIN_JS.contains("features: choice.features"),
            "main.js must thread the pre-flight choice through to add_drive",
        );
    }

    #[test]
    fn preflight_dialog_carries_round2_plan_explanatory_copy() {
        // `fullstack-b-28b` slice iii: the round-2-plan flagged
        // the explanatory copy as "load-bearing"; @@Alex wants
        // users to understand the baseline before they choose
        // what to layer on". Pin the load-bearing phrases so a
        // future refactor can't silently drop them.
        const MAIN_JS: &str = include_str!("../../src/main.js");
        assert!(
            MAIN_JS.contains("BM25 keyword search is"),
            "preflight modal must explain the BM25 baseline",
        );
        assert!(
            MAIN_JS.contains("can't be disabled"),
            "preflight modal must explain that the baseline is mandatory",
        );
        assert!(
            MAIN_JS.contains("dense-vector embeddings"),
            "preflight modal must describe semantic search via dense embeddings",
        );
        assert!(
            MAIN_JS.contains("tokei"),
            "preflight modal must name tokei as the language-detection engine",
        );
        assert!(
            MAIN_JS.contains("COCOMO"),
            "preflight modal must name COCOMO as the estimate model",
        );
    }

    #[test]
    fn invoke_handler_registers_compute_drive_preflight() {
        // `fullstack-b-28b` slice iv: the pre-flight modal calls
        // `compute_drive_preflight` after mount to populate the
        // report rows. Mirrors the other IPC registration pins
        // so a rename catches deliberately.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(MAIN_RS.contains("compute_drive_preflight,"));
        assert!(MAIN_RS.contains("fn compute_drive_preflight("));
    }

    #[test]
    fn preflight_modal_renders_report_rows_after_b28b_iv() {
        // `fullstack-b-28b` slice iv: the modal kicks off
        // `compute_drive_preflight` after mount and renders the
        // returned facts via `renderPreflightReport`. Pin both
        // the invoke + the renderer + the load-bearing report
        // labels so a future refactor can't silently revert to
        // the slice-iii "toggles only" shape.
        const MAIN_JS: &str = include_str!("../../src/main.js");
        assert!(
            MAIN_JS.contains("invoke('compute_drive_preflight'"),
            "main.js must invoke compute_drive_preflight from showPreflightDialog",
        );
        assert!(
            MAIN_JS.contains("renderPreflightReport(reportEl, report)"),
            "main.js must render the resolved report into the dialog",
        );
        for label in [
            "'Files'",
            "'Markdown'",
            "'Size'",
            "'Media'",
            "'Source control'",
        ] {
            assert!(
                MAIN_JS.contains(label),
                "preflight modal must surface {label} report row",
            );
        }
    }

    #[test]
    fn get_drive_features_reads_chan_index_status_after_b28b_ii() {
        // `fullstack-b-28b` slice ii: `get_drive_features` swaps
        // from desktop-cache-only to a `chan index status --json` CLI
        // round-trip, picking up out-of-band feature flips (e.g.
        // a user toggling via terminal). Pin the subprocess
        // argument shape so a refactor can't silently revert to
        // the slice-i cache-only read path.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains("read_features_via_chan_index_status"),
            "get_drive_features must call read_features_via_chan_index_status as the authoritative read path",
        );
        assert!(
            MAIN_RS.contains("[\"index\", \"status\", \"--json\", \"--path\", key]"),
            "the CLI read must use `chan index status --json --path <path>`",
        );
        assert!(
            MAIN_RS.contains("\"semantic_enabled\""),
            "the JSON parser must pull semantic_enabled from chan index status output",
        );
        assert!(
            MAIN_RS.contains("\"reports_enabled\""),
            "the JSON parser must pull reports_enabled from chan index status output",
        );
    }

    #[test]
    fn chan_index_status_json_carries_reports_enabled_after_b28b_ii() {
        // `fullstack-b-28b` slice ii: chan-desktop's CLI read
        // depends on `chan index status --json` emitting
        // `reports_enabled` alongside `semantic_enabled`. Pin
        // the field name in the chan binary's source so a rename
        // / removal on the chan side fails this test loudly +
        // forces a coordinated cross-lane fix instead of a
        // silent regression to cache-only reads.
        const CHAN_MAIN_RS: &str = include_str!("../../../crates/chan/src/main.rs");
        assert!(
            CHAN_MAIN_RS.contains("\"reports_enabled\": cfg.reports_enabled"),
            "chan index status --json must emit reports_enabled for the chan-desktop get_drive_features IPC",
        );
    }

    #[test]
    fn set_drive_features_calls_chan_cli_after_b28b() {
        // `fullstack-b-28b-i`: `set_drive_features` no longer
        // writes the desktop cache in isolation. It first invokes the
        // `chan` CLI for each changed flag (so chan-drive's
        // authoritative state matches what the user clicked),
        // then mirrors the result into the cache. Pin the CLI
        // subcommand names so a rename in chan's CLI surface
        // (or an architectural swap to a different transport)
        // can't silently revert chan-desktop to the old stub
        // behaviour.
        const MAIN_RS: &str = include_str!("main.rs");
        assert!(
            MAIN_RS.contains("\"enable-semantic\""),
            "set_drive_features must shell out to `chan index enable-semantic` when bge flips ON"
        );
        assert!(
            MAIN_RS.contains("\"disable-semantic\""),
            "set_drive_features must shell out to `chan index disable-semantic` when bge flips OFF"
        );
        assert!(
            MAIN_RS.contains("\"reports\""),
            "set_drive_features must invoke `chan reports {{enable,disable}}` for the reports flag"
        );
        assert!(
            MAIN_RS.contains("\"-y\""),
            "chan reports disable prompts for confirmation; -y must be passed so chan-desktop's checkbox click doesn't deadlock"
        );
    }

    #[test]
    fn launcher_calls_drive_features_ipcs() {
        // `fullstack-b-28a`: the SPA-side launcher MUST invoke
        // both IPCs so the expand panel reflects + persists
        // toggle state. Pin the invoke names alongside the
        // Rust registration above.
        const MAIN_JS: &str = include_str!("../../src/main.js");
        assert!(
            MAIN_JS.contains("invoke('get_drive_features'"),
            "main.js must invoke get_drive_features on panel open"
        );
        assert!(
            MAIN_JS.contains("invoke('set_drive_features'"),
            "main.js must invoke set_drive_features on checkbox change"
        );
    }

    #[test]
    fn launcher_prompts_for_existing_user_default_drive() {
        const MAIN_JS: &str = include_str!("../../src/main.js");
        assert!(
            MAIN_JS.contains("invoke('default_drive_status'"),
            "launcher must query default-drive migration status",
        );
        assert!(
            MAIN_JS.contains("showDefaultDriveDialog"),
            "launcher must prompt when a default drive choice is needed",
        );
        assert!(
            MAIN_JS.contains("invoke('choose_default_drive'"),
            "launcher must let users choose an existing default drive",
        );
        assert!(
            MAIN_JS.contains("invoke('create_default_drive'"),
            "launcher must let users create Documents/Chan as default",
        );
        assert!(
            MAIN_JS.contains("showMissingDefaultDriveDialog"),
            "launcher must confirm before factory-resetting missing default drive metadata",
        );
        assert!(
            MAIN_JS.contains("invoke('factory_reset_default_drive'"),
            "launcher must route confirmed missing-default reset to Rust",
        );
    }

    #[test]
    fn launcher_features_panel_carries_round2_plan_toggles() {
        // `fullstack-b-28a`: the panel HTML ships both feature
        // labels + the brief copy. Pin the label strings so a
        // future renaming requires deliberate coordination
        // (Settings copy in `-a-76` mirrors these labels).
        const MAIN_JS: &str = include_str!("../../src/main.js");
        assert!(
            MAIN_JS.contains("Semantic search"),
            "features panel must label the BGE toggle as 'Semantic search'"
        );
        assert!(
            MAIN_JS.contains("Reports"),
            "features panel must label the chan-report toggle as 'Reports'"
        );
        assert!(
            MAIN_JS.contains("data-feat=\"bge\""),
            "features panel must bind the BGE checkbox to the bge field"
        );
        assert!(
            MAIN_JS.contains("data-feat=\"reports\""),
            "features panel must bind the reports checkbox to the reports field"
        );
    }

    #[test]
    fn new_window_accelerator_uses_cmd_shift_n() {
        // `fullstack-b-27`: the "New Window" menu item moves from
        // `CmdOrCtrl+N` to `CmdOrCtrl+Shift+N` to free Cmd+N for
        // the SPA's New Draft handler (`fullstack-a-66`). Pin the
        // chord so a future menu edit can't silently revert to
        // plain Cmd+N and re-clash with the SPA chord.
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
        // `fullstack-b-17`: Cmd+R fires the `reload_window` IPC and
        // Cmd+Opt+I fires `open_devtools`, bypassing the SPA event
        // bus so a frozen Svelte runtime can't lock the dev
        // affordances away. The accelerator path goes through
        // `invokeIpc(...)` (not the `chan:command` `fire(...)`
        // bridge), so the contract pin checks both the IPC command
        // names and the case-label they're bound from.
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'reload_window')"));
        assert!(KEY_BRIDGE_JS.contains("invokeIpc(e, 'open_devtools')"));
        assert!(KEY_BRIDGE_JS.contains("case 'KeyR': invokeIpc"));
        assert!(KEY_BRIDGE_JS.contains("code === 'KeyI'"));
    }

    #[test]
    fn embedded_url_prefix_parser_strips_query_and_trailing_slash() {
        let prefix =
            url_prefix_from_local_url("http://127.0.0.1:1234/drive-abcd/?t=token").expect("prefix");
        assert_eq!(prefix, "/drive-abcd");
    }

    #[test]
    fn embedded_url_prefix_parser_strips_index_html() {
        let prefix =
            url_prefix_from_local_url("http://127.0.0.1:1234/drive-abcd/index.html?t=token")
                .expect("prefix");
        assert_eq!(prefix, "/drive-abcd");
    }

    #[test]
    fn key_bridge_invokes_tauri_ipc_via_core_invoke() {
        // The `invokeIpc` helper grabs `window.__TAURI__.core.invoke`
        // (Tauri 2's invoke surface; was `window.__TAURI__.invoke`
        // in Tauri 1). Pin so a future bridge rewrite doesn't
        // silently regress to the v1 shape. The new shape returns
        // undefined from a webview without the v2 IPC surface
        // attached, which silently swallows the Cmd+R / Cmd+Opt+I
        // accelerators.
        assert!(KEY_BRIDGE_JS.contains("window.__TAURI__"));
        assert!(KEY_BRIDGE_JS.contains("tauri.core.invoke"));
    }

    #[test]
    fn key_bridge_drops_chords_covered_by_pane_mode() {
        // `fullstack-42` pruned every native chord that now has a
        // Pane Mode equivalent. `fullstack-b-2` brought
        // `app.terminal.toggle` back (Cmd+T). `fullstack-a-32`
        // brings back `app.files.toggle` (Cmd+O), `app.graph.toggle`
        // (Cmd+Shift+M), and `app.terminal.richPrompt` (Cmd+P) as
        // direct chords with context-aware semantics. The
        // remaining absences below catch accidental reverts of
        // chords that should still go through Pane Mode only.
        assert!(!KEY_BRIDGE_JS.contains("app.search.toggle"));
        assert!(!KEY_BRIDGE_JS.contains("app.file.new"));
        assert!(!KEY_BRIDGE_JS.contains("Backquote"));
    }

    #[test]
    fn key_bridge_keeps_independent_chords() {
        // Tab close + reopen + Find on page + tab nav + tab jump
        // are NOT duplicated by Pane Mode and must stay reachable
        // through the native bridge. Cmd+T / Cmd+O / Cmd+P /
        // Cmd+Shift+M are the `fullstack-a-32` context-aware
        // spawn chord family.
        assert!(KEY_BRIDGE_JS.contains("app.terminal.toggle"));
        assert!(KEY_BRIDGE_JS.contains("app.files.toggle"));
        assert!(KEY_BRIDGE_JS.contains("app.terminal.richPrompt"));
        assert!(KEY_BRIDGE_JS.contains("app.pane.prev"));
        assert!(KEY_BRIDGE_JS.contains("app.pane.next"));
        assert!(KEY_BRIDGE_JS.contains("app.graph.toggle"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.close"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.reopenClosed"));
        assert!(KEY_BRIDGE_JS.contains("app.find.open"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.jump"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.next"));
        assert!(KEY_BRIDGE_JS.contains("app.tab.prev"));
    }

    #[test]
    fn bundled_chan_path_is_sibling_of_chan_desktop_executable() {
        // `fullstack-b-15`: Tauri's `externalBin` stages the chan
        // chan binary next to chan-desktop's own binary, with the
        // per-target-triple suffix stripped. Pin that contract here
        // so a future capability or layout change can't silently
        // shift where chan-desktop expects to find the bundled binary.
        // Pure path math: the helper does NOT touch the filesystem,
        // so the test passes even when target/debug/chan does not
        // exist (e.g. on a fresh CI checkout that has not built
        // `cargo build --release --bin chan` yet).
        let path = bundled_chan_path().expect("bundled_chan_path resolves");
        let exe = std::env::current_exe().expect("current_exe");
        assert_eq!(
            path.parent(),
            exe.parent(),
            "bundled chan must sit next to chan-desktop's binary",
        );
        let expected_name = if cfg!(target_os = "windows") {
            "chan.exe"
        } else {
            "chan"
        };
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some(expected_name),
        );
    }

    #[test]
    fn resolve_chan_binary_picks_path_when_version_matches() {
        // `fullstack-b-16`: PATH chan exists + version matches → use
        // PATH path. Tested via dependency injection (no real
        // subprocess spawn). The probe argument simulates a
        // successful version match; the bundled-fn argument is a
        // sentinel that must NOT be called when PATH succeeds.
        let path_chan = PathBuf::from("/usr/local/bin/chan");
        let resolved = resolve_chan_binary_with(
            Some(path_chan.clone()),
            |_| Ok(()),
            || panic!("bundled fallback must not run when PATH chan matches"),
        )
        .expect("resolves successfully");
        assert_eq!(resolved, path_chan);
    }

    #[test]
    fn resolve_chan_binary_falls_back_when_path_version_mismatches() {
        // PATH chan exists but version probe errors (mismatch, or
        // failed `--version` invocation, same outward shape). Must
        // fall through to the bundled path.
        let path_chan = PathBuf::from("/usr/local/bin/chan");
        let bundled = PathBuf::from("/Applications/Chan.app/Contents/MacOS/chan");
        let resolved = resolve_chan_binary_with(
            Some(path_chan),
            |_| Err("v0.10.0 != v0.11.1".to_string()),
            || Ok(bundled.clone()),
        )
        .expect("resolves successfully via bundled");
        assert_eq!(resolved, bundled);
    }

    #[test]
    fn resolve_chan_binary_falls_back_when_no_chan_on_path() {
        // PATH lookup turned up empty (no chan binary in any entry
        // of `$PATH`). Resolver returns the bundled path without
        // attempting a version probe.
        let bundled = PathBuf::from("/Applications/Chan.app/Contents/MacOS/chan");
        let resolved = resolve_chan_binary_with(
            None,
            |_| panic!("probe must not run when there is no PATH candidate"),
            || Ok(bundled.clone()),
        )
        .expect("resolves successfully via bundled");
        assert_eq!(resolved, bundled);
    }

    #[test]
    fn resolve_chan_binary_surfaces_error_when_bundled_also_missing() {
        // Edge case from the task spec: no chan on PATH AND
        // `bundled_chan_path()` errors (e.g. `current_exe()` failed).
        // The helper propagates the bundled error so the boot-time
        // preflight can map it to `BinStatus::missing`.
        let resolved = resolve_chan_binary_with(
            None,
            |_| panic!("probe must not run when there is no PATH candidate"),
            || Err("locating chan-desktop binary: io error".to_string()),
        );
        let err = resolved.expect_err("must propagate the bundled error");
        assert!(err.contains("locating chan-desktop binary"));
    }

    #[cfg(unix)]
    #[test]
    fn which_chan_in_finds_chan_in_first_matching_path_entry() {
        // `which_chan_in` is the testable seam for the `PATH`
        // lookup. Synthesize a temp directory containing an
        // executable `chan`, point PATH at it, and confirm the
        // helper returns that path. Then drop a SECOND temp dir
        // also containing chan and confirm first-match-wins.
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let tmp_root =
            std::env::temp_dir().join(format!("chan-fullstack-b-16-which-{}", std::process::id()));
        let first = tmp_root.join("first");
        let second = tmp_root.join("second");
        fs::create_dir_all(&first).expect("create first PATH dir");
        fs::create_dir_all(&second).expect("create second PATH dir");
        for dir in [&first, &second] {
            let bin = dir.join("chan");
            fs::write(&bin, b"#!/bin/sh\necho stub\n").expect("write stub chan");
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755))
                .expect("mark stub executable");
        }

        let path_var = std::env::join_paths([&first, &second]).expect("join PATH");
        let resolved = which_chan_in(&path_var, "chan").expect("resolves PATH chan");
        assert_eq!(resolved, first.join("chan"));

        // No matching binary anywhere on PATH → None.
        let empty_dir = tmp_root.join("empty");
        fs::create_dir_all(&empty_dir).expect("create empty PATH dir");
        let empty_path = std::env::join_paths([&empty_dir]).expect("join PATH");
        assert!(which_chan_in(&empty_path, "chan").is_none());

        // Non-executable file is rejected (Unix-only branch; the
        // Windows fall-through accepts any matching name).
        let no_exec_dir = tmp_root.join("no-exec");
        fs::create_dir_all(&no_exec_dir).expect("create no-exec PATH dir");
        let no_exec = no_exec_dir.join("chan");
        fs::write(&no_exec, b"not executable\n").expect("write non-exec stub");
        fs::set_permissions(&no_exec, fs::Permissions::from_mode(0o644)).expect("mark non-exec");
        let no_exec_path = std::env::join_paths([&no_exec_dir]).expect("join PATH");
        assert!(which_chan_in(&no_exec_path, "chan").is_none());

        fs::remove_dir_all(&tmp_root).expect("cleanup temp PATH fixtures");
    }

    #[test]
    fn drive_title_is_the_path_verbatim() {
        // `fullstack-b-14`: titles are the drive path so the OS
        // window switcher surfaces the disambiguating signal.
        // Earlier shape "chan drive: <basename>" lost the path
        // detail and collided when two drives shared a basename.
        assert_eq!(
            drive_title("/Users/alex/dev/github.com/fiorix/chan"),
            "/Users/alex/dev/github.com/fiorix/chan",
        );
        // Trailing slash, edge case, etc. are passed through; we
        // don't sanitize; the caller's path is the source of truth.
        assert_eq!(drive_title("/tmp/scratch/"), "/tmp/scratch/");
        assert_eq!(drive_title(""), "");
    }

    // `fullstack-b-7`: drive and tunnel webviews host the SPA, which
    // routes external http(s) link clicks through tauri-plugin-opener
    // via the `plugin:opener|open_url` IPC. Without these permissions
    // the IPC denies, the SPA falls back to the clipboard-copy notify
    // branch, and "click external link" looks like a no-op to the
    // user (the bug Alex reported on 2026-05-20). Pin the capability
    // shape here so a future capability-file edit can't silently drop
    // the permissions without the test catching it.
    const DRIVE_CAPABILITY_JSON: &str = include_str!("../capabilities/drive.json");
    const DEFAULT_CAPABILITY_JSON: &str = include_str!("../capabilities/default.json");
    const APP_PERMISSIONS_TOML: &str = include_str!("../permissions/app.toml");

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
        v["remote"]["urls"]
            .as_array()
            .expect("remote urls is an array")
            .iter()
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

    fn app_permission_allows(id: &str) -> Vec<String> {
        let v: toml::Value = toml::from_str(APP_PERMISSIONS_TOML).expect("app permissions parse");
        v["permission"]
            .as_array()
            .expect("permissions is an array")
            .iter()
            .find(|permission| permission["identifier"].as_str() == Some(id))
            .unwrap_or_else(|| panic!("missing app permission {id}"))["commands"]["allow"]
            .as_array()
            .expect("allowed commands is an array")
            .iter()
            .map(|cmd| cmd.as_str().expect("command is a string").to_string())
            .collect()
    }

    #[test]
    fn drive_capability_grants_opener_to_drive_tunnel_and_outbound_windows() {
        let windows = capability_windows(DRIVE_CAPABILITY_JSON);
        assert!(
            windows.iter().any(|w| w == "drive-*"),
            "drive capability must target drive-* windows: {windows:?}",
        );
        assert!(
            windows.iter().any(|w| w == "tunnel-*"),
            "drive capability must target tunnel-* windows: {windows:?}",
        );
        assert!(
            windows.iter().any(|w| w == "outbound-*"),
            "drive capability must target outbound-* windows: {windows:?}",
        );
        let perms = capability_permissions(DRIVE_CAPABILITY_JSON);
        assert!(
            perms.iter().any(|p| p == "drive-window"),
            "drive capability must include drive-window app commands: {perms:?}",
        );
        assert!(
            perms.iter().any(|p| p == "opener:allow-open-url"),
            "drive capability must include opener:allow-open-url: {perms:?}",
        );
    }

    #[test]
    fn drive_capability_covers_loopback_server_urls() {
        // Drive windows load chan-server through loopback HTTP
        // origins. Without a remote URL match, Tauri omits the IPC
        // bridge and drive-window app commands such as native
        // File Browser drag-out never reach Rust.
        let remote_urls = capability_remote_urls(DRIVE_CAPABILITY_JSON);
        assert!(
            remote_urls.iter().any(|u| u == "http://127.0.0.1:*"),
            "drive capability must include 127.0.0.1 loopback: {remote_urls:?}",
        );
        assert!(
            remote_urls.iter().any(|u| u == "http://localhost:*"),
            "drive capability must include localhost loopback: {remote_urls:?}",
        );
    }

    #[test]
    fn app_acl_allows_drive_window_commands() {
        let drive_set = app_permission_set("drive-window");
        for expected in [
            "allow-reload-window",
            "allow-open-devtools",
            "allow-start-file-browser-drag-out",
            "allow-zoom-in",
            "allow-zoom-out",
            "allow-zoom-reset",
        ] {
            assert!(
                drive_set.iter().any(|p| p == expected),
                "drive-window app permission set must include {expected}: {drive_set:?}",
            );
        }
        assert_eq!(
            app_permission_allows("allow-start-file-browser-drag-out"),
            vec!["start_file_browser_drag_out".to_string()],
        );
    }

    #[test]
    fn default_capability_covers_extra_launcher_windows() {
        // `fullstack-83` lets Cmd+N spawn `main-N` launcher windows.
        // They must inherit the same capability as `main`, or
        // external link handling and other plugin IPCs break for the
        // user the moment they open a second launcher.
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
    }
}
