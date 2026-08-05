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
use chan_workspace::ResetMode;
use serde::{Deserialize, Serialize};

use crate::bus::{make_progress_broadcast, make_watch_bridge};
use crate::error::{err, err_from, err_state};
use crate::indexer::Indexer;
use crate::state::{AppState, WorkspaceCell};
use crate::terminal_sessions::CloseReason;

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
    let mut cell_guard = state
        .workspace_cell
        .write()
        .map_err(|_| ResetError::Poisoned("workspace cell lock"))?;
    state.terminal_sessions.close_all(CloseReason::Workspace);
    let mut cell = cell_guard
        .take()
        .expect("workspace cell missing outside reset window");
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
        let bridge = make_watch_bridge(
            &state.events_tx,
            &state.index_events_tx,
            &state.self_writes,
            &state.scope_registry,
            state.workspace_root.clone(),
        );
        let watch_handle = workspace_strong.watch(bridge).map_err(ResetError::Core)?;
        let search_aggression = state
            .server_config
            .lock()
            .map_err(|_| ResetError::Poisoned("server config lock"))?
            .search
            .aggression;
        let indexer = Arc::new(Indexer::spawn(
            workspace_strong.clone(),
            state.index_events_tx.subscribe(),
            true,
            search_aggression,
            make_progress_broadcast(&state.events_tx),
        ));
        *cell_guard = Some(WorkspaceCell {
            workspace: workspace_strong,
            watch_handle: Some(watch_handle),
            indexer,
        });
        return Err(ResetError::Busy);
    }
    // Last strong ref is ours. Drop it so chan-workspace's flock releases
    // before `reset_workspace` tries to verify exclusive access.
    drop(workspace_strong);
    // Clean. Run the actual wipe, reopen, restart watcher + indexer.
    let report = state
        .library
        .reset_workspace(&state.workspace_root, mode)
        .map_err(ResetError::Core)?;
    let workspace = state
        .library
        .open_workspace(&state.workspace_root)
        .map_err(ResetError::Core)?;
    let bridge = make_watch_bridge(
        &state.events_tx,
        &state.index_events_tx,
        &state.self_writes,
        &state.scope_registry,
        state.workspace_root.clone(),
    );
    let watch_handle = workspace.watch(bridge).map_err(ResetError::Core)?;
    let search_aggression = state
        .server_config
        .lock()
        .map_err(|_| ResetError::Poisoned("server config lock"))?
        .search
        .aggression;
    // Fresh indexer pinned to the new Workspace Arc. Reset wiped the
    // index dir if `mode` includes Index, so initial_build=true
    // will catch zero docs and kick a rebuild.
    let indexer = Arc::new(Indexer::spawn(
        workspace.clone(),
        state.index_events_tx.subscribe(),
        true,
        search_aggression,
        make_progress_broadcast(&state.events_tx),
    ));
    *cell_guard = Some(WorkspaceCell {
        workspace,
        watch_handle: Some(watch_handle),
        indexer,
    });
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use chan_workspace::SearchAggression;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};

    use crate::self_writes::SelfWrites;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    struct ResetTestState {
        _config: TempDir,
        _root: TempDir,
        state: Arc<AppState>,
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
            terminal_session_dir: None,
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: crate::state::test_support::make_test_bulk_transfer_tenant(),
            instance_id: "reset-test".to_string(),
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
