//! The `cs tunnel` address spec: `[bind-address:]desktop-port:devserver-port`.
//!
//! Read it the way `ssh -R` is read from the machine the command runs on: the
//! LISTENER end comes first (it lives on the desktop), the DESTINATION end
//! second (it lives on this devserver host). The two ends have names here, so
//! the parser and every error message use those names instead of
//! "local"/"remote", which invert depending on which side of the tunnel the
//! reader is standing on.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};

/// Which transport the tunnel carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Proto {
    Tcp,
    Udp,
}

impl fmt::Display for Proto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Proto::Tcp => "tcp",
            Proto::Udp => "udp",
        })
    }
}

/// A parsed, validated tunnel request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelSpec {
    pub proto: Proto,
    /// Where the desktop binds its listener. Defaults to IPv4 loopback; an
    /// explicit non-loopback address parses (the caller warns) so this stays a
    /// policy decision at the edge rather than a parser rule.
    pub bind_addr: IpAddr,
    /// The desktop's listening port. `0` asks the OS for a free one, and the
    /// bound port comes back in the ready acknowledgement.
    pub desktop_port: u16,
    /// The port the devserver dials on its own loopback for each connection.
    pub devserver_port: u16,
}

impl TunnelSpec {
    /// Loopback default matching the roadmap item ("the listener should
    /// default to loopback").
    pub fn is_loopback_bind(&self) -> bool {
        self.bind_addr.is_loopback()
    }
}

impl fmt::Display for TunnelSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "desktop {} -> devserver 127.0.0.1:{} ({})",
            render_authority(self.bind_addr, self.desktop_port),
            self.devserver_port,
            self.proto
        )
    }
}

/// `host:port` with IPv6 bracketed, for messages and for the bound-address
/// string the desktop reports back.
pub fn render_authority(addr: IpAddr, port: u16) -> String {
    match addr {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    }
}

/// Why a spec did not parse. Each variant renders a message that names the
/// offending field, because the failure a user hits most is transposing the
/// two ports or forgetting one entirely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecError {
    Empty,
    MissingPorts,
    BadDesktopPort(String),
    BadDevserverPort(String),
    ZeroDevserverPort,
    BadBindAddress(String),
    UnclosedBracket,
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpecError::Empty => f.write_str("empty tunnel spec"),
            SpecError::MissingPorts => f.write_str(
                "expected [bind-address:]desktop-port:devserver-port, \
                 for example 8080:3000",
            ),
            SpecError::BadDesktopPort(v) => {
                write!(f, "invalid desktop port {v:?}: expected 0-65535")
            }
            SpecError::BadDevserverPort(v) => {
                write!(f, "invalid devserver port {v:?}: expected 1-65535")
            }
            SpecError::ZeroDevserverPort => f.write_str(
                "devserver port 0 has nothing to dial; name the port your \
                 server listens on",
            ),
            SpecError::BadBindAddress(v) => {
                write!(f, "invalid bind address {v:?}")
            }
            SpecError::UnclosedBracket => f.write_str("unclosed [ in the bind address"),
        }
    }
}

impl std::error::Error for SpecError {}

/// Parse `[bind-address:]desktop-port:devserver-port`.
///
/// The two trailing colon-separated fields are always the ports, so an IPv6
/// bind address is split off by its brackets first and everything before the
/// last two colons is the address. That ordering is what lets `::1` and
/// `[::1]:8080:3000` both behave.
pub fn parse_spec(input: &str, proto: Proto) -> Result<TunnelSpec, SpecError> {
    let s = input.trim();
    if s.is_empty() {
        return Err(SpecError::Empty);
    }

    // Peel a bracketed IPv6 literal off the front so its inner colons never
    // reach the port split.
    let (addr_part, rest) = if let Some(after) = s.strip_prefix('[') {
        let close = after.find(']').ok_or(SpecError::UnclosedBracket)?;
        let addr = &after[..close];
        let rest = after[close + 1..]
            .strip_prefix(':')
            .ok_or(SpecError::MissingPorts)?;
        (Some(addr), rest)
    } else {
        // The last two colon fields are the ports; anything before them is a
        // bare address (an unbracketed IPv6 literal included).
        match s.rmatch_indices(':').nth(1) {
            Some((idx, _)) => (Some(&s[..idx]), &s[idx + 1..]),
            None => (None, s),
        }
    };

    let (desktop_raw, devserver_raw) = rest.split_once(':').ok_or(SpecError::MissingPorts)?;
    if desktop_raw.is_empty() || devserver_raw.is_empty() {
        return Err(SpecError::MissingPorts);
    }

    let desktop_port = desktop_raw
        .parse::<u16>()
        .map_err(|_| SpecError::BadDesktopPort(desktop_raw.to_string()))?;
    let devserver_port = devserver_raw
        .parse::<u16>()
        .map_err(|_| SpecError::BadDevserverPort(devserver_raw.to_string()))?;
    if devserver_port == 0 {
        return Err(SpecError::ZeroDevserverPort);
    }

    let bind_addr = match addr_part {
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
        Some("") => return Err(SpecError::BadBindAddress(String::new())),
        Some(a) => a
            .parse::<IpAddr>()
            .map_err(|_| SpecError::BadBindAddress(a.to_string()))?,
    };

    Ok(TunnelSpec {
        proto,
        bind_addr,
        desktop_port,
        devserver_port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    fn tcp(s: &str) -> Result<TunnelSpec, SpecError> {
        parse_spec(s, Proto::Tcp)
    }

    #[test]
    fn bare_port_pair_defaults_to_ipv4_loopback() {
        let spec = tcp("8080:3000").unwrap();
        assert_eq!(spec.bind_addr, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(spec.desktop_port, 8080);
        assert_eq!(spec.devserver_port, 3000);
        assert!(spec.is_loopback_bind());
    }

    #[test]
    fn desktop_port_zero_is_an_ephemeral_bind_request() {
        assert_eq!(tcp("0:3000").unwrap().desktop_port, 0);
    }

    #[test]
    fn explicit_bind_address_is_taken_verbatim() {
        let spec = tcp("0.0.0.0:8080:3000").unwrap();
        assert_eq!(spec.bind_addr, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(!spec.is_loopback_bind());
    }

    #[test]
    fn bracketed_and_bare_ipv6_both_parse() {
        let bracketed = tcp("[::1]:8080:3000").unwrap();
        assert_eq!(bracketed.bind_addr, IpAddr::V6(Ipv6Addr::LOCALHOST));
        assert_eq!(bracketed.desktop_port, 8080);
        assert_eq!(bracketed.devserver_port, 3000);
        // Unbracketed: the last two colon fields are still the ports.
        let bare = tcp("::1:8080:3000").unwrap();
        assert_eq!(bare, bracketed);
    }

    #[test]
    fn missing_or_partial_port_pairs_are_rejected() {
        assert_eq!(tcp("8080").unwrap_err(), SpecError::MissingPorts);
        assert_eq!(tcp("8080:").unwrap_err(), SpecError::MissingPorts);
        assert_eq!(tcp(":3000").unwrap_err(), SpecError::MissingPorts);
        assert_eq!(tcp("").unwrap_err(), SpecError::Empty);
        assert_eq!(tcp("   ").unwrap_err(), SpecError::Empty);
    }

    #[test]
    fn out_of_range_and_non_numeric_ports_name_the_offending_end() {
        assert_eq!(
            tcp("70000:3000").unwrap_err(),
            SpecError::BadDesktopPort("70000".into())
        );
        assert_eq!(
            tcp("8080:70000").unwrap_err(),
            SpecError::BadDevserverPort("70000".into())
        );
        assert_eq!(
            tcp("http:3000").unwrap_err(),
            SpecError::BadDesktopPort("http".into())
        );
        assert_eq!(
            tcp("8080:-1").unwrap_err(),
            SpecError::BadDevserverPort("-1".into())
        );
    }

    #[test]
    fn devserver_port_zero_is_refused_because_there_is_nothing_to_dial() {
        assert_eq!(tcp("8080:0").unwrap_err(), SpecError::ZeroDevserverPort);
    }

    #[test]
    fn a_bad_bind_address_is_named() {
        assert_eq!(
            tcp("nope:8080:3000").unwrap_err(),
            SpecError::BadBindAddress("nope".into())
        );
        assert_eq!(
            tcp("[::1:8080:3000").unwrap_err(),
            SpecError::UnclosedBracket
        );
    }

    #[test]
    fn display_reads_desktop_end_first() {
        let spec = tcp("8080:3000").unwrap();
        assert_eq!(
            spec.to_string(),
            "desktop 127.0.0.1:8080 -> devserver 127.0.0.1:3000 (tcp)"
        );
    }

    #[test]
    fn authority_brackets_ipv6_only() {
        assert_eq!(
            render_authority(IpAddr::V4(Ipv4Addr::LOCALHOST), 80),
            "127.0.0.1:80"
        );
        assert_eq!(
            render_authority(IpAddr::V6(Ipv6Addr::LOCALHOST), 80),
            "[::1]:80"
        );
    }
}
