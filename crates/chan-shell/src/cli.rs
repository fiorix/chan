//! The `cs` client surface: the clap subcommand tree (`ShellAction` /
//! `TerminalAction`) and the dispatch that turns each action into a
//! control-socket round-trip. Lifted verbatim out of the `chan` binary so
//! `chan-desktop` can drive the same `cs` commands without the `chan`
//! binary on PATH.
//!
//! RISK: the clap derive here is wire-load-bearing. Every flag name,
//! `infer_subcommands`, and arg shape is part of the `cs` contract; a
//! drift breaks commands at runtime with a green build. Wire-smoke every
//! `cs` command after touching this file, not just `cargo build`.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine as _;
use chan_revtunnel::{Proto, TunnelSpec};
use chan_workspace::{
    WorkspaceReadiness, WorkspaceRelationshipKind, WorkspaceSearchDomain, WorkspaceSearchError,
    WorkspaceSearchRequest, WorkspaceSearchResult, WorkspaceSearchWarning, WorkspaceSelector,
    WorkspaceSelectorKind, WorkspaceTraversalDirection,
};
use clap::{Args, Parser, Subcommand};

use crate::help;

use crate::control::{
    absolutize, control_socket_env, open_env, open_env_from, send_control_request,
    send_control_request_streaming, OpenEnv,
};
use crate::submit::SubmitAgent;
use crate::wire::{
    ControlRequest, PaneOp, PaneSide, PastePrefer, SplitDir, SurveySpec, TabDestination, TeamOp,
    TermWriteSubmit, GRAPH_LINK_PREFIX, MAX_CLIPBOARD_BYTES, MAX_TERMINAL_WRITE_BYTES,
};

/// What `cs` is and what it needs to work. Consts rather than doc
/// comments because clap collapses a doc comment's paragraphs onto one
/// line, which would flatten the tables below.
const CS_LONG_ABOUT: &str = "\
Drive the current chan window from its terminal.

`cs` is the chan binary under a second name, picked by argv[0], so `cs
open x.md` and `chan shell open x.md` are the same command. Every action
targets the window that spawned this terminal, discovered from the
environment; run outside a chan terminal, each one errors clearly instead
of guessing.

Actions disambiguate on their first letters, iproute2 style, so `cs o`,
`cs te l`, and `cs sea` resolve to open, terminal list, and search. The
prefix has to be unambiguous: `se` matches both search and session, and
`t` matches both terminal and tunnel, so each is rejected rather than
guessed.";

/// The environment contract and the MCP bridge. This is the page an agent
/// reads to work out where it is running and what it may call.
const CS_AFTER_HELP: &str = r#"THE ENVIRONMENT CONTRACT:
Every chan-spawned terminal carries these. Read them; do not set them.

  CHAN                  1 inside any chan terminal. The detection flag.
  CHAN_CONTROL_SOCKET   the serving chan-server's control socket. Every
                        `cs` command needs it.
  CHAN_WINDOW_ID        the window to act on. Window-targeting commands
                        use it by default; tab openers and pane commands
                        can override it with --window.
  CHAN_TAB_NAME         this tab's name, when it has one. A team member
                        finds its own handle here.
  CHAN_TAB_GROUP        this tab's broadcast group. Always set; the
                        default group is literally "default".
  CHAN_WORKSPACE_PATH   the served workspace root, or $HOME when there
                        is no workspace.
  CHAN_WORKSPACE_NAME   that path's basename.

WORKSPACE ONLY:
`open`, `graph`, `search`, `export`, every `session` action, `terminal
team` (including `--script`), and `terminal new` with a path need a
workspace behind the window. In a standalone terminal they refuse and say
so. Nothing else here does: `terminal`, `pane`, `copy`, `paste`, `upload`,
`download`, and `tunnel` all work in a plain terminal window.

No environment variable distinguishes the two. That refusal IS the check.
`window new|open|rm|hide` and `tunnel` additionally need the desktop app.

EXAMPLES:
Confirm you are in a chan terminal, and find out which one:
  test -n "$CHAN" && echo "in chan: $CHAN_TAB_NAME @ $CHAN_WORKSPACE_NAME"

Find out whether this window has a workspace:
  cs search --limit 1 x >/dev/null 2>&1 \
    && echo workspace || echo "standalone terminal"

Open a file, create a pane, and place a named terminal exactly:
  cs open notes/plan.md
  right=$(cs pane new right)
  cs terminal new --pane "$right" --side a --tab-name @@Builder

THE MCP BRIDGE:
chan exposes an in-process MCP server so an external agent can edit
through the workspace's gates instead of touching files directly. When it
is enabled for a terminal, that terminal also carries:

  CHAN_MCP_SERVER_JSON   the canonical descriptor, name plus argv
  CHAN_MCP_COMMAND_JSON  the argv alone, as JSON
  CHAN_MCP_COMMAND       the same argv as one shell string
  CHAN_MCP_SOCKET        the bridge socket
  CHAN_MCP_SERVER_NAME   always "chan"

These are OFF by default, for every agent: a stray env descriptor stops
codex from starting, because it wants a file-based config. Turn them on
for a whole team with `cs terminal team new --mcp-env on`, or in the team
setup dialog. Translate the descriptor into whatever shape your agent
wants; chan does not write agent-owned config files.

You do not need MCP to be useful here. `cs search`, `cs open`, and the
rest of this surface work with the descriptor absent.

SEE ALSO:
`chan dump-skill --topic overview` for the two modes, `--topic teams` for
running a team, and `--topic graph` for the project graph.
"#;

/// Top-level `cs` parser: the one argv shape behind every `cs` front end.
/// `chan-desktop` parses `cs` argv directly through [`run_cs`]; the `chan`
/// binary's `parse_cli` routes its `cs -> chan` symlink alias through
/// [`parse_cs`] and dispatches the action exactly as `chan shell <action>`
/// does. One parse means one help rendering, so usage lines read
/// `cs <cmd>` (never `cs shell <cmd>`) under both front ends.
/// `infer_subcommands` mirrors the `chan shell` command so `cs te l` /
/// `cs o` resolve the same way everywhere.
#[derive(Parser, Debug)]
#[command(name = "cs", about = "Drive the current chan window from its terminal")]
#[command(long_about = CS_LONG_ABOUT)]
#[command(after_long_help = CS_AFTER_HELP)]
#[command(infer_subcommands = true)]
pub struct CsCli {
    /// Increase logging. -v = info, -vv = debug, -vvv = trace.
    // Parsed here so every front end accepts the same argv (the flag
    // mirrors the `chan` CLI's global `-v`). The `chan` front end wires
    // the count into its tracing init; chan-desktop's [`run_cs`] runs
    // without a subscriber, so there the count is inert.
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,

    #[command(subcommand)]
    pub action: ShellAction,
}

/// Optional coordinates for a command that surfaces a tab. The target window
/// defaults to `$CHAN_WINDOW_ID`; pane and side stay omitted so the SPA resolves
/// its active pane and visible side at dequeue time.
#[derive(Args, Debug, Clone, Default)]
pub struct TabDestinationArgs {
    /// Target window id (default: $CHAN_WINDOW_ID).
    #[arg(long, value_name = "WINDOW_ID")]
    window: Option<String>,
    /// Target pane id (default: the target window's active pane).
    #[arg(long, value_name = "PANE_ID")]
    pane: Option<String>,
    /// Target Hybrid side (default: the target pane's visible side).
    #[arg(long, value_name = "SIDE")]
    side: Option<PaneSide>,
}

impl TabDestinationArgs {
    fn target_env(&self) -> Result<OpenEnv> {
        open_env_from(
            self.window
                .clone()
                .or_else(|| std::env::var("CHAN_WINDOW_ID").ok()),
            std::env::var("CHAN_CONTROL_SOCKET").ok(),
        )
    }

    fn destination(&self) -> Option<TabDestination> {
        if self.pane.is_none() && self.side.is_none() {
            None
        } else {
            Some(TabDestination {
                pane_id: self.pane.clone(),
                side: self.side,
            })
        }
    }
}

/// Search and traversal flags shared by `cs search` and `chan workspace`.
#[derive(Args, Debug, Clone, Default)]
pub struct WorkspaceSearchArgs {
    /// Query text. Words are joined with spaces; omit for exact selectors or
    /// query-free entity browsing.
    #[arg(value_name = "QUERY", num_args = 0.., verbatim_doc_comment)]
    pub query: Vec<String>,
    /// Exact typed traversal seed (`file:notes/a.md`, `tag:design`, ...).
    #[arg(long = "from", value_name = "TYPE:VALUE")]
    pub from: Vec<String>,
    /// Lexical search or browse domain.
    #[arg(long = "domain", value_name = "DOMAIN")]
    pub domains: Vec<String>,
    /// Traversal depth. Omitted means 1 for exact seeds and 0 otherwise.
    #[arg(long)]
    pub depth: Option<u8>,
    /// Traversal direction: auto, out, in, or both.
    #[arg(long, value_name = "DIRECTION")]
    pub direction: Option<String>,
    /// Relationship kind to retain: link, tag, mention, language, contains.
    #[arg(long = "edge-kind", value_name = "KIND")]
    pub edge_kinds: Vec<String>,
    /// Independent content-hit and entity-match limit.
    #[arg(long)]
    pub limit: Option<u32>,
    /// Graph node limit.
    #[arg(long)]
    pub node_limit: Option<u32>,
    /// Graph relationship limit.
    #[arg(long)]
    pub edge_limit: Option<u32>,
}

impl WorkspaceSearchArgs {
    pub fn to_request(&self) -> Result<WorkspaceSearchRequest> {
        let query = self.query.join(" ").trim().to_string();
        let query = (!query.is_empty()).then_some(query);
        let from = self
            .from
            .iter()
            .map(|value| parse_workspace_selector(value))
            .collect::<Result<Vec<_>>>()?;
        let domains = self
            .domains
            .iter()
            .map(|value| parse_search_domain(value))
            .collect::<Result<Vec<_>>>()?;
        let direction = self
            .direction
            .as_deref()
            .map(parse_traversal_direction)
            .transpose()?
            .unwrap_or_default();
        let relationship_kinds = self
            .edge_kinds
            .iter()
            .map(|value| parse_relationship_kind(value))
            .collect::<Result<Vec<_>>>()?;
        let browse = domains
            .iter()
            .any(|domain| *domain != WorkspaceSearchDomain::Content);
        anyhow::ensure!(
            query.is_some() || !from.is_empty() || browse,
            "workspace search requires QUERY, --from, or a non-content --domain"
        );
        Ok(WorkspaceSearchRequest {
            query,
            from,
            domains,
            depth: self.depth,
            direction,
            relationship_kinds,
            limit: self.limit,
            node_limit: self.node_limit,
            edge_limit: self.edge_limit,
        })
    }
}

fn parse_workspace_selector(value: &str) -> Result<WorkspaceSelector> {
    let Some((kind, value)) = value.split_once(':') else {
        anyhow::bail!("invalid --from {value:?}; expected TYPE:VALUE");
    };
    anyhow::ensure!(!value.is_empty(), "invalid --from {kind}:; value is empty");
    let kind = match kind {
        "file" => WorkspaceSelectorKind::File,
        "directory" => WorkspaceSelectorKind::Directory,
        "tag" => WorkspaceSelectorKind::Tag,
        "mention" => WorkspaceSelectorKind::Mention,
        "contact" => WorkspaceSelectorKind::Contact,
        "language" => WorkspaceSelectorKind::Language,
        _ => anyhow::bail!(
            "invalid selector type {kind:?}; expected file, directory, tag, mention, contact, or language"
        ),
    };
    Ok(WorkspaceSelector {
        kind,
        value: value.to_string(),
    })
}

fn parse_search_domain(value: &str) -> Result<WorkspaceSearchDomain> {
    match value {
        "content" => Ok(WorkspaceSearchDomain::Content),
        "file" => Ok(WorkspaceSearchDomain::File),
        "directory" => Ok(WorkspaceSearchDomain::Directory),
        "tag" => Ok(WorkspaceSearchDomain::Tag),
        "mention" => Ok(WorkspaceSearchDomain::Mention),
        "contact" => Ok(WorkspaceSearchDomain::Contact),
        "language" => Ok(WorkspaceSearchDomain::Language),
        _ => anyhow::bail!(
            "invalid domain {value:?}; expected content, file, directory, tag, mention, contact, or language"
        ),
    }
}

fn parse_traversal_direction(value: &str) -> Result<WorkspaceTraversalDirection> {
    match value {
        "auto" => Ok(WorkspaceTraversalDirection::Auto),
        "out" => Ok(WorkspaceTraversalDirection::Out),
        "in" => Ok(WorkspaceTraversalDirection::In),
        "both" => Ok(WorkspaceTraversalDirection::Both),
        _ => anyhow::bail!("invalid direction {value:?}; expected auto, out, in, or both"),
    }
}

fn parse_relationship_kind(value: &str) -> Result<WorkspaceRelationshipKind> {
    match value {
        "link" => Ok(WorkspaceRelationshipKind::Link),
        "tag" => Ok(WorkspaceRelationshipKind::Tag),
        "mention" => Ok(WorkspaceRelationshipKind::Mention),
        "language" => Ok(WorkspaceRelationshipKind::Language),
        "contains" => Ok(WorkspaceRelationshipKind::Contains),
        _ => anyhow::bail!(
            "invalid edge kind {value:?}; expected link, tag, mention, language, or contains"
        ),
    }
}

/// Parse a full `cs` argv (`argv[0]` included) into its [`CsCli`] shape
/// without dispatching. The `chan` binary's cs-symlink path uses this to
/// share the one `cs` parse (and its `cs <cmd>` help rendering) while
/// keeping dispatch and tracing init on its own side. clap prints help /
/// usage and exits the process on a parse error or `--help`.
pub fn parse_cs<I>(args: I) -> CsCli
where
    I: IntoIterator,
    I::Item: Into<std::ffi::OsString> + Clone,
{
    CsCli::parse_from(args)
}

/// Parse a full `cs` argv (`argv[0]` included) and dispatch it. The entry
/// `chan-desktop` calls when invoked through a `cs` name, so desktop users
/// get the `cs` client without a `chan` binary on PATH. Parses through
/// [`parse_cs`], the same parse the `chan` binary's cs path uses.
pub async fn run_cs<I>(args: I) -> Result<()>
where
    I: IntoIterator,
    I::Item: Into<std::ffi::OsString> + Clone,
{
    dispatch(parse_cs(args).action).await
}

#[derive(Subcommand, Debug)]
pub enum ShellAction {
    /// Open a path, a directory, or a chan://graph link in this window
    #[command(long_about = help::CS_OPEN)]
    #[command(after_long_help = help::CS_OPEN_AFTER)]
    Open {
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: Option<String>,
        #[command(flatten)]
        destination: TabDestinationArgs,
    },
    /// Open the workspace graph, focused on an optional path
    #[command(long_about = help::CS_GRAPH)]
    #[command(after_long_help = help::CS_GRAPH_AFTER)]
    Graph {
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: Option<PathBuf>,
        #[command(flatten)]
        destination: TabDestinationArgs,
    },
    /// Open a Dashboard tab in the current window
    #[command(long_about = help::CS_DASHBOARD)]
    #[command(after_long_help = help::CS_DASHBOARD_AFTER)]
    Dashboard {
        /// Initial carousel slide index (0-based). Out-of-range values
        /// land on the default slide.
        #[arg(long = "carousel-index", verbatim_doc_comment)]
        carousel_index: Option<u32>,
        /// Open with carousel auto-rotation OFF (the new tab's
        /// `autoRotate` is false). Default leaves rotation on. Spelled
        /// one-r to match `--carousel-index`.
        #[arg(long = "carousel-off", verbatim_doc_comment)]
        carousel_off: bool,
        #[command(flatten)]
        destination: TabDestinationArgs,
    },
    /// Raise this window's upload picker, targeting a directory
    #[command(long_about = help::CS_UPLOAD)]
    #[command(after_long_help = help::CS_UPLOAD_AFTER)]
    Upload {
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: PathBuf,
    },
    /// Download a file or directory through this window
    #[command(long_about = help::CS_DOWNLOAD)]
    #[command(after_long_help = help::CS_DOWNLOAD_AFTER)]
    Download {
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: PathBuf,
    },
    /// Forward a port of the desktop machine back to this host
    #[command(long_about = help::CS_TUNNEL)]
    #[command(after_long_help = help::CS_TUNNEL_AFTER)]
    Tunnel {
        /// Transport to forward: tcp, or udp (not implemented yet).
        #[arg(long, value_name = "PROTO", default_value = "tcp")]
        #[arg(value_parser = parse_tunnel_proto)]
        proto: Proto,
        /// [bind-address:]desktop-port:devserver-port, or one port for both
        /// ends, e.g. 8080:3000 or 3000.
        #[arg(value_name = "SPEC", value_parser = parse_tunnel_spec_arg)]
        spec: TunnelSpec,
    },
    /// Copy stdin onto the clipboard of the machine viewing this window
    #[command(long_about = help::CS_COPY)]
    #[command(after_long_help = help::CS_COPY_AFTER)]
    Copy {
        /// Force the clipboard MIME instead of sniffing stdin
        /// (e.g. `text/html`, `image/png`).
        #[arg(long, verbatim_doc_comment)]
        mime: Option<String>,
        /// Treat stdin as HTML (shorthand for `--mime text/html`). Use for an
        /// HTML fragment that would not sniff as a full document.
        #[arg(long, conflicts_with = "mime", verbatim_doc_comment)]
        html: bool,
    },
    /// Write this window's clipboard to stdout as raw bytes
    #[command(long_about = help::CS_PASTE)]
    #[command(after_long_help = help::CS_PASTE_AFTER)]
    Paste {
        /// Emit the plain-text representation only.
        #[arg(long, conflicts_with_all = ["html", "image"])]
        text: bool,
        /// Emit the HTML (rich text) representation.
        #[arg(long, conflicts_with_all = ["text", "image"])]
        html: bool,
        /// Emit the image representation (PNG).
        #[arg(long, conflicts_with_all = ["text", "html"])]
        image: bool,
    },
    /// Drive live terminal tabs: new, write, list, restart, close, read
    #[command(infer_subcommands = true)]
    #[command(long_about = help::CS_TERMINAL)]
    #[command(after_long_help = help::CS_TERMINAL_AFTER)]
    Terminal {
        #[command(subcommand)]
        action: TerminalAction,
    },
    /// Render a workspace file to PDF through an open workspace window
    #[command(long_about = help::CS_EXPORT)]
    #[command(after_long_help = help::CS_EXPORT_AFTER)]
    Export {
        /// Workspace-relative source path (e.g. notes/doc.md).
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: String,
        /// Output format. `pdf` is the only registered format today.
        #[arg(long, default_value = "pdf")]
        format: String,
        /// Workspace-relative output path. Defaults to the source with its
        /// extension swapped for the format (notes/doc.md -> notes/doc.pdf).
        #[arg(long, verbatim_doc_comment)]
        out: Option<String>,
    },
    /// Search, browse and traverse this terminal's workspace
    #[command(long_about = help::CS_SEARCH)]
    #[command(after_long_help = help::CS_SEARCH_AFTER)]
    Search {
        #[command(flatten)]
        search: WorkspaceSearchArgs,
        /// Emit the unchanged core JSON result. Compact by default.
        #[arg(long)]
        json: bool,
        /// With --json, pretty-print (indent) the JSON. Ignored without
        /// --json.
        #[arg(long, verbatim_doc_comment)]
        pretty: bool,
    },
    /// List chan's windows and open, hide or remove them
    #[command(infer_subcommands = true)]
    #[command(long_about = help::CS_WINDOW)]
    #[command(after_long_help = help::CS_WINDOW_AFTER)]
    Window {
        #[command(subcommand)]
        action: WindowAction,
    },
    /// Manage the workspace session's leader and followers
    #[command(infer_subcommands = true)]
    #[command(long_about = help::CS_SESSION)]
    #[command(after_long_help = help::CS_SESSION_AFTER)]
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// Inspect or drive a window's tab/pane layout
    #[command(infer_subcommands = true)]
    #[command(long_about = help::CS_PANE)]
    #[command(after_long_help = help::CS_PANE_AFTER)]
    Pane {
        /// Target the window owning this tab, instead of the caller's own
        /// window. Lets `cs pane` run without a $CHAN_WINDOW_ID.
        #[arg(long = "tab-name", global = true, verbatim_doc_comment)]
        #[arg(conflicts_with = "window")]
        tab_name: Option<String>,
        /// Target a window directly instead of using $CHAN_WINDOW_ID.
        #[arg(long, global = true, value_name = "WINDOW_ID")]
        window: Option<String>,
        /// Emit JSON instead of the markdown rendering (layout or exec
        /// result). Compact by default.
        #[arg(long, global = true, verbatim_doc_comment)]
        json: bool,
        /// Indent the JSON output. Only meaningful with `--json`.
        #[arg(long, global = true)]
        pretty: bool,
        /// A layout mutation. Omit for the read-only layout report.
        #[command(subcommand)]
        action: Option<PaneAction>,
    },
}

/// `cs window <action>`: read the window registry and drive the
/// desktop's OS windows. The lifecycle verbs (`new`/`open`/`rm`/`hide`)
/// need the chan desktop app; a standalone `chan open` refuses
/// them. `new` derives its kind from the calling tenant; the id-bearing
/// verbs act on any window by id. Titles are library-owned and
/// auto-derived; there is no rename verb.
#[derive(Subcommand, Debug)]
pub enum WindowAction {
    /// List the windows chan knows about
    ///
    /// Covers connected windows and ones with only a saved layout.
    /// Markdown by default; `--json [--pretty]` for machine output.
    #[command(verbatim_doc_comment)]
    List {
        /// Emit the raw JSON rows instead of the markdown table.
        /// Compact by default.
        #[arg(long, verbatim_doc_comment)]
        json: bool,
        /// With --json, pretty-print (indent) the JSON. Ignored
        /// without --json.
        #[arg(long, verbatim_doc_comment)]
        pretty: bool,
    },
    /// Open a new window, and print its id
    ///
    /// From a standalone terminal this spawns another terminal window;
    /// from a workspace it spawns another window of that workspace.
    #[command(verbatim_doc_comment)]
    New,
    /// Focus a window by id, un-hiding it if hidden
    ///
    /// Best-effort reopens a closed-but-saved workspace window when its
    /// workspace is still running.
    #[command(verbatim_doc_comment)]
    Open {
        /// The window id (see `cs window list`).
        id: String,
    },
    /// Destroy a window by id and delete its saved layout
    ///
    /// Unlike the close button, which only hides. Prompts before killing a
    /// window with live terminals; `--force` skips the prompt.
    #[command(verbatim_doc_comment)]
    Rm {
        /// The window id (see `cs window list`).
        id: String,
        /// Destroy even with live terminal shells, without prompting.
        #[arg(long)]
        force: bool,
    },
    /// Hide a window by id, keeping it reopenable
    ///
    /// The OS close-button behavior: terminals and layout stay warm.
    #[command(verbatim_doc_comment)]
    Hide {
        /// The window id (see `cs window list`).
        id: String,
    },
}

/// `cs session <action>`: manage the session's leader and followers over the
/// control socket. `list` is socket-only; `self`/`handover`/`takeover` carry
/// the caller's own window id ($CHAN_WINDOW_ID) so the server knows which
/// participant is acting.
#[derive(Subcommand, Debug)]
pub enum SessionAction {
    /// List session participants, the leader, and status
    ///
    /// Markdown by default; `--json [--pretty]` for machine output.
    #[command(verbatim_doc_comment)]
    List {
        /// Emit the raw JSON rows instead of the markdown table.
        #[arg(long)]
        json: bool,
        /// With --json, pretty-print (indent) the JSON. Ignored without --json.
        #[arg(long)]
        pretty: bool,
    },
    /// Show, rename, or reset who you are in this session
    ///
    /// Bare, it reports your window, name, role, status, leadership, and
    /// gateway identity. `--name` renames you; `--reset` returns you to
    /// your default name. Markdown by default; `--json [--pretty]` for
    /// machine output.
    #[command(verbatim_doc_comment)]
    #[command(name = "self")]
    SelfCmd {
        /// The new display name for this client.
        #[arg(long, conflicts_with = "reset")]
        name: Option<String>,
        /// Clear your explicit name: fall back to your gateway identity or
        /// your generated default name.
        #[arg(long, verbatim_doc_comment)]
        reset: bool,
        /// Emit the raw JSON record instead of the markdown rendering.
        /// Query form only.
        #[arg(long, conflicts_with_all = ["name", "reset"], verbatim_doc_comment)]
        json: bool,
        /// With --json, pretty-print (indent) the JSON. Ignored without --json.
        #[arg(long)]
        pretty: bool,
    },
    /// Request a leader handover, or answer a pending one
    ///
    /// Accept or reject only when you are the leader.
    #[command(verbatim_doc_comment)]
    Handover {
        /// Window id to hand leadership to (default: you).
        #[arg(long)]
        to: Option<String>,
        /// Accept a pending handover request (leader only).
        #[arg(long)]
        accept: bool,
        /// Reject a pending handover request (leader only).
        #[arg(long)]
        reject: bool,
        /// Seconds to wait for the leader's answer.
        #[arg(long, default_value_t = 30)]
        timeout: u64,
    },
    /// Take over as leader (only when the leader is gone, unless --force).
    Takeover {
        /// Seize leadership even from a live leader.
        #[arg(long)]
        force: bool,
    },
}

/// `cs pane <action>`: the layout mutations, executed on the target window's
/// live SPA `layout`. Each maps 1:1 to a [`PaneOp`] sent in a
/// [`ControlRequest::PaneExec`].
#[derive(Subcommand, Debug)]
pub enum PaneAction {
    /// List every pane and both of its Hybrid sides.
    List,
    /// Focus (activate) a pane by id.
    Focus {
        /// The pane id to focus (from `cs pane list`).
        pane_id: String,
        /// Select side A or B while focusing.
        #[arg(long)]
        side: Option<PaneSide>,
    },
    /// Create a pane to the right or below another pane.
    New {
        /// Where the new pane goes: `right` or `bottom`.
        dir: SplitDirArg,
        /// The pane to split (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
    },
    /// Compatibility alias for `cs pane new`.
    #[command(hide = true)]
    Split {
        /// Where the new pane goes: `right` or `bottom`.
        dir: SplitDirArg,
        /// The pane to split (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
    },
    /// Resize a pane's enclosing split by a ratio delta
    ///
    /// A positive delta grows the pane, so `0.1` and `-0.1` move the
    /// split in opposite directions. No-ops on the sole pane.
    #[command(verbatim_doc_comment)]
    // allow_negative_numbers so a bare `-0.1` is the delta value, not parsed
    // as an (unknown) `-0` flag.
    #[command(allow_negative_numbers = true)]
    Resize {
        /// Ratio delta in -1.0..1.0.
        delta: f64,
        /// The pane to resize (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
    },
    /// Equalize a pane's nearest enclosing split.
    Equalize {
        /// The pane to equalize (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
    },
    /// Swap complete Hybrid contents with another pane.
    Swap {
        /// The other pane id.
        other_pane_id: String,
        /// The source pane (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
    },
    /// Close a pane (the active pane by default).
    Close {
        /// The pane id to close (default: the active pane).
        pane_id: Option<String>,
        /// Close past dirty files / live terminals.
        #[arg(long)]
        force: bool,
    },
    /// Close one tab (the pane's active tab by default).
    CloseTab {
        /// The pane to close a tab in (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
        /// The tab id to close (default: the pane's active tab).
        #[arg(long = "tab")]
        tab: Option<String>,
        /// Close past a dirty file / live terminal.
        #[arg(long)]
        force: bool,
    },
    /// Close a whole pane (the active one by default).
    #[command(hide = true)]
    ClosePane {
        /// The pane id to close (default: the active pane).
        #[arg(long = "pane")]
        pane: Option<String>,
        /// Close past dirty files / live terminals.
        #[arg(long)]
        force: bool,
    },
    /// Close every tab in every pane.
    CloseAll {
        /// Close past dirty files / live terminals.
        #[arg(long)]
        force: bool,
    },
}

/// `right` | `bottom` for canonical `cs pane new` and its compatibility
/// `split` alias, mapped to the wire [`SplitDir`].
#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum SplitDirArg {
    Right,
    Bottom,
}

impl From<SplitDirArg> for SplitDir {
    fn from(dir: SplitDirArg) -> Self {
        match dir {
            SplitDirArg::Right => SplitDir::Right,
            SplitDirArg::Bottom => SplitDir::Bottom,
        }
    }
}

/// `--mcp-env on|off` for `cs terminal team new`: whether the team's terminals
/// get the chan MCP env vars (sets `TeamConfig.mcp_env`). Omitting the flag
/// leaves the field at its config / serde default (OFF).
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
#[value(rename_all = "lower")]
pub enum McpEnvToggle {
    On,
    Off,
}

impl McpEnvToggle {
    fn as_bool(self) -> bool {
        matches!(self, McpEnvToggle::On)
    }
}

impl PaneAction {
    /// Convert the parsed subcommand into the wire [`PaneOp`].
    fn into_op(self) -> PaneOp {
        match self {
            PaneAction::List => unreachable!("pane list is a query, not an exec"),
            PaneAction::Focus { pane_id, side } => PaneOp::Focus { pane_id, side },
            PaneAction::New { dir, pane } | PaneAction::Split { dir, pane } => PaneOp::Split {
                pane_id: pane,
                dir: dir.into(),
            },
            PaneAction::Resize { delta, pane } => PaneOp::Resize {
                pane_id: pane,
                delta,
            },
            PaneAction::Equalize { pane } => PaneOp::Equalize { pane_id: pane },
            PaneAction::Swap {
                other_pane_id,
                pane,
            } => PaneOp::Swap {
                pane_id: pane,
                other_pane_id,
            },
            PaneAction::Close { pane_id, force } => PaneOp::ClosePane { pane_id, force },
            PaneAction::CloseTab { pane, tab, force } => PaneOp::CloseTab {
                pane_id: pane,
                tab_id: tab,
                force,
            },
            PaneAction::ClosePane { pane, force } => PaneOp::ClosePane {
                pane_id: pane,
                force,
            },
            PaneAction::CloseAll { force } => PaneOp::CloseAll { force },
        }
    }
}

#[derive(Subcommand, Debug)]
pub enum TerminalAction {
    /// Open a new terminal tab in the calling window
    #[command(long_about = help::CS_TERMINAL_NEW)]
    #[command(after_long_help = help::CS_TERMINAL_NEW_AFTER)]
    New {
        /// Working directory for the new terminal (workspace-relative or
        /// absolute under the workspace root). Defaults to the workspace
        /// root.
        #[arg(value_hint = clap::ValueHint::AnyPath, verbatim_doc_comment)]
        path: Option<PathBuf>,
        /// Tab name ($CHAN_TAB_NAME inside the new terminal).
        #[arg(long = "tab-name")]
        tab_name: Option<String>,
        /// Broadcast group ($CHAN_TAB_GROUP). Defaults to "default".
        #[arg(long = "tab-group")]
        tab_group: Option<String>,
        #[command(flatten)]
        destination: TabDestinationArgs,
    },
    /// Queue up to 4096 bytes: raw verbatim, or newline plus agent chord
    #[command(long_about = help::CS_TERMINAL_WRITE)]
    #[command(after_long_help = help::CS_TERMINAL_WRITE_AFTER)]
    Write {
        /// Literal UTF-8 text to write, up to 4096 bytes. Omit with
        /// --stdin to read it instead.
        cmd: Option<String>,
        /// Read up to 4096 UTF-8 bytes from this process's stdin instead of
        /// `cmd`; refuse larger input rather than truncating it.
        #[arg(long)]
        stdin: bool,
        /// Submit the input into each target hands-free (the completion-poke
        /// path). The SERVER picks the actual submit encoding: it derives
        /// every matched session's agent from that session's own spawn
        /// command and CHAN_AGENT, so the value here only says what you
        /// believed the target runs; a mismatch is corrected server-side and
        /// noted in the ack, and a shell target gets plain text with no
        /// chord, keeps the raw bytes untouched, and makes the command exit
        /// 69. A non-empty agent body is normalized to exactly one trailing
        /// newline before its chord; an empty body stays chord-only. Spawn
        /// such a session with CHAN_AGENT set or the agent as its command
        /// instead of typing the agent into a shell. Values: claude | codex
        /// | gemini | kimi | opencode.
        /// Omit the flag to write pure bytes: the input parks in the agent's
        /// compose box unsubmitted (a bare newline is a newline to an agent,
        /// not a submit).
        #[arg(long, value_name = "AGENT", verbatim_doc_comment)]
        submit: Option<SubmitAgent>,
        /// Target every session with this tab name.
        #[arg(long = "tab-name")]
        tab_name: Option<String>,
        /// Target every session in this group (broadcast).
        #[arg(long = "tab-group")]
        tab_group: Option<String>,
    },
    /// List live terminal sessions, grouped, as markdown or JSON
    #[command(long_about = help::CS_TERMINAL_LIST)]
    #[command(after_long_help = help::CS_TERMINAL_LIST_AFTER)]
    List {
        /// Emit machine-readable JSON instead of the markdown table.
        #[arg(long)]
        json: bool,
        /// Indent the JSON output. Only meaningful with `--json`.
        #[arg(long)]
        pretty: bool,
    },
    /// Restart live terminal tabs, preserving command and environment
    #[command(long_about = help::CS_TERMINAL_RESTART)]
    #[command(after_long_help = help::CS_TERMINAL_RESTART_AFTER)]
    Restart {
        /// Restart every session with this tab name.
        #[arg(long = "tab-name")]
        tab_name: Option<String>,
        /// Restart every session in this group.
        #[arg(long = "tab-group")]
        tab_group: Option<String>,
    },
    /// Close live terminal tabs, freeing their tab names
    #[command(long_about = help::CS_TERMINAL_CLOSE)]
    #[command(after_long_help = help::CS_TERMINAL_CLOSE_AFTER)]
    Close {
        /// Close every session with this tab name.
        #[arg(long = "tab-name")]
        tab_name: Option<String>,
        /// Close every session in this group.
        #[arg(long = "tab-group")]
        tab_group: Option<String>,
    },
    /// Dump one terminal tab's scrollback to stdout
    #[command(long_about = help::CS_TERMINAL_SCROLLBACK)]
    #[command(after_long_help = help::CS_TERMINAL_SCROLLBACK_AFTER)]
    Scrollback {
        /// Tab name of the session to read. Required; must match exactly
        /// one live session.
        #[arg(long = "tab-name", verbatim_doc_comment)]
        tab_name: String,
    },
    /// Ask the host a question and block until they answer
    #[command(long_about = help::CS_TERMINAL_SURVEY)]
    #[command(after_long_help = help::CS_TERMINAL_SURVEY_AFTER)]
    Survey {
        /// Raise the survey on the window owning this tab name.
        #[arg(long = "tab-name")]
        tab_name: Option<String>,
        /// Raise the survey on every window owning a tab in this group.
        #[arg(long = "tab-group")]
        tab_group: Option<String>,
        /// Optional heading shown above the body.
        #[arg(long)]
        title: Option<String>,
        /// An answer option (1..=4). Repeat for each: `--option A
        /// --option B`. The UI numbers them `[1]`..`[4]`.
        #[arg(long = "option", value_name = "LABEL", verbatim_doc_comment)]
        option: Vec<String>,
        /// Seconds to wait for the host's reply before giving up. On elapse the
        /// survey returns no answer, prints `no reply within <secs>s` to
        /// stderr, and exits 124 (the GNU `timeout` convention), so a caller
        /// can tell a timed-out survey from an answered or dismissed one.
        #[arg(long, value_name = "SECS", default_value_t = crate::wire::DEFAULT_SURVEY_TIMEOUT_SECS, verbatim_doc_comment)]
        timeout: u64,
        /// Read the markdown problem body from this process's stdin
        /// instead of the positional `body` (handy for multi-line bodies).
        #[arg(long, verbatim_doc_comment)]
        stdin: bool,
        /// The markdown problem body. Multiple words join with spaces.
        /// Omit only with `--stdin`.
        #[arg(num_args = 0.., verbatim_doc_comment)]
        body: Vec<String>,
    },
    /// Create, load and spawn a Team Work team of agent terminals
    #[command(infer_subcommands = true)]
    #[command(long_about = help::CS_TERMINAL_TEAM)]
    #[command(after_long_help = help::CS_TERMINAL_TEAM_AFTER)]
    Team {
        #[command(subcommand)]
        action: TeamAction,
    },
}

/// The `cs terminal team` subcommands. `new` takes the config to write
/// (a `--config <file>` path or `--stdin`); `load` takes only the existing
/// team's `dir`. Both accept `--script` to emit the paste-and-run bootstrap
/// instead of running the operation.
#[derive(Subcommand, Debug)]
pub enum TeamAction {
    /// Write a team from a config.toml, then spawn and poke its members
    #[command(long_about = help::CS_TERMINAL_TEAM_NEW)]
    #[command(after_long_help = help::CS_TERMINAL_TEAM_NEW_AFTER)]
    New {
        /// Workspace-relative team directory (the team lives at
        /// `{dir}/config.toml`).
        dir: String,
        /// Path to the team config.toml to write. Omit with `--stdin`.
        #[arg(long)]
        config: Option<PathBuf>,
        /// Read the team config.toml from this process's stdin instead of
        /// `--config`.
        #[arg(long, verbatim_doc_comment)]
        stdin: bool,
        /// Path to a brief Markdown file folded VERBATIM into the generated
        /// `bootstrap.md` (its own section after the Roster), so a round's
        /// custom operating instructions survive a normal `new`/regenerate.
        /// The CLI reads the file and sends its text; the server never sees the
        /// path. Omit for the generic bootstrap.
        #[arg(long, value_name = "FILE", verbatim_doc_comment)]
        brief: Option<PathBuf>,
        /// Turn the chan MCP env vars ON or OFF for the team's terminals
        /// (sets `mcp_env` in the written config.toml). Default when omitted:
        /// OFF, matching the config default - agents still reach `cs search`
        /// and friends with MCP env off. `on` opts the whole team in; `off`
        /// writes it explicitly. Overrides any `mcp_env` in the input config.
        #[arg(long = "mcp-env", value_name = "ON_OFF", verbatim_doc_comment)]
        mcp_env: Option<McpEnvToggle>,
        /// Emit the paste-and-run bootstrap shell script to stdout instead
        /// of writing the team. A pure preview: it mutates nothing.
        #[arg(long, verbatim_doc_comment)]
        #[arg(conflicts_with_all = ["window", "pane", "side"])]
        script: bool,
        #[command(flatten)]
        destination: TabDestinationArgs,
    },
    /// Re-read a saved team's config.toml and spawn the team again
    #[command(long_about = help::CS_TERMINAL_TEAM_LOAD)]
    #[command(after_long_help = help::CS_TERMINAL_TEAM_LOAD_AFTER)]
    Load {
        /// Workspace-relative team directory to load.
        dir: String,
        /// Emit the paste-and-run bootstrap shell script to stdout.
        #[arg(long, conflicts_with_all = ["window", "pane", "side"])]
        script: bool,
        #[command(flatten)]
        destination: TabDestinationArgs,
    },
}

/// Dispatch a `cs <action>` against the current window's chan-server.
/// Was `cmd_shell` in the `chan` binary.
pub async fn dispatch(action: ShellAction) -> Result<()> {
    match action {
        ShellAction::Open { path, destination } => {
            let env = destination.target_env()?;
            let placement = destination.destination();
            if let Some(link) = path.as_deref().filter(|p| p.starts_with(GRAPH_LINK_PREFIX)) {
                let message = send_control_request(
                    &env.control_socket,
                    ControlRequest::OpenGraphLink {
                        window_id: env.window_id,
                        link: link.to_string(),
                        destination: placement,
                    },
                )
                .await?;
                eprintln!("{message}");
                return Ok(());
            }
            // No path -> open the terminal's cwd in the browser.
            let abs = absolutize(path.map(PathBuf::from).unwrap_or(PathBuf::from(".")))?;
            let message = send_control_request(
                &env.control_socket,
                ControlRequest::OpenPath {
                    window_id: env.window_id,
                    path: abs,
                    destination: placement,
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        ShellAction::Graph { path, destination } => {
            let env = destination.target_env()?;
            let abs = path.map(absolutize).transpose()?;
            let message = send_control_request(
                &env.control_socket,
                ControlRequest::OpenGraph {
                    window_id: env.window_id,
                    path: abs,
                    destination: destination.destination(),
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        ShellAction::Dashboard {
            carousel_index,
            carousel_off,
            destination,
        } => {
            let env = destination.target_env()?;
            let message = send_control_request(
                &env.control_socket,
                ControlRequest::OpenDashboard {
                    window_id: env.window_id,
                    carousel_index,
                    carousel_off,
                    destination: destination.destination(),
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        ShellAction::Upload { path } => {
            let env = open_env()?;
            // PATH is required (`.` for the current dir). absolutize resolves it
            // against the CLI's cwd; the server relativizes it to the workspace
            // (bounded) or keeps it cwd-scoped on a standalone terminal.
            let abs = absolutize(path)?;
            let message = send_control_request(
                &env.control_socket,
                ControlRequest::Upload {
                    window_id: env.window_id,
                    path: abs,
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        ShellAction::Download { path } => {
            let env = open_env()?;
            let abs = absolutize(path)?;
            let message = send_control_request(
                &env.control_socket,
                ControlRequest::Download {
                    window_id: env.window_id,
                    path: abs,
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        ShellAction::Tunnel { proto, spec } => cmd_shell_tunnel(proto, spec).await,
        ShellAction::Copy { mime, html } => cmd_shell_copy(mime, html).await,
        ShellAction::Paste { text, html, image } => cmd_shell_paste(text, html, image).await,
        ShellAction::Terminal { action } => cmd_shell_terminal(action).await,
        ShellAction::Window { action } => match action {
            WindowAction::List { json, pretty } => cmd_window_list(json, pretty).await,
            WindowAction::New => cmd_window_op(ControlRequest::WindowNew).await,
            WindowAction::Open { id } => cmd_window_op(ControlRequest::WindowOpen { id }).await,
            WindowAction::Rm { id, force } => {
                cmd_window_op(ControlRequest::WindowClose { id, force }).await
            }
            WindowAction::Hide { id } => cmd_window_op(ControlRequest::WindowHide { id }).await,
        },
        ShellAction::Session { action } => match action {
            SessionAction::List { json, pretty } => cmd_session_list(json, pretty).await,
            SessionAction::SelfCmd {
                name,
                reset,
                json,
                pretty,
            } => cmd_session_self(name, reset, json, pretty).await,
            SessionAction::Handover {
                to,
                accept,
                reject,
                timeout,
            } => {
                let env = open_env()?;
                cmd_session_op(ControlRequest::SessionHandover {
                    window_id: env.window_id,
                    to,
                    accept,
                    reject,
                    timeout_secs: timeout,
                })
                .await
            }
            SessionAction::Takeover { force } => {
                let env = open_env()?;
                cmd_session_op(ControlRequest::SessionTakeover {
                    window_id: env.window_id,
                    force,
                })
                .await
            }
        },
        ShellAction::Export { path, format, out } => cmd_shell_export(path, format, out).await,
        ShellAction::Search {
            search,
            json,
            pretty,
        } => cmd_shell_search(search.to_request()?, json, pretty).await,
        ShellAction::Pane {
            tab_name,
            window,
            json,
            pretty,
            action,
        } => cmd_pane(window, tab_name, json, pretty, action).await,
    }
}

/// `cs window list`: fetch the library's authoritative window set (the same
/// `WindowRecord` feed the desktop watcher and launcher reconcile to) and
/// print it. Session-scoped like `cs terminal list`: needs only
/// $CHAN_CONTROL_SOCKET, no window id. A standalone `chan open` has no
/// library and lists no windows.
async fn cmd_window_list(json: bool, pretty: bool) -> Result<()> {
    let socket = control_socket_env()?;
    let raw = send_control_request(&socket, ControlRequest::WindowList).await?;
    if json {
        if pretty {
            let value: serde_json::Value =
                serde_json::from_str(&raw).context("parsing window list JSON")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&value).context("formatting window list JSON")?
            );
        } else {
            println!("{raw}");
        }
    } else {
        print!("{}", render_window_list_markdown(&raw)?);
    }
    Ok(())
}

/// `cs window <new|open|rm|hide>`: send a one-shot window-lifecycle
/// request and print the server's reply (the new window id for `new`, a
/// short confirmation otherwise). Session-scoped like `cs window list`:
/// needs only $CHAN_CONTROL_SOCKET, no window id. `rm` of a window with
/// live terminals blocks here until the desktop's confirmation dialog is
/// answered (or `--force` was passed).
async fn cmd_window_op(req: ControlRequest) -> Result<()> {
    let socket = control_socket_env()?;
    let message = send_control_request(&socket, req).await?;
    println!("{message}");
    Ok(())
}

/// Render the `cs window list` rows (library `WindowRecord`s:
/// `{window_id, library_id, kind, title, ordinal, connected, …}`) as a
/// markdown table. Titles are library-owned and auto-derived; `connected`
/// means a live `/ws` socket is tagged with the window right now. Every row
/// in the set is a persisted library record, so `connected` is the only
/// status axis.
fn render_window_list_markdown(raw: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(raw).context("parsing window list JSON")?;
    let rows = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("window list JSON is not an array"))?;
    if rows.is_empty() {
        return Ok("No windows.\n".to_string());
    }
    let mut out = String::from(
        "| window | library | kind | title | # | status |\n\
         | --- | --- | --- | --- | --- | --- |\n",
    );
    for row in rows {
        let id = row.get("window_id").and_then(|v| v.as_str()).unwrap_or("?");
        let library = row.get("library_id").and_then(|v| v.as_str()).unwrap_or("");
        let kind = row.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let title = row.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let ordinal = row.get("ordinal").and_then(|v| v.as_u64()).unwrap_or(0);
        let connected = row
            .get("connected")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let status = if connected { "connected" } else { "offline" };
        out.push_str(&format!(
            "| {id} | {library} | {kind} | {title} | {ordinal} | {status} |\n"
        ));
    }
    Ok(out)
}

/// `cs session list`: fetch the session participant roster (window id, name,
/// role, status) and print it. Session-scoped like `cs window list`: needs
/// only $CHAN_CONTROL_SOCKET, no window id.
async fn cmd_session_list(json: bool, pretty: bool) -> Result<()> {
    let socket = control_socket_env()?;
    let raw = send_control_request(&socket, ControlRequest::SessionList).await?;
    if json {
        if pretty {
            let value: serde_json::Value =
                serde_json::from_str(&raw).context("parsing session list JSON")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&value).context("formatting session list JSON")?
            );
        } else {
            println!("{raw}");
        }
    } else {
        print!("{}", render_session_list_markdown(&raw)?);
    }
    Ok(())
}

/// `cs session <handover|takeover>`: send a session command and print the
/// server's reply. A `handover` request BLOCKS here until the leader accepts /
/// rejects or the timeout elapses (the CLI exits 124 on timeout, like
/// `cs window rm` blocking on the desktop dialog).
async fn cmd_session_op(req: ControlRequest) -> Result<()> {
    let socket = control_socket_env()?;
    let message = send_control_request(&socket, req).await?;
    println!("{message}");
    Ok(())
}

/// `cs session self`: bare = the whoami query (who am I in this session),
/// answered as one JSON record in `Ok.message` and rendered as a markdown
/// field table (`--json [--pretty]` for machine output); `--name`/`--reset`
/// print the server's plain confirmation line, like the other session ops.
async fn cmd_session_self(
    name: Option<String>,
    reset: bool,
    json: bool,
    pretty: bool,
) -> Result<()> {
    let env = open_env()?;
    let is_query = name.is_none() && !reset;
    let raw = send_control_request(
        &env.control_socket,
        ControlRequest::SessionSelf {
            window_id: env.window_id,
            name,
            reset,
        },
    )
    .await?;
    if !is_query {
        println!("{raw}");
    } else if json {
        if pretty {
            let value: serde_json::Value =
                serde_json::from_str(&raw).context("parsing session self JSON")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&value).context("formatting session self JSON")?
            );
        } else {
            println!("{raw}");
        }
    } else {
        print!("{}", render_session_self_markdown(&raw)?);
    }
    Ok(())
}

/// Render the `cs session list` rows (`{window_id, name, role, status}`) as a
/// markdown table. `role` is leader or follower; `status` is the participant
/// lifecycle state (live / disconnecting / disconnected / gone).
fn render_session_list_markdown(raw: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).context("parsing session list JSON")?;
    let rows = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("session list JSON is not an array"))?;
    if rows.is_empty() {
        return Ok("No session participants.\n".to_string());
    }
    let mut out = String::from(
        "| window | name | role | status |\n\
         | --- | --- | --- | --- |\n",
    );
    for row in rows {
        let window = row.get("window_id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let role = row.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let status = row.get("status").and_then(|v| v.as_str()).unwrap_or("");
        out.push_str(&format!("| {window} | {name} | {role} | {status} |\n"));
    }
    Ok(out)
}

/// Render the `cs session self` record (`{window_id, name, role, status,
/// is_leader, identity?}`) as a two-column markdown field table -- the
/// single-record analogue of the `cs session list` table. The `identity` row
/// appears only when the gateway asserted one.
fn render_session_self_markdown(raw: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).context("parsing session self JSON")?;
    let field = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or("?");
    let is_leader = value
        .get("is_leader")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut out = String::from("| field | value |\n| --- | --- |\n");
    out.push_str(&format!("| window | {} |\n", field("window_id")));
    out.push_str(&format!("| name | {} |\n", field("name")));
    out.push_str(&format!("| role | {} |\n", field("role")));
    out.push_str(&format!("| status | {} |\n", field("status")));
    out.push_str(&format!(
        "| leader | {} |\n",
        if is_leader { "yes" } else { "no" }
    ));
    if let Some(identity) = value.get("identity").and_then(|v| v.as_str()) {
        out.push_str(&format!("| identity | {identity} |\n"));
    }
    Ok(out)
}

/// `cs export <path>`: render a workspace file to `format` in a live
/// renderer window (the SPA owns the format registry) and write the bytes
/// back into the workspace. Session-scoped like `cs search` (no window id:
/// the server picks the renderer window); blocks until the renderer
/// replies, then prints the final workspace-relative output path.
async fn cmd_shell_export(path: String, format: String, out: Option<String>) -> Result<()> {
    let socket = control_socket_env()?;
    let out_path =
        send_control_request(&socket, ControlRequest::Export { path, format, out }).await?;
    println!("{out_path}");
    Ok(())
}

/// Run the shared retrieval/traversal contract on the live workspace tenant.
async fn cmd_shell_search(request: WorkspaceSearchRequest, json: bool, pretty: bool) -> Result<()> {
    let socket = control_socket_env()?;
    let raw = send_control_request(&socket, ControlRequest::WorkspaceSearch { request }).await?;
    let result: WorkspaceSearchResult =
        serde_json::from_str(&raw).context("parsing workspace search JSON")?;
    if json {
        if pretty {
            println!(
                "{}",
                serde_json::to_string_pretty(&result)
                    .context("formatting workspace search JSON")?
            );
        } else {
            println!("{raw}");
        }
    } else {
        print!("{}", render_workspace_search_markdown(&result));
    }
    anyhow::ensure!(
        result.errors.is_empty(),
        "workspace search completed with structured errors"
    );
    Ok(())
}

pub fn render_workspace_search_markdown(result: &WorkspaceSearchResult) -> String {
    let mut out = String::new();
    if matches!(result.readiness, WorkspaceReadiness::Recovering { .. }) {
        out.push_str("Workspace recovery is in progress; derived results are not ready.\n\n");
    }
    if !result.content_hits.is_empty() {
        out.push_str("## Content\n\n");
        for hit in &result.content_hits {
            if hit.heading.is_empty() {
                out.push_str(&format!("- {}:{}\n", hit.path, hit.start_line));
            } else {
                out.push_str(&format!(
                    "- {}:{} - {}\n",
                    hit.path, hit.start_line, hit.heading
                ));
            }
            if !hit.snippet.is_empty() {
                let flat = hit
                    .snippet
                    .replace('\n', " ")
                    .replace("<b>", "**")
                    .replace("</b>", "**");
                out.push_str(&format!("  {}\n", flat.trim()));
            }
        }
        out.push('\n');
    }
    if !result.entity_matches.is_empty() {
        out.push_str("## Entities\n\n");
        for entity in &result.entity_matches {
            out.push_str(&format!(
                "- {} `{}` ({})\n",
                selector_kind_name(entity.kind),
                entity.label,
                selector_text(&entity.selector)
            ));
        }
        out.push('\n');
    }
    if !result.nodes.is_empty() || !result.relationships.is_empty() {
        out.push_str("## Graph\n\n");
        for node in &result.nodes {
            out.push_str(&format!("- node `{}`\n", graph_node_id(node)));
        }
        for relationship in &result.relationships {
            out.push_str(&format!(
                "- `{}` -{}-> `{}`\n",
                relationship.source,
                relationship_kind_name(relationship.kind),
                relationship.target
            ));
        }
        out.push('\n');
    }
    if !result.warnings.is_empty() {
        out.push_str("## Warnings\n\n");
        for warning in &result.warnings {
            out.push_str(&format!("- {}\n", warning_message(warning)));
        }
        out.push('\n');
    }
    if !result.errors.is_empty() {
        out.push_str("## Errors\n\n");
        for error in &result.errors {
            out.push_str(&format!("- {}\n", error_message(error)));
        }
        out.push('\n');
    }
    if out.is_empty() {
        "No matches.\n".to_string()
    } else {
        out
    }
}

fn selector_kind_name(kind: WorkspaceSelectorKind) -> &'static str {
    match kind {
        WorkspaceSelectorKind::File => "file",
        WorkspaceSelectorKind::Directory => "directory",
        WorkspaceSelectorKind::Tag => "tag",
        WorkspaceSelectorKind::Mention => "mention",
        WorkspaceSelectorKind::Contact => "contact",
        WorkspaceSelectorKind::Language => "language",
    }
}

fn relationship_kind_name(kind: WorkspaceRelationshipKind) -> &'static str {
    match kind {
        WorkspaceRelationshipKind::Link => "link",
        WorkspaceRelationshipKind::Tag => "tag",
        WorkspaceRelationshipKind::Mention => "mention",
        WorkspaceRelationshipKind::Language => "language",
        WorkspaceRelationshipKind::Contains => "contains",
    }
}

fn selector_text(selector: &WorkspaceSelector) -> String {
    format!("{}:{}", selector_kind_name(selector.kind), selector.value)
}

fn graph_node_id(node: &chan_workspace::WorkspaceGraphNode) -> &str {
    match node {
        chan_workspace::WorkspaceGraphNode::File { id, .. }
        | chan_workspace::WorkspaceGraphNode::Directory { id, .. }
        | chan_workspace::WorkspaceGraphNode::Tag { id, .. }
        | chan_workspace::WorkspaceGraphNode::Mention { id, .. }
        | chan_workspace::WorkspaceGraphNode::Contact { id, .. }
        | chan_workspace::WorkspaceGraphNode::Language { id, .. } => id,
    }
}

fn warning_message(warning: &WorkspaceSearchWarning) -> &str {
    match warning {
        WorkspaceSearchWarning::LimitClamped { message, .. }
        | WorkspaceSearchWarning::ReportsDisabled { message }
        | WorkspaceSearchWarning::ReportsUnavailable { message }
        | WorkspaceSearchWarning::HybridUnavailable { message }
        | WorkspaceSearchWarning::MissingLinkTarget { message, .. } => message,
    }
}

fn error_message(error: &WorkspaceSearchError) -> &str {
    match error {
        WorkspaceSearchError::InvalidRequest { message }
        | WorkspaceSearchError::InvalidSelector { message, .. }
        | WorkspaceSearchError::SelectorNotFound { message, .. }
        | WorkspaceSearchError::AmbiguousSelector { message, .. }
        | WorkspaceSearchError::IndexNotReady { message }
        | WorkspaceSearchError::DomainUnavailable { message, .. } => message,
    }
}

/// The `(window_id, tab_name)` target a `cs pane` request carries. An
/// explicit `--tab-name` targets the window owning that tab (and needs no
/// $CHAN_WINDOW_ID); otherwise the caller's own window from $CHAN_WINDOW_ID.
/// Sending one or the other (never both) keeps the server's precedence
/// unambiguous; the server errors when neither resolves.
fn pane_target(
    window: Option<String>,
    tab_name: Option<String>,
) -> (Option<String>, Option<String>) {
    let trimmed = |s: String| {
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    match tab_name.and_then(trimmed) {
        Some(tab) => (None, Some(tab)),
        None => (
            window
                .and_then(trimmed)
                .or_else(|| std::env::var("CHAN_WINDOW_ID").ok().and_then(trimmed)),
            None,
        ),
    }
}

/// `cs pane`: inspect or drive the target window's tab/pane layout over the
/// control socket (the server pushes a `pane_query` / `pane_exec` to the SPA,
/// which replies). Bare = the layout report; a subcommand = a mutation. The
/// target is the caller's own window or `--tab-name`. Markdown by default;
/// `--json [--pretty]` for machine output. A close blocked by a dirty file /
/// live terminal (without `--force`) exits non-zero.
async fn cmd_pane(
    window: Option<String>,
    tab_name: Option<String>,
    json: bool,
    pretty: bool,
    action: Option<PaneAction>,
) -> Result<()> {
    let socket = control_socket_env()?;
    let (window_id, tab_name) = pane_target(window, tab_name);
    let is_query = action
        .as_ref()
        .is_none_or(|action| matches!(action, PaneAction::List));
    let is_new = action
        .as_ref()
        .is_some_and(|action| matches!(action, PaneAction::New { .. } | PaneAction::Split { .. }));
    let request = match action {
        None | Some(PaneAction::List) => ControlRequest::PaneQuery {
            window_id,
            tab_name,
        },
        Some(action) => ControlRequest::PaneExec {
            window_id,
            tab_name,
            op: action.into_op(),
        },
    };
    let raw = send_control_request(&socket, request).await?;
    if json {
        // Compact by default; --pretty re-indents. Both go to stdout so the
        // output pipes cleanly.
        if pretty {
            let value: serde_json::Value =
                serde_json::from_str(&raw).context("parsing pane reply JSON")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&value).context("formatting pane reply JSON")?
            );
        } else {
            println!("{raw}");
        }
    } else if is_query {
        print!("{}", render_pane_layout_markdown(&raw)?);
    } else if is_new {
        let value: serde_json::Value =
            serde_json::from_str(&raw).context("parsing pane new reply")?;
        if !value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            print!("{}", render_pane_exec_markdown(&raw)?);
            anyhow::bail!("cs pane: the operation was blocked (see output above)");
        }
        let pane_id = value
            .get("paneId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow::anyhow!("pane new reply missing `paneId`"))?;
        println!("{pane_id}");
    } else {
        print!("{}", render_pane_exec_markdown(&raw)?);
    }
    // An exec that was blocked (a dirty file / live terminal without --force)
    // completed the round-trip but did not fully apply; surface it as a
    // non-zero exit so scripts can react. The detail is already on stdout.
    if !is_query {
        let value: serde_json::Value =
            serde_json::from_str(&raw).context("parsing pane exec reply")?;
        if !value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            anyhow::bail!("cs pane: the operation was blocked (see output above)");
        }
    }
    Ok(())
}

/// Render a `cs pane <exec>` result. Shape (the SPA builds it):
/// `{ ok, summary, blocked: [{ tab, reason }] }`. Prints the summary, then a
/// `blocked:` list when a close hit a dirty file / live terminal. Falls back
/// to a bare `ok` / `blocked` line if the SPA omitted a summary.
fn render_pane_exec_markdown(raw: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(raw).context("parsing pane exec JSON")?;
    let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut out = String::new();
    if let Some(summary) = value.get("summary").and_then(|v| v.as_str()) {
        if !summary.is_empty() {
            out.push_str(summary);
            out.push('\n');
        }
    }
    if let Some(blocked) = value.get("blocked").and_then(|v| v.as_array()) {
        if !blocked.is_empty() {
            out.push_str("blocked:\n");
            for b in blocked {
                let tab = b.get("tab").and_then(|v| v.as_str()).unwrap_or("?");
                let reason = b.get("reason").and_then(|v| v.as_str()).unwrap_or("?");
                out.push_str(&format!("  - {tab}: {reason}\n"));
            }
        }
    }
    if out.is_empty() {
        out.push_str(if ok { "ok\n" } else { "blocked\n" });
    }
    Ok(out)
}

/// Render the complete two-sided `cs pane list` snapshot as one markdown
/// table per pane. Each side is explicit, including an empty side.
fn render_pane_layout_markdown(raw: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(raw).context("parsing pane layout JSON")?;
    let panes = value
        .get("panes")
        .and_then(|p| p.as_array())
        .ok_or_else(|| anyhow::anyhow!("pane layout JSON missing `panes`"))?;
    if panes.is_empty() {
        return Ok("No panes.\n".to_string());
    }
    let active_pane = value.get("activePaneId").and_then(|v| v.as_str());
    let str_field = |v: &serde_json::Value, key: &str| {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let mut out = String::new();
    for pane in panes {
        let id = str_field(pane, "id");
        let is_active = pane
            .get("active")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| active_pane == Some(id.as_str()));
        let active_side = pane
            .get("activeSide")
            .and_then(|value| value.as_str())
            .unwrap_or("a");
        let side_label = active_side.to_ascii_uppercase();
        match is_active {
            true => out.push_str(&format!("## pane {id} (active, side {side_label})\n\n")),
            false => out.push_str(&format!("## pane {id} (side {side_label})\n\n")),
        }
        let sides = pane
            .get("sides")
            .and_then(|value| value.as_object())
            .ok_or_else(|| anyhow::anyhow!("pane {id} layout JSON missing `sides`"))?;
        out.push_str("| side | tab | kind | title | flags |\n");
        out.push_str("| --- | --- | --- | --- | --- |\n");
        for side in ["a", "b"] {
            let side_value = sides
                .get(side)
                .ok_or_else(|| anyhow::anyhow!("pane {id} layout JSON missing side `{side}`"))?;
            let active_tab = side_value
                .get("activeTabId")
                .and_then(|value| value.as_str());
            let tabs = side_value
                .get("tabs")
                .and_then(|value| value.as_array())
                .ok_or_else(|| {
                    anyhow::anyhow!("pane {id} side {side} layout JSON missing `tabs`")
                })?;
            let side_label = side.to_ascii_uppercase();
            if tabs.is_empty() {
                out.push_str(&format!("| {side_label} | (empty) | | | |\n"));
                continue;
            }
            for tab in tabs {
                let tab_id = str_field(tab, "id");
                let kind = str_field(tab, "kind");
                let title = str_field(tab, "title");
                let is_active_tab = tab
                    .get("active")
                    .and_then(|value| value.as_bool())
                    .unwrap_or_else(|| active_tab == Some(tab_id.as_str()));
                let marker = if is_active_tab { "*" } else { "" };
                let mut flags: Vec<&str> = Vec::new();
                if tab
                    .get("dirty")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
                {
                    flags.push("dirty");
                }
                if tab
                    .get("live")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
                {
                    flags.push("live");
                }
                out.push_str(&format!(
                    "| {side_label} | {tab_id}{marker} | {kind} | {title} | {} |\n",
                    flags.join(", ")
                ));
            }
        }
        out.push('\n');
    }
    Ok(out)
}

/// `--proto` values for `cs tunnel`, parsed by hand because
/// [`chan_revtunnel::Proto`] is a wire type without a clap derive. The two
/// spellings match its serde rendering.
fn parse_tunnel_proto(value: &str) -> Result<Proto, String> {
    match value {
        "tcp" => Ok(Proto::Tcp),
        "udp" => Ok(Proto::Udp),
        other => Err(format!("unknown protocol {other:?}: expected tcp or udp")),
    }
}

/// The SPEC argument of `cs tunnel`, validated at parse time so a typo
/// fails locally with the spec parser's own message and no round-trip. The
/// proto stamped here is a placeholder: `--proto` is a separate flag,
/// applied by [`tunnel_request_spec`] in the dispatch arm.
fn parse_tunnel_spec_arg(value: &str) -> Result<TunnelSpec, String> {
    chan_revtunnel::parse_spec(value, Proto::Tcp).map_err(|err| err.to_string())
}

/// Combine the `--proto` flag with the parsed SPEC, refusing what no end
/// implements yet. Runs before the environment lookup so `--proto udp`
/// names the real blocker even outside a chan terminal.
fn tunnel_request_spec(proto: Proto, spec: TunnelSpec) -> Result<TunnelSpec> {
    if proto == Proto::Udp {
        anyhow::bail!("udp tunnels are not implemented yet; only --proto tcp forwards");
    }
    Ok(TunnelSpec { proto, ..spec })
}

/// Warn when a tunnel spec binds a non-loopback interface on the desktop
/// machine: everything that can reach that interface reaches the forwarded
/// devserver port, and there is no gate on the listener.
fn warn_non_loopback_tunnel_bind(spec: &TunnelSpec) {
    if !spec.is_loopback_bind() {
        eprintln!(
            "WARNING: binding {} exposes the tunnel on a non-loopback \
             interface of the desktop machine; anything that reaches it \
             reaches port {} on this host. Omit the bind address to keep \
             the listener on loopback.",
            chan_revtunnel::spec::render_authority(spec.bind_addr, spec.desktop_port),
            spec.devserver_port
        );
    }
}

/// `cs tunnel`: ask the desktop viewing this window to listen on one of its
/// ports and forward each connection back to a port on this host (the
/// `ssh -R` shape). Unlike every other command, the control connection IS
/// the tunnel's lifetime: the request line goes out without a half-close,
/// the ack comes back when the desktop reports its listener, and the
/// function then blocks until the tunnel dies (a second response line) or
/// this process does (Ctrl-C closes the socket, which is the teardown
/// signal -- no handler needed).
async fn cmd_shell_tunnel(proto: Proto, spec: TunnelSpec) -> Result<()> {
    let spec = tunnel_request_spec(proto, spec)?;
    let env = open_env()?;
    warn_non_loopback_tunnel_bind(&spec);
    let request = ControlRequest::Tunnel {
        window_id: env.window_id,
        proto: spec.proto,
        bind_addr: spec.bind_addr.to_string(),
        desktop_port: spec.desktop_port,
        devserver_port: spec.devserver_port,
    };
    let session = match send_control_request_streaming(&env.control_socket, request).await {
        Ok(session) => session,
        // Nothing acknowledged the tunnel within the server's ready window:
        // the elapsed notice goes to stderr and the CLI exits 124, like the
        // other bounded blocking commands. stderr is unbuffered, so the
        // line lands before the hard exit skips the runtime shutdown.
        Err(err) => match err.downcast::<crate::exit_code::ControlTimeout>() {
            Ok(timeout) => {
                eprintln!("{}", timeout.message);
                std::process::exit(crate::exit_code::CONTROL_TIMEOUT);
            }
            Err(other) => return Err(other),
        },
    };
    eprintln!("{} (Ctrl-C to stop)", session.ack);
    session.wait().await
}

/// How long a clipboard round-trip stays silent before `cs` prints the
/// waiting notice. The window may be showing a Paste request card that nobody
/// has clicked yet; without a notice the CLI looks wedged for the whole 30s
/// server-side reply bound.
const CLIPBOARD_WAIT_NOTICE_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Round-trip a clipboard control request, printing ONE stderr notice if no
/// reply arrived within [`CLIPBOARD_WAIT_NOTICE_DELAY`], then keep waiting
/// (the server bounds the whole trip at 30s). The notice points at the window,
/// which is where the answer comes from on every path (a Paste request card,
/// a browser permission prompt, or the native clipboard backend), so a
/// blocking `cs paste` / `cs copy` is self-explaining instead of silent.
async fn send_clipboard_request(
    socket: &std::path::Path,
    request: ControlRequest,
) -> Result<String> {
    let round_trip = send_control_request(socket, request);
    tokio::pin!(round_trip);
    match tokio::time::timeout(CLIPBOARD_WAIT_NOTICE_DELAY, &mut round_trip).await {
        Ok(result) => result,
        Err(_still_waiting) => {
            eprintln!(
                "waiting for the window's clipboard (check the Chan window for a Paste \
                 request; Ctrl-C to cancel)"
            );
            round_trip.await
        }
    }
}

/// Unwrap a clipboard round-trip result: a reply passes through; an elapsed
/// reply window prints the server's hint to stderr and exits
/// [`crate::exit_code::CONTROL_TIMEOUT`] (124), so a script can tell an
/// unanswered permission prompt from a real clipboard failure (exit 1).
/// stderr is unbuffered, so the line lands before the hard exit skips the
/// runtime shutdown.
fn clipboard_reply_or_timeout_exit(result: Result<String>) -> Result<String> {
    match classify_control_result(result)? {
        ControlOutcome::Replied(message) => Ok(message),
        ControlOutcome::TimedOut(message) => {
            eprintln!("{message}");
            std::process::exit(crate::exit_code::CONTROL_TIMEOUT);
        }
    }
}

/// `cs copy`: read all of stdin and push it onto the window's clipboard. The
/// bytes ride a base64 string on the control socket (a JSON envelope), so an
/// image and text share one path. `--html` maps to `--mime text/html`;
/// otherwise the server sniffs the content type from the bytes.
async fn cmd_shell_copy(mime: Option<String>, html: bool) -> Result<()> {
    let env = open_env()?;
    let mut buf = Vec::new();
    {
        use std::io::Read;
        // Bound the read: the clipboard is for modest content, so cap it (and
        // read one byte past the cap to detect an oversized input) instead of
        // buffering an unbounded stdin -- `cs copy < /dev/zero` never EOFs.
        std::io::stdin()
            .take(MAX_CLIPBOARD_BYTES as u64 + 1)
            .read_to_end(&mut buf)
            .context("reading stdin for cs copy")?;
    }
    if buf.is_empty() {
        anyhow::bail!("nothing on stdin to copy");
    }
    if buf.len() > MAX_CLIPBOARD_BYTES {
        anyhow::bail!(
            "clipboard payload too large (max {} MB)",
            MAX_CLIPBOARD_BYTES / (1024 * 1024)
        );
    }
    let mime = if html {
        Some("text/html".to_string())
    } else {
        mime
    };
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    let result = send_clipboard_request(
        &env.control_socket,
        ControlRequest::ClipboardCopy {
            window_id: env.window_id,
            data_b64,
            mime,
        },
    )
    .await;
    let message = clipboard_reply_or_timeout_exit(result)?;
    eprintln!("{message}");
    Ok(())
}

/// The `{ mime, data_b64 }` reply the SPA sends back for `cs paste`, delivered
/// as JSON in the control response `message`. `data_b64` is base64 of the raw
/// clipboard bytes, which the CLI writes verbatim to stdout.
#[derive(serde::Deserialize)]
struct ClipboardPasteReply {
    mime: String,
    data_b64: String,
}

/// `cs paste`: read the window's clipboard to stdout. The server replies with
/// a `{ mime, data_b64 }` JSON line; decode the base64 and write the RAW bytes
/// to stdout (so `cs paste > file.png` yields the real asset), reporting the
/// emitted MIME on stderr.
async fn cmd_shell_paste(text: bool, html: bool, image: bool) -> Result<()> {
    let env = open_env()?;
    // clap marks the three flags mutually exclusive, so at most one is set.
    let prefer = if text {
        PastePrefer::Text
    } else if html {
        PastePrefer::Html
    } else if image {
        PastePrefer::Image
    } else {
        PastePrefer::Auto
    };
    let result = send_clipboard_request(
        &env.control_socket,
        ControlRequest::ClipboardPaste {
            window_id: env.window_id,
            prefer,
        },
    )
    .await;
    let message = clipboard_reply_or_timeout_exit(result)?;
    let reply: ClipboardPasteReply =
        serde_json::from_str(&message).context("decoding clipboard paste reply")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(reply.data_b64.as_bytes())
        .context("decoding clipboard base64")?;
    {
        use std::io::Write;
        std::io::stdout()
            .write_all(&bytes)
            .context("writing clipboard bytes to stdout")?;
    }
    // The MIME goes to stderr so it never pollutes a `> file` redirect.
    eprintln!("{}", reply.mime);
    Ok(())
}

fn validate_terminal_write_data(data: String) -> Result<String> {
    if data.len() > MAX_TERMINAL_WRITE_BYTES {
        anyhow::bail!(
            "terminal write payload too large (max {MAX_TERMINAL_WRITE_BYTES} bytes); \
             write the content to a file and send its path"
        );
    }
    Ok(data)
}

fn read_terminal_write_stdin(reader: impl std::io::Read) -> Result<String> {
    use std::io::Read;

    let mut buf = Vec::new();
    reader
        .take(MAX_TERMINAL_WRITE_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .context("reading stdin for cs terminal write")?;
    if buf.len() > MAX_TERMINAL_WRITE_BYTES {
        anyhow::bail!(
            "terminal write payload too large (max {MAX_TERMINAL_WRITE_BYTES} bytes); \
             write the content to a file and send its path"
        );
    }
    String::from_utf8(buf).context("stdin must be UTF-8 for cs terminal write")
}

async fn cmd_shell_terminal(action: TerminalAction) -> Result<()> {
    match action {
        TerminalAction::New {
            path,
            tab_name,
            tab_group,
            destination,
        } => {
            let env = destination.target_env()?;
            let abs = path.map(absolutize).transpose()?;
            let message = send_control_request(
                &env.control_socket,
                ControlRequest::OpenTermNew {
                    window_id: env.window_id,
                    path: abs,
                    tab_name,
                    tab_group,
                    destination: destination.destination(),
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        TerminalAction::Write {
            cmd,
            stdin,
            submit,
            tab_name,
            tab_group,
        } => {
            if tab_name.is_none() && tab_group.is_none() {
                anyhow::bail!("cs terminal write needs --tab-name and/or --tab-group");
            }
            // Raw bytes, no implicit newline. --stdin reads at most one byte
            // beyond the logical-message cap so it can refuse, never truncate,
            // oversized input. Terminal input is UTF-8 text.
            let data = if stdin {
                read_terminal_write_stdin(std::io::stdin())?
            } else {
                validate_terminal_write_data(cmd.ok_or_else(|| {
                    anyhow::anyhow!("cs terminal write needs a command or --stdin")
                })?)?
            };
            // The wire carries only the request: whether to submit, plus the
            // agent this sender named (for the server's divergence note). The
            // server derives each matched session's real agent and resolves
            // the chord template in ITS environment, so a CHAN_SUBMIT_<AGENT>
            // override must live server-side, not in this process.
            let socket = control_socket_env()?;
            let result = send_control_request(
                &socket,
                ControlRequest::TermWrite {
                    tab_name,
                    tab_group,
                    data,
                    submit: submit.map(TermWriteSubmit::Agent),
                },
            )
            .await;
            let outcome = classify_term_write_result(result)?;
            eprintln!("{}", outcome.message());
            let exit_code = outcome.exit_code();
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
            Ok(())
        }
        TerminalAction::List { json, pretty } => {
            let socket = control_socket_env()?;
            let raw = send_control_request(&socket, ControlRequest::TermList).await?;
            if json {
                // Compact by default; --pretty re-indents. Both go to
                // stdout so the output pipes cleanly.
                if pretty {
                    let value: serde_json::Value =
                        serde_json::from_str(&raw).context("parsing terminal list JSON")?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&value)
                            .context("formatting terminal list JSON")?
                    );
                } else {
                    println!("{raw}");
                }
            } else {
                print!("{}", render_terminal_list_markdown(&raw)?);
            }
            Ok(())
        }
        TerminalAction::Restart {
            tab_name,
            tab_group,
        } => {
            if tab_name.is_none() && tab_group.is_none() {
                anyhow::bail!("cs terminal restart needs --tab-name and/or --tab-group");
            }
            let socket = control_socket_env()?;
            let message = send_control_request(
                &socket,
                ControlRequest::TermRestart {
                    tab_name,
                    tab_group,
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        TerminalAction::Close {
            tab_name,
            tab_group,
        } => {
            if tab_name.is_none() && tab_group.is_none() {
                anyhow::bail!("cs terminal close needs --tab-name and/or --tab-group");
            }
            let socket = control_socket_env()?;
            let message = send_control_request(
                &socket,
                ControlRequest::TermClose {
                    tab_name,
                    tab_group,
                },
            )
            .await?;
            eprintln!("{message}");
            Ok(())
        }
        TerminalAction::Scrollback { tab_name } => {
            let socket = control_socket_env()?;
            let raw =
                send_control_request(&socket, ControlRequest::TermScrollback { tab_name }).await?;
            // The scrollback is the captured artifact, so it goes to stdout
            // (pipes cleanly into a file or a pager). No trailing newline is
            // added: the ring already carries the session's own line breaks.
            print!("{raw}");
            Ok(())
        }
        TerminalAction::Survey {
            tab_name,
            tab_group,
            title,
            option,
            timeout,
            stdin,
            body,
        } => {
            cmd_shell_survey(SurveyArgs {
                tab_name,
                tab_group,
                title,
                option,
                timeout_secs: timeout,
                stdin,
                body,
            })
            .await
        }
        TerminalAction::Team { action } => cmd_shell_team(action).await,
    }
}

/// `cs terminal team new|load`: round-trip a [`ControlRequest::TerminalTeam`]
/// so the server owns the parse / validate / write / bootstrap generation
/// (the same path the `/api/team-config` route uses). `new` reads the input
/// config.toml from `--config <file>` or `--stdin`; `load` carries no
/// config. With `--script` the server returns the paste-and-run bootstrap
/// script, which prints to STDOUT (the captured artifact); otherwise the
/// one-line ack/summary goes to stderr like the other queueing commands.
async fn cmd_shell_team(action: TeamAction) -> Result<()> {
    let socket = control_socket_env()?;
    // The caller's window, when run from a chan terminal that owns one, so
    // the server binds each spawned agent session to it ($CHAN_WINDOW_ID
    // flows to the agents, like a regular SPA terminal). A windowless caller
    // (a native terminal) omits it and the agents spawn unbound, as before.
    let window_id = std::env::var("CHAN_WINDOW_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let (request, script) = match action {
        TeamAction::New {
            dir,
            config,
            stdin,
            brief,
            mcp_env,
            script,
            destination,
        } => {
            let target_window = destination.window.clone().or_else(|| window_id.clone());
            anyhow::ensure!(
                destination.destination().is_none() || target_window.is_some(),
                "--pane/--side needs --window or $CHAN_WINDOW_ID"
            );
            let mut config_toml = read_team_config_input(config, stdin)?;
            // --mcp-env overrides the input config's `mcp_env` (or adds it).
            // Omitted -> leave the config as-is (server's serde default is OFF).
            if let Some(toggle) = mcp_env {
                config_toml = set_team_mcp_env(&config_toml, toggle.as_bool())?;
            }
            // Read the brief file CLIENT-side into text; the server has no
            // access to the caller's filesystem (same reason config travels as
            // text). Absent -> None, the generic bootstrap.
            let brief_content = read_brief_input(brief)?;
            (
                ControlRequest::TerminalTeam {
                    dir: resolve_team_dir(&dir)?,
                    op: TeamOp::New,
                    config_toml: Some(config_toml),
                    brief_content,
                    script,
                    window_id: target_window,
                    destination: destination.destination(),
                },
                script,
            )
        }
        TeamAction::Load {
            dir,
            script,
            destination,
        } => {
            let target_window = destination.window.clone().or(window_id);
            anyhow::ensure!(
                destination.destination().is_none() || target_window.is_some(),
                "--pane/--side needs --window or $CHAN_WINDOW_ID"
            );
            (
                ControlRequest::TerminalTeam {
                    dir: resolve_team_dir(&dir)?,
                    op: TeamOp::Load,
                    config_toml: None,
                    // Load never regenerates the bootstrap, so a brief is moot.
                    brief_content: None,
                    script,
                    window_id: target_window,
                    destination: destination.destination(),
                },
                script,
            )
        }
    };
    let message = send_control_request(&socket, request).await?;
    if script {
        // The script is the result the caller captures, so it goes to
        // stdout (pipes cleanly into a file), matching `cs terminal survey`.
        println!("{message}");
    } else {
        eprintln!("{message}");
    }
    Ok(())
}

/// Read the optional `cs terminal team new --brief <file>` into text. The
/// server has no access to the caller's filesystem, so the CLI reads the file
/// and sends its CONTENT (the same reason the config travels as text). `None`
/// when `--brief` was omitted -> the generic bootstrap.
fn read_brief_input(brief: Option<PathBuf>) -> Result<Option<String>> {
    match brief {
        None => Ok(None),
        Some(path) => {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading team brief {}", path.display()))?;
            Ok(Some(text))
        }
    }
}

/// Resolve the `cs terminal team new` config.toml input from `--config
/// <file>` XOR `--stdin`. Bails with a clear message if both or neither is
/// given, mirroring the `cs terminal write` / `survey` body precedence.
fn read_team_config_input(config: Option<PathBuf>, stdin: bool) -> Result<String> {
    match (config, stdin) {
        (Some(_), true) => {
            anyhow::bail!("pass either --config <file> or --stdin, not both")
        }
        (Some(path), false) => std::fs::read_to_string(&path)
            .with_context(|| format!("reading team config {}", path.display())),
        (None, true) => {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .context("reading team config from stdin")?;
            Ok(buf)
        }
        (None, false) => {
            anyhow::bail!("cs terminal team new needs a config: --config <file> or --stdin")
        }
    }
}

/// Set the top-level `mcp_env` key in a team config TOML string, so
/// `cs terminal team new --mcp-env on|off` overrides whatever the input config
/// had (or adds it when absent). The server re-parses + regenerates
/// config.toml from this, so the only requirement is a valid TOML document
/// with `mcp_env` at the root (before the `[[members]]` tables). Parsing +
/// re-serializing via `toml` keeps the key at the document root regardless of
/// where the input put its tables, which a naive string append cannot.
fn set_team_mcp_env(config_toml: &str, value: bool) -> Result<String> {
    let mut doc: toml::Table = config_toml
        .parse()
        .context("parsing team config TOML to apply --mcp-env")?;
    doc.insert("mcp_env".to_string(), toml::Value::Boolean(value));
    toml::to_string(&doc).context("re-serializing team config after --mcp-env")
}

/// Resolve a user-typed `cs terminal team` dir to a WORKSPACE-relative dir,
/// against the caller's current directory. `cs` runs inside a chan terminal,
/// so `$CHAN_WORKSPACE_PATH` names the served workspace root and the process
/// cwd locates the caller within it. This gives `team new` / `team load` the
/// same cwd-awareness as `cs open` (a bare name, `.`, a relative path, or an
/// absolute path under the workspace all resolve) while keeping the wire
/// `dir` workspace-relative, so the server, the `--script` generator, and the
/// `/api/team-config` route stay unchanged. The env lookups live here; the
/// pure resolution is [`resolve_team_dir_in`] (the `open_env_from` split).
fn resolve_team_dir(dir: &str) -> Result<String> {
    let workspace = std::env::var("CHAN_WORKSPACE_PATH").ok();
    let cwd = std::env::current_dir().context("resolving current directory")?;
    resolve_team_dir_in(dir, workspace.as_deref(), &cwd)
}

/// The pure dir resolution: anchor `dir` to `workspace` (the served root)
/// via `cwd`. Resolution is LEXICAL (the target is never canonicalized) so a
/// `team new` dir that does not exist yet still resolves; `cwd` and the
/// workspace root, which do exist, ARE canonicalized so a symlinked prefix
/// (macOS `/tmp` -> `/private/tmp`) does not break the prefix match. With no
/// `workspace` (running outside a chan terminal, where the control socket is
/// missing too), the dir passes through unchanged, preserving the prior
/// workspace-relative contract.
fn resolve_team_dir_in(dir: &str, workspace: Option<&str>, cwd: &Path) -> Result<String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        anyhow::bail!("team directory is required");
    }
    let Some(workspace) = workspace.map(str::trim).filter(|w| !w.is_empty()) else {
        return Ok(trimmed.to_string());
    };
    let ws_root = canonical_or(Path::new(workspace));
    let input = Path::new(trimmed);
    // An absolute input stands on its own; a relative one (including ".")
    // joins the caller's cwd.
    let abs = if input.is_absolute() {
        input.to_path_buf()
    } else {
        canonical_or(cwd).join(input)
    };
    let normalized = lexical_normalize(&abs);
    let rel = normalized.strip_prefix(&ws_root).map_err(|_| {
        anyhow::anyhow!(
            "team directory {trimmed:?} is outside the workspace ({})",
            ws_root.display()
        )
    })?;
    let rel = path_to_posix(rel);
    if rel.is_empty() {
        anyhow::bail!("team directory resolves to the workspace root; name a subdirectory");
    }
    Ok(rel)
}

/// Canonicalize `path`, falling back to the path verbatim when it cannot be
/// resolved (e.g. it does not exist). Used on the cwd + workspace root, which
/// normally exist, so the fallback is just defensive.
fn canonical_or(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Resolve `.` and `..` components lexically, without touching the
/// filesystem, so a not-yet-existing `team new` dir still normalizes. A `..`
/// that would climb above the accumulated path just pops the last component.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Join a relative path's `Normal` components with `/` for the workspace-
/// relative wire string. Mirrors the server's `path_to_posix`; defined here
/// so the CLI does not depend on a server-private helper.
fn path_to_posix(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The parsed `cs terminal survey` arguments, grouped so the dispatch does
/// not pass a long positional parameter list around.
struct SurveyArgs {
    tab_name: Option<String>,
    tab_group: Option<String>,
    title: Option<String>,
    option: Vec<String>,
    timeout_secs: u64,
    stdin: bool,
    body: Vec<String>,
}

/// `cs terminal survey`: build a [`SurveySpec`] and round-trip a BLOCKING
/// [`ControlRequest::TermSurvey`]. The server holds the connection open
/// until the user answers, so this call blocks; the reply (the chosen
/// option label, or the follow-up / dismiss line) goes to stdout so it
/// pipes cleanly, matching the "the tool returns that option" contract.
async fn cmd_shell_survey(args: SurveyArgs) -> Result<()> {
    let SurveyArgs {
        tab_name,
        tab_group,
        title,
        option,
        timeout_secs,
        stdin,
        body,
    } = args;

    if tab_name.is_none() && tab_group.is_none() {
        anyhow::bail!("cs terminal survey needs --tab-name and/or --tab-group");
    }
    // The contract caps options at 1..=4 (the UI numbers them [1]..[4]).
    if option.is_empty() || option.len() > 4 {
        anyhow::bail!(
            "cs terminal survey needs 1..=4 --option values (got {})",
            option.len()
        );
    }
    // Body comes from stdin (multi-line bodies) or the positional words.
    let body_markdown = if stdin {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .context("reading survey body from stdin")?;
        buf
    } else {
        body.join(" ")
    };
    if body_markdown.trim().is_empty() {
        anyhow::bail!("cs terminal survey needs a markdown body (positional words or --stdin)");
    }
    let spec = SurveySpec {
        // Server-minted; left empty here (see SurveySpec docs).
        survey_id: String::new(),
        title,
        body_markdown,
        options: option,
    };
    let socket = control_socket_env()?;
    let result = send_control_request(
        &socket,
        ControlRequest::TermSurvey {
            tab_name,
            tab_group,
            spec,
            timeout_secs,
        },
    )
    .await;
    match classify_control_result(result)? {
        // The reply is the result the caller wants captured, so it goes to
        // stdout (unlike the queued-request acks the other commands eprintln).
        ControlOutcome::Replied(message) => {
            println!("{message}");
            Ok(())
        }
        // No answer within `--timeout`: the notice goes to STDERR so stdout
        // stays empty for a `$(cs terminal survey ...)` capture, and exit 124
        // lets a script branch on the timeout. stderr is unbuffered, so the
        // line lands before the hard exit skips the runtime shutdown.
        ControlOutcome::TimedOut(message) => {
            eprintln!("{message}");
            std::process::exit(crate::exit_code::CONTROL_TIMEOUT);
        }
    }
}

/// The typed result of `cs terminal write`. Both outcomes carry the server's
/// acknowledgement because enqueue already succeeded; only
/// [`TermWriteControlOutcome::SubmitRefused`] maps to a failure exit.
#[derive(Debug)]
enum TermWriteControlOutcome {
    Queued(String),
    SubmitRefused(String),
}

impl TermWriteControlOutcome {
    fn message(&self) -> &str {
        match self {
            Self::Queued(message) | Self::SubmitRefused(message) => message,
        }
    }

    fn exit_code(&self) -> i32 {
        match self {
            Self::Queued(_) => 0,
            Self::SubmitRefused(_) => crate::exit_code::SUBMIT_REFUSED,
        }
    }
}

/// Classify a terminal-write control result without parsing its
/// human-readable acknowledgement. Other control errors retain the generic
/// exit-1 path.
fn classify_term_write_result(result: Result<String>) -> Result<TermWriteControlOutcome> {
    match result {
        Ok(message) => Ok(TermWriteControlOutcome::Queued(message)),
        Err(err) => match err.downcast::<crate::exit_code::ControlSubmitRefused>() {
            Ok(refusal) => Ok(TermWriteControlOutcome::SubmitRefused(refusal.message)),
            Err(other) => Err(other),
        },
    }
}

/// The terminal outcome of a bounded blocking control round-trip
/// (`cs terminal survey`, `cs copy`, `cs paste`). Split from the commands so
/// the print-stream + exit-code decision is unit-testable without a live
/// server or a `process::exit`.
#[derive(Debug)]
enum ControlOutcome {
    /// The server replied: the message is the command's normal payload
    /// (a survey answer line, a clipboard reply) and the process exits 0.
    Replied(String),
    /// The reply window elapsed: the message is printed to stderr and the
    /// process exits [`crate::exit_code::CONTROL_TIMEOUT`] (124).
    TimedOut(String),
}

/// Classify a [`send_control_request`] result for a bounded blocking command:
/// a plain reply is [`ControlOutcome::Replied`]; the typed timeout error
/// ([`crate::exit_code::ControlTimeout`], from a `ControlResponse::Timeout`)
/// becomes [`ControlOutcome::TimedOut`]; any other error propagates (exit 1).
fn classify_control_result(result: Result<String>) -> Result<ControlOutcome> {
    match result {
        Ok(message) => Ok(ControlOutcome::Replied(message)),
        Err(err) => match err.downcast::<crate::exit_code::ControlTimeout>() {
            Ok(timeout) => Ok(ControlOutcome::TimedOut(timeout.message)),
            Err(other) => Err(other),
        },
    }
}

/// Render the `cs terminal list` registry JSON
/// (`{groups: {group: [{name, spawn_name, session_id, cwd}]}}`) as a markdown table
/// grouped by terminal group. This is the default human output; `--json`
/// emits the raw payload instead. An empty registry yields a short line
/// rather than a blank table.
fn render_terminal_list_markdown(raw: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).context("parsing terminal list JSON")?;
    let groups = value
        .get("groups")
        .and_then(|g| g.as_object())
        .ok_or_else(|| anyhow::anyhow!("terminal list JSON missing `groups`"))?;
    if groups.is_empty() {
        return Ok("No live terminal sessions.\n".to_string());
    }
    let str_field = |s: &serde_json::Value, key: &str| {
        s.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("-")
            .to_string()
    };
    // Numeric counterpart to `str_field`. A server that predates the field
    // renders `-`, distinguishing "not reported" from a reported empty queue,
    // which is `0`.
    let num_field = |s: &serde_json::Value, key: &str| {
        s.get(key)
            .and_then(|v| v.as_u64())
            .map_or_else(|| "-".to_string(), |n| n.to_string())
    };
    let mut out = String::new();
    for (group, sessions) in groups {
        out.push_str(&format!("## {group}\n\n"));
        out.push_str(
            "| name | spawn | agent | session | window | pane | side | tab | kind | status | queue | cwd |\n",
        );
        out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
        if let Some(arr) = sessions.as_array() {
            for s in arr {
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
                    str_field(s, "name"),
                    // Immutable PTY-incarnation provenance. Always keep the
                    // column; a legacy fd-store import renders unknown as `-`.
                    str_field(s, "spawn_name"),
                    // The server-derived submit agent ("-" for a shell
                    // session), so a poker never has to guess the target.
                    str_field(s, "agent"),
                    str_field(s, "session_id"),
                    str_field(s, "window"),
                    str_field(s, "pane"),
                    str_field(s, "side"),
                    str_field(s, "tab"),
                    str_field(s, "window_kind"),
                    str_field(s, "window_status"),
                    // Logical messages still queued for this session, so a
                    // coordinator can see an undelivered backlog without
                    // reaching for --json. Deep queue means the session has
                    // not seen the latest write yet.
                    num_field(s, "queue_depth"),
                    str_field(s, "cwd"),
                ));
            }
        }
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_write_stdin_accepts_4096_bytes_and_refuses_one_more() {
        let exact = vec![b'x'; MAX_TERMINAL_WRITE_BYTES];
        assert_eq!(
            read_terminal_write_stdin(std::io::Cursor::new(exact.clone()))
                .unwrap()
                .into_bytes(),
            exact
        );

        let error = read_terminal_write_stdin(std::io::Cursor::new(vec![
            b'x';
            MAX_TERMINAL_WRITE_BYTES
                + 1
        ]))
        .unwrap_err()
        .to_string();
        assert!(error.contains("max 4096 bytes"), "{error}");
        assert!(error.contains("file"), "{error}");
    }

    #[test]
    fn terminal_write_literal_cap_counts_utf8_bytes() {
        let exact = "é".repeat(MAX_TERMINAL_WRITE_BYTES / 2);
        assert!(validate_terminal_write_data(exact).is_ok());

        let error =
            validate_terminal_write_data(format!("{}x", "é".repeat(MAX_TERMINAL_WRITE_BYTES / 2)))
                .unwrap_err()
                .to_string();
        assert!(error.contains("max 4096 bytes"), "{error}");
    }

    #[test]
    fn cs_help_renders_cs_usage_without_a_shell_level() {
        // This parser IS the `cs` help surface for every front end (the
        // chan binary's symlink alias and chan-desktop's direct entry), so
        // its usage lines must read `cs <cmd>` with no `shell` level.
        use clap::CommandFactory;
        let mut cmd = CsCli::command();
        cmd.build(); // propagate bin names so subcommand usage says `cs terminal`
        let help = cmd.render_long_help().to_string();
        assert!(
            help.contains("Usage: cs [OPTIONS] <COMMAND>"),
            "usage must be `cs`: {help}"
        );
        assert!(!help.contains("cs shell"), "no `cs shell` path: {help}");

        let help = cmd
            .find_subcommand_mut("terminal")
            .expect("terminal subcommand")
            .render_long_help()
            .to_string();
        assert!(
            help.contains("Usage: cs terminal [OPTIONS] <COMMAND>"),
            "terminal usage must be `cs terminal`: {help}"
        );
        assert!(!help.contains("cs shell"), "no `cs shell` path: {help}");
    }

    #[test]
    fn search_args_build_the_shared_request() {
        let cli = CsCli::try_parse_from([
            "cs",
            "search",
            "two",
            "words",
            "--from",
            "tag:#design",
            "--domain",
            "file",
            "--depth",
            "2",
            "--direction",
            "both",
            "--edge-kind",
            "link",
            "--node-limit",
            "50",
        ])
        .unwrap();
        let ShellAction::Search { search, .. } = cli.action else {
            panic!("expected search action");
        };
        let request = search.to_request().unwrap();
        assert_eq!(request.query.as_deref(), Some("two words"));
        assert_eq!(request.from[0].kind, WorkspaceSelectorKind::Tag);
        assert_eq!(request.from[0].value, "#design");
        assert_eq!(request.domains, vec![WorkspaceSearchDomain::File]);
        assert_eq!(request.depth, Some(2));
        assert_eq!(request.direction, WorkspaceTraversalDirection::Both);
        assert_eq!(
            request.relationship_kinds,
            vec![WorkspaceRelationshipKind::Link]
        );
        assert_eq!(request.node_limit, Some(50));
    }

    #[test]
    fn bare_search_has_one_precise_usage_error() {
        let cli = CsCli::try_parse_from(["cs", "search"]).unwrap();
        let ShellAction::Search { search, .. } = cli.action else {
            panic!("expected search action");
        };
        assert_eq!(
            search.to_request().unwrap_err().to_string(),
            "workspace search requires QUERY, --from, or a non-content --domain"
        );
    }

    #[test]
    fn search_args_require_the_documented_enum_vocabulary() {
        let cli = CsCli::try_parse_from(["cs", "search", "--from", "dir:notes"]).unwrap();
        let ShellAction::Search { search, .. } = cli.action else {
            panic!("expected search action");
        };
        assert!(search.to_request().is_err());

        let cli = CsCli::try_parse_from(["cs", "search", "--domain", "dir"]).unwrap();
        let ShellAction::Search { search, .. } = cli.action else {
            panic!("expected search action");
        };
        assert!(search.to_request().is_err());
    }

    #[test]
    fn search_markdown_converts_bold_highlight_and_locator() {
        let result = WorkspaceSearchResult {
            workspace: chan_workspace::WorkspaceSearchIdentity {
                root: "/tmp/work".into(),
                metadata_key: "work-00112233".into(),
                display_name: "work".into(),
            },
            readiness: chan_workspace::WorkspaceReadiness::default(),
            search: chan_workspace::WorkspaceSearchStatus {
                requested: true,
                ready: true,
                mode: chan_workspace::EffectiveSearchMode::Bm25,
            },
            content_hits: vec![chan_workspace::WorkspaceContentHit {
                path: "a.md".into(),
                chunk_id: "a.md:H".into(),
                heading: "H".into(),
                start_line: 3,
                snippet: "the <b>fox</b> ran".into(),
                score: 1.0,
            }],
            entity_matches: Vec::new(),
            nodes: Vec::new(),
            relationships: Vec::new(),
            traversal: chan_workspace::EffectiveWorkspaceTraversal {
                depth: 0,
                direction: WorkspaceTraversalDirection::Auto,
                relationship_kinds: Vec::new(),
                spine_forced: false,
                profiles: Vec::new(),
            },
            truncation: chan_workspace::WorkspaceSearchTruncation::default(),
            warnings: Vec::new(),
            errors: Vec::new(),
        };
        let out = render_workspace_search_markdown(&result);
        assert!(out.contains("- a.md:3 - H"), "locator: {out}");
        // <b>...</b> highlight -> markdown **bold**.
        assert!(out.contains("the **fox** ran"), "bold: {out}");
        assert!(!out.contains("<b>"), "no raw html: {out}");
    }

    #[test]
    fn search_markdown_reports_recovery_from_state_only() {
        let recovering = chan_workspace::WorkspaceReadiness::Recovering {
            generation: chan_workspace::WorkspaceGeneration::INITIAL,
            completed_generation: chan_workspace::WorkspaceGeneration::INITIAL,
            required_action: None,
            active_generation: None,
            pending_generation: None,
        };
        let result = WorkspaceSearchResult {
            workspace: chan_workspace::WorkspaceSearchIdentity {
                root: "/tmp/work".into(),
                metadata_key: "work-00112233".into(),
                display_name: "work".into(),
            },
            readiness: recovering,
            search: chan_workspace::WorkspaceSearchStatus {
                requested: true,
                ready: true,
                mode: chan_workspace::EffectiveSearchMode::NotRun,
            },
            content_hits: Vec::new(),
            entity_matches: Vec::new(),
            nodes: Vec::new(),
            relationships: Vec::new(),
            traversal: chan_workspace::EffectiveWorkspaceTraversal {
                depth: 0,
                direction: WorkspaceTraversalDirection::Auto,
                relationship_kinds: Vec::new(),
                spine_forced: false,
                profiles: Vec::new(),
            },
            truncation: chan_workspace::WorkspaceSearchTruncation::default(),
            warnings: Vec::new(),
            errors: vec![chan_workspace::WorkspaceSearchError::IndexNotReady {
                message: "workspace recovery is in progress".into(),
            }],
        };

        let out = render_workspace_search_markdown(&result);

        assert!(
            out.starts_with("Workspace recovery is in progress; derived results are not ready.\n"),
            "{out}"
        );
        assert!(out.contains("## Errors"), "{out}");
    }

    #[test]
    fn terminal_list_markdown_empty_is_short_line() {
        let out = render_terminal_list_markdown(r#"{"groups":{}}"#).expect("render");
        assert_eq!(out, "No live terminal sessions.\n");
    }

    #[test]
    fn terminal_list_markdown_renders_window_columns() {
        let raw = r#"{"groups":{"default":[{"name":"probe-live","spawn_name":"probe-spawn","agent":"codex","session_id":"s1","window":"w-abc","pane":"p-1","side":"b","tab":"t-1","window_kind":"standalone-terminal","window_status":"alive","queue_depth":0,"cwd":"/tmp"}]}}"#;
        let out = render_terminal_list_markdown(raw).expect("render");
        assert!(
            out.contains(
                "| name | spawn | agent | session | window | pane | side | tab | kind | status | queue | cwd |"
            ),
            "header: {out}"
        );
        assert!(
            out.contains(
                "| probe-live | probe-spawn | codex | s1 | w-abc | p-1 | b | t-1 | standalone-terminal | alive | 0 | /tmp |"
            ),
            "row: {out}"
        );
    }

    #[test]
    fn terminal_list_markdown_reports_queue_depth_per_session() {
        // The table is the default output, so a coordinator watching a drain
        // should not have to reach for --json. An empty queue reports 0, not
        // a blank or a dash: zero pending is an answer, and rendering it the
        // same as "this server does not report depth" would erase the
        // difference.
        let raw = r#"{"groups":{"crew":[
            {"name":"idle","spawn_name":"sp","agent":"claude","session_id":"s1","window":"w","pane":"p","side":"a","tab":"t","window_kind":"workspace","window_status":"alive","queue_depth":0,"cwd":"/tmp"},
            {"name":"backed-up","spawn_name":"sp","agent":"claude","session_id":"s2","window":"w","pane":"p","side":"b","tab":"t","window_kind":"workspace","window_status":"alive","queue_depth":7,"cwd":"/tmp"}
        ]}}"#;
        let out = render_terminal_list_markdown(raw).expect("render");
        assert!(
            out.contains(
                "| idle | sp | claude | s1 | w | p | a | t | workspace | alive | 0 | /tmp |"
            ),
            "empty queue: {out}"
        );
        assert!(
            out.contains(
                "| backed-up | sp | claude | s2 | w | p | b | t | workspace | alive | 7 | /tmp |"
            ),
            "pending queue: {out}"
        );
    }

    #[test]
    fn terminal_list_markdown_tolerates_a_pre_identity_server() {
        // A server that omits the spawn/agent/window/pane/tab/kind/status
        // fields (or reports a null spawn/agent) renders `-` in those columns
        // rather than erroring. The spawn column itself never disappears.
        // An absent queue_depth renders `-` for the same reason, which is not
        // the `0` a server reporting an empty queue produces.
        let raw = r#"{"groups":{"default":[{"name":"probe","spawn_name":null,"session_id":"s1","cwd":"/tmp"}]}}"#;
        let out = render_terminal_list_markdown(raw).expect("render");
        assert!(
            out.contains("| probe | - | - | s1 | - | - | - | - | - | - | - | /tmp |"),
            "row: {out}"
        );
    }

    #[test]
    fn session_list_markdown_renders_participant_rows() {
        let raw = r#"[{"window_id":"w-abc","name":"alice","role":"leader","status":"live"},{"window_id":"w-def","name":"bob","role":"follower","status":"disconnecting"}]"#;
        let out = render_session_list_markdown(raw).expect("render");
        assert!(
            out.contains("| window | name | role | status |"),
            "header: {out}"
        );
        assert!(
            out.contains("| w-abc | alice | leader | live |"),
            "leader: {out}"
        );
        assert!(
            out.contains("| w-def | bob | follower | disconnecting |"),
            "follower: {out}"
        );
    }

    #[test]
    fn session_list_markdown_empty_is_short_line() {
        let out = render_session_list_markdown("[]").expect("render");
        assert_eq!(out, "No session participants.\n");
    }

    #[test]
    fn session_self_markdown_renders_the_field_table() {
        let raw = r#"{"window_id":"w-abc","name":"ops","role":"follower","status":"live","is_leader":false,"identity":"Ada Lovelace <ada@example.com>"}"#;
        let out = render_session_self_markdown(raw).expect("render");
        assert!(
            out.starts_with("| field | value |\n| --- | --- |\n"),
            "{out}"
        );
        assert!(out.contains("| window | w-abc |"), "{out}");
        assert!(out.contains("| name | ops |"), "{out}");
        assert!(out.contains("| role | follower |"), "{out}");
        assert!(out.contains("| status | live |"), "{out}");
        assert!(out.contains("| leader | no |"), "{out}");
        assert!(
            out.contains("| identity | Ada Lovelace <ada@example.com> |"),
            "{out}"
        );
    }

    #[test]
    fn session_self_markdown_omits_absent_identity_and_marks_leader() {
        let raw =
            r#"{"window_id":"w-a","name":"mbp","role":"leader","status":"live","is_leader":true}"#;
        let out = render_session_self_markdown(raw).expect("render");
        assert!(out.contains("| leader | yes |"), "{out}");
        assert!(!out.contains("| identity |"), "{out}");
    }

    #[test]
    fn survey_timeout_flag_parses_and_defaults_to_600() {
        // Omitted: the baked-in default carries the window so the agent never
        // blocks forever, and default-vs-custom stays visible in the message.
        let cli = CsCli::parse_from(["cs", "terminal", "survey", "--tab-name", "@@Alex", "q"]);
        match cli.action {
            ShellAction::Terminal {
                action: TerminalAction::Survey { timeout, .. },
            } => assert_eq!(timeout, crate::wire::DEFAULT_SURVEY_TIMEOUT_SECS),
            other => panic!("expected survey, got {other:?}"),
        }
        // Explicit override is taken verbatim.
        let cli = CsCli::parse_from([
            "cs",
            "terminal",
            "survey",
            "--tab-name",
            "@@Alex",
            "--timeout",
            "30",
            "q",
        ]);
        match cli.action {
            ShellAction::Terminal {
                action: TerminalAction::Survey { timeout, .. },
            } => assert_eq!(timeout, 30),
            other => panic!("expected survey, got {other:?}"),
        }
    }

    #[test]
    fn classify_control_result_maps_reply_timeout_and_error() {
        // A plain reply is the replied outcome (stdout, exit 0).
        match classify_control_result(Ok("Ship it".into())).unwrap() {
            ControlOutcome::Replied(m) => assert_eq!(m, "Ship it"),
            ControlOutcome::TimedOut(m) => panic!("unexpected timeout: {m}"),
        }
        // The typed timeout error becomes the timed-out outcome (stderr, 124),
        // carrying the server's elapsed-window line verbatim. This is the
        // shared path for `cs terminal survey --timeout` AND the `cs copy` /
        // `cs paste` clipboard round-trips.
        let timed_out = classify_control_result(Err(crate::exit_code::ControlTimeout {
            message: "no reply within 30s".into(),
        }
        .into()))
        .unwrap();
        match timed_out {
            ControlOutcome::TimedOut(m) => assert_eq!(m, "no reply within 30s"),
            ControlOutcome::Replied(m) => panic!("expected timeout, got answer: {m}"),
        }
        // Any other error propagates unchanged (the generic exit-1 path).
        let err = classify_control_result(Err(anyhow::anyhow!("connection refused"))).unwrap_err();
        assert!(err.to_string().contains("connection refused"));
    }

    #[test]
    fn classify_term_write_result_maps_submit_refusal_to_exit_69() {
        let queued = classify_term_write_result(Ok("queued at position 1".into())).unwrap();
        assert_eq!(queued.exit_code(), 0);
        match queued {
            TermWriteControlOutcome::Queued(message) => {
                assert_eq!(message, "queued at position 1")
            }
            TermWriteControlOutcome::SubmitRefused(message) => {
                panic!("unexpected refusal: {message}")
            }
        }

        let refused = classify_term_write_result(Err(crate::exit_code::ControlSubmitRefused {
            message: "queued, but no chord".into(),
        }
        .into()))
        .unwrap();
        assert_eq!(refused.exit_code(), crate::exit_code::SUBMIT_REFUSED);
        match refused {
            TermWriteControlOutcome::SubmitRefused(message) => {
                assert_eq!(message, "queued, but no chord")
            }
            TermWriteControlOutcome::Queued(message) => {
                panic!("expected refusal, got success: {message}")
            }
        }

        let err =
            classify_term_write_result(Err(anyhow::anyhow!("connection refused"))).unwrap_err();
        assert!(err.to_string().contains("connection refused"));
    }

    #[test]
    fn parses_pane_query_json_pretty() {
        let cli = CsCli::parse_from(["cs", "pane", "--json", "--pretty"]);
        match cli.action {
            ShellAction::Pane {
                tab_name,
                json,
                pretty,
                action,
                ..
            } => {
                assert!(json);
                assert!(pretty);
                assert!(tab_name.is_none());
                assert!(action.is_none(), "bare cs pane is the query");
            }
            other => panic!("unexpected parse: {other:?}"),
        }
    }

    #[test]
    fn parses_pane_exec_subcommands_and_global_tab_name() {
        // --tab-name is global, so it works on a subcommand; focus carries
        // the pane id.
        let cli = CsCli::parse_from(["cs", "pane", "--tab-name", "@@Alice", "focus", "pane-1"]);
        match cli.action {
            ShellAction::Pane {
                tab_name,
                action: Some(PaneAction::Focus { pane_id, .. }),
                ..
            } => {
                assert_eq!(tab_name.as_deref(), Some("@@Alice"));
                assert_eq!(pane_id, "pane-1");
            }
            other => panic!("unexpected parse: {other:?}"),
        }

        // split bottom --pane.
        let cli = CsCli::parse_from(["cs", "pane", "split", "bottom", "--pane", "pane-2"]);
        match cli.action {
            ShellAction::Pane {
                action: Some(PaneAction::Split { dir, pane }),
                ..
            } => {
                assert!(matches!(dir, SplitDirArg::Bottom));
                assert_eq!(pane.as_deref(), Some("pane-2"));
            }
            other => panic!("unexpected parse: {other:?}"),
        }

        // close-tab --force.
        let cli = CsCli::parse_from(["cs", "pane", "close-tab", "--force"]);
        match cli.action {
            ShellAction::Pane {
                action: Some(PaneAction::CloseTab { force, tab, pane }),
                ..
            } => {
                assert!(force);
                assert!(tab.is_none() && pane.is_none());
            }
            other => panic!("unexpected parse: {other:?}"),
        }

        // resize delta.
        let cli = CsCli::parse_from(["cs", "pane", "resize", "-0.1"]);
        match cli.action {
            ShellAction::Pane {
                action: Some(PaneAction::Resize { delta, .. }),
                ..
            } => assert!((delta - (-0.1)).abs() < 1e-9),
            other => panic!("unexpected parse: {other:?}"),
        }

        let cli = CsCli::parse_from(["cs", "pane", "--window", "win-2", "new", "right"]);
        assert!(matches!(
            cli.action,
            ShellAction::Pane {
                window: Some(ref window),
                action: Some(PaneAction::New {
                    dir: SplitDirArg::Right,
                    ..
                }),
                ..
            } if window == "win-2"
        ));

        let cli = CsCli::parse_from(["cs", "pane", "equalize", "--pane", "pane-2"]);
        assert!(matches!(
            cli.action,
            ShellAction::Pane {
                action: Some(PaneAction::Equalize {
                    pane: Some(ref pane)
                }),
                ..
            } if pane == "pane-2"
        ));

        let cli = CsCli::parse_from(["cs", "pane", "swap", "pane-7", "--pane", "pane-2"]);
        assert!(matches!(
            cli.action,
            ShellAction::Pane {
                action: Some(PaneAction::Swap {
                    ref other_pane_id,
                    pane: Some(ref pane),
                }),
                ..
            } if other_pane_id == "pane-7" && pane == "pane-2"
        ));

        let cli = CsCli::parse_from(["cs", "pane", "close", "pane-2", "--force"]);
        assert!(matches!(
            cli.action,
            ShellAction::Pane {
                action: Some(PaneAction::Close {
                    pane_id: Some(ref pane),
                    force: true,
                }),
                ..
            } if pane == "pane-2"
        ));

        assert!(
            CsCli::try_parse_from([
                "cs",
                "pane",
                "--window",
                "win-2",
                "--tab-name",
                "@@Alice",
                "list",
            ])
            .is_err(),
            "direct and tab-derived window targets must conflict"
        );
    }

    #[test]
    fn every_tab_opener_accepts_one_shared_destination_shape() {
        let assert_destination = |destination: TabDestinationArgs| {
            assert_eq!(destination.window.as_deref(), Some("win-2"));
            assert_eq!(destination.pane.as_deref(), Some("pane-4"));
            assert_eq!(destination.side, Some(PaneSide::B));
        };
        let tail = ["--window", "win-2", "--pane", "pane-4", "--side", "b"];

        match CsCli::parse_from(["cs", "open", "notes.md"].into_iter().chain(tail)).action {
            ShellAction::Open { destination, .. } => assert_destination(destination),
            other => panic!("unexpected open parse: {other:?}"),
        }
        match CsCli::parse_from(["cs", "graph"].into_iter().chain(tail)).action {
            ShellAction::Graph { destination, .. } => assert_destination(destination),
            other => panic!("unexpected graph parse: {other:?}"),
        }
        match CsCli::parse_from(["cs", "dashboard"].into_iter().chain(tail)).action {
            ShellAction::Dashboard { destination, .. } => assert_destination(destination),
            other => panic!("unexpected dashboard parse: {other:?}"),
        }
        match CsCli::parse_from(["cs", "terminal", "new"].into_iter().chain(tail)).action {
            ShellAction::Terminal {
                action: TerminalAction::New { destination, .. },
            } => assert_destination(destination),
            other => panic!("unexpected terminal new parse: {other:?}"),
        }
        match CsCli::parse_from(
            ["cs", "terminal", "team", "load", "alpha"]
                .into_iter()
                .chain(tail),
        )
        .action
        {
            ShellAction::Terminal {
                action:
                    TerminalAction::Team {
                        action: TeamAction::Load { destination, .. },
                    },
            } => assert_destination(destination),
            other => panic!("unexpected team load parse: {other:?}"),
        }

        assert!(CsCli::try_parse_from(["cs", "open", "--side", "c"]).is_err());
        assert!(CsCli::try_parse_from([
            "cs", "terminal", "team", "load", "alpha", "--script", "--pane", "pane-4",
        ])
        .is_err());
    }

    #[test]
    fn parses_window_lifecycle_subcommands() {
        // Full names.
        let cli = CsCli::parse_from(["cs", "window", "new"]);
        assert!(matches!(
            cli.action,
            ShellAction::Window {
                action: WindowAction::New
            }
        ));

        let cli = CsCli::parse_from(["cs", "window", "open", "terminal-win-2"]);
        match cli.action {
            ShellAction::Window {
                action: WindowAction::Open { id },
            } => assert_eq!(id, "terminal-win-2"),
            other => panic!("unexpected parse: {other:?}"),
        }

        // rm with and without --force.
        let cli = CsCli::parse_from(["cs", "window", "rm", "workspace-aa-0"]);
        match cli.action {
            ShellAction::Window {
                action: WindowAction::Rm { id, force },
            } => {
                assert_eq!(id, "workspace-aa-0");
                assert!(!force);
            }
            other => panic!("unexpected parse: {other:?}"),
        }
        let cli = CsCli::parse_from(["cs", "window", "rm", "--force", "terminal-win-1"]);
        match cli.action {
            ShellAction::Window {
                action: WindowAction::Rm { id, force },
            } => {
                assert_eq!(id, "terminal-win-1");
                assert!(force);
            }
            other => panic!("unexpected parse: {other:?}"),
        }

        let cli = CsCli::parse_from(["cs", "window", "hide", "terminal-win-3"]);
        assert!(matches!(
            cli.action,
            ShellAction::Window {
                action: WindowAction::Hide { .. }
            }
        ));
    }

    #[test]
    fn window_subcommand_prefixes_are_unambiguous() {
        // `infer_subcommands` resolves each verb from a unique prefix -- a
        // regression here is a runtime break clap won't flag at compile
        // time. Note `hide` needs "hi": a bare "h" is ambiguous with the
        // auto-generated `help` subcommand, so it (correctly) does NOT
        // resolve to `hide`.
        type Case = (&'static str, fn(&WindowAction) -> bool);
        let cases: [Case; 5] = [
            ("l", |a| matches!(a, WindowAction::List { .. })),
            ("n", |a| matches!(a, WindowAction::New)),
            ("o", |a| matches!(a, WindowAction::Open { .. })),
            ("hi", |a| matches!(a, WindowAction::Hide { .. })),
            ("r", |a| matches!(a, WindowAction::Rm { .. })),
        ];
        for (prefix, check) in cases {
            // Each verb that needs args gets dummy ones; extras are ignored
            // by the variants that don't take them.
            let args = match prefix {
                "o" | "hi" | "r" => vec!["cs", "window", prefix, "id-0"],
                _ => vec!["cs", "window", prefix],
            };
            let cli = CsCli::try_parse_from(args)
                .unwrap_or_else(|e| panic!("`cs window {prefix}` failed to parse: {e}"));
            match cli.action {
                ShellAction::Window { action } => assert!(
                    check(&action),
                    "`cs window {prefix}` resolved wrong: {action:?}"
                ),
                other => panic!("unexpected parse for `cs window {prefix}`: {other:?}"),
            }
        }

        // A bare "h" is ambiguous (help vs hide); confirm it's rejected so
        // the comment above stays honest.
        assert!(CsCli::try_parse_from(["cs", "window", "h", "id-0"]).is_err());
    }

    #[test]
    fn session_self_bare_is_the_query_and_flags_stay_exclusive() {
        // Bare `cs session self` is the whoami query; `--name`/`--reset` are
        // mutually exclusive mutations, and `--json` is query-form only.
        match CsCli::parse_from(["cs", "session", "self"]).action {
            ShellAction::Session {
                action:
                    SessionAction::SelfCmd {
                        name: None,
                        reset: false,
                        json: false,
                        pretty: false,
                    },
            } => {}
            other => panic!("unexpected parse for bare `cs session self`: {other:?}"),
        }
        assert!(CsCli::try_parse_from(["cs", "session", "self", "--name", "x"]).is_ok());
        assert!(CsCli::try_parse_from(["cs", "session", "self", "--reset"]).is_ok());
        assert!(CsCli::try_parse_from(["cs", "session", "self", "--json", "--pretty"]).is_ok());
        assert!(
            CsCli::try_parse_from(["cs", "session", "self", "--name", "x", "--reset"]).is_err()
        );
        assert!(CsCli::try_parse_from(["cs", "session", "self", "--name", "x", "--json"]).is_err());
        assert!(CsCli::try_parse_from(["cs", "session", "self", "--reset", "--json"]).is_err());
    }

    #[test]
    fn upload_download_require_a_path_argument() {
        // PATH is required on both (no default form); a bare verb is a usage error.
        assert!(CsCli::try_parse_from(["cs", "upload"]).is_err());
        assert!(CsCli::try_parse_from(["cs", "download"]).is_err());
        // `.` (and any relative path) parses to the given path.
        match CsCli::try_parse_from(["cs", "upload", "."]).unwrap().action {
            ShellAction::Upload { path } => assert_eq!(path.to_str(), Some(".")),
            other => panic!("unexpected parse for `cs upload .`: {other:?}"),
        }
        match CsCli::try_parse_from(["cs", "download", "notes/a.md"])
            .unwrap()
            .action
        {
            ShellAction::Download { path } => assert_eq!(path.to_str(), Some("notes/a.md")),
            other => panic!("unexpected parse for `cs download notes/a.md`: {other:?}"),
        }
    }

    #[test]
    fn tunnel_parses_spec_and_proto() {
        // A bare port pair: tcp default, loopback bind. The SPEC is parsed
        // (not carried as a string), so a typo fails at the clap edge with
        // no round-trip.
        match CsCli::try_parse_from(["cs", "tunnel", "8080:3000"])
            .unwrap()
            .action
        {
            ShellAction::Tunnel { proto, spec } => {
                assert_eq!(proto, Proto::Tcp);
                assert_eq!(spec.desktop_port, 8080);
                assert_eq!(spec.devserver_port, 3000);
                assert!(spec.is_loopback_bind());
            }
            other => panic!("unexpected parse for `cs tunnel 8080:3000`: {other:?}"),
        }
        // An explicit bind address and `--proto udp` both PARSE; udp is
        // refused later, at dispatch, not by clap.
        match CsCli::try_parse_from(["cs", "tunnel", "--proto", "udp", "0.0.0.0:53:5353"])
            .unwrap()
            .action
        {
            ShellAction::Tunnel { proto, spec } => {
                assert_eq!(proto, Proto::Udp);
                assert!(!spec.is_loopback_bind());
            }
            other => panic!("unexpected parse for `cs tunnel --proto udp`: {other:?}"),
        }
    }

    #[test]
    fn tunnel_rejects_bad_specs_and_protocols_at_parse_time() {
        // SPEC is required, and each spec_error surfaces at the clap edge.
        assert!(CsCli::try_parse_from(["cs", "tunnel"]).is_err());
        // Missing devserver port.
        assert!(CsCli::try_parse_from(["cs", "tunnel", "8080:"]).is_err());
        // Out-of-range port.
        assert!(CsCli::try_parse_from(["cs", "tunnel", "70000:3000"]).is_err());
        // Devserver port 0 has nothing to dial.
        assert!(CsCli::try_parse_from(["cs", "tunnel", "8080:0"]).is_err());
        // Unknown protocol.
        assert!(CsCli::try_parse_from(["cs", "tunnel", "--proto", "icmp", "8080:3000"]).is_err());
        // One spec per invocation.
        assert!(CsCli::try_parse_from(["cs", "tunnel", "8080:3000", "8081:3001"]).is_err());
    }

    #[test]
    fn tunnel_lone_port_expands_to_both_ends_at_the_clap_edge() {
        match CsCli::try_parse_from(["cs", "tunnel", "3000"])
            .unwrap()
            .action
        {
            ShellAction::Tunnel { spec, .. } => {
                assert_eq!(spec.desktop_port, 3000);
                assert_eq!(spec.devserver_port, 3000);
            }
            other => panic!("unexpected parse for `cs tunnel 3000`: {other:?}"),
        }
    }

    #[test]
    fn tunnel_request_spec_stamps_proto_and_refuses_udp() {
        let parsed = chan_revtunnel::parse_spec("8080:3000", Proto::Tcp).unwrap();
        let spec = tunnel_request_spec(Proto::Tcp, parsed.clone()).unwrap();
        assert_eq!(spec.proto, Proto::Tcp);
        let err = tunnel_request_spec(Proto::Udp, parsed).unwrap_err();
        assert!(err.to_string().contains("not implemented"), "{err}");
    }

    #[test]
    fn copy_parses_bare_and_with_mime_flags() {
        // A bare `cs copy` reads stdin and sniffs the type (no path arg).
        match CsCli::try_parse_from(["cs", "copy"]).unwrap().action {
            ShellAction::Copy { mime, html } => {
                assert_eq!(mime, None);
                assert!(!html);
            }
            other => panic!("unexpected parse for `cs copy`: {other:?}"),
        }
        match CsCli::try_parse_from(["cs", "copy", "--mime", "image/png"])
            .unwrap()
            .action
        {
            ShellAction::Copy { mime, html } => {
                assert_eq!(mime.as_deref(), Some("image/png"));
                assert!(!html);
            }
            other => panic!("unexpected parse for `cs copy --mime`: {other:?}"),
        }
        match CsCli::try_parse_from(["cs", "copy", "--html"])
            .unwrap()
            .action
        {
            ShellAction::Copy { html, .. } => assert!(html),
            other => panic!("unexpected parse for `cs copy --html`: {other:?}"),
        }
        // `--html` and `--mime` are mutually exclusive.
        assert!(CsCli::try_parse_from(["cs", "copy", "--html", "--mime", "text/html"]).is_err());
    }

    #[test]
    fn paste_parses_and_rejects_conflicting_prefer_flags() {
        match CsCli::try_parse_from(["cs", "paste"]).unwrap().action {
            ShellAction::Paste { text, html, image } => {
                assert!(!text && !html && !image);
            }
            other => panic!("unexpected parse for `cs paste`: {other:?}"),
        }
        match CsCli::try_parse_from(["cs", "paste", "--image"])
            .unwrap()
            .action
        {
            ShellAction::Paste { image, .. } => assert!(image),
            other => panic!("unexpected parse for `cs paste --image`: {other:?}"),
        }
        // The three representation flags are mutually exclusive.
        assert!(CsCli::try_parse_from(["cs", "paste", "--text", "--image"]).is_err());
        assert!(CsCli::try_parse_from(["cs", "paste", "--html", "--text"]).is_err());
    }

    #[test]
    fn pane_action_into_op_maps_each_variant() {
        assert!(matches!(
            PaneAction::Focus {
                pane_id: "p".into(),
                side: Some(PaneSide::B),
            }
            .into_op(),
            PaneOp::Focus { .. }
        ));
        assert!(matches!(
            PaneAction::CloseAll { force: true }.into_op(),
            PaneOp::CloseAll { force: true }
        ));
        // SplitDirArg maps to the wire SplitDir.
        match (PaneAction::Split {
            dir: SplitDirArg::Right,
            pane: None,
        })
        .into_op()
        {
            PaneOp::Split { dir, .. } => assert!(matches!(dir, SplitDir::Right)),
            other => panic!("unexpected op: {other:?}"),
        }
        assert!(matches!(
            PaneAction::Equalize {
                pane: Some("p".into())
            }
            .into_op(),
            PaneOp::Equalize {
                pane_id: Some(ref pane)
            } if pane == "p"
        ));
        assert!(matches!(
            PaneAction::Swap {
                other_pane_id: "q".into(),
                pane: Some("p".into()),
            }
            .into_op(),
            PaneOp::Swap {
                pane_id: Some(ref pane),
                ref other_pane_id,
            } if pane == "p" && other_pane_id == "q"
        ));
    }

    #[test]
    fn pane_exec_markdown_lists_blocked() {
        let raw = r#"{"ok":false,"summary":"closed 1, blocked 1","blocked":[
            {"tab":"notes.md","reason":"unsaved changes"}]}"#;
        let out = render_pane_exec_markdown(raw).expect("render");
        assert!(out.contains("closed 1, blocked 1"), "{out}");
        assert!(out.contains("- notes.md: unsaved changes"), "{out}");
    }

    #[test]
    fn pane_layout_markdown_renders_panes_tabs_and_flags() {
        let raw = r#"{
            "activePaneId": "p1",
            "panes": [
                {
                    "id": "p1",
                    "active": true,
                    "activeSide": "b",
                    "sides": {
                        "a": {
                            "activeTabId": "t3",
                            "tabs": [
                                { "id": "t3", "kind": "file", "title": "notes.md", "dirty": true }
                            ]
                        },
                        "b": {
                            "activeTabId": "t4",
                            "tabs": [
                                { "id": "t4", "kind": "terminal", "title": "@@Alice", "live": true }
                            ]
                        }
                    }
                },
                {
                    "id": "p2",
                    "active": false,
                    "activeSide": "a",
                    "sides": {
                        "a": { "activeTabId": null, "tabs": [] },
                        "b": { "activeTabId": null, "tabs": [] }
                    }
                }
            ]
        }"#;
        let out = render_pane_layout_markdown(raw).expect("render");
        // Active pane is flagged; the inactive one is not.
        assert!(
            out.contains("## pane p1 (active, side B)"),
            "active heading: {out}"
        );
        assert!(
            out.contains("## pane p2 (side A)") && !out.contains("## pane p2 (active"),
            "inactive heading: {out}"
        );
        // Each side is explicit; active tabs and state flags survive.
        assert!(
            out.contains("| A | t3* | file | notes.md | dirty |"),
            "{out}"
        );
        assert!(
            out.contains("| B | t4* | terminal | @@Alice | live |"),
            "{out}"
        );
        assert_eq!(
            out.matches("| A | (empty) | | | |").count(),
            1,
            "empty A side: {out}"
        );
        assert_eq!(
            out.matches("| B | (empty) | | | |").count(),
            1,
            "empty B side: {out}"
        );
    }

    #[test]
    fn pane_layout_markdown_empty_is_short_line() {
        let out = render_pane_layout_markdown(r#"{"activePaneId":"","panes":[]}"#).expect("render");
        assert_eq!(out, "No panes.\n");
    }

    #[test]
    fn parses_terminal_close_by_name_or_group() {
        let cli = CsCli::parse_from(["cs", "terminal", "close", "--tab-name", "@@Alice"]);
        match cli.action {
            ShellAction::Terminal {
                action:
                    TerminalAction::Close {
                        tab_name,
                        tab_group,
                    },
            } => {
                assert_eq!(tab_name.as_deref(), Some("@@Alice"));
                assert_eq!(tab_group, None);
            }
            other => panic!("unexpected parse: {other:?}"),
        }
        // --tab-group is accepted too (whole-group teardown). The
        // "needs a selector" guard is a dispatch-time bail (like restart),
        // not a parse error.
        let cli = CsCli::parse_from(["cs", "terminal", "close", "--tab-group", "chan-team"]);
        match cli.action {
            ShellAction::Terminal {
                action: TerminalAction::Close { tab_group, .. },
            } => assert_eq!(tab_group.as_deref(), Some("chan-team")),
            other => panic!("unexpected parse: {other:?}"),
        }
    }

    #[test]
    fn terminal_write_accepts_named_submit_agents_and_rejects_unknown_agents() {
        let cli = CsCli::parse_from([
            "cs",
            "terminal",
            "write",
            "hello",
            "--submit=opencode",
            "--tab-name=@@Lead",
        ]);
        match cli.action {
            ShellAction::Terminal {
                action: TerminalAction::Write { submit, .. },
            } => assert_eq!(submit, Some(SubmitAgent::OpenCode)),
            other => panic!("unexpected parse: {other:?}"),
        }
        let cli = CsCli::parse_from([
            "cs",
            "terminal",
            "write",
            "hello",
            "--submit=kimi",
            "--tab-name=@@Lead",
        ]);
        match cli.action {
            ShellAction::Terminal {
                action: TerminalAction::Write { submit, .. },
            } => assert_eq!(submit.map(SubmitAgent::name), Some("kimi")),
            other => panic!("unexpected parse: {other:?}"),
        }
        assert!(CsCli::try_parse_from([
            "cs",
            "terminal",
            "write",
            "hello",
            "--submit=unknown",
            "--tab-name=@@Lead",
        ])
        .is_err());
    }

    #[test]
    fn parses_terminal_team_new_with_config_and_script() {
        let cli = CsCli::parse_from([
            "cs",
            "terminal",
            "team",
            "new",
            "alpha",
            "--config",
            "spec.toml",
            "--script",
        ]);
        match cli.action {
            ShellAction::Terminal {
                action:
                    TerminalAction::Team {
                        action:
                            TeamAction::New {
                                dir,
                                config,
                                stdin,
                                brief,
                                mcp_env,
                                script,
                                ..
                            },
                    },
            } => {
                assert_eq!(dir, "alpha");
                assert_eq!(config.as_deref(), Some(std::path::Path::new("spec.toml")));
                assert!(!stdin);
                // Omitting --brief leaves it unset (the generic bootstrap).
                assert_eq!(brief, None);
                // Omitting --mcp-env leaves the field unset (server default OFF).
                assert_eq!(mcp_env, None);
                assert!(script);
            }
            other => panic!("unexpected parse: {other:?}"),
        }
    }

    #[test]
    fn parses_terminal_team_new_mcp_env_on_off() {
        let on = CsCli::parse_from([
            "cs",
            "terminal",
            "team",
            "new",
            "alpha",
            "--stdin",
            "--mcp-env",
            "on",
        ]);
        match on.action {
            ShellAction::Terminal {
                action:
                    TerminalAction::Team {
                        action: TeamAction::New { mcp_env, .. },
                    },
            } => assert_eq!(mcp_env, Some(McpEnvToggle::On)),
            other => panic!("unexpected parse: {other:?}"),
        }
        let off = CsCli::parse_from([
            "cs",
            "terminal",
            "team",
            "new",
            "alpha",
            "--stdin",
            "--mcp-env",
            "off",
        ]);
        match off.action {
            ShellAction::Terminal {
                action:
                    TerminalAction::Team {
                        action: TeamAction::New { mcp_env, .. },
                    },
            } => assert_eq!(mcp_env, Some(McpEnvToggle::Off)),
            other => panic!("unexpected parse: {other:?}"),
        }
        // Only on|off parse; a bogus value is a clap error, not a silent miss.
        assert!(CsCli::try_parse_from([
            "cs",
            "terminal",
            "team",
            "new",
            "alpha",
            "--stdin",
            "--mcp-env",
            "maybe",
        ])
        .is_err());
    }

    #[test]
    fn set_team_mcp_env_sets_root_key_before_members() {
        let input = "team_name = \"alpha\"\nhost_handle = \"@@Neo\"\n\n\
                     [[members]]\nhandle = \"@@Lead\"\ncommand = \"claude\"\nis_lead = true\n";
        // ON injects mcp_env = true at the root; the member table is preserved
        // and (per TOML) still serializes after the root scalar keys, so the
        // server parses it back into TeamConfig.mcp_env.
        let on: toml::Table = set_team_mcp_env(input, true).unwrap().parse().unwrap();
        assert_eq!(on.get("mcp_env"), Some(&toml::Value::Boolean(true)));
        assert!(on.get("members").and_then(|m| m.as_array()).is_some());
        // OFF writes it explicitly.
        let off: toml::Table = set_team_mcp_env(input, false).unwrap().parse().unwrap();
        assert_eq!(off.get("mcp_env"), Some(&toml::Value::Boolean(false)));
    }

    #[test]
    fn set_team_mcp_env_overrides_existing_value() {
        // An input that already turned it on is overridden by --mcp-env off.
        let input = "team_name = \"a\"\nmcp_env = true\n\n[[members]]\n\
                     handle = \"@@L\"\ncommand = \"claude\"\nis_lead = true\n";
        let out: toml::Table = set_team_mcp_env(input, false).unwrap().parse().unwrap();
        assert_eq!(out.get("mcp_env"), Some(&toml::Value::Boolean(false)));
    }

    #[test]
    fn parses_terminal_scrollback_tab_name() {
        let cli = CsCli::parse_from(["cs", "terminal", "scrollback", "--tab-name", "@@Alice"]);
        match cli.action {
            ShellAction::Terminal {
                action: TerminalAction::Scrollback { tab_name },
            } => assert_eq!(tab_name, "@@Alice"),
            other => panic!("unexpected parse: {other:?}"),
        }
    }

    #[test]
    fn terminal_scrollback_requires_tab_name() {
        // `--tab-name` is a required clap arg (the field is a plain String),
        // so omitting it is a parse error, not a runtime one.
        assert!(CsCli::try_parse_from(["cs", "terminal", "scrollback"]).is_err());
    }

    #[test]
    fn parses_terminal_team_load_script() {
        let cli = CsCli::parse_from(["cs", "terminal", "team", "load", "alpha", "--script"]);
        match cli.action {
            ShellAction::Terminal {
                action:
                    TerminalAction::Team {
                        action: TeamAction::Load { dir, script, .. },
                    },
            } => {
                assert_eq!(dir, "alpha");
                assert!(script);
            }
            other => panic!("unexpected parse: {other:?}"),
        }
    }

    #[test]
    fn resolve_team_dir_joins_relative_against_cwd_under_workspace() {
        // A bare name resolves cwd-relative within the workspace; "." is the
        // cwd's own workspace-relative path; a "../" normalizes lexically.
        // Synthetic non-existent paths exercise the canonicalize fallback, so
        // the test is filesystem-free and deterministic.
        assert_eq!(
            resolve_team_dir_in("alpha", Some("/ws"), Path::new("/ws/a/b")).unwrap(),
            "a/b/alpha"
        );
        assert_eq!(
            resolve_team_dir_in(".", Some("/ws"), Path::new("/ws/teams/x")).unwrap(),
            "teams/x"
        );
        assert_eq!(
            resolve_team_dir_in("../y", Some("/ws"), Path::new("/ws/teams/x")).unwrap(),
            "teams/y"
        );
    }

    #[test]
    fn resolve_team_dir_accepts_absolute_under_workspace_and_keeps_root_name() {
        assert_eq!(
            resolve_team_dir_in("/ws/teams/alpha", Some("/ws"), Path::new("/ws/elsewhere"))
                .unwrap(),
            "teams/alpha"
        );
        // A bare name at the workspace root stays that name.
        assert_eq!(
            resolve_team_dir_in("alpha", Some("/ws"), Path::new("/ws")).unwrap(),
            "alpha"
        );
    }

    #[test]
    fn resolve_team_dir_rejects_outside_workspace_and_bare_root() {
        // Escapes the workspace -> error.
        assert!(resolve_team_dir_in("/etc", Some("/ws"), Path::new("/ws")).is_err());
        assert!(resolve_team_dir_in("../../etc", Some("/ws"), Path::new("/ws")).is_err());
        // "." at the root resolves to the workspace root itself -> error (a
        // team needs a subdirectory; the server rejects an empty dir too).
        assert!(resolve_team_dir_in(".", Some("/ws"), Path::new("/ws")).is_err());
        assert!(resolve_team_dir_in("   ", Some("/ws"), Path::new("/ws")).is_err());
    }

    #[test]
    fn resolve_team_dir_passes_through_without_a_workspace_env() {
        // Outside a chan terminal ($CHAN_WORKSPACE_PATH unset) the dir is sent
        // verbatim, preserving the prior workspace-relative contract.
        assert_eq!(
            resolve_team_dir_in("teams/alpha", None, Path::new("/anywhere")).unwrap(),
            "teams/alpha"
        );
    }

    #[test]
    fn team_config_input_requires_exactly_one_source() {
        // Both sources -> error; neither -> error. (The single-source happy
        // paths read a file / stdin, exercised end-to-end by the handler.)
        assert!(read_team_config_input(Some("a.toml".into()), true).is_err());
        assert!(read_team_config_input(None, false).is_err());
    }
}
