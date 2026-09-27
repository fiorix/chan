use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::tests::{served_state, with_blocking_tasks_cancelled};

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

const MISSING_CONTENT_TYPE: &str = "Expected request with `Content-Type: application/json`";
const LENGTH_LIMIT: &str = "Failed to buffer the request body: length limit exceeded";

#[tokio::test]
async fn workspace_tenant_missing_json_content_type_is_json() {
    assert_refusal(
        workspace_answer(survey_reply_without_content_type()).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error": MISSING_CONTENT_TYPE}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_json_over_the_limit_is_json() {
    assert_refusal(
        workspace_answer(survey_reply_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": LENGTH_LIMIT}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_bytes_over_the_limit_is_json() {
    assert_refusal(
        workspace_answer(session_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": LENGTH_LIMIT}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_path_not_utf8_is_json() {
    assert_refusal(
        workspace_answer(
            Request::get("/api/headings/%FF")
                .body(Body::empty())
                .unwrap(),
        )
        .await,
        StatusCode::BAD_REQUEST,
        json!({"error": "Invalid URL: Invalid UTF-8 in `path`"}),
    )
    .await;
}

#[tokio::test]
async fn workspace_tenant_multipart_boundary_is_json() {
    assert_refusal(
        workspace_answer(
            Request::post("/api/attachments")
                .header(header::CONTENT_TYPE, "multipart/form-data")
                .body(Body::empty())
                .unwrap(),
        )
        .await,
        StatusCode::BAD_REQUEST,
        json!({"error": "Invalid `boundary` for `multipart/form-data` request"}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_missing_json_content_type_is_json() {
    assert_refusal(
        terminal_answer(survey_reply_without_content_type()).await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error": MISSING_CONTENT_TYPE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_json_over_the_limit_is_json() {
    assert_refusal(
        terminal_answer(survey_reply_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": LENGTH_LIMIT}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_bytes_over_the_limit_is_json() {
    assert_refusal(
        terminal_answer(session_over_the_limit()).await,
        StatusCode::PAYLOAD_TOO_LARGE,
        json!({"error": LENGTH_LIMIT}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_path_not_utf8_is_json() {
    assert_refusal(
        terminal_answer(
            Request::delete("/api/terminals/%FF")
                .body(Body::empty())
                .unwrap(),
        )
        .await,
        StatusCode::BAD_REQUEST,
        json!({"error": "Invalid URL: Invalid UTF-8 in `session`"}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_multipart_boundary_is_json() {
    assert_refusal(
        terminal_answer(
            Request::post("/api/attachments")
                .header(header::CONTENT_TYPE, "multipart/form-data")
                .body(Body::empty())
                .unwrap(),
        )
        .await,
        StatusCode::BAD_REQUEST,
        json!({"error": "Invalid `boundary` for `multipart/form-data` request"}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_drafts_missing_json_content_type_is_json() {
    assert_refusal(
        terminal_answer(
            Request::post("/api/drafts/inspect")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        json!({"error": MISSING_CONTENT_TYPE}),
    )
    .await;
}

#[tokio::test]
async fn terminal_tenant_drafts_query_is_json() {
    let uri: axum::http::Uri = "/api/drafts/new?w=a&w=b".parse().unwrap();
    let Err(rejection) = axum::extract::Query::<
        crate::routes::standalone_fs::StandaloneMutationQuery,
    >::try_from_uri(&uri) else {
        panic!("a repeated field is not a query the route takes");
    };
    let sentence = rejection.body_text();
    assert_refusal(
        terminal_answer(Request::post(uri).body(Body::empty()).unwrap()).await,
        StatusCode::BAD_REQUEST,
        json!({"error": sentence}),
    )
    .await;
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

/// The settings gate answers a wrong method on a settings write before the
/// 405, as it answers the right one.
#[tokio::test]
async fn disabled_settings_refuse_a_wrong_method_first() {
    assert_refusal(
        settings_write_with_wrong_method(true).await,
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
        json!({"error": "Failed to parse the request body as JSON: EOF while parsing an object at line 1 column 1"}),
    )
    .await;
}
