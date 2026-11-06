//! Enrollment parameters and the bearer-gated peer-list relay.

use std::net::IpAddr;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use gateway_common::wireguard::{valid_host, PeerListResponse};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::http::{bearer_token, AppState};
use crate::{Error, Result};

/// The kernel ingress and routing policy offered to enrolling desktops.
#[derive(Clone, Debug)]
pub struct WireguardEnrollment {
    pub host_id: String,
    pub endpoint: String,
    pub public_key: String,
    pub allowed_ips: Vec<String>,
    pub persistent_keepalive: Option<u16>,
    pub hosts: Vec<HostRoute>,
}

/// A gateway DNS name and the tunnel addresses that serve it.
#[derive(Clone, Debug, Serialize)]
pub struct HostRoute {
    pub name: String,
    pub addresses: Vec<IpAddr>,
}

/// Parameters returned with a PAT after profile accepts the desktop's key.
#[derive(Clone, Debug, Serialize)]
pub struct Parameters {
    pub server_public_key: String,
    pub endpoint: String,
    pub addresses: Vec<String>,
    pub allowed_ips: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent_keepalive: Option<u16>,
    pub hosts: Vec<HostRoute>,
}

impl WireguardEnrollment {
    pub(crate) fn parameters(&self, addresses: Vec<String>) -> Parameters {
        Parameters {
            server_public_key: self.public_key.clone(),
            endpoint: self.endpoint.clone(),
            addresses,
            allowed_ips: self.allowed_ips.clone(),
            persistent_keepalive: self.persistent_keepalive,
            hosts: self.hosts.clone(),
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
