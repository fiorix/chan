use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use chan_shell::ShellAction;
use chan_workspace::{SearchAggression, WorkspaceSearchRequest};
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::Shell;

use crate::help::{
    CHAN_ABOUT, CHAN_AFTER_HELP, CHAN_LONG_ABOUT, DUMP_SKILL_AFTER_HELP, DUMP_SKILL_LONG_ABOUT,
    SERVE_AFTER_HELP, SERVE_LONG_ABOUT,
};
use crate::{help, ServiceKind, DEFAULT_PORT};

/// `--version` output: the release version, then the build that produced it.
///
/// Appended rather than substituted, so the packaging consumers that match on
/// the version substring still match --
/// `packaging/distros/homebrew/Formula/chan.rb.in:45` asserts it and
/// `.github/workflows/publish-downstream.yml:905` greps for it.
const CHAN_VERSION: &str = concat!(
    env!("CARGO_PKG_VERSION"),
    " (build ",
    env!("CHAN_BUILD_ID"),
    ")"
);

#[derive(Parser, Debug)]
// `about` is set here rather than inherited from the Cargo description:
// the description is package metadata and runs long, while this string is
// one line of `chan --help`.
#[command(version = CHAN_VERSION, about = CHAN_ABOUT, long_about = CHAN_LONG_ABOUT)]
#[command(after_long_help = CHAN_AFTER_HELP)]
// The `cs` tree resolves every action from an unambiguous prefix
// (iproute2 style); this tree speaks the same grammar so `chan w ls` /
// `chan de status` work like `cs te l`. clap does not propagate the
// setting to children, so every noun family below carries its own copy;
// `subcommand_prefixes_resolve_iproute2_style` pins the contract.
#[command(infer_subcommands = true)]
pub(super) struct Cli {
    /// Increase logging. -v = info, -vv = debug, -vvv = trace.
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub(super) verbose: u8,

    #[command(subcommand)]
    pub(super) command: Command,
}

#[derive(Subcommand, Debug)]
pub(super) enum Command {
    /// Serve a workspace (same as `chan workspace serve`)
    #[command(long_about = SERVE_LONG_ABOUT, visible_alias = "open")]
    #[command(after_long_help = &*SERVE_AFTER_HELP)]
    Serve {
        #[command(flatten)]
        args: ServeCliArgs,
    },
    /// Stop serving a workspace (same as `chan workspace close`)
    #[command(long_about = help::CHAN_CLOSE)]
    #[command(after_long_help = help::CHAN_CLOSE_AFTER)]
    Close {
        #[command(flatten)]
        args: CloseCliArgs,
        /// Also drop registration and metadata (`chan workspace forget`).
        #[arg(long)]
        forget: bool,
    },
    /// Show which registered workspaces are served, and by what
    #[command(long_about = help::CHAN_PS)]
    #[command(after_long_help = help::CHAN_PS_AFTER)]
    Ps {
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Manage the workspace registry and a workspace's content
    ///
    /// Registers, lists, and forgets workspaces, and drives one
    /// workspace's content: index, reports, search, graph, status,
    /// metadata, and contacts.
    ///
    /// Every registry mutation and content operation routes through the
    /// workspace library, so atomic writes, the path sandbox, the
    /// special-file refusal, and the cross-process writer lock apply
    /// uniformly.
    #[command(verbatim_doc_comment)]
    #[command(infer_subcommands = true)]
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
    },
    /// Run this machine's devserver, or manage connections to remote ones
    #[command(long_about = help::CHAN_DEVSERVER)]
    #[command(after_long_help = help::CHAN_DEVSERVER_AFTER)]
    #[command(infer_subcommands = true)]
    Devserver {
        #[command(subcommand)]
        action: DevserverAction,
    },
    /// Drive the current chan window from its terminal (the `cs` alias).
    ///
    /// Reached as `chan shell <action>` or, under the `cs` name on PATH,
    /// as `cs <action>`. Every action targets the chan window that
    /// spawned this terminal ($CHAN_WINDOW_ID + $CHAN_CONTROL_SOCKET);
    /// outside a chan terminal they error clearly.
    ///
    /// Most installs put `cs` on your PATH. If `command -v cs` finds
    /// nothing, link it once yourself:
    ///
    ///   ln -s "$(command -v chan)" ~/.local/bin/cs
    ///
    /// iproute2-style prefix matching: the cs actions disambiguate on
    /// their first letter, so `cs o` / `cs g` / `cs d` / `cs t` resolve
    /// to open / graph / dashboard / terminal.
    #[command(infer_subcommands = true)]
    Shell {
        #[command(subcommand)]
        action: ShellAction,
    },
    /// Read or write settings outside the workspace (editor.*, server.*)
    #[command(long_about = help::CHAN_CONFIG)]
    #[command(after_long_help = help::CHAN_CONFIG_AFTER)]
    #[command(infer_subcommands = true)]
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Generate shell completion scripts.
    Completions {
        /// Shell to generate completions for.
        shell: Shell,
    },
    /// Print an agent-facing manual, built from chan's own help
    #[command(long_about = DUMP_SKILL_LONG_ABOUT)]
    #[command(after_long_help = DUMP_SKILL_AFTER_HELP)]
    DumpSkill {
        #[command(flatten)]
        args: chan_shell::DumpSkillArgs,
    },
    /// Upgrade chan in place
    ///
    /// Reads release metadata from chan.app, downloads the selected CLI
    /// asset, verifies its SHA256, and atomically replaces the running
    /// binary.
    ///
    /// Set `CHAN_UPDATE_CHECK=0` to silence the banner that fires on
    /// `chan serve` startup.
    #[command(verbatim_doc_comment)]
    Upgrade {
        /// Skip the confirmation prompt.
        #[arg(short = 'y', long)]
        yes: bool,
        /// Only check + report; do not download or replace the
        /// binary. Returns success in both directions.
        #[arg(long, verbatim_doc_comment)]
        check: bool,
        /// Pin a specific version instead of querying latest metadata.
        /// Pass a bare version, for example `0.14.0`.
        #[arg(long, verbatim_doc_comment)]
        version: Option<String>,
    },
    /// Internal: run the background `--service=chan` daemon child. The parent
    /// process detaches this command, redirects stdout/stderr to the devserver
    /// log, and passes any tunnel token through the environment only.
    #[command(name = "__devserver-daemon", hide = true)]
    DevserverDaemon {
        /// Host address to bind.
        #[arg(long)]
        bind: IpAddr,
        /// Port to bind.
        #[arg(long)]
        port: u16,
        /// Tunnel endpoint URL. The token, if any, is read only from
        /// CHAN_TUNNEL_TOKEN.
        #[arg(long, env = "CHAN_TUNNEL_URL", verbatim_doc_comment)]
        tunnel_url: Option<String>,
        /// Display name for the gateway roster; the parent passes the
        /// resolved value (explicit flag or hostname) through argv.
        #[arg(long, verbatim_doc_comment)]
        tunnel_devserver_name: Option<String>,
    },
    /// Internal: run the chan-llm MCP server on stdio against a
    /// workspace. Spawned by MCP clients so file edits route through
    /// chan-workspace's gates instead of touching the workspace directly.
    /// Not for end-user invocation.
    #[command(name = "__mcp", hide = true)]
    Mcp {
        /// Workspace root to expose. Must already be registered.
        path: PathBuf,
    },
    /// Internal: stdio bridge to the MCP server hosted in-process
    /// by a running `chan serve`. Connects to the per-server Unix-
    /// domain socket and pipes stdin/stdout through it. Used by the
    /// external MCP clients so agent child processes can reach the
    /// live workspace without trying to reopen it (which would deadlock
    /// against chan-workspace's per-workspace flock). Not for end-user
    /// invocation.
    #[command(name = "__mcp-proxy", hide = true)]
    McpProxy {
        /// Unix-domain socket path the running chan-server listens
        /// on. Resolved at request time by chan-server, embedded in
        /// the gemini settings.json / claude --mcp-config payload.
        socket: PathBuf,
    },
}

/// Subcommands for `chan devserver`. One noun, two faces, told apart by
/// their argument shape. The server-side verbs (run / start / stop /
/// restart / status / join / rotate-token) manage the devserver process on
/// THIS machine: a per-CHAN_HOME singleton addressed by service identity,
/// so they take no target. The client-side verbs (register, and the
/// connection verbs that ride the desktop) operate on the desktop
/// launcher's registry of REMOTE devservers, so they require a URL or
/// label target and a running chan-desktop.
#[derive(Subcommand, Debug)]
pub(super) enum DevserverAction {
    /// Run the devserver in this terminal (foreground, Ctrl-C to stop)
    Run {
        #[command(flatten)]
        args: DevserverServeArgs,
    },
    /// Start the background service and return
    ///
    /// Writes/refreshes its unit, enables it on boot where the backend
    /// supports that, and starts it. Idempotent when it is already
    /// running.
    #[command(verbatim_doc_comment)]
    Start {
        #[command(flatten)]
        args: DevserverServeArgs,
    },
    /// Stop the service AND disable it, then return
    ///
    /// The service does not come back on the next login or boot.
    /// Idempotent. A foreground devserver (`chan devserver run`) is
    /// stopped with Ctrl-C. Stops the devserver on THIS machine; to drop
    /// a connection to a remote one, see the launcher's Disconnect.
    #[command(verbatim_doc_comment)]
    Stop {
        #[command(flatten)]
        args: DevserverServeArgs,
    },
    /// Restart the service, then return
    ///
    /// Rewrites the unit / agent / pidfile first, so it picks up the
    /// current binary; an explicit --bind/--port rebinds, while omitting
    /// both preserves the running service's address. Starts the service
    /// if it is not already running.
    #[command(verbatim_doc_comment)]
    Restart {
        #[command(flatten)]
        args: DevserverServeArgs,
    },
    /// Report service state and its launch URL on a terminal, then exit
    ///
    /// The URL uses the persisted token and is not checked against the running
    /// service. Off a terminal, use --url to print it.
    #[command(verbatim_doc_comment)]
    Status {
        #[command(flatten)]
        args: DevserverServeArgs,
        /// Print the launch URL with its persisted token even when stdout is piped
        #[arg(long)]
        url: bool,
    },
    /// Ensure the service is running and stay attached
    ///
    /// Starts it if down, attaches if up, and blocks on its health until
    /// Ctrl-C. This is the "bring it up and watch it" form connect
    /// scripts use; on Ctrl-C it detaches and the service keeps running.
    #[command(verbatim_doc_comment)]
    Join {
        #[command(flatten)]
        args: DevserverServeArgs,
    },
    /// Rotate the devserver bearer token, then return
    ///
    /// Prints the new CHAN_DEVSERVER_TOKEN= marker plus /?t= URL. Reaches
    /// the running devserver's management API so the old token stops
    /// authorizing immediately; with no running server it rewrites the
    /// persisted config instead (a devserver still running elsewhere
    /// keeps its old token until restarted). The response to a suspected
    /// token leak. Browser tabs on the old ?t= URL must be reopened at
    /// the new one; every other client re-derives it.
    #[command(verbatim_doc_comment)]
    RotateToken {
        #[command(flatten)]
        args: DevserverServeArgs,
    },
    /// Register a remote devserver with the desktop launcher
    ///
    /// Adds the URL to chan-desktop's devserver registry and returns,
    /// without serving or dialing it; connecting is the launcher's
    /// Connect button. Needs the chan desktop app running on this
    /// machine.
    #[command(verbatim_doc_comment)]
    Register {
        /// The devserver URL (scheme://host[:port]).
        url: String,
        /// Optional label for the devserver's launcher section.
        #[arg(long)]
        name: Option<String>,
        /// Optional connect script the desktop runs before it dials the
        /// devserver.
        #[arg(long, verbatim_doc_comment)]
        script: Option<String>,
    },
    /// List the desktop launcher's registered devservers
    ///
    /// One row per registration with its live connection state. Rows
    /// synthesized from a gateway roster are marked; register / connect /
    /// disconnect / forget cannot touch those (the Gateways screen
    /// manages them). Needs the chan desktop app running.
    #[command(verbatim_doc_comment)]
    Ls {
        /// Emit machine-readable JSON:
        /// `{"devservers":[{url,label,status,gateway},...]}`.
        #[arg(long, verbatim_doc_comment)]
        json: bool,
    },
    /// Dial a registered devserver from the desktop
    ///
    /// Resolves TARGET (a registered URL or launcher label) and starts
    /// the desktop's connect: control script, token scrape, dial. Returns
    /// as soon as the connect is underway; sign-in or trust prompts
    /// surface in the launcher, which owns the progress. An unregistered
    /// URL is refused: register first. Needs the chan desktop app
    /// running.
    #[command(verbatim_doc_comment)]
    Connect {
        /// A registered devserver URL or launcher label.
        target: String,
    },
    /// Drop the desktop's connection to a devserver
    ///
    /// The registration row is kept and the remote devserver process
    /// keeps running; reconnect any time. Disconnecting an already
    /// disconnected row succeeds as a no-op. Needs the chan desktop app
    /// running.
    #[command(verbatim_doc_comment)]
    Disconnect {
        /// A registered devserver URL or launcher label.
        target: String,
    },
    /// Remove a devserver registration from the desktop launcher
    ///
    /// The undo of `chan devserver register`: drops the row, discarding
    /// its stored write-only token (re-registering needs the token
    /// again). A connected row is refused; disconnect first, or pass
    /// --force to disconnect and forget in one step. The remote devserver
    /// process keeps running either way. Needs the chan desktop app
    /// running.
    #[command(verbatim_doc_comment)]
    Forget {
        /// A registered devserver URL or launcher label.
        target: String,
        /// Disconnect a live connection first instead of refusing.
        #[arg(long)]
        force: bool,
    },
}

/// Flags shared by the server-side `chan devserver` verbs. One struct,
/// flattened into each verb, so every verb accepts the same address,
/// service, and tunnel flags.
#[derive(Args, Debug)]
pub(super) struct DevserverServeArgs {
    /// Host address to bind. Default 127.0.0.1 (loopback). Use
    /// 0.0.0.0 / :: to listen on all interfaces; there is no TLS and
    /// only a bearer-token gate, so reach a remote devserver over an
    /// `ssh -L` tunnel rather than binding it on a public interface.
    /// Omit on `restart` to preserve the running service's bound
    /// address instead of reverting to the default.
    #[arg(long, verbatim_doc_comment)]
    pub(super) bind: Option<IpAddr>,
    /// Port to bind. Default 8787, except a listening tunnel-mode
    /// devserver (systemd / CHAN_DEVSERVER_LISTEN=1) which defaults to an
    /// OS-assigned free port; preserved from the running service on
    /// `restart` when omitted.
    #[arg(long, verbatim_doc_comment)]
    pub(super) port: Option<u16>,
    /// Service backend. `auto` (the default, and what a bare `--service`
    /// resolves to) picks per-OS at runtime: under start / stop / restart /
    /// status / join it supervises via `systemd` (Linux), `launchd`
    /// (macOS), or the self-managed `chan` daemon (Windows); under `run`
    /// it runs in the FOREGROUND (Ctrl-C to stop). `none` forces that
    /// unsupervised foreground server. `chan` is the cross-OS self-managed
    /// background daemon (pidfile + flock). `systemd` (Linux) and `launchd`
    /// (macOS) are OS-backed background services and need a management
    /// verb.
    #[arg(long, value_enum, num_args = 0..=1, default_value = "auto", default_missing_value = "auto", verbatim_doc_comment)]
    pub(super) service: ServiceKind,
    /// Take over a wedged `--service=chan` daemon, or make a
    /// `--service=systemd restart` destructive instead of preserving live
    /// PTYs. Applies to `--service=chan` and `restart`.
    #[arg(long, verbatim_doc_comment)]
    pub(super) force: bool,
    /// Tunnel endpoint URL. Required with --tunnel-token. Prefer the
    /// CHAN_TUNNEL_URL env var for supervised or scripted deployments.
    #[arg(long, env = "CHAN_TUNNEL_URL", verbatim_doc_comment)]
    pub(super) tunnel_url: Option<String>,
    /// Personal access token (chan_pat_*) from the gateway identity
    /// origin (gw.chan.app for the hosted gateway). Setting this
    /// enables tunnel mode: the devserver dials the gateway and publishes
    /// every mounted workspace behind one registration. The devserver
    /// identity is resolved backend-side from the token; the display
    /// name shown in the roster comes from --tunnel-devserver-name.
    /// Prefer the CHAN_TUNNEL_TOKEN env var so the secret does not
    /// appear in `ps`.
    #[arg(long, env = "CHAN_TUNNEL_TOKEN", verbatim_doc_comment)]
    pub(super) tunnel_token: Option<String>,
    /// Display name for this devserver in the gateway roster (tunnel
    /// mode only). Defaults to this machine's hostname. Trimmed and
    /// capped at 64 bytes; when another of your devservers already
    /// holds the name, the gateway suffixes `-2`, `-3`, ...
    #[arg(long, env = "CHAN_TUNNEL_DEVSERVER_NAME", verbatim_doc_comment)]
    pub(super) tunnel_devserver_name: Option<String>,
    /// Run WITHOUT tunnel mode, ignoring any token in scope: the
    /// --tunnel-token flag, CHAN_TUNNEL_TOKEN in the environment, and
    /// (under --service=systemd) the PAT persisted in the installed
    /// unit. This is how a supervised tunnel devserver is converted
    /// back to a purely local one, and how a shell that inherited a
    /// token still starts a local devserver. Omit it and a supervised
    /// start / restart / join keeps the tunnel registration the unit
    /// already carries.
    #[arg(long, verbatim_doc_comment)]
    pub(super) no_tunnel: bool,
}

/// The `chan serve` / `chan workspace serve` argument set. One struct,
/// flattened into both spellings, so the elevated form and the family
/// form parse and behave identically by construction.
#[derive(Args, Debug, PartialEq)]
pub(super) struct ServeCliArgs {
    /// A local workspace PATH. Required; a URL is refused with a
    /// pointer at `chan devserver register`.
    #[arg(value_hint = clap::ValueHint::AnyPath, verbatim_doc_comment)]
    pub(super) path: Option<String>,
    /// Serve the given path verbatim instead of suggesting
    /// the enclosing VCS repository root. Without this flag, `chan
    /// serve` refuses to start when the workspace path lives inside
    /// a Git / Mercurial / Subversion working tree (exit 70 +
    /// `chan-error: vcs-parent` marker on stderr) because the
    /// repo root is almost always a better workspace root: it
    /// keeps cross-file links, the graph, and search aligned
    /// with the project boundary. Pass `--here` when you
    /// genuinely want to scope the workspace to a subdir.
    #[arg(long, verbatim_doc_comment)]
    pub(super) here: bool,
    /// Host address to bind. Default 127.0.0.1 (or ::1 with -6).
    /// Use 0.0.0.0 / :: to listen on all interfaces. chan has no
    /// TLS and only a bearer-token gate, so any non-loopback host
    /// exposes your workspace in plaintext on that network.
    #[arg(long, verbatim_doc_comment)]
    pub(super) host: Option<IpAddr>,
    /// Force IPv4-only listening. With no --host, binds 127.0.0.1.
    /// Mutually exclusive with -6.
    #[arg(
        short = '4',
        long = "ipv4",
        conflicts_with = "ipv6",
        verbatim_doc_comment
    )]
    pub(super) ipv4: bool,
    /// Force IPv6-only listening. With no --host, binds ::1.
    /// Mutually exclusive with -4.
    #[arg(short = '6', long = "ipv6", verbatim_doc_comment)]
    pub(super) ipv6: bool,
    /// Port to bind.
    #[arg(long, default_value_t = DEFAULT_PORT)]
    pub(super) port: u16,
    /// URL path prefix to mount the server under. Lets a reverse
    /// proxy multiplex many `chan serve` instances under one host
    /// (e.g. `workspace.example.com/{user}/`). Canonicalized to
    /// `/seg[/seg...]` with `[A-Za-z0-9-]+` segments; trailing
    /// slashes and `//` runs are tolerated. Anything else is
    /// rejected.
    #[arg(long, verbatim_doc_comment)]
    pub(super) prefix: Option<String>,
    /// Idle timeout before the server triggers a graceful
    /// shutdown. Accepts `30s`, `5m`, `1h`. Useful for systemd
    /// socket-activated deployments where many idle instances
    /// stack on one host. Without this flag the server stays
    /// resident indefinitely.
    #[arg(long, value_parser = parse_idle_timeout, verbatim_doc_comment)]
    pub(super) timeout: Option<Duration>,
    /// Skip the bearer-token gate. Local dev only;
    /// never expose a no-token server on a shared machine.
    #[arg(long, verbatim_doc_comment)]
    pub(super) no_token: bool,
    /// Do not open the system default browser when the server is
    /// ready. The URL is still printed; useful for shells that
    /// host the UI in their own window (chan-desktop) or for
    /// headless / scripted invocations.
    #[arg(long, verbatim_doc_comment)]
    pub(super) no_browser: bool,
    /// Search indexer resource profile. Overrides
    /// `server.search.aggression` for this run.
    #[arg(long, value_parser = parse_search_aggression, verbatim_doc_comment)]
    pub(super) search_aggression: Option<SearchAggression>,
    /// Refuse settings writes: the server this command binds answers
    /// 403 on its settings-write routes (PATCH /api/config, POST
    /// /api/storage/reset and POST /api/index/rebuild among them).
    /// Settings reads stay open. Only a server bound here enforces
    /// this, so a serve that would hand the workspace to chan-desktop
    /// or a devserver is refused: serve it with --standalone. For
    /// kiosk-style deployments (shared workstation, demo box) where
    /// the workspace owner is not the operator at the keyboard.
    #[arg(long, verbatim_doc_comment)]
    pub(super) no_settings: bool,
    /// Force a standalone server: bind this workspace directly and skip
    /// both the chan-desktop handoff and the local devserver
    /// registration, even when one is running on this box. Overrides the
    /// shell-parentage default. The escape hatch for automation and for
    /// serving a workspace the local devserver / desktop should not take
    /// over. Mutually exclusive with --desktop / --devserver.
    #[arg(long, conflicts_with_all = ["desktop", "devserver", "on"], verbatim_doc_comment)]
    pub(super) standalone: bool,
    /// Force the chan-desktop handoff: hand this workspace to a running
    /// same-user desktop to open in a native window, then exit. Overrides
    /// the shell-parentage default. Falls through to a standalone server
    /// when no desktop is reachable (skew, error, GUI absent, or
    /// CHAN_NO_DESKTOP_HANDOFF). Mutually exclusive with --standalone /
    /// --devserver.
    #[arg(long, conflicts_with_all = ["standalone", "devserver", "on"], verbatim_doc_comment)]
    pub(super) desktop: bool,
    /// Force local-devserver registration. A bare --devserver selects the
    /// only live same-user devserver, or the unique one whose library root
    /// matches this CLI's CHAN_HOME. --devserver=<port|url> selects one
    /// explicitly and refuses when it is not live. Refused from inside a
    /// devserver shell -- nesting a devserver in a devserver is unsupported;
    /// omit the flag to register with the current one. Mutually exclusive
    /// with --standalone / --desktop.
    #[arg(
        long,
        value_name = "PORT|URL",
        num_args = 0..=1,
        default_missing_value = "auto",
        require_equals = true,
        value_parser = parse_devserver_selector,
        conflicts_with_all = ["standalone", "desktop", "on"],
        verbatim_doc_comment
    )]
    pub(super) devserver: Option<DevserverSelector>,
    /// Serve PATH on a REGISTERED remote devserver instead of here. TARGET
    /// is that devserver's URL or launcher label as `chan devserver ls`
    /// shows it, resolved by the desktop; ambiguity refuses. PATH is a path
    /// on that machine, passed verbatim (absolute). A local devserver PORT
    /// belongs to --devserver=<port|url>, not here. Needs the chan desktop
    /// app running and the devserver connected; takes no local serve flag.
    #[arg(
        long,
        value_name = "TARGET",
        value_parser = parse_on_target,
        conflicts_with_all = [
            "standalone", "desktop", "devserver", "here", "host", "ipv4", "ipv6",
            "port", "prefix", "timeout", "no_token", "no_browser",
            "search_aggression", "no_settings",
        ],
        verbatim_doc_comment
    )]
    pub(super) on: Option<String>,
}

/// The `chan close` / `chan workspace close` argument set. One struct,
/// flattened into both spellings, so the elevated form and the family form
/// cannot drift.
#[derive(Args, Debug)]
pub(super) struct CloseCliArgs {
    /// Workspace root to stop serving.
    #[arg(value_hint = clap::ValueHint::AnyPath)]
    pub(super) path: PathBuf,
    /// Close PATH on a REGISTERED remote devserver instead of here: TARGET
    /// is its URL or launcher label as `chan devserver ls` shows it, PATH
    /// is the workspace's path on that machine. The devserver's own
    /// live-terminal guard applies; the workspace stays registered there.
    #[arg(long, value_name = "TARGET", value_parser = parse_on_target, verbatim_doc_comment)]
    pub(super) on: Option<String>,
}

/// The `chan workspace forget` argument set.
#[derive(Args, Debug)]
pub(super) struct ForgetCliArgs {
    /// Workspace root to unregister.
    #[arg(value_hint = clap::ValueHint::AnyPath)]
    pub(super) path: PathBuf,
    /// Forget PATH on a REGISTERED remote devserver instead of here: TARGET
    /// is its URL or launcher label as `chan devserver ls` shows it, PATH
    /// is the workspace's path on that machine. The devserver unmounts and
    /// drops the registration (files on that machine untouched); its
    /// live-terminal guard applies.
    #[arg(long, value_name = "TARGET", value_parser = parse_on_target, verbatim_doc_comment)]
    pub(super) on: Option<String>,
}

#[derive(Args, Debug, Clone, Default)]
pub(super) struct WorkspaceTargets {
    /// Registered workspace selector: canonical path, metadata key, or unique
    /// display name. Repeat to query several workspaces in order.
    #[arg(
        long = "workspace",
        value_name = "SELECTOR",
        conflicts_with = "all_workspaces"
    )]
    pub(super) workspaces: Vec<String>,
    /// Query every registered workspace in canonical-root order.
    #[arg(long)]
    pub(super) all_workspaces: bool,
}

#[derive(Args, Debug, Clone)]
pub(super) struct WorkspaceGraphArgs {
    /// Exact typed traversal seed. Repeat for multiple seeds.
    #[arg(long = "from", value_name = "TYPE:VALUE", required = true)]
    from: Vec<String>,
    /// Traversal depth; defaults to 1 for the required --from seeds.
    #[arg(long)]
    depth: Option<u8>,
    /// Traversal direction: auto, out, in, or both.
    #[arg(long, value_name = "DIRECTION")]
    direction: Option<String>,
    /// Relationship kind to retain: link, tag, mention, language, contains.
    #[arg(long = "edge-kind", value_name = "KIND")]
    edge_kinds: Vec<String>,
    /// Accepted search-result limit; has no effect on graph traversal.
    /// Use --node-limit and --edge-limit to bound the graph.
    #[arg(long)]
    limit: Option<u32>,
    /// Graph node limit.
    #[arg(long)]
    node_limit: Option<u32>,
    /// Graph relationship limit.
    #[arg(long)]
    edge_limit: Option<u32>,
}

impl WorkspaceGraphArgs {
    pub(super) fn to_request(&self) -> Result<WorkspaceSearchRequest> {
        chan_shell::WorkspaceSearchArgs {
            query: Vec::new(),
            from: self.from.clone(),
            domains: Vec::new(),
            depth: self.depth,
            direction: self.direction.clone(),
            edge_kinds: self.edge_kinds.clone(),
            limit: self.limit,
            node_limit: self.node_limit,
            edge_limit: self.edge_limit,
        }
        .to_request()
    }
}

/// Subcommands for `chan workspace`. Groups the workspace-registry
/// operations (add / ls / forget) with the per-workspace content
/// operations (index / reports / search / graph / status / metadata /
/// contacts) under one verb, so the top-level surface carries only the
/// process-lifecycle and app-level commands (serve, close, devserver,
/// config, ...). Mirrors the `IndexAction` / `ReportsAction`
/// sub-enum pattern.
#[derive(Subcommand, Debug)]
pub(super) enum WorkspaceAction {
    /// Register a directory as a chan workspace
    ///
    /// The baseline always runs: a filesystem walk, a markdown read, the
    /// documentation graph, and the BM25 index. Semantic search is an
    /// optional layer, off by default to keep workspaces lean. Code
    /// reports are on by default for new workspaces; `chan workspace
    /// reports disable` turns them off.
    ///
    /// Registering alone does not serve the workspace. `chan serve PATH`
    /// registers and serves in one step, which is the usual way in.
    #[command(verbatim_doc_comment)]
    Add {
        /// Directory to register as a workspace.
        path: PathBuf,
        /// Enable per-workspace semantic search (BGE-small
        /// dense vectors). Per-workspace footprint; needs the shared
        /// model (`chan workspace index download-model`). Off by
        /// default.
        #[arg(long = "semantic-search", verbatim_doc_comment)]
        semantic_search: bool,
        /// Force-enable per-workspace chan-reports (language
        /// detection + SLOC + COCOMO). Per-workspace footprint;
        /// maintained incrementally from filesystem events. Reports
        /// are already on by default for new workspaces; the flag
        /// persists the setting explicitly and runs the kickoff
        /// scan at add time.
        #[arg(long = "reports", verbatim_doc_comment)]
        reports: bool,
    },
    /// List registered workspaces, most-recent first.
    Ls {
        /// Emit machine-readable JSON:
        /// `{"workspaces":[{path,metadata_key,last_seen_at},...]}`.
        /// `last_seen_at` is RFC3339 UTC. The text format is
        /// unchanged when this flag is omitted.
        #[arg(long, verbatim_doc_comment)]
        json: bool,
    },
    /// Serve a workspace, registering it first if needed
    #[command(long_about = SERVE_LONG_ABOUT)]
    #[command(after_long_help = &*SERVE_AFTER_HELP)]
    Serve {
        #[command(flatten)]
        args: ServeCliArgs,
    },
    /// Stop serving a workspace
    #[command(long_about = help::CHAN_CLOSE)]
    #[command(after_long_help = help::CHAN_CLOSE_AFTER)]
    Close {
        #[command(flatten)]
        args: CloseCliArgs,
    },
    /// Stop serving a workspace, then forget it from the registry
    #[command(long_about = help::CHAN_FORGET)]
    #[command(after_long_help = help::CHAN_FORGET_AFTER)]
    Forget {
        #[command(flatten)]
        args: ForgetCliArgs,
    },
    /// Rebuild the search index and graph, and manage semantic search
    ///
    /// Subcommand-driven rather than a flat `chan workspace index PATH`
    /// so the embedding-model and semantic-toggle controls live next to
    /// the rebuild action, mirroring `chan config`.
    #[command(verbatim_doc_comment)]
    #[command(infer_subcommands = true)]
    Index {
        #[command(subcommand)]
        action: IndexAction,
    },
    /// Enable or disable per-workspace code reports
    ///
    /// Reports cover language detection, SLOC, and COCOMO. They are on by
    /// default for new workspaces; toggle them here, in the pre-flight
    /// dialog, or in Settings.
    #[command(verbatim_doc_comment)]
    #[command(infer_subcommands = true)]
    Reports {
        #[command(subcommand)]
        action: ReportsAction,
    },
    /// Search and traverse one or more registered workspaces.
    Search {
        #[command(flatten)]
        search: chan_shell::WorkspaceSearchArgs,
        #[command(flatten)]
        targets: WorkspaceTargets,
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
        /// Indent JSON output when --json is set.
        #[arg(long)]
        pretty: bool,
    },
    /// Traverse workspace graph relationships from exact typed seeds.
    Graph {
        #[command(flatten)]
        graph: WorkspaceGraphArgs,
        #[command(flatten)]
        targets: WorkspaceTargets,
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
        /// Indent JSON output when --json is set.
        #[arg(long)]
        pretty: bool,
    },
    /// Report workspace, index, graph, and code-report status.
    Status {
        /// Workspace root (required).
        path: Option<PathBuf>,
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Import and export chan metadata for a registered workspace.
    #[command(infer_subcommands = true)]
    Metadata {
        #[command(subcommand)]
        action: MetadataAction,
    },
    /// Manage contacts inside a workspace
    ///
    /// Import contacts from an external source as one markdown note per
    /// contact, carrying `chan.kind: contact` frontmatter so the editor
    /// and the graph classify them automatically.
    #[command(verbatim_doc_comment)]
    #[command(infer_subcommands = true)]
    Contacts {
        #[command(subcommand)]
        action: ContactsAction,
    },
}

#[derive(Subcommand, Debug)]
pub(super) enum ContactsAction {
    /// Import contacts from an external source as markdown notes
    ///
    /// Pick the source format with a sub-subcommand.
    #[command(verbatim_doc_comment)]
    #[command(infer_subcommands = true)]
    Import {
        #[command(subcommand)]
        source: ImportSource,
    },
}

#[derive(Subcommand, Debug)]
pub(super) enum ImportSource {
    /// Import a Google Contacts CSV as one markdown note per contact
    #[command(long_about = help::CHAN_WORKSPACE_CONTACTS_IMPORT_CSV)]
    #[command(after_long_help = help::CHAN_WORKSPACE_CONTACTS_IMPORT_CSV_AFTER)]
    Csv {
        /// Path to the CSV file.
        file: PathBuf,
        /// Workspace-relative directory where notes will land. Created
        /// if it does not exist. Use `""` to write at the workspace
        /// root.
        #[arg(long, verbatim_doc_comment)]
        into: String,
        /// Source provider's CSV format. Currently only "google".
        #[arg(long, default_value = "google")]
        provider: String,
        /// Parse and report what would be written; do not touch
        /// the workspace.
        #[arg(long, verbatim_doc_comment)]
        dry_run: bool,
        /// Replace existing files instead of skipping them. The
        /// per-contact line in the report changes from SKIPPED to
        /// OVERWROTE so it's clear which files moved.
        #[arg(long, verbatim_doc_comment)]
        overwrite: bool,
        /// Workspace root (required).
        /// Auto-registers the path if not already known, so
        /// `chan workspace contacts import csv ... --workspace /some/dir`
        /// works without a prior `chan workspace add`.
        #[arg(long, verbatim_doc_comment)]
        workspace: Option<PathBuf>,
    },
}

#[derive(Subcommand, Debug)]
pub(super) enum ConfigAction {
    /// Print one setting value, or all supported settings when no
    /// key is given.
    Get {
        /// Dotted key, e.g. `editor.theme` or
        /// `server.search.aggression`. Empty prints the full TOML.
        key: Option<String>,
        /// Emit JSON instead of a scalar / TOML body.
        #[arg(long)]
        json: bool,
    },
    /// Update a setting. Accepts `key=value` or `key value`.
    Set {
        /// Dotted key, with or without `=value` appended.
        key: String,
        /// Value to assign. Omit when `key` already contains `=value`.
        value: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub(super) enum MetadataAction {
    /// Export metadata for a registered workspace to a .tar.zst archive.
    Export {
        /// Workspace root.
        path: PathBuf,
        /// Output archive path. Must end in .tar.zst and not exist.
        archive: PathBuf,
    },
    /// Import metadata into a registered workspace from a .tar.zst archive.
    Import {
        /// Workspace root.
        path: PathBuf,
        /// Archive path created by `chan workspace metadata export`.
        archive: PathBuf,
        /// Rebuild the workspace index and graph after import.
        #[arg(long)]
        rescan: bool,
        /// Import even when archive SCM identity does not match.
        #[arg(long = "force-scm")]
        force_scm: bool,
    },
    /// Print the archive manifest without importing it.
    Inspect {
        /// Archive path created by `chan workspace metadata export`.
        archive: PathBuf,
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
}

/// Subcommands for `chan workspace index`. Subcommand-driven (rather than a
/// flat `chan workspace index <path>`) so the surface
/// covers rebuild, model download, semantic-search toggle, and
/// state inspection. The flat `chan workspace index <path>` form is not
/// accepted; use `chan workspace index rebuild <path>`.
///
/// Symmetric naming matches the `chan workspace reports
/// enable/disable` parallel pair so scripted callers can pattern-
/// match `<feature> enable / disable` across the surface.
#[derive(Subcommand, Debug)]
pub(super) enum IndexAction {
    /// Rebuild the search index and graph for a workspace
    ///
    /// Takes the workspace root either positionally or as `--path`, so a
    /// wrapper can pass `--path` uniformly across every subcommand here.
    /// At least one form must be supplied.
    #[command(verbatim_doc_comment)]
    Rebuild {
        /// Workspace root, positional form.
        path: Option<PathBuf>,
        /// Workspace root, flag form (synonym for the positional).
        #[arg(long = "path", value_name = "PATH")]
        path_flag: Option<PathBuf>,
    },
    /// Download the embedding model semantic search needs
    ///
    /// Lands in `<user-config>/chan/models/<model-name>/` and is shared by
    /// every workspace. Idempotent: a re-run with the model already
    /// present is a fast no-op.
    #[command(verbatim_doc_comment)]
    DownloadModel {
        /// HuggingFace model id, e.g. `BAAI/bge-small-en-v1.5`.
        #[arg(long, default_value = "BAAI/bge-small-en-v1.5")]
        model: String,
    },
    /// List curated embedding models accepted by chan.
    ListModels {
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Set the embedding model configured for a workspace.
    SetModel {
        /// Workspace root (required).
        #[arg(long)]
        path: Option<PathBuf>,
        /// Curated HuggingFace model id.
        #[arg(long)]
        model: String,
    },
    /// Turn on hybrid (lexical plus semantic) search for a workspace
    ///
    /// Refuses when the embedding model is not downloaded, and points at
    /// `chan workspace index download-model`. The opt-in persists in the
    /// workspace's index config, so it survives a restart.
    #[command(verbatim_doc_comment)]
    EnableSemantic {
        /// Workspace root (required).
        #[arg(long)]
        path: Option<PathBuf>,
    },
    /// Flip the workspace back to BM25-only.
    DisableSemantic {
        /// Workspace root (required).
        #[arg(long)]
        path: Option<PathBuf>,
    },
    /// Print the semantic-search state for a workspace
    ///
    /// Reports the current mode, whether the model is present, its path
    /// and size, and the workspace's opt-in flag.
    #[command(verbatim_doc_comment)]
    Status {
        /// Workspace root (required).
        #[arg(long)]
        path: Option<PathBuf>,
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
}

/// Subcommands for `chan workspace reports`. Mirrors
/// `IndexAction::{EnableSemantic,DisableSemantic}`'s shape so
/// scripted callers can pattern-match `<feature> enable / disable`
/// uniformly across the surface (`chan workspace index enable-semantic` /
/// `chan workspace reports enable`).
///
/// Reports default on for new workspaces; semantic search defaults off. This CLI, the preflight UI, and Settings expose the toggles.
#[derive(Subcommand, Debug)]
pub(super) enum ReportsAction {
    /// Enable code reports for a workspace
    ///
    /// Covers language detection, SLOC counts, and a COCOMO estimate, and
    /// triggers an initial scan when no persisted report exists.
    /// Idempotent: re-enabling is a no-op.
    #[command(verbatim_doc_comment)]
    Enable {
        /// Workspace root (required).
        #[arg(long, value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Disable code reports for a workspace
    ///
    /// Destructive: drops the persisted report, so re-enabling later
    /// triggers a fresh scan. Asks for confirmation on a terminal; pass
    /// `-y` to skip it. Without a terminal and without `-y` it refuses
    /// and exits nonzero, as does a declined prompt.
    #[command(verbatim_doc_comment)]
    Disable {
        /// Workspace root.
        #[arg(long, value_name = "PATH")]
        path: Option<PathBuf>,
        /// Skip the destructive-action confirmation prompt; required
        /// without a terminal.
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },
}

/// The `$ARGV0` the invoking shim left us, on the one platform that needs it.
///
/// Windows cannot hand a child a chosen `argv[0]`: there is no `exec -a` and no
/// POSIX symlink, so the `chan` / `cs` shims pass the name they were invoked
/// under in `$ARGV0` instead. Everywhere else the name arrives in `argv[0]`
/// itself, so the variable is not consulted and an inherited one cannot steer
/// the alias.
#[cfg(windows)]
fn shim_argv0() -> Option<std::ffi::OsString> {
    std::env::var_os("ARGV0")
}

/// See the Windows [`shim_argv0`]. Off Windows `argv[0]` is authoritative.
#[cfg(not(windows))]
fn shim_argv0() -> Option<std::ffi::OsString> {
    None
}

/// Parse process-facing `args` into the clap [`Cli`], resolving the `cs` alias.
///
/// Environment access stays at this edge so [`parse_cli_with_arg0`] keeps the
/// alias decision deterministic.
pub(super) fn parse_cli<I, T>(args: I) -> Cli
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    parse_cli_with_arg0(shim_argv0(), args)
}

/// Parse caller-supplied `args` into the clap [`Cli`] using an explicit shim
/// name, as [`shim_argv0`] resolves it.
///
/// A non-empty shim name wins, because the platform that supplies one cannot
/// express the name any other way. An absent or empty one falls back to the
/// passed `args`, never the process argv, so chan-desktop can preserve its own
/// argument source. A `cs` stem parses through chan-shell's own `cs` parser,
/// keeping every front end on the same help and action surface, so `cs terminal
/// list` is `chan shell terminal list`. The original argv still goes to clap so
/// its program-name slot is untouched.
fn parse_cli_with_arg0<I, T>(argv0_env: Option<std::ffi::OsString>, args: I) -> Cli
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    let argv: Vec<std::ffi::OsString> = args.into_iter().map(Into::into).collect();
    let arg0 = chan_shell::resolve_arg0(argv0_env, || argv.first().cloned().unwrap_or_default());
    if !chan_shell::invoked_as_cs(&arg0) {
        return Cli::parse_from(argv);
    }
    let cs = chan_shell::parse_cs(argv);
    Cli {
        verbose: cs.verbose,
        command: Command::Shell { action: cs.action },
    }
}

pub(super) fn cmd_completions(shell: Shell) -> Result<()> {
    let mut cmd = Cli::command();
    let bin_name = cmd.get_name().to_string();
    clap_complete::generate(shell, &mut cmd, bin_name, &mut std::io::stdout());
    Ok(())
}

/// Parse a `--timeout` value: an unsigned integer plus a `s` / `m`
/// / `h` suffix. Reject zero so a typo doesn't get the server killed
/// on the first activity check. We deliberately don't pull the
/// `humantime` crate for this; the accepted shapes are the only ones
/// that matter for systemd service files (`OnInactiveSec=` style).
fn parse_idle_timeout(s: &str) -> Result<Duration, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("empty timeout".into());
    }
    let (num, unit) = match s.as_bytes().last() {
        Some(b's' | b'm' | b'h') => s.split_at(s.len() - 1),
        _ => return Err(format!("expected suffix s|m|h, got {s:?}")),
    };
    let n: u64 = num
        .parse()
        .map_err(|e| format!("invalid timeout number {num:?}: {e}"))?;
    if n == 0 {
        return Err("timeout must be > 0".into());
    }
    Ok(match unit {
        "s" => Duration::from_secs(n),
        "m" => Duration::from_secs(n * 60),
        "h" => Duration::from_secs(n * 60 * 60),
        _ => unreachable!("suffix already validated"),
    })
}

fn parse_search_aggression(s: &str) -> Result<SearchAggression, String> {
    s.parse()
}

/// Optional value accepted by `chan serve --devserver[=<port|url>]`.
/// `Auto` is the bare flag; a URL is normalized to its effective port because
/// local discovery identifies instances by their bound port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DevserverSelector {
    Auto,
    Port(u16),
}

fn parse_devserver_selector(raw: &str) -> std::result::Result<DevserverSelector, String> {
    if raw == "auto" {
        return Ok(DevserverSelector::Auto);
    }
    if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        let port = raw
            .parse::<u16>()
            .map_err(|_| format!("invalid devserver port {raw:?}: expected 1..=65535"))?;
        return if port == 0 {
            Err("invalid devserver port 0: expected 1..=65535".into())
        } else {
            Ok(DevserverSelector::Port(port))
        };
    }
    if !raw.contains("://") {
        return Err(format!(
            "invalid devserver selector {raw:?}: expected a local port or loopback URL; a \
             registered devserver label belongs to --on {raw}"
        ));
    }
    let url =
        reqwest::Url::parse(raw).map_err(|e| format!("invalid devserver URL {raw:?}: {e}"))?;
    // Discovery selects a LOCAL instance by port, so a URL naming a non-local
    // host must refuse rather than silently matching whatever local instance
    // shares the port number.
    let host = url.host_str().unwrap_or_default();
    let host_is_local = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !host_is_local {
        return Err(format!(
            "devserver URL {raw:?} is not local (host {host:?}): local discovery selects an \
             instance on this machine by port; use a loopback URL or a bare port"
        ));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| format!("devserver URL {raw:?} has no port"))?;
    if port == 0 {
        return Err("invalid devserver port 0: expected 1..=65535".into());
    }
    Ok(DevserverSelector::Port(port))
}

/// `--on TARGET`: a registered devserver's URL or launcher label, resolved by
/// the desktop. Only the shape is checked here: an all-digit value is a
/// local devserver port, which belongs to `--devserver`, and is refused with
/// that pointer so the two flags never guess at each other's grammar.
fn parse_on_target(raw: &str) -> std::result::Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("--on needs a registered devserver URL or launcher label".into());
    }
    if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "--on {trimmed} is port-shaped: --on names a REGISTERED devserver by URL or \
             launcher label (see `chan devserver ls`); a live local devserver port belongs to \
             --devserver={trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{test_env, BUILD_ID};

    #[test]
    fn version_names_the_build_beside_the_release_version() {
        // The acceptance line: two builds from different commits have to be
        // distinguishable through `chan --version`. Between release cuts the
        // version alone cannot do it, so the build id is what separates them.
        let rendered = Cli::command().render_version().to_string();
        assert!(
            rendered.contains(&format!("(build {BUILD_ID})")),
            "--version does not name the build: {rendered}"
        );
    }

    #[test]
    fn version_still_carries_the_bare_release_version() {
        // The build id is APPENDED, never substituted. Two packaging
        // consumers match on the bare version substring and would break on a
        // rewritten line: publish-downstream.yml greps the Homebrew install's
        // `chan --version`, and the cask formula asserts the same.
        let rendered = Cli::command().render_version().to_string();
        assert!(
            rendered.contains(env!("CARGO_PKG_VERSION")),
            "--version lost the release version: {rendered}"
        );
    }

    fn assert_terminal_list(cli: Cli) {
        let Command::Shell { action } = cli.command else {
            panic!("expected shell command, got {:?}", cli.command);
        };
        let ShellAction::Terminal { action } = action else {
            panic!("expected terminal action, got {action:?}");
        };
        let chan_shell::TerminalAction::List { json, pretty } = action else {
            panic!("expected terminal list action, got {action:?}");
        };
        assert!(!json);
        assert!(!pretty);
    }

    fn assert_not_shell(cli: Cli) {
        assert!(
            !matches!(cli.command, Command::Shell { .. }),
            "unexpected shell command: {:?}",
            cli.command
        );
    }

    #[test]
    fn parse_cli_windows_chan_exe_honors_cs_argv0_env() {
        assert_terminal_list(parse_cli_with_arg0(
            Some(std::ffi::OsString::from("cs")),
            [r"C:\Program Files\chan\chan.exe", "terminal", "list"],
        ));
    }

    #[test]
    fn parse_cli_unix_cs_without_argv0_env() {
        assert_terminal_list(parse_cli_with_arg0(
            None,
            ["/usr/local/bin/cs", "terminal", "list"],
        ));
    }

    #[test]
    fn parse_cli_chan_argv0_env_is_not_aliased() {
        assert_not_shell(parse_cli_with_arg0(
            Some(std::ffi::OsString::from("chan")),
            ["chan", "completions", "bash"],
        ));
    }

    #[test]
    fn parse_cli_empty_argv0_env_falls_back_to_cs_argv() {
        assert_terminal_list(parse_cli_with_arg0(
            Some(std::ffi::OsString::new()),
            ["/usr/local/bin/cs", "terminal", "list"],
        ));
    }

    #[test]
    fn parse_cli_windows_chan_exe_without_argv0_env_is_not_aliased() {
        assert_not_shell(parse_cli_with_arg0(
            None,
            [r"C:\Program Files\chan\chan.exe", "completions", "bash"],
        ));
    }

    #[test]
    fn parse_cli_cs_exe_extension_is_aliased() {
        assert_terminal_list(parse_cli_with_arg0(
            None,
            [r"C:/Program Files/chan/cs.exe", "terminal", "list"],
        ));
    }

    #[test]
    fn devserver_selector_url_must_be_local() {
        assert_eq!(
            parse_devserver_selector("http://localhost:9999"),
            Ok(DevserverSelector::Port(9999))
        );
        assert_eq!(
            parse_devserver_selector("http://127.0.0.1:8787"),
            Ok(DevserverSelector::Port(8787))
        );
        assert_eq!(
            parse_devserver_selector("http://[::1]:9999"),
            Ok(DevserverSelector::Port(9999))
        );
        // A remote URL must refuse, not silently select a local instance
        // that happens to share the port number.
        let err = parse_devserver_selector("https://chan.example.com:9999").unwrap_err();
        assert!(err.contains("not local"), "{err}");
        let err = parse_devserver_selector("http://192.168.1.7:8787").unwrap_err();
        assert!(err.contains("not local"), "{err}");
    }

    #[test]
    fn serve_target_flags_are_mutually_exclusive() {
        // clap's `conflicts_with_all` rejects any two target flags at parse
        // time; one alone parses. The family spelling flattens the same
        // args struct, so it parses identically.
        assert!(Cli::try_parse_from(["chan", "serve", ".", "--standalone"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "serve", ".", "--desktop"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "serve", ".", "--devserver"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "workspace", "serve", ".", "--standalone"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "serve", ".", "--standalone", "--desktop"]).is_err());
        assert!(
            Cli::try_parse_from(["chan", "serve", ".", "--standalone", "--devserver"]).is_err()
        );
        assert!(Cli::try_parse_from(["chan", "serve", ".", "--desktop", "--devserver"]).is_err());
    }

    #[test]
    fn open_alias_preserves_serve_arguments_and_help() {
        let cases: &[&[&str]] = &[
            &[],
            &["--here"],
            &["--host", "127.0.0.2"],
            &["-4"],
            &["-6"],
            &["--port", "9000"],
            &["--prefix", "/notes"],
            &["--timeout", "5m"],
            &["--no-token"],
            &["--no-browser"],
            &["--search-aggression", "conservative"],
            &["--no-settings"],
            &["--standalone"],
            &["--desktop"],
            &["--devserver"],
            &["--devserver=9000"],
            &["--on", "lab"],
            &["-vv"],
        ];
        for flags in cases {
            let parse = |verb| {
                let cli = Cli::try_parse_from(
                    ["chan", verb, "/srv/notes"]
                        .into_iter()
                        .chain(flags.iter().copied()),
                )
                .unwrap();
                let Command::Serve { args } = cli.command else {
                    panic!("not serve")
                };
                (cli.verbose, args)
            };
            assert_eq!(parse("open"), parse("serve"), "{flags:?}");
        }
        assert!(Cli::try_parse_from(["chan", "workspace", "open", "."]).is_err());
        for argv in [
            ["chan", "open", "--help"].as_slice(),
            ["chan", "shell", "open", "--help"].as_slice(),
        ] {
            let help = Cli::try_parse_from(argv).unwrap_err().to_string();
            assert!(
                help.contains("chan open") && help.contains("cs open"),
                "{help}"
            );
        }
    }

    #[test]
    fn top_level_prefixes_keep_their_commands() {
        // Pin the original names independently of the live tree so a new
        // command or alias cannot silently steal an existing abbreviation.
        let names = [
            "serve",
            "close",
            "ps",
            "workspace",
            "devserver",
            "shell",
            "config",
            "completions",
            "dump-skill",
            "upgrade",
            "help",
            "__mcp",
            "__mcp-proxy",
            "__devserver-daemon",
        ];
        for name in names {
            for end in 1..=name.len() {
                let prefix = &name[..end];
                if names.contains(&prefix)
                    || names.iter().filter(|n| n.starts_with(prefix)).count() == 1
                {
                    let result = Cli::command()
                        .ignore_errors(true)
                        .try_get_matches_from(["chan", prefix]);
                    let expected = if names.contains(&prefix) {
                        prefix
                    } else {
                        name
                    };
                    if expected == "help" {
                        assert_eq!(
                            result.unwrap_err().kind(),
                            clap::error::ErrorKind::DisplayHelp
                        );
                        continue;
                    }
                    let matches = result.unwrap();
                    assert_eq!(matches.subcommand_name(), Some(expected), "prefix {prefix}");
                }
            }
        }
    }

    #[test]
    fn on_target_refuses_port_shaped_values_and_points_at_devserver() {
        // A port belongs to --devserver; the refusal says so. A label and a
        // URL are accepted as given (the desktop resolves them).
        for argv in [
            ["chan", "serve", "/srv/notes", "--on", "8787"],
            ["chan", "serve", "/srv/notes", "--on", "0"],
        ] {
            let err = Cli::try_parse_from(argv).unwrap_err().to_string();
            assert!(err.contains("--devserver"), "{err}");
        }
        assert!(Cli::try_parse_from(["chan", "serve", "/srv/notes", "--on", "lab"]).is_ok());
        assert!(Cli::try_parse_from([
            "chan",
            "serve",
            "/srv/notes",
            "--on",
            "http://127.0.0.1:8787"
        ])
        .is_ok());
    }

    #[test]
    fn devserver_selector_refuses_labels_and_points_at_on() {
        let err = Cli::try_parse_from(["chan", "serve", "/srv/notes", "--devserver=lab"])
            .unwrap_err()
            .to_string();
        assert!(err.contains("--on"), "{err}");
    }

    #[test]
    fn on_is_exclusive_with_every_local_serve_flag() {
        for extra in [
            &["--devserver"][..],
            &["--standalone"],
            &["--desktop"],
            &["--port", "9000"],
            &["--here"],
            &["--no-browser"],
        ] {
            let mut argv = vec!["chan", "serve", "/srv/notes", "--on", "lab"];
            argv.extend_from_slice(extra);
            assert!(
                Cli::try_parse_from(&argv).is_err(),
                "--on with {extra:?} must be refused"
            );
        }
    }

    #[test]
    fn close_and_forget_take_on_in_both_spellings() {
        let top = Cli::try_parse_from(["chan", "close", "/srv/notes", "--on", "lab"]).unwrap();
        let Command::Close { args, .. } = top.command else {
            panic!("expected close");
        };
        assert_eq!(args.path, PathBuf::from("/srv/notes"));
        assert_eq!(args.on.as_deref(), Some("lab"));
        let fam = Cli::try_parse_from(["chan", "workspace", "close", "/srv/notes", "--on", "lab"])
            .unwrap();
        let Command::Workspace {
            action: WorkspaceAction::Close { args },
        } = fam.command
        else {
            panic!("expected workspace close");
        };
        assert_eq!(args.on.as_deref(), Some("lab"));
        let forget =
            Cli::try_parse_from(["chan", "workspace", "forget", "/srv/notes", "--on", "lab"])
                .unwrap();
        let Command::Workspace {
            action: WorkspaceAction::Forget { args },
        } = forget.command
        else {
            panic!("expected workspace forget");
        };
        assert_eq!(args.on.as_deref(), Some("lab"));
        for argv in [
            &["chan", "serve", "/srv/notes", "--on", "lab"][..],
            &["chan", "workspace", "serve", "/srv/notes", "--on", "lab"],
        ] {
            let cli = Cli::try_parse_from(argv).unwrap();
            let on = match cli.command {
                Command::Serve { args } => args.on,
                Command::Workspace {
                    action: WorkspaceAction::Serve { args },
                } => args.on,
                other => panic!("expected serve, got {other:?}"),
            };
            assert_eq!(on.as_deref(), Some("lab"));
        }
        // `--on` adds no verb and no `--remove`: the pinned elevation holds.
        assert!(Cli::try_parse_from(["chan", "close", "/tmp/x", "--remove"]).is_err());
    }

    #[test]
    fn serve_devserver_selector_parses_bare_port_and_url() {
        let parse = |args: &[&str]| match Cli::try_parse_from(args).unwrap().command {
            Command::Serve { args } => (args.path, args.devserver),
            other => panic!("expected serve, got {other:?}"),
        };

        assert_eq!(parse(&["chan", "serve", "."]), (Some(".".into()), None));
        // require_equals keeps the following positional path out of the
        // optional flag value.
        assert_eq!(
            parse(&["chan", "serve", "--devserver", "."]),
            (Some(".".into()), Some(DevserverSelector::Auto))
        );
        assert_eq!(
            parse(&["chan", "serve", ".", "--devserver=9999"]),
            (Some(".".into()), Some(DevserverSelector::Port(9999)))
        );
        assert_eq!(
            parse(&[
                "chan",
                "serve",
                ".",
                "--devserver=http://127.0.0.1:9000/?t=secret",
            ]),
            (Some(".".into()), Some(DevserverSelector::Port(9000)))
        );
        for (selector, message) in [
            ("--devserver=0", "invalid devserver port 0"),
            ("--devserver=not-a-url", "invalid devserver selector"),
        ] {
            let error = Cli::try_parse_from(["chan", "serve", ".", selector]).unwrap_err();
            assert_eq!(error.kind(), clap::error::ErrorKind::ValueValidation);
            assert!(error.to_string().contains(message), "{error}");
        }
    }

    #[test]
    fn devserver_tunnel_url_has_no_domain_default() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver", "run"]);
        match cli.command {
            Command::Devserver {
                action: DevserverAction::Run { args },
            } => assert_tunnel_defaults_off(&args.tunnel_url, &args.tunnel_token),
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
    }

    /// Asserts the devserver tunnel defaults without rendering any received
    /// value: `tunnel_token` can carry a live `chan_pat_` credential, so a
    /// failure names the field and stays redacted.
    fn assert_tunnel_defaults_off(tunnel_url: &Option<String>, tunnel_token: &Option<String>) {
        assert!(
            tunnel_url.is_none(),
            "tunnel URL must default to unset (value redacted)"
        );
        // No token by default → tunnel mode stays off until opted in.
        assert!(
            tunnel_token.is_none(),
            "tunnel token must default to unset (value redacted)"
        );
    }

    /// Negative coverage for the redaction contract: a failing default-check
    /// must not leak the received value into the panic payload.
    #[test]
    fn tunnel_default_failure_never_renders_the_value() {
        const SENTINEL: &str = "chan_pat_test_sentinel_value";
        let panicked = std::panic::catch_unwind(|| {
            assert_tunnel_defaults_off(&None, &Some(SENTINEL.to_string()));
        });
        let payload = panicked.expect_err("the check must fail on a set token");
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .expect("assert! payload is a string");
        assert!(
            !message.contains(SENTINEL),
            "failure output must not render the token value"
        );
        assert!(message.contains("redacted"), "{message}");
    }

    /// `rotate-token` parses as its own verb; the retired flag form does
    /// not parse at all, so verb exclusivity is structural.
    #[test]
    fn devserver_rotate_token_verb_parses() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver", "rotate-token"]);
        assert!(matches!(
            cli.command,
            Command::Devserver {
                action: DevserverAction::RotateToken { .. }
            }
        ));
        assert!(Cli::try_parse_from(["chan", "devserver", "--rotate-token"]).is_err());
        assert!(Cli::try_parse_from(["chan", "devserver", "rotate-token", "--stop"]).is_err());
    }

    /// The management verbs parse as subcommands, carrying the shared
    /// server-side flags; the retired flag-verb spellings do not parse.
    #[test]
    fn devserver_management_verbs_parse() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver", "stop", "--service=systemd"]);
        match cli.command {
            Command::Devserver {
                action: DevserverAction::Stop { args },
            } => assert_eq!(args.service, ServiceKind::Systemd),
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
        let cli = Cli::parse_from(["chan", "devserver", "restart", "--service=systemd"]);
        match cli.command {
            Command::Devserver {
                action: DevserverAction::Restart { args },
            } => assert_eq!(args.service, ServiceKind::Systemd),
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
        // A bare `chan devserver` does not run a foreground server: the verb
        // is explicit, and flag-verb spellings are rejected.
        assert!(Cli::try_parse_from(["chan", "devserver"]).is_err());
        assert!(Cli::try_parse_from(["chan", "devserver", "--stop"]).is_err());
        assert!(Cli::try_parse_from(["chan", "devserver", "--start"]).is_err());
        assert!(Cli::try_parse_from(["chan", "devserver", "stop", "restart"]).is_err());
    }

    /// `--service` parses to an enum: absent OR a bare `--service` (no value)
    /// resolve to `Auto` (the per-OS default), `=auto`/`=none` and each explicit
    /// backend parse by name, on any of the server-side verbs.
    #[test]
    fn devserver_service_kind_parse() {
        let _env = test_env::ChanTestEnv::new();
        let kind = |args: &[&str]| match Cli::parse_from(args).command {
            Command::Devserver {
                action: DevserverAction::Run { args },
            } => args.service,
            other => panic!("expected Command::Devserver run, got {other:?}"),
        };
        // Absent, a bare `--service`, and `=auto` all resolve to the auto default.
        assert_eq!(kind(&["chan", "devserver", "run"]), ServiceKind::Auto);
        assert_eq!(
            kind(&["chan", "devserver", "run", "--service"]),
            ServiceKind::Auto
        );
        assert_eq!(
            kind(&["chan", "devserver", "run", "--service", "auto"]),
            ServiceKind::Auto
        );
        assert_eq!(
            kind(&["chan", "devserver", "run", "--service", "none"]),
            ServiceKind::None
        );
        assert_eq!(
            kind(&["chan", "devserver", "run", "--service", "chan"]),
            ServiceKind::Chan
        );
        assert_eq!(
            kind(&["chan", "devserver", "run", "--service", "systemd"]),
            ServiceKind::Systemd
        );
        assert_eq!(
            kind(&["chan", "devserver", "run", "--service", "launchd"]),
            ServiceKind::Launchd
        );
        // A bare `--service` at the end of the argv still resolves to Auto
        // on a management verb.
        match Cli::parse_from(["chan", "devserver", "join", "--service"]).command {
            Command::Devserver {
                action: DevserverAction::Join { args },
            } => assert_eq!(args.service, ServiceKind::Auto),
            other => panic!("expected Command::Devserver join, got {other:?}"),
        }
        match Cli::parse_from([
            "chan",
            "devserver",
            "status",
            "--service=systemd",
            "--force",
        ])
        .command
        {
            Command::Devserver {
                action: DevserverAction::Status { args, .. },
            } => {
                assert_eq!(args.service, ServiceKind::Systemd);
                assert!(args.force);
            }
            other => panic!("expected Command::Devserver status, got {other:?}"),
        }
    }

    #[test]
    fn devserver_status_url_flag_is_status_only() {
        let _env = test_env::ChanTestEnv::new();
        let status =
            Cli::try_parse_from(["chan", "devserver", "status", "--url", "--service=chan"]);
        match status {
            Ok(Cli {
                command:
                    Command::Devserver {
                        action: DevserverAction::Status { args, url },
                    },
                ..
            }) => {
                assert_eq!(args.service, ServiceKind::Chan);
                assert!(url, "status must accept --url");
            }
            _ => panic!("status must accept --url"),
        }
        assert!(
            Cli::try_parse_from(["chan", "devserver", "start", "--url"]).is_err(),
            "start must reject --url"
        );
    }

    #[test]
    fn devserver_tunnel_url_accepts_explicit_endpoint() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from([
            "chan",
            "devserver",
            "run",
            "--tunnel-url",
            "http://127.0.0.1:7777/v1/tunnel",
        ]);
        match cli.command {
            Command::Devserver {
                action: DevserverAction::Run { args },
            } => {
                assert_eq!(
                    args.tunnel_url.as_deref(),
                    Some("http://127.0.0.1:7777/v1/tunnel")
                );
            }
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
    }

    #[test]
    fn parse_idle_timeout_units() {
        assert_eq!(parse_idle_timeout("30s").unwrap(), Duration::from_secs(30));
        assert_eq!(parse_idle_timeout("5m").unwrap(), Duration::from_secs(300));
        assert_eq!(parse_idle_timeout("1h").unwrap(), Duration::from_secs(3600));
        assert_eq!(
            parse_idle_timeout("  10s  ").unwrap(),
            Duration::from_secs(10)
        );
    }

    #[test]
    fn parse_idle_timeout_rejects_bad_inputs() {
        assert!(parse_idle_timeout("").is_err());
        assert!(parse_idle_timeout("0s").is_err());
        assert!(parse_idle_timeout("0m").is_err());
        assert!(parse_idle_timeout("10").is_err()); // no unit
        assert!(parse_idle_timeout("10x").is_err()); // bad unit
        assert!(parse_idle_timeout("-5s").is_err()); // negative
        assert!(parse_idle_timeout("five s").is_err());
        assert!(parse_idle_timeout("1.5m").is_err()); // no fractional
    }

    #[test]
    fn parse_search_aggression_accepts_known_levels() {
        assert_eq!(
            parse_search_aggression("conservative").unwrap(),
            SearchAggression::Conservative
        );
        assert_eq!(
            parse_search_aggression("balanced").unwrap(),
            SearchAggression::Balanced
        );
        assert_eq!(
            parse_search_aggression("aggressive").unwrap(),
            SearchAggression::Aggressive
        );
        assert!(parse_search_aggression("turbo").is_err());
    }

    #[test]
    fn index_model_subcommands_parse() {
        let cli =
            Cli::try_parse_from(["chan", "workspace", "index", "list-models", "--json"]).unwrap();
        match cli.command {
            Command::Workspace {
                action:
                    WorkspaceAction::Index {
                        action: IndexAction::ListModels { json },
                    },
            } => assert!(json),
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "chan",
            "workspace",
            "index",
            "set-model",
            "--path",
            "/tmp/workspace",
            "--model",
            "BAAI/bge-base-en-v1.5",
        ])
        .unwrap();
        match cli.command {
            Command::Workspace {
                action:
                    WorkspaceAction::Index {
                        action: IndexAction::SetModel { path, model },
                    },
            } => {
                assert_eq!(path, Some(PathBuf::from("/tmp/workspace")));
                assert_eq!(model, "BAAI/bge-base-en-v1.5");
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn metadata_subcommands_parse() {
        let cli = Cli::try_parse_from([
            "chan",
            "workspace",
            "metadata",
            "export",
            "/tmp/workspace",
            "/tmp/meta.tar.zst",
        ])
        .unwrap();
        match cli.command {
            Command::Workspace {
                action:
                    WorkspaceAction::Metadata {
                        action: MetadataAction::Export { path, archive },
                    },
            } => {
                assert_eq!(path, PathBuf::from("/tmp/workspace"));
                assert_eq!(archive, PathBuf::from("/tmp/meta.tar.zst"));
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "chan",
            "workspace",
            "metadata",
            "import",
            "/tmp/workspace",
            "/tmp/meta.tar.zst",
            "--rescan",
            "--force-scm",
        ])
        .unwrap();
        match cli.command {
            Command::Workspace {
                action:
                    WorkspaceAction::Metadata {
                        action:
                            MetadataAction::Import {
                                path,
                                archive,
                                rescan,
                                force_scm,
                            },
                    },
            } => {
                assert_eq!(path, PathBuf::from("/tmp/workspace"));
                assert_eq!(archive, PathBuf::from("/tmp/meta.tar.zst"));
                assert!(rescan);
                assert!(force_scm);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn workspace_group_uses_ls_and_forget() {
        // The registry verbs live under `chan workspace`, spelled `ls`
        // and `forget`; `rm` is not a spelling.
        let cli = Cli::try_parse_from(["chan", "workspace", "ls", "--json"]).unwrap();
        match cli.command {
            Command::Workspace {
                action: WorkspaceAction::Ls { json },
            } => assert!(json),
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from(["chan", "workspace", "forget", "/tmp/workspace"]).unwrap();
        match cli.command {
            Command::Workspace {
                action: WorkspaceAction::Forget { args },
            } => assert_eq!(args.path, PathBuf::from("/tmp/workspace")),
            other => panic!("unexpected command: {other:?}"),
        }
        assert!(Cli::try_parse_from(["chan", "workspace", "rm", "/tmp/workspace"]).is_err());

        // The lifecycle pair parses under the family as it does elevated.
        let cli = Cli::try_parse_from(["chan", "workspace", "close", "/tmp/workspace"]).unwrap();
        match cli.command {
            Command::Workspace {
                action: WorkspaceAction::Close { args },
            } => assert_eq!(args.path, PathBuf::from("/tmp/workspace")),
            other => panic!("unexpected command: {other:?}"),
        }
        assert!(Cli::try_parse_from(["chan", "close", "/tmp/workspace"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "close", "/tmp/x", "--remove"]).is_err());
    }

    #[test]
    fn flat_workspace_subcommands_are_rejected() {
        // No back-compat aliases: the flat forms (`chan add`, `chan list`,
        // `chan index`, ...) must not parse as top-level commands. They
        // live under `chan workspace`.
        for argv in [
            ["chan", "add"].as_slice(),
            ["chan", "list"].as_slice(),
            ["chan", "remove"].as_slice(),
            ["chan", "forget"].as_slice(),
            ["chan", "index"].as_slice(),
            ["chan", "search"].as_slice(),
            ["chan", "metadata"].as_slice(),
            ["chan", "contacts"].as_slice(),
            ["chan", "register"].as_slice(),
            ["chan", "connect"].as_slice(),
            ["chan", "disconnect"].as_slice(),
            ["chan", "start"].as_slice(),
            ["chan", "stop"].as_slice(),
        ] {
            assert!(
                Cli::try_parse_from(argv).is_err(),
                "flat `{}` must not parse as a top-level command",
                argv[1],
            );
        }
    }

    #[test]
    fn subcommand_prefixes_resolve_iproute2_style() {
        // The chan tree speaks the same prefix grammar as `cs`: every
        // level sets `infer_subcommands`, so an unambiguous prefix
        // resolves at the top level, inside a noun family, and inside a
        // family's own subcommands. A regression here is a runtime break
        // clap won't flag at compile time.
        let cli = Cli::try_parse_from(["chan", "w", "ls"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Workspace {
                action: WorkspaceAction::Ls { .. }
            }
        ));

        let cli = Cli::try_parse_from(["chan", "se", "/tmp/workspace"]).unwrap();
        assert!(matches!(cli.command, Command::Serve { .. }));

        let cli = Cli::try_parse_from(["chan", "p", "--json"]).unwrap();
        assert!(matches!(cli.command, Command::Ps { json: true }));

        let cli = Cli::try_parse_from(["chan", "u", "--check"]).unwrap();
        assert!(matches!(cli.command, Command::Upgrade { check: true, .. }));

        let cli = Cli::try_parse_from(["chan", "du", "--list"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::DumpSkill {
                args: chan_shell::DumpSkillArgs { list: true, .. }
            }
        ));

        let cli = Cli::try_parse_from(["chan", "de", "reg", "http://dev.example:8787"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Devserver {
                action: DevserverAction::Register { .. }
            }
        ));

        let cli = Cli::try_parse_from(["chan", "con", "s", "editor.theme=dark"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Config {
                action: ConfigAction::Set { .. }
            }
        ));

        // Three levels deep: workspace -> index -> rebuild.
        let cli = Cli::try_parse_from(["chan", "w", "i", "r", "/tmp/workspace"]).unwrap();
        assert!(matches!(
            cli.command,
            Command::Workspace {
                action: WorkspaceAction::Index {
                    action: IndexAction::Rebuild { .. }
                }
            }
        ));
    }

    #[test]
    fn ambiguous_subcommand_prefixes_are_rejected() {
        // Refuse-over-guess, pinned per level: each prefix here matches
        // two or more sibling commands (the auto-generated `help`
        // counts as a sibling) and must error rather than resolve. The
        // trailing args are valid for one of the candidates, so a
        // silent guess toward it would turn the case green.
        for argv in [
            // serve / shell
            ["chan", "s", "/tmp/workspace"].as_slice(),
            // close / config / completions
            ["chan", "c", "/tmp/workspace"].as_slice(),
            // config / completions
            ["chan", "co", "get"].as_slice(),
            // devserver / dump-skill
            ["chan", "d", "status"].as_slice(),
            // workspace serve / search
            ["chan", "workspace", "se", "/tmp/workspace"].as_slice(),
            // workspace close / contacts
            ["chan", "workspace", "c", "/tmp/workspace"].as_slice(),
            // devserver start / stop / status
            ["chan", "devserver", "st"].as_slice(),
            // devserver restart / register
            ["chan", "devserver", "re"].as_slice(),
            // index set-model / status
            ["chan", "workspace", "index", "s"].as_slice(),
            // index download-model / disable-semantic
            ["chan", "workspace", "index", "d"].as_slice(),
        ] {
            // An ambiguity is refused as an unknown subcommand (clap never
            // guesses among several matches). The kind assertion tells a
            // refusal from a wrong guess, which `is_err()` could not: a
            // guess toward the arg-less candidate is an error too.
            let err = Cli::try_parse_from(argv).expect_err(&format!(
                "ambiguous prefix `{}` must be rejected, not guessed",
                argv.join(" "),
            ));
            assert_eq!(
                err.kind(),
                clap::error::ErrorKind::InvalidSubcommand,
                "ambiguous prefix `{}`: {err}",
                argv.join(" "),
            );
        }
    }

    #[test]
    fn every_subcommand_node_infers_prefixes() {
        // clap does not propagate `infer_subcommands` to children, so the
        // grammar holds only while every subcommand-bearing node sets it
        // itself. The setting is not readable from the built tree, so this
        // walk proves it behaviourally: at every node, the shortest prefix
        // that singles out each visible child (the auto `help` counts as a
        // sibling) must resolve, which it cannot on a node without
        // inference. A child whose every prefix is shared with a sibling
        // resolves only by its exact name and proves nothing; it is skipped.
        fn unique_prefix(name: &str, siblings: &[String]) -> Option<String> {
            (1..name.len()).find_map(|n| {
                let prefix = &name[..n];
                (siblings.iter().filter(|s| s.starts_with(prefix)).count() == 1)
                    .then(|| prefix.to_string())
            })
        }
        fn walk(cmd: &clap::Command, path: &[String]) {
            let names: Vec<String> = cmd
                .get_subcommands()
                .map(|s| s.get_name().to_string())
                .chain(std::iter::once("help".to_string()))
                .collect();
            for sub in cmd.get_subcommands() {
                if sub.is_hide_set() {
                    continue;
                }
                if let Some(prefix) = unique_prefix(sub.get_name(), &names) {
                    let mut argv: Vec<String> = vec!["chan".into()];
                    argv.extend(path.iter().cloned());
                    argv.push(prefix.clone());
                    if let Err(err) = Cli::try_parse_from(&argv) {
                        assert_ne!(
                            err.kind(),
                            clap::error::ErrorKind::InvalidSubcommand,
                            "`{}` does not resolve the prefix `{prefix}` of `{}`: {err}",
                            argv.join(" "),
                            sub.get_name()
                        );
                    }
                }
                let mut sub_path = path.to_vec();
                sub_path.push(sub.get_name().to_string());
                walk(sub, &sub_path);
            }
        }
        walk(&Cli::command(), &[]);
    }

    #[test]
    fn ps_command_parses() {
        let cli = Cli::try_parse_from(["chan", "ps", "--json"]).unwrap();
        match cli.command {
            Command::Ps { json } => assert!(json),
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn devserver_name_flag_parses() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from([
            "chan",
            "devserver",
            "run",
            "--tunnel-devserver-name",
            "office box",
        ]);
        match cli.command {
            Command::Devserver {
                action: DevserverAction::Run { args },
            } => assert_eq!(args.tunnel_devserver_name.as_deref(), Some("office box")),
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
    }
}
