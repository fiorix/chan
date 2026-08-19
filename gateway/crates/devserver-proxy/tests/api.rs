//! Integration tests for devserver-proxy.
//!
//! No Postgres in this suite: browser sessions and consumed entry ids are
//! proxy-local bounded state. Tests mint identity-style Ed25519 entry
//! credentials directly via `gateway_common::devserver_gate`.
//!
//! Tunnel registrations exercise the real chan-tunnel handshake
//! (h2c POST, Hello/HelloAck, yamux) against an in-process tunnel
//! listener fed by a stub Validator.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::extract::Request as AxRequest;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::response::IntoResponse;
use axum::Router;
use bytes::Bytes;
use chan_tunnel_proto::{H2Duplex, TUNNEL_PATH};
use chan_tunnel_server::{
    serve_tunnel_listener_with_admission, AllowAllAdmission, ServerError, Validated, Validator,
};
use devserver_control_proto::{
    AdmissionLeaseSigner, AdmissionLeaseVerifier, CanonicalOrigin, ProxyId,
};
use futures_util::{SinkExt, StreamExt};
use gateway_common::devserver_gate;
use http::Method as HttpMethod;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tower::ServiceExt;
use uuid::Uuid;

use devserver_proxy::config::{Config, DEFAULT_WS_IDLE_TIMEOUT};
use devserver_proxy::http as dp_http;
use devserver_proxy::identity_validator::CapturingValidator;
use devserver_proxy::registry::Registry;
use devserver_proxy::session_store::SessionStore;

const APEX_HOST: &str = "p1.proxy.chan.app";
const WILDCARD_SUFFIX: &str = ".p1.proxy.chan.app";
const TEST_IDENTITY_ORIGIN: &str = "https://gw.chan.app";
const TEST_DASHBOARD_URL: &str = "https://gw.chan.app/workspaces";

fn test_entry_signer() -> devserver_gate::EntrySigner {
    devserver_gate::EntrySigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap()
}

fn test_entry_verifiers() -> devserver_gate::EntryVerifierRing {
    let signer = test_entry_signer();
    devserver_gate::EntryVerifierRing::from_base64_list(&signer.verifying_key_base64()).unwrap()
}

fn test_admission_verifier() -> AdmissionLeaseVerifier {
    let signer =
        AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
    AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap()
}

/// (user_id, username, devserver_id, scopes) row stored per-token in
/// the stub. Aliased so clippy's `type_complexity` lint is happy on the
/// inner `Arc<Mutex<HashMap<...>>>` declaration below.
type StubRow = (Uuid, String, String, Vec<String>);

/// Stub validator: tokens map to (user_id, username, devserver_id,
/// scopes). Used in place of the real IdentityValidator so tests don't
/// need identity-service. The tunnel-server keys the registration on the
/// token-resolved `devserver_id` (server-authoritative), so the stub is
/// what determines the registry's second key. Every token carries the
/// base `tunnel` scope.
#[derive(Clone, Default)]
struct StubValidator {
    by_token: Arc<StdMutex<HashMap<String, StubRow>>>,
}

impl StubValidator {
    fn add(
        &self,
        token: impl Into<String>,
        user_id: Uuid,
        username: impl Into<String>,
        devserver_id: impl Into<String>,
    ) {
        self.by_token.lock().unwrap().insert(
            token.into(),
            (
                user_id,
                username.into(),
                devserver_id.into(),
                vec!["tunnel".to_string()],
            ),
        );
    }
}

#[async_trait]
impl Validator for StubValidator {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        let g = self.by_token.lock().unwrap();
        match g.get(token) {
            Some((uid, username, devserver_id, scopes)) => Ok(Validated {
                user_id: *uid,
                username: username.clone(),
                devserver_id: devserver_id.clone(),
                scopes: scopes.clone(),
                gateway_assertion_key: Some(
                    chan_tunnel_proto::gateway_assertion::derive_assertion_key(token),
                ),
                admission_lease: None,
                admission_lease_expires_at: None,
            }),
            None => Err(ServerError::InvalidToken),
        }
    }
}

struct TestApp {
    router: Router,
    registry: Registry,
    tunnel_addr: SocketAddr,
    stub: StubValidator,
    sessions: SessionStore,
    _readiness: watch::Sender<bool>,
}

impl TestApp {
    async fn new() -> Self {
        Self::new_inner(DEFAULT_WS_IDLE_TIMEOUT, None, None).await
    }

    /// The WS-bridge tests inject a sub-second idle window so the cut
    /// is observable without waiting out the production default.
    async fn new_with_ws_idle_timeout(ws_idle_timeout: std::time::Duration) -> Self {
        Self::new_inner(ws_idle_timeout, None, None).await
    }

    /// The transfer-policy tests inject tight general body caps so the
    /// transfer route's explicit 100 GiB allowance is observable
    /// without giant fixtures.
    async fn new_with_caps(
        max_request_bytes: Option<usize>,
        max_response_bytes: Option<usize>,
    ) -> Self {
        Self::new_inner(
            DEFAULT_WS_IDLE_TIMEOUT,
            max_request_bytes,
            max_response_bytes,
        )
        .await
    }

    async fn new_inner(
        ws_idle_timeout: std::time::Duration,
        max_request_bytes: Option<usize>,
        max_response_bytes: Option<usize>,
    ) -> Self {
        let registry = Registry::new();

        let cfg = Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            tunnel_bind_addr: "127.0.0.1:0".parse().unwrap(),
            apex_host: APEX_HOST.into(),
            wildcard_suffix: WILDCARD_SUFFIX.into(),
            identity_url: "http://127.0.0.1:7000/".parse().unwrap(),
            identity_auth_token: "unused-in-tests".into(),
            dashboard_url: TEST_DASHBOARD_URL.into(),
            identity_origin: CanonicalOrigin::parse(TEST_IDENTITY_ORIGIN).unwrap(),
            entry_verifiers: test_entry_verifiers(),
            admission_lease_verifier: test_admission_verifier(),
            control_url: "http://127.0.0.1:7101/".parse().unwrap(),
            proxy_token: "unused-control-token".into(),
            proxy_id: ProxyId::parse("p1").unwrap(),
            proxy_base_url: CanonicalOrigin::parse("https://p1.proxy.chan.app").unwrap(),
            max_response_bytes,
            max_request_bytes,
            request_timeout: None,
            ws_idle_timeout,
            session_max_active: 10_000,
            session_lifetime: std::time::Duration::from_secs(3600),
            entry_replay_max_active: 10_000,
            forwarded_proto: "https".into(),
        });

        let (readiness, readiness_rx) = watch::channel(true);
        let sessions = SessionStore::new(cfg.session_max_active, cfg.session_lifetime);
        let router = dp_http::router(cfg, registry.clone(), readiness_rx, sessions.clone());

        // Real tunnel listener fed by a stub validator wrapped in
        // CapturingValidator (mirrors production wiring).
        let stub = StubValidator::default();
        let validator: Arc<dyn Validator> =
            Arc::new(CapturingValidator::new(stub.clone(), registry.clone()));
        let tunnel_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tunnel_addr = tunnel_listener.local_addr().unwrap();
        {
            let tunnels = registry.tunnels();
            tokio::spawn(async move {
                let _ = serve_tunnel_listener_with_admission(
                    tunnel_listener,
                    validator,
                    Arc::new(AllowAllAdmission),
                    tunnels,
                    0,
                )
                .await;
            });
        }

        Self {
            router,
            registry,
            tunnel_addr,
            stub,
            sessions,
            _readiness: readiness,
        }
    }

    async fn cleanup(self) {
        // Nothing DB-backed; just drop self.
    }

    async fn register_tunnel(&self, username: &str, devserver_id: &str, uid: Uuid, router: Router) {
        let token = format!("tok-{}", Uuid::new_v4().simple());
        self.register_tunnel_with_token(&token, username, devserver_id, uid, router)
            .await;
    }

    /// Register a tunnel whose token-resolved devserver id differs
    /// from the client's Hello workspace name. Production-shaped ids
    /// are 64 hex chars, which `is_valid_workspace_name` (max 32)
    /// rejects on the client dial; the registry keys on the
    /// token-resolved id regardless, so the Hello name is a short
    /// advisory slug here.
    async fn register_tunnel_hello(
        &self,
        username: &str,
        devserver_id: &str,
        hello: &str,
        uid: Uuid,
        router: Router,
    ) {
        let token = format!("tok-{}", Uuid::new_v4().simple());
        self.stub.add(&token, uid, username, devserver_id);
        spawn_tunnel_client(self.tunnel_addr, &token, hello, router).await;
        for _ in 0..50 {
            if self.registry.get(username, devserver_id).is_some() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("tunnel for {username}/{devserver_id} did not register");
    }

    async fn register_tunnel_with_token(
        &self,
        token: &str,
        username: &str,
        devserver_id: &str,
        uid: Uuid,
        router: Router,
    ) {
        // The tunnel-server keys the registration on the token-resolved
        // devserver_id, so the stub returns it; the registry's second key
        // is this value (Hello.workspace is not the identity source).
        self.stub.add(token, uid, username, devserver_id);
        spawn_tunnel_client(self.tunnel_addr, token, devserver_id, router).await;
        for _ in 0..50 {
            if self.registry.get(username, devserver_id).is_some() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("tunnel for {username}/{devserver_id} did not register");
    }
}

async fn spawn_tunnel_client(
    tunnel_addr: SocketAddr,
    token: &str,
    workspace: &str,
    router: Router,
) {
    let token = token.to_string();
    let workspace = workspace.to_string();
    tokio::spawn(async move {
        if let Err(e) = run_tunnel_client(tunnel_addr, &token, &workspace, router).await {
            tracing::warn!(error = ?e, "test tunnel client ended");
        }
    });
}

async fn run_tunnel_client(
    tunnel_addr: SocketAddr,
    token: &str,
    workspace: &str,
    router: Router,
) -> anyhow::Result<()> {
    let tcp = TcpStream::connect(tunnel_addr).await?;
    tcp.set_nodelay(true)?;
    let (mut h2, conn) = h2::client::handshake(tcp).await?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let req = http::Request::builder()
        .method(HttpMethod::POST)
        .uri(format!("https://chan-tunnel{TUNNEL_PATH}"))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(())
        .unwrap();
    let (response_fut, send_stream) = h2.send_request(req, false)?;
    let response = response_fut.await?;
    if response.status() != http::StatusCode::OK {
        return Err(anyhow::anyhow!("tunnel POST status {}", response.status()));
    }
    let recv_stream = response.into_body();

    let duplex = H2Duplex::new(send_stream, recv_stream);

    let cfg = chan_tunnel_client::ClientConfig {
        tunnel_url: "https://chan-tunnel/v1/tunnel".parse().unwrap(),
        token: token.to_string(),
        workspace: workspace.to_string(),
        ..Default::default()
    };
    let (_registration, yconn) = chan_tunnel_client::handshake(&cfg, duplex).await?;
    chan_tunnel_client::serve_substreams(yconn, router).await?;
    Ok(())
}

/// Send a request with a Host header. Workspace-proxy routes off Host so
/// every wildcard test must supply one; oneshot does not synthesize.
async fn send_host(
    router: &Router,
    method: Method,
    host: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Bytes) {
    let mut builder = Request::builder().method(method).uri(uri);
    builder = builder.header(header::HOST, host);
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let req = builder.body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let hdrs = res.headers().clone();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, hdrs, bytes)
}

async fn send_host_body(
    router: &Router,
    method: Method,
    host: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: impl Into<Body>,
) -> (StatusCode, HeaderMap, Bytes) {
    let mut builder = Request::builder().method(method).uri(uri);
    builder = builder.header(header::HOST, host);
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let res = router
        .clone()
        .oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let hdrs = res.headers().clone();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, hdrs, bytes)
}

async fn exchange_entry(
    router: &Router,
    host: &str,
    credential: &str,
) -> (StatusCode, HeaderMap, Bytes) {
    let body: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("credential", credential)
        .finish();
    send_host_body(
        router,
        Method::POST,
        host,
        devserver_gate::ENTRY_EXCHANGE_PATH,
        &[
            ("origin", TEST_IDENTITY_ORIGIN),
            ("content-type", "application/x-www-form-urlencoded"),
        ],
        body,
    )
    .await
}

fn mint_for_owner(sub: Uuid, owner_user_id: Uuid, drv: &str, aud: &str, next_path: &str) -> String {
    devserver_gate::encode_entry(
        &test_entry_signer(),
        sub,
        owner_user_id,
        drv,
        aud,
        "p1",
        next_path,
    )
    .unwrap()
}

fn mint(sub: Uuid, drv: &str, aud: &str) -> String {
    mint_for_owner(sub, sub, drv, aud, "/blog/")
}

fn host_for(user: &str) -> String {
    format!("{user}{WILDCARD_SUFFIX}")
}

/// Disc host for a devserver: `{user}--{first 12 hex of id}.<suffix>`.
fn disc_host_for(user: &str, devserver_id: &str) -> String {
    format!("{user}--{}{WILDCARD_SUFFIX}", &devserver_id[..12])
}

// 64-hex devserver ids with distinct 12-char prefixes, plus a pair
// sharing one prefix for the ambiguity case.
const DS_A: &str = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888";
const DS_B: &str = "bbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb7777cccc8888";
const DS_AMB1: &str = "9999aaaa88881111111111111111111111111111111111111111111111111111";
const DS_AMB2: &str = "9999aaaa88882222222222222222222222222222222222222222222222222222";

/// A `Cookie` header value carrying a valid session token for
/// `(sub, workspace)` on `host`. Every reverse-proxy request must pass
/// the gate now that there is no un-gated public path.
fn session_cookie(app: &TestApp, sub: Uuid, workspace: &str, host: &str) -> String {
    session_cookie_for_owner(app, sub, sub, workspace, host)
}

fn session_cookie_for_owner(
    app: &TestApp,
    sub: Uuid,
    owner_user_id: Uuid,
    workspace: &str,
    host: &str,
) -> String {
    format!(
        "__Host-devserver_gate={}",
        opaque_session(app, sub, owner_user_id, workspace, host)
    )
}

fn opaque_session(
    app: &TestApp,
    sub: Uuid,
    owner_user_id: Uuid,
    workspace: &str,
    host: &str,
) -> String {
    let issued = app
        .sessions
        .issue(devserver_proxy::session_store::SessionPrincipal {
            subject_user_id: sub,
            owner_user_id,
            devserver_id: workspace.to_string(),
            audience: host.to_string(),
        })
        .unwrap();
    issued.id().to_string()
}

fn session_and_csrf_cookie(
    app: &TestApp,
    sub: Uuid,
    workspace: &str,
    host: &str,
    csrf: &str,
) -> String {
    format!(
        "{}; __Host-devserver_csrf={csrf}",
        session_cookie(app, sub, workspace, host)
    )
}

// ---------------------------------------------------------------
// Apex routing
// ---------------------------------------------------------------

#[tokio::test]
async fn apex_healthz_ok() {
    let app = TestApp::new().await;
    let (s, _, _) = send_host(&app.router, Method::GET, APEX_HOST, "/healthz", &[]).await;
    assert_eq!(s, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn health_and_readiness_are_not_exposed_on_tenant_or_unknown_hosts() {
    let app = TestApp::new().await;
    for host in [host_for("alice"), "evil.example.com".to_string()] {
        for path in ["/healthz", "/readyz"] {
            let (status, _, _) = send_host(&app.router, Method::GET, &host, path, &[]).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{host}{path}");
        }
    }
    app.cleanup().await;
}

#[tokio::test]
async fn apex_readyz_reflects_control_readiness() {
    let registry = Registry::new();
    let app = TestApp::new().await;
    let cfg = app.router.clone();
    let (status, _, _) = send_host(&cfg, Method::GET, APEX_HOST, "/readyz", &[]).await;
    assert_eq!(status, StatusCode::OK);

    let test_cfg = Arc::new(Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        tunnel_bind_addr: "127.0.0.1:0".parse().unwrap(),
        apex_host: APEX_HOST.into(),
        wildcard_suffix: WILDCARD_SUFFIX.into(),
        identity_url: "http://127.0.0.1:7000/".parse().unwrap(),
        identity_auth_token: "unused-in-tests".into(),
        dashboard_url: TEST_DASHBOARD_URL.into(),
        identity_origin: CanonicalOrigin::parse(TEST_IDENTITY_ORIGIN).unwrap(),
        entry_verifiers: test_entry_verifiers(),
        admission_lease_verifier: test_admission_verifier(),
        control_url: "http://127.0.0.1:7101/".parse().unwrap(),
        proxy_token: "unused-control-token".into(),
        proxy_id: ProxyId::parse("p1").unwrap(),
        proxy_base_url: CanonicalOrigin::parse("https://p1.proxy.chan.app").unwrap(),
        max_response_bytes: None,
        max_request_bytes: None,
        request_timeout: None,
        ws_idle_timeout: DEFAULT_WS_IDLE_TIMEOUT,
        session_max_active: 10_000,
        session_lifetime: std::time::Duration::from_secs(3600),
        entry_replay_max_active: 10_000,
        forwarded_proto: "https".into(),
    });
    let (_readiness, readiness_rx) = watch::channel(false);
    let sessions = SessionStore::new(test_cfg.session_max_active, test_cfg.session_lifetime);
    let unready = dp_http::router(test_cfg, registry, readiness_rx, sessions);
    let (status, _, _) = send_host(&unready, Method::GET, APEX_HOST, "/readyz", &[]).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    app.cleanup().await;
}

#[tokio::test]
async fn apex_unknown_path_is_404() {
    let app = TestApp::new().await;
    let (s, _, _) = send_host(&app.router, Method::GET, APEX_HOST, "/", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = send_host(&app.router, Method::GET, APEX_HOST, "/api/me", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = send_host(&app.router, Method::GET, APEX_HOST, "/alice", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn unknown_host_is_404() {
    let app = TestApp::new().await;
    let (s, _, _) = send_host(&app.router, Method::GET, "evil.example.com", "/blog/", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Wildcard root -> dashboard
// ---------------------------------------------------------------

#[tokio::test]
async fn wildcard_root_redirects_to_dashboard() {
    let app = TestApp::new().await;
    let (s, hdrs, _) = send_host(&app.router, Method::GET, "alice.p1.proxy.chan.app", "/", &[]).await;
    assert!(s.is_redirection(), "got {s}");
    let loc = hdrs.get(header::LOCATION).unwrap().to_str().unwrap();
    assert_eq!(loc, TEST_DASHBOARD_URL);
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Proxy gate (unregistered + anonymous)
// ---------------------------------------------------------------

#[tokio::test]
async fn unregistered_workspace_is_404() {
    let app = TestApp::new().await;
    let (s, _, body) = send_host(&app.router, Method::GET, &host_for("alice"), "/blog/", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"], "not found");
    app.cleanup().await;
}

#[tokio::test]
async fn unregistered_workspace_html_browser_gets_dead_end_page() {
    let app = TestApp::new().await;
    let (s, hdrs, body) = send_host(
        &app.router,
        Method::GET,
        &host_for("alice"),
        "/blog/",
        &[("accept", "text/html,application/xhtml+xml")],
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let ct = hdrs.get(header::CONTENT_TYPE).unwrap().to_str().unwrap();
    assert!(ct.starts_with("text/html"));
    assert!(std::str::from_utf8(&body)
        .unwrap()
        .contains("workspace unavailable"));
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Proxy gate (private + __Host-devserver_gate JWT)
// ---------------------------------------------------------------

#[tokio::test]
async fn private_workspace_anonymous_is_404() {
    // Indistinguishable from unregistered: no leak.
    let app = TestApp::new().await;
    app.register_tunnel("alice", "blog", Uuid::new_v4(), Router::new())
        .await;

    let (s, _, _) = send_host(&app.router, Method::GET, &host_for("alice"), "/blog/", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn entry_token_mints_session_cookie() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new().route("/", axum::routing::get(|| async { "owner ok" }));
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let token = mint(uid, "blog", &host);
    let (s, hdrs, _) = exchange_entry(&app.router, &host, &token).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    let loc = hdrs.get(header::LOCATION).unwrap().to_str().unwrap();
    assert_eq!(loc, "/blog/");
    let set = hdrs.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set.starts_with("__Host-devserver_gate="), "got {set}");
    // Whole-host cookie: the grant is the whole devserver, so the cookie
    // is not scoped to a per-workspace path.
    assert!(
        set.contains("Path=/;") || set.contains("Path=/ "),
        "got {set}"
    );
    assert!(set.contains("HttpOnly"));
    assert!(set.contains("Secure"));
    assert!(set.contains("SameSite=Lax"));
    let set_cookies: Vec<&str> = hdrs
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .collect();
    assert!(
        set_cookies
            .iter()
            .any(|v| v.starts_with("__Host-devserver_csrf=")
                && v.contains("Path=/")
                && !v.contains("HttpOnly")),
        "csrf cookie missing from {set_cookies:?}",
    );
    app.cleanup().await;
}

#[tokio::test]
async fn entry_exchange_is_single_use_and_never_accepts_url_bearers() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    let credential = mint(uid, "blog", &host);

    let (first, headers, _) = exchange_entry(&app.router, &host, &credential).await;
    assert_eq!(first, StatusCode::SEE_OTHER);
    let location = headers.get(header::LOCATION).unwrap().to_str().unwrap();
    assert_eq!(location, "/blog/");
    assert!(!location.contains(&credential));

    let (replay, _, _) = exchange_entry(&app.router, &host, &credential).await;
    assert_eq!(replay, StatusCode::NOT_FOUND);
    let (query, _, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        &format!("/blog/?t={credential}"),
        &[],
    )
    .await;
    assert_eq!(query, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn entry_exchange_rejects_origin_content_type_and_form_ambiguity() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    let credential = mint(uid, "blog", &host);
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("credential", &credential)
        .finish();

    for (headers, want) in [
        (
            vec![("content-type", "application/x-www-form-urlencoded")],
            StatusCode::FORBIDDEN,
        ),
        (
            vec![
                ("origin", "null"),
                ("content-type", "application/x-www-form-urlencoded"),
            ],
            StatusCode::FORBIDDEN,
        ),
        (
            vec![
                ("origin", "https://evil.example"),
                ("content-type", "application/x-www-form-urlencoded"),
            ],
            StatusCode::FORBIDDEN,
        ),
        (
            vec![
                ("origin", TEST_IDENTITY_ORIGIN),
                ("origin", TEST_IDENTITY_ORIGIN),
                ("content-type", "application/x-www-form-urlencoded"),
            ],
            StatusCode::FORBIDDEN,
        ),
        (
            vec![("origin", TEST_IDENTITY_ORIGIN)],
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            vec![
                ("origin", TEST_IDENTITY_ORIGIN),
                (
                    "content-type",
                    "application/x-www-form-urlencoded; charset=utf-8",
                ),
            ],
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            vec![
                ("origin", TEST_IDENTITY_ORIGIN),
                ("content-type", "application/x-www-form-urlencoded"),
                ("content-type", "application/x-www-form-urlencoded"),
            ],
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
    ] {
        let (status, _, _) = send_host_body(
            &app.router,
            Method::POST,
            &host,
            devserver_gate::ENTRY_EXCHANGE_PATH,
            &headers,
            encoded.clone(),
        )
        .await;
        assert_eq!(status, want, "headers {headers:?}");
    }

    for malformed in [
        "",
        "credential=",
        "other=x",
        "credential=a&credential=b",
        "credential=a&other=b",
    ] {
        let (status, _, _) = send_host_body(
            &app.router,
            Method::POST,
            &host,
            devserver_gate::ENTRY_EXCHANGE_PATH,
            &[
                ("origin", TEST_IDENTITY_ORIGIN),
                ("content-type", "application/x-www-form-urlencoded"),
            ],
            malformed,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body {malformed:?}");
    }

    let oversized = format!("credential={}", "x".repeat(8193));
    let (status, _, _) = send_host_body(
        &app.router,
        Method::POST,
        &host,
        devserver_gate::ENTRY_EXCHANGE_PATH,
        &[
            ("origin", TEST_IDENTITY_ORIGIN),
            ("content-type", "application/x-www-form-urlencoded"),
        ],
        oversized,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    app.cleanup().await;
}

#[tokio::test]
async fn entry_preflight_is_independent_of_live_devserver_count() {
    let mut baseline = None;

    for live_count in 0..=2 {
        let app = TestApp::new().await;
        for devserver_id in ["one", "two"].into_iter().take(live_count) {
            app.register_tunnel("alice", devserver_id, Uuid::new_v4(), Router::new())
                .await;
        }
        let host = host_for("alice");
        let path = devserver_gate::ENTRY_EXCHANGE_PATH;
        let mut responses = Vec::new();
        responses.push(
            send_host(
                &app.router,
                Method::GET,
                &host,
                path,
                &[
                    ("origin", TEST_IDENTITY_ORIGIN),
                    ("content-type", "application/x-www-form-urlencoded"),
                ],
            )
            .await,
        );
        responses.push(
            send_host_body(
                &app.router,
                Method::POST,
                &host,
                path,
                &[
                    ("origin", "https://evil.example"),
                    ("content-type", "application/x-www-form-urlencoded"),
                ],
                "credential=junk",
            )
            .await,
        );
        responses.push(
            send_host_body(
                &app.router,
                Method::POST,
                &host,
                path,
                &[
                    ("origin", TEST_IDENTITY_ORIGIN),
                    ("content-type", "text/plain"),
                ],
                "credential=junk",
            )
            .await,
        );
        responses.push(
            send_host_body(
                &app.router,
                Method::POST,
                &host,
                path,
                &[
                    ("origin", TEST_IDENTITY_ORIGIN),
                    ("content-type", "application/x-www-form-urlencoded"),
                    ("accept", "text/html"),
                ],
                "credential=junk",
            )
            .await,
        );
        responses.push(
            send_host_body(
                &app.router,
                Method::POST,
                &host,
                path,
                &[
                    ("origin", TEST_IDENTITY_ORIGIN),
                    ("content-type", "application/x-www-form-urlencoded"),
                ],
                "other=junk",
            )
            .await,
        );
        responses.push(
            send_host_body(
                &app.router,
                Method::POST,
                &host,
                path,
                &[
                    ("origin", TEST_IDENTITY_ORIGIN),
                    ("content-type", "application/x-www-form-urlencoded"),
                ],
                format!("credential={}", "x".repeat(8193)),
            )
            .await,
        );

        assert_eq!(
            responses
                .iter()
                .map(|(status, _, _)| *status)
                .collect::<Vec<_>>(),
            vec![
                StatusCode::NOT_FOUND,
                StatusCode::FORBIDDEN,
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                StatusCode::NOT_FOUND,
                StatusCode::BAD_REQUEST,
                StatusCode::PAYLOAD_TOO_LARGE,
            ],
            "live devservers: {live_count}",
        );
        assert_eq!(
            &responses[0], &responses[3],
            "entry-path 404 response shapes differ"
        );
        if let Some(expected) = &baseline {
            assert_eq!(
                &responses, expected,
                "response changed with {live_count} live devservers"
            );
        } else {
            baseline = Some(responses);
        }
        app.cleanup().await;
    }
}

#[tokio::test]
async fn entry_token_redirects_only_to_signed_clean_path() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    let token = mint_for_owner(uid, uid, "blog", &host, "/blog/page?a=1&b=2");
    let (_, hdrs, _) = exchange_entry(&app.router, &host, &token).await;
    let loc = hdrs.get(header::LOCATION).unwrap().to_str().unwrap();
    assert_eq!(loc, "/blog/page?a=1&b=2");
    app.cleanup().await;
}

#[tokio::test]
async fn entry_token_for_wrong_devserver_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    // alice's live devserver id is "blog"; an entry token minted for a
    // different devserver id (e.g. a rotated/old one) must not admit.
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    let token = mint(uid, "stale-devserver", &host);
    let (s, _, _) = exchange_entry(&app.router, &host, &token).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn entry_token_for_wrong_host_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    // Token minted with aud=bob.p1.proxy.chan.app, presented on
    // alice.p1.proxy.chan.app.
    let bad_token = mint(uid, "blog", "bob.p1.proxy.chan.app");
    let (s, _, _) = exchange_entry(&app.router, &host_for("alice"), &bad_token).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn session_cookie_admits() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new().fallback(|| async { "owner pass" });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let session = opaque_session(&app, uid, uid, "blog", &host);

    let proxy_addr = serve_router_real(app.router.clone()).await;
    let res = reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/"))
        .header(header::HOST, &host)
        .header(header::COOKIE, format!("__Host-devserver_gate={session}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "owner pass");
    app.cleanup().await;
}

#[tokio::test]
async fn credentialed_response_denies_ambient_browser_authority() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new().fallback(|| async {
        (
            [(header::CONTENT_SECURITY_POLICY, "default-src 'self'")],
            "private",
        )
    });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let (status, headers, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        "/blog/",
        &[("cookie", &session_cookie(&app, uid, "blog", &host))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let policies: Vec<&str> = headers
        .get_all("content-security-policy")
        .iter()
        .map(|value| value.to_str().unwrap())
        .collect();
    assert_eq!(policies, ["default-src 'self'", "frame-ancestors 'none'"]);
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");
    assert_eq!(headers.get("cache-control").unwrap(), "private, no-store");
    app.cleanup().await;
}

#[tokio::test]
async fn session_cookie_for_wrong_devserver_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    // Live devserver id is "blog"; a session cookie carrying a different
    // devserver id (drv) must not admit, even on the right host.
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    let session = opaque_session(&app, uid, uid, "stale-devserver", &host);
    let (s, _, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        "/blog/",
        &[("cookie", &format!("__Host-devserver_gate={session}"))],
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

// Regression: identity mints entry JWTs with `sub = caller.user_id`
// (owner or accepted grantee). devserver-proxy used to compare `sub`
// against the registry-cached owner_id and 404 every grantee; the gate
// now trusts identity's mint-time `devserver_access` check and admits any
// signed entry with the right aud + drv.
#[tokio::test]
async fn entry_token_for_grantee_mints_session_carrying_grantee_sub() {
    let app = TestApp::new().await;
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    let upstream = Router::new().route("/", axum::routing::get(|| async { "grantee ok" }));
    app.register_tunnel("alice", "blog", alice, upstream).await;

    let host = host_for("alice");
    // Bob is an accepted grantee; identity mints sub = bob.
    let entry = mint_for_owner(bob, alice, "blog", &host, "/blog/");
    let (s, hdrs, _) = exchange_entry(&app.router, &host, &entry).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    let set = hdrs.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set.starts_with("__Host-devserver_gate="), "got {set}");

    // The minted session cookie must carry sub = bob (the grantee),
    // not sub = alice (the owner), so upstream attribution is correct.
    let cookie = set
        .strip_prefix("__Host-devserver_gate=")
        .and_then(|s| s.split(';').next())
        .unwrap();
    let claims = app
        .sessions
        .lookup(cookie)
        .expect("opaque session cookie should resolve")
        .principal;
    assert_eq!(
        claims.subject_user_id, bob,
        "session cookie sub must be grantee, not owner"
    );
    assert_eq!(claims.owner_user_id, alice);
    assert_eq!(claims.devserver_id, "blog");
    app.cleanup().await;
}

// Regression: a session cookie with a non-owner sub admits as long as
// the signature + aud + drv match. Belongs alongside the
// `session_cookie_for_wrong_devserver_is_404` test which still validates
// the real bound (drv must match the live devserver id).
#[tokio::test]
async fn session_cookie_with_grantee_sub_admits() {
    let app = TestApp::new().await;
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    let upstream = Router::new().fallback(|| async { "grantee pass" });
    app.register_tunnel("alice", "blog", alice, upstream).await;
    let host = host_for("alice");
    let session = opaque_session(&app, bob, alice, "blog", &host);

    let proxy_addr = serve_router_real(app.router.clone()).await;
    let res = reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/"))
        .header(header::HOST, &host)
        .header(header::COOKIE, format!("__Host-devserver_gate={session}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "grantee pass");
    app.cleanup().await;
}

#[tokio::test]
async fn entry_token_with_bad_signature_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    // Token signed with an untrusted identity key; same claim envelope.
    let other_signer =
        devserver_gate::EntrySigner::from_base64("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")
            .unwrap();
    let bad = devserver_gate::encode_entry(&other_signer, uid, uid, "blog", &host, "p1", "/blog/")
        .unwrap();
    let (s, _, _) = exchange_entry(&app.router, &host, &bad).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Segment-preserving forward + upstream proxy
// ---------------------------------------------------------------

#[tokio::test]
async fn proxy_preserves_workspace_segment() {
    // The proxy is a segment-PRESERVING forwarder: it hands the
    // devserver the full public `/{workspace}/...` path (the devserver
    // mounts each tenant at its public slug and routes internally).
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new()
        .route("/blog/assets/foo.js", axum::routing::get(|| async { "js" }))
        .route("/blog/", axum::routing::get(|| async { "root" }));
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let client = reqwest::Client::new();
    let res = client
        .get(format!("http://{proxy_addr}/blog/assets/foo.js"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "js");

    let res = client
        .get(format!("http://{proxy_addr}/blog/"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.text().await.unwrap(), "root");

    app.cleanup().await;
}

#[tokio::test]
async fn transfer_route_admits_body_beyond_the_general_request_cap() {
    // The transfer route replaces the general MAX_REQUEST_BYTES cap with
    // the explicit 100 GiB allowance; a tight injected cap makes the
    // difference observable with a small body.
    let app = TestApp::new_with_caps(Some(1024), None).await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let csrf = "csrf-test-token";
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let client = reqwest::Client::new();
    let body = vec![b'x'; 8 * 1024];
    let cookie = session_and_csrf_cookie(&app, uid, "blog", &host, csrf);

    let res = client
        .post(format!("http://{proxy_addr}/blog/api/fs/upload"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .header("x-chan-csrf", csrf)
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(captured.requests.lock().unwrap().len(), 1);

    // A non-transfer route over the same cap is cut mid-body and never
    // reaches the devserver.
    let res = client
        .post(format!("http://{proxy_addr}/blog/api/graph"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .header("x-chan-csrf", csrf)
        .body(body)
        .send()
        .await
        .unwrap();
    assert_ne!(res.status(), StatusCode::OK);
    assert_eq!(captured.requests.lock().unwrap().len(), 1);
    app.cleanup().await;
}

#[tokio::test]
async fn transfer_route_serves_body_beyond_the_general_response_cap() {
    // Same split on the response side: the transfer route streams past
    // the general MAX_RESPONSE_BYTES cap while a general route's
    // over-cap response is refused with a 502 before any body streams.
    let app = TestApp::new_with_caps(None, Some(1024)).await;
    let uid = Uuid::new_v4();
    let big = Bytes::from(vec![b'y'; 8 * 1024]);
    let upstream = Router::new().fallback(move || {
        let big = big.clone();
        async move { big }
    });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let client = reqwest::Client::new();

    let res = client
        .get(format!(
            "http://{proxy_addr}/blog/api/fs/big.bin?download=1"
        ))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.bytes().await.unwrap().len(), 8 * 1024);

    let res = client
        .get(format!("http://{proxy_addr}/blog/api/graph"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    let body = res.bytes().await;
    assert!(
        body.is_err() || body.unwrap().len() < 8 * 1024,
        "a general route's over-cap body must not arrive whole"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn head_response_declared_over_cap_is_not_refused() {
    // HEAD carries no body, so an upstream that declares an over-cap
    // representation length still gets its headers through under the
    // general policy; the declared-length refusal applies only to
    // responses that actually stream a body.
    let app = TestApp::new_with_caps(None, Some(1024)).await;
    let uid = Uuid::new_v4();
    let big = Bytes::from(vec![b'y'; 8 * 1024]);
    let upstream = Router::new().fallback(move || {
        let big = big.clone();
        async move { big }
    });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let client = reqwest::Client::new();

    let res = client
        .head(format!("http://{proxy_addr}/blog/api/graph"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    // The upstream declares the over-cap representation length (the
    // same 8192 the GET twin is refused for); the declared-length
    // refusal must not fire for HEAD, and no body streams.
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.bytes().await.unwrap().len(), 0);
    app.cleanup().await;
}

#[tokio::test]
async fn management_api_is_404_on_public_wildcard() {
    // `/api/devserver/*` is the devserver's local-only management API;
    // the proxy must 404 it on the public host so only tenant content
    // reaches the tunnel.
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new().fallback(|| async { "should not reach upstream" });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    // Even with a valid session cookie, the management API is not proxied.
    let (s, _, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        "/api/devserver/workspaces",
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn unsafe_methods_require_matching_csrf_header() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let client = reqwest::Client::new();
    let methods = [
        Method::POST,
        Method::PUT,
        Method::PATCH,
        Method::DELETE,
        Method::TRACE,
        Method::from_bytes(b"PROPFIND").unwrap(),
    ];
    for method in methods {
        let res = client
            .request(method.clone(), format!("http://{proxy_addr}/blog/mutate"))
            .header(header::HOST, &host)
            .header(header::COOKIE, session_cookie(&app, uid, "blog", &host))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method}");

        let csrf = "csrf-test-token";
        let res = client
            .request(method.clone(), format!("http://{proxy_addr}/blog/mutate"))
            .header(header::HOST, &host)
            .header(
                header::COOKIE,
                session_and_csrf_cookie(&app, uid, "blog", &host, csrf),
            )
            .header("x-chan-csrf", csrf)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{method}");
    }

    assert_eq!(captured.requests.lock().unwrap().len(), 6);
    app.cleanup().await;
}

#[tokio::test]
async fn csrf_header_is_stripped_from_upstream() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let csrf = "csrf-test-token";
    let proxy_addr = serve_router_real(app.router.clone()).await;
    reqwest::Client::new()
        .post(format!("http://{proxy_addr}/blog/mutate"))
        .header(header::HOST, &host)
        .header(
            header::COOKIE,
            session_and_csrf_cookie(&app, uid, "blog", &host, csrf),
        )
        .header("x-chan-csrf", csrf)
        .send()
        .await
        .unwrap();

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    assert!(headers.get("x-chan-csrf").is_none());
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Hop-by-hop + X-Forwarded-*
// ---------------------------------------------------------------

async fn serve_router_real(router: Router) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    addr
}

#[derive(Clone, Default)]
struct Captured {
    requests: Arc<StdMutex<Vec<RecordedRequest>>>,
}

struct RecordedRequest {
    headers: HeaderMap,
}

fn capturing_router(captured: Captured) -> Router {
    let captured = Arc::new(captured);
    Router::new().fallback(move |req: AxRequest| {
        let captured = captured.clone();
        async move {
            captured.requests.lock().unwrap().push(RecordedRequest {
                headers: req.headers().clone(),
            });
            (
                [(header::CONTENT_TYPE, "text/plain")],
                Bytes::from_static(b"ok"),
            )
                .into_response()
        }
    })
}

#[tokio::test]
async fn x_forwarded_for_appended_when_absent() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/x"))
        .header(header::HOST, &host)
        .header(header::COOKIE, session_cookie(&app, uid, "blog", &host))
        .send()
        .await
        .unwrap();

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    let xff = headers.get("x-forwarded-for").unwrap().to_str().unwrap();
    assert_eq!(xff, "127.0.0.1");
    // X-Forwarded-Proto is sourced from cfg.forwarded_proto (which
    // TestApp configures as the prod default "https"), NOT from any
    // inbound X-Forwarded-Proto header. The test exercises the
    // no-inbound case here.
    let proto = headers.get("x-forwarded-proto").unwrap().to_str().unwrap();
    assert_eq!(proto, "https");
    // X-Forwarded-Host is sourced from the inbound Host header workspace-
    // proxy itself routed on, not from any inbound X-Forwarded-Host.
    let host = headers.get("x-forwarded-host").unwrap().to_str().unwrap();
    assert_eq!(host, host_for("alice"));
    app.cleanup().await;
}

#[tokio::test]
async fn client_supplied_forwarded_headers_are_discarded() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/y"))
        .header(header::HOST, &host)
        .header(header::COOKIE, session_cookie(&app, uid, "blog", &host))
        .header("x-forwarded-for", "203.0.113.5")
        // Inbound XFProto/XFHost: client-supplied and must be ignored.
        // Asserted below: outbound matches cfg / Host, not these values.
        .header("x-forwarded-proto", "http")
        .header("x-forwarded-host", "evil.example.com")
        .send()
        .await
        .unwrap();

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    // Inbound XFF is untrusted without a configured edge allowlist.
    let xff = headers.get("x-forwarded-for").unwrap().to_str().unwrap();
    assert_eq!(xff, "127.0.0.1");
    // XFProto and XFHost are NOT trusted from inbound; the outbound
    // values come from cfg.forwarded_proto and the inbound Host
    // header. Without this we'd be a malleable forwarder for any
    // upstream that builds absolute URLs from XFH/XFProto.
    let proto = headers.get("x-forwarded-proto").unwrap().to_str().unwrap();
    assert_eq!(proto, "https");
    let host = headers.get("x-forwarded-host").unwrap().to_str().unwrap();
    assert_eq!(host, host_for("alice"));

    let xff_count = headers.get_all("x-forwarded-for").iter().count();
    assert_eq!(xff_count, 1);
    app.cleanup().await;
}

#[tokio::test]
async fn cookie_header_stripped_from_upstream() {
    // devserver-proxy must never forward the __Host-devserver_gate cookie to the
    // tenant's chan-serve peer (the cookie is for the gate, not for
    // the tenant). The very cookie that admits the request is stripped
    // before the upstream sees it. Other inbound cookies the tenant
    // content might care about are also stripped today; if that proves
    // wrong we can selectively preserve specific cookie names later.
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/z"))
        .header(header::HOST, &host)
        .header(
            header::COOKIE,
            format!("{}; other=value", session_cookie(&app, uid, "blog", &host)),
        )
        .send()
        .await
        .unwrap();

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    assert!(headers.get(header::COOKIE).is_none());
    app.cleanup().await;
}

#[tokio::test]
async fn authorization_header_stripped_from_upstream() {
    // A user-presented Authorization bearer (e.g. an API client that
    // happens to land on a tenant URL with its own credential) must
    // never reach the tenant's chan-serve. Auth on this leg is the
    // devserver-gate cookie / entry-token handshake; the tenant's content
    // has no business seeing the user's PAT or any other bearer.
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/a"))
        .header(header::HOST, &host)
        .header(header::COOKIE, session_cookie(&app, uid, "blog", &host))
        .header(header::AUTHORIZATION, "Bearer chan_pat_secret")
        .send()
        .await
        .unwrap();

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    assert!(
        headers.get(header::AUTHORIZATION).is_none(),
        "Authorization header must be stripped before reaching upstream"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn gateway_assertion_matches_authenticated_session() {
    let app = TestApp::new().await;
    let owner = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let devserver_id = "blog";
    let tunnel_token = "tok-gateway-assertion";
    let captured = Captured::default();
    app.register_tunnel_with_token(
        tunnel_token,
        "alice",
        devserver_id,
        owner,
        capturing_router(captured.clone()),
    )
    .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let res = reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/assertion"))
        .header(header::HOST, &host)
        .header(
            header::COOKIE,
            session_cookie_for_owner(&app, caller, owner, devserver_id, &host),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    let assertion = headers
        .get(chan_tunnel_proto::gateway_assertion::HEADER_NAME)
        .expect("gateway assertion header")
        .to_str()
        .unwrap();
    let key = chan_tunnel_proto::gateway_assertion::derive_assertion_key(tunnel_token);
    let claims = chan_tunnel_proto::gateway_assertion::verify(
        &key,
        assertion,
        &host,
        devserver_id,
        &owner.to_string(),
    )
    .expect("assertion verifies with tunnel token derived key");
    assert_eq!(claims.sub, caller.to_string());
    assert_eq!(claims.owner_user_id, owner.to_string());
    assert_eq!(claims.aud, host);
    assert_eq!(claims.drv, devserver_id);
    app.cleanup().await;
}

#[tokio::test]
async fn gateway_assertion_omits_display_identity() {
    // Authorization credentials carry only immutable ids. Display identity
    // belongs on a separate lookup path and must not leak into entry/session
    // credentials or the per-request gateway assertion.
    let app = TestApp::new().await;
    let owner = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let devserver_id = "blog";
    let tunnel_token = "tok-assertion-identity";
    let captured = Captured::default();
    app.register_tunnel_with_token(
        tunnel_token,
        "alice",
        devserver_id,
        owner,
        capturing_router(captured.clone()),
    )
    .await;

    let host = host_for("alice");
    let entry = mint_for_owner(caller, owner, devserver_id, &host, "/blog/");
    let (s, hdrs, _) = exchange_entry(&app.router, &host, &entry).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    let session = hdrs
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .find(|v| v.starts_with("__Host-devserver_gate="))
        .expect("session cookie")
        .split(';')
        .next()
        .unwrap()
        .to_string();

    let proxy_addr = serve_router_real(app.router.clone()).await;
    let res = reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/assertion"))
        .header(header::HOST, &host)
        .header(header::COOKIE, &session)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    let assertion = headers
        .get(chan_tunnel_proto::gateway_assertion::HEADER_NAME)
        .expect("gateway assertion header")
        .to_str()
        .unwrap();
    let key = chan_tunnel_proto::gateway_assertion::derive_assertion_key(tunnel_token);
    let claims = chan_tunnel_proto::gateway_assertion::verify(
        &key,
        assertion,
        &host,
        devserver_id,
        &owner.to_string(),
    )
    .expect("assertion verifies");
    assert_eq!(claims.sub, caller.to_string());
    let wire = serde_json::to_value(&claims).unwrap();
    assert!(wire.get("name").is_none());
    assert!(wire.get("email").is_none());
    app.cleanup().await;
}

#[tokio::test]
async fn gateway_assertion_from_opaque_session_has_only_authority_claims() {
    let app = TestApp::new().await;
    let owner = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let devserver_id = "blog";
    let tunnel_token = "tok-assertion-legacy";
    let captured = Captured::default();
    app.register_tunnel_with_token(
        tunnel_token,
        "alice",
        devserver_id,
        owner,
        capturing_router(captured.clone()),
    )
    .await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let res = reqwest::Client::new()
        .get(format!("http://{proxy_addr}/blog/assertion"))
        .header(header::HOST, &host)
        .header(
            header::COOKIE,
            session_cookie_for_owner(&app, caller, owner, devserver_id, &host),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let headers = captured.requests.lock().unwrap()[0].headers.clone();
    let assertion = headers
        .get(chan_tunnel_proto::gateway_assertion::HEADER_NAME)
        .expect("gateway assertion header")
        .to_str()
        .unwrap();
    let key = chan_tunnel_proto::gateway_assertion::derive_assertion_key(tunnel_token);
    let claims = chan_tunnel_proto::gateway_assertion::verify(
        &key,
        assertion,
        &host,
        devserver_id,
        &owner.to_string(),
    )
    .expect("assertion verifies");
    assert_eq!(claims.sub, caller.to_string());
    let wire = serde_json::to_value(&claims).unwrap();
    assert!(wire.get("name").is_none());
    assert!(wire.get("email").is_none());
    app.cleanup().await;
}

// ---------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------

#[tokio::test]
async fn websocket_bridges_text_frames() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TgMessage;

    let app = TestApp::new().await;
    let uid = Uuid::new_v4();

    async fn echo(ws: axum::extract::WebSocketUpgrade) -> axum::response::Response {
        ws.on_upgrade(|mut socket| async move {
            if let Some(Ok(axum::extract::ws::Message::Text(s))) = socket.recv().await {
                let _ = socket
                    .send(axum::extract::ws::Message::Text(format!("echo:{s}").into()))
                    .await;
            }
            let _ = socket.close().await;
        })
    }
    // Segment-preserving forward: the upstream sees the full /blog/ws path.
    let upstream = Router::new().route("/blog/ws", axum::routing::get(echo));
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let url = format!("ws://{proxy_addr}/blog/ws");
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert(header::HOST, HeaderValue::from_str(&host).unwrap());
    req.headers_mut().insert(
        header::COOKIE,
        HeaderValue::from_str(&session_cookie(&app, uid, "blog", &host)).unwrap(),
    );
    req.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_str(&format!("https://{host}")).unwrap(),
    );

    let (mut client_ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    client_ws
        .send(TgMessage::Text("hello".into()))
        .await
        .unwrap();
    let echoed = client_ws.next().await.expect("frame").expect("ws ok");
    match echoed {
        TgMessage::Text(s) => assert_eq!(s, "echo:hello"),
        other => panic!("unexpected: {other:?}"),
    }
    let _ = client_ws.close(None).await;
    app.cleanup().await;
}

#[tokio::test]
async fn websocket_upgrade_runs_auth_gate() {
    let app = TestApp::new().await;
    app.register_tunnel("alice", "blog", Uuid::new_v4(), Router::new())
        .await;

    let req = Request::builder()
        .method(Method::GET)
        .uri("/blog/ws")
        .header(header::HOST, host_for("alice"))
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("sec-websocket-version", "13")
        .body(Body::empty())
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn websocket_upgrade_requires_the_exact_tenant_origin() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, Router::new())
        .await;
    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);

    for origin in [
        None,
        Some("null"),
        Some("https://bob.p1.proxy.chan.app"),
        Some("http://alice.p1.proxy.chan.app"),
        Some("https://alice.p1.proxy.chan.app:7002"),
        Some("https://alice.p1.proxy.chan.app/path"),
    ] {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri("/blog/ws")
            .header(header::HOST, &host)
            .header(header::COOKIE, &cookie)
            .header(header::UPGRADE, "websocket")
            .header(header::CONNECTION, "Upgrade")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("sec-websocket-version", "13");
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        let res = app
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            res.status(),
            StatusCode::FORBIDDEN,
            "origin {origin:?} must be refused"
        );
    }

    app.cleanup().await;
}

// ---------------------------------------------------------------
// Multi-devserver routing (disc hosts + bare-host compat)
// ---------------------------------------------------------------

#[tokio::test]
async fn disc_hosts_route_to_their_devservers() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let up_a = Router::new().fallback(|| async { "ds-a" });
    let up_b = Router::new().fallback(|| async { "ds-b" });
    app.register_tunnel_hello("alice", DS_A, "ws-a", uid, up_a)
        .await;
    app.register_tunnel_hello("alice", DS_B, "ws-b", uid, up_b)
        .await;

    let proxy_addr = serve_router_real(app.router.clone()).await;
    for (id, body) in [(DS_A, "ds-a"), (DS_B, "ds-b")] {
        let host = disc_host_for("alice", id);
        let session = opaque_session(&app, uid, uid, id, &host);
        let res = reqwest::Client::new()
            .get(format!("http://{proxy_addr}/blog/"))
            .header(header::HOST, &host)
            .header(header::COOKIE, format!("__Host-devserver_gate={session}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.text().await.unwrap(), body);
    }
    app.cleanup().await;
}

#[tokio::test]
async fn bare_host_with_two_live_routes_by_credential() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let up_a = Router::new().fallback(|| async { "ds-a" });
    let up_b = Router::new().fallback(|| async { "ds-b" });
    app.register_tunnel_hello("alice", DS_A, "ws-a", uid, up_a)
        .await;
    app.register_tunnel_hello("alice", DS_B, "ws-b", uid, up_b)
        .await;

    // Same bare host both times; the session's drv claim picks the
    // devserver.
    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    for (id, body) in [(DS_A, "ds-a"), (DS_B, "ds-b")] {
        let session = opaque_session(&app, uid, uid, id, &host);
        let res = reqwest::Client::new()
            .get(format!("http://{proxy_addr}/blog/"))
            .header(header::HOST, &host)
            .header(header::COOKIE, format!("__Host-devserver_gate={session}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.text().await.unwrap(), body);
    }
    app.cleanup().await;
}

#[tokio::test]
async fn bare_host_with_two_live_and_no_credential_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel_hello("alice", DS_A, "ws-a", uid, Router::new())
        .await;
    app.register_tunnel_hello("alice", DS_B, "ws-b", uid, Router::new())
        .await;

    let (s, _, _) = send_host(&app.router, Method::GET, &host_for("alice"), "/blog/", &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn bare_host_entry_exchange_with_multiple_live_routes_is_rejected() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel_hello("alice", DS_A, "ws-a", uid, Router::new())
        .await;
    app.register_tunnel_hello("alice", DS_B, "ws-b", uid, Router::new())
        .await;

    let host = host_for("alice");
    let entry = mint(uid, DS_B, &host);
    let (s, hdrs, _) = exchange_entry(&app.router, &host, &entry).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert!(!hdrs.contains_key(header::SET_COOKIE));
    app.cleanup().await;
}

#[tokio::test]
async fn ambiguous_disc_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    // Two live devservers sharing the same 12-hex prefix: the disc
    // host cannot pick one, even with a valid credential.
    app.register_tunnel_hello("alice", DS_AMB1, "ws-1", uid, Router::new())
        .await;
    app.register_tunnel_hello("alice", DS_AMB2, "ws-2", uid, Router::new())
        .await;

    let host = disc_host_for("alice", DS_AMB1);
    let session = opaque_session(&app, uid, uid, DS_AMB1, &host);
    let (s, _, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        "/blog/",
        &[("cookie", &format!("__Host-devserver_gate={session}"))],
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn unknown_disc_is_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel_hello("alice", DS_A, "ws-a", uid, Router::new())
        .await;

    // Well-formed disc host naming a devserver that is not live.
    let host = disc_host_for("alice", DS_B);
    let session = opaque_session(&app, uid, uid, DS_A, &host);
    let (s, _, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        "/blog/",
        &[("cookie", &format!("__Host-devserver_gate={session}"))],
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn credential_for_other_users_devserver_never_routes() {
    let app = TestApp::new().await;
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    app.register_tunnel_hello("alice", DS_A, "ws-a", alice, Router::new())
        .await;
    app.register_tunnel_hello("bob", DS_B, "ws-b", bob, Router::new())
        .await;

    // A session minted for bob's devserver on bob's host: replaying
    // it on alice's hosts (bare and disc) must 404. The aud claim
    // binds the credential to bob's host, so the bare-host drv loop
    // over alice's live set can never verify it.
    let session = opaque_session(&app, bob, bob, DS_B, &host_for("bob"));
    for host in [host_for("alice"), disc_host_for("alice", DS_A)] {
        let (s, _, _) = send_host(
            &app.router,
            Method::GET,
            &host,
            "/blog/",
            &[("cookie", &format!("__Host-devserver_gate={session}"))],
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND, "host {host}");
    }
    app.cleanup().await;
}

#[tokio::test]
async fn disc_wildcard_root_redirects_to_dashboard() {
    let app = TestApp::new().await;
    let (s, hdrs, _) = send_host(
        &app.router,
        Method::GET,
        &disc_host_for("alice", DS_A),
        "/",
        &[],
    )
    .await;
    assert!(s.is_redirection(), "got {s}");
    let loc = hdrs.get(header::LOCATION).unwrap().to_str().unwrap();
    assert_eq!(loc, TEST_DASHBOARD_URL);
    app.cleanup().await;
}

// ---------------------------------------------------------------
// WS bridge idle semantics
// ---------------------------------------------------------------

/// Sub-second idle window for the bridge tests: long enough that
/// handshakes and scheduling jitter never trip it, short enough that
/// the cut is observable in a unit-test budget.
const WS_TEST_IDLE: std::time::Duration = std::time::Duration::from_millis(600);

/// Serve the proxy router on a real listener: a WS upgrade needs a
/// live connection, which `oneshot` cannot provide. The server task
/// is aborted by the caller when the test ends.
async fn serve_proxy(router: Router) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (addr, task)
}

/// Dial a gated WS through the proxy: TCP to the test listener, Host
/// riding the request URI, session cookie passing the gate.
async fn ws_connect(
    addr: SocketAddr,
    host: &str,
    path: &str,
    cookie: &str,
) -> tokio_tungstenite::WebSocketStream<TcpStream> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let tcp = TcpStream::connect(addr).await.unwrap();
    tcp.set_nodelay(true).unwrap();
    let mut request = format!("ws://{host}{path}").into_client_request().unwrap();
    request
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    request
        .headers_mut()
        .insert(header::ORIGIN, format!("https://{host}").parse().unwrap());
    let (ws, _resp) = tokio_tungstenite::client_async(request, tcp)
        .await
        .expect("ws handshake through the proxy");
    ws
}

/// Upstream devserver router with three WS personalities: `stream`
/// pushes a text frame every 100ms unprompted, `echo` answers each
/// text frame and sends nothing on its own, `sink` reads and
/// discards everything.
fn ws_upstream_router() -> Router {
    use axum::extract::ws::{Message as AxMessage, WebSocketUpgrade as AxUpgrade};
    Router::new()
        .route(
            "/blog/ws-stream",
            axum::routing::get(|ws: AxUpgrade| async move {
                ws.on_upgrade(|mut socket| async move {
                    let mut n = 0u64;
                    loop {
                        n += 1;
                        if socket
                            .send(AxMessage::text(format!("tick-{n}")))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                })
            }),
        )
        .route(
            "/blog/ws-echo",
            axum::routing::get(|ws: AxUpgrade| async move {
                ws.on_upgrade(|mut socket| async move {
                    while let Some(Ok(msg)) = socket.recv().await {
                        if let AxMessage::Text(t) = msg {
                            if socket.send(AxMessage::Text(t)).await.is_err() {
                                break;
                            }
                        }
                    }
                })
            }),
        )
        .route(
            "/blog/ws-sink",
            axum::routing::get(|ws: AxUpgrade| async move {
                ws.on_upgrade(
                    |mut socket| async move { while let Some(Ok(_)) = socket.recv().await {} },
                )
            }),
        )
}

#[tokio::test]
async fn ws_bridge_survives_idle_window_while_upstream_streams() {
    use tokio_tungstenite::tungstenite::Message as WsMsg;
    let app = TestApp::new_with_ws_idle_timeout(WS_TEST_IDLE).await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, ws_upstream_router())
        .await;
    let (addr, server) = serve_proxy(app.router.clone()).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    let mut ws = ws_connect(addr, &host, "/blog/ws-stream", &cookie).await;

    // Zero client->upstream frames for 3x the idle window: the shared
    // window must keep resetting on upstream->client traffic alone.
    let hold_until = tokio::time::Instant::now() + 3 * WS_TEST_IDLE;
    let mut ticks = 0u32;
    while tokio::time::Instant::now() < hold_until {
        match tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(WsMsg::Text(_)))) => ticks += 1,
            Ok(Some(Ok(WsMsg::Close(frame)))) => {
                panic!("bridge cut a streaming socket: {frame:?}")
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => panic!("ws error on a streaming socket: {e}"),
            Ok(None) => panic!("bridge dropped a streaming socket"),
            Err(_) => panic!("stream stalled past the tick interval"),
        }
    }
    assert!(ticks >= 12, "expected steady ticks over 1.8s, got {ticks}");
    server.abort();
    app.cleanup().await;
}

#[tokio::test]
async fn ws_bridge_survives_idle_window_on_client_frames_alone() {
    use tokio_tungstenite::tungstenite::Message as WsMsg;
    let app = TestApp::new_with_ws_idle_timeout(WS_TEST_IDLE).await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, ws_upstream_router())
        .await;
    let (addr, server) = serve_proxy(app.router.clone()).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    let mut ws = ws_connect(addr, &host, "/blog/ws-sink", &cookie).await;

    // The upstream never sends; client frames every 150ms must keep
    // the bridge open well past the idle window. If the client
    // direction failed to reset the shared window, the cut would land
    // mid-send phase and surface as a Close below.
    let send_until = tokio::time::Instant::now() + 3 * WS_TEST_IDLE;
    let mut quiet_started = tokio::time::Instant::now();
    while tokio::time::Instant::now() < send_until {
        ws.send(WsMsg::text("ping")).await.expect("send while live");
        quiet_started = tokio::time::Instant::now();
        match tokio::time::timeout(std::time::Duration::from_millis(150), ws.next()).await {
            Err(_) => {} // nothing inbound: the sink stays silent
            Ok(Some(Ok(WsMsg::Close(frame)))) => {
                panic!("bridge cut a client-active socket: {frame:?}")
            }
            Ok(Some(Ok(_))) => {}
            Ok(other) => panic!("client-active socket ended early: {other:?}"),
        }
    }

    // Measure the quiet window from the last successful client frame,
    // proving the bridge remained alive through the send phase.
    let closed = tokio::time::timeout(4 * WS_TEST_IDLE, async {
        loop {
            match ws.next().await {
                Some(Ok(WsMsg::Close(frame))) => break frame,
                Some(Ok(_)) => continue,
                other => panic!("expected a Close frame, got {other:?}"),
            }
        }
    })
    .await
    .expect("idle cut must arrive after the client goes quiet");
    let elapsed = quiet_started.elapsed();
    assert!(
        elapsed >= WS_TEST_IDLE,
        "cut arrived less than one idle window after the last client frame: {elapsed:?}"
    );
    let frame = closed.expect("close carries code and reason");
    assert_eq!(u16::from(frame.code), 1001, "going away");
    server.abort();
    app.cleanup().await;
}

#[tokio::test]
async fn ws_bridge_cuts_both_idle_socket_with_a_close_frame() {
    use tokio_tungstenite::tungstenite::Message as WsMsg;
    let app = TestApp::new_with_ws_idle_timeout(WS_TEST_IDLE).await;
    let uid = Uuid::new_v4();
    app.register_tunnel("alice", "blog", uid, ws_upstream_router())
        .await;
    let (addr, server) = serve_proxy(app.router.clone()).await;

    let host = host_for("alice");
    let cookie = session_cookie(&app, uid, "blog", &host);
    let mut ws = ws_connect(addr, &host, "/blog/ws-echo", &cookie).await;

    // The reference precedes the client frame and its upstream echo, so
    // either deadline reset can only increase the observed quiet window.
    let quiet_started = tokio::time::Instant::now();
    ws.send(WsMsg::text("hello")).await.unwrap();
    let echoed = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
        .await
        .expect("echo within budget")
        .expect("socket open")
        .expect("clean frame");
    assert_eq!(echoed, WsMsg::text("hello"));

    // The client half must observe a real Close frame (code + reason),
    // not an abrupt FIN, and not before the idle window has elapsed.
    let closed = tokio::time::timeout(4 * WS_TEST_IDLE, async {
        loop {
            match ws.next().await {
                Some(Ok(WsMsg::Close(frame))) => break frame,
                Some(Ok(_)) => continue,
                other => panic!("expected a Close frame, got {other:?}"),
            }
        }
    })
    .await
    .expect("both-idle cut must arrive");
    let elapsed = quiet_started.elapsed();
    assert!(
        elapsed >= WS_TEST_IDLE,
        "cut arrived before the idle window elapsed: {elapsed:?}"
    );
    let frame = closed.expect("close carries code and reason");
    assert_eq!(u16::from(frame.code), 1001, "going away");
    assert_eq!(frame.reason.as_str(), "idle timeout");

    // After the Close the stream ends cleanly.
    match tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await {
        Ok(None) | Ok(Some(Err(_))) => {}
        other => panic!("socket should end after the Close, got {other:?}"),
    }
    server.abort();
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Extension capability lane
// ---------------------------------------------------------------

const EXT_CAPABILITY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn ext_path(rest: &str) -> String {
    format!("/blog/_chan/extensions/echo/{EXT_CAPABILITY}{rest}")
}

/// The live defect: an opaque-origin extension frame fetches its module
/// script cookieless, so it can never pass the session gate. The exact
/// capability shape is admitted without it; the devserver's own
/// capability check is the authorization. The forwarded request must
/// carry no cookie and a NON-owner assertion (nil subject), so the
/// devserver's tunnel lane keeps capability callers read-only.
#[tokio::test]
async fn extension_capability_path_admits_cookieless_and_stays_non_owner() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    let token = format!("tok-{}", Uuid::new_v4().simple());
    app.register_tunnel_with_token(
        &token,
        "alice",
        "blog",
        uid,
        capturing_router(captured.clone()),
    )
    .await;

    let host = host_for("alice");
    let (status, headers, body) = send_host(
        &app.router,
        Method::GET,
        &host,
        &ext_path("/app.js"),
        &[("origin", "null"), ("sec-fetch-mode", "cors")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "null"
    );
    assert_eq!(body.as_ref(), b"ok");

    let upstream_headers = captured.requests.lock().unwrap()[0].headers.clone();
    assert!(upstream_headers.get(header::COOKIE).is_none());
    let assertion = upstream_headers
        .get("x-chan-gateway-assertion")
        .expect("forwarded request carries the assertion")
        .to_str()
        .unwrap();
    let key = chan_tunnel_proto::gateway_assertion::derive_assertion_key(&token);
    let claims = chan_tunnel_proto::gateway_assertion::verify(
        &key,
        assertion,
        &host,
        "blog",
        &uid.to_string(),
    )
    .expect("assertion verifies at the devserver");
    assert!(!claims.is_owner(), "capability callers must stay non-owner");
    assert_eq!(claims.sub, Uuid::nil().to_string());
    app.cleanup().await;
}

/// A wrong (well-formed) capability forwards to the devserver, whose
/// miss answers 404; the namespace policy keeps that status readable
/// from the opaque-origin frame instead of CORS-masking it.
#[tokio::test]
async fn extension_capability_miss_404_is_cors_readable() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new().fallback(|| async { StatusCode::NOT_FOUND.into_response() });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let stale = "f".repeat(64);
    let (status, headers, _) = send_host(
        &app.router,
        Method::GET,
        &host,
        &format!("/blog/_chan/extensions/echo/{stale}/app.js"),
        &[("origin", "null"), ("sec-fetch-mode", "cors")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "null"
    );
    app.cleanup().await;
}

/// Only the exact shape is admitted: near-miss spellings stay behind
/// the session gate and keep today's bare anti-enumeration 404,
/// byte-identical to any other unauthenticated tenant path.
#[tokio::test]
async fn loose_extension_shapes_stay_behind_the_session_gate() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let upstream = Router::new().fallback(|| async { "must never be reached" });
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let upper = EXT_CAPABILITY.to_ascii_uppercase();
    for path in [
        // No trailing slash after the capability.
        &format!("/blog/_chan/extensions/echo/{EXT_CAPABILITY}") as &str,
        // Capability malformed: short, uppercase.
        "/blog/_chan/extensions/echo/0123abc/",
        &format!("/blog/_chan/extensions/echo/{upper}/app.js"),
        // Tenant content around the namespace.
        "/blog/",
        "/blog/api/extensions",
    ] {
        let (status, headers, body) =
            send_host(&app.router, Method::GET, &host, path, &[("origin", "null")]).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert!(
            headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(),
            "{path} must stay CORS-opaque"
        );
        assert_eq!(body.as_ref(), br#"{"error":"not found"}"#, "{path}");
    }
    app.cleanup().await;
}

/// The CSRF gate protects cookie-authenticated mutations; the
/// capability lane is cookieless, so a POST forwards without the CSRF
/// pair. Authorization for mutations stays with the devserver: its
/// tunnel lane 403s the non-owner assertion this lane mints.
#[tokio::test]
async fn extension_capability_post_skips_the_csrf_gate() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel("alice", "blog", uid, capturing_router(captured.clone()))
        .await;

    let host = host_for("alice");
    let (status, _, body) = send_host_body(
        &app.router,
        Method::POST,
        &host,
        &ext_path("/state"),
        &[("origin", "null")],
        Body::from("{}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b"ok");
    app.cleanup().await;
}

/// A bare host with several live devservers cannot bind a capability
/// path to one tunnel. The refusal is still shaped like the session
/// gate's 404 but carries the namespace policy so the frame can read
/// it.
#[tokio::test]
async fn extension_capability_on_an_ambiguous_bare_host_is_a_readable_404() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.register_tunnel_hello("alice", DS_A, "one", uid, Router::new())
        .await;
    app.register_tunnel_hello("alice", DS_B, "two", uid, Router::new())
        .await;

    let (status, headers, body) = send_host(
        &app.router,
        Method::GET,
        &host_for("alice"),
        &ext_path("/app.js"),
        &[("origin", "null")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "null"
    );
    assert_eq!(body.as_ref(), br#"{"error":"not found"}"#);
    app.cleanup().await;
}

/// A disc host resolves the capability path to its one devserver even
/// when the user holds several live registrations.
#[tokio::test]
async fn extension_capability_resolves_through_a_disc_host() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let captured = Captured::default();
    app.register_tunnel_hello(
        "alice",
        DS_A,
        "blog",
        uid,
        capturing_router(captured.clone()),
    )
    .await;
    app.register_tunnel_hello("alice", DS_B, "blog", uid, Router::new())
        .await;

    let (status, headers, body) = send_host(
        &app.router,
        Method::GET,
        &disc_host_for("alice", DS_A),
        &ext_path("/app.js"),
        &[("origin", "null")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "null"
    );
    assert_eq!(body.as_ref(), b"ok");
    app.cleanup().await;
}

/// The extension frame's WebSocket connects with `Origin: null` and no
/// cookies; on the capability lane the tenant-origin check does not
/// apply and the upgrade bridges.
#[tokio::test]
async fn extension_capability_websocket_bridges_with_null_origin() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message as TgMessage;

    let app = TestApp::new().await;
    let uid = Uuid::new_v4();

    async fn echo(ws: axum::extract::WebSocketUpgrade) -> axum::response::Response {
        ws.on_upgrade(|mut socket| async move {
            if let Some(Ok(axum::extract::ws::Message::Text(s))) = socket.recv().await {
                let _ = socket
                    .send(axum::extract::ws::Message::Text(format!("echo:{s}").into()))
                    .await;
            }
            let _ = socket.close().await;
        })
    }
    let socket_path = ext_path("/socket");
    let upstream = Router::new().route(&socket_path, axum::routing::get(echo));
    app.register_tunnel("alice", "blog", uid, upstream).await;

    let host = host_for("alice");
    let proxy_addr = serve_router_real(app.router.clone()).await;
    let url = format!("ws://{proxy_addr}{socket_path}");
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert(header::HOST, HeaderValue::from_str(&host).unwrap());
    req.headers_mut()
        .insert(header::ORIGIN, HeaderValue::from_static("null"));

    let (mut client_ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    client_ws
        .send(TgMessage::Text("doom".into()))
        .await
        .unwrap();
    let echoed = client_ws.next().await.expect("frame").expect("ws ok");
    match echoed {
        TgMessage::Text(s) => assert_eq!(s, "echo:doom"),
        other => panic!("unexpected: {other:?}"),
    }
    let _ = client_ws.close(None).await;
    app.cleanup().await;
}
