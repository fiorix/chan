//! A connected devserver's connection health, read from the replies to the
//! pings the desktop sends on the devserver's window feed.
//!
//! The devserver answers each `{"type":"ping"}` text frame on the feed with
//! a `{"type":"pong"}` that carries no id, in the order the pings reached
//! it, so a queue of send times pairs each pong with its ping. The feed's
//! pump (`window_watcher_wiring`) reports what its socket did to the
//! [`ConnectionReading`], which keeps no socket, timer or clock of its own:
//! every report carries the [`Stamp`] it happened at, so a test drives the
//! reading with stamps it makes.
//!
//! One reading serves one connection to a devserver across the feed
//! sockets the connection opens in turn: the history, the latest reply time,
//! the last contact and the reconnecting face all span sockets. Only the
//! devserver's own text frames, its window sets and its pongs, count as
//! contact: a WebSocket Pong can come from a gateway's proxy in front of a
//! devserver that has stopped answering.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use chan_server::{ConnectionFace, ConnectionHealth, CONNECTION_SAMPLE_CAP};
use tokio::sync::watch;

/// A reply waiting this long makes the connection slow. Well above a healthy
/// round trip through a gateway, so jitter does not trip it.
const SLOW_WAIT: Duration = Duration::from_millis(1_000);
/// Replies at or over this make the connection slow once [`RTT_RUN`] in a row
/// reach it: the delay at which an echoed keystroke visibly lags. The
/// launcher's chart floor (`CONNECTION_CHART_FLOOR_MS`) is this number.
const SLOW_RTT_MS: u64 = 400;
/// Replies must come back under this, [`RTT_RUN`] in a row with none
/// overdue, for the connection to leave slow. Lower than the entry threshold
/// so a connection that hovers around it does not change face on every pong.
/// A slow face whose latest reply and current wait are under it reads
/// [`recovering`](ConnectionHealth::recovering).
const OK_RTT_MS: u64 = 300;
/// How many replies in a row a threshold takes, so that one outlier neither
/// enters nor leaves slow.
const RTT_RUN: usize = 2;
/// Silence this long while a reply waits, counted from its ping or from the
/// devserver's latest frame after it, makes the connection stalled: it
/// carries nothing.
const STALLED_WAIT: Duration = Duration::from_millis(4_000);
/// The longest reply worth timing. A reply later than this crossed a jump of
/// the clock or a hang, and neither is the connection's reply time.
const MAX_RTT_MS: u64 = 45_000;
/// How many waiting pings keep their send time. A devserver whose pongs stop
/// while its sets keep the socket open would otherwise hold one for every
/// ping the cadence sends.
const PENDING_CAP: usize = 32;
/// The ping cadence after a socket's first reply while a window of the
/// desktop has the focus: three minutes of it fill the history.
pub(crate) const FOCUSED_CADENCE: Duration = Duration::from_secs(3);
/// The ping cadence after a socket's first reply while no window of the
/// desktop has the focus.
pub(crate) const UNFOCUSED_CADENCE: Duration = Duration::from_secs(20);
/// How often the pump reports the time while
/// [`waits`](ConnectionReading::waits) holds, so a gap between reports shows
/// that the process did not run.
pub(crate) const WAKE_TICK: Duration = Duration::from_secs(2);
/// A gap between reports longer than this, while the pump reports the time
/// every [`WAKE_TICK`], is a sleep of the machine on a clock that counts one
/// (or a frozen process): the pings in flight are not timed. Before the
/// devserver has answered nothing reports the time, and a gap shows nothing.
const WAKE_GAP: Duration = Duration::from_secs(6);
/// A step of the wall clock against the monotonic one larger than this,
/// across a ping's wait, is a sleep on a monotonic clock that pauses during
/// one (or the wall clock set): the ping is not timed.
const CLOCK_STEP_MS: i128 = 2_000;

/// The ping cadence after a socket's first reply.
pub(crate) fn cadence(focused: bool) -> Duration {
    if focused {
        FOCUSED_CADENCE
    } else {
        UNFOCUSED_CADENCE
    }
}

/// A moment as the reading takes it: the monotonic instant it times waits
/// with, and the wall-clock time the launcher reads, in Unix milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Stamp {
    pub mono: Instant,
    pub wall_ms: u64,
}

impl Stamp {
    /// This moment `by` later on both clocks.
    #[cfg(test)]
    pub(crate) fn plus(self, by: Duration) -> Stamp {
        Stamp {
            mono: self.mono + by,
            wall_ms: self.wall_ms + millis(by),
        }
    }
}

/// Where the reading's stamps come from.
pub(crate) trait Clock: Send + Sync {
    fn now(&self) -> Stamp;
}

/// The process's clocks. The monotonic one is tokio's, so a test on a paused
/// runtime moves it.
pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Stamp {
        let wall_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(millis)
            .unwrap_or(0);
        Stamp {
            mono: tokio::time::Instant::now().into_std(),
            wall_ms,
        }
    }
}

fn millis(span: Duration) -> u64 {
    u64::try_from(span.as_millis()).unwrap_or(u64::MAX)
}

/// The pings waiting for a pong, in the order their pongs come: `ahead` of
/// them untimed, then the send stamps in `timed`, oldest first, then `behind`
/// more untimed. Only the timed ones take memory, at most [`PENDING_CAP`];
/// an untimed ping is a count, which is all the pairing needs.
#[derive(Debug, Default)]
struct PendingPings {
    ahead: u32,
    timed: VecDeque<Stamp>,
    behind: u32,
}

impl PendingPings {
    fn push(&mut self, sent: Stamp) {
        // With no timed ping between them, the ones behind are ahead of this
        // one like any other.
        if self.timed.is_empty() {
            self.ahead = self.ahead.saturating_add(self.behind);
            self.behind = 0;
        }
        // A send stamp joins `timed` only at its end, so a ping sent while
        // untimed ones wait behind is counted with them: timing it would hand
        // it the pong of an older ping.
        if self.behind > 0 || self.timed.len() >= PENDING_CAP {
            self.behind = self.behind.saturating_add(1);
        } else {
            self.timed.push_back(sent);
        }
    }

    /// The ping a pong answers: `Some(Some(sent))` for a timed one,
    /// `Some(None)` for an untimed one, `None` with no ping waiting.
    fn pop(&mut self) -> Option<Option<Stamp>> {
        if self.ahead > 0 {
            self.ahead -= 1;
            return Some(None);
        }
        if let Some(sent) = self.timed.pop_front() {
            return Some(Some(sent));
        }
        if self.behind > 0 {
            self.behind -= 1;
            return Some(None);
        }
        None
    }

    /// The oldest `count` timed pings lose their send stamps and keep their
    /// place, so later pongs still pair.
    fn untime(&mut self, count: usize) {
        let count = count.min(self.timed.len());
        if count == 0 {
            return;
        }
        self.timed.drain(..count);
        self.ahead = self
            .ahead
            .saturating_add(u32::try_from(count).unwrap_or(u32::MAX));
        if self.timed.is_empty() {
            self.ahead = self.ahead.saturating_add(self.behind);
            self.behind = 0;
        }
    }
}

/// What the reading keeps of the feed socket open now.
#[derive(Debug, Default)]
struct Socket {
    open: bool,
    /// It has delivered a pong.
    answered: bool,
    /// How many window sets it has delivered.
    sets: u32,
    /// When its last frame of the devserver's arrived.
    last_frame: Option<Stamp>,
}

/// One devserver connection's reading. See the module docs.
#[derive(Debug, Default)]
pub(crate) struct ConnectionReading {
    pending: PendingPings,
    /// A feed socket of this connection has delivered a pong.
    answered: bool,
    socket: Socket,
    /// From the loss of an open feed socket until a later one delivers a pong.
    reconnecting: bool,
    /// This socket's latest reply times, oldest first, at most [`RTT_RUN`].
    rtts: VecDeque<u64>,
    /// The face the replies of this socket gave at the last classification;
    /// `None` before its first.
    class: Option<ConnectionFace>,
    /// The latest reply time, kept across sockets.
    rtt_ms: Option<u64>,
    /// When the devserver's last frame arrived, in Unix milliseconds, kept
    /// across sockets.
    last_contact: Option<u64>,
    /// The reply times of the last finished pings, `None` for a miss.
    samples: VecDeque<Option<u64>>,
    /// The face shown and when it took that face, in Unix milliseconds;
    /// `None` with no face.
    shown: Option<(ConnectionFace, u64)>,
    /// When the reading was last told the time, for the gap that shows a
    /// sleep.
    observed: Option<Instant>,
    /// [`waits`](Self::waits) held as the last report ended, so the pump
    /// reports the time every [`WAKE_TICK`] until the next one: only then
    /// does a gap since that report show that the process did not run.
    reports_due: bool,
}

impl ConnectionReading {
    /// A feed socket opened. Its pings, replies and frames start afresh; the
    /// history, the latest reply time and the last contact carry over.
    /// Answers whether the face changed, as every report does.
    pub(crate) fn opened(&mut self, now: Stamp) -> bool {
        self.observe(now);
        self.pending = PendingPings::default();
        self.socket = Socket {
            open: true,
            ..Socket::default()
        };
        self.rtts.clear();
        self.class = None;
        self.settle(now)
    }

    /// A ping is leaving. Reported before the frame goes to the socket, so a
    /// pong that comes back at once finds it.
    pub(crate) fn ping_sent(&mut self, now: Stamp) -> bool {
        self.observe(now);
        self.pending.push(now);
        self.settle(now)
    }

    /// A pong arrived. It answers the oldest waiting ping, and gives a reply
    /// time when that ping kept its send stamp and the reply took at most
    /// [`MAX_RTT_MS`]. A pong at any time says the devserver answers the
    /// feed's ping: it turns the reading on and ends reconnecting.
    pub(crate) fn pong(&mut self, now: Stamp) -> bool {
        self.observe(now);
        self.contact(now);
        self.answered = true;
        self.socket.answered = true;
        self.reconnecting = false;
        if let Some(Some(sent)) = self.pending.pop() {
            let took = millis(now.mono.saturating_duration_since(sent.mono));
            if took <= MAX_RTT_MS {
                self.rtts.push_back(took);
                if self.rtts.len() > RTT_RUN {
                    self.rtts.pop_front();
                }
                self.rtt_ms = Some(took);
                self.sample(Some(took));
            }
        }
        self.settle(now)
    }

    /// A window set arrived. The socket's first set is the one the
    /// devserver opens with, and says nothing of its pongs. A later one
    /// before any pong is what a devserver that does not answer the ping
    /// sends for it, or a change's set ahead of the pong: either way it shows
    /// no face until a pong comes, and it decides nothing.
    pub(crate) fn set_arrived(&mut self, now: Stamp) -> bool {
        self.observe(now);
        self.contact(now);
        self.socket.sets = self.socket.sets.saturating_add(1);
        self.settle(now)
    }

    /// The open feed socket ended. Once the devserver has answered on this
    /// connection, each ping still waiting with its send stamp is a miss.
    pub(crate) fn lost(&mut self, now: Stamp) -> bool {
        self.observe(now);
        if self.answered {
            for _ in 0..self.pending.timed.len() {
                self.sample(None);
            }
        }
        self.pending = PendingPings::default();
        self.socket = Socket::default();
        self.rtts.clear();
        self.class = None;
        self.reconnecting = true;
        self.settle(now)
    }

    /// Time passed with nothing else to report. The pump reports it every
    /// [`WAKE_TICK`] while [`waits`](Self::waits) holds.
    pub(crate) fn tick(&mut self, now: Stamp) -> bool {
        self.observe(now);
        self.settle(now)
    }

    /// Whether the pump reports the time: a ping that still has its send
    /// stamp waits for its pong, on a connection whose devserver has
    /// answered, over a socket whose sets do not show a devserver that does
    /// not answer.
    pub(crate) fn waits(&self) -> bool {
        self.answered && !self.unanswered_sets() && !self.pending.timed.is_empty()
    }

    /// Whether the open feed socket has delivered a pong. Until it has, the
    /// pump sends that socket no ping after its first.
    pub(crate) fn socket_answered(&self) -> bool {
        self.socket.answered
    }

    /// The open socket has delivered a set for a ping and no pong: a
    /// devserver too old to answer sends its set again for each ping.
    fn unanswered_sets(&self) -> bool {
        self.socket.open && !self.socket.answered && self.socket.sets >= 2
    }

    /// The reading at `now`, or `None` with no face to show.
    pub(crate) fn health(&mut self, now: Stamp) -> Option<ConnectionHealth> {
        self.observe(now);
        self.settle(now);
        let (face, since) = self.shown?;
        // A wait counts once the devserver has answered: before that, a
        // first ping that never comes back is a devserver too old to answer.
        let waiting = if self.answered {
            self.pending.timed.front().copied()
        } else {
            None
        };
        Some(ConnectionHealth {
            face,
            recovering: face == ConnectionFace::Slow && recovering(self.rtt_ms, waiting, now),
            since,
            rtt_ms: self.rtt_ms,
            wait_since: waiting.map(|sent| sent.wall_ms),
            last_contact: self.last_contact,
            samples: self.samples.iter().copied().collect(),
        })
    }

    fn contact(&mut self, now: Stamp) {
        self.socket.last_frame = Some(now);
        self.last_contact = Some(now.wall_ms);
    }

    fn sample(&mut self, rtt_ms: Option<u64>) {
        self.samples.push_back(rtt_ms);
        while self.samples.len() > CONNECTION_SAMPLE_CAP {
            self.samples.pop_front();
        }
    }

    /// Untime the pings in flight across a sleep. Read on every report, so
    /// the pings are untimed before anything reads their wait.
    fn observe(&mut self, now: Stamp) {
        if !self.pending.timed.is_empty() {
            let slept = self.reports_due
                && self
                    .observed
                    .is_some_and(|at| now.mono.saturating_duration_since(at) > WAKE_GAP);
            let crossed = if slept {
                self.pending.timed.len()
            } else {
                // The pings a step crossed are the oldest ones.
                self.pending
                    .timed
                    .iter()
                    .take_while(|sent| stepped(**sent, now))
                    .count()
            };
            self.pending.untime(crossed);
        }
        self.observed = Some(now.mono);
    }

    /// Read the face at `now` into `shown`, answering whether it changed. A
    /// face a wait crossed a threshold into starts when it crossed it, unless
    /// that was before the face it follows began: slow after a stall starts
    /// when it is read, not at the wait's first second. Every report ends
    /// here, so it also notes whether the pump now reports the time.
    fn settle(&mut self, now: Stamp) -> bool {
        self.reports_due = self.waits();
        let next = self.face(now);
        let changed = self.shown.map(|(face, _)| face) != next.map(|(face, _)| face);
        if changed {
            let began = self.shown.map(|(_, since)| since);
            self.shown = next.map(|(face, due)| {
                let since = match due {
                    Some(due) if began.is_none_or(|began| due >= began) => due.min(now.wall_ms),
                    _ => now.wall_ms,
                };
                (face, since)
            });
        }
        changed
    }

    fn face(&mut self, now: Stamp) -> Option<(ConnectionFace, Option<u64>)> {
        if self.reconnecting || !self.answered {
            if self.unanswered_sets() {
                return None;
            }
            let face = if self.reconnecting {
                ConnectionFace::Reconnecting
            } else {
                ConnectionFace::Unknown
            };
            return Some((face, None));
        }
        let (class, due) = classify(
            self.class.unwrap_or(ConnectionFace::Unknown),
            self.pending.timed.front().copied(),
            self.socket.last_frame,
            &self.rtts,
            now,
        );
        self.class = Some(class);
        Some((class, due))
    }
}

/// Whether the wall clock moved against the monotonic one by more than
/// [`CLOCK_STEP_MS`] between `from` and `to`.
fn stepped(from: Stamp, to: Stamp) -> bool {
    let mono = i128::try_from(to.mono.saturating_duration_since(from.mono).as_millis())
        .unwrap_or(i128::MAX);
    let wall = i128::from(to.wall_ms) - i128::from(from.wall_ms);
    (wall - mono).abs() > CLOCK_STEP_MS
}

/// The face the replies of an answering socket give at `now`, after `prev`,
/// and for a face a wait crossed a threshold into, the wall time it crossed
/// it. `prev` matters only for leaving slow, which takes [`RTT_RUN`] replies
/// under [`OK_RTT_MS`] where entering takes as many at [`SLOW_RTT_MS`] or
/// over, or one at [`SLOW_WAIT`] or over.
fn classify(
    prev: ConnectionFace,
    oldest: Option<Stamp>,
    last_frame: Option<Stamp>,
    rtts: &VecDeque<u64>,
    now: Stamp,
) -> (ConnectionFace, Option<u64>) {
    if let Some(sent) = oldest {
        // The silence counts from the ping: a frame older than the ping says
        // nothing about a connection that was not being asked, and one newer
        // than the ping says it still carries data, however late the pong.
        let quiet = match last_frame {
            Some(frame) if frame.mono > sent.mono => frame,
            _ => sent,
        };
        if now.mono.saturating_duration_since(quiet.mono) >= STALLED_WAIT {
            return (
                ConnectionFace::Stalled,
                Some(quiet.wall_ms + millis(STALLED_WAIT)),
            );
        }
        if now.mono.saturating_duration_since(sent.mono) >= SLOW_WAIT {
            return (ConnectionFace::Slow, Some(sent.wall_ms + millis(SLOW_WAIT)));
        }
    }
    // A reply that long had its ping overdue, whether or not anything read
    // the face while it waited.
    if rtts.back().is_some_and(|&ms| ms >= millis(SLOW_WAIT)) {
        return (ConnectionFace::Slow, None);
    }
    let full = rtts.len() == RTT_RUN;
    let face = if matches!(prev, ConnectionFace::Slow | ConnectionFace::Stalled) {
        if full && rtts.iter().all(|&ms| ms < OK_RTT_MS) {
            ConnectionFace::Healthy
        } else {
            ConnectionFace::Slow
        }
    } else if full && rtts.iter().all(|&ms| ms >= SLOW_RTT_MS) {
        ConnectionFace::Slow
    } else {
        ConnectionFace::Healthy
    };
    (face, None)
}

/// Whether a slow face is recovering at `now`: the latest reply time, the one
/// the launcher shows, and the wait of the oldest ping still out are both
/// under [`OK_RTT_MS`], which [`classify`] ends slow at once [`RTT_RUN`]
/// replies in a row come back under it. It changes no face, so it is read
/// with the reading rather than settled with the face.
fn recovering(rtt_ms: Option<u64>, oldest: Option<Stamp>, now: Stamp) -> bool {
    let waited = oldest.map_or(0, |sent| {
        millis(now.mono.saturating_duration_since(sent.mono))
    });
    rtt_ms.unwrap_or(0) < OK_RTT_MS && waited < OK_RTT_MS
}

/// What paces the pings of every devserver's feed: whether a window of the
/// desktop has the focus, and how many times a ping now was asked for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ProbePace {
    pub focused: bool,
    pub nudges: u64,
}

impl ProbePace {
    /// Take the desktop's focus as `focused`, answering whether the pace
    /// changed. A gain asks for its one ping in the same change, so a feed's
    /// pump wakes once for the gain and reads both.
    fn take_focus(&mut self, focused: bool) -> bool {
        if focused && !self.focused {
            self.nudges = self.nudges.wrapping_add(1);
        }
        let changed = self.focused != focused;
        self.focused = focused;
        changed
    }
}

/// What holds the keyboard in a window of the desktop: the window's own
/// webview, or the Computers screen, a webview of its own over it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum FocusHolder {
    Window,
    Screen,
}

/// The desktop's [`ProbePace`], shared by every feed's pump.
pub(crate) struct ProbePacer {
    /// What has the focus in the desktop's windows, by window label. A move
    /// of the focus between two windows, or between a window's webview and
    /// its Computers screen, can report the loss first.
    focused: Mutex<HashSet<(String, FocusHolder)>>,
    pace: watch::Sender<ProbePace>,
}

impl Default for ProbePacer {
    fn default() -> Self {
        Self {
            focused: Mutex::default(),
            pace: watch::channel(ProbePace::default()).0,
        }
    }
}

impl ProbePacer {
    pub(crate) fn subscribe(&self) -> watch::Receiver<ProbePace> {
        self.pace.subscribe()
    }

    /// A window of the desktop gained or lost the focus, or went away
    /// (`focused` false). When the desktop gains the focus, every feed
    /// pings once, in the same update of the pace. A move of the focus
    /// between two windows pings once too when it is reported loss first,
    /// as the desktop losing the focus and gaining it, and not when it is
    /// reported gain first.
    pub(crate) fn window_focus(&self, label: &str, focused: bool) {
        self.holder_focus(label, FocusHolder::Window, focused);
    }

    /// The Computers screen over window `host` gained or lost the keyboard,
    /// or was hidden or dropped (`focused` false). The window has the focus
    /// while either its own webview or its screen holds it. Only Windows
    /// reports a screen's focus: there tauri-runtime-wry synthesizes a
    /// window's focus from its own webview's WebView2 controller, so the
    /// screen taking the keyboard reads as the window losing the focus, and
    /// no gain follows while the screen holds it. Elsewhere a window's focus
    /// is the native window's, which the screen's webview leaves alone.
    pub(crate) fn screen_focus(&self, host: &str, focused: bool) {
        self.holder_focus(host, FocusHolder::Screen, focused);
    }

    fn holder_focus(&self, label: &str, holder: FocusHolder, focused: bool) {
        let now_focused = {
            let mut holders = self.focused.lock().unwrap_or_else(|e| e.into_inner());
            let key = (label.to_string(), holder);
            if focused {
                holders.insert(key);
            } else {
                holders.remove(&key);
            }
            !holders.is_empty()
        };
        self.pace
            .send_if_modified(|pace| pace.take_focus(now_focused));
    }

    /// Ask every feed whose devserver has answered for one ping now.
    pub(crate) fn ping_now(&self) {
        self.pace
            .send_modify(|pace| pace.nudges = pace.nudges.wrapping_add(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALL0: u64 = 1_700_000_000_000;

    /// A clock a test moves by hand, both clocks together unless a test
    /// steps one.
    struct Hand {
        now: Stamp,
    }

    impl Hand {
        fn new() -> Self {
            Hand {
                now: Stamp {
                    mono: Instant::now(),
                    wall_ms: WALL0,
                },
            }
        }

        fn at(&self) -> Stamp {
            self.now
        }

        fn wait(&mut self, ms: u64) -> Stamp {
            self.now = self.now.plus(Duration::from_millis(ms));
            self.now
        }

        /// The machine sleeps `ms`: the wall clock moves, the monotonic one
        /// does not, as on Linux and macOS.
        fn sleep_paused(&mut self, ms: u64) -> Stamp {
            self.now.wall_ms += ms;
            self.now
        }
    }

    fn face(reading: &mut ConnectionReading, now: Stamp) -> Option<ConnectionFace> {
        reading.health(now).map(|health| health.face)
    }

    /// A reading whose first socket is open and has answered one ping in
    /// `rtt` ms, its opening set read.
    fn answered(hand: &mut Hand, rtt: u64) -> ConnectionReading {
        let mut reading = ConnectionReading::default();
        reading.opened(hand.at());
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.at());
        hand.wait(rtt);
        reading.pong(hand.at());
        reading
    }

    /// Wait `ms` with a report every 2 s, as the pump makes while a timed
    /// ping waits.
    fn wait_reported(reading: &mut ConnectionReading, hand: &mut Hand, ms: u64) -> Stamp {
        let mut left = ms;
        while left > 2_000 {
            reading.tick(hand.wait(2_000));
            left -= 2_000;
        }
        hand.wait(left)
    }

    /// One ping answered in `rtt` ms, `gap` ms after the last report.
    fn reply(reading: &mut ConnectionReading, hand: &mut Hand, gap: u64, rtt: u64) {
        hand.wait(gap);
        reading.ping_sent(hand.at());
        hand.wait(rtt);
        reading.pong(hand.at());
    }

    #[test]
    fn before_the_first_reply_the_face_is_unknown() {
        let mut hand = Hand::new();
        let mut reading = ConnectionReading::default();
        assert_eq!(face(&mut reading, hand.at()), Some(ConnectionFace::Unknown));
        reading.opened(hand.at());
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.at());
        let health = reading.health(hand.wait(10_000)).unwrap();
        assert_eq!(
            health.face,
            ConnectionFace::Unknown,
            "a first ping waiting 10 s read as more than unknown"
        );
        assert_eq!(health.wait_since, None, "a wait counted before any reply");
        assert_eq!(health.rtt_ms, None);
        assert!(health.samples.is_empty());
    }

    #[test]
    fn a_first_reply_reads_healthy() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.face, ConnectionFace::Healthy);
        assert_eq!(health.since, WALL0 + 40);
        assert_eq!(health.rtt_ms, Some(40));
        assert_eq!(health.last_contact, Some(WALL0 + 40));
        assert_eq!(health.samples, [Some(40)]);
    }

    #[test]
    fn a_reply_waiting_one_second_reads_slow_from_that_second() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent = hand.wait(3_000);
        reading.ping_sent(sent);
        assert_eq!(
            face(&mut reading, hand.wait(999)),
            Some(ConnectionFace::Healthy),
            "a 999 ms wait"
        );
        let health = reading.health(hand.wait(1)).unwrap();
        assert_eq!(health.face, ConnectionFace::Slow, "a 1 s wait");
        assert_eq!(health.wait_since, Some(sent.wall_ms));

        // Read first well past the second, slow still starts at it.
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent = hand.wait(3_000);
        reading.ping_sent(sent);
        let health = reading.health(hand.wait(1_500)).unwrap();
        assert_eq!(health.face, ConnectionFace::Slow);
        assert_eq!(
            health.since,
            sent.wall_ms + 1_000,
            "slow starts when the wait reached 1 s, not when it was read"
        );
    }

    #[test]
    fn a_reply_of_one_second_reads_slow() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        reply(&mut reading, &mut hand, 3_000, 999);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Healthy),
            "a 999 ms reply"
        );
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        hand.wait(1_000);
        // No report while it waited: the reply alone reads slow.
        reading.pong(hand.at());
        assert_eq!(face(&mut reading, hand.at()), Some(ConnectionFace::Slow));
    }

    #[test]
    fn two_replies_of_400_ms_in_a_row_read_slow() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 400);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Healthy),
            "one 400 ms reply"
        );
        reply(&mut reading, &mut hand, 3_000, 399);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Healthy),
            "400 then 399 ms"
        );
        reply(&mut reading, &mut hand, 3_000, 400);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Healthy),
            "399 then 400 ms"
        );
        reply(&mut reading, &mut hand, 3_000, 400);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Slow),
            "400 then 400 ms"
        );
    }

    #[test]
    fn slow_ends_at_two_replies_under_300_ms_with_none_overdue() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 1_200);
        assert_eq!(face(&mut reading, hand.at()), Some(ConnectionFace::Slow));
        reply(&mut reading, &mut hand, 3_000, 250);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Slow),
            "one reply under 300 ms after a slow one"
        );
        reply(&mut reading, &mut hand, 3_000, 300);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Slow),
            "250 then 300 ms"
        );
        reply(&mut reading, &mut hand, 3_000, 299);
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Slow),
            "300 then 299 ms"
        );
        // Two under 300 ms, but a ping overdue: still slow.
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        hand.wait(20);
        reading.pong(hand.at());
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        assert_eq!(
            face(&mut reading, hand.wait(1_000)),
            Some(ConnectionFace::Slow),
            "two replies under 300 ms with a ping overdue"
        );
        hand.wait(10);
        reading.pong(hand.at());
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.face, ConnectionFace::Slow, "a 1010 ms reply");
        reply(&mut reading, &mut hand, 3_000, 20);
        reply(&mut reading, &mut hand, 3_000, 20);
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(
            health.face,
            ConnectionFace::Healthy,
            "two replies under 300 ms with none overdue"
        );
        assert_eq!(health.since, hand.at().wall_ms);
    }

    /// Recovering is a slow face whose latest reply time and current wait
    /// are both under 300 ms, read whenever the reading is.
    #[test]
    fn a_slow_face_under_300_ms_reads_recovering() {
        let recovering = |reading: &mut ConnectionReading, now: Stamp| {
            let health = reading.health(now).unwrap();
            assert_eq!(health.face, ConnectionFace::Slow);
            health.recovering
        };
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 1_200);
        assert!(!recovering(&mut reading, hand.at()), "a 1.2 s reply");
        reply(&mut reading, &mut hand, 3_000, 300);
        assert!(!recovering(&mut reading, hand.at()), "a 300 ms reply");
        reply(&mut reading, &mut hand, 3_000, 299);
        assert!(recovering(&mut reading, hand.at()), "a 299 ms reply");
        reading.ping_sent(hand.wait(3_000));
        assert!(recovering(&mut reading, hand.wait(299)), "a 299 ms wait");
        assert!(!recovering(&mut reading, hand.wait(1)), "a 300 ms wait");
        hand.wait(100);
        reading.pong(hand.at());
        assert!(!recovering(&mut reading, hand.at()), "a 400 ms reply");
        reply(&mut reading, &mut hand, 3_000, 20);
        assert!(recovering(&mut reading, hand.at()), "a 20 ms reply");
        reply(&mut reading, &mut hand, 3_000, 20);
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.face, ConnectionFace::Healthy);
        assert!(!health.recovering, "a healthy face read as recovering");
    }

    #[test]
    fn a_reply_waiting_four_seconds_with_no_frame_reads_stalled() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent = hand.wait(3_000);
        reading.ping_sent(sent);
        assert_eq!(
            face(&mut reading, hand.wait(3_999)),
            Some(ConnectionFace::Slow),
            "a 3.999 s wait"
        );
        let health = reading.health(hand.wait(1)).unwrap();
        assert_eq!(health.face, ConnectionFace::Stalled, "a 4 s wait");
        assert_eq!(health.wait_since, Some(sent.wall_ms));

        // Read first well past the four seconds, the stall starts at them.
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent = hand.wait(3_000);
        reading.ping_sent(sent);
        let health = reading.health(hand.wait(5_500)).unwrap();
        assert_eq!(health.face, ConnectionFace::Stalled);
        assert_eq!(
            health.since,
            sent.wall_ms + 4_000,
            "the stall starts when the wait reached 4 s, not when it was read"
        );

        // A set arriving during the wait restarts the silence.
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent = hand.wait(3_000);
        reading.ping_sent(sent);
        let set = hand.wait(3_000);
        reading.set_arrived(set);
        assert_eq!(
            face(&mut reading, hand.wait(3_999)),
            Some(ConnectionFace::Slow),
            "a set 3 s into the wait did not hold the stall off"
        );
        let health = reading.health(hand.wait(1)).unwrap();
        assert_eq!(health.face, ConnectionFace::Stalled);
        assert_eq!(health.since, set.wall_ms + 4_000);

        // A frame from before the ping holds nothing off.
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        reading.set_arrived(hand.wait(2_000));
        let sent = hand.wait(1_000);
        reading.ping_sent(sent);
        assert_eq!(
            face(&mut reading, hand.wait(4_000)),
            Some(ConnectionFace::Stalled)
        );
    }

    /// A set during a stall ends it, and the slow face that follows starts
    /// when the set came: the wait's first second is before the stall began.
    #[test]
    fn a_slow_face_after_a_stall_starts_when_it_is_read() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent = hand.wait(3_000);
        reading.ping_sent(sent);
        let stalled = reading.health(hand.wait(5_000)).unwrap();
        assert_eq!(stalled.face, ConnectionFace::Stalled);
        assert_eq!(stalled.since, sent.wall_ms + 4_000);
        let set = hand.wait(1_000);
        reading.set_arrived(set);
        let health = reading.health(hand.wait(500)).unwrap();
        assert_eq!(health.face, ConnectionFace::Slow);
        assert_eq!(
            health.since, set.wall_ms,
            "slow after the stall started before the stall did"
        );
    }

    /// The pump reports the time while a timed ping waits on a connection
    /// whose devserver has answered, and not over a socket whose set
    /// answered its ping.
    #[test]
    fn only_an_answering_connections_wait_asks_for_reports() {
        let mut hand = Hand::new();
        let mut reading = ConnectionReading::default();
        reading.opened(hand.at());
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.at());
        assert!(!reading.waits(), "a first ping before any reply");
        reading.pong(hand.wait(40));
        reading.ping_sent(hand.wait(3_000));
        assert!(reading.waits(), "a ping after a reply");
        reading.lost(hand.wait(1_000));
        reading.opened(hand.wait(1_000));
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.at());
        assert!(
            reading.waits(),
            "the first ping of a later socket of an answering connection"
        );
        reading.set_arrived(hand.wait(10));
        assert!(
            !reading.waits(),
            "a socket whose set answered its ping still asked for reports"
        );
    }

    #[test]
    fn a_lost_socket_reads_reconnecting_until_a_later_one_answers() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let lost = hand.wait(5_000);
        reading.lost(lost);
        let health = reading.health(hand.wait(2_000)).unwrap();
        assert_eq!(health.face, ConnectionFace::Reconnecting);
        assert_eq!(health.since, lost.wall_ms, "reconnecting from the loss");
        assert_eq!(
            health.rtt_ms,
            Some(40),
            "the latest reply time carries over"
        );
        assert_eq!(health.last_contact, Some(WALL0 + 40));

        // Dials that fail open nothing: still reconnecting.
        assert_eq!(
            face(&mut reading, hand.wait(60_000)),
            Some(ConnectionFace::Reconnecting)
        );
        // A later socket opens, pings and sends its opening set: still
        // reconnecting, since nothing has answered on it.
        reading.opened(hand.wait(1_000));
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.wait(10));
        assert_eq!(
            face(&mut reading, hand.wait(1_500)),
            Some(ConnectionFace::Reconnecting),
            "a later socket's set ended reconnecting"
        );
        // Its first pong ends it.
        reading.pong(hand.wait(10));
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.face, ConnectionFace::Slow, "a 1.5 s reply");
        assert_eq!(health.since, hand.at().wall_ms);
        assert_eq!(health.rtt_ms, Some(1_520));
    }

    #[test]
    fn the_history_keeps_sixty_pings_with_their_misses() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 10);
        for n in 0..65u64 {
            reply(&mut reading, &mut hand, 3_000, 11 + n);
        }
        // Two pings waiting when the socket is lost: two misses.
        reading.ping_sent(hand.wait(3_000));
        reading.ping_sent(hand.wait(3_000));
        reading.lost(hand.wait(500));
        let samples = reading.health(hand.at()).unwrap().samples;
        assert_eq!(samples.len(), CONNECTION_SAMPLE_CAP);
        // The oldest kept is the 60th from the end: the replies of 18 ms to
        // 75 ms, then the misses.
        let kept: Vec<Option<u64>> = (18..=75).map(Some).chain([None, None]).collect();
        assert_eq!(samples, kept);
    }

    #[test]
    fn a_socket_lost_before_any_reply_records_no_miss() {
        let mut hand = Hand::new();
        let mut reading = ConnectionReading::default();
        reading.opened(hand.at());
        reading.ping_sent(hand.at());
        reading.lost(hand.wait(500));
        let health = reading.health(hand.at()).unwrap();
        assert!(health.samples.is_empty(), "{:?}", health.samples);
        assert_eq!(health.face, ConnectionFace::Reconnecting);
    }

    #[test]
    fn a_reply_over_45_s_is_not_timed() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        let late = wait_reported(&mut reading, &mut hand, 45_001);
        reading.pong(late);
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.rtt_ms, Some(40), "a 45.001 s reply was timed");
        assert_eq!(health.samples.len(), 1, "{:?}", health.samples);
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        let late = wait_reported(&mut reading, &mut hand, 45_000);
        reading.pong(late);
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.rtt_ms, Some(45_000), "a 45 s reply was not timed");
        assert_eq!(health.samples.len(), 2);
    }

    #[test]
    fn a_ping_across_a_sleep_that_pauses_the_monotonic_clock_is_not_timed() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        hand.wait(100);
        hand.sleep_paused(60_000);
        let health = reading.health(hand.wait(100)).unwrap();
        assert_eq!(
            health.face,
            ConnectionFace::Healthy,
            "a sleep read as a slow reply or a stall"
        );
        assert_eq!(
            health.wait_since, None,
            "a ping across a sleep kept its wait"
        );
        reading.pong(hand.wait(50));
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.rtt_ms, Some(40), "a ping across a sleep was timed");
        assert_eq!(health.samples.len(), 1);
        // The pong paired with the ping across the sleep: the next one is
        // timed.
        reply(&mut reading, &mut hand, 3_000, 60);
        assert_eq!(reading.health(hand.at()).unwrap().rtt_ms, Some(60));
    }

    #[test]
    fn a_ping_across_a_gap_in_reports_is_not_timed() {
        // A sleep on a monotonic clock that counts it: the pump reports every
        // 2 s while a ping waits, so a 30 s gap is a time it did not run.
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        reading.tick(hand.wait(900));
        let woke = hand.wait(30_000);
        assert!(!reading.tick(woke), "the wake changed the face");
        let health = reading.health(woke).unwrap();
        assert_eq!(
            health.face,
            ConnectionFace::Healthy,
            "a gap in reports read as a stall"
        );
        assert_eq!(health.wait_since, None);
        reading.pong(hand.wait(30));
        assert_eq!(reading.health(hand.at()).unwrap().rtt_ms, Some(40));
        // Reports 2 s apart are no gap: a real stall still reads.
        hand.wait(3_000);
        reading.ping_sent(hand.at());
        for _ in 0..3 {
            reading.tick(hand.wait(2_000));
        }
        assert_eq!(face(&mut reading, hand.at()), Some(ConnectionFace::Stalled));
    }

    /// Nothing reports the time while the first ping waits, before the
    /// devserver has answered, so its wait has no gap in reports to show: a
    /// first reply that took 7 s is timed. A sleep across it is still seen
    /// as a step of the wall clock.
    #[test]
    fn a_first_reply_longer_than_a_report_gap_is_timed() {
        let mut hand = Hand::new();
        let mut reading = ConnectionReading::default();
        reading.opened(hand.at());
        let sent = hand.at();
        reading.ping_sent(sent);
        reading.set_arrived(hand.wait(5));
        assert!(!reading.waits(), "the first ping asked for reports");
        reading.pong(hand.wait(6_995));
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(
            health.rtt_ms,
            Some(7_000),
            "a 7 s first reply was not timed"
        );
        assert_eq!(health.samples, [Some(7_000)]);
        assert_eq!(health.face, ConnectionFace::Slow);

        let mut hand = Hand::new();
        let mut reading = ConnectionReading::default();
        reading.opened(hand.at());
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.wait(5));
        hand.sleep_paused(60_000);
        reading.pong(hand.wait(100));
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.rtt_ms, None, "a first ping across a sleep was timed");
        assert!(health.samples.is_empty(), "{:?}", health.samples);
        assert_eq!(health.face, ConnectionFace::Healthy);
    }

    #[test]
    fn a_set_before_the_first_pong_shows_no_face_and_decides_nothing() {
        let mut hand = Hand::new();
        let mut reading = ConnectionReading::default();
        reading.opened(hand.at());
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.wait(5));
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Unknown),
            "the opening set decided something"
        );
        // A change's set ahead of the pong, or an older devserver's answer
        // to the ping: no face.
        assert!(reading.set_arrived(hand.wait(5)));
        assert_eq!(face(&mut reading, hand.at()), None);
        // A pong after it turns the reading on.
        assert!(reading.pong(hand.wait(30)));
        let health = reading.health(hand.at()).unwrap();
        assert_eq!(health.face, ConnectionFace::Healthy);
        assert_eq!(health.rtt_ms, Some(40));
    }

    #[test]
    fn an_older_devservers_later_socket_ends_reconnecting_with_no_face() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        reading.lost(hand.wait(1_000));
        reading.opened(hand.wait(2_000));
        reading.ping_sent(hand.at());
        reading.set_arrived(hand.wait(5));
        assert_eq!(
            face(&mut reading, hand.at()),
            Some(ConnectionFace::Reconnecting)
        );
        reading.set_arrived(hand.wait(5));
        assert_eq!(
            face(&mut reading, hand.wait(60_000)),
            None,
            "the set an older devserver sends for the ping kept reconnecting"
        );
    }

    #[test]
    fn pongs_pair_with_pings_in_order_past_the_cap() {
        let mut hand = Hand::new();
        let mut reading = answered(&mut hand, 40);
        let sent: Vec<Stamp> = (0..PENDING_CAP + 2)
            .map(|_| {
                let at = hand.wait(100);
                reading.ping_sent(at);
                at
            })
            .collect();
        hand.wait(100);
        for _ in 0..PENDING_CAP + 2 {
            reading.pong(hand.at());
        }
        let samples = reading.health(hand.at()).unwrap().samples;
        // The first answer plus the timed ones; the two past the cap were
        // counted, not timed.
        assert_eq!(samples.len(), 1 + PENDING_CAP);
        // The pings left 100 ms apart, so each reply time names its ping.
        for (rtt_ms, at) in samples[1..].iter().zip(&sent) {
            assert_eq!(
                *rtt_ms,
                Some(hand.at().wall_ms - at.wall_ms),
                "a pong paired with another ping"
            );
        }
        // A ping sent while counted ones wait behind is counted too, so its
        // pong is never another ping's.
        assert!(!reading.waits());
    }

    /// The desktop gaining the focus is one change of the pace, carrying
    /// the focus and its ping together. A subscriber cannot tell one change
    /// from two sent in a row, since a watch keeps only the latest value,
    /// so the change itself is read.
    #[test]
    fn a_focus_gain_is_one_change_of_the_pace() {
        let mut pace = ProbePace::default();
        assert!(pace.take_focus(true));
        assert_eq!(
            pace,
            ProbePace {
                focused: true,
                nudges: 1
            },
            "the gain's change left its ping to another"
        );
        assert!(!pace.take_focus(true), "a held focus changed the pace");
        assert_eq!(pace.nudges, 1);
        assert!(pace.take_focus(false));
        assert_eq!(
            pace,
            ProbePace {
                focused: false,
                nudges: 1
            }
        );
    }

    #[test]
    fn the_desktop_gaining_the_focus_asks_for_one_ping() {
        let pacer = ProbePacer::default();
        let pace = pacer.subscribe();
        assert_eq!(*pace.borrow(), ProbePace::default());
        pacer.window_focus("a", true);
        assert_eq!(
            *pace.borrow(),
            ProbePace {
                focused: true,
                nudges: 1
            }
        );
        // The focus moving to another window, gain first: no new ping.
        pacer.window_focus("b", true);
        pacer.window_focus("a", false);
        assert_eq!(
            *pace.borrow(),
            ProbePace {
                focused: true,
                nudges: 1
            }
        );
        // Loss first, the move is the desktop losing the focus and gaining
        // it again: one ping.
        pacer.window_focus("b", false);
        assert!(!pace.borrow().focused);
        pacer.window_focus("c", true);
        assert_eq!(
            *pace.borrow(),
            ProbePace {
                focused: true,
                nudges: 2
            }
        );
        // The last focused window going away is the desktop losing it.
        pacer.window_focus("c", false);
        assert_eq!(
            *pace.borrow(),
            ProbePace {
                focused: false,
                nudges: 2
            }
        );
        pacer.window_focus("d", true);
        assert_eq!(pace.borrow().nudges, 3);
        pacer.ping_now();
        assert_eq!(pace.borrow().nudges, 4);
    }

    /// The reports Windows makes while a window's Computers screen holds the
    /// keyboard: the window's own webview loses the focus to the screen, and
    /// the screen's webview reports its gain and its loss.
    #[test]
    fn a_window_whose_computers_screen_holds_the_keyboard_keeps_the_focus() {
        let focused = |nudges| ProbePace {
            focused: true,
            nudges,
        };
        let pacer = ProbePacer::default();
        let pace = pacer.subscribe();
        pacer.window_focus("w", true);
        assert_eq!(*pace.borrow(), focused(1));
        // The screen shows and takes the keyboard, its gain reported first.
        pacer.screen_focus("w", true);
        pacer.window_focus("w", false);
        assert_eq!(
            *pace.borrow(),
            focused(1),
            "the screen taking the keyboard read as the window losing it"
        );
        // The user goes to another application.
        pacer.screen_focus("w", false);
        assert!(!pace.borrow().focused, "a screen's loss kept the focus");
        // The user comes back: the window's webview gains the focus, and the
        // screen takes the keyboard back from it.
        pacer.window_focus("w", true);
        pacer.screen_focus("w", true);
        pacer.window_focus("w", false);
        assert_eq!(*pace.borrow(), focused(2));
        // The screen hides and hands the keyboard to the window's webview.
        pacer.screen_focus("w", false);
        pacer.window_focus("w", true);
        assert!(pace.borrow().focused);
        // The window's loss, reported before its screen's gain.
        pacer.window_focus("w", false);
        pacer.screen_focus("w", true);
        assert!(pace.borrow().focused);
        // Another window's focus is no screen's: the screen of "w" keeps
        // the desktop focused after "v" loses it.
        pacer.window_focus("v", true);
        pacer.window_focus("v", false);
        assert!(pace.borrow().focused);
        pacer.screen_focus("w", false);
        assert!(!pace.borrow().focused);
    }
}
