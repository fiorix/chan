//! Reader credit held by WebSockets that have opted into sent-byte accounting.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const EVENT_CREDIT: u64 = 512;
const NO_PROGRESS_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub(super) struct Pacing {
    byte_credit: u64,
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
    seq: u64,
    events: u64,
    holding: bool,
    stalled_since: Option<Instant>,
}

/// The raw output and broadcast events successfully sent by one WebSocket.
/// Clones share one lease; dropping the last clone releases reader credit.
#[derive(Clone, Debug)]
pub struct OutputProgress(Arc<Lease>);

#[derive(Debug)]
struct Lease {
    pacing: Arc<Pacing>,
    id: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Read(usize),
    Wait(Instant),
}

impl Pacing {
    pub(super) fn new(capacity: usize, seq: u64) -> Arc<Self> {
        Arc::new(Self {
            byte_credit: (capacity / 2).max(1) as u64,
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
        holding: bool,
        subscribe: impl FnOnce() -> T,
    ) -> (T, Option<OutputProgress>) {
        let mut state = self.state.lock().expect("terminal pacing poisoned");
        let receiver = subscribe();
        let progress = holding.then(|| {
            let id = state.next_id;
            state.next_id += 1;
            let events = state.events;
            let stalled_since = (seq < state.seq).then(Instant::now);
            state.views.insert(
                id,
                View {
                    seq,
                    events,
                    holding: true,
                    stalled_since,
                },
            );
            OutputProgress(Arc::new(Lease {
                pacing: self.clone(),
                id,
            }))
        });
        (receiver, progress)
    }

    pub(super) fn publish(&self, bytes: usize, send: impl FnOnce()) {
        let mut state = self.state.lock().expect("terminal pacing poisoned");
        state.seq = state.seq.saturating_add(bytes as u64);
        state.events = state.events.saturating_add(1);
        let now = Instant::now();
        for view in state.views.values_mut() {
            if view.holding {
                view.stalled_since.get_or_insert(now);
            }
        }
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
        let mut credit = maximum;
        let mut deadline: Option<Instant> = None;
        for view in state.views.values_mut().filter(|view| view.holding) {
            let bytes = state.seq.saturating_sub(view.seq);
            let events = state.events.saturating_sub(view.events);
            if bytes == 0 && events == 0 {
                view.stalled_since = None;
            }
            if let Some(started) = view.stalled_since {
                if now >= started + NO_PROGRESS_LIMIT {
                    view.holding = false;
                    continue;
                }
            }
            let remaining = self.byte_credit.saturating_sub(bytes) as usize;
            credit = credit.min(remaining);
            if remaining == 0 || events >= EVENT_CREDIT {
                let until = *view.stalled_since.get_or_insert(now) + NO_PROGRESS_LIMIT;
                deadline = Some(deadline.map_or(until, |earliest| earliest.min(until)));
            }
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
    /// Acknowledge raw replay or live output after its socket send succeeds.
    /// Synthetic terminal resets and mode preludes must not be acknowledged.
    pub fn sent_output(&self, bytes: usize) {
        self.sent_output_at(bytes, Instant::now());
    }

    fn sent_output_at(&self, bytes: usize, now: Instant) {
        let mut state = self
            .0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned");
        let published_seq = state.seq;
        let published_events = state.events;
        if let Some(view) = state.views.get_mut(&self.0.id) {
            let next = view.seq.saturating_add(bytes as u64).min(published_seq);
            if next > view.seq {
                view.seq = next;
                view.stalled_since = Some(now);
            }
            if view.seq == published_seq && view.events == published_events {
                view.stalled_since = None;
            }
        }
        self.0.pacing.changed.notify_all();
    }

    /// Acknowledge one consumed broadcast event after all its frames are sent.
    /// Events alone never renew the raw-byte progress deadline.
    pub fn sent_event(&self) {
        let mut state = self
            .0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned");
        let published_seq = state.seq;
        let published_events = state.events;
        if let Some(view) = state.views.get_mut(&self.0.id) {
            view.events = view.events.saturating_add(1).min(published_events);
            if view.seq == published_seq && view.events == published_events {
                view.stalled_since = None;
            }
        }
        self.0.pacing.changed.notify_all();
    }

    /// The next raw output byte this attachment has yet to send.
    pub fn seq(&self) -> u64 {
        self.0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned")
            .views
            .get(&self.0.id)
            .map_or(0, |view| view.seq)
    }

    /// True once this attachment was released after its progress deadline.
    /// Late acknowledgments keep its cursor accurate but cannot hold the reader again.
    pub fn needs_replay(&self) -> bool {
        self.0
            .pacing
            .state
            .lock()
            .expect("terminal pacing poisoned")
            .views
            .get(&self.0.id)
            .is_none_or(|view| !view.holding)
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
