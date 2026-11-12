//! A `chan-term` launch: the program name a desktop's default terminal runs,
//! with the grammar xdg-terminal-exec drives through `chan-term.desktop`'s
//! `X-TerminalArg*` keys (`chan::term`). One terminal-only window in its own
//! process, with none of the launcher's boot (shims, library stores, the
//! handoff listener, the window watcher, gateways, the update check), so a
//! launch beside a running chan-desktop leaves it alone.
//!
//! The exception is a launch that only runs the user's shell: a bare
//! `chan-term` or one with `--dir` alone. With a chan-desktop already running
//! it is handed over the handoff socket, and that desktop opens a throwaway
//! local terminal window in the directory (never saved, so a relaunch does not
//! restore it). With none running, it opens its own window.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chan::term::TerminalLaunch;
use tauri::RunEvent;

use crate::config::ConfigStore;
use crate::embedded::EmbeddedServer;
use crate::{serve, AppState};

/// The Tauri label of the one window a `chan-term` launch opens. Its own
/// family: not a watcher label (`local::`, `lib-`), so no bury and no close
/// prompt, and not a devserver control terminal, so no reaping.
pub(crate) const WINDOW_LABEL: &str = "terminal-exec";

/// The program name GTK gives a window without `--app-id`: the class
/// `chan-desktop.desktop`'s `StartupWMClass` names, so the window groups
/// with the desktop's own instead of taking `chan-term` from `argv[0]`.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
const DESKTOP_PROGRAM_NAME: &str = "chan-desktop";

/// The launch when this process runs as `chan-term` (`argv[0]`, or `$ARGV0`
/// under an AppImage), read before any GUI setup: `--help`, `--version` and
/// a usage error print and exit here ([`chan::term::parse_or_exit`]). `None`
/// for every other name.
pub fn launch_if_invoked() -> Option<TerminalLaunch> {
    if !chan::term::invoked_as_term(&chan_shell::invoked_arg0()) {
        return None;
    }
    Some(chan::term::parse_or_exit(std::env::args_os().skip(1)))
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
/// the shell rather than the command, no title and no hold.
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

/// The live state of a `chan-term` launch, managed on the Tauri app so
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

/// Open the launch's window, or hand a shell-only launch to the running
/// chan-desktop ([`chan::term::hands_off`]). Ends the process on a failure
/// before the event loop runs; otherwise returns when the event loop ends.
pub fn run(launch: TerminalLaunch) {
    let cwd = chan::term::start_dir(&launch);
    if chan::term::hands_off(&launch) && hand_off(&cwd) {
        return;
    }
    if let Err(e) = run_window(launch, cwd) {
        fatal(1, &e);
    }
}

/// Ask a running chan-desktop to open the window. A `cwd` that is not UTF-8
/// cannot ride the JSON request, so that launch keeps its own window.
fn hand_off(cwd: &Path) -> bool {
    let Some(cwd_text) = cwd.to_str() else {
        return false;
    };
    let opened = tauri::async_runtime::block_on(chan_server::handoff::try_open_terminal(cwd_text));
    if opened {
        tracing::info!(cwd = %cwd.display(), "the running chan-desktop opened the terminal window");
    }
    opened
}

fn fatal(code: i32, message: &str) -> ! {
    eprintln!("{}: {message}", chan::term::NAME);
    std::process::exit(code)
}

fn run_window(launch: TerminalLaunch, cwd: PathBuf) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    set_gtk_program_name(launch.app_id.as_deref().unwrap_or(DESKTOP_PROGRAM_NAME));
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
            let embedded = tauri::async_runtime::block_on(EmbeddedServer::start_terminal_only(
                crate::terminal_opacity::config_hook(app.handle().clone()),
            ))
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
    Ok(())
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

/// New Window from a `chan-term` window: another `chan-term` process with the
/// same `--dir` and `--app-id`, which is the contract (one window per process)
/// and what groups the windows under one class.
pub(crate) fn spawn_sibling(mode: &TerminalMode) {
    let (exe, appimage) = sibling_executable();
    let args = sibling_args(&mode.cwd, mode.launch.app_id.as_deref());
    match sibling_command(&exe, &args, appimage).spawn() {
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
/// shell re-parses. The sibling must run as `chan-term`: the dispatch reads
/// `$ARGV0` first, which the sibling drops once it has dispatched, and an
/// AppImage's runtime sets `$ARGV0` from the `argv[0]` it is run with, which
/// bash's `exec -a` chooses (the shim wrappers' route).
fn sibling_command(exe: &Path, args: &[OsString], appimage: bool) -> std::process::Command {
    #[cfg(unix)]
    {
        let mut command = if appimage {
            let mut bash = std::process::Command::new("bash");
            bash.arg("-c")
                .arg(format!("exec -a {} \"$0\" \"$@\" &", chan::term::NAME));
            bash
        } else {
            let mut sh = std::process::Command::new("/bin/sh");
            sh.arg("-c").arg("\"$0\" \"$@\" &");
            sh
        };
        command.arg(exe).args(args).env("ARGV0", chan::term::NAME);
        command
    }
    #[cfg(not(unix))]
    {
        let _ = appimage;
        let mut command = std::process::Command::new(exe);
        command.args(args).env("ARGV0", chan::term::NAME);
        command
    }
}

/// The executable a sibling starts, and whether it is an AppImage: its inner
/// binary lives on a mount that ends with this process.
fn sibling_executable() -> (PathBuf, bool) {
    #[cfg(unix)]
    if let Some(appimage) = crate::cs_install::appimage_path() {
        return (appimage, true);
    }
    (
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("chan-desktop")),
        false,
    )
}

/// Make `app_id` the GLib program name before GTK initialises. tauri passes
/// no GTK application id, so GTK 3 derives the Wayland app_id and the X11
/// class from the program name, which GLib otherwise takes from `argv[0]`
/// (`chan-term`, a name no desktop entry's `StartupWMClass` names).
/// libglib-2.0 is already linked through gtk-rs's sys crates, so a raw
/// declaration costs no new crate, the route `linux_gui_stack` takes for
/// `access`.
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
    use chan::term::Invocation;

    fn args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    fn launch(items: &[&str]) -> TerminalLaunch {
        match chan::term::parse(args(items)) {
            Ok(Invocation::Launch(launch)) => launch,
            other => panic!("{items:?} is not a launch: {other:?}"),
        }
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
    fn a_sibling_launch_keeps_the_directory_and_app_id_and_runs_the_shell() {
        assert_eq!(
            sibling_args(Path::new("/w"), Some("org.x")),
            args(&["--dir=/w", "--app-id=org.x"])
        );
        assert_eq!(sibling_args(Path::new("/w"), None), args(&["--dir=/w"]));
        let sibling = launch(
            &sibling_args(Path::new("/w"), Some("org.x"))
                .iter()
                .map(|arg| arg.to_str().unwrap())
                .collect::<Vec<_>>(),
        );
        assert_eq!(sibling.dir, Some(PathBuf::from("/w")));
        assert_eq!(sibling.app_id.as_deref(), Some("org.x"));
        assert_eq!(sibling.command, None);
        assert!(!sibling.hold);
        assert_eq!(sibling.title, None);
    }

    /// The sibling runs as `chan-term`, reparented: `$ARGV0` names it for the
    /// dispatch, and an AppImage, whose runtime sets `$ARGV0` from its own
    /// `argv[0]`, is run under that name by bash's `exec -a`. The argv rides
    /// as positional parameters.
    #[cfg(unix)]
    #[test]
    fn a_sibling_starts_reparented_as_chan_term() {
        let argv = args(&["--dir=/w x", "--app-id=org.x"]);
        let program = |command: &std::process::Command| {
            let mut all = vec![command.get_program().to_os_string()];
            all.extend(command.get_args().map(OsStr::to_os_string));
            all
        };
        let argv0 = |command: &std::process::Command| {
            command
                .get_envs()
                .find(|(key, _)| *key == "ARGV0")
                .and_then(|(_, value)| value.map(OsStr::to_os_string))
        };
        let plain = sibling_command(Path::new("/usr/bin/chan-desktop"), &argv, false);
        assert_eq!(
            program(&plain),
            args(&[
                "/bin/sh",
                "-c",
                "\"$0\" \"$@\" &",
                "/usr/bin/chan-desktop",
                "--dir=/w x",
                "--app-id=org.x"
            ])
        );
        assert_eq!(argv0(&plain), Some(OsString::from("chan-term")));
        let appimage = sibling_command(Path::new("/opt/Chan.AppImage"), &argv, true);
        assert_eq!(
            program(&appimage),
            args(&[
                "bash",
                "-c",
                "exec -a chan-term \"$0\" \"$@\" &",
                "/opt/Chan.AppImage",
                "--dir=/w x",
                "--app-id=org.x"
            ])
        );
        assert_eq!(argv0(&appimage), Some(OsString::from("chan-term")));
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

    /// `chan-term` is read before the version probe, so `chan-term
    /// --version` is its own, and its window opens after the GUI-stack
    /// preference, whose AppImage re-exec carries `$ARGV0` and the argv, and
    /// before the GUI's shim install. `$ARGV0` is dropped between the two, so
    /// neither the window's shells nor anything else it starts inherit it.
    #[test]
    fn chan_term_dispatches_around_the_gui_stack_preference_and_before_the_shims() {
        const MAIN_RS: &str = include_str!("main.rs");
        let production = MAIN_RS
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("main.rs has a test module");
        let main_start = production.find("\nfn main() {").expect("fn main");
        let main_body = &production[main_start..];
        let order = [
            "let terminal_launch = terminal_mode::launch_if_invoked();",
            "print_version_if_requested()",
            "linux_gui_stack::prefer_system_gui_stack();",
            "std::env::remove_var(\"ARGV0\");",
            "terminal_mode::run(launch);",
            "cs_install::install_bin_shims()",
        ];
        let at: Vec<usize> = order
            .iter()
            .map(|needle| {
                main_body
                    .find(needle)
                    .unwrap_or_else(|| panic!("main runs {needle}"))
            })
            .collect();
        assert!(
            at.windows(2).all(|pair| pair[0] < pair[1]),
            "main runs {order:?} in that order"
        );
    }

    /// Without `--app-id` the window keeps the program name that
    /// `chan-desktop.desktop` names as its `StartupWMClass`, which `argv[0]`
    /// (`chan-term`) would otherwise replace. A source pin: GTK applies the
    /// name, which the desktop guest reading observes.
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    #[test]
    fn a_window_without_an_app_id_keeps_the_desktop_entrys_class() {
        const ENTRY: &str = include_str!("../../../packaging/distros/shared/chan-desktop.desktop");
        let class = format!("StartupWMClass={DESKTOP_PROGRAM_NAME}");
        assert!(ENTRY.lines().any(|line| line == class), "{ENTRY}");
        const SELF: &str = include_str!("terminal_mode.rs");
        let production = SELF
            .split("\n#[cfg(test)]\nmod tests {")
            .next()
            .expect("this file has a test module");
        assert!(production.contains(
            "set_gtk_program_name(launch.app_id.as_deref().unwrap_or(DESKTOP_PROGRAM_NAME));"
        ));
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
