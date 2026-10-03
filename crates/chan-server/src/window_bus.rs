//! Parked SPA replies for `cs pane`, copy, paste, and export.
//!
//! The request bus owns one-shot reply senders. The export registry maps an
//! export request id to its deadlines and guarded upload state. A permit
//! enters `committing` under a short job lock, then releases that lock while
//! the workspace performs the atomic write. Retirement removes the id and
//! awaits the permit's outcome without holding either registry lock, so a
//! stalled export write cannot delay another window reply.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;
use tokio::sync::{oneshot, watch};

use crate::round_trip_bus::RoundTripBus;

pub(crate) const EXPORT_QUIET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
pub(crate) const EXPORT_ABSOLUTE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(15 * 60);

/// The `cs pane` / `cs copy` / `cs paste` / `cs export` round-trips: a
/// [`RoundTripBus`] of `win-` ids over the opaque reply payload.
pub struct WindowBus {
    requests: RoundTripBus<Value>,
    exports: Mutex<HashMap<String, Arc<ExportJob>>>,
}

struct ExportState {
    active: bool,
    committing: bool,
    committed: bool,
    failure: Option<String>,
    pages_finished: u64,
    quiet_deadline: tokio::time::Instant,
    absolute_deadline: tokio::time::Instant,
}

/// Records a guarded upload in flight without holding a lock during I/O.
/// Retirement awaits its drop and then observes its success or failure.
pub(crate) struct ExportCommitPermit<'a> {
    job: &'a ExportJob,
    settled: bool,
}

impl ExportCommitPermit<'_> {
    pub(crate) fn mark_committed(&mut self) {
        self.job.lock_state().committed = true;
        self.settled = true;
    }

    pub(crate) fn mark_failed(&mut self, error: String) {
        let mut state = self.job.lock_state();
        state.failure = Some(error);
        state.active = false;
        self.settled = true;
    }
}

impl Drop for ExportCommitPermit<'_> {
    fn drop(&mut self) {
        let mut state = self.job.lock_state();
        if !self.settled {
            state.failure = Some("guarded upload commit did not complete".into());
            state.active = false;
        }
        state.committing = false;
        drop(state);
        self.job.commit_changes.send_replace(());
    }
}

pub(crate) struct ExportJob {
    out: String,
    state: Mutex<ExportState>,
    progress: watch::Sender<Option<tokio::time::Instant>>,
    commit_changes: watch::Sender<()>,
}

impl ExportJob {
    fn lock_state(&self) -> MutexGuard<'_, ExportState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub(crate) fn begin_commit(
        &self,
        path: &str,
    ) -> chan_workspace::Result<ExportCommitPermit<'_>> {
        let mut state = self.lock_state();
        let now = tokio::time::Instant::now();
        if !state.active
            || state.committing
            || state.committed
            || self.out != path
            || now >= state.quiet_deadline
            || now >= state.absolute_deadline
        {
            return Err(chan_workspace::ChanError::Io(
                "export job retired, expired, or upload path differs".into(),
            ));
        }
        state.committing = true;
        Ok(ExportCommitPermit {
            job: self,
            settled: false,
        })
    }

    pub(crate) async fn retire(&self) -> bool {
        self.lock_state().active = false;
        self.committed_after_commit().await
    }

    async fn committed_after_commit(&self) -> bool {
        let mut changes = self.commit_changes.subscribe();
        loop {
            let settled = {
                let state = self.lock_state();
                (!state.committing).then_some(state.committed)
            };
            if let Some(committed) = settled {
                return committed;
            }
            let _ = changes.changed().await;
        }
    }

    #[cfg(test)]
    pub(crate) fn committed(&self) -> bool {
        self.lock_state().committed
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.lock_state().failure.clone()
    }

    pub(crate) fn commit_changes(&self) -> watch::Receiver<()> {
        self.commit_changes.subscribe()
    }

    pub(crate) fn deadlines(&self) -> (tokio::time::Instant, tokio::time::Instant) {
        let state = self.lock_state();
        (state.quiet_deadline, state.absolute_deadline)
    }

    fn page_finished(&self, count: u64) -> bool {
        let mut state = self.lock_state();
        let now = tokio::time::Instant::now();
        if !state.active || now >= state.quiet_deadline || now >= state.absolute_deadline {
            return false;
        }
        let advanced = count > state.pages_finished;
        if advanced {
            state.pages_finished = count;
            state.quiet_deadline = now + EXPORT_QUIET_TIMEOUT;
        }
        drop(state);
        if advanced {
            self.progress.send_replace(Some(now));
        }
        true
    }
}

impl Default for WindowBus {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowBus {
    fn lock_exports(&self) -> MutexGuard<'_, HashMap<String, Arc<ExportJob>>> {
        self.exports
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn new() -> Self {
        Self {
            requests: RoundTripBus::new("win-"),
            exports: Mutex::new(HashMap::new()),
        }
    }

    /// Park a request; see [`RoundTripBus::register`]. The handler stamps the
    /// id onto the outgoing window_command so the SPA echoes it back.
    pub fn register(&self) -> (String, oneshot::Receiver<Value>) {
        self.requests.register()
    }

    pub fn register_export(
        &self,
        out: String,
    ) -> (
        String,
        oneshot::Receiver<Value>,
        watch::Receiver<Option<tokio::time::Instant>>,
    ) {
        let (id, rx) = self.requests.register();
        let (progress, updates) = watch::channel(None);
        let (commit_changes, _) = watch::channel(());
        let now = tokio::time::Instant::now();
        self.lock_exports().insert(
            id.clone(),
            Arc::new(ExportJob {
                out,
                state: Mutex::new(ExportState {
                    active: true,
                    committing: false,
                    committed: false,
                    failure: None,
                    pages_finished: 0,
                    quiet_deadline: now + EXPORT_QUIET_TIMEOUT,
                    absolute_deadline: now + EXPORT_ABSOLUTE_TIMEOUT,
                }),
                progress,
                commit_changes,
            }),
        );
        (id, rx, updates)
    }

    pub(crate) fn export_job(&self, id: &str) -> Option<Arc<ExportJob>> {
        self.lock_exports().get(id).cloned()
    }

    pub fn page_finished(&self, id: &str, count: u64) -> bool {
        self.export_job(id)
            .is_some_and(|job| job.page_finished(count))
    }

    /// Retire the job and await an upload that already entered its commit.
    pub async fn retire_export(&self, id: &str) -> bool {
        let job = self.lock_exports().remove(id);
        self.requests.cancel(id);
        match job {
            Some(job) => job.retire().await,
            None => false,
        }
    }

    /// Compare the quiet deadline and retire under the same job lock that a
    /// page report updates, so a report accepted at the edge cannot be lost.
    pub(crate) async fn retire_export_if_quiet_elapsed(
        &self,
        id: &str,
        now: tokio::time::Instant,
    ) -> Result<bool, tokio::time::Instant> {
        let Some(job) = self.export_job(id) else {
            self.requests.cancel(id);
            return Ok(false);
        };
        {
            let mut state = job.lock_state();
            if state.active && now < state.quiet_deadline {
                return Err(state.quiet_deadline);
            }
            state.active = false;
        }
        self.lock_exports().remove(id);
        self.requests.cancel(id);
        Ok(job.committed_after_commit().await)
    }

    /// Drop a parked request without firing it; see [`RoundTripBus::cancel`].
    pub fn cancel(&self, request_id: &str) {
        self.requests.cancel(request_id)
    }

    /// Fire a parked request with the SPA's payload; see
    /// [`RoundTripBus::complete`]. `false` is what `/api/window/reply` maps
    /// to a 404.
    pub fn complete(&self, request_id: &str, payload: Value) -> bool {
        if let Some(job) = self.export_job(request_id) {
            let mut state = job.lock_state();
            let now = tokio::time::Instant::now();
            if !state.active || now >= state.quiet_deadline || now >= state.absolute_deadline {
                return false;
            }
            state.active = false;
            drop(state);
            self.lock_exports().remove(request_id);
        }
        self.requests.complete(request_id, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn win_ids_carry_the_prefix_and_round_trip_the_payload() {
        let bus = WindowBus::new();
        let (id, rx) = bus.register();
        assert!(id.starts_with("win-"), "id {id:?} lacks the win- prefix");
        assert!(bus.complete(&id, serde_json::json!({"activePaneId": "p1"})));
        let payload = rx.await.expect("payload delivered");
        assert_eq!(payload["activePaneId"], "p1");
        // The wrapper's cancel reaches the registry: a cancelled id no longer
        // completes, so the reply route answers 404, and its receiver sees the
        // sender go.
        let (cancelled, cancelled_rx) = bus.register();
        bus.cancel(&cancelled);
        assert!(!bus.complete(&cancelled, serde_json::json!({})));
        assert!(cancelled_rx.await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn accepted_page_progress_survives_coalesced_watch_updates() {
        let bus = WindowBus::new();
        let (id, _reply, _progress) = bus.register_export("a.pdf".into());
        tokio::time::advance(std::time::Duration::from_secs(80)).await;
        assert!(bus.page_finished(&id, 1));
        tokio::time::advance(std::time::Duration::from_secs(11)).await;
        assert!(bus.page_finished(&id, 2));
        assert!(matches!(
            bus.retire_export_if_quiet_elapsed(&id, tokio::time::Instant::now()).await,
            Err(deadline) if deadline > tokio::time::Instant::now()
        ));
        assert!(bus.complete(&id, serde_json::json!({ "ok": true, "out": "a.pdf" })));
    }

    #[tokio::test(start_paused = true)]
    async fn late_final_reply_does_not_cross_the_quiet_deadline() {
        let bus = WindowBus::new();
        let (id, reply, _progress) = bus.register_export("a.pdf".into());
        tokio::time::advance(EXPORT_QUIET_TIMEOUT).await;
        assert!(!bus.complete(&id, serde_json::json!({ "ok": true, "out": "a.pdf" })));
        bus.retire_export(&id).await;
        assert!(reply.await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn guarded_upload_cannot_commit_after_its_deadline() {
        let bus = WindowBus::new();
        let (id, _reply, _progress) = bus.register_export("a.pdf".into());
        let job = bus.export_job(&id).unwrap();
        tokio::time::advance(EXPORT_QUIET_TIMEOUT).await;
        assert!(job.begin_commit("a.pdf").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_bound_during_commit_does_not_delay_a_pane_reply() {
        let bus = Arc::new(WindowBus::new());
        let (export_id, _export_reply, _progress) = bus.register_export("a.pdf".into());
        let job = bus.export_job(&export_id).unwrap();
        let mut permit = job.begin_commit("a.pdf").unwrap();
        let (pane_id, pane_reply) = bus.register();
        let bound_bus = Arc::clone(&bus);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let bound = tokio::spawn(async move {
            let _ = started_tx.send(());
            bound_bus
                .retire_export_if_quiet_elapsed(
                    &export_id,
                    tokio::time::Instant::now() + EXPORT_QUIET_TIMEOUT,
                )
                .await
        });
        started_rx.await.unwrap();
        let start = std::time::Instant::now();
        while bus.exports.try_lock().is_ok()
            && start.elapsed() < std::time::Duration::from_millis(100)
        {
            tokio::task::yield_now().await;
        }
        let pane_bus = Arc::clone(&bus);
        let mut pane = tokio::task::spawn_blocking(move || {
            pane_bus.complete(&pane_id, serde_json::json!({ "activePaneId": "p1" }))
        });
        let prompt = tokio::time::timeout(std::time::Duration::from_secs(2), &mut pane).await;
        eprintln!("pane_reply_elapsed_ms={}", start.elapsed().as_millis());
        permit.mark_committed();
        drop(permit);
        let prompt_in_time = prompt.is_ok();
        let pane_completed = match prompt {
            Ok(result) => result.unwrap(),
            Err(_) => pane.await.unwrap(),
        };
        assert!(pane_completed);
        assert!(prompt_in_time, "pane reply waited for an export commit");
        assert_eq!(pane_reply.await.unwrap()["activePaneId"], "p1");
        assert_eq!(bound.await.unwrap(), Ok(true));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_retirement_during_failed_commit_answers_uncommitted() {
        let bus = Arc::new(WindowBus::new());
        let (id, _reply, _progress) = bus.register_export("a.pdf".into());
        let job = bus.export_job(&id).unwrap();
        let permit = job.begin_commit("a.pdf").unwrap();
        let retiring_bus = Arc::clone(&bus);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let retired = tokio::spawn(async move {
            let _ = started_tx.send(());
            retiring_bus.retire_export(&id).await
        });
        started_rx.await.unwrap();
        drop(permit);
        assert!(!retired.await.unwrap());
        assert!(!job.committed());
        assert!(job.begin_commit("a.pdf").is_err());
    }

    #[tokio::test]
    async fn a_failed_atomic_write_fails_the_export_commit() {
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let bus = WindowBus::new();
        let (id, _reply, _progress) = bus.register_export("a.pdf".into());
        let job = bus.export_job(&id).unwrap();
        let mut permit = None;
        let result = workspace.write_atomic_stream(
            "a.pdf",
            chan_workspace::AtomicWriteKind::Bytes,
            |sink| {
                sink.write_chunk(b"%PDF-test")?;
                permit = Some(job.begin_commit("a.pdf")?);
                Err(chan_workspace::ChanError::Io(
                    "injected before rename".into(),
                ))
            },
        );
        assert!(result.is_err());
        drop(permit);
        assert!(!root.path().join("a.pdf").exists());
        assert!(!job.committed());
        assert!(
            job.begin_commit("a.pdf").is_err(),
            "failed write must leave the job terminal"
        );
        assert!(job.failure().unwrap().contains("did not complete"));
    }

    #[test]
    fn poisoned_export_locks_are_recovered() {
        let bus = WindowBus::new();
        let (id, _reply, _progress) = bus.register_export("a.pdf".into());
        let job = bus.export_job(&id).unwrap();
        let state_poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _state = job.state.lock().unwrap();
            panic!("poison export state");
        }));
        assert!(state_poisoned.is_err());
        assert!(!job.committed());
        drop(job.begin_commit("a.pdf").unwrap());
        let map_poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _exports = bus.exports.lock().unwrap();
            panic!("poison export map");
        }));
        assert!(map_poisoned.is_err());
        assert!(bus.export_job(&id).is_some());
        assert!(!bus.complete(&id, serde_json::json!({ "ok": true, "out": "a.pdf" })));
        let (next, _reply, _progress) = bus.register_export("b.pdf".into());
        assert!(bus.complete(&next, serde_json::json!({ "ok": true, "out": "b.pdf" })));
    }
}
