//! A default-terminal launch, the command-line contract xdg-terminal-exec
//! drives through the desktop entry's `X-TerminalArg*` keys:
//! `chan-desktop [--dir=PATH] [--app-id=ID] [--title=TITLE] [--hold]
//! [-e CMD ARGS... | -- CMD ARGS...]`. One terminal-only window in its own
//! process, with none of the launcher's boot (shims, library stores, the
//! handoff listener, the window watcher, gateways, the update check), so a
//! launch beside a running chan-desktop leaves it alone.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::RunEvent;

use crate::config::ConfigStore;
use crate::embedded::EmbeddedServer;
use crate::{serve, AppState};

/// The Tauri label of the one window a default-terminal launch opens. Its own
/// family: not a watcher label (`local::`, `lib-`), so no bury and no close
/// prompt, and not a devserver control terminal, so no reaping.
pub(crate) const WINDOW_LABEL: &str = "terminal-exec";

/// One default-terminal launch, as xdg-terminal-exec spells it.
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

/// Parse argv (without `argv[0]`). `Ok(None)` is not a terminal launch: the GUI
/// runs as it always has, so positional arguments (the entry's `%U`) and
/// unknown options before any terminal flag keep today's meaning. Once a
/// terminal flag has been seen the grammar is strict, and `-e` or `--` ends
/// it: everything after is the command's argv, verbatim.
pub fn parse_terminal_launch(
    args: impl IntoIterator<Item = OsString>,
) -> Result<Option<TerminalLaunch>, String> {
    let mut launch = TerminalLaunch {
        dir: None,
        app_id: None,
        title: None,
        hold: false,
        command: None,
    };
    let mut terminal = false;
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
            return Ok(Some(launch));
        }
        if let Some(value) = option_value(&arg, "--hold") {
            if value.is_some() {
                return Err("--hold takes no value".to_string());
            }
            launch.hold = true;
            terminal = true;
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
            terminal = true;
            continue;
        }
        if !terminal {
            return Ok(None);
        }
        let text = arg.to_string_lossy();
        if text.starts_with('-') {
            return Err(format!("unknown option {text}"));
        }
        return Err(format!(
            "unexpected argument {text}: put -e or -- before the command"
        ));
    }
    Ok(terminal.then_some(launch))
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

fn utf8(name: &str, value: OsString) -> Result<String, String> {
    value
        .into_string()
        .map_err(|_| format!("{name} must be valid UTF-8"))
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

/// The process exit code for the command's exit. A signal death reads as 1
/// through `wire_code`, and a status the registry could not observe is not a
/// success either.
pub fn process_exit_code(exit: &chan_server::TerminalExit) -> i32 {
    exit.wire_code()
        .map_or(1, |code| i32::try_from(code).unwrap_or(1))
}

/// `--title`, else the program's name, else `Terminal`.
pub fn default_title(launch: &TerminalLaunch) -> String {
    if let Some(title) = &launch.title {
        return title.clone();
    }
    launch
        .command
        .as_ref()
        .and_then(|argv| argv.first())
        .map(|argv0| {
            Path::new(argv0)
                .file_name()
                .unwrap_or(argv0)
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_else(|| "Terminal".to_string())
}

/// The argv a New Window sibling starts with: the same directory and app id,
/// the shell rather than the command, no title and no hold. `--dir` is always
/// present because a terminal flag is what selects this mode; without one the
/// sibling would launch the GUI.
pub fn sibling_args(dir: &Path, app_id: Option<&str>) -> Vec<OsString> {
    let mut dir_arg = OsString::from("--dir=");
    dir_arg.push(dir);
    let mut args = vec![dir_arg];
    if let Some(app_id) = app_id {
        args.push(format!("--app-id={app_id}").into());
    }
    args
}

/// Resolve `argv[0]` the way execvp will: as a path when it carries a separator
/// (relative to `cwd`), else as the first executable match on `path`. Run
/// before any window opens so a missing program fails with the shell's 127
/// instead of a window sitting on a spawn error.
pub fn preflight_command(
    argv0: &OsStr,
    path: Option<&OsStr>,
    cwd: &Path,
    is_executable: impl Fn(&Path) -> bool,
) -> Result<(), String> {
    let candidate = Path::new(argv0);
    let name = candidate.display();
    if candidate.components().count() > 1 {
        let full = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            cwd.join(candidate)
        };
        return if is_executable(&full) {
            Ok(())
        } else {
            Err(format!("{name}: not an executable file"))
        };
    }
    let found = path.is_some_and(|path| {
        std::env::split_paths(path).any(|dir| is_executable(&dir.join(candidate)))
    });
    if found {
        Ok(())
    } else {
        Err(format!("{name}: command not found"))
    }
}

fn executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The live state of a default-terminal launch, managed on the Tauri app so
/// the exit watcher, the run loop and New Window read one record.
pub(crate) struct TerminalMode {
    launch: TerminalLaunch,
    /// The resolved start directory, which a sibling launch inherits.
    cwd: PathBuf,
    /// The `/exec` tenant prefix once mounted; the exit watcher polls it.
    prefix: OnceLock<String>,
    /// The command's exit code once seen, so a window closed after `--hold`
    /// still ends the process with it.
    exit_code: Mutex<Option<i32>>,
}

/// Run as a default terminal when argv asks for it. `Ok(true)` means the
/// launch was handled (the event loop ends the process); `Ok(false)` means a
/// plain GUI launch; `Err` is a usage error.
pub fn run_if_requested() -> Result<bool, String> {
    let Some(launch) = parse_terminal_launch(std::env::args_os().skip(1))? else {
        return Ok(false);
    };
    run(launch)
}

fn fatal(code: i32, message: &str) -> ! {
    eprintln!("chan-desktop: {message}");
    std::process::exit(code)
}

fn run(launch: TerminalLaunch) -> Result<bool, String> {
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    if let Some(app_id) = &launch.app_id {
        set_gtk_program_name(app_id);
    }
    let home = dirs::home_dir();
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
    if let Some(argv) = &launch.command {
        if let Err(e) = preflight_command(
            &argv[0],
            std::env::var_os("PATH").as_deref(),
            &cwd,
            executable_file,
        ) {
            fatal(127, &e);
        }
    }
    let store = ConfigStore::new().map_err(|e| format!("initializing the config store: {e}"))?;
    let state = Arc::new(AppState::with_store(Arc::new(Mutex::new(store))));
    let mode = Arc::new(TerminalMode {
        launch,
        cwd,
        prefix: OnceLock::new(),
        exit_code: Mutex::new(None),
    });
    let state_for_setup = Arc::clone(&state);
    let mode_for_setup = Arc::clone(&mode);
    let mode_for_run = Arc::clone(&mode);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Registered so the updater's state exists for the shared command table;
    // nothing in this mode starts a check. FreeBSD has no updater.
    #[cfg(not(target_os = "freebsd"))]
    let app = app.plugin(tauri_plugin_updater::Builder::new().build());
    let app = app
        .manage(state)
        .manage(mode)
        .setup(move |app| {
            crate::install_app_menu(app.handle())?;
            #[cfg(target_os = "macos")]
            crate::fix_macos_login_path();
            let embedded = tauri::async_runtime::block_on(EmbeddedServer::start_terminal_only())
                .unwrap_or_else(|e| fatal(126, &format!("starting the terminal host: {e}")));
            let _ = state_for_setup.embedded.set(embedded);
            let embedded = state_for_setup
                .embedded()
                .expect("the terminal host was just installed");
            let program = mode_for_setup.launch.command.clone();
            let (url, prefix) = tauri::async_runtime::block_on(
                embedded.open_terminal_with_program(program, mode_for_setup.cwd.clone()),
            )
            .unwrap_or_else(|e| fatal(126, &format!("opening the terminal: {e}")));
            let _ = mode_for_setup.prefix.set(prefix.clone());
            let title = default_title(&mode_for_setup.launch);
            if let Err(e) = tauri::async_runtime::block_on(serve::spawn_terminal_mode_window(
                app.handle().clone(),
                &title,
                &url,
            )) {
                let _ = tauri::async_runtime::block_on(embedded.close_terminal_tenant(&prefix));
                fatal(1, &format!("opening the terminal window: {e}"));
            }
            spawn_exit_watcher(
                app.handle().clone(),
                Arc::clone(&state_for_setup),
                Arc::clone(&mode_for_setup),
            );
            Ok(())
        })
        .invoke_handler(crate::app_invoke_handler())
        .build(crate::app_context())
        .map_err(|e| format!("building the terminal window application: {e}"))?;
    app.run(move |app, event| {
        // The last window is gone (the close button, Ctrl+D on an exited tab
        // under --hold, Cmd+W): drain the tenant and exit with the command's
        // code when it is known. An exit the watcher requested carries its own
        // code and passes.
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            api.prevent_exit();
            let code = mode_for_run.exit_code.lock().unwrap().unwrap_or(0);
            let _ = crate::begin_normal_shutdown(app.clone(), crate::ShutdownAction::Exit(code));
        }
    });
    Ok(true)
}

/// Poll the tenant for the command's exit. The devserver control terminal
/// polls its tenant once a second; here a fifth of that keeps the lag after
/// `exit` under what a user notices, and the read is a lock and a map lookup.
fn spawn_exit_watcher(app: tauri::AppHandle, state: Arc<AppState>, mode: Arc<TerminalMode>) {
    tauri::async_runtime::spawn(async move {
        const POLL: Duration = Duration::from_millis(200);
        loop {
            tokio::time::sleep(POLL).await;
            let Some(prefix) = mode.prefix.get() else {
                continue;
            };
            let Some(exit) = state
                .embedded()
                .and_then(|embedded| embedded.control_terminal_exit(prefix))
            else {
                continue;
            };
            let code = process_exit_code(&exit);
            *mode.exit_code.lock().unwrap() = Some(code);
            tracing::info!(exit = %exit, code, hold = mode.launch.hold, "the terminal's program exited");
            if !mode.launch.hold {
                let _ = crate::begin_normal_shutdown(app, crate::ShutdownAction::Exit(code));
            }
            return;
        }
    });
}

/// New Window from a default-terminal window: another process with the same
/// `--dir` and `--app-id`, which is the contract (one window per process) and
/// what groups the windows under one class.
pub(crate) fn spawn_sibling(mode: &TerminalMode) {
    let exe = sibling_executable();
    let args = sibling_args(&mode.cwd, mode.launch.app_id.as_deref());
    match sibling_command(&exe, &args).spawn() {
        Ok(mut child) => {
            // Reap what was spawned so it never lingers as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => {
            tracing::warn!(exe = %exe.display(), error = %e, "starting a sibling terminal window failed")
        }
    }
}

/// On unix the sibling starts through `sh -c '"$0" "$@" &'`, so it is
/// reparented away from this process: Omarchy's Super+Return reads the cwd of
/// the focused window's newest child and expects a shell there, not another
/// chan-desktop. The argv rides as positional parameters, never as text a
/// shell re-parses.
fn sibling_command(exe: &Path, args: &[OsString]) -> std::process::Command {
    #[cfg(unix)]
    {
        let mut command = std::process::Command::new("/bin/sh");
        command.arg("-c").arg("\"$0\" \"$@\" &").arg(exe).args(args);
        command
    }
    #[cfg(not(unix))]
    {
        let mut command = std::process::Command::new(exe);
        command.args(args);
        command
    }
}

fn sibling_executable() -> PathBuf {
    #[cfg(unix)]
    if let Some(appimage) = crate::cs_install::appimage_path() {
        return appimage;
    }
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("chan-desktop"))
}

/// Make `app_id` the GLib program name before GTK initialises. tauri passes
/// no GTK application id, so GTK 3 derives the Wayland app_id and the X11
/// class from the program name, which GLib otherwise takes from `argv[0]` (the
/// `chan-desktop` that `StartupWMClass` names). libglib-2.0 is already linked
/// through gtk-rs's sys crates, so a raw declaration costs no new crate, the
/// route `linux_gui_stack` takes for `access`.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn set_gtk_program_name(app_id: &str) {
    use std::ffi::CString;
    use std::os::raw::c_char;
    unsafe extern "C" {
        fn g_set_prgname(prgname: *const c_char);
    }
    let Ok(name) = CString::new(app_id) else {
        tracing::warn!(
            app_id,
            "an app id with an interior NUL cannot be the program name"
        );
        return;
    };
    // SAFETY: GLib copies the string. Called once, on the main thread, before
    // gtk_init runs inside tauri::Builder::build, which is what makes GTK keep
    // it as the program name.
    unsafe { g_set_prgname(name.as_ptr()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    fn parse(items: &[&str]) -> Result<Option<TerminalLaunch>, String> {
        parse_terminal_launch(args(items))
    }

    fn launch(items: &[&str]) -> TerminalLaunch {
        parse(items).expect("parses").expect("is a terminal launch")
    }

    #[test]
    fn plain_launch_is_not_terminal_mode() {
        assert_eq!(parse(&[]), Ok(None));
    }

    #[test]
    fn positional_arguments_stay_with_the_gui() {
        for positional in [&["%U"][..], &["chan://x"], &["/home/u/notes"]] {
            assert_eq!(parse(positional), Ok(None), "{positional:?}");
        }
    }

    #[test]
    fn unknown_options_before_a_terminal_flag_stay_with_the_gui() {
        assert_eq!(parse(&["--foo"]), Ok(None));
        assert_eq!(parse(&["-x", "--dir=/t"]), Ok(None));
        assert_eq!(parse(&["--help"]), Ok(None));
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
    fn dash_e_alone_is_an_error() {
        let err = parse(&["-e"]).unwrap_err();
        assert!(err.contains("command"), "{err}");
        let err = parse(&["--dir=/x", "-e"]).unwrap_err();
        assert!(err.contains("command"), "{err}");
    }

    #[test]
    fn double_dash_alone_is_an_error() {
        let err = parse(&["--"]).unwrap_err();
        assert!(err.contains("command"), "{err}");
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
        let launch = launch(&["--title", "-e", "-e", "x"]);
        assert_eq!(launch.title.as_deref(), Some("-e"));
        assert_eq!(launch.command, Some(args(&["x"])));
    }

    #[test]
    fn valued_options_require_a_value() {
        for bad in [&["--dir"][..], &["--dir="], &["--title="], &["--app-id="]] {
            let err = parse(bad).unwrap_err();
            assert!(err.contains("needs a value"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn hold_takes_no_value() {
        let launch = launch(&["--hold"]);
        assert!(launch.hold);
        assert_eq!(launch.command, None);
        assert!(parse(&["--hold=1"]).is_err());
    }

    #[test]
    fn unknown_options_after_a_terminal_flag_are_errors() {
        let err = parse(&["--hold", "--foo"]).unwrap_err();
        assert!(err.contains("--foo"), "{err}");
    }

    #[test]
    fn positional_arguments_after_a_terminal_flag_are_errors() {
        let err = parse(&["--dir=/x", "vim"]).unwrap_err();
        assert!(err.contains("-e"), "{err}");
    }

    #[test]
    fn options_alone_run_the_shell() {
        let launch = launch(&["--dir=/x"]);
        assert_eq!(launch.command, None);
        assert_eq!(launch.dir, Some(PathBuf::from("/x")));
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
        let err = parse_terminal_launch([raw]).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
        let raw = OsString::from_vec(b"\xff".to_vec());
        let err = parse_terminal_launch([OsString::from("--app-id"), raw]).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn command_argv_and_dir_keep_non_utf8_bytes() {
        use std::os::unix::ffi::OsStringExt;
        let raw = OsString::from_vec(b"\xff\xfe".to_vec());
        let launch = parse_terminal_launch([OsString::from("-e"), raw.clone()])
            .unwrap()
            .unwrap();
        assert_eq!(launch.command, Some(vec![raw.clone()]));
        let dir = OsString::from_vec(b"--dir=/\xff".to_vec());
        let launch = parse_terminal_launch([dir]).unwrap().unwrap();
        assert_eq!(
            launch.dir,
            Some(PathBuf::from(OsString::from_vec(b"/\xff".to_vec())))
        );
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

    #[test]
    fn exit_code_mirrors_the_command_status() {
        use chan_server::TerminalExit;
        assert_eq!(process_exit_code(&TerminalExit::Code { code: 0 }), 0);
        assert_eq!(process_exit_code(&TerminalExit::Code { code: 3 }), 3);
    }

    #[test]
    fn a_signal_death_and_an_unknown_status_exit_nonzero() {
        use chan_server::TerminalExit;
        assert_eq!(
            process_exit_code(&TerminalExit::Signal {
                signal: "SIGKILL".into()
            }),
            1
        );
        assert_eq!(process_exit_code(&TerminalExit::Unknown), 1);
    }

    #[test]
    fn the_default_title_is_the_program_name_or_terminal() {
        assert_eq!(default_title(&launch(&["--dir=/x"])), "Terminal");
        assert_eq!(
            default_title(&launch(&["-e", "/usr/bin/btop", "-p"])),
            "btop"
        );
        assert_eq!(default_title(&launch(&["-e", "btop"])), "btop");
        assert_eq!(
            default_title(&launch(&["--title=Omarchy", "-e", "bash", "-c", "x"])),
            "Omarchy"
        );
    }

    #[test]
    fn a_sibling_launch_always_carries_a_terminal_flag_and_no_command() {
        assert_eq!(
            sibling_args(Path::new("/w"), Some("org.x")),
            args(&["--dir=/w", "--app-id=org.x"])
        );
        assert_eq!(sibling_args(Path::new("/w"), None), args(&["--dir=/w"]));
        let launch = parse_terminal_launch(sibling_args(Path::new("/w"), Some("org.x")))
            .unwrap()
            .expect("a sibling is a terminal launch");
        assert_eq!(launch.command, None);
        assert!(!launch.hold);
        assert_eq!(launch.title, None);
    }

    #[test]
    fn preflight_searches_path_for_a_bare_name_and_uses_a_path_as_given() {
        let path = std::env::join_paths([Path::new("/a"), Path::new("/b")]).unwrap();
        // Joined as the preflight joins, so the separator matches on Windows.
        let executables = [
            PathBuf::from("/b").join("btop"),
            PathBuf::from("/w").join("bin/run.sh"),
            PathBuf::from("/opt/tool"),
        ];
        let is_exec = |p: &Path| executables.iter().any(|e| e == p);
        assert_eq!(
            preflight_command(OsStr::new("btop"), Some(&path), Path::new("/w"), is_exec),
            Ok(())
        );
        assert_eq!(
            preflight_command(
                OsStr::new("bin/run.sh"),
                Some(&path),
                Path::new("/w"),
                is_exec
            ),
            Ok(())
        );
        assert_eq!(
            preflight_command(
                OsStr::new("/opt/tool"),
                Some(&path),
                Path::new("/w"),
                is_exec
            ),
            Ok(())
        );
    }

    #[test]
    fn preflight_refuses_a_missing_program() {
        let path = std::env::join_paths([Path::new("/a")]).unwrap();
        let err = preflight_command(OsStr::new("nope"), Some(&path), Path::new("/w"), |_| false)
            .unwrap_err();
        assert!(err.contains("nope") && err.contains("not found"), "{err}");
        let err = preflight_command(
            OsStr::new("./nope.sh"),
            Some(&path),
            Path::new("/w"),
            |_| false,
        )
        .unwrap_err();
        assert!(err.contains("nope.sh"), "{err}");
        let err =
            preflight_command(OsStr::new("nope"), None, Path::new("/w"), |_| true).unwrap_err();
        assert!(err.contains("not found"), "no PATH finds nothing: {err}");
    }

    #[test]
    fn terminal_mode_dispatches_after_the_gui_stack_preference_and_before_the_shims() {
        const MAIN_RS: &str = include_str!("main.rs");
        let production = MAIN_RS
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("main.rs has a test module");
        let main_start = production.find("\nfn main() {").expect("fn main");
        let main_body = &production[main_start..];
        let gui_stack = main_body
            .find("linux_gui_stack::prefer_system_gui_stack();")
            .expect("the GUI stack preference");
        let dispatch = main_body
            .find("terminal_mode::run_if_requested()")
            .expect("the terminal-mode dispatch");
        let shims = main_body
            .find("cs_install::install_bin_shims()")
            .expect("the shim install");
        assert!(
            gui_stack < dispatch && dispatch < shims,
            "terminal mode runs after the AppImage re-exec can carry its flags and before the GUI's shim install"
        );
    }

    #[test]
    fn the_terminal_mode_builder_shares_the_app_command_table() {
        const SELF: &str = include_str!("terminal_mode.rs");
        let production = SELF
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("this file has a test module");
        assert!(production.contains("crate::app_invoke_handler()"));
        assert!(
            !production.contains("generate_handler!"),
            "one command table, in main.rs"
        );
    }
}
