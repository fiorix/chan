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
use std::sync::Mutex;

use serde_json::Value;
use tokio::sync::oneshot;

/// A `request_id -> oneshot<Value>` registry. One entry per in-flight `cs
/// pane` / `cs paste` round-trip. The id is UNGUESSABLE (a random token, not a
/// monotonic counter): the reply route (`POST /api/window/reply`) trusts
/// whoever echoes the id, and the command is delivered only to the target
/// window's socket, so a predictable id would let a token-bearing caller that
/// never saw the command forge the reply (e.g. inject bytes into a blocked
/// `cs paste > file`).
#[derive(Default)]
pub struct WindowBus {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl WindowBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh random `request_id`, park a oneshot under it, and return
    /// the id plus the receiver the control handler awaits. The handler stamps
    /// the id onto the outgoing window_command so the SPA echoes it back in its
    /// reply.
    pub fn register(&self) -> (String, oneshot::Receiver<Value>) {
        let request_id = format!("win-{}", crate::auth::random_token());
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("window bus poisoned")
            .insert(request_id.clone(), tx);
        (request_id, rx)
    }

    /// Drop a parked request without firing it. The control handler calls
    /// this on any early-exit path after `register` (e.g. the window_command
    /// failed to send, or no reply arrived) so an abandoned request does not
    /// leak its sender.
    pub fn cancel(&self, request_id: &str) {
        self.pending
            .lock()
            .expect("window bus poisoned")
            .remove(request_id);
    }

    /// Complete a parked request: take its sender out of the map and fire
    /// the oneshot with the SPA's payload. Returns `false` when no request
    /// with that id is parked (already answered, or a stale id), which the
    /// `/api/window/reply` route maps to a 404.
    pub fn complete(&self, request_id: &str, payload: Value) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("window bus poisoned")
            .remove(request_id);
        match sender {
            // `send` fails only if the receiver was dropped (the CLI
            // disconnected); report that failure so the reply route maps
            // the stale response to a 404.
            Some(tx) => tx.send(payload).is_ok(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_then_complete_delivers_the_payload() {
        let bus = WindowBus::new();
        let (id, rx) = bus.register();
        assert!(bus.complete(&id, serde_json::json!({"activePaneId": "p1"})));
        let payload = rx.await.expect("payload delivered");
        assert_eq!(payload["activePaneId"], "p1");
    }

    #[test]
    fn complete_unknown_request_is_false() {
        let bus = WindowBus::new();
        assert!(!bus.complete("win-nope", serde_json::json!({})));
    }

    #[test]
    fn complete_after_receiver_drop_is_false() {
        let bus = WindowBus::new();
        let (id, rx) = bus.register();
        drop(rx);
        assert!(!bus.complete(&id, serde_json::json!({})));
    }

    #[test]
    fn each_register_mints_a_distinct_id() {
        let bus = WindowBus::new();
        let (a, _ra) = bus.register();
        let (b, _rb) = bus.register();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn cancel_drops_the_parked_request() {
        let bus = WindowBus::new();
        let (id, rx) = bus.register();
        bus.cancel(&id);
        assert!(!bus.complete(&id, serde_json::json!({})));
        assert!(rx.await.is_err());
    }
}
