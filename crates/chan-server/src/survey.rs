//! The survey bus: the blocked-transport side of `cs terminal survey`.
//!
//! A `cs terminal survey` call BLOCKS in the control socket until the user
//! answers in the SPA. The control handler parks a oneshot here keyed by a
//! server-minted `survey_id` and awaits it; the SPA's reply route
//! (`POST /api/survey/reply`) deserializes the [`SurveyReply`] and calls
//! [`SurveyBus::complete_survey`], which fires the oneshot and unblocks the
//! handler. Keeping the bus and the reply route on the two ends of one
//! stable `complete_survey` API keeps their coupling narrow.
//!
//! The bus also owns the per-target survey FIFO: the SPA holds ONE overlay
//! slot per terminal tab (plus one window-wide slot), so at most one survey
//! may be OPEN per target at a time. [`SurveyBus::enqueue_turn`] admits the
//! first survey for a target immediately and parks later ones in a bounded
//! [`VecDeque`]; each caller's [`SurveyTurnGuard`] releases its slot on drop
//! (reply, timeout, cancel, or a dropped connection), promoting the next
//! survey in arrival order.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chan_shell::SurveyReply;
use tokio::sync::oneshot;

/// How many surveys one target can hold at a time: the open one plus the
/// waiters. A new survey past the cap is refused with an explicit queue-full
/// response, never a silent drop. Mirrors the `cs terminal write` FIFO bound
/// (`WRITE_QUEUE_CAP` in chan-library's terminal_sessions).
pub(crate) const SURVEY_QUEUE_CAP: usize = 100;

/// What one survey serializes on: the resolved target window ids (sorted, so
/// registry iteration order cannot split one target into distinct keys) plus
/// the tab selector. The key matches the SPA's overlay slots: a tab-addressed
/// survey occupies that tab's slot in each owning window, and a group survey
/// (no tab name) occupies the window-wide slot, so two surveys with the same
/// key would collide in one slot and must run one at a time.
pub(crate) type SurveyQueueKey = (Vec<String>, Option<String>);

/// Build the [`SurveyQueueKey`] for a survey resolved to `windows` and
/// addressed with `tab_name` (`None` for a group survey).
pub(crate) fn survey_queue_key(windows: &[String], tab_name: Option<&str>) -> SurveyQueueKey {
    let mut windows = windows.to_vec();
    windows.sort();
    (windows, tab_name.map(str::to_string))
}

/// One survey's place in a target's FIFO. `turn_tx` is `Some` while the
/// survey waits its turn and `None` once it is (or was admitted as) the
/// head; firing it tells the parked handler to push its overlay.
struct QueuedTurn {
    ticket: u64,
    turn_tx: Option<oneshot::Sender<()>>,
}

/// The FIFO's answer to a survey asking to run against a target.
pub(crate) enum SurveyTurn<'a> {
    /// The target was idle: the survey is the head and may open now.
    Ready(SurveyTurnGuard<'a>),
    /// Parked behind earlier surveys: the receiver fires when the survey
    /// reaches the head. The caller bounds the wait with its own deadline;
    /// dropping the guard (without ever opening) leaves the queue cleanly.
    Wait(SurveyTurnGuard<'a>, oneshot::Receiver<()>),
    /// The target already holds [`SURVEY_QUEUE_CAP`] surveys; nothing was
    /// enqueued.
    Full,
}

/// RAII slot in a target's survey FIFO. Dropping it removes the entry and,
/// when the entry was the head, promotes the next survey in line, so every
/// exit path of the blocked handler (reply, timeout while open, timeout
/// while queued, push failure, a dropped connection) releases the target.
pub(crate) struct SurveyTurnGuard<'a> {
    bus: &'a SurveyBus,
    key: SurveyQueueKey,
    ticket: u64,
}

impl Drop for SurveyTurnGuard<'_> {
    fn drop(&mut self) {
        self.bus.finish_turn(&self.key, self.ticket);
    }
}

/// A `survey_id -> oneshot<SurveyReply>` registry. One entry per in-flight
/// `cs terminal survey`. The id is UNGUESSABLE (a random token): the SPA's
/// reply route trusts whoever echoes the id, so a predictable id would let a
/// token-bearing caller forge an answer to a survey it never saw.
#[derive(Default)]
pub struct SurveyBus {
    pending: Mutex<HashMap<String, oneshot::Sender<SurveyReplyEnvelope>>>,
    /// Per-target FIFOs keyed by [`SurveyQueueKey`]. The front entry is the
    /// survey currently allowed to be open; the rest wait in arrival order.
    /// An emptied queue is removed so keys do not accumulate.
    queues: Mutex<HashMap<SurveyQueueKey, VecDeque<QueuedTurn>>>,
    /// Monotonic ticket source distinguishing entries within one queue.
    next_ticket: AtomicU64,
}

/// What a completed survey delivers to the blocked control handler: the reply
/// plus the id of the window that answered (when the SPA reports it), so the
/// handler can exclude that window from the stale-overlay close fan-out. A
/// window answering its own survey already dismissed its overlay locally, so
/// re-closing it there only races that clear. `None` for the window id keeps
/// the pre-report behavior (fan the close to every target).
pub type SurveyReplyEnvelope = (SurveyReply, Option<String>);

impl SurveyBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh `survey_id`, park a oneshot under it, and return the id
    /// plus the receiver the control handler awaits. The handler stamps the
    /// id onto the outgoing [`chan_shell::SurveySpec`] so the SPA echoes it
    /// back in its reply.
    pub fn register(&self) -> (String, oneshot::Receiver<SurveyReplyEnvelope>) {
        let survey_id = format!("survey-{}", crate::auth::random_token());
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("survey bus poisoned")
            .insert(survey_id.clone(), tx);
        (survey_id, rx)
    }

    /// Drop a parked survey without firing it. The control handler calls
    /// this on any early-exit path after `register` so an abandoned survey
    /// does not leak its sender.
    pub fn cancel(&self, survey_id: &str) {
        self.pending
            .lock()
            .expect("survey bus poisoned")
            .remove(survey_id);
    }

    /// Ask for a turn against `key`'s target. The first survey per target is
    /// admitted immediately ([`SurveyTurn::Ready`]); later ones park in the
    /// FIFO ([`SurveyTurn::Wait`]) until every earlier survey's guard drops;
    /// a target already at [`SURVEY_QUEUE_CAP`] refuses outright
    /// ([`SurveyTurn::Full`], queue unchanged).
    pub(crate) fn enqueue_turn(&self, key: SurveyQueueKey) -> SurveyTurn<'_> {
        let ticket = self.next_ticket.fetch_add(1, Ordering::Relaxed);
        let mut queues = self.queues.lock().expect("survey queues poisoned");
        let queue = queues.entry(key.clone()).or_default();
        if queue.len() >= SURVEY_QUEUE_CAP {
            return SurveyTurn::Full;
        }
        if queue.is_empty() {
            queue.push_back(QueuedTurn {
                ticket,
                turn_tx: None,
            });
            drop(queues);
            SurveyTurn::Ready(SurveyTurnGuard {
                bus: self,
                key,
                ticket,
            })
        } else {
            let (tx, rx) = oneshot::channel();
            queue.push_back(QueuedTurn {
                ticket,
                turn_tx: Some(tx),
            });
            drop(queues);
            SurveyTurn::Wait(
                SurveyTurnGuard {
                    bus: self,
                    key,
                    ticket,
                },
                rx,
            )
        }
    }

    /// Release one turn (the [`SurveyTurnGuard`] drop path): remove the entry
    /// wherever it sits (front when its survey ran or is next, mid-queue when
    /// a QUEUED survey timed out) and, when the front was removed, fire the
    /// new head's turn. A fire that finds the receiver already dropped (that
    /// waiter timed out concurrently) is ignored: the waiter's own guard drop
    /// lands here next and promotes its successor, so the queue never stalls.
    fn finish_turn(&self, key: &SurveyQueueKey, ticket: u64) {
        let mut queues = self.queues.lock().expect("survey queues poisoned");
        let Some(queue) = queues.get_mut(key) else {
            return;
        };
        let Some(pos) = queue.iter().position(|turn| turn.ticket == ticket) else {
            return;
        };
        queue.remove(pos);
        if pos == 0 {
            if let Some(next) = queue.front_mut() {
                if let Some(tx) = next.turn_tx.take() {
                    let _ = tx.send(());
                }
            }
        }
        if queue.is_empty() {
            queues.remove(key);
        }
    }

    /// Complete a parked survey: take its sender out of the map and fire the
    /// oneshot with the reply and `answered_by` (the answering window's id, or
    /// `None` when the SPA does not report it). Returns `false` when no survey
    /// with that id is parked (it was already answered, or the id is stale),
    /// which the reply route maps to a 404. C's `POST /api/survey/reply` is the
    /// only caller.
    pub fn complete_survey(
        &self,
        survey_id: &str,
        reply: SurveyReply,
        answered_by: Option<String>,
    ) -> bool {
        let sender = self
            .pending
            .lock()
            .expect("survey bus poisoned")
            .remove(survey_id);
        match sender {
            // `send` fails only if the receiver was dropped (the CLI
            // disconnected); the survey is gone either way, so report it
            // delivered to keep the route idempotent from C's side.
            Some(tx) => tx.send((reply, answered_by)).is_ok(),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_then_complete_delivers_the_reply() {
        let bus = SurveyBus::new();
        let (id, rx) = bus.register();
        assert!(bus.complete_survey(
            &id,
            SurveyReply::Option {
                survey_id: id.clone(),
                option_index: 1,
                option_label: "Yes".into(),
            },
            Some("win-a".into()),
        ));
        // The reply and the answering window round-trip to the handler.
        match rx.await.expect("reply delivered") {
            (SurveyReply::Option { option_label, .. }, answered_by) => {
                assert_eq!(option_label, "Yes");
                assert_eq!(answered_by.as_deref(), Some("win-a"));
            }
            other => panic!("unexpected reply: {other:?}"),
        }
    }

    #[test]
    fn complete_unknown_survey_is_false() {
        let bus = SurveyBus::new();
        assert!(!bus.complete_survey(
            "survey-nope",
            SurveyReply::Followup {
                survey_id: "survey-nope".into(),
            },
            None,
        ));
    }

    #[test]
    fn each_register_mints_a_distinct_id() {
        let bus = SurveyBus::new();
        let (a, _ra) = bus.register();
        let (b, _rb) = bus.register();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn cancel_drops_the_parked_survey() {
        let bus = SurveyBus::new();
        let (id, rx) = bus.register();
        bus.cancel(&id);
        // A cancelled survey no longer matches, and its receiver observes
        // the dropped sender.
        assert!(!bus.complete_survey(
            &id,
            SurveyReply::Option {
                survey_id: id.clone(),
                option_index: 0,
                option_label: "x".into(),
            },
            None,
        ));
        assert!(rx.await.is_err());
    }

    fn key(windows: &[&str], tab: Option<&str>) -> SurveyQueueKey {
        let windows: Vec<String> = windows.iter().map(|w| w.to_string()).collect();
        survey_queue_key(&windows, tab)
    }

    #[test]
    fn survey_queue_key_sorts_windows_so_iteration_order_cannot_split_a_target() {
        assert_eq!(
            key(&["win-b", "win-a"], Some("@@T")),
            key(&["win-a", "win-b"], Some("@@T")),
        );
        // Distinct tabs (and the group survey's window-wide slot) key apart.
        assert_ne!(key(&["win-a"], Some("@@T")), key(&["win-a"], Some("@@U")));
        assert_ne!(key(&["win-a"], Some("@@T")), key(&["win-a"], None));
    }

    #[test]
    fn enqueue_turn_serializes_a_target_in_arrival_order() {
        let bus = SurveyBus::new();
        let k = key(&["win-a"], Some("@@T"));

        // First in: the target is idle, so it runs immediately.
        let first = match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Ready(guard) => guard,
            _ => panic!("first survey must be admitted immediately"),
        };
        // Second and third park behind it.
        let (second, mut second_rx) = match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Wait(guard, rx) => (guard, rx),
            _ => panic!("second survey must wait"),
        };
        let (third, mut third_rx) = match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Wait(guard, rx) => (guard, rx),
            _ => panic!("third survey must wait"),
        };
        assert!(second_rx.try_recv().is_err(), "no turn while first is open");

        // A DIFFERENT target is untouched by this queue.
        assert!(matches!(
            bus.enqueue_turn(key(&["win-a"], Some("@@U"))),
            SurveyTurn::Ready(_)
        ));

        // First resolves: exactly the second is promoted, in order.
        drop(first);
        assert!(second_rx.try_recv().is_ok(), "second promoted after first");
        assert!(third_rx.try_recv().is_err(), "third still waits");
        drop(second);
        assert!(third_rx.try_recv().is_ok(), "third promoted after second");
        drop(third);

        // The emptied queue is removed, so a fresh survey is Ready again.
        assert!(bus.queues.lock().unwrap().is_empty(), "no key leak");
        assert!(matches!(bus.enqueue_turn(k), SurveyTurn::Ready(_)));
    }

    #[test]
    fn dropping_a_queued_turn_leaves_the_queue_without_blocking_successors() {
        let bus = SurveyBus::new();
        let k = key(&["win-a"], Some("@@T"));

        let first = match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Ready(guard) => guard,
            _ => panic!("first survey must be admitted immediately"),
        };
        let (second, second_rx) = match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Wait(guard, rx) => (guard, rx),
            _ => panic!("second survey must wait"),
        };
        let (third, mut third_rx) = match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Wait(guard, rx) => (guard, rx),
            _ => panic!("third survey must wait"),
        };

        // The QUEUED second times out: dropping its receiver + guard removes
        // it mid-queue; the head is untouched and no ghost blocks the third.
        drop(second_rx);
        drop(second);
        drop(first);
        assert!(
            third_rx.try_recv().is_ok(),
            "third promoted straight past the vacated second"
        );
        drop(third);
        assert!(bus.queues.lock().unwrap().is_empty(), "no key leak");
    }

    #[test]
    fn enqueue_turn_refuses_a_full_target_and_recovers_when_one_resolves() {
        let bus = SurveyBus::new();
        let k = key(&["win-a"], Some("@@T"));

        // Fill the target to the cap: one open survey + waiters.
        let mut held = Vec::new();
        match bus.enqueue_turn(k.clone()) {
            SurveyTurn::Ready(guard) => held.push((guard, None)),
            _ => panic!("first survey must be admitted immediately"),
        }
        for n in 1..SURVEY_QUEUE_CAP {
            match bus.enqueue_turn(k.clone()) {
                SurveyTurn::Wait(guard, rx) => held.push((guard, Some(rx))),
                _ => panic!("survey {n} must wait"),
            }
        }

        // Past the cap: refused outright, all-or-nothing (queue unchanged).
        assert!(matches!(bus.enqueue_turn(k.clone()), SurveyTurn::Full));
        assert_eq!(
            bus.queues.lock().unwrap().get(&k).map(|q| q.len()),
            Some(SURVEY_QUEUE_CAP),
            "a refused survey must not grow the queue"
        );

        // One slot frees; the target admits a waiter again.
        drop(held.pop());
        assert!(matches!(bus.enqueue_turn(k), SurveyTurn::Wait(..)));
    }
}
