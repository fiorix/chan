//! Gateway sign-in plus keychain-backed PAT storage for the mobile
//! leg: the authorize page runs in an authentication session, the
//! session intercepts the `chan://auth/callback` navigation in-process,
//! and the captured query settles here.
//!
//! A gateway connect calls `open_gateway_signin`. We generate a random
//! state nonce and a PKCE `code_verifier` (kept in-process) and start
//! the authentication session at
//! `/desktop/authorize?...&redirect_uri=chan://auth/callback&state=<nonce>\
//! &code_challenge=<challenge>&code_challenge_method=S256`.
//! The gateway handles OAuth (passkeys, autofill, all native to the
//! session's browser), mints a PAT, stores it under a one-time
//! redemption `code` bound to the S256 challenge, and navigates back to
//! the mobile callback (zero-delay meta refresh, manual fallback link)
//! with the code in the URL QUERY (`?code=<code>&state=<nonce>`), never
//! the PAT secret. A deny/error carries `?error=<reason>&state=<nonce>`.
//!
//! The session hands the captured URL to the settle path in-process (no
//! OS scheme registration, no second-instance spawn). The settle
//! validates the state nonce in constant time, then swaps
//! `{code, code_verifier}` for the PAT (`POST /desktop/authorize/redeem`
//! against the identity origin held in the slot, never one named by the
//! callback URL), commits the PAT under the connect attempt's credential
//! lock, and continues that same attempt. The commit keeps the PAT or
//! nothing: a refused answer, a failed store, and a cancel (before the
//! commit, or during it, which then undoes it, putting back the token
//! it replaced, unless a replacing connect waits for the PAT) keep
//! nothing of this sign-in, and its PAT is then revoked at the identity
//! origin, with itself as the bearer. Only a current attempt emits
//! `auth-changed` or `auth-error`.
//!
//! PKCE (RFC 7636, S256): the `code_verifier` is 32 CSPRNG bytes
//! encoded base64url-no-pad to a 43-char ASCII string; that STRING is
//! the verifier. `code_challenge = base64url_nopad(SHA256(verifier))`,
//! the hash over the ASCII bytes of the 43-char verifier string,
//! matching the gateway. Only the challenge (a non-invertible hash)
//! rides the browser leg; the verifier's sole appearance on any wire
//! is the redeem POST body, over TLS.
//!
//! The code is single-use with a short server-side TTL, dead after the
//! first redeem, and never logged (the settle path has no request
//! logging by construction).
//!
//! Keychain layout: service `chan-desktop`, one account per gateway
//! identity origin (`gateway:<origin>`, see `gateway_account`). Value
//! is JSON `{id, secret, label, expires_at}`; the token id names the
//! token in logs, since a revoke presents the secret itself.
//!
//! There is no user-facing sign-out. A gateway that answers 401 has
//! its entry dropped (`clear_gateway_pat`) so the next connect falls
//! into the browser sign-in instead of replaying a dead credential.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

use crate::gateway::GatewayAttempt;

#[derive(Clone)]
struct GatewaySignin {
    id: String,
    attempt: Arc<GatewayAttempt>,
}

impl GatewaySignin {
    fn matches(&self, id: &str, attempt: &Arc<GatewayAttempt>) -> bool {
        self.id == id && Arc::ptr_eq(&self.attempt, attempt)
    }
}

#[cfg(test)]
pub(crate) type TestStore = Box<dyn FnOnce(&str, &StoredPat) -> Result<(), String> + Send>;

/// Per-attempt test seams never reach a credential service.
#[cfg(test)]
#[derive(Default)]
pub(super) struct SigninTestHooks {
    pub after_install: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    pub store: Mutex<Option<TestStore>>,
    /// Runs after the redeem answered and before the credential commit.
    pub before_commit: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Runs inside the credential commit, under its lock, before any write.
    pub commit_started: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

/// Event emitted after a successful gateway sign-in callback. The launcher
/// listens and resynchronizes its library view.
pub const AUTH_CHANGED: &str = "auth-changed";

/// Event emitted when the callback fails (state mismatch, missing
/// fields, the identity origin returned `error=...`). Body is a human
/// string suitable for a banner.
pub const AUTH_ERROR: &str = "auth-error";

const KEYCHAIN_SERVICE: &str = "chan-desktop";

/// Account-level gateway scope: one PAT reads the account's devserver
/// roster and mints entries for any of its devservers (own or shared).
/// Requested as the SOLE scope; the gateway rejects mixed requests.
const DESKTOP_ACCOUNT_SCOPES: &str = "desktop.account";

const EXPIRES_IN_SECONDS: u64 = 30 * 24 * 60 * 60;

/// Bound on the redeem round trip. The listener task awaits it after
/// answering the browser, so fail fast enough to keep the flow snappy;
/// the code's server-side TTL comfortably outlives one retry.
const REDEEM_TIMEOUT_SECS: u64 = 15;

/// How long an idle sign-in slot (and its bound listener) lives before
/// the attempt-guarded expiry timer drops it. Set to the gateway row wait
/// so the slot never dies while the row still shows Connecting; the
/// callback path also treats an over-age slot as absent.
const SLOT_TTL: Duration = crate::gateway::GATEWAY_SIGNIN_TIMEOUT;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPat {
    pub id: String,
    pub secret: String,
    pub label: String,
    /// RFC3339 timestamp, or empty when the token never expires.
    #[serde(default)]
    pub expires_at: String,
}

/// Public view of the sign-in state. `secret` is intentionally never
/// surfaced to the frontend -- only `is_signed_in` and the metadata
/// the user can use to decide whether to re-mint.
#[derive(Debug, Clone, Serialize)]
pub struct AuthStatus {
    pub is_signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

fn entry_for(account: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| format!("keychain entry: {e}"))
}

fn store_for(account: &str, pat: &StoredPat) -> Result<(), String> {
    let json = serde_json::to_string(pat).map_err(|e| format!("encoding PAT: {e}"))?;
    entry_for(account)?
        .set_password(&json)
        .map_err(|e| format!("writing keychain: {e}"))
}

/// Best-effort hostname for the PAT label. Fall back to a generic
/// string so we never fail sign-in for cosmetic reasons.
pub fn hostname() -> String {
    gethostname::gethostname()
        .into_string()
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "this machine".to_string())
}

/// Authorization state owned by one gateway connect attempt. The matching
/// callback consumes it; expiry, cancellation, refused publication, and a
/// failed browser open or listener adoption clear it. A new sign-in for the
/// same gateway replaces it and stops the prior listener; another gateway
/// is refused while this slot is held. Only the owning listener and nonce
/// may complete the attempt.
struct PendingAuth {
    state: String,
    account: String,
    /// Origin that served the authorize page. The settle path redeems
    /// the callback's one-time code against this exact origin, never one
    /// named by the callback URL itself.
    identity_origin: String,
    gateway: GatewaySignin,
    /// PKCE verifier (the 43-char base64url string). Redacted from
    /// `Debug` so it never reaches a log line; its only wire appearance
    /// is the redeem POST body.
    code_verifier: String,
    /// When this slot was installed. The expiry timer and the callback
    /// path treat a slot older than [`SLOT_TTL`] as absent.
    created_at: Instant,
    /// Fires the bound listener's shutdown. Firing it stops the accept
    /// loop so a re-click, a completion, an error, or a timeout never
    /// leaks a bound port.
    shutdown: watch::Sender<bool>,
    /// The ephemeral port the loopback listener bound. Rides the
    /// `redirect_uri`; the callback's `Host` must name it.
    port: u16,
}

impl std::fmt::Debug for PendingAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingAuth")
            .field("state", &self.state)
            .field("account", &self.account)
            .field("identity_origin", &self.identity_origin)
            .field("gateway_id", &self.gateway.id)
            .field("code_verifier", &"<redacted>")
            .field("created_at", &self.created_at)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

fn pending_state() -> &'static Mutex<Option<PendingAuth>> {
    static PENDING: OnceLock<Mutex<Option<PendingAuth>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

/// Install a new pending slot, dropping any prior one's listener first so
/// a re-click never leaks a bound port. The gateway's attempt owns the slot
/// through callback classification, replacement and cancellation.
fn replace_pending(new: PendingAuth) -> Result<(), String> {
    let mut slot = pending_state().lock().unwrap();
    // A late predecessor must not replace a successor already installed.
    // The post-install publication still catches cancellation during this swap.
    if new.gateway.attempt.is_cancelled() {
        return Err("sign-in attempt cancelled".into());
    }
    if slot
        .as_ref()
        .is_some_and(|old| old.gateway.id != new.gateway.id)
    {
        return Err("another gateway sign-in is waiting on the browser - finish it first".into());
    }
    if let Some(old) = slot.take() {
        let _ = old.shutdown.send(true);
    }
    *slot = Some(new);
    Ok(())
}

/// 128 bits of randomness, hex-encoded. Used as the OAuth-style
/// state nonce to bind the browser leg to the callback leg.
fn new_state() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// PKCE `code_verifier`: 32 CSPRNG bytes, base64url-no-pad -> a 43-char
/// ASCII string. That string IS the verifier (RFC 7636 s4.1).
fn new_verifier() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

/// PKCE S256 challenge: `base64url_nopad(SHA256(ASCII(verifier)))`. The
/// hash is over the ASCII bytes of the 43-char verifier STRING (RFC 7636
/// s4.2), not any decoded form; both workspaces must agree on this.
fn challenge_for(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

pub fn gateway_account(identity_origin: &str) -> String {
    format!("gateway:{identity_origin}")
}

/// Test-only gateway PAT source, consulted before the OS keyring:
/// entry-scoped keyring mocks don't share state across `Entry`
/// instances, and a headless test host has no real credential service,
/// so flow tests seed credentials here.
#[cfg(test)]
pub(crate) fn test_gateway_pats() -> &'static Mutex<std::collections::HashMap<String, StoredPat>> {
    static PATS: OnceLock<Mutex<std::collections::HashMap<String, StoredPat>>> = OnceLock::new();
    PATS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[cfg(test)]
fn test_gateway_pat_load_errors() -> &'static Mutex<HashMap<String, String>> {
    static ERRORS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ERRORS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Clears an origin-scoped PAT load failure when the test scope exits.
#[cfg(test)]
pub(crate) struct GatewayPatLoadFailure(String);

#[cfg(test)]
impl Drop for GatewayPatLoadFailure {
    fn drop(&mut self) {
        test_gateway_pat_load_errors()
            .lock()
            .unwrap()
            .remove(&self.0);
    }
}

/// Inject a PAT load failure until the returned guard drops, including on panic.
#[cfg(test)]
pub(crate) fn fail_gateway_pat_load_for_test(
    identity_origin: &str,
    error: &str,
) -> GatewayPatLoadFailure {
    test_gateway_pat_load_errors()
        .lock()
        .unwrap()
        .insert(identity_origin.to_string(), error.to_string());
    GatewayPatLoadFailure(identity_origin.to_string())
}

#[cfg(test)]
fn test_gateway_pat_absences() -> &'static Mutex<std::collections::HashSet<String>> {
    static ABSENT: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    ABSENT.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Clears an origin-scoped missing-PAT answer when the test scope exits.
#[cfg(test)]
pub(crate) struct GatewayPatAbsence(String);

#[cfg(test)]
impl Drop for GatewayPatAbsence {
    fn drop(&mut self) {
        test_gateway_pat_absences().lock().unwrap().remove(&self.0);
    }
}

/// Answer the PAT load with no stored PAT until the returned guard drops,
/// including on panic, whatever the host keychain holds: a headless test
/// host may have no credential service to report an absent entry from.
#[cfg(test)]
pub(crate) fn absent_gateway_pat_for_test(identity_origin: &str) -> GatewayPatAbsence {
    test_gateway_pat_absences()
        .lock()
        .unwrap()
        .insert(identity_origin.to_string());
    GatewayPatAbsence(identity_origin.to_string())
}

pub fn load_gateway_pat(identity_origin: &str) -> Result<Option<StoredPat>, String> {
    #[cfg(test)]
    if let Some(error) = test_gateway_pat_load_errors()
        .lock()
        .unwrap()
        .get(identity_origin)
    {
        return Err(error.clone());
    }
    #[cfg(test)]
    if test_gateway_pat_absences()
        .lock()
        .unwrap()
        .contains(identity_origin)
    {
        return Ok(None);
    }
    #[cfg(test)]
    if let Some(pat) = test_gateway_pats().lock().unwrap().get(identity_origin) {
        return Ok(Some(pat.clone()));
    }
    let account = gateway_account(identity_origin);
    match entry_for(&account)?.get_password() {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("decoding stored gateway PAT: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("reading gateway keychain: {e}")),
    }
}

/// Drop the stored PAT for a gateway. The connect flow calls this when the
/// gateway answers 401 (the PAT was revoked or expired server-side), so the
/// next connect attempt falls into the browser sign-in instead of replaying
/// a dead credential.
pub fn clear_gateway_pat(identity_origin: &str) -> Result<(), String> {
    #[cfg(test)]
    if test_gateway_pats()
        .lock()
        .unwrap()
        .remove(identity_origin)
        .is_some()
    {
        return Ok(());
    }
    #[cfg(test)]
    if test_gateway_pat_absences()
        .lock()
        .unwrap()
        .contains(identity_origin)
    {
        return Ok(());
    }
    let account = gateway_account(identity_origin);
    match entry_for(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("clearing gateway keychain: {e}")),
    }
}

pub(super) fn clear_gateway_signin(id: &str, attempt: &Arc<GatewayAttempt>) {
    let mut slot = pending_state().lock().unwrap();
    if slot
        .as_ref()
        .is_some_and(|p| p.gateway.matches(id, attempt))
    {
        let pending = slot.take().expect("matching slot");
        let _ = pending.shutdown.send(true);
    }
}

/// Settle a captured mobile callback query against the pending slot: the same
/// compare-before-take classify plus settle the loopback listener runs, minus
/// the browser answer, which the authentication session owns. Only this
/// attempt's slot can be consumed; anything else ignores with the slot
/// intact.
pub(super) fn settle_mobile_query<R: tauri::Runtime>(
    app: AppHandle<R>,
    id: &str,
    attempt: &Arc<GatewayAttempt>,
    query: &str,
) {
    let action = {
        let mut pending = pending_state().lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|slot| slot.gateway.matches(id, attempt))
        {
            classify_callback(query, &mut pending)
        } else {
            CallbackAction::Ignore
        }
    };
    tauri::async_runtime::spawn(settle(app, action));
}

/// Fail this attempt's live mobile slot with a local (non-gateway) outcome:
/// a dismissed sheet, or a session that never presented. The slot must still
/// belong to the attempt; a successor's slot is left alone, and the failure
/// settles through the same row path as a gateway-reported error.
pub(super) fn fail_mobile_signin<R: tauri::Runtime>(
    app: AppHandle<R>,
    id: &str,
    attempt: &Arc<GatewayAttempt>,
    message: String,
) {
    let action = {
        let mut pending = pending_state().lock().unwrap();
        match pending.as_mut() {
            Some(slot) if slot.gateway.matches(id, attempt) => {
                let slot = pending.take().expect("slot matched");
                CallbackAction::Fail {
                    message,
                    gateway: slot.gateway,
                    shutdown: slot.shutdown,
                }
            }
            _ => CallbackAction::Ignore,
        }
    };
    tauri::async_runtime::spawn(settle(app, action));
}

pub(super) fn open_gateway_signin<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &Arc<crate::AppState>,
    discovery: &crate::devserver::GatewayDiscovery,
    id: &str,
    attempt: &Arc<GatewayAttempt>,
) -> Result<(), String> {
    launch_signin(app, state, discovery, id, attempt)
}

/// Install the slot, then publish the browser wait under its attempt guard.
/// The authentication session runs only after that publication, so an
/// immediate callback cannot be overwritten by a late pending publication.
/// No manager or slot lock spans the session start. A cancel there leaves
/// the browser leg no slot. The session captures the mobile callback
/// in-process and settles through the same classify plus redeem plus
/// commit path as the desktop.
fn launch_signin<R: tauri::Runtime>(
    app: &AppHandle<R>,
    app_state: &Arc<crate::AppState>,
    discovery: &crate::devserver::GatewayDiscovery,
    id: &str,
    attempt: &Arc<GatewayAttempt>,
) -> Result<(), String> {
    let state_nonce = new_state()?;
    let verifier = new_verifier()?;
    let challenge = challenge_for(&verifier);
    let port = 0u16;
    let label = format!("chan-ios @ {}", hostname());
    let redirect_uri = crate::mobile_auth::MOBILE_REDIRECT_URI.to_string();
    let url = authorize_url(discovery, &redirect_uri, &state_nonce, label, challenge)?;
    let gateway = GatewaySignin {
        id: id.into(),
        attempt: Arc::clone(attempt),
    };
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    replace_pending(PendingAuth {
        state: state_nonce,
        account: gateway_account(&discovery.identity_origin),
        identity_origin: discovery.identity_origin.clone(),
        gateway: gateway.clone(),
        code_verifier: verifier,
        created_at: Instant::now(),
        shutdown: shutdown_tx,
        port,
    })?;
    #[cfg(test)]
    if let Some(after_install) = attempt.signin_hooks.after_install.lock().unwrap().take() {
        after_install();
    }
    if !crate::gateway::publish_pending_signin(app, app_state, id, attempt, discovery) {
        clear_gateway_signin(id, attempt);
        return Ok(());
    }
    tauri::async_runtime::spawn(expire_slot(gateway.clone()));
    match crate::mobile_auth::start_mobile_signin(app, url.as_str(), id, attempt, shutdown_rx) {
        Ok(()) => Ok(()),
        Err(error) => {
            clear_gateway_signin(id, attempt);
            crate::gateway::withdraw_pending_signin(app_state, id, attempt);
            Err(error)
        }
    }
}

/// The gateway's authorize page with the sign-in's parameters. The
/// `redirect_uri` is the mobile callback; scope, PKCE, label, and expiry
/// ride exactly as the desktop sends them. No WireGuard key rides: this
/// leg enrolls nothing.
fn authorize_url(
    discovery: &crate::devserver::GatewayDiscovery,
    redirect_uri: &str,
    state_nonce: &str,
    label: String,
    challenge: String,
) -> Result<url::Url, String> {
    let params = vec![
        ("redirect_uri", redirect_uri.to_string()),
        ("state", state_nonce.to_string()),
        ("label", label),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256".to_string()),
        ("scopes", DESKTOP_ACCOUNT_SCOPES.to_string()),
        ("expires_in", EXPIRES_IN_SECONDS.to_string()),
    ];
    url::Url::parse_with_params(&discovery.desktop_authorize_url, &params)
        .map_err(|e| format!("building authorize URL: {e}"))
}

fn fail_signin<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &crate::AppState,
    flow: &GatewaySignin,
    error: &str,
) {
    clear_gateway_signin(&flow.id, &flow.attempt);
    crate::gateway::fail_gateway_signin(app, state, &flow.id, &flow.attempt, error);
}

/// Expiry clears only the slot belonging to this listener's attempt. Row
/// expiry has its own guarded transition in the gateway manager.
async fn expire_slot(flow: GatewaySignin) {
    tokio::time::sleep(SLOT_TTL).await;
    clear_gateway_signin(&flow.id, &flow.attempt);
}

/// What the settle path should do with a classified callback. Decided
/// before any I/O so the route + state rules are unit-testable.
enum CallbackAction {
    /// Swap the one-time code + verifier for the PAT, store it, and emit
    /// AUTH_CHANGED; on a gateway flow, resume the parked connect.
    Redeem {
        code: String,
        code_verifier: String,
        identity_origin: String,
        account: String,
        gateway: GatewaySignin,
        /// The taken slot's listener shutdown, fired once this callback
        /// owns the flow.
        shutdown: watch::Sender<bool>,
    },
    /// Emit AUTH_ERROR and settle this attempt if it still owns the row
    /// (a matching-state error or a matching-state callback missing its code).
    Fail {
        message: String,
        gateway: GatewaySignin,
        shutdown: watch::Sender<bool>,
    },
    /// Non-consuming: no matching pending slot (absent, over-age, or a
    /// state mismatch). Nothing stored, nothing emitted, slot intact.
    Ignore,
}

impl std::fmt::Debug for CallbackAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Redact the verifier from Debug too (a test panic must not
            // print it).
            CallbackAction::Redeem {
                code,
                identity_origin,
                account,
                gateway,
                ..
            } => f
                .debug_struct("Redeem")
                .field("code", code)
                .field("code_verifier", &"<redacted>")
                .field("identity_origin", identity_origin)
                .field("account", account)
                .field("gateway_id", &gateway.id)
                .finish_non_exhaustive(),
            CallbackAction::Fail { message, .. } => f
                .debug_struct("Fail")
                .field("message", message)
                .finish_non_exhaustive(),
            CallbackAction::Ignore => f.write_str("Ignore"),
        }
    }
}

/// Classify a loopback callback QUERY against the pending slot. COMPARE-
/// BEFORE-TAKE: peek the slot; an absent or over-age slot is a
/// non-consuming `Ignore`; a constant-time `state` mismatch is a
/// non-consuming `Ignore` (slot INTACT, no AUTH_ERROR); a matching state
/// takes the slot, then `error` -> `Fail`, `code` -> `Redeem`. The redeem
/// target is always the slot's `identity_origin`; the callback never
/// steers it.
fn classify_callback(query: &str, pending: &mut Option<PendingAuth>) -> CallbackAction {
    let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();

    // Peek (do not take): a mismatch or an absent/expired slot must leave
    // a live browser leg untouched.
    let Some(expected) = pending.as_ref() else {
        return CallbackAction::Ignore;
    };
    if expected.created_at.elapsed() >= SLOT_TTL {
        return CallbackAction::Ignore;
    }
    let got_state = params.get("state").map(String::as_str).unwrap_or("");
    if !ct_eq_str(&expected.state, got_state) {
        return CallbackAction::Ignore;
    }

    // Matching state: this callback owns the slot. Take it.
    let expected = pending.take().expect("slot peeked as Some");
    if let Some(err) = params.get("error") {
        return CallbackAction::Fail {
            message: signin_error_message(err),
            gateway: expected.gateway,
            shutdown: expected.shutdown,
        };
    }
    let code = params.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        return CallbackAction::Fail {
            message: "callback missing redemption code".to_string(),
            gateway: expected.gateway,
            shutdown: expected.shutdown,
        };
    }
    CallbackAction::Redeem {
        code,
        code_verifier: expected.code_verifier,
        identity_origin: expected.identity_origin,
        account: expected.account,
        gateway: expected.gateway,
        shutdown: expected.shutdown,
    }
}

/// Constant-time string compare. Unequal lengths short-circuit (the
/// `state` is a fixed 32-hex nonce, so there is no length to leak); equal
/// lengths compare in constant time via `subtle`, so a local process
/// reaching the port cannot time the compare to recover `state`.
fn ct_eq_str(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Run the classified action's I/O: redeem + store + emit + resume, or
/// emit the error + settle its owning attempt. Fires the slot's listener
/// shutdown first so the accept loop stops.
async fn settle<R: tauri::Runtime>(app: AppHandle<R>, action: CallbackAction) {
    match action {
        CallbackAction::Redeem {
            code,
            code_verifier,
            identity_origin,
            account,
            gateway,
            shutdown,
        } => {
            let _ = shutdown.send(true);
            gateway.attempt.accept_callback();
            let state = Arc::clone(&app.state::<Arc<crate::AppState>>());
            // Awaited through a cancel, not raced against it: identity mints
            // the token as it answers, so a dropped answer would leave a token
            // nobody can revoke. A cancelled attempt's commit refuses below,
            // and that refusal revokes the token. The redeem's own timeout
            // bounds the wait.
            let redeemed = match redeem_inner(&identity_origin, &code, &code_verifier).await {
                Ok(redeemed) => redeemed,
                Err(RedeemError { message, minted }) => {
                    if let Some(minted) = &minted {
                        revoke_unkept(&gateway.id, &identity_origin, &minted.id, &minted.secret)
                            .await;
                    }
                    fail_signin(&app, &state, &gateway, &message);
                    return;
                }
            };
            // The redeem answer's WireGuard parameters are ignored on
            // this leg: no key was sent, so nothing enrolls.
            let _ = &redeemed.wireguard;
            let pat = StoredPat {
                id: redeemed.id,
                secret: redeemed.secret,
                label: redeemed.label,
                expires_at: redeemed.expires_at.unwrap_or_default(),
            };
            let mut writes = SigninWrites {
                state: Arc::clone(&state),
                gateway_id: gateway.id.clone(),
                identity_origin: identity_origin.clone(),
                account,
                pat: pat.clone(),
                prior_pat: None,
                #[cfg(test)]
                attempt: Arc::clone(&gateway.attempt),
            };
            let attempt = Arc::clone(&gateway.attempt);
            #[cfg(test)]
            if let Some(hook) = attempt.signin_hooks.before_commit.lock().unwrap().take() {
                hook();
            }
            // Once this worker starts, join it even after cancellation: a
            // commit is never abandoned midway, and one a cancel lands in is
            // undone inside it. The worker logs to this task's subscriber,
            // where the sign-in's own lines go.
            let dispatch = tracing::dispatcher::get_default(|dispatch| dispatch.clone());
            let committed = tokio::task::spawn_blocking(move || {
                let _logging = tracing::dispatcher::set_default(&dispatch);
                attempt.commit_credentials(&mut writes)
            })
            .await
            .unwrap_or_else(|e| Err(format!("storing gateway credentials: {e}")));
            match committed {
                Ok(true) => {
                    crate::gateway::resume_gateway_signin(
                        app,
                        state,
                        gateway.id,
                        gateway.attempt,
                        pat,
                    )
                    .await
                }
                // Cancelled before the commit or undone after it: nothing of
                // this sign-in is kept, and the cancel's owner reports the row.
                Ok(false) => {
                    tracing::info!(
                        gateway = %gateway.id,
                        "gateway sign-in cancelled; its credentials are not kept",
                    );
                    revoke_unkept(&gateway.id, &identity_origin, &pat.id, &pat.secret).await;
                }
                Err(error) => {
                    revoke_unkept(&gateway.id, &identity_origin, &pat.id, &pat.secret).await;
                    fail_signin(&app, &state, &gateway, &error);
                }
            }
        }
        CallbackAction::Fail {
            message,
            gateway,
            shutdown,
        } => {
            let _ = shutdown.send(true);
            let state = Arc::clone(&app.state::<Arc<crate::AppState>>());
            fail_signin(&app, &state, &gateway, &message);
        }
        CallbackAction::Ignore => {}
    }
}

/// One credential commit: the token alone on this leg. Undo restores
/// the prior token while this commit still owns it.
struct SigninWrites {
    state: Arc<crate::AppState>,
    gateway_id: String,
    identity_origin: String,
    account: String,
    pat: StoredPat,
    /// The token the store held before this commit, once read.
    prior_pat: Option<Option<StoredPat>>,
    #[cfg(test)]
    attempt: Arc<GatewayAttempt>,
}

impl crate::gateway::CredentialWrites for SigninWrites {
    fn write(&mut self) -> Result<(), String> {
        #[cfg(test)]
        if let Some(hook) = self
            .attempt
            .signin_hooks
            .commit_started
            .lock()
            .unwrap()
            .take()
        {
            hook();
        }
        self.prior_pat = Some(read_stored_pat(&self.identity_origin)?);
        self.store()?;
        Ok(())
    }

    fn undo(&mut self) {
        // The token goes back to what the store held before, unless a later
        // commit has stored its own since.
        match read_stored_pat(&self.identity_origin) {
            Ok(Some(stored)) if stored.id == self.pat.id => {
                let prior = self.prior_pat.take().flatten();
                if let Err(error) =
                    put_back_gateway_pat(&self.identity_origin, &self.account, prior.as_ref())
                {
                    tracing::warn!(
                        gateway = %self.gateway_id,
                        %error,
                        "putting back the credential store an undone sign-in replaced failed",
                    );
                }
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(
                gateway = %self.gateway_id,
                %error,
                "reading the credential store to undo a sign-in failed",
            ),
        }
    }

    fn abandoned(&self) -> bool {
        self.state
            .store
            .lock()
            .unwrap()
            .get()
            .is_ok_and(|cfg| !cfg.gateways.iter().any(|g| g.id == self.gateway_id))
    }
}

impl SigninWrites {
    fn store(&self) -> Result<(), String> {
        #[cfg(test)]
        if let Some(store) = self.attempt.signin_hooks.store.lock().unwrap().take() {
            return store(&self.account, &self.pat);
        }
        store_for(&self.account, &self.pat)
    }
}

/// Put `pat` back as the stored token for `identity_origin`, or remove the
/// stored one when there was none before.
fn put_back_gateway_pat(
    identity_origin: &str,
    account: &str,
    pat: Option<&StoredPat>,
) -> Result<(), String> {
    match pat {
        Some(pat) => restore_stored_pat(identity_origin, account, pat),
        None => clear_gateway_pat(identity_origin),
    }
}

/// Bound on revoking a token the sign-in does not keep. A failed sign-in
/// reports only after it, so it stays short; a revoke that runs out is
/// logged, and the token then lives until it expires.
const REVOKE_TIMEOUT_SECS: u64 = 10;

/// What identity answered a token revoking itself.
#[derive(Debug, PartialEq, Eq)]
enum Revoked {
    /// Revoked by this request.
    Now,
    /// The answer every invalid bearer gets: the token is already revoked,
    /// expired or unknown, so nothing is left to revoke and nothing retries.
    AlreadyGone,
}

/// Revoke `secret` at the identity origin that minted it, presenting it as
/// its own bearer, so the request can revoke that token and no other. It
/// goes through the shared HTTP client and its WireGuard proxy decision, as
/// the redeem does.
async fn revoke_inner(identity_origin: &str, secret: &str) -> Result<Revoked, String> {
    let url = format!("{}/desktop/v1/token", identity_origin.trim_end_matches('/'));
    let client = crate::devserver::tls_client_builder()
        .and_then(|builder| {
            builder
                .timeout(Duration::from_secs(REVOKE_TIMEOUT_SECS))
                .build()
                .map_err(|e| e.to_string())
        })
        .map_err(|e| format!("building revoke http client: {e}"))?;
    let resp = client
        .delete(&url)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|e| format!("revoking the token: {e}"))?;
    // Exactly the route's answer counts. An identity without the route
    // answers its SPA fallback (200 and a page) to any path, which revoked
    // nothing.
    let status = resp.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        Ok(Revoked::Now)
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        Ok(Revoked::AlreadyGone)
    } else {
        Err(format!(
            "revoking the token: the gateway answered HTTP {status}, so it may not offer the token self-revoke"
        ))
    }
}

/// Revoke a token this sign-in minted and does not keep. The sign-in has
/// already failed or been cancelled, so the revoke's own outcome is only
/// logged, by the token's id and never its secret, at the level a failed
/// gateway connect logs.
async fn revoke_unkept(gateway_id: &str, identity_origin: &str, token_id: &str, secret: &str) {
    match revoke_inner(identity_origin, secret).await {
        Ok(Revoked::Now) => {
            tracing::info!(gateway = %gateway_id, token = %token_id, "gateway sign-in token revoked");
        }
        Ok(Revoked::AlreadyGone) => {
            tracing::info!(
                gateway = %gateway_id,
                token = %token_id,
                "gateway sign-in token had nothing left to revoke",
            );
        }
        Err(error) => tracing::warn!(
            gateway = %gateway_id,
            token = %token_id,
            %error,
            "revoking a gateway sign-in token the desktop does not keep failed; the token lives until it expires",
        ),
    }
}

/// The token a redeem answer names, decoded before the rest of the answer:
/// identity minted it once it answered, so it can be revoked even when
/// nothing else in the answer can be used.
#[derive(Deserialize)]
struct MintedToken {
    id: String,
    secret: String,
}

impl std::fmt::Debug for MintedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MintedToken")
            .field("id", &self.id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// Why a redeem gave the sign-in no answer it can use.
#[derive(Debug)]
struct RedeemError {
    message: String,
    /// The token an answer named when the rest of it did not decode. The
    /// sign-in keeps nothing of that answer, so it revokes the token before
    /// it fails.
    minted: Option<MintedToken>,
}

impl From<String> for RedeemError {
    fn from(message: String) -> Self {
        Self {
            message,
            minted: None,
        }
    }
}

/// What the redeem endpoint answers with, exactly once per code.
#[derive(Debug, Deserialize)]
struct RedeemedPat {
    id: String,
    secret: String,
    label: String,
    /// RFC3339 timestamp; `null` on the wire for a token that never
    /// expires.
    #[serde(default)]
    expires_at: Option<String>,
    /// What the gateway enrolled the sent WireGuard key with; absent when
    /// no key was sent.
    #[serde(default)]
    wireguard: Option<crate::wireguard_keys::EnrollmentParams>,
}

/// Swap the one-time code plus the PKCE verifier for the PAT at the
/// identity origin that issued it. Runs on the listener's tokio task
/// (the accept-serve path is already async), so no dedicated thread or
/// nested runtime is needed.
async fn redeem_inner(
    identity_origin: &str,
    code: &str,
    code_verifier: &str,
) -> Result<RedeemedPat, RedeemError> {
    let url = format!(
        "{}/desktop/authorize/redeem",
        identity_origin.trim_end_matches('/')
    );
    let body = serde_json::json!({ "code": code, "code_verifier": code_verifier });
    let client = crate::devserver::tls_client_builder()
        .and_then(|builder| {
            builder
                .timeout(Duration::from_secs(REDEEM_TIMEOUT_SECS))
                .build()
                .map_err(|e| e.to_string())
        })
        .map_err(|e| format!("building redeem http client: {e}"))?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("redeeming sign-in code: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::GONE {
        return Err(
            "the sign-in link expired or was already used; try signing in again"
                .to_string()
                .into(),
        );
    }
    if !status.is_success() {
        return Err(format!("redeeming sign-in code: the gateway answered HTTP {status}").into());
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("reading redeemed token: {e}"))?;
    decode_redeemed(&body)
}

/// Decode a redeem answer in two steps, the token it names first and then
/// the whole answer, so an answer whose token decodes and whose rest does
/// not (a keepalive out of range, a field of the wrong type) still hands
/// back the token identity minted, for the sign-in to revoke.
fn decode_redeemed(body: &[u8]) -> Result<RedeemedPat, RedeemError> {
    let minted: MintedToken =
        serde_json::from_slice(body).map_err(|e| format!("decoding redeemed token: {e}"))?;
    serde_json::from_slice(body).map_err(|e| RedeemError {
        message: format!("decoding redeemed token: {e}"),
        minted: Some(minted),
    })
}

/// Map an identity-origin `error=` reason token to the banner string. The
/// tokens are the gateway's stable desktop-authorize vocabulary; the human
/// strings live here on the desktop so gateway deploys never reword the UI.
fn signin_error_message(reason: &str) -> String {
    match reason {
        "user_cancelled" => "sign-in was cancelled in the browser".to_string(),
        "oauth_denied" => "sign-in was denied by the identity provider".to_string(),
        "account_blocked" => "sign-in failed: this account is blocked".to_string(),
        "mint_failed" => "sign-in failed: the gateway could not issue an access token".to_string(),
        "wireguard_enroll_failed" => {
            "sign-in failed: the gateway could not enroll the WireGuard key".to_string()
        }
        other => format!("sign-in failed in the browser: {other}"),
    }
}

/// The token the store holds for `identity_origin`, as a commit reads it
/// before replacing it and again before undoing.
#[cfg(not(test))]
fn read_stored_pat(identity_origin: &str) -> Result<Option<StoredPat>, String> {
    load_gateway_pat(identity_origin)
}

/// Tests answer from the in-process store alone: a headless test host has
/// no credential service to read.
#[cfg(test)]
fn read_stored_pat(identity_origin: &str) -> Result<Option<StoredPat>, String> {
    if let Some(error) = test_gateway_pat_load_errors()
        .lock()
        .unwrap()
        .get(identity_origin)
    {
        return Err(error.clone());
    }
    Ok(test_gateway_pats()
        .lock()
        .unwrap()
        .get(identity_origin)
        .cloned())
}

#[cfg(not(test))]
fn restore_stored_pat(
    _identity_origin: &str,
    account: &str,
    pat: &StoredPat,
) -> Result<(), String> {
    store_for(account, pat)
}

/// Tests keep the restored token in the in-process store the sign-in's store
/// hook writes to.
#[cfg(test)]
fn restore_stored_pat(
    identity_origin: &str,
    _account: &str,
    pat: &StoredPat,
) -> Result<(), String> {
    test_gateway_pats()
        .lock()
        .unwrap()
        .insert(identity_origin.to_string(), pat.clone());
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) static SLOT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    pub(crate) fn install_pending_for_test(
        id: &str,
        attempt: &Arc<GatewayAttempt>,
    ) -> watch::Receiver<bool> {
        let mut slot = pending("cancel-test").unwrap();
        slot.gateway.id = id.into();
        slot.gateway.attempt = Arc::clone(attempt);
        let receiver = slot.shutdown.subscribe();
        replace_pending(slot).unwrap();
        receiver
    }

    pub(crate) fn take_pending_for_test() -> bool {
        pending_state().lock().unwrap().take().is_some()
    }

    pub(crate) fn try_stale_slot_for_test(
        id: &str,
        attempt: &Arc<GatewayAttempt>,
    ) -> Result<(), String> {
        let mut new = pending("stale").unwrap();
        new.gateway = GatewaySignin {
            id: id.into(),
            attempt: Arc::clone(attempt),
        };
        replace_pending(new)
    }

    pub(crate) fn callback_for_test(
        app: AppHandle<tauri::test::MockRuntime>,
        id: &str,
        attempt: &Arc<GatewayAttempt>,
        origin: &str,
        query: &str,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let mut slot = pending("nonce-1");
        let pending = slot.as_mut().unwrap();
        pending.gateway = GatewaySignin {
            id: id.into(),
            attempt: Arc::clone(attempt),
        };
        pending.identity_origin = origin.into();
        pending.account = gateway_account(origin);
        let action = classify_callback(query, &mut slot);
        assert!(slot.is_none(), "test callback must consume the slot");
        settle(app, action)
    }

    /// How long [`assert_listener_destroyed`] waits for the queued client's
    /// reset before it reports the listener still listening.

    #[tokio::test(start_paused = true)]
    async fn stale_slot_timer_keeps_the_successor_and_current_timer_stops_it() {
        let _serial = SLOT_TEST_LOCK.lock().await;
        let old = Arc::new(GatewayAttempt::default());
        let current = Arc::new(GatewayAttempt::default());
        let stopped = install_pending_for_test("gw-keychain", &current);
        expire_slot(GatewaySignin {
            id: "gw-keychain".into(),
            attempt: old,
        })
        .await;
        assert!(
            !*stopped.borrow(),
            "stale expiry cannot stop the successor listener"
        );
        assert!(
            pending_state().lock().unwrap().is_some(),
            "stale expiry cannot clear the successor slot"
        );
        expire_slot(GatewaySignin {
            id: "gw-keychain".into(),
            attempt: current,
        })
        .await;
        assert!(*stopped.borrow(), "current expiry stops the listener");
        assert!(!take_pending_for_test());
    }

    #[test]
    fn signin_error_message_maps_the_authorize_reason_tokens() {
        // The gateway's stable `error=` vocabulary (desktop_authorize):
        // banner strings live desktop-side, one per token, and an unknown
        // token still names itself so a future reason is never swallowed.
        assert_eq!(
            signin_error_message("user_cancelled"),
            "sign-in was cancelled in the browser"
        );
        assert_eq!(
            signin_error_message("oauth_denied"),
            "sign-in was denied by the identity provider"
        );
        assert_eq!(
            signin_error_message("account_blocked"),
            "sign-in failed: this account is blocked"
        );
        assert_eq!(
            signin_error_message("mint_failed"),
            "sign-in failed: the gateway could not issue an access token"
        );
        assert_eq!(
            signin_error_message("wireguard_enroll_failed"),
            "sign-in failed: the gateway could not enroll the WireGuard key"
        );
        assert_eq!(
            signin_error_message("quota_exceeded"),
            "sign-in failed in the browser: quota_exceeded"
        );
    }

    #[test]
    fn authorize_url_with_the_mobile_redirect_keeps_every_other_parameter() {
        // The iOS leg sends the registered mobile callback as its redirect;
        // scope, PKCE, label, and expiry ride exactly as on desktop.
        let discovery = crate::gateway::tests::runtime_with(Vec::new()).discovery;
        let url = authorize_url(
            &discovery,
            crate::mobile_auth::MOBILE_REDIRECT_URI,
            "nonce-1",
            "chan-ios @ host".into(),
            "challenge".into(),
        )
        .unwrap();
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("redirect_uri", "chan://auth/callback"),
                ("state", "nonce-1"),
                ("label", "chan-ios @ host"),
                ("code_challenge", "challenge"),
                ("code_challenge_method", "S256"),
                ("scopes", "desktop.account"),
                ("expires_in", "2592000"),
            ]
            .into_iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect::<Vec<_>>(),
        );
    }

    // --- PKCE construction, pinned against silent drift ---

    #[test]
    fn new_verifier_is_a_43_char_base64url_string() {
        let v = new_verifier().expect("verifier");
        assert_eq!(v.len(), 43, "32 bytes base64url-no-pad is 43 chars");
        assert!(
            v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "base64url alphabet only: {v}"
        );
    }

    #[test]
    fn challenge_for_matches_rfc7636_known_vector() {
        // RFC 7636 Appendix B. Both workspaces MUST agree on this: the
        // hash is over the ASCII bytes of the verifier string.
        const RFC_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const RFC_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(challenge_for(RFC_VERIFIER), RFC_CHALLENGE);
    }

    #[test]
    fn challenge_for_is_43_chars_and_differs_from_the_verifier() {
        let v = new_verifier().expect("verifier");
        let c = challenge_for(&v);
        assert_eq!(c.len(), 43);
        assert_ne!(c, v, "the challenge is a hash, not the verifier");
    }

    // --- classify_callback: the loopback state machine ---

    fn pending(state: &str) -> Option<PendingAuth> {
        let (shutdown, _rx) = watch::channel(false);
        Some(PendingAuth {
            state: state.to_string(),
            account: "gw.chan.app".to_string(),
            identity_origin: "https://id.example".to_string(),
            gateway: GatewaySignin {
                id: "gw-1".into(),
                attempt: Arc::new(GatewayAttempt::default()),
            },
            code_verifier: "verifier-abc".to_string(),
            created_at: Instant::now(),
            shutdown,
            port: 54321,
        })
    }

    #[test]
    fn classify_redeems_on_a_matching_state_carrying_slot_verifier_and_query_code() {
        let mut slot = pending("nonce-1");
        match classify_callback("code=one-time-abc&state=nonce-1", &mut slot) {
            CallbackAction::Redeem {
                code,
                code_verifier,
                identity_origin,
                account,
                gateway,
                ..
            } => {
                assert_eq!(code, "one-time-abc", "code comes from the query");
                assert_eq!(
                    code_verifier, "verifier-abc",
                    "verifier comes from the slot"
                );
                assert_eq!(identity_origin, "https://id.example");
                assert_eq!(account, "gw.chan.app");
                assert_eq!(gateway.id, "gw-1");
            }
            other => panic!("expected Redeem, got {other:?}"),
        }
        assert!(slot.is_none(), "a matching callback consumes the slot");
    }

    #[test]
    fn classify_redeem_target_is_always_the_slot_origin() {
        // The callback query cannot name a redeem host; the origin is
        // structurally the slot's, even if the query tries to smuggle one.
        let mut slot = pending("nonce-1");
        match classify_callback(
            "code=c1&state=nonce-1&identity_origin=https://evil.example",
            &mut slot,
        ) {
            CallbackAction::Redeem {
                identity_origin, ..
            } => {
                assert_eq!(identity_origin, "https://id.example");
            }
            other => panic!("expected Redeem, got {other:?}"),
        }
    }

    #[test]
    fn classify_state_mismatch_is_non_consuming() {
        // A mismatched probe leaves the slot INTACT (no cancel oracle) and
        // raises no AUTH_ERROR.
        let mut slot = pending("nonce-2");
        assert!(matches!(
            classify_callback("code=c1&state=nonce-1", &mut slot),
            CallbackAction::Ignore
        ));
        assert!(
            slot.as_ref().is_some_and(|p| p.state == "nonce-2"),
            "the slot survives a state mismatch"
        );
    }

    #[test]
    fn classify_missing_state_is_non_consuming() {
        let mut slot = pending("nonce-1");
        assert!(matches!(
            classify_callback("code=c1", &mut slot),
            CallbackAction::Ignore
        ));
        assert!(slot.is_some(), "the slot survives a missing state");
    }

    #[test]
    fn classify_ignores_with_nothing_pending() {
        let mut slot: Option<PendingAuth> = None;
        for query in [
            "code=one-time-abc&state=nonce-1",
            "error=user_cancelled&state=nonce-1",
        ] {
            assert!(matches!(
                classify_callback(query, &mut slot),
                CallbackAction::Ignore
            ));
        }
    }

    #[test]
    fn classify_over_age_slot_is_ignore_not_fail() {
        let mut slot = pending("nonce-1");
        // Force the slot past the TTL.
        if let Some(p) = slot.as_mut() {
            p.created_at = Instant::now() - (SLOT_TTL + Duration::from_secs(1));
        }
        assert!(
            matches!(
                classify_callback("code=c1&state=nonce-1", &mut slot),
                CallbackAction::Ignore
            ),
            "an over-age slot is treated as absent, not a failure"
        );
        assert!(slot.is_some(), "the over-age slot is left for the timer");
    }

    #[test]
    fn classify_surfaces_a_deny_that_consumes_the_slot() {
        let mut slot = pending("nonce-1");
        match classify_callback("error=user_cancelled&state=nonce-1", &mut slot) {
            CallbackAction::Fail { message, .. } => {
                assert_eq!(message, "sign-in was cancelled in the browser");
            }
            other => panic!("expected Fail, got {other:?}"),
        }
        assert!(slot.is_none(), "a matching error consumes the slot");
    }

    #[test]
    fn classify_two_tab_regression_ignores_the_stale_tab() {
        // Slot holds nonce2 (the latest sign-in); a callback for nonce1
        // (the abandoned tab) must Ignore and leave nonce2 live.
        let mut slot = pending("nonce2");
        assert!(matches!(
            classify_callback("code=c1&state=nonce1", &mut slot),
            CallbackAction::Ignore
        ));
        assert!(slot.as_ref().is_some_and(|p| p.state == "nonce2"));
    }

    #[test]
    fn classify_matching_state_missing_code_fails() {
        let mut slot = pending("nonce-1");
        match classify_callback("state=nonce-1", &mut slot) {
            CallbackAction::Fail { message, .. } => {
                assert!(message.contains("missing redemption code"), "{message}");
            }
            other => panic!("expected Fail, got {other:?}"),
        }
        assert!(slot.is_none());
    }

    // --- redacting Debug: the verifier never reaches a log line ---

    #[test]
    fn pending_debug_redacts_the_verifier() {
        let slot = pending("nonce-1").unwrap();
        let rendered = format!("{slot:?}");
        assert!(
            !rendered.contains("verifier-abc"),
            "the verifier must be redacted from Debug: {rendered}"
        );
        assert!(rendered.contains("<redacted>"), "{rendered}");
    }

    // --- listener route rules (extracted, no browser) ---

    const PORT: u16 = 45678;

    // --- the neutrality invariant, on the bytes the listener writes ---

    // --- F2: a slow connection does not block the next accept ---

    // --- F3: a bind failure returns Err and installs no slot ---

    // --- redeem: body carries {code, code_verifier} ---

    /// One-shot HTTP stub: accepts a single connection, answers with a
    /// canned response, and hands back the raw request it read.
    fn stub_identity(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            sock.set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut data = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match sock.read(&mut buf) {
                    // The request body is JSON, so a complete request
                    // ends with the object's closing brace.
                    Ok(n) if n > 0 => {
                        data.extend_from_slice(&buf[..n]);
                        if data.ends_with(b"}") {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let resp = format!(
                "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(resp.as_bytes()).expect("write response");
            String::from_utf8_lossy(&data).into_owned()
        });
        (origin, handle)
    }

    #[tokio::test]
    async fn redeem_inner_parses_a_successful_redemption_and_posts_code_and_verifier() {
        let (origin, stub) = stub_identity(
            "200 OK",
            r#"{"id":"t-1","secret":"chan_pat_x","label":"mbp","expires_at":null}"#,
        );
        let pat = redeem_inner(&origin, "one-time-abc", "verifier-xyz")
            .await
            .expect("redeem ok");
        assert_eq!(pat.id, "t-1");
        assert_eq!(pat.secret, "chan_pat_x");
        assert_eq!(pat.label, "mbp");
        assert_eq!(pat.expires_at, None);
        let request = stub.join().expect("stub thread");
        assert!(
            request.starts_with("POST /desktop/authorize/redeem HTTP/1.1"),
            "{request}"
        );
        assert!(request.contains(r#""code":"one-time-abc""#), "{request}");
        assert!(
            request.contains(r#""code_verifier":"verifier-xyz""#),
            "{request}"
        );
    }

    #[tokio::test]
    async fn redeem_inner_maps_410_to_a_replay_message() {
        let (origin, _stub) = stub_identity(
            "410 Gone",
            r#"{"error":"unknown, expired, or already-redeemed code"}"#,
        );
        let err = redeem_inner(&origin, "stale", "v")
            .await
            .expect_err("410 is an error");
        assert!(
            err.message.contains("expired or was already used"),
            "{err:?}"
        );
        assert!(err.minted.is_none(), "no token was minted");
    }

    #[tokio::test]
    async fn redeem_inner_surfaces_other_http_failures() {
        let (origin, _stub) = stub_identity("500 Internal Server Error", "{}");
        let err = redeem_inner(&origin, "c1", "v")
            .await
            .expect_err("500 is an error");
        assert!(err.message.contains("HTTP 500"), "{err:?}");
        assert!(err.minted.is_none(), "no token was minted");
    }

    #[test]
    fn decode_redeemed_hands_back_a_token_whose_answer_does_not_decode() {
        let overflow = br#"{"id":"t-1","secret":"chan_pat_x","label":"mbp","expires_at":null,
            "wireguard":{"server_public_key":"k","endpoint":"e","addresses":[],
            "allowed_ips":[],"persistent_keepalive":70000}}"#;
        let err = decode_redeemed(overflow).expect_err("a keepalive above 65535");
        let minted = err.minted.as_ref().expect("the token decodes on its own");
        assert_eq!(
            (minted.id.as_str(), minted.secret.as_str()),
            ("t-1", "chan_pat_x")
        );
        assert!(
            err.message.starts_with("decoding redeemed token"),
            "{err:?}"
        );
        assert!(
            !format!("{} {err:?}", err.message).contains("chan_pat_x"),
            "neither the message nor the debug form carries the token"
        );
        // An answer naming no token leaves nothing to revoke.
        for body in [
            br#"{"id":"t-1","label":"mbp"}"#.as_slice(),
            b"<!doctype html>".as_slice(),
        ] {
            let err = decode_redeemed(body).expect_err("no token");
            assert!(err.minted.is_none(), "{err:?}");
        }
    }

    /// An identity answering every request with `status` and `body`, which
    /// reports the `Authorization` header each request carried.
    async fn status_identity(
        status: u16,
        body: &'static str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Option<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (seen, bearers) = tokio::sync::mpsc::unbounded_channel();
        let router = axum::Router::new().fallback(move |headers: axum::http::HeaderMap| {
            let seen = seen.clone();
            async move {
                let _ = seen.send(
                    headers
                        .get(axum::http::header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string),
                );
                (axum::http::StatusCode::from_u16(status).unwrap(), body)
            }
        });
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (origin, bearers)
    }

    #[tokio::test]
    async fn revoke_inner_counts_only_204_as_revoked() {
        for (status, body, expected) in [
            (204, "", Some(Revoked::Now)),
            (
                401,
                r#"{"error":"unauthorized"}"#,
                Some(Revoked::AlreadyGone),
            ),
            // An identity without the route: its SPA fallback answers 200
            // and a page, which revoked nothing.
            (200, "<!doctype html><title>chan</title>", None),
            (202, "", None),
            (404, "", None),
            (503, "frontend not built", None),
        ] {
            let (origin, mut bearers) = status_identity(status, body).await;
            let answer = revoke_inner(&origin, "chan_pat_test").await;
            match expected {
                Some(revoked) => assert_eq!(answer, Ok(revoked), "{status}"),
                None => {
                    let error = answer.expect_err("not revoked");
                    assert!(
                        error.contains(&format!("HTTP {status}"))
                            && error.contains("may not offer the token self-revoke"),
                        "{status}: {error}"
                    );
                }
            }
            assert_eq!(
                bearers.recv().await.unwrap().as_deref(),
                Some("Bearer chan_pat_test"),
                "{status}: the token is its own bearer"
            );
        }
    }
}
