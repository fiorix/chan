//! Integration tests for the `/admin/v1/tokens` operator surface.
//!
//! Each test gets its own throwaway Postgres schema. No OAuth or
//! profile mocks: the surface is bearer-authed, and the post-mint
//! devserver registration is best-effort (the profile client points
//! at a closed port here, so that hop fails and must not fail the
//! mint).

#[path = "../../../tests-shared/pg_reaper.rs"]
mod pg_reaper;

use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::json;
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower::ServiceExt;
use tower_sessions_sqlx_store::PostgresStore;
use uuid::Uuid;

use identity::api_tokens::{ApiTokenService, RequestMeta};
use identity::config::Config;
use identity::http;
use identity::profile_client::ProfileClient;

const ADMIN_TOKEN: &str = "test-identity-admin-token";

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
}

impl TestApp {
    /// `admin_token` becomes IDENTITY_ADMIN_TOKEN; empty = surface
    /// disabled. Port 1 is never listening: the best-effort devserver
    /// registration hop fails fast and the mint must survive it.
    async fn new(admin_token: &str) -> Self {
        Self::with_profile(admin_token, "http://127.0.0.1:1/").await
    }

    /// Like [`Self::new`], but the ProfileClient points at
    /// `profile_url`. The operator revoke's profile hop is not
    /// best-effort, so its tests pass a live stub here.
    async fn with_profile(admin_token: &str, profile_url: &str) -> Self {
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

        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .expect("migrate identity tables");

        let api_tokens = ApiTokenService::new(pool.clone());

        let profile_client = ProfileClient::new(profile_url.parse().unwrap(), "unused".into())
            .expect("profile client");

        let cfg = Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            internal_bind_addr: "127.0.0.1:0".parse().unwrap(),
            base_url: "http://localhost:7000/".parse().unwrap(),
            devserver_proxy_origin: "https://proxy.example.test".parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
            database_url: url.clone(),
            cookie_secure: true,
            profile_client,
            internal_auth_token: "test-internal".to_string(),
            session_internal_auth_token: "test-session-internal".to_string(),
            identity_admin_token: admin_token.to_string(),
            account_admin_token: "test-account-admin".to_string(),
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
            providers: vec![],
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
        }
    }

    async fn cleanup(self) {
        let admin = admin_pool(&self.admin_url).await;
        let _ = sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema))
            .execute(&admin)
            .await;
        admin.close().await;
    }

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

/// POST /admin/v1/tokens with an optional bearer; returns (status,
/// parsed JSON body or null).
async fn post_tokens(
    app: &TestApp,
    bearer: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri("/admin/v1/tokens")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(b) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    let req = builder.body(Body::from(body.to_string())).unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, v)
}

/// Minimal live stand-in for profile's admin surface: records the
/// token ids POSTed to `/v1/admin/tokens/{id}/revoke` and answers
/// 202. Profile's real transaction is covered by profile's own suite;
/// these tests assert the boundary call. Every other path 404s, which
/// keeps the post-mint devserver registration hop best-effort.
async fn spawn_profile_stub() -> (String, Arc<Mutex<Vec<Uuid>>>) {
    let hits: Arc<Mutex<Vec<Uuid>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = hits.clone();
    let app = Router::new().route(
        "/v1/admin/tokens/{id}/revoke",
        axum::routing::post(move |axum::extract::Path(id): axum::extract::Path<Uuid>| {
            let recorded = recorded.clone();
            async move {
                recorded.lock().unwrap().push(id);
                StatusCode::ACCEPTED
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/"), hits)
}

/// POST /admin/v1/tokens/{token_id}/revoke with an optional bearer.
async fn post_revoke(app: &TestApp, bearer: Option<&str>, token_id: &str) -> StatusCode {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(format!("/admin/v1/tokens/{token_id}/revoke"));
    if let Some(b) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    let req = builder.body(Body::empty()).unwrap();
    app.router.clone().oneshot(req).await.unwrap().status()
}

#[tokio::test]
async fn admin_mint_happy_path_secret_validates_and_audits() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    let uid = Uuid::new_v4();
    // Mixed-case row, lower-case query: the lookup is
    // case-insensitive on both sides.
    app.insert_user(uid, "Provision@Example.com").await;

    let (status, body) = post_tokens(
        &app,
        Some(ADMIN_TOKEN),
        json!({
            "email": "provision@example.com",
            "scopes": ["tunnel"],
            "label": "ci runner",
            "expires_days": 30,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let secret = body["secret"].as_str().expect("secret once");
    assert!(secret.starts_with("chan_pat_"), "{body}");
    assert_eq!(body["label"], "ci runner");
    assert_eq!(body["scopes"], json!(["tunnel"]));
    assert!(body["expires_at"].is_string(), "{body}");
    let token_id: Uuid = body["id"].as_str().unwrap().parse().expect("uuid id");

    // The minted secret round-trips through the normal validation
    // path and belongs to the resolved user.
    let validated = app
        .api_tokens
        .validate(secret, &RequestMeta::default())
        .await
        .expect("minted PAT validates");
    assert_eq!(validated.user_id, uid);
    assert_eq!(validated.token_id, token_id);

    let entries = app
        .api_tokens
        .audit(uid, token_id, 10)
        .await
        .expect("audit");
    let mut actions: Vec<_> = entries.iter().map(|e| e.action.as_str()).collect();
    actions.sort_unstable();
    assert_eq!(actions, vec!["created_via_admin", "used"]);

    app.cleanup().await;
}

#[tokio::test]
async fn admin_mint_defaults_to_tunnel_scope_and_no_expiry() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "minimal@example.com").await;

    let (status, body) = post_tokens(
        &app,
        Some(ADMIN_TOKEN),
        json!({ "email": "minimal@example.com" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["scopes"], json!(["tunnel"]));
    assert!(body["expires_at"].is_null(), "{body}");

    app.cleanup().await;
}

#[tokio::test]
async fn admin_mint_unknown_email_is_404() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    let (status, body) = post_tokens(
        &app,
        Some(ADMIN_TOKEN),
        json!({ "email": "nobody@example.com" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    app.cleanup().await;
}

#[tokio::test]
async fn admin_mint_bad_scope_is_400() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "scopes@example.com").await;

    // Same shape validation the SPA mint runs: untrimmed, blank, and
    // duplicate scopes are each a 400.
    for scopes in [json!([" tunnel"]), json!([""]), json!(["tunnel", "tunnel"])] {
        let (status, body) = post_tokens(
            &app,
            Some(ADMIN_TOKEN),
            json!({ "email": "scopes@example.com", "scopes": scopes }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{scopes}: {body}");
    }

    app.cleanup().await;
}

#[tokio::test]
async fn admin_mint_requires_the_exact_bearer() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "bearer@example.com").await;

    for bearer in [None, Some("wrong-token")] {
        let (status, body) =
            post_tokens(&app, bearer, json!({ "email": "bearer@example.com" })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{bearer:?}: {body}");
    }
    // Nothing was minted along the way.
    let tokens = app.api_tokens.list(uid).await.expect("list");
    assert!(tokens.is_empty());

    app.cleanup().await;
}

#[tokio::test]
async fn admin_surface_disabled_when_token_empty() {
    let app = TestApp::new("").await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "disabled@example.com").await;

    // Even a caller presenting some bearer gets 404: the surface does
    // not exist on deployments that never set IDENTITY_ADMIN_TOKEN.
    let (status, _body) = post_tokens(
        &app,
        Some("anything"),
        json!({ "email": "disabled@example.com" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let tokens = app.api_tokens.list(uid).await.expect("list");
    assert!(tokens.is_empty());

    app.cleanup().await;
}

#[tokio::test]
async fn admin_revoke_hits_profile_and_is_retry_safe() {
    let (profile_url, hits) = spawn_profile_stub().await;
    let app = TestApp::with_profile(ADMIN_TOKEN, &profile_url).await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "revoke@example.com").await;

    let (status, body) = post_tokens(
        &app,
        Some(ADMIN_TOKEN),
        json!({ "email": "revoke@example.com" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let token_id: Uuid = body["id"].as_str().unwrap().parse().unwrap();

    // The durable revoke is profile's; identity forwards exactly the
    // requested id. The tunnel/session first cut points at a closed
    // port here and must stay best-effort.
    let status = post_revoke(&app, Some(ADMIN_TOKEN), &token_id.to_string()).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(*hits.lock().unwrap(), vec![token_id]);

    // A retry forwards again; profile owns the no-op semantics.
    let status = post_revoke(&app, Some(ADMIN_TOKEN), &token_id.to_string()).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(*hits.lock().unwrap(), vec![token_id, token_id]);

    app.cleanup().await;
}

#[tokio::test]
async fn admin_revoke_unknown_token_is_404() {
    let (profile_url, hits) = spawn_profile_stub().await;
    let app = TestApp::with_profile(ADMIN_TOKEN, &profile_url).await;

    let status = post_revoke(&app, Some(ADMIN_TOKEN), &Uuid::new_v4().to_string()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The owner lookup gates the forward: nothing reached profile.
    assert!(hits.lock().unwrap().is_empty());

    app.cleanup().await;
}

#[tokio::test]
async fn admin_revoke_requires_the_exact_bearer() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    for bearer in [None, Some("wrong-token")] {
        let status = post_revoke(&app, bearer, &Uuid::new_v4().to_string()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{bearer:?}");
    }
    app.cleanup().await;
}

#[tokio::test]
async fn admin_revoke_disabled_surface_is_404() {
    let app = TestApp::new("").await;
    let status = post_revoke(&app, Some("anything"), &Uuid::new_v4().to_string()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}
