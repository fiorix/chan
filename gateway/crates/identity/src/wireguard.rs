//! Enrollment parameters and the bearer-gated peer-list relay.

use std::net::IpAddr;

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
    // An agent polls for its own node. A host that is no configured
    // ingress is a mistyped id or a node the list does not name, and with
    // enrollment off no host is one: both get the answer of an absent
    // route, with no call to profile. An agent keeps the list it has on
    // anything but a served one, so it leaves its interface as it is.
    let configured = state
        .cfg
        .wireguard
        .as_ref()
        .is_some_and(|enrollment| enrollment.has_ingress(&query.host));
    if !configured {
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
