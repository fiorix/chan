//! Inspect refusals from the assembled routers in this crate's unit tests.

use axum::body::{to_bytes, Body};
use axum::extract::{MatchedPath, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;

#[derive(Clone, Debug)]
pub(crate) struct Inspected;

#[derive(Clone, Debug)]
pub(crate) struct UpstreamResponse;

pub(crate) fn check(app: Router) -> Router {
    app.layer(middleware::from_fn_with_state(true, inspect))
}

pub(crate) fn check_devserver(app: Router) -> Router {
    // Tenant and launcher navigation refusals are inspected at their own paths.
    app.layer(middleware::from_fn_with_state(false, inspect))
}

async fn inspect(State(allow_navigation): State<bool>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let matched = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned());
    let is_fallback = matched.is_none();
    let response = next.run(request).await;
    if response.extensions().get::<Inspected>().is_some()
        || response.extensions().get::<UpstreamResponse>().is_some()
        || !(response.status().is_client_error() || response.status().is_server_error())
    {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX)
        .await
        .expect("read refusal body without changing its bytes");
    let envelope = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == "application/json")
        && serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .is_some_and(|value| {
                value.is_object()
                    && value["error"].as_str().is_some_and(|s| !s.is_empty())
                    && value
                        .get("code")
                        .is_none_or(|code| code.as_str().is_some_and(|s| !s.is_empty()))
            });
    let framework = framework_exception(parts.status, &parts.headers, &bytes);
    if let Some(kind) = framework {
        eprintln!(
            "refusal-framework\t{kind}\t{}\t{method}\t{}",
            parts.status.as_u16(),
            matched.as_deref().unwrap_or(&path)
        );
    }
    assert!(
        envelope
            || framework.is_some()
            // HEAD has no response body, including on a refusal.
            || (method == Method::HEAD && bytes.is_empty())
            || permanent_exception(&method, &path, parts.status, is_fallback && allow_navigation, &bytes)
            || range_refusal(&method, &path, parts.status, &parts.headers, &bytes)
            || pending_refusal(&method, &path, parts.status, &parts.headers, &bytes, is_fallback)
            || PENDING
                .iter()
                .any(|(verb, route)| { method.as_str() == *verb && matches_path(route, &path) }),
        "refusal envelope violated: {method} {path} returned {} with body {:?}",
        parts.status,
        String::from_utf8_lossy(&bytes),
    );
    parts.extensions.insert(Inspected);
    Response::from_parts(parts, Body::from(bytes))
}

fn pending_refusal(
    method: &Method,
    path: &str,
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    is_fallback: bool,
) -> bool {
    if *method == Method::PUT
        && matches_path("/api/fs/{*path}", path)
        && matches!(
            status,
            StatusCode::CONFLICT | StatusCode::PRECONDITION_REQUIRED
        )
        && headers
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v == "application/json")
        && write_conflict_shape(body)
    {
        return true;
    }
    // Host dispatch is a fallback; its lock error belongs to chan-library.
    is_fallback
        && status == StatusCode::INTERNAL_SERVER_ERROR
        && body == b"config: workspace host lock poisoned"
}

fn range_refusal(
    method: &Method,
    path: &str,
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> bool {
    // Binary resources and downloads use HTTP ranges, with no JSON reader.
    *method == Method::GET
        && matches_path("/api/fs/{*path}", path)
        && status == StatusCode::RANGE_NOT_SATISFIABLE
        && body.is_empty()
        && headers
            .get(header::ACCEPT_RANGES)
            .is_some_and(|v| v == "bytes")
        && headers
            .get(header::ETAG)
            .is_some_and(|v| !v.as_bytes().is_empty())
        && headers
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("bytes */"))
            .is_some_and(|size| !size.is_empty() && size.bytes().all(|b| b.is_ascii_digit()))
}

fn write_conflict_shape(body: &[u8]) -> bool {
    let Ok(serde_json::Value::Object(fields)) = serde_json::from_slice(body) else {
        return false;
    };
    fields.keys().all(|key| {
        matches!(
            key.as_str(),
            "current_mtime" | "current_mtime_ns" | "current_authority_version" | "disk_conflicted"
        )
    }) && fields
        .get("current_mtime")
        .is_some_and(|v| v.is_null() || v.as_i64().is_some())
        && fields
            .get("disk_conflicted")
            .is_some_and(serde_json::Value::is_boolean)
        && fields
            .get("current_mtime_ns")
            .is_none_or(serde_json::Value::is_string)
        && fields
            .get("current_authority_version")
            .is_none_or(|v| v.as_u64().is_some())
}

fn framework_exception(
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> Option<&'static str> {
    if status == StatusCode::METHOD_NOT_ALLOWED
        && body.is_empty()
        && headers
            .get(header::ALLOW)
            .is_some_and(|value| !value.as_bytes().is_empty())
    {
        return Some("MethodNotAllowed");
    }
    let body = std::str::from_utf8(body).ok()?;
    FRAMEWORK_PENDING
        .iter()
        .find_map(|&(kind, code, text, prefix)| {
            (status.as_u16() == code
                && if prefix {
                    body.starts_with(text)
                } else {
                    body == text
                })
            .then_some(kind)
        })
}

// Axum's extractor replies are identified by their own fixed text, never
// just by a status shared with application refusals. The boolean selects
// a fixed prefix for rejection types that append their underlying error.
const FRAMEWORK_PENDING: &[(&str, u16, &str, bool)] = &[
    (
        "JsonSyntaxError",
        400,
        "Failed to parse the request body as JSON: ",
        true,
    ),
    (
        "JsonDataError",
        422,
        "Failed to deserialize the JSON body into the target type: ",
        true,
    ),
    // The search handler re-emits this rejection with a 400 status.
    (
        "JsonDataError",
        400,
        "Failed to deserialize the JSON body into the target type: ",
        true,
    ),
    (
        "MissingJsonContentType",
        415,
        "Expected request with `Content-Type: application/json`",
        false,
    ),
    (
        "FailedToDeserializeQueryString",
        400,
        "Failed to deserialize query string: ",
        true,
    ),
    // The search handler maps every JsonRejection to 400.
    (
        "MissingJsonContentType",
        400,
        "Expected request with `Content-Type: application/json`",
        false,
    ),
    ("FailedToDeserializePathParams", 400, "Invalid URL: ", true),
    (
        "InvalidBoundary",
        400,
        "Invalid `boundary` for `multipart/form-data` request",
        false,
    ),
    (
        "LengthLimitError",
        413,
        "Failed to buffer the request body: ",
        true,
    ),
    (
        "UnknownBodyError",
        400,
        "Failed to buffer the request body: ",
        true,
    ),
    (
        "InvalidUtf8",
        400,
        "Request body didn't contain valid UTF-8: ",
        true,
    ),
    ("MultipartError", 413, "Request payload is too large", false),
];

fn matches_path(pattern: &str, path: &str) -> bool {
    let mut actual = path.split('/');
    for segment in pattern.split('/') {
        if segment.starts_with("{*") {
            return actual.next().is_some_and(|part| !part.is_empty());
        }
        let Some(part) = actual.next() else {
            return false;
        };
        if segment.starts_with('{') && segment.ends_with('}') {
            if part.is_empty() {
                return false;
            }
        } else if segment != part {
            return false;
        }
    }
    actual.next().is_none()
}

fn permanent_exception(
    method: &Method,
    path: &str,
    status: StatusCode,
    is_fallback: bool,
    body: &[u8],
) -> bool {
    // Navigation and asset failures have no JSON reader.
    if is_fallback && status == StatusCode::NOT_FOUND && !path.starts_with("/api") && path != "/ws"
    {
        return true;
    }
    // A WebSocket extractor rejects before a handler can upgrade; the
    // browser WebSocket API exposes the failed connection, never its body.
    ((*method == Method::GET && WEBSOCKETS.contains(&path))
        || path.starts_with("/_chan/extensions/"))
        && WEBSOCKET_REJECTIONS
            .iter()
            .any(|&(_, code, text)| status.as_u16() == code && body == text.as_bytes())
}

// axum::extract::ws::rejection types have fixed response bodies. A handler's
// own refusal on an upgrade route must still satisfy the JSON contract.
const WEBSOCKET_REJECTIONS: &[(&str, u16, &str)] = &[
    ("MethodNotGet", 405, "Request method must be `GET`"),
    ("MethodNotConnect", 405, "Request method must be `CONNECT`"),
    (
        "InvalidConnectionHeader",
        400,
        "Connection header did not include 'upgrade'",
    ),
    (
        "InvalidUpgradeHeader",
        400,
        "`Upgrade` header did not include 'websocket'",
    ),
    (
        "InvalidProtocolPseudoheader",
        400,
        "`:protocol` pseudo-header did not include 'websocket'",
    ),
    (
        "InvalidWebSocketVersionHeader",
        400,
        "`Sec-WebSocket-Version` header did not include '13'",
    ),
    (
        "WebSocketKeyHeaderMissing",
        400,
        "`Sec-WebSocket-Key` header missing",
    ),
    (
        "ConnectionNotUpgradable",
        426,
        "WebSocket request couldn't be upgraded since no upgrade state was present",
    ),
];

const WEBSOCKETS: &[&str] = &[
    "/ws",
    "/api/terminal/ws",
    "/api/doc/ws",
    "/api/scene/ws",
    "/api/library/windows/watch",
    "/api/library/local-color/watch",
    "/api/library/local-theme/watch",
    "/api/library/tunnel/control",
    "/api/library/tunnel/conn",
];

// Each entry names an existing route whose refusals are not all envelopes.
// Remove entries as those routes adopt the contract; new routes must obey it.
const PENDING: &[(&str, &str)] = &[
    ("GET", "/api/library/windows"),
    ("POST", "/api/library/windows"),
    ("GET", "/api/library/windows/watch"),
    ("DELETE", "/api/library/windows/{window_id}"),
    ("POST", "/api/library/windows/{window_id}/open"),
    ("POST", "/api/library/windows/{window_id}/hide"),
    ("GET", "/api/library/windows/{window_id}/live-terminals"),
    ("POST", "/api/library/windows/{window_id}/close"),
    ("PUT", "/api/library/windows/{window_id}/label"),
    ("POST", "/api/library/windows/{window_id}/visibility"),
    ("POST", "/api/library/devservers/{id}/connect"),
    ("POST", "/api/library/devservers/{id}/disconnect"),
    ("PUT", "/api/library/devservers/{id}/native-trust"),
    ("DELETE", "/api/library/devservers/{id}/native-trust"),
    ("POST", "/api/library/devservers/{id}/terminal"),
    ("POST", "/api/library/devservers/{id}/workspaces/open"),
    ("POST", "/api/library/devservers/{id}/workspaces/on"),
    ("POST", "/api/library/devservers/{id}/workspaces/off"),
    ("POST", "/api/library/devservers/{id}/workspaces/forget"),
    ("POST", "/api/library/gateways/{id}/connect"),
    ("POST", "/api/library/gateways/{id}/disconnect"),
    ("POST", "/api/library/fs/pick-folder"),
    ("GET", "/api/library/tunnel/control"),
    ("GET", "/api/library/tunnel/conn"),
    ("GET", "/api/library/workspaces"),
    ("POST", "/api/library/workspaces"),
    ("POST", "/api/library/workspaces/{id}/on"),
    ("POST", "/api/library/workspaces/{id}/off"),
    ("DELETE", "/api/library/workspaces/{id}"),
    ("GET", "/api/library/local-color"),
    ("PUT", "/api/library/local-color"),
    ("GET", "/api/library/local-color/watch"),
    ("GET", "/api/library/local-theme"),
    ("PUT", "/api/library/local-theme"),
    ("GET", "/api/library/local-theme/watch"),
    ("GET", "/api/library/collapsed-machines"),
    ("PUT", "/api/library/collapsed-machines"),
    ("POST", "/api/library/command-capabilities"),
    ("GET", "/api/library/command-capabilities/{capability}"),
    (
        "POST",
        "/api/library/command-capabilities/{capability}/actions",
    ),
    (
        "GET",
        "/api/library/command-capabilities/{capability}/windows/{window_id}/launch",
    ),
    (
        "GET",
        "/api/library/command-capabilities/{capability}/windows/{window_id}/live-terminals",
    ),
    ("GET", "/api/library/gateways"),
    ("POST", "/api/library/gateways"),
    ("PUT", "/api/library/gateways/{id}"),
    ("DELETE", "/api/library/gateways/{id}"),
    ("GET", "/api/library/devservers"),
    ("POST", "/api/library/devservers"),
    ("PUT", "/api/library/devservers/{id}"),
    ("DELETE", "/api/library/devservers/{id}"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    async fn accepts_refusal(
        method: &str,
        path: &str,
        status: StatusCode,
        body: &'static str,
        retry: Option<&'static str>,
    ) -> bool {
        let app = check(Router::new().route(
            path,
            axum::routing::any(move || async move {
                let mut response = Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8");
                if let Some(retry) = retry {
                    response = response.header(header::RETRY_AFTER, retry);
                }
                response.body(Body::from(body)).unwrap()
            }),
        ));
        let request = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap();
        tokio::spawn(app.oneshot(request)).await.is_ok()
    }

    async fn accepts_response(method: &str, path: &str, response: Response) -> bool {
        let (parts, body) = response.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.unwrap();
        let app = check(Router::new().route(
            path,
            axum::routing::any(move || {
                let mut response = Response::new(Body::from(bytes.clone()));
                *response.status_mut() = parts.status;
                *response.headers_mut() = parts.headers.clone();
                async move { response }
            }),
        ));
        tokio::spawn(
            app.oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            ),
        )
        .await
        .is_ok()
    }

    macro_rules! handler_text_is_rejected {
        ($name:ident, $method:literal, $path:literal, $status:expr) => {
            #[tokio::test]
            async fn $name() {
                assert!(
                    !accepts_refusal($method, $path, $status, "handler-authored refusal", None)
                        .await,
                    "handler-authored text must be caught on {} {}",
                    $method,
                    $path
                );
            }
        };
    }

    handler_text_is_rejected!(
        ws_handler_text_is_rejected,
        "GET",
        "/ws",
        StatusCode::BAD_REQUEST
    );
    handler_text_is_rejected!(
        terminal_ws_handler_text_is_rejected,
        "GET",
        "/api/terminal/ws",
        StatusCode::BAD_REQUEST
    );
    handler_text_is_rejected!(
        doc_ws_handler_text_is_rejected,
        "GET",
        "/api/doc/ws",
        StatusCode::UPGRADE_REQUIRED
    );
    handler_text_is_rejected!(
        scene_ws_handler_text_is_rejected,
        "GET",
        "/api/scene/ws",
        StatusCode::BAD_REQUEST
    );
    handler_text_is_rejected!(
        config_handler_text_is_rejected,
        "PATCH",
        "/api/config",
        StatusCode::INTERNAL_SERVER_ERROR
    );
    handler_text_is_rejected!(
        semantic_handler_text_is_rejected,
        "POST",
        "/api/index/semantic/enable",
        StatusCode::CONFLICT
    );
    handler_text_is_rejected!(
        write_handler_text_is_rejected,
        "PUT",
        "/api/fs/probe.md",
        StatusCode::CONFLICT
    );
    handler_text_is_rejected!(
        delete_handler_text_is_rejected,
        "DELETE",
        "/api/fs/probe.md",
        StatusCode::CONFLICT
    );
    handler_text_is_rejected!(
        move_handler_text_is_rejected,
        "POST",
        "/api/move",
        StatusCode::CONFLICT
    );
    handler_text_is_rejected!(
        transfer_handler_text_is_rejected,
        "POST",
        "/api/fs/transfer",
        StatusCode::CONFLICT
    );

    #[tokio::test]
    async fn write_conflicts_require_their_complete_typed_shape() {
        use axum::response::IntoResponse;
        let full = serde_json::json!({"current_mtime":1,"current_mtime_ns":"1000000000",
            "current_authority_version":3,"disk_conflicted":false});
        let minimal = serde_json::json!({"current_mtime":null,"disk_conflicted":true});
        for value in [full.clone(), minimal] {
            for status in [StatusCode::CONFLICT, StatusCode::PRECONDITION_REQUIRED] {
                assert!(
                    accepts_response(
                        "PUT",
                        "/api/fs/probe.md",
                        (status, axum::Json(value.clone())).into_response()
                    )
                    .await,
                    "the existing write conflict shape remains pending"
                );
            }
        }
        for (field, value) in [
            ("current_mtime", serde_json::json!("1")),
            ("current_mtime_ns", serde_json::json!(1)),
            ("current_authority_version", serde_json::json!(-1)),
            ("disk_conflicted", serde_json::json!(null)),
            ("extra", serde_json::json!(true)),
        ] {
            let mut invalid = full.clone();
            invalid[field] = value;
            assert!(
                !accepts_response(
                    "PUT",
                    "/api/fs/probe.md",
                    (StatusCode::CONFLICT, axum::Json(invalid)).into_response()
                )
                .await,
                "write conflict must reject invalid field {field}"
            );
        }
        for field in ["current_mtime", "disk_conflicted"] {
            let mut invalid = full.clone();
            invalid.as_object_mut().unwrap().remove(field);
            assert!(
                !accepts_response(
                    "PUT",
                    "/api/fs/probe.md",
                    (StatusCode::CONFLICT, axum::Json(invalid)).into_response()
                )
                .await,
                "write conflict requires {field}"
            );
        }
        for (method, path, status) in [
            ("POST", "/api/fs/probe.md", StatusCode::CONFLICT),
            ("PUT", "/api/unrelated", StatusCode::CONFLICT),
            ("PUT", "/api/fs/probe.md", StatusCode::BAD_REQUEST),
        ] {
            assert!(
                !accepts_response(
                    method,
                    path,
                    (status, axum::Json(full.clone())).into_response()
                )
                .await
            );
        }
        assert!(
            !accepts_response(
                "PUT",
                "/api/fs/probe.md",
                (StatusCode::CONFLICT, full.to_string()).into_response()
            )
            .await,
            "write conflict requires JSON content type"
        );
    }

    #[tokio::test]
    async fn extension_upgrade_rejections_require_framework_text() {
        use axum::extract::ws::rejection::WebSocketUpgradeRejection;
        use axum::extract::{FromRequestParts, WebSocketUpgrade};
        use axum::response::IntoResponse;
        let (mut parts, _) = Request::get("/_chan/extensions/echo/cap/ws")
            .header(header::UPGRADE, "websocket")
            .body(Body::empty())
            .unwrap()
            .into_parts();
        let rejection: WebSocketUpgradeRejection =
            WebSocketUpgrade::from_request_parts(&mut parts, &())
                .await
                .unwrap_err();
        assert!(
            accepts_response(
                "GET",
                "/_chan/extensions/echo/cap/ws",
                rejection.into_response()
            )
            .await,
            "the proxy's real WebSocket extractor rejection is recognized"
        );
        assert!(
            !accepts_refusal(
                "GET",
                "/_chan/extensions/echo/cap/ws",
                StatusCode::BAD_REQUEST,
                "handler-authored refusal",
                None
            )
            .await
        );
    }

    #[tokio::test]
    async fn converted_tenant_shapes_require_the_envelope() {
        let mut admitted = Vec::new();
        for (method, path, status, body) in [
            ("GET", "/api/resolve-link", 404, ""),
            ("GET", "/api/report/dir", 404, ""),
            ("GET", "/api/report/file", 404, ""),
            ("GET", "/api/report/file", 400, ""),
            (
                "GET",
                "/api/report/file",
                500,
                "report stream ended before metadata",
            ),
            ("GET", "/api/graph", 500, "graph stream cancelled"),
            (
                "GET",
                "/api/graph",
                500,
                "graph stream ended before metadata",
            ),
            (
                "GET",
                "/api/graph",
                500,
                "graph stream meta encode: encode failed",
            ),
            (
                "GET",
                "/api/backlinks/file.md",
                500,
                "backlinks stream ended before metadata",
            ),
            (
                "GET",
                "/api/backlinks/file.md",
                500,
                "backlinks stream meta encode: encode failed",
            ),
            (
                "GET",
                "/api/preflight",
                500,
                "preflight task panicked: task 1 was cancelled",
            ),
            (
                "GET",
                "/api/session",
                500,
                "Input/output error (os error 5)",
            ),
            (
                "PUT",
                "/api/session",
                500,
                "Input/output error (os error 5)",
            ),
            (
                "DELETE",
                "/api/session",
                500,
                "Input/output error (os error 5)",
            ),
            (
                "GET",
                "/api/sessions",
                500,
                "Input/output error (os error 5)",
            ),
            ("PUT", "/api/session", 500, "invalid session key"),
            (
                "POST",
                "/api/index/semantic/download",
                500,
                "creating model cache /models: Input/output error (os error 5)",
            ),
        ] {
            if accepts_refusal(
                method,
                path,
                StatusCode::from_u16(status).unwrap(),
                body,
                None,
            )
            .await
            {
                admitted.push(format!("{method} {path}: {status} {body}"));
            }
        }
        assert!(
            admitted.is_empty(),
            "converted tenant refusals admitted without envelopes: {admitted:#?}"
        );
    }

    macro_rules! pending_text_shape {
        ($name:ident, $method:literal, $path:literal, $status:expr, $body:expr) => {
            #[tokio::test]
            async fn $name() {
                use axum::response::IntoResponse;
                let body = $body;
                assert!(
                    accepts_response($method, $path, ($status, body).into_response()).await,
                    "inventory must recognize {} {}",
                    $method,
                    $path
                );
                assert!(
                    !accepts_response(
                        $method,
                        $path,
                        ($status, "unrelated handler refusal").into_response()
                    )
                    .await,
                    "the inventory entry must require its body shape"
                );
            }
        };
    }

    #[tokio::test]
    async fn inventory_range_refusal() {
        fn range(status: StatusCode, content_range: &str, body: &'static str) -> Response {
            Response::builder()
                .status(status)
                .header(header::CONTENT_RANGE, content_range)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ETAG, "\"file-token\"")
                .body(Body::from(body))
                .unwrap()
        }
        assert!(
            accepts_response(
                "GET",
                "/api/fs/movie.mp4",
                range(StatusCode::RANGE_NOT_SATISFIABLE, "bytes */100", "")
            )
            .await,
            "range refusals are empty with the unsatisfied Content-Range"
        );
        for (method, path, status, content_range, body) in [
            (
                "POST",
                "/api/fs/movie.mp4",
                StatusCode::RANGE_NOT_SATISFIABLE,
                "bytes */100",
                "",
            ),
            (
                "GET",
                "/api/unrelated",
                StatusCode::RANGE_NOT_SATISFIABLE,
                "bytes */100",
                "",
            ),
            (
                "GET",
                "/api/fs/movie.mp4",
                StatusCode::BAD_REQUEST,
                "bytes */100",
                "",
            ),
            (
                "GET",
                "/api/fs/movie.mp4",
                StatusCode::RANGE_NOT_SATISFIABLE,
                "bytes */oops",
                "",
            ),
            (
                "GET",
                "/api/fs/movie.mp4",
                StatusCode::RANGE_NOT_SATISFIABLE,
                "bytes 0-1/100",
                "",
            ),
            (
                "GET",
                "/api/fs/movie.mp4",
                StatusCode::RANGE_NOT_SATISFIABLE,
                "bytes */100",
                "handler text",
            ),
        ] {
            assert!(!accepts_response(method, path, range(status, content_range, body)).await);
        }
        for header in [header::CONTENT_RANGE, header::ACCEPT_RANGES, header::ETAG] {
            let mut response = range(StatusCode::RANGE_NOT_SATISFIABLE, "bytes */100", "");
            response.headers_mut().remove(header);
            assert!(!accepts_response("GET", "/api/fs/movie.mp4", response).await);
        }
    }

    #[tokio::test]
    async fn inventory_search_missing_content_type() {
        let app = crate::router(crate::state::test_support::make_test_state(false));
        let result = tokio::spawn(
            app.oneshot(
                Request::post("/api/search/workspace")
                    .body(Body::from("{}"))
                    .unwrap(),
            ),
        )
        .await;
        assert!(
            result.is_ok(),
            "the search route's remapped missing JSON content type is pending"
        );
        let response = result.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            "Expected request with `Content-Type: application/json`"
        );
    }

    pending_text_shape!(
        inventory_ws_get_method,
        "POST",
        "/_chan/extensions/echo/cap/ws",
        StatusCode::METHOD_NOT_ALLOWED,
        "Request method must be `GET`"
    );
    pending_text_shape!(
        inventory_ws_connect_method,
        "GET",
        "/api/terminal/ws",
        StatusCode::METHOD_NOT_ALLOWED,
        "Request method must be `CONNECT`"
    );

    #[test]
    fn websocket_exception_accepts_only_the_fixed_framework_bodies() {
        let samples = [
            (400, "Connection header did not include 'upgrade'"),
            (400, "`Upgrade` header did not include 'websocket'"),
            (400, "`:protocol` pseudo-header did not include 'websocket'"),
            (400, "`Sec-WebSocket-Version` header did not include '13'"),
            (400, "`Sec-WebSocket-Key` header missing"),
            (
                426,
                "WebSocket request couldn't be upgraded since no upgrade state was present",
            ),
        ];
        for path in WEBSOCKETS
            .iter()
            .copied()
            .chain(["/_chan/extensions/echo/cap/ws"])
        {
            for (status, text) in samples {
                assert!(permanent_exception(
                    &Method::GET,
                    path,
                    StatusCode::from_u16(status).unwrap(),
                    false,
                    text.as_bytes()
                ));
                assert!(!permanent_exception(
                    &Method::GET,
                    path,
                    StatusCode::from_u16(status).unwrap(),
                    false,
                    b"handler-authored refusal"
                ));
                assert!(!permanent_exception(
                    &Method::GET,
                    path,
                    StatusCode::from_u16(status).unwrap(),
                    false,
                    format!("{text} extra").as_bytes()
                ));
            }
        }
    }

    #[test]
    fn re_emitted_framework_refusal_keeps_its_type() {
        let body = b"Failed to deserialize the JSON body into the target type: unknown variant";
        for status in [StatusCode::BAD_REQUEST, StatusCode::UNPROCESSABLE_ENTITY] {
            assert_eq!(
                framework_exception(status, &HeaderMap::new(), body),
                Some("JsonDataError")
            );
        }
        assert_eq!(
            framework_exception(StatusCode::CONFLICT, &HeaderMap::new(), body),
            None
        );
        assert_eq!(
            framework_exception(
                StatusCode::BAD_REQUEST,
                &HeaderMap::new(),
                b"another refusal"
            ),
            None
        );
    }

    #[tokio::test]
    async fn host_lock_exception_requires_dispatch_fallback() {
        use axum::response::IntoResponse;
        let response = || {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "config: workspace host lock poisoned",
            )
                .into_response()
        };
        let app = check(Router::new().fallback(move || async move { response() }));
        let result = app
            .oneshot(
                Request::get("/tenant/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(result.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            to_bytes(result.into_body(), usize::MAX).await.unwrap(),
            "config: workspace host lock poisoned"
        );
        assert!(
            !accepts_response("GET", "/api/probe", response()).await,
            "host-lock text on a matched handler must require the envelope"
        );
    }

    #[tokio::test]
    async fn inspected_refusals_pass_outer_checks_without_reading_the_body() {
        let inner = check(Router::new().route(
            "/api/probe",
            axum::routing::get(|| async {
                crate::error::err(StatusCode::CONFLICT, "conflict".into())
            }),
        ))
        .layer(middleware::from_fn(
            |request: Request, next: Next| async move {
                let response = next.run(request).await;
                assert!(
                    response.extensions().get::<Inspected>().is_some(),
                    "an inspected refusal must carry its marker"
                );
                let (parts, _) = response.into_parts();
                Response::from_parts(
                    parts,
                    Body::from_stream(futures::stream::poll_fn(
                        |_| -> std::task::Poll<Option<Result<axum::body::Bytes, std::io::Error>>> {
                            panic!("an outer check must not poll an inspected refusal");
                        },
                    )),
                )
            },
        ));
        let app = check(Router::new().nest("/workspace", inner));
        let result = tokio::spawn(
            app.oneshot(
                Request::get("/workspace/api/probe")
                    .body(Body::empty())
                    .unwrap(),
            ),
        )
        .await;
        assert!(
            result.is_ok(),
            "a refusal inspected at the tenant path must pass the outer check once"
        );
        assert_eq!(result.unwrap().unwrap().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn upstream_mark_passes_without_path_or_body_constraints() {
        let app = check(Router::new().route(
            "/api/unrelated",
            axum::routing::get(|| async {
                let mut response = Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .body(Body::from_stream(futures::stream::poll_fn(
                        |_| -> std::task::Poll<Option<Result<axum::body::Bytes, std::io::Error>>> {
                            panic!("an upstream refusal must remain unbuffered");
                        },
                    )))
                    .unwrap();
                response.extensions_mut().insert(UpstreamResponse);
                response
            }),
        ));
        let result =
            tokio::spawn(app.oneshot(Request::get("/api/unrelated").body(Body::empty()).unwrap()))
                .await;
        assert!(
            result.is_ok(),
            "upstream provenance must admit the response independently of its path and body"
        );
        assert_eq!(result.unwrap().unwrap().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn converted_devserver_and_proxy_shapes_require_envelopes() {
        let mut admitted = Vec::new();
        for (method, path, status, body, retry) in [
            (
                "GET",
                "/api/devserver/workspaces",
                401,
                "missing or invalid devserver bearer token",
                None,
            ),
            (
                "POST",
                "/api/devserver/workspaces",
                400,
                "invalid workspace",
                None,
            ),
            ("DELETE", "/api/devserver/workspaces/notes", 404, "", None),
            (
                "POST",
                "/api/devserver/workspaces/notes/on",
                500,
                "invalid workspace",
                None,
            ),
            (
                "POST",
                "/api/devserver/rotate-token",
                401,
                "missing or invalid devserver bearer token",
                None,
            ),
            (
                "POST",
                "/api/devserver/terminal-sessions/drain",
                401,
                "missing or invalid devserver bearer token",
                None,
            ),
            (
                "GET",
                "/api/terminal/api/session",
                503,
                "devserver is restoring terminal sessions",
                Some("1"),
            ),
            ("GET", "/tenant/api/health", 401, "unauthorized", None),
            (
                "GET",
                "/_chan/extensions/echo/cap/state",
                502,
                "extension unavailable",
                None,
            ),
            (
                "GET",
                "/_chan/extensions/echo/cap/ws",
                502,
                "invalid extension websocket URL",
                None,
            ),
            (
                "GET",
                "/_chan/extensions/echo/cap/ws",
                502,
                "extension scope invalid",
                None,
            ),
            (
                "GET",
                "/_chan/extensions/echo/cap/ws",
                502,
                "extension origin invalid",
                None,
            ),
        ] {
            if accepts_refusal(
                method,
                path,
                StatusCode::from_u16(status).unwrap(),
                body,
                retry,
            )
            .await
            {
                admitted.push(format!("{method} {path}: {status} {body}"));
            }
        }
        assert!(
            admitted.is_empty(),
            "converted refusals admitted without envelopes: {admitted:#?}"
        );
    }

    #[tokio::test]
    async fn inspection_preserves_refusal_bytes_status_and_headers() {
        for (path, body, content_type) in [
            (
                "/probe",
                "{ \"error\": \"try later\", \"code\": \"busy\", \"count\": 3 }",
                "application/json",
            ),
            (
                "/api/library/windows",
                "pending refusal",
                "text/plain; charset=utf-8",
            ),
        ] {
            let app = check(Router::new().route(
                path,
                axum::routing::get(move || async move {
                    Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .header(header::CONTENT_TYPE, content_type)
                        .header(header::RETRY_AFTER, "3")
                        .header("x-refusal-test", "kept")
                        .body(Body::from(body))
                        .unwrap()
                }),
            ));
            let response = app
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()[header::RETRY_AFTER], "3");
            assert_eq!(response.headers()["x-refusal-test"], "kept");
            assert_eq!(response.headers()[header::CONTENT_TYPE], content_type);
            assert_eq!(
                to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                body
            );
        }
    }

    #[tokio::test]
    async fn inspection_does_not_poll_success_bodies() {
        for status in [
            StatusCode::SWITCHING_PROTOCOLS,
            StatusCode::OK,
            StatusCode::FOUND,
        ] {
            let app = check(Router::new().route(
                "/stream",
                axum::routing::get(move || async move {
                    Response::builder()
                        .status(status)
                        .body(Body::from_stream(futures::stream::poll_fn(
                            |_| -> std::task::Poll<
                                Option<Result<axum::body::Bytes, std::io::Error>>,
                            > {
                                panic!("the checker must not poll a non-refusal body")
                            },
                        )))
                        .unwrap()
                }),
            ));
            let response = app
                .oneshot(Request::get("/stream").body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
    }

    #[tokio::test]
    #[should_panic(expected = "refusal envelope violated")]
    async fn an_empty_code_does_not_count_as_an_envelope() {
        let app = check(Router::new().route(
            "/probe",
            axum::routing::get(|| async {
                (
                    StatusCode::CONFLICT,
                    axum::Json(serde_json::json!({"error":"conflict", "code":""})),
                )
            }),
        ));
        app.oneshot(Request::get("/probe").body(Body::empty()).unwrap())
            .await
            .unwrap();
    }

    fn terminal_app() -> Router {
        crate::terminal_router(crate::state::test_support::make_test_state(false))
    }

    #[tokio::test]
    async fn terminal_refusal_through_oneshot() {
        let response = terminal_app()
            .oneshot(
                Request::delete("/api/terminals/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("the checked router answers the request");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn terminal_refusal_through_spawned_server() {
        let app = terminal_app();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = reqwest::Client::new()
            .delete(format!("http://{address}/api/terminals/missing"))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        server.abort();
        let response = response.expect("the checked server must answer, not drop the connection");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn malformed_window_reply_through_assembled_router() {
        let response = terminal_app()
            .oneshot(
                Request::post("/api/window/reply")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .expect("the checked router answers malformed JSON");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
