//! Session blobs (`/api/session*`).
//!
//! chan-workspace owns the I/O (Workspace::{put,get,list,delete}_session).
//! chan-server is a thin HTTP shell; the JSON schema of session blobs
//! (window/pane layout) lives in the frontend, not here.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::error::err_from;
use crate::state::AppState;
use crate::util::raw_json_response;

/// Window id query param (`?w=<id>`) for session routes. `moved=1` (DELETE
/// only) marks a cross-window MOVE-OUT so the handler deletes the blob but does
/// NOT reap the window's sessions; the moved PTY survives. Get /
/// put ignore it. `client` is the writer's per-SPA-instance nonce, echoed on
/// the `session_changed` broadcast so the writer can drop its own frame; GET
/// accepts and ignores it.
#[derive(Deserialize)]
pub struct SessionQuery {
    w: String,
    #[serde(default)]
    moved: Option<String>,
    #[serde(default)]
    client: Option<String>,
}

async fn blocking_response(
    f: impl FnOnce() -> Response + Send + 'static,
    label: &'static str,
) -> Response {
    match tokio::task::spawn_blocking(f).await {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{label} task panicked: {e}"),
        )
            .into_response(),
    }
}

/// Lock the workspace-less tenant's in-memory session store. Recovers from a
/// poisoned lock (the critical sections are simple map ops that never leave
/// it inconsistent) so a session request can never itself panic the server.
fn ephemeral_lock(
    state: &AppState,
) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Vec<u8>>> {
    state
        .ephemeral_sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Broadcast a `session_changed` frame on the per-tenant `/ws` bus after a
/// successful session-blob write or delete, so a co-viewer of the same window
/// refetches the layout live. The frame carries the window id in `w`, echoes
/// the writer's nonce in `client` when one was supplied (the writer drops its
/// own frame), and marks a discard with `deleted:true`. No layout payload
/// rides along: the blob can carry team env secrets and the bus is
/// tenant-wide, so the receiver refetches over the authorized GET instead.
/// Built with serde_json because `w` and `client` are client-supplied. A
/// no-subscriber `send` is the only `Err` a broadcast yields, so it is
/// ignored.
fn broadcast_session_changed(state: &AppState, w: &str, client: Option<&str>, deleted: bool) {
    let mut frame = serde_json::json!({ "kind": "session_changed", "w": w });
    if let Some(client) = client {
        frame["client"] = client.into();
    }
    if deleted {
        frame["deleted"] = true.into();
    }
    let _ = state.events_tx.send(frame.to_string());
}

pub async fn api_get_session(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
) -> Response {
    let key = q.w;
    let Ok(workspace) = state.try_workspace() else {
        // Workspace-less terminal tenant: a persistent launcher store when one
        // is configured (a persisted devserver terminal), else the in-memory
        // store (control / desktop-local terminals).
        if let Some(dir) = state.terminal_session_dir.clone() {
            return blocking_response(
                move || match crate::terminal_blob::get(&dir, &key) {
                    Ok(Some(bytes)) => raw_json_response(bytes),
                    Ok(None) => StatusCode::NO_CONTENT.into_response(),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
                },
                "get terminal session",
            )
            .await;
        }
        return match ephemeral_lock(&state).get(&key) {
            Some(bytes) => raw_json_response(bytes.clone()),
            None => StatusCode::NO_CONTENT.into_response(),
        };
    };
    blocking_response(
        move || match workspace.get_session(&key) {
            Ok(Some(bytes)) => raw_json_response(bytes),
            // 204 NO_CONTENT, not 404: "no session yet" is the normal
            // first-launch state. transport.ts treats an empty 2xx body
            // as `undefined`; the api wrapper coerces that to `null`.
            Ok(None) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => err_from(&e),
        },
        "get session",
    )
    .await
}

pub async fn api_put_session(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
    body: Bytes,
) -> Response {
    let response = put_session_response(&state, q.w.clone(), body).await;
    if response.status().is_success() {
        broadcast_session_changed(&state, &q.w, q.client.as_deref(), false);
    }
    response
}

async fn put_session_response(state: &Arc<AppState>, key: String, body: Bytes) -> Response {
    // A saved layout blob makes this window PERSISTED: its detached terminal
    // sessions are kept alive (reattachable) instead of orphan-reaped. The SPA
    // PUTs only windows with durable content; an explicit discard DELETEs (see
    // `api_delete_session`). Marked regardless of which blob backend stores it.
    state.terminal_sessions.mark_window_persisted(&key);
    let Ok(workspace) = state.try_workspace() else {
        if let Some(dir) = state.terminal_session_dir.clone() {
            return blocking_response(
                move || match crate::terminal_blob::put(&dir, &key, &body) {
                    Ok(()) => StatusCode::NO_CONTENT.into_response(),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
                },
                "put terminal session",
            )
            .await;
        }
        ephemeral_lock(state).insert(key, body.to_vec());
        return StatusCode::NO_CONTENT.into_response();
    };
    blocking_response(
        move || match workspace.put_session(&key, &body) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => err_from(&e),
        },
        "put session",
    )
    .await
}

pub async fn api_delete_session(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
) -> Response {
    let moved = matches!(q.moved.as_deref(), Some("1"));
    let response = delete_session_response(&state, q.w.clone(), moved).await;
    if response.status().is_success() {
        broadcast_session_changed(&state, &q.w, q.client.as_deref(), true);
    }
    response
}

async fn delete_session_response(state: &Arc<AppState>, key: String, moved: bool) -> Response {
    // A DELETE either DISCARDS the window or signals a cross-window MOVE-OUT:
    // - `?w=W` (discard: ^W to empty / ^D / Ctrl+Shift+W (off-mac tab close) /
    //   Ctrl+Alt+W (off-mac window close) / an empty window):
    //   drop it from the persisted set AND reap its sessions (kill the PTYs,
    //   release the fds) -- the "discard ⇒ reap" half that frees a busy detached
    //   session the pruner keeps alive.
    // - `?w=W&moved=1`: the source window emptied because its tab
    //   moved to another window. Drop the blob + unpersist so it leaves
    //   `cs window list`, but do NOT reap; the moved PTY survives, and
    //   reattach re-binds it to the target window. Skipping the
    //   reap is the deterministic guard against the source DELETE racing ahead
    //   of the target's attach/rebind.
    // Either way the blob delete below runs (an unsaved window can still go).
    if moved {
        state.terminal_sessions.unpersist_window(&key);
    } else {
        state.terminal_sessions.forget_window(&key);
    }
    let Ok(workspace) = state.try_workspace() else {
        if let Some(dir) = state.terminal_session_dir.clone() {
            return blocking_response(
                move || match crate::terminal_blob::delete(&dir, &key) {
                    Ok(()) => StatusCode::NO_CONTENT.into_response(),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
                },
                "delete terminal session",
            )
            .await;
        }
        ephemeral_lock(state).remove(&key);
        return StatusCode::NO_CONTENT.into_response();
    };
    blocking_response(
        move || match workspace.delete_session(&key) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(e) => err_from(&e),
        },
        "delete session",
    )
    .await
}

pub async fn api_list_sessions(State(state): State<Arc<AppState>>) -> Response {
    let Ok(workspace) = state.try_workspace() else {
        if let Some(dir) = state.terminal_session_dir.clone() {
            return blocking_response(
                move || match crate::terminal_blob::list(&dir) {
                    Ok(keys) => Json(keys).into_response(),
                    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
                },
                "list terminal sessions",
            )
            .await;
        }
        let keys: Vec<String> = ephemeral_lock(&state).keys().cloned().collect();
        return Json(keys).into_response();
    };
    blocking_response(
        move || match workspace.list_sessions() {
            Ok(keys) => Json(keys).into_response(),
            Err(e) => err_from(&e),
        },
        "list sessions",
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Bytes;
    use axum::extract::{Query, State};
    use axum::http::StatusCode;

    use super::{api_delete_session, api_put_session, SessionQuery};
    use crate::state::test_support::make_test_state;

    fn query(w: &str, client: Option<&str>) -> Query<SessionQuery> {
        Query(SessionQuery {
            w: w.to_string(),
            moved: None,
            client: client.map(str::to_string),
        })
    }

    #[tokio::test]
    async fn put_session_broadcasts_session_changed_with_client_echo() {
        // Live layout sync: a co-viewer's SPA keys on a frame whose `kind` is
        // exactly "session_changed", matches `w`, and drops its own nonce in
        // `client`. Pin that wire contract.
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();
        let resp = api_put_session(
            State(state),
            query("w-abc", Some("nonce-1")),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let frame = rx.try_recv().expect("a frame on the /ws bus");
        let json: serde_json::Value = serde_json::from_str(&frame).expect("valid json frame");
        assert_eq!(json["kind"], "session_changed");
        assert_eq!(json["w"], "w-abc");
        assert_eq!(json["client"], "nonce-1");
        assert!(json.get("deleted").is_none(), "PUT is not a discard");
    }

    #[tokio::test]
    async fn put_session_without_client_omits_the_key() {
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();
        let resp = api_put_session(
            State(state),
            query("w-abc", None),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let json: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("frame")).expect("valid json");
        assert!(
            json.get("client").is_none(),
            "no nonce supplied, none echoed"
        );
    }

    #[tokio::test]
    async fn delete_session_broadcasts_deleted() {
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();
        let resp = api_delete_session(State(state), query("w-abc", Some("nonce-1"))).await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let json: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("frame")).expect("valid json");
        assert_eq!(json["kind"], "session_changed");
        assert_eq!(json["w"], "w-abc");
        assert_eq!(json["deleted"], true);
    }

    #[tokio::test]
    async fn session_changed_frame_escapes_client_supplied_strings() {
        // `w` and `client` come off the query string; the ephemeral backend
        // stores any key, so the frame must be real JSON, not a format!.
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();
        let resp = api_put_session(
            State(state),
            query("w-\"quote\\", Some("n\"1")),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let json: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("frame")).expect("valid json");
        assert_eq!(json["w"], "w-\"quote\\");
        assert_eq!(json["client"], "n\"1");
    }

    #[tokio::test]
    async fn failed_put_does_not_broadcast() {
        // Point the terminal-blob store at a key the store rejects: the write
        // 500s and no session_changed frame may ride the bus (a notify on a
        // failed write would make the co-viewer refetch a blob that never
        // changed, and mask the writer's error).
        let mut state = make_test_state(false);
        let dir = tempfile::tempdir().expect("tempdir");
        Arc::get_mut(&mut state)
            .expect("sole test ref")
            .terminal_session_dir = Some(dir.path().to_path_buf());
        let mut rx = state.events_tx.subscribe();
        let resp = api_put_session(
            State(state),
            query("../escape", Some("nonce-1")),
            Bytes::from_static(b"{}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(rx.try_recv().is_err(), "failed write must not notify");
    }

    #[test]
    fn session_routes_wrap_sync_workspace_io_in_spawn_blocking() {
        let source = include_str!("sessions.rs");

        assert!(source.contains("tokio::task::spawn_blocking(f)"));
        assert!(source.contains("move || match workspace.get_session(&key)"));
        assert!(source.contains("move || match workspace.put_session(&key, &body)"));
        assert!(source.contains("move || match workspace.delete_session(&key)"));
        assert!(source.contains("move || match workspace.list_sessions()"));
    }
}
