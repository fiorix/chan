//! Session blobs (`/api/session*`).
//!
//! chan-workspace owns the I/O (Workspace::{put,get,list,delete}_session).
//! chan-server is a thin HTTP shell; the JSON schema of session blobs
//! (window/pane layout) lives in the frontend, not here.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::error::{err, err_from};
use crate::extract::Query;
use crate::routes::blocking_response;
use crate::state::AppState;
use crate::util::raw_json_response;

#[derive(Deserialize)]
pub struct ResumeClient {
    holder: String,
}

/// An explicit reconnect from the detached client's cover. This restores an
/// operational holder claim, not an authentication credential.
pub async fn api_resume_client(
    State(state): State<Arc<AppState>>,
    crate::extract::Json(request): crate::extract::Json<ResumeClient>,
) -> Response {
    match state.client_sessions.registry.resume(&request.holder) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(message) => err(StatusCode::NOT_FOUND, message),
    }
}

/// Window id query param (`?w=<id>`) for session routes. `moved=1` (DELETE
/// only) marks a cross-window MOVE-OUT so the handler deletes the blob but does
/// NOT reap the window's sessions, and `session=<id>` names the terminal that
/// moved, the one session the window's later close spares. `moved=1` without
/// `session` is a terminal that moved before it learned its session id, and
/// the close spares every session bound to the window. Get / put ignore both. `client` is the writer's per-SPA-instance nonce, echoed on
/// the `session_changed` broadcast so the writer can drop its own frame; GET
/// accepts and ignores it. `app=files` addresses the Files blob namespace on a
/// workspace-less tenant (a `files/` child of the terminal blob dir, or the
/// sibling in-memory map), so a Terminal-mode client never restores a Files
/// layout; workspace tenants keep their one on-disk store and ignore it.
#[derive(Deserialize)]
pub struct SessionQuery {
    w: String,
    #[serde(default)]
    moved: Option<String>,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    app: Option<crate::app_query::AppQuery>,
}

/// `GET /api/sessions` query: `app=files` lists the Files namespace instead of
/// the ordinary Terminal one.
#[derive(Deserialize)]
pub struct SessionListQuery {
    #[serde(default)]
    app: Option<crate::app_query::AppQuery>,
}

/// The on-disk blob dir for a standalone namespace: the terminal blob dir
/// itself, or its `files/` child for `app=files`. `None` when this tenant has
/// no durable store (control / desktop-local terminals).
fn standalone_blob_dir(
    state: &AppState,
    app: Option<crate::app_query::AppQuery>,
) -> Option<std::path::PathBuf> {
    let dir = state.terminal_session_dir.clone()?;
    Some(match app {
        Some(crate::app_query::AppQuery::Files) => crate::terminal_blob::files_dir(&dir),
        None => dir,
    })
}

/// The in-memory session map for a standalone namespace, mirroring
/// [`standalone_blob_dir`] for store-less tenants.
fn ephemeral_map_lock(
    state: &AppState,
    app: Option<crate::app_query::AppQuery>,
) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Vec<u8>>> {
    let map = match app {
        Some(crate::app_query::AppQuery::Files) => &state.ephemeral_files_sessions,
        None => &state.ephemeral_sessions,
    };
    map.lock().unwrap_or_else(|e| e.into_inner())
}

/// Broadcast a `session_changed` frame on the per-tenant `/ws` bus after a
/// successful session-blob write or delete, so a co-viewer of the same window
/// refetches the layout live. Durable stores announce inside the write's
/// blocking task, so dropping the request cannot lose a committed change.
/// The frame carries the window id in `w`, echoes
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
        // store (control / desktop-local terminals). `app` picks the namespace.
        if let Some(dir) = standalone_blob_dir(&state, q.app) {
            return blocking_response(
                "get terminal session",
                move || match crate::terminal_blob::get(&dir, &key) {
                    Ok(Some(bytes)) => raw_json_response(bytes),
                    Ok(None) => StatusCode::NO_CONTENT.into_response(),
                    Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                },
            )
            .await;
        }
        return match ephemeral_map_lock(&state, q.app).get(&key) {
            Some(bytes) => raw_json_response(bytes.clone()),
            None => StatusCode::NO_CONTENT.into_response(),
        };
    };
    blocking_response("get session", move || match workspace.get_session(&key) {
        Ok(Some(bytes)) => raw_json_response(bytes),
        // 204 NO_CONTENT, not 404: "no session yet" is the normal
        // first-launch state. transport.ts treats an empty 2xx body
        // as `undefined`; the api wrapper coerces that to `null`.
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err_from(&e),
    })
    .await
}

pub async fn api_put_session(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
    crate::extract::Bytes(body): crate::extract::Bytes,
) -> Response {
    let key = q.w;
    let app = q.app;
    let client = q.client;
    // A saved layout blob makes this window PERSISTED: its detached terminal
    // sessions are kept alive (reattachable) instead of orphan-reaped. The SPA
    // PUTs only windows with durable content; an explicit discard DELETEs (see
    // `api_delete_session`). Marked regardless of which blob backend stores it.
    state.terminal_sessions.mark_window_persisted(&key);
    let Ok(workspace) = state.try_workspace() else {
        if let Some(dir) = standalone_blob_dir(&state, app) {
            return blocking_response(
                "put terminal session",
                move || match crate::terminal_blob::put(&dir, &key, &body) {
                    Ok(()) => {
                        #[cfg(test)]
                        tests::pause_after_write(&key);
                        broadcast_session_changed(&state, &key, client.as_deref(), false);
                        StatusCode::NO_CONTENT.into_response()
                    }
                    Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                },
            )
            .await;
        }
        ephemeral_map_lock(&state, app).insert(key.clone(), body.to_vec());
        broadcast_session_changed(&state, &key, client.as_deref(), false);
        return StatusCode::NO_CONTENT.into_response();
    };
    blocking_response("put session", move || {
        match workspace.put_session(&key, &body) {
            Ok(()) => {
                #[cfg(test)]
                tests::pause_after_write(&key);
                broadcast_session_changed(&state, &key, client.as_deref(), false);
                StatusCode::NO_CONTENT.into_response()
            }
            Err(e) => err_from(&e),
        }
    })
    .await
}

pub async fn api_delete_session(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionQuery>,
) -> Response {
    let moved = matches!(q.moved.as_deref(), Some("1"));
    let key = q.w;
    let app = q.app;
    let client = q.client;
    let moved_session = q.session.as_deref();
    // A DELETE either DISCARDS the window or signals a cross-window MOVE-OUT:
    // - `?w=W` (discard: ^W to empty / ^D / Ctrl+Shift+W (off-mac tab close) /
    //   Ctrl+Alt+W (off-mac window close) / an empty window):
    //   drop it from the persisted set AND reap its sessions (kill the PTYs,
    //   release the fds) -- the "discard ⇒ reap" half that frees a busy detached
    //   session the pruner keeps alive.
    // - `?w=W&moved=1&session=S`: the source window emptied because its tab
    //   moved to another window. Drop the blob + unpersist so it leaves
    //   `cs window list`, but do NOT reap; the moved PTY `S` survives, and
    //   reattach re-binds it to the target window. Skipping the
    //   reap is the deterministic guard against the source DELETE racing ahead
    //   of the target's attach/rebind.
    // Either way the blob delete below runs (an unsaved window can still go).
    if moved {
        state
            .terminal_sessions
            .unpersist_window(&key, moved_session);
    } else {
        state.terminal_sessions.forget_window(&key);
    }
    let Ok(workspace) = state.try_workspace() else {
        if let Some(dir) = standalone_blob_dir(&state, app) {
            return blocking_response("delete terminal session", move || {
                match crate::terminal_blob::delete(&dir, &key) {
                    Ok(()) => {
                        #[cfg(test)]
                        tests::pause_after_write(&key);
                        broadcast_session_changed(&state, &key, client.as_deref(), true);
                        StatusCode::NO_CONTENT.into_response()
                    }
                    Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                }
            })
            .await;
        }
        ephemeral_map_lock(&state, app).remove(&key);
        broadcast_session_changed(&state, &key, client.as_deref(), true);
        return StatusCode::NO_CONTENT.into_response();
    };
    blocking_response("delete session", move || {
        match workspace.delete_session(&key) {
            Ok(()) => {
                #[cfg(test)]
                tests::pause_after_write(&key);
                broadcast_session_changed(&state, &key, client.as_deref(), true);
                StatusCode::NO_CONTENT.into_response()
            }
            Err(e) => err_from(&e),
        }
    })
    .await
}

pub async fn api_list_sessions(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SessionListQuery>,
) -> Response {
    let Ok(workspace) = state.try_workspace() else {
        if let Some(dir) = standalone_blob_dir(&state, q.app) {
            return blocking_response("list terminal sessions", move || {
                match crate::terminal_blob::list(&dir) {
                    Ok(keys) => Json(keys).into_response(),
                    Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
                }
            })
            .await;
        }
        let keys: Vec<String> = ephemeral_map_lock(&state, q.app).keys().cloned().collect();
        return Json(keys).into_response();
    };
    blocking_response("list sessions", move || match workspace.list_sessions() {
        Ok(keys) => Json(keys).into_response(),
        Err(e) => err_from(&e),
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::extract::Query;
    use axum::body::{to_bytes, Bytes};
    use axum::extract::State;
    use axum::http::StatusCode;
    use tempfile::TempDir;

    use super::{
        api_delete_session, api_get_session, api_list_sessions, api_put_session, SessionListQuery,
        SessionQuery,
    };
    use crate::state::test_support::{
        assert_uses_blocking_pool, make_test_state, workspace_app_state,
    };
    use crate::state::AppState;

    fn query(w: &str, client: Option<&str>) -> Query<SessionQuery> {
        Query(SessionQuery {
            w: w.to_string(),
            moved: None,
            session: None,
            client: client.map(str::to_string),
            app: None,
        })
    }

    fn files_query(w: &str) -> Query<SessionQuery> {
        Query(SessionQuery {
            w: w.to_string(),
            moved: None,
            session: None,
            client: None,
            app: Some(crate::app_query::AppQuery::Files),
        })
    }

    #[tokio::test]
    async fn the_files_marker_addresses_a_separate_ephemeral_namespace() {
        // A layout PUT with `app=files` must not land in the plain map: the
        // same window booted against a host that serves no filesystem would
        // otherwise restore browser/editor tabs against routes it lacks.
        let state = make_test_state(false);
        let resp = api_put_session(
            State(state.clone()),
            files_query("w-files"),
            crate::extract::Bytes(Bytes::from_static(b"{\"files\":true}")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(
            state
                .ephemeral_sessions
                .lock()
                .unwrap()
                .get("w-files")
                .is_none(),
            "the Terminal namespace must not see a Files blob"
        );
        assert!(state
            .ephemeral_files_sessions
            .lock()
            .unwrap()
            .get("w-files")
            .is_some());

        // A DELETE without the app leaves the Files blob; with it, reaps it.
        let resp = api_delete_session(State(state.clone()), query("w-files", None)).await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(state
            .ephemeral_files_sessions
            .lock()
            .unwrap()
            .get("w-files")
            .is_some());
        let resp = api_delete_session(State(state.clone()), files_query("w-files")).await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(state
            .ephemeral_files_sessions
            .lock()
            .unwrap()
            .get("w-files")
            .is_none());
    }

    #[tokio::test]
    async fn the_files_marker_addresses_the_files_child_blob_dir() {
        let mut state = make_test_state(false);
        let dir = tempfile::tempdir().expect("tempdir");
        Arc::get_mut(&mut state)
            .expect("sole test ref")
            .terminal_session_dir = Some(dir.path().to_path_buf());
        let resp = api_put_session(
            State(state.clone()),
            files_query("w-files"),
            crate::extract::Bytes(Bytes::from_static(b"{}")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(
            crate::terminal_blob::get(dir.path(), "w-files")
                .unwrap()
                .is_none(),
            "the Terminal namespace must not see a Files blob"
        );
        assert!(
            crate::terminal_blob::get(&crate::terminal_blob::files_dir(dir.path()), "w-files")
                .unwrap()
                .is_some()
        );
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
            crate::extract::Bytes(Bytes::from_static(b"{}")),
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
            crate::extract::Bytes(Bytes::from_static(b"{}")),
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
    async fn a_move_out_delete_spares_only_the_session_it_names() {
        // The source window emptied because one terminal moved away; a second
        // terminal still bound to it is detached (no tab shows it). The
        // move-out DELETE names the moved session, and the host's close of
        // the emptied window must reap the other one at once rather than
        // leave it to the orphan idle timeout.
        let state = make_test_state(false);
        let create = || crate::terminal_sessions::CreateOptions {
            size: portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
            tab_name: None,
            tab_group: None,
            window_id: Some("w-source".to_string()),
            mcp_env: false,
            cwd: None,
            command: Some("sleep 30".into()),
            env: Default::default(),
            profile: None,
        };
        let moved = state.terminal_sessions.create(create()).unwrap();
        let detached = state.terminal_sessions.create(create()).unwrap();
        let (moved_id, detached_id) = (moved.id().to_string(), detached.id().to_string());
        drop(moved);
        drop(detached);

        let uri: axum::http::Uri = format!("/api/session?w=w-source&moved=1&session={moved_id}")
            .parse()
            .unwrap();
        let resp = api_delete_session(
            State(state.clone()),
            Query(axum::extract::Query::try_from_uri(&uri).unwrap().0),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            state.terminal_sessions.len(),
            2,
            "the move-out DELETE reaps nothing"
        );

        assert_eq!(
            state.terminal_sessions.forget_window("w-source"),
            1,
            "the emptied window's close reaps the detached session the move did not carry"
        );
        let live: Vec<String> = state
            .terminal_sessions
            .roster()
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert_eq!(live, vec![moved_id], "only the moved session survives");
        assert!(!live.contains(&detached_id));

        // A terminal that moved before its session id reached the SPA: the
        // DELETE says a terminal moved but not which, so the close spares
        // every session still bound to the window.
        let unbound = || crate::terminal_sessions::CreateOptions {
            window_id: Some("w-unbound".to_string()),
            ..create()
        };
        let first = state.terminal_sessions.create(unbound()).unwrap();
        let second = state.terminal_sessions.create(unbound()).unwrap();
        drop(first);
        drop(second);
        let uri: axum::http::Uri = "/api/session?w=w-unbound&moved=1".parse().unwrap();
        let resp = api_delete_session(
            State(state.clone()),
            Query(axum::extract::Query::try_from_uri(&uri).unwrap().0),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            state.terminal_sessions.forget_window("w-unbound"),
            0,
            "a move-out without a session id spares every session bound to the window"
        );
        assert_eq!(state.terminal_sessions.len(), 3);
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
            crate::extract::Bytes(Bytes::from_static(b"{}")),
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
            crate::extract::Bytes(Bytes::from_static(b"{}")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(rx.try_recv().is_err(), "failed write must not notify");
    }

    struct WriteGate {
        entered: tokio::sync::oneshot::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }

    static WRITE_GATES: std::sync::LazyLock<
        std::sync::Mutex<std::collections::HashMap<String, WriteGate>>,
    > = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

    // Hold the completed write inside its blocking task, so dropping the
    // request cannot race that task's return and its handler's next poll.
    pub(super) fn pause_after_write(key: &str) {
        let gate = WRITE_GATES.lock().unwrap().remove(key);
        if let Some(gate) = gate {
            let _ = gate.entered.send(());
            match gate
                .release
                .recv_timeout(std::time::Duration::from_secs(10))
            {
                Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("session write gate was not released")
                }
            }
        }
    }

    struct ReleaseWrite {
        key: String,
        release: std::sync::mpsc::Sender<()>,
    }

    impl Drop for ReleaseWrite {
        fn drop(&mut self) {
            WRITE_GATES.lock().unwrap().remove(&self.key);
            let _ = self.release.send(());
        }
    }

    async fn cancelled_request_announces(state: Arc<AppState>, key: String, deleted: bool) {
        use axum::body::Body;
        use axum::http::{Method, Request};
        use axum::routing::put;
        use std::time::Duration;
        use tower::ServiceExt;

        const BODY: &[u8] = b"{\"saved\":true}";
        let workspace = state.try_workspace().ok();
        let read = || match &workspace {
            Some(workspace) => workspace.get_session(&key).unwrap(),
            None => crate::terminal_blob::get(state.terminal_session_dir.as_ref().unwrap(), &key)
                .unwrap(),
        };
        if deleted {
            match &workspace {
                Some(workspace) => workspace.put_session(&key, BODY).unwrap(),
                None => crate::terminal_blob::put(
                    state.terminal_session_dir.as_ref().unwrap(),
                    &key,
                    BODY,
                )
                .unwrap(),
            }
            assert_eq!(read().as_deref(), Some(BODY));
        } else {
            assert_eq!(read(), None);
        }

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        assert!(WRITE_GATES
            .lock()
            .unwrap()
            .insert(
                key.clone(),
                WriteGate {
                    entered: entered_tx,
                    release: release_rx
                }
            )
            .is_none());
        let release = ReleaseWrite {
            key: key.clone(),
            release: release_tx,
        };
        let mut events = state.events_tx.subscribe();
        let router = axum::Router::new()
            .route(
                "/api/session",
                put(api_put_session).delete(api_delete_session),
            )
            .with_state(state.clone());
        let request = Request::builder()
            .method(if deleted { Method::DELETE } else { Method::PUT })
            .uri(format!("/api/session?w={key}&client=cancelled-writer"))
            .body(Body::from(BODY))
            .unwrap();
        let request = tokio::spawn(router.oneshot(request));
        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .expect("session write never reached its held success arm")
            .unwrap();
        assert_eq!(read().as_deref(), if deleted { None } else { Some(BODY) });
        assert!(!request.is_finished(), "the write task must still be held");
        assert!(
            events.try_recv().is_err(),
            "the announcement must follow the held write"
        );

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        drop(release);
        let frame = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("stored session change lost its announcement after request cancellation")
            .unwrap();
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        let mut expected = serde_json::json!({
            "kind": "session_changed", "w": key, "client": "cancelled-writer",
        });
        if deleted {
            expected["deleted"] = true.into();
        }
        assert_eq!(frame, expected);
        assert!(events.try_recv().is_err(), "one write must announce once");
    }

    #[tokio::test]
    async fn cancelled_workspace_put_still_announces() {
        let (cfg, _root, state) = workspace_state();
        let key = format!("w-{}", cfg.path().file_name().unwrap().to_str().unwrap());
        cancelled_request_announces(state, key, false).await;
    }

    #[tokio::test]
    async fn cancelled_workspace_delete_still_announces() {
        let (cfg, _root, state) = workspace_state();
        let key = format!("w-{}", cfg.path().file_name().unwrap().to_str().unwrap());
        cancelled_request_announces(state, key, true).await;
    }

    #[tokio::test]
    async fn cancelled_terminal_put_still_announces() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = make_test_state(false);
        Arc::get_mut(&mut state).unwrap().terminal_session_dir = Some(dir.path().to_path_buf());
        let key = format!("w-{}", dir.path().file_name().unwrap().to_str().unwrap());
        cancelled_request_announces(state, key, false).await;
    }

    #[tokio::test]
    async fn cancelled_terminal_delete_still_announces() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = make_test_state(false);
        Arc::get_mut(&mut state).unwrap().terminal_session_dir = Some(dir.path().to_path_buf());
        let key = format!("w-{}", dir.path().file_name().unwrap().to_str().unwrap());
        cancelled_request_announces(state, key, true).await;
    }

    /// The runtime `assert_uses_blocking_pool` needs: one blocking thread,
    /// which the helper holds while it drives the handler.
    fn one_blocking_thread_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap()
    }

    /// A state with a registered workspace, so the session routes take their
    /// workspace arm rather than the workspace-less terminal stores.
    fn workspace_state() -> (TempDir, TempDir, Arc<AppState>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let state = Arc::new(workspace_app_state(
            lib,
            root.path().to_path_buf(),
            workspace,
        ));
        (cfg, root, state)
    }

    #[test]
    fn api_get_session_runs_off_runtime_thread() {
        one_blocking_thread_runtime().block_on(async {
            let (_cfg, _root, state) = workspace_state();
            let workspace = state.try_workspace().unwrap();
            workspace.put_session("win-1", b"{\"saved\":true}").unwrap();
            let resp =
                assert_uses_blocking_pool(api_get_session(State(state), query("win-1", None)))
                    .await;
            assert_eq!(resp.status(), StatusCode::OK);
            let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            assert_eq!(&body[..], b"{\"saved\":true}");
        });
    }

    #[test]
    fn api_put_session_runs_off_runtime_thread() {
        one_blocking_thread_runtime().block_on(async {
            let (_cfg, _root, state) = workspace_state();
            let workspace = state.try_workspace().unwrap();
            let resp = assert_uses_blocking_pool(api_put_session(
                State(state),
                query("win-1", None),
                crate::extract::Bytes(Bytes::from_static(b"{\"saved\":true}")),
            ))
            .await;
            assert_eq!(resp.status(), StatusCode::NO_CONTENT);
            assert_eq!(
                workspace.get_session("win-1").unwrap().as_deref(),
                Some(&b"{\"saved\":true}"[..])
            );
        });
    }

    #[test]
    fn api_delete_session_runs_off_runtime_thread() {
        one_blocking_thread_runtime().block_on(async {
            let (_cfg, _root, state) = workspace_state();
            let workspace = state.try_workspace().unwrap();
            workspace.put_session("win-1", b"{}").unwrap();
            let resp =
                assert_uses_blocking_pool(api_delete_session(State(state), query("win-1", None)))
                    .await;
            assert_eq!(resp.status(), StatusCode::NO_CONTENT);
            assert_eq!(workspace.get_session("win-1").unwrap(), None);
        });
    }

    #[test]
    fn api_list_sessions_runs_off_runtime_thread() {
        one_blocking_thread_runtime().block_on(async {
            let (_cfg, _root, state) = workspace_state();
            state
                .try_workspace()
                .unwrap()
                .put_session("win-1", b"{}")
                .unwrap();
            let resp = assert_uses_blocking_pool(api_list_sessions(
                State(state),
                Query(SessionListQuery { app: None }),
            ))
            .await;
            assert_eq!(resp.status(), StatusCode::OK);
            let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
            let keys: Vec<String> = serde_json::from_slice(&body).unwrap();
            assert_eq!(keys, vec!["win-1".to_string()]);
        });
    }
}
