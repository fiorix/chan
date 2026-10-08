//! `/api/workspace` - workspace metadata + the cloud-workspaces detection helper.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use super::preferences::{preferences_view, PreferencesView};
use crate::error::{err, err_state};
use crate::routes::files::{FileIdentity, FileRoot};
use crate::routes::{blocking_response, run_blocking};
use crate::state::AppState;

#[derive(Serialize)]
struct WorkspaceInfo {
    /// Workspace root rendered with the platform's path spelling and lossy UTF-8 conversion. The response includes the registered path without redaction.
    root: String,
    /// Path-derived label for compact UI surfaces. It is not stored
    /// in the registry and cannot be edited through `/api/workspace`.
    label: Option<String>,
    /// Stable metadata storage key under `~/.chan/workspaces/`.
    metadata_key: Option<String>,
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
pub(crate) struct WorkspaceWarning {
    pub(crate) kind: &'static str,
    pub(crate) path: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<FileIdentity>,
}

pub async fn api_get_workspace(State(state): State<Arc<AppState>>) -> Response {
    workspace_info_response(state, "workspace info").await
}

async fn workspace_info_response(state: Arc<AppState>, label: &'static str) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = run_blocking(label, move || workspace_info(&state, &workspace)).await;
    match result {
        Ok(Ok(info)) => Json(info).into_response(),
        Ok(Err(message)) => err(StatusCode::INTERNAL_SERVER_ERROR, message),
        Err(failed) => failed.into_response(),
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
    match run_blocking("bootstrap", move || workspace.bootstrap()).await {
        Ok(Ok(tree)) => Json(tree).into_response(),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(failed) => failed.into_response(),
    }
}

#[derive(Serialize)]
struct CloudDriveJson {
    provider: String,
    provider_root: String,
    suggested_root: String,
}

pub async fn api_cloud_workspaces() -> Response {
    // `detected_cloud_drives` reports the Dropbox, iCloud Drive and Google
    // Drive folders it finds on this machine. Over the tunnel the gateway
    // admits only this devserver's owner and its grantees, and a grant is
    // one shell-equivalent authority over the whole devserver
    // (`gateway/migrations/0014_drop_devserver_grant_roles.sql`). This tenant
    // serves a grantee terminals too, so the paths show a grantee nothing a
    // shell here could not list.
    blocking_response("cloud workspaces", move || {
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
        preferences: preferences_view(state).map_err(|e| e.to_string())?,
        warnings: workspace_warnings(workspace),
    })
}

pub(crate) fn workspace_warnings(workspace: &chan_workspace::Workspace) -> Vec<WorkspaceWarning> {
    let drafts_dir = workspace.drafts_dir();
    match workspace.draft_preflight() {
        Ok(issues) => issues
            .into_iter()
            .map(|issue| {
                let source = issue.source.map(|source| FileIdentity {
                    root: FileRoot::Draft,
                    path: issue.name.clone(),
                    draft_id: source.draft_id,
                });
                WorkspaceWarning {
                    kind: if issue.name.is_empty() {
                        "draft_preflight_failed"
                    } else {
                        "broken_draft"
                    },
                    path: if issue.name.is_empty() {
                        drafts_dir.to_string_lossy().into_owned()
                    } else {
                        drafts_dir.join(&issue.name).to_string_lossy().into_owned()
                    },
                    message: issue.message,
                    source,
                }
            })
            .collect(),
        Err(e) => vec![WorkspaceWarning {
            kind: "draft_preflight_failed",
            path: drafts_dir.to_string_lossy().into_owned(),
            message: e.to_string(),
            source: None,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::{workspace_warnings, FileRoot};

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
        assert_eq!(
            warnings[0].path,
            workspace.drafts_dir().join("untitled-1").to_string_lossy()
        );
        assert_eq!(warnings[0].message, "draft has no primary file");
        let source = warnings[0].source.as_ref().unwrap();
        assert_eq!(source.root, FileRoot::Draft);
        assert_eq!(source.path, "untitled-1");
        assert_eq!(
            source.draft_id,
            Some(workspace.draft_id("untitled-1").unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_warnings_do_not_offer_discard_for_stray_entries() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.create_draft_dir("untitled").unwrap();
        std::fs::write(workspace.drafts_dir().join("stray"), "not a draft").unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.drafts_dir().join("alias")).unwrap();

        let warnings = workspace_warnings(&workspace);
        for name in ["alias", "stray"] {
            let warning = warnings
                .iter()
                .find(|warning| warning.path.ends_with(name))
                .unwrap();
            assert_eq!(warning.kind, "broken_draft");
            assert!(warning.source.is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn workspace_warnings_report_refused_store_separately() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let first = lib.open_workspace(root.path()).unwrap();
        let sidecar = first.drafts_dir().to_path_buf();
        drop(first);
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(root.path(), &sidecar).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();

        let warnings = workspace_warnings(&workspace);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].kind, "draft_preflight_failed");
        assert_eq!(warnings[0].path, sidecar.to_string_lossy());
        assert!(warnings[0].message.contains("draft store unavailable"));
        assert!(warnings[0].source.is_none());
    }
}
