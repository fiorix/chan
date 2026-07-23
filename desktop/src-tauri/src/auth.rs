//! id.chan.app sign-in flow + keychain-backed PAT storage, over a
//! loopback redirect with PKCE.
//!
//! Flow:
//!   1. The Workspaces window calls `open_signin` (or a gateway connect
//!      calls `open_gateway_signin`). We generate a random state nonce
//!      and a PKCE `code_verifier` (kept in-process), bind an ephemeral
//!      `http://127.0.0.1:<port>/auth/callback` listener in THIS
//!      process, and shell out to the user's default browser pointing at
//!      `/desktop/authorize?...&redirect_uri=http://127.0.0.1:<port>/auth/callback\
//!      &state=<nonce>&code_challenge=<challenge>&code_challenge_method=S256`.
//!   2. id.chan.app handles OAuth (passkeys, autofill, all native to the
//!      user's real browser), mints a PAT, stores it under a one-time
//!      redemption `code` bound to the S256 challenge, and serves a
//!      handoff page that navigates the browser back to the loopback
//!      callback (zero-delay meta refresh, manual fallback link) with the
//!      code in the URL QUERY (`?code=<code>&state=<nonce>`) -- never the
//!      PAT secret. A deny/error carries `?error=<reason>&state=<nonce>`.
//!   3. The callback is an ordinary HTTP GET that necessarily lands in
//!      the process that bound the listener (no OS scheme registration,
//!      no second-instance spawn). The listener validates the state nonce
//!      in constant time, answers a neutral page, then swaps
//!      `{code, code_verifier}` for the PAT (`POST
//!      /desktop/authorize/redeem` against the identity origin held in
//!      the slot -- never one named by the callback URL), persists the
//!      PAT to the OS keychain, and emits `auth-changed`. Errors emit
//!      `auth-error` with a string body.
//!
//! PKCE (RFC 7636, S256): the `code_verifier` is 32 CSPRNG bytes encoded
//! base64url-no-pad to a 43-char ASCII string; that STRING is the
//! verifier. `code_challenge = base64url_nopad(SHA256(verifier.as_bytes()))`
//! -- the hash is over the ASCII bytes of the 43-char verifier string,
//! matching the gateway. Only the challenge (a non-invertible hash) rides
//! the argv-visible browser leg; the verifier's sole appearance on any
//! wire is the redeem POST body, over TLS. This does NOT close the
//! login-CSRF residual a co-tenant who reads the argv-leaked challenge
//! can mount on a shared multi-user host; PKCE only raises the bar.
//! Single-user is the shipped scope.
//!
//! Query, not fragment: a local HTTP listener only ever receives the
//! query (a fragment never reaches a server). The code is single-use with
//! a short server-side TTL, dead after the first redeem, and never logged
//! (the listener has no request logging by construction).
//!
//! Keychain layout: service `chan-desktop`, account `id.chan.app`.
//! Value is JSON `{id, secret, label, expires_at}` so sign-out can
//! both clear locally and surface the token id for a future
//! server-side revoke pass.
//!
//! v1 sign-out is local-only: we drop the keychain entry. Server-
//! side revoke needs the id.chan.app session, which only the user's
//! browser has -- wiring that is a follow-up.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

/// Event emitted whenever the local sign-in state changes (after a
/// successful callback or a sign-out). The Workspaces window listens
/// and re-renders the toolbar button.
pub const AUTH_CHANGED: &str = "auth-changed";

/// Event emitted when the callback fails (state mismatch, missing
/// fields, id.chan.app returned `error=...`). Body is a human
/// string suitable for a banner.
pub const AUTH_ERROR: &str = "auth-error";

const KEYCHAIN_SERVICE: &str = "chan-desktop";
const KEYCHAIN_ACCOUNT: &str = "id.chan.app";
/// Origin serving `/desktop/authorize` for the hosted id.chan.app
/// flow; also what the loopback settle path redeems that flow's code
/// against.
const IDENTITY_ORIGIN: &str = "https://id.chan.app";
const AUTHORIZE_URL: &str = "https://id.chan.app/desktop/authorize";
/// Path the loopback listener answers and the `redirect_uri` names.
const LOOPBACK_CALLBACK_PATH: &str = "/auth/callback";
const SCOPES: &str = "tunnel";
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
/// the stamp-guarded expiry timer drops it. Set to the gateway row wait
/// so the slot never dies while the row still shows Connecting; the
/// callback path also treats an over-age slot as absent.
const SLOT_TTL: Duration = crate::GATEWAY_SIGNIN_TIMEOUT;

/// Concurrent in-flight callback handlers the listener will serve; a
/// flood beyond this drops the excess connection immediately.
const LISTENER_MAX_INFLIGHT: usize = 8;
/// Deadline for reading a connection's request head. A GET has no body,
/// so this bounds a slowloris to its own task. It deliberately does NOT
/// cover the redeem, which owns its own 15s budget (see `serve_callback`):
/// wrapping the whole handler would cancel a slow-network redeem after the
/// neutral 200 was already flushed, a silent sign-in failure.
const LISTENER_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Header read cap. The callback is a bare GET with a handful of
/// headers; anything larger is not our browser.
const LISTENER_HEADER_CAP: usize = 8 * 1024;

/// The single neutral page every callback answer carries, so a
/// state-probing attacker cannot distinguish match from mismatch by the
/// body.
const NEUTRAL_PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>chan</title></head><body>You can close this tab.</body></html>";

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

fn entry() -> Result<Entry, String> {
    entry_for(KEYCHAIN_ACCOUNT)
}

fn load() -> Result<Option<StoredPat>, String> {
    match entry()?.get_password() {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("decoding stored PAT: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("reading keychain: {e}")),
    }
}

fn store_for(account: &str, pat: &StoredPat) -> Result<(), String> {
    let json = serde_json::to_string(pat).map_err(|e| format!("encoding PAT: {e}"))?;
    entry_for(account)?
        .set_password(&json)
        .map_err(|e| format!("writing keychain: {e}"))
}

fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("clearing keychain: {e}")),
    }
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

/// In-flight authorization state. Set when a sign-in launches a browser
/// (and binds a loopback listener); consumed and cleared by the matching
/// loopback callback, the expiry timer, or a replacing sign-in. A second
/// sign-in while one is pending replaces it: the prior listener is
/// dropped (`replace_pending`), the prior browser tab is now stale, and
/// only the latest nonce passes the callback check.
struct PendingAuth {
    state: String,
    account: String,
    /// Origin that served the authorize page. The settle path redeems
    /// the callback's one-time code against this exact origin, never one
    /// named by the callback URL itself.
    identity_origin: String,
    resume_gateway_id: Option<String>,
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
            .field("resume_gateway_id", &self.resume_gateway_id)
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
/// a re-click never leaks a bound port. The sole guaranteeing site: both
/// entry points route their slot swap through here.
fn replace_pending(new: PendingAuth) {
    let mut slot = pending_state().lock().unwrap();
    if let Some(old) = slot.take() {
        let _ = old.shutdown.send(true);
    }
    *slot = Some(new);
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

/// The loopback `redirect_uri` the browser is sent back to. IPv4
/// `127.0.0.1` literal only (never `[::1]`): the browser connects to
/// `127.0.0.1`, so the listener is single-stack.
fn loopback_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}")
}

/// Bind the ephemeral loopback listener synchronously (the port is
/// needed immediately for the `redirect_uri`; commands are sync). Adopted
/// onto tokio inside the accept task, never here. Fail-closed: an `Err`
/// is propagated so the caller touches nothing else (F3).
fn bind_loopback_listener() -> Result<(std::net::TcpListener, u16), String> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("could not start the local sign-in listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the local sign-in listener address: {e}"))?
        .port();
    Ok((listener, port))
}

#[tauri::command]
pub fn auth_status() -> AuthStatus {
    match load() {
        Ok(Some(pat)) => AuthStatus {
            is_signed_in: true,
            label: Some(pat.label),
            expires_at: if pat.expires_at.is_empty() {
                None
            } else {
                Some(pat.expires_at)
            },
        },
        _ => AuthStatus {
            is_signed_in: false,
            label: None,
            expires_at: None,
        },
    }
}

/// Open id.chan.app/desktop/authorize in the user's default browser.
/// Short-circuits when already signed in.
#[tauri::command]
pub fn open_signin(app: AppHandle) -> Result<(), String> {
    if load().ok().flatten().is_some() {
        return Ok(());
    }
    launch_signin(
        &app,
        KEYCHAIN_ACCOUNT.to_string(),
        IDENTITY_ORIGIN.to_string(),
        None,
        AUTHORIZE_URL,
        SCOPES,
        bind_loopback_listener,
    )?;
    // Replacing the slot orphans any parked gateway sign-in (its browser
    // leg lost the nonce): settle those waits so no spinner or busy gate
    // outlives them. `abandon_pending_signins` is runtime-rows-only and
    // never touches the just-installed slot (see its doc).
    crate::gateway::abandon_pending_signins(&app, &app.state::<Arc<crate::AppState>>());
    Ok(())
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

pub fn load_gateway_pat(identity_origin: &str) -> Result<Option<StoredPat>, String> {
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
    let account = gateway_account(identity_origin);
    match entry_for(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("clearing gateway keychain: {e}")),
    }
}

pub fn open_gateway_signin<R: tauri::Runtime>(
    app: &AppHandle<R>,
    identity_origin: &str,
    authorize_url: &str,
    resume_id: &str,
) -> Result<(), String> {
    launch_signin(
        app,
        gateway_account(identity_origin),
        identity_origin.to_string(),
        Some(resume_id.to_string()),
        authorize_url,
        DESKTOP_ACCOUNT_SCOPES,
        bind_loopback_listener,
    )
}

/// The shared sign-in launch, generic over the runtime so both entry
/// points reuse it. Binds the loopback listener (`bind`, injectable for
/// the fail-closed test), builds the authorize URL, installs the slot,
/// spawns the accept-serve task and the expiry timer, then opens the
/// browser. Fail-closed ordering (F3): the bind precedes any slot swap or
/// browser open, so a failed bind leaves any prior sign-in untouched and
/// sets no half-built slot.
#[allow(clippy::too_many_arguments)]
fn launch_signin<R: tauri::Runtime>(
    app: &AppHandle<R>,
    account: String,
    identity_origin: String,
    resume_gateway_id: Option<String>,
    authorize_url: &str,
    scopes: &str,
    bind: impl FnOnce() -> Result<(std::net::TcpListener, u16), String>,
) -> Result<(), String> {
    let state_nonce = new_state()?;
    let verifier = new_verifier()?;
    let challenge = challenge_for(&verifier);
    // F3: bind first; on failure return before touching the slot, the
    // browser, or anything else.
    let (listener, port) = bind()?;

    // Build the authorize URL now (needs the port); a parse failure
    // returns before the slot swap, dropping the freshly-bound listener.
    let label = format!("chan-desktop @ {}", hostname());
    let url = url::Url::parse_with_params(
        authorize_url,
        &[
            ("redirect_uri", loopback_redirect_uri(port)),
            ("state", state_nonce.clone()),
            ("label", label),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256".to_string()),
            ("scopes", scopes.to_string()),
            ("expires_in", EXPIRES_IN_SECONDS.to_string()),
        ],
    )
    .map_err(|e| format!("building authorize URL: {e}"))?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let pending = PendingAuth {
        state: state_nonce,
        account,
        identity_origin,
        resume_gateway_id,
        code_verifier: verifier,
        created_at: Instant::now(),
        shutdown: shutdown_tx.clone(),
        port,
    };
    let created_at = pending.created_at;
    replace_pending(pending);

    // Serve the loopback callback. Adopt the std listener onto tokio
    // INSIDE the task (needs a reactor).
    let app_for_accept = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "adopting the sign-in listener failed");
                return;
            }
        };
        accept_serve(listener, shutdown_rx, move |stream| {
            serve_callback(app_for_accept.clone(), stream, port)
        })
        .await;
    });
    // Drop the abandoned listener + slot at the TTL if no callback ever
    // arrives (a bound-port leak otherwise). Stamp-guarded on created_at.
    spawn_slot_expiry(created_at, shutdown_tx);

    if let Err(e) = app.opener().open_url(url.to_string(), None::<&str>) {
        // No browser leg will arrive: drop the listener and clear the slot
        // so no bound port or live nonce lingers. Stamp-guarded on
        // created_at (like spawn_slot_expiry) so a concurrent re-click's
        // fresh slot is never nuked by this arm.
        let mut slot = pending_state().lock().unwrap();
        if slot.as_ref().map(|p| p.created_at) == Some(created_at) {
            if let Some(p) = slot.take() {
                let _ = p.shutdown.send(true);
            }
        }
        return Err(format!("opening browser: {e}"));
    }
    Ok(())
}

/// Stamp-guarded slot expiry: after [`SLOT_TTL`], drop the listener and
/// clear the slot IF it is still the same one (created_at match), so a
/// re-click's fresh slot survives an old timer.
fn spawn_slot_expiry(created_at: Instant, shutdown: watch::Sender<bool>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SLOT_TTL).await;
        let mut slot = pending_state().lock().unwrap();
        if slot.as_ref().map(|p| p.created_at) == Some(created_at) {
            slot.take();
            let _ = shutdown.send(true);
        }
    });
}

/// The accept loop: `select!` accept vs the shutdown signal, each
/// connection handled in its OWN sub-task so a slow/hung connection never
/// blocks the next accept (F2). A semaphore bounds concurrent handlers;
/// over-cap connections drop. Generic over the per-connection handler so
/// the accept discipline is drivable in tests without the Tauri GUI.
async fn accept_serve<F, Fut>(
    listener: tokio::net::TcpListener,
    mut shutdown_rx: watch::Receiver<bool>,
    handle: F,
) where
    F: Fn(tokio::net::TcpStream) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let sem = Arc::new(tokio::sync::Semaphore::new(LISTENER_MAX_INFLIGHT));
    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let stream = match accepted {
                    Ok((stream, _)) => stream,
                    Err(_) => continue,
                };
                let Ok(permit) = Arc::clone(&sem).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let handle = handle.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    // The per-connection deadline lives inside the handler
                    // (around the header read only), so the redeem keeps its
                    // own budget; the accept loop just spawns and bounds.
                    handle(stream).await;
                });
            }
        }
    }
}

/// Serve one loopback callback connection: read the request head, apply
/// the route rules, answer the neutral page, and (on a matching state)
/// settle the sign-in. NEVER logs the request line or query (it carries
/// the one-time code).
async fn serve_callback<R: tauri::Runtime>(
    app: AppHandle<R>,
    mut stream: tokio::net::TcpStream,
    port: u16,
) {
    // Time-box ONLY the header read (the slowloris surface). write_neutral
    // and settle -- which awaits redeem_inner's own 15s budget -- run
    // outside this deadline, so a slow network cannot cancel a redeem after
    // the neutral 200 has already been flushed.
    let head =
        match tokio::time::timeout(LISTENER_READ_TIMEOUT, read_request_head(&mut stream)).await {
            Ok(Some(h)) => h,
            // Timed out on a slow header send, oversized, or closed before the
            // headers completed: drop without a response.
            _ => return,
        };
    match classify_request(&head, port) {
        RequestDecision::BadRequest => {
            let _ = write_neutral(&mut stream, "400 Bad Request").await;
        }
        RequestDecision::Callback(query) => {
            let action = {
                let mut pending = pending_state().lock().unwrap();
                classify_callback(&query, &mut pending)
            };
            // Answer the neutral 200 FIRST (before any redeem, so the 15s
            // redeem never sits inside the request/response), identically
            // for match and mismatch.
            let _ = write_neutral(&mut stream, "200 OK").await;
            let _ = stream.shutdown().await;
            drop(stream);
            settle(app, action).await;
        }
    }
}

/// Read the HTTP request head (up to the `\r\n\r\n` terminator) with an
/// 8 KiB cap. A GET has no body, so the head is the whole request.
async fn read_request_head(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            return Some(String::from_utf8_lossy(&buf[..pos]).into_owned());
        }
        if buf.len() > LISTENER_HEADER_CAP {
            return None;
        }
    }
}

/// The neutral response, verbatim. `no-store` / `no-referrer`; NO
/// `Access-Control-Allow-*` (CORS stops nothing here: the legitimate
/// callback is a top-level navigation not subject to CORS, and the
/// attacker never reads the response).
fn neutral_response(status_line: &str) -> String {
    format!(
        "HTTP/1.1 {status_line}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Referrer-Policy: no-referrer\r\n\
         Cache-Control: no-store\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{NEUTRAL_PAGE}",
        NEUTRAL_PAGE.len()
    )
}

async fn write_neutral(
    stream: &mut tokio::net::TcpStream,
    status_line: &str,
) -> std::io::Result<()> {
    let resp = neutral_response(status_line);
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await
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
        resume_gateway_id: Option<String>,
        /// The taken slot's listener shutdown, fired once this callback
        /// owns the flow.
        shutdown: watch::Sender<bool>,
    },
    /// Emit AUTH_ERROR and settle parked waits (a matching-state error or
    /// a matching-state callback missing its code).
    Fail {
        message: String,
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
                resume_gateway_id,
                ..
            } => f
                .debug_struct("Redeem")
                .field("code", code)
                .field("code_verifier", &"<redacted>")
                .field("identity_origin", identity_origin)
                .field("account", account)
                .field("resume_gateway_id", resume_gateway_id)
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
            shutdown: expected.shutdown,
        };
    }
    let code = params.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        return CallbackAction::Fail {
            message: "callback missing redemption code".to_string(),
            shutdown: expected.shutdown,
        };
    }
    CallbackAction::Redeem {
        code,
        code_verifier: expected.code_verifier,
        identity_origin: expected.identity_origin,
        account: expected.account,
        resume_gateway_id: expected.resume_gateway_id,
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
/// emit the error + settle parked waits. Fires the slot's listener
/// shutdown first so the accept loop stops.
async fn settle<R: tauri::Runtime>(app: AppHandle<R>, action: CallbackAction) {
    match action {
        CallbackAction::Redeem {
            code,
            code_verifier,
            identity_origin,
            account,
            resume_gateway_id,
            shutdown,
        } => {
            let _ = shutdown.send(true);
            let state = Arc::clone(&app.state::<Arc<crate::AppState>>());
            let redeemed = match redeem_inner(&identity_origin, &code, &code_verifier).await {
                Ok(r) => r,
                Err(e) => {
                    let _ = app.emit(AUTH_ERROR, &e);
                    crate::gateway::abandon_pending_signins(&app, &state);
                    return;
                }
            };
            let pat = StoredPat {
                id: redeemed.id,
                secret: redeemed.secret,
                label: redeemed.label,
                expires_at: redeemed.expires_at.unwrap_or_default(),
            };
            if let Err(e) = store_for(&account, &pat) {
                let _ = app.emit(AUTH_ERROR, &e);
                crate::gateway::abandon_pending_signins(&app, &state);
                return;
            }
            let status = AuthStatus {
                is_signed_in: true,
                label: Some(pat.label),
                expires_at: if pat.expires_at.is_empty() {
                    None
                } else {
                    Some(pat.expires_at)
                },
            };
            let _ = app.emit(AUTH_CHANGED, &status);
            if let Some(id) = resume_gateway_id {
                crate::gateway::resume_gateway_signin(app, state, id).await;
            }
        }
        CallbackAction::Fail { message, shutdown } => {
            let _ = shutdown.send(true);
            let _ = app.emit(AUTH_ERROR, &message);
            let state = Arc::clone(&app.state::<Arc<crate::AppState>>());
            crate::gateway::abandon_pending_signins(&app, &state);
        }
        CallbackAction::Ignore => {}
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
}

/// Swap the one-time code plus the PKCE verifier for the PAT at the
/// identity origin that issued it. Runs on the listener's tokio task
/// (the accept-serve path is already async), so no dedicated thread or
/// nested runtime is needed.
async fn redeem_inner(
    identity_origin: &str,
    code: &str,
    code_verifier: &str,
) -> Result<RedeemedPat, String> {
    let url = format!(
        "{}/desktop/authorize/redeem",
        identity_origin.trim_end_matches('/')
    );
    let body = serde_json::json!({ "code": code, "code_verifier": code_verifier });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REDEEM_TIMEOUT_SECS))
        .build()
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
            "the sign-in link expired or was already used; try signing in again".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!(
            "redeeming sign-in code: the gateway answered HTTP {status}"
        ));
    }
    resp.json::<RedeemedPat>()
        .await
        .map_err(|e| format!("decoding redeemed token: {e}"))
}

/// Map an id.chan.app `error=` reason token to the banner string. The
/// tokens are the gateway's stable desktop-authorize vocabulary; the human
/// strings live here on the desktop so gateway deploys never reword the UI.
fn signin_error_message(reason: &str) -> String {
    match reason {
        "user_cancelled" => "sign-in was cancelled in the browser".to_string(),
        "oauth_denied" => "sign-in was denied by the identity provider".to_string(),
        "account_blocked" => "sign-in failed: this account is blocked".to_string(),
        "mint_failed" => "sign-in failed: the gateway could not issue an access token".to_string(),
        other => format!("sign-in failed in the browser: {other}"),
    }
}

/// The structural verdict for a loopback request, before the state
/// compare. Extracted (pure) so the route rules are unit-testable.
#[derive(Debug, PartialEq, Eq)]
enum RequestDecision {
    /// A route-rule violation (method/path/Host/Sec-Fetch-Dest): 400.
    BadRequest,
    /// A valid callback: the (possibly empty) query string, to be
    /// classified against the slot.
    Callback(String),
}

/// Apply the route rules in order (6.4), before any slot access:
///   1. method GET + path exactly `/auth/callback`, else 400.
///   2. `Host` is `127.0.0.1:<port>` or `[::1]:<port>`, else 400
///      (missing Host -> 400).
///   3. `Sec-Fetch-Dest` present and != `document` -> 400 (absent
///      allowed: old browsers, and a web attacker cannot both omit it
///      and know the secrets).
fn classify_request(head: &str, port: u16) -> RequestDecision {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        return RequestDecision::BadRequest;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != LOOPBACK_CALLBACK_PATH {
        return RequestDecision::BadRequest;
    }

    let mut host: Option<String> = None;
    let mut sec_fetch_dest: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "host" => host = Some(value.trim().to_string()),
                "sec-fetch-dest" => sec_fetch_dest = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }

    let expected_v4 = format!("127.0.0.1:{port}");
    let expected_v6 = format!("[::1]:{port}");
    match host.as_deref() {
        Some(h) if h == expected_v4 || h == expected_v6 => {}
        _ => return RequestDecision::BadRequest,
    }
    if let Some(dest) = sec_fetch_dest {
        if dest != "document" {
            return RequestDecision::BadRequest;
        }
    }

    RequestDecision::Callback(query.to_string())
}

/// Local sign-out. Clears the keychain entry. Server-side revoke is
/// a follow-up -- it needs the id.chan.app session which only the
/// user's browser has access to.
#[tauri::command]
pub fn signout(app: AppHandle) -> Result<AuthStatus, String> {
    clear()?;
    let status = AuthStatus {
        is_signed_in: false,
        label: None,
        expires_at: None,
    };
    let _ = app.emit(AUTH_CHANGED, &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
            signin_error_message("quota_exceeded"),
            "sign-in failed in the browser: quota_exceeded"
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

    #[test]
    fn loopback_redirect_uri_shape() {
        assert_eq!(
            loopback_redirect_uri(54321),
            "http://127.0.0.1:54321/auth/callback"
        );
    }

    // --- classify_callback: the loopback state machine ---

    fn pending(state: &str) -> Option<PendingAuth> {
        let (shutdown, _rx) = watch::channel(false);
        Some(PendingAuth {
            state: state.to_string(),
            account: "id.chan.app".to_string(),
            identity_origin: "https://id.example".to_string(),
            resume_gateway_id: Some("gw-1".to_string()),
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
                resume_gateway_id,
                ..
            } => {
                assert_eq!(code, "one-time-abc", "code comes from the query");
                assert_eq!(
                    code_verifier, "verifier-abc",
                    "verifier comes from the slot"
                );
                assert_eq!(identity_origin, "https://id.example");
                assert_eq!(account, "id.chan.app");
                assert_eq!(resume_gateway_id.as_deref(), Some("gw-1"));
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

    fn head(request_line: &str, extra_headers: &[&str]) -> String {
        let mut s = String::from(request_line);
        s.push_str("\r\nHost: 127.0.0.1:45678");
        for h in extra_headers {
            s.push_str("\r\n");
            s.push_str(h);
        }
        s
    }

    #[test]
    fn classify_request_accepts_a_valid_callback() {
        let raw = head("GET /auth/callback?code=c1&state=s1 HTTP/1.1", &[]);
        assert_eq!(
            classify_request(&raw, PORT),
            RequestDecision::Callback("code=c1&state=s1".to_string())
        );
    }

    #[test]
    fn classify_request_accepts_ipv6_host_form() {
        let raw = "GET /auth/callback?code=c1 HTTP/1.1\r\nHost: [::1]:45678";
        assert!(matches!(
            classify_request(raw, PORT),
            RequestDecision::Callback(_)
        ));
    }

    #[test]
    fn classify_request_rejects_wrong_method() {
        let raw = head("POST /auth/callback HTTP/1.1", &[]);
        assert_eq!(classify_request(&raw, PORT), RequestDecision::BadRequest);
    }

    #[test]
    fn classify_request_rejects_wrong_path() {
        let raw = head("GET /nope HTTP/1.1", &[]);
        assert_eq!(classify_request(&raw, PORT), RequestDecision::BadRequest);
        // Not a prefix match either.
        let raw = head("GET /auth/callback/x HTTP/1.1", &[]);
        assert_eq!(classify_request(&raw, PORT), RequestDecision::BadRequest);
    }

    #[test]
    fn classify_request_rejects_missing_host() {
        let raw = "GET /auth/callback HTTP/1.1\r\nAccept: */*";
        assert_eq!(classify_request(raw, PORT), RequestDecision::BadRequest);
    }

    #[test]
    fn classify_request_rejects_wrong_host_port() {
        let raw = "GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1:1";
        assert_eq!(classify_request(raw, PORT), RequestDecision::BadRequest);
        // A non-loopback host is rejected even on the right port.
        let raw = "GET /auth/callback HTTP/1.1\r\nHost: evil.example:45678";
        assert_eq!(classify_request(raw, PORT), RequestDecision::BadRequest);
    }

    #[test]
    fn classify_request_rejects_non_document_sec_fetch_dest() {
        let raw = head("GET /auth/callback HTTP/1.1", &["Sec-Fetch-Dest: image"]);
        assert_eq!(classify_request(&raw, PORT), RequestDecision::BadRequest);
        // Absent is allowed; document is allowed.
        let raw = head("GET /auth/callback HTTP/1.1", &["Sec-Fetch-Dest: document"]);
        assert!(matches!(
            classify_request(&raw, PORT),
            RequestDecision::Callback(_)
        ));
    }

    #[test]
    fn neutral_response_has_the_privacy_headers_and_no_cors() {
        let resp = neutral_response("200 OK");
        assert!(resp.contains("Content-Type: text/html; charset=utf-8"));
        assert!(resp.contains("Referrer-Policy: no-referrer"));
        assert!(resp.contains("Cache-Control: no-store"));
        assert!(resp.contains("You can close this tab."));
        assert!(
            !resp.to_ascii_lowercase().contains("access-control-allow"),
            "the neutral page must carry no ACAO header"
        );
    }

    // --- F2: a slow connection does not block the next accept ---

    #[tokio::test]
    async fn accept_serve_does_not_wedge_on_a_slow_connection() {
        use tokio::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let counter = Arc::new(AtomicUsize::new(0));
        let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = {
            let counter = Arc::clone(&counter);
            move |mut stream: TcpStream| {
                let counter = Arc::clone(&counter);
                let done_tx = done_tx.clone();
                async move {
                    let n = counter.fetch_add(1, Ordering::SeqCst);
                    if n == 0 {
                        // First connection wedges (slowloris).
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    } else {
                        // A later connection must still be accepted+served.
                        let _ = done_tx.send(());
                    }
                    let mut buf = [0u8; 8];
                    let _ = stream.read(&mut buf).await;
                }
            }
        };
        let server = tokio::spawn(accept_serve(listener, shutdown_rx, handle));

        // First (slow) connection, then a second. The second must be
        // served well before the first's 5s sleep elapses.
        let _slow = TcpStream::connect(addr).await.unwrap();
        let _fast = TcpStream::connect(addr).await.unwrap();
        let served = tokio::time::timeout(Duration::from_secs(1), done_rx.recv()).await;
        assert!(
            served.is_ok() && served.unwrap().is_some(),
            "the second connection was accepted while the first was still hung"
        );

        let _ = shutdown_tx.send(true);
        let _ = server.await;
    }

    // --- F3: a bind failure returns Err and installs no slot ---

    #[test]
    fn bind_failure_returns_err_and_sets_no_slot() {
        // No unit test ever installs the process-global slot (the success
        // flow opens a browser), so it is None here; a failed bind must
        // leave it None and return the error before any slot swap.
        let app = tauri::test::mock_app();
        assert!(pending_state().lock().unwrap().is_none());
        let result = launch_signin(
            app.handle(),
            "acct".to_string(),
            "https://id.example".to_string(),
            None,
            "https://id.example/desktop/authorize",
            SCOPES,
            || Err("boom: EMFILE".to_string()),
        );
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("boom"),
            "propagates the bind error"
        );
        assert!(
            pending_state().lock().unwrap().is_none(),
            "no slot is installed when the bind fails"
        );
    }

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
        assert!(err.contains("expired or was already used"), "{err}");
    }

    #[tokio::test]
    async fn redeem_inner_surfaces_other_http_failures() {
        let (origin, _stub) = stub_identity("500 Internal Server Error", "{}");
        let err = redeem_inner(&origin, "c1", "v")
            .await
            .expect_err("500 is an error");
        assert!(err.contains("HTTP 500"), "{err}");
    }
}
