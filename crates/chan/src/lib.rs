// chan: a terminal emulator and multiplexer plus a workspace manager.
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
// are grouped under `chan workspace`. `chan --help` is the command list.
//
// Anything that touches the registry / workspace contents goes through
// `chan_workspace::Library` and `chan_workspace::Workspace` so the library's
// invariants (atomic writes, path sandbox, special-file refusal,
// cross-process writer lock) apply uniformly.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use anyhow::Result;

use crate::cli::{
    cmd_completions, parse_cli, Command, ContactsAction, DevserverAction, DevserverServeArgs,
    ImportSource, WorkspaceAction,
};
use crate::close::cmd_close_cli;
use crate::config::cmd_config;
use crate::contacts::cmd_contacts_import_csv;
use crate::desktop::{cmd_upgrade_desktop, decide_upgrade_route, desktop_companion, UpgradeRoute};
use crate::devserver::foreground::{
    build_devserver_tunnel, build_devserver_tunnel_from_env, devserver_listen_override,
    resolve_devserver_listen, resolve_devserver_port, run_devserver_foreground,
    warn_non_loopback_bind,
};
use crate::devserver::launchd::{
    join_devserver_under_launchd, restart_devserver_under_launchd, start_devserver_under_launchd,
    stop_devserver_under_launchd,
};
use crate::devserver::management::cmd_rotate_devserver_token;
use crate::devserver::persisted::{
    devserver_addr_from_persisted_args, launchd_program_arguments, read_launch_agent_plist,
    read_systemd_unit, resolve_devserver_addr, systemd_execstart_line,
};
use crate::devserver::supervisor::{
    current_uid, launchd_is_active, unit_is_active, DEVSERVER_LAUNCHD_LABEL, DEVSERVER_SYSTEMD_UNIT,
};
use crate::devserver::systemd::{
    join_devserver_under_systemd, restart_devserver_under_systemd, start_devserver_under_systemd,
    stop_devserver_under_systemd, supervised_tunnel_spec, SystemdTunnel,
};
use crate::index::cmd_index;
use crate::mcp::{cmd_mcp, cmd_mcp_proxy};
use crate::metadata::cmd_metadata;
use crate::registry::{cmd_add, cmd_list};
use crate::remote::{
    cmd_devserver_connect, cmd_devserver_disconnect, cmd_devserver_forget, cmd_devserver_ls,
    cmd_devserver_register,
};
use crate::reports::cmd_reports;
use crate::search::cmd_workspace_search;
use crate::serve::cmd_serve_cli;
use crate::status::{cmd_ps, cmd_status};

mod cli;
mod close;
mod config;
mod contacts;
mod control;
mod desktop;
mod devserver;
mod index;
mod mcp;
mod metadata;
mod parentage;
mod registry;
mod remote;
mod reports;
mod search;
mod serve;
mod status;
#[cfg(test)]
mod test_support;
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

/// The `--service=chan` self-managed daemon: a cross-OS background devserver
/// guarded by a single-instance pidfile + flock (the systemd/launchd analog
/// where there is no OS supervisor, and the portable choice everywhere).
mod devserver_daemon;
pub use devserver_daemon::self_managed_devserver_pid;

/// Serialized ambient-`CHAN_*` isolation for env-reading tests and spawned
/// test children. Not `cfg(test)` because integration tests link this crate
/// without it.
#[doc(hidden)]
pub mod test_env;

/// Default listen port shared by `chan serve` (standalone serve) and
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

/// The build this binary was made from, stamped by `build.rs`.
///
/// The release version cannot name a build on its own: the version pins move
/// only at release cut, so every branch build between two cuts reports the
/// previous release's version. This is what separates them, and it is the same
/// value the server's health surfaces carry, so an id read through a tunnel
/// and an id read from `chan --version` are comparable.
pub const BUILD_ID: &str = env!("CHAN_BUILD_ID");

/// Which binary is driving the `chan` CLI, and therefore how the
/// desktop-aware subcommands behave.
///
/// - [`Personality::Standalone`] -- the `chan` binary from install.sh (and
///   the `cs -> chan` symlink). With both a desktop and devserver live,
///   `chan serve` prefers the devserver; with neither it runs its own server
///   and opens the browser.
///   `chan upgrade` replaces the CLI tarball in place.
/// - [`Personality::Desktop`] -- chan-desktop invoked as `chan` (via the
///   `~/.local/bin/chan` shim). `chan serve` integrates with the desktop:
///   it prefers a live devserver when no desktop is running, otherwise hands
///   the workspace to the desktop or launches the GUI.
///   `chan upgrade` drives the desktop's `tauri-plugin-updater`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Personality {
    Standalone,
    Desktop,
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

/// One management verb of the `chan devserver` family (start / stop /
/// restart / status / join). The subcommand grammar admits exactly one;
/// [`cmd_devserver_action`] adapts the selected verb onto this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevAction {
    Start,
    Stop,
    Restart,
    Status,
    Join,
}

impl DevAction {
    /// The verb's CLI spelling, for error messages.
    fn verb(self) -> &'static str {
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
    /// Run in the foreground: `--service=none` or the `run` form's `auto` default.
    Foreground(ServiceKind),
    /// A management verb on the `chan` background daemon.
    ChanVerb(DevAction),
    /// A verb against a `systemd`/`launchd` background service.
    Supervised(ServiceKind, DevAction),
}

/// One server-side `chan devserver` verb: the foreground `run`, a management
/// verb against a background service, or the token rotation, which needs no
/// service plan at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevserverVerb {
    Run,
    Manage(DevAction),
    RotateToken,
}

/// Split a `chan devserver` subcommand into the shared server-side flags and
/// the [`DevserverVerb`] it selects. The client-side subcommands (register,
/// ls, connect, disconnect, forget) carry no server-side flags and come back
/// whole in the `Err`, so the caller dispatches them itself.
fn devserver_verb(
    action: DevserverAction,
) -> Result<(DevserverServeArgs, DevserverVerb), DevserverAction> {
    use DevserverAction as A;
    Ok(match action {
        A::Run { args } => (args, DevserverVerb::Run),
        A::Start { args } => (args, DevserverVerb::Manage(DevAction::Start)),
        A::Stop { args } => (args, DevserverVerb::Manage(DevAction::Stop)),
        A::Restart { args } => (args, DevserverVerb::Manage(DevAction::Restart)),
        A::Status { args } => (args, DevserverVerb::Manage(DevAction::Status)),
        A::Join { args } => (args, DevserverVerb::Manage(DevAction::Join)),
        A::RotateToken { args } => (args, DevserverVerb::RotateToken),
        client_side @ (A::Register { .. }
        | A::Ls { .. }
        | A::Connect { .. }
        | A::Disconnect { .. }
        | A::Forget { .. }) => return Err(client_side),
    })
}

/// Validate a `(--service, action)` combination and resolve it to a [`DevPlan`],
/// or return a user-facing error for an invalid pair. Pure + total so every cell
/// of the validity matrix is unit-tested without a real service manager.
///
/// - `none` (foreground) takes no action verb.
/// - `chan` starts the portable background daemon when run bare or with
///   `start`, and accepts `stop`/`restart`/`status`/`join`.
/// - `systemd`/`launchd` (detached) require an explicit verb;
///   `--service=systemd` with no verb is ambiguous and rejected.
fn plan_devserver(service: ServiceKind, action: Option<DevAction>) -> Result<DevPlan, String> {
    match (service, action) {
        (ServiceKind::Auto, _) => {
            unreachable!("resolve_auto replaces Auto with a concrete backend before plan_devserver")
        }
        (ServiceKind::None, None) => Ok(DevPlan::Foreground(ServiceKind::None)),
        (ServiceKind::None, Some(a)) => Err(format!(
            "--service=none runs in the foreground (Ctrl-C to stop); `{}` needs a managed \
             backend (--service=chan/systemd/launchd)",
            a.verb()
        )),
        (ServiceKind::Chan, None) => Ok(DevPlan::ChanVerb(DevAction::Start)),
        (ServiceKind::Chan, Some(a)) => Ok(DevPlan::ChanVerb(a)),
        (kind @ (ServiceKind::Systemd | ServiceKind::Launchd), None) => Err(format!(
            "--service={} needs a management verb: one of start/stop/status/restart/join \
             (e.g. `chan devserver start --service={}`)",
            kind.cli_name(),
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
/// verb it selects the OS supervisor: `Systemd` on Linux, `Launchd` on macOS, and
/// `Chan` on Windows and FreeBSD, neither of which has an OS supervisor chan
/// drives, so both take its own portable daemon. An unrecognized OS has no
/// manager for an action verb, so that one case errors (the message points at
/// `--service=chan`). The OS is not threaded into `plan_devserver`, which keeps
/// validating the resolved `(backend, action)` pair on its own matrix.
fn resolve_auto(os: &str, has_action: bool) -> Result<ServiceKind, String> {
    if !has_action {
        return Ok(ServiceKind::None);
    }
    match os {
        "windows" | "freebsd" => Ok(ServiceKind::Chan),
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
            WorkspaceAction::Serve { args } => cmd_serve_cli(args, personality, verbose).await,
            WorkspaceAction::Close { args } => {
                cmd_close_cli(args.path, args.on, false, personality).await
            }
            WorkspaceAction::Forget { args } => {
                cmd_close_cli(args.path, args.on, true, personality).await
            }
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
            WorkspaceAction::Status { path, json } => cmd_status(path, json).await,
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
        Command::Shell { action } => chan_shell::dispatch(action, dump_skill).await,
        Command::Completions { shell } => cmd_completions(shell),
        Command::DumpSkill { args } => dump_skill(args),
        Command::Close { args, forget } => {
            cmd_close_cli(args.path, args.on, forget, personality).await
        }
        Command::Serve { args } => cmd_serve_cli(args, personality, verbose).await,
        Command::Ps { json } => cmd_ps(json).await,
        Command::Devserver { action } => cmd_devserver_action(action, verbose).await,
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
        } => match decide_upgrade_route(
            personality,
            update::packaged_via(),
            desktop_companion(cfg!(windows), chan_server::handoff::handoff_forced()),
        ) {
            // A distro-packaged build: the package manager owns the files.
            UpgradeRoute::Refuse(message) => anyhow::bail!(message),
            // Standalone (install.sh / install.ps1) replaces its CLI archive
            // in place.
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

/// Print the offline agent manual for either CLI personality. The desktop
/// supplies this same renderer to chan-shell so both entrypoints agree.
pub fn dump_skill(args: chan_shell::DumpSkillArgs) -> Result<()> {
    let out = skill::render_output(&args)?;
    print!("{out}");
    Ok(())
}

/// Dispatch one `chan devserver` subcommand: a client-side verb goes to its
/// desktop-launcher handler, and every server-side verb goes through
/// [`cmd_devserver`] with the flags it carries, so flag semantics and service
/// resolution live in one place whichever verb selected them.
async fn cmd_devserver_action(action: DevserverAction, verbose: bool) -> Result<()> {
    use DevserverAction as A;
    let (args, verb) = match devserver_verb(action) {
        Ok(server_side) => server_side,
        Err(A::Register { url, name, script }) => {
            return cmd_devserver_register(url, name, script).await;
        }
        Err(A::Ls { json }) => return cmd_devserver_ls(json).await,
        Err(A::Connect { target }) => return cmd_devserver_connect(target).await,
        Err(A::Disconnect { target }) => return cmd_devserver_disconnect(target).await,
        Err(A::Forget { target, force }) => return cmd_devserver_forget(target, force).await,
        Err(
            A::Run { .. }
            | A::Start { .. }
            | A::Stop { .. }
            | A::Restart { .. }
            | A::Status { .. }
            | A::Join { .. }
            | A::RotateToken { .. },
        ) => unreachable!("devserver_verb maps every server-side verb"),
    };
    cmd_devserver(args, verb, verbose).await
}

/// Run a headless multi-workspace devserver. The no-service default and
/// `--service=none` run in the foreground on `bind:port`; `--service=chan` is
/// the portable background daemon; `--service=systemd`/`launchd` are OS-backed
/// services driven by management verbs (`start`/`stop`/`restart`/
/// `status`/`join`). [`plan_devserver`] validates the `(service, action)`
/// pair before we touch any real service manager.
async fn cmd_devserver(args: DevserverServeArgs, verb: DevserverVerb, verbose: bool) -> Result<()> {
    // Backend-agnostic: rotation dials whatever devserver persisted its
    // port, or falls back to the config file, so it never needs the
    // service plan below.
    let action = match verb {
        DevserverVerb::RotateToken => return cmd_rotate_devserver_token().await,
        DevserverVerb::Run => None,
        DevserverVerb::Manage(action) => Some(action),
    };
    let DevserverServeArgs {
        bind,
        port,
        service,
        force,
        tunnel_url,
        tunnel_token,
        tunnel_devserver_name,
        no_tunnel,
    } = args;
    // `--no-tunnel` drops the token before anything can read it, so a devserver
    // spawned from a shell that inherited CHAN_TUNNEL_TOKEN stays local when
    // asked to. The supervised path takes the flag itself as well, to decline
    // the PAT persisted in the unit (see [`supervised_tunnel_spec`]).
    let tunnel_token = tunnel_token.filter(|_| !no_tunnel);
    // An endpoint is required with a token, but not necessarily HERE: a
    // supervised verb recovers it from the installed unit, which is the whole
    // point of a flagless `restart`. Resolution stays lazy so that path is
    // reachable at all; the foreground and `chan` backends have nothing
    // persisted to read, so they demand it at the point of use.
    let tunnel_url = tunnel_url.filter(|url| !url.trim().is_empty());
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
            // systemd notify it does bind so `chan devserver restart` fdstore
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
            // flagless restart/join keeps what the service runs on.
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

/// Dispatch a `systemd`/`launchd` action verb: `start` (create + enable +
/// start, then return), `stop` (stop + disable), `restart` (rewrite + bounce,
/// then return), `status`, or `join` (ensure running, then attach + block).
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

/// The bound address for a `restart`/`join` whose `--bind`/`--port` were
/// omitted: each field falls back to the running backend's persisted address so
/// a flagless restart keeps what the service runs on.
fn service_target_addr(kind: ServiceKind, bind: Option<IpAddr>, port: Option<u16>) -> SocketAddr {
    resolve_devserver_addr(bind, port, persisted_devserver_addr(kind))
}

/// The address a supervised backend persisted for its running (or last) service,
/// or None when nothing is recorded. systemd/launchd carry it in the unit /
/// agent the supervisor wrote (which survive a `stop`); the `chan` daemon
/// carries it in its pidfile.
fn persisted_devserver_addr(kind: ServiceKind) -> Option<SocketAddr> {
    match kind {
        ServiceKind::Chan => devserver_daemon::persisted_devserver_addr_chan(),
        ServiceKind::Systemd => devserver_addr_from_persisted_args(&read_systemd_unit()?),
        ServiceKind::Launchd => devserver_addr_from_persisted_args(&read_launch_agent_plist()?),
        ServiceKind::None | ServiceKind::Auto => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use crate::devserver::launchd::devserver_launch_agent_plist;
    use crate::devserver::relaunch::{select_relaunchable_exe, RelaunchCandidates};
    use crate::devserver::systemd::devserver_systemd_unit;
    use clap::Parser;
    use std::path::{Path, PathBuf};

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
        assert_eq!(resolve_auto("freebsd", false), Ok(ServiceKind::None));

        // An action verb selects the OS supervisor.
        assert_eq!(resolve_auto("linux", true), Ok(Systemd));
        assert_eq!(resolve_auto("macos", true), Ok(Launchd));
        assert_eq!(resolve_auto("windows", true), Ok(Chan));
        // FreeBSD has no OS supervisor chan drives, so it takes the portable
        // daemon Windows already defaults to.
        assert_eq!(resolve_auto("freebsd", true), Ok(Chan));

        // An unrecognized OS has no manager for an action verb. Naming FreeBSD
        // above must not widen into a silent default for every other OS.
        let err = resolve_auto("plan9", true).unwrap_err();
        assert!(err.contains("could not auto-detect a service backend"));
        assert!(err.contains("plan9"));
        assert!(err.contains("--service=chan"));
        for unknown in ["openbsd", "netbsd", "dragonfly", "illumos", "android"] {
            assert!(
                resolve_auto(unknown, true).is_err(),
                "{unknown} must not resolve a backend"
            );
        }

        // The Linux systemd pick is confirmed only when systemd is the init.
        assert!(require_systemd_for_auto(true).is_ok());
        let missing = require_systemd_for_auto(false).unwrap_err();
        assert!(missing.contains("systemd is not available"));
        assert!(missing.contains("/run/systemd/system"));
        assert!(missing.contains("--service=chan"));
    }

    /// `devserver_verb` splits each server-side subcommand into its shared
    /// flags and one `DevserverVerb`: `run` is the foreground form, the five
    /// management verbs carry their `DevAction`, `rotate-token` stands alone,
    /// and the flags pass through untouched. A client-side subcommand has no
    /// server-side verb and comes back whole.
    #[test]
    fn devserver_verb_maps_every_server_side_subcommand() {
        let _env = test_env::ChanTestEnv::new();
        let parse = |args: &[&str]| match Cli::parse_from(args).command {
            Command::Devserver { action } => action,
            other => panic!("expected Command::Devserver, got {other:?}"),
        };
        for (spelling, expected) in [
            ("run", DevserverVerb::Run),
            ("start", DevserverVerb::Manage(DevAction::Start)),
            ("stop", DevserverVerb::Manage(DevAction::Stop)),
            ("restart", DevserverVerb::Manage(DevAction::Restart)),
            ("status", DevserverVerb::Manage(DevAction::Status)),
            ("join", DevserverVerb::Manage(DevAction::Join)),
            ("rotate-token", DevserverVerb::RotateToken),
        ] {
            let action = parse(&[
                "chan",
                "devserver",
                spelling,
                "--bind",
                "127.0.0.2",
                "--port",
                "4242",
                "--service=chan",
                "--force",
                "--tunnel-url",
                "https://tunnel.example",
                "--tunnel-token",
                "chan_pat_x",
                "--tunnel-devserver-name",
                "box",
                "--no-tunnel",
            ]);
            let (args, verb) = devserver_verb(action)
                .unwrap_or_else(|client_side| panic!("{spelling}: got {client_side:?}"));
            assert_eq!(verb, expected, "{spelling}");
            assert_eq!(args.bind, "127.0.0.2".parse().ok(), "{spelling}");
            assert_eq!(args.port, Some(4242), "{spelling}");
            assert_eq!(args.service, ServiceKind::Chan, "{spelling}");
            assert!(args.force, "{spelling}");
            assert_eq!(
                args.tunnel_url.as_deref(),
                Some("https://tunnel.example"),
                "{spelling}"
            );
            assert_eq!(
                args.tunnel_token.as_deref(),
                Some("chan_pat_x"),
                "{spelling}"
            );
            assert_eq!(
                args.tunnel_devserver_name.as_deref(),
                Some("box"),
                "{spelling}"
            );
            assert!(args.no_tunnel, "{spelling}");
        }

        let client_side = devserver_verb(parse(&["chan", "devserver", "ls", "--json"]));
        assert!(
            matches!(client_side, Err(DevserverAction::Ls { json: true })),
            "{client_side:?}"
        );
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
        let plist =
            devserver_launch_agent_plist(&exe, addr, Path::new("/tmp/devserver.log"), None, None);
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
}
