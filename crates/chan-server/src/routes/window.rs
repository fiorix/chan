//! Window reply route (the SPA side of `cs pane`).
//!
//! A `cs pane` call blocks in the control socket on a oneshot parked in the
//! [`crate::window_bus::WindowBus`] keyed by a server-minted `request_id`.
//! The SPA reads its `layout`, builds the snapshot, and POSTs a
//! [`WindowReplyRequest`] here; this route calls [`crate::window_bus::WindowBus::complete`],
//! which fires the oneshot and unblocks the CLI with the snapshot. This is
//! the reply half of the window channel, mirroring `routes::survey` for the
//! survey bus.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::error::err;
use crate::state::AppState;

/// Body of `POST /api/window/reply`. camelCase to match the SPA
/// (`web/packages/workspace-app/src/api/client.ts` `WindowReplyRequest`). `payload` is opaque to the
/// server: the CLI formats it. For a `cs pane` query it is the layout
/// snapshot the SPA built from its `layout` singleton.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReplyRequest {
    pub request_id: String,
    pub payload: serde_json::Value,
}

/// `POST /api/window/reply` - complete a parked `cs pane` round-trip with the
/// SPA's payload. 404 when no request with that id is parked (already
/// answered, timed out, or a stale id).
pub async fn api_window_reply(
    State(state): State<Arc<AppState>>,
    Json(req): Json<WindowReplyRequest>,
) -> Response {
    if state.window_bus.complete(&req.request_id, req.payload) {
        Json(serde_json::json!({})).into_response()
    } else {
        err(
            StatusCode::NOT_FOUND,
            format!(
                "no window request parked with id {} (already answered, timed out, or stale)",
                req.request_id
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use chan_workspace::SearchAggression;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use super::*;
    use crate::self_writes::SelfWrites;
    use crate::state::WorkspaceCell;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    #[test]
    fn window_reply_request_deserializes_camel_case() {
        let json = r#"{"requestId":"win-3","payload":{"activePaneId":"p1","panes":[]}}"#;
        let req: WindowReplyRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.request_id, "win-3");
        assert_eq!(req.payload["activePaneId"], "p1");
        assert!(req.payload["panes"].is_array());
    }

    // The real router with a test AppState, so the assertion below exercises
    // the actual `/api/window/reply` mount (with its DefaultBodyLimit layer),
    // not a stand-in. Mirrors the `route_test_app` helper in other route tests.
    fn test_router() -> (TempDir, TempDir, axum::Router) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let (events_tx, _) = broadcast::channel::<String>(1);
        let (index_events_tx, _) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        let indexer = Arc::new(crate::indexer::Indexer::spawn(
            workspace.clone(),
            index_events_tx.subscribe(),
            false,
            SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        ));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        std::mem::forget(shutdown_tx);
        let state = Arc::new(AppState {
            library: lib,
            workspace_root: root.path().to_path_buf(),
            workspace_cell: Arc::new(RwLock::new(Some(WorkspaceCell {
                workspace,
                watch_handle: None,
                indexer,
            }))),
            token: Some("secret".to_string()),
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
            doc_sessions: std::sync::Arc::new(crate::doc_sessions::DocRegistry::new()),
            scene_sessions: std::sync::Arc::new(crate::scene_sessions::SceneRegistry::new()),
            shutdown_rx,
            scope_registry: Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: Arc::new(crate::survey::SurveyBus::new()),
            window_bus: Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: Mutex::new(std::collections::HashMap::new()),
            terminal_session_dir: None,
            window_presence: Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: Arc::new(crate::session_presence::SessionRegistry::new()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            instance_id: "test-instance".to_string(),
        });
        (cfg, root, crate::router(state))
    }

    #[tokio::test]
    async fn window_reply_accepts_a_body_over_axums_2mib_default() {
        // A `cs paste` of a normal photo replies with a multi-MB base64 image.
        // Axum's default body limit is 2 MiB, so without the raised limit on
        // the route this 413s and the CLI hangs the full timeout. A 3 MiB body
        // must reach the handler: an unparked id answers 404 (accepted, ran),
        // never 413 (rejected before the handler).
        let (_cfg, _root, router) = test_router();
        let big = "x".repeat(3 * 1024 * 1024);
        let body = format!(r#"{{"requestId":"win-nope","payload":{{"data_b64":"{big}"}}}}"#);
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/window/reply")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(
            resp.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "the raised DefaultBodyLimit on /api/window/reply was removed"
        );
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
