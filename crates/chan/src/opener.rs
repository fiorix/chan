//! `chan-files` and `chan-edit`: open paths in a chan window, as `cs open`
//! does inside chan. The two names are one command ([`Opener`] chooses only
//! the usage), and the server that receives a path decides what it opens.

use std::ffi::OsString;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use chan_server::handoff::{self, CliOpenPath, Response};

use crate::cli::Opener;
use crate::Personality;

/// How long a running desktop has to answer one path: the bound a second
/// chan-desktop launch gives the desktop it finds (`ASK_BOUND` in
/// `desktop/src-tauri/src/single_instance.rs`), which covers a desktop
/// whose embedded server is still starting.
const ANSWER_BOUND: Duration = Duration::from_secs(5);

/// The pause before asking again a listener that closed without an answer.
const ASK_AGAIN_AFTER: Duration = Duration::from_millis(200);

/// How long a desktop this command started has to serve its endpoint, the
/// bound `chan serve` gives the desktop it launches.
#[cfg(unix)]
const LAUNCH_DEADLINE: Duration = Duration::from_secs(20);

/// Open each of `args` (the current directory itself when there are none).
/// In a chan terminal whose server answers, each path goes through `cs
/// open`; anywhere else, to the running desktop ([`open_in_desktop`]), which
/// the desktop personality starts when none runs. An argument or path that
/// cannot be opened is reported in argument order and the rest still open;
/// the command then fails.
pub(super) async fn cmd_open_paths(
    opener: Opener,
    args: Vec<OsString>,
    personality: Personality,
) -> Result<()> {
    let name = opener.name();
    let cwd = std::env::current_dir().ok();
    let args = if args.is_empty() {
        vec![cwd
            .clone()
            .map_or_else(|| OsString::from("."), |cwd| cwd.into_os_string())]
    } else {
        args
    };
    let mut failures = Vec::new();
    let mut paths = Vec::with_capacity(args.len());
    for (at, arg) in args.iter().enumerate() {
        match handoff::launch_arg_path(arg, cwd.as_deref()) {
            Ok(path) => paths.push((at, path)),
            Err(why) => failures.push((at, why)),
        }
    }
    let mut refusal = None;
    if !paths.is_empty() {
        if crate::parentage::chan_terminal_answers().await {
            failures.extend(open_in_terminal_window(&paths).await);
        } else {
            match open_in_desktop(name, &paths, personality).await {
                Ok(more) => failures.extend(more),
                Err(error) => refusal = Some(error),
            }
        }
    }
    failures.sort_by_key(|(at, _)| *at);
    report(name, args.len(), &failures, refusal)
}

/// The command's end: success, the one failure of a lone argument, or each
/// failure in argument order and then the refusal that stopped the rest, or
/// the count.
fn report(
    name: &str,
    count: usize,
    failures: &[(usize, String)],
    refusal: Option<anyhow::Error>,
) -> Result<()> {
    match (failures, refusal) {
        ([], None) => Ok(()),
        ([], Some(refusal)) => Err(refusal),
        ([(_, only)], None) if count == 1 => bail!("{only}"),
        (failures, refusal) => {
            for (_, why) in failures {
                eprintln!("{name}: {why}");
            }
            match refusal {
                Some(refusal) => Err(refusal),
                None => bail!("{} of {count} paths were not opened", failures.len()),
            }
        }
    }
}

/// `cs open PATH` for each path, from this chan terminal: the action prints
/// its own line, so only a failure comes back.
async fn open_in_terminal_window(paths: &[(usize, String)]) -> Vec<(usize, String)> {
    let mut failures = Vec::new();
    for (at, path) in paths {
        let action = chan_shell::ShellAction::Open {
            path: Some(path.clone()),
            destination: chan_shell::TabDestinationArgs::default(),
        };
        if let Err(error) = chan_shell::dispatch(action, crate::dump_skill).await {
            failures.push((*at, format!("{path}: {error:#}")));
        }
    }
    failures
}

/// Hand each path to the running desktop. Nothing listening on the first is
/// no desktop, and [`when_no_desktop`] says what follows; a desktop that does
/// not answer one ([`ask_desktop`]) leaves the rest unsent. A refusal that
/// stops every path (the opt-out, no display, no desktop to start) is the
/// error.
async fn open_in_desktop(
    name: &str,
    paths: &[(usize, String)],
    personality: Personality,
) -> Result<Vec<(usize, String)>> {
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
    for (index, (at, path)) in paths.iter().enumerate() {
        match ask_desktop(path).await {
            CliOpenPath::Opened { message } => eprintln!("{message}"),
            CliOpenPath::Refused { reply } => failures.push((
                *at,
                format!(
                    "chan-desktop did not open {path}: {}",
                    refusal_reason(&reply)
                ),
            )),
            CliOpenPath::NotListening if index == 0 => {
                let all: Vec<String> = paths.iter().map(|(_, path)| path.clone()).collect();
                launch_desktop(name, &all, when_no_desktop(personality)).await?;
                return Ok(failures);
            }
            CliOpenPath::NotListening | CliOpenPath::Silent => {
                failures.extend(
                    paths[index..]
                        .iter()
                        .map(|(at, path)| (*at, format!("chan-desktop did not answer for {path}"))),
                );
                break;
            }
        }
    }
    Ok(failures)
}

/// One path to the running desktop within [`ANSWER_BOUND`]: one request
/// waits out the bound, and a listener that closes without an answer is
/// asked again until it passes, when the desktop is silent. Nothing
/// listening on the first ask is no desktop; once one was heard, its going
/// away is silence too, since another may be on its way up.
async fn ask_desktop(path: &str) -> CliOpenPath {
    let deadline = Instant::now() + ANSWER_BOUND;
    let mut heard = false;
    loop {
        let budget = deadline.saturating_duration_since(Instant::now());
        match handoff::try_open_path(path, budget).await {
            CliOpenPath::NotListening if !heard => return CliOpenPath::NotListening,
            CliOpenPath::NotListening | CliOpenPath::Silent => {
                heard = true;
                if Instant::now() + ASK_AGAIN_AFTER >= deadline {
                    return CliOpenPath::Silent;
                }
                tokio::time::sleep(ASK_AGAIN_AFTER).await;
            }
            answered => return answered,
        }
    }
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

/// Where a started chan-desktop is, read until it settles.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum Started {
    /// Neither settled yet.
    Waiting,
    /// The endpoint is served: the started desktop, or one it handed to.
    Up,
    /// The started process exited 0 before the endpoint was served: it found
    /// a desktop on its way up and handed it the paths.
    HandedOver,
    /// It exited non-zero: the desktop it found never answered it.
    Unanswered,
}

/// The process the command started settles it first: a second launch exits
/// from its single-instance guard, so its status says whether the desktop it
/// found took the paths. `exited` is that status, when it has one.
#[cfg(unix)]
fn started(exited: Option<bool>, endpoint_served: bool) -> Started {
    match (exited, endpoint_served) {
        (Some(true), _) => Started::HandedOver,
        (Some(false), _) => Started::Unanswered,
        (None, true) => Started::Up,
        (None, false) => Started::Waiting,
    }
}

#[cfg(unix)]
async fn launch_desktop(name: &str, paths: &[String], action: NoDesktop) -> Result<()> {
    if action == NoDesktop::Refuse {
        bail!(not_running(name));
    }
    let mut child = crate::desktop::spawn_desktop_gui_opening(paths)
        .map_err(|error| anyhow::anyhow!("starting chan-desktop: {error}"))?;
    let deadline = Instant::now() + LAUNCH_DEADLINE;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let exited = child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten())
            .map(|status| status.success());
        let served = exited.is_none() && handoff::desktop_is_live().await;
        match started(exited, served) {
            Started::Waiting => {}
            Started::Up => {
                eprintln!("started chan-desktop to open {}", paths.join(", "));
                return Ok(());
            }
            Started::HandedOver => {
                eprintln!(
                    "handed {} to the chan-desktop that was starting",
                    paths.join(", ")
                );
                return Ok(());
            }
            Started::Unanswered => bail!(
                "a chan-desktop was starting and did not answer; run {name} again once it is up"
            ),
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

    /// The process a command started settles the launch before the endpoint
    /// does: a second launch's exit says whether the desktop it found took
    /// the paths, whatever the endpoint shows by then.
    #[cfg(unix)]
    #[test]
    fn a_started_desktop_is_read_from_its_exit_first() {
        assert_eq!(started(None, false), Started::Waiting);
        assert_eq!(started(None, true), Started::Up);
        assert_eq!(started(Some(true), false), Started::HandedOver);
        assert_eq!(started(Some(true), true), Started::HandedOver);
        assert_eq!(started(Some(false), false), Started::Unanswered);
        assert_eq!(started(Some(false), true), Started::Unanswered);
    }

    #[test]
    fn failures_come_in_argument_order_before_the_refusal() {
        let failures = [(0, "first".to_string()), (2, "third".to_string())];
        let error = report(
            "chan-files",
            3,
            &failures,
            Some(anyhow::anyhow!("the refusal")),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "the refusal");
        assert_eq!(
            report("chan-files", 3, &failures, None)
                .unwrap_err()
                .to_string(),
            "2 of 3 paths were not opened"
        );
        assert_eq!(
            report("chan-files", 1, &failures[..1], None)
                .unwrap_err()
                .to_string(),
            "first"
        );
        assert!(report("chan-files", 2, &[], None).is_ok());
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
