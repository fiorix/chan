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
pub(crate) const ANSWER_BOUND: Duration = Duration::from_secs(5);

/// The pause before asking again a listener that closed without an answer.
pub(crate) const ASK_AGAIN_AFTER: Duration = Duration::from_millis(200);

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
             display ({}); run {name} in a chan terminal",
            headless_session(cfg!(target_os = "macos"))
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
                launch_desktop(name, Opening::Paths(&all), when_no_desktop(personality)).await?;
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

/// What a session [`handoff::gui_session_present`] reads as headless lacks,
/// for the refusals that say so: an SSH login is headless everywhere, and no
/// `DISPLAY` or `WAYLAND_DISPLAY` only off macOS, whose check reads neither.
pub(crate) fn headless_session(macos: bool) -> &'static str {
    if macos {
        "an SSH login"
    } else {
        "an SSH login, or no DISPLAY or WAYLAND_DISPLAY"
    }
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
pub(crate) enum NoDesktop {
    /// Start one with the paths: this binary is chan-desktop.
    Launch,
    /// Say so and fail: the standalone CLI has no desktop of its own to start.
    Refuse,
}

/// The desktop personality's `current_exe` is the desktop, so it can start
/// one, as its `chan serve` does; on Windows, where a standalone window has
/// no file surface, neither starts one.
pub(crate) fn when_no_desktop(personality: Personality) -> NoDesktop {
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
    /// The endpoint is served and the started process outlived the guard's
    /// bound: it is the desktop.
    Up,
    /// The started process exited 0: it found a desktop on its way up and
    /// handed it the paths, which that desktop opens or refuses.
    HandedOver,
    /// It exited non-zero: the desktop it found never answered it.
    Unanswered,
}

/// The process the command started settles it first: a second launch exits
/// from its single-instance guard, so its status says whether the desktop it
/// found took the paths. A served endpoint says the started process is the
/// desktop only once that process has outlived the guard's bound
/// (`past_guard`): before then the listener can be a desktop still booting,
/// which binds before it answers, with the started process asking it.
#[cfg(unix)]
fn started(exited: Option<bool>, served: bool, past_guard: bool) -> Started {
    match (exited, served, past_guard) {
        (Some(true), ..) => Started::HandedOver,
        (Some(false), ..) => Started::Unanswered,
        (None, true, true) => Started::Up,
        (None, ..) => Started::Waiting,
    }
}

/// The bounds a launch is read within.
#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
struct LaunchBounds {
    /// How often the started process and the endpoint are read.
    poll: Duration,
    /// How long from the start a running process may still be a second
    /// launch asking another desktop: the guard's ask bound and a grace.
    guard: Duration,
    /// How long the launch has to settle, the bound `chan serve` gives the
    /// desktop it launches.
    deadline: Duration,
}

/// What the guard's ask bound is given on top of itself before a running
/// process is taken for the desktop.
#[cfg(unix)]
const GUARD_GRACE: Duration = Duration::from_secs(2);

#[cfg(unix)]
const LAUNCH_BOUNDS: LaunchBounds = LaunchBounds {
    poll: Duration::from_millis(400),
    guard: Duration::from_secs(ANSWER_BOUND.as_secs() + GUARD_GRACE.as_secs()),
    deadline: Duration::from_secs(20),
};

/// Read a launch until it settles ([`started`]): `exited` reads the started
/// process's exit, `true` for success, and `served` whether the endpoint is
/// served. `None` when nothing settles within the deadline.
#[cfg(unix)]
async fn watch_launch<F>(
    bounds: LaunchBounds,
    mut exited: impl FnMut() -> Option<bool>,
    mut served: impl FnMut() -> F,
) -> Option<Started>
where
    F: std::future::Future<Output = bool>,
{
    let start = Instant::now();
    while start.elapsed() < bounds.deadline {
        tokio::time::sleep(bounds.poll).await;
        let exited = exited();
        let past_guard = start.elapsed() >= bounds.guard;
        let served = exited.is_none() && past_guard && served().await;
        match started(exited, served, past_guard) {
            Started::Waiting => {}
            settled => return Some(settled),
        }
    }
    None
}

/// What a command asks the desktop it starts to open. Off unix no command
/// starts a desktop, so there only the variant is read, for the refusal.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) enum Opening<'a> {
    /// The paths of `chan-files` and `chan-edit`.
    Paths(&'a [String]),
    /// The terminal window of a `chan-term` shell, which starts in this
    /// directory.
    Terminal(&'a str),
}

impl Opening<'_> {
    #[cfg_attr(not(unix), allow(dead_code))]
    fn describe(self) -> String {
        match self {
            Opening::Paths(paths) => paths.join(", "),
            Opening::Terminal(dir) => format!("a terminal in {dir}"),
        }
    }
}

#[cfg(unix)]
pub(crate) async fn launch_desktop(
    name: &str,
    opening: Opening<'_>,
    action: NoDesktop,
) -> Result<()> {
    if action == NoDesktop::Refuse {
        bail!(not_running(name, opening));
    }
    let (paths, terminal) = match opening {
        Opening::Paths(paths) => (paths, None),
        Opening::Terminal(dir) => (&[][..], Some(dir)),
    };
    let mut child = crate::desktop::spawn_desktop_gui_opening(paths, terminal)
        .map_err(|error| anyhow::anyhow!("starting chan-desktop: {error}"))?;
    let exited = || {
        child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten())
            .map(|status| status.success())
    };
    match watch_launch(LAUNCH_BOUNDS, exited, handoff::desktop_is_live).await {
        Some(Started::Up) => {
            eprintln!("started chan-desktop to open {}", opening.describe());
            Ok(())
        }
        Some(Started::HandedOver) => {
            eprintln!(
                "handed {} to the chan-desktop that was starting; it decides what to open",
                opening.describe()
            );
            Ok(())
        }
        Some(Started::Unanswered) => {
            bail!("a chan-desktop was starting and did not answer; run {name} again once it is up")
        }
        Some(Started::Waiting) | None => bail!(
            "started chan-desktop, and it did not come up within {} s; run {name} again once it \
             is up",
            LAUNCH_BOUNDS.deadline.as_secs()
        ),
    }
}

#[cfg(not(unix))]
pub(crate) async fn launch_desktop(
    name: &str,
    opening: Opening<'_>,
    _action: NoDesktop,
) -> Result<()> {
    bail!(not_running(name, opening))
}

/// A `chan-term` in a chan terminal still asks the desktop, so only the
/// openers can point at one.
fn not_running(name: &str, opening: Opening<'_>) -> String {
    match opening {
        Opening::Paths(_) => format!(
            "chan-desktop is not running; start it and run {name} again, or run {name} in a \
             chan terminal"
        ),
        Opening::Terminal(_) => {
            format!("chan-desktop is not running; start it and run {name} again")
        }
    }
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

    /// The headless refusals name what the check reads on the platform: an
    /// SSH login alone on macOS, and the display variables too elsewhere.
    #[test]
    fn the_headless_refusal_names_only_what_the_check_reads() {
        assert_eq!(headless_session(true), "an SSH login");
        assert_eq!(
            headless_session(false),
            "an SSH login, or no DISPLAY or WAYLAND_DISPLAY"
        );
    }

    /// The process a command started settles the launch before the endpoint
    /// does: a second launch's exit says whether the desktop it found took
    /// the paths, whatever the endpoint shows by then, and a served endpoint
    /// counts only past the guard's bound.
    #[cfg(unix)]
    #[test]
    fn a_started_desktop_is_read_from_its_exit_first() {
        for past_guard in [false, true] {
            assert_eq!(started(None, false, past_guard), Started::Waiting);
            for served in [false, true] {
                assert_eq!(started(Some(true), served, past_guard), Started::HandedOver);
                assert_eq!(
                    started(Some(false), served, past_guard),
                    Started::Unanswered
                );
            }
        }
        assert_eq!(started(None, true, false), Started::Waiting);
        assert_eq!(started(None, true, true), Started::Up);
    }

    #[cfg(unix)]
    #[test]
    fn the_launch_waits_out_the_guards_ask_before_it_reads_the_endpoint() {
        assert_eq!(LAUNCH_BOUNDS.guard, ANSWER_BOUND + GUARD_GRACE);
        assert!(LAUNCH_BOUNDS.guard < LAUNCH_BOUNDS.deadline);
    }

    #[cfg(unix)]
    const SHORT: LaunchBounds = LaunchBounds {
        poll: Duration::from_millis(20),
        guard: Duration::from_millis(600),
        deadline: Duration::from_secs(5),
    };

    /// The started process is a second launch whose guard is asking a desktop
    /// that bound its listener and stays silent: the endpoint reads served at
    /// once, and the process exits 1 when its ask runs out, within the guard
    /// bound. That is the failure, never a start.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_launch_asking_a_silent_desktop_is_not_a_start() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 0.3; exit 1"])
            .spawn()
            .unwrap();
        let exited = || child.try_wait().unwrap().map(|status| status.success());
        let settled = watch_launch(SHORT, exited, || async { true }).await;
        assert_eq!(settled, Some(Started::Unanswered));
    }

    /// A launch that handed its paths to a desktop on its way up exits 0.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_launch_that_handed_over_is_read_as_such() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 0.1; exit 0"])
            .spawn()
            .unwrap();
        let exited = || child.try_wait().unwrap().map(|status| status.success());
        let settled = watch_launch(SHORT, exited, || async { true }).await;
        assert_eq!(settled, Some(Started::HandedOver));
    }

    /// The started process is the desktop: still running past the guard's
    /// bound with the endpoint served. It is reported up then, not before.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_started_desktop_is_up_once_past_the_guard() {
        let begun = Instant::now();
        let settled = watch_launch(SHORT, || None, || async { true }).await;
        assert_eq!(settled, Some(Started::Up));
        assert!(begun.elapsed() >= SHORT.guard, "{:?}", begun.elapsed());
        let never = LaunchBounds {
            deadline: Duration::from_millis(200),
            ..SHORT
        };
        assert_eq!(watch_launch(never, || None, || async { false }).await, None);
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
