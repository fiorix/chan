use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use gateway_common::validators::{valid_username, MAX_USERNAME_EDITS};
use oauth2::PkceCodeVerifier;
use rustrict::CensorStr;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tower_http::trace::TraceLayer;
use tower_sessions::{cookie::time::Duration, Expiry, Session, SessionManagerLayer};
use tower_sessions_sqlx_store::PostgresStore;
use uuid::Uuid;

use crate::api_tokens::{
    ApiToken, ApiTokenService, AuditEntry, CreatedToken, NewToken, RequestMeta, TokenOrigin,
    ValidatedToken, DEFAULT_TOKEN_SCOPES,
};
use crate::config::Config;
use crate::error::{Error, Result};
use crate::profile_client::{DevserverGrant, IncomingShare, OwnedDevserverSummary, User};
use crate::static_files;
use crate::token_throttle::TokenThrottle;

/// Production session cookie. `__Host-` requires Secure, `Path=/`, and
/// no `Domain`; tower-sessions defaults to `Path=/` with no `Domain`,
/// and `COOKIE_SECURE` supplies Secure (A11).
const SESSION_COOKIE: &str = "__Host-id_session";
/// Session cookie for `COOKIE_SECURE=false` runs. Browsers reject
/// `__Host-` names without Secure, so an insecure dev session must use
/// a visibly test-only name instead of squatting the production one.
const SESSION_COOKIE_INSECURE_DEV: &str = "id_session_insecure_dev";

/// The `__Host-` production name is only legal on Secure cookies; an
/// insecure run gets the visibly test-only name instead (A11).
fn session_cookie_name(cookie_secure: bool) -> &'static str {
    if cookie_secure {
        SESSION_COOKIE
    } else {
        SESSION_COOKIE_INSECURE_DEV
    }
}
const KEY_USER: &str = "user_id";
const KEY_PENDING: &str = "pending_oauth";
/// Optional post-login redirect target. Set by the share landing
/// when an unauthenticated user lands on `/s/{owner}/{workspace}` so the
/// OAuth callback can resume the flow instead of dropping the user
/// at the dashboard. Stored as a relative path; the callback
/// validates the prefix before using it.
const KEY_POST_LOGIN_REDIRECT: &str = "post_login_redirect";

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub api_tokens: ApiTokenService,
    /// Per-token-fingerprint rate limiter applied to
    /// /internal/v1/tokens/validate. Defense in depth: devserver-proxy
    /// throttles by the same fingerprint one hop earlier, so this
    /// kicks in only if the internal bearer leaks and someone calls
    /// identity directly. Throttled requests come back as 401 so
    /// they are indistinguishable from "unknown token" on the wire.
    pub token_throttle: TokenThrottle,
    /// One-time desktop-authorize redemption codes; written by the
    /// confirm handler, consumed by `/desktop/authorize/redeem`.
    pub desktop_redemptions: crate::desktop_authorize::RedemptionStore,
}

/// Reserved usernames. Anything that could collide with an existing
/// or future top-level path under chan.app/ goes here. Kept short on
/// purpose; profanity / leet-speak is handled separately by the
/// rustrict pass.
const RESERVED_USERNAMES: &[&str] = &[
    "admin",
    "administrator",
    "api",
    "app",
    "auth",
    "billing",
    "blog",
    "chan",
    "dashboard",
    "developer",
    "developers",
    "docs",
    "workspace",
    "workspaces",
    "help",
    "id",
    "identity",
    "internal",
    "login",
    "logout",
    "me",
    "oauth",
    "owner",
    "profile",
    "public",
    "root",
    "settings",
    "signin",
    "signup",
    "staff",
    "static",
    "status",
    "support",
    "system",
    "team",
    "user",
    "users",
    "www",
];

#[derive(Debug, Deserialize, Serialize)]
struct PendingOauth {
    provider: String,
    state: String,
    verifier: String,
}

pub fn router(
    cfg: Arc<Config>,
    store: PostgresStore,
    api_tokens: ApiTokenService,
    token_throttle: TokenThrottle,
) -> Router {
    let (public, internal) = routers(cfg, store, api_tokens, token_throttle);
    public.merge(internal)
}

/// Build physically separate public and internal applications. Production
/// serves these on distinct listeners; the combined [`router`] remains only
/// as a test harness convenience for suites that exercise both surfaces.
pub fn routers(
    cfg: Arc<Config>,
    store: PostgresStore,
    api_tokens: ApiTokenService,
    token_throttle: TokenThrottle,
) -> (Router, Router) {
    // Host-only on id.chan.app: no Domain attribute, so the cookie
    // does not propagate to the proxy fleet's tenant origins. The
    // devserver-gate handoff covers the cross-service auth need; see
    // crates/identity/design.md. The `__Host-` name additionally makes
    // the browser reject any Domain-carrying shadow of it (A11), which
    // is why the insecure dev fallback must use a different name.
    let session_layer = SessionManagerLayer::new(store)
        .with_name(session_cookie_name(cfg.cookie_secure))
        .with_secure(cfg.cookie_secure)
        .with_http_only(true)
        .with_same_site(tower_sessions::cookie::SameSite::Lax)
        .with_expiry(Expiry::OnInactivity(Duration::days(30)));

    let state = AppState {
        cfg,
        api_tokens,
        token_throttle,
        desktop_redemptions: Default::default(),
    };

    // /internal/* is gated by IDENTITY_INTERNAL_TOKEN (distinct from
    // PROFILE_AUTH_TOKEN; see internal_auth). Kept on its own
    // sub-router so the session layer doesn't try to load a cookie
    // session for callers that don't have one.
    //
    // No per-IP rate limit here. The only caller is devserver-proxy,
    // so a governor at this hop sees one peer IP regardless of how
    // many distinct clients are probing tokens upstream: a single
    // global bucket that can lock out legitimate `chan devserver`
    // handshakes while leaving real attacker shape invisible. The
    // primary PAT brute-force gate sits in devserver-proxy, keyed on
    // a hash of the candidate token; `token_throttle` inside the
    // validate handler is its defense-in-depth twin.
    let internal = Router::new()
        .route("/internal/v1/tokens/validate", post(validate_token))
        .route_layer(middleware::from_fn_with_state(state.clone(), internal_auth));

    // /admin/v1/* is the operator surface for chan-gateway-admin,
    // gated by IDENTITY_ADMIN_TOKEN (empty = the routes answer 404 as
    // if absent; see admin_auth). Same sub-router shape as /internal
    // for the same session-layer reason.
    let admin = Router::new()
        .route("/admin/v1/tokens", post(admin_tokens_create))
        .route_layer(middleware::from_fn_with_state(state.clone(), admin_auth));

    let internal = internal
        .merge(admin)
        .with_state(state.clone())
        .layer(TraceLayer::new_for_http());

    let public = Router::new()
        .route("/healthz", get(healthz))
        // Never let the SPA fallback make a public probe of the internal
        // namespace look successful. The real handlers exist only in the
        // separately served internal router.
        .route("/internal", axum::routing::any(public_internal_not_found))
        .route(
            "/internal/{*path}",
            axum::routing::any(public_internal_not_found),
        )
        .route("/.well-known/chan-gateway", get(gateway_discovery))
        .route("/auth/{provider}", get(auth_start))
        .route("/auth/{provider}/callback", get(auth_callback))
        .route("/api/providers", get(providers_list))
        .route("/api/me", get(me))
        .route("/api/me/username", patch(update_username))
        .route("/api/logout", post(logout))
        .route("/api/profile", axum::routing::delete(delete_profile))
        .route("/api/tokens", get(tokens_list).post(tokens_create))
        .route("/api/tokens/{id}", axum::routing::delete(tokens_revoke))
        .route("/api/tokens/{id}/audit", get(tokens_audit))
        .route("/api/devservers/owned", get(devservers_owned))
        .route("/api/devservers/incoming", get(devservers_incoming))
        .route(
            "/api/devservers/{devserver_id}/grants",
            get(devserver_grants_list).post(devserver_grants_create),
        )
        .route(
            "/api/grants/{id}",
            axum::routing::delete(devserver_grants_delete),
        )
        .route("/s/{owner}", get(share_landing_root))
        .route("/s/{owner}/{workspace}", get(share_landing))
        .route(
            "/desktop/authorize",
            get(crate::desktop_authorize::authorize),
        )
        .route(
            "/desktop/authorize/consent",
            get(crate::desktop_authorize::consent),
        )
        .route(
            "/desktop/authorize/confirm",
            post(crate::desktop_authorize::confirm),
        )
        .route(
            "/desktop/authorize/redeem",
            post(crate::desktop_authorize::redeem),
        )
        .route("/desktop/v1/devserver/entry", post(desktop_devserver_entry))
        .route("/desktop/v1/devservers", get(crate::desktop_roster::roster))
        .fallback(static_files::handler)
        .with_state(state)
        .layer(session_layer)
        .layer(TraceLayer::new_for_http());

    (public, internal)
}

async fn healthz() -> &'static str {
    "ok"
}

async fn public_internal_not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

#[derive(Debug, Serialize)]
struct GatewayDiscovery {
    kind: &'static str,
    api_version: u32,
    identity_origin: String,
    desktop_authorize_url: String,
    desktop_entry_url: String,
    /// Account-mode roster (`GET`, PAT bearer with `desktop.account`).
    /// Presence tells a desktop this gateway supports account-level
    /// authorize; a gateway without the key reads as connect-mode only.
    roster_url: String,
    devserver_proxy_origin: String,
    devserver_proxy_host_depth: u8,
    tunnel_url: String,
}

async fn gateway_discovery(State(state): State<AppState>) -> Result<Json<GatewayDiscovery>> {
    let identity_origin = state.cfg.base_url.origin().ascii_serialization();
    let devserver_proxy_origin = state
        .cfg
        .devserver_proxy_origin
        .origin()
        .ascii_serialization();
    let tunnel_origin = state
        .cfg
        .devserver_tunnel_origin
        .origin()
        .ascii_serialization();
    Ok(Json(GatewayDiscovery {
        kind: "chan-gateway",
        api_version: 1,
        identity_origin,
        desktop_authorize_url: state
            .cfg
            .base_url
            .join("/desktop/authorize")
            .map_err(|e| Error::Anyhow(anyhow::anyhow!("discovery authorize url: {e}")))?
            .to_string(),
        desktop_entry_url: state
            .cfg
            .base_url
            .join("/desktop/v1/devserver/entry")
            .map_err(|e| Error::Anyhow(anyhow::anyhow!("discovery entry url: {e}")))?
            .to_string(),
        roster_url: state
            .cfg
            .base_url
            .join("/desktop/v1/devservers")
            .map_err(|e| Error::Anyhow(anyhow::anyhow!("discovery roster url: {e}")))?
            .to_string(),
        devserver_proxy_origin: devserver_proxy_origin.clone(),
        devserver_proxy_host_depth: 2,
        tunnel_url: format!("{tunnel_origin}{}", chan_tunnel_proto::TUNNEL_PATH),
    }))
}

async fn auth_start(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    session: Session,
) -> Result<Response> {
    let p = state.cfg.provider(&provider).ok_or(Error::NotFound)?;
    let redirect = state.cfg.redirect_uri(p.name());
    let (url, csrf, verifier) = p.authorize_url(&redirect)?;
    session
        .insert(
            KEY_PENDING,
            &PendingOauth {
                provider: p.name().to_string(),
                state: csrf.secret().clone(),
                verifier: verifier.secret().clone(),
            },
        )
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert: {e}")))?;
    Ok(Redirect::to(url.as_str()).into_response())
}

#[derive(Debug, Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn auth_callback(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(q): Query<CallbackParams>,
    headers: HeaderMap,
    session: Session,
) -> Result<Redirect> {
    // Bound the entire callback at 15s. The provider's `state` lifetime
    // and the user's patience both run out well before the worst-case
    // sum of sequential profile-service awaits (exchange + upsert +
    // flags + audit + cycle_id + insert + audit + claim_grants), so a
    // slow profile cannot strand the OAuth window.
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        auth_callback_inner(state, provider, q, headers, session),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            tracing::warn!("auth_callback exceeded 15s deadline");
            Err(Error::Anyhow(anyhow::anyhow!("auth_callback timed out")))
        }
    }
}

async fn auth_callback_inner(
    state: AppState,
    provider: String,
    q: CallbackParams,
    headers: HeaderMap,
    session: Session,
) -> Result<Redirect> {
    if let Some(err) = q.error {
        // Provider error codes are OAuth-spec values (`access_denied`,
        // `server_error`, etc.); echoing them is safe. The SPA renders
        // the response body via Svelte interpolation which HTML-escapes,
        // so a hostile provider can't smuggle HTML/JS here either.
        return Err(Error::BadRequest(format!("provider error: {err}")));
    }
    let code = q
        .code
        .ok_or_else(|| Error::BadRequest("missing code".into()))?;
    let state_param = q
        .state
        .ok_or_else(|| Error::BadRequest("missing state".into()))?;

    let pending: PendingOauth = session
        .remove(KEY_PENDING)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session remove: {e}")))?
        .ok_or(Error::BadRequest("no pending oauth".into()))?;
    // Validate state first (constant-time) so a non-constant-time
    // provider compare can't be used to oracle which provider the
    // session expects via response-time differences. Provider check
    // is a plain compare because the value was already trusted on
    // /auth/{provider} entry; pairing it with state validation just
    // catches a session that crossed providers mid-flow.
    if !ct_eq(&pending.state, &state_param) {
        return Err(Error::BadRequest("state mismatch".into()));
    }
    if pending.provider != provider {
        return Err(Error::BadRequest("provider mismatch".into()));
    }

    let p = state.cfg.provider(&provider).ok_or(Error::NotFound)?;
    let redirect_uri = state.cfg.redirect_uri(p.name());
    let info = p
        .exchange(
            &code,
            PkceCodeVerifier::new(pending.verifier),
            &redirect_uri,
        )
        .await?;

    // One atomic round trip: find existing identity, else attach
    // identity to the existing user with this email, else create
    // user + identity. Avatar refresh on the steady-state branch is
    // folded into the same tx server-side. A single transaction is
    // what prevents orphan user rows on concurrent first-time logins
    // and lets a second provider attach to an existing user by email
    // instead of failing on a duplicate.
    let upsert = state
        .cfg
        .profile_client
        .upsert_by_identity(
            p.name(),
            &info.provider_subject,
            info.email.as_deref(),
            info.display_name.as_deref(),
            info.picture_url.as_deref(),
        )
        .await?;
    let user = upsert.user;

    let ip = client_ip(&headers);
    let ua = user_agent(&headers);

    if user.is_blocked() {
        // Record the denied attempt before bouncing the user. The
        // session is never granted, so the SPA never reaches /api/me.
        // Forensic only: a profile outage here loses the row but does
        // not change the user-facing behavior. Surface the failure via
        // warn so an audit gap is visible in logs.
        if let Err(e) = state
            .cfg
            .profile_client
            .write_auth_audit(
                user.id,
                "login_denied",
                ip.as_deref(),
                ua.as_deref(),
                user.block_reason.as_deref(),
            )
            .await
        {
            tracing::warn!(error = ?e, user = %user.username, "write_auth_audit (blocked) failed");
        }
        // If the user was bounced here by /desktop/authorize, finish
        // the flow with a loopback error redirect so the desktop client
        // can render its own "blocked" panel.
        if let Some(params) = crate::desktop_authorize::take_pending(&session).await? {
            return Ok(Redirect::to(&crate::desktop_authorize::error_url(
                &params,
                "account_blocked",
            )));
        }
        return Err(Error::Forbidden("account blocked"));
    }

    // Feature-flag gate. `oauth_login` is the allowlist for sign-in.
    // Profile resolves the per-user override on top of the registry
    // default; a fresh deploy ships `default_enabled=false`, so only
    // explicitly granted users can sign in. The deny path leaves the
    // user row in place (matches the blocked-account posture) and
    // 303s to the SPA's denied panel. We do this *before* cycle_id
    // so the session never holds an authenticated state for a
    // denied account.
    let flags = state
        .cfg
        .profile_client
        .get_user_flags(user.id)
        .await
        .unwrap_or_default();
    if !flags.get("oauth_login").copied().unwrap_or(false) {
        if let Err(e) = state
            .cfg
            .profile_client
            .write_auth_audit(
                user.id,
                "login_denied",
                ip.as_deref(),
                ua.as_deref(),
                Some("oauth_login flag not granted"),
            )
            .await
        {
            tracing::warn!(error = ?e, user = %user.username, "write_auth_audit (oauth_login deny) failed");
        }
        // Desktop bounce: route the deny back to chan-desktop via the
        // loopback callback query so the desktop client can surface it.
        if let Some(params) = crate::desktop_authorize::take_pending(&session).await? {
            return Ok(Redirect::to(&crate::desktop_authorize::error_url(
                &params,
                "oauth_denied",
            )));
        }
        return Ok(Redirect::to("/?denied=oauth_login"));
    }

    // Rotate the session id at the privilege boundary: anything that
    // was in this session before sign-in (pending OAuth state, anon
    // CSRF nonces, a cookie an attacker planted on the victim's
    // browser pre-login) keeps the old id, the freshly authenticated
    // state lives under a new one. Prevents session fixation: a
    // pre-set `__Host-id_session` cannot survive the authentication step.
    session
        .cycle_id()
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session cycle_id: {e}")))?;

    session
        .insert(KEY_USER, &user.id)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert: {e}")))?;

    if let Err(e) = state
        .cfg
        .profile_client
        .write_auth_audit(
            user.id,
            "login",
            ip.as_deref(),
            ua.as_deref(),
            Some(p.name()),
        )
        .await
    {
        tracing::warn!(error = ?e, user = %user.username, "write_auth_audit (login) failed");
    }

    // Best-effort claim sweep. Profile fills `grantee_user_id` on
    // any pending grant whose email matches one of the user's
    // verified addresses. Pass the user's primary email plus the
    // freshly-observed provider email; previous providers' emails
    // would already have been swept on their own callbacks. A failure
    // here logs and continues so an unhealthy profile call doesn't
    // block sign-in.
    //
    // Caveat: `users.email` is verified-at-link-time, not re-verified
    // here. Provider reassignment (Google Workspace / Microsoft
    // tenant) of the address after signup could theoretically let a
    // stale `users.email` claim a grant intended for the new owner.
    // The freshly-observed provider email is always re-verified
    // through the provider's own check, so the new-owner side will
    // also sweep it on their next sign-in; we accept the race.
    let mut emails: Vec<String> = vec![user.email.clone()];
    if let Some(e) = info.email.as_deref() {
        if !e.eq_ignore_ascii_case(&user.email) {
            emails.push(e.to_string());
        }
    }
    match state
        .cfg
        .profile_client
        .claim_grants(user.id, &emails)
        .await
    {
        Ok(claimed) if claimed > 0 => {
            tracing::info!(user = %user.username, claimed, "claimed pending workspace grants");
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = ?e, user = %user.username, "claim_grants failed");
        }
    }

    // Desktop bounce: if /desktop/authorize stashed params before
    // sending the user through OAuth, hand the user to the consent
    // page. We do NOT mint here; that needs the user's explicit
    // click on the consent form. peek (not take) so the stash
    // survives across reloads of the consent page.
    if crate::desktop_authorize::peek_pending(&session)
        .await?
        .is_some()
    {
        return Ok(Redirect::to(crate::desktop_authorize::CONSENT_PATH));
    }

    // Resume share landing (or any other stashed return path) if the
    // pre-login redirect was set on this session. We validate it
    // starts with `/` and is not a protocol-relative URL (`//host`)
    // so an attacker cannot use the stash to point us at another
    // origin after login.
    let dest = match session.remove::<String>(KEY_POST_LOGIN_REDIRECT).await {
        Ok(Some(p)) if is_safe_local_redirect(&p) => p,
        Ok(_) => "/".to_string(),
        Err(e) => {
            tracing::warn!(error = ?e, "session remove post_login_redirect failed");
            "/".to_string()
        }
    };
    Ok(Redirect::to(&dest))
}

/// Allow only paths that stay on this origin: must start with a
/// single `/`, must not be protocol-relative (`//evil.com`), and
/// must not contain a scheme separator. Empty / malformed strings
/// fall through to `/` at the caller.
///
/// Intentionally coarse: this is a denylist over "could a browser
/// follow this off-origin?" The `!contains(':')` clause forbids
/// `javascript:` and any path containing a colon (e.g. matrix-style
/// `;jsessionid=`). It also rejects benign paths like `/foo:bar`,
/// which we don't mint anywhere, so the false-positive cost is zero
/// against the same-origin safety win.
fn is_safe_local_redirect(p: &str) -> bool {
    p.starts_with('/') && !p.starts_with("//") && !p.contains(':')
}

pub(crate) async fn current_user_id(session: &Session) -> Result<Uuid> {
    session
        .get::<Uuid>(KEY_USER)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session get: {e}")))?
        .ok_or(Error::Unauthorized)
}

/// Same as [`current_user_id`] but absence of a session returns `Ok(None)`
/// instead of `Unauthorized`. Used by handlers that have an
/// unauthenticated fall-through (`/desktop/authorize` bounces through
/// sign-in before completing).
pub(crate) async fn current_user_id_optional(session: &Session) -> Result<Option<Uuid>> {
    session
        .get::<Uuid>(KEY_USER)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session get: {e}")))
}

/// Resolve the session to a non-blocked user. Used by every
/// management endpoint (rename, mint/revoke/list/audit tokens) so a
/// blocked user can't keep mutating their account through a stale
/// cookie. `me`, `logout` and `delete_profile` deliberately don't
/// gate on blocked: `me` returns the row so the SPA can render the
/// blocked view, the other two are always permitted (right to log
/// out, right to delete).
async fn current_active_user(state: &AppState, session: &Session) -> Result<User> {
    let uid = current_user_id(session).await?;
    let pc = &state.cfg.profile_client;
    let Some(user) = pc.get_user(uid).await? else {
        let _ = session.flush().await;
        return Err(Error::Unauthorized);
    };
    if user.is_blocked() {
        return Err(Error::Forbidden("account blocked"));
    }
    Ok(user)
}

#[derive(Serialize)]
struct DevserverView {
    /// One live devserver id (registry 2nd key); a user can hold
    /// several. The dashboard pairs this with the profile-backed
    /// owned list (which carries the label) to flip online/offline.
    devserver_id: String,
    /// "online" while the tunnel registration is live.
    status: &'static str,
}

#[derive(Serialize)]
struct MeResponse {
    user: User,
    /// Live devserver snapshot for this user, sourced from the
    /// controller admin tunnel list (one row per live devserver).
    /// Empty when nothing is connected (or the user is blocked, or the
    /// controller is unreachable; in the unreachable case we log and
    /// serve an empty list so the dashboard renders). Per-workspace
    /// online state is NOT here: it comes from the devserver's own API
    /// over the owner's direct connection (design 4.1).
    devservers: Vec<DevserverView>,
    /// Resolved feature flags for this user. Map of flag_key -> bool.
    /// Sourced from profile each call (no caching) so a gradual
    /// rollout takes effect on the next dashboard reload.
    flags: gateway_common::profile_client::FlagMap,
}

async fn me(State(state): State<AppState>, session: Session) -> Result<Response> {
    let uid = current_user_id(&session).await?;
    let pc = &state.cfg.profile_client;
    // User vanished underneath the cookie: invalidate and 401.
    let Some(user) = pc.get_user(uid).await? else {
        let _ = session.flush().await;
        return Err(Error::Unauthorized);
    };

    // Workspace list comes from devserver-control. Blocked users get an empty
    // list; the SPA renders the blocked view from `user.blocked_at`.
    // devserver-control outages also surface as empty (with a log line)
    // rather than failing the whole `/api/me`: the dashboard is the
    // user's only way to discover other state (rename, PATs, account
    // delete), and that state still loads from profile-service.
    let devservers = if user.is_blocked() {
        Vec::new()
    } else {
        match state.cfg.workspace_admin.list_owner_tunnels(user.id).await {
            Ok(rows) => rows
                .into_iter()
                .filter(|t| {
                    crate::devserver_authority::verify_tunnel(
                        &state.cfg.admission_lease_verifier,
                        t,
                    )
                    .is_ok()
                        && t.owner_user_id == user.id
                        && t.user == user.username
                })
                .map(|t| DevserverView {
                    devserver_id: t.devserver_id,
                    status: "online",
                })
                .collect(),
            Err(e) => {
                tracing::warn!(error = ?e, user = %user.username, "devserver list fetch failed");
                Vec::new()
            }
        }
    };

    // Resolve feature flags for this user. Profile unhealthy =>
    // empty map (SPA falls back to "feature off" for everything,
    // which is the safe default).
    let flags = state
        .cfg
        .profile_client
        .get_user_flags(user.id)
        .await
        .unwrap_or_default();

    Ok(Json(MeResponse {
        user,
        devservers,
        flags,
    })
    .into_response())
}

async fn logout(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
) -> Result<StatusCode> {
    // Read the user_id before flushing so we can attribute the audit
    // row; absent (already-logged-out) sessions just skip the write.
    let uid = session.get::<Uuid>(KEY_USER).await.ok().flatten();
    session
        .flush()
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session flush: {e}")))?;
    if let Some(uid) = uid {
        let ip = client_ip(&headers);
        let ua = user_agent(&headers);
        let _ = state
            .cfg
            .profile_client
            .write_auth_audit(uid, "logout", ip.as_deref(), ua.as_deref(), None)
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Constant-time string equality for OAuth state and bearer
/// comparison. Length inequality short-circuits to false; this leaks
/// the length but no byte of the secret.
fn ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

#[derive(Serialize)]
struct ProvidersResponse {
    providers: Vec<&'static str>,
}

async fn providers_list(State(state): State<AppState>) -> Json<ProvidersResponse> {
    Json(ProvidersResponse {
        providers: state.cfg.providers.iter().map(|p| p.name()).collect(),
    })
}

async fn delete_profile(State(state): State<AppState>, session: Session) -> Result<StatusCode> {
    let uid = current_user_id(&session).await?;

    // Establish denial before acknowledging either synchronous completion or
    // queued work. The profile transaction blocks new authorization and
    // revokes every PAT while deliberately retaining the user row.
    state
        .cfg
        .profile_client
        .mark_user_pending_delete(uid)
        .await?;

    // The profile transaction above also reserves a durable AccountDelete
    // outbox row. This first cut only reduces latency; profile performs the
    // mandatory post-quiet-period cut and finalization after any restart.
    let (kill, revoke) = tokio::join!(
        state.cfg.workspace_admin.kill_owner_tunnels(uid),
        state.cfg.workspace_admin.revoke_subject_sessions(uid),
    );
    if let Err(error) = kill {
        tracing::warn!(%uid, ?error, "account deletion first tunnel cut failed");
    }
    if let Err(error) = revoke {
        tracing::warn!(%uid, ?error, "account deletion first session cut failed");
    }
    session
        .flush()
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session flush: {e}")))?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct UsernameBody {
    username: String,
}

#[derive(Serialize)]
struct UsernameResponse {
    username: String,
    edits_remaining: i32,
}

/// Validate the candidate before sending it upstream. Cheap rejects
/// happen here so the SPA gets a fast, specific error; profile-
/// service still re-checks format and uniqueness as a safety net.
async fn update_username(
    State(state): State<AppState>,
    session: Session,
    Json(body): Json<UsernameBody>,
) -> Result<Json<UsernameResponse>> {
    let user = current_active_user(&state, &session).await?;
    let uid = user.id;
    let candidate = body.username.trim().to_ascii_lowercase();

    if !valid_username(&candidate) {
        return Err(Error::BadRequest(
            "username must be 3-32 chars, lowercase alphanumeric or hyphen, no leading/trailing hyphen".into(),
        ));
    }
    if RESERVED_USERNAMES
        .binary_search(&candidate.as_str())
        .is_ok()
    {
        return Err(Error::BadRequest("username is reserved".into()));
    }
    // No explicit reject for the `u<hex>` placeholder shape: the
    // UNIQUE index on username plus profile-service's CAS update
    // (lower(username) <> $2) already make it impossible to rename
    // onto another user's placeholder, and renaming to your own
    // current handle is a no-op upstream.
    // rustrict: leet-normalises and matches an internal profanity
    // list. Adequate for usernames; known to false-positive on some
    // place names and short letter combinations. `RUSTRICT_ALLOWLIST`
    // is a comma-separated escape hatch: any handle that appears in
    // it bypasses the filter (case-insensitive). The check itself
    // still runs after every other validation (length, charset,
    // reserved list) so the allowlist cannot reintroduce shapes the
    // earlier rules already refused.
    if candidate.is_inappropriate() && !is_rustrict_allowed(&candidate) {
        return Err(Error::BadRequest("username not allowed".into()));
    }

    if candidate != user.username {
        state.cfg.workspace_admin.kill_owner_tunnels(uid).await?;
    }

    let user = state
        .cfg
        .profile_client
        .update_username(uid, &candidate)
        .await?;

    Ok(Json(UsernameResponse {
        username: user.username,
        edits_remaining: (MAX_USERNAME_EDITS - user.username_edits).max(0),
    }))
}

/// Returns true when the candidate (already lowercased, ASCII)
/// matches an entry in `RUSTRICT_ALLOWLIST`. Env is parsed on every
/// call; the value is short and the rename path is cold.
fn is_rustrict_allowed(candidate: &str) -> bool {
    let Ok(raw) = std::env::var("RUSTRICT_ALLOWLIST") else {
        return false;
    };
    raw.split(',')
        .map(|s| s.trim())
        .any(|s| s.eq_ignore_ascii_case(candidate))
}

#[derive(Debug, Deserialize)]
struct CreateTokenBody {
    label: String,
    /// Lifetime in seconds. None = never expires; the SPA presets
    /// 30d / 90d / 1y / never as the issue requested, but the
    /// concrete expiry is computed client-side and sent here.
    expires_in: Option<i64>,
    /// Capabilities to grant the token. When absent (or empty), the
    /// service falls back to `DEFAULT_TOKEN_SCOPES` (`["tunnel"]`),
    /// which lets the holder dial chan-tunnel. `tunnel` is the only
    /// live scope (every devserver is authenticated).
    #[serde(default)]
    scopes: Option<Vec<String>>,
}

#[derive(Serialize)]
struct TokenView {
    id: Uuid,
    label: String,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
    scopes: Vec<String>,
}

impl From<ApiToken> for TokenView {
    fn from(t: ApiToken) -> Self {
        Self {
            id: t.id,
            label: t.label,
            expires_at: t.expires_at,
            created_at: t.created_at,
            revoked_at: t.revoked_at,
            last_used_at: t.last_used_at,
            scopes: t.scopes,
        }
    }
}

#[derive(Serialize)]
struct CreatedTokenView {
    #[serde(flatten)]
    token: TokenView,
    /// Plaintext PAT. Shown in the UI exactly once on creation;
    /// never returned again from any endpoint.
    secret: String,
}

async fn tokens_create(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    Json(body): Json<CreateTokenBody>,
) -> Result<(StatusCode, Json<CreatedTokenView>)> {
    let uid = current_active_user(&state, &session).await?.id;
    let expires_at = body
        .expires_in
        .filter(|s| *s > 0)
        .map(|s| Utc::now() + chrono::Duration::seconds(s));

    let scopes: Vec<String> = match body.scopes {
        Some(ref s) if !s.is_empty() => s.clone(),
        _ => DEFAULT_TOKEN_SCOPES
            .iter()
            .map(|s| (*s).to_string())
            .collect(),
    };
    let CreatedToken { token, secret } = state
        .api_tokens
        .create(
            NewToken {
                user_id: uid,
                label: &body.label,
                expires_at,
                scopes: &scopes,
                origin: TokenOrigin::Spa,
            },
            &request_meta(&headers),
        )
        .await?;

    // A PAT is a devserver only when it can dial (tunnel scope):
    // register the roster row so the owner sees it and can grant on
    // it before it ever dials in; the label mirrors the PAT label.
    register_devserver_row(&state, uid, &secret, &body.label, &scopes).await;

    Ok((
        StatusCode::CREATED,
        Json(CreatedTokenView {
            token: token.into(),
            secret,
        }),
    ))
}

async fn tokens_list(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<Vec<TokenView>>> {
    let uid = current_active_user(&state, &session).await?.id;
    let tokens = state.api_tokens.list(uid).await?;
    Ok(Json(tokens.into_iter().map(Into::into).collect()))
}

async fn tokens_revoke(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode> {
    let user = current_active_user(&state, &session).await?;
    let uid = user.id;
    let meta = request_meta(&headers);
    state
        .cfg
        .profile_client
        .revoke_user_api_token(uid, id, meta.ip.as_deref(), meta.user_agent.as_deref())
        .await?;
    // Drop every live tunnel and browser session the user has. We can't
    // selectively kill the tunnel(s) backed by this specific PAT
    // (chan-tunnel-server doesn't track which token registered which
    // substream), so a revoke pulls down everything the user has
    // open. chan-serve instances using a non-revoked token will
    // reconnect on the next handshake; instances using the revoked
    // token fail the next validate and stay disconnected.
    let (kill, revoke) = tokio::join!(
        state.cfg.workspace_admin.kill_owner_tunnels(uid),
        state.cfg.workspace_admin.revoke_subject_sessions(uid),
    );
    if let Err(error) = kill {
        tracing::warn!(error = ?error, user = %user.username, "PAT first tunnel cut failed");
    }
    if let Err(error) = revoke {
        tracing::warn!(error = ?error, user = %user.username, "PAT first session cut failed");
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct AuditQuery {
    /// Cap rows returned; defaults to 50, hard-clamped to 200.
    limit: Option<i64>,
}

async fn tokens_audit(
    State(state): State<AppState>,
    session: Session,
    Path(id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<AuditEntry>>> {
    let uid = current_active_user(&state, &session).await?.id;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows = state.api_tokens.audit(uid, id, limit).await?;
    Ok(Json(rows))
}

// ---------------------------------------------------------------------------
// Devserver sharing (grants)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateGrantBody {
    grantee_email: String,
}

/// Owner creates / promotes a grant on one of their devservers. The
/// session user is the owner; the URL carries only the devserver_id
/// (not the owner's id), so a stale tab cannot mint grants against
/// somebody else's devserver. A grant gives the WHOLE devserver.
async fn devserver_grants_create(
    State(state): State<AppState>,
    session: Session,
    Path(devserver_id): Path<String>,
    Json(body): Json<CreateGrantBody>,
) -> Result<(StatusCode, Json<DevserverGrant>)> {
    let user = current_active_user(&state, &session).await?;
    // Surface format errors before the round trip; profile re-checks.
    let devserver_id = devserver_id.trim().to_ascii_lowercase();
    if !is_devserver_id_shape(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let grant = state
        .cfg
        .profile_client
        .create_devserver_grant(user.id, &devserver_id, body.grantee_email.trim())
        .await?;
    Ok((StatusCode::CREATED, Json(grant)))
}

async fn devserver_grants_list(
    State(state): State<AppState>,
    session: Session,
    Path(devserver_id): Path<String>,
) -> Result<Json<Vec<DevserverGrant>>> {
    let user = current_active_user(&state, &session).await?;
    let devserver_id = devserver_id.trim().to_ascii_lowercase();
    if !is_devserver_id_shape(&devserver_id) {
        return Err(Error::BadRequest("invalid devserver id".into()));
    }
    let rows = state
        .cfg
        .profile_client
        .list_devserver_grants(user.id, &devserver_id)
        .await?;
    Ok(Json(rows))
}

async fn devserver_grants_delete(
    State(state): State<AppState>,
    session: Session,
    Path(grant_id): Path<Uuid>,
) -> Result<StatusCode> {
    let user = current_active_user(&state, &session).await?;
    // Pass the session user as owner_id; profile's DELETE filters on
    // `id = $1 AND owner_user_id = $2`, so a bug here cannot let
    // user A revoke user B's grant; 404 from profile instead.
    let pending = state
        .cfg
        .profile_client
        .delete_devserver_grant(user.id, grant_id)
        .await?;
    Ok(if pending {
        StatusCode::ACCEPTED
    } else {
        StatusCode::NO_CONTENT
    })
}

async fn devservers_owned(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<Vec<OwnedDevserverSummary>>> {
    let user = current_active_user(&state, &session).await?;
    let rows = state
        .cfg
        .profile_client
        .list_owned_devservers(user.id)
        .await?;
    Ok(Json(rows))
}

async fn devservers_incoming(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<Vec<IncomingShare>>> {
    let user = current_active_user(&state, &session).await?;
    let rows = state
        .cfg
        .profile_client
        .list_incoming_shares(user.id)
        .await?;
    Ok(Json(rows))
}

/// Shape-only validator; profile re-checks. 1-64 chars, lowercase
/// ascii alnum + `[._-]`, with `.` / `..` / leading-dot rejected to
/// match the canonical rule in profile-service. Still used by the
/// transitional open + share-landing routes, where the path segment is
/// a workspace/tenant name.
fn is_workspace_name_shape(s: &str) -> bool {
    let len = s.len();
    if !(1..=64).contains(&len) {
        return false;
    }
    if s == "." || s == ".." || s.starts_with('.') {
        return false;
    }
    s.bytes()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'.'))
}

/// Shape-only validator for a devserver id: 64 lowercase hex chars
/// (SHA-256 of the PAT). profile re-checks; this catches a malformed
/// path segment before the round trip.
fn is_devserver_id_shape(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

// ---------------------------------------------------------------------------
// Share landing
// ---------------------------------------------------------------------------

/// Optional devserver selector on the share landings: a full
/// devserver id or a hex prefix of one (the 12-hex disc form in
/// practice).
#[derive(Debug, Deserialize)]
struct ShareQuery {
    #[serde(default)]
    d: Option<String>,
}

/// Validate a devserver selector (`?d=` / desktop entry body): a full
/// 64-hex id or any hex prefix of one. Returns the lowercased
/// selector, or `None` for shapes that cannot match an id.
fn sanitize_disc_selector(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    s.bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        .then_some(s)
}

/// Outcome of picking one of an owner's live devservers for an
/// entry-token mint.
enum EntryTarget {
    Ok {
        devserver_id: String,
        proxy_id: String,
        /// Controller-reported base of the proxy node holding the
        /// registration. The entry mint validates it against the
        /// configured proxy namespace and builds the tenant origin
        /// from it; identity never derives a host on its own.
        proxy_base_url: String,
    },
    /// No live tunnel matches: none at all, none matching the
    /// selector, or an ambiguous disc prefix.
    Offline,
    /// Live target(s) exist but the caller holds no grant on any.
    Denied,
}

/// Pick which of the owner's live devservers an entry mint targets.
///
/// `selector` is an explicit devserver id or a hex prefix of one (the
/// share landings' `?d=`, the desktop entry body's `devserver_id`);
/// it must match exactly one live id. Without a selector, a single
/// live devserver wins outright, and several live devservers resolve
/// to the first (sorted) one the caller can access, so pre-disc
/// clients keep a deterministic target. The access check runs per
/// candidate; the loop is bounded by the owner's live set (itself
/// bounded by the controller's fleet-wide devserver cap).
async fn resolve_entry_target(
    state: &AppState,
    owner_id: Uuid,
    owner_username: &str,
    caller: Uuid,
    selector: Option<&str>,
) -> Result<EntryTarget> {
    let client = &state.cfg.workspace_admin;
    let mut tunnels = client.list_owner_tunnels(owner_id).await?;
    for tunnel in &tunnels {
        crate::devserver_authority::verify_tunnel(&state.cfg.admission_lease_verifier, tunnel)
            .map_err(|error| Error::Upstream(error.to_string()))?;
        if tunnel.owner_user_id != owner_id || tunnel.user != owner_username {
            return Err(Error::Upstream(
                "controller returned a tunnel for the wrong owner".into(),
            ));
        }
    }
    if let Some(sel) = selector {
        tunnels.retain(|t| t.devserver_id.starts_with(sel));
        if tunnels.len() > 1 {
            return Ok(EntryTarget::Offline);
        }
    }
    if tunnels.is_empty() {
        return Ok(EntryTarget::Offline);
    }
    for t in tunnels {
        if state
            .cfg
            .profile_client
            .devserver_access(owner_id, &t.devserver_id, caller)
            .await?
            .is_some()
        {
            return Ok(EntryTarget::Ok {
                devserver_id: t.devserver_id,
                proxy_id: t.proxy_id,
                proxy_base_url: t.proxy_base_url,
            });
        }
    }
    Ok(EntryTarget::Denied)
}

/// Public entry point for a copied per-tenant share link
/// (`/s/{owner}/{workspace}`), optionally `?d=`-qualified to pick one
/// of the owner's devservers.
///
/// Flow:
///   1. If the caller has no session, stash the path and 303 to `/` so
///      the SPA shows the OAuth picker. The callback reads the stash and
///      303s back here after sign-in.
///   2. With a session, resolve `{owner}` (username -> User), read the
///      owner's LIVE devserver_id from the proxy admin tunnel list, and
///      call profile `devserver_access?as=<self>` on it. Owner and grantee
///      both return a role; no-access (or no live devserver) returns 404.
///      A grant gives the WHOLE devserver.
///   3. On access, mint an entry JWT (drv = the devserver_id) against
///      the tenant origin built from the controller row's node base
///      (`{owner}--{disc}.{proxy}.<apex>`) and return an auto-submitting,
///      no-store POST handoff so it sets gate cookies and serves the signed
///      `/{workspace}/` target.
async fn share_landing(
    State(state): State<AppState>,
    session: Session,
    Path((owner, workspace)): Path<(String, String)>,
    Query(query): Query<ShareQuery>,
) -> Result<Response> {
    let owner = owner.trim().to_ascii_lowercase();
    let workspace = workspace.trim().to_ascii_lowercase();
    if !valid_username(&owner) || !is_workspace_name_shape(&workspace) {
        return Err(Error::NotFound);
    }
    // An explicit selector that cannot match any id is a dead link:
    // same 404 shape as unknown/no-access below.
    let selector = match query.d.as_deref() {
        None => None,
        Some(raw) => Some(sanitize_disc_selector(raw).ok_or(Error::NotFound)?),
    };

    // Unauthenticated: stash + send to login. Use a 303 (See Other)
    // so a refresh on the SPA root doesn't re-trigger the share flow.
    let uid = session
        .get::<Uuid>(KEY_USER)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session get: {e}")))?;
    let Some(uid) = uid else {
        // The sanitized selector rides the stash so a `?d=`-qualified
        // link survives the sign-in round trip (hex only, safe to
        // embed).
        let dest = match &selector {
            Some(d) => format!("/s/{owner}/{workspace}?d={d}"),
            None => format!("/s/{owner}/{workspace}"),
        };
        session
            .insert(KEY_POST_LOGIN_REDIRECT, &dest)
            .await
            .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert: {e}")))?;
        return Ok(Redirect::to("/").into_response());
    };

    // Resolve the owner handle. 404 is the same shape as "no access" and
    // "unknown devserver", so a stranger cannot probe a handle's existence.
    let owner_user = state
        .cfg
        .profile_client
        .find_user_by_username(&owner)
        .await?
        .ok_or(Error::NotFound)?;

    // Pick the target devserver (selector, single live, or first
    // accessible). Offline, ambiguous, and no-access all collapse to
    // 404 so a probe cannot tell the cases apart.
    let target = resolve_entry_target(
        &state,
        owner_user.id,
        &owner_user.username,
        uid,
        selector.as_deref(),
    )
    .await?;
    let (devserver_id, proxy_id, proxy_base_url) = match target {
        EntryTarget::Ok {
            devserver_id,
            proxy_id,
            proxy_base_url,
        } => (devserver_id, proxy_id, proxy_base_url),
        EntryTarget::Offline | EntryTarget::Denied => {
            tracing::info!(
                owner = %owner_user.username,
                workspace = %workspace,
                caller = %uid,
                "share landing: no accessible live devserver target",
            );
            return Err(Error::NotFound);
        }
    };

    // The tenant origin comes from the controller row's node base, not
    // from the shared apex: a row identity cannot place inside the
    // configured proxy namespace is an upstream failure, never a mint.
    let tenant = state
        .cfg
        .tenant_origin_for(
            &owner_user.username,
            &devserver_id,
            &proxy_id,
            &proxy_base_url,
        )
        .map_err(|e| Error::Upstream(e.to_string()))?;
    let tenant_url: url::Url = tenant
        .origin
        .parse()
        .map_err(|e| Error::Upstream(format!("invalid resolved tenant origin: {e}")))?;
    let aud = chan_tunnel_proto::gateway_assertion::canonical_audience(
        tenant_url.scheme(),
        &tenant.authority,
    );
    let token = gateway_common::devserver_gate::encode_entry(
        &state.cfg.entry_signer,
        uid,
        owner_user.id,
        &devserver_id,
        &aud,
        &proxy_id,
        &format!("/{workspace}/"),
    )
    .map_err(|e| Error::Anyhow(anyhow::anyhow!("mint entry token: {e}")))?;

    tracing::info!(
        owner = %owner_user.username,
        workspace = %workspace,
        caller = %uid,
        devserver_id = %devserver_id,
        "share landing: minting entry token",
    );

    entry_handoff_response(&tenant.origin, &token)
}

/// Whole-devserver open: land the caller on the launcher served at the
/// devserver ROOT. Same flow as `share_landing` minus the `/{workspace}`
/// segment: resolve the owner's one live devserver, check access (owner
/// or grantee), mint an entry JWT (`drv` = that devserver_id) against
/// the owning node's tenant origin, and 303 to that node's ROOT
/// through a body-only POST handoff so the proxy sets its gate cookies and
/// forwards `/` to the launcher. The
/// per-workspace `share_landing` above is the same shape with a tenant path.
async fn share_landing_root(
    State(state): State<AppState>,
    session: Session,
    Path(owner): Path<String>,
    Query(query): Query<ShareQuery>,
) -> Result<Response> {
    let owner = owner.trim().to_ascii_lowercase();
    if !valid_username(&owner) {
        return Err(Error::NotFound);
    }
    let selector = match query.d.as_deref() {
        None => None,
        Some(raw) => Some(sanitize_disc_selector(raw).ok_or(Error::NotFound)?),
    };

    // Unauthenticated: stash + send to login. 303 so a refresh on the SPA
    // root doesn't re-trigger the open flow.
    let uid = session
        .get::<Uuid>(KEY_USER)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session get: {e}")))?;
    let Some(uid) = uid else {
        let dest = match &selector {
            Some(d) => format!("/s/{owner}?d={d}"),
            None => format!("/s/{owner}"),
        };
        session
            .insert(KEY_POST_LOGIN_REDIRECT, &dest)
            .await
            .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert: {e}")))?;
        return Ok(Redirect::to("/").into_response());
    };

    // Resolve the owner handle. 404 is the same shape as "no access" and
    // "unknown devserver", so a stranger cannot probe a handle's existence.
    let owner_user = state
        .cfg
        .profile_client
        .find_user_by_username(&owner)
        .await?
        .ok_or(Error::NotFound)?;

    // Whole-devserver launcher mutation is owner-only. Grantees keep the
    // per-workspace share landings (`/s/{owner}/{workspace}`).
    if uid != owner_user.id {
        return Err(Error::NotFound);
    }

    // Pick the target devserver (selector, single live, or first
    // accessible); its id is the drv claim. Offline and ambiguous
    // collapse to 404 (same shape as no-access).
    let target = resolve_entry_target(
        &state,
        owner_user.id,
        &owner_user.username,
        uid,
        selector.as_deref(),
    )
    .await?;
    let (devserver_id, proxy_id, proxy_base_url) = match target {
        EntryTarget::Ok {
            devserver_id,
            proxy_id,
            proxy_base_url,
        } => (devserver_id, proxy_id, proxy_base_url),
        EntryTarget::Offline | EntryTarget::Denied => {
            tracing::info!(
                owner = %owner_user.username,
                caller = %uid,
                "whole-devserver landing: no accessible live devserver target",
            );
            return Err(Error::NotFound);
        }
    };

    // Same fail-closed rule as the per-workspace landing: the tenant
    // origin comes from the controller row's node base, and a row
    // outside the configured proxy namespace is an upstream failure.
    let tenant = state
        .cfg
        .tenant_origin_for(
            &owner_user.username,
            &devserver_id,
            &proxy_id,
            &proxy_base_url,
        )
        .map_err(|e| Error::Upstream(e.to_string()))?;
    let tenant_url: url::Url = tenant
        .origin
        .parse()
        .map_err(|e| Error::Upstream(format!("invalid resolved tenant origin: {e}")))?;
    let aud = chan_tunnel_proto::gateway_assertion::canonical_audience(
        tenant_url.scheme(),
        &tenant.authority,
    );
    let token = gateway_common::devserver_gate::encode_entry(
        &state.cfg.entry_signer,
        uid,
        owner_user.id,
        &devserver_id,
        &aud,
        &proxy_id,
        "/",
    )
    .map_err(|e| Error::Anyhow(anyhow::anyhow!("mint entry token: {e}")))?;

    tracing::info!(
        owner = %owner_user.username,
        caller = %uid,
        devserver_id = %devserver_id,
        "whole-devserver landing: minting entry token",
    );

    entry_handoff_response(&tenant.origin, &token)
}

fn entry_handoff_response(proxy_origin: &str, credential: &str) -> Result<Response> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use rand::RngCore;

    let mut nonce_bytes = [0_u8; 18];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
    let action = format!(
        "{}{}",
        proxy_origin.trim_end_matches('/'),
        gateway_common::devserver_gate::ENTRY_EXCHANGE_PATH,
    );
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"></head>\
         <body><form method=\"post\" action=\"{}\"><input type=\"hidden\" name=\"credential\" value=\"{}\"></form>\
         <script nonce=\"{}\">document.forms[0].submit()</script></body></html>",
        crate::pages::html_escape(&action),
        crate::pages::html_escape(credential),
        nonce,
    );
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{nonce}'; form-action {proxy_origin}; base-uri 'none'; frame-ancestors 'none'"
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CONTENT_SECURITY_POLICY, csp)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(axum::body::Body::from(body))
        .map_err(|error| Error::Anyhow(error.into()))
}

pub(crate) const DESKTOP_CONNECT_SCOPE: &str = "desktop.connect";

/// Account-level desktop scope: one PAT for the whole account, read
/// via the roster endpoint (`crate::desktop_roster`) and accepted by
/// the entry mint below. Sole-scope by the authorize flow's rule
/// (`desktop_authorize::validate`).
pub(crate) const DESKTOP_ACCOUNT_SCOPE: &str = "desktop.account";

/// The dial scope: a PAT carrying it can register on chan-tunnel, so
/// it IS a devserver (`devserver_id` = sha256 of the PAT is the
/// tunnel-registry key). This is what gates devserver-row
/// registration at every mint site ([`register_devserver_row`]).
pub(crate) const TUNNEL_SCOPE: &str = "tunnel";

/// Register the devserver row for a freshly minted PAT. One shared
/// path for every mint site (SPA, operator, desktop authorize): a PAT
/// is a devserver ONLY when it can dial, so a row is registered iff
/// `scopes` carries [`TUNNEL_SCOPE`] -- a desktop.account or
/// desktop.connect mint registers nothing (its id can never appear in
/// the tunnel registry, so a row would be a phantom in the dashboard
/// and the desktop roster). Best-effort: the row also auto-creates on
/// first grant, and the PAT is already persisted, so a profile hiccup
/// must not fail the mint (warn only).
pub(crate) async fn register_devserver_row(
    state: &AppState,
    user_id: Uuid,
    secret: &str,
    label: &str,
    scopes: &[String],
) {
    if !scopes.iter().any(|s| s == TUNNEL_SCOPE) {
        return;
    }
    let devserver_id = crate::api_tokens::devserver_id_from_pat(secret);
    if let Err(e) = state
        .cfg
        .profile_client
        .create_devserver(user_id, &devserver_id, label)
        .await
    {
        tracing::warn!(error = ?e, user = %user_id, "register devserver after PAT mint failed");
    }
}

/// Stable failure-reason tokens for the desktop entry 404 body. A
/// de-facto desktop API like the `desktop_authorize` `?error=` reasons:
/// the desktop branches on these to narrate the failure, so keep them
/// short and never repurpose one.
const ENTRY_REASON_NO_DEVSERVER: &str = "no_devserver";
const ENTRY_REASON_DEVSERVER_OFFLINE: &str = "devserver_offline";
const ENTRY_REASON_ACCESS_DENIED: &str = "access_denied";

#[derive(Debug, Deserialize)]
struct DesktopEntryBody {
    #[serde(default)]
    path: Option<String>,
    /// Optional explicit target, recorded by chan-desktop from the
    /// authorize callback's devserver pick: the devserver owner's
    /// username (absent = the caller's own devservers) and the full
    /// devserver id. Absent both = first-accessible-live fallback.
    #[serde(default)]
    owner: Option<String>,
    /// Immutable owner identity from the authenticated roster. Required for
    /// every explicit target; usernames are routing/display labels only.
    #[serde(default)]
    owner_user_id: Option<Uuid>,
    #[serde(default)]
    devserver_id: Option<String>,
}

/// Answers for ONE connection, so the fields stay singular. `username`
/// names the devserver's OWNER (the wildcard host label); it equals
/// the caller except for shared devservers targeted via `owner`.
#[derive(Serialize)]
struct DesktopEntryResponse {
    owner_user_id: Uuid,
    username: String,
    devserver_id: String,
    proxy_origin: String,
    entry_exchange_url: String,
    entry_credential: String,
    expires_at: DateTime<Utc>,
}

async fn desktop_devserver_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DesktopEntryBody>,
) -> Result<Response> {
    let token = bearer_token(&headers).ok_or(Error::Unauthorized)?;
    let validated = state
        .api_tokens
        .validate(token, &request_meta(&headers))
        .await?;
    // Either desktop scope opens the entry mint: legacy per-devserver
    // PATs carry desktop.connect, account-mode PATs desktop.account.
    // Authorization for the TARGET stays per-devserver either way
    // (the profile devserver_access check below).
    if !validated
        .scopes
        .iter()
        .any(|scope| scope == DESKTOP_CONNECT_SCOPE || scope == DESKTOP_ACCOUNT_SCOPE)
    {
        tracing::warn!(
            user = %validated.username,
            "desktop entry denied: no desktop scope on the token",
        );
        return Err(Error::Unauthorized);
    }

    // Resolve the target owner: an explicit `owner` names a devserver
    // shared with the caller; absent = the caller's own. Unknown
    // owner reads as access_denied so the desktop clears its stored
    // selection without learning whether the handle exists.
    let explicit_target =
        body.owner.is_some() || body.owner_user_id.is_some() || body.devserver_id.is_some();
    let (owner_id, owner_username) = if explicit_target {
        let owner_id = body
            .owner_user_id
            .ok_or_else(|| Error::DesktopEntryNotFound {
                reason: ENTRY_REASON_ACCESS_DENIED,
                username: body.owner.clone().unwrap_or_default(),
                label: None,
            })?;
        if body.devserver_id.is_none() {
            return Err(Error::DesktopEntryNotFound {
                reason: ENTRY_REASON_DEVSERVER_OFFLINE,
                username: body.owner.clone().unwrap_or_default(),
                label: None,
            });
        }
        if owner_id == validated.user_id {
            (validated.user_id, validated.username.clone())
        } else {
            let owner_user = state
                .cfg
                .profile_client
                .get_user(owner_id)
                .await?
                .ok_or_else(|| Error::DesktopEntryNotFound {
                    reason: ENTRY_REASON_ACCESS_DENIED,
                    username: body.owner.clone().unwrap_or_default(),
                    label: None,
                })?;
            (owner_user.id, owner_user.username)
        }
    } else {
        (validated.user_id, validated.username.clone())
    };
    let selector = match body.devserver_id.as_deref() {
        None => None,
        Some(raw) => {
            Some(
                sanitize_disc_selector(raw).ok_or_else(|| Error::DesktopEntryNotFound {
                    reason: ENTRY_REASON_DEVSERVER_OFFLINE,
                    username: owner_username.clone(),
                    label: None,
                })?,
            )
        }
    };

    let target = resolve_entry_target(
        &state,
        owner_id,
        &owner_username,
        validated.user_id,
        selector.as_deref(),
    )
    .await?;
    let (devserver_id, proxy_id, proxy_base_url) = match target {
        EntryTarget::Ok {
            devserver_id,
            proxy_id,
            proxy_base_url,
        } => (devserver_id, proxy_id, proxy_base_url),
        EntryTarget::Offline if explicit_target => {
            return Err(Error::DesktopEntryNotFound {
                reason: ENTRY_REASON_DEVSERVER_OFFLINE,
                username: owner_username,
                label: None,
            });
        }
        EntryTarget::Offline => {
            tracing::info!(
                user = %validated.username,
                "desktop entry: no live tunnel",
            );
            return Err(desktop_entry_no_tunnel(&state, &validated).await);
        }
        EntryTarget::Denied => {
            return Err(Error::DesktopEntryNotFound {
                reason: ENTRY_REASON_ACCESS_DENIED,
                username: owner_username,
                label: None,
            });
        }
    };

    let path = validate_desktop_entry_path(body.path.as_deref())?;
    // The desktop pins this exact origin as its sole native-authority
    // source, so it must come from the controller row's node base:
    // a row outside the configured proxy namespace is an upstream
    // failure, never a fallback to the shared apex.
    let tenant = state
        .cfg
        .tenant_origin_for(&owner_username, &devserver_id, &proxy_id, &proxy_base_url)
        .map_err(|e| Error::Upstream(e.to_string()))?;
    let tenant_url: url::Url = tenant
        .origin
        .parse()
        .map_err(|e| Error::Upstream(format!("invalid resolved tenant origin: {e}")))?;
    let aud = chan_tunnel_proto::gateway_assertion::canonical_audience(
        tenant_url.scheme(),
        &tenant.authority,
    );
    let entry_token = gateway_common::devserver_gate::encode_entry(
        &state.cfg.entry_signer,
        validated.user_id,
        owner_id,
        &devserver_id,
        &aud,
        &proxy_id,
        &path,
    )
    .map_err(|e| Error::Anyhow(anyhow::anyhow!("mint desktop entry token: {e}")))?;
    let proxy_origin = tenant.origin;
    let entry_exchange_url = format!(
        "{}{}",
        proxy_origin.trim_end_matches('/'),
        gateway_common::devserver_gate::ENTRY_EXCHANGE_PATH,
    );
    tracing::info!(
        user = %validated.username,
        owner = %owner_username,
        devserver_id = %devserver_id,
        path = %path,
        "desktop entry: minted entry credential",
    );
    let mut response = Json(DesktopEntryResponse {
        owner_user_id: owner_id,
        username: owner_username,
        devserver_id,
        proxy_origin,
        entry_exchange_url,
        entry_credential: entry_token,
        expires_at: Utc::now() + chrono::Duration::seconds(30),
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    Ok(response)
}

/// Classify a no-live-tunnel desktop entry for the 404 body: no
/// devserver registered at all vs registered but not currently
/// connected. Best-effort: a failed owned-devserver lookup degrades to
/// the plain 404 so the narration never changes the endpoint's failure
/// mode.
async fn desktop_entry_no_tunnel(state: &AppState, validated: &ValidatedToken) -> Error {
    let owned = match state
        .cfg
        .profile_client
        .list_owned_devservers(validated.user_id)
        .await
    {
        Ok(owned) => owned,
        Err(e) => {
            tracing::warn!(
                user = %validated.username,
                error = %e,
                "desktop entry: owned-devserver lookup failed",
            );
            return Error::NotFound;
        }
    };
    let (reason, label) = match owned.into_iter().next() {
        Some(d) => (ENTRY_REASON_DEVSERVER_OFFLINE, Some(d.label)),
        None => (ENTRY_REASON_NO_DEVSERVER, None),
    };
    Error::DesktopEntryNotFound {
        reason,
        username: validated.username.clone(),
        label,
    }
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

fn validate_desktop_entry_path(path: Option<&str>) -> Result<String> {
    let path = path.unwrap_or("/").trim();
    if path.is_empty()
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains("://")
        || path.contains('\r')
        || path.contains('\n')
    {
        return Err(Error::BadRequest("invalid entry path".into()));
    }
    Ok(path.to_string())
}

async fn internal_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> std::result::Result<Response, Error> {
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match provided {
        Some(t) if ct_eq(t, &state.cfg.internal_auth_token) => Ok(next.run(request).await),
        _ => Err(Error::Unauthorized),
    }
}

/// Gate for the /admin/v1/* operator surface. An empty
/// IDENTITY_ADMIN_TOKEN disables the surface outright: 404, exactly
/// what an unknown route answers, so a probe cannot tell a disabled
/// deployment from one without the routes. With the surface enabled,
/// a wrong or missing bearer is a plain 401.
async fn admin_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> std::result::Result<Response, Error> {
    let expected = &state.cfg.identity_admin_token;
    if expected.is_empty() {
        return Err(Error::NotFound);
    }
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match provided {
        Some(t) if ct_eq(t, expected) => Ok(next.run(request).await),
        _ => Err(Error::Unauthorized),
    }
}

#[derive(Debug, Deserialize)]
struct AdminCreateTokenBody {
    email: String,
    /// Scopes to grant. Absent/empty falls back to
    /// `DEFAULT_TOKEN_SCOPES` (`["tunnel"]`), matching the SPA mint;
    /// shape validation (blank / oversized / duplicate entries) is
    /// the same `ApiTokenService::create` pass the SPA path runs.
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    label: Option<String>,
    /// Lifetime in days. Absent = the token never expires (operator
    /// surface; the browser-flow clamp does not apply).
    #[serde(default)]
    expires_days: Option<u32>,
}

/// `POST /admin/v1/tokens` -- mint a PAT for a user by email, without
/// a browser flow. Provisioning surface for chan-gateway-admin; the
/// response is the same one-time `CreatedTokenView` the SPA mint
/// answers, secret included.
async fn admin_tokens_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AdminCreateTokenBody>,
) -> Result<(StatusCode, Json<CreatedTokenView>)> {
    let uid = state
        .api_tokens
        .user_id_by_email(&body.email)
        .await?
        .ok_or(Error::NotFound)?;
    let scopes: Vec<String> = match body.scopes {
        Some(ref s) if !s.is_empty() => s.clone(),
        _ => DEFAULT_TOKEN_SCOPES
            .iter()
            .map(|s| (*s).to_string())
            .collect(),
    };
    let label = body.label.as_deref().unwrap_or("admin mint");
    let expires_at = body
        .expires_days
        .filter(|d| *d > 0)
        .map(|d| Utc::now() + chrono::Duration::days(i64::from(d)));
    let CreatedToken { token, secret } = state
        .api_tokens
        .create(
            NewToken {
                user_id: uid,
                label,
                expires_at,
                scopes: &scopes,
                origin: TokenOrigin::Admin,
            },
            &request_meta(&headers),
        )
        .await?;

    // Same gated path the SPA mint takes: a PAT is a devserver only
    // when it can dial (tunnel scope), so an operator minting e.g. a
    // desktop.account PAT registers no row.
    register_devserver_row(&state, uid, &secret, label, &scopes).await;

    Ok((
        StatusCode::CREATED,
        Json(CreatedTokenView {
            token: token.into(),
            secret,
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct ValidateBody {
    token: String,
    /// Both fields are required for a tunnel admission validation and
    /// omitted together on the post-registration display-name refresh.
    #[serde(default)]
    proxy_id: Option<devserver_control_proto::ProxyId>,
    #[serde(default)]
    registration_id: Option<Uuid>,
    /// Optional display name the devserver announced in its tunnel
    /// `Hello` (devserver-proxy forwards it as a follow-up validate
    /// once the registration is accepted). When present, it refreshes
    /// the devserver row's label.
    #[serde(default)]
    name: Option<String>,
}

async fn validate_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ValidateBody>,
) -> Result<Json<ValidatedToken>> {
    // Reject garbage before touching the throttle map. Otherwise every
    // random fingerprint takes a bucket slot under the LRU cap and an
    // attacker spamming malformed tokens can evict legitimate
    // fingerprints' state. A real PAT starts with `chan_pat_`; the same
    // 401 we'd return on "throttled" / "unknown token" keeps the shape
    // indistinguishable on the wire.
    if !body.token.starts_with("chan_pat_") {
        return Err(Error::Unauthorized);
    }
    // Per-token-fingerprint rate limit before the DB lookup. Same
    // shape as devserver-proxy's outer throttle: a throttled call comes
    // back as the same 401 an unknown-token call returns, so the
    // throttle is not observable on the wire. See the module doc
    // for the threat model.
    if !state.token_throttle.try_admit(&body.token) {
        tracing::warn!("internal validate_token throttled");
        return Err(Error::Unauthorized);
    }
    // chan-tunnel forwards the originating client IP via
    // X-Forwarded-For; we record that as the validate-IP for audit.
    let meta = request_meta(&headers);
    let v = match (body.proxy_id, body.registration_id) {
        (Some(proxy_id), Some(registration_id)) if !registration_id.is_nil() => {
            state
                .api_tokens
                .validate_for_admission(&body.token, proxy_id, registration_id, &meta)
                .await?
        }
        (None, None) if body.name.is_some() => {
            state.api_tokens.validate(&body.token, &meta).await?
        }
        _ => {
            return Err(Error::BadRequest(
                "proxy_id and non-nil registration_id are required for admission".into(),
            ))
        }
    };
    // A tunnel-announced display name refreshes the devserver row's
    // label through the same gated upsert every mint site uses
    // (tunnel scope only, best-effort). Sanitized to the label bound
    // so profile never has to reject it; the upsert dedups within the
    // owner's rows.
    if let Some(name) = body
        .name
        .as_deref()
        .and_then(sanitize_devserver_display_name)
    {
        register_devserver_row(&state, v.user_id, &body.token, &name, &v.scopes).await;
    }
    Ok(Json(v))
}

/// Sanitize a tunnel-announced display name: drop invisible/spoofing
/// code points, map control characters to spaces, collapse whitespace,
/// and cap at profile's 64-byte label bound (on a char boundary).
/// `None` for a value that is blank after filtering. Defense in depth
/// against modified clients: a well-behaved client (`chan devserver`)
/// already strips control characters and applies the same bound, but
/// this name renders cross-user in grantees' rosters, so the
/// persistence sink filters too.
fn sanitize_devserver_display_name(raw: &str) -> Option<String> {
    const MAX: usize = 64;
    // Zero-width space/joiner/non-joiner, ZWNBSP (BOM), and the bidi
    // embedding/override/isolate controls: invisible or
    // order-mangling, so dropped outright (a space would add a
    // visible gap mid-word). Control characters (C0/C1 via
    // `is_control`, covers ANSI escapes) map to a space instead so
    // words stay separated, then whitespace runs collapse.
    let invisible = |c: char| {
        matches!(
            c,
            '\u{200B}'..='\u{200D}' | '\u{FEFF}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
    };
    let mapped: String = raw
        .chars()
        .filter(|c| !invisible(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let mut end = MAX.min(collapsed.len());
    while !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    Some(collapsed[..end].trim_end().to_string())
}

/// Bundle the audit-only request context (`client_ip` + `user_agent`)
/// for `ApiTokenService` calls.
pub(crate) fn request_meta(headers: &HeaderMap) -> RequestMeta {
    RequestMeta {
        ip: client_ip(headers),
        user_agent: user_agent(headers),
    }
}

pub(crate) fn client_ip(headers: &HeaderMap) -> Option<String> {
    // Production sits behind a reverse proxy that sets
    // X-Forwarded-For; in dev/test the header is absent and we
    // store NULL in the audit row. Stored as text so we don't
    // pull in the sqlx ipnetwork feature for an audit-only field.
    //
    // Trust boundary: the value is audit-only. *Never* use it for
    // authorization. If the service is ever reachable without nginx
    // in front, an attacker can spoof XFF and forge audit rows.
    // Operators must terminate XFF at nginx and either drop or
    // rewrite any inbound XFF so the chain we see comes only from
    // trusted hops.
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn user_agent(headers: &HeaderMap) -> Option<String> {
    // Truncate at 256 *bytes* on a UTF-8 boundary, not chars. A 256-
    // char limit lets a UA string with 4-byte code points reach
    // ~1 KiB in the DB row, which serves no purpose. UA strings in
    // the wild are ASCII so the typical path is char_indices = byte
    // indices anyway; this only matters for adversarial inputs.
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            const MAX: usize = 256;
            if s.len() <= MAX {
                s.to_string()
            } else {
                // Walk back to the nearest UTF-8 boundary at or before MAX.
                let mut end = MAX;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                s[..end].to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_entry_path_accepts_single_slash_paths() {
        // The desktop's window-entry mint sends `/{prefix}/index.html` with
        // the prefix normalized to exactly one leading slash
        // (chan-desktop `window_entry_path`); this pins the accept side of
        // that contract.
        for ok in ["/", "/api/x/index.html", "/notes/index.html?w=abc"] {
            assert_eq!(
                validate_desktop_entry_path(Some(ok)).unwrap(),
                ok,
                "{ok} should validate"
            );
        }
        // An omitted path defaults to the devserver root, and surrounding
        // whitespace is trimmed before validation (the trimmed value is
        // what the entry URL is built from).
        assert_eq!(validate_desktop_entry_path(None).unwrap(), "/");
        assert_eq!(validate_desktop_entry_path(Some(" /x \n")).unwrap(), "/x");
    }

    #[test]
    fn desktop_entry_path_rejects_relative_and_url_shaped_paths() {
        for bad in [
            "",
            "  ",
            "api/x/index.html",
            "//evil.example/x",
            "https://evil.example/x",
            "/x\r\nHeader: y",
        ] {
            assert!(
                validate_desktop_entry_path(Some(bad)).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn desktop_entry_response_pins_full_identity_and_exact_origin_fields() {
        let full_id = "a".repeat(64);
        let proxy_origin = "https://alice--aaaaaaaaaaaa.p1.usr.chan.app";
        let response = DesktopEntryResponse {
            owner_user_id: Uuid::nil(),
            username: "alice".to_string(),
            devserver_id: full_id.clone(),
            proxy_origin: proxy_origin.to_string(),
            entry_exchange_url: format!(
                "{proxy_origin}{}",
                gateway_common::devserver_gate::ENTRY_EXCHANGE_PATH
            ),
            entry_credential: "entry".to_string(),
            expires_at: Utc::now() + chrono::Duration::seconds(30),
        };
        let wire = serde_json::to_value(response).unwrap();
        assert_eq!(wire["username"], "alice");
        assert_eq!(wire["devserver_id"], full_id);
        assert_eq!(wire["proxy_origin"], proxy_origin);
        let entry_url = wire["entry_exchange_url"].as_str().unwrap();
        assert_eq!(
            url::Url::parse(entry_url)
                .unwrap()
                .origin()
                .ascii_serialization(),
            proxy_origin
        );
        assert_eq!(wire["entry_credential"], "entry");
        assert!(entry_url.split('?').nth(1).is_none());
        assert!(wire.get("entry_url").is_none());
        assert!(wire.get("expires_at").is_some());
    }

    #[test]
    fn devserver_display_name_sanitizes_to_the_label_bound() {
        // Trim; blank reads as absent.
        assert_eq!(
            sanitize_devserver_display_name("  office box  ").as_deref(),
            Some("office box")
        );
        assert_eq!(sanitize_devserver_display_name("   "), None);
        assert_eq!(sanitize_devserver_display_name(""), None);
        // Cap at 64 bytes so profile's label validation never rejects
        // the upsert; multi-byte chars are dropped whole.
        let long = "x".repeat(80);
        assert_eq!(
            sanitize_devserver_display_name(&long).as_deref(),
            Some("x".repeat(64).as_str())
        );
        let mut tricky = "x".repeat(63);
        tricky.push('é');
        assert_eq!(
            sanitize_devserver_display_name(&tricky).as_deref(),
            Some("x".repeat(63).as_str())
        );
    }

    #[test]
    fn devserver_display_name_filters_control_and_invisible_chars() {
        // The name renders cross-user in grantees' rosters; a modified
        // client must not smuggle in terminal escapes, unit-breaking
        // newlines, or spoofing code points.
        // Control characters map to spaces; runs collapse.
        assert_eq!(
            sanitize_devserver_display_name("office\r\nbox").as_deref(),
            Some("office box")
        );
        // ANSI escape: the ESC byte is a control character.
        assert_eq!(
            sanitize_devserver_display_name("a\u{1b}[31mb").as_deref(),
            Some("a [31mb")
        );
        // Bidi override / isolates are dropped outright.
        assert_eq!(
            sanitize_devserver_display_name("abc\u{202E}def").as_deref(),
            Some("abcdef")
        );
        assert_eq!(
            sanitize_devserver_display_name("x\u{2066}y\u{2069}z").as_deref(),
            Some("xyz")
        );
        // Zero-width space/joiner/non-joiner and ZWNBSP are dropped.
        assert_eq!(
            sanitize_devserver_display_name("of\u{200B}f\u{200C}i\u{200D}ce\u{FEFF}").as_deref(),
            Some("office")
        );
        // Nothing left after filtering reads as no name.
        assert_eq!(
            sanitize_devserver_display_name("\u{200B}\u{1b}\u{FEFF}"),
            None
        );
        // Plain unicode survives: accents, CJK, emoji.
        assert_eq!(
            sanitize_devserver_display_name("café 東京 🚀").as_deref(),
            Some("café 東京 🚀")
        );
    }

    #[test]
    fn session_cookie_name_is_host_prefixed_only_when_secure() {
        assert_eq!(session_cookie_name(true), "__Host-id_session");
        // Browsers reject `__Host-` without Secure; the insecure dev
        // name must be visibly distinct from the production one.
        assert_eq!(session_cookie_name(false), "id_session_insecure_dev");
    }
}
