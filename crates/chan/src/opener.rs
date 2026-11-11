//! `chan-files` and `chan-edit`: open paths in a chan window, as `cs open`
//! does inside chan. The two names are one command ([`Opener`] chooses only
//! the usage), and the server that receives a path decides what it opens.

use std::ffi::OsString;

use anyhow::{bail, Result};
use chan_server::handoff::{self, OpenPathReply, Response};

use crate::cli::Opener;
use crate::Personality;

/// How long a desktop this command started has to serve its endpoint, the
/// bound `chan serve` gives the desktop it launches.
#[cfg(unix)]
const LAUNCH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(20);

/// Open each of `args` (the current directory when there are none). In a chan
/// terminal whose server answers, each path goes through `cs open`; anywhere
/// else, to the running desktop ([`open_in_desktop`]), which the desktop
/// personality starts when none runs. An argument or path that cannot be
/// opened is reported and the rest still open; the command then fails.
pub(super) async fn cmd_open_paths(
    opener: Opener,
    args: Vec<OsString>,
    personality: Personality,
) -> Result<()> {
    let name = opener.name();
    let args = if args.is_empty() {
        vec![OsString::from(".")]
    } else {
        args
    };
    let cwd = std::env::current_dir().ok();
    let mut failures = Vec::new();
    let mut paths = Vec::with_capacity(args.len());
    for arg in &args {
        match handoff::launch_arg_path(arg, cwd.as_deref()) {
            Ok(path) => paths.push(path),
            Err(why) => failures.push(why),
        }
    }
    if !paths.is_empty() {
        if crate::parentage::chan_terminal_answers().await {
            failures.extend(open_in_terminal_window(&paths).await);
        } else {
            failures.extend(open_in_desktop(name, &paths, personality).await?);
        }
    }
    match failures.as_slice() {
        [] => Ok(()),
        [only] if args.len() == 1 => bail!("{only}"),
        _ => {
            for why in &failures {
                eprintln!("{name}: {why}");
            }
            bail!("{} of {} paths were not opened", failures.len(), args.len())
        }
    }
}

/// `cs open PATH` for each path, from this chan terminal: the action prints
/// its own line, so only a failure comes back.
async fn open_in_terminal_window(paths: &[String]) -> Vec<String> {
    let mut failures = Vec::new();
    for path in paths {
        let action = chan_shell::ShellAction::Open {
            path: Some(path.clone()),
            destination: chan_shell::TabDestinationArgs::default(),
        };
        if let Err(error) = chan_shell::dispatch(action, crate::dump_skill).await {
            failures.push(format!("{path}: {error:#}"));
        }
    }
    failures
}

/// Hand each path to the running desktop. A desktop that answers none of
/// them is taken as absent, and [`when_no_desktop`] says what follows; one
/// that stops answering part way leaves the rest unsent.
async fn open_in_desktop(
    name: &str,
    paths: &[String],
    personality: Personality,
) -> Result<Vec<String>> {
    if handoff::handoff_opt_out() {
        bail!(
            "CHAN_NO_DESKTOP_HANDOFF is set, so {name} hands no path to chan-desktop; run {name} \
             in a chan terminal, or unset CHAN_NO_DESKTOP_HANDOFF"
        );
    }
    if !handoff::gui_session_present() {
        bail!(
            "{name} outside a chan terminal opens paths in chan-desktop, and this session has no \
             display (an SSH login, or no DISPLAY or WAYLAND_DISPLAY); run {name} in a chan \
             terminal"
        );
    }
    let mut failures = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        match handoff::try_open_path(path).await {
            OpenPathReply::Opened { message, .. } => eprintln!("{message}"),
            OpenPathReply::Refused { reply } => failures.push(format!(
                "chan-desktop did not open {path}: {}",
                refusal_reason(&reply)
            )),
            OpenPathReply::NoReply if index == 0 => {
                launch_desktop(name, paths, when_no_desktop(personality)).await?;
                return Ok(failures);
            }
            OpenPathReply::NoReply => {
                failures.extend(
                    paths[index..]
                        .iter()
                        .map(|path| format!("chan-desktop did not answer for {path}")),
                );
                break;
            }
        }
    }
    Ok(failures)
}

/// What a command that found no desktop does.
#[derive(Debug, PartialEq, Eq)]
enum NoDesktop {
    /// Start one with the paths: this binary is chan-desktop.
    Launch,
    /// Say so and fail: the standalone CLI has no desktop of its own to start.
    Refuse,
}

/// The desktop personality's `current_exe` is the desktop, so it can start
/// one, as its `chan serve` does; on Windows, where a standalone window has
/// no file surface, neither starts one.
fn when_no_desktop(personality: Personality) -> NoDesktop {
    match personality {
        Personality::Desktop if cfg!(unix) => NoDesktop::Launch,
        _ => NoDesktop::Refuse,
    }
}

#[cfg(unix)]
async fn launch_desktop(name: &str, paths: &[String], action: NoDesktop) -> Result<()> {
    if action == NoDesktop::Refuse {
        bail!(not_running(name));
    }
    crate::desktop::spawn_desktop_gui_opening(paths)
        .map_err(|error| anyhow::anyhow!("starting chan-desktop: {error}"))?;
    let deadline = std::time::Instant::now() + LAUNCH_DEADLINE;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        if handoff::desktop_is_live().await {
            eprintln!("started chan-desktop to open {}", paths.join(", "));
            return Ok(());
        }
    }
    bail!(
        "started chan-desktop, and it did not come up within {} s; run {name} again once it is up",
        LAUNCH_DEADLINE.as_secs()
    )
}

#[cfg(not(unix))]
async fn launch_desktop(name: &str, _paths: &[String], _action: NoDesktop) -> Result<()> {
    bail!(not_running(name))
}

fn not_running(name: &str) -> String {
    format!(
        "chan-desktop is not running; start it and run {name} again, or run {name} in a chan \
         terminal"
    )
}

/// The sentence for a desktop's refusal line: its own message, or what a
/// desktop of another protocol or one that predates the request means.
fn refusal_reason(reply: &str) -> String {
    match serde_json::from_str::<Response>(reply) {
        Ok(Response::Error { message }) if message.contains("unknown variant `open_path`") => {
            "the running chan-desktop predates opening paths; restart it on this version".into()
        }
        Ok(Response::Error { message }) => message,
        Ok(Response::VersionSkew {
            desktop_version, ..
        }) => format!(
            "it is chan {desktop_version} and this is chan {}; restart chan-desktop",
            handoff::CHAN_VERSION
        ),
        _ => reply.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only a desktop binary on unix starts a desktop: the standalone CLI's
    /// `current_exe` is not one.
    #[test]
    fn only_the_desktop_personality_starts_a_desktop() {
        assert_eq!(
            when_no_desktop(Personality::Desktop),
            if cfg!(unix) {
                NoDesktop::Launch
            } else {
                NoDesktop::Refuse
            }
        );
        assert_eq!(when_no_desktop(Personality::Standalone), NoDesktop::Refuse);
    }

    #[test]
    fn a_refusal_reads_as_its_reason() {
        let line = |response: Response| serde_json::to_string(&response).unwrap();
        assert_eq!(
            refusal_reason(&line(Response::Error {
                message: "create notes.bin: not editable text".into()
            })),
            "create notes.bin: not editable text"
        );
        assert_eq!(
            refusal_reason(&line(Response::VersionSkew {
                desktop_version: "0.1.0".into(),
                desktop_protocol: 0,
            })),
            format!(
                "it is chan 0.1.0 and this is chan {}; restart chan-desktop",
                handoff::CHAN_VERSION
            )
        );
        assert_eq!(refusal_reason("not json"), "not json");
    }

    /// The line a desktop that predates `OpenPath` writes for one, as the
    /// release before it answers.
    #[test]
    fn an_older_desktops_refusal_says_it_predates_opening_paths() {
        let older = r#"{"status":"error","message":"invalid handoff request: unknown variant `open_path`, expected one of `open_workspace`, `upgrade`, `open_devserver`, `close_workspace`, `list_devservers`, `connect_devserver`, `disconnect_devserver`, `forget_devserver`, `serve_remote_workspace`, `close_remote_workspace`, `forget_remote_workspace`, `open_terminal`, `activate` at line 1 column 77"}"#;
        assert_eq!(
            refusal_reason(older),
            "the running chan-desktop predates opening paths; restart it on this version"
        );
    }
}
