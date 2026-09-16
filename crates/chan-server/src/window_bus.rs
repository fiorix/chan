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

use serde_json::Value;
use tokio::sync::oneshot;

use crate::round_trip_bus::RoundTripBus;

/// The `cs pane` / `cs copy` / `cs paste` / `cs export` round-trips: a
/// [`RoundTripBus`] of `win-` ids over the opaque reply payload.
pub struct WindowBus {
    requests: RoundTripBus<Value>,
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
        }
    }

    /// Park a request; see [`RoundTripBus::register`]. The handler stamps the
    /// id onto the outgoing window_command so the SPA echoes it back.
    pub fn register(&self) -> (String, oneshot::Receiver<Value>) {
        self.requests.register()
    }

    /// Drop a parked request without firing it; see [`RoundTripBus::cancel`].
    pub fn cancel(&self, request_id: &str) {
        self.requests.cancel(request_id)
    }

    /// Fire a parked request with the SPA's payload; see
    /// [`RoundTripBus::complete`]. `false` is what `/api/window/reply` maps
    /// to a 404.
    pub fn complete(&self, request_id: &str, payload: Value) -> bool {
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
