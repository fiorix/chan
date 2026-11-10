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
