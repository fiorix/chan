//! Gateway devserver client for the mobile leg: discovery, the entry
//! exchange that mints the exact-origin session, and the tenant
//! navigation URL, over the shared TLS trust decision.
//!
//! A rostered devserver is reached through its gateway's proxy origin.
//! The app assembles each tenant's navigation from the validated
//! `/mobile/v1/devserver/entry` exchange: the entry credential is
//! exchanged by body, never stamped into a URL, and the resulting opaque
//! session is installed into the WebView cookie store before navigation.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The TLS client builder every gateway HTTP call shares: chan-tls's
/// trust decision with HTTP/1.1 ALPN and the process-wide routing decision.
pub(crate) fn tls_client_builder() -> Result<reqwest::ClientBuilder, String> {
    let tls = chan_tls::client_config().map_err(|e| e.to_string())?;
    crate::wireguard::client_builder(
        reqwest::Client::builder().use_preconfigured_tls(http1_tls(tls)),
    )
}

/// `config` with HTTP/1.1 ALPN alone, as the desktop's HTTP clients
/// offer (reqwest uses a preconfigured config as it is, ALPN included).
fn http1_tls(mut config: chan_tls::rustls::ClientConfig) -> chan_tls::rustls::ClientConfig {
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

/// Per-request cap so an unreachable devserver cannot hang the launcher's
/// workspace poll, matching `probe_url`'s connect timeout.
const HTTP_TIMEOUT_SECS: u64 = 5;

/// Older proxies may omit cookie lifetime attributes. Refresh those sessions
/// conservatively instead of caching them until the process exits.
const GATE_SESSION_FALLBACK_TTL_SECS: u64 = 5 * 60;

/// Stop reusing a native session shortly before the browser/proxy considers it
/// expired, avoiding a clean navigation that immediately lands unauthenticated.
const GATE_SESSION_EXPIRY_SAFETY_SECS: u64 = 30;

/// Live connection to one devserver, keyed by the desktop-local
/// `Devserver.id` in [`DevserverConns`]. Connection state is held in memory
/// only: the bearer token rotates with the devserver, so a persisted copy
/// would decay between launches (the same reason local serve URLs live in
/// memory rather than `config.json`).
#[derive(Clone)]
pub struct DevserverConn {
    /// Tunnel endpoint host the desktop dials, e.g. `127.0.0.1` for an
    /// `ssh -L` forward.
    pub host: String,
    /// Tunnel endpoint port the desktop dials.
    pub port: u16,
    /// Devserver-level bearer token, distinct from the per-tenant tokens.
    /// Sent as `Authorization: Bearer <token>` on every endpoint except the
    /// unauthenticated info probe.
    pub token: String,
    /// Human display name for window titles (the server's `host_label`, else the
    /// dialed host). Resolved once at connect and carried on the conn so a
    /// reconnect (which clones the conn) reuses it without re-probing.
    pub name: String,
    /// Gateway-only entry/session metadata is substantially larger than the
    /// ordinary loopback connection. Keep it behind one pointer so connection
    /// values remain cheap to move through the watcher operation enum.
    pub gateway: Option<Box<GatewayConn>>,
}

impl std::fmt::Debug for DevserverConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevserverConn")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("token", &"[REDACTED]")
            .field("name", &self.name)
            .field("gateway", &self.gateway)
            .finish()
    }
}

#[derive(Clone)]
pub struct GatewayConn {
    pub(crate) access: Option<crate::wireguard::AccessGuard>,
    pub identity_origin: String,
    pub mobile_entry_url: String,
    /// Discovery-advertised proxy namespace apex. Entry responses must name one
    /// exact child label beneath this origin with the same scheme/effective port.
    proxy_apex_origin: String,
    /// Canonical exact origin pinned by the first validated entry response.
    pub proxy_origin: String,
    pub pat: String,
    /// Explicit devserver target (immutable owner id plus routing/display
    /// username and devserver id), a
    /// roster row's key), included in every entry request so the gateway
    /// mints for this exact devserver (own or shared). `None` = the
    /// gateway's first-accessible-live fallback.
    pub entry_target: Option<GatewayEntryTarget>,
    session: Arc<Mutex<Option<GatewaySession>>>,
    /// Serializes entry mint/exchange. The sync mutex above only protects the
    /// cached value and is never held over network I/O.
    session_refresh: Arc<tokio::sync::Mutex<()>>,
    /// Publishes each newly exchanged session into the process-wide WebView
    /// cookie store. Installed once the connection reaches the Tauri-owned
    /// connect path; tests install a recorder instead. Keeping the publisher
    /// on the connection makes every re-mint share one propagation chokepoint.
    session_installer: Arc<Mutex<Option<Arc<GatewaySessionInstaller>>>>,
}

impl std::fmt::Debug for GatewayConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayConn")
            .field("identity_origin", &self.identity_origin)
            .field("mobile_entry_url", &self.mobile_entry_url)
            .field("proxy_apex_origin", &self.proxy_apex_origin)
            .field("proxy_origin", &self.proxy_origin)
            .field("pat", &"[REDACTED]")
            .field("entry_target", &self.entry_target)
            .field("session", &self.session)
            .finish()
    }
}

impl GatewayConn {
    pub(crate) fn begin_operation(&self) -> Result<Option<u64>, String> {
        self.require_access()?;
        self.access
            .as_ref()
            .map(crate::wireguard::AccessGuard::epoch)
            .transpose()
    }

    pub(crate) fn require_operation(&self, epoch: Option<u64>) -> Result<(), String> {
        match (&self.access, epoch) {
            (Some(access), Some(epoch)) => access.check_epoch(&self.proxy_origin, epoch),
            (Some(_), None) => Err("WireGuard: request has no operation epoch".into()),
            (None, _) => Ok(()),
        }
    }

    pub(crate) fn require_access(&self) -> Result<(), String> {
        match &self.access {
            Some(access) => access.check(&self.proxy_origin),
            None => Ok(()),
        }
    }

    #[cfg(test)]
    pub fn new(
        identity_origin: String,
        mobile_entry_url: String,
        proxy_origin: String,
        pat: String,
    ) -> Self {
        Self {
            access: None,
            identity_origin,
            mobile_entry_url,
            proxy_apex_origin: proxy_origin.clone(),
            proxy_origin,
            pat,
            entry_target: None,
            session: Arc::new(Mutex::new(None)),
            session_refresh: Arc::new(tokio::sync::Mutex::new(())),
            session_installer: Arc::new(Mutex::new(None)),
        }
    }

    /// Attach an explicit devserver target to every entry mint.
    #[cfg(test)]
    pub fn with_entry_target(mut self, target: Option<GatewayEntryTarget>) -> Self {
        self.entry_target = target;
        self
    }

    #[cfg(test)]
    pub(crate) fn seed_fresh_session_for_test(&self, csrf: &str) {
        *self.session.lock().unwrap() = Some(GatewaySession {
            gate: "test-gate".into(),
            cookie_header: format!("__Host-devserver_gate=test-gate; __Host-devserver_csrf={csrf}"),
            csrf: csrf.into(),
            expires_at: Instant::now() + Duration::from_secs(120),
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayEntryTarget {
    pub owner_user_id: uuid::Uuid,
    pub owner: String,
    pub devserver_id: String,
}

#[derive(Clone)]
struct GatewaySession {
    gate: String,
    cookie_header: String,
    csrf: String,
    expires_at: Instant,
}

type GatewaySessionInstaller =
    dyn Fn(&str, &GatewaySession) -> Result<(), String> + Send + Sync + 'static;

impl GatewaySession {
    fn is_fresh(&self) -> bool {
        Instant::now() < self.expires_at
    }

    /// Time left before this session should be re-minted. `expires_at` already
    /// carries [`GATE_SESSION_EXPIRY_SAFETY_SECS`], so reaching it still leaves
    /// a live window in which the replacement mint can complete.
    #[cfg(test)]
    fn refresh_due_in(&self) -> Duration {
        self.expires_at.saturating_duration_since(Instant::now())
    }
}

impl std::fmt::Debug for GatewaySession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewaySession")
            .field("gate", &"[REDACTED]")
            .field("cookie_header", &"[REDACTED]")
            .field("csrf", &"[REDACTED]")
            .finish()
    }
}

/// In-memory map of connected devservers keyed by `Devserver.id`. A
/// devserver absent from the map is disconnected: its `[DEVSERVER]` section
/// shows the disconnected placeholder rather than live workspace rows.
///
/// Every entry carries the `Instant` it was registered, stamped inside `set`
/// (the single chokepoint every registration site goes through) and read via
/// `registered_elapsed` in tests. A re-`set` (token rotation) re-stamps it.
#[derive(Default)]
pub struct DevserverConns {
    inner: Mutex<HashMap<String, (DevserverConn, Instant)>>,
}

impl DevserverConns {
    pub fn get(&self, id: &str) -> Option<DevserverConn> {
        self.inner
            .lock()
            .unwrap()
            .get(id)
            .map(|(conn, _)| conn.clone())
    }

    /// Find the live gateway-backed connection pinned to `exact_origin`.
    pub fn gateway_conn_for_origin(&self, exact_origin: &str) -> Option<DevserverConn> {
        self.inner.lock().unwrap().values().find_map(|(conn, _)| {
            conn.gateway
                .as_ref()
                .is_some_and(|gw| gw.proxy_origin == exact_origin)
                .then(|| conn.clone())
        })
    }

    /// Whether `id` is currently registered with the exact gateway connection
    /// instance `conn` (distinguishing an active connection from a disconnect or
    /// replacement connect).
    pub(crate) fn is_same_gateway_conn(&self, id: &str, conn: &DevserverConn) -> bool {
        let Some(expected) = conn.gateway.as_ref() else {
            return false;
        };
        self.inner
            .lock()
            .unwrap()
            .get(id)
            .and_then(|(current, _)| current.gateway.as_ref())
            .is_some_and(|current| Arc::ptr_eq(&current.session, &expected.session))
    }

    pub fn set(&self, id: String, conn: DevserverConn) {
        self.inner
            .lock()
            .unwrap()
            .insert(id, (conn, Instant::now()));
    }

    pub fn remove(&self, id: &str) -> Option<DevserverConn> {
        self.inner.lock().unwrap().remove(id).map(|(conn, _)| conn)
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.inner.lock().unwrap().contains_key(id)
    }

    /// How long ago this devserver's connection was registered (its latest
    /// `set` stamp), or `None` when it is not connected.
    #[cfg(test)]
    pub fn registered_elapsed(&self, id: &str) -> Option<Duration> {
        self.inner
            .lock()
            .unwrap()
            .get(id)
            .map(|(_, registered)| registered.elapsed())
    }
}

/// Wire entry from `GET /api/devserver/workspaces`, which [`fetch_workspaces`]
/// turns into a launcher row plus an assembled tenant URL.
#[derive(Clone, Deserialize)]
struct WorkspaceEntry {
    prefix: String,
    path: String,
    label: String,
    on: bool,
    #[serde(default)]
    status: chan_server::WorkspaceStatus,
    #[serde(default)]
    error: Option<String>,
    token: String,
}

impl std::fmt::Debug for WorkspaceEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceEntry")
            .field("prefix", &self.prefix)
            .field("path", &self.path)
            .field("label", &self.label)
            .field("on", &self.on)
            .field("status", &self.status)
            .field("error", &self.error)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

/// `POST /api/devserver/workspaces/{prefix}/on` body, mirroring the server's
/// `SetWorkspaceOnRequest`. `on:false` keeps the workspace registered
/// (unmount-but-remember), distinct from `DELETE` = Forget. `force` overrides
/// the server's off-with-live-terminals guard.
#[derive(Debug, Serialize)]
struct SetWorkspaceOnRequest {
    on: bool,
    force: bool,
}

/// The discriminator a live-terminals refusal carries in its `error` field.
const LIVE_TERMINALS: &str = "live_terminals";

/// Why a devserver workspace on/off/forget failed, structured so a caller can
/// tell a confirm-before-off (live terminals, offer to force) from a refusal
/// the devserver explained, and both from everything else.
#[derive(Debug)]
pub enum SetWorkspaceOnError {
    /// An unforced off or forget was rejected: `active_terminals` live
    /// terminals would be killed. The caller confirms, then retries with
    /// `force: true`.
    ActiveTerminals { active_terminals: usize },
    /// A 409: the devserver declined the request and said why.
    Refused { message: String },
    /// Any other failure (network, decode, any non-409 status), as a plain
    /// message.
    Other { message: String },
}

/// Longest peer refusal message kept, in characters.
const MAX_REFUSAL_MESSAGE_CHARS: usize = 200;

/// A character that changes what a surface DOES rather than what it says, so
/// a peer may not put one in front of a reader: the ASCII and C1 controls,
/// where an escape sequence lives; the line and paragraph separators, which
/// end a line in a surface promised one string; the bidirectional controls,
/// which reorder what is displayed without changing what the string contains;
/// and the zero-width characters, which hide text outright.
///
/// Deliberately absent: the zero-width joiners, the variation selectors and
/// the tag characters. Those carry meaning inside ordinary text, an emoji
/// family or flag sequence among them, and editing them out of a legitimate
/// message would damage what it says. That they cannot
/// render alone is [`is_invisible`]'s business, which answers a different
/// question.
fn is_unshowable(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{00ad}'                  // soft hyphen
            | '\u{061c}'                // arabic letter mark
            | '\u{180e}'                // mongolian vowel separator
            | '\u{200b}'                // zero width space
            | '\u{200e}' | '\u{200f}'   // LRM, RLM
            | '\u{2028}'                // line separator
            | '\u{2029}'                // paragraph separator
            | '\u{202a}'..='\u{202e}'   // bidi embeddings and overrides
            | '\u{2066}'..='\u{2069}'   // bidi isolates
            | '\u{feff}'                // zero width no-break space
        )
}

/// A character that renders nothing on its own. A string of only these is not
/// empty, so without this it would reach a banner as a blank, and a
/// discriminator with one appended would not compare equal to itself.
///
/// Broader than [`is_unshowable`] because the question is different: not
/// whether a reader may be shown this, but whether there is anything to see.
/// It adds the selectors and tags that the editing pass deliberately keeps.
fn is_invisible(c: char) -> bool {
    is_unshowable(c)
        || matches!(c,
            '\u{200c}' | '\u{200d}'     // zero width non-joiner, joiner
            | '\u{2060}'..='\u{2064}'   // word joiner, invisible operators
            | '\u{fe00}'..='\u{fe0f}'   // variation selectors
            | '\u{e0000}'..='\u{e007f}' // tags
            | '\u{e0100}'..='\u{e01ef}' // variation selectors supplement
        )
}

/// Whether `text` holds anything a reader could actually see.
fn has_visible_content(text: &str) -> bool {
    text.chars().any(|c| !c.is_whitespace() && !is_invisible(c))
}

/// Whether `message` says only the live-terminals discriminator, whatever
/// invisible characters surround it.
fn is_bare_discriminator(message: &str) -> bool {
    message
        .chars()
        .filter(|c| !is_invisible(*c) && !c.is_whitespace())
        .eq(LIVE_TERMINALS.chars())
}

/// Make a peer's own words fit to show. Anything [`is_unshowable`] names
/// becomes a space, runs of whitespace collapse to one, and the result is cut
/// to [`MAX_REFUSAL_MESSAGE_CHARS`] on a character boundary.
///
/// The collapse is what keeps the cap useful: a body of two hundred control
/// characters followed by a sentence would otherwise spend the whole budget on
/// substituted spaces and discard the reason. Ordinary text, including
/// non-ASCII, is left as it is.
fn peer_message(raw: &str) -> String {
    let mut out = String::new();
    let mut kept = 0usize;
    let mut pending_space = false;
    for raw_char in raw.chars() {
        let c = if is_unshowable(raw_char) {
            ' '
        } else {
            raw_char
        };
        if c.is_whitespace() {
            pending_space = kept > 0;
            continue;
        }
        if pending_space {
            if kept == MAX_REFUSAL_MESSAGE_CHARS {
                break;
            }
            out.push(' ');
            kept += 1;
            pending_space = false;
        }
        if kept == MAX_REFUSAL_MESSAGE_CHARS {
            break;
        }
        out.push(c);
        kept += 1;
    }
    out
}

/// Keep each caller's non-envelope fallback while displaying a peer's sentence
/// through the same bounded, inert text normalization as conflict refusals.
pub(crate) fn refusal_message(status: reqwest::StatusCode, body: &str, fallback: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.as_object()?.get("error")?.as_str().map(peer_message))
        .filter(|message| has_visible_content(message))
        .map(|message| format!("HTTP {status}: {message}"))
        .unwrap_or_else(|| fallback.to_string())
}

/// Read a `409 Conflict` by its body rather than by its status: a numeric
/// `active_terminals` surfaces the confirm-before-off outcome, a non-empty
/// string `error` surfaces the peer's normalized refusal, and anything else
/// falls back to the body or HTTP status.
async fn refusal_from_conflict(resp: reqwest::Response) -> SetWorkspaceOnError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
    let error = parsed
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(serde_json::Value::as_str);
    let count = parsed
        .as_ref()
        .and_then(|value| value.get("active_terminals"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|count| usize::try_from(count).ok());
    if let Some(active_terminals) = count {
        return SetWorkspaceOnError::ActiveTerminals { active_terminals };
    }
    let reason = error
        .map(peer_message)
        .filter(|message| has_visible_content(message) && !is_bare_discriminator(message))
        .unwrap_or_else(|| {
            let body = peer_message(&body);
            if !has_visible_content(&body) || error.is_some() {
                format!("devserver refused with HTTP {status}")
            } else {
                body
            }
        });
    SetWorkspaceOnError::Refused { message: reason }
}

impl SetWorkspaceOnError {
    pub fn other(msg: impl std::fmt::Display) -> Self {
        Self::Other {
            message: msg.to_string(),
        }
    }
}

/// A devserver workspace as the launcher renders it: the tenant fields plus
/// the assembled tenant URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DevserverWorkspaceRow {
    pub prefix: String,
    pub path: String,
    pub label: String,
    pub on: bool,
    pub status: chan_server::WorkspaceStatus,
    pub error: Option<String>,
    pub url: String,
}

/// Reuse one process-wide HTTP client so devserver polls and requests share keep-alive connection pools. Cloning the client shares its pool rather than opening an independent one. Memoize the build result, including TLS initialization failures, so every caller sees the same initialization outcome without repeated build attempts.
///
/// iOS setup installs the stable proxy before any request. The builder refuses
/// an earlier call, so initialization cannot silently cache a direct client.
fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            tls_client_builder()
                .and_then(|builder| {
                    builder
                        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                        .build()
                        .map_err(|e| e.to_string())
                })
                .map_err(|e| format!("building devserver http client: {e}"))
        })
        .clone()
}

/// The no-redirect twin of [`http_client`], under the same proxy order.
fn http_client_no_redirect() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            tls_client_builder()
                .and_then(|builder| {
                    builder
                        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                        .redirect(reqwest::redirect::Policy::none())
                        .build()
                        .map_err(|e| e.to_string())
                })
                .map_err(|e| format!("building devserver no-redirect http client: {e}"))
        })
        .clone()
}

/// The raw management-API origin the desktop dials for direct loopback
/// devservers. Gateway-backed devservers use the discovered proxy origin.
pub fn base_origin(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

pub fn conn_base_origin(conn: &DevserverConn) -> String {
    conn.gateway
        .as_ref()
        .map(|gw| gw.proxy_origin.clone())
        .unwrap_or_else(|| base_origin(&conn.host, conn.port))
}

pub fn normalize_devserver_url(url: &str) -> Result<String, String> {
    let s = url.trim();
    let normalized = if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("http://{s}")
    };
    let parsed =
        url::Url::parse(&normalized).map_err(|e| format!("invalid devserver URL {url:?}: {e}"))?;
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("devserver URL {url:?} has no host"))?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| format!("devserver URL {url:?} has no port and an unknown scheme"))?;
    let mut out = parsed;
    out.set_host(Some(&host))
        .map_err(|_| format!("invalid devserver host {host:?}"))?;
    if out.port_or_known_default() == Some(port) {
        Ok(out.to_string())
    } else {
        Err(format!("invalid devserver URL {url:?}"))
    }
}

/// Raw `GET /.well-known/chan-gateway` wire payload before validation.
///
/// The mobile endpoints deserialize as optional so a pre-mobile gateway
/// (advertising only the desktop fields) decodes cleanly and fails
/// [`validate_gateway_discovery`] with a dedicated mobile-unsupported message
/// rather than a generic JSON missing-field error. Desktop-only fields such as
/// `desktop_authorize_url`, `desktop_entry_url`, `roster_url`, and
/// `tunnel_url` are ignored when present.
#[derive(Debug, Clone, Deserialize)]
struct RawGatewayDiscovery {
    kind: String,
    api_version: u32,
    identity_origin: String,
    #[serde(default)]
    mobile_authorize_url: Option<String>,
    #[serde(default)]
    mobile_entry_url: Option<String>,
    #[serde(default)]
    mobile_roster_url: Option<String>,
    devserver_proxy_origin: String,
    devserver_proxy_host_depth: u8,
    #[serde(default)]
    wireguard: Option<WireguardDiscovery>,
}

#[derive(Debug, Clone)]
pub struct GatewayDiscovery {
    pub kind: String,
    pub api_version: u32,
    pub identity_origin: String,
    pub mobile_authorize_url: String,
    pub mobile_entry_url: String,
    pub mobile_roster_url: String,
    pub devserver_proxy_origin: String,
    pub devserver_proxy_host_depth: u8,
    /// The gateway's WireGuard ingress, when advertised. Optional on the wire;
    /// validated when present.
    pub wireguard: Option<WireguardDiscovery>,
}

/// Where a gateway's WireGuard ingress listens and the public key of its
/// interface, as the discovery document names them.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WireguardDiscovery {
    /// Explicit support for enrollment through the mobile authorization flow.
    #[serde(default)]
    pub mobile_enrollment: bool,
    /// `host:port`, an IPv6 literal in brackets, as a wg-quick
    /// `Endpoint` reads.
    pub endpoint: String,
    /// The interface's public key as `wg` prints it.
    pub public_key: String,
    /// Routing policy shared by the advertised ingresses. Older gateways
    /// provide it only in the redeem.
    #[serde(default)]
    pub allowed_ips: Option<Vec<String>>,
    #[serde(default)]
    pub persistent_keepalive: Option<u16>,
    /// Absent on gateways that advertise only the legacy peer pair.
    #[serde(default)]
    pub ingresses: Option<Vec<crate::config::WireguardIngress>>,
}

impl WireguardDiscovery {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let invalid = || "chan-gateway discovery has an invalid wireguard entry".to_string();
        if !crate::wireguard_keys::valid_peer(&self.public_key, &self.endpoint)
            || self.persistent_keepalive == Some(0)
        {
            return Err(invalid());
        }
        let allowed = self
            .allowed_ips
            .as_deref()
            .map(crate::wireguard_keys::cidrs);
        if matches!(&allowed, Some(None))
            || matches!(&allowed, Some(Some(cidrs)) if cidrs.is_empty())
        {
            return Err(invalid());
        }
        if let Some(ingresses) = &self.ingresses {
            let allowed = allowed.flatten().ok_or_else(invalid)?;
            crate::wireguard_keys::validate_ingresses(ingresses, &allowed)
                .map_err(|_| invalid())?;
            let first = &ingresses[0];
            if first.public_key != self.public_key || first.endpoint != self.endpoint {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

fn origin_of(raw: &str) -> Result<String, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid URL {raw:?}: {e}"))?;
    if parsed.host_str().is_none() {
        return Err(format!("URL {raw:?} has no host"));
    }
    Ok(parsed.origin().ascii_serialization())
}

fn is_loopback_gateway_host(host: &str) -> bool {
    let h = host
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    if h == "localhost" || h == "localtest.me" || h.ends_with(".localtest.me") {
        return true;
    }
    // An IP counts only when the whole host PARSES as one and it is
    // loopback: a prefix test like starts_with("127.") also accepts
    // public DNS names such as `127.example.com` over cleartext.
    h.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

fn require_https_unless_loopback(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid URL {raw:?}: {e}"))?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if parsed.host_str().is_some_and(is_loopback_gateway_host) => Ok(()),
        "http" => Err(format!(
            "gateway URL {raw:?} must use https outside loopback dev"
        )),
        other => Err(format!(
            "gateway URL {raw:?} has unsupported scheme {other:?}"
        )),
    }
}

fn validate_gateway_discovery(
    configured_url: &str,
    raw: RawGatewayDiscovery,
) -> Result<GatewayDiscovery, String> {
    let d = GatewayDiscovery {
        kind: raw.kind,
        api_version: raw.api_version,
        identity_origin: raw.identity_origin,
        mobile_authorize_url: raw.mobile_authorize_url.unwrap_or_default(),
        mobile_entry_url: raw.mobile_entry_url.unwrap_or_default(),
        mobile_roster_url: raw.mobile_roster_url.unwrap_or_default(),
        devserver_proxy_origin: raw.devserver_proxy_origin,
        devserver_proxy_host_depth: raw.devserver_proxy_host_depth,
        wireguard: raw.wireguard,
    };
    if d.kind != "chan-gateway" || d.api_version != 1 {
        return Err("server is not a supported chan-gateway".to_string());
    }
    if d.devserver_proxy_host_depth != 2 {
        return Err("chan-gateway discovery has an unsupported proxy host depth".to_string());
    }
    if [
        d.mobile_authorize_url.as_str(),
        d.mobile_entry_url.as_str(),
        d.mobile_roster_url.as_str(),
    ]
    .iter()
    .any(|url| url.trim().is_empty())
    {
        return Err("this gateway does not support mobile sign-in".to_string());
    }

    let configured_origin = origin_of(configured_url)?;
    let identity_origin = origin_of(&d.identity_origin)?;
    let authorize_origin = origin_of(&d.mobile_authorize_url)?;
    let entry_origin = origin_of(&d.mobile_entry_url)?;
    let roster_origin = origin_of(&d.mobile_roster_url)?;
    if identity_origin != configured_origin
        || authorize_origin != configured_origin
        || entry_origin != configured_origin
        || roster_origin != configured_origin
    {
        return Err("chan-gateway discovery is cross-origin".to_string());
    }
    if let Some(wireguard) = &d.wireguard {
        wireguard.validate()?;
    }

    for url in [
        configured_url,
        &d.identity_origin,
        &d.mobile_authorize_url,
        &d.mobile_entry_url,
        &d.mobile_roster_url,
        &d.devserver_proxy_origin,
    ] {
        require_https_unless_loopback(url)?;
    }

    Ok(d)
}

#[derive(Debug)]
pub enum GatewayDiscoveryError {
    Transport(String),
    Other(String),
}

impl From<String> for GatewayDiscoveryError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl std::fmt::Display for GatewayDiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) | Self::Other(message) => f.write_str(message),
        }
    }
}

pub async fn discover_gateway(url: &str) -> Result<GatewayDiscovery, GatewayDiscoveryError> {
    let normalized = normalize_devserver_url(url)?;
    let mut u = url::Url::parse(&normalized)
        .map_err(|e| GatewayDiscoveryError::Other(format!("bad gateway URL: {e}")))?;
    u.set_path("/.well-known/chan-gateway");
    u.set_query(None);
    u.set_fragment(None);
    let resp = http_client_no_redirect()?
        .get(u)
        .send()
        .await
        // reqwest's own message stops before the cause, which for a gateway
        // behind a CA in neither trust store is the refused certificate.
        .map_err(|e| {
            GatewayDiscoveryError::Transport(format!(
                "checking chan-gateway discovery: {}",
                crate::native_transfer::reason_without_url(e)
            ))
        })?;
    if !resp.status().is_success() {
        return Err(GatewayDiscoveryError::Other(format!(
            "gateway discovery returned HTTP {}",
            resp.status()
        )));
    }
    let d = resp
        .json::<RawGatewayDiscovery>()
        .await
        .map_err(|e| GatewayDiscoveryError::Other(format!("decoding gateway discovery: {e}")))?;
    validate_gateway_discovery(&normalized, d).map_err(Into::into)
}

#[derive(Serialize)]
struct GatewayEntryRequest<'a> {
    path: &'a str,
    /// Explicit devserver target (a roster row's owner + id); the
    /// keys stay off the wire when absent so an older gateway parses
    /// the request unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_user_id: Option<uuid::Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    devserver_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct GatewayEntryResponse {
    owner_user_id: uuid::Uuid,
    username: String,
    devserver_id: String,
    proxy_origin: String,
    entry_exchange_url: String,
    entry_credential: String,
}

impl std::fmt::Debug for GatewayEntryResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayEntryResponse")
            .field("owner_user_id", &self.owner_user_id)
            .field("username", &self.username)
            .field("devserver_id", &self.devserver_id)
            .field("proxy_origin", &self.proxy_origin)
            .field("entry_exchange_url", &self.entry_exchange_url)
            .field("entry_credential", &"[REDACTED]")
            .finish()
    }
}

#[derive(PartialEq, Eq)]
struct ValidatedGatewayEntry {
    proxy_origin: String,
    entry_exchange_url: String,
    entry_credential: String,
    requested_path: String,
}

impl std::fmt::Debug for ValidatedGatewayEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValidatedGatewayEntry")
            .field("proxy_origin", &self.proxy_origin)
            .field("entry_exchange_url", &self.entry_exchange_url)
            .field("entry_credential", &"[REDACTED]")
            .field("requested_path", &self.requested_path)
            .finish()
    }
}

const GATEWAY_ENTRY_EXCHANGE_PATH: &str = "/_chan/entry";

const MAX_GATEWAY_ENTRY_CREDENTIAL_BYTES: usize = 4096;

fn canonical_origin_only(raw: &str, field: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid {field}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "{field} has unsupported scheme {:?}",
            parsed.scheme()
        ));
    }
    if parsed.host_str().is_none() {
        return Err(format!("{field} has no host"));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!("{field} must contain only scheme, host, and port"));
    }
    require_https_unless_loopback(raw)?;
    Ok(parsed)
}

fn validate_gateway_entry(
    proxy_apex_origin: &str,
    requested_target: Option<&GatewayEntryTarget>,
    requested_path: &str,
    pinned_origin: Option<&str>,
    response: GatewayEntryResponse,
) -> Result<ValidatedGatewayEntry, String> {
    if let Some(target) = requested_target {
        if response.owner_user_id != target.owner_user_id {
            return Err(format!(
                "gateway entry owner id mismatch: requested {}, got {}",
                target.owner_user_id, response.owner_user_id
            ));
        }
        if response.devserver_id != target.devserver_id {
            return Err(format!(
                "gateway entry devserver id mismatch: requested {:?}, got {:?}",
                target.devserver_id, response.devserver_id
            ));
        }
    }
    if response.proxy_origin.trim().is_empty() {
        return Err("gateway entry proxy_origin is empty".to_string());
    }
    let apex = canonical_origin_only(proxy_apex_origin, "gateway proxy apex")?;
    let proxy = canonical_origin_only(&response.proxy_origin, "gateway entry proxy_origin")?;
    if proxy.scheme() != apex.scheme()
        || proxy.port_or_known_default() != apex.port_or_known_default()
    {
        return Err("gateway entry proxy_origin does not match discovery scheme and port".into());
    }
    let apex_host = apex.host_str().expect("origin validator requires a host");
    let proxy_host = proxy.host_str().expect("origin validator requires a host");
    let suffix = format!(".{apex_host}");
    let child = proxy_host
        .strip_suffix(&suffix)
        .filter(|child| {
            let mut labels = child.split('.');
            labels.next().is_some_and(|label| !label.is_empty())
                && labels.next().is_some_and(|label| !label.is_empty())
                && labels.next().is_none()
        })
        .ok_or_else(|| {
            "gateway entry proxy_origin is not exactly two labels below the discovery proxy apex"
                .to_string()
        })?;
    let expected_tenant_label = format!(
        "{}--{}",
        response.username,
        response.devserver_id.chars().take(12).collect::<String>()
    );
    let tenant_label = child.split('.').next().unwrap_or_default();
    if tenant_label != expected_tenant_label {
        return Err("gateway entry proxy_origin is not bound to its owner and devserver".into());
    }

    let proxy_origin = proxy.origin().ascii_serialization();
    if pinned_origin.is_some_and(|pinned| pinned != proxy_origin) {
        return Err("gateway entry attempted to change the pinned proxy origin".to_string());
    }

    let exchange = url::Url::parse(&response.entry_exchange_url)
        .map_err(|e| format!("invalid gateway entry_exchange_url: {e}"))?;
    if !exchange.username().is_empty() || exchange.password().is_some() {
        return Err("gateway entry_exchange_url must not contain credentials".to_string());
    }
    if exchange.origin().ascii_serialization() != proxy_origin {
        return Err("gateway entry_exchange_url origin does not match proxy_origin".to_string());
    }
    if exchange.path() != GATEWAY_ENTRY_EXCHANGE_PATH
        || exchange.query().is_some()
        || exchange.fragment().is_some()
    {
        return Err("gateway entry_exchange_url is not the fixed exchange endpoint".to_string());
    }
    if response.entry_credential.is_empty()
        || response.entry_credential.len() > MAX_GATEWAY_ENTRY_CREDENTIAL_BYTES
        || response.entry_credential.chars().any(char::is_control)
    {
        return Err("gateway entry_credential has an invalid shape".to_string());
    }
    Ok(ValidatedGatewayEntry {
        proxy_origin,
        entry_exchange_url: response.entry_exchange_url,
        entry_credential: response.entry_credential,
        requested_path: requested_path.to_string(),
    })
}

/// Why the gateway refused to mint an entry URL, parsed from the entry
/// endpoint's status + error body so the connect flow can narrate the failure
/// (and self-heal a revoked PAT) instead of flattening everything to one
/// generic string. Every body field beyond `error` is optional on the wire: a
/// gateway that sends no `reason` (or a non-JSON body) classifies as
/// [`Other`](Self::Other) with the plain HTTP-status string, so both skew
/// directions use the status-only classification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayEntryError {
    /// HTTP 401: the PAT is invalid or revoked. The connect flow clears the
    /// stored PAT and re-enters the browser sign-in.
    Unauthorized,
    /// Signed in, but no devserver is registered for this account.
    NoDevserver { username: Option<String> },
    /// A devserver is registered but holds no live tunnel right now.
    DevserverOffline {
        username: Option<String>,
        label: Option<String>,
    },
    /// The account's access to the devserver was denied.
    AccessDenied,
    /// Any other failure (network, decode, an unknown status, or an older
    /// gateway whose error body carries no reason).
    Other(String),
}

impl std::fmt::Display for GatewayEntryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "the gateway sign-in is no longer valid (HTTP 401)"),
            Self::NoDevserver {
                username: Some(username),
            } => write!(
                f,
                "signed in as {username}, but no devserver is registered; \
                 run chan on your machine and connect it to the gateway"
            ),
            Self::NoDevserver { username: None } => write!(
                f,
                "signed in, but no devserver is registered; \
                 run chan on your machine and connect it to the gateway"
            ),
            Self::DevserverOffline {
                label: Some(label), ..
            } => write!(
                f,
                "devserver \"{label}\" is registered but not currently connected"
            ),
            Self::DevserverOffline { label: None, .. } => {
                write!(
                    f,
                    "your devserver is registered but not currently connected"
                )
            }
            Self::AccessDenied => write!(f, "the gateway denied access to this devserver"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// The String conversion the session-refresh paths use: past the connect
/// narration, an entry failure is just an error message again.
impl From<GatewayEntryError> for String {
    fn from(e: GatewayEntryError) -> Self {
        e.to_string()
    }
}

/// The entry endpoint's error body. A superset of the plain `{"error": msg}`
/// shape: `reason` is a short stable token (`no_devserver`,
/// `devserver_offline`, `access_denied`); `username`/`label` decorate the
/// human string when present. Everything is optional so an older gateway's
/// body (or a proxy error page) parses to no reason and falls through.
#[derive(Debug, Deserialize)]
struct GatewayEntryErrorBody {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

/// Classify a non-success entry response. 401 is authorization regardless of
/// body; anything else consults the body's `reason` token and falls back to
/// the plain HTTP-status string when the body carries none.
fn classify_entry_error(status: reqwest::StatusCode, body: &[u8]) -> GatewayEntryError {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return GatewayEntryError::Unauthorized;
    }
    if let Ok(body) = serde_json::from_slice::<GatewayEntryErrorBody>(body) {
        match body.reason.as_deref() {
            Some("no_devserver") => {
                return GatewayEntryError::NoDevserver {
                    username: body.username,
                }
            }
            Some("devserver_offline") => {
                return GatewayEntryError::DevserverOffline {
                    username: body.username,
                    label: body.label,
                }
            }
            Some("access_denied") => return GatewayEntryError::AccessDenied,
            _ => {}
        }
    }
    GatewayEntryError::Other(format!("gateway entry returned HTTP {status}"))
}

async fn request_gateway_entry(
    mobile_entry_url: &str,
    pat: &str,
    entry_target: Option<&GatewayEntryTarget>,
    path: &str,
) -> Result<GatewayEntryResponse, GatewayEntryError> {
    let resp = http_client()
        .map_err(GatewayEntryError::Other)?
        .post(mobile_entry_url)
        .bearer_auth(pat)
        .json(&GatewayEntryRequest {
            path,
            owner: entry_target.map(|target| target.owner.as_str()),
            owner_user_id: entry_target.map(|target| target.owner_user_id),
            devserver_id: entry_target.map(|target| target.devserver_id.as_str()),
        })
        .send()
        .await
        .map_err(|e| GatewayEntryError::Other(format!("minting gateway entry URL: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.bytes().await.unwrap_or_default();
        return Err(classify_entry_error(status, &body));
    }
    resp.json::<GatewayEntryResponse>()
        .await
        .map_err(|e| GatewayEntryError::Other(format!("decoding gateway entry: {e}")))
}

async fn gateway_entry(
    gw: &GatewayConn,
    path: &str,
) -> Result<ValidatedGatewayEntry, GatewayEntryError> {
    let epoch = gw.begin_operation().map_err(GatewayEntryError::Other)?;
    let response = request_gateway_entry(
        &gw.mobile_entry_url,
        &gw.pat,
        gw.entry_target.as_ref(),
        path,
    )
    .await?;
    gw.require_operation(epoch)
        .map_err(GatewayEntryError::Other)?;
    validate_gateway_entry(
        &gw.proxy_apex_origin,
        gw.entry_target.as_ref(),
        path,
        Some(&gw.proxy_origin),
        response,
    )
    .map_err(GatewayEntryError::Other)
}

#[cfg(test)]
pub async fn gateway_conn(
    discovery: &GatewayDiscovery,
    pat: String,
    entry_target: Option<GatewayEntryTarget>,
) -> Result<GatewayConn, GatewayEntryError> {
    gateway_conn_guarded(discovery, pat, entry_target, None).await
}

pub(crate) async fn gateway_conn_guarded(
    discovery: &GatewayDiscovery,
    pat: String,
    entry_target: Option<GatewayEntryTarget>,
    access: Option<crate::wireguard::AccessGuard>,
) -> Result<GatewayConn, GatewayEntryError> {
    let epoch = access
        .as_ref()
        .map(crate::wireguard::AccessGuard::epoch)
        .transpose()
        .map_err(GatewayEntryError::Other)?;
    let response = request_gateway_entry(
        &discovery.mobile_entry_url,
        &pat,
        entry_target.as_ref(),
        "/",
    )
    .await?;
    let entry = validate_gateway_entry(
        &discovery.devserver_proxy_origin,
        entry_target.as_ref(),
        "/",
        None,
        response,
    )
    .map_err(GatewayEntryError::Other)?;
    let gw = GatewayConn {
        access,
        identity_origin: discovery.identity_origin.clone(),
        mobile_entry_url: discovery.mobile_entry_url.clone(),
        proxy_apex_origin: origin_of(&discovery.devserver_proxy_origin)
            .map_err(GatewayEntryError::Other)?,
        proxy_origin: entry.proxy_origin.clone(),
        pat,
        entry_target,
        session: Arc::new(Mutex::new(None)),
        session_refresh: Arc::new(tokio::sync::Mutex::new(())),
        session_installer: Arc::new(Mutex::new(None)),
    };
    gw.require_operation(epoch)
        .map_err(GatewayEntryError::Other)?;
    establish_gateway_session_from_entry(&gw, &entry)
        .await
        .map_err(GatewayEntryError::Other)?;
    Ok(gw)
}

fn extract_cookie_value(
    set_cookie: &reqwest::header::HeaderMap,
    cookie_name: &str,
) -> Option<String> {
    for value in set_cookie.get_all(reqwest::header::SET_COOKIE) {
        let Ok(raw) = value.to_str() else { continue };
        let first = raw.split(';').next().unwrap_or("");
        let Some((name, value)) = first.split_once('=') else {
            continue;
        };
        if name == cookie_name && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn extract_cookie_max_age(
    set_cookie: &reqwest::header::HeaderMap,
    cookie_name: &str,
) -> Option<u64> {
    for value in set_cookie.get_all(reqwest::header::SET_COOKIE) {
        let Ok(raw) = value.to_str() else { continue };
        let mut fields = raw.split(';');
        let Some((name, _)) = fields.next().and_then(|field| field.trim().split_once('=')) else {
            continue;
        };
        if name != cookie_name {
            continue;
        }
        for field in fields {
            let Some((name, value)) = field.trim().split_once('=') else {
                continue;
            };
            if name.eq_ignore_ascii_case("max-age") {
                return value.trim().parse::<u64>().ok();
            }
        }
    }
    None
}

fn gateway_session_ttl(max_age: Option<u64>) -> Duration {
    let max_age = max_age
        .unwrap_or(GATE_SESSION_FALLBACK_TTL_SECS)
        // A malicious or broken peer must not make the desktop cache forever.
        .min(24 * 60 * 60);
    Duration::from_secs(max_age.saturating_sub(GATE_SESSION_EXPIRY_SAFETY_SECS))
}

fn gateway_session_expiry(max_age: Option<u64>) -> Instant {
    Instant::now() + gateway_session_ttl(max_age)
}

async fn establish_gateway_session_from_entry(
    gw: &GatewayConn,
    entry: &ValidatedGatewayEntry,
) -> Result<(GatewaySession, String), String> {
    let epoch = gw.begin_operation()?;
    let resp = http_client_no_redirect()?
        .post(&entry.entry_exchange_url)
        .header(reqwest::header::ORIGIN, &gw.identity_origin)
        .form(&[("credential", entry.entry_credential.as_str())])
        .send()
        .await
        .map_err(|e| format!("exchanging gateway entry credential: {e}"))?;
    gw.require_operation(epoch)?;
    if resp.status() != reqwest::StatusCode::SEE_OTHER {
        return Err(format!(
            "gateway entry exchange returned HTTP {}",
            resp.status()
        ));
    }
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "gateway entry exchange did not return a navigation target".to_string())?;
    validate_gateway_navigation_location(location, &entry.requested_path)?;
    let gate = extract_cookie_value(resp.headers(), "__Host-devserver_gate")
        .ok_or_else(|| "gateway did not return a devserver session cookie".to_string())?;
    let csrf = extract_cookie_value(resp.headers(), "__Host-devserver_csrf")
        .ok_or_else(|| "gateway did not return a CSRF cookie".to_string())?;
    let expires_at = gateway_session_expiry(extract_cookie_max_age(
        resp.headers(),
        "__Host-devserver_gate",
    ));
    let session = GatewaySession {
        gate: gate.clone(),
        cookie_header: format!("__Host-devserver_gate={gate}; __Host-devserver_csrf={csrf}"),
        csrf,
        expires_at,
    };
    publish_gateway_session(gw, &session)?;
    Ok((session, gateway_url(gw, location)))
}

fn publish_gateway_session(gw: &GatewayConn, session: &GatewaySession) -> Result<(), String> {
    gw.require_access()?;
    *gw.session.lock().unwrap() = Some(session.clone());
    let installer = gw.session_installer.lock().unwrap().clone();
    if let Some(installer) = installer {
        if let Err(error) = installer(&gw.proxy_origin, session) {
            let mut current = gw.session.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|current| current.cookie_header == session.cookie_header)
            {
                *current = None;
            }
            return Err(error);
        }
    }
    Ok(())
}

fn validate_gateway_navigation_location(
    location: &str,
    requested_path: &str,
) -> Result<(), String> {
    if location != requested_path
        || location.is_empty()
        || !location.starts_with('/')
        || location.starts_with("//")
        || location.contains('\\')
        || location.chars().any(char::is_control)
    {
        return Err("gateway entry exchange returned an unexpected navigation target".to_string());
    }
    Ok(())
}

async fn mint_gateway_session(gw: &GatewayConn) -> Result<GatewaySession, String> {
    let epoch = gw.begin_operation()?;
    let entry = gateway_entry(gw, "/").await?;
    gw.require_operation(epoch)?;
    establish_gateway_session_from_entry(gw, &entry)
        .await
        .map(|(session, _)| session)
}

async fn gateway_session(gw: &GatewayConn) -> Result<GatewaySession, String> {
    let epoch = gw.begin_operation()?;
    if let Some(session) = gw.session.lock().unwrap().clone().filter(|s| s.is_fresh()) {
        return Ok(session);
    }
    let _refresh = gw.session_refresh.lock().await;
    gw.require_operation(epoch)?;
    if let Some(session) = gw.session.lock().unwrap().clone().filter(|s| s.is_fresh()) {
        return Ok(session);
    }
    mint_gateway_session(gw).await
}

async fn refresh_gateway_session_after(
    gw: &GatewayConn,
    observed_cookie_header: &str,
) -> Result<GatewaySession, String> {
    let epoch = gw.begin_operation()?;
    let _refresh = gw.session_refresh.lock().await;
    gw.require_operation(epoch)?;
    if let Some(session) = gw
        .session
        .lock()
        .unwrap()
        .clone()
        .filter(|s| s.is_fresh() && s.cookie_header != observed_cookie_header)
    {
        return Ok(session);
    }
    mint_gateway_session(gw).await
}

fn gateway_connection_for_window(
    state: &crate::AppState,
    window_label: &str,
    window_url: &url::Url,
) -> Result<DevserverConn, String> {
    let exact_origin = window_url.origin().ascii_serialization();
    if window_label == "main" {
        return state
            .devservers
            .gateway_conn_for_origin(&exact_origin)
            .ok_or_else(|| "gateway CSRF token connection is not available".to_string());
    }
    if !window_label.starts_with("lib-") {
        return Err("gateway CSRF token is unavailable to this window".to_string());
    }
    let (devserver_id, _) = state
        .devserver_feed
        .record_for_native_label(window_label)
        .ok_or_else(|| "gateway CSRF token has no matching devserver window".to_string())?;
    let conn = state
        .devservers
        .get(&devserver_id)
        .ok_or_else(|| "gateway CSRF token connection is not available".to_string())?;
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "gateway CSRF token is unavailable on a direct connection".to_string())?;
    if gw.proxy_origin != exact_origin {
        return Err("gateway CSRF token origin does not match this window".to_string());
    }
    Ok(conn)
}

async fn gateway_csrf_token_for_connection(
    conn: &DevserverConn,
    window_label: &str,
    window_url: &url::Url,
) -> Result<String, String> {
    if window_label != "main" && !window_label.starts_with("lib-") {
        return Err("gateway CSRF token is unavailable to this window".to_string());
    }
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "gateway CSRF token is unavailable on a direct connection".to_string())?;
    if window_url.origin().ascii_serialization() != gw.proxy_origin {
        return Err("gateway CSRF token origin does not match this window".to_string());
    }
    gateway_session(gw).await.map(|session| session.csrf)
}

/// Return the current gateway CSRF token only to the exact managed window and
/// origin that own its connection. The runtime capability rejects calls from
/// other labels and origins first; these checks independently bind the handler
/// to live connection state and cover a window that navigates during refresh.
#[tauri::command]
pub(crate) async fn gateway_csrf_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::AppState>>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    let label = window.label().to_string();
    let url = window
        .url()
        .map_err(|e| format!("reading gateway window URL: {e}"))?;
    let conn = gateway_connection_for_window(state.inner(), &label, &url)?;
    install_gateway_webview_session(&app, &conn, Some(&label))?;
    gateway_csrf_token_for_connection(&conn, &label, &url).await?;

    // A reconnect can replace the connection while an expired session is being
    // minted. Resolve both the connection and URL again so the returned token
    // belongs to what the caller is showing now.
    let url = window
        .url()
        .map_err(|e| format!("reading gateway window URL after refresh: {e}"))?;
    let conn = gateway_connection_for_window(state.inner(), &label, &url)?;
    install_gateway_webview_session(&app, &conn, Some(&label))?;
    gateway_csrf_token_for_connection(&conn, &label, &url).await
}

/// Copy the native client's freshly exchanged opaque session into the shared
/// Tauri WebView cookie store before a clean tenant URL is opened. This keeps
/// the entry credential out of navigation URLs while preserving HttpOnly on
/// the authorization cookie. The installer remains attached to the connection
/// so every later session re-mint updates the store without a navigation.
pub(crate) fn install_gateway_webview_session<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    conn: &DevserverConn,
    preferred_window_label: Option<&str>,
) -> Result<(), String> {
    let Some(gw) = conn.gateway.as_ref() else {
        return Ok(());
    };
    let app = app.clone();
    let preferred_window_label = preferred_window_label.map(str::to_string);
    let access = gw.access.clone();
    let installer: Arc<GatewaySessionInstaller> = Arc::new(move |origin, session| {
        install_gateway_webview_session_values(
            &app,
            origin,
            session,
            preferred_window_label.as_deref(),
            access.as_ref(),
        )
    });
    *gw.session_installer.lock().unwrap() = Some(Arc::clone(&installer));
    install_current_gateway_session(gw, installer.as_ref())
}

fn install_current_gateway_session(
    gw: &GatewayConn,
    installer: &GatewaySessionInstaller,
) -> Result<(), String> {
    loop {
        // Keep this guard scoped to the block. In an edition-2021 `while let`
        // scrutinee it would live through the body and deadlock the re-check.
        let session = {
            let current = gw.session.lock().unwrap();
            current.clone().filter(GatewaySession::is_fresh)
        };
        let Some(session) = session else {
            break;
        };
        installer(&gw.proxy_origin, &session)?;
        let installed_is_current = {
            let current = gw.session.lock().unwrap();
            current.as_ref().is_some_and(|current| {
                current.is_fresh() && current.cookie_header == session.cookie_header
            })
        };
        if installed_is_current {
            break;
        }
    }
    Ok(())
}

#[cfg(not(target_os = "ios"))]
fn install_gateway_webview_session_values<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    proxy_origin: &str,
    session: &GatewaySession,
    preferred_window_label: Option<&str>,
    access: Option<&crate::wireguard::AccessGuard>,
) -> Result<(), String> {
    use tauri::Manager;
    if access.is_some() {
        return Err("WireGuard cookie installation is unavailable on this platform".into());
    }
    let origin =
        url::Url::parse(proxy_origin).map_err(|e| format!("invalid pinned gateway origin: {e}"))?;
    let domain = origin
        .host_str()
        .ok_or_else(|| "pinned gateway origin has no host".to_string())?
        .to_string();
    let secure = origin.scheme() == "https";
    // Injection through the platform cookie store (WKHTTPCookieStore /
    // SoupCookieJar) bypasses Set-Cookie prefix parsing, and a domain
    // with no leading dot stays host-only, so the `__Host-` names are
    // accepted here even though a `.domain()` attribute is present.
    let gate = tauri::webview::Cookie::build(("__Host-devserver_gate", session.gate.clone()))
        .domain(domain.clone())
        .path("/")
        .secure(secure)
        .http_only(true)
        .same_site(tauri::webview::cookie::SameSite::Lax)
        .build();
    let csrf = tauri::webview::Cookie::build(("__Host-devserver_csrf", session.csrf.clone()))
        .domain(domain)
        .path("/")
        .secure(secure)
        .http_only(false)
        .same_site(tauri::webview::cookie::SameSite::Lax)
        .build();
    let webview = preferred_window_label
        .and_then(|label| app.get_webview_window(label))
        .or_else(|| app.webview_windows().into_values().next());
    let Some(webview) = webview else {
        return if access.is_some() {
            Err("WireGuard: no WebView is available for the session".into())
        } else {
            Ok(())
        };
    };
    if let Some(access) = access {
        access.check(proxy_origin)?;
    }
    webview
        .set_cookie(gate)
        .map_err(|e| format!("installing gateway session cookie: {e}"))?;
    if let Some(access) = access {
        access.check(proxy_origin)?;
    }
    webview
        .set_cookie(csrf)
        .map_err(|e| format!("installing gateway CSRF cookie: {e}"))?;
    if let Some(access) = access {
        access.check(proxy_origin)?;
    }
    Ok(())
}

fn gateway_url(gw: &GatewayConn, path: &str) -> String {
    format!("{}{}", gw.proxy_origin.trim_end_matches('/'), path)
}

async fn gateway_get(conn: &DevserverConn, path: &str) -> Result<reqwest::Response, String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
    gateway_request(gw, reqwest::Method::GET, path, None::<&()>, None).await
}

fn gateway_auth_shaped(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::UNAUTHORIZED
}

fn apply_gateway_session(
    builder: reqwest::RequestBuilder,
    method: &reqwest::Method,
    session: &GatewaySession,
) -> reqwest::RequestBuilder {
    let builder = builder.header(reqwest::header::COOKIE, session.cookie_header.clone());
    if method == reqwest::Method::POST
        || method == reqwest::Method::PUT
        || method == reqwest::Method::PATCH
        || method == reqwest::Method::DELETE
    {
        builder.header("X-Chan-CSRF", session.csrf.clone())
    } else {
        builder
    }
}

fn gateway_request_builder<T: Serialize + ?Sized>(
    gw: &GatewayConn,
    method: &reqwest::Method,
    path: &str,
    body: Option<&T>,
    timeout: Duration,
    session: &GatewaySession,
) -> Result<reqwest::RequestBuilder, String> {
    gw.require_access()?;
    let builder = http_client()?
        .request(method.clone(), gateway_url(gw, path))
        .timeout(timeout);
    let builder = match body {
        Some(body) => builder.json(body),
        None => builder,
    };
    Ok(apply_gateway_session(builder, method, session))
}

async fn gateway_request<T: Serialize + ?Sized>(
    gw: &GatewayConn,
    method: reqwest::Method,
    path: &str,
    body: Option<&T>,
    timeout: Option<Duration>,
) -> Result<reqwest::Response, String> {
    let epoch = gw.begin_operation()?;
    let timeout = timeout.unwrap_or(Duration::from_secs(HTTP_TIMEOUT_SECS));
    let session = gateway_session(gw).await?;
    gw.require_operation(epoch)?;
    let resp = gateway_request_builder(gw, &method, path, body, timeout, &session)?
        .send()
        .await
        .map_err(|e| format!("gateway {} {path}: {e}", method.as_str()))?;
    gw.require_operation(epoch)?;
    if !gateway_auth_shaped(resp.status()) {
        return Ok(resp);
    }
    let session = refresh_gateway_session_after(gw, &session.cookie_header).await?;
    gw.require_operation(epoch)?;
    let response = gateway_request_builder(gw, &method, path, body, timeout, &session)?
        .send()
        .await
        .map_err(|e| format!("gateway {} {path}: {e}", method.as_str()))?;
    gw.require_operation(epoch)?;
    Ok(response)
}

async fn raw_devserver_request<T: Serialize + ?Sized>(
    conn: &DevserverConn,
    method: reqwest::Method,
    url: &str,
    body: Option<&T>,
    timeout: Option<Duration>,
    transport_label: &str,
) -> Result<reqwest::Response, String> {
    let builder = http_client()?.request(method, url).bearer_auth(&conn.token);
    let builder = match body {
        Some(body) => builder.json(body),
        None => builder,
    };
    let builder = match timeout {
        Some(timeout) => builder.timeout(timeout),
        None => builder,
    };
    builder
        .send()
        .await
        .map_err(|e| format!("{transport_label}: {e}"))
}

async fn devserver_request<T: Serialize + ?Sized>(
    conn: &DevserverConn,
    method: reqwest::Method,
    path: &str,
    body: Option<&T>,
    raw_transport_label: &str,
) -> Result<reqwest::Response, String> {
    if let Some(gw) = &conn.gateway {
        gateway_request(gw, method, path, body, None).await
    } else {
        let url = format!("{}{}", base_origin(&conn.host, conn.port), path);
        raw_devserver_request(conn, method, &url, body, None, raw_transport_label).await
    }
}

#[derive(Clone, Copy)]
struct PerArmLabel<'a> {
    gateway: &'a str,
    raw: &'a str,
}

impl<'a> PerArmLabel<'a> {
    fn for_conn(self, conn: &DevserverConn) -> &'a str {
        if conn.gateway.is_some() {
            self.gateway
        } else {
            self.raw
        }
    }
}

async fn devserver_status_error(
    conn: &DevserverConn,
    resp: reqwest::Response,
    label: PerArmLabel<'_>,
) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let fallback = format!("HTTP {status}");
    format!(
        "{} returned {}",
        label.for_conn(conn),
        refusal_message(status, &body, &fallback)
    )
}

pub async fn gateway_entry_url(conn: &DevserverConn, path: &str) -> Result<String, String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
    let epoch = gw.begin_operation()?;
    validate_gateway_navigation_location(path, path)?;
    // GatewayConn is pinned to one exact proxy origin. Reuse its fresh opaque
    // session for every same-origin WebView navigation; minting a new entry
    // for each window would exhaust the proxy's per-principal session cap.
    if gw
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(GatewaySession::is_fresh)
    {
        return Ok(gateway_url(gw, path));
    }
    let _refresh = gw.session_refresh.lock().await;
    gw.require_operation(epoch)?;
    if gw
        .session
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(GatewaySession::is_fresh)
    {
        return Ok(gateway_url(gw, path));
    }
    let entry = gateway_entry(gw, path).await.map_err(String::from)?;
    gw.require_operation(epoch)?;
    establish_gateway_session_from_entry(gw, &entry)
        .await
        .map(|(_, navigation_url)| navigation_url)
}

/// Entry path for a tenant window: the prefix is normalized to exactly one
/// leading slash. `WindowRecord.prefix` carries an absolute route path
/// (`/api/notes-1a2b3c`), and identity's entry-path validator rejects a
/// `//`-prefixed path as protocol-relative.
fn window_entry_path(prefix: &str) -> String {
    format!("/{}/index.html", prefix.trim_start_matches('/'))
}

/// The URL a devserver window's webview navigates to, resolved AT NAVIGATION
/// TIME. Raw-tunnel devservers assemble the tenant URL from the row's stable
/// per-tenant token. Gateway devservers reuse the connection's exact-origin
/// opaque session; only a connection without one mints and body-exchanges an
/// entry credential. Entry credentials are never stamped into URLs or the
/// window feed's rows.
pub async fn window_navigation_url(
    conn: &DevserverConn,
    record: &chan_server::WindowRecord,
) -> Result<String, String> {
    if conn.gateway.is_some() {
        gateway_entry_url(conn, &window_entry_path(&record.prefix)).await
    } else {
        assemble_tenant_url_from_base(&conn_base_origin(conn), &record.prefix, &record.token)
    }
}

/// Assemble the tenant URL the desktop opens for a devserver tenant:
/// `http://{host}:{port}{prefix}/index.html?t={token}`. `prefix` is an
/// absolute route path such as `/api/notes-1a2b3c`. Routing through
/// `url::Url` percent-encodes the token query value.
pub fn assemble_tenant_url(
    host: &str,
    port: u16,
    prefix: &str,
    token: &str,
) -> Result<String, String> {
    let base = base_origin(host, port);
    assemble_tenant_url_from_base(&base, prefix, token)
}

pub fn assemble_tenant_url_from_base(
    base: &str,
    prefix: &str,
    token: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(base).map_err(|e| format!("bad devserver base {base}: {e}"))?;
    let path = format!("{}/index.html", prefix.trim_end_matches('/'));
    url.set_path(&path);
    url.query_pairs_mut().append_pair("t", token);
    Ok(url.to_string())
}

/// The meta descriptor chan-server injects into every launcher shell
/// (`inject_launcher_meta`) carrying the serving host's OS family.
const HOST_OS_META_NAME: &str = "chan-launcher-host-os";

/// Fetch a gateway-proxied devserver's OS family (`macos | windows | linux |
/// other`) for the launcher's machine icon from the launcher shell's host-os
/// meta tag.
pub async fn fetch_gateway_host_os(conn: &DevserverConn) -> Result<String, String> {
    let resp = gateway_get(conn, "/").await?;
    if !resp.status().is_success() {
        return Err(format!(
            "gateway launcher shell returned HTTP {}",
            resp.status()
        ));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("reading gateway launcher shell: {e}"))?;
    parse_host_os_meta(&html)
        .ok_or_else(|| "the launcher shell carries no host-os descriptor".to_string())
}

/// Pull the host-os meta's content out of a launcher shell, scanning whole
/// `<meta ...>` tags so attribute order and spacing can vary across server
/// versions.
fn parse_host_os_meta(html: &str) -> Option<String> {
    let name_attr = format!("name=\"{HOST_OS_META_NAME}\"");
    let mut rest = html;
    while let Some(start) = rest.find("<meta") {
        let tag_and_rest = &rest[start..];
        let end = tag_and_rest.find('>')?;
        let tag = &tag_and_rest[..end];
        if tag.contains(&name_attr) {
            let value = tag
                .split_once("content=\"")
                .and_then(|(_, after)| after.split_once('"'))
                .map(|(value, _)| value)?;
            return (!value.is_empty()).then(|| value.to_string());
        }
        rest = &tag_and_rest[end..];
    }
    None
}

/// Fetch a connected devserver's workspace list (`GET /api/library/workspaces`
/// on gateway connections, `GET /api/devserver/workspaces` on raw connections).
pub async fn fetch_workspaces(conn: &DevserverConn) -> Result<Vec<DevserverWorkspaceRow>, String> {
    if conn.gateway.is_some() {
        let resp = gateway_get(conn, "/api/library/workspaces").await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let fallback = format!("HTTP {status}");
            return Err(format!(
                "gateway workspaces returned {}",
                refusal_message(status, &body, &fallback)
            ));
        }
        let entries = resp
            .json::<Vec<chan_server::LauncherWorkspace>>()
            .await
            .map_err(|e| format!("decoding gateway workspaces: {e}"))?;
        let mut rows = Vec::with_capacity(entries.len());
        for entry in entries {
            rows.push(row_from_launcher(conn, entry).await?);
        }
        return Ok(rows);
    }
    let url = format!(
        "{}/api/devserver/workspaces",
        base_origin(&conn.host, conn.port)
    );
    let resp = raw_devserver_request(
        conn,
        reqwest::Method::GET,
        &url,
        None::<&()>,
        None,
        "listing devserver workspaces",
    )
    .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let fallback = format!("HTTP {status}");
        return Err(format!(
            "devserver workspaces returned {}",
            refusal_message(status, &body, &fallback)
        ));
    }
    let entries = resp
        .json::<Vec<WorkspaceEntry>>()
        .await
        .map_err(|e| format!("decoding devserver workspaces: {e}"))?;
    entries
        .into_iter()
        .map(|e| row_from_entry(conn, e))
        .collect()
}

#[derive(Deserialize)]
struct LocalColorResponse {
    color: Option<String>,
}

/// `GET /api/library/local-color`: the devserver library's pane-highlight colour
/// (`#rrggbb`), or `None` for the default accent.
pub async fn fetch_local_color(conn: &DevserverConn) -> Result<Option<String>, String> {
    let label = PerArmLabel {
        gateway: "gateway colour",
        raw: "devserver colour",
    };
    let resp = devserver_request(
        conn,
        reqwest::Method::GET,
        "/api/library/local-color",
        None::<&()>,
        "fetching devserver colour",
    )
    .await?;
    if !resp.status().is_success() {
        return Err(devserver_status_error(conn, resp, label).await);
    }
    resp.json::<LocalColorResponse>()
        .await
        .map(|r| r.color)
        .map_err(|e| format!("decoding {}: {e}", label.for_conn(conn)))
}

fn row_from_entry(
    conn: &DevserverConn,
    e: WorkspaceEntry,
) -> Result<DevserverWorkspaceRow, String> {
    let url = if e.token.is_empty() {
        String::new()
    } else {
        assemble_tenant_url(&conn.host, conn.port, &e.prefix, &e.token)?
    };
    Ok(DevserverWorkspaceRow {
        prefix: e.prefix,
        path: e.path,
        label: e.label,
        on: e.on,
        status: e.status,
        error: e.error,
        url,
    })
}

async fn row_from_launcher(
    conn: &DevserverConn,
    e: chan_server::LauncherWorkspace,
) -> Result<DevserverWorkspaceRow, String> {
    let prefix = if e.prefix.is_empty() {
        e.workspace_id.clone()
    } else {
        e.prefix.clone()
    };
    let url = if e.on {
        format!(
            "{}/{prefix}/index.html",
            conn_base_origin(conn).trim_end_matches('/')
        )
    } else {
        String::new()
    };
    Ok(DevserverWorkspaceRow {
        prefix: format!("/{prefix}"),
        path: e.path,
        label: e.label,
        on: e.on,
        status: e.status,
        error: e.error,
        url,
    })
}

/// Per-connection tracking of decoded window rows so an unreadable row logs
/// once and preserves its last readable record rather than failing the whole
/// list decode.
#[derive(Default)]
pub(crate) struct ConnectionRows {
    logged: HashSet<String>,
    last_readable: HashMap<String, chan_server::WindowRecord>,
}

/// Decode a devserver's window rows one at a time, skipping unreadable rows so
/// an unknown tag on one row does not drop the remaining windows.
pub(crate) fn decode_window_rows(
    devserver_id: &str,
    source: &str,
    rows: Vec<serde_json::Value>,
    seen: &mut ConnectionRows,
) -> Vec<chan_server::WindowRecord> {
    let mut windows = Vec::with_capacity(rows.len());
    for (index, value) in rows.iter().enumerate() {
        let error = match chan_server::WindowRecord::deserialize(value) {
            Ok(record) => {
                seen.last_readable
                    .insert(record.window_id.clone(), record.clone());
                windows.push(record);
                continue;
            }
            Err(error) => error,
        };
        let Some(id) = value.get("window_id").and_then(serde_json::Value::as_str) else {
            tracing::warn!(
                devserver = %devserver_id,
                source = %source,
                row = %format!("index {index}"),
                %error,
                "unreadable devserver window row is hidden"
            );
            continue;
        };
        let first = seen.logged.insert(id.to_owned());
        let row = format!("window_id {id}");
        match seen.last_readable.get(id) {
            Some(last) => {
                windows.push(last.clone());
                if first {
                    tracing::warn!(
                        devserver = %devserver_id,
                        source = %source,
                        %row,
                        %error,
                        "devserver window row turned unreadable; keeping the stale record last read"
                    );
                }
            }
            None if first => tracing::warn!(
                devserver = %devserver_id,
                source = %source,
                %row,
                %error,
                "unreadable devserver window row is hidden"
            ),
            None => {}
        }
    }
    let carried: HashSet<&str> = windows.iter().map(|row| row.window_id.as_str()).collect();
    seen.last_readable
        .retain(|id, _| carried.contains(id.as_str()));
    windows
}

/// The window set a connected devserver serves at `GET /api/library/windows`.
pub async fn fetch_library_windows(
    devserver_id: &str,
    conn: &DevserverConn,
) -> Result<Vec<chan_server::WindowRecord>, String> {
    let label = PerArmLabel {
        gateway: "gateway library windows",
        raw: "library windows",
    };
    let resp = devserver_request(
        conn,
        reqwest::Method::GET,
        "/api/library/windows",
        None::<&()>,
        "listing library windows",
    )
    .await?;
    if !resp.status().is_success() {
        return Err(devserver_status_error(conn, resp, label).await);
    }
    let rows = resp
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| format!("decoding {}: {e}", label.for_conn(conn)))?;
    Ok(decode_window_rows(
        devserver_id,
        "list",
        rows,
        &mut ConnectionRows::default(),
    ))
}

/// Mint a window on a connected devserver's library (`POST /api/library/windows`).
#[cfg(test)]
pub async fn mint_library_window(
    conn: &DevserverConn,
    kind: chan_server::WindowKind,
    workspace_path: Option<String>,
) -> Result<chan_server::WindowRecord, String> {
    mint_library_window_with_start(conn, kind, workspace_path, false).await
}

pub async fn mint_library_window_with_start(
    conn: &DevserverConn,
    kind: chan_server::WindowKind,
    workspace_path: Option<String>,
    start_terminal: bool,
) -> Result<chan_server::WindowRecord, String> {
    let body = chan_server::CreateWindow {
        kind,
        workspace_path,
        // The client mints native windows on a connected devserver.
        origin: chan_server::WindowOrigin::Native,
        start_terminal,
        // The launcher is a legacy caller (the gate allows a missing acting
        // id); leadership is honest-client only.
        acting_window_id: None,
    };
    let status_label = PerArmLabel {
        gateway: "gateway library window mint",
        raw: "library window mint",
    };
    let decode_label = PerArmLabel {
        gateway: "minted gateway window",
        raw: "minted window",
    };
    let resp = devserver_request(
        conn,
        reqwest::Method::POST,
        "/api/library/windows",
        Some(&body),
        "minting library window",
    )
    .await?;
    if !resp.status().is_success() {
        return Err(devserver_status_error(conn, resp, status_label).await);
    }
    resp.json::<chan_server::WindowRecord>()
        .await
        .map_err(|e| format!("decoding {}: {e}", decode_label.for_conn(conn)))
}

/// Allow lifecycle requests to mount or drain a tenant (above the server's 60 s
/// mount timeout).
const REMOTE_SERVE_HTTP_BUDGET: Duration = Duration::from_secs(70);

fn workspace_delete_url(host: &str, port: u16, prefix: &str, force: bool) -> String {
    let mut url = format!(
        "{}/api/devserver/workspaces{}",
        base_origin(host, port),
        prefix
    );
    if force {
        url.push_str("?force=true");
    }
    url
}

/// Unmount and forget a workspace tenant on a connected devserver.
pub async fn forget_workspace(
    conn: &DevserverConn,
    prefix: &str,
    force: bool,
) -> Result<(), SetWorkspaceOnError> {
    if let Some(gw) = &conn.gateway {
        let clean = prefix.trim_start_matches('/');
        let mut path = format!("/api/library/workspaces/{clean}");
        if force {
            path.push_str("?force=true");
        }
        let resp = gateway_request(
            gw,
            reqwest::Method::DELETE,
            &path,
            None::<&()>,
            Some(REMOTE_SERVE_HTTP_BUDGET),
        )
        .await
        .map_err(SetWorkspaceOnError::other)?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err(refusal_from_conflict(resp).await);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let fallback = format!("HTTP {status}");
            return Err(SetWorkspaceOnError::other(format!(
                "gateway workspace delete returned {}",
                refusal_message(status, &body, &fallback)
            )));
        }
        return Ok(());
    }
    let url = workspace_delete_url(&conn.host, conn.port, prefix, force);
    let resp = raw_devserver_request(
        conn,
        reqwest::Method::DELETE,
        &url,
        None::<&()>,
        Some(REMOTE_SERVE_HTTP_BUDGET),
        "forgetting devserver workspace",
    )
    .await
    .map_err(SetWorkspaceOnError::other)?;
    if resp.status() == reqwest::StatusCode::CONFLICT {
        return Err(refusal_from_conflict(resp).await);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let fallback = format!("HTTP {status}");
        return Err(SetWorkspaceOnError::other(format!(
            "devserver workspace delete returned {}",
            refusal_message(status, &body, &fallback)
        )));
    }
    Ok(())
}

fn workspace_on_url(host: &str, port: u16, prefix: &str) -> String {
    format!(
        "{}/api/devserver/workspaces{}/on",
        base_origin(host, port),
        prefix
    )
}

/// Build the launcher-route toggle request for the gateway arm: `/on` takes no
/// body and `/off` sends `{force}`.
fn launcher_workspace_toggle_request(
    prefix: &str,
    on: bool,
    force: bool,
) -> (String, Option<serde_json::Value>) {
    let clean = prefix.trim_start_matches('/');
    if on {
        (format!("/api/library/workspaces/{clean}/on"), None)
    } else {
        (
            format!("/api/library/workspaces/{clean}/off"),
            Some(serde_json::json!({ "force": force })),
        )
    }
}

/// Mount (`on: true`) or unmount (`on: false`) a registered workspace without
/// forgetting it.
pub async fn set_workspace_on(
    conn: &DevserverConn,
    prefix: &str,
    on: bool,
    force: bool,
) -> Result<Option<DevserverWorkspaceRow>, SetWorkspaceOnError> {
    if let Some(gw) = &conn.gateway {
        let (path, body) = launcher_workspace_toggle_request(prefix, on, force);
        let resp = gateway_request(
            gw,
            reqwest::Method::POST,
            &path,
            body.as_ref(),
            Some(REMOTE_SERVE_HTTP_BUDGET),
        )
        .await
        .map_err(SetWorkspaceOnError::other)?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err(refusal_from_conflict(resp).await);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let fallback = format!("HTTP {status}");
            return Err(SetWorkspaceOnError::other(format!(
                "gateway workspace on/off returned {}",
                refusal_message(status, &body, &fallback)
            )));
        }
        if !on {
            return Ok(None);
        }
        if resp.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let Ok(entry) = resp.json::<chan_server::LauncherWorkspace>().await else {
            return Ok(None);
        };
        let row = row_from_launcher(conn, entry)
            .await
            .map_err(SetWorkspaceOnError::other)?;
        return Ok(Some(row));
    }
    let url = workspace_on_url(&conn.host, conn.port, prefix);
    let body = SetWorkspaceOnRequest { on, force };
    let resp = raw_devserver_request(
        conn,
        reqwest::Method::POST,
        &url,
        Some(&body),
        Some(REMOTE_SERVE_HTTP_BUDGET),
        "setting devserver workspace on/off",
    )
    .await
    .map_err(SetWorkspaceOnError::other)?;
    if resp.status() == reqwest::StatusCode::CONFLICT {
        return Err(refusal_from_conflict(resp).await);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let fallback = format!("HTTP {status}");
        return Err(SetWorkspaceOnError::other(format!(
            "devserver workspace on/off returned {}",
            refusal_message(status, &body, &fallback)
        )));
    }
    if !on {
        return Ok(None);
    }
    let entry = resp
        .json::<WorkspaceEntry>()
        .await
        .map_err(|e| SetWorkspaceOnError::other(format!("decoding devserver workspace on: {e}")))?;
    let row = row_from_entry(conn, entry).map_err(SetWorkspaceOnError::other)?;
    Ok(Some(row))
}

/// Every `tracing` line a test emits on its own thread, rendered by the same
/// `fmt` formatter the desktop logs through, so a test pins the line an
/// operator reads rather than a structure nobody sees.
#[cfg(test)]
pub(crate) mod log_capture {
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub(crate) struct Lines(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Lines {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Lines {
        type Writer = Lines;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// This thread's capture, installed until it drops.
    pub(crate) struct Installed {
        _default: tracing::subscriber::DefaultGuard,
        _registered: tracing::Dispatch,
    }

    impl Lines {
        /// Collect this thread's events until the guard drops. A
        /// `#[tokio::test]` runs on a current-thread runtime, so an async
        /// test's events stay on the thread that installed it.
        ///
        /// While at most one dispatcher is registered, tracing-core computes
        /// a callsite's interest from the default of whichever thread
        /// registers it first, so a test that reaches a callsite first on a
        /// thread with no capture caches it as never enabled for every
        /// thread. A second registered dispatcher, held as long as the
        /// capture, makes registration consult every registered dispatcher
        /// instead, and the rebuild after it corrects a callsite another
        /// thread published in the meantime.
        pub(crate) fn install(&self) -> Installed {
            let default = tracing::subscriber::set_default(
                tracing_subscriber::fmt()
                    .with_writer(self.clone())
                    .with_ansi(false)
                    .with_max_level(tracing::Level::INFO)
                    .finish(),
            );
            let registered = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
            tracing::callsite::rebuild_interest_cache();
            Installed {
                _default: default,
                _registered: registered,
            }
        }

        /// The captured `WARN` lines, in order.
        pub(crate) fn warnings(&self) -> Vec<String> {
            self.at(" WARN ")
        }

        /// The captured `INFO` lines, in order.
        pub(crate) fn infos(&self) -> Vec<String> {
            self.at(" INFO ")
        }

        /// Everything captured, every level.
        pub(crate) fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }

        fn at(&self, level: &str) -> Vec<String> {
            String::from_utf8_lossy(&self.0.lock().unwrap())
                .lines()
                .filter(|line| line.contains(level))
                .map(str::to_owned)
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_gateway_discovery() -> RawGatewayDiscovery {
        RawGatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "https://gw.chan.app".into(),
            mobile_authorize_url: Some("https://gw.chan.app/mobile/authorize".into()),
            mobile_entry_url: Some("https://gw.chan.app/mobile/v1/devserver/entry".into()),
            mobile_roster_url: Some("https://gw.chan.app/mobile/v1/devservers".into()),
            devserver_proxy_origin: "https://proxy.chan.app".into(),
            devserver_proxy_host_depth: 2,
            wireguard: None,
        }
    }

    #[test]
    fn gateway_discovery_accepts_same_origin_https() {
        let d = validate_gateway_discovery("https://gw.chan.app", valid_gateway_discovery())
            .expect("valid gateway discovery");
        assert_eq!(d.identity_origin, "https://gw.chan.app");
        assert_eq!(
            d.mobile_authorize_url,
            "https://gw.chan.app/mobile/authorize"
        );
        assert_eq!(
            d.mobile_entry_url,
            "https://gw.chan.app/mobile/v1/devserver/entry"
        );
        assert_eq!(
            d.mobile_roster_url,
            "https://gw.chan.app/mobile/v1/devservers"
        );
    }

    #[test]
    fn gateway_discovery_rejects_cross_origin_identity() {
        let mut d = valid_gateway_discovery();
        d.identity_origin = "https://evil.example".into();
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(err.contains("cross-origin"), "{err}");
    }

    #[test]
    fn gateway_discovery_rejects_cross_origin_entry_url() {
        let mut d = valid_gateway_discovery();
        d.mobile_entry_url = Some("https://evil.example/mobile/v1/devserver/entry".into());
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(err.contains("cross-origin"), "{err}");
    }

    #[test]
    fn gateway_discovery_rejects_http_for_non_loopback() {
        let mut d = valid_gateway_discovery();
        d.identity_origin = "http://gw.chan.app".into();
        d.mobile_authorize_url = Some("http://gw.chan.app/mobile/authorize".into());
        d.mobile_entry_url = Some("http://gw.chan.app/mobile/v1/devserver/entry".into());
        d.mobile_roster_url = Some("http://gw.chan.app/mobile/v1/devservers".into());
        d.devserver_proxy_origin = "http://proxy.chan.app".into();
        let err = validate_gateway_discovery("http://gw.chan.app", d).unwrap_err();
        assert!(err.contains("must use https"), "{err}");
    }

    #[test]
    fn gateway_discovery_allows_http_loopback_dev() {
        let d = RawGatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "http://localhost:7000".into(),
            mobile_authorize_url: Some("http://localhost:7000/mobile/authorize".into()),
            mobile_entry_url: Some("http://localhost:7000/mobile/v1/devserver/entry".into()),
            mobile_roster_url: Some("http://localhost:7000/mobile/v1/devservers".into()),
            devserver_proxy_origin: "http://127.0.0.1:7002".into(),
            devserver_proxy_host_depth: 2,
            wireguard: None,
        };
        validate_gateway_discovery("http://localhost:7000", d)
            .expect("loopback http is explicit dev use");
    }

    #[test]
    fn https_waiver_requires_a_parsed_loopback_ip_not_a_name_prefix() {
        // A public DNS name that merely LOOKS like a loopback literal
        // must not unlock the cleartext waiver.
        for raw in [
            "http://127.example.com",
            "http://127.0.0.1.example.com",
            "http://1270.0.0.1",
        ] {
            require_https_unless_loopback(raw).unwrap_err();
        }
        for raw in [
            "http://127.0.0.1:7000",
            "http://127.1.2.3",
            "http://[::1]:7000",
        ] {
            require_https_unless_loopback(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
        }
    }

    fn gateway_entry_response(proxy_origin: &str, exchange_url: &str) -> GatewayEntryResponse {
        GatewayEntryResponse {
            owner_user_id: test_owner_id(),
            username: "alice".into(),
            devserver_id: "a".repeat(64),
            proxy_origin: proxy_origin.into(),
            entry_exchange_url: exchange_url.into(),
            entry_credential: "entry-credential".into(),
        }
    }

    fn test_owner_id() -> uuid::Uuid {
        uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap()
    }

    fn test_entry_target() -> GatewayEntryTarget {
        GatewayEntryTarget {
            owner_user_id: test_owner_id(),
            owner: "alice".into(),
            devserver_id: "a".repeat(64),
        }
    }

    #[test]
    fn credential_bearing_debug_output_is_redacted() {
        let response = GatewayEntryResponse {
            owner_user_id: test_owner_id(),
            username: "alice".into(),
            devserver_id: "a".repeat(64),
            proxy_origin: "https://alice--aaaaaaaaaaaa.p1.proxy.chan.app".into(),
            entry_exchange_url: "https://alice--aaaaaaaaaaaa.p1.proxy.chan.app/_chan/entry".into(),
            entry_credential: "sentinel-entry-credential".into(),
        };
        let gw = GatewayConn::new(
            "https://gw.chan.app".into(),
            "https://gw.chan.app/mobile/v1/devserver/entry".into(),
            "https://alice--aaaaaaaaaaaa.p1.proxy.chan.app".into(),
            "sentinel-gateway-pat".into(),
        );
        *gw.session.lock().unwrap() = Some(GatewaySession {
            gate: "sentinel-gate-cookie".into(),
            cookie_header: "sentinel-cookie-header".into(),
            csrf: "sentinel-csrf".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
        });
        let conn = DevserverConn {
            host: "example.test".into(),
            port: 443,
            token: "sentinel-devserver-token".into(),
            name: "test".into(),
            gateway: Some(Box::new(gw)),
        };
        let debug = format!("{response:?} {conn:?}");
        for secret in [
            "sentinel-entry-credential",
            "sentinel-gateway-pat",
            "sentinel-gate-cookie",
            "sentinel-cookie-header",
            "sentinel-csrf",
            "sentinel-devserver-token",
        ] {
            assert!(!debug.contains(secret), "Debug leaked {secret}");
        }
        assert!(debug.contains("[REDACTED]"));
    }

    fn validate_test_entry(
        proxy_origin: &str,
        exchange_url: &str,
    ) -> Result<ValidatedGatewayEntry, String> {
        validate_gateway_entry(
            "https://proxy.example.test",
            Some(&test_entry_target()),
            "/notes/index.html",
            None,
            gateway_entry_response(proxy_origin, exchange_url),
        )
    }

    #[test]
    fn gateway_entry_accepts_exact_two_label_host() {
        let origin = "https://alice--aaaaaaaaaaaa.p1.proxy.example.test";
        let entry = validate_test_entry(origin, &format!("{origin}/_chan/entry"))
            .expect("two-label entry origin validates");
        assert_eq!(entry.proxy_origin, origin);
        let canonical = validate_test_entry(
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test:443",
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test:443/_chan/entry",
        )
        .unwrap();
        assert_eq!(
            canonical.proxy_origin,
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test"
        );
    }

    #[test]
    fn gateway_entry_binds_full_requested_identity() {
        let mut response = gateway_entry_response(
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test",
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test/_chan/entry",
        );
        response.owner_user_id = uuid::Uuid::new_v4();
        assert!(validate_gateway_entry(
            "https://proxy.example.test",
            Some(&test_entry_target()),
            "/notes/index.html",
            None,
            response,
        )
        .unwrap_err()
        .contains("owner id mismatch"));

        let mut response = gateway_entry_response(
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test",
            "https://alice--aaaaaaaaaaaa.p1.proxy.example.test/_chan/entry",
        );
        response.devserver_id = format!("{}b", "a".repeat(63));
        assert!(validate_gateway_entry(
            "https://proxy.example.test",
            Some(&test_entry_target()),
            "/notes/index.html",
            None,
            response,
        )
        .unwrap_err()
        .contains("devserver id mismatch"));
    }

    #[test]
    fn gateway_entry_rejects_namespace_and_exchange_endpoint_escapes() {
        for proxy in [
            "",
            "not a url",
            "ftp://alice.p1.proxy.example.test",
            "http://alice.p1.proxy.example.test",
            "https://user@alice.p1.proxy.example.test",
            "https://alice.p1.proxy.example.test/path",
            "https://alice.p1.proxy.example.test/?q=1",
            "https://alice.p1.proxy.example.test/#frag",
            "https://proxy.example.test",
            "https://alice.proxy.example.test",
            "https://nested.alice.p1.proxy.example.test",
            "https://alice.p1.proxy.example.test.evil.example",
            "https://alice.p1.proxy.example.test:444",
        ] {
            assert!(
                validate_test_entry(proxy, "https://alice.p1.proxy.example.test/_chan/entry")
                    .is_err(),
                "proxy escape accepted: {proxy}"
            );
        }
        for exchange_url in [
            "https://bob.p1.proxy.example.test/_chan/entry",
            "http://alice.p1.proxy.example.test/_chan/entry",
            "https://alice.p1.proxy.example.test:444/_chan/entry",
            "https://user@alice.p1.proxy.example.test/_chan/entry",
            "https://alice.p1.proxy.example.test/other",
            "https://alice.p1.proxy.example.test/_chan/entry?q=credential",
            "https://alice.p1.proxy.example.test/_chan/entry#fragment",
        ] {
            assert!(
                validate_test_entry("https://alice.p1.proxy.example.test", exchange_url).is_err(),
                "entry exchange escape accepted: {exchange_url}"
            );
        }
    }

    #[test]
    fn gateway_entry_refresh_cannot_change_the_pinned_origin() {
        let response = gateway_entry_response(
            "https://alice--aaaaaaaaaaaa.p2.proxy.example.test",
            "https://alice--aaaaaaaaaaaa.p2.proxy.example.test/_chan/entry",
        );
        let err = validate_gateway_entry(
            "https://proxy.example.test",
            Some(&test_entry_target()),
            "/notes/index.html",
            Some("https://alice--aaaaaaaaaaaa.p1.proxy.example.test"),
            response,
        )
        .unwrap_err();
        assert!(err.contains("pinned proxy origin"), "{err}");
    }

    #[tokio::test]
    async fn a_failed_discovery_names_the_cause_of_its_transport_error() {
        let sink = chan_tls::testing::Sink::start();
        let Err(GatewayDiscoveryError::Transport(error)) =
            discover_gateway(&format!("https://{}", sink.addr)).await
        else {
            panic!("the sink never answers");
        };
        assert!(
            error.starts_with("checking chan-gateway discovery: error sending request: "),
            "{error}"
        );
        assert!(error.contains("client error (Connect)"), "{error}");
    }

    #[tokio::test]
    async fn gateway_conn_validates_entry_origin_before_any_entry_get() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let sink_hits = Arc::new(AtomicUsize::new(0));
        let sink_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sink_origin = format!("http://{}", sink_listener.local_addr().unwrap());
        let sink_hits_for_route = Arc::clone(&sink_hits);
        let sink = axum::Router::new().route(
            "/stolen",
            axum::routing::get(move || {
                let hits = Arc::clone(&sink_hits_for_route);
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "should not be requested"
                }
            }),
        );
        let sink_server = tokio::spawn(async move {
            axum::serve(sink_listener, sink).await.unwrap();
        });

        let entry_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let entry_addr = entry_listener.local_addr().unwrap();
        let identity_origin = format!("http://{entry_addr}");
        let proxy_apex = format!("http://localtest.me:{}", entry_addr.port());
        let proxy_origin = format!(
            "http://alice--aaaaaaaaaaaa.p1.localtest.me:{}",
            entry_addr.port()
        );
        let response_proxy = proxy_origin.clone();
        let malicious_entry = format!("{sink_origin}/stolen");
        let entry = axum::Router::new().route(
            "/mobile/v1/devserver/entry",
            axum::routing::post(move || {
                let proxy_origin = response_proxy.clone();
                let entry_url = malicious_entry.clone();
                async move {
                    axum::Json(serde_json::json!({
                        "owner_user_id": test_owner_id(),
                        "username": "alice",
                        "devserver_id": "a".repeat(64),
                        "proxy_origin": proxy_origin,
                        "entry_exchange_url": entry_url,
                        "entry_credential": "never-send-me",
                    }))
                }
            }),
        );
        let entry_server = tokio::spawn(async move {
            axum::serve(entry_listener, entry).await.unwrap();
        });

        let discovery = GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: identity_origin.clone(),
            mobile_authorize_url: format!("{identity_origin}/mobile/authorize"),
            mobile_entry_url: format!("{identity_origin}/mobile/v1/devserver/entry"),
            mobile_roster_url: format!("{identity_origin}/mobile/v1/devservers"),
            devserver_proxy_origin: proxy_apex,
            devserver_proxy_host_depth: 2,
            wireguard: None,
        };
        let err = gateway_conn(&discovery, "pat".into(), Some(test_entry_target()))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("entry_exchange_url origin does not match"),
            "{err}"
        );
        assert_eq!(
            sink_hits.load(Ordering::SeqCst),
            0,
            "a rejected cross-origin entry URL must receive no HTTP request"
        );

        entry_server.abort();
        sink_server.abort();
    }

    #[tokio::test]
    async fn gateway_conn_posts_credential_with_exact_identity_origin() {
        use axum::body::Bytes;
        use axum::http::{HeaderMap, StatusCode};
        use std::sync::atomic::{AtomicBool, Ordering};

        let exchange_seen = Arc::new(Mutex::new(None::<(HeaderMap, Bytes)>));
        let entry_seen = Arc::new(AtomicBool::new(false));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let identity_origin = format!("http://{addr}");
        let proxy_apex = format!("http://localtest.me:{}", addr.port());
        let proxy_origin = format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{}", addr.port());
        let response_proxy = proxy_origin.clone();
        let entry_seen_route = Arc::clone(&entry_seen);
        let exchange_seen_route = Arc::clone(&exchange_seen);
        let app = axum::Router::new()
            .route(
                "/mobile/v1/devserver/entry",
                axum::routing::post(move || {
                    let proxy_origin = response_proxy.clone();
                    let entry_seen = Arc::clone(&entry_seen_route);
                    async move {
                        entry_seen.store(true, Ordering::SeqCst);
                        axum::Json(serde_json::json!({
                            "owner_user_id": test_owner_id(),
                            "username": "alice",
                            "devserver_id": "a".repeat(64),
                            "proxy_origin": proxy_origin,
                            "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                            "entry_credential": "sentinel-entry-secret",
                        }))
                    }
                }),
            )
            .route(
                "/_chan/entry",
                axum::routing::post(move |headers: HeaderMap, body: Bytes| {
                    let exchange_seen = Arc::clone(&exchange_seen_route);
                    async move {
                        *exchange_seen.lock().unwrap() = Some((headers, body));
                        axum::response::Response::builder()
                            .status(StatusCode::SEE_OTHER)
                            .header("location", "/")
                            .header(
                                "set-cookie",
                                "__Host-devserver_gate=opaque; Path=/; HttpOnly",
                            )
                            .header("set-cookie", "__Host-devserver_csrf=csrf; Path=/")
                            .body(axum::body::Body::empty())
                            .unwrap()
                    }
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let discovery = GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: identity_origin.clone(),
            mobile_authorize_url: format!("{identity_origin}/mobile/authorize"),
            mobile_entry_url: format!("{identity_origin}/mobile/v1/devserver/entry"),
            mobile_roster_url: format!("{identity_origin}/mobile/v1/devservers"),
            devserver_proxy_origin: proxy_apex,
            devserver_proxy_host_depth: 2,
            wireguard: None,
        };

        let gw = gateway_conn(&discovery, "pat".into(), Some(test_entry_target()))
            .await
            .expect("native POST exchange succeeds");
        assert!(entry_seen.load(Ordering::SeqCst));
        assert!(gw.session.lock().unwrap().is_some());
        let (headers, body) = exchange_seen
            .lock()
            .unwrap()
            .clone()
            .expect("exchange request");
        assert_eq!(headers.get("origin").unwrap(), identity_origin.as_str());
        assert_eq!(
            headers.get("content-type").unwrap(),
            "application/x-www-form-urlencoded"
        );
        let fields: Vec<_> = url::form_urlencoded::parse(&body).collect();
        assert_eq!(
            fields,
            vec![(
                std::borrow::Cow::Borrowed("credential"),
                std::borrow::Cow::Borrowed("sentinel-entry-secret")
            )]
        );
        assert!(!proxy_origin.contains("sentinel-entry-secret"));
        server.abort();
    }

    #[test]
    fn gateway_discovery_rejects_pre_mobile_or_blank_mobile_urls() {
        // A pre-mobile gateway advertises only desktop endpoints: serde
        // accepts and ignores those fields, and validation fails cleanly with
        // the dedicated mobile-unsupported message.
        let desktop_only: RawGatewayDiscovery = serde_json::from_str(
            r#"{
                "kind": "chan-gateway",
                "api_version": 1,
                "identity_origin": "https://gw.chan.app",
                "desktop_authorize_url": "https://gw.chan.app/desktop/authorize",
                "desktop_entry_url": "https://gw.chan.app/desktop/v1/devserver/entry",
                "roster_url": "https://gw.chan.app/desktop/v1/devservers",
                "devserver_proxy_origin": "https://proxy.chan.app",
                "devserver_proxy_host_depth": 2,
                "tunnel_url": "https://proxy.chan.app/v1/tunnel"
            }"#,
        )
        .expect("desktop-only discovery decodes into raw wire struct");
        let err = validate_gateway_discovery("https://gw.chan.app", desktop_only)
            .expect_err("pre-mobile gateway must be rejected");
        assert!(
            err.contains("this gateway does not support mobile sign-in"),
            "{err}"
        );

        // When a gateway serves both desktop and mobile fields, desktop fields
        // are ignored and mobile fields populate GatewayDiscovery.
        let both: RawGatewayDiscovery = serde_json::from_str(
            r#"{
                "kind": "chan-gateway",
                "api_version": 1,
                "identity_origin": "https://gw.chan.app",
                "desktop_authorize_url": "https://gw.chan.app/desktop/authorize",
                "desktop_entry_url": "https://gw.chan.app/desktop/v1/devserver/entry",
                "roster_url": "https://gw.chan.app/desktop/v1/devservers",
                "mobile_authorize_url": "https://gw.chan.app/mobile/authorize",
                "mobile_entry_url": "https://gw.chan.app/mobile/v1/devserver/entry",
                "mobile_roster_url": "https://gw.chan.app/mobile/v1/devservers",
                "devserver_proxy_origin": "https://proxy.chan.app",
                "devserver_proxy_host_depth": 2,
                "tunnel_url": "https://proxy.chan.app/v1/tunnel"
            }"#,
        )
        .expect("combined discovery decodes into raw wire struct");
        let validated =
            validate_gateway_discovery("https://gw.chan.app", both).expect("combined discovery");
        assert_eq!(
            validated.mobile_authorize_url,
            "https://gw.chan.app/mobile/authorize"
        );
        assert_eq!(
            validated.mobile_entry_url,
            "https://gw.chan.app/mobile/v1/devserver/entry"
        );
        assert_eq!(
            validated.mobile_roster_url,
            "https://gw.chan.app/mobile/v1/devservers"
        );

        for missing in [None, Some(String::new()), Some("   \t\n ".to_string())] {
            let mut d = valid_gateway_discovery();
            d.mobile_authorize_url = missing.clone();
            let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
            assert!(
                err.contains("this gateway does not support mobile sign-in"),
                "authorize={missing:?}: {err}"
            );

            let mut d = valid_gateway_discovery();
            d.mobile_entry_url = missing.clone();
            let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
            assert!(
                err.contains("this gateway does not support mobile sign-in"),
                "entry={missing:?}: {err}"
            );

            let mut d = valid_gateway_discovery();
            d.mobile_roster_url = missing.clone();
            let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
            assert!(
                err.contains("this gateway does not support mobile sign-in"),
                "roster={missing:?}: {err}"
            );
        }
    }

    /// A discovery document as identity serves it, with `wireguard` spliced
    /// in when given.
    fn discovery_document(wireguard: Option<&str>) -> String {
        let extra = wireguard
            .map(|entry| format!(",\"wireguard\":{entry}"))
            .unwrap_or_default();
        format!(
            "{{\"kind\":\"chan-gateway\",\"api_version\":1,\
             \"identity_origin\":\"https://gw.chan.app\",\
             \"mobile_authorize_url\":\"https://gw.chan.app/mobile/authorize\",\
             \"mobile_entry_url\":\"https://gw.chan.app/mobile/v1/devserver/entry\",\
             \"mobile_roster_url\":\"https://gw.chan.app/mobile/v1/devservers\",\
             \"devserver_proxy_origin\":\"https://proxy.chan.app\",\
             \"devserver_proxy_host_depth\":2,\
             \"tunnel_url\":\"https://proxy.chan.app/v1/tunnel\"{extra}}}"
        )
    }

    const WG_SERVER_KEY: &str = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

    #[test]
    fn gateway_discovery_reads_the_wireguard_entry() {
        let entry =
            format!("{{\"endpoint\":\"wg.chan.app:51820\",\"public_key\":\"{WG_SERVER_KEY}\"}}");
        let d: RawGatewayDiscovery =
            serde_json::from_str(&discovery_document(Some(&entry))).unwrap();
        let d = validate_gateway_discovery("https://gw.chan.app", d).expect("a good entry");
        assert_eq!(
            d.wireguard,
            Some(WireguardDiscovery {
                mobile_enrollment: false,
                allowed_ips: None,
                persistent_keepalive: None,
                ingresses: None,
                endpoint: "wg.chan.app:51820".into(),
                public_key: WG_SERVER_KEY.into(),
            })
        );
        // A bracketed IPv6 endpoint is the file's grammar too.
        let mut d = valid_gateway_discovery();
        d.wireguard = Some(WireguardDiscovery {
            mobile_enrollment: false,
            allowed_ips: None,
            persistent_keepalive: None,
            ingresses: None,
            endpoint: "[2001:db8::7]:51820".into(),
            public_key: WG_SERVER_KEY.into(),
        });
        validate_gateway_discovery("https://gw.chan.app", d).expect("an IPv6 endpoint");
    }

    #[test]
    fn gateway_discovery_requires_the_first_ingress_to_match_the_single_peer() {
        let mut discovery: WireguardDiscovery = serde_json::from_value(serde_json::json!({
            "endpoint": "p1.proxy.chan.app:51820", "public_key": WG_SERVER_KEY,
            "allowed_ips": ["10.7.0.1/32"],
            "ingresses": [{"id": "p1", "endpoint": "p1.proxy.chan.app:51820",
                "public_key": WG_SERVER_KEY, "hosts": []}]
        }))
        .unwrap();
        discovery.validate().unwrap();
        discovery.endpoint = "p1.proxy.chan.app:51821".into();
        assert!(discovery.validate().is_err(), "single endpoint must match");
        discovery.endpoint = "p1.proxy.chan.app:51820".into();
        discovery.public_key = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=".into();
        assert!(discovery.validate().is_err(), "single key must match");
    }

    #[test]
    fn gateway_discovery_rejects_invalid_ingresses_and_routing_policy() {
        let good = serde_json::json!({
            "endpoint": "p1.proxy.chan.app:51820", "public_key": WG_SERVER_KEY,
            "allowed_ips": ["10.7.0.1/32"], "persistent_keepalive": 25,
            "ingresses": [
                {"id": "p1", "endpoint": "p1.proxy.chan.app:51820", "public_key": WG_SERVER_KEY,
                 "hosts": [{"name": "*.p1.proxy.chan.app", "addresses": ["10.7.0.1"]}]},
                {"id": "p2", "endpoint": "[2001:db8::2]:51820", "public_key": WG_SERVER_KEY,
                 "hosts": [{"name": "*.p2.proxy.chan.app", "addresses": ["10.7.0.1"]}]}
            ]
        });
        let parse = |wireguard: &serde_json::Value| {
            let d =
                serde_json::from_str(&discovery_document(Some(&wireguard.to_string()))).unwrap();
            validate_gateway_discovery("https://gw.chan.app", d)
        };
        parse(&good).expect("two valid ingresses");
        for (pointer, value) in [
            ("/ingresses/1/id", serde_json::json!("p1")),
            ("/ingresses/1/id", serde_json::json!("UPPER")),
            ("/ingresses/1/public_key", serde_json::json!("bad")),
            ("/ingresses/1/endpoint", serde_json::json!("host:+1")),
            ("/ingresses/1/endpoint", serde_json::json!("[not-ipv6]:1")),
            ("/ingresses/1/hosts/0/name", serde_json::json!("bad/name")),
            (
                "/ingresses/1/hosts/0/addresses",
                serde_json::json!(["10.8.0.1"]),
            ),
            ("/ingresses/1/hosts/0/addresses", serde_json::json!([])),
            ("/ingresses", serde_json::json!([])),
            ("/allowed_ips", serde_json::json!([])),
            ("/allowed_ips", serde_json::Value::Null),
            ("/persistent_keepalive", serde_json::json!(0)),
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert!(parse(&bad).is_err(), "accepted invalid {pointer}: {bad}");
        }
    }

    #[test]
    fn gateway_discovery_tolerates_absent_wireguard() {
        // An older gateway, or one that enrolls no peers, omits the key; the
        // document still validates and the app sends no key.
        let d: RawGatewayDiscovery = serde_json::from_str(&discovery_document(None)).unwrap();
        assert_eq!(d.wireguard, None);
        validate_gateway_discovery("https://gw.chan.app", d).expect("absent wireguard is valid");
    }

    #[test]
    fn gateway_discovery_rejects_a_bad_wireguard_entry() {
        for (endpoint, public_key) in [
            ("wg.chan.app", WG_SERVER_KEY),
            ("wg.chan.app:0", WG_SERVER_KEY),
            ("wg.chan.app:51820", &WG_SERVER_KEY[..43]),
            (
                "wg.chan.app:51820",
                "not base64 at all, but forty-four chars long",
            ),
        ] {
            let mut d = valid_gateway_discovery();
            d.wireguard = Some(WireguardDiscovery {
                mobile_enrollment: false,
                allowed_ips: None,
                persistent_keepalive: None,
                ingresses: None,
                endpoint: endpoint.into(),
                public_key: public_key.into(),
            });
            let err = validate_gateway_discovery("https://gw.chan.app", d)
                .expect_err("a bad entry is refused");
            assert_eq!(
                err, "chan-gateway discovery has an invalid wireguard entry",
                "{endpoint} {public_key}"
            );
        }
    }

    #[test]
    fn gateway_discovery_rejects_cross_origin_or_http_mobile_urls() {
        let mut d = valid_gateway_discovery();
        d.mobile_authorize_url = Some("https://evil.example/mobile/authorize".into());
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(err.contains("cross-origin"), "{err}");

        let mut d = valid_gateway_discovery();
        d.mobile_roster_url = Some("https://evil.example/mobile/v1/devservers".into());
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(err.contains("cross-origin"), "{err}");

        // Same host over plain http has a different origin from https://gw.chan.app;
        // when configured_url is also http on non-loopback, require_https_unless_loopback
        // rejects each mobile URL individually too.
        for mutate in [
            |d: &mut RawGatewayDiscovery| {
                d.mobile_authorize_url = Some("http://gw.chan.app/mobile/authorize".into());
            },
            |d: &mut RawGatewayDiscovery| {
                d.mobile_entry_url = Some("http://gw.chan.app/mobile/v1/devserver/entry".into());
            },
            |d: &mut RawGatewayDiscovery| {
                d.mobile_roster_url = Some("http://gw.chan.app/mobile/v1/devservers".into());
            },
        ] {
            let mut d = valid_gateway_discovery();
            mutate(&mut d);
            let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
            assert!(
                err.contains("cross-origin") || err.contains("must use https"),
                "{err}"
            );
        }
    }

    #[test]
    fn entry_request_carries_target_only_when_given() {
        // No explicit target: the wire body stays exactly `{"path":...}`
        // so an older gateway parses it unchanged.
        let bare = serde_json::to_value(GatewayEntryRequest {
            path: "/",
            owner: None,
            owner_user_id: None,
            devserver_id: None,
        })
        .unwrap();
        assert_eq!(bare, serde_json::json!({"path": "/"}));

        // An explicit target rides as the optional owner + devserver_id
        // fields the gateway resolves the devserver from.
        let targeted = serde_json::to_value(GatewayEntryRequest {
            path: "/",
            owner: Some("alice"),
            owner_user_id: Some(test_owner_id()),
            devserver_id: Some("abc123"),
        })
        .unwrap();
        assert_eq!(
            targeted,
            serde_json::json!({
                "path": "/",
                "owner": "alice",
                "owner_user_id": test_owner_id(),
                "devserver_id": "abc123"
            })
        );
    }

    #[test]
    fn entry_error_classifies_the_reason_tokens() {
        // 401 is authorization regardless of body: the PAT is invalid/revoked
        // and the connect flow self-heals into re-sign-in.
        assert_eq!(
            classify_entry_error(reqwest::StatusCode::UNAUTHORIZED, b"{}"),
            GatewayEntryError::Unauthorized
        );
        // The three reason tokens of the entry 404 body.
        assert_eq!(
            classify_entry_error(
                reqwest::StatusCode::NOT_FOUND,
                br#"{"error":"not found","reason":"no_devserver","username":"alice"}"#,
            ),
            GatewayEntryError::NoDevserver {
                username: Some("alice".into())
            }
        );
        assert_eq!(
            classify_entry_error(
                reqwest::StatusCode::NOT_FOUND,
                br#"{"error":"not found","reason":"devserver_offline","username":"alice","label":"lab box"}"#,
            ),
            GatewayEntryError::DevserverOffline {
                username: Some("alice".into()),
                label: Some("lab box".into()),
            }
        );
        assert_eq!(
            classify_entry_error(
                reqwest::StatusCode::NOT_FOUND,
                br#"{"error":"not found","reason":"access_denied","username":"alice"}"#,
            ),
            GatewayEntryError::AccessDenied
        );
        // `label` is omitted (not null) when unknown; absent and null both
        // read None.
        assert_eq!(
            classify_entry_error(
                reqwest::StatusCode::NOT_FOUND,
                br#"{"error":"not found","reason":"devserver_offline","username":"alice"}"#,
            ),
            GatewayEntryError::DevserverOffline {
                username: Some("alice".into()),
                label: None,
            }
        );
    }

    #[test]
    fn entry_error_falls_back_to_the_generic_status_string() {
        // An old gateway (or the endpoint's best-effort degrade on profile
        // hiccups) sends the plain error body with no reason: keep the
        // generic HTTP-status string, exactly the pre-taxonomy behavior.
        let plain =
            classify_entry_error(reqwest::StatusCode::NOT_FOUND, br#"{"error":"not found"}"#);
        assert_eq!(
            plain,
            GatewayEntryError::Other("gateway entry returned HTTP 404 Not Found".into())
        );
        // Unknown reason token: same fallback (forward skew).
        assert_eq!(
            classify_entry_error(
                reqwest::StatusCode::NOT_FOUND,
                br#"{"error":"not found","reason":"quota_exceeded"}"#,
            ),
            GatewayEntryError::Other("gateway entry returned HTTP 404 Not Found".into())
        );
        // Non-JSON body (a proxy error page): fallback, never a parse error.
        assert_eq!(
            classify_entry_error(
                reqwest::StatusCode::BAD_GATEWAY,
                b"<html>bad gateway</html>"
            ),
            GatewayEntryError::Other("gateway entry returned HTTP 502 Bad Gateway".into())
        );
    }

    #[test]
    fn entry_error_display_carries_the_connect_banner_strings() {
        // These strings are the launcher's failure narration (a de-facto UX
        // contract, like the reason tokens themselves); pin them.
        assert_eq!(
            GatewayEntryError::NoDevserver {
                username: Some("alice".into())
            }
            .to_string(),
            "signed in as alice, but no devserver is registered; \
             run chan on your machine and connect it to the gateway"
        );
        assert_eq!(
            GatewayEntryError::NoDevserver { username: None }.to_string(),
            "signed in, but no devserver is registered; \
             run chan on your machine and connect it to the gateway"
        );
        assert_eq!(
            GatewayEntryError::DevserverOffline {
                username: Some("alice".into()),
                label: Some("lab box".into()),
            }
            .to_string(),
            "devserver \"lab box\" is registered but not currently connected"
        );
        assert_eq!(
            GatewayEntryError::DevserverOffline {
                username: None,
                label: None,
            }
            .to_string(),
            "your devserver is registered but not currently connected"
        );
        assert_eq!(
            GatewayEntryError::AccessDenied.to_string(),
            "the gateway denied access to this devserver"
        );
        assert_eq!(
            GatewayEntryError::Other("gateway entry returned HTTP 500".into()).to_string(),
            "gateway entry returned HTTP 500"
        );
    }

    #[test]
    fn assemble_tenant_url_uses_host_port_prefix_token() {
        let url = assemble_tenant_url("127.0.0.1", 8787, "/api/notes-1a2b3c", "tok_abc").unwrap();
        assert_eq!(
            url,
            "http://127.0.0.1:8787/api/notes-1a2b3c/index.html?t=tok_abc"
        );
    }

    #[test]
    fn assemble_tenant_url_trims_a_trailing_slash_on_the_prefix() {
        let url = assemble_tenant_url("10.0.0.5", 9000, "/api/a-0000/", "t").unwrap();
        assert_eq!(url, "http://10.0.0.5:9000/api/a-0000/index.html?t=t");
    }

    #[test]
    fn assemble_tenant_url_percent_encodes_the_token() {
        let url = assemble_tenant_url("127.0.0.1", 8787, "/api/x-1", "a b&c").unwrap();
        assert!(url.ends_with("/api/x-1/index.html?t=a+b%26c"), "{url}");
    }

    #[test]
    fn window_entry_path_normalizes_to_one_leading_slash() {
        // WindowRecord.prefix is absolute (`/api/notes-1a2b3c`); identity's
        // entry-path validator rejects "" / non-"/"-leading / "//"-leading /
        // "://"-containing paths, so both prefix shapes must land on exactly
        // one leading slash.
        assert_eq!(window_entry_path("/api/x"), "/api/x/index.html");
        assert_eq!(window_entry_path("api/x"), "/api/x/index.html");
        for p in ["/api/x", "api/x", "//api/x"] {
            assert!(!window_entry_path(p).starts_with("//"), "{p}");
        }
    }

    fn gateway_test_conn(entry_url: String) -> DevserverConn {
        let parsed = url::Url::parse(&entry_url).unwrap();
        let identity_origin = parsed.origin().ascii_serialization();
        let port = parsed.port_or_known_default().unwrap();
        let (proxy_origin, proxy_apex_origin) =
            if parsed.host_str().is_some_and(is_loopback_gateway_host) {
                (
                    format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{port}"),
                    format!("http://localtest.me:{port}"),
                )
            } else {
                (
                    "https://alice--aaaaaaaaaaaa.p1.proxy.chan.app".into(),
                    "https://proxy.chan.app".into(),
                )
            };
        let mut gateway = GatewayConn::new(
            identity_origin,
            entry_url,
            proxy_origin.clone(),
            "pat".into(),
        )
        .with_entry_target(Some(test_entry_target()));
        gateway.proxy_apex_origin = proxy_apex_origin;
        gateway.proxy_origin = proxy_origin.clone();
        DevserverConn {
            host: url::Url::parse(&proxy_origin)
                .unwrap()
                .host_str()
                .unwrap()
                .into(),
            port,
            token: String::new(),
            name: "alice".into(),
            gateway: Some(Box::new(gateway)),
        }
    }

    fn window_row(window_id: &str, prefix: &str, token: &str) -> chan_server::WindowRecord {
        chan_server::WindowRecord {
            window_id: window_id.into(),
            library_id: "lib-1".into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: prefix.into(),
            token: token.into(),
            persisted: true,
            connected: false,
            holders: None,
            active_transfer: false,
            control: false,
            tmux: None,
            hidden: false,
            origin: chan_server::WindowOrigin::default(),
            start_terminal: false,
        }
    }

    struct MockManagementRequest {
        method: axum::http::Method,
        path: String,
        headers: axum::http::HeaderMap,
        body: axum::body::Bytes,
    }

    struct MockManagementServer {
        addr: std::net::SocketAddr,
        requests: Arc<Mutex<Vec<MockManagementRequest>>>,
        responses: Arc<Mutex<std::collections::VecDeque<(axum::http::StatusCode, String)>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl MockManagementServer {
        async fn start(responses: Vec<(axum::http::StatusCode, String)>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let queued = Arc::new(Mutex::new(std::collections::VecDeque::from(responses)));
            let requests_for_route = Arc::clone(&requests);
            let queued_for_route = Arc::clone(&queued);
            let proxy_origin =
                format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{}", addr.port());
            let proxy_for_entry = proxy_origin.clone();
            let exchange_for_entry = format!("{proxy_origin}/_chan/entry");
            let app = axum::Router::new()
                .route(
                    "/mobile/v1/devserver/entry",
                    axum::routing::post(move || {
                        let proxy_origin = proxy_for_entry.clone();
                        let exchange_url = exchange_for_entry.clone();
                        async move {
                            axum::Json(serde_json::json!({
                                "owner_user_id": test_owner_id(),
                                "username": "alice",
                                "devserver_id": "a".repeat(64),
                                "proxy_origin": proxy_origin,
                                "entry_exchange_url": exchange_url,
                                "entry_credential": "refreshed-entry",
                            }))
                        }
                    }),
                )
                .route(
                    "/_chan/entry",
                    axum::routing::post(|| async {
                        axum::response::Response::builder()
                            .status(axum::http::StatusCode::SEE_OTHER)
                            .header("location", "/")
                            .header(
                                "set-cookie",
                                "__Host-devserver_gate=refreshed-gate; Path=/; HttpOnly; Max-Age=120",
                            )
                            .header(
                                "set-cookie",
                                "__Host-devserver_csrf=refreshed-csrf; Path=/; Max-Age=120",
                            )
                            .body(axum::body::Body::empty())
                            .unwrap()
                    }),
                )
                .fallback(axum::routing::any(
                    move |method: axum::http::Method,
                          uri: axum::http::Uri,
                          headers: axum::http::HeaderMap,
                          body: axum::body::Bytes| {
                        let requests = Arc::clone(&requests_for_route);
                        let responses = Arc::clone(&queued_for_route);
                        async move {
                            requests.lock().unwrap().push(MockManagementRequest {
                                method,
                                path: uri.to_string(),
                                headers,
                                body,
                            });
                            let (status, body) = responses
                                .lock()
                                .unwrap()
                                .pop_front()
                                .expect("mock management response");
                            axum::response::Response::builder()
                                .status(status)
                                .header(axum::http::header::CONTENT_TYPE, "application/json")
                                .body(axum::body::Body::from(body))
                                .unwrap()
                        }
                    },
                ));
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Self {
                addr,
                requests,
                responses: queued,
                task,
            }
        }

        fn raw_conn(&self) -> DevserverConn {
            DevserverConn {
                host: "127.0.0.1".into(),
                port: self.addr.port(),
                token: "raw-token".into(),
                name: "raw".into(),
                gateway: None,
            }
        }

        fn gateway_conn(&self) -> DevserverConn {
            let conn = gateway_test_conn(format!("http://{}/mobile/v1/devserver/entry", self.addr));
            *conn.gateway.as_ref().unwrap().session.lock().unwrap() = Some(GatewaySession {
                gate: "opaque".into(),
                cookie_header: "__Host-devserver_gate=opaque; __Host-devserver_csrf=csrf-1".into(),
                csrf: "csrf-1".into(),
                expires_at: Instant::now() + Duration::from_secs(60),
            });
            conn
        }

        fn assert_responses_drained(&self) {
            assert!(
                self.responses.lock().unwrap().is_empty(),
                "every configured mock response must be consumed"
            );
        }
    }

    impl Drop for MockManagementServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    fn assert_request_shape(
        request: &MockManagementRequest,
        method: axum::http::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) {
        assert_eq!(request.method, method);
        assert_eq!(request.path, path);
        match body {
            Some(body) => {
                assert_eq!(
                    request
                        .headers
                        .get(axum::http::header::CONTENT_TYPE)
                        .unwrap(),
                    "application/json"
                );
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                    body
                );
            }
            None => {
                assert!(request
                    .headers
                    .get(axum::http::header::CONTENT_TYPE)
                    .is_none());
                assert!(request.body.is_empty(), "body: {:?}", request.body);
            }
        }
    }

    fn assert_raw_request(
        request: &MockManagementRequest,
        method: axum::http::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) {
        assert_request_shape(request, method, path, body);
        assert_eq!(
            request
                .headers
                .get(axum::http::header::AUTHORIZATION)
                .unwrap(),
            "Bearer raw-token"
        );
        assert!(request.headers.get(axum::http::header::COOKIE).is_none());
        assert!(request.headers.get("x-chan-csrf").is_none());
    }

    fn assert_gateway_request(
        request: &MockManagementRequest,
        method: axum::http::Method,
        path: &str,
        body: Option<serde_json::Value>,
        cookie: &str,
        csrf: Option<&str>,
    ) {
        assert_request_shape(request, method, path, body);
        assert!(request
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .is_none());
        assert_eq!(
            request.headers.get(axum::http::header::COOKIE).unwrap(),
            cookie
        );
        assert_eq!(
            request
                .headers
                .get("x-chan-csrf")
                .map(|value| value.to_str().unwrap()),
            csrf
        );
    }

    fn mock_response(
        status: axum::http::StatusCode,
        body: impl Into<String>,
    ) -> (axum::http::StatusCode, String) {
        (status, body.into())
    }

    #[tokio::test]
    async fn mint_library_window_request_contract_per_arm() {
        use axum::http::{Method, StatusCode};

        for gateway in [false, true] {
            let mut row = window_row("window-2", "/workspace", "tenant-token");
            row.kind = chan_server::WindowKind::Workspace;
            row.workspace_path = Some("/repo".into());
            let server = MockManagementServer::start(vec![
                mock_response(StatusCode::OK, serde_json::to_string(&row).unwrap()),
                mock_response(StatusCode::INTERNAL_SERVER_ERROR, "failure"),
            ])
            .await;
            let conn = if gateway {
                server.gateway_conn()
            } else {
                server.raw_conn()
            };
            let (minted, error) = tokio::time::timeout(Duration::from_secs(10), async {
                (
                    mint_library_window(
                        &conn,
                        chan_server::WindowKind::Workspace,
                        Some("/repo".into()),
                    )
                    .await,
                    mint_library_window(
                        &conn,
                        chan_server::WindowKind::Workspace,
                        Some("/repo".into()),
                    )
                    .await
                    .unwrap_err(),
                )
            })
            .await
            .expect("window-mint requests must finish");

            let minted = minted.unwrap();
            assert_eq!(minted.window_id, "window-2");
            assert_eq!(minted.workspace_path.as_deref(), Some("/repo"));
            assert_eq!(
                error,
                if gateway {
                    "gateway library window mint returned HTTP 500 Internal Server Error"
                } else {
                    "library window mint returned HTTP 500 Internal Server Error"
                }
            );
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            for request in requests.iter() {
                let body = Some(serde_json::json!({
                    "kind": "workspace",
                    "workspace_path": "/repo",
                }));
                if gateway {
                    assert_gateway_request(
                        request,
                        Method::POST,
                        "/api/library/windows",
                        body,
                        "__Host-devserver_gate=opaque; __Host-devserver_csrf=csrf-1",
                        Some("csrf-1"),
                    );
                } else {
                    assert_raw_request(request, Method::POST, "/api/library/windows", body);
                }
            }
            server.assert_responses_drained();
        }
    }

    #[tokio::test]
    async fn mint_library_window_decode_error_contract_per_arm() {
        use axum::http::{Method, StatusCode};

        for gateway in [false, true] {
            let server =
                MockManagementServer::start(vec![mock_response(StatusCode::OK, "not json")]).await;
            let conn = if gateway {
                server.gateway_conn()
            } else {
                server.raw_conn()
            };
            let error = tokio::time::timeout(
                Duration::from_secs(10),
                mint_library_window(&conn, chan_server::WindowKind::Terminal, None),
            )
            .await
            .expect("window-mint request must finish")
            .unwrap_err();

            assert!(
                error.starts_with(if gateway {
                    "decoding minted gateway window: "
                } else {
                    "decoding minted window: "
                }),
                "error: {error:?}"
            );
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            let body = Some(serde_json::json!({ "kind": "terminal" }));
            if gateway {
                assert_gateway_request(
                    &requests[0],
                    Method::POST,
                    "/api/library/windows",
                    body,
                    "__Host-devserver_gate=opaque; __Host-devserver_csrf=csrf-1",
                    Some("csrf-1"),
                );
            } else {
                assert_raw_request(&requests[0], Method::POST, "/api/library/windows", body);
            }
            server.assert_responses_drained();
        }
    }

    #[tokio::test]
    async fn navigation_url_mints_a_fresh_entry_for_a_gateway_window() {
        // The gateway path mints then exchanges a body-only credential at
        // navigation time; feed rows keep their devserver-local tokens.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let proxy_origin = format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{}", addr.port());
        let response_proxy = proxy_origin.clone();
        let app = axum::Router::new()
            .route(
                "/mobile/v1/devserver/entry",
                axum::routing::post(move || {
                    let proxy_origin = response_proxy.clone();
                    async move {
                        axum::Json(serde_json::json!({
                            "owner_user_id": test_owner_id(),
                            "username": "alice",
                            "devserver_id": "a".repeat(64),
                            "proxy_origin": proxy_origin,
                            "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                            "entry_credential": "tok_entry_1",
                        }))
                    }
                }),
            )
            .route(
                "/_chan/entry",
                axum::routing::post(|| async {
                    axum::response::Response::builder()
                        .status(axum::http::StatusCode::SEE_OTHER)
                        .header("location", "/notes-1a2b3c/index.html")
                        .header(
                            "set-cookie",
                            "__Host-devserver_gate=opaque; Path=/; HttpOnly",
                        )
                        .header("set-cookie", "__Host-devserver_csrf=csrf; Path=/")
                        .body(axum::body::Body::empty())
                        .unwrap()
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let conn = gateway_test_conn(format!("http://{addr}/mobile/v1/devserver/entry"));
        let record = window_row("w-1", "/notes-1a2b3c", "tok_local_1");
        let url = window_navigation_url(&conn, &record)
            .await
            .expect("gateway navigation URL mints");
        assert_eq!(url, format!("{proxy_origin}/notes-1a2b3c/index.html"));
        assert!(!url.contains("tok_entry_1"));
        assert_eq!(record.token, "tok_local_1", "the row's token is untouched");
    }

    #[tokio::test]
    async fn navigation_url_mint_failure_surfaces_as_err() {
        // Unreachable entry endpoint (port 9): the open/retarget caller gets
        // an Err to warn on and retry later; nothing else is affected.
        let conn = gateway_test_conn("http://127.0.0.1:9/mobile/v1/devserver/entry".into());
        let record = window_row("w-1", "/notes-1a2b3c", "tok_local_1");
        assert!(window_navigation_url(&conn, &record).await.is_err());
    }

    #[tokio::test]
    async fn more_than_session_cap_navigations_reuse_one_opaque_session() {
        let conn = gateway_test_conn("http://127.0.0.1:9/mobile/v1/devserver/entry".into());
        let gw = conn.gateway.as_ref().unwrap();
        *gw.session.lock().unwrap() = Some(GatewaySession {
            gate: "opaque-once".into(),
            cookie_header: "__Host-devserver_gate=opaque-once; __Host-devserver_csrf=csrf-once"
                .into(),
            csrf: "csrf-once".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
        });

        for index in 0..17 {
            let prefix = format!("/notes-{index}");
            let record = window_row(&format!("w-{index}"), &prefix, "row-token");
            let url = window_navigation_url(&conn, &record)
                .await
                .expect("cached session navigation succeeds without a new exchange");
            assert_eq!(
                url,
                format!("{}/{}/index.html", gw.proxy_origin, &prefix[1..])
            );
        }
    }

    #[test]
    fn gateway_session_ttl_honors_max_age_with_a_safety_margin() {
        assert_eq!(gateway_session_ttl(Some(120)), Duration::from_secs(90));
        assert_eq!(
            gateway_session_ttl(None),
            Duration::from_secs(GATE_SESSION_FALLBACK_TTL_SECS - 30)
        );
        assert_eq!(gateway_session_ttl(Some(10)), Duration::ZERO);
        assert_eq!(
            gateway_session_ttl(Some(u64::MAX)),
            Duration::from_secs(24 * 60 * 60 - 30)
        );
    }

    #[test]
    fn gateway_cookie_max_age_is_scoped_to_the_named_cookie() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "other=x; Max-Age=999".parse().unwrap(),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            "__Host-devserver_gate=opaque; Path=/; HttpOnly; max-age=3600"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            extract_cookie_max_age(&headers, "__Host-devserver_gate"),
            Some(3600)
        );
    }

    #[test]
    fn gateway_session_install_returns_with_a_fresh_session() {
        let conn = gateway_test_conn("https://gw.chan.app/mobile/v1/devserver/entry".into());
        let gw = conn.gateway.as_ref().unwrap();
        *gw.session.lock().unwrap() = Some(GatewaySession {
            gate: "gate-current".into(),
            cookie_header: "__Host-devserver_gate=gate-current; __Host-devserver_csrf=csrf-current"
                .into(),
            csrf: "csrf-current".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
        });
        let installed = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let installed_for_callback = Arc::clone(&installed);
        let installer: Arc<GatewaySessionInstaller> = Arc::new(move |origin, session| {
            installed_for_callback
                .lock()
                .unwrap()
                .push((origin.to_string(), session.csrf.clone()));
            Ok(())
        });

        install_current_gateway_session(gw, installer.as_ref()).unwrap();

        assert_eq!(
            installed.lock().unwrap().as_slice(),
            [(gw.proxy_origin.clone(), "csrf-current".to_string())]
        );
    }

    #[tokio::test]
    async fn concurrent_session_miss_and_auth_refresh_each_exchange_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let entry_hits = Arc::new(AtomicUsize::new(0));
        let exchange_hits = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let proxy_origin = format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{}", addr.port());
        let response_proxy = proxy_origin.clone();
        let entry_hits_route = Arc::clone(&entry_hits);
        let exchange_hits_route = Arc::clone(&exchange_hits);
        let app = axum::Router::new()
            .route(
                "/mobile/v1/devserver/entry",
                axum::routing::post(move || {
                    let proxy_origin = response_proxy.clone();
                    let entry_hits = Arc::clone(&entry_hits_route);
                    async move {
                        entry_hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({
                            "owner_user_id": test_owner_id(),
                            "username": "alice",
                            "devserver_id": "a".repeat(64),
                            "proxy_origin": proxy_origin,
                            "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                            "entry_credential": "tok_entry",
                        }))
                    }
                }),
            )
            .route(
                "/_chan/entry",
                axum::routing::post(move || {
                    let exchange_hits = Arc::clone(&exchange_hits_route);
                    async move {
                        let generation = exchange_hits.fetch_add(1, Ordering::SeqCst) + 1;
                        axum::response::Response::builder()
                            .status(axum::http::StatusCode::SEE_OTHER)
                            .header("location", "/")
                            .header(
                                "set-cookie",
                                format!(
                                    "__Host-devserver_gate=opaque-{generation}; Path=/; HttpOnly; Max-Age=120"
                                ),
                            )
                            .header(
                                "set-cookie",
                                format!("__Host-devserver_csrf=csrf-{generation}; Path=/; Max-Age=120"),
                            )
                            .body(axum::body::Body::empty())
                            .unwrap()
                    }
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let conn = gateway_test_conn(format!("http://{addr}/mobile/v1/devserver/entry"));
        let gw = conn.gateway.as_ref().unwrap().as_ref().clone();
        let installed = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let installed_for_callback = Arc::clone(&installed);
        let installer: Arc<GatewaySessionInstaller> = Arc::new(move |origin, session| {
            installed_for_callback
                .lock()
                .unwrap()
                .push((origin.to_string(), session.csrf.clone()));
            Ok(())
        });
        *gw.session_installer.lock().unwrap() = Some(installer);

        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..24 {
            let gw = gw.clone();
            tasks.spawn(async move { gateway_session(&gw).await.unwrap() });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(entry_hits.load(Ordering::SeqCst), 1);
        assert_eq!(exchange_hits.load(Ordering::SeqCst), 1);
        assert_eq!(
            installed.lock().unwrap().as_slice(),
            [(proxy_origin.clone(), "csrf-1".to_string())]
        );
        let window_url = url::Url::parse(&format!("{proxy_origin}/notes")).unwrap();
        assert_eq!(
            gateway_csrf_token_for_connection(&conn, "lib-1::w-1", &window_url)
                .await
                .as_deref(),
            Ok("csrf-1")
        );

        let observed = gw
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .cookie_header
            .clone();
        for _ in 0..24 {
            let gw = gw.clone();
            let observed = observed.clone();
            tasks
                .spawn(async move { refresh_gateway_session_after(&gw, &observed).await.unwrap() });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(entry_hits.load(Ordering::SeqCst), 2);
        assert_eq!(exchange_hits.load(Ordering::SeqCst), 2);
        assert_ne!(
            gw.session.lock().unwrap().as_ref().unwrap().cookie_header,
            observed
        );
        assert_eq!(
            installed.lock().unwrap().as_slice(),
            [
                (proxy_origin.clone(), "csrf-1".to_string()),
                (proxy_origin, "csrf-2".to_string()),
            ]
        );
        assert_eq!(
            gateway_csrf_token_for_connection(&conn, "lib-1::w-1", &window_url)
                .await
                .as_deref(),
            Ok("csrf-2")
        );

        server.abort();
    }

    #[tokio::test]
    async fn expired_session_is_not_reused_for_clean_navigation() {
        let conn = gateway_test_conn("http://127.0.0.1:9/mobile/v1/devserver/entry".into());
        let gw = conn.gateway.as_ref().unwrap();
        *gw.session.lock().unwrap() = Some(GatewaySession {
            gate: "expired".into(),
            cookie_header: "__Host-devserver_gate=expired; __Host-devserver_csrf=expired".into(),
            csrf: "expired".into(),
            expires_at: Instant::now(),
        });
        let record = window_row("w-1", "/notes", "row-token");
        assert!(window_navigation_url(&conn, &record).await.is_err());
    }

    #[tokio::test]
    async fn navigation_url_uses_the_stable_token_for_raw_devservers() {
        // No gateway: the URL is assembled from the row's own tenant token,
        // no network involved.
        let conn = DevserverConn {
            host: "box.example.net".into(),
            port: 8787,
            token: String::new(),
            name: "box".into(),
            gateway: None,
        };
        let record = window_row("w-1", "/notes-1a2b3c", "tok_tenant");
        let url = window_navigation_url(&conn, &record)
            .await
            .expect("raw navigation URL assembles");
        assert_eq!(
            url,
            "http://box.example.net:8787/notes-1a2b3c/index.html?t=tok_tenant"
        );
    }

    #[test]
    fn conns_set_get_remove_roundtrip() {
        let conns = DevserverConns::default();
        assert!(!conns.is_connected("ds1"));
        conns.set(
            "ds1".into(),
            DevserverConn {
                host: "127.0.0.1".into(),
                port: 8787,
                token: "tok".into(),
                name: "box".into(),
                gateway: None,
            },
        );
        assert!(conns.is_connected("ds1"));
        assert_eq!(conns.get("ds1").unwrap().port, 8787);
        assert!(conns.remove("ds1").is_some());
        assert!(!conns.is_connected("ds1"));
    }

    #[test]
    fn conns_stamp_registration_on_set_and_clear_on_remove() {
        // `set` stamps the registration Instant the exit watcher's handshake
        // grace reads; `remove` clears it with the entry, so a disconnected
        // devserver has no age to misread.
        let conns = DevserverConns::default();
        assert_eq!(conns.registered_elapsed("ds1"), None);
        conns.set(
            "ds1".into(),
            DevserverConn {
                host: "127.0.0.1".into(),
                port: 8787,
                token: "tok".into(),
                name: "box".into(),
                gateway: None,
            },
        );
        let age = conns.registered_elapsed("ds1").expect("registered");
        assert!(age < Duration::from_secs(60), "fresh registration: {age:?}");
        assert!(conns.remove("ds1").is_some());
        assert_eq!(conns.registered_elapsed("ds1"), None);
    }

    #[tokio::test]
    async fn main_window_resolves_csrf_only_for_matching_connected_gateway_origin() {
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let proxy_origin = "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app";
        let mut conn = gateway_test_conn("http://127.0.0.1:9/mobile/v1/devserver/entry".into());
        {
            let gw = conn.gateway.as_mut().unwrap();
            gw.proxy_origin = proxy_origin.to_string();
            *gw.session.lock().unwrap() = Some(GatewaySession {
                gate: "gate-1".into(),
                cookie_header: "__Host-devserver_gate=gate-1; __Host-devserver_csrf=csrf-main"
                    .into(),
                csrf: "csrf-main".into(),
                expires_at: Instant::now() + Duration::from_secs(120),
            });
        }

        let matching_url = url::Url::parse(&format!("{proxy_origin}/notes/index.html")).unwrap();
        let mismatched_url =
            url::Url::parse("https://bob--1a2b3c4d5e6f.p1.proxy.chan.app/notes/index.html")
                .unwrap();
        let loopback_url = url::Url::parse("http://127.0.0.1:8471/?t=tok").unwrap();

        // Disconnected: main refuses even on the gateway origin.
        assert!(gateway_connection_for_window(&state, "main", &matching_url).is_err());

        // Connected: main resolves CSRF for the matching origin and refuses
        // mismatched origins or non-main/non-lib labels.
        state.devservers.set("gw:1".into(), conn.clone());
        let resolved = gateway_connection_for_window(&state, "main", &matching_url)
            .expect("connected gateway origin resolves for main");
        assert_eq!(
            gateway_csrf_token_for_connection(&resolved, "main", &matching_url)
                .await
                .as_deref(),
            Ok("csrf-main")
        );
        assert!(gateway_connection_for_window(&state, "main", &mismatched_url).is_err());
        assert!(gateway_connection_for_window(&state, "main", &loopback_url).is_err());
        assert!(
            gateway_csrf_token_for_connection(&resolved, "main", &mismatched_url)
                .await
                .is_err()
        );
        assert!(gateway_connection_for_window(&state, "about", &matching_url).is_err());
        assert!(
            gateway_csrf_token_for_connection(&resolved, "about", &matching_url)
                .await
                .is_err()
        );

        // Disconnecting invalidates lookup immediately.
        state.devservers.remove("gw:1");
        assert!(gateway_connection_for_window(&state, "main", &matching_url).is_err());
    }

    #[test]
    fn host_os_meta_and_workspace_toggle_helpers_match_gateway_contract() {
        let html = r#"<!doctype html><html><head><meta charset="utf-8"><meta content="macos" name="chan-launcher-host-os"></head></html>"#;
        assert_eq!(parse_host_os_meta(html).as_deref(), Some("macos"));
        assert_eq!(parse_host_os_meta("<html><head></head></html>"), None);

        assert_eq!(
            launcher_workspace_toggle_request("/notes-1a2b3c", true, false),
            ("/api/library/workspaces/notes-1a2b3c/on".to_string(), None)
        );
        assert_eq!(
            launcher_workspace_toggle_request("notes-1a2b3c", false, true),
            (
                "/api/library/workspaces/notes-1a2b3c/off".to_string(),
                Some(serde_json::json!({ "force": true }))
            )
        );
    }
}

#[cfg(target_os = "ios")]
fn install_gateway_webview_session_values<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    origin: &str,
    session: &GatewaySession,
    label: Option<&str>,
    access: Option<&crate::wireguard::AccessGuard>,
) -> Result<(), String> {
    use tauri::Manager;
    let webview = label
        .and_then(|label| app.get_webview_window(label))
        .or_else(|| app.webview_windows().into_values().next());
    if webview.is_none() {
        return if access.is_some() {
            Err("WireGuard: no WebView is available for the session".into())
        } else {
            Ok(())
        };
    }
    crate::webview_proxy::install_cookies(
        app,
        origin,
        &session.gate,
        &session.csrf,
        access.cloned(),
    )
}
