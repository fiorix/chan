//! The WireGuard key pairs the desktop generates for its gateways.
//!
//! A gateway whose discovery offers enrollment gets a key pair of its own:
//! the private half in `<gateway id>.key` under the desktop's `wireguard`
//! directory (base64 and a newline), the public half on the gateway row,
//! where the launcher shows it and a sign-in sends it. Public tunnel
//! parameters live on the row and configurations are built in memory. The
//! directory is owner-only (0700) and so is each file (0600) on Unix; on
//! Windows the profile directory's ACL applies, as the file reader accepts.
//! The private key is read back only to build a tunnel, so it never
//! reaches the config, a log, the projection or a request.

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use base64::Engine;
use chan_wireguard::config::{parse_public_key, Cidr, Config, Endpoint, Peer};
use chan_wireguard::x25519::{PublicKey, StaticSecret};
use serde::Deserialize;

use crate::config::{WireguardEnrollment, WireguardHost, WireguardIngress};
use crate::devserver::WireguardDiscovery;

/// Synthetic identity for a single-peer answer. A real node can have this
/// label too, so its spelling alone does not establish its provenance.
pub(crate) const LEGACY_INGRESS_ID: &str = "legacy";

/// The key file of `gateway_id` under the key directory `dir`.
pub fn key_path(dir: &Path, gateway_id: &str) -> PathBuf {
    dir.join(format!("{gateway_id}.key"))
}

/// The client file of `gateway_id` under the key directory `dir`.
pub fn conf_path(dir: &Path, gateway_id: &str) -> PathBuf {
    dir.join(format!("{gateway_id}.conf"))
}

/// Generate an X25519 key pair for `gateway_id` from 32 bytes of the OS's
/// randomness, replace its key file under `dir` with the private half, and
/// answer the public half in base64 as `wg` prints it. An error names the
/// file and never the key.
pub fn generate(dir: &Path, gateway_id: &str) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    let secret = StaticSecret::from(bytes);
    let public = encode(PublicKey::from(&secret).as_bytes());
    let mut text = encode(&secret.to_bytes());
    text.push('\n');
    let path = key_path(dir, gateway_id);
    write_owner_only(dir, &path, text.as_bytes())
        .map_err(|e| format!("WireGuard: writing {}: {e}", path.display()))?;
    Ok(public)
}

/// Delete `gateway_id`'s key and client files under `dir`; a file that is
/// not there is not an error.
pub fn remove(dir: &Path, gateway_id: &str) -> io::Result<()> {
    for path in [key_path(dir, gateway_id), conf_path(dir, gateway_id)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// The parameters a gateway enrolled a key with, as the sign-in's redeem
/// answers them: the peer, the client's tunnel addresses, what the tunnel
/// carries, and the host names it routes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnrollmentParams {
    pub server_public_key: String,
    pub endpoint: String,
    pub addresses: Vec<String>,
    pub allowed_ips: Vec<String>,
    #[serde(default)]
    pub persistent_keepalive: Option<u16>,
    #[serde(default)]
    pub hosts: Vec<WireguardHost>,
    #[serde(default)]
    pub ingresses: Option<Vec<EnrollmentIngress>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnrollmentIngress {
    pub id: String,
    pub server_public_key: String,
    pub endpoint: String,
    pub hosts: Vec<WireguardHost>,
}

/// Validated enrollment parameters with the key they enroll and the
/// in-memory configuration of the first peer. Built and checked before the sign-in stores
/// anything, so a refused enrollment writes nothing.
pub struct Enrollment {
    /// The enrolled public key, base64 as it was sent.
    pub public_key: String,
    pub config: Config,
    pub ingresses: Vec<WireguardIngress>,
}

impl std::fmt::Debug for Enrollment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Enrollment")
            .field("public_key", &self.public_key)
            .field("config", &self.config)
            .field("ingresses", &self.ingresses)
            .finish()
    }
}

impl Enrollment {
    pub fn parameters(&self, key_file: PathBuf) -> WireguardEnrollment {
        WireguardEnrollment {
            key_file,
            addresses: self
                .config
                .addresses
                .iter()
                .map(ToString::to_string)
                .collect(),
            allowed_ips: self
                .config
                .peer
                .allowed_ips
                .iter()
                .map(ToString::to_string)
                .collect(),
            persistent_keepalive: self.config.peer.persistent_keepalive,
            ingresses: self.ingresses.clone(),
        }
    }
}

impl WireguardEnrollment {
    /// Build each node's tunnel from one key read. No file is written.
    pub fn configs(&self, enrolled_key: &str) -> Result<Vec<Config>, String> {
        let invalid = || "WireGuard: invalid enrolled tunnel parameters".to_string();
        let addresses = cidrs(&self.addresses)
            .filter(|v| !v.is_empty())
            .ok_or_else(invalid)?;
        let allowed_ips = cidrs(&self.allowed_ips)
            .filter(|v| !v.is_empty())
            .ok_or_else(invalid)?;
        if self.persistent_keepalive == Some(0) {
            return Err(invalid());
        }
        validate_ingresses(&self.ingresses, &allowed_ips).map_err(|_| invalid())?;
        let private_key = read_key_file(&self.key_file)?;
        if encode(PublicKey::from(&private_key).as_bytes()) != enrolled_key {
            return Err("WireGuard: the key file does not hold the enrolled key; connect again to enroll it".into());
        }
        self.ingresses
            .iter()
            .map(|ingress| {
                Ok(Config {
                    private_key: private_key.clone(),
                    addresses: addresses.clone(),
                    mtu: None,
                    peer: Peer {
                        public_key: parse_public_key(&ingress.public_key).map_err(|_| invalid())?,
                        preshared_key: None,
                        endpoint: Endpoint::parse(&ingress.endpoint).map_err(|_| invalid())?,
                        allowed_ips: allowed_ips.clone(),
                        persistent_keepalive: self.persistent_keepalive,
                    },
                })
            })
            .collect()
    }
}

/// Read an owned legacy enrollment without changing either key file.
pub(crate) fn migrate_file(
    dir: &Path,
    gateway_id: &str,
    enrolled_key: &str,
    hosts: &[WireguardHost],
) -> Result<Option<WireguardEnrollment>, String> {
    let config = chan_wireguard::config::read_file(&conf_path(dir, gateway_id))
        .map_err(|e| format!("WireGuard: {e}"))?;
    let key = read_key(dir, gateway_id)?;
    if config.private_key.to_bytes() != key.to_bytes()
        || encode(PublicKey::from(&key).as_bytes()) != enrolled_key
        || config.mtu.is_some()
        || config.peer.preshared_key.is_some()
    {
        return Ok(None);
    }
    let ingress = WireguardIngress {
        id: LEGACY_INGRESS_ID.into(),
        endpoint: config.peer.endpoint.to_string(),
        public_key: encode(config.peer.public_key.as_bytes()),
        hosts: hosts.to_vec(),
    };
    let enrollment = Enrollment {
        public_key: enrolled_key.into(),
        config,
        ingresses: vec![ingress],
    };
    let parameters = enrollment.parameters(key_path(dir, gateway_id));
    parameters.configs(enrolled_key)?;
    Ok(Some(parameters))
}

/// The refusal of a redeem whose peer is not the one discovery named.
pub const PEER_CHANGED: &str =
    "sign-in failed: the gateway's WireGuard peer changed during sign-in";

/// Check a redeem's parameters against what the sign-in sent and build a
/// configuration for `gateway_id` from its key file under `dir`. The peer's
/// key and endpoint must be the discovery entry's, the key file must still
/// hold the key that was sent (a key generated again during the sign-in is
/// refused), and every address must read as the file's grammar reads it.
/// An error is the sign-in's failure sentence and never carries a key.
pub fn prepare(
    dir: &Path,
    gateway_id: &str,
    sent_key: &str,
    entry: &WireguardDiscovery,
    params: &EnrollmentParams,
) -> Result<Enrollment, String> {
    entry.validate().map_err(|_| PEER_CHANGED.to_string())?;
    let peer_key = parse_public_key(&params.server_public_key).map_err(|_| PEER_CHANGED)?;
    let entry_key = parse_public_key(&entry.public_key).map_err(|_| PEER_CHANGED)?;
    let endpoint = Endpoint::parse(&params.endpoint).map_err(|_| PEER_CHANGED)?;
    if entry.ingresses.is_none()
        && (peer_key.as_bytes() != entry_key.as_bytes()
            || Endpoint::parse(&entry.endpoint).ok().as_ref() != Some(&endpoint))
    {
        return Err(PEER_CHANGED.to_string());
    }
    let ingresses = match (&entry.ingresses, &params.ingresses) {
        (Some(offered), Some(redeemed))
            if !redeemed.is_empty() && offered.len() == redeemed.len() =>
        {
            let first = &redeemed[0];
            if first.server_public_key != params.server_public_key
                || first.endpoint != params.endpoint
            {
                return Err(PEER_CHANGED.to_string());
            }
            let mut ids = std::collections::HashSet::new();
            let mut result = Vec::with_capacity(redeemed.len());
            for ingress in redeemed {
                if !ids.insert(&ingress.id)
                    || !offered.iter().any(|item| {
                        item.id == ingress.id
                            && item.public_key == ingress.server_public_key
                            && item.endpoint == ingress.endpoint
                    })
                {
                    return Err(PEER_CHANGED.to_string());
                }
                result.push(WireguardIngress {
                    id: ingress.id.clone(),
                    public_key: ingress.server_public_key.clone(),
                    endpoint: ingress.endpoint.clone(),
                    hosts: ingress.hosts.clone(),
                });
            }
            // Discovery owns the order so reordering a redeem does not
            // change the first route when AllowedIPs overlap.
            result.sort_by_key(|item| offered.iter().position(|entry| entry.id == item.id));
            result
        }
        (None, None) => vec![WireguardIngress {
            id: LEGACY_INGRESS_ID.into(),
            public_key: encode(peer_key.as_bytes()),
            endpoint: endpoint.to_string(),
            hosts: params.hosts.clone(),
        }],
        _ => return Err(PEER_CHANGED.to_string()),
    };
    let private_key = read_key(dir, gateway_id).map_err(|e| format!("sign-in failed: {e}"))?;
    if encode(PublicKey::from(&private_key).as_bytes()) != sent_key {
        return Err(
            "sign-in failed: the WireGuard key changed during sign-in; connect again to enroll it"
                .to_string(),
        );
    }
    let invalid = |what: &str| format!("sign-in failed: the gateway's WireGuard {what} is invalid");
    let addresses = cidrs(&params.addresses).ok_or_else(|| invalid("addresses"))?;
    let allowed_ips = cidrs(&params.allowed_ips).ok_or_else(|| invalid("allowed_ips"))?;
    if addresses.is_empty() {
        return Err(invalid("addresses"));
    }
    if allowed_ips.is_empty() {
        return Err(invalid("allowed_ips"));
    }
    if params.persistent_keepalive == Some(0) {
        return Err(invalid("persistent_keepalive"));
    }
    validate_ingresses(&ingresses, &allowed_ips).map_err(|_| invalid("ingresses"))?;
    let peer_key = parse_public_key(&ingresses[0].public_key).map_err(|_| PEER_CHANGED)?;
    let endpoint = Endpoint::parse(&ingresses[0].endpoint).map_err(|_| PEER_CHANGED)?;
    Ok(Enrollment {
        public_key: sent_key.to_string(),
        config: Config {
            private_key,
            addresses,
            mtu: None,
            peer: Peer {
                public_key: peer_key,
                preshared_key: None,
                endpoint,
                allowed_ips,
                persistent_keepalive: params.persistent_keepalive,
            },
        },
        ingresses,
    })
}

fn valid_label(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 63
        && !raw.starts_with('-')
        && !raw.ends_with('-')
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_dns_name(raw: &str) -> bool {
    raw.len() <= 253 && raw.split('.').all(valid_label)
}

/// The gateway's canonical key and endpoint grammars; wg-quick also reads
/// hex keys and other endpoint spellings that discovery must not offer.
pub(crate) fn valid_peer(key: &str, raw: &str) -> bool {
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(key) else {
        return false;
    };
    if bytes.len() != 32 || encode(&bytes) != key {
        return false;
    }
    let Ok(endpoint) = Endpoint::parse(raw) else {
        return false;
    };
    if raw
        .rsplit_once(':')
        .is_none_or(|(_, port)| port.starts_with('+'))
    {
        return false;
    }
    if raw.starts_with('[') {
        endpoint.host.parse::<std::net::Ipv6Addr>().is_ok()
    } else {
        valid_dns_name(&endpoint.host.to_ascii_lowercase())
    }
}

/// Validate every entry before a sign-in or discovery can persist it.
pub(crate) fn validate_ingresses(
    ingresses: &[WireguardIngress],
    allowed: &[Cidr],
) -> Result<(), ()> {
    if ingresses.is_empty() || allowed.is_empty() {
        return Err(());
    }
    let mut ids = std::collections::HashSet::new();
    for ingress in ingresses {
        if !valid_label(&ingress.id)
            || !ids.insert(&ingress.id)
            || !valid_peer(&ingress.public_key, &ingress.endpoint)
        {
            return Err(());
        }
        for host in &ingress.hosts {
            if !valid_dns_name(host.name.strip_prefix("*.").unwrap_or(&host.name))
                || host.addresses.is_empty()
                || host
                    .addresses
                    .iter()
                    .any(|ip| !allowed.iter().any(|net| net.contains(*ip)))
            {
                return Err(());
            }
        }
    }
    Ok(())
}

/// The bytes of the client file at `path`, `None` when there is none. They
/// hold a private key: they are kept only to recognize an obsolete file
/// before removing it, never shown.
pub fn read_client_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("WireGuard: reading {}: {e}", path.display())),
    }
}

/// The private key in `gateway_id`'s key file under `dir`.
fn read_key(dir: &Path, gateway_id: &str) -> Result<StaticSecret, String> {
    let path = key_path(dir, gateway_id);
    read_key_file(&path)
}

fn read_key_file(path: &Path) -> Result<StaticSecret, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(path)
            .map_err(|e| format!("WireGuard: reading {}: {e}", path.display()))?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!("WireGuard: {} must be owner-only", path.display()));
        }
    }
    let unreadable = || {
        format!(
            "WireGuard: {} does not hold a key; generate one again",
            path.display()
        )
    };
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("WireGuard: reading {}: {e}", path.display()))?;
    let bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(text.trim_end_matches('\n'))
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(unreadable)?;
    Ok(StaticSecret::from(bytes))
}

/// Addresses with prefix lengths as the file reader reads them: an address
/// alone is a host prefix. `None` when one does not read.
pub(crate) fn cidrs(items: &[String]) -> Option<Vec<Cidr>> {
    items
        .iter()
        .map(|item| {
            let (addr, prefix) = match item.split_once('/') {
                Some((addr, prefix)) => (addr, Some(prefix.parse::<u8>().ok()?)),
                None => (item.as_str(), None),
            };
            let addr: IpAddr = addr.parse().ok()?;
            let max = if addr.is_ipv4() { 32 } else { 128 };
            let prefix = prefix.unwrap_or(max);
            (prefix <= max).then_some(Cidr { addr, prefix })
        })
        .collect()
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Replace `path` inside `dir` with `bytes` through the config's atomic
/// write, the directory and the file narrowed to the owner. The staged file
/// is created owner-only and the directory admits no one else, so the key
/// is never readable by another user, even while an old file's mode carries
/// across the rename.
fn write_owner_only(dir: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    chan_workspace::fs_ops::atomic_write(path, bytes)
        .map_err(|e| io::Error::other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The public key the private key in `path` derives.
    fn derived_public(path: &Path) -> String {
        let text = std::fs::read_to_string(path).unwrap();
        let line = text
            .strip_suffix('\n')
            .expect("the key ends with a newline");
        let bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(line)
            .unwrap()
            .try_into()
            .unwrap();
        encode(PublicKey::from(&StaticSecret::from(bytes)).as_bytes())
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn generate_writes_an_owner_only_key_and_answers_its_public_half() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("desktop").join("wireguard");
        let public = generate(&dir, "gw-1a2b3c4d").unwrap();
        let key = key_path(&dir, "gw-1a2b3c4d");
        assert_eq!(key, dir.join("gw-1a2b3c4d.key"));
        assert_eq!(derived_public(&key), public);
        assert_eq!(public.len(), 44);
        assert!(!std::fs::read_to_string(&key).unwrap().contains(&public));
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&key), 0o600);
        }
        // Nothing but the key file is left in the directory.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("gw-1a2b3c4d.key")]);
    }

    #[test]
    fn generate_again_replaces_the_key_and_narrows_a_loose_file() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let first = generate(&dir, "gw-1a2b3c4d").unwrap();
        let key = key_path(&dir, "gw-1a2b3c4d");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let second = generate(&dir, "gw-1a2b3c4d").unwrap();
        assert_ne!(first, second);
        assert_eq!(derived_public(&key), second);
        #[cfg(unix)]
        {
            assert_eq!(mode(&dir), 0o700);
            assert_eq!(mode(&key), 0o600);
        }
    }

    #[test]
    fn a_client_file_written_from_the_key_derives_its_public_half() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let public = generate(&dir, "gw-1a2b3c4d").unwrap();
        let text = std::fs::read_to_string(key_path(&dir, "gw-1a2b3c4d")).unwrap();
        let server = encode(PublicKey::from(&StaticSecret::from([7u8; 32])).as_bytes());
        let config = chan_wireguard::config::Config::parse(&format!(
            "[Interface]\nPrivateKey = {}\nAddress = 10.7.0.23/32\n[Peer]\nPublicKey = {server}\nEndpoint = wg.chan.app:51820\nAllowedIPs = 10.7.0.1/32\n",
            text.trim_end(),
        ))
        .unwrap();
        let conf = conf_path(&dir, "gw-1a2b3c4d");
        chan_wireguard::config::write_file(&conf, &config).unwrap();
        let read = chan_wireguard::config::read_file(&conf).unwrap();
        assert_eq!(
            encode(PublicKey::from(&read.private_key).as_bytes()),
            public
        );
    }

    #[test]
    fn remove_deletes_both_files_and_tolerates_their_absence() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        generate(&dir, "gw-1a2b3c4d").unwrap();
        generate(&dir, "gw-99999999").unwrap();
        std::fs::write(conf_path(&dir, "gw-1a2b3c4d"), "conf").unwrap();
        remove(&dir, "gw-1a2b3c4d").unwrap();
        assert!(!key_path(&dir, "gw-1a2b3c4d").exists());
        assert!(!conf_path(&dir, "gw-1a2b3c4d").exists());
        // Another gateway's key stays.
        assert!(key_path(&dir, "gw-99999999").exists());
        remove(&dir, "gw-1a2b3c4d").unwrap();
        remove(&home.path().join("never"), "gw-1a2b3c4d").unwrap();
    }

    const SERVER_KEY: &str = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

    fn entry() -> WireguardDiscovery {
        WireguardDiscovery {
            allowed_ips: None,
            persistent_keepalive: None,
            ingresses: None,
            endpoint: "wg.chan.app:51820".into(),
            public_key: SERVER_KEY.into(),
        }
    }

    fn params() -> EnrollmentParams {
        EnrollmentParams {
            ingresses: None,
            server_public_key: SERVER_KEY.into(),
            endpoint: "wg.chan.app:51820".into(),
            addresses: vec!["10.7.0.23/32".into(), "fd00:7::23/128".into()],
            allowed_ips: vec!["10.7.0.1/32".into()],
            persistent_keepalive: Some(25),
            hosts: vec![WireguardHost {
                name: "proxy.chan.app".into(),
                addresses: vec!["10.7.0.1".parse().unwrap()],
            }],
        }
    }

    #[test]
    fn enrollment_builds_configs_without_writing_private_material() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let enrollment = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &params()).unwrap();
        assert_eq!(enrollment.public_key, sent);
        assert_eq!(LEGACY_INGRESS_ID, "legacy");
        assert_eq!(enrollment.ingresses[0].id, LEGACY_INGRESS_ID);
        assert_eq!(enrollment.ingresses[0].hosts, params().hosts);
        let key = key_path(&dir, "gw-1a2b3c4d");
        let read = enrollment
            .parameters(key.clone())
            .configs(&sent)
            .unwrap()
            .remove(0);
        assert!(!conf_path(&dir, "gw-1a2b3c4d").exists());
        assert_eq!(encode(PublicKey::from(&read.private_key).as_bytes()), sent);
        let addresses: Vec<String> = read
            .addresses
            .iter()
            .map(|c| format!("{}/{}", c.addr, c.prefix))
            .collect();
        assert_eq!(addresses, ["10.7.0.23/32", "fd00:7::23/128"]);
        assert_eq!(encode(read.peer.public_key.as_bytes()), SERVER_KEY);
        assert_eq!(read.peer.endpoint.to_string(), "wg.chan.app:51820");
        let allowed: Vec<String> = read
            .peer
            .allowed_ips
            .iter()
            .map(|c| format!("{}/{}", c.addr, c.prefix))
            .collect();
        assert_eq!(allowed, ["10.7.0.1/32"]);
        assert_eq!(read.peer.persistent_keepalive, Some(25));
        // Without a keepalive the file has none.
        let mut quiet = params();
        quiet.persistent_keepalive = None;
        let enrollment = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &quiet).unwrap();
        let read = enrollment.parameters(key).configs(&sent).unwrap().remove(0);
        assert_eq!(read.peer.persistent_keepalive, None);
        // The enrollment's Debug carries no key material.
        let key_text = std::fs::read_to_string(key_path(&dir, "gw-1a2b3c4d")).unwrap();
        assert!(!format!("{enrollment:?}").contains(key_text.trim_end()));
    }

    #[test]
    fn prepare_refuses_another_peer_than_discovery_named() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let mut other_key = params();
        other_key.server_public_key = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=".into();
        let mut other_endpoint = params();
        other_endpoint.endpoint = "wg.chan.app:51821".into();
        let mut bad_key = params();
        bad_key.server_public_key = "not a key".into();
        for changed in [other_key, other_endpoint, bad_key] {
            let err = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &changed).unwrap_err();
            assert_eq!(err, PEER_CHANGED, "{changed:?}");
        }
        // The same peer spelled in hex is the same peer.
        let mut hex = params();
        hex.server_public_key = base64::engine::general_purpose::STANDARD
            .decode(SERVER_KEY)
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &hex).unwrap();
        assert!(!conf_path(&dir, "gw-1a2b3c4d").exists());
    }

    #[test]
    fn prepare_refuses_an_ingress_list_that_discovery_did_not_offer() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let mut value = serde_json::json!({
            "server_public_key": SERVER_KEY, "endpoint": "wg.chan.app:51820",
            "addresses": ["10.7.0.23/32"], "allowed_ips": ["10.7.0.1/32"],
            "ingresses": [{"id": "p2", "server_public_key": SERVER_KEY,
                "endpoint": "p2.chan.app:51820", "hosts": []}]
        });
        for list in [value["ingresses"].clone(), serde_json::json!([])] {
            value["ingresses"] = list;
            let params: EnrollmentParams = serde_json::from_value(value.clone()).unwrap();
            let result = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &params);
            assert_eq!(result.unwrap_err(), PEER_CHANGED);
            assert!(!conf_path(&dir, "gw-1a2b3c4d").exists());
        }
    }

    #[test]
    fn prepare_validates_hosts_before_an_enrollment_can_be_stored() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let mut bad = params();
        bad.hosts[0].addresses = vec!["10.8.0.1".parse().unwrap()];
        assert!(prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &bad).is_err());
        assert!(!conf_path(&dir, "gw-1a2b3c4d").exists());
    }

    fn two_ingresses() -> (WireguardDiscovery, EnrollmentParams) {
        let mut entry = entry();
        let mut params = params();
        entry.allowed_ips = Some(params.allowed_ips.clone());
        entry.persistent_keepalive = params.persistent_keepalive;
        entry.ingresses = Some(vec![
            WireguardIngress {
                id: "p1".into(),
                endpoint: entry.endpoint.clone(),
                public_key: SERVER_KEY.into(),
                hosts: params.hosts.clone(),
            },
            WireguardIngress {
                id: "p2".into(),
                endpoint: "p2.chan.app:51821".into(),
                public_key: "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=".into(),
                hosts: vec![WireguardHost {
                    name: "*.p2.chan.app".into(),
                    addresses: vec!["10.7.0.1".parse().unwrap()],
                }],
            },
        ]);
        params.ingresses = Some(
            entry
                .ingresses
                .as_ref()
                .unwrap()
                .iter()
                .map(|i| EnrollmentIngress {
                    id: i.id.clone(),
                    endpoint: i.endpoint.clone(),
                    server_public_key: i.public_key.clone(),
                    hosts: i.hosts.clone(),
                })
                .collect(),
        );
        (entry, params)
    }

    #[test]
    fn two_ingress_redeem_compares_sets_and_builds_configs_from_one_key() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let key = key_path(&dir, "gw-1a2b3c4d");
        let before = std::fs::read(&key).unwrap();
        let (entry, mut params) = two_ingresses();
        params.ingresses.as_mut().unwrap().reverse();
        let first = &params.ingresses.as_ref().unwrap()[0];
        params.server_public_key = first.server_public_key.clone();
        params.endpoint = first.endpoint.clone();
        params.hosts = first.hosts.clone();
        let enrollment = prepare(&dir, "gw-1a2b3c4d", &sent, &entry, &params).unwrap();
        let stored = enrollment.parameters(key.clone());
        assert_eq!(stored.ingresses, entry.ingresses.clone().unwrap());
        let configs = stored.configs(&sent).unwrap();
        assert_eq!(configs.len(), 2);
        for (config, ingress) in configs.iter().zip(stored.ingresses.iter()) {
            assert_eq!(encode(config.public_key().as_bytes()), sent);
            assert_eq!(config.addresses, cidrs(&params.addresses).unwrap());
            assert_eq!(config.peer.allowed_ips, cidrs(&params.allowed_ips).unwrap());
            assert_eq!(
                config.peer.persistent_keepalive,
                params.persistent_keepalive
            );
            assert_eq!(
                encode(config.peer.public_key.as_bytes()),
                ingress.public_key
            );
            assert_eq!(config.peer.endpoint.to_string(), ingress.endpoint);
        }
        assert_eq!(std::fs::read(&key).unwrap(), before);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert!(!serde_json::to_string(&stored)
            .unwrap()
            .contains(std::str::from_utf8(&before).unwrap().trim()));
        #[cfg(unix)]
        assert_eq!(mode(&key), 0o600);
    }

    #[test]
    fn two_ingress_redeem_refuses_each_changed_identity_and_one_sided_lists() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let (entry, params) = two_ingresses();
        let mutations: [fn(&mut EnrollmentParams); 6] = [
            |p| p.ingresses.as_mut().unwrap()[1].id = "p3".into(),
            |p| p.ingresses.as_mut().unwrap()[1].server_public_key = SERVER_KEY.into(),
            |p| p.ingresses.as_mut().unwrap()[1].endpoint = "p2.chan.app:51822".into(),
            |p| {
                p.ingresses.as_mut().unwrap().pop();
            },
            |p| {
                let duplicate = p.ingresses.as_ref().unwrap()[0].clone();
                p.ingresses.as_mut().unwrap()[1] = duplicate;
            },
            |p| p.ingresses = None,
        ];
        for mutate in mutations {
            let mut bad = params.clone();
            mutate(&mut bad);
            assert_eq!(
                prepare(&dir, "gw-1a2b3c4d", &sent, &entry, &bad).unwrap_err(),
                PEER_CHANGED
            );
        }
        let mut legacy = entry;
        legacy.ingresses = None;
        assert_eq!(
            prepare(&dir, "gw-1a2b3c4d", &sent, &legacy, &params).unwrap_err(),
            PEER_CHANGED
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn redeem_requires_the_first_ingress_to_match_the_single_peer() {
        let home = tempfile::tempdir().unwrap();
        let sent = generate(home.path(), "gw-single").unwrap();
        let (entry, params) = two_ingresses();
        for change_key in [false, true] {
            let mut bad = params.clone();
            if change_key {
                bad.server_public_key =
                    bad.ingresses.as_ref().unwrap()[1].server_public_key.clone();
            } else {
                bad.endpoint = "wg.chan.app:51821".into();
            }
            assert_eq!(
                prepare(home.path(), "gw-single", &sent, &entry, &bad).unwrap_err(),
                PEER_CHANGED
            );
        }
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
    }

    #[test]
    fn second_ingress_hosts_are_validated_before_storage() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let (entry, mut params) = two_ingresses();
        params.ingresses.as_mut().unwrap()[1].hosts[0].addresses =
            vec!["10.7.0.2".parse().unwrap()];
        assert!(prepare(&dir, "gw-1a2b3c4d", &sent, &entry, &params)
            .unwrap_err()
            .contains("ingresses is invalid"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn persisted_configs_refuse_a_replaced_or_shared_key() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let (entry, params) = two_ingresses();
        let stored = prepare(&dir, "gw-1a2b3c4d", &sent, &entry, &params)
            .unwrap()
            .parameters(key_path(&dir, "gw-1a2b3c4d"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stored.key_file, std::fs::Permissions::from_mode(0o644))
                .unwrap();
            assert!(stored.configs(&sent).unwrap_err().contains("owner-only"));
            assert!(prepare(&dir, "gw-1a2b3c4d", &sent, &entry, &params)
                .unwrap_err()
                .starts_with("sign-in failed: WireGuard:"));
        }
        generate(&dir, "gw-1a2b3c4d").unwrap();
        assert!(stored
            .configs(&sent)
            .unwrap_err()
            .contains("does not hold the enrolled key"));
        std::fs::remove_file(&stored.key_file).unwrap();
        assert!(stored
            .configs(&sent)
            .unwrap_err()
            .starts_with("WireGuard: reading"));
    }

    #[test]
    fn legacy_migration_checks_both_key_sources_and_keeps_extra_settings() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let enrollment = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &params()).unwrap();
        let path = conf_path(&dir, "gw-1a2b3c4d");
        chan_wireguard::config::write_file(&path, &enrollment.config).unwrap();
        assert!(
            migrate_file(&dir, "gw-1a2b3c4d", SERVER_KEY, &params().hosts)
                .unwrap()
                .is_none(),
            "the enrolled key must match"
        );
        let mut changed = enrollment.config;
        changed.private_key = StaticSecret::from([12u8; 32]);
        chan_wireguard::config::write_file(&path, &changed).unwrap();
        assert!(
            migrate_file(&dir, "gw-1a2b3c4d", &sent, &params().hosts)
                .unwrap()
                .is_none(),
            "the client file must match the generated key"
        );
        changed.private_key = read_key(&dir, "gw-1a2b3c4d").unwrap();
        changed.mtu = Some(1280);
        chan_wireguard::config::write_file(&path, &changed).unwrap();
        assert!(migrate_file(&dir, "gw-1a2b3c4d", &sent, &params().hosts)
            .unwrap()
            .is_none());
        changed.mtu = None;
        changed.peer.preshared_key = Some([13u8; 32]);
        chan_wireguard::config::write_file(&path, &changed).unwrap();
        assert!(migrate_file(&dir, "gw-1a2b3c4d", &sent, &params().hosts)
            .unwrap()
            .is_none());
    }

    #[test]
    fn prepare_refuses_a_key_generated_again_during_the_sign_in() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        generate(&dir, "gw-1a2b3c4d").unwrap();
        let err = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &params()).unwrap_err();
        assert!(
            err.contains("the WireGuard key changed during sign-in"),
            "{err}"
        );
        // A key file that is gone is refused too, naming the file.
        let gone = prepare(&dir, "gw-99999999", &sent, &entry(), &params()).unwrap_err();
        assert!(gone.contains("gw-99999999.key"), "{gone}");
    }

    #[test]
    fn prepare_refuses_parameters_a_client_file_cannot_hold() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        type Break = fn(&mut EnrollmentParams);
        let cases: [(&str, Break); 5] = [
            ("addresses", |p| p.addresses = vec!["10.7.0.23/33".into()]),
            ("addresses", |p| p.addresses.clear()),
            ("allowed_ips", |p| {
                p.allowed_ips = vec!["proxy.chan.app".into()]
            }),
            ("allowed_ips", |p| p.allowed_ips.clear()),
            ("persistent_keepalive", |p| p.persistent_keepalive = Some(0)),
        ];
        for (what, break_it) in cases {
            let mut bad = params();
            break_it(&mut bad);
            let err = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &bad).unwrap_err();
            assert_eq!(
                err,
                format!("sign-in failed: the gateway's WireGuard {what} is invalid"),
                "{bad:?}"
            );
        }
    }
}
