//! Persisted bearer token + axum middleware that gates `/api/*` and `/ws`.
//!
//! Token persistence lives at `<paths.tokens>/token` (mode 0600 on Unix)
//! so a `cargo build && chan serve` cycle does not invalidate the
//! browser's cached sessionStorage token. Atomic write goes through
//! chan-workspace's `fs_ops::atomic_write` so the parent-dir fsync invariant
//! matches the rest of the app.
//!
//! Devserver tunnel requests carry `TunnelOrigin`; the gateway is the trust
//! boundary in that path, so the local bearer gate admits those requests after
//! the proxy has authenticated them.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use chan_workspace::paths::WorkspacePaths;
use rand::RngCore;

use crate::signal::now_unix_secs;
use crate::state::AppState;

const TOKEN_LEN: usize = 32;
const TOKEN_ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn random_token() -> String {
    let mut bytes = [0u8; TOKEN_LEN];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| TOKEN_ALPHABET[(*b as usize) % TOKEN_ALPHABET.len()] as char)
        .collect()
}

/// Load the persisted server token, generating one on first run.
/// Lives at `<paths.tokens>/token` (mode 0600 on Unix). The token
/// survives a binary rebuild so the browser's cached sessionStorage
/// token stays valid across `cargo build && chan serve` cycles.
pub fn load_or_create_token(paths: &WorkspacePaths) -> std::io::Result<String> {
    ensure_tokens_dir(&paths.tokens)?;
    let token_path = paths.tokens.join("token");
    if let Ok(s) = std::fs::read_to_string(&token_path) {
        let s = s.trim();
        if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Ok(s.to_owned());
        }
    }
    let token = random_token();
    write_token_atomic(&token_path, &token)?;
    Ok(token)
}

/// Make sure `<state>/tokens/<workspace-key>/` is a directory we can write
/// inside. Self-heals one specific corruption case: a regular file
/// sitting at that path (typically left by manual fiddling) makes
/// `create_dir_all` fail with `AlreadyExists` and would otherwise
/// abort the whole serve. We remove the stray file and retry. Any
/// other condition (symlink, real permission problem on the dir) is
/// propagated unchanged.
fn ensure_tokens_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::create_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir)?;
            let ft = meta.file_type();
            if ft.is_file() {
                std::fs::remove_file(dir)?;
                std::fs::create_dir_all(dir)
            } else {
                Err(e)
            }
        }
        Err(e) => Err(e),
    }
}

/// Write the token via chan-workspace's atomic_write helper (tmpfile +
/// fsync of file AND parent dir + rename). Sets 0600 permissions on
/// Unix to keep the secret out of `ls -l` snooping.
fn write_token_atomic(token_path: &Path, token: &str) -> std::io::Result<()> {
    chan_workspace::fs_ops::atomic_write(token_path, token.as_bytes())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(token_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Reject requests that don't carry the right token.
///
/// Auth scope: only `/api/*` and `/ws` routes are gated. Static
/// assets stay open: the browser issues those via `<script src>` /
/// `<link href>` before our JS runs and they can't carry the token.
/// The data plane is what needs protecting.
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let protected = path.starts_with("/api") || path == "/ws";
    if protected
        && req.extensions().get::<crate::TunnelOrigin>().is_none()
        && state.token.as_deref().is_some_and(|expected| {
            extract_token(req.uri().query(), req.headers()) != Some(expected)
        })
    {
        return crate::error::err(StatusCode::UNAUTHORIZED, "missing or invalid token".into());
    }
    // WebSocket routes send a terminal close code on revoked admission. HTTP
    // mutations from a detached page must also stop, including autosaves.
    if protected && path != "/api/session/resume" && !is_client_websocket_upgrade(&req) {
        let holder = req
            .headers()
            .get("x-chan-holder")
            .and_then(|v| v.to_str().ok())
            .filter(|h| chan_library::client_sessions::valid_holder(h));
        if holder.is_some_and(|h| state.client_sessions.registry.is_detached(h)) {
            return crate::error::err(
                StatusCode::CONFLICT,
                "client session detached; reconnect explicitly".into(),
            );
        }
    }
    state
        .last_activity
        .store(now_unix_secs(), Ordering::Relaxed);
    next.run(req).await
}

fn is_client_websocket_upgrade(req: &Request<Body>) -> bool {
    matches!(
        req.uri().path(),
        "/ws" | "/api/terminal/ws" | "/api/doc/ws" | "/api/scene/ws"
    ) && req.method() == axum::http::Method::GET
        && req
            .headers()
            .get(header::UPGRADE)
            .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && req
            .headers()
            .get_all(header::CONNECTION)
            .iter()
            .any(|value| {
                value.to_str().is_ok_and(|value| {
                    value
                        .split(',')
                        .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
                })
            })
}

pub fn extract_token<'a>(query: Option<&'a str>, headers: &'a HeaderMap) -> Option<&'a str> {
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some(rest) = pair.strip_prefix("t=") {
                return Some(rest);
            }
        }
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detached_state() -> Arc<AppState> {
        let state = crate::state::test_support::make_test_state_with_token("secret");
        let connection = state
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        state
            .client_sessions
            .registry
            .detach(connection.id())
            .unwrap();
        state
    }

    async fn detached_response(
        method: &str,
        path: &str,
        upgrade: Option<&str>,
        connection: Option<&str>,
    ) -> StatusCode {
        use tower::ServiceExt;
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, "Bearer secret")
            .header("x-chan-holder", "work");
        if let Some(upgrade) = upgrade {
            request = request.header(header::UPGRADE, upgrade);
        }
        if let Some(connection) = connection {
            request = request.header(header::CONNECTION, connection);
        }
        crate::router(detached_state())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn detached_http_upgrade_headers_do_not_exempt_non_socket_routes() {
        for connection in [None, Some("upgrade")] {
            assert_eq!(
                detached_response(
                    "GET",
                    "/api/terminals/roster",
                    Some("websocket"),
                    connection
                )
                .await,
                StatusCode::CONFLICT
            );
        }
    }

    #[tokio::test]
    async fn detached_socket_upgrade_requires_get() {
        assert_eq!(
            detached_response("POST", "/ws", Some("websocket"), Some("upgrade")).await,
            StatusCode::CONFLICT
        );
    }

    #[tokio::test]
    async fn detached_socket_upgrade_requires_connection_token() {
        for connection in [None, Some("keep-alive"), Some("not-upgrade")] {
            assert_eq!(
                detached_response("GET", "/ws", Some("websocket"), connection).await,
                StatusCode::CONFLICT
            );
        }
    }

    #[tokio::test]
    async fn detached_socket_upgrade_requires_websocket_protocol() {
        for upgrade in [None, Some("h2c"), Some("not-websocket")] {
            assert_eq!(
                detached_response("GET", "/ws", upgrade, Some("upgrade")).await,
                StatusCode::CONFLICT
            );
        }
    }

    #[tokio::test]
    async fn untagged_http_is_not_refused_for_a_detached_client() {
        use tower::ServiceExt;
        let response = crate::router(detached_state())
            .oneshot(
                Request::get("/api/terminals/roster")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::UPGRADE, "websocket")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    async fn synthetic_holder_response(authenticated: bool) -> StatusCode {
        use tower::ServiceExt;
        let state = detached_state();
        let connection = state.client_sessions.connect(None, "w", "events").unwrap();
        let client = state
            .client_sessions
            .registry
            .detach(connection.id())
            .unwrap();
        assert!(!chan_library::client_sessions::valid_holder(&client.holder));
        assert!(state.client_sessions.registry.is_detached(&client.holder));
        let mut request =
            Request::get("/api/terminals/roster").header("x-chan-holder", client.holder);
        if authenticated {
            request = request.header(header::AUTHORIZATION, "Bearer secret");
        }
        crate::terminal_router(state)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn synthetic_http_holder_is_absent_for_detached_client_refusal() {
        assert_eq!(synthetic_holder_response(true).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn synthetic_http_holder_still_requires_authentication() {
        assert_eq!(
            synthetic_holder_response(false).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn detached_real_socket_upgrades_close_with_4001_on_every_client_route() {
        use futures::StreamExt;
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
        let state = detached_state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = crate::router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for path in ["/ws", "/api/terminal/ws", "/api/doc/ws", "/api/scene/ws"] {
            let mut request = format!("ws://{address}{path}?h=work&w=w&path=missing.txt")
                .into_client_request()
                .unwrap();
            request
                .headers_mut()
                .insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
            request
                .headers_mut()
                .insert("x-chan-holder", "work".parse().unwrap());
            request
                .headers_mut()
                .insert(header::CONNECTION, "keep-alive, Upgrade".parse().unwrap());
            let (mut socket, response) = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio_tungstenite::connect_async(request),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS, "{path}");
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let code = match message {
                Message::Close(Some(frame)) => Some(u16::from(frame.code)),
                _ => None,
            };
            assert_eq!(code, Some(4001), "{path}");
        }
        assert_eq!(
            state.terminal_sessions.len(),
            0,
            "refused sockets spawn no PTY"
        );
        server.abort();
    }

    #[tokio::test]
    async fn detached_client_http_requires_auth_and_explicit_resume() {
        use tower::ServiceExt;
        let state = crate::state::test_support::make_test_state_with_token("secret");
        let work = state
            .client_sessions
            .connect(Some("work"), "w", "events")
            .unwrap();
        state.client_sessions.registry.detach(work.id()).unwrap();
        let app = crate::terminal_router(state.clone());
        for (token, holder, expected) in [
            (None, "work", StatusCode::UNAUTHORIZED),
            (Some("Bearer secret"), "work", StatusCode::CONFLICT),
            (Some("Bearer secret"), "home", StatusCode::OK),
        ] {
            let mut request = Request::get("/api/terminals/roster").header("x-chan-holder", holder);
            if let Some(token) = token {
                request = request.header(header::AUTHORIZATION, token);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        let response = app
            .oneshot(
                Request::post("/api/session/resume")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-chan-holder", "work")
                    .body(Body::from(r#"{"holder":"work"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(!state.client_sessions.registry.is_detached("work"));
        assert!(
            *work.cancellation().borrow(),
            "resume must not revive old sockets"
        );
    }

    #[tokio::test]
    async fn a_missing_bearer_answers_the_same_sentence_as_json() {
        use tower::ServiceExt;
        let app = crate::terminal_router(crate::state::test_support::make_test_state_with_token(
            "secret",
        ));
        let response = app
            .oneshot(
                Request::get("/api/terminals/roster")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 8192)
                .await
                .unwrap(),
            r#"{"error":"missing or invalid token"}"#
        );
    }

    #[test]
    fn random_token_is_alphanumeric_and_long() {
        let t = random_token();
        assert_eq!(t.len(), TOKEN_LEN);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn extract_token_query_param() {
        let h = HeaderMap::new();
        assert_eq!(
            extract_token(Some("foo=bar&t=secret&x=y"), &h),
            Some("secret")
        );
    }

    #[test]
    fn extract_token_authorization_header() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert_eq!(extract_token(None, &h), Some("secret"));
    }

    #[test]
    fn extract_token_missing() {
        let h = HeaderMap::new();
        assert_eq!(extract_token(None, &h), None);
    }

    /// Some on-disk state has `<state>/tokens/<key>` as a regular file
    /// (32-byte token blob) instead of a directory.
    /// `create_dir_all` cannot turn a file into a directory, so `chan
    /// open` would die with `io: File exists (os error 17)`.
    /// `ensure_tokens_dir` must self-heal: drop the stray file, make
    /// the directory, and let the regular write path produce a fresh
    /// token underneath.
    #[test]
    fn ensure_tokens_dir_self_heals_stale_file_at_tokens_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let tokens = tmp.path().join("tokens").join("deadbeef0000cafe");
        // Pre-populate the schema-violating state: parent dir exists,
        // and the per-key slot is a regular file.
        std::fs::create_dir_all(tokens.parent().unwrap()).unwrap();
        std::fs::write(&tokens, b"WTMYtxvSqLsPsRpVBihjKJaUHWsnL7F9").unwrap();
        assert!(tokens.is_file());

        ensure_tokens_dir(&tokens).expect("self-heal");
        assert!(
            tokens.is_dir(),
            "stray file should have been replaced by a dir"
        );

        // Follow-through: the real call site writes a `token` file
        // inside, which the next boot reads back unchanged.
        let token_path = tokens.join("token");
        write_token_atomic(&token_path, "abcdef").unwrap();
        assert_eq!(std::fs::read_to_string(&token_path).unwrap(), "abcdef");
    }

    /// Sanity: the happy path stays happy. `ensure_tokens_dir` on a
    /// pristine layout is a plain `create_dir_all`.
    #[test]
    fn ensure_tokens_dir_creates_missing_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let tokens = tmp.path().join("tokens").join("aaaaaaaaaaaaaaaa");
        ensure_tokens_dir(&tokens).unwrap();
        assert!(tokens.is_dir());
    }

    /// And idempotence: a second call on an existing directory must
    /// succeed without touching the contents.
    #[test]
    fn ensure_tokens_dir_idempotent_on_existing_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let tokens = tmp.path().join("tokens").join("bbbbbbbbbbbbbbbb");
        std::fs::create_dir_all(&tokens).unwrap();
        std::fs::write(tokens.join("token"), b"existing").unwrap();
        ensure_tokens_dir(&tokens).unwrap();
        assert_eq!(
            std::fs::read_to_string(tokens.join("token")).unwrap(),
            "existing"
        );
    }
}
