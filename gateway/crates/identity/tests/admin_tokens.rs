//! Integration tests for the `/admin/v1/tokens` operator surface.
//!
//! Each test gets its own throwaway Postgres schema. No OAuth or
//! profile mocks: the surface is bearer-authed, and the post-mint
//! devserver registration is best-effort (the profile client points
//! at a closed port here, so that hop fails and must not fail the
//! mint).

#[path = "../../../tests-shared/identity_config.rs"]
mod identity_config;
#[path = "../../../tests-shared/identity_db.rs"]
mod test_db;

use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use identity::api_tokens::{ApiTokenService, RequestMeta};
use identity::config::Config;
use identity::http;
use identity::profile_client::ProfileClient;

const ADMIN_TOKEN: &str = "test-identity-admin-token";

struct TestApp {
    router: Router,
    api_tokens: ApiTokenService,
    pool: PgPool,
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
        let (url, schema, pool, store) =
            test_db::create_schema(test_db::MigrationOrder::SessionsFirst).await;

        let api_tokens = ApiTokenService::new(pool.clone());

        let profile_client = ProfileClient::new(profile_url.parse().unwrap(), "unused".into())
            .expect("profile client");

        let cfg = Arc::new(Config {
            identity_admin_token: admin_token.to_string(),
            account_admin_token: "test-account-admin".to_string(),
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
        }
    }

    async fn cleanup(self) {
        self.pool.close().await;
        test_db::pg::drop_schema(&self.admin_url, &self.schema).await;
    }

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
async fn admin_mint_rejects_overflowing_expiry() {
    let app = TestApp::new(ADMIN_TOKEN).await;
    app.insert_user(Uuid::new_v4(), "overflow@example.com")
        .await;

    let (status, body) = post_tokens(
        &app,
        Some(ADMIN_TOKEN),
        json!({"email": "overflow@example.com", "expires_days": u32::MAX}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid expires_in");
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
