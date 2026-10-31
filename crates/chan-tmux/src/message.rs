//! Notifications: the `%`-lines tmux sends outside a command reply.

use crate::error::Error;
use crate::escape::unescape_output;
use crate::ids::{PaneId, SessionId, WindowId};

/// One parsed notification. Names and layout strings come from tmux, which
/// strips control characters from names; they are still untrusted text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Output {
        pane: PaneId,
        data: Vec<u8>,
    },
    /// Output under `pause-after`, with tmux's age of the data in milliseconds.
    ExtendedOutput {
        pane: PaneId,
        latency_ms: u64,
        data: Vec<u8>,
    },
    WindowAdd(WindowId),
    WindowClose(WindowId),
    WindowRenamed {
        window: WindowId,
        name: String,
    },
    UnlinkedWindowAdd(WindowId),
    UnlinkedWindowClose(WindowId),
    UnlinkedWindowRenamed {
        window: WindowId,
        name: String,
    },
    LayoutChange {
        window: WindowId,
        layout: String,
        visible_layout: String,
        flags: String,
    },
    WindowPaneChanged {
        window: WindowId,
        pane: PaneId,
    },
    SessionChanged {
        session: SessionId,
        name: String,
    },
    SessionsChanged,
    SessionRenamed {
        name: String,
    },
    SessionWindowChanged {
        session: SessionId,
        window: WindowId,
    },
    ClientSessionChanged {
        client: String,
        session: SessionId,
        name: String,
    },
    ClientDetached {
        client: String,
    },
    Pause(PaneId),
    Continue(PaneId),
    PaneModeChanged(PaneId),
    /// The client left control mode. `reason` is tmux's text, if any.
    Exit {
        reason: Option<String>,
    },
    /// A notification this crate does not interpret. Only its keyword is kept.
    Other {
        keyword: String,
    },
}

/// Parse one line that is not part of a reply block.
///
/// `Err` is returned for a line that is not a notification at all and for a
/// known notification whose fields do not parse.
pub fn parse_message(line: &[u8]) -> Result<Message, Error> {
    if line.first() != Some(&b'%') {
        return Err(Error::Malformed("not a notification"));
    }
    let (keyword, rest) = split_once(line, b' ');
    let keyword = std::str::from_utf8(keyword).map_err(|_| Error::Malformed("keyword"))?;
    match keyword {
        "%output" => {
            let (pane, data) = split_once(rest.ok_or(bad("output"))?, b' ');
            Ok(Message::Output {
                pane: pane_id(pane, "output")?,
                data: unescape_output(data.unwrap_or_default()),
            })
        }
        "%extended-output" => extended_output(rest.ok_or(bad("extended-output"))?),
        "%window-add" => Ok(Message::WindowAdd(only_window(rest, "window-add")?)),
        "%window-close" => Ok(Message::WindowClose(only_window(rest, "window-close")?)),
        "%unlinked-window-add" => Ok(Message::UnlinkedWindowAdd(only_window(
            rest,
            "unlinked-window-add",
        )?)),
        "%unlinked-window-close" => Ok(Message::UnlinkedWindowClose(only_window(
            rest,
            "unlinked-window-close",
        )?)),
        "%window-renamed" => {
            let (window, name) = window_and_text(rest, "window-renamed")?;
            Ok(Message::WindowRenamed { window, name })
        }
        "%unlinked-window-renamed" => {
            let (window, name) = window_and_text(rest, "unlinked-window-renamed")?;
            Ok(Message::UnlinkedWindowRenamed { window, name })
        }
        "%layout-change" => layout_change(rest.ok_or(bad("layout-change"))?),
        "%window-pane-changed" => {
            let text = text(rest.ok_or(bad("window-pane-changed"))?)?;
            let mut it = text.split(' ');
            let window = it.next().and_then(WindowId::parse);
            let pane = it.next().and_then(PaneId::parse);
            match (window, pane, it.next()) {
                (Some(window), Some(pane), None) => Ok(Message::WindowPaneChanged { window, pane }),
                _ => Err(bad("window-pane-changed")),
            }
        }
        "%session-changed" => {
            let (session, name) = session_and_text(rest, "session-changed")?;
            Ok(Message::SessionChanged { session, name })
        }
        "%sessions-changed" => Ok(Message::SessionsChanged),
        "%session-renamed" => Ok(Message::SessionRenamed {
            name: text(rest.unwrap_or_default())?.to_owned(),
        }),
        "%session-window-changed" => {
            let text = text(rest.ok_or(bad("session-window-changed"))?)?;
            let mut it = text.split(' ');
            let session = it.next().and_then(SessionId::parse);
            let window = it.next().and_then(WindowId::parse);
            match (session, window, it.next()) {
                (Some(session), Some(window), None) => {
                    Ok(Message::SessionWindowChanged { session, window })
                }
                _ => Err(bad("session-window-changed")),
            }
        }
        "%client-session-changed" => {
            let text = text(rest.ok_or(bad("client-session-changed"))?)?;
            let mut it = text.splitn(3, ' ');
            let client = it.next().filter(|c| !c.is_empty());
            let session = it.next().and_then(SessionId::parse);
            match (client, session) {
                (Some(client), Some(session)) => Ok(Message::ClientSessionChanged {
                    client: client.to_owned(),
                    session,
                    name: it.next().unwrap_or_default().to_owned(),
                }),
                _ => Err(bad("client-session-changed")),
            }
        }
        "%client-detached" => Ok(Message::ClientDetached {
            client: text(rest.unwrap_or_default())?.to_owned(),
        }),
        "%pause" => Ok(Message::Pause(pane_id(rest.ok_or(bad("pause"))?, "pause")?)),
        "%continue" => Ok(Message::Continue(pane_id(
            rest.ok_or(bad("continue"))?,
            "continue",
        )?)),
        "%pane-mode-changed" => Ok(Message::PaneModeChanged(pane_id(
            rest.ok_or(bad("pane-mode-changed"))?,
            "pane-mode-changed",
        )?)),
        "%exit" => Ok(Message::Exit {
            reason: rest
                .filter(|r| !r.is_empty())
                .map(|r| String::from_utf8_lossy(r).into_owned()),
        }),
        other => Ok(Message::Other {
            keyword: other.to_owned(),
        }),
    }
}

fn bad(what: &'static str) -> Error {
    Error::Malformed(what)
}

fn split_once(line: &[u8], sep: u8) -> (&[u8], Option<&[u8]>) {
    match line.iter().position(|&b| b == sep) {
        Some(i) => (&line[..i], Some(&line[i + 1..])),
        None => (line, None),
    }
}

fn text(bytes: &[u8]) -> Result<&str, Error> {
    std::str::from_utf8(bytes).map_err(|_| Error::Malformed("not utf-8"))
}

fn pane_id(bytes: &[u8], what: &'static str) -> Result<PaneId, Error> {
    PaneId::parse(text(bytes)?).ok_or(bad(what))
}

fn only_window(rest: Option<&[u8]>, what: &'static str) -> Result<WindowId, Error> {
    WindowId::parse(text(rest.ok_or(bad(what))?)?).ok_or(bad(what))
}

fn window_and_text(rest: Option<&[u8]>, what: &'static str) -> Result<(WindowId, String), Error> {
    let (window, name) = split_once(rest.ok_or(bad(what))?, b' ');
    let window = WindowId::parse(text(window)?).ok_or(bad(what))?;
    Ok((
        window,
        String::from_utf8_lossy(name.unwrap_or_default()).into_owned(),
    ))
}

fn session_and_text(rest: Option<&[u8]>, what: &'static str) -> Result<(SessionId, String), Error> {
    let (session, name) = split_once(rest.ok_or(bad(what))?, b' ');
    let session = SessionId::parse(text(session)?).ok_or(bad(what))?;
    Ok((
        session,
        String::from_utf8_lossy(name.unwrap_or_default()).into_owned(),
    ))
}

fn layout_change(rest: &[u8]) -> Result<Message, Error> {
    let text = text(rest)?;
    let mut it = text.split(' ');
    let window = it
        .next()
        .and_then(WindowId::parse)
        .ok_or(bad("layout-change"))?;
    let layout = it
        .next()
        .filter(|l| !l.is_empty())
        .ok_or(bad("layout-change"))?;
    let visible_layout = it.next().filter(|l| !l.is_empty()).unwrap_or(layout);
    let flags = it.next().unwrap_or_default();
    Ok(Message::LayoutChange {
        window,
        layout: layout.to_owned(),
        visible_layout: visible_layout.to_owned(),
        flags: flags.to_owned(),
    })
}

fn extended_output(rest: &[u8]) -> Result<Message, Error> {
    let (pane, tail) = split_once(rest, b' ');
    let pane = pane_id(pane, "extended-output")?;
    let tail = tail.ok_or(bad("extended-output"))?;
    // `<latency> [args...] : <data>`; the first " :" ends the header.
    let colon = tail
        .windows(2)
        .position(|w| w == b" :")
        .ok_or(bad("extended-output"))?;
    let header = text(&tail[..colon])?;
    let latency_ms = header
        .split(' ')
        .next()
        .and_then(|l| l.parse::<u64>().ok())
        .ok_or(bad("extended-output"))?;
    let data = tail.get(colon + 3..).unwrap_or_default();
    Ok(Message::ExtendedOutput {
        pane,
        latency_ms,
        data: unescape_output(data),
    })
}
