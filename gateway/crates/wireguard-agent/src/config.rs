//! The agent's configuration, read from the environment. The packaged
//! `wireguard-agent.env` is the authoritative roster; `STATE_DIRECTORY` is
//! set by systemd from the unit's `StateDirectory=`.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use devserver_control_proto::ProxyId;
use url::Url;

/// Default seconds between two polls of identity.
pub const DEFAULT_POLL_SECS: u64 = 5;
/// The accepted poll interval, in seconds.
pub const POLL_SECS_RANGE: std::ops::RangeInclusive<u64> = 1..=60;

/// Linux `IFNAMSIZ` less the terminating NUL.
const MAX_INTERFACE_NAME: usize = 15;
/// Names `wg show` takes as words in an interface's place: `all` would list
/// every interface's peers, with interface names where keys belong.
const WG_SHOW_WORDS: [&str; 2] = ["all", "interfaces"];

#[derive(Debug, Clone)]
pub struct Config {
    /// identity's internal listener; the peer list is read from
    /// `/internal/v1/wireguard/peers` at this URL's scheme, host and port.
    pub identity_url: Url,
    /// The bearer identity checks on that route (`WIREGUARD_AGENT_TOKEN`).
    pub token: String,
    /// The `host` of the gateway's peer rows this agent applies.
    pub host_id: ProxyId,
    /// The one kernel interface this agent changes peers on.
    pub interface: String,
    /// Time between two polls.
    pub poll: Duration,
    /// The `wg` executable from wireguard-tools.
    pub wg_bin: PathBuf,
    /// Where the managed set (`peers.json`) is kept.
    pub state_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Parse from any variable lookup, so the rules are testable without
    /// touching the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let required = |name: &str| -> anyhow::Result<String> {
            let value = lookup(name).unwrap_or_default();
            let value = value.trim();
            if value.is_empty() {
                bail!("{name} is required");
            }
            Ok(value.to_string())
        };

        let identity_url: Url = required("IDENTITY_URL")?
            .parse()
            .context("IDENTITY_URL must be a URL")?;
        gateway_common::internal_transport::require_protected_http_url_with_mode(
            "IDENTITY_URL",
            &identity_url,
            lookup("CHAN_GATEWAY_INTERNAL_TRANSPORT").as_deref(),
        )?;

        let token = required("WIREGUARD_AGENT_TOKEN")?;
        if token.chars().any(char::is_whitespace) {
            bail!("WIREGUARD_AGENT_TOKEN must not contain whitespace");
        }

        let host_id = ProxyId::parse(required("WIREGUARD_AGENT_HOST_ID")?)
            .context("WIREGUARD_AGENT_HOST_ID must be one lowercase DNS label")?;

        let interface = required("WIREGUARD_INTERFACE")?;
        if !valid_interface_name(&interface) {
            bail!(
                "WIREGUARD_INTERFACE must be a network interface name of at most \
                 {MAX_INTERFACE_NAME} characters from [A-Za-z0-9_.-], not starting with '-'"
            );
        }
        if WG_SHOW_WORDS.contains(&interface.as_str()) {
            bail!(
                "WIREGUARD_INTERFACE must not be {interface:?}: `wg show` reads it as a word, \
                 not an interface name"
            );
        }

        let poll_secs = match lookup("WIREGUARD_AGENT_POLL_SECS") {
            Some(raw) if !raw.trim().is_empty() => raw
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|secs| POLL_SECS_RANGE.contains(secs))
                .with_context(|| {
                    format!(
                        "WIREGUARD_AGENT_POLL_SECS must be a whole number of seconds from {} to {}",
                        POLL_SECS_RANGE.start(),
                        POLL_SECS_RANGE.end()
                    )
                })?,
            _ => DEFAULT_POLL_SECS,
        };

        let wg_bin = match lookup("WIREGUARD_WG_BIN") {
            Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
            _ => PathBuf::from("wg"),
        };

        let state_dir = PathBuf::from(required("STATE_DIRECTORY")?);
        if !state_dir.is_absolute() {
            bail!("STATE_DIRECTORY must be an absolute path");
        }

        Ok(Self {
            identity_url,
            token,
            host_id,
            interface,
            poll: Duration::from_secs(poll_secs),
            wg_bin,
            state_dir,
        })
    }
}

/// An interface name `wg` takes as one argument and cannot read as an
/// option: the kernel's length limit and a conservative character set.
fn valid_interface_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_INTERFACE_NAME
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn base() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("IDENTITY_URL", "http://127.0.0.1:7004"),
            ("WIREGUARD_AGENT_TOKEN", "a1b2c3"),
            ("WIREGUARD_AGENT_HOST_ID", "p1"),
            ("WIREGUARD_INTERFACE", "wg0"),
            ("STATE_DIRECTORY", "/var/lib/chan-gateway/wireguard-agent"),
        ])
    }

    fn parse(vars: &HashMap<&'static str, &'static str>) -> anyhow::Result<Config> {
        Config::from_lookup(|name| vars.get(name).map(|v| v.to_string()))
    }

    fn error(vars: &HashMap<&'static str, &'static str>) -> String {
        format!("{:#}", parse(vars).expect_err("the config must be refused"))
    }

    #[test]
    fn a_complete_environment_parses_with_the_defaults() {
        let cfg = parse(&base()).unwrap();
        assert_eq!(cfg.identity_url.as_str(), "http://127.0.0.1:7004/");
        assert_eq!(cfg.host_id.as_str(), "p1");
        assert_eq!(cfg.interface, "wg0");
        assert_eq!(cfg.poll, Duration::from_secs(DEFAULT_POLL_SECS));
        assert_eq!(cfg.wg_bin, PathBuf::from("wg"));
        assert_eq!(
            cfg.state_dir,
            PathBuf::from("/var/lib/chan-gateway/wireguard-agent")
        );
    }

    #[test]
    fn each_missing_required_variable_is_named() {
        for name in [
            "IDENTITY_URL",
            "WIREGUARD_AGENT_TOKEN",
            "WIREGUARD_AGENT_HOST_ID",
            "WIREGUARD_INTERFACE",
            "STATE_DIRECTORY",
        ] {
            let mut vars = base();
            vars.remove(name);
            assert_eq!(error(&vars), format!("{name} is required"), "absent {name}");
            vars.insert(name, "  ");
            assert_eq!(error(&vars), format!("{name} is required"), "blank {name}");
        }
    }

    #[test]
    fn the_poll_interval_is_bounded() {
        for (raw, secs) in [("1", 1), ("60", 60), (" 7 ", 7)] {
            let mut vars = base();
            vars.insert("WIREGUARD_AGENT_POLL_SECS", raw);
            assert_eq!(parse(&vars).unwrap().poll, Duration::from_secs(secs));
        }
        for raw in ["0", "61", "-1", "5s", "1.5"] {
            let mut vars = base();
            vars.insert("WIREGUARD_AGENT_POLL_SECS", raw);
            assert!(
                error(&vars).starts_with("WIREGUARD_AGENT_POLL_SECS must be"),
                "poll {raw}: {}",
                error(&vars)
            );
        }
    }

    #[test]
    fn a_cleartext_non_loopback_identity_url_needs_the_overlay_assertion() {
        let mut vars = base();
        vars.insert("IDENTITY_URL", "http://10.0.0.5:7004");
        assert!(error(&vars).contains("IDENTITY_URL uses non-loopback cleartext"));
        vars.insert("CHAN_GATEWAY_INTERNAL_TRANSPORT", "protected-overlay");
        assert!(parse(&vars).is_ok());
        vars.remove("CHAN_GATEWAY_INTERNAL_TRANSPORT");
        vars.insert("IDENTITY_URL", "https://identity.internal:7004");
        assert!(parse(&vars).is_ok());
    }

    #[test]
    fn the_host_id_and_interface_are_checked() {
        for host in ["P1", "-p1", "p_1", "p1.example"] {
            let mut vars = base();
            vars.insert("WIREGUARD_AGENT_HOST_ID", host);
            assert!(
                error(&vars).starts_with("WIREGUARD_AGENT_HOST_ID must be"),
                "host {host}"
            );
        }
        for iface in ["-wg0", "wg 0", "wg/0", "..", "sixteen-chars-ab"] {
            let mut vars = base();
            vars.insert("WIREGUARD_INTERFACE", iface);
            assert!(
                error(&vars).starts_with("WIREGUARD_INTERFACE must be"),
                "iface {iface}"
            );
        }
        for word in ["all", "interfaces"] {
            let mut vars = base();
            vars.insert("WIREGUARD_INTERFACE", word);
            assert!(
                error(&vars).starts_with(&format!("WIREGUARD_INTERFACE must not be \"{word}\"")),
                "iface {word}: {}",
                error(&vars)
            );
        }
        let mut vars = base();
        vars.insert("WIREGUARD_INTERFACE", "chanwg1.x-y_z");
        assert_eq!(parse(&vars).unwrap().interface, "chanwg1.x-y_z");
    }

    #[test]
    fn the_wg_binary_and_state_directory_are_taken_as_given() {
        let mut vars = base();
        vars.insert("WIREGUARD_WG_BIN", "/usr/bin/wg");
        assert_eq!(parse(&vars).unwrap().wg_bin, PathBuf::from("/usr/bin/wg"));
        vars.insert("STATE_DIRECTORY", "relative/dir");
        assert_eq!(error(&vars), "STATE_DIRECTORY must be an absolute path");
    }
}
