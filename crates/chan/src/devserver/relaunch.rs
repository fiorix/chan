use std::path::{Path, PathBuf};

use anyhow::Result;

/// The `chan` CLI entry points a supervisor may name, as found on disk.
/// Populated by [`discover_relaunch_candidates`] and consumed by the pure
/// [`select_relaunchable_exe`].
#[derive(Debug, Default)]
pub(super) struct RelaunchCandidates {
    /// `current_exe()`, when the OS reports one. On Linux this is the SYMLINK
    /// TARGET (`/proc/self/exe`), which is why a distro `chan -> chan-desktop`
    /// install lands here as the desktop binary.
    pub(super) current_exe: Option<PathBuf>,
    /// This process runs from a chan AppImage, so every path under its mount is
    /// ephemeral.
    pub(super) in_chan_appimage: bool,
    /// An existing `chan` next to `current_exe` (the distro package layout).
    pub(super) sibling_chan: Option<PathBuf>,
    /// The existing local `bin/chan` shim (the macOS / AppImage layout).
    pub(super) local_chan: Option<PathBuf>,
}

/// Pick the binary a unit / plist `ExecStart` (or a daemon re-exec) should name.
/// Pure: every candidate is already exists-checked by discovery.
///
/// Two properties matter. The path must still resolve after the process that
/// wrote it is gone, and its basename must stay `chan`, because chan-desktop
/// runs the CLI only when it is invoked through a `chan` name
/// ([`chan_shell::invoked_as_chan`]). So the winner is deliberately NOT
/// canonicalized: a `chan` symlink or wrapper script IS the answer, and
/// resolving it to `chan-desktop` would start the GUI personality instead.
pub(super) fn select_relaunchable_exe(candidates: &RelaunchCandidates) -> Result<PathBuf> {
    let RelaunchCandidates {
        current_exe,
        in_chan_appimage,
        sibling_chan,
        local_chan,
    } = candidates;

    // An AppImage run has no stable path of its own: the mount dir disappears,
    // and the AppImage file itself launches the GUI. Only the local wrapper
    // (`exec -a chan "$APPIMAGE"`) survives a reboot with the right argv[0].
    if *in_chan_appimage {
        return local_chan.clone().ok_or_else(|| {
            anyhow::anyhow!(
                "no `chan` CLI entry point for the devserver supervisor: this is an \
                 AppImage run, whose own path is temporary and launches the desktop GUI. \
                 Launch Chan Desktop once so it installs the `chan` shim, or install the \
                 chan CLI, then retry"
            )
        });
    }

    let Some(exe) = current_exe else {
        // No `current_exe()`: the shim if there is one, else a bare `chan` for
        // the unit's PATH to resolve.
        return Ok(local_chan
            .clone()
            .unwrap_or_else(|| PathBuf::from(CHAN_CLI_BIN_NAME)));
    };
    if chan_shell::invoked_as_chan(exe.as_os_str()) {
        return Ok(exe.clone());
    }
    if is_desktop_binary(exe) {
        return sibling_chan
            .clone()
            .or_else(|| local_chan.clone())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no `chan` CLI entry point for the devserver supervisor: the running \
                     binary is {} (the desktop GUI personality), with no `chan` beside it \
                     and no `chan` shim in the local bin dir. Launch Chan Desktop once so \
                     it installs the shim, or install the chan CLI, then retry",
                    exe.display()
                )
            });
    }
    // Some other name (a dev build, a renamed install): it is the CLI already,
    // so keep it rather than redirecting the supervisor at a different install.
    Ok(exe.clone())
}

/// `chan`, plus `.exe` where the platform wants it.
const CHAN_CLI_BIN_NAME: &str = if cfg!(windows) { "chan.exe" } else { "chan" };

/// Whether `exe` is the desktop GUI binary, which only runs the CLI when it is
/// invoked through a `chan` name. Stem-based, so `chan-desktop.exe` matches.
fn is_desktop_binary(exe: &Path) -> bool {
    exe.file_stem()
        .is_some_and(|stem| stem == std::ffi::OsStr::new("chan-desktop"))
}

/// Whether this process runs from a chan AppImage. A foreign `$APPIMAGE`
/// inherited from another AppImage app (an editor launching chan) does not
/// count.
fn running_in_chan_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some_and(|appimage| {
        Path::new(&appimage)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                let name = name.to_ascii_lowercase();
                name.contains("chan") && name.ends_with(".appimage")
            })
    })
}

/// The live filesystem half of the resolver: probe the two `chan` entry points a
/// desktop install can have.
fn discover_relaunch_candidates() -> RelaunchCandidates {
    let current_exe = std::env::current_exe().ok();
    let sibling_chan = current_exe
        .as_deref()
        .and_then(Path::parent)
        .map(|dir| dir.join(CHAN_CLI_BIN_NAME))
        .filter(|chan| chan.exists());
    let local_chan = chan_workspace::paths::local_bin_dir()
        .map(|dir| dir.join(CHAN_CLI_BIN_NAME))
        .filter(|chan| chan.exists());
    RelaunchCandidates {
        current_exe,
        in_chan_appimage: running_in_chan_appimage(),
        sibling_chan,
        local_chan,
    }
}

/// Resolve a STABLE, relaunchable path to the `chan` CLI for a unit / plist
/// `ExecStart` or a daemon re-exec. See [`select_relaunchable_exe`] for the
/// order and why the result is never canonicalized.
pub(crate) fn resolve_relaunchable_exe() -> Result<PathBuf> {
    select_relaunchable_exe(&discover_relaunch_candidates())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The supervisor `ExecStart` must name a `chan` entry point on every
    /// install layout, and must NEVER name the desktop binary: chan-desktop
    /// runs the CLI only when its argv[0] stem is `chan`, so a unit pointing at
    /// `chan-desktop` starts the GUI personality instead of the devserver.
    #[test]
    fn relaunchable_exe_selects_a_chan_entry_point() {
        struct Case {
            what: &'static str,
            candidates: RelaunchCandidates,
            /// `None` when the layout has no CLI entry point to name.
            expected: Option<&'static str>,
        }

        let cases = [
            Case {
                what: "a standalone chan CLI is already the entry point",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from("/opt/bin/chan")),
                    ..Default::default()
                },
                expected: Some("/opt/bin/chan"),
            },
            Case {
                what: "a distro package takes the chan sibling, uncanonicalized",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from("/usr/bin/chan-desktop")),
                    sibling_chan: Some(PathBuf::from("/usr/bin/chan")),
                    local_chan: Some(PathBuf::from("/home/u/.local/bin/chan")),
                    ..Default::default()
                },
                expected: Some("/usr/bin/chan"),
            },
            Case {
                what: "a macOS app has no sibling, so the local shim wins",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from(
                        "/Applications/Chan.app/Contents/MacOS/chan-desktop",
                    )),
                    local_chan: Some(PathBuf::from("/Users/u/.local/bin/chan")),
                    ..Default::default()
                },
                expected: Some("/Users/u/.local/bin/chan"),
            },
            Case {
                what: "an AppImage run keeps the shim, never its ephemeral mount",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from("/tmp/.mount_ChanXX/usr/bin/chan-desktop")),
                    in_chan_appimage: true,
                    sibling_chan: Some(PathBuf::from("/tmp/.mount_ChanXX/usr/bin/chan")),
                    local_chan: Some(PathBuf::from("/home/u/.local/bin/chan")),
                },
                expected: Some("/home/u/.local/bin/chan"),
            },
            Case {
                what: "an unrecognized name is the CLI already, so keep it",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from("/opt/bin/chan-0.77")),
                    ..Default::default()
                },
                expected: Some("/opt/bin/chan-0.77"),
            },
            Case {
                what: "no current_exe falls back to the shim",
                candidates: RelaunchCandidates {
                    local_chan: Some(PathBuf::from("/home/u/.local/bin/chan")),
                    ..Default::default()
                },
                expected: Some("/home/u/.local/bin/chan"),
            },
            Case {
                what: "the desktop binary with no CLI entry point is an error",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from("/usr/bin/chan-desktop")),
                    ..Default::default()
                },
                expected: None,
            },
            Case {
                what: "an AppImage run with no shim is an error",
                candidates: RelaunchCandidates {
                    current_exe: Some(PathBuf::from("/tmp/.mount_ChanXX/usr/bin/chan-desktop")),
                    in_chan_appimage: true,
                    sibling_chan: Some(PathBuf::from("/tmp/.mount_ChanXX/usr/bin/chan")),
                    ..Default::default()
                },
                expected: None,
            },
        ];

        for case in cases {
            let selected = select_relaunchable_exe(&case.candidates);
            match (&selected, case.expected) {
                (Ok(exe), Some(expected)) => {
                    assert_eq!(exe, &PathBuf::from(expected), "{}", case.what);
                    assert!(
                        !is_desktop_binary(exe),
                        "{}: selected the GUI binary {}",
                        case.what,
                        exe.display()
                    );
                }
                (Ok(exe), None) => {
                    panic!("{}: expected an error, got {}", case.what, exe.display())
                }
                (Err(e), Some(expected)) => {
                    panic!("{}: expected {expected}, got error: {e}", case.what)
                }
                (Err(_), None) => {}
            }
        }
    }
}
