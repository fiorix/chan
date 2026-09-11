//! Typed HTTP client for profile-service.
//!
//! Mirrors `crates/profile/src/http.rs` exactly. The bearer token
//! lives in the client; callers never deal with auth.
//!
//! `ProfileError` is the client's own error enum so this crate has
//! no axum / IntoResponse dependency. Each consumer
//! (identity-service, the admin CLI) provides a `From<ProfileError>`
//! for its local request-handler error.

use chrono::{DateTime, Utc};
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("not found")]
    NotFound,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
}

pub type ProfileResult<T> = Result<T, ProfileError>;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub display_name: Option<String>,
    pub username: String,
    /// Lifetime rename counter. devserver-proxy ignores this; identity
    /// reads it to surface "edits remaining" in the SPA.
    #[serde(default)]
    pub username_edits: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set by the admin tooling. When non-null, identity refuses
    /// fresh sign-ins and the token-validate path skips the row.
    #[serde(default)]
    pub blocked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub block_reason: Option<String>,
    /// Provider-supplied avatar URL. Browser fetches it directly;
    /// devserver-proxy doesn't read this field.
    #[serde(default)]
    pub avatar_url: Option<String>,
}

impl User {
    pub fn is_blocked(&self) -> bool {
        self.blocked_at.is_some()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Identity {
    pub id: Uuid,
    pub user_id: Uuid,
    pub provider: String,
    pub provider_subject: String,
    pub email: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpsertResponse {
    pub user: User,
    #[serde(default)]
    pub user_created: bool,
    #[serde(default)]
    pub identity_created: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FeatureFlag {
    pub key: String,
    pub description: String,
    pub default_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FeatureFlagSummary {
    pub key: String,
    pub description: String,
    pub default_enabled: bool,
    pub override_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FeatureFlagOverride {
    pub flag_key: String,
    pub user_id: Uuid,
    pub enabled: bool,
    pub set_at: DateTime<Utc>,
}

/// Resolved flag map for one user -- what `GET /v1/users/{id}/flags`
/// returns. A flag absent from the map means it does not exist in
/// the registry (treat as false).
pub type FlagMap = std::collections::BTreeMap<String, bool>;

/// Route prefix profile gates with its admin bearer. Every path under
/// it is behind `admin_auth` in `crates/profile/src/http.rs`.
const ADMIN_PATH_PREFIX: &str = "/v1/admin/";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Devserver {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub label: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DevserverGrant {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub grantee_email: String,
    #[serde(default)]
    pub grantee_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub accepted_at: Option<DateTime<Utc>>,
}

/// Binary shell-equivalent access decision for one exact devserver.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DevserverAccess {
    pub access: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OwnedDevserverSummary {
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub label: String,
    pub grant_count: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IncomingShare {
    pub grant_id: Uuid,
    pub owner_user_id: Uuid,
    pub owner_username: String,
    #[serde(default)]
    pub owner_display_name: Option<String>,
    #[serde(default)]
    pub owner_avatar_url: Option<String>,
    pub devserver_id: String,
    pub label: String,
    pub accepted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct DevserverUserPolicy {
    pub user_id: Uuid,
    pub enabled: bool,
    pub max_connected_devservers: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DevserverFleetPolicy {
    pub admissions_enabled: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AccessRevocation {
    pub user_id: Uuid,
    pub username: String,
    pub pats_revoked: i64,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateDevserverUserPolicy {
    enabled: bool,
    max_connected_devservers: i32,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateDevserverFleetPolicy {
    admissions_enabled: bool,
}

#[derive(Clone)]
pub struct ProfileClient {
    base: Url,
    http: reqwest::Client,
    token: String,
    admin_token: Option<String>,
}

impl std::fmt::Debug for ProfileClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileClient")
            .field("base", &self.base)
            // token deliberately elided
            .finish()
    }
}

impl ProfileClient {
    pub fn new(base: Url, token: String) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(2))
            .build()?;
        Ok(Self {
            base,
            http,
            token,
            admin_token: None,
        })
    }

    pub fn with_admin_token(mut self, token: String) -> anyhow::Result<Self> {
        if token.is_empty() {
            anyhow::bail!("profile admin token must not be empty");
        }
        self.admin_token = Some(token);
        Ok(self)
    }

    fn url(&self, path: &str) -> Url {
        let mut u = self.base.clone();
        u.set_path(path);
        u
    }

    /// Bearer for `path`, derived from the path itself.
    ///
    /// Profile gates `/v1/admin/*` with `admin_auth`, which compares
    /// only against its admin token and never accepts the service
    /// token; every other route takes the service token. Deriving the
    /// tier here rather than at the call site is what keeps an admin
    /// route from being issued with the service bearer: there is no
    /// second builder to pick the wrong one from.
    ///
    /// The fallback is load bearing. A single-token deployment leaves
    /// `admin_token` unset and profile's `admin_token` is then the
    /// same value as its service token, so admin routes have to go
    /// out on `self.token`.
    fn bearer(&self, path: &str) -> &str {
        if path.starts_with(ADMIN_PATH_PREFIX) {
            self.admin_token.as_ref().unwrap_or(&self.token)
        } else {
            &self.token
        }
    }

    /// Attach the tier's bearer to an already-built URL. Callers that
    /// need query parameters build the `Url` first and come through
    /// here, so they are covered by the same rule as `req`.
    fn authed(&self, method: reqwest::Method, url: Url) -> reqwest::RequestBuilder {
        let authorization = format!("Bearer {}", self.bearer(url.path()));
        self.http
            .request(method, url)
            .header(header::AUTHORIZATION, authorization)
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.authed(method, self.url(path))
    }

    /// Send a request that is safe to replay: one retry after 100 ms
    /// on connect error, timeout, or 5xx. Only use for idempotent GETs
    /// -- never for POST/PATCH/DELETE -- because a retry after a write
    /// that the network ate at response time would double-apply.
    /// Damps brief profile-service hiccups (restart, rolling deploy)
    /// for the dashboard and OAuth-callback read path.
    async fn send_idempotent(
        builder: reqwest::RequestBuilder,
    ) -> reqwest::Result<reqwest::Response> {
        // Clone before the first send; `RequestBuilder::try_clone` only
        // fails when the body is a non-cloneable Stream (never the case
        // for the GETs that route through here).
        let retry = builder.try_clone();
        let first = builder.send().await;
        let should_retry = match &first {
            Ok(r) => r.status().is_server_error(),
            Err(e) => e.is_connect() || e.is_timeout(),
        };
        if !should_retry {
            return first;
        }
        let Some(retry) = retry else {
            return first;
        };
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        retry.send().await
    }

    pub async fn get_user(&self, id: Uuid) -> ProfileResult<Option<User>> {
        let builder = self.req(reqwest::Method::GET, &format!("/v1/users/{id}"));
        let res = Self::send_idempotent(builder).await?;
        match res.status() {
            StatusCode::OK => Ok(Some(res.json().await?)),
            StatusCode::NOT_FOUND => Ok(None),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_get_devserver_policy(
        &self,
        user_id: Uuid,
    ) -> ProfileResult<Option<DevserverUserPolicy>> {
        let builder = self.req(
            reqwest::Method::GET,
            &format!("/v1/admin/users/{user_id}/devserver-policy"),
        );
        let res = Self::send_idempotent(builder).await?;
        match res.status() {
            StatusCode::OK => Ok(Some(res.json().await?)),
            StatusCode::NOT_FOUND => Ok(None),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_put_devserver_policy(
        &self,
        user_id: Uuid,
        enabled: bool,
        max_connected_devservers: i32,
    ) -> ProfileResult<DevserverUserPolicy> {
        let res = self
            .req(
                reqwest::Method::PUT,
                &format!("/v1/admin/users/{user_id}/devserver-policy"),
            )
            .json(&UpdateDevserverUserPolicy {
                enabled,
                max_connected_devservers,
            })
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_get_fleet_policy(&self) -> ProfileResult<DevserverFleetPolicy> {
        let builder = self.req(reqwest::Method::GET, "/v1/admin/devserver-policy");
        let res = Self::send_idempotent(builder).await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_put_fleet_policy(
        &self,
        admissions_enabled: bool,
    ) -> ProfileResult<DevserverFleetPolicy> {
        let res = self
            .req(reqwest::Method::PUT, "/v1/admin/devserver-policy")
            .json(&UpdateDevserverFleetPolicy { admissions_enabled })
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_revoke_user_access(&self, user_id: Uuid) -> ProfileResult<AccessRevocation> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/admin/users/{user_id}/access/revoke"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn find_user_by_username(&self, username: &str) -> ProfileResult<Option<User>> {
        let mut url = self.url("/v1/users/by-username");
        url.query_pairs_mut().append_pair("u", username);
        let builder = self.authed(reqwest::Method::GET, url);
        let res = Self::send_idempotent(builder).await?;
        match res.status() {
            StatusCode::OK => Ok(Some(res.json().await?)),
            StatusCode::NOT_FOUND => Ok(None),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn find_user_by_identity(
        &self,
        provider: &str,
        subject: &str,
    ) -> ProfileResult<Option<User>> {
        let mut url = self.url("/v1/users/by-identity");
        url.query_pairs_mut()
            .append_pair("provider", provider)
            .append_pair("subject", subject);
        let res = self.authed(reqwest::Method::GET, url).send().await?;
        match res.status() {
            StatusCode::OK => Ok(Some(res.json().await?)),
            StatusCode::NOT_FOUND => Ok(None),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn create_user(
        &self,
        email: &str,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
    ) -> ProfileResult<User> {
        let res = self
            .req(reqwest::Method::POST, "/v1/users")
            .json(&serde_json::json!({
                "email": email,
                "display_name": display_name,
                "avatar_url": avatar_url,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::CREATED => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    /// Refresh the avatar URL on subsequent sign-ins. Best-effort:
    /// callers fire-and-forget so a failed update doesn't block the
    /// login flow. Sends only the avatar_url field; PATCH semantics
    /// in profile-service leave the other fields untouched.
    pub async fn update_avatar(&self, id: Uuid, avatar_url: &str) -> ProfileResult<()> {
        let res = self
            .req(reqwest::Method::PATCH, &format!("/v1/users/{id}"))
            .json(&serde_json::json!({"avatar_url": avatar_url}))
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn link_identity(
        &self,
        user_id: Uuid,
        provider: &str,
        subject: &str,
        email: Option<&str>,
    ) -> ProfileResult<Identity> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/users/{user_id}/identities"),
            )
            .json(&serde_json::json!({
                "provider": provider,
                "provider_subject": subject,
                "email": email,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::CREATED => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    /// Atomic find-or-create-or-link. One round trip, one Postgres
    /// transaction; closes the orphan window on concurrent first-time
    /// logins and folds in email-based linking when a second provider
    /// attaches to an existing user.
    pub async fn upsert_by_identity(
        &self,
        provider: &str,
        provider_subject: &str,
        email: Option<&str>,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
    ) -> ProfileResult<UpsertResponse> {
        let res = self
            .req(reqwest::Method::POST, "/v1/users/upsert-by-identity")
            .json(&serde_json::json!({
                "provider": provider,
                "provider_subject": provider_subject,
                "email": email,
                "display_name": display_name,
                "avatar_url": avatar_url,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            // 400 is the "no email and no existing identity" case:
            // users.email is NOT NULL so we can't insert without one.
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn update_username(&self, user_id: Uuid, username: &str) -> ProfileResult<User> {
        let res = self
            .req(
                reqwest::Method::PATCH,
                &format!("/v1/users/{user_id}/username"),
            )
            .json(&serde_json::json!({"username": username}))
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            // 409 covers both "rename limit reached" and "username
            // taken"; bubble the upstream message up so the SPA can
            // show the right text.
            StatusCode::CONFLICT => Err(ProfileError::Conflict(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    /// Best-effort log of a user-level event (login / logout /
    /// login_denied). Typically called fire-and-forget: an audit gap
    /// is preferable to a login failure when profile is briefly
    /// unhealthy.
    pub async fn write_auth_audit(
        &self,
        user_id: Uuid,
        action: &str,
        ip: Option<&str>,
        user_agent: Option<&str>,
        note: Option<&str>,
    ) -> ProfileResult<()> {
        let res = self
            .req(reqwest::Method::POST, "/v1/auth-audit")
            .json(&serde_json::json!({
                "user_id": user_id,
                "action": action,
                "ip": ip,
                "user_agent": user_agent,
                "note": note,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn delete_user(&self, id: Uuid) -> ProfileResult<()> {
        let res = self
            .req(reqwest::Method::DELETE, &format!("/v1/users/{id}"))
            .send()
            .await?;
        match res.status() {
            StatusCode::ACCEPTED => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Block all new account activity while retaining the user row until the
    /// caller has confirmed live data-plane revocation across the proxy fleet.
    pub async fn mark_user_pending_delete(&self, id: Uuid) -> ProfileResult<()> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/users/{id}/pending-delete"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::ACCEPTED => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Atomically verify PAT ownership, deny the token, audit the request, and
    /// reserve durable subject revocation in profile's transaction.
    pub async fn revoke_user_api_token(
        &self,
        user_id: Uuid,
        token_id: Uuid,
        ip: Option<&str>,
        user_agent: Option<&str>,
    ) -> ProfileResult<()> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/users/{user_id}/tokens/{token_id}/revoke"),
            )
            .json(&serde_json::json!({
                "ip": ip,
                "user_agent": user_agent,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::ACCEPTED => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Operator-tier revoke by token id, no owner required: profile
    /// soft-revokes, writes the `revoked_via_admin` audit row, and
    /// reserves durable subject revocation. Retry-safe on an
    /// already-revoked token; an unknown id is `NotFound`.
    pub async fn admin_revoke_api_token(&self, token_id: Uuid) -> ProfileResult<()> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/admin/tokens/{token_id}/revoke"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::ACCEPTED => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Resolved flag map for one user. Identity reads this on every
    /// /api/me so the SPA can gate UI affordances, and on OAuth
    /// callback to enforce the `oauth_login` allowlist.
    pub async fn get_user_flags(&self, user_id: Uuid) -> ProfileResult<FlagMap> {
        let builder = self.req(reqwest::Method::GET, &format!("/v1/users/{user_id}/flags"));
        let res = Self::send_idempotent(builder).await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Admin tier: list every registered flag with its override count.
    pub async fn admin_list_flags(&self) -> ProfileResult<Vec<FeatureFlagSummary>> {
        let res = self
            .req(reqwest::Method::GET, "/v1/admin/flags")
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    /// Admin tier: idempotent create/update. Profile returns 200 in
    /// both cases.
    pub async fn admin_upsert_flag(
        &self,
        key: &str,
        description: Option<&str>,
        default_enabled: bool,
    ) -> ProfileResult<FeatureFlag> {
        let res = self
            .req(reqwest::Method::POST, "/v1/admin/flags")
            .json(&serde_json::json!({
                "key": key,
                "description": description,
                "default_enabled": default_enabled,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::OK | StatusCode::CREATED => Ok(res.json().await?),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_delete_flag(&self, key: &str) -> ProfileResult<()> {
        let res = self
            .req(reqwest::Method::DELETE, &format!("/v1/admin/flags/{key}"))
            .send()
            .await?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_list_flag_overrides(
        &self,
        key: &str,
    ) -> ProfileResult<Vec<FeatureFlagOverride>> {
        let res = self
            .req(
                reqwest::Method::GET,
                &format!("/v1/admin/flags/{key}/overrides"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_upsert_flag_override(
        &self,
        key: &str,
        user_id: Uuid,
        enabled: bool,
    ) -> ProfileResult<FeatureFlagOverride> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/admin/flags/{key}/overrides"),
            )
            .json(&serde_json::json!({"user_id": user_id, "enabled": enabled}))
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn admin_delete_flag_override(&self, key: &str, user_id: Uuid) -> ProfileResult<()> {
        let res = self
            .req(
                reqwest::Method::DELETE,
                &format!("/v1/admin/flags/{key}/overrides/{user_id}"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Idempotent. 201 on insert, 200 on hit-existing -- caller maps
    /// both to "devserver now exists". `label` mirrors the PAT label;
    /// a blank label on a re-issue leaves the stored one untouched.
    pub async fn create_devserver(
        &self,
        owner_id: Uuid,
        devserver_id: &str,
        label: &str,
    ) -> ProfileResult<Devserver> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/users/{owner_id}/devservers"),
            )
            .json(&serde_json::json!({"devserver_id": devserver_id, "label": label}))
            .send()
            .await?;
        match res.status() {
            StatusCode::CREATED | StatusCode::OK => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn list_devservers(&self, owner_id: Uuid) -> ProfileResult<Vec<Devserver>> {
        let res = self
            .req(
                reqwest::Method::GET,
                &format!("/v1/users/{owner_id}/devservers"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn delete_devserver(&self, owner_id: Uuid, devserver_id: &str) -> ProfileResult<()> {
        let res = self
            .req(
                reqwest::Method::DELETE,
                &format!("/v1/users/{owner_id}/devservers/{devserver_id}"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(()),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Idempotently grant one email shell-equivalent access to the exact
    /// devserver. Existing claim metadata is preserved server-side.
    pub async fn create_devserver_grant(
        &self,
        owner_id: Uuid,
        devserver_id: &str,
        grantee_email: &str,
    ) -> ProfileResult<DevserverGrant> {
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/users/{owner_id}/devservers/{devserver_id}/grants"),
            )
            .json(&serde_json::json!({
                "grantee_email": grantee_email,
            }))
            .send()
            .await?;
        match res.status() {
            StatusCode::CREATED => Ok(res.json().await?),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn list_devserver_grants(
        &self,
        owner_id: Uuid,
        devserver_id: &str,
    ) -> ProfileResult<Vec<DevserverGrant>> {
        let res = self
            .req(
                reqwest::Method::GET,
                &format!("/v1/users/{owner_id}/devservers/{devserver_id}/grants"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    /// Owner-scoped delete. `owner_id` is required by the server, so
    /// a bug in identity-service can't let user A revoke user B's
    /// grant.
    pub async fn delete_devserver_grant(
        &self,
        owner_id: Uuid,
        grant_id: Uuid,
    ) -> ProfileResult<bool> {
        let res = self
            .req(
                reqwest::Method::DELETE,
                &format!("/v1/users/{owner_id}/grants/{grant_id}"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::NO_CONTENT => Ok(false),
            StatusCode::ACCEPTED => Ok(true),
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }

    /// Per-request access gate. `Ok(Some(DevserverAccess))` is access;
    /// `Ok(None)` is no access (shares the 404 shape with "unknown
    /// devserver" on purpose, so callers can render a single "no access"
    /// page without disclosing which case they hit). A grant gives the
    /// WHOLE devserver, so this is the single authorization assertion.
    pub async fn devserver_access(
        &self,
        owner_id: Uuid,
        devserver_id: &str,
        caller: Uuid,
    ) -> ProfileResult<Option<DevserverAccess>> {
        let mut url = self.url(&format!(
            "/v1/users/{owner_id}/devservers/{devserver_id}/access"
        ));
        url.query_pairs_mut().append_pair("as", &caller.to_string());
        let builder = self.authed(reqwest::Method::GET, url);
        let res = Self::send_idempotent(builder).await?;
        match res.status() {
            StatusCode::OK => Ok(Some(res.json().await?)),
            StatusCode::NOT_FOUND => Ok(None),
            StatusCode::BAD_REQUEST => Err(ProfileError::BadRequest(read_error(res).await)),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn list_owned_devservers(
        &self,
        user_id: Uuid,
    ) -> ProfileResult<Vec<OwnedDevserverSummary>> {
        let res = self
            .req(
                reqwest::Method::GET,
                &format!("/v1/users/{user_id}/grants/owned"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    pub async fn list_incoming_shares(&self, user_id: Uuid) -> ProfileResult<Vec<IncomingShare>> {
        let res = self
            .req(
                reqwest::Method::GET,
                &format!("/v1/users/{user_id}/grants/incoming"),
            )
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => Ok(res.json().await?),
            s => Err(upstream(s, res).await),
        }
    }

    /// Claim pending grants whose `grantee_email` matches any of the
    /// supplied verified OAuth emails. Returns the count of rows
    /// transitioned from pending to claimed. Idempotent.
    pub async fn claim_grants(&self, user_id: Uuid, emails: &[String]) -> ProfileResult<i64> {
        #[derive(Deserialize)]
        struct Resp {
            claimed: i64,
        }
        let res = self
            .req(
                reqwest::Method::POST,
                &format!("/v1/users/{user_id}/grants/claim"),
            )
            .json(&serde_json::json!({"emails": emails}))
            .send()
            .await?;
        match res.status() {
            StatusCode::OK => {
                let r: Resp = res.json().await?;
                Ok(r.claimed)
            }
            StatusCode::NOT_FOUND => Err(ProfileError::NotFound),
            s => Err(upstream(s, res).await),
        }
    }
}

async fn upstream(status: StatusCode, res: reqwest::Response) -> ProfileError {
    drop(res);
    tracing::warn!(%status, "profile-service upstream error");
    ProfileError::Upstream(format!("profile-service {status}"))
}

async fn read_error(res: reqwest::Response) -> String {
    res.text()
        .await
        .unwrap_or_else(|e| format!("<read error: {e}>"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVICE_TOKEN: &str = "service-bearer";
    const ADMIN_TOKEN: &str = "admin-bearer";
    const USER: &str = "11111111-2222-3333-4444-555555555555";

    /// Paths profile gates with `admin_auth`, which accepts only the
    /// admin bearer. One entry per `/v1/admin/*` shape this client
    /// issues.
    const ADMIN_ROUTES: &[(reqwest::Method, &str)] = &[
        (reqwest::Method::POST, "/v1/admin/tokens/abc/revoke"),
        (reqwest::Method::GET, "/v1/admin/flags"),
        (reqwest::Method::POST, "/v1/admin/flags"),
        (reqwest::Method::DELETE, "/v1/admin/flags/beta"),
        (reqwest::Method::GET, "/v1/admin/flags/beta/overrides"),
        (reqwest::Method::POST, "/v1/admin/flags/beta/overrides"),
        (
            reqwest::Method::DELETE,
            "/v1/admin/flags/beta/overrides/abc",
        ),
        (reqwest::Method::GET, "/v1/admin/devserver-policy"),
        (reqwest::Method::PUT, "/v1/admin/devserver-policy"),
    ];

    /// Paths profile gates with the service bearer.
    const SERVICE_ROUTES: &[(reqwest::Method, &str)] = &[
        (reqwest::Method::POST, "/v1/users"),
        (reqwest::Method::POST, "/v1/users/upsert-by-identity"),
        (reqwest::Method::POST, "/v1/auth-audit"),
        (reqwest::Method::GET, "/v1/users/by-username"),
    ];

    fn client(admin_token: Option<&str>) -> ProfileClient {
        let base: Url = "https://profile.internal.test/".parse().unwrap();
        let client = ProfileClient::new(base, SERVICE_TOKEN.to_string()).unwrap();
        match admin_token {
            Some(token) => client.with_admin_token(token.to_string()).unwrap(),
            None => client,
        }
    }

    fn authorization(builder: reqwest::RequestBuilder) -> String {
        builder
            .build()
            .expect("request builds")
            .headers()
            .get(header::AUTHORIZATION)
            .expect("request carries an Authorization header")
            .to_str()
            .expect("Authorization header is ascii")
            .to_owned()
    }

    #[test]
    fn admin_routes_carry_the_admin_bearer() {
        let client = client(Some(ADMIN_TOKEN));
        for (method, path) in ADMIN_ROUTES {
            let path = path.replace("abc", USER);
            assert_eq!(
                authorization(client.req(method.clone(), &path)),
                format!("Bearer {ADMIN_TOKEN}"),
                "{method} {path} was not issued with the admin bearer"
            );
        }
    }

    #[test]
    fn service_routes_carry_the_service_bearer() {
        let client = client(Some(ADMIN_TOKEN));
        for (method, path) in SERVICE_ROUTES {
            assert_eq!(
                authorization(client.req(method.clone(), path)),
                format!("Bearer {SERVICE_TOKEN}"),
                "{method} {path} was not issued with the service bearer"
            );
        }
        let path = format!("/v1/users/{USER}/flags");
        assert_eq!(
            authorization(client.req(reqwest::Method::GET, &path)),
            format!("Bearer {SERVICE_TOKEN}")
        );
    }

    /// The three read paths that append query parameters build their
    /// `Url` first, so they reach the header through `authed` rather
    /// than `req`. Pin them to the same rule.
    #[test]
    fn query_string_routes_use_the_same_path_derived_tier() {
        let client = client(Some(ADMIN_TOKEN));
        let mut service = client.url("/v1/users/by-username");
        service.query_pairs_mut().append_pair("u", "alice");
        assert_eq!(
            authorization(client.authed(reqwest::Method::GET, service)),
            format!("Bearer {SERVICE_TOKEN}")
        );
        let mut admin = client.url("/v1/admin/flags");
        admin.query_pairs_mut().append_pair("key", "beta");
        assert_eq!(
            authorization(client.authed(reqwest::Method::GET, admin)),
            format!("Bearer {ADMIN_TOKEN}")
        );
    }

    /// A single-token deployment leaves the admin token unset and
    /// runs every tier on the service bearer. That fallback is load
    /// bearing: dropping it would lock those deployments out of
    /// `/v1/admin/*`.
    #[test]
    fn admin_routes_fall_back_to_the_service_bearer_without_an_admin_token() {
        let client = client(None);
        for (method, path) in ADMIN_ROUTES.iter().chain(SERVICE_ROUTES) {
            let path = path.replace("abc", USER);
            assert_eq!(
                authorization(client.req(method.clone(), &path)),
                format!("Bearer {SERVICE_TOKEN}"),
                "{method} {path} was not issued with the service bearer"
            );
        }
    }
}
