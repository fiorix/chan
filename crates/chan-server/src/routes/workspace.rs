//! `/api/workspace` - workspace metadata + the cloud-workspaces detection helper.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use super::preferences::{preferences_view, PreferencesView};
use crate::error::{err, err_state};
use crate::state::AppState;

#[derive(Serialize)]
struct WorkspaceInfo {
    /// Absolute workspace root, POSIX-style on every platform so the
    /// JSON shape stays stable. Empty string on `--tunnel-public`
    /// runs: the absolute path of the owner's workspace would otherwise
    /// reveal the owner's username and filesystem layout to every
    /// anonymous visitor.
    root: String,
    /// Path-derived label for compact UI surfaces. It is not stored
    /// in the registry and cannot be edited through `/api/workspace`.
    label: Option<String>,
    /// Stable metadata storage key under `~/.chan/workspaces/`.
    metadata_key: Option<String>,
    /// Validated name of the in-root drafts directory (default
    /// `.Drafts`), from the global `drafts_dir` config. Read-only: the
    /// SPA keys off this to build draft public paths and to recognize
    /// the drafts dir. Wire is snake_case `drafts_dir`.
    drafts_dir: String,
    /// Per-device preferences view. The frontend uses this to seed
    /// the editor (fonts, theme, line spacing) without a follow-up
    /// /api/config round-trip. Same shape as
    /// `GlobalConfig.preferences`; assembled by joining EditorPrefs
    /// and ServerConfig.
    preferences: PreferencesView,
    /// Non-fatal workspace boot warnings. Empty on healthy workspaces.
    warnings: Vec<WorkspaceWarning>,
}

#[derive(Serialize)]
struct WorkspaceWarning {
    kind: &'static str,
    path: String,
    message: String,
}

pub async fn api_get_workspace(State(state): State<Arc<AppState>>) -> Response {
    workspace_info_response(state, "workspace info").await
}

async fn workspace_info_response(state: Arc<AppState>, label: &'static str) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || workspace_info(&state, &workspace)).await;
    match result {
        Ok(Ok(info)) => Json(info).into_response(),
        Ok(Err(message)) => err(StatusCode::INTERNAL_SERVER_ERROR, message),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{label} task panicked: {e}"),
        ),
    }
}

/// `GET /api/workspace/bootstrap` - the structural spine the SPA renders
/// before any index / report job runs. Stat-only filtered walk of the
/// workspace root: immediate files + directories, each directory carrying
/// its recursive subtree file count and byte total, plus the
/// whole-workspace aggregate. Deeper levels load lazily via the existing
/// `/api/fs?dir=` path on File Browser expand / Graph depth.
///
/// Runs on the blocking pool: the walk is synchronous filesystem I/O
/// and must not block the async runtime (a large workspace is a non-
/// trivial stat sweep).
pub async fn api_workspace_bootstrap(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    match tokio::task::spawn_blocking(move || workspace.bootstrap()).await {
        Ok(Ok(tree)) => Json(tree).into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("bootstrap task panicked: {e}"),
        ),
    }
}

#[derive(Serialize)]
struct CloudDriveJson {
    provider: String,
    provider_root: String,
    suggested_root: String,
}

pub async fn api_cloud_workspaces() -> Response {
    // The detection walks the owner's home dir for Dropbox / iCloud
    // / Google Drive / OneDrive locations, surfaced in the SPA's
    // "register a workspace" picker. The tunnel is always authenticated
    // (the gateway proves the viewer is the owner), so there is no
    // anonymous viewer to withhold it from.
    match tokio::task::spawn_blocking(move || {
        let out: Vec<CloudDriveJson> = chan_workspace::paths::detected_cloud_drives()
            .into_iter()
            .map(|c| CloudDriveJson {
                provider: c.provider,
                provider_root: c.provider_root.to_string_lossy().into_owned(),
                suggested_root: c.suggested_root.to_string_lossy().into_owned(),
            })
            .collect();
        Json(out).into_response()
    })
    .await
    {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cloud workspaces task panicked: {e}"),
        )
            .into_response(),
    }
}

/// Build a `WorkspaceInfo` from current registry state.
fn workspace_info(
    state: &AppState,
    workspace: &chan_workspace::Workspace,
) -> Result<WorkspaceInfo, String> {
    let workspaces = state.library.list_workspaces();
    let workspace_root = workspace.root();
    let entry = workspaces
        .iter()
        .find(|d| d.root_path.as_path() == workspace_root);
    let root = workspace_root.to_string_lossy().into_owned();
    Ok(WorkspaceInfo {
        root,
        label: entry
            .and_then(|e| e.root_path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string),
        metadata_key: entry.map(|e| e.metadata_key.clone()),
        drafts_dir: state.library.drafts_dir(),
        preferences: preferences_view(state).map_err(|e| e.to_string())?,
        warnings: workspace_warnings(workspace),
    })
}

fn workspace_warnings(workspace: &chan_workspace::Workspace) -> Vec<WorkspaceWarning> {
    let drafts_dir = workspace.drafts_dir_name();
    match workspace.draft_preflight() {
        Ok(issues) => issues
            .into_iter()
            .map(|issue| WorkspaceWarning {
                kind: "broken_draft",
                path: format!("{}/{}", drafts_dir, issue.name),
                message: issue.message,
            })
            .collect(),
        Err(e) => vec![WorkspaceWarning {
            kind: "draft_preflight_failed",
            path: drafts_dir.to_string(),
            message: e.to_string(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::workspace_warnings;

    #[test]
    fn workspace_warnings_report_broken_drafts() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let draft = workspace.create_draft_dir("untitled-1").unwrap();
        // A subdirectory with no root-level file: nothing for the tab to
        // open, so the draft is broken.
        std::fs::create_dir_all(draft.abs.join("media")).unwrap();
        std::fs::write(draft.abs.join("media/pasted.png"), [1, 2, 3]).unwrap();

        let warnings = workspace_warnings(&workspace);

        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].kind, "broken_draft");
        assert_eq!(warnings[0].path, ".Drafts/untitled-1");
        assert_eq!(warnings[0].message, "draft has no primary file");
    }
}
