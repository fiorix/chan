//! Reader credit held by WebSockets whose client acknowledges parsed output.
//!
//! A completed socket send proves nothing about a stalled page: WebKit keeps
//! accepting frames while its main thread is stopped. The position a client
//! reports having parsed is the only signal that holds on every engine.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const EVENT_CREDIT: u64 = 512;
const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub(super) struct Pacing {
    /// Half the ring. A read under credit is at most this long, so eviction,
    /// which drops whole chunks, cannot reach a position this close to the
    /// end of the stream. A ring under twice `PTY_READ_BYTES` can still hold
    /// one longer chunk from before a view attached; a resume then counts it.
    window: u64,
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct State {
    next_id: u64,
    seq: u64,
    events: u64,
    bypass: bool,
    views: HashMap<u64, View>,
}

#[derive(Debug)]
struct View {
    sent: u64,
    /// The position the client reports parsed; `None` for a client that does
    /// not acknowledge, which is tracked for its cursor and never holds.
    acked: Option<u64>,
    events: u64,
    released: bool,
    blocked_since: Option<Instant>,
}

impl View {
    /// An acknowledgement cannot vouch for bytes this socket has yet to send.
    fn acked_position(&self) -> Option<u64> {
        self.acked.map(|acked| acked.min(self.sent))
    }
}

/// How a WebSocket's output is paced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFlow {
    /// The client does not acknowledge: it never holds the reader, and a
    /// socket that falls behind recovers from the ring with a counted loss.
    Unacknowledged,
    /// The client reports its parsed position, which paces the reader.
    Acknowledged,
}

/// The output one WebSocket has sent and, when it acknowledges, parsed.
/// Clones share one lease; dropping the last clone releases reader credit.
#[derive(Clone, Debug)]
pub struct OutputProgress(Arc<Lease>);

#[derive(Debug)]
struct Lease {
    pacing: Arc<Pacing>,
    id: u64,
    flow: OutputFlow,
}

#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Read(usize),
    Wait(Instant),
}

impl Pacing {
    pub(super) fn new(capacity: usize, seq: u64) -> Arc<Self> {
        Arc::new(Self {
            window: (capacity / 2).max(1) as u64,
            state: Mutex::new(State {
                seq,
                ..State::default()
            }),
            changed: Condvar::new(),
        })
    }

    /// The caller holds the ring lock, so subscription and its replay frontier
    /// cannot straddle an output publication. Controls use this same mutex.
    pub(super) fn subscribe<T>(
        self: &Arc<Self>,
        seq: u64,
        flow: Option<OutputFlow>,
        subscribe: impl FnOnce() -> T,
    ) -> (T, Option<OutputProgress>) {
        let mut state = self.state.lock().expect("terminal pacing poisoned");
        let receiver = subscribe();
        let progress = flow.map(|flow| {
            let id = state.next_id;
            state.next_id += 1;
            let events = state.events;
            state.views.insert(
                id,
                View {
                    sent: seq,
                    acked: (flow == OutputFlow::Acknowledged).then_some(seq),
                    events,
                    released: false,
                    blocked_since: None,
                },
            );
            OutputProgress(Arc::new(Lease {
                pacing: self.clone(),
                id,
                flow,
            }))
        });
        (receiver, progress)
    }

    pub(super) fn publish(&self, bytes: usize, send: impl FnOnce()) {
        let mut state = self.state.lock().expect("terminal pacing poisoned");
        state.seq = state.seq.saturating_add(bytes as u64);
        state.events = state.events.saturating_add(1);
        send();
    }

    pub(super) fn credit(&self, maximum: usize, mut on_wait: impl FnMut()) -> usize {
        let mut state = self.state.lock().expect("terminal pacing poisoned");
        loop {
            match self.admit(&mut state, maximum, Instant::now()) {
                Admission::Read(bytes) => return bytes,
                Admission::Wait(deadline) => {
                    on_wait();
                    let wait = deadline.saturating_duration_since(Instant::now());
                    (state, _) = self
                        .changed
                        .wait_timeout(state, wait)
                        .expect("terminal pacing poisoned");
                }
            }
        }
    }

    fn admit(&self, state: &mut State, maximum: usize, now: Instant) -> Admission {
        if state.bypass {
            return Admission::Read(maximum);
        }
        let (seq, published_events) = (state.seq, state.events);
        let mut credit = maximum;
        let mut deadline: Option<Instant> = None;
        for view in state.views.values_mut().filter(|view| !view.released) {
            let Some(acked) = view.acked_position() else {
                continue;
            };
            let remaining = self.window.saturating_sub(seq.saturating_sub(acked));
            let events = published_events.saturating_sub(view.events);
            if remaining > 0 && events < EVENT_CREDIT {
                // The clock measures a hold, so an idle view never expires.
                view.blocked_since = None;
                credit = credit.min(usize::try_from(remaining).unwrap_or(usize::MAX));
                continue;
            }
            let until = *view.blocked_since.get_or_insert(now) + NO_PROGRESS_LIMIT;
            if now >= until {
                view.released = true;
                view.blocked_since = None;
                continue;
            }
            deadline = Some(deadline.map_or(until, |earliest| earliest.min(until)));
        }
        match deadline {
            Some(deadline) => Admission::Wait(deadline),
            None => Admission::Read(credit),
        }
    }

    pub(super) fn bypass(&self) {
        self.state.lock().expect("terminal pacing poisoned").bypass = true;
        self.changed.notify_all();
    }
}

impl OutputProgress {
    fn with_view<T>(&self, read: impl FnOnce(&View) -> T) -> Option<T> {
        self.0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned")
            .views
            .get(&self.0.id)
            .map(read)
    }

    /// How this socket was opened; a recovery keeps it.
    pub fn flow(&self) -> OutputFlow {
        self.0.flow
    }

    /// The most unacknowledged output this socket may hold, for an
    /// acknowledging client, which learns it from the session frame.
    pub fn ack_window(&self) -> Option<u64> {
        (self.0.flow == OutputFlow::Acknowledged).then_some(self.0.pacing.window)
    }

    /// Record raw replay or live output after its socket send succeeds.
    /// Synthetic terminal resets and mode preludes must not be recorded.
    pub fn sent_output(&self, bytes: usize) {
        let mut state = self
            .0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned");
        let published_seq = state.seq;
        if let Some(view) = state.views.get_mut(&self.0.id) {
            view.sent = view.sent.saturating_add(bytes as u64).min(published_seq);
        }
        self.0.pacing.changed.notify_all();
    }

    /// Record one consumed broadcast event after all its frames are sent.
    /// Events alone never renew the deadline of a view that holds the reader.
    pub fn sent_event(&self) {
        let mut state = self
            .0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned");
        let published_events = state.events;
        if let Some(view) = state.views.get_mut(&self.0.id) {
            view.events = view.events.saturating_add(1).min(published_events);
        }
        self.0.pacing.changed.notify_all();
    }

    /// Record the cumulative position the client has parsed. Only an advance
    /// counts as progress, and a position past the published stream is capped
    /// so a confused client cannot pre-acknowledge output.
    pub fn acknowledge(&self, seq: u64) {
        let mut state = self
            .0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned");
        let published_seq = state.seq;
        if let Some(view) = state.views.get_mut(&self.0.id) {
            let next = seq.min(published_seq);
            if view.acked.is_some_and(|acked| next > acked) {
                view.acked = Some(next);
                view.blocked_since = None;
            }
        }
        self.0.pacing.changed.notify_all();
    }

    /// The next raw output byte this attachment has yet to send.
    pub fn seq(&self) -> u64 {
        self.with_view(|view| view.sent).unwrap_or(0)
    }

    /// How many more raw bytes may be sent now; `None` when the client does
    /// not acknowledge and its socket's own backpressure is the only limit.
    pub fn send_credit(&self) -> Option<usize> {
        let window = self.0.pacing.window;
        self.with_view(|view| {
            view.acked_position().map(|acked| {
                let unacknowledged = view.sent.saturating_sub(acked);
                usize::try_from(window.saturating_sub(unacknowledged)).unwrap_or(usize::MAX)
            })
        })
        .flatten()
    }

    /// Whether the client has parsed everything this socket sent. A recovery
    /// waits for it, so its session frame lands on an empty client queue.
    pub fn drained(&self) -> bool {
        self.with_view(|view| view.acked_position().is_none_or(|acked| acked >= view.sent))
            .unwrap_or(true)
    }

    /// True once this attachment stopped holding the reader at its deadline.
    /// Late acknowledgements keep its cursor accurate but cannot hold again.
    pub fn needs_replay(&self) -> bool {
        self.with_view(|view| view.released).unwrap_or(true)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.pacing
            .state
            .lock()
            .expect("terminal pacing poisoned")
            .views
            .remove(&self.id);
        self.pacing.changed.notify_all();
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod session_tests;

#[cfg(test)]
mod recovery_tests;
