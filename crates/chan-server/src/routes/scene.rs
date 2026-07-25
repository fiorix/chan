//! Live Excalidraw scene sessions: the `/api/scene/ws` WebSocket
//! route.
//!
//! One duplex socket per (canvas mount, scene) attachment, modeled on
//! the doc route: scene traffic is per-path and a lost frame would
//! silently diverge a peer, so every attachment gets its own lossless
//! per-socket FIFO. chan-server is the central authority in an
//! element-level last-writer-wins model: clients push `{elements,
//! appState?, files?}`, the authority merges each element by
//! Excalidraw's version/versionNonce rule and fans the accepted values
//! to the other attachments. There is no version gate, no rebase, and
//! no incremental catch-up: every (re)attach gets a full snapshot,
//! tombstones included.
//!
//! The frame enums below ARE the wire contract the SPA's sceneSync
//! layer builds against; the serde tests in this module pin every tag,
//! field name, and shape. Change a pin only together with the client.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::scene_sessions::scene::SceneError;
use crate::scene_sessions::PushError;
use crate::signal::now_unix_secs;
use crate::state::AppState;

/// Query parameters for `GET /api/scene/ws`.
#[derive(Debug, Deserialize)]
pub struct SceneQuery {
    /// Workspace-relative POSIX path of the scene to attach.
    path: String,
    /// The attaching window's `window_id`. Presence only: it labels
    /// this attachment's cursor via the session roster (two panes of
    /// one window may attach the same scene).
    w: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientFrame {
    /// Submit locally-changed elements (and optionally the whole
    /// appState object and newly-added file entries). Elements always
    /// merge through the authority's LWW rule; a push is never stale.
    /// `elements` is required (an appState-only push sends `[]`).
    #[serde(rename = "push")]
    Push {
        elements: Vec<Value>,
        #[serde(default, rename = "appState")]
        app_state: Option<Value>,
        #[serde(default)]
        files: Option<Value>,
    },
    /// Local pointer moved. Canvas coordinates, client-throttled; the
    /// server stores the latest and fans to the other attachments.
    #[serde(rename = "cursor")]
    Cursor {
        x: f64,
        y: f64,
        #[serde(default)]
        tool: Option<String>,
        #[serde(default)]
        selected: Option<Vec<String>>,
    },
}

/// A peer cursor as other attachments see it. `id` is the server
/// attach id, NOT the window id; `w` is the owning window, resolved to
/// a display name through the session roster.
#[derive(Debug, Serialize)]
pub(crate) struct PeerSceneCursor {
    pub(crate) id: u64,
    pub(crate) w: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selected: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub(crate) enum ServerFrame {
    /// Full scene state: answers every attach and any hard resync.
    /// `elements` includes tombstones so a stale local element cannot
    /// win reconciliation against a delete. `mtime_ns` is the
    /// flushed-to-disk CAS token as a decimal string (the `/api/files`
    /// convention), null when the disk state is unknown.
    #[serde(rename = "snapshot")]
    Snapshot {
        path: String,
        version: u64,
        elements: Vec<Value>,
        #[serde(rename = "appState")]
        app_state: Value,
        files: Value,
        dirty: bool,
        mtime_ns: Option<String>,
        cursors: Vec<PeerSceneCursor>,
    },
    /// One accepted mutation's values, fanned to the OTHER attachments
    /// (the sender's confirmation is its `push-ok`; there is no
    /// own-echo). `appState` and `files` appear only when the mutation
    /// carried them; `version` is the session version after the
    /// commit.
    #[serde(rename = "update")]
    Update {
        version: u64,
        elements: Vec<Value>,
        #[serde(rename = "appState", skip_serializing_if = "Option::is_none")]
        app_state: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        files: Option<Value>,
    },
    /// The in-flight push merged; `version` is the session version
    /// after the merge (unchanged when every pushed element lost the
    /// merge).
    #[serde(rename = "push-ok")]
    PushOk { version: u64 },
    /// A peer's pointer moved. Same fields as a `snapshot.cursors`
    /// entry.
    #[serde(rename = "cursor")]
    Cursor {
        id: u64,
        w: String,
        x: f64,
        y: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        selected: Option<Vec<String>>,
    },
    /// A peer detached; drop its cursor.
    #[serde(rename = "cursor-gone")]
    CursorGone { id: u64 },
    /// The authority flushed to disk (`dirty: false` plus the fresh
    /// `mtime_ns` token) or repeatedly failed to (an `error` message;
    /// the session stays live and the content is safe in memory and in
    /// every client). Clients stamp `savedMtimeNs` from `mtime_ns`.
    #[serde(rename = "flush")]
    Flush {
        dirty: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        mtime_ns: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// The file vanished on disk. The client routes into its
    /// missing-file machinery; the server keeps the session but stops
    /// flushing.
    #[serde(rename = "removed")]
    Removed,
    /// Protocol error (malformed frame, bad element payload, oversized
    /// scene), followed by the server closing this attachment.
    #[serde(rename = "error")]
    Error {
        message: String,
        reason: &'static str,
    },
    /// Registry-initiated teardown (storage reset, metadata import,
    /// shutdown).
    #[serde(rename = "closed")]
    Closed { reason: &'static str },
}

pub async fn api_scene_ws(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SceneQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // A missing workspace still upgrades and answers an error FRAME
    // before closing, symmetric with attach failures: a zero-frame
    // handshake failure on the page load's first dial would latch the
    // SPA's capability probe to "no scene sync" for the whole page
    // load.
    let workspace = state.try_workspace();
    ws.on_upgrade(move |mut socket| async move {
        match workspace {
            Ok(workspace) => scene_ws(socket, state, workspace, query).await,
            Err(e) => error_close(&mut socket, &e.to_string(), "no-workspace").await,
        }
    })
    .into_response()
}

async fn scene_ws(
    mut socket: WebSocket,
    state: Arc<AppState>,
    workspace: Arc<chan_workspace::Workspace>,
    query: SceneQuery,
) {
    state
        .last_activity
        .store(now_unix_secs(), Ordering::Relaxed);
    let mut handle = match state
        .scene_sessions
        .attach(&workspace, &query.path, &query.w)
        .await
    {
        Ok(handle) => handle,
        Err(e) => {
            // The error FRAME must precede the close: the SPA's
            // capability probe reads a close-before-any-frame as "old
            // server, no scene sync" and would latch sceneSync off
            // module-wide over a mere bad path.
            error_close(&mut socket, &e.to_string(), "attach-failed").await;
            return;
        }
    };
    let mut frames = handle.take_frames();
    let mut shutdown_rx = state.shutdown_rx.clone();

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => {
                // The flusher's shutdown pass flushes every session and
                // fans `closed{shutdown}`; this socket just says goodbye.
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1001,
                        reason: "server shutdown".into(),
                    })))
                    .await;
                break;
            }
            msg = socket.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    Ok(Message::Text(text)) => match serde_json::from_str::<ClientFrame>(&text) {
                        Ok(ClientFrame::Push { elements, app_state, files }) => {
                            state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            if let Err(e) = handle.push(elements, app_state, files) {
                                error_close(&mut socket, &e.to_string(), push_error_reason(&e))
                                    .await;
                                break;
                            }
                        }
                        Ok(ClientFrame::Cursor { x, y, tool, selected }) => {
                            state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            handle.cursor(x, y, tool, selected);
                        }
                        Err(e) => {
                            // A frame this route cannot parse means a
                            // desynced or drifted peer: per the contract,
                            // error loudly and close, never a silent drop.
                            error_close(
                                &mut socket,
                                &format!("invalid scene frame: {e}"),
                                "malformed-frame",
                            )
                            .await;
                            break;
                        }
                    },
                    // The contract is JSON text frames only; binary is a
                    // drifted peer, same loud path as malformed JSON.
                    Ok(Message::Binary(_)) => {
                        error_close(
                            &mut socket,
                            "binary frames are not in the scene contract",
                            "malformed-frame",
                        )
                        .await;
                        break;
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                    Err(_) => break,
                }
            }
            frame = frames.recv() => {
                match frame {
                    // Frames are pre-serialized under the session state
                    // lock; forward verbatim so per-socket order stays
                    // consistent.
                    Some(raw) => {
                        if socket.send(Message::text(raw)).await.is_err() {
                            break;
                        }
                    }
                    // Outbox senders gone: registry teardown (`closed`
                    // was the final frame) or this attach was evicted.
                    None => {
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: 1000,
                                reason: "scene session closed".into(),
                            })))
                            .await;
                        break;
                    }
                }
            }
        }
    }
    // Dropping `handle` detaches: cursor-gone fan; a 1->0 transition
    // stamps the detach grace and requests a prompt flush.
}

/// Map a rejected push onto the contract's `error.reason` values.
/// `doc-too-large` matches the doc route's permanent-degrade reason so
/// the client treats both sync flavors' capacity errors identically.
fn push_error_reason(e: &PushError) -> &'static str {
    match e {
        PushError::Scene(SceneError::TooLarge { .. }) => "doc-too-large",
        PushError::Scene(SceneError::Invalid(_)) => "bad-scene",
        PushError::Closed => "session-closed",
    }
}

/// The contract's loud goodbye: an `error` frame naming the reason,
/// then a policy-violation close. Send failures are ignored (the peer
/// may already be gone); dropping the attach handle afterwards is what
/// actually detaches.
async fn error_close(socket: &mut WebSocket, message: &str, reason: &'static str) {
    let frame = ServerFrame::Error {
        message: message.to_string(),
        reason,
    };
    let _ = socket
        .send(Message::text(serde_json::to_string(&frame).unwrap_or_else(
            |e| format!(r#"{{"type":"error","message":"serialize failed: {e}"}}"#),
        )))
        .await;
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: reason.into(),
        })))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene_sessions::SceneRegistry;
    use serde_json::json;
    use tempfile::TempDir;

    fn enc(frame: &ServerFrame) -> String {
        serde_json::to_string(frame).expect("serialize server frame")
    }

    // ---- client -> server ----------------------------------------------

    #[test]
    fn client_push_decodes_the_pinned_shape() {
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"push","elements":[{"id":"x","version":2,"versionNonce":7}],
                "appState":{"gridSize":20},"files":{"f1":{"dataURL":"data:x"}}}"#,
        )
        .unwrap();
        match frame {
            ClientFrame::Push {
                elements,
                app_state,
                files,
            } => {
                assert_eq!(elements.len(), 1);
                assert_eq!(elements[0]["id"], "x");
                assert_eq!(app_state, Some(json!({"gridSize": 20})));
                assert_eq!(files, Some(json!({"f1": {"dataURL": "data:x"}})));
            }
            other => panic!("expected Push, got {other:?}"),
        }

        // appState and files are optional; elements is not (an
        // appState-only push sends []).
        let frame: ClientFrame = serde_json::from_str(r#"{"type":"push","elements":[]}"#).unwrap();
        let ClientFrame::Push {
            elements,
            app_state,
            files,
        } = frame
        else {
            panic!("expected Push");
        };
        assert!(elements.is_empty());
        assert!(app_state.is_none());
        assert!(files.is_none());
        assert!(
            serde_json::from_str::<ClientFrame>(r#"{"type":"push"}"#).is_err(),
            "elements is required"
        );
    }

    #[test]
    fn client_cursor_decodes_with_optional_tool_and_selection() {
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"cursor","x":10.5,"y":-3,"tool":"freedraw","selected":["a","b"]}"#,
        )
        .unwrap();
        match frame {
            ClientFrame::Cursor {
                x,
                y,
                tool,
                selected,
            } => {
                assert_eq!(x, 10.5);
                assert_eq!(y, -3.0);
                assert_eq!(tool.as_deref(), Some("freedraw"));
                assert_eq!(selected, Some(vec!["a".to_string(), "b".to_string()]));
            }
            other => panic!("expected Cursor, got {other:?}"),
        }
        let frame: ClientFrame = serde_json::from_str(r#"{"type":"cursor","x":0,"y":0}"#).unwrap();
        let ClientFrame::Cursor { tool, selected, .. } = frame else {
            panic!("expected Cursor");
        };
        assert!(tool.is_none());
        assert!(selected.is_none());
    }

    #[test]
    fn client_unknown_or_malformed_frames_reject() {
        // Unknown tags and missing fields are protocol errors (the
        // route answers `error` + close, never a silent drop), so the
        // decode itself must fail.
        for bad in [
            r#"{"type":"nope"}"#,
            r#"{"elements":[]}"#,
            r#"{"type":"pull","version":1}"#,
            r#"{"type":"cursor","x":1}"#,
            r#"{"type":"cursor","x":"a","y":2}"#,
        ] {
            assert!(
                serde_json::from_str::<ClientFrame>(bad).is_err(),
                "must reject: {bad}"
            );
        }
    }

    // ---- server -> client ----------------------------------------------

    #[test]
    fn server_snapshot_pins_the_wire_shape() {
        let full = ServerFrame::Snapshot {
            path: "boards/b.excalidraw".into(),
            version: 3,
            elements: vec![json!({"id":"x","version":1,"versionNonce":2,"isDeleted":false})],
            app_state: json!({"gridSize": 20}),
            files: json!({"f1": {"dataURL": "data:x"}}),
            dirty: false,
            mtime_ns: Some("1751234567890123456".into()),
            cursors: vec![PeerSceneCursor {
                id: 7,
                w: "win-1".into(),
                x: 4.5,
                y: 6.0,
                tool: None,
                selected: None,
            }],
        };
        assert_eq!(
            enc(&full),
            r#"{"type":"snapshot","path":"boards/b.excalidraw","version":3,"elements":[{"id":"x","isDeleted":false,"version":1,"versionNonce":2}],"appState":{"gridSize":20},"files":{"f1":{"dataURL":"data:x"}},"dirty":false,"mtime_ns":"1751234567890123456","cursors":[{"id":7,"w":"win-1","x":4.5,"y":6.0}]}"#
        );
        // Disk state unknown (e.g. after `removed`): mtime_ns is null,
        // not omitted; the client stamps savedMtimeNs unconditionally.
        let unknown = ServerFrame::Snapshot {
            path: "b".into(),
            version: 0,
            elements: vec![],
            app_state: json!({}),
            files: json!({}),
            dirty: true,
            mtime_ns: None,
            cursors: vec![],
        };
        assert_eq!(
            enc(&unknown),
            r#"{"type":"snapshot","path":"b","version":0,"elements":[],"appState":{},"files":{},"dirty":true,"mtime_ns":null,"cursors":[]}"#
        );
    }

    #[test]
    fn server_update_and_push_ok_pin_the_wire_shape() {
        let update = ServerFrame::Update {
            version: 4,
            elements: vec![json!({"id":"x","version":6,"versionNonce":9,"isDeleted":false})],
            app_state: None,
            files: None,
        };
        assert_eq!(
            enc(&update),
            r#"{"type":"update","version":4,"elements":[{"id":"x","isDeleted":false,"version":6,"versionNonce":9}]}"#
        );
        let full = ServerFrame::Update {
            version: 5,
            elements: vec![],
            app_state: Some(json!({"viewBackgroundColor": "#fff"})),
            files: Some(json!({"f2": {"dataURL": "data:y"}})),
        };
        assert_eq!(
            enc(&full),
            r##"{"type":"update","version":5,"elements":[],"appState":{"viewBackgroundColor":"#fff"},"files":{"f2":{"dataURL":"data:y"}}}"##
        );
        assert_eq!(
            enc(&ServerFrame::PushOk { version: 5 }),
            r#"{"type":"push-ok","version":5}"#
        );
    }

    #[test]
    fn server_cursor_frames_pin_the_wire_shape() {
        let moved = ServerFrame::Cursor {
            id: 7,
            w: "win-1".into(),
            x: 10.0,
            y: 20.25,
            tool: Some("selection".into()),
            selected: Some(vec!["x".into()]),
        };
        assert_eq!(
            enc(&moved),
            r#"{"type":"cursor","id":7,"w":"win-1","x":10.0,"y":20.25,"tool":"selection","selected":["x"]}"#
        );
        let bare = ServerFrame::Cursor {
            id: 7,
            w: "win-1".into(),
            x: 0.0,
            y: 0.0,
            tool: None,
            selected: None,
        };
        assert_eq!(
            enc(&bare),
            r#"{"type":"cursor","id":7,"w":"win-1","x":0.0,"y":0.0}"#
        );
        assert_eq!(
            enc(&ServerFrame::CursorGone { id: 7 }),
            r#"{"type":"cursor-gone","id":7}"#
        );
    }

    #[test]
    fn server_flush_pins_success_and_failure_shapes() {
        let clean = ServerFrame::Flush {
            dirty: false,
            mtime_ns: Some("1751234567890123456".into()),
            error: None,
        };
        assert_eq!(
            enc(&clean),
            r#"{"type":"flush","dirty":false,"mtime_ns":"1751234567890123456"}"#
        );
        let failed = ServerFrame::Flush {
            dirty: true,
            mtime_ns: None,
            error: Some("write failed".into()),
        };
        assert_eq!(
            enc(&failed),
            r#"{"type":"flush","dirty":true,"error":"write failed"}"#
        );
    }

    #[test]
    fn server_lifecycle_frames_pin_the_wire_shape() {
        assert_eq!(enc(&ServerFrame::Removed), r#"{"type":"removed"}"#);
        assert_eq!(
            enc(&ServerFrame::Error {
                message: "bad element".into(),
                reason: "bad-scene",
            }),
            r#"{"type":"error","message":"bad element","reason":"bad-scene"}"#
        );
        assert_eq!(
            enc(&ServerFrame::Closed { reason: "reset" }),
            r#"{"type":"closed","reason":"reset"}"#
        );
    }

    #[test]
    fn scene_query_decodes_path_and_w() {
        // Axum's Query extractor deserializes through serde exactly
        // like this; pin the parameter names the SPA puts in the URL.
        let q: SceneQuery =
            serde_json::from_str(r#"{"path":"boards/b.excalidraw","w":"win-1"}"#).unwrap();
        assert_eq!(q.path, "boards/b.excalidraw");
        assert_eq!(q.w, "win-1");
        assert!(serde_json::from_str::<SceneQuery>(r#"{"path":"a"}"#).is_err());
        assert!(serde_json::from_str::<SceneQuery>(r#"{"w":"win-1"}"#).is_err());
    }

    #[test]
    fn push_error_reasons_are_pinned() {
        assert_eq!(
            push_error_reason(&PushError::Scene(SceneError::TooLarge {
                bytes: 3,
                limit: 2
            })),
            "doc-too-large"
        );
        assert_eq!(
            push_error_reason(&PushError::Scene(SceneError::Invalid("x"))),
            "bad-scene"
        );
        assert_eq!(push_error_reason(&PushError::Closed), "session-closed");
    }

    // ---- two scripted clients over the attach-handle surface ------------

    fn fixture(files: &[(&str, &str)]) -> (TempDir, TempDir, Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().expect("temp config");
        let root = TempDir::new().expect("temp workspace");
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        for (path, content) in files {
            workspace.write_text(path, content).unwrap();
        }
        (cfg, root, workspace)
    }

    #[tokio::test]
    async fn two_clients_converge_and_lww_losers_stay_silent() {
        let (_cfg, _root, workspace) = fixture(&[(
            "b.excalidraw",
            r#"{"type":"excalidraw","version":2,"source":"t","elements":[],"appState":{},"files":{}}"#,
        )]);
        let registry = Arc::new(SceneRegistry::new());
        let mut a = registry
            .attach(&workspace, "b.excalidraw", "win-a")
            .await
            .unwrap();
        let mut b = registry
            .attach(&workspace, "b.excalidraw", "win-b")
            .await
            .unwrap();
        let mut rxa = a.take_frames();
        let mut rxb = b.take_frames();
        // Both start from the snapshot.
        assert!(rxa.try_recv().unwrap().contains("\"snapshot\""));
        assert!(rxb.try_recv().unwrap().contains("\"snapshot\""));

        // A draws; B hears the update; A only gets the ack.
        a.push(
            vec![json!({"id":"r1","version":1,"versionNonce":10,"index":"a1"})],
            None,
            None,
        )
        .unwrap();
        assert!(rxa.try_recv().unwrap().contains("push-ok"));
        assert!(rxa.try_recv().is_err(), "no own echo");
        let update: serde_json::Value = serde_json::from_str(&rxb.try_recv().unwrap()).unwrap();
        assert_eq!(update["type"], "update");
        assert_eq!(update["elements"][0]["id"], "r1");

        // B answers with a concurrent lower-versioned edit of the same
        // element: the authority discards it, acks B, fans nothing.
        b.push(
            vec![json!({"id":"r1","version":1,"versionNonce":11,"index":"a1"})],
            None,
            None,
        )
        .unwrap();
        assert!(rxb.try_recv().unwrap().contains("push-ok"));
        assert!(rxa.try_recv().is_err(), "loser never fans");

        // B catches up through its own next win.
        b.push(
            vec![json!({"id":"r1","version":2,"versionNonce":3,"index":"a1","angle":45})],
            None,
            None,
        )
        .unwrap();
        let a_update: serde_json::Value = serde_json::from_str(&rxa.try_recv().unwrap()).unwrap();
        assert_eq!(a_update["elements"][0]["angle"], 45);

        let (text_a, _) = a.session().authority_view();
        let (text_b, _) = b.session().authority_view();
        assert_eq!(text_a, text_b, "one authority");
        assert!(text_a.contains("\"angle\": 45"));
    }
}
