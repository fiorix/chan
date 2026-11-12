use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

use crate::{update, Personality};

/// What `chan upgrade` does for the running binary.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum UpgradeRoute {
    /// A distro-packaged build: refuse with this message instead of
    /// installing anything.
    Refuse(String),
    /// Replace the standalone CLI tarball in place.
    Cli,
    /// Drive the running desktop's `tauri-plugin-updater`.
    Desktop,
}

/// Resolve what `chan upgrade` does, from the binary's personality and the
/// build-time distro-package marker. PURE: the refusal and both install
/// paths run in the caller.
///
/// The packaged refusal is decided before the personality, so every install
/// path inherits it and a personality added later cannot skip it: on a build
/// whose files the system package manager owns, neither the tarball replace
/// nor the desktop updater may run. `--check` is refused with the same
/// message rather than reporting an available update, because the update it
/// would name is not one this build can install; the refusal names the
/// package manager, which is the command that does work.
///
/// `packaged` is [`update::packaged_via`] threaded in as an argument because
/// it is a compile-time `option_env!`: passing it is what keeps both the
/// packaged and the unpackaged decision testable from one build.
///
/// `desktop_companion` is the Windows case where the binary is the console
/// `chan.exe` the NSIS install ships beside `chan-desktop.exe`: it runs as
/// `Personality::Standalone` (it is the same binary as the standalone
/// Windows CLI zip), but the desktop's shim marks it with
/// `CHAN_DESKTOP_HANDOFF=1`, and a `chan upgrade` from it upgrades the
/// desktop it belongs to, never a CLI tarball that Windows does not publish.
/// The caller computes it as `cfg!(windows) && handoff_forced()`: on unix
/// that env only forces the `chan serve` handoff, and a standalone
/// install.sh `chan` keeps replacing its own tarball.
pub(super) fn decide_upgrade_route(
    personality: Personality,
    packaged: Option<&str>,
    desktop_companion: bool,
) -> UpgradeRoute {
    if let Some(message) = update::packaged_upgrade_refusal(packaged) {
        return UpgradeRoute::Refuse(message);
    }
    if desktop_companion {
        return UpgradeRoute::Desktop;
    }
    match personality {
        Personality::Standalone => UpgradeRoute::Cli,
        Personality::Desktop => UpgradeRoute::Desktop,
    }
}

/// The `desktop_companion` input of [`decide_upgrade_route`]: true only for a
/// Windows process carrying the desktop shim's `CHAN_DESKTOP_HANDOFF=1`. The
/// Windows half is a parameter rather than a `cfg!` inside so the guard is
/// pinned on every host: on unix the hint steers `chan serve` only, and a
/// standalone install.sh `chan` keeps replacing its own tarball.
pub(super) fn desktop_companion(is_windows: bool, handoff_forced: bool) -> bool {
    is_windows && handoff_forced
}

/// Whether the desktop arm of `chan serve` would send its handoff request or
/// launch the GUI, decided from the inputs [`maybe_handoff_to_desktop`] acts
/// on without sending anything. When no desktop is known to be live and none
/// would be launched, a connect-only probe says whether one is listening.
pub(super) async fn desktop_handoff_would_engage(
    launch_if_absent: bool,
    desktop_known_live: bool,
) -> bool {
    if chan_server::handoff::handoff_opt_out() {
        return false;
    }
    if desktop_known_live {
        return true;
    }
    // `maybe_launch_desktop` launches on unix alone; elsewhere an absent
    // desktop leaves the standalone fallback.
    chan_server::handoff::gui_session_present()
        && ((launch_if_absent && cfg!(unix)) || chan_server::handoff::desktop_is_live().await)
}

/// Integrate a Desktop-personality `chan serve` with the desktop app.
///
/// Returns:
/// - `Some(Ok(()))` when the desktop opened the workspace window (either a
///   running desktop took the handoff, or we launched the GUI and it did):
///   the CLI exits WITHOUT opening the workspace (the desktop owns the flock).
/// - `Some(Err(..))` when desktop integration was attempted but failed hard
///   (GUI launch failed / timed out). The caller propagates the error; a
///   Desktop invocation does NOT silently fall back to the browser.
/// - `None` only when desktop integration does not apply (opted out via
///   `CHAN_NO_DESKTOP_HANDOFF`, no GUI session such as SSH, a running desktop
///   of a skewed version, or a non-unix build): the caller falls back to the
///   standalone server path. These are the cases where a browser/URL is the
///   only sensible outcome.
///
/// The caller already chose the desktop target. Here we add the explicit
/// opt-out and require a GUI session only when no running desktop was already
/// proven, then hand off or let the desktop personality launch the app.
pub(super) async fn maybe_handoff_to_desktop(
    root: &Path,
    launch_if_absent: bool,
    desktop_known_live: bool,
) -> Option<Result<()>> {
    // Explicit opt-out for automation, and the headless auto-skip: over SSH
    // (no GUI session) there's no window to show, so a printed URL is the
    // only useful outcome. Both keep the load-bearing standalone path.
    if chan_server::handoff::handoff_opt_out() {
        return None;
    }
    if !desktop_known_live && !chan_server::handoff::gui_session_present() {
        return None;
    }

    match chan_server::handoff::try_handoff(root).await {
        chan_server::handoff::Outcome::HandedOff => {
            // The desktop owns the workspace from here; the CLI is just a
            // launcher. Print a short note to stdout (where the URL
            // would otherwise go) and exit 0.
            println!("chan: opened {} in chan-desktop.", root.display());
            Some(Ok(()))
        }
        chan_server::handoff::Outcome::VersionSkew {
            desktop_version,
            desktop_protocol: _,
        } => {
            // A running desktop of a DIFFERENT version (e.g. the binary was
            // upgraded but the old desktop is still running). Launching our
            // version would fight the old one for the singleton socket, so
            // name the skew and fall back to a standalone server rather than
            // risk two desktops.
            eprintln!(
                "chan: chan-desktop is version {desktop_version}, CLI is {}; \
                 cannot hand off. Restart chan-desktop to pick up the new \
                 version. Starting a standalone server for now.",
                chan_server::handoff::CHAN_VERSION,
            );
            None
        }
        chan_server::handoff::Outcome::DesktopError { message } => {
            eprintln!(
                "chan: chan-desktop could not open the workspace ({message}); \
                 starting a standalone server."
            );
            None
        }
        chan_server::handoff::Outcome::CloseRefused { .. }
        | chan_server::handoff::Outcome::NotServed => {
            eprintln!(
                "chan: chan-desktop returned a close answer while opening the workspace; \
                 starting a standalone server."
            );
            None
        }
        // No running desktop. A forced-desktop invocation (a
        // `Personality::Desktop` binary, or `CHAN_DESKTOP_HANDOFF=1`) launches
        // the GUI and opens the workspace in it -- and never falls back to the
        // browser. A standalone binary that reached the desktop target only via
        // a live-desktop parentage instead falls through to a standalone serve:
        // its `current_exe` is NOT the desktop, so it must not try to spawn one.
        // A desktop that holds the endpoint and has not started its listener
        // yet (which only Windows tells apart) is booting: launching another
        // would only meet it, so the CLI says why it serves on its own.
        chan_server::handoff::Outcome::NoDesktop => {
            if chan_server::handoff::desktop_is_starting() {
                eprintln!(
                    "chan: chan-desktop is starting and cannot open the workspace yet; \
                     starting a standalone server."
                );
                return None;
            }
            if launch_if_absent {
                maybe_launch_desktop(root).await
            } else {
                None
            }
        }
    }
}

/// Launch the desktop GUI for a `chan serve` that found no running desktop,
/// then hand it the workspace. Unix-only: the Windows companion `chan.exe`
/// can launch `chan-desktop.exe` for `chan upgrade` (`spawn_desktop_gui`),
/// but the serve handoff to a desktop it launched is not wired there, so
/// off unix `chan serve` falls back to a standalone server.
#[cfg(unix)]
async fn maybe_launch_desktop(root: &Path) -> Option<Result<()>> {
    Some(launch_desktop_and_handoff(root).await)
}

#[cfg(not(unix))]
async fn maybe_launch_desktop(_root: &Path) -> Option<Result<()>> {
    None
}

/// Spawn the chan-desktop GUI and hand `root` to it once it's up.
///
/// Only reached from the Desktop personality, so this process is the
/// chan-desktop binary ([`spawn_desktop_gui_opening`] finds what to start
/// from it). Spawns the GUI detached, then polls the well-known
/// handoff socket -- the GUI binds it during setup -- re-attempting
/// `try_handoff` until it opens the workspace or a generous deadline passes
/// (a cold GUI boot starts the embedded server and a window, which takes a
/// few seconds).
#[cfg(unix)]
async fn launch_desktop_and_handoff(root: &Path) -> Result<()> {
    spawn_desktop_gui().context("launching chan-desktop")?;

    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::time::sleep(Duration::from_millis(400)).await;
        match chan_server::handoff::try_handoff(root).await {
            chan_server::handoff::Outcome::HandedOff => {
                println!("chan: launched chan-desktop and opened {}.", root.display());
                return Ok(());
            }
            // Not up yet (socket absent / connect refused): keep waiting.
            chan_server::handoff::Outcome::NoDesktop => {}
            // The desktop we just launched is up but won't take the handoff.
            // Surface and stop retrying rather than spin to the deadline.
            chan_server::handoff::Outcome::VersionSkew {
                desktop_version, ..
            } => {
                anyhow::bail!(
                    "launched chan-desktop is version {desktop_version}, CLI is {}; \
                     cannot hand off",
                    chan_server::handoff::CHAN_VERSION,
                );
            }
            chan_server::handoff::Outcome::DesktopError { message } => {
                anyhow::bail!("chan-desktop could not open the workspace: {message}");
            }
            chan_server::handoff::Outcome::CloseRefused { .. }
            | chan_server::handoff::Outcome::NotServed => {
                anyhow::bail!("chan-desktop returned a close answer while opening the workspace");
            }
        }
        if std::time::Instant::now() >= deadline {
            anyhow::bail!(
                "timed out waiting for chan-desktop to start; run `chan serve` again \
                 once it is up, or set CHAN_NO_DESKTOP_HANDOFF=1 for a standalone server"
            );
        }
    }
}

/// Launch the chan-desktop GUI as a detached process.
#[cfg(unix)]
fn spawn_desktop_gui() -> std::io::Result<()> {
    spawn_desktop_gui_opening(&[], None).map(|_| ())
}

/// Launch the chan-desktop GUI as a detached process given `paths`, which its
/// boot opens in a standalone window as `chan-desktop PATH...` does, or the
/// start directory of a `chan-term` shell, which its boot opens a terminal
/// window in ([`chan_server::handoff::OPEN_TERMINAL_ENV`]). The
/// process started is returned when it is the desktop's own, so a caller can
/// read its exit: a launch that finds another desktop hands it the paths and
/// exits from its single-instance guard. On macOS the process is `open`,
/// which exits once LaunchServices has the app, so there is none to read;
/// with paths it asks for a new instance (`-n`), which runs that guard.
///
/// Only the Desktop personality runs this, so this process is the
/// chan-desktop binary, though `current_exe()` may name it by the command
/// shim it was started through; [`desktop_start`] decides from that path and
/// its resolved one which bundle or binary starts, and refuses a binary that
/// would run a command again instead of the GUI.
#[cfg(unix)]
pub(super) fn spawn_desktop_gui_opening(
    paths: &[String],
    terminal: Option<&str>,
) -> std::io::Result<Option<std::process::Child>> {
    let exe = std::env::current_exe()?;
    let resolved = exe.canonicalize().ok();
    // This process's own AppImage only: a deb's chan started under another
    // application's AppImage environment must not start that AppImage.
    let appimage = chan_server::own_appimage();
    let start = desktop_start(
        &exe,
        resolved.as_deref(),
        appimage.as_deref(),
        cfg!(target_os = "macos"),
    )?;
    match start {
        DesktopStart::Bundle(bundle) => macos_open_command(&bundle, paths, terminal)
            .spawn()
            .map(|_| None),
        DesktopStart::Binary(target) => {
            desktop_gui_command(&target, paths, terminal, std::env::vars_os())
                .spawn()
                .map(Some)
        }
    }
}

/// How [`spawn_desktop_gui_opening`] starts chan-desktop.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum DesktopStart {
    /// `/usr/bin/open` on this `.app` bundle (macOS): launching the bare
    /// Mach-O inside it can start the process without LaunchServices
    /// activating it, where `open` hands the launch to LaunchServices, with
    /// its activation and its single instance.
    Bundle(PathBuf),
    /// This binary, run directly with its own path as `argv[0]`.
    Binary(PathBuf),
}

/// What a command of the desktop personality starts, from the path this
/// process was started through (`exe`, what `current_exe()` returns), that
/// path with its links resolved (`resolved`, `None` when it cannot be), the
/// `$APPIMAGE` it runs from, and whether this is macOS.
///
/// The command shims are symlinks to the desktop binary, and on macOS
/// `current_exe()` reads `_NSGetExecutablePath`, which returns the path a
/// program was started through: a shim's, outside any bundle. So the `.app`
/// is climbed from the resolved path, then from `exe` for a bundle whose
/// binary is itself a link. On Linux `current_exe()` reads `/proc/self/exe`,
/// which is resolved already. An AppImage starts its `$APPIMAGE`, because the
/// running binary lives on a mount that ends with this process.
///
/// A binary started directly runs under its own name, which the desktop's
/// dispatch reads first, so one named as a command of the binary (a copy or a
/// hard link called `chan-term`) would run that command again instead of the
/// GUI, and a command that finds no desktop starts the next: it is refused
/// with the reason, never started.
#[cfg(unix)]
fn desktop_start(
    exe: &Path,
    resolved: Option<&Path>,
    appimage: Option<&Path>,
    macos: bool,
) -> std::io::Result<DesktopStart> {
    let real = resolved.unwrap_or(exe);
    if macos {
        if let Some(bundle) = macos_app_bundle(real).or_else(|| macos_app_bundle(exe)) {
            return Ok(DesktopStart::Bundle(bundle));
        }
    }
    let target = appimage.unwrap_or(real);
    if let Some(command) = command_name(target) {
        return Err(std::io::Error::other(format!(
            "{} is named {command}, which runs chan's {command} command rather than the \
             desktop; start chan-desktop first",
            target.display()
        )));
    }
    Ok(DesktopStart::Binary(target.to_path_buf()))
}

/// The command a program at `path` runs as when started under its own name,
/// by the name rules of the desktop's dispatch (`cs`, `chan`, `chan-files`,
/// `chan-edit`, `chan-term`); `None` for any other name, which boots the GUI.
#[cfg(unix)]
fn command_name(path: &Path) -> Option<String> {
    let name = path.as_os_str();
    let command = chan_shell::invoked_as_cs(name)
        || chan_shell::invoked_as_chan(name)
        || crate::invoked_as_opener(name)
        || crate::term::invoked_as_term(name);
    command.then(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    })
}

/// The `/usr/bin/open` command that starts the `.app` at `bundle` to open
/// `paths`, or the `terminal` a `chan-term` asked for.
///
/// The terminal goes through `--env`, which reaches the new instance however
/// much of `open`'s own environment LaunchServices passes on, and `open`
/// itself carries neither `$ARGV0` nor a terminal this process inherited.
/// The started desktop's dispatch reads `$ARGV0` ahead of `argv[0]`, and an
/// inherited `chan-term` (a New Window sibling's) would run it as a terminal
/// launch, which finds no desktop and opens the app again; an inherited
/// carrier would open a terminal nobody asked for.
#[cfg(unix)]
fn macos_open_command(
    bundle: &Path,
    paths: &[String],
    terminal: Option<&str>,
) -> std::process::Command {
    use chan_server::handoff::OPEN_TERMINAL_ENV;
    use std::process::{Command, Stdio};

    let mut open = Command::new("/usr/bin/open");
    // `-n` with paths or a terminal: `open --args` aimed at an app that is
    // already launching drops the arguments, where a new instance runs the
    // single-instance guard and hands them to the one on its way up.
    if !paths.is_empty() || terminal.is_some() {
        open.arg("-n");
    }
    if let Some(dir) = terminal {
        open.arg("--env").arg(format!("{OPEN_TERMINAL_ENV}={dir}"));
    }
    open.arg(bundle);
    if !paths.is_empty() {
        open.arg("--args").args(paths);
    }
    open.env_remove("ARGV0")
        .env_remove(OPEN_TERMINAL_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    open
}

/// The command that starts the chan-desktop GUI at `target` to open `paths`,
/// or the `terminal` a `chan-term` asked for, which goes in
/// [`OPEN_TERMINAL_ENV`](chan_server::handoff::OPEN_TERMINAL_ENV) and is
/// removed from the environment otherwise, so an inherited one never opens a
/// terminal nobody asked for. Under an AppImage the target is the AppImage
/// again, so the desktop is handed the environment the user had rather than
/// `parent`, this process's, whose search paths name this process's mount
/// ([`chan_server::hand_appimage_host_env`]).
#[cfg(unix)]
fn desktop_gui_command(
    target: &Path,
    paths: &[String],
    terminal: Option<&str>,
    parent: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> std::process::Command {
    use chan_server::handoff::OPEN_TERMINAL_ENV;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut command = Command::new(target);
    chan_server::hand_appimage_host_env(&mut command, parent);
    match terminal {
        Some(dir) => command.env(OPEN_TERMINAL_ENV, dir),
        None => command.env_remove(OPEN_TERMINAL_ENV),
    };
    command
        // argv[0] is the target's own path, which `desktop_start` refuses
        // when its name is a command's, so the process boots the GUI.
        // `$ARGV0` is the name an AppImage wrapper ran THIS process as, and
        // the desktop's dispatch reads it ahead of argv[0], so it is not
        // passed on either.
        .arg0(target)
        .env_remove("ARGV0")
        .args(paths)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // New process group so Ctrl-C in the launching terminal doesn't also
        // kill the desktop we just started.
        .process_group(0);
    command
}

/// Launch the chan-desktop GUI as a detached process.
///
/// On Windows the CLI is usually the console `chan.exe` the NSIS install
/// ships beside `chan-desktop.exe` (the desktop's shim runs it with
/// `CHAN_DESKTOP_HANDOFF=1`), so the desktop is resolved relative to
/// `current_exe()`; a `chan-desktop.exe` invoked as `chan` launches itself.
/// `ARGV0` and `CHAN_DESKTOP_HANDOFF` are dropped from the child's
/// environment: the shim exported them to steer THIS process into the CLI,
/// and the child must boot the GUI.
#[cfg(windows)]
fn spawn_desktop_gui() -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let exe = std::env::current_exe()?;
    let target = windows_desktop_exe_for(&exe).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("no chan-desktop.exe beside {}", exe.display()),
        )
    })?;
    // Same detachment as the devserver daemon spawn: no console of ours, and
    // Ctrl-C in the launching terminal must not reach the desktop.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    Command::new(&target)
        .env_remove("ARGV0")
        .env_remove("CHAN_DESKTOP_HANDOFF")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
}

/// The desktop binary for a Windows CLI process: `exe` itself when it is
/// `chan-desktop.exe`, else a `chan-desktop.exe` in the same directory or
/// one level up (the bundled `chan.exe` may live in `resources\`). `None`
/// for a loose `chan.exe` with no desktop beside it.
#[cfg(any(windows, test))]
fn windows_desktop_exe_for(exe: &Path) -> Option<PathBuf> {
    const DESKTOP_EXE: &str = "chan-desktop.exe";
    if exe
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(DESKTOP_EXE))
    {
        return Some(exe.to_path_buf());
    }
    let dir = exe.parent()?;
    let mut candidates = vec![dir.join(DESKTOP_EXE)];
    if let Some(parent) = dir.parent() {
        candidates.push(parent.join(DESKTOP_EXE));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Climb `…/<Name>.app/Contents/MacOS/<bin>` to the `.app` bundle dir, if
/// `exe` is laid out that way. Returns None for a loose dev binary.
#[cfg(unix)]
fn macos_app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos_dir = exe.parent()?; // …/Contents/MacOS
    let contents = macos_dir.parent()?; // …/Contents
    let bundle = contents.parent()?; // …/<Name>.app
    let is_bundle = bundle.extension().map(|e| e == "app").unwrap_or(false)
        && macos_dir.file_name().map(|n| n == "MacOS").unwrap_or(false)
        && contents
            .file_name()
            .map(|n| n == "Contents")
            .unwrap_or(false);
    is_bundle.then(|| bundle.to_path_buf())
}

/// `chan upgrade` for the Desktop personality: drive the running desktop's
/// `tauri-plugin-updater` instead of replacing a CLI tarball.
///
/// With `check_only` we query a running desktop and report -- we do NOT launch
/// one just to check (that would pop a window). Otherwise we find or launch
/// the desktop and trigger the install (fire-and-return: the desktop owns the
/// download/install/relaunch). `--version` pinning is unsupported (the desktop
/// updater always installs the latest published release).
#[cfg(any(unix, windows))]
pub(super) async fn cmd_upgrade_desktop(
    check_only: bool,
    version_override: Option<String>,
) -> Result<()> {
    use chan_server::handoff::UpgradeOutcome;

    if version_override.is_some() {
        eprintln!(
            "chan: --version is not supported for a desktop install; the desktop \
             updater always installs the latest published release. Ignoring it."
        );
    }

    match chan_server::handoff::try_upgrade(check_only).await {
        UpgradeOutcome::Checked { available, .. } => {
            match available {
                Some(v) => {
                    println!(
                        "chan: chan-desktop {v} is available. Run `chan upgrade` to install it."
                    )
                }
                None => println!("chan: chan-desktop is up to date."),
            }
            Ok(())
        }
        UpgradeOutcome::Started { .. } => {
            println!(
                "chan: chan-desktop is updating in the background; it will relaunch when done."
            );
            Ok(())
        }
        UpgradeOutcome::VersionSkew {
            desktop_version, ..
        } => anyhow::bail!(
            "chan-desktop is version {desktop_version}, CLI is {}; restart chan-desktop, \
             then run `chan upgrade` again",
            chan_server::handoff::CHAN_VERSION,
        ),
        UpgradeOutcome::DesktopError { message } => {
            anyhow::bail!("chan-desktop could not upgrade: {message}")
        }
        UpgradeOutcome::NoDesktop => {
            if check_only {
                // No running desktop to ask; launching one just to check would
                // pop a window. Point the user at the install path instead.
                anyhow::bail!(
                    "no running chan-desktop to check. Open chan-desktop, or run \
                     `chan upgrade` (without --check) to launch and update it"
                );
            }
            launch_desktop_then_upgrade().await
        }
    }
}

/// Launch the desktop GUI (none was running) and trigger its updater once it
/// is up. Mirrors `launch_desktop_and_handoff` but for the upgrade trigger.
#[cfg(any(unix, windows))]
async fn launch_desktop_then_upgrade() -> Result<()> {
    use chan_server::handoff::UpgradeOutcome;

    spawn_desktop_gui().context("launching chan-desktop")?;

    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::time::sleep(Duration::from_millis(400)).await;
        match chan_server::handoff::try_upgrade(false).await {
            UpgradeOutcome::Started { .. } => {
                println!("chan: launched chan-desktop; it is updating in the background.");
                return Ok(());
            }
            // Not up yet (socket absent / connect refused): keep waiting.
            UpgradeOutcome::NoDesktop => {}
            // The launched desktop answered the install request with a check:
            // it found nothing newer (it may have updated itself on launch),
            // so say so instead of exiting silently.
            UpgradeOutcome::Checked { .. } => {
                println!("chan: launched chan-desktop; it is already up to date.");
                return Ok(());
            }
            UpgradeOutcome::VersionSkew {
                desktop_version, ..
            } => anyhow::bail!(
                "launched chan-desktop is version {desktop_version}, CLI is {}; cannot upgrade",
                chan_server::handoff::CHAN_VERSION,
            ),
            UpgradeOutcome::DesktopError { message } => {
                anyhow::bail!("chan-desktop could not upgrade: {message}")
            }
        }
        if std::time::Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for chan-desktop to start");
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub(super) async fn cmd_upgrade_desktop(
    _check_only: bool,
    _version_override: Option<String>,
) -> Result<()> {
    anyhow::bail!("desktop `chan upgrade` is not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_route_refuses_a_packaged_build_in_every_personality() {
        // The marker is a build-time option_env!, so both cases are
        // exercised by passing it in. The route is resolved before
        // --check is read, so a packaged build refuses that too.
        for manager in ["aur", "nix"] {
            for personality in [Personality::Standalone, Personality::Desktop] {
                for companion in [false, true] {
                    let route = decide_upgrade_route(personality, Some(manager), companion);
                    let UpgradeRoute::Refuse(message) = route else {
                        panic!("{personality:?} must refuse on a {manager} build, got {route:?}");
                    };
                    assert!(message.contains(&format!("({manager})")), "{message}");
                    assert!(message.contains("self-upgrade is disabled"), "{message}");
                    // The refusal points at the package manager, never back at a
                    // chan command that would fail the same way.
                    assert!(!message.contains("chan upgrade"), "{message}");
                }
            }
        }
    }

    #[test]
    fn upgrade_route_installs_on_an_unpackaged_build() {
        assert_eq!(
            decide_upgrade_route(Personality::Standalone, None, false),
            UpgradeRoute::Cli
        );
        assert_eq!(
            decide_upgrade_route(Personality::Desktop, None, false),
            UpgradeRoute::Desktop
        );
    }

    #[test]
    fn windows_desktop_exe_resolves_self_sibling_or_parent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let desktop = root.join("chan-desktop.exe");
        std::fs::write(&desktop, b"").expect("fake desktop exe");
        std::fs::create_dir(root.join("resources")).expect("resources dir");

        // The desktop binary itself, however it is cased.
        assert_eq!(
            windows_desktop_exe_for(&root.join("Chan-Desktop.EXE")),
            Some(root.join("Chan-Desktop.EXE"))
        );
        // The bundled console chan.exe beside it.
        assert_eq!(
            windows_desktop_exe_for(&root.join("chan.exe")),
            Some(desktop.clone())
        );
        // A chan.exe one level down, under resources\.
        assert_eq!(
            windows_desktop_exe_for(&root.join("resources").join("chan.exe")),
            Some(desktop)
        );
        // A loose chan.exe with no desktop anywhere near it.
        let loose = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            windows_desktop_exe_for(&loose.path().join("chan.exe")),
            None
        );
    }

    #[test]
    fn upgrade_route_sends_the_desktop_companion_cli_to_the_desktop() {
        // The desktop's Windows shim runs the console chan.exe (a Standalone
        // binary) with CHAN_DESKTOP_HANDOFF=1: that binary upgrades the
        // desktop it ships with, never the standalone Windows CLI archive.
        assert_eq!(
            decide_upgrade_route(Personality::Standalone, None, true),
            UpgradeRoute::Desktop
        );
        assert_eq!(
            decide_upgrade_route(Personality::Desktop, None, true),
            UpgradeRoute::Desktop
        );
    }

    #[test]
    fn desktop_companion_needs_windows_and_the_handoff_hint() {
        // The hint alone is not a companion: a unix install.sh `chan` run
        // with CHAN_DESKTOP_HANDOFF=1 (the serve-handoff steer) keeps
        // replacing its own archive, and a Windows process without the hint
        // is the loose standalone CLI that self-upgrades from the ZIP.
        assert!(desktop_companion(true, true));
        assert!(!desktop_companion(false, true));
        assert!(!desktop_companion(true, false));
        assert!(!desktop_companion(false, false));
    }

    /// The desktop a command starts gets the terminal a `chan-term` asked
    /// for in the carrier, and has the carrier removed when there is none, so
    /// one this process inherited opens nothing; it never inherits `$ARGV0`,
    /// which its dispatch reads ahead of `argv[0]`. The paths are its
    /// arguments.
    #[cfg(unix)]
    #[test]
    fn the_started_desktop_carries_only_the_asked_terminal_and_no_argv0() {
        use chan_server::handoff::OPEN_TERMINAL_ENV;
        use std::ffi::{OsStr, OsString};
        let env = |command: &std::process::Command, key: &str| {
            command
                .get_envs()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.map(OsStr::to_os_string))
        };
        let target = Path::new("/usr/bin/chan-desktop");
        let terminal = desktop_gui_command(target, &[], Some("/srv/notes"), Vec::new());
        assert_eq!(terminal.get_program(), target.as_os_str());
        assert_eq!(terminal.get_args().count(), 0);
        assert_eq!(
            env(&terminal, OPEN_TERMINAL_ENV),
            Some(Some(OsString::from("/srv/notes")))
        );
        assert_eq!(env(&terminal, "ARGV0"), Some(None), "ARGV0 is removed");
        let paths = ["/srv/a.md".to_string(), "/srv/docs".to_string()];
        let opener = desktop_gui_command(target, &paths, None, Vec::new());
        assert_eq!(
            opener.get_args().collect::<Vec<_>>(),
            ["/srv/a.md", "/srv/docs"]
        );
        assert_eq!(
            env(&opener, OPEN_TERMINAL_ENV),
            Some(None),
            "the carrier is removed"
        );
        assert_eq!(env(&opener, "ARGV0"), Some(None), "ARGV0 is removed");
    }

    /// The names the desktop writes command shims for and its dispatch reads.
    #[cfg(unix)]
    const COMMANDS: [&str; 5] = ["chan", "cs", "chan-files", "chan-edit", "chan-term"];

    /// An install laid out in a temp dir: `Chan.app/Contents/MacOS/
    /// chan-desktop`, a loose `target/debug/chan-desktop`, and a `bin`
    /// directory for links, as `~/.local/bin` is. The root is resolved, so the
    /// expected paths equal resolved ones under a linked `TMPDIR`.
    #[cfg(unix)]
    struct Install {
        _dir: tempfile::TempDir,
        root: PathBuf,
        bundle: PathBuf,
        bundle_exe: PathBuf,
        dev_exe: PathBuf,
        bin: PathBuf,
    }

    #[cfg(unix)]
    impl Install {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().canonicalize().expect("resolve the tempdir");
            let bundle = root.join("Chan.app");
            let bundle_exe = bundle.join("Contents").join("MacOS").join("chan-desktop");
            let dev_exe = root.join("target").join("debug").join("chan-desktop");
            for exe in [&bundle_exe, &dev_exe] {
                std::fs::create_dir_all(exe.parent().expect("a parent")).expect("binary dir");
                std::fs::write(exe, b"").expect("binary");
            }
            let bin = root.join("bin");
            std::fs::create_dir(&bin).expect("bin dir");
            Self {
                _dir: dir,
                root,
                bundle,
                bundle_exe,
                dev_exe,
                bin,
            }
        }

        /// A link called `name` in `bin` to `target`, as the shim installer
        /// writes one.
        fn link(&self, name: &str, target: &Path) -> PathBuf {
            let link = self.bin.join(name);
            std::os::unix::fs::symlink(target, &link).expect("link");
            link
        }
    }

    /// What a process started through `exe` starts, `exe` resolved as
    /// [`spawn_desktop_gui_opening`] resolves it.
    #[cfg(unix)]
    fn start(exe: &Path, appimage: Option<&Path>, macos: bool) -> std::io::Result<DesktopStart> {
        desktop_start(exe, exe.canonicalize().ok().as_deref(), appimage, macos)
    }

    /// On macOS `current_exe()` can be the shim a command was started
    /// through, a link outside the bundle: each resolves to the `.app` that
    /// holds its binary, which `open` starts, as the bundle's binary does,
    /// which LaunchServices runs by its own path.
    #[cfg(unix)]
    #[test]
    fn a_shim_starts_the_app_bundle_that_holds_its_binary() {
        let install = Install::new();
        let bundle = DesktopStart::Bundle(install.bundle.clone());
        for name in COMMANDS {
            let shim = install.link(name, &install.bundle_exe);
            assert_eq!(start(&shim, None, true).unwrap(), bundle, "{name}");
        }
        let nested = install.bin.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let relative = nested.join("chan-term");
        std::os::unix::fs::symlink("../../Chan.app/Contents/MacOS/chan-desktop", &relative)
            .unwrap();
        assert_eq!(
            start(&relative, None, true).unwrap(),
            bundle,
            "a relative link"
        );
        assert_eq!(start(&install.bundle_exe, None, true).unwrap(), bundle);
        // A bundle whose binary links out of it is found from the path the
        // process was started by, as before resolution.
        assert_eq!(
            desktop_start(&install.bundle_exe, Some(&install.dev_exe), None, true).unwrap(),
            bundle
        );
    }

    /// A desktop binary outside any bundle (a dev build) is started directly
    /// by its resolved path, so the child's `argv[0]` names the desktop, not
    /// the shim it was reached through; off macOS a bundle is not climbed.
    #[cfg(unix)]
    #[test]
    fn a_loose_desktop_binary_is_started_by_its_resolved_path() {
        let install = Install::new();
        let dev = DesktopStart::Binary(install.dev_exe.clone());
        for macos in [true, false] {
            assert_eq!(start(&install.dev_exe, None, macos).unwrap(), dev);
        }
        for name in COMMANDS {
            let shim = install.link(name, &install.dev_exe);
            for macos in [true, false] {
                assert_eq!(start(&shim, None, macos).unwrap(), dev, "{name} {macos}");
            }
        }
        assert_eq!(
            start(&install.bundle_exe, None, false).unwrap(),
            DesktopStart::Binary(install.bundle_exe.clone())
        );
    }

    /// A deb or rpm links `/usr/bin/chan-term` and the other names to
    /// `chan-desktop`. Linux's `current_exe()` already names `chan-desktop`,
    /// and the link resolves to it as well, so the child runs as the desktop.
    #[cfg(unix)]
    #[test]
    fn a_distro_link_starts_the_desktop_binary_it_names() {
        let install = Install::new();
        let usr_bin = install.root.join("usr").join("bin");
        std::fs::create_dir_all(&usr_bin).unwrap();
        let desktop = usr_bin.join("chan-desktop");
        std::fs::write(&desktop, b"").unwrap();
        let started = DesktopStart::Binary(desktop.clone());
        for name in COMMANDS {
            let link = usr_bin.join(name);
            std::os::unix::fs::symlink("chan-desktop", &link).unwrap();
            for exe in [&desktop, &link] {
                assert_eq!(
                    start(exe, None, false).unwrap(),
                    started,
                    "{}",
                    exe.display()
                );
            }
        }
    }

    /// A binary whose own name is a command's (a copy or a hard link of the
    /// desktop called `chan-term`, or a link that resolves to one), and an
    /// AppImage named as one, would run that command again instead of the GUI:
    /// each is refused with its path and the command, on every platform.
    #[cfg(unix)]
    #[test]
    fn a_binary_named_as_a_command_is_refused() {
        let install = Install::new();
        let copies = install.root.join("copies");
        std::fs::create_dir(&copies).unwrap();
        for name in COMMANDS {
            let copy = copies.join(name);
            std::fs::hard_link(&install.dev_exe, &copy).unwrap();
            let shim = install.link(name, &copy);
            let refusal = format!(
                "{} is named {name}, which runs chan's {name} command rather than the desktop; \
                 start chan-desktop first",
                copy.display()
            );
            for exe in [&copy, &shim] {
                for macos in [true, false] {
                    let error = start(exe, None, macos).unwrap_err();
                    assert_eq!(error.to_string(), refusal, "{} {macos}", exe.display());
                }
            }
            let appimage = copies.join(format!("{name}.AppImage"));
            let error = start(&install.dev_exe, Some(&appimage), false).unwrap_err();
            assert!(
                error
                    .to_string()
                    .starts_with(&format!("{} is named {name}, ", appimage.display())),
                "{error}"
            );
        }
        let appimage = install.root.join("Chan_0.129.0_amd64.AppImage");
        assert_eq!(
            start(&install.dev_exe, Some(&appimage), false).unwrap(),
            DesktopStart::Binary(appimage)
        );
    }

    /// The `open` command asks for a new instance with paths, after
    /// `--args`, or with a terminal, in `--env`, and nothing more for a bare
    /// start; it carries no `$ARGV0` and no inherited carrier of its own, so
    /// neither can reach the desktop it starts, whose dispatch reads `$ARGV0`
    /// ahead of `argv[0]`.
    #[cfg(unix)]
    #[test]
    fn the_open_command_carries_the_asked_terminal_and_no_argv0() {
        use chan_server::handoff::OPEN_TERMINAL_ENV;
        use std::ffi::{OsStr, OsString};
        let env = |command: &std::process::Command, key: &str| {
            command
                .get_envs()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.map(OsStr::to_os_string))
        };
        let argv = |command: &std::process::Command| {
            command
                .get_args()
                .map(OsStr::to_os_string)
                .collect::<Vec<_>>()
        };
        let strings = |items: &[&str]| items.iter().map(OsString::from).collect::<Vec<_>>();
        let bundle = Path::new("/Applications/Chan.app");
        let terminal = macos_open_command(bundle, &[], Some("/srv/notes"));
        assert_eq!(
            terminal.get_program(),
            Path::new("/usr/bin/open").as_os_str()
        );
        assert_eq!(
            argv(&terminal),
            strings(&[
                "-n",
                "--env",
                &format!("{OPEN_TERMINAL_ENV}=/srv/notes"),
                "/Applications/Chan.app"
            ])
        );
        let paths = ["/srv/a.md".to_string(), "/srv/docs".to_string()];
        let opener = macos_open_command(bundle, &paths, None);
        assert_eq!(
            argv(&opener),
            strings(&[
                "-n",
                "/Applications/Chan.app",
                "--args",
                "/srv/a.md",
                "/srv/docs"
            ])
        );
        let bare = macos_open_command(bundle, &[], None);
        assert_eq!(argv(&bare), strings(&["/Applications/Chan.app"]));
        for command in [&terminal, &opener, &bare] {
            assert_eq!(env(command, "ARGV0"), Some(None), "ARGV0 is removed");
            assert_eq!(
                env(command, OPEN_TERMINAL_ENV),
                Some(None),
                "an inherited carrier is removed"
            );
        }
    }

    /// An AppImage desktop's environment as its runtime, the GTK hook and
    /// the GUI-stack re-exec leave it, over a user `PATH` and, when given,
    /// `LD_LIBRARY_PATH`: the entries are AppRun's format strings.
    #[cfg(unix)]
    fn appimage_parent(
        appdir: &str,
        user_ld: Option<&str>,
    ) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        let block = |entries: &[&str]| {
            entries
                .iter()
                .map(|entry| format!("{appdir}/{entry}"))
                .collect::<Vec<_>>()
                .join(":")
        };
        let ld = block(&[
            "usr/lib/",
            "usr/lib/i386-linux-gnu/",
            "usr/lib/x86_64-linux-gnu/",
            "usr/lib32/",
            "usr/lib64/",
            "lib/",
            "lib/i386-linux-gnu/",
            "lib/x86_64-linux-gnu/",
            "lib32/",
            "lib64/",
        ]);
        let path = block(&["usr/bin/", "usr/sbin/", "usr/games/", "bin/", "sbin/"]);
        [
            ("APPDIR", appdir.to_string()),
            ("APPIMAGE", "/home/u/Applications/Chan.AppImage".into()),
            ("ARGV0", "chan-term".into()),
            ("OWD", "/home/u".into()),
            ("PATH", format!("{path}:/usr/local/bin:/usr/bin")),
            (
                "LD_LIBRARY_PATH",
                format!("/usr/lib/x86_64-linux-gnu:{ld}:{}", user_ld.unwrap_or("")),
            ),
            (
                "XDG_DATA_DIRS",
                format!("{appdir}/usr/share/:{appdir}/usr/share:/usr/share:"),
            ),
            ("GTK_PATH", format!("{appdir}//usr/lib/gtk-3.0")),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
    }

    /// The desktop a command starts from an AppImage is the AppImage again,
    /// and gets the user's search paths and nothing of this process's
    /// mount, with and without a user `LD_LIBRARY_PATH`; its own runtime
    /// then adds one block. A parent that is no AppImage process hands its
    /// environment on unchanged: the command touches only its own keys.
    #[cfg(unix)]
    #[test]
    fn the_started_desktop_gets_the_users_environment_not_this_mount() {
        use std::ffi::{OsStr, OsString};
        let appdir = "/tmp/.mount_ChanCLI";
        let target = Path::new("/home/u/Applications/Chan.AppImage");
        for (user_ld, want_ld) in [(None, None), (Some("/opt/a/lib"), Some("/opt/a/lib"))] {
            let command = desktop_gui_command(
                target,
                &[],
                Some("/srv/notes"),
                appimage_parent(appdir, user_ld),
            );
            let envs: Vec<(OsString, Option<OsString>)> = command
                .get_envs()
                .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
                .collect();
            let env = |key: &str| {
                envs.iter()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value.clone())
            };
            assert_eq!(env("PATH"), Some(Some("/usr/local/bin:/usr/bin".into())));
            assert_eq!(env("LD_LIBRARY_PATH"), Some(want_ld.map(OsString::from)));
            assert_eq!(env("XDG_DATA_DIRS"), Some(None));
            for gone in ["APPDIR", "APPIMAGE", "OWD", "GTK_PATH", "ARGV0"] {
                assert_eq!(env(gone), Some(None), "{gone}");
            }
            for (key, value) in &envs {
                assert!(
                    !value
                        .as_ref()
                        .is_some_and(|value| value.to_string_lossy().contains(appdir)),
                    "{key:?} keeps the parent's mount"
                );
            }
        }
        let host: Vec<(OsString, OsString)> = appimage_parent(appdir, Some("/opt/a/lib"))
            .into_iter()
            .filter(|(key, _)| key != "APPDIR" && key != "APPIMAGE")
            .collect();
        let command = desktop_gui_command(target, &[], None, host);
        let keys: Vec<&OsStr> = command.get_envs().map(|(key, _)| key).collect();
        assert_eq!(
            keys.len(),
            2,
            "only the carrier and ARGV0 are removed: {keys:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn macos_app_bundle_climbs_to_dot_app() {
        // The real .app layout resolves to the bundle dir.
        let exe = PathBuf::from("/Applications/Chan.app/Contents/MacOS/chan-desktop");
        assert_eq!(
            macos_app_bundle(&exe),
            Some(PathBuf::from("/Applications/Chan.app"))
        );
        // A loose dev binary (cargo target dir) is not a bundle.
        assert_eq!(
            macos_app_bundle(&PathBuf::from("/Users/x/chan/target/debug/chan-desktop")),
            None
        );
        // A path shaped like a bundle but without the .app extension is not
        // a bundle either.
        assert_eq!(
            macos_app_bundle(&PathBuf::from("/x/Chan/Contents/MacOS/chan-desktop")),
            None
        );
    }
}
