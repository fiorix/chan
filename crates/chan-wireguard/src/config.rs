//! The tunnel configuration, read from the subset of the wg-quick file
//! format chan implements.
//!
//! The format is the one `wg genkey`, `wg-quick` and every WireGuard
//! how-to already use, so an operator writes the client's file the way
//! they write the server's. The subset is what an in-process client can
//! honour: one `[Interface]` with the private key, the tunnel addresses
//! and an optional MTU, and exactly one `[Peer]` with its public key, an
//! optional preshared key, the endpoint, the allowed IPs and an optional
//! persistent keepalive. Everything wg-quick hands to the operating
//! system (DNS, Table, FwMark, the Pre/Post hooks, SaveConfig) is refused
//! by name rather than ignored: this stack owns no interface, no routes
//! and no resolver, and a file that asks for them is a file written for a
//! different client.

use crate::x25519::{PublicKey, StaticSecret};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::fmt;
use std::net::IpAddr;

/// A parsed configuration. `Debug` never prints key material.
pub struct Config {
    pub private_key: StaticSecret,
    /// The tunnel's own addresses, each with its prefix length.
    pub addresses: Vec<Cidr>,
    pub mtu: Option<u16>,
    pub peer: Peer,
}

/// The one peer a chan tunnel speaks to.
pub struct Peer {
    pub public_key: PublicKey,
    pub preshared_key: Option<[u8; 32]>,
    pub endpoint: Endpoint,
    /// Destinations the tunnel carries; a connection to any other address
    /// is refused rather than sent unencrypted.
    pub allowed_ips: Vec<Cidr>,
    pub persistent_keepalive: Option<u16>,
}

/// Where the peer listens. The host may be a name; resolving it is the
/// driver's job, at dial time, so a changed record is picked up by a
/// reconnect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// An address with a prefix length, as in `10.7.0.2/32`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub prefix: u8,
}

impl Cidr {
    /// Whether `ip` falls inside this prefix; a v4 prefix never contains a
    /// v6 address and the reverse.
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = prefix_mask_v4(self.prefix);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = prefix_mask_v6(self.prefix);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

fn prefix_mask_v4(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    }
}

fn prefix_mask_v6(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - u32::from(prefix))
    }
}

impl fmt::Display for Cidr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.host.contains(':') {
            write!(f, "[{}]:{}", self.host, self.port)
        } else {
            write!(f, "{}:{}", self.host, self.port)
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("private_key", &"<redacted>")
            .field("addresses", &self.addresses)
            .field("mtu", &self.mtu)
            .field("peer", &self.peer)
            .finish()
    }
}

impl fmt::Debug for Peer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Peer")
            .field("public_key", &BASE64.encode(self.public_key.as_bytes()))
            .field("preshared_key", &self.preshared_key.map(|_| "<redacted>"))
            .field("endpoint", &self.endpoint)
            .field("allowed_ips", &self.allowed_ips)
            .field("persistent_keepalive", &self.persistent_keepalive)
            .finish()
    }
}

/// Why a configuration text was refused. Messages name the line and the
/// key but never a value, since a value may be a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.line == 0 {
            f.write_str(&self.message)
        } else {
            write!(f, "line {}: {}", self.line, self.message)
        }
    }
}

impl std::error::Error for ConfigError {}

fn err(line: usize, message: impl Into<String>) -> ConfigError {
    ConfigError {
        line,
        message: message.into(),
    }
}

/// Settings wg-quick implements by configuring the operating system. The
/// stack cannot honour them, so a file carrying one is refused with the
/// reason instead of running with part of it ignored.
const OS_ONLY_INTERFACE_KEYS: &[(&str, &str)] = &[
    (
        "DNS",
        "the stack has no resolver; name the endpoint by address or resolve it yourself",
    ),
    ("Table", "the stack installs no routes"),
    ("FwMark", "the stack owns no interface"),
    ("PreUp", "hooks run nothing here"),
    ("PostUp", "hooks run nothing here"),
    ("PreDown", "hooks run nothing here"),
    ("PostDown", "hooks run nothing here"),
    ("SaveConfig", "the file is never written back"),
    (
        "ListenPort",
        "the client binds an ephemeral port and never listens for peers",
    ),
];

#[derive(Default)]
struct InterfaceDraft {
    private_key: Option<StaticSecret>,
    addresses: Vec<Cidr>,
    mtu: Option<u16>,
}

#[derive(Default)]
struct PeerDraft {
    public_key: Option<PublicKey>,
    preshared_key: Option<[u8; 32]>,
    endpoint: Option<Endpoint>,
    allowed_ips: Vec<Cidr>,
    persistent_keepalive: Option<u16>,
    first_line: usize,
}

enum Section {
    None,
    Interface,
    Peer,
}

impl Config {
    /// Parse a wg-quick style text. Section and key names are matched
    /// without regard to case, as wg-quick matches them; `#` starts a
    /// comment; values may be quoted the way `wg` writes them.
    pub fn parse(text: &str) -> Result<Config, ConfigError> {
        let mut interface: Option<InterfaceDraft> = None;
        let mut peers: Vec<PeerDraft> = Vec::new();
        let mut section = Section::None;

        for (index, raw) in text.lines().enumerate() {
            let line_no = index + 1;
            let line = match raw.split_once('#') {
                Some((before, _)) => before,
                None => raw,
            }
            .trim();
            if line.is_empty() {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                section = match name.trim().to_ascii_lowercase().as_str() {
                    "interface" => {
                        if interface.is_some() {
                            return Err(err(line_no, "a second [Interface] section"));
                        }
                        interface = Some(InterfaceDraft::default());
                        Section::Interface
                    }
                    "peer" => {
                        peers.push(PeerDraft {
                            first_line: line_no,
                            ..PeerDraft::default()
                        });
                        Section::Peer
                    }
                    _ => {
                        return Err(err(
                            line_no,
                            "unknown section; expected [Interface] or [Peer]",
                        ))
                    }
                };
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                return Err(err(line_no, "expected `Key = value`"));
            };
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            match section {
                Section::None => return Err(err(line_no, "a setting before any section")),
                Section::Interface => {
                    let draft = interface.as_mut().expect("section tracks the draft");
                    parse_interface_key(draft, key, value, line_no)?;
                }
                Section::Peer => {
                    let draft = peers.last_mut().expect("section tracks the draft");
                    parse_peer_key(draft, key, value, line_no)?;
                }
            }
        }

        let interface = interface.ok_or_else(|| err(0, "no [Interface] section"))?;
        let private_key = interface
            .private_key
            .ok_or_else(|| err(0, "[Interface] has no PrivateKey"))?;
        if interface.addresses.is_empty() {
            return Err(err(0, "[Interface] has no Address"));
        }
        let mut peers = peers.into_iter();
        let peer = peers.next().ok_or_else(|| err(0, "no [Peer] section"))?;
        if let Some(extra) = peers.next() {
            return Err(err(
                extra.first_line,
                "a second [Peer]; a chan tunnel speaks to exactly one peer",
            ));
        }
        let peer_line = peer.first_line;
        let public_key = peer
            .public_key
            .ok_or_else(|| err(peer_line, "[Peer] has no PublicKey"))?;
        let endpoint = peer.endpoint.ok_or_else(|| {
            err(
                peer_line,
                "[Peer] has no Endpoint; the client must know whom to dial",
            )
        })?;
        if peer.allowed_ips.is_empty() {
            return Err(err(
                peer_line,
                "[Peer] has no AllowedIPs; nothing would be routed",
            ));
        }
        Ok(Config {
            private_key,
            addresses: interface.addresses,
            mtu: interface.mtu,
            peer: Peer {
                public_key,
                preshared_key: peer.preshared_key,
                endpoint,
                allowed_ips: peer.allowed_ips,
                persistent_keepalive: peer.persistent_keepalive,
            },
        })
    }

    /// The tunnel's own public key, for the operator to paste into the
    /// server's peer list.
    pub fn public_key(&self) -> PublicKey {
        PublicKey::from(&self.private_key)
    }
}

fn parse_interface_key(
    draft: &mut InterfaceDraft,
    key: &str,
    value: &str,
    line: usize,
) -> Result<(), ConfigError> {
    match key.to_ascii_lowercase().as_str() {
        "privatekey" => {
            if draft.private_key.is_some() {
                return Err(err(line, "PrivateKey given twice"));
            }
            draft.private_key = Some(StaticSecret::from(parse_key(value, line, "PrivateKey")?));
        }
        "address" => {
            for item in value.split(',') {
                draft
                    .addresses
                    .push(parse_cidr(item.trim(), line, "Address")?);
            }
        }
        "mtu" => {
            let mtu: u16 = value
                .parse()
                .map_err(|_| err(line, "MTU is not a number"))?;
            if !(576..=65535).contains(&mtu) {
                return Err(err(line, "MTU must be between 576 and 65535"));
            }
            draft.mtu = Some(mtu);
        }
        _ => {
            if let Some((name, reason)) = OS_ONLY_INTERFACE_KEYS
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
            {
                return Err(err(line, format!("{name} is not supported: {reason}")));
            }
            return Err(err(line, format!("unknown [Interface] key {key}")));
        }
    }
    Ok(())
}

fn parse_peer_key(
    draft: &mut PeerDraft,
    key: &str,
    value: &str,
    line: usize,
) -> Result<(), ConfigError> {
    match key.to_ascii_lowercase().as_str() {
        "publickey" => {
            if draft.public_key.is_some() {
                return Err(err(line, "PublicKey given twice"));
            }
            draft.public_key = Some(PublicKey::from(parse_key(value, line, "PublicKey")?));
        }
        "presharedkey" => {
            if draft.preshared_key.is_some() {
                return Err(err(line, "PresharedKey given twice"));
            }
            draft.preshared_key = Some(parse_key(value, line, "PresharedKey")?);
        }
        "endpoint" => {
            if draft.endpoint.is_some() {
                return Err(err(line, "Endpoint given twice"));
            }
            draft.endpoint = Some(parse_endpoint(value, line)?);
        }
        "allowedips" => {
            for item in value.split(',') {
                draft
                    .allowed_ips
                    .push(parse_cidr(item.trim(), line, "AllowedIPs")?);
            }
        }
        "persistentkeepalive" => {
            let secs: u16 = if value.eq_ignore_ascii_case("off") {
                0
            } else {
                value
                    .parse()
                    .map_err(|_| err(line, "PersistentKeepalive is not a number of seconds"))?
            };
            draft.persistent_keepalive = (secs > 0).then_some(secs);
        }
        _ => return Err(err(line, format!("unknown [Peer] key {key}"))),
    }
    Ok(())
}

/// A 32-byte key as `wg` prints it (base64) or as 64 hex digits.
fn parse_key(value: &str, line: usize, what: &str) -> Result<[u8; 32], ConfigError> {
    let bytes = match value.len() {
        64 => (0..32)
            .map(|i| u8::from_str_radix(&value[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| err(line, format!("{what} is not valid hex")))?,
        44 => BASE64
            .decode(value)
            .map_err(|_| err(line, format!("{what} is not valid base64")))?,
        _ => return Err(err(line, format!("{what} is not a 32-byte key"))),
    };
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| err(line, format!("{what} is not a 32-byte key")))?;
    Ok(key)
}

fn parse_cidr(item: &str, line: usize, what: &str) -> Result<Cidr, ConfigError> {
    let (addr, prefix) = match item.split_once('/') {
        Some((addr, prefix)) => {
            let prefix: u8 = prefix
                .parse()
                .map_err(|_| err(line, format!("{what}: prefix length is not a number")))?;
            (addr, Some(prefix))
        }
        None => (item, None),
    };
    let addr: IpAddr = addr
        .parse()
        .map_err(|_| err(line, format!("{what}: not an IP address")))?;
    let max = if addr.is_ipv4() { 32 } else { 128 };
    let prefix = prefix.unwrap_or(max);
    if prefix > max {
        return Err(err(line, format!("{what}: prefix length exceeds {max}")));
    }
    Ok(Cidr { addr, prefix })
}

fn parse_endpoint(value: &str, line: usize) -> Result<Endpoint, ConfigError> {
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, rest) = rest
            .split_once(']')
            .ok_or_else(|| err(line, "Endpoint: unterminated IPv6 literal"))?;
        let port = rest
            .strip_prefix(':')
            .ok_or_else(|| err(line, "Endpoint: missing port"))?;
        (host, port)
    } else {
        value
            .rsplit_once(':')
            .ok_or_else(|| err(line, "Endpoint: missing port"))?
    };
    if host.is_empty() {
        return Err(err(line, "Endpoint: missing host"));
    }
    let port: u16 = port
        .parse()
        .map_err(|_| err(line, "Endpoint: port is not a number"))?;
    if port == 0 {
        return Err(err(line, "Endpoint: port 0"));
    }
    Ok(Endpoint {
        host: host.to_string(),
        port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
    const KEY_B: &str = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

    fn sample() -> String {
        format!(
            "[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.7.0.2/32, fd00:7::2/128\nMTU = 1380\n\n[Peer]\nPublicKey = {KEY_B}\nEndpoint = vpn.example.org:51820\nAllowedIPs = 10.7.0.0/24, fd00:7::/64\nPersistentKeepalive = 25\n"
        )
    }

    #[test]
    fn parses_the_subset() {
        let cfg = Config::parse(&sample()).unwrap();
        assert_eq!(
            cfg.private_key.to_bytes(),
            BASE64.decode(KEY_A).unwrap()[..]
        );
        assert_eq!(cfg.addresses.len(), 2);
        assert_eq!(cfg.addresses[0].to_string(), "10.7.0.2/32");
        assert_eq!(cfg.addresses[1].to_string(), "fd00:7::2/128");
        assert_eq!(cfg.mtu, Some(1380));
        assert_eq!(
            cfg.peer.public_key.as_bytes()[..],
            BASE64.decode(KEY_B).unwrap()[..]
        );
        assert_eq!(cfg.peer.preshared_key, None);
        assert_eq!(
            cfg.peer.endpoint,
            Endpoint {
                host: "vpn.example.org".into(),
                port: 51820
            }
        );
        assert_eq!(cfg.peer.allowed_ips.len(), 2);
        assert_eq!(cfg.peer.persistent_keepalive, Some(25));
    }

    #[test]
    fn accepts_wg_showconf_spellings() {
        let text = format!(
            "# written by wg showconf\n[interface]\nprivatekey = \"{KEY_A}\" # trailing\naddress = 10.7.0.2\n[peer]\npublickey = {KEY_B}\npresharedkey = {KEY_A}\nendpoint = [2001:db8::1]:51820\nallowedips = 0.0.0.0/0\npersistentkeepalive = off\n"
        );
        let cfg = Config::parse(&text).unwrap();
        assert_eq!(cfg.addresses[0].prefix, 32);
        assert!(cfg.peer.preshared_key.is_some());
        assert_eq!(cfg.peer.endpoint.host, "2001:db8::1");
        assert_eq!(cfg.peer.endpoint.to_string(), "[2001:db8::1]:51820");
        assert_eq!(cfg.peer.persistent_keepalive, None);
        assert_eq!(cfg.peer.allowed_ips[0].prefix, 0);
    }

    #[test]
    fn accepts_hex_keys() {
        let hex = "00".repeat(31) + "01";
        let text = format!(
            "[Interface]\nPrivateKey = {hex}\nAddress = 10.0.0.1/32\n[Peer]\nPublicKey = {KEY_B}\nEndpoint = 1.2.3.4:5\nAllowedIPs = 10.0.0.0/8\n"
        );
        let cfg = Config::parse(&text).unwrap();
        assert_eq!(cfg.private_key.to_bytes()[31], 1);
    }

    fn refused(text: &str) -> ConfigError {
        Config::parse(text).expect_err("must be refused")
    }

    #[test]
    fn refuses_os_only_keys_by_name() {
        let text = sample().replace("MTU = 1380", "DNS = 1.1.1.1");
        let e = refused(&text);
        assert_eq!(e.line, 4);
        assert!(e.message.starts_with("DNS is not supported"), "{e}");
        let text = sample().replace("MTU = 1380", "PostUp = iptables -A FORWARD -i %i -j ACCEPT");
        assert!(refused(&text)
            .message
            .starts_with("PostUp is not supported"));
    }

    #[test]
    fn refuses_a_second_peer_and_missing_parts() {
        let two = sample() + "[Peer]\nPublicKey = " + KEY_A + "\nAllowedIPs = 10.9.0.0/24\n";
        let e = refused(&two);
        assert!(e.message.contains("second [Peer]"), "{e}");
        assert_eq!(e.line, 11);
        assert!(refused(&sample().replace("PrivateKey", "Privatekey2"))
            .message
            .contains("unknown [Interface] key"));
        let no_endpoint = sample().replace("Endpoint = vpn.example.org:51820\n", "");
        assert!(refused(&no_endpoint).message.contains("no Endpoint"));
        let no_allowed = sample().replace("AllowedIPs = 10.7.0.0/24, fd00:7::/64\n", "");
        assert!(refused(&no_allowed).message.contains("no AllowedIPs"));
        assert!(refused("[Peer]\nPublicKey = x\n")
            .message
            .contains("not a 32-byte key"));
        assert!(refused("PrivateKey = x\n")
            .message
            .contains("before any section"));
    }

    #[test]
    fn refuses_bad_values_without_echoing_them() {
        let bad_key = sample().replace(KEY_A, &"A".repeat(44));
        let e = refused(&bad_key);
        assert_eq!(e.line, 2);
        assert!(!e.message.contains("AAAA"));
        let bad_cidr = sample().replace("10.7.0.0/24", "10.7.0.0/33");
        assert!(refused(&bad_cidr).message.contains("exceeds 32"));
        let bad_port = sample().replace(":51820", ":0");
        assert!(refused(&bad_port).message.contains("port 0"));
        let no_port = sample().replace(":51820", "");
        assert!(refused(&no_port).message.contains("missing port"));
        let bad_mtu = sample().replace("MTU = 1380", "MTU = 100");
        assert!(refused(&bad_mtu).message.contains("MTU"));
    }

    #[test]
    fn cidr_contains() {
        let v4 = Cidr {
            addr: "10.7.0.0".parse().unwrap(),
            prefix: 24,
        };
        assert!(v4.contains("10.7.0.200".parse().unwrap()));
        assert!(!v4.contains("10.7.1.1".parse().unwrap()));
        assert!(!v4.contains("fd00:7::1".parse().unwrap()));
        let all = Cidr {
            addr: "0.0.0.0".parse().unwrap(),
            prefix: 0,
        };
        assert!(all.contains("8.8.8.8".parse().unwrap()));
        let v6 = Cidr {
            addr: "fd00:7::".parse().unwrap(),
            prefix: 64,
        };
        assert!(v6.contains("fd00:7::ffff".parse().unwrap()));
        assert!(!v6.contains("fd00:8::1".parse().unwrap()));
        let host = Cidr {
            addr: "fd00:7::2".parse().unwrap(),
            prefix: 128,
        };
        assert!(host.contains("fd00:7::2".parse().unwrap()));
        assert!(!host.contains("fd00:7::3".parse().unwrap()));
    }

    #[test]
    fn debug_redacts_keys() {
        let cfg = Config::parse(&sample().replace("MTU = 1380", "")).unwrap();
        let text = format!("{cfg:?}");
        assert!(!text.contains(KEY_A), "{text}");
        assert!(
            text.contains(KEY_B),
            "the public key is not a secret: {text}"
        );
        let with_psk = format!("{}PresharedKey = {KEY_A}\n", sample());
        let cfg = Config::parse(&with_psk).unwrap();
        assert!(!format!("{cfg:?}").contains(KEY_A));
    }
}
