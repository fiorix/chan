//! The parked-oneshot registry behind every blocked control-socket round-trip.
//!
//! `cs terminal survey`, the `cs pane` family (`cs pane`, `cs copy`, `cs
//! paste`, `cs export`) and `cs session handover` all block in the control
//! socket until a window answers over HTTP: the handler mints an id, parks a
//! oneshot here, pushes a frame carrying the id to the window, and awaits the
//! receiver; the reply route echoes the id and calls
//! [`RoundTripBus::complete`], which fires the oneshot. [`crate::survey::SurveyBus`],
//! [`crate::window_bus::WindowBus`] and [`crate::handover_bus::HandoverBus`]
//! each wrap one of these with their own id prefix and reply type.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

/// An `id -> oneshot<T>` registry, one entry per in-flight round-trip. The id
/// is UNGUESSABLE (a random token behind a fixed prefix, not a monotonic
/// counter): the reply route trusts whoever echoes the id, and the frame that
/// carries it is delivered only to the target window's socket, so a
/// predictable id would let a token-bearing caller that never saw the frame
/// forge the reply (answer a survey it never saw, accept a handover it was
/// never prompted for, or inject bytes into a blocked `cs paste > file`).
pub(crate) struct RoundTripBus<T> {
    /// Fixed per-bus id prefix. The SPA and `cs` echo ids verbatim and never
    /// parse them, so the prefix only keeps the buses' ids legible and apart.
    prefix: &'static str,
    pending: Mutex<HashMap<String, oneshot::Sender<T>>>,
}

impl<T> RoundTripBus<T> {
    pub(crate) fn new(prefix: &'static str) -> Self {
        Self {
            prefix,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Mint a fresh random id, park a oneshot under it, and return the id plus
    /// the receiver the control handler awaits. The handler stamps the id onto
    /// the outgoing frame so the window echoes it back in its reply.
    pub(crate) fn register(&self) -> (String, oneshot::Receiver<T>) {
        let id = format!("{}{}", self.prefix, crate::auth::random_token());
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("round-trip bus poisoned")
            .insert(id.clone(), tx);
        (id, rx)
    }

    /// Drop a parked round-trip without firing it. The control handler calls
    /// this on every early-exit path after `register` (the frame failed to
    /// send, no reply arrived in time, the requester disconnected) so an
    /// abandoned entry does not leak its sender.
    pub(crate) fn cancel(&self, id: &str) {
        self.pending
            .lock()
            .expect("round-trip bus poisoned")
            .remove(id);
    }

    /// Complete a parked round-trip: take its sender out of the map and fire
    /// the oneshot with the reply. Returns `false` when no entry with that id
    /// is parked (already answered, cancelled, or a stale id) and when the
    /// receiver is gone (the CLI disconnected before the reply), so the reply
    /// route maps both to a 404.
    pub(crate) fn complete(&self, id: &str, reply: T) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("round-trip bus poisoned")
            .remove(id);
        match sender {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_then_complete_delivers_the_payload() {
        let bus = RoundTripBus::new("rt-");
        let (id, rx) = bus.register();
        assert!(bus.complete(&id, 7u8));
        assert_eq!(rx.await.expect("payload delivered"), 7);
    }

    #[test]
    fn complete_unknown_id_is_false() {
        let bus = RoundTripBus::<u8>::new("rt-");
        assert!(!bus.complete("rt-nope", 0));
    }

    #[test]
    fn a_completed_id_cannot_be_completed_again() {
        let bus = RoundTripBus::new("rt-");
        let (id, _rx) = bus.register();
        assert!(bus.complete(&id, 1u8));
        assert!(!bus.complete(&id, 2u8));
    }

    #[test]
    fn complete_after_receiver_drop_is_false() {
        let bus = RoundTripBus::new("rt-");
        let (id, rx) = bus.register();
        drop(rx);
        assert!(!bus.complete(&id, 0u8));
    }

    #[test]
    fn each_register_mints_a_distinct_id() {
        let bus = RoundTripBus::<u8>::new("rt-");
        let (a, _ra) = bus.register();
        let (b, _rb) = bus.register();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn cancel_drops_the_parked_request() {
        let bus = RoundTripBus::new("rt-");
        let (id, rx) = bus.register();
        bus.cancel(&id);
        assert!(!bus.complete(&id, 0u8));
        assert!(rx.await.is_err());
    }

    #[test]
    fn ids_carry_the_configured_prefix() {
        let bus = RoundTripBus::<u8>::new("rt-");
        let (id, _rx) = bus.register();
        assert!(id.starts_with("rt-"), "id {id:?} lacks the rt- prefix");
        assert!(id.len() > "rt-".len(), "id {id:?} carries no token");
    }
}
