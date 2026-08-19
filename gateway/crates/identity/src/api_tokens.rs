//! Personal access tokens.
//!
//! Issued from the identity service for the chan CLI / chan-tunnel.
//! Token shape: `chan_pat_<32 random b64url bytes>`. Database stores
//! only `SHA-256(token)`, so a leak of the table doesn't hand out
//! live secrets; the plaintext leaves on the create response and is
//! never persisted.
//!
//! Scope is intentionally flat: a token authenticates a user. Workspace
//! ownership is enforced at the tenant host
//! (`{owner}--{disc}.{proxy}.proxy.{domain}`) by chan-tunnel, not via
//! per-token bindings; the workspace is a path segment only.
//!
//! Every state change writes one row to `api_token_audit`. Actions:
//! `created` (SPA mint), `created_via_desktop` (desktop-authorize
//! mint), `created_via_admin` (chan-gateway-admin mint),
//! `desktop.redeem` (one-time desktop code cashed in), `used`
//! (validate succeeded), `revoked` (owner self-revoke),
//! `revoked_via_admin` (operator revoke; written by profile).

use base64::Engine;
use chrono::{DateTime, Utc};
use devserver_control_proto::{
    AdmissionLease, AdmissionLeaseBinding, AdmissionLeaseSigner, ProxyId,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{Error, Result};

const TOKEN_PREFIX: &str = "chan_pat_";

/// Audit-log actions. Stored as text to keep migrations simple; if
/// the set ever grows we can add a CHECK constraint.
pub const ACTION_CREATED: &str = "created";
pub const ACTION_CREATED_DESKTOP: &str = "created_via_desktop";
pub const ACTION_CREATED_ADMIN: &str = "created_via_admin";
pub const ACTION_DESKTOP_REDEEM: &str = "desktop.redeem";
pub const ACTION_USED: &str = "used";
pub const ACTION_REVOKED: &str = "revoked";

/// Where a `create()` call came from. Each origin records a distinct
/// audit action so operators (and the user themselves) can tell apart
/// tokens minted by the SPA's "create token" button, by chan-desktop
/// bouncing through `/desktop/authorize`, and by an operator running
/// `chan-gateway-admin token create`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenOrigin {
    Spa,
    Desktop,
    Admin,
}

impl TokenOrigin {
    pub fn audit_action(self) -> &'static str {
        match self {
            Self::Spa => ACTION_CREATED,
            Self::Desktop => ACTION_CREATED_DESKTOP,
            Self::Admin => ACTION_CREATED_ADMIN,
        }
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ApiToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    /// Capabilities the token carries. Returned to the proxy at validate
    /// time and gates chan-tunnel-server's scope checks (`tunnel` for any
    /// dial). Newly-issued tokens default to `["tunnel"]`.
    pub scopes: Vec<String>,
}

/// One-shot response: the only time the plaintext token is exposed.
#[derive(Serialize)]
pub struct CreatedToken {
    #[serde(flatten)]
    pub token: ApiToken,
    /// `chan_pat_...` -- shown to the user once, never persisted.
    pub secret: String,
}

impl std::fmt::Debug for CreatedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedToken")
            .field("token", &self.token)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub action: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

/// Successful validate result handed to chan-tunnel. `username` is
/// what chan.app/{username} resolves to; tunneld uses it to build
/// the public URL.
#[derive(Debug, Clone, Serialize)]
pub struct ValidatedToken {
    pub user_id: Uuid,
    pub username: String,
    pub token_id: Uuid,
    pub expires_at: Option<DateTime<Utc>>,
    /// Per-token capabilities. The proxy forwards these into
    /// `chan_tunnel_server::Validated::scopes`, which the listener
    /// uses to gate `tunnel` (any dial).
    pub scopes: Vec<String>,
    /// Devserver identity: lowercase hex SHA-256 of the PAT. The gateway
    /// keys the tunnel registry and the devserver-gate `drv` claim on
    /// this (1 token : 1 devserver). Computed identity-side; the raw PAT
    /// never leaves this service. Distinct encoding from the stored
    /// `token_hash` (base64url) but the same underlying digest.
    pub devserver_id: String,
    /// Authorization state retained only long enough to sign the admission
    /// lease. The proxy learns it from the verified lease, not this response.
    #[serde(skip_serializing)]
    pub max_connected_devservers: u32,
    /// Identity-signed, short-lived controller authority for one exact
    /// registration. Present only on admission validation calls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_lease: Option<AdmissionLease>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_lease_expires_at: Option<DateTime<Utc>>,
}

/// Default scope set for a freshly-issued token. `tunnel` lets the
/// holder dial chan-tunnel; it is the only live scope (every devserver
/// is authenticated, so there is no anonymous-readable capability).
pub const DEFAULT_TOKEN_SCOPES: &[&str] = &["tunnel"];

/// Request-scoped audit context recorded alongside token mutations.
/// Extracted from the HTTP request headers (`http::request_meta`);
/// both fields are best-effort and audit-only -- never used for
/// authorization.
#[derive(Debug, Clone, Default)]
pub struct RequestMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl RequestMeta {
    fn ip(&self) -> Option<&str> {
        self.ip.as_deref()
    }

    fn user_agent(&self) -> Option<&str> {
        self.user_agent.as_deref()
    }
}

/// Everything that defines a token being minted. Constructed with
/// named fields at the call site; `create` validates the label and
/// scope list.
#[derive(Debug)]
pub struct NewToken<'a> {
    pub user_id: Uuid,
    pub label: &'a str,
    pub expires_at: Option<DateTime<Utc>>,
    pub scopes: &'a [String],
    pub origin: TokenOrigin,
}

#[derive(Clone)]
pub struct ApiTokenService {
    pool: PgPool,
    admission_signer: Option<AdmissionLeaseSigner>,
    policy_required: bool,
}

impl ApiTokenService {
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            admission_signer: None,
            policy_required: false,
        }
    }

    pub fn with_admission_signer(pool: PgPool, admission_signer: AdmissionLeaseSigner) -> Self {
        Self {
            pool,
            admission_signer: Some(admission_signer),
            policy_required: false,
        }
    }

    pub fn with_policy_required(mut self, policy_required: bool) -> Self {
        self.policy_required = policy_required;
        self
    }

    /// Single PAT-mint entry point for both the SPA and the
    /// desktop-authorize flow; `new.origin` picks the audit action.
    pub async fn create(&self, new: NewToken<'_>, meta: &RequestMeta) -> Result<CreatedToken> {
        let label = new.label.trim();
        if label.is_empty() {
            return Err(Error::BadRequest("label required".into()));
        }
        if label.len() > 64 {
            return Err(Error::BadRequest("label too long".into()));
        }
        validate_scopes(new.scopes)?;

        let (secret, hash) = generate_token();
        let token = sqlx::query_as::<_, ApiToken>(
            "WITH locked_user AS MATERIALIZED ( \
                 SELECT id, blocked_at FROM users WHERE id = $1 FOR UPDATE \
             ), locked_fleet AS MATERIALIZED ( \
                 SELECT admissions_enabled FROM devserver_fleet_policy \
                 WHERE singleton = true FOR SHARE \
             ) \
             INSERT INTO api_tokens (user_id, label, token_hash, expires_at, scopes) \
             SELECT u.id, $2, $3, $4, $5 \
             FROM locked_user u \
             CROSS JOIN locked_fleet f \
             LEFT JOIN devserver_user_policies p ON p.user_id = u.id \
             WHERE u.blocked_at IS NULL \
               AND f.admissions_enabled = true \
               AND ((p.user_id IS NOT NULL AND p.enabled = true \
                     AND p.max_connected_devservers <= $7) \
                    OR (p.user_id IS NULL AND NOT $6)) \
             RETURNING id, user_id, label, expires_at, created_at, \
                       revoked_at, last_used_at, scopes",
        )
        .bind(new.user_id)
        .bind(label)
        .bind(&hash)
        .bind(new.expires_at)
        .bind(new.scopes)
        .bind(self.policy_required)
        .bind(i32::try_from(devserver_control_proto::MAX_SIGNED_CONNECTED_DEVSERVERS).unwrap())
        .fetch_optional(&self.pool)
        .await
        .map_err(map_db)?;
        let Some(token) = token else {
            let exists =
                sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
                    .bind(new.user_id)
                    .fetch_one(&self.pool)
                    .await
                    .map_err(map_db)?;
            if !exists {
                return Err(Error::NotFound);
            }
            return Err(match new.origin {
                TokenOrigin::Admin => Error::AdminDevserverAccessDisabled,
                TokenOrigin::Spa | TokenOrigin::Desktop => Error::DevserverAccessDisabled,
            });
        };

        self.write_audit(token.id, new.origin.audit_action(), meta)
            .await?;

        Ok(CreatedToken { token, secret })
    }

    /// Case-insensitive email -> user id, on the shared DB (identity
    /// and profile share one Postgres; the users table is reachable
    /// here the same way `validate()` joins it). `None` for an
    /// unknown email.
    pub async fn user_id_by_email(&self, email: &str) -> Result<Option<Uuid>> {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE lower(email) = lower($1)")
            .bind(email)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_db)
    }

    /// Token id -> owning user, revoked or not: the operator revoke
    /// needs the owner for its data-plane first cut even when the
    /// durable revoke is a retry. `None` for an unknown id.
    pub async fn owner_of(&self, token_id: Uuid) -> Result<Option<Uuid>> {
        sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM api_tokens WHERE id = $1")
            .bind(token_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_db)
    }

    pub async fn list(&self, user_id: Uuid) -> Result<Vec<ApiToken>> {
        let rows = sqlx::query_as::<_, ApiToken>(
            "SELECT id, user_id, label, expires_at, created_at, \
                    revoked_at, last_used_at, scopes \
             FROM api_tokens \
             WHERE user_id = $1 \
             ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(map_db)?;
        Ok(rows)
    }

    /// Soft-revoke: keeps the row for audit history, but
    /// `validate()` skips revoked tokens.
    pub async fn revoke(&self, user_id: Uuid, token_id: Uuid, meta: &RequestMeta) -> Result<bool> {
        let res = sqlx::query(
            "UPDATE api_tokens SET revoked_at = now() \
             WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
        )
        .bind(token_id)
        .bind(user_id)
        .execute(&self.pool)
        .await
        .map_err(map_db)?;
        if res.rows_affected() == 0 {
            return Ok(false);
        }
        self.write_audit(token_id, ACTION_REVOKED, meta).await?;
        Ok(true)
    }

    /// Ownership probe used to distinguish an idempotent revoke retry from a
    /// guessed or cross-account token id after the local denial is in place.
    pub async fn owns(&self, user_id: Uuid, token_id: Uuid) -> Result<bool> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM api_tokens WHERE id = $1 AND user_id = $2)")
            .bind(token_id)
            .bind(user_id)
            .fetch_one(&self.pool)
            .await
            .map_err(map_db)
    }

    pub async fn audit(
        &self,
        user_id: Uuid,
        token_id: Uuid,
        limit: i64,
    ) -> Result<Vec<AuditEntry>> {
        // Ownership check first so we don't leak audit rows for
        // someone else's token id.
        let owned = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM api_tokens \
             WHERE id = $1 AND user_id = $2)",
        )
        .bind(token_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .map_err(map_db)?;
        if !owned {
            return Err(Error::NotFound);
        }
        let rows = sqlx::query_as::<_, AuditEntry>(
            "SELECT id, ts, action, ip, user_agent \
             FROM api_token_audit \
             WHERE token_id = $1 \
             ORDER BY ts DESC \
             LIMIT $2",
        )
        .bind(token_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(map_db)?;
        Ok(rows)
    }

    /// Look up by token, enforce active + non-expired, bump
    /// `last_used_at` and write an audit row. Single statement so
    /// concurrent validates can't both write conflicting timestamps.
    pub async fn validate(&self, token: &str, meta: &RequestMeta) -> Result<ValidatedToken> {
        let v = self.validate_no_audit(token).await?;
        self.write_audit(v.token_id, ACTION_USED, meta).await?;
        Ok(v)
    }

    /// Validate a PAT and mint controller authority for one exact proxy
    /// registration. The proxy cannot refresh this lease without the live
    /// tunnel client presenting the PAT again.
    pub async fn validate_for_admission(
        &self,
        token: &str,
        proxy_id: ProxyId,
        registration_id: Uuid,
        meta: &RequestMeta,
    ) -> Result<ValidatedToken> {
        let mut validated = self.validate(token, meta).await?;
        let signer = self.admission_signer.as_ref().ok_or_else(|| {
            Error::Anyhow(anyhow::anyhow!("admission lease signer is not configured"))
        })?;
        let now = Utc::now();
        let admission_lease = signer
            .sign(
                AdmissionLeaseBinding {
                    owner_user_id: validated.user_id,
                    user: validated.username.clone(),
                    devserver_id: validated.devserver_id.clone(),
                    registration_id,
                    proxy_id,
                },
                validated.max_connected_devservers,
                now,
                120,
            )
            .map_err(|error| Error::Anyhow(anyhow::anyhow!(error)))?;
        validated.admission_lease = Some(admission_lease);
        validated.admission_lease_expires_at = Some(now + chrono::Duration::seconds(120));
        Ok(validated)
    }

    /// [`validate`] minus the `used` audit row: the same single
    /// UPDATE..RETURNING, so `last_used_at` still bumps (a roster
    /// poll is real token use and keeps the token visibly active in
    /// the SPA), but nothing lands in `api_token_audit`. Serves only
    /// the desktop roster read, which polls per connected desktop and
    /// would otherwise write thousands of audit rows a day that say
    /// nothing beyond the bumped timestamp.
    pub async fn validate_no_audit(&self, token: &str) -> Result<ValidatedToken> {
        if !token.starts_with(TOKEN_PREFIX) {
            return Err(Error::Unauthorized);
        }
        let hash = hash_token(token);
        let devserver_id = devserver_id_from_pat(token);

        // Join to users to get the username on the same round trip.
        // Blocked accounts (`u.blocked_at IS NOT NULL`) are filtered
        // here so a token issued before the block stops working
        // immediately, even if the admin block step somehow missed
        // its auto-revoke pass.
        let row =
            sqlx::query_as::<_, (Uuid, Uuid, String, Option<DateTime<Utc>>, Vec<String>, i32)>(
                "UPDATE api_tokens t \
             SET last_used_at = now() \
             FROM users u \
             CROSS JOIN devserver_fleet_policy f \
             LEFT JOIN devserver_user_policies p ON p.user_id = u.id \
             WHERE t.token_hash = $1 \
               AND t.user_id = u.id \
               AND t.revoked_at IS NULL \
               AND (t.expires_at IS NULL OR t.expires_at > now()) \
               AND u.blocked_at IS NULL \
               AND f.singleton = true \
               AND f.admissions_enabled = true \
               AND ((p.user_id IS NOT NULL AND p.enabled = true \
                     AND p.max_connected_devservers <= $3) \
                    OR (p.user_id IS NULL AND NOT $2)) \
             RETURNING t.id, u.id, u.username, t.expires_at, t.scopes, \
                       COALESCE(p.max_connected_devservers, $3)",
            )
            .bind(&hash)
            .bind(self.policy_required)
            .bind(i32::try_from(devserver_control_proto::MAX_SIGNED_CONNECTED_DEVSERVERS).unwrap())
            .fetch_optional(&self.pool)
            .await
            .map_err(map_db)?
            .ok_or(Error::Unauthorized)?;

        Ok(ValidatedToken {
            token_id: row.0,
            user_id: row.1,
            username: row.2,
            expires_at: row.3,
            scopes: row.4,
            devserver_id,
            max_connected_devservers: u32::try_from(row.5).map_err(|_| Error::Unauthorized)?,
            admission_lease: None,
            admission_lease_expires_at: None,
        })
    }

    /// `pub(crate)` so the desktop-authorize redeem handler can record
    /// its `desktop.redeem` row without a second audit path.
    pub(crate) async fn write_audit(
        &self,
        token_id: Uuid,
        action: &str,
        meta: &RequestMeta,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO api_token_audit (token_id, action, ip, user_agent) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(token_id)
        .bind(action)
        .bind(meta.ip())
        .bind(meta.user_agent())
        .execute(&self.pool)
        .await
        .map_err(map_db)?;
        Ok(())
    }
}

/// Hard cap on the per-token scope list to bound row width and
/// keep validate-time copies tiny. The live set is just `tunnel`; the
/// cap leaves headroom for future scopes without admitting unbounded
/// lists.
const MAX_SCOPES_PER_TOKEN: usize = 16;
/// Hard cap on the length of any single scope. Scope names are short
/// identifiers (`tunnel`); the cap guards against pathological inputs
/// in the create body.
const MAX_SCOPE_LEN: usize = 64;

/// Reject scope lists that are empty, oversized, contain
/// blank entries, or carry duplicate names. The validator at the
/// other end (`chan_tunnel_server::Validated`) does a linear search
/// for the scopes it cares about, so duplicates would waste space
/// without changing behaviour; rejecting them keeps the row clean.
fn validate_scopes(scopes: &[String]) -> Result<()> {
    if scopes.is_empty() {
        return Err(Error::BadRequest("scopes must be non-empty".into()));
    }
    if scopes.len() > MAX_SCOPES_PER_TOKEN {
        return Err(Error::BadRequest(format!(
            "scopes list exceeds the {MAX_SCOPES_PER_TOKEN}-entry cap"
        )));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(scopes.len());
    for s in scopes {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Err(Error::BadRequest("scope must not be blank".into()));
        }
        if trimmed.len() > MAX_SCOPE_LEN {
            return Err(Error::BadRequest(format!(
                "scope {trimmed:?} exceeds the {MAX_SCOPE_LEN}-char cap"
            )));
        }
        if trimmed != s {
            return Err(Error::BadRequest(format!(
                "scope {s:?} must not contain leading/trailing whitespace"
            )));
        }
        if seen.contains(&trimmed) {
            return Err(Error::BadRequest(format!("duplicate scope {trimmed:?}")));
        }
        seen.push(trimmed);
    }
    Ok(())
}

fn generate_token() -> (String, String) {
    // OsRng directly: never falls back to a userspace PRNG even on
    // exotic platforms where ThreadRng's reseed window matters.
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let secret = format!(
        "{TOKEN_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    );
    let hash = hash_token(&secret);
    (secret, hash)
}

fn hash_token(token: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

/// Devserver identity = lowercase hex SHA-256 of the raw PAT. Same
/// digest as `hash_token`, hex-encoded instead of base64url: the gateway
/// keys the registry and the devserver-gate `drv` claim on this exact
/// string, so its shape (64 lowercase hex chars) is a cross-service
/// contract. The PAT is the secret; this hash is a public handle.
/// `pub(crate)` so the token-create handler can register the devserver
/// row (1 token : 1 devserver) at mint time.
pub(crate) fn devserver_id_from_pat(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn map_db(e: sqlx::Error) -> Error {
    tracing::error!(error = ?e, "api_tokens db error");
    Error::Anyhow(anyhow::anyhow!(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devserver_id_is_lowercase_hex_sha256() {
        // Known vector: SHA-256("abc") is a fixed, well-published digest.
        // Pins the encoding (lowercase hex, 64 chars) so a future tweak
        // to the helper cannot silently change the cross-service id.
        assert_eq!(
            devserver_id_from_pat("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let id = devserver_id_from_pat("chan_pat_example");
        assert_eq!(id.len(), 64);
        assert!(id.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));
        // Same digest as token_hash, different (base64url) encoding.
        assert_ne!(id, hash_token("chan_pat_example"));
    }

    #[test]
    fn validate_response_wire_pins_devserver_id() {
        // Cross-service contract: devserver-proxy keys the registry
        // and the devserver-gate `drv` claim on this exact JSON field
        // name. Renaming it is a silent, compile-green break, so pin the
        // wire string here.
        let v = ValidatedToken {
            user_id: Uuid::nil(),
            username: "alice".into(),
            token_id: Uuid::nil(),
            expires_at: None,
            scopes: vec!["tunnel".into()],
            devserver_id: "a".repeat(64),
            max_connected_devservers: 3,
            admission_lease: None,
            admission_lease_expires_at: None,
        };
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["devserver_id"], "a".repeat(64));
    }

    #[test]
    fn created_token_debug_redacts_plaintext_secret() {
        let created = CreatedToken {
            token: ApiToken {
                id: Uuid::nil(),
                user_id: Uuid::nil(),
                label: "test".into(),
                expires_at: None,
                created_at: Utc::now(),
                revoked_at: None,
                last_used_at: None,
                scopes: vec!["tunnel".into()],
            },
            secret: "sentinel-plaintext-pat".into(),
        };
        let debug = format!("{created:?}");
        assert!(!debug.contains("sentinel-plaintext-pat"));
        assert!(debug.contains("[REDACTED]"));
    }
}
