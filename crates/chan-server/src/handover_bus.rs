//! The handover bus: the blocked-transport side of `cs session handover`.
//!
//! A `cs session handover` request BLOCKS in the control socket until the
//! leader answers (in the SPA overlay, or from its own `cs session handover
//! --accept/--reject`). The control handler parks a oneshot here keyed by a
//! server-minted `request_id` and awaits it; the answer path
//! (`POST /api/session/handover/reply`, or the leader's CLI) calls
//! [`HandoverBus::complete`], which fires the oneshot and unblocks the
//! requester. The exact shape of [`crate::survey::SurveyBus`] and
//! [`crate::window_bus::WindowBus`]; a handover is single-recipient (the
//! leader) rather than fanned out, but the parked-oneshot registry is the same.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

/// The leader's answer to a handover request. Typed (not opaque) so the
/// requester's `cs session handover` prints a distinct line and exit status for
/// accept vs reject, the way `cs terminal survey` distinguishes its replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoverReply {
    Accept,
    Reject { reason: Option<String> },
}

/// A `request_id -> oneshot<HandoverReply>` registry. One entry per in-flight
/// `cs session handover`. The id is UNGUESSABLE (a random token): the answer
/// route trusts whoever echoes the id, so a predictable id would let a
/// token-bearing caller forge an accept/reject it never received the prompt for.
#[derive(Default)]
pub struct HandoverBus {
    pending: Mutex<HashMap<String, oneshot::Sender<HandoverReply>>>,
}

impl HandoverBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh `request_id`, park a oneshot under it, and return the id
    /// plus the receiver the control handler awaits. The handler stamps the id
    /// onto the leader's handover prompt so the answer echoes it back.
    ///
    /// Unused until the `cs session handover` control handler lands; drop the
    /// allow then.
    #[allow(dead_code)]
    pub fn register(&self) -> (String, oneshot::Receiver<HandoverReply>) {
        let request_id = format!("handover-{}", crate::auth::random_token());
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("handover bus poisoned")
            .insert(request_id.clone(), tx);
        (request_id, rx)
    }

    /// Drop a parked request without firing it. The control handler calls this
    /// on any early-exit path after `register` (timeout, the requester
    /// disconnecting) so an abandoned request does not leak its sender.
    ///
    /// Unused until the `cs session handover` control handler lands; drop the
    /// allow then.
    #[allow(dead_code)]
    pub fn cancel(&self, request_id: &str) {
        self.pending
            .lock()
            .expect("handover bus poisoned")
            .remove(request_id);
    }

    /// Complete a parked request: take its sender out of the map and fire the
    /// oneshot with the leader's answer. Returns `false` when no request with
    /// that id is parked (already answered, timed out, or stale), which the
    /// reply route maps to a 404.
    pub fn complete(&self, request_id: &str, reply: HandoverReply) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("handover bus poisoned")
            .remove(request_id);
        match sender {
            // `send` fails only if the receiver was dropped (the requester's CLI
            // disconnected or timed out); report that failure so the reply
            // route maps the stale response to a 404.
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_then_complete_delivers_the_reply() {
        let bus = HandoverBus::new();
        let (id, rx) = bus.register();
        assert!(bus.complete(&id, HandoverReply::Accept));
        assert_eq!(rx.await.expect("reply delivered"), HandoverReply::Accept);
    }

    #[tokio::test]
    async fn reject_carries_its_reason() {
        let bus = HandoverBus::new();
        let (id, rx) = bus.register();
        assert!(bus.complete(
            &id,
            HandoverReply::Reject {
                reason: Some("busy".into()),
            },
        ));
        assert_eq!(
            rx.await.unwrap(),
            HandoverReply::Reject {
                reason: Some("busy".into())
            }
        );
    }

    #[test]
    fn complete_unknown_request_is_false() {
        let bus = HandoverBus::new();
        assert!(!bus.complete("handover-nope", HandoverReply::Accept));
    }

    #[test]
    fn complete_after_receiver_drop_is_false() {
        let bus = HandoverBus::new();
        let (id, rx) = bus.register();
        drop(rx);
        assert!(!bus.complete(&id, HandoverReply::Accept));
    }

    #[test]
    fn each_register_mints_a_distinct_id() {
        let bus = HandoverBus::new();
        let (a, _ra) = bus.register();
        let (b, _rb) = bus.register();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn cancel_drops_the_parked_request() {
        let bus = HandoverBus::new();
        let (id, rx) = bus.register();
        bus.cancel(&id);
        assert!(!bus.complete(&id, HandoverReply::Accept));
        assert!(rx.await.is_err());
    }
}
