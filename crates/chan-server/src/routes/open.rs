//! `POST /api/open`: the command-launcher "Open", riding `cs open` semantics
//! over HTTP.
//!
//! The body names the submitting window and a target. A `chan://graph?...`
//! target forwards verbatim through [`crate::control_socket::open_graph_link`]
//! (the SPA owns the link parser); anything else absolutizes -- a relative
//! target resolves against the workspace root, an absolute one passes
//! verbatim. The shared escape probe routes an outside path through the host
//! to its standalone window. An in-workspace path rides
//! [`crate::control_socket::open_path`]: directory -> file browser,
//! editable/sniffed text -> editor tab, missing -> create empty and open,
//! binary -> file browser reveal. Local and graph commands ride `/ws` back to
//! the submitting window. The HTTP reply carries the queued acknowledgment,
//! plus `window` for a routed open, or a refusal (400 `{error}`).
//!
//! Mounted on the OPEN workspace-tenant api block (tunnel-reachable)
//! DELIBERATELY: a tunnel caller gains no new capability class here. Every
//! tunnel caller is the owner or a grantee, both can already create and edit
//! workspace files via `/api/fs` and spawn shells as the server's user. The
//! route validates the submitting window in this tenant before routing; an
//! escaping path is delivered to the host's standalone window.
//! Standalone-terminal tenants never mount this block, so those surfaces have
//! no `/api/open` at all (and the launcher hides the command there).

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use chan_shell::GRAPH_LINK_PREFIX;

use crate::error::err;
use crate::extract::Json;
use crate::routes::run_blocking;
use crate::state::AppState;

/// Body of `POST /api/open` (Contract C). `window_id` is the submitting
/// window (`sessionWindowId()` in the SPA). `target` is a workspace-relative
/// or absolute path, or a serialized `chan://graph?...` link.
#[derive(Deserialize)]
pub struct OpenRequest {
    pub window_id: String,
    pub target: String,
}

/// `POST /api/open` - queue an open locally or route it through the host.
/// A 200 carries `message`, plus `window` when routed. A refusal answers 400;
/// a failed blocking task answers 500.
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
    // no cwd, unlike `cs open`); absolute ones pass verbatim.
    let requested = PathBuf::from(&target);
    let requested = if requested.is_absolute() {
        requested
    } else {
        workspace.root().join(requested)
    };
    match crate::control_socket::route_open_if_outside_workspace(
        &state.unserve,
        workspace.root(),
        &requested,
        &window_id,
        &state.session_registry,
        &state.events_tx,
    )
    .await
    {
        Ok(Some(routed)) => {
            return Json(serde_json::json!({"message": routed.message, "window": routed.window}))
                .into_response();
        }
        Ok(None) => {}
        Err(error) => {
            let status = match &error {
                crate::control_socket::OpenRoutingError::Refused(_) => StatusCode::BAD_REQUEST,
                crate::control_socket::OpenRoutingError::ProbeFailed(_) => {
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            };
            return err(status, error.to_string());
        }
    }
    // open_path stats, canonicalizes, and may create the file: blocking fs
    // work, so run it off the async worker like the files routes do.
    let self_writes = Arc::clone(&state.self_writes);
    let session_registry = Arc::clone(&state.session_registry);
    let events_tx = state.events_tx.clone();
    let result = run_blocking("open", move || {
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
        Err(failed) => failed.into_response(),
    }
}

fn ok_message(message: String) -> Response {
    Json(serde_json::json!({ "message": message })).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use tempfile::TempDir;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use super::*;
    use crate::state::test_support::workspace_app_state;

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
        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            events_tx: broadcast::channel::<String>(8).0,
            ..workspace_app_state(lib, root.path().to_path_buf(), workspace)
        });
        let events_rx = state.events_tx.subscribe();
        let session_guard = state.session_registry.join("w-1", true, None).guard;
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
        assert_eq!(
            body,
            serde_json::json!({"message": "open request queued for docs"})
        );
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
        assert_eq!(
            body,
            serde_json::json!({"message": "open request queued for /"})
        );
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
        assert_eq!(
            body,
            serde_json::json!({"message": "open request queued for notes.md"})
        );
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
    async fn escaping_relative_target_refuses_with_guidance() {
        let (_cfg, root, mut rx, router, _guard) = test_router();
        let (status, body) = post_open(router, "../outside.md").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            guidance(&root.path().canonicalize().unwrap().join("../outside.md"))
        );
        assert!(rx.try_recv().is_err(), "no window command may queue");
    }

    #[tokio::test]
    async fn escaping_absolute_target_refuses_with_guidance() {
        let (_cfg, _root, mut rx, router, _guard) = test_router();
        let outside = TempDir::new().unwrap();
        let path = outside.path().join("outside.md");
        let (status, body) = post_open(router, path.to_str().unwrap()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], guidance(&path));
        assert!(!path.exists(), "a refused open must not create its target");
        assert!(rx.try_recv().is_err(), "no window command may queue");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn escaping_etc_hosts_refuses_with_guidance() {
        let (_cfg, _root, mut rx, router, _guard) = test_router();
        let (status, body) = post_open(router, "/etc/hosts").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], guidance(std::path::Path::new("/etc/hosts")));
        assert!(rx.try_recv().is_err(), "no window command may queue");
    }

    fn guidance(path: &std::path::Path) -> String {
        format!(
            "path escapes workspace root, and this host serves no filesystem to open it in. \
             Run 'chan serve {}' to load it as a workspace window.",
            path.display()
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hosted_open_routes_through_the_built_tenant() {
        const CHILD: &str = "CHAN_TEST_HOSTED_OPEN_CHILD";
        const TEST: &str = "routes::open::tests::hosted_open_routes_through_the_built_tenant";
        if std::env::var_os(CHILD).is_none() {
            // Builder configuration and shell discovery use process-wide caches.
            let home = TempDir::new().unwrap();
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(60),
                tokio::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        TEST,
                        "--nocapture",
                        "--test-threads=2",
                        "--color=never",
                    ])
                    .env(CHILD, "1")
                    .env("CHAN_HOME", home.path())
                    .env("HOME", home.path())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .expect("hosted open child timed out")
            .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success(),
                "hosted open child failed:\n{stdout}\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                stdout.contains("test result: ok. 1 passed;"),
                "child ran no test:\n{stdout}"
            );
            assert!(
                stdout
                    .lines()
                    .any(|line| line == format!("test {TEST} ... ok")),
                "child did not run {TEST}:\n{stdout}"
            );
            return;
        }

        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let home = PathBuf::from(std::env::var_os("CHAN_HOME").unwrap());
        let library = chan_workspace::Library::open_at(home.join("library.toml")).unwrap();
        library.register_workspace(&root).unwrap();
        let workspace = library.open_workspace(&root).unwrap();
        workspace.stop_open_recovery();
        let root = workspace.root().to_path_buf();
        let fake = Arc::new(crate::control_socket::FakeHost::routing(
            "outside.md",
            "w-outside",
            Some(("/terminal".into(), "standalone-token".into())),
        ));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        let config = crate::ServeConfig {
            addr: ([127, 0, 0, 1], 0).into(),
            prefix: String::new(),
            no_token: true,
            idle_timeout: None,
            open_browser: false,
            search_aggression: None,
            settings_disabled: false,
            verbose: false,
        };
        let mut artifacts = crate::build_app(
            library,
            workspace,
            &config,
            crate::desktop_window_ops::DesktopBridge::default(),
            chan_library::UnserveMode::Host(Arc::downgrade(&host)),
            None,
        )
        .await
        .unwrap();
        let _guard = artifacts
            .state
            .session_registry
            .join("w-1", true, None)
            .guard;
        let mut events = artifacts.state.events_tx.subscribe();
        let absolute = fixture.path().join("outside.md");
        for target in ["../outside.md", absolute.to_str().unwrap()] {
            let (status, body) = post_open(artifacts.app.clone(), target).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body,
                serde_json::json!({
                    "message": "open request queued for outside.md in standalone window w-outside (opening)",
                    "window": "w-outside",
                })
            );
            assert_eq!(
                window_commands(&mut events),
                vec![serde_json::json!({
                    "type": "window_command", "window_id": "w-1", "command": "open_window",
                    "window": "w-outside", "prefix": "/terminal", "token": "standalone-token", "path": "outside.md",
                })]
            );
        }
        assert_eq!(
            fake.open_requests(),
            vec![
                (root.join("../outside.md"), "w-1".into()),
                (absolute.clone(), "w-1".into()),
            ]
        );
        fake.refuse_opens();
        let (status, body) = post_open(artifacts.app.clone(), absolute.to_str().unwrap()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, serde_json::json!({"error": guidance(&absolute)}));
        assert!(
            window_commands(&mut events).is_empty(),
            "a refusal queues no window command"
        );
        assert!(
            !absolute.exists(),
            "the workspace tenant must not create an outside file"
        );
        artifacts.tasks.shutdown().await;
    }

    #[cfg(unix)]
    fn window_commands(rx: &mut broadcast::Receiver<String>) -> Vec<serde_json::Value> {
        let mut frames = Vec::new();
        loop {
            match rx.try_recv() {
                Ok(frame) => {
                    let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
                    if frame["type"] == "window_command" {
                        frames.push(frame);
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => return frames,
                Err(error) => panic!("lost event evidence: {error}"),
            }
        }
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
