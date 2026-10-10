//! Build and emit one bounded OSC 7501 report.

use std::fs::File;
use std::io::{self, Write};

use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};

use crate::control::{control_socket_env, send_control_request};
use crate::ControlRequest;

const MAX_BODY: usize = 4087;
const MAX_APP: usize = 32;
const MAX_ID: usize = 128;
const MAX_SEGMENT: usize = 32;
const MAX_DEPTH: usize = 8;
const MAX_TITLE: usize = 192;
const MAX_TITLE_ENCODED: usize = 256;
const MAX_MSG: usize = 2048;
const MAX_MSG_ENCODED: usize = 2732;

#[derive(Default)]
pub(crate) struct Fields<'a> {
    pub state: &'a str,
    pub kind: Option<&'a str>,
    pub progress: Option<&'a str>,
    pub app: Option<&'a str>,
    pub id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub msg: Option<&'a str>,
}

pub(crate) fn build_report(fields: &Fields<'_>) -> Result<String> {
    ensure!(
        matches!(
            fields.state,
            "idle" | "working" | "done" | "blocked" | "error" | "clear"
        ),
        "state must be idle, working, done, blocked, error or clear"
    );
    if let Some(kind) = fields.kind {
        ensure!(
            matches!(kind, "permission" | "question" | "auth"),
            "kind must be permission, question or auth"
        );
    }
    if let Some(progress) = fields.progress {
        ensure!(
            !progress.is_empty()
                && progress.bytes().all(|b| b.is_ascii_digit())
                && progress.parse::<u8>().is_ok_and(|n| n <= 100),
            "progress must be an integer from 0 to 100"
        );
    }
    if let Some(app) = fields.app {
        ensure!(app.len() <= MAX_APP, "app exceeds the 32-byte limit");
        ensure!(
            name(app),
            "app must use ASCII letters, digits, underscore, dot, plus or hyphen"
        );
    }
    if let Some(id) = fields.id {
        ensure!(id.len() <= MAX_ID, "id exceeds the 128-byte limit");
        ensure!(
            id.split('/').count() <= MAX_DEPTH,
            "id exceeds the 8-level limit"
        );
        for segment in id.split('/') {
            ensure!(
                segment.len() <= MAX_SEGMENT,
                "id segment exceeds the 32-byte limit"
            );
            ensure!(name(segment), "id needs nonempty slash-separated segments of ASCII letters, digits, underscore, dot, plus or hyphen");
        }
    }
    let title = encode_text(fields.title, "title", MAX_TITLE, MAX_TITLE_ENCODED)?;
    let msg = encode_text(fields.msg, "msg", MAX_MSG, MAX_MSG_ENCODED)?;
    let mut body = format!("state={}", fields.state);
    for (key, value) in [
        ("kind", fields.kind),
        ("app", fields.app),
        ("id", fields.id),
        ("title", title.as_deref()),
        ("progress", fields.progress),
        ("msg", msg.as_deref()),
    ] {
        if let Some(value) = value {
            body.push(':');
            body.push_str(key);
            body.push('=');
            body.push_str(value);
        }
    }
    ensure!(
        body.len() <= MAX_BODY,
        "report body exceeds the 4087-byte limit"
    );
    Ok(body)
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

fn encode_text(
    value: Option<&str>,
    field: &str,
    decoded_limit: usize,
    encoded_limit: usize,
) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    ensure!(
        value.len() <= decoded_limit,
        "{field} exceeds the {decoded_limit}-byte decoded limit"
    );
    ensure!(
        !value
            .chars()
            .any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}')),
        "{field} contains a forbidden control character"
    );
    let encoded = STANDARD.encode(value);
    ensure!(
        encoded.len() <= encoded_limit,
        "{field} exceeds the {encoded_limit}-byte encoded limit"
    );
    Ok(Some(encoded))
}

fn sequence(body: &str) -> Result<Vec<u8>> {
    ensure!(
        body.len() <= MAX_BODY,
        "report body exceeds the 4087-byte limit"
    );
    Ok(format!("\x1b]7501;{body}\x1b\\").into_bytes())
}

fn write_sequence(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    if writer.write(bytes)? != bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "short program status write",
        ));
    }
    writer.flush()
}

pub(crate) async fn emit(fields: &Fields<'_>) -> Result<()> {
    let body = build_report(fields)?;
    let bytes = sequence(&body)?;
    match select_route(terminal_output()?, std::env::var("CHAN_SESSION_ID").ok())? {
        Route::Terminal(mut output) => {
            write_sequence(&mut output, &bytes).context("writing program status to the terminal")
        }
        Route::Control(session_id) => {
            let socket = control_socket_env()?;
            send_control_request(&socket, ControlRequest::TermStatus { session_id, body }).await?;
            Ok(())
        }
    }
}

enum Route<T> {
    Terminal(T),
    Control(String),
}

fn select_route<T>(terminal: Option<T>, session_id: Option<String>) -> Result<Route<T>> {
    if let Some(output) = terminal {
        return Ok(Route::Terminal(output));
    }
    if let Some(id) = session_id.filter(|id| !id.is_empty()) {
        return Ok(Route::Control(id));
    }
    bail!("program status needs a terminal or CHAN_SESSION_ID and CHAN_CONTROL_SOCKET")
}

#[cfg(unix)]
fn terminal_output() -> io::Result<Option<File>> {
    use std::io::IsTerminal;

    let stdout = io::stdout();
    if stdout.is_terminal() {
        return rustix::io::dup(stdout)
            .map(|fd| Some(File::from(fd)))
            .map_err(Into::into);
    }
    match File::options().write(true).open("/dev/tty") {
        Ok(tty) => Ok(Some(tty)),
        Err(_) => Ok(None),
    }
}

#[cfg(windows)]
fn terminal_output() -> io::Result<Option<File>> {
    use std::os::windows::io::{AsHandle, AsRawHandle};

    let stdout = io::stdout();
    // GetConsoleMode distinguishes the console from redirected handles.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleMode(handle: *mut std::ffi::c_void, mode: *mut u32) -> i32;
    }
    let mut mode = 0;
    // SAFETY: stdout owns the handle and mode points to writable storage.
    let console = unsafe { GetConsoleMode(stdout.as_raw_handle(), &mut mode) } != 0;
    if console {
        stdout
            .as_handle()
            .try_clone_to_owned()
            .map(|handle| Some(File::from(handle)))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests;
