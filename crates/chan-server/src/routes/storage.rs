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
    close_workspace_sessions, held_past_release, install_workspace_cell, lock_still_held,
    reopen_released, workspace_search_aggression, Release, WorkspaceCellInstallError,
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

/// The bound of each of the reset path's four waits, which it makes one
/// after another under the cell's write guard: for outstanding
/// `Arc<Workspace>` clones (in-flight handlers and MCP tool bodies, the
/// dropped indexer's detached tokio tasks) to drop, for the workspace's last
/// owner once the route has dropped its own reference, for the writer lock
/// that owner's drop releases, and for a reopen refused over the writer
/// lock, which that drop or another process holds.
/// Editor-side I/O is fast (markdown reads / writes), so the first wait
/// ends in milliseconds and the other three find nothing to wait for; each
/// lasts its whole bound only while its own rare state does, twenty seconds
/// in the worst case.
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
/// the old-workspace to new-workspace transition, and do not observe the
/// `None` middle state of a swap that ends with a workspace in the cell.
///
/// One ending leaves the cell empty: a reopen that fails past its one retry,
/// or that is still refused over the writer lock when its bound runs out,
/// returns its error with nothing to put back. Handlers then read a missing
/// workspace, a permanent fault: this route and the metadata import are the
/// only code that fills the cell, and both start from a cell that holds a
/// workspace.
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
/// copy is dropped we wait for the workspace to be let go by whichever owner
/// lets it go last ([`held_past_release`]): within a bound of its own for
/// that owner, and within another, from the moment no owner is left, for the
/// drop that owner started to release the writer lock. Only then do we ask
/// chan-workspace for the reset.
///
/// On Busy we restore the workspace we started with as the cell (with
/// fresh watcher + indexer). This avoids reopening through chan-workspace,
/// which would race the lingering Arc on the per-workspace flock and fail
/// with `WorkspaceLocked`. A Busy after our copy is dropped has already
/// closed the workspace's sessions; a Busy before it has not.
///
/// A workspace that no owner holds cannot be put back. When its lock is
/// still held at the end of that wait, chan-workspace refuses the reset, the
/// reopen waits for the lock within a bound of its own
/// ([`reopen_released`]), and the answer is Busy over the reopened
/// workspace. A lock that the wait saw free and that chan-workspace then
/// refuses the reset over is another process's, and the answer is that
/// refusal. The reopen waits its bound for that lock too, since only a
/// reopen that succeeds fills the cell: the refusal is answered over the
/// workspace reopened once the other process has let go, and a reset that
/// was done before that process took the lock answers success over it.
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
    let releasing = match held_past_release(&released, &lock_dir, RESET_DRAIN_DEADLINE) {
        Release::Held(workspace) => {
            install_workspace_cell(state, &mut cell_guard, workspace, search_aggression);
            return Err(ResetError::Busy);
        }
        Release::LetGo => false,
        Release::LockNotFreed => true,
    };
    // Compute the wipe and restoration independently. Even a partial wipe
    // must run through open_workspace so its lazily-created skeleton is
    // repaired before the operation error is returned. A failed reopen is
    // itself one of the states this route has to recover from.
    let reset_result = ops.reset_workspace(state, mode);
    let reopened = reopen_released(RESET_DRAIN_DEADLINE, || ops.open_workspace(state))
        .map_err(ResetError::Core)?;
    install_workspace_cell(
        state,
        &mut cell_guard,
        reopened.workspace,
        search_aggression,
    );

    match (reset_result, reopened.recovered_from) {
        // The lock this route gave up waiting for was still on its way out
        // when chan-workspace refused the reset over it, and is free again by
        // the reopen: nothing was reset, and a retry finds it free. A lock
        // refusal after the wait saw the lock free is another process's, and
        // answers as that. A lock the reopen waited for is in neither
        // answer: a reset that was done answers success over the workspace
        // it reopened.
        (Err(error), _) if releasing && lock_still_held(&error) => Err(ResetError::Busy),
        (Err(error), _) | (Ok(_), Some(error)) => Err(ResetError::Core(error)),
        (Ok(report), None) => Ok(report),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    use tempfile::TempDir;

    #[cfg(unix)]
    use crate::routes::metadata::another_processes_lock;
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
        reset_test_state_stopped_by(None)
    }

    /// [`reset_test_state`] over the tenant stop signal `stopped`, when the
    /// test sends that signal itself.
    fn reset_test_state_stopped_by(
        stopped: Option<tokio::sync::watch::Receiver<bool>>,
    ) -> ResetTestState {
        let config = TempDir::new().expect("config tempdir");
        let root = TempDir::new().expect("workspace tempdir");
        let library =
            chan_workspace::Library::open_at(config.path().join("config.toml")).expect("library");
        library
            .register_workspace(root.path())
            .expect("register workspace");
        let workspace = library.open_workspace(root.path()).expect("workspace");
        let base = workspace_app_state(library, root.path().to_path_buf(), workspace);
        let shutdown_rx = stopped.unwrap_or_else(|| base.shutdown_rx.clone());
        let state = Arc::new(AppState {
            instance_id: "reset-test".to_string(),
            shutdown_rx,
            ..base
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
    async fn a_reset_whose_first_wait_ends_busy_at_a_stop_flushes_a_document() {
        check_a_busy_first_wait_at_a_stop_flushes(false, false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_whose_first_wait_ends_busy_at_a_stop_flushes_a_drawing() {
        check_a_busy_first_wait_at_a_stop_flushes(false, true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_whose_first_wait_ends_busy_at_a_stop_flushes_a_document() {
        check_a_busy_first_wait_at_a_stop_flushes(true, false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_whose_first_wait_ends_busy_at_a_stop_flushes_a_drawing() {
        check_a_busy_first_wait_at_a_stop_flushes(true, true).await;
    }

    /// A tenant told to stop aborts a flusher that has not ended by the end
    /// of its shutdown grace, and a route whose first wait begins as the
    /// stop lands holds the cell for as long as that grace lasts. No flusher
    /// runs here, as after that abort, and no clock decides the outcome:
    /// what is on disk is what the route flushed before it let the cell go.
    async fn check_a_busy_first_wait_at_a_stop_flushes(import: bool, drawing: bool) {
        use crate::terminal_sessions::{CreateOptions, SessionEvent};
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let test = reset_test_state_stopped_by(Some(stopped));
        let state = test.state.clone();
        // This reference is the owner that keeps the route's first wait busy.
        let workspace = state.try_workspace().unwrap();
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
        let path = if drawing {
            "live.excalidraw"
        } else {
            "live.md"
        };
        // The edit, in a session that nothing has flushed. The attachment
        // stays for the whole operation, as a tab's does.
        let (_attachment, mut frames): (Box<dyn std::any::Any>, _) = if drawing {
            workspace
                .write_text(
                    path,
                    r#"{"type":"excalidraw","version":2,"source":"t","elements":[],"appState":{},"files":{}}"#,
                )
                .unwrap();
            let mut handle = state
                .scene_sessions
                .attach(&workspace, path, "window")
                .await
                .unwrap();
            let frames = handle.take_frames();
            handle
                .push(
                    vec![serde_json::json!({
                        "id": "unflushed", "version": 1, "versionNonce": 10, "index": "a1"
                    })],
                    None,
                    None,
                )
                .unwrap();
            (Box::new(handle), frames)
        } else {
            workspace.write_text(path, "original").unwrap();
            let mut handle = state
                .doc_sessions
                .attach(&workspace, path, "window", None)
                .await
                .unwrap();
            let frames = handle.take_frames();
            handle
                .session()
                .apply_replace("writer", "unflushed")
                .unwrap();
            (Box::new(handle), frames)
        };
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

        stop.send(true).expect("the tenant's state listens");
        let busy = tokio::time::timeout(
            Duration::from_secs(15),
            session_operation(state.clone(), archive.as_deref()),
        )
        .await
        .unwrap();

        assert_eq!(busy.status(), StatusCode::CONFLICT);
        let on_disk = workspace.read_text(path).unwrap();
        assert!(
            on_disk.contains("unflushed"),
            "a route whose first wait ended busy at a stop let the cell go with an \
             edit unflushed: {path} reads {on_disk:?}"
        );
        let session_open = if drawing {
            state.scene_sessions.get(path).is_some()
        } else {
            state.doc_sessions.get(path).is_some()
        };
        assert!(
            !session_open,
            "the route flushed a session at a stop and left it open"
        );
        assert!(
            std::iter::from_fn(|| frames.try_recv().ok()).any(|frame| {
                let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
                frame["type"] == "closed" && frame["reason"] == "shutdown"
            }),
            "the session's attachment was not told that the session closed for a shutdown"
        );
        assert!(
            state
                .terminal_sessions
                .roster()
                .iter()
                .any(|entry| entry.id == terminal.id()),
            "a busy route closed a terminal at a stop"
        );
        assert!(
            !std::iter::from_fn(|| terminal.rx.try_recv().ok())
                .any(|event| matches!(event, SessionEvent::Closed(_) | SessionEvent::Exit(_))),
            "a busy route told a terminal that it closed at a stop"
        );
        assert!(
            Arc::ptr_eq(&workspace, &state.try_workspace().unwrap()),
            "a busy route did not put back the workspace it started with"
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

    /// What the owner of a late reference does with it.
    #[cfg(unix)]
    #[derive(Clone, Copy)]
    enum LateOwner {
        /// Lets go `LATE_REFERENCE_HOLD` after the route goes on.
        LetsGoSoon,
        /// Lets go only once the route has answered.
        OutlastsTheRoute,
        /// Lets go inside the route's bound, three fifths of it after the
        /// route dropped its own reference, and the workspace's drop then
        /// takes this long on the owner's thread.
        LetsGoIntoADropOf(Duration),
    }

    /// A recovery driver whose drop takes a set time. A workspace owns its
    /// driver and drops it after its index and before its writer lock, so the
    /// workspace's drop holds the lock that long with no strong reference
    /// left.
    #[cfg(unix)]
    struct SlowDrop(Duration);

    #[cfg(unix)]
    impl chan_workspace::RecoveryDriver for SlowDrop {
        fn wake(&self, _: chan_workspace::WorkspaceGeneration) {}
    }

    #[cfg(unix)]
    impl Drop for SlowDrop {
        fn drop(&mut self) {
            std::thread::sleep(self.0);
        }
    }

    /// The bound a route waits inside, once for its workspace's owners and
    /// again for each thing it waits for after them.
    #[cfg(unix)]
    fn drain_bound(import: bool) -> Duration {
        if import {
            crate::routes::metadata::IMPORT_DRAIN_DEADLINE
        } else {
            RESET_DRAIN_DEADLINE
        }
    }

    /// Answers a reset or an import beside a reference that another owner
    /// upgrades once the route has counted its own down to one and before it
    /// drops it. Another thread lets that reference go as `owner` says.
    #[cfg(unix)]
    async fn answer_beside_a_late_reference(
        import: bool,
        owner: LateOwner,
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
        if let LateOwner::LetsGoIntoADropOf(takes) = owner {
            late.set_recovery_driver(Arc::new(SlowDrop(takes)));
        }
        let (answered, route_answered) = std::sync::mpsc::channel::<()>();
        let holder = std::thread::spawn({
            let started_with = started_with.clone();
            move || {
                match owner {
                    LateOwner::LetsGoSoon => std::thread::sleep(LATE_REFERENCE_HOLD),
                    LateOwner::OutlastsTheRoute => {
                        // Returns when the sender is dropped, after the answer.
                        let _ = route_answered.recv();
                    }
                    LateOwner::LetsGoIntoADropOf(_) => {
                        // Let go only as the workspace's last owner, so its
                        // drop runs here and not inside the route's own.
                        let dropped_by = Instant::now() + SESSION_CLOSE_WAIT;
                        while started_with.strong_count() > 1 {
                            assert!(
                                Instant::now() < dropped_by,
                                "the route kept its own reference past its session close"
                            );
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        std::thread::sleep(drain_bound(import) * 3 / 5);
                    }
                }
                drop(late);
            }
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
        let answer = answer_beside_a_late_reference(false, LateOwner::LetsGoSoon).await;
        assert!(
            answer.status == StatusCode::OK && matches!(answer.same_workspace, Ok(false)),
            "a reset beside a reference let go soon after its drop must complete \
             over a new workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_reference_let_go_after_its_drop_completes() {
        let answer = answer_beside_a_late_reference(true, LateOwner::LetsGoSoon).await;
        assert!(
            answer.status == StatusCode::OK && matches!(answer.same_workspace, Ok(false)),
            "an import beside a reference let go soon after its drop must complete \
             over a new workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_beside_a_reference_kept_past_its_bound_answers_busy_over_its_workspace() {
        let answer = answer_beside_a_late_reference(false, LateOwner::OutlastsTheRoute).await;
        assert!(
            answer.status == StatusCode::CONFLICT && matches!(answer.same_workspace, Ok(true)),
            "a reset beside a reference kept past its bound must answer busy \
             over the workspace it started with: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_reference_kept_past_its_bound_answers_busy_over_its_workspace() {
        let answer = answer_beside_a_late_reference(true, LateOwner::OutlastsTheRoute).await;
        assert!(
            answer.status == StatusCode::CONFLICT && matches!(answer.same_workspace, Ok(true)),
            "an import beside a reference kept past its bound must answer busy \
             over the workspace it started with: {answer:?}"
        );
    }

    /// The owner lets go three fifths into the route's bound for owners and
    /// its drop ends a fifth past that bound: inside the bound the route then
    /// waits for the lock, which runs from the moment no owner is left.
    #[cfg(unix)]
    fn a_drop_past_the_owners_bound(import: bool) -> LateOwner {
        LateOwner::LetsGoIntoADropOf(drain_bound(import) * 3 / 5)
    }

    /// The owner lets go three fifths into the route's bound for owners and
    /// its drop ends half a bound past the route's wait for the lock: inside
    /// the bound the route then reopens in.
    #[cfg(unix)]
    fn a_drop_past_the_lock_bound(import: bool) -> LateOwner {
        LateOwner::LetsGoIntoADropOf(drain_bound(import) * 3 / 2)
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_beside_a_drop_that_outlasts_its_bound_for_owners_completes() {
        let answer =
            answer_beside_a_late_reference(false, a_drop_past_the_owners_bound(false)).await;
        assert!(
            answer.status == StatusCode::OK && matches!(answer.same_workspace, Ok(false)),
            "a reset whose workspace is still dropping at its bound for owners must \
             wait for the lock and complete over a new workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_drop_that_outlasts_its_bound_for_owners_completes() {
        let answer = answer_beside_a_late_reference(true, a_drop_past_the_owners_bound(true)).await;
        assert!(
            answer.status == StatusCode::OK && matches!(answer.same_workspace, Ok(false)),
            "an import whose workspace is still dropping at its bound for owners must \
             wait for the lock and complete over a new workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell() {
        let answer = answer_beside_a_late_reference(false, a_drop_past_the_lock_bound(false)).await;
        assert!(
            answer.status == StatusCode::CONFLICT && matches!(answer.same_workspace, Ok(false)),
            "a reset whose workspace is still dropping when its wait for the lock ends \
             must answer busy over a reopened workspace: {answer:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_drop_that_outlasts_its_wait_for_the_lock_answers_busy_with_a_cell()
    {
        let answer = answer_beside_a_late_reference(true, a_drop_past_the_lock_bound(true)).await;
        assert!(
            answer.status == StatusCode::CONFLICT && matches!(answer.same_workspace, Ok(false)),
            "an import whose workspace is still dropping when its wait for the lock ends \
             must answer busy over a reopened workspace: {answer:?}"
        );
    }

    /// When another process that took the workspace's writer lock lets it go.
    #[cfg(unix)]
    #[derive(Clone, Copy)]
    enum LetsGo {
        /// As the route asks for its workspace the given time: at the first
        /// the lock is free before the route reopens, at the second the
        /// route's one retry finds it free, and from the third on only a
        /// route that waits at its reopen does.
        AtOpen(usize),
        /// Three of the route's bounds after it first asked for its
        /// workspace, so a reopen that has no bound ends too.
        PastTheBound,
    }

    /// Stands in for another process that takes the workspace's writer lock
    /// once the reset has let its workspace go and seen the lock free: as
    /// the reset asks chan-workspace for its wipe, which is then refused, or
    /// once the wipe is done.
    #[cfg(unix)]
    struct BesideAnotherProcess {
        lock: std::cell::RefCell<Option<chan_workspace::lock::WorkspaceLock>>,
        refuses_the_reset: bool,
        lets_go: LetsGo,
        open_calls: Cell<usize>,
        first_open: Cell<Option<Instant>>,
    }

    #[cfg(unix)]
    impl BesideAnotherProcess {
        fn that_refuses_the_reset(lets_go: LetsGo) -> Self {
            Self::new(true, lets_go)
        }

        fn that_locks_once_the_reset_is_done(lets_go: LetsGo) -> Self {
            Self::new(false, lets_go)
        }

        fn new(refuses_the_reset: bool, lets_go: LetsGo) -> Self {
            Self {
                lock: std::cell::RefCell::new(None),
                refuses_the_reset,
                lets_go,
                open_calls: Cell::new(0),
                first_open: Cell::new(None),
            }
        }

        fn take_the_lock(&self, state: &AppState) {
            *self.lock.borrow_mut() = Some(another_processes_lock(
                &state.library,
                &state.workspace_root,
            ));
        }
    }

    #[cfg(unix)]
    impl ResetWorkspaceOps for BesideAnotherProcess {
        fn reset_workspace(
            &self,
            state: &AppState,
            mode: ResetMode,
        ) -> chan_workspace::Result<ResetReport> {
            if self.refuses_the_reset {
                self.take_the_lock(state);
                return state.library.reset_workspace(&state.workspace_root, mode);
            }
            let report = state.library.reset_workspace(&state.workspace_root, mode)?;
            self.take_the_lock(state);
            Ok(report)
        }

        fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>> {
            self.open_calls.set(self.open_calls.get() + 1);
            let first_open = self.first_open.get().unwrap_or_else(Instant::now);
            self.first_open.set(Some(first_open));
            let lets_go = match self.lets_go {
                LetsGo::AtOpen(open) => self.open_calls.get() >= open,
                LetsGo::PastTheBound => first_open.elapsed() >= RESET_DRAIN_DEADLINE * 3,
            };
            if lets_go {
                self.lock.borrow_mut().take();
            }
            state.library.open_workspace(&state.workspace_root)
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_refused_over_another_processes_lock_answers_that_lock() {
        let test = reset_test_state();
        let ops = BesideAnotherProcess::that_refuses_the_reset(LetsGo::AtOpen(1));

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        assert!(
            matches!(
                result,
                Err(ResetError::Core(chan_workspace::ChanError::WorkspaceLocked))
            ),
            "a reset refused over another process's lock must answer that lock: {:?}",
            result.as_ref().err()
        );
        test.state
            .try_workspace()
            .expect("the reopen after the other process let go fills the cell");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_refused_over_a_lock_let_go_inside_its_reopens_bound_fills_its_cell() {
        let test = reset_test_state();
        let ops = BesideAnotherProcess::that_refuses_the_reset(LetsGo::AtOpen(3));

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        assert!(
            matches!(
                result,
                Err(ResetError::Core(chan_workspace::ChanError::WorkspaceLocked))
            ),
            "a reset refused over another process's lock must answer that lock: {:?}",
            result.as_ref().err()
        );
        assert!(
            test.state.try_workspace().is_ok(),
            "a reset left its cell empty beside a lock that was let go inside its reopen's bound: {:?}",
            test.state.try_workspace().err()
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_done_beside_a_lock_let_go_at_its_second_reopen_answers_success() {
        let test = reset_test_state();
        let ops = BesideAnotherProcess::that_locks_once_the_reset_is_done(LetsGo::AtOpen(2));

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        assert!(
            result.is_ok(),
            "a reset that was done must answer success over the workspace it reopened: {:?}",
            result.as_ref().err()
        );
        test.state
            .try_workspace()
            .expect("the reopen after the other process let go fills the cell");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_done_beside_a_lock_let_go_inside_its_reopens_bound_answers_success() {
        let test = reset_test_state();
        let ops = BesideAnotherProcess::that_locks_once_the_reset_is_done(LetsGo::AtOpen(3));

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        assert!(
            result.is_ok(),
            "a reset that was done must answer success over the workspace it reopened: {:?}",
            result.as_ref().err()
        );
        test.state
            .try_workspace()
            .expect("the reopen after the other process let go fills the cell");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reset_beside_a_lock_held_past_its_reopens_bound_answers_that_lock_with_no_cell() {
        let test = reset_test_state();
        let ops = BesideAnotherProcess::that_refuses_the_reset(LetsGo::PastTheBound);
        let started = Instant::now();

        let result = perform_reset_with(&test.state, ResetMode::State, &ops);

        let took = started.elapsed();
        assert!(
            matches!(
                result,
                Err(ResetError::Core(chan_workspace::ChanError::WorkspaceLocked))
            ),
            "a reset beside a lock held past its reopen's bound must answer that lock: {:?}",
            result.as_ref().err()
        );
        assert!(
            took >= RESET_DRAIN_DEADLINE,
            "the reset gave up on another process's lock after {took:?}, inside its \
             reopen's bound of {RESET_DRAIN_DEADLINE:?}"
        );
        assert!(
            matches!(
                test.state.try_workspace(),
                Err(crate::state::StateAccessError::Missing)
            ),
            "a reset whose reopen was refused to the end of its bound has no workspace \
             to fill its cell with"
        );
    }
}
