//! systacean-39: per-workspace reports feature toggle.
//!
//! Three endpoints under `/api/index/reports/`:
//!
//! * `GET /state` - `{ enabled: bool }` snapshot.
//! * `POST /enable` - flip `reports_enabled` to true. Triggers the
//!   incremental indexing pass per chan-workspace's existing behavior.
//! * `POST /disable` - flip to false. Idempotent at the
//!   `set_reports_enabled` layer.
//!
//! Unblocks `fullstack-a-76` (SPA Settings overlay's Features
//! section). Mirrors the semantic-toggle shape from
//! `routes/index.rs` BUT is NOT gated on the `embeddings` feature:
//! reports are part of the BM25-only baseline.
//!
//! The semantic endpoints get a richer state (model id, download
//! status); reports is a single boolean. We could thread mtime /
//! last-run state later if the Settings UI wants it.

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::error::err_from;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct ReportsState {
    pub enabled: bool,
}

/// `GET /api/index/reports/state`. Read-only snapshot of the
/// per-workspace reports toggle.
pub async fn api_reports_state(State(state): State<Arc<AppState>>) -> Response {
    let workspace = state.workspace().clone();
    let result = tokio::task::spawn_blocking(move || workspace.reports_enabled()).await;
    match result {
        Ok(Ok(enabled)) => Json(ReportsState { enabled }).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

async fn reports_state_after_set(
    workspace: Arc<chan_workspace::Workspace>,
    enabled: bool,
) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        workspace.set_reports_enabled(enabled)?;
        workspace.reports_enabled()
    })
    .await;
    match result {
        Ok(Ok(enabled)) => Json(ReportsState { enabled }).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

/// `POST /api/index/reports/enable`. Flip the per-workspace reports
/// toggle to true. Workspace::set_reports_enabled triggers the
/// incremental indexing pass internally (per `-27`'s contract).
pub async fn api_reports_enable(State(state): State<Arc<AppState>>) -> Response {
    set_reports(state, true).await
}

/// `POST /api/index/reports/disable`. Flip the per-workspace reports
/// toggle to false. Idempotent at the set_reports_enabled layer.
pub async fn api_reports_disable(State(state): State<Arc<AppState>>) -> Response {
    set_reports(state, false).await
}

async fn set_reports(state: Arc<AppState>, enabled: bool) -> Response {
    let workspace = state.workspace().clone();
    // set_reports_enabled may do non-trivial work (kicks off
    // indexing); run on the blocking pool to keep the async
    // runtime responsive.
    reports_state_after_set(workspace, enabled).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use chan_workspace::SearchAggression;
    use tempfile::TempDir;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;

    use crate::self_writes::SelfWrites;
    use crate::state::WorkspaceCell;
    use crate::terminal_sessions::{Registry as TerminalRegistry, RegistryConfig};
    use crate::{EditorPrefs, ServerConfig};

    struct RouteTestApp {
        _cfg: TempDir,
        _root: TempDir,
        state: Arc<AppState>,
    }

    fn route_test_app() -> RouteTestApp {
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
            tunnel_public: false,
            last_activity: Arc::new(AtomicU64::new(0)),
            events_tx,
            index_events_tx,
            server_config: Mutex::new(ServerConfig::default()),
            editor_prefs: Mutex::new(EditorPrefs::default()),
            self_writes: Arc::new(SelfWrites::new()),
            terminal_sessions: Arc::new(TerminalRegistry::new(RegistryConfig {
                workspace_root: root.path().to_path_buf(),
                mcp_socket_path: None,
                control_socket_path: None,
                terminal: ServerConfig::default().terminal,
            })),
            agent_inbox: Arc::new(crate::agent_inbox::AgentInbox::new(
                ServerConfig::default().team_work.inbox_depth,
            )),
            shutdown_rx,
            scope_registry: std::sync::Arc::new(crate::bus::ScopeRegistry::new()),
        });

        RouteTestApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    async fn fetch_state(router: &axum::Router, auth: bool) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().uri("/api/index/reports/state");
        if auth {
            req = req.header(header::AUTHORIZATION, "Bearer secret");
        }
        let response = router
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    async fn post(router: &axum::Router, path: &str) -> (StatusCode, serde_json::Value) {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn reports_state_endpoint_requires_auth() {
        // systacean-39: parity with the semantic endpoints -
        // /state is read-only but still gated by the per-launch
        // token. Anonymous request gets 401.
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, _) = fetch_state(&router, false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn reports_round_trip_state_enable_disable() {
        // systacean-39: full round-trip - initial state, flip
        // enable, re-check, flip disable, re-check. Mirrors the
        // shape FullStackA's `-a-76` Settings UI will exercise.
        let app = route_test_app();
        let router = crate::router(app.state);

        // Initial state: chan-workspace default is `false`.
        let (status, body) = fetch_state(&router, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], false);

        // Enable: flip to true + response carries the new state.
        let (status, body) = post(&router, "/api/index/reports/enable").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], true);

        // Re-check via state: still true after the flip persists.
        let (status, body) = fetch_state(&router, true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], true);

        // Disable: flip back + response carries the new state.
        let (status, body) = post(&router, "/api/index/reports/disable").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], false);

        // Re-check via state: still false.
        let (_, body) = fetch_state(&router, true).await;
        assert_eq!(body["enabled"], false);
    }

    #[tokio::test]
    async fn reports_disable_is_idempotent_when_already_off() {
        // systacean-39: chan-workspace's set_reports_enabled(false)
        // on an already-off workspace is a no-op + returns Ok. The
        // route must surface 200 + the current state, not error.
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = post(&router, "/api/index/reports/disable").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], false);
    }
}
