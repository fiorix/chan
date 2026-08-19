//! Thin reqwest client for devserver-control's `/admin/v1/*` tree.
//!
//! Used by:
//!   * identity-service on PAT revoke, account delete, and dashboard
//!     reads (`/api/me` merges the live workspace list), so id can
//!     render and gate against the fleet-wide aggregate the controller
//!     holds without going through any single proxy's surface.
//!   * profile-service on admin block and in the devserver-registry
//!     sweeper, so the live registrations the fleet holds for a user
//!     are torn down at the same time the DB state changes, and the
//!     sweeper marks from one cluster-wide snapshot.
//!
//! Errors are surfaced to the caller. Denial mutations reserve durable
//! revocation work in profile's transaction, so an immediate control call may
//! fail without losing the required retry. Read calls bubble up directly
//! because the dashboard and sweeper genuinely need authoritative fleet data:
//! a controller 503 or transport error is an upstream failure, never an empty
//! list.
//!
//! `DevserverControlError` is the client's own error enum so this crate
//! has no axum / IntoResponse dependency. Each consumer maps it onto
//! its local error via a `From` impl.

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum DevserverControlError {
    #[error("devserver-control admin upstream: {0}")]
    Upstream(String),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
}

pub type DevserverControlResult<T> = Result<T, DevserverControlError>;

/// One live tunnel as devserver-control reports it. Mirrors
/// devserver-control's `state::TunnelView`; the duplication is
/// deliberate (this crate stays independent of the controller's
/// internal types so it can be pulled by identity and profile without
/// a circular dep). `proxy_id` and `proxy_base_url` identify the
/// proxy node that holds the registration; consumers that predate the
/// distributed fleet ignore them.
#[derive(Clone, Deserialize)]
pub struct TunnelView {
    pub registration_id: Uuid,
    pub owner_user_id: Uuid,
    pub user: String,
    /// The registration's second key: one of the owner's live
    /// devserver ids (a user can hold several). Pinned to the
    /// producer's JSON field name (`devserver_id`).
    pub devserver_id: String,
    pub max_connected_devservers: u32,
    pub peer_addr: Option<String>,
    pub connected_at: DateTime<Utc>,
    pub proxy_id: String,
    pub proxy_base_url: String,
    pub admission_lease: String,
    pub admission_lease_expires_at: DateTime<Utc>,
}

impl std::fmt::Debug for TunnelView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelView")
            .field("registration_id", &self.registration_id)
            .field("owner_user_id", &self.owner_user_id)
            .field("user", &self.user)
            .field("devserver_id", &self.devserver_id)
            .field("peer_addr", &self.peer_addr)
            .field("connected_at", &self.connected_at)
            .field("proxy_id", &self.proxy_id)
            .field("proxy_base_url", &self.proxy_base_url)
            .field("admission_lease", &"[REDACTED]")
            .field(
                "admission_lease_expires_at",
                &self.admission_lease_expires_at,
            )
            .finish()
    }
}

/// One connected proxy node as devserver-control reports it. Mirrors
/// devserver-control's `state::ProxyView` for the same decoupling
/// reason as [`TunnelView`].
#[derive(Debug, Clone, Deserialize)]
pub struct ProxyView {
    pub proxy_id: String,
    pub proxy_base_url: String,
    pub package_version: String,
    pub boot_id: Uuid,
    pub connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub tunnel_count: usize,
    pub status: ProxyStatus,
}

#[derive(Debug, Clone)]
pub struct SessionRevocationResult {
    pub tenant_sessions_revoked: usize,
    pub proxies_confirmed: usize,
    pub proxies_expected: usize,
}

#[derive(Debug, Deserialize)]
struct SessionRevocationWire {
    revoked: Option<usize>,
    tenant_sessions_revoked: Option<usize>,
    proxies_confirmed: usize,
    proxies_expected: usize,
}

fn normalize_session_revocation(
    body: SessionRevocationWire,
) -> DevserverControlResult<SessionRevocationResult> {
    let tenant_sessions_revoked = match (body.tenant_sessions_revoked, body.revoked) {
        (Some(current), Some(compatibility)) if current == compatibility => current,
        (Some(current), None) => current,
        (None, Some(compatibility)) => compatibility,
        (Some(_), Some(_)) => {
            return Err(DevserverControlError::Upstream(
                "devserver-control returned inconsistent session revoke counts".into(),
            ));
        }
        (None, None) => {
            return Err(DevserverControlError::Upstream(
                "devserver-control omitted the session revoke count".into(),
            ));
        }
    };
    Ok(SessionRevocationResult {
        tenant_sessions_revoked,
        proxies_confirmed: body.proxies_confirmed,
        proxies_expected: body.proxies_expected,
    })
}

#[derive(Serialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
enum SessionRevocationRequest<'a> {
    Exact {
        subject_user_id: Uuid,
        owner_user_id: Uuid,
        devserver_id: &'a str,
    },
    Subject {
        subject_user_id: Uuid,
    },
    Owner {
        owner_user_id: Uuid,
    },
    SessionId {
        admin_session_id: Uuid,
    },
    All,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BrowserSessionView {
    pub id: Uuid,
    pub subject_user_id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub proxy_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ControlOverview {
    pub generated_at: DateTime<Utc>,
    pub proxies_connected: usize,
    pub proxies_ready: usize,
    pub devservers_connected: usize,
    pub tenant_sessions_active: usize,
}

/// Session state the controller publishes for a proxy. Serialized
/// snake_case on the wire (`joining` / `active`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyStatus {
    Joining,
    Active,
}

#[derive(Clone)]
pub struct DevserverControlClient {
    base: Url,
    http: reqwest::Client,
    token: String,
}

impl std::fmt::Debug for DevserverControlClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevserverControlClient")
            .field("base", &self.base)
            // token deliberately elided
            .finish()
    }
}

/// Percent-encode one path segment. Usernames are normally
/// `[a-z0-9-]` but the admin tree may have to handle pre-normalized
/// inputs (transient migration data, future relaxed validators), so
/// any byte outside the unreserved set per RFC 3986 §2.3 is escaped.
/// `url::Url::set_path` does not handle this automatically.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl DevserverControlClient {
    pub fn new(base: Url, token: String) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .connect_timeout(std::time::Duration::from_secs(2))
            .build()?;
        Ok(Self { base, http, token })
    }

    /// Force-evict every tunnel an immutable owner has live across the fleet.
    /// Idempotent; "nothing to kill" returns `0`.
    pub async fn kill_owner_tunnels(&self, owner_user_id: Uuid) -> DevserverControlResult<usize> {
        let mut url = self.base.clone();
        url.set_path(&format!("/admin/v1/owners/{owner_user_id}/tunnels/kill"));
        let res = self.http.post(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control admin upstream error");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        // The endpoint returns 200 with a JSON body; tolerate 204 to
        // leave room for a future "noop" optimisation.
        if status == StatusCode::NO_CONTENT {
            return Ok(0);
        }
        let body: KillResponse = res.json().await?;
        Ok(body.killed)
    }

    /// Force-evict one immutable owner/devserver tuple.
    pub async fn kill_tunnel(
        &self,
        owner_user_id: Uuid,
        devserver_id: &str,
    ) -> DevserverControlResult<()> {
        let mut url = self.base.clone();
        let devserver_id = encode_segment(devserver_id);
        url.set_path(&format!(
            "/admin/v1/tunnels/{owner_user_id}/{devserver_id}/kill"
        ));
        let res = self.http.post(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if status == StatusCode::NO_CONTENT {
            return Ok(());
        }
        tracing::warn!(%status, "devserver-control admin upstream error");
        Err(DevserverControlError::Upstream(format!("{status}")))
    }

    /// Snapshot of EVERY live tunnel across all users and proxies
    /// (`GET /admin/v1/tunnels`). The profile sweeper's mark source: each
    /// sweep tick stamps `devservers.last_seen_at` for exactly the
    /// `(user, devserver_id)` pairs returned here, so an error MUST make
    /// the caller skip the whole tick -- marking from a partial or failed
    /// snapshot would age live rows toward deletion. Errors bubble up
    /// (no best-effort swallowing) for that reason.
    pub async fn list_all_tunnels(&self) -> DevserverControlResult<Vec<TunnelView>> {
        let mut url = self.base.clone();
        url.set_path("/admin/v1/tunnels");
        let res = self.http.get(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control admin upstream error");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        let tunnels: Vec<TunnelView> = res.json().await?;
        Ok(tunnels)
    }

    /// Snapshot of every live tunnel for an immutable owner across the fleet.
    /// Identity's dashboard calls this on every `/api/me` so the SPA
    /// renders the user's workspace cards. Empty list when the user has
    /// nothing connected; absent user returns 200 with an empty list
    /// (the endpoint doesn't 404 on unknown users so callers don't have
    /// to special-case the steady state where a fresh sign-in has
    /// nothing registered yet).
    pub async fn list_owner_tunnels(
        &self,
        owner_user_id: Uuid,
    ) -> DevserverControlResult<Vec<TunnelView>> {
        let mut url = self.base.clone();
        url.set_path(&format!("/admin/v1/owners/{owner_user_id}/tunnels"));
        let res = self.http.get(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control admin upstream error");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        let tunnels: Vec<TunnelView> = res.json().await?;
        Ok(tunnels)
    }

    /// Snapshot of every proxy node currently connected to the
    /// controller (`GET /admin/v1/proxies`). Same fail-closed rule as
    /// the tunnel reads: a controller error is an upstream failure,
    /// never an empty fleet.
    pub async fn list_proxies(&self) -> DevserverControlResult<Vec<ProxyView>> {
        let mut url = self.base.clone();
        url.set_path("/admin/v1/proxies");
        let res = self.http.get(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control admin upstream error");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        let proxies: Vec<ProxyView> = res.json().await?;
        Ok(proxies)
    }

    pub async fn revoke_sessions_exact(
        &self,
        subject_user_id: Uuid,
        owner_user_id: Uuid,
        devserver_id: &str,
    ) -> DevserverControlResult<SessionRevocationResult> {
        self.revoke_sessions(SessionRevocationRequest::Exact {
            subject_user_id,
            owner_user_id,
            devserver_id,
        })
        .await
    }

    pub async fn revoke_subject_sessions(
        &self,
        subject_user_id: Uuid,
    ) -> DevserverControlResult<SessionRevocationResult> {
        self.revoke_sessions(SessionRevocationRequest::Subject { subject_user_id })
            .await
    }

    pub async fn revoke_owner_sessions(
        &self,
        owner_user_id: Uuid,
    ) -> DevserverControlResult<SessionRevocationResult> {
        self.revoke_sessions(SessionRevocationRequest::Owner { owner_user_id })
            .await
    }

    pub async fn revoke_session_id(
        &self,
        admin_session_id: Uuid,
    ) -> DevserverControlResult<SessionRevocationResult> {
        self.revoke_sessions(SessionRevocationRequest::SessionId { admin_session_id })
            .await
    }

    pub async fn revoke_all_sessions(&self) -> DevserverControlResult<SessionRevocationResult> {
        self.revoke_sessions(SessionRevocationRequest::All).await
    }

    pub async fn kill_all_tunnels(&self) -> DevserverControlResult<usize> {
        let mut url = self.base.clone();
        url.set_path("/admin/v1/tunnels/kill-all");
        let res = self.http.post(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control tunnel drain failed");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        let body: KillAllResponse = res.json().await?;
        Ok(body.tunnels_evicted)
    }

    pub async fn list_browser_sessions(
        &self,
        subject_user_id: Option<Uuid>,
        owner_user_id: Option<Uuid>,
        proxy_id: Option<&str>,
    ) -> DevserverControlResult<Vec<BrowserSessionView>> {
        let mut url = self.base.clone();
        url.set_path("/admin/v1/browser-sessions");
        {
            let mut query = url.query_pairs_mut();
            if let Some(subject_user_id) = subject_user_id {
                query.append_pair("subject_user_id", &subject_user_id.to_string());
            }
            if let Some(owner_user_id) = owner_user_id {
                query.append_pair("owner_user_id", &owner_user_id.to_string());
            }
            if let Some(proxy_id) = proxy_id {
                query.append_pair("proxy_id", proxy_id);
            }
        }
        let res = self.http.get(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control browser-session list failed");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        Ok(res.json().await?)
    }

    pub async fn overview(&self) -> DevserverControlResult<ControlOverview> {
        let mut url = self.base.clone();
        url.set_path("/admin/v1/overview");
        let res = self.http.get(url).bearer_auth(&self.token).send().await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control overview failed");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        Ok(res.json().await?)
    }

    async fn revoke_sessions(
        &self,
        request: SessionRevocationRequest<'_>,
    ) -> DevserverControlResult<SessionRevocationResult> {
        let mut url = self.base.clone();
        url.set_path("/admin/v1/sessions/revoke");
        let res = self
            .http
            .post(url)
            .bearer_auth(&self.token)
            .json(&request)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            tracing::warn!(%status, "devserver-control session revoke failed");
            return Err(DevserverControlError::Upstream(format!("{status}")));
        }
        normalize_session_revocation(res.json().await?)
    }
}

#[derive(Debug, Deserialize)]
struct KillResponse {
    killed: usize,
}

#[derive(Debug, Deserialize)]
struct KillAllResponse {
    tunnels_evicted: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_view_pins_the_admin_wire_field_names() {
        // devserver-control's state::TunnelView serializes the owner as
        // `user` (NOT `username`), the registration key as
        // `devserver_id`, and the owning node as `proxy_id` /
        // `proxy_base_url`. The profile sweeper joins its mark UPDATE
        // through users on these values, so a silent producer-side
        // rename would no-op every mark and age the whole registry
        // toward deletion.
        let v: TunnelView = serde_json::from_str(
            r#"{
                "registration_id": "650e8400-e29b-41d4-a716-446655440000",
                "owner_user_id": "550e8400-e29b-41d4-a716-446655440000",
                "user": "alice",
                "devserver_id": "abc123",
                "peer_addr": "192.0.2.7:52011",
                "connected_at": "2026-07-15T00:00:00Z",
                "proxy_id": "p1",
                "proxy_base_url": "https://p1.proxy.chan.app",
                "max_connected_devservers": 3,
                "admission_lease": "v1.payload.signature",
                "admission_lease_expires_at": "2026-07-15T00:02:00Z"
            }"#,
        )
        .expect("admin tunnel wire shape parses");
        assert_eq!(v.user, "alice");
        assert_eq!(v.devserver_id, "abc123");
        assert_eq!(v.peer_addr.as_deref(), Some("192.0.2.7:52011"));
        assert_eq!(v.proxy_id, "p1");
        assert_eq!(v.proxy_base_url, "https://p1.proxy.chan.app");
        let debug = format!("{v:?}");
        assert!(!debug.contains("v1.payload.signature"));
        assert!(debug.contains("[REDACTED]"));

        // A payload using `username` must NOT parse: catching the rename
        // here beats debugging a sweeper that never marks anything.
        let renamed = serde_json::from_str::<TunnelView>(
            r#"{
                "username": "alice",
                "devserver_id": "abc123",
                "peer_addr": null,
                "connected_at": "2026-07-15T00:00:00Z",
                "proxy_id": "p1",
                "proxy_base_url": "https://p1.proxy.chan.app",
                "admission_lease": "v1.payload.signature",
                "admission_lease_expires_at": "2026-07-15T00:02:00Z"
            }"#,
        );
        assert!(renamed.is_err(), "the owner field is pinned to `user`");

        // A pre-fleet payload without the proxy fields must NOT parse:
        // the controller always emits them, so accepting their absence
        // would hide a producer that is not the controller.
        let missing_proxy = serde_json::from_str::<TunnelView>(
            r#"{
                "user": "alice",
                "devserver_id": "abc123",
                "peer_addr": null,
                "connected_at": "2026-07-15T00:00:00Z"
            }"#,
        );
        assert!(
            missing_proxy.is_err(),
            "proxy_id and proxy_base_url are required"
        );
    }

    #[test]
    fn proxy_view_pins_the_admin_wire_field_names() {
        let v: ProxyView = serde_json::from_str(
            r#"{
                "proxy_id": "p1",
                "proxy_base_url": "https://p1.proxy.chan.app",
                "package_version": "0.72.0",
                "boot_id": "550e8400-e29b-41d4-a716-446655440000",
                "connected_at": "2026-07-15T00:00:00Z",
                "last_seen_at": "2026-07-15T00:00:05Z",
                "tunnel_count": 3,
                "status": "active"
            }"#,
        )
        .expect("admin proxy wire shape parses");
        assert_eq!(v.proxy_id, "p1");
        assert_eq!(v.tunnel_count, 3);
        assert_eq!(v.status, ProxyStatus::Active);

        // The joining state round-trips too; the fleet publishes it
        // while a proxy's snapshot is still staging.
        let joining: ProxyView = serde_json::from_str(
            r#"{
                "proxy_id": "p2",
                "proxy_base_url": "https://p2.proxy.chan.app",
                "package_version": "0.72.0",
                "boot_id": "550e8400-e29b-41d4-a716-446655440001",
                "connected_at": "2026-07-15T00:00:00Z",
                "last_seen_at": "2026-07-15T00:00:05Z",
                "tunnel_count": 0,
                "status": "joining"
            }"#,
        )
        .expect("joining status parses");
        assert_eq!(joining.status, ProxyStatus::Joining);
    }

    #[test]
    fn session_revocation_accepts_matching_current_and_compatibility_counts() {
        let both: SessionRevocationWire = serde_json::from_str(
            r#"{
                "revoked": 2,
                "tenant_sessions_revoked": 2,
                "proxies_confirmed": 3,
                "proxies_expected": 3
            }"#,
        )
        .unwrap();
        let normalized = normalize_session_revocation(both).unwrap();
        assert_eq!(normalized.tenant_sessions_revoked, 2);

        let legacy: SessionRevocationWire = serde_json::from_str(
            r#"{
                "revoked": 1,
                "proxies_confirmed": 2,
                "proxies_expected": 2
            }"#,
        )
        .unwrap();
        assert_eq!(
            normalize_session_revocation(legacy)
                .unwrap()
                .tenant_sessions_revoked,
            1
        );

        let inconsistent: SessionRevocationWire = serde_json::from_str(
            r#"{
                "revoked": 1,
                "tenant_sessions_revoked": 2,
                "proxies_confirmed": 2,
                "proxies_expected": 2
            }"#,
        )
        .unwrap();
        assert!(normalize_session_revocation(inconsistent).is_err());
    }
}
