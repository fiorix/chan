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
//!   * self-revoke: `DELETE /desktop/v1/token` revokes the presented PAT
//!     and nothing else, keeps its row and audit under its own action,
//!     cuts the owner's live surface only when the PAT was used, refuses
//!     a session alone, and answers every invalid bearer as the PAT auth
//!     does

#[path = "../../../tests-shared/identity_config.rs"]
mod identity_config;
#[path = "../../../tests-shared/identity_db.rs"]
mod test_db;

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use identity::api_tokens::{ApiTokenService, RequestMeta};
use identity::config::Config;
use identity::devserver_control_client::DevserverControlClient;
use identity::http;
use identity::profile_client::ProfileClient;
use identity::providers::github::{GitHubEndpoints, GitHubProvider};

const PROFILE_TOKEN: &str = "test-profile-token";

struct TestApp {
    router: Router,
    api_tokens: ApiTokenService,
    pool: PgPool,
    schema: String,
    admin_url: String,
    profile: MockServer,
    /// devserver-control's admin API, where a revoke's first cut lands.
    control: MockServer,
    github: MockServer,
}

impl TestApp {
    async fn new() -> Self {
        Self::with_wireguard(None).await
    }

    async fn with_wireguard(wireguard: Option<identity::wireguard::WireguardEnrollment>) -> Self {
        let (url, schema, pool, store) =
            test_db::create_schema(test_db::MigrationOrder::SessionsFirst).await;

        let profile = MockServer::start().await;
        let control = MockServer::start().await;
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

        let api_tokens = ApiTokenService::new(pool.clone());

        let cfg = Arc::new(Config {
            base_url,
            wireguard,
            providers: vec![Arc::new(provider)],
            workspace_admin: DevserverControlClient::new(
                control.uri().parse().unwrap(),
                "test-identity-admin-token".into(),
            )
            .unwrap(),
            ..identity_config::test_config(&url, profile_client)
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
            pool,
            schema,
            admin_url: url,
            profile,
            control,
            github,
        }
    }

    async fn cleanup(self) {
        self.pool.close().await;
        test_db::pg::drop_schema(&self.admin_url, &self.schema).await;
    }

    /// Insert a row in `users` with `id`. Mirrors what
    /// profile-service would have done so the api_tokens FK to users
    /// resolves on PAT create.
    async fn insert_user(&self, id: Uuid, email: &str) {
        let pool = test_db::pg::schema_pool(&self.admin_url, &self.schema, 1).await;
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

#[tokio::test]
async fn redemption_audit_failure_still_delivers_the_pat_once() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "octo@example.com").await;
    happy_login(&app, &mut c, uid, "octo@example.com").await;
    mock_get_user(&app, uid, "octo@example.com", false).await;
    assert_eq!(c.get(AUTH_URI).await.status, StatusCode::SEE_OTHER);
    let consent = c.get("/desktop/authorize/consent").await;
    let csrf = extract_csrf(consent.body_str());
    let handoff = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(handoff.status, StatusCode::OK);
    let query = parse_callback_query(&extract_handoff_url(handoff.body_str()));
    let code = query.get("code").unwrap();
    sqlx::query("ALTER TABLE api_token_audit ADD CONSTRAINT reject_redeem CHECK (action <> 'desktop.redeem')")
        .execute(&app.pool).await.unwrap();
    let body = json!({"code":code, "code_verifier":PKCE_VERIFIER});
    let response = c.post_json("/desktop/authorize/redeem", &body).await;
    assert_eq!(response.status, StatusCode::OK);
    let redeemed: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    let secret = redeemed["secret"].as_str().unwrap();
    assert!(app.api_tokens.validate_no_audit(secret).await.is_ok());
    assert_eq!(
        c.post_json("/desktop/authorize/redeem", &body).await.status,
        StatusCode::GONE
    );
    app.cleanup().await;
}
#[tokio::test]
async fn wireguard_authorize_requires_valid_keys_and_an_enrollment_offer() {
    use base64::Engine;
    let app = TestApp::new().await;
    let key = base64::engine::general_purpose::STANDARD.encode([7; 32]);
    let invalid = [
        key[..43].to_owned(),
        format!("{key}="),
        "!".repeat(44),
        base64::engine::general_purpose::STANDARD.encode([7; 31]),
    ];
    let mut client = Client::new(&app);
    for (key, expected) in invalid
        .iter()
        .map(|key| (key, "invalid wireguard_public_key"))
        .chain([(&key, "wireguard enrollment not offered")])
    {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("wireguard_public_key", key)
            .finish();
        let response = client.get(&format!("{AUTH_URI}&{query}")).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&response.body).unwrap(),
            json!({"error":expected})
        );
    }
    app.cleanup().await;
}

fn wireguard_enrollment() -> identity::wireguard::WireguardEnrollment {
    use base64::Engine;
    identity::wireguard::WireguardEnrollment {
        host_id: "p1".into(),
        endpoint: "wg.example.test:51820".into(),
        public_key: base64::engine::general_purpose::STANDARD.encode([9; 32]),
        allowed_ips: vec!["10.7.0.1/32".into(), "fd00:7::1/128".into()],
        persistent_keepalive: Some(25),
        hosts: vec![identity::wireguard::HostRoute {
            name: "*.proxy.example.test".into(),
            addresses: vec!["10.7.0.1".parse().unwrap(), "fd00:7::1".parse().unwrap()],
        }],
    }
}

async fn consent_with_wireguard(app: &TestApp, client: &mut Client<'_>, uid: Uuid) -> String {
    use base64::Engine;
    let email = "wireguard@example.com";
    app.insert_user(uid, email).await;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair(
            "wireguard_public_key",
            &base64::engine::general_purpose::STANDARD.encode([7; 32]),
        )
        .finish();
    let response = client
        .get(&format!(
            "{}&{query}",
            AUTH_URI.replace("scopes=tunnel", "scopes=desktop.account")
        ))
        .await;
    assert_eq!(response.status, StatusCode::SEE_OTHER);
    assert_eq!(response.location, "/");
    happy_login_resume(app, client, uid, email).await;
    mock_get_user(app, uid, email, false).await;
    let response = client.get("/desktop/authorize/consent").await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.body_str().contains("WireGuard key"));
    assert!(response.body_str().contains("wg.example.test:51820"));
    extract_csrf(response.body_str())
}

#[tokio::test]
async fn full_flow_with_a_wireguard_key_enrolls_the_peer_and_returns_its_parameters() {
    use base64::Engine;
    let config = wireguard_enrollment();
    let app = TestApp::with_wireguard(Some(config.clone())).await;
    let uid = Uuid::new_v4();
    let mut client = Client::new(&app);
    let csrf = consent_with_wireguard(&app, &mut client, uid).await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/wireguard/peers")))
        .and(wiremock::matchers::header(
            "authorization",
            format!("Bearer {PROFILE_TOKEN}"),
        ))
        .respond_with(move |request: &wiremock::Request| {
            let body: serde_json::Value = request.body_json().unwrap();
            assert_eq!(body["host"], "p1");
            assert_eq!(
                body["public_key"],
                base64::engine::general_purpose::STANDARD.encode([7; 32])
            );
            assert_eq!(body.as_object().unwrap().len(), 3);
            ResponseTemplate::new(201).set_body_json(json!({
                "id":Uuid::new_v4(), "user_id":uid, "token_id":body["token_id"],
                "host":"p1", "public_key":body["public_key"],
                "addresses":["10.7.0.23/32", "fd00:7::23/128"],
                "created_at":"2026-01-01T00:00:00Z", "updated_at":"2026-01-01T00:00:00Z",
            }))
        })
        .expect(1)
        .mount(&app.profile)
        .await;
    let response = client
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let query = parse_callback_query(&extract_handoff_url(response.body_str()));
    assert!(!query.contains_key("error"));
    let code = query.get("code").unwrap();
    let response = client
        .post_json(
            "/desktop/authorize/redeem",
            &json!({"code":code, "code_verifier":PKCE_VERIFIER}),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let payload: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(
        payload["wireguard"],
        json!({
            "server_public_key":config.public_key, "endpoint":"wg.example.test:51820",
            "addresses":["10.7.0.23/32", "fd00:7::23/128"], "allowed_ips":["10.7.0.1/32", "fd00:7::1/128"],
            "persistent_keepalive":25, "hosts":[{"name":"*.proxy.example.test", "addresses":["10.7.0.1", "fd00:7::1"]}],
        })
    );
    let token: Uuid = payload["id"].as_str().unwrap().parse().unwrap();
    let rows = app.api_tokens.list(uid).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, token);
    assert!(rows[0].revoked_at.is_none());
    assert!(payload["secret"].as_str().unwrap().starts_with("chan_pat_"));
    let requests = app.profile.received_requests().await.unwrap();
    let enroll = requests
        .iter()
        .find(|request| request.url.path().ends_with("/wireguard/peers"))
        .unwrap();
    assert_eq!(
        enroll.body_json::<serde_json::Value>().unwrap()["token_id"],
        token.to_string()
    );
    let audits: Vec<String> =
        sqlx::query_scalar("SELECT action FROM api_token_audit WHERE token_id = $1 ORDER BY id")
            .bind(token)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    assert_eq!(audits, ["created_via_desktop", "desktop.redeem"]);
    assert_eq!(
        client
            .post_json(
                "/desktop/authorize/redeem",
                &json!({"code":code,"code_verifier":PKCE_VERIFIER})
            )
            .await
            .status,
        StatusCode::GONE
    );
    app.profile.verify().await;
    app.cleanup().await;
}

#[tokio::test]
async fn enroll_failure_revokes_the_pat_and_reports_wireguard_enroll_failed() {
    let app = TestApp::with_wireguard(Some(wireguard_enrollment())).await;
    let uid = Uuid::new_v4();
    let mut client = Client::new(&app);
    let csrf = consent_with_wireguard(&app, &mut client, uid).await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/wireguard/peers")))
        .respond_with(
            ResponseTemplate::new(409).set_body_json(json!({"error":"wireguard pool exhausted"})),
        )
        .expect(1)
        .mount(&app.profile)
        .await;
    let response = client
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let query = parse_callback_query(&extract_handoff_url(response.body_str()));
    assert_eq!(
        query.get("error").map(String::as_str),
        Some("wireguard_enroll_failed")
    );
    assert!(!query.contains_key("code"));
    let rows = app.api_tokens.list(uid).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].revoked_at.is_some());
    let audits: Vec<String> =
        sqlx::query_scalar("SELECT action FROM api_token_audit WHERE token_id = $1 ORDER BY id")
            .bind(rows[0].id)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    assert_eq!(audits, ["created_via_desktop", "revoked"]);
    let requests = app.profile.received_requests().await.unwrap();
    assert!(requests
        .iter()
        .any(|request| request.url.path().ends_with("/wireguard/peers")));
    assert!(!requests
        .iter()
        .any(|request| request.url.path().contains("revoke")));
    app.profile.verify().await;
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Desktop token self-revoke (`DELETE /desktop/v1/token`)
// ---------------------------------------------------------------

/// One request as a desktop or a browser sends it: `bearer` as the
/// `Authorization` header, `cookie` as the session, and an optional JSON
/// body. Answers the status and the body bytes.
async fn send_as(
    app: &TestApp,
    method: Method,
    uri: &str,
    bearer: Option<&str>,
    cookie: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(bearer) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let body = match body {
        Some(json) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let res = app
        .router
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, bytes.to_vec())
}

/// `DELETE /desktop/v1/token` presenting `bearer`, with no session.
async fn self_revoke(app: &TestApp, bearer: Option<&str>) -> (StatusCode, Vec<u8>) {
    send_as(app, Method::DELETE, "/desktop/v1/token", bearer, None, None).await
}

/// The answer the PAT auth gives a bearer identity has never minted, read
/// from the roster, the desktop's other PAT-only read.
async fn invalid_bearer_answer(app: &TestApp) -> (StatusCode, Vec<u8>) {
    let unknown = "chan_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    send_as(
        app,
        Method::GET,
        "/desktop/v1/devservers",
        Some(unknown),
        None,
        None,
    )
    .await
}

/// Mint a token for `uid` straight through the service, as the desktop
/// authorize flow and the operator mint do.
async fn mint(app: &TestApp, uid: Uuid, scopes: &[&str]) -> identity::api_tokens::CreatedToken {
    let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_string()).collect();
    app.api_tokens
        .create(
            identity::api_tokens::NewToken {
                user_id: uid,
                label: "chan-desktop @ host",
                expires_at: Some(chrono::Utc::now() + chrono::Duration::days(30)),
                scopes: &scopes,
                origin: identity::api_tokens::TokenOrigin::Desktop,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("mint")
}

/// Whether token `id` is still unrevoked in `api_tokens`; panics when the
/// row is gone, since a revoke must keep it.
async fn active(app: &TestApp, id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT revoked_at IS NULL FROM api_tokens WHERE id = $1")
        .bind(id)
        .fetch_one(&app.pool)
        .await
        .expect("the token row is kept")
}

/// Token `id`'s audit actions, sorted.
async fn audit_actions(app: &TestApp, id: Uuid) -> Vec<String> {
    let mut actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM api_token_audit WHERE token_id = $1")
            .bind(id)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    actions.sort_unstable();
    actions
}

/// The requests `server` received at `at`.
async fn received_at(server: &MockServer, at: &str) -> Vec<wiremock::Request> {
    server
        .received_requests()
        .await
        .expect("request recording is on")
        .into_iter()
        .filter(|request| request.url.path() == at)
        .collect()
}

/// The owner's revoke cut as it reaches the services: profile's revoke,
/// which reserves the durable cut, and devserver-control's first cut of the
/// owner's tunnels and of the sessions they are the subject of.
struct OwnerCut {
    profile_revoke: String,
    tunnel_kill: String,
}

impl OwnerCut {
    /// Answer `uid`'s cut for token `token_id` as profile and
    /// devserver-control answer it.
    async fn mount(app: &TestApp, uid: Uuid, token_id: Uuid) -> Self {
        Self::mount_answering(app, uid, token_id, ResponseTemplate::new(202)).await
    }

    /// [`Self::mount`], with profile's revoke answered by `profile`.
    async fn mount_answering(
        app: &TestApp,
        uid: Uuid,
        token_id: Uuid,
        profile: ResponseTemplate,
    ) -> Self {
        let cut = Self {
            profile_revoke: format!("/v1/users/{uid}/tokens/{token_id}/revoke"),
            tunnel_kill: format!("/admin/v1/owners/{uid}/tunnels/kill"),
        };
        Mock::given(method("POST"))
            .and(path(cut.profile_revoke.as_str()))
            .respond_with(profile)
            .mount(&app.profile)
            .await;
        Mock::given(method("POST"))
            .and(path(cut.tunnel_kill.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"killed": 1})))
            .mount(&app.control)
            .await;
        Mock::given(method("POST"))
            .and(path("/admin/v1/sessions/revoke"))
            .and(body_json(
                json!({"scope": "subject", "subject_user_id": uid}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "revoked": 1,
                "tenant_sessions_revoked": 1,
                "proxies_confirmed": 1,
                "proxies_expected": 1,
            })))
            .mount(&app.control)
            .await;
        cut
    }

    /// How many times each part of the cut was asked for: profile's
    /// revoke, the tunnel kill and the subject's session drain.
    async fn counts(&self, app: &TestApp) -> (usize, usize, usize) {
        (
            received_at(&app.profile, &self.profile_revoke).await.len(),
            received_at(&app.control, &self.tunnel_kill).await.len(),
            received_at(&app.control, "/admin/v1/sessions/revoke")
                .await
                .len(),
        )
    }

    /// [`Self::counts`] once they reach `expected`, or after ten seconds:
    /// a used token's cut runs after the give-back has answered.
    async fn settled(
        &self,
        app: &TestApp,
        expected: (usize, usize, usize),
    ) -> (usize, usize, usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let counts = self.counts(app).await;
            if counts == expected || tokio::time::Instant::now() >= deadline {
                return counts;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// A subscriber that keeps every formatted line, and the lines it kept.
fn capture_logs() -> (
    impl tracing::Subscriber + Send + Sync,
    Arc<std::sync::Mutex<Vec<u8>>>,
) {
    use std::io::Write;
    use std::sync::Mutex;
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let output = Arc::new(Mutex::new(Vec::new()));
    let writer = Capture(output.clone());
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    (subscriber, output)
}

/// Sign `uid` in and run the account-mode authorize, consent, confirm and
/// redeem through identity's own routes, as chan-desktop does. Answers the
/// redeemed token's id and secret; `c` keeps the browser session.
async fn redeem_account_pat(app: &TestApp, c: &mut Client<'_>, uid: Uuid) -> (Uuid, String) {
    let email = "selfrevoke@example.com";
    app.insert_user(uid, email).await;
    happy_login(app, c, uid, email).await;
    mock_get_user(app, uid, email, false).await;
    let resp = c.get(AUTH_URI_ACCOUNT).await;
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
    let query = parse_callback_query(&extract_handoff_url(resp.body_str()));
    let code = query.get("code").expect("code in query").clone();
    let resp = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(resp.status, StatusCode::OK);
    let redeemed: serde_json::Value = serde_json::from_slice(&resp.body).expect("redeem json");
    let id = redeemed["id"].as_str().unwrap().parse().expect("uuid id");
    (id, redeemed["secret"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn redeemed_pat_revokes_itself_and_keeps_its_row() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    let (token_id, secret) = redeem_account_pat(&app, &mut c, uid).await;
    let cut = OwnerCut::mount(&app, uid, token_id).await;

    let (status, body) = self_revoke(&app, Some(&secret)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());
    // Nothing presented the token before, so it opened nothing to cut.
    assert_eq!(cut.counts(&app).await, (0, 0, 0));

    // The account page reads the row back: kept, with `revoked_at` set,
    // and its audit ends in the desktop's own revoke action, not the
    // owner's. Nothing validated the token on the way, so there is no
    // `used` row.
    let cookie = c.cookie.clone().expect("browser session");
    let (status, body) = send_as(&app, Method::GET, "/api/tokens", None, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    let rows: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let rows = rows.as_array().expect("token list");
    assert_eq!(rows.len(), 1, "the row is kept: {rows:?}");
    assert_eq!(rows[0]["id"], json!(token_id));
    assert!(rows[0]["revoked_at"].is_string(), "{rows:?}");
    let (status, body) = send_as(
        &app,
        Method::GET,
        &format!("/api/tokens/{token_id}/audit"),
        None,
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let audit: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
    let mut actions: Vec<&str> = audit
        .iter()
        .map(|entry| entry["action"].as_str().unwrap())
        .collect();
    actions.sort_unstable();
    assert_eq!(
        actions,
        [
            "created_via_desktop",
            "desktop.redeem",
            "revoked_via_desktop"
        ]
    );

    // The token authenticates nothing any more, and revoking it again
    // gets exactly the answer an unknown bearer gets.
    let invalid = invalid_bearer_answer(&app).await;
    assert_eq!(invalid.0, StatusCode::UNAUTHORIZED);
    let roster = send_as(
        &app,
        Method::GET,
        "/desktop/v1/devservers",
        Some(&secret),
        None,
        None,
    )
    .await;
    assert_eq!(roster, invalid);
    let (status, _) = send_as(
        &app,
        Method::POST,
        "/desktop/v1/devserver/entry",
        Some(&secret),
        None,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(app.api_tokens.validate_no_audit(&secret).await.is_err());
    assert_eq!(self_revoke(&app, Some(&secret)).await, invalid);

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_touches_only_the_presented_token() {
    let app = TestApp::new().await;
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    app.insert_user(alice, "alice@example.com").await;
    app.insert_user(bob, "bob@example.com").await;
    let presented = mint(&app, alice, &["desktop.account"]).await;
    let sibling = mint(&app, alice, &["desktop.account"]).await;
    let foreign = mint(&app, bob, &["desktop.account"]).await;

    // A body naming other tokens is not read: the bearer alone is the
    // credential and the target.
    let (status, _) = send_as(
        &app,
        Method::DELETE,
        "/desktop/v1/token",
        Some(&presented.secret),
        None,
        Some(json!({
            "id": sibling.token.id,
            "ids": [sibling.token.id, foreign.token.id],
            "secret": foreign.secret,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!active(&app, presented.token.id).await);
    assert!(active(&app, sibling.token.id).await);
    assert!(active(&app, foreign.token.id).await);
    for other in [&sibling.secret, &foreign.secret] {
        app.api_tokens
            .validate_no_audit(other)
            .await
            .expect("an untouched token still authenticates");
    }

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_of_a_used_token_gets_the_owner_cut() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "used@example.com").await;
    let used = mint(&app, uid, &["desktop.account"]).await;
    let unused = mint(&app, uid, &["desktop.account"]).await;
    // A roster read presents the token, as an entry mint or a dial would:
    // each sets `last_used_at`.
    app.api_tokens
        .validate_no_audit(&used.secret)
        .await
        .expect("the token is live");
    let used_cut = OwnerCut::mount(&app, uid, used.token.id).await;
    let unused_cut = OwnerCut::mount(&app, uid, unused.token.id).await;

    let (status, body) = self_revoke(&app, Some(&used.secret)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());
    assert!(!active(&app, used.token.id).await);
    // Profile reserved its durable cut for the token, and the first cut of
    // the owner's tunnels and of the sessions they are the subject of ran.
    assert_eq!(used_cut.settled(&app, (1, 1, 1)).await, (1, 1, 1));
    let drain = &received_at(&app.control, "/admin/v1/sessions/revoke").await[0];
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&drain.body).unwrap(),
        json!({"scope": "subject", "subject_user_id": uid})
    );
    // The audit names the desktop's give-back, never the owner's revoke.
    // Profile is a stand-in here: that its revoke of a token already revoked
    // adds no audit row is pinned by profile's own
    // `identity_pat_revoke_atomically_denies_audits_and_reserves`.
    assert_eq!(
        audit_actions(&app, used.token.id).await,
        ["created_via_desktop", "revoked_via_desktop"]
    );

    // An unused token of the same owner is revoked with no cut at all: no
    // reservation for it, and no second tunnel kill or session drain.
    let (status, _) = self_revoke(&app, Some(&unused.secret)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!active(&app, unused.token.id).await);
    assert_eq!(unused_cut.counts(&app).await.0, 0);
    assert_eq!(used_cut.counts(&app).await, (1, 1, 1));
    assert_eq!(
        audit_actions(&app, unused.token.id).await,
        ["created_via_desktop", "revoked_via_desktop"]
    );

    app.cleanup().await;
}

#[tokio::test]
async fn a_used_tokens_cut_outlives_a_request_dropped_after_the_give_back() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "dropped@example.com").await;
    let used = mint(&app, uid, &["desktop.account"]).await;
    app.api_tokens
        .validate_no_audit(&used.secret)
        .await
        .expect("the token is live");
    // Profile answers slowly, as one under load does: a cut awaited inside
    // the request would still be waiting on it when the client goes.
    let cut = OwnerCut::mount_answering(
        &app,
        uid,
        used.token.id,
        ResponseTemplate::new(202).set_delay(Duration::from_secs(1)),
    )
    .await;

    // Drive the request only until the give-back has committed, then drop
    // it, as a desktop that hangs up or gives up does.
    let mut request = Box::pin(self_revoke(&app, Some(&used.secret)));
    let answered = loop {
        tokio::select! {
            answer = &mut request => break Some(answer),
            () = tokio::time::sleep(Duration::from_millis(10)) => {
                if !active(&app, used.token.id).await {
                    break None;
                }
            }
        }
    };
    drop(request);

    if let Some((status, body)) = answered {
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(body.is_empty());
    }
    assert!(
        !active(&app, used.token.id).await,
        "the give-back committed"
    );
    assert_eq!(
        cut.settled(&app, (1, 1, 1)).await,
        (1, 1, 1),
        "profile's reservation and the first cut outlive the request"
    );
    assert_eq!(
        audit_actions(&app, used.token.id).await,
        ["created_via_desktop", "revoked_via_desktop"]
    );

    app.cleanup().await;
}

#[tokio::test]
async fn a_used_tokens_first_cut_runs_when_profile_fails() {
    let (subscriber, output) = capture_logs();
    let _logs = tracing::subscriber::set_default(subscriber);
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "profile-down@example.com").await;
    let used = mint(&app, uid, &["desktop.account"]).await;
    app.api_tokens
        .validate_no_audit(&used.secret)
        .await
        .expect("the token is live");
    let cut = OwnerCut::mount_answering(&app, uid, used.token.id, ResponseTemplate::new(500)).await;

    let (status, body) = self_revoke(&app, Some(&used.secret)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());
    assert!(!active(&app, used.token.id).await, "the revoke stands");
    // Profile was asked once and failed; the first cut runs anyway.
    assert_eq!(
        cut.settled(&app, (1, 1, 1)).await,
        (1, 1, 1),
        "the first cut runs after a failed reservation"
    );
    let captured = String::from_utf8(output.lock().unwrap().clone()).unwrap();
    assert!(
        captured.lines().any(|line| line
            .contains("reserving the cut of a used desktop token given back failed")
            && line.contains(&used.token.id.to_string())),
        "the failed reservation is logged by the token's id: {captured}"
    );
    assert!(
        !captured.contains(&used.secret),
        "no line carries the token: {captured}"
    );

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_refuses_a_browser_session_alone() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = Uuid::new_v4();
    app.insert_user(uid, "session@example.com").await;
    happy_login(&app, &mut c, uid, "session@example.com").await;
    mock_get_user(&app, uid, "session@example.com", false).await;
    let cookie = c.cookie.clone().expect("browser session");
    // The session is live: the account page answers through it.
    let (status, _) = send_as(&app, Method::GET, "/api/tokens", None, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    let token = mint(&app, uid, &["desktop.account"]).await;

    let invalid = invalid_bearer_answer(&app).await;
    for bearer in [None, Some("not-a-pat")] {
        let answer = send_as(
            &app,
            Method::DELETE,
            "/desktop/v1/token",
            bearer,
            Some(&cookie),
            Some(json!({ "id": token.token.id })),
        )
        .await;
        assert_eq!(answer, invalid, "{bearer:?}");
    }
    assert!(active(&app, token.token.id).await);

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_answers_every_invalid_bearer_as_the_pat_auth_does() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "invalid@example.com").await;
    let revoked = mint(&app, uid, &["desktop.account"]).await;
    assert!(app
        .api_tokens
        .revoke(uid, revoked.token.id, &RequestMeta::default())
        .await
        .unwrap());
    let expired = mint(&app, uid, &["desktop.account"]).await;
    sqlx::query("UPDATE api_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1")
        .bind(expired.token.id)
        .execute(&app.pool)
        .await
        .unwrap();
    // A devserver's PAT is not the desktop's to give back here.
    let tunnel = mint(&app, uid, &["tunnel"]).await;

    let invalid = invalid_bearer_answer(&app).await;
    assert_eq!(invalid.0, StatusCode::UNAUTHORIZED);
    let unknown = "chan_pat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    for (name, bearer) in [
        ("already revoked", Some(revoked.secret.as_str())),
        ("expired", Some(expired.secret.as_str())),
        ("unknown", Some(unknown)),
        ("not a PAT", Some("opaque")),
        ("tunnel scope", Some(tunnel.secret.as_str())),
        ("absent", None),
    ] {
        assert_eq!(self_revoke(&app, bearer).await, invalid, "{name}");
    }
    // None of them wrote anything: the expired token is not revoked, the
    // tunnel token still authenticates, and the revoked one has only the
    // revoke it had.
    assert!(active(&app, expired.token.id).await);
    assert!(active(&app, tunnel.token.id).await);
    for token in [&revoked, &expired, &tunnel] {
        assert!(
            !audit_actions(&app, token.token.id)
                .await
                .iter()
                .any(|action| action == "revoked_via_desktop"),
            "no give-back is audited"
        );
    }
    assert_eq!(
        audit_actions(&app, revoked.token.id).await,
        ["created_via_desktop", "revoked"]
    );

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_answers_a_blocked_owners_token_as_an_invalid_bearer() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "blocked@example.com").await;
    let token = mint(&app, uid, &["desktop.account"]).await;
    sqlx::query("UPDATE users SET blocked_at = now() WHERE id = $1")
        .bind(uid)
        .execute(&app.pool)
        .await
        .unwrap();

    let invalid = invalid_bearer_answer(&app).await;
    assert_eq!(self_revoke(&app, Some(&token.secret)).await, invalid);
    // The blocked account's own path revokes its tokens; this route wrote
    // nothing.
    assert!(active(&app, token.token.id).await);

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_ignores_the_admission_policy_that_gates_use() {
    let app = TestApp::new().await;
    let paused = Uuid::new_v4();
    let disabled = Uuid::new_v4();
    app.insert_user(paused, "paused@example.com").await;
    app.insert_user(disabled, "disabled@example.com").await;
    let paused_token = mint(&app, paused, &["desktop.account"]).await;
    let disabled_token = mint(&app, disabled, &["desktop.account"]).await;
    sqlx::query(
        "INSERT INTO devserver_user_policies (user_id, enabled, max_connected_devservers) \
         VALUES ($1, false, 1)",
    )
    .bind(disabled)
    .execute(&app.pool)
    .await
    .unwrap();
    // The disabled policy already refuses use; pausing the fleet refuses it
    // for everyone.
    assert!(app
        .api_tokens
        .validate_no_audit(&disabled_token.secret)
        .await
        .is_err());
    sqlx::query("UPDATE devserver_fleet_policy SET admissions_enabled = false")
        .execute(&app.pool)
        .await
        .unwrap();
    assert!(app
        .api_tokens
        .validate_no_audit(&paused_token.secret)
        .await
        .is_err());

    // A holder can still give either token back.
    for (name, token) in [
        ("paused fleet", &paused_token),
        ("disabled user policy", &disabled_token),
    ] {
        let (status, body) = self_revoke(&app, Some(&token.secret)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{name}");
        assert!(body.is_empty(), "{name}");
        assert!(!active(&app, token.token.id).await, "{name}");
    }

    app.cleanup().await;
}

#[tokio::test]
async fn self_revoke_accepts_every_desktop_scope_set() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "scopes@example.com").await;
    for scopes in [
        &["desktop.account"][..],
        &["desktop.connect"][..],
        &["tunnel", "desktop.connect"][..],
    ] {
        let token = mint(&app, uid, scopes).await;
        let (status, _) = self_revoke(&app, Some(&token.secret)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{scopes:?}");
        assert!(!active(&app, token.token.id).await, "{scopes:?}");
        assert_eq!(
            audit_actions(&app, token.token.id).await,
            ["created_via_desktop", "revoked_via_desktop"],
            "{scopes:?}: the revoke wrote its own audit row"
        );
    }

    app.cleanup().await;
}
