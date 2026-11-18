//! Serve helpers the window-ops consumer and the gateway leg share:
//! the serves-changed event, tenant prefix slugs, and the local
//! window mint/resolve/open helpers. The desktop's watcher-driven
//! serve machinery (window builds, retargets, geometry) has no iOS
//! counterpart and is not ported.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// The event the launcher receives when the serve set changes.
pub const SERVES_CHANGED: &str = "serves-changed";

/// The tenant prefix slug for a workspace key: a stable hash of the
/// key, so the same workspace always mounts at the same prefix.
pub fn workspace_window_prefix(key: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    format!("workspace-{:016x}", h.finish())
}

/// Mint a standalone terminal window on the local library: ensure the
/// shared `/terminal` tenant is mounted, then mint the registry row.
/// Returns the new window's id as the registry stores it, which is
/// what `cs window new` prints. The desktop's window watcher opens a
/// native window for the row; on iOS the single webview's launcher
/// lists the row and the page navigates, so minting is the whole op.
pub(crate) async fn spawn_local_terminal_window(state: Arc<AppState>) -> Result<String, String> {
    let Some(embedded) = state.embedded() else {
        return Err("embedded local server is unavailable".to_string());
    };
    // Ensure the shared terminal tenant is mounted (records its prefix
    // so the minted record resolves to it); cached after the first mount.
    embedded.open_terminal().await?;
    // Mint the window. The registry is the sole window authority, so
    // the terminal can never be double-opened and it persists.
    let record = embedded.mint_window(chan_server::WindowKind::Terminal, None)?;
    Ok(record.window_id)
}

/// Resolve the id an open/hide op carries to a native window label.
/// The launcher's window affordance sends a BARE library-minted
/// `window_id` (e.g. `w-1a2b`), but a watched window's native label is
/// the composite `{library_id}::{window_id}`, so a bare id never
/// matches `get_webview_window` directly. `cs window` callers pass the
/// full composite label already, so an id that is itself a live label
/// or already contains `::` is used verbatim. Otherwise match the
/// native window whose label ends with `::{id}` -- among the OPEN
/// windows, the buried list, and the connected devserver feed. Only a
/// bare `w-` id matching none of these falls back to the `local::`
/// composite.
pub(crate) fn resolve_window_label<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> String {
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

/// Pure resolution core (unit-testable without a live Tauri app): pick
/// the native label for `id` given the candidate native labels (the
/// caller passes the OPEN windows plus the buried list). A composite
/// label (one containing `::`) is used verbatim; a bare `window_id`
/// matches the `{library_id}::{id}` candidate (open or buried -- a
/// buried watched window has no live webview but its composite label
/// is in the buried list). A full `control-terminal-` label is used
/// verbatim. A bare library-minted id (`w-<hex>`) matching no
/// candidate resolves to the `local::` composite as a last resort;
/// any other unknown id stays unchanged so the open path returns its
/// ordinary "isn't open" error.
pub(crate) fn resolve_label_from(id: &str, candidates: &[String]) -> String {
    if id.contains("::") {
        return id.to_string();
    }
    let suffix = format!("::{id}");
    if let Some(label) = candidates.iter().find(|l| l.ends_with(&suffix)) {
        return label.clone();
    }
    // A control terminal has no `{library_id}::` prefix, so its full
    // native label is used verbatim.
    if id.starts_with("control-terminal-") {
        return id.to_string();
    }
    if id.starts_with("w-") {
        format!("local::{id}")
    } else {
        id.to_string()
    }
}

/// `cs window open`: focus a live window. Errors when the id names
/// nothing the app can act on. The desktop un-buries watcher windows
/// through their watcher view; iOS has one webview and no watcher, so
/// a live window is shown and focused and anything else is not open.
pub(crate) fn open_window_by_label(app: &AppHandle, label: &str) -> Result<(), String> {
    let label = resolve_window_label(app, label);
    match app.get_webview_window(&label) {
        Some(window) => {
            window.show().map_err(|e| format!("showing {label}: {e}"))?;
            window
                .set_focus()
                .map_err(|e| format!("focusing {label}: {e}"))?;
            Ok(())
        }
        None => Err(format!("window {label} isn't open")),
    }
}
