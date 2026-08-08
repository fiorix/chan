//! First-party control socket for local `chan` CLI helpers.
//!
//! MCP stays scoped to workspace tools for external agents. This socket is
//! for UI commands from chan-spawned terminals, such as `cs open`,
//! where the command must target one frontend window in the already
//! running server process.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use base64::Engine;
use chan_workspace::{Position, TeamConfig, Workspace};
use portable_pty::PtySize;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::desktop_window_ops::DesktopWindowOp;
use crate::handover_bus::{HandoverBus, HandoverReply};
use crate::session_presence::{HandoverError, ParticipantState, RenameError, SessionRegistry};
use crate::state::WorkspaceCell;
use crate::terminal_sessions::Registry as TerminalRegistry;
use crate::terminal_sessions::{AttachHandle, CreateOptions};
use crate::{WindowKind, WindowRecord};

/// Settable handle to the terminal registry. The registry is built after
/// the control socket starts (it needs the control socket path for
/// `$CHAN_CONTROL_SOCKET`), so the caller passes an empty cell here and
/// fills it once the registry exists. Category-2 requests
/// (`cs term write` / `term list`) read it.
pub type TerminalRegistryCell = Arc<OnceLock<Arc<TerminalRegistry>>>;

// The control-socket wire contract (request + response) is shared with
// the `cs` client through chan-shell, so a tag/field rename moves in
// lockstep instead of silently breaking one side. The transport module is
// the only `#[cfg]`-split surface now (unix socket vs. windows named pipe),
// so these types and every handler below are platform-neutral.
pub use chan_shell::{ControlRequest, ControlResponse};
// The survey types are part of the same shared wire module; the handler
// pushes a SurveySpec to the SPA and formats the SurveyReply for the CLI.
// TeamOp tags the `cs terminal team` op (new | load).
use chan_shell::{
    submit_writes, Identity, PaneOp, PastePrefer, ServeKind, SubmitAgent, SurveyReply, SurveySpec,
    TabDestination, TeamOp, MAX_CLIPBOARD_BYTES, MAX_CONTROL_REQUEST_BYTES,
    MAX_TERMINAL_WRITE_BYTES,
};

#[derive(Debug, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
// The shared `Open` prefix is the wire contract: serde renames each
// variant to its `open_*` command string that the SPA's
// `handleWindowCommand` matches on. Renaming to drop the prefix would
// rename the wire command and break the SPA.
#[allow(clippy::enum_variant_names)]
enum WindowCommand {
    OpenFile {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenBrowser {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        select: Option<String>,
        #[serde(skip_serializing_if = "is_false")]
        enter: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenGraph {
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        is_dir: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenGraphLink {
        link: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenTermNew {
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tab_group: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenDashboard {
        #[serde(skip_serializing_if = "Option::is_none")]
        carousel_index: Option<u32>,
        #[serde(skip_serializing_if = "is_false")]
        carousel_off: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    // `cs upload` / `cs download`: raise the Inspector upload / download UI in
    // the originating window, reusing the SPA's fileOps (not a parallel path).
    // On a workspace tenant `path` is workspace-relative ("" = workspace root);
    // on a standalone terminal it is a filesystem-absolute path with its leading
    // `/` stripped (the terminal-tenant route re-roots it). Upload targets a
    // directory; download carries `is_dir` (resolved server-side via stat) so
    // the SPA names the download correctly. Fire-and-forget like the open_*
    // commands.
    Upload {
        path: String,
    },
    Download {
        path: String,
        is_dir: bool,
    },
    // Raise the `cs terminal survey` overlay. The SurveySpec nests under
    // `survey` (it is camelCase, unlike the snake_case sibling fields, so
    // nesting keeps the two conventions from mixing in one object). The SPA
    // reads `frame.survey` and POSTs a SurveyReply to the reply route.
    OpenSurvey {
        survey: SurveySpec,
        // The terminal this survey targets, so the SPA can anchor a
        // per-terminal survey instead of one window-wide modal. `cs terminal
        // survey --tab-name=X` -> Some(X); a `--tab-group` broadcast (or no
        // specific tab) -> None, where the SPA keeps its window-wide fallback.
        // camelCase `tabName` on the wire, pinned with serde(rename) so a green
        // compile can't hide a wire mismatch.
        #[serde(rename = "tabName", skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
    },
    // Close a stale survey overlay after the blocked control call is no longer
    // awaiting this window's reply. `survey_id` lets the SPA close only the
    // matching overlay; `tabName` mirrors `OpenSurvey` so tab-targeted surveys
    // stay per-terminal and group surveys close the window-wide slot.
    CloseSurvey {
        #[serde(rename = "surveyId")]
        survey_id: String,
        reason: SurveyCloseReason,
        #[serde(rename = "tabName", skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
    },
    // `cs pane` layout query: the server asks the window for its current
    // tab/pane layout. The SPA reads its `layout` and POSTs the snapshot to
    // `POST /api/window/reply` echoing `request_id`, which fires the parked
    // window-bus oneshot. Not an `open_*` command (it queries, it does not
    // open a tab), hence the non-`Open` name and the `pane_query` wire tag.
    PaneQuery {
        request_id: String,
    },
    // `cs pane <exec>`: the server asks the window to APPLY a layout mutation
    // (new / focus / resize / equalize / swap / close). The op nests under
    // `op` (it is internally tagged on `kind`, so the SPA reads
    // `frame.op.kind`); the SPA applies it and POSTs the result echoing
    // `request_id`.
    PaneExec {
        request_id: String,
        op: PaneOp,
    },
    // A CLI `cs terminal team new|load` spawned a team server-side; tell
    // the window that owns it to SURFACE the agents by opening a terminal tab
    // per member ATTACHED to the already-spawned `session_id` (not a fresh
    // session), grouped under `group`. Fire-and-forget (no reply / no window
    // bus), like the `open_*` commands.
    TeamSpawned {
        group: String,
        members: Vec<SpawnedMember>,
        #[serde(skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    // `cs session handover`: a follower asked to take leadership; prompt THIS
    // (leader) window to accept or reject. The SPA shows the handover overlay
    // and POSTs the answer to `/api/session/handover/reply` echoing
    // `request_id`, which fires the parked handover-bus oneshot. snake_case
    // field names (like `pane_query`'s `request_id`), read by the SPA's
    // `handleWindowCommand`.
    HandoverPrompt {
        request_id: String,
        from_window_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        from_name: Option<String>,
    },
    // `cs export`: ask the window to render `path` to `format` and write the
    // result back into the workspace. The SPA renders through its
    // `format -> exporter` registry, uploads the bytes with the existing
    // `POST /api/files/upload` (`replace_path` = `out`), then POSTs
    // `{ ok: true, out }` / `{ ok: false, error }` to `POST /api/window/reply`
    // echoing this frame's `id`, which fires the parked window-bus oneshot.
    // The `export-job` tag and the `id` payload key (not `request_id`) are
    // the frozen frame contract the SPA matches on; both paths are
    // workspace-relative and `out` is always the FINAL output path (the
    // server resolves the default before dispatch).
    #[serde(rename = "export-job")]
    ExportJob {
        id: String,
        path: String,
        format: String,
        out: String,
    },
    // `cs copy`: ask the window to write `data_b64` (base64 of the terminal's
    // stdin) onto the clipboard as `mime`. The SPA decodes it, writes via
    // `navigator.clipboard` (or the desktop's native arboard IPC), and POSTs
    // `{ ok }` / `{ error }` to `POST /api/window/reply` echoing `request_id`,
    // which fires the parked window-bus oneshot. Round-trips (not
    // fire-and-forget) so a clipboard denial surfaces as a CLI error.
    ClipboardWrite {
        request_id: String,
        mime: String,
        data_b64: String,
    },
    // `cs paste`: ask the window to read its clipboard back. `prefer` picks
    // the representation when several are present (image-first by default).
    // The SPA POSTs `{ mime, data_b64 }` (or `{ error }`) echoing
    // `request_id`; the CLI base64-decodes it to raw stdout.
    ClipboardRead {
        request_id: String,
        prefer: PastePrefer,
    },
    // `cs tunnel`: ask the window's native host (chan-desktop) to listen on
    // `bind_addr:desktop_port` of the DESKTOP machine and dial this devserver
    // back for every accepted connection. Fire-and-forget: the acknowledgement
    // arrives out of band, on the control WebSocket the desktop opens for
    // `tunnel_id` (see `chan_revtunnel::wire`). Addressing the window is also
    // how the one desktop is selected -- a window's webview belongs to exactly
    // one desktop process -- so a browser-only viewer simply never answers.
    TunnelOpen {
        tunnel_id: String,
        proto: chan_revtunnel::Proto,
        bind_addr: String,
        desktop_port: u16,
        devserver_port: u16,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum SurveyCloseReason {
    Cancelled,
    TimedOut,
    AnsweredElsewhere,
}

/// One spawned team member in a [`WindowCommand::TeamSpawned`]: the tab name
/// (the registry-settled member handle, so the surfaced tab title matches the
/// PTY's $CHAN_TAB_NAME even when a live collision appended `-N`), the live
/// `session_id` the SPA attaches its new terminal tab to, and the member's
/// config grid coordinate when the spawn honors the config layout (absent in
/// tabs mode, where every member stacks in one pane).
#[derive(Debug, Clone, Serialize)]
struct SpawnedMember {
    tab_name: String,
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<Position>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Serialize)]
struct WindowCommandFrame {
    #[serde(rename = "type")]
    frame_type: &'static str,
    window_id: String,
    #[serde(flatten)]
    command: WindowCommand,
}

#[derive(Debug)]
pub struct ControlHandle {
    socket_path: PathBuf,
    accept_loop: JoinHandle<()>,
    /// Held open for the server's lifetime on a STABLE socket path: the
    /// flock on the `.lock` sibling is what makes a takeover race-free (a
    /// later bind that cannot take the flock knows the socket is live and
    /// must not clobber it). `None` on pid-scoped paths, which are unique
    /// by construction. The lock file itself is left on disk on drop --
    /// unlinking it would race a concurrent taker that already opened it.
    #[cfg(unix)]
    _stable_lock: Option<std::fs::File>,
}

impl ControlHandle {
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }
}

impl Drop for ControlHandle {
    fn drop(&mut self) {
        self.accept_loop.abort();
        // A Unix-domain socket leaves a filesystem node that must be
        // unlinked; a Windows named pipe is reclaimed by the OS once the
        // last handle (the accept loop's idle instance) drops, so only the
        // unix path has anything to clean up.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

#[cfg(unix)]
pub fn pick_socket_path() -> PathBuf {
    crate::mcp_bridge::pick_named_socket_path("control")
}

/// The control-socket path for a tenant of a server with a STABLE identity
/// (a devserver): `chan-control-s<hash>.sock` in the same directory
/// pid-scoped sockets use. Deterministic in (identity, prefix), so a
/// restarted devserver rebinds the exact path already baked into every
/// open shell's `$CHAN_CONTROL_SOCKET` and `cs` transparently reaches the
/// new instance. Identity and prefix are folded into one short hash rather
/// than spelled out so the name fits the `sun_path` cap even in a long
/// socket dir (see [`stable_socket_name`]).
pub fn stable_socket_path(identity: &str, prefix: &str) -> PathBuf {
    let name = stable_socket_name(identity, prefix);
    #[cfg(unix)]
    {
        crate::mcp_bridge::unix_socket_dir().join(name)
    }
    #[cfg(windows)]
    {
        PathBuf::from(format!(r"\\.\pipe\{}", name.trim_end_matches(".sock")))
    }
}

/// `chan-control-s<16 hex>.sock`: one FNV-1a 64 hash over the
/// NUL-separated (identity, prefix) pair, so the pair folds in
/// unambiguously and even a hostile identity (it round-trips through a
/// user-editable config file) never reaches the filename verbatim. The
/// leading `s` (stable) marker keeps the name distinguishable from the
/// pid-scoped `chan-control-<digits>-<rand>` family, even for an
/// all-digits identity; discovery's stable-candidate classifier in the
/// `chan` CLI matches this exact shape. The hash is FNV-1a 64 rather than
/// `DefaultHasher` because the name must be stable across chan builds,
/// not just within one process.
fn stable_socket_name(identity: &str, prefix: &str) -> String {
    format!(
        "chan-control-s{:016x}.sock",
        fnv1a64(&format!("{identity}\0{prefix}"))
    )
}

/// FNV-1a 64-bit: tiny, dependency-free, and stable across releases.
pub(crate) fn fnv1a64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// On Windows the control "socket" is a named pipe, so the path is the pipe
/// name `\\.\pipe\chan-control-<pid>-<rand>`. It is carried verbatim through
/// `$CHAN_CONTROL_SOCKET` and read identically by `cs` (a `PathBuf` holds the
/// string unchanged), mirroring the unix socket-path contract.
#[cfg(windows)]
pub fn pick_socket_path() -> PathBuf {
    use rand::RngCore;
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    PathBuf::from(format!(
        r"\\.\pipe\chan-control-{}-{suffix}",
        std::process::id()
    ))
}

/// Which kind of tenant this control socket fronts. Workspace commands
/// (`cs open/graph/search`, team ops) need an actual workspace behind the
/// cell; on a standalone terminal tenant the cell is None BY DESIGN, and
/// the error must say so instead of the transient-sounding "workspace cell
/// unavailable".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlTenant {
    /// A workspace mount (`chan open`, a desktop workspace tenant):
    /// the cell is None only transiently (storage reset window).
    Workspace,
    /// chan-desktop's workspace-less `/terminal` tenant: terminal /
    /// pane / window commands work, workspace commands never will.
    TerminalOnly,
}

/// The unified workspace-only refusal for standalone terminals. `what` names
/// the cs subcommand (e.g. "open", "graph", "session list"); the optional
/// `hint` is a trailing sentence. One message family so every workspace-only
/// command reads the same way on a standalone terminal. No em dashes (house
/// style, pinned by tests).
pub fn workspace_only_refusal(what: &str, hint: Option<&str>) -> String {
    let base = format!(
        "cs {what} is only available in a workspace window; this is a standalone terminal."
    );
    match hint {
        Some(hint) => format!("{base} {hint}"),
        None => base,
    }
}

/// The pure standalone-terminal gate: the single decision for which control
/// commands a [`ControlTenant::TerminalOnly`] session refuses, and with what
/// message. Decoupled from workspace resolution (it takes no workspace cell),
/// so the policy is table-testable in isolation. A [`ControlTenant::Workspace`]
/// session runs everything, so this only ever refuses on a standalone terminal.
///
/// The refusals are the workspace-only commands: `cs open`/`graph`/`search`
/// need a mounted workspace; `cs terminal new --path` needs a workspace root to
/// resolve the cwd; `cs session *` leads a shared workspace session; and `cs
/// terminal team *` (including `--script`) writes into a workspace tree. `cs
/// open PATH` additionally suggests the workspace-load `chan open PATH`.
/// Everything else runs on a standalone terminal: window routing, pane ops,
/// pathless `cs terminal new`, and the cwd-scoped `cs upload`/`download`.
fn terminal_tenant_refusal(req: &ControlRequest, tenant: ControlTenant) -> Option<String> {
    if tenant == ControlTenant::Workspace {
        return None;
    }
    match req {
        ControlRequest::OpenPath { path, .. } => Some(chan_open_guidance(path)),
        ControlRequest::OpenGraphLink { .. } => Some(workspace_only_refusal(
            "open",
            Some("Graph links need a workspace window."),
        )),
        ControlRequest::OpenGraph { .. } => Some(workspace_only_refusal("graph", None)),
        ControlRequest::WorkspaceSearch { .. } => Some(workspace_only_refusal("search", None)),
        ControlRequest::Export { .. } => Some(workspace_only_refusal(
            "export",
            Some("An open workspace window does the rendering; run cs export from a terminal in one."),
        )),
        ControlRequest::OpenTermNew { path: Some(_), .. } => Some(workspace_only_refusal(
            "terminal new --path",
            Some("Drop --path to open a terminal here."),
        )),
        ControlRequest::SessionList => Some(session_refusal("session list")),
        ControlRequest::SessionSelf { .. } => Some(session_refusal("session self")),
        ControlRequest::SessionHandover { .. } => Some(session_refusal("session handover")),
        ControlRequest::SessionTakeover { .. } => Some(session_refusal("session takeover")),
        ControlRequest::TerminalTeam { .. } => Some(workspace_only_refusal("terminal team", None)),
        _ => None,
    }
}

/// Session commands lead a shared workspace session, which a standalone
/// terminal has none of.
fn session_refusal(what: &str) -> String {
    workspace_only_refusal(
        what,
        Some("Standalone terminals have no shared session to lead."),
    )
}

/// Friendly guidance for `cs open PATH` on a standalone terminal: it has no
/// workspace to open the path INTO, and the user most likely wanted to load
/// that path AS a workspace window, which is `chan open PATH`.
fn chan_open_guidance(path: &Path) -> String {
    workspace_only_refusal(
        "open",
        Some(&format!(
            "Run 'chan open {}' to load it as a workspace window.",
            path.display()
        )),
    )
}

/// The command-context gating policy is a pure decision (no workspace cell),
/// so it is table-testable directly, independent of `handle_request` and its
/// buses. Platform-neutral: not gated to unix like the socket round-trip tests.
#[cfg(test)]
mod tenant_gate_tests {
    use super::*;
    use std::path::PathBuf;

    fn open_path(p: &str) -> ControlRequest {
        ControlRequest::OpenPath {
            window_id: "w".into(),
            path: PathBuf::from(p),
            destination: None,
        }
    }
    fn term_new(path: Option<&str>) -> ControlRequest {
        ControlRequest::OpenTermNew {
            window_id: "w".into(),
            path: path.map(PathBuf::from),
            tab_name: None,
            tab_group: None,
            destination: None,
        }
    }
    fn workspace_search() -> ControlRequest {
        ControlRequest::WorkspaceSearch {
            request: chan_workspace::WorkspaceSearchRequest {
                query: Some("q".into()),
                domains: vec![chan_workspace::WorkspaceSearchDomain::Content],
                ..chan_workspace::WorkspaceSearchRequest::default()
            },
        }
    }
    fn session_reqs() -> Vec<ControlRequest> {
        vec![
            ControlRequest::SessionList,
            ControlRequest::SessionSelf {
                window_id: "w".into(),
                name: Some("n".into()),
                reset: false,
            },
            // The bare whoami query rides the same tenant gate.
            ControlRequest::SessionSelf {
                window_id: "w".into(),
                name: None,
                reset: false,
            },
            ControlRequest::SessionHandover {
                window_id: "w".into(),
                to: None,
                accept: false,
                reject: false,
                timeout_secs: 0,
            },
            ControlRequest::SessionTakeover {
                window_id: "w".into(),
                force: false,
            },
        ]
    }
    fn team_reqs() -> Vec<ControlRequest> {
        let mut reqs = Vec::new();
        for op in [TeamOp::New, TeamOp::Load] {
            for script in [false, true] {
                reqs.push(ControlRequest::TerminalTeam {
                    dir: "team".into(),
                    op,
                    config_toml: None,
                    brief_content: None,
                    script,
                    window_id: None,
                    destination: None,
                    tabs: false,
                });
            }
        }
        reqs
    }

    #[test]
    fn a_workspace_tenant_runs_everything() {
        // Every command is allowed on a workspace tenant; the gate only ever
        // refuses on a standalone terminal.
        let mut reqs = vec![
            open_path("/x/y"),
            ControlRequest::OpenGraphLink {
                window_id: "w".into(),
                link: "chan://graph?s=workspace".into(),
                destination: None,
            },
            ControlRequest::OpenGraph {
                window_id: "w".into(),
                path: None,
                destination: None,
            },
            workspace_search(),
            term_new(Some("sub")),
            ControlRequest::Upload {
                window_id: "w".into(),
                path: PathBuf::from("/x"),
            },
        ];
        reqs.extend(session_reqs());
        reqs.extend(team_reqs());
        for req in reqs {
            assert_eq!(
                terminal_tenant_refusal(&req, ControlTenant::Workspace),
                None,
                "{req:?} runs on a workspace tenant",
            );
        }
    }

    #[test]
    fn cs_open_on_a_terminal_tenant_points_at_chan_open() {
        // `cs open PATH` from a standalone terminal is guided to `chan open
        // PATH`, echoing the path, and carries no em-dash (house style).
        let msg = terminal_tenant_refusal(&open_path("/home/u/notes"), ControlTenant::TerminalOnly)
            .expect("cs open refuses on a terminal tenant");
        assert!(msg.contains("chan open /home/u/notes"), "{msg}");
        assert!(!msg.contains('—'), "no em dash in guidance: {msg}");
    }

    #[test]
    fn workspace_only_commands_refuse_on_a_terminal_tenant_as_one_family() {
        // graph / search / terminal-new-path / every session* / every team*
        // (including --script) need a workspace, so they refuse on a standalone
        // terminal, and every refusal reads as the same message family.
        let mut reqs = vec![
            ControlRequest::OpenGraphLink {
                window_id: "w".into(),
                link: "chan://graph?s=workspace".into(),
                destination: None,
            },
            ControlRequest::OpenGraph {
                window_id: "w".into(),
                path: None,
                destination: None,
            },
            workspace_search(),
            term_new(Some("sub")),
        ];
        reqs.extend(session_reqs());
        reqs.extend(team_reqs());
        for req in reqs {
            let msg = terminal_tenant_refusal(&req, ControlTenant::TerminalOnly)
                .unwrap_or_else(|| panic!("{req:?} should refuse on a standalone terminal"));
            assert!(
                msg.contains("is only available in a workspace window")
                    && msg.contains("this is a standalone terminal"),
                "{req:?} refusal is off-family: {msg}",
            );
            assert!(!msg.contains('—'), "no em dash: {msg}");
        }
    }

    #[test]
    fn session_refusals_explain_the_missing_shared_session() {
        for req in session_reqs() {
            let msg = terminal_tenant_refusal(&req, ControlTenant::TerminalOnly)
                .expect("session commands refuse on a standalone terminal");
            assert!(msg.contains("no shared session to lead"), "{req:?}: {msg}");
        }
    }

    #[test]
    fn terminal_new_gate_depends_on_the_path_arg() {
        // `cs terminal new --path` needs a workspace root; `cs terminal new`
        // with no path is pure window routing and runs on a standalone
        // terminal.
        assert!(
            terminal_tenant_refusal(&term_new(Some("sub")), ControlTenant::TerminalOnly)
                .is_some_and(|m| m.contains("terminal new --path")),
        );
        assert_eq!(
            terminal_tenant_refusal(&term_new(None), ControlTenant::TerminalOnly),
            None,
        );
    }

    #[test]
    fn cwd_scoped_and_routing_commands_run_on_a_terminal_tenant() {
        // upload / download are cwd-scoped and dashboard / window-list are
        // pure routing: none of them need a workspace, so the gate lets them
        // through on a standalone terminal.
        for req in [
            ControlRequest::Upload {
                window_id: "w".into(),
                path: PathBuf::from("/x"),
            },
            ControlRequest::Download {
                window_id: "w".into(),
                path: PathBuf::from("/x/note.txt"),
            },
            ControlRequest::OpenDashboard {
                window_id: "w".into(),
                carousel_index: None,
                carousel_off: false,
                destination: None,
            },
            ControlRequest::WindowList,
        ] {
            assert_eq!(
                terminal_tenant_refusal(&req, ControlTenant::TerminalOnly),
                None,
                "{req:?} should run on a standalone terminal",
            );
        }
    }
}

// `UnserveScope` lives in chan-library; its `Host` variant carries a
// `Weak<dyn HostControl>`, so the control socket reaches the host (unserve)
// without naming the concrete `WorkspaceHost` -- the handler upgrades the weak
// and calls the trait-object method directly.
use chan_library::UnserveScope;

/// Shared server resources a control-socket connection needs, plus
/// the tenant gate. One value per `start`; cloned per connection
/// (every field is a cheap handle).
#[derive(Clone)]
pub struct ControlSocketCtx {
    pub workspace_cell: Arc<RwLock<Option<WorkspaceCell>>>,
    pub events_tx: broadcast::Sender<String>,
    pub self_writes: Arc<crate::self_writes::SelfWrites>,
    pub terminal_registry: TerminalRegistryCell,
    pub survey_bus: Arc<crate::survey::SurveyBus>,
    pub window_bus: Arc<crate::window_bus::WindowBus>,
    /// The per-tenant leader/followers session; `cs session list/self/handover/
    /// takeover` read and drive it (the `/ws` pump joins it per socket).
    pub session_registry: Arc<SessionRegistry>,
    /// `cs session handover` blocked-transport registry: the requester's
    /// oneshot parks here until the leader answers.
    pub handover_bus: Arc<HandoverBus>,
    /// Desktop integration: the window-ops channel (`None` standalone) and the
    /// shared title map. The lifecycle verbs send ops down the channel.
    pub desktop: crate::desktop_window_ops::DesktopBridge,
    pub tenant: ControlTenant,
    /// How `ControlRequest::Close` tears this process's workspace(s) down.
    pub unserve: UnserveScope,
}

pub fn start(socket_path: PathBuf, ctx: ControlSocketCtx) -> std::io::Result<ControlHandle> {
    let listener = transport::bind(&socket_path)?;
    Ok(ControlHandle {
        accept_loop: spawn_accept_loop(listener, ctx),
        socket_path,
        #[cfg(unix)]
        _stable_lock: None,
    })
}

/// [`start`] for a STABLE socket path (see [`stable_socket_path`]): take over
/// the path only when no live server owns it. On unix the takeover is
/// serialized by a flock on the `.lock` sibling, held for the handle's
/// lifetime, so a stale node from a dead server is replaced but a live
/// server's socket is never clobbered (the plain [`start`] bind unlinks
/// unconditionally, which is only safe for pid-unique paths). On windows the
/// named-pipe bind already has both properties: `first_pipe_instance(true)`
/// refuses a name a live process owns, and a dead owner's name is reclaimed
/// by the OS.
pub fn start_stable(socket_path: PathBuf, ctx: ControlSocketCtx) -> std::io::Result<ControlHandle> {
    #[cfg(unix)]
    {
        let stable_lock = take_stable_lock(&socket_path)?;
        let listener = transport::bind(&socket_path)?;
        Ok(ControlHandle {
            accept_loop: spawn_accept_loop(listener, ctx),
            socket_path,
            _stable_lock: Some(stable_lock),
        })
    }
    #[cfg(windows)]
    {
        start(socket_path, ctx)
    }
}

/// Own the takeover right for a stable socket path, or fail `AddrInUse` when
/// a live process holds it. The flock releases on process death, so a crashed
/// owner never wedges its successor.
///
/// The takeover retries briefly before giving up: a dead server's flock can
/// outlive it in any child it forked that has not exec'ed yet (the inherited
/// fd shares the lock's open file description until exec closes it), and the
/// server forks shell children constantly. A live server holds its flock for
/// its whole lifetime, so retrying never clobbers one. Only a persistent
/// `WouldBlock` means a live owner; any other lock failure propagates as
/// itself rather than masquerading as one.
#[cfg(unix)]
pub(crate) fn take_stable_lock(socket_path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    const ATTEMPTS: u32 = 5;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(25);

    let mut lock_path = socket_path.as_os_str().to_owned();
    lock_path.push(".lock");
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(PathBuf::from(lock_path))?;
    for _ in 1..ATTEMPTS {
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(_) => std::thread::sleep(RETRY_DELAY),
        }
    }
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(std::fs::TryLockError::WouldBlock) => Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            format!(
                "socket {} is owned by a live process",
                socket_path.display()
            ),
        )),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

fn spawn_accept_loop(mut listener: transport::Listener, ctx: ControlSocketCtx) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let conn = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!("control socket accept: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            let ctx = ctx.clone();
            tokio::spawn(serve_connection(conn, ctx));
        }
    })
}

/// Frame one accepted control connection: read a single line-framed JSON
/// `ControlRequest`, dispatch it, and write the JSON `ControlResponse` line
/// back. Platform-neutral -- it works over whatever read/write halves the
/// active `transport::Conn` yields (a unix stream or a windows named pipe).
async fn serve_connection(conn: transport::Conn, ctx: ControlSocketCtx) {
    let (read, mut write) = conn.into_split();
    // Bound the request read: a control request is one JSON line, and the
    // largest legitimate one is a `cs copy` clipboard payload (base64 of up to
    // MAX_CLIPBOARD_BYTES). Cap it so a hostile client cannot grow the request
    // `String` without bound. An over-cap line is truncated (no trailing
    // newline), so it fails to parse and answers a clean error instead of an OOM.
    let mut reader = BufReader::new(read.take(MAX_CONTROL_REQUEST_BYTES));
    let mut line = String::new();
    let request = match reader.read_line(&mut line).await {
        Ok(0) => Err(ControlResponse::Error {
            message: "empty control request".into(),
        }),
        Ok(_) => {
            serde_json::from_str::<ControlRequest>(&line).map_err(|e| ControlResponse::Error {
                message: format!("invalid control request: {e}"),
            })
        }
        Err(e) => Err(ControlResponse::Error {
            message: format!("read control request: {e}"),
        }),
    };
    let response = match request {
        Err(response) => response,
        // `cs tunnel` is the one LONG-LIVED request: the tunnel lives exactly
        // as long as this connection, so its handler owns both halves (it
        // watches the read half for the client's exit and may write a second
        // line when the desktop dies) instead of returning one response here.
        Ok(ControlRequest::Tunnel {
            window_id,
            proto,
            bind_addr,
            desktop_port,
            devserver_port,
        }) => {
            handle_tunnel(
                reader,
                &mut write,
                &ctx,
                TunnelRequest {
                    window_id,
                    proto,
                    bind_addr,
                    desktop_port,
                    devserver_port,
                },
            )
            .await;
            return;
        }
        Ok(req) => handle_request(req, &ctx).await,
    };
    write_response(&mut write, &response).await;
}

/// Write one line-framed JSON `ControlResponse`. A write failure means the
/// client is already gone, which every caller treats as the end of the
/// exchange.
async fn write_response<W: AsyncWrite + Unpin>(write: &mut W, response: &ControlResponse) {
    if let Ok(mut out) = serde_json::to_vec(response) {
        out.push(b'\n');
        let _ = write.write_all(&out).await;
    }
}

/// The cross-platform transport module -- the ONLY `#[cfg]`-split surface for
/// both the control socket AND the MCP bridge (`mcp_bridge.rs` reuses
/// `bind`/`accept` + `connect`/`Client`). unix uses a `UnixListener`/`UnixStream`;
/// windows uses a `tokio::net::windows::named_pipe` server/client. Both yield a
/// `Conn`/`Client` whose `into_split()` gives read/write halves that implement
/// `AsyncRead + AsyncWrite`, so the accept loop, `serve_connection`, the MCP
/// bridge, and every handler stay platform-neutral. tokio is `features=["full"]`
/// workspace-wide, so neither path adds a dep.
pub(crate) mod transport {
    #[cfg(unix)]
    mod imp {
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;

        use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
        use tokio::net::{UnixListener, UnixStream};

        pub struct Listener(UnixListener);
        pub struct Conn(UnixStream);
        /// Client end of the same transport (the proxy side). A distinct type
        /// from the accepted `Conn` because on Windows the client and server
        /// pipe handles are different types.
        pub struct Client(UnixStream);

        /// Bind the Unix-domain socket, clearing any stale node first (a
        /// crashed prior server can leave the path occupied).
        pub fn bind(path: &Path) -> std::io::Result<Listener> {
            let _ = std::fs::remove_file(path);
            let listener = UnixListener::bind(path)?;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            Ok(Listener(listener))
        }

        /// Connect to a bound transport as a client.
        pub async fn connect(path: &Path) -> std::io::Result<Client> {
            Ok(Client(UnixStream::connect(path).await?))
        }

        impl Listener {
            pub async fn accept(&mut self) -> std::io::Result<Conn> {
                let (stream, _peer) = self.0.accept().await?;
                Ok(Conn(stream))
            }
        }

        impl Conn {
            pub fn into_split(self) -> (OwnedReadHalf, OwnedWriteHalf) {
                self.0.into_split()
            }
        }

        impl Client {
            pub fn into_split(self) -> (OwnedReadHalf, OwnedWriteHalf) {
                self.0.into_split()
            }
        }
    }

    #[cfg(windows)]
    mod imp {
        use std::ffi::OsString;
        use std::path::Path;

        use tokio::io::{ReadHalf, WriteHalf};
        use tokio::net::windows::named_pipe::{
            ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
        };

        /// A named-pipe "listener". tokio creates one pipe instance per
        /// connection, so the listener always holds the next idle instance
        /// and mints a fresh one each time a client connects. `pipe_name` is
        /// the `\\.\pipe\...` string the socket "path" carries.
        pub struct Listener {
            pipe_name: OsString,
            next: NamedPipeServer,
        }
        pub struct Conn(NamedPipeServer);
        /// Client end (the proxy side): a named-pipe CLIENT handle, a distinct
        /// type from the server-side `Conn`.
        pub struct Client(NamedPipeClient);

        pub fn bind(path: &Path) -> std::io::Result<Listener> {
            let pipe_name = path.as_os_str().to_owned();
            // `first_pipe_instance(true)` makes the create fail if another
            // process already owns this name -- a squatter guard, mirroring
            // how the unix bind owns its filesystem path.
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)?;
            Ok(Listener { pipe_name, next })
        }

        /// Connect to a bound transport as a client (open the named pipe).
        pub async fn connect(path: &Path) -> std::io::Result<Client> {
            Ok(Client(ClientOptions::new().open(path.as_os_str())?))
        }

        impl Listener {
            pub async fn accept(&mut self) -> std::io::Result<Conn> {
                // Wait for a client on the idle instance, then swap in a
                // fresh instance for the next client BEFORE handing this one
                // back -- so a client that connects during the swap still
                // finds a server instance (the canonical tokio multi-client
                // loop; otherwise the next client races to `NotFound`).
                self.next.connect().await?;
                let connected = std::mem::replace(
                    &mut self.next,
                    ServerOptions::new().create(&self.pipe_name)?,
                );
                Ok(Conn(connected))
            }
        }

        impl Conn {
            pub fn into_split(self) -> (ReadHalf<NamedPipeServer>, WriteHalf<NamedPipeServer>) {
                tokio::io::split(self.0)
            }
        }

        impl Client {
            pub fn into_split(self) -> (ReadHalf<NamedPipeClient>, WriteHalf<NamedPipeClient>) {
                tokio::io::split(self.0)
            }
        }
    }

    // `Listener` names `spawn_accept_loop`'s parameter; `Conn` names
    // `serve_connection`'s. `connect` + `Client` are the proxy (client) side
    // the MCP bridge reuses.
    pub use imp::{bind, connect, Client, Conn, Listener};
}
// The transport split ends here; the request handlers below are platform-neutral.

// Async because of the one blocking variant (`TermSurvey`); every other
// arm returns synchronously without awaiting.
async fn handle_request(req: ControlRequest, ctx: &ControlSocketCtx) -> ControlResponse {
    let ControlSocketCtx {
        workspace_cell,
        events_tx,
        self_writes,
        terminal_registry,
        survey_bus,
        window_bus,
        session_registry,
        handover_bus,
        desktop,
        tenant,
        unserve,
    } = ctx;
    // The registry is a set-once cell that may be filled after the
    // socket starts; resolve it per request, exactly as before.
    let terminal_registry = terminal_registry.get();
    let tenant = *tenant;
    // Single chokepoint for standalone-terminal gating: refuse the
    // workspace-content commands here (with the friendly `chan open`
    // guidance for `cs open`) before any per-arm workspace resolution.
    if let Some(message) = terminal_tenant_refusal(&req, tenant) {
        return ControlResponse::Error { message };
    }
    match req {
        ControlRequest::OpenPath {
            window_id,
            path,
            destination,
        } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            let workspace = match workspace_from_cell(workspace_cell) {
                Ok(workspace) => workspace,
                Err(message) => return ControlResponse::Error { message },
            };
            if let Err(message) = require_connected_window(session_registry, &window_id) {
                return ControlResponse::Error { message };
            }
            into_response(open_path(
                &workspace,
                self_writes,
                &window_id,
                &path,
                destination,
                session_registry,
                events_tx,
            ))
        }
        ControlRequest::OpenGraphLink {
            window_id,
            link,
            destination,
        } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            if let Err(message) = workspace_from_cell(workspace_cell).map(|_| ()) {
                return ControlResponse::Error { message };
            }
            if let Err(message) = require_connected_window(session_registry, &window_id) {
                return ControlResponse::Error { message };
            }
            into_response(open_graph_link(
                &window_id,
                &link,
                destination,
                session_registry,
                events_tx,
            ))
        }
        ControlRequest::OpenGraph {
            window_id,
            path,
            destination,
        } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            let workspace = match workspace_from_cell(workspace_cell) {
                Ok(workspace) => workspace,
                Err(message) => return ControlResponse::Error { message },
            };
            if let Err(message) = require_connected_window(session_registry, &window_id) {
                return ControlResponse::Error { message };
            }
            into_response(open_graph(
                &workspace,
                &window_id,
                path.as_deref(),
                destination,
                session_registry,
                events_tx,
            ))
        }
        ControlRequest::OpenTermNew {
            window_id,
            path,
            tab_name,
            tab_group,
            destination,
        } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            if let Err(message) = require_connected_window(session_registry, &window_id) {
                return ControlResponse::Error { message };
            }
            // Opening a terminal is window routing, not a workspace operation:
            // the only workspace use is resolving an optional --path cwd. So a
            // standalone terminal tenant CAN open a terminal (no cwd to
            // resolve); a `--path` on a standalone terminal is already refused
            // by `terminal_tenant_refusal`, so this branch never sees one.
            // This mirrors `WindowList`'s tenant branch.
            match tenant {
                ControlTenant::TerminalOnly => into_response(open_term_new_standalone(
                    &window_id,
                    TerminalOpenSpec {
                        tab_name,
                        tab_group,
                        destination,
                    },
                    session_registry,
                    events_tx,
                )),
                ControlTenant::Workspace => {
                    let workspace = match workspace_from_cell(workspace_cell) {
                        Ok(workspace) => workspace,
                        Err(message) => return ControlResponse::Error { message },
                    };
                    into_response(open_term_new(
                        &workspace,
                        &window_id,
                        path.as_deref(),
                        TerminalOpenSpec {
                            tab_name,
                            tab_group,
                            destination,
                        },
                        session_registry,
                        events_tx,
                    ))
                }
            }
        }
        ControlRequest::OpenDashboard {
            window_id,
            carousel_index,
            carousel_off,
            destination,
        } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            if let Err(message) = require_connected_window(session_registry, &window_id) {
                return ControlResponse::Error { message };
            }
            into_response(open_dashboard(
                &window_id,
                carousel_index,
                carousel_off,
                destination,
                session_registry,
                events_tx,
            ))
        }
        ControlRequest::Upload { window_id, path } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            // A standalone terminal has no workspace to anchor at: the CLI
            // already absolutized `path` against the session cwd, so the
            // transfer is cwd / shell-uid scoped (no workspace wall).
            match tenant {
                ControlTenant::TerminalOnly => {
                    into_response(upload_path_standalone(&window_id, &path, events_tx))
                }
                ControlTenant::Workspace => {
                    let workspace = match workspace_from_cell(workspace_cell) {
                        Ok(workspace) => workspace,
                        Err(message) => return ControlResponse::Error { message },
                    };
                    into_response(upload_path(&workspace, &window_id, &path, events_tx))
                }
            }
        }
        ControlRequest::Download { window_id, path } => {
            if let Err(message) = require_window_id(&window_id) {
                return ControlResponse::Error { message };
            }
            match tenant {
                ControlTenant::TerminalOnly => {
                    into_response(download_path_standalone(&window_id, &path, events_tx))
                }
                ControlTenant::Workspace => {
                    let workspace = match workspace_from_cell(workspace_cell) {
                        Ok(workspace) => workspace,
                        Err(message) => return ControlResponse::Error { message },
                    };
                    into_response(download_path(&workspace, &window_id, &path, events_tx))
                }
            }
        }
        ControlRequest::TermWrite {
            tab_name,
            tab_group,
            data,
            submit,
        } => {
            let Some(registry) = terminal_registry else {
                return ControlResponse::Error {
                    message: "terminal registry unavailable".into(),
                };
            };
            term_write_response(
                registry,
                tab_name.as_deref(),
                tab_group.as_deref(),
                &data,
                // Whether to submit, plus the agent the sender named. Any
                // legacy client-resolved template is dropped here: the
                // registry derives each session's chord itself.
                submit.map(|s| s.agent()),
            )
        }
        ControlRequest::TermList => {
            let Some(registry) = terminal_registry else {
                return ControlResponse::Error {
                    message: "terminal registry unavailable".into(),
                };
            };
            // Resolve the library window set (the same source `WindowList` reads)
            // so the listing can name each session's owning window + kind +
            // liveness. A standalone serve has no host, so the set is empty and
            // every session reads back `orphaned` -- honest, not wrong.
            let windows = match unserve {
                UnserveScope::Host(weak) => weak
                    .upgrade()
                    .map(|host| host.assemble_window_records())
                    .unwrap_or_default(),
                UnserveScope::Standalone { .. } | UnserveScope::Unsupported => Vec::new(),
            };
            into_response(term_list(registry, &windows))
        }
        ControlRequest::TermRestart {
            tab_name,
            tab_group,
        } => {
            let Some(registry) = terminal_registry else {
                return ControlResponse::Error {
                    message: "terminal registry unavailable".into(),
                };
            };
            into_response(term_restart(
                registry,
                tab_name.as_deref(),
                tab_group.as_deref(),
            ))
        }
        ControlRequest::TermClose {
            tab_name,
            tab_group,
        } => {
            let Some(registry) = terminal_registry else {
                return ControlResponse::Error {
                    message: "terminal registry unavailable".into(),
                };
            };
            into_response(term_close(
                registry,
                tab_name.as_deref(),
                tab_group.as_deref(),
            ))
        }
        ControlRequest::TermScrollback { tab_name } => {
            let Some(registry) = terminal_registry else {
                return ControlResponse::Error {
                    message: "terminal registry unavailable".into(),
                };
            };
            into_response(term_scrollback(registry, &tab_name))
        }
        ControlRequest::WindowList => {
            // The library is the single authority for the window set: one
            // assembly (`assemble_window_records`) the desktop watcher, the
            // launcher, and `cs window list` all reconcile to, so they never
            // disagree. A standalone `chan open` serve has no host and thus no
            // library window set -- the honest answer is empty.
            let records = match unserve {
                UnserveScope::Host(weak) => weak
                    .upgrade()
                    .map(|host| host.assemble_window_records())
                    .unwrap_or_default(),
                UnserveScope::Standalone { .. } | UnserveScope::Unsupported => Vec::new(),
            };
            into_response(
                serde_json::to_string(&records).map_err(|e| format!("encoding window list: {e}")),
            )
        }
        ControlRequest::SessionList => handle_session_list(session_registry),
        ControlRequest::SessionSelf {
            window_id,
            name,
            reset,
        } => handle_session_self(session_registry, events_tx, window_id, name, reset),
        ControlRequest::SessionHandover {
            window_id,
            to,
            accept,
            reject,
            timeout_secs,
        } => {
            // None requests a handover; Some(true/false) is the leader's
            // accept/reject answer.
            let answer = if accept {
                Some(true)
            } else if reject {
                Some(false)
            } else {
                None
            };
            handle_session_handover(
                session_registry,
                handover_bus,
                events_tx,
                window_id,
                to,
                answer,
                timeout_secs,
            )
            .await
        }
        ControlRequest::SessionTakeover { window_id, force } => {
            handle_session_takeover(session_registry, events_tx, window_id, force)
        }
        ControlRequest::Identify => {
            // Classify this serving process for `chan ps`. `unserve` separates a
            // standalone `serve` (its own shutdown signal) from a hosted tenant;
            // among hosted tenants, an active desktop window-ops channel marks
            // chan-desktop, its absence a headless devserver.
            let kind = if matches!(unserve, UnserveScope::Standalone { .. }) {
                ServeKind::Standalone
            } else if desktop.window_ops.is_some() {
                ServeKind::Desktop
            } else {
                ServeKind::Devserver
            };
            let workspace_identity = workspace_from_cell(workspace_cell).ok().map(|workspace| {
                (
                    workspace.canonical_root().to_path_buf(),
                    workspace.metadata_key().to_string(),
                )
            });
            let identity = Identity {
                kind,
                version: env!("CARGO_PKG_VERSION").to_string(),
                // Lets a caller that reached this socket by name-scanning
                // (stable devserver sockets carry no pid in the filename)
                // confirm which process it landed on.
                pid: std::process::id(),
                workspace_root: workspace_identity.as_ref().map(|(root, _)| root.clone()),
                metadata_key: workspace_identity.map(|(_, key)| key),
            };
            into_response(
                serde_json::to_string(&identity).map_err(|e| format!("encoding identity: {e}")),
            )
        }
        ControlRequest::WorkspaceSearch { request } => {
            let workspace = match workspace_from_cell(workspace_cell) {
                Ok(workspace) => workspace,
                Err(message) => return ControlResponse::Error { message },
            };
            into_response(workspace_search_json(&workspace, &request))
        }
        ControlRequest::Export { path, format, out } => {
            handle_export(path, format, out, session_registry, events_tx, window_bus).await
        }
        ControlRequest::TermSurvey {
            tab_name,
            tab_group,
            spec,
            timeout_secs,
        } => {
            handle_survey(
                spec,
                tab_name.as_deref(),
                tab_group.as_deref(),
                timeout_secs,
                events_tx,
                survey_bus,
                terminal_registry,
            )
            .await
        }
        ControlRequest::TerminalTeam {
            dir,
            op,
            config_toml,
            brief_content,
            script,
            window_id,
            destination,
            tabs,
        } => {
            if !script {
                if let Some(window_id) = window_id.as_deref() {
                    if let Err(message) = require_connected_window(session_registry, window_id) {
                        return ControlResponse::Error { message };
                    }
                } else if destination.is_some() {
                    return ControlResponse::Error {
                        message: "team placement needs a target window".into(),
                    };
                }
            }
            handle_team(
                TeamRequest {
                    dir,
                    op,
                    config_toml,
                    brief_content,
                    script,
                    window_id,
                    destination,
                    tabs,
                },
                ctx,
            )
            .await
        }
        ControlRequest::PaneQuery {
            window_id,
            tab_name,
        } => {
            handle_pane_query(
                window_id,
                tab_name,
                events_tx,
                window_bus,
                terminal_registry,
                session_registry,
            )
            .await
        }
        ControlRequest::PaneExec {
            window_id,
            tab_name,
            op,
        } => {
            handle_pane_exec(
                window_id,
                tab_name,
                op,
                events_tx,
                window_bus,
                terminal_registry,
                session_registry,
            )
            .await
        }
        ControlRequest::ClipboardCopy {
            window_id,
            data_b64,
            mime,
        } => handle_clipboard_copy(window_id, data_b64, mime, events_tx, window_bus).await,
        ControlRequest::ClipboardPaste { window_id, prefer } => {
            handle_clipboard_paste(window_id, prefer, events_tx, window_bus).await
        }
        ControlRequest::WindowNew => handle_window_new(desktop, workspace_cell, tenant).await,
        ControlRequest::WindowOpen { id } => into_response(
            desktop
                .dispatch(|reply| DesktopWindowOp::Open {
                    id: id.clone(),
                    reply,
                })
                .await
                .map(|()| format!("opened window {id}")),
        ),
        ControlRequest::WindowClose { id, force } => {
            handle_window_close(desktop, unserve, workspace_cell, tenant, id, force).await
        }
        ControlRequest::WindowHide { id } => into_response(
            desktop
                .dispatch(|reply| DesktopWindowOp::Hide {
                    id: id.clone(),
                    reply,
                })
                .await
                .map(|()| format!("hid window {id}")),
        ),
        ControlRequest::Close { path, remove } => handle_unserve(unserve, &path, remove).await,
        // `cs tunnel` is served by `serve_connection` instead: the tunnel's
        // lifetime is the connection's, so its handler needs both halves and
        // may write more than one response line. This dispatch answers exactly
        // one line per request, so it can only refuse.
        ControlRequest::Tunnel { .. } => ControlResponse::Error {
            message: "cs tunnel is served on the control connection, not the request dispatch"
                .into(),
        },
    }
}

/// Tear down whatever this process serves for `path`, the server side of
/// `chan close`. The scope (built at mount time) decides: a standalone
/// `chan open` serve of that root fires its graceful-shutdown signal so the
/// process exits and the flock releases; a multi-tenant host unmounts just
/// that tenant; an opt-out process refuses. The response still flushes before
/// a standalone process drains and exits.
///
/// `remove` carries `chan close --remove` (and `chan workspace rm`) through to
/// a HOST: it then also UNREGISTERS the workspace from its library + overlay
/// (so a devserver-served workspace disappears from the launcher and does not
/// survive a restart), not just unmounts it. A standalone serve ignores it --
/// it exits either way, and the caller forgets the local registry.
fn live_terminals_body(active_terminals: usize) -> String {
    format!(r#"{{"error":"live_terminals","active_terminals":{active_terminals}}}"#)
}

async fn handle_unserve(scope: &UnserveScope, path: &Path, remove: bool) -> ControlResponse {
    match scope {
        UnserveScope::Standalone { root, shutdown_tx } => {
            if !same_path(root, path) {
                return ControlResponse::Error {
                    message: format!(
                        "this server does not serve {} (it serves {})",
                        path.display(),
                        root.display()
                    ),
                };
            }
            let _ = shutdown_tx.send(true);
            ControlResponse::Ok {
                message: format!("unserving {}", path.display()),
            }
        }
        UnserveScope::Host(weak) => match weak.upgrade() {
            None => ControlResponse::Error {
                message: "host is shutting down".into(),
            },
            // `--remove` routes through the host's registry+overlay removal (the
            // `DELETE /api/library/workspaces/{id}` equivalent), so the host's
            // own library + persisted overlay reflect it; a plain close just
            // unmounts the tenant and keeps the registration.
            Some(host) if remove => match host.remove_workspace_for_root(path, false).await {
                Ok(chan_library::WorkspaceLifecycleOutcome::Completed) => ControlResponse::Ok {
                    message: format!("removed {}", path.display()),
                },
                Ok(chan_library::WorkspaceLifecycleOutcome::NotFound) => ControlResponse::Error {
                    message: format!("no workspace registered for {}", path.display()),
                },
                Ok(chan_library::WorkspaceLifecycleOutcome::Refused { active_terminals }) => {
                    ControlResponse::Error {
                        message: live_terminals_body(active_terminals),
                    }
                }
                Err(e) => ControlResponse::Error {
                    message: format!("removing {}: {e}", path.display()),
                },
            },
            Some(host) => match host.close_workspace_for_root(path, false).await {
                Ok(chan_library::WorkspaceLifecycleOutcome::Completed) => ControlResponse::Ok {
                    message: format!("unmounted {}", path.display()),
                },
                Ok(chan_library::WorkspaceLifecycleOutcome::NotFound) => ControlResponse::Error {
                    message: format!("no workspace mounted for {}", path.display()),
                },
                Ok(chan_library::WorkspaceLifecycleOutcome::Refused { active_terminals }) => {
                    ControlResponse::Error {
                        message: live_terminals_body(active_terminals),
                    }
                }
                Err(e) => ControlResponse::Error {
                    message: format!("unmounting {}: {e}", path.display()),
                },
            },
        },
        UnserveScope::Unsupported => ControlResponse::Error {
            message: format!(
                "cannot unserve {} from here: this process exposes no control-socket teardown",
                path.display()
            ),
        },
    }
}

/// Whether two paths denote the same workspace root, comparing canonical
/// forms and falling back to the literal path when the filesystem can't
/// canonicalize (a root that moved or went missing still matches itself).
fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// `handle_team`'s dispatch payload: the `ControlRequest::TerminalTeam`
/// variant's fields, bundled at the dispatch site. The wire enum itself
/// stays flat (serde shape frozen).
struct TeamRequest {
    dir: String,
    op: TeamOp,
    config_toml: Option<String>,
    /// The brief text (`cs terminal team new --brief <file>`, read client-side)
    /// folded verbatim into the generated `bootstrap.md`. `new`-only; ignored
    /// by `load` (which never regenerates the bootstrap).
    brief_content: Option<String>,
    script: bool,
    /// The caller's window ($CHAN_WINDOW_ID), when present: every spawned
    /// agent session binds to it so the agents carry $CHAN_WINDOW_ID and the
    /// window-targeting `cs` commands work from inside an agent. The same
    /// window receives the `TeamSpawned` surfacing push.
    window_id: Option<String>,
    destination: Option<TabDestination>,
    /// `--tabs`: stack every member in one pane even when the config's
    /// members carry grid positions (the layout opt-out).
    tabs: bool,
}

/// The `cs terminal team new|load` path. `new` parses the supplied
/// config.toml text, stamps `created_at` when omitted, validates, then
/// either emits the paste-and-run bootstrap script (`--script`) or writes
/// `config.toml` + the regenerated `bootstrap.md` + the dir tree through
/// the Workspace sandbox AND brings the team up server-side via the
/// terminal registry (lead first). `load` reads + validates
/// `{dir}/config.toml`, then emits the script (`--script`) or a one-line
/// summary. All the config logic lives in `routes::team_config` so the CLI
/// path and the HTTP route share one source of truth (the bootstrap is
/// never regenerated client-side).
///
/// async because the non-`--script` path waits for each spawned agent's
/// terminal readiness before poking its identity prompt.
async fn handle_team(req: TeamRequest, ctx: &ControlSocketCtx) -> ControlResponse {
    use crate::routes::team_config::{
        ensure_created_at, generate_bootstrap_script, read_team_config, team_grid_shape,
        validate_team_config, write_team_config,
    };

    let TeamRequest {
        dir,
        op,
        config_toml,
        brief_content,
        script,
        window_id,
        destination,
        tabs,
    } = req;
    // The registry is a set-once cell that may be filled after the socket
    // starts; resolve it per request.
    let terminal_registry = ctx.terminal_registry.get();
    let workspace_cell = &ctx.workspace_cell;
    let events_tx = &ctx.events_tx;

    // Mirror the route's dir guard so a bad dir is a clean message, not a
    // sandbox error deeper in the write path.
    let dir = dir.trim();
    if dir.is_empty() {
        return ControlResponse::Error {
            message: "team directory is required".into(),
        };
    }
    if dir.starts_with('/') {
        return ControlResponse::Error {
            message: format!("team directory must be workspace-relative, not absolute: {dir}"),
        };
    }

    // The workspace is resolved lazily: `new --script` is a pure generator
    // (no filesystem I/O), so only the write (`new`) and read (`load`)
    // paths touch the cell.
    match op {
        TeamOp::New => {
            let Some(toml_text) = config_toml else {
                return ControlResponse::Error {
                    message: "cs terminal team new needs a config (--config <file> or --stdin)"
                        .into(),
                };
            };
            let mut config: TeamConfig = match toml::from_str(&toml_text) {
                Ok(config) => config,
                Err(e) => {
                    return ControlResponse::Error {
                        message: format!("invalid team config TOML: {e}"),
                    }
                }
            };
            ensure_created_at(&mut config);
            if let Err(message) = validate_team_config(&config) {
                return ControlResponse::Error { message };
            }
            if script {
                return ControlResponse::Ok {
                    message: generate_bootstrap_script(dir, &config, brief_content.as_deref()),
                };
            }
            let workspace = match workspace_from_cell(workspace_cell) {
                Ok(workspace) => workspace,
                Err(message) => return ControlResponse::Error { message },
            };
            // The grid precondition runs BEFORE the write so a refusal
            // leaves nothing on disk: the caller cleans up the window (or
            // opts out) and reruns the same `new`. Skipped without a
            // registry (nothing will spawn) and with an explicit `--pane`
            // (the caller named the seed pane to carve).
            if terminal_registry.is_some()
                && !tabs
                && team_grid_shape(&config).is_some()
                && !explicit_pane(&destination)
            {
                if let Some(window_id) = window_id.as_deref() {
                    if let Err(message) = require_single_pane_window(window_id, ctx).await {
                        return ControlResponse::Error { message };
                    }
                }
            }
            if let Err(message) =
                write_team_config(&workspace, dir, &config, brief_content.as_deref())
            {
                return ControlResponse::Error { message };
            }
            // The config + bootstrap.md + tree are on disk. Without a
            // terminal registry (a server with terminals disabled) there is
            // nothing to spawn into, so report the write and stop.
            let Some(registry) = terminal_registry else {
                return ControlResponse::Ok {
                    message: format!(
                        "team {:?} written to {dir} ({} member(s)); no terminal registry to spawn into",
                        config.team_name,
                        config.members.len()
                    ),
                };
            };
            spawn_and_poke_team(
                registry,
                dir,
                &config,
                tabs,
                window_id.as_deref(),
                destination,
                &ctx.session_registry,
                events_tx,
            )
            .await
        }
        TeamOp::Load => {
            let workspace = match workspace_from_cell(workspace_cell) {
                Ok(workspace) => workspace,
                Err(message) => return ControlResponse::Error { message },
            };
            let config = match read_team_config(&workspace, dir) {
                Ok(config) => config,
                Err(message) => return ControlResponse::Error { message },
            };
            if script {
                return ControlResponse::Ok {
                    // Load never folds a brief: it reads an existing team and
                    // never regenerates its `bootstrap.md`.
                    message: generate_bootstrap_script(dir, &config, None),
                };
            }
            // Load now brings the saved team UP, not just summarizes it: read
            // + validate `{dir}/config.toml`, then spawn lead-first and
            // identity-poke each agent, exactly like `new` does after its
            // write (it shares spawn_and_poke_team, so a freshly-written and a
            // reloaded team come up identically). Without a terminal registry
            // there is nothing to spawn into, so fall back to a read-only
            // summary.
            let Some(registry) = terminal_registry else {
                let lead = config
                    .members
                    .iter()
                    .find(|m| m.is_lead)
                    .map(|m| m.handle.as_str())
                    .unwrap_or("?");
                return ControlResponse::Ok {
                    message: format!(
                        "team {:?} at {dir}: {} member(s), lead {lead}; no terminal registry to spawn into",
                        config.team_name,
                        config.members.len()
                    ),
                };
            };
            // Same grid precondition as `new`; `load` mutates nothing, so
            // it runs right before the spawn.
            if !tabs && team_grid_shape(&config).is_some() && !explicit_pane(&destination) {
                if let Some(window_id) = window_id.as_deref() {
                    if let Err(message) = require_single_pane_window(window_id, ctx).await {
                        return ControlResponse::Error { message };
                    }
                }
            }
            spawn_and_poke_team(
                registry,
                dir,
                &config,
                tabs,
                window_id.as_deref(),
                destination,
                &ctx.session_registry,
                events_tx,
            )
            .await
        }
    }
}

/// Whether the caller named the exact seed pane (`--pane`), which replaces
/// the single-pane precondition: the grid carves the named pane instead of
/// the window's only one.
fn explicit_pane(destination: &Option<TabDestination>) -> bool {
    destination.as_ref().is_some_and(|d| d.pane_id.is_some())
}

/// The pane-grid precondition for a positioned team config: the target
/// window must currently hold exactly ONE pane (any number of tabs), the
/// seed the SPA carves into the config's grid. A busier window is refused
/// with each way out spelled per remedy, BEFORE anything is written or
/// spawned, so a refusal never leaves a half-provisioned team. The check
/// reads the live layout through the same `pane_query` round-trip `cs pane`
/// uses (the server itself holds no layout state); the carve races a
/// concurrent layout change only within the push-to-apply window, which the
/// SPA's own destination validation already bounds.
async fn require_single_pane_window(window_id: &str, ctx: &ControlSocketCtx) -> Result<(), String> {
    let response = pane_round_trip(
        window_id,
        |request_id| WindowCommand::PaneQuery { request_id },
        &ctx.events_tx,
        &ctx.window_bus,
        &ctx.session_registry,
    )
    .await;
    let payload = match response {
        ControlResponse::Ok { message } => message,
        ControlResponse::Error { message } => {
            return Err(format!(
                "could not verify window {window_id}'s pane layout: {message}"
            ))
        }
        other => {
            return Err(format!(
                "could not verify window {window_id}'s pane layout: unexpected reply {other:?}"
            ))
        }
    };
    let panes = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .and_then(|v| v.get("panes").and_then(|p| p.as_array()).map(Vec::len));
    match panes {
        None => Err(format!(
            "could not verify window {window_id}'s pane layout: malformed pane reply"
        )),
        Some(1) => Ok(()),
        Some(n) => Err(format!(
            "the team config positions its members into a pane grid, but window {window_id} has \
             {n} panes; close the extra panes (cs pane list, cs pane close-pane --pane <ID>), \
             rerun with --tabs to stack the team in the current pane, or rerun with --window <ID> \
             against a fresh window (cs window new on chan-desktop)"
        )),
    }
}

/// Maximum time an agent member gets to enable bracketed-paste mode. Every
/// supported agent emits DECSET 2004 when its TUI takes control of the PTY.
const TEAM_SPAWN_POKE_READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Gap between the body write and the submit-chord write of a multi-write
/// poke (gemini: the prompt, then the bare CR as a distinct keypress). The
/// gap lets gemini render + settle on the body before the CR arrives, so the
/// CR is read as Enter rather than coalesced into the body's read. The
/// queue-based poke paths (cs / Rich Prompt) get this separation for free
/// from the drainer's idle-gating; this direct-write spawn path needs an
/// explicit gap.
const SUBMIT_SPLIT_GAP: std::time::Duration = std::time::Duration::from_millis(400);

#[derive(Debug)]
struct TeamPoke {
    member: String,
    terminal: AttachHandle,
    writes: Vec<String>,
}

#[derive(Debug, Default)]
struct TeamPokeResult {
    poked: usize,
    failed: Vec<(String, String)>,
}

/// What a server-side team spawn produced: the resolved group, the members
/// that came up, the ones that failed (with the spawn error), and the exact
/// session handles carrying each agent's pending identity poke.
struct TeamSpawn {
    group: String,
    spawned: Vec<String>,
    failed: Vec<(String, String)>,
    /// One exact session handle per AGENT member plus the ordered PTY writes
    /// that deliver and submit its identity prompt. Most agents use one write;
    /// gemini uses two with a gap so its CR remains a distinct keypress.
    pokes: Vec<TeamPoke>,
    /// Each spawned member's tab name + live `session_id`, for the
    /// SPA-surfacing push (`WindowCommand::TeamSpawned`).
    members: Vec<SpawnedMember>,
}

/// Resolve the team's terminal group against the LIVE registry, appending
/// `-N` until unique so a new team never joins an existing group. Mirrors
/// the SPA's `resolveTeamGroup` (teamOrchestrator.svelte.ts): it reads the
/// same resolved-group set `cs terminal list` shows.
fn resolve_team_group(registry: &TerminalRegistry, base: &str) -> String {
    // Group resolution needs only the live tab_groups, so use the cwd-free
    // `roster()` rather than `session_summaries()` (which shells `lsof` per
    // session) -- no point probing every PTY's cwd just to dedup a group name.
    let live: std::collections::HashSet<String> =
        registry.roster().into_iter().map(|s| s.tab_group).collect();
    if !live.contains(base) {
        return base.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !live.contains(&candidate) {
            return candidate;
        }
    }
    base.to_string()
}

/// Bring the team up via the terminal registry: resolve the group, spawn
/// lead-first (full command + env + tab-name + group), and compute the
/// per-agent identity pokes. The poke payload is built with the SAME
/// `identity_prompt` + `apply_submit_chord` the `--script` form emits, so
/// the direct `new` reproduces the script's bytes. Shell members (no agent)
/// spawn but get no poke. A member whose command fails to start is recorded
/// in `failed` and does not abort the rest of the team (mirrors
/// runTeamBootstrap's per-worker try/catch). This step is synchronous (the
/// readiness wait + poke delivery happen in `spawn_and_poke_team`).
fn spawn_team(
    registry: &TerminalRegistry,
    dir: &str,
    config: &TeamConfig,
    tabs: bool,
    window_id: Option<&str>,
) -> TeamSpawn {
    use crate::routes::team_config::{identity_prompt, lead_first_order, team_base_group};

    let group = resolve_team_group(registry, team_base_group(config));
    let mut spawned = Vec::new();
    let mut failed = Vec::new();
    let mut pokes = Vec::new();
    let mut members = Vec::new();
    for m in lead_first_order(config) {
        // A blank command runs the member's default login shell (a shell
        // member); a named command (claude/codex/...) is the PTY program.
        let command = {
            let trimmed = m.command.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        };
        let opts = CreateOptions {
            // No client is attached at spawn time; a real attach resizes via
            // the WS Resize frame. 80x24 is the standard default.
            size: PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            tab_name: Some(m.handle.clone()),
            tab_group: Some(group.clone()),
            // Bind every agent to the caller's window when there is one, so
            // the spawned session exports $CHAN_WINDOW_ID (a window-targeting
            // `cs` command run inside the agent resolves a window) and
            // `window_ids_matching` finds the agent's window. None when the
            // caller is windowless (a native terminal), unchanged from before.
            window_id: window_id.map(str::to_string),
            // MCP env starts OFF; a team opts in via its config's
            // `mcp_env` toggle (team setup dialog / `cs terminal team
            // new|load`). Off by default keeps codex (which wants a
            // file-based MCP config) from failing on a stray descriptor.
            mcp_env: config.mcp_env,
            cwd: None,
            command,
            env: m.env.clone(),
        };
        match registry.create(opts) {
            Ok(handle) => {
                // Capture the session id for the surfacing push. Agent members
                // retain this exact handle through readiness and poke delivery;
                // shell members drop it after the spawn record is complete.
                spawned.push(m.handle.clone());
                members.push(SpawnedMember {
                    // The registry may have settled the name away from the
                    // config handle (`-N` on a live collision); surface the
                    // settled name so the tab title matches the PTY's
                    // $CHAN_TAB_NAME (what `cs terminal write --tab-name`
                    // resolves).
                    tab_name: handle.spawn_name().unwrap_or(m.handle.as_str()).to_string(),
                    session_id: handle.id().to_string(),
                    // `--tabs` strips the grid coordinates so the SPA takes
                    // its stack-in-one-pane path.
                    position: if tabs { None } else { m.position },
                });
                // Derive the submit agent from the command (+ CHAN_AGENT env
                // override), the single source of truth shared with the SPA;
                // a shell member derives None and gets no identity poke.
                if let Some(agent) =
                    SubmitAgent::derive(&m.command, m.env.get("CHAN_AGENT").map(String::as_str))
                {
                    let writes = submit_writes(identity_prompt(config, dir, m), Some(agent));
                    pokes.push(TeamPoke {
                        member: m.handle.clone(),
                        // `opts.command` created this PTY with the member's
                        // command. The server path never creates an interactive
                        // shell session and later types the command into it, so
                        // this handle cannot observe readiness from a preceding
                        // shell life.
                        terminal: handle,
                        writes,
                    });
                }
            }
            Err(e) => failed.push((m.handle.clone(), e.to_string())),
        }
    }
    TeamSpawn {
        group,
        spawned,
        failed,
        pokes,
        members,
    }
}

/// The non-`--script` team spawn path: bring the team up, then deliver each
/// identity poke as soon as that agent enables bracketed-paste mode. Members
/// wait concurrently, so one slow client does not delay a ready peer. Returns
/// only after every agent was poked or reached the readiness bound.
#[allow(clippy::too_many_arguments)]
async fn spawn_and_poke_team(
    registry: &Arc<TerminalRegistry>,
    dir: &str,
    config: &TeamConfig,
    tabs: bool,
    window_id: Option<&str>,
    destination: Option<TabDestination>,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> ControlResponse {
    let mut spawn = spawn_team(registry, dir, config, tabs, window_id);
    let mut surface_error = None;

    // Surface the spawned team in the window that owns it (each agent
    // is bound to `window_id`). The same window opens a terminal tab per
    // member ATTACHED to the live session, so a CLI `cs terminal team new`
    // shows up in the running SPA instead of only on the SPA's next attach.
    // A windowless spawn has no window to surface into. Sent before the
    // readiness wait so the tabs appear while the agents start; the poke
    // reaches the PTYs independently of any SPA attach.
    if let Some(window_id) = window_id {
        if !spawn.members.is_empty() {
            surface_error = send_window_command_if_live(
                session_registry,
                window_id,
                WindowCommand::TeamSpawned {
                    group: spawn.group.clone(),
                    members: spawn.members.clone(),
                    destination,
                },
                events_tx,
            )
            .err();
        }
    }

    // Shell members have no compose box and therefore no poke entry. Joining
    // an empty set returns immediately, preserving the all-shell fast path.
    let poke_result = deliver_team_pokes(&mut spawn.pokes).await;

    let summary = team_spawn_summary(&config.team_name, &spawn, &poke_result);

    if let Some(error) = surface_error {
        let summary = match summary {
            ControlResponse::Ok { message } | ControlResponse::Error { message } => message,
            _ => unreachable!("team spawn summaries use ok or error responses"),
        };
        ControlResponse::Error {
            message: format!(
                "{summary}; team {:?} spawned but could not be surfaced: {error}",
                config.team_name
            ),
        }
    } else {
        summary
    }
}

async fn deliver_team_pokes(pokes: &mut [TeamPoke]) -> TeamPokeResult {
    let results = futures::future::join_all(pokes.iter_mut().map(|poke| async move {
        match tokio::time::timeout(
            TEAM_SPAWN_POKE_READY_TIMEOUT,
            poke.terminal.wait_for_bracketed_paste(),
        )
        .await
        {
            Ok(true) => {
                // Most agents have a single write; gemini has two (prompt,
                // then the bare CR), which must arrive as distinct keypresses.
                for (index, write) in poke.writes.iter().enumerate() {
                    if index > 0 {
                        tokio::time::sleep(SUBMIT_SPLIT_GAP).await;
                    }
                    poke.terminal.send_input(write.as_bytes());
                }
                Ok(())
            }
            Ok(false) => Err((
                poke.member.clone(),
                "terminal ended before enabling bracketed-paste mode".to_string(),
            )),
            Err(_) => Err((
                poke.member.clone(),
                format!(
                    "did not enable bracketed-paste mode within {}s",
                    TEAM_SPAWN_POKE_READY_TIMEOUT.as_secs()
                ),
            )),
        }
    }))
    .await;

    let mut outcome = TeamPokeResult::default();
    for result in results {
        match result {
            Ok(()) => outcome.poked += 1,
            Err(failure) => outcome.failed.push(failure),
        }
    }
    outcome
}

/// Render the CLI-facing response for a completed `spawn_team`: an error when
/// nothing came up, else a one-line summary of the spawned + poked + failed
/// counts. Pure (no I/O) so the wording is unit-tested without a PTY wait.
fn team_spawn_summary(
    team_name: &str,
    spawn: &TeamSpawn,
    poke_result: &TeamPokeResult,
) -> ControlResponse {
    if spawn.spawned.is_empty() {
        return ControlResponse::Error {
            message: format!(
                "team {team_name:?}: no member could be spawned: {}",
                fmt_spawn_failures(&spawn.failed)
            ),
        };
    }
    let mut message = format!(
        "team {team_name:?} spawned in group {:?}: {} member(s) up, poked {} agent(s)",
        spawn.group,
        spawn.spawned.len(),
        poke_result.poked,
    );
    if !spawn.failed.is_empty() {
        message.push_str(&format!(
            "; {} failed: {}",
            spawn.failed.len(),
            fmt_spawn_failures(&spawn.failed)
        ));
    }
    if !poke_result.failed.is_empty() {
        message.push_str(&format!(
            "; {} agent(s) not poked: {}",
            poke_result.failed.len(),
            fmt_spawn_failures(&poke_result.failed)
        ));
        ControlResponse::Error { message }
    } else {
        ControlResponse::Ok { message }
    }
}

fn fmt_spawn_failures(failed: &[(String, String)]) -> String {
    failed
        .iter()
        .map(|(handle, err)| format!("{handle} ({err})"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The blocking `cs terminal survey` path: resolve the tab selector to the
/// owning SPA window(s), take a turn in the target's survey FIFO, mint a
/// survey id, push the `open_survey` overlay to each window, park a oneshot,
/// and AWAIT the SPA's reply (delivered by C's `POST /api/survey/reply` ->
/// `SurveyBus::complete_survey`). The returned message is what the CLI prints
/// to stdout: the chosen option label, or the follow-up / dismiss line.
///
/// Surveys addressed to the same target run ONE at a time: the SPA holds a
/// single overlay slot per tab (and one window-wide slot), so a concurrent
/// second `open_survey` would replace the first and strand its caller. A
/// later survey waits in a bounded per-target queue and only opens once every
/// earlier one resolves (reply, dismiss, or timeout). The caller's
/// `--timeout` bounds the TOTAL wait (queue time plus reply time), so a
/// survey can time out while still queued; it then leaves the queue without
/// ever opening an overlay. A target already at capacity is refused with an
/// explicit queue-full response.
async fn handle_survey(
    mut spec: SurveySpec,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
    timeout_secs: u64,
    events_tx: &broadcast::Sender<String>,
    survey_bus: &Arc<crate::survey::SurveyBus>,
    terminal_registry: Option<&Arc<TerminalRegistry>>,
) -> ControlResponse {
    if tab_name.is_none() && tab_group.is_none() {
        return ControlResponse::Error {
            message: "survey needs a tab name and/or group selector".into(),
        };
    }
    // Mirror the CLI-side cap so a malformed direct request is rejected too.
    if spec.options.is_empty() || spec.options.len() > 4 {
        return ControlResponse::Error {
            message: format!("survey needs 1..=4 options (got {})", spec.options.len()),
        };
    }
    let Some(registry) = terminal_registry else {
        return ControlResponse::Error {
            message: "terminal registry unavailable".into(),
        };
    };
    let windows = registry.window_ids_matching(tab_name, tab_group);
    if windows.is_empty() {
        return ControlResponse::Error {
            message: "no live terminal session matched".into(),
        };
    }
    // The `--timeout` deadline is fixed HERE, before any queueing, so it
    // bounds the total wait. A duration too large for the clock clamps to
    // ~30 years, preserving "effectively never" without panicking.
    let deadline = tokio::time::Instant::now()
        .checked_add(std::time::Duration::from_secs(timeout_secs))
        .unwrap_or_else(|| {
            tokio::time::Instant::now() + std::time::Duration::from_secs(60 * 60 * 24 * 365 * 30)
        });
    // Take a turn in the target's FIFO. The guard releases the slot (and
    // promotes the next survey) when this handler returns on ANY path, so a
    // timed-out or cancelled queued survey never blocks its successors.
    let _turn_guard =
        match survey_bus.enqueue_turn(crate::survey::survey_queue_key(&windows, tab_name)) {
            crate::survey::SurveyTurn::Ready(guard) => guard,
            crate::survey::SurveyTurn::Wait(guard, turn_rx) => {
                match tokio::time::timeout_at(deadline, turn_rx).await {
                    Ok(Ok(())) => guard,
                    // The sender dropped without firing: the bus vanished
                    // mid-wait (server teardown). Nothing was pushed, so there
                    // is no overlay to close.
                    Ok(Err(_)) => {
                        return ControlResponse::Error {
                            message: "survey cancelled while queued".into(),
                        };
                    }
                    // The caller's window elapsed while still queued: leave the
                    // queue (guard drop) having never opened an overlay.
                    Err(_elapsed) => {
                        return ControlResponse::Timeout {
                            message: format!(
                            "no reply within {timeout_secs}s (timed out while queued behind an \
                             earlier survey for this target)"
                        ),
                        };
                    }
                }
            }
            crate::survey::SurveyTurn::Full => {
                return ControlResponse::QueueFull {
                    message: format!(
                        "survey queue for this target is full ({} open or waiting); retry after \
                     the pending surveys resolve",
                        crate::survey::SURVEY_QUEUE_CAP
                    ),
                };
            }
        };
    // Park the oneshot (and stamp its id onto the spec) BEFORE pushing the
    // overlay, so a fast reply cannot arrive before the survey is
    // registered.
    let (survey_id, rx) = survey_bus.register();
    spec.survey_id = survey_id.clone();
    // Fan the overlay out to every owning window. First reply wins; later
    // ones find the id already removed and no-op. A send failure is fatal
    // (the SPA will never see the overlay), so cancel and report it.
    for window_id in &windows {
        if let Err(message) = send_window_command(
            window_id,
            WindowCommand::OpenSurvey {
                survey: spec.clone(),
                tab_name: tab_name.map(str::to_string),
            },
            events_tx,
        ) {
            survey_bus.cancel(&survey_id);
            return ControlResponse::Error { message };
        }
    }
    // Block until C's reply route fires the oneshot, the deadline passes, or
    // the sender is dropped. Mirrors the `cs pane` round-trip
    // (PANE_REPLY_TIMEOUT), but the window is the caller's `--timeout` (the
    // host needs real time to read and answer, unlike pane's instant reply).
    match tokio::time::timeout_at(deadline, rx).await {
        Ok(Ok((reply, answered_by))) => {
            // Close the STALE overlay in the other target windows, but NOT the
            // one that answered: it already dismissed its overlay via the
            // reply, so an `answered_elsewhere` close there only races that
            // local clear (a spurious saved-draft dialog + composer hide).
            send_survey_close_commands(
                &windows,
                answered_by.as_deref(),
                &survey_id,
                tab_name,
                SurveyCloseReason::AnsweredElsewhere,
                events_tx,
            );
            ControlResponse::Ok {
                message: format_survey_reply(&reply),
            }
        }
        // A receive error means the sender was dropped without a reply (server
        // shutdown); the entry is gone, but cancel defensively in case
        // register/await ever diverge.
        Ok(Err(_)) => {
            survey_bus.cancel(&survey_id);
            send_survey_close_commands(
                &windows,
                None,
                &survey_id,
                tab_name,
                SurveyCloseReason::Cancelled,
                events_tx,
            );
            ControlResponse::Error {
                message: "survey cancelled before a reply".into(),
            }
        }
        // No reply within the window: drop the parked oneshot so it does not
        // leak and answer with a distinct Timeout (the CLI maps it to exit
        // 124). A late host answer then finds the id gone and no-ops.
        Err(_elapsed) => {
            survey_bus.cancel(&survey_id);
            send_survey_close_commands(
                &windows,
                None,
                &survey_id,
                tab_name,
                SurveyCloseReason::TimedOut,
                events_tx,
            );
            ControlResponse::Timeout {
                message: format!("no reply within {timeout_secs}s"),
            }
        }
    }
}

fn send_survey_close_commands(
    windows: &[String],
    exclude: Option<&str>,
    survey_id: &str,
    tab_name: Option<&str>,
    reason: SurveyCloseReason,
    events_tx: &broadcast::Sender<String>,
) {
    for window_id in windows {
        // Skip the answering window: it closed its own overlay via the reply.
        if Some(window_id.as_str()) == exclude {
            continue;
        }
        let _ = send_window_command(
            window_id,
            WindowCommand::CloseSurvey {
                survey_id: survey_id.to_string(),
                reason,
                tab_name: tab_name.map(str::to_string),
            },
            events_tx,
        );
    }
}

/// The stdout line the CLI prints for a completed survey. Each variant prints
/// a distinct line so the asking agent can tell an answer from a deferral from
/// a dismissal: the chosen option label; the "host will follow up later"
/// signal on `[F]`; or the dismissed line (Part C).
fn format_survey_reply(reply: &SurveyReply) -> String {
    match reply {
        SurveyReply::Option { option_label, .. } => option_label.clone(),
        SurveyReply::Followup { .. } => "host will follow up later".to_string(),
        SurveyReply::Dismissed { .. } => "survey dismissed; no answer".to_string(),
    }
}

/// How long `cs pane` waits for the SPA to answer before giving up. The SPA
/// replies in milliseconds (no user interaction, unlike a survey), so this
/// only fires when the target window is not actually connected (e.g. the
/// browser tab was closed while the terminal lived on), keeping `cs pane`
/// from blocking forever in that case.
const PANE_REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Resolve the target SPA window for a `cs pane` command. Prefer the explicit
/// `window_id` ($CHAN_WINDOW_ID); otherwise resolve `tab_name` (`--tab-name`)
/// to the single live window owning that tab via `window_ids_matching`, so
/// the command works from a context with no $CHAN_WINDOW_ID (an unbound
/// agent, a native terminal). Errors when neither is given, when a tab
/// selector matches no window, or when it is ambiguous.
fn resolve_pane_window(
    window_id: Option<String>,
    tab_name: Option<&str>,
    terminal_registry: Option<&Arc<TerminalRegistry>>,
) -> Result<String, String> {
    if let Some(window_id) = window_id {
        let trimmed = window_id.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let Some(tab_name) = tab_name.map(str::trim).filter(|t| !t.is_empty()) else {
        return Err(
            "cs pane needs a target: run inside a chan terminal ($CHAN_WINDOW_ID) or pass --tab-name"
                .into(),
        );
    };
    let Some(registry) = terminal_registry else {
        return Err("terminal registry unavailable".into());
    };
    let mut windows = registry.window_ids_matching(Some(tab_name), None);
    match windows.len() {
        0 => Err(format!("no live window owns a tab named {tab_name:?}")),
        1 => Ok(windows.pop().expect("one window")),
        n => Err(format!(
            "{n} live windows own a tab named {tab_name:?}; --tab-name must resolve to one"
        )),
    }
}

/// The shared `cs pane` round-trip: mint a request id, build the
/// window_command from it (a query or an exec), push it to `window_id`, park
/// a oneshot on the window bus, and AWAIT the SPA's reply (delivered by `POST
/// /api/window/reply` -> `WindowBus::complete`). The returned message is the
/// reply payload JSON the CLI formats. Mirrors `handle_survey`'s register ->
/// push -> await shape, with a timeout since no user is in the loop.
async fn pane_round_trip<F>(
    window_id: &str,
    make_command: F,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
    session_registry: &SessionRegistry,
) -> ControlResponse
where
    F: FnOnce(String) -> WindowCommand,
{
    // Park the oneshot BEFORE pushing the command so a fast reply cannot
    // arrive before the request is registered.
    let (request_id, rx) = window_bus.register();
    if let Err(message) = send_window_command_if_live(
        session_registry,
        window_id,
        make_command(request_id.clone()),
        events_tx,
    ) {
        window_bus.cancel(&request_id);
        return ControlResponse::Error { message };
    }
    // Block until the reply route fires the oneshot, or the timeout elapses
    // (the window never answered). Cancel the parked entry on either failure
    // so it does not leak.
    match tokio::time::timeout(PANE_REPLY_TIMEOUT, rx).await {
        Ok(Ok(payload)) => match serde_json::to_string(&payload) {
            Ok(json) => ControlResponse::Ok { message: json },
            Err(e) => ControlResponse::Error {
                message: format!("encode pane reply: {e}"),
            },
        },
        Ok(Err(_)) => {
            window_bus.cancel(&request_id);
            ControlResponse::Error {
                message: "pane request cancelled before a reply".into(),
            }
        }
        Err(_elapsed) => {
            window_bus.cancel(&request_id);
            ControlResponse::Error {
                message: "no reply from the window (is it open in a browser?)".into(),
            }
        }
    }
}

/// `cs pane` (layout query): resolve the target window, then round-trip a
/// `pane_query`. The reply payload is the layout snapshot the CLI formats.
async fn handle_pane_query(
    window_id: Option<String>,
    tab_name: Option<String>,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
    terminal_registry: Option<&Arc<TerminalRegistry>>,
    session_registry: &SessionRegistry,
) -> ControlResponse {
    let target = match resolve_pane_window(window_id, tab_name.as_deref(), terminal_registry) {
        Ok(target) => target,
        Err(message) => return ControlResponse::Error { message },
    };
    if let Err(message) = require_connected_window(session_registry, &target) {
        return ControlResponse::Error { message };
    }
    pane_round_trip(
        &target,
        |request_id| WindowCommand::PaneQuery { request_id },
        events_tx,
        window_bus,
        session_registry,
    )
    .await
}

/// `cs pane <exec>` (new / focus / resize / equalize / swap / close): resolve
/// the target window, then round-trip a `pane_exec` carrying the op. The reply
/// payload is the exec result the CLI formats.
async fn handle_pane_exec(
    window_id: Option<String>,
    tab_name: Option<String>,
    op: PaneOp,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
    terminal_registry: Option<&Arc<TerminalRegistry>>,
    session_registry: &SessionRegistry,
) -> ControlResponse {
    let target = match resolve_pane_window(window_id, tab_name.as_deref(), terminal_registry) {
        Ok(target) => target,
        Err(message) => return ControlResponse::Error { message },
    };
    if let Err(message) = require_connected_window(session_registry, &target) {
        return ControlResponse::Error { message };
    }
    pane_round_trip(
        &target,
        move |request_id| WindowCommand::PaneExec { request_id, op },
        events_tx,
        window_bus,
        session_registry,
    )
    .await
}

/// How long a `cs export` round-trip waits for the renderer's reply. Far
/// past the pane query's 5s: the SPA rasterizes a document page by page
/// (mermaid + excalidraw renders included) before it can upload and reply.
const EXPORT_REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// The `cs export` no-renderer refusal. Only a live SPA window can run an
/// export job (the `format -> exporter` registry lives in the frontend).
const EXPORT_NO_RENDERER: &str = "no connected renderer: an open workspace window does the \
     rendering (the terminal running cs does not); open the workspace in a browser or \
     chan-desktop";

/// Resolve the export target: the most recently active live workspace
/// window, approximated as the LATEST-JOINED live `/ws` participant (the
/// registry tracks liveness and join order, not focus). With one window
/// open (the common case) that is simply the open window.
fn resolve_export_window(session_registry: &SessionRegistry) -> Result<String, String> {
    let snapshot = session_registry.snapshot(std::time::Instant::now());
    snapshot
        .participants
        .iter()
        // `snapshot` orders by join sequence; scan latest-joined first.
        .rev()
        .find(|p| p.status == ParticipantState::Live)
        .map(|p| p.window_id.clone())
        .ok_or_else(|| EXPORT_NO_RENDERER.to_string())
}

/// The default `cs export` output path: the source with its extension
/// swapped for the format string (`notes/doc.md` + `pdf` ->
/// `notes/doc.pdf`). Only the final component's extension changes, so the
/// workspace-relative directory part passes through untouched.
fn default_export_out(path: &str, format: &str) -> String {
    std::path::Path::new(path)
        .with_extension(format)
        .to_string_lossy()
        .into_owned()
}

/// `cs export`: validate, resolve the FINAL output path (Contract: the
/// frame never carries an unresolved default), pick the renderer window,
/// and run the round-trip.
async fn handle_export(
    path: String,
    format: String,
    out: Option<String>,
    session_registry: &Arc<SessionRegistry>,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
) -> ControlResponse {
    let path = path.trim().to_string();
    if path.is_empty() {
        return ControlResponse::Error {
            message: "export needs a source path".into(),
        };
    }
    let format = format.trim().to_string();
    if format.is_empty() {
        return ControlResponse::Error {
            message: "export needs a format".into(),
        };
    }
    let out = out
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .unwrap_or_else(|| default_export_out(&path, &format));
    let target = match resolve_export_window(session_registry) {
        Ok(target) => target,
        Err(message) => return ControlResponse::Error { message },
    };
    export_round_trip(&target, path, format, out, events_tx, window_bus).await
}

/// The `cs export` round-trip, mirroring [`pane_round_trip`]: park the
/// oneshot BEFORE pushing the `export-job` command so a fast reply cannot
/// beat the registration, then await the renderer's `{ ok, out }` /
/// `{ ok: false, error }` payload from `POST /api/window/reply`.
async fn export_round_trip(
    window_id: &str,
    path: String,
    format: String,
    out: String,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
) -> ControlResponse {
    let (request_id, rx) = window_bus.register();
    let command = WindowCommand::ExportJob {
        id: request_id.clone(),
        path,
        format,
        out,
    };
    if let Err(message) = send_window_command(window_id, command, events_tx) {
        window_bus.cancel(&request_id);
        return ControlResponse::Error { message };
    }
    match tokio::time::timeout(EXPORT_REPLY_TIMEOUT, rx).await {
        Ok(Ok(payload)) => export_reply_response(&payload),
        Ok(Err(_)) => {
            window_bus.cancel(&request_id);
            ControlResponse::Error {
                message: "export request cancelled before a reply".into(),
            }
        }
        Err(_elapsed) => {
            window_bus.cancel(&request_id);
            ControlResponse::Error {
                message: format!(
                    "no reply from the renderer within {}s",
                    EXPORT_REPLY_TIMEOUT.as_secs()
                ),
            }
        }
    }
}

/// Interpret the renderer's export reply payload: `{ ok: true, out }` is
/// the dedicated Export success carrying the final output path; `{ ok:
/// false, error }` (and anything malformed) is an error, with the
/// renderer's own message when it sent one.
fn export_reply_response(payload: &serde_json::Value) -> ControlResponse {
    if payload.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let out_path = payload
            .get("out")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        if out_path.is_empty() {
            return ControlResponse::Error {
                message: "renderer reply missing `out`".into(),
            };
        }
        return ControlResponse::Export { out_path };
    }
    let message = payload
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("export failed in the renderer")
        .to_string();
    ControlResponse::Error { message }
}

/// How long a `cs copy` / `cs paste` round-trip waits for the SPA's reply.
/// Longer than the pane query's 5s because the reply can wait on a person: a
/// plain browser may raise a clipboard permission prompt to click, and the
/// desktop's native backend may itself be waiting on the OS clipboard owner.
const CLIPBOARD_REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The shared `cs copy` / `cs paste` round-trip: mint a request id, push the
/// clipboard window_command, park a oneshot on the window bus, and AWAIT the
/// SPA's reply. Returns the opaque reply payload; the caller interprets it
/// (copy reads `{ ok }` / `{ error }`, paste reads `{ mime, data_b64 }`). The
/// `Err` arm carries a ready-made [`ControlResponse`] for the failure paths
/// (send failed, cancelled, or timed out) so the handlers just `?`-style
/// early-return it. An elapsed reply window answers the typed
/// [`ControlResponse::Timeout`] (the CLI maps it to exit 124). The message
/// names both stalls that produce it - the native clipboard backend and an
/// unanswered browser permission prompt - instead of implying the window is
/// gone or that a permission is the only possible cause.
async fn clipboard_round_trip<F>(
    window_id: &str,
    make_command: F,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
) -> Result<serde_json::Value, ControlResponse>
where
    F: FnOnce(String) -> WindowCommand,
{
    let (request_id, rx) = window_bus.register();
    if let Err(message) =
        send_window_command(window_id, make_command(request_id.clone()), events_tx)
    {
        window_bus.cancel(&request_id);
        return Err(ControlResponse::Error { message });
    }
    match tokio::time::timeout(CLIPBOARD_REPLY_TIMEOUT, rx).await {
        Ok(Ok(payload)) => Ok(payload),
        Ok(Err(_)) => {
            window_bus.cancel(&request_id);
            Err(ControlResponse::Error {
                message: "clipboard request cancelled before a reply".into(),
            })
        }
        Err(_elapsed) => {
            window_bus.cancel(&request_id);
            Err(ControlResponse::Timeout {
                message: format!(
                    "no clipboard reply from the window within {}s; the native clipboard \
                     backend or the browser's clipboard permission may be stalled - focus \
                     the Chan window and retry",
                    CLIPBOARD_REPLY_TIMEOUT.as_secs()
                ),
            })
        }
    }
}

/// Pick the clipboard MIME for `cs copy` bytes that arrived with no `--mime`,
/// reusing the file-browser content detectors. Order matters: an image is
/// checked by magic bytes first (it would fail the text check anyway), then
/// an HTML signature, then plain UTF-8 text. Returns `None` for bytes that
/// are none of these, so the handler can tell the user to pass `--mime`.
fn detect_clipboard_mime(bytes: &[u8]) -> Option<&'static str> {
    if let Some(image) = chan_workspace::fs_ops::sniff_image_mime(bytes) {
        return Some(image);
    }
    if looks_like_html(bytes) {
        return Some("text/html");
    }
    if chan_workspace::fs_ops::looks_like_text(bytes) {
        return Some("text/plain;charset=utf-8");
    }
    None
}

/// A light HTML signature sniff: after skipping a UTF-8 BOM and leading
/// whitespace, does the content open with `<!doctype html` or `<html`
/// (case-insensitive)? Deliberately conservative - a bare `<p>` fragment is
/// left as plain text; the user forces HTML with `cs copy --html` when they
/// mean a fragment.
fn looks_like_html(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let trimmed = match bytes.iter().position(|b| !b.is_ascii_whitespace()) {
        Some(i) => &bytes[i..],
        None => return false,
    };
    let head = &trimmed[..trimmed.len().min(15)];
    let lower: Vec<u8> = head.iter().map(u8::to_ascii_lowercase).collect();
    lower.starts_with(b"<!doctype html") || lower.starts_with(b"<html")
}

/// `cs copy`: push the stdin bytes onto the window's clipboard. Resolves the
/// MIME (explicit `--mime`, else a content sniff), round-trips the write, and
/// maps the SPA's ack to an Ok summary or an Error the CLI exits non-zero on.
async fn handle_clipboard_copy(
    window_id: String,
    data_b64: String,
    mime: Option<String>,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
) -> ControlResponse {
    if let Err(message) = require_window_id(&window_id) {
        return ControlResponse::Error { message };
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
        Ok(bytes) => bytes,
        Err(e) => {
            return ControlResponse::Error {
                message: format!("invalid base64 clipboard payload: {e}"),
            }
        }
    };
    if bytes.is_empty() {
        return ControlResponse::Error {
            message: "nothing on stdin to copy".into(),
        };
    }
    // Defense in depth behind the control-socket framing cap: refuse an
    // over-cap payload rather than fan it out to every `/ws` subscriber.
    if bytes.len() > MAX_CLIPBOARD_BYTES {
        return ControlResponse::Error {
            message: format!(
                "clipboard payload too large (max {} MB)",
                MAX_CLIPBOARD_BYTES / (1024 * 1024)
            ),
        };
    }
    let mime = match mime {
        Some(mime) => mime,
        None => match detect_clipboard_mime(&bytes) {
            Some(mime) => mime.to_string(),
            None => {
                return ControlResponse::Error {
                    message: "unsupported clipboard content; pass --mime to force a type".into(),
                }
            }
        },
    };
    // A forced `--mime text/*` on binary would otherwise be lossy-decoded to
    // U+FFFD on the clipboard while reporting success; refuse it instead. A
    // sniffed text mime already passed the UTF-8 check in `looks_like_text`.
    if mime.starts_with("text/") && std::str::from_utf8(&bytes).is_err() {
        return ControlResponse::Error {
            message: format!("clipboard content is not valid UTF-8 for {mime}"),
        };
    }
    let byte_len = bytes.len();
    let payload = match clipboard_round_trip(
        &window_id,
        |request_id| WindowCommand::ClipboardWrite {
            request_id,
            mime: mime.clone(),
            data_b64,
        },
        events_tx,
        window_bus,
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if payload.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        ControlResponse::Ok {
            message: format!("copied {byte_len} bytes ({mime})"),
        }
    } else {
        ControlResponse::Error {
            message: payload
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("clipboard write failed")
                .to_string(),
        }
    }
}

/// `cs paste`: read the window's clipboard to stdout. Round-trips the read and
/// returns the `{ mime, data_b64 }` reply as JSON in `Ok.message` (the CLI
/// base64-decodes it to raw bytes), or surfaces the SPA's `{ error }` as an
/// Error so the CLI exits non-zero.
async fn handle_clipboard_paste(
    window_id: String,
    prefer: PastePrefer,
    events_tx: &broadcast::Sender<String>,
    window_bus: &Arc<crate::window_bus::WindowBus>,
) -> ControlResponse {
    if let Err(message) = require_window_id(&window_id) {
        return ControlResponse::Error { message };
    }
    let payload = match clipboard_round_trip(
        &window_id,
        |request_id| WindowCommand::ClipboardRead { request_id, prefer },
        events_tx,
        window_bus,
    )
    .await
    {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    if let Some(error) = payload.get("error").and_then(serde_json::Value::as_str) {
        return ControlResponse::Error {
            message: error.to_string(),
        };
    }
    match serde_json::to_string(&payload) {
        Ok(json) => ControlResponse::Ok { message: json },
        Err(e) => ControlResponse::Error {
            message: format!("encode clipboard reply: {e}"),
        },
    }
}

fn require_window_id(window_id: &str) -> Result<(), String> {
    if window_id.trim().is_empty() {
        Err("window_id is required".into())
    } else {
        Ok(())
    }
}

pub(crate) fn require_connected_window(
    session_registry: &SessionRegistry,
    window_id: &str,
) -> Result<(), String> {
    let connected = session_registry
        .snapshot(std::time::Instant::now())
        .participants
        .into_iter()
        .any(|participant| {
            participant.window_id == window_id && participant.status == ParticipantState::Live
        });
    if connected {
        Ok(())
    } else {
        Err(format!("window {window_id:?} is not connected"))
    }
}

fn into_response(result: Result<String, String>) -> ControlResponse {
    match result {
        Ok(message) => ControlResponse::Ok { message },
        Err(message) => ControlResponse::Error { message },
    }
}

/// `cs session list`: the participant rows (`[{window_id, name, role, status}]`)
/// as JSON in `Ok.message` for the CLI to render. The leader is the row whose
/// role is `leader`; `is_self` is marked client-side from `$CHAN_WINDOW_ID`.
fn handle_session_list(session_registry: &SessionRegistry) -> ControlResponse {
    let snapshot = session_registry.snapshot(std::time::Instant::now());
    into_response(
        serde_json::to_string(&snapshot.participants)
            .map_err(|e| format!("encoding session list: {e}")),
    )
}

/// `cs session self`: bare = report the calling window's own record (the
/// whoami query, `{window_id, name, role, status, is_leader, identity?}` as
/// JSON in `Ok.message`); `--name` renames it; `--reset` clears its override
/// back to gateway identity / the generated default. Only the mutating forms
/// rebroadcast the roster.
fn handle_session_self(
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
    window_id: String,
    name: Option<String>,
    reset: bool,
) -> ControlResponse {
    let outcome = match (name, reset) {
        // Bare `cs session self`: the whoami query. Read-only, no broadcast.
        (None, false) => {
            return match session_registry.whoami(&window_id, std::time::Instant::now()) {
                Some(record) => into_response(
                    serde_json::to_string(&record)
                        .map_err(|e| format!("encoding session self: {e}")),
                ),
                None => ControlResponse::Error {
                    message: format!("not a session participant: {window_id}"),
                },
            };
        }
        (Some(name), false) => session_registry
            .rename(&window_id, &name)
            .map(|stored| format!("renamed to {stored}")),
        (None, true) => session_registry
            .reset_name(&window_id)
            .map(|effective| format!("name reset to {effective}")),
        // clap forbids the combination; refuse a hand-crafted request.
        (Some(_), true) => {
            return ControlResponse::Error {
                message: "--name conflicts with --reset".into(),
            }
        }
    };
    match outcome {
        Ok(message) => {
            crate::session_roster::broadcast_session_roster(events_tx, session_registry);
            ControlResponse::Ok { message }
        }
        Err(RenameError::Empty) => ControlResponse::Error {
            message: "name cannot be empty".into(),
        },
        Err(RenameError::NotAParticipant) => ControlResponse::Error {
            message: format!("not a session participant: {window_id}"),
        },
    }
}

/// `cs session handover`: either a follower REQUESTS leadership (blocks for the
/// leader's accept/reject), or the leader ANSWERS a pending request from its own
/// terminal (`--accept` / `--reject`, the CLI path for a non-visible leader).
/// The request path mirrors `handle_survey`: park the oneshot, push the prompt
/// to the leader, then block on the caller's `--timeout`.
async fn handle_session_handover(
    session_registry: &SessionRegistry,
    handover_bus: &HandoverBus,
    events_tx: &broadcast::Sender<String>,
    window_id: String,
    to: Option<String>,
    // `None` requests a handover; `Some(true)`/`Some(false)` is the leader
    // answering a pending request with accept / reject.
    answer: Option<bool>,
    timeout_secs: u64,
) -> ControlResponse {
    // The leader answering a pending request from its own terminal.
    if let Some(accept) = answer {
        let Some(pending) = session_registry.pending_for_leader(&window_id) else {
            return ControlResponse::Error {
                message: "no handover is waiting for your answer".into(),
            };
        };
        let reply = if accept {
            HandoverReply::Accept
        } else {
            HandoverReply::Reject { reason: None }
        };
        handover_bus.complete(&pending.request_id, reply);
        return ControlResponse::Ok {
            message: if accept {
                "handover accepted".into()
            } else {
                "handover rejected".into()
            },
        };
    }
    // A follower requesting handover: park the oneshot BEFORE prompting so a
    // fast answer cannot race ahead of the parked request.
    let (request_id, rx) = handover_bus.register();
    let leader = match session_registry.request_handover(&request_id, &window_id, to.as_deref()) {
        Ok(leader) => leader,
        Err(error) => {
            handover_bus.cancel(&request_id);
            return ControlResponse::Error {
                message: handover_error_message(error),
            };
        }
    };
    let from_name = session_registry
        .snapshot(std::time::Instant::now())
        .participants
        .into_iter()
        .find(|p| p.window_id == window_id)
        .and_then(|p| p.name);
    if let Err(message) = send_window_command(
        &leader,
        WindowCommand::HandoverPrompt {
            request_id: request_id.clone(),
            from_window_id: window_id.clone(),
            from_name,
        },
        events_tx,
    ) {
        handover_bus.cancel(&request_id);
        session_registry.cancel_handover(&request_id);
        return ControlResponse::Error { message };
    }
    let timeout_secs = if timeout_secs == 0 { 30 } else { timeout_secs };
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(reply)) => {
            let accepted = matches!(reply, HandoverReply::Accept);
            // The answer path only fired the oneshot; apply the leadership move
            // here, in the requester's handler, so it happens exactly once.
            let resolved = session_registry.resolve_handover(&request_id, accepted);
            if accepted {
                crate::session_roster::broadcast_session_roster(events_tx, session_registry);
            }
            match reply {
                HandoverReply::Accept => {
                    let leader = resolved
                        .and_then(|r| r.new_leader)
                        .unwrap_or_else(|| window_id.clone());
                    ControlResponse::Ok {
                        message: format!("handover accepted; {leader} now leads"),
                    }
                }
                HandoverReply::Reject { reason } => ControlResponse::Ok {
                    message: reason
                        .map(|r| format!("handover rejected: {r}"))
                        .unwrap_or_else(|| "handover rejected".into()),
                },
            }
        }
        // The sender was dropped without a reply (server shutdown, or the
        // requester gone): clear both sides and report it.
        Ok(Err(_)) => {
            handover_bus.cancel(&request_id);
            session_registry.cancel_handover(&request_id);
            ControlResponse::Error {
                message: "handover cancelled before a reply".into(),
            }
        }
        // No answer within the window: drop the parked request and clear the
        // pending slot; a late answer then finds nothing.
        Err(_elapsed) => {
            handover_bus.cancel(&request_id);
            session_registry.cancel_handover(&request_id);
            ControlResponse::Timeout {
                message: format!("no answer within {timeout_secs}s"),
            }
        }
    }
}

/// `cs session takeover [--force]`: become leader. Plain takeover only when the
/// leader is gone/disconnected; `--force` seizes a live leader.
fn handle_session_takeover(
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
    window_id: String,
    force: bool,
) -> ControlResponse {
    match session_registry.takeover(&window_id, force) {
        Ok(true) => {
            crate::session_roster::broadcast_session_roster(events_tx, session_registry);
            ControlResponse::Ok {
                message: "you are now the leader".into(),
            }
        }
        Ok(false) => ControlResponse::Ok {
            message: "you already lead this session".into(),
        },
        Err(error) => ControlResponse::Error {
            message: handover_error_message(error),
        },
    }
}

/// Map a [`HandoverError`] to a clear CLI message.
fn handover_error_message(error: HandoverError) -> String {
    match error {
        HandoverError::NotAParticipant => "you are not a participant in this session".into(),
        HandoverError::NoLeader => "this session has no leader to hand over from".into(),
        HandoverError::UnknownTarget => "the handover target is not a session participant".into(),
        HandoverError::AlreadyLeader => "that window already leads this session".into(),
        HandoverError::AlreadyPending => "another handover is already in flight".into(),
        HandoverError::LeaderNotLive => {
            "the leader is not connected; use `cs session takeover` instead".into()
        }
        HandoverError::LeaderLive => {
            "the leader is live; ask with `cs session handover`, or seize it with `--force`".into()
        }
    }
}

/// `cs window new`: ask the desktop to spawn a window whose kind is
/// derived from the calling tenant -- a terminal tenant spawns a terminal
/// window, a workspace tenant spawns another window of that workspace.
/// Replies with the new window id. Refuses ([`crate::NO_DESKTOP`]) when
/// no desktop is attached.
async fn handle_window_new(
    desktop: &crate::desktop_window_ops::DesktopBridge,
    workspace_cell: &Arc<RwLock<Option<WorkspaceCell>>>,
    tenant: ControlTenant,
) -> ControlResponse {
    use crate::desktop_window_ops::{DesktopWindowOp, NewWindowKind};
    let kind = match tenant {
        ControlTenant::TerminalOnly => NewWindowKind::Terminal,
        ControlTenant::Workspace => {
            let workspace = match workspace_from_cell(workspace_cell) {
                Ok(workspace) => workspace,
                Err(message) => return ControlResponse::Error { message },
            };
            NewWindowKind::Workspace {
                key: workspace.root().to_string_lossy().into_owned(),
            }
        }
    };
    // The reply is the new window id, which is exactly the message the
    // CLI prints.
    into_response(
        desktop
            .dispatch(|reply| DesktopWindowOp::New { kind, reply })
            .await,
    )
}

/// `cs window rm`: authoritatively remove the window. The host weak drops the
/// persisted registry row, reaps its terminal sessions + layout blob, and fires
/// the window watch so any live native window closes -- so an offline/dead row is
/// removable even with no desktop attached. Live shells are guarded server-side:
/// without `force`, a window with live terminals is refused, so a removal never
/// kills a running agent by surprise. A stale saved layout with no row is still
/// cleaned; an unknown id errors.
async fn handle_window_close(
    desktop: &crate::desktop_window_ops::DesktopBridge,
    unserve: &UnserveScope,
    workspace_cell: &Arc<RwLock<Option<WorkspaceCell>>>,
    tenant: ControlTenant,
    id: String,
    force: bool,
) -> ControlResponse {
    use crate::desktop_window_ops::DesktopWindowOp;

    // The host weak is the only authority that can drop a persisted window row
    // (and reap its PTYs + layout blob) -- even an offline/dead row with no live
    // native window, which is the whole point of `cs window rm`.
    let host = match unserve {
        UnserveScope::Host(weak) => weak.upgrade(),
        UnserveScope::Standalone { .. } | UnserveScope::Unsupported => None,
    };

    // --force guard: refuse a removal that would kill live shells unless forced.
    // Runs server-side (this host owns the PTYs) so it holds headless too, where
    // there is no desktop confirm dialog. Disconnect/reload never reaches here,
    // so persisted sessions are untouched.
    if !force {
        if let Some(host) = host.as_ref() {
            let live = host.live_terminal_count(&id);
            if live > 0 {
                return ControlResponse::Error {
                    message: format!(
                        "window {id} has {live} live terminal session(s); \
                         re-run with --force to remove them"
                    ),
                };
            }
        }
    }

    // Authoritative removal: drop the registry row + reap sessions + blob. The
    // window watch fires, so any live native window closes from the registry
    // change. `false` ⇒ this host owns no such row (e.g. a connected devserver
    // owns it).
    let discarded = host
        .as_ref()
        .map(|host| host.discard_window(&id).unwrap_or(false))
        .unwrap_or(false);

    // Best-effort fast close of a live native window. The server already guarded,
    // so force the desktop op (no second confirm dialog); a headless host answers
    // NO_DESKTOP and relies on the watcher reconcile above.
    let destroyed = desktop
        .dispatch(|reply| DesktopWindowOp::Close {
            id: id.clone(),
            force: true,
            reply,
        })
        .await
        .unwrap_or(false);

    // Fallback only when nothing was discarded: a stale saved layout blob with no
    // feed row (discard_window already deletes the blob of any row it owns).
    // Current workspace tenant only -- a terminal tenant has no on-disk blob and a
    // foreign workspace's blob is unreachable from here (a known limitation).
    let had_blob = if !discarded && tenant == ControlTenant::Workspace {
        match workspace_from_cell(workspace_cell) {
            Ok(workspace) => {
                let key = id.clone();
                tokio::task::spawn_blocking(move || {
                    let existed = workspace
                        .get_session(&key)
                        .map(|blob| blob.is_some())
                        .unwrap_or(false);
                    if existed {
                        let _ = workspace.delete_session(&key);
                    }
                    existed
                })
                .await
                .unwrap_or(false)
            }
            Err(_) => false,
        }
    } else {
        false
    };

    match (discarded, destroyed, had_blob) {
        (true, _, _) => ControlResponse::Ok {
            message: format!("removed window {id}"),
        },
        (false, true, _) => ControlResponse::Ok {
            message: format!("closed window {id}"),
        },
        (false, false, true) => ControlResponse::Ok {
            message: format!("deleted saved layout for {id} (no live window)"),
        },
        (false, false, false) => ControlResponse::Error {
            message: format!("no window or saved layout for {id}"),
        },
    }
}

/// The fields of a `cs tunnel` request, as they arrive on the socket.
struct TunnelRequest {
    window_id: String,
    proto: chan_revtunnel::Proto,
    bind_addr: String,
    desktop_port: u16,
    devserver_port: u16,
}

/// Re-validate a `cs tunnel` request into a spec. The CLI already parsed the
/// user's spec so a typo fails locally, and the server parses the result AGAIN
/// because it does not trust clients: these fields are JSON from whatever
/// wrote to the socket. UDP is refused here rather than downgraded, so a
/// `--udp` request never silently forwards TCP.
fn tunnel_spec_from_request(req: &TunnelRequest) -> Result<chan_revtunnel::TunnelSpec, String> {
    if req.proto == chan_revtunnel::Proto::Udp {
        return Err("udp tunnels are not implemented yet; cs tunnel forwards tcp only".into());
    }
    let bind_addr = req
        .bind_addr
        .parse::<std::net::IpAddr>()
        .map_err(|_| format!("invalid tunnel bind address {:?}", req.bind_addr))?;
    if req.devserver_port == 0 {
        return Err(
            "devserver port 0 has nothing to dial; name the port your server listens on".into(),
        );
    }
    Ok(chan_revtunnel::TunnelSpec {
        proto: req.proto,
        bind_addr,
        desktop_port: req.desktop_port,
        devserver_port: req.devserver_port,
    })
}

/// `cs tunnel`: hold a reverse tunnel open for as long as this connection
/// lives.
///
/// The tunnel's lifetime IS this command's. The registration guard is dropped
/// by every exit below (including a cancelled task), which deregisters the
/// tunnel and closes the desktop's control socket, so there is exactly one
/// teardown path. Two lines can reach the client: the `Ok` acknowledgement
/// once the desktop reports a bound listener, and a later `Error` if the
/// desktop dies while the tunnel is up.
async fn handle_tunnel<R, W>(
    mut reader: R,
    write: &mut W,
    ctx: &ControlSocketCtx,
    req: TunnelRequest,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let spec = match tunnel_spec_from_request(&req) {
        Ok(spec) => spec,
        Err(message) => return write_response(write, &ControlResponse::Error { message }).await,
    };

    // The registry lives on the host, which is also what makes a tunnel
    // possible at all: a standalone `chan open` has no window a desktop owns.
    let host = match &ctx.unserve {
        UnserveScope::Host(weak) => weak.upgrade(),
        UnserveScope::Standalone { .. } | UnserveScope::Unsupported => None,
    };
    let Some(host) = host else {
        return write_response(
            write,
            &ControlResponse::Error {
                message: "cs tunnel needs a devserver or chan-desktop host; \
                          this server serves a single workspace and hosts no tunnels"
                    .into(),
            },
        )
        .await;
    };

    // The id is the ONLY thing naming this tunnel on its two public WebSocket
    // paths, so it is minted here with the same unguessable token generator
    // the per-window tokens use.
    let tunnel_id = crate::auth::random_token();
    let mut registration = host.tunnel_registry().register(&tunnel_id, &spec);

    // The trigger. Fire-and-forget by construction: the answer comes back out
    // of band on the control WebSocket the desktop dials. A zero-subscriber
    // send means no window is connected at all, which is the error the user
    // needs to see.
    if let Err(message) = send_window_command(
        &req.window_id,
        WindowCommand::TunnelOpen {
            tunnel_id,
            proto: spec.proto,
            bind_addr: spec.bind_addr.to_string(),
            desktop_port: spec.desktop_port,
            devserver_port: spec.devserver_port,
        },
        &ctx.events_tx,
    ) {
        return write_response(write, &ControlResponse::Error { message }).await;
    }

    let bound = tokio::select! {
        report = &mut registration.ready => match report {
            Ok(chan_revtunnel::server::ReadyReport::Ready { bound }) => bound,
            Ok(chan_revtunnel::server::ReadyReport::Failed { message }) => {
                return write_response(
                    write,
                    &ControlResponse::Error {
                        message: format!("desktop refused the tunnel: {message}"),
                    },
                )
                .await;
            }
            // The registry forgot this tunnel before it was answered; nothing
            // is left to wait for.
            Err(_) => {
                return write_response(
                    write,
                    &ControlResponse::Error {
                        message: "tunnel registration ended before the desktop answered".into(),
                    },
                )
                .await;
            }
        },
        // The client left while waiting: drop the registration and go.
        _ = wait_for_client_eof(&mut reader) => return,
        _ = tokio::time::sleep(std::time::Duration::from_secs(
            chan_revtunnel::wire::READY_TIMEOUT_SECS,
        )) => {
            return write_response(
                write,
                &ControlResponse::Error {
                    message: format!(
                        "no chan-desktop answered within {}s: window {:?} must be open in \
                         chan-desktop, which is the only client that can host a tunnel \
                         (a browser tab cannot)",
                        chan_revtunnel::wire::READY_TIMEOUT_SECS,
                        req.window_id
                    ),
                },
            )
            .await;
        }
    };

    // `bound` and not the request: a desktop-port-0 request asked the OS for
    // a free port, so only the desktop knows what it actually listens on.
    write_response(
        write,
        &ControlResponse::Ok {
            message: format!(
                "tunnel open: desktop {bound} -> devserver 127.0.0.1:{} ({})",
                spec.devserver_port, spec.proto
            ),
        },
    )
    .await;

    tokio::select! {
        // The normal end: the user stopped `cs tunnel`.
        _ = wait_for_client_eof(&mut reader) => {}
        _ = &mut registration.desktop_gone => {
            write_response(
                write,
                &ControlResponse::Error {
                    message: format!(
                        "tunnel closed: {}",
                        chan_revtunnel::wire::TunnelEnd::DesktopGone.close_reason()
                    ),
                },
            )
            .await;
        }
    }
}

/// Resolve when the client's read half ends -- it exited, was killed, or its
/// process died. Bytes after the request line are not part of the contract, so
/// they are drained and ignored; only EOF or a read error ends the wait.
async fn wait_for_client_eof<R: AsyncRead + Unpin>(reader: &mut R) {
    let mut scratch = [0u8; 64];
    loop {
        match reader.read(&mut scratch).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// Run the shared bounded retrieval contract against this tenant's live
/// workspace and return the core result unchanged.
fn workspace_search_json(
    workspace: &Workspace,
    request: &chan_workspace::WorkspaceSearchRequest,
) -> Result<String, String> {
    let result = workspace
        .workspace_search(request)
        .map_err(|error| format!("workspace search: {error}"))?;
    serde_json::to_string(&result).map_err(|error| format!("serialize workspace search: {error}"))
}

fn workspace_from_cell(
    workspace_cell: &Arc<RwLock<Option<WorkspaceCell>>>,
) -> Result<Arc<Workspace>, String> {
    let cell = workspace_cell
        .read()
        .map_err(|_| "workspace cell lock poisoned".to_string())?;
    // Every caller reaches here only on a workspace tenant: the
    // workspace-only commands are refused upstream by
    // `terminal_tenant_refusal`, and the dual-tenant commands
    // (upload/download/terminal-new/window-new/close) call this only in their
    // `Workspace` arm. A workspace tenant's cell is empty only transiently
    // (the storage-reset swap window).
    let cell = cell
        .as_ref()
        .ok_or_else(|| "workspace cell unavailable".to_string())?;
    Ok(cell.workspace.clone())
}

fn send_window_command(
    window_id: &str,
    command: WindowCommand,
    events_tx: &broadcast::Sender<String>,
) -> Result<(), String> {
    let frame = WindowCommandFrame {
        frame_type: "window_command",
        window_id: window_id.to_string(),
        command,
    };
    let raw = serde_json::to_string(&frame).map_err(|e| format!("encode window command: {e}"))?;
    // Window commands fan out over the /ws event broadcast; the SPA window
    // owning `window_id` acts on its frame. `events_tx` is subscribed ONLY by
    // /ws connections, so a zero receiver count means NO window is connected:
    // the command would vanish silently. Surface that as an error rather than
    // a misleading "queued" so the caller knows nothing will happen (the most
    // common cause is running a window-scoped `cs` command outside a chan
    // terminal, where $CHAN_WINDOW_ID is unset and no window is open).
    if events_tx.send(raw).is_err() {
        return Err(
            "no chan window is connected to receive this; open the workspace in a window, \
             or run from inside a chan terminal so $CHAN_WINDOW_ID targets one"
                .into(),
        );
    }
    Ok(())
}

// Every fire-and-forget opener (`cs open`, `cs graph`, `cs dashboard`, `cs
// terminal new`, `cs terminal team new|load`) funnels its exact-window
// dispatch through here and then returns "... request queued" straight to
// the CLI without awaiting the SPA. `--pane`/`--side` placement is validated
// and, on failure, surfaced as a visible transient status in the SPA (see
// `resolveWindowCommandDestination` in store.svelte.ts), but that failure is
// NOT reflected back to the CLI's exit code: the opener has already returned
// "queued" by the time the SPA resolves placement. Making that CLI-visible
// would mean converting openers to blocking round-trips like `cs pane`
// (`pane_round_trip`, above), which also calls this same function but awaits
// a reply afterward instead of returning immediately.
fn send_window_command_if_live(
    session_registry: &SessionRegistry,
    window_id: &str,
    command: WindowCommand,
    events_tx: &broadcast::Sender<String>,
) -> Result<(), String> {
    let frame = WindowCommandFrame {
        frame_type: "window_command",
        window_id: window_id.to_string(),
        command,
    };
    let raw = serde_json::to_string(&frame).map_err(|e| format!("encode window command: {e}"))?;
    match session_registry.dispatch_if_live(window_id, || events_tx.send(raw)) {
        None => Err(format!("window {window_id:?} is not connected")),
        Some(Ok(_)) => Ok(()),
        Some(Err(_)) => Err(
            "no chan window is connected to receive this; open the workspace in a window, \
             or run from inside a chan terminal so $CHAN_WINDOW_ID targets one"
                .into(),
        ),
    }
}

/// Resolve an optional requested path to a workspace-relative path plus
/// whether it is a directory. `None` / the workspace root resolve to
/// `(None, _)`, which the SPA treats as "no specific target".
fn resolve_optional_rel(
    workspace: &Workspace,
    requested: Option<&Path>,
) -> Result<Option<(String, bool)>, String> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    let rel = abs_to_workspace_rel(workspace.root(), requested)?;
    if rel.is_empty() {
        return Ok(None);
    }
    let is_dir = workspace
        .stat(&rel)
        .map(|stat| stat.is_dir)
        .unwrap_or(false);
    Ok(Some((rel, is_dir)))
}

/// Category 1: open the documentation graph in the originating window,
/// optionally focused on a file or directory.
fn open_graph(
    workspace: &Workspace,
    window_id: &str,
    requested: Option<&Path>,
    destination: Option<TabDestination>,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let resolved = resolve_optional_rel(workspace, requested)?;
    let (path, is_dir) = match &resolved {
        Some((rel, is_dir)) => (Some(rel.clone()), *is_dir),
        None => (None, false),
    };
    send_window_command_if_live(
        session_registry,
        window_id,
        WindowCommand::OpenGraph {
            path: path.clone(),
            is_dir,
            destination,
        },
        events_tx,
    )?;
    Ok(match path {
        Some(rel) => format!("graph request queued for {rel}"),
        None => "graph request queued".into(),
    })
}

/// Category 1: open a graph tab from a serialized `chan://graph?...` link.
/// The SPA owns the graph-link parser already, so the control socket forwards
/// the exact link instead of duplicating query decoding server-side.
/// pub(crate): shared with `routes::open` like [`open_path`].
pub(crate) fn open_graph_link(
    window_id: &str,
    link: &str,
    destination: Option<TabDestination>,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    send_window_command_if_live(
        session_registry,
        window_id,
        WindowCommand::OpenGraphLink {
            link: link.to_string(),
            destination,
        },
        events_tx,
    )?;
    Ok("graph link request queued".into())
}

/// Category 1: open a new terminal tab in the originating window. A
/// requested file resolves to its parent directory as the cwd.
struct TerminalOpenSpec {
    tab_name: Option<String>,
    tab_group: Option<String>,
    destination: Option<TabDestination>,
}

fn open_term_new(
    workspace: &Workspace,
    window_id: &str,
    requested: Option<&Path>,
    spec: TerminalOpenSpec,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let TerminalOpenSpec {
        tab_name,
        tab_group,
        destination,
    } = spec;
    let cwd = match resolve_optional_rel(workspace, requested)? {
        Some((rel, true)) => Some(rel),
        Some((rel, false)) => {
            let parent = parent_rel(&rel);
            (!parent.is_empty()).then_some(parent)
        }
        None => None,
    };
    send_window_command_if_live(
        session_registry,
        window_id,
        WindowCommand::OpenTermNew {
            cwd: cwd.clone(),
            tab_name,
            tab_group,
            destination,
        },
        events_tx,
    )?;
    Ok(match cwd {
        Some(rel) => format!("terminal request queued for {rel}"),
        None => "terminal request queued".into(),
    })
}

/// Category 1, workspace-less: open a new terminal tab in a standalone
/// terminal window. There is no workspace to resolve a cwd against, so the
/// command carries no cwd -- pure window routing, the same shape as
/// `open_dashboard`. The caller has already rejected any `--path`.
fn open_term_new_standalone(
    window_id: &str,
    spec: TerminalOpenSpec,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let TerminalOpenSpec {
        tab_name,
        tab_group,
        destination,
    } = spec;
    send_window_command_if_live(
        session_registry,
        window_id,
        WindowCommand::OpenTermNew {
            cwd: None,
            tab_name,
            tab_group,
            destination,
        },
        events_tx,
    )?;
    Ok("terminal request queued".into())
}

/// Category 1: open a Dashboard tab in the originating window.
fn open_dashboard(
    window_id: &str,
    carousel_index: Option<u32>,
    carousel_off: bool,
    destination: Option<TabDestination>,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    send_window_command_if_live(
        session_registry,
        window_id,
        WindowCommand::OpenDashboard {
            carousel_index,
            carousel_off,
            destination,
        },
        events_tx,
    )?;
    Ok("dashboard request queued".into())
}

/// Category 1: raise the file-upload UI in the originating window, targeting a
/// directory. `requested` is the CLI-absolutized path; we relativize it and,
/// when it points at a FILE (or doesn't resolve to a directory), target its
/// parent so the upload always lands in a folder. An empty rel (the workspace
/// root) targets the root, mirroring the workspace-root Inspector pill. Reuses
/// the SPA's `fileOps.uploadFilesTo` (no parallel upload path).
fn upload_path(
    workspace: &Workspace,
    window_id: &str,
    requested: &Path,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let rel = abs_to_workspace_rel(workspace.root(), requested)?;
    let dir = if rel.is_empty() || workspace.stat(&rel).map(|s| s.is_dir).unwrap_or(false) {
        rel
    } else {
        parent_rel(&rel)
    };
    send_window_command(
        window_id,
        WindowCommand::Upload { path: dir.clone() },
        events_tx,
    )?;
    Ok(if dir.is_empty() {
        "upload request queued for /".into()
    } else {
        format!("upload request queued for {dir}")
    })
}

/// Category 1: raise the download-with-progress UI in the originating window
/// for `requested` (the CLI-absolutized path). We relativize it and resolve
/// `is_dir` via stat so the SPA names the download (a directory downloads as a
/// zip). The workspace root is downloadable (is_dir, like the workspace-root
/// Inspector pill). Reuses the SPA's `fileOps.downloadPathWithProgress`.
fn download_path(
    workspace: &Workspace,
    window_id: &str,
    requested: &Path,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let rel = abs_to_workspace_rel(workspace.root(), requested)?;
    let is_dir = if rel.is_empty() {
        true
    } else {
        workspace
            .stat(&rel)
            .map_err(|e| format!("stat {rel}: {e}"))?
            .is_dir
    };
    send_window_command(
        window_id,
        WindowCommand::Download {
            path: rel.clone(),
            is_dir,
        },
        events_tx,
    )?;
    Ok(if rel.is_empty() {
        "download request queued for /".into()
    } else {
        format!("download request queued for {rel}")
    })
}

/// `cs upload` from a standalone-terminal window (no workspace). The CLI
/// absolutized `requested` against the session cwd, so it is the destination
/// the user means; we resolve the target DIRECTORY (the path itself if it is a
/// directory, else its parent) and signal the window. The path is sent with its
/// leading `/` stripped so the SPA's transfer bubble builds a clean
/// `/api/files/upload` request; the terminal-tenant route re-roots it and
/// pre-flights writability. No workspace wall -- the reach is the shell's uid.
fn upload_path_standalone(
    window_id: &str,
    requested: &Path,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let dir = if std::fs::metadata(requested)
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        requested.to_path_buf()
    } else {
        requested
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| requested.to_path_buf())
    };
    send_window_command(
        window_id,
        WindowCommand::Upload {
            path: strip_leading_slash(&dir),
        },
        events_tx,
    )?;
    Ok(format!("upload request queued for {}", dir.display()))
}

/// `cs download` from a standalone-terminal window (no workspace). `requested`
/// is the CLI-absolutized source; we stat it for `is_dir` (and to fail fast on
/// a missing path) and signal the window. Same leading-slash-stripped path
/// convention as [`upload_path_standalone`]; the terminal-tenant route does the
/// full readability pre-flight before building any tarball.
fn download_path_standalone(
    window_id: &str,
    requested: &Path,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let meta = std::fs::metadata(requested)
        .map_err(|e| format!("cannot access {}: {e}", requested.display()))?;
    send_window_command(
        window_id,
        WindowCommand::Download {
            path: strip_leading_slash(requested),
            is_dir: meta.is_dir(),
        },
        events_tx,
    )?;
    Ok(format!(
        "download request queued for {}",
        requested.display()
    ))
}

/// Drop the leading `/` from an absolute path so the SPA's `/api/files/{path}`
/// URL stays clean (no `//`); the terminal-tenant route re-roots the value at
/// `/`. See `crate::routes::transfer`.
fn strip_leading_slash(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches('/').to_string()
}

#[derive(Debug)]
struct TermWriteOutcome {
    message: String,
    submit_refused: bool,
}

/// Convert a terminal write outcome into its typed control response. A shell
/// target that received no submit chord is distinct from an ordinary success
/// even though its text remains accepted into the asynchronous queue.
fn term_write_response(
    registry: &TerminalRegistry,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
    data: &str,
    submit: Option<SubmitAgent>,
) -> ControlResponse {
    match term_write_outcome(registry, tab_name, tab_group, data, submit) {
        Ok(TermWriteOutcome {
            message,
            submit_refused: true,
        }) => ControlResponse::SubmitRefused { message },
        Ok(TermWriteOutcome { message, .. }) => ControlResponse::Ok { message },
        Err(message) => ControlResponse::Error { message },
    }
}

/// Category 2: ENQUEUE logical input onto matching live sessions' write queues.
/// At least one selector is required so a missing filter cannot fan out to
/// every terminal by accident. The bytes are not written to the PTY here:
/// the per-session drainer delivers each queued write when its agent is idle
/// (the serialization the Rich Prompt / poke-chain workflow needs), so
/// compatible submitted writes can be framed together at drain time.
///
/// `submit` is the sender's request (submit, plus the agent it named); the
/// registry derives each matched session's real agent and applies THAT
/// chord. When they disagree, the reply says so next to the queue position,
/// so a sender learns the correction instead of re-circulating a wrong name.
fn term_write_outcome(
    registry: &TerminalRegistry,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
    data: &str,
    submit: Option<SubmitAgent>,
) -> Result<TermWriteOutcome, String> {
    if tab_name.is_none() && tab_group.is_none() {
        return Err("term write needs a tab name and/or group selector".into());
    }
    let outcome = registry.enqueue_write_matching(tab_name, tab_group, data, submit);
    if outcome.queued == 0 {
        return if outcome.oversized > 0 {
            Err(format!(
                "terminal write payload too large (max {MAX_TERMINAL_WRITE_BYTES} bytes); \
                 write the content to a file and send its path"
            ))
        } else if outcome.full > 0 {
            Err(format!(
                "matched session(s) at the {WRITE_QUEUE_CAP_MSG}-entry queue cap; nothing queued"
            ))
        } else {
            Err("no live terminal session matched".into())
        };
    }
    let submit_refused = outcome.diverged.iter().any(|d| d.applied.is_none());
    let mut message = match outcome.position {
        Some(position) => format!("queued at position {position}"),
        None => format!("queued to {} terminal session(s)", outcome.queued),
    };
    if outcome.full > 0 {
        message.push_str(&format!("; {} at queue cap (dropped)", outcome.full));
    }
    if let Some(requested) = submit {
        // Registry map order is arbitrary; sort so a fan-out reply reads the
        // same way every time.
        let mut diverged = outcome.diverged;
        diverged.sort_by(|a, b| a.tab.cmp(&b.tab));
        for d in diverged {
            match d.applied {
                Some(applied) => message.push_str(&format!(
                    "; {} runs {}, not {}: the {} chord was applied",
                    d.tab,
                    applied.name(),
                    requested.name(),
                    applied.name(),
                )),
                None => message.push_str(&format!(
                    "; {} is a shell session: no {} chord applied",
                    d.tab,
                    requested.name(),
                )),
            }
        }
    }
    Ok(TermWriteOutcome {
        message,
        submit_refused,
    })
}

#[cfg(all(test, unix))]
fn term_write(
    registry: &TerminalRegistry,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
    data: &str,
    submit: Option<SubmitAgent>,
) -> Result<String, String> {
    term_write_outcome(registry, tab_name, tab_group, data, submit).map(|outcome| outcome.message)
}

/// The queue cap, surfaced in the "queue full" message. Kept in sync with
/// `terminal_sessions::WRITE_QUEUE_CAP` (private there); a literal here
/// avoids widening that module's surface just for an error string.
const WRITE_QUEUE_CAP_MSG: usize = 100;

/// Category 2: restart the matching live PTY sessions, preserving each
/// session's spawn command + env (so an agent relaunches). At least one
/// selector is required, mirroring `term_write`. This is the out-of-band
/// server path the Team Work self-restart needs: the bootstrap script
/// runs `cs terminal restart` against its own tab, and the server
/// respawns that session because a shell cannot restart itself.
fn term_restart(
    registry: &TerminalRegistry,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
) -> Result<String, String> {
    if tab_name.is_none() && tab_group.is_none() {
        return Err("term restart needs a tab name and/or group selector".into());
    }
    let restarted = registry
        .restart_matching(tab_name, tab_group)
        .map_err(|e| format!("restart failed: {e}"))?;
    if restarted == 0 {
        return Err("no live terminal session matched".into());
    }
    Ok(format!("restarted {restarted} terminal session(s)"))
}

/// Category 2: close live session(s) selected by name and/or group, for
/// `cs terminal close`. The explicit teardown partner to [`term_restart`]:
/// kills the PTY and removes the registry entry so the tab name frees,
/// instead of killing the pid out of band and leaving the entry to linger.
fn term_close(
    registry: &TerminalRegistry,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
) -> Result<String, String> {
    if tab_name.is_none() && tab_group.is_none() {
        return Err("term close needs a tab name and/or group selector".into());
    }
    let closed = registry.close_matching(tab_name, tab_group);
    if closed == 0 {
        return Err("no live terminal session matched".into());
    }
    Ok(format!("closed {closed} terminal session(s)"))
}

/// Category 2: dump the full replay ring of the single live session whose
/// tab name is `tab_name`, for `cs terminal scrollback`. Requires exactly
/// one match: zero is "no session", more than one is ambiguous (scrollback
/// reads one terminal's history, so there is no group fan-out). The bytes
/// are the raw PTY stream (the same a WS attach replays), UTF-8 decoded
/// lossily for the text transport.
fn term_scrollback(registry: &TerminalRegistry, tab_name: &str) -> Result<String, String> {
    let tab_name = tab_name.trim();
    if tab_name.is_empty() {
        return Err("scrollback needs a tab name".into());
    }
    let mut matches = registry.scrollback_matching(tab_name);
    match matches.len() {
        0 => Err("no live terminal session matched".into()),
        1 => {
            let (_id, bytes) = matches.pop().expect("one match");
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
        n => Err(format!(
            "{n} live sessions match tab name {tab_name:?}; scrollback needs a single match"
        )),
    }
}

/// Category 2: list live terminal sessions as JSON, grouped by group.
fn term_list(registry: &TerminalRegistry, windows: &[WindowRecord]) -> Result<String, String> {
    use std::collections::{BTreeMap, HashMap};

    // Index the library window set so each session can name its owning window's
    // kind + liveness without a second registry walk.
    let by_id: HashMap<&str, &WindowRecord> =
        windows.iter().map(|w| (w.window_id.as_str(), w)).collect();

    let mut groups: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
    for summary in registry.session_summaries() {
        // Resolve the session's window: a live row gives kind + alive/offline; a
        // session whose window_id has no row outlived its window (orphaned); a
        // session with no window_id was created outside a browser window (none).
        let (window, window_kind, window_status) = match summary.window_id.as_deref() {
            Some(id) => match by_id.get(id) {
                Some(rec) => {
                    let kind = if rec.control {
                        "control"
                    } else {
                        match rec.kind {
                            WindowKind::Terminal => "standalone-terminal",
                            WindowKind::Workspace => "workspace",
                        }
                    };
                    let status = if rec.connected { "alive" } else { "offline" };
                    (Some(id.to_string()), kind, status)
                }
                None => (Some(id.to_string()), "orphaned", "orphaned"),
            },
            None => (None, "none", "none"),
        };
        let entry = serde_json::json!({
            "name": summary.tab_name,
            "spawn_name": summary.spawn_name,
            // The server-derived submit agent (null for a shell session), so
            // a sender can look up a target's chord instead of guessing it.
            "agent": summary.agent.map(SubmitAgent::name),
            "session_id": summary.session_id,
            "window": window,
            "window_kind": window_kind,
            "window_status": window_status,
            "pane": summary.pane_id,
            "side": summary.side,
            "tab": summary.tab_id,
            "cwd": summary.cwd.map(|p| p.to_string_lossy().into_owned()),
            "queue_depth": summary.queue_depth,
        });
        groups.entry(summary.tab_group).or_default().push(entry);
    }
    let payload = serde_json::json!({ "groups": groups });
    serde_json::to_string(&payload).map_err(|e| format!("encode terminal list: {e}"))
}

// pub(crate): `routes::open` (POST /api/open, the command-launcher Open)
// calls this directly so the HTTP path and `cs open` share ONE semantics
// (dir -> browser, text/sniffed-text -> editor, missing -> create + open,
// binary -> browser reveal) instead of a reimplementation.
pub(crate) fn open_path(
    workspace: &Workspace,
    self_writes: &crate::self_writes::SelfWrites,
    window_id: &str,
    requested: &Path,
    destination: Option<TabDestination>,
    session_registry: &SessionRegistry,
    events_tx: &broadcast::Sender<String>,
) -> Result<String, String> {
    let rel = abs_to_workspace_rel(workspace.root(), requested)?;
    if rel.is_empty() {
        send_window_command_if_live(
            session_registry,
            window_id,
            WindowCommand::OpenBrowser {
                path: String::new(),
                select: None,
                enter: true,
                destination,
            },
            events_tx,
        )?;
        return Ok("open request queued for /".into());
    }
    let stat = workspace.stat(&rel).ok();
    let command = if let Some(stat) = stat {
        if stat.is_dir {
            WindowCommand::OpenBrowser {
                path: rel.clone(),
                select: None,
                enter: true,
                destination: destination.clone(),
            }
        } else if chan_workspace::fs_ops::is_editable_text(&rel) || workspace.sniff_is_text(&rel) {
            // Content-aware text gate -- the same judgment the editor's read
            // route applies (the extension fast-path OR an 8 KiB content
            // sniff), so `cs open` and the editor never disagree about what is
            // openable text. An extensionless / odd-suffix text file opens;
            // a binary file (image, archive, ...) is revealed in the browser.
            WindowCommand::OpenFile {
                path: rel.clone(),
                destination: destination.clone(),
            }
        } else {
            WindowCommand::OpenBrowser {
                path: parent_rel(&rel),
                select: Some(rel.clone()),
                enter: false,
                destination: destination.clone(),
            }
        }
    } else {
        // Nonexistent path: create it empty and open it, for ANY name (not
        // just `.md`). `write_text`'s own editable-text gate bounds what may
        // be created -- a known-text name (.txt/.py/.log/...) succeeds, a
        // binary-class name is refused there. Note the write before it lands
        // so the watcher's Created event is in the suppression set before it
        // can fire (see files.rs::api_write_file).
        self_writes.note(&rel);
        workspace
            .write_text(&rel, "")
            .map_err(|e| format!("create {rel}: {e}"))?;
        WindowCommand::OpenFile {
            path: rel.clone(),
            destination: destination.clone(),
        }
    };

    send_window_command_if_live(session_registry, window_id, command, events_tx)?;
    Ok(format!("open request queued for {rel}"))
}

fn abs_to_workspace_rel(root: &Path, requested: &Path) -> Result<String, String> {
    if !requested.is_absolute() {
        return Err("control path must be absolute".into());
    }
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("canonicalize workspace root: {e}"))?;
    let existing_or_parent = if requested.exists() {
        requested
    } else {
        requested
            .parent()
            .ok_or_else(|| "path has no parent".to_string())?
    };
    let canon = existing_or_parent
        .canonicalize()
        .map_err(|e| format!("canonicalize path: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err("path escapes workspace root".into());
    }
    let candidate = if requested.exists() {
        canon
    } else {
        canon.join(
            requested
                .file_name()
                .ok_or_else(|| "path has no file name".to_string())?,
        )
    };
    let rel = candidate
        .strip_prefix(&root_canon)
        .map_err(|_| "path escapes workspace root".to_string())?;
    Ok(path_to_posix(rel))
}

fn path_to_posix(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn parent_rel(rel: &str) -> String {
    rel.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    use serde_json::Value;

    #[tokio::test]
    async fn unix_transport_bind_sets_socket_mode_0600() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chan-control-mode.sock");
        let _listener = transport::bind(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn looks_like_html_matches_documents_not_fragments() {
        assert!(looks_like_html(b"<!DOCTYPE html><html></html>"));
        assert!(looks_like_html(b"<html lang=\"en\">"));
        assert!(looks_like_html(b"  \n\t<HTML>"));
        // A UTF-8 BOM before the doctype is skipped.
        assert!(looks_like_html(b"\xEF\xBB\xBF<!doctype html>"));
        // A bare fragment stays plain text (the user forces it with --html).
        assert!(!looks_like_html(b"<p>hi</p>"));
        assert!(!looks_like_html(b"plain text"));
        assert!(!looks_like_html(b""));
    }

    #[test]
    fn detect_clipboard_mime_orders_image_html_text() {
        assert_eq!(
            detect_clipboard_mime(b"\x89PNG\r\n\x1a\n..."),
            Some("image/png")
        );
        assert_eq!(
            detect_clipboard_mime(b"<!doctype html><html>"),
            Some("text/html")
        );
        assert_eq!(
            detect_clipboard_mime(b"just some words"),
            Some("text/plain;charset=utf-8")
        );
        // Non-text, non-image bytes (a NUL) type as nothing: force with --mime.
        assert_eq!(detect_clipboard_mime(&[0x00, 0x01, 0x02]), None);
    }

    #[tokio::test]
    async fn clipboard_copy_rejects_oversized_payload() {
        // A payload one byte past the cap is refused before the round-trip, so
        // an over-cap `cs copy` never fans out to the `/ws` subscribers.
        let (events_tx, _rx) = broadcast::channel(1);
        let window_bus = Arc::new(crate::window_bus::WindowBus::new());
        let oversized =
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_CLIPBOARD_BYTES + 1]);
        let resp =
            handle_clipboard_copy("w".into(), oversized, None, &events_tx, &window_bus).await;
        match resp {
            ControlResponse::Error { message } => {
                assert!(
                    message.contains("too large"),
                    "unexpected message: {message}"
                )
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn clipboard_copy_rejects_non_utf8_forced_text() {
        // A forced `--mime text/plain` on binary bytes is refused rather than
        // lossy-decoded to U+FFFD on the clipboard while reporting success.
        let (events_tx, _rx) = broadcast::channel(1);
        let window_bus = Arc::new(crate::window_bus::WindowBus::new());
        let data_b64 = base64::engine::general_purpose::STANDARD.encode([0xff, 0xfe, 0xfd]);
        let resp = handle_clipboard_copy(
            "w".into(),
            data_b64,
            Some("text/plain".into()),
            &events_tx,
            &window_bus,
        )
        .await;
        match resp {
            ControlResponse::Error { message } => {
                assert!(message.contains("not valid UTF-8"), "unexpected: {message}")
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn clipboard_round_trip_elapses_to_the_typed_timeout() {
        // No SPA ever replies: the paused clock auto-advances past the 30s
        // reply window and the round-trip answers the typed Timeout (the CLI
        // maps it to exit 124), naming both stall causes - not the generic
        // Error a disconnected window would get.
        let (events_tx, _rx) = broadcast::channel(4);
        let window_bus = Arc::new(crate::window_bus::WindowBus::new());
        let resp =
            handle_clipboard_paste("w-1".into(), PastePrefer::Auto, &events_tx, &window_bus).await;
        match resp {
            ControlResponse::Timeout { message } => {
                assert!(message.contains("within 30s"), "unexpected: {message}");
                assert!(
                    message.contains("native clipboard backend"),
                    "unexpected: {message}"
                );
                assert!(
                    message.contains("clipboard permission may be stalled"),
                    "unexpected: {message}"
                );
            }
            other => panic!("expected Timeout, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn clipboard_paste_passes_the_windows_error_through() {
        // The SPA answered `{ error }` (a real denial, e.g. the user clicked
        // Cancel on the paste card): the message rides through verbatim as an
        // Error, NOT a Timeout - the CLI exits 1 with the window's own words.
        let (events_tx, mut events_rx) = broadcast::channel(4);
        let window_bus = Arc::new(crate::window_bus::WindowBus::new());
        let bus = Arc::clone(&window_bus);
        let round_trip = tokio::spawn(async move {
            handle_clipboard_paste("w-1".into(), PastePrefer::Auto, &events_tx, &bus).await
        });
        let raw = events_rx.recv().await.expect("frame on /ws broadcast");
        let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(frame["command"], "clipboard_read");
        assert_eq!(frame["window_id"], "w-1");
        let id = frame["request_id"]
            .as_str()
            .expect("request_id")
            .to_string();
        assert!(window_bus.complete(
            &id,
            serde_json::json!({ "error": "paste cancelled in the window" })
        ));
        match round_trip.await.unwrap() {
            ControlResponse::Error { message } => {
                assert_eq!(message, "paste cancelled in the window")
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn window_command_frame_serializes_with_the_prefix_the_ws_pump_scans() {
        // The `/ws` pump (`routes::ws::window_command_target`) reads the target
        // window off the fixed `{"type":"window_command","window_id":"<id>",`
        // prefix to avoid re-parsing a multi-MB clipboard payload per socket. A
        // field reorder/rename here would silently defeat that targeting, so
        // pin the serialized prefix.
        let frame = WindowCommandFrame {
            frame_type: "window_command",
            window_id: "workspace-aa-0".to_string(),
            command: WindowCommand::ClipboardWrite {
                request_id: "r1".into(),
                mime: "image/png".into(),
                data_b64: "AAAA".into(),
            },
        };
        let s = serde_json::to_string(&frame).unwrap();
        assert!(
            s.starts_with(r#"{"type":"window_command","window_id":"workspace-aa-0","#),
            "frame prefix drifted: {s}"
        );
    }

    #[test]
    fn export_job_frame_pins_the_frozen_contract() {
        // Contract B: `command: "export-job"` (hyphenated, via the explicit
        // serde rename) with payload keys `id` / `path` / `format` / `out`.
        // The SPA's window-command listener matches these exact strings.
        let frame = WindowCommandFrame {
            frame_type: "window_command",
            window_id: "w-1".to_string(),
            command: WindowCommand::ExportJob {
                id: "win-r1".into(),
                path: "notes/doc.md".into(),
                format: "pdf".into(),
                out: "notes/doc.pdf".into(),
            },
        };
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "window_command",
                "window_id": "w-1",
                "command": "export-job",
                "id": "win-r1",
                "path": "notes/doc.md",
                "format": "pdf",
                "out": "notes/doc.pdf",
            })
        );
    }

    #[test]
    fn default_export_out_swaps_the_extension_in_place() {
        assert_eq!(default_export_out("notes/doc.md", "pdf"), "notes/doc.pdf");
        assert_eq!(default_export_out("doc", "pdf"), "doc.pdf");
        // Only the last extension swaps; the directory part is untouched.
        assert_eq!(default_export_out("a/b.tar.gz", "pdf"), "a/b.tar.pdf");
    }

    #[test]
    fn resolve_export_window_picks_the_latest_live_participant() {
        let registry = SessionRegistry::new();
        assert_eq!(
            resolve_export_window(&registry).unwrap_err(),
            EXPORT_NO_RENDERER
        );

        let registry = Arc::new(SessionRegistry::new());
        let _a = registry.join("w-a", true, None).guard;
        let b = registry.join("w-b", true, None).guard;
        assert_eq!(resolve_export_window(&registry).unwrap(), "w-b");

        // w-b's socket drops: it leaves Live (grace clock) and the latest
        // remaining LIVE participant wins.
        drop(b);
        assert_eq!(resolve_export_window(&registry).unwrap(), "w-a");
    }

    #[tokio::test]
    async fn export_with_no_live_window_answers_the_no_renderer_error() {
        let (events_tx, _rx) = broadcast::channel(1);
        let window_bus = Arc::new(crate::window_bus::WindowBus::new());
        let registry = Arc::new(SessionRegistry::new());
        let resp = handle_export(
            "notes/doc.md".into(),
            "pdf".into(),
            None,
            &registry,
            &events_tx,
            &window_bus,
        )
        .await;
        match resp {
            ControlResponse::Error { message } => assert_eq!(message, EXPORT_NO_RENDERER),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn export_round_trip_completes_with_the_renderer_reply() {
        let (events_tx, mut events_rx) = broadcast::channel(4);
        let window_bus = Arc::new(crate::window_bus::WindowBus::new());
        let bus = Arc::clone(&window_bus);
        let round_trip = tokio::spawn(async move {
            export_round_trip(
                "w-1",
                "notes/doc.md".into(),
                "pdf".into(),
                "notes/doc.pdf".into(),
                &events_tx,
                &bus,
            )
            .await
        });
        // The pushed frame carries the bus id under `id` (frozen contract);
        // completing that id unblocks the round-trip with the reply payload.
        let raw = events_rx.recv().await.expect("frame on /ws broadcast");
        let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(frame["command"], "export-job");
        assert_eq!(frame["window_id"], "w-1");
        assert_eq!(frame["path"], "notes/doc.md");
        assert_eq!(frame["out"], "notes/doc.pdf");
        let id = frame["id"].as_str().expect("id key").to_string();
        assert!(window_bus.complete(
            &id,
            serde_json::json!({ "ok": true, "out": "notes/doc.pdf" })
        ));
        match round_trip.await.unwrap() {
            ControlResponse::Export { out_path } => assert_eq!(out_path, "notes/doc.pdf"),
            other => panic!("expected Export, got {other:?}"),
        }
    }

    #[test]
    fn export_reply_maps_failures_to_errors() {
        // The renderer's own message wins when it sent one.
        match export_reply_response(
            &serde_json::json!({ "ok": false, "error": "unknown format: docx" }),
        ) {
            ControlResponse::Error { message } => assert_eq!(message, "unknown format: docx"),
            other => panic!("expected Error, got {other:?}"),
        }
        // Malformed replies (no `ok`, or ok without `out`) are errors, never
        // a silent success: the CLI prints `out_path` verbatim.
        assert!(matches!(
            export_reply_response(&serde_json::json!({})),
            ControlResponse::Error { .. }
        ));
        assert!(matches!(
            export_reply_response(&serde_json::json!({ "ok": true })),
            ControlResponse::Error { .. }
        ));
    }

    /// Fresh ControlSocketCtx around the given workspace cell: empty
    /// terminal-registry cell, fresh buses, fresh presence map.
    fn test_ctx(
        workspace_cell: Arc<RwLock<Option<WorkspaceCell>>>,
        tenant: ControlTenant,
    ) -> ControlSocketCtx {
        let (events_tx, _) = broadcast::channel(1);
        ControlSocketCtx {
            workspace_cell,
            events_tx,
            self_writes: Arc::new(crate::self_writes::SelfWrites::new()),
            terminal_registry: Arc::new(std::sync::OnceLock::new()),
            survey_bus: Arc::new(crate::survey::SurveyBus::new()),
            window_bus: Arc::new(crate::window_bus::WindowBus::new()),
            session_registry: Arc::new(SessionRegistry::new()),
            handover_bus: Arc::new(HandoverBus::new()),
            // No desktop attached in unit tests: lifecycle ops refuse and
            // the title map stays empty.
            desktop: crate::desktop_window_ops::DesktopBridge::default(),
            tenant,
            // Unit tests don't exercise unserve; refuse it explicitly.
            unserve: UnserveScope::Unsupported,
        }
    }

    #[test]
    fn session_list_emits_participant_rows() {
        let registry = Arc::new(SessionRegistry::new());
        let _leader = registry.join("w-a", true, None).guard;
        let _follower = registry.join("w-b", false, None).guard;
        let ControlResponse::Ok { message } = handle_session_list(&registry) else {
            panic!("expected Ok rows");
        };
        let rows: serde_json::Value = serde_json::from_str(&message).expect("json rows");
        let rows = rows.as_array().expect("array of rows");
        assert_eq!(rows.len(), 2);
        // The {window_id, name, role, status} contract the CLI renderer reads;
        // the first-joined window leads, and every row carries a generated
        // default name (a row never renders unnamed).
        assert_eq!(rows[0]["window_id"], "w-a");
        assert_eq!(rows[0]["role"], "leader");
        assert_eq!(rows[0]["status"], "live");
        let name = rows[0]["name"].as_str().expect("a generated default name");
        assert!(!name.trim().is_empty());
        assert_eq!(rows[1]["role"], "follower");
    }

    #[test]
    fn session_self_bare_query_reports_the_calling_window() {
        let registry = Arc::new(SessionRegistry::new());
        let (events_tx, mut events_rx) = broadcast::channel(4);
        let _leader = registry.join("w-a", true, None).guard;
        let identity = crate::session_presence::ParticipantIdentity {
            display_name: Some("Ada Lovelace".to_string()),
            email: Some("ada@example.com".to_string()),
        };
        let _follower = registry.join("w-b", false, Some(identity)).guard;

        let ControlResponse::Ok { message } =
            handle_session_self(&registry, &events_tx, "w-b".into(), None, false)
        else {
            panic!("expected Ok record");
        };
        let record: serde_json::Value = serde_json::from_str(&message).expect("json record");
        // Full-object equality pins the exact wire shape the CLI renderer
        // reads (render_session_self_markdown keys off these literals): a
        // renamed or added field fails here, never silently in the client.
        assert_eq!(
            record,
            serde_json::json!({
                "window_id": "w-b",
                "name": "Ada Lovelace <ada@example.com>",
                "role": "follower",
                "status": "live",
                "is_leader": false,
                "identity": "Ada Lovelace <ada@example.com>",
            })
        );
        // The query is read-only: no roster rebroadcast (rename does one).
        assert!(events_rx.try_recv().is_err());

        let ControlResponse::Ok { message } =
            handle_session_self(&registry, &events_tx, "w-a".into(), None, false)
        else {
            panic!("expected Ok record");
        };
        let record: serde_json::Value = serde_json::from_str(&message).expect("json record");
        assert_eq!(record["is_leader"], true);
        assert!(
            record.get("identity").is_none(),
            "a loopback participant's record omits the identity key"
        );
    }

    #[test]
    fn session_self_query_for_a_non_participant_errors() {
        let registry = Arc::new(SessionRegistry::new());
        let (events_tx, _) = broadcast::channel(1);
        let ControlResponse::Error { message } =
            handle_session_self(&registry, &events_tx, "w-ghost".into(), None, false)
        else {
            panic!("expected Error");
        };
        assert!(message.contains("not a session participant"), "{message}");
    }

    #[test]
    fn session_self_name_with_reset_is_refused() {
        let registry = Arc::new(SessionRegistry::new());
        let (events_tx, _) = broadcast::channel(1);
        let _p = registry.join("w-a", true, None).guard;
        let ControlResponse::Error { message } =
            handle_session_self(&registry, &events_tx, "w-a".into(), Some("x".into()), true)
        else {
            panic!("expected Error");
        };
        assert_eq!(message, "--name conflicts with --reset");
    }

    #[tokio::test]
    async fn unserve_standalone_fires_shutdown_on_matching_root() {
        let dir = tempfile::tempdir().expect("root");
        let (tx, rx) = tokio::sync::watch::channel(false);
        let scope = UnserveScope::Standalone {
            root: dir.path().to_path_buf(),
            shutdown_tx: Arc::new(tx),
        };
        let resp = handle_unserve(&scope, dir.path(), false).await;
        assert!(matches!(resp, ControlResponse::Ok { .. }));
        assert!(*rx.borrow(), "matching root fires the shutdown signal");
    }

    #[tokio::test]
    async fn unserve_standalone_refuses_a_foreign_root() {
        let served = tempfile::tempdir().expect("served");
        let other = tempfile::tempdir().expect("other");
        let (tx, rx) = tokio::sync::watch::channel(false);
        let scope = UnserveScope::Standalone {
            root: served.path().to_path_buf(),
            shutdown_tx: Arc::new(tx),
        };
        let resp = handle_unserve(&scope, other.path(), false).await;
        assert!(matches!(resp, ControlResponse::Error { .. }));
        assert!(!*rx.borrow(), "a foreign root must NOT fire shutdown");
    }

    #[tokio::test]
    async fn unserve_unsupported_refuses() {
        let dir = tempfile::tempdir().expect("root");
        let resp = handle_unserve(&UnserveScope::Unsupported, dir.path(), false).await;
        assert!(matches!(resp, ControlResponse::Error { .. }));
    }

    #[tokio::test]
    async fn identify_classifies_standalone_desktop_and_devserver() {
        async fn kind_of(ctx: &ControlSocketCtx) -> ServeKind {
            match handle_request(ControlRequest::Identify, ctx).await {
                ControlResponse::Ok { message } => {
                    serde_json::from_str::<Identity>(&message)
                        .expect("identity json")
                        .kind
                }
                other => panic!("expected Ok identity, got {other:?}"),
            }
        }
        let cell = Arc::new(RwLock::new(None));

        // Hosted tenant, no desktop window-ops channel => devserver.
        let ctx = test_ctx(cell.clone(), ControlTenant::Workspace);
        assert_eq!(kind_of(&ctx).await, ServeKind::Devserver);

        // A standalone `serve` (its own shutdown scope) => standalone.
        let mut ctx = test_ctx(cell.clone(), ControlTenant::Workspace);
        let (tx, _rx) = tokio::sync::watch::channel(false);
        ctx.unserve = UnserveScope::Standalone {
            root: std::path::PathBuf::from("/tmp/standalone"),
            shutdown_tx: Arc::new(tx),
        };
        assert_eq!(kind_of(&ctx).await, ServeKind::Standalone);

        // A hosted tenant WITH a live desktop window-ops channel => desktop.
        let mut ctx = test_ctx(cell, ControlTenant::Workspace);
        let titles = ctx.desktop.window_titles.clone();
        let (ops_tx, _ops_rx) = tokio::sync::mpsc::channel(1);
        ctx.desktop = crate::desktop_window_ops::DesktopBridge {
            window_ops: Some(ops_tx),
            window_titles: titles,
        };
        assert_eq!(kind_of(&ctx).await, ServeKind::Desktop);
    }

    #[test]
    fn stable_socket_name_is_deterministic_and_tenant_scoped() {
        // Same identity + prefix on every boot => the exact path already baked
        // into open shells' $CHAN_CONTROL_SOCKET; a different tenant prefix
        // gets its own socket.
        assert_eq!(
            stable_socket_name("lib-00ff", "/blog"),
            stable_socket_name("lib-00ff", "/blog")
        );
        assert_ne!(
            stable_socket_name("lib-00ff", "/blog"),
            stable_socket_name("lib-00ff", "/api/terminal")
        );
        assert_ne!(
            stable_socket_name("lib-00ff", "/blog"),
            stable_socket_name("lib-11aa", "/blog")
        );
        // The identity round-trips through a user-editable config file; it
        // only ever reaches the filename as a hash, so even a hostile one
        // yields a well-formed name.
        let name = stable_socket_name("../we ird/☃id", "/p");
        assert!(name.starts_with("chan-control-s"), "{name}");
        assert!(name.ends_with(".sock"), "{name}");
        assert!(!name.contains('/') && !name.contains(' '), "{name}");
        // The `s` marker keeps an all-digits identity from minting a
        // pid-shaped name (`chan-control-<digits>-...`), which discovery
        // would then skip in its stable-candidate pass.
        let name = stable_socket_name("123456", "/p");
        assert!(name.starts_with("chan-control-s"), "{name}");
    }

    #[test]
    fn stable_socket_name_fits_macos_socket_dirs() {
        // sockaddr_un's sun_path caps the WHOLE socket path at 104 bytes on
        // macOS (SUN_LEN; 108 on Linux), and macOS temp dirs are long
        // (/var/folders/<2>/<31>/T/<tempdir> burns 55-60 bytes). The name
        // budget below keeps the stable path bindable there; overflowing it
        // makes every devserver control socket fail to bind on macOS.
        let name = stable_socket_name("lib-0011223344556677", "/some/long/workspace/prefix");
        assert!(
            name.len() <= 40,
            "stable socket name must stay within the macOS path budget ({} chars): {name}",
            name.len()
        );
    }

    /// One `Identify` round-trip over a live control socket, speaking the
    /// line-framed wire directly (chan-server links chan-shell without its
    /// client feature, so tests write the frame by hand).
    #[cfg(unix)]
    async fn identify_round_trip(socket: &std::path::Path) -> ControlResponse {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let stream = tokio::net::UnixStream::connect(socket)
            .await
            .expect("connect control socket");
        let (read, mut write) = stream.into_split();
        write
            .write_all(b"{\"type\":\"identify\"}\n")
            .await
            .expect("write identify");
        let mut line = String::new();
        BufReader::new(read)
            .read_line(&mut line)
            .await
            .expect("read identify reply");
        serde_json::from_str(&line).expect("control response json")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_bind_takes_over_a_dead_servers_node_and_serves_old_clients() {
        // A crashed server leaves its socket node behind (Drop never ran) and
        // holds no flock. The next boot must take the path over, and a client
        // holding the OLD $CHAN_CONTROL_SOCKET value must reach the NEW server.
        let dir = tempfile::tempdir().expect("socket dir");
        let path = dir.path().join(stable_socket_name("lib-test", "/blog"));
        drop(std::os::unix::net::UnixListener::bind(&path).expect("stale node"));
        assert!(path.exists(), "the stale node survives its listener");

        let cell = Arc::new(RwLock::new(None));
        let handle = start_stable(
            path.clone(),
            test_ctx(cell.clone(), ControlTenant::Workspace),
        )
        .expect("take over the dead server's stable path");
        assert!(matches!(
            identify_round_trip(&path).await,
            ControlResponse::Ok { .. }
        ));

        // A clean shutdown then releases the path for the next incarnation.
        drop(handle);
        let _next = start_stable(path.clone(), test_ctx(cell, ControlTenant::Workspace))
            .expect("rebind on the same stable path");
        assert!(matches!(
            identify_round_trip(&path).await,
            ControlResponse::Ok { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_bind_refuses_to_clobber_a_live_server() {
        let dir = tempfile::tempdir().expect("socket dir");
        let path = dir.path().join(stable_socket_name("lib-test", "/blog"));
        let cell = Arc::new(RwLock::new(None));
        let _live = start_stable(
            path.clone(),
            test_ctx(cell.clone(), ControlTenant::Workspace),
        )
        .expect("first bind");

        let err = start_stable(path.clone(), test_ctx(cell, ControlTenant::Workspace))
            .expect_err("a live stable socket must not be clobbered");
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);

        // The live server keeps serving on its socket.
        assert!(matches!(
            identify_round_trip(&path).await,
            ControlResponse::Ok { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_bind_absorbs_a_transient_lock_holder() {
        // A dead server's flock can linger in a forked child until it execs
        // (the inherited fd shares the open file description). A holder that
        // vanishes within the takeover's retry budget must not fail the bind.
        let dir = tempfile::tempdir().expect("socket dir");
        let path = dir.path().join(stable_socket_name("lib-test", "/blog"));
        let mut lock_path = path.as_os_str().to_owned();
        lock_path.push(".lock");
        let holder = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(PathBuf::from(lock_path))
            .expect("open the lock sibling");
        holder
            .try_lock()
            .expect("holder flocks before the takeover");
        let released = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(25));
            drop(holder);
        });

        let cell = Arc::new(RwLock::new(None));
        let _handle = start_stable(path.clone(), test_ctx(cell, ControlTenant::Workspace))
            .expect("takeover absorbs a holder that vanishes within the retry budget");
        released.join().expect("holder thread");
        assert!(matches!(
            identify_round_trip(&path).await,
            ControlResponse::Ok { .. }
        ));
    }

    #[test]
    fn parent_rel_returns_empty_for_root_file() {
        assert_eq!(parent_rel("a.png"), "");
        assert_eq!(parent_rel("notes/a.png"), "notes");
    }

    #[test]
    fn abs_to_workspace_rel_bounds_paths_to_the_workspace_root() {
        // A workspace transfer must stay within the workspace root: in-root
        // paths relativize, an escape is rejected, and the root itself (where
        // `.` resolves) is the empty rel.
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("notes")).unwrap();
        std::fs::write(root.path().join("notes/a.md"), b"x").unwrap();

        assert_eq!(
            abs_to_workspace_rel(root.path(), &root.path().join("notes/a.md")).unwrap(),
            "notes/a.md"
        );
        assert_eq!(abs_to_workspace_rel(root.path(), root.path()).unwrap(), "");

        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"x").unwrap();
        let err = abs_to_workspace_rel(root.path(), &outside.path().join("secret")).unwrap_err();
        assert!(err.contains("escapes workspace root"), "{err}");

        // A relative path is refused -- the CLI always absolutizes first.
        assert!(abs_to_workspace_rel(root.path(), std::path::Path::new("notes/a.md")).is_err());
    }

    #[tokio::test]
    async fn handle_request_reports_poisoned_workspace_cell() {
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let poisoned = workspace_cell.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.write().expect("poison setup");
            panic!("poison workspace cell");
        })
        .join();
        let ctx = test_ctx(workspace_cell.clone(), ControlTenant::Workspace);

        let response = handle_request(
            ControlRequest::OpenPath {
                window_id: "window-a".to_string(),
                path: PathBuf::from("/tmp/note.md"),
                destination: None,
            },
            &ctx,
        )
        .await;

        match response {
            ControlResponse::Error { message } => {
                assert_eq!(message, "workspace cell lock poisoned");
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn workspace_commands_refuse_clearly_on_a_terminal_tenant() {
        // A standalone terminal tenant has no workspace BY DESIGN; the
        // refusal must say that (pinned wording) instead of the
        // transient-sounding "workspace cell unavailable".
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);

        let response = handle_request(
            ControlRequest::WorkspaceSearch {
                request: chan_workspace::WorkspaceSearchRequest {
                    query: Some("anything".into()),
                    domains: vec![chan_workspace::WorkspaceSearchDomain::Content],
                    ..chan_workspace::WorkspaceSearchRequest::default()
                },
            },
            &ctx,
        )
        .await;

        match response {
            ControlResponse::Error { message } => {
                assert!(
                    message.contains("cs search is only available in a workspace window"),
                    "{message}"
                );
                assert!(
                    message.contains("this is a standalone terminal"),
                    "{message}"
                );
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn cs_open_on_a_terminal_tenant_guides_to_chan_open() {
        // `cs open PATH` from a standalone terminal has no workspace to open
        // into; instead of the generic refusal, handle_request surfaces the
        // friendly `chan open PATH` guidance (the gate runs before any
        // workspace resolution).
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);

        let response = handle_request(
            ControlRequest::OpenPath {
                window_id: "terminal-win-0".into(),
                path: PathBuf::from("/home/u/notes"),
                destination: None,
            },
            &ctx,
        )
        .await;

        match response {
            ControlResponse::Error { message } => {
                assert!(message.contains("chan open /home/u/notes"), "{message}");
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn upload_download_on_a_terminal_tenant_signal_the_window_cwd_scoped() {
        // `cs upload` / `cs download` from a standalone terminal now WORK
        // (cwd / shell-uid scoped) instead of refusing. The CLI absolutized the
        // path; the control socket signals the window with it, leading `/`
        // stripped, rather than refusing as a workspace-only command. A live
        // /ws subscriber stands in for the connected window.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"x").unwrap();

        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);
        let _window = ctx
            .session_registry
            .join("terminal-win-0", true, None)
            .guard;
        let mut rx = ctx.events_tx.subscribe();

        // Download a file: window is signalled with is_dir=false and the path
        // stripped of its leading slash.
        let response = handle_request(
            ControlRequest::Download {
                window_id: "terminal-win-0".into(),
                path: file.clone(),
            },
            &ctx,
        )
        .await;
        match response {
            ControlResponse::Ok { message } => {
                assert!(message.contains("download request queued"), "{message}")
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
        let frame = rx.try_recv().expect("download window command broadcast");
        let stripped_file = file.to_string_lossy().trim_start_matches('/').to_string();
        assert!(frame.contains("download"), "frame: {frame}");
        assert!(
            frame.contains(&stripped_file),
            "frame missing stripped path: {frame}"
        );

        // Upload targets the directory itself.
        let response = handle_request(
            ControlRequest::Upload {
                window_id: "terminal-win-0".into(),
                path: dir.path().to_path_buf(),
            },
            &ctx,
        )
        .await;
        match response {
            ControlResponse::Ok { message } => {
                assert!(message.contains("upload request queued"), "{message}")
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
        let frame = rx.try_recv().expect("upload window command broadcast");
        let stripped_dir = dir
            .path()
            .to_string_lossy()
            .trim_start_matches('/')
            .to_string();
        assert!(frame.contains("upload"), "frame: {frame}");
        assert!(frame.contains(&stripped_dir), "frame: {frame}");
    }

    #[tokio::test]
    async fn window_list_without_a_host_is_empty() {
        // The library owns the window set; `cs window list` reads it through
        // the host handle (`assemble_window_records`). A control socket with
        // no host (a standalone serve, or any host-less tenant) has no library
        // window set, so the honest answer is an empty array -- not a refusal.
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);

        let response = handle_request(ControlRequest::WindowList, &ctx).await;

        match response {
            ControlResponse::Ok { message } => {
                let rows: Value = serde_json::from_str(&message).expect("rows JSON");
                assert_eq!(rows, serde_json::json!([]));
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn open_term_new_on_a_terminal_tenant_opens_without_workspace() {
        // `cs terminal new` (no path) must WORK on a standalone terminal
        // window: it's window routing, not a workspace op. A live /ws
        // subscriber stands in for the connected SPA window so
        // send_window_command succeeds.
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);
        let _window = ctx
            .session_registry
            .join("terminal-win-0", true, None)
            .guard;
        let mut rx = ctx.events_tx.subscribe();

        let response = handle_request(
            ControlRequest::OpenTermNew {
                window_id: "terminal-win-0".into(),
                path: None,
                tab_name: None,
                tab_group: None,
                destination: Some(TabDestination {
                    pane_id: Some("pane-2".into()),
                    side: Some(chan_shell::PaneSide::B),
                }),
            },
            &ctx,
        )
        .await;

        match response {
            ControlResponse::Ok { message } => assert_eq!(message, "terminal request queued"),
            other => panic!("unexpected non-ok response: {other:?}"),
        }
        // The window command was broadcast to the (stand-in) connected window.
        let frame = rx.try_recv().expect("window command broadcast");
        assert!(frame.contains("open_term_new"), "frame: {frame}");
        assert!(frame.contains("terminal-win-0"), "frame: {frame}");
        let frame: Value = serde_json::from_str(&frame).expect("window command json");
        assert_eq!(frame["destination"]["pane_id"], "pane-2");
        assert_eq!(frame["destination"]["side"], "b");
    }

    #[tokio::test]
    async fn open_term_new_with_path_on_a_terminal_tenant_rejects() {
        // `cs terminal new --path X` can't resolve against a workspace root
        // that doesn't exist here; reject with the pinned message rather than
        // silently dropping the requested cwd.
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);

        let response = handle_request(
            ControlRequest::OpenTermNew {
                window_id: "terminal-win-0".into(),
                path: Some(std::path::PathBuf::from("notes")),
                tab_name: None,
                tab_group: None,
                destination: None,
            },
            &ctx,
        )
        .await;

        match response {
            ControlResponse::Error { message } => {
                assert!(
                    message
                        .contains("cs terminal new --path is only available in a workspace window"),
                    "{message}"
                );
                assert!(
                    message.contains("this is a standalone terminal"),
                    "{message}"
                );
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn queued_opener_requires_the_exact_target_window() {
        let workspace_cell: Arc<RwLock<Option<WorkspaceCell>>> = Arc::new(RwLock::new(None));
        let ctx = test_ctx(workspace_cell, ControlTenant::TerminalOnly);
        let _other = ctx.session_registry.join("window-other", true, None).guard;
        let mut rx = ctx.events_tx.subscribe();

        let response = handle_request(
            ControlRequest::OpenDashboard {
                window_id: "window-offline".into(),
                carousel_index: None,
                carousel_off: false,
                destination: Some(TabDestination {
                    pane_id: Some("pane-2".into()),
                    side: Some(chan_shell::PaneSide::B),
                }),
            },
            &ctx,
        )
        .await;

        match response {
            ControlResponse::Error { message } => {
                assert!(message.contains("window-offline"), "{message}");
                assert!(message.contains("not connected"), "{message}");
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "another connected window must not make the target deliverable"
        );
    }

    #[test]
    fn open_path_creates_markdown_and_broadcasts_window_command() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::create_dir_all(root.path().join("notes")).expect("notes dir");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let self_writes = crate::self_writes::SelfWrites::new();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_path(
            &workspace,
            &self_writes,
            "window-a",
            &root.path().join("notes/new.md"),
            Some(TabDestination {
                pane_id: Some("pane-2".into()),
                side: Some(chan_shell::PaneSide::B),
            }),
            &session_registry,
            &tx,
        )
        .expect("open path");

        assert!(message.contains("notes/new.md"));
        assert!(workspace.exists("notes/new.md"));
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["type"], "window_command");
        assert_eq!(frame["window_id"], "window-a");
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "notes/new.md");
        assert_eq!(frame["destination"]["pane_id"], "pane-2");
        assert_eq!(frame["destination"]["side"], "b");
    }

    #[test]
    fn open_path_enters_existing_directory() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::create_dir_all(root.path().join("notes/sub")).expect("sub dir");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let self_writes = crate::self_writes::SelfWrites::new();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_path(
            &workspace,
            &self_writes,
            "window-a",
            &root.path().join("notes/sub"),
            None,
            &session_registry,
            &tx,
        )
        .expect("open path");

        assert!(message.contains("notes/sub"));
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["type"], "window_command");
        assert_eq!(frame["window_id"], "window-a");
        assert_eq!(frame["command"], "open_browser");
        assert_eq!(frame["path"], "notes/sub");
        assert_eq!(frame["select"], Value::Null);
        assert_eq!(frame["enter"], true);
    }

    /// An existing plaintext file with a non-`.md` extension opens in the
    /// editor (the content-aware gate replaced the old `.md`-only rule).
    #[test]
    fn open_path_opens_existing_text_file() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::write(root.path().join("notes.txt"), b"plain text\n").expect("seed txt");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let self_writes = crate::self_writes::SelfWrites::new();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_path(
            &workspace,
            &self_writes,
            "window-a",
            &root.path().join("notes.txt"),
            None,
            &session_registry,
            &tx,
        )
        .expect("open path");

        assert!(message.contains("notes.txt"));
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "notes.txt");
    }

    /// An extensionless file whose CONTENT sniffs as text opens too: the gate
    /// peeks the bytes, it is not extension-only. Proves the content peek.
    #[test]
    fn open_path_opens_extensionless_text_by_content_sniff() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::write(root.path().join("LICENSE"), b"All rights reserved.\n").expect("seed file");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let self_writes = crate::self_writes::SelfWrites::new();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_path(
            &workspace,
            &self_writes,
            "window-a",
            &root.path().join("LICENSE"),
            None,
            &session_registry,
            &tx,
        )
        .expect("open path");

        assert!(message.contains("LICENSE"));
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "LICENSE");
    }

    /// An existing binary file is revealed in its parent directory.
    #[test]
    fn open_path_reveals_binary_file() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::create_dir_all(root.path().join("media")).expect("media dir");
        std::fs::write(root.path().join("media/data.bin"), [0u8, 1, 2, 3]).expect("seed binary");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let self_writes = crate::self_writes::SelfWrites::new();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_path(
            &workspace,
            &self_writes,
            "window-a",
            &root.path().join("media/data.bin"),
            Some(TabDestination {
                pane_id: Some("pane-2".into()),
                side: Some(chan_shell::PaneSide::B),
            }),
            &session_registry,
            &tx,
        )
        .expect("open path");

        assert!(message.contains("media/data.bin"));
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_browser");
        assert_eq!(frame["path"], "media");
        assert_eq!(frame["select"], "media/data.bin");
        assert!(frame.get("enter").is_none());
        assert_eq!(frame["destination"]["pane_id"], "pane-2");
        assert_eq!(frame["destination"]["side"], "b");
    }

    /// A nonexistent path (any plaintext name, not just `.md`) is created empty
    /// and opened in the editor.
    #[test]
    fn open_path_creates_nonexistent_plaintext() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        std::fs::create_dir_all(root.path().join("notes")).expect("notes dir");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let self_writes = crate::self_writes::SelfWrites::new();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_path(
            &workspace,
            &self_writes,
            "window-a",
            &root.path().join("notes/foo.log"),
            None,
            &session_registry,
            &tx,
        )
        .expect("open path");

        assert!(message.contains("notes/foo.log"));
        assert!(workspace.exists("notes/foo.log"));
        assert_eq!(workspace.read_text("notes/foo.log").expect("read"), "");
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_file");
        assert_eq!(frame["path"], "notes/foo.log");
    }

    fn test_workspace() -> (tempfile::TempDir, tempfile::TempDir, Arc<Workspace>) {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        (cfg, root, workspace)
    }

    fn live_window(
        window_id: &str,
    ) -> (Arc<SessionRegistry>, crate::session_presence::SessionGuard) {
        let registry = Arc::new(SessionRegistry::new());
        let guard = registry.join(window_id, true, None).guard;
        (registry, guard)
    }

    fn empty_registry() -> (tempfile::TempDir, TerminalRegistry) {
        use crate::config::TerminalConfig;
        use crate::terminal_sessions::RegistryConfig;
        let root = tempfile::tempdir().expect("workspace root");
        let registry = TerminalRegistry::new(RegistryConfig {
            workspace_root: root.path().to_path_buf(),
            mcp_socket_path: None,
            control_socket_path: None,
            terminal: TerminalConfig::default(),
        });
        (root, registry)
    }

    #[test]
    fn open_graph_broadcasts_window_command_for_a_directory() {
        let (_cfg, root, workspace) = test_workspace();
        std::fs::create_dir_all(root.path().join("notes/sub")).expect("sub dir");
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        let message = open_graph(
            &workspace,
            "window-a",
            Some(&root.path().join("notes/sub")),
            None,
            &session_registry,
            &tx,
        )
        .expect("open graph");

        assert!(message.contains("notes/sub"));
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_graph");
        assert_eq!(frame["path"], "notes/sub");
        assert_eq!(frame["is_dir"], true);
    }

    #[test]
    fn open_graph_without_a_path_targets_the_whole_graph() {
        let (_cfg, _root, workspace) = test_workspace();
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        open_graph(&workspace, "window-a", None, None, &session_registry, &tx).expect("open graph");

        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_graph");
        assert_eq!(frame["path"], Value::Null);
        assert_eq!(frame["is_dir"], false);
    }

    #[test]
    fn open_graph_link_broadcasts_window_command() {
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");
        let link = "chan://graph?s=dir%3Acrates%2Fchan-tunnel-proto%2Fsrc&m=s&f=2ltmaifds&n=crates%2Fchan-tunnel-proto%2Fsrc%2Fh2_duplex.rs";

        let message = open_graph_link("window-a", link, None, &session_registry, &tx)
            .expect("open graph link");

        assert_eq!(message, "graph link request queued");
        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_graph_link");
        assert_eq!(frame["link"], link);
    }

    #[test]
    fn open_term_new_uses_the_parent_directory_for_a_file() {
        let (_cfg, root, workspace) = test_workspace();
        std::fs::create_dir_all(root.path().join("notes")).expect("notes dir");
        std::fs::write(root.path().join("notes/today.md"), "x").expect("write file");
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        open_term_new(
            &workspace,
            "window-a",
            Some(&root.path().join("notes/today.md")),
            TerminalOpenSpec {
                tab_name: Some("build".into()),
                tab_group: Some("foobar".into()),
                destination: None,
            },
            &session_registry,
            &tx,
        )
        .expect("open term new");

        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_term_new");
        assert_eq!(frame["cwd"], "notes");
        assert_eq!(frame["tab_name"], "build");
        assert_eq!(frame["tab_group"], "foobar");
    }

    #[test]
    fn open_dashboard_carries_the_carousel_index() {
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        open_dashboard("window-a", Some(2), false, None, &session_registry, &tx)
            .expect("open dashboard");

        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_dashboard");
        assert_eq!(frame["carousel_index"], 2);
        // carousel_off omitted from the wire when false (is_false skip).
        assert_eq!(frame["carousel_off"], Value::Null);
    }

    #[test]
    fn open_dashboard_carries_carousel_off_when_set() {
        let (tx, mut rx) = broadcast::channel(4);
        let (session_registry, _guard) = live_window("window-a");

        open_dashboard("window-a", None, true, None, &session_registry, &tx)
            .expect("open dashboard");

        let frame: Value = serde_json::from_str(&rx.try_recv().expect("window command"))
            .expect("window command json");
        assert_eq!(frame["command"], "open_dashboard");
        assert_eq!(frame["carousel_off"], true);
    }

    #[test]
    fn term_write_requires_a_selector() {
        let (_root, registry) = empty_registry();
        let err = term_write(&registry, None, None, "ls", None).expect_err("no selector");
        assert!(err.contains("selector"), "got: {err}");
    }

    #[test]
    fn term_write_reports_no_match_on_an_empty_registry() {
        let (_root, registry) = empty_registry();
        let err = term_write(&registry, Some("nope"), None, "ls", None).expect_err("no match");
        assert!(err.contains("no live terminal session"), "got: {err}");
    }

    /// A registry holding one live PTY session per requested tab name, all in
    /// `group`. The handles are returned so the sessions stay attached for the
    /// life of the test.
    fn registry_with_sessions(
        names: &[&str],
        group: &str,
    ) -> (
        tempfile::TempDir,
        TerminalRegistry,
        Vec<crate::terminal_sessions::AttachHandle>,
    ) {
        use crate::terminal_sessions::CreateOptions;
        let (root, registry) = empty_registry();
        let handles = names
            .iter()
            .map(|name| {
                registry
                    .create(CreateOptions {
                        size: portable_pty::PtySize {
                            rows: 24,
                            cols: 80,
                            pixel_width: 0,
                            pixel_height: 0,
                        },
                        tab_name: Some((*name).to_string()),
                        tab_group: Some(group.to_string()),
                        window_id: Some("window-test".into()),
                        mcp_env: false,
                        cwd: None,
                        command: None,
                        env: Default::default(),
                    })
                    .expect("spawn pty")
            })
            .collect();
        (root, registry, handles)
    }

    #[test]
    fn term_write_reports_the_position_for_a_single_target() {
        let (_root, registry, _handles) = registry_with_sessions(&["Solo"], "probe");
        assert_eq!(
            term_write(&registry, Some("Solo"), None, "first", None),
            Ok("queued at position 1".to_string())
        );
        assert_eq!(
            term_write(&registry, Some("Solo"), None, "second", None),
            Ok("queued at position 2".to_string()),
            "the position counts pending messages"
        );
    }

    #[test]
    fn term_write_refuses_an_oversized_direct_control_body() {
        let (_root, registry, _handles) = registry_with_sessions(&["Solo"], "probe");
        let error = term_write(
            &registry,
            Some("Solo"),
            None,
            &"x".repeat(MAX_TERMINAL_WRITE_BYTES + 1),
            None,
        )
        .expect_err("oversized body");
        assert!(error.contains("max 4096 bytes"), "{error}");
        assert!(error.contains("file"), "{error}");

        assert_eq!(
            term_write(
                &registry,
                Some("Solo"),
                None,
                &"x".repeat(MAX_TERMINAL_WRITE_BYTES),
                None,
            ),
            Ok("queued at position 1".to_string())
        );
    }

    #[test]
    fn term_write_fans_out_to_a_group_without_a_position() {
        let (_root, registry, _handles) = registry_with_sessions(&["A", "B"], "fanout");
        assert_eq!(
            term_write(&registry, None, Some("fanout"), "poke", None),
            Ok("queued to 2 terminal session(s)".to_string()),
            "a multi-target write has no single position to report"
        );
        // The name axis still narrows the group to one target.
        assert_eq!(
            term_write(&registry, Some("A"), Some("fanout"), "poke", None),
            Ok("queued at position 2".to_string())
        );
    }

    #[test]
    fn term_write_reports_the_queue_cap_and_drops_nothing_silently() {
        let (_root, registry, _handles) = registry_with_sessions(&["Full"], "cap");
        for position in 1..=WRITE_QUEUE_CAP_MSG {
            assert_eq!(
                term_write(&registry, Some("Full"), None, "poke", None),
                Ok(format!("queued at position {position}"))
            );
        }
        let err = term_write(&registry, Some("Full"), None, "poke", None).expect_err("at cap");
        assert!(err.contains("queue cap"), "got: {err}");
        assert!(err.contains("nothing queued"), "got: {err}");
    }

    #[test]
    fn term_scrollback_requires_a_tab_name() {
        let (_root, registry) = empty_registry();
        let err = term_scrollback(&registry, "   ").expect_err("blank name");
        assert!(err.contains("needs a tab name"), "got: {err}");
    }

    #[test]
    fn term_scrollback_reports_no_match_on_an_empty_registry() {
        let (_root, registry) = empty_registry();
        let err = term_scrollback(&registry, "@@Nope").expect_err("no match");
        assert!(err.contains("no live terminal session"), "got: {err}");
    }

    #[test]
    fn resolve_pane_window_prefers_window_id_then_resolves_tab_name() {
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        // An explicit window_id wins outright (no registry lookup).
        assert_eq!(
            resolve_pane_window(Some("win-x".into()), None, Some(&registry)).unwrap(),
            "win-x"
        );
        // Neither a window_id nor a tab_name -> a clear "need a target" error.
        assert!(resolve_pane_window(None, None, Some(&registry)).is_err());
        // A tab selector that matches no live window -> error.
        assert!(resolve_pane_window(None, Some("@@Nope"), Some(&registry)).is_err());
        // A session bound to a window, owning a tab: --tab-name resolves it.
        let _h = registry
            .create(CreateOptions {
                size: PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("@@Alice".into()),
                tab_group: None,
                window_id: Some("win-b".into()),
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .expect("spawn session");
        assert_eq!(
            resolve_pane_window(None, Some("@@Alice"), Some(&registry)).unwrap(),
            "win-b"
        );
    }

    #[test]
    fn term_list_has_no_groups_without_sessions() {
        let (_root, registry) = empty_registry();
        let json = term_list(&registry, &[]).expect("term list");
        let value: Value = serde_json::from_str(&json).expect("json");
        assert_eq!(value["groups"], serde_json::json!({}));
    }

    #[test]
    fn term_list_reports_live_pane_side_placement() {
        let (_root, registry) = empty_registry();
        let handle = registry
            .create(CreateOptions {
                size: PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("placed".into()),
                tab_group: None,
                window_id: Some("win-2".into()),
                mcp_env: false,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .expect("spawn session");
        registry
            .update_live_metadata(handle.id(), "renamed".into(), Some("default".into()))
            .expect("rename live metadata");
        assert!(registry.update_session_layout(
            handle.id(),
            Some("pane-4".into()),
            Some(chan_shell::PaneSide::B),
            Some("tab-7".into()),
        ));

        let json = term_list(&registry, &[]).expect("term list");
        let value: Value = serde_json::from_str(&json).expect("json");
        let row = &value["groups"]["default"][0];
        assert_eq!(row["name"], "renamed");
        assert_eq!(row["spawn_name"], "placed");
        assert_eq!(row["pane"], "pane-4");
        assert_eq!(row["side"], "b");
        assert_eq!(row["tab"], "tab-7");
    }

    fn window_record(
        window_id: &str,
        kind: WindowKind,
        connected: bool,
        control: bool,
    ) -> WindowRecord {
        WindowRecord {
            window_id: window_id.into(),
            library_id: "local".into(),
            kind,
            title: String::new(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: String::new(),
            token: String::new(),
            persisted: true,
            connected,
            active_transfer: false,
            control,
            hidden: false,
            origin: crate::WindowOrigin::Native,
        }
    }

    #[test]
    fn term_list_reports_the_pending_queue_depth() {
        // The only way to watch a drain from outside a browser: the SPA badge
        // reads the same logical message count off the WS `queue` frame.
        let (_root, registry, _handles) = registry_with_sessions(&["Watched"], "depth");
        let depth_of = |raw: &str| -> u64 {
            let value: Value = serde_json::from_str(raw).expect("json");
            value["groups"]["depth"][0]["queue_depth"]
                .as_u64()
                .expect("queue_depth")
        };
        assert_eq!(depth_of(&term_list(&registry, &[]).expect("term list")), 0);
        term_write(&registry, Some("Watched"), None, "poke", None).expect("queued");
        term_write(&registry, Some("Watched"), None, "poke", None).expect("queued");
        assert_eq!(depth_of(&term_list(&registry, &[]).expect("term list")), 2);
    }

    #[test]
    fn term_list_exposes_the_derived_agent_per_session() {
        // The discovery half of the submit-chord authority: a sender reads
        // the target's agent off the list instead of guessing it. CHAN_AGENT
        // in the spawn env names the agent without spawning a real agent CLI.
        let (_root, registry) = empty_registry();
        use crate::terminal_sessions::CreateOptions;
        for (name, agent_env) in [("poked", Some("codex")), ("plain", None)] {
            registry
                .create(CreateOptions {
                    size: portable_pty::PtySize {
                        rows: 24,
                        cols: 80,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some((*name).to_string()),
                    tab_group: None,
                    window_id: None,
                    mcp_env: false,
                    cwd: None,
                    command: None,
                    env: agent_env
                        .map(|a| [("CHAN_AGENT".to_string(), a.to_string())].into())
                        .unwrap_or_default(),
                })
                .expect("spawn session");
        }
        let json = term_list(&registry, &[]).expect("term list");
        let value: Value = serde_json::from_str(&json).expect("json");
        let entries = value["groups"]["default"]
            .as_array()
            .expect("default group");
        let agent_of = |n: &str| {
            entries
                .iter()
                .find(|e| e["name"] == n)
                .unwrap_or_else(|| panic!("entry {n} missing: {value}"))["agent"]
                .clone()
        };
        assert_eq!(agent_of("poked"), serde_json::json!("codex"));
        assert_eq!(agent_of("plain"), serde_json::json!(null));
    }

    #[test]
    fn term_write_reports_a_submit_divergence_in_the_ack() {
        // The authority half's visible edge: when the sender's --submit agent
        // is not what the target runs, the ack says what was applied; a
        // matching request stays a bare "queued at position N".
        let (_root, registry) = empty_registry();
        use crate::terminal_sessions::CreateOptions;
        let spawn = |name: &str, agent_env: Option<&str>| {
            registry
                .create(CreateOptions {
                    size: portable_pty::PtySize {
                        rows: 24,
                        cols: 80,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some(name.to_string()),
                    tab_group: None,
                    window_id: None,
                    mcp_env: false,
                    cwd: None,
                    command: None,
                    env: agent_env
                        .map(|a| [("CHAN_AGENT".to_string(), a.to_string())].into())
                        .unwrap_or_default(),
                })
                .expect("spawn session")
        };
        spawn("Watched", Some("codex"));
        spawn("Sh", None);

        let reply = term_write(
            &registry,
            Some("Watched"),
            None,
            "poke",
            Some(SubmitAgent::Claude),
        )
        .expect("queued");
        assert_eq!(
            reply,
            "queued at position 1; Watched runs codex, not claude: the codex chord was applied"
        );

        let reply = term_write(
            &registry,
            Some("Watched"),
            None,
            "poke",
            Some(SubmitAgent::Codex),
        )
        .expect("queued");
        assert_eq!(reply, "queued at position 2", "a match adds no note");

        let reply = term_write(
            &registry,
            Some("Sh"),
            None,
            "poke",
            Some(SubmitAgent::Claude),
        )
        .expect("queued");
        assert_eq!(
            reply,
            "queued at position 1; Sh is a shell session: no claude chord applied"
        );
    }

    #[test]
    fn term_write_types_only_submit_refusal_as_failure() {
        let (_root, registry) = empty_registry();
        use crate::terminal_sessions::CreateOptions;
        let spawn = |name: &str, agent_env: Option<&str>, group: Option<&str>| {
            registry
                .create(CreateOptions {
                    size: portable_pty::PtySize {
                        rows: 24,
                        cols: 80,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some(name.to_string()),
                    tab_group: group.map(str::to_string),
                    window_id: None,
                    mcp_env: false,
                    cwd: None,
                    command: None,
                    env: agent_env
                        .map(|a| [("CHAN_AGENT".to_string(), a.to_string())].into())
                        .unwrap_or_default(),
                })
                .expect("spawn session")
        };
        spawn("@@A", Some("claude"), Some("team"));
        spawn("@@B", Some("codex"), Some("team"));
        spawn("@@C", None, Some("team"));

        let response = term_write_response(
            &registry,
            None,
            Some("team"),
            "poke",
            Some(SubmitAgent::Claude),
        );
        match response {
            ControlResponse::SubmitRefused { message } => assert_eq!(
                message,
                "queued to 3 terminal session(s); @@B runs codex, not claude: the codex chord was applied; @@C is a shell session: no claude chord applied"
            ),
            other => panic!("expected typed submit refusal, got {other:?}"),
        }

        assert!(matches!(
            term_write_response(
                &registry,
                Some("@@B"),
                None,
                "poke",
                Some(SubmitAgent::Claude),
            ),
            ControlResponse::Ok { .. }
        ));
        assert!(matches!(
            term_write_response(
                &registry,
                Some("@@A"),
                None,
                "poke",
                Some(SubmitAgent::Claude),
            ),
            ControlResponse::Ok { .. }
        ));
    }

    #[test]
    fn term_list_carries_window_kind_and_status() {
        let (_root, registry) = empty_registry();
        // A session in an alive workspace window, one in an offline standalone
        // terminal window, one whose window row is gone (orphaned), and a
        // windowless headless session.
        for (name, win) in [
            ("alive", Some("win-alive")),
            ("offline", Some("win-offline")),
            ("ghost", Some("win-gone")),
            ("headless", None),
        ] {
            registry
                .create(CreateOptions {
                    size: PtySize {
                        cols: 80,
                        rows: 24,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some(name.into()),
                    tab_group: None,
                    window_id: win.map(str::to_string),
                    mcp_env: false,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                })
                .expect("spawn session");
        }
        let records = [
            window_record("win-alive", WindowKind::Workspace, true, false),
            window_record("win-offline", WindowKind::Terminal, false, false),
        ];
        let json = term_list(&registry, &records).expect("term list");
        let value: Value = serde_json::from_str(&json).expect("json");
        let entries = value["groups"]["default"]
            .as_array()
            .expect("default group")
            .clone();
        let entry = |n: &str| {
            entries
                .iter()
                .find(|e| e["name"] == n)
                .unwrap_or_else(|| panic!("entry {n} missing: {value}"))
                .clone()
        };
        let alive = entry("alive");
        assert_eq!(alive["window"], "win-alive");
        assert_eq!(alive["window_kind"], "workspace");
        assert_eq!(alive["window_status"], "alive");
        let offline = entry("offline");
        assert_eq!(offline["window_kind"], "standalone-terminal");
        assert_eq!(offline["window_status"], "offline");
        let ghost = entry("ghost");
        assert_eq!(ghost["window"], "win-gone");
        assert_eq!(ghost["window_kind"], "orphaned");
        assert_eq!(ghost["window_status"], "orphaned");
        let headless = entry("headless");
        assert_eq!(headless["window"], Value::Null);
        assert_eq!(headless["window_kind"], "none");
    }

    /// A host stub for the `cs window rm` guard and the `cs tunnel` handler: a
    /// fixed live-terminal count, a flag recording whether the authoritative
    /// discard ran, and a real tunnel registry (the tunnel tests attach to it
    /// exactly as the WebSocket routes do).
    struct FakeHost {
        live: usize,
        discarded: std::sync::atomic::AtomicBool,
        tunnels: Arc<chan_revtunnel::server::TunnelRegistry>,
    }

    impl FakeHost {
        fn new(live: usize) -> Self {
            Self {
                live,
                discarded: std::sync::atomic::AtomicBool::new(false),
                tunnels: chan_revtunnel::server::TunnelRegistry::new(),
            }
        }
    }

    #[async_trait::async_trait]
    impl chan_library::HostControl for FakeHost {
        async fn close_workspace_for_root(
            &self,
            _root: &std::path::Path,
            _force: bool,
        ) -> Result<chan_library::WorkspaceLifecycleOutcome, chan_library::Error> {
            Ok(chan_library::WorkspaceLifecycleOutcome::NotFound)
        }
        async fn remove_workspace_for_root(
            &self,
            _root: &std::path::Path,
            _force: bool,
        ) -> Result<chan_library::WorkspaceLifecycleOutcome, chan_library::Error> {
            Ok(chan_library::WorkspaceLifecycleOutcome::NotFound)
        }
        fn assemble_window_records(&self) -> Vec<WindowRecord> {
            Vec::new()
        }
        fn discard_window(&self, _window_id: &str) -> Result<bool, chan_library::Error> {
            self.discarded
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(true)
        }
        fn live_terminal_count(&self, _window_id: &str) -> usize {
            self.live
        }
        fn tunnel_registry(&self) -> Arc<chan_revtunnel::server::TunnelRegistry> {
            Arc::clone(&self.tunnels)
        }
    }

    async fn run_window_rm(live: usize, force: bool) -> (ControlResponse, Arc<FakeHost>) {
        let cell = Arc::new(RwLock::new(None));
        let mut ctx = test_ctx(cell, ControlTenant::Workspace);
        let fake = Arc::new(FakeHost::new(live));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        ctx.unserve = UnserveScope::Host(Arc::downgrade(&host));
        let resp = handle_request(
            ControlRequest::WindowClose {
                id: "w-1".into(),
                force,
            },
            &ctx,
        )
        .await;
        (resp, fake)
    }

    #[tokio::test]
    async fn window_rm_guards_live_terminals_without_force() {
        let (resp, fake) = run_window_rm(2, false).await;
        match resp {
            ControlResponse::Error { message } => {
                assert!(message.contains("2 live terminal"), "got: {message}")
            }
            other => panic!("expected guard error, got {other:?}"),
        }
        assert!(
            !fake.discarded.load(std::sync::atomic::Ordering::SeqCst),
            "the guard must refuse before discarding"
        );
    }

    #[tokio::test]
    async fn window_rm_with_force_discards_despite_live_terminals() {
        let (resp, fake) = run_window_rm(2, true).await;
        assert!(matches!(resp, ControlResponse::Ok { .. }), "got: {resp:?}");
        assert!(
            fake.discarded.load(std::sync::atomic::Ordering::SeqCst),
            "--force must reach the authoritative discard"
        );
    }

    #[tokio::test]
    async fn window_rm_removes_an_offline_row_with_no_live_terminals() {
        // The headline bug: an offline/dead row (no live terminals) is removable
        // without --force, via the host's authoritative discard.
        let (resp, fake) = run_window_rm(0, false).await;
        match resp {
            ControlResponse::Ok { message } => {
                assert!(message.contains("removed window w-1"), "got: {message}")
            }
            other => panic!("expected ok, got {other:?}"),
        }
        assert!(
            fake.discarded.load(std::sync::atomic::Ordering::SeqCst),
            "an offline row must be discarded"
        );
    }

    #[test]
    fn term_restart_requires_a_selector() {
        let (_root, registry) = empty_registry();
        let err = term_restart(&registry, None, None).expect_err("no selector");
        assert!(err.contains("selector"), "got: {err}");
    }

    #[test]
    fn term_restart_reports_no_match_on_an_empty_registry() {
        let (_root, registry) = empty_registry();
        let err = term_restart(&registry, Some("nope"), None).expect_err("no match");
        assert!(err.contains("no live terminal session"), "got: {err}");
    }

    // A valid two-member team config TOML for the handle_team tests.
    const SAMPLE_TEAM_TOML: &str = r#"
team_name = "alpha"
host_name = "Neo"
host_handle = "@@Neo"
tab_group = "alpha"
created_at = "2026-05-29T00:00:00Z"

[[members]]
handle = "@@Lead"
command = "claude"
is_lead = true
agent = "claude"

[[members]]
handle = "@@Alice"
command = "codex"
is_lead = false
agent = "codex"
"#;

    fn empty_cell() -> Arc<RwLock<Option<WorkspaceCell>>> {
        Arc::new(RwLock::new(None))
    }

    /// A throwaway events sender for `handle_team` / `spawn_and_poke_team` in
    /// tests. The `TeamSpawned` push goes here; with no receiver the
    /// broadcast `send` is a harmless no-op, so the tests do not assert on it.
    fn test_events() -> broadcast::Sender<String> {
        broadcast::channel::<String>(8).0
    }

    #[tokio::test]
    async fn handle_team_rejects_empty_and_absolute_dir() {
        let ctx = test_ctx(empty_cell(), ControlTenant::Workspace);
        match handle_team(
            TeamRequest {
                dir: "   ".to_string(),
                op: TeamOp::New,
                config_toml: None,
                brief_content: None,
                script: false,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &ctx,
        )
        .await
        {
            ControlResponse::Error { message } => {
                assert!(message.contains("required"), "{message}")
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
        match handle_team(
            TeamRequest {
                dir: "/abs/team".to_string(),
                op: TeamOp::Load,
                config_toml: None,
                brief_content: None,
                script: false,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &ctx,
        )
        .await
        {
            ControlResponse::Error { message } => {
                assert!(message.contains("workspace-relative"), "{message}")
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_team_new_requires_a_config() {
        let ctx = test_ctx(empty_cell(), ControlTenant::Workspace);
        match handle_team(
            TeamRequest {
                dir: "new-team-1".to_string(),
                op: TeamOp::New,
                config_toml: None,
                brief_content: None,
                script: false,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &ctx,
        )
        .await
        {
            ControlResponse::Error { message } => {
                assert!(message.contains("needs a config"), "{message}")
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_team_new_script_emits_bootstrap_without_a_workspace() {
        // `--script` is a pure generator: it returns the script even with
        // no workspace cell bound (no filesystem I/O on this path).
        let ctx = test_ctx(empty_cell(), ControlTenant::Workspace);
        match handle_team(
            TeamRequest {
                dir: "new-team-1".to_string(),
                op: TeamOp::New,
                config_toml: Some(SAMPLE_TEAM_TOML.into()),
                brief_content: None,
                script: true,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &ctx,
        )
        .await
        {
            ControlResponse::Ok { message } => {
                assert!(message.starts_with("#!/usr/bin/env bash"), "{message}");
                assert!(message.contains("--tab-name='@@Lead'"), "{message}");
                assert!(message.contains("--submit=codex"), "{message}");
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_team_new_rejects_invalid_toml() {
        let ctx = test_ctx(empty_cell(), ControlTenant::Workspace);
        match handle_team(
            TeamRequest {
                dir: "new-team-1".to_string(),
                op: TeamOp::New,
                config_toml: Some("this is not = = toml".into()),
                brief_content: None,
                script: true,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &ctx,
        )
        .await
        {
            ControlResponse::Error { message } => {
                assert!(message.contains("invalid team config TOML"), "{message}")
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_team_new_rejects_a_config_that_fails_validation() {
        // Valid TOML, but zero members -> validation fails before any write.
        let cell = empty_cell();
        let toml_text = r#"
team_name = "alpha"
host_name = "Neo"
host_handle = "@@Neo"
created_at = "2026-05-29T00:00:00Z"
"#;
        match handle_team(
            TeamRequest {
                dir: "new-team-1".to_string(),
                op: TeamOp::New,
                config_toml: Some(toml_text.into()),
                brief_content: None,
                script: true,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &test_ctx(cell, ControlTenant::Workspace),
        )
        .await
        {
            ControlResponse::Error { message } => {
                assert!(message.contains("between 1 and 9"), "{message}")
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    // A team whose members run a benign shell (blank command -> default
    // login shell), so `spawn_team` brings them up in CI without needing the
    // real agent binaries on PATH. Lead @@Lead (claude submit chord), worker
    // @@Alice (codex), plus a shell member @@Shell (no agent -> no poke).
    const SPAWNABLE_TEAM_TOML: &str = r#"
team_name = "spawnme"
host_name = "Neo"
host_handle = "@@Neo"
tab_group = "spawnme"
created_at = "2026-05-29T00:00:00Z"

# The submit agent is DERIVED from the command (+ a CHAN_AGENT env override).
# These fixtures use empty commands (so the spawn launches a harmless shell,
# not a real agent binary), and CHAN_AGENT to classify which members are
# agents vs the shell member. The command-sniff path is unit-tested in
# chan_shell::submit.
[[members]]
handle = "@@Alice"
command = ""
is_lead = false
env = { CHAN_AGENT = "codex" }

[[members]]
handle = "@@Lead"
command = ""
is_lead = true
env = { CHAN_AGENT = "claude" }

[[members]]
handle = "@@Shell"
command = ""
is_lead = false
"#;

    fn spawnable_config() -> TeamConfig {
        toml::from_str(SPAWNABLE_TEAM_TOML).expect("valid spawnable team config")
    }

    #[cfg(unix)]
    fn single_probe_agent(command: &str) -> TeamConfig {
        let mut config = spawnable_config();
        config.team_name = "readiness-probe".into();
        config.tab_group = "readiness-probe".into();
        config.members.retain(|member| member.is_lead);
        let lead = config.members.first_mut().expect("lead member");
        lead.command = command.into();
        lead.env.insert("CHAN_AGENT".into(), "codex".into());
        config
    }

    #[test]
    fn resolve_team_group_appends_suffix_on_collision() {
        let (_root, registry) = empty_registry();
        assert_eq!(
            resolve_team_group(&registry, "alpha"),
            "alpha",
            "no live group -> base verbatim"
        );
        // Bring up a session in group "alpha"; the next resolve must dodge it.
        let _h = registry
            .create(CreateOptions {
                size: PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("@@x".into()),
                tab_group: Some("alpha".into()),
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .expect("spawn collision session");
        assert_eq!(resolve_team_group(&registry, "alpha"), "alpha-2");
    }

    #[test]
    fn spawn_team_brings_up_lead_first_and_pokes_only_agents() {
        let (_root, registry) = empty_registry();
        let config = spawnable_config();
        let spawn = spawn_team(&registry, "new-team-1", &config, false, Some("win-spawn"));

        // Lead first, then roster order: @@Lead, @@Alice, @@Shell.
        assert_eq!(spawn.spawned, vec!["@@Lead", "@@Alice", "@@Shell"]);
        assert!(
            spawn.failed.is_empty(),
            "no spawn failed: {:?}",
            spawn.failed
        );
        assert_eq!(spawn.group, "spawnme");

        // Only the two AGENT members get an identity poke; the shell member
        // (no agent) does not. Lead's poke carries claude's chord, the
        // worker's carries codex's CR.
        assert_eq!(spawn.pokes.len(), 2, "agents only: {:?}", spawn.pokes);
        assert_eq!(spawn.pokes[0].member, "@@Lead");
        // claude is a SINGLE write ending in its modifyOtherKeys chord.
        assert_eq!(spawn.pokes[0].writes.len(), 1, "claude poke is one write");
        assert!(
            spawn.pokes[0].writes[0].ends_with("\n\x1b[27;9;13~"),
            "lead poke ends with claude chord: {:?}",
            spawn.pokes[0].writes
        );
        assert!(
            spawn.pokes[0].writes[0].contains("You are @@Lead"),
            "lead poke names the lead: {:?}",
            spawn.pokes[0].writes
        );
        assert_eq!(spawn.pokes[1].member, "@@Alice");
        // codex is a SINGLE write (bracketed-paste wrap) ending in CR.
        assert_eq!(spawn.pokes[1].writes.len(), 1, "codex poke is one write");
        assert!(
            spawn.pokes[1].writes[0].ends_with("\n\x1b[201~\r")
                && !spawn.pokes[1].writes[0].ends_with("\x1b[27;9;13~"),
            "worker poke ends with codex CR: {:?}",
            spawn.pokes[1].writes
        );

        // All three sessions live in the resolved group.
        let summaries = registry.session_summaries();
        assert_eq!(summaries.len(), 3);
        assert!(summaries.iter().all(|s| s.tab_group == "spawnme"));

        // Every spawned agent binds to the caller's window, so
        // `window_ids_matching` (the survey / pane-selector resolver) finds
        // it. A windowless spawn (None) would leave nothing to match.
        assert_eq!(
            registry.window_ids_matching(None, Some("spawnme")),
            vec!["win-spawn".to_string()],
            "agents are bound to the caller window"
        );
    }

    #[test]
    fn spawn_team_opencode_lead_uses_one_bracketed_paste_write() {
        let (_root, registry) = empty_registry();
        let mut config = spawnable_config();
        let lead = config
            .members
            .iter_mut()
            .find(|member| member.is_lead)
            .expect("lead member");
        lead.env.insert("CHAN_AGENT".into(), "opencode".into());

        let spawn = spawn_team(&registry, "new-team-1", &config, false, None);
        let poke = spawn
            .pokes
            .iter()
            .find(|poke| poke.member == "@@Lead")
            .expect("lead identity poke");
        let writes = &poke.writes;
        assert_eq!(writes.len(), 1, "opencode has raw-write cost one");
        assert!(
            writes[0].starts_with("\x1b[200~# Team work") && writes[0].contains("You are @@Lead"),
            "opencode lead body starts inside bracketed paste: {writes:?}"
        );
        assert!(
            writes[0].ends_with("\n\x1b[201~\r"),
            "opencode lead submits after bracketed paste: {writes:?}"
        );
    }

    // The open_survey frame must carry the target tab as camelCase
    // `tabName`. A green compile alone would not catch a snake_case
    // drift, so pin the wire string here.
    #[test]
    fn open_survey_frame_serializes_tab_name_as_camel_case_tabname() {
        let spec = SurveySpec {
            survey_id: "sid-1".into(),
            title: None,
            body_markdown: "pick one".into(),
            options: vec!["a".into(), "b".into()],
        };
        // `--tab-name=X` -> the frame carries `tabName`.
        let with_tab = serde_json::to_value(WindowCommand::OpenSurvey {
            survey: spec.clone(),
            tab_name: Some("@@Probe".into()),
        })
        .expect("serialize open_survey");
        assert_eq!(with_tab["command"], "open_survey");
        assert_eq!(with_tab["tabName"], "@@Probe");
        assert!(
            with_tab.get("tab_name").is_none(),
            "wire field must be camelCase tabName, not tab_name"
        );
        // No specific tab -> `tabName` is omitted; the SPA keeps its window-wide
        // fallback.
        let without_tab = serde_json::to_value(WindowCommand::OpenSurvey {
            survey: spec,
            tab_name: None,
        })
        .expect("serialize open_survey");
        assert!(
            without_tab.get("tabName").is_none(),
            "None tab_name omits the field"
        );
    }

    #[test]
    fn close_survey_frame_serializes_reason_and_camel_case_fields() {
        let with_tab = serde_json::to_value(WindowCommand::CloseSurvey {
            survey_id: "sid-1".into(),
            reason: SurveyCloseReason::TimedOut,
            tab_name: Some("@@Probe".into()),
        })
        .expect("serialize close_survey");
        assert_eq!(with_tab["command"], "close_survey");
        assert_eq!(with_tab["surveyId"], "sid-1");
        assert_eq!(with_tab["reason"], "timed_out");
        assert_eq!(with_tab["tabName"], "@@Probe");
        assert!(
            with_tab.get("survey_id").is_none() && with_tab.get("tab_name").is_none(),
            "wire fields must stay camelCase"
        );

        let without_tab = serde_json::to_value(WindowCommand::CloseSurvey {
            survey_id: "sid-2".into(),
            reason: SurveyCloseReason::AnsweredElsewhere,
            tab_name: None,
        })
        .expect("serialize close_survey");
        assert_eq!(without_tab["reason"], "answered_elsewhere");
        assert!(without_tab.get("tabName").is_none());
    }

    #[tokio::test]
    async fn group_survey_timeout_closes_each_target_window() {
        let (_root, registry) = empty_registry();
        for (tab_name, window_id) in [("@@A", "win-a"), ("@@B", "win-b")] {
            registry
                .create(CreateOptions {
                    size: PtySize {
                        cols: 80,
                        rows: 24,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some(tab_name.into()),
                    tab_group: Some("alpha".into()),
                    window_id: Some(window_id.into()),
                    mcp_env: true,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                })
                .expect("spawn survey target");
        }
        let registry = Arc::new(registry);
        let events_tx = broadcast::channel(16).0;
        let mut rx = events_tx.subscribe();
        let survey_bus = Arc::new(crate::survey::SurveyBus::new());
        let response = handle_survey(
            SurveySpec {
                survey_id: String::new(),
                title: None,
                body_markdown: "pick one".into(),
                options: vec!["a".into()],
            },
            None,
            Some("alpha"),
            0,
            &events_tx,
            &survey_bus,
            Some(&registry),
        )
        .await;

        assert!(matches!(response, ControlResponse::Timeout { .. }));
        let mut frames = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            frames.push(serde_json::from_str::<serde_json::Value>(&raw).unwrap());
        }
        let opens = frames
            .iter()
            .filter(|frame| frame["command"] == "open_survey")
            .collect::<Vec<_>>();
        let closes = frames
            .iter()
            .filter(|frame| frame["command"] == "close_survey")
            .collect::<Vec<_>>();
        assert_eq!(opens.len(), 2, "group survey opens in each target window");
        assert_eq!(closes.len(), 2, "timeout closes each target window");
        assert!(closes.iter().all(|frame| frame["reason"] == "timed_out"));
        assert!(
            closes.iter().all(|frame| frame.get("tabName").is_none()),
            "group survey close stays window-wide"
        );
    }

    #[tokio::test]
    async fn answered_survey_excludes_the_answering_window_from_close_fanout() {
        // Regression (S-A): a group survey open in win-a + win-b, answered in
        // win-a. The stale-overlay close must reach win-b ONLY. Fanning
        // `answered_elsewhere` back to the answerer races its own reply-clear
        // and pops a spurious saved-draft dialog + hides its composer there.
        let (_root, registry) = empty_registry();
        for (tab_name, window_id) in [("@@A", "win-a"), ("@@B", "win-b")] {
            registry
                .create(CreateOptions {
                    size: PtySize {
                        cols: 80,
                        rows: 24,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some(tab_name.into()),
                    tab_group: Some("alpha".into()),
                    window_id: Some(window_id.into()),
                    mcp_env: true,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                })
                .expect("spawn survey target");
        }
        let registry = Arc::new(registry);
        // Anchor the frame type: unlike the direct-await tests, the join! below
        // defers the inference that would otherwise fix it to String.
        let events_tx: broadcast::Sender<String> = broadcast::channel(16).0;
        let mut rx = events_tx.subscribe();
        let survey_bus = Arc::new(crate::survey::SurveyBus::new());

        // `handle_survey` blocks awaiting the reply, so answer it concurrently
        // on the same task (no spawn, so the borrows stay simple).
        let answer = async {
            // Recover the server-minted id from the first open_survey frame.
            let survey_id = loop {
                let raw = rx.recv().await.expect("open frame");
                let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
                if frame["command"] == "open_survey" {
                    break frame["survey"]["surveyId"].as_str().unwrap().to_string();
                }
            };
            assert!(survey_bus.complete_survey(
                &survey_id,
                SurveyReply::Option {
                    survey_id: survey_id.clone(),
                    option_index: 0,
                    option_label: "a".into(),
                },
                Some("win-a".into()),
            ));
        };
        let (response, ()) = tokio::join!(
            handle_survey(
                SurveySpec {
                    survey_id: String::new(),
                    title: None,
                    body_markdown: "pick one".into(),
                    options: vec!["a".into()],
                },
                None,
                Some("alpha"),
                30,
                &events_tx,
                &survey_bus,
                Some(&registry),
            ),
            answer,
        );

        assert!(matches!(response, ControlResponse::Ok { .. }));
        let mut closes = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["command"] == "close_survey" {
                closes.push(frame);
            }
        }
        assert_eq!(
            closes.len(),
            1,
            "the answered close reaches only the non-answering window"
        );
        assert_eq!(closes[0]["window_id"], "win-b");
        assert_eq!(closes[0]["reason"], "answered_elsewhere");
        assert!(
            closes.iter().all(|frame| frame["window_id"] != "win-a"),
            "the answering window must be excluded from the close fan-out"
        );
    }

    /// A registry holding one live session named `@@T` owned by `win-a`,
    /// the single survey target the FIFO tests address.
    fn single_tab_registry() -> (tempfile::TempDir, Arc<TerminalRegistry>) {
        let (root, registry) = empty_registry();
        registry
            .create(CreateOptions {
                size: PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("@@T".into()),
                tab_group: None,
                window_id: Some("win-a".into()),
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .expect("spawn survey target");
        (root, Arc::new(registry))
    }

    /// A minimal one-option spec whose body names the survey, so a test can
    /// tell overlays apart on the frame stream.
    fn survey_spec(body: &str) -> SurveySpec {
        SurveySpec {
            survey_id: String::new(),
            title: None,
            body_markdown: body.into(),
            options: vec!["ok".into()],
        }
    }

    /// Await the next `open_survey` frame on the `/ws` fan-out.
    async fn recv_open_survey(rx: &mut broadcast::Receiver<String>) -> serde_json::Value {
        loop {
            let raw = rx.recv().await.expect("open_survey frame");
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["command"] == "open_survey" {
                return frame;
            }
        }
    }

    /// Answer an open survey through the bus the way `POST /api/survey/reply`
    /// does, echoing the id the frame carried.
    fn answer_survey(
        survey_bus: &crate::survey::SurveyBus,
        open_frame: &serde_json::Value,
        label: &str,
    ) {
        let survey_id = open_frame["survey"]["surveyId"]
            .as_str()
            .expect("server-minted id")
            .to_string();
        assert!(survey_bus.complete_survey(
            &survey_id,
            SurveyReply::Option {
                survey_id: survey_id.clone(),
                option_index: 0,
                option_label: label.into(),
            },
            Some("win-a".into()),
        ));
    }

    #[tokio::test]
    async fn second_survey_for_the_same_tab_defers_until_the_first_resolves() {
        // Two surveys addressed to the same tab serialize server-side: the
        // second's open_survey is pushed only after the first resolves, so
        // the SPA's single per-tab slot never sees two at once and BOTH are
        // answerable, in order.
        let (_root, registry) = single_tab_registry();
        let events_tx: broadcast::Sender<String> = broadcast::channel(64).0;
        let mut rx = events_tx.subscribe();
        let survey_bus = Arc::new(crate::survey::SurveyBus::new());

        let driver = async {
            let open_a = recv_open_survey(&mut rx).await;
            assert_eq!(open_a["survey"]["bodyMarkdown"], "first");
            // The second survey is enqueued by now (join! polled it) and must
            // NOT have opened while the first is unresolved.
            assert!(
                rx.try_recv().is_err(),
                "second survey opened before the first resolved"
            );
            answer_survey(&survey_bus, &open_a, "first-answer");
            let open_b = recv_open_survey(&mut rx).await;
            assert_eq!(open_b["survey"]["bodyMarkdown"], "second");
            answer_survey(&survey_bus, &open_b, "second-answer");
        };
        let (resp_a, resp_b, ()) = tokio::join!(
            handle_survey(
                survey_spec("first"),
                Some("@@T"),
                None,
                30,
                &events_tx,
                &survey_bus,
                Some(&registry),
            ),
            handle_survey(
                survey_spec("second"),
                Some("@@T"),
                None,
                30,
                &events_tx,
                &survey_bus,
                Some(&registry),
            ),
            driver,
        );

        match resp_a {
            ControlResponse::Ok { message } => assert_eq!(message, "first-answer"),
            other => panic!("first survey should resolve Ok, got {other:?}"),
        }
        match resp_b {
            ControlResponse::Ok { message } => assert_eq!(message, "second-answer"),
            other => panic!("second survey should resolve Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn queued_survey_times_out_while_waiting_and_leaves_the_queue() {
        // A QUEUED survey whose --timeout elapses before its turn answers
        // Timeout without ever opening an overlay, and its queue slot is
        // vacated: no ghost head blocks the next survey for the target.
        let (_root, registry) = single_tab_registry();
        let events_tx: broadcast::Sender<String> = broadcast::channel(64).0;
        let mut rx = events_tx.subscribe();
        let survey_bus = Arc::new(crate::survey::SurveyBus::new());

        let driver = async {
            // Queued behind the open first survey with a 0s budget: the
            // deadline passes while waiting, so it times out in the queue.
            let resp_b = handle_survey(
                survey_spec("second"),
                Some("@@T"),
                None,
                0,
                &events_tx,
                &survey_bus,
                Some(&registry),
            )
            .await;
            match resp_b {
                ControlResponse::Timeout { message } => {
                    assert!(message.contains("queued"), "unexpected message: {message}")
                }
                other => panic!("queued survey should time out, got {other:?}"),
            }
            // Only the first survey's overlay ever opened; the queued
            // timeout pushed no open and no close of its own.
            let open_a = recv_open_survey(&mut rx).await;
            assert_eq!(open_a["survey"]["bodyMarkdown"], "first");
            assert!(
                rx.try_recv().is_err(),
                "a queued timeout must not push frames"
            );
            // The first survey is still answerable, and with the timed-out
            // one gone from the queue a third survey opens as soon as the
            // first resolves.
            answer_survey(&survey_bus, &open_a, "first-answer");
            let (resp_c, ()) = tokio::join!(
                handle_survey(
                    survey_spec("third"),
                    Some("@@T"),
                    None,
                    30,
                    &events_tx,
                    &survey_bus,
                    Some(&registry),
                ),
                async {
                    let open_c = recv_open_survey(&mut rx).await;
                    assert_eq!(open_c["survey"]["bodyMarkdown"], "third");
                    answer_survey(&survey_bus, &open_c, "third-answer");
                },
            );
            match resp_c {
                ControlResponse::Ok { message } => assert_eq!(message, "third-answer"),
                other => panic!("third survey should resolve Ok, got {other:?}"),
            }
        };
        let (resp_a, ()) = tokio::join!(
            handle_survey(
                survey_spec("first"),
                Some("@@T"),
                None,
                30,
                &events_tx,
                &survey_bus,
                Some(&registry),
            ),
            driver,
        );

        match resp_a {
            ControlResponse::Ok { message } => assert_eq!(message, "first-answer"),
            other => panic!("first survey should resolve Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn survey_against_a_full_target_queue_is_refused_with_queue_full() {
        // A target already holding SURVEY_QUEUE_CAP surveys refuses the next
        // one with the explicit queue-full response and pushes nothing.
        let (_root, registry) = single_tab_registry();
        let events_tx: broadcast::Sender<String> = broadcast::channel(64).0;
        let mut rx = events_tx.subscribe();
        let survey_bus = Arc::new(crate::survey::SurveyBus::new());

        // Fill the handler's own key for the @@T/win-a target.
        let key = crate::survey::survey_queue_key(&["win-a".to_string()], Some("@@T"));
        let mut held = Vec::new();
        for n in 0..crate::survey::SURVEY_QUEUE_CAP {
            match survey_bus.enqueue_turn(key.clone()) {
                crate::survey::SurveyTurn::Ready(guard) => held.push((guard, None)),
                crate::survey::SurveyTurn::Wait(guard, turn_rx) => {
                    held.push((guard, Some(turn_rx)))
                }
                crate::survey::SurveyTurn::Full => panic!("queue full at {n}, before the cap"),
            }
        }

        let response = handle_survey(
            survey_spec("overflow"),
            Some("@@T"),
            None,
            30,
            &events_tx,
            &survey_bus,
            Some(&registry),
        )
        .await;

        match response {
            ControlResponse::QueueFull { message } => {
                assert!(message.contains("full"), "unexpected message: {message}")
            }
            other => panic!("expected QueueFull, got {other:?}"),
        }
        assert!(
            rx.try_recv().is_err(),
            "a refused survey must not push frames"
        );
    }

    // A registry that advertises an MCP socket path, so `set_mcp_env` actually
    // stamps the CHAN_MCP_* descriptor when a member's mcp_env is on (the
    // `empty_registry` helper sets it to None, which no-ops the env even when
    // the toggle is on). The path need not point at a live socket: the child
    // only receives it as env, it does not dial it at spawn time.
    #[cfg(unix)]
    fn registry_with_mcp_socket() -> (tempfile::TempDir, TerminalRegistry) {
        use crate::config::TerminalConfig;
        use crate::terminal_sessions::RegistryConfig;
        let root = tempfile::tempdir().expect("workspace root");
        let registry = TerminalRegistry::new(RegistryConfig {
            workspace_root: root.path().to_path_buf(),
            mcp_socket_path: Some(std::path::PathBuf::from("/tmp/chan-test-mcp.sock")),
            control_socket_path: None,
            terminal: TerminalConfig::default(),
        });
        (root, registry)
    }

    #[cfg(unix)]
    fn probe_team_config(mcp_env: bool) -> TeamConfig {
        TeamConfig {
            team_name: "probe".into(),
            host_name: "Neo".into(),
            host_handle: "@@Neo".into(),
            tab_group: "probe".into(),
            auto_prefix_at: false,
            mcp_env,
            created_at: "2026-06-03T00:00:00Z".into(),
            members: vec![chan_workspace::Member {
                handle: "@@Probe".into(),
                // `${VAR:+set}` expands to "set" when CHAN_MCP_SERVER_JSON is
                // present and "" when absent, so the marker line records the
                // toggle outcome. `sleep` keeps the session alive to be read.
                command: "printf '<<MCP:%s>>\\n' \"${CHAN_MCP_SERVER_JSON:+set}\"; sleep 3".into(),
                env: Default::default(),
                is_lead: true,
                position: None,
            }],
        }
    }

    // E2E: the team config `mcp_env` toggle must flow all the way to the
    // spawned member's PTY env (TeamConfig.mcp_env -> CreateOptions.mcp_env in
    // spawn_team -> set_mcp_env on the child). mcp_env=true stamps
    // CHAN_MCP_SERVER_JSON; mcp_env=false omits it. Read off the member's PTY
    // scrollback via the marker the probe command prints.
    #[cfg(unix)]
    #[test]
    fn spawn_team_mcp_env_toggle_reaches_member_pty_env() {
        use std::time::{Duration, Instant};
        for mcp_env in [true, false] {
            let (_root, registry) = registry_with_mcp_socket();
            let config = probe_team_config(mcp_env);
            let spawn = spawn_team(&registry, "probe-team", &config, false, Some("win-probe"));
            assert_eq!(spawn.spawned, vec!["@@Probe"], "probe member spawned");

            let deadline = Instant::now() + Duration::from_secs(6);
            let mut out = String::new();
            loop {
                if let Ok(s) = term_scrollback(&registry, "@@Probe") {
                    out = s;
                    if out.contains("<<MCP:") {
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            if mcp_env {
                assert!(
                    out.contains("<<MCP:set>>"),
                    "team mcp_env=true should stamp CHAN_MCP_SERVER_JSON on the \
                     member; scrollback: {out:?}"
                );
            } else {
                assert!(
                    out.contains("<<MCP:>>") && !out.contains("<<MCP:set>>"),
                    "team mcp_env=false should omit CHAN_MCP_SERVER_JSON on the \
                     member; scrollback: {out:?}"
                );
            }
        }
    }

    // A team of two shell members (one lead, neither an agent). spawn_and_
    // poke_team brings them up but pokes nobody, so it skips the readiness
    // wait and returns immediately - exercises the spawn path end-to-end
    // without awaiting terminal output in the test.
    const SHELL_TEAM_TOML: &str = r#"
team_name = "shellsquad"
host_name = "Neo"
host_handle = "@@Neo"
tab_group = "shellsquad"
created_at = "2026-05-29T00:00:00Z"

[[members]]
handle = "@@Boss"
command = ""
is_lead = true

[[members]]
handle = "@@Hand"
command = ""
is_lead = false
"#;

    /// SHELL_TEAM_TOML with grid positions: lead at (0,0), worker at (0,1),
    /// a 1x2 pane grid.
    const POSITIONED_TEAM_TOML: &str = r#"
team_name = "shellsquad"
host_name = "Neo"
host_handle = "@@Neo"
tab_group = "shellsquad"
created_at = "2026-05-29T00:00:00Z"

[[members]]
handle = "@@Boss"
command = ""
is_lead = true
position = { row = 0, col = 0 }

[[members]]
handle = "@@Hand"
command = ""
is_lead = false
position = { row = 0, col = 1 }
"#;

    /// Answer the next `pane_query` frame on `events_rx` with a reply listing
    /// `pane_count` panes, through the window bus, standing in for the SPA
    /// side of the single-pane precondition's round-trip.
    async fn answer_pane_query(
        events_rx: &mut broadcast::Receiver<String>,
        window_bus: &crate::window_bus::WindowBus,
        window_id: &str,
        pane_count: usize,
    ) {
        let raw = events_rx.recv().await.expect("pane_query frame");
        let frame: serde_json::Value = serde_json::from_str(&raw).expect("frame json");
        assert_eq!(frame["command"], "pane_query", "unexpected frame: {frame}");
        assert_eq!(frame["window_id"], window_id);
        let id = frame["request_id"]
            .as_str()
            .expect("request_id")
            .to_string();
        let panes: Vec<serde_json::Value> = (0..pane_count)
            .map(|i| serde_json::json!({ "id": format!("pane-{i}"), "active": i == 0 }))
            .collect();
        assert!(window_bus.complete(
            &id,
            serde_json::json!({
                "windowId": window_id,
                "activePaneId": "pane-0",
                "panes": panes,
            })
        ));
    }

    #[tokio::test]
    async fn spawn_and_poke_team_with_shell_members_skips_the_poke_wait() {
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config: TeamConfig = toml::from_str(SHELL_TEAM_TOML).expect("valid shell team");
        match spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            None,
            None,
            &SessionRegistry::new(),
            &test_events(),
        )
        .await
        {
            ControlResponse::Ok { message } => {
                assert!(message.contains("shellsquad"), "{message}");
                assert!(message.contains("2 member(s) up"), "{message}");
                assert!(message.contains("poked 0 agent(s)"), "{message}");
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
        assert_eq!(registry.session_summaries().len(), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_and_poke_team_waits_for_bracketed_paste_after_a_slow_start() {
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config = single_probe_agent("sleep 3.25; printf '<<READY>>\\033[?2004h'; sleep 1");

        let response = spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            None,
            None,
            &SessionRegistry::new(),
            &test_events(),
        )
        .await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let scrollback = loop {
            let output = term_scrollback(&registry, "@@Lead").expect("probe scrollback");
            if output.contains("# Team work") || std::time::Instant::now() >= deadline {
                break output;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        registry.close_matching(Some("@@Lead"), None);

        match response {
            ControlResponse::Ok { message } => {
                assert!(message.contains("poked 1 agent(s)"), "{message}");
                let ready = scrollback
                    .find("<<READY>>")
                    .expect("readiness marker in scrollback");
                let poke = scrollback
                    .find("# Team work")
                    .expect("identity poke echoed by the test PTY");
                assert!(
                    ready < poke,
                    "identity poke must follow readiness: {scrollback:?}"
                );
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn spawn_and_poke_team_names_an_agent_that_never_becomes_ready() {
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config = single_probe_agent("sleep 60");

        let response = spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            None,
            None,
            &SessionRegistry::new(),
            &test_events(),
        )
        .await;
        let scrollback = term_scrollback(&registry, "@@Lead").expect("probe scrollback");
        registry.close_matching(Some("@@Lead"), None);

        match response {
            ControlResponse::Error { message } => {
                assert!(message.contains("@@Lead"), "{message}");
                assert!(message.contains("15s"), "{message}");
                assert!(message.contains("bracketed-paste"), "{message}");
                assert!(
                    !scrollback.contains("# Team work"),
                    "an unready agent must not be poked: {scrollback:?}"
                );
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_and_poke_team_names_an_agent_that_exits_before_readiness() {
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config = single_probe_agent("exit 9");

        let response = spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            None,
            None,
            &SessionRegistry::new(),
            &test_events(),
        )
        .await;
        let scrollback = term_scrollback(&registry, "@@Lead").expect("probe scrollback");
        registry.close_matching(Some("@@Lead"), None);

        match response {
            ControlResponse::Error { message } => {
                assert!(message.contains("@@Lead"), "{message}");
                assert!(message.contains("terminal ended"), "{message}");
                assert!(
                    !scrollback.contains("# Team work"),
                    "an exited agent must not be poked: {scrollback:?}"
                );
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn spawn_and_poke_team_surfaces_to_the_window() {
        // A windowed spawn pushes a `team_spawned` frame to that window
        // carrying the group + each member's tab name and live session id, so
        // the SPA can open a terminal tab attached to the session.
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config: TeamConfig = toml::from_str(SHELL_TEAM_TOML).expect("valid shell team");
        let (events_tx, mut rx) = broadcast::channel::<String>(8);
        let (session_registry, _guard) = live_window("win-s1");
        spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            Some("win-s1"),
            Some(TabDestination {
                pane_id: Some("pane-2".into()),
                side: Some(chan_shell::PaneSide::B),
            }),
            &session_registry,
            &events_tx,
        )
        .await;

        let frame: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("team_spawned frame")).expect("json");
        assert_eq!(frame["type"], "window_command");
        assert_eq!(frame["window_id"], "win-s1");
        assert_eq!(frame["command"], "team_spawned");
        assert_eq!(frame["group"], "shellsquad");
        assert_eq!(frame["destination"]["pane_id"], "pane-2");
        assert_eq!(frame["destination"]["side"], "b");
        let members = frame["members"].as_array().expect("members array");
        assert_eq!(members.len(), 2);
        assert_eq!(members[0]["tab_name"], "@@Boss");
        assert!(
            members[0]["session_id"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
            "member carries a live session id: {members:?}"
        );
    }

    #[tokio::test]
    async fn spawn_and_poke_team_reports_a_surface_enqueue_failure() {
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config: TeamConfig = toml::from_str(SHELL_TEAM_TOML).expect("valid shell team");
        let (events_tx, rx) = broadcast::channel::<String>(8);
        drop(rx);
        let (session_registry, _guard) = live_window("win-s1");

        let response = spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            Some("win-s1"),
            None,
            &session_registry,
            &events_tx,
        )
        .await;

        match response {
            ControlResponse::Error { message } => {
                assert!(
                    message.contains("spawned but could not be surfaced"),
                    "{message}"
                );
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn spawn_and_poke_team_windowless_does_not_surface() {
        // No window to surface into -> no `team_spawned` push (the SPA learns
        // the sessions on its next attach, as before).
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config: TeamConfig = toml::from_str(SHELL_TEAM_TOML).expect("valid shell team");
        let (events_tx, mut rx) = broadcast::channel::<String>(8);
        spawn_and_poke_team(
            &registry,
            "new-team-1",
            &config,
            false,
            None,
            None,
            &SessionRegistry::new(),
            &events_tx,
        )
        .await;
        assert!(
            rx.try_recv().is_err(),
            "a windowless spawn must not surface a team_spawned frame"
        );
    }

    /// A workspace cell bound over an empty temp workspace, for the
    /// `handle_team` tests that exercise the write (`new`) path. The indexer
    /// is real (the cell requires one) but never used here.
    fn bound_empty_cell() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<RwLock<Option<WorkspaceCell>>>,
    ) {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        let lib =
            chan_workspace::Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_workspace(root.path())
            .expect("register workspace");
        let workspace = lib.open_workspace(root.path()).expect("open workspace");
        let (index_tx, index_rx) = broadcast::channel::<chan_workspace::WatchEvent>(1);
        // Keep the channel open for the indexer's lifetime; the test never
        // sends on it.
        std::mem::forget(index_tx);
        let indexer = Arc::new(crate::indexer::Indexer::spawn(
            workspace.clone(),
            index_rx,
            false,
            chan_workspace::SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        ));
        let cell = Arc::new(RwLock::new(Some(WorkspaceCell {
            workspace,
            watch_handle: None,
            indexer,
        })));
        (cfg, root, cell)
    }

    /// [`bound_empty_cell`] with a SHELL_TEAM_TOML team already written under
    /// `dir`, for the `handle_team` Load tests. Both shell members spawn
    /// without an agent binary on PATH.
    fn bound_cell_with_shell_team(
        dir: &str,
    ) -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<RwLock<Option<WorkspaceCell>>>,
    ) {
        use crate::routes::team_config::write_team_config;
        let (cfg, root, cell) = bound_empty_cell();
        let workspace = cell
            .read()
            .expect("cell lock")
            .as_ref()
            .expect("bound cell")
            .workspace
            .clone();
        let config: TeamConfig = toml::from_str(SHELL_TEAM_TOML).expect("valid shell team");
        write_team_config(&workspace, dir, &config, None).expect("write team");
        (cfg, root, cell)
    }

    #[tokio::test]
    async fn handle_team_load_spawns_the_saved_team() {
        // `cs terminal team load` brings the saved team UP, not just
        // summarizes it. The two shell members come live in the registry.
        let (_cfg, _root, cell) = bound_cell_with_shell_team("saved-team");
        let (_rroot, registry) = empty_registry();
        let registry = Arc::new(registry);
        let ctx = test_ctx(cell, ControlTenant::Workspace);
        let _events_rx = ctx.events_tx.subscribe();
        let _window = ctx.session_registry.join("win-load", true, None).guard;
        assert!(
            ctx.terminal_registry.set(registry.clone()).is_ok(),
            "fresh registry cell"
        );
        match handle_team(
            TeamRequest {
                dir: "saved-team".to_string(),
                op: TeamOp::Load,
                config_toml: None,
                brief_content: None,
                script: false,
                window_id: Some("win-load".to_string()),
                destination: None,
                tabs: false,
            },
            &ctx,
        )
        .await
        {
            ControlResponse::Ok { message } => {
                assert!(message.contains("spawned"), "load spawns: {message}");
                assert!(message.contains("2 member(s) up"), "{message}");
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
        assert_eq!(
            registry.session_summaries().len(),
            2,
            "both shell members are live after a load"
        );
        // Window binding applies to Load too: the loaded team's agents bind
        // to the caller's window.
        assert_eq!(
            registry.window_ids_matching(None, Some("shellsquad")),
            vec!["win-load".to_string()],
            "loaded agents bind to the caller window"
        );
    }

    #[tokio::test]
    async fn handle_team_load_without_registry_falls_back_to_a_summary() {
        // A server with terminals disabled has nothing to spawn into, so Load
        // still validates + summarizes instead of erroring.
        let (_cfg, _root, cell) = bound_cell_with_shell_team("saved-team");
        match handle_team(
            TeamRequest {
                dir: "saved-team".to_string(),
                op: TeamOp::Load,
                config_toml: None,
                brief_content: None,
                script: false,
                window_id: None,
                destination: None,
                tabs: false,
            },
            &test_ctx(cell, ControlTenant::Workspace),
        )
        .await
        {
            ControlResponse::Ok { message } => {
                assert!(
                    message.contains("no terminal registry to spawn into"),
                    "{message}"
                );
                assert!(message.contains("2 member(s)"), "{message}");
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn handle_team_new_grid_refuses_a_multi_pane_window_untouched() {
        // The single-pane precondition runs BEFORE the write and the spawn: a
        // refusal leaves no config.toml on disk and no PTY in the registry,
        // and the message names every way out.
        let (_cfg, root, cell) = bound_empty_cell();
        let (_rroot, registry) = empty_registry();
        let registry = Arc::new(registry);
        let ctx = test_ctx(cell, ControlTenant::Workspace);
        let mut events_rx = ctx.events_tx.subscribe();
        let _window = ctx.session_registry.join("win-grid", true, None).guard;
        assert!(
            ctx.terminal_registry.set(registry.clone()).is_ok(),
            "fresh registry cell"
        );
        let team = handle_team(
            TeamRequest {
                dir: "grid-team".to_string(),
                op: TeamOp::New,
                config_toml: Some(POSITIONED_TEAM_TOML.to_string()),
                brief_content: None,
                script: false,
                window_id: Some("win-grid".to_string()),
                destination: None,
                tabs: false,
            },
            &ctx,
        );
        let reply = answer_pane_query(&mut events_rx, &ctx.window_bus, "win-grid", 2);
        let (response, ()) = tokio::join!(team, reply);
        match response {
            ControlResponse::Error { message } => {
                assert!(message.contains("has 2 panes"), "{message}");
                assert!(message.contains("--tabs"), "{message}");
                assert!(message.contains("cs pane close-pane"), "{message}");
                assert!(message.contains("cs window new"), "{message}");
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
        assert!(
            registry.session_summaries().is_empty(),
            "a grid refusal must not spawn"
        );
        assert!(
            !root.path().join("grid-team").exists(),
            "a grid refusal must not write the team dir"
        );
    }

    #[tokio::test]
    async fn handle_team_new_grid_spawns_after_a_single_pane_check() {
        // One pane in the window: the precondition passes, the team comes up,
        // and the surfacing push carries each member's grid coordinate for
        // the SPA to carve by.
        let (_cfg, root, cell) = bound_empty_cell();
        let (_rroot, registry) = empty_registry();
        let registry = Arc::new(registry);
        let ctx = test_ctx(cell, ControlTenant::Workspace);
        let mut events_rx = ctx.events_tx.subscribe();
        let _window = ctx.session_registry.join("win-grid", true, None).guard;
        assert!(
            ctx.terminal_registry.set(registry.clone()).is_ok(),
            "fresh registry cell"
        );
        let team = handle_team(
            TeamRequest {
                dir: "grid-team".to_string(),
                op: TeamOp::New,
                config_toml: Some(POSITIONED_TEAM_TOML.to_string()),
                brief_content: None,
                script: false,
                window_id: Some("win-grid".to_string()),
                destination: None,
                tabs: false,
            },
            &ctx,
        );
        let reply = answer_pane_query(&mut events_rx, &ctx.window_bus, "win-grid", 1);
        let (response, ()) = tokio::join!(team, reply);
        match response {
            ControlResponse::Ok { message } => {
                assert!(message.contains("2 member(s) up"), "{message}")
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
        let frame: serde_json::Value =
            serde_json::from_str(&events_rx.try_recv().expect("team_spawned frame"))
                .expect("frame json");
        assert_eq!(frame["command"], "team_spawned");
        let members = frame["members"].as_array().expect("members array");
        assert_eq!(
            members[0]["position"],
            serde_json::json!({"row": 0, "col": 0})
        );
        assert_eq!(
            members[1]["position"],
            serde_json::json!({"row": 0, "col": 1})
        );
        assert!(
            root.path().join("grid-team/config.toml").exists(),
            "the passing path writes the team dir"
        );
    }

    #[tokio::test]
    async fn handle_team_new_tabs_skips_the_grid_check_and_strips_positions() {
        // `--tabs` opts out of the grid: no pane_query round-trip (the spawn
        // would deadlock on one here, since nothing answers the bus) and the
        // push carries no positions, so the SPA takes its stacking path.
        let (_cfg, _root, cell) = bound_empty_cell();
        let (_rroot, registry) = empty_registry();
        let registry = Arc::new(registry);
        let ctx = test_ctx(cell, ControlTenant::Workspace);
        let mut events_rx = ctx.events_tx.subscribe();
        let _window = ctx.session_registry.join("win-grid", true, None).guard;
        assert!(
            ctx.terminal_registry.set(registry.clone()).is_ok(),
            "fresh registry cell"
        );
        let response = handle_team(
            TeamRequest {
                dir: "grid-team".to_string(),
                op: TeamOp::New,
                config_toml: Some(POSITIONED_TEAM_TOML.to_string()),
                brief_content: None,
                script: false,
                window_id: Some("win-grid".to_string()),
                destination: None,
                tabs: true,
            },
            &ctx,
        )
        .await;
        assert!(
            matches!(response, ControlResponse::Ok { .. }),
            "unexpected response: {response:?}"
        );
        let frame: serde_json::Value =
            serde_json::from_str(&events_rx.try_recv().expect("team_spawned frame"))
                .expect("frame json");
        assert_eq!(frame["command"], "team_spawned", "no pane_query precedes");
        let members = frame["members"].as_array().expect("members array");
        assert!(
            members.iter().all(|m| m.get("position").is_none()),
            "--tabs strips positions: {members:?}"
        );
    }

    #[tokio::test]
    async fn handle_team_new_explicit_pane_skips_the_grid_check() {
        // `--pane` names the seed to carve, replacing the single-pane
        // precondition: no pane_query round-trip, and the push keeps both the
        // destination and the grid coordinates.
        let (_cfg, _root, cell) = bound_empty_cell();
        let (_rroot, registry) = empty_registry();
        let registry = Arc::new(registry);
        let ctx = test_ctx(cell, ControlTenant::Workspace);
        let mut events_rx = ctx.events_tx.subscribe();
        let _window = ctx.session_registry.join("win-grid", true, None).guard;
        assert!(
            ctx.terminal_registry.set(registry.clone()).is_ok(),
            "fresh registry cell"
        );
        let response = handle_team(
            TeamRequest {
                dir: "grid-team".to_string(),
                op: TeamOp::New,
                config_toml: Some(POSITIONED_TEAM_TOML.to_string()),
                brief_content: None,
                script: false,
                window_id: Some("win-grid".to_string()),
                destination: Some(TabDestination {
                    pane_id: Some("pane-7".into()),
                    side: None,
                }),
                tabs: false,
            },
            &ctx,
        )
        .await;
        assert!(
            matches!(response, ControlResponse::Ok { .. }),
            "unexpected response: {response:?}"
        );
        let frame: serde_json::Value =
            serde_json::from_str(&events_rx.try_recv().expect("team_spawned frame"))
                .expect("frame json");
        assert_eq!(frame["command"], "team_spawned", "no pane_query precedes");
        assert_eq!(frame["destination"]["pane_id"], "pane-7");
        let members = frame["members"].as_array().expect("members array");
        assert_eq!(
            members[0]["position"],
            serde_json::json!({"row": 0, "col": 0})
        );
    }

    #[tokio::test]
    async fn team_spawned_uses_the_settled_tab_name_on_a_live_collision() {
        // A second copy of a live team settles "@@Boss" to "@@Boss-2" in the
        // registry; the push must carry the settled name so the surfaced tab
        // title matches the PTY's $CHAN_TAB_NAME (what `cs terminal write
        // --tab-name` resolves).
        let (_root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let config: TeamConfig = toml::from_str(SHELL_TEAM_TOML).expect("valid shell team");
        let (events_tx, mut rx) = broadcast::channel::<String>(8);
        let (session_registry, _guard) = live_window("win-s1");
        for _ in 0..2 {
            spawn_and_poke_team(
                &registry,
                "new-team-1",
                &config,
                false,
                Some("win-s1"),
                None,
                &session_registry,
                &events_tx,
            )
            .await;
        }
        let first: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("first team_spawned")).expect("json");
        assert_eq!(first["members"][0]["tab_name"], "@@Boss");
        let second: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("second team_spawned")).expect("json");
        assert_eq!(second["group"], "shellsquad-2");
        assert_eq!(second["members"][0]["tab_name"], "@@Boss-2");
    }

    #[test]
    fn team_spawn_summary_counts_up_poked_and_failed() {
        let spawn = TeamSpawn {
            group: "alpha".into(),
            spawned: vec!["@@Lead".into(), "@@A".into()],
            failed: vec![("@@B".into(), "no such file".into())],
            pokes: vec![],
            members: vec![],
        };
        let poke_result = TeamPokeResult {
            poked: 1,
            failed: vec![],
        };
        match team_spawn_summary("alpha", &spawn, &poke_result) {
            ControlResponse::Ok { message } => {
                assert!(message.contains("2 member(s) up"), "{message}");
                assert!(message.contains("poked 1 agent(s)"), "{message}");
                assert!(
                    message.contains("1 failed: @@B (no such file)"),
                    "{message}"
                );
            }
            other => panic!("unexpected non-ok response: {other:?}"),
        }
    }

    #[test]
    fn team_spawn_summary_errors_when_nothing_came_up() {
        let spawn = TeamSpawn {
            group: "alpha".into(),
            spawned: vec![],
            failed: vec![("@@Lead".into(), "boom".into())],
            pokes: vec![],
            members: vec![],
        };
        match team_spawn_summary("alpha", &spawn, &TeamPokeResult::default()) {
            ControlResponse::Error { message } => {
                assert!(message.contains("no member could be spawned"), "{message}");
                assert!(message.contains("@@Lead (boom)"), "{message}");
            }
            other => panic!("unexpected non-error response: {other:?}"),
        }
    }

    fn tunnel_request(bind_addr: &str, proto: chan_revtunnel::Proto) -> TunnelRequest {
        TunnelRequest {
            window_id: "w-1".into(),
            proto,
            bind_addr: bind_addr.into(),
            desktop_port: 8080,
            devserver_port: 3000,
        }
    }

    #[test]
    fn udp_is_refused_rather_than_forwarded_as_tcp() {
        let error =
            tunnel_spec_from_request(&tunnel_request("127.0.0.1", chan_revtunnel::Proto::Udp))
                .unwrap_err();
        assert!(error.contains("not implemented"), "{error}");
        assert!(error.contains("udp"), "{error}");
    }

    #[test]
    fn the_server_revalidates_the_spec_it_is_handed() {
        // A client is not trusted to have validated anything: both fields the
        // parser guards are checked again here.
        let bad_addr =
            tunnel_spec_from_request(&tunnel_request("not-an-ip", chan_revtunnel::Proto::Tcp))
                .unwrap_err();
        assert!(bad_addr.contains("bind address"), "{bad_addr}");
        let mut zero_port = tunnel_request("127.0.0.1", chan_revtunnel::Proto::Tcp);
        zero_port.devserver_port = 0;
        let zero = tunnel_spec_from_request(&zero_port).unwrap_err();
        assert!(zero.contains("nothing to dial"), "{zero}");

        let spec = tunnel_spec_from_request(&tunnel_request("::1", chan_revtunnel::Proto::Tcp))
            .expect("valid spec");
        assert_eq!(
            spec.bind_addr,
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        );
        assert_eq!(spec.desktop_port, 8080);
        assert_eq!(spec.devserver_port, 3000);
    }

    /// A ctx whose unserve scope reaches `fake`, as a hosted tenant's does.
    fn tunnel_ctx(host: &Arc<dyn chan_library::HostControl>) -> ControlSocketCtx {
        let mut ctx = test_ctx(Arc::new(RwLock::new(None)), ControlTenant::Workspace);
        ctx.unserve = UnserveScope::Host(Arc::downgrade(host));
        ctx
    }

    /// Drive `handle_tunnel` over an in-memory connection. Dropping the
    /// returned client end is how a test plays `cs tunnel` exiting.
    fn spawn_tunnel(
        ctx: ControlSocketCtx,
        req: TunnelRequest,
    ) -> (JoinHandle<()>, tokio::io::DuplexStream) {
        let (client, server) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            handle_tunnel(read, &mut write, &ctx, req).await;
        });
        (task, client)
    }

    async fn read_response<R: tokio::io::AsyncBufRead + Unpin>(
        reader: &mut R,
    ) -> Option<ControlResponse> {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(serde_json::from_str(&line).expect("response json")),
        }
    }

    #[tokio::test]
    async fn a_hostless_server_says_where_tunnels_live() {
        // A standalone `chan open` owns no window a desktop could answer for.
        let ctx = test_ctx(Arc::new(RwLock::new(None)), ControlTenant::Workspace);
        let (task, mut client) =
            spawn_tunnel(ctx, tunnel_request("127.0.0.1", chan_revtunnel::Proto::Tcp));
        let mut reader = tokio::io::BufReader::new(&mut client);
        match read_response(&mut reader).await {
            Some(ControlResponse::Error { message }) => {
                assert!(message.contains("devserver or chan-desktop"), "{message}");
            }
            other => panic!("expected the no-host error, got {other:?}"),
        }
        task.await.expect("handler");
    }

    #[tokio::test]
    async fn a_ready_desktop_unblocks_the_command_and_a_dead_one_ends_it() {
        let fake = Arc::new(FakeHost::new(0));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        let ctx = tunnel_ctx(&host);
        // Stands in for the connected window that receives the trigger.
        let mut frames = ctx.events_tx.subscribe();
        let (task, mut client) =
            spawn_tunnel(ctx, tunnel_request("127.0.0.1", chan_revtunnel::Proto::Tcp));

        let frame: Value =
            serde_json::from_str(&frames.recv().await.expect("trigger frame")).expect("frame json");
        assert_eq!(frame["type"], "window_command");
        assert_eq!(frame["command"], "tunnel_open");
        assert_eq!(frame["window_id"], "w-1");
        assert_eq!(frame["proto"], "tcp");
        assert_eq!(frame["bind_addr"], "127.0.0.1");
        assert_eq!(frame["desktop_port"], 8080);
        assert_eq!(frame["devserver_port"], 3000);
        let tunnel_id = frame["tunnel_id"].as_str().expect("tunnel id").to_string();
        // The id is the only thing naming this tunnel on two public paths.
        assert!(tunnel_id.len() >= 32, "guessable tunnel id: {tunnel_id}");

        let attach = fake.tunnels.attach_control(&tunnel_id).expect("attach");
        assert!(attach.report(chan_revtunnel::server::ReadyReport::Ready {
            bound: "127.0.0.1:8080".into(),
        }));
        let mut reader = tokio::io::BufReader::new(&mut client);
        match read_response(&mut reader).await {
            Some(ControlResponse::Ok { message }) => {
                assert!(message.contains("desktop 127.0.0.1:8080"), "{message}");
                assert!(message.contains("devserver 127.0.0.1:3000"), "{message}");
                assert!(message.contains("(tcp)"), "{message}");
            }
            other => panic!("expected the ready acknowledgement, got {other:?}"),
        }

        // The desktop dies while the tunnel is up: a second line says so.
        drop(attach);
        match read_response(&mut reader).await {
            Some(ControlResponse::Error { message }) => {
                assert!(message.contains("desktop disconnected"), "{message}");
            }
            other => panic!("expected the desktop-gone line, got {other:?}"),
        }
        task.await.expect("handler");
        assert!(
            fake.tunnels.is_empty(),
            "the registration drop must deregister the tunnel"
        );
    }

    #[tokio::test]
    async fn a_client_that_exits_first_takes_its_tunnel_with_it() {
        let fake = Arc::new(FakeHost::new(0));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        let ctx = tunnel_ctx(&host);
        let mut frames = ctx.events_tx.subscribe();
        let (task, client) =
            spawn_tunnel(ctx, tunnel_request("127.0.0.1", chan_revtunnel::Proto::Tcp));
        frames.recv().await.expect("trigger frame");
        assert_eq!(fake.tunnels.len(), 1);

        // Ctrl-C before any desktop answered.
        drop(client);
        task.await.expect("handler");
        assert!(fake.tunnels.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn no_desktop_answer_fails_with_the_real_cause() {
        let fake = Arc::new(FakeHost::new(0));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        let ctx = tunnel_ctx(&host);
        // A browser-only viewer receives the trigger and never answers.
        let _frames = ctx.events_tx.subscribe();
        let (task, mut client) =
            spawn_tunnel(ctx, tunnel_request("127.0.0.1", chan_revtunnel::Proto::Tcp));
        let mut reader = tokio::io::BufReader::new(&mut client);
        match read_response(&mut reader).await {
            Some(ControlResponse::Error { message }) => {
                assert!(message.contains("chan-desktop"), "{message}");
                assert!(message.contains("w-1"), "{message}");
            }
            other => panic!("expected the timeout error, got {other:?}"),
        }
        task.await.expect("handler");
        assert!(fake.tunnels.is_empty());
    }

    #[tokio::test]
    async fn a_window_that_is_not_connected_is_named_as_the_failure() {
        // No `/ws` subscriber at all: the trigger would vanish silently, so
        // the command fails instead of blocking until the ready timeout.
        let fake = Arc::new(FakeHost::new(0));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        let (task, mut client) = spawn_tunnel(
            tunnel_ctx(&host),
            tunnel_request("127.0.0.1", chan_revtunnel::Proto::Tcp),
        );
        let mut reader = tokio::io::BufReader::new(&mut client);
        match read_response(&mut reader).await {
            Some(ControlResponse::Error { message }) => {
                assert!(message.contains("no chan window is connected"), "{message}");
            }
            other => panic!("expected the no-window error, got {other:?}"),
        }
        task.await.expect("handler");
        assert!(fake.tunnels.is_empty());
    }
}
