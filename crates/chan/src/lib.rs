// chan: an AI-native workspace for your Markdown notes and projects.
//
// This library holds the whole `chan` CLI surface so two binaries can
// drive it: the standalone `chan` binary (`src/main.rs`, a thin shim
// calling `run(.., Personality::Standalone)`) and chan-desktop, which
// dispatches `chan` in-process when invoked through a `~/.local/bin/chan`
// shim (`Personality::Desktop`). The only behavioural fork between the two
// is the `Personality` passed to [`run`]: see `cmd_serve` (browser vs
// desktop handoff) and `chan upgrade` (CLI tarball replace vs desktop
// updater).
//
// The top-level surface carries the process-lifecycle and app-level
// commands; the workspace registry and per-workspace content operations
// are grouped under `chan workspace`:
//
//   chan workspace add <path>       register a directory as a chan
//                                   workspace in ~/.chan/config.toml
//   chan workspace ls [--json]      list registered workspaces,
//                                   most-recent first. --json emits
//                                   a stable machine-readable shape.
//   chan workspace rm <path>        drop a workspace from the registry
//                                   (filesystem contents untouched)
//   chan workspace index <path>     rebuild the search index + graph
//   chan workspace search <path> <query>
//                                   query the BM25 index
//   chan workspace graph <path>     inspect semantic or filesystem graph edges
//   chan workspace status [path]    report workspace/index/graph health,
//                                   and recovery readiness (ready/recovering)
//   chan workspace metadata export PATH ARCHIVE.tar.zst
//                                   export a workspace's chan metadata
//   chan workspace contacts import csv FILE --into DIR
//                                   import a Google Contacts CSV as one
//                                   markdown note per contact under DIR
//   chan open {PATH} [-4|-6] [--host H --port N]
//                                   register + serve a workspace. Defaults
//                                   to 127.0.0.1 (loopback only); -6 picks
//                                   ::1 instead. The embedded web editor
//                                   talks to this. With chan-desktop running
//                                   it hands the workspace to a native window.
//   chan open {URL} [--name --script]
//                                   register a devserver (scheme://host) with
//                                   the desktop instead of serving a path.
//   chan close {PATH} [--remove]    tear down a workspace's server; --remove
//                                   also forgets it from the registry.
//   chan config get [KEY]           print a preference value
//   chan config set KEY=VALUE       update a preference
//
// Anything that touches the registry / workspace contents goes through
// `chan_workspace::Library` and `chan_workspace::Workspace` so the library's
// invariants (atomic writes, path sandbox, special-file refusal,
// cross-process writer lock) apply uniformly.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chan_server::{EditorPrefs, EditorTheme, LineSpacing, ServeConfig, ServerConfig, ThemeChoice};
use chan_shell::ShellAction;
use chan_workspace::{
    KnownWorkspace, Library, MetadataExportOptions, MetadataImportOptions, RecoveryAction,
    SearchAggression, Workspace, WorkspaceReadiness, WorkspaceSearchRequest, WorkspaceSearchResult,
};
use clap::{Args, CommandFactory, Parser, Subcommand};
use clap_complete::Shell;
use serde::{Deserialize, Serialize};

mod update;

/// The build script's own rules. `build.rs` pulls this file in with
/// `include!` and is the only production consumer; mounting it here under
/// `cfg(test)` is what puts those rules under `cargo test`, which a build
/// script's own code otherwise never gets.
#[cfg(test)]
#[path = "build_id.rs"]
mod build_id;

/// `chan dump-skill`: the agent-facing skill document, rendered from the
/// clap trees so it cannot drift from the help it documents.
mod skill;

/// Long-form help for the `chan` commands, as consts.
mod help;

/// `chan open --help`, assembled at first use: the launcher catalog, then
/// the generated chord table, then the worked examples. Composed at
/// runtime rather than with `concat!` because the pieces are consts, not
/// literals, and the chord table has to stay a separate const for
/// `make shortcuts-check` to diff it against the generator.
static OPEN_AFTER_HELP: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "{OPEN_LAUNCHER}\nIN-APP KEYBINDINGS (Cmd = Ctrl on Linux / Windows):\n\n\
         {KEYBINDINGS_TABLE}\n{}",
        help::CHAN_OPEN_AFTER
    )
});

/// The `--service=chan` self-managed daemon: a cross-OS background devserver
/// guarded by a single-instance pidfile + flock (the systemd/launchd analog
/// where there is no OS supervisor, and the portable choice everywhere).
mod devserver_daemon;

/// Serialized ambient-`CHAN_*` isolation for env-reading tests and spawned
/// test children. Not `cfg(test)` because integration tests link this crate
/// without it.
#[doc(hidden)]
pub mod test_env;

/// Default listen port shared by `chan open` (standalone serve) and
/// `chan devserver`. Single-sourced so the two cannot drift: `cmd_serve` relies
/// on them being equal to recognize the "a devserver already owns 8787" bind
/// collision and print an actionable hint instead of a bare "address in use".
const DEFAULT_PORT: u16 = 8787;

/// The devserver's default bind when `--bind` is omitted and no running service
/// supplies one: loopback, matching the `--bind` help and the foreground default.
const DEFAULT_DEVSERVER_BIND: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// The in-app chord table, generated from
/// `web/packages/workspace-app/src/state/shortcuts.ts` (the single source
/// of truth for chan's chords) by
/// `node web/packages/workspace-app/scripts/shortcuts-table.mjs --serve-long-about`.
/// Paste that command's output here verbatim; `make shortcuts-check` fails
/// when the two drift. The native shell layers VS Code-shaped chords on
/// top of the browser set; those are documented in the same TS source.
///
/// The body opens on the quote's own line rather than after a `\`
/// continuation, because that escape eats the newline and every leading
/// space after it, which would strip the first row's table indent.
const KEYBINDINGS_TABLE: &str = "  App
  ---
  Command launcher                             Ctrl+Alt+K
  Settings                                     Cmd+,
  Search                                       Cmd+Shift+S
      (Ctrl+Alt+S on Linux / Windows)
  New terminal                                 Ctrl+Shift+T
      (Cmd+T on macOS desktop; or Mod+. t (Hybrid Nav))
  Reload window                                Cmd+R
      (Ctrl+Shift+R on Linux / Windows)
  Dismiss overlay                              Esc

  File
  ----
  Delete file or directory                     Backspace

  Panes
  -----
  Hybrid Nav                                   Cmd+.
  Flip pane side                               Ctrl+`
  Previous pane                                Alt+[
  Next pane                                    Alt+]
  Split right                                  Ctrl+Alt+/
  Split bottom                                 Ctrl+Alt+?

  Tabs
  ----
  Close tab                                    Ctrl+D
      (Cmd+W on macOS, Ctrl+Shift+W on the Linux / Windows desktop)
  Reopen closed tab                            Ctrl+Alt+Shift+T
      (Cmd+Shift+T on macOS desktop)
  Next tab                                     Alt+Shift+]
  Previous tab                                 Alt+Shift+[
  Jump to tab N                                Ctrl+Alt+1..9

  Editor
  ------
  Show Source Code (toggle rendered/source)    Cmd+E
  Bold                                         Cmd+B
  Italic                                       Cmd+I
  Preview slide deck                           Cmd+Enter
  Present slide deck fullscreen                Cmd+Shift+Enter

  Terminal
  --------
  Copy selection                               Cmd+C
      (Ctrl+Shift+C on Linux / Windows)
  Paste                                        Cmd+V
      (Ctrl+Shift+V on Linux / Windows)
  Show/Hide Rich Prompt                        Cmd+Shift+P
      (Ctrl+Shift+P on Linux / Windows)
  Find in terminal                             Cmd+F
";

/// `chan open` long help: what serving a workspace actually does.
const OPEN_LONG_ABOUT: &str = r#"Register a directory as a chan workspace and serve it.

chan open PATH creates the directory if it does not exist, registers it
in the workspace registry, and serves it. Serving is load-bearing: a
bare `chan workspace add` only registers, while serving mounts the
workspace so the editor, terminal, search, graph, and a devserver can
reach it. The path is always explicit -- a bare `chan open` is an error.

Where it serves follows the shell's parentage and the live same-user
instances on the box. A chan-desktop terminal stays with the desktop; a
`chan devserver` terminal stays with that devserver. From a plain shell,
one live desktop or devserver wins automatically. With both kinds live,
the standalone CLI prefers the devserver and the desktop CLI preserves
its desktop behavior. With neither, the standalone CLI binds a local
server and stays in the foreground until Ctrl-C. --standalone, --desktop,
and --devserver force one target. --devserver=<port|url> names one local
devserver explicitly. A missing explicit devserver or an ambiguous set is
refused rather than guessed; other failed handoffs fall through to a
standalone server.

The standalone server binds 127.0.0.1:8787 by default (::1 with -6),
prints "chan is ready:" and the tokened URL on stderr, and opens the
system browser unless --no-browser. There is no TLS, only a
bearer-token gate, so a non-loopback --host serves your workspace in
plaintext and prints a warning saying so.

Without --here, chan open refuses a path inside a Git, Mercurial, or
Subversion working tree: it exits 70 and prints a `chan-error:
vcs-parent` marker on stderr, because the repository root is almost
always the better workspace root. --here serves the subdirectory
verbatim.

chan open URL (any scheme://host[:port] value) does something else
entirely: it registers a devserver with a running chan-desktop and
returns, without serving or dialing it -- connecting is the launcher's
Connect button. --name and --script apply only to that form.
"#;

/// The launcher catalog, which is the thing a user reaches for once the
/// window is up. Kept next to the chord table it introduces.
const OPEN_LAUNCHER: &str = r#"Inside the window, everything chan can do is one chord away. The command
launcher is Cmd+K on the macOS desktop app and Ctrl+Alt+K everywhere
else (web, Linux, Windows). Cmd+P is Team Work, not the launcher.

In a workspace or terminal window the contextual list is empty until you
type. Typing filters and ranks commands from the focused tab, pane, window,
and the library serving that window. The scope orbs browse those catalogs
directly; Computers opens its action branches without requiring a query.
The Computers SPA searches its authorized aggregate library instead.

Apps you can spawn from it:

  New terminal        a shell tab
  New team            a Team Work group of agent terminals
  New draft           a markdown file in the editor
  New file browser    the workspace file tree
  New graph           the project link graph
  New dashboard       workspace status, indexing status, about
  New diagram         an Excalidraw canvas (workspace windows only)
  New slide deck      a deck (workspace windows only)

Command categories: Global, Workspace, Search, Apps, Tabs, Panes,
Editor, File Browser, Terminal, Dashboard, Graph. The surface categories
(Editor, File Browser, Terminal, Dashboard, Graph) list the commands of
the focused tab's kind.
"#;

/// One line of `chan --help`. Kept separate from the Cargo description,
/// which is package metadata and runs to 155 columns.
const CHAN_ABOUT: &str = "An AI-native IDE: a CLI and a local server over a folder on disk";

/// Orientation for anyone (or anything) meeting chan for the first time.
/// This is the opening section of `chan dump-skill`, so it carries the one
/// distinction everything else depends on: whether you are in a workspace
/// window or a standalone terminal.
const CHAN_LONG_ABOUT: &str = "\
An AI-native IDE: a CLI and a local server over a folder on disk.

`chan open PATH` registers a folder as a workspace and serves it. The
workspace indexes its content for search, builds a graph from the links,
tags, and mentions in your documents, and hosts the editor, terminals,
file browser, graph, dashboard, and Team Work over that one tree.
Everything runs locally; the server binds loopback by default. The
registry of known workspaces lives in `~/.chan/config.toml`, or under
`CHAN_HOME` when that is set.

Inside any chan terminal, `cs` drives the window that spawned it. It is
this same binary under a second name, picked by argv[0], so `cs open
notes/plan.md` and `chan shell open notes/plan.md` are the same
command.";

/// The rest of the orientation. Split from the long_about because clap
/// prints `after_long_help` below OPTIONS, which is where the two-modes
/// table reads best.
const CHAN_AFTER_HELP: &str = r#"THE TWO MODES:
Where you are decides what you can do. There is no environment variable
that tells them apart: workspace-only commands simply refuse in a
standalone terminal, and say so.

  A WORKSPACE WINDOW -- the one you want.
    Unlocks the command launcher, the built-in apps, tabs and panes, and
    the workspace-only `cs` commands: open, graph, search, export, and
    terminal team. This is where work belongs.

  A STANDALONE TERMINAL -- no workspace behind it. PTYs start in $HOME.
    Fully automatable: every `cs terminal` and `cs pane` command works,
    so scripting it is supported and expected. It is the right place to
    manage the chan library -- `chan open`, `chan close`, `chan close
    --remove`, `chan ps` -- and the wrong place for heavy work, because
    none of the workspace surface exists there.

Run a workspace-only command in a standalone terminal and it says so:
  cs <cmd> is only available in a workspace window; this is a
  standalone terminal.

TELLING WHERE YOU ARE:
  $CHAN                 set to 1 inside any chan-spawned terminal
  $CHAN_CONTROL_SOCKET  required by every `cs` command
  $CHAN_WINDOW_ID       also required by window-targeting commands
  $CHAN_TAB_NAME        this tab's name, when it has one
  $CHAN_TAB_GROUP       this tab's broadcast group, default "default"
  $CHAN_TERMINAL        configured engine at PTY spawn: xterm or ghostty
  $CHAN_WORKSPACE_PATH  the served root, or $HOME in a standalone
                        terminal, so it does NOT identify the mode

EXAMPLES:
Serve a project and open it:
  chan open ~/src/my-project

See what is being served, then tear one down:
  chan ps
  chan close ~/src/my-project

Most installs put `cs` on your PATH. If yours did not, link it once:
  ln -s "$(command -v chan)" ~/.local/bin/cs

Teach an agent the whole surface in one shot:
  mkdir -p ~/.claude/skills/chan
  chan dump-skill > ~/.claude/skills/chan/SKILL.md

SEE ALSO:
`chan dump-skill --list` for every topic, then `chan dump-skill --topic
cs` for the environment contract and `--topic open` for the workspace and
its apps.
"#;

/// `chan dump-skill` long help. A const rather than a doc comment because
/// clap collapses a doc comment's paragraphs into one line, which would
/// destroy the example block below.
const DUMP_SKILL_LONG_ABOUT: &str = "\
Print an agent-facing skill document, rendered from chan's own help text.

The output teaches an agent what chan is and how to drive it: the `cs`
command surface, the command launcher and built-in apps, authoring
documents with diagrams and slide decks, the project graph, teams of
agents, and devservers. Every section is the live `--help` of a real
command, so the skill cannot go stale against the binary printing it.

Writes nothing. The document goes to stdout; you decide where it lands.";

/// `chan dump-skill` examples. The install one-liner points at the user's
/// own agent directory on purpose: writing into a checkout's skills dir
/// would commit a generated file back into the repo.
const DUMP_SKILL_AFTER_HELP: &str = r#"EXAMPLES:
Install the skill for a local agent (the usual first run):
  mkdir -p ~/.claude/skills/chan
  chan dump-skill > ~/.claude/skills/chan/SKILL.md

See what topics exist, then read one:
  chan dump-skill --list
  chan dump-skill --topic teams

Hand a topic to another agent, or drop it into a team brief:
  chan dump-skill --topic graph | cs copy
  chan dump-skill --topic cs-terminal-team >> brief.md

SIDE EFFECTS:
None. Every form writes to stdout only.

CAVEATS:
A `--topic` page is a fragment: it carries no skill frontmatter, so it is
a manual page to read, not a file to install as a skill.

SEE ALSO:
`chan dump-skill --list` for every slug, and `chan --help` for the
orientation the skill opens with.
"#;

/// The build this binary was made from, stamped by `build.rs`.
///
/// The release version cannot name a build on its own: the version pins move
/// only at release cut, so every branch build between two cuts reports the
/// previous release's version. This is what separates them, and it is the same
/// value the server's health surfaces carry, so an id read through a tunnel
/// and an id read from `chan --version` are comparable.
pub const BUILD_ID: &str = env!("CHAN_BUILD_ID");

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
struct Cli {
    /// Increase logging. -v = info, -vv = debug, -vvv = trace.
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    verbose: u8,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
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
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
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
    /// Generate shell completion scripts.
    Completions {
        /// Shell to generate completions for.
        shell: Shell,
    },
    /// Print an agent-facing manual, built from chan's own help
    #[command(long_about = DUMP_SKILL_LONG_ABOUT)]
    #[command(after_long_help = DUMP_SKILL_AFTER_HELP)]
    DumpSkill {
        /// Print the topic index instead of the skill.
        #[arg(long, conflicts_with = "topic")]
        list: bool,
        /// Print one topic's manual page instead of the whole skill.
        /// Takes a slug from `--list`.
        #[arg(long, value_name = "SLUG", verbatim_doc_comment)]
        topic: Option<String>,
    },
    /// Stop serving a workspace; --remove also forgets it
    #[command(long_about = help::CHAN_CLOSE)]
    #[command(after_long_help = help::CHAN_CLOSE_AFTER)]
    Close {
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: PathBuf,
        /// After tearing down the server, also forget the workspace from the
        /// registry (filesystem contents untouched). Runs regardless of the
        /// teardown outcome.
        #[arg(long, verbatim_doc_comment)]
        remove: bool,
    },
    /// Serve a workspace by PATH, or register a devserver by URL
    #[command(long_about = OPEN_LONG_ABOUT)]
    #[command(after_long_help = &*OPEN_AFTER_HELP)]
    Open {
        /// A local workspace PATH, or a devserver URL (scheme://host[:port]).
        /// A value containing `://` is treated as a devserver URL; anything
        /// else is a path.
        #[arg(verbatim_doc_comment)]
        target: Option<String>,
        /// (URL form) Optional label for the devserver's launcher section.
        #[arg(long)]
        name: Option<String>,
        /// (URL form) Optional connect script the desktop runs before it
        /// dials the devserver.
        #[arg(long, verbatim_doc_comment)]
        script: Option<String>,
        /// (PATH form) Serve the given path verbatim instead of suggesting
        /// the enclosing VCS repository root. Without this flag, `chan
        /// open` refuses to start when the workspace path lives inside
        /// a Git / Mercurial / Subversion working tree (exit 70 +
        /// `chan-error: vcs-parent` marker on stderr) because the
        /// repo root is almost always a better workspace root: it
        /// keeps cross-file links, the graph, and search aligned
        /// with the project boundary. Pass `--here` when you
        /// genuinely want to scope the workspace to a subdir.
        #[arg(long, verbatim_doc_comment)]
        here: bool,
        /// Host address to bind. Default 127.0.0.1 (or ::1 with -6).
        /// Use 0.0.0.0 / :: to listen on all interfaces. chan has no
        /// TLS and only a bearer-token gate, so any non-loopback host
        /// exposes your workspace in plaintext on that network.
        #[arg(long, verbatim_doc_comment)]
        host: Option<IpAddr>,
        /// Force IPv4-only listening. With no --host, binds 127.0.0.1.
        /// Mutually exclusive with -6.
        #[arg(
            short = '4',
            long = "ipv4",
            conflicts_with = "ipv6",
            verbatim_doc_comment
        )]
        ipv4: bool,
        /// Force IPv6-only listening. With no --host, binds ::1.
        /// Mutually exclusive with -4.
        #[arg(short = '6', long = "ipv6", verbatim_doc_comment)]
        ipv6: bool,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        /// URL path prefix to mount the server under. Lets a reverse
        /// proxy multiplex many `chan open` instances under one host
        /// (e.g. `workspace.example.com/{user}/`). Canonicalized to
        /// `/seg[/seg...]` with `[A-Za-z0-9-]+` segments; trailing
        /// slashes and `//` runs are tolerated. Anything else is
        /// rejected.
        #[arg(long, verbatim_doc_comment)]
        prefix: Option<String>,
        /// Idle timeout before the server triggers a graceful
        /// shutdown. Accepts `30s`, `5m`, `1h`. Useful for systemd
        /// socket-activated deployments where many idle instances
        /// stack on one host. Without this flag the server stays
        /// resident indefinitely.
        #[arg(long, value_parser = parse_idle_timeout, verbatim_doc_comment)]
        timeout: Option<Duration>,
        /// Skip the bearer-token gate. Local dev only;
        /// never expose a no-token server on a shared machine.
        #[arg(long, verbatim_doc_comment)]
        no_token: bool,
        /// Do not open the system default browser when the server is
        /// ready. The URL is still printed; useful for shells that
        /// host the UI in their own window (chan-desktop) or for
        /// headless / scripted invocations.
        #[arg(long, verbatim_doc_comment)]
        no_browser: bool,
        /// Search indexer resource profile. Overrides
        /// `server.search.aggression` for this run.
        #[arg(long, value_parser = parse_search_aggression, verbatim_doc_comment)]
        search_aggression: Option<SearchAggression>,
        /// Lock down the Settings panel: the SPA greys the cog and
        /// the server refuses every settings-write route with 403
        /// (PATCH /api/config, POST /api/storage/reset,
        /// POST /api/index/rebuild). For
        /// kiosk-style deployments (shared workstation, demo box) where
        /// the workspace owner is not the operator at the keyboard.
        #[arg(long, verbatim_doc_comment)]
        no_settings: bool,
        /// Force a standalone server: bind this workspace directly and skip
        /// both the chan-desktop handoff and the local devserver
        /// registration, even when one is running on this box. Overrides the
        /// shell-parentage default. The escape hatch for automation and for
        /// serving a workspace the local devserver / desktop should not take
        /// over. Mutually exclusive with --desktop / --devserver.
        #[arg(long, conflicts_with_all = ["desktop", "devserver"], verbatim_doc_comment)]
        standalone: bool,
        /// Force the chan-desktop handoff: hand this workspace to a running
        /// same-user desktop to open in a native window, then exit. Overrides
        /// the shell-parentage default. Falls through to a standalone server
        /// when no desktop is reachable (skew, error, GUI absent, or
        /// CHAN_NO_DESKTOP_HANDOFF). Mutually exclusive with --standalone /
        /// --devserver.
        #[arg(long, conflicts_with_all = ["standalone", "devserver"], verbatim_doc_comment)]
        desktop: bool,
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
            conflicts_with_all = ["standalone", "desktop"],
            verbatim_doc_comment
        )]
        devserver: Option<DevserverSelector>,
    },
    /// Show which registered workspaces are served, and by what
    #[command(long_about = help::CHAN_PS)]
    #[command(after_long_help = help::CHAN_PS_AFTER)]
    Ps {
        /// Emit machine-readable JSON.
        #[arg(long)]
        json: bool,
    },
    /// Run a headless multi-workspace devserver on one address
    #[command(long_about = help::CHAN_DEVSERVER)]
    #[command(after_long_help = help::CHAN_DEVSERVER_AFTER)]
    Devserver {
        /// Host address to bind. Default 127.0.0.1 (loopback). Use
        /// 0.0.0.0 / :: to listen on all interfaces; there is no TLS and
        /// only a bearer-token gate, so reach a remote devserver over an
        /// `ssh -L` tunnel rather than binding it on a public interface.
        /// Omit on `--restart` to preserve the running service's bound
        /// address instead of reverting to the default.
        #[arg(long, verbatim_doc_comment)]
        bind: Option<IpAddr>,
        /// Port to bind. Default 8787, except a listening tunnel-mode
        /// devserver (systemd / CHAN_DEVSERVER_LISTEN=1) which defaults to an
        /// OS-assigned free port; preserved from the running service on
        /// `--restart` when omitted.
        #[arg(long, verbatim_doc_comment)]
        port: Option<u16>,
        /// Service backend. `auto` (the default, and what a bare `--service`
        /// resolves to) picks per-OS at runtime: with an action verb it
        /// supervises under `systemd` (Linux), `launchd` (macOS), or the
        /// self-managed `chan` daemon (Windows); with no action verb it runs in
        /// the FOREGROUND (Ctrl-C to stop). `none` forces that unsupervised
        /// foreground server. `chan` is the cross-OS self-managed background
        /// daemon (pidfile + flock). `systemd` (Linux) and `launchd` (macOS) are
        /// OS-backed background services. `chan` may run bare or with an action
        /// verb; `systemd` / `launchd` need an explicit action verb.
        #[arg(long, value_enum, num_args = 0..=1, default_value = "auto", default_missing_value = "auto", verbatim_doc_comment)]
        service: ServiceKind,
        /// Start the background service (write/refresh its unit, enable it on
        /// boot where the backend supports that, and start it), then return.
        /// Idempotent when it is already running.
        #[arg(long, group = "action", verbatim_doc_comment)]
        start: bool,
        /// Stop the service AND disable it, so it does not come back on the next
        /// login or boot, then return. Idempotent. A foreground devserver
        /// (`--service=none`) is stopped with Ctrl-C.
        #[arg(long, group = "action", verbatim_doc_comment)]
        stop: bool,
        /// Restart the service, then return. Rewrites the unit / agent / pidfile
        /// first, so it picks up the current binary; an explicit --bind/--port
        /// rebinds, while omitting both preserves the running service's address.
        /// Starts the service if it is not already running.
        #[arg(long, group = "action", verbatim_doc_comment)]
        restart: bool,
        /// Report whether the service is running, then exit.
        #[arg(long, group = "action")]
        status: bool,
        /// Ensure the service is running (start it if down, attach if up) and
        /// stay attached, blocking on its health until Ctrl-C. This is the
        /// "bring it up and watch it" form connect scripts use; on Ctrl-C it
        /// detaches and the service keeps running.
        #[arg(long, group = "action", verbatim_doc_comment)]
        join: bool,
        /// Rotate the devserver bearer token and print the new
        /// CHAN_DEVSERVER_TOKEN= marker plus /?t= URL, then return. Reaches
        /// the running devserver's management API so the old token stops
        /// authorizing immediately; with no running server it rewrites the
        /// persisted config instead (a devserver still running elsewhere
        /// keeps its old token until restarted). The response to a
        /// suspected token leak. Browser tabs on the old ?t= URL must be
        /// reopened at the new one; every other client re-derives it.
        #[arg(long, group = "action", verbatim_doc_comment)]
        rotate_token: bool,
        /// Take over a wedged `--service=chan` daemon, or make a
        /// `--service=systemd --restart` destructive instead of preserving live
        /// PTYs. Applies to `--service=chan` and `--restart`.
        #[arg(long, verbatim_doc_comment)]
        force: bool,
        /// Tunnel endpoint URL. Required with --tunnel-token. Prefer the
        /// CHAN_TUNNEL_URL env var for supervised or scripted deployments.
        #[arg(long, env = "CHAN_TUNNEL_URL", verbatim_doc_comment)]
        tunnel_url: Option<String>,
        /// Personal access token (chan_pat_*) from the gateway identity
        /// origin (gw.chan.app for the hosted gateway). Setting this
        /// enables tunnel mode: the devserver dials the gateway and publishes
        /// every mounted workspace behind one registration. The devserver
        /// identity is resolved backend-side from the token; the display
        /// name shown in the roster comes from --tunnel-devserver-name.
        /// Prefer the CHAN_TUNNEL_TOKEN env var so the secret does not
        /// appear in `ps`.
        #[arg(long, env = "CHAN_TUNNEL_TOKEN", verbatim_doc_comment)]
        tunnel_token: Option<String>,
        /// Display name for this devserver in the gateway roster (tunnel
        /// mode only). Defaults to this machine's hostname. Trimmed and
        /// capped at 64 bytes; when another of your devservers already
        /// holds the name, the gateway suffixes `-2`, `-3`, ...
        #[arg(long, env = "CHAN_TUNNEL_DEVSERVER_NAME", verbatim_doc_comment)]
        tunnel_devserver_name: Option<String>,
        /// Run WITHOUT tunnel mode, ignoring any token in scope: the
        /// --tunnel-token flag, CHAN_TUNNEL_TOKEN in the environment, and
        /// (under --service=systemd) the PAT persisted in the installed
        /// unit. This is how a supervised tunnel devserver is converted
        /// back to a purely local one, and how a shell that inherited a
        /// token still starts a local devserver. Omit it and a supervised
        /// --start/--restart/--join keeps the tunnel registration the unit
        /// already carries.
        #[arg(long, verbatim_doc_comment)]
        no_tunnel: bool,
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
    /// Read or write settings outside the workspace (editor.*, server.*)
    #[command(long_about = help::CHAN_CONFIG)]
    #[command(after_long_help = help::CHAN_CONFIG_AFTER)]
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Upgrade chan in place
    ///
    /// Reads release metadata from chan.app, downloads the selected CLI
    /// asset, verifies its SHA256, and atomically replaces the running
    /// binary.
    ///
    /// Set `CHAN_UPDATE_CHECK=0` to silence the banner that fires on
    /// `chan open` startup.
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
    /// by a running `chan open`. Connects to the per-server Unix-
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

/// Subcommands for `chan workspace`. Groups the workspace-registry
/// operations (add / ls / rm) with the per-workspace content
/// operations (index / reports / search / graph / status / metadata /
/// contacts) under one verb, so the top-level surface carries only the
/// process-lifecycle and app-level commands (open, close, devserver,
/// config, ...). Mirrors the `IndexAction` / `ReportsAction`
/// sub-enum pattern.
#[derive(Args, Debug, Clone, Default)]
struct WorkspaceTargets {
    /// Registered workspace selector: canonical path, metadata key, or unique
    /// display name. Repeat to query several workspaces in order.
    #[arg(
        long = "workspace",
        value_name = "SELECTOR",
        conflicts_with = "all_workspaces"
    )]
    workspaces: Vec<String>,
    /// Query every registered workspace in canonical-root order.
    #[arg(long)]
    all_workspaces: bool,
}

#[derive(Args, Debug, Clone)]
struct WorkspaceGraphArgs {
    /// Exact typed traversal seed. Repeat for multiple seeds.
    #[arg(long = "from", value_name = "TYPE:VALUE", required = true)]
    from: Vec<String>,
    #[arg(long)]
    depth: Option<u8>,
    #[arg(long, value_name = "DIRECTION")]
    direction: Option<String>,
    #[arg(long = "edge-kind", value_name = "KIND")]
    edge_kinds: Vec<String>,
    #[arg(long)]
    limit: Option<u32>,
    #[arg(long)]
    node_limit: Option<u32>,
    #[arg(long)]
    edge_limit: Option<u32>,
}

impl WorkspaceGraphArgs {
    fn to_request(&self) -> Result<WorkspaceSearchRequest> {
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

#[derive(Subcommand, Debug)]
enum WorkspaceAction {
    /// Register a directory as a chan workspace
    ///
    /// The baseline always runs: a filesystem walk, a markdown read, the
    /// documentation graph, and the BM25 index. Semantic search is an
    /// optional layer, off by default to keep workspaces lean. Code
    /// reports are on by default for new workspaces; `chan workspace
    /// reports disable` turns them off.
    ///
    /// Registering alone does not serve the workspace. `chan open PATH`
    /// registers and serves in one step, which is the usual way in.
    #[command(verbatim_doc_comment)]
    Add {
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
    /// Drop a workspace from the registry
    ///
    /// Does not delete the directory or its content; only forgets it on
    /// this machine, so the same path can be registered again later with
    /// `chan workspace add` or `chan open`.
    #[command(verbatim_doc_comment)]
    Rm {
        #[arg(value_hint = clap::ValueHint::AnyPath)]
        path: PathBuf,
    },
    /// Rebuild the search index and graph, and manage semantic search
    ///
    /// Subcommand-driven rather than a flat `chan workspace index PATH`
    /// so the embedding-model and semantic-toggle controls live next to
    /// the rebuild action, mirroring `chan config`.
    #[command(verbatim_doc_comment)]
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
        #[arg(long)]
        json: bool,
        #[arg(long)]
        pretty: bool,
    },
    /// Traverse workspace graph relationships from exact typed seeds.
    Graph {
        #[command(flatten)]
        graph: WorkspaceGraphArgs,
        #[command(flatten)]
        targets: WorkspaceTargets,
        #[arg(long)]
        json: bool,
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
    Contacts {
        #[command(subcommand)]
        action: ContactsAction,
    },
}

#[derive(Subcommand, Debug)]
enum ContactsAction {
    /// Import contacts from an external source as markdown notes
    ///
    /// Pick the source format with a sub-subcommand.
    #[command(verbatim_doc_comment)]
    Import {
        #[command(subcommand)]
        source: ImportSource,
    },
}

#[derive(Subcommand, Debug)]
enum ImportSource {
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
enum ConfigAction {
    /// Print one setting value, or all supported settings when no
    /// key is given.
    Get {
        /// Dotted key, e.g. `editor.theme` or
        /// `server.attachments_dir`. Empty prints the full TOML.
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
enum MetadataAction {
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
/// state inspection. Older scripts' flat `chan workspace index <path>` is now
/// `chan workspace index rebuild <path>`.
///
/// Symmetric naming matches the `chan workspace reports
/// enable/disable` parallel pair so scripted callers can pattern-
/// match `<feature> enable / disable` across the surface.
#[derive(Subcommand, Debug)]
enum IndexAction {
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
/// Default state for both features is OFF (lean-workspace
/// baseline); explicit opt-in via this CLI / the
/// pre-flight UI / Settings flips them on.
#[derive(Subcommand, Debug)]
enum ReportsAction {
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
    /// triggers a fresh scan. Pass `-y` to skip the confirmation prompt.
    #[command(verbatim_doc_comment)]
    Disable {
        /// Workspace root.
        #[arg(long, value_name = "PATH")]
        path: Option<PathBuf>,
        /// Skip the destructive-action confirmation prompt.
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
fn parse_cli<I, T>(args: I) -> Cli
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

/// Which binary is driving the `chan` CLI, and therefore how the
/// desktop-aware subcommands behave.
///
/// - [`Personality::Standalone`] -- the `chan` binary from install.sh (and
///   the `cs -> chan` symlink). With both a desktop and devserver live,
///   `chan open` prefers the devserver; with neither it runs its own server
///   and opens the browser.
///   `chan upgrade` replaces the CLI tarball in place.
/// - [`Personality::Desktop`] -- chan-desktop invoked as `chan` (via the
///   `~/.local/bin/chan` shim). `chan open` integrates with the desktop:
///   it prefers a live devserver when no desktop is running, otherwise hands
///   the workspace to the desktop or launches the GUI.
///   `chan upgrade` drives the desktop's `tauri-plugin-updater`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Personality {
    Standalone,
    Desktop,
}

/// What `chan upgrade` does for the running binary.
#[derive(Debug, PartialEq, Eq)]
enum UpgradeRoute {
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
fn decide_upgrade_route(personality: Personality, packaged: Option<&str>) -> UpgradeRoute {
    if let Some(message) = update::packaged_upgrade_refusal(packaged) {
        return UpgradeRoute::Refuse(message);
    }
    match personality {
        Personality::Standalone => UpgradeRoute::Cli,
        Personality::Desktop => UpgradeRoute::Desktop,
    }
}

/// Which backend backs `chan devserver --service`. `Auto` (the CLI value
/// `auto`, the default) resolves per-OS at runtime: with an action verb it
/// supervises under systemd (Linux), launchd (macOS), or the self-managed `chan`
/// daemon (Windows); with no action verb it runs the plain foreground server.
/// `None` (`none`) forces that unsupervised foreground server, and `Chan` /
/// `Systemd` / `Launchd` each force a specific backend explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ServiceKind {
    // These doc comments are the possible-values list in `--help`, and clap
    // renders each as ONE line however it is wrapped here. Keep them to a
    // single short sentence; the per-OS resolution table is in the command's
    // long help, where there is room for it.
    /// Per-OS auto-pick, the default
    #[value(name = "auto")]
    Auto,
    /// No supervision: run in the foreground, Ctrl-C stops
    #[value(name = "none")]
    None,
    /// The cross-OS self-managed background daemon
    Chan,
    /// A systemd user service (Linux only).
    Systemd,
    /// A launchd LaunchAgent (macOS only).
    Launchd,
}

impl ServiceKind {
    /// The `--service=<name>` value, for error messages.
    fn cli_name(self) -> &'static str {
        match self {
            ServiceKind::Auto => "auto",
            ServiceKind::None => "none",
            ServiceKind::Chan => "chan",
            ServiceKind::Systemd => "systemd",
            ServiceKind::Launchd => "launchd",
        }
    }
}

/// One action verb from the mutually-exclusive `--start`/`--stop`/`--restart`/
/// `--status`/`--join` group. clap enforces at most one is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevAction {
    Start,
    Stop,
    Restart,
    Status,
    Join,
}

impl DevAction {
    /// The `--<flag>` this verb came from, for error messages.
    fn flag(self) -> &'static str {
        match self {
            DevAction::Start => "start",
            DevAction::Stop => "stop",
            DevAction::Restart => "restart",
            DevAction::Status => "status",
            DevAction::Join => "join",
        }
    }
}

/// The resolved operation `chan devserver` will run once the `(--service,
/// action)` pair is validated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevPlan {
    /// Run in the foreground: `--service=none` or the no-action `auto` default.
    Foreground(ServiceKind),
    /// A management verb on the `chan` background daemon.
    ChanVerb(DevAction),
    /// A verb against a `systemd`/`launchd` background service.
    Supervised(ServiceKind, DevAction),
}

/// The single action verb the user passed, if any. clap's `action` group makes
/// at most one of the flags true, so the order here is immaterial.
fn selected_devserver_action(
    start: bool,
    stop: bool,
    restart: bool,
    status: bool,
    join: bool,
) -> Option<DevAction> {
    if start {
        Some(DevAction::Start)
    } else if stop {
        Some(DevAction::Stop)
    } else if restart {
        Some(DevAction::Restart)
    } else if status {
        Some(DevAction::Status)
    } else if join {
        Some(DevAction::Join)
    } else {
        None
    }
}

/// Validate a `(--service, action)` combination and resolve it to a [`DevPlan`],
/// or return a user-facing error for an invalid pair. Pure + total so every cell
/// of the validity matrix is unit-tested without a real service manager.
///
/// - `none` (foreground) takes no action verb.
/// - `chan` starts the portable background daemon when run bare or with
///   `--start`, and accepts `--stop`/`--restart`/`--status`/`--join`.
/// - `systemd`/`launchd` (detached) require an explicit verb; a bare
///   `--service=systemd` is ambiguous and rejected.
fn plan_devserver(service: ServiceKind, action: Option<DevAction>) -> Result<DevPlan, String> {
    match (service, action) {
        (ServiceKind::Auto, _) => {
            unreachable!("resolve_auto replaces Auto with a concrete backend before plan_devserver")
        }
        (ServiceKind::None, None) => Ok(DevPlan::Foreground(ServiceKind::None)),
        (ServiceKind::None, Some(a)) => Err(format!(
            "--service=none runs in the foreground (Ctrl-C to stop); --{} needs a managed \
             backend (--service=chan/systemd/launchd)",
            a.flag()
        )),
        (ServiceKind::Chan, None) => Ok(DevPlan::ChanVerb(DevAction::Start)),
        (ServiceKind::Chan, Some(a)) => Ok(DevPlan::ChanVerb(a)),
        (kind @ (ServiceKind::Systemd | ServiceKind::Launchd), None) => Err(format!(
            "--service={} needs an action: one of --start/--stop/--status/--restart/--join",
            kind.cli_name()
        )),
        (kind @ (ServiceKind::Systemd | ServiceKind::Launchd), Some(a)) => {
            Ok(DevPlan::Supervised(kind, a))
        }
    }
}

/// Resolve `--service=auto` to a concrete backend from the runtime OS string
/// (`std::env::consts::OS`) and whether an action verb was supplied. Pure + total
/// so the whole matrix is unit-tested without a real OS.
///
/// With NO action verb the devserver always runs in the foreground, so a bare
/// `chan devserver` works on every host as `None` (unsupervised). With an action
/// verb it selects the OS supervisor: `Systemd` on Linux, `Launchd` on macOS,
/// `Chan` on Windows. An unrecognized OS has no manager for an action verb, so
/// that one case errors (the message points at `--service=chan`). The OS is not
/// threaded into `plan_devserver`, which keeps validating the resolved
/// `(backend, action)` pair on its own matrix.
fn resolve_auto(os: &str, has_action: bool) -> Result<ServiceKind, String> {
    if !has_action {
        return Ok(ServiceKind::None);
    }
    match os {
        "windows" => Ok(ServiceKind::Chan),
        "linux" => Ok(ServiceKind::Systemd),
        "macos" => Ok(ServiceKind::Launchd),
        other => Err(format!(
            "could not auto-detect a service backend for this OS (\"{other}\"); \
             use --service=chan for the portable background daemon"
        )),
    }
}

/// Whether this host is actually running systemd as its init: the `/run/systemd/
/// system` directory the manager creates. Probed only on the `--service=auto`
/// path (see [`require_systemd_for_auto`]) so a Linux box without systemd (a
/// container, a non-systemd distro) falls back to a clear error instead of a raw
/// `systemctl` spawn failure. An explicit `--service=systemd` skips this.
fn systemd_available() -> bool {
    std::path::Path::new("/run/systemd/system").exists()
}

/// Confirm systemd backs this Linux host before `--service=auto` commits to the
/// systemd backend it picked. `present` is the [`systemd_available`] probe,
/// injected so the no-systemd bail is unit-tested. An explicit `--service=systemd`
/// never reaches here and is left to surface systemctl's own error.
fn require_systemd_for_auto(present: bool) -> Result<(), String> {
    if present {
        Ok(())
    } else {
        Err(
            "--service auto selected systemd for this Linux host, but systemd is not \
             available (no /run/systemd/system). Use --service=chan for the portable \
             background daemon."
                .to_string(),
        )
    }
}

/// Parse `args` and run the selected subcommand to completion.
///
/// This is the single entry point for the whole `chan` CLI. The caller owns
/// the tokio runtime (so it can pick the multi-threaded flavour `serve`
/// needs and `shutdown_background()` to detach chan-workspace's uncancellable
/// reindex pool on exit); everything here runs inside it. Sync subcommands
/// execute inline on the runtime thread, which is fine for a
/// run-one-thing-and-exit CLI.
pub async fn run<I, T>(args: I, personality: Personality) -> Result<()>
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    // Hand the binary's identity to the server library before any subcommand
    // can start one. chan-server cannot stamp this itself -- it is a library,
    // and the id belongs to the binary linking it.
    chan_server::set_build_id(BUILD_ID);

    let cli = parse_cli(args);
    init_tracing(cli.verbose);
    let verbose = cli.verbose > 0;

    match cli.command {
        Command::Workspace { action } => match action {
            WorkspaceAction::Add {
                path,
                semantic_search,
                reports,
            } => cmd_add(path, semantic_search, reports),
            WorkspaceAction::Ls { json } => cmd_list(json),
            WorkspaceAction::Rm { path } => cmd_remove(path, personality).await,
            WorkspaceAction::Index { action } => cmd_index(action),
            WorkspaceAction::Reports { action } => cmd_reports(action),
            WorkspaceAction::Search {
                search,
                targets,
                json,
                pretty,
            } => cmd_workspace_search(search.to_request()?, targets, json, pretty).await,
            WorkspaceAction::Graph {
                graph,
                targets,
                json,
                pretty,
            } => cmd_workspace_search(graph.to_request()?, targets, json, pretty).await,
            WorkspaceAction::Status { path, json } => cmd_status(path, json),
            WorkspaceAction::Metadata { action } => cmd_metadata(action),
            WorkspaceAction::Contacts { action } => match action {
                ContactsAction::Import { source } => match source {
                    ImportSource::Csv {
                        file,
                        into,
                        provider,
                        dry_run,
                        overwrite,
                        workspace,
                    } => {
                        cmd_contacts_import_csv(file, into, provider, dry_run, overwrite, workspace)
                    }
                },
            },
        },
        Command::Shell { action } => chan_shell::dispatch(action).await,
        Command::Completions { shell } => cmd_completions(shell),
        Command::DumpSkill { list, topic } => cmd_dump_skill(list, topic.as_deref()),
        Command::Close { path, remove } => cmd_close(path, remove, personality).await,
        Command::Open {
            target,
            name,
            script,
            here,
            host,
            ipv4,
            ipv6,
            port,
            prefix,
            timeout,
            no_token,
            no_browser,
            search_aggression,
            no_settings,
            standalone,
            desktop,
            devserver,
        } => {
            // Polymorphic dispatch: a `scheme://host` value registers a
            // devserver via the desktop handoff; anything else is a local
            // workspace path that gets registered + served.
            match target {
                Some(t) if looks_like_devserver_url(&t) => {
                    cmd_open_devserver(t, name, script).await
                }
                _ => {
                    let addr = resolve_listen_addr(host, ipv4, ipv6, port)?;
                    let prefix = chan_server::sanitize_prefix(prefix.as_deref().unwrap_or(""))
                        .map_err(|e| anyhow::anyhow!("invalid --prefix: {e}"))?;
                    cmd_serve(
                        ServeArgs {
                            addr,
                            prefix,
                            idle_timeout: timeout,
                            path: target.map(PathBuf::from),
                            here,
                            no_token,
                            no_browser,
                            search_aggression,
                            no_settings,
                            flags: OpenFlags {
                                standalone,
                                desktop,
                                devserver,
                            },
                            verbose,
                        },
                        personality,
                    )
                    .await
                }
            }
        }
        Command::Ps { json } => cmd_ps(json).await,
        Command::Devserver {
            bind,
            port,
            service,
            start,
            stop,
            restart,
            status,
            join,
            rotate_token,
            force,
            tunnel_url,
            tunnel_token,
            tunnel_devserver_name,
            no_tunnel,
        } => {
            cmd_devserver(
                bind,
                port,
                service,
                start,
                stop,
                restart,
                status,
                join,
                rotate_token,
                force,
                tunnel_url,
                tunnel_token,
                tunnel_devserver_name,
                no_tunnel,
                verbose,
            )
            .await
        }
        Command::DevserverDaemon {
            bind,
            port,
            tunnel_url,
            tunnel_devserver_name,
        } => {
            let addr = SocketAddr::new(bind, port);
            let tunnel = build_devserver_tunnel_from_env(tunnel_url, tunnel_devserver_name)?;
            devserver_daemon::run_devserver_daemon_child(addr, tunnel).await
        }
        Command::Config { action } => cmd_config(action),
        Command::Upgrade {
            yes,
            check,
            version,
        } => match decide_upgrade_route(personality, update::packaged_via()) {
            // A distro-packaged build: the package manager owns the files.
            UpgradeRoute::Refuse(message) => anyhow::bail!(message),
            // Standalone (install.sh) replaces the CLI tarball in place.
            UpgradeRoute::Cli => {
                update::run_upgrade(update::UpgradeOptions {
                    assume_yes: yes,
                    check_only: check,
                    version_override: version,
                    verbose,
                })
                .await
            }
            // Desktop drives the running desktop's tauri-plugin-updater
            // instead (no tarball). `yes` is moot -- the fire-and-return flow
            // has no prompt.
            UpgradeRoute::Desktop => cmd_upgrade_desktop(check, version).await,
        },
        Command::Mcp { path } => cmd_mcp(path).await,
        Command::McpProxy { socket } => cmd_mcp_proxy(socket).await,
    }
}

fn init_tracing(verbosity: u8) {
    let level = match verbosity {
        0 => "warn",
        1 => "info",
        2 => "debug",
        _ => "trace",
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| fallback_filter(level)),
        )
        .with_writer(std::io::stderr)
        .init();
}

/// tokei (pulled in transitively by chan-report for the language-count
/// lens) logs `Unknown extension: <ext>` at WARN through tokei's own
/// `LanguageType::from_path` for every file it can't classify. chan-report
/// is default-on (`DashboardConfig::reports_enabled = true`), so on a source
/// tree with reports enabled this is pure console noise with no downstream
/// effect (the graph language lens already degrades when a bucket is
/// absent). Cap tokei at ERROR so the spam disappears but genuine tokei
/// errors still surface.
///
/// Applied to the FALLBACK filter only (`RUST_LOG` parses first via
/// `try_from_default_env`), so anyone who explicitly wants tokei detail
/// keeps full control by setting `RUST_LOG`.
const TOKEI_LOG_DIRECTIVE: &str = "tokei=error";

fn fallback_filter(level: &str) -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::new(level).add_directive(
        TOKEI_LOG_DIRECTIVE
            .parse()
            .expect("static tokei log directive parses"),
    )
}

fn library() -> Result<Library> {
    Library::open().context("opening chan registry")
}

fn same_path(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

fn ensure_workspace_registered(
    lib: &Library,
    root: &Path,
) -> Result<chan_workspace::KnownWorkspace> {
    lib.register_workspace(root)
        .with_context(|| format!("registering {}", root.display()))
}

fn cmd_add(path: PathBuf, semantic_search: bool, reports: bool) -> Result<()> {
    // Mirror `chan open`'s behavior: create the directory if it
    // doesn't exist yet. Single verb covers both "register an
    // existing dir" and "make a fresh workspace here". A separate
    // `chan init` would be a synonym; not worth the mental
    // overhead.
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .with_context(|| format!("creating workspace root {}", path.display()))?;
    }
    let lib = library()?;
    let entry = ensure_workspace_registered(&lib, &path)?;
    // Opt-in feature flags. Persist before
    // boot-time activation so a `chan workspace add --reports` lands the
    // flag immediately + the kickoff scan runs once.
    if semantic_search || reports {
        let workspace = lib
            .open_workspace(&entry.root_path)
            .with_context(|| format!("opening workspace at {}", entry.root_path.display()))?;
        if semantic_search {
            workspace
                .set_semantic_enabled(true)
                .context("persisting semantic_enabled flag")?;
        }
        if reports {
            workspace
                .set_reports_enabled(true)
                .context("persisting reports_enabled flag")?;
        }
        workspace
            .boot()
            .context("BOOT after enabling optional features")?;
    }
    println!("registered: {}", entry.root_path.display());
    if semantic_search {
        println!("semantic search enabled");
    }
    if reports {
        println!("chan-reports enabled");
    }
    Ok(())
}

fn cmd_list(json: bool) -> Result<()> {
    let workspaces = library()?.list_workspaces();
    if json {
        let out = WorkspaceListOutput {
            workspaces: workspaces.iter().map(WorkspaceListEntry::from).collect(),
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    if workspaces.is_empty() {
        println!("(no workspaces registered)");
        return Ok(());
    }
    for d in workspaces {
        println!(
            "{}  (last seen {}, metadata {})",
            d.root_path.display(),
            d.last_seen_at.format("%Y-%m-%d %H:%M"),
            d.metadata_key,
        );
    }
    Ok(())
}

/// Render the skill (or one topic, or the index) to stdout. Pure output,
/// like `cmd_completions`: no workspace, no registry, no side effects.
fn cmd_dump_skill(list: bool, topic: Option<&str>) -> Result<()> {
    let out = if list {
        skill::render_list()
    } else if let Some(topic) = topic {
        skill::render_topic(topic)?
    } else {
        skill::render_skill()?
    };
    print!("{out}");
    Ok(())
}

fn cmd_completions(shell: Shell) -> Result<()> {
    let mut cmd = Cli::command();
    let bin_name = cmd.get_name().to_string();
    clap_complete::generate(shell, &mut cmd, bin_name, &mut std::io::stdout());
    Ok(())
}

/// The process serving a workspace, behind its writer-lock holder.
/// Produced by `serving_kind`'s `Identify` round-trip; serializes to
/// `standalone` / `desktop` / `devserver` for `chan ps --json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServedBy {
    /// A dedicated `chan open` bound to this one workspace.
    Standalone,
    /// chan-desktop's embedded server.
    Desktop,
    /// A multi-workspace `chan devserver`.
    Devserver,
}

impl ServedBy {
    fn label(self) -> &'static str {
        match self {
            ServedBy::Standalone => "standalone",
            ServedBy::Desktop => "desktop",
            ServedBy::Devserver => "devserver",
        }
    }
}

/// One `chan ps` row: a registered workspace and its serving state.
#[derive(Serialize)]
struct PsRow {
    path: String,
    served: bool,
    /// `None` when free, or served but the kind is not yet resolved.
    served_by: Option<ServedBy>,
    pid: Option<u32>,
    /// RFC3339 lock-acquisition time of the holder.
    since: Option<String>,
    /// What the workspace is DOING, for a workspace served by a devserver
    /// this credential can reach. `null` everywhere else -- a standalone or
    /// desktop serve persists no address/token pair `chan ps` may read, and
    /// inventing one would be the new authority the item forbids. Rendered
    /// as `-`, never as `0`.
    activity: Option<PsActivity>,
}

/// The answer to "what is this workspace doing", assembled from the two
/// surfaces that already compute it: `GET {prefix}/api/index/status` for
/// readiness and `GET {prefix}/api/health` for indexer telemetry.
///
/// `readiness` is the server's OWN [`WorkspaceReadiness`], not a copy of its
/// shape, so `chan ps` cannot drift into reporting a different truth than the
/// endpoint it read: a variant or field the server changes stops compiling
/// here rather than silently rendering something stale.
#[derive(Serialize)]
struct PsActivity {
    /// `None` when the status call did not answer.
    readiness: Option<WorkspaceReadiness>,
    /// `None` when the tenant carries no indexer AT ALL -- `/api/health`
    /// reports `indexer: null` on the workspace-less terminal tenant and
    /// during the storage-reset swap window, and that absence is a fact worth
    /// showing rather than flattening. Renders `-`, following the v0.85.0
    /// `cs terminal list` ruling that an unreported value is not a zero.
    indexer: Option<PsIndexer>,
}

/// Indexer telemetry as `chan ps` reads it off `/api/health`.
///
/// Deliberately a client-side mirror of the server's `IndexerHealth` rather
/// than that type itself: chan-server declares `mod indexer` privately, so the
/// type is unreachable from this crate, and making it reachable would mean
/// editing a file this lane does not own. Every field is optional so a payload
/// that stops carrying one renders `-` instead of failing the whole row.
#[derive(Serialize, Deserialize)]
struct PsIndexer {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    queue_depth: Option<u64>,
    #[serde(default)]
    last_event_at: Option<i64>,
    #[serde(default)]
    last_settled_at: Option<i64>,
}

/// `GET {prefix}/api/index/status`: `IndexStatus` flattened, plus readiness.
/// Only readiness is read here; the flattened index state is already
/// represented by the indexer's own status on `/api/health`.
#[derive(Deserialize)]
struct PsIndexStatus {
    #[serde(default)]
    readiness: Option<WorkspaceReadiness>,
}

/// `GET {prefix}/api/health`, narrowed to the field this command needs.
#[derive(Deserialize)]
struct PsHealth {
    /// `null` on a tenant with no indexer, which is why it is a nested Option
    /// rather than a defaulted struct.
    #[serde(default)]
    indexer: Option<PsIndexer>,
}

#[derive(Serialize)]
struct PsOutput {
    workspaces: Vec<PsRow>,
}

/// The `chan ps` BY column: the resolved serving kind, or `-` when the
/// workspace is served but its kind could not be probed (the STATE column
/// already distinguishes served vs free).
fn ps_by_column(_served: bool, kind: Option<ServedBy>) -> &'static str {
    match kind {
        Some(k) => k.label(),
        None => "-",
    }
}

/// Every activity column renders this when the value is not reported, never
/// `0` and never blank. Following the v0.85.0 `cs terminal list` ruling: a
/// queue depth of zero and an unknown queue depth are different facts, and
/// showing the second as the first is how an operator concludes "nothing
/// queued" about a workspace nobody asked.
const PS_ABSENT: &str = "-";

/// READY column: the readiness state word.
fn ps_ready_column(readiness: Option<WorkspaceReadiness>) -> &'static str {
    match readiness {
        Some(WorkspaceReadiness::Ready { .. }) => "ready",
        Some(WorkspaceReadiness::Recovering { .. }) => "recovering",
        None => PS_ABSENT,
    }
}

/// GEN column: `generation/completed` while recovering, bare `generation`
/// when ready. The gap between the two is the lag that says a pass is owed.
fn ps_gen_column(readiness: Option<WorkspaceReadiness>) -> String {
    match readiness {
        Some(WorkspaceReadiness::Ready { generation }) => generation.get().to_string(),
        Some(WorkspaceReadiness::Recovering {
            generation,
            completed_generation,
            ..
        }) => format!("{}/{}", generation.get(), completed_generation.get()),
        None => PS_ABSENT.to_string(),
    }
}

/// PASS column: `pending->active`, the pair that distinguishes a recovery
/// with a worker from one without. `14->none` is the stall fingerprint --
/// a pass is owed and nothing is running it -- and it is the column this
/// whole command exists to put on screen.
fn ps_pass_column(readiness: Option<WorkspaceReadiness>) -> String {
    match readiness {
        Some(WorkspaceReadiness::Recovering {
            active_generation,
            pending_generation,
            ..
        }) => {
            let render = |g: Option<chan_workspace::WorkspaceGeneration>| {
                g.map_or_else(|| "none".to_string(), |g| g.get().to_string())
            };
            format!(
                "{}->{}",
                render(pending_generation),
                render(active_generation)
            )
        }
        // A ready workspace has no pass in flight and no pass owed; that is
        // an absence of work, not an unknown, but rendering it `-` keeps the
        // column honest about carrying no pass rather than implying one.
        Some(WorkspaceReadiness::Ready { .. }) | None => PS_ABSENT.to_string(),
    }
}

/// ACTION column: the recovery action the pass would run.
fn ps_action_column(readiness: Option<WorkspaceReadiness>) -> &'static str {
    match readiness {
        Some(WorkspaceReadiness::Recovering {
            required_action: Some(action),
            ..
        }) => match action {
            RecoveryAction::Replay => "replay",
            RecoveryAction::Reconcile => "reconcile",
            RecoveryAction::FullRebuild => "rebuild",
        },
        _ => PS_ABSENT,
    }
}

/// INDEXER column: the indexer's own health word, or `-` when the tenant
/// carries no indexer or the call did not answer.
fn ps_indexer_column(indexer: Option<&PsIndexer>) -> &str {
    indexer
        .and_then(|i| i.status.as_deref())
        .unwrap_or(PS_ABSENT)
}

/// QUEUE column. A tenant with no indexer renders `-`, NOT `0`: "nothing is
/// queued" and "nobody is reporting a queue" are different facts, and a
/// workspace with no indexer at all reporting `0` reads as the healthy one.
fn ps_queue_column(indexer: Option<&PsIndexer>) -> String {
    indexer
        .and_then(|i| i.queue_depth)
        .map_or_else(|| PS_ABSENT.to_string(), |q| q.to_string())
}

/// Ask the local devserver what each of the workspaces it serves is doing.
///
/// Returns a map keyed by workspace root path. An empty map is the normal
/// answer whenever this credential does not reach a devserver -- no persisted
/// config, nothing listening, a refused bearer -- and every activity column
/// then renders `-`. `chan ps` reporting where a workspace lives must not
/// start failing because the thing serving it is unreachable.
///
/// Authority note: the bearer is the one already persisted at
/// `~/.chan/devserver/config.json`, which this CLI reads today to rotate that
/// same token (a mutating call). Reading two status endpoints with it grants
/// nothing new.
async fn devserver_activity(wanted: &HashSet<String>) -> HashMap<String, PsActivity> {
    let mut out = HashMap::new();
    if wanted.is_empty() {
        return out;
    }
    let Some(token) = chan_server::persisted_devserver_token() else {
        return out;
    };
    let Some(addr) = running_systemd_devserver_addr().or_else(|| {
        chan_server::persisted_devserver_port()
            .map(|port| SocketAddr::new(DEFAULT_DEVSERVER_BIND, port))
    }) else {
        return out;
    };
    let client = reqwest::Client::new();
    // One gate for the whole enrichment: if the listing does not answer, we
    // stop here rather than waiting out a timeout per workspace.
    let listing = format!("http://{addr}/api/devserver/workspaces");
    let request = client.get(&listing).bearer_auth(&token).send();
    let Ok(Ok(response)) = tokio::time::timeout(PS_ACTIVITY_TIMEOUT, request).await else {
        return out;
    };
    if !response.status().is_success() {
        return out;
    }
    let Ok(entries) = response
        .json::<Vec<chan_server::devserver_api::WorkspaceEntry>>()
        .await
    else {
        return out;
    };
    for entry in entries {
        if !wanted.contains(&entry.path) {
            continue;
        }
        let base = format!("http://{addr}{}", entry.prefix);
        let readiness = ps_get::<PsIndexStatus>(&client, &base, "/api/index/status", &entry.token)
            .await
            .and_then(|status| status.readiness);
        let indexer = ps_get::<PsHealth>(&client, &base, "/api/health", &entry.token)
            .await
            .and_then(|health| health.indexer);
        out.insert(entry.path, PsActivity { readiness, indexer });
    }
    out
}

/// How long any one `chan ps` enrichment call may take. Short on purpose:
/// this is decoration on a command whose primary answer (where a workspace
/// is and whether it is served) is already in hand from the filesystem.
const PS_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(3);

/// One authenticated status GET, decoded, with every failure flattened to
/// `None` -- an unreachable or unparseable endpoint renders `-`, it does not
/// fail the row or the command.
async fn ps_get<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    token: &str,
) -> Option<T> {
    let request = client
        .get(format!("{base}{path}"))
        .bearer_auth(token)
        .send();
    let response = tokio::time::timeout(PS_ACTIVITY_TIMEOUT, request)
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<T>().await.ok()
}

/// `chan ps`: report each registered workspace's serving state. Serving
/// is decided by a live writer-lock holder (`lock::is_free` is false);
/// the holder's pid + start time come from the `writer.lock` record.
async fn cmd_ps(json: bool) -> Result<()> {
    let lib = library()?;
    let mut rows = Vec::new();
    for ws in lib.list_workspaces() {
        let lock_dir = lib.workspace_paths_for(&ws.root_path).map(|p| p.lock);
        let served = lock_dir
            .as_deref()
            .map(|d| !chan_workspace::lock::is_free(d))
            .unwrap_or(false);
        let record = if served {
            lock_dir
                .as_deref()
                .and_then(chan_workspace::lock::read_lock_record)
        } else {
            None
        };
        let pid = record.as_ref().map(|r| r.pid);
        let since = record.map(|r| r.started_at);
        let served_by = match (served, pid) {
            (true, Some(p)) => serving_kind(p).await,
            _ => None,
        };
        rows.push(PsRow {
            path: ws.root_path.display().to_string(),
            served,
            served_by,
            pid,
            since,
            activity: None,
        });
    }
    // Only a devserver-served workspace can be enriched: a standalone or
    // desktop serve persists no address/token pair this command may read.
    let wanted: HashSet<String> = rows
        .iter()
        .filter(|r| r.served_by == Some(ServedBy::Devserver))
        .map(|r| r.path.clone())
        .collect();
    let mut activity = devserver_activity(&wanted).await;
    for row in &mut rows {
        row.activity = activity.remove(&row.path);
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&PsOutput { workspaces: rows })?
        );
        return Ok(());
    }
    if rows.is_empty() {
        println!("(no workspaces registered)");
        return Ok(());
    }
    println!(
        "{:<7}  {:<11}  {:>8}  {:<10}  {:<7}  {:<9}  {:<9}  {:<8}  {:>5}  WORKSPACE",
        "STATE", "BY", "PID", "READY", "GEN", "PASS", "ACTION", "INDEXER", "QUEUE"
    );
    for r in &rows {
        let state = if r.served { "served" } else { "free" };
        let by = ps_by_column(r.served, r.served_by);
        let pid = r
            .pid
            .map_or_else(|| PS_ABSENT.to_string(), |p| p.to_string());
        let readiness = r.activity.as_ref().and_then(|a| a.readiness);
        let indexer = r.activity.as_ref().and_then(|a| a.indexer.as_ref());
        println!(
            "{:<7}  {:<11}  {:>8}  {:<10}  {:<7}  {:<9}  {:<9}  {:<8}  {:>5}  {}",
            state,
            by,
            pid,
            ps_ready_column(readiness),
            ps_gen_column(readiness),
            ps_pass_column(readiness),
            ps_action_column(readiness),
            ps_indexer_column(indexer),
            ps_queue_column(indexer),
            r.path
        );
    }
    Ok(())
}

/// Resolve the serving kind behind `holder_pid` with an `Identify`
/// round-trip to its control socket. Returns `None` when the holder has
/// no reachable control socket or does not answer; `chan ps` then shows
/// `-` in the BY column (the STATE column still distinguishes served vs
/// free).
async fn serving_kind(holder_pid: u32) -> Option<ServedBy> {
    let socket = control_socket_for_pid(holder_pid).await?;
    let message = chan_shell::send_control_request(&socket, chan_shell::ControlRequest::Identify)
        .await
        .ok()?;
    let identity: chan_shell::Identity = serde_json::from_str(&message).ok()?;
    Some(match identity.kind {
        chan_shell::ServeKind::Standalone => ServedBy::Standalone,
        chan_shell::ServeKind::Desktop => ServedBy::Desktop,
        chan_shell::ServeKind::Devserver => ServedBy::Devserver,
    })
}

async fn cmd_remove(path: PathBuf, personality: Personality) -> Result<()> {
    let lib = library()?;
    // Tear down a running serve first: `reset_workspace` takes the writer
    // flock and would otherwise fail `WorkspaceLocked` on a live serve.
    // Best-effort -- if we can't reach the holder, fall through and let the
    // reset surface the real error.
    // `remove: true` so a devserver/desktop host also unregisters the
    // workspace from its own library + overlay (not just the local config.toml).
    let _ = unserve_running(&lib, &path, true, personality).await;
    remove_from_registry(&lib, &path)
}

/// Forget `path` from the registry: drop the registry key and the whole
/// `~/.chan/workspaces/<key>/` metadata dir (trash included), leaving the
/// filesystem contents untouched. Shared by `chan workspace rm` and `chan
/// close --remove`. The caller is responsible for tearing down any running
/// serve first (`unregister_workspace` does not).
fn remove_from_registry(lib: &Library, path: &Path) -> Result<()> {
    // Capture the metadata root before `unregister_workspace` drops the
    // registry key (after which the path no longer resolves to it).
    let metadata_root = lib.workspace_paths_for(path).map(|p| p.root);
    let removed = lib
        .unregister_workspace(path)
        .with_context(|| format!("unregistering {}", path.display()))?;
    if removed {
        // `reset_workspace(Everything)` deliberately preserves the trash +
        // lock dirs (other callers rely on that). Forgetting a workspace means
        // "forget everything", so drop the whole metadata dir -- trash
        // included -- leaving no `~/.chan/workspaces/<key>/` behind.
        if let Some(root) = metadata_root {
            let _ = std::fs::remove_dir_all(&root);
        }
        println!("unregistered: {}", path.display());
    } else {
        println!("(not registered: {})", path.display());
    }
    Ok(())
}

/// `chan close {path}`: tear down a running server holding `path`, releasing
/// its writer lock. Best-effort -- "not currently served" (and an unreachable
/// holder) is treated as success, since the goal is "this workspace is not
/// served". With `remove`, it then also forgets the workspace from the
/// registry (`chan workspace rm`), INDEPENDENT of the teardown outcome.
async fn cmd_close(path: PathBuf, remove: bool, personality: Personality) -> Result<()> {
    let lib = library()?;
    // Pass `remove` through so a host (devserver/desktop) that serves this
    // workspace also unregisters it from its own library + overlay; the local
    // `remove_from_registry` below then handles the caller's config.toml +
    // metadata (and the not-served / standalone cases the host can't).
    match unserve_running(&lib, &path, remove, personality).await {
        Ok(UnserveOutcome::Unserved) => println!("closed: {}", path.display()),
        Ok(UnserveOutcome::NotServed) => println!("(not served: {})", path.display()),
        Ok(UnserveOutcome::Refused { active_terminals }) => {
            anyhow::bail!(
                "refusing to close {}: {active_terminals} live terminal(s)",
                path.display()
            );
        }
        // A reachable-but-failed teardown is still "best effort": report it,
        // then (with --remove) forget the workspace anyway.
        Err(e) => eprintln!(
            "chan: could not reach the server for {} ({e}); treating as closed.",
            path.display()
        ),
    }
    if remove {
        remove_from_registry(&lib, &path)?;
    }
    Ok(())
}

enum UnserveOutcome {
    /// A live holder was reached and told to unserve; its flock released.
    Unserved,
    /// No live process holds the workspace (unregistered, no lock record,
    /// or the recorded holder is gone).
    NotServed,
    /// A live holder refused teardown because live terminals would be killed.
    Refused { active_terminals: usize },
}

#[derive(Deserialize)]
struct LiveTerminalsBody {
    error: String,
    active_terminals: usize,
}

fn parse_live_terminals_refusal(message: &str) -> Option<usize> {
    let body: LiveTerminalsBody = serde_json::from_str(message).ok()?;
    (body.error == "live_terminals").then_some(body.active_terminals)
}

/// Shared by `chan close` and `chan workspace rm`. Discovers the process
/// serving `path` from its `writer.lock` record, reaches it over its
/// control socket, asks it to tear down (the server decides scope: a
/// dedicated serve exits, a devserver/desktop unmounts just that tenant),
/// and waits for the flock to release.
///
/// With `remove`, a HOST (devserver / desktop) also UNREGISTERS the workspace
/// from its library + overlay, so the removal is reflected in the host's own
/// registry -- not just the caller's local `config.toml`. This is what keeps a
/// devserver-served workspace from lingering in the launcher (and surviving a
/// restart) after `chan close --remove` / `chan workspace rm`.
async fn unserve_running(
    lib: &Library,
    path: &Path,
    remove: bool,
    personality: Personality,
) -> Result<UnserveOutcome> {
    // Normalize (strip any Windows `\\?\` verbatim prefix) so the path carried
    // in the Close request is in the same canonical form the serving host and
    // the registry key their runtimes under, rather than a verbatim-prefixed
    // form the two sides would have to agree to strip.
    let canonical = chan_workspace::paths::canonicalize_normalized(path);

    // Desktop close handoff, mirroring the `chan open` handoff. A running
    // same-user chan-desktop owns the workspace flock AND its own library +
    // overlay; the per-pid control socket reaches the embedded host (the window
    // closes) but never updates the desktop's runtime map, so the launcher shows
    // the workspace stale-on and a restart resurrects it. The well-known handoff
    // socket sidesteps that and the pid-discovery miss (a GUI desktop whose
    // runtime socket directory differs from the terminal's). Gated like the
    // open handoff: only the Desktop personality or the forced shim hands off,
    // never a plain standalone
    // binary; `CHAN_NO_DESKTOP_HANDOFF` opts out. Any non-`HandedOff` outcome
    // (no desktop, skew, error) drops through to the control-socket path below.
    let want_desktop_handoff = (personality == Personality::Desktop
        || chan_server::handoff::handoff_forced())
        && !chan_server::handoff::handoff_opt_out();
    if want_desktop_handoff {
        match chan_server::handoff::try_close_workspace(&canonical, remove).await {
            chan_server::handoff::Outcome::HandedOff => {
                // The desktop released its flock during teardown; wait it out so a
                // `chan open` racing right behind doesn't see a transient
                // WorkspaceLocked. Only the locally-registered case resolves a lock
                // dir to wait on.
                if let Some(paths) = lib.workspace_paths_for(path) {
                    wait_for_lock_release(&paths.lock);
                }
                return Ok(UnserveOutcome::Unserved);
            }
            chan_server::handoff::Outcome::CloseRefused { active_terminals } => {
                return Ok(UnserveOutcome::Refused { active_terminals });
            }
            _ => {}
        }
    }

    let Some(paths) = lib.workspace_paths_for(path) else {
        return Ok(UnserveOutcome::NotServed); // not registered => nothing serving
    };
    let Some(record) = chan_workspace::lock::read_lock_record(&paths.lock) else {
        return Ok(UnserveOutcome::NotServed); // no holder record on disk
    };
    let Some(socket) = control_socket_for_pid(record.pid).await else {
        // A record but no reachable control socket: the holder is gone
        // (stale record -- the lock is free / steal-able) or runs no control
        // socket. Nothing to tear down over the wire.
        return Ok(UnserveOutcome::NotServed);
    };
    match chan_shell::send_control_request(
        &socket,
        chan_shell::ControlRequest::Close {
            path: canonical,
            remove,
        },
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            let message = e.to_string();
            if let Some(active_terminals) = parse_live_terminals_refusal(&message) {
                return Ok(UnserveOutcome::Refused { active_terminals });
            }
            return Err(e)
                .with_context(|| format!("asking the server (pid {}) to tear down", record.pid));
        }
    }
    wait_for_lock_release(&paths.lock);
    Ok(UnserveOutcome::Unserved)
}

/// Find a control socket for `pid`. A window-spawned server's sockets carry
/// the pid in their name (`chan-control-<pid>-<rand>`) and match by name
/// alone; a devserver's are stable-named (`chan-control-s<hash>`, no pid,
/// so `$CHAN_CONTROL_SOCKET` survives its restarts) and are matched
/// by asking each candidate who it is (a bounded `Identify` round-trip whose
/// reply carries the serving pid). A dedicated `chan open` serve has exactly
/// one socket; a multi-tenant devserver has one per tenant under the same
/// pid. Either way every socket routes the `Close { path }` verb to the
/// server, which acts by path -- so the first match is sufficient and we
/// must NOT broadcast (once the first tenant unmounts, the rest 404). On
/// Unix the socket is a `.sock` file in `$XDG_RUNTIME_DIR` when present and
/// `/tmp` otherwise; on Windows it is a named pipe under the `\\.\pipe\`
/// namespace.
#[cfg(unix)]
async fn control_socket_for_pid(pid: u32) -> Option<PathBuf> {
    control_socket_for_pid_in_dirs(unix_control_socket_dirs(), pid, true).await
}

#[cfg(unix)]
async fn control_socket_for_workspace(
    pid: u32,
    workspace_root: &Path,
    metadata_key: &str,
) -> Option<PathBuf> {
    control_socket_for_workspace_in_dirs(
        unix_control_socket_dirs(),
        pid,
        workspace_root,
        metadata_key,
        true,
    )
    .await
}

#[cfg(unix)]
fn unix_control_socket_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
    {
        push_unique_path(&mut dirs, dir);
    }
    push_unique_path(&mut dirs, PathBuf::from("/tmp"));
    push_unique_path(&mut dirs, std::env::temp_dir());
    dirs
}

#[cfg(windows)]
async fn control_socket_for_pid(pid: u32) -> Option<PathBuf> {
    // Windows control sockets are named pipes under the `\\.\pipe\`
    // namespace, which is directory-enumerable.
    control_socket_for_pid_in_dirs([std::path::Path::new(r"\\.\pipe\")], pid, false).await
}

#[cfg(windows)]
async fn control_socket_for_workspace(
    pid: u32,
    workspace_root: &Path,
    metadata_key: &str,
) -> Option<PathBuf> {
    control_socket_for_workspace_in_dirs(
        [std::path::Path::new(r"\\.\pipe\")],
        pid,
        workspace_root,
        metadata_key,
        false,
    )
    .await
}

/// Overall bound on one stable-candidate `Identify` probe, so a wedged server
/// (accepts but never replies) cannot hang `chan ps` / `chan close`.
const STABLE_SOCKET_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

async fn control_socket_for_pid_in_dirs<I, P>(
    dirs: I,
    pid: u32,
    require_sock_ext: bool,
) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut seen: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let dir = dir.as_ref();
        if seen.iter().any(|seen| seen == dir) {
            continue;
        }
        seen.push(dir.to_path_buf());
    }
    // Pass 1, by name: a pid-named socket needs no round-trip.
    for dir in &seen {
        if let Some(socket) = control_socket_for_pid_in(dir, pid, require_sock_ext) {
            return Some(socket);
        }
    }
    // Pass 2, by identity: stable-named candidates carry no pid, so ask each
    // one who it is and match the reported pid. Dead sockets fail the connect
    // immediately; only a live-but-wedged one costs the probe timeout.
    for dir in &seen {
        for candidate in stable_control_socket_candidates(dir, require_sock_ext) {
            if socket_identity_pid(&candidate).await == Some(pid) {
                return Some(candidate);
            }
        }
    }
    None
}

async fn control_socket_for_workspace_in_dirs<I, P>(
    dirs: I,
    pid: u32,
    workspace_root: &Path,
    metadata_key: &str,
    require_sock_ext: bool,
) -> Option<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut candidates = Vec::new();
    for dir in dirs {
        let dir = dir.as_ref();
        for candidate in control_socket_candidates_for_pid_in(dir, pid, require_sock_ext) {
            push_unique_path(&mut candidates, candidate);
        }
        for candidate in stable_control_socket_candidates(dir, require_sock_ext) {
            push_unique_path(&mut candidates, candidate);
        }
    }
    for candidate in candidates {
        let Some(identity) = socket_identity(&candidate).await else {
            continue;
        };
        if identity.pid == pid
            && identity.workspace_root.as_deref() == Some(workspace_root)
            && identity.metadata_key.as_deref() == Some(metadata_key)
        {
            return Some(candidate);
        }
    }
    None
}

/// The stable-named control-socket candidates in `dir`, sorted for a
/// deterministic probe order.
fn stable_control_socket_candidates(dir: &Path, require_sock_ext: bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            stable_control_socket_name(&name.to_string_lossy(), require_sock_ext)
        })
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates
}

/// True when `name` is a devserver's STABLE control socket:
/// `chan-control-s<16 hex>`, `.sock`-suffixed on unix. The `s` marker and
/// exact shape separate it from the pid-scoped `chan-control-<digits>-<rand>`
/// family, which belongs to whatever process minted it; had one been the
/// holder's, the name pass would already have matched it, so the probe only
/// knocks on stable candidates instead of every serve's socket.
fn stable_control_socket_name(name: &str, require_sock_ext: bool) -> bool {
    let Some(rest) = name.strip_prefix("chan-control-s") else {
        return false;
    };
    let hash = match rest.strip_suffix(".sock") {
        Some(hash) => hash,
        None if require_sock_ext => return false,
        None => rest,
    };
    hash.len() == 16 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The pid serving `socket`, from a bounded `Identify` round-trip. `None` for
/// a dead / unreachable / wedged socket or an unparseable reply.
async fn socket_identity_pid(socket: &Path) -> Option<u32> {
    Some(socket_identity(socket).await?.pid)
}

async fn socket_identity(socket: &Path) -> Option<chan_shell::Identity> {
    let identify = chan_shell::send_control_request(socket, chan_shell::ControlRequest::Identify);
    let message = tokio::time::timeout(STABLE_SOCKET_PROBE_TIMEOUT, identify)
        .await
        .ok()?
        .ok()?;
    serde_json::from_str(&message).ok()
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn control_socket_candidates_for_pid_in(
    dir: &Path,
    pid: u32,
    require_sock_ext: bool,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            control_socket_name_matches(&entry.file_name().to_string_lossy(), pid, require_sock_ext)
        })
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates
}

fn control_socket_for_pid_in(dir: &Path, pid: u32, require_sock_ext: bool) -> Option<PathBuf> {
    control_socket_candidates_for_pid_in(dir, pid, require_sock_ext)
        .into_iter()
        .next()
}

/// True when `name` is a control socket for `pid`
/// (`chan-control-<pid>-<rand>`), optionally requiring the unix `.sock`
/// suffix (Windows named pipes have no extension).
fn control_socket_name_matches(name: &str, pid: u32, require_sock_ext: bool) -> bool {
    let prefix = format!("chan-control-{pid}-");
    name.starts_with(&prefix) && (!require_sock_ext || name.ends_with(".sock"))
}

/// Block (bounded) until the writer lock for `lock_dir` is free after a
/// serve was asked to unserve. The server drops the flock asynchronously
/// during graceful shutdown, so a `chan open` racing right behind would
/// otherwise see a transient `WorkspaceLocked`.
fn wait_for_lock_release(lock_dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !chan_workspace::lock::is_free(lock_dir) {
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
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

/// Resolve final listen address from the user's flags.
///
/// `--host` is authoritative when given; `-4` / `-6` only validate
/// its family. With no `--host`, `-4` selects 127.0.0.1, `-6` selects
/// ::1, and neither selects 127.0.0.1 (the historical default).
fn resolve_listen_addr(
    host: Option<IpAddr>,
    ipv4: bool,
    ipv6: bool,
    port: u16,
) -> Result<SocketAddr> {
    let ip = match host {
        Some(ip) => {
            if ipv4 && !ip.is_ipv4() {
                anyhow::bail!("-4 requires an IPv4 --host, got {ip}");
            }
            if ipv6 && !ip.is_ipv6() {
                anyhow::bail!("-6 requires an IPv6 --host, got {ip}");
            }
            ip
        }
        None if ipv6 => IpAddr::V6(Ipv6Addr::LOCALHOST),
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    Ok(SocketAddr::new(ip, port))
}

/// Emit the structured `vcs-parent` refusal to stderr. The shape is
/// a contract consumed by chan-desktop (and any other wrapping
/// shell):
///
///   - Exit code `70` (set by the caller after this returns).
///   - One stderr line begins with `chan-error: vcs-parent ` and
///     carries `kind=<git|hg|svn> repo_root=<abs path> path=<abs
///     path>` in that order, single-line, space-separated. Values
///     run to end-of-line so paths with spaces don't break the
///     parse; wrappers split on `key=` boundaries, not on spaces.
///   - The surrounding human-readable lines are advisory and may
///     change wording; the marker is the stable bit.
///
/// Documented in the desktop hand-off; do NOT reshape without
/// bumping the marker prefix (e.g. `chan-error-v2: ...`) so old
/// shells fail closed instead of silently misparsing.
fn print_vcs_parent_error(root: &Path, parent: &chan_workspace::VcsParent) {
    // Canonicalize both paths for the marker so wrappers get
    // absolute, symlink-resolved forms. Fall back to the input
    // when canonicalize fails (root may not yet exist on disk).
    let root_abs = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let repo_abs =
        std::fs::canonicalize(&parent.repo_root).unwrap_or_else(|_| parent.repo_root.clone());
    let kind_human = match parent.kind {
        chan_workspace::VcsKind::Git => "Git",
        chan_workspace::VcsKind::Mercurial => "Mercurial",
        chan_workspace::VcsKind::Subversion => "Subversion",
    };
    eprintln!(
        "error: workspace '{}' is inside a {} repository at '{}'.",
        root_abs.display(),
        kind_human,
        repo_abs.display(),
    );
    eprintln!("       Serving the repository root keeps cross-file links, the graph,");
    eprintln!("       and search aligned with the project boundary.");
    eprintln!(
        "chan-error: vcs-parent kind={} repo_root={} path={}",
        parent.kind.as_str(),
        repo_abs.display(),
        root_abs.display(),
    );
    eprintln!("hint: open repo root:    chan open {}", repo_abs.display());
    eprintln!(
        "hint: open only subdir:  chan open --here {}",
        root_abs.display(),
    );
}

/// Resolved `chan open` invocation: every CLI input after listen-addr
/// and prefix resolution, grouped so the handler takes one argument
/// instead of a 15-parameter tail.
struct ServeArgs {
    addr: SocketAddr,
    prefix: String,
    idle_timeout: Option<Duration>,
    path: Option<PathBuf>,
    here: bool,
    no_token: bool,
    no_browser: bool,
    search_aggression: Option<SearchAggression>,
    no_settings: bool,
    flags: OpenFlags,
    verbose: bool,
}

/// Optional value accepted by `chan open --devserver[=<port|url>]`.
/// `Auto` is the bare flag; a URL is normalized to its effective port because
/// local discovery identifies instances by their bound port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevserverSelector {
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
            "invalid devserver selector {raw:?}: expected a port or URL"
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

/// The explicit, mutually exclusive `chan open` target flags. clap's
/// `conflicts_with_all` rejects more than one at parse time; the routing
/// resolver ([`decide_open_route`]) guards the same invariant.
#[derive(Debug, Clone, Copy)]
struct OpenFlags {
    standalone: bool,
    desktop: bool,
    devserver: Option<DevserverSelector>,
}

/// Where `chan open` routes a workspace: bind a standalone server here, hand
/// it to chan-desktop, or register it with the local devserver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenTarget {
    Standalone,
    Desktop,
    Devserver,
}

/// The kind of chan instance that spawned the shell `chan open` runs in,
/// resolved from `$CHAN_CONTROL_SOCKET`. Drives the no-flag default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Parentage {
    /// A chan-desktop terminal: its control socket answers `Desktop`.
    Desktop,
    /// A `chan devserver` terminal: its control socket answers `Devserver`.
    Devserver { pid: u32 },
    /// No chan parent detected (a plain shell, not chan-spawned), an
    /// unreachable holder, or a standalone serve -- the load-bearing
    /// "undetectable -> standalone" case.
    None,
}

/// Why the routing decision could not pick a target.
#[derive(Debug, PartialEq, Eq)]
enum RouteError {
    /// More than one of --standalone / --desktop / --devserver was set.
    /// clap's `conflicts_with_all` normally rejects this first; the resolver
    /// guards it too so the decision stays self-contained.
    MultipleTargets,
    /// An explicit --devserver from inside a devserver shell: nesting one
    /// multi-tenant server in another is unsupported.
    NestedDevserver,
}

/// Side-effect-free liveness snapshot supplied to [`decide_open_route`].
/// The resolver needs only presence/count; concrete devserver selection is a
/// separate pure step after the target kind is chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct LiveInstances {
    desktop: bool,
    devservers: usize,
}

/// Resolve a `chan open` routing decision from explicit flags, shell parentage,
/// binary personality, chan-context presence, and a live-instance snapshot.
/// PURE: every probe and the actual handoff/registration live in the caller.
///
/// Precedence: an explicit flag wins (subject to the nested-devserver
/// refusal); otherwise a devserver parentage registers with that devserver
/// (a stronger signal than a forced-desktop env var inherited into the
/// shell), and desktop parentage hands off. With no identified parent, one live
/// kind wins; with both kinds live, the desktop personality chooses desktop and
/// the standalone personality chooses a devserver. With neither live, the
/// historical standalone/desktop-personality behavior remains. A present but
/// unidentified control socket preserves the conservative standalone fallback
/// only when no live instance supplies a stronger signal.
fn decide_open_route(
    flags: OpenFlags,
    parentage: Parentage,
    forced_desktop: bool,
    chan_context_present: bool,
    live: LiveInstances,
) -> Result<OpenTarget, RouteError> {
    let explicit = match (flags.standalone, flags.desktop, flags.devserver.is_some()) {
        (false, false, false) => None,
        (true, false, false) => Some(OpenTarget::Standalone),
        (false, true, false) => Some(OpenTarget::Desktop),
        (false, false, true) => Some(OpenTarget::Devserver),
        _ => return Err(RouteError::MultipleTargets),
    };

    if let Some(target) = explicit {
        if target == OpenTarget::Devserver && matches!(parentage, Parentage::Devserver { .. }) {
            return Err(RouteError::NestedDevserver);
        }
        return Ok(target);
    }

    Ok(match parentage {
        // In a devserver shell: register with the current devserver. This
        // beats a forced-desktop env var that leaked into the session, which
        // is what routed a devserver shell to chan-desktop before.
        Parentage::Devserver { .. } => OpenTarget::Devserver,
        Parentage::Desktop => OpenTarget::Desktop,
        // No identified parent. A sole live instance wins regardless of binary
        // personality. With both kinds live, the standalone personality prefers
        // a devserver and the desktop personality preserves its desktop contract.
        // With neither live, the desktop personality may launch the GUI. A
        // present-but-unidentified chan socket retains the conservative
        // standalone fallback only when no live target can correct the guess.
        Parentage::None => match (live.desktop, live.devservers > 0) {
            (true, false) => OpenTarget::Desktop,
            (false, true) => OpenTarget::Devserver,
            (true, true) if forced_desktop => OpenTarget::Desktop,
            (true, true) => OpenTarget::Devserver,
            (false, false) if chan_context_present => OpenTarget::Standalone,
            (false, false) if forced_desktop => OpenTarget::Desktop,
            (false, false) => OpenTarget::Standalone,
        },
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevserverSelectionError {
    NotFound {
        port: u16,
    },
    /// The shell's parent devserver is not among the live candidates (a
    /// pre-discovery instance, or a discovery bind that failed non-fatally).
    /// Registering anywhere else would mount the workspace on an instance
    /// the user did not mean, so selection refuses instead of guessing.
    ParentNotFound {
        pid: u32,
    },
    Ambiguous,
}

/// CLI-owned snapshot of a discovered instance. Keeping selection on this
/// value type makes the resolver independent of the transport handle carried
/// by `chan-server`'s discovery result.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DevserverCandidate {
    instance_index: usize,
    pid: u32,
    library_root: PathBuf,
    port: u16,
    version: String,
}

fn devserver_candidates(
    instances: &[chan_server::devserver_handoff::Instance],
) -> Vec<DevserverCandidate> {
    instances
        .iter()
        .enumerate()
        .map(|(instance_index, instance)| DevserverCandidate {
            instance_index,
            pid: instance.pid,
            library_root: instance.library_root.clone(),
            port: instance.port,
            version: instance.version.clone(),
        })
        .collect()
}

/// Resolve one concrete devserver without guessing. An explicit selector wins;
/// otherwise a devserver parent pid is stronger than the CLI's library root,
/// which is stronger than an arbitrary candidate order.
fn select_devserver<'a>(
    instances: &'a [DevserverCandidate],
    selector: Option<DevserverSelector>,
    parent_pid: Option<u32>,
    library_root: &Path,
) -> std::result::Result<Option<&'a DevserverCandidate>, DevserverSelectionError> {
    if let Some(DevserverSelector::Port(port)) = selector {
        let mut matches = instances.iter().filter(|instance| instance.port == port);
        let selected = matches.next();
        return match (selected, matches.next()) {
            (None, _) => Err(DevserverSelectionError::NotFound { port }),
            (Some(_), Some(_)) => Err(DevserverSelectionError::Ambiguous),
            (Some(instance), None) => Ok(Some(instance)),
        };
    }

    if instances.is_empty() {
        return Ok(None);
    }

    // Parentage binds BEFORE the sole-candidate short-circuit: a shell
    // spawned by devserver A must never be adopted by the only-visible
    // devserver B just because A's discovery socket is gone.
    if let Some(pid) = parent_pid {
        let mut matches = instances.iter().filter(|instance| instance.pid == pid);
        return match (matches.next(), matches.next()) {
            (Some(instance), None) => Ok(Some(instance)),
            (Some(_), Some(_)) => Err(DevserverSelectionError::Ambiguous),
            (None, _) => Err(DevserverSelectionError::ParentNotFound { pid }),
        };
    }

    if let [instance] = instances {
        return Ok(Some(instance));
    }

    let mut matches = instances
        .iter()
        .filter(|instance| same_path(&instance.library_root, library_root));
    match (matches.next(), matches.next()) {
        (Some(instance), None) => Ok(Some(instance)),
        _ => Err(DevserverSelectionError::Ambiguous),
    }
}

fn sorted_devservers(instances: &[DevserverCandidate]) -> Vec<&DevserverCandidate> {
    let mut sorted: Vec<_> = instances.iter().collect();
    sorted.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.library_root.cmp(&b.library_root))
            .then_with(|| a.version.cmp(&b.version))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    sorted
}

fn devserver_candidates_text(instances: &[DevserverCandidate]) -> String {
    let mut text = String::new();
    for instance in sorted_devservers(instances) {
        use std::fmt::Write as _;
        let _ = write!(
            text,
            "\n  port {}  library {}  chan {}",
            instance.port,
            instance.library_root.display(),
            instance.version,
        );
    }
    text
}

/// The chan control socket exported into a chan-spawned terminal
/// (`$CHAN_CONTROL_SOCKET`), trimmed and non-empty, or `None` outside a chan
/// session. Its mere presence marks "some chan context" even when the holder
/// cannot be identified.
fn chan_control_socket() -> Option<String> {
    std::env::var("CHAN_CONTROL_SOCKET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Overall bound on the parentage probe's `Identify` round-trip. A holder that
/// accepts the connection but never replies must not hang `chan open` (which
/// then goes on to run a resident server -- this is the only deadline, never a
/// command-wide one). Sized to the connect+read budget the desktop / devserver
/// handoffs use.
const PARENTAGE_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Resolve the kind of chan instance that spawned this shell by an `Identify`
/// round-trip on `$CHAN_CONTROL_SOCKET` -- the same control-socket /
/// serving-kind machinery `chan ps` uses. A chan-spawned terminal exports
/// that socket (`terminal_sessions`); a desktop shell points at the desktop's
/// embedded server, a devserver shell at the devserver. An absent socket (a
/// plain shell), an unreachable / wedged holder, or a `standalone` kind all
/// resolve to [`Parentage::None`].
async fn detect_parentage() -> Parentage {
    match chan_control_socket() {
        Some(socket) => probe_parentage(&PathBuf::from(socket), PARENTAGE_PROBE_TIMEOUT).await,
        None => Parentage::None,
    }
}

/// Identify the serving kind behind `socket` with a `timeout`-bounded
/// `Identify` round-trip. A wedged holder (accepts but never replies), a
/// connect failure, a read error, or a non-desktop/devserver reply all resolve
/// to [`Parentage::None`] so a stale / wedged socket cannot hang `chan open`.
/// `timeout` is injectable so the bound is unit-testable.
async fn probe_parentage(socket: &Path, timeout: Duration) -> Parentage {
    let identify = chan_shell::send_control_request(socket, chan_shell::ControlRequest::Identify);
    let Ok(Ok(message)) = tokio::time::timeout(timeout, identify).await else {
        return Parentage::None;
    };
    match serde_json::from_str::<chan_shell::Identity>(&message) {
        Ok(chan_shell::Identity {
            kind: chan_shell::ServeKind::Desktop,
            ..
        }) => Parentage::Desktop,
        Ok(chan_shell::Identity {
            kind: chan_shell::ServeKind::Devserver,
            pid,
            ..
        }) => Parentage::Devserver { pid },
        // A standalone holder, or a reply we cannot parse: not a context that
        // changes the default.
        _ => Parentage::None,
    }
}

/// Make a serve root absolute against the process cwd. `canonicalize`
/// resolves symlinks for an existing dir; `std::path::absolute` makes a
/// not-yet-created path absolute lexically (so `chan open new-dir` still
/// lands under the cwd); the final fallback returns the input unchanged
/// (only reachable if both fail, e.g. an unreadable cwd). The result must
/// be absolute so the desktop handoff -- which runs with cwd "/" -- and the
/// canonical-path-keyed registry both see the directory the user ran in.
fn absolutize_serve_root(root: PathBuf) -> PathBuf {
    std::fs::canonicalize(&root)
        .or_else(|_| std::path::absolute(&root))
        .unwrap_or(root)
}

/// Error for a command invoked without its required workspace path. Every
/// command names the workspace root explicitly; `hint` is a complete,
/// valid example invocation to suggest.
fn missing_workspace_path(cmd: &str, hint: &str) -> anyhow::Error {
    anyhow::anyhow!("chan {cmd} requires a workspace path; e.g. `{hint}`")
}

/// Discriminate `chan open`'s polymorphic argument: a value shaped like
/// `scheme://host…` is a devserver URL; everything else is a local workspace
/// path. We don't pull a URL crate for the discriminator -- the desktop parses
/// and validates the full URL when it dials. Requiring `://` with a non-empty
/// scheme and authority keeps a Windows path (`C:\…`) or a bare `host:port`
/// (no `//`) from misfiring as a URL, so the path/URL split is unambiguous.
fn looks_like_devserver_url(target: &str) -> bool {
    match target.split_once("://") {
        Some((scheme, rest)) => {
            !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
                && !rest.is_empty()
        }
        None => false,
    }
}

/// `chan open {url}`: REGISTER a devserver by URL via the CLI→desktop handoff,
/// then return. It does NOT dial/connect -- connecting is the launcher's
/// Connect button. The devserver entry lives in the desktop's config (the same
/// registry the launcher reads), so this needs a running chan-desktop to land
/// into; without one there is nowhere to persist it (no standalone fallback --
/// a URL is never served locally).
async fn cmd_open_devserver(
    url: String,
    name: Option<String>,
    script: Option<String>,
) -> Result<()> {
    // Refuse a devserver-in-a-devserver: this CLI running inside a devserver
    // session has no path to the desktop's registry, and nesting one headless
    // multi-tenant server inside another is not a shape the registry models.
    if in_devserver_context().await {
        anyhow::bail!(
            "cannot register a devserver from inside a devserver: `chan open {url}` writes \
             into the desktop's devserver registry, which a devserver session cannot reach. \
             Run it from chan-desktop (or a plain shell on the box running chan-desktop)."
        );
    }
    use chan_server::handoff::Outcome;
    match chan_server::handoff::try_open_devserver(&url, name.as_deref(), script.as_deref()).await {
        Outcome::HandedOff => {
            // Registered, not connected: point the user at the launcher's
            // Connect button. Labelled by --name when given, else the URL.
            let label = name.as_deref().unwrap_or(&url);
            println!("registered \"{label}\". Open it from the launcher.");
            Ok(())
        }
        Outcome::VersionSkew {
            desktop_version, ..
        } => anyhow::bail!(
            "chan-desktop is version {desktop_version}, CLI is {}; cannot register the \
             devserver. Restart chan-desktop to pick up the new version.",
            chan_server::handoff::CHAN_VERSION,
        ),
        Outcome::DesktopError { message } => {
            anyhow::bail!("chan-desktop could not register the devserver: {message}")
        }
        Outcome::CloseRefused { .. } => {
            anyhow::bail!("chan-desktop returned a close refusal while registering a devserver")
        }
        // No desktop = nowhere to register. Unlike the path form, a URL never
        // falls back to a standalone serve (mirrors the window-op "needs the
        // desktop" refusal).
        Outcome::NoDesktop => {
            anyhow::bail!("chan open {url} needs the chan desktop app running.")
        }
    }
}

/// True when this CLI runs inside a chan terminal that a `chan devserver`
/// serves -- `chan open {url}` would otherwise register a devserver into a
/// devserver, which the registry (a desktop-config concept) does not nest.
/// Shares [`detect_parentage`]'s `Identify` round-trip on
/// `$CHAN_CONTROL_SOCKET`; an absent socket / unreachable holder / any other
/// serving kind ⇒ not a devserver context (so a plain shell or a desktop
/// terminal proceeds to the handoff).
async fn in_devserver_context() -> bool {
    matches!(detect_parentage().await, Parentage::Devserver { .. })
}

async fn cmd_serve(args: ServeArgs, personality: Personality) -> Result<()> {
    let ServeArgs {
        addr,
        prefix,
        idle_timeout,
        path,
        here,
        no_token,
        no_browser,
        search_aggression,
        no_settings,
        flags,
        verbose,
    } = args;
    let lib = library()?;
    // `chan open {path}` requires an explicit workspace root; with no path it
    // is a clear error. An explicit path auto-registers, so `chan open
    // /some/dir` works without a prior `chan workspace add`.
    let root = path.ok_or_else(|| missing_workspace_path("open", "chan open ."))?;
    // Resolve to an absolute path against the CLI's cwd before anything
    // downstream consumes it. The macOS desktop handoff opens the
    // workspace in a process whose cwd is "/", and the workspace registry
    // is keyed by the canonical path, so a bare `chan open .` must not
    // leak a relative root (the desktop would resolve it against "/" and
    // open the filesystem root).
    let root = absolutize_serve_root(root);
    // VCS-parent gate. If `root` is inside a Git / Mercurial /
    // Subversion working tree, refuse with a structured error so a
    // wrapping shell (chan-desktop) can parse the marker line and
    // offer the user a choice between repo root and the subdir.
    // Runs before any state mutation: no directory creation, no
    // registry write. `--here` opts the caller out for the case
    // where serving the subdir is the genuine intent.
    if !here {
        if let Some(parent) = chan_workspace::detect_parent_vcs(&root) {
            print_vcs_parent_error(&root, &parent);
            std::process::exit(70);
        }
    }
    // Resolve parentage and live local instances before choosing one target.
    // Explicit standalone/desktop skips probes it does not need; discovery is
    // lazy on their eventual bind-collision path. Selection refusal happens
    // before the workspace root or registry is mutated.
    let forced_desktop =
        personality == Personality::Desktop || chan_server::handoff::handoff_forced();
    let chan_context_present = chan_control_socket().is_some();
    let parentage = if flags.standalone || flags.desktop {
        Parentage::None
    } else {
        detect_parentage().await
    };
    let no_explicit_target = !flags.standalone && !flags.desktop && flags.devserver.is_none();
    let devserver_opt_out = chan_server::devserver_handoff::devserver_handoff_opt_out();
    // A VALUED selector names a specific devserver; silently serving
    // standalone instead would be the wrong-instance outcome this flag exists
    // to prevent. The bare `--devserver` keeps its historical behavior under
    // the opt-out (skip the handoff, serve standalone), as does the env var
    // alone.
    if devserver_opt_out {
        if let Some(DevserverSelector::Port(port)) = flags.devserver {
            anyhow::bail!(
                "--devserver={port} conflicts with CHAN_NO_DEVSERVER_HANDOFF: the flag names \
                 a devserver to register with, but the environment opts this command out of \
                 devserver handoff. Unset CHAN_NO_DEVSERVER_HANDOFF, or drop --devserver={port}."
            );
        }
    }
    let desktop_opt_out = chan_server::handoff::handoff_opt_out();
    let need_devservers = !devserver_opt_out
        && (flags.devserver.is_some()
            || no_explicit_target
                && matches!(parentage, Parentage::None | Parentage::Devserver { .. }));
    let mut devservers = if need_devservers {
        Some(chan_server::devserver_handoff::discover_devservers().await)
    } else {
        None
    };
    let mut candidates = devservers
        .as_deref()
        .map(devserver_candidates)
        .unwrap_or_default();
    let desktop_live = !desktop_opt_out
        && no_explicit_target
        && parentage == Parentage::None
        && chan_server::handoff::desktop_is_live().await;
    let live = LiveInstances {
        desktop: desktop_live,
        devservers: candidates.len(),
    };
    let target =
        match decide_open_route(flags, parentage, forced_desktop, chan_context_present, live) {
            Ok(target) => target,
            Err(RouteError::NestedDevserver) => anyhow::bail!(
                "you are already in a devserver; omit --devserver to register with \
             it, or use --standalone / --desktop"
            ),
            // clap's `conflicts_with_all` rejects this at parse time; bail with the
            // same intent if it ever reaches here.
            Err(RouteError::MultipleTargets) => {
                anyhow::bail!("choose at most one of --standalone, --desktop, --devserver")
            }
        };

    let parent_pid = match parentage {
        Parentage::Devserver { pid } => Some(pid),
        Parentage::Desktop | Parentage::None => None,
    };
    let library_root = lib
        .config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(chan_workspace::paths::config_dir);
    let library_root = absolutize_serve_root(library_root);
    let selected_devserver = if target == OpenTarget::Devserver && !devserver_opt_out {
        match select_devserver(&candidates, flags.devserver, parent_pid, &library_root) {
            Ok(instance) => instance.map(|instance| instance.instance_index),
            Err(DevserverSelectionError::NotFound { port }) => anyhow::bail!(
                "no live local devserver matches --devserver={port}.{}\nUse `chan open \
                 --devserver` to select automatically, or start the requested instance.",
                devserver_candidates_text(&candidates),
            ),
            Err(DevserverSelectionError::ParentNotFound { pid }) => anyhow::bail!(
                "this shell was spawned by a devserver (pid {pid}) that is not among the \
                 live discovered devservers.{}\nExpected the spawning instance; refusing to \
                 register with a different one. Choose one explicitly with \
                 --devserver=<port|url>, or use --standalone.",
                devserver_candidates_text(&candidates),
            ),
            Err(DevserverSelectionError::Ambiguous) => anyhow::bail!(
                "multiple local devservers are live and no unique target was found for library \
                 {}.{}\nChoose one with --devserver=<port|url>.",
                library_root.display(),
                devserver_candidates_text(&candidates),
            ),
        }
    } else {
        None
    };

    // Create the workspace root only AFTER the route is settled, so a refused
    // route (nested devserver, conflicting flags) leaves no empty directory.
    if !root.exists() {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("creating workspace root {}", root.display()))?;
    }

    match target {
        // CLI-to-desktop handoff. When a same-user chan-desktop is running in a
        // GUI session, ask it to open this workspace in a native window and
        // EXIT; the desktop then owns the flock. Launch-if-absent is gated on
        // `forced_desktop` so only a `Personality::Desktop` binary (whose
        // `current_exe` IS the desktop) launches the GUI; a standalone binary
        // that reached this target via a live desktop parentage falls through
        // instead. Every fallback (no desktop, refused, skew, GUI-absent,
        // CHAN_NO_DESKTOP_HANDOFF) drops through to the standalone path below.
        OpenTarget::Desktop => {
            let desktop_known_live = desktop_live || parentage == Parentage::Desktop;
            if let Some(outcome) =
                maybe_handoff_to_desktop(&root, forced_desktop, desktop_known_live).await
            {
                if outcome.is_ok()
                    && forced_desktop
                    && parentage == Parentage::None
                    && live.desktop
                    && live.devservers > 0
                    && !candidates.is_empty()
                {
                    for instance in sorted_devservers(&candidates) {
                        println!(
                            "chan: local devserver on port {} (library {}, chan {}) was not \
                                 selected; use --devserver={} to choose it.",
                            instance.port,
                            instance.library_root.display(),
                            instance.version,
                            instance.port,
                        );
                    }
                }
                return outcome;
            }
        }
        // CLI-to-devserver registration. A running same-user devserver mounts
        // this workspace and owns its flock, so the CLI prints a note and exits
        // WITHOUT opening it. CHAN_NO_DEVSERVER_HANDOFF opts out (skip the
        // attempt, serve standalone); every non-registered outcome drops
        // through to the standalone path below.
        OpenTarget::Devserver => {
            if let Some(instance_index) = selected_devserver {
                let instance = &devservers
                    .as_ref()
                    .expect("selected devserver came from discovery")[instance_index];
                use chan_server::devserver_handoff::Outcome;
                match chan_server::devserver_handoff::try_register_devserver(instance, &root).await
                {
                    Outcome::Registered { prefix: _ } => {
                        println!(
                            "chan: registered {} with local devserver on port {} (library {}, chan \
                             {})",
                            root.display(),
                            instance.port,
                            instance.library_root.display(),
                            instance.version,
                        );
                        return Ok(());
                    }
                    Outcome::VersionSkew => {
                        eprintln!(
                            "chan: a local devserver is running a different version; \
                             cannot register. Starting a standalone server."
                        );
                    }
                    Outcome::Error(message) => {
                        eprintln!(
                            "chan: the local devserver could not mount this workspace \
                             ({message}); starting a standalone server."
                        );
                    }
                    Outcome::NoDevserver => {
                        if let Some(DevserverSelector::Port(port)) = flags.devserver {
                            anyhow::bail!(
                                "local devserver selected by --devserver={port} is no longer live"
                            );
                        }
                    }
                }
            }
        }
        // Bind a standalone server here -- the direct path below.
        OpenTarget::Standalone => {}
    }

    ensure_workspace_registered(&lib, &root)?;
    let workspace = match lib.open_workspace(&root) {
        Ok(workspace) => workspace,
        // A live foreign writer holds the flock -- often a local devserver that
        // already serves this workspace. Point the user at --devserver to
        // register with it instead of fighting for the lock. Worded as a
        // possibility: we have not confirmed the holder IS a devserver.
        Err(chan_workspace::ChanError::WorkspaceLocked) => anyhow::bail!(
            "the workspace is held by another process; if a local devserver \
             owns it, run `chan open --devserver` to register with it."
        ),
        Err(e) => return Err(e.into()),
    };

    // Best-effort update notice. The banner reads cached state
    // (no network) so an air-gapped host pays zero startup cost.
    // The probe runs as a detached tokio task with short timeouts;
    // its failures are swallowed at `debug` level. Honors
    // CHAN_UPDATE_CHECK=0 and the standard *_PROXY env vars
    // (reqwest reads them automatically).
    update::maybe_print_banner();
    tokio::spawn(update::run_probe());

    // Loud warning: the auth model assumes loopback. No TLS, only a
    // bearer token. Binding off-loopback exposes the workspace in the
    // clear to anyone on that network, including unauthenticated
    // probes if --no-token is also set.
    let host = addr.ip();
    if !host.is_loopback() {
        eprintln!(
            "WARNING: binding to {host} exposes chan on a non-loopback \
             interface. There is no TLS; the bearer token is sent in \
             plaintext. Do not use this on an untrusted network."
        );
        if no_token {
            eprintln!(
                "WARNING: --no-token + non-loopback host = open read/write \
                 access to your workspace for anyone who can reach this port."
            );
        }
    }

    if no_settings {
        eprintln!("chan: --no-settings is set; the SPA will grey the cog and all settings-write routes will refuse with 403.");
    }
    let config = ServeConfig {
        addr,
        no_token,
        prefix,
        idle_timeout,
        // Default: open the browser on bind. --no-browser opts out
        // (desktop shells that host the UI in their own window,
        // headless / scripted invocations). Honored in both local
        // and tunnel mode.
        open_browser: !no_browser,
        search_aggression,
        verbose,
        // Local serve trusts the operator by default; --no-settings opts
        // into the UI grey + server 403 for kiosk / shared-workstation
        // deployments where the operator is not the workspace owner.
        settings_disabled: no_settings,
    };
    // A standalone `chan open` and a devserver share DEFAULT_PORT. On collision,
    // use the discovery snapshot to distinguish one of this user's devservers
    // from an unrelated holder. Explicit standalone/desktop routes discover
    // lazily here so their healthy startup path pays no probe cost.
    let serve_result = chan_server::serve(lib, workspace, config).await;
    if let Err(err) = &serve_result {
        if devserver_port_collision_hint(addr.port(), err, &[]).is_some() && devservers.is_none() {
            devservers = Some(chan_server::devserver_handoff::discover_devservers().await);
            candidates = devservers
                .as_deref()
                .map(devserver_candidates)
                .unwrap_or_default();
        }
        if let Some(hint) = devserver_port_collision_hint(addr.port(), err, &candidates) {
            return Err(anyhow::anyhow!(hint));
        }
    }
    serve_result.with_context(|| format!("running server on {addr}"))
}

/// Actionable hint for the one bind failure a user is most likely to hit and
/// least likely to diagnose: `chan open` falling through to a standalone bind
/// on `DEFAULT_PORT`. Returns `Some` only for an `AddrInUse` on exactly that
/// port; every other error keeps the generic server context. A discovered
/// same-user devserver is named only when it reports the collided port.
fn devserver_port_collision_hint(
    port: u16,
    err: &chan_server::Error,
    instances: &[DevserverCandidate],
) -> Option<String> {
    if port != DEFAULT_PORT {
        return None;
    }
    let chan_server::Error::Io(io_err) = err else {
        return None;
    };
    if io_err.kind() != std::io::ErrorKind::AddrInUse {
        return None;
    }
    if let Some(instance) = instances.iter().find(|instance| instance.port == port) {
        return Some(format!(
            "port {DEFAULT_PORT} is already in use, and your local devserver on that port \
             (library {}, chan {}) did not mount this workspace. Re-run with \
             `--devserver={DEFAULT_PORT}` to register there, or `--port N` to bind a \
             standalone server elsewhere.",
            instance.library_root.display(),
            instance.version,
        ));
    }
    Some(format!(
        "port {DEFAULT_PORT} is already in use, but no devserver of yours was discovered \
         on that port. The holder may be another process, another user's devserver, or \
         your own devserver from an older chan version (pre-discovery instances are \
         invisible here). Re-run with `--port N` to bind a standalone server elsewhere."
    ))
}

/// Devserver twin of [`devserver_port_collision_hint`]: an actionable message
/// for the devserver's own listener failing to bind with `AddrInUse` (the only
/// fallible bind that escapes `run_devserver`; the discovery-socket bind is
/// non-fatal). Unlike the serve-path hint this fires for ANY port and names
/// it, so a deliberate squatter against an explicit `--port` reads as a
/// collision in the journal instead of a generic anyhow chain. `None` for
/// every other error, which keeps its context unchanged.
fn devserver_bind_collision_hint(addr: SocketAddr, err: &anyhow::Error) -> Option<String> {
    let io_err = err.root_cause().downcast_ref::<std::io::Error>()?;
    if io_err.kind() != std::io::ErrorKind::AddrInUse {
        return None;
    }
    let squatter = if addr.port() == DEFAULT_PORT {
        "most likely another `chan devserver` or a standalone `chan open` \
         server (both default to it)"
    } else {
        "another process owns it"
    };
    Some(format!(
        "chan devserver: could not bind {addr}: the port is already in use -- \
         {squatter}. Stop the other process or re-run with a different \
         `--port` (a listening tunnel-mode devserver defaults to an \
         OS-assigned free port)."
    ))
}

/// Run a headless multi-workspace devserver. The no-service default and
/// `--service=none` run in the foreground on `bind:port`; `--service=chan` is
/// the portable background daemon; `--service=systemd`/`launchd` are OS-backed
/// services driven by explicit action verbs (`--start`/`--stop`/`--restart`/
/// `--status`/`--join`). [`plan_devserver`] validates the `(service, action)`
/// pair before we touch any real service manager.
#[allow(clippy::too_many_arguments)]
async fn cmd_devserver(
    bind: Option<IpAddr>,
    port: Option<u16>,
    service: ServiceKind,
    start: bool,
    stop: bool,
    restart: bool,
    status: bool,
    join: bool,
    rotate_token: bool,
    force: bool,
    tunnel_url: Option<String>,
    tunnel_token: Option<String>,
    tunnel_devserver_name: Option<String>,
    no_tunnel: bool,
    verbose: bool,
) -> Result<()> {
    // Backend-agnostic: rotation dials whatever devserver persisted its
    // port, or falls back to the config file, so it never needs the
    // service plan below.
    if rotate_token {
        return cmd_rotate_devserver_token().await;
    }
    // `--no-tunnel` drops the token before anything can read it, so a devserver
    // spawned from a shell that inherited CHAN_TUNNEL_TOKEN stays local when
    // asked to. The supervised path takes the flag itself as well, to decline
    // the PAT persisted in the unit (see [`supervised_tunnel_spec`]).
    let tunnel_token = tunnel_token.filter(|_| !no_tunnel);
    // An endpoint is required with a token, but not necessarily HERE: a
    // supervised verb recovers it from the installed unit, which is the whole
    // point of a flagless `--restart`. Resolution stays lazy so that path is
    // reachable at all; the foreground and `chan` backends have nothing
    // persisted to read, so they demand it at the point of use.
    let tunnel_url = tunnel_url.filter(|url| !url.trim().is_empty());
    let action = selected_devserver_action(start, stop, restart, status, join);
    // Resolve `--service=auto` (the default) to a concrete backend from the
    // runtime OS, then validate it exactly like an explicit backend. After this
    // no `Auto` reaches `plan_devserver` or any downstream dispatch.
    let service = if service == ServiceKind::Auto {
        let resolved = resolve_auto(std::env::consts::OS, action.is_some())
            .map_err(|msg| anyhow::anyhow!("chan devserver: {msg}"))?;
        // Only the auto path probes systemd availability; an explicit
        // `--service=systemd` is left to fail later with systemctl's own error.
        if resolved == ServiceKind::Systemd {
            require_systemd_for_auto(systemd_available())
                .map_err(|msg| anyhow::anyhow!("chan devserver: {msg}"))?;
        }
        resolved
    } else {
        service
    };
    let plan =
        plan_devserver(service, action).map_err(|msg| anyhow::anyhow!("chan devserver: {msg}"))?;

    match plan {
        DevPlan::Foreground(ServiceKind::None) => {
            let tunnel =
                build_devserver_tunnel(tunnel_token, tunnel_url, tunnel_devserver_name.as_deref())?;
            // Tunnel mode defaults to NOT binding the loopback port (the gateway
            // is the surface, and it 404s the management API anyway), but under
            // systemd notify it does bind so `chan devserver --restart` fdstore
            // parking can reach the local management API. `CHAN_DEVSERVER_LISTEN`
            // overrides either way.
            let under_systemd = std::env::var_os("NOTIFY_SOCKET").is_some();
            let listen = resolve_devserver_listen(
                tunnel.is_some(),
                under_systemd,
                devserver_listen_override(),
            )?;
            // The requested address for a fresh foreground start: explicit
            // flags win; the port default depends on the resolved mode (see
            // `resolve_devserver_port`). Management verbs recompute theirs
            // from the running service's persisted address instead (see
            // `service_target_addr`).
            let requested = SocketAddr::new(
                bind.unwrap_or(DEFAULT_DEVSERVER_BIND),
                resolve_devserver_port(port, tunnel.is_some(), listen),
            );
            warn_non_loopback_bind(requested);
            run_devserver_foreground(requested, tunnel, listen).await
        }
        DevPlan::Foreground(kind) => {
            unreachable!("plan_devserver only routes none to Foreground, got {kind:?}")
        }
        DevPlan::ChanVerb(action) => {
            // Preserve the daemon's bound address when --bind/--port are omitted.
            let addr = service_target_addr(ServiceKind::Chan, bind, port);
            match action {
                DevAction::Stop => devserver_daemon::stop_devserver_chan(verbose).await,
                DevAction::Restart => {
                    warn_non_loopback_bind(addr);
                    let tunnel = build_devserver_tunnel(
                        tunnel_token,
                        tunnel_url,
                        tunnel_devserver_name.as_deref(),
                    )?;
                    devserver_daemon::restart_devserver_chan(addr, force, verbose, tunnel).await
                }
                DevAction::Status => devserver_daemon::status_devserver_chan(verbose),
                DevAction::Start => {
                    warn_non_loopback_bind(addr);
                    let tunnel = build_devserver_tunnel(
                        tunnel_token,
                        tunnel_url,
                        tunnel_devserver_name.as_deref(),
                    )?;
                    devserver_daemon::run_devserver_as_chan(addr, force, verbose, tunnel).await
                }
                DevAction::Join => {
                    warn_non_loopback_bind(addr);
                    let tunnel = build_devserver_tunnel(
                        tunnel_token,
                        tunnel_url,
                        tunnel_devserver_name.as_deref(),
                    )?;
                    devserver_daemon::join_devserver_chan(addr, force, verbose, tunnel).await
                }
            }
        }
        DevPlan::Supervised(kind, action) => {
            // launchd would have to persist a tunnel PAT in the plist (0644) to
            // re-exec with it, so tunnel mode is refused there. systemd instead
            // writes the unit 0600 (see write_devserver_unit) and carries the
            // token via Environment=, so it is supported.
            if tunnel_token.is_some() && kind == ServiceKind::Launchd {
                anyhow::bail!(
                    "chan devserver: tunnel mode (--tunnel-token) is not supported under \
                     --service=launchd; the launch agent would persist the token in the \
                     plist (0644). Use --service=chan or --service=systemd, or run the \
                     devserver in the foreground."
                );
            }
            // Preserve the running service's bound address when --bind/--port are
            // omitted (per field: explicit flag > persisted > default), so a
            // flagless --restart/--join keeps what the service runs on.
            let addr = service_target_addr(kind, bind, port);
            let tunnel = supervised_tunnel_spec(
                kind,
                tunnel_token,
                tunnel_url,
                tunnel_devserver_name.as_deref(),
                force,
                no_tunnel,
                bind,
                port,
                read_systemd_unit().as_deref(),
            )?;
            run_supervised_devserver(kind, action, addr, force, verbose, tunnel).await
        }
    }
}

/// Warn when a devserver bind exposes a non-loopback interface: there is no TLS,
/// only the persisted bearer-token gate.
fn warn_non_loopback_bind(addr: SocketAddr) {
    if !addr.ip().is_loopback() {
        eprintln!(
            "WARNING: binding to {} exposes the devserver on a non-loopback \
             interface. There is no TLS and only a bearer-token gate; reach a \
             remote devserver over `ssh -L` instead of binding it publicly.",
            addr.ip()
        );
    }
}

/// Build the foreground tunnel config from `--tunnel-token`, warning when the
/// secret arrived on the command line (visible in `ps`) rather than via
/// `CHAN_TUNNEL_TOKEN`. Only the foreground / `chan` paths reach this; the
/// systemd/launchd refusal lives at the call site. These backends persist no
/// unit to reuse an endpoint from, so a token with no `--tunnel-url` /
/// `CHAN_TUNNEL_URL` is an error here -- the same refusal the supervised path
/// only reaches once the installed unit has come up empty too.
fn build_devserver_tunnel(
    tunnel_token: Option<String>,
    tunnel_url: Option<String>,
    tunnel_devserver_name: Option<&str>,
) -> Result<Option<chan_server::DevserverTunnel>> {
    let Some(token) = tunnel_token else {
        return Ok(None);
    };
    // clap does not expose the arg source, so compare to the env directly.
    if std::env::var("CHAN_TUNNEL_TOKEN").ok().as_deref() != Some(token.as_str()) {
        eprintln!(
            "WARNING: --tunnel-token is visible in `ps` output. \
             Prefer CHAN_TUNNEL_TOKEN env var instead."
        );
    }
    let tunnel_url = tunnel_url.context(MISSING_TUNNEL_URL)?;
    Ok(Some(chan_server::DevserverTunnel {
        tunnel_url,
        token,
        name: resolve_tunnel_devserver_name(tunnel_devserver_name),
    }))
}

/// The refusal when tunnel mode is asked for with no endpoint to dial. Shared
/// so the unsupervised backends and the supervised one (which reaches it only
/// after the installed unit yields no endpoint either) read identically.
const MISSING_TUNNEL_URL: &str =
    "chan devserver: tunnel mode requires --tunnel-url or CHAN_TUNNEL_URL";

/// Hidden daemon child tunnel config. The token is never accepted as an argv
/// field here; the parent passes it through CHAN_TUNNEL_TOKEN only. The name
/// is not a secret and rides argv (`--tunnel-devserver-name`).
fn build_devserver_tunnel_from_env(
    tunnel_url: Option<String>,
    tunnel_devserver_name: Option<String>,
) -> Result<Option<chan_server::DevserverTunnel>> {
    let Some(token) = std::env::var("CHAN_TUNNEL_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
    else {
        return Ok(None);
    };
    let tunnel_url = tunnel_url
        .filter(|url| !url.trim().is_empty())
        .context("CHAN_TUNNEL_URL or --tunnel-url is required with CHAN_TUNNEL_TOKEN")?;
    Ok(Some(chan_server::DevserverTunnel {
        tunnel_url,
        token,
        name: resolve_tunnel_devserver_name(tunnel_devserver_name.as_deref()),
    }))
}

/// Gateway bound on a devserver's roster label
/// (`gateway/crates/profile/src/http.rs`, `create_devserver`): 64 bytes.
/// The CLI caps the announced name to the same bound so the gateway
/// never has to reject it.
const TUNNEL_DEVSERVER_NAME_MAX_BYTES: usize = 64;

/// Normalize an explicit `--tunnel-devserver-name`: map control
/// characters to spaces, collapse whitespace runs, trim, and cap at
/// the gateway's 64-byte label bound (truncating on a char boundary).
/// Control characters never reach the wire or the systemd unit from
/// here: an interior newline would inject unit directives into
/// `Environment=` and an ANSI escape would corrupt whatever renders
/// the name. A blank value (after mapping) reads as absent so the
/// hostname default applies.
fn normalize_tunnel_devserver_name(raw: &str) -> Option<String> {
    let mapped: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate_on_char_boundary(&collapsed, TUNNEL_DEVSERVER_NAME_MAX_BYTES).to_string())
}

/// The display name a tunnel registration announces for the gateway
/// roster: the explicit `--tunnel-devserver-name` when given, else this
/// box's hostname (via [`devserver_host_label`]). Never empty.
fn resolve_tunnel_devserver_name(explicit: Option<&str>) -> String {
    explicit
        .and_then(normalize_tunnel_devserver_name)
        .unwrap_or_else(|| {
            normalize_tunnel_devserver_name(&devserver_host_label())
                .expect("devserver_host_label never yields a blank label")
        })
}

/// The longest prefix of `s` that fits in `max` bytes without splitting
/// a UTF-8 code point.
fn truncate_on_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A tunnel registration to bake into a systemd unit: the PAT that flips the
/// devserver into tunnel mode and the gateway endpoint it dials.
struct SystemdTunnel {
    token: String,
    url: String,
    /// The `--bind` to pin in the unit's ExecStart: `Some` when given
    /// explicitly now or already pinned in the persisted tunnel unit. `None`
    /// omits the flag, so the service resolves the loopback default.
    pinned_bind: Option<IpAddr>,
    /// The `--port` to pin in the unit's ExecStart, same explicitness rule as
    /// `pinned_bind`. `None` omits the flag, so a listening tunnel-mode
    /// service binds an OS-assigned port (see [`resolve_devserver_port`]);
    /// the assigned port is never written back here, or a restart would
    /// fossilize it as if the user chose it.
    pinned_port: Option<u16>,
    /// The roster display name to pin in the unit's environment
    /// (`CHAN_TUNNEL_DEVSERVER_NAME`), same explicitness rule as the
    /// address pins: `Some` when given explicitly now or persisted in
    /// the tunnel unit. `None` omits the variable, so the service
    /// resolves its hostname default at runtime.
    pinned_name: Option<String>,
}

/// Build the tunnel spec for a systemd unit, resolving every field as "the
/// explicit value wins, else what the installed unit already carries". A
/// flagless `--restart` therefore comes back as the same registration it went
/// down as, which is the contract the `--restart` help states.
///
/// The PAT is the load-bearing case: the unit's 0600 `Environment=` is its ONLY
/// store, so a management verb run from a shell that cannot see
/// `CHAN_TUNNEL_TOKEN` must read it back out ([`persisted_tunnel_token`]).
/// Dropping it would rewrite the unit as a plain local devserver and destroy
/// the credential in the same write. An explicit token still wins, which is how
/// a rotated PAT is installed, and `--no-tunnel` declines both -- the deliberate
/// way back to a local devserver.
///
/// The endpoint keeps its own rule, "reuse the first-run value, refresh on
/// --force": a flagless restart prefers the endpoint already in the unit and
/// `--force` prefers the CLI one, each falling back to the other so a restart
/// never fails over an endpoint one of the two can supply. The address pins
/// follow the `--port` help contract instead (omit = preserve, so `--force`
/// does not drop them): an explicit CLI flag pins, else a pin persisted in a
/// TUNNEL unit carries over (see [`persisted_tunnel_pins`]). The display name
/// follows the same pin rule via `CHAN_TUNNEL_DEVSERVER_NAME`.
///
/// Returns None when nothing selects tunnel mode (no token from either source,
/// or `--no-tunnel`) or the backend is not systemd (launchd tunnel mode is
/// refused upstream). Errs only when a token IS in play and neither the CLI nor
/// the unit names an endpoint for it.
#[allow(clippy::too_many_arguments)]
fn supervised_tunnel_spec(
    kind: ServiceKind,
    tunnel_token: Option<String>,
    tunnel_url: Option<String>,
    tunnel_devserver_name: Option<&str>,
    force: bool,
    no_tunnel: bool,
    bind: Option<IpAddr>,
    port: Option<u16>,
    persisted_unit: Option<&str>,
) -> Result<Option<SystemdTunnel>> {
    if kind != ServiceKind::Systemd || no_tunnel {
        return Ok(None);
    }
    let Some(token) = tunnel_token.or_else(|| persisted_unit.and_then(persisted_tunnel_token))
    else {
        return Ok(None);
    };
    let persisted_url = persisted_unit.and_then(persisted_tunnel_url);
    let url = if force {
        tunnel_url.or(persisted_url)
    } else {
        persisted_url.or(tunnel_url)
    }
    .context(MISSING_TUNNEL_URL)?;
    let (persisted_bind, persisted_port) = persisted_unit
        .map(persisted_tunnel_pins)
        .unwrap_or((None, None));
    Ok(Some(SystemdTunnel {
        token,
        url,
        pinned_bind: bind.or(persisted_bind),
        pinned_port: port.or(persisted_port),
        pinned_name: tunnel_devserver_name
            .and_then(normalize_tunnel_devserver_name)
            .or_else(|| persisted_unit.and_then(persisted_tunnel_name)),
    }))
}

/// The `--bind`/`--port` pins a persisted TUNNEL unit carries in its
/// ExecStart, each field independently. A tunnel unit persists these flags
/// only when the user chose them (see `devserver_systemd_unit_spec`), so
/// presence IS the explicitness record; a defaulted field is simply absent. A
/// non-tunnel unit (no `--tunnel-url=`) yields no pins: it always persists
/// its address, so carrying that over into a tunnel unit would fossilize a
/// default as if the user picked it.
fn persisted_tunnel_pins(unit: &str) -> (Option<IpAddr>, Option<u16>) {
    if persisted_tunnel_url(unit).is_none() {
        return (None, None);
    }
    (
        persisted_flag_value(unit, "--bind=").and_then(|v| v.parse().ok()),
        persisted_flag_value(unit, "--port=").and_then(|v| v.parse().ok()),
    )
}

/// The display name a persisted TUNNEL unit pins via its
/// `Environment="CHAN_TUNNEL_DEVSERVER_NAME=..."` line, if any. Same
/// explicitness record as [`persisted_tunnel_pins`]: the unit carries
/// the variable only when the user chose a name, and a non-tunnel unit
/// yields nothing. The `%%` specifier escaping the write site applies is
/// undone here so a `%`-containing name round-trips literally.
fn persisted_tunnel_name(unit: &str) -> Option<String> {
    persisted_tunnel_url(unit)?;
    let value = persisted_unit_environment(unit, "CHAN_TUNNEL_DEVSERVER_NAME")?.replace("%%", "%");
    (!value.is_empty()).then_some(value)
}

/// The gateway endpoint a persisted unit records. The `ExecStart` flag is what
/// the service actually dials, so it wins; `CHAN_TUNNEL_URL` in the unit
/// environment -- the copy the devserver's child sessions inherit -- is read as
/// a fallback, so a unit provisioned with only the variable still restarts.
/// Presence of either is what marks a unit as a tunnel unit.
fn persisted_tunnel_url(unit: &str) -> Option<String> {
    if let Some(flag) = persisted_flag_value(unit, "--tunnel-url=").filter(|v| !v.is_empty()) {
        return Some(flag.to_owned());
    }
    let value = persisted_unit_environment(unit, "CHAN_TUNNEL_URL")?.replace("%%", "%");
    (!value.is_empty()).then_some(value)
}

/// The PAT a persisted tunnel unit carries in its 0600 `Environment=`. Read
/// back verbatim: the write site does not escape the token (a `chan_pat_` is
/// base64url, so it has no `%` for systemd to expand and no quote to strip),
/// and a credential must survive the round trip byte for byte or the restart
/// re-registers with a corrupted PAT. Deliberately ungated on the endpoint: a
/// unit carrying a token IS a tunnel unit, and one with no resolvable endpoint
/// must fail loudly rather than silently rewrite itself local and take the only
/// copy of the credential with it.
fn persisted_tunnel_token(unit: &str) -> Option<String> {
    let token = persisted_unit_environment(unit, "CHAN_TUNNEL_TOKEN")?;
    (!token.is_empty()).then(|| token.to_owned())
}

/// The value of an `Environment="KEY=value"` line in a persisted unit, read up
/// to the closing quote so values containing spaces survive the round trip.
/// Callers undo whatever escaping their own write site applies.
fn persisted_unit_environment<'a>(unit: &'a str, key: &str) -> Option<&'a str> {
    let marker = format!("Environment=\"{key}=");
    let start = unit.find(&marker)? + marker.len();
    let rest = &unit[start..];
    Some(&rest[..rest.find('"')?])
}

/// Dispatch a `systemd`/`launchd` action verb: `--start` (create + enable +
/// start, then return), `--stop` (stop + disable), `--restart` (rewrite + bounce,
/// then return), `--status`, or `--join` (ensure running, then attach + block).
/// Both backends compile on every target and are gated at runtime via `cfg!`, so
/// a wrong-OS request errors clearly rather than silently doing nothing.
async fn run_supervised_devserver(
    kind: ServiceKind,
    action: DevAction,
    addr: SocketAddr,
    force: bool,
    verbose: bool,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    match kind {
        ServiceKind::Systemd => {
            if !cfg!(target_os = "linux") {
                anyhow::bail!(
                    "chan devserver: the systemd backend is Linux-only; use --service=chan."
                );
            }
            match action {
                DevAction::Start => start_devserver_under_systemd(addr, tunnel).await,
                DevAction::Stop => stop_devserver_under_systemd().await,
                DevAction::Restart => restart_devserver_under_systemd(addr, force, tunnel).await,
                DevAction::Status => run_devserver_status(kind, verbose).await,
                DevAction::Join => join_devserver_under_systemd(addr, tunnel).await,
            }
        }
        ServiceKind::Launchd => {
            if !cfg!(target_os = "macos") {
                anyhow::bail!(
                    "chan devserver: the launchd backend is macOS-only; use --service=chan."
                );
            }
            match action {
                DevAction::Start => start_devserver_under_launchd(addr).await,
                DevAction::Stop => stop_devserver_under_launchd().await,
                DevAction::Restart => restart_devserver_under_launchd(addr).await,
                DevAction::Status => run_devserver_status(kind, verbose).await,
                DevAction::Join => join_devserver_under_launchd(addr).await,
            }
        }
        ServiceKind::Auto | ServiceKind::None | ServiceKind::Chan => {
            unreachable!("plan_devserver only routes systemd/launchd to Supervised")
        }
    }
}

/// Report whether the resolved backend's service is running, then exit. The
/// `chan` daemon reads its pidfile; systemd/launchd bridge `is-active` /
/// `launchctl print`.
async fn run_devserver_status(kind: ServiceKind, verbose: bool) -> Result<()> {
    match kind {
        ServiceKind::Chan => devserver_daemon::status_devserver_chan(verbose),
        ServiceKind::Systemd => {
            if cfg!(target_os = "linux") {
                let running = unit_is_active().await;
                println!(
                    "chan devserver (systemd): {} -- {DEVSERVER_SYSTEMD_UNIT}",
                    if running { "running" } else { "not running" }
                );
                if let Some(cmd) = read_systemd_unit().and_then(|u| systemd_execstart_line(&u)) {
                    println!("  command: {cmd}");
                }
                Ok(())
            } else {
                anyhow::bail!("chan devserver: the systemd backend is Linux-only.")
            }
        }
        ServiceKind::Launchd => {
            if cfg!(target_os = "macos") {
                let uid = current_uid().await?;
                let running = launchd_is_active(uid).await;
                println!(
                    "chan devserver (launchd): {} -- {DEVSERVER_LAUNCHD_LABEL}",
                    if running { "running" } else { "not running" }
                );
                if let Some(cmd) =
                    read_launch_agent_plist().and_then(|p| launchd_program_arguments(&p))
                {
                    println!("  command: {cmd}");
                }
                Ok(())
            } else {
                anyhow::bail!("chan devserver: the launchd backend is macOS-only.")
            }
        }
        ServiceKind::None => unreachable!("--service=none has no service to report status on"),
        ServiceKind::Auto => unreachable!("resolve_auto replaces Auto before dispatch"),
    }
}

/// The bound address for a `--restart`/`--join` whose `--bind`/`--port` were
/// omitted: each field falls back to the running backend's persisted address so
/// a flagless restart keeps what the service runs on.
fn service_target_addr(kind: ServiceKind, bind: Option<IpAddr>, port: Option<u16>) -> SocketAddr {
    resolve_devserver_addr(bind, port, persisted_devserver_addr(kind))
}

/// Apply the `--stop`/`--restart` address precedence per field: an explicit CLI
/// flag wins, else the running service's persisted value, else the built-in
/// default. Pure (the FS read that yields `persisted` lives in the caller) so the
/// precedence stays unit-testable.
fn resolve_devserver_addr(
    bind: Option<IpAddr>,
    port: Option<u16>,
    persisted: Option<SocketAddr>,
) -> SocketAddr {
    let ip = bind
        .or_else(|| persisted.map(|a| a.ip()))
        .unwrap_or(DEFAULT_DEVSERVER_BIND);
    let port = port
        .or_else(|| persisted.map(|a| a.port()))
        .unwrap_or(DEFAULT_PORT);
    SocketAddr::new(ip, port)
}

/// The address the RUNNING systemd devserver serves its management API on,
/// for the verbs that dial it (the `--stop` / `--force` terminal drain,
/// `--join`'s health watch) and the bind= report lines. Unit-persisted `--bind`/`--port`
/// flags are the truth when present; a tunnel unit with no pinned port binds
/// an OS-assigned one, which the service records in the devserver config at
/// bind time (before READY=1, so an `is-active` unit has already written it).
/// `None` when neither source knows a port.
fn running_systemd_devserver_addr() -> Option<SocketAddr> {
    let unit = read_systemd_unit();
    let ip = unit
        .as_deref()
        .and_then(|unit| persisted_flag_value(unit, "--bind=")?.parse().ok())
        .unwrap_or(DEFAULT_DEVSERVER_BIND);
    let port = unit
        .as_deref()
        .and_then(|unit| persisted_flag_value(unit, "--port=")?.parse().ok())
        .or_else(chan_server::persisted_devserver_port)?;
    Some(SocketAddr::new(ip, port))
}

/// The address a supervised backend persisted for its running (or last) service,
/// or None when nothing is recorded. systemd/launchd carry it in the unit /
/// agent the supervisor wrote (which survive a `--stop`); the `chan` daemon
/// carries it in its pidfile.
fn persisted_devserver_addr(kind: ServiceKind) -> Option<SocketAddr> {
    match kind {
        ServiceKind::Chan => devserver_daemon::persisted_devserver_addr_chan(),
        ServiceKind::Systemd => devserver_addr_from_persisted_args(&read_systemd_unit()?),
        ServiceKind::Launchd => devserver_addr_from_persisted_args(&read_launch_agent_plist()?),
        ServiceKind::None | ServiceKind::Auto => None,
    }
}

/// Parse the `--bind=<ip>` / `--port=<port>` the supervisor persisted into a unit
/// ExecStart line or a launchd plist's ProgramArguments, into the bound address.
/// Each value is read up to the next whitespace or `<`, so it works for both the
/// shell-style ExecStart and the XML-wrapped plist `<string>`. None if either
/// flag is missing or unparseable.
fn devserver_addr_from_persisted_args(text: &str) -> Option<SocketAddr> {
    let ip: IpAddr = persisted_flag_value(text, "--bind=")?.parse().ok()?;
    let port: u16 = persisted_flag_value(text, "--port=")?.parse().ok()?;
    Some(SocketAddr::new(ip, port))
}

/// The value immediately following `flag` in `text`, read up to the next
/// whitespace or `<` (the XML element close in a plist).
fn persisted_flag_value<'a>(text: &'a str, flag: &str) -> Option<&'a str> {
    let start = text.find(flag)? + flag.len();
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '<')
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// The persisted systemd unit contents, if the file exists.
fn read_systemd_unit() -> Option<String> {
    std::fs::read_to_string(systemd_user_unit_dir().ok()?.join(DEVSERVER_SYSTEMD_UNIT)).ok()
}

/// The persisted launchd agent plist contents, if the file exists.
fn read_launch_agent_plist() -> Option<String> {
    std::fs::read_to_string(launch_agent_path().ok()?).ok()
}

/// The `ExecStart=` command line from a systemd unit's text, for `--status`.
fn systemd_execstart_line(unit: &str) -> Option<String> {
    unit.lines()
        .find_map(|l| l.strip_prefix("ExecStart=").map(|s| s.trim().to_string()))
}

/// A launchd plist's `ProgramArguments` joined into one command line, for
/// `--status`. Pulls each `<string>` inside the `<array>` and unescapes it.
fn launchd_program_arguments(plist: &str) -> Option<String> {
    let array = plist
        .split_once("<array>")
        .and_then(|(_, rest)| rest.split_once("</array>"))
        .map(|(inner, _)| inner)?;
    let args: Vec<String> = array
        .match_indices("<string>")
        .filter_map(|(i, tag)| {
            array[i + tag.len()..]
                .split_once("</string>")
                .map(|(value, _)| unescape_plist_xml(value))
        })
        .collect();
    (!args.is_empty()).then(|| args.join(" "))
}

/// Reverse of [`xml_escape`] for displaying persisted plist `<string>` values.
/// `&amp;` is undone last so an escaped entity body is not re-decoded.
fn unescape_plist_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Whether the foreground devserver binds a local TCP listener. Non-tunnel always
/// binds. Tunnel mode defaults to no-bind (the gateway is the surface) EXCEPT
/// under systemd notify, where the loopback management API is needed so
/// `chan devserver --stop` / `--restart --force` can drain the terminals
/// explicitly (restart itself needs no call: the fd store preserves PTYs).
/// `CHAN_DEVSERVER_LISTEN`
/// forces either way. Tunnel-off + LISTEN=0 leaves nothing reachable (no local
/// listener, no tunnel -- only the `chan open` discovery socket), so it is a
/// hard error rather than a silently-unreachable devserver.
fn resolve_devserver_listen(
    tunnel_mode: bool,
    under_systemd_notify: bool,
    listen_override: Option<bool>,
) -> Result<bool> {
    let listen = listen_override.unwrap_or(!tunnel_mode || under_systemd_notify);
    if !listen && !tunnel_mode {
        anyhow::bail!(
            "chan devserver: CHAN_DEVSERVER_LISTEN=0 with no tunnel leaves nothing reachable \
             (no local listener and no tunnel). Set CHAN_TUNNEL_TOKEN to publish through the \
             gateway, or unset CHAN_DEVSERVER_LISTEN to bind the local listener."
        );
    }
    Ok(listen)
}

/// Read `CHAN_DEVSERVER_LISTEN` as a tri-state: unset or empty ⇒ `None` (use the
/// tunnel-mode default), `"0"` ⇒ `Some(false)`, any other non-empty value ⇒
/// `Some(true)` (mirrors `CHAN_NO_DESKTOP_HANDOFF`'s truthiness).
fn devserver_listen_override() -> Option<bool> {
    std::env::var("CHAN_DEVSERVER_LISTEN")
        .ok()
        .and_then(|v| parse_listen_override(&v))
}

/// Pure parse for [`devserver_listen_override`] so the tri-state is unit-tested
/// without touching the process environment.
fn parse_listen_override(raw: &str) -> Option<bool> {
    if raw.is_empty() {
        None
    } else {
        Some(raw != "0")
    }
}

/// The port a fresh foreground devserver binds. An explicit `--port` always
/// wins, tunnel mode included. A LISTENING tunnel-mode devserver defaults to
/// `0` (the OS assigns a free port): its listener is management-only plumbing
/// behind the gateway -- nothing depends on the number, the bound port is
/// read back from `local_addr()` and persisted -- while a fixed 8787 default
/// collides with whatever else owns that port, and the systemd unit path
/// restarts into the same collision forever. Everything else keeps
/// [`DEFAULT_PORT`], whose equality with `chan open`'s default powers the
/// serve-path collision hint.
fn resolve_devserver_port(explicit: Option<u16>, tunnel_mode: bool, listen: bool) -> u16 {
    match explicit {
        Some(port) => port,
        None if tunnel_mode && listen => 0,
        None => DEFAULT_PORT,
    }
}

/// Run the devserver in the foreground. The no-supervisor default and the
/// systemd unit's `ExecStart` / launchd agent's `ProgramArguments` all land
/// here. `tunnel` carries the gateway registration when `--tunnel-token` is
/// set; the supervised backends never pass it (tunnel mode is foreground-only).
async fn run_devserver_foreground(
    addr: SocketAddr,
    tunnel: Option<chan_server::DevserverTunnel>,
    listen: bool,
) -> Result<()> {
    let lib = library()?;
    let result = chan_server::run_devserver(
        lib,
        chan_server::DevserverConfig {
            addr,
            host_label: devserver_host_label(),
            tunnel,
            listen,
        },
    )
    .await;
    // A bind collision gets the actionable hint (mirrors `cmd_serve`); under
    // systemd it lands in the journal as the loud failure line.
    if let Err(err) = &result {
        if let Some(hint) = devserver_bind_collision_hint(addr, err) {
            return Err(anyhow::anyhow!(hint));
        }
    }
    result.context("running devserver")
}

/// Human label for the box, shown in the management API. Falls back to a
/// generic label when the hostname is empty.
fn devserver_host_label() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    if host.trim().is_empty() {
        "devserver".to_string()
    } else {
        host
    }
}

/// The systemd user unit name for the devserver.
const DEVSERVER_SYSTEMD_UNIT: &str = "chan-devserver.service";
/// Matches the unit's `TimeoutStartSec=10min`, which outlives the bounded
/// eight-minute startup restore before the devserver emits `READY=1`.
const DEVSERVER_SYSTEMD_START_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Supervise the devserver under a systemd user service: ensure linger,
/// create + start the unit (or re-attach to a running one), then stream its
/// journal until the unit stops. The controlling terminal sees the
/// devserver's output and notices when it dies, and a unit that cannot
/// start exits non-zero loudly so a watching desktop catches it.
/// What a `--service` watchdog polls to decide the backing server is still up.
/// One probe per backend, so [`run_health_watchdog`] is shared by the
/// self-managed `chan` daemon, systemd, and launchd.
enum DaemonLiveness {
    /// The self-managed `chan` daemon: its pidfile still names this live pid.
    /// The pid re-pins when a `--restart` replaces the daemon (see
    /// [`DaemonLiveness::adopt_restarted`]).
    Chan { record_path: PathBuf, pid: u32 },
    /// A systemd user service: `systemctl --user is-active`.
    Systemd,
    /// A launchd LaunchAgent: `launchctl print` reports running.
    Launchd { uid: u32 },
}

impl DaemonLiveness {
    async fn alive(&self) -> bool {
        match self {
            DaemonLiveness::Chan { record_path, pid } => matches!(
                chan_workspace::daemon_lock::read_daemon_record(record_path),
                Some(r) if r.pid == *pid && chan_workspace::daemon_lock::is_record_live(&r)
            ),
            DaemonLiveness::Systemd => unit_is_active().await,
            DaemonLiveness::Launchd { uid } => launchd_is_active(*uid).await,
        }
    }

    /// chan backend only: after [`DaemonLiveness::alive`] came back false,
    /// look for a RESTARTED daemon to adopt. `--restart` spawns a new pid and
    /// rewrites daemon.json, so a join pinned to the attach-time pid would
    /// otherwise die by design at the first tick after every restart. A new
    /// live record is adopted only when its address equals `addr` -- the
    /// address this join resolved, health-probes, and (through the connect
    /// script's port forward) serves to whoever launched it -- because a
    /// daemon that came back on a different bind is not the server this
    /// join's callers are wired to. systemd/launchd probes re-resolve the
    /// service on every tick, so they have nothing to re-pin. Returns
    /// `(old_pid, new_pid)` when a restarted daemon was adopted.
    fn adopt_restarted(&mut self, addr: &str) -> Option<(u32, u32)> {
        let DaemonLiveness::Chan { record_path, pid } = self else {
            return None;
        };
        let record = chan_workspace::daemon_lock::read_daemon_record(record_path)?;
        if record.pid == *pid
            || record.addr != addr
            || !chan_workspace::daemon_lock::is_record_live(&record)
        {
            return None;
        }
        let old_pid = *pid;
        *pid = record.pid;
        Some((old_pid, record.pid))
    }
}

/// How long the watched backend may fail CONTINUOUSLY (liveness lost or
/// `/api/health` missing) before an attached join gives up. Sized to ride out
/// a `--restart` bounce (stopping the old instance alone may take up to 15s)
/// and slow-network stalls; the trade-off is that a genuinely dead server is
/// reported up to this much later.
const WATCHDOG_GRACE: Duration = Duration::from_secs(30);

/// Pause between watchdog probe passes.
const WATCHDOG_TICK: Duration = Duration::from_secs(2);

/// Per-probe `/api/health` timeout, deliberately larger than the tick: a
/// loaded box answering in 2-4s is slow, not dead, and must not consume
/// grace.
const WATCHDOG_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// What one watchdog probe pass observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchdogSample {
    /// The backend is alive and `/api/health` answered 2xx.
    Healthy,
    /// The backend liveness probe failed and (chan backend) no restarted
    /// daemon was there to adopt.
    BackendGone,
    /// The backend is alive but `/api/health` missed: non-2xx, transport
    /// error, or timeout.
    HealthMiss,
    /// chan backend: the pinned daemon is gone but a restarted one now serves
    /// the same address, and its pid was adopted. A success.
    Repinned { old_pid: u32, new_pid: u32 },
}

impl WatchdogSample {
    /// Whether this sample closes (or keeps closed) the failure window.
    fn is_success(self) -> bool {
        matches!(
            self,
            WatchdogSample::Healthy | WatchdogSample::Repinned { .. }
        )
    }
}

/// What [`WatchdogState::observe`] tells the watchdog loop to do next.
#[derive(Debug, PartialEq, Eq)]
enum WatchdogVerdict {
    /// Keep probing quietly: healthy, or inside the failure window with grace
    /// left.
    Watching,
    /// The first failing sample after health: the failure window just opened.
    /// The loop narrates the wait once.
    LostContact,
    /// A success closed an open failure window. The loop narrates it once.
    Recovered,
    /// The failure window outlived the grace: report the backend dead.
    GiveUp,
}

/// The watchdog's failure-window arithmetic, kept apart from probing and
/// sleeping so tests drive it with manufactured instants. A join bails only
/// after [`WATCHDOG_GRACE`] of CONTINUOUS failure; any success fully resets
/// the window, so restart bounces and transient stalls read as a narrated
/// wait instead of a dead connection.
struct WatchdogState {
    grace: Duration,
    /// When the current uninterrupted run of failing samples began.
    failing_since: Option<Instant>,
}

impl WatchdogState {
    fn new(grace: Duration) -> Self {
        Self {
            grace,
            failing_since: None,
        }
    }

    fn observe(&mut self, sample: WatchdogSample, now: Instant) -> WatchdogVerdict {
        if sample.is_success() {
            return match self.failing_since.take() {
                Some(_) => WatchdogVerdict::Recovered,
                None => WatchdogVerdict::Watching,
            };
        }
        match self.failing_since {
            None => {
                self.failing_since = Some(now);
                WatchdogVerdict::LostContact
            }
            Some(since) if now.duration_since(since) >= self.grace => WatchdogVerdict::GiveUp,
            Some(_) => WatchdogVerdict::Watching,
        }
    }
}

/// One watchdog probe pass: backend liveness first, then the bounded health
/// probe. A chan-backend join whose pinned pid is gone checks for a restarted
/// daemon on the same address before counting the pass as a failure, so a
/// `--restart` reads as a re-pin instead of a death.
async fn watchdog_probe(
    liveness: &mut DaemonLiveness,
    client: &reqwest::Client,
    health_url: &str,
    addr: &str,
) -> WatchdogSample {
    if !liveness.alive().await {
        return match liveness.adopt_restarted(addr) {
            Some((old_pid, new_pid)) => WatchdogSample::Repinned { old_pid, new_pid },
            None => WatchdogSample::BackendGone,
        };
    }
    if health_ok(client, health_url, WATCHDOG_PROBE_TIMEOUT).await {
        WatchdogSample::Healthy
    } else {
        WatchdogSample::HealthMiss
    }
}

/// Resolve when a non-terminal stdin reaches EOF.
///
/// SSH remote commands and the desktop control terminal give `--join` a pipe
/// for stdin. Closing that transport does not reliably signal the remote
/// process, so stdin EOF is the ownership boundary that keeps a healthy
/// watchdog from becoming an orphan. A real terminal stays Ctrl-C-driven.
async fn wait_for_join_stdin_eof() {
    use std::io::IsTerminal;

    if std::io::stdin().is_terminal() {
        return std::future::pending::<()>().await;
    }

    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let _ = std::thread::Builder::new()
        .name("chan-join-stdin".to_string())
        .spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
            let _ = closed_tx.send(());
        });
    // A thread-spawn failure drops the sender and detaches safely. The backing
    // service remains supervised either way.
    let _ = closed_rx.await;
}

/// Stay foreground watching a running `--service` backend until it dies or the
/// user detaches with Ctrl-C or its non-TTY stdin closes -- the unified
/// reattach contract (no journald / launchd log follow). Detaching leaves the
/// backing server running and exits 0. The server dying exits non-zero, but
/// only after [`WATCHDOG_GRACE`] of continuous failure: a `--restart` bounce or
/// a slow network shows as a narrated wait + re-attach instead of killing the
/// join (whose exit tears down the desktop connection riding on it). The exit
/// code still tells the launcher survey a clean detach from a crash.
async fn run_health_watchdog(
    addr: &str,
    mut liveness: DaemonLiveness,
    subject: &str,
) -> Result<()> {
    let health_url = format!("http://{addr}/api/health");
    let client = reqwest::Client::new();
    let mut state = WatchdogState::new(WATCHDOG_GRACE);
    let stdin_eof = wait_for_join_stdin_eof();
    tokio::pin!(stdin_eof);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                eprintln!("chan devserver: detached; the {subject} keeps running.");
                return Ok(());
            }
            _ = &mut stdin_eof => {
                // The controlling pipe is normally gone too, so do not print:
                // eprintln! would panic on a broken stderr pipe.
                return Ok(());
            }
            // The probe rides inside the select so Ctrl-C stays responsive
            // even while a slow health request is in flight.
            sample = async {
                tokio::time::sleep(WATCHDOG_TICK).await;
                watchdog_probe(&mut liveness, &client, &health_url, addr).await
            } => {
                if let WatchdogSample::Repinned { old_pid, new_pid } = sample {
                    eprintln!(
                        "chan devserver: the {subject} restarted (pid {old_pid} -> {new_pid}); \
                         watching the new process."
                    );
                }
                match state.observe(sample, Instant::now()) {
                    WatchdogVerdict::Watching => {}
                    WatchdogVerdict::LostContact => eprintln!(
                        "chan devserver: lost contact with the {subject}; waiting up to {}s \
                         for it to come back (Ctrl-C detaches).",
                        WATCHDOG_GRACE.as_secs()
                    ),
                    WatchdogVerdict::Recovered => {
                        // A re-pin already narrated its own recovery above.
                        if !matches!(sample, WatchdogSample::Repinned { .. }) {
                            eprintln!(
                                "chan devserver: the {subject} is answering again; \
                                 staying attached."
                            );
                        }
                    }
                    WatchdogVerdict::GiveUp => match sample {
                        WatchdogSample::BackendGone => {
                            anyhow::bail!("chan devserver: the {subject} is no longer running.")
                        }
                        _ => anyhow::bail!(
                            "chan devserver: the {subject} stopped answering /api/health."
                        ),
                    },
                }
            }
        }
    }
}

/// One bounded `/api/health` probe; any non-2xx, transport error, or timeout
/// is a miss.
async fn health_ok(client: &reqwest::Client, url: &str, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, client.get(url).send()).await {
        Ok(Ok(resp)) => resp.status().is_success(),
        _ => false,
    }
}

/// `chan devserver --service=systemd --start`: ensure the unit is up (linger +
/// write/enable/start when it is not already running), then return. Enables the
/// unit so it also comes back on boot. Idempotent: a no-op (beyond re-providing
/// the token) when the service is already active.
async fn start_devserver_under_systemd(
    addr: SocketAddr,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    ensure_systemd_linger().await?;
    if unit_is_active().await {
        emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
        eprintln!(
            "chan devserver: the systemd user service {DEVSERVER_SYSTEMD_UNIT} is already running."
        );
        return Ok(());
    }
    bootstrap_systemd_unit(addr, false, false, tunnel).await?;
    // Report the address the service actually bound: a tunnel unit with no
    // pinned port is on an OS-assigned one, not the requested default.
    eprintln!(
        "chan devserver: started the systemd user service {DEVSERVER_SYSTEMD_UNIT} (bind={}).",
        running_systemd_devserver_addr().unwrap_or(addr)
    );
    Ok(())
}

/// `chan devserver --service=systemd --join`: ensure the unit is running (start
/// it if down, re-attach if up), then stay attached and block on the health
/// watchdog until Ctrl-C. This is the "bring it up and watch it" form connect
/// scripts use; unlike `--start` it does not return until the service stops or
/// the user detaches.
async fn join_devserver_under_systemd(
    addr: SocketAddr,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    ensure_systemd_linger().await?;

    if unit_is_active().await {
        // Re-attaching to a unit that is already running. A journal follow
        // won't re-emit the unit's original start line, so the supervisor
        // re-provides the token contract itself (see emit_devserver_token_marker).
        emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
        eprintln!(
            "chan devserver: re-attaching to the running systemd user service \
             {DEVSERVER_SYSTEMD_UNIT}"
        );
    } else {
        bootstrap_systemd_unit(addr, false, false, tunnel).await?;
        eprintln!(
            "chan devserver: started the systemd user service \
             {DEVSERVER_SYSTEMD_UNIT} (bind={})",
            running_systemd_devserver_addr().unwrap_or(addr)
        );
    }

    // Watch the address the service actually bound: a tunnel unit with no
    // pinned port is on an OS-assigned one, recorded by the service at bind.
    let addr = running_systemd_devserver_addr().unwrap_or(addr);
    run_health_watchdog(
        &addr.to_string(),
        DaemonLiveness::Systemd,
        &format!("systemd user service {DEVSERVER_SYSTEMD_UNIT}"),
    )
    .await
}

trait DevserverSystemdControl {
    async fn command(&mut self, args: &[&str]) -> Result<()>;
    async fn wait_active(&mut self, timeout: Duration) -> bool;
}

struct LiveDevserverSystemdControl;

impl DevserverSystemdControl for LiveDevserverSystemdControl {
    async fn command(&mut self, args: &[&str]) -> Result<()> {
        systemctl_user(args).await
    }

    async fn wait_active(&mut self, timeout: Duration) -> bool {
        wait_until_active(timeout).await
    }
}

async fn activate_devserver_unit(
    update: &DevserverUnitUpdate,
    restart: bool,
    restore_active: bool,
    control: &mut impl DevserverSystemdControl,
) -> Result<()> {
    let mut restart_attempted = false;
    let activation = async {
        if update.changed {
            control.command(&["daemon-reload"]).await?;
        }
        if restart {
            // enable (so it survives logout) + restart (bounce a running unit,
            // start a stopped one); `enable --now` does not bounce an active unit.
            control.command(&["enable", DEVSERVER_SYSTEMD_UNIT]).await?;
            restart_attempted = true;
            control
                .command(&["restart", DEVSERVER_SYSTEMD_UNIT])
                .await?;
        } else {
            control
                .command(&["enable", "--now", DEVSERVER_SYSTEMD_UNIT])
                .await?;
        }
        if !control.wait_active(DEVSERVER_SYSTEMD_START_TIMEOUT).await {
            anyhow::bail!(
                "the systemd user service {DEVSERVER_SYSTEMD_UNIT} failed to become active"
            );
        }
        Ok(())
    }
    .await;
    let Err(error) = activation else {
        return Ok(());
    };
    if !update.changed {
        return Err(error);
    }

    let mut rollback_errors = Vec::new();
    if let Err(rollback_error) = update.rollback_file() {
        rollback_errors.push(format!("unit restore failed: {rollback_error:#}"));
    }
    if let Err(rollback_error) = control.command(&["daemon-reload"]).await {
        rollback_errors.push(format!("rollback daemon-reload failed: {rollback_error:#}"));
    }
    if restore_active && restart_attempted {
        if let Err(rollback_error) = control.command(&["restart", DEVSERVER_SYSTEMD_UNIT]).await {
            rollback_errors.push(format!("previous-unit restart failed: {rollback_error:#}"));
        }
    }
    // Continuous fdstore parking preserves live PTYs across ANY number of
    // restarts, the rollback's second one included, so a rollback needs no
    // terminal-impact caveat: the store re-feeds the parked masters to
    // whichever unit definition comes up.
    let terminal_impact = if restore_active && restart_attempted {
        "; live terminal PTYs restore from the systemd fd store"
    } else {
        ""
    };
    if rollback_errors.is_empty() {
        let rollback = if update.previous.is_some() {
            "restored the previous unit"
        } else {
            "removed the newly installed unit"
        };
        anyhow::bail!(
            "systemd unit activation failed: {error:#}; {rollback} at {}{terminal_impact}",
            update.path.display(),
        );
    }
    anyhow::bail!(
        "systemd unit activation failed: {error:#}; rollback was incomplete: {}{terminal_impact}",
        rollback_errors.join("; "),
    )
}

/// Write the unit for `addr` and bring it up: `daemon-reload`, then `enable
/// --now` for a first start or `enable` + `restart` to bounce/(re)start under
/// `--restart` (`enable --now` would not bounce an already-running unit). Waits
/// until active and surfaces the bearer token. Shared by the first-start path
/// and [`restart_devserver_under_systemd`]; the caller owns linger + the
/// started/restarted log line + watching the service.
async fn bootstrap_systemd_unit(
    addr: SocketAddr,
    restart: bool,
    restore_active: bool,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    let update = write_devserver_unit(addr, tunnel)?;
    if update.changed {
        eprintln!("chan devserver: wrote {}", update.path.display());
    }
    let mut control = LiveDevserverSystemdControl;
    if let Err(error) =
        activate_devserver_unit(&update, restart, restore_active, &mut control).await
    {
        anyhow::bail!("{error:#}\n{}", recent_unit_journal().await);
    }
    // The freshly started service prints the token marker to its own stdout,
    // which under the unit lands in the journal -- invisible to this terminal
    // on a host with no readable journal. Emit it directly from the persisted
    // config so the desktop reconnects regardless; fail loud if it never
    // lands rather than claim "started" on a token we cannot surface.
    emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
    Ok(())
}

/// `chan devserver --service=systemd --restart`: rewrite the unit (current
/// binary + `addr`), bounce it (or start it if stopped), then return. Linger is
/// ensured first, mirroring the start path. Continuous fdstore parking makes
/// the bounce preserve live PTYs by itself; `--force` is the destructive
/// variant, draining every session through the management API first (and
/// falling back to stop-then-start when the drain cannot complete, so a
/// wedged devserver still restarts WITHOUT resurrecting its terminals).
/// Use `--join` to stay attached.
async fn restart_devserver_under_systemd(
    addr: SocketAddr,
    force: bool,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    ensure_systemd_linger().await?;
    let mut was_running = unit_is_active().await;
    if was_running && force {
        eprintln!(
            "chan devserver: WARNING: restarting systemd service destructively because --force was supplied"
        );
        // Dial the RUNNING service's management API for the drain: a tunnel
        // unit with no pinned port serves on an OS-assigned port, not the
        // requested/default `addr`.
        let dial = running_systemd_devserver_addr().unwrap_or(addr);
        let drain = drain_devserver_terminals(dial).await;
        was_running =
            force_teardown_before_restart(drain, &mut LiveDevserverSystemdControl).await?;
    }
    bootstrap_systemd_unit(addr, true, was_running, tunnel).await?;
    eprintln!(
        "chan devserver: {} the systemd user service {DEVSERVER_SYSTEMD_UNIT} (bind={})",
        if was_running { "restarted" } else { "started" },
        running_systemd_devserver_addr().unwrap_or(addr)
    );
    Ok(())
}

/// The `--force` teardown decision: a confirmed drain keeps the normal
/// preserved-restart path (the sessions are already dead), while ANY drain
/// failure must stop the unit first -- a plain restart re-feeds the parked
/// fds and would resurrect the sessions `--force` promised to kill. Stop
/// releases the fd store (masters close, shells HUP) before the fresh
/// activation. Returns whether the unit is still running afterwards.
async fn force_teardown_before_restart(
    drain: std::result::Result<(), String>,
    control: &mut impl DevserverSystemdControl,
) -> Result<bool> {
    match drain {
        Ok(()) => Ok(true),
        Err(reason) => {
            eprintln!(
                "chan devserver: WARNING: terminal drain failed ({reason}); \
                 stopping the unit first so --force stays destructive"
            );
            control.command(&["stop", DEVSERVER_SYSTEMD_UNIT]).await?;
            Ok(false)
        }
    }
}

/// POST the drain endpoint: every terminal session is closed and the child
/// processes waited on before this returns Ok. Err carries the reason the
/// drain could not be confirmed (no token, connect failure, timeout, or
/// lingering children); callers decide how destructive to be about it.
async fn drain_devserver_terminals(addr: SocketAddr) -> std::result::Result<(), String> {
    let Some(token) = chan_server::persisted_devserver_token() else {
        return Err("could not read the devserver token".to_string());
    };
    let url = format!("http://{addr}/api/devserver/terminal-sessions/drain");
    let client = reqwest::Client::new();
    let request = client.post(&url).bearer_auth(token).send();
    // The server-side child wait is bounded at 5s; leave headroom.
    let response = match tokio::time::timeout(Duration::from_secs(10), request).await {
        Ok(Ok(response)) => response,
        Ok(Err(e)) => return Err(format!("request failed: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }
    let drained: chan_server::devserver_api::DrainedTerminals = response
        .json()
        .await
        .map_err(|e| format!("parsing drain response: {e}"))?;
    eprintln!(
        "chan devserver: drained {} terminal session(s) ({} child process(es) confirmed dead)",
        drained.closed, drained.dead
    );
    if !drained.lingering.is_empty() {
        return Err(format!(
            "{} child process(es) still running: {:?}",
            drained.lingering.len(),
            drained.lingering
        ));
    }
    Ok(())
}

/// `chan devserver --service=systemd --stop`: stop the running unit AND disable
/// it, so it does not come back on the next login or boot. Sessions are drained
/// through the management API first (explicit kill, today's forcefulness for
/// HUP-immune children); the stop itself then releases the fd store, so even a
/// failed drain still ends every terminal a HUP can reach. Idempotent: stop is
/// a no-op when the unit is not active, and disable is skipped when no unit file
/// is installed. The unit file itself stays on disk (disable only drops the
/// `WantedBy` symlink), so `--status` can still show its last command.
/// The `--stop` drain decision: a failed drain WARNS and still stops -- the
/// released fd store closes every master and HUPs the shells, so stop is
/// never blocked on a wedged devserver. `drain` is None when nothing was
/// running or no address was discoverable.
async fn stop_unit_after_drain(
    drain: Option<std::result::Result<(), String>>,
    was_active: bool,
    control: &mut impl DevserverSystemdControl,
) -> Result<()> {
    if !was_active {
        return Ok(());
    }
    if let Some(Err(reason)) = drain {
        eprintln!(
            "chan devserver: WARNING: terminal drain failed ({reason}); \
             stopping anyway (the released fd store HUPs the shells)"
        );
    }
    control.command(&["stop", DEVSERVER_SYSTEMD_UNIT]).await
}

async fn stop_devserver_under_systemd() -> Result<()> {
    let was_active = unit_is_active().await;
    let drain = match (was_active, running_systemd_devserver_addr()) {
        (true, Some(dial)) => Some(drain_devserver_terminals(dial).await),
        _ => None,
    };
    stop_unit_after_drain(drain, was_active, &mut LiveDevserverSystemdControl).await?;
    // Disable only when a unit is installed, so a stop with nothing there does
    // not surface a spurious "No such file" from systemctl.
    if read_systemd_unit().is_some() {
        systemctl_user(&["disable", DEVSERVER_SYSTEMD_UNIT]).await?;
    }
    if was_active {
        eprintln!(
            "chan devserver: stopped and disabled the systemd user service {DEVSERVER_SYSTEMD_UNIT}."
        );
    } else {
        eprintln!(
            "chan devserver: the systemd user service {DEVSERVER_SYSTEMD_UNIT} is not running (disabled)."
        );
    }
    Ok(())
}

/// `chan devserver --rotate-token`: re-mint the devserver bearer. Prefer
/// rotating THROUGH the running server's management API so the old bearer
/// stops authorizing immediately (the suspected-leak response); fall back
/// to rewriting the persisted config when nothing answers, which a
/// devserver still running elsewhere only picks up at its next restart.
/// Either way the new `CHAN_DEVSERVER_TOKEN=` marker and `/?t=` URL are
/// printed: the marker is the scrapers' distribution channel, and a
/// rotation that does not re-emit it strands them on a dead token.
async fn cmd_rotate_devserver_token() -> Result<()> {
    let Some(current) = chan_server::persisted_devserver_token() else {
        anyhow::bail!(
            "chan devserver --rotate-token: no devserver config with a token \
             found (~/.chan/devserver/config.json); start a devserver first"
        );
    };
    let dial = running_systemd_devserver_addr().or_else(|| {
        chan_server::persisted_devserver_port()
            .map(|port| SocketAddr::new(DEFAULT_DEVSERVER_BIND, port))
    });
    if let Some(addr) = dial {
        let url = format!("http://{addr}/api/devserver/rotate-token");
        let client = reqwest::Client::new();
        let request = client.post(&url).bearer_auth(&current).send();
        match tokio::time::timeout(Duration::from_secs(5), request).await {
            Ok(Ok(response)) if response.status().is_success() => {
                let rotated: chan_server::devserver_api::RotatedToken = response
                    .json()
                    .await
                    .context("parsing the rotate-token response")?;
                eprintln!("chan devserver: token rotated; the old bearer no longer authorizes");
                print!("{}", rotated_token_output(Some(addr), &rotated.token));
                return Ok(());
            }
            Ok(Ok(response)) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                anyhow::bail!(
                    "chan devserver --rotate-token: the running devserver rejected the \
                     persisted token (401): its in-memory token and \
                     ~/.chan/devserver/config.json disagree. Restart the devserver, \
                     then rotate again."
                );
            }
            Ok(Ok(response)) => {
                anyhow::bail!(
                    "chan devserver --rotate-token: the running devserver answered HTTP {}",
                    response.status()
                );
            }
            // Nothing listening (or too slow): rotate the file instead.
            Ok(Err(_)) | Err(_) => {}
        }
    }
    match chan_server::rotate_persisted_devserver_token()
        .context("rewriting ~/.chan/devserver/config.json")?
    {
        Some(token) => {
            eprintln!(
                "chan devserver: NOTE: no running devserver answered; rotated the \
                 persisted token only -- a devserver still running elsewhere keeps \
                 accepting its old token until it restarts"
            );
            print!("{}", rotated_token_output(dial, &token));
            Ok(())
        }
        None => anyhow::bail!(
            "chan devserver --rotate-token: no devserver config with a token \
             found (~/.chan/devserver/config.json); start a devserver first"
        ),
    }
}

/// The stdout block a rotation prints: the `/?t=` URL (when the serve
/// address is known) and the LOCKED `CHAN_DEVSERVER_TOKEN=` marker line
/// the desktop control terminal re-scrapes on every connect.
fn rotated_token_output(addr: Option<SocketAddr>, token: &str) -> String {
    let mut out = String::new();
    if let Some(addr) = addr {
        out.push_str(&format!(
            "chan devserver: listening on http://{addr}/?t={token}\n"
        ));
    }
    out.push_str(&format!("{}{token}\n", chan_server::DEVSERVER_TOKEN_MARKER));
    out
}

/// How long the supervisor waits for the service's bearer token to land in the
/// persisted config before giving up. A fresh `Type=simple` unit reports active
/// before its first persist, so a brief poll covers that race; every later start
/// finds the token on the first read.
const DEVSERVER_TOKEN_WAIT: Duration = Duration::from_secs(5);

/// Resolve the persisted devserver bearer token, polling `read` until it yields
/// a token or `timeout` elapses. Injecting the reader keeps the poll/timeout
/// contract testable without a real config on disk.
async fn resolve_devserver_token(
    read: impl Fn() -> Option<String>,
    timeout: Duration,
) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(token) = read() {
            return Some(token);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Print the locked `CHAN_DEVSERVER_TOKEN=` marker to stdout -- the same contract
/// the foreground server emits -- directly from the supervisor, read from the
/// persisted 0600 config. Token delivery must not depend on this user being able
/// to read the unit journal (a uid below `SYS_UID_MAX`, or a user outside the
/// `systemd-journal`/`adm` groups, cannot): the desktop control terminal scrapes
/// this marker to reconnect, and the journal follow is only human-facing log
/// streaming. A duplicate marker re-surfaced by the journal on readable hosts is
/// harmless -- the scraper takes the last one.
///
/// Errors when the token never lands within `timeout`. The point of
/// `--service=systemd` supervision is to hand a client a token to reconnect
/// with; a unit that is
/// active but whose token cannot be surfaced is unreachable, so fail loud rather
/// than babysit it. The unit stays running, so a later re-attach can recover it.
async fn emit_devserver_token_marker(timeout: Duration) -> Result<()> {
    match resolve_devserver_token(chan_server::persisted_devserver_token, timeout).await {
        Some(token) => {
            println!("{}{token}", chan_server::DEVSERVER_TOKEN_MARKER);
            Ok(())
        }
        None => anyhow::bail!(
            "chan devserver: the supervised service is active but its bearer \
             token could not be read from ~/.chan/devserver/config.json; the \
             control terminal cannot authenticate to it"
        ),
    }
}

/// Ensure lingering is enabled so the user service survives logout. Fails
/// loudly with a manual hint when it cannot be ensured.
async fn ensure_systemd_linger() -> Result<()> {
    let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
    // Already lingering? Then it is ensured. `loginctl enable-linger` does a
    // polkit check on every call that a non-root user without an interactive
    // authority is denied EVEN when linger is already on, so only call it
    // when linger is actually off.
    if let Some(user) = user.as_deref() {
        if user_linger_enabled(user).await {
            return Ok(());
        }
    }
    let mut args: Vec<&str> = vec!["enable-linger"];
    if let Some(user) = user.as_deref() {
        args.push(user);
    }
    let output = run_tool("loginctl", &args).await?;
    if !output.status.success() {
        anyhow::bail!(
            "chan devserver --service=systemd: linger is off (so the service would not \
             survive logout) and `loginctl enable-linger` was denied:\n{}\n\
             enable it once, as root: sudo loginctl enable-linger {}",
            String::from_utf8_lossy(&output.stderr).trim(),
            user.as_deref().unwrap_or("$USER"),
        );
    }
    Ok(())
}

/// Whether `loginctl` reports `Linger=yes` for `user`.
async fn user_linger_enabled(user: &str) -> bool {
    matches!(
        run_tool("loginctl", &["show-user", user, "-p", "Linger"]).await,
        Ok(output) if String::from_utf8_lossy(&output.stdout).trim() == "Linger=yes"
    )
}

/// The `chan` CLI entry points a supervisor may name, as found on disk.
/// Populated by [`discover_relaunch_candidates`] and consumed by the pure
/// [`select_relaunchable_exe`].
#[derive(Debug, Default)]
struct RelaunchCandidates {
    /// `current_exe()`, when the OS reports one. On Linux this is the SYMLINK
    /// TARGET (`/proc/self/exe`), which is why a distro `chan -> chan-desktop`
    /// install lands here as the desktop binary.
    current_exe: Option<PathBuf>,
    /// This process runs from a chan AppImage, so every path under its mount is
    /// ephemeral.
    in_chan_appimage: bool,
    /// An existing `chan` next to `current_exe` (the distro package layout).
    sibling_chan: Option<PathBuf>,
    /// The existing local `bin/chan` shim (the macOS / AppImage layout).
    local_chan: Option<PathBuf>,
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
fn select_relaunchable_exe(candidates: &RelaunchCandidates) -> Result<PathBuf> {
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
fn resolve_relaunchable_exe() -> Result<PathBuf> {
    select_relaunchable_exe(&discover_relaunch_candidates())
}

/// Write `~/.config/systemd/user/chan-devserver.service` whose `ExecStart` runs
/// the resolved `chan` CLI's foreground devserver on `addr`. Returns the unit
/// path.
fn write_devserver_unit(
    addr: SocketAddr,
    tunnel: Option<SystemdTunnel>,
) -> Result<DevserverUnitUpdate> {
    let exe = resolve_relaunchable_exe()?;
    let dir = systemd_user_unit_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let unit_path = dir.join(DEVSERVER_SYSTEMD_UNIT);
    let unit = devserver_systemd_unit_spec(
        &exe,
        addr,
        devserver_chan_home().as_deref(),
        tunnel.as_ref(),
    );
    write_rendered_devserver_unit(&unit_path, &unit, tunnel.is_some())
}

#[derive(Debug)]
struct DevserverUnitUpdate {
    path: PathBuf,
    previous: Option<String>,
    previous_permissions: Option<std::fs::Permissions>,
    changed: bool,
}

impl DevserverUnitUpdate {
    fn rollback_file(&self) -> Result<()> {
        match &self.previous {
            Some(previous) => {
                std::fs::write(&self.path, previous)
                    .with_context(|| format!("restoring {}", self.path.display()))?;
                if let Some(permissions) = &self.previous_permissions {
                    std::fs::set_permissions(&self.path, permissions.clone()).with_context(
                        || format!("restoring permissions on {}", self.path.display()),
                    )?;
                }
            }
            None => match std::fs::remove_file(&self.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("removing {}", self.path.display()));
                }
            },
        }
        Ok(())
    }
}

fn write_rendered_devserver_unit(
    unit_path: &Path,
    unit: &chan_systemd::DevserverUnit,
    contains_secret: bool,
) -> Result<DevserverUnitUpdate> {
    let (previous, previous_permissions) = match std::fs::read_to_string(unit_path) {
        Ok(previous) => {
            let permissions = std::fs::metadata(unit_path)
                .with_context(|| format!("reading metadata for {}", unit_path.display()))?
                .permissions();
            (Some(previous), Some(permissions))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspecting installed unit {}", unit_path.display()));
        }
    };
    if let Some(previous) = &previous {
        match unit.classify_installed(previous) {
            chan_systemd::DevserverUnitClass::Current => {
                return Ok(DevserverUnitUpdate {
                    path: unit_path.to_path_buf(),
                    previous: None,
                    previous_permissions: None,
                    changed: false,
                });
            }
            chan_systemd::DevserverUnitClass::Foreign => {
                anyhow::bail!(
                    "refusing to overwrite foreign or administrator-edited systemd unit at {}; \
                     move or remove it, then retry",
                    unit_path.display()
                );
            }
            chan_systemd::DevserverUnitClass::KnownLegacy => {}
        }
    }
    let update = DevserverUnitUpdate {
        path: unit_path.to_path_buf(),
        previous,
        previous_permissions,
        changed: true,
    };
    let rendered = unit.render();
    let stage = (|| -> Result<()> {
        std::fs::write(unit_path, &rendered)
            .with_context(|| format!("writing {}", unit_path.display()))?;
        // The tunnel unit embeds the PAT via Environment=; keep it owner-only.
        // The 0644 default is exactly why launchd tunnel mode is still refused.
        if contains_secret {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(unit_path, std::fs::Permissions::from_mode(0o600))
                    .with_context(|| format!("setting 0600 on {}", unit_path.display()))?;
            }
        }
        Ok(())
    })();
    if let Err(error) = stage {
        if let Err(rollback_error) = update.rollback_file() {
            anyhow::bail!(
                "{error:#}; restoring the unit after the failed write also failed: \
                 {rollback_error:#}"
            );
        }
        return Err(error);
    }
    Ok(update)
}

/// The `CHAN_HOME` override to bake into a supervised service's environment, if
/// set to a non-empty value. systemd/launchd start the service with a fresh
/// environment (not the supervisor's), so a devserver launched under `CHAN_HOME`
/// must carry it into the unit/plist, otherwise the service falls back to the
/// real `~/.chan` while the supervisor reads the isolated config, splitting the
/// token handshake. Mirrors how the log path already resolves through `CHAN_HOME`.
fn devserver_chan_home() -> Option<String> {
    std::env::var("CHAN_HOME").ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
fn devserver_systemd_unit(
    exe: &Path,
    addr: SocketAddr,
    chan_home: Option<&str>,
    tunnel: Option<&SystemdTunnel>,
) -> String {
    devserver_systemd_unit_spec(exe, addr, chan_home, tunnel).render()
}

fn devserver_systemd_unit_spec(
    exe: &Path,
    addr: SocketAddr,
    chan_home: Option<&str>,
    tunnel: Option<&SystemdTunnel>,
) -> chan_systemd::DevserverUnit {
    // A CHAN_HOME-scoped supervisor passes it to the service, else the unit runs
    // against the real ~/.chan. Quoted so a path with spaces survives.
    let mut environment = Vec::new();
    if let Some(home) = chan_home {
        environment.push(format!("CHAN_HOME={home}"));
    }
    // Tunnel mode: carry the PAT in the unit (written 0600) and dial the gateway
    // via --tunnel-url. Under systemd the devserver still binds the loopback
    // management API (see resolve_devserver_listen) so `--stop` / `--restart
    // --force` can drain the terminals. Only PINNED (explicit or preserved-explicit) address
    // flags ride in the ExecStart; an omitted field leaves the service to
    // resolve its tunnel-mode default (loopback bind, OS-assigned port), and
    // the assigned port is never written back here -- persisting it would pin
    // it as if the user chose it.
    let exec = match tunnel {
        Some(tunnel) => {
            environment.push(format!("CHAN_TUNNEL_TOKEN={}", tunnel.token));
            // The endpoint rides the environment as well as the ExecStart flag.
            // The flag is what THIS service dials; the variable is what the
            // terminals it spawns inherit, so a `chan devserver --restart` typed
            // inside the workspace resolves the same gateway the unit already
            // uses instead of refusing for want of an endpoint. Both are
            // written from one resolved value, so they cannot disagree.
            environment.push(format!(
                "CHAN_TUNNEL_URL={}",
                tunnel.url.replace(['"', '\\'], "").replace('%', "%%")
            ));
            // Pinned only when the user chose a name (explicit or
            // preserved-explicit); omitted, the service resolves its
            // hostname default at runtime. Quotes and backslashes are
            // stripped: systemd's Environment= quoting cannot carry
            // them raw, and a display name has no business containing
            // either. `%` is escaped as `%%` so systemd's specifier
            // expansion hands the service the literal name
            // ([`persisted_tunnel_name`] undoes it on read-back).
            if let Some(name) = &tunnel.pinned_name {
                environment.push(format!(
                    "CHAN_TUNNEL_DEVSERVER_NAME={}",
                    name.replace(['"', '\\'], "").replace('%', "%%")
                ));
            }
            let mut exec = format!("{exe} devserver", exe = exe.display());
            if let Some(ip) = tunnel.pinned_bind {
                exec.push_str(&format!(" --bind={ip}"));
            }
            if let Some(port) = tunnel.pinned_port {
                exec.push_str(&format!(" --port={port}"));
            }
            exec.push_str(&format!(" --tunnel-url={}", tunnel.url));
            exec
        }
        None => format!(
            "{exe} devserver --bind={ip} --port={port}",
            exe = exe.display(),
            ip = addr.ip(),
            port = addr.port(),
        ),
    };
    environment.into_iter().fold(
        chan_systemd::DevserverUnit::new(exec),
        |unit, assignment| unit.with_environment(assignment),
    )
}

/// `$XDG_CONFIG_HOME/systemd/user`, else `$HOME/.config/systemd/user`.
fn systemd_user_unit_dir() -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(xdg).join("systemd").join("user"));
    }
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .context("no HOME for the systemd user unit directory")?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("systemd")
        .join("user"))
}

/// Poll until the unit is active, a failure is reported, or the deadline
/// passes. Tolerates the brief `activating` window after `enable --now`.
async fn wait_until_active(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if unit_is_active().await {
            return true;
        }
        if unit_is_failed().await || Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn unit_is_active() -> bool {
    matches!(
        run_tool("systemctl", &["--user", "is-active", DEVSERVER_SYSTEMD_UNIT]).await,
        Ok(output) if output.status.success()
    )
}

async fn unit_is_failed() -> bool {
    matches!(
        run_tool("systemctl", &["--user", "is-failed", DEVSERVER_SYSTEMD_UNIT]).await,
        Ok(output) if output.status.success()
    )
}

/// Run `systemctl --user <args>`, erroring with stderr on a non-zero exit.
async fn systemctl_user(args: &[&str]) -> Result<()> {
    let mut full: Vec<&str> = vec!["--user"];
    full.extend_from_slice(args);
    let output = run_tool("systemctl", &full).await?;
    if !output.status.success() {
        anyhow::bail!(
            "`systemctl --user {}` failed:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// The last lines of the unit's journal, for a failure message.
async fn recent_unit_journal() -> String {
    match run_tool(
        "journalctl",
        &[
            "--user",
            "-u",
            DEVSERVER_SYSTEMD_UNIT,
            "--no-pager",
            "-n",
            "30",
        ],
    )
    .await
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string(),
        Err(e) => format!("(could not read the journal: {e})"),
    }
}

/// Run a tool to completion, capturing its output. Errors only when the
/// tool cannot be spawned (e.g. missing binary), not on a non-zero exit.
async fn run_tool(program: &str, args: &[&str]) -> Result<std::process::Output> {
    tokio::process::Command::new(program)
        .args(args)
        .output()
        .await
        .with_context(|| format!("running `{program} {}`", args.join(" ")))
}

// ---------------------------------------------------------------------------
// macOS launchd backend -- mirrors the systemd backend above. The functions are
// always compiled (they only shell out to `launchctl`) and called only under
// `cfg!(target_os = "macos")`; the pure helpers stay unit-testable on any host.
// ---------------------------------------------------------------------------

/// The launchd LaunchAgent label for the devserver. Reverse-DNS off the app
/// bundle id (`app.chan.desktop`).
const DEVSERVER_LAUNCHD_LABEL: &str = "app.chan.devserver";

/// `chan devserver --service=launchd --start`: ensure the agent is up
/// (write/enable/bootstrap when it is not already running), then return. A
/// LaunchAgent in the `gui/<uid>` domain outlives the launching shell and the
/// GUI login session (it does NOT survive a full logout; that would need a root
/// LaunchDaemon). Idempotent: a no-op (beyond re-providing the token) when it is
/// already active.
async fn start_devserver_under_launchd(addr: SocketAddr) -> Result<()> {
    let uid = current_uid().await?;
    if launchd_is_active(uid).await {
        emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
        eprintln!(
            "chan devserver: the launchd agent {DEVSERVER_LAUNCHD_LABEL} is already running."
        );
        return Ok(());
    }
    bootstrap_launch_agent(uid, addr).await?;
    eprintln!("chan devserver: started the launchd agent {DEVSERVER_LAUNCHD_LABEL} (bind={addr}).");
    Ok(())
}

/// `chan devserver --service=launchd --join`: ensure the agent is running (start
/// it if down, re-attach if up), then stay attached and follow its log until
/// Ctrl-C. Unlike `--start` it does not return until the agent stops or the user
/// detaches.
async fn join_devserver_under_launchd(addr: SocketAddr) -> Result<()> {
    let uid = current_uid().await?;

    if launchd_is_active(uid).await {
        // Re-attaching to a running agent. Its stdout (with the token marker)
        // goes to the log file, not this terminal, so the supervisor re-provides
        // the token contract itself (see emit_devserver_token_marker).
        emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
        eprintln!(
            "chan devserver: re-attaching to the running launchd agent \
             {DEVSERVER_LAUNCHD_LABEL}"
        );
    } else {
        bootstrap_launch_agent(uid, addr).await?;
        eprintln!(
            "chan devserver: started the launchd agent {DEVSERVER_LAUNCHD_LABEL} \
             (bind={addr})"
        );
    }

    run_health_watchdog(
        &addr.to_string(),
        DaemonLiveness::Launchd { uid },
        &format!("launchd agent {DEVSERVER_LAUNCHD_LABEL}"),
    )
    .await
}

/// (Re)register and start the launchd agent for `addr`: rewrite the plist
/// (current binary + `addr`), bootout any stale registration, enable, bootstrap,
/// and wait until active. Always re-registers, so it doubles as the `--restart`
/// reload (a `kickstart -k` alone would bounce the OLD plist). Surfaces the
/// bearer token. Shared by the first-start path and
/// [`restart_devserver_under_launchd`]; the caller owns the started/restarted
/// log line + watching the agent.
async fn bootstrap_launch_agent(uid: u32, addr: SocketAddr) -> Result<()> {
    let service = launchd_service_target(uid);
    let plist = write_devserver_launch_agent(addr)?;
    eprintln!("chan devserver: wrote {}", plist.display());
    // Clear any stale (loaded-but-dead, or running) registration so the freshly
    // written plist takes effect; best-effort, it errors when nothing is loaded.
    let _ = run_tool("launchctl", &["bootout", service.as_str()]).await;
    launchctl(&["enable", service.as_str()]).await?;
    let plist_arg = plist.to_string_lossy();
    launchctl(&["bootstrap", &launchd_domain_target(uid), plist_arg.as_ref()]).await?;
    if !wait_until_launchd_active(uid, Duration::from_secs(10)).await {
        anyhow::bail!(
            "chan devserver: the launchd agent {DEVSERVER_LAUNCHD_LABEL} \
             failed to start:\n{}",
            recent_launchd_log().await
        );
    }
    // Same direct-emit contract as the systemd path: the service logs its
    // own marker to the log file, invisible to this terminal, so surface it
    // from the persisted config and fail loud if it never lands.
    emit_devserver_token_marker(DEVSERVER_TOKEN_WAIT).await?;
    Ok(())
}

/// `chan devserver --service=launchd --restart`: rewrite + re-register the agent
/// (current binary + `addr`) so it bounces (or starts if stopped), then return.
/// Use `--join` to stay attached.
async fn restart_devserver_under_launchd(addr: SocketAddr) -> Result<()> {
    let uid = current_uid().await?;
    let was_running = launchd_is_active(uid).await;
    bootstrap_launch_agent(uid, addr).await?;
    eprintln!(
        "chan devserver: {} the launchd agent {DEVSERVER_LAUNCHD_LABEL} (bind={addr})",
        if was_running { "restarted" } else { "started" }
    );
    Ok(())
}

/// `chan devserver --service=launchd --stop`: bootout the agent AND disable it,
/// so launchd does not re-bootstrap it at the next GUI login. Idempotent:
/// `bootout` errors when nothing is loaded, which we report as already-stopped;
/// `disable` is best-effort. The plist stays on disk, so `--status` can still
/// show its last command; `--start`/`--restart` re-enable it.
async fn stop_devserver_under_launchd() -> Result<()> {
    let uid = current_uid().await?;
    let service = launchd_service_target(uid);
    let output = run_tool("launchctl", &["bootout", service.as_str()]).await?;
    // Persist the disable so RunAtLoad does not relaunch it at login. Best-effort:
    // a no-op when it was never enabled, and it must not fail the stop.
    let _ = run_tool("launchctl", &["disable", service.as_str()]).await;
    if output.status.success() {
        eprintln!(
            "chan devserver: stopped and disabled the launchd agent {DEVSERVER_LAUNCHD_LABEL}."
        );
    } else {
        eprintln!(
            "chan devserver: the launchd agent {DEVSERVER_LAUNCHD_LABEL} is not running (disabled)."
        );
    }
    Ok(())
}

/// The current user's numeric uid for the `gui/<uid>` domain target. Shells out
/// to `id -u` rather than adding a libc dependency, mirroring the systemd
/// backend's `$USER` discovery.
async fn current_uid() -> Result<u32> {
    let output = run_tool("id", &["-u"]).await?;
    if !output.status.success() {
        anyhow::bail!(
            "`id -u` failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .context("parsing the current uid from `id -u`")
}

/// `gui/<uid>` -- the launchd domain target for the user's GUI login session.
fn launchd_domain_target(uid: u32) -> String {
    format!("gui/{uid}")
}

/// `gui/<uid>/<label>` -- the launchd service target for the devserver agent.
fn launchd_service_target(uid: u32) -> String {
    format!("gui/{uid}/{DEVSERVER_LAUNCHD_LABEL}")
}

/// The user's home directory from `$HOME`, for the macOS launchd paths. Mirrors
/// the `$HOME` resolution the systemd unit-dir helper uses (no `dirs` dep).
fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .context("no HOME for the launchd agent paths")
}

/// `~/Library/LaunchAgents/app.chan.devserver.plist`.
fn launch_agent_path() -> Result<PathBuf> {
    Ok(home_dir()?
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{DEVSERVER_LAUNCHD_LABEL}.plist")))
}

/// `~/.chan/devserver/devserver.log` -- where the agent's stdout/stderr land
/// (launchd has no journal). Co-located with the 0600 devserver config. Routed
/// through the single chan-home authority (`config_dir`) so `CHAN_HOME` moves it.
fn devserver_log_path() -> Result<PathBuf> {
    Ok(chan_workspace::paths::config_dir()
        .join("devserver")
        .join("devserver.log"))
}

/// Write the LaunchAgent plist whose `ProgramArguments` run the resolved `chan`
/// CLI's foreground devserver on `addr`. Returns the plist path.
fn write_devserver_launch_agent(addr: SocketAddr) -> Result<PathBuf> {
    let exe = resolve_relaunchable_exe()?;
    let log = devserver_log_path()?;
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let plist_path = launch_agent_path()?;
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let plist = devserver_launch_agent_plist(&exe, addr, &log, devserver_chan_home().as_deref());
    std::fs::write(&plist_path, plist)
        .with_context(|| format!("writing {}", plist_path.display()))?;
    Ok(plist_path)
}

/// Build the LaunchAgent plist XML. `RunAtLoad` starts it on bootstrap;
/// `KeepAlive`/`SuccessfulExit=false` restarts it only on a crash (the launchd
/// analogue of systemd `Restart=on-failure`); stdout/stderr go to `log`.
fn devserver_launch_agent_plist(
    exe: &Path,
    addr: SocketAddr,
    log: &Path,
    chan_home: Option<&str>,
) -> String {
    // launchd starts the agent with a fresh environment, so a CHAN_HOME-scoped
    // supervisor bakes it into the plist; else the agent runs against ~/.chan.
    let environment = match chan_home {
        Some(home) => format!(
            "  <key>EnvironmentVariables</key>\n  \
             <dict>\n    <key>CHAN_HOME</key>\n    <string>{}</string>\n  </dict>\n",
            xml_escape(home)
        ),
        None => String::new(),
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>devserver</string>
    <string>--bind={ip}</string>
    <string>--port={port}</string>
  </array>
{environment}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        label = DEVSERVER_LAUNCHD_LABEL,
        exe = xml_escape(&exe.to_string_lossy()),
        ip = addr.ip(),
        port = addr.port(),
        log = xml_escape(&log.to_string_lossy()),
    )
}

/// Minimal XML text escaping for plist `<string>` values (paths).
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Run `launchctl <args>`, erroring with stderr on a non-zero exit. For the
/// must-succeed calls (`enable`, `bootstrap`); `bootout` runs best-effort.
async fn launchctl(args: &[&str]) -> Result<()> {
    let output = run_tool("launchctl", args).await?;
    if !output.status.success() {
        anyhow::bail!(
            "`launchctl {}` failed:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Whether the agent is loaded AND running.
async fn launchd_is_active(uid: u32) -> bool {
    let service = launchd_service_target(uid);
    matches!(
        run_tool("launchctl", &["print", service.as_str()]).await,
        Ok(output)
            if output.status.success()
                && launchd_print_running(&String::from_utf8_lossy(&output.stdout))
    )
}

/// Whether the agent is loaded, not running, and last exited non-zero.
async fn launchd_is_failed(uid: u32) -> bool {
    let service = launchd_service_target(uid);
    matches!(
        run_tool("launchctl", &["print", service.as_str()]).await,
        Ok(output)
            if output.status.success()
                && launchd_print_failed(&String::from_utf8_lossy(&output.stdout))
    )
}

/// Parse `launchctl print` output for a running service (`state = running`).
fn launchd_print_running(out: &str) -> bool {
    out.lines().any(|l| l.trim() == "state = running")
}

/// Parse `launchctl print` output for a failed service: not running with a
/// non-zero `last exit code`. `(never exited)` and `= 0` are not failures.
fn launchd_print_failed(out: &str) -> bool {
    let not_running = out.lines().any(|l| l.trim() == "state = not running");
    let bad_exit = out.lines().find_map(|l| {
        l.trim()
            .strip_prefix("last exit code = ")
            .and_then(|v| v.parse::<i32>().ok())
    });
    not_running && matches!(bad_exit, Some(code) if code != 0)
}

/// Poll until the agent is active, a failure is reported, or the deadline
/// passes. Tolerates the brief window between bootstrap and first run.
async fn wait_until_launchd_active(uid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if launchd_is_active(uid).await {
            return true;
        }
        if launchd_is_failed(uid).await || Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// The last lines of the agent's log file, for a failure message.
async fn recent_launchd_log() -> String {
    let path = match devserver_log_path() {
        Ok(p) => p,
        Err(e) => return format!("(could not resolve the log path: {e})"),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let mut tail: Vec<&str> = text.lines().rev().take(30).collect();
            tail.reverse();
            tail.join("\n")
        }
        Err(e) => format!("(could not read {}: {e})", path.display()),
    }
}

/// Integrate a Desktop-personality `chan open` with the desktop app.
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
async fn maybe_handoff_to_desktop(
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

/// Launch the desktop GUI for a `chan open` that found no running desktop,
/// then hand it the workspace. Unix-only (the desktop + handoff socket are
/// unix); off unix there's no GUI to launch, so fall back to standalone.
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
                "timed out waiting for chan-desktop to start; run `chan open` again \
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
#[cfg(unix)]
async fn cmd_upgrade_desktop(check_only: bool, version_override: Option<String>) -> Result<()> {
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
#[cfg(unix)]
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
            // check_only=false never returns Checked, but be exhaustive.
            UpgradeOutcome::Checked { .. } => return Ok(()),
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

#[cfg(not(unix))]
async fn cmd_upgrade_desktop(_check_only: bool, _version_override: Option<String>) -> Result<()> {
    anyhow::bail!("desktop `chan upgrade` is only supported on unix")
}

/// Dispatch the `chan workspace reports {enable,disable}`
/// subcommands. Parallels `cmd_index_set_semantic`'s shape: open
/// the workspace (with the path-resolution fallback to the registry's
/// default), flip the per-workspace `reports_enabled` flag, surface
/// the verb on stdout. `disable` is destructive -- drops the
/// persisted `report.jsonl` so re-enable triggers a fresh scan;
/// gated on `--yes` or an interactive prompt (explicit
/// confirmation for a destructive action).
fn cmd_reports(action: ReportsAction) -> Result<()> {
    match action {
        ReportsAction::Enable { path } => cmd_reports_set(path, true, false),
        ReportsAction::Disable { path, yes } => cmd_reports_set(path, false, yes),
    }
}

fn cmd_reports_set(path: Option<PathBuf>, enabled: bool, skip_confirm: bool) -> Result<()> {
    let lib = library()?;
    let root = path.ok_or_else(|| {
        let (cmd, hint) = if enabled {
            ("reports enable", "chan workspace reports enable --path .")
        } else {
            ("reports disable", "chan workspace reports disable --path .")
        };
        missing_workspace_path(cmd, hint)
    })?;
    let workspace = lib
        .open_workspace(&root)
        .with_context(|| format!("opening workspace at {}", root.display()))?;
    // Destructive-action confirmation for disable. The non-
    // interactive `-y` flag skips the prompt; an interactive TTY
    // without `-y` blocks until the user confirms.
    if !enabled && !skip_confirm {
        eprintln!(
            "About to disable chan-reports for workspace at {}",
            workspace.root().display(),
        );
        eprintln!(
            "This drops the persisted report.jsonl. Re-enabling later \
             triggers a fresh scan."
        );
        eprint!("Continue? [y/N] ");
        use std::io::Write;
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        let answer = line.trim().to_ascii_lowercase();
        if !(answer == "y" || answer == "yes") {
            eprintln!("Aborted.");
            return Ok(());
        }
    }
    workspace
        .set_reports_enabled(enabled)
        .context("persisting reports_enabled flag")?;
    if enabled {
        // Kick off the initial scan via `boot` so the flag flip
        // produces visible data without waiting for the next
        // `Workspace::report()` consumer.
        workspace.boot().context("BOOT after enabling reports")?;
    }
    let verb = if enabled { "enabled" } else { "disabled" };
    println!(
        "chan-reports {verb} for workspace at {}",
        workspace.root().display()
    );
    Ok(())
}

fn cmd_index(action: IndexAction) -> Result<()> {
    match action {
        IndexAction::Rebuild { path, path_flag } => {
            // Either form works. Both supplied → the
            // flag wins; users have to be explicit anyway and the
            // flag is the canonical shape going forward. Neither
            // supplied → clean error, not a clap-default panic.
            let resolved = path_flag.or(path).ok_or_else(|| {
                anyhow::anyhow!(
                    "`chan workspace index rebuild` requires a workspace path (positional or `--path`)"
                )
            })?;
            cmd_index_rebuild(resolved)
        }
        IndexAction::DownloadModel { model } => cmd_index_download_model(&model),
        IndexAction::ListModels { json } => cmd_index_list_models(json),
        IndexAction::SetModel { path, model } => cmd_index_set_model(path, &model),
        IndexAction::EnableSemantic { path } => cmd_index_set_semantic(path, true),
        IndexAction::DisableSemantic { path } => cmd_index_set_semantic(path, false),
        IndexAction::Status { path, json } => cmd_index_status(path, json),
    }
}

fn cmd_index_rebuild(path: PathBuf) -> Result<()> {
    let lib = library()?;
    // Idempotent: registering an already-known workspace only touches
    // last_seen_at. CLI users expect `chan workspace index rebuild /some/path`
    // to work without a prior `chan workspace add`.
    ensure_workspace_registered(&lib, &path)?;
    let workspace = lib.open_workspace(&path)?;

    // Live progress on stderr so the user can see the embed pass
    // is making progress; on a big workspace it can run for tens of
    // minutes. Use a TTY-friendly carriage return rewrite when
    // stderr is interactive; fall back to plain lines (one per
    // file) when redirected so logs stay readable.
    use std::io::{IsTerminal, Write};
    let tty = std::io::stderr().is_terminal();
    // chan-workspace 0.7 reshaped progress: a single `ProgressEvent` with
    // a `stage` enum (IndexFile / EmbedBatch / GraphRebuild / ...),
    // current/total counters, and an optional label. We surface the
    // two stages the reindex CLI cared about; everything else folds
    // into a generic "still working" line so nothing escapes the user
    // silently on large workspaces.
    let callback = chan_workspace::progress::progress_fn(move |p| {
        let line = match p.stage {
            chan_workspace::progress::ProgressStage::IndexFile => format!(
                "[{}/{}] {}",
                p.current.saturating_add(1),
                p.total,
                p.label.as_deref().unwrap_or("")
            ),
            chan_workspace::progress::ProgressStage::EmbedBatch => format!(
                "[{}/{}] embedding {} chunks...",
                p.current.saturating_add(1),
                p.total,
                p.current
            ),
            other => format!("{other:?} {}", p.label.as_deref().unwrap_or("")),
        };
        if tty {
            let mut err = std::io::stderr().lock();
            let _ = write!(err, "\r\x1b[2K{line}");
            let _ = err.flush();
        } else {
            eprintln!("{line}");
        }
    });
    let summary = workspace
        .reindex_with(None, callback.as_ref())
        .context("reindex")?;
    if tty {
        eprintln!();
    }

    println!(
        "indexed {}/{} files, {} chunks ({} errors)",
        summary.indexed,
        summary.files,
        summary.chunks,
        summary.errors.len(),
    );
    // Surface embed-phase resumption when it fired. Skipped on full
    // first-time builds (count is 0) so the success path stays terse.
    if summary.embeds_reused > 0 {
        println!(
            "reused {} embedding shard{} from prior run",
            summary.embeds_reused,
            if summary.embeds_reused == 1 { "" } else { "s" },
        );
    }
    for (path, e) in &summary.errors {
        eprintln!("  error: {path}: {e}");
    }
    Ok(())
}

fn cmd_index_list_models(json: bool) -> Result<()> {
    let models = chan_workspace::index::config::embedding_models();
    if json {
        println!("{}", serde_json::to_string_pretty(models)?);
    } else {
        for model in models {
            let marker = if model.is_default { "default" } else { "" };
            println!(
                "{:<28} {:<19} dim={:<4} {:<8} {:<7} {}",
                model.id, model.label, model.dim, model.size_label, marker, model.note
            );
        }
    }
    Ok(())
}

/// Stub when the binary is built without
/// `--features embeddings`. The candle + hf-hub stack is gated
/// behind that feature; without it there's nothing to download.
/// Bail with a clear message instead of a missing-symbol error.
#[cfg(not(feature = "embeddings"))]
fn cmd_index_download_model(_model: &str) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

#[cfg(not(feature = "embeddings"))]
fn cmd_index_set_semantic(_path: Option<PathBuf>, _enabled: bool) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

#[cfg(not(feature = "embeddings"))]
fn cmd_index_set_model(_path: Option<PathBuf>, _model: &str) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

#[cfg(not(feature = "embeddings"))]
fn cmd_index_status(_path: Option<PathBuf>, _json: bool) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

/// Download the embedding model into the per-machine
/// cache. Blocking; the hf-hub backend prints its own progress to
/// stderr when stderr is a TTY. Idempotent -- if the model is
/// already laid out in the cache the call returns immediately.
#[cfg(feature = "embeddings")]
fn cmd_index_download_model(model: &str) -> Result<()> {
    use chan_workspace::index::embeddings::{
        global_models_dir, repo_dir_name, resolve_model, Embedder,
    };
    if chan_workspace::index::config::embedding_model(model).is_none() {
        anyhow::bail!(
            "unknown embedding model: {model} (run `chan workspace index list-models` to list supported models)"
        );
    }
    let cache_dir = global_models_dir();
    let expected_dir = cache_dir.join(repo_dir_name(model));
    if resolve_model(model).is_ok() {
        println!(
            "model {} already present at {}",
            model,
            expected_dir.display()
        );
        return Ok(());
    }
    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("create model cache {}", cache_dir.display()))?;
    eprintln!(
        "downloading {} into {} (this may take a few minutes)",
        model,
        cache_dir.display()
    );
    Embedder::open(model, &cache_dir).with_context(|| format!("download model {model}"))?;
    println!("downloaded {} into {}", model, expected_dir.display());
    Ok(())
}

#[cfg(feature = "embeddings")]
fn cmd_index_set_model(path: Option<PathBuf>, model: &str) -> Result<()> {
    if chan_workspace::index::config::embedding_model(model).is_none() {
        anyhow::bail!(
            "unknown embedding model: {model} (run `chan workspace index list-models` to list supported models)"
        );
    }
    let lib = library()?;
    let root = path.ok_or_else(|| {
        missing_workspace_path(
            "index set-model",
            "chan workspace index set-model --path . --model BAAI/bge-small-en-v1.5",
        )
    })?;
    let workspace = lib
        .open_workspace(&root)
        .with_context(|| not_a_chan_workspace_hint(&root))?;
    workspace
        .set_semantic_model(model)
        .context("persisting semantic model")?;
    println!(
        "semantic model set to {model} for workspace at {}",
        workspace.root().display()
    );
    Ok(())
}

/// Flip the per-workspace Hybrid-search opt-in. On enable,
/// refuses if the model isn't downloaded; the user is pointed at
/// `chan workspace index download-model`. On disable, always succeeds (the
/// underlying `set_semantic_enabled` is idempotent).
///
/// Deliberately does NOT auto-register an unregistered path.
/// Refusing here surfaces a clean "not a chan workspace at <path>"
/// instead of a registration side-effect that leaks the
/// implementation detail.
#[cfg(feature = "embeddings")]
fn cmd_index_set_semantic(path: Option<PathBuf>, enabled: bool) -> Result<()> {
    use chan_workspace::index::embeddings::resolve_model;
    let lib = library()?;
    let root = path.ok_or_else(|| {
        let (cmd, hint) = if enabled {
            (
                "index enable-semantic",
                "chan workspace index enable-semantic --path .",
            )
        } else {
            (
                "index disable-semantic",
                "chan workspace index disable-semantic --path .",
            )
        };
        missing_workspace_path(cmd, hint)
    })?;
    let workspace = lib
        .open_workspace(&root)
        .with_context(|| not_a_chan_workspace_hint(&root))?;
    if enabled {
        let model = workspace
            .semantic_model()
            .context("reading workspace's model id")?;
        if let Err(err) = resolve_model(&model) {
            return Err(anyhow::anyhow!(
                "{err}\nrun `chan workspace index download-model` to fetch it"
            ));
        }
    }
    workspace
        .set_semantic_enabled(enabled)
        .context("persisting semantic_enabled flag")?;
    let verb = if enabled { "enabled" } else { "disabled" };
    println!(
        "semantic search {verb} for workspace at {}",
        workspace.root().display()
    );
    Ok(())
}

/// Print the per-workspace semantic-search state. Text by
/// default; `--json` emits a `{workspaces:[{...}]}`-style object for
/// scripting (single workspace in the response; the shape is plural so
/// a future multi-workspace variant lands as a pure extension).
///
/// Read-only access, lock-free + no auto-register.
/// Taking the writer lock via `Workspace::open` (and
/// auto-registering missing paths) would surface against a
/// live-served workspace as "workspace is locked by another
/// process", and against an
/// unregistered path leak "Error: registering <path>". So the
/// helper looks up the registered workspace's index dir directly and
/// loads `IndexConfig` from disk -- no Workspace handle, no flock, no
/// side-effects. Missing-from-registry → clean
/// "not a chan workspace at <path>".
#[cfg(feature = "embeddings")]
fn cmd_index_status(path: Option<PathBuf>, json: bool) -> Result<()> {
    use chan_workspace::index::embeddings::{global_models_dir, repo_dir_name, resolve_model};
    let lib = library()?;
    let root = path.ok_or_else(|| {
        missing_workspace_path("index status", "chan workspace index status --path .")
    })?;
    let workspace_paths = lib
        .workspace_paths_for(&root)
        .ok_or_else(|| anyhow::anyhow!(not_a_chan_workspace_hint(&root)))?;
    // Canonical path comes back from the registry entry; falls back
    // to the user-supplied root if the registry lookup somehow
    // races (impossible while we hold a Library handle, but the
    // ladder keeps the display correct without panicking).
    let canonical_root = lib
        .list_workspaces()
        .into_iter()
        .find(|d| same_path(&d.root_path, &root))
        .map(|d| d.root_path)
        .unwrap_or(root);
    let cfg = chan_workspace::index::config::load(&workspace_paths.index).with_context(|| {
        format!(
            "reading index config at {}",
            workspace_paths.index.display()
        )
    })?;
    // Report and semantic toggles live in the per-workspace dashboard config.
    let dashboard = chan_workspace::dashboard::load(&workspace_paths.root).with_context(|| {
        format!(
            "reading dashboard config at {}",
            workspace_paths.root.display()
        )
    })?;
    let model = cfg.model;
    let semantic_enabled = dashboard.semantic_enabled;
    let expected_dir = global_models_dir().join(repo_dir_name(&model));
    let model_present = resolve_model(&model).is_ok();
    let model_size_bytes = if model_present {
        Some(dir_total_size(&expected_dir))
    } else {
        None
    };
    let mode = if semantic_enabled && model_present {
        "hybrid"
    } else {
        "bm25"
    };
    if json {
        // Emit `reports_enabled` alongside `semantic_enabled` so a desktop
        // caller reads both flags from one CLI round-trip. Both come from the
        // per-workspace dashboard config; this is a strict additive extension
        // (existing JSON consumers ignore unknown fields).
        let body = serde_json::json!({
            "workspace": canonical_root.display().to_string(),
            "mode": mode,
            "model_present": model_present,
            "model_name": model,
            "model_path": expected_dir.display().to_string(),
            "model_size_bytes": model_size_bytes,
            "semantic_enabled": semantic_enabled,
            "reports_enabled": dashboard.reports_enabled,
        });
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        println!("workspace:            {}", canonical_root.display());
        println!("mode:             {mode}");
        println!("model:            {model}");
        println!("model path:       {}", expected_dir.display());
        println!(
            "model present:    {}",
            if model_present {
                "yes"
            } else {
                "no (run `chan workspace index download-model`)"
            }
        );
        if let Some(bytes) = model_size_bytes {
            println!("model size:       {}", humanize_bytes(bytes));
        }
        println!(
            "semantic enabled: {}",
            if semantic_enabled { "yes" } else { "no" }
        );
    }
    Ok(())
}

/// User-facing message when a CLI subcommand is
/// pointed at a path the registry doesn't know. Surfaces a clear
/// "not a chan workspace at <path>" hint with a `chan workspace add` next-step
/// instead of leaking the implementation detail (auto-register
/// side-effect, `WorkspaceNotRegistered(<path>)`, etc.).
///
/// Gated on `embeddings` to match both
/// call sites (`cmd_index_set_semantic`, `cmd_index_status`).
/// Without the gate `--no-default-features` builds with
/// `RUSTFLAGS=-D warnings` fail on dead_code.
#[cfg(feature = "embeddings")]
fn not_a_chan_workspace_hint(root: &std::path::Path) -> String {
    format!(
        "not a chan workspace at {}; run `chan workspace add {}` first",
        root.display(),
        root.display()
    )
}

/// Recursive size of every regular file under `dir`. Mirrors the
/// helper in `chan-server::routes::index` so the CLI status output
/// agrees with the API's `model_size_bytes` field.
#[cfg(feature = "embeddings")]
fn dir_total_size(dir: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, total: &mut u64) {
        let Ok(it) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in it.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                walk(&entry.path(), total);
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    *total += meta.len();
                }
            }
        }
    }
    let mut total = 0;
    walk(dir, &mut total);
    total
}

#[cfg(feature = "embeddings")]
fn humanize_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Run chan-llm's MCP server on stdio against `path`. Spawned by
/// external MCP clients through config files; not user-facing.
///
/// We deliberately do NOT auto-register the workspace here: the host
/// (chan-server) has already registered the workspace for
/// this workspace when the session started, and the MCP subprocess
/// inherits that registry. If the workspace isn't registered when the
/// agent invokes the subcommand, that's a wiring bug worth
/// surfacing rather than silently fixing.
async fn cmd_mcp(path: PathBuf) -> Result<()> {
    let workspace = library()?
        .open_workspace(&path)
        .with_context(|| format!("opening workspace {}", path.display()))?;
    chan_llm::mcp::Server::new(workspace)
        .serve_stdio()
        .await
        .context("running MCP server")
}

/// Bridge between the agent subprocess and the MCP server hosted in
/// chan-server. Connects to the server's MCP transport (a Unix-domain
/// socket on unix, a named pipe on Windows) and pipes stdin -> socket and
/// socket -> stdout concurrently. Returns when either direction closes,
/// which is the normal end of a session.
async fn cmd_mcp_proxy(socket: PathBuf) -> Result<()> {
    chan_server::run_mcp_stdio_proxy(socket)
        .await
        .context("running MCP proxy")
}

#[derive(Debug, Serialize)]
pub struct MultiWorkspaceSearchOutput {
    pub results: Vec<WorkspaceSearchResult>,
    pub errors: Vec<WorkspaceExecutionError>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceExecutionError {
    pub workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_key: Option<String>,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug)]
struct WorkspaceExecutionFailure {
    code: &'static str,
    message: String,
}

async fn cmd_workspace_search(
    request: WorkspaceSearchRequest,
    targets: WorkspaceTargets,
    json: bool,
    pretty: bool,
) -> Result<()> {
    let lib = library()?;
    let (selected, mut errors) = select_workspace_targets(&lib, &targets)?;
    let mut results = Vec::new();
    for workspace in selected {
        match execute_workspace_search(&lib, &workspace, &request).await {
            Ok(result) => results.push(result),
            Err(error) => errors.push(WorkspaceExecutionError {
                workspace: workspace.root_path.display().to_string(),
                metadata_key: Some(workspace.metadata_key.clone()),
                code: error.code,
                message: error.message,
            }),
        }
    }
    let output = MultiWorkspaceSearchOutput { results, errors };
    if json {
        if pretty {
            println!("{}", serde_json::to_string_pretty(&output)?);
        } else {
            println!("{}", serde_json::to_string(&output)?);
        }
    } else {
        for result in &output.results {
            println!(
                "# {} ({})\n",
                result.workspace.display_name, result.workspace.root
            );
            print!("{}", chan_shell::render_workspace_search_markdown(result));
        }
        if !output.errors.is_empty() {
            println!("# Workspace errors\n");
            for error in &output.errors {
                println!("- {}: {}", error.workspace, error.message);
            }
        }
    }
    anyhow::ensure!(
        output.errors.is_empty() && output.results.iter().all(|result| result.errors.is_empty()),
        "workspace search completed with errors"
    );
    Ok(())
}

fn select_workspace_targets(
    lib: &Library,
    targets: &WorkspaceTargets,
) -> Result<(Vec<KnownWorkspace>, Vec<WorkspaceExecutionError>)> {
    let mut known = lib.list_workspaces();
    if targets.all_workspaces {
        known.sort_by(|left, right| left.root_path.cmp(&right.root_path));
        return Ok((known, Vec::new()));
    }
    if targets.workspaces.is_empty() {
        let cwd = std::fs::canonicalize(std::env::current_dir()?)?;
        let selected = known
            .into_iter()
            .filter(|workspace| cwd.starts_with(&workspace.root_path))
            .max_by_key(|workspace| workspace.root_path.components().count());
        return match selected {
            Some(workspace) => Ok((vec![workspace], Vec::new())),
            None => Ok((
                Vec::new(),
                vec![WorkspaceExecutionError {
                    workspace: cwd.display().to_string(),
                    metadata_key: None,
                    code: "workspace_not_found",
                    message: "current directory is not inside a registered workspace".into(),
                }],
            )),
        };
    }

    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut errors = Vec::new();
    for selector in &targets.workspaces {
        match resolve_workspace_selector(&known, selector) {
            Ok(workspace) => {
                if seen.insert(workspace.metadata_key.clone()) {
                    selected.push(workspace.clone());
                }
            }
            Err(error) => errors.push(error),
        }
    }
    Ok((selected, errors))
}

fn resolve_workspace_selector<'a>(
    known: &'a [KnownWorkspace],
    selector: &str,
) -> std::result::Result<&'a KnownWorkspace, WorkspaceExecutionError> {
    let selector_path = PathBuf::from(selector);
    let canonical = std::fs::canonicalize(&selector_path).ok();
    if let Some(workspace) = known.iter().find(|workspace| {
        workspace.root_path == selector_path
            || canonical
                .as_ref()
                .is_some_and(|path| path == &workspace.root_path)
            || workspace.root_path.to_string_lossy() == selector
    }) {
        return Ok(workspace);
    }
    if let Some(workspace) = known
        .iter()
        .find(|workspace| workspace.metadata_key == selector)
    {
        return Ok(workspace);
    }
    let display_matches: Vec<&KnownWorkspace> = known
        .iter()
        .filter(|workspace| known_workspace_display_name(workspace).eq_ignore_ascii_case(selector))
        .collect();
    match display_matches.as_slice() {
        [workspace] => Ok(workspace),
        [] => Err(WorkspaceExecutionError {
            workspace: selector.to_string(),
            metadata_key: None,
            code: "workspace_not_found",
            message: format!("no registered workspace matches {selector:?}"),
        }),
        matches => Err(WorkspaceExecutionError {
            workspace: selector.to_string(),
            metadata_key: None,
            code: "ambiguous_workspace",
            message: format!(
                "workspace display name {selector:?} is ambiguous: {}",
                matches
                    .iter()
                    .map(|workspace| format!(
                        "{} ({})",
                        workspace.root_path.display(),
                        workspace.metadata_key
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }),
    }
}

fn known_workspace_display_name(workspace: &KnownWorkspace) -> String {
    workspace.display_name.clone().unwrap_or_else(|| {
        workspace
            .root_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.root_path.display().to_string())
    })
}

async fn execute_workspace_search(
    lib: &Library,
    known: &KnownWorkspace,
    request: &WorkspaceSearchRequest,
) -> std::result::Result<WorkspaceSearchResult, WorkspaceExecutionFailure> {
    execute_workspace_search_with_dirs(lib, known, request, None).await
}

async fn execute_workspace_search_with_dirs(
    lib: &Library,
    known: &KnownWorkspace,
    request: &WorkspaceSearchRequest,
    socket_dirs: Option<&[PathBuf]>,
) -> std::result::Result<WorkspaceSearchResult, WorkspaceExecutionFailure> {
    let paths =
        lib.workspace_paths_for(&known.root_path)
            .ok_or_else(|| WorkspaceExecutionFailure {
                code: "workspace_open_failed",
                message: "registered workspace has no sidecar path".into(),
            })?;
    if chan_workspace::lock::is_locked_by_foreign_holder(&paths.lock, &known.root_path) {
        return execute_live_workspace_search(known, &paths.lock, request, socket_dirs).await;
    }
    match lib.open_workspace(&known.root_path) {
        Ok(workspace) => {
            workspace
                .workspace_search(request)
                .map_err(|error| WorkspaceExecutionFailure {
                    code: "workspace_search_failed",
                    message: error.to_string(),
                })
        }
        Err(
            chan_workspace::ChanError::WorkspaceLocked
            | chan_workspace::ChanError::WorkspaceAlreadyOpen,
        ) => execute_live_workspace_search(known, &paths.lock, request, socket_dirs).await,
        Err(error) => Err(WorkspaceExecutionFailure {
            code: "workspace_open_failed",
            message: error.to_string(),
        }),
    }
}

async fn execute_live_workspace_search(
    known: &KnownWorkspace,
    lock_dir: &Path,
    request: &WorkspaceSearchRequest,
    socket_dirs: Option<&[PathBuf]>,
) -> std::result::Result<WorkspaceSearchResult, WorkspaceExecutionFailure> {
    let record = chan_workspace::lock::read_lock_record(lock_dir).ok_or_else(|| {
        WorkspaceExecutionFailure {
            code: "served_workspace_unreachable",
            message: "workspace lock is held but its holder record is unavailable".into(),
        }
    })?;
    let socket = match socket_dirs {
        Some(dirs) => {
            control_socket_for_workspace_in_dirs(
                dirs,
                record.pid,
                &known.root_path,
                &known.metadata_key,
                cfg!(unix),
            )
            .await
        }
        None => {
            control_socket_for_workspace(record.pid, &known.root_path, &known.metadata_key).await
        }
    }
    .ok_or_else(|| WorkspaceExecutionFailure {
        code: "served_workspace_unreachable",
        message: format!(
            "no reachable control tenant exactly matches {} ({})",
            known.root_path.display(),
            known.metadata_key
        ),
    })?;
    let raw = chan_shell::send_control_request(
        &socket,
        chan_shell::ControlRequest::WorkspaceSearch {
            request: request.clone(),
        },
    )
    .await
    .map_err(|error| WorkspaceExecutionFailure {
        code: "served_workspace_unreachable",
        message: error.to_string(),
    })?;
    serde_json::from_str(&raw).map_err(|error| WorkspaceExecutionFailure {
        code: "workspace_search_failed",
        message: format!("decoding workspace search response: {error}"),
    })
}

#[derive(Serialize)]
struct WorkspaceListOutput {
    workspaces: Vec<WorkspaceListEntry>,
}

#[derive(Serialize)]
struct WorkspaceListEntry {
    path: String,
    /// Stable per-workspace metadata storage key under ~/.chan/workspaces/.
    metadata_key: String,
    /// RFC3339 UTC timestamp.
    last_seen_at: String,
}

impl From<&KnownWorkspace> for WorkspaceListEntry {
    fn from(d: &KnownWorkspace) -> Self {
        Self {
            path: d.root_path.display().to_string(),
            metadata_key: d.metadata_key.clone(),
            last_seen_at: d.last_seen_at.to_rfc3339(),
        }
    }
}

#[derive(Serialize)]
struct StatusOutput {
    root: String,
    metadata_key: Option<String>,
    readiness: WorkspaceReadiness,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<StatusIndex>,
    #[serde(skip_serializing_if = "Option::is_none")]
    graph: Option<StatusGraph>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<StatusReport>,
}

#[derive(Serialize)]
struct StatusIndex {
    ready: bool,
    indexed_docs: u64,
    indexed_vectors: u64,
    model: String,
}

#[derive(Serialize)]
struct StatusGraph {
    files: usize,
    edges: usize,
    tags: usize,
}

#[derive(Serialize)]
struct StatusReport {
    files: u64,
    code: u64,
    comments: u64,
    blanks: u64,
    complexity: u64,
    by_language: Vec<StatusLanguage>,
    cocomo_model: String,
    estimated_cost_usd: f64,
}

#[derive(Serialize)]
struct StatusLanguage {
    name: String,
    files: u64,
    code: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct ConfigOutput {
    editor: EditorPrefs,
    server: ServerConfig,
}

#[derive(Clone, Copy)]
enum ConfigValueKind {
    String,
    NonEmptyString,
    Bool,
    U32,
    U32Range(u32, u32),
    U64NonZero,
    UsizeNonZero,
    F64Range(f64, f64),
    Enum(&'static [&'static str]),
    OptionalU32Range(u32, u32),
    OptionalEnum(&'static [&'static str]),
    StringList(usize),
    Color,
    ReadOnly(&'static str),
    Collection(&'static str),
}

#[derive(Clone, Copy)]
struct ConfigKeySpec {
    key: &'static str,
    kind: ConfigValueKind,
}

const CONFIG_KEYS: &[ConfigKeySpec] = &[
    ConfigKeySpec {
        key: "editor.editor_theme",
        kind: ConfigValueKind::Enum(&["github", "google_docs", "word"]),
    },
    ConfigKeySpec {
        key: "editor.editor_font_size",
        kind: ConfigValueKind::OptionalU32Range(10, 32),
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.mode",
        kind: ConfigValueKind::Enum(&["standard", "custom"]),
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.background",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.foreground",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.cursor",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.contrast",
        kind: ConfigValueKind::Enum(&["auto", "dark", "light"]),
    },
    ConfigKeySpec {
        key: "editor.theme",
        kind: ConfigValueKind::Enum(&["system", "light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.pane_widths.inspector",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.graph",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.browser",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.search",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.outline",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.browser_side_panes.left",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.browser_side_panes.right",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.line_spacing",
        kind: ConfigValueKind::Enum(&["standard", "compact"]),
    },
    ConfigKeySpec {
        key: "editor.date_format",
        kind: ConfigValueKind::String,
    },
    ConfigKeySpec {
        key: "editor.strip_trailing_whitespace_on_save",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.bubble_overlay_mode",
        kind: ConfigValueKind::Enum(&["stack", "tray"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.editor",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.terminal",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.browser",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.graph",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.dashboard",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.graph_colors.mode",
        kind: ConfigValueKind::Enum(&["standard", "custom"]),
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.doc",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.source",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.binary",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.img",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.folder",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.tag",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.language",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.contact",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.doc",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.source",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.binary",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.img",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.folder",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.tag",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.language",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.contact",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.empty_pane_carousel_cycling",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.page_width_ratio",
        kind: ConfigValueKind::F64Range(0.25, 1.0),
    },
    ConfigKeySpec {
        key: "editor.overlay_maximized",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.cs_dismissed",
        kind: ConfigValueKind::ReadOnly("managed by the cs-link prompt"),
    },
    ConfigKeySpec {
        key: "editor.shortcuts",
        kind: ConfigValueKind::Collection(
            "use Settings or PATCH /api/config to edit shortcut overrides",
        ),
    },
    ConfigKeySpec {
        key: "server.attachments_dir",
        kind: ConfigValueKind::NonEmptyString,
    },
    ConfigKeySpec {
        key: "server.search.aggression",
        kind: ConfigValueKind::Enum(&["conservative", "balanced", "aggressive"]),
    },
    ConfigKeySpec {
        key: "server.terminal.idle_timeout_secs",
        kind: ConfigValueKind::U64NonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.session_cap",
        kind: ConfigValueKind::UsizeNonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.ring_bytes",
        kind: ConfigValueKind::UsizeNonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.scrollback_mb",
        kind: ConfigValueKind::U32Range(10, 50),
    },
    ConfigKeySpec {
        key: "server.terminal.default_term",
        kind: ConfigValueKind::NonEmptyString,
    },
    ConfigKeySpec {
        key: "server.terminal.font",
        kind: ConfigValueKind::Enum(&["os-default", "source-code-pro"]),
    },
    ConfigKeySpec {
        key: "server.terminal.font_size",
        kind: ConfigValueKind::U32Range(8, 32),
    },
    ConfigKeySpec {
        key: "server.terminal.mcp_env",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.mouse_capture",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.ghostty",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.secret_masking",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.secret_mask_suffixes",
        kind: ConfigValueKind::StringList(100),
    },
];

fn cmd_status(path: Option<PathBuf>, json: bool) -> Result<()> {
    let lib = library()?;
    let root = path.ok_or_else(|| missing_workspace_path("status", "chan workspace status ."))?;
    ensure_workspace_registered(&lib, &root)?;
    let workspace = lib.open_workspace(&root)?;
    let metadata_key = lib
        .list_workspaces()
        .into_iter()
        .find(|d| same_path(&d.root_path, workspace.root()))
        .map(|d| d.metadata_key);
    let out = workspace_status_output(&workspace, metadata_key)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    println!("workspace: {}", out.root);
    if let Some(metadata_key) = &out.metadata_key {
        println!("metadata: {metadata_key}");
    }
    let readiness = match out.readiness {
        WorkspaceReadiness::Ready { .. } => "ready",
        WorkspaceReadiness::Recovering { .. } => "recovering",
    };
    println!("readiness: {readiness}");
    if matches!(out.readiness, WorkspaceReadiness::Recovering { .. }) {
        println!("derived state: unavailable while workspace recovery is in progress");
        return Ok(());
    }
    let index = out
        .index
        .as_ref()
        .context("ready workspace status missing index snapshot")?;
    let graph = out
        .graph
        .as_ref()
        .context("ready workspace status missing graph snapshot")?;
    let report = out
        .report
        .as_ref()
        .context("ready workspace status missing report snapshot")?;
    println!(
        "index: ready={} docs={} vectors={} model={}",
        index.ready, index.indexed_docs, index.indexed_vectors, index.model
    );
    println!(
        "graph: files={} edges={} tags={}",
        graph.files, graph.edges, graph.tags
    );
    println!(
        "report: files={} code={} comments={} blanks={} complexity={} cocomo={} cost=${:.2}",
        report.files,
        report.code,
        report.comments,
        report.blanks,
        report.complexity,
        report.cocomo_model,
        report.estimated_cost_usd
    );
    if !report.by_language.is_empty() {
        println!("languages:");
        for lang in &report.by_language {
            println!(
                "  {:<18} files={:<5} code={}",
                lang.name, lang.files, lang.code
            );
        }
    }
    Ok(())
}

fn workspace_status_output(
    workspace: &Workspace,
    metadata_key: Option<String>,
) -> Result<StatusOutput> {
    let readiness = workspace.readiness();
    if matches!(readiness, WorkspaceReadiness::Recovering { .. }) {
        return Ok(StatusOutput {
            root: workspace.root().display().to_string(),
            metadata_key,
            readiness,
            index: None,
            graph: None,
            report: None,
        });
    }

    let index = workspace.index_stats().context("reading index stats")?;
    let graph = workspace.graph().context("opening graph")?;
    let graph_files = graph.files().context("reading graph files")?;
    let mut graph_edges = 0usize;
    for file in &graph_files {
        graph_edges += graph
            .neighbors(file)
            .with_context(|| format!("querying graph neighbors for {file}"))?
            .len();
    }
    let tags = graph.tags().context("reading graph tags")?.len();
    let report = workspace.report().context("reading code report")?;
    let by_language = report
        .by_language
        .into_iter()
        .take(12)
        .map(|l| StatusLanguage {
            name: l.name,
            files: l.files,
            code: l.code,
        })
        .collect();
    let out = StatusOutput {
        root: workspace.root().display().to_string(),
        metadata_key,
        readiness,
        index: Some(StatusIndex {
            ready: index.ready,
            indexed_docs: index.indexed_docs,
            indexed_vectors: index.indexed_vectors,
            model: index.model,
        }),
        graph: Some(StatusGraph {
            files: graph_files.len(),
            edges: graph_edges,
            tags,
        }),
        report: Some(StatusReport {
            files: report.totals.files,
            code: report.totals.code,
            comments: report.totals.comments,
            blanks: report.totals.blanks,
            complexity: report.totals.complexity,
            by_language,
            cocomo_model: report.cocomo.model,
            estimated_cost_usd: report.cocomo.estimated_cost_usd,
        }),
    };
    Ok(out)
}

fn cmd_config(action: ConfigAction) -> Result<()> {
    match action {
        ConfigAction::Get { key, json } => {
            let editor = EditorPrefs::load().context("loading editor preferences")?;
            let server = ServerConfig::load().context("loading server config")?;
            match key.as_deref() {
                None | Some("") => {
                    let output = ConfigOutput { editor, server };
                    validate_config_dump(&serde_json::to_value(&output)?)?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&output)?);
                    } else {
                        print!("{}", toml::to_string_pretty(&output)?);
                    }
                }
                Some(k) => {
                    let value = read_config_key(&editor, &server, k)?;
                    if json {
                        println!("{}", serde_json::to_string(&value)?);
                    } else {
                        println!("{}", scalar_to_string(&value));
                    }
                }
            }
            Ok(())
        }
        ConfigAction::Set { key, value } => {
            let (key, raw_value) = split_assignment(&key, value.as_deref())?;
            let key = canonical_config_key(&key);
            if key.starts_with("server.") {
                let mut cfg = ServerConfig::load().context("loading server config")?;
                write_server_config_key(&mut cfg, &key, &raw_value)?;
                cfg.save().context("saving server config")?;
            } else {
                let mut prefs = EditorPrefs::load().context("loading editor preferences")?;
                write_pref_key(&mut prefs, &key, &raw_value)?;
                prefs.save().context("saving editor preferences")?;
            }
            println!("{key} = {raw_value}");
            Ok(())
        }
    }
}

fn cmd_metadata(action: MetadataAction) -> Result<()> {
    match action {
        MetadataAction::Export { path, archive } => {
            let lib = library()?;
            let report = lib
                .export_metadata_archive(
                    &path,
                    &archive,
                    MetadataExportOptions {
                        chan_version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                )
                .context("exporting metadata archive")?;
            println!(
                "exported {} files ({} bytes) to {}",
                report.files,
                report.bytes,
                report.archive_path.display()
            );
            println!("source metadata: {}", report.manifest.source_metadata_key);
            Ok(())
        }
        MetadataAction::Import {
            path,
            archive,
            rescan,
            force_scm,
        } => {
            let lib = library()?;
            ensure_workspace_registered(&lib, &path)?;
            let report = lib
                .import_metadata_archive(
                    &path,
                    &archive,
                    MetadataImportOptions { rescan, force_scm },
                )
                .context("importing metadata archive")?;
            println!(
                "imported {} files ({} bytes) from {}",
                report.files,
                report.bytes,
                archive.display()
            );
            println!("subtrees: {}", report.imported_subtrees.join(", "));
            if report.rescanned {
                println!("rescan: completed");
            }
            Ok(())
        }
        MetadataAction::Inspect { archive, json } => {
            let lib = library()?;
            let manifest = lib
                .inspect_metadata_archive(&archive)
                .context("inspecting metadata archive")?;
            if json {
                println!("{}", serde_json::to_string_pretty(&manifest)?);
            } else {
                println!("format: {}", manifest.archive_format_version);
                println!("chan: {}", manifest.chan_version);
                println!("created: {}", manifest.created_at);
                println!("source root: {}", manifest.source_root);
                println!("source metadata: {}", manifest.source_metadata_key);
                println!("subtrees: {}", manifest.included_subtrees.join(", "));
                if let Some(scm) = manifest.scm {
                    if !scm.remotes.is_empty() {
                        println!("scm remotes: {}", scm.remotes.join(", "));
                    }
                    if let Some(head) = scm.head {
                        println!("scm head: {head}");
                    }
                }
            }
            Ok(())
        }
    }
}

/// Accept both `chan config set k=v` and `chan config set k v`.
/// Returns `(key, value)`. Bails with a clear message on empty values
/// so a typo doesn't silently wipe a preference.
fn split_assignment(key: &str, value: Option<&str>) -> Result<(String, String)> {
    if let Some(v) = value {
        if v.is_empty() {
            anyhow::bail!("value must not be empty (got `{key}=`)");
        }
        return Ok((key.to_owned(), v.to_owned()));
    }
    if let Some((k, v)) = key.split_once('=') {
        let k = k.trim();
        let v = v.trim();
        if k.is_empty() {
            anyhow::bail!("key must not be empty");
        }
        if v.is_empty() {
            anyhow::bail!("value must not be empty (got `{key}`)");
        }
        return Ok((k.to_owned(), v.to_owned()));
    }
    anyhow::bail!("missing value: use `{key}=VALUE` or `{key} VALUE`")
}

fn read_config_key(
    editor: &EditorPrefs,
    server: &ServerConfig,
    key: &str,
) -> Result<serde_json::Value> {
    let key = canonical_config_key(key);
    let spec = config_key_spec(&key)?;
    let config = serde_json::to_value(ConfigOutput {
        editor: editor.clone(),
        server: server.clone(),
    })?;
    if let Some(value) = config_value_at(&config, &key) {
        return Ok(value.clone());
    }
    match spec.kind {
        ConfigValueKind::OptionalU32Range(..) | ConfigValueKind::OptionalEnum(..) => {
            Ok(serde_json::Value::Null)
        }
        ConfigValueKind::Collection(_) if key == "editor.shortcuts" => Ok(serde_json::json!({})),
        _ => anyhow::bail!("supported config key `{key}` is missing from the serialized schema"),
    }
}

fn write_pref_key(prefs: &mut EditorPrefs, key: &str, value: &str) -> Result<()> {
    let key = canonical_config_key(key);
    if !key.starts_with("editor.") {
        anyhow::bail!("`{key}` is a server config key, not an editor preference");
    }
    let updated = write_config_key(
        ConfigOutput {
            editor: prefs.clone(),
            server: ServerConfig::default(),
        },
        &key,
        value,
    )?;
    *prefs = updated.editor;
    Ok(())
}

fn write_server_config_key(cfg: &mut ServerConfig, key: &str, value: &str) -> Result<()> {
    let key = canonical_config_key(key);
    if !key.starts_with("server.") {
        anyhow::bail!("`{key}` is an editor preference, not a server config key");
    }
    let updated = write_config_key(
        ConfigOutput {
            editor: EditorPrefs::default(),
            server: cfg.clone(),
        },
        &key,
        value,
    )?;
    *cfg = updated.server;
    Ok(())
}

fn canonical_config_key(key: &str) -> String {
    key.strip_prefix("terminal.")
        .map(|suffix| format!("server.terminal.{suffix}"))
        .unwrap_or_else(|| key.to_owned())
}

fn config_key_spec(key: &str) -> Result<ConfigKeySpec> {
    if key.starts_with("editor.shortcuts.") {
        anyhow::bail!(
            "`editor.shortcuts` is a collection; use Settings or PATCH /api/config to edit shortcut overrides"
        );
    }
    CONFIG_KEYS
        .iter()
        .copied()
        .find(|spec| spec.key == key)
        .ok_or_else(|| {
            let settable = CONFIG_KEYS
                .iter()
                .filter(|spec| {
                    !matches!(
                        spec.kind,
                        ConfigValueKind::ReadOnly(_) | ConfigValueKind::Collection(_)
                    )
                })
                .map(|spec| spec.key)
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::anyhow!("unknown key `{key}`; supported settable keys: {settable}")
        })
}

fn config_value_at<'a>(root: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    key.split('.')
        .try_fold(root, |value, segment| value.get(segment))
}

fn config_schema_sample() -> Result<serde_json::Value> {
    let mut editor = EditorPrefs {
        editor_font_size: Some(10),
        terminal_colors: chan_server::TerminalColorPrefs {
            custom: Some(chan_server::TerminalCustomColors {
                background: "#000000".into(),
                foreground: "#ffffff".into(),
                cursor: "#ffffff".into(),
                contrast: chan_server::TerminalContrast::Auto,
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    editor.hybrid_surface_themes.editor = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.terminal = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.browser = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.graph = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.dashboard = Some(chan_server::SurfaceThemeChoice::Light);
    // Empty per-mode tables: enough schema for `set_config_value` to
    // materialize `editor.graph_colors.<mode>.<kind>` on a default
    // config without pre-populating any hue.
    editor.graph_colors.dark = Some(chan_server::GraphPalette::default());
    editor.graph_colors.light = Some(chan_server::GraphPalette::default());
    Ok(serde_json::to_value(ConfigOutput {
        editor,
        server: ServerConfig::default(),
    })?)
}

fn write_config_key(config: ConfigOutput, key: &str, raw: &str) -> Result<ConfigOutput> {
    let spec = config_key_spec(key)?;
    let value = parse_config_scalar(spec, raw)?;
    let mut serialized = serde_json::to_value(&config)?;
    let sample = config_schema_sample()?;
    set_config_value(&mut serialized, &sample, key, value)?;
    if key == "editor.terminal_colors.mode"
        && config_value_at(&serialized, key) == Some(&serde_json::json!("custom"))
        && config_value_at(&serialized, "editor.terminal_colors.custom").is_none()
    {
        anyhow::bail!(
            "editor.terminal_colors.mode=custom needs the custom color fields; set those first"
        );
    }
    serde_json::from_value(serialized)
        .with_context(|| format!("invalid value for config key `{key}`"))
}

fn set_config_value(
    root: &mut serde_json::Value,
    sample: &serde_json::Value,
    key: &str,
    value: serde_json::Value,
) -> Result<()> {
    let segments: Vec<&str> = key.split('.').collect();
    let mut current = root;
    let mut sample_current = sample;
    for segment in &segments[..segments.len() - 1] {
        sample_current = sample_current
            .get(*segment)
            .ok_or_else(|| anyhow::anyhow!("config schema has no `{key}` leaf"))?;
        let object = current
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("`{key}` crosses a scalar config value"))?;
        current = object
            .entry((*segment).to_owned())
            .or_insert_with(|| sample_current.clone());
    }
    let leaf = segments.last().expect("config keys are non-empty");
    current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("`{key}` parent is not a config section"))?
        .insert((*leaf).to_owned(), value);
    Ok(())
}

fn parse_config_scalar(spec: ConfigKeySpec, raw: &str) -> Result<serde_json::Value> {
    use serde_json::{Number, Value};

    let invalid_enum = |values: &[&str]| {
        anyhow::anyhow!("{}: expected {}, got `{raw}`", spec.key, values.join("|"))
    };
    let value = match spec.kind {
        ConfigValueKind::String => Value::String(raw.to_owned()),
        ConfigValueKind::NonEmptyString => {
            if raw.is_empty() {
                anyhow::bail!("{} must be non-empty", spec.key);
            }
            Value::String(raw.to_owned())
        }
        ConfigValueKind::Bool => Value::Bool(
            raw.parse::<bool>()
                .with_context(|| format!("{}: expected true|false, got `{raw}`", spec.key))?,
        ),
        ConfigValueKind::U32 => Value::Number(Number::from(parse_u32(spec.key, raw)?)),
        ConfigValueKind::U32Range(min, max) => {
            let parsed = parse_u32(spec.key, raw)?;
            if !(min..=max).contains(&parsed) {
                anyhow::bail!("{} must be in {min}..={max}, got `{raw}`", spec.key);
            }
            Value::Number(Number::from(parsed))
        }
        ConfigValueKind::U64NonZero => {
            Value::Number(Number::from(parse_nonzero_u64(spec.key, raw)?))
        }
        ConfigValueKind::UsizeNonZero => {
            let parsed = parse_nonzero_usize(spec.key, raw)?;
            Value::Number(Number::from(parsed as u64))
        }
        ConfigValueKind::F64Range(min, max) => {
            let parsed = raw
                .parse::<f64>()
                .with_context(|| format!("{}: expected a number, got `{raw}`", spec.key))?;
            if !parsed.is_finite() || !(min..=max).contains(&parsed) {
                anyhow::bail!("{} must be in {min}..={max}, got `{raw}`", spec.key);
            }
            Value::Number(Number::from_f64(parsed).expect("finite f64 has a JSON number"))
        }
        ConfigValueKind::Enum(values) => {
            let normalized = match spec.key {
                "editor.theme" => theme_choice_label(parse_theme_choice(raw)?).to_owned(),
                "editor.editor_theme" => editor_theme_label(parse_editor_theme(raw)?).to_owned(),
                "editor.line_spacing" => line_spacing_label(parse_line_spacing(raw)?).to_owned(),
                _ => raw.to_owned(),
            };
            if !values.contains(&normalized.as_str()) {
                return Err(invalid_enum(values));
            }
            Value::String(normalized)
        }
        ConfigValueKind::OptionalU32Range(min, max) => {
            if matches!(raw, "none" | "null") {
                Value::Null
            } else {
                let parsed = parse_u32(spec.key, raw)?;
                if !(min..=max).contains(&parsed) {
                    anyhow::bail!("{} must be in {min}..={max}, got `{raw}`", spec.key);
                }
                Value::Number(Number::from(parsed))
            }
        }
        ConfigValueKind::OptionalEnum(values) => {
            if matches!(raw, "none" | "null") {
                Value::Null
            } else {
                if !values.contains(&raw) {
                    return Err(invalid_enum(values));
                }
                Value::String(raw.to_owned())
            }
        }
        ConfigValueKind::StringList(max) => {
            let entries: Vec<String> = serde_json::from_str(raw).with_context(|| {
                format!(
                    "{}: expected a JSON string array, for example [\"TOKEN\",\"SECRET\"]",
                    spec.key
                )
            })?;
            if entries.len() > max {
                anyhow::bail!("{} accepts at most {max} entries", spec.key);
            }
            if let Some(invalid) = entries.iter().find(|entry| {
                entry.is_empty()
                    || !entry
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            }) {
                anyhow::bail!("{}: `{invalid}` is outside [A-Za-z0-9_]+", spec.key);
            }
            let mut seen = std::collections::HashSet::new();
            if let Some(duplicate) = entries.iter().find(|entry| !seen.insert((*entry).clone())) {
                anyhow::bail!("{}: duplicate entry `{duplicate}`", spec.key);
            }
            serde_json::to_value(entries)?
        }
        ConfigValueKind::Color => Value::String(normalize_config_color(spec.key, raw)?),
        ConfigValueKind::ReadOnly(reason) => {
            anyhow::bail!("{} is read-only in `chan config`: {reason}", spec.key)
        }
        ConfigValueKind::Collection(route) => {
            anyhow::bail!("{} is a collection; {route}", spec.key)
        }
    };
    Ok(value)
}

fn normalize_config_color(key: &str, raw: &str) -> Result<String> {
    let hex = raw
        .strip_prefix('#')
        .filter(|hex| matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow::anyhow!("{key}: expected #rgb or #rrggbb, got `{raw}`"))?;
    let expanded = if hex.len() == 3 {
        hex.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        hex.to_owned()
    };
    Ok(format!("#{}", expanded.to_ascii_lowercase()))
}

fn validate_config_dump(config: &serde_json::Value) -> Result<()> {
    fn walk(value: &serde_json::Value, path: &mut Vec<String>) -> Result<()> {
        if let serde_json::Value::Object(fields) = value {
            for (name, value) in fields {
                path.push(name.clone());
                walk(value, path)?;
                path.pop();
            }
            return Ok(());
        }
        let key = path.join(".");
        if key.starts_with("editor.shortcuts.") {
            return Ok(());
        }
        config_key_spec(&key)
            .with_context(|| format!("serialized config leaf `{key}` has no CLI policy"))?;
        Ok(())
    }
    walk(config, &mut Vec::new())
}

fn parse_theme_choice(value: &str) -> Result<ThemeChoice> {
    match value {
        "system" => Ok(ThemeChoice::System),
        "light" => Ok(ThemeChoice::Light),
        "dark" => Ok(ThemeChoice::Dark),
        _ => anyhow::bail!("expected system|light|dark, got `{value}`"),
    }
}

fn parse_editor_theme(value: &str) -> Result<EditorTheme> {
    match value {
        "github" => Ok(EditorTheme::Github),
        "google_docs" => Ok(EditorTheme::GoogleDocs),
        "word" => Ok(EditorTheme::Word),
        _ => anyhow::bail!("expected github|google_docs|word, got `{value}`"),
    }
}

fn parse_line_spacing(value: &str) -> Result<LineSpacing> {
    match value {
        "standard" => Ok(LineSpacing::Standard),
        "compact" => Ok(LineSpacing::Compact),
        // `tight` is an accepted legacy alias for `compact` (same
        // density target), so muscle memory and existing
        // scripts keep working; the canonical reader (`config get`)
        // echoes back `compact` so the user is nudged toward the new
        // spelling without losing their preference.
        "tight" => Ok(LineSpacing::Compact),
        _ => anyhow::bail!("expected standard|compact, got `{value}`"),
    }
}

fn parse_u32(key: &str, value: &str) -> Result<u32> {
    value
        .parse::<u32>()
        .with_context(|| format!("{key}: expected non-negative integer, got `{value}`"))
}

fn parse_nonzero_u64(key: &str, value: &str) -> Result<u64> {
    let parsed = value
        .parse::<u64>()
        .with_context(|| format!("{key} must be a positive integer"))?;
    if parsed == 0 {
        anyhow::bail!("{key} must be greater than 0");
    }
    Ok(parsed)
}

fn parse_nonzero_usize(key: &str, value: &str) -> Result<usize> {
    let parsed = value
        .parse::<usize>()
        .with_context(|| format!("{key} must be a positive integer"))?;
    if parsed == 0 {
        anyhow::bail!("{key} must be greater than 0");
    }
    Ok(parsed)
}

fn theme_choice_label(t: ThemeChoice) -> &'static str {
    match t {
        ThemeChoice::System => "system",
        ThemeChoice::Light => "light",
        ThemeChoice::Dark => "dark",
    }
}

fn editor_theme_label(t: EditorTheme) -> &'static str {
    match t {
        EditorTheme::Github => "github",
        EditorTheme::GoogleDocs => "google_docs",
        EditorTheme::Word => "word",
    }
}

fn line_spacing_label(s: LineSpacing) -> &'static str {
    match s {
        LineSpacing::Standard => "standard",
        LineSpacing::Compact => "compact",
    }
}

/// Render a single-value response without the JSON quotes / braces.
/// Strings unquote, numbers stringify, everything else falls back to
/// the JSON shape.
fn scalar_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn cmd_contacts_import_csv(
    file: PathBuf,
    into: String,
    provider: String,
    dry_run: bool,
    overwrite: bool,
    workspace: Option<PathBuf>,
) -> Result<()> {
    use chan_workspace::contacts::{
        google::parse_google_csv, slug::SlugAllocator, ImportOpts, ProviderKind,
    };

    // Provider gate. Only Google CSV today; the flag exists so the
    // help text and the wire shape are stable when more land.
    let prov =
        ProviderKind::parse(&provider).with_context(|| format!("unknown provider: {provider}"))?;
    if prov != ProviderKind::Google {
        anyhow::bail!("only --provider google is supported today");
    }

    // Parse the CSV up front. A bad file should fail before we
    // touch the workspace, so the user doesn't end up with a half-
    // created Contacts/ dir on a typo.
    let csv_bytes = std::fs::read(&file).with_context(|| format!("reading {}", file.display()))?;
    let contacts = parse_google_csv(csv_bytes.as_slice())
        .with_context(|| format!("parsing {}", file.display()))?;
    if contacts.is_empty() {
        println!("(no contacts in {})", file.display());
        return Ok(());
    }

    let lib = library()?;
    let root = workspace.ok_or_else(|| {
        missing_workspace_path(
            "contacts import csv",
            "chan workspace contacts import csv contacts.csv --workspace .",
        )
    })?;
    if !root.exists() {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("creating workspace root {}", root.display()))?;
    }
    ensure_workspace_registered(&lib, &root)?;
    let workspace = lib.open_workspace(&root)?;

    if dry_run {
        // Mirror the orchestrator's slug + existence check loop
        // without writing. Existence checks against the live workspace
        // so SKIPPED / OVERWROTE labels are accurate.
        let dir_norm = into.trim_matches('/').to_string();
        let mut wrote = 0usize;
        let mut overwrote = 0usize;
        let mut skipped = 0usize;
        let on_disk = |p: &str| workspace.exists(p);
        let mut slugs = SlugAllocator::new(&dir_norm, &on_disk);
        for c in &contacts {
            let path = slugs.slug_for(c);
            let exists = workspace.exists(&path);
            if exists && !overwrite {
                println!("WOULD SKIP      {path}  (exists)");
                skipped += 1;
            } else if exists {
                println!("WOULD OVERWRITE {path}");
                overwrote += 1;
            } else {
                println!("WOULD WRITE     {path}");
                wrote += 1;
            }
        }
        println!();
        println!(
            "{wrote} would write, {overwrote} would overwrite, \
             {skipped} would skip (dry-run; no files changed)"
        );
        return Ok(());
    }

    let summary = workspace
        .import_contacts(&into, contacts, ImportOpts { overwrite })
        .context("importing contacts")?;
    print_import_summary(&summary);
    Ok(())
}

fn print_import_summary(summary: &chan_workspace::ImportSummary) {
    use chan_workspace::ImportOutcome;
    for o in &summary.outcomes {
        match o {
            ImportOutcome::Wrote { path } => println!("WROTE     {path}"),
            ImportOutcome::Overwrote { path } => println!("OVERWROTE {path}"),
            ImportOutcome::Skipped { path, reason } => {
                println!("SKIPPED   {path}  ({reason})")
            }
            ImportOutcome::Failed { name, reason } => {
                println!("FAILED    {name}  ({reason})")
            }
        }
    }
    let c = summary.counts();
    println!();
    println!(
        "{} wrote, {} overwrote, {} skipped, {} failed",
        c.wrote, c.overwrote, c.skipped, c.failed
    );
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// `make shortcuts-check` diffs the SOURCE text of `KEYBINDINGS_TABLE`
    /// against the generator, so it cannot see an escape that changes the
    /// compiled value. This asserts on the value itself: every row of the
    /// chord table carries the two-space indent the help framing expects.
    #[test]
    fn keybindings_table_rows_keep_the_help_indent() {
        let unindented: Vec<&str> = KEYBINDINGS_TABLE
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with("  "))
            .collect();
        assert!(
            unindented.is_empty(),
            "KEYBINDINGS_TABLE rows lost the table indent:\n  {}",
            unindented.join("\n  ")
        );
        assert!(
            KEYBINDINGS_TABLE.lines().filter(|l| !l.is_empty()).count() > 10,
            "KEYBINDINGS_TABLE looks empty"
        );
    }

    #[test]
    fn upgrade_route_refuses_a_packaged_build_in_every_personality() {
        // The marker is a build-time option_env!, so both cases are
        // exercised by passing it in. The route is resolved before
        // --check is read, so a packaged build refuses that too.
        for manager in ["aur", "nix"] {
            for personality in [Personality::Standalone, Personality::Desktop] {
                let route = decide_upgrade_route(personality, Some(manager));
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

    #[test]
    fn upgrade_route_installs_on_an_unpackaged_build() {
        assert_eq!(
            decide_upgrade_route(Personality::Standalone, None),
            UpgradeRoute::Cli
        );
        assert_eq!(
            decide_upgrade_route(Personality::Desktop, None),
            UpgradeRoute::Desktop
        );
    }

    #[test]
    fn devserver_collision_hint_only_on_default_port_addr_in_use() {
        use std::io::{Error as IoError, ErrorKind};
        let in_use = || chan_server::Error::Io(IoError::from(ErrorKind::AddrInUse));
        let matching = DevserverCandidate {
            instance_index: 0,
            pid: 41,
            library_root: PathBuf::from("/home/me/.chan"),
            port: DEFAULT_PORT,
            version: "0.74.0".into(),
        };
        let other_port = DevserverCandidate {
            port: 9999,
            ..matching.clone()
        };

        let hint =
            devserver_port_collision_hint(DEFAULT_PORT, &in_use(), &[matching]).expect("hint");
        assert!(hint.contains(&DEFAULT_PORT.to_string()), "{hint}");
        assert!(hint.contains("your local devserver"), "{hint}");
        assert!(hint.contains("/home/me/.chan"), "{hint}");
        assert!(hint.contains("--devserver=8787"), "{hint}");
        assert!(hint.contains("--port"), "{hint}");

        // A live devserver on another port does not explain this collision.
        let hint =
            devserver_port_collision_hint(DEFAULT_PORT, &in_use(), &[other_port]).expect("hint");
        assert!(hint.contains("no devserver of yours"), "{hint}");
        assert!(hint.contains("another user's"), "{hint}");
        // The holder can also be the user's own pre-discovery devserver;
        // the hint must not imply only foreign processes qualify.
        assert!(hint.contains("older chan version"), "{hint}");
        assert!(!hint.contains("did not mount"), "{hint}");

        assert!(devserver_port_collision_hint(9999, &in_use(), &[]).is_none());

        let denied = chan_server::Error::Io(IoError::from(ErrorKind::PermissionDenied));
        assert!(devserver_port_collision_hint(DEFAULT_PORT, &denied, &[]).is_none());

        let cfg = chan_server::Error::Config("nope".into());
        assert!(devserver_port_collision_hint(DEFAULT_PORT, &cfg, &[]).is_none());
    }

    #[test]
    fn devserver_bind_collision_hint_names_any_port() {
        use std::io::{Error as IoError, ErrorKind};
        let bind_err = |kind: ErrorKind, addr: &str| {
            anyhow::Error::from(IoError::from(kind)).context(format!("binding devserver on {addr}"))
        };

        // An explicit non-default port gets the hint too (a squatter against
        // `--port 9000` must fail loud with the port named), reading the
        // AddrInUse through the anyhow context chain the bind site adds.
        let addr: SocketAddr = "127.0.0.1:9000".parse().unwrap();
        let hint = devserver_bind_collision_hint(addr, &bind_err(ErrorKind::AddrInUse, "9000"))
            .expect("hint");
        assert!(hint.contains("127.0.0.1:9000"), "{hint}");
        assert!(hint.contains("--port"), "{hint}");

        // The shared default names its likely squatters.
        let addr: SocketAddr = format!("127.0.0.1:{DEFAULT_PORT}").parse().unwrap();
        let hint = devserver_bind_collision_hint(addr, &bind_err(ErrorKind::AddrInUse, "8787"))
            .expect("hint");
        assert!(hint.contains("chan devserver"), "{hint}");
        assert!(hint.contains("chan open"), "{hint}");

        // Any other failure keeps its generic context.
        assert!(devserver_bind_collision_hint(
            addr,
            &bind_err(ErrorKind::PermissionDenied, "8787")
        )
        .is_none());
        assert!(devserver_bind_collision_hint(addr, &anyhow::anyhow!("not io")).is_none());
    }

    #[test]
    fn watchdog_failure_bursts_shorter_than_grace_never_bail() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0),
            WatchdogVerdict::Watching
        );
        // The first failing sample opens the window and narrates once.
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(2)),
            WatchdogVerdict::LostContact
        );
        // Mixed failure kinds inside the window stay quiet while grace
        // remains: 31s after t0 is only 29s after the window opened.
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0 + sec(10)),
            WatchdogVerdict::Watching
        );
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(31)),
            WatchdogVerdict::Watching
        );
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0 + sec(32)),
            WatchdogVerdict::Recovered
        );
    }

    #[test]
    fn watchdog_continuous_failure_past_grace_gives_up() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0),
            WatchdogVerdict::LostContact
        );
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0 + sec(29)),
            WatchdogVerdict::Watching
        );
        // The whole grace elapsed without one success: give up.
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0 + sec(30)),
            WatchdogVerdict::GiveUp
        );
    }

    #[test]
    fn watchdog_recovery_resets_the_grace_window() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0),
            WatchdogVerdict::LostContact
        );
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0 + sec(29)),
            WatchdogVerdict::Recovered
        );
        // A new outage starts a FRESH window: 29 more seconds of failure sits
        // within grace again, not a continuation of the first burst.
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(30)),
            WatchdogVerdict::LostContact
        );
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(59)),
            WatchdogVerdict::Watching
        );
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(60)),
            WatchdogVerdict::GiveUp
        );
    }

    #[test]
    fn watchdog_repin_counts_as_success() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0),
            WatchdogVerdict::LostContact
        );
        // Adopting a restarted daemon closes the window like a healthy probe.
        assert_eq!(
            state.observe(
                WatchdogSample::Repinned {
                    old_pid: 1,
                    new_pid: 2
                },
                t0 + sec(4)
            ),
            WatchdogVerdict::Recovered
        );
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0 + sec(6)),
            WatchdogVerdict::Watching
        );
    }

    #[test]
    fn watchdog_adopts_a_restarted_chan_daemon_on_the_same_address() {
        let dir = tempfile::tempdir().unwrap();
        let record_path = dir.path().join("daemon.json");
        let addr = "127.0.0.1:4444";
        // Pin a pid no record below names; the restarted record names THIS
        // test process, the one pid guaranteed to be alive.
        let mut liveness = DaemonLiveness::Chan {
            record_path: record_path.clone(),
            pid: 1,
        };
        // Mid-restart there is no record yet: nothing to adopt.
        assert_eq!(liveness.adopt_restarted(addr), None);
        let record = chan_workspace::daemon_lock::DaemonRecord {
            pid: std::process::id(),
            creation_time: 0,
            addr: addr.to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
        };
        std::fs::write(&record_path, serde_json::to_string(&record).unwrap()).unwrap();
        // A live record on a different address is not the server this join's
        // callers are wired to.
        assert_eq!(liveness.adopt_restarted("127.0.0.1:5555"), None);
        // Same address, live, new pid: adopt it.
        assert_eq!(
            liveness.adopt_restarted(addr),
            Some((1, std::process::id()))
        );
        // The pin moved: the same record is now the watched daemon, so there
        // is nothing further to adopt.
        assert_eq!(liveness.adopt_restarted(addr), None);
    }

    #[test]
    fn devserver_url_discriminator() {
        // scheme://host shapes are devserver URLs.
        assert!(looks_like_devserver_url("https://box.example.com:8787"));
        assert!(looks_like_devserver_url("http://127.0.0.1:8787"));
        assert!(looks_like_devserver_url(
            "https://alice--1a2b3c4d5e6f.p1.usr.chan.app"
        ));
        // Everything else is a local path: bare host:port (no `//`), a
        // relative or absolute path, `.`, a Windows drive path, and an empty
        // authority.
        assert!(!looks_like_devserver_url("box.example.com:8787"));
        assert!(!looks_like_devserver_url("."));
        assert!(!looks_like_devserver_url("./notes"));
        assert!(!looks_like_devserver_url("/home/u/notes"));
        assert!(!looks_like_devserver_url("notes"));
        assert!(!looks_like_devserver_url(r"C:\Users\u\notes"));
        assert!(!looks_like_devserver_url("://nohost"));
        assert!(!looks_like_devserver_url("https://"));
    }

    /// No-flag triple, for the parentage-default cases.
    const NO_FLAGS: OpenFlags = OpenFlags {
        standalone: false,
        desktop: false,
        devserver: None,
    };

    fn route(
        flags: OpenFlags,
        parentage: Parentage,
        forced_desktop: bool,
        live: LiveInstances,
    ) -> Result<OpenTarget, RouteError> {
        let present = parentage != Parentage::None;
        decide_open_route(flags, parentage, forced_desktop, present, live)
    }

    #[test]
    fn route_explicit_flag_forces_its_target() {
        for parentage in [
            Parentage::Desktop,
            Parentage::Devserver { pid: 42 },
            Parentage::None,
        ] {
            let standalone = OpenFlags {
                standalone: true,
                ..NO_FLAGS
            };
            assert_eq!(
                route(standalone, parentage, false, LiveInstances::default()),
                Ok(OpenTarget::Standalone)
            );
            let desktop = OpenFlags {
                desktop: true,
                ..NO_FLAGS
            };
            assert_eq!(
                route(desktop, parentage, false, LiveInstances::default()),
                Ok(OpenTarget::Desktop)
            );
        }
        let devserver = OpenFlags {
            devserver: Some(DevserverSelector::Auto),
            ..NO_FLAGS
        };
        assert_eq!(
            route(
                devserver,
                Parentage::Desktop,
                false,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Devserver)
        );
        assert_eq!(
            route(devserver, Parentage::None, false, LiveInstances::default()),
            Ok(OpenTarget::Devserver)
        );
    }

    #[test]
    fn route_explicit_standalone_overrides_forced_desktop() {
        // --standalone wins even when the desktop handoff is forced (the
        // Windows shim's CHAN_DESKTOP_HANDOFF / Personality::Desktop).
        let standalone = OpenFlags {
            standalone: true,
            ..NO_FLAGS
        };
        assert_eq!(
            route(standalone, Parentage::None, true, LiveInstances::default()),
            Ok(OpenTarget::Standalone)
        );
        assert_eq!(
            route(
                standalone,
                Parentage::Desktop,
                true,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Standalone)
        );
    }

    #[test]
    fn route_live_instance_matrix() {
        let sets = [
            (
                LiveInstances::default(),
                OpenTarget::Standalone,
                OpenTarget::Desktop,
            ),
            (
                LiveInstances {
                    desktop: true,
                    devservers: 0,
                },
                OpenTarget::Desktop,
                OpenTarget::Desktop,
            ),
            (
                LiveInstances {
                    desktop: false,
                    devservers: 1,
                },
                OpenTarget::Devserver,
                OpenTarget::Devserver,
            ),
            (
                LiveInstances {
                    desktop: true,
                    devservers: 2,
                },
                OpenTarget::Devserver,
                OpenTarget::Desktop,
            ),
        ];
        for (live, standalone_want, desktop_want) in sets {
            assert_eq!(
                route(NO_FLAGS, Parentage::None, false, live),
                Ok(standalone_want),
                "standalone personality, live={live:?}"
            );
            assert_eq!(
                route(NO_FLAGS, Parentage::None, true, live),
                Ok(desktop_want),
                "desktop personality, live={live:?}"
            );
            for forced_desktop in [false, true] {
                assert_eq!(
                    route(NO_FLAGS, Parentage::Desktop, forced_desktop, live),
                    Ok(OpenTarget::Desktop),
                    "desktop parent, forced={forced_desktop}, live={live:?}"
                );
                assert_eq!(
                    route(
                        NO_FLAGS,
                        Parentage::Devserver { pid: 42 },
                        forced_desktop,
                        live,
                    ),
                    Ok(OpenTarget::Devserver),
                    "devserver parent, forced={forced_desktop}, live={live:?}"
                );
            }
        }
    }

    #[test]
    fn route_present_unidentified_prefers_standalone() {
        // A control socket IS present but its kind did not resolve (a wedged or
        // timed-out probe -> Parentage::None). Even with a leaked
        // CHAN_DESKTOP_HANDOFF, prefer standalone over misrouting to desktop.
        assert_eq!(
            decide_open_route(
                NO_FLAGS,
                Parentage::None,
                true,
                true,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Standalone)
        );
        assert_eq!(
            decide_open_route(
                NO_FLAGS,
                Parentage::None,
                true,
                true,
                LiveInstances {
                    desktop: false,
                    devservers: 1,
                }
            ),
            Ok(OpenTarget::Devserver)
        );
        assert_eq!(
            decide_open_route(
                NO_FLAGS,
                Parentage::None,
                true,
                false,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Desktop)
        );
    }

    #[test]
    fn route_nested_devserver_refused() {
        // Explicit --devserver from inside a devserver shell is refused; the
        // no-flag default in the same shell registers transparently.
        let devserver = OpenFlags {
            devserver: Some(DevserverSelector::Auto),
            ..NO_FLAGS
        };
        assert_eq!(
            route(
                devserver,
                Parentage::Devserver { pid: 42 },
                false,
                LiveInstances::default()
            ),
            Err(RouteError::NestedDevserver)
        );
        assert_eq!(
            route(
                NO_FLAGS,
                Parentage::Devserver { pid: 42 },
                false,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Devserver)
        );
    }

    #[test]
    fn route_multiple_targets_rejected() {
        // The resolver guards mutual exclusion even though clap rejects it
        // first (see `open_target_flags_are_mutually_exclusive`).
        let two = OpenFlags {
            standalone: true,
            desktop: true,
            devserver: None,
        };
        assert_eq!(
            route(two, Parentage::None, false, LiveInstances::default()),
            Err(RouteError::MultipleTargets)
        );
    }

    fn candidate(index: usize, pid: u32, root: &str, port: u16) -> DevserverCandidate {
        DevserverCandidate {
            instance_index: index,
            pid,
            library_root: PathBuf::from(root),
            port,
            version: format!("0.74.{index}"),
        }
    }

    #[test]
    fn devserver_selection_is_deterministic() {
        let a = candidate(0, 10, "/library/a", 8787);
        let b = candidate(1, 20, "/library/b", 9999);

        assert_eq!(
            select_devserver(&[], None, None, Path::new("/library/a")),
            Ok(None)
        );
        assert_eq!(
            select_devserver(std::slice::from_ref(&a), None, None, Path::new("/other"))
                .unwrap()
                .map(|candidate| candidate.port),
            Some(8787)
        );
        assert_eq!(
            select_devserver(&[a.clone(), b.clone()], None, None, Path::new("/library/b"))
                .unwrap()
                .map(|candidate| candidate.port),
            Some(9999)
        );
        assert_eq!(
            select_devserver(&[a.clone(), b.clone()], None, None, Path::new("/other")),
            Err(DevserverSelectionError::Ambiguous)
        );
        // Parentage is stronger than CHAN_HOME: this preserves "the current
        // devserver" even if two live processes share one library root.
        assert_eq!(
            select_devserver(
                &[a.clone(), b.clone()],
                None,
                Some(10),
                Path::new("/library/b")
            )
            .unwrap()
            .map(|candidate| candidate.port),
            Some(8787)
        );
        assert_eq!(
            select_devserver(
                &[a.clone(), b.clone()],
                Some(DevserverSelector::Port(9999)),
                None,
                Path::new("/library/a"),
            )
            .unwrap()
            .map(|candidate| candidate.port),
            Some(9999)
        );
        assert_eq!(
            select_devserver(
                &[a, b],
                Some(DevserverSelector::Port(7777)),
                None,
                Path::new("/library/a"),
            ),
            Err(DevserverSelectionError::NotFound { port: 7777 })
        );
    }

    #[test]
    fn parentage_refuses_when_the_parent_is_not_discovered() {
        let a = candidate(0, 10, "/library/a", 8787);
        let b = candidate(1, 20, "/library/b", 9999);

        // A matching parent pid still selects, even as the sole candidate.
        assert_eq!(
            select_devserver(
                std::slice::from_ref(&a),
                None,
                Some(10),
                Path::new("/other")
            )
            .unwrap()
            .map(|candidate| candidate.port),
            Some(8787)
        );
        // The spawning devserver is invisible to discovery: adopting the sole
        // survivor would mount the workspace on the wrong instance, so
        // selection refuses. (No-parent sole-candidate adoption is pinned by
        // `devserver_selection_is_deterministic`.)
        assert_eq!(
            select_devserver(
                std::slice::from_ref(&a),
                None,
                Some(99),
                Path::new("/other")
            ),
            Err(DevserverSelectionError::ParentNotFound { pid: 99 })
        );
        // Same with several candidates: parentage never falls through to the
        // CHAN_HOME preference when it names a pid that is not live.
        assert_eq!(
            select_devserver(&[a, b], None, Some(99), Path::new("/library/b")),
            Err(DevserverSelectionError::ParentNotFound { pid: 99 })
        );
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

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_parentage_times_out_on_a_wedged_holder() {
        use tokio::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hung.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        // Accept the connection but never reply: the probe must elapse to None
        // rather than hang `chan open`.
        let _accept = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                // Hold the stream open without writing a response.
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                drop(stream);
            }
        });
        let start = std::time::Instant::now();
        let p = probe_parentage(&sock, std::time::Duration::from_millis(150)).await;
        assert_eq!(p, Parentage::None);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "probe must give up promptly, took {:?}",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_parentage_none_when_no_listener() {
        // A path with no listener: the connect fails fast -> None, no hang.
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("nope.sock");
        assert_eq!(
            probe_parentage(&sock, std::time::Duration::from_secs(3)).await,
            Parentage::None
        );
    }

    #[test]
    fn open_target_flags_are_mutually_exclusive() {
        // clap's `conflicts_with_all` rejects any two target flags at parse
        // time; one alone parses.
        assert!(Cli::try_parse_from(["chan", "open", ".", "--standalone"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "open", ".", "--desktop"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "open", ".", "--devserver"]).is_ok());
        assert!(Cli::try_parse_from(["chan", "open", ".", "--standalone", "--desktop"]).is_err());
        assert!(Cli::try_parse_from(["chan", "open", ".", "--standalone", "--devserver"]).is_err());
        assert!(Cli::try_parse_from(["chan", "open", ".", "--desktop", "--devserver"]).is_err());
    }

    #[test]
    fn open_devserver_selector_parses_bare_port_and_url() {
        let parse = |args: &[&str]| match Cli::try_parse_from(args).unwrap().command {
            Command::Open {
                target, devserver, ..
            } => (target, devserver),
            other => panic!("expected open, got {other:?}"),
        };

        assert_eq!(parse(&["chan", "open", "."]), (Some(".".into()), None));
        // require_equals keeps the following positional path out of the
        // optional flag value.
        assert_eq!(
            parse(&["chan", "open", "--devserver", "."]),
            (Some(".".into()), Some(DevserverSelector::Auto))
        );
        assert_eq!(
            parse(&["chan", "open", ".", "--devserver=9999"]),
            (Some(".".into()), Some(DevserverSelector::Port(9999)))
        );
        assert_eq!(
            parse(&[
                "chan",
                "open",
                ".",
                "--devserver=http://127.0.0.1:9000/?t=secret",
            ]),
            (Some(".".into()), Some(DevserverSelector::Port(9000)))
        );
        assert!(Cli::try_parse_from(["chan", "open", ".", "--devserver=0"]).is_err());
        assert!(Cli::try_parse_from(["chan", "open", ".", "--devserver=not-a-url"]).is_err());
    }

    #[test]
    fn control_socket_for_pid_matches_only_that_pid() {
        let dir = tempfile::TempDir::new().unwrap();
        // A different pid's control socket and an unrelated chan socket are
        // both ignored.
        std::fs::write(dir.path().join("chan-control-999-abcd.sock"), b"").unwrap();
        std::fs::write(dir.path().join("chan-mcp-4242-abcd.sock"), b"").unwrap();
        assert_eq!(control_socket_for_pid_in(dir.path(), 4242, true), None);
        // The matching pid's socket is found.
        let want = dir.path().join("chan-control-4242-ef01.sock");
        std::fs::write(&want, b"").unwrap();
        assert_eq!(
            control_socket_for_pid_in(dir.path(), 4242, true),
            Some(want)
        );
    }

    #[tokio::test]
    async fn control_socket_for_pid_searches_candidate_dirs() {
        let first = tempfile::TempDir::new().unwrap();
        let second = tempfile::TempDir::new().unwrap();
        let want = second.path().join("chan-control-4242-ef01.sock");
        std::fs::write(&want, b"").unwrap();
        assert_eq!(
            control_socket_for_pid_in_dirs([first.path(), second.path()], 4242, true).await,
            Some(want)
        );
    }

    #[test]
    fn stable_control_socket_name_excludes_pid_shaped_names() {
        // A devserver's stable socket (`chan-control-s<16 hex>`, no pid) is a
        // probe candidate; a pid-named socket or an unrelated file is not.
        assert!(stable_control_socket_name(
            "chan-control-s89abcdef01234567.sock",
            true
        ));
        assert!(!stable_control_socket_name(
            "chan-control-4242-ef01.sock",
            true
        ));
        assert!(!stable_control_socket_name("chan-mcp-4242-ef01.sock", true));
        // Only the exact 16-lowercase-hex hash shape qualifies.
        assert!(!stable_control_socket_name(
            "chan-control-s89abcdef.sock",
            true
        ));
        assert!(!stable_control_socket_name(
            "chan-control-s89ABCDEF01234567.sock",
            true
        ));
        // The `.sock` suffix is required only on unix (a Windows pipe name
        // has none).
        assert!(!stable_control_socket_name(
            "chan-control-s89abcdef01234567",
            true
        ));
        assert!(stable_control_socket_name(
            "chan-control-s89abcdef01234567",
            false
        ));
    }

    /// A stub control server on a unix socket that answers every `Identify`
    /// with the given pid, standing in for a devserver tenant socket.
    #[cfg(unix)]
    fn spawn_identify_stub(socket: &std::path::Path, pid: u32) -> tokio::task::JoinHandle<()> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let listener = tokio::net::UnixListener::bind(socket).expect("bind stub socket");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                let _ = BufReader::new(read).read_line(&mut line).await;
                let identity = chan_shell::Identity {
                    kind: chan_shell::ServeKind::Devserver,
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    pid,
                    workspace_root: None,
                    metadata_key: None,
                };
                let reply = chan_shell::ControlResponse::Ok {
                    message: serde_json::to_string(&identity).expect("identity json"),
                };
                let mut out = serde_json::to_vec(&reply).expect("response json");
                out.push(b'\n');
                let _ = write.write_all(&out).await;
            }
        })
    }

    #[cfg(unix)]
    fn empty_workspace_search_result(root: &Path, key: &str) -> WorkspaceSearchResult {
        WorkspaceSearchResult {
            workspace: chan_workspace::WorkspaceSearchIdentity {
                root: root.display().to_string(),
                metadata_key: key.into(),
                display_name: root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            },
            readiness: chan_workspace::WorkspaceReadiness::default(),
            search: chan_workspace::WorkspaceSearchStatus {
                requested: false,
                ready: true,
                mode: chan_workspace::EffectiveSearchMode::NotRun,
            },
            content_hits: Vec::new(),
            entity_matches: Vec::new(),
            nodes: Vec::new(),
            relationships: Vec::new(),
            traversal: chan_workspace::EffectiveWorkspaceTraversal {
                depth: 0,
                direction: chan_workspace::WorkspaceTraversalDirection::Auto,
                relationship_kinds: Vec::new(),
                spine_forced: false,
                profiles: Vec::new(),
            },
            truncation: chan_workspace::WorkspaceSearchTruncation::default(),
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }

    #[test]
    fn workspace_status_skips_derived_snapshots_during_recovery() {
        let config = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        let lib = Library::open_at(config.path().join("config.toml")).expect("library");
        let known = lib.register_workspace(root.path()).expect("register");
        let workspace = lib.open_workspace(root.path()).expect("open");
        workspace.request_recovery(chan_workspace::RecoveryAction::FullRebuild);

        let output =
            workspace_status_output(&workspace, Some(known.metadata_key)).expect("status output");
        let json = serde_json::to_value(&output).expect("status JSON");

        assert_eq!(json["readiness"]["state"], "recovering");
        assert!(json.get("index").is_none(), "{json}");
        assert!(json.get("graph").is_none(), "{json}");
        assert!(json.get("report").is_none(), "{json}");
    }

    #[cfg(unix)]
    fn spawn_workspace_search_stub(
        socket: &std::path::Path,
        identity: chan_shell::Identity,
        result: WorkspaceSearchResult,
    ) -> tokio::task::JoinHandle<()> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let listener = tokio::net::UnixListener::bind(socket).expect("bind workspace stub");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                if BufReader::new(read).read_line(&mut line).await.is_err() {
                    continue;
                }
                let response = match serde_json::from_str::<chan_shell::ControlRequest>(&line) {
                    Ok(chan_shell::ControlRequest::Identify) => chan_shell::ControlResponse::Ok {
                        message: serde_json::to_string(&identity).expect("identity json"),
                    },
                    Ok(chan_shell::ControlRequest::WorkspaceSearch { .. }) => {
                        chan_shell::ControlResponse::Ok {
                            message: serde_json::to_string(&result).expect("search json"),
                        }
                    }
                    _ => chan_shell::ControlResponse::Error {
                        message: "unsupported request".into(),
                    },
                };
                let mut out = serde_json::to_vec(&response).expect("response json");
                out.push(b'\n');
                let _ = write.write_all(&out).await;
            }
        })
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_socket_for_pid_probes_stable_named_sockets() {
        // A devserver's stable-named socket carries no pid, so discovery must
        // resolve it through the Identify round-trip. The wrong pid must NOT
        // resolve to it (a stale lock record's holder is genuinely gone).
        let dir = tempfile::TempDir::new().unwrap();
        let stable = dir.path().join("chan-control-s00aa11bb22cc33dd.sock");
        let stub = spawn_identify_stub(&stable, 4242);
        assert_eq!(
            control_socket_for_pid_in_dirs([dir.path()], 4242, true).await,
            Some(stable.clone())
        );
        assert_eq!(
            control_socket_for_pid_in_dirs([dir.path()], 7777, true).await,
            None
        );
        stub.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_socket_discovery_matches_root_and_metadata_key() {
        let dir = tempfile::Builder::new()
            .prefix("chan-ws-")
            .tempdir_in("/tmp")
            .unwrap();
        let root_a = tempfile::TempDir::new().unwrap();
        let root_b = tempfile::TempDir::new().unwrap();
        let pid = std::process::id();
        let result = empty_workspace_search_result(root_b.path(), "key-b");
        let wrong = dir.path().join(format!("chan-control-{pid}-a.sock"));
        let right = dir.path().join(format!("chan-control-{pid}-b.sock"));
        let wrong_stub = spawn_workspace_search_stub(
            &wrong,
            chan_shell::Identity {
                kind: chan_shell::ServeKind::Devserver,
                version: env!("CARGO_PKG_VERSION").into(),
                pid,
                workspace_root: Some(root_a.path().to_path_buf()),
                metadata_key: Some("key-a".into()),
            },
            result.clone(),
        );
        let right_stub = spawn_workspace_search_stub(
            &right,
            chan_shell::Identity {
                kind: chan_shell::ServeKind::Devserver,
                version: env!("CARGO_PKG_VERSION").into(),
                pid,
                workspace_root: Some(root_b.path().to_path_buf()),
                metadata_key: Some("key-b".into()),
            },
            result,
        );

        let selected =
            control_socket_for_workspace_in_dirs([dir.path()], pid, root_b.path(), "key-b", true)
                .await;
        assert_eq!(selected, Some(right));
        wrong_stub.abort();
        right_stub.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_search_retries_over_the_exact_tenant_when_direct_open_loses_the_lock() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let config_path = config.path().join("config.toml");
        let holder_library = Library::open_at(config_path.clone()).unwrap();
        let known = holder_library.register_workspace(root.path()).unwrap();
        let held = holder_library.open_workspace(root.path()).unwrap();
        held.write_text("note.md", "# Note\n").unwrap();
        held.index_file("note.md").unwrap();

        let request = WorkspaceSearchRequest {
            domains: vec![chan_workspace::WorkspaceSearchDomain::File],
            ..WorkspaceSearchRequest::default()
        };
        let expected = held.workspace_search(&request).unwrap();
        let socket_dir = tempfile::Builder::new()
            .prefix("chan-ws-")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = socket_dir.path().join(format!(
            "chan-control-{}-workspace.sock",
            std::process::id()
        ));
        let stub = spawn_workspace_search_stub(
            &socket,
            chan_shell::Identity {
                kind: chan_shell::ServeKind::Devserver,
                version: env!("CARGO_PKG_VERSION").into(),
                pid: std::process::id(),
                workspace_root: Some(known.root_path.clone()),
                metadata_key: Some(known.metadata_key.clone()),
            },
            expected.clone(),
        );

        // A distinct Library observes the root as free-by-this-pid, then its
        // direct open returns WorkspaceAlreadyOpen. The retry must identify
        // and query the exact live tenant instead of opening sidecars.
        let querying_library = Library::open_at(config_path).unwrap();
        let dirs = [socket_dir.path().to_path_buf()];
        let actual =
            execute_workspace_search_with_dirs(&querying_library, &known, &request, Some(&dirs))
                .await
                .unwrap();
        assert_eq!(actual, expected);
        stub.abort();
    }

    // Selects workspaces by the path string a user typed. On Windows
    // canonicalization returns a `\\?\` verbatim path, so the typed form and
    // the registered key are different strings for the same directory and the
    // selection reports errors. chan publishes no standalone Windows CLI, so
    // this contract is not one the project ships there.
    #[cfg(unix)]
    #[test]
    fn workspace_selection_preserves_explicit_order_and_deduplicates_by_key() {
        let config = tempfile::TempDir::new().unwrap();
        let roots = tempfile::TempDir::new().unwrap();
        let alpha = roots.path().join("alpha");
        let beta = roots.path().join("beta");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&beta).unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let alpha_known = lib.register_workspace(&alpha).unwrap();
        let beta_known = lib.register_workspace(&beta).unwrap();
        let targets = WorkspaceTargets {
            workspaces: vec![
                beta_known.metadata_key.clone(),
                alpha.display().to_string(),
                beta.display().to_string(),
            ],
            all_workspaces: false,
        };

        let (selected, errors) = select_workspace_targets(&lib, &targets).unwrap();

        assert!(errors.is_empty());
        assert_eq!(
            selected
                .iter()
                .map(|workspace| workspace.metadata_key.as_str())
                .collect::<Vec<_>>(),
            vec![
                beta_known.metadata_key.as_str(),
                alpha_known.metadata_key.as_str()
            ]
        );
    }

    #[test]
    fn workspace_selection_reports_ambiguous_display_names() {
        let config = tempfile::TempDir::new().unwrap();
        let roots = tempfile::TempDir::new().unwrap();
        let alpha = roots.path().join("alpha");
        let beta = roots.path().join("beta");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&beta).unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        let alpha_known = lib
            .register_workspace_with_name(&alpha, Some("Shared".into()))
            .unwrap();
        let beta_known = lib
            .register_workspace_with_name(&beta, Some("shared".into()))
            .unwrap();
        let targets = WorkspaceTargets {
            workspaces: vec!["SHARED".into()],
            all_workspaces: false,
        };

        let (selected, errors) = select_workspace_targets(&lib, &targets).unwrap();

        assert!(selected.is_empty());
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "ambiguous_workspace");
        assert!(errors[0]
            .message
            .contains(&alpha_known.root_path.display().to_string()));
        assert!(errors[0]
            .message
            .contains(&beta_known.root_path.display().to_string()));
    }

    #[test]
    fn control_socket_name_matches_pid_and_ext() {
        // A unix `.sock` file matches whether or not the suffix is required.
        assert!(control_socket_name_matches(
            "chan-control-1234-ab.sock",
            1234,
            true
        ));
        assert!(control_socket_name_matches(
            "chan-control-1234-ab.sock",
            1234,
            false
        ));
        // A Windows named pipe (no extension) matches only when the suffix
        // is not required.
        assert!(control_socket_name_matches(
            "chan-control-1234-deadbeef",
            1234,
            false
        ));
        assert!(!control_socket_name_matches(
            "chan-control-1234-deadbeef",
            1234,
            true
        ));
        // A different pid and an unrelated name never match.
        assert!(!control_socket_name_matches(
            "chan-control-9999-ab.sock",
            1234,
            true
        ));
        assert!(!control_socket_name_matches(
            "something-else.sock",
            1234,
            true
        ));
    }

    #[test]
    fn ps_by_column_never_emits_bare_served() {
        // Served-but-unprobed and free both render `-` (STATE carries the
        // served/free distinction).
        assert_eq!(ps_by_column(true, None), "-");
        assert_eq!(ps_by_column(false, None), "-");
        // A resolved kind renders its label.
        assert_eq!(ps_by_column(true, Some(ServedBy::Devserver)), "devserver");
        assert_eq!(ps_by_column(true, Some(ServedBy::Standalone)), "standalone");
        assert_eq!(ps_by_column(true, Some(ServedBy::Desktop)), "desktop");
    }

    /// The payload is the one recorded from the owner's live devserver in
    /// `gitignore-write-strands-the-workspace-in-recovering`: generation 14,
    /// completed 12, reconcile owed, nothing active. Parsing the real evidence
    /// rather than a hand-built value is deliberate -- it pins the wire shape
    /// this command reads, so a server-side rename fails here instead of
    /// quietly rendering `-` forever.
    #[test]
    fn ps_columns_render_the_stall_fingerprint() {
        let readiness: WorkspaceReadiness = serde_json::from_str(
            r#"{"state":"recovering","generation":14,"completed_generation":12,
                "required_action":"reconcile","active_generation":null,
                "pending_generation":14}"#,
        )
        .expect("the recorded live readiness payload must parse");
        let readiness = Some(readiness);

        assert_eq!(ps_ready_column(readiness), "recovering");
        // generation/completed: the lag that says a pass is owed.
        assert_eq!(ps_gen_column(readiness), "14/12");
        // pending->active. `14->none` IS the stall: work owed, nobody running
        // it. This is the column the whole item exists to put on screen.
        assert_eq!(ps_pass_column(readiness), "14->none");
        assert_eq!(ps_action_column(readiness), "reconcile");
    }

    /// A recovery that HAS a claimant must not render like the stall. Same
    /// state word, same readiness variant, different PASS column -- which is
    /// the distinction v0.87.0 shipped and that this command must not collapse.
    #[test]
    fn ps_pass_column_distinguishes_a_claimed_pass_from_a_stalled_one() {
        let claimed: WorkspaceReadiness = serde_json::from_str(
            r#"{"state":"recovering","generation":14,"completed_generation":12,
                "required_action":"reconcile","active_generation":14,
                "pending_generation":null}"#,
        )
        .unwrap();
        assert_eq!(ps_ready_column(Some(claimed)), "recovering");
        assert_eq!(ps_pass_column(Some(claimed)), "none->14");

        let stalled: WorkspaceReadiness = serde_json::from_str(
            r#"{"state":"recovering","generation":14,"completed_generation":12,
                "required_action":"reconcile","active_generation":null,
                "pending_generation":14}"#,
        )
        .unwrap();
        assert_ne!(ps_pass_column(Some(claimed)), ps_pass_column(Some(stalled)));
    }

    /// A healthy workspace, from a payload captured off a live devserver.
    #[test]
    fn ps_columns_render_a_ready_workspace() {
        let readiness: WorkspaceReadiness =
            serde_json::from_str(r#"{"state":"ready","generation":3}"#).unwrap();
        let readiness = Some(readiness);
        assert_eq!(ps_ready_column(readiness), "ready");
        assert_eq!(ps_gen_column(readiness), "3");
        // No pass in flight and none owed.
        assert_eq!(ps_pass_column(readiness), "-");
        assert_eq!(ps_action_column(readiness), "-");
    }

    /// The v0.85.0 `cs terminal list` ruling, applied here: an unreported
    /// value renders `-`, never `0`. A tenant with no indexer reporting a
    /// queue depth of `0` would read as the healthy one, which is the exact
    /// misreading this command exists to prevent.
    #[test]
    fn ps_absent_indexer_renders_dash_not_zero() {
        // `/api/health` reports `indexer: null` on a tenant with no indexer.
        let health: PsHealth = serde_json::from_str(r#"{"indexer":null}"#).unwrap();
        assert!(health.indexer.is_none());
        assert_eq!(ps_indexer_column(health.indexer.as_ref()), "-");
        assert_eq!(ps_queue_column(health.indexer.as_ref()), "-");

        // A real indexer reporting an empty queue renders `0`, and the two
        // must not be the same string.
        let live: PsHealth = serde_json::from_str(
            r#"{"indexer":{"status":"idle","queue_depth":0,"last_event_at":null,
                "last_settled_at":1786352908,"coalesced_rebuild":false}}"#,
        )
        .unwrap();
        assert_eq!(ps_indexer_column(live.indexer.as_ref()), "idle");
        assert_eq!(ps_queue_column(live.indexer.as_ref()), "0");
        assert_ne!(
            ps_queue_column(health.indexer.as_ref()),
            ps_queue_column(live.indexer.as_ref())
        );
    }

    /// Every column degrades to `-` when nothing answered, so an unreachable
    /// devserver costs the operator the activity columns and not the command.
    #[test]
    fn ps_columns_render_absent_when_nothing_answered() {
        assert_eq!(ps_ready_column(None), "-");
        assert_eq!(ps_gen_column(None), "-");
        assert_eq!(ps_pass_column(None), "-");
        assert_eq!(ps_action_column(None), "-");
        assert_eq!(ps_indexer_column(None), "-");
        assert_eq!(ps_queue_column(None), "-");
    }

    /// `/api/index/status` flattens `IndexStatus` alongside `readiness`, so
    /// the reader must pick readiness out of a payload carrying other keys
    /// rather than expecting a bare object. Payload captured live.
    #[test]
    fn ps_index_status_reads_readiness_out_of_the_flattened_payload() {
        let status: PsIndexStatus = serde_json::from_str(
            r#"{"state":"idle","indexed_docs":3,"indexed_vectors":0,
                "model":"BAAI/bge-small-en-v1.5",
                "readiness":{"state":"ready","generation":1}}"#,
        )
        .unwrap();
        assert_eq!(ps_ready_column(status.readiness), "ready");
        assert_eq!(ps_gen_column(status.readiness), "1");
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

    #[test]
    fn absolutize_serve_root_is_always_absolute() {
        // The bug: a relative root (`.`) handed to the desktop made it
        // open "/". The invariant that fixes it is simply that the serve
        // root is always absolute before the handoff -- regardless of
        // whether the dir exists yet.
        assert!(absolutize_serve_root(PathBuf::from(".")).is_absolute());
        assert!(absolutize_serve_root(PathBuf::from("does/not/exist/yet")).is_absolute());
        assert!(absolutize_serve_root(PathBuf::from("/tmp")).is_absolute());
        // A relative path lands under the cwd, not the filesystem root.
        let cwd = std::env::current_dir().unwrap();
        assert!(absolutize_serve_root(PathBuf::from("sub/dir")).starts_with(&cwd));
    }

    fn ipv4(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn ipv6(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    /// The fallback filter must (1) parse the static tokei directive
    /// without panicking at startup for every verbosity level and (2)
    /// actually carry the tokei cap. A malformed directive would panic
    /// the binary on launch; a dropped directive would let the spam back.
    #[test]
    fn fallback_filter_caps_tokei_for_every_level() {
        for level in ["warn", "info", "debug", "trace"] {
            let rendered = fallback_filter(level).to_string();
            assert!(
                rendered.contains("tokei"),
                "level {level} filter dropped the tokei directive: {rendered}"
            );
        }
    }

    #[test]
    fn default_is_v4_loopback() {
        let addr = resolve_listen_addr(None, false, false, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("127.0.0.1"), 8787));
    }

    #[test]
    fn ipv4_flag_with_no_host_gives_v4_loopback() {
        let addr = resolve_listen_addr(None, true, false, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("127.0.0.1"), 8787));
    }

    #[test]
    fn ipv6_flag_with_no_host_gives_v6_loopback() {
        let addr = resolve_listen_addr(None, false, true, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv6("::1"), 8787));
    }

    #[test]
    fn explicit_host_overrides_default() {
        let addr = resolve_listen_addr(Some(ipv4("0.0.0.0")), false, false, 9000).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("0.0.0.0"), 9000));
    }

    #[test]
    fn ipv4_flag_rejects_v6_host() {
        let err = resolve_listen_addr(Some(ipv6("::1")), true, false, 8787).unwrap_err();
        assert!(err.to_string().contains("-4"));
    }

    #[test]
    fn ipv6_flag_rejects_v4_host() {
        let err = resolve_listen_addr(Some(ipv4("127.0.0.1")), false, true, 8787).unwrap_err();
        assert!(err.to_string().contains("-6"));
    }

    #[test]
    fn ipv4_flag_accepts_matching_v4_host() {
        let addr = resolve_listen_addr(Some(ipv4("0.0.0.0")), true, false, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("0.0.0.0"), 8787));
    }

    #[test]
    fn ipv6_flag_accepts_matching_v6_host() {
        let addr = resolve_listen_addr(Some(ipv6("::")), false, true, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv6("::"), 8787));
    }

    #[test]
    fn devserver_tunnel_url_has_no_domain_default() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver"]);
        match cli.command {
            Command::Devserver {
                tunnel_url,
                tunnel_token,
                ..
            } => assert_tunnel_defaults_off(&tunnel_url, &tunnel_token),
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

    /// The `listen` resolution matrix: tunnel mode flips the default to no-bind
    /// UNLESS running under systemd notify; `CHAN_DEVSERVER_LISTEN` overrides;
    /// tunnel-off + LISTEN=0 is the unreachable-devserver hard error.
    #[test]
    fn devserver_listen_matrix() {
        // Tunnel off: default binds; explicit 1 binds; explicit 0 errors
        // (nothing reachable). systemd notify makes no difference off-tunnel.
        assert!(resolve_devserver_listen(false, false, None).unwrap());
        assert!(resolve_devserver_listen(false, true, None).unwrap());
        assert!(resolve_devserver_listen(false, false, Some(true)).unwrap());
        assert!(resolve_devserver_listen(false, false, Some(false)).is_err());
        // Tunnel on, NOT under systemd: default does NOT bind locally; explicit 0
        // also doesn't; explicit 1 binds the local listener alongside the tunnel.
        assert!(!resolve_devserver_listen(true, false, None).unwrap());
        assert!(!resolve_devserver_listen(true, false, Some(false)).unwrap());
        assert!(resolve_devserver_listen(true, false, Some(true)).unwrap());
        // Tunnel on, UNDER systemd notify: default binds the loopback management
        // API so the `--stop` / `--force` terminal drain can reach it; explicit
        // 0 still opts out.
        assert!(resolve_devserver_listen(true, true, None).unwrap());
        assert!(!resolve_devserver_listen(true, true, Some(false)).unwrap());
    }

    /// `CHAN_DEVSERVER_LISTEN` is a tri-state: unset/empty ⇒ default, `"0"` ⇒
    /// off, any other non-empty value ⇒ on.
    #[test]
    fn devserver_listen_override_parse() {
        assert_eq!(parse_listen_override(""), None);
        assert_eq!(parse_listen_override("0"), Some(false));
        assert_eq!(parse_listen_override("1"), Some(true));
        // Any non-empty, non-"0" value is truthy (mirrors CHAN_NO_DESKTOP_HANDOFF).
        assert_eq!(parse_listen_override("yes"), Some(true));
    }

    /// The port default matrix: an explicit `--port` always wins; a LISTENING
    /// tunnel-mode devserver defaults to 0 (OS-assigned, so systemd restarts
    /// never collide on a fixed port); everything else keeps the shared 8787.
    #[test]
    fn devserver_port_defaults_by_mode() {
        // Explicit wins everywhere, tunnel mode included.
        assert_eq!(resolve_devserver_port(Some(9000), true, true), 9000);
        assert_eq!(resolve_devserver_port(Some(9000), false, true), 9000);
        assert_eq!(resolve_devserver_port(Some(DEFAULT_PORT), true, true), 8787);
        // Tunnel + listen (systemd notify / CHAN_DEVSERVER_LISTEN=1): the OS
        // assigns the port.
        assert_eq!(resolve_devserver_port(None, true, true), 0);
        // Tunnel without a listener: nothing binds; the addr keeps the shared
        // default for the discovery/window-record report, as before.
        assert_eq!(resolve_devserver_port(None, true, false), DEFAULT_PORT);
        // Non-tunnel keeps the shared default the `chan open` handoff and the
        // serve-path collision hint rely on.
        assert_eq!(resolve_devserver_port(None, false, true), DEFAULT_PORT);
    }

    /// A rotation MUST re-emit the locked marker line -- it is the desktop
    /// control terminal's only distribution channel -- and the `/?t=` URL
    /// when the serve address is known. Red mutation: drop either line
    /// from `rotated_token_output`.
    #[test]
    fn rotated_token_output_reemits_marker_and_url() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let out = rotated_token_output(Some(addr), "tok-new");
        assert!(out.contains("http://127.0.0.1:8787/?t=tok-new"), "{out}");
        assert!(out.contains("CHAN_DEVSERVER_TOKEN=tok-new"), "{out}");
        // Address unknown: the marker line still goes out.
        let out = rotated_token_output(None, "tok-2");
        assert!(!out.contains("listening"), "{out}");
        assert!(out.contains("CHAN_DEVSERVER_TOKEN=tok-2"), "{out}");
    }

    /// `--rotate-token` parses and sits in the exclusive action group.
    #[test]
    fn devserver_rotate_token_flag_parses() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver", "--rotate-token"]);
        match cli.command {
            Command::Devserver { rotate_token, .. } => assert!(rotate_token),
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
        assert!(
            Cli::try_parse_from(["chan", "devserver", "--rotate-token", "--stop"]).is_err(),
            "action verbs are mutually exclusive"
        );
    }

    /// The action verbs parse onto their flags, and clap's `action` group makes
    /// them mutually exclusive.
    #[test]
    fn devserver_action_group_parse() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver", "--service=systemd", "--stop"]);
        match cli.command {
            Command::Devserver {
                service,
                stop,
                restart,
                ..
            } => {
                assert_eq!(service, ServiceKind::Systemd);
                assert!(stop);
                assert!(!restart);
            }
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
        let cli = Cli::parse_from(["chan", "devserver", "--service=systemd", "--restart"]);
        match cli.command {
            Command::Devserver {
                service,
                stop,
                restart,
                ..
            } => {
                assert_eq!(service, ServiceKind::Systemd);
                assert!(restart);
                assert!(!stop);
            }
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
        // At most one action verb may be supplied (clap `group = "action"`).
        assert!(Cli::try_parse_from([
            "chan",
            "devserver",
            "--service=systemd",
            "--stop",
            "--restart"
        ])
        .is_err());
        assert!(Cli::try_parse_from([
            "chan",
            "devserver",
            "--service=systemd",
            "--start",
            "--join"
        ])
        .is_err());
    }

    /// `--service` parses to an enum: absent OR a bare `--service` (no value)
    /// resolve to `Auto` (the per-OS default), `=auto`/`=none` and each explicit
    /// backend parse by name. A bare `--service` immediately before an action
    /// flag (`--service --join`) still resolves to `Auto` and parses the verb.
    #[test]
    fn devserver_service_kind_parse() {
        let _env = test_env::ChanTestEnv::new();
        let kind = |args: &[&str]| match Cli::parse_from(args).command {
            Command::Devserver { service, .. } => service,
            other => panic!("expected Command::Devserver, got {other:?}"),
        };
        // Absent, a bare `--service`, and `=auto` all resolve to the auto default.
        assert_eq!(kind(&["chan", "devserver"]), ServiceKind::Auto);
        assert_eq!(kind(&["chan", "devserver", "--service"]), ServiceKind::Auto);
        assert_eq!(
            kind(&["chan", "devserver", "--service", "auto"]),
            ServiceKind::Auto
        );
        assert_eq!(
            kind(&["chan", "devserver", "--service", "none"]),
            ServiceKind::None
        );
        assert_eq!(
            kind(&["chan", "devserver", "--service", "chan"]),
            ServiceKind::Chan
        );
        assert_eq!(
            kind(&["chan", "devserver", "--service", "systemd"]),
            ServiceKind::Systemd
        );
        assert_eq!(
            kind(&["chan", "devserver", "--service", "launchd"]),
            ServiceKind::Launchd
        );
        // The space form `--service --join`: `--service` takes no value (the next
        // token is a flag), so it resolves to Auto and `--join` still parses.
        match Cli::parse_from(["chan", "devserver", "--service", "--join"]).command {
            Command::Devserver { service, join, .. } => {
                assert_eq!(service, ServiceKind::Auto);
                assert!(join);
            }
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
        match Cli::parse_from([
            "chan",
            "devserver",
            "--service=systemd",
            "--status",
            "--force",
        ])
        .command
        {
            Command::Devserver { status, force, .. } => {
                assert!(status);
                assert!(force);
            }
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
    }

    /// Every cell of the `(--service, action)` validity matrix resolves to the
    /// documented plan or errors: `none` runs bare and rejects all verbs,
    /// `chan` starts in the background and accepts every verb, and
    /// systemd/launchd require a verb.
    #[test]
    fn devserver_plan_validity_matrix() {
        use DevAction::*;
        use ServiceKind::{Chan, Launchd, Systemd};

        assert_eq!(
            plan_devserver(ServiceKind::None, Option::None),
            Ok(DevPlan::Foreground(ServiceKind::None))
        );
        assert_eq!(
            plan_devserver(Chan, Option::None),
            Ok(DevPlan::ChanVerb(Start))
        );

        // `none` (foreground) rejects every action verb.
        for a in [Start, Stop, Restart, Status, Join] {
            assert!(
                plan_devserver(ServiceKind::None, Some(a)).is_err(),
                "none + {a:?} should error"
            );
        }

        // `chan` starts/manages the portable background daemon.
        for a in [Start, Stop, Restart, Status, Join] {
            assert_eq!(plan_devserver(Chan, Some(a)), Ok(DevPlan::ChanVerb(a)));
        }

        // systemd/launchd require an explicit verb and accept all five.
        for kind in [Systemd, Launchd] {
            assert!(
                plan_devserver(kind, Option::None).is_err(),
                "{kind:?} with no action should error"
            );
            for a in [Start, Stop, Restart, Status, Join] {
                assert_eq!(
                    plan_devserver(kind, Some(a)),
                    Ok(DevPlan::Supervised(kind, a))
                );
            }
        }
    }

    /// `--service=auto` resolves per-OS: an action verb picks the OS supervisor
    /// (systemd/launchd/chan), no action verb runs the foreground server on
    /// every OS, and the Linux systemd pick is gated on systemd actually being
    /// the init.
    #[test]
    fn resolve_auto_matrix() {
        use ServiceKind::{Chan, Launchd, Systemd};

        // No action verb: always plain foreground.
        assert_eq!(resolve_auto("linux", false), Ok(ServiceKind::None));
        assert_eq!(resolve_auto("macos", false), Ok(ServiceKind::None));
        assert_eq!(resolve_auto("plan9", false), Ok(ServiceKind::None));
        assert_eq!(resolve_auto("windows", false), Ok(ServiceKind::None));

        // An action verb selects the OS supervisor.
        assert_eq!(resolve_auto("linux", true), Ok(Systemd));
        assert_eq!(resolve_auto("macos", true), Ok(Launchd));
        assert_eq!(resolve_auto("windows", true), Ok(Chan));

        // An unrecognized OS has no manager for an action verb.
        let err = resolve_auto("plan9", true).unwrap_err();
        assert!(err.contains("could not auto-detect a service backend"));
        assert!(err.contains("plan9"));
        assert!(err.contains("--service=chan"));

        // The Linux systemd pick is confirmed only when systemd is the init.
        assert!(require_systemd_for_auto(true).is_ok());
        let missing = require_systemd_for_auto(false).unwrap_err();
        assert!(missing.contains("systemd is not available"));
        assert!(missing.contains("/run/systemd/system"));
        assert!(missing.contains("--service=chan"));
    }

    /// `selected_devserver_action` collapses the five action bools to at most one
    /// verb (clap's group makes the flags mutually exclusive).
    #[test]
    fn devserver_selected_action() {
        assert_eq!(
            selected_devserver_action(false, false, false, false, false),
            None
        );
        assert_eq!(
            selected_devserver_action(true, false, false, false, false),
            Some(DevAction::Start)
        );
        assert_eq!(
            selected_devserver_action(false, true, false, false, false),
            Some(DevAction::Stop)
        );
        assert_eq!(
            selected_devserver_action(false, false, true, false, false),
            Some(DevAction::Restart)
        );
        assert_eq!(
            selected_devserver_action(false, false, false, true, false),
            Some(DevAction::Status)
        );
        assert_eq!(
            selected_devserver_action(false, false, false, false, true),
            Some(DevAction::Join)
        );
    }

    /// `--stop`/`--restart` address precedence: explicit flag > running
    /// persisted > default, applied per field so a flagless restart preserves
    /// the running address (the bug) while a single flag overrides just that
    /// field.
    #[test]
    fn resolve_devserver_addr_precedence() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        let sock = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert_eq!(
            resolve_devserver_addr(None, None, None),
            sock("127.0.0.1:8787")
        );
        assert_eq!(
            resolve_devserver_addr(None, None, Some(sock("0.0.0.0:9000"))),
            sock("0.0.0.0:9000")
        );
        assert_eq!(
            resolve_devserver_addr(Some(ip("1.2.3.4")), None, Some(sock("0.0.0.0:9000"))),
            sock("1.2.3.4:9000")
        );
        assert_eq!(
            resolve_devserver_addr(None, Some(5555), Some(sock("0.0.0.0:9000"))),
            sock("0.0.0.0:5555")
        );
        assert_eq!(
            resolve_devserver_addr(Some(ip("1.2.3.4")), Some(5555), None),
            sock("1.2.3.4:5555")
        );
    }

    /// The persisted-address parser handles both the systemd ExecStart line and
    /// the launchd plist `<string>` form, and fails closed when a flag is absent.
    #[test]
    fn devserver_addr_parses_from_persisted_forms() {
        assert_eq!(
            devserver_addr_from_persisted_args(
                "/usr/bin/chan devserver --bind=0.0.0.0 --port=9000"
            ),
            Some("0.0.0.0:9000".parse().unwrap())
        );
        assert_eq!(
            devserver_addr_from_persisted_args(
                "<string>--bind=192.168.1.5</string>\n<string>--port=8080</string>"
            ),
            Some("192.168.1.5:8080".parse().unwrap())
        );
        assert_eq!(
            devserver_addr_from_persisted_args("/usr/bin/chan devserver --bind=0.0.0.0"),
            None
        );
    }

    /// `--status` command extraction: the systemd ExecStart value and the
    /// launchd ProgramArguments joined (with plist `<string>` values unescaped).
    #[test]
    fn status_command_extracts_per_backend() {
        let unit = "[Service]\nExecStart=/usr/bin/chan devserver --bind=0.0.0.0 --port=9000\nRestart=on-failure\n";
        assert_eq!(
            systemd_execstart_line(unit).as_deref(),
            Some("/usr/bin/chan devserver --bind=0.0.0.0 --port=9000")
        );
        let plist = "<array>\n  <string>/usr/bin/chan</string>\n  <string>devserver</string>\n  <string>--bind=0.0.0.0</string>\n  <string>--port=9000</string>\n</array>";
        assert_eq!(
            launchd_program_arguments(plist).as_deref(),
            Some("/usr/bin/chan devserver --bind=0.0.0.0 --port=9000")
        );
        let escaped = "<array><string>/a&amp;b/chan</string><string>devserver</string></array>";
        assert_eq!(
            launchd_program_arguments(escaped).as_deref(),
            Some("/a&b/chan devserver")
        );
    }

    /// The systemd unit template carries WatchdogSec= so a seized-but-
    /// alive devserver fails systemd's liveness check and restarts
    /// (with the devserver's WATCHDOG=1 pings keeping a healthy one
    /// alive). Paired with the packaged unit test below.
    #[test]
    fn systemd_unit_template_sets_watchdog() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let unit = devserver_systemd_unit(Path::new("/usr/bin/chan"), addr, None, None);
        assert!(
            unit.contains("WatchdogSec=30\n"),
            "unit template must pin WatchdogSec=30: {unit}"
        );
        assert!(
            unit.contains("TimeoutStartSec=10min\n"),
            "unit must outlive the bounded startup restore: {unit}"
        );
        assert!(
            unit.contains("Type=notify"),
            "watchdog needs notify: {unit}"
        );
    }

    #[test]
    fn foreign_devserver_systemd_unit_is_refused_without_overwrite() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let foreign = "[Service]\nExecStart=/usr/bin/custom-devserver\n";
        std::fs::write(&path, foreign).expect("seed foreign unit");
        let desired = chan_systemd::DevserverUnit::new(
            "/usr/bin/chan devserver --bind=127.0.0.1 --port=8787",
        );

        let error = write_rendered_devserver_unit(&path, &desired, false)
            .expect_err("foreign unit refused");
        let message = error.to_string();
        assert!(message.contains("foreign"), "{message}");
        assert!(message.contains(&path.display().to_string()), "{message}");
        assert!(
            message.contains("move") || message.contains("remove"),
            "{message}"
        );
        assert_eq!(
            std::fs::read_to_string(path).expect("foreign unit remains"),
            foreign
        );
    }

    #[test]
    fn chan_own_unit_is_not_refused_when_the_exe_name_is_unrecognized() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let desired =
            devserver_systemd_unit_spec(Path::new("/opt/Editor.AppImage"), addr, None, None);
        std::fs::write(&path, desired.render()).expect("seed the unit chan itself wrote");

        let update = write_rendered_devserver_unit(&path, &desired, false)
            .expect("chan must recognize the unit it just wrote");
        assert!(!update.changed, "identical unit must be a no-op");
    }

    #[derive(Default)]
    struct FakeDevserverSystemdControl {
        commands: Vec<Vec<String>>,
        fail_command: Option<usize>,
        active: bool,
        waits: Vec<Duration>,
    }

    impl DevserverSystemdControl for FakeDevserverSystemdControl {
        async fn command(&mut self, args: &[&str]) -> Result<()> {
            self.commands
                .push(args.iter().map(|arg| (*arg).to_string()).collect());
            if self.fail_command == Some(self.commands.len()) {
                anyhow::bail!("injected systemctl failure");
            }
            Ok(())
        }

        async fn wait_active(&mut self, timeout: Duration) -> bool {
            self.waits.push(timeout);
            self.active
        }
    }

    fn systemd_commands(control: &FakeDevserverSystemdControl) -> Vec<String> {
        control.commands.iter().map(|args| args.join(" ")).collect()
    }

    #[tokio::test]
    async fn force_teardown_stops_the_unit_when_the_drain_fails() {
        let mut control = FakeDevserverSystemdControl {
            active: true,
            ..Default::default()
        };
        let still_running = force_teardown_before_restart(Err("timed out".into()), &mut control)
            .await
            .expect("teardown");
        assert!(!still_running, "a failed drain must leave the unit stopped");
        assert_eq!(
            systemd_commands(&control),
            ["stop chan-devserver.service"],
            "stop must precede the fresh activation so the released store \
             cannot resurrect the sessions"
        );
    }

    #[tokio::test]
    async fn force_teardown_keeps_the_preserved_path_on_a_confirmed_drain() {
        let mut control = FakeDevserverSystemdControl {
            active: true,
            ..Default::default()
        };
        let still_running = force_teardown_before_restart(Ok(()), &mut control)
            .await
            .expect("teardown");
        assert!(still_running);
        assert!(
            systemd_commands(&control).is_empty(),
            "a confirmed drain needs no extra stop"
        );
    }

    #[tokio::test]
    async fn stop_proceeds_past_a_failed_drain() {
        let mut control = FakeDevserverSystemdControl {
            active: true,
            ..Default::default()
        };
        stop_unit_after_drain(Some(Err("connect refused".into())), true, &mut control)
            .await
            .expect("stop");
        assert_eq!(
            systemd_commands(&control),
            ["stop chan-devserver.service"],
            "a failed drain must not block the stop"
        );
    }

    #[tokio::test]
    async fn known_legacy_devserver_systemd_unit_migrates_idempotently() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let desired = chan_systemd::DevserverUnit::new(
            "/usr/bin/chan devserver --bind=127.0.0.1 --port=8787",
        );
        let rendered = desired.render();
        let legacy = rendered.replace("TimeoutStartSec=10min\n", "");
        std::fs::write(&path, &legacy).expect("seed legacy unit");

        let update =
            write_rendered_devserver_unit(&path, &desired, false).expect("stage migration");
        assert!(update.changed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), rendered);
        let mut control = FakeDevserverSystemdControl {
            active: true,
            ..Default::default()
        };
        activate_devserver_unit(&update, true, true, &mut control)
            .await
            .expect("activate migrated unit");
        assert_eq!(
            systemd_commands(&control),
            [
                "daemon-reload",
                "enable chan-devserver.service",
                "restart chan-devserver.service",
            ]
        );
        assert_eq!(control.waits, [DEVSERVER_SYSTEMD_START_TIMEOUT]);

        let repeat =
            write_rendered_devserver_unit(&path, &desired, false).expect("classify current unit");
        assert!(!repeat.changed);
        let mut repeat_control = FakeDevserverSystemdControl {
            active: true,
            ..Default::default()
        };
        activate_devserver_unit(&repeat, true, true, &mut repeat_control)
            .await
            .expect("repeat activation");
        assert_eq!(
            systemd_commands(&repeat_control),
            [
                "enable chan-devserver.service",
                "restart chan-devserver.service",
            ]
        );
    }

    #[tokio::test]
    async fn failed_devserver_systemd_restart_restores_legacy_unit() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let desired = chan_systemd::DevserverUnit::new(
            "/usr/bin/chan devserver --bind=127.0.0.1 --port=8787",
        );
        let legacy = desired.render().replace("TimeoutStartSec=10min\n", "");
        std::fs::write(&path, &legacy).expect("seed legacy unit");
        let update =
            write_rendered_devserver_unit(&path, &desired, false).expect("stage migration");
        let mut control = FakeDevserverSystemdControl {
            fail_command: Some(3),
            active: true,
            ..Default::default()
        };

        let error = activate_devserver_unit(&update, true, true, &mut control)
            .await
            .expect_err("restart failure rolls back");
        assert!(error.to_string().contains("restored"), "{error:#}");
        assert!(
            error
                .to_string()
                .contains("live terminal PTYs restore from the systemd fd store"),
            "{error:#}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        assert_eq!(
            systemd_commands(&control),
            [
                "daemon-reload",
                "enable chan-devserver.service",
                "restart chan-devserver.service",
                "daemon-reload",
                "restart chan-devserver.service",
            ]
        );
    }

    #[tokio::test]
    async fn failed_devserver_systemd_migration_after_restart_reports_preserved_terminals() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let desired = chan_systemd::DevserverUnit::new(
            "/usr/bin/chan devserver --bind=127.0.0.1 --port=8787",
        );
        let legacy = desired.render().replace("TimeoutStartSec=10min\n", "");
        std::fs::write(&path, &legacy).expect("seed legacy unit");
        let update =
            write_rendered_devserver_unit(&path, &desired, false).expect("stage migration");
        let mut control = FakeDevserverSystemdControl {
            active: false,
            ..Default::default()
        };

        let error = activate_devserver_unit(&update, true, true, &mut control)
            .await
            .expect_err("readiness failure rolls back");
        let message = format!("{error:#}");
        assert!(
            message.contains("live terminal PTYs restore from the systemd fd store"),
            "{message}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        assert_eq!(
            systemd_commands(&control),
            [
                "daemon-reload",
                "enable chan-devserver.service",
                "restart chan-devserver.service",
                "daemon-reload",
                "restart chan-devserver.service",
            ]
        );
    }

    #[tokio::test]
    async fn failed_devserver_systemd_reload_restores_without_bounce() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let desired = chan_systemd::DevserverUnit::new(
            "/usr/bin/chan devserver --bind=127.0.0.1 --port=8787",
        );
        let legacy = desired.render().replace("TimeoutStartSec=10min\n", "");
        std::fs::write(&path, &legacy).expect("seed legacy unit");
        let update =
            write_rendered_devserver_unit(&path, &desired, false).expect("stage migration");
        let mut control = FakeDevserverSystemdControl {
            fail_command: Some(1),
            active: true,
            ..Default::default()
        };

        activate_devserver_unit(&update, true, true, &mut control)
            .await
            .expect_err("daemon-reload failure rolls back");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        assert_eq!(
            systemd_commands(&control),
            ["daemon-reload", "daemon-reload"]
        );
    }

    /// The distro-packaged unit (packaging/distros/shared) mirrors the
    /// CLI-written template; both must carry the watchdog line.
    #[test]
    fn packaged_systemd_unit_sets_watchdog() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packaging/distros/shared/chan-devserver.service"
        );
        let unit = std::fs::read_to_string(path).expect("packaged unit readable");
        assert!(
            unit.contains("WatchdogSec=30"),
            "packaged unit must pin WatchdogSec=30: {unit}"
        );
    }

    #[cfg(unix)]
    fn normalized_devserver_systemd_unit(unit: &str) -> String {
        unit.lines()
            // A shell template may prefix a line with a conditional expansion,
            // for an environment line that only some configurations carry.
            // Environment content is already outside the contract, so strip the
            // prefix before deciding what the line is; a line that is nothing
            // but an expansion normalizes to empty and drops out below.
            .map(|line| match line.strip_prefix("${") {
                Some(rest) => rest.split_once('}').map_or(line, |(_, tail)| tail),
                None => line,
            })
            .filter(|line| !line.is_empty())
            .filter(|line| !line.starts_with('#'))
            .filter(|line| !line.starts_with("Environment="))
            .map(|line| {
                if line.starts_with("ExecStart=") {
                    "ExecStart=<runtime>"
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[cfg(unix)]
    fn sdme_devserver_systemd_unit(script: &str) -> &str {
        let heredoc = script
            .split_once("cat > \"$UNIT\" <<EOF\n")
            .expect("sdme provision script contains the unit heredoc")
            .1;
        heredoc
            .split_once("\nEOF\n")
            .expect("sdme provision unit heredoc is terminated")
            .0
    }

    /// The runtime renderer is the canonical unit contract. Package and sdme
    /// variants may substitute environment and ExecStart values, but every
    /// supervision directive and its ordering must stay identical.
    // Parses an sdme provision script for a systemd unit heredoc, splitting on
    // `<<EOF\n`. Both systemd and the sdme provisioner are Linux-only, and a
    // Windows checkout gives the script CRLF endings, so the split finds
    // nothing and the parse helper panics.
    #[cfg(unix)]
    #[test]
    fn devserver_systemd_unit_sources_match_normalized() {
        let runtime = devserver_systemd_unit(
            Path::new("/usr/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            None,
        );
        let packaged = include_str!("../../../packaging/distros/shared/chan-devserver.service");
        let provision = include_str!("../../../packaging/sdme/chan-devserver-provision.sh");
        let expected = normalized_devserver_systemd_unit(&runtime);

        assert_eq!(
            normalized_devserver_systemd_unit(packaged),
            expected,
            "packaged unit diverged from the typed runtime contract"
        );
        assert_eq!(
            normalized_devserver_systemd_unit(sdme_devserver_systemd_unit(provision)),
            expected,
            "sdme unit diverged from the typed runtime contract"
        );
    }

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

    /// Both supervisor renderers must start the resolved CLI: the first argument
    /// is an executable whose basename is `chan`, and the subcommand is
    /// `devserver`.
    #[test]
    fn generated_supervisors_start_the_chan_cli() {
        // The Arch / deb / rpm layout: `chan-desktop` at `/usr/bin` with a
        // `chan` sibling.
        let exe = select_relaunchable_exe(&RelaunchCandidates {
            current_exe: Some(PathBuf::from("/usr/bin/chan-desktop")),
            sibling_chan: Some(PathBuf::from("/usr/bin/chan")),
            ..Default::default()
        })
        .expect("the packaged chan sibling resolves");
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();

        let unit = devserver_systemd_unit(&exe, addr, None, None);
        let systemd = systemd_execstart_line(&unit).expect("the unit has an ExecStart");
        let plist = devserver_launch_agent_plist(&exe, addr, Path::new("/tmp/devserver.log"), None);
        let launchd = launchd_program_arguments(&plist).expect("the plist has ProgramArguments");

        for (source, command) in [("systemd", &systemd), ("launchd", &launchd)] {
            let mut args = command.split_whitespace();
            let program = args.next().unwrap_or_default();
            assert_eq!(
                Path::new(program).file_name(),
                Some(std::ffi::OsStr::new("chan")),
                "{source} runs {program}, not the chan CLI"
            );
            assert_eq!(
                args.next(),
                Some("devserver"),
                "{source} command changed: {command}"
            );
        }
    }

    #[test]
    fn devserver_tunnel_url_accepts_explicit_endpoint() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from([
            "chan",
            "devserver",
            "--tunnel-url",
            "http://127.0.0.1:7777/v1/tunnel",
        ]);
        match cli.command {
            Command::Devserver { tunnel_url, .. } => {
                assert_eq!(
                    tunnel_url.as_deref(),
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
    fn workspace_group_uses_ls_and_rm() {
        // The registry verbs live under `chan workspace`, spelled `ls`
        // and `rm`.
        let cli = Cli::try_parse_from(["chan", "workspace", "ls", "--json"]).unwrap();
        match cli.command {
            Command::Workspace {
                action: WorkspaceAction::Ls { json },
            } => assert!(json),
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from(["chan", "workspace", "rm", "/tmp/workspace"]).unwrap();
        match cli.command {
            Command::Workspace {
                action: WorkspaceAction::Rm { path },
            } => assert_eq!(path, PathBuf::from("/tmp/workspace")),
            other => panic!("unexpected command: {other:?}"),
        }
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
            ["chan", "index"].as_slice(),
            ["chan", "search"].as_slice(),
            ["chan", "metadata"].as_slice(),
            ["chan", "contacts"].as_slice(),
        ] {
            assert!(
                Cli::try_parse_from(argv).is_err(),
                "flat `{}` must not parse as a top-level command",
                argv[1],
            );
        }
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
    fn served_by_json_labels_are_stable() {
        // The `chan ps --json` `served_by` strings are a machine contract.
        assert_eq!(
            serde_json::to_value(ServedBy::Standalone).unwrap(),
            "standalone"
        );
        assert_eq!(serde_json::to_value(ServedBy::Desktop).unwrap(), "desktop");
        assert_eq!(
            serde_json::to_value(ServedBy::Devserver).unwrap(),
            "devserver"
        );
        assert_eq!(ServedBy::Devserver.label(), "devserver");
    }

    #[test]
    fn embedding_model_registry_json_uses_default_key() {
        let body = serde_json::to_value(chan_workspace::index::config::embedding_models()).unwrap();
        let first = &body.as_array().unwrap()[0];
        assert_eq!(first["id"], "BAAI/bge-small-en-v1.5");
        assert_eq!(first["default"], true);
        assert_eq!(first["dim"], 384);
        assert!(first.get("is_default").is_none());
    }

    #[test]
    fn config_split_assignment_accepts_equals_form() {
        let (k, v) = split_assignment("editor.theme=dark", None).unwrap();
        assert_eq!(k, "editor.theme");
        assert_eq!(v, "dark");
    }

    #[test]
    fn config_split_assignment_accepts_two_args() {
        let (k, v) = split_assignment("editor.theme", Some("dark")).unwrap();
        assert_eq!(k, "editor.theme");
        assert_eq!(v, "dark");
    }

    #[test]
    fn config_split_assignment_rejects_empty_value() {
        // `chan config set editor.theme=` is the typo-with-trailing-`=`
        // form. We must refuse it so a bad invocation never wipes a
        // preference to "".
        let err = split_assignment("editor.theme=", None).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));

        let err = split_assignment("editor.theme", Some("")).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn config_split_assignment_demands_a_value() {
        let err = split_assignment("editor.theme", None).unwrap_err();
        assert!(err.to_string().contains("missing value"));
    }

    #[test]
    fn config_read_then_write_round_trips_theme() {
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.theme", "dark").unwrap();
        assert_eq!(prefs.theme, ThemeChoice::Dark);
        let server = ServerConfig::default();
        let v = read_config_key(&prefs, &server, "editor.theme").unwrap();
        assert_eq!(v, serde_json::json!("dark"));
    }

    #[test]
    fn config_pane_width_round_trips_u32() {
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.pane_widths.search", "320").unwrap();
        assert_eq!(prefs.pane_widths.search, 320);
        let server = ServerConfig::default();
        let v = read_config_key(&prefs, &server, "editor.pane_widths.search").unwrap();
        assert_eq!(v, serde_json::json!(320));
    }

    #[test]
    fn config_server_paths_round_trip() {
        let editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        write_server_config_key(&mut server, "server.attachments_dir", "media/2026").unwrap();
        assert_eq!(server.attachments_dir, "media/2026");
        assert_eq!(
            read_config_key(&editor, &server, "server.attachments_dir").unwrap(),
            serde_json::json!("media/2026")
        );
    }

    #[test]
    fn config_search_aggression_round_trips() {
        let editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        write_server_config_key(&mut server, "server.search.aggression", "aggressive").unwrap();
        assert_eq!(server.search.aggression, SearchAggression::Aggressive);
        assert_eq!(
            read_config_key(&editor, &server, "server.search.aggression").unwrap(),
            serde_json::json!("aggressive")
        );
        let err =
            write_server_config_key(&mut server, "server.search.aggression", "turbo").unwrap_err();
        assert!(err
            .to_string()
            .contains("expected conservative|balanced|aggressive"));
    }

    #[test]
    fn config_server_paths_reject_empty_values() {
        let mut server = ServerConfig::default();
        let err = write_server_config_key(&mut server, "server.attachments_dir", "").unwrap_err();
        assert!(err.to_string().contains("non-empty"));
    }

    #[test]
    fn config_write_rejects_bad_theme_value() {
        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.theme", "neon").unwrap_err();
        assert!(err.to_string().contains("system|light|dark"));
    }

    #[test]
    fn config_line_spacing_accepts_canonical_tokens() {
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.line_spacing", "standard").unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Standard);
        write_pref_key(&mut prefs, "editor.line_spacing", "compact").unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Compact);
    }

    #[test]
    fn config_line_spacing_accepts_legacy_tight_alias() {
        // Older CLI scripts and muscle memory may still pass
        // `tight`; treat it as `compact` rather than erroring so
        // `chan config set` doesn't break those callers. The read
        // path normalizes the value back to `compact` (see
        // `line_spacing_label`).
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.line_spacing", "tight").unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Compact);
        assert_eq!(line_spacing_label(prefs.line_spacing), "compact");
    }

    #[test]
    fn config_line_spacing_rejects_unknown_value() {
        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.line_spacing", "sparse").unwrap_err();
        assert!(err.to_string().contains("standard|compact"));
    }

    #[test]
    fn config_line_spacing_label_round_trips() {
        // Read path: `chan config get editor.line_spacing` echoes
        // the canonical lowercase token, not the legacy `tight`.
        assert_eq!(line_spacing_label(LineSpacing::Standard), "standard");
        assert_eq!(line_spacing_label(LineSpacing::Compact), "compact");
    }

    #[test]
    fn config_write_rejects_bad_pane_width_value() {
        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.pane_widths.search", "-1").unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("non-negative integer"),
            "expected validation error, got: {msg}"
        );
    }

    #[test]
    fn config_unknown_key_is_rejected() {
        let prefs = EditorPrefs::default();
        let server = ServerConfig::default();
        let err = read_config_key(&prefs, &server, "editor.nope").unwrap_err();
        assert!(err.to_string().contains("unknown key"));
        assert!(err.to_string().contains("server.terminal.secret_masking"));

        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.nope", "x").unwrap_err();
        assert!(err.to_string().contains("unknown key"));

        let mut server = ServerConfig::default();
        let err = write_server_config_key(&mut server, "server.nope", "x").unwrap_err();
        assert!(err.to_string().contains("unknown key"));
    }

    fn config_leaf_paths(value: &serde_json::Value) -> Vec<(String, serde_json::Value)> {
        fn walk(
            value: &serde_json::Value,
            prefix: &mut Vec<String>,
            leaves: &mut Vec<(String, serde_json::Value)>,
        ) {
            if let serde_json::Value::Object(fields) = value {
                for (name, value) in fields {
                    prefix.push(name.clone());
                    walk(value, prefix, leaves);
                    prefix.pop();
                }
            } else {
                leaves.push((prefix.join("."), value.clone()));
            }
        }

        let mut leaves = Vec::new();
        walk(value, &mut Vec::new(), &mut leaves);
        leaves
    }

    fn populated_config_for_coverage() -> (EditorPrefs, ServerConfig) {
        let mut shortcuts = std::collections::BTreeMap::new();
        shortcuts.insert(
            "workspace.open".into(),
            chan_server::ShortcutOverride {
                web: Some("Mod+O".into()),
                ..Default::default()
            },
        );
        let editor = EditorPrefs {
            editor_font_size: Some(20),
            terminal_colors: chan_server::TerminalColorPrefs {
                mode: chan_server::TerminalColorMode::Custom,
                custom: Some(chan_server::TerminalCustomColors {
                    background: "#112233".into(),
                    foreground: "#ddeeff".into(),
                    cursor: "#abcdef".into(),
                    contrast: chan_server::TerminalContrast::Auto,
                }),
            },
            hybrid_surface_themes: chan_server::HybridSurfaceThemes {
                editor: Some(chan_server::SurfaceThemeChoice::Dark),
                terminal: Some(chan_server::SurfaceThemeChoice::Light),
                browser: Some(chan_server::SurfaceThemeChoice::Dark),
                graph: Some(chan_server::SurfaceThemeChoice::Light),
                dashboard: Some(chan_server::SurfaceThemeChoice::Dark),
            },
            // Every palette leaf populated: an optional field left None
            // never reaches the dump and the coverage walk would skip it.
            graph_colors: chan_server::GraphColorPrefs {
                mode: chan_server::GraphColorMode::Custom,
                dark: Some(chan_server::GraphPalette {
                    doc: Some("#ff8a3d".into()),
                    source: Some("#4169e1".into()),
                    binary: Some("#5e5e62".into()),
                    img: Some("#b07dff".into()),
                    folder: Some("#8e8e93".into()),
                    tag: Some("#6cd07a".into()),
                    language: Some("#ff4db8".into()),
                    contact: Some("#e3b341".into()),
                }),
                light: Some(chan_server::GraphPalette {
                    doc: Some("#c25a1f".into()),
                    source: Some("#2851c4".into()),
                    binary: Some("#4e4e54".into()),
                    img: Some("#7a4cd8".into()),
                    folder: Some("#6c6c70".into()),
                    tag: Some("#2f9444".into()),
                    language: Some("#c71585".into()),
                    contact: Some("#9a6700".into()),
                }),
            },
            shortcuts,
            ..Default::default()
        };
        (editor, ServerConfig::default())
    }

    #[test]
    fn config_serialized_leafs_have_get_set_coverage() {
        let (editor, server) = populated_config_for_coverage();
        let dump = serde_json::to_value(ConfigOutput {
            editor: editor.clone(),
            server: server.clone(),
        })
        .unwrap();
        for (key, expected) in config_leaf_paths(&dump) {
            if key.starts_with("editor.shortcuts.") {
                continue;
            }
            let actual = read_config_key(&editor, &server, &key)
                .unwrap_or_else(|error| panic!("{key} is printed but not readable: {error}"));
            assert_eq!(actual, expected, "{key} read changed the serialized value");
            if key == "editor.cs_dismissed" {
                continue;
            }
            let raw = scalar_to_string(&expected);
            if key.starts_with("server.") {
                let mut updated = server.clone();
                write_server_config_key(&mut updated, &key, &raw)
                    .unwrap_or_else(|error| panic!("{key} is printed but not writable: {error}"));
            } else {
                let mut updated = editor.clone();
                write_pref_key(&mut updated, &key, &raw)
                    .unwrap_or_else(|error| panic!("{key} is printed but not writable: {error}"));
            }
        }

        assert_eq!(
            read_config_key(&editor, &server, "editor.shortcuts").unwrap(),
            dump["editor"]["shortcuts"]
        );
        let mut updated = editor.clone();
        let error = write_pref_key(&mut updated, "editor.shortcuts.workspace.open.web", "Mod+K")
            .unwrap_err();
        assert!(error.to_string().contains("collection"), "{error:#}");

        let mut updated = editor;
        let error = write_pref_key(&mut updated, "editor.cs_dismissed", "true").unwrap_err();
        assert!(error.to_string().contains("read-only"), "{error:#}");

        let mut updated = server;
        let error = write_server_config_key(
            &mut updated,
            "server.terminal.secret_mask_suffixes",
            "TOKEN",
        )
        .unwrap_err();
        assert!(error.to_string().contains("JSON string array"), "{error:#}");
    }

    #[test]
    fn config_schema_audit_rejects_an_unowned_serialized_leaf() {
        let (editor, server) = populated_config_for_coverage();
        let mut dump = serde_json::to_value(ConfigOutput { editor, server }).unwrap();
        dump["editor"]["future_leaf"] = serde_json::json!(true);
        let error = validate_config_dump(&dump).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("future_leaf"), "{message}");
        assert!(message.contains("no CLI policy"), "{message}");
    }

    #[test]
    fn config_terminal_alias_and_validation_are_typed() {
        let mut editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        write_server_config_key(&mut server, "terminal.secret_masking", "true").unwrap();
        assert!(server.terminal.secret_masking);
        assert_eq!(
            read_config_key(&editor, &server, "terminal.secret_masking").unwrap(),
            serde_json::json!(true)
        );

        let error =
            write_server_config_key(&mut server, "server.terminal.scrollback_mb", "9").unwrap_err();
        assert!(error.to_string().contains("10..=50"), "{error:#}");
        let error = write_server_config_key(&mut server, "server.terminal.secret_masking", "yes")
            .unwrap_err();
        assert!(error.to_string().contains("true|false"), "{error:#}");
        let error =
            write_server_config_key(&mut server, "server.terminal.session_cap", "0").unwrap_err();
        assert!(error.to_string().contains("greater than 0"), "{error:#}");
        let error = write_server_config_key(
            &mut server,
            "server.terminal.secret_mask_suffixes",
            "[\"TOKEN\",\"TOKEN\"]",
        )
        .unwrap_err();
        assert!(error.to_string().contains("duplicate"), "{error:#}");

        let error = write_pref_key(&mut editor, "editor.editor_font_size", "9").unwrap_err();
        assert!(error.to_string().contains("10..=32"), "{error:#}");
        let error = write_pref_key(
            &mut editor,
            "editor.terminal_colors.custom.background",
            "black",
        )
        .unwrap_err();
        assert!(error.to_string().contains("#rgb or #rrggbb"), "{error:#}");
    }

    #[test]
    fn config_graph_colors_set_from_default_materializes_the_subtree() {
        let mut editor = EditorPrefs::default();
        // The palette subtree does not exist in a default config; the
        // schema sample must carry enough of it for the write to land.
        write_pref_key(&mut editor, "editor.graph_colors.dark.doc", "#FF0000").unwrap();
        let dark = editor.graph_colors.dark.as_ref().unwrap();
        assert_eq!(dark.doc.as_deref(), Some("#ff0000"), "hex is normalized");
        assert_eq!(dark.source, None, "untouched hues stay absent");
        assert_eq!(
            editor.graph_colors.mode,
            chan_server::GraphColorMode::Standard
        );

        // The leaf reads back through the same key set the dump walks.
        let server = ServerConfig::default();
        let value = read_config_key(&editor, &server, "editor.graph_colors.dark.doc").unwrap();
        assert_eq!(value, serde_json::json!("#ff0000"));

        write_pref_key(&mut editor, "editor.graph_colors.mode", "custom").unwrap();
        assert_eq!(
            editor.graph_colors.mode,
            chan_server::GraphColorMode::Custom
        );
        let error = write_pref_key(&mut editor, "editor.graph_colors.mode", "bogus").unwrap_err();
        assert!(error.to_string().contains("standard|custom"), "{error:#}");
        let error =
            write_pref_key(&mut editor, "editor.graph_colors.light.tag", "chartreuse").unwrap_err();
        assert!(error.to_string().contains("#rgb or #rrggbb"), "{error:#}");
    }

    #[test]
    fn config_no_key_dump_validates_with_a_custom_graph_palette() {
        // `chan config get` with no key runs validate_config_dump on the
        // live path: a palette leaf without a CONFIG_KEYS row breaks the
        // command for every user, not only the suite.
        let (editor, server) = populated_config_for_coverage();
        assert!(editor.graph_colors.dark.is_some());
        let dump = serde_json::to_value(ConfigOutput {
            editor: editor.clone(),
            server: server.clone(),
        })
        .unwrap();
        validate_config_dump(&dump).unwrap();
        // The populated fixture must exercise every palette key: count
        // the leaves under graph_colors so a new hue row can't silently
        // go uncovered.
        let palette_leaves = config_leaf_paths(&dump)
            .into_iter()
            .filter(|(key, _)| key.starts_with("editor.graph_colors."))
            .count();
        assert_eq!(palette_leaves, 17, "mode + 8 hues x 2 modes");
    }

    #[test]
    fn config_secret_masking_false_and_true_persist_in_isolated_home() {
        let env = test_env::ChanTestEnv::new();
        assert!(!ServerConfig::default().terminal.secret_masking);

        cmd_config(ConfigAction::Set {
            key: "terminal.secret_masking".into(),
            value: Some("false".into()),
        })
        .unwrap();
        let path = env.home().join("server.toml");
        let saved = ServerConfig::load_from(&path).unwrap();
        assert!(!saved.terminal.secret_masking);

        cmd_config(ConfigAction::Set {
            key: "server.terminal.secret_masking".into(),
            value: Some("true".into()),
        })
        .unwrap();
        let saved = ServerConfig::load_from(&path).unwrap();
        assert!(saved.terminal.secret_masking);
    }

    #[tokio::test]
    async fn resolve_devserver_token_returns_first_available() {
        // The common case: the token is already on disk, so the first read wins
        // and no polling happens.
        let token =
            resolve_devserver_token(|| Some("tok_abc".to_string()), Duration::from_secs(5)).await;
        assert_eq!(token.as_deref(), Some("tok_abc"));
    }

    #[tokio::test]
    async fn resolve_devserver_token_polls_until_the_token_lands() {
        // The fresh `Type=simple` race: the unit is active but the service has
        // not persisted yet, so the first reads miss and a later one succeeds.
        let calls = std::cell::Cell::new(0u32);
        let token = resolve_devserver_token(
            || {
                let n = calls.get() + 1;
                calls.set(n);
                (n >= 3).then(|| "tok_late".to_string())
            },
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(token.as_deref(), Some("tok_late"));
        assert!(
            calls.get() >= 3,
            "expected polling, saw {} reads",
            calls.get()
        );
    }

    #[tokio::test]
    async fn resolve_devserver_token_gives_up_after_timeout() {
        // A token that never lands resolves to None at the deadline, which the
        // caller turns into a loud failure rather than supervising blind.
        let token = resolve_devserver_token(|| None, Duration::from_millis(150)).await;
        assert_eq!(token, None);
    }

    #[test]
    fn devserver_systemd_unit_enables_notify_and_fdstore() {
        let unit = devserver_systemd_unit(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            None,
            None,
        );
        assert!(unit.contains("Type=notify"));
        assert!(unit.contains("NotifyAccess=main"));
        assert!(unit.contains("FileDescriptorStoreMax=512"));
        assert!(unit.contains("KillMode=process"));
        assert!(
            unit.contains("ExecStart=/usr/local/bin/chan devserver --bind=127.0.0.1 --port=8799")
        );
        // Without CHAN_HOME the unit carries no Environment line (real ~/.chan).
        assert!(!unit.contains("Environment="));
    }

    #[test]
    fn devserver_systemd_unit_propagates_chan_home() {
        let unit = devserver_systemd_unit(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            Some("/tmp/iso home"),
            None,
        );
        // The service inherits the supervisor's CHAN_HOME (quoted for the space),
        // placed before ExecStart so systemd resolves it for the started process.
        assert!(unit.contains("Environment=\"CHAN_HOME=/tmp/iso home\"\n"));
        let env = unit.find("Environment=").unwrap();
        let exec = unit.find("ExecStart=").unwrap();
        assert!(env < exec);
    }

    #[test]
    fn devserver_systemd_unit_tunnel_carries_token_and_url() {
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://usr.chan.app/v1/tunnel".to_string(),
            pinned_bind: None,
            pinned_port: None,
            pinned_name: None,
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            Some(&tunnel),
        );
        // Unpinned tunnel mode dials the gateway via --tunnel-url with no
        // --bind/--port: the service resolves its tunnel-mode defaults
        // (loopback, OS-assigned port), so no default can fossilize here.
        assert!(unit.contains(
            "ExecStart=/home/dev/.local/bin/chan devserver \
             --tunnel-url=https://usr.chan.app/v1/tunnel\n"
        ));
        assert!(!unit.contains("--bind="));
        assert!(!unit.contains("--port="));
        // The PAT rides in an Environment= line (the unit is written 0600),
        // and the endpoint rides one too, so the terminals this service spawns
        // inherit it and can run their own `chan devserver` verbs.
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_abc123\"\n"));
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_URL=https://usr.chan.app/v1/tunnel\"\n"));
        // The systemd fdstore scaffold is unchanged from the non-tunnel unit.
        assert!(unit.contains("Type=notify"));
        assert!(unit.contains("NotifyAccess=main"));
        assert!(unit.contains("FileDescriptorStoreMax=512"));
    }

    #[test]
    fn devserver_systemd_unit_tunnel_pins_explicit_addr_flags() {
        // Pinned (explicit or preserved-explicit) address flags ride in the
        // ExecStart, so the tunnel service binds exactly there.
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://usr.chan.app/v1/tunnel".to_string(),
            pinned_bind: Some("0.0.0.0".parse().unwrap()),
            pinned_port: Some(9000),
            pinned_name: None,
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "0.0.0.0:9000".parse().unwrap(),
            None,
            Some(&tunnel),
        );
        assert!(unit.contains(
            "ExecStart=/home/dev/.local/bin/chan devserver --bind=0.0.0.0 \
             --port=9000 --tunnel-url=https://usr.chan.app/v1/tunnel\n"
        ));
        // Each field pins independently: a port-only pin keeps the bind
        // omitted (the service resolves the loopback default).
        let port_only = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://usr.chan.app/v1/tunnel".to_string(),
            pinned_bind: None,
            pinned_port: Some(9000),
            pinned_name: None,
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:9000".parse().unwrap(),
            None,
            Some(&port_only),
        );
        assert!(unit.contains(
            "ExecStart=/home/dev/.local/bin/chan devserver --port=9000 \
             --tunnel-url=https://usr.chan.app/v1/tunnel\n"
        ));
        assert!(!unit.contains("--bind="));
    }

    #[test]
    fn devserver_systemd_unit_tunnel_stacks_chan_home_and_token() {
        // CHAN_HOME (test isolation) and the token stack as two Environment lines,
        // both before ExecStart so systemd resolves them for the started process.
        let tunnel = SystemdTunnel {
            token: "chan_pat_xyz".to_string(),
            url: "https://example.test/v1/tunnel".to_string(),
            pinned_bind: None,
            pinned_port: None,
            pinned_name: None,
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            Some("/tmp/iso"),
            Some(&tunnel),
        );
        assert!(unit.contains("Environment=\"CHAN_HOME=/tmp/iso\"\n"));
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_xyz\"\n"));
        let token_env = unit.find("CHAN_TUNNEL_TOKEN").unwrap();
        let exec = unit.find("ExecStart=").unwrap();
        assert!(token_env < exec);
    }

    /// A systemd tunnel spec reduced to the fields a case is actually about:
    /// the token/endpoint the CLI supplied, the two mode flags, and the
    /// installed unit. Address and name pins keep their own tests.
    fn tunnel_spec_for(
        token: Option<&str>,
        url: Option<&str>,
        force: bool,
        no_tunnel: bool,
        unit: Option<&str>,
    ) -> Result<Option<SystemdTunnel>> {
        supervised_tunnel_spec(
            ServiceKind::Systemd,
            token.map(str::to_owned),
            url.map(str::to_owned),
            None,
            force,
            no_tunnel,
            None,
            None,
            unit,
        )
    }

    /// A tunnel unit as the supervisor writes one: the PAT and the endpoint in
    /// the 0600 environment, the endpoint also in the ExecStart the service
    /// dials, and one explicit port pin.
    const INSTALLED_TUNNEL_UNIT: &str = "Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_installed\"\n\
         Environment=\"CHAN_TUNNEL_URL=https://first-run.test/v1/tunnel\"\n\
         ExecStart=/home/dev/.local/bin/chan devserver --port=9000 \
         --tunnel-url=https://first-run.test/v1/tunnel\n";

    #[test]
    fn supervised_tunnel_spec_reuses_persisted_url_unless_forced() {
        // Nothing anywhere -> no tunnel spec (non-tunnel supervised restart).
        assert!(
            tunnel_spec_for(None, Some("https://cli.test"), false, false, None)
                .unwrap()
                .is_none()
        );
        // launchd never gets a tunnel spec (its tunnel mode is refused upstream).
        assert!(supervised_tunnel_spec(
            ServiceKind::Launchd,
            Some("chan_pat_a".into()),
            Some("https://cli.test".into()),
            None,
            false,
            false,
            None,
            None,
            None,
        )
        .unwrap()
        .is_none());
        // With a token, --force takes the CLI URL (a "refresh"); with no unit
        // and no flags there is nothing to pin.
        let spec = tunnel_spec_for(
            Some("chan_pat_a"),
            Some("https://cli.test"),
            true,
            false,
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.token, "chan_pat_a");
        assert_eq!(spec.url, "https://cli.test");
        assert_eq!(spec.pinned_bind, None);
        assert_eq!(spec.pinned_port, None);
        // A flagless restart reuses the persisted unit's URL and pins.
        let spec = tunnel_spec_for(
            Some("chan_pat_a"),
            Some("https://cli.test"),
            false,
            false,
            Some(INSTALLED_TUNNEL_UNIT),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.url, "https://first-run.test/v1/tunnel");
        assert_eq!(spec.pinned_bind, None);
        assert_eq!(spec.pinned_port, Some(9000));
        // --force refreshes the URL from the CLI but keeps the pins: the
        // `--port` help contract is omit = preserve, force or not.
        let spec = tunnel_spec_for(
            Some("chan_pat_a"),
            Some("https://cli.test"),
            true,
            false,
            Some(INSTALLED_TUNNEL_UNIT),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.url, "https://cli.test");
        assert_eq!(spec.pinned_port, Some(9000));
        // --force with no CLI endpoint still falls back to the unit's rather
        // than failing: "refresh" means prefer the CLI, not require it.
        let spec = tunnel_spec_for(
            Some("chan_pat_a"),
            None,
            true,
            false,
            Some(INSTALLED_TUNNEL_UNIT),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.url, "https://first-run.test/v1/tunnel");
        // An explicit CLI flag pins over anything persisted.
        let spec = supervised_tunnel_spec(
            ServiceKind::Systemd,
            Some("chan_pat_a".into()),
            Some("https://cli.test".into()),
            None,
            false,
            false,
            Some("0.0.0.0".parse().unwrap()),
            Some(9100),
            Some(INSTALLED_TUNNEL_UNIT),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.pinned_bind, Some("0.0.0.0".parse().unwrap()));
        assert_eq!(spec.pinned_port, Some(9100));
    }

    #[test]
    fn supervised_tunnel_spec_recovers_the_pat_from_the_installed_unit() {
        // The regression this guards: a `--restart` typed in a shell that
        // carries NEITHER the token nor the endpoint. The unit is the only
        // store for both, so the restart must come back as the same tunnel
        // registration -- not as a local devserver whose unit rewrite would
        // destroy the only copy of the PAT.
        let spec = tunnel_spec_for(None, None, false, false, Some(INSTALLED_TUNNEL_UNIT))
            .unwrap()
            .unwrap();
        assert_eq!(spec.token, "chan_pat_installed");
        assert_eq!(spec.url, "https://first-run.test/v1/tunnel");
        assert_eq!(spec.pinned_port, Some(9000));
        // An explicit token still wins: that is how a rotated PAT is installed.
        let spec = tunnel_spec_for(
            Some("chan_pat_rotated"),
            None,
            false,
            false,
            Some(INSTALLED_TUNNEL_UNIT),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.token, "chan_pat_rotated");
        // --force is about destructiveness and endpoint refresh; it must NOT
        // turn a restart into a silent tunnel teardown.
        let spec = tunnel_spec_for(None, None, true, false, Some(INSTALLED_TUNNEL_UNIT))
            .unwrap()
            .unwrap();
        assert_eq!(spec.token, "chan_pat_installed");
        // --no-tunnel is the deliberate way back to a local devserver, and it
        // overrides an explicit token as well as the persisted one.
        assert!(
            tunnel_spec_for(None, None, false, true, Some(INSTALLED_TUNNEL_UNIT))
                .unwrap()
                .is_none()
        );
        assert!(tunnel_spec_for(
            Some("chan_pat_a"),
            Some("https://cli.test"),
            false,
            true,
            Some(INSTALLED_TUNNEL_UNIT),
        )
        .unwrap()
        .is_none());
        // A non-tunnel unit stays non-tunnel: there is no token to recover.
        let local = "ExecStart=/usr/bin/chan devserver --bind=127.0.0.1 --port=8787\n";
        assert!(tunnel_spec_for(None, None, false, false, Some(local))
            .unwrap()
            .is_none());
    }

    #[test]
    fn supervised_tunnel_spec_errs_when_no_source_names_an_endpoint() {
        // A token with no endpoint from either source is the one case that
        // fails -- loudly, because the alternative is rewriting the unit
        // without the PAT it is the only store for.
        let no_url = "Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_installed\"\n\
                      ExecStart=/usr/bin/chan devserver --bind=127.0.0.1 --port=8787\n";
        // Matched rather than unwrap_err()'d: SystemdTunnel carries a PAT and
        // so implements no Debug, which is worth keeping.
        let Err(error) = tunnel_spec_for(None, None, false, false, Some(no_url)) else {
            panic!("a persisted token with no resolvable endpoint must fail");
        };
        assert_eq!(error.to_string(), MISSING_TUNNEL_URL);
        // The CLI can supply the endpoint the unit lacks.
        let spec = tunnel_spec_for(None, Some("https://cli.test"), false, false, Some(no_url))
            .unwrap()
            .unwrap();
        assert_eq!(spec.token, "chan_pat_installed");
        assert_eq!(spec.url, "https://cli.test");
        // And --no-tunnel converts that unit rather than erroring on it.
        assert!(tunnel_spec_for(None, None, false, true, Some(no_url))
            .unwrap()
            .is_none());
    }

    /// The whole unit an unpinned tunnel devserver installs, asserted as text
    /// rather than by `contains`, because this exact byte sequence is the
    /// contract: a `--restart` that renders something else classifies the
    /// installed unit as changed and rewrites it. Provisioning that writes a
    /// unit by hand has to match this to be left alone.
    #[test]
    fn devserver_systemd_unit_tunnel_renders_the_whole_unit() {
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://usr.chan.app/v1/tunnel".to_string(),
            pinned_bind: None,
            pinned_port: None,
            pinned_name: None,
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            Some(&tunnel),
        );
        assert_eq!(
            unit,
            "[Unit]\n\
             Description=chan devserver\n\
             After=network.target\n\
             \n\
             [Service]\n\
             Type=notify\n\
             NotifyAccess=main\n\
             FileDescriptorStoreMax=512\n\
             KillMode=process\n\
             Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_abc123\"\n\
             Environment=\"CHAN_TUNNEL_URL=https://usr.chan.app/v1/tunnel\"\n\
             ExecStart=/home/dev/.local/bin/chan devserver \
             --tunnel-url=https://usr.chan.app/v1/tunnel\n\
             TimeoutStartSec=10min\n\
             Restart=on-failure\n\
             WatchdogSec=30\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n"
        );
    }

    #[test]
    fn unsupervised_tunnel_still_demands_an_endpoint_up_front() {
        // Making the endpoint requirement lazy must not make it optional. The
        // foreground and `chan` backends persist no unit to recover one from,
        // so for them the refusal fires exactly where it always did.
        let Err(error) = build_devserver_tunnel(Some("chan_pat_a".into()), None, None) else {
            panic!("a token with no endpoint must fail on the unsupervised path");
        };
        assert_eq!(error.to_string(), MISSING_TUNNEL_URL);
        // No token is not tunnel mode, endpoint or not.
        assert!(build_devserver_tunnel(None, None, None).unwrap().is_none());
        assert!(
            build_devserver_tunnel(None, Some("https://cli.test".into()), None)
                .unwrap()
                .is_none()
        );
        // Token plus endpoint resolves as before.
        let tunnel = build_devserver_tunnel(
            Some("chan_pat_a".into()),
            Some("https://cli.test".into()),
            Some("office box"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(tunnel.tunnel_url, "https://cli.test");
        assert_eq!(tunnel.token, "chan_pat_a");
        assert_eq!(tunnel.name, "office box");
    }

    #[test]
    fn persisted_tunnel_readers_round_trip_a_rendered_unit() {
        // The read side against what the write side actually produces, so the
        // two cannot drift: every field a flagless restart depends on comes
        // back out of a rendered unit.
        let tunnel = SystemdTunnel {
            token: "chan_pat_round_trip".to_string(),
            url: "https://usr.chan.app/v1/tunnel".to_string(),
            pinned_bind: Some("0.0.0.0".parse().unwrap()),
            pinned_port: Some(9000),
            pinned_name: Some("office box".to_string()),
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "0.0.0.0:9000".parse().unwrap(),
            None,
            Some(&tunnel),
        );
        assert_eq!(
            persisted_tunnel_token(&unit),
            Some("chan_pat_round_trip".to_string())
        );
        assert_eq!(
            persisted_tunnel_url(&unit),
            Some("https://usr.chan.app/v1/tunnel".to_string())
        );
        assert_eq!(
            persisted_tunnel_pins(&unit),
            (Some("0.0.0.0".parse().unwrap()), Some(9000))
        );
        assert_eq!(persisted_tunnel_name(&unit), Some("office box".to_string()));
        // Feeding that unit back through the resolver with an empty CLI
        // reproduces the spec it was rendered from -- the restart round trip.
        let spec = tunnel_spec_for(None, None, false, false, Some(&unit))
            .unwrap()
            .unwrap();
        assert_eq!(spec.token, tunnel.token);
        assert_eq!(spec.url, tunnel.url);
        assert_eq!(spec.pinned_bind, tunnel.pinned_bind);
        assert_eq!(spec.pinned_port, tunnel.pinned_port);
        assert_eq!(spec.pinned_name, tunnel.pinned_name);
        // Re-rendering from the recovered spec is byte-identical, so a restart
        // that changes nothing leaves the unit (and its PAT) untouched.
        let rerendered = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "0.0.0.0:9000".parse().unwrap(),
            None,
            Some(&spec),
        );
        assert_eq!(rerendered, unit);
    }

    #[test]
    fn persisted_tunnel_url_falls_back_to_the_environment_copy() {
        // A unit provisioned with the endpoint only in the environment (no
        // ExecStart flag) is still a tunnel unit: its pins and name read, and
        // a flagless restart resolves the endpoint.
        let env_only = "Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_a\"\n\
                        Environment=\"CHAN_TUNNEL_URL=https://env.test/v1/tunnel\"\n\
                        Environment=\"CHAN_TUNNEL_DEVSERVER_NAME=env box\"\n\
                        ExecStart=/usr/bin/chan devserver --port=9100\n";
        assert_eq!(
            persisted_tunnel_url(env_only),
            Some("https://env.test/v1/tunnel".to_string())
        );
        assert_eq!(persisted_tunnel_pins(env_only), (None, Some(9100)));
        assert_eq!(persisted_tunnel_name(env_only), Some("env box".to_string()));
        // The ExecStart flag is what the service dials, so it wins when both
        // are present.
        let both = "Environment=\"CHAN_TUNNEL_URL=https://env.test/v1/tunnel\"\n\
                    ExecStart=/usr/bin/chan devserver --tunnel-url=https://exec.test/v1/tunnel\n";
        assert_eq!(
            persisted_tunnel_url(both),
            Some("https://exec.test/v1/tunnel".to_string())
        );
        // No endpoint anywhere: not a tunnel unit, so nothing pins.
        let local = "ExecStart=/usr/bin/chan devserver --bind=127.0.0.1 --port=8787\n";
        assert_eq!(persisted_tunnel_url(local), None);
    }

    #[test]
    fn persisted_tunnel_pins_only_read_tunnel_units() {
        // A tunnel unit's persisted --bind/--port ARE the explicitness record,
        // each field independently.
        let pinned = "ExecStart=/usr/bin/chan devserver --bind=0.0.0.0 --port=9000 \
                      --tunnel-url=https://t.test/v1/tunnel\n";
        assert_eq!(
            persisted_tunnel_pins(pinned),
            (Some("0.0.0.0".parse().unwrap()), Some(9000))
        );
        let port_only =
            "ExecStart=/usr/bin/chan devserver --port=9000 --tunnel-url=https://t.test/v1/tunnel\n";
        assert_eq!(persisted_tunnel_pins(port_only), (None, Some(9000)));
        let unpinned = "ExecStart=/usr/bin/chan devserver --tunnel-url=https://t.test/v1/tunnel\n";
        assert_eq!(persisted_tunnel_pins(unpinned), (None, None));
        // A NON-tunnel unit always persists its address; converting it to
        // tunnel mode must not carry that address over as a pin.
        let non_tunnel = "ExecStart=/usr/bin/chan devserver --bind=127.0.0.1 --port=8787\n";
        assert_eq!(persisted_tunnel_pins(non_tunnel), (None, None));
    }

    #[test]
    fn persisted_flag_value_reads_tunnel_url_from_execstart() {
        // The "reuse first-run URL" read: pull --tunnel-url back out of a unit's
        // ExecStart line the way a flagless --restart would.
        let unit = "ExecStart=/home/dev/.local/bin/chan devserver \
                    --tunnel-url=https://first-run.test/v1/tunnel\n";
        assert_eq!(
            persisted_flag_value(unit, "--tunnel-url="),
            Some("https://first-run.test/v1/tunnel")
        );
    }

    #[test]
    fn tunnel_devserver_name_resolves_explicit_then_hostname() {
        // Explicit wins and is trimmed; blank/whitespace falls back to the
        // hostname default, which is never empty.
        assert_eq!(
            resolve_tunnel_devserver_name(Some("  office box  ")),
            "office box"
        );
        let host_default = resolve_tunnel_devserver_name(None);
        assert!(!host_default.is_empty());
        assert_eq!(resolve_tunnel_devserver_name(Some("   ")), host_default);
    }

    #[test]
    fn tunnel_devserver_name_maps_control_chars_to_spaces() {
        // Interior control characters (newline would inject systemd
        // unit directives, ESC would corrupt renderers) become spaces,
        // and whitespace runs collapse.
        assert_eq!(
            resolve_tunnel_devserver_name(Some("office\nbox")),
            "office box"
        );
        assert_eq!(
            resolve_tunnel_devserver_name(Some("office\r\n\tbox")),
            "office box"
        );
        assert_eq!(
            resolve_tunnel_devserver_name(Some("a\u{1b}b")),
            "a b",
            "ANSI escape byte maps to a space"
        );
        // All-control input reads as blank: hostname default applies.
        let host_default = resolve_tunnel_devserver_name(None);
        assert_eq!(resolve_tunnel_devserver_name(Some("\n\t\r")), host_default);
        // Percent is not a control character; it survives untouched
        // (the systemd unit write site escapes it, not this layer).
        assert_eq!(resolve_tunnel_devserver_name(Some("box 50%")), "box 50%");
    }

    #[test]
    fn tunnel_devserver_name_caps_at_64_bytes_on_char_boundary() {
        let long = "x".repeat(80);
        assert_eq!(resolve_tunnel_devserver_name(Some(&long)), "x".repeat(64));
        // A multi-byte char straddling the cap is dropped whole, never split.
        let mut tricky = "x".repeat(63);
        tricky.push('é'); // 2 bytes: 63 + 2 > 64
        let resolved = resolve_tunnel_devserver_name(Some(&tricky));
        assert_eq!(resolved, "x".repeat(63));
    }

    #[test]
    fn devserver_systemd_unit_tunnel_pins_explicit_name() {
        // A pinned name rides in the unit environment (like the token), so
        // the service re-announces it on every restart. Quotes and
        // backslashes are stripped: systemd's Environment= quoting cannot
        // carry them raw.
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://usr.chan.app/v1/tunnel".to_string(),
            pinned_bind: None,
            pinned_port: None,
            pinned_name: Some("office \"box\"\\".to_string()),
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            Some(&tunnel),
        );
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_DEVSERVER_NAME=office box\"\n"));
        // A `%` writes as `%%` (systemd Environment= specifier
        // escaping), and reads back literal via persisted_tunnel_name:
        // the round trip a flagless --restart takes.
        let percent = SystemdTunnel {
            pinned_name: Some("box 50%".to_string()),
            ..tunnel
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            Some(&percent),
        );
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_DEVSERVER_NAME=box 50%%\"\n"));
        assert_eq!(persisted_tunnel_name(&unit), Some("box 50%".to_string()));
        // Unpinned name: no variable, the service resolves its hostname
        // default at runtime.
        let unnamed = SystemdTunnel {
            pinned_name: None,
            ..percent
        };
        let unit = devserver_systemd_unit(
            Path::new("/home/dev/.local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            Some(&unnamed),
        );
        assert!(!unit.contains("CHAN_TUNNEL_DEVSERVER_NAME"));
    }

    #[test]
    fn persisted_tunnel_name_reads_tunnel_units_only() {
        // The persisted name (spaces included) reads back up to the closing
        // quote, and only from a tunnel unit.
        let unit = "Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_a\"\n\
                    Environment=\"CHAN_TUNNEL_DEVSERVER_NAME=office box\"\n\
                    ExecStart=/usr/bin/chan devserver \
                    --tunnel-url=https://t.test/v1/tunnel\n";
        assert_eq!(persisted_tunnel_name(unit), Some("office box".to_string()));
        let nameless = "Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_a\"\n\
                        ExecStart=/usr/bin/chan devserver \
                        --tunnel-url=https://t.test/v1/tunnel\n";
        assert_eq!(persisted_tunnel_name(nameless), None);
        let non_tunnel = "Environment=\"CHAN_TUNNEL_DEVSERVER_NAME=office box\"\n\
                          ExecStart=/usr/bin/chan devserver --bind=127.0.0.1 --port=8787\n";
        assert_eq!(persisted_tunnel_name(non_tunnel), None);
    }

    #[test]
    fn supervised_tunnel_spec_pins_name_explicit_over_persisted() {
        let unit = "Environment=\"CHAN_TUNNEL_DEVSERVER_NAME=persisted name\"\n\
                    ExecStart=/usr/bin/chan devserver \
                    --tunnel-url=https://first-run.test/v1/tunnel\n";
        // A flagless restart carries the persisted name over.
        let spec = tunnel_spec_for(
            Some("chan_pat_a"),
            Some("https://cli.test"),
            false,
            false,
            Some(unit),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.pinned_name, Some("persisted name".to_string()));
        // An explicit flag (trimmed) pins over the persisted value.
        let spec = supervised_tunnel_spec(
            ServiceKind::Systemd,
            Some("chan_pat_a".into()),
            Some("https://cli.test".into()),
            Some("  new name  "),
            false,
            false,
            None,
            None,
            Some(unit),
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.pinned_name, Some("new name".to_string()));
        // No flag, no unit: nothing pins; the service resolves its
        // hostname default at runtime.
        let spec = tunnel_spec_for(
            Some("chan_pat_a"),
            Some("https://cli.test"),
            false,
            false,
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(spec.pinned_name, None);
    }

    #[test]
    fn devserver_name_flag_parses() {
        let _env = test_env::ChanTestEnv::new();
        let cli = Cli::parse_from(["chan", "devserver", "--tunnel-devserver-name", "office box"]);
        match cli.command {
            Command::Devserver {
                tunnel_devserver_name,
                ..
            } => assert_eq!(tunnel_devserver_name.as_deref(), Some("office box")),
            other => panic!("expected Command::Devserver, got {other:?}"),
        }
    }

    #[test]
    fn launch_agent_plist_carries_program_and_keys() {
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            Path::new("/Users/x/.chan/devserver/devserver.log"),
            None,
        );
        assert!(plist.contains("<string>app.chan.devserver</string>"));
        assert!(plist.contains("<string>/usr/local/bin/chan</string>"));
        assert!(plist.contains("<string>devserver</string>"));
        assert!(plist.contains("<string>--bind=127.0.0.1</string>"));
        assert!(plist.contains("<string>--port=8799</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<string>/Users/x/.chan/devserver/devserver.log</string>"));
        // Without CHAN_HOME there is no EnvironmentVariables block.
        assert!(!plist.contains("EnvironmentVariables"));
    }

    #[test]
    fn launch_agent_plist_propagates_chan_home() {
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            Path::new("/tmp/iso/.chan/devserver/devserver.log"),
            Some("/tmp/iso & home"),
        );
        assert!(plist.contains("<key>EnvironmentVariables</key>"));
        assert!(plist.contains("<key>CHAN_HOME</key>"));
        // The value is XML-escaped like every other plist string.
        assert!(plist.contains("<string>/tmp/iso &amp; home</string>"));
    }

    #[test]
    fn launch_agent_plist_escapes_xml_in_paths() {
        let plist = devserver_launch_agent_plist(
            Path::new("/opt/a & b/chan"),
            "127.0.0.1:1".parse().unwrap(),
            Path::new("/tmp/log"),
            None,
        );
        assert!(plist.contains("/opt/a &amp; b/chan"));
        assert!(!plist.contains("a & b/chan"));
    }

    #[test]
    fn launchd_print_running_reads_state() {
        // Tab-indented like real `launchctl print` output.
        assert!(launchd_print_running(
            "\tstate = running\n\tpid = 4321\n\tlast exit code = (never exited)\n"
        ));
        assert!(!launchd_print_running(
            "\tstate = not running\n\tlast exit code = (never exited)\n"
        ));
    }

    #[test]
    fn launchd_print_failed_only_on_nonzero_exit() {
        assert!(launchd_print_failed(
            "\tstate = not running\n\tlast exit code = 1\n"
        ));
        // A clean exit, a never-run service, and a running service are not failures.
        assert!(!launchd_print_failed(
            "\tstate = not running\n\tlast exit code = 0\n"
        ));
        assert!(!launchd_print_failed(
            "\tstate = not running\n\tlast exit code = (never exited)\n"
        ));
        assert!(!launchd_print_failed("\tstate = running\n\tpid = 5\n"));
    }
}
