//! OAuth-style PAT mint for the Chan mobile app, over the registered
//! custom-scheme callback `chan://auth/callback` with PKCE.
//!
//! The mobile app generates a PKCE `code_verifier` in-process and opens
//! an `ASWebAuthenticationSession` sheet at `/mobile/authorize` with its
//! S256 `code_challenge` and `redirect_uri=chan://auth/callback`. After
//! OAuth sign-in and consent on the gateway origin, identity mints a
//! `mobile.account` PAT, stashes it in `state.mobile_redemptions` under a
//! one-time code bound to the challenge, and answers a handoff page that
//! navigates to `chan://auth/callback?code=&state=`. The app intercepts
//! that navigation in-process and exchanges `{code, code_verifier}` over
//! TLS at `POST /mobile/authorize/redeem`.
//!
//! Four routes:
//!
//!   * `GET  /mobile/authorize?<query>` -- entry point. Validates the
//!     query (`redirect_uri` pinned to `chan://auth/callback`,
//!     `code_challenge` + `S256` method, `state`, `label`, sole scope
//!     `mobile.account`, `expires_in`, and absence of
//!     `wireguard_public_key`), clears any pending desktop authorize
//!     stash in the session, stashes [`AuthorizeParams`] under
//!     `mobile_authorize`, and redirects: to `/` if unauthenticated, or
//!     straight to `/mobile/authorize/consent` if authenticated.
//!   * `GET  /mobile/authorize/consent` -- renders the mobile HTML
//!     consent page in the shared [`crate::pages`] shell with a fresh
//!     CSRF nonce stored under `mobile_csrf`.
//!   * `POST /mobile/authorize/confirm` -- handles `allow` / `deny`.
//!     Consumes the CSRF nonce and pending params; on `allow` mints a
//!     PAT with [`TokenOrigin::Mobile`], inserts it into
//!     `state.mobile_redemptions`, and returns a 200 handoff page
//!     navigating to `chan://auth/callback?code=&state=` (`deny` and
//!     blocked accounts carry `?error=&state=`).
//!   * `POST /mobile/authorize/redeem` -- swaps `{code, code_verifier}`
//!     against `state.mobile_redemptions` only, writes the
//!     `mobile.redeem` audit row, and returns `{id, secret, label,
//!     expires_at}`. Codes in `desktop_redemptions` are never visible
//!     here and vice versa.

use axum::extract::{Form, Query, State};
use axum::http::HeaderMap;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tower_sessions::Session;
use url::form_urlencoded::byte_serialize;
use url::Url;
use uuid::Uuid;

use crate::api_tokens::{CreatedToken, NewToken, TokenOrigin, ACTION_MOBILE_REDEEM};
use crate::desktop_authorize::{
    generate_csrf, humanize_expires, valid_code_challenge, Handoff, RedeemPayload,
};
use crate::error::{Error, Result};
use crate::http::{
    current_user_id, current_user_id_optional, request_meta, AppState, MOBILE_ACCOUNT_SCOPE,
};
use crate::pages;
use crate::profile_client::User;

/// Session key under which `/mobile/authorize` stashes pending params.
const KEY_MOBILE_AUTHORIZE: &str = "mobile_authorize";

/// Session key for the mobile consent-form CSRF nonce.
const KEY_MOBILE_CSRF: &str = "mobile_csrf";

/// The single registered mobile callback URI.
const MOBILE_CALLBACK_URI: &str = "chan://auth/callback";

/// The single path the mobile `redirect_uri` may carry.
const MOBILE_CALLBACK_PATH: &str = "/callback";

/// Floor on mobile credential lifetimes (60 seconds).
const MIN_EXPIRES_IN_SECS: i64 = 60;

/// Ninety-day ceiling on mobile credentials (7,776,000 seconds).
const MAX_EXPIRES_IN_SECS: i64 = 90 * 86_400;

/// Maximum length of the echoed `state` nonce (ASCII graphic bytes).
const MAX_STATE_LEN: usize = 256;

/// Path the mobile consent page lives at. Exported so `auth_callback`
/// can redirect without repeating the literal.
pub const CONSENT_PATH: &str = "/mobile/authorize/consent";

/// What `/mobile/authorize/redeem` answers with, once per code. Mobile
/// does not offer gateway WireGuard enrollment, so no `wireguard` field
/// exists on this wire shape.
#[derive(Debug, Clone, Serialize)]
pub struct MobileRedeemPayload {
    pub id: Uuid,
    pub secret: String,
    pub label: String,
    pub expires_at: Option<DateTime<Utc>>,
}

/// Validate the registered mobile `redirect_uri` by parsed-component
/// equality against [`MOBILE_CALLBACK_URI`], plus raw-string guards for
/// whitespace, control characters, and non-double-slash scheme prefixes
/// that WHATWG URL normalization would otherwise fold.
fn validate_mobile_redirect_uri(raw: &str) -> Result<()> {
    if raw != raw.trim() || raw.bytes().any(|b| b.is_ascii_control()) {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    if !raw.starts_with("chan://") || raw.starts_with("chan:///") {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    let url = Url::parse(raw).map_err(|_| Error::BadRequest("invalid redirect_uri".into()))?;
    if url.scheme() != "chan" {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    if url.host_str() != Some("auth") {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    if url.port().is_some() {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    if url.path() != MOBILE_CALLBACK_PATH {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    Ok(())
}

/// Query shape parsed from `GET /mobile/authorize`.
#[derive(Debug, Deserialize)]
pub struct AuthorizeQuery {
    redirect_uri: String,
    state: String,
    label: String,
    code_challenge: String,
    code_challenge_method: String,
    #[serde(default)]
    scopes: Option<String>,
    expires_in: Option<i64>,
    #[serde(default)]
    wireguard_public_key: Option<String>,
}

/// Validated form of [`AuthorizeQuery`] stashed in the session across
/// the OAuth roundtrip and consent step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizeParams {
    redirect_uri: String,
    state: String,
    label: String,
    code_challenge: String,
    scopes: Vec<String>,
    expires_in_secs: i64,
}

fn validate(q: AuthorizeQuery) -> Result<AuthorizeParams> {
    validate_mobile_redirect_uri(&q.redirect_uri)?;
    if q.wireguard_public_key.is_some() {
        return Err(Error::BadRequest(
            "wireguard enrollment not supported on mobile".into(),
        ));
    }
    if q.code_challenge_method != "S256" {
        return Err(Error::BadRequest("invalid code_challenge_method".into()));
    }
    if !valid_code_challenge(&q.code_challenge) {
        return Err(Error::BadRequest("invalid code_challenge".into()));
    }
    if q.state.is_empty()
        || q.state.len() > MAX_STATE_LEN
        || !q.state.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(Error::BadRequest("invalid state".into()));
    }
    let label = q.label.trim();
    if label.is_empty() || label.len() > 64 {
        return Err(Error::BadRequest("invalid label".into()));
    }
    let raw_scopes = q.scopes.unwrap_or_default();
    let scopes: Vec<&str> = raw_scopes.split(',').map(str::trim).collect();
    if scopes.as_slice() != [MOBILE_ACCOUNT_SCOPE] {
        return Err(Error::BadRequest("invalid scopes".into()));
    }
    let expires_in_secs = match q.expires_in {
        Some(n) if n > 0 => n.clamp(MIN_EXPIRES_IN_SECS, MAX_EXPIRES_IN_SECS),
        _ => return Err(Error::BadRequest("invalid expires_in".into())),
    };
    Ok(AuthorizeParams {
        redirect_uri: MOBILE_CALLBACK_URI.to_string(),
        state: q.state,
        label: label.to_string(),
        code_challenge: q.code_challenge,
        scopes: vec![MOBILE_ACCOUNT_SCOPE.to_string()],
        expires_in_secs,
    })
}

/// Build the success callback target carrying the one-time redemption
/// code and the echoed `state` as query parameters.
pub fn success_url(params: &AuthorizeParams, code: &str) -> String {
    let mut query = String::new();
    push_pair(&mut query, "code", code);
    push_pair(&mut query, "state", &params.state);
    format!("{}?{}", params.redirect_uri, query)
}

/// Build the error callback target carrying `error` and `state` as query
/// parameters (`account_blocked`, `oauth_denied`, `user_cancelled`).
pub fn error_url(params: &AuthorizeParams, reason: &str) -> String {
    let mut query = String::new();
    push_pair(&mut query, "error", reason);
    push_pair(&mut query, "state", &params.state);
    format!("{}?{}", params.redirect_uri, query)
}

fn push_pair(buf: &mut String, key: &str, value: &str) {
    if !buf.is_empty() {
        buf.push('&');
    }
    buf.push_str(key);
    buf.push('=');
    let encoded: String = byte_serialize(value.as_bytes()).collect();
    buf.push_str(&encoded);
}

/// Peek at a pending mobile authorize without consuming it.
pub async fn peek_pending(session: &Session) -> Result<Option<AuthorizeParams>> {
    session
        .get::<AuthorizeParams>(KEY_MOBILE_AUTHORIZE)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session get mobile_authorize: {e}")))
}

/// Read and remove a pending mobile authorize.
pub async fn take_pending(session: &Session) -> Result<Option<AuthorizeParams>> {
    session
        .remove::<AuthorizeParams>(KEY_MOBILE_AUTHORIZE)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session remove mobile_authorize: {e}")))
}

/// Clear any pending mobile authorize params and CSRF nonce so a later
/// desktop authorize in the same browser session cannot collide with a
/// stale mobile stash.
pub(crate) async fn clear_pending(session: &Session) -> Result<()> {
    session
        .remove_value(KEY_MOBILE_AUTHORIZE)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session clear mobile_authorize: {e}")))?;
    session
        .remove_value(KEY_MOBILE_CSRF)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session clear mobile_csrf: {e}")))?;
    Ok(())
}

fn handoff_copy(kind: &Handoff) -> (&'static str, &'static str) {
    match kind {
        Handoff::Success => ("Authorized", "Returning you to the Chan app..."),
        Handoff::Cancelled => (
            "Request cancelled",
            "No token was issued. Returning you to the Chan app...",
        ),
        Handoff::Error => (
            "Sign-in failed",
            "Returning you to the Chan app with the details...",
        ),
    }
}

fn render_handoff_html(kind: &Handoff, target: &str) -> String {
    let (title, blurb) = handoff_copy(kind);
    let url = pages::html_escape(target);
    let head_extra = format!("<meta http-equiv=\"refresh\" content=\"0;url={url}\">\n  ");
    let body = format!(
        r#"
    <span class="mark" aria-hidden="true"></span>
    <h1>{title}</h1>
    <p class="muted">{blurb}</p>
    <a class="btn primary" href="{url}">Open Chan</a>
    <p class="muted small">You can close this tab.</p>
  "#,
    );
    pages::render(&pages::Page {
        title,
        head_extra: &head_extra,
        body: &body,
    })
}

fn handoff_response(kind: &Handoff, target: &str) -> Response {
    (
        pages::security_headers(),
        Html(render_handoff_html(kind, target)),
    )
        .into_response()
}

async fn complete(
    state: &AppState,
    headers: &HeaderMap,
    params: &AuthorizeParams,
    user: &User,
) -> Result<String> {
    let expires_at: DateTime<Utc> = Utc::now() + chrono::Duration::seconds(params.expires_in_secs);
    let CreatedToken { token, secret } = state
        .api_tokens
        .create(
            NewToken {
                user_id: user.id,
                label: &params.label,
                expires_at: Some(expires_at),
                scopes: &params.scopes,
                origin: TokenOrigin::Mobile,
            },
            &request_meta(headers),
        )
        .await
        .map_err(|e| {
            tracing::warn!(error = ?e, user = %user.username, "mobile authorize mint failed");
            e
        })?;
    crate::http::register_devserver_row(state, user.id, &secret, &params.label, &params.scopes)
        .await;
    let code = state.mobile_redemptions.insert(
        RedeemPayload {
            id: token.id,
            secret,
            label: token.label,
            expires_at: token.expires_at,
            wireguard: None,
        },
        params.code_challenge.clone(),
    );
    Ok(success_url(params, &code))
}

#[derive(Debug, Deserialize)]
pub struct RedeemRequest {
    code: String,
    code_verifier: String,
}

/// `POST /mobile/authorize/redeem` -- swap a one-time mobile code plus
/// PKCE verifier for the minted `mobile.account` PAT. Consumes strictly
/// from `state.mobile_redemptions`.
pub async fn redeem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RedeemRequest>,
) -> Result<Json<MobileRedeemPayload>> {
    let Some(payload) = state.mobile_redemptions.take(&req.code, &req.code_verifier) else {
        return Err(Error::Gone(
            "unknown, expired, or already-redeemed code".into(),
        ));
    };
    if let Err(error) = state
        .api_tokens
        .write_audit(payload.id, ACTION_MOBILE_REDEEM, &request_meta(&headers))
        .await
    {
        tracing::warn!(?error, token_id = %payload.id, "mobile redemption audit failed");
    }
    Ok(Json(MobileRedeemPayload {
        id: payload.id,
        secret: payload.secret,
        label: payload.label,
        expires_at: payload.expires_at,
    }))
}

/// `GET /mobile/authorize` -- validate query, clear any stale desktop
/// authorize stash, stash mobile params, and bounce to `/` or consent.
pub async fn authorize(
    State(state): State<AppState>,
    session: Session,
    Query(q): Query<AuthorizeQuery>,
) -> Result<Redirect> {
    let params = validate(q)?;
    let uid = current_user_id_optional(&state, &session).await?;
    crate::desktop_authorize::clear_pending(&session).await?;
    session
        .insert(KEY_MOBILE_AUTHORIZE, &params)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert mobile_authorize: {e}")))?;

    let Some(uid) = uid else {
        return Ok(Redirect::to("/"));
    };
    let user = state
        .cfg
        .profile_client
        .get_user(uid)
        .await?
        .ok_or(Error::Unauthorized)?;
    if user.is_blocked() {
        let _ = take_pending(&session).await?;
        return Ok(Redirect::to(&error_url(&params, "account_blocked")));
    }
    Ok(Redirect::to(CONSENT_PATH))
}

/// `GET /mobile/authorize/consent` -- render the mobile consent HTML.
pub async fn consent(State(state): State<AppState>, session: Session) -> Result<Response> {
    let uid = current_user_id(&state, &session).await?;
    let Some(params) = peek_pending(&session).await? else {
        return Err(Error::BadRequest("no pending mobile authorize".into()));
    };
    let user = state
        .cfg
        .profile_client
        .get_user(uid)
        .await?
        .ok_or(Error::Unauthorized)?;
    if user.is_blocked() {
        let _ = take_pending(&session).await?;
        return Ok(Redirect::to(&error_url(&params, "account_blocked")).into_response());
    }

    let csrf = generate_csrf();
    session
        .insert(KEY_MOBILE_CSRF, &csrf)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert mobile_csrf: {e}")))?;

    let html = render_consent_html(&params, &user, &csrf);
    Ok((pages::security_headers(), Html(html)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ConfirmForm {
    action: String,
    csrf: String,
}

/// `POST /mobile/authorize/confirm` -- handle `allow` / `deny` and
/// return the 200 handoff page navigating to `chan://auth/callback`.
pub async fn confirm(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    Form(form): Form<ConfirmForm>,
) -> Result<Response> {
    let uid = current_user_id(&state, &session).await?;

    let expected_csrf: String = session
        .remove(KEY_MOBILE_CSRF)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session remove mobile_csrf: {e}")))?
        .ok_or_else(|| Error::BadRequest("csrf missing".into()))?;
    if !bool::from(form.csrf.as_bytes().ct_eq(expected_csrf.as_bytes())) {
        let _ = take_pending(&session).await?;
        return Err(Error::BadRequest("csrf mismatch".into()));
    }

    let Some(params) = take_pending(&session).await? else {
        return Err(Error::BadRequest("no pending mobile authorize".into()));
    };

    match form.action.as_str() {
        "allow" => {
            let user = state
                .cfg
                .profile_client
                .get_user(uid)
                .await?
                .ok_or(Error::Unauthorized)?;
            if user.is_blocked() {
                return Ok(handoff_response(
                    &Handoff::Error,
                    &error_url(&params, "account_blocked"),
                ));
            }
            let url = complete(&state, &headers, &params, &user).await?;
            Ok(handoff_response(&Handoff::Success, &url))
        }
        "deny" => Ok(handoff_response(
            &Handoff::Cancelled,
            &error_url(&params, "user_cancelled"),
        )),
        _ => Err(Error::BadRequest("invalid action".into())),
    }
}

fn render_consent_html(params: &AuthorizeParams, user: &User, csrf: &str) -> String {
    let display = user
        .display_name
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&user.username);
    let scopes = params.scopes.join(", ");
    let expires_phrase = humanize_expires(params.expires_in_secs);
    let body = format!(
        r#"
    <span class="mark" aria-hidden="true"></span>
    <h1>Authorize a mobile app?</h1>
    <p class="muted">An application on this device is requesting access. It identifies itself by the label below. chan cannot verify who it is.</p>
    <p class="muted">Signed in as <strong>{display}</strong>.</p>
    <p class="muted">Approving gives this application account-level access to this gateway for {expires_phrase}: it can list your devservers and devservers shared with you, and mint access to them.</p>
    <div class="details">
      <div class="row"><span class="k">Calls itself</span><span class="v">{label}</span></div>
      <div class="row"><span class="k">Scopes</span><span class="v">{scopes}</span></div>
      <div class="row"><span class="k">Expires in</span><span class="v">{expires_phrase}</span></div>
    </div>
    <p class="muted small">It will receive the result in the Chan app at chan://auth/callback.</p>
    <form method="post" action="/mobile/authorize/confirm">
      <input type="hidden" name="csrf" value="{csrf}">
      <button class="btn" type="submit" name="action" value="deny">Cancel</button>
      <button class="btn primary" type="submit" name="action" value="allow">Authorize</button>
    </form>
  "#,
        display = pages::html_escape(display),
        label = pages::html_escape(&params.label),
        scopes = pages::html_escape(&scopes),
        expires_phrase = pages::html_escape(&expires_phrase),
        csrf = pages::html_escape(csrf),
    );
    pages::render(&pages::Page {
        title: "Authorize a mobile app",
        head_extra: "",
        body: &body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_authorize::{challenge_for, RedemptionStore};
    use base64::Engine;

    const RFC_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    fn params() -> AuthorizeParams {
        AuthorizeParams {
            redirect_uri: MOBILE_CALLBACK_URI.into(),
            state: "nonce-1_abc~xyz".into(),
            label: "chan-ios @ iphone".into(),
            code_challenge: RFC_CHALLENGE.into(),
            scopes: vec!["mobile.account".into()],
            expires_in_secs: 30 * 86_400,
        }
    }

    fn base_query() -> AuthorizeQuery {
        AuthorizeQuery {
            redirect_uri: MOBILE_CALLBACK_URI.into(),
            state: "nonce-1".into(),
            label: "chan-ios @ iphone".into(),
            code_challenge: RFC_CHALLENGE.into(),
            code_challenge_method: "S256".into(),
            scopes: Some("mobile.account".into()),
            expires_in: Some(2_592_000),
            wireguard_public_key: None,
        }
    }

    fn consent_user() -> User {
        User {
            id: Uuid::nil(),
            email: "u@example.com".into(),
            display_name: None,
            username: "alice".into(),
            username_edits: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            blocked_at: None,
            block_reason: None,
            avatar_url: None,
        }
    }

    #[test]
    fn mobile_redirect_uri_accepts_the_registered_value() {
        assert_eq!(MOBILE_CALLBACK_URI, "chan://auth/callback");
        assert!(validate_mobile_redirect_uri("chan://auth/callback").is_ok());
    }

    #[test]
    fn mobile_redirect_uri_rejects_named_bypasses_and_loopback() {
        for bad in [
            // loopback callbacks belong exclusively to /desktop/authorize.
            "http://127.0.0.1:12345/auth/callback",
            "http://[::1]:12345/auth/callback",
            // query and fragment smuggle.
            "chan://auth/callback?code=x",
            "chan://auth/callback#frag",
            // userinfo host-spoof.
            "chan://auth@evil.example/callback",
            "chan://user:pass@auth/callback",
            // prefix games on host and path.
            "chan://auth.evil.example/callback",
            "chan://authx/callback",
            "chan://auth/callback/x",
            "chan://auth/callbackX",
            "chan://auth/cb",
            // port smuggle.
            "chan://auth:88/callback",
            // wrong scheme, unexpected scheme slashes, missing host, missing path.
            "chanx://auth/callback",
            "https://auth/callback",
            "chan:auth/callback",
            "chan:/auth/callback",
            "chan:///auth/callback",
            "chan:////auth/callback",
            "chan:///callback",
            "chan://auth",
            "chan://auth/",
            // leading/trailing whitespace and ASCII control characters that
            // WHATWG URL parsing would strip.
            " chan://auth/callback",
            "chan://auth/callback ",
            "\tchan://auth/callback",
            "chan://auth\t/callback",
            "chan://auth/callback\n",
            "CHAN://auth/callback",
            "chan://AUTH/callback",
            "",
        ] {
            assert!(
                validate_mobile_redirect_uri(bad).is_err(),
                "{bad:?} should reject"
            );
        }
    }

    #[test]
    fn mobile_redirect_uri_pins_whatwg_edge_spellings() {
        // Empty userinfo is absent userinfo: `@` with nothing before it
        // parses to an empty username, and validate() normalizes the stored
        // redirect_uri to MOBILE_CALLBACK_URI.
        assert!(validate_mobile_redirect_uri("chan://@auth/callback").is_ok());
        // Empty port is absent port: WHATWG drops an empty port buffer
        // instead of erroring, and the registered value carries none.
        assert!(validate_mobile_redirect_uri("chan://auth:/callback").is_ok());
        // An empty query or fragment is still present: a trailing `?` or `#`
        // parses to Some(""), which the smuggle rule rejects.
        assert!(validate_mobile_redirect_uri("chan://auth/callback?").is_err());
        assert!(validate_mobile_redirect_uri("chan://auth/callback#").is_err());
    }

    #[test]
    fn validates_mobile_query_and_normalizes_redirect_uri() {
        let mut q = base_query();
        q.redirect_uri = "chan://@auth:/callback".into();
        let p = validate(q).unwrap();
        assert_eq!(p.redirect_uri, "chan://auth/callback");
        assert_eq!(p.scopes, vec!["mobile.account".to_string()]);
        assert_eq!(p.expires_in_secs, 2_592_000);
        assert_eq!(p.code_challenge, RFC_CHALLENGE);
    }

    #[test]
    fn validate_rejects_loopback_and_other_redirect_uris() {
        for bad in [
            "http://127.0.0.1:12345/auth/callback",
            "http://[::1]:12345/auth/callback",
            "https://attacker.example/cb",
            "chan:///auth/callback",
            "chan:/auth/callback",
            " chan://auth/callback",
            "",
        ] {
            let mut q = base_query();
            q.redirect_uri = bad.into();
            assert!(validate(q).is_err(), "{bad:?} should reject");
        }
    }

    #[test]
    fn validate_rejects_wireguard_public_key_explicitly() {
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        for supplied in [key, String::new(), "not-a-key".into()] {
            let mut q = base_query();
            q.wireguard_public_key = Some(supplied);
            assert!(matches!(
                validate(q),
                Err(Error::BadRequest(msg)) if msg == "wireguard enrollment not supported on mobile"
            ));
        }
    }

    #[test]
    fn validate_accepts_only_sole_mobile_account_scope() {
        let mut ok = base_query();
        ok.scopes = Some(" mobile.account ".into());
        assert_eq!(validate(ok).unwrap().scopes, vec!["mobile.account"]);

        for bad in [
            None,
            Some(String::new()),
            Some("   ".into()),
            Some(",".into()),
            Some("tunnel".into()),
            Some("desktop.connect".into()),
            Some("desktop.account".into()),
            Some("mobile.other".into()),
            Some("mobile.account,tunnel".into()),
            Some("tunnel,mobile.account".into()),
            Some("mobile.account,desktop.account".into()),
            Some("mobile.account,mobile.account".into()),
            Some("mobile.account,".into()),
        ] {
            let mut q = base_query();
            q.scopes = bad.clone();
            assert!(
                matches!(
                    validate(q),
                    Err(Error::BadRequest(msg)) if msg == "invalid scopes"
                ),
                "{bad:?} should reject"
            );
        }
    }

    #[test]
    fn validate_enforces_ascii_graphic_state_bounds() {
        for ok in ["!".to_string(), "x".repeat(MAX_STATE_LEN)] {
            let mut q = base_query();
            q.state = ok.clone();
            assert_eq!(validate(q).unwrap().state, ok);
        }
        for bad in [
            String::new(),
            " ".into(),
            "abc xyz".into(),
            " nonce".into(),
            "nonce\t".into(),
            "nonce\n".into(),
            "n\u{00e9}".into(),
            "x".repeat(MAX_STATE_LEN + 1),
        ] {
            let mut q = base_query();
            q.state = bad.clone();
            assert!(
                matches!(validate(q), Err(Error::BadRequest(msg)) if msg == "invalid state"),
                "{bad:?} should reject"
            );
        }
    }

    #[test]
    fn validate_enforces_trimmed_label_bounds() {
        let mut q = base_query();
        q.label = "  iPhone  ".into();
        assert_eq!(validate(q).unwrap().label, "iPhone");

        let mut max_q = base_query();
        max_q.label = "a".repeat(64);
        assert_eq!(validate(max_q).unwrap().label.len(), 64);

        for bad in [String::new(), "   ".into(), "a".repeat(65)] {
            let mut q = base_query();
            q.label = bad.clone();
            assert!(
                matches!(validate(q), Err(Error::BadRequest(msg)) if msg == "invalid label"),
                "{bad:?} should reject"
            );
        }
    }

    #[test]
    fn validate_requires_positive_expires_in_and_clamps_to_bounds() {
        for bad in [None, Some(0), Some(-1), Some(-3600)] {
            let mut q = base_query();
            q.expires_in = bad;
            assert!(
                matches!(validate(q), Err(Error::BadRequest(msg)) if msg == "invalid expires_in"),
                "{bad:?} should reject"
            );
        }

        for (input, expected) in [
            (1, 60),
            (59, 60),
            (60, 60),
            (3600, 3600),
            (7_776_000, 7_776_000),
            (7_776_001, 7_776_000),
            (i64::MAX, 7_776_000),
        ] {
            let mut q = base_query();
            q.expires_in = Some(input);
            assert_eq!(validate(q).unwrap().expires_in_secs, expected, "{input}");
        }
    }

    #[test]
    fn validate_rejects_bad_pkce_method_or_challenge() {
        for bad_method in ["plain", "s256", "S384", ""] {
            let mut q = base_query();
            q.code_challenge_method = bad_method.into();
            assert!(validate(q).is_err(), "{bad_method}");
        }
        for bad_challenge in [
            String::new(),
            "short".into(),
            "A".repeat(42),
            "A".repeat(44),
            format!("{}=", "A".repeat(42)),
            format!("+{}", "A".repeat(42)),
        ] {
            let mut q = base_query();
            q.code_challenge = bad_challenge.clone();
            assert!(validate(q).is_err(), "{bad_challenge}");
        }
    }

    #[test]
    fn callback_urls_carry_query_only_and_escape_attr_breakers() {
        let mut p = params();
        p.state = r#""onmouseover='x'"#.into();
        let ok = success_url(&p, "the-code");
        assert!(ok.starts_with("chan://auth/callback?"), "{ok}");
        assert!(!ok.contains('#'), "{ok}");
        assert!(ok.contains("code=the-code"), "{ok}");
        assert!(!ok.contains("secret="), "{ok}");
        assert!(!ok.contains("id="), "{ok}");
        assert!(!ok.contains("label="), "{ok}");
        assert!(!ok.contains("expires_at="), "{ok}");

        let err = error_url(&p, "user_cancelled");
        assert!(err.starts_with("chan://auth/callback?"), "{err}");
        assert!(!err.contains('#'), "{err}");
        assert!(err.contains("error=user_cancelled"), "{err}");
        assert!(!err.contains("code="), "{err}");

        for url in [&ok, &err] {
            for breaker in ['"', '<', '>', '\'', ' '] {
                assert!(!url.contains(breaker), "{breaker:?} leaked into {url}");
            }
        }
    }

    #[test]
    fn handoff_html_embeds_mobile_target_twice_and_escapes() {
        let url = success_url(&params(), "the-code");
        let html = render_handoff_html(&Handoff::Success, &url);
        let escaped = pages::html_escape(&url);
        assert_eq!(html.matches(&escaped).count(), 2, "{html}");
        assert!(html.contains("<h1>Authorized</h1>"), "{html}");
        assert!(html.contains("Open Chan"), "{html}");
        assert!(!html.contains("chan-desktop"), "{html}");

        let cancelled =
            render_handoff_html(&Handoff::Cancelled, &error_url(&params(), "user_cancelled"));
        assert!(
            cancelled.contains("<h1>Request cancelled</h1>"),
            "{cancelled}"
        );
        assert!(cancelled.contains("No token was issued."), "{cancelled}");
    }

    #[test]
    fn consent_html_matches_mobile_copy_and_escapes_inputs() {
        let mut p = params();
        p.label = "<img src=x onerror=alert(1)>".into();
        let mut user = consent_user();
        user.display_name = Some("<b>Alice</b>".into());

        let html = render_consent_html(&p, &user, "csrf-token");
        assert!(
            html.contains("<title>Authorize a mobile app</title>"),
            "{html}"
        );
        assert!(html.contains("<h1>Authorize a mobile app?</h1>"), "{html}");
        assert!(
            html.contains(
                "<p class=\"muted\">An application on this device is requesting access. It identifies itself by the label below. chan cannot verify who it is.</p>"
            ),
            "{html}"
        );
        assert!(
            html.contains(
                "<p class=\"muted\">Signed in as <strong>&lt;b&gt;Alice&lt;/b&gt;</strong>.</p>"
            ),
            "{html}"
        );
        assert!(
            html.contains(
                "<p class=\"muted\">Approving gives this application account-level access to this gateway for 30 days: it can list your devservers and devservers shared with you, and mint access to them.</p>"
            ),
            "{html}"
        );
        assert!(
            html.contains("<div class=\"row\"><span class=\"k\">Calls itself</span><span class=\"v\">&lt;img src=x onerror=alert(1)&gt;</span></div>"),
            "{html}"
        );
        assert!(
            html.contains("<div class=\"row\"><span class=\"k\">Scopes</span><span class=\"v\">mobile.account</span></div>"),
            "{html}"
        );
        assert!(
            html.contains("<div class=\"row\"><span class=\"k\">Expires in</span><span class=\"v\">30 days</span></div>"),
            "{html}"
        );
        assert!(
            html.contains("<p class=\"muted small\">It will receive the result in the Chan app at chan://auth/callback.</p>"),
            "{html}"
        );
        assert!(
            html.contains("<form method=\"post\" action=\"/mobile/authorize/confirm\">"),
            "{html}"
        );
        assert!(html.contains(r#"name="csrf" value="csrf-token""#), "{html}");
        assert!(
            html.contains(r#"name="action" value="deny">Cancel</button>"#),
            "{html}"
        );
        assert!(
            html.contains(r#"name="action" value="allow">Authorize</button>"#),
            "{html}"
        );
        assert!(!html.contains("WireGuard"), "{html}");
        assert!(!html.contains("127.0.0.1"), "{html}");
        assert!(!html.contains("<img src=x"), "{html}");
    }

    #[test]
    fn mobile_redeem_payload_omits_wireguard_and_preserves_null_expires_at() {
        let wire = serde_json::to_value(MobileRedeemPayload {
            id: Uuid::nil(),
            secret: "chan_pat_AAAA".into(),
            label: "iphone".into(),
            expires_at: None,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "secret": "chan_pat_AAAA",
                "label": "iphone",
                "expires_at": null,
            })
        );
        assert!(wire.get("wireguard").is_none(), "{wire}");
    }

    #[test]
    fn desktop_and_mobile_redemption_stores_reject_each_others_codes() {
        let desktop_store = RedemptionStore::default();
        let mobile_store = RedemptionStore::default();
        let challenge = challenge_for(RFC_VERIFIER);

        let desktop_code = desktop_store.insert(
            RedeemPayload {
                id: Uuid::nil(),
                secret: "chan_pat_desktop".into(),
                label: "desktop".into(),
                expires_at: None,
                wireguard: None,
            },
            challenge.clone(),
        );
        let mobile_code = mobile_store.insert(
            RedeemPayload {
                id: Uuid::nil(),
                secret: "chan_pat_mobile".into(),
                label: "mobile".into(),
                expires_at: None,
                wireguard: None,
            },
            challenge,
        );

        // Cross-store probes miss without burning the owning store's entry.
        assert!(mobile_store.take(&desktop_code, RFC_VERIFIER).is_none());
        assert!(desktop_store.take(&mobile_code, RFC_VERIFIER).is_none());

        assert_eq!(
            desktop_store
                .take(&desktop_code, RFC_VERIFIER)
                .unwrap()
                .secret,
            "chan_pat_desktop"
        );
        assert_eq!(
            mobile_store
                .take(&mobile_code, RFC_VERIFIER)
                .unwrap()
                .secret,
            "chan_pat_mobile"
        );
    }
}
