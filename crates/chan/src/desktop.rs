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
        chan_server::handoff::Outcome::CloseRefused { .. } => {
            eprintln!(
                "chan: chan-desktop returned a close refusal while opening the workspace; \
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
        chan_server::handoff::Outcome::NoDesktop => {
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
/// Only reached from the Desktop personality, so `current_exe()` IS the
/// chan-desktop binary. Spawns the GUI detached, then polls the well-known
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
            chan_server::handoff::Outcome::CloseRefused { .. } => {
                anyhow::bail!("chan-desktop returned a close refusal while opening the workspace");
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
///
/// `current_exe()` is the chan-desktop binary (this only runs for the Desktop
/// personality). We start it with a clean argv0 (NOT `chan`/`cs`) so the
/// pre-GUI argv probe falls through to a normal GUI launch instead of
/// re-dispatching as the CLI.
#[cfg(unix)]
fn spawn_desktop_gui() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let exe = std::env::current_exe()?;

    // macOS: launching the bare Mach-O inside the `.app` can start the process
    // without LaunchServices activating/foregrounding it. Prefer
    // `open <Name>.app`, which hands launch to LaunchServices (proper
    // activation + single-instance). Derive the bundle by climbing
    // `…/<Name>.app/Contents/MacOS/<bin>`.
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle) = macos_app_bundle(&exe) {
            return Command::new("/usr/bin/open")
                .arg(bundle)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|_| ());
        }
        // Not in a bundle (dev build): fall through to the direct exec below.
    }

    // Linux AppImage: `$APPIMAGE` is the real, relaunchable image, while
    // `current_exe()` is the ephemeral `/tmp/.mount_*` path. Prefer
    // `$APPIMAGE`; off an AppImage (deb/rpm) `current_exe()` is
    // `/usr/bin/chan-desktop`, which relaunches fine.
    let target = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .unwrap_or(exe);
    Command::new(&target)
        // Clean argv0 so the spawned process boots the GUI, not the alias.
        .arg0(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // New process group so Ctrl-C in the launching terminal doesn't also
        // kill the desktop we just started.
        .process_group(0)
        .spawn()
        .map(|_| ())
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
#[cfg(target_os = "macos")]
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

    #[cfg(target_os = "macos")]
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
