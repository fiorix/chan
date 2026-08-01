//! Process-ready extension catalog and capability-scoped HTTP reverse proxy.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{OriginalUri, Path as AxumPath};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};

use crate::extensions::{ExtensionCatalog, ExtensionEntry, ExtensionView, EXTENSION_PROXY_PREFIX};

const EXTENSION_FRAME_POLICY: &str = "frame-ancestors 'self'";

pub async fn api_extensions(Extension(catalog): Extension<Arc<ExtensionCatalog>>) -> Response {
    let entries: Vec<ExtensionView> = catalog.views();
    let mut response = Json(entries).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::PRAGMA, "no-cache".parse().unwrap());
    response
}

/// Proxy one capability-scoped extension request to its process-private
/// loopback endpoint. The capability lives in the path so relative assets do
/// not need Chan's bearer query, and the extension-owned token never crosses
/// into browser memory.
pub async fn proxy_extension(
    Extension(catalog): Extension<Arc<ExtensionCatalog>>,
    AxumPath((id, capability, path)): AxumPath<(String, String, String)>,
    OriginalUri(original_uri): OriginalUri,
    request: Request<Body>,
) -> Response {
    proxy_extension_request(catalog, id, capability, path, original_uri, request).await
}

/// Axum catch-all parameters require a non-empty suffix, while an extension
/// entrypoint commonly lives at `/`. Keep the exact capability root explicit
/// so it cannot fall through to Chan's SPA fallback.
pub async fn proxy_extension_root(
    Extension(catalog): Extension<Arc<ExtensionCatalog>>,
    AxumPath((id, capability)): AxumPath<(String, String)>,
    OriginalUri(original_uri): OriginalUri,
    request: Request<Body>,
) -> Response {
    proxy_extension_request(
        catalog,
        id,
        capability,
        "/".to_string(),
        original_uri,
        request,
    )
    .await
}

async fn proxy_extension_request(
    catalog: Arc<ExtensionCatalog>,
    id: String,
    capability: String,
    path: String,
    original_uri: axum::http::Uri,
    request: Request<Body>,
) -> Response {
    let Some(entry) = catalog.find(&id, &capability).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };

    if let Some(response) = cors_preflight(request.method(), request.headers()) {
        return response;
    }

    let upstream = entry.upstream_url(&path, request.uri().query());
    let (parts, body) = request.into_parts();
    let mut headers = parts.headers;
    let had_origin = headers.contains_key(header::ORIGIN);
    strip_request_headers(&mut headers);

    let mut outgoing = extension_proxy_client()
        .request(parts.method, upstream.clone())
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));
    if had_origin {
        outgoing = outgoing.header(header::ORIGIN, upstream.origin().ascii_serialization());
    }

    let upstream_response = match outgoing.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(extension_id = %id, %error, "extension proxy request failed");
            return (StatusCode::BAD_GATEWAY, "extension unavailable").into_response();
        }
    };

    let status = upstream_response.status();
    let mut response_headers = upstream_response.headers().clone();
    rewrite_location(
        &mut response_headers,
        &entry,
        &upstream,
        original_uri.path(),
    );
    apply_extension_response_policy(&mut response_headers);
    let body = Body::from_stream(upstream_response.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

fn extension_proxy_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .build()
            .expect("build extension proxy client")
    })
}

fn cors_preflight(method: &Method, headers: &HeaderMap) -> Option<Response> {
    if method != Method::OPTIONS {
        return None;
    }
    let requested_method = headers.get(header::ACCESS_CONTROL_REQUEST_METHOD)?;
    if headers.get(header::ORIGIN)?.as_bytes() != b"null" {
        return None;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("null"),
    );
    response_headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        requested_method.clone(),
    );
    if let Some(requested_headers) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        response_headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            requested_headers.clone(),
        );
    }
    response_headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Some(response)
}

fn strip_request_headers(headers: &mut HeaderMap) {
    strip_hop_by_hop(headers);
    let private_headers: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            let name = name.as_str();
            name == "host"
                || name == "cookie"
                || name == "origin"
                || name == "referer"
                || name == "forwarded"
                || name.starts_with("x-forwarded-")
                || name.starts_with("x-chan-")
        })
        .cloned()
        .collect();
    for name in private_headers {
        headers.remove(name);
    }
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let connection_headers = headers
        .get(header::CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for name in connection_headers {
        headers.remove(name.as_str());
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

fn rewrite_location(
    headers: &mut HeaderMap,
    entry: &ExtensionEntry,
    upstream_request: &url::Url,
    original_path: &str,
) {
    let Some(location) = headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
    else {
        return;
    };
    let Ok(upstream_location) = upstream_request.join(location) else {
        return;
    };
    let Some(public_path) = entry.public_path_for(&upstream_location) else {
        return;
    };
    let tenant_prefix = original_path
        .find(EXTENSION_PROXY_PREFIX)
        .map(|at| &original_path[..at])
        .unwrap_or_default();
    let Ok(value) = HeaderValue::from_str(&format!("{tenant_prefix}{public_path}")) else {
        return;
    };
    headers.insert(header::LOCATION, value);
}

fn apply_extension_response_policy(headers: &mut HeaderMap) {
    strip_hop_by_hop(headers);
    headers.remove(header::SET_COOKIE);
    headers.remove(header::ACCESS_CONTROL_ALLOW_CREDENTIALS);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("null"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.append(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(EXTENSION_FRAME_POLICY),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::extract::Query;
    use axum::routing::{any, get};
    use axum::Router;
    use std::collections::HashMap;
    use tower::ServiceExt;

    const CAPABILITY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn catalog() -> Arc<ExtensionCatalog> {
        ExtensionCatalog::for_test(vec![ExtensionEntry::for_test(
            "echo",
            "Echo",
            "http://127.0.0.1:9/app/?mode=test#ready",
            "upstream-secret",
            CAPABILITY,
        )])
    }

    async fn upstream_probe(
        Query(query): Query<HashMap<String, String>>,
        headers: HeaderMap,
    ) -> Response {
        if query.get("t").map(String::as_str) != Some("upstream-secret") {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if query.get("q").map(String::as_str) != Some("one") {
            return StatusCode::BAD_REQUEST.into_response();
        }
        if headers.contains_key(header::COOKIE) {
            return (StatusCode::BAD_REQUEST, "cookie leaked").into_response();
        }
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !origin.starts_with("http://127.0.0.1:") {
            return (StatusCode::BAD_REQUEST, "origin not rewritten").into_response();
        }
        let mut response = "proxied".into_response();
        response
            .headers_mut()
            .insert(header::SET_COOKIE, HeaderValue::from_static("unsafe=1"));
        response
    }

    #[tokio::test]
    async fn catalog_exposes_only_a_same_tenant_proxy_capability() {
        let response = api_extensions(Extension(catalog())).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "private, no-store"
        );
        let body = to_bytes(response.into_body(), 4096).await.expect("body");
        let value: serde_json::Value = serde_json::from_slice(&body).expect("JSON catalog");
        assert_eq!(
            value[0]["entry_path"],
            format!("{EXTENSION_PROXY_PREFIX}/echo/{CAPABILITY}/app/?mode=test#ready")
        );
        let body = String::from_utf8(body.to_vec()).expect("UTF-8 catalog");
        assert!(!body.contains("127.0.0.1:9"));
        assert!(!body.contains("upstream-secret"));
    }

    #[test]
    fn proxy_url_replaces_browser_auth_with_the_extension_token() {
        let catalog = catalog();
        let entry = catalog.find("echo", CAPABILITY).expect("entry");
        let upstream = entry.upstream_url("/assets/app.js", Some("v=1&t=browser-secret"));
        assert_eq!(upstream.path(), "/assets/app.js");
        assert!(upstream
            .query_pairs()
            .any(|(key, value)| key == "v" && value == "1"));
        assert!(upstream
            .query_pairs()
            .any(|(key, value)| key == "t" && value == "upstream-secret"));
        assert!(!upstream.as_str().contains("browser-secret"));
    }

    #[tokio::test]
    async fn proxy_keeps_one_public_port_and_hides_browser_credentials() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream");
        let address = listener.local_addr().expect("upstream address");
        let upstream = Router::new().route("/", get(upstream_probe));
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, upstream)
                .await
                .expect("serve upstream")
        });

        let catalog = ExtensionCatalog::for_test(vec![ExtensionEntry::for_test(
            "echo",
            "Echo",
            &format!("http://{address}/"),
            "upstream-secret",
            CAPABILITY,
        )]);
        let app = Router::new()
            .route(
                "/_chan/extensions/{id}/{capability}/",
                any(proxy_extension_root),
            )
            .route(
                "/_chan/extensions/{id}/{capability}/{*path}",
                any(proxy_extension),
            )
            .layer(Extension(catalog));
        let request = Request::builder()
            .uri(format!(
                "/_chan/extensions/echo/{CAPABILITY}/?q=one&t=browser-secret"
            ))
            .header(header::ORIGIN, "null")
            .header(header::COOKIE, "chan=secret")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.expect("proxy response");
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "null"
        );
        let body = to_bytes(response.into_body(), 1024).await.expect("body");
        assert_eq!(body.as_ref(), b"proxied");

        upstream_task.abort();
        let _ = upstream_task.await;
    }

    #[test]
    fn gateway_frame_policy_marker_is_narrow() {
        let mut headers = HeaderMap::new();
        apply_extension_response_policy(&mut headers);
        assert_eq!(
            headers
                .get_all(HeaderName::from_static("content-security-policy"))
                .iter()
                .next_back()
                .unwrap(),
            EXTENSION_FRAME_POLICY
        );
        assert_eq!(
            headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "null"
        );
        assert!(headers.get(header::SET_COOKIE).is_none());
    }

    #[test]
    fn cors_preflight_requires_an_options_request_from_the_opaque_frame() {
        let headers = HeaderMap::from_iter([
            (header::ORIGIN, HeaderValue::from_static("null")),
            (
                header::ACCESS_CONTROL_REQUEST_METHOD,
                HeaderValue::from_static("POST"),
            ),
        ]);

        assert!(cors_preflight(&Method::GET, &headers).is_none());
        let response = cors_preflight(&Method::OPTIONS, &headers).expect("preflight response");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "null"
        );
    }
}
