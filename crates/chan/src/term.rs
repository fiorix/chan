//! `chan-term`: open a terminal window, the command a desktop's default
//! terminal runs. Its grammar is the one xdg-terminal-exec drives through
//! `chan-term.desktop`'s `X-TerminalArg*` keys:
//! `chan-term [--dir=PATH] [--app-id=ID] [--title=TITLE] [--hold]
//! [-e CMD ARGS... | -- CMD ARGS...]`.
//!
//! A launch that only runs the user's shell
//! ([`hands_off`](crate::term::hands_off)) is the CLI's (`cmd_term`): it opens
//! a terminal window of the running chan-desktop, as `chan-files` opens a path
//! there, and chan-desktop's own `chan-term` starts the desktop with that
//! terminal when none runs. A launch with a command, `--hold`, `--app-id` or
//! `--title` needs a window of the process's own, so chan-desktop run as
//! `chan-term` opens that window itself; the standalone CLI cannot, and
//! refuses it.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Result};
use chan_server::handoff::{self, CliOpenTerminal, Response};

use crate::opener::{self, Opening};
use crate::Personality;

/// The program name this command is reached by.
pub const NAME: &str = "chan-term";

/// One launch, as xdg-terminal-exec spells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLaunch {
    /// `--dir`, as given; a relative path resolves against the process cwd.
    pub dir: Option<PathBuf>,
    /// `--app-id`: the Wayland app_id and X11 class on the GTK desktops (Linux
    /// and FreeBSD).
    pub app_id: Option<String>,
    /// `--title`: the OS window title, fixed for the window's life.
    pub title: Option<String>,
    /// `--hold`: keep the window after the command exits.
    pub hold: bool,
    /// The exact argv after `-e` or `--`; `None` runs the user's shell.
    pub command: Option<Vec<OsString>>,
}

/// What an argv asks of `chan-term`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Launch(TerminalLaunch),
    /// `-h` or `--help`.
    Help,
    /// `-V` or `--version`.
    Version,
}

/// Whether `arg0` names `chan-term`, by the file-stem rule of the `cs` alias
/// and the openers, so a link, an AppImage wrapper's `$ARGV0` and a `.exe`
/// all match.
pub fn invoked_as_term(arg0: &OsStr) -> bool {
    Path::new(arg0).file_stem() == Some(OsStr::new(NAME))
}

/// Parse argv (without `argv[0]`). No argument runs the shell in the current
/// directory. `-e` or `--` ends the grammar: everything after it is the
/// command's argv, verbatim, so a value that looks like an option is the
/// command's. Before it, an unknown option or a positional argument is a
/// usage error.
pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Invocation, String> {
    let mut launch = TerminalLaunch {
        dir: None,
        app_id: None,
        title: None,
        hold: false,
        command: None,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "-e" || arg == "--" {
            let command: Vec<OsString> = args.collect();
            if command.is_empty() {
                return Err(format!(
                    "{} needs a command after it",
                    arg.to_string_lossy()
                ));
            }
            launch.command = Some(command);
            return Ok(Invocation::Launch(launch));
        }
        if arg == "-h" || arg == "--help" {
            return Ok(Invocation::Help);
        }
        if arg == "-V" || arg == "--version" {
            return Ok(Invocation::Version);
        }
        if let Some(value) = option_value(&arg, "--hold") {
            if value.is_some() {
                return Err("--hold takes no value".to_string());
            }
            launch.hold = true;
            continue;
        }
        let mut valued = None;
        for name in ["--dir", "--app-id", "--title"] {
            if let Some(inline) = option_value(&arg, name) {
                let value = match inline {
                    Some(value) => value.to_os_string(),
                    None => args.next().ok_or_else(|| format!("{name} needs a value"))?,
                };
                if value.is_empty() {
                    return Err(format!("{name} needs a value"));
                }
                valued = Some((name, value));
                break;
            }
        }
        if let Some((name, value)) = valued {
            match name {
                "--dir" => launch.dir = Some(PathBuf::from(value)),
                "--app-id" => launch.app_id = Some(utf8(name, value)?),
                _ => launch.title = Some(utf8(name, value)?),
            }
            continue;
        }
        let text = arg.to_string_lossy();
        if text.starts_with('-') {
            return Err(format!("unknown option {text}"));
        }
        return Err(format!(
            "unexpected argument {text}: put -e or -- before the command"
        ));
    }
    Ok(Invocation::Launch(launch))
}

/// [`parse`] for a process: `--help` and `--version` print and exit 0, and a
/// usage error prints the reason and the usage line and exits 2.
pub fn parse_or_exit(args: impl IntoIterator<Item = OsString>) -> TerminalLaunch {
    match parse(args) {
        Ok(Invocation::Launch(launch)) => launch,
        Ok(Invocation::Help) => {
            print!("{}", crate::help::CHAN_TERM_HELP);
            std::process::exit(0)
        }
        Ok(Invocation::Version) => {
            println!("{NAME} {}", crate::cli::CHAN_VERSION);
            std::process::exit(0)
        }
        Err(error) => {
            eprintln!("{NAME}: {error}");
            eprintln!("{}", crate::help::CHAN_TERM_USAGE);
            std::process::exit(2)
        }
    }
}

/// `Some(None)` for a bare `--name`, `Some(Some(value))` for `--name=value`,
/// `None` when `arg` is another option or a positional.
fn option_value<'a>(arg: &'a OsStr, name: &str) -> Option<Option<&'a OsStr>> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let bytes = arg.as_bytes();
        if bytes == name.as_bytes() {
            return Some(None);
        }
        let rest = bytes.strip_prefix(name.as_bytes())?;
        rest.strip_prefix(b"=")
            .map(|value| Some(OsStr::from_bytes(value)))
    }
    #[cfg(not(unix))]
    {
        let text = arg.to_str()?;
        if text == name {
            return Some(None);
        }
        let rest = text.strip_prefix(name)?;
        rest.strip_prefix('=').map(|value| Some(OsStr::new(value)))
    }
}

/// Whether `arg` is an option of the launch grammar: `-e`, `--`, or `--hold`,
/// `--dir`, `--app-id` or `--title`, bare or with `=value`. chan-desktop
/// refuses one with a pointer here, since it runs no terminal of its own.
pub fn is_launch_option(arg: &OsStr) -> bool {
    arg == "-e"
        || arg == "--"
        || ["--hold", "--dir", "--app-id", "--title"]
            .iter()
            .any(|name| option_value(arg, name).is_some())
}

fn utf8(name: &str, value: OsString) -> Result<String, String> {
    value
        .into_string()
        .map_err(|_| format!("{name} must be valid UTF-8"))
}

/// Whether a launch may be handed to a running chan-desktop instead of
/// opening its own window. Only a launch that runs the user's shell with no
/// per-process contract: a command must end the process with its exit code,
/// `--hold` keeps a window this process owns, and the running desktop can
/// honor neither a per-process `--app-id` (GTK takes it from the program name)
/// nor a fixed `--title`.
pub fn hands_off(launch: &TerminalLaunch) -> bool {
    own_window_reason(launch).is_none()
}

/// What in `launch` needs a window of its own, for the sentence that says so.
fn own_window_reason(launch: &TerminalLaunch) -> Option<&'static str> {
    if launch.command.is_some() {
        Some("a command")
    } else if launch.hold {
        Some("--hold")
    } else if launch.app_id.is_some() {
        Some("--app-id")
    } else if launch.title.is_some() {
        Some("--title")
    } else {
        None
    }
}

/// Where the terminal starts: `requested` (`--dir`) resolved against the
/// process cwd, else the process cwd itself, which is the launcher's own
/// (xdg-terminal-exec inherits it). A path that is not a directory falls back
/// to `home` with a warning for the caller to log, because a launcher passing
/// a stale directory must still get a window.
pub fn resolve_working_dir(
    requested: Option<&Path>,
    process_cwd: &Path,
    home: Option<&Path>,
    is_dir: impl Fn(&Path) -> bool,
) -> (PathBuf, Option<String>) {
    let Some(requested) = requested else {
        return (process_cwd.to_path_buf(), None);
    };
    let dir = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        process_cwd.join(requested)
    };
    if is_dir(&dir) {
        return (dir, None);
    }
    let fallback = home
        .map(Path::to_path_buf)
        .unwrap_or_else(|| process_cwd.to_path_buf());
    let warning = format!(
        "{} is not a directory; starting in {}",
        dir.display(),
        fallback.display()
    );
    (fallback, Some(warning))
}

/// The launch's start directory (see [`resolve_working_dir`]), logging the
/// fallback when `--dir` names no directory.
pub fn start_dir(launch: &TerminalLaunch) -> PathBuf {
    let home = std::env::home_dir();
    let process_cwd = std::env::current_dir()
        .ok()
        .or_else(|| home.clone())
        .unwrap_or_else(|| PathBuf::from("/"));
    let (cwd, warning) = resolve_working_dir(
        launch.dir.as_deref(),
        &process_cwd,
        home.as_deref(),
        |dir| dir.is_dir(),
    );
    if let Some(warning) = warning {
        tracing::warn!("{warning}");
    }
    cwd
}

/// `chan-term` for a launch that runs the user's shell: a terminal window of
/// the running chan-desktop in the start directory, which the desktop has
/// [`opener::ANSWER_BOUND`] to open, as a path of `chan-files` does. Nothing
/// listening is no desktop: the desktop personality starts one with the
/// terminal, which its boot opens in place of its first window, and the
/// standalone CLI says none is running. A launch that needs a window of its
/// own never reaches the desktop personality here (chan-desktop opens that
/// window itself), and the standalone CLI refuses it.
pub(crate) async fn cmd_term(launch: TerminalLaunch, personality: Personality) -> Result<()> {
    if let Some(reason) = own_window_reason(&launch) {
        bail!(
            "{reason} needs a window of chan-term's own, which only Chan Desktop's chan-term \
             opens; this chan is the standalone CLI, whose chan-term only asks a running \
             chan-desktop for a shell window"
        );
    }
    if handoff::handoff_opt_out() {
        bail!(
            "CHAN_NO_DESKTOP_HANDOFF is set, so {NAME} asks chan-desktop for no window; unset \
             CHAN_NO_DESKTOP_HANDOFF"
        );
    }
    if !handoff::gui_session_present() {
        bail!(
            "{NAME} opens its window in chan-desktop, and this session has no display (an SSH \
             login, or no DISPLAY or WAYLAND_DISPLAY)"
        );
    }
    let cwd = start_dir(&launch);
    let Some(cwd_text) = cwd.to_str() else {
        bail!(
            "{} is not valid UTF-8, which a request to chan-desktop cannot carry",
            cwd.display()
        );
    };
    match ask_desktop(cwd_text).await {
        CliOpenTerminal::Opened => Ok(()),
        CliOpenTerminal::Refused { reply } => bail!(
            "chan-desktop did not open a terminal in {cwd_text}: {}",
            refusal_reason(&reply)
        ),
        CliOpenTerminal::Silent => {
            bail!("chan-desktop did not answer for a terminal in {cwd_text}")
        }
        CliOpenTerminal::NotListening => {
            opener::launch_desktop(
                NAME,
                Opening::Terminal(cwd_text),
                opener::when_no_desktop(personality),
            )
            .await
        }
    }
}

/// One `OpenTerminal` within [`opener::ANSWER_BOUND`], asked again while a
/// listener closes without an answer, as the openers ask for a path. Nothing
/// listening on the first ask is no desktop; once one was heard, its going
/// away is silence, since another may be on its way up.
async fn ask_desktop(cwd: &str) -> CliOpenTerminal {
    let deadline = Instant::now() + opener::ANSWER_BOUND;
    let mut heard = false;
    loop {
        let budget = deadline.saturating_duration_since(Instant::now());
        match handoff::try_open_terminal(cwd, budget).await {
            CliOpenTerminal::NotListening if !heard => return CliOpenTerminal::NotListening,
            CliOpenTerminal::NotListening | CliOpenTerminal::Silent => {
                heard = true;
                if Instant::now() + opener::ASK_AGAIN_AFTER >= deadline {
                    return CliOpenTerminal::Silent;
                }
                tokio::time::sleep(opener::ASK_AGAIN_AFTER).await;
            }
            answered => return answered,
        }
    }
}

/// The sentence for a desktop's refusal line: its own message, or what a
/// desktop of another protocol means.
fn refusal_reason(reply: &str) -> String {
    match serde_json::from_str::<Response>(reply) {
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

/// Whether `args` (without `argv[0]`) are a `chan-term` launch that only runs
/// the user's shell: what chan-desktop runs as the CLI rather than as a window
/// of its own. Help, version and a usage error are not.
pub fn is_shell_launch(args: impl IntoIterator<Item = OsString>) -> bool {
    matches!(parse(args), Ok(Invocation::Launch(launch)) if hands_off(&launch))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    fn parse_str(items: &[&str]) -> Result<Invocation, String> {
        parse(args(items))
    }

    fn launch(items: &[&str]) -> TerminalLaunch {
        match parse_str(items) {
            Ok(Invocation::Launch(launch)) => launch,
            other => panic!("{items:?} is not a launch: {other:?}"),
        }
    }

    fn error(items: &[&str]) -> String {
        parse_str(items).expect_err("a usage error")
    }

    #[test]
    fn the_name_matches_by_file_stem() {
        for arg0 in [
            "chan-term",
            "/usr/bin/chan-term",
            "/home/u/.local/bin/chan-term",
            r"C:/Program Files/chan/chan-term.exe",
        ] {
            assert!(invoked_as_term(OsStr::new(arg0)), "{arg0}");
        }
        for arg0 in [
            "chan",
            "chan-desktop",
            "chan-terminal",
            "/usr/bin/chan-term/x",
            "",
        ] {
            assert!(!invoked_as_term(OsStr::new(arg0)), "{arg0}");
        }
    }

    #[test]
    fn no_argument_runs_the_shell_here() {
        let launch = launch(&[]);
        assert_eq!(
            launch,
            TerminalLaunch {
                dir: None,
                app_id: None,
                title: None,
                hold: false,
                command: None,
            }
        );
        assert!(hands_off(&launch));
    }

    #[test]
    fn help_and_version_answer_before_a_command() {
        for help in ["-h", "--help"] {
            assert_eq!(parse_str(&[help]), Ok(Invocation::Help));
            assert_eq!(parse_str(&["--dir=/x", help]), Ok(Invocation::Help));
        }
        for version in ["-V", "--version"] {
            assert_eq!(parse_str(&[version]), Ok(Invocation::Version));
        }
        assert_eq!(
            launch(&["-e", "ls", "--help"]).command,
            Some(args(&["ls", "--help"]))
        );
    }

    /// The desktop entry's `%U` and a GUI launch's path have no place here:
    /// chan-term is never the GUI, so what the old GUI fallback took is an
    /// error now.
    #[test]
    fn positional_arguments_and_unknown_options_are_errors() {
        for positional in [&["%U"][..], &["chan://x"], &["/home/u/notes"], &["vim"]] {
            let err = error(positional);
            assert!(err.contains("put -e or -- before the command"), "{err}");
        }
        for unknown in [&["--foo"][..], &["-x", "--dir=/t"], &["--hold", "--foo"]] {
            let err = error(unknown);
            assert!(err.starts_with("unknown option -"), "{unknown:?}: {err}");
        }
    }

    #[test]
    fn dash_e_takes_the_rest_as_the_exact_argv() {
        let script = "for i in 1 2; do echo $i; done";
        let launch = launch(&["-e", "bash", "-c", script]);
        assert_eq!(launch.command, Some(args(&["bash", "-c", script])));
        assert_eq!(launch.dir, None);
        assert!(!launch.hold);
    }

    #[test]
    fn double_dash_takes_the_rest_as_the_exact_argv() {
        let launch = launch(&["--", "ls", "--color=auto", "--", "-e"]);
        assert_eq!(
            launch.command,
            Some(args(&["ls", "--color=auto", "--", "-e"]))
        );
    }

    #[test]
    fn dash_e_ends_option_parsing() {
        let launch = launch(&["-e", "printf", "--dir=/x", "--hold"]);
        assert_eq!(
            launch.command,
            Some(args(&["printf", "--dir=/x", "--hold"]))
        );
        assert_eq!(launch.dir, None);
        assert!(!launch.hold);
    }

    #[test]
    fn dash_e_or_double_dash_alone_is_an_error() {
        for bad in [&["-e"][..], &["--dir=/x", "-e"], &["--"]] {
            let err = error(bad);
            assert!(err.contains("needs a command"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn options_accept_equals_and_separate_values() {
        assert_eq!(launch(&["--dir=/tmp"]), launch(&["--dir", "/tmp"]));
        assert_eq!(launch(&["--title=Build"]), launch(&["--title", "Build"]));
        assert_eq!(
            launch(&["--app-id=org.x.y"]),
            launch(&["--app-id", "org.x.y"])
        );
        assert_eq!(launch(&["--dir=/tmp"]).dir, Some(PathBuf::from("/tmp")));
        assert_eq!(launch(&["--title=Build"]).title.as_deref(), Some("Build"));
        assert_eq!(
            launch(&["--app-id=org.x.y"]).app_id.as_deref(),
            Some("org.x.y")
        );
    }

    #[test]
    fn a_value_is_taken_verbatim_even_when_it_looks_like_an_option() {
        let dashed = launch(&["--title", "-e", "-e", "x"]);
        assert_eq!(dashed.title.as_deref(), Some("-e"));
        assert_eq!(dashed.command, Some(args(&["x"])));
        assert_eq!(
            launch(&["--title", "--help"]).title.as_deref(),
            Some("--help")
        );
    }

    #[test]
    fn valued_options_require_a_value() {
        for bad in [&["--dir"][..], &["--dir="], &["--title="], &["--app-id="]] {
            let err = error(bad);
            assert!(err.contains("needs a value"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn hold_takes_no_value() {
        let launch = launch(&["--hold"]);
        assert!(launch.hold);
        assert_eq!(launch.command, None);
        assert_eq!(error(&["--hold=1"]), "--hold takes no value");
    }

    #[test]
    fn a_repeated_option_keeps_the_last_value() {
        assert_eq!(
            launch(&["--dir=/a", "--dir=/b"]).dir,
            Some(PathBuf::from("/b"))
        );
    }

    #[test]
    fn a_relative_dir_is_kept_as_given() {
        assert_eq!(launch(&["--dir=notes"]).dir, Some(PathBuf::from("notes")));
    }

    #[test]
    fn dash_e_may_follow_every_option() {
        let launch = launch(&[
            "--title=Build",
            "--hold",
            "--app-id=a.b",
            "--dir=/w",
            "-e",
            "make",
            "-j4",
        ]);
        assert_eq!(launch.title.as_deref(), Some("Build"));
        assert!(launch.hold);
        assert_eq!(launch.app_id.as_deref(), Some("a.b"));
        assert_eq!(launch.dir, Some(PathBuf::from("/w")));
        assert_eq!(launch.command, Some(args(&["make", "-j4"])));
    }

    #[cfg(unix)]
    #[test]
    fn title_and_app_id_must_be_utf8() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(b"--title=\xff".to_vec());
        let err = parse([raw]).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
        let raw = OsString::from_vec(b"\xff".to_vec());
        let err = parse([OsString::from("--app-id"), raw]).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn command_argv_and_dir_keep_non_utf8_bytes() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(b"\xff\xfe".to_vec());
        let Ok(Invocation::Launch(launch)) = parse([OsString::from("-e"), raw.clone()]) else {
            panic!("a launch");
        };
        assert_eq!(launch.command, Some(vec![raw]));
        let dir = OsString::from_vec(b"--dir=/\xff".to_vec());
        let Ok(Invocation::Launch(launch)) = parse([dir]) else {
            panic!("a launch");
        };
        assert_eq!(
            launch.dir,
            Some(PathBuf::from(OsString::from_vec(b"/\xff".to_vec())))
        );
    }

    #[test]
    fn the_launch_options_are_the_grammars() {
        for option in [
            "-e",
            "--",
            "--hold",
            "--hold=1",
            "--dir",
            "--dir=/x",
            "--app-id",
            "--app-id=a",
            "--title",
            "--title=t",
        ] {
            assert!(is_launch_option(OsStr::new(option)), "{option}");
        }
        for other in [
            "--help",
            "--version",
            "-psn_0_1",
            "--directory",
            "notes.md",
            "-",
        ] {
            assert!(!is_launch_option(OsStr::new(other)), "{other}");
        }
    }

    #[test]
    fn only_a_shell_launch_with_no_per_process_contract_hands_off() {
        assert!(hands_off(&launch(&[])), "a bare launch");
        assert!(hands_off(&launch(&["--dir=/tmp"])));
        let own = |items: &[&str]| own_window_reason(&launch(items));
        assert_eq!(
            own(&["-e", "htop"]),
            Some("a command"),
            "a command owns the exit code"
        );
        assert_eq!(own(&["--", "htop"]), Some("a command"));
        assert_eq!(
            own(&["--hold"]),
            Some("--hold"),
            "--hold keeps a window this process owns"
        );
        assert_eq!(
            own(&["--dir=/tmp", "--app-id=floating"]),
            Some("--app-id"),
            "the app id is per process"
        );
        assert_eq!(
            own(&["--title=Logs"]),
            Some("--title"),
            "the running desktop composes its own titles"
        );
    }

    /// What chan-desktop runs as the CLI: a launch with nothing but the
    /// shell's directory. Help, version, a usage error and a launch that
    /// needs its own window are the desktop's to answer.
    #[test]
    fn a_shell_launch_is_one_with_no_per_process_contract() {
        for shell in [&[][..], &["--dir=/tmp"], &["--dir", "notes"]] {
            assert!(is_shell_launch(args(shell)), "{shell:?}");
        }
        for other in [
            &["-e", "htop"][..],
            &["--hold"],
            &["--title=T"],
            &["--app-id=a"],
            &["--help"],
            &["-V"],
            &["htop"],
            &["--foo"],
        ] {
            assert!(!is_shell_launch(args(other)), "{other:?}");
        }
    }

    #[test]
    fn no_dir_means_the_process_cwd() {
        let (dir, warning) = resolve_working_dir(
            None,
            Path::new("/proc-cwd"),
            Some(Path::new("/home/u")),
            |_| true,
        );
        assert_eq!(dir, PathBuf::from("/proc-cwd"));
        assert_eq!(warning, None);
    }

    #[test]
    fn a_relative_dir_resolves_against_the_process_cwd() {
        // Joined with the platform's separator, as the resolver joins.
        let expected = Path::new("/proc-cwd").join("notes");
        let (dir, warning) = resolve_working_dir(
            Some(Path::new("notes")),
            Path::new("/proc-cwd"),
            Some(Path::new("/home/u")),
            |dir| dir == expected,
        );
        assert_eq!(dir, expected);
        assert_eq!(warning, None);
    }

    #[test]
    fn a_missing_dir_falls_back_to_home_with_a_warning() {
        let (dir, warning) = resolve_working_dir(
            Some(Path::new("/gone")),
            Path::new("/proc-cwd"),
            Some(Path::new("/home/u")),
            |_| false,
        );
        assert_eq!(dir, PathBuf::from("/home/u"));
        let warning = warning.expect("a warning names the fallback");
        assert!(
            warning.contains("/gone") && warning.contains("/home/u"),
            "{warning}"
        );
    }

    /// The help is what the packages' container smokes grep for, and the
    /// usage line is the one a usage error prints.
    #[test]
    fn the_help_opens_with_the_usage_line() {
        assert!(
            crate::help::CHAN_TERM_HELP.contains(&format!("\n{}\n", crate::help::CHAN_TERM_USAGE)),
            "{}",
            crate::help::CHAN_TERM_HELP
        );
        assert!(crate::help::CHAN_TERM_USAGE.starts_with("Usage: chan-term "));
    }
}
