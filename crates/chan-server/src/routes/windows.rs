//! `GET /api/windows` -- enumerate the windows this tenant knows about.
//!
//! A "window" here is a per-window session id: the `?w=<id>` that keys
//! the `/api/session` layout blob and tags the window's `/ws` socket.
//! The response is the union of both sources:
//!
//!   * `saved`: a session blob exists (the window persisted a layout
//!     at some point) -- on disk for workspace tenants, in the
//!     ephemeral map for terminal tenants.
//!   * `connected`: a `/ws` socket tagged with this id is live RIGHT
//!     NOW, somewhere -- any browser tab or desktop webview. Note a
//!     hidden (buried) chan-desktop window keeps its webview and
//!     therefore stays `connected`; the server cannot distinguish
//!     hidden from visible, so it deliberately doesn't claim to.
//!
//! chan-desktop polls this on remote attachments (outbound / tunnel)
//! to offer `saved && !connected` windows in its Window menu for
//! ad-hoc reopening; `cs window list` serves the same view in a
//! terminal.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct WindowInfo {
    /// Per-window session id (the `?w=` value; for chan-desktop
    /// windows this is the Tauri window label).
    pub id: String,
    /// A `/ws` socket tagged with this id is currently live.
    pub connected: bool,
    /// A session blob exists for this id.
    pub saved: bool,
    /// The real OS window title, when chan-desktop registered it (the
    /// `<base> Window <N>` the title bar shows, or a `cs window title`
    /// override). Absent in browser mode and for closed-but-`saved`
    /// rows, so the existing `{id, connected, saved}` wire shape is
    /// preserved byte-for-byte when there is no title to add.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The window flavour (`"terminal"` | `"workspace"`), from the same
    /// desktop registration as `title`; absent under the same conditions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Join saved blob keys and live socket ids into one sorted list. A standalone
/// window's layout lives in one of two namespaces -- the plain one, or the
/// `files/` child that holds a layout with browser/editor tabs -- and a row
/// saved in either is saved, so both are merged here. BTreeMap so the response
/// order is deterministic (id-sorted). Rows carry no title/kind here -- see
/// [`join_windows_with_titles`] for the desktop-enriched variant.
pub(crate) fn join_windows(
    saved: Vec<String>,
    saved_files: Vec<String>,
    connected: Vec<String>,
) -> Vec<WindowInfo> {
    let mut by_id: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    for id in saved.into_iter().chain(saved_files) {
        by_id.entry(id).or_insert((false, false)).1 = true;
    }
    for id in connected {
        by_id.entry(id).or_insert((false, false)).0 = true;
    }
    by_id
        .into_iter()
        .map(|(id, (connected, saved))| WindowInfo {
            id,
            connected,
            saved,
            title: None,
            kind: None,
        })
        .collect()
}

/// [`join_windows`], then stamp each row with the desktop's OS title and
/// kind from `titles` (empty in browser/standalone mode, so this is a
/// no-op there). Closed-but-`saved` rows whose window the desktop already
/// dropped carry no title -- correct, there is no live OS title for them.
pub(crate) fn join_windows_with_titles(
    saved: Vec<String>,
    saved_files: Vec<String>,
    connected: Vec<String>,
    titles: &crate::window_titles::WindowTitles,
) -> Vec<WindowInfo> {
    let mut rows = join_windows(saved, saved_files, connected);
    for row in &mut rows {
        if let Some(meta) = titles.get(&row.id) {
            row.title = Some(meta.title);
            row.kind = meta.kind;
        }
    }
    rows
}

/// Enumerate this tenant's windows: saved session blobs ∪ live `/ws` presence,
/// each stamped with the desktop's OS title/kind. Sync -- `list_sessions` is
/// blocking disk I/O, so an async caller wraps this in `spawn_blocking`. A
/// failed saved-blob read degrades to "no saved windows" (graceful for an
/// enumeration; the host aggregate must not fail wholesale on one tenant).
/// Backs `GET /api/windows` (the desktop's remote-connection window menu).
pub(crate) fn enumerate_windows(state: &AppState) -> Vec<WindowInfo> {
    let connected = state.window_presence.connected_ids();
    let titles = state.window_titles.clone();
    let (saved, saved_files): (Vec<String>, Vec<String>) = match state.try_workspace() {
        Ok(workspace) => (workspace.list_sessions().unwrap_or_default(), Vec::new()),
        // Workspace-less terminal tenant: a persistent launcher store when one
        // is configured (a persisted devserver terminal), else in memory. Both
        // standalone namespaces (Terminal and Files) merge into one id list,
        // Files rows stamped with their app.
        Err(_) => match &state.terminal_session_dir {
            Some(dir) => (
                crate::terminal_blob::list(dir).unwrap_or_default(),
                crate::terminal_blob::list(&crate::terminal_blob::files_dir(dir))
                    .unwrap_or_default(),
            ),
            None => (
                state
                    .ephemeral_sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .keys()
                    .cloned()
                    .collect(),
                state
                    .ephemeral_files_sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .keys()
                    .cloned()
                    .collect(),
            ),
        },
    };
    join_windows_with_titles(saved, saved_files, connected, &titles)
}

pub async fn api_list_windows(State(state): State<Arc<AppState>>) -> Response {
    // spawn_blocking: `enumerate_windows` does sync disk I/O (`list_sessions`).
    match tokio::task::spawn_blocking(move || enumerate_windows(&state)).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("list windows task panicked: {e}"),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_is_a_sorted_union_with_per_source_flags() {
        let joined = join_windows(
            vec!["w-b".into(), "w-a".into()],
            Vec::new(),
            vec!["w-c".into(), "w-b".into()],
        );
        let view: Vec<(&str, bool, bool)> = joined
            .iter()
            .map(|w| (w.id.as_str(), w.connected, w.saved))
            .collect();
        assert_eq!(
            view,
            [
                ("w-a", false, true),
                ("w-b", true, true),
                ("w-c", true, false),
            ],
        );
    }

    // Wire pin: the desktop and `cs window list` parse these exact
    // field names; a rename is a runtime break the type checker can't
    // see across the HTTP boundary. With no title (browser mode /
    // closed-but-saved rows) the `title`/`kind` keys are SKIPPED, so the
    // shape stays byte-identical to the pre-title contract.
    #[test]
    fn window_info_serializes_id_connected_saved() {
        let json = serde_json::to_string(&WindowInfo {
            id: "workspace-aa-0".into(),
            connected: true,
            saved: false,
            title: None,
            kind: None,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"id":"workspace-aa-0","connected":true,"saved":false}"#,
        );
    }

    // Wire pin: when the desktop registered a title, the row carries
    // `title` and `kind` after the base triple.
    #[test]
    fn window_info_serializes_title_and_kind_when_present() {
        let json = serde_json::to_string(&WindowInfo {
            id: "terminal-win-0".into(),
            connected: true,
            saved: false,
            title: Some("Terminal Window 1".into()),
            kind: Some("terminal".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"id":"terminal-win-0","connected":true,"saved":false,"title":"Terminal Window 1","kind":"terminal"}"#,
        );
    }

    #[test]
    fn a_layout_saved_in_either_namespace_reads_as_saved() {
        // A standalone window's layout lives in the plain namespace or in the
        // `files/` child, depending on whether it holds file tabs. Either way
        // the window has a saved layout, and it is ONE row: the merge must not
        // double-list a window that moved between them.
        let rows = join_windows(
            vec!["w-term".into()],
            vec!["w-files".into()],
            vec!["w-files".into()],
        );
        assert_eq!(rows.len(), 2);
        let by_id = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert!(by_id("w-term").saved && !by_id("w-term").connected);
        assert!(by_id("w-files").saved && by_id("w-files").connected);
        // The wire keeps the base triple: the namespace is a server-side
        // storage detail, not something a client reads.
        let json = serde_json::to_string(by_id("w-files")).unwrap();
        assert_eq!(json, r#"{"id":"w-files","connected":true,"saved":true}"#);
    }

    #[test]
    fn join_with_titles_stamps_only_known_ids() {
        let titles = crate::window_titles::WindowTitles::new();
        titles.set(
            "w-b",
            crate::window_titles::WindowMeta {
                title: "🏠 /notes Window 1".into(),
                kind: Some("workspace".into()),
            },
        );
        let rows =
            join_windows_with_titles(vec!["w-a".into()], Vec::new(), vec!["w-b".into()], &titles);
        let by_id = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        // The closed-but-saved row has no live title.
        assert_eq!(by_id("w-a").title, None);
        assert_eq!(by_id("w-a").kind, None);
        // The connected row picks up the desktop's title + kind.
        assert_eq!(by_id("w-b").title.as_deref(), Some("🏠 /notes Window 1"));
        assert_eq!(by_id("w-b").kind.as_deref(), Some("workspace"));
    }
}
