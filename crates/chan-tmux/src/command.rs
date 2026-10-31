//! Commands the client sends, and parsers for the replies it asks for.
//!
//! Commands are a closed enum: ids are typed, formats are constants, and the
//! only free text a command can carry (a window name, a directory) is quoted
//! and refused if it holds a control character, so no argument can end its
//! command line and begin another.

use crate::decode::Expect;
use crate::error::Error;
use crate::escape::hex_pairs;
use crate::ids::{PaneId, WindowId};

/// Most bytes one `send-keys -H` command carries.
pub const MAX_KEY_BYTES: usize = 256;
/// Largest terminal dimension a size command may state, and the most rows a
/// pane can have.
pub(crate) const MAX_SIZE: u32 = 10_000;
/// Longest free-text argument, in bytes.
const MAX_TEXT: usize = 1024;

const LIST_SESSIONS_FORMAT: &str = "#{session_id}";
// The name comes last and may hold spaces; the parser reads the four fixed
// fields and takes the rest as the name.
const LIST_WINDOWS_FORMAT: &str =
    "#{window_id} #{window_layout} #{window_visible_layout} #{window_flags} #{window_name}";
const LIST_PANES_FORMAT: &str = "#{pane_id} #{pane_active}";
const PANE_STATE_FORMAT: &str = "#{pane_id} #{cursor_x} #{cursor_y} #{pane_in_mode} #{alternate_on} #{scroll_region_upper} #{scroll_region_lower} #{pane_width} #{pane_height} #{history_size}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// A line holding only `^C`, the first thing written after entry. tmux
    /// answers it with a parse error, which the caller ignores; a shell that
    /// was left holding a line when a program printed the marker and exited
    /// cancels that line instead of running it with the newline that
    /// follows.
    Interrupt,
    /// `#{version}`.
    Version,
    /// The size of the whole client.
    ClientSize {
        cols: u32,
        rows: u32,
    },
    /// The size of one window (tmux 3.4 and later).
    WindowSize {
        window: WindowId,
        cols: u32,
        rows: u32,
    },
    /// Pause a pane's output after it has been unread for `seconds`.
    PauseAfter {
        seconds: u32,
    },
    /// Ask for JSON layouts (tmux 3.8 and later).
    NewLayouts,
    /// Resume a paused pane.
    ContinuePane(PaneId),
    ListSessions,
    ListWindows,
    ListPanes(WindowId),
    PaneState(PaneId),
    /// The screen the pane shows, the alternate one while a program has it
    /// on, with up to `history_rows` rows of scrollback above it, answered
    /// as one [`Event::Capture`](crate::Event::Capture). The line asks for
    /// the pane's state and then the rows, and tmux runs the two together,
    /// so the state sizes the rows exactly: a resize or a shorter history
    /// between them cannot leave the reply short. The screen tmux saved
    /// under an alternate screen is not asked for: its capture (`-a`) is one
    /// row when no alternate screen is on and keeps its old height after a
    /// resize, so no promise fits it.
    CapturePane {
        pane: PaneId,
        history_rows: u32,
    },
    /// Keys as raw bytes. At most [`MAX_KEY_BYTES`]; see [`Command::send_keys`].
    SendKeys {
        pane: PaneId,
        bytes: Vec<u8>,
    },
    NewWindow {
        cwd: Option<String>,
    },
    SplitWindow {
        pane: PaneId,
        horizontal: bool,
    },
    KillWindow(WindowId),
    KillPane(PaneId),
    SelectWindow(WindowId),
    SelectPane(PaneId),
    RenameWindow {
        window: WindowId,
        name: String,
    },
    Detach,
    /// End the tmux server the client is attached to, with every session it
    /// holds; tmux answers with `%exit`.
    KillServer,
}

impl Command {
    /// Split keystrokes into as many [`Command::SendKeys`] as needed.
    pub fn send_keys(pane: PaneId, bytes: &[u8]) -> Vec<Command> {
        bytes
            .chunks(MAX_KEY_BYTES)
            .map(|c| Command::SendKeys {
                pane,
                bytes: c.to_vec(),
            })
            .collect()
    }

    /// The command line, without its line break.
    pub fn render(&self) -> Result<String, Error> {
        Ok(match self {
            Command::Interrupt => "\u{3}".into(),
            Command::Version => "display-message -p '#{version}'".into(),
            Command::ClientSize { cols, rows } => {
                check_size(*cols, *rows)?;
                format!("refresh-client -C {cols},{rows}")
            }
            Command::WindowSize { window, cols, rows } => {
                check_size(*cols, *rows)?;
                format!("refresh-client -C {window}:{cols}x{rows}")
            }
            Command::PauseAfter { seconds } => format!("refresh-client -f pause-after={seconds}"),
            Command::NewLayouts => "refresh-client -f new-layouts".into(),
            Command::ContinuePane(pane) => format!("refresh-client -A '{pane}:continue'"),
            Command::ListSessions => format!("list-sessions -F '{LIST_SESSIONS_FORMAT}'"),
            Command::ListWindows => format!("list-windows -F '{LIST_WINDOWS_FORMAT}'"),
            Command::ListPanes(window) => {
                format!("list-panes -t {window} -F '{LIST_PANES_FORMAT}'")
            }
            Command::PaneState(pane) => {
                format!("display-message -p -t {pane} '{PANE_STATE_FORMAT}'")
            }
            Command::CapturePane { pane, history_rows } => {
                if *history_rows > 1_000_000 {
                    return Err(Error::BadArgument("capture range"));
                }
                let start = if *history_rows == 0 {
                    "0".to_owned()
                } else {
                    format!("-{history_rows}")
                };
                format!(
                    "display-message -p -t {pane} '{PANE_STATE_FORMAT}' ; \
                     capture-pane -p -e -t {pane} -S {start} -E -"
                )
            }
            Command::SendKeys { pane, bytes } => {
                if bytes.is_empty() || bytes.len() > MAX_KEY_BYTES {
                    return Err(Error::BadArgument("key bytes"));
                }
                format!("send-keys -t {pane} -H {}", hex_pairs(bytes))
            }
            Command::NewWindow { cwd } => match cwd {
                Some(dir) => format!("new-window -PF '#{{window_id}}' -c {}", quote(dir)?),
                None => "new-window -PF '#{window_id}'".into(),
            },
            Command::SplitWindow { pane, horizontal } => {
                let dir = if *horizontal { "-h" } else { "-v" };
                format!("split-window {dir} -t {pane} -PF '#{{pane_id}}'")
            }
            Command::KillWindow(window) => format!("kill-window -t {window}"),
            Command::KillPane(pane) => format!("kill-pane -t {pane}"),
            Command::SelectWindow(window) => format!("select-window -t {window}"),
            Command::SelectPane(pane) => format!("select-pane -t {pane}"),
            // tmux reads a quoted word that starts with `-` as flags, so the
            // name goes after `--`.
            Command::RenameWindow { window, name } => {
                format!("rename-window -t {window} -- {}", quote(name)?)
            }
            Command::Detach => "detach-client".into(),
            Command::KillServer => "kill-server".into(),
        })
    }

    /// The reply blocks the command line produces, in order, and what each
    /// must look like for its terminator to be believed.
    ///
    /// Only a capture carries pane content, which a program can fill with
    /// forged protocol lines; every other reply is generated by tmux from
    /// numbers and symbols. A capture is two blocks: the pane state, then
    /// the rows it sizes.
    pub fn expects(&self) -> Vec<Expect> {
        match self {
            Command::CapturePane { history_rows, .. } => vec![
                Expect::PaneState,
                Expect::Capture {
                    history_rows: *history_rows,
                },
            ],
            _ => vec![Expect::Any],
        }
    }
}

fn check_size(cols: u32, rows: u32) -> Result<(), Error> {
    if (1..=MAX_SIZE).contains(&cols) && (1..=MAX_SIZE).contains(&rows) {
        Ok(())
    } else {
        Err(Error::BadArgument("size"))
    }
}

/// Quote free text as one tmux word, safe against both of tmux's readers.
///
/// The command parser reads the single quotes. tmux then expands formats in
/// window names and directories, where `#(...)` runs a shell command, so every
/// `#` is doubled to make the text literal.
fn quote(text: &str) -> Result<String, Error> {
    if text.len() > MAX_TEXT {
        return Err(Error::BadArgument("text too long"));
    }
    if text.chars().any(|c| c.is_control()) {
        return Err(Error::BadArgument("control character"));
    }
    Ok(format!(
        "'{}'",
        text.replace('#', "##").replace('\'', "'\\''")
    ))
}

/// A tmux version as `#{version}` prints it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
}

impl Version {
    /// `3.8`, `3.0a`, `next-3.5`. A letter suffix is ignored.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.strip_prefix("next-").unwrap_or(text);
        let (major, rest) = text.split_once('.')?;
        let minor: String = rest.chars().take_while(char::is_ascii_digit).collect();
        Some(Self {
            major: major.parse().ok()?,
            minor: minor.parse().ok()?,
        })
    }
}

/// One window of a [`Command::ListWindows`] reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: WindowId,
    pub layout: String,
    pub visible_layout: String,
    pub flags: String,
    /// The window's name, untrusted text that tmux keeps free of control
    /// characters; empty when the window has none.
    pub name: String,
}

pub fn parse_list_windows(lines: &[Vec<u8>]) -> Result<Vec<WindowInfo>, Error> {
    lines
        .iter()
        .map(|line| {
            let text = std::str::from_utf8(line).map_err(|_| Error::Malformed("list-windows"))?;
            let f: Vec<&str> = text.splitn(5, ' ').collect();
            match f.as_slice() {
                [id, layout, visible, flags, rest @ ..] => Ok(WindowInfo {
                    id: WindowId::parse(id).ok_or(Error::Malformed("list-windows"))?,
                    layout: (*layout).to_owned(),
                    visible_layout: (*visible).to_owned(),
                    flags: (*flags).to_owned(),
                    name: rest.first().map(|n| (*n).to_owned()).unwrap_or_default(),
                }),
                _ => Err(Error::Malformed("list-windows")),
            }
        })
        .collect()
}

/// One pane of a [`Command::ListPanes`] reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneInfo {
    pub id: PaneId,
    pub active: bool,
}

pub fn parse_list_panes(lines: &[Vec<u8>]) -> Result<Vec<PaneInfo>, Error> {
    lines
        .iter()
        .map(|line| {
            let text = std::str::from_utf8(line).map_err(|_| Error::Malformed("list-panes"))?;
            match text.split(' ').collect::<Vec<_>>().as_slice() {
                [id, active] => Ok(PaneInfo {
                    id: PaneId::parse(id).ok_or(Error::Malformed("list-panes"))?,
                    active: *active == "1",
                }),
                _ => Err(Error::Malformed("list-panes")),
            }
        })
        .collect()
}

/// The screen state of a pane, from [`Command::PaneState`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneState {
    pub id: PaneId,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub in_mode: bool,
    pub alternate_on: bool,
    pub scroll_upper: u32,
    pub scroll_lower: u32,
    pub width: u32,
    pub height: u32,
    pub history_size: u32,
}

pub fn parse_pane_state(lines: &[Vec<u8>]) -> Result<PaneState, Error> {
    let bad = Error::Malformed("pane state");
    let [line] = lines else { return Err(bad) };
    let text = std::str::from_utf8(line).map_err(|_| Error::Malformed("pane state"))?;
    let f: Vec<&str> = text.split(' ').collect();
    let n = |i: usize| -> Result<u32, Error> {
        f.get(i)
            .and_then(|v| v.parse().ok())
            .ok_or(Error::Malformed("pane state"))
    };
    if f.len() != 10 {
        return Err(bad);
    }
    Ok(PaneState {
        id: PaneId::parse(f[0]).ok_or(Error::Malformed("pane state"))?,
        cursor_x: n(1)?,
        cursor_y: n(2)?,
        in_mode: n(3)? != 0,
        alternate_on: n(4)? != 0,
        scroll_upper: n(5)?,
        scroll_lower: n(6)?,
        width: n(7)?,
        height: n(8)?,
        history_size: n(9)?,
    })
}

/// The single id a creating command (`new-window`, `split-window`) prints.
pub fn parse_created_id(lines: &[Vec<u8>]) -> Result<String, Error> {
    match lines {
        [line] => std::str::from_utf8(line)
            .ok()
            .filter(|t| WindowId::parse(t).is_some() || PaneId::parse(t).is_some())
            .map(str::to_owned)
            .ok_or(Error::Malformed("created id")),
        _ => Err(Error::Malformed("created id")),
    }
}
