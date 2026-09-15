//! Integration tests for personal access tokens (PATs).
//!
//! Each test gets its own throwaway Postgres schema. Exercises the
//! `ApiTokenService` directly (create / validate / revoke / audit)
//! and the `/internal/v1/tokens/validate` endpoint over the live
//! router.

#[path = "../../../tests-shared/identity_config.rs"]
mod identity_config;
#[path = "../../../tests-shared/identity_db.rs"]
mod test_db;

use std::sync::Arc;

/// Default scope set for tests that don't care about scope content.
/// Matches the production default in
/// `identity::api_tokens::DEFAULT_TOKEN_SCOPES`.
fn default_scopes() -> Vec<String> {
    vec!["tunnel".to_string()]
}

/// Audit context with both fields populated, for tests asserting the
/// recorded ip / user_agent. Use `RequestMeta::default()` when the
/// test doesn't care.
fn meta(ip: &str, ua: &str) -> RequestMeta {
    RequestMeta {
        ip: Some(ip.to_string()),
        user_agent: Some(ua.to_string()),
    }
}

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use identity::api_tokens::{NewToken, RequestMeta, TokenOrigin};
use identity::config::Config;
use identity::http;
use identity::profile_client::ProfileClient;
use identity::providers::github::GitHubProvider;
use identity::token_throttle::TokenThrottle;

struct TestEnv {
    router: Router,
    public_router: Router,
    api_tokens: identity::api_tokens::ApiTokenService,
    schema: String,
    admin_url: String,
    pool: PgPool,
}

impl TestEnv {
    fn api_tokens_service(&self) -> &identity::api_tokens::ApiTokenService {
        &self.api_tokens
    }

    async fn new() -> Self {
        Self::new_with_policy_required(false).await
    }

    async fn new_with_policy_required(policy_required: bool) -> Self {
        let (url, schema, pool, store) =
            test_db::create_schema(test_db::MigrationOrder::GatewayFirst).await;

        // Minimal Config; nothing in the PAT endpoints reads OAuth
        // provider state. We still need a provider configured because
        // Config requires non-empty `providers`.
        let provider = GitHubProvider::new("client".into(), "secret".into()).expect("gh");
        let profile_client =
            ProfileClient::new("http://127.0.0.1:65535/".parse().unwrap(), "unused".into())
                .expect("profile client");

        let api_tokens = identity::api_tokens::ApiTokenService::with_admission_signer(
            pool.clone(),
            devserver_control_proto::AdmissionLeaseSigner::from_base64(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap(),
        )
        .with_policy_required(policy_required);
        let api_tokens_for_state = api_tokens.clone();
        let cfg = Arc::new(Config {
            providers: vec![Arc::new(provider)],
            ..identity_config::test_config(&url, profile_client)
        });
        let (public_router, internal_router) =
            http::routers(cfg, store, api_tokens_for_state, TokenThrottle::new());
        let router = public_router.clone().merge(internal_router);

        Self {
            router,
            public_router,
            api_tokens,
            schema,
            admin_url: url,
            pool,
        }
    }

    async fn cleanup(self) {
        self.pool.close().await;
        test_db::pg::drop_schema(&self.admin_url, &self.schema).await;
    }

    /// Insert a user row directly so PAT create has an FK target.
    async fn insert_user(&self) -> Uuid {
        let id = Uuid::new_v4();
        // username is NOT NULL since migration 0003. Mirror the
        // backfill shape so the row passes the unique index across
        // tests that insert multiple users.
        sqlx::query(
            "INSERT INTO users (id, email, username) VALUES \
             ($1, $2, 'u' || substr(replace($1::text, '-', ''), 1, 12))",
        )
        .bind(id)
        .bind(format!("{id}@example.com"))
        .execute(&self.pool)
        .await
        .expect("insert user");
        id
    }
}

async fn json_post(router: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, v)
}

async fn json_post_with_auth(
    router: &Router,
    uri: &str,
    bearer: &str,
    body: Value,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, v)
}

#[tokio::test]
async fn public_router_never_exposes_internal_token_validation() {
    let env = TestEnv::new().await;
    for path in ["/internal", "/internal/v1/tokens/validate"] {
        let (status, _) = json_post_with_auth(
            &env.public_router,
            path,
            "test-internal",
            json!({"token": "chan_pat_sentinel"}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "public path {path}");
    }
    env.cleanup().await;
}

#[tokio::test]
async fn pat_create_validate_revoke_audit() {
    let env = TestEnv::new().await;
    let uid = env.insert_user().await;

    let created = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "ci-runner",
                expires_at: None,
                scopes: &default_scopes(),
                origin: TokenOrigin::Spa,
            },
            &meta("10.0.0.1", "test-ua"),
        )
        .await
        .expect("create");
    assert!(created.secret.starts_with("chan_pat_"));
    assert_eq!(created.token.label, "ci-runner");

    // Validate succeeds, returns user_id + username, bumps last_used.
    let v = env
        .api_tokens_service()
        .validate(&created.secret, &meta("10.0.0.2", "tunneld"))
        .await
        .expect("validate");
    assert_eq!(v.user_id, uid);
    assert_eq!(v.token_id, created.token.id);
    assert!(v.username.starts_with('u'));

    // Revoke kills the token; subsequent validate is unauthorized.
    let revoked = env
        .api_tokens_service()
        .revoke(uid, created.token.id, &meta("10.0.0.1", "test-ua"))
        .await
        .expect("revoke");
    assert!(revoked);
    assert!(env
        .api_tokens_service()
        .validate(&created.secret, &RequestMeta::default())
        .await
        .is_err());

    // Audit log records all three actions in reverse chronological
    // order: created -> used -> revoked.
    let entries = env
        .api_tokens_service()
        .audit(uid, created.token.id, 50)
        .await
        .expect("audit");
    let actions: Vec<_> = entries.iter().map(|e| e.action.as_str()).collect();
    assert_eq!(actions, vec!["revoked", "used", "created"]);

    env.cleanup().await;
}

#[tokio::test]
async fn pat_validate_skips_blocked_user() {
    // Block-flag enforcement is the safety net on top of the
    // admin block path's auto-revoke: even an unrevoked token
    // stops working when the owner's row carries blocked_at.
    let env = TestEnv::new().await;
    let uid = env.insert_user().await;
    let created = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "ci",
                expires_at: None,
                scopes: &default_scopes(),
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("create");

    // Active path works.
    env.api_tokens_service()
        .validate(&created.secret, &RequestMeta::default())
        .await
        .expect("validate ok");

    // Set blocked_at directly (the admin endpoint lives in
    // profile-service; here we exercise the SQL guard).
    sqlx::query("UPDATE users SET blocked_at = now() WHERE id = $1")
        .bind(uid)
        .execute(&env.pool)
        .await
        .unwrap();

    let res = env
        .api_tokens_service()
        .validate(&created.secret, &RequestMeta::default())
        .await;
    assert!(res.is_err(), "blocked-user validate should fail");
    env.cleanup().await;
}

#[tokio::test]
async fn pat_policy_enforces_compatibility_required_user_and_fleet_states() {
    let env = TestEnv::new().await;
    let uid = env.insert_user().await;
    let scopes = default_scopes();
    let created = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "compat",
                expires_at: None,
                scopes: &scopes,
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("missing policy remains compatible by default");

    sqlx::query(
        "INSERT INTO devserver_user_policies \
         (user_id, enabled, max_connected_devservers) VALUES ($1, true, 3)",
    )
    .bind(uid)
    .execute(&env.pool)
    .await
    .unwrap();
    let registration_id = Uuid::new_v4();
    let validated = env
        .api_tokens_service()
        .validate_for_admission(
            &created.secret,
            devserver_control_proto::ProxyId::parse("p1").unwrap(),
            registration_id,
            &RequestMeta::default(),
        )
        .await
        .expect("enabled policy validates");
    let lease = validated.admission_lease.expect("signed lease");
    let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    )
    .unwrap();
    let verifier = devserver_control_proto::AdmissionLeaseVerifier::from_base64(
        &signer.verifying_key_base64(),
    )
    .unwrap();
    let claims = verifier.verify(&lease, chrono::Utc::now()).unwrap();
    assert_eq!(claims.max_connected_devservers, 3);
    assert_eq!(claims.binding.registration_id, registration_id);

    sqlx::query("UPDATE devserver_user_policies SET enabled = false WHERE user_id = $1")
        .bind(uid)
        .execute(&env.pool)
        .await
        .unwrap();
    assert!(matches!(
        env.api_tokens_service()
            .create(
                NewToken {
                    user_id: uid,
                    label: "disabled",
                    expires_at: None,
                    scopes: &scopes,
                    origin: TokenOrigin::Spa,
                },
                &RequestMeta::default(),
            )
            .await,
        Err(identity::error::Error::DevserverAccessDisabled)
    ));
    assert!(matches!(
        env.api_tokens_service()
            .validate(&created.secret, &RequestMeta::default())
            .await,
        Err(identity::error::Error::Unauthorized)
    ));

    sqlx::query("UPDATE devserver_user_policies SET enabled = true WHERE user_id = $1")
        .bind(uid)
        .execute(&env.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devserver_fleet_policy SET admissions_enabled = false")
        .execute(&env.pool)
        .await
        .unwrap();
    assert!(matches!(
        env.api_tokens_service()
            .create(
                NewToken {
                    user_id: uid,
                    label: "paused",
                    expires_at: None,
                    scopes: &scopes,
                    origin: TokenOrigin::Admin,
                },
                &RequestMeta::default(),
            )
            .await,
        Err(identity::error::Error::AdminDevserverAccessDisabled)
    ));
    assert!(matches!(
        env.api_tokens_service()
            .validate(&created.secret, &RequestMeta::default())
            .await,
        Err(identity::error::Error::Unauthorized)
    ));
    env.cleanup().await;

    let required = TestEnv::new_with_policy_required(true).await;
    let uid = required.insert_user().await;
    assert!(matches!(
        required
            .api_tokens_service()
            .create(
                NewToken {
                    user_id: uid,
                    label: "missing",
                    expires_at: None,
                    scopes: &scopes,
                    origin: TokenOrigin::Spa,
                },
                &RequestMeta::default(),
            )
            .await,
        Err(identity::error::Error::DevserverAccessDisabled)
    ));
    required.cleanup().await;
}

#[tokio::test]
async fn pat_expired_is_unauthorized() {
    let env = TestEnv::new().await;
    let uid = env.insert_user().await;

    let past = chrono::Utc::now() - chrono::Duration::seconds(60);
    let created = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "stale",
                expires_at: Some(past),
                scopes: &default_scopes(),
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("create");
    assert!(env
        .api_tokens_service()
        .validate(&created.secret, &RequestMeta::default())
        .await
        .is_err());
    env.cleanup().await;
}

#[tokio::test]
async fn pat_audit_scoped_to_owner() {
    let env = TestEnv::new().await;
    let alice = env.insert_user().await;
    let bob = env.insert_user().await;

    let alice_token = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: alice,
                label: "a",
                expires_at: None,
                scopes: &default_scopes(),
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("create");

    // Bob asking for Alice's token audit must 404, not leak rows.
    let res = env
        .api_tokens_service()
        .audit(bob, alice_token.token.id, 50)
        .await;
    assert!(matches!(res, Err(identity::error::Error::NotFound)));

    // Bob revoking Alice's token returns false (no row matched);
    // Alice's token continues to validate.
    let revoked = env
        .api_tokens_service()
        .revoke(bob, alice_token.token.id, &RequestMeta::default())
        .await
        .expect("revoke call");
    assert!(!revoked);
    assert!(env
        .api_tokens_service()
        .validate(&alice_token.secret, &RequestMeta::default())
        .await
        .is_ok());

    env.cleanup().await;
}

#[tokio::test]
async fn pat_validate_endpoint_requires_internal_bearer() {
    let env = TestEnv::new().await;
    let uid = env.insert_user().await;

    let created = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "tunnel",
                expires_at: None,
                scopes: &default_scopes(),
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("create");
    let registration_id = Uuid::new_v4();

    // Missing bearer is rejected.
    let (s, _) = json_post(
        &env.router,
        "/internal/v1/tokens/validate",
        json!({"token": created.secret}),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // Wrong bearer is rejected.
    let (s, _) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "wrong",
        json!({"token": created.secret}),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // Correct bearer succeeds and returns user_id + username.
    let (s, v) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": created.secret, "registration_id": registration_id, "proxy_id": "p1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["user_id"].as_str().unwrap(), uid.to_string());
    // The response carries the devserver identity (lowercase hex
    // SHA-256 of the PAT). devserver-proxy keys the registry + drv on it.
    let ds = v["devserver_id"].as_str().expect("devserver_id present");
    assert_eq!(ds.len(), 64);
    assert!(ds.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));

    // Garbage token gets unauthorized, not bad-request, so callers
    // can't probe shape.
    let (s, _) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": "not-a-pat"}),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    env.cleanup().await;
}

#[tokio::test]
async fn pat_validate_endpoint_accepts_display_name() {
    // The tunnel name announce rides the validate exchange as an
    // optional `name` (devserver-proxy's post-registration follow-up).
    // The label refresh through profile is best-effort -- TestEnv's
    // profile client points at a dead port -- so the exchange itself
    // must answer 200 with the unchanged response shape regardless.
    let env = TestEnv::new().await;
    let uid = env.insert_user().await;

    let created = env
        .api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "tunnel",
                expires_at: None,
                scopes: &default_scopes(),
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("create");

    let (s, v) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": created.secret, "name": "office box", "registration_id": Uuid::new_v4(), "proxy_id": "p1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["user_id"].as_str().unwrap(), uid.to_string());
    assert!(v["devserver_id"].as_str().is_some());

    env.cleanup().await;
}
