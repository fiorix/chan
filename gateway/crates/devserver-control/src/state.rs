use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::time::Duration;

use chrono::{DateTime, Utc};
use devserver_control_proto::{
    AdmissionDecision, BrowserSessionRow, CanonicalOrigin, ProxyId, ServerFrame, SessionRevocation,
    TunnelRow, CONTROLLER_DISCONNECTED_AUTHORITY_RETENTION_SECONDS,
    MAX_BROWSER_SESSION_SNAPSHOT_BYTES, MAX_BROWSER_SESSION_SNAPSHOT_ROWS,
};
use serde::Serialize;
use tokio::time::Instant;
use uuid::Uuid;

#[cfg(test)]
std::thread_local! {
    static ROW_SIZE_SERIALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static TUNNEL_VIEW_MATERIALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
pub const SESSION_DEAD_AFTER: Duration = Duration::from_secs(15);
pub const CONVERGENCE_WINDOW: Duration = Duration::from_secs(30);
pub const DISCONNECTED_AUTHORITY_RETENTION: Duration =
    Duration::from_secs(CONTROLLER_DISCONNECTED_AUTHORITY_RETENTION_SECONDS);
pub const ADMISSION_CLAIM_TTL: Duration = Duration::from_secs(15);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTSTANDING_PINGS: usize = 8;
/// Per-session bound on remembered command-confirmed removals. An
/// authenticated proxy must not grow controller memory without bound;
/// past the bound the eventual down simply costs one resync.
const MAX_CONFIRMED_DOWNS: usize = 4096;

type TunnelKey = (Uuid, String);
type PendingIdentity = (SessionKey, Uuid, Uuid);
const MAX_PROXY_SESSIONS: usize = 128;
const MAX_PROXY_AUTHORITIES: usize = MAX_PROXY_SESSIONS * 2;
const MAX_ROWS_PER_SESSION: usize = devserver_control_proto::MAX_SNAPSHOT_ROWS;
const MAX_FLEET_ROWS: usize = 16_384;
const MAX_FLEET_RESIDENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_FLEET_BROWSER_SESSION_ROWS: usize = 500_000;
const MAX_FLEET_BROWSER_SESSION_BYTES: usize = 128 * 1024 * 1024;
const MAX_PENDING_PER_SESSION: usize = 1024;
const MAX_PENDING_FLEET: usize = 16_384;
const MAX_BOOT_HISTORY: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionIncarnation(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyStatus {
    Joining,
    Active,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProxyView {
    pub proxy_id: String,
    pub proxy_base_url: String,
    pub package_version: String,
    pub boot_id: Uuid,
    pub connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub tunnel_count: usize,
    pub status: ProxyStatus,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct TunnelView {
    pub registration_id: Uuid,
    pub owner_user_id: Uuid,
    pub user: String,
    pub devserver_id: String,
    pub max_connected_devservers: u32,
    pub peer_addr: Option<std::net::SocketAddr>,
    pub connected_at: DateTime<Utc>,
    pub proxy_id: String,
    pub proxy_base_url: String,
    /// Signed authority returned only on authenticated admin APIs so
    /// identity can independently re-verify the controller row.
    pub admission_lease: String,
    pub admission_lease_expires_at: DateTime<Utc>,
}

impl std::fmt::Debug for TunnelView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TunnelView")
            .field("registration_id", &self.registration_id)
            .field("owner_user_id", &self.owner_user_id)
            .field("user", &self.user)
            .field("devserver_id", &self.devserver_id)
            .field("max_connected_devservers", &self.max_connected_devservers)
            .field("has_peer_addr", &self.peer_addr.is_some())
            .field("connected_at", &self.connected_at)
            .field("proxy_id", &self.proxy_id)
            .field("proxy_base_url", &self.proxy_base_url)
            .field("admission_lease", &"[REDACTED]")
            .field(
                "admission_lease_expires_at",
                &self.admission_lease_expires_at,
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnedTunnel {
    session: SessionKey,
    proxy_base_url: String,
    row: TunnelRow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnedBrowserSession {
    session: SessionKey,
    row: BrowserSessionRow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrowserSessionView {
    pub id: Uuid,
    pub subject_user_id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub proxy_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct ProxySession {
    incarnation: SessionIncarnation,
    base_url: CanonicalOrigin,
    package_version: String,
    boot_id: Uuid,
    generation: Option<u64>,
    rows: HashMap<Uuid, TunnelRow>,
    resident_bytes: usize,
    browser_sessions: HashMap<Uuid, BrowserSessionRow>,
    browser_session_resident_bytes: usize,
    /// Registration ids whose removal the controller already applied from
    /// a confirmed kill command. The proxy still publishes its own
    /// contiguous `TunnelDown` for each confirmed eviction, and without
    /// this memory that expected down looks like corruption and forces a
    /// full resync that retracts every other row of the session.
    confirmed_downs: HashSet<Uuid>,
    status: ProxyStatus,
    fleet_ready: bool,
    connected_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    last_seen: Instant,
    last_ping: Instant,
    outstanding_pings: VecDeque<u64>,
}

#[derive(Debug, Clone)]
struct PendingClaim {
    session: SessionKey,
    request_id: Uuid,
    registration_id: Uuid,
    max_connected_devservers: u32,
    expires_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandPurpose {
    Reconciliation,
    Runtime,
}

#[derive(Debug)]
struct PendingCommand {
    session: SessionKey,
    registration_ids: HashSet<Uuid>,
    purpose: CommandPurpose,
    expires_at: Instant,
}

#[derive(Debug)]
struct PendingSessionRevocation {
    session: SessionKey,
    expires_at: Instant,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct FleetUsage {
    rows: usize,
    bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReconciliationKind {
    Initial,
    Joining(SessionKey),
}

#[derive(Debug)]
struct Reconciliation {
    kind: ReconciliationKind,
    command_ids: HashSet<Uuid>,
    failed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct SessionKey {
    pub(crate) proxy_id: String,
    pub(crate) incarnation: SessionIncarnation,
}

#[derive(Debug)]
pub(crate) enum Effect {
    Send {
        session: SessionKey,
        frame: ServerFrame,
    },
    Retire {
        session: SessionKey,
        reason: String,
    },
    CommandSettled {
        command_id: Uuid,
        outcome: CommandOutcome,
    },
}

/// Terminal state of a Runtime-purpose kill command. The state machine
/// cannot hold waiters, so it reports each settle through
/// `Effect::CommandSettled` and the actor resolves the oneshot it
/// registered when the command was issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandOutcome {
    /// Every targeted registration was reported killed or already missing.
    Confirmed {
        killed: usize,
        missing: usize,
    },
    /// The proxy reported a failure, or the result did not account for
    /// every targeted registration exactly once.
    Failed,
    TimedOut,
    /// The owning session ended before the command settled.
    SessionLost,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StateError {
    #[error("controller is not ready")]
    NotReady,
    #[error("proxy session is stale")]
    StaleSession,
    #[error("proxy session is not joining")]
    ProxyNotJoining,
    #[error("snapshot exceeds the row limit: {0}")]
    SnapshotTooLarge(usize),
    #[error("snapshot contains duplicate registration id {0}")]
    DuplicateRegistration(Uuid),
    #[error("browser-session snapshot exceeds the row limit: {0}")]
    BrowserSessionSnapshotTooLarge(usize),
    #[error("snapshot contains duplicate browser session id {0}")]
    DuplicateBrowserSession(Uuid),
    #[error("another reconciliation is in progress")]
    ReconciliationInProgress,
    #[error("pong nonce is not outstanding")]
    InvalidPong,
    #[error("proxy id already has a live session")]
    DuplicateProxyId,
    #[error("proxy session limit reached")]
    SessionLimit,
    #[error("controller fleet row capacity reached")]
    FleetCapacity,
    #[error("non-empty snapshot came from a different proxy boot")]
    BootIdMismatch,
    #[error("proxy boot history capacity reached")]
    BootHistoryCapacity,
    #[error("admission lease expired before controller mutation")]
    ExpiredAdmissionLease,
    #[error("browser session expired before controller mutation")]
    ExpiredBrowserSession,
    #[error("authoritative proxy is reconnecting")]
    AuthorityTemporarilyUnavailable,
}

pub(crate) struct ControllerState {
    max_devservers_per_user: usize,
    ready: bool,
    next_incarnation: u64,
    next_ping_nonce: u64,
    proxies: BTreeMap<String, ProxySession>,
    tunnels: HashMap<TunnelKey, OwnedTunnel>,
    browser_sessions: HashMap<Uuid, OwnedBrowserSession>,
    owner_occupancy: HashMap<Uuid, HashMap<String, usize>>,
    pending: HashMap<TunnelKey, PendingClaim>,
    pending_index: HashMap<PendingIdentity, TunnelKey>,
    pending_per_session: HashMap<SessionKey, usize>,
    commands: HashMap<Uuid, PendingCommand>,
    session_revocations: HashMap<Uuid, PendingSessionRevocation>,
    quarantined_restart_keys: HashSet<TunnelKey>,
    orphan_deadlines: HashMap<SessionKey, Instant>,
    disconnected_proxy_deadlines: HashMap<(String, Uuid), Instant>,
    orphan_usage: HashMap<SessionKey, FleetUsage>,
    orphan_total: FleetUsage,
    browser_orphan_usage: HashMap<SessionKey, FleetUsage>,
    browser_orphan_total: FleetUsage,
    boot_history: HashMap<String, Uuid>,
    reconciliation: Option<Reconciliation>,
    convergence_deadline: Option<Instant>,
}

impl ControllerState {
    pub fn new(max_devservers_per_user: usize) -> Self {
        Self {
            max_devservers_per_user,
            ready: false,
            next_incarnation: 1,
            next_ping_nonce: 1,
            proxies: BTreeMap::new(),
            tunnels: HashMap::new(),
            browser_sessions: HashMap::new(),
            owner_occupancy: HashMap::new(),
            pending: HashMap::new(),
            pending_index: HashMap::new(),
            pending_per_session: HashMap::new(),
            commands: HashMap::new(),
            session_revocations: HashMap::new(),
            quarantined_restart_keys: HashSet::new(),
            orphan_deadlines: HashMap::new(),
            disconnected_proxy_deadlines: HashMap::new(),
            orphan_usage: HashMap::new(),
            orphan_total: FleetUsage::default(),
            browser_orphan_usage: HashMap::new(),
            browser_orphan_total: FleetUsage::default(),
            boot_history: HashMap::new(),
            reconciliation: None,
            convergence_deadline: None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub(crate) fn watch_shape(&self) -> (bool, usize, usize, usize) {
        (
            self.ready,
            self.tunnels.len(),
            self.proxies.len(),
            self.browser_sessions.len(),
        )
    }

    pub fn begin_session_authorized(
        &mut self,
        proxy_id: ProxyId,
        base_url: CanonicalOrigin,
        package_version: String,
        boot_id: Uuid,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<(SessionIncarnation, Vec<Effect>), StateError> {
        if self.current_key(proxy_id.as_str()).is_some() {
            return Err(StateError::DuplicateProxyId);
        }
        if self.proxies.len() >= MAX_PROXY_SESSIONS {
            return Err(StateError::SessionLimit);
        }
        let authority = (proxy_id.as_str().to_string(), boot_id);
        let known_authorities = self.disconnected_proxy_deadlines.len()
            + self
                .proxies
                .iter()
                .filter(|(known_proxy_id, session)| {
                    !self
                        .disconnected_proxy_deadlines
                        .contains_key(&(known_proxy_id.to_string(), session.boot_id))
                })
                .count();
        if known_authorities >= MAX_PROXY_AUTHORITIES
            && !self.disconnected_proxy_deadlines.contains_key(&authority)
        {
            return Err(StateError::SessionLimit);
        }

        let incarnation = SessionIncarnation(self.next_incarnation);
        self.next_incarnation = self.next_incarnation.wrapping_add(1).max(1);
        self.proxies.insert(
            proxy_id.as_str().to_string(),
            ProxySession {
                incarnation,
                base_url,
                package_version,
                boot_id,
                generation: None,
                rows: HashMap::new(),
                resident_bytes: 0,
                browser_sessions: HashMap::new(),
                browser_session_resident_bytes: 0,
                confirmed_downs: HashSet::new(),
                status: ProxyStatus::Joining,
                fleet_ready: false,
                connected_at: wall_now,
                last_seen_at: wall_now,
                last_seen: now,
                last_ping: now,
                outstanding_pings: VecDeque::new(),
            },
        );
        Ok((incarnation, Vec::new()))
    }

    #[cfg(test)]
    pub fn begin_session(
        &mut self,
        proxy_id: ProxyId,
        base_url: CanonicalOrigin,
        package_version: String,
        boot_id: Uuid,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> (SessionIncarnation, Vec<Effect>) {
        self.begin_session_authorized(proxy_id, base_url, package_version, boot_id, now, wall_now)
            .expect("test session id is unique")
    }

    pub fn accept_snapshot(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        base_generation: u64,
        rows: Vec<TunnelRow>,
        browser_sessions: Vec<BrowserSessionRow>,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        if self.ready && self.reconciliation.is_some() {
            return Err(StateError::ReconciliationInProgress);
        }
        if rows.len() > MAX_ROWS_PER_SESSION {
            return Err(StateError::SnapshotTooLarge(rows.len()));
        }
        if browser_sessions.len() > MAX_BROWSER_SESSION_SNAPSHOT_ROWS {
            return Err(StateError::BrowserSessionSnapshotTooLarge(
                browser_sessions.len(),
            ));
        }
        let (retained_rows, retained_bytes) = self.fleet_usage(Some(proxy_id.as_str()));
        if retained_rows.saturating_add(rows.len()) > MAX_FLEET_ROWS {
            return Err(StateError::FleetCapacity);
        }
        let snapshot_bytes = rows.iter().try_fold(0_usize, |total, row| {
            row_resident_bytes(row).map(|bytes| total.saturating_add(bytes))
        })?;
        if retained_bytes.saturating_add(snapshot_bytes) > MAX_FLEET_RESIDENT_BYTES {
            return Err(StateError::FleetCapacity);
        }
        let (retained_browser_rows, retained_browser_bytes) =
            self.browser_session_usage(Some(proxy_id.as_str()));
        if retained_browser_rows.saturating_add(browser_sessions.len())
            > MAX_FLEET_BROWSER_SESSION_ROWS
        {
            return Err(StateError::FleetCapacity);
        }
        let browser_snapshot_bytes = browser_sessions.iter().try_fold(0_usize, |total, row| {
            browser_session_resident_bytes(row).map(|bytes| total.saturating_add(bytes))
        })?;
        if browser_snapshot_bytes > MAX_BROWSER_SESSION_SNAPSHOT_BYTES
            || retained_browser_bytes.saturating_add(browser_snapshot_bytes)
                > MAX_FLEET_BROWSER_SESSION_BYTES
        {
            return Err(StateError::FleetCapacity);
        }
        let mut by_id = HashMap::with_capacity(rows.len());
        for row in rows {
            if row.admission_lease_expires_at <= wall_now {
                return Err(StateError::ExpiredAdmissionLease);
            }
            let registration_id = row.registration_id;
            if by_id.insert(registration_id, row).is_some() {
                return Err(StateError::DuplicateRegistration(registration_id));
            }
        }
        let mut browser_by_id = HashMap::with_capacity(browser_sessions.len());
        for row in browser_sessions {
            if row.expires_at <= wall_now {
                return Err(StateError::ExpiredBrowserSession);
            }
            let admin_session_id = row.admin_session_id;
            if browser_by_id.insert(admin_session_id, row).is_some()
                || self.proxies.iter().any(|(known_proxy_id, session)| {
                    known_proxy_id != proxy_id.as_str()
                        && session.browser_sessions.contains_key(&admin_session_id)
                })
            {
                return Err(StateError::DuplicateBrowserSession(admin_session_id));
            }
        }

        let key = self.require_key(proxy_id, incarnation)?;
        let boot_id = self
            .proxies
            .get(proxy_id.as_str())
            .expect("key was validated")
            .boot_id;
        if self.ready
            && !by_id.is_empty()
            && self
                .boot_history
                .get(proxy_id.as_str())
                .is_some_and(|previous| *previous != boot_id)
        {
            tracing::error!(
                proxy_id = proxy_id.as_str(),
                %boot_id,
                "quarantined non-empty snapshot from a changed proxy boot"
            );
            return Err(StateError::BootIdMismatch);
        }
        if !self.boot_history.contains_key(proxy_id.as_str())
            && self.boot_history.len() >= MAX_BOOT_HISTORY
        {
            return Err(StateError::BootHistoryCapacity);
        }
        self.boot_history
            .insert(proxy_id.as_str().to_string(), boot_id);
        let session = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("key was validated");
        if session.status != ProxyStatus::Joining {
            return Err(StateError::ProxyNotJoining);
        }
        session.generation = Some(base_generation);
        session.rows = by_id;
        session.resident_bytes = snapshot_bytes;
        session.browser_sessions = browser_by_id;
        session.browser_session_resident_bytes = browser_snapshot_bytes;
        session.status = if self.ready {
            ProxyStatus::Joining
        } else {
            ProxyStatus::Active
        };
        session.last_seen = now;
        session.last_seen_at = wall_now;

        let mut effects = vec![Effect::Send {
            session: key.clone(),
            frame: ServerFrame::SnapshotAccepted { base_generation },
        }];
        if self.ready {
            effects.extend(self.reconcile_joining(key, now)?);
        } else if self.convergence_deadline.is_none() {
            self.convergence_deadline = Some(now + CONVERGENCE_WINDOW);
        }
        Ok(effects)
    }

    pub fn tunnel_up(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        row: TunnelRow,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        if row.admission_lease_expires_at <= wall_now {
            return Err(StateError::ExpiredAdmissionLease);
        }
        let key = self.require_key(proxy_id, incarnation)?;
        if let Some(effects) = self.advance_or_resync(&key, generation)? {
            return Ok(effects);
        }
        self.touch(&key, now, wall_now)?;
        let session_rows = self
            .proxies
            .get(proxy_id.as_str())
            .map_or(0, |session| session.rows.len());
        let (fleet_rows, fleet_bytes) = self.fleet_usage(None);
        if session_rows >= MAX_ROWS_PER_SESSION || fleet_rows >= MAX_FLEET_ROWS {
            return Err(StateError::FleetCapacity);
        }
        let row_bytes = row_resident_bytes(&row)?;
        if fleet_bytes.saturating_add(row_bytes) > MAX_FLEET_RESIDENT_BYTES {
            return Err(StateError::FleetCapacity);
        }
        if self
            .proxies
            .values()
            .any(|session| session.rows.contains_key(&row.registration_id))
        {
            return Ok(self.force_resync(&key, generation.saturating_add(1)));
        }

        let tunnel_key = (row.owner_user_id, row.devserver_id.clone());
        let matching_claim = self.pending.get(&tunnel_key).is_some_and(|claim| {
            claim.session == key && claim.registration_id == row.registration_id
        });
        if !matching_claim {
            let (_, effects) =
                self.issue_kill(key, vec![row.registration_id], CommandPurpose::Runtime, now);
            return Ok(effects);
        }
        self.remove_pending(&tunnel_key);

        let session = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("key was validated");
        session.resident_bytes = session.resident_bytes.saturating_add(row_bytes);
        session.rows.insert(row.registration_id, row.clone());

        let mut effects = Vec::new();
        let proxy_base_url = self
            .proxies
            .get(proxy_id.as_str())
            .expect("key was validated")
            .base_url
            .as_str()
            .to_string();
        let had_tunnel = self.tunnels.contains_key(&tunnel_key);
        if let Some(old) = self.tunnels.insert(
            tunnel_key.clone(),
            OwnedTunnel {
                session: key,
                proxy_base_url,
                row,
            },
        ) {
            if self
                .tunnels
                .values()
                .all(|current| current.row.registration_id != old.row.registration_id)
            {
                let (_, kill) = self.issue_kill(
                    old.session,
                    vec![old.row.registration_id],
                    CommandPurpose::Runtime,
                    now,
                );
                effects.extend(kill);
            }
        }
        if !had_tunnel {
            self.add_owner_key(&tunnel_key);
        }
        Ok(effects)
    }

    pub fn tunnel_down(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        registration_id: Uuid,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        if let Some(effects) = self.advance_or_resync(&key, generation)? {
            return Ok(effects);
        }
        self.touch(&key, now, wall_now)?;
        let known = self
            .proxies
            .get(proxy_id.as_str())
            .is_some_and(|session| session.rows.contains_key(&registration_id));
        if !known {
            let expected = self
                .proxies
                .get_mut(proxy_id.as_str())
                .expect("key was validated")
                .confirmed_downs
                .remove(&registration_id);
            if expected {
                return Ok(Vec::new());
            }
            return Ok(self.force_resync(&key, generation.saturating_add(1)));
        }
        self.remove_registration(&key, registration_id);
        Ok(Vec::new())
    }

    pub fn browser_session_up(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        row: BrowserSessionRow,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        if row.expires_at <= wall_now {
            return Err(StateError::ExpiredBrowserSession);
        }
        let key = self.require_key(proxy_id, incarnation)?;
        if let Some(effects) = self.advance_or_resync(&key, generation)? {
            return Ok(effects);
        }
        self.touch(&key, now, wall_now)?;
        let duplicate = self
            .proxies
            .values()
            .any(|session| session.browser_sessions.contains_key(&row.admin_session_id));
        if duplicate {
            return Ok(self.force_resync(&key, generation.saturating_add(1)));
        }
        let (fleet_rows, fleet_bytes) = self.browser_session_usage(None);
        let row_bytes = browser_session_resident_bytes(&row)?;
        let session = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("key was validated");
        if session.browser_sessions.len() >= MAX_BROWSER_SESSION_SNAPSHOT_ROWS
            || fleet_rows >= MAX_FLEET_BROWSER_SESSION_ROWS
            || session
                .browser_session_resident_bytes
                .saturating_add(row_bytes)
                > MAX_BROWSER_SESSION_SNAPSHOT_BYTES
            || fleet_bytes.saturating_add(row_bytes) > MAX_FLEET_BROWSER_SESSION_BYTES
        {
            return Err(StateError::FleetCapacity);
        }
        session.browser_session_resident_bytes = session
            .browser_session_resident_bytes
            .saturating_add(row_bytes);
        session
            .browser_sessions
            .insert(row.admin_session_id, row.clone());
        if session.status == ProxyStatus::Active && session.fleet_ready {
            self.browser_sessions.insert(
                row.admin_session_id,
                OwnedBrowserSession { session: key, row },
            );
        }
        Ok(Vec::new())
    }

    pub fn browser_session_down(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        admin_session_id: Uuid,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        if let Some(effects) = self.advance_or_resync(&key, generation)? {
            return Ok(effects);
        }
        self.touch(&key, now, wall_now)?;
        let row = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("key was validated")
            .browser_sessions
            .remove(&admin_session_id);
        let Some(row) = row else {
            return Ok(self.force_resync(&key, generation.saturating_add(1)));
        };
        let row_bytes = browser_session_resident_bytes(&row).unwrap_or(0);
        let session = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("key was validated");
        session.browser_session_resident_bytes = session
            .browser_session_resident_bytes
            .saturating_sub(row_bytes);
        let published = self
            .browser_sessions
            .get(&admin_session_id)
            .filter(|owned| owned.session == key)
            .is_some();
        if published {
            self.browser_sessions.remove(&admin_session_id);
        }
        Ok(Vec::new())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn request_admission_authorized(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        owner_user_id: Uuid,
        _user: String,
        devserver_id: String,
        max_connected_devservers: u32,
        _admission_lease: devserver_control_proto::AdmissionLease,
        admission_lease_expires_at: DateTime<Utc>,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        if admission_lease_expires_at <= wall_now {
            return Err(StateError::ExpiredAdmissionLease);
        }
        let session_key = self.require_key(proxy_id, incarnation)?;
        self.touch(&session_key, now, wall_now)?;
        let active = self
            .proxies
            .get(proxy_id.as_str())
            .is_some_and(|session| session.status == ProxyStatus::Active && session.fleet_ready);
        if !self.ready || !active {
            return Ok(vec![admission_effect(
                session_key,
                request_id,
                registration_id,
                AdmissionDecision::ControlWarming,
            )]);
        }

        let tunnel_key = (owner_user_id, devserver_id);
        if let Some(claim) = self.pending.get_mut(&tunnel_key).filter(|claim| {
            claim.session == session_key
                && claim.request_id == request_id
                && claim.registration_id == registration_id
        }) {
            claim.expires_at = now + ADMISSION_CLAIM_TTL;
            return Ok(vec![admission_effect(
                session_key,
                request_id,
                registration_id,
                AdmissionDecision::Admit,
            )]);
        }
        let reconnect =
            self.tunnels.contains_key(&tunnel_key) || self.pending.contains_key(&tunnel_key);
        let effective_limit = self.effective_owner_limit(owner_user_id, max_connected_devservers);
        if !reconnect && self.distinct_for_owner(owner_user_id) >= effective_limit {
            return Ok(vec![admission_effect(
                session_key,
                request_id,
                registration_id,
                AdmissionDecision::AtCapacity,
            )]);
        }

        let pending_for_session = self
            .pending_per_session
            .get(&session_key)
            .copied()
            .unwrap_or(0);
        if self.pending.len() >= MAX_PENDING_FLEET
            || pending_for_session >= MAX_PENDING_PER_SESSION
            || self.fleet_usage(None).0.saturating_add(self.pending.len()) >= MAX_FLEET_ROWS
        {
            return Ok(vec![admission_effect(
                session_key,
                request_id,
                registration_id,
                AdmissionDecision::AtCapacity,
            )]);
        }

        let mut effects = Vec::new();
        if let Some(old) = self.remove_pending(&tunnel_key) {
            effects.push(admission_effect(
                old.session,
                old.request_id,
                old.registration_id,
                AdmissionDecision::Stale,
            ));
        }
        self.insert_pending(
            tunnel_key,
            PendingClaim {
                session: session_key.clone(),
                request_id,
                registration_id,
                max_connected_devservers,
                expires_at: now + ADMISSION_CLAIM_TTL,
            },
        );
        effects.push(admission_effect(
            session_key,
            request_id,
            registration_id,
            AdmissionDecision::Admit,
        ));
        Ok(effects)
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn request_admission(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        user: String,
        devserver_id: String,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        self.request_admission_authorized(
            proxy_id,
            incarnation,
            request_id,
            registration_id,
            legacy_owner_user_id(&user),
            user,
            devserver_id,
            u32::try_from(self.max_devservers_per_user.max(1)).unwrap_or(u32::MAX),
            devserver_control_proto::AdmissionLease::parse("test").expect("test lease"),
            wall_now + chrono::Duration::minutes(5),
            now,
            wall_now,
        )
    }

    pub fn cancel_admission(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<(), StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        self.touch(&key, now, wall_now)?;
        let identity = (key, request_id, registration_id);
        if let Some(tunnel_key) = self.pending_index.get(&identity).cloned() {
            self.remove_pending(&tunnel_key);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn refresh_lease(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        max_connected_devservers: u32,
        admission_lease: devserver_control_proto::AdmissionLease,
        admission_lease_expires_at: DateTime<Utc>,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        if admission_lease_expires_at <= wall_now {
            return Err(StateError::ExpiredAdmissionLease);
        }
        let session_key = self.require_key(proxy_id, incarnation)?;
        self.touch(&session_key, now, wall_now)?;
        let old = self
            .proxies
            .get(proxy_id.as_str())
            .and_then(|session| session.rows.get(&registration_id))
            .cloned()
            .ok_or(StateError::StaleSession)?;
        if old.owner_user_id != owner_user_id
            || old.user != user
            || old.devserver_id != devserver_id
        {
            return Err(StateError::StaleSession);
        }
        let old_bytes = row_resident_bytes(&old).unwrap_or(0);
        let mut refreshed = old;
        refreshed.max_connected_devservers = max_connected_devservers;
        refreshed.admission_lease = admission_lease;
        refreshed.admission_lease_expires_at = admission_lease_expires_at;
        let refreshed_bytes = row_resident_bytes(&refreshed)?;
        let fleet_bytes = self.fleet_usage(None).1;
        if fleet_bytes
            .saturating_sub(old_bytes)
            .saturating_add(refreshed_bytes)
            > MAX_FLEET_RESIDENT_BYTES
        {
            return Err(StateError::FleetCapacity);
        }
        let session = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("session key was validated");
        session.resident_bytes = session
            .resident_bytes
            .saturating_sub(old_bytes)
            .saturating_add(refreshed_bytes);
        session.rows.insert(registration_id, refreshed.clone());
        if let Some(owned) = self
            .tunnels
            .get_mut(&(owner_user_id, devserver_id))
            .filter(|owned| {
                owned.session == session_key && owned.row.registration_id == registration_id
            })
        {
            owned.row = refreshed;
        }
        Ok(Vec::new())
    }

    pub fn record_activity(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<(), StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        self.touch(&key, now, wall_now)
    }

    pub fn pong(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        nonce: u64,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<(), StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        let session = self
            .proxies
            .get_mut(proxy_id.as_str())
            .expect("key was validated");
        let Some(position) = session
            .outstanding_pings
            .iter()
            .position(|candidate| *candidate == nonce)
        else {
            return Err(StateError::InvalidPong);
        };
        session.outstanding_pings.remove(position);
        self.touch(&key, now, wall_now)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn command_result(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        command_id: Uuid,
        killed: Vec<Uuid>,
        missing: Vec<Uuid>,
        failed: Vec<Uuid>,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<Vec<Effect>, StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        self.touch(&key, now, wall_now)?;
        let Some(command) = self.commands.remove(&command_id) else {
            return Ok(Vec::new());
        };
        if command.session != key {
            self.commands.insert(command_id, command);
            return Err(StateError::StaleSession);
        }

        let reported: HashSet<Uuid> = killed
            .iter()
            .chain(&missing)
            .chain(&failed)
            .copied()
            .collect();
        let report_len = killed.len() + missing.len() + failed.len();
        let invalid = reported.len() != report_len
            || reported
                .iter()
                .any(|registration_id| !command.registration_ids.contains(registration_id));
        let incomplete = command
            .registration_ids
            .iter()
            .any(|registration_id| !reported.contains(registration_id));
        for registration_id in killed.iter().chain(&missing).copied() {
            if command.registration_ids.contains(&registration_id) {
                self.remove_registration(&key, registration_id);
            }
        }
        // The proxy publishes its own contiguous TunnelDown for every
        // eviction it confirms; remember the confirmed ids so that
        // expected down is accepted instead of forcing a resync that
        // would retract the session's other rows. `missing` rows never
        // produce a down, so they are not remembered.
        if let Some(session) = self.proxies.get_mut(&key.proxy_id) {
            for registration_id in &killed {
                if command.registration_ids.contains(registration_id)
                    && session.confirmed_downs.len() < MAX_CONFIRMED_DOWNS
                {
                    session.confirmed_downs.insert(*registration_id);
                }
            }
        }

        if command.purpose == CommandPurpose::Reconciliation {
            if let Some(reconciliation) = self.reconciliation.as_mut() {
                reconciliation.command_ids.remove(&command_id);
                reconciliation.failed |= invalid || incomplete || !failed.is_empty();
            }
            return Ok(self.finish_reconciliation_if_complete(now));
        }
        let outcome = if invalid || incomplete || !failed.is_empty() {
            CommandOutcome::Failed
        } else {
            CommandOutcome::Confirmed {
                killed: killed.len(),
                missing: missing.len(),
            }
        };
        Ok(vec![Effect::CommandSettled {
            command_id,
            outcome,
        }])
    }

    pub fn begin_session_revocation(
        &mut self,
        revocation: SessionRevocation,
        now: Instant,
    ) -> Result<(Vec<Uuid>, Vec<Effect>, usize, bool), StateError> {
        revocation
            .validate()
            .map_err(|_| StateError::AuthorityTemporarilyUnavailable)?;
        let sessions: Vec<_> = self
            .proxies
            .iter()
            .map(|(proxy_id, session)| SessionKey {
                proxy_id: proxy_id.clone(),
                incarnation: session.incarnation,
            })
            .collect();
        let mut command_ids = Vec::with_capacity(sessions.len());
        let mut effects = Vec::with_capacity(sessions.len());
        for session in sessions {
            let command_id = Uuid::new_v4();
            self.session_revocations.insert(
                command_id,
                PendingSessionRevocation {
                    session: session.clone(),
                    expires_at: now + COMMAND_TIMEOUT,
                },
            );
            command_ids.push(command_id);
            effects.push(Effect::Send {
                session,
                frame: ServerFrame::RevokeSessions {
                    command_id,
                    revocation: revocation.clone(),
                },
            });
        }
        let unreachable_proxies = self
            .disconnected_proxy_deadlines
            .keys()
            .filter(|(proxy_id, boot_id)| {
                self.proxies
                    .get(proxy_id)
                    .is_none_or(|session| session.boot_id != *boot_id)
            })
            .count();
        Ok((command_ids, effects, unreachable_proxies, self.ready))
    }

    pub fn session_revocation_result(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        command_id: Uuid,
        revoked: usize,
    ) -> Result<Vec<Effect>, StateError> {
        if revoked > devserver_control_proto::MAX_SESSION_REVOCATION_COUNT {
            return Err(StateError::FleetCapacity);
        }
        let session = self.require_key(proxy_id, incarnation)?;
        let Some(pending) = self.session_revocations.remove(&command_id) else {
            return Ok(Vec::new());
        };
        if pending.session != session {
            self.session_revocations.insert(command_id, pending);
            return Err(StateError::StaleSession);
        }
        Ok(vec![Effect::CommandSettled {
            command_id,
            outcome: CommandOutcome::Confirmed {
                killed: revoked,
                missing: 0,
            },
        }])
    }

    pub fn disconnect(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
        now: Instant,
    ) -> Result<Vec<Effect>, StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        Ok(self.remove_session(&key, now))
    }

    pub fn require_resync(
        &mut self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
    ) -> Result<Vec<Effect>, StateError> {
        let key = self.require_key(proxy_id, incarnation)?;
        let expected_generation = self
            .proxies
            .get(proxy_id.as_str())
            .and_then(|session| session.generation)
            .map_or(0, |generation| generation.saturating_add(1));
        Ok(self.force_resync(&key, expected_generation))
    }

    pub fn tick(&mut self, now: Instant, wall_now: DateTime<Utc>) -> Vec<Effect> {
        let expired_pending: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(key, claim)| (claim.expires_at <= now).then_some(key.clone()))
            .collect();
        for key in expired_pending {
            self.remove_pending(&key);
        }

        let expired_orphans: Vec<_> = self
            .orphan_deadlines
            .iter()
            .filter_map(|(session, deadline)| (*deadline <= now).then_some(session.clone()))
            .collect();
        for session in expired_orphans {
            self.orphan_deadlines.remove(&session);
            self.remove_orphan_usage(&session);
            self.remove_browser_orphan_usage(&session);
            self.remove_tunnels_for_session(&session);
            self.remove_browser_sessions_for_session(&session);
        }
        self.disconnected_proxy_deadlines
            .retain(|_, deadline| *deadline > now);

        let mut effects = Vec::new();
        let expired_leases: Vec<_> = self
            .tunnels
            .values()
            .filter(|owned| owned.row.admission_lease_expires_at <= wall_now)
            .map(|owned| (owned.session.clone(), owned.row.registration_id))
            .collect();
        for (session, registration_id) in expired_leases {
            self.remove_registration(&session, registration_id);
            let (_, kill) =
                self.issue_kill(session, vec![registration_id], CommandPurpose::Runtime, now);
            effects.extend(kill);
        }
        let expired_commands: Vec<Uuid> = self
            .commands
            .iter()
            .filter_map(|(command_id, command)| (command.expires_at <= now).then_some(*command_id))
            .collect();
        let mut reconciliation_expired = false;
        for command_id in expired_commands {
            let Some(command) = self.commands.remove(&command_id) else {
                continue;
            };
            tracing::warn!(%command_id, session = %command.session.proxy_id, "controller command timed out");
            if command.purpose == CommandPurpose::Reconciliation {
                if let Some(reconciliation) = self.reconciliation.as_mut() {
                    reconciliation.command_ids.remove(&command_id);
                    reconciliation.failed = true;
                    reconciliation_expired = true;
                }
            } else {
                effects.push(Effect::CommandSettled {
                    command_id,
                    outcome: CommandOutcome::TimedOut,
                });
            }
        }
        if reconciliation_expired {
            effects.extend(self.finish_reconciliation_if_complete(now));
        }
        let expired_revocations: Vec<_> = self
            .session_revocations
            .iter()
            .filter_map(|(command_id, command)| (command.expires_at <= now).then_some(*command_id))
            .collect();
        for command_id in expired_revocations {
            self.session_revocations.remove(&command_id);
            effects.push(Effect::CommandSettled {
                command_id,
                outcome: CommandOutcome::TimedOut,
            });
        }

        let mut dead = Vec::new();
        for (proxy_id, session) in &mut self.proxies {
            if now.duration_since(session.last_seen) >= SESSION_DEAD_AFTER {
                tracing::warn!(proxy_id, "proxy control heartbeat expired");
                dead.push(SessionKey {
                    proxy_id: proxy_id.clone(),
                    incarnation: session.incarnation,
                });
                continue;
            }
            if now.duration_since(session.last_ping) >= HEARTBEAT_INTERVAL {
                session.last_ping = now;
                let nonce = self.next_ping_nonce;
                self.next_ping_nonce = self.next_ping_nonce.wrapping_add(1);
                session.outstanding_pings.push_back(nonce);
                while session.outstanding_pings.len() > MAX_OUTSTANDING_PINGS {
                    session.outstanding_pings.pop_front();
                }
                tracing::debug!(proxy_id, nonce, "sending proxy control heartbeat");
                effects.push(Effect::Send {
                    session: SessionKey {
                        proxy_id: proxy_id.clone(),
                        incarnation: session.incarnation,
                    },
                    frame: ServerFrame::Ping { nonce },
                });
            }
        }
        for key in dead {
            effects.extend(self.remove_session(&key, now));
            effects.push(Effect::Retire {
                session: key,
                reason: "proxy control heartbeat expired".to_string(),
            });
        }

        if !self.ready
            && self.reconciliation.is_none()
            && self
                .convergence_deadline
                .is_some_and(|deadline| deadline <= now)
        {
            effects.extend(self.begin_initial_reconciliation(now));
        }
        effects
    }

    pub fn tunnel_views(&self) -> Vec<TunnelView> {
        let mut out: Vec<_> = self.tunnels.values().map(tunnel_view).collect();
        out.sort_by(|a, b| {
            a.user
                .cmp(&b.user)
                .then_with(|| a.devserver_id.cmp(&b.devserver_id))
        });
        out
    }

    pub fn read_tunnels(&self) -> Result<Vec<TunnelView>, StateError> {
        self.ready
            .then(|| self.tunnel_views())
            .ok_or(StateError::NotReady)
    }

    pub fn browser_session_views(&self) -> Vec<BrowserSessionView> {
        let mut views: Vec<_> = self
            .browser_sessions
            .values()
            .map(|owned| BrowserSessionView {
                id: owned.row.admin_session_id,
                subject_user_id: owned.row.subject_user_id,
                owner_user_id: owned.row.owner_user_id,
                devserver_id: owned.row.devserver_id.clone(),
                proxy_id: owned.session.proxy_id.clone(),
                created_at: owned.row.created_at,
                expires_at: owned.row.expires_at,
            })
            .collect();
        views.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        views
    }

    pub fn read_browser_sessions(&self) -> Result<Vec<BrowserSessionView>, StateError> {
        self.ready
            .then(|| self.browser_session_views())
            .ok_or(StateError::NotReady)
    }

    pub fn owner_tunnel_views(&self, owner_user_id: Uuid) -> Vec<TunnelView> {
        let mut out: Vec<_> = self
            .owner_occupancy
            .get(&owner_user_id)
            .into_iter()
            .flat_map(HashMap::keys)
            .filter_map(|devserver_id| {
                self.tunnels
                    .get(&(owner_user_id, devserver_id.clone()))
                    .map(tunnel_view)
            })
            .collect();
        out.sort_by(|a, b| a.devserver_id.cmp(&b.devserver_id));
        out
    }

    pub fn read_owner_tunnels(&self, owner_user_id: Uuid) -> Result<Vec<TunnelView>, StateError> {
        self.ready
            .then(|| self.owner_tunnel_views(owner_user_id))
            .ok_or(StateError::NotReady)
    }

    pub fn proxy_views(&self) -> Vec<ProxyView> {
        self.proxies
            .iter()
            .map(|(proxy_id, session)| ProxyView {
                proxy_id: proxy_id.clone(),
                proxy_base_url: session.base_url.as_str().to_string(),
                package_version: session.package_version.clone(),
                boot_id: session.boot_id,
                connected_at: session.connected_at,
                last_seen_at: session.last_seen_at,
                tunnel_count: session.rows.len(),
                status: session.status,
            })
            .collect()
    }

    pub fn read_proxies(&self) -> Result<Vec<ProxyView>, StateError> {
        self.ready
            .then(|| self.proxy_views())
            .ok_or(StateError::NotReady)
    }

    /// Exact admin kill for one immutable `(owner_user_id, devserver_id)` key. The command
    /// targets the registration UUID read at issue time, never the key, so
    /// a delayed command cannot kill a successor registration. Returns the
    /// command id when a row was found so the actor can register a waiter
    /// before applying the send effect.
    pub fn begin_exact_kill(
        &mut self,
        owner_user_id: Uuid,
        devserver_id: &str,
        now: Instant,
    ) -> Result<(Option<Uuid>, Vec<Effect>), StateError> {
        if !self.ready {
            return Err(StateError::NotReady);
        }
        let Some(owned) = self.tunnels.get(&(owner_user_id, devserver_id.to_string())) else {
            return Ok((None, Vec::new()));
        };
        let session = owned.session.clone();
        let registration_id = owned.row.registration_id;
        if !self.owns_aggregate_rows(&session) {
            return Err(StateError::AuthorityTemporarilyUnavailable);
        }
        let (command_id, effects) =
            self.issue_kill(session, vec![registration_id], CommandPurpose::Runtime, now);
        Ok((Some(command_id), effects))
    }

    /// Owner-wide admin kill. Pending admission claims for the immutable owner are
    /// cancelled before any command is issued (fleet admission rule 7); a
    /// late `TunnelUp` for a cancelled claim arrives without a matching
    /// claim and is killed by the unclaimed-row path. Authoritative rows
    /// group by current owning session, one command per proxy. Returns the
    /// issued command ids so the actor can register waiters before
    /// applying the send effects.
    pub fn begin_owner_kill(
        &mut self,
        owner_user_id: Uuid,
        now: Instant,
    ) -> Result<(Vec<Uuid>, Vec<Effect>), StateError> {
        if !self.ready {
            return Err(StateError::NotReady);
        }
        if self.tunnels.values().any(|owned| {
            owned.row.owner_user_id == owner_user_id && !self.owns_aggregate_rows(&owned.session)
        }) {
            return Err(StateError::AuthorityTemporarilyUnavailable);
        }
        let owner_pending: Vec<_> = self
            .pending
            .keys()
            .filter(|(owner, _)| *owner == owner_user_id)
            .cloned()
            .collect();
        for key in owner_pending {
            self.remove_pending(&key);
        }

        let mut grouped: BTreeMap<SessionKey, Vec<Uuid>> = BTreeMap::new();
        for owned in self.tunnels.values() {
            if owned.row.owner_user_id == owner_user_id && self.owns_aggregate_rows(&owned.session)
            {
                grouped
                    .entry(owned.session.clone())
                    .or_default()
                    .push(owned.row.registration_id);
            }
        }
        let mut command_ids = Vec::new();
        let mut effects = Vec::new();
        for (session, registration_ids) in grouped {
            let (command_id, kill) =
                self.issue_kill(session, registration_ids, CommandPurpose::Runtime, now);
            command_ids.push(command_id);
            effects.extend(kill);
        }
        Ok((command_ids, effects))
    }

    pub fn begin_all_kill(&mut self, now: Instant) -> Result<(Vec<Uuid>, Vec<Effect>), StateError> {
        if !self.ready {
            return Err(StateError::NotReady);
        }
        if !self.disconnected_proxy_deadlines.is_empty()
            || self
                .proxies
                .values()
                .any(|proxy| proxy.status != ProxyStatus::Active || !proxy.fleet_ready)
            || self
                .tunnels
                .values()
                .any(|owned| !self.owns_aggregate_rows(&owned.session))
        {
            return Err(StateError::AuthorityTemporarilyUnavailable);
        }
        let pending: Vec<_> = self.pending.keys().cloned().collect();
        for key in pending {
            self.remove_pending(&key);
        }
        let mut grouped: BTreeMap<SessionKey, Vec<Uuid>> = BTreeMap::new();
        for owned in self.tunnels.values() {
            grouped
                .entry(owned.session.clone())
                .or_default()
                .push(owned.row.registration_id);
        }
        let mut command_ids = Vec::new();
        let mut effects = Vec::new();
        for (session, registration_ids) in grouped {
            let (command_id, kill) =
                self.issue_kill(session, registration_ids, CommandPurpose::Runtime, now);
            command_ids.push(command_id);
            effects.extend(kill);
        }
        Ok((command_ids, effects))
    }

    /// Aggregate rows are only ever published from Active sessions:
    /// `force_resync` and session removal retract a session's rows before
    /// its status can leave Active. A kill must route to a session that
    /// still owns the row, so a stale or Joining owner is treated as not
    /// found rather than commanding a session that no longer carries the
    /// registration.
    fn owns_aggregate_rows(&self, session: &SessionKey) -> bool {
        self.proxies.get(&session.proxy_id).is_some_and(|proxy| {
            proxy.incarnation == session.incarnation && proxy.status == ProxyStatus::Active
        })
    }

    fn require_key(
        &self,
        proxy_id: &ProxyId,
        incarnation: SessionIncarnation,
    ) -> Result<SessionKey, StateError> {
        self.proxies
            .get(proxy_id.as_str())
            .filter(|session| session.incarnation == incarnation)
            .map(|_| SessionKey {
                proxy_id: proxy_id.as_str().to_string(),
                incarnation,
            })
            .ok_or(StateError::StaleSession)
    }

    fn current_key(&self, proxy_id: &str) -> Option<SessionKey> {
        self.proxies.get(proxy_id).map(|session| SessionKey {
            proxy_id: proxy_id.to_string(),
            incarnation: session.incarnation,
        })
    }

    fn touch(
        &mut self,
        key: &SessionKey,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> Result<(), StateError> {
        let session = self
            .proxies
            .get_mut(&key.proxy_id)
            .filter(|session| session.incarnation == key.incarnation)
            .ok_or(StateError::StaleSession)?;
        session.last_seen = now;
        session.last_seen_at = wall_now;
        Ok(())
    }

    fn advance_or_resync(
        &mut self,
        key: &SessionKey,
        generation: u64,
    ) -> Result<Option<Vec<Effect>>, StateError> {
        let expected = self
            .proxies
            .get(&key.proxy_id)
            .filter(|session| session.incarnation == key.incarnation)
            .and_then(|session| session.generation)
            .map(|current| current + 1);
        let Some(expected) = expected else {
            return Err(StateError::StaleSession);
        };
        if generation != expected {
            return Ok(Some(self.force_resync(key, expected)));
        }
        self.proxies
            .get_mut(&key.proxy_id)
            .expect("key was validated")
            .generation = Some(generation);
        Ok(None)
    }

    fn force_resync(&mut self, key: &SessionKey, expected_generation: u64) -> Vec<Effect> {
        if let Some(session) = self.proxies.get_mut(&key.proxy_id) {
            session.status = ProxyStatus::Joining;
            session.fleet_ready = false;
            session.generation = None;
            session.rows.clear();
            session.resident_bytes = 0;
            session.browser_sessions.clear();
            session.browser_session_resident_bytes = 0;
            session.confirmed_downs.clear();
        }
        self.remove_tunnels_for_session(key);
        self.remove_browser_sessions_for_session(key);
        self.remove_pending_for_session(key);
        self.leave_readiness_if_no_active_sessions();
        vec![Effect::Send {
            session: key.clone(),
            frame: ServerFrame::ResyncRequired {
                expected_generation,
            },
        }]
    }

    fn begin_initial_reconciliation(&mut self, now: Instant) -> Vec<Effect> {
        if !self
            .proxies
            .values()
            .any(|session| session.status == ProxyStatus::Active)
        {
            self.convergence_deadline = None;
            return Vec::new();
        }
        let candidates: Vec<_> = self
            .proxies
            .iter()
            .flat_map(|(proxy_id, session)| {
                let key = SessionKey {
                    proxy_id: proxy_id.clone(),
                    incarnation: session.incarnation,
                };
                let proxy_base_url = session.base_url.as_str().to_string();
                session.rows.values().cloned().map(move |row| OwnedTunnel {
                    session: key.clone(),
                    proxy_base_url: proxy_base_url.clone(),
                    row,
                })
            })
            .collect();
        let mut counts = HashMap::new();
        for candidate in &candidates {
            *counts
                .entry((
                    candidate.row.owner_user_id,
                    candidate.row.devserver_id.clone(),
                ))
                .or_insert(0_usize) += 1;
        }
        self.quarantined_restart_keys
            .retain(|key| counts.contains_key(key));
        self.quarantined_restart_keys.extend(
            counts
                .into_iter()
                .filter_map(|(key, count)| (count > 1).then_some(key)),
        );
        let (desired, losers) = self.initial_reconciliation_plan(candidates);
        if losers.is_empty() {
            self.replace_tunnels(desired);
            self.ready = true;
            self.convergence_deadline = None;
            self.quarantined_restart_keys.clear();
            return self.mark_fleet_ready();
        }
        self.start_reconciliation(ReconciliationKind::Initial, losers, now)
    }

    fn reconcile_joining(
        &mut self,
        joining: SessionKey,
        now: Instant,
    ) -> Result<Vec<Effect>, StateError> {
        if self.reconciliation.is_some() {
            return Err(StateError::ReconciliationInProgress);
        }
        let session = self
            .proxies
            .get(&joining.proxy_id)
            .filter(|session| session.incarnation == joining.incarnation)
            .ok_or(StateError::StaleSession)?;
        let boot_id = session.boot_id;
        let rows = session.rows.values().cloned().collect();
        let (desired, losers) = self.joining_plan(&joining, rows);
        if losers.is_empty() {
            self.replace_tunnels(desired);
            if let Some(session) = self.proxies.get_mut(&joining.proxy_id) {
                session.status = ProxyStatus::Active;
                session.fleet_ready = true;
            }
            self.replace_browser_sessions();
            self.clear_orphans_for_proxy_authority(&joining.proxy_id, boot_id);
            return Ok(vec![Effect::Send {
                session: joining,
                frame: ServerFrame::FleetReady,
            }]);
        }
        Ok(self.start_reconciliation(ReconciliationKind::Joining(joining), losers, now))
    }

    /// Fail-closed initial restart reconciliation. Recency is unavailable
    /// while the fleet is reconstructed, so two signed rows for one
    /// immutable key are a conflict, not grounds to elect a winner from
    /// attacker-controlled proxy or registration identifiers.
    fn initial_reconciliation_plan(
        &self,
        candidates: impl IntoIterator<Item = OwnedTunnel>,
    ) -> (HashMap<TunnelKey, OwnedTunnel>, Vec<OwnedTunnel>) {
        let mut grouped: BTreeMap<TunnelKey, Vec<OwnedTunnel>> = BTreeMap::new();
        let mut signed_limits: HashMap<Uuid, usize> = HashMap::new();
        for candidate in candidates {
            let deployment_limit = if self.max_devservers_per_user == 0 {
                usize::MAX
            } else {
                self.max_devservers_per_user
            };
            signed_limits
                .entry(candidate.row.owner_user_id)
                .and_modify(|limit| {
                    *limit = (*limit).min(candidate.row.max_connected_devservers as usize)
                })
                .or_insert_with(|| {
                    deployment_limit.min(candidate.row.max_connected_devservers as usize)
                });
            grouped
                .entry((
                    candidate.row.owner_user_id,
                    candidate.row.devserver_id.clone(),
                ))
                .or_default()
                .push(candidate);
        }

        let mut desired = HashMap::new();
        let mut losers = Vec::new();
        for (key, mut rows) in grouped {
            if rows.len() != 1 || self.quarantined_restart_keys.contains(&key) {
                losers.extend(rows);
                continue;
            }
            rows.sort_by(|a, b| {
                a.session
                    .proxy_id
                    .cmp(&b.session.proxy_id)
                    .then_with(|| a.row.registration_id.cmp(&b.row.registration_id))
            });
            let winner = rows.remove(0);
            desired.insert(key, winner);
            losers.extend(rows);
        }

        let mut by_user: BTreeMap<Uuid, Vec<(TunnelKey, OwnedTunnel)>> = BTreeMap::new();
        for (key, owned) in &desired {
            by_user
                .entry(key.0)
                .or_default()
                .push((key.clone(), owned.clone()));
        }
        for (owner_user_id, rows) in &mut by_user {
            if let Some(limit) = signed_limits.get(owner_user_id).copied() {
                rows.sort_by(|(a_key, a), (b_key, b)| {
                    a_key
                        .1
                        .cmp(&b_key.1)
                        .then_with(|| a.session.proxy_id.cmp(&b.session.proxy_id))
                        .then_with(|| a.row.registration_id.cmp(&b.row.registration_id))
                });
                for (key, loser) in rows.iter().skip(limit) {
                    desired.remove(key);
                    losers.push(loser.clone());
                }
            }
        }

        let mut seen = HashSet::new();
        losers.retain(|owned| seen.insert(owned.row.registration_id));
        (desired, losers)
    }

    /// Live-first reconciliation for a routine joining snapshot. Every row
    /// the controller currently publishes is an immutable winner: those rows
    /// were admitted during this controller lifetime, so recency is
    /// available and a joining snapshot must never outrank it. Joining rows
    /// that duplicate a live key lose, each user's live rows are reserved
    /// against the capacity limit first, and only novel joining keys that
    /// fit the remaining slots are admitted. Competing rows inside one
    /// snapshot resolve by registration id, an ordering local to that
    /// snapshot; proxy id is never treated as recency on a routine join.
    fn joining_plan(
        &self,
        joining: &SessionKey,
        rows: Vec<TunnelRow>,
    ) -> (HashMap<TunnelKey, OwnedTunnel>, Vec<OwnedTunnel>) {
        let mut desired = self.tunnels.clone();
        desired.retain(|_, owned| {
            owned.session.proxy_id != joining.proxy_id || self.owns_aggregate_rows(&owned.session)
        });
        // Pending claims reserve their key and their capacity slot the
        // same way live rows do: the claim is strictly earlier than the
        // joining snapshot, so recency favors it.
        let mut ids_per_user: HashMap<Uuid, HashSet<String>> = HashMap::new();
        let mut limits_per_user: HashMap<Uuid, usize> = HashMap::new();
        for (user, devserver_id) in desired.keys().chain(self.pending.keys()) {
            ids_per_user
                .entry(*user)
                .or_default()
                .insert(devserver_id.clone());
        }
        for ((owner, _), tunnel) in &desired {
            let deployment_limit = if self.max_devservers_per_user == 0 {
                usize::MAX
            } else {
                self.max_devservers_per_user
            };
            limits_per_user
                .entry(*owner)
                .and_modify(|limit| {
                    *limit = (*limit).min(tunnel.row.max_connected_devservers as usize)
                })
                .or_insert_with(|| {
                    deployment_limit.min(tunnel.row.max_connected_devservers as usize)
                });
        }
        for ((owner, _), claim) in &self.pending {
            let deployment_limit = if self.max_devservers_per_user == 0 {
                usize::MAX
            } else {
                self.max_devservers_per_user
            };
            limits_per_user
                .entry(*owner)
                .and_modify(|limit| *limit = (*limit).min(claim.max_connected_devservers as usize))
                .or_insert_with(|| deployment_limit.min(claim.max_connected_devservers as usize));
        }

        let mut grouped: BTreeMap<TunnelKey, Vec<TunnelRow>> = BTreeMap::new();
        for row in rows {
            let deployment_limit = if self.max_devservers_per_user == 0 {
                usize::MAX
            } else {
                self.max_devservers_per_user
            };
            limits_per_user
                .entry(row.owner_user_id)
                .and_modify(|limit| *limit = (*limit).min(row.max_connected_devservers as usize))
                .or_insert_with(|| deployment_limit.min(row.max_connected_devservers as usize));
            grouped
                .entry((row.owner_user_id, row.devserver_id.clone()))
                .or_default()
                .push(row);
        }

        let mut losers = Vec::new();
        for (key, mut rows) in grouped {
            rows.sort_by_key(|row| row.registration_id);
            let mut rows = rows.into_iter().map(|row| OwnedTunnel {
                session: joining.clone(),
                proxy_base_url: self
                    .proxies
                    .get(&joining.proxy_id)
                    .expect("joining session exists")
                    .base_url
                    .as_str()
                    .to_string(),
                row,
            });
            if rows.len() != 1 {
                losers.extend(rows);
                continue;
            }
            let live = ids_per_user.get(&key.0).map_or(0, |ids| ids.len());
            let occupied = desired.contains_key(&key) || self.pending.contains_key(&key);
            let over_capacity = limits_per_user
                .get(&key.0)
                .is_some_and(|limit| live >= *limit);
            if occupied || over_capacity {
                losers.extend(rows);
                continue;
            }
            let winner = rows.next().expect("grouped rows are non-empty");
            desired.insert(key.clone(), winner);
            ids_per_user.entry(key.0).or_default().insert(key.1.clone());
            losers.extend(rows);
        }
        (desired, losers)
    }

    fn start_reconciliation(
        &mut self,
        kind: ReconciliationKind,
        losers: Vec<OwnedTunnel>,
        now: Instant,
    ) -> Vec<Effect> {
        let mut grouped: BTreeMap<SessionKey, Vec<Uuid>> = BTreeMap::new();
        for loser in losers {
            grouped
                .entry(loser.session)
                .or_default()
                .push(loser.row.registration_id);
        }

        let mut command_ids = HashSet::new();
        let mut effects = Vec::new();
        for (session, registration_ids) in grouped {
            let (command_id, kill) = self.issue_kill(
                session,
                registration_ids,
                CommandPurpose::Reconciliation,
                now,
            );
            command_ids.insert(command_id);
            effects.extend(kill);
        }
        self.reconciliation = Some(Reconciliation {
            kind,
            command_ids,
            failed: false,
        });
        effects
    }

    fn finish_reconciliation_if_complete(&mut self, now: Instant) -> Vec<Effect> {
        if self
            .reconciliation
            .as_ref()
            .is_none_or(|reconciliation| !reconciliation.command_ids.is_empty())
        {
            return Vec::new();
        }
        let reconciliation = self.reconciliation.take().expect("checked above");
        if reconciliation.failed {
            return match reconciliation.kind {
                ReconciliationKind::Initial => {
                    self.convergence_deadline = Some(now + CONVERGENCE_WINDOW);
                    Vec::new()
                }
                ReconciliationKind::Joining(session) => {
                    let mut effects = self.remove_session(&session, now);
                    effects.push(Effect::Retire {
                        session,
                        reason: "joining snapshot reconciliation failed".to_string(),
                    });
                    effects
                }
            };
        }

        let (desired, losers) = match &reconciliation.kind {
            ReconciliationKind::Initial => {
                let candidates: Vec<OwnedTunnel> = self
                    .proxies
                    .iter()
                    .filter(|(_, session)| session.generation.is_some())
                    .flat_map(|(proxy_id, session)| {
                        let key = SessionKey {
                            proxy_id: proxy_id.clone(),
                            incarnation: session.incarnation,
                        };
                        let proxy_base_url = session.base_url.as_str().to_string();
                        session.rows.values().cloned().map(move |row| OwnedTunnel {
                            session: key.clone(),
                            proxy_base_url: proxy_base_url.clone(),
                            row,
                        })
                    })
                    .collect();
                self.initial_reconciliation_plan(candidates)
            }
            ReconciliationKind::Joining(joining) => {
                // Recompute from current actor state so live deltas that
                // landed while the kill commands were outstanding keep
                // their immutable-winner status.
                let rows = self
                    .proxies
                    .get(&joining.proxy_id)
                    .filter(|session| session.incarnation == joining.incarnation)
                    .map(|session| session.rows.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                self.joining_plan(joining, rows)
            }
        };
        if !losers.is_empty() {
            return self.start_reconciliation(reconciliation.kind, losers, now);
        }
        self.replace_tunnels(desired);
        match reconciliation.kind {
            ReconciliationKind::Initial => {
                self.ready = true;
                self.convergence_deadline = None;
                self.quarantined_restart_keys.clear();
                self.mark_fleet_ready()
            }
            ReconciliationKind::Joining(session) => {
                let Some(proxy) = self
                    .proxies
                    .get_mut(&session.proxy_id)
                    .filter(|proxy| proxy.incarnation == session.incarnation)
                else {
                    return Vec::new();
                };
                // A force-resync can clear the generation while kill
                // commands are outstanding; flipping Active here would
                // strand the incarnation, because a fresh snapshot
                // requires Joining and a delta requires a generation.
                // Leave the session Joining so its resync snapshot
                // re-drives the join.
                if proxy.generation.is_none() {
                    return Vec::new();
                }
                proxy.status = ProxyStatus::Active;
                proxy.fleet_ready = true;
                let boot_id = proxy.boot_id;
                self.replace_browser_sessions();
                self.clear_orphans_for_proxy_authority(&session.proxy_id, boot_id);
                vec![Effect::Send {
                    session,
                    frame: ServerFrame::FleetReady,
                }]
            }
        }
    }

    fn mark_fleet_ready(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        for (proxy_id, session) in &mut self.proxies {
            if session.status != ProxyStatus::Active {
                continue;
            }
            session.fleet_ready = true;
            effects.push(Effect::Send {
                session: SessionKey {
                    proxy_id: proxy_id.clone(),
                    incarnation: session.incarnation,
                },
                frame: ServerFrame::FleetReady,
            });
        }
        self.replace_browser_sessions();
        effects
    }

    fn issue_kill(
        &mut self,
        session: SessionKey,
        registration_ids: Vec<Uuid>,
        purpose: CommandPurpose,
        now: Instant,
    ) -> (Uuid, Vec<Effect>) {
        let command_id = Uuid::new_v4();
        self.commands.insert(
            command_id,
            PendingCommand {
                session: session.clone(),
                registration_ids: registration_ids.iter().copied().collect(),
                purpose,
                expires_at: now + COMMAND_TIMEOUT,
            },
        );
        (
            command_id,
            vec![Effect::Send {
                session,
                frame: ServerFrame::KillRegistrations {
                    command_id,
                    registration_ids,
                },
            }],
        )
    }

    fn remove_session(&mut self, key: &SessionKey, now: Instant) -> Vec<Effect> {
        let current = self
            .proxies
            .get(&key.proxy_id)
            .is_some_and(|session| session.incarnation == key.incarnation);
        if !current {
            return Vec::new();
        }
        let boot_id = self
            .proxies
            .get(&key.proxy_id)
            .expect("current key was checked")
            .boot_id;
        let browser_orphan_usage = self
            .proxies
            .get(&key.proxy_id)
            .map(|session| FleetUsage {
                rows: session.browser_sessions.len(),
                bytes: session.browser_session_resident_bytes,
            })
            .unwrap_or_default();
        self.proxies.remove(&key.proxy_id);
        let retain_until = now + DISCONNECTED_AUTHORITY_RETENTION;
        self.disconnected_proxy_deadlines
            .entry((key.proxy_id.clone(), boot_id))
            .and_modify(|deadline| *deadline = (*deadline).max(retain_until))
            .or_insert(retain_until);
        let orphan_usage = self
            .tunnels
            .values()
            .filter(|owned| owned.session == *key)
            .fold(FleetUsage::default(), |mut usage, owned| {
                usage.rows = usage.rows.saturating_add(1);
                usage.bytes = usage
                    .bytes
                    .saturating_add(row_resident_bytes(&owned.row).unwrap_or(0));
                usage
            });
        if orphan_usage.rows > 0 || browser_orphan_usage.rows > 0 {
            self.orphan_deadlines
                .insert(key.clone(), now + CONVERGENCE_WINDOW);
        }
        if orphan_usage.rows > 0 {
            self.remove_orphan_usage(key);
            self.orphan_total.rows = self.orphan_total.rows.saturating_add(orphan_usage.rows);
            self.orphan_total.bytes = self.orphan_total.bytes.saturating_add(orphan_usage.bytes);
            self.orphan_usage.insert(key.clone(), orphan_usage);
        }
        if browser_orphan_usage.rows > 0 {
            self.remove_browser_orphan_usage(key);
            self.browser_orphan_total.rows = self
                .browser_orphan_total
                .rows
                .saturating_add(browser_orphan_usage.rows);
            self.browser_orphan_total.bytes = self
                .browser_orphan_total
                .bytes
                .saturating_add(browser_orphan_usage.bytes);
            self.browser_orphan_usage
                .insert(key.clone(), browser_orphan_usage);
        }
        self.remove_pending_for_session(key);

        let removed_commands: Vec<Uuid> = self
            .commands
            .iter()
            .filter_map(|(command_id, command)| (command.session == *key).then_some(*command_id))
            .collect();
        let mut effects = Vec::new();
        for command_id in removed_commands {
            let Some(command) = self.commands.remove(&command_id) else {
                continue;
            };
            if command.purpose == CommandPurpose::Runtime {
                effects.push(Effect::CommandSettled {
                    command_id,
                    outcome: CommandOutcome::SessionLost,
                });
            }
            if let Some(reconciliation) = self.reconciliation.as_mut() {
                reconciliation.command_ids.remove(&command_id);
            }
        }
        let removed_revocations: Vec<_> = self
            .session_revocations
            .iter()
            .filter_map(|(command_id, command)| (command.session == *key).then_some(*command_id))
            .collect();
        for command_id in removed_revocations {
            self.session_revocations.remove(&command_id);
            effects.push(Effect::CommandSettled {
                command_id,
                outcome: CommandOutcome::SessionLost,
            });
        }
        effects.extend(self.finish_reconciliation_if_complete(now));
        self.leave_readiness_if_no_active_sessions();
        effects
    }

    fn leave_readiness_if_no_active_sessions(&mut self) {
        let any_active = self
            .proxies
            .values()
            .any(|session| session.status == ProxyStatus::Active);
        if !any_active {
            self.ready = false;
            self.convergence_deadline = None;
        }
    }

    fn remove_registration(&mut self, session: &SessionKey, registration_id: Uuid) {
        let mut removed_orphan_bytes = None;
        if let Some(proxy) = self.proxies.get_mut(&session.proxy_id) {
            if proxy.incarnation == session.incarnation {
                if let Some(row) = proxy.rows.remove(&registration_id) {
                    let bytes = row_resident_bytes(&row).unwrap_or(0);
                    proxy.resident_bytes = proxy.resident_bytes.saturating_sub(bytes);
                }
            }
        } else if let Some(owned) = self
            .tunnels
            .values()
            .find(|owned| owned.session == *session && owned.row.registration_id == registration_id)
        {
            removed_orphan_bytes = Some(row_resident_bytes(&owned.row).unwrap_or(0));
        }
        let removed_keys: Vec<_> = self
            .tunnels
            .iter()
            .filter_map(|(key, owned)| {
                (owned.session == *session && owned.row.registration_id == registration_id)
                    .then_some(key.clone())
            })
            .collect();
        for key in removed_keys {
            self.tunnels.remove(&key);
            self.remove_owner_key(&key);
        }
        if let Some(bytes) = removed_orphan_bytes {
            self.orphan_total.rows = self.orphan_total.rows.saturating_sub(1);
            self.orphan_total.bytes = self.orphan_total.bytes.saturating_sub(bytes);
            let remove_usage = self.orphan_usage.get_mut(session).is_some_and(|usage| {
                usage.rows = usage.rows.saturating_sub(1);
                usage.bytes = usage.bytes.saturating_sub(bytes);
                usage.rows == 0
            });
            if remove_usage {
                self.orphan_usage.remove(session);
                self.orphan_deadlines.remove(session);
            }
        }
    }

    fn distinct_for_owner(&self, owner_user_id: Uuid) -> usize {
        self.owner_occupancy
            .get(&owner_user_id)
            .map_or(0, HashMap::len)
    }

    fn effective_owner_limit(&self, owner_user_id: Uuid, candidate_limit: u32) -> usize {
        let deployment_limit = if self.max_devservers_per_user == 0 {
            usize::MAX
        } else {
            self.max_devservers_per_user
        };
        self.tunnels
            .iter()
            .filter_map(|((owner, _), tunnel)| {
                (*owner == owner_user_id).then_some(tunnel.row.max_connected_devservers as usize)
            })
            .chain(self.pending.iter().filter_map(|((owner, _), claim)| {
                (*owner == owner_user_id).then_some(claim.max_connected_devservers as usize)
            }))
            .chain(std::iter::once(candidate_limit as usize))
            .fold(deployment_limit, usize::min)
    }

    fn insert_pending(&mut self, tunnel_key: TunnelKey, claim: PendingClaim) {
        debug_assert!(!self.pending.contains_key(&tunnel_key));
        let identity = (
            claim.session.clone(),
            claim.request_id,
            claim.registration_id,
        );
        self.pending_index.insert(identity, tunnel_key.clone());
        self.add_owner_key(&tunnel_key);
        *self
            .pending_per_session
            .entry(claim.session.clone())
            .or_default() += 1;
        self.pending.insert(tunnel_key, claim);
    }

    fn remove_pending(&mut self, tunnel_key: &TunnelKey) -> Option<PendingClaim> {
        let claim = self.pending.remove(tunnel_key)?;
        self.remove_owner_key(tunnel_key);
        self.pending_index.remove(&(
            claim.session.clone(),
            claim.request_id,
            claim.registration_id,
        ));
        let remove_count = self
            .pending_per_session
            .get_mut(&claim.session)
            .is_some_and(|count| {
                *count = count.saturating_sub(1);
                *count == 0
            });
        if remove_count {
            self.pending_per_session.remove(&claim.session);
        }
        Some(claim)
    }

    fn remove_pending_for_session(&mut self, session: &SessionKey) {
        let keys: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(key, claim)| (claim.session == *session).then_some(key.clone()))
            .collect();
        for key in keys {
            self.remove_pending(&key);
        }
    }

    fn add_owner_key(&mut self, key: &TunnelKey) {
        *self
            .owner_occupancy
            .entry(key.0)
            .or_default()
            .entry(key.1.clone())
            .or_default() += 1;
    }

    fn remove_owner_key(&mut self, key: &TunnelKey) {
        let remove_owner = self.owner_occupancy.get_mut(&key.0).is_some_and(|keys| {
            let remove_key = keys.get_mut(&key.1).is_some_and(|references| {
                *references = references.saturating_sub(1);
                *references == 0
            });
            if remove_key {
                keys.remove(&key.1);
            }
            keys.is_empty()
        });
        if remove_owner {
            self.owner_occupancy.remove(&key.0);
        }
    }

    fn remove_tunnels_for_session(&mut self, session: &SessionKey) {
        let keys: Vec<_> = self
            .tunnels
            .iter()
            .filter_map(|(key, owned)| (owned.session == *session).then_some(key.clone()))
            .collect();
        for key in keys {
            self.tunnels.remove(&key);
            self.remove_owner_key(&key);
        }
    }

    fn replace_tunnels(&mut self, tunnels: HashMap<TunnelKey, OwnedTunnel>) {
        self.tunnels = tunnels;
        self.owner_occupancy.clear();
        let tunnel_keys: Vec<_> = self.tunnels.keys().cloned().collect();
        let pending_keys: Vec<_> = self.pending.keys().cloned().collect();
        for key in tunnel_keys.iter().chain(&pending_keys) {
            self.add_owner_key(key);
        }
    }

    fn remove_browser_sessions_for_session(&mut self, session: &SessionKey) {
        self.browser_sessions
            .retain(|_, owned| owned.session != *session);
    }

    fn replace_browser_sessions(&mut self) {
        self.browser_sessions
            .retain(|_, owned| self.browser_orphan_usage.contains_key(&owned.session));
        for (proxy_id, proxy) in &self.proxies {
            if proxy.status != ProxyStatus::Active || !proxy.fleet_ready {
                continue;
            }
            let session = SessionKey {
                proxy_id: proxy_id.clone(),
                incarnation: proxy.incarnation,
            };
            for row in proxy.browser_sessions.values() {
                self.browser_sessions.insert(
                    row.admin_session_id,
                    OwnedBrowserSession {
                        session: session.clone(),
                        row: row.clone(),
                    },
                );
            }
        }
    }

    fn clear_orphans_for_proxy_authority(&mut self, proxy_id: &str, boot_id: Uuid) {
        let sessions: HashSet<_> = self
            .orphan_usage
            .keys()
            .chain(self.browser_orphan_usage.keys())
            .chain(self.orphan_deadlines.keys())
            .filter(|session| session.proxy_id == proxy_id)
            .cloned()
            .collect();
        for session in sessions {
            self.remove_orphan_usage(&session);
            self.remove_browser_orphan_usage(&session);
            self.remove_browser_sessions_for_session(&session);
        }
        self.orphan_deadlines
            .retain(|session, _| session.proxy_id != proxy_id);
        self.disconnected_proxy_deadlines
            .remove(&(proxy_id.to_string(), boot_id));
    }

    fn remove_orphan_usage(&mut self, session: &SessionKey) {
        if let Some(usage) = self.orphan_usage.remove(session) {
            self.orphan_total.rows = self.orphan_total.rows.saturating_sub(usage.rows);
            self.orphan_total.bytes = self.orphan_total.bytes.saturating_sub(usage.bytes);
        }
    }

    fn remove_browser_orphan_usage(&mut self, session: &SessionKey) {
        if let Some(usage) = self.browser_orphan_usage.remove(session) {
            self.browser_orphan_total.rows =
                self.browser_orphan_total.rows.saturating_sub(usage.rows);
            self.browser_orphan_total.bytes =
                self.browser_orphan_total.bytes.saturating_sub(usage.bytes);
        }
    }

    /// Count and size active staged rows plus retained orphan authority using
    /// maintained per-session totals. This is O(session-count), not O(rows),
    /// so a lease refresh or admission cannot amplify into fleet-wide JSON
    /// serialization work.
    fn fleet_usage(&self, replacing_proxy_id: Option<&str>) -> (usize, usize) {
        let mut rows = 0_usize;
        let mut bytes = 0_usize;
        for (proxy_id, session) in &self.proxies {
            if replacing_proxy_id == Some(proxy_id.as_str()) {
                continue;
            }
            rows = rows.saturating_add(session.rows.len());
            bytes = bytes.saturating_add(session.resident_bytes);
        }
        if let Some(replacing_proxy_id) = replacing_proxy_id {
            for (session, usage) in &self.orphan_usage {
                if session.proxy_id == replacing_proxy_id {
                    continue;
                }
                rows = rows.saturating_add(usage.rows);
                bytes = bytes.saturating_add(usage.bytes);
            }
        } else {
            rows = rows.saturating_add(self.orphan_total.rows);
            bytes = bytes.saturating_add(self.orphan_total.bytes);
        }
        (rows, bytes)
    }

    fn browser_session_usage(&self, replacing_proxy_id: Option<&str>) -> (usize, usize) {
        let mut rows = 0_usize;
        let mut bytes = 0_usize;
        for (proxy_id, session) in &self.proxies {
            if replacing_proxy_id == Some(proxy_id.as_str()) {
                continue;
            }
            rows = rows.saturating_add(session.browser_sessions.len());
            bytes = bytes.saturating_add(session.browser_session_resident_bytes);
        }
        if let Some(replacing_proxy_id) = replacing_proxy_id {
            for (session, usage) in &self.browser_orphan_usage {
                if session.proxy_id == replacing_proxy_id {
                    continue;
                }
                rows = rows.saturating_add(usage.rows);
                bytes = bytes.saturating_add(usage.bytes);
            }
        } else {
            rows = rows.saturating_add(self.browser_orphan_total.rows);
            bytes = bytes.saturating_add(self.browser_orphan_total.bytes);
        }
        (rows, bytes)
    }
}

fn row_resident_bytes(row: &TunnelRow) -> Result<usize, StateError> {
    #[cfg(test)]
    ROW_SIZE_SERIALIZATIONS.with(|count| count.set(count.get().saturating_add(1)));
    serde_json::to_vec(row)
        .map(|serialized| serialized.len())
        .map_err(|_| StateError::FleetCapacity)
}

fn browser_session_resident_bytes(row: &BrowserSessionRow) -> Result<usize, StateError> {
    serde_json::to_vec(row)
        .map(|serialized| serialized.len())
        .map_err(|_| StateError::FleetCapacity)
}

fn tunnel_view(owned: &OwnedTunnel) -> TunnelView {
    #[cfg(test)]
    TUNNEL_VIEW_MATERIALIZATIONS.with(|count| count.set(count.get().saturating_add(1)));
    TunnelView {
        registration_id: owned.row.registration_id,
        owner_user_id: owned.row.owner_user_id,
        user: owned.row.user.clone(),
        devserver_id: owned.row.devserver_id.clone(),
        max_connected_devservers: owned.row.max_connected_devservers,
        peer_addr: owned.row.peer_addr,
        connected_at: owned.row.connected_at,
        proxy_id: owned.session.proxy_id.clone(),
        proxy_base_url: owned.proxy_base_url.clone(),
        admission_lease: owned.row.admission_lease.as_str().to_string(),
        admission_lease_expires_at: owned.row.admission_lease_expires_at,
    }
}

fn admission_effect(
    session: SessionKey,
    request_id: Uuid,
    registration_id: Uuid,
    decision: AdmissionDecision,
) -> Effect {
    Effect::Send {
        session,
        frame: ServerFrame::AdmissionDecision {
            request_id,
            registration_id,
            decision,
        },
    }
}

#[cfg(test)]
pub(crate) fn legacy_owner_user_id(user: &str) -> Uuid {
    let mut bytes = [0_u8; 16];
    for (index, byte) in user.bytes().enumerate() {
        bytes[index % bytes.len()] ^= byte;
    }
    bytes[15] |= 1;
    Uuid::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(id: &str) -> ProxyId {
        ProxyId::parse(id).unwrap()
    }

    fn origin(id: &str) -> CanonicalOrigin {
        CanonicalOrigin::parse(&format!("https://{id}.proxy.example.test")).unwrap()
    }

    fn row(user: &str, devserver: &str, registration_id: Uuid) -> TunnelRow {
        TunnelRow {
            registration_id,
            owner_user_id: legacy_owner_user_id(user),
            user: user.into(),
            devserver_id: devserver.into(),
            max_connected_devservers: 100,
            admission_lease: devserver_control_proto::AdmissionLease::parse("test").unwrap(),
            admission_lease_expires_at: Utc::now() + chrono::Duration::days(365),
            peer_addr: Some("203.0.113.9:4321".parse().unwrap()),
            connected_at: Utc::now(),
        }
    }

    fn browser_row(
        admin_session_id: Uuid,
        subject_user_id: Uuid,
        owner_user_id: Uuid,
        devserver_id: &str,
    ) -> BrowserSessionRow {
        let created_at = Utc::now();
        BrowserSessionRow {
            admin_session_id,
            subject_user_id,
            owner_user_id,
            devserver_id: devserver_id.to_string(),
            created_at,
            expires_at: created_at + chrono::Duration::hours(1),
        }
    }

    fn assert_owner_occupancy_invariant(state: &ControllerState) {
        let mut expected: HashMap<Uuid, HashMap<String, usize>> = HashMap::new();
        for (owner_user_id, devserver_id) in state.tunnels.keys().chain(state.pending.keys()) {
            *expected
                .entry(*owner_user_id)
                .or_default()
                .entry(devserver_id.clone())
                .or_default() += 1;
        }
        assert_eq!(state.owner_occupancy, expected);
    }

    fn begin(state: &mut ControllerState, id: &str, now: Instant) -> (ProxyId, SessionIncarnation) {
        let id = proxy(id);
        let (incarnation, _) = state.begin_session(
            id.clone(),
            origin(id.as_str()),
            env!("CARGO_PKG_VERSION").into(),
            Uuid::new_v4(),
            now,
            Utc::now(),
        );
        (id, incarnation)
    }

    fn snapshot(
        state: &mut ControllerState,
        id: &ProxyId,
        incarnation: SessionIncarnation,
        rows: Vec<TunnelRow>,
        now: Instant,
    ) -> Vec<Effect> {
        state
            .accept_snapshot(id, incarnation, 0, rows, Vec::new(), now, Utc::now())
            .unwrap()
    }

    fn ready_one(
        state: &mut ControllerState,
        id: &str,
        rows: Vec<TunnelRow>,
        now: Instant,
    ) -> (ProxyId, SessionIncarnation, Vec<Effect>) {
        let (id, incarnation) = begin(state, id, now);
        snapshot(state, &id, incarnation, rows, now);
        state
            .record_activity(&id, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
            .unwrap();
        let effects = state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        (id, incarnation, effects)
    }

    #[test]
    fn stale_incarnation_cannot_disconnect_replacement() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, old) = begin(&mut state, "p1", now);
        assert!(matches!(
            state.begin_session_authorized(
                id.clone(),
                origin("p1"),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
                now,
                Utc::now(),
            ),
            Err(StateError::DuplicateProxyId)
        ));
        state.disconnect(&id, old, now).unwrap();
        let (_, current) = begin(&mut state, "p1", now);
        assert_ne!(old, current);
        assert!(matches!(
            state.disconnect(&id, old, now),
            Err(StateError::StaleSession)
        ));
        assert_eq!(state.proxy_views().len(), 1);
        assert_eq!(state.proxy_views()[0].proxy_id, "p1");
    }

    #[test]
    fn disconnected_incumbent_stays_authoritative_until_verified_replacement_snapshot() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let incumbent_id = Uuid::from_u128(1);
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &p1,
            p1_incarnation,
            vec![row("alice", "one", incumbent_id)],
            now,
        );
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        snapshot(&mut state, &p2, p2_incarnation, Vec::new(), now);
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
                .unwrap();
        }
        state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        assert!(state.is_ready());
        let incumbent_boot = state.proxies.get("p1").unwrap().boot_id;

        state
            .disconnect(&p1, p1_incarnation, now + CONVERGENCE_WINDOW)
            .unwrap();
        assert!(
            state.is_ready(),
            "the other active proxy keeps fleet reads available"
        );
        assert_eq!(state.tunnel_views()[0].registration_id, incumbent_id);
        assert!(matches!(
            state.begin_exact_kill(
                legacy_owner_user_id("alice"),
                "one",
                now + CONVERGENCE_WINDOW,
            ),
            Err(StateError::AuthorityTemporarilyUnavailable)
        ));

        let (changed_boot, _) = state
            .begin_session_authorized(
                p1.clone(),
                origin("p1"),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
                now + CONVERGENCE_WINDOW + Duration::from_millis(500),
                Utc::now(),
            )
            .unwrap();
        assert!(matches!(
            state.accept_snapshot(
                &p1,
                changed_boot,
                0,
                vec![row("alice", "one", Uuid::new_v4())],
                Vec::new(),
                now + CONVERGENCE_WINDOW + Duration::from_millis(500),
                Utc::now(),
            ),
            Err(StateError::BootIdMismatch)
        ));
        state
            .disconnect(
                &p1,
                changed_boot,
                now + CONVERGENCE_WINDOW + Duration::from_millis(500),
            )
            .unwrap();
        assert_eq!(state.tunnel_views()[0].registration_id, incumbent_id);

        let replacement = p1.clone();
        let (replacement_incarnation, _) = state
            .begin_session_authorized(
                replacement.clone(),
                origin("p1"),
                env!("CARGO_PKG_VERSION").into(),
                incumbent_boot,
                now + CONVERGENCE_WINDOW + Duration::from_secs(1),
                Utc::now(),
            )
            .unwrap();
        assert_eq!(state.tunnel_views()[0].registration_id, incumbent_id);
        let replacement_id = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &replacement,
            replacement_incarnation,
            vec![row("alice", "one", replacement_id)],
            now + CONVERGENCE_WINDOW + Duration::from_secs(1),
        );
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::FleetReady,
                ..
            }
        )));
        assert_eq!(state.tunnel_views()[0].registration_id, replacement_id);
    }

    #[test]
    fn disconnected_incumbent_expires_at_the_reconnect_deadline() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (p1, p1_incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", Uuid::new_v4())],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        state.disconnect(&p1, p1_incarnation, active_at).unwrap();
        assert_eq!(state.tunnel_views().len(), 1);
        assert!(matches!(
            state.begin_exact_kill(legacy_owner_user_id("alice"), "one", active_at),
            Err(StateError::NotReady | StateError::AuthorityTemporarilyUnavailable)
        ));

        state.tick(
            active_at + CONVERGENCE_WINDOW - Duration::from_millis(1),
            Utc::now(),
        );
        assert_eq!(state.tunnel_views().len(), 1);
        state.tick(active_at + CONVERGENCE_WINDOW, Utc::now());
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn orphaned_rows_count_toward_fleet_capacity_for_novel_joining_keys() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let owner_user_id = legacy_owner_user_id("alice");
        let orphan_session = SessionKey {
            proxy_id: "gone".into(),
            incarnation: SessionIncarnation(1),
        };
        let mut orphan_usage = FleetUsage::default();
        for index in 0..MAX_FLEET_ROWS {
            let registration_id = Uuid::from_u128(index as u128 + 1);
            let devserver_id = format!("orphan-{index}");
            let row = row("alice", &devserver_id, registration_id);
            orphan_usage.rows += 1;
            orphan_usage.bytes += row_resident_bytes(&row).unwrap();
            state.tunnels.insert(
                (owner_user_id, devserver_id.clone()),
                OwnedTunnel {
                    session: orphan_session.clone(),
                    proxy_base_url: "https://gone.proxy.example.test".into(),
                    row,
                },
            );
        }
        state.orphan_total = orphan_usage;
        state.orphan_usage.insert(orphan_session, orphan_usage);
        let (proxy_id, incarnation) = begin(&mut state, "p1", now);
        assert!(matches!(
            state.accept_snapshot(
                &proxy_id,
                incarnation,
                0,
                vec![row("bob", "novel", Uuid::new_v4())],
                Vec::new(),
                now,
                Utc::now(),
            ),
            Err(StateError::FleetCapacity)
        ));
        assert_eq!(state.tunnels.len(), MAX_FLEET_ROWS);
    }

    #[test]
    fn lease_refresh_work_does_not_scale_with_fleet_rows() {
        let now = Instant::now();
        let wall_now = Utc::now();
        let registration_id = Uuid::new_v4();
        let mut state = ControllerState::new(10_000);
        let (proxy_id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        let orphan_session = SessionKey {
            proxy_id: "gone".into(),
            incarnation: SessionIncarnation(1),
        };
        let mut usage = FleetUsage::default();
        for index in 0..4_096 {
            let devserver_id = format!("orphan-{index}");
            let row = row("orphan", &devserver_id, Uuid::new_v4());
            usage.rows += 1;
            usage.bytes += row_resident_bytes(&row).unwrap();
            let tunnel_key = (row.owner_user_id, devserver_id);
            state.tunnels.insert(
                tunnel_key.clone(),
                OwnedTunnel {
                    session: orphan_session.clone(),
                    proxy_base_url: "https://gone.proxy.example.test".into(),
                    row,
                },
            );
            state.add_owner_key(&tunnel_key);
        }
        state.orphan_total = usage;
        state.orphan_usage.insert(orphan_session, usage);

        ROW_SIZE_SERIALIZATIONS.with(|count| count.set(0));
        state
            .refresh_lease(
                &proxy_id,
                incarnation,
                registration_id,
                legacy_owner_user_id("alice"),
                "alice".into(),
                "one".into(),
                100,
                devserver_control_proto::AdmissionLease::parse("refreshed").unwrap(),
                wall_now + chrono::Duration::seconds(120),
                now + CONVERGENCE_WINDOW,
                wall_now,
            )
            .unwrap();
        assert_eq!(
            ROW_SIZE_SERIALIZATIONS.with(std::cell::Cell::get),
            2,
            "refresh must size only the old and replacement row"
        );

        let reconnect_registration = Uuid::new_v4();
        ROW_SIZE_SERIALIZATIONS.with(|count| count.set(0));
        for _ in 0..256 {
            let effects = state
                .request_admission_authorized(
                    &proxy_id,
                    incarnation,
                    Uuid::new_v4(),
                    reconnect_registration,
                    legacy_owner_user_id("alice"),
                    "alice".into(),
                    "one".into(),
                    10_000,
                    devserver_control_proto::AdmissionLease::parse("lease").unwrap(),
                    wall_now + chrono::Duration::seconds(120),
                    now + CONVERGENCE_WINDOW,
                    wall_now,
                )
                .unwrap();
            assert!(has_decision(&effects, AdmissionDecision::Admit));
        }
        assert_eq!(state.pending.len(), 1);
        assert_eq!(state.pending_index.len(), 1);
        assert_eq!(
            state.pending_per_session.values().copied().sum::<usize>(),
            1
        );
        assert_eq!(
            ROW_SIZE_SERIALIZATIONS.with(std::cell::Cell::get),
            0,
            "same-key admission churn must not rescan or serialize fleet rows"
        );

        let novel_owner = Uuid::new_v4();
        for index in 0..256 {
            let effects = state
                .request_admission_authorized(
                    &proxy_id,
                    incarnation,
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    novel_owner,
                    "novel-owner".into(),
                    format!("novel-{index}"),
                    10_000,
                    devserver_control_proto::AdmissionLease::parse("lease").unwrap(),
                    wall_now + chrono::Duration::seconds(120),
                    now + CONVERGENCE_WINDOW,
                    wall_now,
                )
                .unwrap();
            assert!(has_decision(&effects, AdmissionDecision::Admit));
        }
        assert_eq!(state.distinct_for_owner(novel_owner), 256);
        assert_eq!(
            ROW_SIZE_SERIALIZATIONS.with(std::cell::Cell::get),
            0,
            "novel admission accounting must not serialize fleet rows"
        );
        assert_owner_occupancy_invariant(&state);
    }

    #[test]
    fn owner_tunnel_read_materializes_only_that_owners_rows() {
        let now = Instant::now();
        let target_registration = Uuid::new_v4();
        let mut state = ControllerState::new(10_000);
        let (proxy_id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("target", "mine", target_registration)],
            now,
        );
        let unrelated_owner = legacy_owner_user_id("unrelated");
        let session = SessionKey {
            proxy_id: proxy_id.as_str().to_string(),
            incarnation,
        };
        for index in 0..8_192_u128 {
            let devserver_id = format!("unrelated-{index}");
            let unrelated = row("unrelated", &devserver_id, Uuid::from_u128(index + 1));
            let key = (unrelated_owner, devserver_id);
            state.tunnels.insert(
                key.clone(),
                OwnedTunnel {
                    session: session.clone(),
                    proxy_base_url: "https://p1.proxy.example.test".into(),
                    row: unrelated,
                },
            );
            state.add_owner_key(&key);
        }

        TUNNEL_VIEW_MATERIALIZATIONS.with(|count| count.set(0));
        let views = state
            .read_owner_tunnels(legacy_owner_user_id("target"))
            .unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].registration_id, target_registration);
        assert_eq!(
            TUNNEL_VIEW_MATERIALIZATIONS.with(std::cell::Cell::get),
            1,
            "unrelated fleet rows must not be cloned for an owner read"
        );
    }

    #[test]
    fn retired_incarnation_rejects_every_late_mutation() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, retired) = begin(&mut state, "p1", now);
        state.disconnect(&id, retired, now).unwrap();
        let (_, current) = begin(&mut state, "p1", now);

        assert!(matches!(
            state.tunnel_up(
                &id,
                retired,
                1,
                row("alice", "one", Uuid::new_v4()),
                now,
                Utc::now(),
            ),
            Err(StateError::StaleSession)
        ));
        assert!(matches!(
            state.record_activity(&id, retired, now, Utc::now()),
            Err(StateError::StaleSession)
        ));
        assert!(matches!(
            state.command_result(
                &id,
                retired,
                Uuid::new_v4(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                now,
                Utc::now(),
            ),
            Err(StateError::StaleSession)
        ));
        assert!(matches!(
            state.disconnect(&id, retired, now),
            Err(StateError::StaleSession)
        ));
        assert_eq!(state.current_key(id.as_str()).unwrap().incarnation, current);
    }

    #[test]
    fn readiness_waits_for_the_full_convergence_window() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, incarnation) = begin(&mut state, "p1", now);
        let effects = snapshot(&mut state, &id, incarnation, Vec::new(), now);
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::SnapshotAccepted { .. },
                ..
            }
        )));
        assert!(!state.is_ready());
        state
            .record_activity(
                &id,
                incarnation,
                now + CONVERGENCE_WINDOW - Duration::from_millis(1),
                Utc::now(),
            )
            .unwrap();
        state.tick(
            now + CONVERGENCE_WINDOW - Duration::from_millis(1),
            Utc::now(),
        );
        assert!(!state.is_ready());
        state
            .record_activity(&id, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
            .unwrap();
        let effects = state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        assert!(state.is_ready());
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::FleetReady,
                ..
            }
        )));
    }

    #[test]
    fn actor_mutation_rechecks_signed_lease_expiry_at_exact_boundary() {
        let now = Instant::now();
        let wall_now = Utc::now();

        let mut expired_state = ControllerState::new(100);
        let (expired_proxy, expired_incarnation) = begin(&mut expired_state, "p1", now);
        let mut expired = row("alice", "one", Uuid::new_v4());
        expired.admission_lease_expires_at = wall_now;
        assert!(matches!(
            expired_state.accept_snapshot(
                &expired_proxy,
                expired_incarnation,
                0,
                vec![expired],
                Vec::new(),
                now,
                wall_now,
            ),
            Err(StateError::ExpiredAdmissionLease)
        ));

        let mut live_state = ControllerState::new(100);
        let (live_proxy, live_incarnation) = begin(&mut live_state, "p1", now);
        let mut live = row("alice", "one", Uuid::new_v4());
        live.admission_lease_expires_at = wall_now + chrono::Duration::seconds(1);
        assert!(live_state
            .accept_snapshot(
                &live_proxy,
                live_incarnation,
                0,
                vec![live],
                Vec::new(),
                now,
                wall_now,
            )
            .is_ok());
    }

    #[test]
    fn signed_and_deployment_caps_serialize_the_exact_last_slot() {
        let now = Instant::now();
        let wall_now = Utc::now();
        let owner_user_id = Uuid::new_v4();
        let mut signed = ControllerState::new(10);
        let (proxy_id, incarnation, _) = ready_one(&mut signed, "p1", Vec::new(), now);

        for devserver_id in ["one", "two"] {
            let effects = signed
                .request_admission_authorized(
                    &proxy_id,
                    incarnation,
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    owner_user_id,
                    "alice".into(),
                    devserver_id.into(),
                    2,
                    devserver_control_proto::AdmissionLease::parse("lease").unwrap(),
                    wall_now + chrono::Duration::seconds(120),
                    now + CONVERGENCE_WINDOW,
                    wall_now,
                )
                .unwrap();
            assert!(has_decision(&effects, AdmissionDecision::Admit));
        }
        let over_signed_cap = signed
            .request_admission_authorized(
                &proxy_id,
                incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                owner_user_id,
                "alice".into(),
                "three".into(),
                10,
                devserver_control_proto::AdmissionLease::parse("lease").unwrap(),
                wall_now + chrono::Duration::seconds(120),
                now + CONVERGENCE_WINDOW,
                wall_now,
            )
            .unwrap();
        assert!(has_decision(
            &over_signed_cap,
            AdmissionDecision::AtCapacity
        ));

        let mut deployment = ControllerState::new(1);
        let (proxy_id, incarnation, _) = ready_one(&mut deployment, "p1", Vec::new(), now);
        for (devserver_id, expected) in [
            ("one", AdmissionDecision::Admit),
            ("two", AdmissionDecision::AtCapacity),
        ] {
            let effects = deployment
                .request_admission_authorized(
                    &proxy_id,
                    incarnation,
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    owner_user_id,
                    "alice".into(),
                    devserver_id.into(),
                    3,
                    devserver_control_proto::AdmissionLease::parse("lease").unwrap(),
                    wall_now + chrono::Duration::seconds(120),
                    now + CONVERGENCE_WINDOW,
                    wall_now,
                )
                .unwrap();
            assert!(has_decision(&effects, expected));
        }
    }

    #[test]
    fn initial_mixed_signed_caps_reconcile_to_the_minimum() {
        let now = Instant::now();
        let wall_now = Utc::now();
        let mut state = ControllerState::new(100);
        let (proxy_id, incarnation) = begin(&mut state, "p1", now);
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let mut first = row("alice", "one", first_id);
        first.max_connected_devservers = 1;
        let mut second = row("alice", "two", second_id);
        second.max_connected_devservers = 3;
        state
            .accept_snapshot(
                &proxy_id,
                incarnation,
                0,
                vec![first, second],
                Vec::new(),
                now,
                wall_now,
            )
            .unwrap();
        state
            .record_activity(&proxy_id, incarnation, now + CONVERGENCE_WINDOW, wall_now)
            .unwrap();
        let effects = state.tick(now + CONVERGENCE_WINDOW, wall_now);
        let (command_id, registration_ids) = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Send {
                    frame:
                        ServerFrame::KillRegistrations {
                            command_id,
                            registration_ids,
                        },
                    ..
                } => Some((*command_id, registration_ids.clone())),
                _ => None,
            })
            .expect("mixed-cap loser must be evicted");
        assert_eq!(registration_ids, vec![second_id]);
        state
            .command_result(
                &proxy_id,
                incarnation,
                command_id,
                registration_ids,
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                wall_now,
            )
            .unwrap();
        assert!(state.is_ready());
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].registration_id, first_id);
    }

    #[test]
    fn browser_snapshot_deltas_and_generation_gap_share_one_authority() {
        let now = Instant::now();
        let wall_now = Utc::now();
        let subject_user_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let mut state = ControllerState::new(100);
        let (proxy_id, incarnation) = begin(&mut state, "p1", now);
        state
            .accept_snapshot(
                &proxy_id,
                incarnation,
                0,
                Vec::new(),
                vec![browser_row(first_id, subject_user_id, owner_user_id, "one")],
                now,
                wall_now,
            )
            .unwrap();
        state
            .record_activity(&proxy_id, incarnation, now + CONVERGENCE_WINDOW, wall_now)
            .unwrap();
        state.tick(now + CONVERGENCE_WINDOW, wall_now);
        assert_eq!(state.read_browser_sessions().unwrap().len(), 1);

        state
            .browser_session_up(
                &proxy_id,
                incarnation,
                1,
                browser_row(second_id, subject_user_id, owner_user_id, "two"),
                now + CONVERGENCE_WINDOW,
                wall_now,
            )
            .unwrap();
        assert_eq!(state.read_browser_sessions().unwrap().len(), 2);
        state
            .browser_session_down(
                &proxy_id,
                incarnation,
                2,
                first_id,
                now + CONVERGENCE_WINDOW,
                wall_now,
            )
            .unwrap();
        assert_eq!(state.read_browser_sessions().unwrap()[0].id, second_id);

        let effects = state
            .browser_session_up(
                &proxy_id,
                incarnation,
                4,
                browser_row(Uuid::new_v4(), subject_user_id, owner_user_id, "three"),
                now + CONVERGENCE_WINDOW,
                wall_now,
            )
            .unwrap();
        assert!(has_resync(&effects, 3));
        assert!(state.browser_session_views().is_empty());
        assert!(!state.is_ready());
    }

    #[test]
    fn disconnected_browser_inventory_is_retained_until_grace_expires() {
        let now = Instant::now();
        let wall_now = Utc::now();
        let admin_session_id = Uuid::new_v4();
        let mut state = ControllerState::new(100);
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        state
            .accept_snapshot(
                &p1,
                p1_incarnation,
                0,
                Vec::new(),
                vec![browser_row(
                    admin_session_id,
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    "one",
                )],
                now,
                wall_now,
            )
            .unwrap();
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        snapshot(&mut state, &p2, p2_incarnation, Vec::new(), now);
        for (proxy_id, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy_id, incarnation, now + CONVERGENCE_WINDOW, wall_now)
                .unwrap();
        }
        state.tick(now + CONVERGENCE_WINDOW, wall_now);
        let disconnected_at = now + CONVERGENCE_WINDOW;
        state
            .disconnect(&p1, p1_incarnation, disconnected_at)
            .unwrap();
        assert_eq!(
            state.read_browser_sessions().unwrap()[0].id,
            admin_session_id
        );
        assert_eq!(state.browser_orphan_total.rows, 1);

        let before_expiry = disconnected_at + CONVERGENCE_WINDOW - Duration::from_millis(1);
        state
            .record_activity(&p2, p2_incarnation, before_expiry, wall_now)
            .unwrap();
        state.tick(before_expiry, wall_now);
        assert_eq!(state.read_browser_sessions().unwrap().len(), 1);

        let expiry = disconnected_at + CONVERGENCE_WINDOW;
        state
            .record_activity(&p2, p2_incarnation, expiry, wall_now)
            .unwrap();
        state.tick(expiry, wall_now);
        assert!(state.read_browser_sessions().unwrap().is_empty());
        assert_eq!(state.browser_orphan_total, FleetUsage::default());
    }

    #[test]
    fn tunnel_view_debug_redacts_admission_authority() {
        let sentinel = "lease-sentinel-must-never-appear";
        let view = TunnelView {
            registration_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            user: "alice".into(),
            devserver_id: "devserver".into(),
            max_connected_devservers: 3,
            peer_addr: None,
            connected_at: Utc::now(),
            proxy_id: "p1".into(),
            proxy_base_url: "https://p1.proxy.example.test".into(),
            admission_lease: sentinel.into(),
            admission_lease_expires_at: Utc::now() + chrono::Duration::seconds(120),
        };
        let debug = format!("{view:?}");
        assert!(debug.contains("REDACTED"));
        assert!(!debug.contains(sentinel));
        assert!(!debug.contains("203.0.113.9"));
    }

    #[test]
    fn session_revocation_fans_out_to_active_and_warming_proxies() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        let subject_user_id = Uuid::new_v4();
        let revocation = SessionRevocation::Subject { subject_user_id };
        let (command_ids, effects, unreachable, authority_ready) = state
            .begin_session_revocation(revocation.clone(), now)
            .unwrap();
        assert_eq!(command_ids.len(), 2);
        assert_eq!(effects.len(), 2);
        assert_eq!(unreachable, 0);
        assert!(!authority_ready);
        for proxy_id in ["p1", "p2"] {
            assert!(effects.iter().any(|effect| matches!(
                effect,
                Effect::Send {
                    session,
                    frame: ServerFrame::RevokeSessions {
                        revocation: sent,
                        ..
                    },
                } if session.proxy_id == proxy_id && sent == &revocation
            )));
        }

        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            let command_id = effects
                .iter()
                .find_map(|effect| match effect {
                    Effect::Send {
                        session,
                        frame: ServerFrame::RevokeSessions { command_id, .. },
                    } if session.proxy_id == proxy.as_str() => Some(*command_id),
                    _ => None,
                })
                .unwrap();
            let settled = state
                .session_revocation_result(proxy, incarnation, command_id, 3)
                .unwrap();
            assert!(matches!(
                settled.as_slice(),
                [Effect::CommandSettled {
                    outcome: CommandOutcome::Confirmed {
                        killed: 3,
                        missing: 0,
                    },
                    ..
                }]
            ));
        }
        assert!(state.session_revocations.is_empty());
    }

    #[test]
    fn session_revocation_retains_double_disconnected_authority_past_proxy_deadline() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (p1, p1_incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", Uuid::new_v4())],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let (p3, p3_incarnation) = begin(&mut state, "p3", active_at);
        let p3_effects = snapshot(
            &mut state,
            &p3,
            p3_incarnation,
            vec![row("carol", "three", Uuid::new_v4())],
            active_at,
        );
        assert!(p3_effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::FleetReady,
                ..
            }
        )));

        let p2 = proxy("p2");
        let p2_boot = Uuid::new_v4();
        let (first_incarnation, _) = state
            .begin_session_authorized(
                p2.clone(),
                origin("p2"),
                env!("CARGO_PKG_VERSION").into(),
                p2_boot,
                active_at,
                Utc::now(),
            )
            .unwrap();
        snapshot(
            &mut state,
            &p2,
            first_incarnation,
            vec![row("bob", "two", Uuid::new_v4())],
            active_at,
        );
        let first_disconnect = active_at + Duration::from_secs(1);
        state
            .disconnect(&p2, first_incarnation, first_disconnect)
            .unwrap();

        // Reconnect just inside the proxy's normal 30-second grace. Snapshot
        // acceptance arms a fresh 45-second convergence deadline, then a
        // duplicate row keeps this incarnation from reaching FleetReady.
        let reconnect_at = first_disconnect
            + Duration::from_secs(devserver_control_proto::PROXY_CONTROL_LOSS_GRACE_SECONDS - 1);
        let (second_incarnation, _) = state
            .begin_session_authorized(
                p2.clone(),
                origin("p2"),
                env!("CARGO_PKG_VERSION").into(),
                p2_boot,
                reconnect_at,
                Utc::now(),
            )
            .unwrap();
        let warming_effects = snapshot(
            &mut state,
            &p2,
            second_incarnation,
            vec![
                row("bob", "two", Uuid::new_v4()),
                row("alice", "one", Uuid::new_v4()),
            ],
            reconnect_at,
        );
        assert!(warming_effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::SnapshotAccepted { .. },
                ..
            }
        )));
        assert!(warming_effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::KillRegistrations { .. },
                ..
            }
        )));
        assert!(!warming_effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::FleetReady,
                ..
            }
        )));

        let second_disconnect = reconnect_at + Duration::from_secs(1);
        state
            .disconnect(&p2, second_incarnation, second_disconnect)
            .unwrap();

        let revocation = SessionRevocation::Subject {
            subject_user_id: Uuid::new_v4(),
        };
        let (command_ids, effects, unreachable, authority_ready) = state
            .begin_session_revocation(revocation.clone(), second_disconnect)
            .unwrap();
        assert_eq!(command_ids.len(), 2);
        assert_eq!(unreachable, 1);
        assert!(authority_ready);
        for proxy_id in [p1.as_str(), p3.as_str()] {
            assert!(effects.iter().any(|effect| matches!(
                effect,
                Effect::Send {
                    session,
                    frame: ServerFrame::RevokeSessions {
                        revocation: sent,
                        ..
                    },
                } if session.proxy_id == proxy_id && sent == &revocation
            )));
        }

        let original_controller_deadline = first_disconnect + DISCONNECTED_AUTHORITY_RETENTION;
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p3, p3_incarnation)] {
            state
                .record_activity(proxy, incarnation, original_controller_deadline, Utc::now())
                .unwrap();
        }
        state.tick(original_controller_deadline, Utc::now());
        let (_, _, unreachable, authority_ready) = state
            .begin_session_revocation(revocation.clone(), original_controller_deadline)
            .unwrap();
        assert_eq!(
            unreachable, 1,
            "the second disconnect must refresh the same-boot authority marker"
        );
        assert!(authority_ready);

        let proxy_authority_deadline = reconnect_at
            + Duration::from_secs(devserver_control_proto::PROXY_CONVERGENCE_GRACE_SECONDS);
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p3, p3_incarnation)] {
            state
                .record_activity(proxy, incarnation, proxy_authority_deadline, Utc::now())
                .unwrap();
        }
        state.tick(proxy_authority_deadline, Utc::now());
        let (_, _, unreachable, authority_ready) = state
            .begin_session_revocation(revocation.clone(), proxy_authority_deadline)
            .unwrap();
        assert_eq!(
            unreachable, 1,
            "controller tombstone must outlive the proxy's longest retained authority"
        );
        assert!(authority_ready);

        let controller_authority_deadline = second_disconnect + DISCONNECTED_AUTHORITY_RETENTION;
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p3, p3_incarnation)] {
            state
                .record_activity(
                    proxy,
                    incarnation,
                    controller_authority_deadline,
                    Utc::now(),
                )
                .unwrap();
        }
        state.tick(controller_authority_deadline, Utc::now());
        let (_, _, unreachable, authority_ready) = state
            .begin_session_revocation(revocation, controller_authority_deadline)
            .unwrap();
        assert_eq!(unreachable, 0);
        assert!(authority_ready);
    }

    #[test]
    fn zero_row_disconnect_remains_revocation_incomplete_until_grace_expiry() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (proxy_id, incarnation) = begin(&mut state, "p1", now);
        state.disconnect(&proxy_id, incarnation, now).unwrap();
        assert!(state.orphan_usage.is_empty());

        let revocation = SessionRevocation::Subject {
            subject_user_id: Uuid::new_v4(),
        };
        let (commands, _, unreachable, authority_ready) = state
            .begin_session_revocation(revocation.clone(), now)
            .unwrap();
        assert!(commands.is_empty());
        assert_eq!(unreachable, 1);
        assert!(!authority_ready);

        state.tick(now + DISCONNECTED_AUTHORITY_RETENTION, Utc::now());
        let (_, _, unreachable, authority_ready) = state
            .begin_session_revocation(revocation, now + DISCONNECTED_AUTHORITY_RETENTION)
            .unwrap();
        assert_eq!(unreachable, 0);
        assert!(!authority_ready);
    }

    #[test]
    fn changed_boot_cannot_hide_a_disconnected_same_id_authority() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let proxy_id = proxy("p1");
        let old_boot = Uuid::new_v4();
        let (old_incarnation, _) = state
            .begin_session_authorized(
                proxy_id.clone(),
                origin("p1"),
                env!("CARGO_PKG_VERSION").into(),
                old_boot,
                now,
                Utc::now(),
            )
            .unwrap();
        state.disconnect(&proxy_id, old_incarnation, now).unwrap();
        let (new_incarnation, _) = state
            .begin_session_authorized(
                proxy_id.clone(),
                origin("p1"),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
                now,
                Utc::now(),
            )
            .unwrap();

        let revocation = SessionRevocation::Subject {
            subject_user_id: Uuid::new_v4(),
        };
        let (commands, effects, unreachable, _) =
            state.begin_session_revocation(revocation, now).unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(effects.len(), 1);
        assert_eq!(unreachable, 1);
        assert!(matches!(
            effects.as_slice(),
            [Effect::Send { session, .. }] if session.incarnation == new_incarnation
        ));
    }

    #[test]
    fn disconnected_authority_history_is_bounded() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let proxy_id = proxy("p1");
        for boot in 1..=MAX_PROXY_AUTHORITIES as u128 {
            let (incarnation, _) = state
                .begin_session_authorized(
                    proxy_id.clone(),
                    origin("p1"),
                    env!("CARGO_PKG_VERSION").into(),
                    Uuid::from_u128(boot),
                    now,
                    Utc::now(),
                )
                .unwrap();
            state.disconnect(&proxy_id, incarnation, now).unwrap();
        }
        assert_eq!(
            state.disconnected_proxy_deadlines.len(),
            MAX_PROXY_AUTHORITIES
        );
        assert!(matches!(
            state.begin_session_authorized(
                proxy_id,
                origin("p1"),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::from_u128(MAX_PROXY_AUTHORITIES as u128 + 1),
                now,
                Utc::now(),
            ),
            Err(StateError::SessionLimit)
        ));
    }

    #[test]
    fn fresh_warming_controller_never_claims_revocation_complete() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let revocation = SessionRevocation::Subject {
            subject_user_id: Uuid::new_v4(),
        };
        let (commands, effects, unreachable, authority_ready) =
            state.begin_session_revocation(revocation, now).unwrap();
        assert!(commands.is_empty());
        assert!(effects.is_empty());
        assert_eq!(unreachable, 0);
        assert!(!authority_ready);
    }

    #[test]
    fn generation_gap_requests_resync_without_applying_delta() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let effects = state
            .tunnel_up(
                &id,
                incarnation,
                2,
                row("alice", "one", Uuid::new_v4()),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                frame: ServerFrame::ResyncRequired {
                    expected_generation: 1
                },
                ..
            }
        )));
        assert!(state.tunnel_views().is_empty());
        assert_eq!(state.proxy_views()[0].status, ProxyStatus::Joining);
    }

    #[test]
    fn illegal_registration_ids_force_a_fresh_snapshot() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let effects = state
            .tunnel_down(
                &id,
                incarnation,
                1,
                Uuid::new_v4(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_resync(&effects, 2));
        assert_eq!(state.proxy_views()[0].status, ProxyStatus::Joining);

        let mut state = ControllerState::new(100);
        let registration_id = Uuid::new_v4();
        let (id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        state
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                registration_id,
                "alice".into(),
                "two".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        let effects = state
            .tunnel_up(
                &id,
                incarnation,
                1,
                row("alice", "two", registration_id),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_resync(&effects, 2));
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn pong_must_match_an_outstanding_ping() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, incarnation) = begin(&mut state, "p1", now);
        snapshot(&mut state, &id, incarnation, Vec::new(), now);
        let effects = state.tick(now + HEARTBEAT_INTERVAL, Utc::now());
        let nonce = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Send {
                    frame: ServerFrame::Ping { nonce },
                    ..
                } => Some(*nonce),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            state.pong(&id, incarnation, nonce + 1, now, Utc::now()),
            Err(StateError::InvalidPong)
        );
        state
            .pong(&id, incarnation, nonce, now, Utc::now())
            .unwrap();
        assert_eq!(
            state.pong(&id, incarnation, nonce, now, Utc::now()),
            Err(StateError::InvalidPong)
        );
    }

    #[test]
    fn expired_pending_claim_no_longer_consumes_capacity() {
        let now = Instant::now();
        let mut state = ControllerState::new(1);
        let (id, incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let first = state
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "one".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&first, AdmissionDecision::Admit));
        state
            .record_activity(
                &id,
                incarnation,
                now + CONVERGENCE_WINDOW + ADMISSION_CLAIM_TTL,
                Utc::now(),
            )
            .unwrap();
        state.tick(now + CONVERGENCE_WINDOW + ADMISSION_CLAIM_TTL, Utc::now());
        let second = state
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "two".into(),
                now + CONVERGENCE_WINDOW + ADMISSION_CLAIM_TTL,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&second, AdmissionDecision::Admit));
    }

    #[test]
    fn newer_pending_claim_marks_the_old_request_stale() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        state
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "one".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        let effects = state
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "one".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&effects, AdmissionDecision::Stale));
        assert!(has_decision(&effects, AdmissionDecision::Admit));
    }

    #[test]
    fn admission_counts_pending_and_treats_retries_and_reconnects_as_neutral() {
        let now = Instant::now();
        let mut warming = ControllerState::new(1);
        let (id, incarnation) = begin(&mut warming, "p1", now);
        snapshot(&mut warming, &id, incarnation, Vec::new(), now);
        let effects = warming
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "one".into(),
                now,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&effects, AdmissionDecision::ControlWarming));

        let mut state = ControllerState::new(1);
        let (p1, p1_incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let request_id = Uuid::new_v4();
        let registration_id = Uuid::new_v4();
        let first = state
            .request_admission(
                &p1,
                p1_incarnation,
                request_id,
                registration_id,
                "alice".into(),
                "one".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&first, AdmissionDecision::Admit));
        let retry = state
            .request_admission(
                &p1,
                p1_incarnation,
                request_id,
                registration_id,
                "alice".into(),
                "one".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&retry, AdmissionDecision::Admit));
        assert!(!has_decision(&retry, AdmissionDecision::Stale));
        let capped = state
            .request_admission(
                &p1,
                p1_incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "two".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&capped, AdmissionDecision::AtCapacity));

        let (p2, p2_incarnation) = begin(&mut state, "p2", now + CONVERGENCE_WINDOW);
        snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            Vec::new(),
            now + CONVERGENCE_WINDOW,
        );
        let reconnect = state
            .request_admission(
                &p2,
                p2_incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "one".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&reconnect, AdmissionDecision::Admit));
    }

    #[test]
    fn zero_fleet_recovery_waits_for_a_new_full_window() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (p1, p1_incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        state.disconnect(&p1, p1_incarnation, now).unwrap();
        assert!(!state.is_ready());

        let restart_at = now + CONVERGENCE_WINDOW;
        let (p2, p2_incarnation) = begin(&mut state, "p2", restart_at);
        snapshot(&mut state, &p2, p2_incarnation, Vec::new(), restart_at);
        let before = restart_at + CONVERGENCE_WINDOW - Duration::from_millis(1);
        state
            .record_activity(&p2, p2_incarnation, before, Utc::now())
            .unwrap();
        state.tick(before, Utc::now());
        assert!(!state.is_ready());
        let deadline = restart_at + CONVERGENCE_WINDOW;
        state
            .record_activity(&p2, p2_incarnation, deadline, Utc::now())
            .unwrap();
        state.tick(deadline, Utc::now());
        assert!(state.is_ready());
    }

    #[test]
    fn joining_rows_publish_atomically_without_a_global_outage() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let winner = Uuid::from_u128(1);
        let loser = Uuid::from_u128(2);
        let (_p1, _p1_incarnation, _) =
            ready_one(&mut state, "p1", vec![row("alice", "one", winner)], now);
        let (p2, p2_incarnation) = begin(&mut state, "p2", now + CONVERGENCE_WINDOW);
        let effects = snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            vec![
                row("alice", "one", loser),
                row("alice", "two", Uuid::new_v4()),
            ],
            now + CONVERGENCE_WINDOW,
        );
        assert!(state.is_ready());
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.proxy_views()[1].status, ProxyStatus::Joining);
        let command_id = kill_command(&effects, "p2", loser);
        let ready = state
            .command_result(
                &p2,
                p2_incarnation,
                command_id,
                vec![loser],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(ready.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::FleetReady,
            } if session.proxy_id == "p2"
        )));
        assert_eq!(state.tunnel_views().len(), 2);
        assert_eq!(state.proxy_views()[1].status, ProxyStatus::Active);
    }

    #[test]
    fn delta_during_joining_reconciliation_is_not_lost() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let winner = Uuid::from_u128(1);
        let loser = Uuid::from_u128(2);
        let (p1, p1_incarnation, _) =
            ready_one(&mut state, "p1", vec![row("alice", "one", winner)], now);
        let (p2, p2_incarnation) = begin(&mut state, "p2", now + CONVERGENCE_WINDOW);
        let effects = snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            vec![row("alice", "one", loser)],
            now + CONVERGENCE_WINDOW,
        );
        let command_id = kill_command(&effects, "p2", loser);

        let second = Uuid::new_v4();
        state
            .request_admission(
                &p1,
                p1_incarnation,
                Uuid::new_v4(),
                second,
                "alice".into(),
                "two".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        state
            .tunnel_up(
                &p1,
                p1_incarnation,
                1,
                row("alice", "two", second),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        state
            .command_result(
                &p2,
                p2_incarnation,
                command_id,
                vec![loser],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        let ids: Vec<_> = state
            .tunnel_views()
            .into_iter()
            .map(|view| view.devserver_id)
            .collect();
        assert_eq!(ids, ["one", "two"]);
    }

    #[test]
    fn duplicate_restart_rows_wait_for_successful_command_result() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let winner_id = Uuid::from_u128(1);
        let loser_id = Uuid::from_u128(2);
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            vec![row("alice", "one", loser_id)],
            now,
        );
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &p1,
            p1_incarnation,
            vec![row("alice", "one", winner_id)],
            now,
        );
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
                .unwrap();
        }
        let effects = state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        assert!(!state.is_ready());
        let p2_command = kill_command(&effects, "p2", loser_id);
        let p1_command = kill_command(&effects, "p1", winner_id);
        state
            .command_result(
                &p2,
                p2_incarnation,
                p2_command,
                vec![loser_id],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        let ready = state
            .command_result(
                &p1,
                p1_incarnation,
                p1_command,
                vec![winner_id],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(state.is_ready());
        assert!(state.tunnel_views().is_empty());
        assert!(
            ready
                .iter()
                .filter(|effect| matches!(
                    effect,
                    Effect::Send {
                        frame: ServerFrame::FleetReady,
                        ..
                    }
                ))
                .count()
                == 2
        );
    }

    #[test]
    fn failed_restart_reconciliation_retries_after_a_new_window() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let duplicate = row("alice", "one", Uuid::from_u128(2));
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        snapshot(&mut state, &p2, p2_incarnation, vec![duplicate], now);
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &p1,
            p1_incarnation,
            vec![row("alice", "one", Uuid::from_u128(1))],
            now,
        );
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
                .unwrap();
        }
        let effects = state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        let loser = Uuid::from_u128(2);
        let winner = Uuid::from_u128(1);
        let command_id = kill_command(&effects, "p2", loser);
        let p1_command = kill_command(&effects, "p1", winner);
        state
            .command_result(
                &p2,
                p2_incarnation,
                command_id,
                Vec::new(),
                Vec::new(),
                vec![loser],
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        state
            .command_result(
                &p1,
                p1_incarnation,
                p1_command,
                vec![winner],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(!state.is_ready());
        assert_eq!(state.read_tunnels(), Err(StateError::NotReady));

        let retry_at = now + CONVERGENCE_WINDOW * 2;
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, retry_at, Utc::now())
                .unwrap();
        }
        let retry = state.tick(retry_at, Utc::now());
        let retry_command = kill_command(&retry, "p2", loser);
        state
            .command_result(
                &p2,
                p2_incarnation,
                retry_command,
                vec![loser],
                Vec::new(),
                Vec::new(),
                retry_at,
                Utc::now(),
            )
            .unwrap();
        assert!(state.is_ready());
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn reconciliation_command_timeout_retries_instead_of_wedging() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let loser = Uuid::from_u128(2);
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            vec![row("alice", "one", loser)],
            now,
        );
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &p1,
            p1_incarnation,
            vec![row("alice", "one", Uuid::from_u128(1))],
            now,
        );
        let convergence_at = now + CONVERGENCE_WINDOW;
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, convergence_at, Utc::now())
                .unwrap();
        }
        let first = state.tick(convergence_at, Utc::now());
        let expired_command = kill_command(&first, "p2", loser);
        assert!(state.commands.contains_key(&expired_command));

        let timeout_at = convergence_at + COMMAND_TIMEOUT;
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, timeout_at, Utc::now())
                .unwrap();
        }
        state.tick(timeout_at, Utc::now());
        assert!(!state.is_ready());
        assert!(state.commands.is_empty());
        assert!(state.reconciliation.is_none());

        let retry_at = timeout_at + CONVERGENCE_WINDOW;
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, retry_at, Utc::now())
                .unwrap();
        }
        let retry = state.tick(retry_at, Utc::now());
        let retry_command = kill_command(&retry, "p2", loser);
        assert_ne!(retry_command, expired_command);
    }

    #[test]
    fn runtime_command_timeout_releases_pending_state() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (proxy, incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let registration_id = Uuid::new_v4();
        let active_at = now + CONVERGENCE_WINDOW;
        let command = state
            .tunnel_up(
                &proxy,
                incarnation,
                1,
                row("alice", "unclaimed", registration_id),
                active_at,
                Utc::now(),
            )
            .unwrap();
        let command_id = kill_command(&command, "p1", registration_id);
        assert!(state.commands.contains_key(&command_id));

        let timeout_at = active_at + COMMAND_TIMEOUT;
        state
            .record_activity(&proxy, incarnation, timeout_at, Utc::now())
            .unwrap();
        state.tick(timeout_at, Utc::now());
        assert!(state.commands.is_empty());
        assert!(state.is_ready());
    }

    #[test]
    fn joining_snapshot_never_evicts_a_live_row() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let live_id = Uuid::from_u128(1);
        let stale_id = Uuid::from_u128(2);
        let (_p2, _p2_incarnation, _) =
            ready_one(&mut state, "p2", vec![row("alice", "one", live_id)], now);
        // p0 sorts before p2, so the restart tie-break would crown the stale
        // snapshot; a routine join must kill the joining row instead.
        let (p0, p0_incarnation) = begin(&mut state, "p0", now + CONVERGENCE_WINDOW);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", stale_id)],
            now + CONVERGENCE_WINDOW,
        );
        let command_id = kill_command(&effects, "p0", stale_id);
        assert!(effects.iter().all(|effect| !matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::KillRegistrations { .. },
            } if session.proxy_id == "p2"
        )));
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].proxy_id, "p2");
        let p0_view = state
            .proxy_views()
            .into_iter()
            .find(|view| view.proxy_id == "p0")
            .unwrap();
        assert_eq!(p0_view.status, ProxyStatus::Joining);

        let ready = state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                vec![stale_id],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(ready.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::FleetReady,
            } if session.proxy_id == "p0"
        )));
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].proxy_id, "p2");
        let p0_view = state
            .proxy_views()
            .into_iter()
            .find(|view| view.proxy_id == "p0")
            .unwrap();
        assert_eq!(p0_view.status, ProxyStatus::Active);
    }

    #[test]
    fn joining_row_that_exceeds_live_capacity_loses() {
        let now = Instant::now();
        let mut state = ControllerState::new(1);
        let (_p2, _p2_incarnation, _) = ready_one(
            &mut state,
            "p2",
            vec![row("alice", "two", Uuid::from_u128(1))],
            now,
        );
        // "one" sorts before "two", so the restart capacity trim would evict
        // the live row; the live-first rule reserves alice's slot for it.
        let (p0, p0_incarnation) = begin(&mut state, "p0", now + CONVERGENCE_WINDOW);
        let joining_id = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", joining_id)],
            now + CONVERGENCE_WINDOW,
        );
        let command_id = kill_command(&effects, "p0", joining_id);
        assert!(effects.iter().all(|effect| !matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::KillRegistrations { .. },
            } if session.proxy_id == "p2"
        )));
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].devserver_id, "two");
        assert_eq!(state.tunnel_views()[0].proxy_id, "p2");

        state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                vec![joining_id],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].devserver_id, "two");
        assert_eq!(state.tunnel_views()[0].proxy_id, "p2");
    }

    #[test]
    fn failed_joining_reconciliation_retires_only_the_joining_session() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (_p2, _p2_incarnation, _) = ready_one(
            &mut state,
            "p2",
            vec![row("alice", "one", Uuid::from_u128(1))],
            now,
        );
        let (p0, p0_incarnation) = begin(&mut state, "p0", now + CONVERGENCE_WINDOW);
        let stale_id = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", stale_id)],
            now + CONVERGENCE_WINDOW,
        );
        let command_id = kill_command(&effects, "p0", stale_id);
        let retired = state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                Vec::new(),
                Vec::new(),
                vec![stale_id],
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(retired.iter().any(|effect| matches!(
            effect,
            Effect::Retire { session, .. } if session.proxy_id == "p0"
        )));
        assert!(state.is_ready());
        assert_eq!(state.proxy_views().len(), 1);
        assert_eq!(state.proxy_views()[0].proxy_id, "p2");
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].proxy_id, "p2");
    }

    #[test]
    fn joining_snapshot_duplicate_keys_are_all_quarantined() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (_p1, _p1_incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let (p0, p0_incarnation) = begin(&mut state, "p0", now + CONVERGENCE_WINDOW);
        let winner = Uuid::from_u128(1);
        let loser = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", loser), row("alice", "one", winner)],
            now + CONVERGENCE_WINDOW,
        );
        let command_id = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Send {
                    session,
                    frame:
                        ServerFrame::KillRegistrations {
                            command_id,
                            registration_ids,
                        },
                } if session.proxy_id == "p0"
                    && registration_ids.len() == 2
                    && registration_ids.contains(&winner)
                    && registration_ids.contains(&loser) =>
                {
                    Some(*command_id)
                }
                _ => None,
            })
            .expect("conflicting rows are killed together");
        state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                vec![loser, winner],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn live_delta_during_joining_completion_is_not_re_ranked() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let live_one = Uuid::from_u128(1);
        let dup = Uuid::from_u128(2);
        let joining_two = Uuid::from_u128(3);
        let live_two = Uuid::from_u128(4);
        let (p2, p2_incarnation, _) =
            ready_one(&mut state, "p2", vec![row("alice", "one", live_one)], now);
        let (p0, p0_incarnation) = begin(&mut state, "p0", now + CONVERGENCE_WINDOW);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", dup), row("alice", "two", joining_two)],
            now + CONVERGENCE_WINDOW,
        );
        let first_command = kill_command(&effects, "p0", dup);

        // A live admission lands while the joining kill is outstanding; the
        // completion re-plan must treat it as an immutable winner too.
        state
            .request_admission(
                &p2,
                p2_incarnation,
                Uuid::new_v4(),
                live_two,
                "alice".into(),
                "two".into(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        state
            .tunnel_up(
                &p2,
                p2_incarnation,
                1,
                row("alice", "two", live_two),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();

        let second = state
            .command_result(
                &p0,
                p0_incarnation,
                first_command,
                vec![dup],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        let second_command = kill_command(&second, "p0", joining_two);
        assert!(second.iter().all(|effect| !matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::KillRegistrations { .. },
            } if session.proxy_id == "p2"
        )));
        let done = state
            .command_result(
                &p0,
                p0_incarnation,
                second_command,
                vec![joining_two],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(done.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::FleetReady,
            } if session.proxy_id == "p0"
        )));
        let owners: Vec<_> = state
            .tunnel_views()
            .into_iter()
            .map(|view| (view.devserver_id, view.proxy_id))
            .collect();
        assert_eq!(
            owners,
            [
                ("one".to_string(), "p2".to_string()),
                ("two".to_string(), "p2".to_string()),
            ]
        );
    }

    #[test]
    fn initial_reconciliation_fails_closed_on_duplicate_immutable_keys() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let low = Uuid::from_u128(1);
        let high = Uuid::from_u128(2);
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            vec![row("alice", "one", low)],
            now,
        );
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &p1,
            p1_incarnation,
            vec![row("alice", "one", high)],
            now,
        );
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
                .unwrap();
        }
        let effects = state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        // Recency is unavailable at restart, so neither signed duplicate
        // may be elected by proxy id or registration id.
        let p2_command = kill_command(&effects, "p2", low);
        let p1_command = kill_command(&effects, "p1", high);
        state
            .command_result(
                &p2,
                p2_incarnation,
                p2_command,
                vec![low],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        state
            .command_result(
                &p1,
                p1_incarnation,
                p1_command,
                vec![high],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(state.is_ready());
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn user_kill_cancels_pending_claims_before_commanding() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let registration_id = Uuid::new_v4();
        let (id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let claimed_registration = Uuid::new_v4();
        let admit = state
            .request_admission(
                &id,
                incarnation,
                Uuid::new_v4(),
                claimed_registration,
                "alice".into(),
                "two".into(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        assert!(has_decision(&admit, AdmissionDecision::Admit));
        assert_eq!(state.pending.len(), 1);

        let (command_ids, effects) = state
            .begin_owner_kill(legacy_owner_user_id("alice"), active_at)
            .unwrap();
        assert!(state.pending.is_empty());
        let command_id = kill_command(&effects, "p1", registration_id);
        assert_eq!(command_ids, vec![command_id]);

        // The cancelled claim no longer activates its registration: a late
        // TunnelUp takes the unclaimed path and is killed outright.
        let late = state
            .tunnel_up(
                &id,
                incarnation,
                1,
                row("alice", "two", claimed_registration),
                active_at,
                Utc::now(),
            )
            .unwrap();
        kill_command(&late, "p1", claimed_registration);
        assert_eq!(state.tunnel_views().len(), 1);
    }

    #[test]
    fn exact_kill_on_unknown_key_issues_nothing() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (_id, _incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", Uuid::new_v4())],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        for (user, devserver_id) in [("alice", "two"), ("bob", "one")] {
            let (command_id, effects) = state
                .begin_exact_kill(legacy_owner_user_id(user), devserver_id, active_at)
                .unwrap();
            assert!(command_id.is_none());
            assert!(effects.is_empty());
        }
        assert!(state.commands.is_empty());
    }

    #[test]
    fn kills_require_readiness() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (id, incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &id,
            incarnation,
            vec![row("alice", "one", Uuid::new_v4())],
            now,
        );
        assert!(matches!(
            state.begin_exact_kill(legacy_owner_user_id("alice"), "one", now),
            Err(StateError::NotReady)
        ));
        assert!(matches!(
            state.begin_owner_kill(legacy_owner_user_id("alice"), now),
            Err(StateError::NotReady)
        ));
    }

    #[test]
    fn runtime_command_settles_confirmed_on_result() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let registration_id = Uuid::new_v4();
        let (id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let (command_id, _) = state
            .begin_exact_kill(legacy_owner_user_id("alice"), "one", active_at)
            .unwrap();
        let command_id = command_id.expect("row exists");
        let effects = state
            .command_result(
                &id,
                incarnation,
                command_id,
                vec![registration_id],
                Vec::new(),
                Vec::new(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::CommandSettled {
                command_id: settled,
                outcome: CommandOutcome::Confirmed {
                    killed: 1,
                    missing: 0
                },
            } if *settled == command_id
        )));
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn runtime_command_settles_failed_on_reported_failure() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let registration_id = Uuid::new_v4();
        let (id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let (command_id, _) = state
            .begin_exact_kill(legacy_owner_user_id("alice"), "one", active_at)
            .unwrap();
        let command_id = command_id.expect("row exists");
        let effects = state
            .command_result(
                &id,
                incarnation,
                command_id,
                Vec::new(),
                Vec::new(),
                vec![registration_id],
                active_at,
                Utc::now(),
            )
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::CommandSettled {
                command_id: settled,
                outcome: CommandOutcome::Failed,
            } if *settled == command_id
        )));
    }

    #[test]
    fn runtime_command_settles_timed_out_on_expiry() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let registration_id = Uuid::new_v4();
        let (id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let (command_id, _) = state
            .begin_exact_kill(legacy_owner_user_id("alice"), "one", active_at)
            .unwrap();
        let command_id = command_id.expect("row exists");
        let timeout_at = active_at + COMMAND_TIMEOUT;
        state
            .record_activity(&id, incarnation, timeout_at, Utc::now())
            .unwrap();
        let effects = state.tick(timeout_at, Utc::now());
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::CommandSettled {
                command_id: settled,
                outcome: CommandOutcome::TimedOut,
            } if *settled == command_id
        )));
        assert!(state.commands.is_empty());
    }

    #[test]
    fn runtime_command_settles_session_lost_on_session_death() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let registration_id = Uuid::new_v4();
        let (id, incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", registration_id)],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let (command_id, _) = state
            .begin_exact_kill(legacy_owner_user_id("alice"), "one", active_at)
            .unwrap();
        let command_id = command_id.expect("row exists");
        let effects = state.disconnect(&id, incarnation, active_at).unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::CommandSettled {
                command_id: settled,
                outcome: CommandOutcome::SessionLost,
            } if *settled == command_id
        )));
        assert!(state.commands.is_empty());
    }

    #[test]
    fn user_kill_with_no_rows_issues_nothing() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (_id, _incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let (command_ids, effects) = state
            .begin_owner_kill(legacy_owner_user_id("alice"), now + CONVERGENCE_WINDOW)
            .unwrap();
        assert!(command_ids.is_empty());
        assert!(effects.is_empty());
    }

    #[test]
    fn user_kill_groups_registrations_by_owning_session() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let bob_registration = Uuid::new_v4();
        let (p1, p1_incarnation) = begin(&mut state, "p1", now);
        snapshot(
            &mut state,
            &p1,
            p1_incarnation,
            vec![
                row("alice", "one", first),
                row("alice", "two", second),
                row("bob", "one", bob_registration),
            ],
            now,
        );
        let (p2, p2_incarnation) = begin(&mut state, "p2", now);
        let third = Uuid::new_v4();
        snapshot(
            &mut state,
            &p2,
            p2_incarnation,
            vec![row("alice", "three", third)],
            now,
        );
        for (proxy, incarnation) in [(&p1, p1_incarnation), (&p2, p2_incarnation)] {
            state
                .record_activity(proxy, incarnation, now + CONVERGENCE_WINDOW, Utc::now())
                .unwrap();
        }
        state.tick(now + CONVERGENCE_WINDOW, Utc::now());
        assert!(state.is_ready());

        let (command_ids, effects) = state
            .begin_owner_kill(legacy_owner_user_id("alice"), now + CONVERGENCE_WINDOW)
            .unwrap();
        assert_eq!(command_ids.len(), 2);
        let mut per_session: HashMap<String, Vec<Uuid>> = HashMap::new();
        for effect in &effects {
            let Effect::Send {
                session,
                frame:
                    ServerFrame::KillRegistrations {
                        registration_ids, ..
                    },
            } = effect
            else {
                continue;
            };
            per_session.insert(session.proxy_id.clone(), registration_ids.clone());
        }
        assert_eq!(per_session.len(), 2);
        let p1_ids = per_session.get("p1").expect("p1 command");
        assert_eq!(p1_ids.len(), 2);
        assert!(p1_ids.contains(&first));
        assert!(p1_ids.contains(&second));
        assert_eq!(per_session.get("p2").expect("p2 command"), &vec![third]);
        // bob's row is never targeted.
        let targeted: HashSet<Uuid> = per_session.values().flatten().copied().collect();
        assert!(!targeted.contains(&bob_registration));
        assert_eq!(state.tunnel_views().len(), 4);
    }

    #[test]
    fn command_confirmed_down_is_not_treated_as_corruption() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let (p1, p1_incarnation, _) = ready_one(
            &mut state,
            "p1",
            vec![row("alice", "one", first), row("alice", "two", second)],
            now,
        );
        let active_at = now + CONVERGENCE_WINDOW;
        let (command_id, _) = state
            .begin_exact_kill(legacy_owner_user_id("alice"), "one", active_at)
            .unwrap();
        let command_id = command_id.expect("the aggregate row exists");
        state
            .command_result(
                &p1,
                p1_incarnation,
                command_id,
                vec![first],
                Vec::new(),
                Vec::new(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        assert_eq!(state.tunnel_views().len(), 1);

        // The proxy publishes its own contiguous TunnelDown for the same
        // eviction; it must not retract the proxy's other rows.
        let effects = state
            .tunnel_down(&p1, p1_incarnation, 1, first, active_at, Utc::now())
            .unwrap();
        assert!(effects.is_empty());
        assert_eq!(state.proxy_views()[0].status, ProxyStatus::Active);
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].devserver_id, "two");
    }

    #[test]
    fn joining_row_that_duplicates_a_pending_claim_loses() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (p1, p1_incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let active_at = now + CONVERGENCE_WINDOW;
        let claim_registration = Uuid::new_v4();
        state
            .request_admission(
                &p1,
                p1_incarnation,
                Uuid::new_v4(),
                claim_registration,
                "alice".into(),
                "one".into(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        // The pending claim is strictly earlier than the joining snapshot,
        // so p0's copy of the claimed key loses even though no live row
        // exists yet.
        let (p0, p0_incarnation) = begin(&mut state, "p0", active_at);
        let joining_id = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", joining_id)],
            active_at,
        );
        let command_id = kill_command(&effects, "p0", joining_id);
        state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                vec![joining_id],
                Vec::new(),
                Vec::new(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        // The claimed TunnelUp then lands without a replacement battle.
        state
            .tunnel_up(
                &p1,
                p1_incarnation,
                1,
                row("alice", "one", claim_registration),
                active_at,
                Utc::now(),
            )
            .unwrap();
        assert_eq!(state.tunnel_views().len(), 1);
        assert_eq!(state.tunnel_views()[0].proxy_id, "p1");
    }

    #[test]
    fn pending_claim_consumes_joining_capacity() {
        let now = Instant::now();
        let mut state = ControllerState::new(1);
        let (p1, p1_incarnation, _) = ready_one(&mut state, "p1", Vec::new(), now);
        let active_at = now + CONVERGENCE_WINDOW;
        state
            .request_admission(
                &p1,
                p1_incarnation,
                Uuid::new_v4(),
                Uuid::new_v4(),
                "alice".into(),
                "one".into(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        // Cap 1 is fully consumed by the pending claim, so p0's novel key
        // loses even though alice has no live row.
        let (p0, p0_incarnation) = begin(&mut state, "p0", active_at);
        let joining_id = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "two", joining_id)],
            active_at,
        );
        let command_id = kill_command(&effects, "p0", joining_id);
        state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                vec![joining_id],
                Vec::new(),
                Vec::new(),
                active_at,
                Utc::now(),
            )
            .unwrap();
        assert!(state.tunnel_views().is_empty());
    }

    #[test]
    fn force_resync_during_joining_reconciliation_keeps_the_session_joining() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let (_p2, _p2_incarnation, _) = ready_one(
            &mut state,
            "p2",
            vec![row("alice", "one", Uuid::from_u128(1))],
            now,
        );
        let (p0, p0_incarnation) = begin(&mut state, "p0", now + CONVERGENCE_WINDOW);
        let dup = Uuid::from_u128(2);
        let effects = snapshot(
            &mut state,
            &p0,
            p0_incarnation,
            vec![row("alice", "one", dup)],
            now + CONVERGENCE_WINDOW,
        );
        let command_id = kill_command(&effects, "p0", dup);

        // A corrupt delta mid-reconciliation force-resyncs the session;
        // the outstanding kill result must not flip it Active with no
        // generation, a state a fresh snapshot could never recover from.
        let resync = state
            .tunnel_up(
                &p0,
                p0_incarnation,
                5,
                row("alice", "nine", Uuid::new_v4()),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(has_resync(&resync, 1));
        state
            .command_result(
                &p0,
                p0_incarnation,
                command_id,
                vec![dup],
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        let p0_view = state
            .proxy_views()
            .into_iter()
            .find(|view| view.proxy_id == "p0")
            .unwrap();
        assert_eq!(p0_view.status, ProxyStatus::Joining);

        let effects = state
            .accept_snapshot(
                &p0,
                p0_incarnation,
                0,
                Vec::new(),
                Vec::new(),
                now + CONVERGENCE_WINDOW,
                Utc::now(),
            )
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::Send {
                session,
                frame: ServerFrame::FleetReady,
            } if session.proxy_id == "p0"
        )));
        let p0_view = state
            .proxy_views()
            .into_iter()
            .find(|view| view.proxy_id == "p0")
            .unwrap();
        assert_eq!(p0_view.status, ProxyStatus::Active);
    }

    fn kill_command(effects: &[Effect], proxy_id: &str, registration_id: Uuid) -> Uuid {
        effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Send {
                    session,
                    frame:
                        ServerFrame::KillRegistrations {
                            command_id,
                            registration_ids,
                        },
                } if session.proxy_id == proxy_id && registration_ids == &[registration_id] => {
                    Some(*command_id)
                }
                _ => None,
            })
            .expect("targeted kill command")
    }

    fn has_resync(effects: &[Effect], expected_generation: u64) -> bool {
        effects.iter().any(|effect| {
            matches!(
                effect,
                Effect::Send {
                    frame: ServerFrame::ResyncRequired { expected_generation: actual },
                    ..
                } if *actual == expected_generation
            )
        })
    }

    fn has_decision(effects: &[Effect], expected: AdmissionDecision) -> bool {
        effects.iter().any(|effect| {
            matches!(
                effect,
                Effect::Send {
                    frame: ServerFrame::AdmissionDecision { decision, .. },
                    ..
                } if *decision == expected
            )
        })
    }
}
