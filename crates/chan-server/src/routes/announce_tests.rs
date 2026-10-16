//! A mutation and its announcement are one unit. Each mutating route is held
//! after its store, its request is aborted and seen cancelled, and the hold is
//! released; the frames the uncancelled request sends must still arrive, once.
//! The worker sends synchronously, in one call, before it returns, and the
//! handler is gone before the release, so once the expected frames have
//! arrived nothing more can come and `try_recv` decides "once" with no timed
//! wait. The control sends the same request uncancelled and checks the same
//! right after the answer, since every send precedes it. The five-second
//! bound is a hang guard on a wait that an event ends.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::{broadcast, mpsc};
use tower::ServiceExt;

use super::announce_hold;
use super::drafts::{NEW_DIAGRAM_CONTENT, NEW_DRAFT_CONTENT};
use super::standalone_fs::test_fixture::{files_fixture, Fixture};
use crate::state::AppState;

const BOUND: Duration = Duration::from_secs(5);
const LOST: &str = "a stored change lost its announcement after request cancellation";
const UNANSWERED: &str = "an answered mutation sent no announcement";

fn request(method: Method, uri: &str, json_body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, "Bearer secret");
    let body = match json_body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap()
}

async fn answer(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Run `request` through `router`. Cancelled, its worker is held after the
/// store, `stored` runs while it is held with the announcement still to
/// come, and the request is aborted and seen cancelled before the release.
/// Uncancelled, it is answered with a success and `stored` runs after.
async fn run(
    router: axum::Router,
    w: &str,
    request: Request<Body>,
    cancel: bool,
    stored: impl FnOnce(),
    before_release: impl FnOnce(),
) {
    if !cancel {
        let (status, body) = answer(router.oneshot(request).await.unwrap()).await;
        assert!(status.is_success(), "{status}: {body}");
        stored();
        return;
    }
    let (entered, release) = announce_hold::hold(w);
    let task = tokio::spawn(router.oneshot(request));
    tokio::time::timeout(BOUND, entered)
        .await
        .expect("the worker never reached the end of its store")
        .unwrap();
    stored();
    before_release();
    task.abort();
    assert!(
        task.await.unwrap_err().is_cancelled(),
        "the request must be gone before the release"
    );
    drop(release);
}

// ---- The six workspace routes and their `draft` frames ----

struct WorkspaceApp {
    _cfg: TempDir,
    root: TempDir,
    state: Arc<AppState>,
    workspace: Arc<chan_workspace::Workspace>,
}

fn workspace_app() -> WorkspaceApp {
    let cfg = TempDir::new().unwrap();
    let root = TempDir::new().unwrap();
    let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(root.path()).unwrap();
    let workspace = lib.open_workspace(root.path()).unwrap();
    let state = Arc::new(AppState {
        token: Some("secret".to_string()),
        ..crate::state::test_support::workspace_app_state(
            lib,
            root.path().to_path_buf(),
            workspace.clone(),
        )
    });
    WorkspaceApp {
        _cfg: cfg,
        root,
        state,
        workspace,
    }
}

impl WorkspaceApp {
    fn router(&self) -> axum::Router {
        crate::router(self.state.clone())
    }

    /// A draft made by the route without a window, so nothing holds it.
    async fn draft(&self) -> Value {
        let (status, created) = answer(
            self.router()
                .oneshot(request(Method::POST, "/api/drafts/new", None))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        created["primary"].clone()
    }
}

/// The `draft` frames waiting on `events`, any others skipped.
fn draft_frames(events: &mut broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(frame) = events.try_recv() {
        let frame: Value = serde_json::from_str(&frame).unwrap();
        if frame["type"] == "draft" {
            frames.push(frame);
        }
    }
    frames
}

async fn next_draft_frame(events: &mut broadcast::Receiver<String>, missing: &str) -> Value {
    loop {
        let frame = tokio::time::timeout(BOUND, events.recv())
            .await
            .expect(missing)
            .unwrap();
        let frame: Value = serde_json::from_str(&frame).unwrap();
        if frame["type"] == "draft" {
            return frame;
        }
    }
}

/// One workspace mutation: its request, its store's check and the one
/// `draft` frame it sends, which `expected` gives once the store is done.
async fn workspace_case(
    app: &WorkspaceApp,
    w: &str,
    request: Request<Body>,
    cancel: bool,
    stored: impl FnOnce(),
    expected: impl FnOnce() -> Value,
) {
    let mut events = app.state.events_tx.subscribe();
    let mut early = Vec::new();
    run(app.router(), w, request, cancel, stored, || {
        early = draft_frames(&mut events);
    })
    .await;
    assert_eq!(
        early,
        Vec::<Value>::new(),
        "the announcement must follow the store"
    );
    let frame = next_draft_frame(&mut events, if cancel { LOST } else { UNANSWERED }).await;
    assert_eq!(frame, expected());
    assert_eq!(
        draft_frames(&mut events),
        Vec::<Value>::new(),
        "one mutation announces once"
    );
}

async fn workspace_create(cancel: bool, w: &str, uri: &str, leaf: &str) {
    let app = workspace_app();
    let uri = format!("{uri}?w={w}");
    workspace_case(
        &app,
        w,
        request(Method::POST, &uri, None),
        cancel,
        || {
            assert!(app
                .workspace
                .drafts_dir()
                .join("untitled")
                .join(leaf)
                .is_file())
        },
        || {
            json!({
                "type": "draft",
                "event": "created",
                "source": {
                    "root": "draft",
                    "path": format!("untitled/{leaf}"),
                    "draft_id": app.workspace.draft_id("untitled").unwrap(),
                },
                "source_w": w,
            })
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_draft_create_still_announces() {
    workspace_create(true, "w-create-pin", "/api/drafts/new", "draft.md").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_draft_create_announces_once() {
    workspace_create(false, "w-create-control", "/api/drafts/new", "draft.md").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_diagram_create_still_announces() {
    workspace_create(
        true,
        "w-diagram-pin",
        "/api/diagrams/new",
        "untitled.excalidraw",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_diagram_create_announces_once() {
    workspace_create(
        false,
        "w-diagram-control",
        "/api/diagrams/new",
        "untitled.excalidraw",
    )
    .await;
}

async fn workspace_discard(cancel: bool, w: &str) {
    let app = workspace_app();
    let primary = app.draft().await;
    workspace_case(
        &app,
        w,
        request(
            Method::POST,
            &format!("/api/drafts/discard?w={w}"),
            Some(json!({ "source": primary })),
        ),
        cancel,
        || assert!(!app.workspace.drafts_dir().join("untitled").exists()),
        || {
            json!({
                "type": "draft", "event": "discarded", "source": primary, "source_w": w,
            })
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_draft_discard_still_announces() {
    workspace_discard(true, "w-discard-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_draft_discard_announces_once() {
    workspace_discard(false, "w-discard-control").await;
}

async fn workspace_promote(cancel: bool, w: &str) {
    let app = workspace_app();
    let primary = app.draft().await;
    workspace_case(
        &app,
        w,
        request(
            Method::POST,
            &format!("/api/drafts/promote?w={w}"),
            Some(json!({ "source": primary, "target": "saved.md" })),
        ),
        cancel,
        || {
            assert_eq!(
                std::fs::read_to_string(app.root.path().join("saved.md")).unwrap(),
                NEW_DRAFT_CONTENT
            );
            assert!(!app.workspace.drafts_dir().join("untitled").exists());
        },
        || {
            json!({
                "type": "draft",
                "event": "promoted",
                "source": primary,
                "destination": { "root": "workspace", "path": "saved.md" },
                "source_w": w,
            })
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_draft_promote_still_announces() {
    workspace_promote(true, "w-promote-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_draft_promote_announces_once() {
    workspace_promote(false, "w-promote-control").await;
}

async fn workspace_attachment(cancel: bool, w: &str) {
    let app = workspace_app();
    let primary = app.draft().await;
    let id = primary["draft_id"].as_str().unwrap().to_string();
    let body = format!(
        "--upload\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ndraft\r\n\
         --upload\r\nContent-Disposition: form-data; name=\"draft_id\"\r\n\r\n{id}\r\n\
         --upload\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\nuntitled\r\n\
         --upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\n\r\nimage bytes\r\n--upload--\r\n"
    );
    let upload = Request::post(format!("/api/attachments?w={w}"))
        .header(header::AUTHORIZATION, "Bearer secret")
        .header(header::CONTENT_TYPE, "multipart/form-data; boundary=upload")
        .body(Body::from(body))
        .unwrap();
    workspace_case(
        &app,
        w,
        upload,
        cancel,
        || {
            let files = app.workspace.draft_files().unwrap();
            assert_eq!(
                files.read("untitled/image.png", &id).unwrap(),
                b"image bytes"
            );
        },
        || {
            json!({
                "type": "draft",
                "event": "modified",
                "source": { "root": "draft", "path": "untitled/image.png", "draft_id": id },
                "source_w": w,
            })
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_draft_attachment_still_announces() {
    workspace_attachment(true, "w-attachment-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_draft_attachment_announces_once() {
    workspace_attachment(false, "w-attachment-control").await;
}

async fn workspace_write(cancel: bool, w: &str) {
    let app = workspace_app();
    let primary = app.draft().await;
    let id = primary["draft_id"].as_str().unwrap().to_string();
    let write = Request::put(format!(
        "/api/fs/untitled/draft.md?root=draft&draft_id={id}&w={w}"
    ))
    .header(header::AUTHORIZATION, "Bearer secret")
    .body(Body::from("# written\n"))
    .unwrap();
    workspace_case(
        &app,
        w,
        write,
        cancel,
        || {
            let files = app.workspace.draft_files().unwrap();
            let (text, _) = files.read_text_with_stat("untitled/draft.md", &id).unwrap();
            assert_eq!(text, "# written\n");
        },
        || {
            json!({
                "type": "draft", "event": "modified", "source": primary, "source_w": w,
            })
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_draft_write_still_announces() {
    workspace_write(true, "w-write-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_draft_write_announces_once() {
    workspace_write(false, "w-write-control").await;
}

// ---- The eight standalone routes and their attributed `fs` frames ----

const DRAFTS: &str = "home/user/.chan/Drafts";

/// The frames attributed to `w` waiting on `frames`, as (kind, path, to).
/// A frame without `source_w`, such as an OS echo the ticket did not
/// spend, is not the route's announcement and is skipped.
fn attributed(
    frames: &mut mpsc::UnboundedReceiver<String>,
    w: &str,
) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    while let Ok(frame) = frames.try_recv() {
        if let Some(change) = attributed_change(&frame, w) {
            out.push(change);
        }
    }
    out
}

fn attributed_change(frame: &str, w: &str) -> Option<(String, String, Value)> {
    let frame: Value = serde_json::from_str(frame).unwrap();
    if frame["type"] != "fs" || frame["source_w"] != w {
        return None;
    }
    let event = &frame["event"];
    Some((
        event["kind"].as_str().unwrap().to_string(),
        event["path"].as_str().unwrap().to_string(),
        event["to"].clone(),
    ))
}

/// One standalone mutation with a window: its request, its store's check and
/// the whole set of attributed frames its commit sends to the subscribed
/// `scopes`.
async fn standalone_case(
    fx: &Fixture,
    scopes: &[&str],
    w: &str,
    request: Request<Body>,
    cancel: bool,
    stored: impl FnOnce(),
    expected: &[(&str, &str, Value)],
) {
    let (id, mut frames) = fx.registry.register();
    for scope in scopes {
        fx.registry.subscribe(id, scope);
    }
    let mut early = Vec::new();
    run(
        crate::terminal_router(fx.state.clone()),
        w,
        request,
        cancel,
        stored,
        || early = attributed(&mut frames, w),
    )
    .await;
    assert_eq!(early, Vec::new(), "the announcement must follow the store");
    let mut got = Vec::new();
    while got.len() < expected.len() {
        let frame = tokio::time::timeout(BOUND, frames.recv())
            .await
            .expect(if cancel { LOST } else { UNANSWERED })
            .unwrap();
        got.extend(attributed_change(&frame, w));
    }
    let mut want: Vec<(String, String, Value)> = expected
        .iter()
        .map(|(kind, path, to)| (kind.to_string(), path.to_string(), to.clone()))
        .collect();
    got.sort_by(|a, b| a.1.cmp(&b.1));
    want.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(got, want);
    assert_eq!(
        attributed(&mut frames, w),
        Vec::new(),
        "one mutation announces once"
    );
}

fn post(uri: &str, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::post(uri);
    let body = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap()
}

async fn standalone_create_file(cancel: bool, w: &str) {
    let fx = files_fixture();
    standalone_case(
        &fx,
        &[""],
        w,
        post(
            &format!("/api/fs?w={w}"),
            Some(json!({ "path": "made.md", "is_dir": false, "content": "made" })),
        ),
        cancel,
        || {
            assert_eq!(
                std::fs::read_to_string(fx.root.join("made.md")).unwrap(),
                "made"
            )
        },
        &[("Created", "made.md", Value::Null)],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_create_still_announces() {
    standalone_create_file(true, "w-fs-create-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_create_announces_once() {
    standalone_create_file(false, "w-fs-create-control").await;
}

async fn standalone_delete_file(cancel: bool, w: &str) {
    let fx = files_fixture();
    std::fs::write(fx.root.join("gone.md"), "gone").unwrap();
    standalone_case(
        &fx,
        &[""],
        w,
        Request::delete(format!("/api/fs/gone.md?w={w}"))
            .body(Body::empty())
            .unwrap(),
        cancel,
        || assert!(!fx.root.join("gone.md").exists()),
        &[("Removed", "gone.md", Value::Null)],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_delete_still_announces() {
    standalone_delete_file(true, "w-fs-delete-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_delete_announces_once() {
    standalone_delete_file(false, "w-fs-delete-control").await;
}

async fn standalone_write_file(cancel: bool, w: &str) {
    let fx = files_fixture();
    standalone_case(
        &fx,
        &[""],
        w,
        Request::put(format!("/api/fs/written.md?w={w}"))
            .body(Body::from("written"))
            .unwrap(),
        cancel,
        || {
            assert_eq!(
                std::fs::read_to_string(fx.root.join("written.md")).unwrap(),
                "written"
            )
        },
        &[("Modified", "written.md", Value::Null)],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_write_still_announces() {
    standalone_write_file(true, "w-fs-write-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_write_announces_once() {
    standalone_write_file(false, "w-fs-write-control").await;
}

async fn standalone_move(cancel: bool, w: &str) {
    let fx = files_fixture();
    std::fs::write(fx.root.join("from.md"), "moved").unwrap();
    standalone_case(
        &fx,
        &[""],
        w,
        post(
            &format!("/api/move?w={w}"),
            Some(json!({ "from": "from.md", "to": "to.md" })),
        ),
        cancel,
        || {
            assert!(!fx.root.join("from.md").exists());
            assert_eq!(
                std::fs::read_to_string(fx.root.join("to.md")).unwrap(),
                "moved"
            );
        },
        &[("Renamed", "from.md", json!("to.md"))],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_move_still_announces() {
    standalone_move(true, "w-fs-move-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_move_announces_once() {
    standalone_move(false, "w-fs-move-control").await;
}

async fn standalone_create_draft(cancel: bool, w: &str, uri: &str, leaf: &str, seed: &str) {
    let fx = files_fixture();
    let dir = format!("{DRAFTS}/untitled");
    let primary = format!("{dir}/{leaf}");
    standalone_case(
        &fx,
        &[DRAFTS, dir.as_str()],
        w,
        post(&format!("{uri}?w={w}"), None),
        cancel,
        || {
            assert_eq!(
                std::fs::read_to_string(fx.root.join(&primary)).unwrap(),
                seed
            )
        },
        &[
            ("Created", dir.as_str(), Value::Null),
            ("Created", primary.as_str(), Value::Null),
        ],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_draft_create_still_announces() {
    standalone_create_draft(
        true,
        "w-sa-create-pin",
        "/api/drafts/new",
        "draft.md",
        NEW_DRAFT_CONTENT,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_draft_create_announces_once() {
    standalone_create_draft(
        false,
        "w-sa-create-control",
        "/api/drafts/new",
        "draft.md",
        NEW_DRAFT_CONTENT,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_diagram_create_still_announces() {
    standalone_create_draft(
        true,
        "w-sa-diagram-pin",
        "/api/diagrams/new",
        "untitled.excalidraw",
        NEW_DIAGRAM_CONTENT,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_diagram_create_announces_once() {
    standalone_create_draft(
        false,
        "w-sa-diagram-control",
        "/api/diagrams/new",
        "untitled.excalidraw",
        NEW_DIAGRAM_CONTENT,
    )
    .await;
}

/// A standalone draft made by the route without a window, so nothing is
/// attributed or held.
async fn standalone_draft(fx: &Fixture) {
    let response = crate::terminal_router(fx.state.clone())
        .oneshot(post("/api/drafts/new", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn standalone_discard_draft(cancel: bool, w: &str) {
    let fx = files_fixture();
    standalone_draft(&fx).await;
    let dir = format!("{DRAFTS}/untitled");
    standalone_case(
        &fx,
        &[DRAFTS],
        w,
        post(
            &format!("/api/drafts/discard?w={w}"),
            Some(json!({ "path": format!("{dir}/draft.md") })),
        ),
        cancel,
        || assert!(!fx.root.join(&dir).exists()),
        &[("Removed", dir.as_str(), Value::Null)],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_draft_discard_still_announces() {
    standalone_discard_draft(true, "w-sa-discard-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_draft_discard_announces_once() {
    standalone_discard_draft(false, "w-sa-discard-control").await;
}

async fn standalone_promote_draft(cancel: bool, w: &str) {
    let fx = files_fixture();
    standalone_draft(&fx).await;
    let dir = format!("{DRAFTS}/untitled");
    standalone_case(
        &fx,
        &[DRAFTS, "home/user"],
        w,
        post(
            &format!("/api/drafts/promote?w={w}"),
            Some(json!({ "path": format!("{dir}/draft.md"), "target": "home/user/saved.md" })),
        ),
        cancel,
        || {
            assert!(!fx.root.join(&dir).exists());
            assert_eq!(
                std::fs::read_to_string(fx.root.join("home/user/saved.md")).unwrap(),
                NEW_DRAFT_CONTENT
            );
        },
        &[
            ("Removed", dir.as_str(), Value::Null),
            ("Created", "home/user/saved.md", Value::Null),
        ],
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_standalone_draft_promote_still_announces() {
    standalone_promote_draft(true, "w-sa-promote-pin").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answered_standalone_draft_promote_announces_once() {
    standalone_promote_draft(false, "w-sa-promote-control").await;
}
