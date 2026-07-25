//! Per-workspace screensaver overlay state.
//!
//! Five endpoints under `/api/screensaver/`:
//!
//! * `GET /state` - `{ enabled, timeout_secs, theme, pin_set }`. The
//!   PIN hash itself never appears on the wire - `pin_set` is a
//!   `bool` derived from whether `Workspace::screensaver_pin_hash()`
//!   returns `Some(_)`.
//! * `PATCH /state` body `{ enabled?, timeout_secs?, theme? }` - partial
//!   update.
//! * `POST /pin` body `{ hash: base64 }` - set the PIN hash.
//!   Server stores the base64-decoded bytes verbatim. PBKDF2 is
//!   client-side.
//! * `DELETE /pin` - clear the PIN.
//! * `POST /verify` body `{ hash: base64 }` - returns
//!   `{ verified: bool }` from a byte-equality compare against
//!   the stored hash. Returns `verified: false` when no PIN is
//!   set (the overlay still arms but the lockout is moot).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::state::AppState;

const MIN_TIMEOUT_SECS: u32 = 10;
const MAX_TIMEOUT_SECS: u32 = 3600;

#[derive(Debug, Clone, Serialize)]
pub struct ScreensaverState {
    pub enabled: bool,
    pub timeout_secs: u32,
    pub theme: chan_workspace::ScreensaverTheme,
    pub pin_set: bool,
}

#[derive(Debug, Deserialize)]
pub struct PatchPayload {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub timeout_secs: Option<u32>,
    #[serde(default)]
    pub theme: Option<chan_workspace::ScreensaverTheme>,
}

#[derive(Debug, Deserialize)]
pub struct PinPayload {
    /// Base64-encoded PIN hash bytes. SPA does PBKDF2 client-side
    /// + posts the digest here.
    pub hash: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyResult {
    pub verified: bool,
}

/// `GET /api/screensaver/state`.
pub async fn api_screensaver_state(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    screensaver_state_response(workspace).await
}

async fn screensaver_state_response(workspace: Arc<chan_workspace::Workspace>) -> Response {
    let result = tokio::task::spawn_blocking(move || screensaver_state_sync(&workspace)).await;
    match result {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

fn screensaver_state_sync(
    workspace: &chan_workspace::Workspace,
) -> chan_workspace::Result<ScreensaverState> {
    Ok(screensaver_state_from_config(
        workspace.dashboard_snapshot()?,
    ))
}

fn screensaver_state_from_config(config: chan_workspace::DashboardConfig) -> ScreensaverState {
    ScreensaverState {
        enabled: config.screensaver_enabled,
        timeout_secs: config.screensaver_timeout_secs,
        theme: config.screensaver_theme,
        pin_set: config.screensaver_pin_hash.is_some(),
    }
}

/// `PATCH /api/screensaver/state`. Partial update: only the
/// fields present in the body are written. Returns the
/// post-update state, mirroring the semantic + reports toggle
/// shape so the SPA can update its cache from the response.
pub async fn api_screensaver_patch(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PatchPayload>,
) -> Response {
    if let Some(timeout) = payload.timeout_secs {
        if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&timeout) {
            return err(
                StatusCode::BAD_REQUEST,
                format!("timeout_secs must be between {MIN_TIMEOUT_SECS} and {MAX_TIMEOUT_SECS}"),
            );
        }
    }
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(
        move || -> Result<ScreensaverState, chan_workspace::ChanError> {
            let config = workspace.update_screensaver(
                payload.enabled,
                payload.timeout_secs,
                payload.theme,
            )?;
            Ok(screensaver_state_from_config(config))
        },
    )
    .await;
    match result {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

/// `POST /api/screensaver/pin`. Set the PIN hash (overwrites any
/// existing one).
pub async fn api_screensaver_set_pin(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PinPayload>,
) -> Response {
    let bytes = match base64::engine::general_purpose::STANDARD.decode(payload.hash.as_bytes()) {
        Ok(b) => b,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("invalid base64: {e}")),
    };
    if bytes.is_empty() {
        return err(StatusCode::BAD_REQUEST, "empty hash".to_string());
    }
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || {
        workspace.set_screensaver_pin_hash(Some(bytes))?;
        screensaver_state_sync(&workspace)
    })
    .await;
    match result {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

/// `DELETE /api/screensaver/pin`. Clear the PIN.
pub async fn api_screensaver_clear_pin(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || {
        workspace.set_screensaver_pin_hash(None)?;
        screensaver_state_sync(&workspace)
    })
    .await;
    match result {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

/// `POST /api/screensaver/verify`. Returns `{verified: bool}`.
/// Server-side byte-equality compare; the PIN hash never leaves
/// the server in either direction (request body is the candidate
/// hash; response is just a boolean).
pub async fn api_screensaver_verify(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<PinPayload>,
) -> Response {
    let candidate = match base64::engine::general_purpose::STANDARD.decode(payload.hash.as_bytes())
    {
        Ok(b) => b,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("invalid base64: {e}")),
    };
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || {
        let stored = workspace.screensaver_pin_hash()?;
        let verified = match stored {
            // Constant-time compare to avoid leaking PIN length /
            // prefix matches through response-timing. `subtle` is a
            // workspace dep candidate but for v1 the manual loop is
            // sufficient: both inputs are short fixed-length hashes
            // so timing differences are below the WS-layer noise
            // floor anyway. Document the constraint so a future
            // bcrypt-style migration knows to keep this property.
            Some(stored_bytes) => constant_time_eq(&candidate, &stored_bytes),
            None => false,
        };
        Ok::<_, chan_workspace::ChanError>(verified)
    })
    .await;
    match result {
        Ok(Ok(verified)) => Json(VerifyResult { verified }).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err_from(&chan_workspace::ChanError::Io(join.to_string())),
    }
}

/// Constant-time byte-equality. Returns false immediately on
/// length mismatch (length is not a secret - the SPA controls
/// the hash length client-side via PBKDF2 output size).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
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
            scope_registry: std::sync::Arc::new(crate::bus::ScopeRegistry::new()),
            survey_bus: std::sync::Arc::new(crate::survey::SurveyBus::new()),
            window_bus: std::sync::Arc::new(crate::window_bus::WindowBus::new()),
            handover_bus: std::sync::Arc::new(crate::handover_bus::HandoverBus::new()),
            ephemeral_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            terminal_session_dir: None,
            window_presence: std::sync::Arc::new(crate::window_presence::WindowPresence::new()),
            session_registry: std::sync::Arc::new(crate::session_presence::SessionRegistry::new()),
            window_transfers: std::sync::Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: std::sync::Arc::new(crate::window_titles::WindowTitles::new()),
            instance_id: "test-instance".to_string(),
        });

        RouteTestApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    async fn request(
        router: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer secret");
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(req.body(body).unwrap())
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
    async fn screensaver_state_default_is_off_300s_no_pin() {
        // A fresh workspace reports the documented
        // defaults: enabled=false, timeout=300, pin_set=false.
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = request(&router, "GET", "/api/screensaver/state", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], false);
        assert_eq!(body["timeout_secs"], 300);
        assert_eq!(body["theme"], "plain");
        assert_eq!(body["pin_set"], false);
    }

    #[tokio::test]
    async fn screensaver_patch_updates_three_fields_atomically() {
        // PATCH accepts partial body, applies all present fields in one
        // mutation, and returns the resulting snapshot.
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = request(
            &router,
            "PATCH",
            "/api/screensaver/state",
            Some(r#"{"enabled":true,"timeout_secs":60,"theme":"matrix"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], true);
        assert_eq!(body["timeout_secs"], 60);
        assert_eq!(body["theme"], "matrix");
        assert_eq!(body["pin_set"], false);

        // Partial: only update timeout; enabled stays true.
        let (status, body) = request(
            &router,
            "PATCH",
            "/api/screensaver/state",
            Some(r#"{"timeout_secs":120}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["enabled"], true);
        assert_eq!(body["timeout_secs"], 120);
        assert_eq!(body["theme"], "matrix");
    }

    #[tokio::test]
    async fn screensaver_patch_accepts_plain_theme_round_trip() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, body) = request(
            &router,
            "PATCH",
            "/api/screensaver/state",
            Some(r#"{"theme":"plain"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["theme"], "plain");

        let (status, body) = request(&router, "GET", "/api/screensaver/state", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["theme"], "plain");
    }

    #[tokio::test]
    async fn screensaver_patch_rejects_castaway_theme() {
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, _) = request(
            &router,
            "PATCH",
            "/api/screensaver/state",
            Some(r#"{"theme":"castaway"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn screensaver_patch_rejects_timeout_outside_bounds() {
        // The API boundary rejects values outside
        // the UI-supported [10s, 3600s] range.
        let app = route_test_app();
        let workspace = app
            .state
            .try_workspace()
            .expect("screensaver test workspace");
        let dashboard_path = chan_workspace::dashboard::config_path(&workspace.paths().root);
        let router = crate::router(app.state);
        for body in [r#"{"timeout_secs":9}"#, r#"{"timeout_secs":3601}"#] {
            let (status, body) =
                request(&router, "PATCH", "/api/screensaver/state", Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(
                body.to_string().contains("timeout_secs"),
                "body should mention timeout_secs: {body}"
            );
        }
        assert!(
            !dashboard_path.exists(),
            "invalid timeout must not write dashboard config"
        );
    }

    #[tokio::test]
    async fn screensaver_pin_set_verify_clear_round_trip() {
        // Full PIN lifecycle - set, verify (positive
        // + negative), clear, verify (always false). PIN hash
        // never appears in any response body.
        let app = route_test_app();
        let router = crate::router(app.state);

        // Set PIN.
        // base64("\xDE\xAD\xBE\xEF\x42") = "3q2+70I="
        let (status, body) = request(
            &router,
            "POST",
            "/api/screensaver/pin",
            Some(r#"{"hash":"3q2+70I="}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["pin_set"], true);
        // The hash MUST NOT appear in the state body.
        let body_str = body.to_string();
        assert!(
            !body_str.contains("3q2+70I="),
            "PIN hash leaked into response: {body_str}"
        );

        // Verify positive: same bytes.
        let (status, body) = request(
            &router,
            "POST",
            "/api/screensaver/verify",
            Some(r#"{"hash":"3q2+70I="}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["verified"], true);

        // Verify negative: different bytes.
        // base64("\xAA\xBB\xCC") = "qrvM"
        let (_, body) = request(
            &router,
            "POST",
            "/api/screensaver/verify",
            Some(r#"{"hash":"qrvM"}"#),
        )
        .await;
        assert_eq!(body["verified"], false);

        // Clear PIN.
        let (status, body) = request(&router, "DELETE", "/api/screensaver/pin", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["pin_set"], false);

        // Verify on cleared PIN returns false.
        let (_, body) = request(
            &router,
            "POST",
            "/api/screensaver/verify",
            Some(r#"{"hash":"3q2+70I="}"#),
        )
        .await;
        assert_eq!(body["verified"], false);
    }

    #[tokio::test]
    async fn screensaver_set_pin_rejects_invalid_base64() {
        // Invalid base64 input returns 400.
        let app = route_test_app();
        let router = crate::router(app.state);
        let (status, _) = request(
            &router,
            "POST",
            "/api/screensaver/pin",
            Some(r#"{"hash":"not_base64!@#"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn screensaver_endpoints_require_auth() {
        // Parity with other settings endpoints -
        // all routes are gated by the per-launch token.
        let app = route_test_app();
        let router = crate::router(app.state);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/screensaver/state")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
