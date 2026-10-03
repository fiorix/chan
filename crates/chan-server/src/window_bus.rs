//! The window bus: the blocked-transport side of the `cs pane` round-trip.
//!
//! `cs pane` needs a REPLY from the SPA (the layout lives only in the
//! frontend), so the control handler cannot answer synchronously the way
//! `cs term list` does. It mirrors the `cs terminal survey` mechanism
//! (`survey.rs`) one-for-one: the handler mints a `request_id`, parks a
//! oneshot here, pushes a `pane_query` window_command carrying that id, and
//! AWAITS the oneshot. The SPA reads its `layout`, then
//! `POST /api/window/reply` deserializes the `{ requestId, payload }` body
//! and calls [`WindowBus::complete`], which fires the oneshot and unblocks
//! the handler with the payload.
//!
//! Kept on the same `Arc<WindowBus>`-on-`AppState` shape as `SurveyBus`
//! (created in `lib.rs`, passed to the control socket for the `register` +
//! `await` side, cloned onto `AppState` for the reply route's `complete`
//! side) so the two round-trip buses read identically. The reply payload is
//! an opaque `serde_json::Value` so the QUERY (returns the layout) and the
//! future EXEC ops (return a success/partial result) share one bus.

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
    committed: bool,
    pages_finished: u64,
    quiet_deadline: tokio::time::Instant,
    absolute_deadline: tokio::time::Instant,
}

/// The upload permit remains held through the atomic rename. Retirement
/// cannot claim timeout after that rename has won the race.
pub(crate) struct ExportCommitPermit<'a>(MutexGuard<'a, ExportState>);

impl ExportCommitPermit<'_> {
    pub(crate) fn mark_committed(&mut self) {
        self.0.committed = true;
    }
}

pub(crate) struct ExportJob {
    out: String,
    state: Mutex<ExportState>,
    progress: watch::Sender<Option<tokio::time::Instant>>,
}

impl ExportJob {
    pub(crate) fn begin_commit(
        &self,
        path: &str,
    ) -> chan_workspace::Result<ExportCommitPermit<'_>> {
        let state = self.state.lock().expect("export job poisoned");
        let now = tokio::time::Instant::now();
        if !state.active
            || state.committed
            || self.out != path
            || now >= state.quiet_deadline
            || now >= state.absolute_deadline
        {
            return Err(chan_workspace::ChanError::Io(
                "export job retired, expired, or upload path differs".into(),
            ));
        }
        Ok(ExportCommitPermit(state))
    }

    fn retire(&self) -> bool {
        let mut state = self.state.lock().expect("export job poisoned");
        state.active = false;
        state.committed
    }

    pub(crate) fn committed(&self) -> bool {
        self.state.lock().expect("export job poisoned").committed
    }

    pub(crate) fn deadlines(&self) -> (tokio::time::Instant, tokio::time::Instant) {
        let state = self.state.lock().expect("export job poisoned");
        (state.quiet_deadline, state.absolute_deadline)
    }

    fn page_finished(&self, count: u64) -> bool {
        let mut state = self.state.lock().expect("export job poisoned");
        let now = tokio::time::Instant::now();
        if !state.active || now >= state.quiet_deadline || now >= state.absolute_deadline {
            return false;
        }
        if count > state.pages_finished {
            state.pages_finished = count;
            state.quiet_deadline = now + EXPORT_QUIET_TIMEOUT;
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
        let now = tokio::time::Instant::now();
        self.exports.lock().expect("export jobs poisoned").insert(
            id.clone(),
            Arc::new(ExportJob {
                out,
                state: Mutex::new(ExportState {
                    active: true,
                    committed: false,
                    pages_finished: 0,
                    quiet_deadline: now + EXPORT_QUIET_TIMEOUT,
                    absolute_deadline: now + EXPORT_ABSOLUTE_TIMEOUT,
                }),
                progress,
            }),
        );
        (id, rx, updates)
    }

    pub(crate) fn export_job(&self, id: &str) -> Option<Arc<ExportJob>> {
        self.exports
            .lock()
            .expect("export jobs poisoned")
            .get(id)
            .cloned()
    }

    pub fn page_finished(&self, id: &str, count: u64) -> bool {
        self.export_job(id)
            .is_some_and(|job| job.page_finished(count))
    }

    /// Retire the job, returning whether its guarded upload already committed.
    pub fn retire_export(&self, id: &str) -> bool {
        let mut exports = self.exports.lock().expect("export jobs poisoned");
        let committed = exports.remove(id).is_some_and(|job| job.retire());
        self.requests.cancel(id);
        committed
    }

    /// Compare the quiet deadline and retire under the same job lock that a
    /// page report updates, so a report accepted at the edge cannot be lost.
    pub(crate) fn retire_export_if_quiet_elapsed(
        &self,
        id: &str,
        now: tokio::time::Instant,
    ) -> Result<bool, tokio::time::Instant> {
        let mut exports = self.exports.lock().expect("export jobs poisoned");
        let Some(job) = exports.get(id) else {
            self.requests.cancel(id);
            return Ok(false);
        };
        let mut state = job.state.lock().expect("export job poisoned");
        if state.active && now < state.quiet_deadline {
            return Err(state.quiet_deadline);
        }
        state.active = false;
        let committed = state.committed;
        drop(state);
        exports.remove(id);
        self.requests.cancel(id);
        Ok(committed)
    }

    /// Drop a parked request without firing it; see [`RoundTripBus::cancel`].
    pub fn cancel(&self, request_id: &str) {
        self.requests.cancel(request_id)
    }

    /// Fire a parked request with the SPA's payload; see
    /// [`RoundTripBus::complete`]. `false` is what `/api/window/reply` maps
    /// to a 404.
    pub fn complete(&self, request_id: &str, payload: Value) -> bool {
        let mut exports = self.exports.lock().expect("export jobs poisoned");
        if let Some(job) = exports.get(request_id) {
            let mut state = job.state.lock().expect("export job poisoned");
            let now = tokio::time::Instant::now();
            if now >= state.quiet_deadline || now >= state.absolute_deadline {
                return false;
            }
            state.active = false;
            drop(state);
            exports.remove(request_id);
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
            bus.retire_export_if_quiet_elapsed(&id, tokio::time::Instant::now()),
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
        bus.retire_export(&id);
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
        let bound = tokio::task::spawn_blocking(move || {
            let _ = started_tx.send(());
            bound_bus.retire_export_if_quiet_elapsed(
                &export_id,
                tokio::time::Instant::now() + EXPORT_QUIET_TIMEOUT,
            )
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
        let retired = tokio::task::spawn_blocking(move || {
            let _ = started_tx.send(());
            retiring_bus.retire_export(&id)
        });
        started_rx.await.unwrap();
        drop(permit);
        assert!(!retired.await.unwrap());
        assert!(!job.committed());
        assert!(job.begin_commit("a.pdf").is_err());
    }
}
