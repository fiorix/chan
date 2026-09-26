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
//! (reply, timeout, cancellation, or EOF from an opted-in client), promoting
//! the next survey in arrival order.
//!
//! And the bus records which surveys are open: for each overlay the handler
//! has pushed and not yet closed, the windows it went to, the tab it targets
//! and its spec. `open_survey` and `close_survey` ride the `/ws` broadcast
//! once each, so a window whose socket was down when one went out never gets
//! it; the `/ws` attach sends that window the record instead (`survey_sync`),
//! the whole set of surveys the server still waits on there. The handler
//! holds an [`OpenSurveyGuard`] from before the open push until before the
//! close push, so no exit path leaves a closed survey in the record, and no
//! window synced from it can raise a survey whose close it was not
//! subscribed for.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chan_shell::{SurveyReply, SurveySpec};
use tokio::sync::oneshot;

use crate::round_trip_bus::RoundTripBus;

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
/// while queued, push failure, or EOF from an opted-in client) releases the
/// target.
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

/// One survey whose overlay is up: the windows its `open_survey` went to, the
/// tab it targets (`None` for a group survey, which takes the window-wide
/// slot) and the spec as pushed, id stamped.
struct OpenSurvey {
    windows: Vec<String>,
    tab_name: Option<String>,
    spec: SurveySpec,
}

/// RAII record of one open survey. Dropping it takes the survey out of what
/// [`SurveyBus::open_for_window`] reports, so every exit of the blocked
/// handler (reply, sender dropped, client EOF, deadline, a failed push, or the
/// handler's future dropped) leaves the record.
pub(crate) struct OpenSurveyGuard<'a> {
    bus: &'a SurveyBus,
    survey_id: String,
}

impl Drop for OpenSurveyGuard<'_> {
    fn drop(&mut self) {
        self.bus.forget_open(&self.survey_id);
    }
}

/// The `cs terminal survey` round-trips: a [`RoundTripBus`] of `survey-` ids
/// over the [`SurveyReplyEnvelope`], the per-target FIFO that serializes the
/// surveys addressed to one overlay slot, and the record of open surveys.
pub struct SurveyBus {
    pending: RoundTripBus<SurveyReplyEnvelope>,
    /// Per-target FIFOs keyed by [`SurveyQueueKey`]. The front entry is the
    /// survey currently allowed to be open; the rest wait in arrival order.
    /// An emptied queue is removed so keys do not accumulate.
    queues: Mutex<HashMap<SurveyQueueKey, VecDeque<QueuedTurn>>>,
    /// Monotonic ticket source distinguishing entries within one queue.
    next_ticket: AtomicU64,
    /// The surveys whose overlay is up, in the order they opened. At most
    /// one per target, since only a turn's holder opens, so a scan is cheap.
    open: Mutex<Vec<OpenSurvey>>,
}

/// What a completed survey delivers to the blocked control handler: the reply
/// plus the id of the window that answered (when the SPA reports it), so the
/// handler can exclude that window from the stale-overlay close fan-out. A
/// window answering its own survey already dismissed its overlay locally, so
/// re-closing it there only races that clear. `None` for the window id keeps
/// the pre-report behavior (fan the close to every target).
pub type SurveyReplyEnvelope = (SurveyReply, Option<String>);

impl Default for SurveyBus {
    fn default() -> Self {
        Self::new()
    }
}

impl SurveyBus {
    pub fn new() -> Self {
        Self {
            pending: RoundTripBus::new("survey-"),
            queues: Mutex::new(HashMap::new()),
            next_ticket: AtomicU64::new(0),
            open: Mutex::new(Vec::new()),
        }
    }

    /// Record `spec` (its id already stamped) as open in `windows` for
    /// `tab_name` until the returned guard drops. The handler takes it before
    /// it pushes `open_survey`, so a window that attaches too late for that
    /// push is synced the survey instead, and drops it before it pushes
    /// `close_survey`, so a window that attaches too late for the close is
    /// synced without it.
    pub(crate) fn record_open(
        &self,
        windows: &[String],
        tab_name: Option<&str>,
        spec: &SurveySpec,
    ) -> OpenSurveyGuard<'_> {
        self.open
            .lock()
            .expect("open surveys poisoned")
            .push(OpenSurvey {
                windows: windows.to_vec(),
                tab_name: tab_name.map(str::to_string),
                spec: spec.clone(),
            });
        OpenSurveyGuard {
            bus: self,
            survey_id: spec.survey_id.clone(),
        }
    }

    /// The surveys open in `window_id`, oldest first, each as the spec its
    /// `open_survey` carried and the tab it targets: what a `survey_sync` for
    /// that window lists.
    pub(crate) fn open_for_window(&self, window_id: &str) -> Vec<(SurveySpec, Option<String>)> {
        self.open
            .lock()
            .expect("open surveys poisoned")
            .iter()
            .filter(|open| open.windows.iter().any(|window| window == window_id))
            .map(|open| (open.spec.clone(), open.tab_name.clone()))
            .collect()
    }

    /// Remove one open survey (the [`OpenSurveyGuard`] drop path).
    fn forget_open(&self, survey_id: &str) {
        // Guard drop keeps the record's cleanup available after a panicking
        // writer, like `finish_turn`.
        self.open
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|open| open.spec.survey_id != survey_id);
    }

    /// Park a survey; see [`RoundTripBus::register`]. The handler stamps the
    /// id onto the outgoing [`chan_shell::SurveySpec`] so the SPA echoes it
    /// back in its reply.
    pub fn register(&self) -> (String, oneshot::Receiver<SurveyReplyEnvelope>) {
        self.pending.register()
    }

    /// Drop a parked survey without firing it; see [`RoundTripBus::cancel`].
    pub fn cancel(&self, survey_id: &str) {
        self.pending.cancel(survey_id)
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
        // Guard drop keeps queue cleanup available after a panicking writer;
        // recover and continue from the queue state it left.
        let mut queues = self
            .queues
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
        self.pending.complete(survey_id, (reply, answered_by))
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

    #[tokio::test]
    async fn survey_ids_carry_the_prefix() {
        let bus = SurveyBus::new();
        let (id, _rx) = bus.register();
        assert!(
            id.starts_with("survey-"),
            "id {id:?} lacks the survey- prefix"
        );
        // The wrapper's cancel reaches the registry: a cancelled id no longer
        // completes, so the reply route answers 404, and its receiver sees the
        // sender go.
        let (cancelled, cancelled_rx) = bus.register();
        bus.cancel(&cancelled);
        assert!(!bus.complete_survey(
            &cancelled,
            SurveyReply::Option {
                survey_id: cancelled.clone(),
                option_index: 0,
                option_label: "Yes".into(),
            },
            None,
        ));
        assert!(cancelled_rx.await.is_err());
    }

    fn spec(survey_id: &str) -> SurveySpec {
        SurveySpec {
            survey_id: survey_id.into(),
            title: None,
            body_markdown: format!("body of {survey_id}"),
            options: vec!["ok".into()],
        }
    }

    fn open_ids(bus: &SurveyBus, window_id: &str) -> Vec<(String, Option<String>)> {
        bus.open_for_window(window_id)
            .into_iter()
            .map(|(spec, tab_name)| (spec.survey_id, tab_name))
            .collect()
    }

    #[test]
    fn open_surveys_are_listed_per_window_oldest_first_until_their_guard_drops() {
        let bus = SurveyBus::new();
        let windows = |ids: &[&str]| ids.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        let tab = bus.record_open(&windows(&["win-a"]), Some("@@T"), &spec("survey-1"));
        let group = bus.record_open(&windows(&["win-a", "win-b"]), None, &spec("survey-2"));

        assert_eq!(
            open_ids(&bus, "win-a"),
            vec![
                ("survey-1".to_string(), Some("@@T".to_string())),
                ("survey-2".to_string(), None),
            ],
            "win-a holds both, in the order they opened"
        );
        assert_eq!(
            open_ids(&bus, "win-b"),
            vec![("survey-2".to_string(), None)]
        );
        assert!(
            open_ids(&bus, "win-c").is_empty(),
            "no survey targets win-c"
        );
        let listed = bus.open_for_window("win-b");
        assert_eq!(listed[0].0.body_markdown, "body of survey-2");

        // Whatever ended it (reply, cancel, deadline, a dropped handler), the
        // guard's drop is what takes a survey out of later syncs, and only
        // that survey.
        drop(tab);
        assert_eq!(
            open_ids(&bus, "win-a"),
            vec![("survey-2".to_string(), None)]
        );
        drop(group);
        assert!(open_ids(&bus, "win-a").is_empty());
        assert!(open_ids(&bus, "win-b").is_empty());
        assert!(bus.open.lock().unwrap().is_empty(), "no record leaks");
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
