//! HTTP route handlers, organized by area.
//!
//! Per-area submodules host the handlers, request / response shapes,
//! and any helpers specific to that area. Cross-area types (e.g.
//! `PreferencesView`) live in the module that owns them and are
//! re-exported here. Route tables are assembled in four places:
//! `router_with_extensions` and `terminal_router` in `lib.rs`,
//! `library::launcher_router`, and `devserver::build_devserver_app`.

mod attachments;
mod build_info;
mod contacts;
// pub(crate) so the server-side doc-session authority (registry, flusher,
// reconciler) fans the exact ServerFrame shapes the `/api/doc/ws` route
// serves; the frame enums in `doc` are the wire contract's single source.
pub(crate) mod doc;
mod drafts;
mod excluded_dirs;
mod extensions;
mod files;
mod fs_graph;
mod graph;
mod health;
#[cfg(feature = "embeddings")]
mod index;
mod inspector;
mod library;
mod mentions;
mod metadata;
mod open;
mod preferences;
mod preflight;
mod report;
mod reports_toggle;
// pub(crate) so the server-side scene-session authority (registry,
// flusher, reconciler) fans the exact ServerFrame shapes the
// `/api/scene/ws` route serves; the frame enums in `scene` are the wire
// contract's single source.
pub(crate) mod scene;
mod screensaver;
mod search;
mod session_handover;
mod sessions;
// pub(crate) so the terminal router (`crate::lib`) mounts the standalone
// Files handlers and the transfer lane dispatches its shared-path GET and
// upload branches into them.
pub(crate) mod standalone_drafts;
pub(crate) mod standalone_fs;
mod storage;
mod survey;
// pub(crate) so the `cs terminal team` control-socket handler
// (`crate::control_socket`, a sibling of `routes`) can reuse the team
// config write/read + bootstrap generation instead of duplicating it.
pub(crate) mod team_config;
mod terminal;
// pub(crate) so the terminal router (`crate::lib`) mounts the standalone
// transfer handlers.
pub(crate) mod transfer;
mod tunnel;
mod window;
// Tenant-scoped `GET /api/windows` saved/live session view, separate from the
// control socket's library rows.
pub(crate) mod windows;
mod workspace;
mod ws;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tokio::task::JoinError;

/// A blocking task that did not return: its closure panicked, or the runtime
/// cancelled it before it ran. It answers as a text/plain 500 carrying the
/// route's label.
pub(crate) struct BlockingTaskFailed {
    label: &'static str,
    error: JoinError,
}

impl IntoResponse for BlockingTaskFailed {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{} task panicked: {}", self.label, self.error),
        )
            .into_response()
    }
}

/// Runs a closure on the blocking pool and returns its value, or the
/// [`BlockingTaskFailed`] carrying `label` when the task did not return.
pub(crate) async fn run_blocking<T: Send + 'static>(
    label: &'static str,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, BlockingTaskFailed> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|error| BlockingTaskFailed { label, error })
}

/// Runs a response-producing closure on the blocking pool and maps a panicked
/// task to a text/plain 500 carrying `label`.
pub(crate) async fn blocking_response(
    label: &'static str,
    f: impl FnOnce() -> Response + Send + 'static,
) -> Response {
    run_blocking(label, f)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

pub use attachments::api_post_attachment;
pub use build_info::api_build_info;
pub use contacts::{api_get_contacts, api_post_contacts_import};
pub use doc::api_doc_ws;
pub use drafts::{
    api_create_diagram, api_create_draft, api_discard_draft, api_inspect_draft, api_promote_draft,
};
pub use excluded_dirs::{api_excluded_dirs_get, api_excluded_dirs_put};
pub(crate) use extensions::loggable_uri;
pub use extensions::{
    api_extensions, extension_response_policy, proxy_extension, proxy_extension_root,
};
pub use files::{
    api_create_file, api_delete_file, api_fs_transfer, api_list_files, api_move, api_read_file,
    api_resolve_session_conflict, api_upload_file, api_write_file,
};
pub use fs_graph::{api_fs_graph, build_fs_graph, FsGraphResponse, FsGraphScope};
pub use graph::{
    api_backlinks, api_graph, api_headings, api_language_graph, api_link_targets, api_links,
    api_resolve_link,
};
#[cfg(test)]
pub(crate) use health::TEST_DECLARED_BUILD_ID;
pub use health::{api_health, build_id, set_build_id};
#[cfg(feature = "embeddings")]
pub use index::{
    api_semantic_disable, api_semantic_download, api_semantic_enable, api_semantic_model_patch,
    api_semantic_models, api_semantic_state,
};
pub use inspector::api_inspector;
pub use library::{launcher_router, LauncherBearer};
pub use mentions::api_get_mentions;
#[cfg(all(test, unix))]
pub(crate) use metadata::install_test_session_close_gate;
pub use metadata::{api_metadata_export, api_metadata_import};
pub use open::api_open;
pub(crate) use preferences::broadcast_config_changed;
pub use preferences::{api_get_config, api_patch_config};
pub use preflight::{api_preflight, api_preflight_decision};
pub use report::{api_report_dir, api_report_file, api_report_prefix};
pub use reports_toggle::{api_reports_disable, api_reports_enable, api_reports_state};
pub use scene::api_scene_ws;
pub use screensaver::{
    api_screensaver_clear_pin, api_screensaver_patch, api_screensaver_set_pin,
    api_screensaver_state, api_screensaver_verify,
};
pub use search::{
    api_index_rebuild, api_index_status, api_indexing_state, api_search_content, api_search_files,
    api_search_workspace,
};
pub use session_handover::api_session_handover_reply;
pub use sessions::{api_delete_session, api_get_session, api_list_sessions, api_put_session};
pub use storage::api_storage_reset;
pub use survey::api_survey_reply;
pub use team_config::{api_team_config_read, api_team_config_write};
pub use terminal::{
    api_create_terminal, api_delete_terminal, api_restart_terminal, api_set_terminal_broadcast,
    api_terminal_next_name, api_terminal_shells, api_terminal_ws, api_terminals_roster,
    spawn_roster_broadcaster,
};
pub(crate) use terminal::{normalize_terminal_command, validate_terminal_env};
pub use window::api_window_reply;
pub use windows::api_list_windows;
pub use workspace::{api_cloud_workspaces, api_get_workspace, api_workspace_bootstrap};
pub use ws::ws_upgrade;

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::Arc;
    use std::time::Duration;

    use axum::extract::{Query, State};
    use axum::http::header;
    use axum::Json;
    use tempfile::TempDir;

    use crate::state::AppState;

    #[tokio::test]
    async fn blocking_response_maps_a_panicked_task_to_a_labelled_500() {
        let response = blocking_response("probe", || panic!("boom")).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        assert!(
            content_type.starts_with("text/plain"),
            "unexpected content type: {content_type:?}"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = std::str::from_utf8(&body).unwrap();
        assert!(
            body.starts_with("probe task panicked: "),
            "unexpected body: {body:?}"
        );
    }

    /// Poll `future` with every blocking task it spawns cancelled before it
    /// runs.
    ///
    /// The runtime entered around each poll has shut its blocking pool down,
    /// and tokio shuts a task spawned into such a pool down instead of queueing
    /// it, so the route's `spawn_blocking` resolves to a cancelled `JoinError`.
    /// `run_blocking` answers a cancelled task and a panicked one the same way,
    /// so this reaches the route's join-error arm with no seam in the route.
    /// Only the route's own polls see the shut-down runtime; the test's runtime
    /// keeps driving every other task.
    async fn with_blocking_tasks_cancelled<F: Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let shut_down = runtime.handle().clone();
        runtime.shutdown_background();
        let mut future = std::pin::pin!(future);
        let route = std::future::poll_fn(move |cx| {
            let _entered = shut_down.enter();
            future.as_mut().poll(cx)
        });
        tokio::time::timeout(Duration::from_secs(5), route)
            .await
            .expect("the route did not answer with its blocking task cancelled")
    }

    /// The status, content type and body text of `response`.
    async fn response_parts(response: Response) -> (StatusCode, String, String) {
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            content_type,
            String::from_utf8(body.to_vec()).unwrap(),
        )
    }

    /// True when `text` is how a cancelled task's `JoinError` displays.
    fn is_cancelled_task(text: &str) -> bool {
        text.strip_prefix("task ")
            .and_then(|rest| rest.strip_suffix(" was cancelled"))
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
    }

    /// Assert `response` is the text/plain 500 a failed blocking task gets,
    /// naming `label` and the cancelled task.
    async fn assert_blocking_task_failed(response: Response, label: &str) {
        let (status, content_type, body) = response_parts(response).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert_eq!(content_type, "text/plain; charset=utf-8", "{body}");
        assert!(
            body.strip_prefix(&format!("{label} task panicked: "))
                .is_some_and(is_cancelled_task),
            "{body}"
        );
    }

    /// State for a served workspace: a workspace cell with its indexer.
    fn served_state() -> (TempDir, TempDir, Arc<AppState>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let state = crate::state::test_support::workspace_app_state(
            lib,
            root.path().to_path_buf(),
            workspace,
        );
        (cfg, root, Arc::new(state))
    }

    // Each pin drives one route to its join-error arm and checks the whole
    // answer: a 500, text/plain, the route's label, then the task's
    // `JoinError`. The routes include `run_blocking` arms, one whose label is
    // a parameter, and a `blocking_response` caller.

    #[tokio::test]
    async fn preflight_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_preflight(State(state))).await;
        assert_blocking_task_failed(response, "preflight").await;
    }

    #[tokio::test]
    async fn list_files_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_list_files(
            State(state),
            Query(files::ListFilesQuery { dir: None }),
        ))
        .await;
        assert_blocking_task_failed(response, "list files").await;
    }

    #[tokio::test]
    async fn reports_state_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_reports_state(State(state))).await;
        assert_blocking_task_failed(response, "reports state").await;
    }

    #[tokio::test]
    async fn excluded_dirs_put_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_excluded_dirs_put(
            State(state),
            Json(serde_json::from_value(serde_json::json!({ "workspace": ["vendor"] })).unwrap()),
        ))
        .await;
        assert_blocking_task_failed(response, "excluded directories").await;
    }

    #[tokio::test]
    async fn storage_reset_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_storage_reset(
            State(state),
            Json(serde_json::from_value(serde_json::json!({ "mode": "workspace" })).unwrap()),
        ))
        .await;
        assert_blocking_task_failed(response, "reset").await;
    }

    #[tokio::test]
    async fn workspace_info_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_get_workspace(State(state))).await;
        assert_blocking_task_failed(response, "workspace info").await;
    }

    #[tokio::test]
    async fn list_windows_join_error_body() {
        let (_cfg, _root, state) = served_state();
        let response = with_blocking_tasks_cancelled(api_list_windows(State(state))).await;
        assert_blocking_task_failed(response, "list windows").await;
    }
}
