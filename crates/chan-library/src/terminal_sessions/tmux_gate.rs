//! The tmux control-mode gate: the marker policy, the consent question and
//! the hardening that follows an allow, as a state machine fed by a
//! session's output bytes and ticked by the registry's drainer. It keeps no
//! clock of its own: every call takes the moment it happens at.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chan_tmux::{
    Client, Command, Event, Limits, Message, PaneId, SessionId, Token, Version, WindowId,
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::tmux_connection::{
    self, Purpose, Step, TmuxConnection, TmuxConnectionStatus, TmuxWork, WorkDone,
};
use super::{PtyCommand, TerminalExit, TmuxConnectionId};
use crate::config::TerminalTmuxConfig;

/// Numbers connections across the process.
static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

/// How long an unanswered question stands before it is a deny.
pub const QUESTION_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the peer has, after an allow, to announce a session and answer
/// the version probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a denied or ended stream is swallowed waiting for its `%exit`
/// before plain output resumes regardless.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Most bytes read while a question stands; past it the question is a deny,
/// since the peer is flooding rather than waiting.
const HELD_BYTES_MAX: usize = 1 << 20;
/// The oldest tmux the gate connects to.
const VERSION_FLOOR: Version = Version { major: 3, minor: 2 };

/// What the OS reports running in the PTY's foreground as the marker arrives.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Foreground {
    /// The process name, as `comm` on Linux.
    pub name: Option<String>,
    /// Its command line where the OS lets it be read.
    pub command: Option<String>,
}

/// The question attached pages show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxQuestion {
    /// The foreground program's name, or `unknown`.
    pub program: String,
    /// Its command line where the OS lets it be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Seconds the question stands before it is a deny.
    pub timeout_secs: u64,
}

/// The consent state a session publishes. `revision` orders snapshots;
/// `question` is the one open, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct TmuxConsentSnapshot {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<TmuxQuestion>,
}

/// The connection state a session publishes for the control terminal's
/// status view. `revision` orders snapshots; `connection` is set while
/// connected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct TmuxStatus {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<TmuxConnectionStatus>,
}

/// A client's request of a live connection, from the status view. One with
/// no connection changes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "request", rename_all = "kebab-case")]
pub enum TmuxRequest {
    /// Open a tmux window past the cap: its panes get sessions and a chan
    /// window is minted for it. `window` is tmux's id, `@N`.
    OpenWindow { window: String },
    /// Make a new tmux window, which opens in a chan window of its own, past
    /// the cap if need be.
    NewWindow,
    /// Split tmux pane `pane` (`%N`), side by side when `horizontal`; the
    /// new pane arrives through the window's layout.
    Split { pane: String, horizontal: bool },
    /// Make `pane` tmux's active pane, after a client's focus moved to it.
    Focus { pane: String },
    /// Size the tmux window that holds `pane` (`%N`) to `cols` by `rows`:
    /// the grid a chan window's panes can show together, dividers counted
    /// as tmux draws them. tmux lays its panes out inside and tells each
    /// pane session its size.
    WindowSize { pane: String, cols: u32, rows: u32 },
    /// Detach the control client; the tmux server and its sessions live on.
    Detach,
    /// End the tmux server with every session it holds.
    End,
}

/// A client's answer to the question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TmuxAnswer {
    Allow,
    /// Allow, and ask no more on this session.
    AllowForTab,
    Deny,
}

/// What the session does after a feed, an answer or a tick.
#[derive(Debug)]
pub(super) enum Action {
    /// Write these bytes to the PTY, as one write.
    Write(Vec<u8>),
    /// Show this line of chan's own to the user, in the terminal.
    Notice(String),
    /// Something the registry does for the connection, off the gate lock.
    Work(TmuxWork),
    /// The connection is made: give the control session a window of its
    /// own, titled `title`.
    ControlWindow { title: String },
}

/// What a feed hands back: the bytes that go on to the ring, and the
/// actions the feed decided.
#[derive(Debug, Default)]
pub(super) struct Fed {
    pub passthrough: Vec<u8>,
    pub actions: Vec<Action>,
}

#[derive(Debug)]
enum Phase {
    /// Ordinary terminal output.
    Plain,
    /// The marker arrived from a foreground that is not trusted; the
    /// question stands and the protocol read meanwhile is held.
    Asking {
        deadline: Instant,
        held: Vec<Event>,
        held_bytes: usize,
    },
    /// Allowed: waiting for the peer to announce a session, then to answer
    /// the version probe.
    Probing {
        deadline: Instant,
        probe: Option<Token>,
        /// The session the peer announced, for the connection's status.
        session: Option<(SessionId, String)>,
    },
    /// Connected to a tmux at or past the floor: the connection keeps its
    /// windows and panes.
    Connected {
        version: Version,
        connection: Box<TmuxConnection>,
    },
    /// Denied or ended: protocol lines are swallowed until `%exit` or the
    /// deadline, so none of them draw.
    Draining { deadline: Instant },
}

/// One session's gate.
#[derive(Debug)]
pub(super) struct TmuxGate {
    client: Client,
    policy: TerminalTmuxConfig,
    /// The terminal scrollback setting, which sizes a pane's capture.
    scrollback_mb: u32,
    phase: Phase,
    /// An earlier answer of allow-for-tab; dies with the session.
    allow_for_tab: bool,
    published: watch::Sender<Arc<TmuxConsentSnapshot>>,
    revision: u64,
    status: watch::Sender<Arc<TmuxStatus>>,
    status_revision: u64,
}

impl TmuxGate {
    pub(super) fn new(policy: TerminalTmuxConfig, scrollback_mb: u32) -> Self {
        let mut client = Client::new(Limits::default());
        client.arm(policy.enabled);
        let (published, _) = watch::channel(Arc::new(TmuxConsentSnapshot::default()));
        let (status, _) = watch::channel(Arc::new(TmuxStatus::default()));
        Self {
            client,
            policy,
            scrollback_mb,
            phase: Phase::Plain,
            allow_for_tab: false,
            published,
            revision: 0,
            status,
            status_revision: 0,
        }
    }

    /// Follow a policy change: the marker is recognized or not from here
    /// on. A connection already in control mode runs on until it ends, and
    /// an open question stands until it is answered or times out.
    pub(super) fn set_policy(&mut self, policy: TerminalTmuxConfig) {
        self.client.arm(policy.enabled);
        self.policy = policy;
    }

    /// Whether the stream is inside control mode.
    #[cfg(test)]
    pub(super) fn in_control_mode(&self) -> bool {
        self.client.in_control_mode()
    }

    /// The connected tmux's version, once connected.
    #[cfg(test)]
    pub(super) fn connected_version(&self) -> Option<Version> {
        match &self.phase {
            Phase::Connected { version, .. } => Some(*version),
            _ => None,
        }
    }

    /// The connection, while connected.
    #[cfg(test)]
    pub(super) fn connection(&self) -> Option<&TmuxConnection> {
        match &self.phase {
            Phase::Connected { connection, .. } => Some(connection),
            _ => None,
        }
    }

    /// The registry answered a piece of the connection's work.
    pub(super) fn work_done(&mut self, done: WorkDone, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Phase::Connected { connection, .. } = &mut self.phase {
            let steps = connection.on_work_done(done);
            if let Err(error) = drive(&mut self.client, connection, steps, &mut actions) {
                self.end_control(
                    &format!("tmux control mode ended: {error}"),
                    &mut actions,
                    now,
                );
            }
        }
        self.publish_status_if_dirty();
        actions
    }

    /// A client's request of the connection. Nothing happens without one,
    /// or for a window tmux has not listed.
    pub(super) fn request(&mut self, request: TmuxRequest, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        tracing::debug!(
            ?request,
            connected = matches!(self.phase, Phase::Connected { .. }),
            "tmux request at the gate"
        );
        if let Phase::Connected { connection, .. } = &mut self.phase {
            let steps = match request {
                TmuxRequest::OpenWindow { window } => match WindowId::parse(&window) {
                    Some(window) => connection.open_window(window),
                    None => Vec::new(),
                },
                TmuxRequest::NewWindow => connection.request_new_window(),
                TmuxRequest::Split { pane, horizontal } => match PaneId::parse(&pane) {
                    Some(pane) => connection.request_split(pane, horizontal),
                    None => Vec::new(),
                },
                TmuxRequest::Focus { pane } => match PaneId::parse(&pane) {
                    Some(pane) => connection.request_focus(pane),
                    None => Vec::new(),
                },
                TmuxRequest::WindowSize { pane, cols, rows } => match PaneId::parse(&pane) {
                    Some(pane) => connection.request_window_size(pane, cols, rows),
                    None => Vec::new(),
                },
                TmuxRequest::Detach => vec![Step::Submit(Command::Detach, Purpose::Fire)],
                TmuxRequest::End => vec![Step::Submit(Command::KillServer, Purpose::Fire)],
            };
            if let Err(error) = drive(&mut self.client, connection, steps, &mut actions) {
                self.end_control(
                    &format!("tmux control mode ended: {error}"),
                    &mut actions,
                    now,
                );
            }
        }
        self.publish_status_if_dirty();
        actions
    }

    /// A pane session's command, from the gateway thread.
    pub(super) fn pane_command(
        &mut self,
        pane: PaneId,
        command: PtyCommand,
        now: Instant,
    ) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Phase::Connected { connection, .. } = &mut self.phase {
            let steps = connection.on_pane_command(pane, command);
            if let Err(error) = drive(&mut self.client, connection, steps, &mut actions) {
                self.end_control(
                    &format!("tmux control mode ended: {error}"),
                    &mut actions,
                    now,
                );
            }
        }
        self.publish_status_if_dirty();
        actions
    }

    /// The control session's process ended: whatever tmux did not say, the
    /// connection is over.
    pub(super) fn control_exited(&mut self) -> Vec<Action> {
        let mut actions = Vec::new();
        self.end_connection(TerminalExit::Unknown, &mut actions);
        if !matches!(self.phase, Phase::Plain) {
            self.reset();
        }
        actions
    }

    /// End the connection's panes and windows, if there is one.
    fn end_connection(&mut self, exit: TerminalExit, actions: &mut Vec<Action>) {
        if let Phase::Connected { connection, .. } = &mut self.phase {
            for step in connection.on_end(exit) {
                if let Step::Action(action) = step {
                    actions.push(action);
                }
            }
            self.publish_status(None);
        }
    }

    /// Whether a client's typed bytes may reach the PTY: only while the
    /// stream is plain. From the marker on, the PTY's input is the protocol,
    /// and a byte typed into it would be a command the client never paired
    /// (or, while the question stands, a write the answer has not allowed).
    pub(super) fn accepts_input(&self) -> bool {
        matches!(self.phase, Phase::Plain)
    }

    /// Whether a question stands.
    #[cfg(test)]
    pub(super) fn asking(&self) -> bool {
        matches!(self.phase, Phase::Asking { .. })
    }

    /// The current consent snapshot and a receiver of the ones to come.
    pub(super) fn subscribe(
        &self,
    ) -> (
        Arc<TmuxConsentSnapshot>,
        watch::Receiver<Arc<TmuxConsentSnapshot>>,
    ) {
        let mut rx = self.published.subscribe();
        let current = rx.borrow_and_update().clone();
        (current, rx)
    }

    /// The current connection status and a receiver of the ones to come.
    pub(super) fn subscribe_status(&self) -> (Arc<TmuxStatus>, watch::Receiver<Arc<TmuxStatus>>) {
        let mut rx = self.status.subscribe();
        let current = rx.borrow_and_update().clone();
        (current, rx)
    }

    /// Decode bytes the PTY produced. `foreground` is read only when the
    /// marker arrives.
    pub(super) fn feed(
        &mut self,
        bytes: &[u8],
        now: Instant,
        foreground: impl FnOnce() -> Foreground,
    ) -> Fed {
        let mut fed = Fed::default();
        if let Phase::Asking { held_bytes, .. } = &mut self.phase {
            *held_bytes += bytes.len();
            if *held_bytes > HELD_BYTES_MAX {
                self.deny(
                    "denied: too much output while the question stood",
                    now,
                    &mut fed.actions,
                );
                return fed;
            }
        }
        let events = match self.client.feed(bytes) {
            Ok(events) => events,
            Err(error) => {
                self.end(
                    &format!("tmux control mode ended: {error}"),
                    &mut fed.actions,
                );
                return fed;
            }
        };
        let mut foreground = Some(foreground);
        for event in events {
            match event {
                Event::Passthrough(data) => fed.passthrough.extend_from_slice(&data),
                Event::Entered => {
                    // The marker's bytes passed as they came; the terminal
                    // is inside an empty DCS, closed here so nothing of
                    // what follows is taken for its body.
                    fed.passthrough.extend_from_slice(b"\x1b\\");
                    let fg = foreground.take().map(|f| f()).unwrap_or_default();
                    self.entered(fg, now, &mut fed.actions);
                }
                event => self.event(event, now, &mut fed.actions),
            }
        }
        self.publish_status_if_dirty();
        fed
    }

    /// A client's answer. The first answer wins; one with no question
    /// standing is ignored.
    pub(super) fn answer(&mut self, answer: TmuxAnswer, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        let Phase::Asking { held, .. } = &mut self.phase else {
            return actions;
        };
        let held = std::mem::take(held);
        match answer {
            TmuxAnswer::Deny => {
                self.deny("denied", now, &mut actions);
            }
            TmuxAnswer::Allow | TmuxAnswer::AllowForTab => {
                self.publish(None);
                if answer == TmuxAnswer::AllowForTab {
                    self.allow_for_tab = true;
                }
                self.phase = Phase::Probing {
                    deadline: now + PROBE_TIMEOUT,
                    probe: None,
                    session: None,
                };
                for event in held {
                    self.event(event, now, &mut actions);
                }
            }
        }
        actions
    }

    /// Time passing: the question's, the probe's and the drain's deadlines.
    pub(super) fn tick(&mut self, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        match &self.phase {
            Phase::Asking { deadline, .. } if now >= *deadline => {
                self.deny("denied: no answer", now, &mut actions);
            }
            Phase::Probing {
                deadline, probe, ..
            } if now >= *deadline => {
                if probe.is_some() {
                    self.end_control(
                        "tmux control mode ended: no version reply",
                        &mut actions,
                        now,
                    );
                } else {
                    // The peer never announced a session, so it is not tmux:
                    // cancel whatever line a shell may be holding and draw
                    // its output again.
                    actions.push(Action::Write(b"\x03".to_vec()));
                    self.end(
                        "tmux control mode ended: no session announced",
                        &mut actions,
                    );
                }
            }
            Phase::Draining { deadline } if now >= *deadline => {
                self.reset();
            }
            _ => {}
        }
        actions
    }

    fn entered(&mut self, foreground: Foreground, now: Instant, actions: &mut Vec<Action>) {
        let trusted = foreground
            .name
            .as_deref()
            .map(program_word)
            .is_some_and(|word| word == "tmux" || self.policy.trust.iter().any(|t| t == word));
        if trusted || self.allow_for_tab {
            self.phase = Phase::Probing {
                deadline: now + PROBE_TIMEOUT,
                probe: None,
                session: None,
            };
            return;
        }
        self.phase = Phase::Asking {
            deadline: now + QUESTION_TIMEOUT,
            held: Vec::new(),
            held_bytes: 0,
        };
        self.publish(Some(TmuxQuestion {
            program: foreground.name.unwrap_or_else(|| "unknown".to_owned()),
            command: foreground.command,
            timeout_secs: QUESTION_TIMEOUT.as_secs(),
        }));
        let _ = actions;
    }

    fn event(&mut self, event: Event, now: Instant, actions: &mut Vec<Action>) {
        match &mut self.phase {
            Phase::Plain => {}
            Phase::Asking { held, .. } => held.push(event),
            Phase::Probing { probe, session, .. } => match event {
                Event::Message(Message::SessionChanged {
                    session: announced,
                    name,
                }) if probe.is_none() => match self.submit_probe(actions) {
                    Ok(token) => {
                        if let Phase::Probing { probe, session, .. } = &mut self.phase {
                            *probe = Some(token);
                            *session = Some((announced, name));
                        }
                    }
                    Err(error) => {
                        self.end_control(&format!("tmux control mode ended: {error}"), actions, now)
                    }
                },
                Event::Reply { token, result } if Some(token) == *probe => {
                    let announced = session.take();
                    let control_title = match &announced {
                        Some((_, name)) if !name.is_empty() => format!("tmux {name}"),
                        _ => "tmux".to_owned(),
                    };
                    let version = result
                        .ok()
                        .and_then(|rows| rows.into_iter().next())
                        .and_then(|row| String::from_utf8(row).ok())
                        .and_then(|text| Version::parse(&text));
                    match version {
                        Some(version) if version >= VERSION_FLOOR => {
                            let id =
                                TmuxConnectionId(NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed));
                            let (mut connection, rx) =
                                TmuxConnection::new(id, version, self.scrollback_mb, announced);
                            actions.push(Action::Notice(format!(
                                "tmux {}.{} control mode",
                                version.major, version.minor
                            )));
                            actions
                                .push(Action::Work(TmuxWork::StartGateway { connection: id, rx }));
                            actions.push(Action::ControlWindow {
                                title: control_title,
                            });
                            let steps = connection.start();
                            if let Err(error) =
                                drive(&mut self.client, &mut connection, steps, actions)
                            {
                                self.end_control(
                                    &format!("tmux control mode ended: {error}"),
                                    actions,
                                    now,
                                );
                                return;
                            }
                            self.phase = Phase::Connected {
                                version,
                                connection: Box::new(connection),
                            };
                            self.publish_status_if_dirty();
                        }
                        Some(version) => self.end_control(
                            &format!(
                                "tmux {}.{} is older than {}.{}; detached",
                                version.major,
                                version.minor,
                                VERSION_FLOOR.major,
                                VERSION_FLOOR.minor
                            ),
                            actions,
                            now,
                        ),
                        None => self.end_control(
                            "tmux control mode ended: no version reply",
                            actions,
                            now,
                        ),
                    }
                }
                Event::Exited { reason, .. } => self.exited("tmux", reason, actions),
                _ => {}
            },
            Phase::Connected {
                version,
                connection,
            } => {
                if let Event::Exited { reason, .. } = event {
                    let what = format!("tmux {}.{}", version.major, version.minor);
                    self.end_connection(TerminalExit::Code { code: 0 }, actions);
                    self.exited(&what, reason, actions);
                    return;
                }
                let steps = tmux_connection::event_steps(connection, event);
                if let Err(error) = drive(&mut self.client, connection, steps, actions) {
                    self.end_control(&format!("tmux control mode ended: {error}"), actions, now);
                }
            }
            Phase::Draining { .. } => {
                if let Event::Exited { .. } = event {
                    self.reset();
                }
            }
        }
    }

    /// The interrupt line, then the version probe, each written on its own.
    fn submit_probe(&mut self, actions: &mut Vec<Action>) -> Result<Token, chan_tmux::Error> {
        let (_, interrupt) = self.client.submit(&Command::Interrupt)?;
        actions.push(Action::Write(interrupt));
        let (token, probe) = self.client.submit(&Command::Version)?;
        actions.push(Action::Write(probe));
        Ok(token)
    }

    fn exited(&mut self, what: &str, reason: Option<String>, actions: &mut Vec<Action>) {
        let notice = match reason {
            Some(reason) => format!("{what} control mode ended: {reason}"),
            None => format!("{what} control mode ended"),
        };
        actions.push(Action::Notice(notice));
        self.phase = Phase::Plain;
    }

    /// Deny: withdraw the question, write one newline, which detaches a real
    /// tmux, then swallow the protocol until its `%exit`.
    fn deny(&mut self, why: &str, now: Instant, actions: &mut Vec<Action>) {
        self.publish(None);
        actions.push(Action::Write(b"\n".to_vec()));
        actions.push(Action::Notice(format!("tmux control mode {why}")));
        self.phase = Phase::Draining {
            deadline: now + DRAIN_TIMEOUT,
        };
    }

    /// Leave a control mode the peer answered in: detach, then swallow the
    /// protocol until its `%exit`.
    fn end_control(&mut self, notice: &str, actions: &mut Vec<Action>, now: Instant) {
        self.end_connection(TerminalExit::Unknown, actions);
        if let Ok((_, detach)) = self.client.submit(&Command::Detach) {
            actions.push(Action::Write(detach));
        }
        actions.push(Action::Notice(notice.to_owned()));
        self.phase = Phase::Draining {
            deadline: now + DRAIN_TIMEOUT,
        };
    }

    /// Leave a stream that cannot be trusted any further: the bytes draw as
    /// plain output from here on.
    fn end(&mut self, notice: &str, actions: &mut Vec<Action>) {
        self.end_connection(TerminalExit::Unknown, actions);
        actions.push(Action::Notice(notice.to_owned()));
        self.reset();
    }

    fn reset(&mut self) {
        self.client = Client::new(Limits::default());
        self.client.arm(self.policy.enabled);
        self.phase = Phase::Plain;
    }

    fn publish(&mut self, question: Option<TmuxQuestion>) {
        self.revision += 1;
        self.published.send_replace(Arc::new(TmuxConsentSnapshot {
            revision: self.revision,
            question,
        }));
    }

    /// Publish the connection's status when it changed since the last one.
    fn publish_status_if_dirty(&mut self) {
        let Phase::Connected { connection, .. } = &mut self.phase else {
            return;
        };
        if !connection.take_dirty() {
            return;
        }
        let snapshot = connection.status();
        self.publish_status(Some(snapshot));
    }

    fn publish_status(&mut self, connection: Option<TmuxConnectionStatus>) {
        self.status_revision += 1;
        self.status.send_replace(Arc::new(TmuxStatus {
            revision: self.status_revision,
            connection,
        }));
    }
}

/// Submit the connection's commands through the client and collect its
/// actions. A full queue keeps typed keys in the connection's backlog and
/// drops anything else, which a later reply resubmits or the state replaces;
/// any other refusal is the stream's and ends it.
fn drive(
    client: &mut Client,
    connection: &mut TmuxConnection,
    steps: Vec<Step>,
    actions: &mut Vec<Action>,
) -> Result<(), chan_tmux::Error> {
    for step in steps {
        match step {
            Step::Action(action) => actions.push(action),
            Step::Submit(command, purpose) => match client.submit(&command) {
                Ok((token, bytes)) => {
                    connection.submitted(token, purpose);
                    actions.push(Action::Write(bytes));
                }
                Err(chan_tmux::Error::TooManyPending) => {
                    if let Command::SendKeys { pane, bytes } = command {
                        connection.backlog(pane, bytes);
                    } else {
                        tracing::debug!(?purpose, "tmux command queue full; dropped");
                    }
                }
                Err(chan_tmux::Error::BadArgument(what)) => {
                    tracing::warn!(what, ?purpose, "tmux command refused");
                }
                Err(error) => return Err(error),
            },
        }
    }
    Ok(())
}

/// The program a process name names: its first word, since a program that
/// titles itself, as tmux does with `tmux: client`, changes the name the OS
/// reports.
fn program_word(name: &str) -> &str {
    name.split([':', ' ']).next().unwrap_or("")
}

/// The name and command line of a process, read from `/proc`.
#[cfg(target_os = "linux")]
pub(super) fn process_foreground(pid: u32) -> Foreground {
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|comm| comm.trim_end().to_owned())
        .filter(|comm| !comm.is_empty());
    let command = std::fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|raw| {
            let text = String::from_utf8_lossy(&raw).replace('\0', " ");
            let text = text.trim_end().to_owned();
            text.chars().take(240).collect::<String>()
        })
        .filter(|command| !command.is_empty());
    Foreground { name, command }
}

/// The name and command line of a process where there is no `/proc` to
/// read, through the process table.
#[cfg(any(target_os = "macos", target_os = "freebsd"))]
pub(super) fn process_foreground(pid: u32) -> Foreground {
    process_foreground_from_table(pid)
}

/// Not read on this platform: an unknown foreground, which asks.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "freebsd")))]
pub(super) fn process_foreground(_pid: u32) -> Foreground {
    Foreground::default()
}

/// The process table's word on `pid`: its name and its arguments. Linux
/// reads `/proc` instead and compiles this for its test alone, so the shared
/// path is run on every platform the gate reads a foreground on.
#[cfg(any(target_os = "macos", target_os = "freebsd", test))]
fn process_foreground_from_table(pid: u32) -> Foreground {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let Ok(mut system) = System::new() else {
        return Foreground::default();
    };
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let Some(process) = system.process(pid) else {
        return Foreground::default();
    };
    let name = process.name().to_string_lossy().into_owned();
    let command = process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    Foreground {
        name: (!name.is_empty()).then_some(name),
        command: (!command.is_empty()).then(|| command.chars().take(240).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &[u8] = b"\x1bP1000p";
    /// What the terminal is shown of an entry: the marker, then the ST that
    /// closes it.
    const SHOWN: &[u8] = b"\x1bP1000p\x1b\\";
    const ENTRY: &[u8] =
        b"%begin 1 1 0\r\n%end 1 1 0\r\n%sessions-changed\r\n%session-changed $0 main\r\n";

    fn policy(enabled: bool, trust: &[&str]) -> TerminalTmuxConfig {
        TerminalTmuxConfig {
            enabled,
            trust: trust.iter().map(|t| (*t).to_owned()).collect(),
        }
    }

    fn tmux() -> Foreground {
        Foreground {
            name: Some("tmux".into()),
            command: Some("tmux -CC".into()),
        }
    }

    fn ssh() -> Foreground {
        Foreground {
            name: Some("ssh".into()),
            command: Some("ssh host tmux -CC".into()),
        }
    }

    fn entry() -> Vec<u8> {
        let mut s = MARKER.to_vec();
        s.extend_from_slice(ENTRY);
        s
    }

    fn writes(actions: &[Action]) -> Vec<Vec<u8>> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Write(bytes) => Some(bytes.clone()),
                Action::Notice(_) | Action::Work(_) | Action::ControlWindow { .. } => None,
            })
            .collect()
    }

    fn notices(actions: &[Action]) -> Vec<String> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Notice(text) => Some(text.clone()),
                Action::Write(_) | Action::Work(_) | Action::ControlWindow { .. } => None,
            })
            .collect()
    }

    fn question(gate: &TmuxGate) -> Option<TmuxQuestion> {
        gate.subscribe().0.question.clone()
    }

    #[test]
    fn a_local_tmux_enters_without_a_question_and_is_probed() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        let fed = gate.feed(b"$ tmux -CC\r\n", now, tmux);
        assert_eq!(fed.passthrough, b"$ tmux -CC\r\n");
        let fed = gate.feed(&entry(), now, tmux);
        assert_eq!(
            fed.passthrough, SHOWN,
            "the empty DCS, nothing of the protocol"
        );
        assert!(question(&gate).is_none());
        assert_eq!(
            writes(&fed.actions),
            vec![
                b"\x03\n".to_vec(),
                b"display-message -p '#{version}'\n".to_vec()
            ],
            "the interrupt line, then the probe, each its own write"
        );
        let fed = gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        assert_eq!(
            gate.connected_version(),
            Some(Version { major: 3, minor: 8 })
        );
        assert_eq!(notices(&fed.actions), vec!["tmux 3.8 control mode"]);
        let fed = gate.feed(b"%exit\r\n\x1b\\$ ", now, tmux);
        assert_eq!(notices(&fed.actions), vec!["tmux 3.8 control mode ended"]);
        assert_eq!(fed.passthrough, b"$ ", "plain output resumes after the ST");
        assert!(!gate.in_control_mode());
    }

    #[test]
    fn another_foreground_asks_and_writes_nothing_meanwhile() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        let fed = gate.feed(&entry(), now, ssh);
        assert_eq!(fed.passthrough, SHOWN);
        assert!(fed.actions.is_empty());
        let q = question(&gate).expect("a question");
        assert_eq!(q.program, "ssh");
        assert_eq!(q.command.as_deref(), Some("ssh host tmux -CC"));
        assert_eq!(q.timeout_secs, 60);
        // Protocol lines while the question stands are held, not drawn.
        let fed = gate.feed(b"%output %0 hello\r\n", now, ssh);
        assert!(fed.passthrough.is_empty() && fed.actions.is_empty());
        assert!(gate.asking());
    }

    #[test]
    fn allow_replays_the_held_session_and_probes() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        let actions = gate.answer(TmuxAnswer::Allow, now);
        assert!(question(&gate).is_none(), "the question is withdrawn");
        assert_eq!(writes(&actions).len(), 2, "{actions:?}");
        gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.4\r\n%end 2 3 1\r\n",
            now,
            ssh,
        );
        assert_eq!(
            gate.connected_version(),
            Some(Version { major: 3, minor: 4 })
        );
        // A second answer changes nothing.
        assert!(gate.answer(TmuxAnswer::Deny, now).is_empty());
    }

    #[test]
    fn deny_writes_one_newline_and_drains_until_exit() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        let actions = gate.answer(TmuxAnswer::Deny, now);
        assert_eq!(writes(&actions), vec![b"\n".to_vec()]);
        assert_eq!(notices(&actions), vec!["tmux control mode denied"]);
        assert!(question(&gate).is_none());
        let fed = gate.feed(b"%output %0 last\r\n%exit\r\n\x1b\\$ ", now, ssh);
        assert_eq!(fed.passthrough, b"$ ", "nothing of the protocol drew");
        assert!(fed.actions.is_empty());
        assert!(!gate.in_control_mode());
    }

    #[test]
    fn a_stream_that_breaks_while_draining_is_plain_from_the_next_read() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        gate.answer(TmuxAnswer::Deny, now);
        // A reply no command asked for: the framing is lost with the rest
        // of this read, and nothing of it draws.
        let fed = gate.feed(b"%begin 2 2 1\r\nx\r\n%end 2 2 1\r\n$ ", now, ssh);
        assert!(fed.passthrough.is_empty());
        assert!(!gate.in_control_mode());
        assert_eq!(gate.feed(b"$ ", now, ssh).passthrough, b"$ ");
    }

    #[test]
    fn a_drain_that_never_sees_exit_ends_at_its_deadline() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        gate.answer(TmuxAnswer::Deny, now);
        gate.feed(b"%output %0 still here\r\n", now, ssh);
        assert!(gate.tick(now + DRAIN_TIMEOUT).is_empty());
        assert!(!gate.in_control_mode());
        let fed = gate.feed(b"plain again", now, ssh);
        assert_eq!(fed.passthrough, b"plain again");
    }

    #[test]
    fn no_answer_in_time_is_a_deny() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        assert!(gate
            .tick(now + QUESTION_TIMEOUT - Duration::from_secs(1))
            .is_empty());
        let actions = gate.tick(now + QUESTION_TIMEOUT);
        assert_eq!(writes(&actions), vec![b"\n".to_vec()]);
        assert_eq!(
            notices(&actions),
            vec!["tmux control mode denied: no answer"]
        );
        assert!(question(&gate).is_none());
    }

    #[test]
    fn allow_for_tab_skips_the_next_question() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        gate.answer(TmuxAnswer::AllowForTab, now);
        gate.feed(b"%exit\r\n\x1b\\", now, ssh);
        let fed = gate.feed(&entry(), now, ssh);
        assert!(question(&gate).is_none());
        assert_eq!(writes(&fed.actions).len(), 2, "probed at once: {fed:?}");
    }

    #[test]
    fn a_retitled_tmux_enters_at_once() {
        // tmux titles its processes, so Linux reports the client as this.
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        let fed = gate.feed(&entry(), now, || Foreground {
            name: Some("tmux: client".into()),
            command: Some("tmux: client".into()),
        });
        assert!(question(&gate).is_none());
        assert_eq!(writes(&fed.actions).len(), 2);
        assert_eq!(program_word("tmux: client"), "tmux");
        assert_eq!(program_word("sshd: alex [priv]"), "sshd");
        assert_eq!(program_word("ssh"), "ssh");
        assert_eq!(program_word(""), "");
    }

    #[test]
    fn typed_input_is_refused_from_the_marker_until_the_stream_is_plain_again() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        assert!(gate.accepts_input());
        gate.feed(&entry(), now, ssh);
        assert!(!gate.accepts_input(), "not while the question stands");
        gate.answer(TmuxAnswer::Allow, now);
        assert!(!gate.accepts_input(), "not while probing");
        gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            ssh,
        );
        assert!(!gate.accepts_input(), "not while connected");
        gate.feed(b"%exit\r\n\x1b\\", now, ssh);
        assert!(gate.accepts_input(), "plain again after the exit");
    }

    #[test]
    fn a_trusted_name_enters_at_once() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &["ssh"]), 10);
        let fed = gate.feed(&entry(), now, ssh);
        assert!(question(&gate).is_none());
        assert_eq!(writes(&fed.actions).len(), 2);
    }

    #[test]
    fn an_unknown_foreground_asks_as_unknown() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, Foreground::default);
        assert_eq!(question(&gate).unwrap().program, "unknown");
    }

    #[test]
    fn disabled_passes_the_marker_through_as_bytes() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(false, &[]), 10);
        let fed = gate.feed(&entry(), now, tmux);
        assert_eq!(fed.passthrough, entry());
        assert!(fed.actions.is_empty() && question(&gate).is_none());
    }

    #[test]
    fn a_connected_gate_publishes_its_status_and_its_end() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        let (initial, mut status_rx) = gate.subscribe_status();
        assert_eq!(initial.revision, 0);
        assert!(initial.connection.is_none());
        gate.feed(&entry(), now, tmux);
        assert!(
            !status_rx.has_changed().unwrap(),
            "probing publishes nothing"
        );
        gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        let status = status_rx.borrow_and_update().clone();
        let connection = status.connection.as_ref().expect("connected");
        assert_eq!(connection.version, "3.8");
        assert_eq!(
            connection.session,
            Some(tmux_connection::TmuxSessionStatus {
                id: "$0".into(),
                name: "main".into(),
            })
        );
        assert!(connection.windows.is_empty());
        assert_eq!(connection.window_cap, tmux_connection::WINDOW_CAP);
        assert!(connection.errors.is_empty());
        // A window tmux adds is listed open, with no chan window yet.
        gate.feed(b"%window-add @5\r\n", now, tmux);
        let status = status_rx.borrow_and_update().clone();
        assert_eq!(
            status.connection.as_ref().unwrap().windows,
            vec![tmux_connection::TmuxWindowStatus {
                id: "@5".into(),
                name: String::new(),
                panes: 0,
                open: true,
                chan_window: None,
            }]
        );
        // The host's answer and a rename land in it.
        gate.work_done(
            WorkDone::WindowMinted {
                key: WindowId(5),
                window_id: Some("w-1".into()),
            },
            now,
        );
        let status = status_rx.borrow_and_update().clone();
        assert_eq!(
            status.connection.as_ref().unwrap().windows[0]
                .chan_window
                .as_deref(),
            Some("w-1")
        );
        gate.feed(b"%window-renamed @5 logs\r\n", now, tmux);
        let status = status_rx.borrow_and_update().clone();
        assert_eq!(status.connection.as_ref().unwrap().windows[0].name, "logs");
        // Output alone is not a status change.
        gate.feed(b"%output %0 hi\r\n", now, tmux);
        assert!(!status_rx.has_changed().unwrap());
        // The end clears the connection.
        gate.feed(b"%exit\r\n\x1b\\", now, tmux);
        let status = status_rx.borrow_and_update().clone();
        assert!(status.connection.is_none());
        assert!(status.revision > initial.revision);
    }

    #[test]
    fn connecting_asks_for_a_control_window_titled_by_the_session() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, tmux);
        let fed = gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        let titles: Vec<&str> = fed
            .actions
            .iter()
            .filter_map(|a| match a {
                Action::ControlWindow { title } => Some(title.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(titles, vec!["tmux main"]);
        assert!(
            fed.actions.iter().any(|a| matches!(
                a,
                Action::Work(TmuxWork::StartGateway { connection, .. }) if connection.0 > 0
            )),
            "the gateway starts with the connection's id"
        );
    }

    #[test]
    fn a_new_window_request_submits_new_window() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, tmux);
        gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        let actions = gate.request(TmuxRequest::NewWindow, now);
        assert_eq!(
            writes(&actions),
            vec![b"new-window -PF '#{window_id}'\n".to_vec()]
        );
        assert_eq!(
            serde_json::from_str::<TmuxRequest>(r#"{"request":"new-window"}"#).unwrap(),
            TmuxRequest::NewWindow
        );
        assert_eq!(
            serde_json::from_str::<TmuxRequest>(
                r#"{"request":"window-size","pane":"%0","cols":120,"rows":40}"#
            )
            .unwrap(),
            TmuxRequest::WindowSize {
                pane: "%0".into(),
                cols: 120,
                rows: 40
            }
        );
    }

    #[test]
    fn requests_open_a_window_past_the_cap_detach_and_end() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        assert!(
            gate.request(TmuxRequest::Detach, now).is_empty(),
            "nothing without a connection"
        );
        gate.feed(&entry(), now, tmux);
        gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        let (_, mut status_rx) = gate.subscribe_status();
        let cap = tmux_connection::WINDOW_CAP;
        for n in 1..=(cap + 1) {
            gate.feed(format!("%window-add @{n}\r\n").as_bytes(), now, tmux);
        }
        let status = status_rx.borrow_and_update().clone();
        let windows = status.connection.as_ref().unwrap().windows.clone();
        assert_eq!(windows.len(), cap + 1);
        assert!(windows[..cap].iter().all(|w| w.open));
        assert!(
            !windows[cap].open,
            "the window past the cap is listed closed"
        );
        let past = windows[cap].id.clone();
        let actions = gate.request(
            TmuxRequest::OpenWindow {
                window: past.clone(),
            },
            now,
        );
        assert!(
            actions.iter().any(|a| matches!(
                a,
                Action::Work(TmuxWork::MintWindow { key, .. }) if key.to_string() == past
            )),
            "a chan window is asked for"
        );
        let written = writes(&actions);
        assert_eq!(written.len(), 1);
        assert!(
            written[0].starts_with(format!("list-panes -t {past}").as_bytes()),
            "its panes are listed: {:?}",
            String::from_utf8_lossy(&written[0])
        );
        let status = status_rx.borrow_and_update().clone();
        assert!(status.connection.as_ref().unwrap().windows[cap].open);
        // Again, for a window tmux has not listed, or for a bad id: nothing.
        assert!(gate
            .request(TmuxRequest::OpenWindow { window: past }, now)
            .is_empty());
        assert!(gate
            .request(
                TmuxRequest::OpenWindow {
                    window: "@77".into()
                },
                now
            )
            .is_empty());
        assert!(gate
            .request(
                TmuxRequest::OpenWindow {
                    window: "nine".into()
                },
                now
            )
            .is_empty());
        assert_eq!(
            writes(&gate.request(TmuxRequest::Detach, now)),
            vec![b"detach-client\n".to_vec()]
        );
        assert_eq!(
            writes(&gate.request(TmuxRequest::End, now)),
            vec![b"kill-server\n".to_vec()]
        );
    }

    #[test]
    fn turning_off_leaves_a_live_connection_alone() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, tmux);
        gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.8\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        gate.set_policy(policy(false, &[]));
        let fed = gate.feed(b"%output %0 hi\r\n", now, tmux);
        assert!(
            fed.passthrough.is_empty(),
            "the protocol is still swallowed"
        );
        assert!(gate.connected_version().is_some());
        // After it ends, the next marker is plain bytes.
        gate.feed(b"%exit\r\n\x1b\\", now, tmux);
        let fed = gate.feed(&entry(), now, tmux);
        assert_eq!(fed.passthrough, entry());
    }

    #[test]
    fn a_peer_that_never_announces_a_session_gets_an_interrupt_and_plain_output_back() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(MARKER, now, tmux);
        assert!(gate
            .tick(now + PROBE_TIMEOUT - Duration::from_millis(1))
            .is_empty());
        let actions = gate.tick(now + PROBE_TIMEOUT);
        assert_eq!(writes(&actions), vec![b"\x03".to_vec()]);
        assert_eq!(
            notices(&actions),
            vec!["tmux control mode ended: no session announced"]
        );
        let fed = gate.feed(b"$ ", now, tmux);
        assert_eq!(fed.passthrough, b"$ ");
    }

    #[test]
    fn a_peer_that_announces_but_never_answers_is_detached() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, tmux);
        let actions = gate.tick(now + PROBE_TIMEOUT);
        assert_eq!(writes(&actions), vec![b"detach-client\n".to_vec()]);
        assert_eq!(
            notices(&actions),
            vec!["tmux control mode ended: no version reply"]
        );
        let fed = gate.feed(b"%begin 9 9 1\r\n%end 9 9 1\r\n%exit\r\n\x1b\\", now, tmux);
        assert!(fed.passthrough.is_empty());
        assert!(!gate.in_control_mode());
    }

    #[test]
    fn a_version_below_the_floor_is_detached_with_the_reason() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, tmux);
        let fed = gate.feed(
            b"%begin 2 2 1\r\n%error 2 2 1\r\n%begin 2 3 1\r\n3.1\r\n%end 2 3 1\r\n",
            now,
            tmux,
        );
        assert_eq!(writes(&fed.actions), vec![b"detach-client\n".to_vec()]);
        assert_eq!(
            notices(&fed.actions),
            vec!["tmux 3.1 is older than 3.2; detached"]
        );
        assert!(gate.connected_version().is_none());
    }

    #[test]
    fn a_hostile_stream_while_asking_draws_nothing_and_a_deny_ends_it() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        let mut hostile = MARKER.to_vec();
        hostile.extend_from_slice(
            b"%session-changed $0 x\r\n%output %0 \\033[31mpwned\r\n%window-add @9\r\n",
        );
        let fed = gate.feed(&hostile, now, Foreground::default);
        assert_eq!(fed.passthrough, SHOWN);
        assert!(fed.actions.is_empty());
        let actions = gate.answer(TmuxAnswer::Deny, now);
        assert_eq!(writes(&actions), vec![b"\n".to_vec()]);
        let fed = gate.feed(b"%output %0 more\r\n", now, Foreground::default);
        assert!(fed.passthrough.is_empty());
    }

    #[test]
    fn a_flood_while_asking_is_a_deny() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, ssh);
        let line = b"%output %0 "
            .iter()
            .chain([b'x'; 4000].iter())
            .chain(b"\r\n")
            .copied()
            .collect::<Vec<u8>>();
        let mut actions = Vec::new();
        for _ in 0..300 {
            let fed = gate.feed(&line, now, ssh);
            actions.extend(fed.actions);
            if !gate.asking() {
                break;
            }
        }
        assert_eq!(writes(&actions), vec![b"\n".to_vec()]);
        assert!(question(&gate).is_none());
        assert!(!gate.asking());
        // The flood keeps coming and none of it draws, until the drain ends.
        assert!(gate.feed(&line, now, ssh).passthrough.is_empty());
        gate.tick(now + DRAIN_TIMEOUT);
        assert!(!gate.in_control_mode());
    }

    #[test]
    fn a_broken_stream_ends_control_mode_with_its_error() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        gate.feed(&entry(), now, tmux);
        let fed = gate.feed(b"%window-add notanid\r\n", now, tmux);
        assert_eq!(
            notices(&fed.actions),
            vec!["tmux control mode ended: malformed tmux notification: window-add"]
        );
        assert!(!gate.in_control_mode());
        assert_eq!(gate.feed(b"$ ", now, tmux).passthrough, b"$ ");
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
    #[test]
    fn the_process_table_names_this_process_and_its_arguments() {
        let me = std::process::id();
        let read = process_foreground_from_table(me);
        let name = read.name.expect("a name");
        let exe = std::env::current_exe().unwrap();
        let file = exe.file_name().unwrap().to_string_lossy().into_owned();
        // The table's name is the executable's, whole or cut as the OS keeps
        // it (Linux keeps 15 bytes of it).
        assert!(
            file.starts_with(&name) || name.starts_with(&file),
            "{name:?} vs {file:?}"
        );
        let command = read.command.expect("arguments");
        assert!(command.contains(&name), "{command:?}");
        #[cfg(target_os = "linux")]
        assert_eq!(
            process_foreground(me).name,
            Some(name),
            "the /proc read agrees"
        );
        assert_eq!(
            process_foreground_from_table(u32::MAX - 1),
            Foreground::default()
        );
    }

    #[test]
    fn snapshots_are_ordered_and_a_subscriber_sees_the_open_question() {
        let now = Instant::now();
        let mut gate = TmuxGate::new(policy(true, &[]), 10);
        let (first, mut rx) = gate.subscribe();
        assert_eq!(first.revision, 0);
        gate.feed(&entry(), now, ssh);
        assert!(rx.has_changed().unwrap());
        let open = rx.borrow_and_update().clone();
        assert_eq!(open.revision, 1);
        assert!(open.question.is_some());
        gate.answer(TmuxAnswer::Deny, now);
        let closed = rx.borrow_and_update().clone();
        assert_eq!(closed.revision, 2);
        assert!(closed.question.is_none());
    }
}
