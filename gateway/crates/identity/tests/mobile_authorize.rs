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
        let entry_signer = devserver_gate::EntrySigner::from_base64(ENTRY_SIGNING_KEY).unwrap();
        let entry_verifier =
            EntryVerifierRing::from_base64_list(&entry_signer.verifying_key_base64()).unwrap();

        let cfg = Arc::new(Config {
            base_url,
            devserver_proxy_origin: "https://proxy.chan.app".parse().unwrap(),
            entry_signer,
            providers: vec![Arc::new(provider)],
            wireguard,
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
        let response = client.get(&format!("{MOBILE_AUTH_URI}&{query}")).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&response.body).unwrap(),
            json!({"error":expected})
        );
    }
    app.cleanup().await;
}

/// Two ingresses under the test config's proxy origin, `p1` first, on one
/// shared pair of tunnel addresses.
fn wireguard_enrollment() -> identity::wireguard::WireguardEnrollment {
    use base64::Engine;
    let ingress = |id: &str, byte| gateway_common::wireguard::Ingress {
        id: id.into(),
        endpoint: format!("{id}.proxy.chan.app:51820"),
        public_key: base64::engine::general_purpose::STANDARD.encode([byte; 32]),
    };
    identity::wireguard::WireguardEnrollment::new(
        vec![ingress("p1", 9), ingress("p2", 10)],
        "proxy.chan.app",
        &["10.7.0.1".parse().unwrap(), "fd00:7::1".parse().unwrap()],
        vec!["10.7.0.1/32".into(), "fd00:7::1/128".into()],
        Some(25),
    )
    .unwrap()
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
    let response = client.get(&format!("{MOBILE_AUTH_URI}&{query}")).await;
    assert_eq!(response.status, StatusCode::SEE_OTHER);
    assert_eq!(response.location, "/");
    mount_oauth(app, uid, email, false, true).await;
    mock_get_user(app, uid, email, false).await;
    let callback = complete_oauth(client).await;
    assert_eq!(callback.status, StatusCode::SEE_OTHER);
    assert_eq!(callback.location, "/mobile/authorize/consent");
    let response = client.get("/mobile/authorize/consent").await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.body_str().contains("WireGuard key"));
    // The page names both ingresses the fixture offers, by id and endpoint.
    for ingress in [
        "p1 at p1.proxy.chan.app:51820",
        "p2 at p2.proxy.chan.app:51820",
    ] {
        assert!(response.body_str().contains(ingress), "{ingress}");
    }
    extract_csrf(response.body_str())
}

#[tokio::test]
async fn full_flow_with_a_wireguard_key_enrolls_one_peer_and_answers_one_address_with_every_ingress(
) {
    use base64::Engine;
    let key = |byte: u8| base64::engine::general_purpose::STANDARD.encode([byte; 32]);
    let app = TestApp::with_wireguard(Some(wireguard_enrollment())).await;
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
            // The peer names a host, as a profile that keys peers by host
            // answers it; identity reads the addresses and not the host.
            let body: serde_json::Value = request.body_json().unwrap();
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
            "/mobile/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let query = parse_callback_query(&extract_handoff_url_with_prefix(
        response.body_str(),
        "chan://auth/callback?",
    ));
    assert!(!query.contains_key("error"));
    let code = query.get("code").unwrap();
    let response = client
        .post_json(
            "/mobile/authorize/redeem",
            &json!({"code":code, "code_verifier":PKCE_VERIFIER}),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let payload: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
    let hosts = |id: &str| {
        json!([
            {"name":format!("{id}.proxy.chan.app"), "addresses":["10.7.0.1", "fd00:7::1"]},
            {"name":format!("*.{id}.proxy.chan.app"), "addresses":["10.7.0.1", "fd00:7::1"]},
        ])
    };
    // One address set, the first ingress in the single-peer fields, and
    // both ingresses in the list.
    assert_eq!(
        payload["wireguard"],
        json!({
            "server_public_key":key(9), "endpoint":"p1.proxy.chan.app:51820",
            "addresses":["10.7.0.23/32", "fd00:7::23/128"], "allowed_ips":["10.7.0.1/32", "fd00:7::1/128"],
            "persistent_keepalive":25, "hosts":hosts("p1"),
            "ingresses":[
                {"id":"p1", "endpoint":"p1.proxy.chan.app:51820", "server_public_key":key(9), "hosts":hosts("p1")},
                {"id":"p2", "endpoint":"p2.proxy.chan.app:51820", "server_public_key":key(10), "hosts":hosts("p2")},
            ],
        })
    );
    // The redeem names the peers discovery names: the single pair, which a
    // client that reads no list compares, and the list entry for entry,
    // with each key under the redeem's name for it.
    let response = client.get("/.well-known/chan-gateway").await;
    assert_eq!(response.status, StatusCode::OK);
    let discovery =
        serde_json::from_slice::<serde_json::Value>(&response.body).unwrap()["wireguard"].take();
    assert_eq!(
        payload["wireguard"]["server_public_key"],
        discovery["public_key"]
    );
    for field in ["endpoint", "allowed_ips", "persistent_keepalive"] {
        assert_eq!(payload["wireguard"][field], discovery[field], "{field}");
    }
    let mut listed = discovery["ingresses"].clone();
    for ingress in listed.as_array_mut().unwrap() {
        let ingress = ingress.as_object_mut().unwrap();
        let public_key = ingress.remove("public_key").unwrap();
        ingress.insert("server_public_key".into(), public_key);
    }
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert_eq!(payload["wireguard"]["ingresses"], listed);
    let token: Uuid = payload["id"].as_str().unwrap().parse().unwrap();
    let rows = app.api_tokens.list(uid).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, token);
    assert!(rows[0].revoked_at.is_none());
    assert!(payload["secret"].as_str().unwrap().starts_with("chan_pat_"));
    // One enrollment for every ingress: profile is asked once, for the
    // minted token, with the first ingress as the host.
    let enrolls: Vec<serde_json::Value> = app
        .profile
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|request| request.url.path().ends_with("/wireguard/peers"))
        .map(|request| request.body_json().unwrap())
        .collect();
    assert_eq!(
        enrolls,
        [json!({"token_id":token, "public_key":key(7), "host":"p1"})]
    );
    let audits: Vec<String> =
        sqlx::query_scalar("SELECT action FROM api_token_audit WHERE token_id = $1 ORDER BY id")
            .bind(token)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    assert_eq!(audits, ["created_via_mobile", "mobile.redeem"]);
    assert_eq!(
        client
            .post_json(
                "/mobile/authorize/redeem",
                &json!({"code":code,"code_verifier":PKCE_VERIFIER})
            )
            .await
            .status,
        StatusCode::GONE
    );
    app.profile.verify().await;
    assert!(app.control.received_requests().await.unwrap().is_empty());
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
            "/mobile/authorize/confirm",
            &[("csrf", &csrf), ("action", "allow")],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let query = parse_callback_query(&extract_handoff_url_with_prefix(
        response.body_str(),
        "chan://auth/callback?",
    ));
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
    assert_eq!(audits, ["created_via_mobile", "revoked"]);
    let requests = app.profile.received_requests().await.unwrap();
    assert!(requests
        .iter()
        .any(|request| request.url.path().ends_with("/wireguard/peers")));
    assert!(!requests
        .iter()
        .any(|request| request.url.path().contains("revoke")));
    app.profile.verify().await;
    assert!(app.control.received_requests().await.unwrap().is_empty());
    app.cleanup().await;
}

#[tokio::test]
async fn mobile_token_give_back_removes_its_peer_from_the_real_profile_active_set() {
    use base64::Engine;
    use gateway_common::wireguard::{PeerList, PeerListResponse};

    let app = TestApp::new().await;
    let uid = Uuid::new_v4();
    app.insert_user(uid, "mobile-peer@example.com").await;
    let token = mint_pat(&app, uid, &["mobile.account"], TokenOrigin::Mobile).await;
    let profile = profile::http::app(profile::http::AppState {
        pool: app.pool.clone(),
        auth_token: PROFILE_TOKEN.into(),
        admin_token: None,
        wireguard: profile::wireguard::Config::parse(
            Some("10.7.0.0/24"),
            None,
            Some("10.7.0.1"),
            None,
        )
        .unwrap(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, profile)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client = ProfileClient::new(
        format!("http://{address}").parse().unwrap(),
        PROFILE_TOKEN.into(),
    )
    .unwrap();
    let public_key = base64::engine::general_purpose::STANDARD.encode([7; 32]);
    let peer = client
        .enroll_wireguard_peer(uid, token.token.id, &public_key, "p1")
        .await
        .unwrap();
    assert_eq!(peer.public_key, public_key);
    assert_eq!(peer.token_id, token.token.id);
    let PeerListResponse::Modified { body, etag } =
        client.list_wireguard_peers("p1", None).await.unwrap()
    else {
        panic!("unconditional list must return a body");
    };
    let listed: PeerList = serde_json::from_slice(&body).unwrap();
    assert_eq!(listed.host, "p1");
    assert_eq!(listed.peers.len(), 1);
    assert_eq!(listed.peers[0].public_key, public_key);
    assert_eq!(listed.peers[0].allowed_ips, peer.addresses);
    assert_eq!(
        send_bearer(
            &app,
            Method::DELETE,
            "/desktop/v1/token",
            Some(&token.secret),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED,
    );
    assert!(app.api_tokens.presented(&token.secret).await.is_ok());
    assert!(app.api_tokens.list(uid).await.unwrap()[0]
        .last_used_at
        .is_none());
    assert_eq!(
        send_bearer(
            &app,
            Method::DELETE,
            "/mobile/v1/token",
            Some(&token.secret),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT,
    );
    let PeerListResponse::Modified {
        body,
        etag: revoked_etag,
    } = client
        .list_wireguard_peers("p1", Some(&etag))
        .await
        .unwrap()
    else {
        panic!("revocation must invalidate the active peer list");
    };
    assert_ne!(revoked_etag, etag);
    let listed: PeerList = serde_json::from_slice(&body).unwrap();
    assert!(listed.peers.is_empty());
    assert!(app.api_tokens.presented(&token.secret).await.is_err());
    let audits: Vec<String> =
        sqlx::query_scalar("SELECT action FROM api_token_audit WHERE token_id = $1 ORDER BY id")
            .bind(token.token.id)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    assert_eq!(
        audits,
        [
            "created_via_mobile",
            "wireguard_enrolled",
            "revoked_via_mobile"
        ]
    );
    assert!(app.control.received_requests().await.unwrap().is_empty());
    assert!(app.profile.received_requests().await.unwrap().is_empty());
    stop.send(()).unwrap();
    server.await.unwrap();
    app.cleanup().await;
}
