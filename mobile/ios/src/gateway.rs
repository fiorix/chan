//! Managed per-gateway account connections for the mobile leg.
//!
//! A configured [`Gateway`] is connected at the ACCOUNT level: the app
//! discovers the gateway once, signs in once per gateway account
//! (`mobile.account` scope, PAT in the OS keyring), and polls the
//! gateway's `/mobile/v1/devservers` roster; the rostered devservers
//! surface as synthesized rows in the launcher list and vanish when the
//! gateway disconnects. This module owns that lifecycle: the runtime map
//! behind [`GatewayManager`], the connect flow, the roster poll, and the
//! cascade teardown.
//!
//! Failure semantics are load-bearing and test-pinned: an upstream
//! failure (network, 5xx; the roster's own 502 body is
//! `{"error":"upstream error"}`) KEEPS the last-known roster and
//! retries, flipping the gateway to `unreachable` only after
//! [`ROSTER_UNREACHABLE_FAILURES`] consecutive misses, a PAT the
//! keychain fails to load counting as one; ONLY a 401, or a connected
//! gateway whose stored PAT is gone, runs the disconnect cascade and
//! clears the stored PAT. A degraded all-offline roster is never
//! synthesized; dropping rows on a flaky upstream would close every
//! gateway window.
//!
//! Connect owns an identity before discovery starts. Discovery and the
//! first roster request coalesce repeated Connects; a browser wait
//! permits a new attempt, cancelling its predecessor. Results publish
//! only while their attempt is current. A disconnect invalidates it
//! and persists disabled intent together; timeout keeps enabled intent
//! for a later retry.
//!
//! Lock order is config store, then gateway state. The pending-auth
//! slot is never held with either. Credential operations take the
//! attempt's credential lock before gateway state, releasing state
//! before keyring calls; cancellation waits for an operation already
//! begun before returning. A connect's first roster policy work
//! finishes before cascade teardown, and a successor waits for that
//! teardown before discovering again.
//!
//! Browser sign-in is single-flight across gateways. The auth module
//! owns the pending slot and callback settlement, both tied to the
//! connect's attempt. A stale callback changes no row. The credential
//! commit ends all kept or none kept: a cancel before it stores
//! nothing, and one that lands during it lets it finish and then
//! undoes it, putting back what it replaced, unless a replacing
//! connect waits to use the credentials, which keeps them and
//! announces them. A cancellation returns only once every commit it
//! supersedes has ended. A token the sign-in does not keep is revoked
//! at the gateway.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use chan_server::GatewayStatus;

use crate::config::{self, Gateway};
use crate::devserver::{self, GatewayDiscovery, GatewayDiscoveryError};
use crate::{auth, AppState};

/// How long a browser sign-in may wait before its row times out. The
/// auth slot shares this budget, so the slot never dies while the row
/// still shows Connecting.
pub(crate) const GATEWAY_SIGNIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

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
    /// 401, or no stored PAT for a polled gateway: the credential is dead,
    /// under-scoped or gone. The ONLY outcome that cascades.
    Unauthorized,
    /// Everything else (network, decode, 5xx incl. the roster's 502
    /// upstream-error body, a keychain that cannot load the PAT): keep the
    /// last-known roster and retry.
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
    poll_cancel: Option<CancellationToken>,
    /// Consecutive poll rounds whose PAT load failed, so the poll warns once
    /// per streak and says how long it was when the load answers again.
    pat_load_failures: u32,
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
    state: Mutex<GatewayState>,
    #[cfg(test)]
    after_cancel_intent: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    before_discovery: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[derive(Default)]
struct GatewayState {
    runtimes: HashMap<String, GatewayRuntime>,
    /// A discovery failure precedes the runtime's validated discovery.
    discovery_errors: HashMap<String, String>,
    attempts: HashMap<String, Arc<GatewayAttempt>>,
    teardowns: HashMap<String, Arc<CancellationToken>>,
    /// Roster polling is background-paused on mobile: ticks skip their fetch
    /// while set, and the foreground transition resyncs immediately. Never
    /// set on desktop, where the flag reads false always.
    suspended: bool,
}

#[derive(Default)]
pub(super) struct GatewayAttempt {
    cancel: CancellationToken,
    credentials: Mutex<CredentialCommit>,
    policy: tokio::sync::Mutex<()>,
    /// The connect that replaced this attempt during its browser wait, set
    /// before this attempt is cancelled. It waits for this attempt's
    /// credential commit and then uses what it kept. The link is strong, so
    /// every attempt in a chain lives while an older one can still commit.
    successor: std::sync::OnceLock<Arc<GatewayAttempt>>,
    /// The attempt this one replaced, the other half of `successor`. Weak:
    /// an attempt that is gone has no commit left to wait for.
    predecessor: std::sync::OnceLock<std::sync::Weak<GatewayAttempt>>,
    /// The browser's callback reached this attempt, so the browser wait is
    /// over and its expiry no longer applies.
    callback_accepted: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(super) signin_hooks: auth::SigninTestHooks,
}

/// What a sign-in's credential commit writes, as one unit the commit can
/// take back whole.
pub(super) trait CredentialWrites {
    /// Write everything or nothing: an error leaves no write of this call
    /// behind, what it replaced put back.
    fn write(&mut self) -> Result<(), String>;
    /// Put back what a successful [`Self::write`] replaced, as far as no
    /// later write has replaced it again.
    fn undo(&mut self);
    /// Whether what the writes were for is gone by the time they end (the
    /// gateway's row removed), which undoes them as a withdrawal does.
    fn abandoned(&self) -> bool;
    /// Cleanup that may run only once the writes are irrevocably kept.
    fn kept(&mut self) {}
}

#[derive(Default, PartialEq, Eq)]
enum CredentialCommit {
    #[default]
    Open,
    Cancelled,
}

impl GatewayAttempt {
    pub(super) fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub(super) async fn wait<T>(&self, step: impl std::future::Future<Output = T>) -> Option<T> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => None,
            result = step => Some(result),
        }
    }

    /// Run a sign-in's credential writes under this attempt's credential
    /// lock. The commit ends all kept (`Ok(true)`) or none kept: `Ok(false)`
    /// when cancelled, `Err` when a write failed, which `writes` takes back
    /// itself. A cancel before the writes start refuses them. One that lands
    /// while they run lets them finish, since a write abandoned midway could
    /// leave an enrolled row without its token, and then undoes them before
    /// the lock is released. Every cancellation waits for this lock in
    /// [`Self::finish_cancellation`], through the attempts the cancelled one
    /// replaced, so it returns only once nothing of the commit is left. The
    /// writes are kept while a connect that replaced this attempt is still
    /// live, and undone when the row they were for is gone.
    pub(super) fn commit_credentials(
        &self,
        writes: &mut impl CredentialWrites,
    ) -> Result<bool, String> {
        let mut commit = self.credentials.lock().unwrap();
        if *commit == CredentialCommit::Cancelled || self.cancel.is_cancelled() {
            *commit = CredentialCommit::Cancelled;
            return Ok(false);
        }
        writes.write()?;
        if self.withdrawn() || writes.abandoned() {
            writes.undo();
            *commit = CredentialCommit::Cancelled;
            return Ok(false);
        }
        writes.kept();
        Ok(true)
    }

    /// Whether nothing wants this attempt's credentials any more: it was
    /// cancelled, and so was every connect that replaced it in turn. A
    /// Disconnect, a removal's cascade, a 401 cascade or a browser wait that
    /// expired before its callback withdraws an attempt; a replacing connect
    /// does not, until it is withdrawn itself.
    fn withdrawn(&self) -> bool {
        let mut attempt = self;
        loop {
            if !attempt.cancel.is_cancelled() {
                return false;
            }
            match attempt.successor.get() {
                Some(next) => attempt = &**next,
                None => return true,
            }
        }
    }

    /// Close this attempt's credential commit once any commit it runs has
    /// ended, then each attempt it replaced in turn, newest first. A
    /// cancellation that waits here never returns while a commit it
    /// supersedes is still writing or undoing, and none of those attempts
    /// can start one after it.
    async fn finish_cancellation(self: &Arc<Self>) {
        let attempt = Arc::clone(self);
        let _ = tokio::task::spawn_blocking(move || {
            let mut next = Some(attempt);
            while let Some(attempt) = next {
                *attempt.credentials.lock().unwrap() = CredentialCommit::Cancelled;
                next = attempt.predecessor.get().and_then(std::sync::Weak::upgrade);
            }
        })
        .await;
    }

    /// Record that the browser's callback reached this attempt.
    pub(super) fn accept_callback(&self) {
        self.callback_accepted
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn callback_was_accepted(&self) -> bool {
        self.callback_accepted
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl GatewayState {
    fn owns(&self, gateway_id: &str, attempt: &Arc<GatewayAttempt>) -> bool {
        self.attempts
            .get(gateway_id)
            .is_some_and(|current| Arc::ptr_eq(current, attempt))
    }
}

impl GatewayManager {
    /// The volatile GatewayEntry fields for `gateway_id`, including a
    /// discovery failure before a runtime exists.
    pub fn view(&self, gateway_id: &str) -> Option<GatewayRuntimeView> {
        let gateway_state = self.state.lock().unwrap();
        let runtimes = &gateway_state.runtimes;
        if gateway_state.attempts.contains_key(gateway_id)
            && runtimes
                .get(gateway_id)
                .is_none_or(|rt| rt.status == GatewayStatus::Disconnected)
        {
            return Some(GatewayRuntimeView {
                status: GatewayStatus::Connecting,
                ..Default::default()
            });
        }
        runtimes
            .get(gateway_id)
            .map(|rt| GatewayRuntimeView {
                status: rt.status,
                pending_signin: rt.pending_signin,
                devserver_count: rt.roster.len(),
                last_error: rt.last_error.clone(),
            })
            .or_else(|| {
                gateway_state
                    .discovery_errors
                    .get(gateway_id)
                    .map(|error| GatewayRuntimeView {
                        status: GatewayStatus::Disconnected,
                        last_error: Some(error.clone()),
                        ..Default::default()
                    })
            })
    }

    /// A saved file change supersedes a discovery failure tied to the old file.
    pub(crate) fn clear_discovery_error(&self, gateway_id: &str) {
        self.state
            .lock()
            .unwrap()
            .discovery_errors
            .remove(gateway_id);
    }

    /// The roster snapshot of a connected gateway (synthesized-row
    /// sources). Empty when the gateway has no runtime.
    pub fn roster(&self, gateway_id: &str) -> Vec<RosterDevserver> {
        self.state
            .lock()
            .unwrap()
            .runtimes
            .get(gateway_id)
            .map(|rt| rt.roster.clone())
            .unwrap_or_default()
    }

    /// The validated discovery of a gateway with a live runtime, for the
    /// rostered-devserver connect path. `None` when the gateway is not
    /// connected.
    pub fn discovery(&self, gateway_id: &str) -> Option<GatewayDiscovery> {
        self.state
            .lock()
            .unwrap()
            .runtimes
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
        self.state
            .lock()
            .unwrap()
            .runtimes
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
        self.state
            .lock()
            .unwrap()
            .runtimes
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
/// roster and count toward unreachable; only `Unauthorized` cascades;
/// success of either flavor resets the failure counter.
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

async fn await_devserver_teardown(state: &AppState, id: &str) {
    let Some(teardown) = state.devserver_remove_hook.get() else {
        return;
    };
    if let Err(error) = teardown(id).await {
        tracing::warn!(devserver = %id, %error, "awaiting devserver teardown failed");
    }
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
        await_devserver_teardown(state, &id).await;
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
        await_devserver_teardown(state, &id).await;
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
                    await_devserver_teardown(state, &id).await;
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
    crate::devserver::tls_client_builder()
        .and_then(|builder| {
            builder
                .timeout(Duration::from_secs(ROSTER_HTTP_TIMEOUT_SECS))
                .build()
                .map_err(|e| e.to_string())
        })
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
        Err(e) => {
            return RosterFetch::Upstream(format!(
                "roster request failed: {}",
                crate::native_transfer::reason_without_url(e)
            ))
        }
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

/// Change intent while the caller holds the store and gateway state together.
fn persist_enabled(store: &mut config::ConfigStore, gateway_id: &str, enabled: bool) {
    let Ok(mut cfg) = store.get() else { return };
    let Some(g) = cfg.gateways.iter_mut().find(|g| g.id == gateway_id) else {
        return;
    };
    if g.enabled != enabled {
        g.enabled = enabled;
        if let Err(e) = store.save(&cfg) {
            tracing::warn!(gateway = %gateway_id, error = %e, "persisting gateway enabled flag failed");
        }
    }
}

struct StartedConnect {
    attempt: Arc<GatewayAttempt>,
    teardown: Option<Arc<CancellationToken>>,
    replaced: Option<Arc<GatewayAttempt>>,
}

fn begin_connect(state: &AppState, gateway_id: &str) -> Result<Option<StartedConnect>, String> {
    let mut store = state.store.lock().unwrap();
    if !store
        .get()
        .map_err(|e| e.to_string())?
        .gateways
        .iter()
        .any(|g| g.id == gateway_id)
    {
        return Err(format!("no gateway {gateway_id}"));
    }
    let mut live = state.gateway_manager.state.lock().unwrap();
    let pending = live
        .runtimes
        .get(gateway_id)
        .is_some_and(|rt| rt.pending_signin);
    if live.attempts.contains_key(gateway_id) && !pending {
        return Ok(None);
    }
    persist_enabled(&mut store, gateway_id, true);
    let attempt = Arc::new(GatewayAttempt::default());
    live.discovery_errors.remove(gateway_id);
    let replaced = live
        .attempts
        .insert(gateway_id.into(), Arc::clone(&attempt));
    if let Some(old) = &replaced {
        // Linked before the cancel, so a commit the cancel lands in sees a
        // successor that wants its credentials, and a cancellation of the
        // successor waits for that commit.
        let _ = old.successor.set(Arc::clone(&attempt));
        let _ = attempt.predecessor.set(Arc::downgrade(old));
        old.cancel.cancel();
        if let Some(rt) = live.runtimes.get_mut(gateway_id) {
            rt.pending_signin = false;
        }
    }
    let teardown = live.teardowns.get(gateway_id).cloned();
    drop(live);
    drop(store);
    if let Some(old) = &replaced {
        auth::clear_gateway_signin(gateway_id, old);
    }
    Ok(Some(StartedConnect {
        attempt,
        teardown,
        replaced,
    }))
}

/// Connect a configured gateway. Non-interactive startup never opens a browser.
pub async fn connect_gateway<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Arc<AppState>,
    gateway_id: String,
    interactive: bool,
) -> Result<(), String> {
    let Some(started) = begin_connect(&state, &gateway_id)? else {
        return Ok(());
    };
    let StartedConnect {
        attempt,
        teardown,
        replaced,
    } = started;
    signal_rows_changed(&app, &state);
    if let Some(replaced) = replaced {
        if attempt.wait(replaced.finish_cancellation()).await.is_none() {
            return Ok(());
        }
    }
    if let Some(teardown) = teardown {
        if attempt.wait(teardown.cancelled()).await.is_none() {
            return Ok(());
        }
    }
    // Read the row again: a predecessor's commit this connect waited for may
    // have enrolled the key, which the enrollment check below must see. A
    // row removed meanwhile is settled by the removal's own cascade.
    let Ok(gateway) = gateway_row(&state, &gateway_id) else {
        return Ok(());
    };
    #[cfg(test)]
    if let Some(before_discovery) = state
        .gateway_manager
        .before_discovery
        .lock()
        .unwrap()
        .take()
    {
        before_discovery();
    }
    let label = display_label(&gateway);
    let Some(discovered) = attempt
        .wait(devserver::discover_gateway(&gateway.url))
        .await
    else {
        return Ok(());
    };
    let Some(discovery) =
        publish_discovery(&app, &state, &gateway_id, &label, &attempt, discovered)?
    else {
        return Ok(());
    };
    // A keyring read can block. Its result remains owned by this attempt even
    // when cancellation stops waiting for the blocking task.
    let origin = discovery.identity_origin.clone();
    let Some(loaded) = attempt
        .wait(async move {
            tokio::task::spawn_blocking(move || auth::load_gateway_pat(&origin))
                .await
                .unwrap_or_else(|error| Err(format!("loading gateway credentials: {error}")))
        })
        .await
    else {
        return Ok(());
    };
    let Some(pat) = publish_pat_load(
        &app,
        &state,
        &gateway_id,
        &label,
        &attempt,
        &discovery,
        loaded,
    )?
    else {
        return Ok(());
    };
    let pat = match pat {
        Some(pat) => pat,
        stored => {
            let _ = &stored;
            return signin_leg(
                &app,
                &state,
                &gateway_id,
                &label,
                &discovery,
                &attempt,
                interactive,
            );
        }
    };
    connect_with_pat(
        &app,
        &state,
        &gateway_id,
        &attempt,
        &discovery,
        pat,
        interactive,
    )
    .await
}

async fn connect_with_pat<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    discovery: &GatewayDiscovery,
    pat: auth::StoredPat,
    interactive: bool,
) -> Result<(), String> {
    if !publish_connecting(state, gateway_id, attempt, discovery) {
        return Ok(());
    }
    signal_rows_changed(app, state);
    let Some(fetch) = attempt
        .wait(fetch_roster(
            &discovery.mobile_roster_url,
            &pat.secret,
            None,
        ))
        .await
    else {
        return Ok(());
    };
    finish_first_fetch(
        app,
        state,
        gateway_id,
        attempt,
        discovery,
        fetch,
        interactive,
    )
    .await
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
        poll_cancel: None,
        pat_load_failures: 0,
    }
}

fn publish_discovery<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    gateway_id: &str,
    label: &str,
    attempt: &Arc<GatewayAttempt>,
    result: Result<GatewayDiscovery, GatewayDiscoveryError>,
) -> Result<Option<GatewayDiscovery>, String> {
    // Registry writes and disconnect take these locks in the same order.
    // Keep both through persistence and adoption so a stale result cannot
    // replace a successor's tunnels or revive a disconnected row.
    let store = state.store.lock().unwrap();
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return Ok(None);
    }
    let (title, msg) = match result {
        Ok(discovery) => {
            return Ok(Some(discovery));
        }
        Err(error) => {
            let text = error.to_string();
            let title = if text.contains("does not support mobile sign-in") {
                "Gateway unsupported"
            } else {
                "Gateway unreachable"
            };
            (title, format!("gateway discovery failed: {text}"))
        }
    };
    live.attempts.remove(gateway_id);
    if let Some(rt) = live.runtimes.get_mut(gateway_id) {
        rt.status = GatewayStatus::Disconnected;
        rt.pending_signin = false;
        rt.last_error = Some(msg.clone());
    } else {
        live.discovery_errors.insert(gateway_id.into(), msg.clone());
    }
    drop(live);
    drop(store);
    emit_notice(app, "error", "gateway", gateway_id, label, title, &msg);
    signal_rows_changed(app, state);
    Err(msg)
}

fn publish_pat_load<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    gateway_id: &str,
    label: &str,
    attempt: &Arc<GatewayAttempt>,
    discovery: &GatewayDiscovery,
    loaded: Result<Option<auth::StoredPat>, String>,
) -> Result<Option<Option<auth::StoredPat>>, String> {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return Ok(None);
    }
    match loaded {
        Ok(pat) => Ok(Some(pat)),
        Err(error) => {
            live.attempts.remove(gateway_id);
            let rt = live
                .runtimes
                .entry(gateway_id.into())
                .or_insert_with(|| new_runtime(discovery.clone()));
            if rt.status != GatewayStatus::Connected && !rt.pending_signin {
                rt.status = GatewayStatus::Disconnected;
                rt.last_error = Some(error.clone());
            }
            drop(live);
            emit_notice(
                app,
                "error",
                "gateway",
                gateway_id,
                label,
                "Gateway credentials unavailable",
                &error,
            );
            signal_rows_changed(app, state);
            Err(error)
        }
    }
}

fn publish_connecting(
    state: &AppState,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    discovery: &GatewayDiscovery,
) -> bool {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return false;
    }
    let rt = live
        .runtimes
        .entry(gateway_id.into())
        .or_insert_with(|| new_runtime(discovery.clone()));
    rt.discovery = discovery.clone();
    rt.status = GatewayStatus::Connecting;
    rt.pending_signin = false;
    true
}

fn park_failed_connect<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    error: &str,
) -> bool {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return false;
    }
    live.attempts.remove(gateway_id);
    let changed = match live.runtimes.get_mut(gateway_id) {
        Some(rt) if rt.status == GatewayStatus::Connecting && !rt.pending_signin => {
            rt.status = GatewayStatus::Disconnected;
            rt.last_error = Some(error.into());
            true
        }
        Some(rt) if rt.status == GatewayStatus::Disconnected => {
            rt.last_error = Some(error.into());
            true
        }
        None => true,
        _ => false,
    };
    drop(live);
    if changed {
        signal_rows_changed(app, state);
    }
    true
}

async fn finish_first_fetch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    discovery: &GatewayDiscovery,
    fetch: RosterFetch,
    interactive: bool,
) -> Result<(), String> {
    let _policy = attempt.policy.lock().await;
    let label = gateway_row(state, gateway_id)
        .map(|g| display_label(&g))
        .unwrap_or_else(|_| gateway_id.into());
    if matches!(fetch, RosterFetch::Unauthorized) {
        // Serialize a clear already begun with cancellation, without holding
        // gateway state across a keyring call.
        let cleared = {
            let _credentials = attempt.credentials.lock().unwrap();
            if !state
                .gateway_manager
                .state
                .lock()
                .unwrap()
                .owns(gateway_id, attempt)
            {
                return Ok(());
            }
            auth::clear_gateway_pat(&discovery.identity_origin)
        };
        if let Err(error) = cleared {
            if park_failed_connect(app, state, gateway_id, attempt, &error) {
                return Err(error);
            }
            return Ok(());
        }
        return signin_leg(
            app,
            state,
            gateway_id,
            &label,
            discovery,
            attempt,
            interactive,
        );
    }
    let effect = {
        let mut live = state.gateway_manager.state.lock().unwrap();
        if !live.owns(gateway_id, attempt) {
            return Ok(());
        }
        let rt = live
            .runtimes
            .entry(gateway_id.into())
            .or_insert_with(|| new_runtime(discovery.clone()));
        apply_roster_fetch(rt, fetch)
    };
    apply_roster_policy_diff(state, gateway_id, &effect.diff).await;
    // Cascade waits for this policy section before its teardown, and a new
    // Connect waits for that teardown before it can publish a successor.
    if !spawn_roster_poll(
        app,
        state,
        gateway_id,
        attempt,
        discovery.mobile_roster_url.clone(),
    ) {
        return Ok(());
    }
    if effect.became_unreachable {
        notice_unreachable(app, state, gateway_id, &label);
    }
    signal_rows_changed(app, state);
    Ok(())
}

/// The browser leg keeps its attempt while parked. Auth owns the slot itself.
/// Why a start-up connect that needs the browser stops: the row's
/// `last_error` and the notice that says so.
struct SigninPark {
    error: &'static str,
    title: &'static str,
    message: &'static str,
}

/// Park a connect that needs the browser where none may open: the row is
/// disconnected with `park.error` until a Connect click signs in.
fn park_for_signin<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    label: &str,
    discovery: &GatewayDiscovery,
    attempt: &Arc<GatewayAttempt>,
    park: SigninPark,
) -> Result<(), String> {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return Ok(());
    }
    live.attempts.remove(gateway_id);
    let rt = live
        .runtimes
        .entry(gateway_id.into())
        .or_insert_with(|| new_runtime(discovery.clone()));
    rt.status = GatewayStatus::Disconnected;
    rt.pending_signin = false;
    rt.last_error = Some(park.error.into());
    drop(live);
    emit_notice(
        app,
        "info",
        "gateway",
        gateway_id,
        label,
        park.title,
        park.message,
    );
    signal_rows_changed(app, state);
    Ok(())
}

fn signin_leg<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    label: &str,
    discovery: &GatewayDiscovery,
    attempt: &Arc<GatewayAttempt>,
    interactive: bool,
) -> Result<(), String> {
    if !state
        .gateway_manager
        .state
        .lock()
        .unwrap()
        .owns(gateway_id, attempt)
    {
        return Ok(());
    }
    if !interactive {
        return park_for_signin(
            app,
            state,
            gateway_id,
            label,
            discovery,
            attempt,
            SigninPark {
                error: "sign-in required - click Connect",
                title: "Sign-in required",
                message:
                    "this gateway needs a browser sign-in; click Connect on the Gateways screen",
            },
        );
    }
    if state
        .gateway_manager
        .any_pending_signin_other_than(gateway_id)
    {
        let msg = "another gateway sign-in is waiting on the browser - finish it first";
        if park_failed_connect(app, state, gateway_id, attempt, msg) {
            emit_notice(
                app,
                "info",
                "gateway",
                gateway_id,
                label,
                "Sign-in busy",
                msg,
            );
        }
        return Ok(());
    }
    if let Err(error) = auth::open_gateway_signin(app, state, discovery, gateway_id, attempt) {
        if park_failed_connect(app, state, gateway_id, attempt, &error) {
            return Err(error);
        }
        return Ok(());
    }
    let app = app.clone();
    let state = Arc::clone(state);
    let attempt = Arc::clone(attempt);
    let gateway_id = gateway_id.to_string();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            biased;
            _ = attempt.cancel.cancelled() => return,
            _ = tokio::time::sleep(GATEWAY_SIGNIN_TIMEOUT) => {}
        }
        expire_signin(&app, &state, &gateway_id, &label, &attempt);
    });
    Ok(())
}

pub(super) fn publish_pending_signin<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    discovery: &GatewayDiscovery,
) -> bool {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return false;
    }
    let rt = live
        .runtimes
        .entry(gateway_id.into())
        .or_insert_with(|| new_runtime(discovery.clone()));
    rt.discovery = discovery.clone();
    rt.pending_signin = true;
    rt.status = GatewayStatus::Connecting;
    drop(live);
    signal_rows_changed(app, state);
    true
}

pub(super) fn withdraw_pending_signin(
    state: &AppState,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
) {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return;
    }
    if let Some(rt) = live.runtimes.get_mut(gateway_id) {
        rt.pending_signin = false;
    }
}

fn expire_signin<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    gateway_id: &str,
    label: &str,
    attempt: &Arc<GatewayAttempt>,
) {
    // Once the callback has arrived the browser did its part: the sign-in
    // ends in its own outcome, and an expiry now would undo a commit in
    // flight or hide a refusal behind a timeout.
    if attempt.callback_was_accepted() {
        return;
    }
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return;
    }
    let Some(rt) = live
        .runtimes
        .get_mut(gateway_id)
        .filter(|rt| rt.pending_signin)
    else {
        return;
    };
    rt.pending_signin = false;
    rt.status = GatewayStatus::Disconnected;
    rt.last_error = Some("sign-in was not completed in the browser".into());
    live.attempts.remove(gateway_id);
    attempt.cancel.cancel();
    drop(live);
    auth::clear_gateway_signin(gateway_id, attempt);
    emit_notice(
        app,
        "error",
        "gateway",
        gateway_id,
        label,
        "Sign-in timed out",
        "sign-in was not completed in the browser; click Connect to try again",
    );
    signal_rows_changed(app, state);
}

impl GatewayManager {
    fn any_pending_signin_other_than(&self, gateway_id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .runtimes
            .iter()
            .any(|(id, rt)| rt.pending_signin && id != gateway_id)
    }
}

/// Resume after a sign-in callback on its own attempt, never a replacement.
pub(super) async fn resume_gateway_signin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Arc<AppState>,
    gateway_id: String,
    attempt: Arc<GatewayAttempt>,
    pat: auth::StoredPat,
) {
    let discovery = {
        let mut live = state.gateway_manager.state.lock().unwrap();
        if live.owns(&gateway_id, &attempt) {
            let Some(rt) = live.runtimes.get_mut(&gateway_id) else {
                live.attempts.remove(&gateway_id);
                attempt.cancel.cancel();
                drop(live);
                signal_rows_changed(&app, &state);
                return;
            };
            rt.pending_signin = false;
            Some(rt.discovery.clone())
        } else {
            None
        }
    };
    let Some(discovery) = discovery else {
        // Only a kept credential commit reaches here: one a replacing connect
        // waited for, or one a cancel reached after it ended. The row is no
        // longer this attempt's, so the credentials wait for a later Connect.
        match gateway_row(&state, &gateway_id) {
            Ok(row) => emit_notice(
                &app, "info", "gateway", &gateway_id, &display_label(&row), "Sign-in stored",
                "the sign-in completed for a gateway that was disconnected meanwhile; click Connect to use it",
            ),
            Err(_) => emit_notice(
                &app, "info", "desktop", "desktop", "chan-desktop", "Sign-in ignored",
                "the sign-in completed for a gateway that was removed meanwhile",
            ),
        }
        return;
    };
    let status = auth::AuthStatus {
        is_signed_in: true,
        label: Some(pat.label.clone()),
        expires_at: (!pat.expires_at.is_empty()).then(|| pat.expires_at.clone()),
    };
    let _ = app.emit(auth::AUTH_CHANGED, &status);
    if let Err(error) =
        connect_with_pat(&app, &state, &gateway_id, &attempt, &discovery, pat, true).await
    {
        tracing::warn!(gateway = %gateway_id, %error, "gateway connect after sign-in failed");
    }
}

/// A failed callback or listener can settle only the attempt that owns it.
pub(super) fn fail_gateway_signin<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    message: &str,
) {
    let mut live = state.gateway_manager.state.lock().unwrap();
    if !live.owns(gateway_id, attempt) {
        return;
    }
    live.attempts.remove(gateway_id);
    attempt.cancel.cancel();
    if let Some(rt) = live.runtimes.get_mut(gateway_id) {
        rt.pending_signin = false;
        rt.status = GatewayStatus::Disconnected;
        rt.last_error = Some(message.into());
    }
    drop(live);
    let _ = app.emit(auth::AUTH_ERROR, message);
    signal_rows_changed(app, state);
}

/// Pause or resume roster polling on mobile. Ticks skip their fetch while
/// suspended; the loop itself keeps sleeping, so resume needs no restart.
pub(super) fn set_roster_poll_suspended(state: &Arc<AppState>, suspended: bool) {
    state.gateway_manager.state.lock().unwrap().suspended = suspended;
}

/// Run one immediate roster tick per polled gateway: the foreground resync.
/// Runtimes without a poll (never connected, or torn down) are skipped.
pub(super) fn resync_roster_polls<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
) {
    let polls: Vec<(String, String, String, CancellationToken)> = {
        let live = state.gateway_manager.state.lock().unwrap();
        live.runtimes
            .iter()
            .filter_map(|(id, rt)| {
                let cancel = rt.poll_cancel.clone()?;
                Some((
                    id.clone(),
                    rt.discovery.identity_origin.clone(),
                    rt.discovery.mobile_roster_url.clone(),
                    cancel,
                ))
            })
            .collect()
    };
    for (gateway_id, identity_origin, roster_url, cancel) in polls {
        let app = app.clone();
        let state = Arc::clone(state);
        tauri::async_runtime::spawn(async move {
            let _ = roster_poll_tick(
                &app,
                &state,
                &gateway_id,
                &identity_origin,
                &roster_url,
                &cancel,
            )
            .await;
        });
    }
}

fn spawn_roster_poll<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    roster_url: String,
) -> bool {
    let cancel = CancellationToken::new();
    let identity_origin = {
        let mut gateway_state = state.gateway_manager.state.lock().unwrap();
        if !gateway_state.owns(gateway_id, attempt) {
            return false;
        }
        gateway_state.attempts.remove(gateway_id);
        let runtimes = &mut gateway_state.runtimes;
        let Some(rt) = runtimes.get_mut(gateway_id) else {
            return false;
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
            let tick = roster_poll_tick(
                &app,
                &state,
                &gateway_id,
                &identity_origin,
                &roster_url,
                &cancel,
            )
            .await;
            if tick.is_break() {
                break;
            }
        }
    });
    true
}

/// One roster-poll round after the loop's sleep. `Break` ends the loop: the
/// runtime is gone, a successor poll replaced this one, or the gateway
/// signed out.
async fn roster_poll_tick<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    identity_origin: &str,
    roster_url: &str,
    cancel: &CancellationToken,
) -> ControlFlow<()> {
    // A backgrounded mobile app skips the fetch but keeps the loop: the
    // foreground transition resyncs immediately (resync_roster_polls).
    if state.gateway_manager.state.lock().unwrap().suspended {
        return ControlFlow::Continue(());
    }
    // Re-read the PAT each tick: a re-sign-in mid-poll swaps the
    // credential without restarting the loop.
    let loaded = auth::load_gateway_pat(identity_origin);
    let signed_out = matches!(loaded, Ok(None));
    let effect = match loaded {
        Ok(Some(pat)) => {
            let etag = {
                let mut gateway_state = state.gateway_manager.state.lock().unwrap();
                let runtimes = &mut gateway_state.runtimes;
                let Some(rt) = runtimes.get_mut(gateway_id) else {
                    return ControlFlow::Break(());
                };
                if rt.pat_load_failures > 0 {
                    tracing::info!(
                        gateway = %gateway_id,
                        failed_rounds = rt.pat_load_failures,
                        "roster poll loaded the gateway PAT again"
                    );
                    rt.pat_load_failures = 0;
                }
                rt.etag.clone()
            };
            let fetch = fetch_roster(roster_url, &pat.secret, etag.as_deref()).await;
            // A disconnect+reconnect replaced this poll while the fetch
            // was in flight: the successor owns the runtime now, and the
            // map-presence check below cannot tell the two polls apart -
            // only the token can. Applying the stale fetch would clobber
            // the successor's state.
            if cancel.is_cancelled() {
                return ControlFlow::Break(());
            }
            let mut gateway_state = state.gateway_manager.state.lock().unwrap();
            let runtimes = &mut gateway_state.runtimes;
            match runtimes.get_mut(gateway_id) {
                Some(rt) => apply_roster_fetch(rt, fetch),
                None => return ControlFlow::Break(()),
            }
        }
        // Nothing was fetched: the outcome is made up here, so it is judged
        // and applied under one lock, by a poll whose token still stands, on
        // a runtime no connect or browser sign-in owns. A connect clears a
        // rejected PAT before its browser leg while this poll still runs,
        // and reports its own load failures.
        loaded => {
            let mut gateway_state = state.gateway_manager.state.lock().unwrap();
            if cancel.is_cancelled() {
                return ControlFlow::Break(());
            }
            if gateway_state.attempts.contains_key(gateway_id) {
                return ControlFlow::Continue(());
            }
            let Some(rt) = gateway_state.runtimes.get_mut(gateway_id) else {
                return ControlFlow::Break(());
            };
            let fetch = match loaded {
                // The stored credential is gone and nothing can read the
                // roster without one: sign out the way a rejected credential
                // does.
                Ok(_) => RosterFetch::Unauthorized,
                // A keychain that cannot answer counts toward unreachable
                // like a gateway that cannot, so the row stops claiming a
                // fresh roster; the streak warns once.
                Err(error) => {
                    rt.pat_load_failures = rt.pat_load_failures.saturating_add(1);
                    if rt.pat_load_failures == 1 {
                        tracing::warn!(gateway = %gateway_id, %error, "roster poll could not load the gateway PAT");
                    }
                    RosterFetch::Upstream(error)
                }
            };
            apply_roster_fetch(rt, fetch)
        }
    };
    apply_roster_policy_diff(state, gateway_id, &effect.diff).await;
    if effect.cascade {
        let label = gateway_row(state, gateway_id)
            .map(|g| display_label(&g))
            .unwrap_or_else(|_| gateway_id.to_string());
        cascade_disconnect(app, state, gateway_id, CascadeReason::Unauthorized).await;
        let (title, message) = if signed_out {
            (
                "Gateway signed out",
                "the stored sign-in is gone; click Connect to sign in again",
            )
        } else {
            (
                "Gateway sign-in expired",
                "the gateway rejected the stored sign-in; click Connect to sign in again",
            )
        };
        emit_notice(app, "error", "gateway", gateway_id, &label, title, message);
        return ControlFlow::Break(());
    }
    if effect.became_unreachable {
        let label = gateway_row(state, gateway_id)
            .map(|g| display_label(&g))
            .unwrap_or_else(|_| gateway_id.to_string());
        notice_unreachable(app, state, gateway_id, &label);
    }
    if effect.changed {
        signal_rows_changed(app, state);
    }
    ControlFlow::Continue(())
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
    /// The roster answered 401, or the poll found the stored PAT gone: clear
    /// the PAT, keep enabled (the next connect runs the sign-in leg).
    Unauthorized,
}

struct GatewayTeardown {
    attempt: Option<Arc<GatewayAttempt>>,
    runtime: Option<GatewayRuntime>,
    previous: Option<Arc<CancellationToken>>,
    finished: Arc<CancellationToken>,
}

fn invalidate_gateway(
    state: &AppState,
    gateway_id: &str,
    reason: CascadeReason,
) -> GatewayTeardown {
    let mut store = state.store.lock().unwrap();
    let mut live = state.gateway_manager.state.lock().unwrap();
    if reason == CascadeReason::UserDisconnect {
        persist_enabled(&mut store, gateway_id, false);
    }
    #[cfg(test)]
    if let Some(after_intent) = state
        .gateway_manager
        .after_cancel_intent
        .lock()
        .unwrap()
        .take()
    {
        after_intent();
    }
    let attempt = live.attempts.remove(gateway_id);
    live.discovery_errors.remove(gateway_id);
    if let Some(attempt) = &attempt {
        attempt.cancel.cancel();
    }
    let runtime = live.runtimes.remove(gateway_id);
    if let Some(cancel) = runtime.as_ref().and_then(|rt| rt.poll_cancel.as_ref()) {
        cancel.cancel();
    }
    let finished = Arc::new(CancellationToken::new());
    let previous = live
        .teardowns
        .insert(gateway_id.into(), Arc::clone(&finished));
    GatewayTeardown {
        attempt,
        runtime,
        previous,
        finished,
    }
}

/// Invalidate work and intent together before waiting for policy or teardown.
/// Successors can start, but wait for the ordered teardown before discovery.
pub async fn cascade_disconnect<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    gateway_id: &str,
    reason: CascadeReason,
) {
    let GatewayTeardown {
        attempt,
        runtime,
        previous,
        finished,
    } = invalidate_gateway(state, gateway_id, reason);
    signal_rows_changed(app, state);
    if let Some(previous) = previous {
        previous.cancelled().await;
    }
    let _policy = match &attempt {
        Some(attempt) => {
            // No gateway/store lock is held while waiting for a keyring call.
            auth::clear_gateway_signin(gateway_id, attempt);
            attempt.finish_cancellation().await;
            Some(attempt.policy.lock().await)
        }
        None => None,
    };
    if let Some(runtime) = runtime {
        for row in &runtime.roster {
            let synth_id = synthesized_row_id(gateway_id, &row.owner, &row.devserver_id);
            let policy_lock = state.native_policy_lock(&synth_id);
            let _policy_guard = policy_lock.lock().await;
            state.bump_native_policy_generation(&synth_id);
            await_devserver_teardown(state, &synth_id).await;
        }
        if reason == CascadeReason::Unauthorized {
            if let Err(e) = auth::clear_gateway_pat(&runtime.discovery.identity_origin) {
                tracing::warn!(gateway = %gateway_id, error = %e, "clearing gateway PAT failed");
            }
        }
    }
    let mut live = state.gateway_manager.state.lock().unwrap();
    if live
        .teardowns
        .get(gateway_id)
        .is_some_and(|current| Arc::ptr_eq(current, &finished))
    {
        live.teardowns.remove(gateway_id);
    }
    finished.cancel();
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
pub(crate) mod tests {
    use super::*;

    struct SigninFixture {
        _dir: tempfile::TempDir,
        state: Arc<AppState>,
        attempt: Arc<GatewayAttempt>,
        discovery: GatewayDiscovery,
        app: tauri::App<tauri::test::MockRuntime>,
    }

    impl SigninFixture {
        fn new(origin: &str) -> Self {
            use tauri::Manager;
            let (dir, state) = pat_load_test_state(origin);
            let attempt = begin_connect(&state, "gw-keychain")
                .unwrap()
                .unwrap()
                .attempt;
            let mut rt = runtime_with(Vec::new());
            rt.discovery.identity_origin = origin.into();
            rt.discovery.mobile_authorize_url = format!("{origin}/mobile/authorize");
            rt.discovery.mobile_entry_url = format!("{origin}/mobile/v1/devserver/entry");
            rt.discovery.mobile_roster_url = format!("{origin}/mobile/v1/devservers");
            rt.pending_signin = true;
            let discovery = rt.discovery.clone();
            state
                .gateway_manager
                .state
                .lock()
                .unwrap()
                .runtimes
                .insert("gw-keychain".into(), rt);
            let app = tauri::test::mock_app();
            app.manage(Arc::clone(&state));
            Self {
                _dir: dir,
                state,
                attempt,
                discovery,
                app,
            }
        }

        async fn cancel(&self) {
            cascade_disconnect(
                self.app.handle(),
                &self.state,
                "gw-keychain",
                CascadeReason::UserDisconnect,
            )
            .await;
        }

        fn callback(&self, query: &str) -> impl std::future::Future<Output = ()> + Send + 'static {
            auth::tests::callback_for_test(
                self.app.handle().clone(),
                "gw-keychain",
                &self.attempt,
                &self.discovery.identity_origin,
                query,
            )
        }
    }

    fn auth_events(
        app: &tauri::App<tauri::test::MockRuntime>,
    ) -> std::sync::mpsc::Receiver<String> {
        use tauri::Listener;
        let (tx, rx) = std::sync::mpsc::channel();
        for name in [auth::AUTH_CHANGED, auth::AUTH_ERROR] {
            let tx = tx.clone();
            app.listen(name, move |_| {
                let _ = tx.send(name.into());
            });
        }
        rx
    }

    fn unlocked_auth_events(
        app: &tauri::App<tauri::test::MockRuntime>,
        state: &Arc<AppState>,
        name: &'static str,
    ) -> std::sync::mpsc::Receiver<(String, bool)> {
        use tauri::Listener;
        let (tx, rx) = std::sync::mpsc::channel();
        let state = Arc::clone(state);
        app.listen(name, move |event| {
            let unlocked = state.gateway_manager.state.try_lock().is_ok();
            tx.send((event.payload().into(), unlocked)).unwrap();
        });
        app.emit(name, "listener control").unwrap();
        assert_eq!(
            rx.try_recv().unwrap(),
            ("\"listener control\"".into(), true)
        );
        rx
    }

    fn assert_failed_callback_settled(
        f: &SigninFixture,
        events: &std::sync::mpsc::Receiver<(String, bool)>,
        message: &str,
    ) {
        let slot_left = auth::tests::take_pending_for_test();
        let view = f.state.gateway_manager.view("gw-keychain").unwrap();
        assert_eq!(
            view.status,
            GatewayStatus::Disconnected,
            "a current failed callback must disconnect its row"
        );
        assert!(!view.pending_signin);
        assert_eq!(view.last_error.as_deref(), Some(message));
        let (payload, unlocked) = events.try_recv().expect("one current auth-error");
        assert_eq!(serde_json::from_str::<String>(&payload).unwrap(), message);
        assert!(events.try_recv().is_err(), "exactly one auth-error");
        assert!(!slot_left, "failed callback must clear its owned slot");
        assert!(
            unlocked,
            "auth-error must be emitted outside the gateway lock"
        );
    }

    #[tokio::test]
    async fn current_failed_callback_disconnects_and_emits_one_error() {
        let _serial = auth::tests::SLOT_TEST_LOCK.lock().await;
        let f = SigninFixture::new("https://failed-callback.example.test");
        let events = unlocked_auth_events(&f.app, &f.state, auth::AUTH_ERROR);
        let stopped = auth::tests::install_pending_for_test("gw-keychain", &f.attempt);
        assert!(!*stopped.borrow());
        f.callback("error=user_cancelled&state=nonce-1").await;
        assert_failed_callback_settled(&f, &events, "sign-in was cancelled in the browser");
        assert!(*stopped.borrow());
    }

    #[tokio::test]
    async fn expired_signin_refuses_credential_commit() {
        let _serial = auth::tests::SLOT_TEST_LOCK.lock().await;
        let f = SigninFixture::new("https://expired-commit.example.test");
        let control = GatewayAttempt::default();
        let mut stores = 0;
        assert!(control
            .commit_credentials(&mut writes(|| {
                stores += 1;
                Ok(())
            }))
            .unwrap());
        assert_eq!(stores, 1, "a fresh attempt runs its credential store");
        expire_signin(
            f.app.handle(),
            &f.state,
            "gw-keychain",
            "gateway",
            &f.attempt,
        );
        let stored = f
            .attempt
            .commit_credentials(&mut writes(|| {
                stores += 1;
                Ok(())
            }))
            .unwrap();
        assert!(!stored, "an expired attempt refuses credential commitment");
        assert_eq!(stores, 1, "expiry must not call the credential store");
        let view = f.state.gateway_manager.view("gw-keychain").unwrap();
        assert_eq!(view.status, GatewayStatus::Disconnected);
        assert!(!view.pending_signin);
    }

    #[tokio::test]
    async fn owning_resume_without_runtime_ends_its_attempt() {
        use tauri::Listener;
        let (_dir, state) = pat_load_test_state("https://missing-runtime.example.test");
        let attempt = begin_connect(&state, "gw-keychain")
            .unwrap()
            .unwrap()
            .attempt;
        let app = tauri::test::mock_app();
        let events = auth_events(&app);
        let (signal, signals) = std::sync::mpsc::channel();
        let signal_state = Arc::clone(&state);
        app.listen(crate::serve::SERVES_CHANGED, move |_| {
            let _ = signal.send(signal_state.gateway_manager.state.try_lock().is_ok());
        });
        signal_rows_changed(app.handle(), &state);
        assert_eq!(
            signals.try_iter().collect::<Vec<_>>(),
            [true],
            "the listener sees a row signal after unlocking"
        );
        assert_eq!(
            state.gateway_manager.view("gw-keychain").unwrap().status,
            GatewayStatus::Connecting
        );
        resume_gateway_signin(
            app.handle().clone(),
            Arc::clone(&state),
            "gw-keychain".into(),
            Arc::clone(&attempt),
            auth::StoredPat {
                id: "test".into(),
                secret: "fixture-only".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        )
        .await;
        assert!(
            state.gateway_manager.view("gw-keychain").is_none(),
            "resume without runtime must remove its attempt"
        );
        assert!(
            attempt.is_cancelled(),
            "resume without runtime must cancel its attempt"
        );
        assert_eq!(
            signals.try_iter().collect::<Vec<_>>(),
            [true],
            "resume without runtime must signal its removed row once, after unlocking"
        );
        assert!(
            events.try_recv().is_err(),
            "a missing runtime receives no auth event"
        );
        assert!(
            begin_connect(&state, "gw-keychain").unwrap().is_some(),
            "a new connect can start"
        );
    }

    /// The id of the token `headers` present as their bearer: the id of the
    /// `minted` token whose secret it is, `-` for anything else.
    fn bearer_id(headers: &axum::http::HeaderMap, minted: &[(String, String)]) -> String {
        let bearer = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        minted
            .iter()
            .find(|(_, secret)| bearer == Some(secret.as_str()))
            .map_or_else(|| "-".into(), |(id, _)| id.clone())
    }

    const WG_SERVER_KEY: &str = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
    /// A TEST-NET address: no lookup, and no handshake ever completes.
    const WG_ENDPOINT: &str = "192.0.2.1:51820";

    fn redeem_answer(wireguard: Option<serde_json::Value>) -> serde_json::Value {
        let mut answer = serde_json::json!({
            "id": "pat-wg",
            "secret": "fixture-only",
            "label": "test",
            "expires_at": null,
        });
        if let Some(params) = wireguard {
            answer["wireguard"] = params;
        }
        answer
    }

    fn redeem_params(server_public_key: &str) -> serde_json::Value {
        serde_json::json!({
            "server_public_key": server_public_key,
            "endpoint": WG_ENDPOINT,
            "addresses": ["10.7.0.23/32", "fd00:7::23/128"],
            "allowed_ips": ["10.7.0.1/32"],
            "persistent_keepalive": 25,
            "hosts": [
                {"name": "proxy.chan.invalid", "addresses": ["10.7.0.1"]},
                {"name": "*.proxy.chan.invalid", "addresses": ["10.7.0.1"]},
            ],
        })
    }

    /// Credential writes from one closure with nothing to undo, for tests of
    /// the commit's refusal and locking rather than of a sign-in's writes.
    struct ClosureWrites<F>(Option<F>);

    impl<F: FnOnce() -> Result<(), String>> CredentialWrites for ClosureWrites<F> {
        fn write(&mut self) -> Result<(), String> {
            (self.0.take().expect("the commit writes once"))()
        }

        fn undo(&mut self) {}

        fn abandoned(&self) -> bool {
            false
        }
    }

    fn writes<F: FnOnce() -> Result<(), String>>(write: F) -> ClosureWrites<F> {
        ClosureWrites(Some(write))
    }

    /// Writes that count their calls and run `during` inside the write,
    /// where a cancel lands in the middle of a commit.
    struct CountedWrites {
        writes: usize,
        undos: usize,
        during: Option<Box<dyn FnOnce()>>,
    }

    impl CredentialWrites for CountedWrites {
        fn write(&mut self) -> Result<(), String> {
            self.writes += 1;
            if let Some(during) = self.during.take() {
                during();
            }
            Ok(())
        }

        fn undo(&mut self) {
            self.undos += 1;
        }

        fn abandoned(&self) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn commit_undoes_writes_a_cancel_lands_in_unless_a_live_successor_waits() {
        let _serial = auth::tests::SLOT_TEST_LOCK.lock().await;
        type App = tauri::AppHandle<tauri::test::MockRuntime>;
        type Cancel = Box<dyn FnOnce(&AppState, &App, &Arc<GatewayAttempt>)>;
        let disconnect: Cancel = Box::new(|state, _, _| {
            invalidate_gateway(state, "gw-keychain", CascadeReason::UserDisconnect);
        });
        let replace: Cancel = Box::new(|state, _, _| {
            begin_connect(state, "gw-keychain").unwrap().unwrap();
        });
        let replace_then_disconnect: Cancel = Box::new(|state, _, _| {
            begin_connect(state, "gw-keychain").unwrap().unwrap();
            invalidate_gateway(state, "gw-keychain", CascadeReason::UserDisconnect);
        });
        let removal_cascade: Cancel = Box::new(|state, _, _| {
            invalidate_gateway(state, "gw-keychain", CascadeReason::Removed);
        });
        let expiry: Cancel = Box::new(|state, app, attempt| {
            expire_signin(app, state, "gw-keychain", "gateway", attempt);
        });
        let expiry_after_callback: Cancel = Box::new(|state, app, attempt| {
            attempt.accept_callback();
            expire_signin(app, state, "gw-keychain", "gateway", attempt);
        });
        for (case, cancel, kept) in [
            ("a disconnect", disconnect, false),
            ("a removal's cascade", removal_cascade, false),
            ("an expired browser wait", expiry, false),
            (
                "an expiry after the callback arrived",
                expiry_after_callback,
                true,
            ),
            ("a replacing connect", replace, true),
            (
                "a replacing connect then disconnected",
                replace_then_disconnect,
                false,
            ),
        ] {
            let f = SigninFixture::new("https://commit-undo.example.test");
            let state = Arc::clone(&f.state);
            let app = f.app.handle().clone();
            let attempt = Arc::clone(&f.attempt);
            let mut writes = CountedWrites {
                writes: 0,
                undos: 0,
                during: Some(Box::new(move || cancel(&state, &app, &attempt))),
            };
            let committed = f.attempt.commit_credentials(&mut writes).unwrap();
            assert_eq!(committed, kept, "{case}");
            assert_eq!(writes.writes, 1, "{case}: the commit runs to its end");
            assert_eq!(
                writes.undos,
                usize::from(!kept),
                "{case}: undone exactly when nothing waits for the credentials"
            );
        }
    }

    /// A peer key no discovery entry names: the sign-in refuses it.
    const OTHER_PEER: &str = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";

    /// Whether `future` is still pending after one poll.
    async fn still_pending<F: std::future::Future>(mut future: std::pin::Pin<&mut F>) -> bool {
        std::future::poll_fn(|cx| {
            std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx).is_pending())
        })
        .await
    }

    /// Invalidate the gateway as a Disconnect does, from a sync test hook,
    /// and settle the teardown the cascade would, so a later cascade does not
    /// wait on it.
    fn disconnect_now(state: &AppState) {
        let teardown = invalidate_gateway(state, "gw-keychain", CascadeReason::UserDisconnect);
        state
            .gateway_manager
            .state
            .lock()
            .unwrap()
            .teardowns
            .remove("gw-keychain");
        teardown.finished.cancel();
    }

    /// The revoke is logged by the token's id, and no line carries the
    /// token itself.
    fn assert_revoke_logged(lines: &crate::devserver::log_capture::Lines) {
        let text = lines.text();
        assert!(
            lines
                .infos()
                .iter()
                .any(|line| line.contains("gateway sign-in token revoked")
                    && line.contains("pat-wg")),
            "{text}"
        );
        assert!(
            !text.contains("fixture-only"),
            "a log line carries the token: {text}"
        );
    }

    #[tokio::test]
    async fn stale_resume_keeps_successor_identity_and_emits_no_auth_event() {
        let f = StaleAttempt::new();
        let app = tauri::test::mock_app();
        let events = auth_events(&app);
        resume_gateway_signin(
            app.handle().clone(),
            Arc::clone(&f.state),
            "gw-keychain".into(),
            Arc::clone(&f.stale),
            auth::StoredPat {
                id: "test".into(),
                secret: "test".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        )
        .await;
        assert!(
            events.try_recv().is_err(),
            "stale resume cannot announce authentication"
        );
        assert!(f
            .state
            .gateway_manager
            .state
            .lock()
            .unwrap()
            .owns("gw-keychain", &f.current));
        assert!(
            f.state
                .gateway_manager
                .view("gw-keychain")
                .unwrap()
                .pending_signin
        );
    }

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

    pub(crate) fn runtime_with(rows: Vec<RosterDevserver>) -> GatewayRuntime {
        let mut rt = new_runtime(GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "https://gw.chan.app".into(),
            mobile_authorize_url: "https://gw.chan.app/mobile/authorize".into(),
            mobile_entry_url: "https://gw.chan.app/mobile/v1/devserver/entry".into(),
            mobile_roster_url: "https://gw.chan.app/mobile/v1/devservers".into(),
            devserver_proxy_origin: "https://proxy.chan.app".into(),
            devserver_proxy_host_depth: 2,
            wireguard: None,
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
            wireguard: None,
            wireguard_public_key: None,
            wireguard_enrolled_key: None,
            wireguard_enrollment: None,
            wireguard_cleanup: None,
            wireguard_hosts: Vec::new(),
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
        let p1 = "https://alice--a.p1.proxy.chan.app";
        let p2 = "https://alice--a.p2.proxy.chan.app";
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
            "/mobile/v1/devservers",
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
        (format!("http://{addr}/mobile/v1/devservers"), handle)
    }

    fn resp(status: u16, etag: Option<&str>, body: &str) -> axum::response::Response {
        let mut b = axum::http::Response::builder().status(status);
        if let Some(etag) = etag {
            b = b.header(axum::http::header::ETAG, etag);
        }
        b.body(axum::body::Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn a_failed_roster_request_names_its_cause() {
        let sink = chan_tls::testing::Sink::start();
        let url = format!("https://{}/mobile/v1/devservers", sink.addr);
        match fetch_roster(&url, "pat-secret", None).await {
            RosterFetch::Upstream(error) => {
                assert!(
                    error.starts_with("roster request failed: error sending request: "),
                    "{error}"
                );
                assert!(error.contains("client error (Connect)"), "{error}");
            }
            other => panic!("expected Upstream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn fetch_parses_a_fresh_roster_and_derives_shared() {
        let body = r#"{"user_id":"11111111-1111-1111-1111-111111111111","username":"alice","devservers":[
            {"owner_user_id":"11111111-1111-1111-1111-111111111111","owner":"alice","devserver_id":"a1","label":"laptop","online":true,"proxy_origin":"https://alice--a1.p1.proxy.chan.app"},
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
                    Some("https://alice--a1.p1.proxy.chan.app"),
                    "the online row carries its node origin"
                );
                assert_eq!(rows[1].proxy_origin, None, "the offline row is null");
            }
            other => panic!("expected Fresh, got {other:?}"),
        }
        server.abort();
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

    /// A gateway in one stub: discovery (loopback http, mobile_roster_url
    /// advertised, proxy origin inside the static grant scope so the
    /// capability mint no-ops under the mock runtime) plus a one-row
    /// roster.
    async fn spawn_gateway_stub(unauthorized: bool) -> (String, tokio::task::JoinHandle<()>) {
        spawn_gateway_stub_with_hold(unauthorized, None).await
    }

    async fn spawn_gateway_stub_with_hold(
        unauthorized: bool,
        hold: Option<tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        spawn_gateway_stub_full(unauthorized, hold, None).await
    }

    /// The gateway stub, its discovery carrying `wireguard` when given.
    async fn spawn_gateway_stub_full(
        unauthorized: bool,
        hold: Option<tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>>,
        wireguard: Option<serde_json::Value>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use axum::{response::IntoResponse, routing::get};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let disc_origin = origin.clone();
        let app = axum::Router::new()
            .route(
                "/.well-known/chan-gateway",
                get(move || {
                    let o = disc_origin.clone();
                    let wireguard = wireguard.clone();
                    async move {
                        let mut doc = serde_json::json!({
                            "kind": "chan-gateway",
                            "api_version": 1,
                            "identity_origin": o,
                            "mobile_authorize_url": format!("{o}/mobile/authorize"),
                            "mobile_entry_url": format!("{o}/mobile/v1/devserver/entry"),
                            "mobile_roster_url": format!("{o}/mobile/v1/devservers"),
                            "devserver_proxy_origin": "https://proxy.chan.app",
                            "devserver_proxy_host_depth": 2,
                        });
                        if let Some(entry) = wireguard {
                            doc["wireguard"] = entry;
                        }
                        axum::Json(doc)
                    }
                }),
            )
            .route(
                "/mobile/v1/devservers",
                get(move || {
                    let hold = hold.clone();
                    async move {
                        if let Some(entered) = hold {
                            let (release, wait) = tokio::sync::oneshot::channel();
                            entered.send(release).unwrap();
                            let _ = wait.await;
                        }
                        if unauthorized {
                            return axum::http::StatusCode::UNAUTHORIZED.into_response();
                        }
                        axum::Json(serde_json::json!({
                            "user_id": "11111111-1111-1111-1111-111111111111",
                            "username": "alice",
                            "devservers": [{
                                "owner_user_id": "11111111-1111-1111-1111-111111111111",
                                "owner": "alice",
                                "devserver_id": "a1",
                                "label": "laptop",
                                "online": true,
                                "proxy_origin": "https://alice--a1.p1.proxy.chan.app"
                            }]
                        }))
                        .into_response()
                    }
                }),
            );
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (origin, handle)
    }

    async fn held_discovery() -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<tokio::sync::oneshot::Sender<()>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (entered, requests) = tokio::sync::mpsc::unbounded_channel();
        let router = axum::Router::new().route(
            "/.well-known/chan-gateway",
            axum::routing::get(move || {
                let entered = entered.clone();
                async move {
                    let (release, wait) = tokio::sync::oneshot::channel();
                    entered.send(release).unwrap();
                    let _ = wait.await;
                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (origin, requests, server)
    }

    fn hold_teardowns(
        state: &AppState,
    ) -> tokio::sync::mpsc::UnboundedReceiver<(String, tokio::sync::oneshot::Sender<()>)> {
        let (entered, entry) = tokio::sync::mpsc::unbounded_channel();
        state
            .devserver_remove_hook
            .set(Arc::new(move |id| {
                let (release, wait) = tokio::sync::oneshot::channel();
                entered.send((id.to_string(), release)).unwrap();
                tauri::async_runtime::spawn(async move {
                    let _ = wait.await;
                })
            }))
            .ok()
            .unwrap();
        entry
    }

    struct StaleAttempt {
        _dir: tempfile::TempDir,
        state: Arc<AppState>,
        stale: Arc<GatewayAttempt>,
        current: Arc<GatewayAttempt>,
        discovery: GatewayDiscovery,
    }

    impl StaleAttempt {
        fn new() -> Self {
            let origin = format!("https://{}.example.test", uuid::Uuid::new_v4());
            let (dir, state) = pat_load_test_state(&origin);
            let stale = begin_connect(&state, "gw-keychain")
                .unwrap()
                .unwrap()
                .attempt;
            let mut rt = runtime_with(Vec::new());
            rt.discovery.identity_origin = origin;
            rt.discovery.mobile_roster_url = UNUSED_ROSTER_URL.into();
            rt.pending_signin = true;
            let discovery = rt.discovery.clone();
            state
                .gateway_manager
                .state
                .lock()
                .unwrap()
                .runtimes
                .insert("gw-keychain".into(), rt);
            let current = begin_connect(&state, "gw-keychain")
                .unwrap()
                .unwrap()
                .attempt;
            {
                let mut live = state.gateway_manager.state.lock().unwrap();
                let rt = live.runtimes.get_mut("gw-keychain").unwrap();
                rt.status = GatewayStatus::Connecting;
                rt.pending_signin = true;
                rt.username = "successor".into();
                rt.last_error = Some("successor marker".into());
            }
            Self {
                _dir: dir,
                state,
                stale,
                current,
                discovery,
            }
        }

        fn assert_unchanged(&self) {
            let live = self.state.gateway_manager.state.lock().unwrap();
            assert!(
                live.owns("gw-keychain", &self.current),
                "successor still owns the attempt"
            );
            let rt = live
                .runtimes
                .get("gw-keychain")
                .expect("successor runtime retained");
            assert_eq!(
                rt.status,
                GatewayStatus::Connecting,
                "stale result changed status"
            );
            assert!(rt.pending_signin, "stale result cleared the successor wait");
            assert_eq!(rt.username, "successor", "stale result changed username");
            assert_eq!(
                rt.last_error.as_deref(),
                Some("successor marker"),
                "stale result changed error"
            );
            assert_eq!(rt.consecutive_failures, 0, "stale failure was counted");
            assert!(rt.poll_cancel.is_none(), "stale result installed a poll");
        }
    }

    fn notices(app: &tauri::App<tauri::test::MockRuntime>) -> std::sync::mpsc::Receiver<String> {
        use tauri::Listener;
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen(LAUNCHER_NOTICE, move |event| {
            let _ = tx.send(event.payload().into());
        });
        rx
    }

    fn assert_stale_discovery_refused(succeeded: bool) {
        let f = StaleAttempt::new();
        let app = tauri::test::mock_app();
        let notices = notices(&app);
        let outcome = if succeeded {
            Ok(f.discovery.clone())
        } else {
            Err(GatewayDiscoveryError::Other("old failure".into()))
        };
        let result = publish_discovery(
            app.handle(),
            &f.state,
            "gw-keychain",
            "test",
            &f.stale,
            outcome,
        );
        assert!(
            matches!(result, Ok(None)),
            "stale discovery result must be refused"
        );
        f.assert_unchanged();
        assert!(
            notices.try_recv().is_err(),
            "stale discovery raised a notice"
        );
    }

    #[test]
    fn stale_discovery_outcome_leaves_successor_untouched() {
        assert_stale_discovery_refused(true);
        assert_stale_discovery_refused(false);
    }

    #[tokio::test]
    async fn connect_gateway_rejects_pre_mobile_discovery_payload() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let disc_origin = origin.clone();
        let router = axum::Router::new().route(
            "/.well-known/chan-gateway",
            axum::routing::get(move || {
                let o = disc_origin.clone();
                async move {
                    axum::Json(serde_json::json!({
                        "kind": "chan-gateway",
                        "api_version": 1,
                        "identity_origin": o,
                        "desktop_authorize_url": format!("{o}/desktop/authorize"),
                        "desktop_entry_url": format!("{o}/desktop/v1/devserver/entry"),
                        "roster_url": format!("{o}/desktop/v1/devservers"),
                        "devserver_proxy_origin": "https://proxy.chan.app",
                        "devserver_proxy_host_depth": 2,
                        "tunnel_url": "https://proxy.chan.app/v1/tunnel",
                    }))
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (_dir, state) = pat_load_test_state(&origin);
        let app = tauri::test::mock_app();
        let notices = notices(&app);
        let err = connect_gateway(
            app.handle().clone(),
            Arc::clone(&state),
            "gw-keychain".into(),
            false,
        )
        .await
        .expect_err("pre-mobile gateway discovery must fail");
        assert!(
            err.contains("this gateway does not support mobile sign-in"),
            "{err}"
        );
        let view = state
            .gateway_manager
            .view("gw-keychain")
            .expect("discovery error recorded");
        assert_eq!(view.status, GatewayStatus::Disconnected);
        assert!(
            view.last_error
                .as_deref()
                .is_some_and(|e| e.contains("this gateway does not support mobile sign-in")),
            "view={view:?}"
        );
        let payload = notices.try_recv().expect("unsupported notice emitted");
        let notice: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(notice["kind"], "error");
        assert!(
            notice["message"]
                .as_str()
                .is_some_and(|m| m.contains("this gateway does not support mobile sign-in")),
            "{notice}"
        );
        server.abort();
    }

    fn age_file(path: &std::path::Path) -> (Vec<u8>, std::time::SystemTime) {
        let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        (
            std::fs::read(path).unwrap(),
            std::fs::metadata(path).unwrap().modified().unwrap(),
        )
    }

    fn assert_file_unchanged(path: &std::path::Path, before: &(Vec<u8>, std::time::SystemTime)) {
        assert_eq!(std::fs::read(path).unwrap(), before.0, "file bytes changed");
        assert_eq!(
            std::fs::metadata(path).unwrap().modified().unwrap(),
            before.1,
            "file was rewritten"
        );
    }

    async fn assert_stale_first_fetch_refused(fetch: RosterFetch) {
        let f = StaleAttempt::new();
        let app = tauri::test::mock_app();
        let notices = notices(&app);
        finish_first_fetch(
            app.handle(),
            &f.state,
            "gw-keychain",
            &f.stale,
            &f.discovery,
            fetch,
            false,
        )
        .await
        .unwrap();
        f.assert_unchanged();
        assert!(notices.try_recv().is_err());
    }

    enum SigninEnding {
        NonInteractive,
        Expired,
        Abandoned,
    }

    pub(crate) fn pat_load_test_state(origin: &str) -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let mut cfg = config::Config::default();
        cfg.gateways.push(Gateway {
            id: "gw-keychain".into(),
            url: origin.into(),
            label: "test gateway".into(),
            enabled: true,
            added_at: 0,
            native_trust: Vec::new(),
            wireguard: None,
            wireguard_public_key: None,
            wireguard_enrolled_key: None,
            wireguard_enrollment: None,
            wireguard_cleanup: None,
            wireguard_hosts: Vec::new(),
        });
        store.lock().unwrap().save(&cfg).unwrap();
        (dir, Arc::new(AppState::with_store(store)))
    }

    /// No gateway listens here: a tick that got past the PAT load would
    /// record a refused connection instead of the load's own error.
    const UNUSED_ROSTER_URL: &str = "http://127.0.0.1:9/mobile/v1/devservers";

    /// A roster origin answering `status` to one request and reporting the
    /// hit. The tick under test runs detached for resync, so the hit crosses
    /// a channel with a bound.
    fn counting_roster_stub(status: &'static str) -> (String, std::sync::mpsc::Receiver<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/mobile/v1/devservers",
            listener.local_addr().unwrap()
        );
        let (hit_tx, hit_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut sock, _)) = listener.accept() else {
                return;
            };
            sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut head = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                match sock.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        head.extend_from_slice(&buf[..n]);
                        if head.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let body = "{}";
            let resp = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes());
            let _ = hit_tx.send(());
        });
        (url, hit_rx)
    }

    #[tokio::test]
    async fn suspended_poll_tick_skips_the_fetch() {
        // A fetch would queue a connection on the origin's listener even
        // unaccepted, so an empty accept queue proves the tick fetched
        // nothing.
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.set_nonblocking(true).unwrap();
        let roster_url = format!(
            "http://{}/mobile/v1/devservers",
            probe.local_addr().unwrap()
        );
        let (_dir, state) = pat_load_test_state("https://id.example");
        set_roster_poll_suspended(&state, true);
        let app = tauri::test::mock_app();
        let tick = roster_poll_tick(
            app.handle(),
            &state,
            "gw-suspend",
            "https://id.example",
            &roster_url,
            &CancellationToken::new(),
        )
        .await;
        assert!(
            tick.is_continue(),
            "a suspended tick continues without fetching"
        );
        assert!(
            probe.accept().is_err(),
            "a suspended tick opens no roster connection"
        );
    }

    #[tokio::test]
    async fn resync_runs_one_immediate_tick_per_polled_gateway() {
        let (polled_url, polled_hit) = counting_roster_stub("500 Internal Server Error");
        let (idle_url, idle_hit) = counting_roster_stub("500 Internal Server Error");
        // A 500 answers the hit-count without decoding a roster; the PAT load
        // is what the tick under test must get past. A unique origin keeps
        // the seeded PAT clear of every other test's.
        let origin = format!("https://resync-{}.example", uuid::Uuid::new_v4());
        let (_dir, state) = pat_load_test_state(&origin);
        auth::test_gateway_pats().lock().unwrap().insert(
            origin.clone(),
            auth::StoredPat {
                id: "t-1".into(),
                secret: "chan_pat_x".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        );
        {
            let mut live = state.gateway_manager.state.lock().unwrap();
            let mut polled = runtime_with(Vec::new());
            polled.discovery.identity_origin = origin.clone();
            polled.discovery.mobile_roster_url = polled_url;
            polled.poll_cancel = Some(CancellationToken::new());
            live.runtimes.insert("gw-polled".into(), polled);
            let mut idle = runtime_with(Vec::new());
            idle.discovery.identity_origin = origin.clone();
            idle.discovery.mobile_roster_url = idle_url;
            live.runtimes.insert("gw-idle".into(), idle);
        }
        let app = tauri::test::mock_app();
        resync_roster_polls(app.handle(), &state);
        polled_hit
            .recv_timeout(Duration::from_secs(10))
            .expect("the polled gateway ticks immediately on resync");
        assert!(
            idle_hit.recv_timeout(Duration::from_millis(500)).is_err(),
            "a runtime without a poll gets no resync tick",
        );
        auth::test_gateway_pats().lock().unwrap().remove(&origin);
    }

    /// Install a runtime under `pat_load_test_state`'s gateway id with a
    /// last-known roster, returning the poll token its cascade would cancel.
    fn install_polled_runtime(
        state: &AppState,
        identity_origin: &str,
        status: GatewayStatus,
        pending_signin: bool,
    ) -> CancellationToken {
        let mut rt = runtime_with(vec![row("alice", "a", true)]);
        rt.discovery.identity_origin = identity_origin.into();
        rt.status = status;
        rt.pending_signin = pending_signin;
        let cancel = CancellationToken::new();
        rt.poll_cancel = Some(cancel.clone());
        state
            .gateway_manager
            .state
            .lock()
            .unwrap()
            .runtimes
            .insert("gw-keychain".into(), rt);
        cancel
    }

    #[tokio::test]
    async fn a_pat_load_failure_on_the_roster_poll_reaches_unreachable() {
        use tauri::Listener;

        let origin = "https://keychain-failure.example.test";
        let (_dir, state) = pat_load_test_state(origin);
        let app = tauri::test::mock_app();
        let (notice_tx, notice_rx) = std::sync::mpsc::channel();
        app.listen(LAUNCHER_NOTICE, move |event| {
            notice_tx.send(event.payload().to_string()).unwrap();
        });
        let cancel = install_polled_runtime(&state, origin, GatewayStatus::Connected, false);
        let error = "reading gateway keychain: injected poll failure";
        let _failure = auth::fail_gateway_pat_load_for_test(origin, error);

        for tick in 1..=ROSTER_UNREACHABLE_FAILURES {
            let flow = roster_poll_tick(
                app.handle(),
                &state,
                "gw-keychain",
                origin,
                UNUSED_ROSTER_URL,
                &cancel,
            )
            .await;
            assert!(flow.is_continue(), "tick {tick} ended the poll");
            let view = state.gateway_manager.view("gw-keychain").unwrap();
            assert_eq!(
                view.last_error.as_deref(),
                Some(error),
                "tick {tick} recorded no failure"
            );
            let expected = if tick < ROSTER_UNREACHABLE_FAILURES {
                GatewayStatus::Connected
            } else {
                GatewayStatus::Unreachable
            };
            assert_eq!(view.status, expected, "status after tick {tick}");
            assert_eq!(
                view.devserver_count, 1,
                "the last-known roster stays served"
            );
        }
        let payload = notice_rx
            .try_recv()
            .expect("crossing the threshold emits one notice");
        let notice: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(notice["title"], "Gateway unreachable");
        assert!(notice["message"].as_str().unwrap().contains(error));
        assert_eq!(notice_rx.try_iter().count(), 0);
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test]
    async fn a_missing_pat_on_the_roster_poll_signs_a_connected_gateway_out() {
        use tauri::Listener;

        let origin = "https://keychain-missing.example.test";
        let (_dir, state) = pat_load_test_state(origin);
        let app = tauri::test::mock_app();
        let (notice_tx, notice_rx) = std::sync::mpsc::channel();
        app.listen(LAUNCHER_NOTICE, move |event| {
            notice_tx.send(event.payload().to_string()).unwrap();
        });
        let _absent = auth::absent_gateway_pat_for_test(origin);
        for status in [GatewayStatus::Connected, GatewayStatus::Unreachable] {
            let cancel = install_polled_runtime(&state, origin, status, false);
            let flow = roster_poll_tick(
                app.handle(),
                &state,
                "gw-keychain",
                origin,
                UNUSED_ROSTER_URL,
                &cancel,
            )
            .await;
            assert!(
                flow.is_break(),
                "a {status:?} gateway without a stored PAT kept polling"
            );
            assert!(
                state.gateway_manager.view("gw-keychain").is_none(),
                "the sign-out cascade takes a {status:?} runtime out"
            );
            assert!(cancel.is_cancelled());
            let payload = notice_rx.try_recv().expect("the sign-out emits a notice");
            let notice: serde_json::Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(notice["kind"], "error");
            assert_eq!(notice["source"]["id"], "gw-keychain");
            assert!(notice["message"]
                .as_str()
                .unwrap()
                .contains("click Connect to sign in again"));
            assert_eq!(notice_rx.try_iter().count(), 0);
            assert!(
                gateway_row(&state, "gw-keychain").unwrap().enabled,
                "a sign-out keeps the gateway enabled"
            );
        }
    }

    #[tokio::test]
    async fn the_roster_poll_leaves_a_connecting_runtime_to_its_connect() {
        use tauri::Listener;

        let origin = "https://keychain-connecting.example.test";
        let (_dir, state) = pat_load_test_state(origin);
        let app = tauri::test::mock_app();
        let (notice_tx, notice_rx) = std::sync::mpsc::channel();
        app.listen(LAUNCHER_NOTICE, move |event| {
            notice_tx.send(event.payload().to_string()).unwrap();
        });
        // A rejected PAT is cleared before the browser leg while the old
        // poll still runs, and a connect or sign-in reports its own outcome.
        for (status, pending_signin, fetch_in_flight) in [
            (GatewayStatus::Connecting, true, false),
            (GatewayStatus::Connecting, false, true),
        ] {
            for failing in [false, true] {
                let cancel = install_polled_runtime(&state, origin, status, pending_signin);
                state
                    .gateway_manager
                    .state
                    .lock()
                    .unwrap()
                    .attempts
                    .insert("gw-keychain".into(), Arc::new(GatewayAttempt::default()));
                let _absent = (!failing).then(|| auth::absent_gateway_pat_for_test(origin));
                let _failure = failing
                    .then(|| auth::fail_gateway_pat_load_for_test(origin, "injected load failure"));
                for _ in 0..ROSTER_UNREACHABLE_FAILURES {
                    let flow = roster_poll_tick(
                        app.handle(),
                        &state,
                        "gw-keychain",
                        origin,
                        UNUSED_ROSTER_URL,
                        &cancel,
                    )
                    .await;
                    assert!(flow.is_continue());
                }
                let rt = state
                    .gateway_manager
                    .state
                    .lock()
                    .unwrap()
                    .runtimes
                    .remove("gw-keychain")
                    .expect("the poll left the runtime in place");
                let case = format!(
                    "{status:?} pending={pending_signin} connect={fetch_in_flight} failing={failing}"
                );
                assert_eq!(rt.status, status, "{case}");
                assert_eq!(rt.pending_signin, pending_signin, "{case}");
                assert_eq!(rt.last_error, None, "{case}");
                assert_eq!(rt.consecutive_failures, 0, "{case}");
                assert!(!cancel.is_cancelled(), "{case}");
                assert_eq!(notice_rx.try_iter().count(), 0, "{case}");
            }
        }
    }

    /// A runtime no connect or sign-in is driving is the poll's, whatever its
    /// status reads: a connect whose first fetch failed leaves it Connecting
    /// with the poll as its only driver, and an expired sign-in leaves it
    /// Disconnected beside the poll an earlier connect started.
    #[tokio::test]
    async fn the_roster_poll_drives_a_runtime_no_attempt_owns() {
        let origin = "https://keychain-unowned.example.test";
        let (_dir, state) = pat_load_test_state(origin);
        let app = tauri::test::mock_app();
        let error = "reading gateway keychain: injected poll failure";
        let _failure = auth::fail_gateway_pat_load_for_test(origin, error);
        for status in [GatewayStatus::Connecting, GatewayStatus::Disconnected] {
            let cancel = install_polled_runtime(&state, origin, status, false);
            for _ in 0..ROSTER_UNREACHABLE_FAILURES {
                let flow = roster_poll_tick(
                    app.handle(),
                    &state,
                    "gw-keychain",
                    origin,
                    UNUSED_ROSTER_URL,
                    &cancel,
                )
                .await;
                assert!(flow.is_continue());
            }
            let view = state.gateway_manager.view("gw-keychain").unwrap();
            assert_eq!(
                (view.status, view.last_error.as_deref()),
                (GatewayStatus::Unreachable, Some(error)),
                "a {status:?} runtime no attempt owns"
            );
        }
    }

    /// A poll replaced while its PAT load was in flight applies nothing to
    /// the runtime its successor owns: neither a load failure nor a missing
    /// credential.
    #[tokio::test]
    async fn a_cancelled_poll_applies_no_pat_load_outcome() {
        use tauri::Listener;

        let origin = "https://keychain-cancelled.example.test";
        let (_dir, state) = pat_load_test_state(origin);
        let app = tauri::test::mock_app();
        let (notice_tx, notice_rx) = std::sync::mpsc::channel();
        app.listen(LAUNCHER_NOTICE, move |event| {
            notice_tx.send(event.payload().to_string()).unwrap();
        });
        for failing in [true, false] {
            let cancel = install_polled_runtime(&state, origin, GatewayStatus::Connected, false);
            cancel.cancel();
            let _absent = (!failing).then(|| auth::absent_gateway_pat_for_test(origin));
            let _failure =
                failing.then(|| auth::fail_gateway_pat_load_for_test(origin, "injected failure"));
            let flow = roster_poll_tick(
                app.handle(),
                &state,
                "gw-keychain",
                origin,
                UNUSED_ROSTER_URL,
                &cancel,
            )
            .await;
            let case = if failing {
                "a load failure"
            } else {
                "a missing PAT"
            };
            let rt = state
                .gateway_manager
                .state
                .lock()
                .unwrap()
                .runtimes
                .remove("gw-keychain");
            let rt = rt.unwrap_or_else(|| panic!("a cancelled poll signed out on {case}"));
            assert_eq!(
                (rt.status, rt.consecutive_failures, rt.last_error),
                (GatewayStatus::Connected, 0, None),
                "a cancelled poll applied {case}"
            );
            assert!(
                flow.is_break(),
                "a cancelled poll kept polling after {case}"
            );
            assert_eq!(notice_rx.try_iter().count(), 0, "{case}");
        }
    }

    /// A keychain that keeps failing warns once for the streak, not every
    /// round, and the first round that loads the PAT again logs one info
    /// line with how many rounds failed.
    #[tokio::test]
    async fn the_roster_poll_warns_once_per_pat_load_failure_streak() {
        let origin = "https://keychain-streak.example.test";
        let (_dir, state) = pat_load_test_state(origin);
        let app = tauri::test::mock_app();
        let lines = crate::devserver::log_capture::Lines::default();
        let _capture = lines.install();
        let cancel = install_polled_runtime(&state, origin, GatewayStatus::Connected, false);
        let tick = || {
            roster_poll_tick(
                app.handle(),
                &state,
                "gw-keychain",
                origin,
                UNUSED_ROSTER_URL,
                &cancel,
            )
        };
        let failure = auth::fail_gateway_pat_load_for_test(origin, "injected streak failure");
        for _ in 0..ROSTER_UNREACHABLE_FAILURES {
            assert!(tick().await.is_continue());
        }
        let warned = lines
            .warnings()
            .into_iter()
            .filter(|line| line.contains("could not load the gateway PAT"))
            .count();
        assert_eq!(
            warned,
            1,
            "a failing streak warns once: {:?}",
            lines.warnings()
        );

        drop(failure);
        auth::test_gateway_pats().lock().unwrap().insert(
            origin.into(),
            auth::StoredPat {
                id: "streak".into(),
                secret: "test-secret".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        );
        for _ in 0..2 {
            assert!(tick().await.is_continue());
        }
        auth::test_gateway_pats().lock().unwrap().remove(origin);
        let recovered: Vec<String> = lines
            .infos()
            .into_iter()
            .filter(|line| line.contains("loaded the gateway PAT again"))
            .collect();
        assert_eq!(
            recovered.len(),
            1,
            "the first round that loads the PAT again logs once: {recovered:?}"
        );
        assert!(
            recovered[0].contains(&format!("failed_rounds={ROSTER_UNREACHABLE_FAILURES}")),
            "the recovery line names the streak's length: {recovered:?}"
        );
    }

    /// The sign-in resume end to end: park -> callback -> roster
    /// fetched -> poll running.
    #[tokio::test]
    async fn resume_after_signin_fetches_roster_and_starts_poll() {
        let (origin, server) = spawn_gateway_stub(false).await;
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
                wireguard: None,
                wireguard_public_key: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_hosts: Vec::new(),
            });
            store.lock().unwrap().save(&cfg).unwrap();
        }
        let state = Arc::new(crate::AppState::with_store(store));
        let app = tauri::test::mock_app();
        let events = unlocked_auth_events(&app, &state, auth::AUTH_CHANGED);
        let attempt = begin_connect(&state, "gw-feedface")
            .unwrap()
            .unwrap()
            .attempt;

        // Park the runtime exactly the way the sign-in leg leaves it.
        {
            let mut rt = new_runtime(GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: origin.clone(),
                mobile_authorize_url: format!("{origin}/mobile/authorize"),
                mobile_entry_url: format!("{origin}/mobile/v1/devserver/entry"),
                mobile_roster_url: format!("{origin}/mobile/v1/devservers"),
                devserver_proxy_origin: "https://proxy.chan.app".into(),
                devserver_proxy_host_depth: 2,
                wireguard: None,
            });
            rt.pending_signin = true;
            let mut gateway_state = state.gateway_manager.state.lock().unwrap();
            let runtimes = &mut gateway_state.runtimes;
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
            Arc::clone(&attempt),
            auth::load_gateway_pat(&origin).unwrap().unwrap(),
        )
        .await;

        let (payload, unlocked) = events.try_recv().expect("resume must emit auth-changed");
        let status: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(status["is_signed_in"], true);
        assert_eq!(status["label"], "test");
        assert!(
            events.try_recv().is_err(),
            "resume emits auth-changed exactly once"
        );
        assert!(
            unlocked,
            "auth-changed must be emitted outside the gateway lock"
        );

        let view = state
            .gateway_manager
            .view("gw-feedface")
            .expect("runtime lives");
        assert!(
            !attempt.cancel.is_cancelled(),
            "resume continues its attempt without replacing it"
        );
        assert!(!view.pending_signin, "the park is cleared");
        assert_eq!(
            view.status,
            GatewayStatus::Connected,
            "the roster fetch ran (last_error: {:?})",
            view.last_error
        );
        assert_eq!(view.devserver_count, 1, "the stub roster row arrived");
        assert!(
            state.gateway_manager.state.lock().unwrap().runtimes["gw-feedface"]
                .poll_cancel
                .is_some(),
            "the roster poll is running"
        );
        server.abort();
    }
}
