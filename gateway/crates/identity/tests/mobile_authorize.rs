//! Integration tests for `/mobile/authorize*` and `/mobile/v1/*`.
//!
//! Exercises the mobile OAuth + PKCE consent flow, session stash
//! isolation between `/desktop/authorize` and `/mobile/authorize`,
//! redemption-store isolation between `/desktop/authorize/redeem` and
//! `/mobile/authorize/redeem`, bidirectional bearer scope isolation
//! across `/mobile/v1/{devservers,devserver/entry,token}` and
//! `/desktop/v1/{devservers,devserver/entry,token}`, `POST /api/tokens`
//! refusal of `mobile.*` scopes, and reserved username checks.

#[path = "../../../tests-shared/identity_config.rs"]
mod identity_config;
#[path = "../../../tests-shared/identity_db.rs"]
mod test_db;

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use gateway_common::devserver_gate::{self, EntryVerifierRing};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use identity::api_tokens::{ApiTokenService, CreatedToken, NewToken, RequestMeta, TokenOrigin};
use identity::config::Config;
use identity::devserver_control_client::DevserverControlClient;
use identity::http;
use identity::profile_client::ProfileClient;
use identity::providers::github::{GitHubEndpoints, GitHubProvider};

const PROFILE_TOKEN: &str = "test-profile-token";
const PKCE_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const ENTRY_SIGNING_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const MOBILE_AUTH_URI: &str = "/mobile/authorize?\
                               redirect_uri=chan%3A%2F%2Fauth%2Fcallback&\
                               state=mobile-nonce-1&\
                               label=chan-ios+%40+iphone&\
                               code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
                               code_challenge_method=S256&\
                               scopes=mobile.account&\
                               expires_in=2592000";

const DESKTOP_AUTH_URI: &str = "/desktop/authorize?\
                                redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback&\
                                state=desktop-nonce-1&\
                                label=chan-desktop+%40+host&\
                                code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&\
                                code_challenge_method=S256&\
                                scopes=desktop.account&\
                                expires_in=2592000";

struct TestApp {
    router: Router,
    api_tokens: ApiTokenService,
    pool: PgPool,
    schema: String,
    admin_url: String,
    profile: MockServer,
    control: MockServer,
    github: MockServer,
    entry_verifier: EntryVerifierRing,
}

impl TestApp {
    async fn new() -> Self {
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
        let entry_signer = devserver_gate::EntrySigner::from_base64(ENTRY_SIGNING_KEY).unwrap();
        let entry_verifier =
            EntryVerifierRing::from_base64_list(&entry_signer.verifying_key_base64()).unwrap();

        let cfg = Arc::new(Config {
            base_url,
            devserver_proxy_origin: "https://proxy.chan.app".parse().unwrap(),
            entry_signer,
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
            entry_verifier,
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

    async fn post_json(&mut self, uri: &str, body: &Value) -> Sent {
        self.send(
            Method::POST,
            uri,
            Some("application/json"),
            Body::from(body.to_string()),
        )
        .await
    }

    async fn patch_json(&mut self, uri: &str, body: &Value) -> Sent {
        self.send(
            Method::PATCH,
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

fn placeholder_username(id: Uuid) -> String {
    format!("u{}", &id.simple().to_string()[..12])
}

fn extract_oauth_state(authorize_url: &str) -> String {
    let u = Url::parse(authorize_url).unwrap();
    u.query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .expect("state param")
}

fn parse_callback_query(url: &str) -> std::collections::HashMap<String, String> {
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect()
}

fn extract_csrf(html: &str) -> String {
    let needle = r#"name="csrf" value=""#;
    let start = html.find(needle).expect("csrf input present");
    let after = &html[start + needle.len()..];
    let end = after.find('"').expect("csrf value closes");
    after[..end].to_string()
}

fn extract_handoff_url_with_prefix(html: &str, prefix: &str) -> String {
    let needle = format!(r#"href="{prefix}"#);
    let start = html.find(&needle).expect("handoff link present");
    let after = &html[start + r#"href=""#.len()..];
    let end = after.find('"').expect("href value closes");
    let escaped = &after[..end];
    assert_eq!(
        html.matches(escaped).count(),
        2,
        "target must ride both meta refresh and fallback link: {html}"
    );
    escaped.replace("&amp;", "&")
}

fn user_json(user_id: Uuid, email: &str, blocked: bool) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let mut body = json!({
        "id": user_id,
        "email": email,
        "display_name": "Octo Cat",
        "username": placeholder_username(user_id),
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

async fn mock_get_user(app: &TestApp, user_id: Uuid, email: &str, blocked: bool) {
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{user_id}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(user_json(user_id, email, blocked)))
        .mount(&app.profile)
        .await;
}

async fn mount_oauth(app: &TestApp, user_id: Uuid, email: &str, blocked: bool, oauth_login: bool) {
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
    Mock::given(method("POST"))
        .and(path("/v1/users/upsert-by-identity"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": user_json(user_id, email, blocked),
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
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"oauth_login": oauth_login})))
        .mount(&app.profile)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/audit/auth"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&app.profile)
        .await;
}

async fn complete_oauth(c: &mut Client<'_>) -> Sent {
    let resp = c.get("/auth/github").await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    let state = extract_oauth_state(&resp.location);
    c.get(&format!("/auth/github/callback?code=fake&state={state}"))
        .await
}

async fn send_bearer(
    app: &TestApp,
    method: Method,
    uri: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(bearer) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    let body = match body {
        Some(val) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(val.to_string())
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

async fn mint_pat(app: &TestApp, uid: Uuid, scopes: &[&str], origin: TokenOrigin) -> CreatedToken {
    let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_string()).collect();
    app.api_tokens
        .create(
            NewToken {
                user_id: uid,
                label: "test-token",
                expires_at: Some(chrono::Utc::now() + chrono::Duration::days(30)),
                scopes: &scopes,
                origin,
            },
            &RequestMeta::default(),
        )
        .await
        .expect("mint pat")
}

async fn with_cuts_settled<F: std::future::Future>(request: F) -> F::Output {
    use tracing::instrument::WithSubscriber as _;
    use tracing_subscriber::layer::SubscriberExt as _;

    struct Finished(Option<tokio::sync::oneshot::Sender<()>>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Finished {}
    impl Drop for Finished {
        fn drop(&mut self) {
            if let Some(finished) = self.0.take() {
                let _ = finished.send(());
            }
        }
    }

    let (finished, completion) = tokio::sync::oneshot::channel();
    let subscriber = tracing_subscriber::registry().with(Finished(Some(finished)));
    let response = request.with_subscriber(subscriber).await;
    tokio::time::timeout(Duration::from_secs(10), completion)
        .await
        .expect("request and detached cuts finish")
        .expect("last subscriber drop signals completion");
    response
}

async fn mock_live_tunnel(app: &TestApp, owner_user_id: Uuid, username: &str, devserver_id: &str) {
    let now = chrono::Utc::now();
    let signer =
        devserver_control_proto::AdmissionLeaseSigner::from_base64(ENTRY_SIGNING_KEY).unwrap();
    let registration_id = Uuid::new_v4();
    let lease = signer
        .sign(
            devserver_control_proto::AdmissionLeaseBinding {
                owner_user_id,
                user: username.into(),
                devserver_id: devserver_id.into(),
                registration_id,
                proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
            },
            3,
            now,
            120,
        )
        .unwrap();
    Mock::given(method("GET"))
        .and(path(format!("/admin/v1/owners/{owner_user_id}/tunnels")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "registration_id": registration_id,
            "owner_user_id": owner_user_id,
            "user": username,
            "devserver_id": devserver_id,
            "max_connected_devservers": 3,
            "peer_addr": null,
            "connected_at": now.to_rfc3339(),
            "proxy_id": "p1",
            "proxy_base_url": "https://p1.proxy.chan.app",
            "admission_lease": lease,
            "admission_lease_expires_at": (now + chrono::Duration::seconds(120)).to_rfc3339(),
        }])))
        .mount(&app.control)
        .await;
}

#[tokio::test]
async fn mobile_authorize_end_to_end_mints_and_redeems_mobile_pat() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let email = "mobile@example.com";
    app.insert_user(uid, email).await;

    // A mobile.account PAT cannot dial chan-tunnel, so no devserver row
    // may be registered in profile during consent confirmation.
    Mock::given(method("POST"))
        .and(path(format!("/v1/users/{uid}/devservers")))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&app.profile)
        .await;

    let mut c = Client::new(&app);
    let resp = c.get(MOBILE_AUTH_URI).await;
    assert_eq!(resp.status, StatusCode::SEE_OTHER);
    assert_eq!(resp.location, "/");

    mount_oauth(&app, uid, email, false, true).await;
    mock_get_user(&app, uid, email, false).await;

    let cb = complete_oauth(&mut c).await;
    assert_eq!(cb.status, StatusCode::SEE_OTHER);
    assert_eq!(cb.location, "/mobile/authorize/consent");

    let consent = c.get("/mobile/authorize/consent").await;
    assert_eq!(consent.status, StatusCode::OK);
    assert_eq!(consent.header("x-frame-options"), Some("DENY"));
    assert_eq!(consent.header("cache-control"), Some("no-store"));
    let html = consent.body_str();
    assert!(html.contains("<title>Authorize a mobile app</title>"));
    assert!(html.contains("<h1>Authorize a mobile app?</h1>"));
    assert!(html.contains("It will receive the result in the Chan app at chan://auth/callback."));
    let csrf = extract_csrf(html);

    let confirm = c
        .post_form(
            "/mobile/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(confirm.status, StatusCode::OK);
    assert!(confirm.location.is_empty());
    let handoff_url = extract_handoff_url_with_prefix(confirm.body_str(), "chan://auth/callback?");
    let query = parse_callback_query(&handoff_url);
    assert_eq!(
        query.get("state").map(String::as_str),
        Some("mobile-nonce-1")
    );
    let code = query.get("code").expect("redemption code").clone();

    // Desktop redeem must refuse a mobile redemption code without
    // consuming it from the mobile redemption store.
    let wrong_redeem = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(wrong_redeem.status, StatusCode::GONE);

    // Mobile redeem succeeds once and omits `wireguard`.
    let redeem = c
        .post_json(
            "/mobile/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(redeem.status, StatusCode::OK);
    let redeemed: Value = serde_json::from_slice(&redeem.body).unwrap();
    assert!(redeemed.get("wireguard").is_none(), "{redeemed}");
    assert_eq!(redeemed["label"], "chan-ios @ iphone");
    let secret = redeemed["secret"].as_str().unwrap();
    assert!(secret.starts_with("chan_pat_"));
    let token_id: Uuid = redeemed["id"].as_str().unwrap().parse().unwrap();

    // Replay is 410 Gone.
    let replay = c
        .post_json(
            "/mobile/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(replay.status, StatusCode::GONE);

    let validated = app
        .api_tokens
        .validate(secret, &RequestMeta::default())
        .await
        .expect("mobile PAT validates");
    assert_eq!(validated.scopes, vec!["mobile.account".to_string()]);

    let entries = app.api_tokens.audit(uid, token_id, 10).await.unwrap();
    let mut actions: Vec<_> = entries.iter().map(|e| e.action.as_str()).collect();
    actions.sort_unstable();
    assert_eq!(actions, vec!["created_via_mobile", "mobile.redeem", "used"]);

    app.cleanup().await;
}

#[tokio::test]
async fn desktop_code_is_rejected_by_mobile_redeem_and_desktop_authorize_rejects_chan_scheme() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let email = "desktop-iso@example.com";
    app.insert_user(uid, email).await;

    let mut c = Client::new(&app);
    // /desktop/authorize rejects chan://auth/callback, and /mobile/authorize
    // rejects loopback http://127.0.0.1.
    let bad_desktop = c
        .get(&DESKTOP_AUTH_URI.replace(
            "http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback",
            "chan%3A%2F%2Fauth%2Fcallback",
        ))
        .await;
    assert_eq!(bad_desktop.status, StatusCode::BAD_REQUEST);

    let bad_mobile = c
        .get(&MOBILE_AUTH_URI.replace(
            "chan%3A%2F%2Fauth%2Fcallback",
            "http%3A%2F%2F127.0.0.1%3A54321%2Fauth%2Fcallback",
        ))
        .await;
    assert_eq!(bad_mobile.status, StatusCode::BAD_REQUEST);

    mount_oauth(&app, uid, email, false, true).await;
    mock_get_user(&app, uid, email, false).await;

    assert_eq!(c.get(DESKTOP_AUTH_URI).await.status, StatusCode::SEE_OTHER);
    assert_eq!(
        complete_oauth(&mut c).await.location,
        "/desktop/authorize/consent"
    );
    let consent = c.get("/desktop/authorize/consent").await;
    let csrf = extract_csrf(consent.body_str());
    let confirm = c
        .post_form(
            "/desktop/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    let handoff_url = extract_handoff_url_with_prefix(
        confirm.body_str(),
        "http://127.0.0.1:54321/auth/callback?",
    );
    let code = parse_callback_query(&handoff_url)
        .get("code")
        .cloned()
        .unwrap();

    // Mobile redeem rejects the desktop code with 410 without consuming it.
    let wrong = c
        .post_json(
            "/mobile/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::GONE);

    let right = c
        .post_json(
            "/desktop/authorize/redeem",
            &json!({ "code": code, "code_verifier": PKCE_VERIFIER }),
        )
        .await;
    assert_eq!(right.status, StatusCode::OK);

    app.cleanup().await;
}

#[tokio::test]
async fn starting_mobile_authorize_clears_stale_desktop_stash_and_vice_versa() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let email = "stash@example.com";
    app.insert_user(uid, email).await;
    mount_oauth(&app, uid, email, false, true).await;
    mock_get_user(&app, uid, email, false).await;

    let mut c = Client::new(&app);
    assert_eq!(c.get(DESKTOP_AUTH_URI).await.status, StatusCode::SEE_OTHER);
    // Starting mobile authorize in the same session clears desktop's stash.
    assert_eq!(c.get(MOBILE_AUTH_URI).await.status, StatusCode::SEE_OTHER);

    let cb = complete_oauth(&mut c).await;
    assert_eq!(cb.location, "/mobile/authorize/consent");
    assert_eq!(
        c.get("/desktop/authorize/consent").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        c.get("/mobile/authorize/consent").await.status,
        StatusCode::OK
    );

    // Starting desktop authorize now clears the mobile stash and its CSRF.
    assert_eq!(c.get(DESKTOP_AUTH_URI).await.status, StatusCode::SEE_OTHER);
    assert_eq!(
        c.get("/mobile/authorize/consent").await.status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        c.get("/desktop/authorize/consent").await.status,
        StatusCode::OK
    );

    app.cleanup().await;
}

#[tokio::test]
async fn mobile_oauth_bounce_surfaces_blocked_and_oauth_denied_to_callback() {
    let app = TestApp::new().await;
    let blocked_uid = Uuid::new_v4();
    app.insert_user(blocked_uid, "blocked@example.com").await;
    mount_oauth(&app, blocked_uid, "blocked@example.com", true, true).await;

    let mut c = Client::new(&app);
    assert_eq!(c.get(MOBILE_AUTH_URI).await.status, StatusCode::SEE_OTHER);
    let cb = complete_oauth(&mut c).await;
    assert_eq!(cb.status, StatusCode::SEE_OTHER);
    assert!(cb.location.starts_with("chan://auth/callback?"));
    assert_eq!(
        parse_callback_query(&cb.location)
            .get("error")
            .map(String::as_str),
        Some("account_blocked")
    );
    app.cleanup().await;

    let app2 = TestApp::new().await;
    let denied_uid = Uuid::new_v4();
    app2.insert_user(denied_uid, "denied@example.com").await;
    mount_oauth(&app2, denied_uid, "denied@example.com", false, false).await;

    let mut c2 = Client::new(&app2);
    assert_eq!(c2.get(MOBILE_AUTH_URI).await.status, StatusCode::SEE_OTHER);
    let cb2 = complete_oauth(&mut c2).await;
    assert_eq!(cb2.status, StatusCode::SEE_OTHER);
    assert!(cb2.location.starts_with("chan://auth/callback?"));
    assert_eq!(
        parse_callback_query(&cb2.location)
            .get("error")
            .map(String::as_str),
        Some("oauth_denied")
    );
    app2.cleanup().await;
}

#[tokio::test]
async fn mobile_and_desktop_v1_routes_enforce_strict_scope_isolation() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let username = placeholder_username(uid);
    let devserver_id = "a".repeat(64);
    app.insert_user(uid, "scopes@example.com").await;

    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/grants/owned")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "owner_user_id": uid,
            "devserver_id": devserver_id,
            "label": "box",
            "grant_count": 0,
        }])))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/v1/users/{uid}/grants/incoming")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&app.profile)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/v1/users/{uid}/devservers/{devserver_id}/access"
        )))
        .and(query_param("as", uid.to_string()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"access": true})))
        .mount(&app.profile)
        .await;
    mock_live_tunnel(&app, uid, &username, &devserver_id).await;

    let mobile_pat = mint_pat(&app, uid, &["mobile.account"], TokenOrigin::Mobile).await;
    let desktop_acct = mint_pat(&app, uid, &["desktop.account"], TokenOrigin::Desktop).await;
    let desktop_conn = mint_pat(&app, uid, &["desktop.connect"], TokenOrigin::Desktop).await;
    let tunnel_pat = mint_pat(&app, uid, &["tunnel"], TokenOrigin::Spa).await;

    // /mobile/v1/* rejects desktop.account, desktop.connect, and tunnel.
    for wrong in [
        &desktop_acct.secret,
        &desktop_conn.secret,
        &tunnel_pat.secret,
    ] {
        assert_eq!(
            send_bearer(
                &app,
                Method::GET,
                "/mobile/v1/devservers",
                Some(wrong),
                None
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send_bearer(
                &app,
                Method::POST,
                "/mobile/v1/devserver/entry",
                Some(wrong),
                Some(json!({})),
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send_bearer(&app, Method::DELETE, "/mobile/v1/token", Some(wrong), None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }

    // /desktop/v1/* rejects mobile.account.
    assert_eq!(
        send_bearer(
            &app,
            Method::GET,
            "/desktop/v1/devservers",
            Some(&mobile_pat.secret),
            None,
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send_bearer(
            &app,
            Method::POST,
            "/desktop/v1/devserver/entry",
            Some(&mobile_pat.secret),
            Some(json!({})),
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send_bearer(
            &app,
            Method::DELETE,
            "/desktop/v1/token",
            Some(&mobile_pat.secret),
            None,
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );

    // /mobile/v1/devservers succeeds with mobile.account.
    let (status, roster_bytes) = send_bearer(
        &app,
        Method::GET,
        "/mobile/v1/devservers",
        Some(&mobile_pat.secret),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let roster: Value = serde_json::from_slice(&roster_bytes).unwrap();
    assert_eq!(roster["devservers"][0]["devserver_id"], devserver_id);

    // /mobile/v1/devserver/entry mints an entry credential carrying ClientType::Mobile.
    let (status, entry_bytes) = send_bearer(
        &app,
        Method::POST,
        "/mobile/v1/devserver/entry",
        Some(&mobile_pat.secret),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entry: Value = serde_json::from_slice(&entry_bytes).unwrap();
    let expected_aud = format!("{username}--{}.p1.proxy.chan.app", &devserver_id[..12]);
    let claims = devserver_gate::decode_entry(
        &app.entry_verifier,
        entry["entry_credential"].as_str().unwrap(),
        "p1",
        &expected_aud,
        &devserver_id,
        uid,
    )
    .expect("entry credential verifies");
    assert_eq!(claims.client, devserver_gate::ClientType::Mobile);

    // /mobile/v1/token revokes the used mobile.account PAT under
    // `revoked_via_mobile` and triggers the owner cut.
    Mock::given(method("POST"))
        .and(path(format!(
            "/v1/users/{uid}/tokens/{}/revoke",
            mobile_pat.token.id
        )))
        .respond_with(ResponseTemplate::new(202))
        .expect(1)
        .mount(&app.profile)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/admin/v1/owners/{uid}/tunnels/kill")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"killed": 1})))
        .expect(1)
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
        .expect(1)
        .mount(&app.control)
        .await;

    let (revoke_status, _) = with_cuts_settled(send_bearer(
        &app,
        Method::DELETE,
        "/mobile/v1/token",
        Some(&mobile_pat.secret),
        None,
    ))
    .await;
    assert_eq!(revoke_status, StatusCode::NO_CONTENT);

    let mut actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM api_token_audit WHERE token_id = $1")
            .bind(mobile_pat.token.id)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    actions.sort_unstable();
    // Both the refused desktop entry and the accepted mobile entry audit
    // the PAT validation that precedes their scope checks.
    assert_eq!(
        actions,
        vec!["created_via_mobile", "revoked_via_mobile", "used", "used"]
    );

    app.cleanup().await;
}

#[tokio::test]
async fn spa_tokens_create_rejects_mobile_scopes_and_reserves_desktop_and_mobile_usernames() {
    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    let email = "spa@example.com";
    app.insert_user(uid, email).await;
    mount_oauth(&app, uid, email, false, true).await;
    mock_get_user(&app, uid, email, false).await;

    let mut c = Client::new(&app);
    assert_eq!(complete_oauth(&mut c).await.status, StatusCode::SEE_OTHER);

    for bad_scopes in [
        json!(["mobile.account"]),
        json!(["tunnel", "mobile.account"]),
        json!(["mobile.other"]),
    ] {
        let resp = c
            .post_json(
                "/api/tokens",
                &json!({"label": "cli", "scopes": bad_scopes}),
            )
            .await;
        assert_eq!(resp.status, StatusCode::BAD_REQUEST, "{bad_scopes}");
        let body: Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(body["error"], "invalid scopes", "{bad_scopes}");
    }

    for reserved in ["desktop", "mobile"] {
        let resp = c
            .patch_json("/api/me/username", &json!({"username": reserved}))
            .await;
        assert_eq!(resp.status, StatusCode::BAD_REQUEST, "{reserved}");
        let body: Value = serde_json::from_slice(&resp.body).unwrap();
        assert_eq!(body["error"], "username is reserved", "{reserved}");
    }

    app.cleanup().await;
}
