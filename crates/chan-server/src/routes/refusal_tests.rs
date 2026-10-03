use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::tests::{served_state, with_blocking_tasks_cancelled};

// The sentence each kind of extractor rejection answers.
const NOT_JSON: &str = "the request body is not valid JSON";
const WRONG_SHAPE: &str = "the request body does not match what this route accepts";
const NOT_JSON_CONTENT_TYPE: &str = "the request body must have the content type application/json";
const TOO_LARGE: &str = "the request body is too large";
const UNREADABLE_BODY: &str = "the request body could not be read";
const BAD_QUERY: &str = "the query string does not match what this route accepts";
const BAD_PATH: &str = "the request path does not match what this route accepts";
const NO_BOUNDARY: &str = "the multipart request has no valid boundary";
const MISASSEMBLED: &str = "this route cannot read its request";

pub(super) async fn assert_refusal(response: Response, status: StatusCode, expected: Value) {
    assert_eq!(response.status(), status);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE),
        Some(&header::HeaderValue::from_static("application/json")),
        "a tenant refusal must have the JSON content type"
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&body).expect("a tenant refusal must be JSON");
    assert_eq!(body, expected);
}

async fn workspace_request(uri: &str) -> Response {
    let (_cfg, _root, state) = served_state();
    crate::router(state)
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn missing_link_refusal_is_json() {
    assert_refusal(
        workspace_request("/api/resolve-link?target=missing.md").await,
        StatusCode::NOT_FOUND,
        json!({"error": "link target not found", "code": "link_not_found"}),
    )
    .await;
}

#[tokio::test]
async fn missing_directory_report_refusal_is_json() {
    assert_refusal(
        workspace_request("/api/report/dir?path=missing").await,
        StatusCode::NOT_FOUND,
        json!({"error": "directory report not found", "code": "report_not_found"}),
    )
    .await;
}

#[tokio::test]
async fn missing_file_report_refusal_is_json() {
    assert_refusal(
        workspace_request("/api/report/file?path=missing.rs").await,
        StatusCode::NOT_FOUND,
        json!({"error": "file report not found", "code": "report_not_found"}),
    )
    .await;
}

#[tokio::test]
async fn empty_report_path_refusal_is_json() {
    assert_refusal(
        workspace_request("/api/report/file?path=%20").await,
        StatusCode::BAD_REQUEST,
        json!({"error": "file report path is required"}),
    )
    .await;
}

macro_rules! metadata_refusal {
    ($name:ident, $uri:literal, $message:literal) => {
        #[tokio::test]
        async fn $name() {
            let (_cfg, _root, state) = served_state();
            let response = with_blocking_tasks_cancelled(
                crate::router(state)
                    .oneshot(Request::get($uri).body(Body::empty()).unwrap()),
            )
            .await
            .unwrap();
            assert_refusal(
                response,
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": $message}),
            )
            .await;
        }
    };
}

metadata_refusal!(
    graph_missing_metadata_refusal_is_json,
    "/api/graph?stream=1",
    "graph stream ended before metadata"
);
metadata_refusal!(
    backlinks_missing_metadata_refusal_is_json,
    "/api/backlinks/missing.md?stream=1",
    "backlinks stream ended before metadata"
);
metadata_refusal!(
    report_missing_metadata_refusal_is_json,
    "/api/report/file?path=missing.rs&stream=1",
    "report stream ended before metadata"
);

#[tokio::test]
async fn blocking_panic_refusal_is_json() {
    let error = tokio::task::spawn_blocking(|| panic!("blocking failure"))
        .await
        .unwrap_err();
    let message = format!("file read task panicked: {error}");
    assert_refusal(
        super::BlockingTaskFailed {
            label: "file read",
            error,
        }
        .into_response(),
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error": message}),
    )
    .await;
}

#[tokio::test]
async fn blocking_route_refusal_is_json() {
    let (_cfg, _root, state) = served_state();
    let response = with_blocking_tasks_cancelled(
        crate::router(state).oneshot(Request::get("/api/preflight").body(Body::empty()).unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body.as_object().unwrap().len(), 1);
    let message = body["error"].as_str().unwrap();
    let task_id = message
        .strip_prefix("preflight task panicked: task ")
        .and_then(|s| s.strip_suffix(" was cancelled"))
        .expect("the route must retain its label and the join error");
    assert!(!task_id.is_empty() && task_id.bytes().all(|b| b.is_ascii_digit()));
}

async fn session_request(method: &str, uri: &str, dir: &std::path::Path) -> Response {
    let mut state = crate::state::test_support::make_test_state(false);
    Arc::get_mut(&mut state).unwrap().terminal_session_dir = Some(dir.to_path_buf());
    crate::terminal_router(state)
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn session_invalid_key_refusal_is_json() {
    let dir = tempfile::tempdir().unwrap();
    assert_refusal(
        session_request("PUT", "/api/session?w=..%2Fescape", dir.path()).await,
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error": "invalid session key"}),
    )
    .await;
}

#[tokio::test]
async fn session_read_refusal_is_json() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("window");
    std::fs::create_dir(&key).unwrap();
    let message = std::fs::read(&key).unwrap_err().to_string();
    assert_refusal(
        session_request("GET", "/api/session?w=window", dir.path()).await,
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error": message}),
    )
    .await;
}

#[tokio::test]
async fn session_delete_refusal_is_json() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("window");
    std::fs::create_dir(&key).unwrap();
    let message = std::fs::remove_file(&key).unwrap_err().to_string();
    assert_refusal(
        session_request("DELETE", "/api/session?w=window", dir.path()).await,
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error": message}),
    )
    .await;
}

#[tokio::test]
async fn session_list_refusal_is_json() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("sessions");
    std::fs::write(&dir, b"occupied").unwrap();
    let message = std::fs::read_dir(&dir).unwrap_err().to_string();
    assert_refusal(
        session_request("GET", "/api/sessions", &dir).await,
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error": message}),
    )
    .await;
}

/// A wrong method on a real route keeps the framework's 405 and the `Allow`
/// header naming the route's methods, with the envelope for its body.
async fn assert_method_refused(response: Response, allow: &str) {
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        response
            .headers()
            .get(header::ALLOW)
            .and_then(|value| value.to_str().ok()),
        Some(allow),
        "the Allow header names the route's methods"
    );
    assert_refusal(
        response,
        StatusCode::METHOD_NOT_ALLOWED,
        json!({"error": "method not allowed"}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_wrong_method_is_json() {
    let (_cfg, _root, state) = served_state();
    let response = crate::router(state)
        .oneshot(
            Request::post("/api/resolve-link")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_method_refused(response, "GET,HEAD").await;
}

#[tokio::test]
async fn terminal_tenant_wrong_method_is_json() {
    let state = crate::state::test_support::make_test_state(false);
    let response = crate::terminal_router(state)
        .oneshot(
            Request::delete("/api/survey/reply")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_method_refused(response, "POST").await;
}

const LAUNCHER_BEARER: &str = "launcher-bearer";

/// One request through the launcher's router over a throwaway library, with a
/// bound serve address, and behind [`LAUNCHER_BEARER`] when `gated`.
async fn launcher_answer(gated: bool, request: Request<Body>) -> Response {
    let config = tempfile::tempdir().unwrap();
    let library = chan_workspace::Library::open_at(config.path().join("config.toml")).unwrap();
    let host = Arc::new(crate::WorkspaceHost::new(library, crate::route_builder()));
    let bearer = gated.then(|| Arc::new(std::sync::RwLock::new(LAUNCHER_BEARER.to_string())));
    let serve_addr = std::sync::OnceLock::new();
    let _ = serve_addr.set("127.0.0.1:8080".parse().unwrap());
    crate::routes::launcher_router(host, bearer, Some(Arc::new(serve_addr)))
        .oneshot(request)
        .await
        .unwrap()
}

fn bodiless(method: &str, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

/// One route of each launcher sub-router that takes the 405 answer: the
/// management routes, a reverse-tunnel leg, the surface's configuration, the
/// capability mint and a capability use.
#[tokio::test]
async fn launcher_wrong_method_is_json() {
    for (method, uri, allow) in [
        ("PATCH", "/api/library/workspaces", "GET,HEAD,POST"),
        ("POST", "/api/library/tunnel/control", "GET,HEAD"),
        ("DELETE", "/api/library/local-color", "GET,HEAD,PUT"),
        ("GET", "/api/library/command-capabilities", "POST"),
        (
            "DELETE",
            "/api/library/command-capabilities/probe/actions",
            "POST",
        ),
    ] {
        assert_method_refused(launcher_answer(false, bodiless(method, uri)).await, allow).await;
    }
}

/// A launcher gate answers a wrong method before the 405 does, and its
/// refusal keeps the route's Allow.
async fn assert_gate_refuses_first(
    response: Response,
    allow: &str,
    status: StatusCode,
    sentence: &str,
) {
    assert_eq!(
        response
            .headers()
            .get(header::ALLOW)
            .and_then(|value| value.to_str().ok()),
        Some(allow),
        "the gate's refusal carries the route's Allow"
    );
    assert_refusal(response, status, json!({"error": sentence})).await;
}

#[tokio::test]
async fn launcher_bearer_refuses_a_wrong_method_first() {
    assert_gate_refuses_first(
        launcher_answer(true, bodiless("PATCH", "/api/library/workspaces")).await,
        "GET,HEAD,POST",
        StatusCode::UNAUTHORIZED,
        "missing or invalid launcher bearer token",
    )
    .await;
}

#[tokio::test]
async fn surface_bearer_refuses_a_wrong_method_on_a_config_route_first() {
    assert_gate_refuses_first(
        launcher_answer(true, bodiless("DELETE", "/api/library/local-color")).await,
        "GET,HEAD,PUT",
        StatusCode::UNAUTHORIZED,
        "missing or invalid surface bearer token",
    )
    .await;
}

#[tokio::test]
async fn surface_bearer_refuses_a_wrong_method_on_the_capability_mint_first() {
    assert_gate_refuses_first(
        launcher_answer(true, bodiless("GET", "/api/library/command-capabilities")).await,
        "POST",
        StatusCode::UNAUTHORIZED,
        "missing or invalid surface bearer token",
    )
    .await;
}

/// The owner's browser session passes the launcher bearer as a tunnel caller
/// and is refused the legs, whatever the method.
#[tokio::test]
async fn owner_gate_refuses_a_wrong_method_on_a_tunnel_leg_first() {
    let origin = crate::route_authority::test_support::Caller::BrowserOwner
        .origin()
        .expect("a tunnel caller");
    let request = Request::post("/api/library/tunnel/control")
        .extension(origin)
        .body(Body::empty())
        .unwrap();
    assert_gate_refuses_first(
        launcher_answer(true, request).await,
        "GET,HEAD",
        StatusCode::FORBIDDEN,
        "reverse tunnels are not available for this gateway role",
    )
    .await;
}

/// A capability path is a credential, so the 405 on a capability route keeps
/// the headers that hold it out of caches and referrers.
#[tokio::test]
async fn capability_routes_keep_their_headers_on_a_wrong_method() {
    for (method, uri) in [
        ("GET", "/api/library/command-capabilities"),
        ("DELETE", "/api/library/command-capabilities/probe/actions"),
    ] {
        let response = launcher_answer(false, bodiless(method, uri)).await;
        assert_eq!(
            response.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {uri}"
        );
        for (name, value) in [
            (header::CACHE_CONTROL, "no-store, private"),
            (header::REFERRER_POLICY, "no-referrer"),
        ] {
            assert_eq!(
                response
                    .headers()
                    .get(&name)
                    .and_then(|found| found.to_str().ok()),
                Some(value),
                "{method} {uri}: {name}"
            );
        }
    }
}

/// One byte over the framework's default body limit, which the survey reply
/// and the session routes keep.
const OVER_DEFAULT_LIMIT: usize = 2 * 1024 * 1024 + 1;

async fn workspace_answer(request: Request<Body>) -> Response {
    let (_cfg, _root, state) = served_state();
    crate::router(state).oneshot(request).await.unwrap()
}

async fn terminal_answer(request: Request<Body>) -> Response {
    let state = crate::state::test_support::make_test_state(false);
    crate::terminal_router(state)
        .oneshot(request)
        .await
        .unwrap()
}

fn survey_reply_without_content_type() -> Request<Body> {
    Request::post("/api/survey/reply")
        .body(Body::from("{}"))
        .unwrap()
}

fn survey_reply_over_the_limit() -> Request<Body> {
    Request::post("/api/survey/reply")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(vec![b' '; OVER_DEFAULT_LIMIT]))
        .unwrap()
}

fn session_over_the_limit() -> Request<Body> {
    Request::put("/api/session?w=probe")
        .body(Body::from(vec![b'x'; OVER_DEFAULT_LIMIT]))
        .unwrap()
}

fn draft_over_the_limit() -> Request<Body> {
    Request::post("/api/drafts/new")
        .body(Body::from(vec![b'x'; OVER_DEFAULT_LIMIT]))
        .unwrap()
}

#[tokio::test]
async fn workspace_tenant_draft_over_the_limit_is_json() {
    assert_refusal(
        workspace_answer(draft_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": TOO_LARGE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_draft_over_the_limit_is_json() {
    assert_refusal(
        terminal_answer(draft_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": TOO_LARGE}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_missing_json_content_type_is_json() {
    assert_refusal(
        workspace_answer(survey_reply_without_content_type()).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error": NOT_JSON_CONTENT_TYPE}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_json_over_the_limit_is_json() {
    assert_refusal(
        workspace_answer(survey_reply_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": TOO_LARGE}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_bytes_over_the_limit_is_json() {
    assert_refusal(
        workspace_answer(session_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": TOO_LARGE}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_path_not_utf8_is_json() {
    let request = || {
        Request::get("/api/headings/%FF")
            .body(Body::empty())
            .unwrap()
    };
    assert_refusal(
        workspace_answer(request()).await,
        StatusCode::BAD_REQUEST,
        json!({"error": BAD_PATH}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_multipart_boundary_is_json() {
    let request = || {
        Request::post("/api/attachments")
            .header(header::CONTENT_TYPE, "multipart/form-data")
            .body(Body::empty())
            .unwrap()
    };
    assert_refusal(
        workspace_answer(request()).await,
        StatusCode::BAD_REQUEST,
        json!({"error": NO_BOUNDARY}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_missing_json_content_type_is_json() {
    assert_refusal(
        terminal_answer(survey_reply_without_content_type()).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error": NOT_JSON_CONTENT_TYPE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_json_over_the_limit_is_json() {
    assert_refusal(
        terminal_answer(survey_reply_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": TOO_LARGE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_bytes_over_the_limit_is_json() {
    assert_refusal(
        terminal_answer(session_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": TOO_LARGE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_path_not_utf8_is_json() {
    let request = || {
        Request::delete("/api/terminals/%FF")
            .body(Body::empty())
            .unwrap()
    };
    assert_refusal(
        terminal_answer(request()).await,
        StatusCode::BAD_REQUEST,
        json!({"error": BAD_PATH}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_multipart_boundary_is_json() {
    let request = || {
        Request::post("/api/attachments")
            .header(header::CONTENT_TYPE, "multipart/form-data")
            .body(Body::empty())
            .unwrap()
    };
    assert_refusal(
        terminal_answer(request()).await,
        StatusCode::BAD_REQUEST,
        json!({"error": NO_BOUNDARY}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_drafts_missing_json_content_type_is_json() {
    let request = || {
        Request::post("/api/drafts/inspect")
            .body(Body::from("{}"))
            .unwrap()
    };
    assert_refusal(
        terminal_answer(request()).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error": NOT_JSON_CONTENT_TYPE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_drafts_query_is_json() {
    // A repeated field is not a query the route takes.
    assert_refusal(
        terminal_answer(
            Request::post("/api/drafts/new?w=a&w=b")
                .body(Body::empty())
                .unwrap(),
        )
        .await,
        StatusCode::BAD_REQUEST,
        json!({"error": BAD_QUERY}),
    )
    .await;
}

/// A JSON string where a route takes an object.
fn json_string(uri: &str) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#""x""#))
        .unwrap()
}

#[tokio::test]
async fn workspace_tenant_json_of_the_wrong_type_names_no_rust_type() {
    assert_refusal(
        workspace_answer(json_string("/api/survey/reply")).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({"error": WRONG_SHAPE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_json_of_the_wrong_type_names_no_rust_type() {
    assert_refusal(
        terminal_answer(json_string("/api/survey/reply")).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({"error": WRONG_SHAPE}),
    )
    .await;
}

#[tokio::test]
async fn launcher_json_of_the_wrong_type_names_no_rust_type() {
    assert_refusal(
        launcher_answer(false, json_string("/api/library/windows")).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({"error": WRONG_SHAPE}),
    )
    .await;
}

/// A router assembled without the layer that carries a handler's extension
/// answers a server fault in the envelope, and names no Rust type.
#[tokio::test]
async fn a_missing_extension_is_json_and_names_no_rust_type() {
    let response = axum::Router::new()
        .route(
            "/api/extensions",
            axum::routing::get(crate::routes::api_extensions),
        )
        .oneshot(bodiless("GET", "/api/extensions"))
        .await
        .unwrap();
    assert_refusal(
        response,
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error": MISASSEMBLED}),
    )
    .await;
}

fn broken_body() -> Body {
    Body::from_stream(futures::stream::iter([Err::<axum::body::Bytes, _>(
        std::io::Error::other("the client went away"),
    )]))
}

fn create_window(content_type: Option<&str>, body: impl Into<Body>) -> Request<Body> {
    let request = Request::post("/api/library/windows");
    match content_type {
        Some(content_type) => request.header(header::CONTENT_TYPE, content_type),
        None => request,
    }
    .body(body.into())
    .unwrap()
}

/// A launcher route's JSON body, in each shape the JSON extractor refuses.
#[tokio::test]
async fn launcher_json_rejections_are_json() {
    let json = Some("application/json");
    let cases: [(StatusCode, &str, Request<Body>); 5] = [
        (StatusCode::BAD_REQUEST, NOT_JSON, create_window(json, "{")),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            WRONG_SHAPE,
            create_window(json, "7"),
        ),
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            NOT_JSON_CONTENT_TYPE,
            create_window(None, "{}"),
        ),
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            TOO_LARGE,
            create_window(json, vec![b' '; OVER_DEFAULT_LIMIT]),
        ),
        (
            StatusCode::BAD_REQUEST,
            UNREADABLE_BODY,
            create_window(json, broken_body()),
        ),
    ];
    for (status, sentence, request) in cases {
        assert_refusal(
            launcher_answer(false, request).await,
            status,
            json!({"error": sentence}),
        )
        .await;
    }
}

/// The launcher's off route buffers its optional body itself.
#[tokio::test]
async fn launcher_bytes_rejections_are_json() {
    let off = |body: Body| {
        Request::post("/api/library/workspaces/probe/off")
            .body(body)
            .unwrap()
    };
    let cases: [(StatusCode, &str, Body); 2] = [
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            TOO_LARGE,
            Body::from(vec![b'x'; OVER_DEFAULT_LIMIT]),
        ),
        (StatusCode::BAD_REQUEST, UNREADABLE_BODY, broken_body()),
    ];
    for (status, sentence, body) in cases {
        assert_refusal(
            launcher_answer(false, off(body)).await,
            status,
            json!({"error": sentence}),
        )
        .await;
    }
}

#[tokio::test]
async fn launcher_path_not_utf8_is_json() {
    let request = || bodiless("DELETE", "/api/library/windows/%FF");
    assert_refusal(
        launcher_answer(false, request()).await,
        StatusCode::BAD_REQUEST,
        json!({"error": BAD_PATH}),
    )
    .await;
}

/// The path rejection on a capability route keeps the capability headers.
#[tokio::test]
async fn capability_path_not_utf8_is_json_with_its_headers() {
    let request = || bodiless("GET", "/api/library/command-capabilities/%FF");
    let response = launcher_answer(false, request()).await;
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "no-store, private"
    );
    assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
    assert_refusal(
        response,
        StatusCode::BAD_REQUEST,
        json!({"error": BAD_PATH}),
    )
    .await;
}

#[tokio::test]
async fn launcher_query_rejections_are_json() {
    // A repeated field, and a value that is not the field's type.
    for uri in [
        "/api/library/windows/x?acting_window_id=a&acting_window_id=b",
        "/api/library/workspaces/x?force=x",
    ] {
        assert_refusal(
            launcher_answer(false, bodiless("DELETE", uri)).await,
            StatusCode::BAD_REQUEST,
            json!({"error": BAD_QUERY}),
        )
        .await;
    }
}

async fn settings_write_with_wrong_method(settings_disabled: bool) -> Response {
    let state = crate::state::test_support::make_test_state(settings_disabled);
    crate::router(state)
        .oneshot(
            Request::put("/api/storage/reset")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

/// The settings gate's refusal keeps the route's Allow on a wrong method.
#[tokio::test]
async fn disabled_settings_refuse_a_wrong_method_first() {
    let response = settings_write_with_wrong_method(true).await;
    assert_eq!(
        response.headers().get(header::ALLOW),
        Some(&header::HeaderValue::from_static("POST")),
        "the settings refusal carries the route's Allow"
    );
    assert_refusal(
        response,
        StatusCode::FORBIDDEN,
        json!({"error": "settings are disabled on this server (started with --no-settings); configuration changes are not permitted here"}),
    )
    .await;
}

#[tokio::test]
async fn enabled_settings_answer_a_wrong_method_with_the_405() {
    assert_method_refused(settings_write_with_wrong_method(false).await, "POST").await;
}

fn restart_unknown_terminal(json_body: Option<&'static str>) -> Request<Body> {
    let request = Request::post("/api/terminals/missing/restart");
    match json_body {
        Some(body) => request
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body)),
        None => request.body(Body::empty()),
    }
    .unwrap()
}

/// The restart route's body is optional: without one the request reaches the
/// route, and a malformed one is refused in the envelope.
#[tokio::test]
async fn terminal_restart_without_a_body_reaches_the_route() {
    assert_refusal(
        terminal_answer(restart_unknown_terminal(None)).await,
        StatusCode::NOT_FOUND,
        json!({"error": "terminal session not found"}),
    )
    .await;
}

#[tokio::test]
async fn terminal_restart_with_a_malformed_body_is_json() {
    assert_refusal(
        terminal_answer(restart_unknown_terminal(Some("{"))).await,
        StatusCode::BAD_REQUEST,
        json!({"error": NOT_JSON}),
    )
    .await;
}
