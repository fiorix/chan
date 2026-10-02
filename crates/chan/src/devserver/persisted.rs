use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::devserver::supervisor::{DEVSERVER_LAUNCHD_LABEL, DEVSERVER_SYSTEMD_UNIT};
use crate::{DEFAULT_DEVSERVER_BIND, DEFAULT_PORT};

/// Apply the `stop`/`restart` address precedence per field: an explicit CLI
/// flag wins, else the running service's persisted value, else the built-in
/// default. Pure (the FS read that yields `persisted` lives in the caller) so the
/// precedence stays unit-testable.
pub(super) fn resolve_devserver_addr(
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

/// Where to dial this machine's devserver: the running systemd unit's
/// address, else the persisted port on the default bind.
pub(crate) fn local_devserver_dial_addr() -> Option<SocketAddr> {
    running_systemd_devserver_addr().or_else(|| {
        chan_server::persisted_devserver_port()
            .map(|port| SocketAddr::new(DEFAULT_DEVSERVER_BIND, port))
    })
}

/// The address the RUNNING systemd devserver serves its management API on,
/// for the verbs that dial it (the `stop` / `--force` terminal drain,
/// `join`'s health watch) and the bind= report lines. Unit-persisted `--bind`/`--port`
/// flags are the truth when present; a tunnel unit with no pinned port binds
/// an OS-assigned one, which the service records in the devserver config at
/// bind time (before READY=1, so an `is-active` unit has already written it).
/// `None` when neither source knows a port.
pub(super) fn running_systemd_devserver_addr() -> Option<SocketAddr> {
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

/// Parse the `--bind=<ip>` / `--port=<port>` the supervisor persisted into a unit
/// ExecStart line or a launchd plist's ProgramArguments, into the bound address.
/// Each value is read up to the next whitespace or `<`, so it works for both the
/// shell-style ExecStart and the XML-wrapped plist `<string>`. None if either
/// flag is missing or unparseable.
pub(super) fn devserver_addr_from_persisted_args(text: &str) -> Option<SocketAddr> {
    let ip: IpAddr = persisted_flag_value(text, "--bind=")?.parse().ok()?;
    let port: u16 = persisted_flag_value(text, "--port=")?.parse().ok()?;
    Some(SocketAddr::new(ip, port))
}

/// The value immediately following `flag` in the command a persisted unit or
/// plist runs (see [`persisted_command_line`]), read up to the next
/// whitespace or `<` (the XML element close in a plist).
pub(super) fn persisted_flag_value<'a>(text: &'a str, flag: &str) -> Option<&'a str> {
    let command = persisted_command_line(text)?;
    let start = command.find(flag)? + flag.len();
    let rest = &command[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '<')
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// The command a persisted definition runs: a unit's `ExecStart=` line, or a
/// plist's `ProgramArguments` array. Flags are read from here alone because a
/// definition's environment (a recorded PATH, CHAN_HOME) can hold the same
/// text, and a unit renders its `Environment=` lines before `ExecStart=`.
fn persisted_command_line(text: &str) -> Option<&str> {
    if let Some(exec_start) = text
        .lines()
        .find_map(|line| line.trim_start().strip_prefix("ExecStart="))
    {
        return Some(exec_start);
    }
    let (_, arguments) = text.split_once("<key>ProgramArguments</key>")?;
    let (_, array) = arguments.split_once("<array>")?;
    array.split_once("</array>").map(|(array, _)| array)
}

/// The persisted systemd unit contents, if the file exists.
pub(super) fn read_systemd_unit() -> Option<String> {
    std::fs::read_to_string(systemd_user_unit_dir().ok()?.join(DEVSERVER_SYSTEMD_UNIT)).ok()
}

/// The persisted launchd agent plist contents, if the file exists.
pub(super) fn read_launch_agent_plist() -> Option<String> {
    std::fs::read_to_string(launch_agent_path().ok()?).ok()
}

/// The `ExecStart=` command line from a systemd unit's text, for `status`.
pub(super) fn systemd_execstart_line(unit: &str) -> Option<String> {
    unit.lines()
        .find_map(|l| l.strip_prefix("ExecStart=").map(|s| s.trim().to_string()))
}

/// A launchd plist's `ProgramArguments` joined into one command line, for
/// `status`. Pulls each `<string>` inside the `<array>` and unescapes it.
pub(super) fn launchd_program_arguments(plist: &str) -> Option<String> {
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

/// Whether a rewrite of the devserver's service definition keeps the `PATH`
/// the installed one records rather than `current`, this process's own.
///
/// The recorded `PATH` is the service's `PATH` for every extension and
/// terminal it spawns, so only a render from a terminal replaces it. A
/// render with no terminal on standard input (a desktop connect script, any
/// other script) keeps it, so a non-interactive `PATH` never replaces a login
/// one, and so does a terminal render whose `PATH` has no usable entry,
/// rather than dropping the line. With nothing recorded, every render records
/// its own.
pub(super) fn keeps_recorded_service_path(current: &std::ffi::OsStr, interactive: bool) -> bool {
    !interactive || chan_systemd::service_search_path(current).is_none()
}

/// The `CHAN_HOME` override to bake into a supervised service's environment, if
/// set to a non-empty value. systemd/launchd start the service with a fresh
/// environment (not the supervisor's), so a devserver launched under `CHAN_HOME`
/// must carry it into the unit/plist, otherwise the service falls back to the
/// real `~/.chan` while the supervisor reads the isolated config, splitting the
/// token handshake. Mirrors how the log path already resolves through `CHAN_HOME`.
pub(super) fn devserver_chan_home() -> Option<String> {
    std::env::var("CHAN_HOME").ok().filter(|v| !v.is_empty())
}

/// `$XDG_CONFIG_HOME/systemd/user`, else `$HOME/.config/systemd/user`.
pub(super) fn systemd_user_unit_dir() -> Result<PathBuf> {
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

/// The user's home directory from `$HOME`, for the macOS launchd paths. Mirrors
/// the `$HOME` resolution the systemd unit-dir helper uses (no `dirs` dep).
fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .context("no HOME for the launchd agent paths")
}

/// `~/Library/LaunchAgents/app.chan.devserver.plist`.
pub(super) fn launch_agent_path() -> Result<PathBuf> {
    Ok(home_dir()?
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{DEVSERVER_LAUNCHD_LABEL}.plist")))
}

/// `~/.chan/devserver/devserver.log` -- where the agent's stdout/stderr land
/// (launchd has no journal). Co-located with the 0600 devserver config. Routed
/// through the single chan-home authority (`config_dir`) so `CHAN_HOME` moves it.
pub(crate) fn devserver_log_path() -> Result<PathBuf> {
    Ok(chan_workspace::paths::config_dir()
        .join("devserver")
        .join("devserver.log"))
}

/// The `PATH` a LaunchAgent plist's `EnvironmentVariables` records, unescaped.
pub(super) fn recorded_launch_agent_search_path(plist: &str) -> Option<String> {
    let (_, environment) = plist.split_once("<key>EnvironmentVariables</key>")?;
    let (environment, _) = environment.split_once("</dict>")?;
    let (_, value) = environment.split_once("<key>PATH</key>")?;
    let (value, _) = value
        .trim_start()
        .strip_prefix("<string>")?
        .split_once("</string>")?;
    Some(unescape_plist_xml(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `stop`/`restart` address precedence: explicit flag > running
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
        // Old-form ExecStart (no run verb): units installed by an older chan must still parse.
        assert_eq!(
            devserver_addr_from_persisted_args(
                "[Service]\nExecStart=/usr/bin/chan devserver --bind=0.0.0.0 --port=9000\n"
            ),
            Some("0.0.0.0:9000".parse().unwrap())
        );
        assert_eq!(
            devserver_addr_from_persisted_args(
                "<key>ProgramArguments</key>\n<array>\n<string>--bind=192.168.1.5</string>\n\
                 <string>--port=8080</string>\n</array>"
            ),
            Some("192.168.1.5:8080".parse().unwrap())
        );
        assert_eq!(
            devserver_addr_from_persisted_args(
                "[Service]\nExecStart=/usr/bin/chan devserver --bind=0.0.0.0\n"
            ),
            None
        );
    }

    /// `status` command extraction: the systemd ExecStart value and the
    /// launchd ProgramArguments joined (with plist `<string>` values unescaped).
    #[test]
    fn status_command_extracts_per_backend() {
        let unit = "[Service]\nExecStart=/usr/bin/chan devserver run --bind=0.0.0.0 --port=9000\nRestart=on-failure\n";
        assert_eq!(
            systemd_execstart_line(unit).as_deref(),
            Some("/usr/bin/chan devserver run --bind=0.0.0.0 --port=9000")
        );
        let plist = "<array>\n  <string>/usr/bin/chan</string>\n  <string>devserver</string>\n  <string>run</string>\n  <string>--bind=0.0.0.0</string>\n  <string>--port=9000</string>\n</array>";
        assert_eq!(
            launchd_program_arguments(plist).as_deref(),
            Some("/usr/bin/chan devserver run --bind=0.0.0.0 --port=9000")
        );
        let escaped = "<array><string>/a&amp;b/chan</string><string>devserver</string></array>";
        assert_eq!(
            launchd_program_arguments(escaped).as_deref(),
            Some("/a&b/chan devserver")
        );
    }

    #[test]
    fn persisted_flag_value_reads_tunnel_url_from_execstart() {
        // The "reuse first-run URL" read: pull --tunnel-url back out of a unit's
        // ExecStart line the way a flagless restart would.
        let unit = "ExecStart=/home/dev/.local/bin/chan devserver run \
                    --tunnel-url=https://first-run.test/v1/tunnel\n";
        assert_eq!(
            persisted_flag_value(unit, "--tunnel-url="),
            Some("https://first-run.test/v1/tunnel")
        );
    }
}
