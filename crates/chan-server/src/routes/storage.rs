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
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::ResetMode;
use serde::{Deserialize, Serialize};

use crate::bus::{make_progress_broadcast, make_watch_bridge};
use crate::error::{err, err_from};
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
const RESET_DRAIN_DEADLINE: Duration = Duration::from_secs(5);

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
    let doc_workspace = state.try_workspace().ok();
    state
        .doc_sessions
        .close_all("reset", doc_workspace.as_ref(), &state.self_writes)
        .await;
    state
        .scene_sessions
        .close_all("reset", doc_workspace.as_ref(), &state.self_writes)
        .await;
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
        ResetError::Busy => err(
            StatusCode::CONFLICT,
            "workspace busy: in-flight requests still hold the writer lock; \
             retry in a moment"
                .into(),
        ),
        ResetError::Core(c) => err_from(c),
        ResetError::Poisoned(what) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{what} poisoned"),
        ),
    }
}

/// Replace `state.workspace_cell` end-to-end. Holds the write lock the
/// entire time so handlers waiting on the read lock see exactly one
/// transition (old workspace -> new workspace); they never observe the
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

    #[test]
    fn err_from_reset_maps_poisoned_locks_to_500() {
        let response = err_from_reset(&ResetError::Poisoned("workspace cell lock"));
        let status = response.into_response().into_parts().0.status;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
