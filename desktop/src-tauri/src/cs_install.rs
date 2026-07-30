//! First-run install of the `chan` and `cs` bin shims into `~/.local/bin`
//! (`$CHAN_HOME/.local/bin` when `CHAN_HOME` is set -- resolved via
//! `chan_workspace::paths::local_bin_dir`, so a smoke instance stays isolated),
//! so a chan-desktop install also gives you the `chan` / `cs` command line with
//! nothing extra to download. Both names resolve to the running chan-desktop
//! binary; the argv[0] dispatch (`chan_shell::invoked_as_chan` /
//! `invoked_as_cs`) selects the CLI / control-client path before any GUI init.
//!
//! The shape of the shim depends on how chan-desktop was installed:
//!
//! - **macOS `.app`** and **Linux deb/rpm**: real symlinks to the installed
//!   binary (`current_exe()`). The path is stable across an in-place
//!   self-upgrade, and a symlink WE wrote is re-pointed on boot if the binary
//!   moved (e.g. the `.app` was dragged into /Applications).
//! - **Linux AppImage**: tiny wrapper scripts (`exec -a chan "$APPIMAGE" "$@"`),
//!   not symlinks. `std::env::current_exe()` inside an AppImage points into the
//!   ephemeral `/tmp/.mount_*` squashfs that vanishes on exit, and the `AppRun`
//!   shim can reset argv[0]; `exec -a <name> "$APPIMAGE"` pins both the stable
//!   path and the argv[0] the detection keys on.
//! - **Nix store / dev build / `cargo run` / anything else**: no-op. Nix
//!   installs the `chan` and `cs` output symlinks itself; unrecognized builds
//!   never pollute `~/.local/bin`.
//!
//! Posture: best-effort + idempotent + self-healing. A failure is logged, never
//! fatal. A shim WE wrote self-heals on the next launch when it goes stale (the
//! binary moved, the AppImage updated). A `chan` / `cs` the user installed
//! themselves -- a real binary from install.sh, a hand-made symlink -- is never
//! clobbered.

#[cfg(unix)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

/// The two names we own. Both point at the same chan-desktop binary; argv[0]
/// dispatch picks the behavior.
#[cfg(unix)]
const SHIM_NAMES: [&str; 2] = ["chan", "cs"];

/// File stem of the chan-desktop binary. A symlink at `~/.local/bin/{chan,cs}`
/// whose target ends in this stem is recognized as OURS (so a moved/upgraded
/// install self-heals), while a user's own `cs -> chan` (stem "chan") is left
/// alone.
#[cfg(unix)]
const DESKTOP_BIN_STEM: &str = "chan-desktop";

/// Marker line written into a wrapper script so we only ever rewrite a wrapper
/// WE wrote.
#[cfg(unix)]
const WRAPPER_MARKER: &str = "# chan-desktop bin shim";

/// Ownership substring: any wrapper containing this was written by some version
/// of chan-desktop (the marker text has changed over time), so it is ours to
/// rewrite. A user's own script will not contain it.
#[cfg(unix)]
const WRAPPER_OWNS: &str = "# chan-desktop";

/// The AppImage path from `$APPIMAGE`, or `None` when not running from an
/// AppImage (macOS, `cargo run`, a deb/rpm install). Also consumed by
/// `linux_gui_stack` to gate the bundle-first loader fixups. Unix-only: the
/// AppImage / bundle-first loader concept does not exist on Windows.
#[cfg(unix)]
pub fn appimage_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// How this chan-desktop was installed, which decides how the shims are made.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum InstallKind {
    /// Linux AppImage: write wrapper scripts re-execing this `$APPIMAGE`.
    AppImage(PathBuf),
    /// A stable on-disk binary we can symlink to directly -- a macOS `.app`
    /// bundle binary or a Linux deb/rpm `/usr/bin/chan-desktop`.
    Symlink(PathBuf),
    /// Dev build / unrecognized layout: do nothing.
    None,
}

/// Classify the install from the AppImage path and the (canonicalized) running
/// exe. Pure, so the precedence is unit-tested without the process env. The
/// `.app` and `/usr` checks are not `cfg`-gated because the two patterns are
/// mutually exclusive in practice (a Linux path never contains
/// `.app/Contents/MacOS/`, a macOS app binary is never under `/usr`), which
/// keeps both branches testable on any host.
#[cfg(unix)]
fn classify_install(appimage: Option<PathBuf>, exe: Option<PathBuf>) -> InstallKind {
    if let Some(appimage) = appimage {
        return InstallKind::AppImage(appimage);
    }
    let Some(exe) = exe else {
        return InstallKind::None;
    };
    let s = exe.to_string_lossy();
    // macOS .app bundle binary: …/Chan.app/Contents/MacOS/chan-desktop.
    if s.contains(".app/Contents/MacOS/") {
        return InstallKind::Symlink(exe);
    }
    // Linux deb/rpm: a system-installed /usr/bin/chan-desktop (or /usr/local).
    if s.starts_with("/usr/") && exe.file_name() == Some(OsStr::new(DESKTOP_BIN_STEM)) {
        return InstallKind::Symlink(exe);
    }
    InstallKind::None
}

/// Gather the env + exe and classify. The exe is canonicalized so the symlink
/// target is the real binary (stable across an in-place self-upgrade) and a
/// moved install re-points cleanly.
#[cfg(unix)]
fn detect_kind() -> InstallKind {
    let appimage = appimage_path();
    let exe = std::env::current_exe()
        .ok()
        .map(|e| e.canonicalize().unwrap_or(e));
    classify_install(appimage, exe)
}

/// The wrapper script that re-execs `target` as `name`. `exec -a` (a bash
/// builtin present on every AppImage-capable desktop) forces argv[0] regardless
/// of how the AppImage `AppRun` shim would otherwise rewrite it.
#[cfg(unix)]
fn wrapper_script(name: &str, target: &Path) -> String {
    format!(
        "#!/usr/bin/env bash\n\
         {WRAPPER_MARKER}\n\
         # Re-exec the chan-desktop AppImage as `{name}` so the right argv[0]\n\
         # dispatch fires (CLI / control client) instead of the GUI. Rewritten\n\
         # on launch if the AppImage path changes; delete this file to opt out.\n\
         exec -a {name} {} \"$@\"\n",
        shell_single_quote(target),
    )
}

/// Single-quote a path for the wrapper so a space or shell metacharacter in the
/// AppImage path is safe. Embedded single quotes are escaped the POSIX way
/// (`'\''`).
#[cfg(unix)]
fn shell_single_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"))
}

/// What to do with a wrapper-script shim given the current file contents.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum WrapperPlan {
    /// Leave it: a user's own file (no marker), or already current.
    Skip,
    /// Write this script (absent, or ours-but-stale).
    Write(String),
}

#[cfg(unix)]
fn plan_wrapper(name: &str, appimage: &Path, existing: Option<&str>) -> WrapperPlan {
    let desired = wrapper_script(name, appimage);
    match existing {
        // A file we did not write: never touch it.
        Some(content) if !content.contains(WRAPPER_OWNS) => WrapperPlan::Skip,
        // Our wrapper, already current.
        Some(content) if content == desired => WrapperPlan::Skip,
        // Absent, or our wrapper but stale -> (re)write.
        _ => WrapperPlan::Write(desired),
    }
}

/// What we observe at a shim path, enough to plan a symlink without clobbering
/// anything foreign.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum Observed {
    /// Nothing there.
    Absent,
    /// A symlink, with the literal path it points at.
    SymlinkTo(PathBuf),
    /// A regular file (or anything that is not a symlink we can read): foreign.
    NonSymlink,
}

#[cfg(unix)]
fn observe(path: &Path) -> Observed {
    match std::fs::symlink_metadata(path) {
        Err(_) => Observed::Absent,
        Ok(meta) if meta.file_type().is_symlink() => match std::fs::read_link(path) {
            Ok(target) => Observed::SymlinkTo(target),
            Err(_) => Observed::NonSymlink,
        },
        Ok(_) => Observed::NonSymlink,
    }
}

/// What to do with a symlink shim.
#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
enum SymAction {
    /// Leave it: already current, or foreign.
    Skip,
    /// Create the symlink (nothing there).
    Link,
    /// Replace our own stale symlink (the binary moved / self-upgraded).
    Relink,
}

#[cfg(unix)]
fn plan_symlink(target: &Path, observed: &Observed) -> SymAction {
    match observed {
        Observed::Absent => SymAction::Link,
        // Never clobber a real file (a user's standalone `chan` binary, etc.).
        Observed::NonSymlink => SymAction::Skip,
        Observed::SymlinkTo(current) => {
            if current == target {
                SymAction::Skip
            } else if current.file_name() == Some(OsStr::new(DESKTOP_BIN_STEM)) {
                // A symlink pointing at a (different) chan-desktop binary is one
                // of ours that went stale -> re-point. A user's `cs -> chan`
                // (stem "chan") falls through to Skip.
                SymAction::Relink
            } else {
                SymAction::Skip
            }
        }
    }
}

/// Install (or refresh) one shim. Returns `Ok(true)` when it wrote/updated the
/// shim, `Ok(false)` when nothing was needed (foreign entry, already current).
#[cfg(unix)]
fn install_one(kind: &InstallKind, bin_dir: &Path, name: &str) -> std::io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;

    let path = bin_dir.join(name);
    match kind {
        InstallKind::None => Ok(false),
        InstallKind::AppImage(appimage) => {
            // Read the existing wrapper as text. An entry that exists but is not
            // readable UTF-8 (a binary, a symlink to one) is foreign -> skip.
            let existing = match std::fs::read_to_string(&path) {
                Ok(content) => Some(content),
                Err(_) if path.symlink_metadata().is_ok() => return Ok(false),
                Err(_) => None,
            };
            match plan_wrapper(name, appimage, existing.as_deref()) {
                WrapperPlan::Skip => Ok(false),
                WrapperPlan::Write(script) => {
                    std::fs::create_dir_all(bin_dir)?;
                    std::fs::write(&path, script)?;
                    let mut perms = std::fs::metadata(&path)?.permissions();
                    perms.set_mode(0o755);
                    std::fs::set_permissions(&path, perms)?;
                    Ok(true)
                }
            }
        }
        InstallKind::Symlink(target) => match plan_symlink(target, &observe(&path)) {
            SymAction::Skip => Ok(false),
            SymAction::Link => {
                std::fs::create_dir_all(bin_dir)?;
                std::os::unix::fs::symlink(target, &path)?;
                Ok(true)
            }
            SymAction::Relink => {
                std::fs::create_dir_all(bin_dir)?;
                std::fs::remove_file(&path)?;
                std::os::unix::fs::symlink(target, &path)?;
                Ok(true)
            }
        },
    }
}

/// The directory the unix shim install resolves to -- `local_bin_dir()`, which is
/// CHAN_HOME-aware (`$CHAN_HOME/.local/bin` when set, else `$HOME/.local/bin`) -- so
/// the boot install log can name the path it ACTUALLY wrote to instead of a hardcoded
/// `~/.local/bin` (which misleads under a `CHAN_HOME` smoke instance). `None` off unix:
/// the Windows shims live under a different `%LOCALAPPDATA%` dir, so the log omits the
/// path there rather than naming the wrong one (no behavioural change, just logging).
#[cfg(unix)]
pub(crate) fn shim_install_dir() -> Option<std::path::PathBuf> {
    chan_workspace::paths::local_bin_dir()
}

/// Off unix the boot log omits the install dir (see the unix variant).
#[cfg(not(unix))]
pub(crate) fn shim_install_dir() -> Option<std::path::PathBuf> {
    None
}

/// Install the `~/.local/bin/{chan,cs}` shims for this install, self-healing any
/// stale shim WE wrote. No-op for a dev build / unrecognized layout or when
/// there is no home dir. Returns the number of shims written/updated.
///
/// Best-effort: a per-shim failure is logged and the other shim is still
/// attempted; nothing here is fatal to boot.
#[cfg(unix)]
pub fn install_bin_shims() -> std::io::Result<u32> {
    let kind = detect_kind();
    if matches!(kind, InstallKind::None) {
        return Ok(0);
    }
    // CHAN_HOME-aware: `$CHAN_HOME/.local/bin` when CHAN_HOME is set, else
    // `$HOME/.local/bin` (byte-identical to the old inlined path when unset). `None`
    // only when neither base resolves -- then there's nowhere to install, so no-op.
    let Some(bin_dir) = chan_workspace::paths::local_bin_dir() else {
        return Ok(0);
    };

    let mut changed = 0u32;
    for name in SHIM_NAMES {
        match install_one(&kind, &bin_dir, name) {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, shim = name, "installing bin shim failed"),
        }
    }
    Ok(changed)
}

/// Windows: there is no `exec -a` to force argv[0] and no POSIX symlink, so the
/// shims are `.cmd` wrappers in a per-user bin dir (`%LOCALAPPDATA%\chan\bin`)
/// that set `ARGV0=<name>` before re-execing the installed chan-desktop.exe.
/// `chan_shell::invoked_arg0()` reads `$ARGV0` ahead of `argv[0]`, so the
/// `chan` / `cs` stem dispatch fires (CLI / control client) instead of the GUI
/// -- the same mechanism the Linux AppImage uses via `exec -a` exporting
/// `$ARGV0`. Best-effort: also append the bin dir to the per-user `Path` so a
/// fresh shell resolves `chan` / `cs`.
#[cfg(windows)]
pub fn install_bin_shims() -> std::io::Result<u32> {
    use windows_shim::{
        ensure_on_user_path, install_one, install_roots, resolve_cli_target, shim_bin_dir,
        SHIM_NAMES,
    };

    // Stable install path only: a dev `cargo run` from target\{debug,release}\
    // is left alone (never pollute the user's PATH from an un-packaged build),
    // mirroring the unix `InstallKind::None` short-circuit.
    let Some(exe) = std::env::current_exe().ok() else {
        tracing::debug!("chan/cs shim install skipped: current_exe() unavailable");
        return Ok(0);
    };
    if !windows_shim::is_installed_exe(&exe, &install_roots()) {
        tracing::debug!(
            exe = %exe.display(),
            "chan/cs shim install skipped: not an installed chan-desktop.exe (dev build)",
        );
        return Ok(0);
    }
    let Some(bin_dir) = shim_bin_dir() else {
        tracing::warn!("chan/cs shim install skipped: %LOCALAPPDATA% bin dir unavailable");
        return Ok(0);
    };

    // Point the shims at the bundled console `chan.exe` when present (real CLI
    // semantics: foreground + Ctrl-C), else the GUI chan-desktop.exe as before.
    let target = resolve_cli_target(&exe);

    let mut changed = 0u32;
    for name in SHIM_NAMES {
        match install_one(&target, &bin_dir, name) {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, shim = name, "installing bin shim failed"),
        }
    }
    // Put the bin dir on PATH so a new shell finds `chan` / `cs`. Best-effort:
    // a registry failure is logged, never fatal, and the written shims still
    // work via an absolute path or a manually-extended PATH.
    if changed > 0 {
        if let Err(e) = ensure_on_user_path(&bin_dir) {
            tracing::warn!(error = %e, "adding chan bin dir to user PATH failed");
        }
    }
    Ok(changed)
}

/// Windows shim mechanics: `.cmd` wrappers (no `exec -a` / symlinks on Windows),
/// plus a best-effort per-user `Path` registration. Split into pure helpers so
/// the wrapper text, the install-vs-dev classification, and the PATH-append
/// string surgery are unit-testable without touching the registry or the FS.
#[cfg(windows)]
mod windows_shim {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// The two names we own. Both re-exec the same chan-desktop.exe; the
    /// `ARGV0` the wrapper sets picks the behavior.
    pub(super) const SHIM_NAMES: [&str; 2] = ["chan", "cs"];

    /// File stem of the chan-desktop binary an installed exe must match (the
    /// dev-build guard rejects anything else).
    const DESKTOP_BIN_STEM: &str = "chan-desktop";

    /// Marker line so we only ever rewrite a wrapper WE wrote; `::` is a batch
    /// comment. A user's own `chan.cmd` will not contain it.
    const WRAPPER_MARKER: &str = ":: chan-desktop bin shim";

    /// Ownership substring: any wrapper containing this was written by some
    /// version of chan-desktop, so it is ours to rewrite.
    const WRAPPER_OWNS: &str = ":: chan-desktop";

    /// Marker line for the extensionless POSIX shim (Git BASH runs a bare
    /// `chan` / `cs`, not `chan.cmd`). `#` is an sh comment; a user's own
    /// `chan` will not contain it.
    const POSIX_MARKER: &str = "# chan-desktop bin shim";

    /// Ownership substring for the POSIX shim, analogous to `WRAPPER_OWNS`.
    const POSIX_OWNS: &str = "# chan-desktop";

    /// Per-user bin dir for the `.cmd` shims: `%LOCALAPPDATA%\chan\bin`, the
    /// Windows analogue of the unix `~/.local/bin`.
    pub(super) fn shim_bin_dir() -> Option<PathBuf> {
        dirs::data_local_dir().map(|d| d.join("chan").join("bin"))
    }

    /// Roots a packaged chan-desktop.exe can legitimately live under: the NSIS
    /// `currentUser` install lands beneath `%LOCALAPPDATA%`; a `perMachine`
    /// install lands beneath one of the Program Files dirs.
    pub(super) fn install_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if let Some(d) = dirs::data_local_dir() {
            roots.push(d);
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(v) = std::env::var_os(var) {
                roots.push(PathBuf::from(v));
            }
        }
        roots
    }

    /// Resolve the binary the `chan` / `cs` shims should re-exec. Prefer a
    /// bundled console-subsystem `chan.exe` (a real CLI: `chan devserver` from a
    /// terminal then BLOCKS and takes Ctrl-C, unlike the GUI-subsystem
    /// chan-desktop.exe, which detaches when launched from PowerShell). Probe
    /// the layouts the Windows bundle may place it in -- a sibling of
    /// chan-desktop.exe, or a `resources\` subdir -- and fall back to the desktop
    /// exe itself when absent (a desktop-only build / older install), so the
    /// shims always point at SOMETHING that dispatches the CLI via `$ARGV0`.
    pub(super) fn resolve_cli_target(desktop_exe: &Path) -> PathBuf {
        let Some(dir) = desktop_exe.parent() else {
            return desktop_exe.to_path_buf();
        };
        for candidate in [dir.join("chan.exe"), dir.join("resources").join("chan.exe")] {
            if candidate.is_file() {
                return candidate;
            }
        }
        desktop_exe.to_path_buf()
    }

    /// Whether `exe` is an installed chan-desktop (the right stem, under a known
    /// install root) versus a `cargo run` from `target\`. Pure for testing.
    pub(super) fn is_installed_exe(exe: &Path, roots: &[PathBuf]) -> bool {
        if exe.file_stem() != Some(OsStr::new(DESKTOP_BIN_STEM)) {
            return false;
        }
        roots.iter().any(|root| path_starts_with_ci(exe, root))
    }

    /// Case-insensitive, boundary-aware path prefix test (Windows paths are
    /// case-insensitive). `C:\Foo\bar` starts with `c:\foo` but not `C:\foobar`.
    fn path_starts_with_ci(path: &Path, prefix: &Path) -> bool {
        let p = path.to_string_lossy().to_lowercase();
        let pre = prefix.to_string_lossy().to_lowercase();
        let pre = pre.trim_end_matches(['\\', '/']);
        if !p.starts_with(pre) {
            return false;
        }
        match p[pre.len()..].chars().next() {
            None => true,
            Some(c) => c == '\\' || c == '/',
        }
    }

    /// The `.cmd` wrapper that re-execs `target` as `name`. `set "ARGV0=<name>"`
    /// makes `chan_shell::invoked_arg0()` report `<name>` so the CLI / control
    /// client dispatch fires before any GUI init. `set "CHAN_DESKTOP_HANDOFF=1"`
    /// opts the bundled console `chan.exe` (a `Standalone`-personality binary)
    /// into the CLI-to-desktop handoff, so `chan open <ws>` hands off to the
    /// running desktop instead of binding its own port -- matching the
    /// macOS/Linux desktop shim (which re-execs the desktop binary directly).
    /// `%*` forwards the args; `exit /b` propagates the child's exit code. CRLF
    /// endings for `cmd.exe`.
    pub(super) fn wrapper_script(name: &str, target: &Path) -> String {
        format!(
            "@echo off\r\n\
             {WRAPPER_MARKER}\r\n\
             setlocal\r\n\
             set \"ARGV0={name}\"\r\n\
             set \"CHAN_DESKTOP_HANDOFF=1\"\r\n\
             \"{target}\" %*\r\n\
             exit /b %errorlevel%\r\n",
            target = target.display(),
        )
    }

    /// The extensionless POSIX shim that a POSIX shell (a user's own
    /// `bash`/`sh`) runs for a bare `chan` / `cs`, since such shells do not
    /// consult `PATHEXT` and so will not run `chan.cmd` as `chan`. Exports
    /// `ARGV0=<name>` -- `chan_shell::invoked_arg0()` reads it ahead of
    /// `argv[0]` -- and `CHAN_DESKTOP_HANDOFF=1` so `chan open` hands off to the
    /// running desktop (see [`wrapper_script`]), then execs the target. Same
    /// ARGV0 mechanism as the Linux AppImage wrapper. Forward-slash target so
    /// MSYS parses the path (backslashes are sh escapes); LF endings.
    pub(super) fn posix_wrapper_script(name: &str, target: &Path) -> String {
        let target = target.display().to_string().replace('\\', "/");
        format!(
            "#!/bin/sh\n\
             {POSIX_MARKER}\n\
             export ARGV0={name}\n\
             export CHAN_DESKTOP_HANDOFF=1\n\
             exec \"{target}\" \"$@\"\n",
        )
    }

    /// What to do with a `.cmd` shim given the current file contents.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum WrapperPlan {
        /// Leave it: a user's own file (no marker), or already current.
        Skip,
        /// Write this script (absent, or ours-but-stale).
        Write(String),
    }

    /// Decide whether to (re)write a shim file given its current contents:
    /// write when absent or ours-but-stale; skip a foreign file (no `owns`
    /// marker) or one already current. Pure for testing -- shared by the
    /// `.cmd` and POSIX shims.
    pub(super) fn plan_shim(desired: &str, owns: &str, existing: Option<&str>) -> WrapperPlan {
        match existing {
            Some(content) if !content.contains(owns) => WrapperPlan::Skip,
            Some(content) if content == desired => WrapperPlan::Skip,
            _ => WrapperPlan::Write(desired.to_string()),
        }
    }

    /// Install (or refresh) BOTH shims for `name`: the `.cmd` (cmd.exe /
    /// PowerShell) and the extensionless POSIX script (Git BASH). `Ok(true)`
    /// when either was written/updated, `Ok(false)` when both were left alone
    /// (foreign entry, already current).
    pub(super) fn install_one(target: &Path, bin_dir: &Path, name: &str) -> std::io::Result<bool> {
        let cmd = install_shim_file(
            &bin_dir.join(format!("{name}.cmd")),
            &wrapper_script(name, target),
            WRAPPER_OWNS,
        )?;
        let posix = install_shim_file(
            &bin_dir.join(name),
            &posix_wrapper_script(name, target),
            POSIX_OWNS,
        )?;
        Ok(cmd || posix)
    }

    /// Write `desired` to `path` when `plan_shim` says so, creating the bin
    /// dir on demand. An entry that exists but is not readable UTF-8 is
    /// foreign -> skip.
    fn install_shim_file(path: &Path, desired: &str, owns: &str) -> std::io::Result<bool> {
        let existing = match std::fs::read_to_string(path) {
            Ok(content) => Some(content),
            Err(_) if path.symlink_metadata().is_ok() => return Ok(false),
            Err(_) => None,
        };
        match plan_shim(desired, owns, existing.as_deref()) {
            WrapperPlan::Skip => Ok(false),
            WrapperPlan::Write(script) => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(path, script)?;
                Ok(true)
            }
        }
    }

    /// The new per-user `Path` value once `dir` is appended, or `None` when
    /// `dir` is already present (case-insensitive). Pure string surgery so the
    /// membership + join logic is testable without the registry.
    pub(super) fn path_with_dir_appended(current: &str, dir: &str) -> Option<String> {
        let dir_norm = dir.trim_end_matches(['\\', '/']).to_lowercase();
        let present = current
            .split(';')
            .map(|e| e.trim().trim_end_matches(['\\', '/']).to_lowercase())
            .any(|e| e == dir_norm);
        if present {
            return None;
        }
        if current.is_empty() {
            Some(dir.to_string())
        } else if current.ends_with(';') {
            Some(format!("{current}{dir}"))
        } else {
            Some(format!("{current};{dir}"))
        }
    }

    /// Best-effort append of `dir` to the per-user `Path` (HKCU\Environment) via
    /// `reg.exe` -- no extra crate dependency for the write itself, mirroring how
    /// `linux_gui_stack` shells out to `ldconfig`. Reads the current value +
    /// type, appends only when missing, and writes it back preserving the
    /// registry type. After a successful write it broadcasts `WM_SETTINGCHANGE`
    /// ("Environment") so processes spawned afterward (Explorer, new shells)
    /// inherit the new PATH without a logout; an already-open shell still needs
    /// a relaunch. Any failure is returned for the caller to log.
    pub(super) fn ensure_on_user_path(dir: &Path) -> std::io::Result<()> {
        use std::process::Command;
        let dir = dir.to_string_lossy().into_owned();
        let (current, kind) = read_user_path()?;
        let Some(new_value) = path_with_dir_appended(&current, &dir) else {
            return Ok(()); // already on PATH
        };
        let status = Command::new("reg")
            .args([
                "add",
                "HKCU\\Environment",
                "/v",
                "Path",
                "/t",
                &kind,
                "/d",
                &new_value,
                "/f",
            ])
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other(format!(
                "reg add HKCU\\Environment Path exited with {status}"
            )));
        }
        broadcast_environment_change();
        Ok(())
    }

    /// Tell top-level windows (Explorer, and thus processes it spawns) that the
    /// environment changed, so a fresh shell picks up the new PATH without a
    /// logout. Best-effort and time-bounded: a hung listener cannot stall the
    /// caller (`SMTO_ABORTIFHUNG` + a 5s timeout), and the result is ignored.
    fn broadcast_environment_change() {
        use windows_sys::Win32::Foundation::{LPARAM, WPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        // "Environment" as a NUL-terminated UTF-16 buffer for lParam.
        let env: Vec<u16> = "Environment"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut result: usize = 0;
        // SAFETY: a standard WM_SETTINGCHANGE broadcast. `env` is a valid
        // NUL-terminated UTF-16 buffer that outlives this synchronous, timed
        // call; the out-param is a live stack `usize`.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0 as WPARAM,
                env.as_ptr() as LPARAM,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }

    /// Current per-user `Path` value and its registry type (`REG_EXPAND_SZ` /
    /// `REG_SZ`). A fresh user with no `Path` value yields an empty string typed
    /// `REG_EXPAND_SZ` (the default for an env var that may contain `%VAR%`).
    fn read_user_path() -> std::io::Result<(String, String)> {
        use std::process::Command;
        let out = Command::new("reg")
            .args(["query", "HKCU\\Environment", "/v", "Path"])
            .output()?;
        if !out.status.success() {
            // No Path value yet: create it as REG_EXPAND_SZ.
            return Ok((String::new(), "REG_EXPAND_SZ".to_string()));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(parse_reg_query_path(&text)
            .unwrap_or_else(|| (String::new(), "REG_EXPAND_SZ".to_string())))
    }

    /// Parse `reg query HKCU\Environment /v Path` output into (value, type).
    /// The data line is `    Path    REG_EXPAND_SZ    <value>` (value may
    /// contain spaces and `;`). Pure for testing.
    fn parse_reg_query_path(text: &str) -> Option<(String, String)> {
        for line in text.lines() {
            let trimmed = line.trim_start();
            // The data line is `Path    REG_TYPE    <value>`; skip every other
            // line (header, blank). The char after the name must be whitespace
            // so we don't match a different value like `PathExt`.
            let Some(rest) = trimmed.strip_prefix("Path") else {
                continue;
            };
            if !rest.starts_with(char::is_whitespace) {
                continue;
            }
            let rest = rest.trim_start();
            let mut it = rest.splitn(2, char::is_whitespace);
            let Some(kind) = it.next() else {
                continue;
            };
            if !kind.starts_with("REG_") {
                continue;
            }
            let value = it.next().unwrap_or("").trim().to_string();
            return Some((value, kind.to_string()));
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn resolve_cli_target_prefers_bundled_chan_then_falls_back() {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path();
            let desktop = dir.join("chan-desktop.exe");
            std::fs::write(&desktop, b"").unwrap();

            // No chan.exe anywhere: fall back to the desktop exe (no regression).
            assert_eq!(resolve_cli_target(&desktop), desktop);

            // chan.exe in a `resources\` subdir is used.
            let res_dir = dir.join("resources");
            std::fs::create_dir_all(&res_dir).unwrap();
            let res_cli = res_dir.join("chan.exe");
            std::fs::write(&res_cli, b"").unwrap();
            assert_eq!(resolve_cli_target(&desktop), res_cli);

            // A sibling chan.exe wins (first candidate probed).
            let sibling = dir.join("chan.exe");
            std::fs::write(&sibling, b"").unwrap();
            assert_eq!(resolve_cli_target(&desktop), sibling);
        }

        #[test]
        fn installed_exe_accepts_localappdata_rejects_target() {
            let roots = vec![PathBuf::from("C:\\Users\\me\\AppData\\Local")];
            assert!(is_installed_exe(
                Path::new("C:\\Users\\me\\AppData\\Local\\chan\\chan-desktop.exe"),
                &roots,
            ));
            // Case-insensitive root match.
            assert!(is_installed_exe(
                Path::new("c:\\users\\me\\appdata\\local\\Chan\\chan-desktop.exe"),
                &roots,
            ));
            // A dev cargo build is left alone.
            assert!(!is_installed_exe(
                Path::new("C:\\src\\chan\\target\\release\\chan-desktop.exe"),
                &roots,
            ));
            // Boundary-aware: a sibling dir sharing a prefix is not "under" it.
            assert!(!is_installed_exe(
                Path::new("C:\\Users\\me\\AppData\\Localx\\chan-desktop.exe"),
                &roots,
            ));
            // Wrong stem under a valid root.
            assert!(!is_installed_exe(
                Path::new("C:\\Users\\me\\AppData\\Local\\chan\\notepad.exe"),
                &roots,
            ));
        }

        #[test]
        fn wrapper_sets_argv0_and_quotes_target() {
            let s = wrapper_script(
                "chan",
                Path::new("C:\\Program Files\\Chan\\chan-desktop.exe"),
            );
            assert!(s.starts_with("@echo off\r\n"));
            assert!(s.contains(WRAPPER_MARKER));
            assert!(s.contains("set \"ARGV0=chan\"\r\n"));
            // Opts the bundled console chan.exe into the desktop handoff.
            assert!(s.contains("set \"CHAN_DESKTOP_HANDOFF=1\"\r\n"));
            assert!(s.contains("\"C:\\Program Files\\Chan\\chan-desktop.exe\" %*\r\n"));
            assert!(s.contains("exit /b %errorlevel%\r\n"));
            // Distinct script per name.
            let cs = wrapper_script("cs", Path::new("C:\\Program Files\\Chan\\chan-desktop.exe"));
            assert!(cs.contains("set \"ARGV0=cs\"\r\n"));
            assert_ne!(s, cs);
        }

        #[test]
        fn posix_shim_sets_argv0_and_execs_forward_slash_target() {
            let s = posix_wrapper_script(
                "chan",
                Path::new("C:\\Program Files\\Chan\\chan-desktop.exe"),
            );
            assert!(s.starts_with("#!/bin/sh\n"));
            assert!(s.contains(POSIX_MARKER));
            assert!(s.contains("export ARGV0=chan\n"));
            assert!(s.contains("export CHAN_DESKTOP_HANDOFF=1\n"));
            // Backslashes become forward slashes so MSYS/Git BASH parses the
            // path; the whole script stays backslash-free.
            assert!(s.contains("exec \"C:/Program Files/Chan/chan-desktop.exe\" \"$@\"\n"));
            assert!(!s.contains('\\'));
            // LF endings (not the `.cmd`'s CRLF).
            assert!(!s.contains('\r'));
            // Distinct script per name.
            let cs = posix_wrapper_script("cs", Path::new("C:\\app\\chan-desktop.exe"));
            assert!(cs.contains("export ARGV0=cs\n"));
            assert_ne!(s, cs);
        }

        #[test]
        fn plan_shim_skips_foreign_posix_file() {
            let desired = posix_wrapper_script("chan", Path::new("C:\\app\\chan-desktop.exe"));
            // A user's own `chan` (no ownership marker) is never clobbered.
            assert_eq!(
                plan_shim(
                    &desired,
                    POSIX_OWNS,
                    Some("#!/bin/sh\nexec /usr/bin/chan \"$@\"\n")
                ),
                WrapperPlan::Skip,
            );
            // Absent -> write; ours-and-current -> skip.
            assert!(matches!(
                plan_shim(&desired, POSIX_OWNS, None),
                WrapperPlan::Write(_)
            ));
            assert_eq!(
                plan_shim(&desired, POSIX_OWNS, Some(&desired)),
                WrapperPlan::Skip
            );
        }

        #[test]
        fn plan_writes_when_absent_skips_foreign_rewrites_stale() {
            let target = Path::new("C:\\app\\chan-desktop.exe");
            let desired = wrapper_script("cs", target);
            assert!(matches!(
                plan_shim(&desired, WRAPPER_OWNS, None),
                WrapperPlan::Write(_)
            ));
            // No marker -> someone else's cs.cmd. Hands off.
            let foreign = "@echo off\r\nC:\\other\\cs.exe %*\r\n";
            assert_eq!(
                plan_shim(&desired, WRAPPER_OWNS, Some(foreign)),
                WrapperPlan::Skip
            );
            // Our wrapper, current -> skip.
            assert_eq!(
                plan_shim(&desired, WRAPPER_OWNS, Some(&desired)),
                WrapperPlan::Skip
            );
            // Our wrapper, but the exe moved (self-upgrade) -> rewrite.
            let stale = wrapper_script("cs", Path::new("C:\\old\\chan-desktop.exe"));
            assert!(matches!(
                plan_shim(&desired, WRAPPER_OWNS, Some(&stale)),
                WrapperPlan::Write(_)
            ));
        }

        #[test]
        fn path_append_is_idempotent_and_boundary_aware() {
            let dir = "C:\\Users\\me\\AppData\\Local\\chan\\bin";
            // Absent -> appended with a separator.
            assert_eq!(
                path_with_dir_appended("C:\\Windows;C:\\Windows\\System32", dir),
                Some(format!("C:\\Windows;C:\\Windows\\System32;{dir}"))
            );
            // Empty PATH -> just the dir.
            assert_eq!(path_with_dir_appended("", dir), Some(dir.to_string()));
            // Trailing ';' -> no doubled separator.
            assert_eq!(
                path_with_dir_appended("C:\\Windows;", dir),
                Some(format!("C:\\Windows;{dir}"))
            );
            // Already present (case-insensitive, trailing-slash tolerant) -> None.
            assert_eq!(
                path_with_dir_appended(
                    "c:\\users\\me\\appdata\\local\\chan\\bin\\;C:\\Windows",
                    dir
                ),
                None
            );
        }

        #[test]
        fn reg_query_parse_extracts_value_and_type() {
            let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    \
                Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\tools\r\n\r\n";
            assert_eq!(
                parse_reg_query_path(out),
                Some((
                    "%USERPROFILE%\\bin;C:\\tools".to_string(),
                    "REG_EXPAND_SZ".to_string()
                ))
            );
            // No Path value present.
            assert_eq!(
                parse_reg_query_path("HKEY_CURRENT_USER\\Environment\r\n"),
                None
            );
        }
    }
}

/// Other non-unix platforms (none ship today): no shim mechanism, nothing to
/// install.
#[cfg(not(any(unix, windows)))]
pub fn install_bin_shims() -> std::io::Result<u32> {
    Ok(0)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn classify_appimage_takes_precedence() {
        let appimage = PathBuf::from("/home/u/Chan.AppImage");
        // Even with a plausible exe, $APPIMAGE wins.
        assert_eq!(
            classify_install(
                Some(appimage.clone()),
                Some(PathBuf::from("/usr/bin/chan-desktop"))
            ),
            InstallKind::AppImage(appimage)
        );
    }

    #[test]
    fn classify_macos_app_bundle_is_symlink() {
        let exe = PathBuf::from("/Applications/Chan.app/Contents/MacOS/chan-desktop");
        assert_eq!(
            classify_install(None, Some(exe.clone())),
            InstallKind::Symlink(exe)
        );
    }

    #[test]
    fn classify_linux_system_install_is_symlink() {
        let exe = PathBuf::from("/usr/bin/chan-desktop");
        assert_eq!(
            classify_install(None, Some(exe.clone())),
            InstallKind::Symlink(exe)
        );
    }

    #[test]
    fn classify_dev_build_is_none() {
        // A cargo target dir is neither an .app bundle nor a /usr install.
        assert_eq!(
            classify_install(
                None,
                Some(PathBuf::from("/home/u/chan/target/debug/chan-desktop"))
            ),
            InstallKind::None
        );
        assert_eq!(classify_install(None, None), InstallKind::None);
    }

    #[test]
    fn classify_nix_store_install_is_none() {
        // The package output already contains chan/cs symlinks. Never create
        // mutable ~/.local/bin shims pointing into a particular store path.
        assert_eq!(
            classify_install(
                None,
                Some(PathBuf::from(
                    "/nix/store/abc123-chan-desktop-0.81.0/bin/chan-desktop"
                ))
            ),
            InstallKind::None
        );
    }

    #[test]
    fn wrapper_script_pins_argv0_and_quotes_path() {
        let s = wrapper_script("chan", Path::new("/home/u/Apps/Chan x86_64.AppImage"));
        assert!(s.starts_with("#!/usr/bin/env bash\n"));
        assert!(s.contains(WRAPPER_MARKER));
        // argv[0] forced to the name, AppImage path single-quoted (space-safe).
        assert!(s.contains("exec -a chan '/home/u/Apps/Chan x86_64.AppImage' \"$@\""));
        // The same target produces a distinct script per name.
        let cs = wrapper_script("cs", Path::new("/home/u/Apps/Chan x86_64.AppImage"));
        assert!(cs.contains("exec -a cs '/home/u/Apps/Chan x86_64.AppImage' \"$@\""));
        assert_ne!(s, cs);
    }

    #[test]
    fn shell_single_quote_escapes_embedded_quote() {
        assert_eq!(shell_single_quote(Path::new("/a/b")), "'/a/b'");
        assert_eq!(
            shell_single_quote(Path::new("/it's/here")),
            "'/it'\\''s/here'"
        );
    }

    #[test]
    fn wrapper_plan_writes_when_absent_and_skips_foreign() {
        let appimage = Path::new("/home/u/Chan.AppImage");
        assert!(matches!(
            plan_wrapper("cs", appimage, None),
            WrapperPlan::Write(_)
        ));
        // No marker -> someone else's cs. Hands off.
        let foreign = "#!/bin/sh\nexec /usr/local/bin/chan shell \"$@\"\n";
        assert_eq!(
            plan_wrapper("cs", appimage, Some(foreign)),
            WrapperPlan::Skip
        );
    }

    #[test]
    fn wrapper_plan_skips_current_and_rewrites_stale() {
        let appimage = Path::new("/home/u/Chan.AppImage");
        let current = wrapper_script("cs", appimage);
        assert_eq!(
            plan_wrapper("cs", appimage, Some(&current)),
            WrapperPlan::Skip
        );
        // Our wrapper, but the AppImage moved -> rewrite.
        let stale = wrapper_script("cs", Path::new("/old/Chan.AppImage"));
        assert!(matches!(
            plan_wrapper("cs", appimage, Some(&stale)),
            WrapperPlan::Write(_)
        ));
    }

    #[test]
    fn wrapper_plan_recognizes_an_older_marker_as_ours() {
        // A wrapper written by an earlier chan-desktop (different marker text)
        // is still ours to refresh, not orphaned as foreign.
        let appimage = Path::new("/home/u/Chan.AppImage");
        let old = "#!/usr/bin/env bash\n# chan-desktop cs wrapper\nexec -a cs '/old/Chan.AppImage' \"$@\"\n";
        assert!(matches!(
            plan_wrapper("cs", appimage, Some(old)),
            WrapperPlan::Write(_)
        ));
    }

    #[test]
    fn symlink_plan_links_when_absent() {
        let target = Path::new("/Applications/Chan.app/Contents/MacOS/chan-desktop");
        assert_eq!(plan_symlink(target, &Observed::Absent), SymAction::Link);
    }

    #[test]
    fn symlink_plan_skips_current_and_foreign_file() {
        let target = Path::new("/usr/bin/chan-desktop");
        assert_eq!(
            plan_symlink(target, &Observed::SymlinkTo(target.to_path_buf())),
            SymAction::Skip
        );
        // A real file (a user's standalone `chan` binary) is never clobbered.
        assert_eq!(plan_symlink(target, &Observed::NonSymlink), SymAction::Skip);
    }

    #[test]
    fn symlink_plan_relinks_our_stale_link_but_leaves_a_user_link() {
        let target = Path::new("/Applications/Chan.app/Contents/MacOS/chan-desktop");
        // Our own link, now stale (the .app moved) -> re-point.
        let stale = Observed::SymlinkTo(PathBuf::from("/old/Chan.app/Contents/MacOS/chan-desktop"));
        assert_eq!(plan_symlink(target, &stale), SymAction::Relink);
        // A user's `cs -> chan` (a standalone install) is foreign -> leave it.
        let user = Observed::SymlinkTo(PathBuf::from("/home/u/.local/bin/chan"));
        assert_eq!(plan_symlink(target, &user), SymAction::Skip);
    }
}
