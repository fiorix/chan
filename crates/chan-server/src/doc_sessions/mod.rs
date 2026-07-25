//! Live document sessions: the server-side authority for collaborative
//! editing over `@codemirror/collab`'s update-log model.
//!
//! One `DocSession` per attached workspace-relative path. Clients push
//! `{version, updates}` batches; the authority accepts a batch only at
//! the matching version (a stale push is answered `push-stale` and the
//! client rebases), applies it all-or-nothing through the pure UTF-16
//! applier in [`changes`], appends to a bounded update log, and fans
//! the committed updates to every attachment, including the sender
//! (the own-clientID echo is the sender's confirmation). The authority
//! never transforms.
//!
//! Fan-out uses one unbounded mpsc outbox per attachment, and every
//! server->client frame is enqueued while the session state lock is
//! held: doc updates are keystroke-scale and must never drop or
//! reorder (a lost update permanently desyncs a client), so each
//! socket sees a strict per-session FIFO consistent with version
//! order. The wire shapes come from `crate::routes::doc`, the single
//! source for the doc ws contract.
//!
//! While a session is live the server is the single writer to disk:
//! the flusher debounces dirty sessions to atomic CAS writes, and the
//! reconciler adopts clean external writes as synthetic `$disk`
//! updates and retains dirty divergence for three-way resolution.
//! Because a
//! filesystem's mtime and read-after-write cannot be trusted to
//! identify our own flush echoes (network FUSE mounts re-stamp mtime
//! and serve stale/empty reads), the reconciler also checks disk
//! content against the session's [`DiskEchoRing`] and defers
//! suspicious fold-ins until a second observation corroborates them.
//!
//! State locks are std mutexes with short critical sections, never
//! held across await; lock order is registry map, then session state.
//! Each session additionally has an async `io_lock` serializing its
//! flush and reconcile disk IO end to end (token capture through
//! commit), acquired before any state lock and held across those
//! awaits; without it a reconcile can classify the disk between a
//! flush's write and its token commit and mistake the flush's own
//! echo for an external edit.

pub mod changes;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chan_workspace::{
    semantic_write_budget, ChanError, FileStat, WatchEvent, WatchKind, Workspace, TEXT_WRITE_LIMIT,
};
use tokio::sync::{broadcast, mpsc, watch, Notify};

use crate::disk_echo::{content_hash, DiskEchoRing};
use crate::routes::doc::{PeerCursor, ServerFrame};
use crate::self_writes::{
    check_write_preconditions, SelfWrites, WritePreconditionError, WritePreconditions,
};
use crate::state::WorkspaceCell;
use changes::{Applied, ApplyError, ChangeSetJson, Section, UpdateJson};

/// Update-log ring caps. Attached clients never need the log (their
/// outboxes are lossless); it serves only `pull` requests and
/// `?version=` reconnects, so a bounded ring with snapshot fallback
/// below the base is enough.
const DOC_LOG_MAX_UPDATES: usize = 512;
const DOC_LOG_MAX_BYTES: usize = 256 * 1024;

/// Debounce between a session turning dirty and its disk flush; parity
/// with the SPA's classic autosave debounce.
const DOC_FLUSH_DEBOUNCE: Duration = Duration::from_millis(800);

/// How long a fully detached session survives before the reaper drops
/// it. A browser reload reattaches well within the grace window and
/// takes the cheap incremental-catch-up path instead of a snapshot.
const DOC_DETACH_GRACE: Duration = Duration::from_secs(30);

/// A divergent disk observation that cannot be verified as our own
/// echo must hold this long, unchanged, before it folds into the
/// session. One flusher tick past this re-observes and settles it, so
/// an honest external edit lands within ~two ticks of this; a transient
/// (an in-flight-upload artifact, a non-atomic replace gap) changes or
/// resolves within it and never destroys live state.
const CORROBORATE_AFTER: Duration = Duration::from_millis(300);

/// Flusher wake cadence; the debounce is measured against
/// `dirty_since`, the tick only bounds how late a flush can start.
const FLUSH_TICK: Duration = Duration::from_millis(200);

/// Reserved synthetic-participant prefix. Client pushes carrying it
/// are rejected so a peer can never impersonate the disk or HTTP
/// reconcilers.
const RESERVED_CLIENT_PREFIX: char = '$';
const DISK_CLIENT: &str = "$disk";
const REMOVED_DISK_MARKER: &str = "\0chan:removed";
const UNREADABLE_DISK_MARKER: &str = "\0chan:unreadable";
static NEXT_CONFLICT_ID: AtomicU64 = AtomicU64::new(1);

/// All live doc sessions, keyed by workspace-relative POSIX path.
pub struct DocRegistry {
    sessions: Mutex<HashMap<String, Arc<DocSession>>>,
    /// Wakes the flusher out of its tick sleep (detach and forced
    /// flushes want sub-tick latency).
    flush_wake: Notify,
    next_attach_id: AtomicU64,
}

/// One live document: the authority text plus everything needed to
/// serve attaches, pushes, and the disk integration.
pub struct DocSession {
    /// Workspace-relative POSIX path; the registry key.
    pub path: String,
    state: Mutex<DocState>,
    /// Mirror of `state.attaches.len()` maintained on attach/detach,
    /// readable without the state lock.
    attach_count: AtomicUsize,
    /// Unix millis stamped when the last attachment dropped; 0 while
    /// attached. The reaper ages fully detached sessions from here.
    detached_at: AtomicI64,
    /// Set under the state lock by the reaper and `close_all`; a
    /// closed session accepts nothing and is (being) removed from the
    /// registry map.
    closed: AtomicBool,
    /// Serializes this session's disk IO: a flush (token capture
    /// through commit) and a reconcile (stat through merge) never
    /// interleave. Acquired before any state lock, held across the
    /// blocking-IO awaits; see the module doc.
    io_lock: tokio::sync::Mutex<()>,
    #[cfg(test)]
    fail_after_preflight: AtomicBool,
}

struct AttachSink {
    outbox: mpsc::UnboundedSender<String>,
    window_id: String,
}

struct CursorPos {
    window_id: String,
    anchor: u64,
    head: u64,
    version: u64,
}

struct LoggedUpdate {
    client_id: String,
    changes: ChangeSetJson,
    /// Approximate wire cost, counted against `DOC_LOG_MAX_BYTES`.
    cost: usize,
}

/// Approximate wire bytes of a change set, for the log ring's byte
/// cap. Exactness does not matter; the cap only bounds memory.
fn changeset_cost(cs: &ChangeSetJson) -> usize {
    cs.sections
        .iter()
        .map(|s| match s {
            Section::Retain(_) => 8,
            Section::Edit { lines, .. } => 8 + lines.iter().map(|l| l.len() + 4).sum::<usize>(),
        })
        .sum()
}

struct DocState {
    /// Authority text. Invariants: valid UTF-8 (a `String`) and no
    /// larger than `write_budget`.
    text: String,
    /// Semantic cap derived from the last durable file size. Legacy
    /// oversized text may shrink but cannot grow.
    write_budget: u64,
    /// Cached UTF-16 length of `text`, kept incrementally.
    len16: u64,
    /// Count of accepted updates since session creation.
    version: u64,
    /// Updates for versions `[log_base, version)`, oldest first.
    log: VecDeque<Arc<LoggedUpdate>>,
    log_base: u64,
    log_bytes: usize,
    attaches: HashMap<u64, AttachSink>,
    cursors: HashMap<u64, CursorPos>,
    /// Explicit lifecycle state. Disk observations preserve the
    /// independent dirty clock; conflicts retain all three inputs and
    /// pause automatic writes.
    session_state: SessionState,
    /// Last content known to have reached disk. This remains unchanged
    /// while observations or conflicts are pending, so E3 can reason
    /// from a real three-way baseline.
    baseline: DurableBaseline,
    /// Skip the debounce on the next flusher pass (detach, forced
    /// flush).
    flush_now: bool,
    /// CAS token of the last flushed (or adopted) disk state. None
    /// when the file is gone or the token is unknown; a CAS write
    /// against None creates the file.
    flushed_mtime_ns: Option<i64>,
    /// Version captured by the flush in flight; a commit only clears
    /// `dirty_since` when the version still matches, so edits landing
    /// mid-flush keep the session dirty.
    flush_epoch_version: u64,
    /// Consecutive flush failures; the error fan starts at the second
    /// so a single transient miss stays quiet.
    flush_failures: u32,
    /// Hashes of content this session itself put on (or adopted from)
    /// disk. A reconcile read matching the ring is our own bytes under
    /// a re-stamped mtime, never an external edit.
    disk_echo: DiskEchoRing,
}

#[derive(Debug)]
enum SessionState {
    Clean,
    Dirty {
        since: Instant,
    },
    Observing {
        dirty_since: Option<Instant>,
        observation: DiskObservation,
    },
    Conflicted(SessionConflict),
    Removed,
}

#[derive(Debug)]
enum DiskObservation {
    Content {
        hash: u64,
        mtime_ns: Option<i64>,
        seen: Instant,
    },
    Removal {
        seen: Instant,
    },
}

#[derive(Debug)]
struct DurableBaseline {
    content: String,
    content_hash: u64,
    #[allow(dead_code)] // consumed by E3 conflict persistence/resolution
    mtime_ns: Option<i64>,
    #[allow(dead_code)] // consumed by E3 conflict persistence/resolution
    authority_version: u64,
}

#[derive(Debug)]
struct SessionConflict {
    id: String,
    baseline_version: u64,
    disk_version: u64,
    authority_version: u64,
    #[allow(dead_code)] // consumed by E3 explicit overwrite
    disk_mtime_ns: Option<i64>,
    #[allow(dead_code)] // consumed by E3 explicit reload
    disk_content: String,
}

/// Deterministic three-way merge result consumed by the session state
/// transition.
enum MergeOutcome {
    #[allow(dead_code)] // constructed by E3's merge engine
    Merged(String),
    Conflict,
}

/// Result of the conflict-aware PUT mutation gate.
pub(crate) enum HttpReplaceOutcome {
    Applied,
    PreconditionRequired {
        current_version: u64,
        disk_mtime_ns: Option<i64>,
    },
    Stale {
        current_version: u64,
        disk_mtime_ns: Option<i64>,
    },
    Conflicted {
        disk_mtime_ns: Option<i64>,
    },
}

pub(crate) struct HttpWriteView {
    pub disk_mtime_ns: Option<i64>,
    pub authority_version: u64,
    pub conflict_mtime_ns: Option<Option<i64>>,
    pub write_budget: u64,
}

pub(crate) struct HttpReadView {
    pub content: String,
    pub disk_mtime_ns: Option<i64>,
    pub authority_version: u64,
    pub disk_conflicted: bool,
}

impl SessionState {
    fn dirty_since(&self) -> Option<Instant> {
        match self {
            Self::Dirty { since } => Some(*since),
            Self::Observing { dirty_since, .. } => *dirty_since,
            _ => None,
        }
    }

    fn is_dirty(&self) -> bool {
        self.dirty_since().is_some() || matches!(self, Self::Conflicted(_))
    }

    fn mark_dirty(&mut self, authority_version: u64) {
        match self {
            Self::Clean | Self::Removed => {
                *self = Self::Dirty {
                    since: Instant::now(),
                };
            }
            Self::Dirty { .. } => {}
            Self::Observing { dirty_since, .. } => {
                dirty_since.get_or_insert_with(Instant::now);
            }
            Self::Conflicted(conflict) => conflict.authority_version = authority_version,
        }
    }

    fn observe_content(&mut self, hash: u64, mtime_ns: Option<i64>) {
        if matches!(self, Self::Conflicted(_)) {
            return;
        }
        let dirty_since = self.dirty_since();
        *self = Self::Observing {
            dirty_since,
            observation: DiskObservation::Content {
                hash,
                mtime_ns,
                seen: Instant::now(),
            },
        };
    }

    fn observe_removal(&mut self) {
        if matches!(self, Self::Conflicted(_)) {
            return;
        }
        let dirty_since = self.dirty_since();
        *self = Self::Observing {
            dirty_since,
            observation: DiskObservation::Removal {
                seen: Instant::now(),
            },
        };
    }

    fn clear_observation(&mut self) {
        let Self::Observing { dirty_since, .. } = self else {
            return;
        };
        *self = match *dirty_since {
            Some(since) => Self::Dirty { since },
            None => Self::Clean,
        };
    }

    fn content_observation(&self) -> Option<(u64, Option<i64>, Instant)> {
        match self {
            Self::Observing {
                observation:
                    DiskObservation::Content {
                        hash,
                        mtime_ns,
                        seen,
                    },
                ..
            } => Some((*hash, *mtime_ns, *seen)),
            _ => None,
        }
    }

    #[cfg(test)]
    fn content_observation_mut(&mut self) -> Option<&mut Instant> {
        match self {
            Self::Observing {
                observation: DiskObservation::Content { seen, .. },
                ..
            } => Some(seen),
            _ => None,
        }
    }

    fn removal_observation(&self) -> Option<Instant> {
        match self {
            Self::Observing {
                observation: DiskObservation::Removal { seen },
                ..
            } => Some(*seen),
            _ => None,
        }
    }

    #[cfg(test)]
    fn removal_observation_mut(&mut self) -> Option<&mut Instant> {
        match self {
            Self::Observing {
                observation: DiskObservation::Removal { seen },
                ..
            } => Some(seen),
            _ => None,
        }
    }

    fn has_observation(&self) -> bool {
        matches!(self, Self::Observing { .. })
    }

    fn conflict_disk_mtime_ns(&self) -> Option<Option<i64>> {
        match self {
            Self::Conflicted(conflict) => Some(conflict.disk_mtime_ns),
            _ => None,
        }
    }

    fn clear_after_flush(&mut self) {
        match self {
            Self::Dirty { .. } => *self = Self::Clean,
            Self::Observing { dirty_since, .. } => *dirty_since = None,
            Self::Clean | Self::Conflicted(_) | Self::Removed => {}
        }
    }
}

/// A registered attachment. Dropping it detaches: the outbox and
/// cursor are removed (peers see `cursor-gone`), and the last drop
/// stamps the detach time and requests a prompt flush.
pub struct DocAttachHandle {
    registry: Arc<DocRegistry>,
    session: Arc<DocSession>,
    attach_id: u64,
    frames: Option<mpsc::UnboundedReceiver<String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum AttachError {
    /// Path validation or the seeding disk read failed (missing file,
    /// not editable text, non-UTF-8, oversized, ...).
    #[error(transparent)]
    Workspace(#[from] ChanError),
    #[error("doc session read task failed: {0}")]
    Task(String),
}

/// A push the route must answer with an `error` frame and close the
/// attachment. A stale base version is NOT an error (the session
/// answers `push-stale` itself).
#[derive(Debug, thiserror::Error)]
pub enum PushError {
    #[error("reserved client id {0:?}")]
    ReservedClientId(String),
    #[error(transparent)]
    Apply(#[from] ApplyError),
    #[error("session closed")]
    Closed,
}

/// Normalize CRLF and lone CR to LF. Both text ingress points (the
/// session-creation seed and the reconciler's disk read) pass through
/// here, so the authority text never contains `\r`: CodeMirror
/// LF-normalizes on input, and a `\r` reaching a client would desync
/// its length accounting into an error/close/resnapshot cycle. The
/// conversion is NOT proactively flushed; it lands on disk with the
/// first real edit's flush, matching the classic save path's
/// LF-converts-on-first-save semantics.
fn normalize_lf(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Serialization of the doc wire frames cannot fail: every shape is
/// string-keyed plain data. The pin tests in routes/doc.rs would catch
/// a change that breaks this before it could panic here.
fn serialize(frame: &ServerFrame) -> String {
    serde_json::to_string(frame).expect("serialize doc server frame")
}

fn updates_frame<'a>(base: u64, entries: impl Iterator<Item = &'a Arc<LoggedUpdate>>) -> String {
    let updates = entries
        .map(|e| UpdateJson {
            client_id: e.client_id.clone(),
            changes: e.changes.clone(),
        })
        .collect();
    serialize(&ServerFrame::Updates {
        version: base,
        updates,
    })
}

fn snapshot_frame(path: &str, st: &DocState) -> String {
    let cursors = st
        .cursors
        .iter()
        .map(|(id, c)| PeerCursor {
            id: *id,
            w: c.window_id.clone(),
            anchor: c.anchor,
            head: c.head,
            version: c.version,
        })
        .collect();
    serialize(&ServerFrame::Snapshot {
        path: path.to_string(),
        version: st.version,
        doc: st.text.clone(),
        dirty: st.session_state.is_dirty(),
        mtime_ns: st.flushed_mtime_ns.map(|n| n.to_string()),
        cursors,
    })
}

fn flush_frame(st: &DocState) -> String {
    serialize(&ServerFrame::Flush {
        dirty: st.session_state.is_dirty(),
        mtime_ns: st.flushed_mtime_ns.map(|n| n.to_string()),
        error: None,
    })
}

impl DocState {
    fn fan(&self, json: &str) {
        for sink in self.attaches.values() {
            // A send only fails when the pump died; its handle drop
            // cleans the attach up.
            let _ = sink.outbox.send(json.to_owned());
        }
    }

    fn fan_except(&self, skip: u64, json: &str) {
        for (id, sink) in &self.attaches {
            if *id != skip {
                let _ = sink.outbox.send(json.to_owned());
            }
        }
    }

    fn send_to(&self, id: u64, json: String) {
        if let Some(sink) = self.attaches.get(&id) {
            let _ = sink.outbox.send(json);
        }
    }

    fn mark_dirty(&mut self) {
        self.session_state.mark_dirty(self.version);
    }

    fn append_log(&mut self, entry: Arc<LoggedUpdate>) {
        self.version += 1;
        self.log_bytes += entry.cost;
        self.log.push_back(entry);
        while self.log.len() > DOC_LOG_MAX_UPDATES || self.log_bytes > DOC_LOG_MAX_BYTES {
            let Some(evicted) = self.log.pop_front() else {
                break;
            };
            self.log_base += 1;
            self.log_bytes -= evicted.cost;
        }
    }
}

impl DocSession {
    fn new(path: &str, text: String, stat: &FileStat) -> Self {
        let len16 = changes::utf16_len(&text);
        let baseline = DurableBaseline {
            content_hash: content_hash(&text),
            content: text.clone(),
            mtime_ns: stat.mtime_ns,
            authority_version: 0,
        };
        // The seed is disk-adopted content: a stale read serving it
        // back later must count as an echo, not an external edit.
        let mut disk_echo = DiskEchoRing::new();
        disk_echo.note(content_hash(&text));
        Self {
            path: path.to_string(),
            state: Mutex::new(DocState {
                text,
                write_budget: semantic_write_budget(Some(stat.size)),
                len16,
                version: 0,
                log: VecDeque::new(),
                log_base: 0,
                log_bytes: 0,
                attaches: HashMap::new(),
                cursors: HashMap::new(),
                session_state: SessionState::Clean,
                baseline,
                flush_now: false,
                flushed_mtime_ns: stat.mtime_ns,
                flush_epoch_version: 0,
                flush_failures: 0,
                disk_echo,
            }),
            attach_count: AtomicUsize::new(0),
            detached_at: AtomicI64::new(0),
            closed: AtomicBool::new(false),
            io_lock: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            fail_after_preflight: AtomicBool::new(false),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, DocState> {
        self.state.lock().expect("doc session state poisoned")
    }

    // Test-surface accessor; production code reads the atomic directly.
    #[allow(dead_code)]
    pub fn attach_count(&self) -> usize {
        self.attach_count.load(Ordering::Relaxed)
    }

    /// Swap the echo ring for one with a short TTL so tests can
    /// observe expiry without sleeping through the production window.
    /// Discards existing entries; call before the writes under test.
    #[cfg(test)]
    fn test_set_disk_echo_ttl(&self, ttl: Duration) {
        self.lock_state().disk_echo = DiskEchoRing::with_ttl(ttl);
    }

    /// Age the pending absence past CORROBORATE_AFTER so the next
    /// reconcile confirms the removal; for route-level tests that
    /// exercise the removed flow without sleeping.
    #[cfg(test)]
    pub(crate) fn test_backdate_pending_removal(&self) {
        let mut st = self.lock_state();
        let pending = st
            .session_state
            .removal_observation_mut()
            .expect("a pending removal to age");
        *pending = Instant::now()
            .checked_sub(CORROBORATE_AFTER + Duration::from_millis(50))
            .unwrap();
    }

    #[cfg(test)]
    pub(crate) fn test_force_conflict(&self, disk_text: String, stat: &FileStat) {
        self.apply_merge_outcome(disk_text, stat, MergeOutcome::Conflict);
    }

    #[cfg(test)]
    fn test_fail_after_preflight(&self) {
        self.fail_after_preflight.store(true, Ordering::Relaxed);
    }

    /// Current authority text plus the session CAS token, for the GET
    /// divert: a client about to attach sees exactly the bytes its
    /// snapshot will carry, under a token consistent with the session.
    #[cfg(test)]
    pub fn authority_view(&self) -> (String, Option<i64>) {
        let st = self.lock_state();
        (st.text.clone(), st.flushed_mtime_ns)
    }

    /// Atomic GET view: authority bytes and every piece of metadata
    /// the client must retain for a subsequent CAS write.
    pub(crate) fn http_read_view(&self) -> HttpReadView {
        let st = self.lock_state();
        HttpReadView {
            content: st.text.clone(),
            disk_mtime_ns: st.flushed_mtime_ns,
            authority_version: st.version,
            disk_conflicted: st.session_state.conflict_disk_mtime_ns().is_some(),
        }
    }

    /// Atomic PUT preflight view: authority, session token, and an
    /// outer conflict marker carrying the retained disk token.
    pub(crate) fn http_write_view(&self) -> HttpWriteView {
        let st = self.lock_state();
        HttpWriteView {
            disk_mtime_ns: st.flushed_mtime_ns,
            authority_version: st.version,
            conflict_mtime_ns: st.session_state.conflict_disk_mtime_ns(),
            write_budget: st.write_budget,
        }
    }

    /// Whether a PUT must stay on the session path. Only an explicitly
    /// removed session falls through so the classic path can recreate
    /// the file; a conflict remains session-owned even when the
    /// conflicting disk token is absent.
    pub(crate) fn diverts_http_write(&self) -> bool {
        !matches!(&self.lock_state().session_state, SessionState::Removed)
    }

    /// Session CAS token for the PUT divert's conflict check.
    #[cfg(test)]
    pub fn token(&self) -> Option<i64> {
        self.lock_state().flushed_mtime_ns
    }

    /// Replace the whole authority text as a synthetic update from
    /// `client_id` (the `$http` divert). Fans like any edit and marks
    /// the session dirty; the caller decides when to flush.
    #[cfg(test)]
    pub fn apply_replace(&self, client_id: &str, new_text: &str) -> Result<(), ApplyError> {
        let mut st = self.lock_state();
        if new_text.len() as u64 > st.write_budget {
            return Err(ApplyError::DocTooLarge {
                bytes: new_text.len() as u64,
                limit: st.write_budget,
            });
        }
        self.apply_replace_locked(&mut st, client_id, new_text);
        Ok(())
    }

    /// Apply an HTTP replacement only while automatic persistence is
    /// permitted. Collaborative updates remain live during conflicts;
    /// PUT must instead direct the caller to explicit resolution
    /// without mutating authority.
    pub(crate) fn apply_http_replace(
        &self,
        client_id: &str,
        new_text: &str,
        preconditions: WritePreconditions,
    ) -> Result<HttpReplaceOutcome, ApplyError> {
        let mut st = self.lock_state();
        if let Some(disk_mtime_ns) = st.session_state.conflict_disk_mtime_ns() {
            return Ok(HttpReplaceOutcome::Conflicted { disk_mtime_ns });
        }
        match check_write_preconditions(
            st.flushed_mtime_ns,
            Some(st.version),
            new_text == st.text,
            preconditions,
        ) {
            Ok(()) => {}
            Err(WritePreconditionError::Required) => {
                return Ok(HttpReplaceOutcome::PreconditionRequired {
                    current_version: st.version,
                    disk_mtime_ns: st.flushed_mtime_ns,
                });
            }
            Err(WritePreconditionError::Conflict) => {
                return Ok(HttpReplaceOutcome::Stale {
                    current_version: st.version,
                    disk_mtime_ns: st.flushed_mtime_ns,
                });
            }
        }
        if new_text.len() as u64 > st.write_budget {
            return Err(ApplyError::DocTooLarge {
                bytes: new_text.len() as u64,
                limit: st.write_budget,
            });
        }
        self.apply_replace_locked(&mut st, client_id, new_text);
        Ok(HttpReplaceOutcome::Applied)
    }

    fn apply_replace_locked(&self, st: &mut DocState, client_id: &str, new_text: &str) {
        if new_text == st.text {
            return;
        }
        self.replace_locked(st, client_id, new_text.to_string());
        st.mark_dirty();
    }

    /// Commit `new_text` as a synthetic update under an already-held
    /// state lock: log, fan, bump version. Leaves dirty/token handling
    /// to the caller (the `$disk` and `$http` paths differ there).
    fn replace_locked(&self, st: &mut DocState, client_id: &str, new_text: String) {
        let cs = changes::replace_diff(&st.text, &new_text);
        let cost = changeset_cost(&cs) + client_id.len();
        let entry = Arc::new(LoggedUpdate {
            client_id: client_id.to_string(),
            changes: cs,
            cost,
        });
        let frame = updates_frame(st.version, std::iter::once(&entry));
        st.len16 = changes::utf16_len(&new_text);
        st.text = new_text;
        st.append_log(entry);
        st.fan(&frame);
    }

    /// Apply a result supplied by the deterministic three-way merge
    /// gate.
    #[cfg(test)]
    fn apply_merge_outcome(&self, disk_text: String, stat: &FileStat, outcome: MergeOutcome) {
        let disk_text = normalize_lf(disk_text);
        let mut st = self.lock_state();
        self.apply_merge_outcome_locked(&mut st, disk_text, stat, outcome);
    }

    fn apply_merge_outcome_locked(
        &self,
        st: &mut DocState,
        disk_text: String,
        stat: &FileStat,
        outcome: MergeOutcome,
    ) {
        let disk_hash = content_hash(&disk_text);
        match outcome {
            MergeOutcome::Merged(merged_text) => {
                let merged_text = normalize_lf(merged_text);
                let dirty_since = st.session_state.dirty_since().unwrap_or_else(Instant::now);
                st.disk_echo.note(disk_hash);
                st.flushed_mtime_ns = stat.mtime_ns;
                if merged_text != st.text {
                    self.replace_locked(st, DISK_CLIENT, merged_text);
                }
                st.baseline = DurableBaseline {
                    content: disk_text,
                    content_hash: disk_hash,
                    mtime_ns: stat.mtime_ns,
                    authority_version: st.version,
                };
                st.write_budget = semantic_write_budget(Some(stat.size));
                st.session_state = if st.text == st.baseline.content {
                    SessionState::Clean
                } else {
                    SessionState::Dirty { since: dirty_since }
                };
                st.flush_now = st.session_state.is_dirty();
                st.flush_failures = 0;
            }
            MergeOutcome::Conflict => {
                DocSession::enter_conflict_locked(st, disk_hash, stat.mtime_ns, disk_text);
            }
        }
    }

    fn enter_conflict_locked(
        st: &mut DocState,
        disk_version: u64,
        disk_mtime_ns: Option<i64>,
        disk_content: String,
    ) {
        let baseline_version = st.baseline.content_hash;
        let id = match &st.session_state {
            SessionState::Conflicted(conflict)
                if conflict.baseline_version == baseline_version
                    && conflict.disk_version == disk_version =>
            {
                conflict.id.clone()
            }
            _ => format!("doc-{}", NEXT_CONFLICT_ID.fetch_add(1, Ordering::Relaxed)),
        };
        st.session_state = SessionState::Conflicted(SessionConflict {
            id,
            baseline_version,
            disk_version,
            authority_version: st.version,
            disk_mtime_ns,
            disk_content,
        });
        st.flush_now = false;
    }

    /// Fold clean external disk content into the session. Dirty
    /// divergence runs a deterministic line-oriented three-way merge
    /// from the durable baseline.
    fn merge_disk(&self, disk_text: String, stat: &FileStat) {
        let disk_text = normalize_lf(disk_text);
        let mut st = self.lock_state();
        if st.session_state.is_dirty() && disk_text != st.text {
            let outcome = diffy::merge(&st.baseline.content, &st.text, &disk_text)
                .map(MergeOutcome::Merged)
                .unwrap_or(MergeOutcome::Conflict);
            self.apply_merge_outcome_locked(&mut st, disk_text, stat, outcome);
            return;
        }
        // Adopted disk content joins the echo ring: a stale read
        // serving these bytes again is not a fresh external edit.
        let disk_hash = content_hash(&disk_text);
        st.disk_echo.note(disk_hash);
        if disk_text != st.text {
            self.replace_locked(&mut st, DISK_CLIENT, disk_text.clone());
        }
        st.flushed_mtime_ns = stat.mtime_ns;
        st.baseline = DurableBaseline {
            content: disk_text,
            content_hash: disk_hash,
            mtime_ns: stat.mtime_ns,
            authority_version: st.version,
        };
        st.write_budget = semantic_write_budget(Some(stat.size));
        st.session_state = SessionState::Clean;
        st.flush_failures = 0;
    }

    /// The file vanished from disk. Forget the token, stop the flush
    /// clock (a deliberate delete is never resurrected by a flush; the
    /// next client edit re-dirties and the CAS-against-None write
    /// recreates), and tell every client.
    fn mark_removed(&self) {
        let mut st = self.lock_state();
        if st.session_state.is_dirty() {
            Self::enter_conflict_locked(
                &mut st,
                content_hash(REMOVED_DISK_MARKER),
                None,
                String::new(),
            );
            return;
        }
        st.flushed_mtime_ns = None;
        st.write_budget = TEXT_WRITE_LIMIT;
        st.session_state = SessionState::Removed;
        st.flush_now = false;
        st.fan(&serialize(&ServerFrame::Removed));
    }

    /// Resolve a conflict in favor of the retained disk side. Valid
    /// text becomes a synthetic `$disk` update; a retained removal
    /// becomes `Removed`. Unreadable disk state cannot be reloaded and
    /// leaves the conflict intact.
    #[allow(dead_code)] // wired to the explicit resolution route in E4
    pub(crate) fn reload_conflict(&self) -> bool {
        let mut st = self.lock_state();
        let (disk_version, disk_mtime_ns, disk_content) = match &st.session_state {
            SessionState::Conflicted(conflict) => (
                conflict.disk_version,
                conflict.disk_mtime_ns,
                conflict.disk_content.clone(),
            ),
            _ => return false,
        };
        if disk_version == content_hash(REMOVED_DISK_MARKER) {
            st.flushed_mtime_ns = None;
            st.session_state = SessionState::Removed;
            st.flush_now = false;
            st.flush_failures = 0;
            st.fan(&serialize(&ServerFrame::Removed));
            return true;
        }
        let disk_content = normalize_lf(disk_content);
        let disk_hash = content_hash(&disk_content);
        if disk_version != disk_hash {
            return false;
        }
        let changed = disk_content != st.text;
        if changed {
            self.replace_locked(&mut st, DISK_CLIENT, disk_content.clone());
        }
        st.disk_echo.note(disk_hash);
        st.flushed_mtime_ns = disk_mtime_ns;
        st.baseline = DurableBaseline {
            content: disk_content,
            content_hash: disk_hash,
            mtime_ns: disk_mtime_ns,
            authority_version: st.version,
        };
        st.write_budget = semantic_write_budget(Some(st.baseline.content.len() as u64));
        st.session_state = SessionState::Clean;
        st.flush_now = false;
        st.flush_failures = 0;
        if !changed {
            let frame = snapshot_frame(&self.path, &st);
            st.fan(&frame);
        }
        true
    }

    /// Resolve a conflict in favor of the live authority. The
    /// retained disk token becomes the CAS expectation, the existing
    /// flush path writes safely, and a successful commit re-broadcasts
    /// the current authority.
    #[allow(dead_code)] // wired to the explicit resolution route in E4
    pub(crate) async fn overwrite_conflict(
        self: &Arc<Self>,
        workspace: &Arc<Workspace>,
        self_writes: &SelfWrites,
    ) -> bool {
        {
            let mut st = self.lock_state();
            let disk_mtime_ns = match &st.session_state {
                SessionState::Conflicted(conflict) => conflict.disk_mtime_ns,
                _ => return false,
            };
            st.flushed_mtime_ns = disk_mtime_ns;
            st.session_state = SessionState::Dirty {
                since: Instant::now(),
            };
            st.flush_now = true;
        }
        if !flush_session(self, workspace, self_writes).await {
            return false;
        }
        let st = self.lock_state();
        let frame = snapshot_frame(&self.path, &st);
        st.fan(&frame);
        true
    }

    /// First half of a flush: capture the text and token under the
    /// lock. Returns None when there is nothing to flush. Clears
    /// `flush_now` either way.
    fn begin_flush(&self) -> Option<FlushJob> {
        let mut st = self.lock_state();
        st.flush_now = false;
        st.session_state.dirty_since()?;
        st.flush_epoch_version = st.version;
        Some(FlushJob {
            text: st.text.clone(),
            expected_mtime_ns: st.flushed_mtime_ns,
            epoch: st.version,
        })
    }

    /// Second half of a successful flush: adopt the fresh token, note
    /// the flushed content in the echo ring, clear dirty only if no
    /// edit landed while the write was in flight, and fan the flush
    /// state.
    fn finish_flush(&self, epoch: u64, stat: &FileStat, content: &str) {
        let mut st = self.lock_state();
        st.flushed_mtime_ns = stat.mtime_ns;
        let flushed_hash = content_hash(content);
        st.disk_echo.note(flushed_hash);
        st.flush_failures = 0;
        st.baseline = DurableBaseline {
            content: content.to_string(),
            content_hash: flushed_hash,
            mtime_ns: stat.mtime_ns,
            authority_version: epoch,
        };
        st.write_budget = semantic_write_budget(Some(stat.size));
        if st.version == epoch {
            st.session_state.clear_after_flush();
        }
        let frame = flush_frame(&st);
        st.fan(&frame);
    }

    fn note_flush_failure(&self, message: String) {
        let mut st = self.lock_state();
        st.flush_failures += 1;
        if st.flush_failures >= 2 {
            let frame = serialize(&ServerFrame::Flush {
                dirty: true,
                mtime_ns: None,
                error: Some(message),
            });
            st.fan(&frame);
        }
    }
}

struct FlushJob {
    text: String,
    expected_mtime_ns: Option<i64>,
    epoch: u64,
}

impl DocAttachHandle {
    // Exercised by the doc_sessions and route tests; the ws pump itself
    // only takes frames, pushes, pulls, and moves cursors.
    #[allow(dead_code)]
    pub fn attach_id(&self) -> u64 {
        self.attach_id
    }

    #[allow(dead_code)]
    pub fn session(&self) -> &Arc<DocSession> {
        &self.session
    }

    /// The per-attachment frame stream, taken once by the socket pump.
    /// Every frame is a complete serialized `ServerFrame`.
    pub fn take_frames(&mut self) -> mpsc::UnboundedReceiver<String> {
        self.frames.take().expect("doc attach frames taken twice")
    }

    /// Version-gated batch push. A base-version mismatch is answered
    /// with `push-stale` on this attachment's own stream and returns
    /// Ok. On success the committed updates fan to every attachment
    /// (sender included), then `push-ok` to the sender, both enqueued
    /// under the same lock. An Err means the route should answer an
    /// `error` frame and drop this attachment; the authority text is
    /// untouched (the batch is all-or-nothing).
    pub fn push(&self, base_version: u64, updates: Vec<UpdateJson>) -> Result<(), PushError> {
        // The changes are already grammar-checked (UpdateJson carries a
        // typed ChangeSetJson from frame decode); only the reserved
        // synthetic-participant ids are ours to police.
        for update in &updates {
            if update.client_id.starts_with(RESERVED_CLIENT_PREFIX) {
                return Err(PushError::ReservedClientId(update.client_id.clone()));
            }
        }

        let mut st = self.session.lock_state();
        if self.session.closed.load(Ordering::Relaxed) {
            return Err(PushError::Closed);
        }
        if st.version != base_version {
            let frame = serialize(&ServerFrame::PushStale {
                version: st.version,
            });
            st.send_to(self.attach_id, frame);
            return Ok(());
        }

        // All-or-nothing: apply the whole batch against locals; only
        // then commit.
        let mut applied: Option<Applied> = None;
        for update in &updates {
            let (text, len16) = match &applied {
                Some(a) => (a.text.as_str(), a.len16),
                None => (st.text.as_str(), st.len16),
            };
            applied = Some(changes::apply_with_limit(
                text,
                len16,
                &update.changes,
                st.write_budget,
            )?);
        }

        if let Some(a) = applied {
            let base = st.version;
            st.text = a.text;
            st.len16 = a.len16;
            let entries: Vec<Arc<LoggedUpdate>> = updates
                .into_iter()
                .map(|update| {
                    let cost = changeset_cost(&update.changes) + update.client_id.len();
                    Arc::new(LoggedUpdate {
                        client_id: update.client_id,
                        changes: update.changes,
                        cost,
                    })
                })
                .collect();
            let frame = updates_frame(base, entries.iter());
            for entry in entries {
                st.append_log(entry);
            }
            st.mark_dirty();
            st.fan(&frame);
        }
        let ok = serialize(&ServerFrame::PushOk {
            version: st.version,
        });
        st.send_to(self.attach_id, ok);
        Ok(())
    }

    /// Explicit catch-up: inside the log answers the missing updates,
    /// outside it answers a fresh snapshot; at the current version
    /// answers nothing.
    pub fn pull(&self, version: u64) {
        let st = self.session.lock_state();
        if version >= st.log_base && version <= st.version {
            if version < st.version {
                let frame = updates_frame(
                    version,
                    st.log.iter().skip((version - st.log_base) as usize),
                );
                st.send_to(self.attach_id, frame);
            }
        } else {
            let frame = snapshot_frame(&self.session.path, &st);
            st.send_to(self.attach_id, frame);
        }
    }

    /// Selection moved: clamp to the document, stamp the current
    /// version, store for future snapshots, and fan to the OTHER
    /// attachments (the owner knows its own selection).
    pub fn cursor(&self, anchor: u64, head: u64) {
        let mut st = self.session.lock_state();
        let Some(window_id) = st
            .attaches
            .get(&self.attach_id)
            .map(|s| s.window_id.clone())
        else {
            return;
        };
        let anchor = anchor.min(st.len16);
        let head = head.min(st.len16);
        let version = st.version;
        st.cursors.insert(
            self.attach_id,
            CursorPos {
                window_id: window_id.clone(),
                anchor,
                head,
                version,
            },
        );
        let frame = serialize(&ServerFrame::Cursor {
            id: self.attach_id,
            w: window_id,
            anchor,
            head,
            version,
        });
        st.fan_except(self.attach_id, &frame);
    }
}

impl Drop for DocAttachHandle {
    fn drop(&mut self) {
        let mut st = self.session.lock_state();
        st.attaches.remove(&self.attach_id);
        if st.cursors.remove(&self.attach_id).is_some() {
            let frame = serialize(&ServerFrame::CursorGone { id: self.attach_id });
            st.fan(&frame);
        }
        let last = st.attaches.is_empty();
        if last && !self.session.closed.load(Ordering::Relaxed) {
            self.session
                .detached_at
                .store(now_unix_millis(), Ordering::Relaxed);
            st.flush_now = true;
        }
        drop(st);
        self.session.attach_count.fetch_sub(1, Ordering::Relaxed);
        if last {
            self.registry.flush_wake.notify_one();
        }
    }
}

impl Default for DocRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl DocRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            flush_wake: Notify::new(),
            next_attach_id: AtomicU64::new(1),
        }
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<DocSession>>> {
        self.sessions.lock().expect("doc registry poisoned")
    }

    /// The live session for a path, if any (the GET/PUT diverts and
    /// the reconciler key on this).
    pub fn get(&self, path: &str) -> Option<Arc<DocSession>> {
        self.lock_sessions()
            .get(path)
            .filter(|s| !s.closed.load(Ordering::Relaxed))
            .cloned()
    }

    fn sessions_snapshot(&self) -> Vec<Arc<DocSession>> {
        self.lock_sessions().values().cloned().collect()
    }

    /// Attach to the session for `path`, creating it from disk on the
    /// first attachment. The returned handle's frame stream already
    /// carries the catch-up: a full `snapshot`, or, for a usable
    /// `client_version`, the incremental `updates` plus current
    /// cursors and flush state. Enqueued under the same lock that
    /// registers the attachment, so no update can slip in between.
    pub async fn attach(
        self: &Arc<Self>,
        workspace: &Arc<Workspace>,
        path: &str,
        window_id: &str,
        client_version: Option<u64>,
    ) -> Result<DocAttachHandle, AttachError> {
        chan_workspace::fs_ops::validate_rel(path)?;
        loop {
            // Fast path: live session.
            {
                let sessions = self.lock_sessions();
                if let Some(session) = sessions.get(path) {
                    if let Some(handle) =
                        self.register_attach(session.clone(), window_id, client_version)
                    {
                        return Ok(handle);
                    }
                    // Closed but not yet removed: fall through and
                    // seed a replacement.
                }
            }

            // First attach: seed from disk OUTSIDE every lock (the
            // read enforces the editable-text gate, valid UTF-8, and
            // the size cap).
            let ws = Arc::clone(workspace);
            let read_path = path.to_string();
            let (text, stat) =
                tokio::task::spawn_blocking(move || ws.read_text_with_stat(&read_path))
                    .await
                    .map_err(|e| AttachError::Task(e.to_string()))??;
            let text = normalize_lf(text);

            // Re-lock and double-check: a concurrent first attach may
            // have won the race; use its session and discard this read
            // (the ptr-equality idiom from terminal_sessions).
            let mut sessions = self.lock_sessions();
            match sessions.get(path) {
                Some(existing) if !existing.closed.load(Ordering::Relaxed) => {
                    let session = existing.clone();
                    if let Some(handle) = self.register_attach(session, window_id, client_version) {
                        return Ok(handle);
                    }
                    // Raced a close between the lookups; start over.
                }
                _ => {
                    let session = Arc::new(DocSession::new(path, text, &stat));
                    sessions.insert(path.to_string(), session.clone());
                    let handle = self
                        .register_attach(session, window_id, client_version)
                        .expect("fresh session cannot be closed under the map lock");
                    return Ok(handle);
                }
            }
        }
    }

    /// Register an attachment on `session` and enqueue its catch-up.
    /// None when the session is closed (caller retries against the
    /// map). Callers hold the registry map lock, which is what makes
    /// the closed check race-free against the reaper and `close_all`.
    fn register_attach(
        self: &Arc<Self>,
        session: Arc<DocSession>,
        window_id: &str,
        client_version: Option<u64>,
    ) -> Option<DocAttachHandle> {
        let attach_id = self.next_attach_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let mut st = session.lock_state();
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        match client_version {
            Some(v) if v >= st.log_base && v <= st.version => {
                if v < st.version {
                    let frame = updates_frame(v, st.log.iter().skip((v - st.log_base) as usize));
                    let _ = tx.send(frame);
                }
                for (id, c) in &st.cursors {
                    let _ = tx.send(serialize(&ServerFrame::Cursor {
                        id: *id,
                        w: c.window_id.clone(),
                        anchor: c.anchor,
                        head: c.head,
                        version: c.version,
                    }));
                }
                let _ = tx.send(flush_frame(&st));
            }
            _ => {
                let _ = tx.send(snapshot_frame(&session.path, &st));
            }
        }
        st.attaches.insert(
            attach_id,
            AttachSink {
                outbox: tx,
                window_id: window_id.to_string(),
            },
        );
        drop(st);
        session.attach_count.fetch_add(1, Ordering::Relaxed);
        session.detached_at.store(0, Ordering::Relaxed);
        Some(DocAttachHandle {
            registry: Arc::clone(self),
            session,
            attach_id,
            frames: Some(rx),
        })
    }

    /// One flusher sweep: flush every session that is due (debounce
    /// elapsed or flush requested).
    pub async fn flush_pass(&self, workspace: &Arc<Workspace>, self_writes: &SelfWrites) {
        for session in self.sessions_snapshot() {
            let due = {
                let st = session.lock_state();
                st.flush_now
                    || st
                        .session_state
                        .dirty_since()
                        .is_some_and(|since| since.elapsed() >= DOC_FLUSH_DEBOUNCE)
            };
            if due {
                flush_session(&session, workspace, self_writes).await;
            }
        }
    }

    /// Drop sessions that have been fully detached past the grace
    /// window and hold nothing unflushed. Marks them closed under the
    /// map lock so a concurrent attach either finds them gone or sees
    /// the closed flag and reseeds.
    pub fn reap_pass(&self) {
        let now = now_unix_millis();
        let mut sessions = self.lock_sessions();
        sessions.retain(|_, session| {
            let st = session.lock_state();
            let detached_at = session.detached_at.load(Ordering::Relaxed);
            let reap = st.attaches.is_empty()
                && !st.session_state.is_dirty()
                && detached_at > 0
                && now.saturating_sub(detached_at) >= DOC_DETACH_GRACE.as_millis() as i64;
            if reap {
                session.closed.store(true, Ordering::Relaxed);
            }
            !reap
        });
    }

    /// Registry-initiated teardown (storage reset, shutdown): flush
    /// what can be flushed, tell every attachment `closed`, and drop
    /// all sessions. Pass the pre-swap workspace on reset so dirty
    /// sessions land on disk first.
    pub async fn close_all(
        &self,
        reason: &'static str,
        workspace: Option<&Arc<Workspace>>,
        self_writes: &SelfWrites,
    ) {
        let sessions: Vec<Arc<DocSession>> = {
            let mut map = self.lock_sessions();
            map.drain().map(|(_, s)| s).collect()
        };
        for session in sessions {
            if let Some(ws) = workspace {
                session.lock_state().flush_now = true;
                flush_session(&session, ws, self_writes).await;
            }
            let mut st = session.lock_state();
            session.closed.store(true, Ordering::Relaxed);
            st.fan(&serialize(&ServerFrame::Closed { reason }));
            st.attaches.clear();
            st.cursors.clear();
        }
    }

    /// Route one raw watcher event into the affected session, if any.
    /// Every path-bearing event reconciles stat-first, `Removed`
    /// included: the flusher's atomic temp+rename surfaces a watcher
    /// `Removed` for the flushed path on every write, so absence must
    /// be confirmed against the disk (reconcile_session's exists probe)
    /// before a session routes into the removed flow. A rename
    /// reconciles both keys: the vacated source stats absent and lands
    /// in removed, the destination merges as a modify.
    pub async fn reconcile_event(&self, workspace: &Arc<Workspace>, event: WatchEvent) {
        match event.kind {
            WatchKind::Created | WatchKind::Modified | WatchKind::Removed => {
                if let Some(session) = event.path.as_deref().and_then(|p| self.get(p)) {
                    reconcile_session(&session, workspace).await;
                }
            }
            WatchKind::Renamed => {
                if let Some(session) = event.path.as_deref().and_then(|p| self.get(p)) {
                    reconcile_session(&session, workspace).await;
                }
                if let Some(session) = event.to.as_deref().and_then(|p| self.get(p)) {
                    reconcile_session(&session, workspace).await;
                }
            }
            WatchKind::ProviderError => self.reconcile_all(workspace).await,
        }
    }

    /// Stat-and-reconcile every live session; the answer to a lagged
    /// or unreliable watch stream.
    pub async fn reconcile_all(&self, workspace: &Arc<Workspace>) {
        for session in self.sessions_snapshot() {
            reconcile_session(&session, workspace).await;
        }
    }

    /// Re-observe sessions holding an uncorroborated disk observation
    /// (a pending fold or a pending removal). Runs on the flusher tick
    /// so a stable observation settles within roughly CORROBORATE_AFTER
    /// plus one tick, without the reconciler ever sleeping.
    pub async fn reconcile_pending(&self, workspace: &Arc<Workspace>) {
        for session in self.sessions_snapshot() {
            let pending = {
                let st = session.lock_state();
                st.session_state.has_observation()
            };
            if pending {
                reconcile_session(&session, workspace).await;
            }
        }
    }
}

/// Flush one session to disk: capture under the lock, CAS-write
/// outside it, commit the token. A CAS conflict means the disk changed
/// under us: reconcile and retry once if authority and disk converge.
/// Other failures keep the session dirty; the content stays safe in
/// memory and in every client, and the error fan starts on the second
/// consecutive failure.
///
/// Returns whether the state captured by this call settled durably:
/// true when the write committed, when there was nothing unflushed, or
/// when the CAS-conflict reconcile left authority and disk equal
/// (including the removed-file path, whose authoritative disk state is
/// deliberately "no file"). False means the write failed and the
/// session stays dirty, or an unresolved conflict prevents a flush;
/// the PUT divert turns those into an honest non-200 response.
/// The signal is race-free where a `dirty()` read would not be: a
/// concurrent push re-dirtying the session cannot retract a commit
/// that already happened.
pub(crate) async fn flush_session(
    session: &Arc<DocSession>,
    workspace: &Arc<Workspace>,
    self_writes: &SelfWrites,
) -> bool {
    let _io = session.io_lock.lock().await;
    flush_session_locked(session, workspace, self_writes).await
}

async fn flush_session_locked(
    session: &Arc<DocSession>,
    workspace: &Arc<Workspace>,
    self_writes: &SelfWrites,
) -> bool {
    for attempt in 0..2u32 {
        let Some(job) = session.begin_flush() else {
            return session
                .lock_state()
                .session_state
                .conflict_disk_mtime_ns()
                .is_none();
        };
        // The canonical strict write preflight performs filesystem
        // syscalls, so keep the whole probe off the async runtime.
        // Reserve only after it succeeds; every later failure cancels.
        let ws = Arc::clone(workspace);
        let preflight_path = session.path.clone();
        match tokio::task::spawn_blocking(move || ws.ensure_writable(&preflight_path)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                session.note_flush_failure(e.to_string());
                return false;
            }
            Err(join) => {
                session.note_flush_failure(join.to_string());
                return false;
            }
        }
        let self_write = self_writes.reserve_after_preflight(&session.path);
        let flushed_content = job.text.clone();
        let ws = Arc::clone(workspace);
        let path = session.path.clone();
        let epoch = job.epoch;
        #[cfg(test)]
        let test_session = Arc::clone(session);
        let result = tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if test_session
                .fail_after_preflight
                .swap(false, Ordering::Relaxed)
            {
                let target = ws.root().join(&path);
                let _ = std::fs::remove_file(&target);
                let _ = std::fs::create_dir(&target);
            }
            match ws.write_text_if_unchanged(&path, job.expected_mtime_ns, &job.text) {
                Ok(()) => (true, ws.stat(&path)),
                Err(e) => (false, Err(e)),
            }
        })
        .await;
        match result {
            Ok((_, Ok(stat))) => {
                session.finish_flush(epoch, &stat, &flushed_content);
                return true;
            }
            Ok((false, Err(ChanError::WriteConflict { .. }))) if attempt == 0 => {
                self_writes.cancel(self_write);
                // Disk changed since our token: reconcile it, then
                // retry only if the state machine remains flushable.
                // A fold-in deferred for corroboration is not a failure:
                // the pending path owns convergence, so bail without
                // fanning an error.
                reconcile_session_locked(session, workspace).await;
                if session.lock_state().session_state.has_observation() {
                    return false;
                }
            }
            Ok((write_committed, Err(e))) => {
                if !write_committed {
                    self_writes.cancel(self_write);
                }
                session.note_flush_failure(e.to_string());
                return false;
            }
            Err(join) => {
                self_writes.cancel(self_write);
                session.note_flush_failure(join.to_string());
                return false;
            }
        }
    }
    // Unreachable: attempt 1 exits through an arm above (a second
    // consecutive WriteConflict takes the generic-failure arm).
    false
}

/// Bring one session in line with the disk: an unchanged token or a
/// read matching the session's own recent disk content is our flush
/// echo (adopt the token, keep the authority); equal content adopts
/// the token silently; clean divergent content becomes a `$disk`
/// update, while dirty divergence enters the E3 merge gate only once
/// corroborated (a lying read must never destroy live state); a
/// vanished file routes into the removed path after absence
/// corroborates. Unreadable content (non-UTF-8, oversized) enters a
/// retained conflict instead of risking authority loss.
pub(crate) async fn reconcile_session(session: &Arc<DocSession>, workspace: &Arc<Workspace>) {
    let _io = session.io_lock.lock().await;
    reconcile_session_locked(session, workspace).await
}

async fn reconcile_session_locked(session: &Arc<DocSession>, workspace: &Arc<Workspace>) {
    if session.closed.load(Ordering::Relaxed) {
        return;
    }
    let ws = Arc::clone(workspace);
    let stat_path = session.path.clone();
    let stat = match tokio::task::spawn_blocking(move || ws.stat(&stat_path)).await {
        Ok(Ok(stat)) => stat,
        Ok(Err(_)) => {
            let ws = Arc::clone(workspace);
            let probe_path = session.path.clone();
            let exists = tokio::task::spawn_blocking(move || ws.exists(&probe_path))
                .await
                .unwrap_or(true);
            let mut st = session.lock_state();
            if exists {
                if st.session_state.removal_observation().is_some() {
                    st.session_state.clear_observation();
                }
                return;
            }
            // Absence must corroborate: a non-atomic replace (FUSE
            // rename as delete + create) vanishes the path for real
            // milliseconds-to-seconds, and firing `removed` at the
            // clients mid-typing tears down their session state.
            match st.session_state.removal_observation() {
                Some(first) if first.elapsed() >= CORROBORATE_AFTER => {
                    drop(st);
                    session.mark_removed();
                }
                Some(_) => {}
                None => st.session_state.observe_removal(),
            }
            return;
        }
        Err(_) => return,
    };
    {
        let mut st = session.lock_state();
        if st.session_state.removal_observation().is_some() {
            st.session_state.clear_observation();
        }
        if matches!(st.session_state, SessionState::Conflicted(_)) {
            return;
        }
        // A matching token normally settles the event as our own flush
        // echo. Not while an observation is pending, though: a refused
        // empty read adopts the token below to keep CAS writes viable,
        // and settling here would end the corroboration that folds an
        // honest truncation in once the guards lapse.
        if stat.mtime_ns.is_some()
            && stat.mtime_ns == st.flushed_mtime_ns
            && st.session_state.content_observation().is_none()
        {
            return;
        }
    }
    let ws = Arc::clone(workspace);
    let read_path = session.path.clone();
    let (disk_text, disk_stat) =
        match tokio::task::spawn_blocking(move || ws.read_text_with_stat(&read_path)).await {
            Ok(Ok(read)) => read,
            Ok(Err(e)) => {
                tracing::warn!(
                    error = %e,
                    path = %session.path,
                    "doc session reconcile read failed; entering conflict"
                );
                let marker = format!(
                    "{UNREADABLE_DISK_MARKER}:{}:{:?}:{e}",
                    stat.size, stat.mtime_ns
                );
                let mut st = session.lock_state();
                DocSession::enter_conflict_locked(
                    &mut st,
                    content_hash(&marker),
                    stat.mtime_ns,
                    String::new(),
                );
                return;
            }
            Err(_) => return,
        };
    let disk_text = normalize_lf(disk_text);
    let hash = content_hash(&disk_text);
    {
        let mut st = session.lock_state();
        if st.disk_echo.contains(hash) {
            // Our own bytes under a re-stamped mtime (async-committing
            // fs) or a stale read serving a recent flush back: adopt
            // the token so the next CAS write succeeds and keep the
            // authority text. Divergent bytes stay scheduled: if they
            // are still on disk after the ring entry expires, they are
            // durable external state and must fold normally.
            st.flushed_mtime_ns = disk_stat.mtime_ns;
            if disk_text == st.text {
                st.session_state.clear_observation();
            } else if !matches!(
                st.session_state.content_observation(),
                Some((pending_hash, pending_mtime, _))
                    if pending_hash == hash && pending_mtime == disk_stat.mtime_ns
            ) {
                st.session_state.observe_content(hash, disk_stat.mtime_ns);
            }
            return;
        }
        if disk_text == st.text {
            // Equal content: merge_disk's silent-adopt branch.
            drop(st);
            session.merge_disk(disk_text, &disk_stat);
            return;
        }
        let dirty = st.session_state.is_dirty();
        if disk_text.is_empty() && (dirty || st.disk_echo.any_recent()) {
            // An empty read right after our own writes is the classic
            // in-flight-upload placeholder; folding it in blanks every
            // client and the next flush persists the blank. Refuse the
            // merge while the session is dirty or the ring is fresh,
            // but ADOPT the token: the next CAS flush then restores
            // the authority content over the suspect empty file (the
            // live session wins). The observation stays pending so the
            // flusher tick re-checks; an honest truncation folds in
            // through the corroboration below once the ring TTL lapses
            // on an idle session.
            st.flushed_mtime_ns = disk_stat.mtime_ns;
            if !matches!(
                st.session_state.content_observation(),
                Some((pending_hash, pending_mtime, _))
                    if pending_hash == hash && pending_mtime == disk_stat.mtime_ns
            ) {
                tracing::warn!(
                    path = %session.path,
                    "doc session reconcile refused an uncorroborated empty read"
                );
                st.session_state.observe_content(hash, disk_stat.mtime_ns);
            }
            return;
        }
        if dirty || disk_text.is_empty() {
            // Divergent content into a dirty session (or a stable
            // empty read past the guards above): fold in only after
            // the observation holds unchanged for CORROBORATE_AFTER.
            let observation = st.session_state.content_observation();
            let corroborated = matches!(
                observation,
                Some((pending_hash, pending_mtime, seen))
                    if pending_hash == hash
                        && pending_mtime == disk_stat.mtime_ns
                        && seen.elapsed() >= CORROBORATE_AFTER
            );
            let same_observation = matches!(
                observation,
                Some((pending_hash, pending_mtime, _))
                    if pending_hash == hash && pending_mtime == disk_stat.mtime_ns
            );
            if corroborated {
                drop(st);
                session.merge_disk(disk_text, &disk_stat);
            } else if !same_observation {
                st.session_state.observe_content(hash, disk_stat.mtime_ns);
            }
            return;
        }
        drop(st);
    }
    // Clean session, non-empty divergent content: an ordinary external
    // edit; fold it in immediately, as before.
    session.merge_disk(disk_text, &disk_stat);
}

fn cell_workspace(cell: &Arc<RwLock<Option<WorkspaceCell>>>) -> Option<Arc<Workspace>> {
    cell.read().ok()?.as_ref().map(|c| c.workspace.clone())
}

/// The background flusher: debounced dirty-session writes, detach
/// flushes, the detach-grace reaper, and the flush-all on shutdown.
/// Spawned once in build_app next to the other long-lived tasks.
pub fn spawn_flusher(
    registry: Arc<DocRegistry>,
    workspace_cell: Arc<RwLock<Option<WorkspaceCell>>>,
    self_writes: Arc<SelfWrites>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = registry.flush_wake.notified() => {}
                _ = tokio::time::sleep(FLUSH_TICK) => {}
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        let ws = cell_workspace(&workspace_cell);
                        registry
                            .close_all("shutdown", ws.as_ref(), &self_writes)
                            .await;
                        return;
                    }
                }
            }
            if let Some(ws) = cell_workspace(&workspace_cell) {
                registry.flush_pass(&ws, &self_writes).await;
                registry.reconcile_pending(&ws).await;
            }
            registry.reap_pass();
        }
    })
}

/// The reconciler: subscribes the RAW watcher feed (pre-suppression;
/// sessions do their own precise mtime-token echo filtering instead of
/// the coarse SelfWrites window) and folds external writes into live
/// sessions. A lagged receiver or provider error reconciles everything.
pub fn spawn_reconciler(
    registry: Arc<DocRegistry>,
    workspace_cell: Arc<RwLock<Option<WorkspaceCell>>>,
    mut events: broadcast::Receiver<WatchEvent>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        return;
                    }
                }
                received = events.recv() => {
                    let Some(ws) = cell_workspace(&workspace_cell) else {
                        continue;
                    };
                    match received {
                        Ok(event) => registry.reconcile_event(&ws, event).await,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            registry.reconcile_all(&ws).await;
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tempfile::TempDir;

    struct Fixture {
        _cfg: TempDir,
        root: TempDir,
        workspace: Arc<Workspace>,
        registry: Arc<DocRegistry>,
        self_writes: SelfWrites,
    }

    fn fixture(files: &[(&str, &str)]) -> Fixture {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        for (path, content) in files {
            workspace.write_text(path, content).unwrap();
        }
        Fixture {
            _cfg: cfg,
            root,
            workspace,
            registry: Arc::new(DocRegistry::new()),
            self_writes: SelfWrites::new(),
        }
    }

    async fn attach(
        fx: &Fixture,
        path: &str,
        window: &str,
        version: Option<u64>,
    ) -> (DocAttachHandle, mpsc::UnboundedReceiver<String>) {
        let mut handle = fx
            .registry
            .attach(&fx.workspace, path, window, version)
            .await
            .expect("attach");
        let frames = handle.take_frames();
        (handle, frames)
    }

    /// Drain everything currently enqueued. All enqueues under test
    /// happen synchronously before this runs, so nothing is racy.
    fn drain(rx: &mut mpsc::UnboundedReceiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(s) = rx.try_recv() {
            out.push(serde_json::from_str(&s).unwrap());
        }
        out
    }

    fn update(client: &str, changes: Value) -> UpdateJson {
        UpdateJson {
            client_id: client.into(),
            changes: serde_json::from_value(changes).expect("valid change set"),
        }
    }

    fn backdate_dirty(session: &Arc<DocSession>) {
        let mut st = session.lock_state();
        st.session_state = SessionState::Dirty {
            since: Instant::now()
                .checked_sub(DOC_FLUSH_DEBOUNCE + Duration::from_millis(50))
                .unwrap(),
        };
    }

    /// Age the pending disk observation past CORROBORATE_AFTER so the
    /// next reconcile treats it as corroborated.
    fn backdate_pending_fold(session: &Arc<DocSession>) {
        let mut st = session.lock_state();
        let pending = st
            .session_state
            .content_observation_mut()
            .expect("a pending fold to age");
        *pending = Instant::now()
            .checked_sub(CORROBORATE_AFTER + Duration::from_millis(50))
            .unwrap();
    }

    /// Age the pending absence past CORROBORATE_AFTER so the next
    /// reconcile confirms the removal.
    fn backdate_pending_removal(session: &Arc<DocSession>) {
        session.test_backdate_pending_removal();
    }

    #[tokio::test]
    async fn attach_snapshots_and_seeds_from_disk() {
        let fx = fixture(&[("a.md", "hello")]);
        let (_h, mut rx) = attach(&fx, "a.md", "win-1", None).await;
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), 1);
        let snap = &frames[0];
        assert_eq!(snap["type"], "snapshot");
        assert_eq!(snap["path"], "a.md");
        assert_eq!(snap["version"], 0);
        assert_eq!(snap["doc"], "hello");
        assert_eq!(snap["dirty"], false);
        assert!(snap["mtime_ns"].is_string());
        assert_eq!(snap["cursors"], json!([]));
    }

    #[tokio::test]
    async fn merged_outcome_preserves_durable_baseline_through_observation() {
        let fx = fixture(&[("a.md", "left\nright\n")]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session()
            .apply_replace("c1", "left local\nright\n")
            .unwrap();
        drain(&mut rx);

        let disk = "left\nright disk\n".to_string();
        std::fs::write(fx.root.path().join("a.md"), &disk).unwrap();
        let stat = fx.workspace.stat("a.md").unwrap();
        let merged = "left local\nright disk\n".to_string();
        ha.session()
            .apply_merge_outcome(disk.clone(), &stat, MergeOutcome::Merged(merged.clone()));

        assert_eq!(ha.session().authority_view().0, merged);
        let mut st = ha.session().lock_state();
        assert!(matches!(st.session_state, SessionState::Dirty { .. }));
        assert_eq!(st.baseline.content, disk);
        assert_eq!(st.baseline.content_hash, content_hash(&disk));
        assert_eq!(st.baseline.mtime_ns, stat.mtime_ns);
        assert_eq!(st.baseline.authority_version, st.version);

        let baseline = (
            st.baseline.content.clone(),
            st.baseline.content_hash,
            st.baseline.mtime_ns,
            st.baseline.authority_version,
        );
        st.session_state
            .observe_content(content_hash("next disk"), Some(99));
        assert!(matches!(
            st.session_state,
            SessionState::Observing {
                dirty_since: Some(_),
                ..
            }
        ));
        assert_eq!(
            baseline,
            (
                st.baseline.content.clone(),
                st.baseline.content_hash,
                st.baseline.mtime_ns,
                st.baseline.authority_version,
            ),
            "an observation cannot mutate the durable baseline"
        );
    }

    #[tokio::test]
    async fn conflict_retains_three_versions_and_pauses_flush() {
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session().apply_replace("c1", "local").unwrap();
        drain(&mut rx);

        let disk = "external".to_string();
        std::fs::write(fx.root.path().join("a.md"), &disk).unwrap();
        let stat = fx.workspace.stat("a.md").unwrap();
        ha.session()
            .apply_merge_outcome(disk.clone(), &stat, MergeOutcome::Conflict);

        let first_id = {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("overlap must enter Conflicted");
            };
            assert_eq!(conflict.baseline_version, content_hash("base"));
            assert_eq!(conflict.disk_version, content_hash(&disk));
            assert_eq!(conflict.authority_version, st.version);
            assert_eq!(conflict.disk_mtime_ns, stat.mtime_ns);
            assert_eq!(conflict.disk_content, disk);
            assert_eq!(st.baseline.content, "base");
            assert_eq!(st.baseline.mtime_ns, st.flushed_mtime_ns);
            assert_eq!(st.baseline.authority_version, 0);
            conflict.id.clone()
        };

        ha.session()
            .apply_merge_outcome(disk.clone(), &stat, MergeOutcome::Conflict);
        ha.session().apply_replace("c2", "local continued").unwrap();
        let st = ha.session().lock_state();
        let SessionState::Conflicted(conflict) = &st.session_state else {
            panic!("collaboration must remain conflicted");
        };
        assert_eq!(conflict.id, first_id, "conflict id must stay stable");
        assert_eq!(conflict.authority_version, st.version);
        drop(st);
        assert!(
            ha.session().begin_flush().is_none(),
            "automatic flush pauses in Conflicted"
        );
        assert!(
            !flush_session(ha.session(), &fx.workspace, &fx.self_writes).await,
            "a forced flush must not report a conflict as durable"
        );
    }

    #[tokio::test]
    async fn disk_equal_to_dirty_authority_advances_baseline_and_cleans() {
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session().apply_replace("c1", "local").unwrap();
        drain(&mut rx);

        std::fs::write(fx.root.path().join("a.md"), "local").unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(ha.session(), &fx.workspace).await;

        let st = ha.session().lock_state();
        assert!(matches!(st.session_state, SessionState::Clean));
        assert_eq!(st.baseline.content, "local");
        assert_eq!(st.baseline.content_hash, content_hash("local"));
        assert_eq!(st.baseline.mtime_ns, st.flushed_mtime_ns);
        assert_eq!(st.baseline.authority_version, st.version);
    }

    #[tokio::test]
    async fn nonoverlapping_external_edit_merges_flushes_and_broadcasts_once() {
        let fx = fixture(&[("a.md", "alpha\nbeta\ngamma\n")]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session()
            .apply_replace("c1", "alpha local\nbeta\ngamma\n")
            .unwrap();
        drain(&mut rx);

        std::fs::write(fx.root.path().join("a.md"), "alpha\nbeta\ngamma disk\n").unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(ha.session(), &fx.workspace).await;
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let merged = "alpha local\nbeta\ngamma disk\n";
        assert_eq!(ha.session().authority_view().0, merged);
        let updates = drain(&mut rx);
        assert_eq!(updates.len(), 1, "merged authority broadcasts once");
        assert_eq!(updates[0]["type"], "updates");
        assert_eq!(updates[0]["updates"][0]["clientID"], "$disk");

        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), merged);
        let flushed = drain(&mut rx);
        assert_eq!(flushed.len(), 1, "merged authority flushes once");
        assert_eq!(flushed[0]["type"], "flush");
        assert_eq!(flushed[0]["dirty"], false);
    }

    #[tokio::test]
    async fn overlapping_external_edit_conflicts_and_reload_adopts_disk() {
        let baseline = "alpha\nbeta\n";
        let local = "alpha local\nbeta\n";
        let disk = "alpha disk\nbeta\n";
        let fx = fixture(&[("a.md", baseline)]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session().apply_replace("c1", local).unwrap();
        drain(&mut rx);

        fx.workspace.write_text("a.md", disk).unwrap();
        let stat = fx.workspace.stat("a.md").unwrap();
        ha.session().merge_disk(disk.to_string(), &stat);
        {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("overlapping edits must conflict");
            };
            assert_eq!(st.baseline.content, baseline);
            assert_eq!(st.text, local);
            assert_eq!(conflict.baseline_version, content_hash(baseline));
            assert_eq!(conflict.disk_version, content_hash(disk));
            assert_eq!(conflict.authority_version, st.version);
            assert_eq!(conflict.disk_content, disk);
        }
        assert!(drain(&mut rx).is_empty(), "conflict has no silent winner");

        assert!(ha.session().reload_conflict());
        assert_eq!(ha.session().authority_view().0, disk);
        assert!(matches!(
            ha.session().lock_state().session_state,
            SessionState::Clean
        ));
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "updates");
        assert_eq!(frames[0]["updates"][0]["clientID"], "$disk");
    }

    #[tokio::test]
    async fn overwrite_conflict_flushes_authority_and_rebroadcasts() {
        let baseline = "alpha\nbeta\n";
        let local = "alpha local\nbeta\n";
        let disk = "alpha disk\nbeta\n";
        let fx = fixture(&[("a.md", baseline)]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session().apply_replace("c1", local).unwrap();
        drain(&mut rx);
        fx.workspace.write_text("a.md", disk).unwrap();
        let stat = fx.workspace.stat("a.md").unwrap();
        ha.session().merge_disk(disk.to_string(), &stat);

        assert!(
            ha.session()
                .overwrite_conflict(&fx.workspace, &fx.self_writes)
                .await
        );
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), local);
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["type"], "flush");
        assert_eq!(frames[1]["type"], "snapshot");
        assert_eq!(frames[1]["doc"], local);
    }

    #[tokio::test]
    async fn delete_while_dirty_enters_conflicted() {
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        ha.session().apply_replace("c1", "local").unwrap();
        drain(&mut rx);

        std::fs::remove_file(fx.root.path().join("a.md")).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        backdate_pending_removal(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let st = ha.session().lock_state();
        let SessionState::Conflicted(conflict) = &st.session_state else {
            panic!("delete versus edit must enter Conflicted");
        };
        assert_eq!(st.text, "local");
        assert_eq!(st.baseline.content, "base");
        assert_eq!(conflict.baseline_version, content_hash("base"));
        assert_eq!(conflict.authority_version, st.version);
        assert_eq!(conflict.disk_mtime_ns, None);
        assert!(conflict.disk_content.is_empty());
        drop(st);
        assert_eq!(drain(&mut rx).len(), 0, "neither side wins");
    }

    #[tokio::test]
    async fn unreadable_external_replacement_enters_conflicted() {
        let fx = fixture(&[("a.md", "authority")]);
        let (ha, mut rx) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rx);
        std::fs::write(fx.root.path().join("a.md"), [0xff, 0xfe]).unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;

        reconcile_session(ha.session(), &fx.workspace).await;

        let st = ha.session().lock_state();
        let SessionState::Conflicted(conflict) = &st.session_state else {
            panic!("unreadable replacement must conflict");
        };
        assert_eq!(st.text, "authority");
        assert_eq!(st.baseline.content, "authority");
        assert_ne!(conflict.disk_version, content_hash(""));
        assert!(conflict.disk_content.is_empty());
        drop(st);
        assert!(drain(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn concurrent_first_attaches_share_one_session() {
        let fx = fixture(&[("a.md", "x")]);
        let (a, b) = tokio::join!(
            fx.registry.attach(&fx.workspace, "a.md", "w1", None),
            fx.registry.attach(&fx.workspace, "a.md", "w2", None),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert!(Arc::ptr_eq(a.session(), b.session()));
        assert_eq!(fx.registry.lock_sessions().len(), 1);
        assert_eq!(a.session().attach_count(), 2);
    }

    #[tokio::test]
    async fn push_commits_fans_to_all_and_acks_sender() {
        let fx = fixture(&[("a.md", "ab")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (_hb, mut rxb) = attach(&fx, "a.md", "w2", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        ha.push(0, vec![update("c1", json!([1, [0, "X"], 1]))])
            .unwrap();

        let a_frames = drain(&mut rxa);
        assert_eq!(a_frames.len(), 2, "sender sees echo then ack: {a_frames:?}");
        assert_eq!(a_frames[0]["type"], "updates");
        assert_eq!(a_frames[0]["version"], 0);
        assert_eq!(a_frames[0]["updates"][0]["clientID"], "c1");
        assert_eq!(
            a_frames[0]["updates"][0]["changes"],
            json!([1, [0, "X"], 1])
        );
        assert_eq!(a_frames[1]["type"], "push-ok");
        assert_eq!(a_frames[1]["version"], 1);

        let b_frames = drain(&mut rxb);
        assert_eq!(b_frames.len(), 1);
        assert_eq!(b_frames[0]["type"], "updates");

        let (text, _) = ha.session().authority_view();
        assert_eq!(text, "aXb");
    }

    #[tokio::test]
    async fn stale_push_answers_push_stale_to_sender_only() {
        let fx = fixture(&[("a.md", "ab")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (hb, mut rxb) = attach(&fx, "a.md", "w2", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        ha.push(0, vec![update("c1", json!([[2, "yo"]]))]).unwrap();
        drain(&mut rxa);
        drain(&mut rxb);

        // B pushes at the version it last confirmed; the authority has
        // moved on.
        hb.push(0, vec![update("c2", json!([2, [0, "!"]]))])
            .unwrap();
        let b_frames = drain(&mut rxb);
        assert_eq!(b_frames.len(), 1);
        assert_eq!(b_frames[0]["type"], "push-stale");
        assert_eq!(b_frames[0]["version"], 1);
        assert_eq!(drain(&mut rxa).len(), 0, "no fan on a stale push");

        // After rebasing (here: recomputing against v1) the push lands.
        hb.push(1, vec![update("c2", json!([2, [0, "!"]]))])
            .unwrap();
        assert_eq!(hb.session().authority_view().0, "yo!");
    }

    #[tokio::test]
    async fn push_batch_is_all_or_nothing_and_rejects_bad_input() {
        let fx = fixture(&[("a.md", "abc")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        // Second update's span mismatches the doc the first produces.
        let err = ha
            .push(
                0,
                vec![update("c1", json!([[3, "xy"]])), update("c1", json!([99]))],
            )
            .unwrap_err();
        assert!(matches!(
            err,
            PushError::Apply(ApplyError::LengthMismatch { .. })
        ));
        let st = ha.session().lock_state();
        assert_eq!(st.text, "abc", "failed batch must not touch the authority");
        assert_eq!(st.version, 0);
        drop(st);
        assert_eq!(drain(&mut rxa).len(), 0, "failed batch fans nothing");

        // Reserved synthetic ids are rejected before anything runs.
        let err = ha.push(0, vec![update("$disk", json!([3]))]).unwrap_err();
        assert!(matches!(err, PushError::ReservedClientId(_)));
    }

    #[tokio::test]
    async fn reconnect_version_gets_incremental_catchup_with_flush_state() {
        let fx = fixture(&[("a.md", "")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([[0, "a"]]))]).unwrap();
        ha.push(1, vec![update("c1", json!([1, [0, "b"]]))])
            .unwrap();
        ha.push(2, vec![update("c1", json!([2, [0, "c"]]))])
            .unwrap();

        // A reconnect that confirmed v1 gets exactly v1..v3 plus the
        // flush state, not a snapshot.
        let (_hb, mut rxb) = attach(&fx, "a.md", "w2", Some(1)).await;
        let frames = drain(&mut rxb);
        assert_eq!(frames.len(), 2, "{frames:?}");
        assert_eq!(frames[0]["type"], "updates");
        assert_eq!(frames[0]["version"], 1);
        assert_eq!(frames[0]["updates"].as_array().unwrap().len(), 2);
        assert_eq!(frames[1]["type"], "flush");
        assert_eq!(frames[1]["dirty"], true);

        // An explicit pull answers the same shape.
        drain(&mut rxa);
        ha.pull(2);
        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "updates");
        assert_eq!(frames[0]["version"], 2);
        assert_eq!(frames[0]["updates"].as_array().unwrap().len(), 1);

        // A pull at the current version has nothing to say.
        ha.pull(3);
        assert_eq!(drain(&mut rxa).len(), 0);
    }

    #[tokio::test]
    async fn log_ring_evicts_and_reconnect_below_base_snapshots() {
        let fx = fixture(&[("a.md", "")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        // One oversized update blows the byte cap and evicts itself.
        let big = "x".repeat(DOC_LOG_MAX_BYTES + 1024);
        ha.push(0, vec![update("c1", json!([[0, big]]))]).unwrap();
        {
            let st = ha.session().lock_state();
            assert_eq!(st.version, 1);
            assert_eq!(st.log_base, 1, "oversized entry evicted immediately");
            assert!(st.log.is_empty());
            assert_eq!(st.log_bytes, 0);
        }

        // A reconnect below the base cannot be served incrementally.
        let (_hb, mut rxb) = attach(&fx, "a.md", "w2", Some(0)).await;
        let frames = drain(&mut rxb);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "snapshot");
        assert_eq!(frames[0]["version"], 1);

        // The count cap holds too.
        for version in 1..=(DOC_LOG_MAX_UPDATES as u64 + 10) {
            ha.push(version, vec![update("c1", json!([version_len(&ha)]))])
                .unwrap();
        }
        let st = ha.session().lock_state();
        assert!(st.log.len() <= DOC_LOG_MAX_UPDATES);
        assert_eq!(st.log_base + st.log.len() as u64, st.version);
    }

    /// Identity retain over the current doc, as a raw section value.
    fn version_len(handle: &DocAttachHandle) -> Value {
        let st = handle.session().lock_state();
        json!(st.len16)
    }

    #[tokio::test]
    async fn cursor_clamps_fans_to_others_and_cleans_up() {
        let fx = fixture(&[("a.md", "hello")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (hb, mut rxb) = attach(&fx, "a.md", "w2", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        ha.cursor(3, 9999);
        assert_eq!(drain(&mut rxa).len(), 0, "own cursor is not echoed");
        let frames = drain(&mut rxb);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "cursor");
        assert_eq!(frames[0]["id"], ha.attach_id());
        assert_eq!(frames[0]["w"], "w1");
        assert_eq!(frames[0]["anchor"], 3);
        assert_eq!(frames[0]["head"], 5, "head clamps to len16");

        // A later attach sees the cursor in its snapshot.
        let (_hc, mut rxc) = attach(&fx, "a.md", "w3", None).await;
        let frames = drain(&mut rxc);
        assert_eq!(frames[0]["cursors"][0]["id"], ha.attach_id());

        // Detach fans cursor-gone to the survivors.
        let a_id = ha.attach_id();
        drop(ha);
        let frames = drain(&mut rxb);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "cursor-gone");
        assert_eq!(frames[0]["id"], a_id);
        assert_eq!(hb.session().attach_count(), 2);
    }

    #[tokio::test]
    async fn flush_debounces_writes_and_stamps_token() {
        let fx = fixture(&[("a.md", "ab")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([2, [0, "c"]]))])
            .unwrap();
        drain(&mut rxa);

        // Inside the debounce window nothing flushes.
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "ab");
        assert_eq!(drain(&mut rxa).len(), 0);

        // Past the debounce the write lands, the token is adopted, and
        // the clients hear about it.
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "abc");
        assert!(fx.self_writes.should_suppress("a.md"));
        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "flush");
        assert_eq!(frames[0]["dirty"], false);
        assert!(frames[0]["mtime_ns"].is_string());
        let st = ha.session().lock_state();
        assert!(!st.session_state.is_dirty());
        assert!(st.flushed_mtime_ns.is_some());
    }

    #[tokio::test]
    async fn edit_during_flush_keeps_the_session_dirty() {
        let fx = fixture(&[("a.md", "")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([[0, "v1"]]))]).unwrap();

        // Interleave: capture the flush job, then land another edit
        // before the write "completes".
        let job = ha.session().begin_flush().expect("dirty session");
        ha.push(1, vec![update("c1", json!([2, [0, "+"]]))])
            .unwrap();
        fx.workspace
            .write_text_if_unchanged("a.md", job.expected_mtime_ns, &job.text)
            .unwrap();
        let stat = fx.workspace.stat("a.md").unwrap();
        ha.session().finish_flush(job.epoch, &stat, &job.text);

        let st = ha.session().lock_state();
        assert!(
            st.session_state.is_dirty(),
            "the mid-flight edit must survive as dirt"
        );
        assert_eq!(st.flushed_mtime_ns, stat.mtime_ns, "token still adopted");
        drop(st);
        let frames = drain(&mut rxa);
        let flush = frames.last().unwrap();
        assert_eq!(flush["type"], "flush");
        assert_eq!(flush["dirty"], true);
    }

    #[tokio::test]
    async fn detach_forces_flush_grace_reaps_and_reattach_within_grace_is_incremental() {
        let fx = fixture(&[("a.md", "")]);
        let (ha, _rxa) = attach(&fx, "a.md", "w1", None).await;
        ha.push(0, vec![update("c1", json!([[0, "typed"]]))])
            .unwrap();
        let session = Arc::clone(ha.session());
        drop(ha);

        // The last detach requests a prompt flush; the pass honors it
        // without waiting out the debounce.
        assert!(session.lock_state().flush_now);
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "typed");

        // Within grace the session survives, so a versioned reattach
        // takes the incremental path (here: already current, so just
        // cursors-and-flush, no snapshot).
        let (hb, mut rxb) = attach(&fx, "a.md", "w2", Some(1)).await;
        let frames = drain(&mut rxb);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["type"], "flush");
        assert!(Arc::ptr_eq(hb.session(), &session), "same session reused");
        drop(hb);

        // Not yet aged: the reaper leaves it.
        fx.registry.reap_pass();
        assert_eq!(fx.registry.lock_sessions().len(), 1);

        // Aged past grace and clean: reaped, and the next attach
        // starts a fresh session from disk.
        session.detached_at.store(
            now_unix_millis() - DOC_DETACH_GRACE.as_millis() as i64 - 1_000,
            Ordering::Relaxed,
        );
        fx.registry.reap_pass();
        assert_eq!(fx.registry.lock_sessions().len(), 0);
        assert!(session.closed.load(Ordering::Relaxed));
        let (hc, mut rxc) = attach(&fx, "a.md", "w3", Some(1)).await;
        let frames = drain(&mut rxc);
        assert_eq!(frames[0]["type"], "snapshot");
        assert_eq!(frames[0]["doc"], "typed");
        assert_eq!(frames[0]["version"], 0, "fresh session, fresh log");
        assert!(!Arc::ptr_eq(hc.session(), &session));
    }

    #[tokio::test]
    async fn reaper_spares_dirty_sessions() {
        let fx = fixture(&[("a.md", "")]);
        let (ha, _rxa) = attach(&fx, "a.md", "w1", None).await;
        ha.push(0, vec![update("c1", json!([[0, "unsaved"]]))])
            .unwrap();
        let session = Arc::clone(ha.session());
        drop(ha);
        session.detached_at.store(
            now_unix_millis() - DOC_DETACH_GRACE.as_millis() as i64 - 1_000,
            Ordering::Relaxed,
        );
        fx.registry.reap_pass();
        assert_eq!(
            fx.registry.lock_sessions().len(),
            1,
            "unflushed content must never be reaped away"
        );
    }

    #[tokio::test]
    async fn reconcile_ignores_own_flush_echo() {
        let fx = fixture(&[("a.md", "ab")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([2, [0, "c"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);
        let version_before = ha.session().lock_state().version;

        // The watcher event our own flush produced: token matches,
        // nothing happens.
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(ha.session().lock_state().version, version_before);
        assert_eq!(drain(&mut rxa).len(), 0);
    }

    #[tokio::test]
    async fn reconcile_merges_external_writes_as_disk_updates() {
        let fx = fixture(&[("a.md", "hello world")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (_hb, mut rxb) = attach(&fx, "a.md", "w2", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        // An agent appends to the file behind the server's back.
        std::fs::write(fx.root.path().join("a.md"), "hello world\nagent line\n").unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;

        let (text, token) = ha.session().authority_view();
        assert_eq!(text, "hello world\nagent line\n");
        assert!(token.is_some(), "disk token adopted");
        let st = ha.session().lock_state();
        assert_eq!(st.version, 1);
        assert!(!st.session_state.is_dirty(), "authority equals disk: clean");
        drop(st);
        for rx in [&mut rxa, &mut rxb] {
            let frames = drain(rx);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["type"], "updates");
            assert_eq!(frames[0]["updates"][0]["clientID"], "$disk");
        }
    }

    #[tokio::test]
    async fn reconcile_adopts_token_silently_on_equal_content() {
        let fx = fixture(&[("a.md", "same")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        // Rewrite the identical bytes: mtime changes, content does not.
        std::fs::write(fx.root.path().join("a.md"), "same").unwrap();
        let disk_token = fx.workspace.stat("a.md").unwrap().mtime_ns;
        reconcile_session(ha.session(), &fx.workspace).await;

        let st = ha.session().lock_state();
        assert_eq!(st.version, 0, "no synthetic update for equal content");
        assert_eq!(st.flushed_mtime_ns, disk_token, "token adopted");
        drop(st);
        assert_eq!(drain(&mut rxa).len(), 0, "silent adoption");
    }

    #[tokio::test]
    async fn removed_file_stops_flushing_and_never_resurrects() {
        let fx = fixture(&[("a.md", "content")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        std::fs::remove_file(fx.root.path().join("a.md")).unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Removed,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;
        // Absence corroborates across two observations before the
        // removal fans.
        assert_eq!(drain(&mut rxa).len(), 0, "first absence only parks");
        backdate_pending_removal(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "removed");
        {
            let st = ha.session().lock_state();
            assert_eq!(st.flushed_mtime_ns, None);
            assert!(!st.session_state.is_dirty(), "flush clock stopped");
        }
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(
            !fx.workspace.exists("a.md"),
            "a deliberate delete is not resurrected"
        );

        // The next client edit re-dirties; the CAS-against-None write
        // recreates the file.
        ha.push(0, vec![update("c1", json!([[7], [0, "fresh"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "fresh");
    }

    #[tokio::test]
    async fn flush_echo_removed_event_is_not_a_removal() {
        let fx = fixture(&[("a.md", "ab")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([2, [0, "c"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);
        let token = ha.session().lock_state().flushed_mtime_ns;

        // The flusher's atomic temp+rename surfaces a watcher Removed
        // for a path that still exists on disk; it must reconcile as a
        // flush echo, not a removal.
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Removed,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;

        assert_eq!(drain(&mut rxa).len(), 0, "no spurious removed frame");
        let st = ha.session().lock_state();
        assert_eq!(st.flushed_mtime_ns, token, "token untouched");
        assert!(!st.session_state.is_dirty(), "session stays clean");
    }

    #[tokio::test]
    async fn rename_away_still_fans_removed_for_the_source() {
        let fx = fixture(&[("a.md", "x")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        std::fs::rename(fx.root.path().join("a.md"), fx.root.path().join("b.md")).unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Renamed,
                    path: Some("a.md".into()),
                    to: Some("b.md".into()),
                },
            )
            .await;
        // The vacated source parks as a pending absence and fans the
        // removal once it corroborates.
        assert_eq!(drain(&mut rxa).len(), 0, "first absence only parks");
        backdate_pending_removal(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "removed");
        assert!(ha.session().lock_state().flushed_mtime_ns.is_none());
    }

    #[tokio::test]
    async fn lagged_watch_reconciles_every_live_session() {
        let fx = fixture(&[("a.md", "one"), ("b.md", "two")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (hb, mut rxb) = attach(&fx, "b.md", "w1", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        std::fs::write(fx.root.path().join("a.md"), "one CHANGED").unwrap();
        fx.registry.reconcile_all(&fx.workspace).await;

        assert_eq!(ha.session().authority_view().0, "one CHANGED");
        assert_eq!(hb.session().authority_view().0, "two");
        assert_eq!(drain(&mut rxa).len(), 1, "merged session heard the update");
        assert_eq!(drain(&mut rxb).len(), 0, "untouched session stays silent");
    }

    #[tokio::test]
    async fn flush_cas_conflict_enters_conflicted_after_corroboration() {
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([4, [0, " typed"]]))])
            .unwrap();
        drain(&mut rxa);

        // Stale the session token: an external write bumps the mtime.
        std::fs::write(fx.root.path().join("a.md"), "external").unwrap();
        backdate_dirty(ha.session());
        let settled = flush_session(ha.session(), &fx.workspace, &fx.self_writes).await;

        // The conflict defers to corroboration: nothing merged yet, no
        // failure fanned, the divergent observation parked.
        assert!(!settled, "deferred fold-in is not a settled flush");
        assert!(
            !fx.self_writes.should_suppress("a.md"),
            "the CAS-conflict arm must cancel its reservation"
        );
        assert_eq!(ha.session().authority_view().0, "base typed");
        assert_eq!(drain(&mut rxa).len(), 0, "no fan while parked");
        {
            let st = ha.session().lock_state();
            assert!(st.session_state.content_observation().is_some());
            assert_eq!(st.flush_failures, 0, "a deferral is not a failure");
        }

        // The observation holds: the line merge proves the edits
        // overlap, keeps both sides, and pauses flush.
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        let (text, _) = ha.session().authority_view();
        assert_eq!(text, "base typed");
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "external");
        let st = ha.session().lock_state();
        let SessionState::Conflicted(conflict) = &st.session_state else {
            panic!("corroborated divergence must enter Conflicted");
        };
        assert_eq!(conflict.disk_content, "external");
        drop(st);
        assert_eq!(drain(&mut rxa).len(), 0, "no actor silently wins");
    }

    #[tokio::test]
    async fn close_all_flushes_fans_closed_and_empties_the_registry() {
        let fx = fixture(&[("a.md", ""), ("b.md", "clean")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (hb, mut rxb) = attach(&fx, "b.md", "w1", None).await;
        drain(&mut rxa);
        drain(&mut rxb);
        ha.push(0, vec![update("c1", json!([[0, "dirty"]]))])
            .unwrap();
        drain(&mut rxa);

        fx.registry
            .close_all("reset", Some(&fx.workspace), &fx.self_writes)
            .await;

        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "dirty");
        let a_frames = drain(&mut rxa);
        assert_eq!(a_frames.last().unwrap()["type"], "closed");
        assert_eq!(a_frames.last().unwrap()["reason"], "reset");
        assert_eq!(drain(&mut rxb).last().unwrap()["type"], "closed");
        assert_eq!(fx.registry.lock_sessions().len(), 0);
        assert!(matches!(
            ha.push(1, vec![update("c1", json!([5]))]),
            Err(PushError::Closed)
        ));
        assert!(matches!(
            hb.push(0, vec![update("c1", json!([5]))]),
            Err(PushError::Closed)
        ));
    }

    #[tokio::test]
    async fn http_replace_fans_and_marks_dirty() {
        let fx = fixture(&[("a.md", "old")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        ha.session().apply_replace("$http", "new body").unwrap();
        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "updates");
        assert_eq!(frames[0]["updates"][0]["clientID"], "$http");
        let st = ha.session().lock_state();
        assert_eq!(st.text, "new body");
        assert_eq!(st.version, 1);
        assert!(st.session_state.is_dirty(), "PUT divert flushes explicitly");
        drop(st);

        // Equal content is a no-op.
        ha.session().apply_replace("$http", "new body").unwrap();
        assert_eq!(drain(&mut rxa).len(), 0);
        assert_eq!(ha.session().lock_state().version, 1);

        // The divert-side size gate holds here too.
        let too_big = "x".repeat(TEXT_WRITE_LIMIT as usize + 1);
        assert!(matches!(
            ha.session().apply_replace("$http", &too_big),
            Err(ApplyError::DocTooLarge { .. })
        ));
    }

    #[tokio::test]
    async fn legacy_oversize_session_can_shrink_within_its_semantic_budget() {
        let fx = fixture(&[]);
        let legacy = "x".repeat(3 * 1024 * 1024);
        std::fs::write(fx.root.path().join("legacy.txt"), &legacy).unwrap();
        let (ha, mut rx) = attach(&fx, "legacy.txt", "w1", None).await;
        drain(&mut rx);

        let smaller = "y".repeat(5 * 1024 * 1024 / 2);
        ha.session().apply_replace("$http", &smaller).unwrap();

        assert_eq!(ha.session().authority_view().0.len(), smaller.len());
    }

    #[tokio::test]
    async fn post_preflight_write_failure_cancels_suppression() {
        let fx = fixture(&[("a.md", "x")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([1, [0, "y"]]))])
            .unwrap();

        // The strict preflight succeeds, then the hook replaces the
        // target with a directory inside the blocking write task.
        ha.session().test_fail_after_preflight();
        let ok = flush_session(ha.session(), &fx.workspace, &fx.self_writes).await;
        assert!(
            !fx.self_writes.should_suppress("a.md"),
            "a post-preflight failure must cancel watcher suppression"
        );
        assert!(!ok, "failed write must report false");
        {
            let st = ha.session().lock_state();
            assert!(st.session_state.is_dirty(), "content stays dirty in memory");
        }
        assert!(fx.root.path().join("a.md").is_dir());

        // Restore the disk side and its CAS token; the retained
        // authority then commits normally.
        std::fs::remove_dir(fx.root.path().join("a.md")).unwrap();
        fx.workspace.write_text("a.md", "x").unwrap();
        ha.session().lock_state().flushed_mtime_ns = fx.workspace.stat("a.md").unwrap().mtime_ns;
        assert!(flush_session(ha.session(), &fx.workspace, &fx.self_writes).await);
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "xy");
    }

    #[tokio::test]
    async fn crlf_seed_normalizes_to_lf_without_proactive_flush() {
        let fx = fixture(&[("a.md", "a\r\nb\rc")]);
        let disk_token = fx.workspace.stat("a.md").unwrap().mtime_ns;
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;

        let frames = drain(&mut rxa);
        assert_eq!(frames[0]["type"], "snapshot");
        assert_eq!(frames[0]["doc"], "a\nb\nc", "authority text is pure LF");
        assert_eq!(frames[0]["dirty"], false);
        {
            let st = ha.session().lock_state();
            assert!(!st.session_state.is_dirty(), "normalization is not an edit");
            assert_eq!(st.flushed_mtime_ns, disk_token, "CRLF file's token adopted");
            assert_eq!(st.len16, 5);
        }

        // No proactive flush: the disk keeps its CRLF bytes until a
        // real edit lands.
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "a\r\nb\rc");
    }

    #[tokio::test]
    async fn crlf_disk_merge_converges_clients_on_lf() {
        let fx = fixture(&[("a.md", "one\ntwo")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (_hb, mut rxb) = attach(&fx, "a.md", "w2", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        std::fs::write(fx.root.path().join("a.md"), "one\r\ntwo\r\nthree\r\n").unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;

        assert_eq!(ha.session().authority_view().0, "one\ntwo\nthree\n");
        for rx in [&mut rxa, &mut rxb] {
            let frames = drain(rx);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["updates"][0]["clientID"], "$disk");
        }

        // Rewriting the same CRLF bytes bumps only the mtime: after
        // normalization the content is equal, so the token is adopted
        // silently and no synthetic update fans.
        std::fs::write(fx.root.path().join("a.md"), "one\r\ntwo\r\nthree\r\n").unwrap();
        let new_token = fx.workspace.stat("a.md").unwrap().mtime_ns;
        let version_before = ha.session().lock_state().version;
        reconcile_session(ha.session(), &fx.workspace).await;
        let st = ha.session().lock_state();
        assert_eq!(st.version, version_before);
        assert_eq!(st.flushed_mtime_ns, new_token);
        drop(st);
        assert_eq!(drain(&mut rxa).len(), 0);
    }

    #[tokio::test]
    async fn first_edit_after_crlf_seed_flushes_lf_to_disk() {
        let fx = fixture(&[("a.md", "l1\r\nl2")]);
        let (ha, _rxa) = attach(&fx, "a.md", "w1", None).await;

        // Seeded doc is "l1\nl2" (5 units); append "!".
        ha.push(0, vec![update("c1", json!([5, [0, "!"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;

        let on_disk = fx.workspace.read_text("a.md").unwrap();
        assert_eq!(
            on_disk, "l1\nl2!",
            "LF conversion lands with the first save"
        );
        assert!(!on_disk.contains('\r'));
    }

    #[tokio::test]
    async fn attach_rejects_invalid_and_missing_paths() {
        let fx = fixture(&[]);
        for path in ["../escape.md", "no-such.md"] {
            let err = fx
                .registry
                .attach(&fx.workspace, path, "w1", None)
                .await
                .err();
            assert!(err.is_some(), "attach must fail for {path}");
        }
        assert_eq!(fx.registry.lock_sessions().len(), 0);
    }

    // ---- untrusted-filesystem reconcile guards. A filesystem can lie
    // about a just-flushed write (Google-Drive FUSE clients re-stamp
    // mtime when the upload commits and serve stale or empty
    // read-after-write); these tests hold that no such lie blanks a
    // session, reverts confirmed edits, or discards dirty ones.

    #[tokio::test]
    async fn empty_read_after_flush_is_refused_and_disk_restored() {
        // Seed 16 UTF-16 units: "# plan\nline one\n".
        let fx = fixture(&[("a.md", "# plan\nline one\n")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        let (_hb, mut rxb) = attach(&fx, "a.md", "w2", None).await;
        drain(&mut rxa);
        drain(&mut rxb);

        // The user types; the edit is confirmed and flushed. Disk is good.
        ha.push(0, vec![update("c1", json!([16, [0, "typed"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);
        drain(&mut rxb);
        assert_eq!(
            fx.workspace.read_text("a.md").unwrap(),
            "# plan\nline one\ntyped"
        );

        // The user keeps typing: an unflushed (dirty) edit lands.
        ha.push(1, vec![update("c1", json!([21, [0, " more"]]))])
            .unwrap();
        drain(&mut rxa);
        drain(&mut rxb);
        assert!(ha.session().lock_state().session_state.is_dirty());

        // The watcher echo of OUR OWN flush comes back with a re-stamped
        // mtime, and the read-after-write returns the upload placeholder:
        // EMPTY content. Through the Workspace API this is
        // indistinguishable from truncating the file behind the server's
        // back.
        std::fs::write(fx.root.path().join("a.md"), "").unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;

        // Refused: the authority keeps every confirmed and dirty edit,
        // no client hears a $disk update, and the observation parks as
        // pending with the token adopted.
        let (text, _) = ha.session().authority_view();
        assert_eq!(text, "# plan\nline one\ntyped more");
        {
            let st = ha.session().lock_state();
            assert!(st.session_state.is_dirty(), "dirty edit survives");
            assert!(
                st.session_state.content_observation().is_some(),
                "observation parked"
            );
        }
        for rx in [&mut rxa, &mut rxb] {
            assert_eq!(drain(rx).len(), 0, "no $disk fan for the refusal");
        }

        // The adopted token lets the next flush CAS-write the authority
        // back over the suspect empty file: the live session wins.
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(
            fx.workspace.read_text("a.md").unwrap(),
            "# plan\nline one\ntyped more"
        );
        // The restore's echo clears the pending observation.
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert!(ha
            .session()
            .lock_state()
            .session_state
            .content_observation()
            .is_none());
    }

    #[tokio::test]
    async fn stale_prewrite_read_is_recognized_as_own_echo() {
        let fx = fixture(&[("a.md", "v1")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        // Typed + confirmed + flushed: disk has "v1 typed".
        ha.push(0, vec![update("c1", json!([2, [0, " typed"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);
        assert_eq!(fx.workspace.read_text("a.md").unwrap(), "v1 typed");

        // The flush's own echo arrives with a re-stamped mtime and the
        // read serves the PRE-write content: bytes this session itself
        // adopted at seed time, still in the echo ring.
        std::fs::write(fx.root.path().join("a.md"), "v1").unwrap();
        let stale_token = fx.workspace.stat("a.md").unwrap().mtime_ns;
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;

        // The authority keeps the flushed edit; no client hears a $disk
        // revert; the observed token is adopted so CAS writes stay
        // viable against whatever identity the fs reports.
        let (text, token) = ha.session().authority_view();
        assert_eq!(text, "v1 typed", "flushed edit survives the stale read");
        assert_eq!(token, stale_token, "token adopted from the observation");
        assert_eq!(drain(&mut rxa).len(), 0, "no $disk fan");
        assert!(!ha.session().lock_state().session_state.is_dirty());
    }

    #[tokio::test]
    async fn external_restore_folds_after_echo_ttl() {
        let fx = fixture(&[("a.md", "v1")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.session()
            .test_set_disk_echo_ttl(Duration::from_millis(500));
        ha.session().lock_state().disk_echo.note(content_hash("v1"));

        std::fs::write(fx.root.path().join("a.md"), "v2").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(ha.session().authority_view().0, "v2");
        drain(&mut rxa);

        std::fs::write(fx.root.path().join("a.md"), "v1").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(
            ha.session().authority_view().0,
            "v2",
            "a live echo-ring entry still protects authority"
        );
        assert!(
            ha.session()
                .lock_state()
                .session_state
                .content_observation()
                .is_some(),
            "the restore observation remains scheduled"
        );

        tokio::time::sleep(Duration::from_millis(600)).await;
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert_eq!(ha.session().authority_view().0, "v1");
        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["updates"][0]["clientID"], "$disk");
    }

    #[tokio::test]
    async fn stale_token_echo_never_reverts_midflight_typing() {
        // A reconcile that observes the disk while the flush's token
        // commit is still pending (the io_lock serializes the real
        // tasks; this simulates the pre-commit token state directly)
        // must recognize the flushed bytes as its own via the echo
        // ring, not revert the keystrokes that landed mid-flush.
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        let pre_flush_token = ha.session().lock_state().flushed_mtime_ns;

        ha.push(0, vec![update("c1", json!([4, [0, " one"]]))])
            .unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);

        // Typing lands right after the write hit the disk.
        ha.push(1, vec![update("c1", json!([8, [0, " two"]]))])
            .unwrap();
        drain(&mut rxa);
        ha.session().lock_state().flushed_mtime_ns = pre_flush_token;

        reconcile_session(ha.session(), &fx.workspace).await;

        // The mid-flight keystrokes survive, stay dirty (they still
        // need their own flush), and no $disk revert is fanned.
        let (text, _) = ha.session().authority_view();
        assert_eq!(text, "base one two");
        {
            let st = ha.session().lock_state();
            assert!(st.session_state.is_dirty(), "unflushed typing stays dirty");
        }
        assert_eq!(drain(&mut rxa).len(), 0, "no $disk fan");
    }

    #[tokio::test]
    async fn external_edit_into_dirty_session_does_not_discard_authority() {
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([4, [0, " typed"]]))])
            .unwrap();
        drain(&mut rxa);
        assert!(ha.session().lock_state().session_state.is_dirty());

        // A genuine external edit lands while the session is dirty:
        // not our bytes, so it must corroborate before folding in.
        std::fs::write(fx.root.path().join("a.md"), "external").unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("a.md".into()),
                    to: None,
                },
            )
            .await;
        assert_eq!(ha.session().authority_view().0, "base typed");
        assert_eq!(drain(&mut rxa).len(), 0, "first observation only parks");

        // The observation holds. The merge proves this overlap and
        // retains the local authority for explicit resolution; disk
        // must never silently win.
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert_eq!(ha.session().authority_view().0, "base typed");
        assert_eq!(drain(&mut rxa).len(), 0, "no actor silently wins");
    }

    #[tokio::test]
    async fn changing_disk_under_corroboration_restarts_the_clock() {
        let fx = fixture(&[("a.md", "base")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        ha.push(0, vec![update("c1", json!([4, [0, "!"]]))])
            .unwrap();
        drain(&mut rxa);

        // First divergent observation parks; the disk then changes
        // AGAIN before the re-check: the fresh observation replaces the
        // pending one instead of corroborating it.
        std::fs::write(fx.root.path().join("a.md"), "flicker one").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        backdate_pending_fold(ha.session());
        std::fs::write(fx.root.path().join("a.md"), "flicker two").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(ha.session().authority_view().0, "base!");
        assert_eq!(drain(&mut rxa).len(), 0, "unstable disk never folds");
    }

    #[tokio::test]
    async fn honest_truncation_folds_once_guards_lapse() {
        let fx = fixture(&[("a.md", "content")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);
        // Expire the seed entry so the ring reads as stale history, the
        // state after a minute of idling.
        ha.session().test_set_disk_echo_ttl(Duration::from_nanos(1));

        // A clean session, no recent self-writes: an external truncation
        // is suspicious only until corroborated.
        std::fs::write(fx.root.path().join("a.md"), "").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(ha.session().authority_view().0, "content");
        assert_eq!(drain(&mut rxa).len(), 0, "first observation parks");

        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert_eq!(ha.session().authority_view().0, "");
        let frames = drain(&mut rxa);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["updates"][0]["clientID"], "$disk");
    }

    #[tokio::test]
    async fn transient_absence_does_not_fan_removed() {
        let fx = fixture(&[("a.md", "content")]);
        let (ha, mut rxa) = attach(&fx, "a.md", "w1", None).await;
        drain(&mut rxa);

        // A non-atomic replace vanishes the path for one observation;
        // it is back before the corroborating re-check.
        std::fs::remove_file(fx.root.path().join("a.md")).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(drain(&mut rxa).len(), 0, "absence only parks");
        assert!(ha
            .session()
            .lock_state()
            .session_state
            .removal_observation()
            .is_some());

        std::fs::write(fx.root.path().join("a.md"), "content").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert!(ha
            .session()
            .lock_state()
            .session_state
            .removal_observation()
            .is_none());
        // The re-appeared file reconciles as equal content (or an echo);
        // either way no removed frame was ever fanned.
        for f in drain(&mut rxa) {
            assert_ne!(f["type"], "removed");
        }
    }
}
