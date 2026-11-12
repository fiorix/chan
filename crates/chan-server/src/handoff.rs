//! CLI-to-desktop workspace handoff over a well-known per-user endpoint:
//! a Unix-domain socket on unix, a named pipe on Windows.
//!
//! When chan-desktop is running and the user types `chan serve
//! ~/notes` in a terminal, the natural intent is "show me this workspace
//! in the app," not "fail because the desktop already holds the
//! per-workspace flock." This module is the same-user IPC channel that
//! makes that handoff possible.
//!
//! Discovery is a WELL-KNOWN per-user endpoint (not the per-pid socket
//! the mcp_bridge / control_socket use): the CLI must find the desktop
//! without knowing its pid. On unix, same-user is enforced by the socket
//! living in a per-user runtime dir with 0600 perms and owned by the
//! user; on Windows, the pipe's name carries the account's SID, so each
//! account has an endpoint of its own, and the endpoint's pipe and its claim
//! pipe grant that account alone, where the default named-pipe ACL would also
//! grant LocalSystem and Administrators. Any local user can still create a
//! pipe of the name first, so a client reads the account the pipe's server
//! runs as before it writes, and writes nothing to another account's.
//!
//! INVARIANT: exactly one process owns a workspace's writes (the
//! chan-workspace per-workspace flock). In a successful handoff the DESKTOP
//! owns the workspace; the CLI is a launcher that exits WITHOUT opening
//! the workspace. The CLI must therefore consult this module BEFORE it
//! calls `open_workspace`, so it never double-opens.
//!
//! Workspace handoff never carries a bearer token: by design the desktop spawns
//! its OWN native window against its OWN embedded server. Devserver registration
//! may carry a write-only bearer inside the URL as `?t=...`, matching the
//! launcher dialog and the devserver's printed URL. The protocol still carries a
//! version field so a desktop-vs-CLI skew falls back to standalone rather than
//! doing silent cross-version IPC.
//!
//! Reuses the control_socket.rs shape: line-delimited JSON request +
//! response and a Drop guard for teardown (unix unlinks the socket file;
//! a Windows named pipe vanishes with the process). The protocol/types
//! compile on every platform; the listener + client are implemented on
//! unix (UDS) and Windows (named pipe), the desktop's two targets.

use std::path::PathBuf;

#[cfg(unix)]
use crate::local_socket::{effective_uid, socket_is_owner_controlled};

use serde::{Deserialize, Serialize};
#[cfg(any(unix, windows))]
use std::path::Path;
#[cfg(any(unix, windows))]
use std::time::Duration;

/// Wire-protocol version. Bump on any incompatible change to the
/// request/response shape. The CLI and desktop compare this in the
/// handshake; a mismatch means NO handoff (fall back to standalone),
/// never a silent best-effort decode of an unknown shape.
pub const PROTOCOL_VERSION: u32 = 1;

/// Human-facing crate version, baked at compile time. Carried in the
/// handshake so the skew message can name concrete versions ("desktop
/// is X, CLI is Y"). Distinct from PROTOCOL_VERSION: two builds can
/// share a protocol while differing in crate version.
pub const CHAN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Capabilities the desktop advertises. Reserved for forward
/// compatibility: a request the desktop can't satisfy falls back to
/// standalone rather than erroring. Today the only capability is
/// opening a LOCAL workspace window; tunneled-workspace handoff is out of
/// scope (the CLI's `--tunnel-*` path already forces standalone).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capabilities {
    /// The desktop can open a local registry workspace in a native
    /// window. Always true for a desktop that speaks this protocol;
    /// the field exists so a future desktop can advertise FALSE (e.g.
    /// a headless build) and the CLI falls back cleanly.
    pub open_local_workspace: bool,
}

/// CLI -> desktop request. `tag = "type"` mirrors control_socket so
/// the on-wire shape is `{"type":"open_workspace", ...}`. Every variant
/// carries the `protocol` + `cli_version` handshake fields; the listener
/// checks `protocol` against its own PROTOCOL_VERSION before dispatching.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Ask the desktop to open the given workspace path in a native
    /// window.
    OpenWorkspace {
        protocol: u32,
        cli_version: String,
        /// The workspace root the CLI was asked to serve. The desktop first
        /// looks up the path as sent; if no workspace is mounted by that key,
        /// it registers the path through its local library before mounting.
        /// Sent as a string for stable JSON across platforms.
        workspace_path: String,
    },
    /// Ask the running desktop to drive its `tauri-plugin-updater`. With
    /// `check_only` the desktop reports whether an update is available and
    /// does not install; otherwise it kicks off check -> download -> install
    /// in the background (fire-and-return: the CLI gets `UpgradeStarted` at
    /// once, the desktop owns the progress + self-relaunch). This is how a
    /// `chan upgrade` from the desktop-dispatched `chan` binary updates the
    /// app instead of replacing a CLI tarball.
    Upgrade {
        protocol: u32,
        cli_version: String,
        check_only: bool,
    },
    /// Ask the desktop to register a devserver by URL -- the `chan devserver register {url}`
    /// handoff. The desktop writes the `{url, name, script}` entry into the same
    /// config its launcher devserver registry reads; the launcher's Connect
    /// button drives the dial (the CLI does not auto-connect). The CLI sends
    /// this from its `open` command; the desktop's listener handles it. A bearer
    /// may ride inside the URL as `?t=...`; the desktop extracts it into the
    /// write-only devserver registry token.
    OpenDevserver {
        protocol: u32,
        cli_version: String,
        /// The full devserver URL, scheme included.
        url: String,
        /// Optional user label for the launcher section header.
        name: Option<String>,
        /// Optional connect script run before the dial.
        script: Option<String>,
    },
    /// Ask the running desktop to tear down the workspace it serves at
    /// `workspace_path` -- the `chan close` / `chan workspace forget` handoff. The
    /// desktop stops serving the tenant and, with `remove`, unregisters it from
    /// its own library + overlay. Like the open handoff, this goes through the
    /// well-known socket because the per-pid control socket reaches the embedded
    /// host but CANNOT update the desktop's runtime map: a control-socket close
    /// leaves the launcher showing the workspace stale-on and a restart
    /// resurrects it.
    CloseWorkspace {
        protocol: u32,
        cli_version: String,
        /// The workspace root to stop serving. On a forget, a stored registry
        /// root names its row before symlinks are resolved; other paths and
        /// close use the desktop's resolved lookup. Sent as a string for
        /// stable JSON across platforms.
        workspace_path: String,
        /// `chan workspace forget`: also unregister the workspace from the
        /// desktop's library + overlay, not just stop serving it.
        remove: bool,
    },
    /// Ask the desktop for its devserver registry rows -- the
    /// `chan devserver ls` handoff. Read-only; the reply carries one
    /// summary per row, gateway-roster rows included (marked, since
    /// register/forget cannot touch those).
    ListDevservers { protocol: u32, cli_version: String },
    /// Ask the desktop to dial a registered devserver -- the
    /// `chan devserver connect` handoff. Fire-and-return like `Upgrade`:
    /// the desktop starts the connect (control script, token scrape,
    /// dial) and answers `DevserverConnectStarted` at once; sign-in or
    /// trust prompts surface in the launcher, which owns the progress.
    ConnectDevserver {
        protocol: u32,
        cli_version: String,
        /// A registered URL or launcher label; the desktop resolves it
        /// against its persisted rows and refuses ambiguity.
        target: String,
    },
    /// Ask the desktop to drop its connection to a registered devserver --
    /// the `chan devserver disconnect` handoff. The row is kept and the
    /// remote process keeps running; an already-disconnected row is a
    /// no-op success.
    DisconnectDevserver {
        protocol: u32,
        cli_version: String,
        /// A registered URL or launcher label, resolved like
        /// `ConnectDevserver`'s.
        target: String,
    },
    /// Ask the desktop to remove a devserver registration row -- the
    /// `chan devserver forget` handoff, the undo of `OpenDevserver`. A
    /// connected row is refused unless `force`, which disconnects and
    /// removes in one stroke via the registry's remove hook. The remote
    /// process keeps running either way; the row's write-only token is
    /// discarded with it.
    ForgetDevserver {
        protocol: u32,
        cli_version: String,
        /// A registered URL or launcher label, resolved like
        /// `ConnectDevserver`'s.
        target: String,
        /// Disconnect first when the row is live, instead of refusing.
        force: bool,
    },
    /// `chan workspace serve WS --on TARGET`: mount `workspace_path` (a path
    /// on that machine, passed verbatim) on a registered, connected devserver.
    /// Synchronous: the desktop answers once the devserver reports the mount,
    /// which is why this variant carries a longer reply budget than the
    /// devserver-registry verbs.
    ServeRemoteWorkspace {
        protocol: u32,
        cli_version: String,
        /// A registered URL or launcher label, resolved like
        /// `ConnectDevserver`'s.
        target: String,
        /// The workspace root on the devserver's machine.
        workspace_path: String,
    },
    /// `chan workspace close WS --on TARGET`: unmount the workspace on that
    /// devserver and keep it registered there. Live terminals refuse, as the
    /// devserver's own guard does; the reply is `CloseRefused`.
    CloseRemoteWorkspace {
        protocol: u32,
        cli_version: String,
        target: String,
        workspace_path: String,
    },
    /// `chan workspace forget WS --on TARGET`: unmount and drop the
    /// registration on that devserver. Same live-terminal refusal.
    ForgetRemoteWorkspace {
        protocol: u32,
        cli_version: String,
        target: String,
        workspace_path: String,
    },
    /// A `chan-term` launch that runs the user's shell (xdg-terminal-exec
    /// with no command): open a throwaway standalone terminal window whose
    /// first terminal starts in `cwd`. The window is never saved, so a relaunch
    /// does not restore it. The desktop answers `TerminalOpened` once the
    /// window is minted, or `Error` (a shutdown in progress, a `cwd` outside
    /// its filesystem surface), and the launcher then opens its own window.
    OpenTerminal {
        protocol: u32,
        cli_version: String,
        /// The absolute start directory. Sent as a string for stable JSON
        /// across platforms.
        cwd: String,
    },
    /// A second desktop launch found this endpoint held: come forward as a
    /// Dock click does, raising the last focused window or opening a
    /// standalone terminal when none shows. The sender then exits, so a user
    /// never has two desktops opening every window twice. The handshake
    /// field `cli_version` carries the launching desktop's version. A
    /// desktop shutting down answers `Error`; one that predates this request
    /// answers `Error` for its unknown type.
    Activate { protocol: u32, cli_version: String },
    /// Open `path` as `cs open PATH` does in a standalone window: reuse or
    /// mint a standalone window, raise it, and open a directory in the file
    /// browser, a text file in the editor, reveal any other file, or create a
    /// missing one empty. A launch given paths sends one per path; the desktop
    /// answers `PathOpened`, or `Error` (a shutdown in progress, a path it
    /// cannot open there). One that predates this request answers `Error` for
    /// its unknown type.
    OpenPath {
        protocol: u32,
        cli_version: String,
        /// The absolute path. Sent as a string for stable JSON across
        /// platforms.
        path: String,
    },
}

impl Request {
    /// The handshake protocol version carried by any request variant.
    pub fn protocol(&self) -> u32 {
        match self {
            Request::OpenWorkspace { protocol, .. }
            | Request::Upgrade { protocol, .. }
            | Request::OpenDevserver { protocol, .. }
            | Request::CloseWorkspace { protocol, .. }
            | Request::ListDevservers { protocol, .. }
            | Request::ConnectDevserver { protocol, .. }
            | Request::DisconnectDevserver { protocol, .. }
            | Request::ForgetDevserver { protocol, .. }
            | Request::ServeRemoteWorkspace { protocol, .. }
            | Request::CloseRemoteWorkspace { protocol, .. }
            | Request::ForgetRemoteWorkspace { protocol, .. }
            | Request::OpenTerminal { protocol, .. }
            | Request::Activate { protocol, .. }
            | Request::OpenPath { protocol, .. } => *protocol,
        }
    }

    /// The CLI's human version, for skew logging.
    pub fn cli_version(&self) -> &str {
        match self {
            Request::OpenWorkspace { cli_version, .. }
            | Request::Upgrade { cli_version, .. }
            | Request::OpenDevserver { cli_version, .. }
            | Request::CloseWorkspace { cli_version, .. }
            | Request::ListDevservers { cli_version, .. }
            | Request::ConnectDevserver { cli_version, .. }
            | Request::DisconnectDevserver { cli_version, .. }
            | Request::ForgetDevserver { cli_version, .. }
            | Request::ServeRemoteWorkspace { cli_version, .. }
            | Request::CloseRemoteWorkspace { cli_version, .. }
            | Request::ForgetRemoteWorkspace { cli_version, .. }
            | Request::OpenTerminal { cli_version, .. }
            | Request::Activate { cli_version, .. }
            | Request::OpenPath { cli_version, .. } => cli_version,
        }
    }

    /// How long a one-shot client waits for this request's reply once the
    /// connection is up. The devserver-registry verbs answer from memory and
    /// keep the 3 s window. A local close or forget allows the tenant-task
    /// grace, the workspace release wait, and 3 s for dispatch and the reply.
    /// The remote workspace arms wait on a devserver
    /// round-trip (a mount can take up to the server's own 60 s mount timeout,
    /// an unmount drains terminals with a bounded wait), so their budget sits
    /// above those timeouts and the server's error, not the client's
    /// deadline, is what the user sees.
    #[cfg(any(unix, windows))]
    pub fn reply_budget(&self) -> Duration {
        match self {
            Request::CloseWorkspace { .. } => {
                chan_library::tenant::TENANT_TASK_SHUTDOWN_GRACE
                    + chan_library::host::WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT
                    + Duration::from_secs(3)
            }
            Request::ServeRemoteWorkspace { .. } => Duration::from_secs(75),
            Request::CloseRemoteWorkspace { .. } | Request::ForgetRemoteWorkspace { .. } => {
                Duration::from_secs(30)
            }
            _ => Duration::from_millis(3000),
        }
    }
}

/// Desktop -> CLI response. `tag = "status"` mirrors
/// control_socket's `ControlResponse`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    /// The desktop accepted the request and is opening (or has
    /// raised) the workspace window. The CLI prints a short note and
    /// exits; the desktop owns the workspace lifecycle from here.
    Opened {
        desktop_version: String,
        capabilities: Capabilities,
    },
    /// The desktop speaks a different protocol version. The CLI does
    /// NOT hand off; it prints the skew and falls back to standalone.
    VersionSkew {
        desktop_version: String,
        desktop_protocol: u32,
    },
    /// The desktop could not open the workspace (e.g. a runtime error
    /// mounting it). The CLI logs the reason and falls back to
    /// standalone rather than leaving the user with nothing.
    Error { message: String },
    /// The desktop accepted an `Upgrade { check_only: false }` and kicked
    /// off the install in the background. The CLI prints a note and exits;
    /// the desktop owns the download/install/relaunch.
    UpgradeStarted { desktop_version: String },
    /// The desktop answered an `Upgrade { check_only: true }`: `available`
    /// is the announced version when an update exists, or `None` when the
    /// desktop is already current.
    UpgradeChecked {
        desktop_version: String,
        available: Option<String>,
    },
    /// The desktop registered (and is connecting) the devserver from an
    /// `OpenDevserver`. The CLI prints a note and exits; the desktop owns the
    /// devserver lifecycle from here.
    DevserverRegistered { desktop_version: String },
    /// The desktop tore down the workspace from a `CloseWorkspace` request
    /// (stopped serving it, and unregistered it when `remove`). The CLI
    /// reports the close once the workspace's writer lock is free. A skew or
    /// absent desktop falls back to the per-pid control socket. A
    /// still-releasing error exits 75 without local unregister; other errors
    /// fall back.
    Closed { desktop_version: String },
    /// The desktop serves no workspace at the root a `CloseWorkspace` named,
    /// and with `remove` holds no row for it. It is not a close: the CLI
    /// goes on to the writer lock's holder over its control socket, as it
    /// does with no desktop running, because another process (a standalone
    /// `chan serve`) may hold the workspace.
    NotServed { desktop_version: String },
    /// The desktop refused a `CloseWorkspace`, `CloseRemoteWorkspace`, or
    /// `ForgetRemoteWorkspace` request because unmount/remove would kill live
    /// terminal sessions. `error` is the devserver's own `live_terminals`
    /// literal.
    CloseRefused {
        error: String,
        active_terminals: usize,
    },
    /// The desktop's devserver registry rows, answering `ListDevservers`.
    Devservers {
        desktop_version: String,
        devservers: Vec<DevserverSummary>,
    },
    /// The desktop accepted a `ConnectDevserver` and is dialing in the
    /// background. The CLI prints a note and exits; the launcher owns
    /// sign-in, trust prompts, and the connect outcome.
    DevserverConnectStarted { desktop_version: String },
    /// The desktop dropped the connection from a `DisconnectDevserver`
    /// (or it was not connected). The row is kept.
    DevserverDisconnected { desktop_version: String },
    /// The desktop removed the registration row from a `ForgetDevserver`.
    DevserverForgotten { desktop_version: String },
    /// The devserver mounted the workspace from a `ServeRemoteWorkspace`
    /// (or already had it mounted); `prefix` is the route it serves at.
    RemoteWorkspaceServed {
        desktop_version: String,
        prefix: String,
    },
    /// The devserver unmounted the workspace from a `CloseRemoteWorkspace`
    /// and keeps it registered; `was_served` says whether it was mounted.
    RemoteWorkspaceClosed {
        desktop_version: String,
        was_served: bool,
    },
    /// The devserver dropped the workspace from a `ForgetRemoteWorkspace`.
    RemoteWorkspaceForgotten { desktop_version: String },
    /// The desktop minted the throwaway terminal window an `OpenTerminal`
    /// asked for; its window watcher opens it.
    TerminalOpened { desktop_version: String },
    /// The desktop took an `Activate`: it is raising its last focused
    /// window, or opening a standalone terminal when none shows.
    Activated { desktop_version: String },
    /// The desktop opened an `OpenPath`'s path in a standalone window and
    /// raised it. `message` is the line `cs open` prints for the same open:
    /// the path, the window, whether that window is still opening, and the
    /// workspace that holds the path when one does.
    PathOpened {
        desktop_version: String,
        message: String,
    },
}

impl Response {
    /// The desktop's answer to a `CloseWorkspace`, from its host's close or
    /// removal of the named root. A root the host does not serve answers
    /// `NotServed`, never `Closed`: the CLI reads `Closed` as the close done,
    /// and a standalone `chan serve` holding that root would keep running.
    pub fn from_close_outcome(
        outcome: Result<chan_library::WorkspaceLifecycleOutcome, String>,
    ) -> Self {
        use chan_library::WorkspaceLifecycleOutcome;
        match outcome {
            Ok(WorkspaceLifecycleOutcome::Completed) => Response::Closed {
                desktop_version: CHAN_VERSION.into(),
            },
            Ok(WorkspaceLifecycleOutcome::NotFound) => Response::NotServed {
                desktop_version: CHAN_VERSION.into(),
            },
            Ok(WorkspaceLifecycleOutcome::Refused { active_terminals }) => Response::CloseRefused {
                error: "live_terminals".into(),
                active_terminals,
            },
            Err(message) => Response::Error { message },
        }
    }
}

/// One devserver registry row as `chan devserver ls` renders it. A
/// deliberate summary rather than the launcher's full wire entry, so the
/// CLI surface does not inherit every launcher field as a contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevserverSummary {
    /// The dial URL, scheme included, as stored.
    pub url: String,
    /// The launcher section label; empty when the row has none.
    #[serde(default)]
    pub label: String,
    /// Live connection state as the launcher projects it:
    /// disconnected | connecting | connected.
    pub status: String,
    /// A gateway-roster row: listed for completeness, but register /
    /// connect / disconnect / forget cannot touch it (the Gateways
    /// screen manages it).
    #[serde(default)]
    pub gateway: bool,
}

/// Resolve the well-known per-user socket path. Prefers
/// `$XDG_RUNTIME_DIR/chan-desktop.sock` (a per-user dir the OS
/// already 0700s on Linux); falls back to
/// `<tmp>/chan-desktop-<uid>/chan-desktop.sock` on macOS, which has no
/// XDG_RUNTIME_DIR -- an owner-only DIRECTORY in the sticky world-writable
/// tmp, mirroring the devserver discovery dir, so a bare squattable node
/// never sits in shared /tmp. Pure path resolution: the desktop bind side
/// creates/validates the directory via [`ensure_well_known_socket_path`],
/// the client side validates it without creating it. The name is kept short
/// for the macOS `sun_path` 104-byte limit. Returns None on non-unix/windows.
pub fn well_known_socket_path() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            let dir = PathBuf::from(dir);
            if !dir.as_os_str().is_empty() {
                return Some(dir.join("chan-desktop.sock"));
            }
        }
        Some(unix_no_xdg_desktop_dir().join("chan-desktop.sock"))
    }
    #[cfg(windows)]
    {
        // Named pipes share one namespace for the whole machine, so the name
        // carries the account's SID, which no other account has, local or
        // domain; a user name cut to the characters a pipe name allows can be
        // another account's as well. The name is WELL-KNOWN (per account, not
        // per pid) so the CLI finds the desktop without its pid. An account
        // whose SID cannot be read has no endpoint.
        chan_winpipe::current_account_sid()
            .ok()
            .map(endpoint_for_account)
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// The Windows handoff endpoint of the account `sid`. A SID holds no `.`, so
/// no account's endpoint is another account's claim pipe ([`claim_pipe_name`]).
#[cfg(any(windows, test))]
fn endpoint_for_account(sid: &str) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\chan-desktop-{sid}"))
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // rustix is already a chan-server dep (terminal_sessions uses its
    // getrlimit); reuse it here rather than reaching for raw libc.
    rustix::process::getuid().as_raw()
}

/// The no-XDG desktop socket directory: `<tmp>/chan-desktop-<uid>`. Per-uid
/// name so two users cannot collide in a shared /tmp; the ensure/existing
/// pair below makes it owner-only by construction, like the devserver
/// discovery dir.
#[cfg(unix)]
fn unix_no_xdg_desktop_dir() -> PathBuf {
    std::env::temp_dir().join(format!("chan-desktop-{}", current_uid()))
}

/// Whether the well-known path lives in the no-XDG fallback dir this module
/// owns (as opposed to the OS-provisioned `$XDG_RUNTIME_DIR`).
#[cfg(unix)]
fn uses_no_xdg_desktop_dir() -> bool {
    std::env::var_os("XDG_RUNTIME_DIR").is_none_or(|dir| dir.is_empty())
}

/// Bind-side resolution of the well-known endpoint: on the unix no-XDG arm
/// this CREATES the owner-only socket directory, or refuses when another uid
/// owns the node. Only the desktop's listener calls this; clients must never
/// create the directory and only validate an existing one.
pub fn ensure_well_known_socket_path() -> Option<PathBuf> {
    #[cfg(unix)]
    if uses_no_xdg_desktop_dir() {
        ensure_owner_dir_at(&unix_no_xdg_desktop_dir()).ok()?;
    }
    well_known_socket_path()
}

/// Client-side resolution of the well-known endpoint: validates the no-XDG
/// directory (owner, dir-ness, 0700) WITHOUT creating it. `None` is the
/// ordinary no-desktop case; a squatted or foreign-owned directory also
/// resolves to `None` so no request bytes ever flow into it.
fn existing_well_known_socket_path() -> Option<PathBuf> {
    #[cfg(unix)]
    if uses_no_xdg_desktop_dir() {
        existing_owner_dir_at(&unix_no_xdg_desktop_dir()).ok()?;
    }
    well_known_socket_path()
}

/// Create-or-validate an owner-only directory: lstat first, atomic 0700
/// mkdir on NotFound, re-validate after (covering the AlreadyExists race),
/// and force perms back to 0700 only once ownership is proven. Mirrors the
/// devserver discovery dir's construction.
#[cfg(unix)]
fn ensure_owner_dir_at(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    match std::fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            if let Err(create_err) = builder.create(dir) {
                if create_err.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(create_err);
                }
            }
        }
        Err(e) => return Err(e),
    }

    let metadata = owner_dir_metadata(dir)?;
    if metadata.permissions().mode() & 0o777 != 0o700 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Validate-only twin of [`ensure_owner_dir_at`]: the directory must already
/// exist, be a real directory owned by this euid, and be exactly 0700.
#[cfg(unix)]
fn existing_owner_dir_at(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = owner_dir_metadata(dir)?;
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err(not_owner_controlled(dir));
    }
    Ok(())
}

#[cfg(unix)]
fn owner_dir_metadata(dir: &Path) -> std::io::Result<std::fs::Metadata> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(dir)?;
    if !metadata.file_type().is_dir() || metadata.uid() != effective_uid() {
        return Err(not_owner_controlled(dir));
    }
    Ok(metadata)
}

#[cfg(unix)]
fn not_owner_controlled(dir: &Path) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!(
            "desktop handoff directory {} is not an owner-controlled directory",
            dir.display()
        ),
    )
}

/// True when a GUI session is present, i.e. it makes sense to hand a
/// workspace to a desktop the user can actually see. On macOS the desktop
/// session is always present for an interactive login; the headless
/// signal we guard against is an SSH session with no display. On
/// Linux we additionally require DISPLAY or WAYLAND_DISPLAY.
///
/// Conservative by design: when unsure we return false so the CLI
/// keeps the load-bearing standalone behavior rather than handing a
/// workspace to a desktop nobody can see.
pub fn gui_session_present() -> bool {
    #[cfg(target_os = "macos")]
    {
        // A remote SSH login sets SSH_CONNECTION / SSH_TTY and has no
        // Aqua session the user can interact with; skip handoff there.
        if std::env::var_os("SSH_CONNECTION").is_some()
            || std::env::var_os("SSH_TTY").is_some()
            || std::env::var_os("SSH_CLIENT").is_some()
        {
            return false;
        }
        true
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if std::env::var_os("SSH_CONNECTION").is_some()
            || std::env::var_os("SSH_TTY").is_some()
            || std::env::var_os("SSH_CLIENT").is_some()
        {
            return false;
        }
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    }
    #[cfg(windows)]
    {
        // Windows is a GUI OS; an interactive (or RDP) session always has a
        // desktop the user can see. The hand-off still only proceeds if a
        // chan-desktop is actually running (try_handoff connects the pipe).
        true
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Explicit opt-out for automation: `CHAN_NO_DESKTOP_HANDOFF=1`
/// forces standalone even in a GUI session with a desktop running.
/// Any non-empty, non-"0" value counts as set.
pub fn handoff_opt_out() -> bool {
    match std::env::var("CHAN_NO_DESKTOP_HANDOFF") {
        Ok(v) => !v.is_empty() && v != "0",
        Err(_) => false,
    }
}

/// Force the CLI-to-desktop handoff ON for a `Standalone`-personality binary:
/// `CHAN_DESKTOP_HANDOFF=1`. The desktop-installed Windows shim sets this so the
/// bundled console `chan.exe` hands a `chan serve` off to the running desktop
/// exactly like the macOS/Linux desktop shim does via `Personality::Desktop`
/// (on those platforms the shim re-execs the desktop binary, so the personality
/// already carries the intent; on Windows the shim re-execs a separate
/// `chan.exe`, which is always `Standalone`, so it needs this explicit signal).
/// `CHAN_NO_DESKTOP_HANDOFF` still wins -- the opt-out is checked at the handoff
/// itself. Any non-empty, non-"0" value counts as set.
pub fn handoff_forced() -> bool {
    match std::env::var("CHAN_DESKTOP_HANDOFF") {
        Ok(v) => !v.is_empty() && v != "0",
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Desktop side: listener on the well-known socket.
// ---------------------------------------------------------------------------

/// The right to serve the well-known endpoint, taken apart from the bind so
/// a desktop can learn at the very start of its boot whether another desktop
/// serves the endpoint, and keep the right through the rest of its boot. On
/// unix it is the endpoint's flock (`take_stable_lock`). On Windows it is the
/// first instance of a pipe of its own beside the endpoint's, `<endpoint>.claim`,
/// which no other process can create while it exists and no client opens: a
/// pipe's first instance takes a client before anyone reads it, so the
/// endpoint's own pipe is created only when the listener starts, and a client
/// during the boot meets no pipe instead of one nobody reads. The pipe
/// namespace is one for the whole machine, so two sessions of one account
/// meet the same claim. It ends when the claim, or the listener started on
/// it, is dropped, and with the process.
#[derive(Debug)]
pub struct EndpointClaim {
    socket_path: PathBuf,
    #[cfg(unix)]
    lock: std::fs::File,
    #[cfg(windows)]
    claim_pipe: tokio::net::windows::named_pipe::NamedPipeServer,
}

/// Why [`claim_endpoint_at`] did not claim the endpoint.
#[derive(Debug)]
pub enum ClaimError {
    /// A live process of this account holds it.
    Held(std::io::Error),
    /// A process of another account holds the endpoint's name in a way this
    /// account cannot reach (on Windows, a claim pipe that refuses it
    /// access). That is no holder of this account's: no launch of this
    /// account can ask it to come forward, so the launch boots without the
    /// listener rather than exit beside it.
    Foreign(std::io::Error),
    /// The claim could not be tried: the runtime directory is missing or not
    /// the user's, the lock file cannot be opened, or the platform has no
    /// endpoint.
    Unavailable(std::io::Error),
}

impl std::fmt::Display for ClaimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaimError::Held(error)
            | ClaimError::Foreign(error)
            | ClaimError::Unavailable(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ClaimError {}

impl From<ClaimError> for std::io::Error {
    fn from(error: ClaimError) -> Self {
        match error {
            ClaimError::Held(error)
            | ClaimError::Foreign(error)
            | ClaimError::Unavailable(error) => error,
        }
    }
}

/// Claim the endpoint at `socket_path` (see [`EndpointClaim`]).
#[cfg(unix)]
pub fn claim_endpoint_at(socket_path: &Path) -> Result<EndpointClaim, ClaimError> {
    match crate::control_socket::take_stable_lock(socket_path) {
        Ok(lock) => Ok(EndpointClaim {
            socket_path: socket_path.to_path_buf(),
            lock,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(ClaimError::Held(error)),
        Err(error) => Err(ClaimError::Unavailable(error)),
    }
}

/// Claim the endpoint at `socket_path` (see [`EndpointClaim`]). The claim's
/// pipe registers with the tokio reactor, so this must be called from within
/// a tokio runtime, like [`start_listener`].
///
/// The claim is held when this account's claim pipe already has its one
/// instance. A claim pipe of the name that refuses this account access is
/// another account's, since this account's grants it full access: no holder
/// of this account's ([`ClaimError::Foreign`]). Nothing that holds this
/// account's claim serves the endpoint without it, so an endpoint pipe some
/// other process created first does not keep the claim from this launch; the
/// listener's first instance then fails on it, and the desktop runs without
/// its listener, keeping the claim.
#[cfg(windows)]
pub fn claim_endpoint_at(socket_path: &Path) -> Result<EndpointClaim, ClaimError> {
    // What CreateNamedPipe answers for a claim pipe that already has an
    // instance: pipe busy when the name is at its instance limit, which this
    // account's claim pipe of one instance always is, and access denied when
    // the pipe's security grants this account no instance of it.
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_PIPE_BUSY: i32 = 231;

    match create_claim_pipe(socket_path) {
        Ok(claim_pipe) => Ok(EndpointClaim {
            socket_path: socket_path.to_path_buf(),
            claim_pipe,
        }),
        Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => Err(ClaimError::Held(error)),
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            Err(ClaimError::Foreign(error))
        }
        Err(error) => Err(ClaimError::Unavailable(error)),
    }
}

/// Create the claim pipe of the endpoint at `socket_path`: the first, and
/// only, instance of `<endpoint>.claim`, inbound, which nothing reads, and
/// which grants this account alone.
#[cfg(windows)]
fn create_claim_pipe(
    socket_path: &Path,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    chan_winpipe::create_owner_only(
        tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .access_outbound(false)
            .max_instances(1),
        claim_pipe_name(socket_path),
    )
}

#[cfg(any(windows, test))]
fn claim_pipe_name(socket_path: &Path) -> std::ffi::OsString {
    let mut name = socket_path.as_os_str().to_owned();
    name.push(".claim");
    name
}

/// What the pipe directory says of an endpoint and its claim.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PipeListing {
    /// Neither pipe has an instance: no desktop.
    Absent,
    /// The claim pipe has an instance and the endpoint's pipe has none: a
    /// desktop that claimed the endpoint and has not started its listener,
    /// which is a desktop still booting.
    Booting,
    /// The endpoint's pipe has an instance: a listener serves it, or a
    /// process created a pipe of its name, which a client tells apart by the
    /// account the pipe's server runs as.
    Served,
    /// The listing could not be read. It is no reading of a boot: the
    /// guard's ask goes on as for a desktop that is up, and the CLI falls
    /// back as it does for no desktop, without saying one is starting.
    Unreadable,
}

#[cfg(any(windows, test))]
impl PipeListing {
    /// A desktop still booting, and nothing else: not an unreadable listing.
    fn booting(self) -> bool {
        self == PipeListing::Booting
    }
}

/// Read the endpoint at `socket_path` and its claim from the listing of
/// `\\.\pipe\`. Opening a pipe to find out would connect to an instance a
/// client is waiting for, or one a server would read from; a listing opens
/// none.
#[cfg(windows)]
fn endpoint_listing_at(socket_path: &Path) -> PipeListing {
    let name = |pipe: &std::ffi::OsStr| {
        pipe.to_str()
            .and_then(|pipe| pipe.strip_prefix(r"\\.\pipe\"))
            .map(str::to_ascii_lowercase)
    };
    let (Some(claim), Some(endpoint)) = (
        name(&claim_pipe_name(socket_path)),
        name(socket_path.as_os_str()),
    ) else {
        return PipeListing::Unreadable;
    };
    let listed = std::fs::read_dir(r"\\.\pipe\").and_then(|entries| {
        entries
            .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect()
    });
    classify_listing(&claim, &endpoint, listed)
}

/// [`PipeListing`] from the names in the pipe directory. Names compare
/// without case, as the pipe file system compares them; `claim` and
/// `endpoint` are lowercase.
#[cfg(any(windows, test))]
fn classify_listing(
    claim: &str,
    endpoint: &str,
    listed: std::io::Result<Vec<String>>,
) -> PipeListing {
    let Ok(listed) = listed else {
        return PipeListing::Unreadable;
    };
    let has = |wanted: &str| {
        listed
            .iter()
            .any(|name| name.to_ascii_lowercase() == wanted)
    };
    match (has(claim), has(endpoint)) {
        (_, true) => PipeListing::Served,
        (true, false) => PipeListing::Booting,
        (false, false) => PipeListing::Absent,
    }
}

/// Whether a desktop holds the claim of the endpoint at `socket_path` and
/// has not started its listener yet, which is a desktop still booting
/// ([`PipeListing::Booting`]; an unreadable listing is not). On unix the
/// claim is the flock beside the socket, and this reads false.
#[cfg(windows)]
pub fn endpoint_is_booting_at(socket_path: &Path) -> bool {
    endpoint_listing_at(socket_path).booting()
}

/// See the Windows arm.
#[cfg(not(windows))]
pub fn endpoint_is_booting_at(_socket_path: &std::path::Path) -> bool {
    false
}

/// [`endpoint_is_booting_at`] on this user's well-known endpoint: what the
/// CLI asks after a request found no desktop, so it can say that one is on
/// its way up instead of serving on its own without a word.
pub fn desktop_is_starting() -> bool {
    existing_well_known_socket_path().is_some_and(|path| endpoint_is_booting_at(&path))
}

#[cfg(not(any(unix, windows)))]
pub fn claim_endpoint_at(_socket_path: &std::path::Path) -> Result<EndpointClaim, ClaimError> {
    Err(ClaimError::Unavailable(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "handoff endpoint requires unix-domain sockets or windows named pipes",
    )))
}

/// Why [`start_claimed_listener`] did not start a listener. It hands the
/// claim back still held: a desktop that goes on without its listener keeps
/// the claim, since dropping it would let a second desktop claim the endpoint
/// and start beside the first.
#[derive(Debug)]
pub struct ListenerStartError {
    pub claim: EndpointClaim,
    pub error: std::io::Error,
}

impl std::fmt::Display for ListenerStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}

impl std::error::Error for ListenerStartError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

/// Drops the claim, for a caller that claimed only to start the listener.
impl From<ListenerStartError> for std::io::Error {
    fn from(failed: ListenerStartError) -> Self {
        failed.error
    }
}

/// Handle owning the handoff listener and the connections it has accepted.
/// [`shutdown`](Self::shutdown) stops accepting and lets those connections
/// finish their replies, within a bound; Drop aborts the accept loop, and
/// with it every connection still in flight, and unlinks the socket file,
/// mirroring control_socket / mcp_bridge. A `kill -9` that skips Drop leaves
/// a stale file; the next bind unlinks it first.
#[cfg(any(unix, windows))]
pub struct ListenerHandle {
    socket_path: PathBuf,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    accept_loop: Option<tokio::task::JoinHandle<()>>,
    /// Held until Drop has unlinked the socket, so another live process cannot
    /// take the stable path and then have this handle remove its node.
    #[cfg(unix)]
    _stable_lock: std::fs::File,
    /// The claim, held by the handle rather than by the accept loop, so an
    /// accept loop that stops while its desktop runs leaves the endpoint
    /// claimed.
    #[cfg(windows)]
    _claim: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(not(any(unix, windows)))]
pub struct ListenerHandle {
    socket_path: PathBuf,
}

impl ListenerHandle {
    pub fn socket_path(&self) -> &std::path::Path {
        &self.socket_path
    }
}

#[cfg(any(unix, windows))]
impl ListenerHandle {
    /// Stop accepting, give the connections already accepted up to 75
    /// seconds (`CONNECTION_DRAIN_TIMEOUT`) to deliver their replies, abort
    /// any still running, then unlink the socket.
    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(accept_loop) = self.accept_loop.take() {
            if let Err(error) = accept_loop.await {
                tracing::warn!(%error, "handoff accept loop did not stop cleanly");
            }
        }
    }
}

/// How long a stopping listener waits for accepted connections to deliver
/// their replies: the longest reply budget a handoff client holds,
/// [`Request::reply_budget`] for `ServeRemoteWorkspace`. A reply later than
/// that has no reader left, and a shorter bound would abort one a client is
/// still waiting for.
#[cfg(any(unix, windows))]
const CONNECTION_DRAIN_TIMEOUT: Duration = Duration::from_secs(75);

/// Wait up to `bound` for a stopped listener's accepted connections to
/// finish, then abort the rest and wait for them to unwind, so none outlives
/// the listener that accepted it.
#[cfg(any(unix, windows))]
pub(crate) async fn drain_connections(mut connections: tokio::task::JoinSet<()>, bound: Duration) {
    let drained = tokio::time::timeout(bound, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tracing::warn!(
            connections = connections.len(),
            "listener stop aborted connections still in flight"
        );
        connections.shutdown().await;
    }
}

#[cfg(any(unix, windows))]
impl Drop for ListenerHandle {
    fn drop(&mut self) {
        if let Some(h) = self.accept_loop.take() {
            h.abort();
        }
        // A Unix socket leaves a filesystem node to unlink; a Windows named
        // pipe vanishes when the owning process exits, so nothing to remove.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Bind the well-known socket and spawn an accept loop. Each connection
/// carries one `Request`; the desktop's `handler` returns the `Response` and
/// the connection closes. The listener applies the protocol-version gate
/// before calling `handler`, so the handler only ever sees protocol-valid
/// requests; a skew becomes `Response::VersionSkew` without invoking it.
///
/// `handler` is `async` because an `Upgrade` request drives
/// `tauri-plugin-updater`'s network check. `OpenWorkspace` work stays
/// effectively synchronous (the desktop queues the window spawn onto its app
/// handle and returns immediately).
///
/// The socket is chmod 0600 immediately after bind so only the owning user
/// can connect (defense in depth on top of the per-user directory). Must be
/// called from within a tokio runtime.
///
/// Claims the endpoint first and fails while a live process holds it, with
/// the error the claim met: `AddrInUse` on unix; on Windows the claim pipe's
/// pipe-busy error, its access-denied error for another account's claim
/// pipe, or the listener's own when another process created the endpoint's
/// pipe first. [`start_claimed_listener`] serves a claim taken earlier.
#[cfg(any(unix, windows))]
pub fn start_listener<F, Fut>(socket_path: PathBuf, handler: F) -> std::io::Result<ListenerHandle>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    start_claimed_listener(claim_endpoint_at(&socket_path)?, handler).map_err(Into::into)
}

/// [`start_listener`] on an endpoint this process already claimed.
#[cfg(unix)]
pub fn start_claimed_listener<F, Fut>(
    claim: EndpointClaim,
    handler: F,
) -> Result<ListenerHandle, ListenerStartError>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    start_listener_with_peer_uid(claim, handler, |stream| Ok(stream.peer_cred()?.uid()))
}

/// Unix listener with an injectable peer-uid resolver so the refusal boundary
/// can be tested without requiring a second account on the host.
#[cfg(unix)]
fn start_listener_with_peer_uid<F, Fut, U>(
    claim: EndpointClaim,
    handler: F,
    peer_uid: U,
) -> Result<ListenerHandle, ListenerStartError>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
    U: Fn(&tokio::net::UnixStream) -> std::io::Result<u32> + Send + Sync + 'static,
{
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    // Unlink any stale socket from a previous run that didn't clean up
    // (kill -9, panic in Drop) so bind doesn't EADDRINUSE.
    let _ = std::fs::remove_file(&claim.socket_path);
    let listener = match UnixListener::bind(&claim.socket_path) {
        Ok(listener) => listener,
        // The claim is taken apart only once the bind holds, so a failed
        // bind returns it with its lock.
        Err(error) => return Err(ListenerStartError { claim, error }),
    };
    let EndpointClaim {
        socket_path,
        lock: stable_lock,
    } = claim;
    // Lock the socket to the owning user. Best-effort: a chmod failure
    // (exotic fs) does not abort the listener, but the per-user
    // directory placement is the primary boundary anyway.
    let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));

    let handler = std::sync::Arc::new(handler);
    let peer_uid = std::sync::Arc::new(peer_uid);
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let accept_loop = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let accepted = tokio::select! {
                biased;
                _ = &mut stopped => break,
                _ = connections.join_next(), if !connections.is_empty() => continue,
                accepted = listener.accept() => accepted,
            };
            let (stream, _) = match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!("handoff accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let uid = match peer_uid(&stream) {
                Ok(uid) => uid,
                Err(e) => {
                    tracing::warn!(error = %e, "handoff peer credential check failed");
                    continue;
                }
            };
            let owner_uid = rustix::process::geteuid().as_raw();
            if uid != owner_uid {
                tracing::warn!(peer_uid = uid, owner_uid, "handoff peer uid refused");
                continue;
            }
            let handler = handler.clone();
            connections.spawn(async move {
                let (read, write) = stream.into_split();
                serve_connection(read, write, handler.as_ref()).await;
            });
        }
        // Closing the listener refuses new peers while accepted ones finish.
        drop(listener);
        drain_connections(connections, CONNECTION_DRAIN_TIMEOUT).await;
    });

    Ok(ListenerHandle {
        socket_path,
        stop: Some(stop),
        accept_loop: Some(accept_loop),
        _stable_lock: stable_lock,
    })
}

/// Windows: the same handoff protocol over a named pipe (the cross-platform
/// transport chan already uses for the `cs` control socket). Mirrors the
/// control_socket accept loop: hold one idle pipe instance and, on each client
/// connect, swap in a FRESH instance BEFORE handing the connected one to a task,
/// so a client arriving during the swap still finds a live server instance.
/// Same per-connection framing (read one JSON line -> `dispatch` -> write one
/// JSON line) as the unix arm; `dispatch` applies the protocol-version gate.
///
/// The pipe is created here, not by the claim: until the listener starts,
/// a client meets no pipe and answers at once, and nothing a client writes
/// waits in an instance to be served after it gave up. The first instance
/// refuses a name another process already serves, and every instance grants
/// this account alone.
#[cfg(windows)]
pub fn start_claimed_listener<F, Fut>(
    claim: EndpointClaim,
    handler: F,
) -> Result<ListenerHandle, ListenerStartError>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    start_listener_with_instances(claim, handler, |pipe_name| {
        chan_winpipe::create_owner_only(
            &tokio::net::windows::named_pipe::ServerOptions::new(),
            pipe_name,
        )
    })
}

/// Windows listener with an injectable source of the instances that follow
/// the first, so a failed re-arm can be tested without exhausting the system.
#[cfg(windows)]
fn start_listener_with_instances<F, Fut, N>(
    claim: EndpointClaim,
    handler: F,
    mut next_instance: N,
) -> Result<ListenerHandle, ListenerStartError>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
    N: FnMut(&std::ffi::OsStr) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer>
        + Send
        + 'static,
{
    use tokio::net::windows::named_pipe::ServerOptions;

    let first = chan_winpipe::create_owner_only(
        ServerOptions::new().first_pipe_instance(true),
        claim.socket_path.as_os_str(),
    );
    let mut next = match first {
        Ok(first) => first,
        Err(error) => return Err(ListenerStartError { claim, error }),
    };
    let EndpointClaim {
        socket_path,
        claim_pipe,
    } = claim;
    let pipe_name = socket_path.as_os_str().to_owned();

    let handler = std::sync::Arc::new(handler);
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let accept_loop = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let connected = tokio::select! {
                biased;
                _ = &mut stopped => break,
                _ = connections.join_next(), if !connections.is_empty() => continue,
                connected = next.connect() => connected,
            };
            if let Err(e) = connected {
                tracing::warn!("handoff accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            // Re-arm BEFORE serving so the next client doesn't race to NotFound.
            let fresh = match next_instance(&pipe_name) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "handoff listener stopped: it could not create the next pipe instance; \
                         the endpoint stays claimed, so a second launch exits instead of \
                         running beside this desktop"
                    );
                    break;
                }
            };
            let connected = std::mem::replace(&mut next, fresh);
            let handler = handler.clone();
            connections.spawn(async move {
                let (read, write) = tokio::io::split(connected);
                serve_connection(read, write, handler.as_ref()).await;
            });
        }
        // Closing the idle instance refuses new clients while accepted ones
        // finish.
        drop(next);
        drain_connections(connections, CONNECTION_DRAIN_TIMEOUT).await;
    });

    Ok(ListenerHandle {
        socket_path,
        stop: Some(stop),
        accept_loop: Some(accept_loop),
        _claim: claim_pipe,
    })
}

#[cfg(not(any(unix, windows)))]
pub fn start_listener<F, Fut>(_socket_path: PathBuf, _handler: F) -> std::io::Result<ListenerHandle>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "handoff listener requires unix-domain sockets or windows named pipes",
    ))
}

#[cfg(not(any(unix, windows)))]
pub fn start_claimed_listener<F, Fut>(
    claim: EndpointClaim,
    _handler: F,
) -> Result<ListenerHandle, ListenerStartError>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    Err(ListenerStartError {
        claim,
        error: std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "handoff listener requires unix-domain sockets or windows named pipes",
        ),
    })
}

// Leave room for paths, URLs, labels and an optional connect script.
#[cfg(any(unix, windows))]
const MAX_HANDOFF_REQUEST_BYTES: u64 = 1024 * 1024;

#[cfg(any(unix, windows))]
async fn serve_connection<R, W, F, Fut>(read: R, mut write: W, handler: &F)
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
    F: Fn(Request) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Response> + Send,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(read.take(MAX_HANDOFF_REQUEST_BYTES));
    let mut line = String::new();
    let Some(read_result) = crate::control_socket::read_request_line(&mut reader, &mut line).await
    else {
        return;
    };
    let response = match read_result {
        Ok(0) => Response::Error {
            message: "empty handoff request".into(),
        },
        Ok(_) if !line.ends_with('\n') => Response::Error {
            message: "invalid handoff request: line is not newline-terminated".into(),
        },
        Ok(_) => match serde_json::from_str::<Request>(&line) {
            Ok(req) => dispatch(req, handler).await,
            Err(e) => Response::Error {
                message: format!("invalid handoff request: {e}"),
            },
        },
        Err(e) => Response::Error {
            message: format!("read handoff request: {e}"),
        },
    };
    if let Ok(mut out) = serde_json::to_vec(&response) {
        out.push(b'\n');
        let _ = write.write_all(&out).await;
    }
}

/// Apply the protocol-version gate, then call the desktop's async `handler`.
/// A skew short-circuits to `VersionSkew` and the handler never runs (so the
/// desktop never acts on a request it can't fully understand).
#[cfg(any(unix, windows))]
async fn dispatch<F, Fut>(req: Request, handler: &F) -> Response
where
    F: Fn(Request) -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    if req.protocol() != PROTOCOL_VERSION {
        tracing::info!(
            cli_version = %req.cli_version(),
            cli_protocol = req.protocol(),
            "handoff refused: protocol skew",
        );
        return Response::VersionSkew {
            desktop_version: CHAN_VERSION.into(),
            desktop_protocol: PROTOCOL_VERSION,
        };
    }
    handler(req).await
}

// ---------------------------------------------------------------------------
// CLI side: discover + request handoff.
// ---------------------------------------------------------------------------

/// Outcome of a handoff attempt. The CLI maps every non-`HandedOff`
/// variant to "own the server exactly as today" (standalone); the
/// distinct variants exist so the CLI can print the right note.
#[derive(Debug)]
pub enum Outcome {
    /// The desktop accepted the request: it opened the workspace window
    /// (`try_handoff`) or registered the devserver (`try_open_devserver`).
    /// The CLI exits 0 without opening anything itself (the desktop owns the
    /// flock / the devserver lifecycle).
    HandedOff,
    /// No desktop discovered: no socket, connect refused, stale
    /// socket, or any I/O error before a valid response. The
    /// load-bearing default path -> own the server, print URL.
    NoDesktop,
    /// The desktop is a different protocol version. The CLI prints
    /// the skew and falls back to standalone.
    VersionSkew {
        desktop_version: String,
        desktop_protocol: u32,
    },
    /// The desktop answered but refused/failed (e.g. could not mount
    /// the workspace). Falls back to standalone after logging.
    DesktopError { message: String },
    /// The desktop refused close/remove because live terminal sessions would be
    /// killed.
    CloseRefused { active_terminals: usize },
    /// The desktop does not serve the workspace a close named. The close
    /// goes on to the writer lock's holder, as it does with no desktop.
    NotServed,
}

/// How long a client waits to connect: on Windows, how long it retries a busy
/// pipe, which a listener between two instances answers.
#[cfg(any(unix, windows))]
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
#[cfg(any(unix, windows))]
const IO_TIMEOUT: Duration = Duration::from_millis(3000);
#[cfg(any(unix, windows))]
const PROBE_TIMEOUT: Duration = Duration::from_millis(250);
// Updater checks may need a network round-trip on the desktop.
#[cfg(any(unix, windows))]
const UPGRADE_IO_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a request to the endpoint got no answer line.
#[cfg(any(unix, windows))]
enum EndpointError {
    /// Nothing listens: no endpoint, a stale socket, another account's.
    NoDesktop,
    /// A listener took the request and wrote nothing within the budget.
    NoReply,
    /// A listener took the request and closed, or failed, without a line.
    Closed,
}

/// Shared gate for request clients and the connect-only liveness probe.
#[cfg(unix)]
async fn connect_endpoint(socket_path: &Path, timeout: Duration) -> Option<tokio::net::UnixStream> {
    if !socket_is_owner_controlled(socket_path) {
        return None;
    }
    tokio::time::timeout(timeout, tokio::net::UnixStream::connect(socket_path))
        .await
        .ok()?
        .ok()
}

/// Shared gate for request clients and the connect-only liveness probe:
/// open the endpoint's pipe, retrying a busy pipe until `timeout`, and refuse
/// a pipe whose server runs as another account before anything is written to
/// it. A pipe of this account's name is not this account's by its name alone:
/// any local user can create one first.
#[cfg(windows)]
async fn connect_endpoint(
    socket_path: &Path,
    timeout: Duration,
) -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
    let account = chan_winpipe::current_account_sid().ok()?;
    connect_endpoint_as(socket_path, timeout, account).await
}

/// [`connect_endpoint`] for a client of `account`, so a test can stand in
/// for a server of another account.
#[cfg(windows)]
async fn connect_endpoint_as(
    socket_path: &Path,
    timeout: Duration,
    account: &str,
) -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;

    // Win32 ERROR_PIPE_BUSY: every instance of the pipe is taken.
    const ERROR_PIPE_BUSY: i32 = 231;

    let deadline = std::time::Instant::now() + timeout;
    let client = loop {
        match ClientOptions::new().open(socket_path) {
            Ok(client) => break client,
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && std::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            // No pipe (no desktop, or one still booting), access denied
            // (another account's pipe), or busy past the bound.
            Err(_) => return None,
        }
    };
    match chan_winpipe::server_account_sid(&client) {
        Ok(server) if server == account => Some(client),
        served => {
            tracing::debug!(
                endpoint = %socket_path.display(),
                ?served,
                "the handoff endpoint is not served by this account; nothing is sent to it"
            );
            None
        }
    }
}

/// Write one request line and read one reply line.
///
/// A listener refuses a request it will not take, such as one over its byte
/// cap, by writing its refusal and closing the connection without reading
/// the rest. The write then fails with a broken pipe while the refusal
/// already waits in the receive buffer, so a failed write still reads one
/// line, and a reply that parses as `T` answers the request.
#[cfg(any(unix, windows))]
pub(crate) async fn exchange_line<T, R, W>(
    read: R,
    write: &mut W,
    payload: &[u8],
) -> std::io::Result<String>
where
    T: serde::de::DeserializeOwned,
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let written = async {
        write.write_all(payload).await?;
        write.flush().await
    }
    .await;
    let mut line = String::new();
    let read = BufReader::new(read).read_line(&mut line).await;
    reply_after_write::<T>(written, read, line)
}

/// The reply to a request line, from the outcome of its write and of the
/// read of one line that followed: the line after a complete write, and
/// after a failed one only a line that parses as `T`, the answer the peer
/// gave before it closed. The write's error stands otherwise.
#[cfg(any(unix, windows))]
pub(crate) fn reply_after_write<T: serde::de::DeserializeOwned>(
    written: std::io::Result<()>,
    read: std::io::Result<usize>,
    line: String,
) -> std::io::Result<String> {
    match written {
        Ok(()) => read.map(|_| line),
        Err(_) if serde_json::from_str::<T>(&line).is_ok() => Ok(line),
        Err(error) => Err(error),
    }
}

#[cfg(any(unix, windows))]
async fn request_endpoint(
    socket_path: &Path,
    req: &Request,
    budget: Duration,
) -> Result<String, EndpointError> {
    let stream = connect_endpoint(socket_path, CONNECT_TIMEOUT)
        .await
        .ok_or(EndpointError::NoDesktop)?;
    let mut payload = serde_json::to_vec(req).map_err(|_| EndpointError::NoDesktop)?;
    payload.push(b'\n');
    #[cfg(unix)]
    let (read, mut write) = stream.into_split();
    #[cfg(windows)]
    let (read, mut write) = tokio::io::split(stream);
    let io = exchange_line::<Response, _, _>(read, &mut write, &payload);
    match tokio::time::timeout(budget, io).await {
        Ok(Ok(line)) if !line.trim().is_empty() => Ok(line),
        Ok(_) => Err(EndpointError::Closed),
        Err(_) => Err(EndpointError::NoReply),
    }
}

/// Report whether the same-user desktop endpoint accepts a local connection.
/// The probe is connect-only: it sends no request, cannot dispatch a desktop
/// action, and drops the connection immediately. Missing, stale, busy, or
/// headless endpoints resolve to `false` within a short bound, and so does a
/// Windows pipe that another account serves.
#[cfg(any(unix, windows))]
pub async fn desktop_is_live() -> bool {
    if handoff_opt_out() || !gui_session_present() {
        return false;
    }
    let Some(socket_path) = existing_well_known_socket_path() else {
        return false;
    };
    desktop_is_live_at(&socket_path).await
}

#[cfg(any(unix, windows))]
async fn desktop_is_live_at(socket_path: &Path) -> bool {
    connect_endpoint(socket_path, PROBE_TIMEOUT).await.is_some()
}

#[cfg(not(any(unix, windows)))]
pub async fn desktop_is_live() -> bool {
    false
}

/// Try to hand `workspace_path` to a running same-user desktop. Connects
/// the well-known socket, sends an `OpenWorkspace` request, and parses
/// the response. Any connect failure / stale socket / read error /
/// malformed reply maps to `Outcome::NoDesktop`, the answer for an
/// absent desktop: the CLI then launches chan-desktop (a forced-desktop
/// invocation) or starts a standalone server.
///
/// A short connect+IO timeout bounds the case where a stale socket
/// file exists but nothing is accepting; the CLI must not hang on a
/// dead desktop. On Windows a missing pipe (no desktop, or one still
/// booting) is no desktop at once and a busy one is retried briefly.
#[cfg(any(unix, windows))]
pub async fn try_handoff(workspace_path: &Path) -> Outcome {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return Outcome::NoDesktop;
    };
    try_handoff_at(&socket_path, workspace_path).await
}

/// The post-resolution half of [`try_handoff`], on an explicit socket path so
/// the ownership gate is testable without steering the process environment.
#[cfg(any(unix, windows))]
async fn try_handoff_at(socket_path: &Path, workspace_path: &Path) -> Outcome {
    let req = Request::OpenWorkspace {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        workspace_path: workspace_path.display().to_string(),
    };
    let Ok(line) = request_endpoint(socket_path, &req, IO_TIMEOUT).await else {
        return Outcome::NoDesktop;
    };

    match serde_json::from_str::<Response>(&line) {
        Ok(Response::Opened { .. }) => Outcome::HandedOff,
        Ok(Response::VersionSkew {
            desktop_version,
            desktop_protocol,
        }) => Outcome::VersionSkew {
            desktop_version,
            desktop_protocol,
        },
        Ok(Response::Error { message }) => Outcome::DesktopError { message },
        // A reply we can't parse, or an upgrade / devserver reply to an
        // open-workspace request (a desktop we can't talk to sanely): fall back
        // rather than guess.
        Ok(Response::UpgradeStarted { .. })
        | Ok(Response::UpgradeChecked { .. })
        | Ok(Response::DevserverRegistered { .. })
        | Ok(Response::Closed { .. })
        | Ok(Response::NotServed { .. })
        | Ok(Response::CloseRefused { .. })
        | Ok(Response::Devservers { .. })
        | Ok(Response::DevserverConnectStarted { .. })
        | Ok(Response::DevserverDisconnected { .. })
        | Ok(Response::DevserverForgotten { .. })
        | Ok(Response::RemoteWorkspaceServed { .. })
        | Ok(Response::RemoteWorkspaceClosed { .. })
        | Ok(Response::RemoteWorkspaceForgotten { .. })
        | Ok(Response::TerminalOpened { .. })
        | Ok(Response::Activated { .. })
        | Ok(Response::PathOpened { .. })
        | Err(_) => Outcome::NoDesktop,
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_handoff(_workspace_path: &std::path::Path) -> Outcome {
    Outcome::NoDesktop
}

/// Try to make a running same-user desktop tear down the workspace it serves at
/// `workspace_path` -- the `chan close` / `chan workspace forget` handoff. Connects
/// the well-known socket, sends a `CloseWorkspace` request, and maps the reply:
/// `Closed` is `Outcome::HandedOff`, `NotServed` is `Outcome::NotServed`, and a
/// close refusal, version skew, or desktop error keeps its own `Outcome`
/// variant. Any connect failure / stale socket / read error / malformed or
/// unrelated reply maps to
/// `Outcome::NoDesktop` so the CLI falls back to the per-pid control-socket
/// teardown, the same path it takes when no desktop is running. Mirrors
/// `try_handoff`'s framing + timeouts.
#[cfg(any(unix, windows))]
pub async fn try_close_workspace(workspace_path: &Path, remove: bool) -> Outcome {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return Outcome::NoDesktop;
    };
    try_close_workspace_at(&socket_path, workspace_path, remove).await
}

#[cfg(any(unix, windows))]
async fn try_close_workspace_at(
    socket_path: &Path,
    workspace_path: &Path,
    remove: bool,
) -> Outcome {
    let req = Request::CloseWorkspace {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        workspace_path: workspace_path.display().to_string(),
        remove,
    };
    let Ok(line) = request_endpoint(socket_path, &req, req.reply_budget()).await else {
        return Outcome::NoDesktop;
    };

    map_close_response(&line)
}

#[cfg(not(any(unix, windows)))]
pub async fn try_close_workspace(_workspace_path: &std::path::Path, _remove: bool) -> Outcome {
    Outcome::NoDesktop
}

/// Map a `CloseWorkspace` reply line to an [`Outcome`]. Shared by the unix +
/// windows arms: only `Closed` is a success; `NotServed` is
/// `Outcome::NotServed`, a `CloseRefused` keeps its live terminal count as
/// `Outcome::CloseRefused`, a skew falls back to `VersionSkew`, an `Error` to
/// `DesktopError`, and any other reply / unparseable line to `NoDesktop` so
/// the caller drops to the control-socket teardown rather than guessing.
#[cfg(any(unix, windows))]
fn map_close_response(line: &str) -> Outcome {
    match serde_json::from_str::<Response>(line) {
        Ok(Response::Closed { .. }) => Outcome::HandedOff,
        Ok(Response::NotServed { .. }) => Outcome::NotServed,
        Ok(Response::CloseRefused {
            active_terminals, ..
        }) => Outcome::CloseRefused { active_terminals },
        Ok(Response::VersionSkew {
            desktop_version,
            desktop_protocol,
        }) => Outcome::VersionSkew {
            desktop_version,
            desktop_protocol,
        },
        Ok(Response::Error { message }) => Outcome::DesktopError { message },
        Ok(Response::Opened { .. })
        | Ok(Response::UpgradeStarted { .. })
        | Ok(Response::UpgradeChecked { .. })
        | Ok(Response::DevserverRegistered { .. })
        | Ok(Response::Devservers { .. })
        | Ok(Response::DevserverConnectStarted { .. })
        | Ok(Response::DevserverDisconnected { .. })
        | Ok(Response::DevserverForgotten { .. })
        | Ok(Response::RemoteWorkspaceServed { .. })
        | Ok(Response::RemoteWorkspaceClosed { .. })
        | Ok(Response::RemoteWorkspaceForgotten { .. })
        | Ok(Response::TerminalOpened { .. })
        | Ok(Response::Activated { .. })
        | Ok(Response::PathOpened { .. })
        | Err(_) => Outcome::NoDesktop,
    }
}

/// Try to register a devserver by `url` with a running same-user
/// desktop -- the `chan devserver register {url}` path. Connects the well-known socket, sends
/// an `OpenDevserver` request, and maps the reply: `DevserverRegistered` ->
/// `HandedOff`; a protocol skew -> `VersionSkew`; an `Error` -> `DesktopError`;
/// any other reply / connect failure / stale socket / malformed line ->
/// `NoDesktop` (the caller surfaces "no desktop to register the devserver
/// into"). Mirrors `try_handoff`'s framing + timeouts. `name` / `script` ride
/// along as the optional launcher label + connect script; a bearer may ride in
/// the URL as `?t=...`.
#[cfg(any(unix, windows))]
pub async fn try_open_devserver(url: &str, name: Option<&str>, script: Option<&str>) -> Outcome {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return Outcome::NoDesktop;
    };
    try_open_devserver_at(&socket_path, url, name, script).await
}

#[cfg(any(unix, windows))]
async fn try_open_devserver_at(
    socket_path: &Path,
    url: &str,
    name: Option<&str>,
    script: Option<&str>,
) -> Outcome {
    let req = Request::OpenDevserver {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        url: url.to_string(),
        name: name.map(str::to_string),
        script: script.map(str::to_string),
    };
    let Ok(line) = request_endpoint(socket_path, &req, IO_TIMEOUT).await else {
        return Outcome::NoDesktop;
    };

    map_devserver_response(&line)
}

#[cfg(not(any(unix, windows)))]
pub async fn try_open_devserver(_url: &str, _name: Option<&str>, _script: Option<&str>) -> Outcome {
    Outcome::NoDesktop
}

/// Outcome of a generic devserver-control round-trip: the desktop's
/// reply verbatim, or no reachable desktop. Unlike the `Outcome`-mapped
/// verbs, the caller matches [`Response`] itself -- these verbs never
/// fall back to anything, so there is nothing to normalize.
#[derive(Debug)]
pub enum DevserverControlOutcome {
    Reply(Response),
    NoDesktop,
    /// The desktop accepted the connection but no reply arrived within the
    /// request's budget: the operation may still be running there, which is
    /// a different message from "no desktop".
    NoReply {
        budget: Duration,
    },
}

/// One request/one reply against the well-known desktop socket, for the
/// devserver-control verbs (`ls` / `connect` / `disconnect` / `forget`).
/// Mirrors `try_open_devserver`'s framing and timeouts; any connect
/// failure, stale socket, or malformed line maps to `NoDesktop`.
#[cfg(any(unix, windows))]
pub async fn try_devserver_control(req: Request) -> DevserverControlOutcome {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return DevserverControlOutcome::NoDesktop;
    };
    try_devserver_control_at(&socket_path, req).await
}

#[cfg(any(unix, windows))]
async fn try_devserver_control_at(socket_path: &Path, req: Request) -> DevserverControlOutcome {
    let budget = req.reply_budget();
    let line = match request_endpoint(socket_path, &req, budget).await {
        Ok(line) => line,
        Err(EndpointError::NoDesktop | EndpointError::Closed) => {
            return DevserverControlOutcome::NoDesktop
        }
        Err(EndpointError::NoReply) => return DevserverControlOutcome::NoReply { budget },
    };

    match serde_json::from_str::<Response>(line.trim()) {
        Ok(resp) => DevserverControlOutcome::Reply(resp),
        Err(_) => DevserverControlOutcome::NoDesktop,
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_devserver_control(_req: Request) -> DevserverControlOutcome {
    DevserverControlOutcome::NoDesktop
}

/// The variable a `chan-term` that starts chan-desktop sets on it: the
/// absolute directory of the terminal the launch asked for. The desktop reads
/// and drops it at boot, opens that terminal where it would otherwise open
/// its first window, and hands it to the desktop it finds instead when
/// another one runs, as a launch's paths are.
pub const OPEN_TERMINAL_ENV: &str = "CHAN_DESKTOP_OPEN_TERMINAL";

/// What an `OpenTerminal` from the CLI met at the well-known endpoint, told
/// apart as [`CliOpenPath`] tells them: only nothing listening lets the CLI
/// start a desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliOpenTerminal {
    /// The desktop opened the terminal window.
    Opened,
    /// It answered without opening; `reply` is its answer line.
    Refused { reply: String },
    /// Nothing listens on the endpoint: no desktop is running, or one has not
    /// bound it yet.
    NotListening,
    /// A listener took the request and gave no answer within the budget, or
    /// closed without one.
    Silent,
}

/// Ask the running same-user desktop for a throwaway terminal window whose
/// shell starts in `cwd`, within `budget`, for a `chan-term` launch that runs
/// the user's shell. The caller reads `CHAN_NO_DESKTOP_HANDOFF` and the
/// GUI-session check first, so it can say which of them stopped it.
#[cfg(any(unix, windows))]
pub async fn try_open_terminal(cwd: &str, budget: Duration) -> CliOpenTerminal {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return CliOpenTerminal::NotListening;
    };
    try_open_terminal_from_cli_at(&socket_path, cwd, budget).await
}

#[cfg(any(unix, windows))]
async fn try_open_terminal_from_cli_at(
    socket_path: &Path,
    cwd: &str,
    budget: Duration,
) -> CliOpenTerminal {
    match request_endpoint(socket_path, &open_terminal_request(cwd), budget).await {
        Ok(line) => match serde_json::from_str::<Response>(line.trim()) {
            Ok(Response::TerminalOpened { .. }) => CliOpenTerminal::Opened,
            _ => CliOpenTerminal::Refused {
                reply: line.trim().to_string(),
            },
        },
        Err(EndpointError::NoDesktop) => CliOpenTerminal::NotListening,
        Err(EndpointError::NoReply | EndpointError::Closed) => CliOpenTerminal::Silent,
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_open_terminal(_cwd: &str, _budget: std::time::Duration) -> CliOpenTerminal {
    CliOpenTerminal::NotListening
}

/// Ask the desktop serving the endpoint at `socket_path` for the terminal a
/// launch carried ([`OPEN_TERMINAL_ENV`]). Like [`try_activate_at`] this
/// ignores `CHAN_NO_DESKTOP_HANDOFF` and the GUI-session check: the sender is
/// a desktop launch handing its terminal to the desktop it will not run
/// beside. The answer reads as an `Activate`'s: an opened terminal raised its
/// window, so the holder came forward.
#[cfg(any(unix, windows))]
pub async fn try_open_terminal_at(
    socket_path: &Path,
    cwd: &str,
    budget: Duration,
) -> ActivateReply {
    match request_endpoint(socket_path, &open_terminal_request(cwd), budget).await {
        Ok(line) => match serde_json::from_str::<Response>(line.trim()) {
            Ok(Response::TerminalOpened { desktop_version }) => {
                ActivateReply::Activated { desktop_version }
            }
            _ => ActivateReply::Refused {
                reply: line.trim().to_string(),
            },
        },
        Err(EndpointError::NoDesktop | EndpointError::NoReply | EndpointError::Closed) => {
            ActivateReply::NoReply
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_open_terminal_at(
    _socket_path: &std::path::Path,
    _cwd: &str,
    _budget: std::time::Duration,
) -> ActivateReply {
    ActivateReply::NoReply
}

#[cfg(any(unix, windows))]
fn open_terminal_request(cwd: &str) -> Request {
    Request::OpenTerminal {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        cwd: cwd.to_string(),
    }
}

/// What the desktop serving an endpoint answered to an `Activate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivateReply {
    /// It is coming forward.
    Activated { desktop_version: String },
    /// It answered without coming forward; `reply` is its answer line. A
    /// desktop that predates `Activate` answers `Error` for an unknown type,
    /// one on another protocol `VersionSkew`, and one shutting down `Error`.
    Refused { reply: String },
    /// Nothing answered: no endpoint to connect to, a connection closed
    /// without a reply, or no reply within the budget.
    NoReply,
}

/// Ask the desktop serving the endpoint at `socket_path` to come forward.
/// Unlike the CLI's requests this ignores `CHAN_NO_DESKTOP_HANDOFF` and the
/// GUI-session check: the sender is itself a desktop, and one desktop per
/// endpoint is not something automation opts out of.
#[cfg(any(unix, windows))]
pub async fn try_activate_at(socket_path: &Path, budget: Duration) -> ActivateReply {
    match request_endpoint(socket_path, &activate_request(), budget).await {
        Ok(line) => map_activate_response(&line),
        Err(EndpointError::NoDesktop | EndpointError::NoReply | EndpointError::Closed) => {
            ActivateReply::NoReply
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_activate_at(
    _socket_path: &std::path::Path,
    _budget: std::time::Duration,
) -> ActivateReply {
    ActivateReply::NoReply
}

#[cfg(any(unix, windows))]
fn activate_request() -> Request {
    Request::Activate {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
    }
}

/// Any line is an answer from a live desktop, so only `Activated` comes
/// forward and everything else, an unreadable line included, is a refusal.
#[cfg(any(unix, windows))]
fn map_activate_response(line: &str) -> ActivateReply {
    let line = line.trim();
    match serde_json::from_str::<Response>(line) {
        Ok(Response::Activated { desktop_version }) => ActivateReply::Activated { desktop_version },
        _ => ActivateReply::Refused {
            reply: line.to_string(),
        },
    }
}

/// The desktop's answer to an `OpenPath` for `path`: `PathOpened` once `host`
/// has opened it in a standalone window as `cs open PATH` does there, `Error`
/// with the reason otherwise.
pub async fn answer_open_path(host: &chan_library::WorkspaceHost, path: &str) -> Response {
    match crate::control_socket::open_path_for_handoff(host, std::path::Path::new(path)).await {
        Ok(message) => Response::PathOpened {
            desktop_version: CHAN_VERSION.into(),
            message,
        },
        Err(message) => Response::Error { message },
    }
}

/// What the desktop serving an endpoint answered to an `OpenPath`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenPathReply {
    /// It opened the path; `message` is its `PathOpened` line.
    Opened {
        desktop_version: String,
        message: String,
    },
    /// It answered without opening; `reply` is its answer line. A desktop
    /// that predates `OpenPath` answers `Error` for an unknown type, one on
    /// another protocol `VersionSkew`, and one shutting down or unable to
    /// open the path `Error`.
    Refused { reply: String },
    /// Nothing answered: no endpoint to connect to, a connection closed
    /// without a reply, or no reply within the budget.
    NoReply,
}

/// Ask the desktop serving the endpoint at `socket_path` to open `path`. Like
/// [`try_activate_at`] this ignores `CHAN_NO_DESKTOP_HANDOFF` and the
/// GUI-session check: the sender is a desktop launch handing its arguments
/// to the desktop it will not run beside.
#[cfg(any(unix, windows))]
pub async fn try_open_path_at(socket_path: &Path, path: &str, budget: Duration) -> OpenPathReply {
    let req = Request::OpenPath {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        path: path.to_string(),
    };
    match request_endpoint(socket_path, &req, budget).await {
        Ok(line) => map_open_path_response(&line),
        Err(EndpointError::NoDesktop | EndpointError::NoReply | EndpointError::Closed) => {
            OpenPathReply::NoReply
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_open_path_at(
    _socket_path: &std::path::Path,
    _path: &str,
    _budget: std::time::Duration,
) -> OpenPathReply {
    OpenPathReply::NoReply
}

/// As with `Activate`, any line is an answer from a live desktop, so only
/// `PathOpened` is an open and everything else is a refusal.
#[cfg(any(unix, windows))]
fn map_open_path_response(line: &str) -> OpenPathReply {
    let line = line.trim();
    match serde_json::from_str::<Response>(line) {
        Ok(Response::PathOpened {
            desktop_version,
            message,
        }) => OpenPathReply::Opened {
            desktop_version,
            message,
        },
        _ => OpenPathReply::Refused {
            reply: line.to_string(),
        },
    }
}

/// What an `OpenPath` from the CLI met at the well-known endpoint. Unlike
/// [`OpenPathReply`], a desktop that is running and gave no answer is told
/// apart from no desktop at all, since only the second lets the CLI start
/// one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliOpenPath {
    /// The desktop opened the path; `message` is its `PathOpened` line.
    Opened { message: String },
    /// It answered without opening; `reply` is its answer line.
    Refused { reply: String },
    /// Nothing listens on the endpoint: no socket, a stale one, or another
    /// account's. No desktop is running, or one has not bound it yet.
    NotListening,
    /// A listener took the request and gave no answer within the budget, or
    /// closed without one: a desktop is running and did not answer.
    Silent,
}

/// Ask the running same-user desktop to open `path` within `budget`, for the
/// CLI's `chan-files` and `chan-edit` outside a chan terminal. The caller
/// reads `CHAN_NO_DESKTOP_HANDOFF` and the GUI-session check first, so it can
/// say which of them stopped it.
#[cfg(any(unix, windows))]
pub async fn try_open_path(path: &str, budget: Duration) -> CliOpenPath {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return CliOpenPath::NotListening;
    };
    try_open_path_from_cli_at(&socket_path, path, budget).await
}

#[cfg(not(any(unix, windows)))]
pub async fn try_open_path(_path: &str, _budget: std::time::Duration) -> CliOpenPath {
    CliOpenPath::NotListening
}

#[cfg(any(unix, windows))]
async fn try_open_path_from_cli_at(
    socket_path: &Path,
    path: &str,
    budget: Duration,
) -> CliOpenPath {
    let req = Request::OpenPath {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        path: path.to_string(),
    };
    match request_endpoint(socket_path, &req, budget).await {
        Ok(line) => match map_open_path_response(&line) {
            OpenPathReply::Opened { message, .. } => CliOpenPath::Opened { message },
            OpenPathReply::Refused { .. } | OpenPathReply::NoReply => CliOpenPath::Refused {
                reply: line.trim().to_string(),
            },
        },
        Err(EndpointError::NoDesktop) => CliOpenPath::NotListening,
        Err(EndpointError::NoReply | EndpointError::Closed) => CliOpenPath::Silent,
    }
}

/// The absolute path a launch argument names, the `path` of an `OpenPath` or
/// of `cs open`: an argument of `chan-desktop`, `chan-files` or `chan-edit`,
/// typed or the file URIs a desktop entry's `%U` expands to. A relative path
/// is made absolute against `cwd`, the launch's working directory, and a
/// `file://` URI is percent-decoded. `Err` is the reason an argument names
/// nothing chan can open, because a desktop entry hands over every URI a file
/// manager selected (`smb://` and `sftp://` on a network mount among them): a
/// URI of another scheme, a file URI naming another host or encoding a `/` or
/// a NUL in a name, a relative path with no working directory, a path that is
/// not UTF-8, which the request's JSON cannot carry.
pub fn launch_arg_path(
    arg: &std::ffi::OsStr,
    cwd: Option<&std::path::Path>,
) -> Result<String, String> {
    launch_arg_pathbuf(arg, cwd)?
        .into_os_string()
        .into_string()
        .map_err(|path| {
            format!(
                "{} is not valid UTF-8, so it cannot be sent to chan",
                std::path::Path::new(&path).display()
            )
        })
}

fn launch_arg_pathbuf(
    arg: &std::ffi::OsStr,
    cwd: Option<&std::path::Path>,
) -> Result<PathBuf, String> {
    if let Some(text) = arg.to_str() {
        if let Some(uri) = launch_arg_uri(text) {
            return file_uri_path(text, &uri);
        }
    }
    let path = std::path::Path::new(arg);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    match cwd {
        Some(cwd) => Ok(cwd.join(path)),
        None => Err(format!(
            "{} is relative and this launch has no working directory to resolve it in",
            path.display()
        )),
    }
}

/// `text` as a URI when it has a scheme of two letters or more, so a Windows
/// drive letter (`C:\notes.md`) stays a path.
fn launch_arg_uri(text: &str) -> Option<url::Url> {
    url::Url::parse(text)
        .ok()
        .filter(|uri| uri.scheme().len() > 1)
}

/// The local path a `file://` URI names. The host is checked here rather than
/// left to `to_file_path`, which on Windows makes `file://host/share/...` a UNC
/// path; a `/` or a NUL encoded in a name (`%2F`, `%00`) is refused, since
/// decoding it would split the name or end it.
fn file_uri_path(text: &str, uri: &url::Url) -> Result<PathBuf, String> {
    if uri.scheme() != "file" {
        return Err(format!(
            "{text} is not a file: chan opens files and directories, given as paths or \
             file:// URIs"
        ));
    }
    if let Some(host) = uri
        .host_str()
        .filter(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost"))
    {
        return Err(format!(
            "{text} names the host {host}: chan opens files on this machine only"
        ));
    }
    let encoded = uri.path().to_ascii_lowercase();
    if encoded.contains("%2f") || encoded.contains("%00") {
        return Err(format!(
            "{text} encodes a / or a NUL inside a name, which no file name holds"
        ));
    }
    uri.to_file_path()
        .map_err(|()| format!("{text} names no local path"))
}

/// Map an `OpenDevserver` reply line to an [`Outcome`]. Shared by the unix +
/// windows arms so the response handling stays in one place: only
/// `DevserverRegistered` is a success; a workspace/upgrade reply to a
/// devserver request (or an unparseable line) is a desktop we can't talk to
/// sanely, so it falls back to `NoDesktop` rather than guessing.
#[cfg(any(unix, windows))]
fn map_devserver_response(line: &str) -> Outcome {
    match serde_json::from_str::<Response>(line) {
        Ok(Response::DevserverRegistered { .. }) => Outcome::HandedOff,
        Ok(Response::VersionSkew {
            desktop_version,
            desktop_protocol,
        }) => Outcome::VersionSkew {
            desktop_version,
            desktop_protocol,
        },
        Ok(Response::Error { message }) => Outcome::DesktopError { message },
        Ok(Response::Opened { .. })
        | Ok(Response::UpgradeStarted { .. })
        | Ok(Response::UpgradeChecked { .. })
        | Ok(Response::Closed { .. })
        | Ok(Response::NotServed { .. })
        | Ok(Response::CloseRefused { .. })
        | Ok(Response::Devservers { .. })
        | Ok(Response::DevserverConnectStarted { .. })
        | Ok(Response::DevserverDisconnected { .. })
        | Ok(Response::DevserverForgotten { .. })
        | Ok(Response::RemoteWorkspaceServed { .. })
        | Ok(Response::RemoteWorkspaceClosed { .. })
        | Ok(Response::RemoteWorkspaceForgotten { .. })
        | Ok(Response::TerminalOpened { .. })
        | Ok(Response::Activated { .. })
        | Ok(Response::PathOpened { .. })
        | Err(_) => Outcome::NoDesktop,
    }
}

/// Outcome of an upgrade-trigger attempt against the well-known socket.
/// Mirrors [`Outcome`] for the `Upgrade` request: every non-`Started` /
/// non-`Checked` variant means the CLI couldn't drive a running desktop.
#[derive(Debug)]
pub enum UpgradeOutcome {
    /// The desktop kicked off the install in the background (`check_only` was
    /// false). The CLI prints a note and exits.
    Started { desktop_version: String },
    /// The desktop reported an availability check (`check_only` was true).
    /// `available` is `Some(version)` when an update exists, else `None`.
    Checked {
        desktop_version: String,
        available: Option<String>,
    },
    /// No desktop discovered: no socket, connect refused, stale socket, read
    /// error, or malformed reply. The caller may launch one and retry.
    NoDesktop,
    /// The desktop speaks a different protocol version.
    VersionSkew {
        desktop_version: String,
        desktop_protocol: u32,
    },
    /// The desktop answered but the updater failed (e.g. unavailable / check
    /// error).
    DesktopError { message: String },
}

/// Ask a running same-user desktop to drive its updater. With `check_only`
/// the desktop reports availability without installing; otherwise it starts
/// the install in the background and returns at once (fire-and-return). Any
/// connect failure / stale socket / read error / malformed reply maps to
/// `UpgradeOutcome::NoDesktop` so the caller can launch a desktop and retry.
#[cfg(any(unix, windows))]
pub async fn try_upgrade(check_only: bool) -> UpgradeOutcome {
    let Some(socket_path) = existing_well_known_socket_path() else {
        return UpgradeOutcome::NoDesktop;
    };
    try_upgrade_at(&socket_path, check_only).await
}

#[cfg(any(unix, windows))]
async fn try_upgrade_at(socket_path: &Path, check_only: bool) -> UpgradeOutcome {
    let req = Request::Upgrade {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        check_only,
    };
    let Ok(line) = request_endpoint(socket_path, &req, UPGRADE_IO_TIMEOUT).await else {
        return UpgradeOutcome::NoDesktop;
    };

    map_upgrade_response(&line)
}

#[cfg(not(any(unix, windows)))]
pub async fn try_upgrade(_check_only: bool) -> UpgradeOutcome {
    UpgradeOutcome::NoDesktop
}

/// Map the desktop's one-line reply to an `Upgrade` request. Shared by the
/// unix and Windows client arms so the two transports cannot drift on what
/// a reply means.
#[cfg(any(unix, windows))]
fn map_upgrade_response(line: &str) -> UpgradeOutcome {
    match serde_json::from_str::<Response>(line) {
        Ok(Response::UpgradeStarted { desktop_version }) => {
            UpgradeOutcome::Started { desktop_version }
        }
        Ok(Response::UpgradeChecked {
            desktop_version,
            available,
        }) => UpgradeOutcome::Checked {
            desktop_version,
            available,
        },
        Ok(Response::VersionSkew {
            desktop_version,
            desktop_protocol,
        }) => UpgradeOutcome::VersionSkew {
            desktop_version,
            desktop_protocol,
        },
        Ok(Response::Error { message }) => UpgradeOutcome::DesktopError { message },
        // An open-workspace / devserver reply to an upgrade request, or an
        // unparseable line: a desktop we can't talk to sanely.
        Ok(Response::Opened { .. })
        | Ok(Response::DevserverRegistered { .. })
        | Ok(Response::Closed { .. })
        | Ok(Response::NotServed { .. })
        | Ok(Response::CloseRefused { .. })
        | Ok(Response::Devservers { .. })
        | Ok(Response::DevserverConnectStarted { .. })
        | Ok(Response::DevserverDisconnected { .. })
        | Ok(Response::DevserverForgotten { .. })
        | Ok(Response::RemoteWorkspaceServed { .. })
        | Ok(Response::RemoteWorkspaceClosed { .. })
        | Ok(Response::RemoteWorkspaceForgotten { .. })
        | Ok(Response::TerminalOpened { .. })
        | Ok(Response::Activated { .. })
        | Ok(Response::PathOpened { .. })
        | Err(_) => UpgradeOutcome::NoDesktop,
    }
}

#[cfg(test)]
mod tests {
    async fn request_deadline_case(drip: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            let (mut client, peer) = tokio::io::duplex(1024);
            let (read, write) = tokio::io::split(peer);
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let handler = |_| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async {
                    Response::Closed {
                        desktop_version: CHAN_VERSION.into(),
                    }
                }
            };
            let mut serving = Box::pin(serve_connection(read, write, &handler));
            assert!(futures::poll!(serving.as_mut()).is_pending());
            tokio::time::advance(Duration::from_secs(5)).await;
            if drip {
                client.write_all(b"{\"type\":").await.unwrap();
            }
            assert!(futures::poll!(serving.as_mut()).is_pending());
            tokio::time::advance(Duration::from_secs(4)).await;
            if drip {
                client.write_all(b"\"unfinished").await.unwrap();
            }
            assert!(
                futures::poll!(serving.as_mut()).is_pending(),
                "deadline fired early"
            );
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::time::timeout(Duration::from_millis(10), serving.as_mut())
                .await
                .expect("request read survived the ten-second total deadline");
            drop(serving);
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).await.unwrap();
            assert!(reply.is_empty(), "expiry must close without a reply");
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_request_deadline_closes_a_silent_client() {
        request_deadline_case(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_request_deadline_is_not_reset_by_partial_input() {
        request_deadline_case(true).await;
    }

    async fn request_handler_case(slow: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            let (mut client, peer) = tokio::io::duplex(1024);
            let (read, write) = tokio::io::split(peer);
            let request = Request::OpenWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: CHAN_VERSION.into(),
                workspace_path: "notes".into(),
            };
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let release = tokio::sync::Semaphore::new(0);
            let handler = |received| {
                assert_eq!(received, request);
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let release = &release;
                async move {
                    if slow {
                        release.acquire().await.unwrap().forget();
                    }
                    Response::Closed {
                        desktop_version: CHAN_VERSION.into(),
                    }
                }
            };
            client
                .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
                .await
                .unwrap();
            let mut serving = Box::pin(serve_connection(read, write, &handler));
            if slow {
                assert!(futures::poll!(serving.as_mut()).is_pending());
                assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
                tokio::time::advance(Duration::from_secs(11)).await;
                assert!(
                    futures::poll!(serving.as_mut()).is_pending(),
                    "request deadline ended the handler"
                );
                release.add_permits(1);
            }
            serving.as_mut().await;
            drop(serving);
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Response>(&reply).unwrap(),
                Response::Closed {
                    desktop_version: CHAN_VERSION.into()
                }
            );
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_request_deadline_serves_an_immediate_request() {
        request_handler_case(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_request_deadline_does_not_limit_a_slow_handler() {
        request_handler_case(true).await;
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_request_without_a_trailing_newline_is_refused() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            for over_cap in [false, true] {
                let request = Request::OpenWorkspace {
                    protocol: PROTOCOL_VERSION,
                    cli_version: CHAN_VERSION.into(),
                    workspace_path: if over_cap {
                        "x".repeat(MAX_HANDOFF_REQUEST_BYTES as usize)
                    } else {
                        "notes".into()
                    },
                };
                let request = serde_json::to_vec(&request).unwrap();
                let (mut client, peer) = tokio::io::duplex(request.len().max(1024));
                let (read, write) = tokio::io::split(peer);
                client.write_all(&request).await.unwrap();
                client.shutdown().await.unwrap();
                let calls = std::sync::atomic::AtomicUsize::new(0);
                serve_connection(read, write, &|_| {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async {
                        Response::Closed {
                            desktop_version: CHAN_VERSION.into(),
                        }
                    }
                })
                .await;
                let mut reply = Vec::new();
                client.read_to_end(&mut reply).await.unwrap();
                let calls = calls.load(std::sync::atomic::Ordering::SeqCst);
                assert_eq!(
                    serde_json::from_slice::<Response>(&reply).unwrap(),
                    Response::Error {
                        message: "invalid handoff request: line is not newline-terminated".into(),
                    },
                    "over_cap={over_cap}, handler calls={calls}"
                );
                assert_eq!(calls, 0, "an incomplete request must not reach the handler");
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_request_over_the_byte_cap_is_refused() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            let request = Request::OpenWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: CHAN_VERSION.into(),
                workspace_path: "x".repeat(MAX_HANDOFF_REQUEST_BYTES as usize),
            };
            let request = format!("{}\n", serde_json::to_string(&request).unwrap());
            let (mut client, peer) = tokio::io::duplex(request.len());
            let (read, write) = tokio::io::split(peer);
            client.write_all(request.as_bytes()).await.unwrap();
            let calls = std::sync::atomic::AtomicUsize::new(0);
            serve_connection(read, write, &|_| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async {
                    Response::Closed {
                        desktop_version: CHAN_VERSION.into(),
                    }
                }
            })
            .await;
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).await.unwrap();
            assert!(matches!(
                serde_json::from_slice::<Response>(&reply).unwrap(),
                Response::Error { message } if message.starts_with("invalid handoff request:")
            ));
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        })
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[derive(Clone, Copy, Debug)]
    enum ClientVerb {
        Open,
        Close,
        Devserver,
        Control,
        Upgrade,
        Probe,
    }

    #[cfg(unix)]
    async fn invoke_client(verb: ClientVerb, path: &Path) -> bool {
        let outcome = match verb {
            ClientVerb::Open => try_handoff_at(path, Path::new("/private/notes")).await,
            ClientVerb::Close => {
                try_close_workspace_at(path, Path::new("/private/notes"), true).await
            }
            ClientVerb::Devserver => {
                try_open_devserver_at(
                    path,
                    "http://localhost:8787?t=private",
                    Some("label"),
                    Some("script"),
                )
                .await
            }
            ClientVerb::Control => {
                return match try_devserver_control_at(
                    path,
                    Request::ListDevservers {
                        protocol: PROTOCOL_VERSION,
                        cli_version: CHAN_VERSION.into(),
                    },
                )
                .await
                {
                    DevserverControlOutcome::NoDesktop => false,
                    DevserverControlOutcome::Reply(Response::Devservers { .. }) => true,
                    other => panic!("unexpected control outcome: {other:?}"),
                }
            }
            ClientVerb::Upgrade => {
                return match try_upgrade_at(path, true).await {
                    UpgradeOutcome::NoDesktop => false,
                    UpgradeOutcome::Started { .. } => true,
                    other => panic!("unexpected upgrade outcome: {other:?}"),
                }
            }
            ClientVerb::Probe => return desktop_is_live_at(path).await,
        };
        match outcome {
            Outcome::NoDesktop => false,
            Outcome::HandedOff => true,
            other => panic!("unexpected handoff outcome: {other:?}"),
        }
    }

    #[cfg(unix)]
    async fn assert_client_socket_gate(verb: ClientVerb) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sock");
        let link = dir.path().join("link.sock");
        // The server accepts until the client has returned: a connection the
        // client made is accepted before its return can end the wait, and a
        // client that made none ends it. A connection the reactor has not
        // reported when the client returns is still queued on the socket, so
        // the end of the wait asks the socket itself.
        let socket = std::os::unix::net::UnixListener::bind(&real).unwrap();
        socket.set_nonblocking(true).unwrap();
        let listener = tokio::net::UnixListener::from_std(socket.try_clone().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let mut observed = Vec::new();
        for path in [&link, &real] {
            let client_done = tokio::sync::Notify::new();
            let client = async {
                let success = invoke_client(verb, path).await;
                client_done.notify_one();
                success
            };
            let server = async {
                let mut stream = tokio::select! {
                    biased;
                    accepted = listener.accept() => accepted.unwrap().0,
                    () = client_done.notified() => match socket.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(true).unwrap();
                            tokio::net::UnixStream::from_std(stream).unwrap()
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            return None;
                        }
                        Err(error) => panic!("the listener failed: {error}"),
                    },
                };
                if matches!(verb, ClientVerb::Probe) {
                    let mut line = String::new();
                    BufReader::new(stream).read_line(&mut line).await.unwrap();
                    assert!(line.is_empty(), "liveness is connect-only");
                    return Some(line);
                }
                let (read, mut write) = stream.split();
                let mut line = String::new();
                BufReader::new(read).read_line(&mut line).await.unwrap();
                let request: Request = serde_json::from_str(&line).unwrap();
                let reply = match (verb, request) {
                    (ClientVerb::Open, Request::OpenWorkspace { workspace_path, .. }) => {
                        assert_eq!(workspace_path, "/private/notes");
                        Response::Opened {
                            desktop_version: CHAN_VERSION.into(),
                            capabilities: Capabilities {
                                open_local_workspace: true,
                            },
                        }
                    }
                    (
                        ClientVerb::Close,
                        Request::CloseWorkspace {
                            workspace_path,
                            remove,
                            ..
                        },
                    ) => {
                        assert_eq!(workspace_path, "/private/notes");
                        assert!(remove);
                        Response::Closed {
                            desktop_version: CHAN_VERSION.into(),
                        }
                    }
                    (
                        ClientVerb::Devserver,
                        Request::OpenDevserver {
                            url, name, script, ..
                        },
                    ) => {
                        assert_eq!(url, "http://localhost:8787?t=private");
                        assert_eq!(name.as_deref(), Some("label"));
                        assert_eq!(script.as_deref(), Some("script"));
                        Response::DevserverRegistered {
                            desktop_version: CHAN_VERSION.into(),
                        }
                    }
                    (ClientVerb::Control, Request::ListDevservers { .. }) => Response::Devservers {
                        desktop_version: CHAN_VERSION.into(),
                        devservers: Vec::new(),
                    },
                    (ClientVerb::Upgrade, Request::Upgrade { check_only, .. }) => {
                        assert!(check_only);
                        Response::UpgradeStarted {
                            desktop_version: CHAN_VERSION.into(),
                        }
                    }
                    other => panic!("unexpected request: {other:?}"),
                };
                let mut payload = serde_json::to_vec(&reply).unwrap();
                payload.push(b'\n');
                write.write_all(&payload).await.unwrap();
                Some(line)
            };
            let (success, received) = tokio::join!(client, server);
            eprintln!(
                "{verb:?} {}: success={success}, received={received:?}",
                path.file_name().unwrap().to_string_lossy()
            );
            observed.push((success, received.is_some()));
        }
        assert_eq!(observed, vec![(false, false), (true, true)]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_workspace_client_requires_an_owned_socket() {
        assert_client_socket_gate(ClientVerb::Open).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn close_workspace_client_requires_an_owned_socket() {
        assert_client_socket_gate(ClientVerb::Close).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn open_devserver_client_requires_an_owned_socket() {
        assert_client_socket_gate(ClientVerb::Devserver).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn devserver_control_client_requires_an_owned_socket() {
        assert_client_socket_gate(ClientVerb::Control).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn upgrade_client_requires_an_owned_socket() {
        assert_client_socket_gate(ClientVerb::Upgrade).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn liveness_client_requires_an_owned_socket() {
        assert_client_socket_gate(ClientVerb::Probe).await;
    }
    use super::*;

    #[test]
    fn request_round_trips() {
        let req = Request::OpenWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            workspace_path: "/tmp/notes".into(),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"open_workspace\""));
        let back: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);

        let upgrade = Request::Upgrade {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            check_only: true,
        };
        let json = serde_json::to_string(&upgrade).unwrap();
        assert!(json.contains("\"type\":\"upgrade\""));
        assert_eq!(upgrade, serde_json::from_str::<Request>(&json).unwrap());
        assert_eq!(upgrade.protocol(), PROTOCOL_VERSION);
        assert_eq!(upgrade.cli_version(), "9.9.9");

        let devserver = Request::OpenDevserver {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            url: "https://box.example.com:8787".into(),
            name: Some("box".into()),
            script: None,
        };
        let json = serde_json::to_string(&devserver).unwrap();
        assert!(json.contains("\"type\":\"open_devserver\""));
        assert!(json.contains("\"url\":\"https://box.example.com:8787\""));
        assert_eq!(devserver, serde_json::from_str::<Request>(&json).unwrap());

        let close = Request::CloseWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            workspace_path: "/tmp/notes".into(),
            remove: true,
        };
        let json = serde_json::to_string(&close).unwrap();
        assert!(json.contains("\"type\":\"close_workspace\""));
        assert!(json.contains("\"remove\":true"));
        assert_eq!(close, serde_json::from_str::<Request>(&json).unwrap());
        assert_eq!(close.protocol(), PROTOCOL_VERSION);
        assert_eq!(close.cli_version(), "9.9.9");

        let ls = Request::ListDevservers {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
        };
        let json = serde_json::to_string(&ls).unwrap();
        assert!(json.contains("\"type\":\"list_devservers\""));
        assert_eq!(ls, serde_json::from_str::<Request>(&json).unwrap());
        assert_eq!(ls.protocol(), PROTOCOL_VERSION);
        assert_eq!(ls.cli_version(), "9.9.9");

        let connect = Request::ConnectDevserver {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            target: "lab".into(),
        };
        let json = serde_json::to_string(&connect).unwrap();
        assert!(json.contains("\"type\":\"connect_devserver\""));
        assert!(json.contains("\"target\":\"lab\""));
        assert_eq!(connect, serde_json::from_str::<Request>(&json).unwrap());

        let disconnect = Request::DisconnectDevserver {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            target: "https://box.example.com:8787".into(),
        };
        let json = serde_json::to_string(&disconnect).unwrap();
        assert!(json.contains("\"type\":\"disconnect_devserver\""));
        assert_eq!(disconnect, serde_json::from_str::<Request>(&json).unwrap());

        let forget = Request::ForgetDevserver {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            target: "lab".into(),
            force: true,
        };
        let json = serde_json::to_string(&forget).unwrap();
        assert!(json.contains("\"type\":\"forget_devserver\""));
        assert!(json.contains("\"force\":true"));
        assert_eq!(forget, serde_json::from_str::<Request>(&json).unwrap());
        assert_eq!(forget.protocol(), PROTOCOL_VERSION);
        assert_eq!(forget.cli_version(), "9.9.9");
    }

    #[test]
    fn response_round_trips() {
        let resp = Response::Opened {
            desktop_version: CHAN_VERSION.into(),
            capabilities: Capabilities {
                open_local_workspace: true,
            },
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"status\":\"opened\""));
        let back: Response = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);

        let skew = Response::VersionSkew {
            desktop_version: "0.1.0".into(),
            desktop_protocol: 99,
        };
        let json = serde_json::to_string(&skew).unwrap();
        assert!(json.contains("\"status\":\"version_skew\""));
        assert_eq!(skew, serde_json::from_str::<Response>(&json).unwrap());

        let started = Response::UpgradeStarted {
            desktop_version: CHAN_VERSION.into(),
        };
        let json = serde_json::to_string(&started).unwrap();
        assert!(json.contains("\"status\":\"upgrade_started\""));
        assert_eq!(started, serde_json::from_str::<Response>(&json).unwrap());

        let checked = Response::UpgradeChecked {
            desktop_version: CHAN_VERSION.into(),
            available: Some("9.9.9".into()),
        };
        let json = serde_json::to_string(&checked).unwrap();
        assert!(json.contains("\"status\":\"upgrade_checked\""));
        assert_eq!(checked, serde_json::from_str::<Response>(&json).unwrap());

        let registered = Response::DevserverRegistered {
            desktop_version: CHAN_VERSION.into(),
        };
        let json = serde_json::to_string(&registered).unwrap();
        assert!(json.contains("\"status\":\"devserver_registered\""));
        assert_eq!(registered, serde_json::from_str::<Response>(&json).unwrap());

        let closed = Response::Closed {
            desktop_version: CHAN_VERSION.into(),
        };
        let json = serde_json::to_string(&closed).unwrap();
        assert!(json.contains("\"status\":\"closed\""));
        assert_eq!(closed, serde_json::from_str::<Response>(&json).unwrap());

        let not_served = Response::NotServed {
            desktop_version: CHAN_VERSION.into(),
        };
        let json = serde_json::to_string(&not_served).unwrap();
        assert!(json.contains("\"status\":\"not_served\""));
        assert_eq!(not_served, serde_json::from_str::<Response>(&json).unwrap());

        let refused = Response::CloseRefused {
            error: "live_terminals".into(),
            active_terminals: 2,
        };
        let json = serde_json::to_string(&refused).unwrap();
        assert_eq!(refused, serde_json::from_str::<Response>(&json).unwrap());
        assert!(json.contains("\"status\":\"close_refused\""));
        assert!(json.contains("\"error\":\"live_terminals\""));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn map_close_response_maps_variants() {
        // `Closed` is the only success; everything else falls back so the CLI
        // drops to the per-pid control-socket teardown rather than guessing.
        let closed = format!("{{\"status\":\"closed\",\"desktop_version\":\"{CHAN_VERSION}\"}}");
        assert!(matches!(map_close_response(&closed), Outcome::HandedOff));

        let not_served =
            format!("{{\"status\":\"not_served\",\"desktop_version\":\"{CHAN_VERSION}\"}}");
        assert!(matches!(
            map_close_response(&not_served),
            Outcome::NotServed
        ));

        let refused =
            "{\"status\":\"close_refused\",\"error\":\"live_terminals\",\"active_terminals\":2}";
        assert!(matches!(
            map_close_response(refused),
            Outcome::CloseRefused {
                active_terminals: 2
            }
        ));

        let skew =
            "{\"status\":\"version_skew\",\"desktop_version\":\"0.1.0\",\"desktop_protocol\":99}";
        assert!(matches!(
            map_close_response(skew),
            Outcome::VersionSkew { .. }
        ));

        let err = "{\"status\":\"error\",\"message\":\"nope\"}";
        assert!(matches!(
            map_close_response(err),
            Outcome::DesktopError { .. }
        ));

        // An open-workspace reply to a close request (a desktop we can't talk to
        // sanely) and unparseable lines both fall back.
        let opened = format!(
            "{{\"status\":\"opened\",\"desktop_version\":\"{CHAN_VERSION}\",\
             \"capabilities\":{{\"open_local_workspace\":true}}}}"
        );
        assert!(matches!(map_close_response(&opened), Outcome::NoDesktop));
        assert!(matches!(map_close_response("not json"), Outcome::NoDesktop));
    }

    /// What the desktop answers for each outcome of its host's close, read
    /// back over the wire the way the CLI reads it. Only a completed close is
    /// handed off; a root the host does not serve sends the CLI on to the
    /// writer lock's holder.
    #[cfg(any(unix, windows))]
    #[test]
    fn a_close_outcome_reaches_the_cli_as_what_it_was() {
        use chan_library::WorkspaceLifecycleOutcome;
        let read = |outcome| {
            let line = serde_json::to_string(&Response::from_close_outcome(outcome)).unwrap();
            map_close_response(&line)
        };
        assert!(matches!(
            read(Ok(WorkspaceLifecycleOutcome::Completed)),
            Outcome::HandedOff
        ));
        assert!(matches!(
            read(Ok(WorkspaceLifecycleOutcome::NotFound)),
            Outcome::NotServed
        ));
        assert!(matches!(
            read(Ok(WorkspaceLifecycleOutcome::Refused {
                active_terminals: 3
            })),
            Outcome::CloseRefused {
                active_terminals: 3
            }
        ));
        assert!(matches!(
            read(Err("removing /srv/notes: workspace is still releasing; retry".into())),
            Outcome::DesktopError { message }
                if message == "removing /srv/notes: workspace is still releasing; retry"
        ));
    }

    #[test]
    fn opt_out_parsing() {
        // Snapshot + restore so the test is order-independent.
        let prev = std::env::var_os("CHAN_NO_DESKTOP_HANDOFF");
        std::env::remove_var("CHAN_NO_DESKTOP_HANDOFF");
        assert!(!handoff_opt_out());
        std::env::set_var("CHAN_NO_DESKTOP_HANDOFF", "1");
        assert!(handoff_opt_out());
        std::env::set_var("CHAN_NO_DESKTOP_HANDOFF", "0");
        assert!(!handoff_opt_out());
        std::env::set_var("CHAN_NO_DESKTOP_HANDOFF", "");
        assert!(!handoff_opt_out());
        match prev {
            Some(v) => std::env::set_var("CHAN_NO_DESKTOP_HANDOFF", v),
            None => std::env::remove_var("CHAN_NO_DESKTOP_HANDOFF"),
        }
    }

    #[test]
    fn forced_parsing() {
        // Pins the `CHAN_DESKTOP_HANDOFF` name -- the desktop shim sets it to opt
        // the bundled console chan.exe into the handoff; a rename here would
        // silently break that cross-crate contract. Snapshot + restore for
        // order-independence.
        let prev = std::env::var_os("CHAN_DESKTOP_HANDOFF");
        std::env::remove_var("CHAN_DESKTOP_HANDOFF");
        assert!(!handoff_forced());
        std::env::set_var("CHAN_DESKTOP_HANDOFF", "1");
        assert!(handoff_forced());
        std::env::set_var("CHAN_DESKTOP_HANDOFF", "0");
        assert!(!handoff_forced());
        std::env::set_var("CHAN_DESKTOP_HANDOFF", "");
        assert!(!handoff_forced());
        match prev {
            Some(v) => std::env::set_var("CHAN_DESKTOP_HANDOFF", v),
            None => std::env::remove_var("CHAN_DESKTOP_HANDOFF"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn well_known_path_is_some_on_unix() {
        // Don't assert the exact value (env-dependent); just that unix
        // always resolves a path and it ends in the expected filename.
        let p = well_known_socket_path().expect("unix path");
        let s = p.to_string_lossy();
        assert!(s.contains("chan-desktop"), "unexpected path: {s}");
    }

    #[cfg(unix)]
    #[test]
    fn owner_dir_ensure_creates_0700_and_repairs_perms() {
        use std::os::unix::fs::PermissionsExt;

        let base = tempfile::tempdir().unwrap();
        let dir = base.path().join("chan-desktop-test");
        ensure_owner_dir_at(&dir).expect("fresh create");
        let mode = std::fs::symlink_metadata(&dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
        // Idempotent, and a loosened mode is forced back to 0700 only after
        // the ownership check passed.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_owner_dir_at(&dir).expect("revalidate");
        let mode = std::fs::symlink_metadata(&dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn owner_dir_refuses_non_directory_nodes() {
        use std::os::unix::fs::PermissionsExt;

        let base = tempfile::tempdir().unwrap();

        // A squatter's plain file where the directory should be.
        let as_file = base.path().join("file-squat");
        std::fs::write(&as_file, b"x").unwrap();
        assert_eq!(
            ensure_owner_dir_at(&as_file).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(existing_owner_dir_at(&as_file).is_err());

        // A symlink to a real owned directory: lstat must refuse it.
        let real = base.path().join("real-dir");
        std::fs::create_dir(&real).unwrap();
        let link = base.path().join("link-squat");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(ensure_owner_dir_at(&link).is_err());
        assert!(existing_owner_dir_at(&link).is_err());

        // The validate-only twin never creates: a missing dir is an error and
        // stays missing; a non-0700 dir is refused rather than repaired.
        let missing = base.path().join("missing");
        assert!(existing_owner_dir_at(&missing).is_err());
        assert!(!missing.exists());
        let loose = base.path().join("loose");
        std::fs::create_dir(&loose).unwrap();
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(existing_owner_dir_at(&loose).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn handoff_send_gate_requires_an_owned_real_socket() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sock");
        let dispatched = Arc::new(AtomicBool::new(false));
        let dispatched_cb = dispatched.clone();
        let _handle = start_listener(real.clone(), move |_req| {
            let dispatched_cb = dispatched_cb.clone();
            async move {
                dispatched_cb.store(true, Ordering::SeqCst);
                Response::Opened {
                    desktop_version: CHAN_VERSION.into(),
                    capabilities: Capabilities {
                        open_local_workspace: true,
                    },
                }
            }
        })
        .unwrap();

        // A symlink to the real socket is a redirection, not the endpoint:
        // lstat refuses it before any request bytes are written.
        let link = dir.path().join("link.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(!socket_is_owner_controlled(&link));
        assert!(matches!(
            try_handoff_at(&link, Path::new("/tmp/notes")).await,
            Outcome::NoDesktop
        ));
        assert!(
            !dispatched.load(Ordering::SeqCst),
            "no request may flow through a symlinked node"
        );

        // A plain file is not a socket either.
        let file = dir.path().join("file.sock");
        std::fs::write(&file, b"x").unwrap();
        assert!(matches!(
            try_handoff_at(&file, Path::new("/tmp/notes")).await,
            Outcome::NoDesktop
        ));

        // The real, owned socket passes the gate and hands off.
        assert!(socket_is_owner_controlled(&real));
        assert!(matches!(
            try_handoff_at(&real, Path::new("/tmp/notes")).await,
            Outcome::HandedOff
        ));
        assert!(dispatched.load(Ordering::SeqCst));
    }

    /// Windows resolves the endpoint in the `\\.\pipe\` namespace, named by
    /// this account's SID and not by its user name.
    #[cfg(windows)]
    #[test]
    fn well_known_path_is_named_pipe_on_windows() {
        let sid = chan_winpipe::current_account_sid().unwrap();
        assert_eq!(
            well_known_socket_path().expect("windows path"),
            PathBuf::from(format!(r"\\.\pipe\chan-desktop-{sid}"))
        );
    }

    /// Every Windows client, the probe and each request, opens the endpoint
    /// through `connect_endpoint_as`, so none writes before the check of the
    /// server's account: the module opens a pipe as a client in that one
    /// place.
    #[test]
    fn every_windows_client_opens_the_endpoint_through_the_account_check() {
        let source = include_str!("handoff.rs");
        let (production, _) = source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module");
        assert_eq!(production.matches("ClientOptions::new()").count(), 1);
        let (_, check) = production
            .split_once("async fn connect_endpoint_as(")
            .expect("the account check");
        let (check, _) = check.split_once("\n}\n").expect("its end");
        assert!(check.contains("ClientOptions::new()"));
        assert!(check.contains("chan_winpipe::server_account_sid(&client)"));
    }

    /// Two accounts, whose user names may filter to one name, have two
    /// endpoints, and neither account's endpoint is the other's claim pipe.
    #[test]
    fn each_account_has_an_endpoint_of_its_own() {
        let first = endpoint_for_account("S-1-5-21-1-2-3-1001");
        let second = endpoint_for_account("S-1-5-21-1-2-3-1002");
        assert_eq!(
            first,
            PathBuf::from(r"\\.\pipe\chan-desktop-S-1-5-21-1-2-3-1001")
        );
        assert_ne!(first, second);
        for (endpoint, other) in [(&first, &second), (&second, &first)] {
            assert_eq!(
                claim_pipe_name(endpoint),
                std::ffi::OsString::from(format!("{}.claim", endpoint.display()))
            );
            assert_ne!(claim_pipe_name(endpoint), other.as_os_str());
            assert_ne!(claim_pipe_name(endpoint), claim_pipe_name(other));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dispatch_rejects_protocol_skew() {
        let req = Request::OpenWorkspace {
            protocol: PROTOCOL_VERSION + 1,
            cli_version: "9.9.9".into(),
            workspace_path: "/tmp/notes".into(),
        };
        // The handler returns a distinctive Opened; getting VersionSkew back
        // proves dispatch short-circuited and never ran the handler.
        let handler = |_r: Request| async {
            Response::Opened {
                desktop_version: CHAN_VERSION.into(),
                capabilities: Capabilities {
                    open_local_workspace: true,
                },
            }
        };
        match dispatch(req, &handler).await {
            Response::VersionSkew {
                desktop_protocol, ..
            } => assert_eq!(desktop_protocol, PROTOCOL_VERSION),
            other => panic!("expected VersionSkew, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dispatch_runs_handler_on_match() {
        let req = Request::OpenWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: "/tmp/notes".into(),
        };
        let handler = |_r: Request| async {
            Response::Error {
                message: "mount failed".to_string(),
            }
        };
        match dispatch(req, &handler).await {
            Response::Error { message } => assert_eq!(message, "mount failed"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_liveness_probe_is_connect_only_and_wedged_safe() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("live.sock");
        let handled = Arc::new(AtomicBool::new(false));
        let handled_cb = handled.clone();
        let _handle = start_listener(sock.clone(), move |_req| {
            let handled_cb = handled_cb.clone();
            async move {
                handled_cb.store(true, Ordering::SeqCst);
                std::future::pending::<Response>().await
            }
        })
        .unwrap();

        assert!(desktop_is_live_at(&sock).await);
        tokio::task::yield_now().await;
        assert!(
            !handled.load(Ordering::SeqCst),
            "connect-only liveness must not dispatch a request"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_liveness_probe_bounds_missing_and_stale_sockets() {
        const STALE_SOCKET_CHILD: &str = "CHAN_TEST_HANDOFF_STALE_SOCKET_CHILD";

        if let Some(path) = std::env::var_os(STALE_SOCKET_CHILD) {
            drop(std::os::unix::net::UnixListener::bind(path).unwrap());
            return;
        }

        let caller = std::thread::current()
            .name()
            .expect("libtest caller name")
            .to_owned();
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.sock");
        let missing_result =
            tokio::time::timeout(Duration::from_secs(1), desktop_is_live_at(&missing))
                .await
                .expect("missing-socket probe must stay bounded");
        assert!(!missing_result);

        let stale = dir.path().join("stale.sock");
        // Bind after exec in a single-test child, then wait for it to exit. The
        // parent never owns the listener fd, so another parent test's fork
        // cannot inherit it and keep the supposedly stale socket alive.
        let output = tokio::process::Command::new(std::env::current_exe().expect("test binary"))
            .arg("--exact")
            .arg("handoff::tests::desktop_liveness_probe_bounds_missing_and_stale_sockets")
            .arg("--nocapture")
            .arg("--test-threads=2")
            .arg("--color=never")
            .env(STALE_SOCKET_CHILD, &stale)
            .output()
            .await
            .expect("run stale-socket child");
        assert!(
            output.status.success(),
            "stale-socket child failed (status={}):\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("test result: ok. 1 passed;"),
            "stale-socket child did not run one test:\n{stdout}"
        );
        let passed = format!("test {caller} ... ok");
        assert!(
            stdout.lines().any(|line| line == passed),
            "stale-socket child did not run its caller: {caller}\n{stdout}"
        );
        assert!(stale.exists(), "stale socket node should remain");
        let stale_result = tokio::time::timeout(Duration::from_secs(1), desktop_is_live_at(&stale))
            .await
            .expect("stale-socket probe must stay bounded");
        assert!(!stale_result);
    }

    /// A stopping listener waits exactly as long as the most patient client.
    #[cfg(any(unix, windows))]
    #[test]
    fn connection_drain_matches_the_longest_reply_budget() {
        let serve = Request::ServeRemoteWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            target: "lab".into(),
            workspace_path: "/srv/notes".into(),
        };
        assert_eq!(CONNECTION_DRAIN_TIMEOUT, serve.reply_budget());
        #[cfg(unix)]
        assert!(CONNECTION_DRAIN_TIMEOUT >= UPGRADE_IO_TIMEOUT);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_listener_reclaims_a_stale_socket_node() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("stale.sock");
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
        assert!(sock.exists(), "stale socket node should remain");

        let _handle = start_listener(sock.clone(), |_req| async {
            Response::Opened {
                desktop_version: CHAN_VERSION.into(),
                capabilities: Capabilities {
                    open_local_workspace: true,
                },
            }
        })
        .expect("a dead owner's socket node must be reclaimed");

        assert!(matches!(
            request_over(&sock, "/tmp/notes").await,
            Response::Opened { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_listener_does_not_clobber_a_live_owner() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("owned.sock");
        let _first = start_listener(sock.clone(), |_req| async {
            Response::Error {
                message: "first listener".into(),
            }
        })
        .unwrap();

        let error = match start_listener(sock.clone(), |_req| async {
            Response::Error {
                message: "second listener".into(),
            }
        }) {
            Ok(_) => panic!("a second listener must not take a live owner's socket"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);

        match request_over(&sock, "/tmp/notes").await {
            Response::Error { message } => assert_eq!(message, "first listener"),
            other => panic!("expected the first listener, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_refuses_a_different_uid_before_dispatch() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("uid.sock");
        let handled = Arc::new(AtomicBool::new(false));
        let handled_cb = handled.clone();
        let resolved = Arc::new(AtomicBool::new(false));
        let resolved_cb = resolved.clone();
        let wrong_uid = rustix::process::geteuid().as_raw().wrapping_add(1);
        let _handle = start_listener_with_peer_uid(
            claim_endpoint_at(&sock).unwrap(),
            move |_req| {
                let handled_cb = handled_cb.clone();
                async move {
                    handled_cb.store(true, Ordering::SeqCst);
                    Response::Error {
                        message: "must not dispatch".into(),
                    }
                }
            },
            move |_stream| {
                resolved_cb.store(true, Ordering::SeqCst);
                Ok(wrong_uid)
            },
        )
        .unwrap();

        let mut stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
        let req = Request::OpenWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: "/tmp/notes".into(),
        };
        let mut payload = serde_json::to_vec(&req).unwrap();
        payload.push(b'\n');
        let _ = stream.write_all(&payload).await;

        tokio::time::timeout(Duration::from_secs(1), async {
            while !resolved.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("peer uid resolver should run");

        let mut byte = [0_u8; 1];
        match tokio::time::timeout(Duration::from_secs(1), stream.read(&mut byte)).await {
            Ok(Ok(0)) | Ok(Err(_)) => {}
            Ok(Ok(n)) => panic!("refused peer received {n} response bytes"),
            Err(_) => panic!("refused peer connection remained open"),
        }
        assert!(
            !handled.load(Ordering::SeqCst),
            "uid refusal must happen before dispatch"
        );
    }

    /// A request over the listener's byte cap is refused, and the client
    /// reports that refusal although its own write fails: the listener stops
    /// reading at the cap, writes the refusal and closes, so the rest of the
    /// request meets a broken pipe while the refusal waits in the client's
    /// receive buffer. The request is several times the cap, so the part the
    /// listener never reads cannot fit in the socket's buffers and the write
    /// cannot complete before the close.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_over_cap_request_reports_the_refusal_its_failed_write_left() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("cap.sock");
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = std::sync::Arc::clone(&calls);
        let _listener = start_listener(sock.clone(), move |_req| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async {
                Response::Closed {
                    desktop_version: CHAN_VERSION.into(),
                }
            }
        })
        .unwrap();
        let workspace = "x".repeat(8 * MAX_HANDOFF_REQUEST_BYTES as usize);
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            try_handoff_at(&sock, Path::new(&workspace)),
        )
        .await
        .expect("the client did not answer");
        match outcome {
            Outcome::DesktopError { message } => assert!(
                message.starts_with("invalid handoff request:"),
                "the client reported another error: {message}"
            ),
            other => panic!("the client did not report the listener's refusal: {other:?}"),
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// A listener stop owes an accepted connection its reply: it may not
    /// return while the handler is still answering, and the client still
    /// reads the reply afterwards.
    #[cfg(unix)]
    #[tokio::test]
    async fn listener_stop_waits_for_an_in_flight_reply() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("stop.sock");
        let (entered_tx, entered) = tokio::sync::oneshot::channel();
        let entered_tx = std::sync::Mutex::new(Some(entered_tx));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let answering = Arc::clone(&release);
        let handle = start_listener(sock.clone(), move |_req| {
            let entered = entered_tx.lock().unwrap().take();
            let release = Arc::clone(&answering);
            async move {
                if let Some(entered) = entered {
                    let _ = entered.send(());
                }
                let _permit = release.acquire().await.unwrap();
                Response::Opened {
                    desktop_version: CHAN_VERSION.into(),
                    capabilities: Capabilities {
                        open_local_workspace: true,
                    },
                }
            }
        })
        .unwrap();
        let client_sock = sock.clone();
        let client = tokio::spawn(async move { request_over(&client_sock, "/tmp/notes").await });
        tokio::time::timeout(Duration::from_secs(10), entered)
            .await
            .expect("the request never reached the handler")
            .unwrap();

        let stop = tokio::spawn(handle.shutdown());
        // The listener has taken the stop once it refuses a new peer.
        while tokio::net::UnixStream::connect(&sock).await.is_ok() {
            tokio::task::yield_now().await;
        }
        assert!(
            !stop.is_finished(),
            "the listener stop returned while an accepted connection still owed its reply"
        );

        release.add_permits(1);
        assert!(matches!(client.await.unwrap(), Response::Opened { .. }));
        tokio::time::timeout(Duration::from_secs(10), stop)
            .await
            .expect("the stop outlived its last connection")
            .unwrap();
    }

    /// A connection that never finishes cannot hold a stop forever: past the
    /// drain bound the listener aborts it, and its client reads the end of
    /// the stream rather than a reply.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn listener_stop_aborts_a_connection_past_the_drain_bound() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("stuck.sock");
        let (entered_tx, entered) = tokio::sync::oneshot::channel();
        let entered_tx = std::sync::Mutex::new(Some(entered_tx));
        let handle = start_listener(sock.clone(), move |_req| {
            let entered = entered_tx.lock().unwrap().take();
            async move {
                if let Some(entered) = entered {
                    let _ = entered.send(());
                }
                std::future::pending::<Response>().await
            }
        })
        .unwrap();
        let (read, mut write) = tokio::net::UnixStream::connect(&sock)
            .await
            .unwrap()
            .into_split();
        let mut payload = serde_json::to_vec(&Request::OpenWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: "/tmp/notes".into(),
        })
        .unwrap();
        payload.push(b'\n');
        write.write_all(&payload).await.unwrap();
        entered.await.expect("the request reached the handler");

        let started = tokio::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(300), handle.shutdown())
            .await
            .expect("a stuck connection held the stop past its drain bound");
        assert!(
            started.elapsed() >= CONNECTION_DRAIN_TIMEOUT,
            "the stop aborted a connection before the drain bound"
        );
        let mut line = String::new();
        let read = BufReader::new(read).read_line(&mut line).await.unwrap();
        assert_eq!(read, 0, "the aborted connection still answered: {line:?}");
    }

    // End-to-end: a listener bound on a temp socket + a client request
    // over try_handoff's wire path (we point the well-known resolver at
    // the temp socket by connecting directly through a sibling helper).
    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_opened() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let opened = Arc::new(AtomicBool::new(false));
        let opened_cb = opened.clone();
        let _handle = start_listener(sock.clone(), move |req| {
            let opened_cb = opened_cb.clone();
            async move {
                match req {
                    Request::OpenWorkspace { workspace_path, .. } => {
                        assert_eq!(workspace_path, "/tmp/notes");
                        opened_cb.store(true, Ordering::SeqCst);
                        Response::Opened {
                            desktop_version: CHAN_VERSION.into(),
                            capabilities: Capabilities {
                                open_local_workspace: true,
                            },
                        }
                    }
                    Request::Upgrade { .. } => Response::Error {
                        message: "unexpected upgrade".into(),
                    },
                    Request::OpenDevserver { .. } => Response::Error {
                        message: "unexpected open_devserver".into(),
                    },
                    Request::CloseWorkspace { .. } => Response::Error {
                        message: "unexpected close".into(),
                    },
                    Request::ListDevservers { .. }
                    | Request::ConnectDevserver { .. }
                    | Request::DisconnectDevserver { .. }
                    | Request::ForgetDevserver { .. }
                    | Request::ServeRemoteWorkspace { .. }
                    | Request::CloseRemoteWorkspace { .. }
                    | Request::ForgetRemoteWorkspace { .. } => Response::Error {
                        message: "unexpected devserver control".into(),
                    },
                    Request::OpenTerminal { .. } => Response::Error {
                        message: "unexpected open_terminal".into(),
                    },
                    Request::Activate { .. } => Response::Error {
                        message: "unexpected activate".into(),
                    },
                    Request::OpenPath { .. } => Response::Error {
                        message: "unexpected open_path".into(),
                    },
                }
            }
        })
        .unwrap();

        // The socket should be 0600.
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "socket perms should be 0600");

        let resp = request_over(&sock, "/tmp/notes").await;
        assert!(matches!(resp, Response::Opened { .. }));
        assert!(opened.load(Ordering::SeqCst), "handler must have run");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_terminal_opened() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), move |req| async move {
            match req {
                Request::OpenTerminal { cwd, .. } if cwd == "/tmp/proj" => {
                    Response::TerminalOpened {
                        desktop_version: CHAN_VERSION.into(),
                    }
                }
                other => Response::Error {
                    message: format!("unexpected request {other:?}"),
                },
            }
        })
        .unwrap();
        let req = Request::OpenTerminal {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            cwd: "/tmp/proj".into(),
        };
        match try_devserver_control_at(&sock, req).await {
            DevserverControlOutcome::Reply(Response::TerminalOpened { desktop_version }) => {
                assert_eq!(desktop_version, CHAN_VERSION)
            }
            other => panic!("expected TerminalOpened, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_error() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), move |_req| async move {
            Response::Error {
                message: "no such workspace".to_string(),
            }
        })
        .unwrap();
        let resp = request_over(&sock, "/tmp/x").await;
        match resp {
            Response::Error { message } => assert_eq!(message, "no such workspace"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// The listener answers what its handler says for an `Activate`, which
    /// travels as the additive `activate` tag (PROTOCOL_VERSION stays 1), and
    /// the client reads `Activated` as coming forward.
    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_activated() {
        let json = serde_json::to_string(&activate_request()).unwrap();
        assert!(json.contains("\"type\":\"activate\""), "{json}");
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), move |req| async move {
            match req {
                Request::Activate { protocol, .. } => {
                    assert_eq!(protocol, PROTOCOL_VERSION);
                    Response::Activated {
                        desktop_version: "9.9.9".into(),
                    }
                }
                other => Response::Error {
                    message: format!("unexpected {other:?}"),
                },
            }
        })
        .unwrap();
        assert_eq!(
            try_activate_at(&sock, Duration::from_secs(3)).await,
            ActivateReply::Activated {
                desktop_version: "9.9.9".into()
            }
        );
    }

    /// The open-path request on the wire, as a launch given a path sends it:
    /// the additive `open_path` tag (PROTOCOL_VERSION stays 1), answered by a
    /// listener whose handler is the desktop's, `answer_open_path` over a host
    /// with the real standalone surface, so the path lands in a standalone
    /// window; the launch's client reads that answer as an open.
    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_open_path() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let (host, _cfg) = crate::control_socket::standalone_host().await;
        let files = tempfile::tempdir().unwrap();
        let notes = files.path().join("notes.md");
        std::fs::write(&notes, "# notes\n").unwrap();
        let notes_text = notes.to_str().unwrap().to_string();
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let serving = std::sync::Arc::clone(&host);
        let _handle = start_listener(sock.clone(), move |req| {
            let host = std::sync::Arc::clone(&serving);
            async move {
                match req {
                    Request::OpenPath { path, .. } => answer_open_path(&host, &path).await,
                    other => Response::Error {
                        message: format!("unexpected {other:?}"),
                    },
                }
            }
        })
        .unwrap();

        let request = serde_json::json!({
            "type": "open_path",
            "protocol": 1,
            "cli_version": "0.0.0",
            "path": notes_text,
        });
        let stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
        let (read, mut write) = stream.into_split();
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        BufReader::new(read).read_line(&mut line).await.unwrap();
        let windows = crate::control_socket::standalone_windows(&host);
        let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            reply,
            serde_json::json!({
                "status": "path_opened",
                "desktop_version": CHAN_VERSION,
                "message": format!(
                    "open request queued for /{} in standalone window {} (opening)",
                    crate::control_socket::machine_path(&notes),
                    windows.first().map(String::as_str).unwrap_or("<none minted>"),
                ),
            }),
            "{line}"
        );
        assert_eq!(windows.len(), 1, "{windows:?}");

        assert_eq!(
            try_open_path_at(&sock, &notes_text, Duration::from_secs(3)).await,
            OpenPathReply::Opened {
                desktop_version: CHAN_VERSION.into(),
                message: format!(
                    "open request queued for /{} in standalone window {}",
                    crate::control_socket::machine_path(&notes),
                    windows[0],
                ),
            }
        );
        assert_eq!(
            serde_json::to_value(Request::OpenPath {
                protocol: PROTOCOL_VERSION,
                cli_version: "0.0.0".into(),
                path: notes_text.clone(),
            })
            .unwrap(),
            request,
            "the client sends the shape the listener reads"
        );
    }

    /// The line a listener that predates `OpenPath` writes for one, read from
    /// the listener of the release before it.
    #[cfg(unix)]
    const OLDER_DESKTOP_OPEN_PATH_REPLY: &str = concat!(
        r#"{"status":"error","message":"invalid handoff request: unknown variant `open_path`, expected one of `open_workspace`, `upgrade`, `open_devserver`, `close_workspace`, `list_devservers`, `connect_devserver`, `disconnect_devserver`, `forget_devserver`, `serve_remote_workspace`, `close_remote_workspace`, `forget_remote_workspace`, `open_terminal`, `activate` at line 1 column 77"}"#,
        "\n"
    );

    /// A desktop that predates `OpenPath` answers it the way every listener
    /// answers a type it does not know, and the launch's client reads that
    /// line as a refusal from a live desktop, not as no desktop at all.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_open_path_to_an_older_desktop_is_refused_not_unanswered() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("old.sock");
        let _claim = claim_endpoint_at(&sock).unwrap();
        let server = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            assert!(line.contains("\"type\":\"open_path\""), "{line}");
            write
                .write_all(OLDER_DESKTOP_OPEN_PATH_REPLY.as_bytes())
                .await
                .unwrap();
        });
        assert_eq!(
            try_open_path_at(&sock, "/srv/notes.md", Duration::from_secs(3)).await,
            OpenPathReply::Refused {
                reply: OLDER_DESKTOP_OPEN_PATH_REPLY.trim().to_string()
            }
        );
    }

    /// The CLI tells no desktop from one that is running and gave no answer:
    /// only the first lets it start a desktop.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_clis_open_path_tells_no_listener_from_a_silent_one() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = tempfile::tempdir().unwrap();
        let budget = Duration::from_millis(300);
        let absent = dir.path().join("absent.sock");
        assert_eq!(
            try_open_path_from_cli_at(&absent, "/srv/a.md", budget).await,
            CliOpenPath::NotListening
        );

        // Bound and never accepted on: the kernel completes the connect, and
        // nothing ever reads the request.
        let silent = dir.path().join("silent.sock");
        let _held = std::os::unix::net::UnixListener::bind(&silent).unwrap();
        assert_eq!(
            try_open_path_from_cli_at(&silent, "/srv/a.md", budget).await,
            CliOpenPath::Silent
        );

        let closing = dir.path().join("closing.sock");
        let listener = tokio::net::UnixListener::bind(&closing).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            drop(stream);
        });
        assert_eq!(
            try_open_path_from_cli_at(&closing, "/srv/a.md", budget).await,
            CliOpenPath::Silent
        );

        let answers = dir.path().join("answers.sock");
        let listener = tokio::net::UnixListener::bind(&answers).unwrap();
        tokio::spawn(async move {
            for reply in [
                r#"{"status":"path_opened","desktop_version":"0.0.0","message":"opened"}"#,
                r#"{"status":"error","message":"not editable text"}"#,
            ] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                BufReader::new(read).read_line(&mut line).await.unwrap();
                write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        assert_eq!(
            try_open_path_from_cli_at(&answers, "/srv/a.md", budget).await,
            CliOpenPath::Opened {
                message: "opened".into()
            }
        );
        assert_eq!(
            try_open_path_from_cli_at(&answers, "/srv/a.md", budget).await,
            CliOpenPath::Refused {
                reply: r#"{"status":"error","message":"not editable text"}"#.into()
            }
        );
    }

    /// The CLI's `OpenTerminal` tells no desktop from a silent one, as its
    /// `OpenPath` does, and the guard's reads an opened terminal as a desktop
    /// that came forward and every other answer as a refusal.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_open_terminal_tells_no_listener_from_a_silent_one() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = tempfile::tempdir().unwrap();
        let budget = Duration::from_millis(300);
        let absent = dir.path().join("absent.sock");
        assert_eq!(
            try_open_terminal_from_cli_at(&absent, "/srv", budget).await,
            CliOpenTerminal::NotListening
        );
        assert_eq!(
            try_open_terminal_at(&absent, "/srv", budget).await,
            ActivateReply::NoReply
        );
        let silent = dir.path().join("silent.sock");
        let _held = std::os::unix::net::UnixListener::bind(&silent).unwrap();
        assert_eq!(
            try_open_terminal_from_cli_at(&silent, "/srv", budget).await,
            CliOpenTerminal::Silent
        );

        let answers = dir.path().join("answers.sock");
        let listener = tokio::net::UnixListener::bind(&answers).unwrap();
        let (sent, mut requests) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            for reply in [
                r#"{"status":"terminal_opened","desktop_version":"0.0.0"}"#,
                r#"{"status":"error","message":"chan-desktop is shutting down"}"#,
                r#"{"status":"terminal_opened","desktop_version":"9.9.9"}"#,
            ] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                BufReader::new(read).read_line(&mut line).await.unwrap();
                sent.send(line).unwrap();
                write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        assert_eq!(
            try_open_terminal_from_cli_at(&answers, "/srv/a b", budget).await,
            CliOpenTerminal::Opened
        );
        let request: serde_json::Value =
            serde_json::from_str(&requests.recv().await.unwrap()).unwrap();
        assert_eq!(request["type"], "open_terminal");
        assert_eq!(request["cwd"], "/srv/a b");
        assert_eq!(
            try_open_terminal_from_cli_at(&answers, "/srv", budget).await,
            CliOpenTerminal::Refused {
                reply: r#"{"status":"error","message":"chan-desktop is shutting down"}"#.into()
            }
        );
        assert_eq!(
            try_open_terminal_at(&answers, "/srv", budget).await,
            ActivateReply::Activated {
                desktop_version: "9.9.9".into()
            }
        );
    }

    fn arg_path(arg: &str, cwd: Option<&str>) -> Result<String, String> {
        launch_arg_path(std::ffi::OsStr::new(arg), cwd.map(std::path::Path::new))
    }

    #[cfg(unix)]
    #[test]
    fn a_launch_argument_is_made_absolute_against_the_working_directory() {
        assert_eq!(
            arg_path("notes.md", Some("/home/u/work")),
            Ok("/home/u/work/notes.md".into())
        );
        assert_eq!(
            arg_path("./a b/c.md", Some("/home/u/work")),
            Ok("/home/u/work/./a b/c.md".into())
        );
        assert_eq!(
            arg_path("/srv/readme.md", None),
            Ok("/srv/readme.md".into())
        );
        assert_eq!(
            arg_path("notes.md", None),
            Err(
                "notes.md is relative and this launch has no working directory to resolve it in"
                    .into()
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_uri_launch_argument_is_percent_decoded() {
        for (uri, path) in [
            ("file:///tmp/a%20b.md", "/tmp/a b.md"),
            ("file://localhost/srv/caf%C3%A9.md", "/srv/caf\u{e9}.md"),
            ("file:///home/u/dir/", "/home/u/dir/"),
        ] {
            assert_eq!(arg_path(uri, None), Ok(path.into()), "{uri}");
        }
    }

    #[test]
    fn a_launch_argument_of_another_scheme_names_nothing_to_open() {
        for uri in [
            "smb://nas/share/notes.md",
            "https://example.com/notes.md",
            "mailto:someone@example.com",
        ] {
            assert_eq!(
                arg_path(uri, None),
                Err(format!(
                    "{uri} is not a file: chan opens files and directories, given as paths or \
                     file:// URIs"
                ))
            );
        }
    }

    /// The host is read before the URI becomes a path, on every platform:
    /// Windows would otherwise make `file://host/share/...` a UNC path.
    #[test]
    fn a_file_uri_on_another_host_names_nothing_to_open() {
        assert_eq!(
            arg_path("file://nas.local/share/notes.md", None),
            Err(
                "file://nas.local/share/notes.md names the host nas.local: chan opens files on \
                 this machine only"
                    .into()
            )
        );
    }

    /// Decoding `%2F` or `%00` would split a name or end it, so such a URI
    /// names no file.
    #[test]
    fn a_file_uri_encoding_a_slash_or_a_nul_in_a_name_names_nothing_to_open() {
        for uri in [
            "file:///srv/a%2Fb.md",
            "file:///srv/a%2fb.md",
            "file:///srv/a%00b.md",
        ] {
            assert_eq!(
                arg_path(uri, None),
                Err(format!(
                    "{uri} encodes a / or a NUL inside a name, which no file name holds"
                ))
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_launch_argument_that_is_not_utf8_cannot_be_sent() {
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(
            launch_arg_path(std::ffi::OsStr::from_bytes(b"/tmp/bad-\xff.md"), None),
            Err("/tmp/bad-\u{fffd}.md is not valid UTF-8, so it cannot be sent to chan".into())
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_letter_launch_argument_is_a_path_not_a_uri() {
        assert_eq!(
            arg_path(r"C:\notes\a.md", None),
            Ok(r"C:\notes\a.md".into())
        );
    }

    /// A desktop that predates `Activate` answers it the way every listener
    /// answers a type it does not know. That answer is a refusal from a live
    /// desktop, not the absence of one, so a second launch beside an older
    /// desktop still exits.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unknown_request_type_is_refused_not_unanswered() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        // What a listener answers a type it does not know.
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), |_req| async {
            Response::Error {
                message: "the handler must not run".into(),
            }
        })
        .unwrap();
        let mut stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
        stream
            .write_all(
                b"{\"type\":\"from_a_later_release\",\"protocol\":1,\"cli_version\":\"9.9.9\"}\n",
            )
            .await
            .unwrap();
        let mut unknown_reply = String::new();
        BufReader::new(stream)
            .read_line(&mut unknown_reply)
            .await
            .unwrap();
        assert!(
            unknown_reply.contains("invalid handoff request: unknown variant"),
            "{unknown_reply}"
        );

        // An older desktop sends that same line for `activate`.
        let old = dir.path().join("old.sock");
        let _old = claim_endpoint_at(&old).unwrap();
        let server = tokio::net::UnixListener::bind(&old).unwrap();
        let reply = unknown_reply.clone();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            assert!(line.contains("\"type\":\"activate\""), "{line}");
            write.write_all(reply.as_bytes()).await.unwrap();
        });
        assert_eq!(
            try_activate_at(&old, Duration::from_secs(3)).await,
            ActivateReply::Refused {
                reply: unknown_reply.trim().to_string()
            }
        );
    }

    /// No socket, or a claim whose listener is not bound yet, answers
    /// nothing; the caller decides how long to keep asking.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_endpoint_without_a_listener_does_not_answer() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        assert_eq!(
            try_activate_at(&sock, Duration::from_millis(500)).await,
            ActivateReply::NoReply
        );
        let _claim = claim_endpoint_at(&sock).unwrap();
        assert_eq!(
            try_activate_at(&sock, Duration::from_millis(500)).await,
            ActivateReply::NoReply
        );
    }

    /// The claim is the listener's lock taken on its own: a second claim, or
    /// a listener, meets it held until it is dropped, a listener started on
    /// it keeps holding it, and a missing directory is not a held endpoint.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_endpoint_claim_is_held_until_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let first = claim_endpoint_at(&sock).unwrap();
        assert!(matches!(claim_endpoint_at(&sock), Err(ClaimError::Held(_))));
        let refused = match start_listener(sock.clone(), |_req| async {
            Response::Error {
                message: "second".into(),
            }
        }) {
            Ok(_) => panic!("a listener must not start on a claimed endpoint"),
            Err(error) => error,
        };
        assert_eq!(refused.kind(), std::io::ErrorKind::AddrInUse);
        drop(first);

        let claim = claim_endpoint_at(&sock).unwrap();
        let _handle = start_claimed_listener(claim, |_req| async {
            Response::Activated {
                desktop_version: CHAN_VERSION.into(),
            }
        })
        .unwrap();
        assert!(matches!(claim_endpoint_at(&sock), Err(ClaimError::Held(_))));
        assert!(matches!(
            try_activate_at(&sock, Duration::from_secs(3)).await,
            ActivateReply::Activated { .. }
        ));

        let missing = dir.path().join("missing").join("hand.sock");
        assert!(matches!(
            claim_endpoint_at(&missing),
            Err(ClaimError::Unavailable(_))
        ));
    }

    /// On unix a held claim with no socket is not read as a desktop booting:
    /// the guard's ask keeps its one bound there, and the CLI says nothing
    /// about a desktop starting.
    #[cfg(unix)]
    #[test]
    fn a_unix_claim_without_its_listener_does_not_read_as_booting() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _claim = claim_endpoint_at(&sock).unwrap();
        assert!(!sock.exists(), "the claim binds no socket");
        assert!(!endpoint_is_booting_at(&sock));
    }

    /// A listener that fails to start hands its claim back still held, so a
    /// desktop that goes on without the listener keeps the endpoint and a
    /// second claim meets it held until that claim is dropped. The bind fails
    /// on a socket name past the `sun_path` limit (108 bytes on Linux, 104 on
    /// macOS), which the lock file beside the socket does not have.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_claim_whose_listener_fails_to_start_stays_held() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join(format!("{}.sock", "s".repeat(150)));
        let claim = claim_endpoint_at(&sock).unwrap();
        let failed = start_claimed_listener(claim, |_req| async {
            Response::Activated {
                desktop_version: CHAN_VERSION.into(),
            }
        })
        .err()
        .expect("a socket path past the sun_path limit must not bind");
        assert!(
            matches!(claim_endpoint_at(&sock), Err(ClaimError::Held(_))),
            "the endpoint must stay claimed after its listener failed to start: {failed}"
        );
        drop(failed);
        assert!(
            claim_endpoint_at(&sock).is_ok(),
            "dropping the claim the failed start handed back frees the endpoint"
        );
    }

    #[test]
    fn remote_workspace_requests_and_replies_round_trip() {
        // The three additive arms and their replies, by wire tag: an old
        // desktop answers an unknown tag with "invalid handoff request", which
        // is what keeps PROTOCOL_VERSION at 1.
        for (req, tag) in [
            (
                Request::ServeRemoteWorkspace {
                    protocol: PROTOCOL_VERSION,
                    cli_version: "9.9.9".into(),
                    target: "lab".into(),
                    workspace_path: "/srv/notes".into(),
                },
                "serve_remote_workspace",
            ),
            (
                Request::CloseRemoteWorkspace {
                    protocol: PROTOCOL_VERSION,
                    cli_version: "9.9.9".into(),
                    target: "lab".into(),
                    workspace_path: "/srv/notes".into(),
                },
                "close_remote_workspace",
            ),
            (
                Request::ForgetRemoteWorkspace {
                    protocol: PROTOCOL_VERSION,
                    cli_version: "9.9.9".into(),
                    target: "lab".into(),
                    workspace_path: "/srv/notes".into(),
                },
                "forget_remote_workspace",
            ),
        ] {
            let json = serde_json::to_string(&req).unwrap();
            assert!(json.contains(&format!("\"type\":\"{tag}\"")), "{json}");
            assert!(json.contains("\"target\":\"lab\""), "{json}");
            assert!(json.contains("\"workspace_path\":\"/srv/notes\""), "{json}");
            assert_eq!(req, serde_json::from_str::<Request>(&json).unwrap());
            assert_eq!(req.protocol(), PROTOCOL_VERSION);
            assert_eq!(req.cli_version(), "9.9.9");
        }
        for (resp, tag) in [
            (
                Response::RemoteWorkspaceServed {
                    desktop_version: "9.9.9".into(),
                    prefix: "/notes-1a2b3c".into(),
                },
                "remote_workspace_served",
            ),
            (
                Response::RemoteWorkspaceClosed {
                    desktop_version: "9.9.9".into(),
                    was_served: true,
                },
                "remote_workspace_closed",
            ),
            (
                Response::RemoteWorkspaceForgotten {
                    desktop_version: "9.9.9".into(),
                },
                "remote_workspace_forgotten",
            ),
        ] {
            let json = serde_json::to_string(&resp).unwrap();
            assert!(json.contains(&format!("\"status\":\"{tag}\"")), "{json}");
            assert_eq!(resp, serde_json::from_str::<Response>(&json).unwrap());
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn reply_budget_covers_local_teardown_and_preserves_the_other_verbs() {
        for remove in [false, true] {
            let close = Request::CloseWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: "9.9.9".into(),
                workspace_path: "/srv/notes".into(),
                remove,
            };
            assert!(
                close.reply_budget()
                    > chan_library::tenant::TENANT_TASK_SHUTDOWN_GRACE
                        + chan_library::host::WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT,
                "local close and forget must leave room for the teardown reply"
            );
        }
        let base = |target: &str| Request::ConnectDevserver {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            target: target.into(),
        };
        assert_eq!(base("lab").reply_budget(), Duration::from_millis(3000));
        assert_eq!(
            Request::ServeRemoteWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: "9.9.9".into(),
                target: "lab".into(),
                workspace_path: "/srv/notes".into(),
            }
            .reply_budget(),
            Duration::from_secs(75)
        );
        assert_eq!(
            Request::ForgetRemoteWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: "9.9.9".into(),
                target: "lab".into(),
                workspace_path: "/srv/notes".into(),
            }
            .reply_budget(),
            Duration::from_secs(30)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_close_and_forget_receive_retry_after_the_release_wait() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        for remove in [false, true] {
            let listener = start_listener(sock.clone(), move |request| async move {
                assert!(matches!(
                    request,
                    Request::CloseWorkspace { remove: actual, .. } if actual == remove
                ));
                tokio::time::sleep(chan_library::host::WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT).await;
                Response::Error {
                    message: chan_library::host::WORKSPACE_STILL_RELEASING.into(),
                }
            })
            .unwrap();
            let outcome = try_close_workspace_at(&sock, Path::new("/srv/notes"), remove).await;
            assert!(
                matches!(&outcome, Outcome::DesktopError { message }
                    if message == chan_library::host::WORKSPACE_STILL_RELEASING),
                "the release retry must reach the CLI before its reply deadline: {outcome:?}"
            );
            drop(listener);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_remote_workspace_served() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), move |req| async move {
            match req {
                Request::ServeRemoteWorkspace {
                    target,
                    workspace_path,
                    ..
                } => {
                    assert_eq!(target, "lab");
                    assert_eq!(workspace_path, "/srv/notes");
                    Response::RemoteWorkspaceServed {
                        desktop_version: CHAN_VERSION.into(),
                        prefix: "/notes-1a2b3c".into(),
                    }
                }
                _ => Response::Error {
                    message: "unexpected request".into(),
                },
            }
        })
        .unwrap();
        let req = Request::ServeRemoteWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            target: "lab".into(),
            workspace_path: "/srv/notes".into(),
        };
        match round_trip(&sock, &req).await {
            Response::RemoteWorkspaceServed { prefix, .. } => assert_eq!(prefix, "/notes-1a2b3c"),
            other => panic!("expected RemoteWorkspaceServed, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_upgrade_checked() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), move |req| async move {
            match req {
                Request::Upgrade { check_only, .. } => {
                    assert!(check_only, "test sends check_only=true");
                    Response::UpgradeChecked {
                        desktop_version: CHAN_VERSION.into(),
                        available: Some("9.9.9".into()),
                    }
                }
                Request::OpenWorkspace { .. } => Response::Error {
                    message: "unexpected open".into(),
                },
                Request::OpenDevserver { .. } => Response::Error {
                    message: "unexpected open_devserver".into(),
                },
                Request::CloseWorkspace { .. } => Response::Error {
                    message: "unexpected close".into(),
                },
                Request::ListDevservers { .. }
                | Request::ConnectDevserver { .. }
                | Request::DisconnectDevserver { .. }
                | Request::ForgetDevserver { .. }
                | Request::ServeRemoteWorkspace { .. }
                | Request::CloseRemoteWorkspace { .. }
                | Request::ForgetRemoteWorkspace { .. } => Response::Error {
                    message: "unexpected devserver control".into(),
                },
                Request::OpenTerminal { .. } => Response::Error {
                    message: "unexpected open_terminal".into(),
                },
                Request::Activate { .. } => Response::Error {
                    message: "unexpected activate".into(),
                },
                Request::OpenPath { .. } => Response::Error {
                    message: "unexpected open_path".into(),
                },
            }
        })
        .unwrap();
        match upgrade_over(&sock, true).await {
            Response::UpgradeChecked { available, .. } => {
                assert_eq!(available, Some("9.9.9".to_string()))
            }
            other => panic!("expected UpgradeChecked, got {other:?}"),
        }
    }

    /// The Windows twin of `listener_round_trip_upgrade_checked`: the named-pipe
    /// client arm against this process's own pipe listener, so the busy-retry
    /// open, the one-line framing, and the shared reply mapping are exercised
    /// where they run, not only compiled.
    #[cfg(windows)]
    #[tokio::test]
    async fn listener_round_trip_upgrade_checked_pipe() {
        let pipe = PathBuf::from(format!(
            r"\\.\pipe\chan-test-upgrade-{}",
            std::process::id()
        ));
        let _handle = start_listener(pipe.clone(), move |req| async move {
            match req {
                Request::Upgrade { check_only, .. } => {
                    assert!(check_only, "test sends check_only=true");
                    Response::UpgradeChecked {
                        desktop_version: CHAN_VERSION.into(),
                        available: Some("9.9.9".into()),
                    }
                }
                _ => Response::Error {
                    message: "unexpected request".into(),
                },
            }
        })
        .unwrap();
        match try_upgrade_at(&pipe, true).await {
            UpgradeOutcome::Checked { available, .. } => {
                assert_eq!(available, Some("9.9.9".to_string()))
            }
            other => panic!("expected Checked, got {other:?}"),
        }
    }

    /// The Windows twin of `listener_round_trip_activated` and
    /// `an_endpoint_claim_is_held_until_dropped`: a second claim meets the
    /// first held, and the listener started on it serves the client.
    #[cfg(windows)]
    #[tokio::test]
    async fn listener_round_trip_activated_pipe() {
        let pipe = PathBuf::from(format!(
            r"\\.\pipe\chan-test-activate-{}",
            std::process::id()
        ));
        let claim = claim_endpoint_at(&pipe).unwrap();
        assert!(matches!(claim_endpoint_at(&pipe), Err(ClaimError::Held(_))));
        let _handle = start_claimed_listener(claim, move |req| async move {
            match req {
                Request::Activate { .. } => Response::Activated {
                    desktop_version: "9.9.9".into(),
                },
                other => Response::Error {
                    message: format!("unexpected {other:?}"),
                },
            }
        })
        .unwrap();
        assert_eq!(
            try_activate_at(&pipe, Duration::from_secs(3)).await,
            ActivateReply::Activated {
                desktop_version: "9.9.9".into()
            }
        );
        let absent = PathBuf::from(format!(
            r"\\.\pipe\chan-test-activate-absent-{}",
            std::process::id()
        ));
        assert_eq!(
            try_activate_at(&absent, Duration::from_millis(500)).await,
            ActivateReply::NoReply
        );
    }

    /// A pipe nobody serves is the no-desktop case, never a hang or a guess.
    #[cfg(windows)]
    #[tokio::test]
    async fn unserved_pipe_is_no_desktop() {
        let pipe = PathBuf::from(format!(
            r"\\.\pipe\chan-test-upgrade-absent-{}",
            std::process::id()
        ));
        assert!(matches!(
            try_upgrade_at(&pipe, true).await,
            UpgradeOutcome::NoDesktop
        ));
    }

    /// A pipe name of one Windows test's own, so parallel tests and an
    /// installed desktop never meet.
    #[cfg(windows)]
    fn test_pipe(tag: &str) -> PathBuf {
        PathBuf::from(format!(r"\\.\pipe\chan-test-{tag}-{}", std::process::id()))
    }

    #[cfg(windows)]
    fn opened() -> Response {
        Response::Opened {
            desktop_version: CHAN_VERSION.into(),
            capabilities: Capabilities {
                open_local_workspace: true,
            },
        }
    }

    /// The client of a `chan serve --desktop` that writes its request while
    /// the desktop boots and gives up before the listener starts is never
    /// served afterwards: there is nothing to write it into until the
    /// listener runs.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_request_sent_during_the_boot_is_never_served_late() {
        use std::sync::{Arc, Mutex};
        use tokio::io::AsyncWriteExt;
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe = test_pipe("boot-late");
        let claim = claim_endpoint_at(&pipe).unwrap();
        if let Ok(mut early) = ClientOptions::new().open(&pipe) {
            let mut line = serde_json::to_vec(&Request::OpenWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: CHAN_VERSION.into(),
                workspace_path: "early".into(),
            })
            .unwrap();
            line.push(b'\n');
            let _ = early.write_all(&line).await;
        }
        let served = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&served);
        let _handle = start_claimed_listener(claim, move |req| {
            let seen = Arc::clone(&seen);
            async move {
                if let Request::OpenWorkspace { workspace_path, .. } = req {
                    seen.lock().unwrap().push(workspace_path);
                }
                opened()
            }
        })
        .unwrap();
        assert!(matches!(
            try_handoff_at(&pipe, Path::new("late")).await,
            Outcome::HandedOff
        ));
        // An early request the listener took would be served beside the late
        // one; give it the time.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(*served.lock().unwrap(), ["late"]);
    }

    /// The connect-only probe during the boot takes nothing from the client
    /// after it: both answer at once, within the second a `chan serve`
    /// during a boot is given, and once the listener runs both find it.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_probe_during_the_boot_turns_no_client_away() {
        let pipe = test_pipe("boot-probe");
        let claim = claim_endpoint_at(&pipe).unwrap();
        let started = std::time::Instant::now();
        assert!(
            !desktop_is_live_at(&pipe).await,
            "a desktop still booting is not live"
        );
        assert!(matches!(
            try_handoff_at(&pipe, Path::new("during")).await,
            Outcome::NoDesktop
        ));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a client during the boot answers within a second, not after {:?}",
            started.elapsed()
        );
        let _handle = start_claimed_listener(claim, |_req| async { opened() }).unwrap();
        assert!(desktop_is_live_at(&pipe).await);
        assert!(matches!(
            try_handoff_at(&pipe, Path::new("after")).await,
            Outcome::HandedOff
        ));
    }

    /// A listener that cannot create its next pipe instance stops serving,
    /// and the endpoint stays claimed while its handle lives: a second
    /// desktop meets it held instead of booting beside this one.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_listener_whose_rearm_fails_keeps_the_claim() {
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe = test_pipe("rearm");
        let claim = claim_endpoint_at(&pipe).unwrap();
        let handle = start_listener_with_instances(
            claim,
            |_req| async {
                Response::Activated {
                    desktop_version: CHAN_VERSION.into(),
                }
            },
            |_pipe_name| Err(std::io::Error::other("no pipe instance left")),
        )
        .unwrap();
        // The first client is accepted, and the re-arm after it fails.
        let _ = try_activate_at(&pipe, Duration::from_secs(1)).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match ClientOptions::new().open(&pipe) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                _ => {}
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the stopped listener left a pipe instance"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            matches!(claim_endpoint_at(&pipe), Err(ClaimError::Held(_))),
            "the endpoint stays claimed while the desktop runs"
        );
        drop(handle);
        assert!(claim_endpoint_at(&pipe).is_ok());
    }

    /// A claim whose listener has not started reads as a desktop booting,
    /// and creates no endpoint pipe; a running listener reads as served, and
    /// a claim given up as absent once its pipes are gone.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_claim_without_its_listener_reads_as_booting() {
        let pipe = test_pipe("booting");
        assert_eq!(endpoint_listing_at(&pipe), PipeListing::Absent);
        assert!(!endpoint_is_booting_at(&pipe), "no claim");
        let claim = claim_endpoint_at(&pipe).unwrap();
        assert_eq!(
            endpoint_listing_at(&pipe),
            PipeListing::Booting,
            "the claim creates no endpoint pipe"
        );
        assert!(endpoint_is_booting_at(&pipe));
        let handle = start_claimed_listener(claim, |_req| async { opened() }).unwrap();
        assert_eq!(endpoint_listing_at(&pipe), PipeListing::Served);
        assert!(!endpoint_is_booting_at(&pipe), "the listener is up");
        drop(handle);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while endpoint_listing_at(&pipe) != PipeListing::Absent {
            assert!(
                std::time::Instant::now() < deadline,
                "a pipe outlived its listener: {:?}",
                endpoint_listing_at(&pipe)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(claim_endpoint_at(&pipe).is_ok());
    }

    /// A client writes nothing to an endpoint whose server runs as another
    /// account, which the test stands in for by expecting another SID than
    /// the listener's; the same listener, expected as this account's, is
    /// written to and answers.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_pipe_served_by_another_account_is_never_written_to() {
        use std::sync::{Arc, Mutex};

        let pipe = test_pipe("other-account");
        let served = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&served);
        let _handle = start_listener(pipe.clone(), move |req| {
            let seen = Arc::clone(&seen);
            async move {
                if let Request::OpenWorkspace { workspace_path, .. } = req {
                    seen.lock().unwrap().push(workspace_path);
                }
                opened()
            }
        })
        .unwrap();
        assert!(
            connect_endpoint_as(&pipe, CONNECT_TIMEOUT, "S-1-5-21-0-0-0-1")
                .await
                .is_none(),
            "a server of another account is refused"
        );
        // A request written to the refused client would be served by now.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(served.lock().unwrap().is_empty());
        assert!(desktop_is_live_at(&pipe).await);
        assert!(matches!(
            try_handoff_at(&pipe, Path::new("ours")).await,
            Outcome::HandedOff
        ));
        assert_eq!(*served.lock().unwrap(), ["ours"]);
    }

    /// The claim pipe and the endpoint's pipe grant this account alone: owned
    /// by its SID, with a protected DACL whose one entry is that SID, read
    /// back from the claim's own end and from two clients of the listener, the
    /// second reaching the instance armed after the first.
    #[cfg(windows)]
    #[tokio::test]
    async fn the_claim_and_the_endpoint_grant_this_account_alone() {
        use tokio::net::windows::named_pipe::ClientOptions;

        const ERROR_PIPE_BUSY: i32 = 231;
        let sid = chan_winpipe::current_account_sid().unwrap();
        // Compared as SIDs: SDDL writes a well-known account by its alias, so
        // the built-in Administrator's pipes read back `O:LAD:P(A;;FA;;;LA)`.
        let owner_only = |sddl: String| {
            assert!(
                chan_winpipe::grants_account_alone(&sddl, sid),
                "{sddl} for {sid}"
            )
        };
        let pipe = test_pipe("owner-only");
        let claim = claim_endpoint_at(&pipe).unwrap();
        owner_only(chan_winpipe::security_sddl(&claim.claim_pipe).unwrap());
        let _handle = start_claimed_listener(claim, |_req| async { opened() }).unwrap();
        for _ in 0..2 {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let client = loop {
                match ClientOptions::new().open(&pipe) {
                    Ok(client) => break client,
                    Err(e)
                        if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                            && std::time::Instant::now() < deadline =>
                    {
                        tokio::time::sleep(Duration::from_millis(20)).await
                    }
                    Err(e) => panic!("open the endpoint: {e}"),
                }
            };
            owner_only(chan_winpipe::security_sddl(&client).unwrap());
        }
    }

    /// An endpoint pipe some other process created first holds no claim: the
    /// claim is taken, the listener's first instance fails on that pipe and
    /// hands the claim back held, so a second launch meets it held, and the
    /// listing reads the endpoint served, not booting.
    #[cfg(windows)]
    #[tokio::test]
    async fn an_endpoint_pipe_without_a_claim_pipe_holds_no_claim() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe = test_pipe("endpoint-first");
        let first = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .unwrap();
        let claim = claim_endpoint_at(&pipe).expect("no claim pipe holds the endpoint");
        let failed = start_claimed_listener(claim, |_req| async { opened() })
            .err()
            .expect("the endpoint's name is taken");
        assert!(matches!(claim_endpoint_at(&pipe), Err(ClaimError::Held(_))));
        assert_eq!(endpoint_listing_at(&pipe), PipeListing::Served);
        assert!(!endpoint_is_booting_at(&pipe));
        drop((first, failed));
        assert!(claim_endpoint_at(&pipe).is_ok());
    }

    /// A claim pipe of the endpoint's name that refuses this account access
    /// is another account's, which no launch of this account can ask to come
    /// forward: no holder of this account's. The test stands in for that
    /// account with a claim pipe whose security grants LocalSystem alone.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_claim_pipe_this_account_cannot_open_is_no_holder() {
        use tokio::net::windows::named_pipe::ServerOptions;

        let pipe = test_pipe("foreign-claim");
        let _theirs = chan_winpipe::create_with_sddl(
            ServerOptions::new()
                .first_pipe_instance(true)
                .access_outbound(false),
            claim_pipe_name(&pipe),
            "D:P(A;;GA;;;SY)",
        )
        .unwrap();
        assert!(
            matches!(claim_endpoint_at(&pipe), Err(ClaimError::Foreign(_))),
            "another account's claim pipe"
        );
        let _ours = claim_endpoint_at(&test_pipe("own-claim")).unwrap();
        assert!(
            matches!(
                claim_endpoint_at(&test_pipe("own-claim")),
                Err(ClaimError::Held(_))
            ),
            "this account's claim pipe"
        );
    }

    /// The pipe directory read by name, without case, and its failure: a
    /// listing that cannot be read is not a boot, so the guard's ask goes on
    /// as for a desktop that is up and the CLI says nothing of a desktop
    /// starting.
    #[test]
    fn the_pipe_listing_tells_absent_booting_and_served_and_a_failure_is_no_boot() {
        let read = |names: &[&str]| Ok(names.iter().map(|name| name.to_string()).collect());
        let (claim, endpoint) = ("chan-desktop-a.claim", "chan-desktop-a");
        assert_eq!(
            classify_listing(claim, endpoint, read(&["other", "chan-desktop-ab"])),
            PipeListing::Absent
        );
        assert_eq!(
            classify_listing(claim, endpoint, read(&["Chan-Desktop-A.Claim"])),
            PipeListing::Booting
        );
        assert_eq!(
            classify_listing(
                claim,
                endpoint,
                read(&["chan-desktop-a.claim", "chan-desktop-a"])
            ),
            PipeListing::Served
        );
        assert_eq!(
            classify_listing(claim, endpoint, read(&["CHAN-DESKTOP-A"])),
            PipeListing::Served,
            "an endpoint pipe without a claim pipe is served, not booting"
        );
        let unreadable = classify_listing(
            claim,
            endpoint,
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        );
        assert_eq!(unreadable, PipeListing::Unreadable);
        for (listing, booting) in [
            (PipeListing::Absent, false),
            (PipeListing::Booting, true),
            (PipeListing::Served, false),
            (PipeListing::Unreadable, false),
        ] {
            assert_eq!(listing.booting(), booting, "{listing:?}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_devserver_registered() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hand.sock");
        let _handle = start_listener(sock.clone(), move |req| async move {
            match req {
                Request::OpenDevserver {
                    url, name, script, ..
                } => {
                    assert_eq!(url, "https://box.example.com:8787");
                    assert_eq!(name.as_deref(), Some("box"));
                    assert_eq!(script.as_deref(), Some("echo connect"));
                    Response::DevserverRegistered {
                        desktop_version: CHAN_VERSION.into(),
                    }
                }
                Request::OpenWorkspace { .. } => Response::Error {
                    message: "unexpected open".into(),
                },
                Request::Upgrade { .. } => Response::Error {
                    message: "unexpected upgrade".into(),
                },
                Request::CloseWorkspace { .. } => Response::Error {
                    message: "unexpected close".into(),
                },
                Request::ListDevservers { .. }
                | Request::ConnectDevserver { .. }
                | Request::DisconnectDevserver { .. }
                | Request::ForgetDevserver { .. }
                | Request::ServeRemoteWorkspace { .. }
                | Request::CloseRemoteWorkspace { .. }
                | Request::ForgetRemoteWorkspace { .. } => Response::Error {
                    message: "unexpected devserver control".into(),
                },
                Request::OpenTerminal { .. } => Response::Error {
                    message: "unexpected open_terminal".into(),
                },
                Request::Activate { .. } => Response::Error {
                    message: "unexpected activate".into(),
                },
                Request::OpenPath { .. } => Response::Error {
                    message: "unexpected open_path".into(),
                },
            }
        })
        .unwrap();
        match devserver_over(
            &sock,
            "https://box.example.com:8787",
            Some("box"),
            Some("echo connect"),
        )
        .await
        {
            Response::DevserverRegistered { .. } => {}
            other => panic!("expected DevserverRegistered, got {other:?}"),
        }
    }

    /// Connect directly to `sock` and round-trip one OpenWorkspace. Mirrors
    /// try_handoff's wire framing but targets an explicit socket so the
    /// test doesn't depend on the well-known path.
    #[cfg(unix)]
    async fn request_over(sock: &std::path::Path, workspace: &str) -> Response {
        let req = Request::OpenWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: workspace.into(),
        };
        round_trip(sock, &req).await
    }

    /// Round-trip one `Upgrade` request, mirroring try_upgrade's framing.
    #[cfg(unix)]
    async fn upgrade_over(sock: &std::path::Path, check_only: bool) -> Response {
        let req = Request::Upgrade {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            check_only,
        };
        round_trip(sock, &req).await
    }

    /// Round-trip one `OpenDevserver` request, mirroring try_open_devserver's
    /// framing.
    #[cfg(unix)]
    async fn devserver_over(
        sock: &std::path::Path,
        url: &str,
        name: Option<&str>,
        script: Option<&str>,
    ) -> Response {
        let req = Request::OpenDevserver {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            url: url.into(),
            name: name.map(str::to_string),
            script: script.map(str::to_string),
        };
        round_trip(sock, &req).await
    }

    #[cfg(unix)]
    async fn round_trip(sock: &std::path::Path, req: &Request) -> Response {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let stream = UnixStream::connect(sock).await.unwrap();
        let mut payload = serde_json::to_vec(req).unwrap();
        payload.push(b'\n');
        let (read, mut write) = stream.into_split();
        write.write_all(&payload).await.unwrap();
        write.flush().await.unwrap();
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
