use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
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

/// Open the session PTY with the platform's contention handling. On macOS
/// `openpty` fails with ENXIO ("Device not configured")
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
    retry_transient_openpty(|| openpty_once(pty_system, size), std::thread::sleep)
}

/// FreeBSD's `openpty` calls the non-thread-safe `ptsname`, whose static buffer
/// can be overwritten by another concurrent call before the slave is opened.
/// Both callers can then receive the same slave, and the second child's
/// `TIOCSCTTY` fails with EPERM. The returned descriptors are independent, so
/// only the libc call needs serialization.
#[cfg(target_os = "freebsd")]
fn openpty_once(pty_system: &dyn PtySystem, size: PtySize) -> anyhow::Result<PtyPair> {
    static OPENPTY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = OPENPTY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pty_system.openpty(size)
}

#[cfg(not(target_os = "freebsd"))]
fn openpty_once(pty_system: &dyn PtySystem, size: PtySize) -> anyhow::Result<PtyPair> {
    pty_system.openpty(size)
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
/// match skips the retry and returns the `openpty` error unchanged, so a change
/// in portable-pty's wording can only cost the retry, never the error.
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
    locale_selects_utf8_on(requested, super::ENV_KEYS_IGNORE_CASE)
}

/// [`locale_selects_utf8`], with a requested key matched as a child's
/// environment matches keys when `ignore_case`.
pub(super) fn locale_selects_utf8_on(
    requested: &BTreeMap<String, String>,
    ignore_case: bool,
) -> bool {
    let lookup = |key: &str| -> Option<String> {
        super::env_value(requested, key, ignore_case)
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
/// `profile` names an explicit shell (a picker selection); `None` spawns the
/// machine's single default shell. On Windows the default reads the warm
/// [`windows_shell`] `OnceLock`; on unix it uses `portable_pty`'s own `$SHELL`
/// resolution.
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
            // No command: the user's default interactive shell
            // (portable_pty resolves $SHELL / the passwd entry).
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

/// The MCP discovery entries a spawn with MCP env opted in hands its child,
/// or `None` when the socket path or chan's own executable path is not UTF-8.
pub(super) fn mcp_env(socket_path: &std::path::Path) -> Option<[(&'static str, String); 5]> {
    let socket = socket_path.to_str()?;
    let exe = std::env::current_exe().ok()?;
    let exe = exe.to_str()?;
    let argv_json = serde_json::json!([exe, "__mcp-proxy", socket]).to_string();
    let server_json = serde_json::json!({
        "name": "chan",
        "command": exe,
        "args": ["__mcp-proxy", socket],
    })
    .to_string();
    Some([
        ("CHAN_MCP_SERVER_NAME", "chan".to_string()),
        ("CHAN_MCP_SOCKET", socket.to_string()),
        ("CHAN_MCP_COMMAND", format!("{exe} __mcp-proxy {socket}")),
        ("CHAN_MCP_COMMAND_JSON", argv_json),
        ("CHAN_MCP_SERVER_JSON", server_json),
    ])
}

/// Keys the AppImage runtime sets for every process it starts, whose value
/// holds no mount path, so the value scan in [`scrub_var`] cannot see them.
/// `ARGV0` is read ahead of `argv[0]` by `chan_shell::invoked_arg0`, so an
/// inherited copy misnames a re-exec'd chan. A child that is itself an
/// AppImage process gets each of them again from its own runtime.
const APPIMAGE_RUNTIME_KEYS: &[&str] = &["APPIMAGE", "ARGV0", "OWD"];

/// Keys linuxdeploy's GTK hook reads or sets whose value holds no mount path.
/// A terminal's GTK apps must not inherit them: `GDK_BACKEND` pins GTK
/// children to X11, which drops every GTK app launched from a terminal onto
/// XWayland, and `GTK_THEME` is the bundle's theme. A child AppImage process
/// keeps them, since its own hook reads `APPIMAGE_GTK_THEME` as the user's
/// override and sets `GTK_THEME` again, and a `GDK_BACKEND` the hook no
/// longer sets is the user's.
const APPIMAGE_GTK_KEYS: &[&str] = &["APPIMAGE_GTK_THEME", "GDK_BACKEND", "GTK_THEME"];

/// Who is handed the environment the user had before a chan AppImage process
/// started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum HostEnvFor {
    /// A terminal's shell or command.
    Terminal,
    /// Another AppImage process of chan's, whose own runtime and GTK hook
    /// build the AppImage's environment again on top of the user's.
    AppImage,
}

/// Search paths the runtime prepends its own entries to rather than inventing
/// outright. Its AppRun writes each as its block of mount entries, then a
/// separator, then the value the user had, empty when there was none, so the
/// user's value is exactly what follows the last mount entry ([`host_value`]).
/// They are rewritten to that value, never dropped while it holds anything:
/// removing `PATH` would leave the shell unable to resolve a command at all.
/// Two keys AppRun writes look alike and are not here, so the value scan drops
/// them whole: the GTK hook sets `GSETTINGS_SCHEMA_DIR` outright, losing the
/// user's value before AppRun prepends to it, and AppRun follows its
/// `GST_PLUGIN_SYSTEM_PATH` and `GST_PLUGIN_SYSTEM_PATH_1_0` entries with the
/// user's `QT_PLUGIN_PATH`, not their own value.
const APPIMAGE_PREPENDED_KEYS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
];

/// The host entry linuxdeploy's GTK hook writes right after its own mount
/// entry, ahead of the user's value: `$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS`.
const GTK_HOOK_XDG_DATA_DIR: &str = "/usr/share";

/// What scrubbing one variable does to it.
#[derive(Debug, Clone, PartialEq, Eq)]
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
fn scrub_var(appdir: &Path, key: &str, value: &OsStr, to: HostEnvFor) -> Option<Scrub> {
    if APPIMAGE_PREPENDED_KEYS.contains(&key) {
        let entries: Vec<PathBuf> = std::env::split_paths(value).collect();
        let host = host_value(appdir, key, &entries)?;
        // Nothing left, or the lone empty entry AppRun's separator leaves
        // when the user had no value, means the runtime created the variable
        // outright (it does this for LD_LIBRARY_PATH and XDG_DATA_DIRS on
        // hosts that had none), so the host state to restore is "unset", not
        // empty: the loader reads an empty entry as the current directory.
        return Some(match std::env::join_paths(host) {
            Ok(joined) if !joined.is_empty() => Scrub::Rewrite(joined),
            _ => Scrub::Remove,
        });
    }
    if to == HostEnvFor::AppImage && APPIMAGE_GTK_KEYS.contains(&key) {
        return None;
    }
    if APPIMAGE_RUNTIME_KEYS.contains(&key)
        || APPIMAGE_GTK_KEYS.contains(&key)
        || entry_in_bundle(appdir, value)
    {
        return Some(Scrub::Remove);
    }
    None
}

/// The entries of a prepended key the user had: those after its last entry
/// inside the mount, or after the last whole AppRun block of another mount
/// ([`last_apprun_block`]) when that comes later, or `None` when there is
/// neither (the value is the user's as it stands). Whatever comes before is
/// not the user's: the runtime's own block, and what chan prepended to it
/// afterwards, the host library directory the AppImage's GUI-stack re-exec
/// puts first in `LD_LIBRARY_PATH` among them. Everything after it is the
/// user's value as they wrote it, an empty entry of theirs included. For
/// `XDG_DATA_DIRS` the GTK hook's [`GTK_HOOK_XDG_DATA_DIR`] directly after the
/// mount entries is the hook's too.
fn host_value<'a>(appdir: &Path, key: &str, entries: &'a [PathBuf]) -> Option<&'a [PathBuf]> {
    let own = entries.iter().rposition(|entry| entry.starts_with(appdir));
    let last = own.max(last_apprun_block(key, entries))?;
    let host = &entries[last + 1..];
    Some(match host.split_first() {
        Some((first, rest))
            if key == "XDG_DATA_DIRS" && first.as_path() == Path::new(GTK_HOOK_XDG_DATA_DIR) =>
        {
            rest
        }
        _ => host,
    })
}

/// AppRun's block for `key`: the entries it writes ahead of the user's value,
/// each one directory of its mount followed by these suffixes in this order
/// (its format strings, and for `XDG_DATA_DIRS` the GTK hook's entry after
/// its own). Empty for a key whose block is a lone entry, which a user's own
/// entry could match.
fn apprun_block(key: &str) -> &'static [&'static str] {
    match key {
        "LD_LIBRARY_PATH" => &[
            "/usr/lib/",
            "/usr/lib/i386-linux-gnu/",
            "/usr/lib/x86_64-linux-gnu/",
            "/usr/lib32/",
            "/usr/lib64/",
            "/lib/",
            "/lib/i386-linux-gnu/",
            "/lib/x86_64-linux-gnu/",
            "/lib32/",
            "/lib64/",
        ],
        "PATH" => &["/usr/bin/", "/usr/sbin/", "/usr/games/", "/bin/", "/sbin/"],
        "XDG_DATA_DIRS" => &["/usr/share/", "/usr/share"],
        "PERLLIB" => &["/usr/share/perl5/", "/usr/lib/perl5/"],
        "QT_PLUGIN_PATH" => &[
            "/usr/lib/qt4/plugins/",
            "/usr/lib/i386-linux-gnu/qt4/plugins/",
            "/usr/lib/x86_64-linux-gnu/qt4/plugins/",
            "/usr/lib32/qt4/plugins/",
            "/usr/lib64/qt4/plugins/",
            "/usr/lib/qt5/plugins/",
            "/usr/lib/i386-linux-gnu/qt5/plugins/",
            "/usr/lib/x86_64-linux-gnu/qt5/plugins/",
            "/usr/lib32/qt5/plugins/",
            "/usr/lib64/qt5/plugins/",
        ],
        _ => &[],
    }
}

/// The index of the last entry of the last whole AppRun block of `key` in
/// `entries`, under any one directory other than the root. A chan process of
/// an older release that starts the AppImage again hands the child its own
/// environment, so the child's search paths hold that process's block after
/// the child's own, and in FUSE mode that block names another mount, gone
/// once its process exits. A user does not write a whole block: every one of
/// its entries, in AppRun's order, with its trailing separators.
fn last_apprun_block(key: &str, entries: &[PathBuf]) -> Option<usize> {
    let block = apprun_block(key);
    let len = block.len();
    if len < 2 || entries.len() < len {
        return None;
    }
    (len - 1..entries.len()).rev().find(|&end| {
        let run = &entries[end + 1 - len..=end];
        let Some(dir) = run[0]
            .to_str()
            .and_then(|first| first.strip_suffix(block[0]))
        else {
            return false;
        };
        dir.len() > 1
            && dir.starts_with('/')
            && run.iter().zip(block).all(|(entry, suffix)| {
                entry
                    .to_str()
                    .is_some_and(|entry| entry == format!("{dir}{suffix}"))
            })
    })
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
    for (key, scrub) in appimage_host_env(std::env::vars_os(), HostEnvFor::Terminal) {
        match scrub {
            Scrub::Remove => cmd.env_remove(key),
            Scrub::Rewrite(value) => cmd.env(key, value),
        }
    }
}

/// What turns `vars`, a process's environment, back into the one the user
/// had before the chan AppImage process it belongs to started, for `to`:
/// each variable the AppImage runtime, its GTK hook or chan put there, with
/// what to do to it. Empty when `vars` is no AppImage process's: `$APPDIR`
/// and `$APPIMAGE` are set only by that runtime, so the dev binary, the macOS
/// bundle and the deb/rpm install hand their environment on unchanged.
fn appimage_host_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    to: HostEnvFor,
) -> Vec<(String, Scrub)> {
    let vars: Vec<(OsString, OsString)> = vars.into_iter().collect();
    let value_of = |name: &str| {
        vars.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
            .filter(|value| !value.is_empty())
    };
    let (Some(appdir), Some(_)) = (value_of("APPDIR"), value_of("APPIMAGE")) else {
        return Vec::new();
    };
    let appdir = PathBuf::from(appdir);
    vars.iter()
        .filter_map(|(key, value)| {
            let key = key.to_str()?;
            Some((key.to_string(), scrub_var(&appdir, key, value, to)?))
        })
        .collect()
}

/// Give `cmd`, which starts chan's AppImage again (a New Window sibling, a
/// desktop a command starts, the devserver daemon, a relaunch), the
/// environment the user had before `parent`, this process's environment, was
/// built: its search paths as the user had them and none of this mount's
/// entries, so the child's own runtime adds exactly one block of its own on
/// top. A parent that is no AppImage process changes nothing.
pub fn hand_appimage_host_env(
    cmd: &mut Command,
    parent: impl IntoIterator<Item = (OsString, OsString)>,
) {
    for (key, scrub) in appimage_host_env(parent, HostEnvFor::AppImage) {
        match scrub {
            Scrub::Remove => cmd.env_remove(key),
            Scrub::Rewrite(value) => cmd.env(key, value),
        };
    }
}

/// The value of `name` a process chan starts should get from `parent`, this
/// process's environment: as the user had it before chan's AppImage built
/// `parent` (`None` when they had none), or as `parent` has it off an
/// AppImage. For a value chan records for later processes, such as the
/// `PATH` of the devserver's systemd unit.
pub fn appimage_host_var(
    name: &str,
    parent: impl IntoIterator<Item = (OsString, OsString)>,
) -> Option<OsString> {
    let parent: Vec<(OsString, OsString)> = parent.into_iter().collect();
    let host = appimage_host_env(parent.iter().cloned(), HostEnvFor::AppImage);
    match host.into_iter().find(|(key, _)| key == name) {
        Some((_, Scrub::Remove)) => None,
        Some((_, Scrub::Rewrite(value))) => Some(value),
        None => parent
            .into_iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value),
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
    use super::{scrub_var, HostEnvFor, Scrub};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    const APPDIR: &str = "/tmp/.mount_chanAA";

    /// Build a search-path value the way the platform writes one, so these
    /// cases exercise the real separator instead of a hardcoded colon.
    fn joined(parts: &[&str]) -> OsString {
        std::env::join_paths(parts.iter().map(PathBuf::from)).expect("join test paths")
    }

    fn scrub(key: &str, value: &OsString) -> Option<Scrub> {
        scrub_var(Path::new(APPDIR), key, value, HostEnvFor::Terminal)
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

    /// Whatever comes before the last mount entry is the runtime's or
    /// chan's, wherever mount entries sit among the others.
    #[test]
    fn entries_before_the_last_mount_entry_are_not_the_users() {
        let value = joined(&[
            "/usr/lib/x86_64-linux-gnu",
            "/tmp/.mount_chanAA/usr/lib",
            "/opt/stray",
            "/tmp/.mount_chanAA/lib64",
            "/opt/a",
        ]);
        assert_eq!(
            scrub("LD_LIBRARY_PATH", &value),
            Some(Scrub::Rewrite("/opt/a".into())),
        );
    }

    /// The values exactly as the AppImage's AppRun writes them, with the
    /// `:` separator of its format strings, so only on unix, where AppImages
    /// run.
    /// A child AppImage process keeps the GTK hook's keys, which its own hook
    /// reads or sets again, and a terminal loses them; the runtime's keys go
    /// for both, since every AppImage process's runtime sets them again.
    #[test]
    fn a_child_appimage_keeps_the_gtk_keys_a_terminal_loses() {
        let appdir = Path::new(APPDIR);
        for key in ["GDK_BACKEND", "GTK_THEME", "APPIMAGE_GTK_THEME"] {
            let value = OsString::from("x11");
            assert_eq!(
                scrub_var(appdir, key, &value, HostEnvFor::Terminal),
                Some(Scrub::Remove),
                "{key}"
            );
            assert_eq!(
                scrub_var(appdir, key, &value, HostEnvFor::AppImage),
                None,
                "{key}"
            );
        }
        for key in ["APPIMAGE", "ARGV0", "OWD"] {
            let value = OsString::from("value");
            for to in [HostEnvFor::Terminal, HostEnvFor::AppImage] {
                assert_eq!(
                    scrub_var(appdir, key, &value, to),
                    Some(Scrub::Remove),
                    "{key} {to:?}"
                );
            }
        }
    }

    #[cfg(unix)]
    mod apprun_shapes {
        use super::super::{appimage_host_env, appimage_host_var, hand_appimage_host_env};
        use super::{scrub, HostEnvFor, Scrub, APPDIR};
        use std::ffi::{OsStr, OsString};

        /// The host library directory the AppImage's GUI-stack re-exec puts
        /// first in the desktop's `LD_LIBRARY_PATH`.
        const HOST_LIB: &str = "/usr/lib/x86_64-linux-gnu";

        /// A value as the AppImage's AppRun writes it: its mount entries, a
        /// separator, and the user's value, empty when there was none. The
        /// formats are AppRun.wrapped's and the GTK hook's, read from the
        /// AppImage and run in a throwaway AppDir.
        fn apprun(block: &[&str], user: &str) -> String {
            let block: Vec<String> = block
                .iter()
                .map(|entry| format!("{APPDIR}/{entry}"))
                .collect();
            format!("{}:{user}", block.join(":"))
        }

        fn apprun_ld(user: &str) -> String {
            apprun(
                &[
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
                ],
                user,
            )
        }

        /// The desktop's `LD_LIBRARY_PATH` once the re-exec put the host first.
        fn reexeced_ld(user: &str) -> OsString {
            OsString::from(format!("{HOST_LIB}:{}", apprun_ld(user)))
        }

        #[test]
        fn a_user_who_had_no_library_path_gets_none() {
            // The verifier's shell got `/usr/lib/x86_64-linux-gnu:`: the
            // re-exec's directory and the empty entry AppRun's separator leaves.
            assert_eq!(
                scrub("LD_LIBRARY_PATH", &reexeced_ld("")),
                Some(Scrub::Remove)
            );
            let no_reexec = OsString::from(apprun_ld(""));
            assert_eq!(scrub("LD_LIBRARY_PATH", &no_reexec), Some(Scrub::Remove));
        }

        #[test]
        fn a_user_who_had_a_library_path_gets_their_entries_in_order() {
            assert_eq!(
                scrub("LD_LIBRARY_PATH", &reexeced_ld("/opt/b/lib:/opt/a/lib")),
                Some(Scrub::Rewrite("/opt/b/lib:/opt/a/lib".into())),
            );
        }

        /// Everything after the mount entries is the value the user wrote, so an
        /// empty entry there is theirs and stays where they put it.
        #[test]
        fn an_empty_entry_the_user_wrote_stays_as_written() {
            for user in ["/opt/a::/opt/b", "/opt/a:", ":/opt/a"] {
                assert_eq!(
                    scrub("LD_LIBRARY_PATH", &reexeced_ld(user)),
                    Some(Scrub::Rewrite(user.into())),
                    "{user}"
                );
            }
        }

        /// The re-exec's directory is dropped by its place, ahead of the mount
        /// entries, not by its name: a user who named it gets it back, once.
        #[test]
        fn the_reexec_directory_goes_and_the_users_own_copy_stays() {
            assert_eq!(
                scrub("LD_LIBRARY_PATH", &reexeced_ld(HOST_LIB)),
                Some(Scrub::Rewrite(HOST_LIB.into())),
            );
        }

        /// The GTK hook writes `$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS`
        /// and AppRun prepends its own entry, so a user with no `XDG_DATA_DIRS`
        /// got `/usr/share:` back, losing the spec's default, and one with a
        /// value got `/usr/share` ahead of it.
        #[test]
        fn data_dirs_lose_the_hooks_entry_and_the_empty_one() {
            let xdg = |user: &str| {
                OsString::from(format!(
                    "{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:{user}"
                ))
            };
            assert_eq!(scrub("XDG_DATA_DIRS", &xdg("")), Some(Scrub::Remove));
            assert_eq!(
                scrub("XDG_DATA_DIRS", &xdg("/usr/local/share:/usr/share")),
                Some(Scrub::Rewrite("/usr/local/share:/usr/share".into())),
            );
        }

        /// `PATH` is always set, so AppRun's separator is followed by the user's
        /// own value and leaves no empty entry.
        #[test]
        fn path_gets_the_users_value() {
            let value = OsString::from(apprun(
                &["usr/bin/", "usr/sbin/", "usr/games/", "bin/", "sbin/"],
                "/usr/local/bin:/usr/bin",
            ));
            assert_eq!(
                scrub("PATH", &value),
                Some(Scrub::Rewrite("/usr/local/bin:/usr/bin".into())),
            );
        }

        /// AppRun writes `PYTHONPATH`, `PERLLIB` and `QT_PLUGIN_PATH` in the
        /// same shape as `LD_LIBRARY_PATH`, so a terminal gets the user's value
        /// of each, or none; `GSETTINGS_SCHEMA_DIR` and the GStreamer paths do
        /// not carry the user's own value after the mount entries and are
        /// dropped whole.
        #[test]
        fn the_other_apprun_paths_give_back_the_users_value() {
            let qt: Vec<String> = ["qt4", "qt5"]
                .iter()
                .flat_map(|qt| {
                    [
                        "usr/lib",
                        "usr/lib/i386-linux-gnu",
                        "usr/lib/x86_64-linux-gnu",
                        "usr/lib32",
                        "usr/lib64",
                    ]
                    .map(|lib| format!("{lib}/{qt}/plugins/"))
                })
                .collect();
            let qt: Vec<&str> = qt.iter().map(String::as_str).collect();
            for (key, block) in [
                ("PYTHONPATH", &["usr/share/pyshared/"][..]),
                ("PERLLIB", &["usr/share/perl5/", "usr/lib/perl5/"]),
                ("QT_PLUGIN_PATH", &qt),
            ] {
                assert_eq!(
                    scrub(key, &apprun(block, "/opt/mine").into()),
                    Some(Scrub::Rewrite("/opt/mine".into())),
                    "{key}"
                );
                assert_eq!(
                    scrub(key, &apprun(block, "").into()),
                    Some(Scrub::Remove),
                    "{key}"
                );
            }
            let schemas = format!(
                "{APPDIR}/usr/share/glib-2.0/schemas/:{APPDIR}//usr/share/glib-2.0/schemas"
            );
            assert_eq!(
                scrub("GSETTINGS_SCHEMA_DIR", &schemas.into()),
                Some(Scrub::Remove)
            );
            for key in ["GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0"] {
                // The user's QT_PLUGIN_PATH, which AppRun writes there.
                let gst = format!("{APPDIR}/usr/lib/gstreamer:/opt/qt");
                assert_eq!(scrub(key, &gst.into()), Some(Scrub::Remove), "{key}");
            }
        }

        /// A block of the given entries under `dir`, as AppRun writes it.
        fn block_under(dir: &str, block: &[&str]) -> String {
            block
                .iter()
                .map(|entry| format!("{dir}/{entry}"))
                .collect::<Vec<_>>()
                .join(":")
        }

        const LD_BLOCK: [&str; 10] = [
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
        ];

        /// What a parent of an older release hands down, which still reaches
        /// this release's terminal scrub: a desktop a CLI started holds the
        /// CLI's block after its own, and an own-process sibling holds its
        /// parent's re-exec directory and block after its own. In FUSE mode
        /// those blocks name another mount, so the own-mount rule alone kept
        /// them; a whole AppRun block under any directory is not the user's.
        #[test]
        fn an_older_parents_block_is_not_the_users() {
            let other = "/tmp/.mount_chanZZ";
            for user in ["", "/opt/a/lib"] {
                let want = if user.is_empty() {
                    Scrub::Remove
                } else {
                    Scrub::Rewrite(user.into())
                };
                let cold_start = format!(
                    "{HOST_LIB}:{}:{}:{user}",
                    block_under(APPDIR, &LD_BLOCK),
                    block_under(other, &LD_BLOCK)
                );
                let sibling = format!(
                    "{HOST_LIB}:{}:{HOST_LIB}:{}:{user}",
                    block_under(APPDIR, &LD_BLOCK),
                    block_under(other, &LD_BLOCK)
                );
                for value in [cold_start, sibling] {
                    assert_eq!(
                        scrub("LD_LIBRARY_PATH", &value.clone().into()),
                        Some(want.clone()),
                        "{value}"
                    );
                }
            }
            let path_block = ["usr/bin/", "usr/sbin/", "usr/games/", "bin/", "sbin/"];
            let path = format!(
                "{}:{}:/usr/local/bin:/usr/bin",
                block_under(APPDIR, &path_block),
                block_under(other, &path_block)
            );
            assert_eq!(
                scrub("PATH", &path.into()),
                Some(Scrub::Rewrite("/usr/local/bin:/usr/bin".into()))
            );
            let xdg = format!(
                "{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:\
                 {other}/usr/share/:{other}/usr/share:/usr/share:"
            );
            assert_eq!(scrub("XDG_DATA_DIRS", &xdg.into()), Some(Scrub::Remove));
        }

        /// Only a whole block counts: a user's entry that looks like one of
        /// its entries, or a block cut short, stays the user's.
        #[test]
        fn part_of_a_block_is_the_users() {
            let partial = format!(
                "{}:/opt/x/usr/lib/:/opt/x/usr/lib/i386-linux-gnu/:/opt/a",
                block_under(APPDIR, &LD_BLOCK)
            );
            assert_eq!(
                scrub("LD_LIBRARY_PATH", &partial.into()),
                Some(Scrub::Rewrite(
                    "/opt/x/usr/lib/:/opt/x/usr/lib/i386-linux-gnu/:/opt/a".into()
                ))
            );
        }

        fn apprun_path(user: &str) -> String {
            apprun(
                &["usr/bin/", "usr/sbin/", "usr/games/", "bin/", "sbin/"],
                user,
            )
        }

        /// A chan AppImage desktop's environment as its runtime, the GTK hook
        /// and the re-exec leave it, over a user's `PATH` and, when given,
        /// `LD_LIBRARY_PATH`.
        fn appimage_desktop(user_ld: Option<&str>) -> Vec<(OsString, OsString)> {
            let pair = |key: &str, value: String| (OsString::from(key), OsString::from(value));
            vec![
                pair("APPDIR", APPDIR.to_string()),
                pair("APPIMAGE", "/home/u/Applications/Chan.AppImage".into()),
                pair("ARGV0", "chan-desktop".into()),
                pair("OWD", "/home/u".into()),
                pair("HOME", "/home/u".into()),
                pair("PATH", apprun_path("/usr/local/bin:/usr/bin")),
                pair(
                    "LD_LIBRARY_PATH",
                    reexeced_ld(user_ld.unwrap_or("")).into_string().unwrap(),
                ),
                pair(
                    "XDG_DATA_DIRS",
                    format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:"),
                ),
                pair("GTK_PATH", format!("{APPDIR}//usr/lib/gtk-3.0")),
                pair("GDK_BACKEND", "x11".into()),
            ]
        }

        /// What a child AppImage process is handed: the user's search paths,
        /// none of the runtime's keys, nothing inside the parent's mount, and
        /// the GTK keys its own hook reads; a variable the AppImage did not
        /// touch is left to be inherited.
        #[test]
        fn a_child_appimage_gets_the_users_environment() {
            for (user_ld, ld) in [
                (None, None),
                (Some("/opt/a/lib"), Some(OsString::from("/opt/a/lib"))),
            ] {
                let host = appimage_host_env(appimage_desktop(user_ld), HostEnvFor::AppImage);
                let get = |name: &str| {
                    host.iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, scrub)| scrub.clone())
                };
                let rewrite = |value: &str| Some(Scrub::Rewrite(value.into()));
                assert_eq!(get("PATH"), rewrite("/usr/local/bin:/usr/bin"));
                assert_eq!(
                    get("LD_LIBRARY_PATH"),
                    Some(ld.map_or(Scrub::Remove, Scrub::Rewrite)),
                    "{user_ld:?}"
                );
                assert_eq!(get("XDG_DATA_DIRS"), Some(Scrub::Remove));
                for gone in ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "GTK_PATH"] {
                    assert_eq!(get(gone), Some(Scrub::Remove), "{gone}");
                }
                assert_eq!(get("GDK_BACKEND"), None, "the user's backend is kept");
                assert_eq!(get("HOME"), None, "an untouched variable is inherited");
            }
        }

        /// A parent that is no AppImage process, by `$APPDIR` and `$APPIMAGE`
        /// both, hands its environment on as it is.
        #[test]
        fn a_parent_that_is_no_appimage_hands_its_environment_on() {
            let mut env = appimage_desktop(Some("/opt/a/lib"));
            for drop in ["APPDIR", "APPIMAGE"] {
                let without: Vec<_> = env.iter().filter(|(key, _)| key != drop).cloned().collect();
                assert_eq!(
                    appimage_host_env(without, HostEnvFor::AppImage),
                    Vec::new(),
                    "{drop}"
                );
            }
            env.retain(|(key, _)| key != "APPDIR" && key != "APPIMAGE");
            let mut command = std::process::Command::new("/bin/true");
            hand_appimage_host_env(&mut command, env.clone());
            assert_eq!(command.get_envs().count(), 0, "nothing set or removed");
            assert_eq!(
                appimage_host_var("PATH", env),
                Some(OsString::from(apprun_path("/usr/local/bin:/usr/bin")))
            );
        }

        /// A command handed the host environment sets the user's values and
        /// removes the rest, and the single-variable read agrees with it.
        #[test]
        fn a_command_is_handed_the_users_values() {
            let mut command = std::process::Command::new("/bin/true");
            hand_appimage_host_env(&mut command, appimage_desktop(None));
            let env = |key: &str| {
                command
                    .get_envs()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.map(OsStr::to_os_string))
            };
            assert_eq!(
                env("PATH"),
                Some(Some(OsString::from("/usr/local/bin:/usr/bin")))
            );
            assert_eq!(env("LD_LIBRARY_PATH"), Some(None));
            assert_eq!(env("APPIMAGE"), Some(None));
            assert_eq!(env("GDK_BACKEND"), None);
            assert_eq!(
                appimage_host_var("PATH", appimage_desktop(None)),
                Some(OsString::from("/usr/local/bin:/usr/bin"))
            );
            assert_eq!(
                appimage_host_var("LD_LIBRARY_PATH", appimage_desktop(None)),
                None
            );
            assert_eq!(
                appimage_host_var("HOME", appimage_desktop(None)),
                Some(OsString::from("/home/u"))
            );
        }
    }
}
