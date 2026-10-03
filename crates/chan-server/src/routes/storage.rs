//! POST /api/storage/reset.
//!
//! Drops the workspace's writer lock by replacing the active WorkspaceCell,
//! runs chan-workspace's `Library::reset_workspace` (which acquires the
//! per-workspace flock to verify exclusive access), then reopens the
//! workspace and re-attaches the watcher in a fresh cell. The frontend
//! reloads the window after a successful reset, so any in-flight
//! handler clones of the old `Arc<Workspace>` drain naturally.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use chan_workspace::{ResetMode, ResetReport, Workspace};
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::extract::Json;
use crate::routes::run_blocking;
use crate::state::AppState;

use super::metadata::{
    close_workspace_sessions, held_past_release, install_workspace_cell,
    workspace_search_aggression, WorkspaceCellInstallError,
};

/// Body of `POST /api/storage/reset`. Two modes mirror the chan-
/// core enum; the JSON tag is lowercased for the frontend's
/// `ResetMode` type.
#[derive(Deserialize)]
pub struct ResetBody {
    mode: ResetModeView,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ResetModeView {
    /// Map -> chan-workspace ResetMode::State (keep the registry entry).
    Workspace,
    /// Map -> chan-workspace ResetMode::Everything.
    Everything,
}

impl From<ResetModeView> for ResetMode {
    fn from(m: ResetModeView) -> Self {
        match m {
            ResetModeView::Workspace => ResetMode::State,
            ResetModeView::Everything => ResetMode::Everything,
        }
    }
}

#[derive(Serialize)]
struct ResetResponse {
    removed_entries: usize,
}

/// How long the reset path waits for outstanding `Arc<Workspace>` clones
/// (in-flight handlers and MCP tool bodies, the dropped indexer's
/// detached tokio tasks) to drop before giving up. Editor-side I/O
/// is fast (markdown reads / writes); 5 s is comfortable headroom
/// without making a misclick feel like a hang.
#[cfg(not(test))]
const RESET_DRAIN_DEADLINE: Duration = Duration::from_secs(5);
#[cfg(test)]
const RESET_DRAIN_DEADLINE: Duration = Duration::from_millis(500);

pub async fn api_storage_reset(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ResetBody>,
) -> Response {
    // settings_disabled is enforced by `tunnel_guard::settings_guard`
    // at the router layer; no per-handler gate.
    let mode: ResetMode = body.mode.into();
    if let Err(e) = state.try_workspace() {
        return err_state(&e);
    }
    // Run the reset on a blocking-thread: the drain spin-wait sleeps
    // and the chan-workspace wipe walks the filesystem; neither belongs
    // on the async runtime's worker thread.
    let state_clone = state.clone();
    let result = run_blocking("reset", move || perform_reset(&state_clone, mode)).await;
    match result {
        Ok(Ok(report)) => Json(ResetResponse {
            removed_entries: report.removed_entries,
        })
        .into_response(),
        Ok(Err(e)) => err_from_reset(&e),
        Err(failed) => failed.into_response(),
    }
}

#[derive(Debug)]
enum ResetError {
    Busy,
    Core(chan_workspace::ChanError),
    Poisoned(&'static str),
}

impl From<WorkspaceCellInstallError> for ResetError {
    fn from(error: WorkspaceCellInstallError) -> Self {
        match error {
            WorkspaceCellInstallError::Poisoned(what) => Self::Poisoned(what),
        }
    }
}

fn err_from_reset(e: &ResetError) -> Response {
    match e {
        ResetError::Busy => {
            let mut response = err(
                StatusCode::CONFLICT,
                "workspace busy: in-flight requests still hold the workspace; \
                 retry in a moment"
                    .into(),
            );
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from_static("1"));
            response
        }
        ResetError::Core(c) => err_from(c),
        ResetError::Poisoned(what) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{what} poisoned"),
        ),
    }
}

/// Replace `state.workspace_cell` end-to-end. Holds the write lock the
/// entire time so handlers receive a nonblocking busy result throughout
/// the old-workspace to new-workspace transition; they never observe the
/// `None` middle state.
///
/// Drain protocol: we keep one strong `Arc<Workspace>` aside (`workspace_strong`)
/// after taking the cell out, then poll `Arc::strong_count` until only
/// our copy remains. Holding the write lock means no NEW handler can
/// reborrow the workspace from the cell, so a `strong_count > 1` deadline
/// expiry is a genuine "an MCP tool body / detached task is still pinning
/// the workspace".
///
/// The count does not see a weak reference, which an indexer task or a
/// chan-workspace check can upgrade after the count reads one. So once our
/// copy is dropped we wait, within the same bound, for the workspace to be
/// let go by whichever owner lets it go last ([`held_past_release`]), and
/// only then ask chan-workspace for the reset.
///
/// On Busy we restore the workspace we started with as the cell (with
/// fresh watcher + indexer). This avoids reopening through chan-workspace,
/// which would race the lingering Arc on the per-workspace flock and fail
/// with `WorkspaceLocked`. A Busy after our copy is dropped has already
/// closed the workspace's sessions; a Busy before it has not.
fn perform_reset(
    state: &AppState,
    mode: ResetMode,
) -> Result<chan_workspace::ResetReport, ResetError> {
    perform_reset_with(state, mode, &LiveResetWorkspaceOps)
}

trait ResetWorkspaceOps {
    fn reset_workspace(
        &self,
        state: &AppState,
        mode: ResetMode,
    ) -> chan_workspace::Result<ResetReport>;

    fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>>;
}

struct LiveResetWorkspaceOps;

impl ResetWorkspaceOps for LiveResetWorkspaceOps {
    fn reset_workspace(
        &self,
        state: &AppState,
        mode: ResetMode,
    ) -> chan_workspace::Result<ResetReport> {
        state.library.reset_workspace(&state.workspace_root, mode)
    }

    fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>> {
        state.library.open_workspace(&state.workspace_root)
    }
}

fn perform_reset_with(
    state: &AppState,
    mode: ResetMode,
    ops: &impl ResetWorkspaceOps,
) -> Result<ResetReport, ResetError> {
    // Snapshot configuration before entering the destructive window. A
    // poisoned config lock is a server fault, but it must not also remove the
    // workspace cell.
    let search_aggression = workspace_search_aggression(state)?;
    let mut cell_guard = state
        .workspace_cell
        .write()
        .map_err(|_| ResetError::Poisoned("workspace cell lock"))?;
    let Some(mut cell) = cell_guard.take() else {
        return Err(ResetError::Busy);
    };
    // Nudge the rebuild to bail at its next per-file check so a long
    // cold-boot reindex doesn't pin the workspace past the deadline.
    cell.indexer.cancel();
    // Stop the watcher first so notify-side state doesn't keep a
    // Workspace ref alive past our drop.
    cell.watch_handle.take();
    // Hold one strong Arc aside so the spin-wait below has something
    // to count against. Dropping the cell releases the indexer and
    // (separately) the cell's own workspace clone; whatever strong refs
    // remain belong to in-flight handlers, MCP tool bodies, or the
    // detached tokio tasks the dropped Indexer struct left behind.
    let workspace_strong = cell.workspace.clone();
    drop(cell);
    let deadline = Instant::now() + RESET_DRAIN_DEADLINE;
    while Arc::strong_count(&workspace_strong) > 1 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if Arc::strong_count(&workspace_strong) > 1 {
        // Outstanding clones never dropped. Restore the original
        // workspace Arc as the cell with a fresh watcher + indexer; the
        // caller retries the reset. Reusing `workspace_strong` instead
        // of reopening sidesteps chan-workspace's per-workspace flock (which
        // a lingering Arc still holds).
        install_workspace_cell(state, &mut cell_guard, workspace_strong, search_aggression);
        return Err(ResetError::Busy);
    }
    // Admission succeeded. Flush dirty authorities against the old workspace
    // and close sessions before releasing its writer lock.
    close_workspace_sessions(state, &workspace_strong, "reset");
    // Drop our reference, then wait for the workspace's last owner to let it
    // go, so chan-workspace's flock is released before `reset_workspace`
    // verifies exclusive access.
    let released = Arc::downgrade(&workspace_strong);
    let lock_dir = workspace_strong.paths().lock.clone();
    drop(workspace_strong);
    if let Some(workspace) =
        held_past_release(&released, &lock_dir, Instant::now() + RESET_DRAIN_DEADLINE)
    {
        install_workspace_cell(state, &mut cell_guard, workspace, search_aggression);
        return Err(ResetError::Busy);
    }
    // Compute the wipe and restoration independently. Even a partial wipe
    // must run through open_workspace so its lazily-created skeleton is
    // repaired before the operation error is returned.
    let reset_result = ops.reset_workspace(state, mode);
    let (workspace, reopen_error) = match ops.open_workspace(state) {
        Ok(workspace) => (workspace, None),
        Err(error) => {
            // A failed reopen is itself one of the states this route has to
            // recover from. Retry once as restoration work, while preserving
            // the first error for the response if recovery succeeds.
            let workspace = ops.open_workspace(state).map_err(ResetError::Core)?;
            (workspace, Some(error))
        }
    };
    install_workspace_cell(state, &mut cell_guard, workspace, search_aggression);

    match (reset_result, reopen_error) {
        (Err(error), _) | (Ok(_), Some(error)) => Err(ResetError::Core(error)),
        (Ok(report), None) => Ok(report),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    use tempfile::TempDir;

    use crate::routes::metadata::inject_test_watch_registration_failure;
    #[cfg(unix)]
    use crate::routes::metadata::install_test_session_close_gate;
    use crate::state::test_support::workspace_app_state;

    struct ResetTestState {
        _config: TempDir,
        _root: TempDir,
        state: Arc<AppState>,
    }

    struct FaultingResetWorkspaceOps {
        fail_reset: bool,
        open_failures_remaining: Cell<usize>,
        open_calls: Cell<usize>,
    }

    impl FaultingResetWorkspaceOps {
        fn failing_reset() -> Self {
            Self {
                fail_reset: true,
                open_failures_remaining: Cell::new(0),
                open_calls: Cell::new(0),
            }
        }

        fn failing_open_once() -> Self {
            Self {
                fail_reset: false,
                open_failures_remaining: Cell::new(1),
                open_calls: Cell::new(0),
            }
        }

        fn failing_open_twice() -> Self {
            Self {
                fail_reset: false,
                open_failures_remaining: Cell::new(2),
                open_calls: Cell::new(0),
            }
        }
    }

    impl ResetWorkspaceOps for FaultingResetWorkspaceOps {
        fn reset_workspace(
            &self,
            state: &AppState,
            mode: ResetMode,
        ) -> chan_workspace::Result<ResetReport> {
            if self.fail_reset {
                return Err(chan_workspace::ChanError::Io(
                    "injected reset failure".into(),
                ));
            }
            state.library.reset_workspace(&state.workspace_root, mode)
        }

        fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>> {
            self.open_calls.set(self.open_calls.get() + 1);
            let failures = self.open_failures_remaining.get();
            if failures > 0 {
                self.open_failures_remaining.set(failures - 1);
                return Err(chan_workspace::ChanError::Io(
                    "injected open failure".into(),
                ));
            }
            state.library.open_workspace(&state.workspace_root)
        }
    }

    fn reset_test_state() -> ResetTestState {
        let config = TempDir::new().expect("config tempdir");
        let root = TempDir::new().expect("workspace tempdir");
        let library =
            chan_workspace::Library::open_at(config.path().join("config.toml")).expect("library");
        library
            .register_workspace(root.path())
            .expect("register workspace");
        let workspace = library.open_workspace(root.path()).expect("workspace");
        let state = Arc::new(AppState {
            instance_id: "reset-test".to_string(),
            ..workspace_app_state(library, root.path().to_path_buf(), workspace)
        });

        ResetTestState {
            _config: config,
            _root: root,
            state,
        }
    }

    #[test]
    fn err_from_reset_maps_poisoned_locks_to_500() {
        let response = err_from_reset(&ResetError::Poisoned("workspace cell lock"));
        let status = response.into_response().into_parts().0.status;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn busy_reset_preserves_live_sessions_and_success_flushes_then_closes() {
        check_busy_sessions_then_success(false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn busy_import_preserves_live_sessions_and_success_flushes_then_closes() {
        check_busy_sessions_then_success(true).await;
    }

    async fn session_operation(state: Arc<AppState>, archive: Option<&[u8]>) -> Response {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;
        if let Some(archive) = archive {
            let mut body = b"--import\r\nContent-Disposition: form-data; name=\"rescan\"\r\n\r\nfalse\r\n--import\r\nContent-Disposition: form-data; name=\"file\"; filename=\"metadata.tar.zst\"\r\n\r\n".to_vec();
            body.extend_from_slice(archive);
            body.extend_from_slice(b"\r\n--import--\r\n");
            axum::Router::new()
                .route(
                    "/import",
                    axum::routing::post(super::super::metadata::api_metadata_import),
                )
                .with_state(state)
                .oneshot(
                    Request::post("/import")
                        .header("content-type", "multipart/form-data; boundary=import")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap()
        } else {
            api_storage_reset(
                State(state),
                Json(ResetBody {
                    mode: ResetModeView::Workspace,
                }),
            )
            .await
        }
    }

    async fn check_busy_sessions_then_success(import: bool) {
        use crate::terminal_sessions::{CreateOptions, SessionEvent};
        let test = reset_test_state();
        let state = test.state.clone();
        let workspace = state.try_workspace().unwrap();
        workspace.write_text("live.md", "original").unwrap();
        let archive_dir = tempfile::tempdir().unwrap();
        let archive = if import {
            let path = archive_dir.path().join("metadata.tar.zst");
            state
                .library
                .export_metadata_archive(
                    &state.workspace_root,
                    &path,
                    chan_workspace::MetadataExportOptions {
                        chan_version: "test".into(),
                    },
                )
                .unwrap();
            Some(std::fs::read(path).unwrap())
        } else {
            None
        };
        let mut doc = state
            .doc_sessions
            .attach(&workspace, "live.md", "window", None)
            .await
            .unwrap();
        let mut frames = doc.take_frames();
        doc.session()
            .apply_replace("writer", "dirty content")
            .unwrap();
        let mut terminal = state
            .terminal_sessions
            .create(CreateOptions {
                size: portable_pty::PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("live".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                env: Default::default(),
                profile: None,
            })
            .unwrap();
        assert!(!state.terminal_sessions.live_child_pids().is_empty());
        let busy = tokio::time::timeout(
            Duration::from_secs(15),
            session_operation(state.clone(), archive.as_deref()),
        )
        .await
        .unwrap();
        let doc_open = state.doc_sessions.get("live.md").is_some();
        let terminal_open = state
            .terminal_sessions
            .roster()
            .iter()
            .any(|entry| entry.id == terminal.id());
        let mut doc_closed = false;
        while let Ok(frame) = frames.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
            doc_closed |= frame["type"] == "closed";
        }
        let mut terminal_closed = false;
        while let Ok(event) = terminal.rx.try_recv() {
            terminal_closed |= matches!(event, SessionEvent::Closed(_) | SessionEvent::Exit(_));
        }
        eprintln!("import={import}, status={}, doc_open={doc_open}, terminal_open={terminal_open}, doc_closed={doc_closed}, terminal_closed={terminal_closed}", busy.status());
        assert_eq!(busy.status(), StatusCode::CONFLICT);
        assert!(doc_open && terminal_open && !doc_closed && !terminal_closed);
        assert!(Arc::ptr_eq(&workspace, &state.try_workspace().unwrap()));
        let old_workspace = Arc::downgrade(&workspace);
        drop(workspace);
        let mut success = session_operation(state.clone(), archive.as_deref()).await;
        for _ in 0..10 {
            if success.status() == StatusCode::OK {
                break;
            }
            assert_eq!(success.status(), StatusCode::CONFLICT);
            tokio::time::sleep(Duration::from_millis(50)).await;
            success = session_operation(state.clone(), archive.as_deref()).await;
        }
        assert_eq!(success.status(), StatusCode::OK);
        assert!(state.doc_sessions.get("live.md").is_none());
        assert!(state.terminal_sessions.roster().is_empty());
        assert!(old_workspace.upgrade().is_none());
        assert_eq!(
            state.try_workspace().unwrap().read_text("live.md").unwrap(),
            "dirty content"
        );
        assert!(matches!(
            doc.push(1, Vec::new()),
            Err(crate::doc_sessions::PushError::Closed)
        ));
        assert!(std::iter::from_fn(|| frames.try_recv().ok()).any(|frame| {
            let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
            frame["type"] == "closed" && frame["reason"] == if import { "import" } else { "reset" }
        }));
        assert!(
            std::iter::from_fn(|| terminal.rx.try_recv().ok()).any(|event| {
                matches!(
                    event,
                    SessionEvent::Closed(crate::terminal_sessions::CloseReason::Workspace)
                )
            })
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn perform_reset_answers_busy_when_the_cell_is_already_taken() {
        let test = reset_test_state();
        test.state
            .workspace_cell
            .write()
            .expect("workspace cell lock")
            .take()
            .expect("workspace cell");

        let error = perform_reset(&test.state, ResetMode::State).expect_err("reset must be busy");

        assert!(matches!(error, ResetError::Busy));
        let response = err_from_reset(&error);
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(response.headers().get(RETRY_AFTER).unwrap(), "1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn poisoned_server_config_does_not_remove_the_workspace_cell() {
        let test = reset_test_state();
        let state = test.state.clone();
        let original = state.try_workspace().expect("workspace");
        let poison_state = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison_state.server_config.lock().expect("server config");
            panic!("poison server config");
        })
        .join();

        let result = perform_reset(&state, ResetMode::State);

        assert!(matches!(
            result,
            Err(ResetError::Poisoned("server config lock"))
        ));
        let restored = state.try_workspace().expect("workspace remains installed");
        assert!(Arc::ptr_eq(&original, &restored));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn poisoned_server_config_does_not_remove_a_busy_workspace_cell() {
        let test = reset_test_state();
        let state = test.state.clone();
        let external = state.try_workspace().expect("external workspace holder");
        let poison_state = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison_state.server_config.lock().expect("server config");
            panic!("poison server config");
        })
        .join();

        let result = perform_reset(&state, ResetMode::State);

        assert!(matches!(
            result,
            Err(ResetError::Poisoned("server config lock"))
        ));
        let restored = state.try_workspace().expect("workspace remains installed");
        assert!(Arc::ptr_eq(&external, &restored));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reset_failure_reopens_and_reinstalls_the_workspace() {
        let test = reset_test_state();

        let result = perform_reset_with(
            &test.state,
            ResetMode::State,
            &FaultingResetWorkspaceOps::failing_reset(),
        );

        assert!(matches!(
            result,
            Err(ResetError::Core(chan_workspace::ChanError::Io(message)))
                if message == "injected reset failure"
        ));
        test.state
            .try_workspace()
            .expect("failed reset must reinstall the workspace");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transient_open_failure_retries_and_reinstalls_the_workspace() {
        let test = reset_test_state();
        let ops = FaultingResetWorkspaceOps::failing_open_once();

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        assert!(matches!(
            result,
            Err(ResetError::Core(chan_workspace::ChanError::Io(message)))
                if message == "injected open failure"
        ));
        assert_eq!(ops.open_failures_remaining.get(), 0);
        assert_eq!(ops.open_calls.get(), 2);
        test.state
            .try_workspace()
            .expect("reopen recovery must reinstall the workspace");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persistent_open_failure_is_permanent_not_retryable() {
        let test = reset_test_state();
        let ops = FaultingResetWorkspaceOps::failing_open_twice();

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        assert!(matches!(
            result,
            Err(ResetError::Core(chan_workspace::ChanError::Io(message)))
                if message == "injected open failure"
        ));
        assert_eq!(ops.open_calls.get(), 2);
        let access_error = test
            .state
            .try_workspace()
            .expect_err("both reopen attempts failed");
        let response = err_state(&access_error);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(response.headers().get(RETRY_AFTER).is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handler_reports_a_missing_cell_as_a_permanent_fault() {
        let test = reset_test_state();
        test.state
            .workspace_cell
            .write()
            .expect("workspace cell lock")
            .take()
            .expect("workspace cell");

        let response = api_storage_reset(
            State(test.state),
            Json(ResetBody {
                mode: ResetModeView::Workspace,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(response.headers().get(RETRY_AFTER).is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn watcher_failure_keeps_a_successful_reset_serving() {
        let test = reset_test_state();
        inject_test_watch_registration_failure(&test.state.workspace_root);

        let result = perform_reset(&test.state, ResetMode::State);

        assert!(result.is_ok());
        test.state
            .try_workspace()
            .expect("watcher failure must keep the workspace serving");
        let cell = test
            .state
            .workspace_cell
            .read()
            .expect("workspace cell lock");
        assert!(cell
            .as_ref()
            .expect("workspace cell")
            .watch_handle
            .is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn watcher_failure_keeps_a_busy_reset_serving() {
        let test = reset_test_state();
        let external = test
            .state
            .try_workspace()
            .expect("external workspace holder");
        inject_test_watch_registration_failure(&test.state.workspace_root);

        let result = perform_reset(&test.state, ResetMode::State);

        assert!(matches!(result, Err(ResetError::Busy)));
        let restored = test
            .state
            .try_workspace()
            .expect("watcher failure must restore the busy workspace");
        assert!(Arc::ptr_eq(&external, &restored));
        drop(restored);
        let cell = test
            .state
            .workspace_cell
            .read()
            .expect("workspace cell lock");
        assert!(cell
            .as_ref()
            .expect("workspace cell")
            .watch_handle
            .is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handler_reset_completes_without_an_external_workspace_holder() {
        let test = reset_test_state();

        let response = api_storage_reset(
            State(test.state),
            Json(ResetBody {
                mode: ResetModeView::Workspace,
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handler_reset_restores_busy_cell_and_succeeds_after_holder_drops() {
        let test = reset_test_state();
        let state = test.state.clone();
        let external = state.try_workspace().expect("external workspace holder");
        let old_workspace = Arc::downgrade(&external);

        let busy = api_storage_reset(
            State(state.clone()),
            Json(ResetBody {
                mode: ResetModeView::Workspace,
            }),
        )
        .await;

        assert_eq!(busy.status(), StatusCode::CONFLICT);
        assert_eq!(busy.headers().get(RETRY_AFTER).unwrap(), "1");
        let restored = state.try_workspace().expect("restored workspace");
        assert!(Arc::ptr_eq(&external, &restored));
        drop(restored);
        drop(external);

        // Restoring the busy cell planted a fresh indexer, and its detached
        // tokio tasks hold workspace clones until they wind down. A retry
        // that lands inside that window drains out and answers Busy again,
        // which is the documented contract the `Retry-After` above states.
        // Retry like a client instead of assuming one attempt is enough.
        let mut success = api_storage_reset(
            State(state.clone()),
            Json(ResetBody {
                mode: ResetModeView::Workspace,
            }),
        )
        .await;
        for _ in 0..10 {
            if success.status() == StatusCode::OK {
                break;
            }
            assert_eq!(success.status(), StatusCode::CONFLICT);
            tokio::time::sleep(Duration::from_millis(50)).await;
            success = api_storage_reset(
                State(state.clone()),
                Json(ResetBody {
                    mode: ResetModeView::Workspace,
                }),
            )
            .await;
        }

        assert_eq!(success.status(), StatusCode::OK);
        assert!(
            old_workspace.upgrade().is_none(),
            "the successful retry must replace the old workspace generation"
        );
        state.try_workspace().expect("new workspace generation");
    }

    /// How long a reference upgraded beside a route's drop is kept when it is
    /// let go soon after: longer than the route takes to reach chan-workspace
    /// once it has dropped its own, and well inside the route's bound.
    #[cfg(unix)]
    const LATE_REFERENCE_HOLD: Duration = Duration::from_millis(150);

    /// How long a pin waits for its route at the session close. A route that
    /// answers before it gets there never opens the gate, so the wait ends
    /// on the route's answer or here and never on the gate alone.
    #[cfg(unix)]
    const SESSION_CLOSE_WAIT: Duration = Duration::from_secs(10);

    /// What a route answered beside a late reference, and what its cell holds
    /// once it has answered: whether that is the workspace the route started
    /// with, or why it holds none.
    #[cfg(unix)]
    #[derive(Debug)]
    struct BesideALateReference {
        status: StatusCode,
        same_workspace: Result<bool, crate::state::StateAccessError>,
    }

    /// Answers a reset or an import beside a reference that another owner
    /// upgrades once the route has counted its own down to one and before it
    /// drops it. Another thread lets that reference go `LATE_REFERENCE_HOLD`
    /// after the route goes on, or only once the route has answered when
    /// `outlasts_the_route`.
    #[cfg(unix)]
    async fn answer_beside_a_late_reference(
        import: bool,
        outlasts_the_route: bool,
    ) -> BesideALateReference {
        let test = reset_test_state();
        let state = test.state.clone();
        let archive_dir = tempfile::tempdir().unwrap();
        let archive = import.then(|| {
            let path = archive_dir.path().join("metadata.tar.zst");
            state
                .library
                .export_metadata_archive(
                    &state.workspace_root,
                    &path,
                    chan_workspace::MetadataExportOptions {
                        chan_version: "test".into(),
                    },
                )
                .unwrap();
            std::fs::read(path).unwrap()
        });
        let started_with = Arc::downgrade(&state.try_workspace().unwrap());
        // The session close runs between the route's count and its drop.
        let (counted, at_the_close) = tokio::sync::oneshot::channel();
        let (go_on, gone_on) = std::sync::mpsc::channel();
        install_test_session_close_gate(&state.workspace_root, counted, gone_on);
        let mut route = tokio::spawn({
            let state = state.clone();
            async move { session_operation(state, archive.as_deref()).await }
        });
        tokio::select! {
            reached = at_the_close => reached.expect("the gate fires or stays installed"),
            answer = &mut route => panic!(
                "the route answered {} before its session close",
                answer.unwrap().status()
            ),
            () = tokio::time::sleep(SESSION_CLOSE_WAIT) => panic!(
                "the route neither reached its session close nor answered \
                 within {SESSION_CLOSE_WAIT:?}"
            ),
        }
        let late = started_with
            .upgrade()
            .expect("the route holds its reference at the session close");
        let (answered, route_answered) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            if outlasts_the_route {
                // Returns when the sender is dropped, after the answer.
                let _ = route_answered.recv();
            } else {
                std::thread::sleep(LATE_REFERENCE_HOLD);
            }
            drop(late);
        });
        go_on.send(()).unwrap();
        let status = route.await.unwrap().status();
        let same_workspace = state
            .try_workspace()
            .map(|workspace| std::sync::Weak::ptr_eq(&started_with, &Arc::downgrade(&workspace)));
        drop(answered);
        holder.join().unwrap();
        BesideALateReference {
            status,
            same_workspace,
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_beside_a_reference_let_go_after_its_drop_completes() {
        let answer = answer_beside_a_late_reference(false, false).await;
        assert!(
            answer.status == StatusCode::OK && matches!(answer.same_workspace, Ok(false)),
            "a reset beside a reference let go soon after its drop must complete \
             over a new workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_reference_let_go_after_its_drop_completes() {
        let answer = answer_beside_a_late_reference(true, false).await;
        assert!(
            answer.status == StatusCode::OK && matches!(answer.same_workspace, Ok(false)),
            "an import beside a reference let go soon after its drop must complete \
             over a new workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_beside_a_reference_kept_past_its_bound_answers_busy_over_its_workspace() {
        let answer = answer_beside_a_late_reference(false, true).await;
        assert!(
            answer.status == StatusCode::CONFLICT && matches!(answer.same_workspace, Ok(true)),
            "a reset beside a reference kept past its bound must answer busy \
             over the workspace it started with: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_reference_kept_past_its_bound_answers_busy_over_its_workspace() {
        let answer = answer_beside_a_late_reference(true, true).await;
        assert!(
            answer.status == StatusCode::CONFLICT && matches!(answer.same_workspace, Ok(true)),
            "an import beside a reference kept past its bound must answer busy \
             over the workspace it started with: {answer:?}"
        );
    }
}
