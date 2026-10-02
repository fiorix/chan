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
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

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
    normalize_tunnel_devserver_name, resolve_devserver_listen, resolve_devserver_port,
    run_devserver_foreground, warn_non_loopback_bind, MISSING_TUNNEL_URL,
};
use crate::devserver::management::{
    cmd_rotate_devserver_token, drain_devserver_terminals, emit_devserver_token_marker, health_ok,
    DEVSERVER_TOKEN_WAIT,
};
use crate::devserver::persisted::{
    devserver_addr_from_persisted_args, devserver_chan_home, devserver_log_path,
    keeps_recorded_service_path, launch_agent_path, launchd_program_arguments,
    persisted_flag_value, read_launch_agent_plist, read_systemd_unit,
    recorded_launch_agent_search_path, resolve_devserver_addr, running_systemd_devserver_addr,
    systemd_execstart_line, systemd_user_unit_dir,
};
use crate::devserver::relaunch::resolve_relaunchable_exe;
use crate::devserver::supervisor::{
    current_uid, launchctl, launchd_domain_target, launchd_is_active, launchd_service_target,
    recent_unit_journal, run_tool, systemctl_user, unit_is_active, wait_until_active,
    wait_until_launchd_active, DEVSERVER_LAUNCHD_LABEL, DEVSERVER_SYSTEMD_UNIT,
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
/// flagless `restart` therefore comes back as the same registration it went
/// down as, which is the contract the `restart` help states.
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

/// Matches the unit's `TimeoutStartSec=10min`, which outlives the bounded
/// eight-minute startup restore before the devserver emits `READY=1`.
const DEVSERVER_SYSTEMD_START_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What a `--service` watchdog polls to decide the backing server is still up.
/// One probe per backend, so [`run_health_watchdog`] is shared by the
/// self-managed `chan` daemon, systemd, and launchd.
enum DaemonLiveness {
    /// The self-managed `chan` daemon: its pidfile still names this live pid.
    /// The pid re-pins when a `restart` replaces the daemon (see
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
    /// look for a RESTARTED daemon to adopt. `restart` spawns a new pid and
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
/// a `restart` bounce (stopping the old instance alone may take up to 15s)
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
/// `restart` reads as a re-pin instead of a death.
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
/// SSH remote commands and the desktop control terminal give `join` a pipe
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
/// only after [`WATCHDOG_GRACE`] of continuous failure: a `restart` bounce or
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

/// `chan devserver start --service=systemd`: ensure the unit is up (linger +
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

/// `chan devserver join --service=systemd`: ensure the unit is running (start
/// it if down, re-attach if up), then stay attached and block on the health
/// watchdog until Ctrl-C. This is the "bring it up and watch it" form connect
/// scripts use; unlike `start` it does not return until the service stops or
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
/// `restart` (`enable --now` would not bounce an already-running unit). Waits
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

/// `chan devserver restart --service=systemd`: rewrite the unit (current
/// binary + `addr`), bounce it (or start it if stopped), then return. Linger is
/// ensured first, mirroring the start path. Continuous fdstore parking makes
/// the bounce preserve live PTYs by itself; `--force` is the destructive
/// variant, draining every session through the management API first (and
/// falling back to stop-then-start when the drain cannot complete, so a
/// wedged devserver still restarts WITHOUT resurrecting its terminals).
/// Use `join` to stay attached.
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

/// `chan devserver stop --service=systemd`: stop the running unit AND disable
/// it, so it does not come back on the next login or boot. Sessions are drained
/// through the management API first (explicit kill, today's forcefulness for
/// HUP-immune children); the stop itself then releases the fd store, so even a
/// failed drain still ends every terminal a HUP can reach. Idempotent: stop is
/// a no-op when the unit is not active, and disable is skipped when no unit file
/// is installed. The unit file itself stays on disk (disable only drops the
/// `WantedBy` symlink), so `status` can still show its last command.
/// The `stop` drain decision: a failed drain WARNS and still stops -- the
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
            "chan devserver (systemd): linger is off (so the service would not \
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

/// Write `~/.config/systemd/user/chan-devserver.service` whose `ExecStart` runs
/// the resolved `chan` CLI's foreground devserver on `addr`. Returns the unit
/// path.
fn write_devserver_unit(
    addr: SocketAddr,
    tunnel: Option<SystemdTunnel>,
) -> Result<DevserverUnitUpdate> {
    use std::io::IsTerminal;
    let exe = resolve_relaunchable_exe()?;
    let dir = systemd_user_unit_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let unit_path = dir.join(DEVSERVER_SYSTEMD_UNIT);
    // The service runs with the user manager's environment, so the unit
    // records a PATH: without it an extension that resolves a helper by name
    // fails at every service start. An unreadable unit is left to
    // write_rendered_devserver_unit, which reports it.
    let installed = std::fs::read_to_string(&unit_path).ok();
    let unit = with_devserver_unit_search_path(
        devserver_systemd_unit_spec(
            &exe,
            addr,
            devserver_chan_home().as_deref(),
            tunnel.as_ref(),
        ),
        &std::env::var_os("PATH").unwrap_or_default(),
        installed.as_deref(),
        std::io::stdin().is_terminal(),
    );
    write_rendered_devserver_unit(&unit_path, &unit, tunnel.is_some())
}

/// `unit` with the `PATH` line [`keeps_recorded_service_path`] chooses when
/// it replaces `installed`: the one `installed` records, verbatim, or one
/// built from `current`.
fn with_devserver_unit_search_path(
    unit: chan_systemd::DevserverUnit,
    current: &std::ffi::OsStr,
    installed: Option<&str>,
    interactive: bool,
) -> chan_systemd::DevserverUnit {
    match installed.and_then(chan_systemd::DevserverUnit::recorded_search_path) {
        Some(recorded) if keeps_recorded_service_path(current, interactive) => {
            unit.with_environment(format!("PATH={recorded}"))
        }
        _ => unit.with_search_path(current),
    }
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
    // management API (see resolve_devserver_listen) so `stop` / `restart
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
            // terminals it spawns inherit, so a `chan devserver restart` typed
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
            let mut exec = format!("{exe} devserver run", exe = exe.display());
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
            "{exe} devserver run --bind={ip} --port={port}",
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

// ---------------------------------------------------------------------------
// macOS launchd backend -- mirrors the systemd backend above. The functions are
// always compiled (they only shell out to `launchctl`) and called only under
// `cfg!(target_os = "macos")`; the pure helpers stay unit-testable on any host.
// ---------------------------------------------------------------------------

/// `chan devserver start --service=launchd`: ensure the agent is up
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

/// `chan devserver join --service=launchd`: ensure the agent is running (start
/// it if down, re-attach if up), then stay attached and follow its log until
/// Ctrl-C. Unlike `start` it does not return until the agent stops or the user
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
/// and wait until active. Always re-registers, so it doubles as the `restart`
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

/// `chan devserver restart --service=launchd`: rewrite + re-register the agent
/// (current binary + `addr`) so it bounces (or starts if stopped), then return.
/// Use `join` to stay attached.
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

/// `chan devserver stop --service=launchd`: bootout the agent AND disable it,
/// so launchd does not re-bootstrap it at the next GUI login. Idempotent:
/// `bootout` errors when nothing is loaded, which we report as already-stopped;
/// `disable` is best-effort. The plist stays on disk, so `status` can still
/// show its last command; `start`/`restart` re-enable it.
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

/// Write the LaunchAgent plist whose `ProgramArguments` run the resolved `chan`
/// CLI's foreground devserver on `addr`. Returns the plist path.
fn write_devserver_launch_agent(addr: SocketAddr) -> Result<PathBuf> {
    use std::io::IsTerminal;
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
    // launchd starts the agent with its own environment, so the plist
    // records a PATH for the same reason the systemd unit does, chosen by
    // the same rule.
    let installed = std::fs::read_to_string(&plist_path).ok();
    let search_path = launch_agent_search_path(
        &std::env::var_os("PATH").unwrap_or_default(),
        installed.as_deref(),
        std::io::stdin().is_terminal(),
    );
    let plist = devserver_launch_agent_plist(
        &exe,
        addr,
        &log,
        devserver_chan_home().as_deref(),
        search_path.as_deref(),
    );
    std::fs::write(&plist_path, plist)
        .with_context(|| format!("writing {}", plist_path.display()))?;
    Ok(plist_path)
}

/// The `PATH` the LaunchAgent plist records when it replaces `installed`:
/// the one `installed` records when [`keeps_recorded_service_path`] says so,
/// else the entries of `current` that [`chan_systemd::service_search_path`]
/// keeps, the same filter the systemd unit applies.
fn launch_agent_search_path(
    current: &std::ffi::OsStr,
    installed: Option<&str>,
    interactive: bool,
) -> Option<String> {
    match installed.and_then(recorded_launch_agent_search_path) {
        Some(recorded) if keeps_recorded_service_path(current, interactive) => Some(recorded),
        _ => chan_systemd::service_search_path(current),
    }
}

/// Build the LaunchAgent plist XML. `RunAtLoad` starts it on bootstrap;
/// `KeepAlive`/`SuccessfulExit=false` restarts it only on a crash (the launchd
/// analogue of systemd `Restart=on-failure`); stdout/stderr go to `log`.
fn devserver_launch_agent_plist(
    exe: &Path,
    addr: SocketAddr,
    log: &Path,
    chan_home: Option<&str>,
    search_path: Option<&str>,
) -> String {
    // launchd starts the agent with a fresh environment, so a CHAN_HOME-scoped
    // supervisor bakes it into the plist; else the agent runs against ~/.chan.
    // The PATH is the one `launch_agent_search_path` chose. The dict follows
    // ProgramArguments, where persisted_command_line reads the flags.
    let mut variables = String::new();
    for (key, value) in [("CHAN_HOME", chan_home), ("PATH", search_path)] {
        if let Some(value) = value {
            variables.push_str(&format!(
                "    <key>{key}</key>\n    <string>{}</string>\n",
                xml_escape(value)
            ));
        }
    }
    let environment = if variables.is_empty() {
        String::new()
    } else {
        format!("  <key>EnvironmentVariables</key>\n  <dict>\n{variables}  </dict>\n")
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
    <string>run</string>
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use crate::devserver::relaunch::{select_relaunchable_exe, RelaunchCandidates};
    use clap::Parser;

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

    /// The flags a restart reads back come from the command a definition
    /// runs, never from its environment: a unit's `Environment=` lines render
    /// before `ExecStart=`, and a PATH entry may hold the same text.
    #[test]
    fn persisted_flags_come_from_the_command_line_only() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let unit = devserver_systemd_unit_spec(Path::new("/usr/bin/chan"), addr, None, None)
            .with_search_path(std::ffi::OsStr::new(
                "/opt/x--port=1/bin:/opt/y--tunnel-url=https://z/bin:/usr/bin",
            ))
            .render();
        assert_eq!(
            persisted_flag_value(&unit, "--port="),
            Some("8787"),
            "the port must come from ExecStart: {unit}"
        );
        assert_eq!(devserver_addr_from_persisted_args(&unit), Some(addr));
        assert_eq!(
            persisted_tunnel_url(&unit),
            None,
            "a local unit must not read as a tunnel unit: {unit}"
        );

        // A plist keeps the flags in ProgramArguments, wherever its
        // environment sits.
        let plist = "<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n    \
                     <key>PATH</key>\n    <string>/opt/x--port=1/bin:/usr/bin</string>\n  \
                     </dict>\n  <key>ProgramArguments</key>\n  <array>\n    \
                     <string>/usr/local/bin/chan</string>\n    <string>devserver</string>\n    \
                     <string>run</string>\n    <string>--bind=127.0.0.1</string>\n    \
                     <string>--port=8787</string>\n  </array>\n</dict>\n";
        assert_eq!(
            persisted_flag_value(plist, "--port="),
            Some("8787"),
            "the port must come from ProgramArguments: {plist}"
        );
        assert_eq!(devserver_addr_from_persisted_args(plist), Some(addr));
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
    fn chan_own_unit_is_rewritten_with_the_installing_search_path() {
        // The upgrade path over a unit an older chan wrote without a PATH, and
        // a restart from a shell with another PATH, both rewrite the unit with
        // the caller's PATH instead of refusing it as administrator-edited.
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let spec = || devserver_systemd_unit_spec(Path::new("/usr/bin/chan"), addr, None, None);
        std::fs::write(&path, spec().render()).expect("seed a unit without a PATH");

        let login = spec().with_search_path(std::ffi::OsStr::new("/home/dev/.local/bin:/usr/bin"));
        let update = write_rendered_devserver_unit(&path, &login, false)
            .expect("chan must upgrade a unit it wrote itself");
        assert!(update.changed, "a unit without a PATH must gain one");
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            written.contains("Environment=\"PATH=/home/dev/.local/bin:/usr/bin\"\n"),
            "the unit must carry the installing PATH: {written}"
        );

        let other_shell = spec().with_search_path(std::ffi::OsStr::new("/opt/tools/bin:/usr/bin"));
        let update = write_rendered_devserver_unit(&path, &other_shell, false)
            .expect("chan must refresh the PATH it recorded");
        assert!(update.changed, "another PATH must rewrite the unit");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            other_shell.render()
        );

        let again = write_rendered_devserver_unit(&path, &other_shell, false)
            .expect("the unit chan just wrote is its own");
        assert!(!again.changed, "the same PATH must be a no-op");
    }

    #[test]
    fn a_render_without_a_terminal_keeps_the_recorded_search_path() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let spec = || devserver_systemd_unit_spec(Path::new("/usr/bin/chan"), addr, None, None);
        let path_line = |unit: &chan_systemd::DevserverUnit| {
            unit.render()
                .lines()
                .find(|line| line.starts_with("Environment=\"PATH="))
                .map(str::to_string)
        };
        let login = std::ffi::OsStr::new("/home/dev/.local/bin:/usr/bin");
        let script = std::ffi::OsStr::new("/usr/bin:/bin");
        let installed = spec().with_search_path(login).render();

        // A connect script's render keeps the login PATH the unit records.
        let scripted = with_devserver_unit_search_path(spec(), script, Some(&installed), false);
        assert_eq!(
            scripted.render(),
            installed,
            "a render without a terminal must keep the recorded PATH"
        );

        // A render from a terminal replaces it.
        let interactive = with_devserver_unit_search_path(spec(), script, Some(&installed), true);
        assert_eq!(
            path_line(&interactive).as_deref(),
            Some("Environment=\"PATH=/usr/bin:/bin\""),
            "a render from a terminal must record its own PATH"
        );

        // With nothing recorded, a render without a terminal records its own,
        // over a unit an older chan wrote and on a first install alike.
        for installed in [Some(spec().render()), None] {
            let first =
                with_devserver_unit_search_path(spec(), script, installed.as_deref(), false);
            assert_eq!(
                path_line(&first).as_deref(),
                Some("Environment=\"PATH=/usr/bin:/bin\""),
                "a unit with no recorded PATH must gain one"
            );
        }

        // A terminal render with no usable entry keeps the recorded line
        // rather than deleting it.
        let unusable = std::ffi::OsStr::new("::bin:.");
        let emptied = with_devserver_unit_search_path(spec(), unusable, Some(&installed), true);
        assert_eq!(
            emptied.render(),
            installed,
            "a PATH with no usable entry must not delete the recorded one"
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

    #[test]
    fn chan_own_unit_is_updated_when_the_rendered_address_changes() {
        // The installed unit and the desired one both come out of the real
        // renderer: a hand-written ExecStart is exactly how the two spellings
        // drifted apart in the first place.
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let installed = devserver_systemd_unit_spec(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            None,
        );
        std::fs::write(&path, installed.render()).expect("seed the unit chan itself wrote");

        // `chan devserver start --port=9000` over an installed unit: same
        // renderer, different address, so the Current short-circuit does not
        // apply and the ExecStart has to be recognized on its own.
        let desired = devserver_systemd_unit_spec(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:9000".parse().unwrap(),
            None,
            None,
        );
        let update = write_rendered_devserver_unit(&path, &desired, false)
            .expect("chan must update a unit it wrote itself");
        assert!(update.changed, "a new address must rewrite the unit");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), desired.render());
    }

    #[test]
    fn chan_own_unit_is_updated_when_the_binary_moves() {
        // package -> AppImage -> ~/.local/bin: the ExecStart executable changes
        // under the same renderer.
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let installed = devserver_systemd_unit_spec(Path::new("/usr/bin/chan"), addr, None, None);
        std::fs::write(&path, installed.render()).expect("seed the packaged unit");

        let desired =
            devserver_systemd_unit_spec(Path::new("/home/dev/.local/bin/chan"), addr, None, None);
        let update = write_rendered_devserver_unit(&path, &desired, false)
            .expect("chan must update a unit it wrote itself");
        assert!(update.changed, "a moved binary must rewrite the unit");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), desired.render());
    }

    #[test]
    fn chan_own_tunnel_unit_is_updated_when_the_rendered_address_changes() {
        // The tunnel branch renders a different flag set through the same
        // `devserver run` verb; it must be recognized too.
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
            pinned_bind: None,
            pinned_port: None,
            pinned_name: None,
        };
        let installed = devserver_systemd_unit_spec(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8787".parse().unwrap(),
            None,
            Some(&tunnel),
        );
        std::fs::write(&path, installed.render()).expect("seed the tunnel unit");

        let pinned = SystemdTunnel {
            token: tunnel.token.clone(),
            url: tunnel.url.clone(),
            pinned_bind: None,
            pinned_port: Some(9000),
            pinned_name: None,
        };
        let desired = devserver_systemd_unit_spec(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:9000".parse().unwrap(),
            None,
            Some(&pinned),
        );
        let update = write_rendered_devserver_unit(&path, &desired, true)
            .expect("chan must update a tunnel unit it wrote itself");
        assert!(update.changed, "a new pinned port must rewrite the unit");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), desired.render());
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

    // The unit every install before the two-fd store carries: the current
    // shape at FileDescriptorStoreMax=512. It must be rewritten at 1024 and
    // reloaded, and a second pass must find it current.
    #[tokio::test]
    async fn an_installed_unit_at_the_512_store_maximum_migrates() {
        let dir = tempfile::tempdir().expect("unit dir");
        let path = dir.path().join(DEVSERVER_SYSTEMD_UNIT);
        let desired = chan_systemd::DevserverUnit::new(
            "/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787",
        );
        let rendered = desired.render();
        assert!(rendered.contains("\nFileDescriptorStoreMax=1024\n"));
        let installed =
            rendered.replace("FileDescriptorStoreMax=1024", "FileDescriptorStoreMax=512");
        std::fs::write(&path, &installed).expect("seed the installed unit");

        let update =
            write_rendered_devserver_unit(&path, &desired, false).expect("stage migration");
        assert!(update.changed, "a 512 unit is migrated, not refused");
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

        let repeat =
            write_rendered_devserver_unit(&path, &desired, false).expect("classify current unit");
        assert!(!repeat.changed, "the migrated unit is current");
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
        assert!(unit.contains("FileDescriptorStoreMax=1024"));
        assert!(unit.contains("KillMode=process"));
        assert!(unit
            .contains("ExecStart=/usr/local/bin/chan devserver run --bind=127.0.0.1 --port=8799"));
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
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
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
            "ExecStart=/home/dev/.local/bin/chan devserver run \
             --tunnel-url=https://proxy.chan.app/v1/tunnel\n"
        ));
        assert!(!unit.contains("--bind="));
        assert!(!unit.contains("--port="));
        // The PAT rides in an Environment= line (the unit is written 0600),
        // and the endpoint rides one too, so the terminals this service spawns
        // inherit it and can run their own `chan devserver` verbs.
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_abc123\"\n"));
        assert!(unit.contains("Environment=\"CHAN_TUNNEL_URL=https://proxy.chan.app/v1/tunnel\"\n"));
        // The systemd fdstore scaffold is unchanged from the non-tunnel unit.
        assert!(unit.contains("Type=notify"));
        assert!(unit.contains("NotifyAccess=main"));
        assert!(unit.contains("FileDescriptorStoreMax=1024"));
    }

    #[test]
    fn devserver_systemd_unit_tunnel_pins_explicit_addr_flags() {
        // Pinned (explicit or preserved-explicit) address flags ride in the
        // ExecStart, so the tunnel service binds exactly there.
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
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
            "ExecStart=/home/dev/.local/bin/chan devserver run --bind=0.0.0.0 \
             --port=9000 --tunnel-url=https://proxy.chan.app/v1/tunnel\n"
        ));
        // Each field pins independently: a port-only pin keeps the bind
        // omitted (the service resolves the loopback default).
        let port_only = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
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
            "ExecStart=/home/dev/.local/bin/chan devserver run --port=9000 \
             --tunnel-url=https://proxy.chan.app/v1/tunnel\n"
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
         ExecStart=/home/dev/.local/bin/chan devserver run --port=9000 \
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
        // The regression this guards: a `restart` typed in a shell that
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
        let local = "ExecStart=/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787\n";
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
                      ExecStart=/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787\n";
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
    /// contract: a `restart` that renders something else classifies the
    /// installed unit as changed and rewrites it. Provisioning that writes a
    /// unit by hand has to match this to be left alone.
    #[test]
    fn devserver_systemd_unit_tunnel_renders_the_whole_unit() {
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
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
             FileDescriptorStoreMax=1024\n\
             KillMode=process\n\
             Environment=\"CHAN_TUNNEL_TOKEN=chan_pat_abc123\"\n\
             Environment=\"CHAN_TUNNEL_URL=https://proxy.chan.app/v1/tunnel\"\n\
             ExecStart=/home/dev/.local/bin/chan devserver run \
             --tunnel-url=https://proxy.chan.app/v1/tunnel\n\
             TimeoutStartSec=10min\n\
             Restart=on-failure\n\
             WatchdogSec=30\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n"
        );
    }

    #[test]
    fn persisted_tunnel_readers_round_trip_a_rendered_unit() {
        // The read side against what the write side actually produces, so the
        // two cannot drift: every field a flagless restart depends on comes
        // back out of a rendered unit.
        let tunnel = SystemdTunnel {
            token: "chan_pat_round_trip".to_string(),
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
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
            Some("https://proxy.chan.app/v1/tunnel".to_string())
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
        // Old-form ExecStart (no run verb): units installed by an older chan must still parse.
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
        let local = "ExecStart=/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787\n";
        assert_eq!(persisted_tunnel_url(local), None);
    }

    #[test]
    fn persisted_tunnel_pins_only_read_tunnel_units() {
        // A tunnel unit's persisted --bind/--port ARE the explicitness record,
        // each field independently.
        let pinned = "ExecStart=/usr/bin/chan devserver run --bind=0.0.0.0 --port=9000 \
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
        let non_tunnel = "ExecStart=/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787\n";
        assert_eq!(persisted_tunnel_pins(non_tunnel), (None, None));
    }

    #[test]
    fn devserver_systemd_unit_tunnel_pins_explicit_name() {
        // A pinned name rides in the unit environment (like the token), so
        // the service re-announces it on every restart. Quotes and
        // backslashes are stripped: systemd's Environment= quoting cannot
        // carry them raw.
        let tunnel = SystemdTunnel {
            token: "chan_pat_abc123".to_string(),
            url: "https://proxy.chan.app/v1/tunnel".to_string(),
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
        // the round trip a flagless restart takes.
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
                          ExecStart=/usr/bin/chan devserver run --bind=127.0.0.1 --port=8787\n";
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
    fn launch_agent_plist_carries_program_and_keys() {
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            "127.0.0.1:8799".parse().unwrap(),
            Path::new("/Users/x/.chan/devserver/devserver.log"),
            None,
            None,
        );
        assert!(plist.contains("<string>app.chan.devserver</string>"));
        assert!(plist.contains("<string>/usr/local/bin/chan</string>"));
        assert!(plist.contains("<string>devserver</string>"));
        assert!(plist.contains("<string>run</string>"));
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
            None,
        );
        assert!(plist.contains("<key>EnvironmentVariables</key>"));
        assert!(plist.contains("<key>CHAN_HOME</key>"));
        // The value is XML-escaped like every other plist string.
        assert!(plist.contains("<string>/tmp/iso &amp; home</string>"));
    }

    #[test]
    fn launch_agent_plist_records_the_install_time_search_path() {
        let addr: SocketAddr = "127.0.0.1:8799".parse().unwrap();
        let plist = devserver_launch_agent_plist(
            Path::new("/usr/local/bin/chan"),
            addr,
            Path::new("/tmp/log"),
            Some("/tmp/iso"),
            Some("/Users/x/.local/bin:/opt/a&b/bin:/usr/bin"),
        );
        assert!(
            plist.contains(
                "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>CHAN_HOME</key>\n    \
                 <string>/tmp/iso</string>\n    <key>PATH</key>\n    \
                 <string>/Users/x/.local/bin:/opt/a&amp;b/bin:/usr/bin</string>\n  </dict>\n"
            ),
            "the plist must record the PATH, XML-escaped, beside CHAN_HOME: {plist}"
        );
        // The environment follows the command, and neither the status line
        // nor the persisted address reads it.
        assert!(
            plist.find("<key>ProgramArguments</key>")
                < plist.find("<key>EnvironmentVariables</key>")
        );
        assert_eq!(
            launchd_program_arguments(&plist).as_deref(),
            Some("/usr/local/bin/chan devserver run --bind=127.0.0.1 --port=8799")
        );
        assert_eq!(devserver_addr_from_persisted_args(&plist), Some(addr));
        assert_eq!(
            recorded_launch_agent_search_path(&plist).as_deref(),
            Some("/Users/x/.local/bin:/opt/a&b/bin:/usr/bin")
        );
    }

    #[test]
    fn launch_agent_search_path_follows_the_unit_rule() {
        let plist = |search_path: Option<&str>| {
            devserver_launch_agent_plist(
                Path::new("/usr/local/bin/chan"),
                "127.0.0.1:8799".parse().unwrap(),
                Path::new("/tmp/log"),
                None,
                search_path,
            )
        };
        let installed = plist(Some("/Users/x/.local/bin:/usr/bin"));
        let script = std::ffi::OsStr::new("/usr/bin:/bin:relative:/usr/bin");

        assert_eq!(
            launch_agent_search_path(script, Some(&installed), false).as_deref(),
            Some("/Users/x/.local/bin:/usr/bin"),
            "a render without a terminal must keep the recorded PATH"
        );
        assert_eq!(
            launch_agent_search_path(script, Some(&installed), true).as_deref(),
            Some("/usr/bin:/bin"),
            "a render from a terminal must record its own PATH, filtered like the unit's"
        );
        for installed in [Some(plist(None)), None] {
            assert_eq!(
                launch_agent_search_path(script, installed.as_deref(), false).as_deref(),
                Some("/usr/bin:/bin"),
                "a plist with no recorded PATH must gain one"
            );
        }
        assert_eq!(
            launch_agent_search_path(std::ffi::OsStr::new("::bin:."), Some(&installed), true)
                .as_deref(),
            Some("/Users/x/.local/bin:/usr/bin"),
            "a PATH with no usable entry must not delete the recorded one"
        );
    }

    #[test]
    fn launch_agent_plist_escapes_xml_in_paths() {
        let plist = devserver_launch_agent_plist(
            Path::new("/opt/a & b/chan"),
            "127.0.0.1:1".parse().unwrap(),
            Path::new("/tmp/log"),
            None,
            None,
        );
        assert!(plist.contains("/opt/a &amp; b/chan"));
        assert!(!plist.contains("a & b/chan"));
    }
}
