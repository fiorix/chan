//! Discovery and the internal peer relay, with an isolated profile stand-in.

#[path = "../../../tests-shared/identity_config.rs"]
mod identity_config;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::Router;
use base64::Engine;
use gateway_common::wireguard::Ingress;
use identity::wireguard::WireguardEnrollment;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use wiremock::matchers::{header as has_header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn key(byte: u8) -> String {
    base64::engine::general_purpose::STANDARD.encode([byte; 32])
}

fn ingress(id: &str, byte: u8) -> Ingress {
    Ingress {
        id: id.into(),
        endpoint: format!("{id}.proxy.example.test:51820"),
        public_key: key(byte),
    }
}

/// An enrollment under the test config's proxy origin, its ingresses in
/// the order given.
fn enrollment_of(ingresses: Vec<Ingress>, keepalive: Option<u16>) -> WireguardEnrollment {
    WireguardEnrollment::new(
        ingresses,
        "proxy.example.test",
        &["10.7.0.1".parse().unwrap()],
        vec!["10.7.0.1/32".into()],
        keepalive,
    )
    .unwrap()
}

/// Two ingresses, `p1` first.
fn enrollment() -> WireguardEnrollment {
    enrollment_of(vec![ingress("p1", 7), ingress("p2", 8)], Some(25))
}

async fn apps(
    profile: &MockServer,
    wireguard: Option<WireguardEnrollment>,
    agent: &str,
) -> (Router, Router) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    pool.close().await;
    let client = identity::profile_client::ProfileClient::new(
        profile.uri().parse().unwrap(),
        "test-profile".into(),
    )
    .unwrap();
    let mut cfg = identity_config::test_config("unused", client);
    cfg.wireguard = wireguard;
    cfg.wireguard_agent_token = agent.into();
    identity::http::routers(
        Arc::new(cfg),
        tower_sessions_sqlx_store::PostgresStore::new(pool.clone()),
        identity::api_tokens::ApiTokenService::new(pool),
        identity::token_throttle::TokenThrottle::new(),
    )
}

async fn request(
    app: Router,
    uri: &str,
    auth: Option<&str>,
    condition: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut request = Request::get(uri);
    if let Some(auth) = auth {
        request = request.header(header::AUTHORIZATION, format!("Bearer {auth}"));
    }
    if let Some(condition) = condition {
        request = request.header(header::IF_NONE_MATCH, condition);
    }
    let response = app
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}

#[tokio::test]
async fn discovery_advertises_wireguard_only_when_configured() {
    let profile = MockServer::start().await;
    let (public, _) = apps(&profile, None, "").await;
    let (status, _, baseline) = request(public, "/.well-known/chan-gateway", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let expected = r#"{"kind":"chan-gateway","api_version":1,"identity_origin":"http://localhost:7000","desktop_authorize_url":"http://localhost:7000/desktop/authorize","desktop_entry_url":"http://localhost:7000/desktop/v1/devserver/entry","roster_url":"http://localhost:7000/desktop/v1/devservers","devserver_proxy_origin":"https://proxy.example.test","devserver_proxy_host_depth":2,"tunnel_url":"https://tunnel.example.test/v1/tunnel"}"#;
    assert_eq!(baseline, expected.as_bytes());
    let (public, _) = apps(&profile, Some(enrollment()), "").await;
    let (status, _, body) = request(public, "/.well-known/chan-gateway", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let mut discovery: Value = serde_json::from_slice(&body).unwrap();
    assert!(discovery
        .as_object_mut()
        .unwrap()
        .remove("wireguard")
        .unwrap()
        .is_object());
    assert_eq!(
        discovery,
        serde_json::from_slice::<Value>(&baseline).unwrap()
    );
}

/// The `wireguard` object of the discovery document `wireguard` configures.
async fn discovered(wireguard: WireguardEnrollment) -> Value {
    let profile = MockServer::start().await;
    let (public, _) = apps(&profile, Some(wireguard), "").await;
    let (status, _, body) = request(public, "/.well-known/chan-gateway", None, None).await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_slice::<Value>(&body).unwrap()["wireguard"].take()
}

#[tokio::test]
async fn discovery_lists_every_ingress_and_repeats_the_first_as_the_single_pair() {
    assert_eq!(
        discovered(enrollment()).await,
        json!({
            "endpoint": "p1.proxy.example.test:51820",
            "public_key": key(7),
            "allowed_ips": ["10.7.0.1/32"],
            "persistent_keepalive": 25,
            "ingresses": [
                {
                    "id": "p1",
                    "endpoint": "p1.proxy.example.test:51820",
                    "public_key": key(7),
                    "hosts": [
                        {"name": "p1.proxy.example.test", "addresses": ["10.7.0.1"]},
                        {"name": "*.p1.proxy.example.test", "addresses": ["10.7.0.1"]},
                    ],
                },
                {
                    "id": "p2",
                    "endpoint": "p2.proxy.example.test:51820",
                    "public_key": key(8),
                    "hosts": [
                        {"name": "p2.proxy.example.test", "addresses": ["10.7.0.1"]},
                        {"name": "*.p2.proxy.example.test", "addresses": ["10.7.0.1"]},
                    ],
                },
            ],
        })
    );

    // The single pair follows the list's first entry, not an id, and the
    // keepalive is left out when it is off.
    let reversed = enrollment_of(vec![ingress("p2", 8), ingress("p1", 7)], None);
    let wireguard = discovered(reversed).await;
    assert_eq!(wireguard["endpoint"], "p2.proxy.example.test:51820");
    assert_eq!(wireguard["public_key"], key(8));
    assert_eq!(wireguard["ingresses"][0]["id"], "p2");
    assert_eq!(wireguard["ingresses"][1]["id"], "p1");
    assert!(wireguard.get("persistent_keepalive").is_none());
    assert_eq!(wireguard.as_object().unwrap().len(), 4);
}

#[tokio::test]
async fn wireguard_peers_route_requires_its_own_bearer_and_relays_profile() {
    let profile = MockServer::start().await;
    let (public, internal) = apps(&profile, Some(enrollment()), "test-wireguard-agent").await;
    let uri = "/internal/v1/wireguard/peers?host=p1";
    for token in [
        None,
        Some("wrong"),
        Some("test-internal"),
        Some("test-session-internal"),
    ] {
        assert_eq!(
            request(internal.clone(), uri, token, None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(public, uri, Some("test-wireguard-agent"), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (_, disabled) = apps(&profile, Some(enrollment()), "").await;
    assert_eq!(
        request(disabled, uri, Some("test-wireguard-agent"), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    for host in ["", "P1", "p1.example", "-p1"] {
        assert_eq!(
            request(
                internal.clone(),
                &format!("/internal/v1/wireguard/peers?host={host}"),
                Some("test-wireguard-agent"),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert!(profile.received_requests().await.unwrap().is_empty());
    let body = r#"{ "host": "p1", "peers": [] }"#;
    let etag = "\"a1b2\"";
    Mock::given(method("GET"))
        .and(path("/v1/wireguard/peers"))
        .and(query_param("host", "p1"))
        .and(has_header("authorization", "Bearer test-profile"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", etag)
                .set_body_raw(body, "application/json"),
        )
        .expect(1)
        .mount(&profile)
        .await;
    let (status, headers, actual) =
        request(internal.clone(), uri, Some("test-wireguard-agent"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::ETAG], etag);
    assert_eq!(actual, body.as_bytes());
    profile.verify().await;
    profile.reset().await;
    Mock::given(method("GET"))
        .and(path("/v1/wireguard/peers"))
        .and(query_param("host", "p1"))
        .and(has_header("if-none-match", etag))
        .respond_with(ResponseTemplate::new(304).insert_header("etag", etag))
        .expect(1)
        .mount(&profile)
        .await;
    let (status, headers, body) = request(
        internal.clone(),
        uri,
        Some("test-wireguard-agent"),
        Some(etag),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
    assert_eq!(headers[header::ETAG], etag);
    assert!(body.is_empty());
    profile.verify().await;
    profile.reset().await;
    for status in [400, 401, 500] {
        Mock::given(method("GET"))
            .and(path("/v1/wireguard/peers"))
            .respond_with(ResponseTemplate::new(status))
            .expect(1)
            .mount(&profile)
            .await;
        assert_eq!(
            request(internal.clone(), uri, Some("test-wireguard-agent"), None)
                .await
                .0,
            StatusCode::BAD_GATEWAY
        );
        profile.verify().await;
        profile.reset().await;
    }
}

const AGENT: &str = "test-wireguard-agent";

fn peers_uri(host: &str) -> String {
    format!("/internal/v1/wireguard/peers?host={host}")
}

/// A peer list as profile answers it for `host`: the host echoed, and one
/// entry per key.
fn list_body(host: &str, keys: &[&str]) -> String {
    let peers: Vec<Value> = keys
        .iter()
        .map(|key| json!({"public_key": key, "allowed_ips": ["10.7.0.23/32"]}))
        .collect();
    json!({"host": host, "peers": peers}).to_string()
}

/// Have profile answer one list read for `host` with `body` under `etag`,
/// only for a request carrying `condition` when one is given.
async fn mount_list(
    profile: &MockServer,
    host: &str,
    etag: &str,
    body: &str,
    condition: Option<&str>,
) {
    let mock = Mock::given(method("GET"))
        .and(path("/v1/wireguard/peers"))
        .and(query_param("host", host));
    let mock = match condition {
        Some(condition) => mock.and(has_header("if-none-match", condition)),
        None => mock,
    };
    mock.respond_with(
        ResponseTemplate::new(200)
            .insert_header("etag", etag)
            .set_body_raw(body.to_owned(), "application/json"),
    )
    .expect(1)
    .mount(profile)
    .await;
}

/// Have profile answer every other list read with an empty list, so a read
/// identity should not have relayed is answered, and counted, instead of
/// failing for want of a mock.
async fn mount_empty_lists(profile: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/v1/wireguard/peers"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"empty\"")
                .set_body_raw(r#"{"host":"any","peers":[]}"#, "application/json"),
        )
        .with_priority(10)
        .mount(profile)
        .await;
}

#[tokio::test]
async fn wireguard_peers_route_relays_each_configured_ingress_and_answers_404_for_another_host() {
    let profile = MockServer::start().await;
    mount_empty_lists(&profile).await;
    let (_, internal) = apps(&profile, Some(enrollment()), AGENT).await;
    let peer = key(1);
    for (host, etag) in [("p1", "\"e1\""), ("p2", "\"e2\"")] {
        let body = list_body(host, &[&peer]);
        mount_list(&profile, host, etag, &body, None).await;
        let (status, headers, actual) =
            request(internal.clone(), &peers_uri(host), Some(AGENT), None).await;
        assert_eq!(status, StatusCode::OK, "{host}");
        assert_eq!(headers[header::ETAG], etag);
        assert_eq!(actual, body.as_bytes());
    }
    profile.verify().await;
    assert_eq!(profile.received_requests().await.unwrap().len(), 2);

    // A host that is no configured ingress is not found, and profile, which
    // would answer it, is not asked.
    let (status, _, body) = request(internal.clone(), &peers_uri("p9"), Some(AGENT), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, br#"{"error":"not found"}"#);
    // The bearer is checked first, so a caller without it learns nothing
    // of which hosts are configured.
    for token in [None, Some("wrong")] {
        let unknown = request(internal.clone(), &peers_uri("p9"), token, None).await;
        assert_eq!(unknown.0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            unknown,
            request(internal.clone(), &peers_uri("p1"), token, None).await
        );
    }
    assert_eq!(profile.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn wireguard_peers_route_relays_every_well_formed_host_while_enrollment_is_off() {
    let profile = MockServer::start().await;
    let (_, off) = apps(&profile, None, AGENT).await;
    let peer = key(1);
    // No list names an ingress, so no host disagrees with one: a host is
    // relayed whatever its id, with that id and the ETag its agent holds.
    for (host, held, etag) in [
        ("p1", "\"held-1\"", "\"e1\""),
        ("p2", "\"held-2\"", "\"e2\""),
        ("p9", "\"held-9\"", "\"e9\""),
    ] {
        let body = list_body(host, &[&peer]);
        mount_list(&profile, host, etag, &body, Some(held)).await;
        let (status, headers, actual) =
            request(off.clone(), &peers_uri(host), Some(AGENT), Some(held)).await;
        assert_eq!(status, StatusCode::OK, "{host}");
        assert_eq!(headers[header::ETAG], etag);
        assert_eq!(actual, body.as_bytes());
    }
    profile.verify().await;
    assert_eq!(profile.received_requests().await.unwrap().len(), 3);

    // The bearer is still checked first, and an unset agent bearer still
    // answers as an absent route.
    for token in [None, Some("wrong")] {
        for host in ["p1", "p9"] {
            assert_eq!(
                request(off.clone(), &peers_uri(host), token, None).await.0,
                StatusCode::UNAUTHORIZED,
                "{host}"
            );
        }
    }
    let (_, no_bearer) = apps(&profile, None, "").await;
    assert_eq!(
        request(no_bearer, &peers_uri("p1"), Some(AGENT), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // A host that is missing or is no label is a bad request before any
    // relay, with enrollment on or off.
    let (_, on) = apps(&profile, Some(enrollment()), AGENT).await;
    for app in [on, off] {
        for uri in ["/internal/v1/wireguard/peers".to_owned(), peers_uri("P1")] {
            assert_eq!(
                request(app.clone(), &uri, Some(AGENT), None).await.0,
                StatusCode::BAD_REQUEST,
                "{uri}"
            );
        }
    }
    assert_eq!(profile.received_requests().await.unwrap().len(), 3);
}

/// Every line this test executable logs, whichever test logs it. The
/// subscriber is the process's one default, not a per-thread one: a
/// callsite's interest is cached process-wide, and a test on another thread
/// that reached the callsite first would cache it as disabled.
#[derive(Clone, Default)]
struct Logged(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Logged {
    fn install() -> &'static Self {
        static LOGGED: std::sync::OnceLock<Logged> = std::sync::OnceLock::new();
        LOGGED.get_or_init(|| {
            let logged = Logged::default();
            let writer = logged.clone();
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish();
            tracing::subscriber::set_global_default(subscriber).unwrap();
            logged
        })
    }

    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }

    /// The lines carrying the field `host=<host>`.
    fn about(&self, host: &str) -> Vec<String> {
        let field = format!("host={host}");
        self.text()
            .lines()
            .filter(|line| line.split_whitespace().any(|word| word == field))
            .map(str::to_owned)
            .collect()
    }
}

#[tokio::test]
async fn an_unlisted_host_is_logged_once_at_warn_with_its_label_and_without_the_bearer() {
    let logged = Logged::install();
    let profile = MockServer::start().await;
    mount_empty_lists(&profile).await;
    // Ids and hosts no other test names, since the log is the process's.
    let listed = enrollment_of(vec![ingress("n1", 7)], None);
    let (_, on) = apps(&profile, Some(listed), AGENT).await;
    let (_, off) = apps(&profile, None, AGENT).await;

    let poll = |app: &Router, host: &str, token| {
        let (app, uri) = (app.clone(), peers_uri(host));
        async move { request(app, &uri, token, None).await.0 }
    };
    assert_eq!(poll(&on, "q7", Some(AGENT)).await, StatusCode::NOT_FOUND);
    let lines = logged.about("q7");
    assert_eq!(lines.len(), 1, "{lines:?}");
    let line = &lines[0];
    assert!(line.contains(" WARN "), "{line}");
    assert!(line.contains("WIREGUARD_INGRESSES"), "{line}");
    assert!(line.contains("polls=1"), "{line}");

    // An agent polls again within seconds, and is answered without a line.
    assert_eq!(poll(&on, "q7", Some(AGENT)).await, StatusCode::NOT_FOUND);
    assert_eq!(logged.about("q7").len(), 1);

    // Nothing else is logged about a host: not a caller without the
    // bearer, a host that is no label, a listed host, or any host while
    // enrollment is off.
    for token in [None, Some("wrong")] {
        assert_eq!(poll(&on, "q8", token).await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(poll(&on, "Q8", Some(AGENT)).await, StatusCode::BAD_REQUEST);
    assert_eq!(poll(&on, "n1", Some(AGENT)).await, StatusCode::OK);
    assert_eq!(poll(&off, "q9", Some(AGENT)).await, StatusCode::OK);
    for host in ["q8", "Q8", "n1", "q9"] {
        assert_eq!(logged.about(host), Vec::<String>::new());
    }
    // No line of any test holds a bearer.
    let text = logged.text();
    for bearer in [AGENT, "test-profile"] {
        assert!(!text.contains(bearer), "{text}");
    }
}

#[tokio::test]
async fn a_peer_profile_drops_leaves_each_hosts_list_at_that_hosts_next_poll() {
    let profile = MockServer::start().await;
    let (_, internal) = apps(&profile, Some(enrollment()), AGENT).await;
    let (peer, with_peer, without_peer) = (key(1), "\"with-peer\"", "\"without-peer\"");
    for host in ["p1", "p2"] {
        let body = list_body(host, &[&peer]);
        mount_list(&profile, host, with_peer, &body, None).await;
        let (status, headers, actual) =
            request(internal.clone(), &peers_uri(host), Some(AGENT), None).await;
        assert_eq!(status, StatusCode::OK, "{host}");
        assert_eq!(headers[header::ETAG], with_peer);
        assert_eq!(actual, body.as_bytes());
    }
    profile.verify().await;

    // The peer's token is revoked, so profile's list no longer holds it.
    // Each agent polls with the ETag of the list it has. Identity keeps no
    // list of its own: the poll reaches profile with that ETag, and
    // profile's answer is the agent's, on one host as on the other.
    profile.reset().await;
    for host in ["p1", "p2"] {
        let body = list_body(host, &[]);
        mount_list(&profile, host, without_peer, &body, Some(with_peer)).await;
        let (status, headers, actual) = request(
            internal.clone(),
            &peers_uri(host),
            Some(AGENT),
            Some(with_peer),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{host}");
        assert_eq!(headers[header::ETAG], without_peer);
        assert_eq!(actual, body.as_bytes());
    }
    profile.verify().await;
}
