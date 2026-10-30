//! A tmux control-mode connection: the windows and panes tmux reports, the
//! pane sessions that show them, and the commands that keep the two in step.
//! Runs where the gate runs, under the control session's gate lock; what it
//! cannot do there (sessions and windows are the registry's) it hands back
//! as work the registry performs on its drainer, answering with
//! [`WorkDone`].

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;

use chan_tmux::{
    parse_layout, parse_list_panes, parse_list_windows, Command, Event, Message, PaneId, PaneState,
    SessionId, Token, Version, WindowId,
};
use serde::Serialize;

use super::tmux_gate::Action;
use super::{
    PaneCommand, PtyCommand, PtySize, Session, TerminalExit, TmuxConnectionId, TmuxPaneRef,
    TmuxPaneSpec,
};

/// Most tmux windows a connection materializes as chan windows; the rest are
/// listed for the control terminal to open on demand.
pub(super) const WINDOW_CAP: usize = 8;
/// Most panes one connection holds sessions for.
pub(super) const PANE_CAP: usize = 96;
/// Most bytes of a pane's output held while its capture is on the way; past
/// it the pane is lossy, and the capture alone is its history.
const HOLD_MAX: usize = 1 << 20;
/// Most bytes of a pane's typed input kept while the client's queue is full.
const INPUT_BACKLOG_MAX: usize = 64 << 10;
/// Seconds of unread output after which tmux pauses a pane. Chan reads as
/// fast as tmux writes, so a pause means chan itself lagged; it is answered
/// at once.
const PAUSE_AFTER_SECS: u32 = 5;
/// Bytes a captured cell can cost at most (true colour and a hyperlink), for
/// sizing the history a capture asks for against the reply's byte bound.
const CAPTURE_BYTES_PER_CELL: usize = 24;
/// Most history rows a capture asks for, inside the crate's submit bound.
const CAPTURE_ROWS_MAX: u32 = 150_000;
/// The crate's default reply byte bound, of which a capture may use half.
const REPLY_BYTES_MAX: usize = 64 << 20;
/// Most recent error texts a connection keeps for its status.
const ERRORS_MAX: usize = 8;

/// A connection as the control terminal's status view shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxConnectionStatus {
    /// The connected tmux's version, `major.minor`.
    pub version: String,
    /// The session the client is attached to, once tmux announced it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TmuxSessionStatus>,
    /// Every window tmux listed, in id order.
    pub windows: Vec<TmuxWindowStatus>,
    /// Most windows opened as chan windows at the attach; the rest open on
    /// request.
    pub window_cap: usize,
    /// The most recent errors, oldest first.
    pub errors: Vec<String>,
}

/// A tmux session, by its id and name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxSessionStatus {
    pub id: String,
    pub name: String,
}

/// A tmux window as the status view lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxWindowStatus {
    /// tmux's id, `@N`.
    pub id: String,
    pub name: String,
    /// Panes tmux reports in it.
    pub panes: usize,
    /// Whether its panes have sessions: within the cap, or opened on request.
    pub open: bool,
    /// The chan window minted for it, once the host answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chan_window: Option<String>,
}

/// What the registry does for the connection, off the gate lock.
#[derive(Debug)]
pub(super) enum TmuxWork {
    /// Make a pane session; answered with [`WorkDone::PaneAdded`] or
    /// [`WorkDone::PaneRefused`].
    AddPane {
        spec: TmuxPaneSpec,
        sink: Sender<PaneCommand>,
    },
    /// Record the pane's exit and close its session.
    EndPane { id: String, exit: TerminalExit },
    /// Rename the pane sessions of a window after tmux renamed it.
    RenamePanes { ids: Vec<String>, name: String },
    /// Ask the host for a chan window for a tmux window; answered with
    /// [`WorkDone::WindowMinted`].
    MintWindow { key: WindowId, title: String },
    /// Tell a chan window to open a tab for a pane session bound to it.
    AttachTab {
        window_id: String,
        session_id: String,
    },
    /// Give the control session a window of its own, titled `title`.
    ControlWindow { title: String },
    /// Drop a chan window the host minted.
    RemoveWindow { window_id: String },
    /// Start the gateway thread that reads the panes' commands.
    StartGateway {
        connection: TmuxConnectionId,
        rx: Receiver<PaneCommand>,
    },
}

/// The registry's answer to a piece of work.
#[derive(Debug)]
pub(super) enum WorkDone {
    PaneAdded {
        pane: PaneId,
        session: Arc<Session>,
    },
    PaneRefused {
        pane: PaneId,
    },
    WindowMinted {
        key: WindowId,
        window_id: Option<String>,
    },
}

/// What a submitted command's reply is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Purpose {
    /// The reply says nothing the connection needs; an error is logged.
    Fire,
    ListWindows,
    ListPanes(WindowId),
    Capture(PaneId),
    /// A `new-window` a client asked for; the window it adds is bound by
    /// `pending_new_windows`, not the reply.
    NewWindow,
}

/// One thing the gate does for the connection: submit a command through the
/// client, or an action of the session's.
pub(super) enum Step {
    Submit(Command, Purpose),
    Action(Action),
}

#[derive(Debug)]
struct Window {
    name: String,
    panes: Vec<PaneId>,
    /// Sizes per pane from the layout, by pane id.
    sizes: HashMap<PaneId, (u32, u32)>,
    /// The chan window minted for it, once the host answered.
    chan_window: Option<String>,
    /// Within the window cap: its panes get sessions.
    materialized: bool,
}

#[derive(Debug)]
struct Pane {
    window: WindowId,
    session: Option<Arc<Session>>,
    /// Output read before the capture landed.
    hold: Vec<u8>,
    /// The hold overflowed: the capture alone is the history.
    lossy: bool,
    captured: bool,
    /// A session was asked for and not yet answered.
    requested: bool,
}

/// One connection's state. See the module doc.
#[derive(Debug)]
pub(super) struct TmuxConnection {
    id: TmuxConnectionId,
    version: Version,
    sink: Sender<PaneCommand>,
    scrollback_mb: u32,
    windows: BTreeMap<WindowId, Window>,
    panes: HashMap<PaneId, Pane>,
    pending: HashMap<Token, Purpose>,
    /// Typed input the client's queue could not take yet, oldest first.
    input_backlog: VecDeque<(PaneId, Vec<u8>)>,
    backlog_bytes: usize,
    /// The latest size asked for each window, sent when the queue allows.
    resize_wanted: BTreeMap<WindowId, (u32, u32)>,
    /// The attached session, as tmux announced it.
    session: Option<(SessionId, String)>,
    /// The chan window each `new-window` a client asked for should land in,
    /// oldest first; `None` asks for a chan window of its own. tmux runs
    /// commands in order, so the next window it adds is the oldest request's.
    pending_new_windows: VecDeque<Option<String>>,
    /// The status changed since the gate last published it.
    dirty: bool,
    /// The most recent errors, oldest first, for the status.
    errors: VecDeque<String>,
    /// Sessions ended through the registry, by session id, so an end is
    /// asked for once.
    ending: Vec<String>,
}

impl TmuxConnection {
    /// A connection to a tmux of `version`, with the receiver its gateway
    /// thread reads the panes' commands from.
    pub(super) fn new(
        id: TmuxConnectionId,
        version: Version,
        scrollback_mb: u32,
        session: Option<(SessionId, String)>,
    ) -> (Self, Receiver<PaneCommand>) {
        let (sink, rx) = std::sync::mpsc::channel();
        (
            Self {
                id,
                version,
                sink,
                scrollback_mb,
                windows: BTreeMap::new(),
                panes: HashMap::new(),
                pending: HashMap::new(),
                input_backlog: VecDeque::new(),
                backlog_bytes: 0,
                resize_wanted: BTreeMap::new(),
                session,
                pending_new_windows: VecDeque::new(),
                dirty: true,
                errors: VecDeque::new(),
                ending: Vec::new(),
            },
            rx,
        )
    }

    /// The connection as the status view shows it.
    pub(super) fn status(&self) -> TmuxConnectionStatus {
        TmuxConnectionStatus {
            version: format!("{}.{}", self.version.major, self.version.minor),
            session: self.session.as_ref().map(|(id, name)| TmuxSessionStatus {
                id: id.to_string(),
                name: name.clone(),
            }),
            windows: self
                .windows
                .iter()
                .map(|(id, w)| TmuxWindowStatus {
                    id: id.to_string(),
                    name: w.name.clone(),
                    panes: w.panes.len(),
                    open: w.materialized,
                    chan_window: w.chan_window.clone(),
                })
                .collect(),
            window_cap: WINDOW_CAP,
            errors: self.errors.iter().cloned().collect(),
        }
    }

    /// Whether the status changed since this was last asked; clears it.
    pub(super) fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// Open a window past the cap: its panes get sessions and the host is
    /// asked for a chan window, as for a window within the cap. A window
    /// already open, or one tmux has not listed, changes nothing.
    pub(super) fn open_window(&mut self, window: WindowId) -> Vec<Step> {
        let mut steps = Vec::new();
        let Some(w) = self.windows.get_mut(&window) else {
            return steps;
        };
        if w.materialized {
            return steps;
        }
        w.materialized = true;
        self.dirty = true;
        let title = if w.name.is_empty() {
            format!("tmux {window}")
        } else {
            w.name.clone()
        };
        steps.push(Step::Action(Action::Work(TmuxWork::MintWindow {
            key: window,
            title,
        })));
        steps.push(Step::Submit(
            Command::ListPanes(window),
            Purpose::ListPanes(window),
        ));
        steps
    }

    /// A client asked for a new tmux window: `affinity` is the chan window
    /// its panes should land in as tabs, or `None` for a chan window of its
    /// own, past the cap if need be.
    pub(super) fn request_new_window(&mut self, affinity: Option<String>) -> Vec<Step> {
        self.pending_new_windows.push_back(affinity);
        vec![Step::Submit(
            Command::NewWindow { cwd: None },
            Purpose::NewWindow,
        )]
    }

    /// Keep an error for the status, dropping the oldest past the bound.
    fn note_error(&mut self, text: String) {
        if self.errors.len() == ERRORS_MAX {
            self.errors.pop_front();
        }
        self.errors.push_back(text);
        self.dirty = true;
    }

    /// The first commands after the version is known: flow control, the
    /// JSON layouts tmux 3.8 prints, and the window list that starts the
    /// attach.
    pub(super) fn start(&mut self) -> Vec<Step> {
        let mut steps = vec![Step::Submit(
            Command::PauseAfter {
                seconds: PAUSE_AFTER_SECS,
            },
            Purpose::Fire,
        )];
        if self.version >= (Version { major: 3, minor: 8 }) {
            steps.push(Step::Submit(Command::NewLayouts, Purpose::Fire));
        }
        steps.push(Step::Submit(Command::ListWindows, Purpose::ListWindows));
        steps
    }

    /// The gate submitted a command for `purpose`; its reply is `token`'s.
    pub(super) fn submitted(&mut self, token: Token, purpose: Purpose) {
        self.pending.insert(token, purpose);
    }

    /// A notification, outside any reply.
    pub(super) fn on_message(&mut self, message: Message) -> Vec<Step> {
        let mut steps = Vec::new();
        match message {
            Message::Output { pane, data } | Message::ExtendedOutput { pane, data, .. } => {
                self.output(pane, &data, &mut steps);
            }
            Message::Pause(pane) => {
                steps.push(Step::Submit(Command::ContinuePane(pane), Purpose::Fire));
            }
            Message::WindowAdd(window) | Message::UnlinkedWindowAdd(window) => {
                self.window_seen(window, String::new(), &mut steps);
            }
            Message::WindowClose(window) | Message::UnlinkedWindowClose(window) => {
                self.window_closed(window, &mut steps);
            }
            Message::WindowRenamed { window, name }
            | Message::UnlinkedWindowRenamed { window, name } => {
                if let Some(w) = self.windows.get_mut(&window) {
                    w.name = name.clone();
                    self.dirty = true;
                    let ids: Vec<String> = w
                        .panes
                        .iter()
                        .filter_map(|pane| self.panes.get(pane))
                        .filter_map(|pane| pane.session.as_ref())
                        .map(|session| session.id.clone())
                        .collect();
                    if !ids.is_empty() {
                        steps.push(Step::Action(Action::Work(TmuxWork::RenamePanes {
                            ids,
                            name,
                        })));
                    }
                }
            }
            Message::LayoutChange { window, layout, .. } => {
                self.layout_changed(window, &layout, &mut steps);
            }
            Message::SessionChanged { session, name } => {
                self.session = Some((session, name));
                self.dirty = true;
            }
            Message::SessionRenamed { name } => {
                if let Some((_, current)) = &mut self.session {
                    *current = name;
                    self.dirty = true;
                }
            }
            Message::WindowPaneChanged { .. }
            | Message::SessionsChanged
            | Message::SessionWindowChanged { .. }
            | Message::ClientSessionChanged { .. }
            | Message::ClientDetached { .. }
            | Message::Continue(_)
            | Message::PaneModeChanged(_)
            | Message::Exit { .. }
            | Message::Other { .. } => {}
        }
        steps
    }

    /// The reply to a submitted command.
    pub(super) fn on_reply(
        &mut self,
        token: Token,
        result: Result<Vec<Vec<u8>>, Vec<Vec<u8>>>,
    ) -> Vec<Step> {
        let mut steps = Vec::new();
        let Some(purpose) = self.pending.remove(&token) else {
            return steps;
        };
        self.retry_backlog(&mut steps);
        let rows = match result {
            Ok(rows) => rows,
            Err(message) => {
                let message = String::from_utf8_lossy(&message.concat()).into_owned();
                tracing::debug!(
                    connection = self.id.0,
                    ?purpose,
                    message,
                    "tmux refused a command"
                );
                if let Purpose::Capture(pane) = purpose {
                    // The pane is gone; tmux says so with a notification too.
                    self.pane_gone(pane, &mut steps);
                } else {
                    if purpose == Purpose::NewWindow {
                        // No window came of it, so the next one tmux adds is
                        // not this request's.
                        self.pending_new_windows.pop_front();
                    }
                    self.note_error(format!("tmux refused a command: {message}"));
                }
                return steps;
            }
        };
        match purpose {
            Purpose::Fire | Purpose::Capture(_) | Purpose::NewWindow => {}
            Purpose::ListWindows => match parse_list_windows(&rows) {
                Ok(windows) => {
                    for info in windows {
                        self.window_seen(info.id, info.name, &mut steps);
                        self.layout_changed(info.id, &info.layout, &mut steps);
                    }
                }
                Err(error) => {
                    tracing::warn!(connection = self.id.0, %error, "list-windows reply");
                    self.note_error(format!("list-windows reply: {error}"));
                }
            },
            Purpose::ListPanes(window) => match parse_list_panes(&rows) {
                Ok(panes) => {
                    let ids: Vec<PaneId> = panes.iter().map(|p| p.id).collect();
                    self.window_panes(window, ids, &mut steps);
                }
                Err(error) => {
                    tracing::warn!(connection = self.id.0, %error, "list-panes reply");
                    self.note_error(format!("list-panes reply for {window}: {error}"));
                }
            },
        }
        steps
    }

    /// A capture: the pane's state and rows, written as the pane's first
    /// bytes, then whatever was held.
    pub(super) fn on_capture(
        &mut self,
        token: Token,
        state: PaneState,
        rows: Vec<Vec<u8>>,
    ) -> Vec<Step> {
        let mut steps = Vec::new();
        let Some(Purpose::Capture(pane_id)) = self.pending.remove(&token) else {
            return steps;
        };
        self.retry_backlog(&mut steps);
        let Some(pane) = self.panes.get_mut(&pane_id) else {
            return steps;
        };
        let Some(session) = pane.session.clone() else {
            return steps;
        };
        let mut bytes = Vec::new();
        if state.alternate_on {
            bytes.extend_from_slice(b"\x1b[?1049h");
        }
        bytes.extend_from_slice(b"\x1b[0m\x1b[H\x1b[2J");
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                bytes.extend_from_slice(b"\r\n");
            }
            bytes.extend_from_slice(row);
        }
        bytes.extend_from_slice(b"\x1b[0m");
        if state.scroll_upper != 0 || state.scroll_lower + 1 != state.height {
            bytes.extend_from_slice(
                format!(
                    "\x1b[{};{}r",
                    state.scroll_upper + 1,
                    state.scroll_lower + 1
                )
                .as_bytes(),
            );
        }
        bytes.extend_from_slice(
            format!("\x1b[{};{}H", state.cursor_y + 1, state.cursor_x + 1).as_bytes(),
        );
        let held = std::mem::take(&mut pane.hold);
        pane.captured = true;
        session.record_output(&bytes);
        if !held.is_empty() {
            session.record_output(&held);
        }
        steps
    }

    /// The registry answered a piece of work.
    pub(super) fn on_work_done(&mut self, done: WorkDone) -> Vec<Step> {
        let mut steps = Vec::new();
        match done {
            WorkDone::PaneAdded {
                pane: pane_id,
                session,
            } => {
                let Some(pane) = self.panes.get_mut(&pane_id) else {
                    // Closed while the registry worked; end it again.
                    steps.push(Step::Action(Action::Work(TmuxWork::EndPane {
                        id: session.id.clone(),
                        exit: TerminalExit::Code { code: 0 },
                    })));
                    return steps;
                };
                pane.requested = false;
                let window = self.windows.get(&pane.window);
                if let Some(chan_window) = window.and_then(|w| w.chan_window.clone()) {
                    session.set_window_id(Some(chan_window.clone()));
                    steps.push(Step::Action(Action::Work(TmuxWork::AttachTab {
                        window_id: chan_window,
                        session_id: session.id.clone(),
                    })));
                }
                let size = window
                    .and_then(|w| w.sizes.get(&pane_id).copied())
                    .unwrap_or((80, 24));
                pane.session = Some(session);
                let history_rows = capture_history_rows(self.scrollback_mb, size.0);
                steps.push(Step::Submit(
                    Command::CapturePane {
                        pane: pane_id,
                        history_rows,
                    },
                    Purpose::Capture(pane_id),
                ));
            }
            WorkDone::PaneRefused { pane } => {
                tracing::warn!(connection = self.id.0, pane = %pane, "no session for a tmux pane");
                self.panes.remove(&pane);
                self.note_error(format!("no session for pane {pane}: the session cap"));
            }
            WorkDone::WindowMinted { key, window_id } => {
                self.dirty = true;
                if let Some(window) = self.windows.get_mut(&key) {
                    window.chan_window = window_id.clone();
                    if let Some(window_id) = window_id {
                        for pane in &window.panes {
                            if let Some(session) =
                                self.panes.get(pane).and_then(|p| p.session.as_ref())
                            {
                                session.set_window_id(Some(window_id.clone()));
                                steps.push(Step::Action(Action::Work(TmuxWork::AttachTab {
                                    window_id: window_id.clone(),
                                    session_id: session.id.clone(),
                                })));
                            }
                        }
                    }
                }
            }
        }
        steps
    }

    /// A pane session's command, from the gateway thread.
    pub(super) fn on_pane_command(&mut self, pane: PaneId, command: PtyCommand) -> Vec<Step> {
        let mut steps = Vec::new();
        if !self.panes.contains_key(&pane) {
            return steps;
        }
        match command {
            PtyCommand::Input(bytes) => self.input(pane, bytes, &mut steps),
            PtyCommand::InputSequence { parts, .. } => {
                for part in parts {
                    self.input(pane, part, &mut steps);
                }
            }
            PtyCommand::Resize(size) => {
                if let Some(window) = self.panes.get(&pane).map(|p| p.window) {
                    self.resize_wanted
                        .insert(window, (u32::from(size.cols), u32::from(size.rows)));
                    self.send_resizes(&mut steps);
                }
            }
            PtyCommand::Redraw => {
                // The ring replays what the pane showed; a program on the
                // alternate screen is asked for its screen again, since that
                // replay is empty by design.
                let alt = self
                    .panes
                    .get(&pane)
                    .and_then(|p| p.session.as_ref())
                    .is_some_and(|s| s.in_alt_screen.load(std::sync::atomic::Ordering::Relaxed));
                if alt {
                    steps.push(Step::Submit(
                        Command::CapturePane {
                            pane,
                            history_rows: 0,
                        },
                        Purpose::Capture(pane),
                    ));
                }
            }
            PtyCommand::Kill => {
                steps.push(Step::Submit(Command::KillPane(pane), Purpose::Fire));
            }
            PtyCommand::ProgramStatusReply(reply) => {
                let bytes = reply.query_bytes();
                self.input(pane, bytes.to_vec(), &mut steps);
            }
        }
        steps
    }

    /// The client refused a submit for a full queue: keep the input until a
    /// reply frees a slot.
    pub(super) fn backlog(&mut self, pane: PaneId, bytes: Vec<u8>) {
        if self.backlog_bytes + bytes.len() > INPUT_BACKLOG_MAX {
            tracing::warn!(connection = self.id.0, pane = %pane, "tmux input backlog full; dropping input");
            self.note_error(format!("input to pane {pane} dropped: the backlog is full"));
            return;
        }
        self.backlog_bytes += bytes.len();
        self.input_backlog.push_back((pane, bytes));
    }

    /// The connection is over: every pane session ends, every minted window
    /// goes, and nothing more is submitted.
    pub(super) fn on_end(&mut self, exit: TerminalExit) -> Vec<Step> {
        let mut steps = Vec::new();
        let panes: Vec<PaneId> = self.panes.keys().copied().collect();
        for pane in panes {
            self.end_pane(pane, exit.clone(), &mut steps);
        }
        let windows: Vec<WindowId> = self.windows.keys().copied().collect();
        for window in windows {
            if let Some(window_id) = self.windows.remove(&window).and_then(|w| w.chan_window) {
                steps.push(Step::Action(Action::Work(TmuxWork::RemoveWindow {
                    window_id,
                })));
            }
        }
        self.pending.clear();
        self.input_backlog.clear();
        self.backlog_bytes = 0;
        steps
    }

    #[cfg(test)]
    pub(super) fn pane_session(&self, pane: PaneId) -> Option<Arc<Session>> {
        self.panes.get(&pane).and_then(|p| p.session.clone())
    }

    #[cfg(test)]
    pub(super) fn window_count(&self) -> usize {
        self.windows.len()
    }

    fn output(&mut self, pane_id: PaneId, data: &[u8], steps: &mut Vec<Step>) {
        let Some(pane) = self.panes.get_mut(&pane_id) else {
            // A pane tmux has not listed for us: it belongs to a window
            // past the cap, or one not yet listed.
            return;
        };
        if pane.captured {
            if let Some(session) = &pane.session {
                session.record_output(data);
            }
            return;
        }
        if pane.lossy {
            return;
        }
        if pane.hold.len() + data.len() > HOLD_MAX {
            pane.hold.clear();
            pane.lossy = true;
            tracing::info!(connection = self.id.0, pane = %pane_id, "tmux pane output held past its bound; the capture alone is its history");
            self.note_error(format!(
                "pane {pane_id} wrote more than the hold before its capture; its history is the capture alone"
            ));
            return;
        }
        pane.hold.extend_from_slice(data);
        let _ = steps;
    }

    fn input(&mut self, pane: PaneId, bytes: Vec<u8>, steps: &mut Vec<Step>) {
        if bytes.is_empty() {
            return;
        }
        if !self.input_backlog.is_empty() {
            self.backlog(pane, bytes);
            return;
        }
        for command in Command::send_keys(pane, &bytes) {
            steps.push(Step::Submit(command, Purpose::Fire));
        }
    }

    fn retry_backlog(&mut self, steps: &mut Vec<Step>) {
        while let Some((pane, bytes)) = self.input_backlog.pop_front() {
            self.backlog_bytes -= bytes.len();
            for command in Command::send_keys(pane, &bytes) {
                steps.push(Step::Submit(command, Purpose::Fire));
            }
        }
        self.send_resizes(steps);
    }

    fn send_resizes(&mut self, steps: &mut Vec<Step>) {
        let wanted = std::mem::take(&mut self.resize_wanted);
        for (window, (cols, rows)) in wanted {
            let command = if self.version >= (Version { major: 3, minor: 4 }) {
                Command::WindowSize { window, cols, rows }
            } else {
                Command::ClientSize { cols, rows }
            };
            steps.push(Step::Submit(command, Purpose::Fire));
        }
    }

    /// A window tmux has, by list or notification.
    fn window_seen(&mut self, window: WindowId, name: String, steps: &mut Vec<Step>) {
        if let Some(existing) = self.windows.get_mut(&window) {
            if !name.is_empty() {
                existing.name = name;
            }
            return;
        }
        // A window a client asked for lands where it asked: in the chan
        // window named as its affinity, or in one of its own past the cap.
        let requested = self.pending_new_windows.pop_front();
        let affinity = requested.clone().flatten();
        let materialized = requested.is_some()
            || self.windows.values().filter(|w| w.materialized).count() < WINDOW_CAP;
        let title = if name.is_empty() {
            format!("tmux {window}")
        } else {
            name.clone()
        };
        self.dirty = true;
        self.windows.insert(
            window,
            Window {
                name,
                panes: Vec::new(),
                sizes: HashMap::new(),
                chan_window: affinity.clone(),
                materialized,
            },
        );
        if materialized {
            if affinity.is_none() {
                steps.push(Step::Action(Action::Work(TmuxWork::MintWindow {
                    key: window,
                    title,
                })));
            }
            steps.push(Step::Submit(
                Command::ListPanes(window),
                Purpose::ListPanes(window),
            ));
        }
    }

    fn window_closed(&mut self, window: WindowId, steps: &mut Vec<Step>) {
        let Some(w) = self.windows.remove(&window) else {
            return;
        };
        self.dirty = true;
        for pane in w.panes {
            self.end_pane(pane, TerminalExit::Code { code: 0 }, steps);
        }
        if let Some(window_id) = w.chan_window {
            steps.push(Step::Action(Action::Work(TmuxWork::RemoveWindow {
                window_id,
            })));
        }
    }

    /// The panes a window has, from its layout or a list, with their sizes.
    fn layout_changed(&mut self, window: WindowId, layout: &str, steps: &mut Vec<Step>) {
        let parsed = match parse_layout(layout) {
            Ok(parsed) => parsed,
            Err(error) => {
                tracing::warn!(connection = self.id.0, window = %window, %error, "tmux layout");
                return;
            }
        };
        let mut sizes = HashMap::new();
        fn walk(cell: &chan_tmux::Cell, sizes: &mut HashMap<PaneId, (u32, u32)>) {
            match &cell.kind {
                chan_tmux::Kind::Pane(id) => {
                    sizes.insert(*id, (cell.width, cell.height));
                }
                chan_tmux::Kind::Horizontal(c) | chan_tmux::Kind::Vertical(c) => {
                    c.iter().for_each(|c| walk(c, sizes));
                }
            }
        }
        walk(&parsed.root, &mut sizes);
        let ids = parsed.panes();
        if let Some(w) = self.windows.get_mut(&window) {
            w.sizes = sizes.clone();
        }
        self.window_panes(window, ids, steps);
        // A pane whose size changed is told, as a PTY's client is.
        for (pane, (cols, rows)) in sizes {
            if let Some(session) = self.panes.get(&pane).and_then(|p| p.session.as_ref()) {
                session.note_tmux_pane_size(PtySize {
                    cols: u16::try_from(cols).unwrap_or(u16::MAX),
                    rows: u16::try_from(rows).unwrap_or(u16::MAX),
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
    }

    /// Reconcile a window's panes with `ids`: new ones get sessions, gone
    /// ones end.
    fn window_panes(&mut self, window: WindowId, ids: Vec<PaneId>, steps: &mut Vec<Step>) {
        let Some(w) = self.windows.get(&window) else {
            return;
        };
        let materialized = w.materialized;
        let name = w.name.clone();
        let chan_window = w.chan_window.clone();
        let sizes = w.sizes.clone();
        let gone: Vec<PaneId> = w
            .panes
            .iter()
            .copied()
            .filter(|p| !ids.contains(p))
            .collect();
        for pane in gone {
            self.end_pane(pane, TerminalExit::Code { code: 0 }, steps);
        }
        if let Some(w) = self.windows.get_mut(&window) {
            if w.panes != ids {
                w.panes = ids.clone();
                self.dirty = true;
            }
        }
        if !materialized {
            return;
        }
        for pane_id in ids {
            if self.panes.contains_key(&pane_id) {
                continue;
            }
            if self.panes.len() >= PANE_CAP {
                tracing::warn!(connection = self.id.0, pane = %pane_id, "tmux pane past the cap; not shown");
                self.note_error(format!(
                    "pane {pane_id} not shown: the pane cap of {PANE_CAP}"
                ));
                continue;
            }
            self.panes.insert(
                pane_id,
                Pane {
                    window,
                    session: None,
                    hold: Vec::new(),
                    lossy: false,
                    captured: false,
                    requested: true,
                },
            );
            let (cols, rows) = sizes.get(&pane_id).copied().unwrap_or((80, 24));
            steps.push(Step::Action(Action::Work(TmuxWork::AddPane {
                spec: TmuxPaneSpec {
                    pane: TmuxPaneRef {
                        connection: self.id,
                        pane: pane_id,
                    },
                    name: (!name.is_empty()).then(|| name.clone()),
                    group: "tmux".to_owned(),
                    window_id: chan_window.clone(),
                    size: PtySize {
                        cols: u16::try_from(cols).unwrap_or(u16::MAX),
                        rows: u16::try_from(rows).unwrap_or(u16::MAX),
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                },
                sink: self.sink.clone(),
            })));
        }
    }

    /// tmux refused a capture: the pane is gone.
    fn pane_gone(&mut self, pane: PaneId, steps: &mut Vec<Step>) {
        self.end_pane(pane, TerminalExit::Code { code: 0 }, steps);
    }

    fn end_pane(&mut self, pane_id: PaneId, exit: TerminalExit, steps: &mut Vec<Step>) {
        let Some(pane) = self.panes.remove(&pane_id) else {
            return;
        };
        if let Some(w) = self.windows.get_mut(&pane.window) {
            w.panes.retain(|p| *p != pane_id);
        }
        if let Some(session) = pane.session {
            if !self.ending.contains(&session.id) {
                self.ending.push(session.id.clone());
                steps.push(Step::Action(Action::Work(TmuxWork::EndPane {
                    id: session.id.clone(),
                    exit,
                })));
            }
        }
    }
}

/// How many history rows a capture of a pane `cols` wide asks for: the
/// scrollback setting in lines at that width, inside the submit bound and
/// half the reply's byte bound at the most a cell can cost.
pub(super) fn capture_history_rows(scrollback_mb: u32, cols: u32) -> u32 {
    let cols = cols.max(1) as usize;
    let lines = (scrollback_mb as usize * 1024 * 1024) / (cols * 12);
    let by_bytes = (REPLY_BYTES_MAX / 2) / (cols * CAPTURE_BYTES_PER_CELL + 2);
    lines.min(by_bytes).min(CAPTURE_ROWS_MAX as usize) as u32
}

/// Drive the events a connection receives from the gate.
pub(super) fn event_steps(connection: &mut TmuxConnection, event: Event) -> Vec<Step> {
    match event {
        Event::Message(message) => connection.on_message(message),
        Event::Reply { token, result } => connection.on_reply(token, result),
        Event::Capture { token, state, rows } => connection.on_capture(token, state, rows),
        Event::Passthrough(_)
        | Event::Entered
        | Event::Unsolicited { .. }
        | Event::Stray(_)
        | Event::Exited { .. } => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_kept_for_the_status_up_to_the_bound() {
        let (mut c, _rx) = TmuxConnection::new(
            TmuxConnectionId(1),
            Version { major: 3, minor: 8 },
            10,
            Some((SessionId(0), "main".into())),
        );
        assert!(c.take_dirty(), "a new connection has a status to publish");
        assert!(!c.take_dirty());
        for n in 0..ERRORS_MAX + 2 {
            c.submitted(Token(n as u64), Purpose::Fire);
            let steps = c.on_reply(Token(n as u64), Err(vec![format!("bad {n}").into_bytes()]));
            assert!(steps.is_empty());
        }
        assert!(c.take_dirty());
        let status = c.status();
        assert_eq!(status.errors.len(), ERRORS_MAX, "the oldest are dropped");
        assert_eq!(status.errors[0], "tmux refused a command: bad 2");
        assert_eq!(
            status.errors.last().unwrap(),
            &format!("tmux refused a command: bad {}", ERRORS_MAX + 1)
        );
        assert_eq!(
            status.session,
            Some(TmuxSessionStatus {
                id: "$0".into(),
                name: "main".into(),
            })
        );
        assert_eq!(status.version, "3.8");
        // A refused capture is the pane's end, not an error.
        c.submitted(Token(99), Purpose::Capture(PaneId(3)));
        c.on_reply(Token(99), Err(vec![b"can't find pane".to_vec()]));
        assert_eq!(c.status().errors.len(), ERRORS_MAX);
        assert!(!c.take_dirty());
    }

    #[test]
    fn history_rows_follow_the_width_and_the_bounds() {
        // 10 MB at 80 columns is the SPA's 10,922 lines.
        assert_eq!(capture_history_rows(10, 80), 10_922);
        // 50 MB at 80 columns would be 54,613 lines; the byte bound caps it.
        assert_eq!(capture_history_rows(50, 80), 17_458);
        assert_eq!(
            17_458 * (80 * 24 + 2),
            33_554_276,
            "just under half of 64 MiB"
        );
        // A wide pane with a full setting hits the byte bound.
        let wide = capture_history_rows(50, 2000);
        assert!(wide * (2000 * 24 + 2) <= (REPLY_BYTES_MAX / 2) as u32);
        assert!(capture_history_rows(50, 1) <= CAPTURE_ROWS_MAX);
    }
}
