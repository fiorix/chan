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
use std::time::{Duration, Instant};

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

use tokio::sync::mpsc;
use wiremock::matchers::{method as mock_method, path as mock_path};
use wiremock::{Mock, MockServer, Request as MockRequest, Respond, ResponseTemplate};

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
    profile: Option<MockServer>,
}

impl TestEnv {
    fn api_tokens_service(&self) -> &identity::api_tokens::ApiTokenService {
        &self.api_tokens
    }

    async fn new() -> Self {
        Self::build(false, None).await
    }

    async fn new_with_policy_required(policy_required: bool) -> Self {
        Self::build(policy_required, None).await
    }

    /// A `TestEnv` whose profile client points at a wiremock server, so
    /// a test can read back what identity posted to profile. The other
    /// constructors aim it at a closed port on purpose: what they
    /// exercise must hold even when profile never answers.
    async fn with_profile_mock() -> Self {
        Self::build(false, Some(MockServer::start().await)).await
    }

    async fn build(policy_required: bool, profile: Option<MockServer>) -> Self {
        let (url, schema, pool, store) =
            test_db::create_schema(test_db::MigrationOrder::GatewayFirst).await;

        // Minimal Config; nothing in the PAT endpoints reads OAuth
        // provider state. We still need a provider configured because
        // Config requires non-empty `providers`.
        let provider = GitHubProvider::new("client".into(), "secret".into()).expect("gh");
        let profile_uri = match &profile {
            Some(server) => server.uri(),
            None => "http://127.0.0.1:65535/".to_string(),
        };
        let profile_client = ProfileClient::new(profile_uri.parse().unwrap(), "unused".into())
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
            profile,
        }
    }

    fn profile(&self) -> &MockServer {
        self.profile.as_ref().expect("built with a profile mock")
    }

    /// Mount profile's devserver-row route for `uid`, answering every
    /// ensure with `template`, and hand back the stream of ensures
    /// identity posts to it.
    async fn row_ensures(&self, uid: Uuid, template: ResponseTemplate) -> RowEnsures {
        let (posts, received) = mpsc::unbounded_channel();
        Mock::given(mock_method("POST"))
            .and(mock_path(format!("/v1/users/{uid}/devservers")))
            .respond_with(RowEnsureResponder { posts, template })
            .mount(self.profile())
            .await;
        RowEnsures { received }
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

/// Bound on every wait for a row ensure. The ensure runs on a task the
/// validate response does not wait for, so a test waits for the POST
/// instead of reading a count the moment the response lands, and the
/// bound turns a hop that never happens into a failure rather than a
/// hang.
const ROW_ENSURE_BOUND: Duration = Duration::from_secs(30);

/// Answers profile's devserver-row route and hands each ensure's JSON
/// body to the test as it arrives, which is before any response delay
/// the template carries.
struct RowEnsureResponder {
    posts: mpsc::UnboundedSender<Value>,
    template: ResponseTemplate,
}

impl Respond for RowEnsureResponder {
    fn respond(&self, request: &MockRequest) -> ResponseTemplate {
        let body = serde_json::from_slice(&request.body).expect("json request body");
        let _ = self.posts.send(body);
        self.template.clone()
    }
}

/// The devserver-row ensures profile received, in arrival order.
struct RowEnsures {
    received: mpsc::UnboundedReceiver<Value>,
}

impl RowEnsures {
    /// The next ensure, or a failure once [`ROW_ENSURE_BOUND`] passes.
    async fn next(&mut self) -> Value {
        tokio::time::timeout(ROW_ENSURE_BOUND, self.received.recv())
            .await
            .expect("profile received no devserver row ensure within the bound")
            .expect("row ensure channel stays open")
    }

    /// Every ensure that has already arrived beyond the ones read.
    fn drain(&mut self) -> Vec<Value> {
        let mut rest = Vec::new();
        while let Ok(post) = self.received.try_recv() {
            rest.push(post);
        }
        rest
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

/// Mint a PAT carrying `scopes` for `uid` and return its raw secret.
async fn pat_with_scopes(env: &TestEnv, uid: Uuid, scopes: &[&str]) -> String {
    let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_string()).collect();
    env.api_tokens_service()
        .create(
            NewToken {
                user_id: uid,
                label: "tunnel",
                expires_at: None,
                scopes: &scopes,
                origin: TokenOrigin::Spa,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("create pat")
        .secret
}

/// A `create_devserver` 201 body, as profile answers it.
fn devserver_row(uid: Uuid, devserver_id: &str, label: &str) -> Value {
    json!({
        "id": Uuid::new_v4(),
        "owner_user_id": uid,
        "devserver_id": devserver_id,
        "label": label,
        "created_at": chrono::Utc::now().to_rfc3339(),
    })
}

#[tokio::test]
async fn admission_validate_registers_the_devserver_row() {
    // The admission validate is the tunnel's own dial and its lease
    // refresh. Identity holds the raw PAT, so it is the only party that
    // can name the devserver id, and profile's `devserver_access`
    // refuses even the owner entry to a devserver with no row: a dial
    // that announces no name must therefore still get one, label-less.
    // The announced name arrives on a separate validate moments later
    // and labels the same row.
    let env = TestEnv::with_profile_mock().await;
    let uid = env.insert_user().await;
    let secret = pat_with_scopes(&env, uid, &["tunnel"]).await;
    let mut ensures = env
        .row_ensures(
            uid,
            ResponseTemplate::new(201).set_body_json(devserver_row(uid, "", "")),
        )
        .await;

    let (s, v) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": secret, "registration_id": Uuid::new_v4(), "proxy_id": "p1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let devserver_id = v["devserver_id"]
        .as_str()
        .expect("devserver_id")
        .to_string();

    let post = ensures.next().await;
    assert_eq!(post["devserver_id"], devserver_id);
    assert_eq!(post["label"], "", "a nameless dial gets a label-less row");
    let extra = ensures.drain();
    assert!(
        extra.is_empty(),
        "one row ensure per admission validate, got {extra:?}"
    );

    env.cleanup().await;
}

#[tokio::test]
async fn name_announce_validate_labels_the_devserver_row() {
    // devserver-proxy forwards the tunnel `Hello` name on a second
    // validate once the registration is accepted. That call carries no
    // proxy_id, and it must still reach profile with the announced
    // label, whichever of the two validates lands first.
    let env = TestEnv::with_profile_mock().await;
    let uid = env.insert_user().await;
    let secret = pat_with_scopes(&env, uid, &["tunnel"]).await;
    let mut ensures = env
        .row_ensures(
            uid,
            ResponseTemplate::new(200).set_body_json(devserver_row(uid, "", "office box")),
        )
        .await;

    let (s, v) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": secret, "name": "office box"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let devserver_id = v["devserver_id"]
        .as_str()
        .expect("devserver_id")
        .to_string();

    let post = ensures.next().await;
    assert_eq!(post["devserver_id"], devserver_id);
    assert_eq!(post["label"], "office box");
    let extra = ensures.drain();
    assert!(
        extra.is_empty(),
        "one row ensure per validate, got {extra:?}"
    );

    env.cleanup().await;
}

#[tokio::test]
async fn admission_validate_without_the_tunnel_scope_registers_nothing() {
    // A PAT that cannot dial can never appear in the tunnel registry,
    // so a row for its id would be a phantom on the dashboard and in
    // the desktop roster. The validate itself still succeeds: the
    // tunnel-server, not this route, refuses the dial. A dialling PAT
    // of the same owner validates second and gives the assertion an
    // ensure to wait for on the same route: the scopeless validate's
    // ensure, had the scope gate let it through, was spawned first and
    // would be the POST waiting here.
    let env = TestEnv::with_profile_mock().await;
    let uid = env.insert_user().await;
    let scopeless = pat_with_scopes(&env, uid, &["desktop.account"]).await;
    let dialling = pat_with_scopes(&env, uid, &["tunnel"]).await;
    let mut ensures = env
        .row_ensures(
            uid,
            ResponseTemplate::new(201).set_body_json(devserver_row(uid, "", "")),
        )
        .await;

    let (s, _) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": scopeless, "registration_id": Uuid::new_v4(), "proxy_id": "p1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let (s, v) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": dialling, "registration_id": Uuid::new_v4(), "proxy_id": "p1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let dialling_id = v["devserver_id"]
        .as_str()
        .expect("devserver_id")
        .to_string();

    let post = ensures.next().await;
    assert_eq!(
        post["devserver_id"], dialling_id,
        "the first ensure is the dialling PAT's"
    );
    let extra = ensures.drain();
    assert!(
        extra.is_empty(),
        "a PAT without the tunnel scope registers no row, got {extra:?}"
    );

    env.cleanup().await;
}

/// Longer than the profile client's own total timeout (10 s, set in
/// `gateway_common::profile_client`), so the stalled ensure cannot
/// answer at all while the test runs.
const PROFILE_STALL: Duration = Duration::from_secs(20);

/// What devserver-proxy's `IdentityValidator` gives the whole validate
/// exchange. A validate slower than this is a 502 on the dial and a
/// refused lease refresh on a live tunnel.
const PROXY_VALIDATE_BUDGET: Duration = Duration::from_secs(5);

#[tokio::test]
async fn a_stalled_profile_does_not_hold_the_admission_validate() {
    // Every dial and every 60 s lease refresh of a live tunnel comes
    // through this route on devserver-proxy's budget, and a lease that
    // lapses closes the tunnel. The row ensure is a profile hop on a
    // longer bound than that budget, so it runs detached: profile
    // accepting the POST and answering far too late leaves the validate
    // answering at once with the lease its caller needs.
    let env = TestEnv::with_profile_mock().await;
    let uid = env.insert_user().await;
    let secret = pat_with_scopes(&env, uid, &["tunnel"]).await;
    let mut ensures = env
        .row_ensures(
            uid,
            ResponseTemplate::new(201)
                .set_body_json(devserver_row(uid, "", ""))
                .set_delay(PROFILE_STALL),
        )
        .await;

    let started = Instant::now();
    let (s, v) = json_post_with_auth(
        &env.router,
        "/internal/v1/tokens/validate",
        "test-internal",
        json!({"token": secret, "registration_id": Uuid::new_v4(), "proxy_id": "p1"}),
    )
    .await;
    let elapsed = started.elapsed();
    assert_eq!(s, StatusCode::OK);
    assert!(
        elapsed < PROXY_VALIDATE_BUDGET,
        "validate answered in {elapsed:?}, past devserver-proxy's {PROXY_VALIDATE_BUDGET:?}"
    );

    // The normal admission body, not a degraded one.
    assert_eq!(v["user_id"], uid.to_string());
    assert_eq!(v["scopes"], json!(["tunnel"]));
    let devserver_id = v["devserver_id"]
        .as_str()
        .expect("devserver_id")
        .to_string();
    assert!(!v["admission_lease"]
        .as_str()
        .expect("admission_lease")
        .is_empty());
    assert!(v["admission_lease_expires_at"].is_string());

    // The row is still ensured: profile holds the POST, it just has not
    // answered it.
    let post = ensures.next().await;
    assert_eq!(post["devserver_id"], devserver_id);
    assert_eq!(post["label"], "");

    env.cleanup().await;
}
