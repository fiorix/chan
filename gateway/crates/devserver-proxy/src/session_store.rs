use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chan_tunnel_proto::gateway_assertion::ClientType;
use chrono::{DateTime, Utc};
use devserver_control_proto::BrowserSessionRow;
use rand::RngCore;
use subtle::ConstantTimeEq;
use tokio::sync::{broadcast, Notify};
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SESSION_ID_BYTES: usize = 32;
const MAX_SESSIONS_PER_SUBJECT: usize = 64;
const MAX_SESSIONS_PER_PRINCIPAL: usize = 16;
/// An extension binding token is a selector, the lookup key, followed by a
/// verifier compared in constant time, so a timing difference in the map
/// lookup can reveal nothing about the 256 bits that authorize the request.
const BINDING_SELECTOR_BYTES: usize = 16;
const BINDING_VERIFIER_BYTES: usize = 32;
/// Length of an extension binding token as it appears in a bound path.
pub const EXTENSION_BINDING_HEX_LEN: usize = (BINDING_SELECTOR_BYTES + BINDING_VERIFIER_BYTES) * 2;
/// Every frame load of an extension tab mints a binding, so a principal that
/// reloads frames rotates through this many instead of accumulating them: the
/// least recently used binding is evicted to make room.
const MAX_BINDINGS_PER_PRINCIPAL: usize = 32;
/// Proxy-wide bindings allowed per session slot. The total is refused, never
/// evicted, when full, so one user's frames cannot push out another user's.
const BINDINGS_PER_SESSION_SLOT: usize = 4;
#[cfg(not(test))]
const REVOCATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(test)]
const REVOCATION_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SessionPrincipal {
    pub subject_user_id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub audience: String,
}

impl std::fmt::Debug for SessionPrincipal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionPrincipal")
            .field("subject_user_id", &self.subject_user_id)
            .field("owner_user_id", &self.owner_user_id)
            .field("devserver_id", &self.devserver_id)
            .field("audience", &self.audience)
            .finish()
    }
}

/// One opaque proxy session.
///
/// The client type is an attribute of the session, not part of its
/// principal: a user's desktop session and browser session on the same
/// devserver are one principal, so they share the principal's session
/// quota and extension bindings, and every revocation that reaches the
/// principal reaches both.
#[derive(Clone)]
pub struct SessionRecord {
    pub admin_session_id: Uuid,
    pub principal: SessionPrincipal,
    /// The client the entry credential that opened this session was minted
    /// for, signed into every assertion made under it.
    pub client: ClientType,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub created_at_wall: DateTime<Utc>,
    pub expires_at_wall: DateTime<Utc>,
    pub cancellation: CancellationToken,
    operations: Arc<ActiveOperations>,
}

impl std::fmt::Debug for SessionRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRecord")
            .field("admin_session_id", &self.admin_session_id)
            .field("principal", &self.principal)
            .field("client", &self.client)
            .field("created_at", &self.created_at)
            .field("expires_at", &self.expires_at)
            .field("cancelled", &self.cancellation.is_cancelled())
            .finish()
    }
}

/// One request or WebSocket bridge admitted under a browser session.
///
/// The guard is registered before the transport starts. Moving it into the
/// transport task makes Drop the proof that the bridge has stopped; session
/// revocation aborts that task and waits for the guard to disappear before the
/// controller may acknowledge the command.
pub(crate) struct ActiveOperation {
    operations: Arc<ActiveOperations>,
    id: u64,
}

impl ActiveOperation {
    pub(crate) fn spawn<F, T>(self, future: F) -> JoinHandle<T>
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let operations = self.operations.clone();
        let id = self.id;
        let task = tokio::spawn(async move {
            let _operation = self;
            future.await
        });
        operations.attach(id, task.abort_handle());
        task
    }
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        let removed = self
            .operations
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .remove(&self.id)
            .is_some();
        if removed {
            self.operations.changed.notify_one();
        }
    }
}

#[derive(Default)]
struct ActiveOperations {
    state: Mutex<ActiveOperationState>,
    changed: Notify,
}

#[derive(Default)]
struct ActiveOperationState {
    revoked: bool,
    next_id: u64,
    active: HashMap<u64, Option<AbortHandle>>,
}

impl ActiveOperations {
    fn begin(self: &Arc<Self>) -> Option<ActiveOperation> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.revoked {
            return None;
        }
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        state.active.insert(id, None);
        Some(ActiveOperation {
            operations: self.clone(),
            id,
        })
    }

    fn attach(&self, id: u64, abort: AbortHandle) {
        let abort_now = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let revoked = state.revoked;
            match state.active.get_mut(&id) {
                Some(slot) if !revoked => {
                    *slot = Some(abort.clone());
                    false
                }
                Some(_) => true,
                None => false,
            }
        };
        if abort_now {
            abort.abort();
        }
    }

    fn revoke(&self) {
        let aborts = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.revoked = true;
            state
                .active
                .values()
                .filter_map(|abort| abort.clone())
                .collect::<Vec<_>>()
        };
        for abort in aborts {
            abort.abort();
        }
    }

    async fn wait_drained(&self, deadline: Instant) -> bool {
        loop {
            let changed = self.changed.notified();
            if self
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .active
                .is_empty()
            {
                return true;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return false;
            }
        }
    }
}

impl SessionRecord {
    pub(crate) fn begin_operation(&self) -> Option<ActiveOperation> {
        self.operations.begin()
    }

    fn revoke_authority(&self) {
        self.cancellation.cancel();
        self.operations.revoke();
    }
}

/// The devserver extension a binding forwards to: the tenant and extension
/// the frame was opened for, and the devserver's own path capability.
#[derive(Clone, PartialEq, Eq)]
pub struct ExtensionTarget {
    pub tenant: String,
    pub extension_id: String,
    pub capability: String,
}

impl std::fmt::Debug for ExtensionTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionTarget")
            .field("tenant", &self.tenant)
            .field("extension_id", &self.extension_id)
            .finish_non_exhaustive()
    }
}

/// A signed-in principal's extension link. The opaque-origin extension frame
/// can send no cookie, so the bound path carries the token instead, and the
/// binding stands in for the session cookie on every request the frame makes.
///
/// A binding belongs to its principal rather than to the session that minted
/// it: an open extension tab keeps working when the same user signs in again
/// before the minting session's hour runs out, just as the rest of that tab
/// keeps working on the renewed cookie. It lives only while the principal has
/// held a live session without a gap since it was minted, and any revocation
/// that reaches the principal deletes it.
struct ExtensionBinding {
    verifier: [u8; BINDING_VERIFIER_BYTES],
    principal: SessionPrincipal,
    /// The client of the session whose frame navigation minted the binding.
    /// A bound request carries it while that client holds a live session for
    /// the principal, and [`ClientType::Unknown`] otherwise, so a binding kept
    /// alive by another client's session never claims a client that neither
    /// opened the frame nor still holds a session.
    client: ClientType,
    target: ExtensionTarget,
    last_used: Instant,
    cancellation: CancellationToken,
    operations: Arc<ActiveOperations>,
}

impl ExtensionBinding {
    fn revoke_authority(&self) {
        self.cancellation.cancel();
        self.operations.revoke();
    }
}

/// A live binding resolved for one request.
pub struct ResolvedBinding {
    pub target: ExtensionTarget,
    /// The principal's authority for this request: its identity and expiry
    /// are the live session's, its client is the binding's (see
    /// `ExtensionBinding::client`), and cancellation and the operation
    /// registry are the binding's own, so revoking the binding stops its
    /// transports.
    pub authorization: SessionRecord,
}

pub struct IssuedSession {
    id: String,
    pub record: SessionRecord,
}

impl IssuedSession {
    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Revocation {
    Exact {
        subject_user_id: Uuid,
        owner_user_id: Uuid,
        devserver_id: String,
    },
    Subject {
        subject_user_id: Uuid,
    },
    SessionId {
        admin_session_id: Uuid,
    },
    Owner {
        owner_user_id: Uuid,
    },
    All,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionEvent {
    Up(BrowserSessionRow),
    Down(Uuid),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IssueError {
    #[error("proxy session authority is suspended")]
    AuthoritySuspended,
    #[error("proxy session capacity reached")]
    AtCapacity,
    #[error("proxy subject session capacity reached")]
    SubjectAtCapacity,
    #[error("proxy principal session capacity reached")]
    PrincipalAtCapacity,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RevokeError {
    #[error("timed out draining revoked session transports")]
    DrainTimedOut,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BindError {
    #[error("the principal holds no live proxy session")]
    NoLiveSession,
    #[error("extension binding capacity reached")]
    AtCapacity,
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<SessionState>>,
    events: broadcast::Sender<SessionEvent>,
    max_sessions: usize,
    max_sessions_per_subject: usize,
    max_sessions_per_principal: usize,
    max_bindings: usize,
    max_bindings_per_principal: usize,
    lifetime: Duration,
}

#[derive(Default)]
struct SessionState {
    authority_suspended: bool,
    sessions: HashMap<String, SessionRecord>,
    expiries: BinaryHeap<Reverse<(Instant, String)>>,
    subject_counts: HashMap<Uuid, usize>,
    /// Session ids per principal: the principal quota, and where a binding
    /// looks for the live session it rides on.
    principal_sessions: HashMap<SessionPrincipal, Vec<String>>,
    /// Extension bindings keyed by selector.
    bindings: HashMap<String, ExtensionBinding>,
    principal_bindings: HashMap<SessionPrincipal, Vec<String>>,
}

impl std::fmt::Debug for SessionStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionStore")
            .field("max_sessions", &self.max_sessions)
            .field("max_sessions_per_subject", &self.max_sessions_per_subject)
            .field(
                "max_sessions_per_principal",
                &self.max_sessions_per_principal,
            )
            .field("max_bindings", &self.max_bindings)
            .field(
                "max_bindings_per_principal",
                &self.max_bindings_per_principal,
            )
            .field("lifetime", &self.lifetime)
            .finish_non_exhaustive()
    }
}

impl SessionStore {
    pub fn new(max_sessions: usize, lifetime: Duration) -> Self {
        let (events, _) = broadcast::channel(max_sessions.saturating_mul(2).clamp(128, 65_536));
        Self {
            inner: Arc::new(Mutex::new(SessionState::default())),
            events,
            max_sessions,
            max_sessions_per_subject: max_sessions.min(MAX_SESSIONS_PER_SUBJECT),
            max_sessions_per_principal: max_sessions.min(MAX_SESSIONS_PER_PRINCIPAL),
            max_bindings: max_sessions.saturating_mul(BINDINGS_PER_SESSION_SLOT),
            max_bindings_per_principal: MAX_BINDINGS_PER_PRINCIPAL,
            lifetime,
        }
    }

    #[cfg(test)]
    fn with_quotas(
        max_sessions: usize,
        lifetime: Duration,
        max_sessions_per_subject: usize,
        max_sessions_per_principal: usize,
    ) -> Self {
        Self {
            max_sessions_per_subject,
            max_sessions_per_principal,
            ..Self::new(max_sessions, lifetime)
        }
    }

    #[cfg(test)]
    fn with_binding_quotas(
        max_sessions: usize,
        lifetime: Duration,
        max_bindings: usize,
        max_bindings_per_principal: usize,
    ) -> Self {
        Self {
            max_bindings,
            max_bindings_per_principal,
            ..Self::new(max_sessions, lifetime)
        }
    }

    fn expire_due(&self, state: &mut SessionState, now: Instant) {
        for record in take_expired(state, now) {
            record.revoke_authority();
            let _ = self
                .events
                .send(SessionEvent::Down(record.admin_session_id));
        }
    }

    pub fn issue(
        &self,
        principal: SessionPrincipal,
        client: ClientType,
    ) -> Result<IssuedSession, IssueError> {
        let now = Instant::now();
        let wall_now = Utc::now();
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if state.authority_suspended {
            return Err(IssueError::AuthoritySuspended);
        }
        // Expiring first is also what keeps a binding from outliving a gap:
        // a principal whose last session lapsed loses its bindings here,
        // before a new session for it is inserted.
        self.expire_due(&mut state, now);
        if state.sessions.len() >= self.max_sessions {
            return Err(IssueError::AtCapacity);
        }
        if state
            .subject_counts
            .get(&principal.subject_user_id)
            .copied()
            .unwrap_or_default()
            >= self.max_sessions_per_subject
        {
            return Err(IssueError::SubjectAtCapacity);
        }
        if state.principal_sessions.get(&principal).map_or(0, Vec::len)
            >= self.max_sessions_per_principal
        {
            return Err(IssueError::PrincipalAtCapacity);
        }

        let id = loop {
            let candidate = random_session_id();
            if !state.sessions.contains_key(&candidate) {
                break candidate;
            }
        };
        let record = SessionRecord {
            admin_session_id: Uuid::new_v4(),
            principal,
            client,
            created_at: now,
            expires_at: now + self.lifetime,
            created_at_wall: wall_now,
            expires_at_wall: wall_now
                .checked_add_signed(
                    chrono::Duration::from_std(self.lifetime).unwrap_or(chrono::Duration::MAX),
                )
                .unwrap_or(DateTime::<Utc>::MAX_UTC),
            cancellation: CancellationToken::new(),
            operations: Arc::new(ActiveOperations::default()),
        };
        state.sessions.insert(id.clone(), record.clone());
        *state
            .subject_counts
            .entry(record.principal.subject_user_id)
            .or_default() += 1;
        state
            .principal_sessions
            .entry(record.principal.clone())
            .or_default()
            .push(id.clone());
        state
            .expiries
            .push(Reverse((record.expires_at, id.clone())));
        let _ = self
            .events
            .send(SessionEvent::Up(browser_session_row(&record)));
        Ok(IssuedSession { id, record })
    }

    pub fn lookup(&self, id: &str) -> Option<SessionRecord> {
        if !valid_session_id(id) {
            return None;
        }
        let now = Instant::now();
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let record = state.sessions.get(id)?.clone();
        // A revoked record remains resident until every admitted transport has
        // drained. Keeping the tombstone is what makes a retried controller
        // command observe an earlier drain timeout instead of falsely
        // confirming that there is nothing left to revoke.
        if record.cancellation.is_cancelled() {
            return None;
        }
        if record.expires_at <= now {
            remove_session(&mut state, id);
            record.revoke_authority();
            let _ = self
                .events
                .send(SessionEvent::Down(record.admin_session_id));
            return None;
        }
        Some(record)
    }

    /// Revoke every matching session and every extension binding of a
    /// principal the revocation reaches. An admin-session revocation reaches
    /// the principal of the session it names, so it also ends the bindings
    /// that principal's other sessions keep alive: a revocation never leaves
    /// an extension link usable.
    pub async fn revoke(&self, revocation: &Revocation) -> Result<usize, RevokeError> {
        let (revoked, bindings) = {
            let state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            let revoked = state
                .sessions
                .iter()
                .filter(|(_, record)| revocation.matches(record))
                .map(|(id, record)| (id.clone(), record.clone()))
                .collect::<Vec<_>>();
            let principals = revoked
                .iter()
                .map(|(_, record)| &record.principal)
                .collect::<HashSet<_>>();
            let bindings = binding_handles(&state, |principal| {
                revocation.matches_principal(principal) || principals.contains(principal)
            });
            (revoked, bindings)
        };

        self.finish_revocation(revoked, bindings).await
    }

    pub async fn clear(&self) -> Result<usize, RevokeError> {
        let (cleared, bindings) = {
            let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            // Grace expiry is an authority boundary. Suspending issuance in
            // the same critical section closes the race with an entry
            // exchange that captured a registry row before tunnel eviction.
            state.authority_suspended = true;
            let cleared = state
                .sessions
                .iter()
                .map(|(id, record)| (id.clone(), record.clone()))
                .collect::<Vec<_>>();
            (cleared, binding_handles(&state, |_| true))
        };

        self.finish_revocation(cleared, bindings).await
    }

    /// The tail every revocation shares once its sessions and bindings are
    /// selected: cancel, drain, then remove. A drain that times out returns
    /// before anything is removed, so the cancelled records and bindings stay
    /// in the store as the tombstone a retried revocation must find.
    async fn finish_revocation(
        &self,
        selected: Vec<(String, SessionRecord)>,
        bindings: Vec<BindingHandle>,
    ) -> Result<usize, RevokeError> {
        // Bindings first: a request resolving a binding between the two steps
        // then meets a cancelled binding rather than one whose sessions just
        // went dead, which it would discard instead of leaving the tombstone
        // a retried command must find.
        for binding in &bindings {
            binding.revoke_authority();
        }
        for (_, record) in &selected {
            record.revoke_authority();
        }
        let deadline = Instant::now() + REVOCATION_DRAIN_TIMEOUT;
        for (_, record) in &selected {
            if !record.operations.wait_drained(deadline).await {
                return Err(RevokeError::DrainTimedOut);
            }
        }
        for binding in &bindings {
            if !binding.operations.wait_drained(deadline).await {
                return Err(RevokeError::DrainTimedOut);
            }
        }

        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        for binding in &bindings {
            binding.remove_from(&mut state);
        }
        for (id, _) in &selected {
            if let Some(record) = remove_session(&mut state, id) {
                let _ = self
                    .events
                    .send(SessionEvent::Down(record.admin_session_id));
            }
        }
        Ok(selected.len())
    }

    /// Bind an extension link to `principal`, which must hold a live session,
    /// for the client of the session that asked, and answer the token for the
    /// bound path.
    pub fn bind_extension(
        &self,
        principal: &SessionPrincipal,
        client: ClientType,
        target: ExtensionTarget,
    ) -> Result<String, BindError> {
        let now = Instant::now();
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        self.expire_due(&mut state, now);
        if live_session(&state, principal, now).is_none() {
            return Err(BindError::NoLiveSession);
        }
        if self.max_bindings_per_principal == 0 {
            return Err(BindError::AtCapacity);
        }
        let held = state.principal_bindings.get(principal).map_or(0, Vec::len);
        if held >= self.max_bindings_per_principal {
            let evicted = state
                .principal_bindings
                .get(principal)
                .into_iter()
                .flatten()
                .filter_map(|selector| {
                    state
                        .bindings
                        .get(selector)
                        .map(|binding| (binding.last_used, selector.clone()))
                })
                .min();
            if let Some((_, selector)) = evicted {
                if let Some(binding) = remove_binding(&mut state, &selector) {
                    binding.revoke_authority();
                }
            }
        } else if state.bindings.len() >= self.max_bindings {
            return Err(BindError::AtCapacity);
        }

        let selector = loop {
            let candidate = random_hex(BINDING_SELECTOR_BYTES);
            if !state.bindings.contains_key(&candidate) {
                break candidate;
            }
        };
        let mut verifier = [0_u8; BINDING_VERIFIER_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut verifier);
        let token = format!("{selector}{}", hex(&verifier));
        state
            .principal_bindings
            .entry(principal.clone())
            .or_default()
            .push(selector.clone());
        state.bindings.insert(
            selector,
            ExtensionBinding {
                verifier,
                principal: principal.clone(),
                client,
                target,
                last_used: now,
                cancellation: CancellationToken::new(),
                operations: Arc::new(ActiveOperations::default()),
            },
        );
        Ok(token)
    }

    /// Resolve a bound path's token to its target and the principal's
    /// authority for one request, or `None` when the token names no live
    /// binding. A binding whose principal no longer holds a live session is
    /// deleted here, so it cannot come back when that user signs in again.
    pub fn resolve_extension_binding(&self, token: &str) -> Option<ResolvedBinding> {
        let (selector, verifier) = split_binding_token(token)?;
        let now = Instant::now();
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let binding = state.bindings.get(selector)?;
        if !bool::from(binding.verifier[..].ct_eq(&verifier[..]))
            || binding.cancellation.is_cancelled()
        {
            return None;
        }
        let Some(session) = live_session(&state, &binding.principal, now).cloned() else {
            if let Some(binding) = remove_binding(&mut state, selector) {
                binding.revoke_authority();
            }
            return None;
        };
        let client = if live_sessions(&state, &binding.principal, now)
            .any(|record| record.client == binding.client)
        {
            binding.client
        } else {
            ClientType::Unknown
        };
        let binding = state.bindings.get_mut(selector)?;
        binding.last_used = now;
        Some(ResolvedBinding {
            target: binding.target.clone(),
            authorization: SessionRecord {
                admin_session_id: session.admin_session_id,
                principal: binding.principal.clone(),
                client,
                created_at: session.created_at,
                expires_at: session.expires_at,
                created_at_wall: session.created_at_wall,
                expires_at_wall: session.expires_at_wall,
                cancellation: binding.cancellation.clone(),
                operations: binding.operations.clone(),
            },
        })
    }

    #[cfg(test)]
    fn binding_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .bindings
            .len()
    }

    pub fn resume_authority(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .authority_suspended = false;
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sessions
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(crate) fn snapshot_and_subscribe(
        &self,
    ) -> (Vec<BrowserSessionRow>, broadcast::Receiver<SessionEvent>) {
        self.prune_expired();
        let state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let events = self.events.subscribe();
        let rows = state
            .sessions
            .values()
            .filter(|record| !record.cancellation.is_cancelled())
            .map(browser_session_row)
            .collect();
        (rows, events)
    }

    pub(crate) fn prune_expired(&self) {
        let expired = {
            let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            take_expired(&mut state, Instant::now())
        };
        for record in expired {
            record.revoke_authority();
            let _ = self
                .events
                .send(SessionEvent::Down(record.admin_session_id));
        }
    }
}

impl Revocation {
    fn matches(&self, record: &SessionRecord) -> bool {
        match self {
            Self::SessionId { admin_session_id } => record.admin_session_id == *admin_session_id,
            _ => self.matches_principal(&record.principal),
        }
    }

    /// Whether the revocation names `principal` by its own fields. An
    /// admin-session revocation names a session, never a principal.
    fn matches_principal(&self, principal: &SessionPrincipal) -> bool {
        match self {
            Self::Exact {
                subject_user_id,
                owner_user_id,
                devserver_id,
            } => {
                principal.subject_user_id == *subject_user_id
                    && principal.owner_user_id == *owner_user_id
                    && principal.devserver_id == *devserver_id
            }
            Self::Subject { subject_user_id } => principal.subject_user_id == *subject_user_id,
            Self::SessionId { .. } => false,
            Self::Owner { owner_user_id } => principal.owner_user_id == *owner_user_id,
            Self::All => true,
        }
    }
}

/// What a revocation holds of a binding while it drains outside the lock.
struct BindingHandle {
    selector: String,
    cancellation: CancellationToken,
    operations: Arc<ActiveOperations>,
}

impl BindingHandle {
    fn revoke_authority(&self) {
        self.cancellation.cancel();
        self.operations.revoke();
    }

    /// Remove the binding this handle was taken from, and not a different
    /// binding that has since reused its selector.
    fn remove_from(&self, state: &mut SessionState) {
        if state
            .bindings
            .get(&self.selector)
            .is_some_and(|binding| Arc::ptr_eq(&binding.operations, &self.operations))
        {
            remove_binding(state, &self.selector);
        }
    }
}

fn binding_handles(
    state: &SessionState,
    mut reached: impl FnMut(&SessionPrincipal) -> bool,
) -> Vec<BindingHandle> {
    state
        .bindings
        .iter()
        .filter(|(_, binding)| reached(&binding.principal))
        .map(|(selector, binding)| BindingHandle {
            selector: selector.clone(),
            cancellation: binding.cancellation.clone(),
            operations: binding.operations.clone(),
        })
        .collect()
}

/// The principal's live session with the latest expiry, the one a bound
/// request's transport is allowed to outlast least.
fn live_session<'a>(
    state: &'a SessionState,
    principal: &SessionPrincipal,
    now: Instant,
) -> Option<&'a SessionRecord> {
    live_sessions(state, principal, now).max_by_key(|record| record.expires_at)
}

/// Every session of the principal that is neither revoked nor expired.
fn live_sessions<'a>(
    state: &'a SessionState,
    principal: &SessionPrincipal,
    now: Instant,
) -> impl Iterator<Item = &'a SessionRecord> {
    state
        .principal_sessions
        .get(principal)
        .into_iter()
        .flatten()
        .filter_map(|id| state.sessions.get(id))
        .filter(move |record| !record.cancellation.is_cancelled() && record.expires_at > now)
}

fn take_expired(state: &mut SessionState, now: Instant) -> Vec<SessionRecord> {
    let mut expired = Vec::new();
    while let Some(Reverse((expiry, id))) = state.expiries.peek().cloned() {
        if expiry > now {
            break;
        }
        state.expiries.pop();
        if state.sessions.get(&id).is_some_and(|record| {
            record.expires_at == expiry && !record.cancellation.is_cancelled()
        }) {
            if let Some(record) = remove_session(state, &id) {
                expired.push(record);
            }
        }
    }
    expired
}

fn browser_session_row(record: &SessionRecord) -> BrowserSessionRow {
    BrowserSessionRow {
        admin_session_id: record.admin_session_id,
        subject_user_id: record.principal.subject_user_id,
        owner_user_id: record.principal.owner_user_id,
        devserver_id: record.principal.devserver_id.clone(),
        created_at: record.created_at_wall,
        expires_at: record.expires_at_wall,
    }
}

/// Remove a session. When it was its principal's last, the principal's
/// extension bindings go with it: a binding never survives a moment in which
/// its user held no session.
fn remove_session(state: &mut SessionState, id: &str) -> Option<SessionRecord> {
    let record = state.sessions.remove(id)?;
    decrement_count(&mut state.subject_counts, &record.principal.subject_user_id);
    let last = match state.principal_sessions.get_mut(&record.principal) {
        Some(ids) => {
            ids.retain(|held| held != id);
            ids.is_empty()
        }
        None => true,
    };
    if last {
        state.principal_sessions.remove(&record.principal);
        for selector in state
            .principal_bindings
            .get(&record.principal)
            .cloned()
            .unwrap_or_default()
        {
            if let Some(binding) = remove_binding(state, &selector) {
                binding.revoke_authority();
            }
        }
    }
    Some(record)
}

fn remove_binding(state: &mut SessionState, selector: &str) -> Option<ExtensionBinding> {
    let binding = state.bindings.remove(selector)?;
    if let Some(selectors) = state.principal_bindings.get_mut(&binding.principal) {
        selectors.retain(|held| held != selector);
        if selectors.is_empty() {
            state.principal_bindings.remove(&binding.principal);
        }
    }
    Some(binding)
}

fn decrement_count<K>(counts: &mut HashMap<K, usize>, key: &K)
where
    K: Eq + std::hash::Hash,
{
    if let Some(count) = counts.get_mut(key) {
        *count -= 1;
        if *count == 0 {
            counts.remove(key);
        }
    }
}

fn random_session_id() -> String {
    random_hex(SESSION_ID_BYTES)
}

fn random_hex(len: usize) -> String {
    let mut bytes = vec![0_u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn valid_session_id(id: &str) -> bool {
    id.len() == SESSION_ID_BYTES * 2 && is_lower_hex(id)
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Split a canonical binding token into its selector and decoded verifier.
fn split_binding_token(token: &str) -> Option<(&str, [u8; BINDING_VERIFIER_BYTES])> {
    if token.len() != EXTENSION_BINDING_HEX_LEN || !is_lower_hex(token) {
        return None;
    }
    let (selector, verifier_hex) = token.split_at(BINDING_SELECTOR_BYTES * 2);
    let mut verifier = [0_u8; BINDING_VERIFIER_BYTES];
    for (byte, pair) in verifier.iter_mut().zip(verifier_hex.as_bytes().chunks(2)) {
        let pair = std::str::from_utf8(pair).ok()?;
        *byte = u8::from_str_radix(pair, 16).ok()?;
    }
    Some((selector, verifier))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(subject: u128, owner: u128, devserver_id: &str) -> SessionPrincipal {
        SessionPrincipal {
            subject_user_id: Uuid::from_u128(subject),
            owner_user_id: Uuid::from_u128(owner),
            devserver_id: devserver_id.to_string(),
            audience: format!("alice--{devserver_id}.p1.proxy.chan.app"),
        }
    }

    #[test]
    fn issue_uses_unguessable_opaque_ids_and_preserves_authority() {
        let store = SessionStore::new(2, Duration::from_secs(60));
        let first = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let second = store
            .issue(principal(2, 20, "dev-b"), ClientType::Browser)
            .expect("issue");

        assert_eq!(first.id().len(), SESSION_ID_BYTES * 2);
        assert!(first.id().bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first.id(), second.id());
        assert_eq!(
            store.lookup(first.id()).expect("session").principal,
            principal(1, 10, "dev-a")
        );
    }

    #[test]
    fn capacity_refuses_without_evicting_a_live_session() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");

        assert_eq!(
            store
                .issue(principal(2, 20, "dev-b"), ClientType::Browser)
                .err(),
            Some(IssueError::AtCapacity)
        );
        assert!(store.lookup(issued.id()).is_some());
    }

    #[test]
    fn one_subject_cannot_exhaust_global_session_capacity() {
        let store = SessionStore::with_quotas(6, Duration::from_secs(60), 2, 2);
        let attacker = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("first");
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("second");
        assert_eq!(
            store
                .issue(principal(1, 20, "dev-b"), ClientType::Browser)
                .err(),
            Some(IssueError::SubjectAtCapacity)
        );
        let neighbor = store.issue(principal(2, 10, "dev-a"), ClientType::Browser);
        assert!(neighbor.is_ok(), "neighbor retains reserved capacity");
        assert!(store.lookup(attacker.id()).is_some());
    }

    #[test]
    fn one_principal_cannot_consume_a_subjects_whole_quota() {
        let store = SessionStore::with_quotas(6, Duration::from_secs(60), 4, 2);
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("first");
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("second");
        assert_eq!(
            store
                .issue(principal(1, 10, "dev-a"), ClientType::Browser)
                .err(),
            Some(IssueError::PrincipalAtCapacity)
        );
        assert!(store
            .issue(principal(1, 10, "dev-b"), ClientType::Browser)
            .is_ok());
    }

    #[tokio::test]
    async fn revocation_releases_subject_and_principal_quotas() {
        let store = SessionStore::with_quotas(6, Duration::from_secs(60), 1, 1);
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("first");
        assert_eq!(
            store
                .issue(principal(1, 10, "dev-a"), ClientType::Browser)
                .err(),
            Some(IssueError::SubjectAtCapacity)
        );
        assert_eq!(
            store
                .revoke(&Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                })
                .await,
            Ok(1)
        );
        assert!(store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .is_ok());
    }

    #[test]
    fn lookup_rejects_noncanonical_ids() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");

        assert!(store.lookup("").is_none());
        assert!(store.lookup(&issued.id().to_ascii_uppercase()).is_none());
        assert!(store.lookup(&format!("{}0", issued.id())).is_none());
        assert!(store.lookup(issued.id()).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_fails_closed_and_cancels_active_streams() {
        let store = SessionStore::new(1, Duration::from_secs(30));
        let issued = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let cancellation = issued.record.cancellation.clone();

        tokio::time::advance(Duration::from_secs(31)).await;

        assert!(store.lookup(issued.id()).is_none());
        assert!(cancellation.is_cancelled());
        assert!(store.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn issue_prunes_only_due_expiry_index_entries_before_capacity_check() {
        let store = SessionStore::new(1, Duration::from_secs(30));
        let expired = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        tokio::time::advance(Duration::from_secs(31)).await;

        let replacement = store
            .issue(principal(2, 20, "dev-b"), ClientType::Browser)
            .expect("expired capacity is reclaimed");
        assert!(expired.record.cancellation.is_cancelled());
        assert!(store.lookup(replacement.id()).is_some());
        assert_eq!(store.len(), 1);
    }

    #[tokio::test]
    async fn revocation_leaves_harmless_stale_expiry_index_entries() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let removed = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        assert_eq!(
            store
                .revoke(&Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                })
                .await,
            Ok(1)
        );
        let replacement = store
            .issue(principal(2, 20, "dev-b"), ClientType::Browser)
            .expect("stale expiry entry does not consume capacity");
        assert!(removed.record.cancellation.is_cancelled());
        assert!(store.lookup(replacement.id()).is_some());
    }

    #[tokio::test]
    async fn exact_revoke_cannot_cross_owner_or_devserver() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        let target = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let other_owner = store
            .issue(principal(1, 20, "dev-a"), ClientType::Browser)
            .expect("issue");
        let other_devserver = store
            .issue(principal(1, 10, "dev-b"), ClientType::Browser)
            .expect("issue");

        let revoked = store
            .revoke(&Revocation::Exact {
                subject_user_id: Uuid::from_u128(1),
                owner_user_id: Uuid::from_u128(10),
                devserver_id: "dev-a".to_string(),
            })
            .await;

        assert_eq!(revoked, Ok(1));
        assert!(target.record.cancellation.is_cancelled());
        assert!(!other_owner.record.cancellation.is_cancelled());
        assert!(!other_devserver.record.cancellation.is_cancelled());
        assert!(store.lookup(target.id()).is_none());
        assert!(store.lookup(other_owner.id()).is_some());
        assert!(store.lookup(other_devserver.id()).is_some());
    }

    #[tokio::test]
    async fn subject_revoke_cancels_every_matching_session_only() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        let first = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let second = store
            .issue(principal(1, 20, "dev-b"), ClientType::Browser)
            .expect("issue");
        let untouched = store
            .issue(principal(2, 10, "dev-a"), ClientType::Browser)
            .expect("issue");

        assert_eq!(
            store
                .revoke(&Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                })
                .await,
            Ok(2)
        );
        assert!(first.record.cancellation.is_cancelled());
        assert!(second.record.cancellation.is_cancelled());
        assert!(!untouched.record.cancellation.is_cancelled());
        assert_eq!(store.len(), 1);
    }

    #[tokio::test]
    async fn admin_owner_and_all_revocations_target_redacted_inventory_ids() {
        let store = SessionStore::new(6, Duration::from_secs(60));
        let first = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let second = store
            .issue(principal(2, 10, "dev-b"), ClientType::Browser)
            .expect("issue");
        let third = store
            .issue(principal(3, 20, "dev-c"), ClientType::Browser)
            .expect("issue");
        let cookie_id = first.id().to_string();
        let admin_id = first.record.admin_session_id;

        let (snapshot, _) = store.snapshot_and_subscribe();
        assert_eq!(snapshot.len(), 3);
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains(&cookie_id));
        assert!(encoded.contains(&admin_id.to_string()));

        assert_eq!(
            store
                .revoke(&Revocation::SessionId {
                    admin_session_id: admin_id,
                })
                .await,
            Ok(1)
        );
        assert!(first.record.cancellation.is_cancelled());
        assert_eq!(
            store
                .revoke(&Revocation::Owner {
                    owner_user_id: Uuid::from_u128(10),
                })
                .await,
            Ok(1)
        );
        assert!(second.record.cancellation.is_cancelled());
        assert!(!third.record.cancellation.is_cancelled());
        assert_eq!(store.revoke(&Revocation::All).await, Ok(1));
        assert!(third.record.cancellation.is_cancelled());
        assert!(store.is_empty());
    }

    #[tokio::test]
    async fn clear_cancels_and_drains_every_session_for_fail_closed_control_loss() {
        let store = SessionStore::new(2, Duration::from_secs(60));
        let first = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let second = store
            .issue(principal(2, 20, "dev-b"), ClientType::Browser)
            .expect("issue");

        assert_eq!(store.clear().await, Ok(2));
        assert!(first.record.cancellation.is_cancelled());
        assert!(second.record.cancellation.is_cancelled());
        assert!(store.is_empty());
        assert_eq!(
            store
                .issue(principal(3, 30, "dev-c"), ClientType::Browser)
                .err(),
            Some(IssueError::AuthoritySuspended)
        );
        store.resume_authority();
        assert!(store
            .issue(principal(3, 30, "dev-c"), ClientType::Browser)
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn control_loss_clear_retains_a_tombstone_until_transport_drain_is_proven() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let operation = issued
            .record
            .begin_operation()
            .expect("active operation without a task");
        let revocation = Revocation::Subject {
            subject_user_id: Uuid::from_u128(1),
        };

        assert_eq!(store.clear().await, Err(RevokeError::DrainTimedOut));
        assert!(store.lookup(issued.id()).is_none());
        assert_eq!(
            store.revoke(&revocation).await,
            Err(RevokeError::DrainTimedOut),
            "reconvergence must not erase a control-loss drain failure"
        );

        drop(operation);
        assert_eq!(store.revoke(&revocation).await, Ok(1));
        assert!(store.is_empty());
    }

    async fn blocked_transport(
        operation: ActiveOperation,
        stopped: tokio::sync::oneshot::Sender<()>,
    ) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        tx.send(()).await.expect("buffer first item");
        let task = operation.spawn(async move {
            let _stopped = StopNotice(Some(stopped));
            tx.send(()).await.expect("receiver remains alive");
            let _ = rx.recv().await;
        });
        // The second send is blocked behind a full buffer. Detach so only the
        // revocation registry can stop the simulated non-reading transport.
        drop(task);
        tokio::task::yield_now().await;
    }

    struct StopNotice(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for StopNotice {
        fn drop(&mut self) {
            if let Some(stopped) = self.0.take() {
                let _ = stopped.send(());
            }
        }
    }

    #[tokio::test]
    async fn exact_revoke_force_aborts_nonreading_http_bridge_before_ack() {
        let store = SessionStore::new(2, Duration::from_secs(60));
        let target = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let untouched = store
            .issue(principal(2, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let (stopped_tx, stopped_rx) = tokio::sync::oneshot::channel();
        blocked_transport(
            target.record.begin_operation().expect("active authority"),
            stopped_tx,
        )
        .await;

        assert_eq!(
            store
                .revoke(&Revocation::Exact {
                    subject_user_id: Uuid::from_u128(1),
                    owner_user_id: Uuid::from_u128(10),
                    devserver_id: "dev-a".to_string(),
                })
                .await,
            Ok(1)
        );
        stopped_rx
            .await
            .expect("bridge task stopped before revoke acknowledged");
        assert!(target.record.begin_operation().is_none());
        assert!(untouched.record.begin_operation().is_some());
    }

    #[tokio::test]
    async fn subject_revoke_force_aborts_nonreading_websocket_bridges_before_ack() {
        let store = SessionStore::new(3, Duration::from_secs(60));
        let first = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let second = store
            .issue(principal(1, 20, "dev-b"), ClientType::Browser)
            .expect("issue");
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        let (second_tx, second_rx) = tokio::sync::oneshot::channel();
        blocked_transport(
            first.record.begin_operation().expect("active authority"),
            first_tx,
        )
        .await;
        blocked_transport(
            second.record.begin_operation().expect("active authority"),
            second_tx,
        )
        .await;

        assert_eq!(
            store
                .revoke(&Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                })
                .await,
            Ok(2)
        );
        first_rx.await.expect("first bridge stopped before ack");
        second_rx.await.expect("second bridge stopped before ack");
    }

    #[tokio::test(start_paused = true)]
    async fn revoke_refuses_to_ack_when_an_operation_cannot_be_force_aborted() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let _unattached = issued
            .record
            .begin_operation()
            .expect("active operation without a task");

        assert_eq!(
            store
                .revoke(&Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                })
                .await,
            Err(RevokeError::DrainTimedOut)
        );
    }

    fn target(capability: char) -> ExtensionTarget {
        ExtensionTarget {
            tenant: "notes".to_string(),
            extension_id: "echo".to_string(),
            capability: capability.to_string().repeat(64),
        }
    }

    #[test]
    fn a_binding_resolves_to_its_principal_only_with_the_exact_token() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        let session = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let token = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");

        assert_eq!(token.len(), EXTENSION_BINDING_HEX_LEN);
        assert!(is_lower_hex(&token));
        let resolved = store.resolve_extension_binding(&token).expect("resolve");
        assert_eq!(resolved.target, target('a'));
        assert_eq!(resolved.authorization.principal, principal(1, 10, "dev-a"));
        assert_eq!(
            resolved.authorization.admin_session_id,
            session.record.admin_session_id
        );
        assert_eq!(resolved.authorization.expires_at, session.record.expires_at);

        let last = token.chars().last().unwrap();
        let wrong_verifier = format!(
            "{}{}",
            &token[..token.len() - 1],
            if last == '0' { '1' } else { '0' }
        );
        for wrong in [
            wrong_verifier,
            token.to_ascii_uppercase(),
            token[..token.len() - 2].to_string(),
            format!("{token}0"),
            String::new(),
        ] {
            assert!(store.resolve_extension_binding(&wrong).is_none(), "{wrong}");
        }
        assert!(store.resolve_extension_binding(&token).is_some());
    }

    #[test]
    fn a_principal_with_no_live_session_cannot_bind() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        assert_eq!(
            store.bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a')),
            Err(BindError::NoLiveSession)
        );
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        // A session for the same subject on another devserver is another
        // principal.
        assert_eq!(
            store.bind_extension(&principal(1, 10, "dev-b"), ClientType::Browser, target('a')),
            Err(BindError::NoLiveSession)
        );
    }

    /// The same user signing in again before the first session's hour runs
    /// out keeps an open extension tab working: the binding rides the renewed
    /// session and its transports take that session's expiry.
    #[tokio::test(start_paused = true)]
    async fn a_binding_survives_the_principal_renewing_its_session() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("first session");
        let token = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");

        tokio::time::advance(Duration::from_secs(40)).await;
        let renewed = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("renewal");
        tokio::time::advance(Duration::from_secs(30)).await;

        let resolved = store
            .resolve_extension_binding(&token)
            .expect("the binding outlives the minting session");
        assert_eq!(
            resolved.authorization.admin_session_id,
            renewed.record.admin_session_id
        );
        assert_eq!(resolved.authorization.expires_at, renewed.record.expires_at);
    }

    /// A moment with no live session ends a binding for good, whether the
    /// store notices at the next sign-in or at the next bound request.
    #[tokio::test(start_paused = true)]
    async fn a_binding_dies_when_its_principal_goes_without_a_session() {
        let store = SessionStore::new(4, Duration::from_secs(30));
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let noticed_at_sign_in = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");
        tokio::time::advance(Duration::from_secs(31)).await;
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("sign in again");
        assert!(store
            .resolve_extension_binding(&noticed_at_sign_in)
            .is_none());
        assert_eq!(store.binding_count(), 0);

        let noticed_at_request = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('b'))
            .expect("bind under the new session");
        tokio::time::advance(Duration::from_secs(31)).await;
        assert!(store
            .resolve_extension_binding(&noticed_at_request)
            .is_none());
        assert_eq!(store.binding_count(), 0);
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("sign in again");
        assert!(store
            .resolve_extension_binding(&noticed_at_request)
            .is_none());
    }

    /// Every revocation form that reaches the principal deletes its binding
    /// and stops a transport admitted through it before acknowledging. An
    /// admin-session revocation reaches the principal of the session it
    /// names even while that principal holds another live session.
    #[tokio::test]
    async fn every_revocation_that_reaches_the_principal_ends_its_bindings() {
        let revocations = |session: Uuid| {
            vec![
                Revocation::Exact {
                    subject_user_id: Uuid::from_u128(1),
                    owner_user_id: Uuid::from_u128(10),
                    devserver_id: "dev-a".to_string(),
                },
                Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                },
                Revocation::Owner {
                    owner_user_id: Uuid::from_u128(10),
                },
                Revocation::All,
                Revocation::SessionId {
                    admin_session_id: session,
                },
            ]
        };
        for index in 0..5 {
            let store = SessionStore::new(8, Duration::from_secs(60));
            let first = store
                .issue(principal(1, 10, "dev-a"), ClientType::Browser)
                .expect("issue");
            store
                .issue(principal(1, 10, "dev-a"), ClientType::Browser)
                .expect("second session");
            let token = store
                .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
                .expect("bind");
            let revocation = revocations(first.record.admin_session_id).remove(index);
            let authorization = store
                .resolve_extension_binding(&token)
                .expect("resolve")
                .authorization;
            let (stopped_tx, stopped_rx) = tokio::sync::oneshot::channel();
            blocked_transport(
                authorization.begin_operation().expect("active binding"),
                stopped_tx,
            )
            .await;

            assert!(store.revoke(&revocation).await.is_ok(), "{revocation:?}");
            // Bounded, so a revocation that misses the binding fails here
            // instead of waiting forever on a transport nothing aborts.
            tokio::time::timeout(Duration::from_secs(5), stopped_rx)
                .await
                .unwrap_or_else(|_| panic!("{revocation:?}: transport still running after ack"))
                .unwrap_or_else(|_| panic!("{revocation:?}: transport stopped before ack"));
            assert!(authorization.cancellation.is_cancelled(), "{revocation:?}");
            assert!(authorization.begin_operation().is_none(), "{revocation:?}");
            assert!(
                store.resolve_extension_binding(&token).is_none(),
                "{revocation:?}"
            );
            assert_eq!(store.binding_count(), 0, "{revocation:?}");
        }
    }

    #[tokio::test]
    async fn a_revocation_that_misses_the_principal_leaves_its_binding() {
        let store = SessionStore::new(8, Duration::from_secs(60));
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let other = store
            .issue(principal(2, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let token = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");

        for revocation in [
            Revocation::Exact {
                subject_user_id: Uuid::from_u128(1),
                owner_user_id: Uuid::from_u128(10),
                devserver_id: "dev-b".to_string(),
            },
            Revocation::Subject {
                subject_user_id: Uuid::from_u128(2),
            },
            Revocation::Owner {
                owner_user_id: Uuid::from_u128(20),
            },
            Revocation::SessionId {
                admin_session_id: other.record.admin_session_id,
            },
        ] {
            store.revoke(&revocation).await.expect("revoke");
            assert!(
                store.resolve_extension_binding(&token).is_some(),
                "{revocation:?}"
            );
        }
    }

    #[tokio::test]
    async fn clearing_the_store_ends_every_binding() {
        let store = SessionStore::new(8, Duration::from_secs(60));
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        store
            .issue(principal(2, 20, "dev-b"), ClientType::Browser)
            .expect("issue");
        let first = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");
        let second = store
            .bind_extension(&principal(2, 20, "dev-b"), ClientType::Browser, target('b'))
            .expect("bind");

        assert_eq!(store.clear().await, Ok(2));
        assert!(store.resolve_extension_binding(&first).is_none());
        assert!(store.resolve_extension_binding(&second).is_none());
        assert_eq!(store.binding_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_binding_transport_that_will_not_drain_keeps_the_revocation_pending() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let token = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");
        let operation = store
            .resolve_extension_binding(&token)
            .expect("resolve")
            .authorization
            .begin_operation()
            .expect("active operation without a task");
        let revocation = Revocation::Subject {
            subject_user_id: Uuid::from_u128(1),
        };

        assert_eq!(
            store.revoke(&revocation).await,
            Err(RevokeError::DrainTimedOut)
        );
        assert!(store.resolve_extension_binding(&token).is_none());
        assert_eq!(
            store.revoke(&revocation).await,
            Err(RevokeError::DrainTimedOut),
            "a retry must not confirm while the binding's transport is live"
        );

        drop(operation);
        assert_eq!(store.revoke(&revocation).await, Ok(1));
        assert_eq!(store.binding_count(), 0);
    }

    /// Reloading frames rotates a principal through its quota: the least
    /// recently used binding goes, a binding in use stays.
    #[tokio::test(start_paused = true)]
    async fn a_principal_reloading_frames_evicts_its_least_recently_used_binding() {
        let store = SessionStore::with_binding_quotas(4, Duration::from_secs(600), 100, 2);
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let bind = |capability| {
            store
                .bind_extension(
                    &principal(1, 10, "dev-a"),
                    ClientType::Browser,
                    target(capability),
                )
                .expect("bind")
        };
        let first = bind('a');
        tokio::time::advance(Duration::from_secs(1)).await;
        let second = bind('b');
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(store.resolve_extension_binding(&first).is_some());
        tokio::time::advance(Duration::from_secs(1)).await;

        let third = bind('c');
        assert_eq!(store.binding_count(), 2);
        assert!(store.resolve_extension_binding(&second).is_none());
        assert!(store.resolve_extension_binding(&first).is_some());
        assert!(store.resolve_extension_binding(&third).is_some());
    }

    #[test]
    fn a_full_binding_table_refuses_without_evicting_another_users_binding() {
        let store = SessionStore::with_binding_quotas(4, Duration::from_secs(60), 2, 32);
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        store
            .issue(principal(2, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let first = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('a'))
            .expect("bind");
        let second = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('b'))
            .expect("bind");

        assert_eq!(
            store.bind_extension(&principal(2, 10, "dev-a"), ClientType::Browser, target('c')),
            Err(BindError::AtCapacity)
        );
        assert!(store.resolve_extension_binding(&first).is_some());
        assert!(store.resolve_extension_binding(&second).is_some());
    }

    #[test]
    fn the_default_binding_quotas_follow_the_session_capacity() {
        let store = SessionStore::new(10_000, Duration::from_secs(60));
        assert_eq!(store.max_bindings, 40_000);
        assert_eq!(store.max_bindings_per_principal, 32);
    }

    #[tokio::test(start_paused = true)]
    async fn retried_revoke_keeps_timed_out_transport_pending_until_it_drains() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("issue");
        let operation = issued
            .record
            .begin_operation()
            .expect("active operation without a task");
        let revocation = Revocation::Subject {
            subject_user_id: Uuid::from_u128(1),
        };

        assert_eq!(
            store.revoke(&revocation).await,
            Err(RevokeError::DrainTimedOut)
        );
        assert!(store.lookup(issued.id()).is_none());
        assert_eq!(
            store.revoke(&revocation).await,
            Err(RevokeError::DrainTimedOut),
            "a retry must not confirm while the first command's transport is live"
        );

        drop(operation);
        assert_eq!(store.revoke(&revocation).await, Ok(1));
        assert!(store.is_empty());
    }

    /// The client is an attribute of a session, not part of its principal. A
    /// user's desktop session and browser session on one devserver share the
    /// principal's quota, and every revocation form reaches the principal's
    /// binding whichever of the two sessions minted it: exact, subject, owner
    /// and all revoke both sessions, and an admin-session revocation of either
    /// one ends the binding the other keeps alive.
    #[tokio::test]
    async fn a_users_desktop_and_browser_sessions_are_one_principal() {
        let store = SessionStore::with_quotas(8, Duration::from_secs(60), 8, 2);
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Desktop)
            .expect("desktop session");
        store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("browser session");
        for client in [
            ClientType::Desktop,
            ClientType::Browser,
            ClientType::Unknown,
        ] {
            assert_eq!(
                store.issue(principal(1, 10, "dev-a"), client).err(),
                Some(IssueError::PrincipalAtCapacity),
                "{client:?}"
            );
        }

        let revocations = |session: Uuid| {
            vec![
                Revocation::Exact {
                    subject_user_id: Uuid::from_u128(1),
                    owner_user_id: Uuid::from_u128(10),
                    devserver_id: "dev-a".to_string(),
                },
                Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                },
                Revocation::Owner {
                    owner_user_id: Uuid::from_u128(10),
                },
                Revocation::All,
                Revocation::SessionId {
                    admin_session_id: session,
                },
            ]
        };
        for index in 0..5 {
            for (named_client, other_client) in [
                (ClientType::Desktop, ClientType::Browser),
                (ClientType::Browser, ClientType::Desktop),
            ] {
                for binding_client in [named_client, other_client] {
                    let store = SessionStore::new(8, Duration::from_secs(60));
                    let named = store
                        .issue(principal(1, 10, "dev-a"), named_client)
                        .expect("named session");
                    let other = store
                        .issue(principal(1, 10, "dev-a"), other_client)
                        .expect("other session");
                    let token = store
                        .bind_extension(&principal(1, 10, "dev-a"), binding_client, target('a'))
                        .expect("bind");
                    let revocation = revocations(named.record.admin_session_id).remove(index);
                    let by_session = matches!(revocation, Revocation::SessionId { .. });
                    let case = format!(
                        "{revocation:?} naming the {named_client:?} session, binding minted by {binding_client:?}"
                    );

                    let revoked = store.revoke(&revocation).await.expect("revoke");
                    assert_eq!(revoked, if by_session { 1 } else { 2 }, "{case}");
                    assert!(store.lookup(named.id()).is_none(), "{case}");
                    assert_eq!(store.lookup(other.id()).is_some(), by_session, "{case}");
                    assert!(store.resolve_extension_binding(&token).is_none(), "{case}");
                    assert_eq!(store.binding_count(), 0, "{case}");
                }
            }
        }
    }

    #[test]
    fn a_session_keeps_the_client_its_credential_was_minted_for() {
        let store = SessionStore::new(8, Duration::from_secs(60));
        for client in [
            ClientType::Desktop,
            ClientType::Browser,
            ClientType::Unknown,
        ] {
            let issued = store
                .issue(principal(1, 10, "dev-a"), client)
                .expect("issue");
            assert_eq!(issued.record.client, client);
            assert_eq!(store.lookup(issued.id()).expect("lookup").client, client);
        }
    }

    /// A bound request is asserted as the client whose session minted the
    /// binding while that client holds a live session for the principal. Once
    /// only another client's session keeps the binding alive, it is asserted as
    /// unknown, never as the other client and never as the one that left; a
    /// fresh session of the minting client restores it.
    #[tokio::test(start_paused = true)]
    async fn a_bound_request_carries_the_minting_client_only_while_that_client_holds_a_session() {
        let store = SessionStore::new(8, Duration::from_secs(60));
        let desktop = store
            .issue(principal(1, 10, "dev-a"), ClientType::Desktop)
            .expect("desktop session");
        let desktop_token = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Desktop, target('a'))
            .expect("desktop binding");
        tokio::time::advance(Duration::from_secs(30)).await;
        let browser = store
            .issue(principal(1, 10, "dev-a"), ClientType::Browser)
            .expect("browser session");
        let browser_token = store
            .bind_extension(&principal(1, 10, "dev-a"), ClientType::Browser, target('b'))
            .expect("browser binding");

        let client_of = |token: &str| {
            store
                .resolve_extension_binding(token)
                .expect("live binding")
                .authorization
                .client
        };
        assert_eq!(client_of(&desktop_token), ClientType::Desktop);
        assert_eq!(client_of(&browser_token), ClientType::Browser);

        // The desktop session lapses; the browser session keeps both bindings.
        tokio::time::advance(Duration::from_secs(31)).await;
        assert!(store.lookup(desktop.id()).is_none());
        let resolved = store
            .resolve_extension_binding(&desktop_token)
            .expect("the browser session keeps the binding alive");
        assert_eq!(resolved.authorization.client, ClientType::Unknown);
        assert_eq!(
            resolved.authorization.admin_session_id,
            browser.record.admin_session_id
        );
        assert_eq!(client_of(&browser_token), ClientType::Browser);

        store
            .issue(principal(1, 10, "dev-a"), ClientType::Desktop)
            .expect("the desktop signs in again");
        assert_eq!(client_of(&desktop_token), ClientType::Desktop);
    }
}
