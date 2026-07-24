//! Managed per-gateway account connections.
//!
//! A configured [`Gateway`](crate::config::Gateway) is connected at the
//! ACCOUNT level: the desktop discovers the gateway once, signs in once per
//! gateway account (`desktop.account` scope, PAT in the OS keyring), and
//! polls the gateway's devserver roster; the rostered devservers surface as
//! synthesized rows in the launcher list and vanish when the gateway
//! disconnects. This module owns that lifecycle: the runtime map behind
//! [`GatewayManager`], the connect flow, the roster poll, and the cascade
//! teardown.
//!
//! Failure semantics are load-bearing and test-pinned: an upstream failure
//! (network, 5xx - the roster's own 502 body is `{"error":"upstream
//! error"}`) KEEPS the last-known roster and retries, flipping the gateway
//! to `unreachable` only after [`ROSTER_UNREACHABLE_FAILURES`] consecutive
//! misses; ONLY a 401 runs the disconnect cascade and clears the stored
//! PAT. A degraded all-offline roster is never synthesized - dropping rows
//! on a flaky upstream would close every gateway window.
//!
//! Sign-in is single-flight (the pending-auth slot in [`crate::auth`] is
//! process-global latest-wins): one gateway sign-in may be in the browser
//! at a time; a second Connect on ANOTHER gateway surfaces a busy notice
//! instead of a parallel browser leg. A re-click on the SAME gateway
//! falls through latest-wins and re-opens the browser - the prior tab
//! orphans into a state-mismatch failure - which is deliberate: the
//! fall-through is the user's retry hatch. Because the slot is single,
//! ANY consumed callback (success, failure, cancellation) or a competing
//! sign-in replacing the slot settles every parked gateway wait:
//! [`abandon_pending_signins`] resets them so no spinner or busy gate
//! outlives its browser leg. A callback that resumes a gateway removed
//! mid-flight is dropped with a notice; one that resumes a gateway the
//! user disconnected meanwhile stores the PAT but stays disconnected.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use chan_server::GatewayStatus;

use crate::config::{self, Gateway};
use crate::devserver::{self, GatewayDiscovery};
use crate::{auth, AppState};

/// Roster poll cadence per connected gateway.
pub const ROSTER_POLL_SECS: u64 = 10;
/// Consecutive roster-poll failures before a gateway reports
/// `unreachable`. The last-known roster stays served throughout.
pub const ROSTER_UNREACHABLE_FAILURES: u32 = 3;
/// Bound on one roster round trip.
const ROSTER_HTTP_TIMEOUT_SECS: u64 = 5;

/// The launcher-notice event: corner bubbles in the launcher, each naming
/// its SOURCE (gateway / devserver / desktop), expandable to the full
/// message, dismissable.
pub const LAUNCHER_NOTICE: &str = "launcher-notice";

/// One devserver row from the gateway's roster, plus the derived
/// `shared` flag (immutable owner id differs from the account id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterDevserver {
    pub owner_user_id: uuid::Uuid,
    pub owner: String,
    pub devserver_id: String,
    pub label: String,
    pub online: bool,
    pub shared: bool,
    /// The controller-derived exact origin of the proxy node serving this
    /// devserver; `None` while offline. The desktop reads it ONLY to detect
    /// an online registration moving nodes (the roster diff classifies the
    /// move): origin authority comes from entry-response validation, never
    /// from roster state.
    pub proxy_origin: Option<String>,
}

/// The roster endpoint's 200 body.
#[derive(Debug, Deserialize)]
struct RosterResponse {
    user_id: uuid::Uuid,
    username: String,
    devservers: Vec<RosterRow>,
}

#[derive(Debug, Deserialize)]
struct RosterRow {
    owner_user_id: uuid::Uuid,
    owner: String,
    devserver_id: String,
    #[serde(default)]
    label: String,
    online: bool,
    /// Null while the devserver is offline, the exact node origin while
    /// online. A lifecycle signal only: it never authorizes the origin.
    proxy_origin: Option<String>,
}

/// What one roster round trip amounted to.
#[derive(Debug)]
pub enum RosterFetch {
    /// 200: a fresh roster (and its ETag for the next conditional GET).
    Fresh {
        username: String,
        rows: Vec<RosterDevserver>,
        etag: Option<String>,
    },
    /// 304: the roster is unchanged.
    NotModified,
    /// 401: the PAT is dead or under-scoped. The ONLY outcome that
    /// cascades.
    Unauthorized,
    /// Everything else (network, decode, 5xx incl. the roster's 502
    /// upstream-error body): keep the last-known roster and retry.
    Upstream(String),
}

/// Live state of one connected (or connecting) gateway.
pub struct GatewayRuntime {
    pub discovery: GatewayDiscovery,
    pub username: String,
    pub roster: Vec<RosterDevserver>,
    pub etag: Option<String>,
    pub status: GatewayStatus,
    pub last_error: Option<String>,
    pub consecutive_failures: u32,
    pub pending_signin: bool,
    /// Stamp of the sign-in wait, so only the matching timeout clears it
    /// (a re-click re-stamps; the stale task then no-ops).
    signin_stamp: u64,
    poll_cancel: Option<CancellationToken>,
}

/// The registry's projection of a runtime: the volatile GatewayEntry
/// fields.
#[derive(Debug, Clone, Default)]
pub struct GatewayRuntimeView {
    pub status: GatewayStatus,
    pub pending_signin: bool,
    pub devserver_count: usize,
    pub last_error: Option<String>,
}

/// Effect of applying one roster fetch to a runtime, for the caller to
/// act on outside the lock.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FetchEffect {
    /// The launcher-visible state changed: fire signal_library_change.
    pub changed: bool,
    /// The PAT is dead: run the 401 cascade.
    pub cascade: bool,
    /// This fetch crossed the unreachable threshold: emit the notice once.
    pub became_unreachable: bool,
    /// Actionable membership/policy/node-move changes from a fresh roster.
    /// The caller applies teardown and trust pruning after releasing the
    /// runtime-map lock.
    pub diff: RosterDiff,
}

/// Process-wide gateway runtime map. Lives in [`AppState`] and is shared
/// with the config registry for its live-state projection.
#[derive(Default)]
pub struct GatewayManager {
    runtimes: Mutex<HashMap<String, GatewayRuntime>>,
}

impl GatewayManager {
    /// The volatile GatewayEntry fields for `gateway_id`, or `None` when
    /// the gateway has no runtime (renders as disconnected defaults).
    pub fn view(&self, gateway_id: &str) -> Option<GatewayRuntimeView> {
        let runtimes = self.runtimes.lock().unwrap();
        runtimes.get(gateway_id).map(|rt| GatewayRuntimeView {
            status: rt.status,
            pending_signin: rt.pending_signin,
            devserver_count: rt.roster.len(),
            last_error: rt.last_error.clone(),
        })
    }

    /// Whether ANY gateway sign-in is waiting on the browser. The pending
    /// slot in auth is process-global latest-wins, so a second browser leg
    /// would orphan the first: callers surface a notice instead.
    pub fn any_pending_signin(&self) -> bool {
        self.runtimes
            .lock()
            .unwrap()
            .values()
            .any(|rt| rt.pending_signin)
    }

    /// The roster snapshot of a connected gateway (synthesized-row
    /// sources). Empty when the gateway has no runtime.
    pub fn roster(&self, gateway_id: &str) -> Vec<RosterDevserver> {
        self.runtimes
            .lock()
            .unwrap()
            .get(gateway_id)
            .map(|rt| rt.roster.clone())
            .unwrap_or_default()
    }

    /// The validated discovery of a gateway with a live runtime, for the
    /// rostered-devserver connect path. `None` when the gateway is not
    /// connected.
    pub fn discovery(&self, gateway_id: &str) -> Option<GatewayDiscovery> {
        self.runtimes
            .lock()
            .unwrap()
            .get(gateway_id)
            .map(|rt| rt.discovery.clone())
    }

    /// One rostered devserver by its (owner, id) key. `None` when the
    /// gateway has no runtime or the roster no longer carries the row.
    pub fn roster_row(
        &self,
        gateway_id: &str,
        owner: &str,
        devserver_id: &str,
    ) -> Option<RosterDevserver> {
        self.runtimes
            .lock()
            .unwrap()
            .get(gateway_id)
            .and_then(|rt| {
                rt.roster
                    .iter()
                    .find(|r| r.owner == owner && r.devserver_id == devserver_id)
                    .cloned()
            })
    }

    /// Seed a runtime with a fixed roster, bypassing the connect flow, so
    /// registry-projection tests exercise synthesized rows without HTTP.
    #[cfg(test)]
    pub(crate) fn seed_test_runtime(
        &self,
        gateway_id: &str,
        discovery: GatewayDiscovery,
        roster: Vec<RosterDevserver>,
    ) {
        let mut rt = new_runtime(discovery);
        rt.roster = roster;
        rt.status = GatewayStatus::Connected;
        self.runtimes
            .lock()
            .unwrap()
            .insert(gateway_id.to_string(), rt);
    }
}

/// Split a synthesized row id back into (gateway id, owner, devserver id);
/// `None` for anything that is not a well-formed `gw:` triple. The
/// gateway id comes back WITH its `gw-` prefix, ready for config lookups.
pub fn parse_synthesized_id(id: &str) -> Option<(String, String, String)> {
    let rest = id.strip_prefix("gw:")?;
    let mut parts = rest.splitn(3, ':');
    let (hex, owner, devserver_id) = (parts.next()?, parts.next()?, parts.next()?);
    if hex.is_empty() || owner.is_empty() || devserver_id.is_empty() {
        return None;
    }
    Some((
        format!("gw-{hex}"),
        owner.to_string(),
        devserver_id.to_string(),
    ))
}

/// The synthesized launcher-row id for a rostered devserver:
/// `gw:{gateway 8hex sans prefix}:{owner}:{devserver_id}`. Every segment
/// is pinned to `[A-Za-z0-9_-]` (Tauri label charset, `::`-free for the
/// watcher's label parsing); the debug assert catches a wire value that
/// breaks the invariant before it becomes a window label.
pub fn synthesized_row_id(gateway_id: &str, owner: &str, devserver_id: &str) -> String {
    let gw_hex = gateway_id.strip_prefix("gw-").unwrap_or(gateway_id);
    debug_assert!(
        [gw_hex, owner, devserver_id].iter().all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        }),
        "synthesized id segment outside [A-Za-z0-9_-]: {gw_hex}/{owner}/{devserver_id}"
    );
    format!("gw:{gw_hex}:{owner}:{devserver_id}")
}

/// Difference between two roster snapshots, keyed by (owner, id).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RosterDiff {
    pub added: Vec<(String, String)>,
    pub removed: Vec<(String, String)>,
    pub flipped_online: Vec<(String, String)>,
    /// Rows whose label changed (a devserver rename must reach
    /// the launcher without waiting for a membership or online change).
    pub updated: Vec<(String, String)>,
    /// Rows online on both sides whose proxy_origin names a DIFFERENT
    /// node: the registration moved proxies, so the managed connection
    /// pinned to the old node must be torn down and re-entered. A null on
    /// either side is an ordinary online/offline transition, not a move.
    pub moved: Vec<(String, String)>,
}

impl RosterDiff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.removed.is_empty()
            && self.flipped_online.is_empty()
            && self.updated.is_empty()
            && self.moved.is_empty()
    }
}

/// Pure roster diff: which rows appeared, disappeared, flipped their
/// online bit, changed label, or moved proxy nodes. The fresh
/// snapshot replaces the cache either way; the diff only decides whether
/// the launcher gets a push and which lifecycle actions run.
pub fn diff_rosters(old: &[RosterDevserver], new: &[RosterDevserver]) -> RosterDiff {
    let key = |r: &RosterDevserver| (r.owner.clone(), r.devserver_id.clone());
    let old_map: HashMap<_, _> = old.iter().map(|r| (key(r), r)).collect();
    let new_map: HashMap<_, _> = new.iter().map(|r| (key(r), r)).collect();
    let mut diff = RosterDiff::default();
    for (k, row) in &new_map {
        match old_map.get(k) {
            None => diff.added.push(k.clone()),
            Some(was) if was.online != row.online => diff.flipped_online.push(k.clone()),
            // Online under one exact origin, still online under another:
            // the registration moved proxy nodes. The online-flip arm above
            // already claimed every transition through offline, so both
            // rows are online here; the is_some guards keep skew (an online
            // row reporting a null origin) out of the move path.
            Some(was)
                if was.proxy_origin.is_some()
                    && row.proxy_origin.is_some()
                    && was.proxy_origin != row.proxy_origin =>
            {
                diff.moved.push(k.clone())
            }
            Some(was)
                if was.owner_user_id != row.owner_user_id
                    || was.label != row.label
                    || was.shared != row.shared =>
            {
                diff.updated.push(k.clone())
            }
            Some(_) => {}
        }
    }
    for k in old_map.keys() {
        if !new_map.contains_key(k) {
            diff.removed.push(k.clone());
        }
    }
    diff
}

/// Apply one fetch outcome to a runtime. Pure over the runtime struct so
/// the failure semantics are table-testable: upstream failures KEEP the
/// roster and count toward unreachable; only 401 cascades; success of
/// either flavor resets the failure counter.
pub fn apply_roster_fetch(rt: &mut GatewayRuntime, fetch: RosterFetch) -> FetchEffect {
    let mut effect = FetchEffect::default();
    match fetch {
        RosterFetch::Fresh {
            username,
            rows,
            etag,
        } => {
            let diff = diff_rosters(&rt.roster, &rows);
            effect.changed = !diff.is_empty() || rt.status != GatewayStatus::Connected;
            effect.diff = diff;
            rt.username = username;
            rt.roster = rows;
            rt.etag = etag;
            rt.consecutive_failures = 0;
            rt.status = GatewayStatus::Connected;
            rt.last_error = None;
        }
        RosterFetch::NotModified => {
            effect.changed = rt.status != GatewayStatus::Connected;
            rt.consecutive_failures = 0;
            rt.status = GatewayStatus::Connected;
            rt.last_error = None;
        }
        RosterFetch::Upstream(message) => {
            rt.consecutive_failures = rt.consecutive_failures.saturating_add(1);
            rt.last_error = Some(message);
            if rt.consecutive_failures >= ROSTER_UNREACHABLE_FAILURES
                && rt.status != GatewayStatus::Unreachable
            {
                rt.status = GatewayStatus::Unreachable;
                effect.changed = true;
                effect.became_unreachable = true;
            }
        }
        RosterFetch::Unauthorized => {
            effect.cascade = true;
        }
    }
    effect
}

async fn apply_roster_policy_diff(state: &Arc<AppState>, gateway_id: &str, diff: &RosterDiff) {
    for (owner, devserver_id) in &diff.removed {
        let id = synthesized_row_id(gateway_id, owner, devserver_id);
        let policy_lock = state.native_policy_lock(&id);
        let _policy_guard = policy_lock.lock().await;
        state.bump_native_policy_generation(&id);
        if let Err(e) =
            config::prune_native_trust_by_label(&state.store, gateway_id, owner, devserver_id)
        {
            tracing::warn!(gateway = %gateway_id, devserver = %id, error = %e, "pruning removed devserver native trust failed");
        }
        if let Some(teardown) = state.devserver_remove_hook.get() {
            teardown(&id);
        }
    }

    // A moved row is a node migration, not a revocation: the exact-origin
    // pin lives on the in-memory managed connection, so tearing the
    // connection down IS the pin clearing, and the persisted owner/devserver
    // trust binding stays. A previously connected row reconnects through
    // the normal connect path, whose fresh entry flow validates and pins
    // the new node origin (the roster value is never fed to validation).
    for (owner, devserver_id) in &diff.moved {
        let id = synthesized_row_id(gateway_id, owner, devserver_id);
        let policy_lock = state.native_policy_lock(&id);
        let _policy_guard = policy_lock.lock().await;
        state.bump_native_policy_generation(&id);
        let was_connected = state.devservers.is_connected(&id);
        if let Some(teardown) = state.devserver_remove_hook.get() {
            teardown(&id);
        }
        if was_connected {
            if let Some(reconnect) = state.devserver_reconnect_hook.get() {
                reconnect(&id);
            }
        }
    }

    for (owner, devserver_id) in &diff.updated {
        let Some(row) = state
            .gateway_manager
            .roster_row(gateway_id, owner, devserver_id)
        else {
            continue;
        };
        let id = synthesized_row_id(gateway_id, owner, devserver_id);
        let policy_lock = state.native_policy_lock(&id);
        let _policy_guard = policy_lock.lock().await;
        if row.shared {
            match config::native_trust(&state.store, gateway_id, row.owner_user_id, devserver_id) {
                Ok(true) => {}
                Ok(false) => {
                    state.bump_native_policy_generation(&id);
                    if let Some(teardown) = state.devserver_remove_hook.get() {
                        teardown(&id);
                    }
                }
                Err(e) => {
                    tracing::warn!(gateway = %gateway_id, devserver = %id, error = %e, "checking changed devserver native trust failed")
                }
            }
        } else if let Err(e) = config::set_native_trust(
            &state.store,
            gateway_id,
            row.owner_user_id,
            owner,
            devserver_id,
            false,
        ) {
            tracing::warn!(gateway = %gateway_id, devserver = %id, error = %e, "pruning owned devserver native trust failed");
        }
    }
}

fn roster_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(ROSTER_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("building roster http client: {e}"))
}

/// One roster round trip. Status codes are the contract: 200 parses a
/// fresh roster (`shared` derived from `owner != username`), 304 answers
/// a matching If-None-Match, 401 means the PAT is dead or under-scoped,
/// and EVERYTHING else - network, decode, 5xx - is an upstream failure
/// the caller retries without dropping state.
pub async fn fetch_roster(roster_url: &str, pat_secret: &str, etag: Option<&str>) -> RosterFetch {
    let client = match roster_client() {
        Ok(c) => c,
        Err(e) => return RosterFetch::Upstream(e),
    };
    let mut req = client.get(roster_url).bearer_auth(pat_secret);
    if let Some(etag) = etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return RosterFetch::Upstream(format!("roster request failed: {e}")),
    };
    match resp.status() {
        reqwest::StatusCode::NOT_MODIFIED => RosterFetch::NotModified,
        reqwest::StatusCode::UNAUTHORIZED => RosterFetch::Unauthorized,
        status if status.is_success() => {
            let etag = resp
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            match resp.json::<RosterResponse>().await {
                Ok(body) => {
                    let user_id = body.user_id;
                    let username = body.username;
                    let rows = body
                        .devservers
                        .into_iter()
                        .map(|r| RosterDevserver {
                            shared: r.owner_user_id != user_id,
                            owner_user_id: r.owner_user_id,
                            owner: r.owner,
                            devserver_id: r.devserver_id,
                            label: r.label,
                            online: r.online,
                            proxy_origin: r.proxy_origin,
                        })
                        .collect();
                    RosterFetch::Fresh {
                        username,
                        rows,
                        etag,
                    }
                }
                Err(e) => RosterFetch::Upstream(format!("decoding roster: {e}")),
            }
        }
        status => RosterFetch::Upstream(format!("roster returned HTTP {status}")),
    }
}

/// Emit a launcher-notice bubble. Fire-and-forget: the launcher's notice
/// store keeps what it receives; nothing is replayed to a launcher that
/// was not yet listening.
pub fn emit_notice<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: &str,
    source_type: &str,
    source_id: &str,
    source_label: &str,
    title: &str,
    message: &str,
) {
    #[derive(Serialize)]
    struct Source<'a> {
        r#type: &'a str,
        id: &'a str,
        label: &'a str,
    }
    #[derive(Serialize)]
    struct Notice<'a> {
        id: String,
        kind: &'a str,
        source: Source<'a>,
        title: &'a str,
        message: &'a str,
        at: u64,
    }
    let mut buf = [0u8; 2];
    let id = match getrandom::getrandom(&mut buf) {
        Ok(()) => format!("ntc-{:02x}{:02x}", buf[0], buf[1]),
        Err(_) => format!("ntc-{:04x}", config::now_millis() as u16),
    };
    let _ = app.emit(
        LAUNCHER_NOTICE,
        &Notice {
            id,
            kind,
            source: Source {
                r#type: source_type,
                id: source_id,
                label: source_label,
            },
            title,
            message,
            at: config::now_millis(),
        },
    );
}

/// Push the launcher a fresh devserver/gateway list (the feed re-lists
/// registries on the library change signal). The gateway flow's own copy
/// of the crate-level push helper, generic over the runtime so the whole
/// flow drives under the mock runtime in tests.
fn signal_rows_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &AppState) {
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = app.emit(crate::serve::SERVES_CHANGED, ());
}

fn gateway_row(state: &AppState, gateway_id: &str) -> Result<Gateway, String> {
    let cfg = state
        .store
        .lock()
        .unwrap()
        .get()
        .map_err(|e| e.to_string())?;
    cfg.gateways
        .iter()
        .find(|g| g.id == gateway_id)
        .cloned()
        .ok_or_else(|| format!("no gateway {gateway_id}"))
}

fn display_label(g: &Gateway) -> String {
    if !g.label.is_empty() {
        return g.label.clone();
    }
    url::Url::parse(&g.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| g.url.clone())
}

/// Persist the connect intent (`enabled`) on a gateway row. Missing rows
/// are a no-op (removed mid-flight).
fn persist_enabled(state: &AppState, gateway_id: &str, enabled: bool) {
    let mut store = state.store.lock().unwrap();
    let Ok(mut cfg) = store.get() else { return };
    let Some(g) = cfg.gateways.iter_mut().find(|g| g.id == gateway_id) else {
        return;
    };
    if g.enabled == enabled {
        return;
    }
    g.enabled = enabled;
    if let Err(e) = store.save(&cfg) {
        tracing::warn!(gateway = %gateway_id, error = %e, "persisting gateway enabled flag failed");
    }
}

/// Connect a configured gateway. `interactive` gates the browser leg:
/// a user click may open the sign-in page; the startup autoconnect must
/// never pop a browser and instead leaves the row disconnected with a
/// sign-in-required error.
pub async fn connect_gateway<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Arc<AppState>,
    gateway_id: String,
    interactive: bool,
) -> Result<(), String> {
    let gateway = gateway_row(&state, &gateway_id)?;
    let label = display_label(&gateway);

    // Coalesce: a connect already in flight (and not merely parked on the
    // browser) finishes on its own; a re-click while waiting on the
    // browser falls through to re-open the sign-in page (latest-wins).
    {
        let runtimes = state.gateway_manager.runtimes.lock().unwrap();
        if let Some(existing) = runtimes.get(&gateway_id) {
            if existing.status == GatewayStatus::Connecting && !existing.pending_signin {
                return Ok(());
            }
        }
    }
    persist_enabled(&state, &gateway_id, true);

    let discovery = match devserver::discover_gateway(&gateway.url).await {
        Ok(d) => d,
        Err(e) => {
            let msg = format!("gateway discovery failed: {e}");
            upsert_disconnected(&state, &gateway_id, &msg);
            emit_notice(
                &app,
                "error",
                "gateway",
                &gateway_id,
                &label,
                "Gateway unreachable",
                &msg,
            );
            signal_rows_changed(&app, &state);
            return Err(msg);
        }
    };
    let Some(roster_url) = discovery.roster_url.clone() else {
        let msg =
            "this gateway is too old for account connections - upgrade the gateway".to_string();
        upsert_disconnected(&state, &gateway_id, &msg);
        emit_notice(
            &app,
            "error",
            "gateway",
            &gateway_id,
            &label,
            "Gateway too old",
            &msg,
        );
        signal_rows_changed(&app, &state);
        return Err(msg);
    };

    let pat = auth::load_gateway_pat(&discovery.identity_origin)?;
    let Some(pat) = pat else {
        return signin_leg(&app, &state, &gateway_id, &label, &discovery, interactive);
    };

    upsert_connecting(&state, &gateway_id, &discovery);
    drop_runtime_if_removed(&state, &gateway_id);
    signal_rows_changed(&app, &state);

    match fetch_roster(&roster_url, &pat.secret, None).await {
        RosterFetch::Unauthorized => {
            // Dead or under-scoped PAT (a desktop.connect-era credential
            // cannot read the roster): self-heal into one re-sign-in.
            auth::clear_gateway_pat(&discovery.identity_origin)?;
            signin_leg(&app, &state, &gateway_id, &label, &discovery, interactive)
        }
        fetch => {
            let effect = {
                let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
                let rt = runtimes
                    .entry(gateway_id.clone())
                    .or_insert_with(|| new_runtime(discovery.clone()));
                apply_roster_fetch(rt, fetch)
            };
            apply_roster_policy_diff(&state, &gateway_id, &effect.diff).await;
            if effect.became_unreachable {
                notice_unreachable(&app, &state, &gateway_id, &label);
            }
            spawn_roster_poll(&app, &state, &gateway_id, roster_url);
            drop_runtime_if_removed(&state, &gateway_id);
            signal_rows_changed(&app, &state);
            Ok(())
        }
    }
}

fn new_runtime(discovery: GatewayDiscovery) -> GatewayRuntime {
    GatewayRuntime {
        discovery,
        username: String::new(),
        roster: Vec::new(),
        etag: None,
        status: GatewayStatus::Connecting,
        last_error: None,
        consecutive_failures: 0,
        pending_signin: false,
        signin_stamp: 0,
        poll_cancel: None,
    }
}

fn upsert_connecting(state: &AppState, gateway_id: &str, discovery: &GatewayDiscovery) {
    let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
    let rt = runtimes
        .entry(gateway_id.to_string())
        .or_insert_with(|| new_runtime(discovery.clone()));
    rt.discovery = discovery.clone();
    rt.status = GatewayStatus::Connecting;
    rt.pending_signin = false;
}

/// Park a runtime as disconnected with an error. A gateway that never got
/// past discovery has no runtime to park; the registry projection then
/// falls back to disconnected defaults and the caller's notice carries
/// the error.
fn upsert_disconnected(state: &AppState, gateway_id: &str, error: &str) {
    let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
    if let Some(rt) = runtimes.get_mut(gateway_id) {
        rt.status = GatewayStatus::Disconnected;
        rt.pending_signin = false;
        rt.last_error = Some(error.to_string());
    }
}

/// A cascade for a removed gateway can race a connect attempt whose
/// awaits were in flight: the cascade takes the runtime out, the connect
/// re-inserts it, and the resurrected poll would hit the removed gateway
/// with the stored PAT for the process lifetime. Called after every
/// runtime (re)insertion: drops the runtime again (poll cancelled) when
/// the config row is gone. Returns whether it dropped one.
fn drop_runtime_if_removed(state: &AppState, gateway_id: &str) -> bool {
    if gateway_row(state, gateway_id).is_ok() {
        return false;
    }
    let removed = {
        let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
        runtimes.remove(gateway_id)
    };
    if let Some(rt) = &removed {
        if let Some(cancel) = &rt.poll_cancel {
            cancel.cancel();
        }
    }
    removed.is_some()
}

/// The browser sign-in leg. Non-interactive callers (startup autoconnect)
/// never open a browser: the row parks disconnected with a
/// sign-in-required error instead.
fn signin_leg<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    label: &str,
    discovery: &GatewayDiscovery,
    interactive: bool,
) -> Result<(), String> {
    if !interactive {
        // The startup autoconnect must make the missing-PAT state VISIBLE
        // without a browser: park a runtime (creating one for a gateway
        // that has never connected) carrying the sign-in-required error,
        // and say so once.
        {
            let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
            let rt = runtimes
                .entry(gateway_id.to_string())
                .or_insert_with(|| new_runtime(discovery.clone()));
            rt.status = GatewayStatus::Disconnected;
            rt.pending_signin = false;
            rt.last_error = Some("sign-in required - click Connect".to_string());
        }
        emit_notice(
            app,
            "info",
            "gateway",
            gateway_id,
            label,
            "Sign-in required",
            "this gateway needs a browser sign-in; click Connect on the Gateways screen",
        );
        drop_runtime_if_removed(state, gateway_id);
        signal_rows_changed(app, state);
        return Ok(());
    }
    if state
        .gateway_manager
        .any_pending_signin_other_than(gateway_id)
    {
        let msg = "another gateway sign-in is waiting on the browser - finish it first".to_string();
        emit_notice(
            app,
            "info",
            "gateway",
            gateway_id,
            label,
            "Sign-in busy",
            &msg,
        );
        return Ok(());
    }
    auth::open_gateway_signin(
        app,
        &discovery.identity_origin,
        &discovery.desktop_authorize_url,
        gateway_id,
    )?;
    let stamp = config::now_millis();
    {
        let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
        let rt = runtimes
            .entry(gateway_id.to_string())
            .or_insert_with(|| new_runtime(discovery.clone()));
        rt.discovery = discovery.clone();
        rt.pending_signin = true;
        rt.signin_stamp = stamp;
        rt.status = GatewayStatus::Connecting;
    }
    drop_runtime_if_removed(state, gateway_id);
    signal_rows_changed(app, state);
    // Expire the wait like the devserver rows do: only the matching stamp
    // clears, so a re-click's fresh wait survives the stale timeout.
    let app = app.clone();
    let state = Arc::clone(state);
    let gateway_id = gateway_id.to_string();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(crate::GATEWAY_SIGNIN_TIMEOUT).await;
        let expired = {
            let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
            match runtimes.get_mut(&gateway_id) {
                Some(rt) if rt.pending_signin && rt.signin_stamp == stamp => {
                    rt.pending_signin = false;
                    rt.status = GatewayStatus::Disconnected;
                    rt.last_error = Some("sign-in was not completed in the browser".to_string());
                    true
                }
                _ => false,
            }
        };
        if expired {
            emit_notice(
                &app,
                "error",
                "gateway",
                &gateway_id,
                &label,
                "Sign-in timed out",
                "sign-in was not completed in the browser; click Connect to try again",
            );
            signal_rows_changed(&app, &state);
        }
    });
    Ok(())
}

impl GatewayManager {
    fn any_pending_signin_other_than(&self, gateway_id: &str) -> bool {
        self.runtimes
            .lock()
            .unwrap()
            .iter()
            .any(|(id, rt)| rt.pending_signin && id != gateway_id)
    }
}

/// Resume after a sign-in callback stored the PAT: the gateway must still
/// be configured (ruling: a mid-flight removal drops the sign-in with a
/// notice), then the connect re-runs PAT-backed.
pub async fn resume_gateway_signin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Arc<AppState>,
    gateway_id: String,
) {
    // Make the parked runtime resumable FIRST - pending cleared, status
    // Disconnected - so connect_gateway's coalesce guard (which lets a
    // live non-pending Connecting attempt finish on its own) cannot
    // mistake the park for an attempt in flight and dead-end the row.
    {
        let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
        if let Some(rt) = runtimes.get_mut(&gateway_id) {
            rt.pending_signin = false;
            rt.status = GatewayStatus::Disconnected;
        }
    }
    match gateway_row(&state, &gateway_id) {
        // Still configured and still wanted: the connect re-runs
        // PAT-backed.
        Ok(row) if row.enabled => {
            if let Err(e) =
                connect_gateway(app.clone(), Arc::clone(&state), gateway_id.clone(), true).await
            {
                tracing::warn!(gateway = %gateway_id, error = %e, "gateway connect after sign-in failed");
            }
        }
        // The user disconnected the row while the browser leg ran: the
        // PAT is stored for later, but the disconnect stands.
        Ok(row) => {
            emit_notice(
                &app,
                "info",
                "gateway",
                &gateway_id,
                &display_label(&row),
                "Sign-in stored",
                "the sign-in completed for a gateway that was disconnected meanwhile; click Connect to use it",
            );
            signal_rows_changed(&app, &state);
        }
        Err(_) => {
            emit_notice(
                &app,
                "info",
                "desktop",
                "desktop",
                "chan-desktop",
                "Sign-in ignored",
                "the sign-in completed for a gateway that was removed meanwhile",
            );
            let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
            runtimes.remove(&gateway_id);
        }
    }
}

/// Reset every parked gateway sign-in wait. The pending-auth slot is
/// process-global and single: once ANY callback consumes it (success,
/// failure, cancellation) or a competing sign-in replaces it, a parked
/// gateway's browser leg can never complete - its spinner and the
/// cross-gateway busy gate must not outlive the leg.
///
/// INVARIANT (correctness, not nicety): this touches gateway RUNTIME
/// ROWS only and MUST NOT clear the auth slot or drop the loopback
/// listener. `open_signin` installs the new slot and THEN calls this, so
/// an abandon that dropped the slot would nuke the just-created sign-in.
/// The slot/listener lifecycle is owned entirely by `auth`
/// (`replace_pending` drops the prior, the stamp-guarded timer drops the
/// abandoned at the slot TTL = `GATEWAY_SIGNIN_TIMEOUT`, the settle path
/// drops on completion, the open-url-failure arm drops on a failed open).
pub fn abandon_pending_signins<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
) {
    let mut cleared = false;
    {
        let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
        for rt in runtimes.values_mut() {
            if rt.pending_signin {
                rt.pending_signin = false;
                rt.status = GatewayStatus::Disconnected;
                rt.last_error = Some("sign-in was not completed".to_string());
                cleared = true;
            }
        }
    }
    if cleared {
        signal_rows_changed(app, state);
    }
}

fn spawn_roster_poll<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    roster_url: String,
) {
    let cancel = CancellationToken::new();
    let identity_origin = {
        let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
        let Some(rt) = runtimes.get_mut(gateway_id) else {
            return;
        };
        // A reconnect replaces the poll: cancel the previous loop first.
        if let Some(old) = rt.poll_cancel.replace(cancel.clone()) {
            old.cancel();
        }
        rt.discovery.identity_origin.clone()
    };
    let app = app.clone();
    let state = Arc::clone(state);
    let gateway_id = gateway_id.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(ROSTER_POLL_SECS)) => {}
            }
            // Re-read the PAT each tick: a re-sign-in mid-poll swaps the
            // credential without restarting the loop.
            let secret = match auth::load_gateway_pat(&identity_origin) {
                Ok(Some(pat)) => pat.secret,
                Ok(None) | Err(_) => {
                    // No credential: the next tick retries; a cascade (which
                    // clears the PAT) also cancels this loop.
                    continue;
                }
            };
            let etag = {
                let runtimes = state.gateway_manager.runtimes.lock().unwrap();
                match runtimes.get(&gateway_id) {
                    Some(rt) => rt.etag.clone(),
                    None => break,
                }
            };
            let fetch = fetch_roster(&roster_url, &secret, etag.as_deref()).await;
            // A disconnect+reconnect replaced this poll while the fetch
            // was in flight: the successor owns the runtime now, and the
            // map-presence check below cannot tell the two polls apart -
            // only the token can. Applying the stale fetch would clobber
            // the successor's state.
            if cancel.is_cancelled() {
                break;
            }
            let effect = {
                let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
                match runtimes.get_mut(&gateway_id) {
                    Some(rt) => apply_roster_fetch(rt, fetch),
                    None => break,
                }
            };
            apply_roster_policy_diff(&state, &gateway_id, &effect.diff).await;
            if effect.cascade {
                let label = gateway_row(&state, &gateway_id)
                    .map(|g| display_label(&g))
                    .unwrap_or_else(|_| gateway_id.clone());
                cascade_disconnect(&app, &state, &gateway_id, CascadeReason::Unauthorized).await;
                emit_notice(
                    &app,
                    "error",
                    "gateway",
                    &gateway_id,
                    &label,
                    "Gateway sign-in expired",
                    "the gateway rejected the stored sign-in; click Connect to sign in again",
                );
                break;
            }
            if effect.became_unreachable {
                let label = gateway_row(&state, &gateway_id)
                    .map(|g| display_label(&g))
                    .unwrap_or_else(|_| gateway_id.clone());
                notice_unreachable(&app, &state, &gateway_id, &label);
            }
            if effect.changed {
                signal_rows_changed(&app, &state);
            }
        }
    });
}

fn notice_unreachable<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    label: &str,
) {
    let detail = state
        .gateway_manager
        .view(gateway_id)
        .and_then(|v| v.last_error)
        .unwrap_or_default();
    emit_notice(
        app,
        "error",
        "gateway",
        gateway_id,
        label,
        "Gateway unreachable",
        &format!("the gateway has missed several roster checks; its devservers stay listed with their last-known state ({detail})"),
    );
}

/// Why a cascade runs, deciding PAT handling and the enabled flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CascadeReason {
    /// The user clicked Disconnect: persist enabled=false, keep the PAT.
    UserDisconnect,
    /// The row was removed: config row is already gone, keep the PAT
    /// (a re-add reconnects without a new sign-in).
    Removed,
    /// The roster answered 401: clear the PAT (it is dead), keep enabled
    /// (the next connect runs the sign-in leg).
    Unauthorized,
}

/// Tear down everything a gateway contributed: stop the poll, drop live
/// connections of its rostered devservers (idempotent per row), drop the
/// runtime (its synthesized rows vanish from the next list), then signal.
/// Serialized per gateway by the runtimes lock taking the runtime OUT
/// before any teardown runs; a second cascade for the same id finds no
/// runtime and no-ops.
pub async fn cascade_disconnect<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    reason: CascadeReason,
) {
    let runtime = {
        let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
        runtimes.remove(gateway_id)
    };
    let Some(runtime) = runtime else {
        // Nothing live; still honor the intent flag for a user disconnect,
        // and signal regardless - the GATEWAY row changed (removed or
        // disabled) even when no runtime existed, and the invariant
        // "signal on every gateway mutation" must not depend on the
        // caller.
        if reason == CascadeReason::UserDisconnect {
            persist_enabled(state, gateway_id, false);
        }
        signal_rows_changed(app, state);
        return;
    };
    if let Some(cancel) = &runtime.poll_cancel {
        cancel.cancel();
    }
    for row in &runtime.roster {
        let synth_id = synthesized_row_id(gateway_id, &row.owner, &row.devserver_id);
        let policy_lock = state.native_policy_lock(&synth_id);
        let _policy_guard = policy_lock.lock().await;
        state.bump_native_policy_generation(&synth_id);
        if let Some(teardown) = state.devserver_remove_hook.get() {
            teardown(&synth_id);
        }
    }
    match reason {
        CascadeReason::UserDisconnect => persist_enabled(state, gateway_id, false),
        CascadeReason::Removed => {}
        CascadeReason::Unauthorized => {
            if let Err(e) = auth::clear_gateway_pat(&runtime.discovery.identity_origin) {
                tracing::warn!(gateway = %gateway_id, error = %e, "clearing gateway PAT failed");
            }
        }
    }
    signal_rows_changed(app, state);
}

/// Startup autoconnect: every enabled gateway connects non-interactively
/// (no browser legs at login; PAT-less rows park as sign-in required).
pub fn autoconnect_enabled_gateways<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
) {
    let gateways = state
        .store
        .lock()
        .unwrap()
        .get()
        .map(|cfg| cfg.gateways)
        .unwrap_or_default();
    for g in gateways.into_iter().filter(|g| g.enabled) {
        let app = app.clone();
        let state = Arc::clone(state);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = connect_gateway(app, state, g.id.clone(), false).await {
                tracing::info!(gateway = %g.id, error = %e, "startup gateway connect failed");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_id(owner: &str) -> uuid::Uuid {
        if owner == "alice" {
            uuid::Uuid::from_u128(1)
        } else {
            uuid::Uuid::from_u128(2)
        }
    }

    fn row(owner: &str, id: &str, online: bool) -> RosterDevserver {
        RosterDevserver {
            owner_user_id: owner_id(owner),
            owner: owner.to_string(),
            devserver_id: id.to_string(),
            label: String::new(),
            online,
            shared: false,
            proxy_origin: None,
        }
    }

    /// An online row served by a node: `proxy_origin` carries the exact
    /// origin the identity side derived for that node.
    fn node_row(owner: &str, id: &str, proxy_origin: &str) -> RosterDevserver {
        RosterDevserver {
            proxy_origin: Some(proxy_origin.to_string()),
            ..row(owner, id, true)
        }
    }

    fn runtime_with(rows: Vec<RosterDevserver>) -> GatewayRuntime {
        let mut rt = new_runtime(GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "https://id.chan.app".into(),
            desktop_authorize_url: "https://id.chan.app/desktop/authorize".into(),
            desktop_entry_url: "https://id.chan.app/desktop/v1/devserver/entry".into(),
            devserver_proxy_origin: "https://x.devserver.chan.app".into(),
            devserver_proxy_host_depth: 2,
            roster_url: Some("https://id.chan.app/desktop/v1/devservers".into()),
        });
        rt.roster = rows;
        rt.status = GatewayStatus::Connected;
        rt
    }

    fn policy_state(native_trust: Vec<config::NativeDevserverTrust>) -> Arc<AppState> {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let mut cfg = config::Config::default();
        cfg.gateways.push(Gateway {
            id: "gw-feedface".into(),
            url: "https://id.example.test".into(),
            label: String::new(),
            enabled: true,
            added_at: 0,
            native_trust,
        });
        store.lock().unwrap().save(&cfg).unwrap();
        std::mem::forget(dir);
        Arc::new(AppState::with_store(store))
    }

    #[test]
    fn diff_reports_adds_removes_and_online_flips() {
        let old = vec![row("alice", "a", true), row("alice", "b", false)];
        let new = vec![row("alice", "b", true), row("bob", "c", true)];
        let diff = diff_rosters(&old, &new);
        assert_eq!(diff.added, vec![("bob".to_string(), "c".to_string())]);
        assert_eq!(diff.removed, vec![("alice".to_string(), "a".to_string())]);
        assert_eq!(
            diff.flipped_online,
            vec![("alice".to_string(), "b".to_string())]
        );
        assert!(diff_rosters(&new, &new).is_empty());
    }

    #[test]
    fn diff_reports_label_updates_and_apply_signals_them() {
        // A devserver rename must reach the launcher
        // without waiting for a membership or online change.
        let old = vec![row("alice", "a", true)];
        let mut renamed = row("alice", "a", true);
        renamed.label = "new-name".to_string();
        let diff = diff_rosters(&old, &[renamed.clone()]);
        assert_eq!(diff.updated, vec![("alice".to_string(), "a".to_string())]);
        assert!(diff.added.is_empty());
        assert!(diff.flipped_online.is_empty());
        assert!(!diff.is_empty());

        let mut rt = runtime_with(old);
        let effect = apply_roster_fetch(
            &mut rt,
            RosterFetch::Fresh {
                username: "alice".into(),
                rows: vec![renamed],
                etag: None,
            },
        );
        assert!(effect.changed, "a rename pushes to the launcher");
    }

    #[test]
    fn diff_reports_owned_to_shared_policy_flip() {
        let old = vec![row("alice", "a", true)];
        let mut shared = row("alice", "a", true);
        shared.shared = true;

        let diff = diff_rosters(&old, &[shared]);
        assert_eq!(diff.updated, vec![("alice".to_string(), "a".to_string())]);
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
        assert!(diff.flipped_online.is_empty());
    }

    #[test]
    fn diff_classifies_a_node_move_apart_from_online_flips() {
        let p1 = "https://alice--a.p1.usr.chan.app";
        let p2 = "https://alice--a.p2.usr.chan.app";
        let moved = vec![("alice".to_string(), "a".to_string())];

        // Online under one node, still online under another: a move, and
        // nothing else.
        let diff = diff_rosters(&[node_row("alice", "a", p1)], &[node_row("alice", "a", p2)]);
        assert_eq!(diff.moved, moved);
        assert!(diff.flipped_online.is_empty());
        assert!(diff.updated.is_empty());
        assert!(diff.added.is_empty() && diff.removed.is_empty());

        // Same node, still online: unchanged.
        assert!(
            diff_rosters(&[node_row("alice", "a", p1)], &[node_row("alice", "a", p1)]).is_empty()
        );

        // value -> null (offline) and null -> value (back online) are
        // ordinary transitions, never moves, even when the origin differs.
        let diff = diff_rosters(&[node_row("alice", "a", p1)], &[row("alice", "a", false)]);
        assert_eq!(diff.flipped_online, moved);
        assert!(diff.moved.is_empty());
        let diff = diff_rosters(&[row("alice", "a", false)], &[node_row("alice", "a", p2)]);
        assert_eq!(diff.flipped_online, moved);
        assert!(diff.moved.is_empty());

        // A label change on an unmoved node stays an update.
        let mut renamed = node_row("alice", "a", p1);
        renamed.label = "new-name".to_string();
        let diff = diff_rosters(&[node_row("alice", "a", p1)], &[renamed]);
        assert_eq!(diff.updated, moved);
        assert!(diff.moved.is_empty());

        // Skew (online but null origin on one side) is not a move.
        let diff = diff_rosters(&[row("alice", "a", true)], &[node_row("alice", "a", p1)]);
        assert!(diff.moved.is_empty());
        assert!(diff.is_empty(), "origin arrival alone is not actionable");
    }

    #[tokio::test]
    async fn moved_row_tears_down_drops_the_pin_and_reconnects() {
        let owner = "bob";
        let devserver_id = "d".repeat(64);
        // Shared AND trusted: a move must preserve the persisted
        // owner/devserver trust binding while the connection goes away.
        let state = policy_state(vec![config::NativeDevserverTrust {
            owner_user_id: Some(owner_id(owner)),
            owner: owner.into(),
            devserver_id: devserver_id.clone(),
        }]);
        let id = synthesized_row_id("gw-feedface", owner, &devserver_id);
        // A live managed connection pinned to the OLD node origin.
        state.devservers.set(
            id.clone(),
            devserver::DevserverConn {
                host: "bob--d.p1.usr.chan.app".into(),
                port: 443,
                token: String::new(),
                name: "old-node".into(),
                gateway: Some(Box::new(devserver::GatewayConn::new(
                    "https://id.example.test".into(),
                    "https://id.example.test/desktop/v1/devserver/entry".into(),
                    "https://bob--d.p1.usr.chan.app".into(),
                    "pat".into(),
                ))),
            },
        );
        let torn_down = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&torn_down);
        let conns = Arc::clone(&state.devservers);
        assert!(state
            .devserver_remove_hook
            .set(Arc::new(move |id| {
                seen.lock().unwrap().push(id.to_string());
                // The production hook (teardown_devserver_connection) drops
                // the conn; the stub mirrors that one effect so the test
                // observes the pin going away.
                conns.remove(id);
            }))
            .is_ok());
        let reconnected = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&reconnected);
        assert!(state
            .devserver_reconnect_hook
            .set(Arc::new(move |id| seen
                .lock()
                .unwrap()
                .push(id.to_string())))
            .is_ok());
        let diff = RosterDiff {
            moved: vec![(owner.into(), devserver_id.clone())],
            ..Default::default()
        };

        apply_roster_policy_diff(&state, "gw-feedface", &diff).await;

        assert_eq!(
            state.native_policy_generation(&id),
            1,
            "an in-flight connect of the old origin aborts"
        );
        assert!(
            !state.devservers.is_connected(&id),
            "tearing the connection down drops the old node pin"
        );
        assert_eq!(*torn_down.lock().unwrap(), vec![id.clone()]);
        assert_eq!(
            *reconnected.lock().unwrap(),
            vec![id],
            "a connected row re-enters the normal connect flow"
        );
        assert!(
            config::native_trust(&state.store, "gw-feedface", owner_id(owner), &devserver_id,)
                .unwrap(),
            "a move is not a revocation: the trust binding survives"
        );
        // The new roster origin never reached the capability mint: the
        // entry flow is the only mint path.
        assert!(!crate::runtime_capability::is_minted(
            "https://bob--d.p1.usr.chan.app"
        ));
    }

    #[tokio::test]
    async fn moved_row_without_a_connection_does_not_reconnect() {
        let owner = "bob";
        let devserver_id = "d".repeat(64);
        let state = policy_state(Vec::new());
        let reconnected = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&reconnected);
        assert!(state
            .devserver_reconnect_hook
            .set(Arc::new(move |id| seen
                .lock()
                .unwrap()
                .push(id.to_string())))
            .is_ok());
        let diff = RosterDiff {
            moved: vec![(owner.into(), devserver_id.clone())],
            ..Default::default()
        };

        apply_roster_policy_diff(&state, "gw-feedface", &diff).await;

        let id = synthesized_row_id("gw-feedface", owner, &devserver_id);
        assert_eq!(state.native_policy_generation(&id), 1);
        assert!(
            reconnected.lock().unwrap().is_empty(),
            "a row nobody connected stays disconnected; its next connect enters fresh"
        );
    }

    #[tokio::test]
    async fn removed_row_prunes_trust_bumps_policy_and_tears_down() {
        let owner = "bob";
        let devserver_id = "d".repeat(64);
        let state = policy_state(vec![config::NativeDevserverTrust {
            owner_user_id: Some(owner_id(owner)),
            owner: owner.into(),
            devserver_id: devserver_id.clone(),
        }]);
        let torn_down = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&torn_down);
        assert!(state
            .devserver_remove_hook
            .set(Arc::new(move |id| seen
                .lock()
                .unwrap()
                .push(id.to_string())))
            .is_ok());
        let diff = RosterDiff {
            removed: vec![(owner.into(), devserver_id.clone())],
            ..Default::default()
        };

        apply_roster_policy_diff(&state, "gw-feedface", &diff).await;

        let id = synthesized_row_id("gw-feedface", owner, &devserver_id);
        assert!(
            !config::native_trust(&state.store, "gw-feedface", owner_id(owner), &devserver_id,)
                .unwrap()
        );
        assert_eq!(state.native_policy_generation(&id), 1);
        assert_eq!(*torn_down.lock().unwrap(), vec![id]);
    }

    #[tokio::test]
    async fn owned_to_untrusted_shared_flip_tears_down() {
        let owner = "bob";
        let devserver_id = "d".repeat(64);
        let state = policy_state(Vec::new());
        let mut shared = row(owner, &devserver_id, true);
        shared.shared = true;
        state.gateway_manager.seed_test_runtime(
            "gw-feedface",
            GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: "https://id.example.test".into(),
                desktop_authorize_url: "https://id.example.test/desktop/authorize".into(),
                desktop_entry_url: "https://id.example.test/desktop/v1/devserver/entry".into(),
                devserver_proxy_origin: "https://devserver.example.test".into(),
                devserver_proxy_host_depth: 2,
                roster_url: Some("https://id.example.test/desktop/v1/devservers".into()),
            },
            vec![shared],
        );
        let torn_down = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&torn_down);
        assert!(state
            .devserver_remove_hook
            .set(Arc::new(move |id| seen
                .lock()
                .unwrap()
                .push(id.to_string())))
            .is_ok());
        let diff = RosterDiff {
            updated: vec![(owner.into(), devserver_id.clone())],
            ..Default::default()
        };

        apply_roster_policy_diff(&state, "gw-feedface", &diff).await;

        let id = synthesized_row_id("gw-feedface", owner, &devserver_id);
        assert_eq!(state.native_policy_generation(&id), 1);
        assert_eq!(*torn_down.lock().unwrap(), vec![id]);
    }

    #[test]
    fn upstream_failures_keep_the_roster_and_flip_unreachable_once() {
        // Ruling: a 502/network failure NEVER drops the last-known roster;
        // the gateway flips unreachable only after N consecutive misses,
        // and only once (one notice, one signal).
        let mut rt = runtime_with(vec![row("alice", "a", true)]);
        for i in 1..ROSTER_UNREACHABLE_FAILURES {
            let effect = apply_roster_fetch(&mut rt, RosterFetch::Upstream("boom".into()));
            assert_eq!(effect, FetchEffect::default(), "failure {i} is silent");
            assert_eq!(rt.status, GatewayStatus::Connected);
            assert_eq!(rt.roster.len(), 1, "roster kept on failure {i}");
        }
        let effect = apply_roster_fetch(&mut rt, RosterFetch::Upstream("boom".into()));
        assert!(effect.changed && effect.became_unreachable);
        assert_eq!(rt.status, GatewayStatus::Unreachable);
        assert_eq!(rt.roster.len(), 1, "roster kept while unreachable");
        // Further failures stay silent (already unreachable).
        let effect = apply_roster_fetch(&mut rt, RosterFetch::Upstream("boom".into()));
        assert_eq!(effect, FetchEffect::default());
    }

    #[test]
    fn success_resets_failures_and_recovers_unreachable() {
        let mut rt = runtime_with(vec![row("alice", "a", true)]);
        for _ in 0..ROSTER_UNREACHABLE_FAILURES {
            apply_roster_fetch(&mut rt, RosterFetch::Upstream("boom".into()));
        }
        assert_eq!(rt.status, GatewayStatus::Unreachable);
        let effect = apply_roster_fetch(&mut rt, RosterFetch::NotModified);
        assert!(effect.changed, "recovery signals");
        assert_eq!(rt.status, GatewayStatus::Connected);
        assert_eq!(rt.consecutive_failures, 0);
        assert_eq!(rt.last_error, None);
    }

    #[test]
    fn only_unauthorized_cascades() {
        let mut rt = runtime_with(vec![row("alice", "a", true)]);
        let effect = apply_roster_fetch(&mut rt, RosterFetch::Unauthorized);
        assert!(effect.cascade);
        assert!(!effect.changed);
        // The roster survives until the cascade takes the runtime out.
        assert_eq!(rt.roster.len(), 1);
        let effect = apply_roster_fetch(&mut rt, RosterFetch::Upstream("502".into()));
        assert!(!effect.cascade, "upstream failure never cascades");
    }

    #[test]
    fn fresh_roster_replaces_cache_and_signals_only_on_change() {
        let mut rt = runtime_with(vec![row("alice", "a", true)]);
        // Same membership + same online bits: no signal.
        let effect = apply_roster_fetch(
            &mut rt,
            RosterFetch::Fresh {
                username: "alice".into(),
                rows: vec![row("alice", "a", true)],
                etag: Some("\"e1\"".into()),
            },
        );
        assert!(!effect.changed);
        assert_eq!(rt.etag.as_deref(), Some("\"e1\""));
        // A flip signals.
        let effect = apply_roster_fetch(
            &mut rt,
            RosterFetch::Fresh {
                username: "alice".into(),
                rows: vec![row("alice", "a", false)],
                etag: None,
            },
        );
        assert!(effect.changed);
    }

    #[test]
    fn synthesized_id_shape_is_pinned() {
        assert_eq!(
            synthesized_row_id("gw-1a2b3c4d", "alice", &"d".repeat(64)),
            format!("gw:1a2b3c4d:alice:{}", "d".repeat(64))
        );
    }

    #[test]
    fn synthesized_id_round_trips_through_parse() {
        let id = synthesized_row_id("gw-1a2b3c4d", "alice", "abc123");
        assert_eq!(
            parse_synthesized_id(&id),
            Some((
                "gw-1a2b3c4d".to_string(),
                "alice".to_string(),
                "abc123".to_string()
            ))
        );
        // Plain row ids and malformed triples parse to None.
        assert_eq!(parse_synthesized_id("a-plain-uuid"), None);
        assert_eq!(parse_synthesized_id("gw:onlyhex"), None);
        assert_eq!(parse_synthesized_id("gw:hex:owner:"), None);
        assert_eq!(parse_synthesized_id("gw::owner:ds"), None);
    }

    #[test]
    #[should_panic(expected = "synthesized id segment")]
    #[cfg(debug_assertions)]
    fn synthesized_id_rejects_bad_charset() {
        let _ = synthesized_row_id("gw-1a2b3c4d", "al:ice", "abc");
    }

    async fn spawn_roster_stub(
        response: axum::response::Response<axum::body::Body>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::get;
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let app = axum::Router::new().route(
            "/desktop/v1/devservers",
            get(move |headers: axum::http::HeaderMap| {
                let parts = parts.clone();
                let bytes = bytes.clone();
                async move {
                    // Echo 304 when the conditional matches the stub ETag.
                    if let (Some(inm), Some(etag)) = (
                        headers.get(axum::http::header::IF_NONE_MATCH),
                        parts.headers.get(axum::http::header::ETAG),
                    ) {
                        if inm == etag {
                            return axum::http::Response::builder()
                                .status(304)
                                .body(axum::body::Body::empty())
                                .unwrap();
                        }
                    }
                    let mut resp = axum::http::Response::builder().status(parts.status);
                    for (k, v) in parts.headers.iter() {
                        resp = resp.header(k, v);
                    }
                    resp.body(axum::body::Body::from(bytes)).unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}/desktop/v1/devservers"), handle)
    }

    fn resp(status: u16, etag: Option<&str>, body: &str) -> axum::response::Response {
        let mut b = axum::http::Response::builder().status(status);
        if let Some(etag) = etag {
            b = b.header(axum::http::header::ETAG, etag);
        }
        b.body(axum::body::Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn fetch_parses_a_fresh_roster_and_derives_shared() {
        let body = r#"{"user_id":"11111111-1111-1111-1111-111111111111","username":"alice","devservers":[
            {"owner_user_id":"11111111-1111-1111-1111-111111111111","owner":"alice","devserver_id":"a1","label":"laptop","online":true,"proxy_origin":"https://alice--a1.p1.usr.chan.app"},
            {"owner_user_id":"22222222-2222-2222-2222-222222222222","owner":"bob","devserver_id":"b1","label":"","online":false,"proxy_origin":null}]}"#;
        let (url, server) = spawn_roster_stub(resp(200, Some("\"e1\""), body)).await;
        match fetch_roster(&url, "pat-secret", None).await {
            RosterFetch::Fresh {
                username,
                rows,
                etag,
            } => {
                assert_eq!(username, "alice");
                assert_eq!(etag.as_deref(), Some("\"e1\""));
                assert_eq!(rows.len(), 2);
                assert!(!rows[0].shared, "own row");
                assert!(rows[1].shared, "foreign owner derives shared");
                assert_eq!(
                    rows[0].proxy_origin.as_deref(),
                    Some("https://alice--a1.p1.usr.chan.app"),
                    "the online row carries its node origin"
                );
                assert_eq!(rows[1].proxy_origin, None, "the offline row is null");
            }
            other => panic!("expected Fresh, got {other:?}"),
        }
        server.abort();
    }

    /// The roster field is data, not authority: parsing a row's
    /// proxy_origin never mints a Tauri grant. Only the entry flow's
    /// validated response reaches `mint_exact_origin_grant`.
    #[tokio::test]
    async fn roster_parsing_mints_no_origin_authority() {
        const ROSTER_ORIGIN: &str = "https://carol--c9.p9.usr.chan.app";
        let body = r#"{"user_id":"33333333-3333-3333-3333-333333333333","username":"carol","devservers":[
            {"owner_user_id":"33333333-3333-3333-3333-333333333333","owner":"carol","devserver_id":"c9","label":"","online":true,"proxy_origin":"https://carol--c9.p9.usr.chan.app"}]}"#;
        let (url, server) = spawn_roster_stub(resp(200, None, body)).await;
        match fetch_roster(&url, "s", None).await {
            RosterFetch::Fresh { rows, .. } => {
                assert_eq!(rows[0].proxy_origin.as_deref(), Some(ROSTER_ORIGIN));
            }
            other => panic!("expected Fresh, got {other:?}"),
        }
        server.abort();
        assert!(!crate::runtime_capability::is_minted(ROSTER_ORIGIN));
    }

    #[tokio::test]
    async fn fetch_maps_304_401_and_502_to_their_outcomes() {
        let body = r#"{"user_id":"11111111-1111-1111-1111-111111111111","username":"alice","devservers":[]}"#;
        let (url, server) = spawn_roster_stub(resp(200, Some("\"e2\""), body)).await;
        assert!(matches!(
            fetch_roster(&url, "s", Some("\"e2\"")).await,
            RosterFetch::NotModified
        ));
        server.abort();

        let (url, server) = spawn_roster_stub(resp(401, None, r#"{"error":"unauthorized"}"#)).await;
        assert!(matches!(
            fetch_roster(&url, "s", None).await,
            RosterFetch::Unauthorized
        ));
        server.abort();

        // The roster's pinned 502 body: an upstream failure, never a
        // cascade, never a roster drop.
        let (url, server) =
            spawn_roster_stub(resp(502, None, r#"{"error":"upstream error"}"#)).await;
        match fetch_roster(&url, "s", None).await {
            RosterFetch::Upstream(msg) => assert!(msg.contains("502"), "{msg}"),
            other => panic!("expected Upstream, got {other:?}"),
        }
        server.abort();
    }

    /// A gateway in one stub: discovery (loopback http, roster_url
    /// advertised, proxy origin inside the static grant scope so the
    /// capability mint no-ops under the mock runtime) plus a one-row
    /// roster.
    async fn spawn_gateway_stub() -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let disc_origin = origin.clone();
        let app = axum::Router::new()
            .route(
                "/.well-known/chan-gateway",
                get(move || {
                    let o = disc_origin.clone();
                    async move {
                        axum::Json(serde_json::json!({
                            "kind": "chan-gateway",
                            "api_version": 1,
                            "identity_origin": o,
                            "desktop_authorize_url": format!("{o}/desktop/authorize"),
                            "desktop_entry_url": format!("{o}/desktop/v1/devserver/entry"),
                            "devserver_proxy_origin": "https://devserver.chan.app",
                            "devserver_proxy_host_depth": 2,
                            "roster_url": format!("{o}/desktop/v1/devservers"),
                        }))
                    }
                }),
            )
            .route(
                "/desktop/v1/devservers",
                get(|| async {
                    axum::Json(serde_json::json!({
                        "user_id": "11111111-1111-1111-1111-111111111111",
                        "username": "alice",
                        "devservers": [{
                            "owner_user_id": "11111111-1111-1111-1111-111111111111",
                            "owner": "alice",
                            "devserver_id": "a1",
                            "label": "laptop",
                            "online": true,
                            "proxy_origin": "https://alice--a1.p1.devserver.chan.app"
                        }]
                    }))
                }),
            );
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (origin, handle)
    }

    /// The blocker regression: park -> callback -> roster fetched -> poll
    /// running. The resume must make the parked runtime resumable before
    /// re-entering connect_gateway, or the coalesce guard reads the park
    /// as an attempt in flight and the gateway sticks Connecting forever.
    #[tokio::test]
    async fn resume_after_signin_fetches_roster_and_starts_poll() {
        let (origin, server) = spawn_gateway_stub().await;
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        {
            let mut cfg = config::Config::default();
            cfg.gateways.push(Gateway {
                id: "gw-feedface".to_string(),
                url: origin.clone(),
                label: String::new(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
            });
            store.lock().unwrap().save(&cfg).unwrap();
        }
        let state = Arc::new(crate::AppState::with_store(store));
        let app = tauri::test::mock_app();

        // Park the runtime exactly the way the sign-in leg leaves it.
        {
            let mut rt = new_runtime(GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: origin.clone(),
                desktop_authorize_url: format!("{origin}/desktop/authorize"),
                desktop_entry_url: format!("{origin}/desktop/v1/devserver/entry"),
                devserver_proxy_origin: "https://devserver.chan.app".into(),
                devserver_proxy_host_depth: 2,
                roster_url: Some(format!("{origin}/desktop/v1/devservers")),
            });
            rt.pending_signin = true;
            rt.signin_stamp = 42;
            let mut runtimes = state.gateway_manager.runtimes.lock().unwrap();
            runtimes.insert("gw-feedface".to_string(), rt);
        }
        // The callback stored the account PAT before the resume runs.
        crate::auth::test_gateway_pats().lock().unwrap().insert(
            origin.clone(),
            crate::auth::StoredPat {
                id: "pat-1".into(),
                secret: "s3cret".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        );

        resume_gateway_signin(
            app.handle().clone(),
            Arc::clone(&state),
            "gw-feedface".to_string(),
        )
        .await;

        let view = state
            .gateway_manager
            .view("gw-feedface")
            .expect("runtime lives");
        assert!(!view.pending_signin, "the park is cleared");
        assert_eq!(
            view.status,
            GatewayStatus::Connected,
            "the roster fetch ran (last_error: {:?})",
            view.last_error
        );
        assert_eq!(view.devserver_count, 1, "the stub roster row arrived");
        assert!(
            state.gateway_manager.runtimes.lock().unwrap()["gw-feedface"]
                .poll_cancel
                .is_some(),
            "the roster poll is running"
        );
        server.abort();
    }
}
