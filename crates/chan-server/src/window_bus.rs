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

/// The `cs pane` / `cs copy` / `cs paste` / `cs export` round-trips: a
/// [`RoundTripBus`] of `win-` ids over the opaque reply payload.
pub struct WindowBus {
    requests: RoundTripBus<Value>,
    exports: Mutex<HashMap<String, Arc<ExportJob>>>,
}

struct ExportState {
    active: bool,
    committed: bool,
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
        if !state.active || state.committed || self.out != path {
            return Err(chan_workspace::ChanError::Io(
                "export job retired or upload path differs".into(),
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

    fn page_finished(&self) -> bool {
        let state = self.state.lock().expect("export job poisoned");
        if !state.active {
            return false;
        }
        self.progress
            .send_replace(Some(tokio::time::Instant::now()));
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
        self.exports.lock().expect("export jobs poisoned").insert(
            id.clone(),
            Arc::new(ExportJob {
                out,
                state: Mutex::new(ExportState {
                    active: true,
                    committed: false,
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

    pub fn page_finished(&self, id: &str) -> bool {
        self.export_job(id).is_some_and(|job| job.page_finished())
    }

    /// Retire the job, returning whether its guarded upload already committed.
    pub fn retire_export(&self, id: &str) -> bool {
        let mut exports = self.exports.lock().expect("export jobs poisoned");
        let committed = exports.remove(id).is_some_and(|job| job.retire());
        self.requests.cancel(id);
        committed
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
        if let Some(job) = exports.remove(request_id) {
            job.retire();
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
}
