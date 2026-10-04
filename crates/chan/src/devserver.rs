use std::net::{IpAddr, SocketAddr};
use std::path::Path;

use anyhow::Result;

use crate::cli::{DevserverAction, DevserverServeArgs};
use crate::devserver::foreground::{
    build_devserver_tunnel, devserver_listen_override, resolve_devserver_listen,
    resolve_devserver_port, run_devserver_foreground, warn_non_loopback_bind,
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
use crate::remote::{
    cmd_devserver_connect, cmd_devserver_disconnect, cmd_devserver_forget, cmd_devserver_ls,
    cmd_devserver_register,
};
use crate::{devserver_daemon, ServiceKind, DEFAULT_DEVSERVER_BIND};

pub(crate) mod foreground;
mod launchd;
pub(crate) mod management;
pub(crate) mod persisted;
pub(crate) mod relaunch;
mod supervisor;
mod systemd;
pub(crate) mod watchdog;

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
        A::Status { args, .. } => (args, DevserverVerb::Manage(DevAction::Status)),
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

/// Dispatch one `chan devserver` subcommand: a client-side verb goes to its
/// desktop-launcher handler, and every server-side verb goes through
/// [`cmd_devserver`] with the flags it carries, so flag semantics and service
/// resolution live in one place whichever verb selected them.
pub(super) async fn cmd_devserver_action(action: DevserverAction, verbose: bool) -> Result<()> {
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

/// Build the status lines shared by the supervised and portable backends.
pub(crate) fn devserver_status_text(
    state: &str,
    command: Option<&str>,
    log: Option<&Path>,
    _addr: Option<SocketAddr>,
    _token: Option<&str>,
    _show_url: bool,
) -> String {
    let mut out = format!("{state}\n");
    if let Some(command) = command {
        out.push_str(&format!("  command: {command}\n"));
    }
    if let Some(log) = log {
        out.push_str(&format!("  log: {}\n", log.display()));
    }
    out
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
                let state = format!(
                    "chan devserver (systemd): {} -- {DEVSERVER_SYSTEMD_UNIT}",
                    if running { "running" } else { "not running" }
                );
                let command = read_systemd_unit().and_then(|u| systemd_execstart_line(&u));
                print!(
                    "{}",
                    devserver_status_text(&state, command.as_deref(), None, None, None, false)
                );
                Ok(())
            } else {
                anyhow::bail!("chan devserver: the systemd backend is Linux-only.")
            }
        }
        ServiceKind::Launchd => {
            if cfg!(target_os = "macos") {
                let uid = current_uid().await?;
                let running = launchd_is_active(uid).await;
                let state = format!(
                    "chan devserver (launchd): {} -- {DEVSERVER_LAUNCHD_LABEL}",
                    if running { "running" } else { "not running" }
                );
                let command = read_launch_agent_plist().and_then(|p| launchd_program_arguments(&p));
                print!(
                    "{}",
                    devserver_status_text(&state, command.as_deref(), None, None, None, false)
                );
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
    use crate::cli::{Cli, Command};
    use crate::devserver::launchd::devserver_launch_agent_plist;
    use crate::devserver::relaunch::{select_relaunchable_exe, RelaunchCandidates};
    use crate::devserver::systemd::devserver_systemd_unit;
    use crate::test_env;
    use clap::Parser;
    use std::path::{Path, PathBuf};

    #[test]
    fn status_text_has_launch_url_for_each_backend() {
        let _env = test_env::ChanTestEnv::new();
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let token = "status-unit-token";
        let expected = chan_server::ServeHandle {
            addr,
            prefix: String::new(),
            token: Some(token.to_owned()),
        }
        .launch_url();
        for kind in [
            ServiceKind::Systemd,
            ServiceKind::Launchd,
            ServiceKind::Chan,
        ] {
            let state = format!("chan devserver ({}): running", kind.cli_name());
            let text = devserver_status_text(
                &state,
                Some("chan devserver run"),
                None,
                Some(addr),
                Some(token),
                true,
            );
            assert!(
                text.contains(&format!("chan devserver: listening on {expected}\n")),
                "launch URL absent for {}",
                kind.cli_name()
            );
        }
    }

    #[test]
    fn status_text_handles_hidden_and_missing_launch_urls() {
        let _env = test_env::ChanTestEnv::new();
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let token = "status-unit-token";
        let state = "chan devserver (chan): running";
        let hidden = devserver_status_text(state, None, None, Some(addr), Some(token), false);
        assert!(!hidden.contains("?t="), "hidden status exposed a token URL");
        assert!(hidden.contains("--url"), "hidden status must name --url");

        let missing = devserver_status_text(state, None, None, Some(addr), None, true);
        let config = chan_workspace::paths::config_dir().join("devserver/config.json");
        assert!(
            missing.contains(&config.display().to_string()),
            "missing token path absent"
        );
        assert!(!missing.contains("http://"), "missing token yielded a URL");

        let no_addr = devserver_status_text(state, None, None, None, Some(token), true);
        assert!(
            !no_addr.contains("http://"),
            "missing address yielded a URL"
        );
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
