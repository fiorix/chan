//! Enrollment parameters and the bearer-gated peer-list relay.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use gateway_common::wireguard::{valid_host, Ingress, PeerListResponse};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::http::{bearer_token, AppState};
use crate::{Error, Result};

/// The WireGuard ingresses and the routing policy offered to enrolling
/// desktops. Every ingress answers on the same tunnel addresses and lists
/// every enrolled peer, so one enrollment is valid on all of them.
#[derive(Clone, Debug)]
pub struct WireguardEnrollment {
    /// One entry per proxy node that terminates WireGuard, in the order
    /// the operator listed them. Never empty: [`Self::new`] refuses an
    /// empty list.
    ingresses: Vec<IngressRoutes>,
    allowed_ips: Vec<String>,
    persistent_keepalive: Option<u16>,
}

/// One ingress and the gateway names its tunnel carries. Serialized, it is
/// one entry of discovery's list: the ingress's own fields and `hosts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IngressRoutes {
    #[serde(flatten)]
    pub ingress: Ingress,
    pub hosts: Vec<HostRoute>,
}

/// A gateway DNS name and the tunnel addresses that serve it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HostRoute {
    pub name: String,
    pub addresses: Vec<IpAddr>,
}

/// The `wireguard` object of the discovery document: everything a desktop
/// needs to start a tunnel to any ingress except its own key and address.
#[derive(Debug, Serialize)]
pub(crate) struct Discovery {
    /// The first ingress's endpoint and key. A desktop that reads no list
    /// reads these two and sees one ingress.
    endpoint: String,
    public_key: String,
    allowed_ips: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    persistent_keepalive: Option<u16>,
    ingresses: Vec<IngressRoutes>,
}

/// Parameters returned with a PAT after profile accepts the desktop's key.
/// `addresses` is the peer's one address set, valid on every ingress.
/// `server_public_key`, `endpoint` and `hosts` describe the first ingress,
/// for a desktop that reads no list; `ingresses` is discovery's list.
#[derive(Clone, Debug, Serialize)]
pub struct Parameters {
    pub server_public_key: String,
    pub endpoint: String,
    pub addresses: Vec<String>,
    pub allowed_ips: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent_keepalive: Option<u16>,
    pub hosts: Vec<HostRoute>,
    pub ingresses: Vec<IngressParameters>,
}

/// One ingress as the redeem lists it: discovery's entry, with the key
/// under the name the redeem gives a peer's key.
#[derive(Clone, Debug, Serialize)]
pub struct IngressParameters {
    pub id: String,
    pub endpoint: String,
    pub server_public_key: String,
    pub hosts: Vec<HostRoute>,
}

impl WireguardEnrollment {
    /// Build the enrollment offer for `ingresses`, kept in the order given,
    /// or `None` for an empty list. Each ingress's host map is derived, not
    /// configured: its node name `{id}.{proxy_host}` and every name below
    /// it, which are the node base and the tenant names identity mints for
    /// that proxy id, each mapped to `addresses`, the tunnel addresses
    /// every ingress interface answers on.
    pub fn new(
        ingresses: Vec<Ingress>,
        proxy_host: &str,
        addresses: &[IpAddr],
        allowed_ips: Vec<String>,
        persistent_keepalive: Option<u16>,
    ) -> Option<Self> {
        if ingresses.is_empty() {
            return None;
        }
        let ingresses = ingresses
            .into_iter()
            .map(|ingress| {
                let node = format!("{}.{proxy_host}", ingress.id);
                let wildcard = format!("*.{node}");
                let hosts = [node, wildcard]
                    .into_iter()
                    .map(|name| HostRoute {
                        name,
                        addresses: addresses.to_vec(),
                    })
                    .collect();
                IngressRoutes { ingress, hosts }
            })
            .collect();
        Some(Self {
            ingresses,
            allowed_ips,
            persistent_keepalive,
        })
    }

    /// Every ingress, in the operator's order.
    pub fn ingresses(&self) -> &[IngressRoutes] {
        &self.ingresses
    }

    /// The CIDRs a desktop routes through each ingress's tunnel.
    pub fn allowed_ips(&self) -> &[String] {
        &self.allowed_ips
    }

    /// The keepalive interval desktops use, `None` when it is off.
    pub fn persistent_keepalive(&self) -> Option<u16> {
        self.persistent_keepalive
    }

    /// Whether `id` names a configured ingress.
    pub(crate) fn has_ingress(&self, id: &str) -> bool {
        self.ingresses.iter().any(|route| route.ingress.id == id)
    }

    /// The ingress the single-ingress wire fields describe, which is all a
    /// desktop that reads no ingress list enrolls against.
    pub(crate) fn first(&self) -> &IngressRoutes {
        &self.ingresses[0]
    }

    pub(crate) fn discovery(&self) -> Discovery {
        let first = &self.first().ingress;
        Discovery {
            endpoint: first.endpoint.clone(),
            public_key: first.public_key.clone(),
            allowed_ips: self.allowed_ips.clone(),
            persistent_keepalive: self.persistent_keepalive,
            ingresses: self.ingresses.clone(),
        }
    }

    pub(crate) fn parameters(&self, addresses: Vec<String>) -> Parameters {
        let first = self.first();
        Parameters {
            server_public_key: first.ingress.public_key.clone(),
            endpoint: first.ingress.endpoint.clone(),
            addresses,
            allowed_ips: self.allowed_ips.clone(),
            persistent_keepalive: self.persistent_keepalive,
            hosts: first.hosts.clone(),
            ingresses: self
                .ingresses
                .iter()
                .map(|route| IngressParameters {
                    id: route.ingress.id.clone(),
                    endpoint: route.ingress.endpoint.clone(),
                    server_public_key: route.ingress.public_key.clone(),
                    hosts: route.hosts.clone(),
                })
                .collect(),
        }
    }
}

pub(crate) async fn authenticate(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response> {
    let expected = &state.cfg.wireguard_agent_token;
    if expected.is_empty() {
        return Err(Error::NotFound);
    }
    match bearer_token(&headers) {
        Some(token) if bool::from(token.as_bytes().ct_eq(expected.as_bytes())) => {
            Ok(next.run(request).await)
        }
        _ => Err(Error::Unauthorized),
    }
}

/// How long a host that keeps polling into the 404 goes unlogged after a
/// line about it.
const REFUSAL_LOG_INTERVAL: Duration = Duration::from_secs(600);

/// How many refused hosts are tracked at once. The label comes from the
/// caller, so the map is bounded: a holder of the agent bearer cannot grow
/// it, or the log, by polling for invented hosts.
const REFUSAL_LOG_HOSTS: usize = 64;

/// When each refused host was last logged. An agent polls every few
/// seconds for as long as it runs, so a line per refused poll would bury
/// the rest of the log, and one line per host would leave nothing in a
/// recent window for a state that can last for days. A refusal is logged
/// when it starts and once per `REFUSAL_LOG_INTERVAL` while it lasts, each
/// line carrying the number of polls it stands for.
#[derive(Clone, Default)]
pub struct RefusedPolls {
    hosts: Arc<Mutex<HashMap<String, RefusedHost>>>,
}

struct RefusedHost {
    logged_at: Instant,
    /// Refused polls since that line.
    unlogged: u64,
}

impl RefusedPolls {
    /// Count one refused poll for `host` at `now`. `Some(polls)` when a
    /// line is due, `polls` being the refused polls it stands for: this
    /// one and those since the previous line. A host met while
    /// [`REFUSAL_LOG_HOSTS`] others are inside their interval is not
    /// tracked and gets no line until one of them leaves it.
    fn note(&self, host: &str, now: Instant) -> Option<u64> {
        let recent = |entry: &RefusedHost| {
            now.saturating_duration_since(entry.logged_at) < REFUSAL_LOG_INTERVAL
        };
        let mut hosts = self.hosts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = hosts.get_mut(host) {
            entry.unlogged += 1;
            if recent(entry) {
                return None;
            }
            entry.logged_at = now;
            return Some(std::mem::take(&mut entry.unlogged));
        }
        if hosts.len() >= REFUSAL_LOG_HOSTS {
            hosts.retain(|_, entry| recent(entry));
            if hosts.len() >= REFUSAL_LOG_HOSTS {
                return None;
            }
        }
        hosts.insert(
            host.to_owned(),
            RefusedHost {
                logged_at: now,
                unlogged: 0,
            },
        );
        Some(1)
    }
}

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    host: String,
}

pub(crate) async fn peers(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Response> {
    if !valid_host(&query.host) {
        return Err(Error::BadRequest("invalid wireguard host".into()));
    }
    // An agent polls for its own node. With enrollment configured, a host
    // that is no ingress id means the agent's host id and the list
    // disagree: the route answers as an absent one, with no call to
    // profile, and the agent, which keeps the list it has on anything but
    // a served one, reports the 404 on its node. With enrollment off there
    // is no list to disagree with, and the route relays. Profile's list is
    // the same for every host, so a relay can neither wipe nor misplace a
    // peer, while a 404 would hold every agent on its last list and keep
    // revocations from reaching the nodes.
    let unlisted = state
        .cfg
        .wireguard
        .as_ref()
        .is_some_and(|enrollment| !enrollment.has_ingress(&query.host));
    if unlisted {
        // The host is a validated label, and the bearer was checked before
        // this handler ran: the line names the first and never the second.
        if let Some(polls) = state.wireguard_refusals.note(&query.host, Instant::now()) {
            tracing::warn!(
                host = %query.host,
                polls,
                "a WireGuard peer agent polls for a host that is not an id in \
                 WIREGUARD_INGRESSES and is answered 404: it keeps its last peer list, so \
                 revocations do not reach that node until the id is listed or the node's \
                 interface is taken down"
            );
        }
        return Err(Error::NotFound);
    }
    let condition = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    let response = state
        .cfg
        .profile_client
        .list_wireguard_peers(&query.host, condition)
        .await?;
    Ok(match response {
        PeerListResponse::NotModified { etag } => {
            (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response()
        }
        PeerListResponse::Modified { body, etag } => (
            [
                (header::ETAG, etag),
                (header::CONTENT_TYPE, "application/json".to_owned()),
            ],
            body,
        )
            .into_response(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Two ingresses, `p2` listed first, so the first entry is not the one
    /// an ordering by id would pick.
    fn enrollment(persistent_keepalive: Option<u16>) -> WireguardEnrollment {
        let ingress = |id: &str| Ingress {
            id: id.into(),
            endpoint: format!("{id}.proxy.example.test:51820"),
            public_key: format!("key-of-{id}"),
        };
        WireguardEnrollment::new(
            vec![ingress("p2"), ingress("p1")],
            "proxy.example.test",
            &["10.7.0.1".parse().unwrap(), "fd00:7::1".parse().unwrap()],
            vec!["10.7.0.0/24".into(), "fd00:7::/64".into()],
            persistent_keepalive,
        )
        .unwrap()
    }

    /// The host map of the ingress `id`, as both documents carry it.
    fn hosts(id: &str) -> Value {
        json!([
            {"name": format!("{id}.proxy.example.test"), "addresses": ["10.7.0.1", "fd00:7::1"]},
            {"name": format!("*.{id}.proxy.example.test"), "addresses": ["10.7.0.1", "fd00:7::1"]},
        ])
    }

    #[test]
    fn redeem_parameters_describe_the_first_ingress_and_list_discoverys_ingresses() {
        let enrollment = enrollment(Some(25));
        let peer = vec!["10.7.0.23/32".to_owned(), "fd00:7::17/128".to_owned()];
        let parameters = serde_json::to_value(enrollment.parameters(peer)).unwrap();
        assert_eq!(
            parameters,
            json!({
                "server_public_key": "key-of-p2",
                "endpoint": "p2.proxy.example.test:51820",
                "addresses": ["10.7.0.23/32", "fd00:7::17/128"],
                "allowed_ips": ["10.7.0.0/24", "fd00:7::/64"],
                "persistent_keepalive": 25,
                "hosts": hosts("p2"),
                "ingresses": [
                    {
                        "id": "p2",
                        "endpoint": "p2.proxy.example.test:51820",
                        "server_public_key": "key-of-p2",
                        "hosts": hosts("p2"),
                    },
                    {
                        "id": "p1",
                        "endpoint": "p1.proxy.example.test:51820",
                        "server_public_key": "key-of-p1",
                        "hosts": hosts("p1"),
                    },
                ],
            })
        );

        // The redeem's list is discovery's, entry for entry, with each key
        // under the redeem's name for it, and the single-ingress fields of
        // the two documents agree, which a desktop compares.
        let discovery = serde_json::to_value(enrollment.discovery()).unwrap();
        let renamed: Vec<Value> = discovery["ingresses"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(|mut entry| {
                let key = entry.as_object_mut().unwrap().remove("public_key").unwrap();
                entry["server_public_key"] = key;
                entry
            })
            .collect();
        assert_eq!(renamed.len(), 2);
        assert_eq!(parameters["ingresses"], Value::Array(renamed));
        assert_eq!(parameters["server_public_key"], discovery["public_key"]);
        for shared in ["endpoint", "allowed_ips", "persistent_keepalive"] {
            assert_eq!(parameters[shared], discovery[shared], "{shared}");
        }

        // A keepalive that is off is absent from both, not null.
        let off = self::enrollment(None);
        for document in [
            serde_json::to_value(off.parameters(Vec::new())).unwrap(),
            serde_json::to_value(off.discovery()).unwrap(),
        ] {
            assert!(document.get("persistent_keepalive").is_none(), "{document}");
            assert!(document.get("ingresses").is_some());
        }
    }

    #[test]
    fn a_refused_host_is_logged_when_it_starts_and_once_per_interval() {
        let refused = RefusedPolls::default();
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        assert_eq!(refused.note("p9", at(0)), Some(1));
        // An agent polling every five seconds is quiet for the interval,
        // and the line that ends it counts the polls it stands for.
        for poll in 1..120 {
            assert_eq!(refused.note("p9", at(poll * 5)), None, "poll {poll}");
        }
        assert_eq!(refused.note("p9", at(600)), Some(120));
        assert_eq!(refused.note("p9", at(605)), None);
        assert_eq!(refused.note("p9", at(1200)), Some(2));
        // Each host has its own line.
        assert_eq!(refused.note("p8", at(1201)), Some(1));
        assert_eq!(refused.note("p9", at(1202)), None);
    }

    #[test]
    fn refused_hosts_are_tracked_up_to_a_bound() {
        let refused = RefusedPolls::default();
        let tracked = || refused.hosts.lock().unwrap().len();
        let start = Instant::now();
        for host in 0..REFUSAL_LOG_HOSTS {
            assert_eq!(refused.note(&format!("h{host}"), start), Some(1));
        }
        // With every tracked host inside its interval, one more is neither
        // tracked nor logged, and the tracked ones keep their state.
        let later = start + Duration::from_secs(1);
        assert_eq!(refused.note("one-more", later), None);
        assert_eq!(tracked(), REFUSAL_LOG_HOSTS);
        assert_eq!(refused.note("h0", later), None);
        // It takes the place of the hosts whose interval has passed.
        let expired = start + REFUSAL_LOG_INTERVAL;
        assert_eq!(refused.note("one-more", expired), Some(1));
        assert_eq!(tracked(), 1);
    }
}
