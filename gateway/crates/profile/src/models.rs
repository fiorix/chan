use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub display_name: Option<String>,
    pub username: String,
    pub username_edits: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub blocked_at: Option<DateTime<Utc>>,
    pub block_reason: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateUser {
    pub email: String,
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUser {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Admin-only payload to rewrite a user's email. Email is the identity-
/// linking key for branch (b) of `upsert_by_identity`, so changing it
/// is effectively an account-takeover lever and lives behind the admin
/// bearer (not the service bearer). Operators audit-log the change in
/// `auth_audit` via the handler.
#[derive(Debug, Deserialize)]
pub struct AdminChangeEmail {
    pub email: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUsername {
    pub username: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Identity {
    pub id: Uuid,
    pub user_id: Uuid,
    pub provider: String,
    pub provider_subject: String,
    pub email: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateIdentity {
    pub provider: String,
    pub provider_subject: String,
    pub email: Option<String>,
}

/// Atomic "find or create" by OAuth identity, in one transaction.
/// The single round trip is what prevents orphan user rows on
/// concurrent first-time logins, and it carries the email-based
/// linking rule: sign-in with a second provider whose verified email
/// matches an existing user attaches to that user instead of
/// failing with a duplicate-email conflict.
#[derive(Debug, Deserialize)]
pub struct UpsertByIdentity {
    pub provider: String,
    pub provider_subject: String,
    /// Required to create a new user (users.email is NOT NULL).
    /// Absence is allowed when the call resolves to an existing
    /// (provider, subject) -- providers may stop returning email on
    /// re-auth and we still want sign-in to succeed.
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpsertResponse {
    pub user: User,
    /// True only on the branch that inserted a brand-new user row.
    pub user_created: bool,
    /// True when this call inserted the identity row (either to a
    /// freshly-created user or attaching to an existing one via
    /// email match). False on the steady-state "already linked"
    /// branch.
    pub identity_created: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AuthAudit {
    pub id: i64,
    pub user_id: Uuid,
    pub ts: DateTime<Utc>,
    pub action: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAuthAudit {
    pub user_id: Uuid,
    pub action: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BlockUser {
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AdminToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub label: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AdminTokenAudit {
    pub id: i64,
    pub token_id: Uuid,
    pub ts: DateTime<Utc>,
    pub action: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct FeatureFlag {
    pub key: String,
    pub description: String,
    pub default_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Admin payload to create OR update a flag. Re-issuing for the
/// same key bumps description and / or default. Idempotent so the
/// CLI does not need a separate "edit" path.
#[derive(Debug, Deserialize)]
pub struct UpsertFlag {
    pub key: String,
    #[serde(default)]
    pub description: Option<String>,
    pub default_enabled: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct FeatureFlagOverride {
    pub flag_key: String,
    pub user_id: Uuid,
    pub enabled: bool,
    pub set_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertFlagOverride {
    pub user_id: Uuid,
    pub enabled: bool,
}

/// One row per flag, summarising the override count for the admin
/// list. The dashboard uses `default_enabled` together with the
/// override count to colour-code "rollout in progress" vs "closed"
/// vs "open to all".
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct FeatureFlagSummary {
    pub key: String,
    pub description: String,
    pub default_enabled: bool,
    pub override_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One shareable devserver the owner has declared. `devserver_id` is
/// the lowercase hex SHA-256 of the owner's PAT (produced by identity);
/// `label` mirrors the PAT label so the owner's list renders without a
/// second hop. The surrogate uuid is for FK joins only.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Devserver {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub label: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDevserver {
    pub devserver_id: String,
    /// Human-friendly name, mirrored from the PAT label. Optional so the
    /// grant-create auto-bootstrap path (which has no label) still works;
    /// absent or blank leaves any existing label untouched.
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct DevserverGrant {
    pub id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub grantee_email: String,
    pub grantee_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub accepted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDevserverGrant {
    pub grantee_email: String,
}

/// Binary access decision returned by the per-request gate. A grant is
/// shell-equivalent access to the exact devserver data plane.
#[derive(Debug, Serialize)]
pub struct DevserverAccess {
    pub access: bool,
}

/// One incoming share: owner's identity flattened so the dashboard
/// can render without a second hop. A grant gives the WHOLE devserver,
/// so the share is keyed on the devserver, not a single workspace.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct IncomingShare {
    pub grant_id: Uuid,
    pub owner_user_id: Uuid,
    pub owner_username: String,
    pub owner_display_name: Option<String>,
    pub owner_avatar_url: Option<String>,
    pub devserver_id: String,
    pub label: String,
    pub accepted_at: DateTime<Utc>,
}

/// One devserver the owner has configured shares on. `grant_count` is
/// the number of (active) grants on it; the SPA pairs this with the
/// live-tunnel list from devserver-proxy admin to surface online /
/// offline status for a devserver that has shares but no live
/// registration.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct OwnedDevserverSummary {
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub label: String,
    pub grant_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct ClaimGrantsRequest {
    /// Verified OAuth emails the caller wants to claim against.
    /// identity-service supplies the union of users.email and
    /// identities.email for the signing-in user; profile fills any
    /// pending grant whose grantee_email matches any of them.
    pub emails: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ClaimGrantsResponse {
    pub claimed: i64,
}

/// Durable product policy for one user's devserver access. The deployment's
/// fleet safety ceiling remains authoritative when it is lower.
#[derive(Debug, Clone, Deserialize, Serialize, sqlx::FromRow)]
pub struct DevserverUserPolicy {
    pub user_id: Uuid,
    pub enabled: bool,
    pub max_connected_devservers: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpsertDevserverUserPolicy {
    pub enabled: bool,
    pub max_connected_devservers: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, sqlx::FromRow)]
pub struct DevserverFleetPolicy {
    pub admissions_enabled: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateDevserverFleetPolicy {
    pub admissions_enabled: bool,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AdminOverview {
    pub generated_at: DateTime<Utc>,
    pub users_total: i64,
    pub users_active: i64,
    pub users_blocked: i64,
    pub users_logged_in_since: i64,
    pub login_events_since: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccessRevocation {
    pub user_id: Uuid,
    pub username: String,
    pub pats_revoked: i64,
}
