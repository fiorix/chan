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
