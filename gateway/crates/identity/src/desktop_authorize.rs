//! OAuth-style PAT mint for chan-desktop, over a loopback redirect
//! with PKCE.
//!
//! chan-desktop binds a short-lived `http://127.0.0.1:<port>/auth/callback`
//! listener in its own process, generates a PKCE `code_verifier` (kept
//! in-process) and its `code_challenge = base64url(SHA256(verifier))`,
//! and opens the system browser at `/desktop/authorize`. The browser
//! consents on the real gateway origin; the gateway mints a PAT, stores
//! it under a one-time code bound to the challenge, and redirects the
//! browser back to the loopback listener carrying the code. The desktop
//! then redeems `{code, code_verifier}` over TLS to the identity origin.
//!
//! Four routes:
//!
//!   * `GET  /desktop/authorize?<query>` -- entry point. Validates the
//!     query (loopback `redirect_uri`, `code_challenge` + `S256`
//!     method, `state`, `label`, `scopes`, `expires_in`), stashes a
//!     [`AuthorizeParams`] struct in the session, and redirects: to `/`
//!     if unauthenticated (SPA sign-in renders, then `auth_callback`
//!     bounces back here), or straight to
//!     `/desktop/authorize/consent` if authenticated.
//!   * `GET  /desktop/authorize/consent` -- renders a server-side HTML
//!     consent page. Because a loopback client is public and cannot
//!     authenticate itself, the page presents the requester as an
//!     untrusted local app (the `label` is requester-supplied text,
//!     not a verified identity) and names the local port the result
//!     is delivered to. Includes a hidden CSRF nonce stored alongside
//!     the pending params.
//!   * `POST /desktop/authorize/confirm` -- handles the `Authorize` /
//!     `Cancel` action. Consumes the pending params + CSRF; on
//!     `allow` mints a PAT through [`ApiTokenService::create`] with
//!     [`TokenOrigin::Desktop`], stashes it in the
//!     [`RedemptionStore`] under a one-time code bound to the PKCE
//!     challenge, and answers 200 with a handoff page that navigates
//!     the browser to `http://127.0.0.1:<port>/auth/callback?code=&state=`
//!     (`deny` / blocked carry `?error=&state=` instead) via a
//!     zero-delay meta refresh plus a manual fallback link. The no-3xx
//!     ruling binds THIS response specifically: a 3xx answering the
//!     form POST would put the loopback hop inside the form
//!     submission's redirect chain, which Chrome subjects to the
//!     page's `form-action` CSP, and the handoff page keeps that
//!     navigation out of any form chain entirely. It says nothing
//!     about the desktop's own loopback answer, which replies to a GET
//!     navigation outside any form chain and does redirect, sending
//!     the browser back to this origin's profile page. The PAT secret
//!     never appears in the query or the page: only the one-time code
//!     does, and the page itself is `no-store` / `no-referrer`.
//!   * `POST /desktop/authorize/redeem` -- swaps a one-time code plus
//!     the PKCE verifier for the minted PAT (`{"code": ...,
//!     "code_verifier": ...}` -> `{id, secret, label, expires_at}`).
//!     Single-use with a [`REDEEM_TTL`] lifetime; unknown, expired,
//!     replayed codes and a code presented with the wrong verifier all
//!     answer 410.
//!
//! Both HTML pages render in the shared [`crate::pages`] shell (SPA
//! palette, inline CSS) under one strict CSP ([`crate::pages::CSP`]):
//! `default-src 'none'` with carve-outs for the inline styles, the
//! same-origin logo mask, and the consent form's same-origin POST.
//! `X-Frame-Options: DENY` + `frame-ancestors 'none'` keep a
//! malicious page from iframing the consent and clickjacking an
//! approval.
//!
//! Hardening posture:
//!   * `redirect_uri` must be a loopback callback
//!     (`http://127.0.0.1:<port>/auth/callback` or the `[::1]` form),
//!     validated by parsed-enum host equality (see
//!     [`validate_loopback_redirect_uri`]). A bad redirect_uri returns
//!     400; the port is the only free field.
//!   * `code_challenge_method` must be exactly `S256` and
//!     `code_challenge` a 43-char base64url-no-pad value decoding to
//!     32 bytes. The redeem verifies `SHA256(verifier)` equals the
//!     stored challenge in constant time.
//!   * `state` must be present and bounded; without it the desktop
//!     client cannot tie the response to its request.
//!   * `expires_in` is clamped to [`MAX_EXPIRES_IN_SECS`].
//!   * `scopes` are checked against [`ALLOWED_SCOPES`]. The general
//!     `/api/tokens` path only checks scope shape; this stricter list
//!     applies here because the desktop flow is unattended and we
//!     want a known-bounded capability surface.
//!   * The consent POST is gated by a 32-byte CSRF nonce stored in
//!     the session and compared with `subtle::ConstantTimeEq`. The
//!     session cookie itself is `SameSite=Lax`, so a cross-site POST
//!     never carries the cookie; the explicit nonce is defense in
//!     depth and proves the user passed through the rendered consent
//!     page rather than POSTing directly.
//!   * The audit row for the resulting PAT is `created_via_desktop`
//!     (not `created`), and each redemption writes a `desktop.redeem`
//!     row, so operators and users can tell the desktop flow apart
//!     from SPA mints and see when the code was cashed in.
//!   * The redeem route has no session auth: the credential is
//!     possession of the one-time code AND knowledge of the verifier
//!     whose S256 hash keys the stored challenge (TLS assumed). This
//!     is NOT takeover-proof: because a public loopback client cannot
//!     authenticate itself and the `code_challenge` + `state` leak
//!     through the browser-opener argv, a co-tenant who reads them can
//!     bind their own consent to the victim's challenge and deliver
//!     the result to the victim's listener (a login-CSRF residual).
//!     PKCE raises the bar (attacker needs a gateway account, an
//!     automated consent, and a won race) but does not close it under
//!     a shared-host threat model. Single-user is the shipped scope.
//!
//! Known limitations:
//!   * No per-session rate limit. A signed-in user spam-clicking
//!     `Authorize` mints PATs into their own table; audit-visible and
//!     bounded by the user's own account, so there is no server-side
//!     limit -- the audit log is the watch surface.
//!   * The redemption store is in-process memory. A single identity
//!     instance is an existing deployment assumption (the consent
//!     flow already stashes pending state server-side in-process); a
//!     multi-replica deployment would need a shared store, and a
//!     restart during the redemption window just forces a re-auth.

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Form, Query, State};
use axum::http::HeaderMap;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Utc};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tower_sessions::Session;
use url::form_urlencoded::byte_serialize;
use url::{Host, Url};
use uuid::Uuid;

use crate::api_tokens::{CreatedToken, NewToken, TokenOrigin, ACTION_DESKTOP_REDEEM};
use crate::error::{Error, Result};
use crate::http::{
    current_user_id, current_user_id_optional, request_meta, AppState, DESKTOP_ACCOUNT_SCOPE,
    DESKTOP_CONNECT_SCOPE, TUNNEL_SCOPE,
};
use crate::pages;
use crate::profile_client::User;

/// Session key under which `/desktop/authorize` stashes a pending
/// authorize. Read by `auth_callback` (to redirect to consent after
/// OAuth completes) and by the consent / confirm handlers.
pub const KEY_DESKTOP_AUTHORIZE: &str = "desktop_authorize";

/// Session key for the consent-form CSRF nonce. Regenerated each time
/// the consent page is rendered; consumed by the confirm POST.
const KEY_DESKTOP_CSRF: &str = "desktop_authorize_csrf";

/// The single path a loopback `redirect_uri` may carry. The host must
/// be `127.0.0.1`/`[::1]` (parsed-enum equality, [`validate_loopback_redirect_uri`]),
/// the scheme `http`, and the port free; only the path is fixed here.
const LOOPBACK_CALLBACK_PATH: &str = "/auth/callback";

/// 90 days. Matches what the spec example sends (30d) with headroom
/// for future longer-lived desktop sessions. The clamp prevents a
/// hostile or buggy desktop build from issuing year-long credentials.
const MAX_EXPIRES_IN_SECS: i64 = 90 * 86_400;

/// Sanity cap on the echoed `state` value. 512 bytes is more than
/// enough for any reasonable nonce + extension data; anything larger
/// is either a misuse or an attempt to balloon the session row.
const MAX_STATE_LEN: usize = 512;

/// Scope allowlist for the desktop flow. Stricter than the shape
/// check `ApiTokenService::create` runs: scopes here must be one of
/// the desktop/tunnel vocabulary entries, so a desktop build cannot
/// mint a token carrying a typo'd or future-only scope. `tunnel` and
/// `desktop.connect` stay listed for shipped desktops (dropping
/// either would 400 their sign-in); new desktops request
/// `desktop.account` alone (see the sole-scope rule in [`validate`]).
const ALLOWED_SCOPES: &[&str] = &[TUNNEL_SCOPE, DESKTOP_CONNECT_SCOPE, DESKTOP_ACCOUNT_SCOPE];

/// Default when the client omits `scopes`. Matches the SPA / general
/// PAT default so silence means "private tunnel only".
const DEFAULT_SCOPES: &[&str] = &[TUNNEL_SCOPE];

/// Path the consent page lives at. Exported so other modules (today
/// `auth_callback`) can build a redirect without restating the literal.
pub const CONSENT_PATH: &str = "/desktop/authorize/consent";

/// Lifetime of a one-time redemption code: long enough for the browser
/// to reach the loopback listener and the desktop to call back, short
/// enough that a code lifted from an open handoff tab is stale before
/// anyone could plausibly exfiltrate and replay it (and it is
/// PKCE-demoted anyway: useless without the in-process verifier).
const REDEEM_TTL: Duration = Duration::from_secs(120);

/// What `/desktop/authorize/redeem` answers with, exactly once per
/// code. Besides `POST /api/tokens`, this is the only response that
/// ever carries a PAT secret.
#[derive(Debug, Clone, Serialize)]
pub struct RedeemPayload {
    pub id: Uuid,
    pub secret: String,
    pub label: String,
    /// Always present on the wire (`null` for a token that never
    /// expires); the desktop contract reads the key unconditionally.
    pub expires_at: Option<DateTime<Utc>>,
}

/// In-process single-use store for pending redemptions, shared via
/// `AppState`. Expired entries are swept on every insert and lookup,
/// so the map never outgrows the codes minted inside one TTL window.
#[derive(Clone, Default)]
pub struct RedemptionStore {
    inner: Arc<Mutex<HashMap<String, StoredRedemption>>>,
}

#[derive(Debug)]
struct StoredRedemption {
    payload: RedeemPayload,
    /// PKCE `code_challenge` (`base64url(SHA256(verifier))`) the redeem
    /// must satisfy. Never leaves the store: the wire response is the
    /// bare [`RedeemPayload`].
    challenge: String,
    expires_at: Instant,
}

impl RedemptionStore {
    /// Stash `payload` under a fresh 256-bit code, bound to the PKCE
    /// `challenge`, and return the code. The code is the map key -- a
    /// server secret the desktop learns only through the loopback
    /// callback query, so an attacker who never sees that query cannot
    /// name an entry; the challenge is the PKCE proof the redeem must
    /// satisfy.
    pub fn insert(&self, payload: RedeemPayload, challenge: String) -> String {
        self.insert_with_ttl(payload, challenge, REDEEM_TTL)
    }

    fn insert_with_ttl(&self, payload: RedeemPayload, challenge: String, ttl: Duration) -> String {
        let code = generate_code();
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, v| v.expires_at > now);
        map.insert(
            code.clone(),
            StoredRedemption {
                payload,
                challenge,
                expires_at: now + ttl,
            },
        );
        code
    }

    /// Single-use PKCE lookup: returns the payload only when `code`
    /// names a live entry AND `SHA256(verifier)` equals that entry's
    /// stored challenge, compared in constant time. The first take
    /// wins; every later take, any take past the TTL, an unknown code,
    /// and a wrong verifier all get `None` -- indistinguishable, so an
    /// off-path caller cannot probe code state or the challenge. The
    /// entry is consumed on any matched code (a wrong verifier burns
    /// that code, matching the existing single-use remove).
    fn take(&self, code: &str, verifier: &str) -> Option<RedeemPayload> {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, v| v.expires_at > now);
        let stored = map.remove(code)?;
        let computed = challenge_for(verifier);
        if bool::from(stored.challenge.as_bytes().ct_eq(computed.as_bytes())) {
            Some(stored.payload)
        } else {
            None
        }
    }
}

/// 32 random bytes, base64url: same entropy class as the PAT secret
/// the code stands in for.
fn generate_code() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE S256: `base64url_nopad(SHA256(ASCII(verifier)))`. The hash is
/// over the ASCII bytes of the verifier STRING (RFC 7636 s4.2), not
/// any decoded form; both sides must agree on this. Base64url is
/// no-pad, matching [`generate_code`] / [`generate_csrf`].
fn challenge_for(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// A well-formed PKCE S256 `code_challenge`: a 43-char base64url-no-pad
/// string decoding to exactly 32 bytes (the SHA-256 output width). The
/// length check alone rejects `plain`-method challenges (a 43-char cap
/// on the verifier would be a coincidence) and the decode rejects
/// non-alphabet characters.
fn valid_code_challenge(challenge: &str) -> bool {
    if challenge.len() != 43 {
        return false;
    }
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(challenge) {
        Ok(bytes) => bytes.len() == 32,
        Err(_) => false,
    }
}

/// Validate a loopback `redirect_uri` by PARSED-ENUM equality -- never
/// text matching, never [`Ipv4Addr::is_loopback`], never the name
/// `localhost`. Each rule names the bypass it blocks.
fn validate_loopback_redirect_uri(raw: &str) -> Result<()> {
    let url = Url::parse(raw).map_err(|_| Error::BadRequest("invalid redirect_uri".into()))?;
    // Scheme http only: the in-process listener has no certificate, so
    // `https` could never complete; and accepting it would invite a
    // TLS-terminating proxy in the path.
    if url.scheme() != "http" {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    // Host by parsed enum. `http://127.0.0.1@evil.example/auth/callback`
    // parses with host `evil.example` and `127.0.0.1` in userinfo, so a
    // text/substring check would hand the consent to evil.example;
    // `http://0.0.0.0:<port>/...` is a valid non-loopback IPv4 that
    // connect(2) routes to localhost on Linux/Windows, so is_loopback()
    // is insufficient; `http://[::ffff:127.0.0.1]:<port>/...` is
    // loopback in effect but Ipv6Addr::is_loopback() returns false for
    // it. Only exact enum equality against 127.0.0.1 / ::1 is sound.
    match url.host() {
        Some(Host::Ipv4(ip)) if ip == Ipv4Addr::LOCALHOST => {}
        Some(Host::Ipv6(ip)) if ip == Ipv6Addr::LOCALHOST => {}
        _ => return Err(Error::BadRequest("invalid redirect_uri".into())),
    }
    // Port required and non-zero: RFC 8252 s4.1.3 lets the client pick
    // any ephemeral port, but `0` is the wildcard bind sentinel, never
    // a real callback target.
    match url.port() {
        Some(p) if p > 0 => {}
        _ => return Err(Error::BadRequest("invalid redirect_uri".into())),
    }
    // Path exact, not starts_with: `/auth/callback/x` or `/auth/callbackX`
    // would otherwise slip a different endpoint past the pin.
    if url.path() != LOOPBACK_CALLBACK_PATH {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    // No query/fragment/userinfo/password: userinfo is the host-spoof
    // vector above; a query/fragment would let a requester smuggle
    // extra state into the callback the listener never expects.
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::BadRequest("invalid redirect_uri".into()));
    }
    Ok(())
}

/// Query shape parsed from the request URL.
#[derive(Debug, Deserialize)]
pub struct AuthorizeQuery {
    redirect_uri: String,
    state: String,
    label: String,
    /// PKCE `code_challenge`, required: a 43-char base64url-no-pad
    /// value decoding to 32 bytes. A missing field is a serde 400.
    code_challenge: String,
    /// PKCE method, required and must equal `S256` exactly. `plain`
    /// would re-leak the verifier through the browser-opener argv.
    code_challenge_method: String,
    /// Comma-separated scope list. Absent / empty -> [`DEFAULT_SCOPES`].
    #[serde(default)]
    scopes: Option<String>,
    /// Token lifetime in seconds. Clamped to [`MAX_EXPIRES_IN_SECS`];
    /// non-positive values are rejected (the desktop flow expects a
    /// finite token, never an immortal one).
    expires_in: Option<i64>,
}

/// Validated form of [`AuthorizeQuery`] suitable for stashing in the
/// session across the OAuth roundtrip + the consent step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizeParams {
    /// Already-validated loopback callback
    /// (`http://127.0.0.1:<port>/auth/callback` or `[::1]`).
    redirect_uri: String,
    state: String,
    label: String,
    /// PKCE `code_challenge` the redemption is bound to.
    code_challenge: String,
    scopes: Vec<String>,
    expires_in_secs: i64,
}

/// Parse + validate. `Err` is a 400; the desktop client expects to fix
/// and retry its query string before any loopback redirect happens.
fn validate(q: AuthorizeQuery) -> Result<AuthorizeParams> {
    validate_loopback_redirect_uri(&q.redirect_uri)?;
    if q.code_challenge_method != "S256" {
        return Err(Error::BadRequest("invalid code_challenge_method".into()));
    }
    if !valid_code_challenge(&q.code_challenge) {
        return Err(Error::BadRequest("invalid code_challenge".into()));
    }
    let state = q.state.trim();
    if state.is_empty() || state.len() > MAX_STATE_LEN {
        return Err(Error::BadRequest("invalid state".into()));
    }
    let label = q.label.trim();
    if label.is_empty() || label.len() > 64 {
        return Err(Error::BadRequest("invalid label".into()));
    }
    let raw_scopes = q.scopes.unwrap_or_default();
    let scopes: Vec<String> = if raw_scopes.trim().is_empty() {
        DEFAULT_SCOPES.iter().map(|s| (*s).to_string()).collect()
    } else {
        raw_scopes
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    if scopes.is_empty() {
        return Err(Error::BadRequest("invalid scopes".into()));
    }
    for s in &scopes {
        if !ALLOWED_SCOPES.contains(&s.as_str()) {
            return Err(Error::BadRequest("invalid scopes".into()));
        }
    }
    // Sole-scope rule: desktop.account already covers the whole
    // account (roster read + entry mint), so a request mixing it with
    // the per-devserver vocabulary is a confused client, not a
    // capability request we can honor.
    if scopes.iter().any(|s| s == DESKTOP_ACCOUNT_SCOPE) && scopes.len() > 1 {
        return Err(Error::BadRequest("invalid scopes".into()));
    }
    // Clamp instead of reject: the spec note says "Cap expires_in to
    // whatever your policy max is. Don't trust the client." Clamping
    // keeps an over-eager desktop build working at the policy ceiling
    // instead of failing outright.
    let expires_in_secs = match q.expires_in {
        Some(n) if n > 0 => n.min(MAX_EXPIRES_IN_SECS),
        _ => return Err(Error::BadRequest("invalid expires_in".into())),
    };
    Ok(AuthorizeParams {
        redirect_uri: q.redirect_uri,
        state: state.to_string(),
        label: label.to_string(),
        code_challenge: q.code_challenge,
        scopes,
        expires_in_secs,
    })
}

/// Build the success redirect target: a loopback callback carrying the
/// one-time redemption code and the echoed `state` as QUERY parameters
/// -- never the PAT secret, never the token metadata (label/expiry ride
/// the redeem response). The parameters ride the query because a local
/// HTTP listener only ever receives the query; a fragment never reaches
/// a server.
pub fn success_url(params: &AuthorizeParams, code: &str) -> String {
    let mut query = String::new();
    push_pair(&mut query, "code", code);
    push_pair(&mut query, "state", &params.state);
    format!("{}?{}", params.redirect_uri, query)
}

/// Build the error redirect target. Same query encoding as
/// [`success_url`], never a `code`; the desktop client decides how to
/// surface `reason` to the user. `reason` is a short stable token
/// (`account_blocked`, `oauth_denied`, `user_cancelled`,
/// `mint_failed`) so logs and downstream UI can branch without
/// parsing English.
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

/// Peek at a pending authorize without consuming it. Used by
/// `auth_callback` to decide whether to redirect to consent.
pub async fn peek_pending(session: &Session) -> Result<Option<AuthorizeParams>> {
    session
        .get::<AuthorizeParams>(KEY_DESKTOP_AUTHORIZE)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session get desktop_authorize: {e}")))
}

/// Read + remove a pending authorize. Used by the deny branches in
/// `auth_callback` (blocked account, oauth_login deny) and by the
/// confirm POST.
pub async fn take_pending(session: &Session) -> Result<Option<AuthorizeParams>> {
    session
        .remove::<AuthorizeParams>(KEY_DESKTOP_AUTHORIZE)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session remove desktop_authorize: {e}")))
}

/// Generate a 32-byte CSRF nonce, base64url-encoded. Stored in the
/// session and surfaced into the consent form as a hidden field.
fn generate_csrf() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Which handoff variant `confirm` renders: the copy differs, the
/// mechanics (meta refresh + manual link to the loopback callback
/// target) do not.
enum Handoff {
    /// PAT minted; the target carries `?code=...`.
    Success,
    /// The user clicked Cancel; the target carries `?error=user_cancelled`.
    Cancelled,
    /// The account is blocked; the target carries `?error=account_blocked`.
    Error,
}

impl Handoff {
    /// `(title, blurb)` for the card. The title doubles as the `<h1>`.
    fn copy(&self) -> (&'static str, &'static str) {
        match self {
            Handoff::Success => ("Authorized", "Returning you to chan-desktop\u{2026}"),
            Handoff::Cancelled => (
                "Request cancelled",
                "No token was issued. Returning you to chan-desktop\u{2026}",
            ),
            Handoff::Error => (
                "Sign-in failed",
                "Returning you to chan-desktop with the details\u{2026}",
            ),
        }
    }
}

/// Render the handoff page `confirm` answers with: a zero-delay meta
/// refresh to the loopback callback target plus a manual fallback link,
/// so the navigation to `127.0.0.1` never rides THIS form POST's
/// redirect chain (see the module doc). The target appears exactly
/// twice, both times attribute-escaped; its only user-influenced parts
/// are percent-encoded by [`success_url`] / [`error_url`].
fn render_handoff_html(kind: &Handoff, target: &str) -> String {
    let (title, blurb) = kind.copy();
    let url = pages::html_escape(target);
    let head_extra = format!("<meta http-equiv=\"refresh\" content=\"0;url={url}\">\n  ");
    let body = format!(
        r#"
    <span class="mark" aria-hidden="true"></span>
    <h1>{title}</h1>
    <p class="muted">{blurb}</p>
    <a class="btn primary" href="{url}">Open chan-desktop</a>
    <p class="muted small">You can close this tab.</p>
  "#,
    );
    pages::render(&pages::Page {
        title,
        head_extra: &head_extra,
        body: &body,
    })
}

/// The 200 response wrapping [`render_handoff_html`], with the shared
/// security headers (the page embeds a one-time redemption code on the
/// success path, never the PAT secret: `no-store`, `no-referrer`,
/// `nosniff`).
fn handoff_response(kind: &Handoff, target: &str) -> Response {
    (
        pages::security_headers(),
        Html(render_handoff_html(kind, target)),
    )
        .into_response()
}

/// Mint the PAT, stash it under a one-time redemption code bound to the
/// request's PKCE challenge, and return the loopback success URL
/// carrying the code. Called by the confirm POST when the user clicks
/// Authorize.
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
                origin: TokenOrigin::Desktop,
            },
            &request_meta(headers),
        )
        .await
        .map_err(|e| {
            tracing::warn!(error = ?e, user = %user.username, "desktop authorize mint failed");
            e
        })?;
    // A PAT is a devserver only when it can dial (tunnel scope): the
    // shared mint-site helper registers the roster row so the owner
    // sees it and can grant on it before it ever dials in; account
    // and connect mints register nothing.
    crate::http::register_devserver_row(state, user.id, &secret, &params.label, &params.scopes)
        .await;
    let code = state.desktop_redemptions.insert(
        RedeemPayload {
            id: token.id,
            secret,
            label: token.label.clone(),
            expires_at: token.expires_at,
        },
        params.code_challenge.clone(),
    );
    Ok(success_url(params, &code))
}

#[derive(Debug, Deserialize)]
pub struct RedeemRequest {
    code: String,
    /// PKCE verifier. `SHA256(code_verifier)` must equal the challenge
    /// the code was stored under; the verifier's only appearance on any
    /// wire, over TLS, to the identity origin the desktop holds.
    code_verifier: String,
}

/// `POST /desktop/authorize/redeem` -- swap a one-time code plus the
/// PKCE verifier for the minted PAT. No session auth: the credential is
/// possession of the code AND knowledge of the verifier whose S256 hash
/// keys the stored challenge (see the module doc's hardening notes).
/// This is NOT takeover-proof -- a co-tenant who reads the argv-leaked
/// challenge can bind their own consent to it (a login-CSRF residual);
/// PKCE only raises the bar. Unknown, expired, replayed codes and a
/// wrong verifier all share one 410 so an off-path caller cannot probe
/// code state or the challenge.
pub async fn redeem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RedeemRequest>,
) -> Result<Json<RedeemPayload>> {
    let Some(payload) = state
        .desktop_redemptions
        .take(&req.code, &req.code_verifier)
    else {
        return Err(Error::Gone(
            "unknown, expired, or already-redeemed code".into(),
        ));
    };
    state
        .api_tokens
        .write_audit(payload.id, ACTION_DESKTOP_REDEEM, &request_meta(&headers))
        .await?;
    Ok(Json(payload))
}

/// `GET /desktop/authorize` entry. Validates the query, stashes
/// params, and bounces -- to `/` for unauthenticated sessions (the SPA
/// renders sign-in), or straight to the consent page otherwise.
pub async fn authorize(
    State(state): State<AppState>,
    session: Session,
    Query(q): Query<AuthorizeQuery>,
) -> Result<Redirect> {
    let params = validate(q)?;
    session
        .insert(KEY_DESKTOP_AUTHORIZE, &params)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert desktop_authorize: {e}")))?;

    let Some(uid) = current_user_id_optional(&session).await? else {
        // Bounce through SPA sign-in. `auth_callback` redirects to
        // CONSENT_PATH once the user is authenticated.
        let _ = state;
        return Ok(Redirect::to("/"));
    };
    // Authenticated. Short-circuit a known-blocked user to the
    // loopback error redirect so the desktop client gets a precise
    // reason instead of staring at a 403.
    let user = state
        .cfg
        .profile_client
        .get_user(uid)
        .await?
        .ok_or(Error::Unauthorized)?;
    if user.is_blocked() {
        // Consume the stash; the user has decided nothing yet, but
        // there is no consent to render for a blocked account.
        let _ = take_pending(&session).await?;
        return Ok(Redirect::to(&error_url(&params, "account_blocked")));
    }
    Ok(Redirect::to(CONSENT_PATH))
}

/// `GET /desktop/authorize/consent` -- renders the consent HTML.
pub async fn consent(State(state): State<AppState>, session: Session) -> Result<Response> {
    let uid = current_user_id(&session).await?;
    let Some(params) = peek_pending(&session).await? else {
        return Err(Error::BadRequest("no pending desktop authorize".into()));
    };
    let user = state
        .cfg
        .profile_client
        .get_user(uid)
        .await?
        .ok_or(Error::Unauthorized)?;
    if user.is_blocked() {
        // Consume + redirect: a blocked user shouldn't see the
        // consent prompt.
        let _ = take_pending(&session).await?;
        return Ok(Redirect::to(&error_url(&params, "account_blocked")).into_response());
    }

    // Fresh CSRF on every render so a leaked nonce from a previous
    // page load cannot be replayed. Overwrites any prior value.
    let csrf = generate_csrf();
    session
        .insert(KEY_DESKTOP_CSRF, &csrf)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session insert desktop_csrf: {e}")))?;

    let html = render_consent_html(&params, &user, &csrf);
    Ok((pages::security_headers(), Html(html)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ConfirmForm {
    /// `allow` or `deny`. Anything else is a 400.
    action: String,
    /// Echoed CSRF nonce. Compared constant-time to the session
    /// value stored during consent render.
    csrf: String,
}

/// `POST /desktop/authorize/confirm` -- handles allow / deny. Every
/// outcome answers 200 with a [`Handoff`] page (see the module doc for
/// why THIS response, alone in the flow, is not a redirect).
pub async fn confirm(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    Form(form): Form<ConfirmForm>,
) -> Result<Response> {
    let uid = current_user_id(&session).await?;

    // Consume CSRF first so a replay of an old form fails even if
    // params are still stashed.
    let expected_csrf: String = session
        .remove(KEY_DESKTOP_CSRF)
        .await
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("session remove desktop_csrf: {e}")))?
        .ok_or_else(|| Error::BadRequest("csrf missing".into()))?;
    if !bool::from(form.csrf.as_bytes().ct_eq(expected_csrf.as_bytes())) {
        // Drop the pending stash on CSRF mismatch: an attacker who
        // knows the URL but not the nonce should not be able to keep
        // an authorize alive across attempts.
        let _ = take_pending(&session).await?;
        return Err(Error::BadRequest("csrf mismatch".into()));
    }

    let Some(params) = take_pending(&session).await? else {
        return Err(Error::BadRequest("no pending desktop authorize".into()));
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

/// Render the consent page in the shared [`crate::pages`] shell (the
/// SPA card look). Every interpolated value is escaped; the form's
/// `csrf` / `action` fields are the wire contract the confirm POST
/// (and the integration tests) read. Script-free within the shell's
/// strict CSP.
fn render_consent_html(params: &AuthorizeParams, user: &User, csrf: &str) -> String {
    let display = user
        .display_name
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&user.username);
    let scopes = params.scopes.join(", ");
    let expires_phrase = humanize_expires(params.expires_in_secs);
    // The loopback port the result is delivered to, parsed from the
    // already-validated redirect_uri. A user who did not just start a
    // sign-in from an app on this computer sees a request they did not
    // begin.
    let port = Url::parse(&params.redirect_uri)
        .ok()
        .and_then(|u| u.port())
        .map(|p| p.to_string())
        .unwrap_or_default();
    // Account-mode consent frames the grant by what it EXPOSES rather
    // than reassuring about who receives it; the requester's identity
    // cannot be verified for a public loopback client.
    let account_blurb = if params.scopes.iter().any(|s| s == DESKTOP_ACCOUNT_SCOPE) {
        format!(
            "<p class=\"muted\">Approving gives this application account-level access to \
             this gateway for {expires}: it can list your devservers and devservers shared \
             with you, and mint access to them.</p>\n    ",
            expires = pages::html_escape(&expires_phrase),
        )
    } else {
        String::new()
    };
    let body = format!(
        r#"
    <span class="mark" aria-hidden="true"></span>
    <h1>Authorize an app on this computer?</h1>
    <p class="muted">An application running on this computer is requesting access. It identifies itself by the label below. chan cannot verify who it is.</p>
    <p class="muted">Signed in as <strong>{display}</strong>.</p>
    {account_blurb}<div class="details">
      <div class="row"><span class="k">Calls itself</span><span class="v">{label}</span></div>
      <div class="row"><span class="k">Scopes</span><span class="v">{scopes}</span></div>
      <div class="row"><span class="k">Expires in</span><span class="v">{expires_phrase}</span></div>
    </div>
    <p class="muted small">It will receive the result on this computer at 127.0.0.1, port {port}.</p>
    <form method="post" action="/desktop/authorize/confirm">
      <input type="hidden" name="csrf" value="{csrf}">
      <button class="btn" type="submit" name="action" value="deny">Cancel</button>
      <button class="btn primary" type="submit" name="action" value="allow">Authorize</button>
    </form>
  "#,
        display = pages::html_escape(display),
        label = pages::html_escape(&params.label),
        scopes = pages::html_escape(&scopes),
        expires_phrase = pages::html_escape(&expires_phrase),
        port = pages::html_escape(&port),
        csrf = pages::html_escape(csrf),
    );
    pages::render(&pages::Page {
        title: "Authorize an app on this computer",
        head_extra: "",
        body: &body,
    })
}

/// Best-effort coarse phrasing. "30 days", "2 hours" -- never tries
/// to mix units. Falls back to seconds for sub-minute values.
fn humanize_expires(secs: i64) -> String {
    const MIN: i64 = 60;
    const HOUR: i64 = 60 * MIN;
    const DAY: i64 = 24 * HOUR;
    if secs >= DAY {
        let d = secs / DAY;
        return format!("{d} day{}", if d == 1 { "" } else { "s" });
    }
    if secs >= HOUR {
        let h = secs / HOUR;
        return format!("{h} hour{}", if h == 1 { "" } else { "s" });
    }
    if secs >= MIN {
        let m = secs / MIN;
        return format!("{m} minute{}", if m == 1 { "" } else { "s" });
    }
    format!("{secs} second{}", if secs == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// A valid loopback callback target for tests.
    const LOOPBACK_URI: &str = "http://127.0.0.1:54321/auth/callback";
    /// RFC 7636 Appendix B known vector: `challenge_for(RFC_VERIFIER)`
    /// must equal `RFC_CHALLENGE`. Pins the S256 construction against
    /// silent drift with the desktop half.
    const RFC_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const RFC_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    fn params() -> AuthorizeParams {
        AuthorizeParams {
            redirect_uri: LOOPBACK_URI.into(),
            state: "abc xyz".into(),
            label: "chan-desktop @ box".into(),
            code_challenge: RFC_CHALLENGE.into(),
            scopes: vec!["tunnel".into()],
            expires_in_secs: 30 * 86_400,
        }
    }

    /// A minimal valid authorize query. Tests mutate the one field they
    /// exercise.
    fn base_query() -> AuthorizeQuery {
        AuthorizeQuery {
            redirect_uri: LOOPBACK_URI.into(),
            state: "nonce".into(),
            label: "x".into(),
            code_challenge: RFC_CHALLENGE.into(),
            code_challenge_method: "S256".into(),
            scopes: None,
            expires_in: Some(10),
        }
    }

    fn payload(secret: &str) -> RedeemPayload {
        RedeemPayload {
            id: Uuid::nil(),
            secret: secret.into(),
            label: "box".into(),
            expires_at: None,
        }
    }

    // --- PKCE construction (the drift-sensitive detail) ---

    #[test]
    fn challenge_for_matches_rfc7636_known_vector() {
        // The hash is over the ASCII bytes of the verifier STRING,
        // base64url no-pad (RFC 7636 s4.2). Both workspaces must agree.
        assert_eq!(challenge_for(RFC_VERIFIER), RFC_CHALLENGE);
        assert_eq!(challenge_for(RFC_VERIFIER).len(), 43);
    }

    #[test]
    fn valid_code_challenge_shape() {
        assert!(valid_code_challenge(RFC_CHALLENGE));
        assert!(!valid_code_challenge(""));
        assert!(!valid_code_challenge("short"));
        assert!(!valid_code_challenge(&"A".repeat(42)));
        assert!(!valid_code_challenge(&"A".repeat(44)));
        // '=' padding is not in the no-pad alphabet.
        assert!(!valid_code_challenge(&format!("{}=", "A".repeat(42))));
        // '+' is base64-standard, not base64url.
        assert!(!valid_code_challenge(&format!("+{}", "A".repeat(42))));
    }

    // --- validate_loopback_redirect_uri: accept + reject BY NAME ---

    #[test]
    fn loopback_redirect_uri_accepts_ipv4_and_ipv6() {
        assert!(validate_loopback_redirect_uri("http://127.0.0.1:54321/auth/callback").is_ok());
        // [::1] is accepted for spec completeness though the desktop
        // never emits it.
        assert!(validate_loopback_redirect_uri("http://[::1]:54321/auth/callback").is_ok());
    }

    #[test]
    fn loopback_redirect_uri_rejects_named_bypasses() {
        for bad in [
            // userinfo host-spoof: host is evil.example, 127.0.0.1 in
            // userinfo; a text check would hand the consent to evil.
            "http://127.0.0.1@evil.example/auth/callback",
            // non-loopback IPv4 that connect(2) routes to localhost, so
            // is_loopback() alone is insufficient.
            "http://0.0.0.0:54321/auth/callback",
            // v4-mapped IPv6, loopback in effect but is_loopback()==false.
            "http://[::ffff:127.0.0.1]:54321/auth/callback",
            // no cert on the listener.
            "https://127.0.0.1:54321/auth/callback",
            // the NAME localhost is never accepted, only parsed IPs.
            "http://localhost:54321/auth/callback",
            // port 0 is the wildcard bind sentinel.
            "http://127.0.0.1:0/auth/callback",
            // port required.
            "http://127.0.0.1/auth/callback",
            // path exact, not starts_with.
            "http://127.0.0.1:54321/auth/callback/x",
            "http://127.0.0.1:54321/auth/callbackX",
            // no query / fragment / userinfo / password.
            "http://127.0.0.1:54321/auth/callback?x=1",
            "http://127.0.0.1:54321/auth/callback#frag",
            "http://user:pass@127.0.0.1:54321/auth/callback",
            // the removed custom scheme.
            "chan://auth/callback",
            "",
        ] {
            assert!(
                validate_loopback_redirect_uri(bad).is_err(),
                "{bad} should reject"
            );
        }
    }

    // --- validate() ---

    #[test]
    fn validates_minimal_query() {
        let mut q = base_query();
        q.label = "chan-desktop".into();
        q.expires_in = Some(2_592_000);
        let p = validate(q).unwrap();
        assert_eq!(p.scopes, vec!["tunnel".to_string()]);
        assert_eq!(p.expires_in_secs, 2_592_000);
        assert_eq!(p.code_challenge, RFC_CHALLENGE);
        assert_eq!(p.redirect_uri, LOOPBACK_URI);
    }

    #[test]
    fn rejects_wrong_redirect_uri() {
        for bad in [
            "https://attacker.example/cb",
            "chan://auth/callback",
            "http://localhost:54321/auth/callback",
            "",
        ] {
            let mut q = base_query();
            q.redirect_uri = bad.into();
            assert!(validate(q).is_err(), "{bad} should reject");
        }
    }

    #[test]
    fn rejects_wrong_pkce_method() {
        for bad in ["plain", "s256", "S384", ""] {
            let mut q = base_query();
            q.code_challenge_method = bad.into();
            assert!(validate(q).is_err(), "{bad} should reject");
        }
    }

    #[test]
    fn rejects_malformed_code_challenge() {
        for bad in [
            String::new(),
            "short".into(),
            "A".repeat(42),
            "A".repeat(44),
            format!("{}=", "A".repeat(42)),
            format!("+{}", "A".repeat(42)),
        ] {
            let mut q = base_query();
            q.code_challenge = bad.clone();
            assert!(validate(q).is_err(), "{bad} should reject");
        }
    }

    #[test]
    fn rejects_blank_or_oversized_state() {
        for bad in ["".to_string(), "   ".into(), "x".repeat(MAX_STATE_LEN + 1)] {
            let mut q = base_query();
            q.state = bad;
            assert!(validate(q).is_err());
        }
    }

    #[test]
    fn rejects_unknown_scope() {
        let mut q = base_query();
        q.scopes = Some("tunnel,admin".into());
        assert!(validate(q).is_err());
    }

    #[test]
    fn accepts_sole_account_scope() {
        let mut q = base_query();
        q.scopes = Some("desktop.account".into());
        let p = validate(q).unwrap();
        assert_eq!(p.scopes, vec!["desktop.account"]);
    }

    #[test]
    fn rejects_account_scope_mixed_with_others() {
        // desktop.account is sole-scope: any companion, even an
        // otherwise-allowed one, is a 400.
        for bad in [
            "desktop.account,tunnel",
            "tunnel,desktop.account",
            "desktop.account,desktop.connect",
        ] {
            let mut q = base_query();
            q.scopes = Some(bad.into());
            assert!(validate(q).is_err(), "{bad} should reject");
        }
    }

    #[test]
    fn legacy_scope_pairs_still_validate() {
        // Shipped desktops send tunnel and tunnel,desktop.connect;
        // both must keep working (Contract A back-compat).
        for ok in ["tunnel", "tunnel,desktop.connect", "desktop.connect"] {
            let mut q = base_query();
            q.scopes = Some(ok.into());
            assert!(validate(q).is_ok(), "{ok} should validate");
        }
    }

    #[test]
    fn accepts_csv_scopes_with_whitespace() {
        // Exercises comma-split + trim + empty-element filter.
        let mut q = base_query();
        q.scopes = Some(" tunnel , ".into());
        let p = validate(q).unwrap();
        assert_eq!(p.scopes, vec!["tunnel"]);
    }

    #[test]
    fn clamps_expires_in() {
        let mut q = base_query();
        q.expires_in = Some(MAX_EXPIRES_IN_SECS * 10);
        let p = validate(q).unwrap();
        assert_eq!(p.expires_in_secs, MAX_EXPIRES_IN_SECS);
    }

    #[test]
    fn rejects_non_positive_expires_in() {
        for n in [0, -1, -3600] {
            let mut q = base_query();
            q.expires_in = Some(n);
            assert!(validate(q).is_err());
        }
    }

    // --- success_url / error_url: loopback QUERY, not fragment ---

    #[test]
    fn success_url_uses_query_and_encodes_specials() {
        let url = success_url(&params(), "the-code");
        assert!(
            url.starts_with("http://127.0.0.1:54321/auth/callback?"),
            "got {url}"
        );
        assert!(!url.contains('#'), "no fragment: {url}");
        assert!(url.contains("code=the-code"), "got {url}");
        assert!(url.contains("state=abc+xyz"), "got {url}");
    }

    #[test]
    fn success_url_never_carries_credentials_or_metadata() {
        // The one-time code REPLACES id + secret; the secret only ever
        // leaves through the redeem response. label/expires_at ride the
        // redeem response too, not the URL.
        let url = success_url(&params(), "the-code");
        assert!(!url.contains("secret="), "got {url}");
        assert!(!url.contains("chan_pat_"), "got {url}");
        assert!(!url.contains("id="), "got {url}");
        assert!(!url.contains("label="), "got {url}");
        assert!(!url.contains("expires_at="), "got {url}");
    }

    #[test]
    fn success_url_never_emits_devserver_keys() {
        // The query vocabulary is code/state only; no devserver_* key
        // may ever appear.
        let url = success_url(&params(), "the-code");
        assert!(!url.contains("devserver_"), "got {url}");
    }

    #[test]
    fn error_url_carries_reason_and_state_as_query() {
        let url = error_url(&params(), "account_blocked");
        assert!(
            url.starts_with("http://127.0.0.1:54321/auth/callback?"),
            "got {url}"
        );
        assert!(!url.contains('#'), "no fragment: {url}");
        assert!(url.contains("error=account_blocked"));
        assert!(url.contains("state=abc+xyz"));
        assert!(!url.contains("code="), "error carries no code: {url}");
    }

    #[test]
    fn loopback_urls_contain_no_html_attr_breakers() {
        // The property that makes embedding the URL in the handoff
        // page's attributes safe: byte_serialize percent-encodes every
        // attribute breaker, so the only entity the escaped URL can
        // contain is `&amp;`.
        let mut p = params();
        p.state = r#""onmouseover='x' "#.into();
        for url in [success_url(&p, "the-code"), error_url(&p, "user_cancelled")] {
            for breaker in ['"', '<', '>', '\'', ' '] {
                assert!(!url.contains(breaker), "{breaker:?} leaked into {url}");
            }
        }
    }

    // --- RedemptionStore: PKCE-bound single-use ---

    #[test]
    fn redemption_store_is_single_use() {
        let store = RedemptionStore::default();
        let code = store.insert(payload("chan_pat_AAAA"), challenge_for(RFC_VERIFIER));
        let first = store.take(&code, RFC_VERIFIER).expect("first take wins");
        assert_eq!(first.secret, "chan_pat_AAAA");
        assert!(
            store.take(&code, RFC_VERIFIER).is_none(),
            "replay must miss"
        );
        assert!(store.take("no-such-code", RFC_VERIFIER).is_none());
    }

    #[test]
    fn redemption_store_wrong_verifier_misses_indistinguishably() {
        // A live code presented with a verifier whose hash != the
        // stored challenge returns None, the same as an unknown code.
        let store = RedemptionStore::default();
        let code = store.insert(payload("chan_pat_AAAA"), challenge_for(RFC_VERIFIER));
        assert!(store.take(&code, "the-wrong-verifier").is_none());
    }

    #[test]
    fn redemption_store_expires_codes() {
        let store = RedemptionStore::default();
        let code = store.insert_with_ttl(
            payload("chan_pat_AAAA"),
            challenge_for(RFC_VERIFIER),
            Duration::ZERO,
        );
        assert!(
            store.take(&code, RFC_VERIFIER).is_none(),
            "expired take must miss"
        );
        // The sweep also evicted the entry outright.
        assert!(store.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn pkce_closes_naive_injection() {
        // NAIVE injection: the attacker binds their OWN code to their
        // OWN challenge, then a victim verifier is presented. The hash
        // mismatch -> None -> 410. Closed by PKCE.
        let store = RedemptionStore::default();
        let attacker_challenge = challenge_for("attacker-verifier-string");
        let code = store.insert(payload("chan_pat_ATK"), attacker_challenge);
        assert!(
            store.take(&code, RFC_VERIFIER).is_none(),
            "a verifier that does not hash to the stored challenge must miss"
        );
    }

    #[test]
    fn pkce_residual_challenge_binding_stays_open_by_design() {
        // RESIDUAL: an entry minted under C_V IS redeemable
        // by verifier_V, because SHA256(verifier_V) == C_V by
        // construction. This is the challenge-binding takeover PKCE
        // does NOT close under a shared-host threat model. Codified so
        // the residual is not accidentally believed closed -- do NOT
        // "fix" this to assert a miss.
        let store = RedemptionStore::default();
        let c_v = challenge_for(RFC_VERIFIER);
        let code = store.insert(payload("chan_pat_ATK"), c_v);
        let got = store
            .take(&code, RFC_VERIFIER)
            .expect("verifier_V satisfies C_V by construction (the residual)");
        assert_eq!(got.secret, "chan_pat_ATK");
    }

    #[test]
    fn redeem_payload_serializes_null_expires_at() {
        // The desktop reads `expires_at` unconditionally: null, not
        // absent, for a token without an expiry.
        let j = serde_json::to_value(payload("chan_pat_AAAA")).unwrap();
        assert!(j.get("expires_at").is_some_and(|v| v.is_null()), "{j}");
        assert_eq!(j["secret"], "chan_pat_AAAA");
        assert_eq!(j["id"], "00000000-0000-0000-0000-000000000000");
    }

    // --- handoff page (loopback target) ---

    #[test]
    fn handoff_html_embeds_target_twice_and_escapes() {
        let url = success_url(&params(), "the-code");
        let html = render_handoff_html(&Handoff::Success, &url);
        // Exactly twice: the meta refresh and the manual fallback link.
        let escaped = pages::html_escape(&url);
        assert_eq!(
            html.matches(&escaped).count(),
            2,
            "meta + link, got: {html}"
        );
        assert!(
            html.contains(&format!(
                "<meta http-equiv=\"refresh\" content=\"0;url={escaped}\">"
            )),
            "{html}"
        );
        assert!(
            html.contains(&format!("<a class=\"btn primary\" href=\"{escaped}\">")),
            "{html}"
        );
        assert!(html.contains("You can close this tab."), "{html}");
        assert!(html.contains("<h1>Authorized</h1>"), "{html}");
    }

    #[test]
    fn handoff_cancelled_variant_carries_error_url() {
        let url = error_url(&params(), "user_cancelled");
        let html = render_handoff_html(&Handoff::Cancelled, &url);
        assert!(html.contains("error=user_cancelled"), "{html}");
        assert!(html.contains("<h1>Request cancelled</h1>"), "{html}");
        assert!(html.contains("No token was issued."), "{html}");
    }

    // --- consent page (finding-3 copy) ---

    #[test]
    fn consent_html_includes_required_fields_and_no_unescaped_input() {
        let mut p = params();
        // Hostile-shape inputs that would XSS without escaping.
        p.label = "<img src=x onerror=alert(1)>".into();
        p.state = r#""onclick=alert(1)//"#.into();
        let user = User {
            id: Uuid::nil(),
            email: "u@example.com".into(),
            display_name: Some("<b>Alice</b>".into()),
            username: "alice".into(),
            username_edits: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            blocked_at: None,
            block_reason: None,
            avatar_url: None,
        };
        let html = render_consent_html(&p, &user, "csrf-token");
        // The finding-3 copy: an untrusted local app, unverifiable.
        assert!(
            html.contains("<h1>Authorize an app on this computer?</h1>"),
            "{html}"
        );
        assert!(html.contains("chan cannot verify who it is."), "{html}");
        assert!(html.contains("Calls itself"), "{html}");
        // The loopback port the result is delivered to.
        assert!(html.contains("at 127.0.0.1, port 54321."), "{html}");
        // CSRF appears as a hidden input.
        assert!(html.contains(r#"name="csrf" value="csrf-token""#), "{html}");
        // Two action buttons.
        assert!(html.contains(r#"name="action" value="allow""#));
        assert!(html.contains(r#"name="action" value="deny""#));
        // The shared shell renders the card + logo mark.
        assert!(html.contains(r#"class="mark""#), "{html}");
        // No raw <script>, <img onerror=, or unescaped quote in user fields.
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img src=x"));
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(html.contains("&lt;b&gt;Alice&lt;/b&gt;"));
        // The devserver picker is gone: no radios, ever.
        assert!(!html.contains(r#"name="devserver""#), "{html}");
        assert!(!html.contains(r#"type="radio""#), "{html}");
        // A tunnel-scoped request renders no account blurb.
        assert!(!html.contains("account-level access"), "{html}");
    }

    #[test]
    fn consent_html_account_scope_renders_the_account_copy() {
        let mut p = params();
        p.scopes = vec!["desktop.account".into()];
        let user = User {
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
        };
        let html = render_consent_html(&p, &user, "csrf-token");
        // Exposure-framed account blurb with the expiry.
        assert!(
            html.contains(
                "Approving gives this application account-level access to \
                 this gateway for 30 days: it can list your devservers and devservers shared \
                 with you, and mint access to them."
            ),
            "{html}"
        );
        assert!(!html.contains(r#"type="radio""#), "{html}");
        assert!(!html.contains(r#"name="devserver""#), "{html}");
    }

    #[test]
    fn humanize_picks_coarsest_unit() {
        assert_eq!(humanize_expires(30), "30 seconds");
        assert_eq!(humanize_expires(60), "1 minute");
        assert_eq!(humanize_expires(3600), "1 hour");
        assert_eq!(humanize_expires(86_400), "1 day");
        assert_eq!(humanize_expires(2 * 86_400), "2 days");
        assert_eq!(humanize_expires(30 * 86_400), "30 days");
    }
}
