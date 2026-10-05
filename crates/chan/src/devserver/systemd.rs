use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};

use crate::devserver::foreground::{normalize_tunnel_devserver_name, MISSING_TUNNEL_URL};
use crate::devserver::management::{
    drain_devserver_terminals, emit_devserver_token_marker, DEVSERVER_TOKEN_WAIT,
};
use crate::devserver::persisted::{
    devserver_chan_home, keeps_recorded_service_path, persisted_flag_value, read_systemd_unit,
    running_systemd_devserver_addr, systemd_user_unit_dir,
};
use crate::devserver::relaunch::resolve_relaunchable_exe;
use crate::devserver::supervisor::{
    recent_unit_journal, run_tool, systemctl_user, unit_is_active, wait_until_active,
    DEVSERVER_SYSTEMD_UNIT,
};
use crate::devserver::watchdog::{run_health_watchdog, DaemonLiveness};
use crate::ServiceKind;

/// A tunnel registration to bake into a systemd unit: the PAT that flips the
/// devserver into tunnel mode and the gateway endpoint it dials.
pub(super) struct SystemdTunnel {
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
pub(super) fn supervised_tunnel_spec(
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

/// Matches the unit's `TimeoutStartSec=10min`, which outlives the bounded
/// eight-minute startup restore before the devserver emits `READY=1`.
const DEVSERVER_SYSTEMD_START_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// `chan devserver start --service=systemd`: ensure the unit is up (linger +
/// write/enable/start when it is not already running), then return. Enables the
/// unit so it also comes back on boot. Idempotent: a no-op (beyond re-providing
/// the token) when the service is already active.
pub(super) async fn start_devserver_under_systemd(
    addr: SocketAddr,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    ensure_systemd_linger().await?;
    if unit_is_active().await {
        emit_devserver_token_marker(running_systemd_devserver_addr(), DEVSERVER_TOKEN_WAIT).await?;
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
pub(super) async fn join_devserver_under_systemd(
    addr: SocketAddr,
    tunnel: Option<SystemdTunnel>,
) -> Result<()> {
    ensure_systemd_linger().await?;

    if unit_is_active().await {
        // Re-attaching to a unit that is already running. A journal follow
        // won't re-emit the unit's original start line, so the supervisor
        // re-provides the launch URL and token marker itself when the running
        // address is known (see emit_devserver_token_marker).
        emit_devserver_token_marker(running_systemd_devserver_addr(), DEVSERVER_TOKEN_WAIT).await?;
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

/// The running unit's address wins. On a fresh activation with no readable
/// bound address, only a port pinned in the unit can name a browser URL.
fn fresh_systemd_marker_addr(
    running: Option<SocketAddr>,
    requested: SocketAddr,
    port_pinned: bool,
) -> Option<SocketAddr> {
    running
        .filter(|bound| bound.port() != 0)
        .or_else(|| port_pinned.then_some(requested))
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
    let port_pinned = tunnel
        .as_ref()
        .is_none_or(|tunnel| tunnel.pinned_port.is_some());
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
    // The freshly started service prints its launch URL and token marker,
    // which under the unit lands in the journal -- invisible to this terminal
    // on a host with no readable journal. Emit the marker and a launch URL
    // when the bound address is known, directly from the persisted config;
    // fail loud if the token never lands.
    emit_devserver_token_marker(
        fresh_systemd_marker_addr(running_systemd_devserver_addr(), addr, port_pinned),
        DEVSERVER_TOKEN_WAIT,
    )
    .await?;
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
pub(super) async fn restart_devserver_under_systemd(
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

pub(super) async fn stop_devserver_under_systemd() -> Result<()> {
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
pub(super) fn devserver_systemd_unit(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devserver::persisted::devserver_addr_from_persisted_args;

    #[test]
    fn a_fresh_systemd_marker_uses_the_running_or_pinned_address() {
        let requested: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let bound: SocketAddr = "127.0.0.1:49231".parse().unwrap();
        assert_eq!(
            fresh_systemd_marker_addr(Some(bound), requested, false),
            Some(bound),
            "the running unit's bound address did not win"
        );
        let requested_nonzero: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        assert_eq!(
            fresh_systemd_marker_addr(None, requested_nonzero, false),
            None,
            "a fresh unit with no pinned port emitted an unbound URL"
        );
        assert_eq!(
            fresh_systemd_marker_addr(None, requested_nonzero, true),
            Some(requested_nonzero),
            "a fresh unit with a pinned port lost its known address"
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
        let packaged = include_str!("../../../../packaging/distros/shared/chan-devserver.service");
        let provision = include_str!("../../../../packaging/sdme/chan-devserver-provision.sh");
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
}
