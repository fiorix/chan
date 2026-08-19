//! End-to-end tests against a real Postgres.
//!
//! Set `TEST_DATABASE_URL` to a database the test process can create
//! schemas in. Each test gets its own throwaway schema, so tests are
//! independent and can run in parallel.

#[path = "../../../tests-shared/pg_reaper.rs"]
mod pg_reaper;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};

/// Single-connection admin pool. `PgPool::connect` defaults to
/// max_connections=10; multiplied by ~17 parallel tests (each
/// opening admin pools twice -- once on setup, once on cleanup)
/// blows past a default Postgres `max_connections=100`. Capping
/// admin to one keeps per-test peak demand well under that cap.
async fn admin_pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await
        .expect("connect admin")
}
use tower::ServiceExt;
use uuid::Uuid;

const TOKEN: &str = "test-token";
const ADMIN_TOKEN: &str = "test-admin-token";

type OptionalTimestamp = Option<chrono::DateTime<chrono::Utc>>;
type RevocationScheduleRow = (
    String,
    OptionalTimestamp,
    OptionalTimestamp,
    OptionalTimestamp,
);
type RevocationGenerationRow = (
    String,
    OptionalTimestamp,
    OptionalTimestamp,
    OptionalTimestamp,
    i64,
);

struct TestApp {
    router: Router,
    schema: String,
    admin_url: String,
    pool: PgPool,
}

impl TestApp {
    async fn new() -> Self {
        Self::new_with_control("http://127.0.0.1:7003").await
    }

    async fn new_with_control(control_url: &str) -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must be set; e.g. postgres://localhost/chan_gateway_test");
        // Hold-one-connection reaper: clears any idle connections
        // leaked by previous test-process runs, then keeps one slot
        // pinned for the rest of this process so the role never
        // goes fully idle from PG's perspective.
        pg_reaper::reap_idle(&url).await;
        let schema = format!("t_{}", Uuid::new_v4().simple());

        // Create the schema using a one-shot admin connection so we
        // don't pay for it on every pool acquire.
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

        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .expect("migrate");

        let workspace_admin =
            gateway_common::devserver_control_client::DevserverControlClient::new(
                control_url.parse().unwrap(),
                "test-profile-admin-token".into(),
            )
            .unwrap();
        let router = profile::http::router(profile::http::AppState {
            revocations: profile::revocation::RevocationCoordinator::spawn(
                pool.clone(),
                workspace_admin.clone(),
            ),
            pool: pool.clone(),
            auth_token: TOKEN.to_string(),
            admin_token: Some(ADMIN_TOKEN.to_string()),
            workspace_admin,
        });

        Self {
            router,
            schema,
            admin_url: url,
            pool,
        }
    }

    async fn cleanup(self) {
        // Close the per-test pool first so the admin connection
        // doesn't have to wait behind it.
        self.pool.close().await;
        let admin = admin_pool(&self.admin_url).await;
        let _ = sqlx::query(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema))
            .execute(&admin)
            .await;
        admin.close().await;
    }

    async fn req(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.req_as(TOKEN, method, path, body).await
    }

    async fn admin(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.req_as(ADMIN_TOKEN, method, path, body).await
    }

    async fn req_as(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(serde_json::to_vec(&v).unwrap())
            }
            None => Body::empty(),
        };
        let req = builder.body(body).unwrap();
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, json)
    }
}

#[tokio::test]
async fn control_plane_migration_seeds_and_constrains_policy() {
    let app = TestApp::new().await;
    let admissions_enabled: bool = sqlx::query_scalar(
        "SELECT admissions_enabled FROM devserver_fleet_policy WHERE singleton = true",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert!(admissions_enabled);
    let singleton_violation = sqlx::query(
        "INSERT INTO devserver_fleet_policy (singleton, admissions_enabled) VALUES (false, true)",
    )
    .execute(&app.pool)
    .await
    .unwrap_err();
    assert_eq!(
        singleton_violation
            .as_database_error()
            .and_then(|error| error.code())
            .as_deref(),
        Some("23514")
    );
    app.cleanup().await;
}

#[tokio::test]
async fn admin_user_policy_is_idempotent_bounded_and_user_scoped() {
    let app = TestApp::new().await;
    let (_, user) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "policy@example.com"})),
        )
        .await;
    let user_id = user["id"].as_str().unwrap();
    let path = format!("/v1/admin/users/{user_id}/devserver-policy");

    assert_eq!(
        app.admin(Method::GET, &path, None).await.0,
        StatusCode::NOT_FOUND
    );
    let body = json!({"enabled": true, "max_connected_devservers": 3});
    let (status, first) = app.admin(Method::PUT, &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["max_connected_devservers"], 3);
    let (_, second) = app.admin(Method::PUT, &path, Some(body)).await;
    assert_eq!(second["user_id"], first["user_id"]);
    assert_eq!(app.admin(Method::GET, &path, None).await.1["enabled"], true);

    let (status, _) = app
        .admin(
            Method::PUT,
            &path,
            Some(json!({"enabled": true, "max_connected_devservers": 0})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = app
        .admin(
            Method::PUT,
            &format!("/v1/admin/users/{}/devserver-policy", Uuid::new_v4()),
            Some(json!({"enabled": true, "max_connected_devservers": 3})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn concurrent_user_policy_upserts_serialize_and_leave_one_valid_row() {
    let app = TestApp::new().await;
    let (_, user) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "policy-race@example.com"})),
        )
        .await;
    let user_id = user["id"].as_str().unwrap();
    let path = format!("/v1/admin/users/{user_id}/devserver-policy");

    let first = app.admin(
        Method::PUT,
        &path,
        Some(json!({"enabled": false, "max_connected_devservers": 1})),
    );
    let second = app.admin(
        Method::PUT,
        &path,
        Some(json!({"enabled": true, "max_connected_devservers": 7})),
    );
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second.0, StatusCode::OK);

    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM devserver_user_policies WHERE user_id = $1")
            .bind(Uuid::parse_str(user_id).unwrap())
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(rows, 1);
    let (_, persisted) = app.admin(Method::GET, &path, None).await;
    assert!(
        (persisted["enabled"] == false && persisted["max_connected_devservers"] == 1)
            || (persisted["enabled"] == true && persisted["max_connected_devservers"] == 7)
    );
    app.cleanup().await;
}

#[tokio::test]
async fn admin_fleet_policy_persists_pause_and_resume() {
    let app = TestApp::new().await;
    let path = "/v1/admin/devserver-policy";
    assert_eq!(
        app.admin(Method::GET, path, None).await.1["admissions_enabled"],
        true
    );
    let (status, paused) = app
        .admin(
            Method::PUT,
            path,
            Some(json!({"admissions_enabled": false})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paused["admissions_enabled"], false);
    assert_eq!(
        app.admin(Method::GET, path, None).await.1["admissions_enabled"],
        false
    );
    assert_eq!(
        app.admin(Method::PUT, path, Some(json!({"admissions_enabled": true})))
            .await
            .1["admissions_enabled"],
        true
    );
    app.cleanup().await;
}

#[tokio::test]
async fn global_auth_audit_filters_order_and_overview_are_bounded() {
    let app = TestApp::new().await;
    let (_, first) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "audit-a@example.com"})),
        )
        .await;
    let (_, second) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "audit-b@example.com"})),
        )
        .await;
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();
    for (user_id, action) in [
        (first_id, "login"),
        (first_id, "login"),
        (second_id, "logout"),
    ] {
        assert_eq!(
            app.req(
                Method::POST,
                "/v1/auth-audit",
                Some(json!({
                    "user_id": user_id,
                    "action": action,
                    "ip": null,
                    "user_agent": null,
                    "note": null
                }))
            )
            .await
            .0,
            StatusCode::NO_CONTENT
        );
    }

    let (_, login_rows) = app
        .admin(
            Method::GET,
            &format!("/v1/admin/auth-audit?user_id={first_id}&action=login&limit=1&offset=1"),
            None,
        )
        .await;
    assert_eq!(login_rows.as_array().unwrap().len(), 1);
    assert_eq!(login_rows[0]["user_id"], first_id);
    let (status, _) = app
        .admin(Method::GET, "/v1/admin/auth-audit?limit=501", None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let since = (chrono::Utc::now() - chrono::Duration::minutes(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (status, overview) = app
        .admin(
            Method::GET,
            &format!("/v1/admin/overview?since={since}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(overview["users_total"], 2);
    assert_eq!(overview["users_active"], 2);
    assert_eq!(overview["users_blocked"], 0);
    assert_eq!(overview["users_logged_in_since"], 1);
    assert_eq!(overview["login_events_since"], 2);
    app.cleanup().await;
}

#[tokio::test]
async fn auth_required() {
    let app = TestApp::new().await;
    let req = Request::builder()
        .method(Method::POST)
        .uri("/v1/users")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"email":"a@b"}"#))
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn user_crud() {
    let app = TestApp::new().await;

    let (s, v) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "a@b.com", "display_name": "A"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["email"], "a@b.com");

    let (s, v) = app.req(Method::GET, &format!("/v1/users/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["display_name"], "A");

    let (s, v) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{id}"),
            Some(json!({"display_name": "B"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["display_name"], "B");

    let (s, _) = app
        .req(Method::DELETE, &format!("/v1/users/{id}"), None)
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);

    let (s, user) = app.req(Method::GET, &format!("/v1/users/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert!(user["blocked_at"].is_string());
    assert_eq!(user["block_reason"], "account deletion pending");

    app.cleanup().await;
}

#[tokio::test]
async fn identity_link_and_lookup() {
    let app = TestApp::new().await;

    let (_, u) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": "x@y.com"})))
        .await;
    let uid = u["id"].as_str().unwrap();

    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{uid}/identities"),
            Some(json!({
                "provider": "github",
                "provider_subject": "12345",
                "email": "x@y.com",
            })),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);

    let (s, v) = app
        .req(
            Method::GET,
            "/v1/users/by-identity?provider=github&subject=12345",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["id"].as_str().unwrap(), uid);

    // Re-linking the same provider+subject must conflict.
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{uid}/identities"),
            Some(json!({"provider": "github", "provider_subject": "12345"})),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // by-identity miss is 404, not 500.
    let (s, _) = app
        .req(
            Method::GET,
            "/v1/users/by-identity?provider=github&subject=nope",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

#[tokio::test]
async fn username_backfill_rename_and_cap() {
    let app = TestApp::new().await;

    // New users get the deterministic 'u<hex>' placeholder; edit
    // counter starts at 0 so callers have the full budget.
    let (_, u) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": "n@m.com"})))
        .await;
    let uid = u["id"].as_str().unwrap().to_string();
    let initial = u["username"].as_str().unwrap().to_string();
    assert!(initial.starts_with('u'));
    assert_eq!(u["username_edits"].as_i64().unwrap(), 0);

    // Reject malformed handles before SQL ever sees them.
    let (s, _) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{uid}/username"),
            Some(json!({"username": "ab"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{uid}/username"),
            Some(json!({"username": "-leading"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Successful rename increments the counter.
    let (s, v) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{uid}/username"),
            Some(json!({"username": "alice"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["username"], "alice");
    assert_eq!(v["username_edits"].as_i64().unwrap(), 1);

    // Renaming to the same handle (case-insensitive) is a no-op,
    // not an edit -- caller can re-submit a form without burning a
    // slot.
    let (s, v) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{uid}/username"),
            Some(json!({"username": "ALICE"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["username_edits"].as_i64().unwrap(), 1);

    // Three more renames to exhaust the cap (4 total).
    for name in ["bob", "carol", "dave"] {
        let (s, _) = app
            .req(
                Method::PATCH,
                &format!("/v1/users/{uid}/username"),
                Some(json!({"username": name})),
            )
            .await;
        assert_eq!(s, StatusCode::OK);
    }

    // Cap reached: the next rename is rejected.
    let (s, _) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{uid}/username"),
            Some(json!({"username": "eve"})),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // Uniqueness enforced across users (case-insensitive).
    let (_, u2) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "n2@m.com"})),
        )
        .await;
    let uid2 = u2["id"].as_str().unwrap().to_string();
    let (s, _) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{uid2}/username"),
            Some(json!({"username": "Dave"})),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    app.cleanup().await;
}

/// Helper: insert an api_token row (skips the hashing layer; we
/// only care about state transitions in profile-side admin tests).
async fn insert_api_token(pool: &PgPool, user_id: Uuid, label: &str) -> Uuid {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO api_tokens (user_id, label, token_hash) \
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user_id)
    .bind(label)
    .bind(format!("hash-{}", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn admin_token_gating() {
    let app = TestApp::new().await;
    // Wrong bearer (the regular service token) is not enough for
    // /v1/admin: rotation independence requires this stays separate.
    let (s, _) = app.req(Method::GET, "/v1/admin/users", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // Missing bearer entirely: same.
    let req = Request::builder()
        .method(Method::GET)
        .uri("/v1/admin/users")
        .body(Body::empty())
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    // Admin bearer works.
    let (s, _) = app.admin(Method::GET, "/v1/admin/users", None).await;
    assert_eq!(s, StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
async fn admin_list_users_filters() {
    let app = TestApp::new().await;
    app.req(
        Method::POST,
        "/v1/users",
        Some(json!({"email": "alice@example.com"})),
    )
    .await;
    let (_, b) = app
        .req(
            Method::POST,
            "/v1/users",
            Some(json!({"email": "bob@other.com"})),
        )
        .await;
    let bob_id = b["id"].as_str().unwrap().to_string();

    // Substring filter (case-insensitive).
    let (s, v) = app
        .admin(Method::GET, "/v1/admin/users?email=EXAMPLE", None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["email"], "alice@example.com");

    // Block bob, then filter.
    app.admin(
        Method::POST,
        &format!("/v1/admin/users/{bob_id}/block"),
        Some(json!({"reason": "spam"})),
    )
    .await;
    let (_, only_blocked) = app
        .admin(Method::GET, "/v1/admin/users?blocked=true", None)
        .await;
    assert_eq!(only_blocked.as_array().unwrap().len(), 1);
    assert_eq!(only_blocked[0]["id"], bob_id);

    let (_, only_active) = app
        .admin(Method::GET, "/v1/admin/users?blocked=false", None)
        .await;
    assert_eq!(only_active.as_array().unwrap().len(), 1);
    assert_eq!(only_active[0]["email"], "alice@example.com");

    app.cleanup().await;
}

#[tokio::test]
async fn admin_block_revokes_tokens_and_audits() {
    let app = TestApp::new().await;
    let (_, u) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": "z@z.com"})))
        .await;
    let uid: Uuid = u["id"].as_str().unwrap().parse().unwrap();
    let t1 = insert_api_token(&app.pool, uid, "t1").await;
    let t2 = insert_api_token(&app.pool, uid, "t2").await;

    // Pre-block: the regular GET still resolves the user, with
    // blocked_at null on the wire.
    let (_, before) = app
        .req(Method::GET, &format!("/v1/users/{uid}"), None)
        .await;
    assert!(before["blocked_at"].is_null());

    let (s, blocked) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/users/{uid}/block"),
            Some(json!({"reason": "abuse"})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert!(!blocked["blocked_at"].is_null());
    assert_eq!(blocked["block_reason"], "abuse");

    // Both tokens auto-revoked.
    let revoked: Vec<bool> = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM api_tokens \
         WHERE id IN ($1, $2) ORDER BY id",
    )
    .bind(t1)
    .bind(t2)
    .fetch_all(&app.pool)
    .await
    .unwrap();
    assert_eq!(revoked, vec![true, true]);

    // auth_audit row written with the reason.
    let (_, audit) = app
        .admin(
            Method::GET,
            &format!("/v1/admin/users/{uid}/auth-audit"),
            None,
        )
        .await;
    let arr = audit.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["action"], "blocked");
    assert_eq!(arr[0]["note"], "abuse");

    // Re-block keeps the original blocked_at (idempotent timestamp,
    // updated reason). Issue another block with a fresh reason.
    let original_blocked_at = blocked["blocked_at"].clone();
    let (s, reblocked) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/users/{uid}/block"),
            Some(json!({"reason": "still bad"})),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(reblocked["blocked_at"], original_blocked_at);
    assert_eq!(reblocked["block_reason"], "still bad");

    // Unblock clears flags but does NOT un-revoke tokens.
    let (s, unblocked) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/users/{uid}/unblock"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert!(unblocked["blocked_at"].is_null());
    assert!(unblocked["block_reason"].is_null());
    let still_revoked: bool = sqlx::query_scalar(
        "SELECT bool_and(revoked_at IS NOT NULL) FROM api_tokens WHERE user_id = $1",
    )
    .bind(uid)
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert!(still_revoked);

    app.cleanup().await;
}

#[tokio::test]
async fn admin_token_revoke_and_audit() {
    let app = TestApp::new().await;
    let (_, u) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": "k@k.com"})))
        .await;
    let uid: Uuid = u["id"].as_str().unwrap().parse().unwrap();
    let tid = insert_api_token(&app.pool, uid, "cli").await;

    // List by user.
    let (s, list) = app
        .admin(Method::GET, &format!("/v1/admin/users/{uid}/tokens"), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], tid.to_string());
    assert!(list[0]["revoked_at"].is_null());

    // Revoke writes an audit row.
    let (s, _) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/tokens/{tid}/revoke"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);

    let (s, audit) = app
        .admin(Method::GET, &format!("/v1/admin/tokens/{tid}/audit"), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = audit.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["action"], "revoked_via_admin");

    // Second revoke is a clean no-op (no audit duplicate).
    let (s, _) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/tokens/{tid}/revoke"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let (_, audit2) = app
        .admin(Method::GET, &format!("/v1/admin/tokens/{tid}/audit"), None)
        .await;
    assert_eq!(audit2.as_array().unwrap().len(), 1);

    // Unknown token: 404.
    let (s, _) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/tokens/{}/revoke", Uuid::new_v4()),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

#[tokio::test]
async fn identity_pat_revoke_atomically_denies_audits_and_reserves() {
    let app = TestApp::new().await;
    let alice: Uuid = mk_user(&app, "pat-alice@x.com").await.parse().unwrap();
    let bob: Uuid = mk_user(&app, "pat-bob@x.com").await.parse().unwrap();
    let alice_token = insert_api_token(&app.pool, alice, "desktop").await;
    let bob_token = insert_api_token(&app.pool, bob, "desktop").await;

    let (status, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{alice}/tokens/{alice_token}/revoke"),
            Some(json!({"ip": "192.0.2.4", "user_agent": "chan-test/1"})),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (revoked, action, ip, user_agent, kind, phase): (
        bool,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT t.revoked_at IS NOT NULL, a.action, a.ip, a.user_agent, j.kind, j.phase \
         FROM api_tokens t \
         JOIN api_token_audit a ON a.token_id = t.id \
         JOIN control_revocation_jobs j ON j.subject_user_id = t.user_id \
         WHERE t.id = $1",
    )
    .bind(alice_token)
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert!(revoked);
    assert_eq!(action, "revoked");
    assert_eq!(ip.as_deref(), Some("192.0.2.4"));
    assert_eq!(user_agent.as_deref(), Some("chan-test/1"));
    assert_eq!(kind, "subject");
    assert_eq!(phase, "pending_first_cut");

    let (status, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{alice}/tokens/{bob_token}/revoke"),
            Some(json!({"ip": null, "user_agent": null})),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let bob_active: bool =
        sqlx::query_scalar("SELECT revoked_at IS NULL FROM api_tokens WHERE id = $1")
            .bind(bob_token)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(bob_active);

    // Idempotent retry restarts settlement but does not duplicate the audit.
    let (status, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{alice}/tokens/{alice_token}/revoke"),
            Some(json!({"ip": "192.0.2.4", "user_agent": "chan-test/1"})),
        )
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let audits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM api_token_audit WHERE token_id = $1")
            .bind(alice_token)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(audits, 1);

    app.cleanup().await;
}

#[tokio::test]
async fn write_auth_audit_round_trip() {
    let app = TestApp::new().await;
    let (_, u) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": "a@a.com"})))
        .await;
    let uid = u["id"].as_str().unwrap().to_string();

    let (s, _) = app
        .req(
            Method::POST,
            "/v1/auth-audit",
            Some(json!({
                "user_id": uid,
                "action": "login",
                "ip": "10.0.0.1",
                "user_agent": "test/1.0",
                "note": "github",
            })),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    let (_, audit) = app
        .admin(
            Method::GET,
            &format!("/v1/admin/users/{uid}/auth-audit"),
            None,
        )
        .await;
    let arr = audit.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["action"], "login");
    assert_eq!(arr[0]["ip"], "10.0.0.1");
    assert_eq!(arr[0]["note"], "github");

    // Empty action rejected.
    let (s, _) = app
        .req(
            Method::POST,
            "/v1/auth-audit",
            Some(json!({"user_id": uid, "action": ""})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Audit for unknown user is 404 (FK is enforced via the WHERE
    // EXISTS guard so we get a clean error, not a 500).
    let (s, _) = app
        .req(
            Method::POST,
            "/v1/auth-audit",
            Some(json!({"user_id": Uuid::new_v4(), "action": "login"})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

// ---------------------------------------------------------------
// upsert_by_identity (single-tx find-or-create)
// ---------------------------------------------------------------

#[tokio::test]
async fn upsert_first_time_creates_user_and_identity() {
    let app = TestApp::new().await;
    let (s, v) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "1001",
                "email": "alice@example.com",
                "display_name": "Alice",
                "avatar_url": "https://gh/a.png",
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["user_created"], true);
    assert_eq!(v["identity_created"], true);
    assert_eq!(v["user"]["email"], "alice@example.com");
    assert_eq!(v["user"]["avatar_url"], "https://gh/a.png");

    // by-identity lookup now resolves to the same user.
    let (s, by_id) = app
        .req(
            Method::GET,
            "/v1/users/by-identity?provider=github&subject=1001",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(by_id["id"], v["user"]["id"]);
    app.cleanup().await;
}

#[tokio::test]
async fn upsert_existing_identity_returns_same_user() {
    let app = TestApp::new().await;
    let (_, first) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "2002",
                "email": "bob@example.com",
            })),
        )
        .await;
    let uid = first["user"]["id"].clone();

    // Second call with the same (provider, subject) returns the
    // same user; no new identity row written.
    let (s, second) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "2002",
                "email": "bob@example.com",
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(second["user_created"], false);
    assert_eq!(second["identity_created"], false);
    assert_eq!(second["user"]["id"], uid);
    app.cleanup().await;
}

#[tokio::test]
async fn upsert_existing_email_links_identity_to_existing_user() {
    // The migration 0001 contract: a second provider with a verified
    // email matching an existing user attaches to that user, not a
    // new one.
    let app = TestApp::new().await;
    let (_, gh) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "3003",
                "email": "carol@example.com",
            })),
        )
        .await;
    let uid = gh["user"]["id"].clone();

    let (s, google) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "google",
                "provider_subject": "g-3003",
                "email": "Carol@Example.COM",  // case-insensitive match
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(google["user_created"], false);
    assert_eq!(google["identity_created"], true);
    assert_eq!(google["user"]["id"], uid, "should link to existing user");

    // Both identities resolve to the same user.
    let (_, by_gh) = app
        .req(
            Method::GET,
            "/v1/users/by-identity?provider=github&subject=3003",
            None,
        )
        .await;
    let (_, by_google) = app
        .req(
            Method::GET,
            "/v1/users/by-identity?provider=google&subject=g-3003",
            None,
        )
        .await;
    assert_eq!(by_gh["id"], by_google["id"]);
    app.cleanup().await;
}

#[tokio::test]
async fn upsert_missing_email_for_unknown_user_is_400() {
    let app = TestApp::new().await;
    let (s, _) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "4004",
                // no email
            })),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    app.cleanup().await;
}

#[tokio::test]
async fn upsert_existing_identity_without_email_still_succeeds() {
    // Re-auth for an already-linked identity must not require email
    // (provider may stop returning it after first consent).
    let app = TestApp::new().await;
    app.req(
        Method::POST,
        "/v1/users/upsert-by-identity",
        Some(json!({
            "provider": "github",
            "provider_subject": "5005",
            "email": "dan@example.com",
        })),
    )
    .await;
    let (s, v) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "5005",
                // no email
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["user_created"], false);
    assert_eq!(v["identity_created"], false);
    app.cleanup().await;
}

#[tokio::test]
async fn upsert_refreshes_avatar_when_changed() {
    let app = TestApp::new().await;
    app.req(
        Method::POST,
        "/v1/users/upsert-by-identity",
        Some(json!({
            "provider": "github",
            "provider_subject": "6006",
            "email": "eve@example.com",
            "avatar_url": "https://gh/old.png",
        })),
    )
    .await;
    let (_, v) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "6006",
                "avatar_url": "https://gh/new.png",
            })),
        )
        .await;
    assert_eq!(v["user"]["avatar_url"], "https://gh/new.png");

    // Same avatar -> no spurious updated_at churn (we don't observe
    // updated_at directly; just confirm the field stayed).
    let (_, v2) = app
        .req(
            Method::POST,
            "/v1/users/upsert-by-identity",
            Some(json!({
                "provider": "github",
                "provider_subject": "6006",
                "avatar_url": "https://gh/new.png",
            })),
        )
        .await;
    assert_eq!(v2["user"]["avatar_url"], "https://gh/new.png");
    app.cleanup().await;
}

#[tokio::test]
async fn upsert_concurrent_first_time_no_orphans() {
    // Race regression: multiple concurrent first-time signups for
    // the same (provider, subject) must converge on a single user
    // row, not leave orphans behind. Workspaces N parallel upserts and
    // asserts they all return the same user id and no extra users
    // were created with that email.
    let app = TestApp::new().await;
    let router = std::sync::Arc::new(app.router.clone());
    let mut handles = Vec::new();
    for _ in 0..5 {
        let r = router.clone();
        handles.push(tokio::spawn(async move {
            let req = Request::builder()
                .method(Method::POST)
                .uri("/v1/users/upsert-by-identity")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "provider": "github",
                        "provider_subject": "race-7007",
                        "email": "race@example.com",
                    }))
                    .unwrap(),
                ))
                .unwrap();
            let res = (*r).clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK, "concurrent upsert failed");
            let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
            let v: Value = serde_json::from_slice(&bytes).unwrap();
            v["user"]["id"].as_str().unwrap().to_string()
        }));
    }

    let mut ids = Vec::new();
    for h in handles {
        ids.push(h.await.unwrap());
    }
    let first = &ids[0];
    assert!(
        ids.iter().all(|x| x == first),
        "all concurrent upserts must converge on one user id, got {ids:?}"
    );

    // Exactly one user row carries this email.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = $1")
        .bind("race@example.com")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "no orphans");
    app.cleanup().await;
}

#[tokio::test]
async fn pending_user_delete_preserves_identity_until_settlement() {
    let app = TestApp::new().await;

    let (_, u) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": "c@d.com"})))
        .await;
    let uid = u["id"].as_str().unwrap();

    app.req(
        Method::POST,
        &format!("/v1/users/{uid}/identities"),
        Some(json!({"provider": "google", "provider_subject": "g1"})),
    )
    .await;

    let (s, _) = app
        .req(Method::DELETE, &format!("/v1/users/{uid}"), None)
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);

    let (s, _) = app
        .req(
            Method::GET,
            "/v1/users/by-identity?provider=google&subject=g1",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// devserver_grants
// ---------------------------------------------------------------------------

async fn mk_user(app: &TestApp, email: &str) -> String {
    let (_, v) = app
        .req(Method::POST, "/v1/users", Some(json!({"email": email})))
        .await;
    v["id"].as_str().unwrap().to_string()
}

/// A syntactically-valid devserver id: 64 lowercase hex chars. The real
/// id is SHA-256(PAT); tests only need the right shape and distinct,
/// lexicographically-sortable values, so one repeated hex digit suffices.
fn ds(hex_digit: &str) -> String {
    hex_digit.repeat(64)
}

#[tokio::test]
async fn grant_create_resolves_existing_user() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let alice = mk_user(&app, "alice@x.com").await;
    let dsid = ds("a");

    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "alice@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["grantee_user_id"], alice);
    assert!(v.get("role").is_none());
    assert_eq!(v["devserver_id"], dsid);
    assert!(v["accepted_at"].is_string());

    app.cleanup().await;
}

#[tokio::test]
async fn grant_create_pending_for_unknown_email() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let dsid = ds("a");

    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "future@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert!(v["grantee_user_id"].is_null());
    assert!(v["accepted_at"].is_null());

    app.cleanup().await;
}

#[tokio::test]
async fn grant_create_validates_inputs() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let dsid = ds("a");

    // Role-bearing clients must fail the binary-access cutover instead of
    // silently creating broader shell-equivalent authority.
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "a@b.com", "role": "viewer"})),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    // Bad email.
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "nope"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Bad devserver id (non-hex char at the right length).
    let bad = "g".repeat(64);
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{bad}/grants"),
            Some(json!({"grantee_email": "a@b.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Bad devserver id (too short).
    let short = "a".repeat(63);
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{short}/grants"),
            Some(json!({"grantee_email": "a@b.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Unknown owner.
    let ghost = Uuid::new_v4();
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{ghost}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "a@b.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

#[tokio::test]
async fn grant_role_column_is_absent_after_migrations() {
    let app = TestApp::new().await;
    let role_columns = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM information_schema.columns \
         WHERE table_schema = current_schema() \
           AND table_name = 'devserver_grants' \
           AND column_name = 'role'",
    )
    .fetch_one(&app.pool)
    .await
    .expect("inspect migrated devserver_grants shape");
    assert_eq!(role_columns, 0, "legacy role column survived migration");
    app.cleanup().await;
}

#[tokio::test]
async fn grant_create_is_idempotent_case_insensitively() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let _alice = mk_user(&app, "alice@x.com").await;
    let dsid = ds("a");

    let (s, v1) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "alice@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);

    let (s, v2) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "ALICE@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v1["id"], v2["id"], "same row");
    assert!(v2.get("role").is_none());
    assert_eq!(v1["created_at"], v2["created_at"], "created_at preserved");

    app.cleanup().await;
}

#[tokio::test]
async fn grant_list_and_delete() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    mk_user(&app, "alice@x.com").await;
    mk_user(&app, "bob@x.com").await;
    let dsid = ds("a");

    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
        Some(json!({"grantee_email": "alice@x.com"})),
    )
    .await;
    let (_, b) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "bob@x.com"})),
        )
        .await;
    let bid = b["id"].as_str().unwrap().to_string();

    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v.as_array().unwrap().len(), 2);

    let (s, _) = app
        .req(
            Method::DELETE,
            &format!("/v1/users/{owner}/grants/{bid}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);

    let (_, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            None,
        )
        .await;
    assert_eq!(v.as_array().unwrap().len(), 1);

    // Wrong-owner delete is 404 (defense-in-depth).
    let other = mk_user(&app, "other@x.com").await;
    let (_, again) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "bob@x.com"})),
        )
        .await;
    let gid = again["id"].as_str().unwrap();
    let (s, _) = app
        .req(
            Method::DELETE,
            &format!("/v1/users/{other}/grants/{gid}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

#[tokio::test]
async fn devserver_access_owner_grantee_and_stranger() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let alice = mk_user(&app, "alice@x.com").await;
    let stranger = mk_user(&app, "s@x.com").await;
    let dsid = ds("a");
    let other_ds = ds("b");

    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
        Some(json!({"grantee_email": "alice@x.com"})),
    )
    .await;

    // Owner.
    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{dsid}/access?as={owner}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["access"], true);

    // Grantee.
    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{dsid}/access?as={alice}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["access"], true);

    // Stranger: 404, not 403 (no enumeration).
    let (s, _) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{dsid}/access?as={stranger}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Different devserver of the same owner: grantee has no grant on it,
    // so 404 (same shape). Proves the grant is scoped to its devserver.
    let (s, _) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{other_ds}/access?as={alice}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

#[tokio::test]
async fn claim_sweep_fills_pending_grants() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let dsid = ds("a");

    // Pre-seed a grant for an email that doesn't exist yet.
    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
        Some(json!({"grantee_email": "late@x.com"})),
    )
    .await;

    // Now the user signs up.
    let late = mk_user(&app, "late@x.com").await;

    // Sweep with the user's verified emails.
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{late}/grants/claim"),
            Some(json!({"emails": ["LATE@x.com", "alt@x.com"]})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["claimed"], 1);

    // Access now resolves.
    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{dsid}/access?as={late}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["access"], true);

    // Second sweep is a no-op.
    let (_, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{late}/grants/claim"),
            Some(json!({"emails": ["late@x.com"]})),
        )
        .await;
    assert_eq!(v["claimed"], 0);

    app.cleanup().await;
}

#[tokio::test]
async fn list_owned_and_incoming() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let alice = mk_user(&app, "alice@x.com").await;
    let ds_a = ds("a");
    let ds_b = ds("b");

    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{ds_a}/grants"),
        Some(json!({"grantee_email": "alice@x.com"})),
    )
    .await;
    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{ds_a}/grants"),
        Some(json!({"grantee_email": "ghost@x.com"})),
    )
    .await;
    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{ds_b}/grants"),
        Some(json!({"grantee_email": "alice@x.com"})),
    )
    .await;

    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/grants/owned"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert!(arr.iter().all(|row| row["owner_user_id"] == owner));
    // Ordered by devserver_id, so ds_a ("aaaa...") precedes ds_b.
    assert_eq!(arr[0]["devserver_id"], ds_a);
    assert_eq!(arr[0]["grant_count"], 2);
    assert_eq!(arr[1]["devserver_id"], ds_b);
    assert_eq!(arr[1]["grant_count"], 1);

    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{alice}/grants/incoming"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    // Both rows show this owner and carry a devserver_id + label.
    for row in arr {
        assert_eq!(row["owner_user_id"], owner);
        assert!(row["devserver_id"].is_string());
        assert!(row["label"].is_string());
        assert!(row["accepted_at"].is_string());
    }

    app.cleanup().await;
}

#[tokio::test]
async fn pending_user_delete_preserves_grants_until_settlement() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let alice = mk_user(&app, "alice@x.com").await;
    let dsid = ds("a");

    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
        Some(json!({"grantee_email": "alice@x.com"})),
    )
    .await;

    // The owner and dependent grants stay durable until the outbox confirms
    // the second data-plane cut.
    let (status, _) = app
        .req(Method::DELETE, &format!("/v1/users/{owner}"), None)
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (_, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{alice}/grants/incoming"),
            None,
        )
        .await;
    assert_eq!(v.as_array().unwrap().len(), 1);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// devservers (first-class entity)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn devserver_create_idempotent() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let dsid = ds("a");
    let upper = "A".repeat(64); // same id, uppercase: normalizes to dsid

    let (s, v1) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": dsid, "label": "laptop"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v1["devserver_id"], dsid);
    assert_eq!(v1["label"], "laptop");

    let (s, v2) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": upper})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "re-create returns 200, not 201");
    assert_eq!(v1["id"], v2["id"], "same row");
    assert_eq!(
        v2["label"], "laptop",
        "blank label leaves the name untouched"
    );

    app.cleanup().await;
}

#[tokio::test]
async fn devserver_create_validates_id() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;

    let too_short = "a".repeat(63);
    let too_long = "a".repeat(65);
    let non_hex = "g".repeat(64);
    for bad in ["", "Has Space", &too_short, &too_long, &non_hex] {
        let (s, _) = app
            .req(
                Method::POST,
                &format!("/v1/users/{owner}/devservers"),
                Some(json!({"devserver_id": bad})),
            )
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "should reject {bad:?}");
    }
    app.cleanup().await;
}

#[tokio::test]
async fn devserver_label_dedups_within_owner_only() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let other = mk_user(&app, "other@x.com").await;
    let ds_a = ds("a");
    let ds_b = ds("b");
    let ds_c = ds("c");

    // First taker keeps the label.
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": ds_a, "label": "laptop"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["label"], "laptop");

    // A second devserver of the SAME owner announcing the same label
    // gets the -2 suffix; a third gets -3.
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": ds_b, "label": "laptop"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["label"], "laptop-2");
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": ds_c, "label": "laptop"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["label"], "laptop-3");

    // Re-announcing the label a row already holds is idempotent: the
    // row's own label is excluded from the taken set (no suffix creep
    // on reconnect).
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": ds_b, "label": "laptop-2"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["label"], "laptop-2");
    // Same for the plain name on the first row.
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers"),
            Some(json!({"devserver_id": ds_a, "label": "laptop"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["label"], "laptop");

    // The dedup is owner-scoped: another owner takes "laptop" untouched.
    let (s, v) = app
        .req(
            Method::POST,
            &format!("/v1/users/{other}/devservers"),
            Some(json!({"devserver_id": ds_a, "label": "laptop"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["label"], "laptop");

    app.cleanup().await;
}

#[tokio::test]
async fn devserver_label_dedup_serializes_concurrent_first_dials() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;

    // Three first dials race the same label for one owner. The
    // per-owner advisory lock serializes the dedup-then-upsert, so
    // the labels come out {laptop, laptop-2, laptop-3} in some order
    // -- never two rows holding the same name.
    let mk = |dsid: String| {
        let app = &app;
        let owner = &owner;
        async move {
            app.req(
                Method::POST,
                &format!("/v1/users/{owner}/devservers"),
                Some(json!({"devserver_id": dsid, "label": "laptop"})),
            )
            .await
        }
    };
    let ((sa, va), (sb, vb), (sc, vc)) = tokio::join!(mk(ds("a")), mk(ds("b")), mk(ds("c")));
    for s in [sa, sb, sc] {
        assert_eq!(s, StatusCode::CREATED);
    }
    let mut labels: Vec<String> = [&va, &vb, &vc]
        .iter()
        .map(|v| v["label"].as_str().unwrap().to_string())
        .collect();
    labels.sort();
    assert_eq!(labels, ["laptop", "laptop-2", "laptop-3"]);

    app.cleanup().await;
}

#[tokio::test]
async fn devserver_delete_refuses_to_cascade_grants() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    mk_user(&app, "alice@x.com").await;
    let ds_a = ds("a");
    let ds_b = ds("b");

    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers"),
        Some(json!({"devserver_id": ds_a})),
    )
    .await;
    let (_, grant) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{ds_a}/grants"),
            Some(json!({"grantee_email": "alice@x.com"})),
        )
        .await;
    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers"),
        Some(json!({"devserver_id": ds_b})),
    )
    .await;

    let (s, v) = app
        .req(Method::GET, &format!("/v1/users/{owner}/devservers"), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["devserver_id"], ds_a);
    assert_eq!(arr[1]["devserver_id"], ds_b);

    let (s, _) = app
        .req(
            Method::DELETE,
            &format!("/v1/users/{owner}/devservers/{ds_a}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);

    // Neither the registry row nor its grant was cascaded.
    let (_, v) = app
        .req(Method::GET, &format!("/v1/users/{owner}/devservers"), None)
        .await;
    assert_eq!(v.as_array().unwrap().len(), 2);

    let (_, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/devservers/{ds_a}/grants"),
            None,
        )
        .await;
    assert_eq!(v.as_array().unwrap().len(), 1);

    // Explicit grant revocation is the only safe route to deletion.
    let grant_id = grant["id"].as_str().unwrap();
    let (s, _) = app
        .req(
            Method::DELETE,
            &format!("/v1/users/{owner}/grants/{grant_id}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let (s, _) = app
        .req(
            Method::DELETE,
            &format!("/v1/users/{owner}/devservers/{ds_a}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    app.cleanup().await;
}

#[tokio::test]
async fn owned_includes_grantless() {
    // A brand-new devserver with zero grants must still appear in
    // /grants/owned with grant_count = 0 so the dashboard can render it.
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let dsid = ds("a");

    app.req(
        Method::POST,
        &format!("/v1/users/{owner}/devservers"),
        Some(json!({"devserver_id": dsid, "label": "desktop"})),
    )
    .await;

    let (s, v) = app
        .req(
            Method::GET,
            &format!("/v1/users/{owner}/grants/owned"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["devserver_id"], dsid);
    assert_eq!(arr[0]["label"], "desktop");
    assert_eq!(arr[0]["grant_count"], 0);

    app.cleanup().await;
}

#[tokio::test]
async fn grant_create_autocreates_devserver() {
    // POST /v1/users/{o}/devservers/{d}/grants must work even if the
    // owner has not POSTed the devserver first: the grant handler
    // upserts the devservers row in the same transaction, so a caller
    // that pre-seeds a grant before the devserver registers still
    // produces a valid graph and the FK never fires.
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    mk_user(&app, "alice@x.com").await;
    let dsid = ds("c");

    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{dsid}/grants"),
            Some(json!({"grantee_email": "alice@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);

    let (_, v) = app
        .req(Method::GET, &format!("/v1/users/{owner}/devservers"), None)
        .await;
    let arr = v.as_array().unwrap();
    assert!(arr.iter().any(|r| r["devserver_id"] == dsid));

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// feature_flags
// ---------------------------------------------------------------------------

#[tokio::test]
async fn flags_seeded_oauth_login_and_share_workspaces() {
    let app = TestApp::new().await;
    let (s, v) = app.admin(Method::GET, "/v1/admin/flags", None).await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    let keys: Vec<&str> = arr.iter().map(|r| r["key"].as_str().unwrap()).collect();
    assert!(keys.contains(&"oauth_login"));
    assert!(keys.contains(&"share_workspaces"));
    for r in arr {
        if r["key"] == "oauth_login" || r["key"] == "share_workspaces" {
            assert_eq!(r["default_enabled"], false);
        }
    }
    app.cleanup().await;
}

#[tokio::test]
async fn flag_upsert_then_delete() {
    let app = TestApp::new().await;
    let (s, v) = app
        .admin(
            Method::POST,
            "/v1/admin/flags",
            Some(json!({
                "key": "experimental",
                "description": "internal canary",
                "default_enabled": true,
            })),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["default_enabled"], true);
    // Re-upsert flips default.
    let (_, v) = app
        .admin(
            Method::POST,
            "/v1/admin/flags",
            Some(json!({
                "key": "experimental",
                "default_enabled": false,
            })),
        )
        .await;
    assert_eq!(v["default_enabled"], false);
    assert_eq!(
        v["description"], "internal canary",
        "preserved on partial upsert"
    );

    let (s, _) = app
        .admin(Method::DELETE, "/v1/admin/flags/experimental", None)
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = app
        .admin(Method::DELETE, "/v1/admin/flags/experimental", None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn flag_override_resolution() {
    let app = TestApp::new().await;
    let alice = mk_user(&app, "alice@x.com").await;
    let bob = mk_user(&app, "bob@x.com").await;

    // oauth_login is seeded default=false. Resolve for alice -> false.
    let (s, v) = app
        .req(Method::GET, &format!("/v1/users/{alice}/flags"), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["oauth_login"], false);

    // Grant oauth_login to alice via override.
    let (s, _) = app
        .admin(
            Method::POST,
            "/v1/admin/flags/oauth_login/overrides",
            Some(json!({"user_id": alice, "enabled": true})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    let (_, v) = app
        .req(Method::GET, &format!("/v1/users/{alice}/flags"), None)
        .await;
    assert_eq!(v["oauth_login"], true);

    // Bob still defaults to false.
    let (_, v) = app
        .req(Method::GET, &format!("/v1/users/{bob}/flags"), None)
        .await;
    assert_eq!(v["oauth_login"], false);

    // Revoke alice's override; resolution falls back to default.
    let (s, _) = app
        .admin(
            Method::DELETE,
            &format!("/v1/admin/flags/oauth_login/overrides/{alice}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, v) = app
        .req(Method::GET, &format!("/v1/users/{alice}/flags"), None)
        .await;
    assert_eq!(v["oauth_login"], false);
    app.cleanup().await;
}

#[tokio::test]
async fn flag_override_idempotent_and_lists() {
    let app = TestApp::new().await;
    let alice = mk_user(&app, "alice@x.com").await;

    app.admin(
        Method::POST,
        "/v1/admin/flags/share_workspaces/overrides",
        Some(json!({"user_id": alice, "enabled": true})),
    )
    .await;
    app.admin(
        Method::POST,
        "/v1/admin/flags/share_workspaces/overrides",
        Some(json!({"user_id": alice, "enabled": false})),
    )
    .await;
    let (s, v) = app
        .admin(
            Method::GET,
            "/v1/admin/flags/share_workspaces/overrides",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1, "upsert collapses to one row");
    assert_eq!(arr[0]["enabled"], false);
    app.cleanup().await;
}

#[tokio::test]
async fn flag_override_on_unknown_flag_or_user_is_404() {
    let app = TestApp::new().await;
    let alice = mk_user(&app, "alice@x.com").await;
    let ghost = Uuid::new_v4();

    let (s, _) = app
        .admin(
            Method::POST,
            "/v1/admin/flags/nope/overrides",
            Some(json!({"user_id": alice, "enabled": true})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let (s, _) = app
        .admin(
            Method::POST,
            "/v1/admin/flags/oauth_login/overrides",
            Some(json!({"user_id": ghost, "enabled": true})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    app.cleanup().await;
}

#[tokio::test]
async fn flag_delete_cascades_overrides() {
    let app = TestApp::new().await;
    let alice = mk_user(&app, "alice@x.com").await;
    // Make a throwaway flag we can delete (seeded ones stick around).
    app.admin(
        Method::POST,
        "/v1/admin/flags",
        Some(json!({"key": "tmp", "default_enabled": false})),
    )
    .await;
    app.admin(
        Method::POST,
        "/v1/admin/flags/tmp/overrides",
        Some(json!({"user_id": alice, "enabled": true})),
    )
    .await;
    app.admin(Method::DELETE, "/v1/admin/flags/tmp", None).await;
    let (_, v) = app
        .req(Method::GET, &format!("/v1/users/{alice}/flags"), None)
        .await;
    assert!(v.get("tmp").is_none(), "tmp flag is gone");
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// devserver registry sweeper
// ---------------------------------------------------------------------------

const RETENTION: std::time::Duration = std::time::Duration::from_secs(15 * 60);

async fn username_of(app: &TestApp, user_id: &str) -> String {
    sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(Uuid::parse_str(user_id).unwrap())
        .fetch_one(&app.pool)
        .await
        .expect("user has a username")
}

async fn seed_devserver(app: &TestApp, owner_id: &str, dsid: &str) {
    sqlx::query("INSERT INTO devservers (owner_user_id, devserver_id) VALUES ($1, $2)")
        .bind(Uuid::parse_str(owner_id).unwrap())
        .bind(dsid)
        .execute(&app.pool)
        .await
        .expect("seed devserver row");
}

/// Backdate a row's liveness evidence: `created_min` minutes ago for
/// created_at, and last_seen_at = `seen_min` minutes ago (None keeps
/// it NULL, the never-marked state).
async fn backdate_devserver(app: &TestApp, dsid: &str, created_min: f64, seen_min: Option<f64>) {
    // make_interval's only double-precision named arg is secs.
    sqlx::query(
        "UPDATE devservers SET \
             created_at = now() - make_interval(secs => $2 * 60.0), \
             last_seen_at = CASE WHEN $3::double precision IS NULL THEN NULL \
                                 ELSE now() - make_interval(secs => $3 * 60.0) END \
         WHERE devserver_id = $1",
    )
    .bind(dsid)
    .bind(created_min)
    .bind(seen_min)
    .execute(&app.pool)
    .await
    .expect("backdate devserver row");
}

async fn devserver_ids(app: &TestApp) -> Vec<String> {
    sqlx::query_scalar("SELECT devserver_id FROM devservers ORDER BY devserver_id")
        .fetch_all(&app.pool)
        .await
        .expect("list devserver rows")
}

async fn grant_count(app: &TestApp, dsid: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM devserver_grants WHERE devserver_id = $1")
        .bind(dsid)
        .fetch_one(&app.pool)
        .await
        .expect("count grants")
}

#[tokio::test]
async fn sweep_preserves_shared_rows_and_marks_live_ones() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    mk_user(&app, "friend@x.com").await;
    let stale = ds("a");
    let live = ds("b");

    // A stale row carrying a grant remains until the grant has completed its
    // exact-revocation path; the sweeper must never cascade authorization.
    let (s, _) = app
        .req(
            Method::POST,
            &format!("/v1/users/{owner}/devservers/{stale}/grants"),
            Some(json!({"grantee_email": "friend@x.com"})),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    seed_devserver(&app, &owner, &live).await;

    // Both rows are older than the retention and never marked; only
    // the live one appears in the snapshot.
    backdate_devserver(&app, &stale, 30.0, None).await;
    backdate_devserver(&app, &live, 30.0, None).await;

    let snapshot = vec![(owner.parse().unwrap(), live.clone())];
    let stats = profile::sweeper::sweep_once(&app.pool, &snapshot, RETENTION)
        .await
        .expect("sweep runs");
    assert_eq!(stats.marked, 1, "the live row is stamped");
    assert_eq!(stats.deleted, 0, "the shared stale row is preserved");

    assert_eq!(devserver_ids(&app).await, vec![stale.clone(), live.clone()]);
    assert_eq!(
        grant_count(&app, &stale).await,
        1,
        "shared authorization remains explicit"
    );
    let seen: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT last_seen_at FROM devservers WHERE devserver_id = $1")
            .bind(&live)
            .fetch_one(&app.pool)
            .await
            .expect("live row remains");
    let seen = seen.expect("mark stamped last_seen_at");
    assert!(chrono::Utc::now() - seen < chrono::Duration::seconds(60));

    app.cleanup().await;
}

#[tokio::test]
async fn sweep_spares_young_rows_whether_marked_or_never_seen() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let never_seen_young = ds("c");
    let seen_recently = ds("d");
    let seen_long_ago = ds("e");
    for dsid in [&never_seen_young, &seen_recently, &seen_long_ago] {
        seed_devserver(&app, &owner, dsid).await;
    }
    // Freshly registered, never dialed: COALESCE falls back to
    // created_at, which is inside the retention.
    backdate_devserver(&app, &never_seen_young, 5.0, None).await;
    // Offline but recently seen: inside the retention.
    backdate_devserver(&app, &seen_recently, 30.0, Some(5.0)).await;
    // Offline past the retention: the one that goes.
    backdate_devserver(&app, &seen_long_ago, 40.0, Some(30.0)).await;

    // Nothing is live; an empty snapshot is a valid successful fetch.
    let stats = profile::sweeper::sweep_once(&app.pool, &[], RETENTION)
        .await
        .expect("sweep runs");
    assert_eq!(stats.marked, 0);
    assert_eq!(stats.deleted, 1);
    assert_eq!(
        devserver_ids(&app).await,
        vec![never_seen_young.clone(), seen_recently.clone()],
    );

    app.cleanup().await;
}

#[tokio::test]
async fn sweep_is_idempotent_across_ticks() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let stale = ds("a");
    let live = ds("b");
    seed_devserver(&app, &owner, &stale).await;
    seed_devserver(&app, &owner, &live).await;
    backdate_devserver(&app, &stale, 30.0, None).await;
    backdate_devserver(&app, &live, 30.0, None).await;

    let snapshot = vec![(owner.parse().unwrap(), live.clone())];
    let first = profile::sweeper::sweep_once(&app.pool, &snapshot, RETENTION)
        .await
        .expect("first sweep");
    assert_eq!((first.marked, first.deleted), (1, 1));

    // Same snapshot again: the live row re-marks, nothing new dies.
    let second = profile::sweeper::sweep_once(&app.pool, &snapshot, RETENTION)
        .await
        .expect("second sweep");
    assert_eq!((second.marked, second.deleted), (1, 0));
    assert_eq!(devserver_ids(&app).await, vec![live.clone()]);

    // A snapshot naming a user with no rows marks nothing and is
    // harmless (the proxy can know tunnels profile has no row for).
    let stranger = vec![(Uuid::new_v4(), ds("f"))];
    let third = profile::sweeper::sweep_once(&app.pool, &stranger, RETENTION)
        .await
        .expect("third sweep");
    assert_eq!(third.marked, 0);

    app.cleanup().await;
}

#[tokio::test]
async fn sweep_owner_uuid_survives_username_rename_and_reclaim() {
    let app = TestApp::new().await;
    let owner = mk_user(&app, "owner@x.com").await;
    let reclaimer = mk_user(&app, "reclaimer@x.com").await;
    let old_username = username_of(&app, &owner).await;

    let (status, _) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{owner}/username"),
            Some(json!({"username": "renamed-owner"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = app
        .req(
            Method::PATCH,
            &format!("/v1/users/{reclaimer}/username"),
            Some(json!({"username": old_username})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "retired handle can be reclaimed");

    // Both accounts have the same devserver identifier. Only the immutable
    // UUID in the live snapshot decides which row is marked and retained.
    let devserver_id = ds("a");
    seed_devserver(&app, &owner, &devserver_id).await;
    seed_devserver(&app, &reclaimer, &devserver_id).await;
    backdate_devserver(&app, &devserver_id, 30.0, None).await;

    let snapshot = vec![(owner.parse().unwrap(), devserver_id.clone())];
    let stats = profile::sweeper::sweep_once(&app.pool, &snapshot, RETENTION)
        .await
        .expect("sweep runs");
    assert_eq!((stats.marked, stats.deleted), (1, 1));

    let survivors: Vec<Uuid> =
        sqlx::query_scalar("SELECT owner_user_id FROM devservers WHERE devserver_id = $1")
            .bind(&devserver_id)
            .fetch_all(&app.pool)
            .await
            .expect("list surviving owners");
    assert_eq!(survivors, vec![owner.parse::<Uuid>().unwrap()]);

    app.cleanup().await;
}

#[tokio::test]
async fn revocation_reservation_has_no_precommit_settlement_clock() {
    let app = TestApp::new().await;
    let user_id: Uuid = mk_user(&app, "restart@x.com").await.parse().unwrap();
    let job = profile::revocation::RevocationJob::Subject(user_id);
    let mut tx = app.pool.begin().await.unwrap();
    profile::revocation::reserve_tx(&mut tx, &job)
        .await
        .expect("transactional reservation");
    let (phase, first_cut, settle, deadline): RevocationScheduleRow = sqlx::query_as(
        "SELECT phase, first_cut_confirmed_at, settle_not_before, deadline \
         FROM control_revocation_jobs WHERE job_key = $1",
    )
    .bind(format!("subject:{user_id}"))
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(phase, "pending_first_cut");
    assert!(first_cut.is_none());
    assert!(settle.is_none());
    assert!(deadline.is_none());
    tx.commit().await.unwrap();
    app.cleanup().await;
}

#[tokio::test]
async fn admin_delete_atomically_persists_dominant_outbox_job() {
    let app = TestApp::new().await;
    let user_id = mk_user(&app, "delete@x.com").await;
    let (status, _) = app
        .req(Method::DELETE, &format!("/v1/users/{user_id}"), None)
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let (blocked, kind, phase, settle): (
        bool,
        String,
        String,
        Option<chrono::DateTime<chrono::Utc>>,
    ) = sqlx::query_as(
        "SELECT u.blocked_at IS NOT NULL, j.kind, j.phase, j.settle_not_before \
         FROM users u JOIN control_revocation_jobs j ON j.subject_user_id = u.id \
         WHERE u.id = $1",
    )
    .bind(user_id.parse::<Uuid>().unwrap())
    .fetch_one(&app.pool)
    .await
    .expect("denial and outbox commit together");
    assert!(blocked);
    assert_eq!(kind, "account_delete");
    assert_eq!(phase, "pending_first_cut");
    assert!(settle.is_none());

    let (status, _) = app
        .admin(
            Method::POST,
            &format!("/v1/admin/users/{user_id}/unblock"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let blocked: bool =
        sqlx::query_scalar("SELECT blocked_at IS NOT NULL FROM users WHERE id = $1")
            .bind(user_id.parse::<Uuid>().unwrap())
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(blocked, "pending deletion cannot reopen authorization");
    app.cleanup().await;
}

#[tokio::test]
async fn admin_delete_finalizes_only_after_confirmed_settlement() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let control = axum::Router::new()
        .route(
            "/admin/v1/owners/{owner_id}/tunnels/kill",
            axum::routing::post(|| async { axum::Json(json!({"killed": 0})) }),
        )
        .route(
            "/admin/v1/sessions/revoke",
            axum::routing::post(|| async {
                axum::Json(json!({
                    "revoked": 0,
                    "proxies_confirmed": 1,
                    "proxies_expected": 1
                }))
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, control).await.unwrap() });
    let control_url = format!("http://{addr}");
    let app = TestApp::new_with_control(&control_url).await;
    let user_id: Uuid = mk_user(&app, "finalize@x.com").await.parse().unwrap();
    app.req(
        Method::POST,
        &format!("/v1/users/{user_id}/identities"),
        Some(json!({"provider": "google", "provider_subject": "finalize-sub"})),
    )
    .await;

    let (status, _) = app
        .req(Method::DELETE, &format!("/v1/users/{user_id}"), None)
        .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        users, 1,
        "the first cut must not delete durable identity state"
    );

    let client = gateway_common::devserver_control_client::DevserverControlClient::new(
        control_url.parse().unwrap(),
        "test-profile-admin-token".into(),
    )
    .unwrap();
    // The first successful post-commit cut only starts the quiet window.
    profile::revocation::process_once(&app.pool, &client)
        .await
        .unwrap();
    let (phase, settle): (String, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "SELECT phase, settle_not_before FROM control_revocation_jobs WHERE job_key = $1",
    )
    .bind(format!("subject:{user_id}"))
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(phase, "settling");
    assert!(settle >= chrono::Utc::now() + chrono::Duration::seconds(39));
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(users, 1);

    sqlx::query(
        "UPDATE control_revocation_jobs SET \
           settle_not_before = now() - interval '1 second', next_attempt_at = now() \
         WHERE job_key = $1",
    )
    .bind(format!("subject:{user_id}"))
    .execute(&app.pool)
    .await
    .unwrap();
    for _ in 0..10 {
        profile::revocation::process_once(&app.pool, &client)
            .await
            .unwrap();
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
        if users == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let identities: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM identities WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(users, 0, "confirmed second cut finalizes the account");
    assert_eq!(identities, 0, "finalization applies dependent-row cascades");

    app.cleanup().await;
    server.abort();
}

#[tokio::test]
async fn coalesced_reservation_resets_a_due_generation_to_first_cut_phase() {
    let app = TestApp::new().await;
    let user_id: Uuid = mk_user(&app, "supersede@x.com").await.parse().unwrap();
    let job = profile::revocation::RevocationJob::Subject(user_id);
    profile::revocation::reserve(&app.pool, &job)
        .await
        .expect("initial reservation");
    sqlx::query(
        "UPDATE control_revocation_jobs SET \
           phase = 'settling', first_cut_confirmed_at = now() - interval '41 seconds', \
           settle_not_before = now() - interval '1 second', \
           deadline = now() + interval '5 minutes', next_attempt_at = now() - interval '1 second' \
         WHERE job_key = $1",
    )
    .bind(format!("subject:{user_id}"))
    .execute(&app.pool)
    .await
    .unwrap();
    let old_generation: i64 =
        sqlx::query_scalar("SELECT generation FROM control_revocation_jobs WHERE job_key = $1")
            .bind(format!("subject:{user_id}"))
            .fetch_one(&app.pool)
            .await
            .unwrap();

    profile::revocation::reserve(&app.pool, &job)
        .await
        .expect("new denial supersedes the due generation");
    let (phase, first_cut, settle, deadline, generation): RevocationGenerationRow = sqlx::query_as(
        "SELECT phase, first_cut_confirmed_at, settle_not_before, deadline, generation \
         FROM control_revocation_jobs WHERE job_key = $1",
    )
    .bind(format!("subject:{user_id}"))
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(phase, "pending_first_cut");
    assert!(first_cut.is_none());
    assert!(settle.is_none());
    assert!(deadline.is_none());
    assert!(generation > old_generation);
    app.cleanup().await;
}
