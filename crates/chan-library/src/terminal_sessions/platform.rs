use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;

use portable_pty::{CommandBuilder, PtyPair, PtySize, PtySystem};

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

#[cfg(unix)]
fn fd_snapshot() -> Option<(u64, u64)> {
    let open = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
    let limit = nofile_limit()?;
    Some((open, limit))
}

#[cfg(not(unix))]
fn fd_snapshot() -> Option<(u64, u64)> {
    None
}

#[cfg(target_os = "linux")]
fn nofile_limit() -> Option<u64> {
    rustix::process::getrlimit(rustix::process::Resource::Nofile).current
}

#[cfg(target_os = "macos")]
fn nofile_limit() -> Option<u64> {
    rustix::process::getrlimit(rustix::process::Resource::Nofile).current
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
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

pub(super) fn command_builder(command: Option<&str>) -> CommandBuilder {
    let command = command.map(str::trim).filter(|command| !command.is_empty());
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

/// The user's default Windows terminal shell, resolved once and cached.
#[cfg(windows)]
pub(super) struct WindowsShell {
    program: PathBuf,
    kind: WinShellKind,
}

/// How the resolved Windows shell takes its interactive / one-shot arguments.
#[cfg(windows)]
#[derive(Clone, Copy)]
enum WinShellKind {
    /// `powershell.exe` / `pwsh.exe`: `-NoLogo` interactive, `-NoLogo -Command`
    /// one-shot. No `-NoProfile` -- we want the user's profile/PATH (the `-l`
    /// analog of the unix login shell).
    PowerShell,
    /// `cmd.exe`: no args interactive, `/C` one-shot.
    Cmd,
    /// Any other shell a user points `CHAN_SHELL` at (a POSIX `sh`/`bash`,
    /// including a Git BASH they install themselves): `-l` / `-lc`, matching the
    /// unix login-shell convention.
    Posix,
}

#[cfg(windows)]
impl WindowsShell {
    fn build(&self, command: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        match (self.kind, command) {
            (WinShellKind::PowerShell, None) => {
                cmd.arg("-NoLogo");
            }
            (WinShellKind::PowerShell, Some(c)) => {
                cmd.args(["-NoLogo", "-Command", c]);
            }
            (WinShellKind::Cmd, None) => {}
            (WinShellKind::Cmd, Some(c)) => {
                cmd.args(["/C", c]);
            }
            (WinShellKind::Posix, None) => {
                cmd.arg("-l");
            }
            (WinShellKind::Posix, Some(c)) => {
                cmd.args(["-lc", c]);
            }
        }
        cmd
    }
}

/// Resolve the user's default Windows shell once and cache it for the process
/// lifetime -- resolution shells out (`where pwsh`), and a terminal spawn is on
/// the interactive path.
#[cfg(windows)]
pub(super) fn windows_shell() -> &'static WindowsShell {
    static CACHE: std::sync::OnceLock<WindowsShell> = std::sync::OnceLock::new();
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
#[cfg(windows)]
fn classify_windows_shell(program: &Path) -> WinShellKind {
    let stem = program
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match stem.as_str() {
        "pwsh" | "powershell" => WinShellKind::PowerShell,
        "cmd" => WinShellKind::Cmd,
        _ => WinShellKind::Posix,
    }
}

/// Resolve the Windows shell, first match wins:
///   1. `CHAN_SHELL` (verbatim path/name; arg convention inferred from the stem).
///   2. `pwsh.exe` (PowerShell 7) if on PATH.
///   3. `powershell.exe` (Windows PowerShell 5, in-box on every supported Windows).
///   4. `%ComSpec%` / `cmd.exe`.
#[cfg(windows)]
fn resolve_windows_shell() -> WindowsShell {
    use std::process::Command;

    // 1. Explicit override.
    if let Some(raw) = std::env::var_os("CHAN_SHELL").filter(|v| !v.is_empty()) {
        let program = PathBuf::from(raw);
        let kind = classify_windows_shell(&program);
        return WindowsShell { program, kind };
    }

    // 2. PowerShell 7 (pwsh) if installed.
    if let Ok(output) = Command::new("where").arg("pwsh").output() {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
            {
                return WindowsShell {
                    program: PathBuf::from(path),
                    kind: WinShellKind::PowerShell,
                };
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
        return WindowsShell {
            program,
            kind: WinShellKind::PowerShell,
        };
    }

    // 4. %ComSpec% / cmd.exe -- the last-resort default.
    let comspec = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    WindowsShell {
        program: comspec,
        kind: WinShellKind::Cmd,
    }
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
