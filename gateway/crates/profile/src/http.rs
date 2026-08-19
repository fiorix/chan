use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use gateway_common::devserver_control_client::DevserverControlClient;
use gateway_common::validators::{valid_username, MAX_USERNAME_EDITS};
use serde::Deserialize;
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::models::{
    AccessRevocation, AdminChangeEmail, AdminOverview, AdminToken, AdminTokenAudit, AuthAudit,
    BlockUser, ClaimGrantsRequest, ClaimGrantsResponse, CreateAuthAudit, CreateDevserver,
    CreateDevserverGrant, CreateIdentity, CreateUser, Devserver, DevserverAccess,
    DevserverFleetPolicy, DevserverGrant, DevserverUserPolicy, FeatureFlag, FeatureFlagOverride,
    FeatureFlagSummary, Identity, IncomingShare, OwnedDevserverSummary, UpdateDevserverFleetPolicy,
    UpdateUser, UpdateUsername, UpsertByIdentity, UpsertDevserverUserPolicy, UpsertFlag,
    UpsertFlagOverride, UpsertResponse, User,
};

/// Single source of truth for the column list returned for `users`
/// rows, both bare and with a table alias prefix.
const USER_COLS: &str =
    "id, email, display_name, username, username_edits, created_at, updated_at, \
     blocked_at, block_reason, avatar_url";

/// Protects API and controller allocations from an operator typo while leaving
/// the deployment's lower safety ceiling authoritative at admission.
pub const MAX_CONNECTED_DEVSERVERS_POLICY: i32 = 1_000_000;

fn user_cols_prefixed(alias: &str) -> String {
    USER_COLS
        .split(", ")
        .map(|c| format!("{alias}.{c}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A devserver id is the lowercase hex SHA-256 of the owner's PAT:
/// exactly 64 chars of `[0-9a-f]`. identity-service produces it (it
/// holds the raw token); profile re-checks the shape so a malformed
/// path segment is a clean 400 rather than a silent no-match that
/// reads like "no access". Caller lowercases + trims before passing in.
fn valid_devserver_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Lightweight: non-empty, contains `@`, no whitespace, sane length.
/// Provider-issued emails go through the provider's own verification;
/// this catches obvious typos before we burn an INSERT.
fn valid_email(s: &str) -> bool {
    let len = s.len();
    (3..=254).contains(&len) && s.contains('@') && !s.chars().any(char::is_whitespace)
}

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub auth_token: String,
    /// Optional admin bearer; `None` makes every `/v1/admin/*`
    /// route 401, which is the safe default if the env var was
    /// forgotten on a fresh deploy.
    pub admin_token: Option<String>,
    /// Scope-specific devserver-control client used for block and grant
    /// revocation. Its configuration is mandatory at startup.
    pub workspace_admin: DevserverControlClient,
    pub revocations: crate::revocation::RevocationCoordinator,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/v1/users", post(create_user))
        .route(
            "/v1/users/{id}",
            get(get_user).patch(update_user).delete(delete_user),
        )
        .route(
            "/v1/users/{id}/pending-delete",
            post(mark_user_pending_delete),
        )
        .route(
            "/v1/users/{id}/tokens/{token_id}/revoke",
            post(revoke_user_token),
        )
        .route("/v1/users/{id}/username", patch(update_username))
        .route("/v1/users/by-identity", get(get_user_by_identity))
        .route("/v1/users/by-username", get(get_user_by_username))
        .route(
            "/v1/users/upsert-by-identity",
            post(upsert_user_by_identity),
        )
        .route("/v1/users/{id}/identities", post(create_identity))
        .route(
            "/v1/users/{owner_id}/devservers",
            get(list_devservers).post(create_devserver),
        )
        .route(
            "/v1/users/{owner_id}/devservers/{devserver_id}",
            axum::routing::delete(delete_devserver),
        )
        .route(
            "/v1/users/{owner_id}/devservers/{devserver_id}/grants",
            get(list_devserver_grants).post(create_devserver_grant),
        )
        .route(
            "/v1/users/{owner_id}/devservers/{devserver_id}/access",
            get(devserver_access),
        )
        .route(
            "/v1/users/{owner_id}/grants/{id}",
            axum::routing::delete(delete_devserver_grant),
        )
        .route("/v1/users/{id}/grants/owned", get(list_owned_devservers))
        .route("/v1/users/{id}/grants/incoming", get(list_incoming_shares))
        .route("/v1/users/{id}/grants/claim", post(claim_grants))
        .route("/v1/users/{id}/flags", get(get_user_flags))
        .route("/v1/auth-audit", post(write_auth_audit))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));

    let admin = Router::new()
        .route("/v1/admin/users", get(admin_list_users))
        .route("/v1/admin/users/{id}/block", post(admin_block_user))
        .route("/v1/admin/users/{id}/unblock", post(admin_unblock_user))
        .route("/v1/admin/users/{id}/email", post(admin_change_email))
        .route(
            "/v1/admin/users/{id}/access/revoke",
            post(admin_revoke_user_access),
        )
        .route(
            "/v1/admin/users/{id}/devserver-policy",
            get(admin_get_user_policy).put(admin_put_user_policy),
        )
        .route("/v1/admin/users/{id}/auth-audit", get(admin_user_audit))
        .route("/v1/admin/users/{id}/tokens", get(admin_user_tokens))
        .route("/v1/admin/tokens/{id}/revoke", post(admin_revoke_token))
        .route("/v1/admin/tokens/{id}/audit", get(admin_token_audit))
        .route(
            "/v1/admin/devserver-policy",
            get(admin_get_fleet_policy).put(admin_put_fleet_policy),
        )
        .route("/v1/admin/auth-audit", get(admin_auth_audit))
        .route("/v1/admin/overview", get(admin_overview))
        .route(
            "/v1/admin/flags",
            get(admin_list_flags).post(admin_upsert_flag),
        )
        .route(
            "/v1/admin/flags/{key}",
            axum::routing::delete(admin_delete_flag),
        )
        .route(
            "/v1/admin/flags/{key}/overrides",
            get(admin_list_flag_overrides).post(admin_upsert_flag_override),
        )
        .route(
            "/v1/admin/flags/{key}/overrides/{user_id}",
            axum::routing::delete(admin_delete_flag_override),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), admin_auth));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(api)
        .merge(admin)
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

/// Constant-time byte equality for bearer comparison. Length
/// inequality short-circuits to false; this leaks the *length*
/// (cheap, low value) but not any byte of the secret.
fn bearer_eq(provided: &str, expected: &str) -> bool {
    provided.as_bytes().ct_eq(expected.as_bytes()).into()
}

async fn auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> std::result::Result<axum::response::Response, Error> {
    let ok = match bearer(&headers) {
        Some(t) => {
            // Both checks always run so a wrong token never short-
            // circuits on the first byte -- the admin token is
            // privileged so anything the regular auth token can do,
            // the admin token can also do (lets the CLI hold one
            // secret instead of two).
            let regular = bearer_eq(t, &state.auth_token);
            let admin = state
                .admin_token
                .as_deref()
                .is_some_and(|a| bearer_eq(t, a));
            regular | admin
        }
        None => false,
    };
    if ok {
        Ok(next.run(request).await)
    } else {
        Err(Error::Unauthorized)
    }
}

async fn admin_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> std::result::Result<axum::response::Response, Error> {
    let admin = state.admin_token.as_deref().ok_or(Error::Unauthorized)?;
    match bearer(&headers) {
        Some(t) if bearer_eq(t, admin) => Ok(next.run(request).await),
        _ => Err(Error::Unauthorized),
    }
}

async fn healthz() -> &'static str {
    "ok"
}

async fn create_user(
    State(state): State<AppState>,
    Json(body): Json<CreateUser>,
) -> Result<(StatusCode, Json<User>)> {
    let email = body.email.trim();
    if email.is_empty() {
        return Err(Error::BadRequest("email required".into()));
    }
    // Seed a deterministic placeholder handle from the freshly
    // generated row id. Same shape as the 0003 backfill so users
    // upgraded across migrations look uniform. Caller (identity-
    // service) renames it on first sign-in.
    let user = sqlx::query_as::<_, User>(&format!(
        "WITH new AS (SELECT gen_random_uuid() AS id) \
         INSERT INTO users (id, email, display_name, username, avatar_url) \
         SELECT new.id, $1, $2, 'u' || substr(replace(new.id::text, '-', ''), 1, 12), $3 \
         FROM new \
         RETURNING {USER_COLS}",
    ))
    .bind(email)
    .bind(body.display_name.as_deref())
    .bind(body.avatar_url.as_deref())
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(user)))
}

async fn get_user(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Json<User>> {
    let user = sqlx::query_as::<_, User>(&format!("SELECT {USER_COLS} FROM users WHERE id = $1",))
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(Error::NotFound)?;
    Ok(Json(user))
}

/// Service-bearer-authenticated user mutation. Intentionally narrow:
/// only fields safe for unverified rewrite (display name, avatar
/// URL). Email is excluded because it is the identity-linking key
/// for branch (b) of `upsert_by_identity` and rewriting it would
/// pivot account ownership to any account whose verified OAuth email
/// matched the new value. Email mutation lives behind the admin
/// bearer on `POST /v1/admin/users/{id}/email`.
async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateUser>,
) -> Result<Json<User>> {
    if body.display_name.is_none() && body.avatar_url.is_none() {
        return Err(Error::BadRequest("nothing to update".into()));
    }
    let user = sqlx::query_as::<_, User>(&format!(
        "UPDATE users \
         SET display_name = COALESCE($2, display_name), \
             avatar_url = COALESCE($3, avatar_url), \
             updated_at = now() \
         WHERE id = $1 \
         RETURNING {USER_COLS}",
    ))
    .bind(id)
    .bind(body.display_name.as_deref())
    .bind(body.avatar_url.as_deref())
    .fetch_optional(&state.pool)
    .await?
    .ok_or(Error::NotFound)?;
    Ok(Json(user))
}

async fn delete_user(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<StatusCode> {
    begin_user_delete(&state, id).await
}

/// Establish the local denial state required before identity can acknowledge
/// an asynchronous account deletion. This transaction blocks every new
/// authorization and revokes every PAT while leaving the user row in place
/// until devserver-control confirms the live data plane is gone.
async fn mark_user_pending_delete(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    begin_user_delete(&state, id).await
}

async fn begin_user_delete(state: &AppState, id: Uuid) -> Result<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE users \
         SET blocked_at = COALESCE(blocked_at, now()), \
             block_reason = 'account deletion pending', \
             updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() \
         WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO auth_audit (user_id, action, note) \
         VALUES ($1, 'account_delete_pending', 'awaiting data-plane revocation')",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    crate::revocation::reserve_tx(
        &mut tx,
        &crate::revocation::RevocationJob::AccountDelete(id),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeUserToken {
    ip: Option<String>,
    user_agent: Option<String>,
}

/// Identity-service PAT revocation boundary. Profile owns both the token row
/// and revocation outbox, so ownership verification, local denial, audit, and
/// durable first-cut reservation commit atomically.
async fn revoke_user_token(
    State(state): State<AppState>,
    Path((id, token_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<RevokeUserToken>,
) -> Result<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let active = sqlx::query_scalar::<_, bool>(
        "SELECT revoked_at IS NULL FROM api_tokens \
         WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(token_id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if active {
        sqlx::query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1")
            .bind(token_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO api_token_audit (token_id, action, ip, user_agent) \
             VALUES ($1, 'revoked', $2, $3)",
        )
        .bind(token_id)
        .bind(body.ip.as_deref())
        .bind(body.user_agent.as_deref())
        .execute(&mut *tx)
        .await?;
    }
    crate::revocation::reserve_tx(&mut tx, &crate::revocation::RevocationJob::Subject(id)).await?;
    tx.commit().await?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct ByIdentity {
    provider: String,
    subject: String,
}

#[derive(Debug, Deserialize)]
struct ByUsername {
    u: String,
}

/// Resolve `username -> User`. Used by identity-service in the share
/// landing flow where the URL carries the owner's handle, not their
/// uuid. Case-insensitive match (usernames are stored lowercase per
/// the `update_username` CAS).
async fn get_user_by_username(
    State(state): State<AppState>,
    Query(q): Query<ByUsername>,
) -> Result<Json<User>> {
    let name = q.u.trim().to_ascii_lowercase();
    if name.is_empty() {
        return Err(Error::BadRequest("username required".into()));
    }
    let user = sqlx::query_as::<_, User>(&format!(
        "SELECT {USER_COLS} FROM users WHERE lower(username) = $1",
    ))
    .bind(&name)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(Error::NotFound)?;
    Ok(Json(user))
}

async fn get_user_by_identity(
    State(state): State<AppState>,
    Query(q): Query<ByIdentity>,
) -> Result<Json<User>> {
    let user = sqlx::query_as::<_, User>(&format!(
        "SELECT {} \
         FROM users u JOIN identities i ON i.user_id = u.id \
         WHERE i.provider = $1 AND i.provider_subject = $2",
        user_cols_prefixed("u"),
    ))
    .bind(&q.provider)
    .bind(&q.subject)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(Error::NotFound)?;
    Ok(Json(user))
}

async fn create_identity(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
    Json(body): Json<CreateIdentity>,
) -> Result<(StatusCode, Json<Identity>)> {
    if body.provider.trim().is_empty() || body.provider_subject.trim().is_empty() {
        return Err(Error::BadRequest(
            "provider and provider_subject required".into(),
        ));
    }
    // Ensure the parent user exists. Without this, FK-violation surfaces as a
    // generic 500 instead of a clean 404 for the by-id route.
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
    if !exists {
        return Err(Error::NotFound);
    }

    let identity = sqlx::query_as::<_, Identity>(
        "INSERT INTO identities (user_id, provider, provider_subject, email) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id, user_id, provider, provider_subject, email, created_at",
    )
    .bind(user_id)
    .bind(&body.provider)
    .bind(&body.provider_subject)
    .bind(body.email.as_deref())
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(identity)))
}

/// Single-tx find-or-create. Three branches:
///
/// (a) `(provider, provider_subject)` already linked: return that
///     user; refresh `avatar_url` if a new one was supplied and
///     differs.
/// (b) Identity not linked yet, but `email` matches an existing
///     user (case-insensitive): insert the identity row pointing at
///     that user. This is the "I signed in with GitHub last time
///     and Google this time, same verified email" flow.
/// (c) Neither: create a new user (with deterministic placeholder
///     username) plus its identity row, both in one tx.
///
/// Concurrent first-time signups can race (`UNIQUE(email)` or
/// `UNIQUE(provider, subject)` collisions). We retry on 23505 up to
/// twice; the retry hits branch (a) or (b) and converges.
async fn upsert_user_by_identity(
    State(state): State<AppState>,
    Json(body): Json<UpsertByIdentity>,
) -> Result<Json<UpsertResponse>> {
    if body.provider.trim().is_empty() || body.provider_subject.trim().is_empty() {
        return Err(Error::BadRequest(
            "provider and provider_subject required".into(),
        ));
    }
    let email = body
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let display_name = body.display_name.as_deref();
    let avatar_url = body.avatar_url.as_deref();

    // Up to 3 attempts: each contention loser observes the winner's
    // committed state on the next pass. Two retries is enough to
    // cover the worst case (both unique constraints racing).
    for attempt in 0..3 {
        match try_upsert_once(
            &state.pool,
            &body.provider,
            &body.provider_subject,
            email,
            display_name,
            avatar_url,
        )
        .await
        {
            Ok(resp) => return Ok(Json(resp)),
            Err(Error::Db(e)) if attempt < 2 && is_unique_violation(&e) => {
                tracing::debug!(attempt, "upsert_by_identity hit 23505, retrying");
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(Error::Conflict("upsert: too many retries"))
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error().and_then(|d| d.code()).as_deref() == Some("23505")
}

async fn try_upsert_once(
    pool: &PgPool,
    provider: &str,
    provider_subject: &str,
    email: Option<&str>,
    display_name: Option<&str>,
    avatar_url: Option<&str>,
) -> Result<UpsertResponse> {
    let mut tx = pool.begin().await?;

    // (a) Identity already linked.
    let existing: Option<User> = sqlx::query_as(&format!(
        "SELECT {} FROM users u \
         JOIN identities i ON i.user_id = u.id \
         WHERE i.provider = $1 AND i.provider_subject = $2",
        user_cols_prefixed("u"),
    ))
    .bind(provider)
    .bind(provider_subject)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(mut user) = existing {
        if let Some(new_pic) = avatar_url {
            if user.avatar_url.as_deref() != Some(new_pic) {
                user = sqlx::query_as::<_, User>(&format!(
                    "UPDATE users SET avatar_url = $2, updated_at = now() \
                     WHERE id = $1 RETURNING {USER_COLS}",
                ))
                .bind(user.id)
                .bind(new_pic)
                .fetch_one(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        return Ok(UpsertResponse {
            user,
            user_created: false,
            identity_created: false,
        });
    }

    // (b) and (c) require email -- users.email is NOT NULL.
    let Some(email) = email else {
        return Err(Error::BadRequest(
            "provider returned no email; cannot create account".into(),
        ));
    };

    let by_email: Option<User> = sqlx::query_as(&format!(
        "SELECT {USER_COLS} FROM users WHERE lower(email) = lower($1)",
    ))
    .bind(email)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(user) = by_email {
        // (b) Attach this provider to the existing user.
        sqlx::query(
            "INSERT INTO identities (user_id, provider, provider_subject, email) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(user.id)
        .bind(provider)
        .bind(provider_subject)
        .bind(email)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(UpsertResponse {
            user,
            user_created: false,
            identity_created: true,
        });
    }

    // (c) Brand-new user. Insert user (deterministic placeholder
    // username from the row's freshly-generated uuid), then the
    // identity row, both in this tx.
    let user = sqlx::query_as::<_, User>(&format!(
        "WITH new AS (SELECT gen_random_uuid() AS id) \
         INSERT INTO users (id, email, display_name, username, avatar_url) \
         SELECT new.id, $1, $2, 'u' || substr(replace(new.id::text, '-', ''), 1, 12), $3 \
         FROM new \
         RETURNING {USER_COLS}",
    ))
    .bind(email)
    .bind(display_name)
    .bind(avatar_url)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO identities (user_id, provider, provider_subject, email) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(user.id)
    .bind(provider)
    .bind(provider_subject)
    .bind(email)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(UpsertResponse {
        user,
        user_created: true,
        identity_created: true,
    })
}

/// Atomic rename: format + uniqueness (lowercase) + per-user edit cap
/// resolved in one statement. The CTE returns one row: the freshly
/// renamed user when the cap permits and the name changed, or the
/// existing row unchanged when the caller asked for their current
/// handle (no-op success without burning an edit), or zero rows when
/// the cap is exhausted or the user is missing. One follow-up SELECT
/// distinguishes "cap reached" from "not found" in the zero-rows
/// case. Folding the CAS and the no-op detection into one statement
/// is what closes the TOCTOU window a separate diagnostic SELECT
/// would open.
async fn update_username(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateUsername>,
) -> Result<Json<User>> {
    let new = body.username.trim().to_ascii_lowercase();
    if !valid_username(&new) {
        return Err(Error::BadRequest("invalid username".into()));
    }

    // The unique index on lower(username) raises 23505 -> Conflict on
    // collision; we let the shared `From<sqlx::Error>` mapper handle
    // that. The CTE itself only fires UPDATE when the new value is
    // distinct from the current one, so the no-op rename branch never
    // touches the unique index.
    let res = sqlx::query_as::<_, User>(&format!(
        "WITH \
            current AS ( \
                SELECT id, lower(username) AS handle, username_edits \
                FROM users WHERE id = $1 \
            ), \
            renamed AS ( \
                UPDATE users \
                SET username = $2, \
                    username_edits = username_edits + 1, \
                    updated_at = now() \
                WHERE id = $1 \
                  AND id IN ( \
                      SELECT id FROM current \
                      WHERE username_edits < $3 AND handle <> $2 \
                  ) \
                RETURNING {USER_COLS} \
            ) \
         SELECT * FROM renamed \
         UNION ALL \
         SELECT {USER_COLS} FROM users \
         WHERE id = $1 AND lower(username) = $2 \
           AND NOT EXISTS (SELECT 1 FROM renamed)",
    ))
    .bind(id)
    .bind(&new)
    .bind(MAX_USERNAME_EDITS)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(user) = res {
        return Ok(Json(user));
    }

    // Zero rows: either the user doesn't exist or the cap is hit.
    let row = sqlx::query_scalar::<_, i32>("SELECT username_edits FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(Error::NotFound)?;
    if row >= MAX_USERNAME_EDITS {
        return Err(Error::Conflict("rename limit reached"));
    }
    Err(Error::Conflict("rename failed"))
}

/// Identity calls this on login / logout / login_denied. The audit
/// table is owned by profile so the `/v1/admin/*` reader doesn't
/// have to cross-service to render the user audit view.
async fn write_auth_audit(
    State(state): State<AppState>,
    Json(body): Json<CreateAuthAudit>,
) -> Result<StatusCode> {
    let action = body.action.trim();
    if action.is_empty() || action.len() > 32 {
        return Err(Error::BadRequest("invalid action".into()));
    }
    let res = sqlx::query(
        "INSERT INTO auth_audit (user_id, action, ip, user_agent, note) \
         SELECT $1, $2, $3, $4, $5 \
         WHERE EXISTS(SELECT 1 FROM users WHERE id = $1)",
    )
    .bind(body.user_id)
    .bind(action)
    .bind(body.ip.as_deref())
    .bind(body.user_agent.as_deref())
    .bind(body.note.as_deref())
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct ListUsersQuery {
    /// Substring match against email (case-insensitive).
    email: Option<String>,
    /// Exact match against username (case-insensitive).
    username: Option<String>,
    /// `true`/`false` to filter; absent = all.
    blocked: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn admin_list_users(
    State(state): State<AppState>,
    Query(q): Query<ListUsersQuery>,
) -> Result<Json<Vec<User>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let offset = q.offset.unwrap_or(0).max(0);
    let email = q.email.as_deref().map(|s| s.to_ascii_lowercase());
    let username = q.username.as_deref().map(|s| s.to_ascii_lowercase());

    let rows = sqlx::query_as::<_, User>(&format!(
        "SELECT {USER_COLS} FROM users \
         WHERE ($1::text IS NULL OR position($1 in lower(email)) > 0) \
           AND ($2::text IS NULL OR lower(username) = $2) \
           AND ($3::bool IS NULL \
                OR ($3 = true  AND blocked_at IS NOT NULL) \
                OR ($3 = false AND blocked_at IS NULL)) \
         ORDER BY created_at DESC \
         LIMIT $4 OFFSET $5",
    ))
    .bind(email)
    .bind(username)
    .bind(q.blocked)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn admin_get_user_policy(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<DevserverUserPolicy>> {
    let policy = sqlx::query_as::<_, DevserverUserPolicy>(
        "SELECT user_id, enabled, max_connected_devservers, updated_at \
         FROM devserver_user_policies WHERE user_id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(Error::NotFound)?;
    Ok(Json(policy))
}

async fn admin_put_user_policy(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpsertDevserverUserPolicy>,
) -> Result<Json<DevserverUserPolicy>> {
    if !(1..=MAX_CONNECTED_DEVSERVERS_POLICY).contains(&body.max_connected_devservers) {
        return Err(Error::BadRequest(format!(
            "max_connected_devservers must be between 1 and {MAX_CONNECTED_DEVSERVERS_POLICY}"
        )));
    }
    let policy = sqlx::query_as::<_, DevserverUserPolicy>(
        "WITH locked_user AS MATERIALIZED ( \
             SELECT id FROM users WHERE id = $1 FOR UPDATE \
         ) \
         INSERT INTO devserver_user_policies \
             (user_id, enabled, max_connected_devservers) \
         SELECT id, $2, $3 FROM locked_user \
         ON CONFLICT (user_id) DO UPDATE \
         SET enabled = EXCLUDED.enabled, \
             max_connected_devservers = EXCLUDED.max_connected_devservers, \
             updated_at = now() \
         RETURNING user_id, enabled, max_connected_devservers, updated_at",
    )
    .bind(id)
    .bind(body.enabled)
    .bind(body.max_connected_devservers)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(Error::NotFound)?;
    Ok(Json(policy))
}

async fn admin_get_fleet_policy(
    State(state): State<AppState>,
) -> Result<Json<DevserverFleetPolicy>> {
    let policy = sqlx::query_as::<_, DevserverFleetPolicy>(
        "SELECT admissions_enabled, updated_at \
         FROM devserver_fleet_policy WHERE singleton = true",
    )
    .fetch_optional(&state.pool)
    .await?
    .ok_or(Error::Unavailable("fleet policy is unavailable"))?;
    Ok(Json(policy))
}

async fn admin_put_fleet_policy(
    State(state): State<AppState>,
    Json(body): Json<UpdateDevserverFleetPolicy>,
) -> Result<Json<DevserverFleetPolicy>> {
    let policy = sqlx::query_as::<_, DevserverFleetPolicy>(
        "INSERT INTO devserver_fleet_policy (singleton, admissions_enabled) \
         VALUES (true, $1) \
         ON CONFLICT (singleton) DO UPDATE \
         SET admissions_enabled = EXCLUDED.admissions_enabled, updated_at = now() \
         RETURNING admissions_enabled, updated_at",
    )
    .bind(body.admissions_enabled)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(policy))
}

#[derive(Debug, Deserialize)]
struct GlobalAuditQuery {
    user_id: Option<Uuid>,
    action: Option<String>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn admin_auth_audit(
    State(state): State<AppState>,
    Query(q): Query<GlobalAuditQuery>,
) -> Result<Json<Vec<AuthAudit>>> {
    let limit = q.limit.unwrap_or(100);
    let offset = q.offset.unwrap_or(0);
    if !(1..=500).contains(&limit) {
        return Err(Error::BadRequest("limit must be between 1 and 500".into()));
    }
    if offset < 0 {
        return Err(Error::BadRequest("offset must be non-negative".into()));
    }
    if q.action.as_deref().is_some_and(str::is_empty) {
        return Err(Error::BadRequest("action must not be empty".into()));
    }
    if q.since
        .zip(q.until)
        .is_some_and(|(since, until)| since > until)
    {
        return Err(Error::BadRequest("since must not be after until".into()));
    }
    let rows = sqlx::query_as::<_, AuthAudit>(
        "SELECT id, user_id, ts, action, ip, user_agent, note \
         FROM auth_audit \
         WHERE ($1::uuid IS NULL OR user_id = $1) \
           AND ($2::text IS NULL OR action = $2) \
           AND ($3::timestamptz IS NULL OR ts >= $3) \
           AND ($4::timestamptz IS NULL OR ts <= $4) \
         ORDER BY ts DESC, id DESC \
         LIMIT $5 OFFSET $6",
    )
    .bind(q.user_id)
    .bind(q.action)
    .bind(q.since)
    .bind(q.until)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct OverviewQuery {
    since: DateTime<Utc>,
}

async fn admin_overview(
    State(state): State<AppState>,
    Query(q): Query<OverviewQuery>,
) -> Result<Json<AdminOverview>> {
    let overview = sqlx::query_as::<_, AdminOverview>(
        "SELECT now() AS generated_at, \
                COUNT(*)::bigint AS users_total, \
                COUNT(*) FILTER (WHERE blocked_at IS NULL)::bigint AS users_active, \
                COUNT(*) FILTER (WHERE blocked_at IS NOT NULL)::bigint AS users_blocked, \
                (SELECT COUNT(DISTINCT user_id)::bigint FROM auth_audit \
                 WHERE action = 'login' AND ts >= $1) AS users_logged_in_since, \
                (SELECT COUNT(*)::bigint FROM auth_audit \
                 WHERE action = 'login' AND ts >= $1) AS login_events_since \
         FROM users",
    )
    .bind(q.since)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(overview))
}

/// Set blocked_at if not already set, stash the reason, revoke
/// every active token, and write one auth_audit row. Single tx so
/// the CLI sees an atomic state change.
async fn admin_block_user(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<BlockUser>,
) -> Result<(StatusCode, Json<User>)> {
    let mut tx = state.pool.begin().await?;

    let user = sqlx::query_as::<_, User>(&format!(
        "UPDATE users \
         SET blocked_at = COALESCE(blocked_at, now()), \
             block_reason = $2, \
             updated_at = now() \
         WHERE id = $1 \
         RETURNING {USER_COLS}",
    ))
    .bind(id)
    .bind(body.reason.as_deref())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;

    // Auto-revoke every active token. Per-token audit rows are
    // skipped: the auth_audit 'blocked' entry is the canonical
    // event for the action and the per-token log would just
    // duplicate it N times.
    sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() \
         WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO auth_audit (user_id, action, note) VALUES ($1, 'blocked', $2)")
        .bind(id)
        .bind(body.reason.as_deref())
        .execute(&mut *tx)
        .await?;
    crate::revocation::reserve_tx(&mut tx, &crate::revocation::RevocationJob::Subject(id)).await?;

    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(user)))
}

async fn admin_revoke_user_access(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<AccessRevocation>> {
    let mut tx = state.pool.begin().await?;
    let username =
        sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?;
    let pats_revoked = sqlx::query(
        "UPDATE api_tokens SET revoked_at = now() \
         WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected() as i64;
    let prior = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM auth_audit \
         WHERE user_id = $1 AND action = 'access_revoked')",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if pats_revoked > 0 || !prior {
        sqlx::query(
            "INSERT INTO auth_audit (user_id, action, note) \
             VALUES ($1, 'access_revoked', 'admin access cut')",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(AccessRevocation {
        user_id: id,
        username,
        pats_revoked,
    }))
}

/// Admin-only: rewrite a user's email. Records the change in
/// `auth_audit` with the old address in the note so the operator
/// audit trail captures the pivot point. Conflicts on the unique
/// index map to 409 via the shared `From<sqlx::Error>` handler.
async fn admin_change_email(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<AdminChangeEmail>,
) -> Result<Json<User>> {
    let new_email = body.email.trim();
    if !valid_email(new_email) {
        return Err(Error::BadRequest("invalid email".into()));
    }
    let mut tx = state.pool.begin().await?;
    let old: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let old = old.ok_or(Error::NotFound)?;
    let user = sqlx::query_as::<_, User>(&format!(
        "UPDATE users SET email = $2, updated_at = now() \
         WHERE id = $1 \
         RETURNING {USER_COLS}",
    ))
    .bind(id)
    .bind(new_email)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO auth_audit (user_id, action, note) \
         VALUES ($1, 'email_changed', $2)",
    )
    .bind(id)
    .bind(format!("old={old} new={new_email}"))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(user))
}

async fn admin_unblock_user(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<User>> {
    let mut tx = state.pool.begin().await?;
    let exists = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(Error::NotFound);
    }
    let deletion_pending = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM control_revocation_jobs \
         WHERE job_key = $1 AND kind = 'account_delete')",
    )
    .bind(format!("subject:{id}"))
    .fetch_one(&mut *tx)
    .await?;
    if deletion_pending {
        return Err(Error::Conflict("account deletion is pending"));
    }
    let user = sqlx::query_as::<_, User>(&format!(
        "UPDATE users \
         SET blocked_at = NULL, block_reason = NULL, updated_at = now() \
         WHERE id = $1 \
         RETURNING {USER_COLS}",
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;

    sqlx::query("INSERT INTO auth_audit (user_id, action) VALUES ($1, 'unblocked')")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(user))
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    limit: Option<i64>,
}

async fn admin_user_audit(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<AuthAudit>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows = sqlx::query_as::<_, AuthAudit>(
        "SELECT id, user_id, ts, action, ip, user_agent, note \
         FROM auth_audit WHERE user_id = $1 ORDER BY ts DESC LIMIT $2",
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn admin_user_tokens(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<AdminToken>>> {
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows = sqlx::query_as::<_, AdminToken>(
        "SELECT id, user_id, label, expires_at, created_at, revoked_at, last_used_at \
         FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Soft-revoke any non-revoked token, from the operator surface. The
/// audit row says `revoked_via_admin` so the owner's token audit does
/// not attribute an operator's action to them. Answers 202: the local
/// denial is committed but the subject-revocation outbox still settles
/// the data plane. An already-revoked token re-reserves that settlement
/// without a duplicate audit row, so a CLI retry doesn't error out; an
/// unknown token id 404s so the CLI flags the typo.
async fn admin_revoke_token(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let revoked_user = sqlx::query_scalar::<_, Uuid>(
        "UPDATE api_tokens SET revoked_at = now() \
         WHERE id = $1 AND revoked_at IS NULL \
         RETURNING user_id",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let user_id = match revoked_user {
        Some(user_id) => {
            sqlx::query(
                "INSERT INTO api_token_audit (token_id, action) \
                 VALUES ($1, 'revoked_via_admin')",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            user_id
        }
        None => sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM api_tokens WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Error::NotFound)?,
    };
    crate::revocation::reserve_tx(&mut tx, &crate::revocation::RevocationJob::Subject(user_id))
        .await?;
    tx.commit().await?;
    Ok(StatusCode::ACCEPTED)
}

/// Idempotent devserver create. Re-issuing for the same
/// (owner, devserver_id) returns the existing row at 200 OK instead of
/// 409. identity-service calls this at PAT-create time (it holds the raw
/// token to compute `devserver_id`) and again when a tunnel announces a
/// display name; the `(owner, devserver_id)` pair is the canonical key,
/// the surrogate uuid is for FK joins only. A blank / absent label on a
/// re-issue leaves the stored label untouched. A non-blank label dedups
/// within the owner's rows (`-2`, `-3`, ... suffixes) so the roster
/// never shows two identical names for one owner.
async fn create_devserver(
    State(state): State<AppState>,
    Path(owner_id): Path<Uuid>,
    Json(body): Json<CreateDevserver>,
) -> Result<(StatusCode, Json<Devserver>)> {
    let devserver_id = body.devserver_id.trim().to_ascii_lowercase();
    if !valid_devserver_id(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let label = body.label.unwrap_or_default();
    let label = label.trim();
    if label.len() > 64 {
        return Err(Error::BadRequest("label too long".into()));
    }
    let owner_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(owner_id)
            .fetch_one(&state.pool)
            .await?;
    if !owner_exists {
        return Err(Error::NotFound);
    }

    // Owner-scoped label dedup. The row's own current label is excluded
    // so a reconnect announcing the name it already holds is a no-op,
    // never a fresh suffix. No unique constraint backs the label, so
    // the dedup-then-upsert runs in one transaction under a per-owner
    // advisory lock (`pg_advisory_xact_lock`, released at commit): two
    // simultaneous first dials serialize, and the second one's taken
    // snapshot always sees the first one's committed label.
    let mut tx = state.pool.begin().await?;
    let label = if label.is_empty() {
        String::new()
    } else {
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtext('devserver_label'), hashtext($1::text))",
        )
        .bind(owner_id)
        .execute(&mut *tx)
        .await?;
        let taken: Vec<String> = sqlx::query_scalar(
            "SELECT label FROM devservers \
             WHERE owner_user_id = $1 AND devserver_id <> $2 AND label <> ''",
        )
        .bind(owner_id)
        .bind(&devserver_id)
        .fetch_all(&mut *tx)
        .await?;
        dedup_label(label, &taken)
    };

    // ON CONFLICT DO NOTHING + RETURNING returns 0 rows on hit, so
    // we follow up with an UPDATE-returning in that case. Two-step keeps
    // the INSERT happy-path single-statement.
    let inserted = sqlx::query_as::<_, Devserver>(
        "INSERT INTO devservers (owner_user_id, devserver_id, label) VALUES ($1, $2, $3) \
         ON CONFLICT (owner_user_id, devserver_id) DO NOTHING \
         RETURNING id, owner_user_id, devserver_id, label, created_at",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .bind(&label)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(d) = inserted {
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(d)));
    }
    // Existing row: refresh the label only when a non-empty one is
    // supplied so the grant-create auto-bootstrap (label-less) never
    // blanks a real name.
    let existing = sqlx::query_as::<_, Devserver>(
        "UPDATE devservers SET label = CASE WHEN $3 = '' THEN label ELSE $3 END \
         WHERE owner_user_id = $1 AND devserver_id = $2 \
         RETURNING id, owner_user_id, devserver_id, label, created_at",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .bind(&label)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::OK, Json(existing)))
}

/// First free variant of `label` against the owner's other rows'
/// labels: the label itself, else `label-2`, `label-3`, ... The base is
/// shortened (on a char boundary) when a suffix would push past the
/// 64-byte label bound, and the shortened candidate re-checks the taken
/// set, so the result always validates. Terminates: candidates differ
/// for every n, and `taken` is finite.
fn dedup_label(label: &str, taken: &[String]) -> String {
    let is_free = |candidate: &str| !taken.iter().any(|t| t == candidate);
    if is_free(label) {
        return label.to_string();
    }
    for n in 2u64.. {
        let suffix = format!("-{n}");
        let mut end = (64 - suffix.len()).min(label.len());
        while !label.is_char_boundary(end) {
            end -= 1;
        }
        let candidate = format!("{}{suffix}", &label[..end]);
        if is_free(&candidate) {
            return candidate;
        }
    }
    unreachable!("some numeric suffix is always free");
}

async fn list_devservers(
    State(state): State<AppState>,
    Path(owner_id): Path<Uuid>,
) -> Result<Json<Vec<Devserver>>> {
    let rows = sqlx::query_as::<_, Devserver>(
        "SELECT id, owner_user_id, devserver_id, label, created_at \
         FROM devservers WHERE owner_user_id = $1 \
         ORDER BY devserver_id",
    )
    .bind(owner_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Drop an unshared devserver registry row. Shared rows must have each grant
/// removed through the exact-revocation settlement path first; silently
/// cascading a grant would leave its one-hour proxy session authorized.
async fn delete_devserver(
    State(state): State<AppState>,
    Path((owner_id, devserver_id)): Path<(Uuid, String)>,
) -> Result<StatusCode> {
    let devserver_id = devserver_id.trim().to_ascii_lowercase();
    if !valid_devserver_id(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let res = sqlx::query(
        "DELETE FROM devservers d \
         WHERE owner_user_id = $1 AND devserver_id = $2 \
           AND NOT EXISTS (SELECT 1 FROM devserver_grants g \
                           WHERE g.owner_user_id = d.owner_user_id \
                             AND g.devserver_id = d.devserver_id)",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM devservers WHERE owner_user_id = $1 AND devserver_id = $2)",
        )
        .bind(owner_id)
        .bind(&devserver_id)
        .fetch_one(&state.pool)
        .await?;
        return if exists {
            Err(Error::Conflict("remove devserver grants first"))
        } else {
            Err(Error::NotFound)
        };
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Idempotent grant create. Re-adding the same email on the same
/// (owner, devserver) returns the existing binary access row.
///
/// grantee_user_id resolution: best-effort at insert time (matches
/// the common case where the recipient already has an account).
/// Late signups are picked up by `claim_grants` on the next OAuth
/// callback.
async fn create_devserver_grant(
    State(state): State<AppState>,
    Path((owner_id, devserver_id)): Path<(Uuid, String)>,
    Json(body): Json<CreateDevserverGrant>,
) -> Result<(StatusCode, Json<DevserverGrant>)> {
    let devserver_id = devserver_id.trim().to_ascii_lowercase();
    if !valid_devserver_id(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let email = body.grantee_email.trim();
    if !valid_email(email) {
        return Err(Error::BadRequest("invalid email".into()));
    }
    let owner_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(owner_id)
            .fetch_one(&state.pool)
            .await?;
    if !owner_exists {
        return Err(Error::NotFound);
    }

    let mut tx = state.pool.begin().await?;

    // Ensure the parent `devservers` row exists. The FK from
    // devserver_grants requires it; auto-creating here keeps the grant
    // API ergonomic (callers don't have to bootstrap the devserver row
    // in a separate hop) and is idempotent. Label is left at the default
    // here; identity sets a real one at PAT-create time.
    sqlx::query(
        "INSERT INTO devservers (owner_user_id, devserver_id) VALUES ($1, $2) \
         ON CONFLICT (owner_user_id, devserver_id) DO NOTHING",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .execute(&mut *tx)
    .await?;

    let grantee_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = lower($1)")
            .bind(email)
            .fetch_optional(&mut *tx)
            .await?;

    let row = sqlx::query_as::<_, DevserverGrant>(
        "INSERT INTO devserver_grants \
             (owner_user_id, devserver_id, grantee_email, grantee_user_id, accepted_at) \
         VALUES ($1, $2, $3, $4, \
                 CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END) \
         ON CONFLICT (owner_user_id, devserver_id, lower(grantee_email)) DO UPDATE SET \
             grantee_user_id = COALESCE(devserver_grants.grantee_user_id, EXCLUDED.grantee_user_id), \
             accepted_at = COALESCE(devserver_grants.accepted_at, EXCLUDED.accepted_at) \
         RETURNING id, owner_user_id, devserver_id, grantee_email, grantee_user_id, \
                   created_at, accepted_at",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .bind(email)
    .bind(grantee_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn list_devserver_grants(
    State(state): State<AppState>,
    Path((owner_id, devserver_id)): Path<(Uuid, String)>,
) -> Result<Json<Vec<DevserverGrant>>> {
    let devserver_id = devserver_id.trim().to_ascii_lowercase();
    if !valid_devserver_id(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let rows = sqlx::query_as::<_, DevserverGrant>(
        "SELECT id, owner_user_id, devserver_id, grantee_email, grantee_user_id, \
                created_at, accepted_at \
         FROM devserver_grants \
         WHERE owner_user_id = $1 AND devserver_id = $2 \
         ORDER BY created_at",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Owner-scoped delete. Path carries owner_id so a bug in the calling
/// layer can't let user A revoke user B's grant by guessing its uuid.
async fn delete_devserver_grant(
    State(state): State<AppState>,
    Path((owner_id, grant_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let grant = sqlx::query_as::<_, (Option<Uuid>, Uuid, String)>(
        "SELECT grantee_user_id, owner_user_id, devserver_id \
         FROM devserver_grants WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
    )
    .bind(grant_id)
    .bind(owner_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let Some(subject_user_id) = grant.0 else {
        sqlx::query("DELETE FROM devserver_grants WHERE id = $1 AND owner_user_id = $2")
            .bind(grant_id)
            .bind(owner_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    };
    let job = crate::revocation::RevocationJob::Exact {
        subject_user_id,
        owner_user_id: grant.1,
        devserver_id: grant.2,
    };
    crate::revocation::reserve_tx(&mut tx, &job).await?;
    let deleted = sqlx::query("DELETE FROM devserver_grants WHERE id = $1 AND owner_user_id = $2")
        .bind(grant_id)
        .bind(owner_id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct AccessQuery {
    /// Caller user_id (the signed-in user we're checking access for).
    #[serde(rename = "as")]
    caller: Uuid,
}

/// Per-request access gate. identity-service calls this before minting
/// an entry JWT, with the devserver_id of the owner's live registration.
/// Returns binary access when the caller is the owner or has a claimed grant,
/// and 404 in every other case (no-grant and unknown-devserver share the
///     same shape so the endpoint can't be used to enumerate which
///     devservers a user is sharing). A grant gives the WHOLE devserver,
///     so this is the single authorization assertion the gate needs.
async fn devserver_access(
    State(state): State<AppState>,
    Path((owner_id, devserver_id)): Path<(Uuid, String)>,
    Query(q): Query<AccessQuery>,
) -> Result<Json<DevserverAccess>> {
    let devserver_id = devserver_id.trim().to_ascii_lowercase();
    if !valid_devserver_id(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let granted: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
             SELECT 1 FROM devservers d \
             WHERE d.owner_user_id = $1 AND d.devserver_id = $2 \
               AND (d.owner_user_id = $3 OR EXISTS( \
                   SELECT 1 FROM devserver_grants g \
                   WHERE g.owner_user_id = d.owner_user_id \
                     AND g.devserver_id = d.devserver_id \
                     AND g.grantee_user_id = $3 \
               )) \
         )",
    )
    .bind(owner_id)
    .bind(&devserver_id)
    .bind(q.caller)
    .fetch_one(&state.pool)
    .await?;
    granted
        .then_some(Json(DevserverAccess { access: true }))
        .ok_or(Error::NotFound)
}

/// Devservers this user owns. Paired in the SPA with the live-tunnel
/// list from devserver-proxy admin: a devserver that shows up here but
/// not in the live list is the "configured / offline" state. The grant
/// count is a LEFT JOIN aggregate, so a devserver with no grants yet
/// still surfaces (it will not let anyone in until at least one grant
/// lands, but the row exists for the dashboard).
async fn list_owned_devservers(
    State(state): State<AppState>,
    Path(owner_id): Path<Uuid>,
) -> Result<Json<Vec<OwnedDevserverSummary>>> {
    let rows = sqlx::query_as::<_, OwnedDevserverSummary>(
        "SELECT d.owner_user_id, d.devserver_id, d.label, COALESCE(g.cnt, 0)::bigint AS grant_count \
         FROM devservers d \
         LEFT JOIN ( \
             SELECT owner_user_id, devserver_id, COUNT(*) AS cnt \
             FROM devserver_grants \
             GROUP BY owner_user_id, devserver_id \
         ) g ON g.owner_user_id = d.owner_user_id AND g.devserver_id = d.devserver_id \
         WHERE d.owner_user_id = $1 \
         ORDER BY d.devserver_id",
    )
    .bind(owner_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Devservers shared *with* this user. Only includes claimed grants so a
/// pending invite (email matched but no sign-in yet -- shouldn't happen
/// for the caller themselves, but defensive) doesn't leak into the
/// dashboard. The `label` joins from the parent devserver row.
async fn list_incoming_shares(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Vec<IncomingShare>>> {
    let rows = sqlx::query_as::<_, IncomingShare>(
        "SELECT g.id AS grant_id, \
                u.id AS owner_user_id, u.username AS owner_username, \
                u.display_name AS owner_display_name, u.avatar_url AS owner_avatar_url, \
                g.devserver_id, d.label, g.accepted_at \
         FROM devserver_grants g \
         JOIN users u ON u.id = g.owner_user_id \
         JOIN devservers d ON d.owner_user_id = g.owner_user_id \
                          AND d.devserver_id = g.devserver_id \
         WHERE g.grantee_user_id = $1 AND g.accepted_at IS NOT NULL \
         ORDER BY g.accepted_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Claim sweep. identity-service calls this on OAuth callback with
/// the union of users.email + identities.email for the signing-in
/// user. Every pending row whose grantee_email lower-cases to one
/// of those values is assigned to this user_id and stamped
/// accepted_at = now(). Idempotent: rows already claimed by another
/// user are not touched (defensive guard against email reassignment
/// races between providers).
async fn claim_grants(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
    Json(body): Json<ClaimGrantsRequest>,
) -> Result<Json<ClaimGrantsResponse>> {
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let normalized: Vec<String> = body
        .emails
        .iter()
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    if normalized.is_empty() {
        return Ok(Json(ClaimGrantsResponse { claimed: 0 }));
    }
    let res = sqlx::query(
        "UPDATE devserver_grants \
         SET grantee_user_id = $1, accepted_at = now() \
         WHERE grantee_user_id IS NULL \
           AND lower(grantee_email) = ANY($2)",
    )
    .bind(user_id)
    .bind(&normalized)
    .execute(&state.pool)
    .await?;
    Ok(Json(ClaimGrantsResponse {
        claimed: res.rows_affected() as i64,
    }))
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

/// 1-64 chars, lowercase ascii alnum plus `[._-]`. Flag keys are a
/// small admin-curated set; the shape keeps them safe as map keys and
/// log fields.
fn valid_flag_key(s: &str) -> bool {
    let len = s.len();
    if !(1..=64).contains(&len) {
        return false;
    }
    s.bytes()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'.'))
}

/// Service-tier: resolve every registered flag for a single user.
/// Returns `{flag_key: bool}` so callers (identity-service /api/me,
/// devserver-proxy admin tooling) can render or gate without a second
/// hop. Unknown user is 404; unknown flag is simply absent from
/// the map.
async fn get_user_flags(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<serde_json::Map<String, serde_json::Value>>> {
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows: Vec<(String, bool)> = sqlx::query_as(
        "SELECT f.key, COALESCE(o.enabled, f.default_enabled) AS enabled \
         FROM feature_flags f \
         LEFT JOIN feature_flag_overrides o \
                ON o.flag_key = f.key AND o.user_id = $1 \
         ORDER BY f.key",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut map = serde_json::Map::new();
    for (k, v) in rows {
        map.insert(k, serde_json::Value::Bool(v));
    }
    Ok(Json(map))
}

async fn admin_list_flags(State(state): State<AppState>) -> Result<Json<Vec<FeatureFlagSummary>>> {
    let rows = sqlx::query_as::<_, FeatureFlagSummary>(
        "SELECT f.key, f.description, f.default_enabled, \
                COALESCE(o.cnt, 0)::bigint AS override_count, \
                f.created_at, f.updated_at \
         FROM feature_flags f \
         LEFT JOIN ( \
             SELECT flag_key, COUNT(*) AS cnt \
             FROM feature_flag_overrides \
             GROUP BY flag_key \
         ) o ON o.flag_key = f.key \
         ORDER BY f.key",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Idempotent: re-issuing for the same key updates the description
/// (if present) and / or default_enabled. The whole table is
/// admin-only; operators driving a rollout edit defaults in-place.
async fn admin_upsert_flag(
    State(state): State<AppState>,
    Json(body): Json<UpsertFlag>,
) -> Result<(StatusCode, Json<FeatureFlag>)> {
    let key = body.key.trim().to_ascii_lowercase();
    if !valid_flag_key(&key) {
        return Err(Error::BadRequest("invalid flag key".into()));
    }
    // ON CONFLICT DO UPDATE so the second invocation moves the
    // default. xmax = 0 on insert; we don't expose that distinction,
    // both paths return 200 OK with the canonical row.
    let row = sqlx::query_as::<_, FeatureFlag>(
        "INSERT INTO feature_flags (key, description, default_enabled) \
         VALUES ($1, COALESCE($2, ''), $3) \
         ON CONFLICT (key) DO UPDATE SET \
             description = COALESCE($2, feature_flags.description), \
             default_enabled = EXCLUDED.default_enabled, \
             updated_at = now() \
         RETURNING key, description, default_enabled, created_at, updated_at",
    )
    .bind(&key)
    .bind(body.description.as_deref())
    .bind(body.default_enabled)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::OK, Json(row)))
}

async fn admin_delete_flag(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<StatusCode> {
    let key = key.trim().to_ascii_lowercase();
    if !valid_flag_key(&key) {
        return Err(Error::BadRequest("invalid flag key".into()));
    }
    let res = sqlx::query("DELETE FROM feature_flags WHERE key = $1")
        .bind(&key)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn admin_list_flag_overrides(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<Vec<FeatureFlagOverride>>> {
    let key = key.trim().to_ascii_lowercase();
    if !valid_flag_key(&key) {
        return Err(Error::BadRequest("invalid flag key".into()));
    }
    // 404 if the flag does not exist so the caller distinguishes
    // "no overrides" from "no such flag".
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM feature_flags WHERE key = $1)")
            .bind(&key)
            .fetch_one(&state.pool)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows = sqlx::query_as::<_, FeatureFlagOverride>(
        "SELECT flag_key, user_id, enabled, set_at \
         FROM feature_flag_overrides WHERE flag_key = $1 \
         ORDER BY set_at DESC",
    )
    .bind(&key)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// Idempotent upsert. POSTing the same (flag, user_id) updates the
/// `enabled` bit and refreshes `set_at`, which doubles as a change
/// log entry for the admin tooling.
async fn admin_upsert_flag_override(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<UpsertFlagOverride>,
) -> Result<Json<FeatureFlagOverride>> {
    let key = key.trim().to_ascii_lowercase();
    if !valid_flag_key(&key) {
        return Err(Error::BadRequest("invalid flag key".into()));
    }
    let flag_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM feature_flags WHERE key = $1)")
            .bind(&key)
            .fetch_one(&state.pool)
            .await?;
    if !flag_exists {
        return Err(Error::NotFound);
    }
    let user_exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(body.user_id)
            .fetch_one(&state.pool)
            .await?;
    if !user_exists {
        return Err(Error::NotFound);
    }
    let row = sqlx::query_as::<_, FeatureFlagOverride>(
        "INSERT INTO feature_flag_overrides (flag_key, user_id, enabled) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (flag_key, user_id) DO UPDATE SET \
             enabled = EXCLUDED.enabled, set_at = now() \
         RETURNING flag_key, user_id, enabled, set_at",
    )
    .bind(&key)
    .bind(body.user_id)
    .bind(body.enabled)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(row))
}

async fn admin_delete_flag_override(
    State(state): State<AppState>,
    Path((key, user_id)): Path<(String, Uuid)>,
) -> Result<StatusCode> {
    let key = key.trim().to_ascii_lowercase();
    if !valid_flag_key(&key) {
        return Err(Error::BadRequest("invalid flag key".into()));
    }
    let res =
        sqlx::query("DELETE FROM feature_flag_overrides WHERE flag_key = $1 AND user_id = $2")
            .bind(&key)
            .bind(user_id)
            .execute(&state.pool)
            .await?;
    if res.rows_affected() == 0 {
        return Err(Error::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn admin_token_audit(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<AdminTokenAudit>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM api_tokens WHERE id = $1)")
            .bind(id)
            .fetch_one(&state.pool)
            .await?;
    if !exists {
        return Err(Error::NotFound);
    }
    let rows = sqlx::query_as::<_, AdminTokenAudit>(
        "SELECT id, token_id, ts, action, ip, user_agent \
         FROM api_token_audit WHERE token_id = $1 ORDER BY ts DESC LIMIT $2",
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::dedup_label;

    fn taken(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn dedup_label_keeps_a_free_label() {
        assert_eq!(dedup_label("laptop", &taken(&["office"])), "laptop");
        assert_eq!(dedup_label("laptop", &[]), "laptop");
    }

    #[test]
    fn dedup_label_suffixes_until_free() {
        assert_eq!(dedup_label("laptop", &taken(&["laptop"])), "laptop-2");
        assert_eq!(
            dedup_label("laptop", &taken(&["laptop", "laptop-2"])),
            "laptop-3"
        );
        // Only exact matches collide; a prefix relation does not.
        assert_eq!(dedup_label("laptop", &taken(&["laptop-2"])), "laptop");
    }

    #[test]
    fn dedup_label_respects_the_64_byte_bound() {
        let base = "x".repeat(64);
        let out = dedup_label(&base, &taken(&[&base]));
        assert_eq!(out, format!("{}-2", "x".repeat(62)));
        assert!(out.len() <= 64);
        // The shortened candidate re-checks the taken set.
        let out = dedup_label(&base, &taken(&[&base, &format!("{}-2", "x".repeat(62))]));
        assert_eq!(out, format!("{}-3", "x".repeat(62)));
    }

    #[test]
    fn dedup_label_shortens_on_char_boundaries() {
        // 32 two-byte chars = 64 bytes; the suffix forces dropping a
        // whole char, never splitting one.
        let base = "é".repeat(32);
        let out = dedup_label(&base, &taken(&[&base]));
        assert_eq!(out, format!("{}-2", "é".repeat(31)));
        assert!(out.len() <= 64);
    }
}
