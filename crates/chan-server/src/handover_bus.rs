//! The handover bus: the blocked-transport side of `cs session handover`.
//!
//! A `cs session handover` request BLOCKS in the control socket until the
//! leader answers (in the SPA overlay, or from its own `cs session handover
//! --accept/--reject`). The control handler parks a oneshot here keyed by a
//! server-minted `request_id` and awaits it; the answer path
//! (`POST /api/session/handover/reply`, or the leader's CLI) calls
//! [`HandoverBus::complete`], which fires the oneshot and unblocks the
//! requester. A handover is single-recipient (the leader) rather than fanned
//! out like a survey, but the parked-oneshot registry is the same
//! [`RoundTripBus`] that [`crate::survey::SurveyBus`] and
//! [`crate::window_bus::WindowBus`] wrap.

use tokio::sync::oneshot;

use crate::round_trip_bus::RoundTripBus;

/// The leader's answer to a handover request. Typed (not opaque) so the
/// requester's `cs session handover` prints a distinct line and exit status for
/// accept vs reject, the way `cs terminal survey` distinguishes its replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoverReply {
    Accept,
    Reject { reason: Option<String> },
}

/// The `cs session handover` round-trips: a [`RoundTripBus`] of `handover-`
/// ids over the typed [`HandoverReply`].
pub struct HandoverBus {
    requests: RoundTripBus<HandoverReply>,
}

impl Default for HandoverBus {
    fn default() -> Self {
        Self::new()
    }
}

impl HandoverBus {
    pub fn new() -> Self {
        Self {
            requests: RoundTripBus::new("handover-"),
        }
    }

    /// Park a request; see [`RoundTripBus::register`]. The handler stamps the
    /// id onto the leader's handover prompt so the answer echoes it back.
    pub fn register(&self) -> (String, oneshot::Receiver<HandoverReply>) {
        self.requests.register()
    }

    /// Drop a parked request without firing it (timeout, the requester
    /// disconnecting); see [`RoundTripBus::cancel`].
    pub fn cancel(&self, request_id: &str) {
        self.requests.cancel(request_id)
    }

    /// Fire a parked request with the leader's answer; see
    /// [`RoundTripBus::complete`]. `false` is what the reply route maps to a
    /// 404.
    pub fn complete(&self, request_id: &str, reply: HandoverReply) -> bool {
        self.requests.complete(request_id, reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handover_ids_carry_the_prefix_and_round_trip_an_accept() {
        let bus = HandoverBus::new();
        let (id, rx) = bus.register();
        assert!(
            id.starts_with("handover-"),
            "id {id:?} lacks the handover- prefix"
        );
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
}
