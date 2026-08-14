//! Devserver management-API client.
//!
//! A devserver is a headless `chan devserver` aggregating many workspaces
//! on one box, reached over an `ssh -L` tunnel or direct loopback. The
//! desktop drives a small HTTP/JSON surface the devserver reserves at its
//! root prefix:
//!
//! - `GET  /api/devserver/info` (unauthenticated): health, version, label.
//! - `GET  /api/devserver/workspaces` (bearer): the workspaces to group.
//!
//! Every workspace is its own tokened tenant. The devserver
//! returns each tenant's `prefix` and per-tenant `token`; the desktop
//! assembles the tenant URL itself, `http://{host}:{port}{prefix}/index.html?t={token}`,
//! and opens it with the same outbound-window machinery as any remote URL.
//! Assembling client-side keeps the desktop in control of the local tunnel
//! port and avoids the devserver needing to know how it is reached.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

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
    pub identity_origin: String,
    pub desktop_entry_url: String,
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
            .field("desktop_entry_url", &self.desktop_entry_url)
            .field("proxy_apex_origin", &self.proxy_apex_origin)
            .field("proxy_origin", &self.proxy_origin)
            .field("pat", &"[REDACTED]")
            .field("entry_target", &self.entry_target)
            .field("session", &self.session)
            .finish()
    }
}

impl GatewayConn {
    pub fn new(
        identity_origin: String,
        desktop_entry_url: String,
        proxy_origin: String,
        pat: String,
    ) -> Self {
        Self {
            identity_origin,
            desktop_entry_url,
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
    pub fn with_entry_target(mut self, target: Option<GatewayEntryTarget>) -> Self {
        self.entry_target = target;
        self
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
/// [`registered_elapsed`](Self::registered_elapsed): the control-script exit
/// watcher uses the age to tell a connect-time daemonize-handshake exit from a
/// later death of the script that IS the connection. A re-`set` (token
/// rotation) re-stamps it: the rotation is a fresh registration.
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
    pub fn registered_elapsed(&self, id: &str) -> Option<Duration> {
        self.inner
            .lock()
            .unwrap()
            .get(id)
            .map(|(_, registered)| registered.elapsed())
    }
}

/// The management-API protocol version this desktop speaks. A devserver
/// reporting a different `protocol` is refused at connect rather than
/// driven against shapes that may have shifted.
pub const DEVSERVER_API_PROTOCOL: u32 = 1;

/// `GET /api/devserver/info`: the unauthenticated health probe.
#[derive(Debug, Clone, Deserialize)]
pub struct DevserverInfo {
    pub devserver_version: String,
    pub protocol: u32,
    /// Human label for the box, shown in the `[DEVSERVER {host}]` header
    /// once connected.
    pub host_label: String,
    /// The devserver library's `library_id`: supplied at
    /// connect so the desktop can mint the control terminal as a registry row
    /// under it even on a zero-window connect (no window record to learn it from).
    #[serde(default)]
    pub library_id: String,
    /// The devserver host's OS family (`macos | windows | linux | other`),
    /// surfaced to the launcher as the machine icon. `#[serde(default)]`: empty
    /// from a devserver too old to report it.
    #[serde(default)]
    pub os: String,
    /// Best-effort human OS string for the launcher tooltip; absent when unknown.
    #[serde(default)]
    pub pretty_name: Option<String>,
    /// Whether this devserver serves the standalone Files application, so the
    /// launcher only offers its remote New-Files action where a mint would
    /// take. `#[serde(default)]`: false from a devserver too old to report it.
    #[serde(default)]
    pub files_app: bool,
}

/// One element of `GET /api/devserver/workspaces`: a tenant the desktop
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

/// `POST /api/devserver/workspaces/{prefix}/on` body -- mirrors the server's
/// `SetWorkspaceOnRequest`. `on:false` keeps the workspace registered
/// (unmount-but-remember), distinct from `DELETE` = Forget. `force` overrides
/// the server's off-with-live-terminals guard (the 409 below).
#[derive(Debug, serde::Serialize)]
struct SetWorkspaceOnRequest {
    on: bool,
    force: bool,
}

/// The server's 409 body when an unforced off is rejected because the tenant
/// still has live terminals -- mirrors `ActiveTerminalsRejection`.
#[derive(Debug, serde::Deserialize)]
struct ActiveTerminalsRejection {
    active_terminals: usize,
}

/// Why a devserver workspace on/off failed, structured so the SPA can tell a
/// confirm-before-off (live terminals → offer to force) apart from a plain
/// failure. Serialized to the frontend as the command's error.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind")]
pub enum SetWorkspaceOnError {
    /// An unforced off was rejected: `active_terminals` live terminals would be
    /// killed. The SPA confirms, then retries with `force: true`.
    ActiveTerminals { active_terminals: usize },
    /// Any other failure (network, decode, non-409 status), as a plain message.
    Other { message: String },
}

impl SetWorkspaceOnError {
    pub fn other(msg: impl std::fmt::Display) -> Self {
        Self::Other {
            message: msg.to_string(),
        }
    }
}

/// A devserver workspace as the launcher renders it: the tenant fields plus
/// the assembled tenant URL ready for the outbound-window machinery.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DevserverWorkspaceRow {
    pub prefix: String,
    pub path: String,
    pub label: String,
    pub on: bool,
    pub status: chan_server::WorkspaceStatus,
    pub error: Option<String>,
    pub url: String,
}

/// One process-wide `reqwest::Client`, reused across every devserver request.
///
/// Building a fresh `Client` per call (the old body of this fn) defeated
/// reqwest's keep-alive connection pool: the 5s workspace/colour poll
/// (`main.rs`) opens two requests per cycle, and a per-call Client never reuses
/// a connection, so the devserver held each one ESTABLISHED waiting for a reuse
/// that never came -- ~22 leaked conns/min until it hit its 1024-fd cap (~40 min)
/// and started failing every accept with "Too many open files"
/// (`dev/devserver-bug/analysis.md`). A single cached Client shares one
/// connection pool across all callers (the pool keys on host:port, so each
/// devserver endpoint still gets its own pooled connection), collapsing
/// ESTABLISHED from ~967 to ~1. `Client` is internally `Arc`-backed, so the
/// per-call `.clone()` is cheap and every clone shares that one pool.
///
/// The signature is unchanged so the ~9 call sites stay as they are. The build
/// result (success OR the rare TLS-backend init failure) is memoized: a failure
/// here is deterministic, so caching it avoids re-attempting a build that cannot
/// succeed.
fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .map_err(|e| format!("building devserver http client: {e}"))
        })
        .clone()
}

fn http_client_no_redirect() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                .redirect(reqwest::redirect::Policy::none())
                .build()
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

/// Parse a stored devserver URL into the `(host, port)` the raw-tunnel dial
/// uses. The port defaults from the scheme when the URL omits it (`https`→443,
/// `http`→80), so `https://p1.usr.chan.app` resolves without an explicit
/// port. Bare `host:port` (no scheme) is rejected -- the launcher requires a
/// `scheme://host` URL. Gateway discovery uses the original URL before this
/// raw-origin fallback is used.
pub fn parse_devserver_url(url: &str) -> Result<(String, u16), String> {
    let parsed =
        url::Url::parse(url.trim()).map_err(|e| format!("invalid devserver URL {url:?}: {e}"))?;
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("devserver URL {url:?} has no host"))?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| format!("devserver URL {url:?} has no port and an unknown scheme"))?;
    Ok((host, port))
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

#[derive(Debug, Clone, Deserialize)]
pub struct GatewayDiscovery {
    pub kind: String,
    pub api_version: u32,
    pub identity_origin: String,
    pub desktop_authorize_url: String,
    pub desktop_entry_url: String,
    pub devserver_proxy_origin: String,
    pub devserver_proxy_host_depth: u8,
    /// Account-mode devserver roster endpoint. Presence means the gateway
    /// supports account-level desktop connections; a gateway without it is
    /// too old for account mode and the desktop says so instead of
    /// connecting. `#[serde(default)]`: additive on the wire, older
    /// gateways simply omit it.
    #[serde(default)]
    pub roster_url: Option<String>,
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
    d: GatewayDiscovery,
) -> Result<GatewayDiscovery, String> {
    if d.kind != "chan-gateway" || d.api_version != 1 {
        return Err("server is not a supported chan-gateway".to_string());
    }
    if d.devserver_proxy_host_depth != 2 {
        return Err("chan-gateway discovery has an unsupported proxy host depth".to_string());
    }

    let configured_origin = origin_of(configured_url)?;
    let identity_origin = origin_of(&d.identity_origin)?;
    let authorize_origin = origin_of(&d.desktop_authorize_url)?;
    let entry_origin = origin_of(&d.desktop_entry_url)?;
    if identity_origin != configured_origin
        || authorize_origin != configured_origin
        || entry_origin != configured_origin
    {
        return Err("chan-gateway discovery is cross-origin".to_string());
    }
    // The roster URL is identity-side like the entry URL: same-origin, or
    // the discovery is lying about where the account roster lives.
    if let Some(roster_url) = &d.roster_url {
        if origin_of(roster_url)? != configured_origin {
            return Err("chan-gateway discovery is cross-origin".to_string());
        }
        require_https_unless_loopback(roster_url)?;
    }

    for raw in [
        configured_url,
        &d.identity_origin,
        &d.desktop_authorize_url,
        &d.desktop_entry_url,
        &d.devserver_proxy_origin,
    ] {
        require_https_unless_loopback(raw)?;
    }

    Ok(d)
}

pub async fn discover_gateway(url: &str) -> Result<GatewayDiscovery, String> {
    let normalized = normalize_devserver_url(url)?;
    let mut u = url::Url::parse(&normalized).map_err(|e| format!("bad gateway URL: {e}"))?;
    u.set_path("/.well-known/chan-gateway");
    u.set_query(None);
    u.set_fragment(None);
    let resp = http_client_no_redirect()?
        .get(u)
        .send()
        .await
        .map_err(|e| format!("checking chan-gateway discovery: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gateway discovery returned HTTP {}", resp.status()));
    }
    let d = resp
        .json::<GatewayDiscovery>()
        .await
        .map_err(|e| format!("decoding gateway discovery: {e}"))?;
    validate_gateway_discovery(&normalized, d)
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
/// directions degrade to today's behavior.
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
    desktop_entry_url: &str,
    pat: &str,
    entry_target: Option<&GatewayEntryTarget>,
    path: &str,
) -> Result<GatewayEntryResponse, GatewayEntryError> {
    let resp = http_client()
        .map_err(GatewayEntryError::Other)?
        .post(desktop_entry_url)
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
    let response = request_gateway_entry(
        &gw.desktop_entry_url,
        &gw.pat,
        gw.entry_target.as_ref(),
        path,
    )
    .await?;
    validate_gateway_entry(
        &gw.proxy_apex_origin,
        gw.entry_target.as_ref(),
        path,
        Some(&gw.proxy_origin),
        response,
    )
    .map_err(GatewayEntryError::Other)
}

pub async fn gateway_conn(
    discovery: &GatewayDiscovery,
    pat: String,
    entry_target: Option<GatewayEntryTarget>,
) -> Result<GatewayConn, GatewayEntryError> {
    let response = request_gateway_entry(
        &discovery.desktop_entry_url,
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
        identity_origin: discovery.identity_origin.clone(),
        desktop_entry_url: discovery.desktop_entry_url.clone(),
        proxy_apex_origin: origin_of(&discovery.devserver_proxy_origin)
            .map_err(GatewayEntryError::Other)?,
        proxy_origin: entry.proxy_origin.clone(),
        pat,
        entry_target,
        session: Arc::new(Mutex::new(None)),
        session_refresh: Arc::new(tokio::sync::Mutex::new(())),
        session_installer: Arc::new(Mutex::new(None)),
    };
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
    let resp = http_client_no_redirect()?
        .post(&entry.entry_exchange_url)
        .header(reqwest::header::ORIGIN, &gw.identity_origin)
        .form(&[("credential", entry.entry_credential.as_str())])
        .send()
        .await
        .map_err(|e| format!("exchanging gateway entry credential: {e}"))?;
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
    let entry = gateway_entry(gw, "/").await?;
    establish_gateway_session_from_entry(gw, &entry)
        .await
        .map(|(session, _)| session)
}

async fn gateway_session(gw: &GatewayConn) -> Result<GatewaySession, String> {
    if let Some(session) = gw.session.lock().unwrap().clone().filter(|s| s.is_fresh()) {
        return Ok(session);
    }
    let _refresh = gw.session_refresh.lock().await;
    if let Some(session) = gw.session.lock().unwrap().clone().filter(|s| s.is_fresh()) {
        return Ok(session);
    }
    mint_gateway_session(gw).await
}

async fn refresh_gateway_session_after(
    gw: &GatewayConn,
    observed_cookie_header: &str,
) -> Result<GatewaySession, String> {
    let _refresh = gw.session_refresh.lock().await;
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

pub(crate) async fn gateway_cookie_header(conn: &DevserverConn) -> Result<String, String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
    gateway_session(gw).await.map(|s| s.cookie_header)
}

/// Time to wait before `conn`'s gateway session should be re-minted, or `None`
/// when `conn` does not reach a gateway. `Some(ZERO)` means it is due now,
/// including the case where no session has been minted yet.
pub(crate) fn gateway_session_refresh_delay(conn: &DevserverConn) -> Option<Duration> {
    let gw = conn.gateway.as_ref()?;
    let session = gw.session.lock().unwrap().clone();
    Some(session.map_or(Duration::ZERO, |session| session.refresh_due_in()))
}

/// Cookie header of the session currently cached for `conn`, minting nothing.
/// The refresh loop hands this back to [`refresh_gateway_session_if_current`]
/// so a session some other path already replaced is not re-minted twice.
pub(crate) fn cached_gateway_cookie_header(conn: &DevserverConn) -> Option<String> {
    let gw = conn.gateway.as_ref()?;
    let session = gw.session.lock().unwrap().clone();
    session.map(|session| session.cookie_header)
}

pub(crate) async fn refresh_gateway_session_if_current(
    conn: &DevserverConn,
    observed_cookie_header: &str,
) -> Result<(), String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
    refresh_gateway_session_after(gw, observed_cookie_header)
        .await
        .map(|_| ())
}

fn gateway_connection_for_window(
    state: &crate::AppState,
    window_label: &str,
) -> Result<DevserverConn, String> {
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
    if conn.gateway.is_none() {
        return Err("gateway CSRF token is unavailable on a direct connection".to_string());
    }
    Ok(conn)
}

async fn gateway_csrf_token_for_connection(
    conn: &DevserverConn,
    window_label: &str,
    window_url: &url::Url,
) -> Result<String, String> {
    if !window_label.starts_with("lib-") {
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
    let conn = gateway_connection_for_window(state.inner(), &label)?;
    install_gateway_webview_session(&app, &conn, Some(&label))?;
    let url = window
        .url()
        .map_err(|e| format!("reading gateway window URL: {e}"))?;
    gateway_csrf_token_for_connection(&conn, &label, &url).await?;

    // A reconnect can replace the connection while an expired session is being
    // minted. Resolve both the connection and URL again so the returned token
    // belongs to what the caller is showing now.
    let conn = gateway_connection_for_window(state.inner(), &label)?;
    install_gateway_webview_session(&app, &conn, Some(&label))?;
    let url = window
        .url()
        .map_err(|e| format!("reading gateway window URL after refresh: {e}"))?;
    gateway_csrf_token_for_connection(&conn, &label, &url).await
}

/// Copy the native client's freshly exchanged opaque session into the shared
/// Tauri WebView cookie store before a clean tenant URL is opened. This keeps
/// the entry credential out of navigation URLs while preserving HttpOnly on
/// the authorization cookie. The installer remains attached to the connection
/// so every later session re-mint updates the store without a navigation.
pub(crate) fn install_gateway_webview_session(
    app: &tauri::AppHandle,
    conn: &DevserverConn,
    preferred_window_label: Option<&str>,
) -> Result<(), String> {
    let Some(gw) = conn.gateway.as_ref() else {
        return Ok(());
    };
    let app = app.clone();
    let preferred_window_label = preferred_window_label.map(str::to_string);
    let installer: Arc<GatewaySessionInstaller> = Arc::new(move |origin, session| {
        install_gateway_webview_session_values(
            &app,
            origin,
            session,
            preferred_window_label.as_deref(),
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

fn install_gateway_webview_session_values(
    app: &tauri::AppHandle,
    proxy_origin: &str,
    session: &GatewaySession,
    preferred_window_label: Option<&str>,
) -> Result<(), String> {
    use tauri::Manager;
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
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next());
    let Some(webview) = webview else {
        return Ok(());
    };
    webview
        .set_cookie(gate)
        .map_err(|e| format!("installing gateway session cookie: {e}"))?;
    webview
        .set_cookie(csrf)
        .map_err(|e| format!("installing gateway CSRF cookie: {e}"))?;
    Ok(())
}

fn gateway_url(gw: &GatewayConn, path: &str) -> String {
    format!("{}{}", gw.proxy_origin.trim_end_matches('/'), path)
}

pub(crate) fn gateway_ws_url(conn: &DevserverConn, path: &str) -> Result<String, String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
    let mut url =
        url::Url::parse(&gw.proxy_origin).map_err(|e| format!("bad gateway proxy origin: {e}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(format!("unsupported gateway proxy scheme {other:?}")),
    };
    url.set_scheme(scheme)
        .map_err(|_| format!("unsupported gateway proxy scheme {scheme:?}"))?;
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

async fn gateway_get(conn: &DevserverConn, path: &str) -> Result<reqwest::Response, String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
    gateway_request(gw, reqwest::Method::GET, path).await
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

async fn gateway_request(
    gw: &GatewayConn,
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::Response, String> {
    let session = gateway_session(gw).await?;
    let resp = apply_gateway_session(
        http_client()?.request(method.clone(), gateway_url(gw, path)),
        &method,
        &session,
    )
    .send()
    .await
    .map_err(|e| format!("gateway {} {path}: {e}", method.as_str()))?;
    if !gateway_auth_shaped(resp.status()) {
        return Ok(resp);
    }
    let session = refresh_gateway_session_after(gw, &session.cookie_header).await?;
    apply_gateway_session(
        http_client()?.request(method.clone(), gateway_url(gw, path)),
        &method,
        &session,
    )
    .send()
    .await
    .map_err(|e| format!("gateway {} {path}: {e}", method.as_str()))
}

async fn gateway_request_json<T: Serialize + ?Sized>(
    gw: &GatewayConn,
    method: reqwest::Method,
    path: &str,
    body: &T,
) -> Result<reqwest::Response, String> {
    let session = gateway_session(gw).await?;
    let resp = apply_gateway_session(
        http_client()?
            .request(method.clone(), gateway_url(gw, path))
            .json(body),
        &method,
        &session,
    )
    .send()
    .await
    .map_err(|e| format!("gateway {} {path}: {e}", method.as_str()))?;
    if !gateway_auth_shaped(resp.status()) {
        return Ok(resp);
    }
    let session = refresh_gateway_session_after(gw, &session.cookie_header).await?;
    apply_gateway_session(
        http_client()?
            .request(method.clone(), gateway_url(gw, path))
            .json(body),
        &method,
        &session,
    )
    .send()
    .await
    .map_err(|e| format!("gateway {} {path}: {e}", method.as_str()))
}

pub async fn gateway_entry_url(conn: &DevserverConn, path: &str) -> Result<String, String> {
    let gw = conn
        .gateway
        .as_ref()
        .ok_or_else(|| "not a gateway connection".to_string())?;
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

/// Path the devserver persists its config (including the bearer token) at on
/// the local box, the sibling of the desktop's own `desktop/config.json`
/// under the shared `~/.chan` home.
fn local_devserver_config_path() -> std::path::PathBuf {
    chan_workspace::paths::config_dir()
        .join("devserver")
        .join("config.json")
}

/// The local devserver's persisted config, of which the desktop only needs
/// the bearer token. A devserver on the same box writes this `0600`, so on a
/// local-loopback connection the desktop reads the token straight from the
/// file rather than scraping it from terminal output.
#[derive(Deserialize)]
struct LocalDevserverConfig {
    devserver_token: String,
    /// The devserver's last bound port, so a local connect dials the CURRENT
    /// port instead of a stored URL that goes stale when a `--port 0` devserver
    /// restarts on a different OS-assigned port. Absent (`0`) on an older config.
    #[serde(default)]
    port: u16,
}

impl std::fmt::Debug for LocalDevserverConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalDevserverConfig")
            .field("devserver_token", &"[REDACTED]")
            .field("port", &self.port)
            .finish()
    }
}

/// Read the bearer token of a devserver running on this same box from its
/// persisted config. Fails when no local devserver has started (the file is
/// absent) or the file lacks the token.
pub fn read_local_token() -> Result<String, String> {
    let path = local_devserver_config_path();
    let bytes = std::fs::read(&path).map_err(|e| {
        format!(
            "reading the local devserver config at {}: {e}",
            path.display()
        )
    })?;
    let cfg: LocalDevserverConfig = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parsing the local devserver config: {e}"))?;
    if cfg.devserver_token.is_empty() {
        return Err("the local devserver config has no token yet".to_string());
    }
    Ok(cfg.devserver_token)
}

/// Read the last bound port of a devserver running on this same box from its
/// persisted config, or `None` when the file is absent/unreadable or carries no
/// bound port (`0`, an older config). A local connect dials this so it reaches
/// the current port after the devserver restarts on a new OS-assigned port,
/// instead of the stored URL's stale port.
pub fn read_local_port() -> Option<u16> {
    let bytes = std::fs::read(local_devserver_config_path()).ok()?;
    let cfg: LocalDevserverConfig = serde_json::from_slice(&bytes).ok()?;
    (cfg.port != 0).then_some(cfg.port)
}

/// Scrape the devserver bearer token from a control terminal's output, matching
/// the locked machine marker `CHAN_DEVSERVER_TOKEN=<token>` (the shared
/// `chan_server::DEVSERVER_TOKEN_MARKER`) that `chan devserver` emits on every
/// start AND `--service=systemd --join` re-attach. Single-sourcing the marker const keeps the
/// emitter and this scraper from drifting. The desktop scrapes this fresh on
/// every connect (and on a script re-run), so a recycled or rotated devserver is
/// handled by construction -- no stored/stale token to reuse.
///
/// `output` is raw PTY bytes (decoded lossily), so it carries ANSI escapes and
/// possibly several markers across restarts. Take the LAST one and read the
/// url-safe token run after it, which stops at the first non-token byte
/// (whitespace, an ANSI escape, end of line).
pub fn scrape_token(output: &str) -> Option<String> {
    let marker = chan_server::DEVSERVER_TOKEN_MARKER;
    output.rmatch_indices(marker).find_map(|(i, m)| {
        let token: String = output[i + m.len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        (!token.is_empty()).then_some(token)
    })
}

/// `GET /api/devserver/info`: unauthenticated, used to confirm the devserver
/// is up and read its version and label.
pub async fn fetch_info(host: &str, port: u16) -> Result<DevserverInfo, String> {
    let url = format!("{}/api/devserver/info", base_origin(host, port));
    let resp = http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("reaching devserver {host}:{port}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("devserver info returned HTTP {}", resp.status()));
    }
    resp.json::<DevserverInfo>()
        .await
        .map_err(|e| format!("decoding devserver info: {e}"))
}

/// The meta descriptor chan-server injects into every launcher shell
/// (`inject_launcher_meta`) carrying the serving host's OS family.
const HOST_OS_META_NAME: &str = "chan-launcher-host-os";

/// Fetch a gateway-proxied devserver's OS family (`macos | windows | linux |
/// other`) for the launcher's machine icon. The gateway proxy never forwards
/// the local-only `/api/devserver/*` management surface, so the [`fetch_info`]
/// probe is unreachable through it; the devserver's OS self-report on the
/// tunnel surface is the host-os meta injected into its launcher shell (the
/// same descriptor the web launcher's capabilities probe reads). Errors when
/// the shell is unreachable or lacks the descriptor (a devserver too old to
/// inject it); the caller leaves the icon neutral.
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

/// Pull the host-os meta's content out of a launcher shell. Scans whole
/// `<meta ...>` tags rather than matching the injector's exact byte sequence,
/// so attribute order and spacing are free to vary across server versions.
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

/// `GET /api/devserver/workspaces`: the live workspace list, each entry's
/// tenant URL already assembled.
pub async fn fetch_workspaces(conn: &DevserverConn) -> Result<Vec<DevserverWorkspaceRow>, String> {
    if conn.gateway.is_some() {
        let resp = gateway_get(conn, "/api/library/workspaces").await?;
        if !resp.status().is_success() {
            return Err(format!(
                "gateway workspaces returned HTTP {}",
                resp.status()
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
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| format!("listing devserver workspaces: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "devserver workspaces returned HTTP {}",
            resp.status()
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

/// One `{ color }` frame of the devserver's `/api/library/local-color` GET.
#[derive(serde::Deserialize)]
struct LocalColorResponse {
    color: Option<String>,
}

/// `GET /api/library/local-color`: the devserver library's pane-highlight colour
/// (`#rrggbb`), or `None` for the default accent. Fetched ONCE on connect to warm
/// the desktop's per-devserver colour cache BEFORE the window watcher opens any
/// window, so a devserver window seeds its `?pane=` colour from the first build
/// instead of flashing blue until the async colour watch pushes. The
/// colour watch (`stream_color_feed`) keeps it live thereafter.
pub async fn fetch_local_color(conn: &DevserverConn) -> Result<Option<String>, String> {
    if conn.gateway.is_some() {
        let resp = gateway_get(conn, "/api/library/local-color").await?;
        if !resp.status().is_success() {
            return Err(format!("gateway colour returned HTTP {}", resp.status()));
        }
        return resp
            .json::<LocalColorResponse>()
            .await
            .map(|r| r.color)
            .map_err(|e| format!("decoding gateway colour: {e}"));
    }
    let url = format!(
        "{}/api/library/local-color",
        base_origin(&conn.host, conn.port)
    );
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| format!("fetching devserver colour: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("devserver colour returned HTTP {}", resp.status()));
    }
    resp.json::<LocalColorResponse>()
        .await
        .map(|r| r.color)
        .map_err(|e| format!("decoding devserver colour: {e}"))
}

/// Turn a wire `WorkspaceEntry` into a launcher row, assembling the tenant URL
/// from its token. An off (registered-but-unmounted) row carries `token:""` and
/// gets an empty URL -- it has no live tenant; the launcher renders it off and
/// Open turns it on first (which mints a fresh token).
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

/// The full window set a connected devserver serves at
/// `GET /api/library/windows` -- the watcher's initial seed (it also carries the
/// devserver's `library_id`, stamped per row, the watcher's first read of which
/// library it is reconciling). The WS `/watch` then pushes every change.
pub async fn fetch_library_windows(
    conn: &DevserverConn,
) -> Result<Vec<chan_server::WindowRecord>, String> {
    if conn.gateway.is_some() {
        let resp = gateway_get(conn, "/api/library/windows").await?;
        if !resp.status().is_success() {
            return Err(format!(
                "gateway library windows returned HTTP {}",
                resp.status()
            ));
        }
        let rows = resp
            .json::<Vec<chan_server::WindowRecord>>()
            .await
            .map_err(|e| format!("decoding gateway library windows: {e}"))?;
        return Ok(rows);
    }
    let url = format!("{}/api/library/windows", base_origin(&conn.host, conn.port));
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| format!("listing library windows: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("library windows returned HTTP {}", resp.status()));
    }
    resp.json::<Vec<chan_server::WindowRecord>>()
        .await
        .map_err(|e| format!("decoding library windows: {e}"))
}

/// Mint a window on a connected devserver's library
/// (`POST /api/library/windows`): the library assigns the id, persists the
/// record, and fires the watch, so the desktop's watcher reconciles the new
/// window open -- no client-side open. Used for the first-connect boot terminal
/// (`kind: Terminal`) and launcher-open reroutes. `app` selects the application
/// riding a terminal-class tenant (`Some(Files)` for a standalone Files
/// window); `None` is the kind's default app.
pub async fn mint_library_window(
    conn: &DevserverConn,
    kind: chan_server::WindowKind,
    app: Option<chan_server::WindowApp>,
    workspace_path: Option<String>,
) -> Result<chan_server::WindowRecord, String> {
    if let Some(gw) = &conn.gateway {
        let body = chan_server::CreateWindow {
            kind,
            app,
            workspace_path,
            origin: chan_server::WindowOrigin::Native,
            acting_window_id: None,
        };
        let resp =
            gateway_request_json(gw, reqwest::Method::POST, "/api/library/windows", &body).await?;
        if !resp.status().is_success() {
            return Err(format!(
                "gateway library window mint returned HTTP {}",
                resp.status()
            ));
        }
        return resp
            .json::<chan_server::WindowRecord>()
            .await
            .map_err(|e| format!("decoding minted gateway window: {e}"));
    }
    let url = format!("{}/api/library/windows", base_origin(&conn.host, conn.port));
    let body = chan_server::CreateWindow {
        kind,
        app,
        workspace_path,
        // The desktop mints native windows on a connected devserver.
        origin: chan_server::WindowOrigin::Native,
        // The desktop launcher is a legacy caller (the gate allows a missing
        // acting id); leadership is honest-client only.
        acting_window_id: None,
    };
    let resp = http_client()?
        .post(&url)
        .bearer_auth(&conn.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("minting library window: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "library window mint returned HTTP {}",
            resp.status()
        ));
    }
    resp.json::<chan_server::WindowRecord>()
        .await
        .map_err(|e| format!("decoding minted window: {e}"))
}

/// `DELETE /api/library/windows/{window_id}`: discard a devserver window's
/// registry record. The server drops the row, PERSISTS the removal
/// (`save_best_effort`), and fires the watch so every client's reconcile closes
/// the window. The devserver analog of the local `embedded.discard_window` -- a
/// closed devserver window must DELETE its record, else it survives server-side
/// and reopens (empty) on restart. A 404 (already gone) is success.
pub async fn discard_library_window(conn: &DevserverConn, window_id: &str) -> Result<(), String> {
    if let Some(gw) = &conn.gateway {
        let resp = gateway_request(
            gw,
            reqwest::Method::DELETE,
            &format!("/api/library/windows/{window_id}"),
        )
        .await?;
        if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(format!(
                "gateway library window discard returned HTTP {}",
                resp.status()
            ));
        }
        return Ok(());
    }
    let url = format!(
        "{}/api/library/windows/{}",
        base_origin(&conn.host, conn.port),
        window_id
    );
    let resp = http_client()?
        .delete(&url)
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| format!("discarding library window: {e}"))?;
    if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "library window discard returned HTTP {}",
            resp.status()
        ));
    }
    Ok(())
}

/// The `DELETE` URL for unmounting a workspace tenant. The server route is
/// an axum wildcard, so `prefix` (an absolute route path like
/// `/api/notes-1a2b3c`) is appended verbatim after the collection path.
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

/// `DELETE /api/devserver/workspaces/{prefix}`: unmount a workspace tenant
/// from the devserver (the "Forget" action).
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
        let resp = gateway_request(gw, reqwest::Method::DELETE, &path)
            .await
            .map_err(SetWorkspaceOnError::other)?;
        if !resp.status().is_success() {
            return Err(SetWorkspaceOnError::other(format!(
                "gateway workspace delete returned HTTP {}",
                resp.status()
            )));
        }
        return Ok(());
    }
    let url = workspace_delete_url(&conn.host, conn.port, prefix, force);
    let resp = http_client()
        .map_err(SetWorkspaceOnError::other)?
        .delete(&url)
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| SetWorkspaceOnError::other(format!("forgetting devserver workspace: {e}")))?;
    if resp.status() == reqwest::StatusCode::CONFLICT {
        let active_terminals = resp
            .json::<ActiveTerminalsRejection>()
            .await
            .map(|r| r.active_terminals)
            .unwrap_or(0);
        return Err(SetWorkspaceOnError::ActiveTerminals { active_terminals });
    }
    if !resp.status().is_success() {
        return Err(SetWorkspaceOnError::other(format!(
            "devserver workspace delete returned HTTP {}",
            resp.status()
        )));
    }
    Ok(())
}

/// `POST /api/library/windows/{window_id}/visibility` `{hidden}`: set a devserver
/// window's server-persisted visibility. The devserver owns its window
/// registry, so hiding/showing a remote window persists THERE and the desktop
/// mirrors it on the next connect. Distinct from the `/hide`+`/open` bridge ops
/// (transient, non-persistent). Fire-and-forget from the bury/unbury chokepoint.
pub async fn set_window_visibility(
    conn: &DevserverConn,
    window_id: &str,
    hidden: bool,
) -> Result<(), String> {
    if let Some(gw) = &conn.gateway {
        let resp = gateway_request_json(
            gw,
            reqwest::Method::POST,
            &format!("/api/library/windows/{window_id}/visibility"),
            &serde_json::json!({ "hidden": hidden }),
        )
        .await?;
        if !resp.status().is_success() {
            return Err(format!(
                "gateway window visibility returned HTTP {}",
                resp.status()
            ));
        }
        return Ok(());
    }
    let url = format!(
        "{}/api/library/windows/{}/visibility",
        base_origin(&conn.host, conn.port),
        window_id
    );
    let resp = http_client()?
        .post(&url)
        .bearer_auth(&conn.token)
        .json(&serde_json::json!({ "hidden": hidden }))
        .send()
        .await
        .map_err(|e| format!("setting devserver window visibility: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "devserver window visibility returned HTTP {}",
            resp.status()
        ));
    }
    Ok(())
}

/// `PUT /api/library/windows/{window_id}/label` `{label}`: persist the user
/// caption on the devserver that owns a remote non-control window.
pub async fn set_window_label(
    conn: &DevserverConn,
    window_id: &str,
    label: &str,
) -> Result<(), String> {
    let path = format!("/api/library/windows/{window_id}/label");
    if let Some(gw) = &conn.gateway {
        let resp = gateway_request_json(
            gw,
            reqwest::Method::PUT,
            &path,
            &serde_json::json!({ "label": label }),
        )
        .await?;
        if !resp.status().is_success() {
            return Err(format!(
                "gateway window label returned HTTP {}",
                resp.status()
            ));
        }
        return Ok(());
    }
    let url = format!("{}{}", base_origin(&conn.host, conn.port), path);
    let resp = http_client()?
        .put(&url)
        .bearer_auth(&conn.token)
        .json(&serde_json::json!({ "label": label }))
        .send()
        .await
        .map_err(|e| format!("setting devserver window label: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "devserver window label returned HTTP {}",
            resp.status()
        ));
    }
    Ok(())
}

/// The on/off-toggle URL for a registered workspace: the collection path + the
/// prefix (an absolute route path) + `/on`. Distinct from the DELETE URL
/// (= Forget); on/off keeps the registration.
fn workspace_on_url(host: &str, port: u16, prefix: &str) -> String {
    format!(
        "{}/api/devserver/workspaces{}/on",
        base_origin(host, port),
        prefix
    )
}

/// `POST /api/devserver/workspaces/{prefix}/on` `{on, force}`: mount (`on:true`)
/// or unmount (`on:false`) a registered workspace WITHOUT forgetting it. Turning
/// on mints a fresh tenant token; turning off clears it. Idempotent server-side.
/// An unforced off is rejected with 409 + a live-terminal count when the tenant
/// has open terminals -- surfaced as [`SetWorkspaceOnError::ActiveTerminals`] so
/// the SPA can confirm-then-force; `force: true` overrides the guard.
pub async fn set_workspace_on(
    conn: &DevserverConn,
    prefix: &str,
    on: bool,
    force: bool,
) -> Result<(), SetWorkspaceOnError> {
    if let Some(gw) = &conn.gateway {
        let clean = prefix.trim_start_matches('/');
        let resp = gateway_request_json(
            gw,
            reqwest::Method::POST,
            &format!("/api/library/workspaces/{clean}/on"),
            &SetWorkspaceOnRequest { on, force },
        )
        .await
        .map_err(SetWorkspaceOnError::other)?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            let active_terminals = resp
                .json::<ActiveTerminalsRejection>()
                .await
                .map(|r| r.active_terminals)
                .unwrap_or(0);
            return Err(SetWorkspaceOnError::ActiveTerminals { active_terminals });
        }
        if !resp.status().is_success() {
            return Err(SetWorkspaceOnError::other(format!(
                "gateway workspace on/off returned HTTP {}",
                resp.status()
            )));
        }
        return Ok(());
    }
    let url = workspace_on_url(&conn.host, conn.port, prefix);
    let resp = http_client()
        .map_err(SetWorkspaceOnError::other)?
        .post(&url)
        .bearer_auth(&conn.token)
        .json(&SetWorkspaceOnRequest { on, force })
        .send()
        .await
        .map_err(|e| {
            SetWorkspaceOnError::other(format!("setting devserver workspace on/off: {e}"))
        })?;
    if resp.status() == reqwest::StatusCode::CONFLICT {
        // Off blocked by live terminals: surface the count for the confirm.
        let active_terminals = resp
            .json::<ActiveTerminalsRejection>()
            .await
            .map(|r| r.active_terminals)
            .unwrap_or(0);
        return Err(SetWorkspaceOnError::ActiveTerminals { active_terminals });
    }
    if !resp.status().is_success() {
        return Err(SetWorkspaceOnError::other(format!(
            "devserver workspace on/off returned HTTP {}",
            resp.status()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_devserver_url_reads_host_and_explicit_port() {
        assert_eq!(
            parse_devserver_url("http://127.0.0.1:8787").unwrap(),
            ("127.0.0.1".to_string(), 8787)
        );
    }

    #[test]
    fn parse_devserver_url_defaults_port_from_scheme() {
        assert_eq!(
            parse_devserver_url("https://box.example.com").unwrap(),
            ("box.example.com".to_string(), 443)
        );
        assert_eq!(
            parse_devserver_url("http://box.example.com").unwrap(),
            ("box.example.com".to_string(), 80)
        );
    }

    #[test]
    fn parse_devserver_url_rejects_bare_host_port_and_garbage() {
        // Bare host:port has no scheme -- the launcher requires scheme://host.
        assert!(parse_devserver_url("127.0.0.1:8787").is_err());
        assert!(parse_devserver_url("not a url").is_err());
        assert!(parse_devserver_url("").is_err());
    }

    fn valid_gateway_discovery() -> GatewayDiscovery {
        GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "https://gw.chan.app".into(),
            desktop_authorize_url: "https://gw.chan.app/desktop/authorize".into(),
            desktop_entry_url: "https://gw.chan.app/desktop/v1/devserver/entry".into(),
            devserver_proxy_origin: "https://usr.chan.app".into(),
            devserver_proxy_host_depth: 2,
            roster_url: Some("https://gw.chan.app/desktop/v1/devservers".into()),
        }
    }

    #[test]
    fn gateway_discovery_accepts_same_origin_https() {
        let d = validate_gateway_discovery("https://gw.chan.app", valid_gateway_discovery())
            .expect("valid gateway discovery");
        assert_eq!(d.identity_origin, "https://gw.chan.app");
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
        d.desktop_entry_url = "https://evil.example/desktop/v1/devserver/entry".into();
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(err.contains("cross-origin"), "{err}");
    }

    #[test]
    fn gateway_discovery_rejects_http_for_non_loopback() {
        let mut d = valid_gateway_discovery();
        d.identity_origin = "http://gw.chan.app".into();
        d.desktop_authorize_url = "http://gw.chan.app/desktop/authorize".into();
        d.desktop_entry_url = "http://gw.chan.app/desktop/v1/devserver/entry".into();
        d.devserver_proxy_origin = "http://usr.chan.app".into();
        d.roster_url = Some("http://gw.chan.app/desktop/v1/devservers".into());
        let err = validate_gateway_discovery("http://gw.chan.app", d).unwrap_err();
        assert!(err.contains("must use https"), "{err}");
    }

    #[test]
    fn gateway_discovery_allows_http_loopback_dev() {
        let d = GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "http://localhost:7000".into(),
            desktop_authorize_url: "http://localhost:7000/desktop/authorize".into(),
            desktop_entry_url: "http://localhost:7000/desktop/v1/devserver/entry".into(),
            devserver_proxy_origin: "http://127.0.0.1:7002".into(),
            devserver_proxy_host_depth: 2,
            roster_url: None,
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
            proxy_origin: "https://alice--aaaaaaaaaaaa.p1.usr.chan.app".into(),
            entry_exchange_url: "https://alice--aaaaaaaaaaaa.p1.usr.chan.app/_chan/entry".into(),
            entry_credential: "sentinel-entry-credential".into(),
        };
        let gw = GatewayConn::new(
            "https://gw.chan.app".into(),
            "https://gw.chan.app/desktop/v1/devserver/entry".into(),
            "https://alice--aaaaaaaaaaaa.p1.usr.chan.app".into(),
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
            "/desktop/v1/devserver/entry",
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
            desktop_authorize_url: format!("{identity_origin}/desktop/authorize"),
            desktop_entry_url: format!("{identity_origin}/desktop/v1/devserver/entry"),
            devserver_proxy_origin: proxy_apex,
            devserver_proxy_host_depth: 2,
            roster_url: None,
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
                "/desktop/v1/devserver/entry",
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
            desktop_authorize_url: format!("{identity_origin}/desktop/authorize"),
            desktop_entry_url: format!("{identity_origin}/desktop/v1/devserver/entry"),
            devserver_proxy_origin: proxy_apex,
            devserver_proxy_host_depth: 2,
            roster_url: None,
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
    fn gateway_discovery_tolerates_absent_roster_url() {
        // Older gateways omit the field entirely; discovery stays valid and
        // the desktop reports "too old for account mode" instead of failing.
        let mut d = valid_gateway_discovery();
        d.roster_url = None;
        validate_gateway_discovery("https://gw.chan.app", d).expect("absent roster_url is valid");
    }

    #[test]
    fn gateway_discovery_rejects_cross_origin_or_http_roster_url() {
        let mut d = valid_gateway_discovery();
        d.roster_url = Some("https://evil.example/desktop/v1/devservers".into());
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(err.contains("cross-origin"), "{err}");

        let mut d = valid_gateway_discovery();
        d.roster_url = Some("http://gw.chan.app/desktop/v1/devservers".into());
        let err = validate_gateway_discovery("https://gw.chan.app", d).unwrap_err();
        assert!(
            err.contains("cross-origin") || err.contains("must use https"),
            "{err}"
        );
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
    fn devserver_info_decodes_the_wire_shape() {
        let json = r#"{"devserver_version":"0.38.0","protocol":1,"host_label":"lab box"}"#;
        let info: DevserverInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.devserver_version, "0.38.0");
        assert_eq!(info.protocol, 1);
        assert_eq!(info.host_label, "lab box");
    }

    #[test]
    fn parse_host_os_meta_reads_the_injected_descriptor() {
        // The exact shape `inject_launcher_meta` emits, among its siblings.
        let html = "<!doctype html><html><head>\
             <meta name=\"chan-launcher-host-os\" content=\"linux\">\
             <meta name=\"chan-launcher-surface\" content=\"devserver\">\
             </head><body></body></html>";
        assert_eq!(parse_host_os_meta(html).as_deref(), Some("linux"));
    }

    #[test]
    fn parse_host_os_meta_tolerates_attribute_order_and_spacing() {
        let html = "<head><meta  content=\"macos\"  name=\"chan-launcher-host-os\" ></head>";
        assert_eq!(parse_host_os_meta(html).as_deref(), Some("macos"));
    }

    #[test]
    fn parse_host_os_meta_is_none_without_the_descriptor() {
        // A shell from a devserver too old to inject it: other metas only.
        let html = "<head><meta name=\"viewport\" content=\"width=device-width\"></head>";
        assert_eq!(parse_host_os_meta(html), None);
        assert_eq!(parse_host_os_meta(""), None);
    }

    #[test]
    fn parse_host_os_meta_is_none_on_an_empty_value() {
        let html = "<head><meta name=\"chan-launcher-host-os\" content=\"\"></head>";
        assert_eq!(parse_host_os_meta(html), None);
    }

    #[test]
    fn workspace_entry_decodes_a_bare_array_element() {
        let json = r#"[{"prefix":"/api/notes-1a2b3c","path":"/home/a/notes","label":"notes","on":true,"token":"tok_abc"}]"#;
        let entries: Vec<WorkspaceEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].prefix, "/api/notes-1a2b3c");
        assert_eq!(entries[0].path, "/home/a/notes");
        assert_eq!(entries[0].label, "notes");
        assert!(entries[0].on);
        assert_eq!(entries[0].status, chan_server::WorkspaceStatus::Stopped);
        assert_eq!(entries[0].error, None);
        assert_eq!(entries[0].token, "tok_abc");
    }

    #[test]
    fn workspace_delete_url_appends_the_prefix_verbatim() {
        assert_eq!(
            workspace_delete_url("127.0.0.1", 8787, "/api/notes-1a2b3c", false),
            "http://127.0.0.1:8787/api/devserver/workspaces/api/notes-1a2b3c"
        );
        assert_eq!(
            workspace_delete_url("127.0.0.1", 8787, "/api/notes-1a2b3c", true),
            "http://127.0.0.1:8787/api/devserver/workspaces/api/notes-1a2b3c?force=true"
        );
    }

    #[test]
    fn workspace_on_url_appends_prefix_and_on() {
        assert_eq!(
            workspace_on_url("127.0.0.1", 8787, "/api/notes-1a2b3c"),
            "http://127.0.0.1:8787/api/devserver/workspaces/api/notes-1a2b3c/on"
        );
    }

    #[test]
    fn set_workspace_on_request_serializes_on_and_force_fields() {
        assert_eq!(
            serde_json::to_string(&SetWorkspaceOnRequest {
                on: false,
                force: false
            })
            .unwrap(),
            r#"{"on":false,"force":false}"#
        );
        assert_eq!(
            serde_json::to_string(&SetWorkspaceOnRequest {
                on: true,
                force: true
            })
            .unwrap(),
            r#"{"on":true,"force":true}"#
        );
    }

    #[test]
    fn row_from_entry_off_row_has_no_url_on_row_has_one() {
        let conn = DevserverConn {
            host: "127.0.0.1".into(),
            port: 8787,
            token: "dt".into(),
            name: "box".into(),
            gateway: None,
        };
        // Off (registered-but-unmounted): token:"" ⇒ empty URL.
        let off = WorkspaceEntry {
            prefix: "/api/notes-1a2b3c".into(),
            path: "/home/a/notes".into(),
            label: "notes".into(),
            on: false,
            status: chan_server::WorkspaceStatus::Stopped,
            error: None,
            token: String::new(),
        };
        let row = row_from_entry(&conn, off).unwrap();
        assert!(!row.on);
        assert_eq!(row.url, "");
        // On: a live token assembles the tenant URL.
        let on = WorkspaceEntry {
            prefix: "/api/notes-1a2b3c".into(),
            path: "/home/a/notes".into(),
            label: "notes".into(),
            on: true,
            status: chan_server::WorkspaceStatus::Running,
            error: None,
            token: "tok_live".into(),
        };
        let row = row_from_entry(&conn, on).unwrap();
        assert!(row.on);
        assert_eq!(
            row.url,
            "http://127.0.0.1:8787/api/notes-1a2b3c/index.html?t=tok_live"
        );
    }

    #[tokio::test]
    async fn gateway_workspace_poll_row_does_not_mint_entry_url() {
        let conn = DevserverConn {
            host: "alice--aaaaaaaaaaaa.p1.usr.chan.app".into(),
            port: 443,
            token: String::new(),
            name: "alice".into(),
            gateway: Some(Box::new(GatewayConn::new(
                "https://gw.chan.app".into(),
                "http://127.0.0.1:9/desktop/v1/devserver/entry".into(),
                "https://alice--aaaaaaaaaaaa.p1.usr.chan.app".into(),
                "pat".into(),
            ))),
        };
        let row = row_from_launcher(
            &conn,
            chan_server::LauncherWorkspace {
                workspace_id: "notes".into(),
                path: "/repo/notes".into(),
                status: chan_server::WorkspaceStatus::Running,
                error: None,
                label: "notes".into(),
                on: true,
                library_id: Some("lib-1".into()),
                devserver_id: Some("ds-1".into()),
                prefix: "notes".into(),
            },
        )
        .await
        .expect("row conversion should not call desktop_entry_url");
        assert_eq!(
            row.url,
            "https://alice--aaaaaaaaaaaa.p1.usr.chan.app/notes/index.html"
        );
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
                    "https://alice--aaaaaaaaaaaa.p1.usr.chan.app".into(),
                    "https://usr.chan.app".into(),
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
            app: None,
            title: "Terminal Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: prefix.into(),
            token: token.into(),
            persisted: true,
            connected: false,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::default(),
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
                "/desktop/v1/devserver/entry",
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
        let conn = gateway_test_conn(format!("http://{addr}/desktop/v1/devserver/entry"));
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
        let conn = gateway_test_conn("http://127.0.0.1:9/desktop/v1/devserver/entry".into());
        let record = window_row("w-1", "/notes-1a2b3c", "tok_local_1");
        assert!(window_navigation_url(&conn, &record).await.is_err());
    }

    #[tokio::test]
    async fn more_than_session_cap_navigations_reuse_one_opaque_session() {
        let conn = gateway_test_conn("http://127.0.0.1:9/desktop/v1/devserver/entry".into());
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
    fn refresh_delay_tracks_the_cached_session_and_skips_loopback_conns() {
        fn session(expires_at: Instant) -> GatewaySession {
            GatewaySession {
                gate: "g".into(),
                cookie_header: "__Host-devserver_gate=g".into(),
                csrf: "c".into(),
                expires_at,
            }
        }

        let conn = gateway_test_conn("http://127.0.0.1:9/entry".into());
        // Nothing minted yet: due now, and there is no header to hand back.
        assert_eq!(gateway_session_refresh_delay(&conn), Some(Duration::ZERO));
        assert_eq!(cached_gateway_cookie_header(&conn), None);

        let gw = conn.gateway.as_ref().unwrap();
        *gw.session.lock().unwrap() = Some(session(Instant::now() + Duration::from_secs(600)));
        let delay = gateway_session_refresh_delay(&conn).expect("gateway conn");
        assert!(
            delay > Duration::from_secs(590) && delay <= Duration::from_secs(600),
            "{delay:?}"
        );
        assert_eq!(
            cached_gateway_cookie_header(&conn).as_deref(),
            Some("__Host-devserver_gate=g")
        );

        // A session already past its expiry reports zero rather than saturating
        // backwards: the resumed-from-sleep case, where the re-mint is overdue.
        *gw.session.lock().unwrap() = Some(session(Instant::now()));
        assert_eq!(gateway_session_refresh_delay(&conn), Some(Duration::ZERO));

        // A plain loopback devserver holds no gateway session to keep fresh, so
        // the refresh loop exits instead of polling it forever.
        let loopback = DevserverConn {
            host: "127.0.0.1".into(),
            port: 1234,
            token: "t".into(),
            name: "local".into(),
            gateway: None,
        };
        assert_eq!(gateway_session_refresh_delay(&loopback), None);
        assert_eq!(cached_gateway_cookie_header(&loopback), None);
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
        let conn = gateway_test_conn("https://gw.chan.app/desktop/v1/devserver/entry".into());
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
                "/desktop/v1/devserver/entry",
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
        let conn = gateway_test_conn(format!("http://{addr}/desktop/v1/devserver/entry"));
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
    async fn gateway_csrf_token_refuses_foreign_origins_and_non_library_labels() {
        let conn = gateway_test_conn("https://gw.chan.app/desktop/v1/devserver/entry".into());
        let gw = conn.gateway.as_ref().unwrap();
        *gw.session.lock().unwrap() = Some(GatewaySession {
            gate: "gate-current".into(),
            cookie_header: "__Host-devserver_gate=gate-current; __Host-devserver_csrf=csrf-current"
                .into(),
            csrf: "csrf-current".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
        });
        let own_url = url::Url::parse(&format!("{}/notes", gw.proxy_origin)).unwrap();
        assert_eq!(
            gateway_csrf_token_for_connection(&conn, "lib-1::w-1", &own_url)
                .await
                .as_deref(),
            Ok("csrf-current")
        );

        let foreign = url::Url::parse("https://bob--bbbbbbbbbbbb.p1.usr.chan.app/").unwrap();
        assert!(
            gateway_csrf_token_for_connection(&conn, "lib-1::w-1", &foreign)
                .await
                .unwrap_err()
                .contains("origin does not match")
        );
        assert!(
            gateway_csrf_token_for_connection(&conn, "settings", &own_url)
                .await
                .unwrap_err()
                .contains("unavailable to this window")
        );
    }

    #[tokio::test]
    async fn expired_session_is_not_reused_for_clean_navigation() {
        let conn = gateway_test_conn("http://127.0.0.1:9/desktop/v1/devserver/entry".into());
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
    fn scrape_token_reads_the_marker_line() {
        // The locked machine marker, e.g. surfaced through a journalctl follow.
        let out = "some boot noise\nJun 17 host chan[12]: CHAN_DEVSERVER_TOKEN=tok_abc123\n$ ";
        assert_eq!(scrape_token(out).as_deref(), Some("tok_abc123"));
    }

    #[test]
    fn scrape_token_takes_the_last_occurrence_across_restarts() {
        let out = "CHAN_DEVSERVER_TOKEN=old_TOKEN\n[restart]\nCHAN_DEVSERVER_TOKEN=new-TOKEN_2\n";
        assert_eq!(scrape_token(out).as_deref(), Some("new-TOKEN_2"));
    }

    #[test]
    fn scrape_token_takes_the_rotated_marker_over_the_pre_rotation_one() {
        // A `chan devserver --rotate-token` re-emits the marker into the
        // same control-terminal scrollback the pre-rotation start wrote:
        // the scrape must hand every later connect the NEW bearer. Red
        // mutation: `rmatch_indices` -> `match_indices` in `scrape_token`.
        let out = "chan devserver: listening on http://127.0.0.1:8787/?t=tok_before\n\
                   CHAN_DEVSERVER_TOKEN=tok_before\n\
                   chan devserver: token rotated; the old bearer no longer authorizes\n\
                   chan devserver: listening on http://127.0.0.1:8787/?t=tok_after\n\
                   CHAN_DEVSERVER_TOKEN=tok_after\n";
        assert_eq!(scrape_token(out).as_deref(), Some("tok_after"));
    }

    #[test]
    fn scrape_token_stops_at_ansi_or_whitespace() {
        // Raw PTY bytes carry ANSI; the token run stops at the escape byte.
        let out = "CHAN_DEVSERVER_TOKEN=tok_xyz\x1b[0m extra";
        assert_eq!(scrape_token(out).as_deref(), Some("tok_xyz"));
    }

    #[test]
    fn scrape_token_none_when_absent_or_empty() {
        assert_eq!(scrape_token("no token here\n$ "), None);
        assert_eq!(scrape_token("CHAN_DEVSERVER_TOKEN= \nnext"), None);
        // A loose `token=` (human-readable line) is NOT the machine marker.
        assert_eq!(
            scrape_token("chan devserver: bind=… token=tok_loose\n"),
            None
        );
    }

    #[test]
    fn scrape_token_ignores_the_w5_running_banner() {
        // The terminal layer prepends a `running: {command}\r\n` banner to
        // the control terminal's scrollback before the connect script runs -- it is
        // the FIRST ring bytes, ahead of any token the devserver emits. Confirm it
        // can't disturb the scrape.
        //
        // 1. A real connect-script command never contains the marker (the token is
        //    runtime-generated by `chan devserver`, not passed in), so the banner is
        //    inert and the real token is read.
        let out = "running: ssh box -L 8787:localhost:8787 chan devserver\r\n\
                   CHAN_DEVSERVER_TOKEN=tok_real123\r\n$ ";
        assert_eq!(scrape_token(out).as_deref(), Some("tok_real123"));
        // 2. Even pathologically -- a command string that literally embeds the marker
        //    -- the banner is the FIRST bytes and `scrape_token` takes the LAST marker
        //    (`rmatch_indices`), so the devserver's real token (emitted AFTER the
        //    script connects) still wins; the banner's marker is never reached.
        let pathological = "running: CHAN_DEVSERVER_TOKEN=from_command chan devserver\r\n\
                            CHAN_DEVSERVER_TOKEN=tok_real456\r\n$ ";
        assert_eq!(scrape_token(pathological).as_deref(), Some("tok_real456"));
    }

    #[test]
    fn local_devserver_config_reads_token_and_port() {
        // The desktop reads the token + the bound port; legacy/unknown keys are
        // ignored, and an absent port defaults to 0 (an older config).
        let json = r#"{"devserver_token":"tok_box","port":9605,"workspaces":[],"terminals":[]}"#;
        let cfg: LocalDevserverConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.devserver_token, "tok_box");
        assert_eq!(cfg.port, 9605);

        let no_port = r#"{"devserver_token":"tok_box"}"#;
        let cfg: LocalDevserverConfig = serde_json::from_str(no_port).unwrap();
        assert_eq!(cfg.port, 0);
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
}
