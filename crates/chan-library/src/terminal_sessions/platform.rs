use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;

use portable_pty::{CommandBuilder, PtyPair, PtySize, PtySystem};

use super::shell_profiles::ShellProfile;
#[cfg(windows)]
use super::shell_profiles::{ProfileSource, ShellKind};
use super::{CreateError, FdPressure};

const TERMINAL_FD_HEADROOM: u64 = 32;
pub(super) const TERMINAL_SESSION_FD_ESTIMATE: u64 = 8;

/// Attempts per `openpty`, counting the first one. The darwin retries sleep
/// 10/20/40/80 ms between attempts, so a persistent refusal costs 150 ms
/// before it surfaces, and a genuinely exhausted pty pool still fails.
const OPENPTY_ATTEMPTS: u32 = 5;
const OPENPTY_RETRY_FLOOR: Duration = Duration::from_millis(10);

/// Open the session PTY, absorbing the darwin pty allocator's transient
/// refusal. On macOS `openpty` fails with ENXIO ("Device not configured")
/// both when the pool is exhausted (`kern.tty.ptmx_max`) and transiently
/// under concurrent open/close churn, where the very next attempt succeeds.
/// The NOFILE guard cannot cover this: it is a kernel pty-table refusal, not
/// process fd pressure. A bounded retry separates the two honestly: churn is
/// absorbed within a beat, exhaustion keeps failing and still surfaces as
/// the spawn error.
pub(super) fn openpty_absorbing_transient_refusal(
    pty_system: &dyn PtySystem,
    size: PtySize,
) -> anyhow::Result<PtyPair> {
    retry_transient_openpty(|| pty_system.openpty(size), std::thread::sleep)
}

fn retry_transient_openpty<T>(
    mut open: impl FnMut() -> anyhow::Result<T>,
    mut sleep: impl FnMut(Duration),
) -> anyhow::Result<T> {
    let mut delay = OPENPTY_RETRY_FLOOR;
    for _ in 1..OPENPTY_ATTEMPTS {
        match open() {
            Ok(pair) => return Ok(pair),
            Err(err) if is_transient_openpty_refusal(&err) => {
                sleep(delay);
                delay *= 2;
            }
            Err(err) => return Err(err),
        }
    }
    open()
}

/// portable-pty formats the errno into the message text
/// (`bail!("failed to openpty: {:?}", io::Error::last_os_error())`), so ENXIO
/// is only recoverable from that text; `code: 6` is ENXIO on darwin. A missed
/// match simply skips the retry and returns the error exactly as before, so
/// the coupling to portable-pty's wording can only fail toward today's
/// behavior.
#[cfg(target_os = "macos")]
fn is_transient_openpty_refusal(err: &anyhow::Error) -> bool {
    let message = format!("{err:#}");
    message.contains("failed to openpty") && message.contains("code: 6,")
}

/// Only darwin's pty allocator refuses transiently; elsewhere an `openpty`
/// error is real and retrying it would only delay the report.
#[cfg(not(target_os = "macos"))]
fn is_transient_openpty_refusal(_err: &anyhow::Error) -> bool {
    false
}

pub(super) fn reject_terminal_spawn_if_fd_pressure() -> Result<(), CreateError> {
    let Some((open, limit)) = fd_snapshot() else {
        return Ok(());
    };
    if fd_headroom_allows(open, limit, TERMINAL_SESSION_FD_ESTIMATE) {
        return Ok(());
    }
    Err(CreateError::FdPressure(FdPressure {
        open,
        limit,
        required: TERMINAL_SESSION_FD_ESTIMATE + TERMINAL_FD_HEADROOM,
    }))
}

pub(super) fn fd_headroom_allows(open: u64, limit: u64, new_fds: u64) -> bool {
    open.saturating_add(new_fds)
        .saturating_add(TERMINAL_FD_HEADROOM)
        < limit
}

#[cfg(all(unix, not(target_os = "freebsd")))]
fn fd_snapshot() -> Option<(u64, u64)> {
    let open = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
    let limit = nofile_limit()?;
    Some((open, limit))
}

/// FreeBSD publishes `/dev/fd` as a devfs stub holding `0`, `1`, `2` unless
/// `fdescfs` is mounted over it, so the entry count is a constant 3 whatever
/// the process actually holds. Counting that would tell the terminal guard it
/// has permanent clear headroom, which is a worse answer than admitting there
/// is no probe. `chan_workspace::fd_budget` carries the same guard for the
/// index side.
#[cfg(target_os = "freebsd")]
fn fd_snapshot() -> Option<(u64, u64)> {
    if !dev_fd_lists_open_descriptors() {
        return None;
    }
    let open = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
    let limit = nofile_limit()?;
    Some((open, limit))
}

/// Whether `/dev/fd` reflects this process's descriptors. Holding a descriptor
/// the listing has to show separates `fdescfs` from the stub: the stub answers
/// with the three standard entries and nothing else, while under `fdescfs` the
/// probe descriptor and `read_dir`'s own handle are both listed. Resolved once.
#[cfg(target_os = "freebsd")]
fn dev_fd_lists_open_descriptors() -> bool {
    use std::sync::OnceLock;
    static LIVE: OnceLock<bool> = OnceLock::new();
    *LIVE.get_or_init(|| {
        let Ok(probe) = std::fs::File::open("/dev/null") else {
            return false;
        };
        let seen = std::fs::read_dir("/dev/fd")
            .map(|entries| entries.count())
            .unwrap_or(0);
        drop(probe);
        seen > STUB_DEV_FD_ENTRIES
    })
}

/// `0`, `1`, `2`: what bare devfs publishes under `/dev/fd`.
#[cfg(target_os = "freebsd")]
const STUB_DEV_FD_ENTRIES: usize = 3;

#[cfg(not(unix))]
fn fd_snapshot() -> Option<(u64, u64)> {
    None
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
fn nofile_limit() -> Option<u64> {
    rustix::process::getrlimit(rustix::process::Resource::Nofile).current
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))
))]
fn nofile_limit() -> Option<u64> {
    None
}

pub(super) fn path_inside_root(path: &Path, root: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path == root || path.starts_with(root)
}

#[cfg(target_os = "linux")]
pub(super) fn process_cwd(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
pub(super) fn process_cwd(pid: u32) -> Option<PathBuf> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

/// True when the requested or inherited environment already selects a UTF-8
/// codeset, following the standard LC_ALL > LC_CTYPE > LANG precedence. The
/// per-session overrides win over the server's own environment. When this is
/// false the spawned shell would fall back to the POSIX/C codeset and render
/// multibyte UTF-8 as raw bytes in pagers / editors like `less` and `vim`.
pub(super) fn locale_selects_utf8(requested: &BTreeMap<String, String>) -> bool {
    let lookup = |key: &str| -> Option<String> {
        requested
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .filter(|value| !value.is_empty())
    };
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Some(value) = lookup(key) {
            let value = value.to_ascii_lowercase();
            return value.contains("utf-8") || value.contains("utf8");
        }
    }
    false
}

/// Resolve the user's shell the same way an interactive terminal does:
/// `$SHELL` (when it points at an executable) → the passwd `pw_shell` →
/// `/bin/sh`. Single-sources the resolution so no caller hardcodes a fallback
/// shell. This is exactly `portable_pty`'s `new_default_prog().get_shell()`,
/// which performs and validates that lookup -- reuse it rather than hand-rolling
/// `getpwuid`. Unix-only: `get_shell` is unix-only, and the Windows terminal
/// path is Git BASH, which never calls this.
#[cfg(unix)]
pub fn user_shell() -> String {
    CommandBuilder::new_default_prog().get_shell()
}

/// Build the spawn command for a terminal.
///
/// `profile` names an explicit shell (a picker selection); `None` keeps the
/// historical behaviour of spawning the machine's single default shell. The
/// default path is unchanged on both platforms -- on Windows it still reads the
/// warm [`windows_shell`] `OnceLock`, on unix it still defers to
/// `portable_pty`'s own `$SHELL` resolution -- so adding the parameter does not
/// move the default.
pub(super) fn command_builder(
    profile: Option<&ShellProfile>,
    command: Option<&str>,
) -> CommandBuilder {
    let command = command.map(str::trim).filter(|command| !command.is_empty());
    if let Some(profile) = profile {
        return profile.build(command);
    }
    #[cfg(windows)]
    {
        windows_shell().build(command)
    }
    #[cfg(not(windows))]
    {
        match command {
            // No command: the user's default interactive shell, exactly as
            // before (portable_pty resolves $SHELL / the passwd entry).
            None => CommandBuilder::new_default_prog(),
            // One-shot: run it through a login shell so profile-exported PATH
            // (where `cs` lives) is in scope. The shell is resolved via
            // `user_shell` ($SHELL → passwd → /bin/sh, validated) -- single-sourced
            // with the interactive path above, never a hardcoded `/bin/sh`.
            Some(command) => {
                let mut cmd = CommandBuilder::new(user_shell());
                cmd.args(["-lc", command]);
                cmd
            }
        }
    }
}

/// Resolve the user's default Windows shell once and cache it for the process
/// lifetime -- resolution shells out (`where pwsh`), and a terminal spawn is on
/// the interactive path.
///
/// This caches the single *default*; [`shell_profiles::shell_profiles`] caches
/// the enumeration of every shell on the machine. Both exist: a request that
/// names no profile must stay as cheap as it was.
#[cfg(windows)]
pub(super) fn windows_shell() -> &'static ShellProfile {
    static CACHE: std::sync::OnceLock<ShellProfile> = std::sync::OnceLock::new();
    CACHE.get_or_init(resolve_windows_shell)
}

/// Force the [`windows_shell`] cache to resolve eagerly, off the async request
/// path. Resolution may shell out (`where pwsh`) with blocking
/// `std::process::Command`; resolving it lazily on the first terminal create  --
/// which runs on a tokio worker (the embedded server hosts the SPA, API, and WS
/// on one runtime) -- would block that worker and freeze the SPA. The server
/// primes this once on a blocking thread at startup, so [`windows_shell`] only
/// ever reads the warm `OnceLock`.
// `pub` (not `pub(crate)`) because chan-server's route layer calls it
// cross-crate to prime the cache at server startup.
#[cfg(windows)]
pub fn prime_windows_shell() {
    let _ = windows_shell();
}

/// Classify a shell program by its file stem so a `CHAN_SHELL` override gets the
/// right argument convention. Unknown stems are treated as POSIX (`-lc`), which
/// is the useful fallback for a user who points `CHAN_SHELL` at a `bash`/`sh`.
///
/// `wsl` is called out explicitly and must not fall through to POSIX: `-l` to
/// `wsl.exe` means "list distributions", so a POSIX-classified `wsl.exe` prints
/// a distro list and exits instead of opening a shell.
#[cfg(windows)]
fn classify_windows_shell(program: &Path) -> ShellKind {
    ShellKind::from_program_stem(program)
}

/// A default-resolution profile for a bare program path: interactive args come
/// from the kind, and it is marked [`ProfileSource::Discovered`] because
/// nothing user-authored produced it.
#[cfg(windows)]
fn default_profile(id: &str, name: &str, program: PathBuf, kind: ShellKind) -> ShellProfile {
    ShellProfile {
        id: id.to_string(),
        name: name.to_string(),
        program,
        args: kind.default_interactive_args(),
        kind,
        path_prepend: Vec::new(),
        source: ProfileSource::Discovered,
    }
}

/// Resolve the Windows shell, first match wins:
///   1. `CHAN_SHELL` (verbatim path/name; arg convention inferred from the stem).
///   2. `pwsh.exe` (PowerShell 7) if on PATH.
///   3. `powershell.exe` (Windows PowerShell 5, in-box on every supported Windows).
///   4. `%ComSpec%` / `cmd.exe`.
#[cfg(windows)]
fn resolve_windows_shell() -> ShellProfile {
    use std::process::Command;

    // 1. Explicit override.
    if let Some(raw) = std::env::var_os("CHAN_SHELL").filter(|v| !v.is_empty()) {
        let program = PathBuf::from(raw);
        let kind = classify_windows_shell(&program);
        let name = program
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("CHAN_SHELL")
            .to_string();
        return default_profile("chan-shell", &name, program, kind);
    }

    // 2. PowerShell 7 (pwsh) if installed.
    if let Ok(output) = Command::new("where").arg("pwsh").output() {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
            {
                return default_profile(
                    "pwsh",
                    "PowerShell",
                    PathBuf::from(path),
                    ShellKind::PowerShell,
                );
            }
        }
    }

    // 3. Windows PowerShell 5, the in-box default. Prefer the full System32
    //    path so a modified PATH can't shadow it; fall back to the bare name.
    let powershell = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(|root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.is_file());
    if let Some(program) = powershell {
        return default_profile(
            "windows-powershell",
            "Windows PowerShell",
            program,
            ShellKind::PowerShell,
        );
    }

    // 4. %ComSpec% / cmd.exe -- the last-resort default.
    let comspec = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    default_profile("cmd", "Command Prompt", comspec, ShellKind::Cmd)
}

pub(crate) fn set_mcp_env(cmd: &mut CommandBuilder, socket_path: &std::path::Path) {
    let Some(socket) = socket_path.to_str() else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(exe) = exe.to_str() else {
        return;
    };
    let argv_json = serde_json::json!([exe, "__mcp-proxy", socket]).to_string();
    let server_json = serde_json::json!({
        "name": "chan",
        "command": exe,
        "args": ["__mcp-proxy", socket],
    })
    .to_string();

    cmd.env("CHAN_MCP_SERVER_NAME", "chan");
    cmd.env("CHAN_MCP_SOCKET", socket);
    cmd.env("CHAN_MCP_COMMAND", format!("{exe} __mcp-proxy {socket}"));
    cmd.env("CHAN_MCP_COMMAND_JSON", argv_json);
    cmd.env("CHAN_MCP_SERVER_JSON", server_json);
}

pub(super) fn clear_mcp_env(cmd: &mut CommandBuilder) {
    for key in [
        "CHAN_MCP_SERVER_NAME",
        "CHAN_MCP_SOCKET",
        "CHAN_MCP_COMMAND",
        "CHAN_MCP_COMMAND_JSON",
        "CHAN_MCP_SERVER_JSON",
        "CHAN_TAB_GROUP",
        "CHAN_WINDOW_ID",
        "CHAN_CONTROL_SOCKET",
        "CHAN_WORKSPACE_NAME",
        "CHAN_WORKSPACE_PATH",
    ] {
        cmd.env_remove(key);
    }
}

/// Keys the AppImage runtime and linuxdeploy's GTK hook invent whose value
/// holds no mount path, so the value scan in [`scrub_var`] cannot see them.
/// `GDK_BACKEND` pins GTK children to X11, which drops every GTK app launched
/// from a terminal onto XWayland; `ARGV0` is read ahead of `argv[0]` by
/// `chan_shell::invoked_arg0`, so an inherited copy misnames a re-exec'd chan.
const APPIMAGE_OPAQUE_KEYS: &[&str] = &[
    "APPIMAGE",
    "APPIMAGE_GTK_THEME",
    "ARGV0",
    "GDK_BACKEND",
    "GTK_THEME",
    "OWD",
];

/// Search paths the runtime prepends its own entries to rather than inventing
/// outright. These are filtered entry by entry, never dropped: removing `PATH`
/// would leave the shell unable to resolve a command at all.
const APPIMAGE_PREPENDED_KEYS: &[&str] = &["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"];

/// What scrubbing one variable does to it.
#[derive(Debug, PartialEq, Eq)]
enum Scrub {
    /// Drop the key: it exists only to point at the bundle.
    Remove,
    /// Keep the key, minus the entries that pointed at the bundle.
    Rewrite(OsString),
}

/// Whether any `PATH`-style entry of `value` resolves inside the mount.
/// Splitting before comparing keeps the match component-aware, so a second
/// AppImage whose mount id merely starts with this one's is not mistaken for
/// part of this bundle.
fn entry_in_bundle(appdir: &Path, value: &OsStr) -> bool {
    std::env::split_paths(value).any(|entry| entry.starts_with(appdir))
}

/// Plan the scrub for one variable, or `None` to leave it alone. Pure, so the
/// treatment split is unit-tested without mutating this process's environment.
///
/// Matching on the value rather than on a list of names is what keeps this
/// honest across a Tauri or linuxdeploy bump: a plugin that starts exporting
/// some new bundle-scoped key is caught the day it appears, with no list here
/// to forget to update. Only the keys whose value hides the mount need naming.
fn scrub_var(appdir: &Path, key: &str, value: &OsStr) -> Option<Scrub> {
    if APPIMAGE_PREPENDED_KEYS.contains(&key) {
        let mut dropped = false;
        let kept: Vec<PathBuf> = std::env::split_paths(value)
            .filter(|entry| {
                let keep = !entry.starts_with(appdir);
                dropped |= !keep;
                keep
            })
            .collect();
        if !dropped {
            return None;
        }
        // Nothing left means the runtime created the variable outright (it
        // does this for LD_LIBRARY_PATH on hosts that had none), so the host
        // state to restore is "unset", not "empty" -- an empty LD_LIBRARY_PATH
        // is not the same thing to the loader.
        return Some(match std::env::join_paths(kept) {
            Ok(joined) if !joined.is_empty() => Scrub::Rewrite(joined),
            _ => Scrub::Remove,
        });
    }
    if APPIMAGE_OPAQUE_KEYS.contains(&key) || entry_in_bundle(appdir, value) {
        return Some(Scrub::Remove);
    }
    None
}

/// Strip the AppImage bundle environment from a terminal spawn.
///
/// The type-2 runtime and linuxdeploy's GTK hook redirect a wide set of
/// loader and toolkit variables into the ephemeral `/tmp/.mount_*` squashfs.
/// The GUI process needs them, because WebKit and GTK dlopen out of that mount
/// long after startup, but a shell must not inherit them: it would run system
/// binaries against the bundle's older libraries, resolve `xdg-open` out of the
/// bundle, and hand a `PYTHONHOME` with no stdlib to anything embedding CPython.
/// AppImage documents no mechanism for recovering what the runtime overwrote,
/// so the host environment is reconstructed here rather than restored.
///
/// No-op off an AppImage: `$APPDIR` and `$APPIMAGE` are set only by that
/// runtime, so the dev binary, the macOS bundle, and the deb/rpm install never
/// enter the branch.
pub(super) fn clear_appimage_env(cmd: &mut CommandBuilder) {
    let Some(appdir) = std::env::var_os("APPDIR").filter(|dir| !dir.is_empty()) else {
        return;
    };
    if std::env::var_os("APPIMAGE").is_none_or(|path| path.is_empty()) {
        return;
    }
    let appdir = PathBuf::from(appdir);
    for (key, value) in std::env::vars_os() {
        let Some(key) = key.to_str() else {
            continue;
        };
        match scrub_var(&appdir, key, &value) {
            Some(Scrub::Remove) => cmd.env_remove(key),
            Some(Scrub::Rewrite(filtered)) => cmd.env(key, filtered),
            None => {}
        }
    }
}

pub(crate) fn terminal_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact message shape portable-pty's unix `openpty` produces, which
    /// is the only place the errno survives (see
    /// [`is_transient_openpty_refusal`]).
    fn openpty_error(errno: i32) -> anyhow::Error {
        anyhow::anyhow!(
            "failed to openpty: {:?}",
            std::io::Error::from_raw_os_error(errno)
        )
    }

    #[test]
    fn openpty_first_success_never_sleeps() {
        let mut slept = Vec::new();
        let value = retry_transient_openpty(|| Ok(7), |delay| slept.push(delay)).unwrap();
        assert_eq!(value, 7);
        assert!(slept.is_empty(), "slept: {slept:?}");
    }

    #[test]
    fn openpty_non_transient_failure_reports_on_the_first_attempt() {
        let mut attempts = 0;
        let mut slept = Vec::new();
        // EMFILE is real fd pressure on every platform: never retried.
        let err = retry_transient_openpty(
            || -> anyhow::Result<()> {
                attempts += 1;
                Err(openpty_error(24))
            },
            |delay| slept.push(delay),
        )
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert!(slept.is_empty(), "slept: {slept:?}");
        assert!(err.to_string().contains("failed to openpty"), "got: {err}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn openpty_transient_enxio_is_absorbed() {
        let mut attempts = 0;
        let mut slept = Vec::new();
        let value = retry_transient_openpty(
            || {
                attempts += 1;
                if attempts <= 2 {
                    Err(openpty_error(rustix::io::Errno::NXIO.raw_os_error()))
                } else {
                    Ok("pair")
                }
            },
            |delay| slept.push(delay),
        )
        .unwrap();
        assert_eq!(value, "pair");
        assert_eq!(attempts, 3);
        assert_eq!(
            slept,
            vec![Duration::from_millis(10), Duration::from_millis(20)]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn openpty_persistent_enxio_fails_after_bounded_attempts() {
        let mut attempts = 0;
        let mut slept = Vec::new();
        let err = retry_transient_openpty(
            || -> anyhow::Result<()> {
                attempts += 1;
                Err(openpty_error(rustix::io::Errno::NXIO.raw_os_error()))
            },
            |delay| slept.push(delay),
        )
        .unwrap_err();
        assert_eq!(attempts, OPENPTY_ATTEMPTS);
        assert_eq!(slept.len() as u32, OPENPTY_ATTEMPTS - 1);
        assert!(err.to_string().contains("code: 6,"), "got: {err}");
    }
}

#[cfg(test)]
mod appimage_env_tests {
    use super::{scrub_var, Scrub};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    const APPDIR: &str = "/tmp/.mount_chanAA";

    /// Build a search-path value the way the platform writes one, so these
    /// cases exercise the real separator instead of a hardcoded colon.
    fn joined(parts: &[&str]) -> OsString {
        std::env::join_paths(parts.iter().map(PathBuf::from)).expect("join test paths")
    }

    fn scrub(key: &str, value: &OsString) -> Option<Scrub> {
        scrub_var(Path::new(APPDIR), key, value)
    }

    #[test]
    fn prepended_key_keeps_host_entries_in_order() {
        let value = joined(&[
            "/tmp/.mount_chanAA/usr/bin",
            "/tmp/.mount_chanAA/usr/sbin",
            "/usr/local/bin",
            "/usr/bin",
        ]);
        assert_eq!(
            scrub("PATH", &value),
            Some(Scrub::Rewrite(joined(&["/usr/local/bin", "/usr/bin"]))),
        );
    }

    #[test]
    fn prepended_key_is_unset_when_every_entry_was_the_bundle() {
        // The runtime creates LD_LIBRARY_PATH outright on a host that had
        // none, so the host state to restore is unset rather than empty.
        let value = joined(&[
            "/tmp/.mount_chanAA/usr/lib",
            "/tmp/.mount_chanAA/usr/lib/x86_64-linux-gnu",
        ]);
        assert_eq!(scrub("LD_LIBRARY_PATH", &value), Some(Scrub::Remove));
    }

    #[test]
    fn prepended_key_without_bundle_entries_is_left_alone() {
        let value = joined(&["/usr/local/bin", "/usr/bin"]);
        assert_eq!(scrub("PATH", &value), None);
    }

    #[test]
    fn sibling_mount_whose_id_extends_this_one_is_not_the_bundle() {
        // Mount ids share a prefix whenever two AppImages of related names are
        // open at once. Matching on path components rather than on the raw
        // string keeps the other app's entries out of this scrub.
        let value = joined(&["/tmp/.mount_chanAAB/usr/bin", "/usr/bin"]);
        assert_eq!(scrub("PATH", &value), None);

        let opaque = OsString::from("/tmp/.mount_chanAAB/usr/lib/loaders.cache");
        assert_eq!(scrub("GDK_PIXBUF_MODULE_FILE", &opaque), None);
    }

    #[test]
    fn unnamed_key_pointing_into_the_bundle_is_removed() {
        // No list here names GST_PLUGIN_SYSTEM_PATH or whatever a future
        // linuxdeploy plugin exports; the value is what condemns them.
        let value = joined(&["/tmp/.mount_chanAA/usr/lib/gstreamer-1.0"]);
        assert_eq!(scrub("GST_PLUGIN_SYSTEM_PATH", &value), Some(Scrub::Remove));

        let future = OsString::from("/tmp/.mount_chanAA/usr/share/some-new-thing");
        assert_eq!(
            scrub("SOME_FUTURE_PLUGIN_DIR", &future),
            Some(Scrub::Remove)
        );
    }

    #[test]
    fn trailing_separator_does_not_hide_a_bundle_entry() {
        // PYTHONPATH and PERLLIB are both exported with a trailing separator.
        let value = joined(&["/tmp/.mount_chanAA/usr/share/pyshared", ""]);
        assert_eq!(scrub("PYTHONPATH", &value), Some(Scrub::Remove));
    }

    #[test]
    fn opaque_key_is_removed_though_its_value_hides_the_mount() {
        assert_eq!(
            scrub("GDK_BACKEND", &OsString::from("x11")),
            Some(Scrub::Remove),
        );
        assert_eq!(
            scrub("GTK_THEME", &OsString::from("Adwaita:light")),
            Some(Scrub::Remove),
        );
    }

    #[test]
    fn host_variables_survive_untouched() {
        assert_eq!(scrub("HOME", &OsString::from("/home/user")), None);
        assert_eq!(scrub("EDITOR", &OsString::from("vim")), None);
        assert_eq!(scrub("TERM", &OsString::from("xterm-256color")), None);
    }
}
