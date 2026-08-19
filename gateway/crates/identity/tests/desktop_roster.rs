//! Integration tests for `GET /desktop/v1/devservers`.
//!
//! Each test gets its own throwaway Postgres schema and a wiremock
//! server standing in for profile-service and the devserver-control
//! admin API. PATs are seeded through the real operator surface
//! (`POST /admin/v1/tokens`), so the Config carries a non-empty
//! `identity_admin_token` (unlike the entry-test harness, which
//! leaves the /admin/v1 tree disabled).
//!
//! Pins the Contract B failure semantics: 401 for a wrong-scope PAT,
//! 502 (never a degraded all-offline 200) when profile or the
//! devserver-control admin API fails, ETag/If-None-Match 304 on an
//! unchanged body, and the no-audit validate (last_used_at bumps, no
//! `used` row).

#[path = "../../../tests-shared/pg_reaper.rs"]
mod pg_reaper;

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower::ServiceExt;
use tower_sessions_sqlx_store::PostgresStore;
use uuid::Uuid;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use identity::api_tokens::ApiTokenService;
use identity::config::Config;
use identity::devserver_control_client::DevserverControlClient;
use identity::http;
use identity::profile_client::ProfileClient;
use identity::providers::github::GitHubProvider;
use identity::token_throttle::TokenThrottle;

const ADMIN_TOKEN: &str = "test-admin-bearer";

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
    pool: PgPool,
    profile: MockServer,
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

        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .expect("migrate identity tables");

        let store = PostgresStore::new(pool.clone());
        store.migrate().await.expect("migrate sessions");

        let profile = MockServer::start().await;

        let profile_client = ProfileClient::new(profile.uri().parse().unwrap(), "unused".into())
            .expect("profile client");
        // No OAuth in these tests; Config just requires a non-empty
        // provider list.
        let provider = GitHubProvider::new("client".into(), "secret".into()).expect("gh");

        let api_tokens = ApiTokenService::new(pool.clone());
        let cfg = Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            internal_bind_addr: "127.0.0.1:0".parse().unwrap(),
            base_url: "http://localhost:7000/".parse().unwrap(),
            devserver_proxy_origin: "https://proxy.chan.app".parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
            database_url: url.clone(),
            cookie_secure: true,
            profile_client,
            internal_auth_token: "test-internal".to_string(),
            session_internal_auth_token: "test-session-internal".to_string(),
            // Non-empty: the tests seed PATs through POST
            // /admin/v1/tokens, the same surface an operator (and the
            // e2e rig) uses to mint account-scoped tokens.
            identity_admin_token: ADMIN_TOKEN.to_string(),
            account_admin_token: "test-account-admin".to_string(),
            // Same mock server backs the proxy-admin client; its
            // /admin/v1/* paths don't collide with profile's /v1/*.
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
        let router = http::router(cfg, store, api_tokens.clone(), TokenThrottle::new());

        Self {
            router,
            api_tokens,
            schema,
            admin_url: url,
            pool,
            profile,
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

    /// Insert a user row directly (FK target for PAT create and the
    /// email the admin mint resolves).
    async fn insert_user(&self) -> Uuid {
        let id = Uuid::new_v4();
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

    /// Mint a PAT with `scopes` through the real operator surface, as
    /// the e2e rig does. Returns `(token_id, secret)`. A tunnel-scoped
    /// mint's best-effort devserver registration hits the profile
    /// mock's unmatched-404 and is swallowed; a non-tunnel mint
    /// registers nothing at all (row registration is gated on the
    /// dial scope).
    async fn admin_mint(&self, uid: Uuid, scopes: &[&str]) -> (Uuid, String) {
        let req = Request::builder()
            .method(Method::POST)
            .uri("/admin/v1/tokens")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {ADMIN_TOKEN}"))
            .body(Body::from(
                json!({"email": format!("{uid}@example.com"), "scopes": scopes}).to_string(),
            ))
            .unwrap();
        let res = self.router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED, "admin mint");
        let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        let id = v["id"].as_str().expect("token id").parse().unwrap();
        (id, v["secret"].as_str().expect("secret").to_string())
    }
}

/// The placeholder username `insert_user` seeds, computed the same way.
fn placeholder_username(id: Uuid) -> String {
    format!("u{}", &id.simple().to_string()[..12])
}

async fn mock_owned(app: &TestApp, uid: Uuid, rows: Value) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/grants/owned")))
        .respond_with(ResponseTemplate::new(200).set_body_json(rows))
        .mount(&app.profile)
        .await;
}

async fn mock_incoming(app: &TestApp, uid: Uuid, rows: Value) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/grants/incoming")))
        .respond_with(ResponseTemplate::new(200).set_body_json(rows))
        .mount(&app.profile)
        .await;
}

/// Mock the identity-scoped per-owner tunnel reads.
async fn mock_all_tunnels(app: &TestApp, pairs: &[(Uuid, &str, &str)]) {
    let rows: Vec<(Uuid, &str, &str, &str, &str)> = pairs
        .iter()
        .map(|(owner_user_id, user, id)| {
            (
                *owner_user_id,
                *user,
                *id,
                "p1",
                "https://p1.proxy.chan.app",
            )
        })
        .collect();
    mock_all_tunnels_on(app, &rows).await;
}

fn signed_tunnel_row(
    owner_user_id: Uuid,
    user: &str,
    devserver_id: &str,
    proxy_id: &str,
    proxy_base_url: &str,
) -> Value {
    let now = chrono::Utc::now();
    let registration_id = Uuid::new_v4();
    let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    )
    .unwrap();
    let lease = signer
        .sign(
            devserver_control_proto::AdmissionLeaseBinding {
                owner_user_id,
                user: user.into(),
                devserver_id: devserver_id.into(),
                registration_id,
                proxy_id: devserver_control_proto::ProxyId::parse(proxy_id).unwrap(),
            },
            3,
            now,
            120,
        )
        .unwrap();
    json!({
        "registration_id": registration_id,
        "owner_user_id": owner_user_id,
        "user": user,
        "devserver_id": devserver_id,
        "max_connected_devservers": 3,
        "peer_addr": null,
        "connected_at": now.to_rfc3339(),
        "proxy_id": proxy_id,
        "proxy_base_url": proxy_base_url,
        "admission_lease": lease,
        "admission_lease_expires_at": (now + chrono::Duration::seconds(120)).to_rfc3339(),
    })
}

/// Same, with each row pinned to its own proxy node.
async fn mock_all_tunnels_on(app: &TestApp, rows: &[(Uuid, &str, &str, &str, &str)]) {
    let mut by_owner = std::collections::BTreeMap::<Uuid, Vec<Value>>::new();
    for (owner_user_id, user, id, proxy_id, proxy_base_url) in rows {
        by_owner
            .entry(*owner_user_id)
            .or_default()
            .push(signed_tunnel_row(
                *owner_user_id,
                user,
                id,
                proxy_id,
                proxy_base_url,
            ));
    }
    for (owner_user_id, rows) in by_owner {
        Mock::given(method("GET"))
            .and(path(format!("/admin/v1/owners/{owner_user_id}/tunnels")))
            .respond_with(ResponseTemplate::new(200).set_body_json(rows))
            .mount(&app.profile)
            .await;
    }
}

fn incoming_share_json(owner_user_id: Uuid, owner: &str, devserver_id: &str, label: &str) -> Value {
    json!({
        "grant_id": Uuid::new_v4(),
        "owner_user_id": owner_user_id,
        "owner_username": owner,
        "owner_display_name": null,
        "owner_avatar_url": null,
        "devserver_id": devserver_id,
        "label": label,
        "accepted_at": chrono::Utc::now().to_rfc3339(),
    })
}

struct RosterReply {
    status: StatusCode,
    etag: Option<String>,
    body: Vec<u8>,
}

impl RosterReply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("json body")
    }
}

async fn get_roster(app: &TestApp, pat: &str, if_none_match: Option<&str>) -> RosterReply {
    let mut builder = Request::builder()
        .method(Method::GET)
        .uri("/desktop/v1/devservers")
        .header(header::AUTHORIZATION, format!("Bearer {pat}"));
    if let Some(etag) = if_none_match {
        builder = builder.header(header::IF_NONE_MATCH, etag);
    }
    let res = app
        .router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let etag = res
        .headers()
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec();
    RosterReply { status, etag, body }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[tokio::test]
async fn roster_merges_owned_shared_and_live_unrostered() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let username = placeholder_username(uid);
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    let a = "a".repeat(64); // owned, labeled, online
    let b = "b".repeat(64); // owned, blank label -> disc fallback, offline
    let c = "c".repeat(64); // shared by bob, online
    let e = "e".repeat(64); // live tunnel, no registry row -> union
    let f = "f".repeat(64); // unrelated user's tunnel -> filtered out
    let bob_uid = Uuid::new_v4();
    let mallory_uid = Uuid::new_v4();

    mock_owned(
        &app,
        uid,
        json!([
            {"owner_user_id": uid, "devserver_id": a, "label": "laptop", "grant_count": 0},
            {"owner_user_id": uid, "devserver_id": b, "label": "", "grant_count": 0},
        ]),
    )
    .await;
    mock_incoming(
        &app,
        uid,
        json!([incoming_share_json(bob_uid, "bob-handle", &c, "bob-box")]),
    )
    .await;
    mock_all_tunnels(
        &app,
        &[
            (uid, &username, &a),
            (uid, &username, &e),
            (bob_uid, "bob-handle", &c),
            (mallory_uid, "mallory", &f),
        ],
    )
    .await;

    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    let body = reply.json();
    assert_eq!(body["username"], username);
    assert_eq!(body["user_id"], uid.to_string());

    let rows = body["devservers"].as_array().expect("devservers array");
    let summary: Vec<(String, String, bool, String)> = rows
        .iter()
        .map(|r| {
            assert!(r.get("role").is_none(), "binary grants have no role: {r}");
            (
                r["owner"].as_str().unwrap().to_string(),
                r["label"].as_str().unwrap().to_string(),
                r["online"].as_bool().unwrap(),
                r["owner_user_id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    // Own rows first sorted by label ("bbb..." < "eee..." < "laptop"),
    // then shared; the union row (e) is online with the disc label;
    // mallory's tunnel appears nowhere.
    assert_eq!(
        summary,
        vec![
            (username.clone(), "b".repeat(12), false, uid.to_string()),
            (username.clone(), "e".repeat(12), true, uid.to_string()),
            (username.clone(), "laptop".into(), true, uid.to_string()),
            (
                "bob-handle".into(),
                "bob-box".into(),
                true,
                bob_uid.to_string(),
            ),
        ],
        "{body}"
    );
    // Online rows carry the exact origin of the node holding the
    // registration; the offline row is null.
    let origins: Vec<Value> = rows.iter().map(|r| r["proxy_origin"].clone()).collect();
    let node_origin =
        |owner: &str, id: &str| json!(format!("https://{owner}--{}.p1.proxy.chan.app", &id[..12]));
    assert_eq!(
        origins,
        vec![
            Value::Null,
            node_origin(&username, &e),
            node_origin(&username, &a),
            node_origin("bob-handle", &c),
        ],
        "{body}"
    );
    assert!(!body.to_string().contains(&f), "foreign tunnel leaked");
    app.cleanup().await;
}

#[tokio::test]
async fn roster_two_owners_on_different_nodes_get_their_own_origins() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let username = placeholder_username(uid);
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    let a = "a".repeat(64); // owned by the caller, live on p1
    let c = "c".repeat(64); // shared by bob, live on p2
    let bob_uid = Uuid::new_v4();

    mock_owned(
        &app,
        uid,
        json!([{"owner_user_id": uid, "devserver_id": a, "label": "laptop", "grant_count": 0}]),
    )
    .await;
    mock_incoming(
        &app,
        uid,
        json!([incoming_share_json(bob_uid, "bob-handle", &c, "bob-box")]),
    )
    .await;
    mock_all_tunnels_on(
        &app,
        &[
            (uid, &username, &a, "p1", "https://p1.proxy.chan.app"),
            (bob_uid, "bob-handle", &c, "p2", "https://p2.proxy.chan.app"),
        ],
    )
    .await;

    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    let rows = reply.json();
    let origins: Vec<String> = rows["devservers"]
        .as_array()
        .expect("devservers array")
        .iter()
        .map(|r| {
            r["proxy_origin"]
                .as_str()
                .expect("online origin")
                .to_string()
        })
        .collect();
    assert_eq!(
        origins,
        vec![
            format!("https://{username}--{}.p1.proxy.chan.app", &a[..12]),
            format!("https://bob-handle--{}.p2.proxy.chan.app", &c[..12]),
        ],
        "{rows}"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn roster_live_row_with_invalid_node_base_is_502() {
    // Fail-closed, same shape as a controller outage: identity cannot
    // place the row inside the configured namespace, so it must not
    // guess an origin or degrade the row to offline.
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let username = placeholder_username(uid);
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    let a = "a".repeat(64);
    mock_owned(
        &app,
        uid,
        json!([{"owner_user_id": uid, "devserver_id": a, "label": "laptop", "grant_count": 0}]),
    )
    .await;
    mock_incoming(&app, uid, json!([])).await;
    mock_all_tunnels_on(
        &app,
        &[(uid, &username, &a, "p1", "https://p1.evil.example.net")],
    )
    .await;

    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json(), json!({"error": "upstream error"}));
    app.cleanup().await;
}

#[tokio::test]
async fn roster_signed_proxy_id_cannot_be_mixed_with_another_node_base() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let username = placeholder_username(uid);
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    let a = "a".repeat(64);
    mock_owned(
        &app,
        uid,
        json!([{"owner_user_id": uid, "devserver_id": a, "label": "laptop", "grant_count": 0}]),
    )
    .await;
    mock_incoming(&app, uid, json!([])).await;
    // The row's signature authorizes p1. A p2 base is syntactically inside the
    // configured namespace, but it is not the node named in the signed claim.
    mock_all_tunnels_on(
        &app,
        &[(uid, &username, &a, "p1", "https://p2.proxy.chan.app")],
    )
    .await;

    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json(), json!({"error": "upstream error"}));
    app.cleanup().await;
}

#[tokio::test]
async fn roster_401_for_wrong_scope_or_bad_token() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let (_, tunnel_pat) = app.admin_mint(uid, &["tunnel"]).await;
    let (_, connect_pat) = app.admin_mint(uid, &["desktop.connect"]).await;

    for pat in [tunnel_pat.as_str(), connect_pat.as_str(), "chan_pat_bogus"] {
        let reply = get_roster(&app, pat, None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "pat {pat}");
        assert_eq!(reply.json()["error"], "unauthorized", "pat {pat}");
    }

    // No Authorization header at all.
    let req = Request::builder()
        .method(Method::GET)
        .uri("/desktop/v1/devservers")
        .body(Body::empty())
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    app.cleanup().await;
}

#[tokio::test]
async fn roster_etag_yields_304_until_the_roster_changes() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let username = placeholder_username(uid);
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    let a = "a".repeat(64);
    mock_owned(
        &app,
        uid,
        json!([{"owner_user_id": uid, "devserver_id": a, "label": "laptop", "grant_count": 0}]),
    )
    .await;
    mock_incoming(&app, uid, json!([])).await;
    // Two snapshots with the tunnel live (the 200 + the 304 probe),
    // then the mock exhausts and the offline snapshot takes over.
    Mock::given(method("GET"))
        .and(path(format!("/admin/v1/owners/{uid}/tunnels")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!([signed_tunnel_row(
                uid,
                &username,
                &a,
                "p1",
                "https://p1.proxy.chan.app"
            ),])),
        )
        .up_to_n_times(2)
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/admin/v1/owners/{uid}/tunnels")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&app.profile)
        .await;

    let first = get_roster(&app, &pat, None).await;
    assert_eq!(first.status, StatusCode::OK);
    let etag = first.etag.clone().expect("ETag on 200");
    assert!(
        etag.starts_with('"') && etag.ends_with('"') && etag.len() == 66,
        "quoted sha256 hex, got {etag}"
    );

    // Unchanged roster: 304, empty body, same ETag echoed.
    let second = get_roster(&app, &pat, Some(&etag)).await;
    assert_eq!(second.status, StatusCode::NOT_MODIFIED);
    assert!(second.body.is_empty(), "304 body must be empty");
    assert_eq!(second.etag.as_deref(), Some(etag.as_str()));

    // The tunnel dropped: the stale ETag no longer matches, the flip
    // comes back as a fresh 200 with a new ETag.
    let third = get_roster(&app, &pat, Some(&etag)).await;
    assert_eq!(third.status, StatusCode::OK);
    assert_eq!(third.json()["devservers"][0]["online"], false);
    let new_etag = third.etag.expect("ETag on the changed 200");
    assert_ne!(new_etag, etag);
    app.cleanup().await;
}

#[tokio::test]
async fn roster_profile_failure_is_502_upstream_error() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    // Owned list fails outright.
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/grants/owned")))
        .respond_with(ResponseTemplate::new(500))
        .mount(&app.profile)
        .await;

    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json(), json!({"error": "upstream error"}));
    app.cleanup().await;
}

#[tokio::test]
async fn roster_proxy_failure_is_502_never_degraded_all_offline() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let (_, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    let a = "a".repeat(64);
    mock_owned(
        &app,
        uid,
        json!([{"owner_user_id": uid, "devserver_id": a, "label": "laptop", "grant_count": 0}]),
    )
    .await;
    mock_incoming(&app, uid, json!([])).await;
    Mock::given(method("GET"))
        .and(path(format!("/admin/v1/owners/{uid}/tunnels")))
        .respond_with(ResponseTemplate::new(500))
        .mount(&app.profile)
        .await;

    // Ruling: a liveness-source failure must NEVER serve rows with
    // online=false (the desktop would tear down every window); it is
    // a 502 and the desktop keeps its last-known roster.
    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert_eq!(reply.json(), json!({"error": "upstream error"}));
    app.cleanup().await;
}

#[tokio::test]
async fn roster_read_bumps_last_used_without_audit_row() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;
    let username = placeholder_username(uid);
    let (token_id, pat) = app.admin_mint(uid, &["desktop.account"]).await;

    mock_owned(&app, uid, json!([])).await;
    mock_incoming(&app, uid, json!([])).await;
    mock_all_tunnels(&app, &[(uid, &username, &"a".repeat(64))]).await;

    let reply = get_roster(&app, &pat, None).await;
    assert_eq!(reply.status, StatusCode::OK);

    // last_used_at bumped (deliberate: a roster poll is token use)...
    let tokens = app.api_tokens.list(uid).await.expect("list");
    let token = tokens.iter().find(|t| t.id == token_id).expect("token row");
    assert!(token.last_used_at.is_some(), "last_used_at must bump");

    // ...but the only audit row is the mint: no `used` per poll tick.
    let entries = app
        .api_tokens
        .audit(uid, token_id, 10)
        .await
        .expect("audit");
    let actions: Vec<&str> = entries.iter().map(|e| e.action.as_str()).collect();
    assert_eq!(actions, vec!["created_via_admin"], "{actions:?}");
    app.cleanup().await;
}

#[tokio::test]
async fn discovery_advertises_roster_url_with_api_version_1() {
    let app = TestApp::new().await;
    let req = Request::builder()
        .method(Method::GET)
        .uri("/.well-known/chan-gateway")
        .body(Body::empty())
        .unwrap();
    let res = app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(res.into_body(), 1 << 20).await.unwrap()).unwrap();
    // Contract E: roster_url is ADDITIVE; api_version stays 1 (v0.69
    // desktops hard-reject anything else).
    assert_eq!(body["api_version"], 1, "{body}");
    assert_eq!(
        body["roster_url"], "http://localhost:7000/desktop/v1/devservers",
        "{body}"
    );
    assert_eq!(
        body["desktop_entry_url"], "http://localhost:7000/desktop/v1/devserver/entry",
        "{body}"
    );
    app.cleanup().await;
}

#[tokio::test]
async fn admin_mint_without_tunnel_scope_registers_no_devserver_row() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;

    // Row registration is gated on the dial scope: a desktop.account
    // mint must never POST to the profile devservers path (a row for
    // an undialable PAT would be a phantom in the dashboard and the
    // roster). Verified at MockServer drop.
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/devservers")))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&app.profile)
        .await;

    let (_, secret) = app.admin_mint(uid, &["desktop.account"]).await;
    assert!(secret.starts_with("chan_pat_"), "mint still succeeds");
    app.cleanup().await;
}

#[tokio::test]
async fn admin_mint_with_tunnel_scope_registers_devserver_row() {
    let app = TestApp::new().await;
    let uid = app.insert_user().await;

    // A dialable PAT keeps registering exactly one row, labeled after
    // the mint (the operator surface's default label).
    let now = chrono::Utc::now().to_rfc3339();
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/devservers")))
        .and(wiremock::matchers::body_partial_json(
            json!({"label": "admin mint"}),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "id": Uuid::new_v4(),
            "owner_user_id": uid,
            "devserver_id": "a".repeat(64),
            "label": "admin mint",
            "created_at": now,
        })))
        .expect(1)
        .mount(&app.profile)
        .await;

    let (_, secret) = app.admin_mint(uid, &["tunnel"]).await;
    assert!(secret.starts_with("chan_pat_"));
    app.cleanup().await;
}
