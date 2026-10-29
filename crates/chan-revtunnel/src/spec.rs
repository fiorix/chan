//! The `cs tunnel` address spec: `[bind-address:]desktop:devserver`, or one
//! side for both ends (`3000` reads as `3000:3000`). Each side is a port or an
//! inclusive range `first-last`, so one spec names one tunnel or many:
//! `8000-8010` pairs each desktop port with the same devserver port, and
//! `8000-8010:3000-3010` pairs the two ranges in order.
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
    /// A range whose first port is above its last.
    ReversedRange(String),
    /// A desktop range starting at 0: port 0 means "let the OS pick", which
    /// only reads as one listener, not as the first of a range.
    ZeroInDesktopRange(String),
    /// Two ranges of different lengths cannot be paired in order.
    RangeLengthMismatch {
        desktop: String,
        devserver: String,
        desktop_len: usize,
        devserver_len: usize,
    },
    /// One fixed desktop port cannot listen for every port of a devserver
    /// range; only port 0 (one OS-picked port each) pairs with a range.
    FixedDesktopPortWithRange {
        desktop_port: u16,
        devserver: String,
    },
}

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpecError::Empty => f.write_str("empty tunnel spec"),
            SpecError::MissingPorts => f.write_str(
                "expected [bind-address:]desktop-port:devserver-port or one \
                 port for both ends, for example 8080:3000 or 3000",
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
            SpecError::ReversedRange(v) => {
                write!(
                    f,
                    "reversed port range {v:?}: expected first-last with first <= last"
                )
            }
            SpecError::ZeroInDesktopRange(v) => write!(
                f,
                "desktop range {v:?} starts at 0; use 0 alone to let the OS pick one port"
            ),
            SpecError::RangeLengthMismatch {
                desktop,
                devserver,
                desktop_len,
                devserver_len,
            } => write!(
                f,
                "desktop range {desktop} has {desktop_len} ports, devserver range \
                 {devserver} has {devserver_len}; ranges pair in order and must \
                 have the same length"
            ),
            SpecError::FixedDesktopPortWithRange {
                desktop_port,
                devserver,
            } => write!(
                f,
                "desktop port {desktop_port} cannot listen for every port of \
                 {devserver}; use 0 to let the OS pick one port each, or a desktop \
                 range of the same length"
            ),
        }
    }
}

impl std::error::Error for SpecError {}

/// The address and the two raw port sides of a spec, split by the grammar
/// the single-pair and the list parsers share.
///
/// The two trailing colon-separated fields are always the port sides, so an
/// IPv6 bind address is split off by its brackets first and everything before
/// the last two colons is the address. That ordering is what lets `::1` and
/// `[::1]:8080:3000` both behave. A colon-free rest is the one-side shorthand
/// for both ends.
fn split_spec(input: &str) -> Result<(Option<&str>, &str, &str), SpecError> {
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

    // A colon-free rest is the one-side shorthand for both ends. The
    // shorthand never fires on a rest that still holds a colon, so
    // 1.2.3.4:8080 keeps failing as a bad desktop port.
    let (desktop_raw, devserver_raw) = match rest.split_once(':') {
        Some(pair) => pair,
        None => (rest, rest),
    };
    if desktop_raw.is_empty() || devserver_raw.is_empty() {
        return Err(SpecError::MissingPorts);
    }
    Ok((addr_part, desktop_raw, devserver_raw))
}

fn parse_bind_addr(addr_part: Option<&str>) -> Result<IpAddr, SpecError> {
    match addr_part {
        None => Ok(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some("") => Err(SpecError::BadBindAddress(String::new())),
        Some(a) => a
            .parse::<IpAddr>()
            .map_err(|_| SpecError::BadBindAddress(a.to_string())),
    }
}

/// Parse `[bind-address:]desktop-port:devserver-port`, or a lone port used
/// for both ends, into the one tunnel it names. A range on either side is not
/// a port here; [`parse_specs`] is the list grammar.
pub fn parse_spec(input: &str, proto: Proto) -> Result<TunnelSpec, SpecError> {
    let (addr_part, desktop_raw, devserver_raw) = split_spec(input)?;
    let desktop_port = desktop_raw
        .parse::<u16>()
        .map_err(|_| SpecError::BadDesktopPort(desktop_raw.to_string()))?;
    let devserver_port = devserver_raw
        .parse::<u16>()
        .map_err(|_| SpecError::BadDevserverPort(devserver_raw.to_string()))?;
    if devserver_port == 0 {
        return Err(SpecError::ZeroDevserverPort);
    }
    let bind_addr = parse_bind_addr(addr_part)?;
    Ok(TunnelSpec {
        proto,
        bind_addr,
        desktop_port,
        devserver_port,
    })
}

/// One side of a spec: a port, or an inclusive range of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PortSide {
    One(u16),
    Range(u16, u16),
}

impl PortSide {
    fn len(self) -> usize {
        match self {
            PortSide::One(_) => 1,
            PortSide::Range(first, last) => usize::from(last - first) + 1,
        }
    }

    fn ports(self) -> std::ops::RangeInclusive<u16> {
        match self {
            PortSide::One(port) => port..=port,
            PortSide::Range(first, last) => first..=last,
        }
    }
}

/// Parse one side as a port or a `first-last` range. `bad` builds the error
/// that names this side when neither reading parses.
fn parse_side(raw: &str, bad: fn(String) -> SpecError) -> Result<PortSide, SpecError> {
    if let Ok(port) = raw.parse::<u16>() {
        return Ok(PortSide::One(port));
    }
    let Some((first, last)) = raw.split_once('-') else {
        return Err(bad(raw.to_string()));
    };
    let (Ok(first), Ok(last)) = (first.parse::<u16>(), last.parse::<u16>()) else {
        return Err(bad(raw.to_string()));
    };
    if first > last {
        return Err(SpecError::ReversedRange(raw.to_string()));
    }
    Ok(PortSide::Range(first, last))
}

/// Parse `[bind-address:]desktop:devserver`, or one side for both ends, where
/// each side is a port or an inclusive `first-last` range, into every tunnel
/// it names, in port order.
///
/// Two ranges pair in order and must have the same length. A desktop port of
/// 0 pairs with every port of a devserver range (one OS-picked listener each);
/// any other fixed desktop port cannot, since one authority listens once. A
/// desktop range pairs with one fixed devserver port, as several specs may
/// name the same devserver port. The bind address applies to every tunnel.
pub fn parse_specs(input: &str, proto: Proto) -> Result<Vec<TunnelSpec>, SpecError> {
    let (addr_part, desktop_raw, devserver_raw) = split_spec(input)?;
    let desktop = parse_side(desktop_raw, SpecError::BadDesktopPort)?;
    let devserver = parse_side(devserver_raw, SpecError::BadDevserverPort)?;
    if devserver.ports().contains(&0) {
        return Err(SpecError::ZeroDevserverPort);
    }
    if matches!(desktop, PortSide::Range(0, _)) {
        return Err(SpecError::ZeroInDesktopRange(desktop_raw.to_string()));
    }
    let bind_addr = parse_bind_addr(addr_part)?;

    let pairs: Vec<(u16, u16)> = match (desktop, devserver) {
        (PortSide::One(0), PortSide::Range(..)) => {
            devserver.ports().map(|port| (0, port)).collect()
        }
        (PortSide::One(desktop_port), PortSide::Range(..)) => {
            return Err(SpecError::FixedDesktopPortWithRange {
                desktop_port,
                devserver: devserver_raw.to_string(),
            });
        }
        (PortSide::Range(..), PortSide::Range(..)) if desktop.len() != devserver.len() => {
            return Err(SpecError::RangeLengthMismatch {
                desktop: desktop_raw.to_string(),
                devserver: devserver_raw.to_string(),
                desktop_len: desktop.len(),
                devserver_len: devserver.len(),
            });
        }
        (PortSide::Range(..), PortSide::Range(..)) => {
            desktop.ports().zip(devserver.ports()).collect()
        }
        (PortSide::Range(..), PortSide::One(devserver_port)) => desktop
            .ports()
            .map(|desktop_port| (desktop_port, devserver_port))
            .collect(),
        (PortSide::One(desktop_port), PortSide::One(devserver_port)) => {
            vec![(desktop_port, devserver_port)]
        }
    };
    Ok(pairs
        .into_iter()
        .map(|(desktop_port, devserver_port)| TunnelSpec {
            proto,
            bind_addr,
            desktop_port,
            devserver_port,
        })
        .collect())
}

/// The first spec whose desktop listener another spec in the list already
/// names: the same bind address and the same fixed port. Port 0 never
/// collides, since the OS picks a fresh one per listener; the same devserver
/// port in two specs is two listeners for one service, which is fine.
pub fn duplicate_listener(specs: &[TunnelSpec]) -> Option<&TunnelSpec> {
    let mut seen = std::collections::HashSet::new();
    specs
        .iter()
        .filter(|spec| spec.desktop_port != 0)
        .find(|spec| !seen.insert((spec.bind_addr, spec.desktop_port)))
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
    fn lone_port_expands_to_both_ends() {
        let spec = tcp("3000").unwrap();
        assert_eq!(spec.bind_addr, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(spec.desktop_port, 3000);
        assert_eq!(spec.devserver_port, 3000);
        assert_eq!(
            spec.to_string(),
            "desktop 127.0.0.1:3000 -> devserver 127.0.0.1:3000 (tcp)"
        );

        // The shorthand composes with a bracketed bind address.
        let v6 = tcp("[::1]:3000").unwrap();
        assert_eq!(v6.bind_addr, IpAddr::V6(Ipv6Addr::LOCALHOST));
        assert_eq!(v6.desktop_port, 3000);
        assert_eq!(v6.devserver_port, 3000);

        // A lone zero expands to devserver port 0, which has nothing to dial.
        assert_eq!(tcp("0").unwrap_err(), SpecError::ZeroDevserverPort);

        // The shorthand never fires on a rest that still holds a colon, so
        // an IPv4 literal with one port stays a bad desktop port.
        assert_eq!(
            tcp("1.2.3.4:8080").unwrap_err(),
            SpecError::BadDesktopPort("1.2.3.4".into())
        );
    }

    #[test]
    fn missing_or_partial_port_pairs_are_rejected() {
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

    fn tcp_list(s: &str) -> Result<Vec<TunnelSpec>, SpecError> {
        parse_specs(s, Proto::Tcp)
    }

    fn ends(specs: &[TunnelSpec]) -> Vec<(u16, u16)> {
        specs
            .iter()
            .map(|spec| (spec.desktop_port, spec.devserver_port))
            .collect()
    }

    #[test]
    fn a_single_pair_is_one_tunnel_through_both_parsers() {
        assert_eq!(
            tcp_list("8080:3000").unwrap(),
            vec![tcp("8080:3000").unwrap()]
        );
        assert_eq!(tcp_list("3000").unwrap(), vec![tcp("3000").unwrap()]);
        assert_eq!(
            tcp_list("[::1]:3000").unwrap(),
            vec![tcp("[::1]:3000").unwrap()]
        );
    }

    #[test]
    fn ranges_expand_in_port_order() {
        // One side for both ends pairs each port with itself.
        assert_eq!(
            ends(&tcp_list("8000-8002").unwrap()),
            vec![(8000, 8000), (8001, 8001), (8002, 8002)]
        );
        // Two ranges pair in order.
        assert_eq!(
            ends(&tcp_list("8000-8002:3000-3002").unwrap()),
            vec![(8000, 3000), (8001, 3001), (8002, 3002)]
        );
        // Port 0 pairs with every devserver port: one OS-picked listener each.
        assert_eq!(
            ends(&tcp_list("0:3000-3002").unwrap()),
            vec![(0, 3000), (0, 3001), (0, 3002)]
        );
        // A desktop range may fan in to one devserver port.
        assert_eq!(
            ends(&tcp_list("8000-8001:3000").unwrap()),
            vec![(8000, 3000), (8001, 3000)]
        );
        // A range of one is the pair.
        assert_eq!(
            ends(&tcp_list("8000-8000:3000").unwrap()),
            vec![(8000, 3000)]
        );
        // The bind address applies to every tunnel the spec expands to.
        let v6 = tcp_list("[::1]:8000-8001").unwrap();
        assert_eq!(v6.len(), 2);
        assert!(v6
            .iter()
            .all(|spec| spec.bind_addr == IpAddr::V6(Ipv6Addr::LOCALHOST)));
        let bare = tcp_list("0.0.0.0:8000-8001:3000-3001").unwrap();
        assert!(bare
            .iter()
            .all(|spec| spec.bind_addr == IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
    }

    #[test]
    fn range_rules_are_refused_with_the_named_side() {
        assert_eq!(
            tcp_list("8000-8005:3000-3010").unwrap_err(),
            SpecError::RangeLengthMismatch {
                desktop: "8000-8005".into(),
                devserver: "3000-3010".into(),
                desktop_len: 6,
                devserver_len: 11,
            }
        );
        assert_eq!(
            tcp_list("8010-8000").unwrap_err(),
            SpecError::ReversedRange("8010-8000".into())
        );
        assert_eq!(
            tcp_list("8000:3010-3000").unwrap_err(),
            SpecError::ReversedRange("3010-3000".into())
        );
        assert_eq!(
            tcp_list("8000:3000-3010").unwrap_err(),
            SpecError::FixedDesktopPortWithRange {
                desktop_port: 8000,
                devserver: "3000-3010".into(),
            }
        );
        // A devserver side that includes 0 has nothing to dial, as the lone
        // zero shorthand does.
        assert_eq!(tcp_list("0-10").unwrap_err(), SpecError::ZeroDevserverPort);
        assert_eq!(
            tcp_list("8000-8010:0-10").unwrap_err(),
            SpecError::ZeroDevserverPort
        );
        // A desktop range cannot start at the OS-pick port.
        assert_eq!(
            tcp_list("0-10:3000-3010").unwrap_err(),
            SpecError::ZeroInDesktopRange("0-10".into())
        );
        // Malformed ranges name the side as a bad port.
        assert_eq!(
            tcp_list("8000-x:3000").unwrap_err(),
            SpecError::BadDesktopPort("8000-x".into())
        );
        assert_eq!(
            tcp_list("8000:3000-").unwrap_err(),
            SpecError::BadDevserverPort("3000-".into())
        );
        assert_eq!(
            tcp_list("8000-70000").unwrap_err(),
            SpecError::BadDesktopPort("8000-70000".into())
        );
        // The single-pair parser reads no range at all.
        assert_eq!(
            tcp("8000-8010").unwrap_err(),
            SpecError::BadDesktopPort("8000-8010".into())
        );
    }

    #[test]
    fn duplicate_listener_names_the_repeated_desktop_authority() {
        let specs = |inputs: &[&str]| -> Vec<TunnelSpec> {
            inputs.iter().map(|s| tcp(s).unwrap()).collect()
        };
        let repeated = specs(&["8080:3000", "8081:3001", "8080:3002"]);
        assert_eq!(duplicate_listener(&repeated), Some(&repeated[2]));
        // The OS picks a fresh port per listener, so port 0 never collides.
        assert_eq!(duplicate_listener(&specs(&["0:3000", "0:3001"])), None);
        // Two listeners for one service is fine.
        assert_eq!(
            duplicate_listener(&specs(&["8080:3000", "8081:3000"])),
            None
        );
        // A different bind address is a different listener.
        assert_eq!(
            duplicate_listener(&specs(&["8080:3000", "[::1]:8080:3000"])),
            None
        );
        assert_eq!(duplicate_listener(&[]), None);
    }
}
