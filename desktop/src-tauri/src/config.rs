//! Desktop-only config.
//!
//! The chan registry (`~/.chan/config.toml`) is the source of truth
//! for which workspaces exist. This file holds only desktop-specific
//! state that has no place in chan proper:
//!
//! - `outbound`: remote-workspace URLs the user explicitly attached.
//!   The desktop owns only the webview/window state for these
//!   entries, not the remote process or token lifecycle.
//! - `window_configs`: LRU stack of closed-window labels + URL hashes
//!   so a freshly-opened workspace window picks up the panes / tabs /
//!   selections / overlay state of the previous window for that
//!   workspace instead of starting blank.
//!
//! Per-workspace serve URLs are intentionally NOT persisted: chan rotates
//! the bearer token on every `chan open`, so a saved URL would
//! decay to garbage between launches. The URL lives in `AppState`
//! in memory while a serve is running, and the desktop webview
//! reloads it fresh on every On toggle.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chan_server::{
    DevserverEntry, DevserverInput, DevserverRegistry, DevserverStatus, GatewayEntry, GatewayInput,
    GatewayRegistry,
};
use serde::{Deserialize, Serialize};

use crate::devserver::DevserverConns;

/// Cap on how many window configs we retain in the LRU stack.
/// Newest first; older entries past the cap are evicted on save.
/// Twenty is roomy enough for several concurrently-open workspaces
/// without risking unbounded growth from an open-close-reopen loop.
pub const MAX_WINDOW_CONFIGS: usize = 20;

/// Cap on how many distinct monitor signatures we remember per window in the
/// geometry LRU. Five covers a laptop that docks / undocks across a couple of
/// external-monitor layouts and flips back without losing any layout's stored
/// size + position. Newest signature first; older ones evicted past the cap.
pub const MAX_WINDOW_GEOMETRIES: usize = 5;

/// An already-running chan server that chan-desktop opens by URL.
/// The URL may carry a bearer token. It is persisted verbatim after
/// validation because the remote server owns token rotation and
/// shutdown; desktop owns only the attachment row and webview
/// window state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutboundWorkspace {
    /// Stable desktop-local identifier used for row actions and
    /// window restore. Not sent to the remote server.
    pub id: String,
    /// User-pasted HTTP(S) URL, including any bearer token.
    pub url: String,
    /// Optional user label for the launcher row and window title.
    #[serde(default)]
    pub label: String,
    /// Wall-clock millis when the attachment was created.
    #[serde(default)]
    pub added_at: u64,
}

/// A devserver the desktop dials out to: a headless `chan devserver`
/// running on some box (often reached over an `ssh -L` local forward).
/// Unlike `OutboundWorkspace` (one remote URL = one workspace), a
/// devserver is a multi-workspace aggregator: the desktop groups its
/// workspaces under one `[DEVSERVER {host}]` launcher section and drives
/// them through the devserver's management API.
///
/// This struct is the *local* connection recipe only: the full devserver URL
/// (scheme included) the desktop dials plus the user's connect `script` (the
/// control terminal runs it, e.g. an `ssh -L` invocation). The devserver owns
/// the per-workspace URLs/tokens and their lifecycle; the desktop persists
/// just enough to re-offer the connection and re-open its windows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Devserver {
    /// Stable desktop-local identifier used for row actions, window
    /// restore, and the in-memory connection-state map. Not sent to the
    /// devserver.
    pub id: String,
    /// The full devserver URL the desktop dials, scheme included
    /// (`https://box.example.com:8787`, or `http://127.0.0.1:8787` for an
    /// `ssh -L` loopback forward). The scheme is load-bearing: the dial path
    /// branches raw-tunnel vs proxied-HTTPS on it (the proxied + OAuth branch
    /// is a deferred follow-up). The parsed host is also the default
    /// `[DEVSERVER {host}]` section label until the devserver reports its own
    /// `host_label`. A missing port defaults from the scheme at dial time.
    pub url: String,
    /// The connect script the CONTROL TERMINAL runs in its PTY (typically
    /// an `ssh user@box -L {port}:localhost:{port} chan devserver ...`).
    /// It blocks for the life of the session; its return means the
    /// session ended (the CONTROL TERMINAL then offers re-run / disconnect).
    #[serde(default)]
    pub script: String,
    /// Optional user label for the launcher section header and window
    /// titles. Empty falls back to the URL host.
    #[serde(default)]
    pub label: String,
    /// Bearer token for the devserver. Write-only over the launcher wire: the
    /// registry reports its presence via `has_token` and never echoes the
    /// value back. Stored so a connect script can be just the transport setup
    /// (for example `ssh -N`) while the credential comes from the Address URL;
    /// empty means scrape/read a fresh token at dial.
    #[serde(default)]
    pub token: String,
    /// Wall-clock millis when the devserver was added.
    #[serde(default)]
    pub added_at: u64,
    /// Whether the control terminal auto-hides on a successful connect (the
    /// devserver form's "auto-hide control terminal on success" checkbox). The
    /// connect flow reads it to hide the control terminal programmatically (no
    /// bury notice) once connected.
    #[serde(default)]
    pub auto_hide_control: bool,
    /// Legacy markers from the retired pick-one gateway flow: the picked
    /// devserver's OWNER username plus its full id, recorded by sign-in
    /// callbacks before gateways became first-class. Nothing writes them
    /// anymore; the startup migration reads them to convert the row into a
    /// [`Gateway`] entry (and clears them on a row it keeps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_devserver_id: Option<String>,
}

/// Persisted consent for one shared devserver's exact gateway identity.
/// Labels, proxy origins, and short discriminators are intentionally absent:
/// authority is keyed by immutable owner UUID plus the full devserver id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeDevserverTrust {
    /// None only on legacy records. Legacy username-keyed trust is retained
    /// for readable config migration but never authorizes native IPC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<uuid::Uuid>,
    pub owner: String,
    pub devserver_id: String,
}

/// A gateway the desktop holds an account-level connection to: the public
/// identity origin the user added on the launcher's Gateways screen. The
/// desktop signs in once per gateway account, polls the gateway's devserver
/// roster, and synthesizes the rostered devservers into the launcher list.
/// Only this connection recipe persists; roster rows are volatile and the
/// account PAT lives in the OS keyring (keyed by the identity origin), so a
/// removed-then-re-added gateway reconnects without a fresh sign-in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Gateway {
    /// Stable desktop-minted id (`gw-` + 8 lowercase hex). The hex segment
    /// (sans prefix) rides inside synthesized devserver row ids, whose
    /// charset is pinned to `[A-Za-z0-9_-]`.
    pub id: String,
    /// The gateway's public identity origin, scheme included, no path
    /// (`https://gw.chan.app`). Normalized to an origin at add time.
    pub url: String,
    /// Optional user label for the gateway badge; empty falls back to the
    /// URL host.
    #[serde(default)]
    pub label: String,
    /// Connect intent: enabled gateways auto-connect at startup. Connect
    /// persists `true`, disconnect persists `false`. Defaults `true` so a
    /// hand-added row behaves like a freshly added one.
    #[serde(default = "gateway_enabled_default")]
    pub enabled: bool,
    /// Wall-clock millis when the gateway was added (or when its legacy
    /// devserver row was converted).
    #[serde(default)]
    pub added_at: u64,
    /// Shared devservers the user has allowed to receive native IPC. Trust is
    /// scoped by this enclosing gateway row and survives disconnect/restart;
    /// removing the gateway removes the records with it.
    #[serde(default)]
    pub native_trust: Vec<NativeDevserverTrust>,
}

impl Gateway {
    pub fn trusts_native(&self, owner_user_id: uuid::Uuid, devserver_id: &str) -> bool {
        self.native_trust.iter().any(|trust| {
            trust.owner_user_id == Some(owner_user_id) && trust.devserver_id == devserver_id
        })
    }
}

/// Read one persisted shared-devserver trust decision. The gateway row is the
/// outer trust boundary, so an absent gateway is an error rather than an
/// untrusted answer that might hide a mid-flight removal.
pub fn native_trust(
    store: &Arc<Mutex<ConfigStore>>,
    gateway_id: &str,
    owner_user_id: uuid::Uuid,
    devserver_id: &str,
) -> Result<bool, String> {
    let cfg = store.lock().unwrap().get().map_err(|e| e.to_string())?;
    let gateway = cfg
        .gateways
        .iter()
        .find(|gateway| gateway.id == gateway_id)
        .ok_or_else(|| format!("no gateway {gateway_id}"))?;
    Ok(gateway.trusts_native(owner_user_id, devserver_id))
}

/// Persist or remove one exact shared-devserver trust tuple. Returns whether
/// the file changed; repeated PUT/DELETE operations are idempotent.
pub fn set_native_trust(
    store: &Arc<Mutex<ConfigStore>>,
    gateway_id: &str,
    owner_user_id: uuid::Uuid,
    owner: &str,
    devserver_id: &str,
    trusted: bool,
) -> Result<bool, String> {
    let mut store = store.lock().unwrap();
    let mut cfg = store.get().map_err(|e| e.to_string())?;
    let gateway = cfg
        .gateways
        .iter_mut()
        .find(|gateway| gateway.id == gateway_id)
        .ok_or_else(|| format!("no gateway {gateway_id}"))?;
    let present = gateway.trusts_native(owner_user_id, devserver_id);
    if present == trusted {
        return Ok(false);
    }
    if trusted {
        gateway.native_trust.push(NativeDevserverTrust {
            owner_user_id: Some(owner_user_id),
            owner: owner.to_string(),
            devserver_id: devserver_id.to_string(),
        });
    } else {
        gateway.native_trust.retain(|trust| {
            trust.owner_user_id != Some(owner_user_id) || trust.devserver_id != devserver_id
        });
    }
    store.save(&cfg).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Cleanup-only removal for a roster row that disappeared before its UUID can
/// be read from the new snapshot. This never grants authority.
pub fn prune_native_trust_by_label(
    store: &Arc<Mutex<ConfigStore>>,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<bool, String> {
    let mut store = store.lock().unwrap();
    let mut cfg = store.get().map_err(|e| e.to_string())?;
    let gateway = cfg
        .gateways
        .iter_mut()
        .find(|gateway| gateway.id == gateway_id)
        .ok_or_else(|| format!("no gateway {gateway_id}"))?;
    let before = gateway.native_trust.len();
    gateway
        .native_trust
        .retain(|trust| trust.owner != owner || trust.devserver_id != devserver_id);
    if gateway.native_trust.len() == before {
        return Ok(false);
    }
    store.save(&cfg).map_err(|e| e.to_string())?;
    Ok(true)
}

fn gateway_enabled_default() -> bool {
    true
}

/// Per-window layout snapshot pushed when a workspace webview closes,
/// popped when the same workspace opens its next webview. The Tauri
/// window label is the join key: reusing it forwards the SPA's
/// `?w=<label>` lookup so the per-window `session.json` in the
/// workspace hydrates the panes / tabs that were open before. The URL
/// hash carries the overlay state (file browser selection, search
/// query, graph scope, etc.) that chan deliberately keeps out of
/// `session.json` so shareable URLs stay shareable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    /// Workspace identity:
    ///   * local workspaces: canonical filesystem path (matches the
    ///     `AppState.serves` key).
    ///   * remote (devserver) workspaces: `"remote:<id>"`, namespaced by the
    ///     desktop-local attachment id because the URL can change.
    pub key: String,
    /// Tauri window label this config was last bound to. The label
    /// is hash-prefixed (`workspace-<16hex>-<seq>`) so it implicitly
    /// encodes the workspace identity too -- reusing it produces the
    /// same prefix and the per-workspace close-on-exit cleanup walker
    /// still matches.
    pub window_label: String,
    /// URL hash (everything after `#`, without the leading hash
    /// character). Empty when the SPA never wrote a hash. Applied
    /// verbatim on the next open so file-browser selection, search
    /// query, graph scope, and other overlay-encoded knobs round
    /// trip across the close/open cycle.
    #[serde(default)]
    pub url_hash: String,
    /// Browser-style zoom level, 1.0 = 100 %. Persists across the
    /// close/open cycle so Cmd++ / Cmd+- / Cmd+0 chord state
    /// survives a session restart. `#[serde(default
    /// = "default_zoom")]` keeps `config.json` entries without the
    /// field loadable (missing reads as 1.0).
    #[serde(default = "default_zoom")]
    pub zoom_level: f64,
    /// Wall-clock millis when this config was pushed. Newest first
    /// in the stack; only used for diagnostics + LRU eviction.
    pub saved_at: u64,
}

fn default_zoom() -> f64 {
    1.0
}

/// Plain monitor descriptor, decoupled from Tauri so the geometry math stays
/// unit-testable without a window system (this module links no Tauri). `serve`
/// maps each `tauri::Monitor` to one of these: the full bounds + `scale` form
/// the monitor SIGNATURE; the `work_*` usable area drives the on-screen clamp.
/// Physical pixels throughout (OS desktop coordinates).
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorDesc {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub work_x: i32,
    pub work_y: i32,
    pub work_w: u32,
    pub work_h: u32,
    pub scale: f64,
}

/// The same descriptor in LOGICAL points: every physical bound divided by the
/// monitor's own scale. tao reports monitor bounds as points times that
/// monitor's scale, so mixed-scale monitors can OVERLAP in physical space;
/// dividing each back to points restores the single, non-overlapping global
/// points map that stored window geometry (also points) is identified and
/// clamped against.
pub fn to_points(m: &MonitorDesc) -> MonitorDesc {
    let s = if m.scale > 0.0 { m.scale } else { 1.0 };
    MonitorDesc {
        x: (m.x as f64 / s).round() as i32,
        y: (m.y as f64 / s).round() as i32,
        w: (m.w as f64 / s).round() as u32,
        h: (m.h as f64 / s).round() as u32,
        work_x: (m.work_x as f64 / s).round() as i32,
        work_y: (m.work_y as f64 / s).round() as i32,
        work_w: (m.work_w as f64 / s).round() as u32,
        work_h: (m.work_h as f64 / s).round() as u32,
        scale: m.scale,
    }
}

/// One captured OS window geometry, tagged with the monitor signature it was
/// captured under. LOGICAL points (the global AppKit window coordinate space):
/// points tile cleanly across mixed-DPI monitors and are scale-independent to
/// apply, so a restore lands at the right size and monitor even when the window
/// is rebuilt hidden on a different-scale display. `x,y` is the OUTER (top-left)
/// position; `w,h` the INNER (content) size, each converted from
/// `WebviewWindow::{outer_position, inner_size}` at capture via the window's
/// scale factor and re-applied as `LogicalPosition` / `LogicalSize` at build.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowGeometry {
    /// Monitor signature at capture time (see [`monitor_signature`]). The
    /// geometry is only re-applied as a full restore when the live signature
    /// matches, so a stored `x,y` can't open a window off a desktop it no
    /// longer fits.
    pub monitor_sig: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// Wall-clock millis at capture; newest first within a record's
    /// per-signature LRU. Diagnostics + eviction order only.
    pub saved_at: u64,
}

/// Desktop-owned OS window geometry for one window, with a small
/// per-monitor-signature LRU so a machine that flips monitor layout and back
/// restores each layout's own size + position. Keyed by the (stable across a
/// bury / reopen) native window label -- sibling to [`WindowConfig`], which holds
/// SPA restore state for outbound windows only. Geometry lives here for ALL
/// window classes (local / devserver / outbound) because only chan-desktop can
/// read / set OS window pixels -- even when the SPA session itself is server-owned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowGeometryRecord {
    /// Native Tauri window label -- the join key. Stable across a bury / reopen:
    /// outbound windows reuse their label; watcher windows reopen at the same
    /// `{library_id}::{window_id}`.
    pub window_label: String,
    /// Per-signature geometry LRU, newest first, capped at
    /// [`MAX_WINDOW_GEOMETRIES`].
    #[serde(default)]
    pub geometries: Vec<WindowGeometry>,
    /// Wall-clock millis of the most recent capture for this window; newest
    /// record first in the stack. Diagnostics + LRU eviction.
    pub saved_at: u64,
}

/// Result of resolving a window's stored geometry against the CURRENT monitor
/// signature ([`lookup_window_geometry`]).
#[derive(Debug, Clone, PartialEq)]
pub enum GeometryMatch {
    /// Signature matched (same monitor hardware): high confidence -- restore the
    /// stored position + size.
    Exact(WindowGeometry),
    /// No signature match (monitor layout changed): lower confidence, but still
    /// restore the most-recent stored geometry. The apply path clamps it to the
    /// monitor the stored position falls on, preserving the position when it is
    /// on-screen rather than centering + shrinking on the primary.
    Fallback(WindowGeometry),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// Explicit outbound URL attachments. These are non-owned
    /// remote workspaces that desktop opens by URL.
    #[serde(default)]
    pub outbound: Vec<OutboundWorkspace>,
    /// Configured devservers (multi-workspace aggregators the desktop
    /// dials out to). Each renders its own `[DEVSERVER {host}]` launcher
    /// section. The per-workspace URLs/tokens are NOT persisted (the
    /// devserver rotates them); only the connection recipe is.
    #[serde(default)]
    pub devservers: Vec<Devserver>,
    /// Configured gateways: account-level connections whose devserver
    /// rosters the desktop synthesizes into the launcher list. Only the
    /// connection recipe persists (see [`Gateway`]); the rostered rows are
    /// volatile. `#[serde(default)]`: configs predating gateways read empty,
    /// and a downgrade ignores the unknown field.
    #[serde(default)]
    pub gateways: Vec<Gateway>,
    /// LRU stack of closed window configs. Newest at index 0. A
    /// fresh workspace webview pops the most-recent matching entry on
    /// open so the user re-enters the same panes / tabs / overlays
    /// they left behind. Capped at `MAX_WINDOW_CONFIGS`; oldest
    /// evicted past that.
    #[serde(default)]
    pub window_configs: Vec<WindowConfig>,
    /// Desktop-owned OS window geometry, one [`WindowGeometryRecord`] per window
    /// label, each with its own per-monitor-signature LRU. Sibling to
    /// `window_configs` (which is outbound-only SPA restore state): geometry is
    /// keyed by the stable native label and covers every window class, since only
    /// the desktop can read / set OS window pixels. Newest record first; capped
    /// at `MAX_WINDOW_CONFIGS` windows.
    #[serde(default)]
    pub window_geometry: Vec<WindowGeometryRecord>,
    /// The LOCAL library's pane-highlight colour (hex `#rrggbb`), or `None` for
    /// the default accent. Backs the [`LocalColorStore`](chan_server::LocalColorStore)
    /// the host reads when minting local windows (terminals + workspaces). The
    /// launcher's local-colour route writes it; the per-devserver colour lives on
    /// each [`Devserver`].
    #[serde(default)]
    pub local_color: Option<String>,
    /// The launcher's light/dark choice (`"dark"` / `"light"`), or `None` to
    /// follow the OS (the default, so shipping this changes nothing until the
    /// user first toggles). Backs the [`LocalThemeStore`](chan_server::LocalThemeStore)
    /// that local standalone terminal windows read + watch; the launcher's
    /// local-theme route writes it. Remote and devserver terminals are unaffected
    /// (their host installs no store).
    #[serde(default)]
    pub launcher_theme: Option<String>,
    /// The launcher's collapsed machine cards -- the `"local"` card and each
    /// devserver keyed by its id. Backs the
    /// [`CollapsedMachinesStore`](chan_server::CollapsedMachinesStore) the
    /// launcher reconciles against on boot; the collapse toggle writes it.
    /// Empty (the default, so shipping this changes nothing) until the user
    /// collapses a card. Stale ids are harmless and left unpruned.
    #[serde(default)]
    pub collapsed_machines: Vec<String>,
}

pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            path: config_path()?,
        })
    }

    /// Test-only store at an explicit path; production stores resolve
    /// their path through [`ConfigStore::new`].
    #[cfg(test)]
    pub(crate) fn at_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn get(&self) -> io::Result<Config> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e),
        }
    }

    pub fn save(&mut self, cfg: &Config) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let bytes = serde_json::to_vec_pretty(cfg)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Side effect run after a devserver row is removed via the registry's
/// [`remove`](DevserverRegistry::remove) (the HTTP `DELETE` path), so that path
/// reaps a live connection/windows (the desktop's `teardown_devserver_connection`).
/// Set once, after the Tauri `AppHandle` exists (the registry installs before it),
/// via the shared [`OnceLock`] cell -- the chan-server-side registry can't see
/// the `AppHandle` directly, so the desktop injects the teardown as a closure.
/// The returned handle lets async gateway policy paths await teardown before a
/// reconnect; the synchronous registry-remove path explicitly detaches it.
/// A no-op when nothing is live (removing a not-connected devserver).
pub type DevserverRemoveHook =
    Arc<dyn Fn(&str) -> tauri::async_runtime::JoinHandle<()> + Send + Sync>;

/// chan-desktop's [`DevserverRegistry`] implementation -- the bridge the
/// launcher's `/api/library/devservers` routes reach through
/// [`WorkspaceHost::devserver_registry`](chan_server::WorkspaceHost::devserver_registry).
/// It wraps the SHARED [`ConfigStore`] handle (the same `Arc<Mutex<ConfigStore>>`
/// the desktop's own commands and the window-config LRU use), so every config
/// write -- devserver CRUD, window stack, outbound attachments -- serializes
/// through one lock and can't lose an update to a concurrent full-file rewrite.
///
/// The token is write-only: `add`/`update` accept it, `list` and the returned
/// entry only report [`has_token`](DevserverEntry::has_token). A blank/absent
/// token on update keeps the stored one unless the caller sets `clear_token`.
pub struct DevserverConfigRegistry {
    store: Arc<Mutex<ConfigStore>>,
    /// Filled (once the `AppHandle` exists) with the live-connection teardown;
    /// `remove` fires it after dropping a row so the HTTP `DELETE` reaps the
    /// same connection/windows the Tauri command does. Empty until then (and on
    /// headless surfaces) -- `remove` then only drops the config row.
    on_remove: Arc<OnceLock<DevserverRemoveHook>>,
    /// The live connection map (shared with `AppState.devservers`), so `list`
    /// reports each row's [`DevserverEntry::status`] -- the launcher shows
    /// Connect vs Disconnect + gates Edit read-only off it.
    conns: Arc<DevserverConns>,
    /// Devservers with a connect request currently in flight. Shared with
    /// `AppState.devserver_connecting`, so list reports `connecting` during the
    /// coalesced dial attempt.
    connecting: Arc<Mutex<HashSet<String>>>,
    /// The connected-devserver feed (shared with `AppState.devserver_feed`), so
    /// `list` resolves each row's `library_id` from the live window snapshot.
    /// `WorkspaceHost::pane_color` matches a devserver window's `library_id`
    /// against these entries to find its colour, so the projection MUST carry it.
    feed: Arc<crate::DevserverFeed>,
    /// The gateway runtime map (shared with `AppState.gateway_manager`):
    /// `list` appends one synthesized row per rostered gateway devserver,
    /// so connected gateways' devservers appear beside the persisted rows.
    gateway_manager: Arc<crate::gateway::GatewayManager>,
}

impl DevserverConfigRegistry {
    pub fn new(
        store: Arc<Mutex<ConfigStore>>,
        on_remove: Arc<OnceLock<DevserverRemoveHook>>,
        conns: Arc<DevserverConns>,
        connecting: Arc<Mutex<HashSet<String>>>,
        feed: Arc<crate::DevserverFeed>,
        gateway_manager: Arc<crate::gateway::GatewayManager>,
    ) -> Self {
        Self {
            store,
            on_remove,
            conns,
            connecting,
            feed,
            gateway_manager,
        }
    }
}

/// Project a rostered gateway devserver into a launcher row. The id is the
/// synthesized `gw:` triple; connection state reads the same conns /
/// connecting / feed maps as persisted rows (keyed by that id); the roster
/// supplies label, liveness, and provenance. Synthesized rows carry no
/// local config: no token, no script, no editing.
fn entry_from_roster_row(
    gateway: &Gateway,
    row: &crate::gateway::RosterDevserver,
    conns: &DevserverConns,
    connecting: &Arc<Mutex<HashSet<String>>>,
    feed: &crate::DevserverFeed,
) -> DevserverEntry {
    let id = crate::gateway::synthesized_row_id(&gateway.id, &row.owner, &row.devserver_id);
    let (host, port) = url::Url::parse(&gateway.url)
        .ok()
        .and_then(|u| {
            let host = u.host_str()?.to_string();
            Some((host, u.port_or_known_default().unwrap_or(443)))
        })
        .unwrap_or_else(|| (gateway.url.clone(), 443));
    let (os, pretty_name) = feed.os_of(&id).unwrap_or_default();
    DevserverEntry {
        // Three-way mapping for rostered rows: a live conn reports
        // Connected (the window-feed watchdog still owns quiet-conn
        // Unreachable), an unconnected row follows the roster's online
        // bit - offline rows get the lost dot BEFORE any connect attempt.
        // Gateway-level trouble (the roster fetch failing) stays on the
        // GatewayEntry badge, never painted across rows.
        status: if conns.is_connected(&id) {
            if feed.is_unreachable(&id) {
                DevserverStatus::Unreachable
            } else {
                DevserverStatus::Connected
            }
        } else if connecting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id)
        {
            DevserverStatus::Connecting
        } else if row.online {
            DevserverStatus::Disconnected
        } else {
            DevserverStatus::Unreachable
        },
        library_id: feed.library_id_of(&id),
        id,
        url: gateway.url.clone(),
        host,
        port,
        label: row.label.clone(),
        script: String::new(),
        has_token: false,
        auto_hide_control: false,
        pending_signin: false,
        os,
        pretty_name,
        gateway_id: Some(gateway.id.clone()),
        gateway_url: gateway.url.clone(),
        shared: row.shared,
        native_trust_required: row.shared
            && !gateway.trusts_native(row.owner_user_id, &row.devserver_id),
    }
}

/// chan-desktop's [`LocalColorStore`](chan_server::LocalColorStore): the local
/// library's pane-highlight colour persisted in the desktop config
/// (`~/.chan/desktop`, the same shared store the devserver registry + window LRU
/// use, so every write serializes through one lock). The host reads it when
/// minting local windows; the launcher's local-colour route writes it.
pub struct LocalColorConfig {
    store: Arc<Mutex<ConfigStore>>,
}

impl LocalColorConfig {
    pub fn new(store: Arc<Mutex<ConfigStore>>) -> Self {
        Self { store }
    }
}

impl chan_server::LocalColorStore for LocalColorConfig {
    fn get(&self) -> Option<String> {
        self.store
            .lock()
            .unwrap()
            .get()
            .ok()
            .and_then(|c| c.local_color)
    }

    fn set(&self, color: Option<String>) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        cfg.local_color = color;
        store.save(&cfg).map_err(|e| e.to_string())
    }
}

/// chan-desktop's [`LocalThemeStore`](chan_server::LocalThemeStore): the
/// launcher's light/dark choice persisted in the desktop config (the same
/// shared store the local colour + devserver registry use, so every write
/// serializes through one lock). The host reads it when minting local terminal
/// windows; the launcher's local-theme route writes it.
pub struct LocalThemeConfig {
    store: Arc<Mutex<ConfigStore>>,
}

impl LocalThemeConfig {
    pub fn new(store: Arc<Mutex<ConfigStore>>) -> Self {
        Self { store }
    }
}

impl chan_server::LocalThemeStore for LocalThemeConfig {
    fn get(&self) -> Option<String> {
        self.store
            .lock()
            .unwrap()
            .get()
            .ok()
            .and_then(|c| c.launcher_theme)
    }

    fn set(&self, theme: Option<String>) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        cfg.launcher_theme = theme;
        store.save(&cfg).map_err(|e| e.to_string())
    }
}

/// chan-desktop's [`CollapsedMachinesStore`](chan_server::CollapsedMachinesStore):
/// the launcher's collapsed machine cards persisted in the shared desktop config
/// (the same store the theme + colour + devserver registry use, so every write
/// serializes through one lock). The launcher reconciles against it on boot; the
/// collapse toggle writes it.
pub struct CollapsedMachinesConfig {
    store: Arc<Mutex<ConfigStore>>,
}

impl CollapsedMachinesConfig {
    pub fn new(store: Arc<Mutex<ConfigStore>>) -> Self {
        Self { store }
    }
}

impl chan_server::CollapsedMachinesStore for CollapsedMachinesConfig {
    fn get(&self) -> Vec<String> {
        self.store
            .lock()
            .unwrap()
            .get()
            .map(|c| c.collapsed_machines)
            .unwrap_or_default()
    }

    fn set(&self, collapsed: Vec<String>) -> Result<(), String> {
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        cfg.collapsed_machines = collapsed;
        store.save(&cfg).map_err(|e| e.to_string())
    }
}

/// Project a stored [`Devserver`] to the launcher's wire [`DevserverEntry`],
/// eliding the token (only its presence, `has_token`, crosses the wire) and
/// joining the live connection state (`connected`) from `conns`.
/// Form + validate the desktop's stored dial URL from the launcher's host+port
/// (the wire model since the devserver form switched back to Host+Port, smoke
/// #3). The desktop persists the URL (the dial path, dedup, and window-restore
/// key are URL-based); `entry_from_devserver` re-exposes host+port on the wire.
fn devserver_url(input: &DevserverInput) -> Result<String, String> {
    if let Some(url) = input
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        return crate::devserver::normalize_devserver_url(url);
    }
    let host = input.host.trim();
    if host.is_empty() {
        return Err("devserver host is required".to_string());
    }
    let url = format!("http://{host}:{}", input.port);
    crate::devserver::normalize_devserver_url(&url)
}

fn entry_from_devserver(
    d: &Devserver,
    conns: &DevserverConns,
    connecting: &Arc<Mutex<HashSet<String>>>,
    feed: &crate::DevserverFeed,
) -> DevserverEntry {
    // The desktop stores the dial URL (formed from the user's host+port); the wire
    // entry exposes host+port. A stored URL is always valid (add/update validate
    // it), so the parse should not fail; fall back defensively to (raw, 0).
    let (host, port) =
        crate::devserver::parse_devserver_url(&d.url).unwrap_or_else(|_| (d.url.clone(), 0));
    // The self-reported OS, cached in the feed at connect (empty before the first
    // connect or from a devserver too old to report it).
    let (os, pretty_name) = feed.os_of(&d.id).unwrap_or_default();
    DevserverEntry {
        id: d.id.clone(),
        url: d.url.clone(),
        host,
        port,
        label: d.label.clone(),
        script: d.script.clone(),
        has_token: !d.token.is_empty(),
        status: if conns.is_connected(&d.id) {
            // The connection record exists, but if this devserver's window/color
            // feed sockets have gone down (the post-sleep half-open zombie, N
            // consecutive feed reconnect failures) report Unreachable instead of
            // a green Connected that the fresh-TCP workspace poll would otherwise
            // keep lit over a dead feed.
            if feed.is_unreachable(&d.id) {
                DevserverStatus::Unreachable
            } else {
                DevserverStatus::Connected
            }
        } else if connecting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&d.id)
        {
            DevserverStatus::Connecting
        } else {
            DevserverStatus::Disconnected
        },
        // Sign-in waits are gateway-level; a persisted row never waits, and
        // the key stays on the wire so the launcher parses it unconditionally.
        pending_signin: false,
        // The connected library id, learned from the live window feed (`None`
        // until this devserver is connected with ≥1 window). `pane_color` matches
        // a devserver window's `library_id` against this (in the feed) to resolve
        // its colour; no colour lives on the entry anymore (each library's colour
        // is on its own host).
        library_id: feed.library_id_of(&d.id),
        // Whether the control terminal auto-hides on connect success.
        auto_hide_control: d.auto_hide_control,
        // The launcher's machine icon + tooltip, from the devserver's self-report.
        os,
        pretty_name,
        // Plain configured rows carry no gateway provenance; gateway-roster
        // rows are synthesized with these set, not read from persisted config.
        gateway_id: None,
        gateway_url: String::new(),
        shared: false,
        native_trust_required: false,
    }
}

impl DevserverRegistry for DevserverConfigRegistry {
    fn list(&self) -> Vec<DevserverEntry> {
        // Infallible by contract (mirrors the window feed): a read error
        // surfaces as an empty list, not a 500. Persisted rows first, then
        // one synthesized row per rostered gateway devserver - derived
        // deterministically from the config rows + the roster cache, so
        // repeated lists agree while nothing changed.
        let store = self.store.lock().unwrap();
        store
            .get()
            .map(|cfg| {
                let mut rows: Vec<DevserverEntry> = cfg
                    .devservers
                    .iter()
                    .map(|d| entry_from_devserver(d, &self.conns, &self.connecting, &self.feed))
                    .collect();
                for g in &cfg.gateways {
                    rows.extend(self.gateway_manager.roster(&g.id).iter().map(|r| {
                        entry_from_roster_row(g, r, &self.conns, &self.connecting, &self.feed)
                    }));
                }
                rows
            })
            .unwrap_or_default()
    }

    fn add(&self, input: DevserverInput) -> Result<DevserverEntry, String> {
        let url = devserver_url(&input)?;
        let token = input.token.unwrap_or_default().trim().to_string();
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        let entry = Devserver {
            id: uuid::Uuid::new_v4().to_string(),
            url,
            script: input.script.unwrap_or_default(),
            label: input.label.unwrap_or_default(),
            token,
            added_at: now_millis(),
            auto_hide_control: input.auto_hide_control,
            gateway_owner: None,
            gateway_devserver_id: None,
        };
        cfg.devservers.push(entry.clone());
        store.save(&cfg).map_err(|e| e.to_string())?;
        Ok(entry_from_devserver(
            &entry,
            &self.conns,
            &self.connecting,
            &self.feed,
        ))
    }

    fn update(&self, id: &str, input: DevserverInput) -> Result<Option<DevserverEntry>, String> {
        // Synthesized gateway rows carry no local config to edit; they are
        // not in the persisted vec, so the lookup below misses and the
        // route layer answers 404. Same for remove.
        let url = devserver_url(&input)?;
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        let Some(ds) = cfg.devservers.iter_mut().find(|d| d.id == id) else {
            return Ok(None);
        };
        ds.url = url;
        // label/script are full-replace (None/empty clears, which the display
        // path reads as "derive the label from the URL host" / "no script").
        ds.label = input.label.unwrap_or_default();
        ds.script = input.script.unwrap_or_default();
        // The auto-hide flag is full-replace like label/script (the edit form resubmits it).
        ds.auto_hide_control = input.auto_hide_control;
        // Token is write-only: the edit form can't echo the stored secret, so
        // blank/absent still means keep. `clear_token` is the explicit removal
        // path; a pasted replacement token wins over the checkbox.
        let replacement_token = input
            .token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty());
        if let Some(tok) = replacement_token {
            ds.token = tok.to_string();
        } else if input.clear_token {
            ds.token.clear();
        }
        let entry = entry_from_devserver(ds, &self.conns, &self.connecting, &self.feed);
        store.save(&cfg).map_err(|e| e.to_string())?;
        Ok(Some(entry))
    }

    fn remove(&self, id: &str) -> Result<bool, String> {
        {
            let mut store = self.store.lock().unwrap();
            let mut cfg = store.get().map_err(|e| e.to_string())?;
            let before = cfg.devservers.len();
            cfg.devservers.retain(|d| d.id != id);
            if cfg.devservers.len() == before {
                return Ok(false);
            }
            store.save(&cfg).map_err(|e| e.to_string())?;
        }
        // Row dropped: reap any live connection/windows so the HTTP DELETE
        // matches the Tauri command's teardown. The store lock is released
        // above first -- the teardown locks the other AppState maps, never the
        // store. A no-op when the devserver wasn't connected.
        if let Some(hook) = self.on_remove.get() {
            std::mem::drop(hook(id));
        }
        Ok(true)
    }
}

/// Normalize a gateway URL to its origin: scheme + host [+ non-default
/// port], path/query/fragment dropped. Rejects non-http(s) schemes and
/// hostless URLs; everything after the origin is user noise (a pasted
/// consent-page URL still yields the right gateway).
pub fn normalize_gateway_url(raw: &str) -> Result<String, String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| format!("invalid gateway URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("gateway URL must be http(s)".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("gateway URL needs a host".to_string());
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Mint a gateway id: `gw-` + 8 lowercase hex chars from the OS CSPRNG.
/// Callers dedup against the config's existing ids (four random bytes make
/// startup-collisions astronomically unlikely, but a config file is
/// forever).
fn mint_gateway_id() -> Result<String, String> {
    let mut b = [0u8; 4];
    getrandom::getrandom(&mut b).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    Ok(format!(
        "gw-{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3]
    ))
}

fn mint_unused_gateway_id(existing: &[Gateway]) -> Result<String, String> {
    loop {
        let id = mint_gateway_id()?;
        if !existing.iter().any(|g| g.id == id) {
            return Ok(id);
        }
    }
}

/// Side effect run after a gateway row is removed via the registry's
/// [`remove`](chan_server::GatewayRegistry::remove) (the HTTP `DELETE`
/// path), so that path runs the same cascade the Tauri command does (stop
/// the roster poll, tear down rostered connections, drop the roster rows).
/// Set once, after the Tauri `AppHandle` exists, via the shared
/// [`OnceLock`] cell -- mirror of [`DevserverRemoveHook`]. A no-op when the
/// gateway wasn't connected.
pub type GatewayRemoveHook = Arc<dyn Fn(&str) + Send + Sync>;

/// chan-desktop's [`GatewayRegistry`](chan_server::GatewayRegistry)
/// implementation -- the bridge the launcher's `/api/library/gateways`
/// routes reach through `WorkspaceHost::gateway_registry`. Wraps the SHARED
/// [`ConfigStore`] handle like [`DevserverConfigRegistry`], so gateway CRUD
/// serializes through the same lock as every other config write.
///
/// The volatile [`GatewayEntry`](chan_server::GatewayEntry) fields
/// (`status`, `pending_signin`, `devserver_count`, `last_error`) project
/// from the gateway manager's runtime map.
pub struct GatewayConfigRegistry {
    store: Arc<Mutex<ConfigStore>>,
    /// Filled (once the `AppHandle` exists) with the cascade teardown;
    /// `remove` fires it after dropping a row. Empty until then (and on
    /// surfaces without live connections) -- `remove` then only drops the
    /// config row.
    on_remove: Arc<OnceLock<GatewayRemoveHook>>,
    /// The live runtime map (shared with `AppState.gateway_manager`), so
    /// `list` reports each row's connection state; a gateway without a
    /// runtime renders the disconnected defaults.
    manager: Arc<crate::gateway::GatewayManager>,
}

impl GatewayConfigRegistry {
    pub fn new(
        store: Arc<Mutex<ConfigStore>>,
        on_remove: Arc<OnceLock<GatewayRemoveHook>>,
        manager: Arc<crate::gateway::GatewayManager>,
    ) -> Self {
        Self {
            store,
            on_remove,
            manager,
        }
    }
}

fn entry_from_gateway(
    g: &Gateway,
    view: Option<crate::gateway::GatewayRuntimeView>,
) -> GatewayEntry {
    let view = view.unwrap_or_default();
    GatewayEntry {
        id: g.id.clone(),
        url: g.url.clone(),
        label: g.label.clone(),
        enabled: g.enabled,
        status: view.status,
        pending_signin: view.pending_signin,
        devserver_count: view.devserver_count,
        last_error: view.last_error,
    }
}

impl GatewayRegistry for GatewayConfigRegistry {
    fn list(&self) -> Vec<GatewayEntry> {
        // Infallible by contract (mirrors the devserver list): a read error
        // surfaces as an empty list, not a 500.
        let store = self.store.lock().unwrap();
        store
            .get()
            .map(|cfg| {
                cfg.gateways
                    .iter()
                    .map(|g| entry_from_gateway(g, self.manager.view(&g.id)))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn add(&self, input: GatewayInput) -> Result<GatewayEntry, String> {
        let url = normalize_gateway_url(&input.url)?;
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        if cfg.gateways.iter().any(|g| g.url == url) {
            return Err(format!("gateway already configured: {url}"));
        }
        let gw = Gateway {
            id: mint_unused_gateway_id(&cfg.gateways)?,
            url,
            label: input.label.unwrap_or_default().trim().to_string(),
            enabled: true,
            added_at: now_millis(),
            native_trust: Vec::new(),
        };
        cfg.gateways.push(gw.clone());
        store.save(&cfg).map_err(|e| e.to_string())?;
        Ok(entry_from_gateway(&gw, None))
    }

    fn update(&self, id: &str, input: GatewayInput) -> Result<Option<GatewayEntry>, String> {
        let mut store = self.store.lock().unwrap();
        let mut cfg = store.get().map_err(|e| e.to_string())?;
        let Some(gw) = cfg.gateways.iter_mut().find(|g| g.id == id) else {
            return Ok(None);
        };
        // The URL is the gateway's identity (the keyring PAT and the
        // synthesized row ids key off it), so update refuses a different
        // origin; an empty url means keep. Changing the origin is a
        // remove + re-add.
        if !input.url.trim().is_empty() && normalize_gateway_url(&input.url)? != gw.url {
            return Err("gateway URL is immutable; remove and re-add to change it".to_string());
        }
        // Label is full-replace: empty clears, and the badge derives from
        // the URL host again.
        gw.label = input.label.unwrap_or_default().trim().to_string();
        let entry = entry_from_gateway(gw, self.manager.view(id));
        store.save(&cfg).map_err(|e| e.to_string())?;
        Ok(Some(entry))
    }

    fn remove(&self, id: &str) -> Result<bool, String> {
        {
            let mut store = self.store.lock().unwrap();
            let mut cfg = store.get().map_err(|e| e.to_string())?;
            let before = cfg.gateways.len();
            cfg.gateways.retain(|g| g.id != id);
            if cfg.gateways.len() == before {
                return Ok(false);
            }
            store.save(&cfg).map_err(|e| e.to_string())?;
        }
        // Row dropped: run the cascade so the HTTP DELETE matches the Tauri
        // command's teardown. The store lock is released above first -- the
        // cascade locks live-connection state, never the store.
        if let Some(hook) = self.on_remove.get() {
            hook(id);
        }
        Ok(true)
    }
}

/// What the one-shot legacy migration did, for the startup log and the
/// launcher's info notice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GatewayMigration {
    /// Gateways created from legacy rows (rows merged into a pre-existing
    /// gateway entry create nothing but still count as converted).
    pub created: Vec<Gateway>,
    /// Legacy devserver rows dropped after conversion.
    pub converted_rows: usize,
    /// Rows kept as plain devservers with their legacy markers cleared
    /// (their URL no longer parses). Counted separately because the
    /// clearing alone must still persist, or every startup re-visits
    /// those rows.
    pub cleared_marker_rows: usize,
}

impl GatewayMigration {
    pub fn changed(&self) -> bool {
        self.converted_rows > 0 || self.cleared_marker_rows > 0
    }
}

/// Convert devserver rows recorded by the retired pick-one gateway flow
/// (`gateway_owner`/`gateway_devserver_id` set) into [`Gateway`] entries,
/// dropping the rows: the gateway's roster now supplies its devservers, so
/// a persisted per-devserver row would shadow the synthesized one. Rows
/// pointing at the same origin merge into one gateway (first non-empty
/// label wins); an origin already configured merges into that entry. A row
/// whose URL no longer parses keeps its devserver row (gateway markers
/// cleared) rather than losing user data -- the raw-dial backstop re-flags
/// it as a gateway at connect time.
///
/// Pure over [`Config`] so the shapes are table-testable; the startup
/// driver persists only when something converted.
fn split_legacy_gateway_rows(cfg: &mut Config) -> GatewayMigration {
    let devservers = std::mem::take(&mut cfg.devservers);
    let mut outcome = GatewayMigration::default();
    for mut row in devservers {
        if row.gateway_owner.is_none() && row.gateway_devserver_id.is_none() {
            cfg.devservers.push(row);
            continue;
        }
        let Ok(origin) = normalize_gateway_url(&row.url) else {
            row.gateway_owner = None;
            row.gateway_devserver_id = None;
            outcome.cleared_marker_rows += 1;
            cfg.devservers.push(row);
            continue;
        };
        outcome.converted_rows += 1;
        if let Some(existing) = cfg.gateways.iter_mut().find(|g| g.url == origin) {
            if existing.label.is_empty() && !row.label.is_empty() {
                existing.label = row.label;
            }
            continue;
        }
        let Ok(id) = mint_unused_gateway_id(&cfg.gateways) else {
            // No CSPRNG, no id: keep the row untouched and let a later
            // startup retry the conversion.
            outcome.converted_rows -= 1;
            cfg.devservers.push(row);
            continue;
        };
        let gw = Gateway {
            id,
            url: origin,
            label: row.label,
            enabled: true,
            added_at: row.added_at,
            native_trust: Vec::new(),
        };
        cfg.gateways.push(gw.clone());
        outcome.created.push(gw);
    }
    outcome
}

/// Convert one persisted devserver row into a gateway entry: the row's
/// URL origin becomes (or merges into, first non-empty label winning) a
/// gateway, and the row is dropped - the gateway's roster supplies its
/// devservers from here on. The `chan open` handoff probe calls this when
/// a just-registered URL answers as a gateway. `Ok(None)` when no row has
/// `id` (removed meanwhile); an unparseable row URL is an error and the
/// config stays untouched.
pub fn convert_devserver_row_to_gateway(
    store: &Arc<Mutex<ConfigStore>>,
    id: &str,
) -> Result<Option<Gateway>, String> {
    let mut guard = store.lock().unwrap();
    let mut cfg = guard.get().map_err(|e| e.to_string())?;
    let Some(pos) = cfg.devservers.iter().position(|d| d.id == id) else {
        return Ok(None);
    };
    let row = cfg.devservers.remove(pos);
    let origin = normalize_gateway_url(&row.url)?;
    let gw = if let Some(existing) = cfg.gateways.iter_mut().find(|g| g.url == origin) {
        if existing.label.is_empty() && !row.label.is_empty() {
            existing.label = row.label;
        }
        existing.clone()
    } else {
        let gw = Gateway {
            id: mint_unused_gateway_id(&cfg.gateways)?,
            url: origin,
            label: row.label,
            enabled: true,
            added_at: row.added_at,
            native_trust: Vec::new(),
        };
        cfg.gateways.push(gw.clone());
        gw
    };
    guard.save(&cfg).map_err(|e| e.to_string())?;
    Ok(Some(gw))
}

/// One-shot startup migration driver: runs right after the [`ConfigStore`]
/// exists, before any registry or connection reads the config
/// (single-threaded), and saves atomically only when rows converted. A
/// config read/write error leaves the file untouched; the caller logs and
/// the next startup retries.
pub fn migrate_legacy_gateway_rows(
    store: &Arc<Mutex<ConfigStore>>,
) -> io::Result<GatewayMigration> {
    let mut guard = store.lock().unwrap();
    let mut cfg = guard.get()?;
    let outcome = split_legacy_gateway_rows(&mut cfg);
    if outcome.changed() {
        guard.save(&cfg)?;
    }
    Ok(outcome)
}

/// Identity key for a local-workspace WindowConfig. Matches the
/// `AppState.serves` key so a window-config lookup uses the same
/// canonical-path normalisation as the workspace registry.
pub fn local_window_key(workspace_key: &str) -> String {
    workspace_key.to_string()
}

/// Identity key for a remote (devserver) URL attachment.
pub fn remote_window_key(id: &str) -> String {
    format!("remote:{id}")
}

/// Push a window config to the top of the LRU stack and persist.
/// Older entries with the same `window_label` are dropped so the
/// stack stays compact (one entry per label across all keys).
/// Trims to `MAX_WINDOW_CONFIGS`.
pub fn push_window_config(cfg: &mut Config, mut entry: WindowConfig) {
    if entry.saved_at == 0 {
        entry.saved_at = now_millis();
    }
    cfg.window_configs
        .retain(|w| w.window_label != entry.window_label);
    cfg.window_configs.insert(0, entry);
    cfg.window_configs.truncate(MAX_WINDOW_CONFIGS);
}

/// Pop the most-recent WindowConfig matching `key` whose label is NOT
/// currently live, removing it from the stack. Returns `None` when no
/// such entry exists. Callers save the config afterwards; this
/// function only mutates the in-memory `Config`.
///
/// `is_label_live` exists for bury-on-close: a buried (hidden) window
/// is still a live webview AND has a fresh stack entry captured at
/// bury time. A new same-workspace window must neither reuse that
/// label (Tauri labels are unique per process) nor pop-and-discard the
/// entry -- the buried window still needs it if the app quits before an
/// unbury. Skipping live-label entries leaves them in place; across an
/// app restart nothing is live and the stack pops normally.
pub fn pop_window_config(
    cfg: &mut Config,
    key: &str,
    is_label_live: impl Fn(&str) -> bool,
) -> Option<WindowConfig> {
    let pos = cfg
        .window_configs
        .iter()
        .position(|w| w.key == key && !is_label_live(&w.window_label))?;
    Some(cfg.window_configs.remove(pos))
}

/// Order-independent monitor signature: the monitor count plus each monitor's
/// SIZE and scale factor, sorted so the OS reporting monitors in a different
/// order doesn't change the string. The scale is stringified (`{:.2}`) so float
/// equality never bites.
///
/// Monitor POSITION is deliberately excluded: macOS anchors the global
/// coordinate space at the Main display, so making a display the Main one (or
/// the menu bar moving) re-origins every monitor's position WITHOUT any hardware
/// change. Keying on position made a same-hardware hide+reopen mismatch and fall
/// through to the size-only path. Size + scale identify the hardware layout;
/// where a window lands is the stored geometry's job (the apply path clamps the
/// restored position to the monitor it belongs to).
pub fn monitor_signature(mons: &[MonitorDesc]) -> String {
    let mut parts: Vec<String> = mons
        .iter()
        .map(|m| format!("{}x{}@{:.2}", m.w, m.h, m.scale))
        .collect();
    parts.sort();
    format!("{}|{}", mons.len(), parts.join("|"))
}

/// Upsert a freshly-captured geometry into the window's per-signature LRU and
/// move the window's record to the front. The new signature replaces any prior
/// entry for the same signature (dedup) and goes to the front, capped at
/// [`MAX_WINDOW_GEOMETRIES`] so flipping monitor layouts and back keeps each
/// layout's own geometry. The records stack is capped at [`MAX_WINDOW_CONFIGS`]
/// windows. Best-effort callers save afterwards; this only mutates `cfg`.
pub fn push_window_geometry(cfg: &mut Config, label: &str, mut geom: WindowGeometry) {
    if geom.saved_at == 0 {
        geom.saved_at = now_millis();
    }
    let saved_at = geom.saved_at;
    if let Some(pos) = cfg
        .window_geometry
        .iter()
        .position(|r| r.window_label == label)
    {
        let mut rec = cfg.window_geometry.remove(pos);
        rec.geometries.retain(|g| g.monitor_sig != geom.monitor_sig);
        rec.geometries.insert(0, geom);
        rec.geometries.truncate(MAX_WINDOW_GEOMETRIES);
        rec.saved_at = saved_at;
        cfg.window_geometry.insert(0, rec);
    } else {
        cfg.window_geometry.insert(
            0,
            WindowGeometryRecord {
                window_label: label.to_string(),
                geometries: vec![geom],
                saved_at,
            },
        );
    }
    cfg.window_geometry.truncate(MAX_WINDOW_CONFIGS);
}

/// Resolve the geometry to apply for `label` under `current_sig`: an exact
/// signature match returns [`GeometryMatch::Exact`]; otherwise the most-recent
/// stored geometry is returned as [`GeometryMatch::Fallback`]. `None` when
/// nothing is stored for the label.
pub fn lookup_window_geometry(
    cfg: &Config,
    label: &str,
    current_sig: &str,
) -> Option<GeometryMatch> {
    let rec = cfg
        .window_geometry
        .iter()
        .find(|r| r.window_label == label)?;
    if let Some(g) = rec.geometries.iter().find(|g| g.monitor_sig == current_sig) {
        return Some(GeometryMatch::Exact(g.clone()));
    }
    rec.geometries.first().cloned().map(GeometryMatch::Fallback)
}

/// Intersection AREA of two rects (each `(x, y, w, h)`), in px². `i64` so the
/// product can't overflow `i32`. Zero when the rects don't overlap.
fn intersect_area(a: (i32, i32, u32, u32), b: (i32, i32, u32, u32)) -> i64 {
    let (ax, ay, aw, ah) = a;
    let (bx, by, bw, bh) = b;
    let ix1 = ax.max(bx) as i64;
    let iy1 = ay.max(by) as i64;
    let ix2 = (ax as i64 + aw as i64).min(bx as i64 + bw as i64);
    let iy2 = (ay as i64 + ah as i64).min(by as i64 + bh as i64);
    (ix2 - ix1).max(0) * (iy2 - iy1).max(0)
}

/// Index of the monitor a stored window rect belongs to: the one whose FULL
/// bounds overlap the rect the most. `None` when the rect overlaps no monitor
/// (stored fully off every current screen -- the caller then falls back to the
/// union box). Identifies "which screen is this window on" so the restore clamps
/// to THAT monitor's work area instead of the primary's.
pub fn monitor_for_rect(mons: &[MonitorDesc], x: i32, y: i32, w: u32, h: u32) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (i, m) in mons.iter().enumerate() {
        let area = intersect_area((x, y, w, h), (m.x, m.y, m.w, m.h));
        if area > 0 && best.is_none_or(|(_, a)| area > a) {
            best = Some((i, area));
        }
    }
    best.map(|(i, _)| i)
}

/// A monitor's WORK area as a `(min_x, min_y, max_x, max_y)` clamp box.
pub fn work_area_bbox(m: &MonitorDesc) -> (i32, i32, i32, i32) {
    (
        m.work_x,
        m.work_y,
        m.work_x + m.work_w as i32,
        m.work_y + m.work_h as i32,
    )
}

/// Bounding box `(min_x, min_y, max_x, max_y)` of every monitor's WORK area, or
/// `None` when there are no monitors. The clamp keeps a restored window inside
/// this box so it can't open off the visible desktop.
pub fn union_work_bbox(mons: &[MonitorDesc]) -> Option<(i32, i32, i32, i32)> {
    if mons.is_empty() {
        return None;
    }
    let min_x = mons.iter().map(|m| m.work_x).min().unwrap();
    let min_y = mons.iter().map(|m| m.work_y).min().unwrap();
    let max_x = mons
        .iter()
        .map(|m| m.work_x + m.work_w as i32)
        .max()
        .unwrap();
    let max_y = mons
        .iter()
        .map(|m| m.work_y + m.work_h as i32)
        .max()
        .unwrap();
    Some((min_x, min_y, max_x, max_y))
}

/// Clamp a window rect so the WHOLE window stays inside the work-area bounding
/// box: shrink the size to fit if larger, then pull the top-left back so the
/// window can't open off the visible desktop. For a signature MATCH this is a
/// near-no-op (the stored rect was valid then); it earns its keep when the work
/// area shrank under the same physical layout (a dock / taskbar appeared).
pub fn clamp_rect_to_bbox(
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    bbox: (i32, i32, i32, i32),
) -> (i32, i32, u32, u32) {
    let (min_x, min_y, max_x, max_y) = bbox;
    let bw = (max_x - min_x).max(0) as u32;
    let bh = (max_y - min_y).max(0) as u32;
    let w = w.min(bw).max(1);
    let h = h.min(bh).max(1);
    // Highest top-left that still fits the window inside the bbox.
    let max_x_pos = (max_x - w as i32).max(min_x);
    let max_y_pos = (max_y - h as i32).max(min_y);
    let cx = x.clamp(min_x, max_x_pos);
    let cy = y.clamp(min_y, max_y_pos);
    (cx, cy, w, h)
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn current_millis() -> u64 {
    now_millis()
}

/// chan-desktop keeps its config under `~/.chan/desktop/` -- the same
/// `~/.chan` home as the CLI registry (`config.toml`), not a separate
/// OS app-data directory. On Windows that resolves to
/// `%USERPROFILE%\.chan\desktop\config.json`.
fn config_path() -> io::Result<PathBuf> {
    Ok(chan_workspace::paths::config_dir()
        .join("desktop")
        .join("config.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_server::GatewayStatus;

    fn empty_connecting() -> Arc<Mutex<HashSet<String>>> {
        Arc::new(Mutex::new(HashSet::new()))
    }

    fn entry(key: &str, label: &str, hash: &str, saved_at: u64) -> WindowConfig {
        WindowConfig {
            key: key.to_string(),
            window_label: label.to_string(),
            url_hash: hash.to_string(),
            zoom_level: 1.0,
            saved_at,
        }
    }

    #[test]
    fn push_inserts_at_front() {
        let mut cfg = Config::default();
        push_window_config(&mut cfg, entry("/workspace/a", "workspace-a-0", "", 100));
        push_window_config(
            &mut cfg,
            entry("/workspace/b", "workspace-b-0", "files=1", 200),
        );
        assert_eq!(cfg.window_configs[0].window_label, "workspace-b-0");
        assert_eq!(cfg.window_configs[1].window_label, "workspace-a-0");
    }

    #[test]
    fn push_dedupes_by_window_label() {
        // Pushing twice for the same label collapses to one entry
        // at the top, not two. Prevents stack growth from
        // re-opening + re-closing the same window in a loop.
        let mut cfg = Config::default();
        push_window_config(&mut cfg, entry("/workspace/a", "workspace-a-0", "old", 100));
        push_window_config(&mut cfg, entry("/workspace/a", "workspace-a-0", "new", 200));
        assert_eq!(cfg.window_configs.len(), 1);
        assert_eq!(cfg.window_configs[0].url_hash, "new");
    }

    #[test]
    fn push_caps_at_max() {
        let mut cfg = Config::default();
        for i in 0..MAX_WINDOW_CONFIGS + 5 {
            let label = format!("workspace-a-{i}");
            push_window_config(&mut cfg, entry("/workspace/a", &label, "", 100 + i as u64));
        }
        assert_eq!(cfg.window_configs.len(), MAX_WINDOW_CONFIGS);
        // The five oldest got evicted; the newest stays at the top.
        let newest = format!("workspace-a-{}", MAX_WINDOW_CONFIGS + 4);
        assert_eq!(cfg.window_configs[0].window_label, newest);
    }

    #[test]
    fn pop_returns_most_recent_for_key() {
        let mut cfg = Config::default();
        push_window_config(
            &mut cfg,
            entry("/workspace/a", "workspace-a-0", "older", 100),
        );
        push_window_config(&mut cfg, entry("/workspace/b", "workspace-b-0", "", 200));
        push_window_config(
            &mut cfg,
            entry("/workspace/a", "workspace-a-1", "newer", 300),
        );
        let popped = pop_window_config(&mut cfg, "/workspace/a", |_| false).unwrap();
        assert_eq!(popped.window_label, "workspace-a-1");
        assert_eq!(popped.url_hash, "newer");
        // The older /workspace/a entry is still on the stack.
        let popped2 = pop_window_config(&mut cfg, "/workspace/a", |_| false).unwrap();
        assert_eq!(popped2.window_label, "workspace-a-0");
        // /workspace/b is untouched.
        assert_eq!(cfg.window_configs.len(), 1);
        assert_eq!(cfg.window_configs[0].window_label, "workspace-b-0");
    }

    #[test]
    fn pop_returns_none_when_no_match() {
        let mut cfg = Config::default();
        push_window_config(&mut cfg, entry("/workspace/a", "workspace-a-0", "", 100));
        assert!(pop_window_config(&mut cfg, "/workspace/missing", |_| false).is_none());
        assert_eq!(cfg.window_configs.len(), 1);
    }

    #[test]
    fn pop_skips_live_labels_and_leaves_them_on_the_stack() {
        // Bury-on-close: `workspace-a-1` is a buried (hidden but live)
        // window with a bury-time entry on the stack. A new window of
        // the same workspace must pop PAST it to the older dead entry,
        // leaving the live one in place for the quit-while-buried
        // restore.
        let mut cfg = Config::default();
        push_window_config(
            &mut cfg,
            entry("/workspace/a", "workspace-a-0", "dead", 100),
        );
        push_window_config(
            &mut cfg,
            entry("/workspace/a", "workspace-a-1", "live", 200),
        );
        let popped =
            pop_window_config(&mut cfg, "/workspace/a", |label| label == "workspace-a-1").unwrap();
        assert_eq!(popped.window_label, "workspace-a-0");
        assert_eq!(cfg.window_configs.len(), 1);
        assert_eq!(cfg.window_configs[0].window_label, "workspace-a-1");
        // Every entry live -> nothing pops, nothing is dropped.
        assert!(pop_window_config(&mut cfg, "/workspace/a", |_| true).is_none());
        assert_eq!(cfg.window_configs.len(), 1);
    }

    #[test]
    fn window_config_zoom_level_defaults_to_one_on_missing_field() {
        // A `config.json` entry without a `zoom_level` field must
        // stay loadable as 1.0 instead of failing the load and
        // dropping the entire window-config stack on the floor.
        let missing_zoom = r#"{
            "key": "/workspace/legacy",
            "window_label": "workspace-legacy-0",
            "url_hash": "files=1",
            "saved_at": 12345
        }"#;
        let cfg: WindowConfig = serde_json::from_str(missing_zoom).expect("legacy load");
        assert_eq!(cfg.zoom_level, 1.0);
        assert_eq!(cfg.url_hash, "files=1");
    }

    #[test]
    fn window_config_zoom_level_round_trips() {
        let entry = WindowConfig {
            key: "/workspace/a".to_string(),
            window_label: "workspace-a-0".to_string(),
            url_hash: String::new(),
            zoom_level: 1.4,
            saved_at: 0,
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        let back: WindowConfig = serde_json::from_str(&json).expect("deserialize");
        assert!((back.zoom_level - 1.4).abs() < f64::EPSILON);
    }

    #[test]
    fn remote_window_key_namespaced_apart_from_local() {
        let remote = remote_window_key("remote-1");
        assert_ne!(local_window_key("remote-1"), remote);
    }

    #[test]
    fn config_defaults_outbound_empty() {
        let cfg = Config::default();
        assert!(cfg.outbound.is_empty());
    }

    #[test]
    fn outbound_workspace_label_defaults_empty() {
        let raw = r#"{
            "id": "remote-1",
            "url": "http://127.0.0.1:4000/?t=abc"
        }"#;
        let workspace: OutboundWorkspace = serde_json::from_str(raw).expect("legacy load");
        assert_eq!(workspace.id, "remote-1");
        assert_eq!(workspace.label, "");
        assert_eq!(workspace.added_at, 0);
    }

    #[test]
    fn config_defaults_devservers_empty() {
        let cfg = Config::default();
        assert!(cfg.devservers.is_empty());
    }

    #[test]
    fn config_loads_without_devservers_field() {
        // A config.json that predates devservers must still load: serde
        // reads the missing key as the empty set so the load never fails
        // and drops the rest of the config.
        let raw = r#"{ "outbound": [], "window_configs": [] }"#;
        let cfg: Config = serde_json::from_str(raw).expect("load without devservers");
        assert!(cfg.devservers.is_empty());
    }

    #[test]
    fn config_devservers_round_trip() {
        let cfg = Config {
            devservers: vec![Devserver {
                id: "ds-1".into(),
                url: "http://127.0.0.1:8787".into(),
                script: "ssh box -L 8787:localhost:8787 chan devserver".into(),
                label: "lab box".into(),
                token: "tok_secret".into(),
                added_at: 42,
                auto_hide_control: true,
                gateway_owner: Some("alice".into()),
                gateway_devserver_id: Some("a".repeat(64)),
            }],
            ..Default::default()
        };
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: Config = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.devservers, cfg.devservers);
    }

    #[test]
    fn devserver_optional_fields_default() {
        // Only the connection essentials are required; script/label/
        // added_at/gateway selection default so a hand-written (or
        // pre-picker) config stays loadable.
        let raw = r#"{
            "id": "ds-1",
            "url": "http://127.0.0.1:8787"
        }"#;
        let ds: Devserver = serde_json::from_str(raw).expect("minimal load");
        assert_eq!(ds.id, "ds-1");
        assert_eq!(ds.url, "http://127.0.0.1:8787");
        assert_eq!(ds.script, "");
        assert_eq!(ds.label, "");
        assert_eq!(ds.token, "");
        assert_eq!(ds.added_at, 0);
        assert_eq!(ds.gateway_owner, None);
        assert_eq!(ds.gateway_devserver_id, None);
    }

    /// The registry projects a stored `Devserver` to a wire `DevserverEntry`
    /// with the token elided and `has_token` reporting its presence; it never
    /// echoes the token value.
    #[test]
    fn registry_list_elides_token_reports_has_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::new(crate::devserver::DevserverConns::default()),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let added = reg
            .add(DevserverInput {
                url: None,
                host: "box.example.com".into(),
                port: 8787,
                label: Some("lab".into()),
                script: Some("ssh -L …".into()),
                token: Some("tok_secret".into()),
                clear_token: false,
                auto_hide_control: false,
            })
            .expect("add");
        assert!(added.has_token);
        assert_eq!(added.host, "box.example.com");
        assert_eq!(added.port, 8787);
        assert_eq!(added.library_id, None);
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].has_token);
        // The token value never appears on the wire entry (no field for it);
        // the on-disk config still holds it for the connect path.
        let cfg = store.lock().unwrap().get().unwrap();
        assert_eq!(cfg.devservers[0].token, "tok_secret");
    }

    /// The wire `connected` flag the launcher reads
    /// (`GET /api/library/devservers` -> `list` -> `entry_from_devserver`)
    /// derives from the shared `DevserverConns` membership, so dropping the conn
    /// flips it false while the config row stays. This is the mechanism that
    /// guarantees the launcher never shows a dead devserver as connected.
    #[test]
    fn registry_list_connected_tracks_conns_membership() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let conns = Arc::new(crate::devserver::DevserverConns::default());
        let connecting = empty_connecting();
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::clone(&conns),
            Arc::clone(&connecting),
            Arc::new(crate::DevserverFeed::default()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let id = reg
            .add(DevserverInput {
                host: "127.0.0.1".into(),
                port: 8787,
                ..Default::default()
            })
            .expect("add")
            .id;
        // No live conn yet: disconnected.
        assert_eq!(reg.list()[0].status, DevserverStatus::Disconnected);
        connecting.lock().unwrap().insert(id.clone());
        assert_eq!(reg.list()[0].status, DevserverStatus::Connecting);
        // A live conn (what connect_devserver_impl sets on a successful dial).
        conns.set(
            id.clone(),
            crate::devserver::DevserverConn {
                host: "127.0.0.1".into(),
                port: 8787,
                token: "tok".into(),
                name: "box".into(),
                gateway: None,
            },
        );
        assert_eq!(reg.list()[0].status, DevserverStatus::Connected);
        connecting.lock().unwrap().remove(&id);
        // The control terminal dies -> the flip drops the conn -> the wire entry
        // flips to status:disconnected, but the persisted config row is untouched
        // (so a re-run/edit can reconnect it).
        conns.remove(&id);
        assert_eq!(reg.list()[0].status, DevserverStatus::Disconnected);
        assert_eq!(store.lock().unwrap().get().unwrap().devservers.len(), 1);
        // Sign-in waits are gateway-level: a persisted row never reports
        // pending_signin (the wire key stays, pinned false).
        assert!(!reg.list()[0].pending_signin);
    }

    /// A live connection whose window/color feed sockets have gone down (the
    /// post-sleep half-open zombie) reports Unreachable, not a green Connected
    /// the fresh-TCP poll would otherwise keep lit. Gated on a live conn: with no
    /// conn, a lingering flag still reads Disconnected.
    #[test]
    fn registry_status_unreachable_when_feed_down_but_conn_lives() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let conns = Arc::new(crate::devserver::DevserverConns::default());
        let feed = Arc::new(crate::DevserverFeed::default());
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::clone(&conns),
            empty_connecting(),
            Arc::clone(&feed),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let id = reg
            .add(DevserverInput {
                host: "127.0.0.1".into(),
                port: 8787,
                ..Default::default()
            })
            .expect("add")
            .id;
        conns.set(
            id.clone(),
            crate::devserver::DevserverConn {
                host: "127.0.0.1".into(),
                port: 8787,
                token: "tok".into(),
                name: "box".into(),
                gateway: None,
            },
        );
        // A live conn with a healthy feed reads Connected.
        assert_eq!(reg.list()[0].status, DevserverStatus::Connected);
        // The feed watchdog marks the sockets unreachable while the conn record
        // survives -> Unreachable.
        assert!(feed.set_unreachable(&id, true));
        assert_eq!(reg.list()[0].status, DevserverStatus::Unreachable);
        // Recovery clears it -> back to Connected.
        assert!(feed.set_unreachable(&id, false));
        assert_eq!(reg.list()[0].status, DevserverStatus::Connected);
        // Unreachable is a sub-state of a live conn: drop the conn and even a
        // lingering flag reads Disconnected, not Unreachable.
        feed.set_unreachable(&id, true);
        conns.remove(&id);
        assert_eq!(reg.list()[0].status, DevserverStatus::Disconnected);
    }

    /// `update` with a blank/absent token keeps the stored one; a non-blank
    /// token replaces it; `clear_token` removes it. URL/label/script are
    /// full-replace.
    #[test]
    fn registry_update_keeps_replaces_and_clears_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::new(crate::devserver::DevserverConns::default()),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let id = reg
            .add(DevserverInput {
                host: "127.0.0.1".into(),
                port: 8787,
                token: Some("tok_one".into()),
                ..Default::default()
            })
            .expect("add")
            .id;
        // Blank token + new url/label: token survives, the rest replace.
        let updated = reg
            .update(
                &id,
                DevserverInput {
                    host: "127.0.0.1".into(),
                    port: 9000,
                    label: Some("renamed".into()),
                    token: None,
                    ..Default::default()
                },
            )
            .expect("update")
            .expect("found");
        assert_eq!(updated.host, "127.0.0.1");
        assert_eq!(updated.port, 9000);
        assert_eq!(updated.label, "renamed");
        assert!(updated.has_token);
        assert_eq!(
            store.lock().unwrap().get().unwrap().devservers[0].token,
            "tok_one"
        );
        // A non-blank token replaces it.
        reg.update(
            &id,
            DevserverInput {
                host: "127.0.0.1".into(),
                port: 9000,
                token: Some("tok_two".into()),
                ..Default::default()
            },
        )
        .expect("update")
        .expect("found");
        assert_eq!(
            store.lock().unwrap().get().unwrap().devservers[0].token,
            "tok_two"
        );
        // An explicit clear removes it.
        let cleared = reg
            .update(
                &id,
                DevserverInput {
                    host: "127.0.0.1".into(),
                    port: 9000,
                    clear_token: true,
                    ..Default::default()
                },
            )
            .expect("update")
            .expect("found");
        assert!(!cleared.has_token);
        assert_eq!(store.lock().unwrap().get().unwrap().devservers[0].token, "");
    }

    #[test]
    fn registry_update_and_remove_missing_id_signal_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let reg = DevserverConfigRegistry::new(
            store,
            Arc::new(OnceLock::new()),
            Arc::new(crate::devserver::DevserverConns::default()),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let missing = reg
            .update(
                "nope",
                DevserverInput {
                    host: "127.0.0.1".into(),
                    port: 8787,
                    ..Default::default()
                },
            )
            .expect("update ok");
        assert!(missing.is_none());
        assert!(!reg.remove("nope").expect("remove ok"));
    }

    /// `remove` fires the teardown hook ONLY when a row was actually dropped,
    /// with that id -- so the HTTP DELETE reaps the live connection, and a
    /// missing-id remove (or a not-found) doesn't fire a spurious teardown.
    #[test]
    fn registry_remove_fires_hook_only_when_a_row_was_removed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let fired: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let hook_cell: Arc<OnceLock<DevserverRemoveHook>> = Arc::new(OnceLock::new());
        let fired_for_hook = Arc::clone(&fired);
        hook_cell
            .set(Arc::new(move |id: &str| {
                fired_for_hook.lock().unwrap().push(id.to_string());
                tauri::async_runtime::spawn(async {})
            }))
            .ok();
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::clone(&hook_cell),
            Arc::new(crate::devserver::DevserverConns::default()),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let id = reg
            .add(DevserverInput {
                host: "127.0.0.1".into(),
                port: 8787,
                ..Default::default()
            })
            .expect("add")
            .id;
        // Missing id: nothing dropped → hook must NOT fire.
        assert!(!reg.remove("nope").expect("remove ok"));
        assert!(fired.lock().unwrap().is_empty());
        // Real id: row dropped → hook fires once with that id.
        assert!(reg.remove(&id).expect("remove ok"));
        assert_eq!(fired.lock().unwrap().as_slice(), &[id]);
    }

    #[test]
    fn registry_add_rejects_an_empty_host() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let reg = DevserverConfigRegistry::new(
            store,
            Arc::new(OnceLock::new()),
            Arc::new(crate::devserver::DevserverConns::default()),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        assert!(reg
            .add(DevserverInput {
                host: "".into(),
                port: 8787,
                ..Default::default()
            })
            .is_err());
    }

    // --- window geometry ---

    fn mon(x: i32, y: i32, w: u32, h: u32, scale: f64) -> MonitorDesc {
        // Work area = full bounds minus a 40px top bar, to exercise the clamp.
        MonitorDesc {
            x,
            y,
            w,
            h,
            work_x: x,
            work_y: y + 40,
            work_w: w,
            work_h: h - 40,
            scale,
        }
    }

    fn geom(sig: &str, x: i32, y: i32, w: u32, h: u32, saved_at: u64) -> WindowGeometry {
        WindowGeometry {
            monitor_sig: sig.to_string(),
            x,
            y,
            w,
            h,
            saved_at,
        }
    }

    #[test]
    fn signature_is_order_independent() {
        let a = mon(0, 0, 2560, 1440, 2.0);
        let b = mon(2560, 0, 1920, 1080, 1.0);
        assert_eq!(
            monitor_signature(&[a.clone(), b.clone()]),
            monitor_signature(&[b, a]),
        );
    }

    #[test]
    fn signature_encodes_count_and_scale() {
        let sig = monitor_signature(&[mon(0, 0, 1920, 1080, 1.5)]);
        assert!(sig.starts_with("1|"), "sig={sig}");
        assert!(sig.contains("1920x1080@1.50"), "sig={sig}");
        // A different scale under the same size is a DIFFERENT signature.
        assert_ne!(sig, monitor_signature(&[mon(0, 0, 1920, 1080, 2.0)]));
        // A different SIZE is a different signature.
        assert_ne!(sig, monitor_signature(&[mon(0, 0, 2560, 1440, 1.5)]));
    }

    #[test]
    fn signature_ignores_monitor_position() {
        // macOS re-origins monitor positions when the Main display / menu bar
        // moves; the same hardware must keep the same signature so a reopen
        // doesn't fall through. Only size + scale + count matter.
        let at_origin = monitor_signature(&[mon(0, 0, 3840, 2160, 2.0)]);
        let shifted = monitor_signature(&[mon(-1512, 982, 3840, 2160, 2.0)]);
        assert_eq!(at_origin, shifted);
    }

    #[test]
    fn signature_changes_with_monitor_count() {
        let one = monitor_signature(&[mon(0, 0, 1920, 1080, 1.0)]);
        let two = monitor_signature(&[mon(0, 0, 1920, 1080, 1.0), mon(1920, 0, 1920, 1080, 1.0)]);
        assert_ne!(one, two);
    }

    #[test]
    fn push_geometry_inserts_and_dedupes_by_signature() {
        let mut cfg = Config::default();
        push_window_geometry(&mut cfg, "w1", geom("sigA", 10, 20, 800, 600, 100));
        // Same window + same signature: replaces, not appends; stays length 1.
        push_window_geometry(&mut cfg, "w1", geom("sigA", 30, 40, 900, 700, 200));
        assert_eq!(cfg.window_geometry.len(), 1);
        assert_eq!(cfg.window_geometry[0].geometries.len(), 1);
        assert_eq!(cfg.window_geometry[0].geometries[0].x, 30);
        assert_eq!(cfg.window_geometry[0].geometries[0].w, 900);
        assert_eq!(cfg.window_geometry[0].saved_at, 200);
    }

    #[test]
    fn push_geometry_keeps_per_signature_lru_capped_newest_first() {
        let mut cfg = Config::default();
        for i in 0..(MAX_WINDOW_GEOMETRIES as i32 + 3) {
            let sig = format!("sig{i}");
            push_window_geometry(&mut cfg, "w1", geom(&sig, i, i, 800, 600, 100 + i as u64));
        }
        assert_eq!(cfg.window_geometry.len(), 1);
        assert_eq!(
            cfg.window_geometry[0].geometries.len(),
            MAX_WINDOW_GEOMETRIES
        );
        let newest = format!("sig{}", MAX_WINDOW_GEOMETRIES as i32 + 2);
        assert_eq!(cfg.window_geometry[0].geometries[0].monitor_sig, newest);
    }

    #[test]
    fn push_geometry_caps_records_and_moves_touched_to_front() {
        let mut cfg = Config::default();
        for i in 0..(MAX_WINDOW_CONFIGS + 3) {
            let label = format!("w{i}");
            push_window_geometry(&mut cfg, &label, geom("s", 0, 0, 1, 1, 100 + i as u64));
        }
        // Capped at MAX_WINDOW_CONFIGS windows; newest label at the front, the
        // three oldest evicted.
        assert_eq!(cfg.window_geometry.len(), MAX_WINDOW_CONFIGS);
        let newest = format!("w{}", MAX_WINDOW_CONFIGS + 2);
        assert_eq!(cfg.window_geometry[0].window_label, newest);
        assert!(!cfg.window_geometry.iter().any(|r| r.window_label == "w0"));
        // Re-touching a surviving window moves its record to the front.
        let survivor = format!("w{}", MAX_WINDOW_CONFIGS);
        push_window_geometry(&mut cfg, &survivor, geom("s", 5, 5, 1, 1, 999));
        assert_eq!(cfg.window_geometry[0].window_label, survivor);
        assert_eq!(cfg.window_geometry.len(), MAX_WINDOW_CONFIGS);
    }

    #[test]
    fn lookup_geometry_exact_on_signature_match() {
        let mut cfg = Config::default();
        push_window_geometry(&mut cfg, "w1", geom("sigA", 10, 20, 800, 600, 100));
        match lookup_window_geometry(&cfg, "w1", "sigA") {
            Some(GeometryMatch::Exact(g)) => assert_eq!((g.x, g.y, g.w, g.h), (10, 20, 800, 600)),
            other => panic!("expected Exact, got {other:?}"),
        }
    }

    #[test]
    fn lookup_geometry_fallback_on_signature_mismatch() {
        let mut cfg = Config::default();
        push_window_geometry(&mut cfg, "w1", geom("sigA", 10, 20, 800, 600, 100));
        match lookup_window_geometry(&cfg, "w1", "sigOTHER") {
            // Fallback still carries the full stored rect; the apply path
            // preserves the position, clamped to its monitor.
            Some(GeometryMatch::Fallback(g)) => {
                assert_eq!((g.x, g.y, g.w, g.h), (10, 20, 800, 600))
            }
            other => panic!("expected Fallback, got {other:?}"),
        }
    }

    #[test]
    fn lookup_geometry_none_when_label_absent() {
        let cfg = Config::default();
        assert!(lookup_window_geometry(&cfg, "missing", "sigA").is_none());
    }

    #[test]
    fn geometry_flip_layout_and_back_restores_each_signature() {
        // The dual-monitor flip guardrail: capture under A, then under B, then
        // flip back to A -> A's own geometry is still remembered (Exact), not
        // overwritten by B.
        let mut cfg = Config::default();
        push_window_geometry(
            &mut cfg,
            "lib-ab::w-1",
            geom("sigA", 100, 100, 1200, 800, 100),
        );
        push_window_geometry(&mut cfg, "lib-ab::w-1", geom("sigB", 50, 50, 900, 700, 200));
        match lookup_window_geometry(&cfg, "lib-ab::w-1", "sigA") {
            Some(GeometryMatch::Exact(g)) => {
                assert_eq!((g.x, g.y, g.w, g.h), (100, 100, 1200, 800))
            }
            other => panic!("flip-back to A: expected Exact A, got {other:?}"),
        }
        match lookup_window_geometry(&cfg, "lib-ab::w-1", "sigB") {
            Some(GeometryMatch::Exact(g)) => assert_eq!((g.x, g.y, g.w, g.h), (50, 50, 900, 700)),
            other => panic!("on B: expected Exact B, got {other:?}"),
        }
    }

    #[test]
    fn monitor_for_rect_picks_the_containing_monitor() {
        // External (LG 4K) as the main display at origin, laptop BELOW it (the
        // host's layout). A window stored on the laptop maps to the laptop, not
        // the external -- so the restore clamps to the laptop's work area.
        let external = mon(0, 0, 3840, 2160, 2.0);
        let laptop = mon(0, 2160, 3024, 1964, 2.0);
        let mons = [external, laptop];
        assert_eq!(monitor_for_rect(&mons, 200, 2300, 1200, 800), Some(1));
        assert_eq!(monitor_for_rect(&mons, 200, 200, 1200, 800), Some(0));
    }

    #[test]
    fn monitor_for_rect_uses_max_overlap_and_none_when_offscreen() {
        let mons = [mon(0, 0, 1920, 1080, 1.0), mon(1920, 0, 1920, 1080, 1.0)];
        // Straddling the seam but mostly on the right monitor -> index 1.
        assert_eq!(monitor_for_rect(&mons, 1800, 100, 1000, 700), Some(1));
        // Entirely off every screen -> None (caller falls back to union box).
        assert_eq!(monitor_for_rect(&mons, 9000, 9000, 400, 300), None);
    }

    #[test]
    fn to_points_divides_bounds_by_scale() {
        // A 2x monitor's physical bounds halve to points; scale is preserved.
        let p = to_points(&mon(0, 0, 3024, 1964, 2.0));
        assert_eq!((p.x, p.y, p.w, p.h), (0, 0, 1512, 982));
        // mon() carves a 40px physical top bar; it halves to 20 points.
        assert_eq!((p.work_x, p.work_y, p.work_w, p.work_h), (0, 20, 1512, 962));
        assert_eq!(p.scale, 2.0);
        // A 1x monitor is unchanged.
        let m1 = mon(1512, 0, 1920, 1080, 1.0);
        assert_eq!(to_points(&m1), m1);
        // scale 0 guards to 1.0 so there is no divide-by-zero.
        assert_eq!(to_points(&mon(0, 0, 100, 100, 0.0)).w, 100);
    }

    #[test]
    fn monitor_for_rect_in_points_picks_the_external_where_physical_ties() {
        // 2x built-in main at the origin, 1x external to its right. tao reports
        // monitor bounds as points times the monitor's own scale, so the external's
        // origin (1512x1) lands inside the main's doubled extent (1512x2 = 3024): a
        // window on the external overlaps BOTH monitors' physical bounds equally, so
        // monitor_for_rect ties to the first-enumerated (the main). Converting to
        // points tiles the monitors and identifies the external cleanly.
        let mons = [mon(0, 0, 3024, 1964, 2.0), mon(1512, 0, 1920, 1080, 1.0)];
        let (wx, wy, ww, wh) = (1900, 200, 800, 600);
        // Physical space misattributes the external window to the main (index 0).
        assert_eq!(monitor_for_rect(&mons, wx, wy, ww, wh), Some(0));
        // Points space picks the external (index 1).
        let pmons: Vec<_> = mons.iter().map(to_points).collect();
        assert_eq!(monitor_for_rect(&pmons, wx, wy, ww, wh), Some(1));
    }

    #[test]
    fn work_area_bbox_excludes_the_menu_bar() {
        // mon() carves a 40px top bar out of the work area.
        let m = mon(0, 0, 3840, 2160, 2.0);
        assert_eq!(work_area_bbox(&m), (0, 40, 3840, 2160));
    }

    #[test]
    fn clamp_to_actual_monitor_preserves_position_on_a_secondary() {
        // A window stored on the BELOW laptop stays on the laptop at its stored
        // position (it is within that monitor's work area), not centered or
        // pulled to the primary external display.
        let external = mon(0, 0, 3840, 2160, 2.0);
        let laptop = mon(0, 2160, 3024, 1964, 2.0); // work y[2200,4124]
        let mons = [external, laptop];
        let idx = monitor_for_rect(&mons, 300, 2400, 1200, 800).unwrap();
        let (x, y, w, h) = clamp_rect_to_bbox(300, 2400, 1200, 800, work_area_bbox(&mons[idx]));
        assert_eq!((x, y, w, h), (300, 2400, 1200, 800));
    }

    #[test]
    fn clamp_rect_leaves_onscreen_rect_unchanged() {
        let bbox = union_work_bbox(&[mon(0, 0, 2560, 1440, 2.0)]).unwrap();
        assert_eq!(
            clamp_rect_to_bbox(100, 100, 1200, 800, bbox),
            (100, 100, 1200, 800)
        );
    }

    #[test]
    fn clamp_rect_pulls_offscreen_rect_back() {
        // work area: x[0,2560], y[40,1440]
        let bbox = union_work_bbox(&[mon(0, 0, 2560, 1440, 2.0)]).unwrap();
        // Bottom-right overflow: top-left pulled so the 1200x800 window fits.
        assert_eq!(
            clamp_rect_to_bbox(9000, 9000, 1200, 800, bbox),
            (1360, 640, 1200, 800)
        );
        // Negative origin pulled to the work-area min (x=0, y=40).
        let (x, y, _, _) = clamp_rect_to_bbox(-500, -500, 1200, 800, bbox);
        assert_eq!((x, y), (0, 40));
    }

    #[test]
    fn clamp_rect_shrinks_window_larger_than_desktop() {
        let bbox = union_work_bbox(&[mon(0, 0, 1280, 800, 1.0)]).unwrap(); // work 1280x760
        assert_eq!(
            clamp_rect_to_bbox(0, 40, 4000, 4000, bbox),
            (0, 40, 1280, 760)
        );
    }

    #[test]
    fn clamp_rect_keeps_window_on_second_monitor() {
        // Two side-by-side monitors; a window on the right one stays put.
        let bbox =
            union_work_bbox(&[mon(0, 0, 1920, 1080, 1.0), mon(1920, 0, 1920, 1080, 1.0)]).unwrap(); // x[0,3840], y[40,1080]
        assert_eq!(
            clamp_rect_to_bbox(2000, 100, 1000, 700, bbox),
            (2000, 100, 1000, 700)
        );
    }

    #[test]
    fn union_work_bbox_none_for_empty() {
        assert!(union_work_bbox(&[]).is_none());
    }

    #[test]
    fn config_loads_without_window_geometry_field() {
        // A config.json predating window geometry must still load: serde reads
        // the missing key as the empty set, so the load never fails and drops
        // the rest of the config.
        let raw = r#"{ "outbound": [], "window_configs": [] }"#;
        let cfg: Config = serde_json::from_str(raw).expect("load without window_geometry");
        assert!(cfg.window_geometry.is_empty());
    }

    #[test]
    fn window_geometry_round_trips() {
        let mut cfg = Config::default();
        push_window_geometry(
            &mut cfg,
            "lib-ab::w-1",
            geom("sigA", 100, 100, 1200, 800, 100),
        );
        push_window_geometry(&mut cfg, "lib-ab::w-1", geom("sigB", 50, 50, 900, 700, 200));
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: Config = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.window_geometry.len(), 1);
        let rec = &back.window_geometry[0];
        assert_eq!(rec.window_label, "lib-ab::w-1");
        assert_eq!(rec.geometries.len(), 2);
        // Newest (sigB) first.
        assert_eq!(rec.geometries[0].monitor_sig, "sigB");
        assert_eq!(rec.geometries[1].monitor_sig, "sigA");
    }

    fn legacy_gateway_row(id: &str, url: &str, label: &str) -> Devserver {
        Devserver {
            id: id.to_string(),
            url: url.to_string(),
            script: String::new(),
            label: label.to_string(),
            token: String::new(),
            added_at: 42,
            auto_hide_control: false,
            gateway_owner: Some("alice".to_string()),
            gateway_devserver_id: Some("d".repeat(64)),
        }
    }

    fn plain_row(id: &str, url: &str) -> Devserver {
        Devserver {
            id: id.to_string(),
            url: url.to_string(),
            script: String::new(),
            label: String::new(),
            token: String::new(),
            added_at: 7,
            auto_hide_control: false,
            gateway_owner: None,
            gateway_devserver_id: None,
        }
    }

    #[test]
    fn config_loads_without_gateways_field() {
        // A config.json predating gateways must still load: serde reads the
        // missing key as the empty vec.
        let raw = r#"{ "outbound": [], "devservers": [] }"#;
        let cfg: Config = serde_json::from_str(raw).expect("load without gateways");
        assert!(cfg.gateways.is_empty());
    }

    #[test]
    fn gateway_enabled_defaults_true() {
        // A hand-edited row without the field behaves like a fresh add.
        let raw = r#"{ "id": "gw-00000000", "url": "https://gw.chan.app" }"#;
        let gw: Gateway = serde_json::from_str(raw).expect("gateway row");
        assert!(gw.enabled);
        assert!(gw.label.is_empty());
    }

    #[test]
    fn migration_converts_legacy_rows_and_keeps_plain_ones() {
        let mut cfg = Config {
            devservers: vec![
                legacy_gateway_row("ds1", "https://GW.chan.app/consent?x=1", "work"),
                plain_row("ds2", "http://box.example.com:8787"),
            ],
            ..Default::default()
        };
        let outcome = split_legacy_gateway_rows(&mut cfg);
        // The legacy row became a gateway: origin-normalized URL (host
        // lowercased, path/query dropped), label + added_at carried, enabled.
        assert_eq!(cfg.gateways.len(), 1);
        let gw = &cfg.gateways[0];
        assert_eq!(gw.url, "https://gw.chan.app");
        assert_eq!(gw.label, "work");
        assert_eq!(gw.added_at, 42);
        assert!(gw.enabled);
        // The plain row stayed; the legacy row is gone.
        assert_eq!(cfg.devservers.len(), 1);
        assert_eq!(cfg.devservers[0].id, "ds2");
        assert_eq!(outcome.created.len(), 1);
        assert_eq!(outcome.converted_rows, 1);
        assert!(outcome.changed());
    }

    #[test]
    fn migration_merges_same_origin_rows_and_existing_gateways() {
        let mut cfg = Config {
            devservers: vec![
                legacy_gateway_row("ds1", "https://gw.chan.app/a", ""),
                legacy_gateway_row("ds2", "https://gw.chan.app/b", "named"),
                legacy_gateway_row("ds3", "https://other.example", "elsewhere"),
            ],
            gateways: vec![Gateway {
                id: "gw-11111111".to_string(),
                url: "https://other.example".to_string(),
                label: String::new(),
                enabled: true,
                added_at: 1,
                native_trust: Vec::new(),
            }],
            ..Default::default()
        };
        let outcome = split_legacy_gateway_rows(&mut cfg);
        // Two same-origin rows collapse into ONE new gateway; the first
        // non-empty label wins. The third row merges into the pre-existing
        // entry (filling its empty label) instead of duplicating it.
        assert_eq!(cfg.gateways.len(), 2);
        assert_eq!(cfg.gateways[0].url, "https://other.example");
        assert_eq!(cfg.gateways[0].label, "elsewhere");
        assert_eq!(cfg.gateways[1].url, "https://gw.chan.app");
        assert_eq!(cfg.gateways[1].label, "named");
        assert!(cfg.devservers.is_empty());
        assert_eq!(outcome.created.len(), 1);
        assert_eq!(outcome.converted_rows, 3);
    }

    #[test]
    fn migration_keeps_unparseable_rows_as_plain_devservers() {
        // Losing the row would lose user data; clearing the markers keeps it
        // usable as a plain devserver and stops the migration re-visiting it.
        let mut cfg = Config {
            devservers: vec![legacy_gateway_row("ds1", "not a url", "broken")],
            ..Default::default()
        };
        let outcome = split_legacy_gateway_rows(&mut cfg);
        assert!(cfg.gateways.is_empty());
        assert_eq!(cfg.devservers.len(), 1);
        assert_eq!(cfg.devservers[0].gateway_owner, None);
        assert_eq!(cfg.devservers[0].gateway_devserver_id, None);
        // Clearing alone still counts as a change: the driver must persist
        // it or every startup re-visits the row.
        assert_eq!(outcome.converted_rows, 0);
        assert_eq!(outcome.cleared_marker_rows, 1);
        assert!(outcome.changed());
    }

    #[test]
    fn migration_driver_persists_marker_clearing_alone() {
        // An unparseable legacy row is the ONLY change: the cleared
        // markers must reach disk, making the second run a no-op.
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        {
            let mut guard = store.lock().unwrap();
            let cfg = Config {
                devservers: vec![legacy_gateway_row("ds1", "not a url", "broken")],
                ..Default::default()
            };
            guard.save(&cfg).unwrap();
        }
        let first = migrate_legacy_gateway_rows(&store).unwrap();
        assert!(first.changed());
        let persisted = store.lock().unwrap().get().unwrap();
        assert_eq!(persisted.devservers[0].gateway_owner, None);
        assert_eq!(persisted.devservers[0].gateway_devserver_id, None);
        let second = migrate_legacy_gateway_rows(&store).unwrap();
        assert!(!second.changed(), "second run re-visits nothing");
    }

    #[test]
    fn migration_driver_persists_once_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        {
            let mut guard = store.lock().unwrap();
            let cfg = Config {
                devservers: vec![legacy_gateway_row("ds1", "https://gw.chan.app", "")],
                ..Default::default()
            };
            guard.save(&cfg).unwrap();
        }
        let first = migrate_legacy_gateway_rows(&store).unwrap();
        assert!(first.changed());
        let after_first = store.lock().unwrap().get().unwrap();
        assert_eq!(after_first.gateways.len(), 1);
        assert!(after_first.devservers.is_empty());
        // A second run converts nothing and leaves the file as-is.
        let second = migrate_legacy_gateway_rows(&store).unwrap();
        assert!(!second.changed());
        assert_eq!(
            serde_json::to_value(store.lock().unwrap().get().unwrap()).unwrap(),
            serde_json::to_value(&after_first).unwrap()
        );
    }

    fn test_discovery() -> crate::devserver::GatewayDiscovery {
        crate::devserver::GatewayDiscovery {
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

    fn roster_row(
        owner: &str,
        id: &str,
        label: &str,
        shared: bool,
    ) -> crate::gateway::RosterDevserver {
        crate::gateway::RosterDevserver {
            owner_user_id: if owner == "alice" {
                uuid::Uuid::from_u128(1)
            } else {
                uuid::Uuid::from_u128(2)
            },
            owner: owner.to_string(),
            devserver_id: id.to_string(),
            label: label.to_string(),
            online: true,
            shared,
            proxy_origin: Some("https://p1.usr.chan.app".to_string()),
        }
    }

    fn registry_with_gateway_roster() -> (tempfile::TempDir, DevserverConfigRegistry) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        {
            let mut guard = store.lock().unwrap();
            let cfg = Config {
                devservers: vec![plain_row("ds1", "http://box.example.com:8787")],
                gateways: vec![Gateway {
                    id: "gw-1a2b3c4d".to_string(),
                    url: "https://gw.chan.app".to_string(),
                    label: "work".to_string(),
                    enabled: true,
                    added_at: 1,
                    native_trust: Vec::new(),
                }],
                ..Default::default()
            };
            guard.save(&cfg).unwrap();
        }
        let manager = Arc::new(crate::gateway::GatewayManager::default());
        manager.seed_test_runtime(
            "gw-1a2b3c4d",
            test_discovery(),
            vec![
                roster_row("alice", &"a".repeat(64), "laptop", false),
                roster_row("bob", &"b".repeat(64), "shared-box", true),
            ],
        );
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::new(crate::devserver::DevserverConns::default()),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            manager,
        );
        (dir, reg)
    }

    #[test]
    fn list_appends_synthesized_gateway_rows() {
        let (_dir, reg) = registry_with_gateway_roster();
        let rows = reg.list();
        assert_eq!(rows.len(), 3, "one plain + two synthesized");
        assert_eq!(rows[0].id, "ds1");
        assert_eq!(rows[0].gateway_id, None);

        let own = &rows[1];
        assert_eq!(own.id, format!("gw:1a2b3c4d:alice:{}", "a".repeat(64)));
        assert_eq!(own.gateway_id.as_deref(), Some("gw-1a2b3c4d"));
        assert_eq!(own.gateway_url, "https://gw.chan.app");
        assert!(!own.shared);
        assert!(!own.native_trust_required);
        assert_eq!(own.label, "laptop");
        assert_eq!(own.status, DevserverStatus::Disconnected);
        assert!(!own.has_token);
        assert!(own.script.is_empty());
        assert_eq!(own.host, "gw.chan.app");

        let shared = &rows[2];
        assert_eq!(shared.id, format!("gw:1a2b3c4d:bob:{}", "b".repeat(64)));
        assert!(shared.shared);
        assert!(shared.native_trust_required);

        // Trust is the exact full tuple under this gateway. Once persisted it
        // survives a fresh config read and only that shared row flips.
        assert!(set_native_trust(
            &reg.store,
            "gw-1a2b3c4d",
            uuid::Uuid::from_u128(2),
            "bob",
            &"b".repeat(64),
            true,
        )
        .unwrap());
        assert!(
            !set_native_trust(
                &reg.store,
                "gw-1a2b3c4d",
                uuid::Uuid::from_u128(2),
                "bob",
                &"b".repeat(64),
                true,
            )
            .unwrap(),
            "re-grant is idempotent"
        );
        let trusted = reg.list();
        assert!(!trusted[1].native_trust_required);
        assert!(!trusted[2].native_trust_required);
        assert_eq!(
            reg.store.lock().unwrap().get().unwrap().gateways[0]
                .native_trust
                .len(),
            1,
            "idempotent grant persists one exact record"
        );

        // Deterministic across calls while nothing changes.
        assert_eq!(reg.list(), trusted);
        assert!(set_native_trust(
            &reg.store,
            "gw-1a2b3c4d",
            uuid::Uuid::from_u128(2),
            "bob",
            &"b".repeat(64),
            false,
        )
        .unwrap());
        assert!(reg.list()[2].native_trust_required);
    }

    #[test]
    fn synthesized_status_maps_conn_and_roster_online_three_ways() {
        // conn live -> Connected; no conn + online -> Disconnected; no conn
        // + offline -> Unreachable (the lost dot as a pre-connect signal).
        // Gateway-level trouble never reaches row status.
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        {
            let cfg = Config {
                gateways: vec![Gateway {
                    id: "gw-1a2b3c4d".to_string(),
                    url: "https://gw.chan.app".to_string(),
                    label: String::new(),
                    enabled: true,
                    added_at: 1,
                    native_trust: Vec::new(),
                }],
                ..Default::default()
            };
            store.lock().unwrap().save(&cfg).unwrap();
        }
        let manager = Arc::new(crate::gateway::GatewayManager::default());
        let mut offline = roster_row("alice", &"b".repeat(64), "dark-box", false);
        offline.online = false;
        manager.seed_test_runtime(
            "gw-1a2b3c4d",
            test_discovery(),
            vec![
                roster_row("alice", &"a".repeat(64), "laptop", false),
                offline,
            ],
        );
        let conns = Arc::new(crate::devserver::DevserverConns::default());
        let reg = DevserverConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::clone(&conns),
            empty_connecting(),
            Arc::new(crate::DevserverFeed::default()),
            manager,
        );
        let rows = reg.list();
        assert_eq!(
            rows[0].status,
            DevserverStatus::Disconnected,
            "online, no conn"
        );
        assert_eq!(
            rows[1].status,
            DevserverStatus::Unreachable,
            "offline, no conn"
        );
        // A live conn wins over the roster bit.
        conns.set(
            rows[0].id.clone(),
            crate::devserver::DevserverConn {
                host: "alice--aaaaaaaaaaaa.p1.usr.chan.app".to_string(),
                port: 443,
                token: String::new(),
                name: "laptop".to_string(),
                gateway: None,
            },
        );
        assert_eq!(
            reg.list()[0].status,
            DevserverStatus::Connected,
            "conn live"
        );
    }

    #[test]
    fn update_and_remove_answer_missing_for_synthesized_ids() {
        // Synthesized rows carry no local config: the route layer must 404
        // mutations, which the registry signals out-of-band.
        let (_dir, reg) = registry_with_gateway_roster();
        let synth = format!("gw:1a2b3c4d:alice:{}", "a".repeat(64));
        let update = reg.update(
            &synth,
            DevserverInput {
                url: None,
                host: "box.example.com".into(),
                port: 8787,
                label: None,
                script: None,
                token: None,
                clear_token: false,
                auto_hide_control: false,
            },
        );
        assert_eq!(update, Ok(None));
        assert_eq!(reg.remove(&synth), Ok(false));
        // And the synthesized rows are untouched by the attempts.
        assert_eq!(reg.list().len(), 3);
    }

    #[test]
    fn convert_handoff_row_becomes_or_merges_into_a_gateway() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        {
            let cfg = Config {
                devservers: vec![
                    plain_row("ds1", "https://gw.example.com/some/path"),
                    plain_row("ds2", "https://gw.chan.app"),
                    plain_row("ds3", "not a url"),
                ],
                gateways: vec![Gateway {
                    id: "gw-11111111".to_string(),
                    url: "https://gw.chan.app".to_string(),
                    label: String::new(),
                    enabled: true,
                    added_at: 1,
                    native_trust: Vec::new(),
                }],
                ..Default::default()
            };
            store.lock().unwrap().save(&cfg).unwrap();
        }
        // A fresh origin becomes a new gateway; the row is gone.
        let gw = convert_devserver_row_to_gateway(&store, "ds1")
            .expect("convert")
            .expect("row existed");
        assert_eq!(gw.url, "https://gw.example.com");
        assert!(gw.enabled);
        let cfg = store.lock().unwrap().get().unwrap();
        assert!(!cfg.devservers.iter().any(|d| d.id == "ds1"));
        assert_eq!(cfg.gateways.len(), 2);
        // A known origin merges into the existing entry (no duplicate).
        let gw = convert_devserver_row_to_gateway(&store, "ds2")
            .expect("convert")
            .expect("row existed");
        assert_eq!(gw.id, "gw-11111111");
        let cfg = store.lock().unwrap().get().unwrap();
        assert_eq!(cfg.gateways.len(), 2);
        // Unknown id (removed meanwhile): None, nothing changes.
        assert_eq!(convert_devserver_row_to_gateway(&store, "ghost"), Ok(None));
        // An unparseable row URL errors and the config stays untouched.
        assert!(convert_devserver_row_to_gateway(&store, "ds3").is_err());
        let cfg = store.lock().unwrap().get().unwrap();
        assert!(cfg.devservers.iter().any(|d| d.id == "ds3"));
    }

    #[test]
    fn gateway_registry_add_normalizes_dedups_and_mints_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let reg = GatewayConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let added = reg
            .add(GatewayInput {
                url: "https://GW.chan.app/consent?pick=1".to_string(),
                label: Some("  work  ".to_string()),
            })
            .expect("add");
        assert_eq!(added.url, "https://gw.chan.app");
        assert_eq!(added.label, "work");
        assert!(added.enabled);
        assert_eq!(added.status, GatewayStatus::Disconnected);
        // The minted id is gw- + 8 lowercase hex (the synthesized-row id
        // charset depends on it).
        let hex = added.id.strip_prefix("gw-").expect("gw- prefix");
        assert_eq!(hex.len(), 8);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        // Same origin (different noise) is a dup.
        let err = reg
            .add(GatewayInput {
                url: "https://gw.chan.app/other".to_string(),
                label: None,
            })
            .expect_err("dup origin");
        assert!(err.contains("already configured"), "{err}");
        // Non-http(s) is rejected.
        assert!(reg
            .add(GatewayInput {
                url: "ftp://gw.chan.app".to_string(),
                label: None,
            })
            .is_err());
        assert_eq!(reg.list().len(), 1);
    }

    #[test]
    fn gateway_registry_update_renames_and_keeps_the_url_immutable() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let reg = GatewayConfigRegistry::new(
            Arc::clone(&store),
            Arc::new(OnceLock::new()),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        let added = reg
            .add(GatewayInput {
                url: "https://gw.chan.app".to_string(),
                label: Some("work".to_string()),
            })
            .expect("add");
        // Rename: label is full-replace (trimmed), echoing the stored URL back
        // is fine, and the new label persists in the config store.
        let updated = reg
            .update(
                &added.id,
                GatewayInput {
                    url: "https://gw.chan.app".to_string(),
                    label: Some("  prod  ".to_string()),
                },
            )
            .expect("update")
            .expect("row exists");
        assert_eq!(updated.id, added.id);
        assert_eq!(updated.url, "https://gw.chan.app");
        assert_eq!(updated.label, "prod");
        let cfg = store.lock().unwrap().get().unwrap();
        assert_eq!(cfg.gateways[0].label, "prod");
        // An empty url means keep; an absent label clears (the badge derives
        // from the URL host again).
        let cleared = reg
            .update(
                &added.id,
                GatewayInput {
                    url: String::new(),
                    label: None,
                },
            )
            .expect("update")
            .expect("row exists");
        assert_eq!(cleared.url, "https://gw.chan.app");
        assert_eq!(cleared.label, "");
        // A different origin is refused: the URL is identity (remove + re-add
        // is the origin-change path) and the stored row stays untouched.
        let err = reg
            .update(
                &added.id,
                GatewayInput {
                    url: "https://other.example".to_string(),
                    label: Some("x".to_string()),
                },
            )
            .expect_err("url change refused");
        assert!(err.contains("immutable"), "{err}");
        let cfg = store.lock().unwrap().get().unwrap();
        assert_eq!(cfg.gateways[0].url, "https://gw.chan.app");
        assert_eq!(cfg.gateways[0].label, "");
        // Same origin with URL noise still counts as a match (normalized).
        assert!(reg
            .update(
                &added.id,
                GatewayInput {
                    url: "https://GW.chan.app/consent?pick=1".to_string(),
                    label: Some("noisy".to_string()),
                },
            )
            .expect("update")
            .is_some());
        // Unknown id: None, nothing changes.
        assert_eq!(
            reg.update(
                "gw-deadbeef",
                GatewayInput {
                    url: String::new(),
                    label: None,
                },
            ),
            Ok(None)
        );
    }

    #[test]
    fn gateway_registry_remove_fires_hook_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore {
            path: dir.path().join("config.json"),
        }));
        let hook_cell: Arc<OnceLock<GatewayRemoveHook>> = Arc::new(OnceLock::new());
        let removed_ids: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&removed_ids);
        hook_cell
            .set(Arc::new(move |id: &str| {
                sink.lock().unwrap().push(id.to_string());
            }))
            .ok()
            .expect("hook installs once");
        let reg = GatewayConfigRegistry::new(
            Arc::clone(&store),
            Arc::clone(&hook_cell),
            Arc::new(crate::gateway::GatewayManager::default()),
        );
        assert_eq!(reg.remove("gw-deadbeef"), Ok(false));
        assert!(removed_ids.lock().unwrap().is_empty());
        let added = reg
            .add(GatewayInput {
                url: "https://gw.chan.app".to_string(),
                label: None,
            })
            .expect("add");
        assert_eq!(reg.remove(&added.id), Ok(true));
        assert_eq!(*removed_ids.lock().unwrap(), vec![added.id]);
        assert!(reg.list().is_empty());
    }
}
