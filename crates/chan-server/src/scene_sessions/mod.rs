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
//! scene file form, and the reconciler folds external writes back in
//! through the replace semantics (bumped versions and tombstones that
//! win client-side reconciliation) instead of raising the "changed on
//! disk" banner. Because a filesystem's mtime and read-after-write
//! cannot be trusted to identify our own flush echoes (network FUSE
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

use chan_workspace::{ChanError, FileStat, WatchEvent, WatchKind, Workspace, TEXT_WRITE_LIMIT};
use rand::RngCore;
use tokio::sync::{broadcast, mpsc, watch, Notify};

use crate::disk_echo::{content_hash, DiskEchoRing};
use crate::routes::scene::{PeerSceneCursor, ServerFrame};
use crate::self_writes::SelfWrites;
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
/// echo must hold this long, unchanged, before it folds into the
/// session; parity with doc_sessions.
const CORROBORATE_AFTER: Duration = Duration::from_millis(300);

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
    /// Count of accepted mutations (pushes, replaces, disk merges that
    /// changed anything) since session creation. Informational on the
    /// wire; there is no rebase protocol.
    version: u64,
    attaches: HashMap<u64, AttachSink>,
    cursors: HashMap<u64, CursorPos>,
    /// When the authority first diverged from the flushed disk state;
    /// None while clean. The flush debounce is measured from here.
    dirty_since: Option<Instant>,
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
    /// Hashes of raw file text this session itself put on (or adopted
    /// from) disk. A reconcile read matching the ring is our own bytes
    /// under a re-stamped mtime, never an external edit.
    disk_echo: DiskEchoRing,
    /// Divergent disk observation awaiting corroboration; folded in
    /// only after it holds unchanged past `CORROBORATE_AFTER`. The
    /// flusher tick re-observes pending sessions.
    pending_fold: Option<PendingFold>,
    /// First observation of the file being absent; `mark_removed` only
    /// fires once absence holds past `CORROBORATE_AFTER`.
    pending_removal: Option<Instant>,
}

/// One unverified disk observation: content hash plus the stat token
/// it arrived under. A later observation corroborates it only when
/// both match; any change restarts the clock.
struct PendingFold {
    hash: u64,
    mtime_ns: Option<i64>,
    seen: Instant,
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
        dirty: st.dirty_since.is_some(),
        mtime_ns: st.flushed_mtime_ns.map(|n| n.to_string()),
        cursors,
    })
}

fn flush_frame(st: &SceneState) -> String {
    serialize(&ServerFrame::Flush {
        dirty: st.dirty_since.is_some(),
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
        if self.dirty_since.is_none() {
            self.dirty_since = Some(Instant::now());
        }
    }
}

impl SceneSession {
    fn new(path: &str, seed_text: &str, scene: Scene, stat: &FileStat) -> Self {
        // The seed is disk-adopted content: a stale read serving those
        // raw bytes back later must count as an echo, not an external
        // edit. The ring holds raw file text, not the serialize_file
        // form, because a stale read returns exactly what was on disk.
        let mut disk_echo = DiskEchoRing::new();
        disk_echo.note(content_hash(seed_text));
        Self {
            path: path.to_string(),
            state: Mutex::new(SceneState {
                scene,
                version: 0,
                attaches: HashMap::new(),
                cursors: HashMap::new(),
                dirty_since: None,
                flush_now: false,
                flushed_mtime_ns: stat.mtime_ns,
                flush_epoch_version: 0,
                flush_failures: 0,
                disk_echo,
                pending_fold: None,
                pending_removal: None,
            }),
            attach_count: AtomicUsize::new(0),
            detached_at: AtomicI64::new(0),
            closed: AtomicBool::new(false),
            io_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, SceneState> {
        self.state.lock().expect("scene session state poisoned")
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
            .pending_removal
            .as_mut()
            .expect("a pending removal to age");
        *pending = Instant::now()
            .checked_sub(CORROBORATE_AFTER + Duration::from_millis(50))
            .unwrap();
    }

    /// Current authority scene in its file form plus the session CAS
    /// token, for the GET divert: a client reads exactly what a flush
    /// would write, under a token consistent with the session.
    pub fn authority_view(&self) -> (String, Option<i64>) {
        let st = self.lock_state();
        (st.scene.serialize_file(), st.flushed_mtime_ns)
    }

    /// Session CAS token for the PUT divert's conflict check.
    pub fn token(&self) -> Option<i64> {
        self.lock_state().flushed_mtime_ns
    }

    /// Replace the whole authority scene from a file body (the `$http`
    /// divert). Changed elements fan to every attachment with bumped
    /// versions and the session turns dirty; equal content is a no-op.
    /// The caller decides when to flush.
    pub fn apply_replace(&self, body: &str) -> Result<(), SceneError> {
        let mut st = self.lock_state();
        let applied = st.scene.apply_replace(body, &mut fresh_nonce)?;
        if !applied.is_empty() {
            st.version += 1;
            let frame = update_frame(st.version, applied);
            st.fan(&frame);
            st.mark_dirty();
        }
        Ok(())
    }

    /// Fold external disk content into the session through the replace
    /// semantics: clients converge on the disk state, the token is
    /// adopted, and the session is clean afterwards. Equal content
    /// adopts the token silently. Content that does not parse as a
    /// scene is ignored with a warning: a deliberate stalemate that
    /// surfaces through flush errors rather than corrupting the
    /// session.
    fn merge_disk(&self, disk_text: String, stat: &FileStat) {
        let mut st = self.lock_state();
        // Adopted disk bytes join the echo ring either way: even when
        // the parse gate below rejects them, a stale read serving the
        // same bytes again is not a fresh observation.
        st.disk_echo.note(content_hash(&disk_text));
        st.pending_fold = None;
        st.pending_removal = None;
        match st.scene.apply_replace(&disk_text, &mut fresh_nonce) {
            Ok(applied) => {
                if !applied.is_empty() {
                    st.version += 1;
                    let frame = update_frame(st.version, applied);
                    st.fan(&frame);
                }
                st.flushed_mtime_ns = stat.mtime_ns;
                st.dirty_since = None;
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
        st.flushed_mtime_ns = None;
        st.dirty_since = None;
        st.flush_now = false;
        st.pending_fold = None;
        st.pending_removal = None;
        st.fan(&serialize(&ServerFrame::Removed));
    }

    /// First half of a flush: serialize the file form and capture the
    /// token under the lock. Returns None when there is nothing to
    /// flush. Clears `flush_now` either way.
    fn begin_flush(&self) -> Option<FlushJob> {
        let mut st = self.lock_state();
        st.flush_now = false;
        st.dirty_since?;
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
    fn finish_flush(&self, epoch: u64, stat: &FileStat, content_hash: u64) {
        let mut st = self.lock_state();
        st.flushed_mtime_ns = stat.mtime_ns;
        st.disk_echo.note(content_hash);
        st.flush_failures = 0;
        if st.version == epoch {
            st.dirty_since = None;
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
    // Exercised by the scene_sessions and route tests; the ws pump
    // itself only takes frames, pushes, and moves cursors.
    #[allow(dead_code)]
    pub fn attach_id(&self) -> u64 {
        self.attach_id
    }

    #[allow(dead_code)]
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
        let applied = st.scene.apply_push(elements, app_state, files)?;
        if !applied.is_empty() {
            st.version += 1;
            let frame = update_frame(st.version, applied);
            st.fan_except(self.attach_id, &frame);
            st.mark_dirty();
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
        self.sessions.lock().expect("scene registry poisoned")
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
            let (text, stat) =
                tokio::task::spawn_blocking(move || ws.read_text_with_stat(&read_path))
                    .await
                    .map_err(|e| AttachError::Task(e.to_string()))??;
            if text.len() as u64 > TEXT_WRITE_LIMIT {
                return Err(AttachError::Scene(SceneError::TooLarge {
                    bytes: text.len() as u64,
                    limit: TEXT_WRITE_LIMIT,
                }));
            }
            let scene = Scene::parse(&text)?;

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
                    let session = Arc::new(SceneSession::new(path, &text, scene, &stat));
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
            let due = {
                let st = session.lock_state();
                st.flush_now
                    || st
                        .dirty_since
                        .is_some_and(|since| since.elapsed() >= SCENE_FLUSH_DEBOUNCE)
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
                && st.dirty_since.is_none()
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
                st.pending_fold.is_some() || st.pending_removal.is_some()
            };
            if pending {
                reconcile_session(&session, workspace).await;
            }
        }
    }
}

/// Flush one session to disk: serialize under the lock, CAS-write
/// outside it, commit the token. A CAS conflict means the disk changed
/// under us: reconcile (merging the external content through the
/// replace semantics) and retry once. Other failures keep the session
/// dirty; the content stays safe in memory and in every client, and
/// the error fan starts on the second consecutive failure.
///
/// Returns whether the state captured by this call settled durably:
/// true when the write committed, when there was nothing unflushed, or
/// when the CAS-conflict reconcile left authority and disk equal
/// (including the removed-file path, whose authoritative disk state is
/// deliberately "no file"). False means the write failed and the
/// session stays dirty; the PUT divert turns that into an honest 503.
pub(crate) async fn flush_session(
    session: &Arc<SceneSession>,
    workspace: &Arc<Workspace>,
    self_writes: &SelfWrites,
) -> bool {
    let _io = session.io_lock.lock().await;
    flush_session_locked(session, workspace, self_writes).await
}

async fn flush_session_locked(
    session: &Arc<SceneSession>,
    workspace: &Arc<Workspace>,
    self_writes: &SelfWrites,
) -> bool {
    for attempt in 0..2u32 {
        let Some(job) = session.begin_flush() else {
            return true;
        };
        // Reserve suppression before the blocking write so an
        // immediate watcher event cannot escape. The strict preflight
        // keeps known-refused writes out of the ring; failures after
        // reservation cancel it below.
        let self_write = match self_writes.reserve_if_writable(workspace, &session.path) {
            Ok(reservation) => reservation,
            Err(e) => {
                session.note_flush_failure(e.to_string());
                return false;
            }
        };
        let job_hash = content_hash(&job.text);
        let ws = Arc::clone(workspace);
        let path = session.path.clone();
        let epoch = job.epoch;
        let result = tokio::task::spawn_blocking(move || {
            match ws.write_text_if_unchanged(&path, job.expected_mtime_ns, &job.text) {
                Ok(()) => (true, ws.stat(&path)),
                Err(e) => (false, Err(e)),
            }
        })
        .await;
        match result {
            Ok((_, Ok(stat))) => {
                session.finish_flush(epoch, &stat, job_hash);
                return true;
            }
            Ok((false, Err(ChanError::WriteConflict { .. }))) if attempt == 0 => {
                self_writes.cancel(self_write);
                // Disk changed since our token: fold the external
                // content in, then retry with the adopted token. If
                // the merge left nothing dirty the retry no-ops. A
                // fold-in deferred for corroboration is not a failure:
                // the pending path owns convergence, so bail without
                // fanning an error.
                reconcile_session_locked(session, workspace).await;
                if session.lock_state().pending_fold.is_some() {
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
/// own flush echo (ignore); parseable content merges through the
/// replace semantics (equal content adopts the token silently); a
/// vanished file routes into the removed path. Unreadable or
/// unparseable content is ignored with a warning: a deliberate
/// stalemate that surfaces through flush errors rather than corrupting
/// the session.
pub(crate) async fn reconcile_session(session: &Arc<SceneSession>, workspace: &Arc<Workspace>) {
    let _io = session.io_lock.lock().await;
    reconcile_session_locked(session, workspace).await
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
                st.pending_removal = None;
                return;
            }
            // Absence must corroborate; parity with doc_sessions.
            match st.pending_removal {
                Some(first) if first.elapsed() >= CORROBORATE_AFTER => {
                    drop(st);
                    session.mark_removed();
                }
                Some(_) => {}
                None => st.pending_removal = Some(Instant::now()),
            }
            return;
        }
        Err(_) => return,
    };
    {
        let mut st = session.lock_state();
        st.pending_removal = None;
        // A matching token settles the event as our own flush echo,
        // except while an observation is pending; parity with
        // doc_sessions.
        if stat.mtime_ns.is_some()
            && stat.mtime_ns == st.flushed_mtime_ns
            && st.pending_fold.is_none()
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
                    "scene session reconcile read failed; keeping the authority scene"
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
            let authority_hash = content_hash(&st.scene.serialize_file());
            if hash == authority_hash {
                st.pending_fold = None;
            } else if !matches!(
                &st.pending_fold,
                Some(p) if p.hash == hash && p.mtime_ns == disk_stat.mtime_ns
            ) {
                st.pending_fold = Some(PendingFold {
                    hash,
                    mtime_ns: disk_stat.mtime_ns,
                    seen: Instant::now(),
                });
            }
            return;
        }
        let dirty = st.dirty_since.is_some();
        if disk_text.is_empty() && (dirty || st.disk_echo.any_recent()) {
            // The in-flight-upload placeholder guard; parity with
            // doc_sessions, and load-bearing here too: an empty body
            // parses as a valid empty scene, so without this refusal a
            // lying read would tombstone every element. The adopted
            // token lets the next CAS flush restore the scene file.
            st.flushed_mtime_ns = disk_stat.mtime_ns;
            if !matches!(
                &st.pending_fold,
                Some(p) if p.hash == hash && p.mtime_ns == disk_stat.mtime_ns
            ) {
                tracing::warn!(
                    path = %session.path,
                    "scene session reconcile refused an uncorroborated empty read"
                );
                st.pending_fold = Some(PendingFold {
                    hash,
                    mtime_ns: disk_stat.mtime_ns,
                    seen: Instant::now(),
                });
            }
            return;
        }
        if dirty || disk_text.is_empty() {
            // Divergent content into a dirty session (or a stable
            // empty read past the guards above): fold in only after
            // the observation holds unchanged for CORROBORATE_AFTER.
            let corroborated = matches!(
                &st.pending_fold,
                Some(p) if p.hash == hash
                    && p.mtime_ns == disk_stat.mtime_ns
                    && p.seen.elapsed() >= CORROBORATE_AFTER
            );
            let same_observation = matches!(
                &st.pending_fold,
                Some(p) if p.hash == hash && p.mtime_ns == disk_stat.mtime_ns
            );
            if corroborated {
                drop(st);
                session.merge_disk(disk_text, &disk_stat);
            } else if !same_observation {
                st.pending_fold = Some(PendingFold {
                    hash,
                    mtime_ns: disk_stat.mtime_ns,
                    seen: Instant::now(),
                });
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
        st.dirty_since = Some(
            Instant::now()
                .checked_sub(SCENE_FLUSH_DEBOUNCE + Duration::from_millis(50))
                .unwrap(),
        );
    }

    /// Age the pending disk observation past CORROBORATE_AFTER so the
    /// next reconcile treats it as corroborated.
    fn backdate_pending_fold(session: &Arc<SceneSession>) {
        let mut st = session.lock_state();
        let pending = st.pending_fold.as_mut().expect("a pending fold to age");
        pending.seen = Instant::now()
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
        assert!(st.dirty_since.is_some());
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
        assert!(st.dirty_since.is_none(), "discarded push leaves no dirt");
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
        assert!(st.dirty_since.is_none());
        assert!(st.flushed_mtime_ns.is_some());
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
        ha.session()
            .finish_flush(job.epoch, &stat, content_hash(&job.text));

        let st = ha.session().lock_state();
        assert!(
            st.dirty_since.is_some(),
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
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("b.excalidraw".into()),
                    to: None,
                },
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
        assert!(st.dirty_since.is_none(), "authority equals disk: clean");
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
        ha.push(vec![elem("y", 1, 1, "a2")], None, None).unwrap();
        drain(&mut rxa);

        std::fs::remove_file(fx.root.path().join("b.excalidraw")).unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Removed,
                    path: Some("b.excalidraw".into()),
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
        assert_eq!(types(&frames), ["removed"]);
        {
            let st = ha.session().lock_state();
            assert_eq!(st.flushed_mtime_ns, None);
            assert!(st.dirty_since.is_none(), "flush clock stopped");
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
        assert_eq!(ids, ["x", "y", "z"]);
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
                WatchEvent {
                    kind: WatchKind::Removed,
                    path: Some("b.excalidraw".into()),
                    to: None,
                },
            )
            .await;

        assert_eq!(drain(&mut rxa).len(), 0, "no spurious removed frame");
        let st = ha.session().lock_state();
        assert_eq!(st.flushed_mtime_ns, token, "token untouched");
        assert!(st.dirty_since.is_none(), "session stays clean");
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
                WatchEvent {
                    kind: WatchKind::Renamed,
                    path: Some("b.excalidraw".into()),
                    to: Some("c.excalidraw".into()),
                },
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
    async fn flush_cas_conflict_reconciles_and_retries() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("y", 1, 1, "a2")], None, None).unwrap();
        drain(&mut rxa);

        // Stale the session token: an external write bumps the mtime
        // and adds an element.
        fx.workspace
            .write_text(
                "b.excalidraw",
                &body(json!([elem("x", 1, 1, "a1"), elem("z", 1, 1, "a3")])),
            )
            .unwrap();
        backdate_dirty(ha.session());
        let settled = flush_session(ha.session(), &fx.workspace, &fx.self_writes).await;

        // The conflict defers to corroboration: nothing merged yet, no
        // failure fanned, the divergent observation parked.
        assert!(!settled, "deferred fold-in is not a settled flush");
        assert_eq!(drain(&mut rxa).len(), 0, "no fan while parked");
        {
            let st = ha.session().lock_state();
            assert!(st.pending_fold.is_some());
            assert_eq!(st.flush_failures, 0, "a deferral is not a failure");
        }

        // The observation holds: the aged re-check merges disk through
        // the replace semantics. The merge tombstones y (the disk body
        // is the authority and does not carry it); the accepted
        // outcome is the disk state, mirroring the doc path's
        // dirty-discard semantics on corroborated external edits.
        backdate_pending_fold(ha.session());
        fx.registry.reconcile_pending(&fx.workspace).await;
        let st = ha.session().lock_state();
        assert!(st.dirty_since.is_none());
        drop(st);
        let (text, _) = ha.session().authority_view();
        let on_session: Value = serde_json::from_str(&text).unwrap();
        let ids: Vec<&str> = on_session["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["x", "z"], "disk authority wins the conflict window");
        let frames = drain(&mut rxa);
        assert_eq!(types(&frames), ["update"], "clients hear the disk merge");
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
        assert!(st.dirty_since.is_some(), "PUT divert flushes explicitly");
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
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("b.excalidraw".into()),
                    to: None,
                },
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
            assert!(st.dirty_since.is_some(), "dirty mutation survives");
            assert!(st.pending_fold.is_some(), "observation parked");
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
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("b.excalidraw".into()),
                    to: None,
                },
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
            .note(content_hash(&seed));

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
            ha.session().lock_state().pending_fold.is_some(),
            "the restore observation remains scheduled"
        );

        tokio::time::sleep(Duration::from_millis(600)).await;
        fx.registry.reconcile_pending(&fx.workspace).await;
        let (text, _) = ha.session().authority_view();
        assert!(!text.contains("\"y\""), "the expired restore folds");
        assert_eq!(types(&drain(&mut rxa)), ["update"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_flush_does_not_poison_watcher_suppression() {
        use std::os::unix::fs::PermissionsExt;

        let fx = fixture(&[("b.excalidraw", &body(json!([])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("x", 1, 1, "a1")], None, None).unwrap();

        let root = fx.root.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o555)).unwrap();
        let ok = flush_session(ha.session(), &fx.workspace, &fx.self_writes).await;
        assert!(
            !fx.self_writes.should_suppress("b.excalidraw"),
            "a failed flush must not poison watcher suppression"
        );
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!ok, "failed write must report false");
        assert!(
            ha.session().lock_state().dirty_since.is_some(),
            "authority remains dirty"
        );
        assert!(flush_session(ha.session(), &fx.workspace, &fx.self_writes).await);
    }

    #[tokio::test]
    async fn external_edit_into_dirty_session_folds_after_corroboration() {
        let fx = fixture(&[("b.excalidraw", &body(json!([elem("x", 1, 1, "a1")])))]);
        let (ha, mut rxa) = attach(&fx, "b.excalidraw", "w1").await;
        drain(&mut rxa);
        ha.push(vec![elem("y", 1, 1, "a2")], None, None).unwrap();
        drain(&mut rxa);
        assert!(ha.session().lock_state().dirty_since.is_some());

        // A genuine external edit lands while the session is dirty:
        // not our bytes, so it must corroborate before folding in.
        fx.workspace
            .write_text(
                "b.excalidraw",
                &body(json!([elem("x", 1, 1, "a1"), elem("z", 1, 1, "a3")])),
            )
            .unwrap();
        fx.registry
            .reconcile_event(
                &fx.workspace,
                WatchEvent {
                    kind: WatchKind::Modified,
                    path: Some("b.excalidraw".into()),
                    to: None,
                },
            )
            .await;
        assert_eq!(drain(&mut rxa).len(), 0, "first observation only parks");
        assert!(ha.session().authority_view().0.contains("\"y\""));

        // The observation holds: one aged re-check merges it (the disk
        // body is the authority; y tombstones, the accepted semantics).
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
        assert_eq!(ids, ["x", "z"]);
        let frames = drain(&mut rxa);
        assert_eq!(types(&frames), ["update"], "clients hear the merge");
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
        assert!(ha.session().lock_state().pending_removal.is_some());

        std::fs::write(fx.root.path().join("b.excalidraw"), &seed).unwrap();
        reconcile_session(ha.session(), &fx.workspace).await;
        assert!(ha.session().lock_state().pending_removal.is_none());
        for f in drain(&mut rxa) {
            assert_ne!(f["type"], "removed");
        }
    }
}
