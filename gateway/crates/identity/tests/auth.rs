//! Integration tests for identity-service.
//!
//! Each test gets:
//! - its own throwaway Postgres schema (for tower-sessions);
//! - a wiremock-backed profile-service;
//! - a wiremock-backed GitHub (token + user + emails endpoints).
//!
//! Set `TEST_DATABASE_URL` to a database the test process can
//! create schemas in (same as `profile`'s tests).

#[path = "../../../tests-shared/pg_reaper.rs"]
mod pg_reaper;

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};

/// Single-connection admin pool -- see profile-tests for the
/// rationale (default pool size * parallel tests blows past
/// Postgres' max_connections).
async fn admin_pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await
        .expect("connect admin")
}
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
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must be set; e.g. postgres://localhost/chan_gateway_test");
        // Reap leaked connections from prior test-process runs and
        // hold one slot for the rest of this process. See module
        // doc on `pg_reaper`.
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

        // Run our own migrations so api_tokens / users exist in this
        // test schema; tower-sessions only handles its own table.
        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .expect("migrate identity tables");

        let api_tokens = identity::api_tokens::ApiTokenService::new(pool.clone());

        let cfg = Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            internal_bind_addr: "127.0.0.1:0".parse().unwrap(),
            base_url,
            devserver_proxy_origin: "https://usr.chan.app".parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
            database_url: url.clone(),
            cookie_secure: true,
            profile_client,
            internal_auth_token: "test-internal".to_string(),
            identity_admin_token: "test-identity-admin".to_string(),
            // Point the proxy-admin client at the same mock server; its
            // /admin/v1/* paths don't collide with profile's /v1/users/*.
            // Tests that need a live devserver mock the tunnel list (see
            // `mock_live_devserver`); the rest get an empty list via the
            // no-match error path, which `me` tolerates.
            workspace_admin: DevserverControlClient::new(
                profile.uri().parse().unwrap(),
                "test-admin".into(),
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
        let admin = admin_pool(&self.admin_url).await;
        let _ = sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema))
            .execute(&admin)
            .await;
        admin.close().await;
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
        "test-internal",
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
    assert_eq!(value("referrer-policy"), Some("no-referrer"));
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
        "test-internal",
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
        "test-identity-admin",
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
        "test-identity-admin",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(revoked["oauth_sessions_revoked"], 1);
    let (status, retried) = authenticated_json(
        &app.router,
        Method::POST,
        &format!("/admin/v1/sessions/{admin_session_id}/revoke"),
        "test-identity-admin",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retried["oauth_sessions_revoked"], 0);
    let (status, _) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        "test-internal",
        Some(json!({"session": raw_session})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = authenticated_json(
        &app.router,
        Method::POST,
        "/internal/v1/sessions/whoami",
        "test-internal",
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
async fn composite_policy_and_fleet_retries_converge_after_partial_drain() {
    let app = TestApp::new().await;
    let user_id = fake_user_id();

    mock_policy_update_round(&app, user_id, 3, 1, StatusCode::BAD_GATEWAY).await;
    let (status, report) = authenticated_json(
        &app.router,
        Method::PUT,
        &format!("/admin/v1/users/{user_id}/devserver-policy"),
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
        "test-identity-admin",
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
                "proxy_base_url": "https://p1.usr.chan.app",
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
async fn share_landing_root_grantee_denied() {
    // Owner-only gate: a GRANTEE (caller != owner) does NOT get
    // whole-devserver open -- they keep the per-workspace share landing. 404
    // (same shape as unknown-handle) so it can't probe ownership. The gate
    // fires before any devserver lookup, so no live-devserver/access mocks.
    let app = TestApp::new().await;
    let mut c = Client::new(&app);
    let caller_uid = fake_user_id();
    happy_login(&app, &mut c, caller_uid, "grantee@x.com").await;
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

    let (s, _, _, _) = c.send(Method::GET, "/s/owner-handle", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
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
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"oauth_login": false})))
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
