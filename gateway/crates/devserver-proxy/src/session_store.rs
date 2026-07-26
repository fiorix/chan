use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use devserver_control_proto::BrowserSessionRow;
use rand::RngCore;
use tokio::sync::{broadcast, Notify};
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SESSION_ID_BYTES: usize = 32;
const MAX_SESSIONS_PER_SUBJECT: usize = 64;
const MAX_SESSIONS_PER_PRINCIPAL: usize = 16;
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

#[derive(Clone)]
pub struct SessionRecord {
    pub admin_session_id: Uuid,
    pub principal: SessionPrincipal,
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

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<SessionState>>,
    events: broadcast::Sender<SessionEvent>,
    max_sessions: usize,
    max_sessions_per_subject: usize,
    max_sessions_per_principal: usize,
    lifetime: Duration,
}

#[derive(Default)]
struct SessionState {
    authority_suspended: bool,
    sessions: HashMap<String, SessionRecord>,
    expiries: BinaryHeap<Reverse<(Instant, String)>>,
    subject_counts: HashMap<Uuid, usize>,
    principal_counts: HashMap<SessionPrincipal, usize>,
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
        let (events, _) = broadcast::channel(max_sessions.saturating_mul(2).clamp(128, 65_536));
        Self {
            inner: Arc::new(Mutex::new(SessionState::default())),
            events,
            max_sessions,
            max_sessions_per_subject,
            max_sessions_per_principal,
            lifetime,
        }
    }

    pub fn issue(&self, principal: SessionPrincipal) -> Result<IssuedSession, IssueError> {
        let now = Instant::now();
        let wall_now = Utc::now();
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if state.authority_suspended {
            return Err(IssueError::AuthoritySuspended);
        }
        let expired = take_expired(&mut state, now);
        for record in expired {
            record.revoke_authority();
            let _ = self
                .events
                .send(SessionEvent::Down(record.admin_session_id));
        }
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
        if state
            .principal_counts
            .get(&principal)
            .copied()
            .unwrap_or_default()
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
        *state
            .principal_counts
            .entry(record.principal.clone())
            .or_default() += 1;
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

    pub async fn revoke(&self, revocation: &Revocation) -> Result<usize, RevokeError> {
        let revoked = {
            let state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            state
                .sessions
                .iter()
                .filter(|(_, record)| revocation.matches(record))
                .map(|(id, record)| (id.clone(), record.clone()))
                .collect::<Vec<_>>()
        };

        for (_, record) in &revoked {
            record.revoke_authority();
        }
        let deadline = Instant::now() + REVOCATION_DRAIN_TIMEOUT;
        for (_, record) in &revoked {
            if !record.operations.wait_drained(deadline).await {
                return Err(RevokeError::DrainTimedOut);
            }
        }

        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        for (id, _) in &revoked {
            if let Some(record) = remove_session(&mut state, id) {
                let _ = self
                    .events
                    .send(SessionEvent::Down(record.admin_session_id));
            }
        }
        Ok(revoked.len())
    }

    pub async fn clear(&self) -> Result<usize, RevokeError> {
        let cleared = {
            let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
            // Grace expiry is an authority boundary. Suspending issuance in
            // the same critical section closes the race with an entry
            // exchange that captured a registry row before tunnel eviction.
            state.authority_suspended = true;
            state
                .sessions
                .iter()
                .map(|(id, record)| (id.clone(), record.clone()))
                .collect::<Vec<_>>()
        };

        for (_, record) in &cleared {
            record.revoke_authority();
        }
        let deadline = Instant::now() + REVOCATION_DRAIN_TIMEOUT;
        for (_, record) in &cleared {
            if !record.operations.wait_drained(deadline).await {
                return Err(RevokeError::DrainTimedOut);
            }
        }

        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        for (id, _) in &cleared {
            if let Some(record) = remove_session(&mut state, id) {
                let _ = self
                    .events
                    .send(SessionEvent::Down(record.admin_session_id));
            }
        }
        Ok(cleared.len())
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
            Self::Exact {
                subject_user_id,
                owner_user_id,
                devserver_id,
            } => {
                record.principal.subject_user_id == *subject_user_id
                    && record.principal.owner_user_id == *owner_user_id
                    && record.principal.devserver_id == *devserver_id
            }
            Self::Subject { subject_user_id } => {
                record.principal.subject_user_id == *subject_user_id
            }
            Self::SessionId { admin_session_id } => record.admin_session_id == *admin_session_id,
            Self::Owner { owner_user_id } => record.principal.owner_user_id == *owner_user_id,
            Self::All => true,
        }
    }
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

fn remove_session(state: &mut SessionState, id: &str) -> Option<SessionRecord> {
    let record = state.sessions.remove(id)?;
    decrement_count(&mut state.subject_counts, &record.principal.subject_user_id);
    decrement_count(&mut state.principal_counts, &record.principal);
    Some(record)
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
    let mut bytes = [0_u8; SESSION_ID_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut encoded = String::with_capacity(SESSION_ID_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn valid_session_id(id: &str) -> bool {
    id.len() == SESSION_ID_BYTES * 2
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(subject: u128, owner: u128, devserver_id: &str) -> SessionPrincipal {
        SessionPrincipal {
            subject_user_id: Uuid::from_u128(subject),
            owner_user_id: Uuid::from_u128(owner),
            devserver_id: devserver_id.to_string(),
            audience: format!("alice--{devserver_id}.p1.usr.chan.app"),
        }
    }

    #[test]
    fn issue_uses_unguessable_opaque_ids_and_preserves_authority() {
        let store = SessionStore::new(2, Duration::from_secs(60));
        let first = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let second = store.issue(principal(2, 20, "dev-b")).expect("issue");

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
        let issued = store.issue(principal(1, 10, "dev-a")).expect("issue");

        assert_eq!(
            store.issue(principal(2, 20, "dev-b")).err(),
            Some(IssueError::AtCapacity)
        );
        assert!(store.lookup(issued.id()).is_some());
    }

    #[test]
    fn one_subject_cannot_exhaust_global_session_capacity() {
        let store = SessionStore::with_quotas(6, Duration::from_secs(60), 2, 2);
        let attacker = store.issue(principal(1, 10, "dev-a")).expect("first");
        store.issue(principal(1, 10, "dev-a")).expect("second");
        assert_eq!(
            store.issue(principal(1, 20, "dev-b")).err(),
            Some(IssueError::SubjectAtCapacity)
        );
        let neighbor = store.issue(principal(2, 10, "dev-a"));
        assert!(neighbor.is_ok(), "neighbor retains reserved capacity");
        assert!(store.lookup(attacker.id()).is_some());
    }

    #[test]
    fn one_principal_cannot_consume_a_subjects_whole_quota() {
        let store = SessionStore::with_quotas(6, Duration::from_secs(60), 4, 2);
        store.issue(principal(1, 10, "dev-a")).expect("first");
        store.issue(principal(1, 10, "dev-a")).expect("second");
        assert_eq!(
            store.issue(principal(1, 10, "dev-a")).err(),
            Some(IssueError::PrincipalAtCapacity)
        );
        assert!(store.issue(principal(1, 10, "dev-b")).is_ok());
    }

    #[tokio::test]
    async fn revocation_releases_subject_and_principal_quotas() {
        let store = SessionStore::with_quotas(6, Duration::from_secs(60), 1, 1);
        store.issue(principal(1, 10, "dev-a")).expect("first");
        assert_eq!(
            store.issue(principal(1, 10, "dev-a")).err(),
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
        assert!(store.issue(principal(1, 10, "dev-a")).is_ok());
    }

    #[test]
    fn lookup_rejects_noncanonical_ids() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store.issue(principal(1, 10, "dev-a")).expect("issue");

        assert!(store.lookup("").is_none());
        assert!(store.lookup(&issued.id().to_ascii_uppercase()).is_none());
        assert!(store.lookup(&format!("{}0", issued.id())).is_none());
        assert!(store.lookup(issued.id()).is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_fails_closed_and_cancels_active_streams() {
        let store = SessionStore::new(1, Duration::from_secs(30));
        let issued = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let cancellation = issued.record.cancellation.clone();

        tokio::time::advance(Duration::from_secs(31)).await;

        assert!(store.lookup(issued.id()).is_none());
        assert!(cancellation.is_cancelled());
        assert!(store.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn issue_prunes_only_due_expiry_index_entries_before_capacity_check() {
        let store = SessionStore::new(1, Duration::from_secs(30));
        let expired = store.issue(principal(1, 10, "dev-a")).expect("issue");
        tokio::time::advance(Duration::from_secs(31)).await;

        let replacement = store
            .issue(principal(2, 20, "dev-b"))
            .expect("expired capacity is reclaimed");
        assert!(expired.record.cancellation.is_cancelled());
        assert!(store.lookup(replacement.id()).is_some());
        assert_eq!(store.len(), 1);
    }

    #[tokio::test]
    async fn revocation_leaves_harmless_stale_expiry_index_entries() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let removed = store.issue(principal(1, 10, "dev-a")).expect("issue");
        assert_eq!(
            store
                .revoke(&Revocation::Subject {
                    subject_user_id: Uuid::from_u128(1),
                })
                .await,
            Ok(1)
        );
        let replacement = store
            .issue(principal(2, 20, "dev-b"))
            .expect("stale expiry entry does not consume capacity");
        assert!(removed.record.cancellation.is_cancelled());
        assert!(store.lookup(replacement.id()).is_some());
    }

    #[tokio::test]
    async fn exact_revoke_cannot_cross_owner_or_devserver() {
        let store = SessionStore::new(4, Duration::from_secs(60));
        let target = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let other_owner = store.issue(principal(1, 20, "dev-a")).expect("issue");
        let other_devserver = store.issue(principal(1, 10, "dev-b")).expect("issue");

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
        let first = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let second = store.issue(principal(1, 20, "dev-b")).expect("issue");
        let untouched = store.issue(principal(2, 10, "dev-a")).expect("issue");

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
        let first = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let second = store.issue(principal(2, 10, "dev-b")).expect("issue");
        let third = store.issue(principal(3, 20, "dev-c")).expect("issue");
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
        let first = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let second = store.issue(principal(2, 20, "dev-b")).expect("issue");

        assert_eq!(store.clear().await, Ok(2));
        assert!(first.record.cancellation.is_cancelled());
        assert!(second.record.cancellation.is_cancelled());
        assert!(store.is_empty());
        assert_eq!(
            store.issue(principal(3, 30, "dev-c")).err(),
            Some(IssueError::AuthoritySuspended)
        );
        store.resume_authority();
        assert!(store.issue(principal(3, 30, "dev-c")).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn control_loss_clear_retains_a_tombstone_until_transport_drain_is_proven() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store.issue(principal(1, 10, "dev-a")).expect("issue");
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
        let target = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let untouched = store.issue(principal(2, 10, "dev-a")).expect("issue");
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
        let first = store.issue(principal(1, 10, "dev-a")).expect("issue");
        let second = store.issue(principal(1, 20, "dev-b")).expect("issue");
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
        let issued = store.issue(principal(1, 10, "dev-a")).expect("issue");
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

    #[tokio::test(start_paused = true)]
    async fn retried_revoke_keeps_timed_out_transport_pending_until_it_drains() {
        let store = SessionStore::new(1, Duration::from_secs(60));
        let issued = store.issue(principal(1, 10, "dev-a")).expect("issue");
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
}
