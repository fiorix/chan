//! Integration tests for identity-service.
//!
//! Each test gets:
//! - its own throwaway Postgres schema (for tower-sessions);
//! - a wiremock-backed profile-service;
//! - a wiremock-backed GitHub (token + user + emails endpoints).
//!
//! Set `TEST_DATABASE_URL` to a database the test process can
//! create schemas in (same as `profile`'s tests).

#[path = "../../../tests-shared/identity_config.rs"]
mod identity_config;
#[path = "../../../tests-shared/identity_db.rs"]
mod test_db;

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use tower_sessions_sqlx_store::PostgresStore;
use url::Url;
use uuid::Uuid;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use identity::config::Config;
use identity::devserver_control_client::DevserverControlClient;
use identity::http;
use identity::profile_client::ProfileClient;
use identity::providers::github::{GitHubEndpoints, GitHubProvider};

const PROFILE_TOKEN: &str = "test-profile-token";
const VALIDATION_INTERNAL_TOKEN: &str = "test-validation-internal";
const SESSION_INTERNAL_TOKEN: &str = "test-session-internal";
const OPERATOR_ADMIN_TOKEN: &str = "test-identity-admin";
const ACCOUNT_ADMIN_TOKEN: &str = "test-account-admin";

struct TestApp {
    router: Router,
    pool: PgPool,
    schema: String,
    admin_url: String,
    profile: MockServer,
    github: MockServer,
}

impl TestApp {
    async fn new() -> Self {
        Self::with_identity_tokens(
            SESSION_INTERNAL_TOKEN,
            OPERATOR_ADMIN_TOKEN,
            ACCOUNT_ADMIN_TOKEN,
        )
        .await
    }

    async fn with_identity_tokens(
        session_internal_auth_token: &str,
        identity_admin_token: &str,
        account_admin_token: &str,
    ) -> Self {
        let (url, schema, pool, store) =
            test_db::create_schema(test_db::MigrationOrder::SessionsFirst).await;

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

        let api_tokens = identity::api_tokens::ApiTokenService::new(pool.clone());

        let cfg = Arc::new(Config {
            base_url,
            devserver_proxy_origin: "https://proxy.chan.app".parse().unwrap(),
            internal_auth_token: VALIDATION_INTERNAL_TOKEN.to_string(),
            session_internal_auth_token: session_internal_auth_token.to_string(),
            identity_admin_token: identity_admin_token.to_string(),
            account_admin_token: account_admin_token.to_string(),
            // The profile mock also serves the disjoint control-admin paths.
            // Tests needing a live devserver use `mock_live_devserver`; the
            // rest take the no-match error path, which `me` tolerates.
            workspace_admin: DevserverControlClient::new(
                profile.uri().parse().unwrap(),
                "test-admin".into(),
            )
            .unwrap(),
            providers: vec![Arc::new(provider)],
            ..identity_config::test_config(&url, profile_client)
        });

        let router = http::router(
            cfg,
            store,
            api_tokens,
            identity::token_throttle::TokenThrottle::new(),
        );

        Self {
            router,
            pool,
            schema,
            admin_url: url,
            profile,
            github,
        }
    }

    async fn cleanup(self) {
        self.pool.close().await;
        test_db::pg::drop_schema(&self.admin_url, &self.schema).await;
    }
}

/// Tiny stateful client: keeps the session cookie between calls so
/// tests can step through login -> callback -> me.
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
        body: Option<Value>,
    ) -> (StatusCode, Vec<(String, String)>, Value, String) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(c) = &self.cookie {
            builder = builder.header(header::COOKIE, c.clone());
        }
        let body = match body {
            Some(v) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(serde_json::to_vec(&v).unwrap())
            }
            None => Body::empty(),
        };
        let req = builder.body(body).unwrap();
        let res = self.app.router.clone().oneshot(req).await.unwrap();

        let status = res.status();
        let headers: Vec<(String, String)> = res
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        // Update cookie jar from Set-Cookie if present.
        if let Some(set_cookie) = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .next()
            .and_then(|v| v.to_str().ok())
        {
            // Strip attributes; keep only `name=value`.
            let pair = set_cookie.split(';').next().unwrap_or("").to_string();
            self.cookie = Some(pair);
        }

        let location = res
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, headers, json, location)
    }
}

async fn authenticated_json(
    router: &Router,
    method: Method,
    uri: &str,
    bearer: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    let body = match body {
        Some(value) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&value).unwrap())
        }
        None => Body::empty(),
    };
    let response = router
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, body)
}

fn raw_session_cookie(client: &Client<'_>) -> String {
    client
        .cookie
        .as_deref()
        .and_then(|cookie| cookie.split_once('='))
        .map(|(_, value)| value.to_string())
        .expect("session cookie")
}

async fn assert_whoami_unauthorized(app: &TestApp, session: &str) {
    let (status, body) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        SESSION_INTERNAL_TOKEN,
        Some(json!({"session": session})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({"error": "unauthorized"}));
}

fn session_revocation_response(status: StatusCode, revoked: usize) -> ResponseTemplate {
    let response = ResponseTemplate::new(status.as_u16());
    if status.is_success() {
        response.set_body_json(json!({
            "revoked": revoked,
            "tenant_sessions_revoked": revoked,
            "proxies_confirmed": 2,
            "proxies_expected": 2,
        }))
    } else {
        response
    }
}

async fn mock_session_drain(app: &TestApp, scope: Value, status: StatusCode, revoked: usize) {
    Mock::given(method("POST"))
        .and(path("/admin/v1/sessions/revoke"))
        .and(body_json(scope))
        .respond_with(session_revocation_response(status, revoked))
        .expect(1)
        .mount(&app.profile)
        .await;
}

async fn mock_owner_tunnel_drain(app: &TestApp, user_id: Uuid, killed: usize) {
    Mock::given(method("POST"))
        .and(path(format!("/admin/v1/owners/{user_id}/tunnels/kill")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"killed": killed})))
        .expect(1)
        .mount(&app.profile)
        .await;
}

async fn mock_all_tunnel_drain(app: &TestApp, killed: usize) {
    Mock::given(method("POST"))
        .and(path("/admin/v1/tunnels/kill-all"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"tunnels_evicted": killed})))
        .expect(1)
        .mount(&app.profile)
        .await;
}

async fn mock_policy_update_round(
    app: &TestApp,
    user_id: Uuid,
    previous_limit: i32,
    requested_limit: i32,
    session_status: StatusCode,
) {
    let updated_at = chrono::Utc::now().to_rfc3339();
    Mock::given(method("GET"))
        .and(path(format!("/v1/admin/users/{user_id}/devserver-policy")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": user_id,
            "enabled": true,
            "max_connected_devservers": previous_limit,
            "updated_at": updated_at,
        })))
        .expect(1)
        .mount(&app.profile)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!("/v1/admin/users/{user_id}/devserver-policy")))
        .and(body_json(json!({
            "enabled": true,
            "max_connected_devservers": requested_limit,
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": user_id,
            "enabled": true,
            "max_connected_devservers": requested_limit,
            "updated_at": updated_at,
        })))
        .expect(1)
        .mount(&app.profile)
        .await;
    mock_session_drain(
        app,
        json!({"scope": "owner", "owner_user_id": user_id}),
        session_status,
        2,
    )
    .await;
    mock_owner_tunnel_drain(app, user_id, 2).await;
}

async fn mock_fleet_pause_round(app: &TestApp, session_status: StatusCode) {
    Mock::given(method("PUT"))
        .and(path("/v1/admin/devserver-policy"))
        .and(body_json(json!({"admissions_enabled": false})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "admissions_enabled": false,
            "updated_at": chrono::Utc::now().to_rfc3339(),
        })))
        .expect(1)
        .mount(&app.profile)
        .await;
    mock_session_drain(app, json!({"scope": "all"}), session_status, 4).await;
    mock_all_tunnel_drain(app, 3).await;
}

async fn mock_access_revoke_round(
    app: &TestApp,
    user_id: Uuid,
    pats_revoked: usize,
    session_status: StatusCode,
) {
    Mock::given(method("POST"))
        .and(path(format!("/v1/admin/users/{user_id}/access/revoke")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": user_id,
            "username": "alice",
            "pats_revoked": pats_revoked,
        })))
        .expect(1)
        .mount(&app.profile)
        .await;
    mock_session_drain(
        app,
        json!({"scope": "subject", "subject_user_id": user_id}),
        session_status,
        3,
    )
    .await;
    mock_owner_tunnel_drain(app, user_id, 2).await;
}

fn extract_state(authorize_url: &str) -> String {
    let u = Url::parse(authorize_url).unwrap();
    u.query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .expect("state param")
}

fn assert_entry_handoff(status: StatusCode, headers: &[(String, String)], location: &str) {
    assert_eq!(status, StatusCode::OK);
    assert!(
        location.is_empty(),
        "credential must not appear in Location"
    );
    let value = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(value("cache-control"), Some("no-store"));
    assert_eq!(value("referrer-policy"), Some("strict-origin"));
    assert!(
        value("content-security-policy").is_some_and(|csp| csp.contains("form-action https://"))
    );
}

fn fake_user_id() -> Uuid {
    Uuid::new_v4()
}

#[tokio::test]
async fn me_unauthenticated() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, _, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn auth_start_redirects_to_provider() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, _, location) = c.send(Method::GET, "/auth/github", None).await;
    assert_eq!(s, StatusCode::SEE_OTHER, "expected 303");
    assert!(
        location.contains("/login/oauth/authorize"),
        "got {location}"
    );
    assert!(location.contains("state="), "got {location}");
    assert!(location.contains("code_challenge="), "got {location}");
    app.cleanup().await;
}

#[tokio::test]
async fn oauth_return_to_is_safe_and_consumed_once() {
    let app = TestApp::new().await;
    for invalid in [
        "https%3A%2F%2Fevil.example%2F",
        "%2F%2Fevil.example%2F",
        "%2F%252Fevil.example",
        "%2F%255Cevil.example",
        "%2Faccount%2F%23fragment",
        "%2Faccount%2F%250aheader",
        "%25",
    ] {
        let mut client = Client::new(&app);
        let (status, _, _, _) = client
            .send(
                Method::GET,
                &format!("/auth/github?return_to={invalid}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");
    }

    let uid = fake_user_id();
    let mut client = Client::new(&app);
    happy_login_at(
        &app,
        &mut client,
        uid,
        "return@example.com",
        "/auth/github?return_to=%2Faccount%2F%3Ftab%3Dsessions",
        "/account/?tab=sessions",
    )
    .await;
    // A new flow on the same cookie has no inherited destination.
    happy_login(&app, &mut client, uid, "return@example.com").await;
    app.cleanup().await;
}

#[tokio::test]
async fn unknown_provider_is_404() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, _, _) = c.send(Method::GET, "/auth/myspace", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

async fn happy_login(app: &TestApp, c: &mut Client<'_>, user_id: Uuid, email: &str) {
    happy_login_at(app, c, user_id, email, "/auth/github", "/").await;
}

async fn happy_login_at(
    app: &TestApp,
    c: &mut Client<'_>,
    user_id: Uuid,
    email: &str,
    auth_uri: &str,
    expected_return_to: &str,
) {
    // 1. /auth/github -> redirect with state + Set-Cookie session.
    let (_, _, _, location) = c.send(Method::GET, auth_uri, None).await;
    let state = extract_state(&location);

    // 2. wiremock GitHub: token exchange + user info.
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

    // 3. wiremock profile-service: single atomic upsert call.
    //    username + username_edits are NOT NULL on users since 0003;
    //    identity::profile_client::User deserializes them, so the
    //    mock body must include them or the callback returns 502.
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
    sqlx::query(
        "INSERT INTO users (id, email, display_name, username) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(user_id)
    .bind(email)
    .bind("Octo Cat")
    .bind(format!("u{}", &user_id.simple().to_string()[..12]))
    .execute(&app.pool)
    .await
    .expect("seed profile-owned user for the shared session-index FK");
    Mock::given(method("POST"))
        .and(path("/v1/users/upsert-by-identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": user_body.clone(),
            "user_created": true,
            "identity_created": true,
        })))
        .mount(&app.profile)
        .await;

    // 3b. callback runs a best-effort claim sweep. Tests don't care
    //     about the count; respond 0 so the warn-on-error path is
    //     not taken (which would otherwise pollute test output via
    //     `wiremock` returning 404 for an unmocked path).
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{user_id}/grants/claim")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"claimed": 0})))
        .mount(&app.profile)
        .await;

    // 3c. Feature flags. happy_login grants oauth_login + share_workspaces
    //     so the callback gate passes and the SPA gets the flags.
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{user_id}/flags")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "oauth_login": true,
            "share_workspaces": true,
        })))
        .mount(&app.profile)
        .await;

    // 4. callback -> 303 to /
    let (s, _, _, location) = c
        .send(
            Method::GET,
            &format!("/auth/github/callback?code=fake&state={state}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::SEE_OTHER, "callback should redirect");
    assert_eq!(location, expected_return_to);
}

#[tokio::test]
async fn login_then_me() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    // /api/me returns just the user; devserver content lives behind devserver-proxy.
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": uid,
            "email": "octo@example.com",
            "display_name": "Octo Cat",
            "username": format!("u{}", &uid.simple().to_string()[..12]),
            "username_edits": 0,
            "created_at": chrono::Utc::now().to_rfc3339(),
            "updated_at": chrono::Utc::now().to_rfc3339(),
        })))
        .mount(&app.profile)
        .await;

    let (s, _, body, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["user"]["id"].as_str().unwrap(), uid.to_string());
    // The live devserver list comes from proxy admin. This test mocks no
    // tunnel list, so the admin call no-matches and `me` resolves an empty
    // array (it tolerates admin errors rather than failing /api/me).
    assert_eq!(
        body["devservers"].as_array().expect("devservers present"),
        &Vec::<serde_json::Value>::new()
    );
    app.cleanup().await;
}

async fn mock_session_user(app: &TestApp, uid: Uuid) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": uid,
            "email": "session-index@example.com",
            "display_name": "Session User",
            "username": format!("u{}", &uid.simple().to_string()[..12]),
            "username_edits": 0,
            "created_at": chrono::Utc::now(),
            "updated_at": chrono::Utc::now(),
        })))
        .mount(&app.profile)
        .await;
}

async fn unindex_session(app: &TestApp, client: &Client<'_>) {
    let deleted = sqlx::query("DELETE FROM identity_session_index WHERE store_id = $1")
        .bind(raw_session_cookie(client))
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 1);
}

async fn store_session_exists(app: &TestApp, store_id: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM tower_sessions.session WHERE id = $1)")
        .bind(store_id)
        .fetch_one(&app.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn unindexed_oauth_sessions_cannot_authenticate_public_apis() {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        let app = TestApp::new().await;
        let uid = fake_user_id();
        mock_session_user(&app, uid).await;
        let mut observed = Vec::new();
        for route in ["/api/me", "/api/tokens"] {
            let mut client = Client::new(&app);
            happy_login(&app, &mut client, uid, "session-index@example.com").await;
            assert_eq!(
                client.send(Method::GET, route, None).await.0,
                StatusCode::OK
            );
            let store_id = raw_session_cookie(&client);
            unindex_session(&app, &client).await;
            assert!(store_session_exists(&app, &store_id).await);
            let status = client.send(Method::GET, route, None).await.0;
            observed.push((route, status, store_session_exists(&app, &store_id).await));
        }
        app.cleanup().await;
        assert_eq!(
            observed,
            vec![
                ("/api/me", StatusCode::UNAUTHORIZED, false),
                ("/api/tokens", StatusCode::UNAUTHORIZED, false),
            ]
        );
    })
    .await
    .expect("unindexed OAuth API test timed out");
}

#[tokio::test]
async fn user_wide_oauth_revoke_denies_every_session_authenticated_route() {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        let app = TestApp::new().await;
        let uid = fake_user_id();
        mock_session_user(&app, uid).await;
        let token = Uuid::nil();
        let devserver = "a".repeat(64);
        let routes = vec![
            (Method::GET, "/api/me".into(), None),
            (
                Method::PATCH,
                "/api/me/username".into(),
                Some(json!({"username": "session-user"})),
            ),
            (Method::DELETE, "/api/profile".into(), None),
            (Method::GET, "/api/tokens".into(), None),
            (
                Method::POST,
                "/api/tokens".into(),
                Some(json!({"label": "session test"})),
            ),
            (Method::DELETE, format!("/api/tokens/{token}"), None),
            (Method::GET, format!("/api/tokens/{token}/audit"), None),
            (Method::GET, "/api/devservers/owned".into(), None),
            (Method::GET, "/api/devservers/incoming".into(), None),
            (
                Method::GET,
                format!("/api/devservers/{devserver}/grants"),
                None,
            ),
            (
                Method::POST,
                format!("/api/devservers/{devserver}/grants"),
                Some(json!({"grantee_email": "guest@example.com"})),
            ),
            (Method::DELETE, format!("/api/grants/{token}"), None),
            (Method::GET, "/desktop/authorize/consent".into(), None),
            (Method::POST, "/desktop/authorize/confirm".into(), None),
        ];
        let mut sessions = Vec::new();
        for unindexed in [false, true] {
            for _ in &routes {
                let mut client = Client::new(&app);
                happy_login(&app, &mut client, uid, "session-index@example.com").await;
                if unindexed {
                    unindex_session(&app, &client).await;
                }
                sessions.push((unindexed, client));
            }
        }
        let (status, result) = authenticated_json(
            &app.router,
            Method::POST,
            &format!("/admin/v1/users/{uid}/sessions/revoke"),
            OPERATOR_ADMIN_TOKEN,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["oauth_sessions_revoked"], routes.len());
        let mut failures = Vec::new();
        for ((unindexed, mut client), (method, route, body)) in
            sessions.into_iter().zip(routes.iter().cycle())
        {
            let store_id = raw_session_cookie(&client);
            let status = if route == "/desktop/authorize/confirm" {
                let request = Request::builder()
                    .method(Method::POST)
                    .uri(route)
                    .header(header::COOKIE, client.cookie.as_ref().unwrap())
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from("action=allow&csrf=unused"))
                    .unwrap();
                app.router.clone().oneshot(request).await.unwrap().status()
            } else {
                client.send(method.clone(), route, body.clone()).await.0
            };
            let retained = store_session_exists(&app, &store_id).await;
            if status != StatusCode::UNAUTHORIZED || retained {
                failures.push(format!(
                    "{method} {route}: unindexed={unindexed}, status={status}, retained={retained}"
                ));
            }
        }
        app.cleanup().await;
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    })
    .await
    .expect("user-wide OAuth route test timed out");
}

#[tokio::test]
async fn malformed_oauth_authentication_time_signs_out() {
    use tower_sessions::SessionStore;

    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        let app = TestApp::new().await;
        let uid = fake_user_id();
        mock_session_user(&app, uid).await;
        let store = PostgresStore::new(app.pool.clone());
        let mut observed = Vec::new();
        for malformed in [json!("not a timestamp"), json!(123), json!({}), Value::Null] {
            let mut client = Client::new(&app);
            happy_login(&app, &mut client, uid, "session-index@example.com").await;
            assert_eq!(
                client.send(Method::GET, "/api/me", None).await.0,
                StatusCode::OK
            );
            let store_id = raw_session_cookie(&client);
            let mut record = store
                .load(&store_id.parse().unwrap())
                .await
                .unwrap()
                .unwrap();
            assert!(record
                .data
                .insert("authenticated_at".into(), malformed)
                .is_some());
            store.save(&record).await.unwrap();
            let status = client.send(Method::GET, "/api/me", None).await.0;
            observed.push((status, store_session_exists(&app, &store_id).await));
        }
        app.cleanup().await;
        assert_eq!(observed, vec![(StatusCode::UNAUTHORIZED, false); 4]);
    })
    .await
    .expect("malformed OAuth timestamp test timed out");
}

#[tokio::test]
async fn oauth_session_index_must_match_user_and_authentication_time() {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        let app = TestApp::new().await;
        let uid = fake_user_id();
        let other_uid = fake_user_id();
        sqlx::query(
            "INSERT INTO users (id, email, display_name, username) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(other_uid)
        .bind("other-session@example.com")
        .bind("Other User")
        .bind(format!("u{}", &other_uid.simple().to_string()[..12]))
        .execute(&app.pool)
        .await
        .unwrap();
        mock_session_user(&app, uid).await;
        for mismatch in ["user", "authentication time", "missing authentication time"] {
            let mut client = Client::new(&app);
            happy_login(&app, &mut client, uid, "session-index@example.com").await;
            let store_id = raw_session_cookie(&client);
            match mismatch {
                "user" => {
                    sqlx::query(
                        "UPDATE identity_session_index SET user_id = $1 WHERE store_id = $2",
                    )
                    .bind(other_uid)
                    .bind(&store_id)
                    .execute(&app.pool)
                    .await
                    .unwrap();
                }
                "authentication time" => {
                    sqlx::query(
                        "UPDATE identity_session_index \
                         SET authenticated_at = authenticated_at - interval '1 second' \
                         WHERE store_id = $1",
                    )
                    .bind(&store_id)
                    .execute(&app.pool)
                    .await
                    .unwrap();
                }
                "missing authentication time" => {
                    use tower_sessions::SessionStore;
                    let store = PostgresStore::new(app.pool.clone());
                    let session_id = store_id.parse().unwrap();
                    let mut record = store.load(&session_id).await.unwrap().unwrap();
                    assert!(record.data.remove("authenticated_at").is_some());
                    store.save(&record).await.unwrap();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                client.send(Method::GET, "/api/me", None).await.0,
                StatusCode::UNAUTHORIZED,
                "{mismatch}"
            );
            assert!(!store_session_exists(&app, &store_id).await, "{mismatch}");
        }
        app.cleanup().await;
    })
    .await
    .expect("OAuth index mismatch test timed out");
}

#[tokio::test]
async fn oauth_signout_preserves_anonymous_share_and_desktop_signin_flows() {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        let app = TestApp::new().await;
        let uid = fake_user_id();
        mock_session_user(&app, uid).await;
        let desktop_uri = "/desktop/authorize?\
            redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
            state=desktop-test&label=desktop&\
            code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
            code_challenge_method=S256&scopes=tunnel&expires_in=3600";
        for unindexed in [false, true] {
            for (route, destination) in [
                ("/s/owner", "/s/owner"),
                ("/s/owner/workspace", "/s/owner/workspace"),
                (desktop_uri, "/desktop/authorize/consent"),
            ] {
                let mut client = Client::new(&app);
                if unindexed {
                    happy_login(&app, &mut client, uid, "session-index@example.com").await;
                    unindex_session(&app, &client).await;
                } else {
                    assert_eq!(
                        client.send(Method::GET, "/auth/github", None).await.0,
                        StatusCode::SEE_OTHER
                    );
                    assert_eq!(
                        client.send(Method::GET, "/api/me", None).await.0,
                        StatusCode::UNAUTHORIZED
                    );
                }
                let old_store_id = raw_session_cookie(&client);
                let (status, _, _, location) = client.send(Method::GET, route, None).await;
                assert_eq!(
                    status,
                    StatusCode::SEE_OTHER,
                    "{route}, unindexed={unindexed}"
                );
                assert_eq!(location, "/");
                // The session store can reuse the flushed id when the handler
                // saves an anonymous stash. Neither record may retain authority.
                use tower_sessions::SessionStore;
                let store = PostgresStore::new(app.pool.clone());
                for store_id in [old_store_id, raw_session_cookie(&client)] {
                    if let Some(record) = store.load(&store_id.parse().unwrap()).await.unwrap() {
                        assert!(!record.data.contains_key("user_id"));
                        assert!(!record.data.contains_key("authenticated_at"));
                    }
                }
                assert_eq!(
                    client.send(Method::GET, "/api/me", None).await.0,
                    StatusCode::UNAUTHORIZED
                );
                happy_login_at(
                    &app,
                    &mut client,
                    uid,
                    "session-index@example.com",
                    "/auth/github",
                    destination,
                )
                .await;
                if route == desktop_uri {
                    assert_eq!(
                        client.send(Method::GET, destination, None).await.0,
                        StatusCode::OK
                    );
                }
                assert_eq!(
                    client.send(Method::POST, "/api/logout", None).await.0,
                    StatusCode::NO_CONTENT
                );
            }
        }
        let mut unindexed_logout = Client::new(&app);
        happy_login(
            &app,
            &mut unindexed_logout,
            uid,
            "session-index@example.com",
        )
        .await;
        let store_id = raw_session_cookie(&unindexed_logout);
        unindex_session(&app, &unindexed_logout).await;
        assert_eq!(
            unindexed_logout
                .send(Method::POST, "/api/logout", None)
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        assert!(!store_session_exists(&app, &store_id).await);
        app.cleanup().await;
    })
    .await
    .expect("OAuth anonymous continuation test timed out");
}

#[tokio::test]
async fn indexed_oauth_session_whoami_inventory_and_exact_revoke_converge() {
    let app = TestApp::new().await;
    let mut client = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut client, uid, "indexed@example.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": uid,
            "email": "indexed@example.com",
            "display_name": "Indexed User",
            "username": format!("u{}", &uid.simple().to_string()[..12]),
            "username_edits": 0,
            "created_at": chrono::Utc::now().to_rfc3339(),
            "updated_at": chrono::Utc::now().to_rfc3339(),
        })))
        .mount(&app.profile)
        .await;

    let raw_session = client
        .cookie
        .as_deref()
        .and_then(|cookie| cookie.split_once('='))
        .map(|(_, value)| value.to_string())
        .expect("authenticated session cookie");
    let (status, whoami) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        SESSION_INTERNAL_TOKEN,
        Some(json!({"session": raw_session})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(whoami["user"]["id"], uid.to_string());
    assert!(whoami["session"]["authenticated_at"].is_string());

    let (status, rows) = authenticated_json(
        &app.router,
        Method::GET,
        "/admin/v1/sessions",
        OPERATOR_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = rows.as_array().expect("session list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["user_id"], uid.to_string());
    assert!(rows[0].get("store_id").is_none());
    assert!(!serde_json::to_string(rows).unwrap().contains(&raw_session));
    let admin_session_id = rows[0]["id"].as_str().unwrap();

    let (status, revoked) = authenticated_json(
        &app.router,
        Method::POST,
        &format!("/admin/v1/sessions/{admin_session_id}/revoke"),
        OPERATOR_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revoked["oauth_sessions_revoked"], 1);
    let (status, retried) = authenticated_json(
        &app.router,
        Method::POST,
        &format!("/admin/v1/sessions/{admin_session_id}/revoke"),
        OPERATOR_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retried["oauth_sessions_revoked"], 0);
    let (status, _) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        SESSION_INTERNAL_TOKEN,
        Some(json!({"session": raw_session})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        SESSION_INTERNAL_TOKEN,
        Some(json!({"session": "malformed"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn whoami_refusal_shape_is_uniform() {
    let app = TestApp::new().await;

    assert_whoami_unauthorized(&app, "malformed").await;

    let mut pre_auth = Client::new(&app);
    let (status, _, _, _) = pre_auth.send(Method::GET, "/auth/github", None).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_whoami_unauthorized(&app, &raw_session_cookie(&pre_auth)).await;

    let uid = fake_user_id();
    let mut authenticated = Client::new(&app);
    happy_login(&app, &mut authenticated, uid, "whoami-refusal@example.com").await;
    let raw_session = raw_session_cookie(&authenticated);

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(blocked_user_body(uid, "whoami-refusal@example.com")),
        )
        .mount(&app.profile)
        .await;
    assert_whoami_unauthorized(&app, &raw_session).await;

    app.profile.reset().await;
    assert_whoami_unauthorized(&app, &raw_session).await;

    sqlx::query(
        "UPDATE tower_sessions.session \
         SET expiry_date = now() - interval '1 second' \
         WHERE id = $1",
    )
    .bind(&raw_session)
    .execute(&app.pool)
    .await
    .expect("expire tower session");
    assert_whoami_unauthorized(&app, &raw_session).await;

    app.cleanup().await;
}

#[tokio::test]
async fn identity_credentials_are_route_scoped_and_optional_scopes_hide() {
    let app = TestApp::new().await;

    let (status, _) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        SESSION_INTERNAL_TOKEN,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    for token in [
        VALIDATION_INTERNAL_TOKEN,
        OPERATOR_ADMIN_TOKEN,
        ACCOUNT_ADMIN_TOKEN,
    ] {
        let (status, _) = authenticated_json(
            &app.router,
            Method::POST,
            "/internal/v1/sessions/whoami",
            token,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{token}");
    }

    let (status, _) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/tokens/validate",
        VALIDATION_INTERNAL_TOKEN,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    for token in [
        SESSION_INTERNAL_TOKEN,
        OPERATOR_ADMIN_TOKEN,
        ACCOUNT_ADMIN_TOKEN,
    ] {
        let (status, _) = authenticated_json(
            &app.router,
            Method::POST,
            "/internal/v1/tokens/validate",
            token,
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{token}");
    }

    let user_id = fake_user_id();
    Mock::given(method("GET"))
        .and(path(format!("/v1/admin/users/{user_id}/devserver-policy")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": user_id,
            "enabled": true,
            "max_connected_devservers": 3,
            "updated_at": chrono::Utc::now(),
        })))
        .expect(1)
        .mount(&app.profile)
        .await;
    let (status, body) = authenticated_json(
        &app.router,
        Method::GET,
        &format!("/admin/v1/users/{user_id}/devserver-policy"),
        ACCOUNT_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    for (method, path) in [
        (Method::POST, "/admin/v1/tokens"),
        (
            Method::POST,
            "/admin/v1/tokens/00000000-0000-0000-0000-000000000000/revoke",
        ),
        (Method::GET, "/admin/v1/sessions"),
        (Method::GET, "/admin/v1/fleet"),
    ] {
        let (status, _) =
            authenticated_json(&app.router, method, path, ACCOUNT_ADMIN_TOKEN, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let (status, _) = authenticated_json(
        &app.router,
        Method::GET,
        &format!("/admin/v1/users/{user_id}/devserver-policy"),
        SESSION_INTERNAL_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    app.profile.verify().await;
    app.cleanup().await;

    let disabled = TestApp::with_identity_tokens("", "", "").await;
    for (method, path) in [
        (Method::POST, "/internal/v1/sessions/whoami"),
        (Method::GET, "/admin/v1/sessions"),
        (
            Method::GET,
            "/admin/v1/users/00000000-0000-0000-0000-000000000001/devserver-policy",
        ),
    ] {
        let (status, _) = authenticated_json(&disabled.router, method, path, "unused", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    disabled.cleanup().await;
}

#[tokio::test]
async fn composite_policy_and_fleet_retries_converge_after_partial_drain() {
    let app = TestApp::new().await;
    let user_id = fake_user_id();

    mock_policy_update_round(&app, user_id, 3, 1, StatusCode::BAD_GATEWAY).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::PUT,
        &format!("/admin/v1/users/{user_id}/devserver-policy"),
        ACCOUNT_ADMIN_TOKEN,
        Some(json!({
            "enabled": true,
            "max_connected_devservers": 1,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(report["durable"]["policy"]["max_connected_devservers"], 1);
    assert_eq!(report["tenant_sessions_revoked"], 0);
    assert_eq!(report["tunnels_evicted"], 2);
    app.profile.verify().await;
    app.profile.reset().await;

    mock_policy_update_round(&app, user_id, 1, 1, StatusCode::OK).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::PUT,
        &format!("/admin/v1/users/{user_id}/devserver-policy"),
        ACCOUNT_ADMIN_TOKEN,
        Some(json!({
            "enabled": true,
            "max_connected_devservers": 1,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["policy"]["max_connected_devservers"], 1);
    assert_eq!(report["tenant_sessions_revoked"], 2);
    assert_eq!(report["tunnels_evicted"], 2);
    app.profile.verify().await;
    app.profile.reset().await;

    mock_fleet_pause_round(&app, StatusCode::BAD_GATEWAY).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::POST,
        "/admin/v1/fleet/pause",
        OPERATOR_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(report["durable"]["admissions_enabled"], false);
    assert_eq!(report["tenant_sessions_revoked"], 0);
    assert_eq!(report["tunnels_evicted"], 3);
    app.profile.verify().await;
    app.profile.reset().await;

    mock_fleet_pause_round(&app, StatusCode::OK).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::POST,
        "/admin/v1/fleet/pause",
        OPERATOR_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["admissions_enabled"], false);
    assert_eq!(report["tenant_sessions_revoked"], 4);
    assert_eq!(report["tunnels_evicted"], 3);
    app.profile.verify().await;

    app.cleanup().await;
}

#[tokio::test]
async fn composite_access_revoke_and_delete_retry_to_completion() {
    let app = TestApp::new().await;
    let access_user_id = fake_user_id();

    mock_access_revoke_round(&app, access_user_id, 2, StatusCode::BAD_GATEWAY).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::POST,
        &format!("/admin/v1/users/{access_user_id}/access/revoke"),
        ACCOUNT_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(report["durable"]["pats_revoked"], 2);
    assert_eq!(report["tenant_sessions_revoked"], 0);
    assert_eq!(report["tunnels_evicted"], 2);
    app.profile.verify().await;
    app.profile.reset().await;

    mock_access_revoke_round(&app, access_user_id, 0, StatusCode::OK).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::POST,
        &format!("/admin/v1/users/{access_user_id}/access/revoke"),
        ACCOUNT_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["pats_revoked"], 0);
    assert_eq!(report["oauth_sessions_revoked"], 0);
    assert_eq!(report["tenant_sessions_revoked"], 3);
    assert_eq!(report["tunnels_evicted"], 2);
    app.profile.verify().await;
    app.profile.reset().await;

    let delete_user_id = fake_user_id();
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{delete_user_id}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            delete_user_id,
            "delete@example.com",
            "delete-user",
        )))
        .expect(1)
        .mount(&app.profile)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{delete_user_id}/pending-delete")))
        .respond_with(ResponseTemplate::new(202))
        .expect(1)
        .mount(&app.profile)
        .await;
    mock_session_drain(
        &app,
        json!({"scope": "subject", "subject_user_id": delete_user_id}),
        StatusCode::BAD_GATEWAY,
        1,
    )
    .await;
    mock_owner_tunnel_drain(&app, delete_user_id, 1).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::DELETE,
        &format!("/admin/v1/users/{delete_user_id}"),
        ACCOUNT_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(report["durable"]["profile_existed"], true);
    assert_eq!(report["tenant_sessions_revoked"], 0);
    assert_eq!(report["tunnels_evicted"], 1);
    app.profile.verify().await;
    app.profile.reset().await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{delete_user_id}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            delete_user_id,
            "delete@example.com",
            "delete-user",
        )))
        .up_to_n_times(1)
        .expect(1)
        .mount(&app.profile)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{delete_user_id}/pending-delete")))
        .respond_with(ResponseTemplate::new(202))
        .expect(1)
        .mount(&app.profile)
        .await;
    mock_session_drain(
        &app,
        json!({"scope": "subject", "subject_user_id": delete_user_id}),
        StatusCode::OK,
        1,
    )
    .await;
    mock_owner_tunnel_drain(&app, delete_user_id, 1).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::DELETE,
        &format!("/admin/v1/users/{delete_user_id}"),
        ACCOUNT_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["profile_existed"], true);
    assert_eq!(report["sessions_deleted"], 0);

    let (status, report) = authenticated_json(
        &app.router,
        Method::DELETE,
        &format!("/admin/v1/users/{delete_user_id}"),
        ACCOUNT_ADMIN_TOKEN,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["profile_existed"], false);
    assert_eq!(report["sessions_deleted"], 0);
    app.profile.verify().await;

    app.cleanup().await;
}

#[tokio::test]
async fn callback_state_mismatch_rejects() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);

    // Start the flow to populate the session, then send a tampered
    // state. No GitHub mocks; we should never get that far.
    let (_, _, _, _) = c.send(Method::GET, "/auth/github", None).await;
    let (s, _, _, _) = c
        .send(
            Method::GET,
            "/auth/github/callback?code=fake&state=tampered",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    app.cleanup().await;
}

#[tokio::test]
async fn logout_clears_session() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    let (s, _, _, _) = c.send(Method::POST, "/api/logout", None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    let (s, _, _, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn providers_endpoint_lists_configured() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, body, _) = c.send(Method::GET, "/api/providers", None).await;
    assert_eq!(s, StatusCode::OK);
    let providers = body["providers"].as_array().unwrap();
    let names: Vec<_> = providers.iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(names, vec!["github"]);
    app.cleanup().await;
}

#[tokio::test]
async fn delete_profile_succeeds_and_clears_session() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    // Profile establishes durable local denial before identity acknowledges.
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/pending-delete")))
        .respond_with(ResponseTemplate::new(202))
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c.send(Method::DELETE, "/api/profile", None).await;
    assert_eq!(s, StatusCode::ACCEPTED);

    // Session was flushed. /api/me with the same cookie -> 401.
    let (s, _, _, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn delete_profile_unauthenticated_is_401() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, _, _) = c.send(Method::DELETE, "/api/profile", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

// ---------------------------------------------------------------
// Blocked-account gates
// ---------------------------------------------------------------

/// Helper: serialize a User body with `blocked_at` set so /api/me
/// returns the row that triggers the gate.
fn blocked_user_body(uid: Uuid, email: &str) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    json!({
        "id": uid,
        "email": email,
        "display_name": "Octo Cat",
        "username": format!("u{}", &uid.simple().to_string()[..12]),
        "username_edits": 0,
        "created_at": now,
        "updated_at": now,
        "blocked_at": now,
        "block_reason": "abuse",
    })
}

#[tokio::test]
async fn me_returns_user_with_blocked_state() {
    // /api/me must NOT 403 a blocked user; the SPA needs the row
    // to render the blocked view. Other endpoints gate, but `me`
    // surfaces the state.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(blocked_user_body(uid, "octo@example.com")),
        )
        .mount(&app.profile)
        .await;

    let (s, _, body, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::OK, "me must succeed for blocked users");
    assert!(body["user"]["blocked_at"].is_string());
    assert_eq!(body["user"]["block_reason"], "abuse");
    app.cleanup().await;
}

#[tokio::test]
async fn blocked_user_rename_is_403() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(blocked_user_body(uid, "octo@example.com")),
        )
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c
        .send(
            Method::PATCH,
            "/api/me/username",
            Some(json!({"username": "newhandle"})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    app.cleanup().await;
}

#[tokio::test]
async fn token_create_rejects_overflowing_expiry() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "octo@example.com",
            "octocat",
        )))
        .mount(&app.profile)
        .await;

    let (s, _, body, _) = c
        .send(
            Method::POST,
            "/api/tokens",
            Some(json!({"label": "cli", "expires_in": i64::MAX})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid expires_in");
    app.cleanup().await;
}

#[tokio::test]
async fn token_create_rejects_expires_in_outside_i64() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "octo@example.com",
            "octocat",
        )))
        .mount(&app.profile)
        .await;

    let (status, headers, body, _) = c
        .send(
            Method::POST,
            "/api/tokens",
            Some(json!({
                "label": "cli",
                "expires_in": 9_223_372_036_854_775_808_u64,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // Json extractor rejections are text/plain; every identity handler error
    // is application/json, and none maps to 422.
    let content_type = headers
        .iter()
        .find_map(|(key, value)| (key == "content-type").then_some(value.as_str()));
    assert_eq!(
        content_type,
        Some("text/plain; charset=utf-8"),
        "422 must come from the Json extractor, not a handler error: {headers:?}"
    );
    assert_eq!(
        body,
        Value::Null,
        "extractor rejection must not be a JSON error envelope"
    );

    let (status, _, body, _) = c.send(Method::GET, "/api/tokens", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));
    app.cleanup().await;
}

#[tokio::test]
async fn token_create_refuses_desktop_scopes() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "octo@example.com",
            "octocat",
        )))
        .mount(&app.profile)
        .await;

    for scopes in [
        json!(["desktop.connect"]),
        json!(["desktop.account"]),
        json!(["tunnel", "desktop.connect"]),
        json!(["desktop.other"]),
    ] {
        let (status, _, body, _) = c
            .send(
                Method::POST,
                "/api/tokens",
                Some(json!({"label": "cli", "scopes": scopes})),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "scopes={scopes}");
        assert_eq!(body["error"], "invalid scopes", "scopes={scopes}");
    }

    let (status, _, body, _) = c.send(Method::GET, "/api/tokens", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));

    let (status, _, _, _) = c
        .send(
            Method::POST,
            "/api/tokens",
            Some(json!({"label": "cli", "scopes": ["tunnel"]})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    app.cleanup().await;
}

#[tokio::test]
async fn token_create_non_positive_expires_in_never_expires() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "octo@example.com",
            "octocat",
        )))
        .mount(&app.profile)
        .await;

    for (case, request) in [
        ("absent", json!({"label": "cli"})),
        ("null", json!({"label": "cli", "expires_in": null})),
        ("zero", json!({"label": "cli", "expires_in": 0})),
        ("negative", json!({"label": "cli", "expires_in": -1})),
    ] {
        let (status, _, body, _) = c.send(Method::POST, "/api/tokens", Some(request)).await;
        assert_eq!(status, StatusCode::CREATED, "case={case}");
        assert_eq!(body.get("expires_at"), Some(&Value::Null), "case={case}");
    }
    app.cleanup().await;
}

#[tokio::test]
async fn blocked_user_token_create_is_403() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(blocked_user_body(uid, "octo@example.com")),
        )
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c
        .send(
            Method::POST,
            "/api/tokens",
            Some(json!({"label": "cli", "expires_in": null})),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    app.cleanup().await;
}

#[tokio::test]
async fn blocked_user_token_list_is_403() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(blocked_user_body(uid, "octo@example.com")),
        )
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c.send(Method::GET, "/api/tokens", None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    app.cleanup().await;
}

#[tokio::test]
async fn blocked_user_can_still_logout() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(blocked_user_body(uid, "octo@example.com")),
        )
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c.send(Method::POST, "/api/logout", None).await;
    assert_eq!(s, StatusCode::NO_CONTENT, "logout must always work");
    app.cleanup().await;
}

#[tokio::test]
async fn blocked_user_can_still_delete_account() {
    // Right to deletion: a blocked account must be able to delete
    // itself even though every other write is refused.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/pending-delete")))
        .respond_with(ResponseTemplate::new(202))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(blocked_user_body(uid, "octo@example.com")),
        )
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c.send(Method::DELETE, "/api/profile", None).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Workspace sharing (grants) + share landing
// ---------------------------------------------------------------------------

fn live_user_body(uid: Uuid, email: &str, username: &str) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    json!({
        "id": uid,
        "email": email,
        "display_name": "Owner",
        "username": username,
        "username_edits": 0,
        "created_at": now,
        "updated_at": now,
    })
}

fn grant_body(grant_id: Uuid, owner_id: Uuid, devserver_id: &str, email: &str) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    json!({
        "id": grant_id,
        "owner_user_id": owner_id,
        "devserver_id": devserver_id,
        "grantee_email": email,
        "grantee_user_id": null,
        "created_at": now,
        "accepted_at": null,
    })
}

async fn profile_request_count(app: &TestApp, request_method: &str, request_path: &str) -> usize {
    app.profile
        .received_requests()
        .await
        .expect("profile request recording enabled")
        .iter()
        .filter(|request| {
            request.method.as_str() == request_method && request.url.path() == request_path
        })
        .count()
}

/// Mock the scoped controller tunnel list so `username` has one live
/// devserver. The open routes read the live devserver_id from here to
/// mint the gate `drv`.
async fn mock_live_devserver(
    app: &TestApp,
    owner_user_id: Uuid,
    username: &str,
    devserver_id: &str,
) {
    mock_live_devservers(app, owner_user_id, username, &[devserver_id]).await;
}

/// Same, with several live devservers.
async fn mock_live_devservers(
    app: &TestApp,
    owner_user_id: Uuid,
    username: &str,
    devserver_ids: &[&str],
) {
    let now = chrono::Utc::now();
    let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    )
    .unwrap();
    let rows: Vec<serde_json::Value> = devserver_ids
        .iter()
        .map(|id| {
            let registration_id = Uuid::new_v4();
            let lease = signer
                .sign(
                    devserver_control_proto::AdmissionLeaseBinding {
                        owner_user_id,
                        user: username.into(),
                        devserver_id: (*id).into(),
                        registration_id,
                        proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
                    },
                    3,
                    now,
                    120,
                )
                .unwrap();
            json!({
                "registration_id": registration_id,
                "owner_user_id": owner_user_id,
                "user": username,
                "devserver_id": id,
                "max_connected_devservers": 3,
                "peer_addr": null,
                "connected_at": now.to_rfc3339(),
                "proxy_id": "p1",
                "proxy_base_url": "https://p1.proxy.chan.app",
                "admission_lease": lease,
                "admission_lease_expires_at": (now + chrono::Duration::seconds(120)).to_rfc3339(),
            })
        })
        .collect();
    Mock::given(method("GET"))
        .and(path(format!("/admin/v1/owners/{owner_user_id}/tunnels")))
        .respond_with(ResponseTemplate::new(200).set_body_json(rows))
        .mount(&app.profile)
        .await;
}

#[tokio::test]
async fn grant_create_requires_session() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let dsid = "a".repeat(64);
    let (s, _, _, _) = c
        .send(
            Method::POST,
            &format!("/api/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "a@b.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn grant_create_validates_role() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "owner@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;

    let dsid = "a".repeat(64);
    let (s, _, _, _) = c
        .send(
            Method::POST,
            &format!("/api/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "a@b.com", "role": "admin"})),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    app.cleanup().await;
}

#[tokio::test]
async fn grant_create_forwards_to_profile() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "owner@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let grant_id = Uuid::new_v4();
    let dsid = "a".repeat(64);
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/devservers/{dsid}/grants")))
        .respond_with(ResponseTemplate::new(201).set_body_json(grant_body(
            grant_id,
            uid,
            &dsid,
            "alice@x.com",
        )))
        .mount(&app.profile)
        .await;

    let (s, _, body, _) = c
        .send(
            Method::POST,
            &format!("/api/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "alice@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(body["id"].as_str().unwrap(), grant_id.to_string());
    assert!(body.get("role").is_none());
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_unauthed_stashes_redirect() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, _, location) = c.send(Method::GET, "/s/owner-handle/photos", None).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(location, "/");
    // Now log in. After the callback, the redirect target should be
    // the stashed share URL, not "/".
    let uid = fake_user_id();
    // happy_login asserts location == "/" -- bypass it and run the
    // OAuth steps manually so we can inspect the real location.
    let (_, _, _, _) = c.send(Method::GET, "/auth/github", None).await;
    // Pull state by re-reading the redirect from a fresh /auth call:
    // the session already has KEY_POST_LOGIN_REDIRECT set, and
    // /auth/github overwrites KEY_PENDING (a different key) without
    // clearing the redirect stash.
    let (_, _, _, loc2) = c.send(Method::GET, "/auth/github", None).await;
    let state = extract_state(&loc2);

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
            "email": "octo@example.com",
        })))
        .mount(&app.github)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/users/upsert-by-identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": live_user_body(uid, "octo@example.com", "octocat"),
            "user_created": true,
            "identity_created": true,
        })))
        .mount(&app.profile)
        .await;
    sqlx::query(
        "INSERT INTO users (id, email, display_name, username) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(uid)
    .bind("octo@example.com")
    .bind("Octo Cat")
    .bind("octocat")
    .execute(&app.pool)
    .await
    .expect("seed profile-owned user for the shared session-index FK");
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/grants/claim")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"claimed": 0})))
        .mount(&app.profile)
        .await;
    // Grant oauth_login so the callback gate admits the user.
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/flags")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"oauth_login": true})))
        .mount(&app.profile)
        .await;

    let (s, _, _, location) = c
        .send(
            Method::GET,
            &format!("/auth/github/callback?code=fake&state={state}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(
        location, "/s/owner-handle/photos",
        "callback should resume the stashed share URL"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_grantee_minted_jwt_redirect() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;

    let owner_uid = Uuid::new_v4();
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let dsid = "a".repeat(64);
    mock_live_devserver(&app, owner_uid, "owner-handle", &dsid).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{dsid}/access"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;

    let (s, headers, _, location) = c.send(Method::GET, "/s/owner-handle/photos", None).await;
    assert_entry_handoff(s, &headers, &location);
    app.cleanup().await;
}

/// GET `uri` with the client's session cookie and read the entry handoff
/// page: the form action and the credential it POSTs.
async fn entry_handoff_page(c: &Client<'_>, uri: &str) -> (url::Url, String) {
    let mut builder = Request::builder().method(Method::GET).uri(uri);
    if let Some(cookie) = &c.cookie {
        builder = builder.header(header::COOKIE, cookie.clone());
    }
    let res = c
        .app
        .router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "{uri}");
    let page =
        String::from_utf8(to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap();
    let attribute = |prefix: &str| {
        let (_, rest) = page
            .split_once(prefix)
            .unwrap_or_else(|| panic!("{uri}: no {prefix} in {page}"));
        rest.split_once('"').unwrap().0.to_string()
    };
    let action = url::Url::parse(&attribute(r#"action=""#)).unwrap();
    (action, attribute(r#"name="credential" value=""#))
}

/// Verify a handoff credential as the proxy named in its form action would.
fn decode_handoff(
    action: &url::Url,
    credential: &str,
    devserver_id: &str,
    owner_user_id: Uuid,
) -> gateway_common::devserver_gate::Claims {
    use gateway_common::devserver_gate::{decode_entry, EntrySigner, EntryVerifierRing};
    let signer = EntrySigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
    let ring = EntryVerifierRing::from_base64_list(&signer.verifying_key_base64()).unwrap();
    decode_entry(
        &ring,
        credential,
        "p1",
        action.host_str().unwrap(),
        devserver_id,
        owner_user_id,
    )
    .expect("handoff credential verifies")
}

/// Mock one live devserver `dsid` of `owner-handle` that grants access, and
/// sign `caller` in, the profile answering for the caller as `username`.
async fn signed_in_with_a_shared_devserver<'a>(
    app: &'a TestApp,
    owner_uid: Uuid,
    dsid: &str,
    caller: Uuid,
    username: &str,
) -> Client<'a> {
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    mock_live_devserver(app, owner_uid, "owner-handle", dsid).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{dsid}/access"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;
    let mut c = Client::new(app);
    happy_login(app, &mut c, caller, &format!("{username}@x.com")).await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller,
            &format!("{username}@x.com"),
            username,
        )))
        .mount(&app.profile)
        .await;
    c
}

async fn assert_share_landing_denies_inactive_caller(uri: &str, owner_uid: Uuid, caller_uid: Uuid) {
    for missing in [false, true] {
        let app = TestApp::new().await;
        let dsid = "b".repeat(64);
        let mut c =
            signed_in_with_a_shared_devserver(&app, owner_uid, &dsid, caller_uid, "caller").await;
        let response = if missing {
            ResponseTemplate::new(404).set_body_json(json!({"error": "not found"}))
        } else {
            ResponseTemplate::new(200).set_body_json(blocked_user_body(caller_uid, "caller@x.com"))
        };
        Mock::given(method("GET"))
            .and(path(format!("/v1/users/{caller_uid}")))
            .respond_with(response)
            .with_priority(1)
            .mount(&app.profile)
            .await;

        let cookie = c.cookie.clone();
        let (status, headers, body, location) = c.send(Method::GET, uri, None).await;
        if status == StatusCode::OK {
            assert_entry_handoff(status, &headers, &location);
            let (action, credential) = entry_handoff_page(&c, uri).await;
            let claims = decode_handoff(&action, &credential, &dsid, owner_uid);
            assert_eq!(claims.sub, caller_uid);
            eprintln!("{uri}: inactive caller received a verified entry credential");
        }
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}, missing={missing}");
        assert_eq!(body, json!({"error": "not found"}));
        assert_eq!(
            c.cookie, cookie,
            "navigation must preserve the identity cookie"
        );
        app.cleanup().await;
    }
}

#[tokio::test]
async fn share_landing_denies_inactive_caller() {
    assert_share_landing_denies_inactive_caller(
        "/s/owner-handle/photos",
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await;
}

#[tokio::test]
async fn share_landing_root_denies_inactive_caller() {
    let owner_uid = Uuid::new_v4();
    assert_share_landing_denies_inactive_caller("/s/owner-handle", owner_uid, owner_uid).await;
}

/// Both share landings answer a signed-in browser's navigation, so every
/// credential they mint is for the browser client, whether the caller is a
/// grantee opening one workspace or the owner opening one workspace or the
/// whole devserver.
#[tokio::test]
async fn share_landings_mint_every_credential_for_the_browser_client() {
    let owner_uid = Uuid::new_v4();
    let dsid = "b".repeat(64);

    let app = TestApp::new().await;
    let grantee_uid = fake_user_id();
    let grantee =
        signed_in_with_a_shared_devserver(&app, owner_uid, &dsid, grantee_uid, "grantee").await;
    let (action, credential) = entry_handoff_page(&grantee, "/s/owner-handle/photos").await;
    let claims = decode_handoff(&action, &credential, &dsid, owner_uid);
    assert_eq!(claims.sub, grantee_uid);
    assert_eq!(claims.next_path, "/photos/");
    assert_eq!(
        claims.client,
        gateway_common::devserver_gate::ClientType::Browser
    );
    app.cleanup().await;

    let app = TestApp::new().await;
    let owner =
        signed_in_with_a_shared_devserver(&app, owner_uid, &dsid, owner_uid, "owner-handle").await;
    for uri in ["/s/owner-handle", "/s/owner-handle/photos"] {
        let (action, credential) = entry_handoff_page(&owner, uri).await;
        let claims = decode_handoff(&action, &credential, &dsid, owner_uid);
        assert_eq!(claims.sub, owner_uid, "{uri}");
        assert_eq!(
            claims.client,
            gateway_common::devserver_gate::ClientType::Browser,
            "{uri}"
        );
        assert_eq!(
            serde_json::to_value(&claims).unwrap()["client"],
            "browser",
            "{uri}"
        );
    }
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_root_unauthed_redirects_to_login() {
    // Whole-devserver open (/s/{owner}, no workspace) while signed out:
    // 303 to the login root, same as the per-workspace landing.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let (s, _, _, location) = c.send(Method::GET, "/s/owner-handle", None).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(location, "/");
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_root_owner_minted_jwt_redirect() {
    // Whole-devserver open is OWNER-ONLY: the owner opening their
    // OWN devserver (caller == owner) mints the entry JWT and redirects to
    // the proxy ROOT, where the launcher is served -- the per-workspace flow
    // minus the tenant path.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "owner@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    // `/s/owner-handle` resolves to the logged-in user → caller == owner.
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let dsid = "a".repeat(64);
    mock_live_devserver(&app, uid, "owner-handle", &dsid).await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/devservers/{dsid}/access")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;

    let (s, headers, _, location) = c.send(Method::GET, "/s/owner-handle", None).await;
    assert_entry_handoff(s, &headers, &location);
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_d_selector_picks_devserver() {
    // Two live devservers; `?d=` (the 12-hex disc) picks the second.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;
    let owner_uid = Uuid::new_v4();
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let ds1 = "a".repeat(64);
    let ds2 = "b".repeat(64);
    mock_live_devservers(&app, owner_uid, "owner-handle", &[&ds1, &ds2]).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{ds2}/access"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;

    let (s, headers, _, location) = c
        .send(
            Method::GET,
            &format!("/s/owner-handle/photos?d={}", &ds2[..12]),
            None,
        )
        .await;
    assert_entry_handoff(s, &headers, &location);
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_unknown_or_malformed_d_is_404() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;
    let owner_uid = Uuid::new_v4();
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    mock_live_devserver(&app, owner_uid, "owner-handle", &"a".repeat(64)).await;

    // Well-formed selector that matches no live devserver.
    let (s, _, _, _) = c
        .send(
            Method::GET,
            &format!("/s/owner-handle/photos?d={}", "f".repeat(12)),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // Malformed selector (non-hex): dead link, same 404 shape.
    let (s, _, _, _) = c
        .send(Method::GET, "/s/owner-handle/photos?d=not-hex", None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_multi_live_falls_back_to_first_accessible() {
    // No selector, two live devservers: the caller lands on the first
    // (sorted) one they can access -- here the grant is on the second.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;
    let owner_uid = Uuid::new_v4();
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let ds1 = "a".repeat(64);
    let ds2 = "b".repeat(64);
    mock_live_devservers(&app, owner_uid, "owner-handle", &[&ds1, &ds2]).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{ds1}/access"
        )))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "not found"})))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{ds2}/access"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;

    let (s, headers, _, location) = c.send(Method::GET, "/s/owner-handle/photos", None).await;
    assert_entry_handoff(s, &headers, &location);
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_node_base_outside_the_namespace_is_502() {
    // Fail-closed: a controller row identity cannot place under the
    // configured apex is an upstream error, never a mint against the
    // shared apex.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;
    let owner_uid = Uuid::new_v4();
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let dsid = "a".repeat(64);
    let now = chrono::Utc::now();
    let registration_id = Uuid::new_v4();
    let lease = devserver_control_proto::AdmissionLeaseSigner::from_base64(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    )
    .unwrap()
    .sign(
        devserver_control_proto::AdmissionLeaseBinding {
            owner_user_id: owner_uid,
            user: "owner-handle".into(),
            devserver_id: dsid.clone(),
            registration_id,
            proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
        },
        3,
        now,
        120,
    )
    .unwrap();
    Mock::given(method("GET"))
        .and(path(format!("/admin/v1/owners/{owner_uid}/tunnels")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "registration_id": registration_id,
            "owner_user_id": owner_uid,
            "user": "owner-handle",
            "devserver_id": dsid,
            "max_connected_devservers": 3,
            "peer_addr": null,
            "connected_at": now.to_rfc3339(),
            "proxy_id": "p1",
            "proxy_base_url": "https://p1.evil.example.net",
            "admission_lease": lease,
            "admission_lease_expires_at": (now + chrono::Duration::seconds(120)).to_rfc3339(),
        }])))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{dsid}/access"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;

    let (s, _, body, _) = c.send(Method::GET, "/s/owner-handle/photos", None).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "got {body}");
    assert_eq!(body, json!({"error": "upstream unreachable"}));
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_unknown_owner_skips_the_caller_lookup() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "not found"})))
        .mount(&app.profile)
        .await;

    let caller_path = format!("/v1/users/{caller_uid}");
    let before = profile_request_count(&app, "GET", &caller_path).await;
    let (status, _, body, _) = c.send(Method::GET, "/s/unknown-owner/photos", None).await;
    let after = profile_request_count(&app, "GET", &caller_path).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "not found"}));
    assert_eq!(
        after - before,
        0,
        "unknown owner must be refused before resolving the caller"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_root_grantee_denied() {
    // A grantee who can open a shared workspace must still not reach the
    // whole-devserver launcher. The owner-only gate keeps the refusal at the
    // same 404 shape as an unknown handle.
    let app = TestApp::new().await;
    let caller_uid = fake_user_id();
    let owner_uid = Uuid::new_v4();
    let mut c =
        signed_in_with_a_shared_devserver(&app, owner_uid, &"b".repeat(64), caller_uid, "grantee")
            .await;

    let caller_path = format!("/v1/users/{caller_uid}");
    let before = profile_request_count(&app, "GET", &caller_path).await;
    let (status, _, body, _) = c.send(Method::GET, "/s/owner-handle", None).await;
    let after = profile_request_count(&app, "GET", &caller_path).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "not found"}));
    assert_eq!(
        after - before,
        0,
        "root owner-only gate must fire before resolving the caller"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn share_landing_no_access_is_404() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "alice@x.com").await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{caller_uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            caller_uid,
            "alice@x.com",
            "alice",
        )))
        .mount(&app.profile)
        .await;
    let owner_uid = Uuid::new_v4();
    Mock::given(method("GET"))
        .and(path("/v1/users/by-username"))
        .respond_with(ResponseTemplate::new(200).set_body_json(live_user_body(
            owner_uid,
            "owner@x.com",
            "owner-handle",
        )))
        .mount(&app.profile)
        .await;
    let dsid = "a".repeat(64);
    mock_live_devserver(&app, owner_uid, "owner-handle", &dsid).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{owner_uid}/devservers/{dsid}/access"
        )))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "not found"})))
        .mount(&app.profile)
        .await;

    let (s, _, _, _) = c.send(Method::GET, "/s/owner-handle/photos", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Feature-flag gate at OAuth callback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn callback_denied_when_oauth_login_flag_off() {
    assert_flag_denial(false).await;
}

#[tokio::test]
async fn flag_lookup_failure_is_audited_as_failure_and_grants_no_session() {
    assert_flag_denial(true).await;
}

async fn assert_flag_denial(lookup_fails: bool) {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();

    // Walk the OAuth flow manually so we can install a flags mock
    // that returns oauth_login=false (default-off shape).
    let (_, _, _, location) = c.send(Method::GET, "/auth/github", None).await;
    let state = extract_state(&location);

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
            "email": "octo@example.com",
        })))
        .mount(&app.github)
        .await;
    let now = chrono::Utc::now().to_rfc3339();
    let user_body = json!({
        "id": uid,
        "email": "octo@example.com",
        "display_name": "Octo Cat",
        "username": format!("u{}", &uid.simple().to_string()[..12]),
        "username_edits": 0,
        "created_at": now,
        "updated_at": now,
    });
    Mock::given(method("POST"))
        .and(path("/v1/users/upsert-by-identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": user_body,
            "user_created": true,
            "identity_created": true,
        })))
        .mount(&app.profile)
        .await;
    // Flags mock: oauth_login disabled.
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/flags")))
        .respond_with(if lookup_fails {
            ResponseTemplate::new(503)
        } else {
            ResponseTemplate::new(200).set_body_json(json!({"oauth_login": false}))
        })
        .mount(&app.profile)
        .await;

    let (s, _, _, location) = c
        .send(
            Method::GET,
            &format!("/auth/github/callback?code=fake&state={state}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(location, "/?denied=oauth_login");

    // No session was granted: /api/me returns 401.
    let (s, _, _, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let requests = app.profile.received_requests().await.unwrap();
    let audit = requests
        .iter()
        .find(|r| r.url.path() == "/v1/auth-audit")
        .unwrap();
    let audit: Value = audit.body_json().unwrap();
    assert_eq!(audit["action"], "login_denied");
    assert_eq!(
        audit["note"],
        if lookup_fails {
            "oauth_login flag lookup failed"
        } else {
            "oauth_login flag not granted"
        }
    );
    app.cleanup().await;
}

#[tokio::test]
async fn me_includes_flags_map() {
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let uid = fake_user_id();
    happy_login(&app, &mut c, uid, "octo@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": uid,
            "email": "octo@example.com",
            "display_name": "Octo Cat",
            "username": format!("u{}", &uid.simple().to_string()[..12]),
            "username_edits": 0,
            "created_at": chrono::Utc::now().to_rfc3339(),
            "updated_at": chrono::Utc::now().to_rfc3339(),
        })))
        .mount(&app.profile)
        .await;

    let (s, _, body, _) = c.send(Method::GET, "/api/me", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["flags"]["oauth_login"], true);
    assert_eq!(body["flags"]["share_workspaces"], true);
    app.cleanup().await;
}

#[tokio::test]
async fn known_rename_conflicts_preserve_live_tunnels() {
    for exhausted in [false, true] {
        let app = TestApp::new().await;
        let mut c = Client::new(&app);
        let uid = fake_user_id();
        happy_login(&app, &mut c, uid, "octo@example.com").await;
        let now = chrono::Utc::now().to_rfc3339();
        let mut user = json!({"id": uid, "email": "octo@example.com", "display_name": null,
            "username": "old-handle", "username_edits": if exhausted { gateway_common::validators::MAX_USERNAME_EDITS } else { 0 },
            "created_at": now, "updated_at": now});
        Mock::given(method("GET"))
            .and(path(format!("/v1/users/{uid}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(&user))
            .mount(&app.profile)
            .await;
        user["id"] = json!(Uuid::new_v4());
        user["username"] = json!("new-handle");
        Mock::given(method("GET"))
            .and(path("/v1/users/by-username"))
            .respond_with(if exhausted {
                ResponseTemplate::new(404)
            } else {
                ResponseTemplate::new(200).set_body_json(user)
            })
            .mount(&app.profile)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/admin/v1/owners/{uid}/tunnels/kill")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"killed":1})))
            .mount(&app.profile)
            .await;
        Mock::given(method("PATCH"))
            .and(path(format!("/v1/users/{uid}/username")))
            .respond_with(
                ResponseTemplate::new(409).set_body_json(json!({"error":"rename conflict"})),
            )
            .mount(&app.profile)
            .await;
        let (status, _, _, _) = c
            .send(
                Method::PATCH,
                "/api/me/username",
                Some(json!({"username":"new-handle"})),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "exhausted={exhausted}");
        let requests = app.profile.received_requests().await.unwrap();
        assert!(!requests
            .iter()
            .any(|r| r.url.path().starts_with("/admin/v1/")));
        assert!(!requests.iter().any(|r| r.method == "PATCH"));
        app.cleanup().await;
    }
}

#[tokio::test]
async fn logout_audit_failure_is_logged_without_blocking_logout() {
    use std::io::Write;
    use std::sync::Mutex;
    use tracing::instrument::WithSubscriber;
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
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    happy_login(&app, &mut c, fake_user_id(), "octo@example.com").await;
    Mock::given(method("POST"))
        .and(path("/v1/auth-audit"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&app.profile)
        .await;
    let output = Arc::new(Mutex::new(Vec::new()));
    let writer = Capture(output.clone());
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let (status, _, _, _) = c
        .send(Method::POST, "/api/logout", None)
        .with_subscriber(subscriber)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let captured = String::from_utf8(output.lock().unwrap().clone()).unwrap();
    assert!(captured.contains("logout audit failed"), "{captured}");
    assert_eq!(
        c.send(Method::GET, "/api/me", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    app.cleanup().await;
}
