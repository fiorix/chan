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
//!
//! [`read_file`] is how a consumer gets from a path to a [`Config`]: it
//! refuses a file other users can read before reading it, and its errors
//! name the path, the line and the key, never a value.

use crate::x25519::{PublicKey, StaticSecret};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::fmt;
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

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

impl Endpoint {
    /// `host:port`, with an IPv6 literal in brackets, as a file's
    /// `Endpoint` reads; the error names no line (0).
    pub fn parse(value: &str) -> Result<Endpoint, ConfigError> {
        parse_endpoint(value, 0)
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

/// Why a file was refused by [`read_file`]. Every message names the path;
/// a parse refusal adds the line and the key, and nothing ever carries a
/// value, since a value may be a key.
#[derive(Debug)]
pub enum ReadError {
    /// The file could not be read: absent, unreadable, not UTF-8.
    Io { path: PathBuf, source: io::Error },
    /// The file is readable by the group or others. It holds the tunnel's
    /// private key, so it is refused before its contents are read, as ssh
    /// refuses a shared private key.
    Shared { path: PathBuf, mode: u32 },
    /// The contents are not a configuration this stack honours.
    Parse { path: PathBuf, source: ConfigError },
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::Io { path, source } => write!(f, "{}: {source}", path.display()),
            ReadError::Shared { path, mode } => write!(
                f,
                "{path} is readable by the group or others (mode {mode:03o}); it holds the \
                 tunnel's private key, so narrow it first: chmod 600 {path}",
                path = path.display()
            ),
            ReadError::Parse { path, source } => write!(f, "{}: {source}", path.display()),
        }
    }
}

impl std::error::Error for ReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ReadError::Io { source, .. } => Some(source),
            ReadError::Shared { .. } => None,
            ReadError::Parse { source, .. } => Some(source),
        }
    }
}

impl ReadError {
    /// The refused file.
    pub fn path(&self) -> &Path {
        match self {
            ReadError::Io { path, .. }
            | ReadError::Shared { path, .. }
            | ReadError::Parse { path, .. } => path,
        }
    }
}

/// Read and parse the wg-quick file at `path`. The file's metadata is read
/// first and on Unix a file the group or others can read is refused before
/// its contents are; only then is the text read and handed to
/// [`Config::parse`]. Nothing from the file is logged or carried in an
/// error.
pub fn read_file(path: &Path) -> Result<Config, ReadError> {
    let io_error = |source| ReadError::Io {
        path: path.to_path_buf(),
        source,
    };
    let metadata = std::fs::metadata(path).map_err(io_error)?;
    refuse_shared(path, &metadata)?;
    let text = std::fs::read_to_string(path).map_err(io_error)?;
    Config::parse(&text).map_err(|source| ReadError::Parse {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(unix)]
fn refuse_shared(path: &Path, metadata: &std::fs::Metadata) -> Result<(), ReadError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(ReadError::Shared {
            path: path.to_path_buf(),
            mode,
        });
    }
    Ok(())
}

/// Windows has no mode bits to read; the file's ACL is the user's to set.
#[cfg(not(unix))]
fn refuse_shared(_path: &Path, _metadata: &std::fs::Metadata) -> Result<(), ReadError> {
    Ok(())
}

/// Write `config` to `path` as a wg-quick file that [`read_file`] reads
/// back field for field: `[Interface]` with `PrivateKey`, `Address` (the
/// addresses comma separated) and `MTU` when set, a blank line, then
/// `[Peer]` with `PublicKey`, `PresharedKey` when set, `Endpoint`,
/// `AllowedIPs` and `PersistentKeepalive` when set; keys are base64 as
/// `wg` prints them.
///
/// The file is created owner-only (mode 0600 on Unix; on Windows the
/// profile's ACL applies, as `read_file` accepts) and replaces any file at
/// `path` atomically: the text goes to a sibling created exclusively, is
/// synced, and is renamed over the target, so a reader never sees half a
/// file. An existing target that is not a regular file is refused with
/// `InvalidInput`, and on Unix one the group or others can read with
/// `PermissionDenied`: whoever shared it is not replaced silently. Errors
/// name the path, never a value.
pub fn write_file(path: &Path, config: &Config) -> io::Result<()> {
    if let Ok(existing) = std::fs::symlink_metadata(path) {
        if !existing.file_type().is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not a regular file", path.display()),
            ));
        }
        refuse_replacing_shared(path, &existing)?;
    }
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} names no file", path.display()),
        )
    })?;
    let mut staged_name = std::ffi::OsString::from(".");
    staged_name.push(name);
    staged_name.push(format!(".{}.tmp", std::process::id()));
    let staged = dir.join(staged_name);
    let written = write_staged(&staged, render(config).as_bytes())
        .and_then(|()| std::fs::rename(&staged, path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&staged);
        return Err(io::Error::new(
            e.kind(),
            format!("writing {}: {e}", path.display()),
        ));
    }
    sync_dir(dir);
    Ok(())
}

/// The file text [`write_file`] writes.
fn render(config: &Config) -> String {
    let join = |cidrs: &[Cidr]| {
        cidrs
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut text = format!(
        "[Interface]\nPrivateKey = {}\nAddress = {}\n",
        BASE64.encode(config.private_key.to_bytes()),
        join(&config.addresses)
    );
    if let Some(mtu) = config.mtu {
        text.push_str(&format!("MTU = {mtu}\n"));
    }
    let peer = &config.peer;
    text.push_str(&format!(
        "\n[Peer]\nPublicKey = {}\n",
        BASE64.encode(peer.public_key.as_bytes())
    ));
    if let Some(psk) = peer.preshared_key {
        text.push_str(&format!("PresharedKey = {}\n", BASE64.encode(psk)));
    }
    text.push_str(&format!(
        "Endpoint = {}\nAllowedIPs = {}\n",
        peer.endpoint,
        join(&peer.allowed_ips)
    ));
    if let Some(keepalive) = peer.persistent_keepalive {
        text.push_str(&format!("PersistentKeepalive = {keepalive}\n"));
    }
    text
}

fn write_staged(staged: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(staged)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Make the rename durable; a directory that cannot be opened for it (on
/// Windows, any) leaves the rename to the filesystem's own ordering.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(dir) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(unix)]
fn refuse_replacing_shared(path: &Path, metadata: &std::fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{path} is readable by the group or others (mode {mode:03o}), so it is not \
                 replaced; narrow it (chmod 600 {path}) or remove it first",
                path = path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn refuse_replacing_shared(_path: &Path, _metadata: &std::fs::Metadata) -> io::Result<()> {
    Ok(())
}

/// A public key as `wg` prints it (44 characters of base64) or as 64 hex
/// digits, the form a gateway publishes its interface's key in.
pub fn parse_public_key(value: &str) -> Result<PublicKey, ConfigError> {
    parse_key(value, 0, "public key").map(PublicKey::from)
}

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
    /// comment; values may be quoted the way `wg` writes them. Lines may
    /// end in CRLF, and a leading UTF-8 byte order mark is skipped: it is
    /// an encoding mark, not a setting, and Windows editors and
    /// PowerShell's `Out-File -Encoding utf8` write one.
    pub fn parse(text: &str) -> Result<Config, ConfigError> {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
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
        // Pairs of bytes, not string slices: a key can come from a gateway,
        // and a multibyte character would not split on a pair boundary.
        64 => value
            .as_bytes()
            .chunks(2)
            .map(|pair| {
                let digit = |byte: u8| char::from(byte).to_digit(16);
                match (digit(pair[0]), digit(pair[1])) {
                    (Some(high), Some(low)) => Ok((high * 16 + low) as u8),
                    _ => Err(err(line, format!("{what} is not valid hex"))),
                }
            })
            .collect::<Result<Vec<u8>, _>>()?,
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

    /// A file written on Windows: CRLF line endings and the byte order
    /// mark PowerShell 5.1's `Out-File -Encoding utf8` puts first.
    #[test]
    fn accepts_crlf_and_a_byte_order_mark() {
        let text = format!("\u{feff}{}", sample().replace('\n', "\r\n"));
        let cfg = Config::parse(&text).unwrap();
        assert_eq!(cfg.addresses[0].to_string(), "10.7.0.2/32");
        assert_eq!(cfg.peer.endpoint.to_string(), "vpn.example.org:51820");
        assert_eq!(cfg.peer.persistent_keepalive, Some(25));
        // A line still ends without a stray carriage return in its value.
        assert_eq!(cfg.mtu, Some(1380));
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

    /// Write `text` as an owner-only file, the shape `read_file` accepts,
    /// in a directory of its own.
    /// The section-8 file a gateway's enrollment parameters make.
    fn enrolled(addresses: &str, keepalive: Option<u16>) -> String {
        let mut text = format!(
            "[Interface]\nPrivateKey = {KEY_A}\nAddress = {addresses}\n\n[Peer]\nPublicKey = {KEY_B}\nEndpoint = wg.example.com:51820\nAllowedIPs = 10.7.0.1/32\n"
        );
        if let Some(seconds) = keepalive {
            text.push_str(&format!("PersistentKeepalive = {seconds}\n"));
        }
        text
    }

    #[test]
    fn write_file_writes_the_wg_quick_text_of_an_enrollment() {
        let dir = tempfile::tempdir().unwrap();
        for (addresses, keepalive) in [
            ("10.7.0.23/32", Some(25)),
            ("10.7.0.23/32, fd00:7::23/128", Some(25)),
            ("10.7.0.23/32", None),
            ("10.7.0.23/32, fd00:7::23/128", None),
        ] {
            let text = enrolled(addresses, keepalive);
            let path = dir.path().join("gw.conf");
            write_file(&path, &Config::parse(&text).unwrap()).unwrap();
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                text,
                "{addresses} {keepalive:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_file_creates_an_owner_only_file_and_replaces_one() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gw.conf");
        let config = Config::parse(&enrolled("10.7.0.23/32", Some(25))).unwrap();
        write_file(&path, &config).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        // An owner-only file is replaced, and no staged sibling is left.
        let second = Config::parse(&enrolled("10.7.0.24/32", None)).unwrap();
        write_file(&path, &second).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            enrolled("10.7.0.24/32", None)
        );
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("gw.conf")]);
    }

    #[cfg(unix)]
    #[test]
    fn write_file_refuses_to_replace_a_file_other_users_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gw.conf");
        std::fs::write(&path, "shared\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let config = Config::parse(&enrolled("10.7.0.23/32", Some(25))).unwrap();
        let err = write_file(&path, &config).expect_err("a shared file is not replaced");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
        assert!(err.to_string().contains("chmod 600"), "{err}");
        assert!(!err.to_string().contains(KEY_A), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "shared\n");
        // Nor is something that is not a regular file.
        let err = write_file(dir.path(), &config).expect_err("a directory is refused");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{err}");
    }

    #[test]
    fn write_file_round_trips_through_read_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("full.conf");
        let text = format!(
            "[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.7.0.2/32, fd00:7::2/128\nMTU = 1380\n[Peer]\nPublicKey = {KEY_B}\nPresharedKey = {KEY_A}\nEndpoint = [2001:db8::1]:51820\nAllowedIPs = 10.7.0.0/24, fd00:7::/64\nPersistentKeepalive = 15\n"
        );
        let original = Config::parse(&text).unwrap();
        write_file(&path, &original).unwrap();
        let back = read_file(&path).unwrap();
        assert_eq!(back.private_key.to_bytes(), original.private_key.to_bytes());
        assert_eq!(back.addresses, original.addresses);
        assert_eq!(back.mtu, Some(1380));
        assert_eq!(back.peer.public_key, original.peer.public_key);
        assert_eq!(back.peer.preshared_key, original.peer.preshared_key);
        assert_eq!(back.peer.endpoint, original.peer.endpoint);
        assert_eq!(back.peer.allowed_ips, original.peer.allowed_ips);
        assert_eq!(back.peer.persistent_keepalive, Some(15));
    }

    #[test]
    fn the_public_parsers_take_what_a_file_takes() {
        assert_eq!(
            parse_public_key(KEY_B).unwrap().as_bytes()[..],
            BASE64.decode(KEY_B).unwrap()[..]
        );
        for bad in [
            &KEY_B[..43],
            "not base64 at all, but forty-four chars long",
            "",
        ] {
            assert!(parse_public_key(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            Endpoint::parse("wg.example.com:51820").unwrap(),
            Endpoint {
                host: "wg.example.com".into(),
                port: 51820
            }
        );
        assert_eq!(Endpoint::parse("[fd00::1]:51820").unwrap().host, "fd00::1");
        for bad in [
            "wg.example.com",
            "wg.example.com:0",
            ":51820",
            "[fd00::1:51820",
        ] {
            assert!(Endpoint::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_hex_key_is_read_by_byte_pairs_and_refuses_what_is_not_hex() {
        let hex: String = BASE64
            .decode(KEY_B)
            .unwrap()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect();
        assert_eq!(
            parse_public_key(&hex).unwrap().as_bytes()[..],
            BASE64.decode(KEY_B).unwrap()[..]
        );
        // 64 bytes whose last character takes three: a pair boundary falls
        // inside it. A sign is not a digit either.
        let multibyte = format!("{}\u{20ac}", "a".repeat(61));
        assert_eq!(multibyte.len(), 64);
        let signed = format!("+f{}", &hex[2..]);
        for bad in [multibyte.as_str(), signed.as_str()] {
            assert_eq!(
                parse_public_key(bad).unwrap_err().to_string(),
                "public key is not valid hex",
                "{bad:?}"
            );
        }
        let file = format!("[Interface]\nPrivateKey = {KEY_A}\nAddress = 10.7.0.1/32\n\n[Peer]\nPublicKey = {multibyte}\nEndpoint = 127.0.0.1:51820\nAllowedIPs = 10.7.0.2/32\n");
        assert_eq!(
            Config::parse(&file).unwrap_err().to_string(),
            "line 6: PublicKey is not valid hex"
        );
    }

    fn owner_only_file(text: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chan.conf");
        std::fs::write(&path, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        (dir, path)
    }

    #[test]
    fn read_file_parses_an_owner_only_file() {
        let (_dir, path) = owner_only_file(&sample());
        let cfg = read_file(&path).unwrap();
        assert_eq!(cfg.peer.endpoint.to_string(), "vpn.example.org:51820");
        assert_eq!(cfg.addresses.len(), 2);
    }

    #[test]
    fn read_file_that_is_missing_names_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("absent.conf");
        let error = read_file(&path).unwrap_err();
        assert!(matches!(error, ReadError::Io { .. }), "{error:?}");
        assert_eq!(error.path(), path);
        let text = error.to_string();
        assert!(text.starts_with(&path.display().to_string()), "{text}");
    }

    #[test]
    fn read_file_with_a_bad_line_names_the_line_and_the_key_not_the_value() {
        let (_dir, path) = owner_only_file(&sample().replace("10.7.0.2/32", "nowhere"));
        let error = read_file(&path).unwrap_err();
        assert!(matches!(error, ReadError::Parse { .. }), "{error:?}");
        let text = error.to_string();
        assert!(text.contains(&path.display().to_string()), "{text}");
        assert!(text.contains("line 3"), "{text}");
        assert!(text.contains("Address"), "{text}");
        assert!(!text.contains(KEY_A), "{text}");
        // A malformed key is named by its key, never by its value.
        let (_dir, path) = owner_only_file(&sample().replace(KEY_A, &"A".repeat(44)));
        let text = read_file(&path).unwrap_err().to_string();
        assert!(text.contains("line 2"), "{text}");
        assert!(text.contains("PrivateKey"), "{text}");
        assert!(!text.contains("AAAA"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn read_file_readable_by_others_is_refused_naming_the_mode_fix() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, path) = owner_only_file(&sample());
        for mode in [0o640, 0o604, 0o644, 0o660] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            let error = read_file(&path).unwrap_err();
            assert!(matches!(error, ReadError::Shared { .. }), "{error:?}");
            let text = error.to_string();
            assert!(text.contains(&path.display().to_string()), "{text}");
            assert!(text.contains(&format!("mode {mode:03o}")), "{text}");
            assert!(
                text.contains(&format!("chmod 600 {}", path.display())),
                "{text}"
            );
            assert!(!text.contains(KEY_A), "{text}");
        }
        // Owner-only, read-only included, is accepted.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(read_file(&path).is_ok());
    }
}
