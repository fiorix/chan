//! `POST /api/open`: the command-launcher "Open", riding `cs open` semantics
//! over HTTP.
//!
//! The body names the submitting window and a target. A `chan://graph?...`
//! target forwards verbatim through [`crate::control_socket::open_graph_link`]
//! (the SPA owns the link parser); anything else absolutizes -- a relative
//! target resolves against the workspace root, an absolute one passes
//! verbatim -- and rides [`crate::control_socket::open_path`]: directory ->
//! file browser, editable/sniffed text -> editor tab, missing -> create empty
//! and open, binary -> file browser reveal. The SEMANTICS live in those two
//! control-socket fns and are never reimplemented here, so `cs open` and the
//! launcher command cannot drift. The resulting `open_browser` / `open_file` /
//! `open_graph_link` window commands ride the existing `/ws` broadcast back to
//! the submitting window; the HTTP reply is just the queued/refused ack
//! (Contract C: 200 `{message}` / 400 `{error}`).
//!
//! Mounted on the OPEN workspace-tenant api block (tunnel-reachable)
//! DELIBERATELY: a tunnel guest gains no new capability class here -- guests
//! can already create and edit workspace files via `/api/fs`, and an open
//! frame only steers windows that themselves belong to the tenant's `/ws`.
//! Standalone-terminal tenants never mount this block, so those surfaces have
//! no `/api/open` at all (and the launcher hides the command there).

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use chan_shell::GRAPH_LINK_PREFIX;

use crate::error::err;
use crate::state::AppState;

/// Body of `POST /api/open` (Contract C). `window_id` is the submitting
/// window (`sessionWindowId()` in the SPA); the queued window command rides
/// `/ws` back to exactly that window. `target` is a workspace-relative or
/// absolute path, or a serialized `chan://graph?...` link.
#[derive(Deserialize)]
pub struct OpenRequest {
    pub window_id: String,
    pub target: String,
}

/// `POST /api/open` - queue an open for `target` in the submitting window.
/// 200 `{message}` when the window command was queued, 400 `{error}` on any
/// refusal (empty fields, workspace escape, no connected window).
pub async fn api_open(
    State(state): State<Arc<AppState>>,
    Json(req): Json<OpenRequest>,
) -> Response {
    let window_id = req.window_id.trim().to_string();
    if window_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "window_id is required".into());
    }
    if let Err(error) =
        crate::control_socket::require_connected_window(&state.session_registry, &window_id)
    {
        return err(StatusCode::BAD_REQUEST, error);
    }
    let target = req.target.trim().to_string();
    if target.is_empty() {
        return err(StatusCode::BAD_REQUEST, "target is required".into());
    }
    if target.starts_with(GRAPH_LINK_PREFIX) {
        return match crate::control_socket::open_graph_link(
            &window_id,
            &target,
            None,
            &state.session_registry,
            &state.events_tx,
        ) {
            Ok(message) => ok_message(message),
            Err(error) => err(StatusCode::BAD_REQUEST, error),
        };
    }
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return crate::error::err_state(&e),
    };
    // Relative targets resolve against the workspace root (the launcher has
    // no cwd, unlike `cs open`); absolute ones pass verbatim and stand or
    // fall on open_path's escape check.
    let requested = PathBuf::from(&target);
    let requested = if requested.is_absolute() {
        requested
    } else {
        workspace.root().join(requested)
    };
    // open_path stats, canonicalizes, and may create the file: blocking fs
    // work, so run it off the async worker like the files routes do.
    let self_writes = Arc::clone(&state.self_writes);
    let session_registry = Arc::clone(&state.session_registry);
    let events_tx = state.events_tx.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::control_socket::open_path(
            &workspace,
            &self_writes,
            &window_id,
            &requested,
            None,
            &session_registry,
            &events_tx,
        )
    })
    .await;
    match result {
        Ok(Ok(message)) => ok_message(message),
        Ok(Err(error)) => err(StatusCode::BAD_REQUEST, error),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn ok_message(message: String) -> Response {
    Json(serde_json::json!({ "message": message })).into_response()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Mutex, RwLock};

    use axum::body::{to_bytes, Body};
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

    /// The real router over a tempdir workspace, plus a live `/ws` events
    /// subscription (window commands refuse to queue with zero subscribers)
    /// and the root for seeding files. Mirrors `routes::window`'s
    /// test_router.
    fn test_router() -> (
        TempDir,
        TempDir,
        broadcast::Receiver<String>,
        axum::Router,
        crate::session_presence::SessionGuard,
    ) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let (events_tx, events_rx) = broadcast::channel::<String>(8);
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
        let session_registry = Arc::new(crate::session_presence::SessionRegistry::new());
        let session_guard = session_registry.join("w-1", true, None).guard;
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
            session_registry,
            pending_window_commands: Arc::new(Default::default()),
            window_transfers: Arc::new(crate::window_transfers::WindowTransfers::new()),
            window_titles: Arc::new(crate::window_titles::WindowTitles::new()),
            bulk_transfer: crate::state::test_support::make_test_bulk_transfer_tenant(),
            instance_id: "test-instance".to_string(),
            standalone_files: None,
        });
        (cfg, root, events_rx, crate::router(state), session_guard)
    }

    async fn post_open(router: axum::Router, target: &str) -> (StatusCode, serde_json::Value) {
        post_open_for_window(router, "w-1", target).await
    }

    async fn post_open_for_window(
        router: axum::Router,
        window_id: &str,
        target: &str,
    ) -> (StatusCode, serde_json::Value) {
        let body = serde_json::json!({ "window_id": window_id, "target": target });
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/open")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn next_frame(rx: &mut broadcast::Receiver<String>) -> serde_json::Value {
        serde_json::from_str(&rx.try_recv().expect("a queued window command")).unwrap()
    }

    #[tokio::test]
    async fn open_directory_queues_open_browser_for_the_posted_window() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        std::fs::create_dir(root.path().join("docs")).unwrap();
        let (status, body) = post_open(router, "docs").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["message"], "open request queued for docs");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_browser");
        assert_eq!(frame["window_id"], "w-1");
        assert_eq!(frame["path"], "docs");
    }

    #[tokio::test]
    async fn open_dot_queues_workspace_root_browser() {
        let (_cfg, _root, mut rx, router, _guard) = test_router();
        let (status, body) = post_open(router, ".").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["message"], "open request queued for /");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_browser");
        assert_eq!(frame["path"], "");
        assert_eq!(frame["enter"], true);
        assert!(frame.get("select").is_none());
    }

    #[tokio::test]
    async fn open_text_file_queues_open_file() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        std::fs::write(root.path().join("notes.md"), "hello\n").unwrap();
        let (status, body) = post_open(router, "notes.md").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "notes.md");
    }

    #[tokio::test]
    async fn open_extensionless_text_passes_the_content_sniff() {
        // No extension fast-path: the 8 KiB content sniff (the editor's own
        // gate) must decide, so `cs open` parity holds for Makefile-style
        // names.
        let (_cfg, root, mut rx, router, _guard) = test_router();
        std::fs::write(root.path().join("NOTES"), "plain words\n").unwrap();
        let (status, body) = post_open(router, "NOTES").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "NOTES");
    }

    #[tokio::test]
    async fn open_binary_file_queues_parent_reveal() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        std::fs::create_dir(root.path().join("media")).unwrap();
        std::fs::write(
            root.path().join("media/img.png"),
            b"\x89PNG\r\n\x1a\n\x00\x00",
        )
        .unwrap();
        let (status, body) = post_open(router, "media/img.png").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["message"], "open request queued for media/img.png");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_browser");
        assert_eq!(frame["path"], "media");
        assert_eq!(frame["select"], "media/img.png");
        assert!(frame.get("enter").is_none());
    }

    #[tokio::test]
    async fn open_missing_path_creates_empty_and_opens() {
        // Ruling 6: full `cs open` parity, create + open (the dialog's status
        // row discloses "creates and opens" before submit).
        let (_cfg, root, mut rx, router, _guard) = test_router();
        let (status, body) = post_open(router, "fresh.md").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "fresh.md");
        let created = root.path().join("fresh.md");
        assert!(created.is_file(), "created empty on disk");
        assert_eq!(std::fs::read_to_string(created).unwrap(), "");
    }

    #[tokio::test]
    async fn open_missing_binary_class_path_stays_refused() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        let (status, body) = post_open(router, "missing.png").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|message| message.contains("path is not editable text: missing.png")),
            "{body}"
        );
        assert!(!root.path().join("missing.png").exists());
        assert!(rx.try_recv().is_err(), "no window command may queue");
    }

    #[tokio::test]
    async fn relative_target_resolves_against_the_workspace_root() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        std::fs::create_dir(root.path().join("sub")).unwrap();
        std::fs::write(root.path().join("sub/x.md"), "x\n").unwrap();
        let (status, body) = post_open(router, "sub/x.md").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(next_frame(&mut rx)["path"], "sub/x.md");
    }

    #[tokio::test]
    async fn absolute_target_inside_the_root_passes_verbatim() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        std::fs::write(root.path().join("abs.md"), "x\n").unwrap();
        let abs = root.path().join("abs.md");
        let (status, body) = post_open(router, abs.to_str().unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(next_frame(&mut rx)["path"], "abs.md");
    }

    #[tokio::test]
    async fn escaping_targets_refuse_with_400() {
        // A relative `..` walk-out and an absolute path outside the root both
        // die on open_path's canonicalized escape check.
        let (_cfg, _root, mut rx, router, _guard) = test_router();
        let (status, body) = post_open(router.clone(), "../outside.md").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "path escapes workspace root");
        let (status, body) = post_open(router, "/etc/hosts").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "path escapes workspace root");
        assert!(rx.try_recv().is_err(), "no window command may queue");
    }

    #[tokio::test]
    async fn graph_link_forwards_verbatim_as_open_graph_link() {
        let (_cfg, _root, mut rx, router, _guard) = test_router();
        let link = "chan://graph?scope=fs&select=notes.md";
        let (status, body) = post_open(router, link).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["message"], "graph link request queued");
        let frame = next_frame(&mut rx);
        assert_eq!(frame["command"], "open_graph_link");
        assert_eq!(frame["window_id"], "w-1");
        assert_eq!(frame["link"], link);
    }

    #[tokio::test]
    async fn empty_fields_refuse_with_400() {
        let (_cfg, _root, _rx, router, _guard) = test_router();
        let (status, body) = post_open(router.clone(), "   ").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "target is required");
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/open")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"window_id":"","target":"x.md"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn offline_target_refuses_while_another_window_is_live() {
        let (_cfg, root, mut rx, router, _guard) = test_router();

        let (status, body) = post_open_for_window(router, "w-offline", "notes.md").await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"].as_str().is_some_and(
                |message| message.contains("w-offline") && message.contains("not connected")
            ),
            "{body}"
        );
        assert!(
            rx.try_recv().is_err(),
            "the live w-1 receiver must not make w-offline deliverable"
        );
        assert!(
            !root.path().join("notes.md").exists(),
            "target validation must happen before missing-file creation"
        );
    }
}
