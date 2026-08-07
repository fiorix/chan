//! Live Excalidraw scene sessions: the server-side authority for
//! element-level collaborative drawing.
//!
//! One `SceneSession` per attached workspace-relative path. Clients
//! push `{elements, appState?, files?}` batches; the authority merges
//! each element through the pure last-writer-wins model in [`scene`]
//! and fans the accepted values to the OTHER attachments (the sender's
//! confirmation is its `push-ok`; unlike the doc route there is no
//! own-echo, because clients reconcile content instead of replaying an
//! update log). Scene pushes always merge: there is no version gate,
//! no push-stale, and no incremental catch-up; every (re)attach gets a
//! full snapshot, tombstones included, since scenes are small next to
//! keystroke logs.
//!
//! Fan-out uses one unbounded mpsc outbox per attachment, and every
//! server->client frame is enqueued while the session state lock is
//! held, so each socket sees a strict per-session FIFO. The wire
//! shapes come from `crate::routes::scene`, the single source for the
//! scene ws contract.
//!
//! While a session is live the server is the single writer to disk:
//! the flusher debounces dirty sessions to atomic CAS writes of the
//! scene file form. The reconciler adopts clean external writes
//! through the replace semantics and retains dirty divergence for
//! identity-aware resolution. Because a filesystem's mtime and
//! read-after-write cannot be trusted to identify our own flush echoes (network FUSE
//! mounts re-stamp mtime and serve stale/empty reads), the reconciler
//! also checks raw disk bytes against the session's
//! [`DiskEchoRing`] and defers suspicious fold-ins until a second
//! observation corroborates them, mirroring doc_sessions.
//!
//! State locks are std mutexes with short critical sections, never
//! held across await; lock order is registry map, then session state.
//! Each session additionally has an async `io_lock` serializing its
//! flush and reconcile disk IO end to end, acquired before any state
//! lock and held across those awaits; see the doc_sessions module doc
//! for the race it prevents.

pub mod scene;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chan_workspace::{
    semantic_write_budget, ChanError, FileStat, WatchEvent, WatchKind, Workspace, WorkspacePath,
    TEXT_WRITE_LIMIT,
};
use rand::RngCore;
use tokio::sync::{broadcast, mpsc, watch, Notify};

pub(crate) use crate::collab_sessions::HttpReplaceOutcome;
use crate::collab_sessions::{
    DurableBaseline, HttpReadView, HttpWriteView, MergeOutcome, SessionConflict, SessionState,
};
use crate::disk_echo::{content_hash, DiskEchoRing};
use crate::doc_sessions::recovery::{
    self, RecoveryAuthority, RecoveryBaseline, RecoveryConflict, RecoveryKind, RecoveryRecord,
    RecoveryState,
};
use crate::routes::scene::{PeerSceneCursor, ServerFrame};
use crate::self_writes::{
    check_write_preconditions, SelfWrites, WritePreconditionError, WritePreconditions,
};
use crate::state::WorkspaceCell;
use scene::{Applied, Scene, SceneError};

/// Debounce between a session turning dirty and its disk flush; parity
/// with the doc flusher and the SPA's classic autosave debounce.
const SCENE_FLUSH_DEBOUNCE: Duration = Duration::from_millis(800);

/// How long a fully detached session survives before the reaper drops
/// it. A browser reload reattaches well within the grace window (and
/// takes a snapshot either way; the grace mainly preserves tombstones
/// across quick reloads).
const SCENE_DETACH_GRACE: Duration = Duration::from_secs(30);

/// Flusher wake cadence; the debounce is measured against
/// `dirty_since`, the tick only bounds how late a flush can start.
const FLUSH_TICK: Duration = Duration::from_millis(200);

/// A divergent disk observation that cannot be verified as our own
/// echo must hold this long, unchanged, before the state machine
/// settles it; parity with doc_sessions.
const CORROBORATE_AFTER: Duration = Duration::from_millis(300);
const REMOVED_DISK_MARKER: &str = "\0chan:removed";
const UNREADABLE_DISK_MARKER: &str = "\0chan:unreadable";
static NEXT_CONFLICT_ID: AtomicU64 = AtomicU64::new(1);

/// A fresh versionNonce for server-side bumps, in Excalidraw's
/// `randomInteger` range `[0, 2^31)`.
fn fresh_nonce() -> u64 {
    (rand::thread_rng().next_u32() & 0x7fff_ffff) as u64
}

/// All live scene sessions, keyed by workspace-relative POSIX path.
pub struct SceneRegistry {
    sessions: Mutex<HashMap<String, Arc<SceneSession>>>,
    /// Wakes the flusher out of its tick sleep (detach and forced
    /// flushes want sub-tick latency).
    flush_wake: Notify,
    next_attach_id: AtomicU64,
}

/// One live scene: the authority element state plus everything needed
/// to serve attaches, pushes, and the disk integration.
pub struct SceneSession {
    /// Workspace-relative POSIX path; the registry key.
    pub path: String,
    state: Mutex<SceneState>,
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
    x: f64,
    y: f64,
    tool: Option<String>,
    selected: Option<Vec<String>>,
}

struct SceneState {
    /// Authority scene, tombstones included.
    scene: Scene,
    /// Semantic cap derived from the last durable file size. Legacy
    /// oversized scenes may shrink but cannot grow.
    write_budget: u64,
    /// Count of accepted mutations (pushes, replaces, disk merges that
    /// changed anything) since session creation. Informational on the
    /// wire; there is no rebase protocol.
    version: u64,
    attaches: HashMap<u64, AttachSink>,
    cursors: HashMap<u64, CursorPos>,
    /// Explicit lifecycle state. Disk observations preserve the
    /// independent dirty clock; conflicts retain all three inputs and
    /// pause automatic writes.
    session_state: SessionState,
    /// Last canonical scene content known to have reached disk. This
    /// remains unchanged while observations or conflicts are pending.
    baseline: DurableBaseline,
    /// Skip the debounce on the next flusher pass (detach, forced
    /// flush).
    flush_now: bool,
    /// Authority changed since the last recovery record capture.
    /// Record capture clears this under the state lock before IO, so
    /// a push landing during persistence remains pending.
    recovery_pending: bool,
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
    /// Hashes of raw file text this session itself put on (or adopted
    /// from) disk. A reconcile read matching the ring is our own bytes
    /// under a re-stamped mtime, never an external edit.
    disk_echo: DiskEchoRing,
}

/// A registered attachment. Dropping it detaches: the outbox and
/// cursor are removed (peers see `cursor-gone`), and the last drop
/// stamps the detach time and requests a prompt flush.
pub struct SceneAttachHandle {
    registry: Arc<SceneRegistry>,
    session: Arc<SceneSession>,
    attach_id: u64,
    frames: Option<mpsc::UnboundedReceiver<String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum AttachError {
    /// Path validation or the seeding disk read failed (missing file,
    /// not readable text, non-UTF-8, ...).
    #[error(transparent)]
    Workspace(#[from] ChanError),
    /// The file read fine but is not a usable scene (corrupt JSON or
    /// over the size cap). The client degrades to the classic path
    /// rather than letting a flush overwrite a file the session could
    /// not represent.
    #[error(transparent)]
    Scene(#[from] SceneError),
    #[error("scene session read task failed: {0}")]
    Task(String),
}

/// A push the route must answer with an `error` frame and close the
/// attachment.
#[derive(Debug, thiserror::Error)]
pub enum PushError {
    #[error(transparent)]
    Scene(#[from] SceneError),
    #[error("session closed")]
    Closed,
}

fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Serialization of the scene wire frames cannot fail: every shape is
/// string-keyed plain data. The pin tests in routes/scene.rs would
/// catch a change that breaks this before it could panic here.
fn serialize(frame: &ServerFrame) -> String {
    serde_json::to_string(frame).expect("serialize scene server frame")
}

/// The fan payload for one accepted mutation. `version` is the session
/// version after the mutation committed.
fn update_frame(version: u64, applied: Applied) -> String {
    serialize(&ServerFrame::Update {
        version,
        elements: applied.elements,
        app_state: applied.app_state,
        files: (!applied.files.is_empty()).then_some(serde_json::Value::Object(applied.files)),
    })
}

fn snapshot_frame(path: &str, st: &SceneState) -> String {
    let cursors = st
        .cursors
        .iter()
        .map(|(id, c)| PeerSceneCursor {
            id: *id,
            w: c.window_id.clone(),
            x: c.x,
            y: c.y,
            tool: c.tool.clone(),
            selected: c.selected.clone(),
        })
        .collect();
    serialize(&ServerFrame::Snapshot {
        path: path.to_string(),
        version: st.version,
        elements: st.scene.elements_snapshot(),
        app_state: serde_json::Value::Object(st.scene.app_state().clone()),
        files: serde_json::Value::Object(st.scene.files().clone()),
        dirty: st.session_state.is_dirty(),
        mtime_ns: st.flushed_mtime_ns.map(|n| n.to_string()),
        cursors,
    })
}

fn flush_frame(st: &SceneState) -> String {
    serialize(&ServerFrame::Flush {
        dirty: st.session_state.is_dirty(),
        mtime_ns: st.flushed_mtime_ns.map(|n| n.to_string()),
        error: None,
    })
}

impl SceneState {
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
}

impl SceneSession {
    fn new(path: &str, seed_text: &str, scene: Scene, stat: &FileStat) -> Self {
        // The seed is disk-adopted content: a stale read serving those
        // raw bytes back later must count as an echo, not an external
        // edit. The ring holds raw file text, not the serialize_file
        // form, because a stale read returns exactly what was on disk.
        let mut disk_echo = DiskEchoRing::new();
        disk_echo.note_adopted(content_hash(seed_text));
        let baseline_content = scene.serialize_file();
        let baseline = DurableBaseline {
            content_hash: content_hash(&baseline_content),
            content: baseline_content,
            mtime_ns: stat.mtime_ns,
            authority_version: 0,
        };
        Self {
            path: path.to_string(),
            state: Mutex::new(SceneState {
                scene,
                write_budget: semantic_write_budget(Some(stat.size)),
                version: 0,
                attaches: HashMap::new(),
                cursors: HashMap::new(),
                session_state: SessionState::Clean,
                baseline,
                flush_now: false,
                recovery_pending: false,
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

    fn from_recovery(
        path: &str,
        disk: Option<(String, FileStat)>,
        unreadable_disk: Option<(u64, Option<i64>)>,
        record: RecoveryRecord,
    ) -> Result<Self, String> {
        let authority = Scene::parse(&record.authority.content)
            .map_err(|error| format!("parse recovered scene authority: {error}"))?;
        let baseline_scene = Scene::parse(&record.baseline.content)
            .map_err(|error| format!("parse recovered scene baseline: {error}"))?;
        let (disk_text, disk_scene, disk_stat) = match disk {
            Some((text, stat)) => {
                let scene = Scene::parse(&text).ok();
                (text, scene, Some(stat))
            }
            None => (String::new(), None, None),
        };
        let disk_mtime_ns = disk_stat
            .as_ref()
            .and_then(|stat| stat.mtime_ns)
            .or_else(|| unreadable_disk.and_then(|(_, mtime_ns)| mtime_ns));
        let disk_present = disk_stat.is_some();
        let baseline_hash = content_hash(&record.baseline.content);
        if baseline_hash != record.baseline.content_hash {
            return Err("scene recovery baseline hash mismatch".into());
        }
        if record.baseline.authority_version > record.authority.version {
            return Err("scene recovery baseline version is ahead of authority".into());
        }
        if record.authority.content.len() as u64 > record.authority.write_budget {
            return Err("scene recovery authority exceeds its write budget".into());
        }

        let disk_canonical = disk_scene.as_ref().map(Scene::serialize_file);
        let disk_hash = if disk_present {
            content_hash(&disk_text)
        } else if let Some((version, _)) = unreadable_disk {
            version
        } else {
            content_hash(REMOVED_DISK_MARKER)
        };
        let version = record.authority.version;
        let baseline = DurableBaseline {
            content: record.baseline.content,
            content_hash: baseline_hash,
            mtime_ns: record.baseline.mtime_ns,
            authority_version: record.baseline.authority_version,
        };
        let disk_matches_authority = disk_scene
            .as_ref()
            .is_some_and(|scene| scene.file_content_eq(&authority));
        let disk_matches_baseline = disk_scene
            .as_ref()
            .is_some_and(|scene| scene.file_content_eq(&baseline_scene));
        let session_state = match record.lifecycle {
            RecoveryState::Clean if disk_present && disk_scene.is_some() => {
                return Ok(Self::new(
                    path,
                    &disk_text,
                    disk_scene.expect("present disk has scene"),
                    disk_stat.as_ref().expect("present disk has stat"),
                ));
            }
            RecoveryState::Clean => {
                return Err("scene recovery is clean but the source file is unusable".into());
            }
            RecoveryState::Dirty if disk_matches_authority => SessionState::Clean,
            RecoveryState::Dirty if disk_matches_baseline => SessionState::Dirty {
                since: Instant::now(),
            },
            RecoveryState::Dirty => SessionState::Conflicted(SessionConflict {
                id: format!("scene-{}", NEXT_CONFLICT_ID.fetch_add(1, Ordering::Relaxed)),
                baseline_version: baseline_hash,
                disk_version: disk_hash,
                authority_version: version,
                disk_mtime_ns,
                disk_content: disk_text.clone(),
                pending: None,
            }),
            RecoveryState::Conflicted { conflict } => {
                if conflict.baseline_version != baseline_hash
                    || conflict.authority_version != version
                {
                    return Err("scene recovery conflict version mismatch".into());
                }
                let collapsed = if disk_matches_authority {
                    Some(("clean", SessionState::Clean))
                } else if disk_matches_baseline {
                    Some((
                        "dirty",
                        SessionState::Dirty {
                            since: Instant::now(),
                        },
                    ))
                } else {
                    None
                };
                if let Some((collapsed_to, state)) = collapsed {
                    tracing::info!(
                        path = %path,
                        collapsed_to,
                        "scene recovery conflict matches live disk"
                    );
                    state
                } else {
                    SessionState::Conflicted(SessionConflict {
                        id: conflict.id,
                        baseline_version: baseline_hash,
                        disk_version: disk_hash,
                        authority_version: version,
                        disk_mtime_ns,
                        disk_content: disk_text.clone(),
                        pending: None,
                    })
                }
            }
            RecoveryState::Removed if disk_present && disk_scene.is_some() => {
                return Ok(Self::new(
                    path,
                    &disk_text,
                    disk_scene.expect("present disk has scene"),
                    disk_stat.as_ref().expect("present disk has stat"),
                ));
            }
            RecoveryState::Removed => {
                return Err("scene recovery source file is still missing".into());
            }
        };
        let baseline = if matches!(session_state, SessionState::Clean) {
            DurableBaseline {
                content_hash: content_hash(
                    disk_canonical
                        .as_ref()
                        .expect("clean recovery has disk content"),
                ),
                content: disk_canonical.expect("clean recovery has disk content"),
                mtime_ns: disk_mtime_ns,
                authority_version: version,
            }
        } else {
            baseline
        };
        let mut disk_echo = DiskEchoRing::new();
        disk_echo.note_adopted(disk_hash);
        Ok(Self {
            path: path.to_string(),
            state: Mutex::new(SceneState {
                scene: authority,
                write_budget: record.authority.write_budget,
                version,
                attaches: HashMap::new(),
                cursors: HashMap::new(),
                session_state,
                baseline,
                flush_now: false,
                recovery_pending: false,
                flushed_mtime_ns: disk_mtime_ns,
                flush_epoch_version: version,
                flush_failures: 0,
                disk_echo,
            }),
            attach_count: AtomicUsize::new(0),
            detached_at: AtomicI64::new(0),
            closed: AtomicBool::new(false),
            io_lock: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            fail_after_preflight: AtomicBool::new(false),
        })
    }

    fn recovery_record(&self) -> RecoveryRecord {
        let mut st = self.lock_state();
        let _ = std::mem::take(&mut st.recovery_pending);
        let lifecycle = match &st.session_state {
            SessionState::Clean => RecoveryState::Clean,
            SessionState::Dirty { .. } => RecoveryState::Dirty,
            SessionState::Observing { dirty_since, .. } => {
                if dirty_since.is_some() {
                    RecoveryState::Dirty
                } else {
                    RecoveryState::Clean
                }
            }
            SessionState::Conflicted(conflict) => RecoveryState::Conflicted {
                conflict: RecoveryConflict {
                    id: conflict.id.clone(),
                    baseline_version: conflict.baseline_version,
                    disk_version: conflict.disk_version,
                    authority_version: conflict.authority_version,
                    disk_mtime_ns: conflict.disk_mtime_ns,
                },
            },
            SessionState::Removed => RecoveryState::Removed,
        };
        RecoveryRecord::new(
            RecoveryKind::Scene,
            self.path.clone(),
            RecoveryAuthority {
                content: st.scene.serialize_file(),
                version: st.version,
                write_budget: st.write_budget,
                flushed_mtime_ns: st.flushed_mtime_ns,
            },
            RecoveryBaseline {
                content: st.baseline.content.clone(),
                content_hash: st.baseline.content_hash,
                mtime_ns: st.baseline.mtime_ns,
                authority_version: st.baseline.authority_version,
            },
            lifecycle,
        )
    }

    async fn persist_recovery_locked(&self, workspace: &Arc<Workspace>) -> Result<(), String> {
        let record = self.recovery_record();
        let workspace = Arc::clone(workspace);
        tokio::task::spawn_blocking(move || recovery::store(&workspace, &record))
            .await
            .map_err(|error| format!("scene recovery write task failed: {error}"))?
            .map_err(|error| error.to_string())
    }

    async fn persist_pending_recovery(self: &Arc<Self>, workspace: &Arc<Workspace>) {
        let _io = self.io_lock.lock().await;
        if !self.lock_state().recovery_pending {
            return;
        }
        if let Err(error) = self.persist_recovery_locked(workspace).await {
            tracing::warn!(
                path = self.path,
                %error,
                "scene recovery persistence degraded"
            );
        }
    }

    pub(crate) async fn persist_recovery(self: &Arc<Self>, workspace: &Arc<Workspace>) {
        let _io = self.io_lock.lock().await;
        if let Err(error) = self.persist_recovery_locked(workspace).await {
            tracing::warn!(
                path = self.path,
                %error,
                "scene recovery persistence degraded"
            );
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, SceneState> {
        // Session state remains memory-safe after a panicking writer; recover
        // so cleanup and later requests continue from the state it left.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    // Test-surface accessor; production code reads the atomic directly.
    #[cfg(test)]
    pub fn attach_count(&self) -> usize {
        self.attach_count.load(Ordering::Relaxed)
    }

    /// Swap the echo ring for one with a short TTL so tests can
    /// observe expiry without waiting through the production window.
    /// Discards existing entries; call before the writes under test.
    #[cfg(test)]
    fn test_set_disk_echo_ttl(&self, ttl: Duration) {
        self.lock_state().disk_echo = DiskEchoRing::with_ttls(ttl, ttl);
    }

    #[cfg(test)]
    fn test_age_disk_echo(&self, age: Duration) {
        self.lock_state().disk_echo.test_age_by(age);
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

    /// Current authority scene in its file form plus the session CAS
    /// token, for the GET divert: a client reads exactly what a flush
    /// would write, under a token consistent with the session.
    #[cfg(test)]
    pub fn authority_view(&self) -> (String, Option<i64>) {
        let st = self.lock_state();
        (st.scene.serialize_file(), st.flushed_mtime_ns)
    }

    /// Atomic GET view: authority bytes and every piece of metadata
    /// the client must retain for a subsequent CAS write.
    pub(crate) fn http_read_view(&self) -> HttpReadView {
        let st = self.lock_state();
        HttpReadView {
            content: st.scene.serialize_file(),
            disk_mtime_ns: st.flushed_mtime_ns,
            authority_version: st.version,
            disk_conflicted: st.session_state.conflict_disk_mtime_ns().is_some(),
        }
    }

    /// Atomic PUT preflight view: session token and an outer conflict
    /// marker carrying the retained disk token.
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

    /// Replace the whole authority scene from a file body (the `$http`
    /// divert). Changed elements fan to every attachment with bumped
    /// versions and the session turns dirty; equal content is a no-op.
    /// The caller decides when to flush.
    #[cfg(test)]
    pub fn apply_replace(&self, body: &str) -> Result<(), SceneError> {
        let mut st = self.lock_state();
        self.apply_replace_locked(&mut st, body)?;
        Ok(())
    }

    /// Apply an HTTP replacement only while automatic persistence is
    /// permitted. Collaborative updates remain live during conflicts;
    /// PUT must instead direct the caller to explicit resolution
    /// without mutating authority.
    pub(crate) fn apply_http_replace(
        &self,
        body: &str,
        preconditions: WritePreconditions,
    ) -> Result<HttpReplaceOutcome, SceneError> {
        let mut st = self.lock_state();
        if let Some(disk_mtime_ns) = st.session_state.conflict_disk_mtime_ns() {
            return Ok(HttpReplaceOutcome::Conflicted { disk_mtime_ns });
        }
        let content_equal = Scene::parse(body)?.file_content_eq(&st.scene);
        match check_write_preconditions(
            st.flushed_mtime_ns,
            Some(st.version),
            content_equal,
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
        self.apply_replace_locked(&mut st, body)?;
        Ok(HttpReplaceOutcome::Applied)
    }

    fn apply_replace_locked(&self, st: &mut SceneState, body: &str) -> Result<(), SceneError> {
        let applied = st
            .scene
            .apply_replace_with_limit(body, &mut fresh_nonce, st.write_budget)?;
        if !applied.is_empty() {
            st.version += 1;
            let frame = update_frame(st.version, applied);
            st.fan(&frame);
            st.mark_dirty();
        }
        Ok(())
    }

    /// Apply a result supplied by the identity-aware merge gate.
    #[cfg(test)]
    fn apply_merge_outcome(&self, disk_text: String, stat: &FileStat, outcome: MergeOutcome) {
        let mut st = self.lock_state();
        self.apply_merge_outcome_locked(&mut st, disk_text, stat, outcome);
    }

    fn apply_merge_outcome_locked(
        &self,
        st: &mut SceneState,
        disk_text: String,
        stat: &FileStat,
        outcome: MergeOutcome,
    ) {
        let disk_hash = content_hash(&disk_text);
        let disk_budget = semantic_write_budget(Some(stat.size));
        match outcome {
            MergeOutcome::Merged(merged_text) => {
                let disk_baseline = match Scene::parse(&disk_text) {
                    Ok(scene) => scene.serialize_file(),
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            path = %self.path,
                            "scene merge outcome carried unusable disk content"
                        );
                        return;
                    }
                };
                let dirty_since = st.session_state.dirty_since().unwrap_or_else(Instant::now);
                let applied = match st.scene.apply_replace_with_limit(
                    &merged_text,
                    &mut fresh_nonce,
                    disk_budget,
                ) {
                    Ok(applied) => applied,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            path = %self.path,
                            "scene merge outcome was unusable"
                        );
                        return;
                    }
                };
                st.disk_echo.note_adopted(disk_hash);
                st.flushed_mtime_ns = stat.mtime_ns;
                if !applied.is_empty() {
                    st.version += 1;
                    let frame = update_frame(st.version, applied);
                    st.fan(&frame);
                }
                let baseline_hash = content_hash(&disk_baseline);
                st.baseline = DurableBaseline {
                    content: disk_baseline,
                    content_hash: baseline_hash,
                    mtime_ns: stat.mtime_ns,
                    authority_version: st.version,
                };
                st.write_budget = disk_budget;
                st.session_state = if Scene::parse(&st.baseline.content)
                    .is_ok_and(|baseline| baseline.file_content_eq(&st.scene))
                {
                    SessionState::Clean
                } else {
                    SessionState::Dirty { since: dirty_since }
                };
                st.flush_now = st.session_state.is_dirty();
                st.flush_failures = 0;
            }
            MergeOutcome::Conflict => {
                Self::enter_conflict_locked(st, disk_hash, stat.mtime_ns, disk_text);
            }
        }
    }

    fn enter_conflict_locked(
        st: &mut SceneState,
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
            _ => format!("scene-{}", NEXT_CONFLICT_ID.fetch_add(1, Ordering::Relaxed)),
        };
        st.session_state = SessionState::Conflicted(SessionConflict {
            id,
            baseline_version,
            disk_version,
            authority_version: st.version,
            disk_mtime_ns,
            disk_content,
            pending: None,
        });
        st.flush_now = false;
    }

    /// Fold external disk content into the session. Divergence runs
    /// the identity- and field-aware three-way merge from the durable
    /// baseline; invalid or ambiguous scene input becomes a conflict.
    fn merge_disk(&self, disk_text: String, stat: &FileStat) {
        let mut st = self.lock_state();
        if scene::validate_merge_input(&disk_text).is_err() {
            self.apply_merge_outcome_locked(&mut st, disk_text, stat, MergeOutcome::Conflict);
            return;
        }
        let disk_scene = Scene::parse(&disk_text).expect("validated scene parses");
        let disk_matches_authority = disk_scene.file_content_eq(&st.scene);
        if st.session_state.is_dirty() && !disk_matches_authority {
            let disk_budget = semantic_write_budget(Some(stat.size));
            let outcome = scene::merge_three_way_with_limit(
                &st.baseline.content,
                &st.scene,
                &disk_text,
                disk_budget,
            )
            .map(MergeOutcome::Merged)
            .unwrap_or(MergeOutcome::Conflict);
            self.apply_merge_outcome_locked(&mut st, disk_text, stat, outcome);
            return;
        }
        // Adopted disk bytes join the echo ring either way: even when
        // the parse gate below rejects them, a stale read serving the
        // same bytes again is not a fresh observation.
        let disk_hash = content_hash(&disk_text);
        let disk_budget = semantic_write_budget(Some(stat.size));
        st.disk_echo.note_adopted(disk_hash);
        match st
            .scene
            .apply_replace_with_limit(&disk_text, &mut fresh_nonce, disk_budget)
        {
            Ok(applied) => {
                if !applied.is_empty() {
                    st.version += 1;
                    let frame = update_frame(st.version, applied);
                    st.fan(&frame);
                }
                st.flushed_mtime_ns = stat.mtime_ns;
                let baseline_content = disk_scene.serialize_file();
                st.baseline = DurableBaseline {
                    content_hash: content_hash(&baseline_content),
                    content: baseline_content,
                    mtime_ns: stat.mtime_ns,
                    authority_version: st.version,
                };
                st.write_budget = disk_budget;
                st.session_state = SessionState::Clean;
                st.flush_failures = 0;
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %self.path,
                    "scene session reconcile skipped unusable disk content; keeping the authority scene"
                );
            }
        }
    }

    /// The file vanished from disk. Forget the token, stop the flush
    /// clock (a deliberate delete is never resurrected by a flush; the
    /// next client push re-dirties and the CAS-against-None write
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

    /// Resolve a conflict in favor of the retained disk side. A valid
    /// scene is adopted through replace semantics; a retained removal
    /// becomes `Removed`. Invalid or unreadable input leaves the
    /// conflict intact.
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
        let disk_hash = content_hash(&disk_content);
        if disk_version != disk_hash {
            return false;
        }
        let disk_budget = semantic_write_budget(Some(disk_content.len() as u64));
        let disk_scene = match Scene::parse(&disk_content) {
            Ok(scene) => scene,
            Err(_) => return false,
        };
        let applied =
            match st
                .scene
                .apply_replace_with_limit(&disk_content, &mut fresh_nonce, disk_budget)
            {
                Ok(applied) => applied,
                Err(_) => return false,
            };
        let changed = !applied.is_empty();
        if changed {
            st.version += 1;
            let frame = update_frame(st.version, applied);
            st.fan(&frame);
        }
        st.disk_echo.note_adopted(disk_hash);
        st.flushed_mtime_ns = disk_mtime_ns;
        let baseline_content = disk_scene.serialize_file();
        st.baseline = DurableBaseline {
            content_hash: content_hash(&baseline_content),
            content: baseline_content,
            mtime_ns: disk_mtime_ns,
            authority_version: st.version,
        };
        st.write_budget = disk_budget;
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

    /// First half of a flush: serialize the file form and capture the
    /// token under the lock. Returns None when there is nothing to
    /// flush. Clears `flush_now` either way.
    fn begin_flush(&self) -> Option<FlushJob> {
        let mut st = self.lock_state();
        st.flush_now = false;
        st.session_state.dirty_since()?;
        st.flush_epoch_version = st.version;
        Some(FlushJob {
            text: st.scene.serialize_file(),
            expected_mtime_ns: st.flushed_mtime_ns,
            epoch: st.version,
        })
    }

    /// Second half of a successful flush: adopt the fresh token, note
    /// the flushed file form in the echo ring, clear dirty only if no
    /// mutation landed while the write was in flight, and fan the
    /// flush state.
    fn finish_flush(&self, epoch: u64, stat: &FileStat, content: &str) {
        let mut st = self.lock_state();
        st.flushed_mtime_ns = stat.mtime_ns;
        let flushed_hash = content_hash(content);
        st.disk_echo.note_written(flushed_hash);
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

impl SceneAttachHandle {
    #[cfg(test)]
    pub fn attach_id(&self) -> u64 {
        self.attach_id
    }

    #[cfg(test)]
    pub fn session(&self) -> &Arc<SceneSession> {
        &self.session
    }

    /// The per-attachment frame stream, taken once by the socket pump.
    /// Every frame is a complete serialized `ServerFrame`.
    pub fn take_frames(&mut self) -> mpsc::UnboundedReceiver<String> {
        self.frames.take().expect("scene attach frames taken twice")
    }

    /// Merge one push. Accepted values fan to the OTHER attachments
    /// and the sender gets `push-ok`, both enqueued under the same
    /// lock. A fully discarded push still acks (the sender's elements
    /// lost the merge everywhere, nothing to fan). An Err means the
    /// route should answer an `error` frame and drop this attachment;
    /// the authority scene is untouched (the push is all-or-nothing).
    pub fn push(
        &self,
        elements: Vec<serde_json::Value>,
        app_state: Option<serde_json::Value>,
        files: Option<serde_json::Value>,
    ) -> Result<(), PushError> {
        let mut st = self.session.lock_state();
        if self.session.closed.load(Ordering::Relaxed) {
            return Err(PushError::Closed);
        }
        let write_budget = st.write_budget;
        let applied = st
            .scene
            .apply_push_with_limit(elements, app_state, files, write_budget)?;
        if !applied.is_empty() {
            st.version += 1;
            let frame = update_frame(st.version, applied);
            st.fan_except(self.attach_id, &frame);
            st.mark_dirty();
            st.recovery_pending = true;
        }
        let ok = serialize(&ServerFrame::PushOk {
            version: st.version,
        });
        st.send_to(self.attach_id, ok);
        Ok(())
    }

    /// Pointer moved: store for future snapshots and fan to the OTHER
    /// attachments (the owner knows its own pointer). Canvas
    /// coordinates are unbounded floats; nothing to clamp.
    pub fn cursor(&self, x: f64, y: f64, tool: Option<String>, selected: Option<Vec<String>>) {
        let mut st = self.session.lock_state();
        let Some(window_id) = st
            .attaches
            .get(&self.attach_id)
            .map(|s| s.window_id.clone())
        else {
            return;
        };
        let frame = serialize(&ServerFrame::Cursor {
            id: self.attach_id,
            w: window_id.clone(),
            x,
            y,
            tool: tool.clone(),
            selected: selected.clone(),
        });
        st.cursors.insert(
            self.attach_id,
            CursorPos {
                window_id,
                x,
                y,
                tool,
                selected,
            },
        );
        st.fan_except(self.attach_id, &frame);
    }
}

impl Drop for SceneAttachHandle {
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

impl Default for SceneRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            flush_wake: Notify::new(),
            next_attach_id: AtomicU64::new(1),
        }
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<SceneSession>>> {
        // A poisoned registry still contains memory-safe session entries;
        // recover so cleanup and later requests continue from that state.
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// The live session for a path, if any (the GET/PUT diverts and
    /// the reconciler key on this).
    pub fn get(&self, path: &str) -> Option<Arc<SceneSession>> {
        self.lock_sessions()
            .get(path)
            .filter(|s| !s.closed.load(Ordering::Relaxed))
            .cloned()
    }

    fn sessions_snapshot(&self) -> Vec<Arc<SceneSession>> {
        self.lock_sessions().values().cloned().collect()
    }

    /// Attach to the session for `path`, creating it from disk on the
    /// first attachment. The returned handle's frame stream already
    /// carries the full snapshot, enqueued under the same lock that
    /// registers the attachment, so no update can slip in between.
    pub async fn attach(
        self: &Arc<Self>,
        workspace: &Arc<Workspace>,
        path: &str,
        window_id: &str,
    ) -> Result<SceneAttachHandle, AttachError> {
        chan_workspace::fs_ops::validate_rel(path)?;
        loop {
            // Fast path: live session.
            {
                let sessions = self.lock_sessions();
                if let Some(session) = sessions.get(path) {
                    if let Some(handle) = self.register_attach(session.clone(), window_id) {
                        return Ok(handle);
                    }
                    // Closed but not yet removed: fall through and
                    // seed a replacement.
                }
            }

            // First attach: seed from disk OUTSIDE every lock (the
            // read enforces the text gate and valid UTF-8; the scene
            // cap is checked here since a session must never hold a
            // scene its flush could not represent).
            let ws = Arc::clone(workspace);
            let read_path = path.to_string();
            let (disk, unreadable_disk, recovery) = tokio::task::spawn_blocking(move || {
                let recovery =
                    recovery::load(&ws, RecoveryKind::Scene, &read_path)?.and_then(|record| {
                        let validation = Scene::parse(&record.authority.content)
                            .and_then(|_| Scene::parse(&record.baseline.content));
                        match validation {
                            Ok(_) => Some(record),
                            Err(error) => {
                                tracing::warn!(
                                    path = read_path,
                                    %error,
                                    "ignoring incompatible scene recovery record"
                                );
                                None
                            }
                        }
                    });
                let (disk, unreadable_disk) = match ws.classify_workspace_path(&read_path)? {
                    WorkspacePath::Missing => (None, None),
                    WorkspacePath::Regular(stat) | WorkspacePath::Directory(stat) => {
                        match ws.read_text_with_stat(&read_path) {
                            Ok(read) => (Some(read), None),
                            Err(error) if recovery.is_some() => {
                                let marker = format!(
                                    "{UNREADABLE_DISK_MARKER}:{}:{:?}:{error}",
                                    stat.size, stat.mtime_ns
                                );
                                (None, Some((content_hash(&marker), stat.mtime_ns)))
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    WorkspacePath::Special(kind) if recovery.is_some() => {
                        let marker = format!("{UNREADABLE_DISK_MARKER}:special:{kind:?}");
                        (None, Some((content_hash(&marker), None)))
                    }
                    WorkspacePath::Special(_) => {
                        return Err(ChanError::Io(
                            "scene session source is not a regular file".into(),
                        ));
                    }
                };
                Ok::<_, ChanError>((disk, unreadable_disk, recovery))
            })
            .await
            .map_err(|e| AttachError::Task(e.to_string()))??;
            if disk.is_none() && recovery.is_none() {
                return Err(AttachError::Workspace(ChanError::Io(format!(
                    "not found: {path}"
                ))));
            }
            if let Some((text, stat)) = &disk {
                let write_budget = semantic_write_budget(Some(stat.size));
                if text.len() as u64 > write_budget {
                    return Err(AttachError::Scene(SceneError::TooLarge {
                        bytes: text.len() as u64,
                        limit: write_budget,
                    }));
                }
            }

            // Re-lock and double-check: a concurrent first attach may
            // have won the race; use its session and discard this read
            // (the ptr-equality idiom from terminal_sessions).
            let mut sessions = self.lock_sessions();
            match sessions.get(path) {
                Some(existing) if !existing.closed.load(Ordering::Relaxed) => {
                    let session = existing.clone();
                    if let Some(handle) = self.register_attach(session, window_id) {
                        return Ok(handle);
                    }
                    // Raced a close between the lookups; start over.
                }
                _ => {
                    let session = Arc::new(match (recovery, disk) {
                        (Some(record), disk) => {
                            SceneSession::from_recovery(path, disk, unreadable_disk, record)
                                .map_err(AttachError::Task)?
                        }
                        (None, Some((text, stat))) => {
                            let scene = Scene::parse(&text)?;
                            SceneSession::new(path, &text, scene, &stat)
                        }
                        (None, None) => unreachable!("missing source handled before registry lock"),
                    });
                    sessions.insert(path.to_string(), session.clone());
                    let handle = self
                        .register_attach(session, window_id)
                        .expect("fresh session cannot be closed under the map lock");
                    return Ok(handle);
                }
            }
        }
    }

    /// Register an attachment on `session` and enqueue its snapshot.
    /// None when the session is closed (caller retries against the
    /// map). Callers hold the registry map lock, which is what makes
    /// the closed check race-free against the reaper and `close_all`.
    fn register_attach(
        self: &Arc<Self>,
        session: Arc<SceneSession>,
        window_id: &str,
    ) -> Option<SceneAttachHandle> {
        let attach_id = self.next_attach_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let mut st = session.lock_state();
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        let _ = tx.send(snapshot_frame(&session.path, &st));
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
        Some(SceneAttachHandle {
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
            let (due, recovery_pending) = {
                let st = session.lock_state();
                (
                    st.flush_now
                        || st
                            .session_state
                            .dirty_since()
                            .is_some_and(|since| since.elapsed() >= SCENE_FLUSH_DEBOUNCE),
                    st.recovery_pending,
                )
            };
            if due {
                flush_session(&session, workspace, self_writes).await;
            } else if recovery_pending {
                session.persist_pending_recovery(workspace).await;
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
                && now.saturating_sub(detached_at) >= SCENE_DETACH_GRACE.as_millis() as i64;
            if reap {
                session.closed.store(true, Ordering::Relaxed);
            }
            !reap
        });
    }

    /// Registry-initiated teardown (storage reset, metadata import,
    /// shutdown): flush what can be flushed, tell every attachment
    /// `closed`, and drop all sessions. Pass the pre-swap workspace on
    /// reset so dirty sessions land on disk first.
    pub async fn close_all(
        &self,
        reason: &'static str,
        workspace: Option<&Arc<Workspace>>,
        self_writes: &SelfWrites,
    ) {
        let sessions: Vec<Arc<SceneSession>> = {
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
    /// be confirmed against the disk (reconcile_session's exists
    /// probe) before a session routes into the removed flow. A rename
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
    /// (a pending fold or a pending removal); parity with
    /// doc_sessions. Runs on the flusher tick.
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

/// Flush one session to disk: serialize under the lock, CAS-write
/// outside it, commit the token. A CAS conflict means the disk changed
/// under us: reconcile and retry once if authority and disk converge.
/// Other failures keep the session
/// dirty; the content stays safe in memory and in every client, and
/// the error fan starts on the second consecutive failure.
///
/// Returns whether the state captured by this call settled durably:
/// true when the write committed, when there was nothing unflushed, or
/// when the CAS-conflict reconcile left authority and disk equal
/// (including the removed-file path, whose authoritative disk state is
/// deliberately "no file"). False means the write failed and the
/// session stays dirty, or an unresolved conflict prevents a flush;
/// the PUT divert turns those into an honest non-200 response.
pub(crate) async fn flush_session(
    session: &Arc<SceneSession>,
    workspace: &Arc<Workspace>,
    self_writes: &SelfWrites,
) -> bool {
    let _io = session.io_lock.lock().await;
    let durable = flush_session_locked(session, workspace, self_writes).await;
    if let Err(error) = session.persist_recovery_locked(workspace).await {
        tracing::warn!(error = %error, path = %session.path, "persist scene recovery failed");
    }
    durable
}

async fn flush_session_locked(
    session: &Arc<SceneSession>,
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

/// Bring one session in line with the disk: an unchanged token is our
/// own flush echo (ignore); clean parseable content adopts through the
/// replace semantics, while dirty divergence enters the three-way
/// merge gate after corroboration; a vanished file routes into the
/// removed path.
/// Unreadable or unparseable content enters a retained conflict
/// instead of risking authority loss.
pub(crate) async fn reconcile_session(session: &Arc<SceneSession>, workspace: &Arc<Workspace>) {
    let _io = session.io_lock.lock().await;
    reconcile_session_locked(session, workspace).await;
    if let Err(error) = session.persist_recovery_locked(workspace).await {
        tracing::warn!(error = %error, path = %session.path, "persist scene recovery failed");
    }
}

async fn reconcile_session_locked(session: &Arc<SceneSession>, workspace: &Arc<Workspace>) {
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
            // Absence must corroborate; parity with doc_sessions.
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
        // A matching token settles the event as our own flush echo,
        // except while an observation is pending; parity with
        // doc_sessions.
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
                    "scene session reconcile read failed; entering conflict"
                );
                let marker = format!(
                    "{UNREADABLE_DISK_MARKER}:{}:{:?}:{e}",
                    stat.size, stat.mtime_ns
                );
                let mut st = session.lock_state();
                SceneSession::enter_conflict_locked(
                    &mut st,
                    content_hash(&marker),
                    stat.mtime_ns,
                    String::new(),
                );
                return;
            }
            Err(_) => return,
        };
    let hash = content_hash(&disk_text);
    {
        let mut st = session.lock_state();
        if st.disk_echo.contains(hash) {
            // Our own bytes under a re-stamped mtime or a stale read
            // serving a recent flush back: adopt the token and keep
            // the authority scene. Divergent bytes stay scheduled: if
            // they remain after expiry, they are durable external
            // state and must fold normally.
            st.flushed_mtime_ns = disk_stat.mtime_ns;
            let disk_matches_authority =
                Scene::parse(&disk_text).is_ok_and(|scene| scene.file_content_eq(&st.scene));
            if disk_matches_authority {
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
        let disk_matches_authority =
            Scene::parse(&disk_text).is_ok_and(|scene| scene.file_content_eq(&st.scene));
        if disk_matches_authority {
            drop(st);
            session.merge_disk(disk_text, &disk_stat);
            return;
        }
        let dirty = st.session_state.is_dirty();
        if disk_text.is_empty() && (dirty || st.disk_echo.any_recent_write()) {
            // The in-flight-upload placeholder guard; parity with
            // doc_sessions, and load-bearing here too: an empty body
            // parses as a valid empty scene, so without this refusal a
            // lying read would tombstone every element. The adopted
            // token lets the next CAS flush restore the scene file.
            st.flushed_mtime_ns = disk_stat.mtime_ns;
            if !matches!(
                st.session_state.content_observation(),
                Some((pending_hash, pending_mtime, _))
                    if pending_hash == hash && pending_mtime == disk_stat.mtime_ns
            ) {
                tracing::warn!(
                    path = %session.path,
                    "scene session reconcile refused an uncorroborated empty read"
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
/// Spawned once in build_app next to the doc-session tasks.
pub fn spawn_flusher(
    registry: Arc<SceneRegistry>,
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
    registry: Arc<SceneRegistry>,
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
pub(crate) async fn characterization_http_trace(
) -> crate::collab_sessions::characterization::HttpTrace {
    use crate::collab_sessions::characterization::{HttpOutcomeTrace, HttpTrace, HttpViewTrace};

    fn outcome(outcome: HttpReplaceOutcome, expected_token: Option<i64>) -> HttpOutcomeTrace {
        match outcome {
            HttpReplaceOutcome::Applied => panic!("characterization expected a refusal"),
            HttpReplaceOutcome::PreconditionRequired {
                current_version,
                disk_mtime_ns,
            } => HttpOutcomeTrace::PreconditionRequired {
                current_version,
                token_matches: disk_mtime_ns == expected_token,
            },
            HttpReplaceOutcome::Stale {
                current_version,
                disk_mtime_ns,
            } => HttpOutcomeTrace::Stale {
                current_version,
                token_matches: disk_mtime_ns == expected_token,
            },
            HttpReplaceOutcome::Conflicted { disk_mtime_ns } => HttpOutcomeTrace::Conflicted {
                token_matches: disk_mtime_ns == expected_token,
            },
        }
    }

    fn view(session: &SceneSession, expected_conflict_token: Option<Option<i64>>) -> HttpViewTrace {
        let read = session.http_read_view();
        let write = session.http_write_view();
        HttpViewTrace {
            authority_version: read.authority_version,
            read_write_version_match: read.authority_version == write.authority_version,
            read_write_token_match: read.disk_mtime_ns == write.disk_mtime_ns,
            disk_conflicted: read.disk_conflicted,
            conflict_layer_present: write.conflict_mtime_ns.is_some(),
            conflict_token_matches: write.conflict_mtime_ns == expected_conflict_token,
        }
    }

    fn body(ids: &[&str]) -> String {
        let elements: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(index, id)| {
                serde_json::json!({
                    "id": id,
                    "type": "rectangle",
                    "version": 1,
                    "versionNonce": index as u64 + 1,
                    "index": format!("a{index}"),
                    "isDeleted": false,
                })
            })
            .collect();
        serde_json::json!({
            "type": "excalidraw",
            "version": 2,
            "source": "test",
            "elements": elements,
            "appState": {},
            "files": {},
        })
        .to_string()
    }

    let config = tempfile::tempdir().expect("config tempdir");
    let root = tempfile::tempdir().expect("workspace tempdir");
    let library =
        chan_workspace::Library::open_at(config.path().join("config.toml")).expect("library");
    library
        .register_workspace(root.path())
        .expect("register workspace");
    let workspace = library.open_workspace(root.path()).expect("workspace");
    let initial = body(&["base"]);
    workspace
        .write_text("b.excalidraw", &initial)
        .expect("seed");
    let stat = workspace.stat("b.excalidraw").expect("seed stat");
    let scene = Scene::parse(&initial).expect("seed scene");
    let session = Arc::new(SceneSession::new("b.excalidraw", &initial, scene, &stat));
    let initial_token = session.http_write_view().disk_mtime_ns;
    let local = body(&["base", "local"]);

    let precondition_required = outcome(
        session
            .apply_http_replace(&local, WritePreconditions::default())
            .expect("precondition outcome"),
        initial_token,
    );
    let stale = outcome(
        session
            .apply_http_replace(
                &local,
                WritePreconditions {
                    expected_mtime_ns: initial_token,
                    authority_version: Some(99),
                    ..WritePreconditions::default()
                },
            )
            .expect("stale outcome"),
        initial_token,
    );

    let disk = body(&["disk"]);
    workspace
        .write_text("b.excalidraw", &disk)
        .expect("disk side");
    let disk_stat = workspace.stat("b.excalidraw").expect("disk stat");
    session.test_force_conflict(disk.clone(), &disk_stat);
    let conflicted = outcome(
        session
            .apply_http_replace(&local, WritePreconditions::default())
            .expect("conflict outcome"),
        disk_stat.mtime_ns,
    );
    let conflicted_view = view(&session, Some(disk_stat.mtime_ns));

    assert!(session.reload_conflict());
    let reloaded_view = view(&session, None);

    let local = body(&["disk", "local"]);
    session.apply_replace(&local).expect("local replacement");
    let second_disk = body(&["disk", "external"]);
    workspace
        .write_text("b.excalidraw", &second_disk)
        .expect("second disk side");
    let second_disk_stat = workspace.stat("b.excalidraw").expect("second disk stat");
    session.test_force_conflict(second_disk, &second_disk_stat);
    assert!(
        session
            .overwrite_conflict(&workspace, &SelfWrites::new())
            .await
    );
    let overwritten_view = view(&session, None);

    HttpTrace {
        precondition_required,
        stale,
        conflicted,
        conflicted_view,
        reloaded_view,
        overwritten_view,
    }
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
        registry: Arc<SceneRegistry>,
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
            registry: Arc::new(SceneRegistry::new()),
            self_writes: SelfWrites::new(),
        }
    }

    #[tokio::test]
    async fn incompatible_recovered_scene_falls_back_to_fresh_disk_open() {
        let disk = body(json!([]));
        let fx = fixture(&[("b.excalidraw", &disk)]);
        let invalid = "{not a scene}";
        let record = RecoveryRecord::new(
            RecoveryKind::Scene,
            "b.excalidraw".into(),
            RecoveryAuthority {
                content: invalid.into(),
                version: 2,
                write_budget: 1024,
                flushed_mtime_ns: None,
            },
            RecoveryBaseline {
                content: invalid.into(),
                content_hash: content_hash(invalid),
                mtime_ns: None,
                authority_version: 1,
            },
            RecoveryState::Dirty,
        );
        recovery::store(&fx.workspace, &record).unwrap();

        let handle = fx
            .registry
            .attach(&fx.workspace, "b.excalidraw", "w1")
            .await
            .expect("invalid recovery is absent when fresh disk is usable");
        assert_eq!(
            handle.session().authority_view().0,
            Scene::parse(&disk).unwrap().serialize_file()
        );
    }

    fn elem(id: &str, version: u64, nonce: u64, index: &str) -> Value {
        json!({
            "id": id,
            "type": "rectangle",
            "version": version,
            "versionNonce": nonce,
            "index": index,
            "isDeleted": false,
        })
    }

    fn body(elements: Value) -> String {
        json!({
            "type": "excalidraw",
            "version": 2,
            "source": "test",
            "elements": elements,
            "appState": {},
            "files": {},
        })
        .to_string()
    }

    async fn attach(
        fx: &Fixture,
        path: &str,
        window: &str,
    ) -> (SceneAttachHandle, mpsc::UnboundedReceiver<String>) {
        let mut handle = fx
            .registry
            .attach(&fx.workspace, path, window)
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

    fn types(frames: &[Value]) -> Vec<&str> {
        frames.iter().map(|v| v["type"].as_str().unwrap()).collect()
    }

    fn backdate_dirty(session: &Arc<SceneSession>) {
        let mut st = session.lock_state();
        st.session_state = SessionState::Dirty {
            since: Instant::now()
                .checked_sub(SCENE_FLUSH_DEBOUNCE + Duration::from_millis(50))
                .unwrap(),
        };
    }

    /// Age the pending disk observation past CORROBORATE_AFTER so the
    /// next reconcile treats it as corroborated.
    fn backdate_pending_fold(session: &Arc<SceneSession>) {
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
    fn backdate_pending_removal(session: &Arc<SceneSession>) {
        session.test_backdate_pending_removal();
    }

    #[tokio::test]
    async fn attach_snapshots_and_seeds_from_disk() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 3, 7, "a1")])))]);
        let (_h, mut rx) = attach(&fx, "b.excalidraw", "win-1").await;
        let frames = drain(&mut rx);
        assert_eq!(frames.len(), 1);
        let snap = &frames[0];
        assert_eq!(snap["type"], "snapshot");
        assert_eq!(snap["path"], "b.excalidraw");
        assert_eq!(snap["version"], 0);
        assert_eq!(snap["elements"][0]["id"], "x");
        assert_eq!(snap["appState"], json!({}));
        assert_eq!(snap["files"], json!({}));
        assert_eq!(snap["dirty"], false);
        assert!(snap["mtime_ns"].is_string());
        assert_eq!(snap["cursors"], json!([]));
    }

    #[tokio::test]
    async fn merged_outcome_preserves_durable_baseline_through_observation() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        ha.push(vec![elem("y", 1, 2, "a2")], None, None).unwrap();
        drain(&mut rx);

        let disk = body(json!([elem("x", 1, 1, "a1"), elem("z", 1, 3, "a3")]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        let stat = fx.workspace.stat("b.excalidraw").unwrap();
        let merged = body(json!([
            elem("x", 1, 1, "a1"),
            elem("y", 1, 2, "a2"),
            elem("z", 1, 3, "a3")
        ]));
        ha.session()
            .apply_merge_outcome(disk.clone(), &stat, MergeOutcome::Merged(merged));

        let authority = Scene::parse(&ha.session().authority_view().0).unwrap();
        assert!(authority.element("y").is_some());
        assert!(authority.element("z").is_some());
        let expected_baseline = Scene::parse(&disk).unwrap().serialize_file();
        let mut st = ha.session().lock_state();
        assert!(matches!(st.session_state, SessionState::Dirty { .. }));
        assert_eq!(st.baseline.content, expected_baseline);
        assert_eq!(st.baseline.content_hash, content_hash(&expected_baseline));
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
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        ha.push(vec![elem("x", 2, 2, "a1")], None, None).unwrap();
        drain(&mut rx);

        let disk = body(json!([elem("x", 2, 3, "a1")]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        let stat = fx.workspace.stat("b.excalidraw").unwrap();
        ha.session()
            .apply_merge_outcome(disk.clone(), &stat, MergeOutcome::Conflict);

        let first_id = {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("overlap must enter Conflicted");
            };
            assert_eq!(conflict.baseline_version, st.baseline.content_hash);
            assert_eq!(conflict.disk_version, content_hash(&disk));
            assert_eq!(conflict.authority_version, st.version);
            assert_eq!(conflict.disk_mtime_ns, stat.mtime_ns);
            assert_eq!(conflict.disk_content, disk);
            assert_eq!(
                st.baseline.content,
                Scene::parse(&seed).unwrap().serialize_file()
            );
            assert_eq!(st.baseline.mtime_ns, st.flushed_mtime_ns);
            assert_eq!(st.baseline.authority_version, 0);
            conflict.id.clone()
        };

        ha.session()
            .apply_merge_outcome(disk.clone(), &stat, MergeOutcome::Conflict);
        ha.push(vec![elem("y", 1, 4, "a2")], None, None).unwrap();
        {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("collaboration must remain conflicted");
            };
            assert_eq!(conflict.id, first_id, "conflict id must stay stable");
            assert_eq!(conflict.authority_version, st.version);
        }
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
        let seed = body(json!([]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        ha.push(vec![elem("x", 1, 1, "a1")], None, None).unwrap();
        drain(&mut rx);

        let authority = ha.session().authority_view().0;
        fx.workspace.write_text("b.excalidraw", &authority).unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(ha.session(), &fx.workspace).await;

        let st = ha.session().lock_state();
        assert!(matches!(st.session_state, SessionState::Clean));
        assert_eq!(st.baseline.content, authority);
        assert_eq!(st.baseline.content_hash, content_hash(&authority));
        assert_eq!(st.baseline.mtime_ns, st.flushed_mtime_ns);
        assert_eq!(st.baseline.authority_version, st.version);
    }

    #[tokio::test]
    async fn distinct_external_element_merges_flushes_and_broadcasts_once() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        ha.push(vec![elem("y", 1, 2, "a2")], None, None).unwrap();
        drain(&mut rx);

        let disk = body(json!([elem("x", 1, 1, "a1"), elem("z", 1, 3, "a3")]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(ha.session(), &fx.workspace).await;
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let authority = Scene::parse(&ha.session().authority_view().0).unwrap();
        for id in ["x", "y", "z"] {
            assert!(authority.element(id).is_some(), "merged element {id}");
        }
        let updates = drain(&mut rx);
        assert_eq!(types(&updates), ["update"], "merged authority fans once");

        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let disk = Scene::parse(&fx.workspace.read_text("b.excalidraw").unwrap()).unwrap();
        for id in ["x", "y", "z"] {
            assert!(disk.element(id).is_some(), "flushed element {id}");
        }
        let flushed = drain(&mut rx);
        assert_eq!(types(&flushed), ["flush"], "merged authority flushes once");
        assert_eq!(flushed[0]["dirty"], false);
    }

    #[tokio::test]
    async fn same_element_edit_conflicts_and_reload_adopts_disk() {
        let mut baseline_element = elem("x", 1, 1, "a1");
        baseline_element["x"] = json!(10);
        let seed = body(json!([baseline_element]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);

        let mut local_element = elem("x", 2, 2, "a1");
        local_element["x"] = json!(20);
        ha.push(vec![local_element], None, None).unwrap();
        drain(&mut rx);
        let mut disk_element = elem("x", 2, 3, "a1");
        disk_element["x"] = json!(30);
        let disk = body(json!([disk_element]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        let stat = fx.workspace.stat("b.excalidraw").unwrap();
        ha.session().merge_disk(disk.clone(), &stat);

        {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("same-field element edits must conflict");
            };
            assert_eq!(st.scene.element("x").unwrap().value["x"], 20);
            assert_eq!(conflict.baseline_version, st.baseline.content_hash);
            assert_eq!(conflict.disk_version, content_hash(&disk));
            assert_eq!(conflict.authority_version, st.version);
            assert_eq!(conflict.disk_content, disk);
        }
        assert!(drain(&mut rx).is_empty(), "conflict has no silent winner");

        assert!(ha.session().reload_conflict());
        assert_eq!(
            Scene::parse(&ha.session().authority_view().0)
                .unwrap()
                .element("x")
                .unwrap()
                .value["x"],
            30
        );
        assert_eq!(types(&drain(&mut rx)), ["update"]);
    }

    #[tokio::test]
    async fn overwrite_scene_conflict_flushes_authority_and_rebroadcasts() {
        let mut baseline_element = elem("x", 1, 1, "a1");
        baseline_element["x"] = json!(10);
        let seed = body(json!([baseline_element]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);

        let mut local_element = elem("x", 2, 2, "a1");
        local_element["x"] = json!(20);
        ha.push(vec![local_element], None, None).unwrap();
        drain(&mut rx);
        let mut disk_element = elem("x", 2, 3, "a1");
        disk_element["x"] = json!(30);
        let disk = body(json!([disk_element]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        let stat = fx.workspace.stat("b.excalidraw").unwrap();
        ha.session().merge_disk(disk, &stat);

        assert!(
            ha.session()
                .overwrite_conflict(&fx.workspace, &fx.self_writes)
                .await
        );
        assert_eq!(
            Scene::parse(&fx.workspace.read_text("b.excalidraw").unwrap())
                .unwrap()
                .element("x")
                .unwrap()
                .value["x"],
            20
        );
        let frames = drain(&mut rx);
        assert_eq!(types(&frames), ["flush", "snapshot"]);
        assert_eq!(frames[1]["elements"][0]["x"], 20);
    }

    #[tokio::test]
    async fn conflicted_scene_rehydrates_after_server_restart_without_flushing_authority() {
        let mut baseline_element = elem("x", 1, 1, "a1");
        baseline_element["x"] = json!(10);
        let seed = body(json!([baseline_element]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (handle, mut frames) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut frames);

        let mut local_element = elem("x", 2, 2, "a1");
        local_element["x"] = json!(20);
        handle
            .push(vec![local_element], None, None)
            .expect("local edit");
        drain(&mut frames);
        let authority = handle.session().authority_view().0;

        let mut disk_element = elem("x", 2, 3, "a1");
        disk_element["x"] = json!(30);
        let disk = body(json!([disk_element]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        handle.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(handle.session(), &fx.workspace).await;
        backdate_pending_fold(handle.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert!(handle.session().http_read_view().disk_conflicted);
        drop(handle);

        let restarted = Arc::new(SceneRegistry::new());
        let reopened = restarted
            .attach(&fx.workspace, "b.excalidraw", "w2")
            .await
            .expect("restart attach");
        let view = reopened.session().http_read_view();
        assert!(
            Scene::parse(&view.content)
                .unwrap()
                .file_content_eq(&Scene::parse(&authority).unwrap()),
            "live scene authority rehydrates"
        );
        assert!(view.disk_conflicted, "scene conflict survives restart");
        {
            let state = reopened.session().lock_state();
            let durable = Scene::parse(&state.baseline.content).unwrap();
            assert!(durable.file_content_eq(&Scene::parse(&seed).unwrap()));
            let SessionState::Conflicted(conflict) = &state.session_state else {
                panic!("reopened scene must remain conflicted");
            };
            assert_eq!(conflict.baseline_version, state.baseline.content_hash);
            assert_eq!(conflict.authority_version, state.version);
        }

        restarted.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(
            Scene::parse(&fx.workspace.read_text("b.excalidraw").unwrap())
                .unwrap()
                .file_content_eq(&Scene::parse(&disk).unwrap()),
            "restart must not flush stale scene authority over retained disk"
        );
    }

    #[tokio::test]
    async fn conflicted_scene_rehydration_collapses_when_disk_matches_authority() {
        let mut baseline_element = elem("x", 1, 1, "a1");
        baseline_element["x"] = json!(10);
        let seed = body(json!([baseline_element]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (handle, mut frames) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut frames);

        let mut local_element = elem("x", 2, 2, "a1");
        local_element["x"] = json!(20);
        handle
            .push(vec![local_element], None, None)
            .expect("local edit");
        drain(&mut frames);
        let authority = handle.session().authority_view().0;

        let mut disk_element = elem("x", 2, 3, "a1");
        disk_element["x"] = json!(30);
        let disk = body(json!([disk_element]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        handle.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(handle.session(), &fx.workspace).await;
        backdate_pending_fold(handle.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert!(handle.session().http_read_view().disk_conflicted);
        drop(handle);

        fx.workspace.write_text("b.excalidraw", &authority).unwrap();
        let restarted = Arc::new(SceneRegistry::new());
        let reopened = restarted
            .attach(&fx.workspace, "b.excalidraw", "w2")
            .await
            .expect("restart attach");
        assert!(
            !reopened.session().http_read_view().disk_conflicted,
            "a resolved scene conflict must not re-prompt"
        );
        {
            let state = reopened.session().lock_state();
            assert!(matches!(state.session_state, SessionState::Clean));
            assert!(state
                .scene
                .file_content_eq(&Scene::parse(&authority).unwrap()));
            assert!(Scene::parse(&state.baseline.content)
                .unwrap()
                .file_content_eq(&Scene::parse(&authority).unwrap()));
        }

        restarted.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(
            Scene::parse(&fx.workspace.read_text("b.excalidraw").unwrap())
                .unwrap()
                .file_content_eq(&Scene::parse(&authority).unwrap())
        );
    }

    #[tokio::test]
    async fn conflicted_scene_rehydration_collapses_when_disk_matches_baseline() {
        let mut baseline_element = elem("x", 1, 1, "a1");
        baseline_element["x"] = json!(10);
        let seed = body(json!([baseline_element]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (handle, mut frames) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut frames);

        let mut local_element = elem("x", 2, 2, "a1");
        local_element["x"] = json!(20);
        handle
            .push(vec![local_element], None, None)
            .expect("local edit");
        drain(&mut frames);
        let authority = handle.session().authority_view().0;

        let mut disk_element = elem("x", 2, 3, "a1");
        disk_element["x"] = json!(30);
        let disk = body(json!([disk_element]));
        fx.workspace.write_text("b.excalidraw", &disk).unwrap();
        handle.session().lock_state().flushed_mtime_ns = None;
        reconcile_session(handle.session(), &fx.workspace).await;
        backdate_pending_fold(handle.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        assert!(handle.session().http_read_view().disk_conflicted);
        drop(handle);

        fx.workspace.write_text("b.excalidraw", &seed).unwrap();
        let restarted = Arc::new(SceneRegistry::new());
        let reopened = restarted
            .attach(&fx.workspace, "b.excalidraw", "w2")
            .await
            .expect("restart attach");
        assert!(
            !reopened.session().http_read_view().disk_conflicted,
            "a baseline-restored scene conflict must not re-prompt"
        );
        {
            let state = reopened.session().lock_state();
            assert!(matches!(state.session_state, SessionState::Dirty { .. }));
            assert!(state
                .scene
                .file_content_eq(&Scene::parse(&authority).unwrap()));
            assert!(Scene::parse(&state.baseline.content)
                .unwrap()
                .file_content_eq(&Scene::parse(&seed).unwrap()));
        }

        backdate_dirty(reopened.session());
        restarted.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(
            Scene::parse(&fx.workspace.read_text("b.excalidraw").unwrap())
                .unwrap()
                .file_content_eq(&Scene::parse(&authority).unwrap())
        );
    }

    #[tokio::test]
    async fn delete_while_dirty_enters_conflicted() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        ha.push(vec![elem("y", 1, 2, "a2")], None, None).unwrap();
        drain(&mut rx);
        let authority = ha.session().authority_view().0;

        std::fs::remove_file(fx.root.path().join("b.excalidraw")).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        backdate_pending_removal(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("delete versus edit must enter Conflicted");
            };
            assert!(st.scene.element("y").is_some(), "local authority retained");
            assert_eq!(
                st.baseline.content,
                Scene::parse(&seed).unwrap().serialize_file()
            );
            assert_eq!(conflict.baseline_version, st.baseline.content_hash);
            assert_eq!(conflict.authority_version, st.version);
            assert_eq!(conflict.disk_mtime_ns, None);
            assert!(conflict.disk_content.is_empty());
        }
        assert_eq!(drain(&mut rx).len(), 0, "neither side wins");
        drop(ha);

        let restarted = Arc::new(SceneRegistry::new());
        let reopened = restarted
            .attach(&fx.workspace, "b.excalidraw", "w2")
            .await
            .expect("removed-side scene conflict rehydrates");
        let view = reopened.session().http_read_view();
        assert!(view.disk_conflicted);
        assert!(Scene::parse(&view.content)
            .unwrap()
            .file_content_eq(&Scene::parse(&authority).unwrap()));
        {
            let st = reopened.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("removed-side scene conflict must survive restart");
            };
            assert_eq!(conflict.disk_version, content_hash(REMOVED_DISK_MARKER));
        }
        restarted.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(!fx.root.path().join("b.excalidraw").exists());
    }

    #[tokio::test]
    async fn invalid_external_replacement_enters_conflicted() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        fx.workspace.write_text("b.excalidraw", "{oops").unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;

        reconcile_session(ha.session(), &fx.workspace).await;

        {
            let st = ha.session().lock_state();
            let SessionState::Conflicted(conflict) = &st.session_state else {
                panic!("invalid replacement must conflict");
            };
            assert!(st.scene.element("x").is_some());
            assert_eq!(
                st.baseline.content,
                Scene::parse(&seed).unwrap().serialize_file()
            );
            assert_eq!(conflict.disk_version, content_hash("{oops"));
            assert_eq!(conflict.disk_content, "{oops");
        }
        assert!(drain(&mut rx).is_empty());
        drop(ha);

        let restarted = Arc::new(SceneRegistry::new());
        let reopened = restarted
            .attach(&fx.workspace, "b.excalidraw", "w2")
            .await
            .expect("invalid-side scene conflict rehydrates");
        let view = reopened.session().http_read_view();
        assert!(view.disk_conflicted);
        assert!(Scene::parse(&view.content)
            .unwrap()
            .file_content_eq(&Scene::parse(&seed).unwrap()));
        restarted.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert_eq!(fx.workspace.read_text("b.excalidraw").unwrap(), "{oops");
    }

    #[tokio::test]
    async fn empty_file_seeds_an_empty_scene() {
        let fx = fixture(&[("b.excalidraw", "")]);
        let (_h, mut rx) = attach(&fx, "b.excalidraw", "win-1").await;
        let frames = drain(&mut rx);
        assert_eq!(frames[0]["elements"], json!([]));
    }

    #[tokio::test]
    async fn concurrent_first_attaches_share_one_session() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (a, b) = tokio::join!(
            fx.registry.attach(&fx.workspace, "b.excalidraw", "w1"),
            fx.registry.attach(&fx.workspace, "b.excalidraw", "w2"),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert!(Arc::ptr_eq(a.session(), b.session()));
        assert_eq!(fx.registry.lock_sessions().len(), 1);
        assert_eq!(a.session().attach_count(), 2);
    }

    #[tokio::test]
    async fn push_fans_accepted_to_others_only_and_acks_sender() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        let (_hb, mut rxb) = attach(&fx, "b.excalidraw", "w2").await;
        drain(&mut rxa);
        drain(&mut rxb);

        ha.push(vec![elem("x", 1, 5, "a1")], None, None).unwrap();

        // Sender: ack only, NO own echo (clients reconcile content,
        // they do not replay a log).
        let a_frames = drain(&mut rxa);
        assert_eq!(types(&a_frames), ["push-ok"], "{a_frames:?}");
        assert_eq!(a_frames[0]["version"], 1);

        // Peer: the accepted values.
        let b_frames = drain(&mut rxb);
        assert_eq!(types(&b_frames), ["update"]);
        assert_eq!(b_frames[0]["version"], 1);
        assert_eq!(b_frames[0]["elements"][0]["id"], "x");
        assert!(
            b_frames[0].get("appState").is_none(),
            "appState omitted when the push did not carry it"
        );
        assert!(b_frames[0].get("files").is_none());

        let st = ha.session().lock_state();
        assert!(st.session_state.is_dirty());
        assert_eq!(st.version, 1);
    }

    #[tokio::test]
    async fn discarded_push_acks_without_fan_or_dirt() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 5, 10, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        let (_hb, mut rxb) = attach(&fx, "b.excalidraw", "w2").await;
        drain(&mut rxa);
        drain(&mut rxb);

        // Older version: the stored element wins, nothing changes.
        ha.push(vec![elem("x", 4, 99, "a1")], None, None).unwrap();
        let a_frames = drain(&mut rxa);
        assert_eq!(types(&a_frames), ["push-ok"]);
        assert_eq!(a_frames[0]["version"], 0, "no version bump");
        assert_eq!(drain(&mut rxb).len(), 0, "nothing fans");
        let st = ha.session().lock_state();
        assert!(
            !st.session_state.is_dirty(),
            "discarded push leaves no dirt"
        );
    }

    #[tokio::test]
    async fn push_rejects_malformed_and_oversized_and_closed() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        let err = ha.push(vec![json!({"nope": 1})], None, None).unwrap_err();
        assert!(matches!(err, PushError::Scene(SceneError::Invalid(_))));

        let big = "x".repeat(TEXT_WRITE_LIMIT as usize + 16);
        let err = ha
            .push(
                vec![json!({"id": "big", "version": 1, "versionNonce": 1, "text": big})],
                None,
                None,
            )
            .unwrap_err();
        assert!(matches!(err, PushError::Scene(SceneError::TooLarge { .. })));

        ha.session().closed.store(true, Ordering::Relaxed);
        let err = ha.push(vec![], None, None).unwrap_err();
        assert!(matches!(err, PushError::Closed));
        ha.session().closed.store(false, Ordering::Relaxed);
    }

    #[tokio::test]
    async fn cursor_fans_to_others_snapshots_and_cleans_up() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        let (hb, mut rxb) = attach(&fx, "b.excalidraw", "w2").await;
        drain(&mut rxa);
        drain(&mut rxb);

        ha.cursor(
            120.5,
            -33.25,
            Some("selection".into()),
            Some(vec!["x".into()]),
        );
        assert_eq!(drain(&mut rxa).len(), 0, "own cursor is not echoed");
        let frames = drain(&mut rxb);
        assert_eq!(types(&frames), ["cursor"]);
        assert_eq!(frames[0]["id"], ha.attach_id());
        assert_eq!(frames[0]["w"], "w1");
        assert_eq!(frames[0]["x"], 120.5);
        assert_eq!(frames[0]["y"], -33.25);
        assert_eq!(frames[0]["tool"], "selection");
        assert_eq!(frames[0]["selected"], json!(["x"]));

        // A later attach sees the cursor in its snapshot.
        let (_hc, mut rxc) = attach(&fx, "b.excalidraw", "w3").await;
        let frames = drain(&mut rxc);
        assert_eq!(frames[0]["cursors"][0]["id"], ha.attach_id());

        // Detach fans cursor-gone to the survivors.
        let a_id = ha.attach_id();
        drop(ha);
        let frames = drain(&mut rxb);
        assert_eq!(types(&frames), ["cursor-gone"]);
        assert_eq!(frames[0]["id"], a_id);
        assert_eq!(hb.session().attach_count(), 2);
    }

    #[tokio::test]
    async fn flush_debounces_writes_file_form_and_stamps_token() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("x", 1, 5, "a1")], None, None).unwrap();
        drain(&mut rxa);

        // Inside the debounce window nothing flushes.
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let on_disk: Value =
            serde_json::from_str(&fx.workspace.read_text("b.excalidraw").unwrap()).unwrap();
        assert_eq!(on_disk["elements"], json!([]), "debounce holds");

        // Past the debounce the file form lands, the token is adopted,
        // and the clients hear about it.
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let text = fx.workspace.read_text("b.excalidraw").unwrap();
        let on_disk: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(on_disk["type"], "excalidraw");
        assert_eq!(on_disk["source"], "chan");
        assert_eq!(on_disk["elements"][0]["id"], "x");
        assert!(fx.self_writes.should_suppress("b.excalidraw"));
        let frames = drain(&mut rxa);
        assert_eq!(types(&frames), ["flush"]);
        assert_eq!(frames[0]["dirty"], false);
        assert!(frames[0]["mtime_ns"].is_string());
        let st = ha.session().lock_state();
        assert!(!st.session_state.is_dirty());
        assert!(st.flushed_mtime_ns.is_some());
    }

    #[tokio::test]
    async fn push_persists_recovery_on_flusher_tick_not_ack_path() {
        let seed = body(json!([]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let sidecar = fx
            .root
            .path()
            .join(".chan/editor-sessions/v1/scenes/b.excalidraw.json");
        let (handle, _frames) = attach(&fx, "b.excalidraw", "w1").await;

        handle
            .push(vec![elem("x", 1, 5, "a1")], None, None)
            .unwrap();
        assert!(
            !sidecar.exists(),
            "the ack path must not write the recovery sidecar"
        );

        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(
            sidecar.exists(),
            "the flusher tick must persist pending recovery"
        );
        let record: Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        assert_eq!(record["authority_version"], 1);
        let authority = Scene::parse(record["authority"].as_str().unwrap()).unwrap();
        assert!(authority.element("x").is_some());
    }

    #[tokio::test]
    async fn push_after_recovery_capture_stays_pending_for_next_tick() {
        let seed = body(json!([]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let sidecar = fx
            .root
            .path()
            .join(".chan/editor-sessions/v1/scenes/b.excalidraw.json");
        let (handle, _frames) = attach(&fx, "b.excalidraw", "w1").await;
        handle
            .push(vec![elem("x", 1, 5, "a1")], None, None)
            .unwrap();

        let captured = handle.session().recovery_record();
        assert!(!handle.session().lock_state().recovery_pending);
        handle
            .push(vec![elem("y", 1, 5, "a2")], None, None)
            .unwrap();
        assert!(handle.session().lock_state().recovery_pending);

        recovery::store(&fx.workspace, &captured).unwrap();
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let record: Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        assert_eq!(record["authority_version"], 2);
        let authority = Scene::parse(record["authority"].as_str().unwrap()).unwrap();
        assert!(authority.element("x").is_some());
        assert!(authority.element("y").is_some());
    }

    #[tokio::test]
    async fn mutation_during_flush_keeps_the_session_dirty() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("x", 1, 5, "a1")], None, None).unwrap();

        // Interleave: capture the flush job, then land another push
        // before the write "completes".
        let job = ha.session().begin_flush().expect("dirty session");
        ha.push(vec![elem("y", 1, 5, "a2")], None, None).unwrap();
        fx.workspace
            .write_text_if_unchanged("b.excalidraw", job.expected_mtime_ns, &job.text)
            .unwrap();
        let stat = fx.workspace.stat("b.excalidraw").unwrap();
        ha.session().finish_flush(job.epoch, &stat, &job.text);

        let st = ha.session().lock_state();
        assert!(
            st.session_state.is_dirty(),
            "the mid-flight push must survive as dirt"
        );
        assert_eq!(st.flushed_mtime_ns, stat.mtime_ns, "token still adopted");
    }

    #[tokio::test]
    async fn detach_forces_flush_and_grace_reaps_clean_sessions() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, _rxa) = attach(&fx, "b.excalidraw", "w1").await;
        ha.push(vec![elem("x", 1, 5, "a1")], None, None).unwrap();
        let session = Arc::clone(ha.session());
        drop(ha);

        // The last detach requests a prompt flush; the pass honors it
        // without waiting out the debounce.
        assert!(session.lock_state().flush_now);
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let on_disk: Value =
            serde_json::from_str(&fx.workspace.read_text("b.excalidraw").unwrap()).unwrap();
        assert_eq!(on_disk["elements"][0]["id"], "x");

        // Not yet aged: the reaper leaves it.
        fx.registry.reap_pass();
        assert_eq!(fx.registry.lock_sessions().len(), 1);

        // Aged past grace and clean: reaped, and the next attach
        // starts a fresh session from disk.
        session.detached_at.store(
            now_unix_millis() - SCENE_DETACH_GRACE.as_millis() as i64 - 1_000,
            Ordering::Relaxed,
        );
        fx.registry.reap_pass();
        assert_eq!(fx.registry.lock_sessions().len(), 0);
        assert!(session.closed.load(Ordering::Relaxed));
        let (hc, mut rxc) = attach(&fx, "b.excalidraw", "w3").await;
        let frames = drain(&mut rxc);
        assert_eq!(frames[0]["type"], "snapshot");
        assert_eq!(frames[0]["version"], 0, "fresh session");
        assert!(!Arc::ptr_eq(hc.session(), &session));
    }

    #[tokio::test]
    async fn reaper_spares_dirty_sessions() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, _rxa) = attach(&fx, "b.excalidraw", "w1").await;
        ha.push(vec![elem("x", 1, 5, "a1")], None, None).unwrap();
        let session = Arc::clone(ha.session());
        drop(ha);
        session.detached_at.store(
            now_unix_millis() - SCENE_DETACH_GRACE.as_millis() as i64 - 1_000,
            Ordering::Relaxed,
        );
        // Sabotage the flush so the dirt survives the detach pass.
        session.lock_state().flush_now = false;
        fx.registry.reap_pass();
        assert_eq!(
            fx.registry.lock_sessions().len(),
            1,
            "unflushed content must never be reaped away"
        );
    }

    #[tokio::test]
    async fn reconcile_ignores_own_flush_echo() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("x", 1, 5, "a1")], None, None).unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);
        let version_before = ha.session().lock_state().version;

        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(ha.session().lock_state().version, version_before);
        assert_eq!(drain(&mut rxa).len(), 0);
    }

    #[tokio::test]
    async fn formatting_only_ring_echo_clears_the_disk_observation() {
        let compact = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &compact)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        std::fs::write(fx.root.path().join("b.excalidraw"), &compact).unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;

        reconcile_session(ha.session(), &fx.workspace).await;

        assert!(
            ha.session()
                .lock_state()
                .session_state
                .content_observation()
                .is_none(),
            "semantically equal scene formatting must settle the echo"
        );
    }

    #[tokio::test]
    async fn restamped_disk_adopt_keeps_durable_bytes_and_settles_its_echo() {
        let seed = body(json!([elem("x", 5, 10, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rx) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rx);
        let mut edited = elem("x", 5, 10, "a1");
        edited
            .as_object_mut()
            .unwrap()
            .insert("strokeColor".into(), "#ff0000".into());
        let disk_text = body(json!([edited]));
        let disk_canonical = Scene::parse(&disk_text).unwrap().serialize_file();
        fx.workspace.write_text("b.excalidraw", &disk_text).unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;

        reconcile_session(ha.session(), &fx.workspace).await;

        {
            let mut st = ha.session().lock_state();
            assert_ne!(
                st.scene.serialize_file(),
                disk_canonical,
                "the server restamps adopted merge metadata"
            );
            assert_eq!(
                st.baseline.content, disk_canonical,
                "the durable baseline must retain the bytes represented on disk"
            );
            st.flushed_mtime_ns = None;
        }
        reconcile_session(ha.session(), &fx.workspace).await;
        assert!(
            ha.session()
                .lock_state()
                .session_state
                .content_observation()
                .is_none(),
            "nonce-only authority divergence must settle a live echo-ring entry"
        );
    }

    #[tokio::test]
    async fn reconcile_merges_hand_edits_with_bumped_versions() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 5, 10, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        let (_hb, mut rxb) = attach(&fx, "b.excalidraw", "w2").await;
        drain(&mut rxa);
        drain(&mut rxb);

        // An agent hand-edits the element on disk without touching its
        // version fields.
        let mut edited = elem("x", 5, 10, "a1");
        edited
            .as_object_mut()
            .unwrap()
            .insert("strokeColor".into(), "#ff0000".into());
        fx.workspace
            .write_text("b.excalidraw", &body(json!([edited])))
            .unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent::file(
                    WatchKind::Modified,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;

        for rx in [&mut rxa, &mut rxb] {
            let frames = drain(rx);
            assert_eq!(types(&frames), ["update"], "disk merges fan to everyone");
            let el = &frames[0]["elements"][0];
            assert_eq!(el["strokeColor"], "#ff0000");
            assert_eq!(
                el["version"], 6,
                "bumped past the stored version so client reconciliation adopts it"
            );
        }
        let st = ha.session().lock_state();
        assert!(!st.session_state.is_dirty(), "authority equals disk: clean");
        assert!(st.flushed_mtime_ns.is_some(), "disk token adopted");
    }

    #[tokio::test]
    async fn reconcile_adopts_token_silently_on_equal_content() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        // Rewrite equivalent content: mtime changes, the scene does
        // not (element values identical; envelope formatting differs,
        // which must not matter).
        fx.workspace
            .write_text("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))
            .unwrap();
        let disk_token = fx.workspace.stat("b.excalidraw").unwrap().mtime_ns;
        reconcile_session(ha.session(), &fx.workspace).await;

        let st = ha.session().lock_state();
        assert_eq!(st.version, 0, "no synthetic update for equal content");
        assert_eq!(st.flushed_mtime_ns, disk_token, "token adopted");
        drop(st);
        assert_eq!(drain(&mut rxa).len(), 0, "silent adoption");
    }

    #[tokio::test]
    async fn reconcile_keeps_authority_on_corrupt_disk_content() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        let token_before = ha.session().token();

        std::fs::write(fx.root.path().join("b.excalidraw"), "{not json").unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;

        let st = ha.session().lock_state();
        assert_eq!(st.version, 0, "authority untouched");
        assert_eq!(
            st.flushed_mtime_ns, token_before,
            "corrupt content must not adopt the token (stalemate surfaces via flush errors)"
        );
        drop(st);
        assert_eq!(drain(&mut rxa).len(), 0);
    }

    #[tokio::test]
    async fn removed_file_stops_flushing_and_next_push_recreates() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        std::fs::remove_file(fx.root.path().join("b.excalidraw")).unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent::file(
                    WatchKind::Removed,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        // Absence corroborates across two observations before the
        // removal fans.
        assert_eq!(drain(&mut rxa).len(), 0, "first absence only parks");
        backdate_pending_removal(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let frames = drain(&mut rxa);
        assert_eq!(types(&frames), ["removed"]);
        {
            let st = ha.session().lock_state();
            assert_eq!(st.flushed_mtime_ns, None);
            assert!(!st.session_state.is_dirty(), "flush clock stopped");
        }
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        assert!(
            !fx.workspace.exists("b.excalidraw"),
            "a deliberate delete is not resurrected"
        );

        // The next push re-dirties; the CAS-against-None write
        // recreates the file.
        ha.push(vec![elem("z", 1, 1, "a3")], None, None).unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let on_disk: Value =
            serde_json::from_str(&fx.workspace.read_text("b.excalidraw").unwrap()).unwrap();
        let ids: Vec<&str> = on_disk["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x", "z"]);
    }

    #[tokio::test]
    async fn flush_echo_removed_event_is_not_a_removal() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("x", 1, 1, "a1")], None, None).unwrap();
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
                WatchEvent::file(
                    WatchKind::Removed,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;

        assert_eq!(drain(&mut rxa).len(), 0, "no spurious removed frame");
        let st = ha.session().lock_state();
        assert_eq!(st.flushed_mtime_ns, token, "token untouched");
        assert!(!st.session_state.is_dirty(), "session stays clean");
    }

    #[tokio::test]
    async fn rename_away_still_fans_removed_for_the_source() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        std::fs::rename(
            fx.root.path().join("b.excalidraw"),
            fx.root.path().join("c.excalidraw"),
        )
        .unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent::rename(
                    Some("b.excalidraw".into()),
                    Some("c.excalidraw".into()),
                    false,
                    None,
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        // The vacated source parks as a pending absence and fans the
        // removal once it corroborates.
        assert_eq!(drain(&mut rxa).len(), 0, "first absence only parks");
        backdate_pending_removal(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;

        let frames = drain(&mut rxa);
        assert_eq!(types(&frames), ["removed"]);
        assert!(ha.session().lock_state().flushed_mtime_ns.is_none());
    }

    #[tokio::test]
    async fn flush_cas_conflict_enters_conflicted_after_corroboration() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        let mut local = elem("x", 2, 2, "a1");
        local["x"] = json!(20);
        ha.push(vec![local], None, None).unwrap();
        drain(&mut rxa);

        // Stale the session token: an external write bumps the mtime
        // and changes the same element field incompatibly.
        let mut disk = elem("x", 2, 3, "a1");
        disk["x"] = json!(30);
        fx.workspace
            .write_text("b.excalidraw", &body(json!([disk])))
            .unwrap();
        backdate_dirty(ha.session());
        let settled = flush_session(ha.session(), &fx.workspace, &fx.self_writes).await;

        // The conflict defers to corroboration: nothing merged yet, no
        // failure fanned, the divergent observation parked.
        assert!(!settled, "deferred fold-in is not a settled flush");
        assert!(
            !fx.self_writes.should_suppress("b.excalidraw"),
            "the CAS-conflict arm must cancel its reservation"
        );
        assert_eq!(drain(&mut rxa).len(), 0, "no fan while parked");
        {
            let st = ha.session().lock_state();
            assert!(st.session_state.content_observation().is_some());
            assert_eq!(st.flush_failures, 0, "a deferral is not a failure");
        }

        // The observation holds: the identity-aware merge proves the
        // same field overlaps, keeps both sides, and pauses flush.
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        let st = ha.session().lock_state();
        let SessionState::Conflicted(conflict) = &st.session_state else {
            panic!("corroborated divergence must enter Conflicted");
        };
        assert!(conflict.disk_content.contains("\"x\":30"));
        drop(st);
        let (text, _) = ha.session().authority_view();
        let on_session: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(on_session["elements"][0]["id"], "x");
        assert_eq!(
            on_session["elements"][0]["x"], 20,
            "local authority stays live"
        );
        assert_eq!(drain(&mut rxa).len(), 0, "no actor silently wins");
    }

    #[tokio::test]
    async fn close_all_flushes_fans_closed_and_empties_the_registry() {
        let fx = fixture(&[
            ("a.excalidraw", &body(json!([]))[..]),
            ("b.excalidraw", &body(json!([]))[..]),
        ]);
        let (ha, mut rxa) = attach(&fx, "a.excalidraw", "w1").await;
        let (hb, mut rxb) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        drain(&mut rxb);
        ha.push(vec![elem("x", 1, 1, "a1")], None, None).unwrap();
        drain(&mut rxa);

        fx.registry
            .close_all("reset", Some(&fx.workspace), &fx.self_writes)
            .await;

        let on_disk: Value =
            serde_json::from_str(&fx.workspace.read_text("a.excalidraw").unwrap()).unwrap();
        assert_eq!(on_disk["elements"][0]["id"], "x", "dirty scene flushed");
        let a_frames = drain(&mut rxa);
        assert_eq!(a_frames.last().unwrap()["type"], "closed");
        assert_eq!(a_frames.last().unwrap()["reason"], "reset");
        assert_eq!(drain(&mut rxb).last().unwrap()["type"], "closed");
        assert_eq!(fx.registry.lock_sessions().len(), 0);
        assert!(matches!(
            ha.push(vec![], None, None),
            Err(PushError::Closed)
        ));
        assert!(matches!(
            hb.push(vec![], None, None),
            Err(PushError::Closed)
        ));
    }

    #[tokio::test]
    async fn http_replace_fans_bumped_elements_and_marks_dirty() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 5, 10, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        let mut edited = elem("x", 5, 10, "a1");
        edited
            .as_object_mut()
            .unwrap()
            .insert("angle".into(), json!(45));
        ha.session().apply_replace(&body(json!([edited]))).unwrap();
        let frames = drain(&mut rxa);
        assert_eq!(types(&frames), ["update"]);
        assert_eq!(frames[0]["elements"][0]["version"], 6);
        let st = ha.session().lock_state();
        assert_eq!(st.version, 1);
        assert!(st.session_state.is_dirty(), "PUT divert flushes explicitly");
        drop(st);

        // Equal content is a no-op.
        let (current, _) = ha.session().authority_view();
        ha.session().apply_replace(&current).unwrap();
        assert_eq!(drain(&mut rxa).len(), 0);
        assert_eq!(ha.session().lock_state().version, 1);

        // Bad bodies are rejected without touching the session.
        let err = ha.session().apply_replace("{nope").unwrap_err();
        assert!(matches!(err, SceneError::Invalid(_)));
        assert_eq!(ha.session().lock_state().version, 1);
    }

    #[tokio::test]
    async fn legacy_oversize_scene_can_shrink_within_its_semantic_budget() {
        let fx = fixture(&[]);
        let mut legacy_element = elem("x", 1, 1, "a1");
        legacy_element
            .as_object_mut()
            .unwrap()
            .insert("text".into(), json!("x".repeat(3 * 1024 * 1024)));
        std::fs::write(
            fx.root.path().join("legacy.excalidraw"),
            body(json!([legacy_element])),
        )
        .unwrap();
        let (ha, mut rx) = attach(&fx, "legacy.excalidraw", "w1").await;
        drain(&mut rx);

        let mut smaller_element = elem("x", 1, 1, "a1");
        smaller_element
            .as_object_mut()
            .unwrap()
            .insert("text".into(), json!("y".repeat(5 * 1024 * 1024 / 2)));
        ha.session()
            .apply_replace(&body(json!([smaller_element])))
            .unwrap();

        assert!(ha.session().authority_view().0.len() > TEXT_WRITE_LIMIT as usize);
    }

    #[tokio::test]
    async fn attach_rejects_invalid_missing_and_corrupt_paths() {
        let fx = fixture(&[("corrupt.excalidraw", "{oops")]);
        for path in ["../escape.excalidraw", "no-such.excalidraw"] {
            let err = fx.registry.attach(&fx.workspace, path, "w1").await.err();
            assert!(
                matches!(err, Some(AttachError::Workspace(_))),
                "attach must fail for {path}"
            );
        }
        let err = fx
            .registry
            .attach(&fx.workspace, "corrupt.excalidraw", "w1")
            .await
            .err();
        assert!(
            matches!(err, Some(AttachError::Scene(SceneError::Invalid(_)))),
            "corrupt scene must not seed a session: {err:?}"
        );
        assert_eq!(fx.registry.lock_sessions().len(), 0);
    }

    // ---- untrusted-filesystem reconcile guards, mirroring the
    // doc_sessions suite: no lying stat/read may blank a scene, revert
    // flushed mutations, or discard dirty ones. An empty body parses
    // as a valid empty scene, so the empty-read guard is load-bearing
    // here exactly as it is for docs.

    #[tokio::test]
    async fn empty_read_after_flush_is_refused_and_disk_restored() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        // A mutation is confirmed and flushed; disk is good.
        ha.push(vec![elem("y", 1, 1, "a2")], None, None).unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);
        let flushed = fx.workspace.read_text("b.excalidraw").unwrap();
        assert!(flushed.contains("\"y\""));

        // Another mutation lands (dirty), then the flush's own echo
        // comes back with a re-stamped mtime and an EMPTY read.
        ha.push(vec![elem("z", 1, 1, "a3")], None, None).unwrap();
        drain(&mut rxa);
        std::fs::write(fx.root.path().join("b.excalidraw"), "").unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent::file(
                    WatchKind::Modified,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;

        // Refused: no element tombstoned, no fan, observation parked.
        let (text, _) = ha.session().authority_view();
        let on_session: Value = serde_json::from_str(&text).unwrap();
        let ids: Vec<&str> = on_session["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x", "y", "z"], "no element lost to the empty read");
        {
            let st = ha.session().lock_state();
            assert!(st.session_state.is_dirty(), "dirty mutation survives");
            assert!(
                st.session_state.content_observation().is_some(),
                "observation parked"
            );
        }
        assert_eq!(drain(&mut rxa).len(), 0, "no fan for the refusal");

        // The adopted token lets the next flush CAS-write the scene
        // back over the suspect empty file.
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        let restored = fx.workspace.read_text("b.excalidraw").unwrap();
        assert!(
            restored.contains("\"z\""),
            "scene file restored: {restored}"
        );
    }

    #[tokio::test]
    async fn stale_prewrite_read_is_recognized_as_own_echo() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        // Mutation confirmed and flushed: disk carries x and y.
        ha.push(vec![elem("y", 1, 1, "a2")], None, None).unwrap();
        backdate_dirty(ha.session());
        fx.registry.flush_pass(&fx.workspace, &fx.self_writes).await;
        drain(&mut rxa);

        // The flush's own echo arrives with a re-stamped mtime and the
        // read serves the PRE-write bytes: the exact seed text, still
        // in the echo ring.
        std::fs::write(fx.root.path().join("b.excalidraw"), &seed).unwrap();
        let stale_token = fx.workspace.stat("b.excalidraw").unwrap().mtime_ns;
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent::file(
                    WatchKind::Modified,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;

        // The authority keeps y; the token is adopted; nothing fans.
        let (text, token) = ha.session().authority_view();
        assert!(text.contains("\"y\""), "flushed mutation survives");
        assert_eq!(token, stale_token, "token adopted from the observation");
        assert_eq!(drain(&mut rxa).len(), 0, "no fan");
    }

    #[tokio::test]
    async fn external_restore_folds_after_echo_ttl() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let changed = body(json!([elem("x", 1, 1, "a1"), elem("y", 1, 1, "a2")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.session()
            .test_set_disk_echo_ttl(Duration::from_millis(500));
        ha.session()
            .lock_state()
            .disk_echo
            .note_written(content_hash(&seed));

        std::fs::write(fx.root.path().join("b.excalidraw"), &changed).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert!(ha.session().authority_view().0.contains("\"y\""));
        drain(&mut rxa);

        std::fs::write(fx.root.path().join("b.excalidraw"), &seed).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert!(
            ha.session().authority_view().0.contains("\"y\""),
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

        ha.session().test_age_disk_echo(Duration::from_millis(600));
        fx.registry.reconcile_pending(&fx.workspace).await;
        let (text, _) = ha.session().authority_view();
        assert!(!text.contains("\"y\""), "the expired restore folds");
        assert_eq!(types(&drain(&mut rxa)), ["update"]);
    }

    #[tokio::test]
    async fn post_preflight_write_failure_cancels_suppression() {
        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("x", 1, 1, "a1")], None, None).unwrap();

        // The strict preflight succeeds, then the hook replaces the
        // target with a directory inside the blocking write task.
        ha.session().test_fail_after_preflight();
        let ok = flush_session(ha.session(), &fx.workspace, &fx.self_writes).await;
        assert!(
            !fx.self_writes.should_suppress("b.excalidraw"),
            "a post-preflight failure must cancel watcher suppression"
        );
        assert!(!ok, "failed write must report false");
        assert!(
            ha.session().lock_state().session_state.is_dirty(),
            "authority remains dirty"
        );
        assert!(fx.root.path().join("b.excalidraw").is_dir());

        std::fs::remove_dir(fx.root.path().join("b.excalidraw")).unwrap();
        fx.workspace
            .write_text("b.excalidraw", &body(json!([])))
            .unwrap();
        ha.session().lock_state().flushed_mtime_ns =
            fx.workspace.stat("b.excalidraw").unwrap().mtime_ns;
        assert!(flush_session(ha.session(), &fx.workspace, &fx.self_writes).await);
    }

    #[tokio::test]
    async fn external_edit_into_dirty_session_does_not_discard_authority() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("y", 1, 1, "a2")], None, None).unwrap();
        drain(&mut rxa);
        assert!(ha.session().lock_state().session_state.is_dirty());

        // A genuine external edit lands while the session is dirty:
        // not our bytes, so it must corroborate before folding in.
        fx.workspace
            .write_text(
                "b.excalidraw",
                &body(json!([elem("x", 1, 1, "a1"), elem("z", 1, 1, "a3")])),
            )
            .unwrap();
        ha.session().lock_state().flushed_mtime_ns = None;
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent::file(
                    WatchKind::Modified,
                    "b.excalidraw",
                    chan_workspace::WorkspaceGeneration::default(),
                ),
            )
            .await;
        assert_eq!(drain(&mut rxa).len(), 0, "first observation only parks");
        assert!(ha.session().authority_view().0.contains("\"y\""));

        // The observation holds. Distinct identities merge without
        // allowing disk to silently tombstone the local element.
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        let (text, _) = ha.session().authority_view();
        let on_session: Value = serde_json::from_str(&text).unwrap();
        let ids: Vec<&str> = on_session["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x", "y", "z"]);
        assert_eq!(types(&drain(&mut rxa)), ["update"]);
    }

    #[tokio::test]
    async fn transient_absence_does_not_fan_removed() {
        let seed = body(json!([elem("x", 1, 1, "a1")]));
        let fx = fixture(&[("b.excalidraw", &seed)]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);

        // A non-atomic replace vanishes the path for one observation;
        // it is back before the corroborating re-check.
        std::fs::remove_file(fx.root.path().join("b.excalidraw")).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert_eq!(drain(&mut rxa).len(), 0, "absence only parks");
        assert!(ha
            .session()
            .lock_state()
            .session_state
            .removal_observation()
            .is_some());

        std::fs::write(fx.root.path().join("b.excalidraw"), &seed).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert!(ha
            .session()
            .lock_state()
            .session_state
            .removal_observation()
            .is_none());
        for f in drain(&mut rxa) {
            assert_ne!(f["type"], "removed");
        }
    }
}
