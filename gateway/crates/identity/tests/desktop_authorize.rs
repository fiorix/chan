//! Integration tests for `/desktop/authorize`.
//!
//! Each test gets its own throwaway Postgres schema (for
//! tower-sessions + api_tokens) and wiremock mocks for profile + the
//! GitHub OAuth endpoints. Exercises the full loopback + PKCE flow:
//!
//!   * unauthenticated bounce → `/`
//!   * OAuth completion → `/desktop/authorize/consent`
//!   * consent page render (CSRF nonce, security headers)
//!   * allow / deny POST → 200 handoff page navigating to
//!     `http://127.0.0.1:<port>/auth/callback?code=...&state=...` (meta
//!     refresh + fallback link); neither the query nor the page ever
//!     carries the PAT secret
//!   * redeem: `{code, code_verifier}` → PAT once; replayed, unknown,
//!     and wrong-verifier → 410
//!   * audit rows record `created_via_desktop` + `desktop.redeem`

#[path = "../../../tests-shared/pg_reaper.rs"]
mod pg_reaper;

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::json;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower::ServiceExt;
use tower_sessions_sqlx_store::PostgresStore;
use url::Url;
use uuid::Uuid;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use identity::api_tokens::{ApiTokenService, RequestMeta};
use identity::config::Config;
use identity::http;
use identity::profile_client::ProfileClient;
use identity::providers::github::{GitHubEndpoints, GitHubProvider};

const PROFILE_TOKEN: &str = "test-profile-token";

async fn admin_pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await
        .expect("connect admin")
}

struct TestApp {
    router: Router,
    api_tokens: ApiTokenService,
    schema: String,
    admin_url: String,
    profile: MockServer,
    github: MockServer,
}

impl TestApp {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must be set; e.g. postgres://localhost/chan_gateway_test");
        pg_reaper::reap_idle(&url).await;
        let schema = format!("t_{}", Uuid::new_v4().simple());

        let admin = admin_pool(&url).await;
        sqlx::query(&format!("CREATE SCHEMA \"{schema}\""))
            .execute(&admin)
            .await
            .expect("create schema");
        admin.close().await;

        let s = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(move |conn, _meta| {
                let s = s.clone();
                Box::pin(async move {
                    sqlx::query(&format!("SET search_path TO \"{s}\", public"))
                        .execute(conn)
                        .await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .expect("connect pool");

        let store = PostgresStore::new(pool.clone());
        store.migrate().await.expect("migrate sessions");

        let profile = MockServer::start().await;
        let github = MockServer::start().await;

        let profile_url: Url = profile.uri().parse().unwrap();
        let profile_client =
            ProfileClient::new(profile_url, PROFILE_TOKEN.into()).expect("profile client");

        let github_endpoints = GitHubEndpoints {
            auth: format!("{}/login/oauth/authorize", github.uri()),
            token: format!("{}/login/oauth/access_token", github.uri()),
            user: format!("{}/user", github.uri()),
            emails: format!("{}/user/emails", github.uri()),
        };
        let provider = GitHubProvider::with_endpoints(
            "client-id".into(),
            "client-secret".into(),
            github_endpoints,
        )
        .expect("github provider");

        let base_url: Url = "http://localhost:7000/".parse().unwrap();

        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .expect("migrate identity tables");

        let api_tokens = ApiTokenService::new(pool.clone());

        let cfg = Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            internal_bind_addr: "127.0.0.1:0".parse().unwrap(),
            base_url,
            devserver_proxy_origin: "https://proxy.example.test".parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
            database_url: url.clone(),
            cookie_secure: true,
            profile_client,
            internal_auth_token: "test-internal".to_string(),
            session_internal_auth_token: "test-session-internal".to_string(),
            identity_admin_token: String::new(),
            account_admin_token: String::new(),
            workspace_admin: gateway_common::devserver_control_client::DevserverControlClient::new(
                "http://127.0.0.1:7002".parse().unwrap(),
                "test-identity-admin-token".into(),
            )
            .unwrap(),
            admission_lease_verifier: {
                let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                devserver_control_proto::AdmissionLeaseVerifier::from_base64(
                    &signer.verifying_key_base64(),
                )
                .unwrap()
            },
            entry_signer: gateway_common::devserver_gate::EntrySigner::from_base64(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap(),
            providers: vec![Arc::new(provider)],
        });

        let router = http::router(
            cfg,
            store,
            api_tokens.clone(),
            identity::token_throttle::TokenThrottle::new(),
        );

        Self {
            router,
            api_tokens,
            schema,
            admin_url: url,
            profile,
            github,
        }
    }

    async fn cleanup(self) {
        let admin = admin_pool(&self.admin_url).await;
        let _ = sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema))
            .execute(&admin)
            .await;
        admin.close().await;
    }

    /// Insert a row in `users` with `id`. Mirrors what
    /// profile-service would have done so the api_tokens FK to users
    /// resolves on PAT create.
    async fn insert_user(&self, id: Uuid, email: &str) {
        let url = self.admin_url.clone();
        let s = self.schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .after_connect(move |conn, _meta| {
                let s = s.clone();
                Box::pin(async move {
                    sqlx::query(&format!("SET search_path TO \"{s}\", public"))
                        .execute(conn)
                        .await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .expect("connect for insert_user");
        sqlx::query(
            "INSERT INTO users (id, email, username) VALUES \
             ($1, $2, 'u' || substr(replace($1::text, '-', ''), 1, 12))",
        )
        .bind(id)
        .bind(email)
        .execute(&pool)
        .await
        .expect("insert user row");
        pool.close().await;
    }
}

/// Stateful client that keeps the session cookie across calls.
struct Client<'a> {
    app: &'a TestApp,
    cookie: Option<String>,
}

impl<'a> Client<'a> {
    fn new(app: &'a TestApp) -> Self {
        Self { app, cookie: None }
    }

    async fn send(
        &mut self,
        method: Method,
        uri: &str,
        content_type: Option<&str>,
        body: Body,
    ) -> Sent {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(c) = &self.cookie {
            builder = builder.header(header::COOKIE, c.clone());
        }
        if let Some(ct) = content_type {
            builder = builder.header(header::CONTENT_TYPE, ct);
        }
        let req = builder.body(body).unwrap();
        let res = self.app.router.clone().oneshot(req).await.unwrap();
        let status = res.status();

        if let Some(set_cookie) = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .next()
            .and_then(|v| v.to_str().ok())
        {
            let pair = set_cookie.split(';').next().unwrap_or("").to_string();
            self.cookie = Some(pair);
        }
        let location = res
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let headers: Vec<(String, String)> = res
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
        Sent {
            status,
            location,
            headers,
            body: bytes.to_vec(),
        }
    }

    async fn get(&mut self, uri: &str) -> Sent {
        self.send(Method::GET, uri, None, Body::empty()).await
    }

    async fn post_form(&mut self, uri: &str, fields: &[(&str, &str)]) -> Sent {
        let encoded: String = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish();
        self.send(
            Method::POST,
            uri,
            Some("application/x-www-form-urlencoded"),
            Body::from(encoded),
        )
        .await
    }

    async fn post_json(&mut self, uri: &str, body: &serde_json::Value) -> Sent {
        self.send(
            Method::POST,
            uri,
            Some("application/json"),
            Body::from(body.to_string()),
        )
        .await
    }
}

struct Sent {
    status: StatusCode,
    location: String,
    #[allow(dead_code)]
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Sent {
    fn body_str(&self) -> &str {
        std::str::from_utf8(&self.body).expect("utf8 body")
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn extract_oauth_state(authorize_url: &str) -> String {
    let u = Url::parse(authorize_url).unwrap();
    u.query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .expect("state param")
}

/// Parse a `http://127.0.0.1:<port>/auth/callback?k=v&k2=v2` loopback
/// callback query into a map.
fn parse_callback_query(url: &str) -> std::collections::HashMap<String, String> {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

/// Pull the CSRF token out of the consent page HTML.
fn extract_csrf(html: &str) -> String {
    let needle = r#"name="csrf" value=""#;
    let start = html.find(needle).expect("csrf input present");
    let after = &html[start + needle.len()..];
    let end = after.find('"').expect("csrf value closes");
    after[..end].to_string()
}

/// Pull the loopback callback target out of the handoff page HTML and
/// assert it appears exactly twice (the meta refresh + the fallback
/// link). The attribute-escaped URL can only contain `&amp;` entities
/// (percent-encoding covers every other breaker), so unescaping is a
/// single replace.
fn extract_handoff_url(html: &str) -> String {
    let needle = r#"href="http://127.0.0.1"#;
    let start = html.find(needle).expect("handoff link present");
    let after = &html[start + r#"href=""#.len()..];
    let end = after.find('"').expect("href value closes");
    let escaped = &after[..end];
    assert_eq!(
        html.matches(escaped).count(),
        2,
        "the target rides the meta refresh AND the link: {html}"
    );
    escaped.replace("&amp;", "&")
}

/// Workspace an end-to-end OAuth callback so the test client ends up
/// holding an authenticated session cookie tied to `user_id`.
async fn happy_login(app: &TestApp, c: &mut Client<'_>, user_id: Uuid, email: &str) {
    let resp = c.get("/auth/github").await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let state = extract_oauth_state(&resp.location);

    Mock::given(method("POST"))
        .and(path("/login/oauth/access_token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "gh-access",
            "token_type": "Bearer",
            "scope": "read:user,user:email",
        })))
        .mount(&app.github)
        .await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 999,
            "login": "octocat",
            "name": "Octo Cat",
            "email": email,
        })))
        .mount(&app.github)
        .await;

    let now = chrono::Utc::now().to_rfc3339();
    let user_body = json!({
        "id": user_id,
        "email": email,
        "display_name": "Octo Cat",
        "username": format!("u{}", &user_id.simple().to_string()[..12]),
        "username_edits": 0,
        "created_at": now,
        "updated_at": now,
    });
    Mock::given(method("POST"))
        .and(path("/v1/users/upsert-by-identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": user_body.clone(),
            "user_created": true,
            "identity_created": true,
        })))
        .mount(&app.profile)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{user_id}/grants/claim")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"claimed": 0})))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{user_id}/flags")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"oauth_login": true})))
        .mount(&app.profile)
        .await;

    let resp = c
        .get(&format!("/auth/github/callback?code=fake&state={state}"))
        .await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER, "callback should 303");
}

/// Stand up the `GET /v1/users/{uid}` mock so /desktop/authorize and
/// the consent / confirm handlers can look the user up. `blocked`
/// controls the response shape: blocked sets `blocked_at` to now.
async fn mock_get_user(app: &TestApp, user_id: Uuid, email: &str, blocked: bool) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{user_id}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(user_json(user_id, email, blocked)))
        .mount(&app.profile)
        .await;
}

/// [`mock_get_user`] capped at `n` responses; once exhausted the next
/// matching mock serves, so a test can flip the user's blocked state
/// mid-flow without depending on wiremock mount precedence.
async fn mock_get_user_up_to(app: &TestApp, user_id: Uuid, email: &str, blocked: bool, n: u64) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{user_id}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(user_json(user_id, email, blocked)))
        .up_to_n_times(n)
        .mount(&app.profile)
        .await;
}

/// The profile-service user body both `mock_get_user*` helpers serve.
fn user_json(user_id: Uuid, email: &str, blocked: bool) -> serde_json::Value {
    let now = chrono::Utc::now().to_rfc3339();
    let mut body = json!({
        "id": user_id,
        "email": email,
        "display_name": "Octo Cat",
        "username": format!("u{}", &user_id.simple().to_string()[..12]),
        "username_edits": 0,
        "created_at": now,
        "updated_at": now,
    });
    if blocked {
        body["blocked_at"] = json!(chrono::Utc::now().to_rfc3339());
        body["block_reason"] = json!("admin action");
    }
    body
}

/// RFC 7636 Appendix B known vector. The matching challenge
/// `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM ==
/// base64url(SHA256(PKCE_VERIFIER))` rides the AUTH_URI query strings;
/// the gateway recomputes and constant-time compares at redeem.
const PKCE_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

/// A valid loopback callback the desktop listener would bind, plus the
/// PKCE challenge + S256 method.
const AUTH_URI: &str = "/desktop/authorize?\
                        redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
                        state=desktop-nonce-1&\
                        label=chan-desktop+%40+host&\
                        code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
                        code_challenge_method=S256&\
                        scopes=tunnel&\
                        expires_in=2592000";

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[tokio::test]
async fn unauthenticated_bounces_to_root() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let resp = c.get(AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    assert_eq!(resp.location, "/");
    app.cleanup().await;
}

#[tokio::test]
async fn bad_redirect_uri_returns_400() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let resp = c
        .get(
            "/desktop/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb&\
             state=x&label=x&\
             code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
             code_challenge_method=S256&expires_in=10",
        )
        .await;
    assert_eq!(resp.status, StatusCode::BAD_REQUEST);
    app.cleanup().await;
}

#[tokio::test]
async fn oauth_bounce_lands_on_consent() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;

    // First: hit /desktop/authorize unauthenticated. Stashes params
    // and 303s to /. The session cookie now carries the pending
    // authorize, which auth_callback will pick up.
    let resp = c.get(AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    assert_eq!(resp.location, "/");

    happy_login_resume(&app, &mut c, uid, "octo@example.com").await;
    app.cleanup().await;
}

#[tokio::test]
async fn full_flow_mints_pat_with_desktop_audit_action() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;

    happy_login(&app, &mut c, uid, "octo@example.com").await;
    // Authed GET /desktop/authorize -> 303 /desktop/authorize/consent
    mock_get_user(&app, uid, "octo@example.com", false).await;
    let resp = c.get(AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    assert_eq!(resp.location, "/desktop/authorize/consent");

    // Consent page renders with CSRF + security headers.
    let resp = c.get("/desktop/authorize/consent").await;
    assert_eq!(resp.status, StatusCode::OK);
    let html = resp.body_str();
    let csrf = extract_csrf(html);
    assert!(!csrf.is_empty(), "csrf token present");
    assert_eq!(resp.header("x-frame-options"), Some("DENY"));
    assert_eq!(resp.header("cache-control"), Some("no-store"));
    let csp = resp.header("content-security-policy").unwrap();
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(csp.contains("img-src 'self'"), "{csp}");

    // Authorize: a 200 handoff page, NOT a redirect. The ruling binds
    // this confirm response specifically -- a 3xx off this form POST
    // would put the loopback hop under form-action. It does not bind the
    // desktop's loopback answer, which is a GET outside any form chain
    // and does redirect, back to this origin's profile page.
    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert!(
        resp.location.is_empty(),
        "no Location header on the handoff"
    );
    assert_eq!(resp.header("x-frame-options"), Some("DENY"));
    assert_eq!(resp.header("cache-control"), Some("no-store"));
    assert_eq!(resp.header("referrer-policy"), Some("no-referrer"));
    let csp = resp.header("content-security-policy").unwrap();
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(csp.contains("img-src 'self'"), "{csp}");
    let url = extract_handoff_url(resp.body_str());
    let query = parse_callback_query(&url);
    assert!(url.starts_with("http://127.0.0.1:54321/auth/callback?"));
    assert!(
        !url.contains('#'),
        "loopback delivery is a query, not a fragment"
    );
    assert_eq!(
        query.get("state").map(String::as_str),
        Some("desktop-nonce-1")
    );
    // label/expires_at ride the redeem response, never the callback query.
    assert!(!query.contains_key("label"), "no label in the query: {url}");

    // The query carries a one-time code and NEVER the credential; the
    // handoff page as a whole is grep-clean of the secret.
    assert!(!query.contains_key("secret"), "no secret key: {url}");
    assert!(!query.contains_key("id"), "no id key: {url}");
    let code = query.get("code").expect("code in query").clone();
    assert!(!code.is_empty());
    let html = resp.body_str();
    assert!(!html.contains("chan_pat_"), "PAT leaked into the handoff");
    assert!(!html.contains("secret="), "secret key in the handoff");

    // Redeem code + verifier: 200 exactly once, with the working PAT.
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let redeemed: serde_json::Value = serde_json::from_slice(&resp.body).expect("redeem json");
    let secret = redeemed["secret"].as_str().expect("secret string");
    assert!(secret.starts_with("chan_pat_"), "{redeemed}");
    assert_eq!(redeemed["label"], "chan-desktop @ host");
    assert!(
        redeemed["expires_at"].is_string(),
        "expires_in was requested, so the key carries a timestamp: {redeemed}"
    );
    let token_id: Uuid = redeemed["id"].as_str().unwrap().parse().expect("uuid id");

    // The redeemed PAT works through the normal validation path.
    let validated = app
        .api_tokens
        .validate(secret, &RequestMeta::default())
        .await
        .expect("redeemed PAT validates");
    assert_eq!(validated.user_id, uid);
    assert_eq!(validated.token_id, token_id);

    // A replay of the same code is 410 with an error body.
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::GONE);
    let body: serde_json::Value = serde_json::from_slice(&resp.body).expect("error json");
    assert!(body["error"].is_string(), "{body}");

    // Audit trail: the desktop mint, the redemption, the validate.
    let entries = app
        .api_tokens
        .audit(uid, token_id, 10)
        .await
        .expect("audit");
    let mut actions: Vec<_> = entries.iter().map(|e| e.action.as_str()).collect();
    actions.sort_unstable();
    assert_eq!(
        actions,
        vec!["created_via_desktop", "desktop.redeem", "used"]
    );

    app.cleanup().await;
}

#[tokio::test]
async fn redeem_unknown_code_is_410() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": "no-such-code", "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::GONE);
    let body: serde_json::Value = serde_json::from_slice(&resp.body).expect("error json");
    assert!(body["error"].is_string(), "{body}");
    app.cleanup().await;
}

#[tokio::test]
async fn deny_returns_user_cancelled_and_does_not_mint() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;

    let resp = c.get(AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let resp = c.get("/desktop/authorize/consent").await;
    let csrf = extract_csrf(resp.body_str());

    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "deny")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert!(resp.body_str().contains("Request cancelled"), "deny copy");
    let url = extract_handoff_url(resp.body_str());
    let query = parse_callback_query(&url);
    assert_eq!(
        query.get("error").map(String::as_str),
        Some("user_cancelled")
    );
    assert_eq!(
        query.get("state").map(String::as_str),
        Some("desktop-nonce-1")
    );
    // No PAT rows for this user.
    let pool = app.api_tokens.list(uid).await.expect("list");
    assert!(pool.is_empty(), "deny must not mint a token");
    app.cleanup().await;
}

#[tokio::test]
async fn blocked_on_confirm_renders_error_handoff() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    // The user is unblocked through authorize + consent (two lookups),
    // then blocked by the time they click Authorize. Exhaustion (not
    // mount order) hands the third lookup to the blocked mock.
    mock_get_user_up_to(&app, uid, "octo@example.com", false, 2).await;
    mock_get_user(&app, uid, "octo@example.com", true).await;

    let resp = c.get(AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let resp = c.get("/desktop/authorize/consent").await;
    assert_eq!(resp.status, StatusCode::OK);
    let csrf = extract_csrf(resp.body_str());

    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    assert!(resp.body_str().contains("Sign-in failed"), "error copy");
    let url = extract_handoff_url(resp.body_str());
    let query = parse_callback_query(&url);
    assert_eq!(
        query.get("error").map(String::as_str),
        Some("account_blocked")
    );
    // No PAT was minted for the blocked user.
    let tokens = app.api_tokens.list(uid).await.expect("list");
    assert!(tokens.is_empty(), "blocked allow must not mint a token");
    app.cleanup().await;
}

#[tokio::test]
async fn csrf_mismatch_returns_400_and_clears_pending() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;

    let _ = c.get(AUTH_URI).await;
    let _ = c.get("/desktop/authorize/consent").await;

    // POST with a bogus CSRF.
    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", "not-the-real-csrf"), ("action", "allow")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::BAD_REQUEST);

    // Pending is cleared: a retry without re-running /desktop/authorize
    // 400s instead of minting against a stale stash.
    let resp = c.get("/desktop/authorize/consent").await;
    assert_eq!(resp.status, StatusCode::BAD_REQUEST);
    app.cleanup().await;
}

/// Smaller variant of `happy_login` used when the test client already
/// has a pending `/desktop/authorize` stashed in its session and we
/// just want to confirm `auth_callback` redirects to the consent page
/// instead of `/`.
async fn happy_login_resume(app: &TestApp, c: &mut Client<'_>, user_id: Uuid, email: &str) {
    let resp = c.get("/auth/github").await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let state = extract_oauth_state(&resp.location);

    Mock::given(method("POST"))
        .and(path("/login/oauth/access_token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "gh-access",
            "token_type": "Bearer",
            "scope": "read:user,user:email",
        })))
        .mount(&app.github)
        .await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 999,
            "login": "octocat",
            "name": "Octo Cat",
            "email": email,
        })))
        .mount(&app.github)
        .await;
    let now = chrono::Utc::now().to_rfc3339();
    Mock::given(method("POST"))
        .and(path("/v1/users/upsert-by-identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": {
                "id": user_id,
                "email": email,
                "display_name": "Octo Cat",
                "username": format!("u{}", &user_id.simple().to_string()[..12]),
                "username_edits": 0,
                "created_at": now,
                "updated_at": now,
            },
            "user_created": true,
            "identity_created": true,
        })))
        .mount(&app.profile)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{user_id}/grants/claim")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"claimed": 0})))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{user_id}/flags")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"oauth_login": true})))
        .mount(&app.profile)
        .await;

    let resp = c
        .get(&format!("/auth/github/callback?code=fake&state={state}"))
        .await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    // The hook in auth_callback redirects to the consent page, not /.
    assert_eq!(resp.location, "/desktop/authorize/consent");
}

// ---------------------------------------------------------------
// Account-mode flow + legacy scope regression
// ---------------------------------------------------------------

/// AUTH query for the account-mode flow: the sole desktop.account
/// scope (Contract A).
const AUTH_URI_ACCOUNT: &str = "/desktop/authorize?\
                                redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
                                state=desktop-nonce-3&\
                                label=chan-desktop+%40+host&\
                                code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
                                code_challenge_method=S256&\
                                scopes=desktop.account&\
                                expires_in=2592000";

/// AUTH query with the legacy scope pair shipped desktops send.
const AUTH_URI_CONNECT: &str = "/desktop/authorize?\
                                redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
                                state=desktop-nonce-2&\
                                label=chan-desktop+%40+host&\
                                code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
                                code_challenge_method=S256&\
                                scopes=tunnel%2Cdesktop.connect&\
                                expires_in=2592000";

#[tokio::test]
async fn account_flow_mints_account_pat_and_no_devserver_row() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;

    // Contract A: the account PAT mints NO devservers row. Verified
    // at MockServer drop: zero calls to the profile registration.
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/devservers")))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&app.profile)
        .await;

    let resp = c.get(AUTH_URI_ACCOUNT).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let resp = c.get("/desktop/authorize/consent").await;
    assert_eq!(resp.status, StatusCode::OK);
    let html = resp.body_str().to_string();
    let csrf = extract_csrf(&html);
    // The account consent: the exposure-framed copy is present, the
    // picker is gone.
    assert!(
        html.contains(
            "Approving gives this application account-level access to \
             this gateway for 30 days: it can list your devservers and devservers shared \
             with you, and mint access to them."
        ),
        "{html}"
    );
    assert!(!html.contains(r#"type="radio""#), "{html}");
    assert!(!html.contains(r#"name="devserver""#), "{html}");

    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let url = extract_handoff_url(resp.body_str());
    let query = parse_callback_query(&url);
    let code = query.get("code").expect("code in query").clone();
    // The query never carries devserver_* keys, not even empty ones.
    assert!(!query.keys().any(|k| k.starts_with("devserver_")), "{url}");

    // The redeemed PAT carries exactly the account scope.
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let redeemed: serde_json::Value = serde_json::from_slice(&resp.body).expect("redeem json");
    let secret = redeemed["secret"].as_str().expect("secret string");
    let validated = app
        .api_tokens
        .validate(secret, &RequestMeta::default())
        .await
        .expect("account PAT validates");
    assert_eq!(validated.scopes, vec!["desktop.account".to_string()]);
    app.cleanup().await;
}

#[tokio::test]
async fn legacy_connect_flow_still_mints_and_registers() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;

    // The tunnel scope keeps registering the 1-token:1-devserver row
    // exactly once (shipped-desktop back-compat).
    let now = chrono::Utc::now().to_rfc3339();
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/devservers")))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": Uuid::new_v4(),
            "owner_user_id": uid,
            "devserver_id": "a".repeat(64),
            "label": "chan-desktop @ host",
            "created_at": now,
        })))
        .expect(1)
        .mount(&app.profile)
        .await;

    let resp = c.get(AUTH_URI_CONNECT).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let resp = c.get("/desktop/authorize/consent").await;
    assert_eq!(resp.status, StatusCode::OK);
    let html = resp.body_str().to_string();
    let csrf = extract_csrf(&html);
    // No picker on the legacy consent either, and no account copy.
    assert!(!html.contains(r#"type="radio""#), "{html}");
    assert!(!html.contains("access to your account"), "{html}");

    // A client may still POST a devserver pick; the unmodeled field
    // is ignored, the mint proceeds, and the fragment carries no
    // devserver_* keys.
    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[
                ("csrf", &csrf),
                ("action", "allow"),
                ("devserver", &format!("bob:{}", "b".repeat(64))),
            ],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let url = extract_handoff_url(resp.body_str());
    let query = parse_callback_query(&url);
    assert!(query.contains_key("code"), "{url}");
    assert!(!query.keys().any(|k| k.starts_with("devserver_")), "{url}");

    // The minted PAT carries the legacy scope pair.
    let tokens = app.api_tokens.list(uid).await.expect("list");
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0].scopes, vec!["tunnel", "desktop.connect"]);
    app.cleanup().await;
}

#[tokio::test]
async fn account_scope_mixed_with_tunnel_is_400_at_the_door() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let resp = c
        .get(
            "/desktop/authorize?\
             redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
             state=x&label=x&\
             code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
             code_challenge_method=S256&\
             scopes=desktop.account%2Ctunnel&expires_in=10",
        )
        .await;
    assert_eq!(resp.status, StatusCode::BAD_REQUEST);
    app.cleanup().await;
}

#[tokio::test]
async fn redeem_wrong_verifier_is_410() {
    // A valid, freshly minted code presented with a verifier whose
    // S256 hash does not equal the stored challenge is 410 --
    // indistinguishable from an unknown code (PKCE closes the naive
    // stolen-code injection).
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;

    let resp = c.get(AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let resp = c.get("/desktop/authorize/consent").await;
    let csrf = extract_csrf(resp.body_str());
    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let url = extract_handoff_url(resp.body_str());
    let code = parse_callback_query(&url)
        .get("code")
        .expect("code in query")
        .clone();

    // Wrong verifier -> 410.
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": "the-wrong-verifier" }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::GONE);
    // The code was consumed on the miss, so the RIGHT verifier now also
    // 410s (single-use).
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::GONE);
    app.cleanup().await;
}

#[tokio::test]
async fn state_with_specials_round_trips_through_the_loopback_url() {
    // A state carrying `&`, `#`, `=`, a space, and a newline survives
    // as one opaque parameter through the authorize -> handoff ->
    // callback-query path.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;

    let hostile_state = "a&b#c=d e\nf";
    let encoded_state: String =
        url::form_urlencoded::byte_serialize(hostile_state.as_bytes()).collect();
    let auth_uri = format!(
        "/desktop/authorize?\
         redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
         state={encoded_state}&label=chan-desktop+%40+host&\
         code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
         code_challenge_method=S256&scopes=tunnel&expires_in=2592000"
    );

    let resp = c.get(&auth_uri).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let resp = c.get("/desktop/authorize/consent").await;
    let csrf = extract_csrf(resp.body_str());
    let resp = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let url = extract_handoff_url(resp.body_str());
    let query = parse_callback_query(&url);
    assert_eq!(query.get("state").map(String::as_str), Some(hostile_state));
    app.cleanup().await;
}
