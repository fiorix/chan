//! The desired peer set, read from identity's internal listener:
//! `GET /internal/v1/wireguard/peers?host={id}` behind `WIREGUARD_AGENT_TOKEN`.
//! identity relays profile's body and its quoted `ETag` unchanged, and
//! answers 304 when `If-None-Match` carries the current one.

use std::time::Duration;

use anyhow::Context;
use devserver_control_proto::ProxyId;
use reqwest::{header, redirect, Client, StatusCode};
use serde::Deserialize;
use url::Url;

use crate::peers::{canonical_peer, PeerSet};

pub const PEERS_PATH: &str = "/internal/v1/wireguard/peers";

/// What one poll learned.
#[derive(Debug, PartialEq, Eq)]
pub enum Fetched {
    /// A new list, with the `ETag` to send next time.
    Peers {
        peers: PeerSet,
        etag: Option<String>,
    },
    /// 304: the list has not changed since the `ETag` sent.
    NotModified,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    /// 401: identity refused the bearer. Fatal; the unit restarts the agent.
    Unauthorized,
    /// Anything else that is not a usable answer; the last list stays.
    Upstream(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    host: String,
    peers: Vec<Peer>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Peer {
    public_key: String,
    allowed_ips: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct IdentityClient {
    client: Client,
    endpoint: Url,
    auth_header: String,
    host: ProxyId,
}

impl IdentityClient {
    pub fn new(identity_url: &Url, token: &str, host: ProxyId) -> anyhow::Result<Self> {
        let tls = chan_tls::client_config().context("building the TLS trust for IDENTITY_URL")?;
        Self::with_tls(identity_url, token, host, tls)
    }

    /// [`IdentityClient::new`] over `tls`, which the agent takes from
    /// chan-tls, so identity is verified as the desktop and the devserver's
    /// tunnel verify the gateway.
    fn with_tls(
        identity_url: &Url,
        token: &str,
        host: ProxyId,
        mut tls: chan_tls::rustls::ClientConfig,
    ) -> anyhow::Result<Self> {
        // reqwest uses a preconfigured config as it is, ALPN included, and
        // this build has no HTTP/2, so the config offers HTTP/1.1 alone.
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut endpoint = identity_url
            .join(PEERS_PATH)
            .context("IDENTITY_URL cannot carry the peers path")?;
        endpoint
            .query_pairs_mut()
            .append_pair("host", host.as_str());
        let client = Client::builder()
            .use_preconfigured_tls(tls)
            .timeout(Duration::from_secs(5))
            .connect_timeout(Duration::from_secs(2))
            // An internal route has no reason to redirect, and following one
            // would carry the bearer's request somewhere else.
            .redirect(redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            endpoint,
            auth_header: format!("Bearer {token}"),
            host,
        })
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    pub async fn fetch(&self, etag: Option<&str>) -> Result<Fetched, FetchError> {
        let mut request = self
            .client
            .get(self.endpoint.clone())
            .header(header::AUTHORIZATION, &self.auth_header);
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .map_err(|e| FetchError::Upstream(format!("request failed: {}", with_causes(&e))))?;
        match response.status() {
            StatusCode::OK => {}
            StatusCode::NOT_MODIFIED if etag.is_some() => return Ok(Fetched::NotModified),
            StatusCode::UNAUTHORIZED => return Err(FetchError::Unauthorized),
            status => return Err(FetchError::Upstream(format!("identity answered {status}"))),
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .await
            .map_err(|e| FetchError::Upstream(format!("reading the body failed: {e}")))?;
        let peers = self
            .parse(&bytes)
            .map_err(|e| FetchError::Upstream(format!("invalid peer list: {e}")))?;
        Ok(Fetched::Peers { peers, etag })
    }

    fn parse(&self, bytes: &[u8]) -> Result<PeerSet, String> {
        let body: Body = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        if body.host != self.host.as_str() {
            return Err(format!(
                "the list is for host {:?}, not {:?}",
                body.host,
                self.host.as_str()
            ));
        }
        let mut peers = PeerSet::new();
        for peer in body.peers {
            let ips = canonical_peer(&peer.public_key, &peer.allowed_ips)?;
            if peers.insert(peer.public_key.clone(), ips).is_some() {
                return Err(format!("peer {} is listed twice", peer.public_key));
            }
        }
        Ok(peers)
    }
}

/// `error` and the causes under it. reqwest's own message names the URL and
/// stops there, before the cause that says why, such as the certificate a
/// handshake refused.
fn with_causes(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(next) = cause {
        text.push_str(": ");
        text.push_str(&next.to_string());
        cause = next.source();
    }
    text
}

/// The poll state: the last list identity served, the `ETag` that names
/// it, and whether the last poll failed, so a failure logs at warn when it
/// starts and at debug while it repeats.
#[derive(Debug)]
pub struct Poller {
    client: IdentityClient,
    etag: Option<String>,
    desired: Option<PeerSet>,
    failing: bool,
}

/// identity refused the bearer.
#[derive(Debug)]
pub struct Unauthorized;

impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "identity refused WIREGUARD_AGENT_TOKEN (401); it must equal identity's \
             WIREGUARD_AGENT_TOKEN",
        )
    }
}

impl std::error::Error for Unauthorized {}

/// What a poll did with the list, and which log line a failure got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Polled {
    /// identity served a list (a new one, or 304 for the current one).
    Served,
    /// A failure after a served list: logged at warn.
    FailureStarted,
    /// A failure after a failure: logged at debug.
    FailureRepeated,
}

impl Poller {
    pub fn new(client: IdentityClient) -> Self {
        Self {
            client,
            etag: None,
            desired: None,
            failing: false,
        }
    }

    /// The last list identity served; `None` until the first one arrives,
    /// and the reconciler does nothing until then.
    pub fn desired(&self) -> Option<&PeerSet> {
        self.desired.as_ref()
    }

    /// Poll once. Only a refused bearer is an error; every other failure is
    /// logged and keeps the last list.
    pub async fn poll(&mut self) -> Result<Polled, Unauthorized> {
        match self.client.fetch(self.etag.as_deref()).await {
            Ok(fetched) => {
                if self.failing {
                    tracing::info!(url = %self.client.endpoint(), "identity serves the peer list again");
                    self.failing = false;
                }
                if let Fetched::Peers { peers, etag } = fetched {
                    if self.desired.as_ref() != Some(&peers) {
                        tracing::info!(peers = peers.len(), "identity's peer list changed");
                    }
                    self.desired = Some(peers);
                    self.etag = etag;
                }
                Ok(Polled::Served)
            }
            Err(FetchError::Unauthorized) => Err(Unauthorized),
            Err(FetchError::Upstream(error)) => {
                if self.failing {
                    tracing::debug!(url = %self.client.endpoint(), %error, "identity still does not serve the peer list; keeping the last one");
                    Ok(Polled::FailureRepeated)
                } else {
                    tracing::warn!(url = %self.client.endpoint(), %error, "identity does not serve the peer list; keeping the last one");
                    self.failing = true;
                    Ok(Polled::FailureStarted)
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::peers::tests::key;

    const ETAG: &str = "\"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\"";

    fn body(peers: &[(String, &[&str])]) -> serde_json::Value {
        serde_json::json!({
            "host": "p1",
            "peers": peers
                .iter()
                .map(|(k, ips)| serde_json::json!({"public_key": k, "allowed_ips": ips}))
                .collect::<Vec<_>>(),
        })
    }

    fn client(server: &MockServer) -> IdentityClient {
        IdentityClient::new(
            &server.uri().parse().unwrap(),
            "agent-bearer",
            ProxyId::parse("p1").unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn a_200_replaces_the_desired_set_and_its_etag_is_sent_back() {
        let server = MockServer::start().await;
        // Mounted first so it wins once the ETag is sent: 304 keeps the set.
        Mock::given(method("GET"))
            .and(path(PEERS_PATH))
            .and(header("if-none-match", ETAG))
            .respond_with(ResponseTemplate::new(304).insert_header("etag", ETAG))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(PEERS_PATH))
            .and(query_param("host", "p1"))
            .and(header("authorization", "Bearer agent-bearer"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("etag", ETAG)
                    .set_body_json(body(&[
                        (key(2), &["10.7.0.3/32", "fd00:7::3/128"]),
                        (key(1), &["10.7.0.2/32"]),
                    ])),
            )
            .mount(&server)
            .await;

        let mut poller = Poller::new(client(&server));
        assert_eq!(poller.desired(), None);
        poller.poll().await.unwrap();
        let expected = PeerSet::from([
            (key(1), vec!["10.7.0.2/32".to_string()]),
            (key(2), vec!["10.7.0.3/32".into(), "fd00:7::3/128".into()]),
        ]);
        assert_eq!(poller.desired(), Some(&expected));

        poller.poll().await.unwrap();
        assert_eq!(poller.desired(), Some(&expected));
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].headers.get("if-none-match").is_none());
        assert_eq!(
            requests[1]
                .headers
                .get("if-none-match")
                .unwrap()
                .to_str()
                .unwrap(),
            ETAG,
            "the ETag is sent back byte for byte, quotes included"
        );
    }

    #[tokio::test]
    async fn a_502_keeps_the_last_set_and_logs_once() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(PEERS_PATH))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(body(&[(key(1), &["10.7.0.2/32"])])),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(PEERS_PATH))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;

        let mut poller = Poller::new(client(&server));
        assert_eq!(poller.poll().await.unwrap(), Polled::Served);
        let first = poller.desired().cloned().unwrap();
        let mut outcomes = Vec::new();
        for _ in 0..3 {
            outcomes.push(poller.poll().await.unwrap());
            assert_eq!(poller.desired(), Some(&first));
        }
        // One warn line when the failure starts, debug while it repeats.
        assert_eq!(
            outcomes,
            [
                Polled::FailureStarted,
                Polled::FailureRepeated,
                Polled::FailureRepeated
            ]
        );
    }

    #[tokio::test]
    async fn identity_is_verified_with_the_config_it_is_given_over_http1() {
        let (tls, handshakes) = chan_tls::testing::recording(chan_tls::client_config().unwrap());
        let sink = chan_tls::testing::Sink::start();
        let client = IdentityClient::with_tls(
            &format!("https://{}", sink.addr).parse().unwrap(),
            "agent-bearer",
            ProxyId::parse("p1").unwrap(),
            tls,
        )
        .unwrap();
        let Err(FetchError::Upstream(error)) = client.fetch(None).await else {
            panic!("the sink never answers");
        };
        assert!(
            error.starts_with("request failed: error sending request for url"),
            "{error}"
        );
        assert!(
            error.matches(": ").count() > 1,
            "the message carries the cause under reqwest's own: {error}"
        );
        assert_eq!(handshakes.server_names(), ["127.0.0.1"]);
        assert_eq!(sink.alpn_offers(), [["http/1.1"]]);
    }

    #[tokio::test]
    async fn a_401_is_fatal_and_names_the_bearer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(PEERS_PATH))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let error = Poller::new(client(&server)).poll().await.unwrap_err();
        assert!(error.to_string().contains("WIREGUARD_AGENT_TOKEN"));
        assert!(!error.to_string().contains("agent-bearer"));
    }

    #[tokio::test]
    async fn an_invalid_list_is_an_upstream_failure() {
        let server = MockServer::start().await;
        let cases = [
            serde_json::json!({"host": "p2", "peers": []}),
            serde_json::json!({"host": "p1", "peers": [{"public_key": "bad", "allowed_ips": ["10.7.0.2/32"]}]}),
            serde_json::json!({"host": "p1", "peers": [{"public_key": key(1), "allowed_ips": ["10.7.0.2"]}]}),
            serde_json::json!({"host": "p1", "peers": [
                {"public_key": key(1), "allowed_ips": ["10.7.0.2/32"]},
                {"public_key": key(1), "allowed_ips": ["10.7.0.3/32"]},
            ]}),
        ];
        for case in cases {
            server.reset().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(&case))
                .mount(&server)
                .await;
            assert!(
                matches!(
                    client(&server).fetch(None).await,
                    Err(FetchError::Upstream(_))
                ),
                "{case}"
            );
        }
        // A 304 answers a request that carried no ETag only by mistake.
        server.reset().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(304))
            .mount(&server)
            .await;
        assert!(matches!(
            client(&server).fetch(None).await,
            Err(FetchError::Upstream(_))
        ));
    }
}
