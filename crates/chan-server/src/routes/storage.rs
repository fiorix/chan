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
use axum::Json;
use chan_workspace::{ResetMode, ResetReport, Workspace};
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::state::AppState;
use crate::terminal_sessions::CloseReason;

use super::metadata::{
    install_workspace_cell, workspace_search_aggression, WorkspaceCellInstallError,
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
/// (in-flight handler tasks, MCP sessions, the dropped indexer's
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
    // Close every live doc session BEFORE the workspace cell swap:
    // flush-all against the pre-swap workspace, fan `closed{reset}` so
    // attached editors detach cleanly, and drop the sessions so no
    // stale authority text survives into the next workspace
    // generation. Doc sessions hold no workspace Arc, so this also
    // keeps them out of the reset drain count.
    let doc_workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    state
        .doc_sessions
        .close_all("reset", Some(&doc_workspace), &state.self_writes)
        .await;
    state
        .scene_sessions
        .close_all("reset", Some(&doc_workspace), &state.self_writes)
        .await;
    drop(doc_workspace);
    // Run the reset on a blocking-thread: the drain spin-wait sleeps
    // and the chan-workspace wipe walks the filesystem; neither belongs
    // on the async runtime's worker thread.
    let state_clone = state.clone();
    let result = tokio::task::spawn_blocking(move || perform_reset(&state_clone, mode)).await;
    match result {
        Ok(Ok(report)) => Json(ResetResponse {
            removed_entries: report.removed_entries,
        })
        .into_response(),
        Ok(Err(e)) => err_from_reset(&e),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("reset task: {e}"),
        ),
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
/// reborrow the workspace, so the count is monotonically non-increasing
/// once the cell is gone -- a `strong_count > 1` deadline expiry is a
/// genuine "an MCP session / detached task is still pinning the workspace".
///
/// On Busy we restore the original `workspace_strong` as the cell (with
/// fresh watcher + indexer). This avoids reopening through chan-workspace,
/// which would race the lingering Arc on the per-workspace flock and fail
/// with `WorkspaceLocked`.
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
    state.terminal_sessions.close_all(CloseReason::Workspace);
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
    // remain belong to in-flight handlers, MCP sessions, or the
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
    // Last strong ref is ours. Drop it so chan-workspace's flock releases
    // before `reset_workspace` tries to verify exclusive access.
    drop(workspace_strong);
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
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use chan_workspace::SearchAggression;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};

    use crate::indexer::Indexer;
    use crate::routes::metadata::inject_test_watch_registration_failure;
    use crate::self_writes::SelfWrites;
    use crate::state::WorkspaceCell;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

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
        let (events_tx, _) = broadcast::channel::<String>(1);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        let indexer = Arc::new(Indexer::spawn(
            workspace.clone(),
            index_events_tx.subscribe(),
            false,
            SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        ));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        std::mem::forget(shutdown_tx);

        let state = Arc::new(AppState {
            library,
            workspace_root: root.path().to_path_buf(),
            workspace_cell: Arc::new(RwLock::new(Some(WorkspaceCell {
                workspace,
                watch_handle: None,
                indexer,
            }))),
            token: None,
            prefix: Arc::new(RwLock::new(String::new())),
            settings_disabled: false,
            last_activity: Arc::new(AtomicU64::new(0)),
            events_tx,
            index_events_tx,
            server_config: Mutex::new(ServerConfig::default()),
            editor_prefs: Mutex::new(EditorPrefs::default()),
            config_revision: AtomicU64::new(1),
            config_write_serial: Mutex::new(()),
            self_writes: Arc::new(SelfWrites::new()),
            terminal_sessions: Arc::new(TerminalRegistry::new(RegistryConfig {
                workspace_root: root.path().to_path_buf(),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            doc_sessions: Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: Arc::new(crate::survey::SurveyBus::new()),
            window_bus: Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: Mutex::new(HashMap::new()),
            ephemeral_files_sessions: Mutex::new(HashMap::new()),
            terminal_session_dir: None,
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            pending_window_commands: std::sync::Arc::new(Default::default()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: crate::state::test_support::make_test_bulk_transfer_tenant(),
            instance_id: "reset-test".to_string(),
            standalone_files: None,
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
}
