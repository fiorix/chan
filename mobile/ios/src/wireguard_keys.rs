//! The WireGuard key pairs the app generates for its gateways.
//!
//! A gateway whose discovery offers enrollment gets a key pair of its
//! own: the private half in an immutable generated file under the app's
//! `wireguard` directory (base64 and a newline), the public half on
//! the gateway row, where the launcher shows it and a sign-in sends
//! it. The directory is owner-only (0700) and so is each file (0600)
//! on Unix. The private key never reaches the config, a log, the
//! projection, or a request.
//!
//! This module owns key-file storage and ingress validation. The mobile
//! fabric builds runtime tunnels from the separately persisted parameters.

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use crate::devserver::WireguardDiscovery;
use base64::Engine;
use chan_wireguard::config::{parse_public_key, Cidr, Config, Endpoint, Peer};
use chan_wireguard::x25519::{PublicKey, StaticSecret};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::{WireguardHost, WireguardIngress};

/// The key file of `gateway_id` under the key directory `dir`.
pub fn key_path(dir: &Path, gateway_id: &str) -> PathBuf {
    dir.join(format!("{gateway_id}.key"))
}

/// The client file of `gateway_id` under the key directory `dir`.
#[cfg(test)]
pub fn conf_path(dir: &Path, gateway_id: &str) -> PathBuf {
    dir.join(format!("{gateway_id}.conf"))
}

pub(crate) const FRESH_KEY_REQUIRED: &str =
    "WireGuard: the previous enrollment outcome is unknown; generate a fresh key before connecting";

pub(crate) struct GeneratedKey {
    pub public_key: String,
    pub path: PathBuf,
    sha256: [u8; 32],
}

/// A generated file is immutable so a failed config save cannot destroy the
/// previously selected or enrolled private key.
pub(crate) fn generate(dir: &Path, gateway_id: &str) -> Result<GeneratedKey, String> {
    use std::io::Write;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    let secret = StaticSecret::from(bytes);
    let public_key = encode(PublicKey::from(&secret).as_bytes());
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let path = dir.join(format!("{gateway_id}.{nonce}.key"));
    if !managed_path(dir, gateway_id, &path) {
        return Err("WireGuard: invalid gateway key identity".into());
    }
    let write = || -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            writeln!(file, "{}", encode(&secret.to_bytes()))?;
            file.sync_all()?;
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir_all(dir)?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            writeln!(file, "{}", encode(&secret.to_bytes()))?;
            file.sync_all()?;
        }
        std::fs::File::open(dir)?.sync_all()
    };
    write().map_err(|e| format!("WireGuard: writing {}: {e}", path.display()))?;
    let sha256 = Sha256::digest(format!("{}\n", encode(&secret.to_bytes())).as_bytes()).into();
    Ok(GeneratedKey {
        public_key,
        path,
        sha256,
    })
}

pub(crate) fn selected_path(
    dir: &Path,
    gateway: &crate::config::Gateway,
) -> Result<PathBuf, String> {
    let path = gateway
        .wireguard_key_file
        .clone()
        .unwrap_or_else(|| key_path(dir, &gateway.id));
    if !managed_path(dir, &gateway.id, &path) {
        return Err("WireGuard: selected key is not a managed gateway file".into());
    }
    Ok(path)
}

pub(crate) fn stored_key_path(dir: &Path, id: &str, path: &Path) -> PathBuf {
    if path.is_absolute() && managed_path(dir, id, path) {
        let name = path.file_name().expect("managed path has a filename");
        if dir.join(name).as_os_str() == path.as_os_str() {
            return PathBuf::from(name);
        }
    }
    path.into()
}

pub(crate) fn resolve_stored_key_path(dir: &Path, id: &str, path: &Path) -> PathBuf {
    if path.to_str().is_some_and(|name| managed_name(id, name)) {
        dir.join(path)
    } else {
        path.into()
    }
}

fn managed_path(dir: &Path, id: &str, path: &Path) -> bool {
    path.parent() == Some(dir)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| managed_name(id, name))
}

fn managed_name(id: &str, name: &str) -> bool {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return false;
    }
    name == format!("{id}.key")
        || name
            .strip_prefix(&format!("{id}."))
            .and_then(|rest| rest.strip_suffix(".key"))
            .is_some_and(|nonce| {
                nonce.len() == 32
                    && nonce
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
}

pub(crate) fn capture_owned(
    dir: &Path,
    id: &str,
    path: &Path,
    public_key: &str,
) -> Option<GeneratedKey> {
    if !managed_path(dir, id, path) || !std::fs::symlink_metadata(path).ok()?.file_type().is_file()
    {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let private: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(text.trim_end_matches('\n'))
        .ok()?
        .try_into()
        .ok()?;
    if encode(PublicKey::from(&StaticSecret::from(private)).as_bytes()) != public_key {
        return None;
    }
    Some(GeneratedKey {
        public_key: public_key.into(),
        path: path.into(),
        sha256: Sha256::digest(bytes).into(),
    })
}

pub(crate) fn remove_owned(dir: &Path, id: &str, owned: &GeneratedKey) -> Result<(), String> {
    if !managed_path(dir, id, &owned.path) {
        return Ok(());
    }
    match std::fs::symlink_metadata(&owned.path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(format!(
                "WireGuard: inspecting {}: {e}",
                owned.path.display()
            ))
        }
        Ok(meta) if !meta.file_type().is_file() => return Ok(()),
        Ok(_) => {}
    }
    let bytes = std::fs::read(&owned.path)
        .map_err(|e| format!("WireGuard: reading {}: {e}", owned.path.display()))?;
    if <[u8; 32]>::from(Sha256::digest(bytes)) != owned.sha256 {
        return Ok(());
    }
    std::fs::remove_file(&owned.path)
        .map_err(|e| format!("WireGuard: removing {}: {e}", owned.path.display()))
}

pub(crate) fn read_key_file(
    path: &std::path::Path,
) -> Result<chan_wireguard::x25519::StaticSecret, String> {
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
    Ok(chan_wireguard::x25519::StaticSecret::from(bytes))
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

/// Validated public parameters and the exact immutable key they enroll.
pub(crate) struct Enrollment {
    pub config: chan_wireguard::config::Config,
    pub ingresses: Vec<WireguardIngress>,
}

impl Enrollment {
    pub(crate) fn parameters(&self, key_file: PathBuf) -> crate::config::WireguardEnrollment {
        crate::config::WireguardEnrollment {
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

const LEGACY_INGRESS_ID: &str = "legacy";

/// The refusal of a redeem whose peer is not the one discovery named.
pub const PEER_CHANGED: &str =
    "sign-in failed: the gateway's WireGuard peer changed during sign-in";

/// Check a redeem's parameters against what the sign-in sent and build a
/// configuration from the selected immutable key file. The peer's key and
/// endpoint must be the discovery entry's, the key file must still
/// hold the key that was sent (a key generated again during the sign-in is
/// refused), and every address must read as the file's grammar reads it.
/// An error is the sign-in's failure sentence and never carries a key.
pub fn prepare(
    key_file: &Path,
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
                            && item.hosts == ingress.hosts
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
    if entry
        .allowed_ips
        .as_ref()
        .is_some_and(|offered| cidrs(offered) != cidrs(&params.allowed_ips))
        || (entry.allowed_ips.is_some()
            && entry.persistent_keepalive != params.persistent_keepalive)
        || params.ingresses.as_ref().is_some_and(|items| {
            items
                .first()
                .is_some_and(|first| first.hosts != params.hosts)
        })
    {
        return Err(PEER_CHANGED.into());
    }
    let private_key = read_key_file(key_file).map_err(|e| format!("sign-in failed: {e}"))?;
    if encode(PublicKey::from(&private_key).as_bytes()) != sent_key {
        return Err(
            "sign-in failed: the WireGuard key changed during sign-in; connect again to enroll it"
                .to_string(),
        );
    }
    let invalid = |what: &str| format!("sign-in failed: the gateway's WireGuard {what} is invalid");
    let addresses = cidrs(&params.addresses).ok_or_else(|| invalid("addresses"))?;
    let allowed_ips = cidrs(&params.allowed_ips).ok_or_else(|| invalid("allowed_ips"))?;
    // Match the embedded stack's unicast check and two-address capacity
    // before keeping credentials, rather than failing later at tunnel start.
    if addresses.is_empty()
        || addresses.len() > 2
        || addresses.iter().any(|cidr| match cidr.addr {
            IpAddr::V4(address) => {
                address.is_unspecified() || address.is_multicast() || address.is_broadcast()
            }
            IpAddr::V6(address) => address.is_unspecified() || address.is_multicast(),
        })
    {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn offered() -> WireguardDiscovery {
        WireguardDiscovery {
            mobile_enrollment: true,
            endpoint: "wg.example.test:51820".into(),
            public_key: encode(&[7; 32]),
            allowed_ips: Some(vec!["10.7.0.1/32".into()]),
            persistent_keepalive: Some(25),
            ingresses: Some(vec![WireguardIngress {
                id: "p1".into(),
                endpoint: "wg.example.test:51820".into(),
                public_key: encode(&[7; 32]),
                hosts: vec![WireguardHost {
                    name: "*.p1.proxy.example.test".into(),
                    addresses: vec!["10.7.0.1".parse().unwrap()],
                }],
            }]),
        }
    }

    fn params(entry: &WireguardDiscovery) -> EnrollmentParams {
        let first = &entry.ingresses.as_ref().unwrap()[0];
        EnrollmentParams {
            server_public_key: entry.public_key.clone(),
            endpoint: entry.endpoint.clone(),
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: entry.allowed_ips.clone().unwrap(),
            persistent_keepalive: entry.persistent_keepalive,
            hosts: first.hosts.clone(),
            ingresses: Some(vec![EnrollmentIngress {
                id: first.id.clone(),
                server_public_key: first.public_key.clone(),
                endpoint: first.endpoint.clone(),
                hosts: first.hosts.clone(),
            }]),
        }
    }

    #[test]
    fn redeem_parameters_bind_every_advertised_ingress_and_policy() {
        let dir = tempfile::tempdir().unwrap();
        let key = generate(dir.path(), "gw-test").unwrap();
        let entry = offered();
        let valid = params(&entry);
        let enrollment = prepare(&key.path, &key.public_key, &entry, &valid).unwrap();
        assert!(enrollment
            .parameters(key.path.clone())
            .configs(&key.public_key)
            .is_ok());
        type Change = fn(&mut EnrollmentParams);
        let changes: &[Change] = &[
            |p| p.server_public_key = encode(&[8; 32]),
            |p| p.endpoint = "other.example.test:51820".into(),
            |p| p.addresses.clear(),
            |p| p.addresses = vec!["10.7.0.2/33".into()],
            |p| p.addresses = vec!["0.0.0.0/32".into()],
            |p| p.addresses = vec!["224.0.0.1/32".into()],
            |p| p.addresses = vec!["255.255.255.255/32".into()],
            |p| p.addresses = vec!["::/128".into()],
            |p| p.addresses = vec!["ff02::1/128".into()],
            |p| {
                p.addresses = vec![
                    "10.7.0.2/32".into(),
                    "10.7.0.3/32".into(),
                    "10.7.0.4/32".into(),
                ]
            },
            |p| p.allowed_ips = vec!["0.0.0.0/0".into()],
            |p| p.persistent_keepalive = None,
            |p| p.hosts.clear(),
            |p| p.ingresses = None,
            |p| p.ingresses.as_mut().unwrap()[0].id = "p2".into(),
            |p| p.ingresses.as_mut().unwrap()[0].endpoint = "other.example.test:51820".into(),
            |p| p.ingresses.as_mut().unwrap()[0].server_public_key = encode(&[8; 32]),
            |p| p.ingresses.as_mut().unwrap()[0].hosts[0].name = "*.other.example.test".into(),
            |p| {
                p.ingresses.as_mut().unwrap()[0].hosts[0].addresses =
                    vec!["10.7.0.3".parse().unwrap()]
            },
            |p| {
                let duplicate = p.ingresses.as_ref().unwrap()[0].clone();
                p.ingresses.as_mut().unwrap().push(duplicate);
            },
        ];
        for (index, change) in changes.iter().enumerate() {
            let mut invalid = valid.clone();
            change(&mut invalid);
            assert!(
                prepare(&key.path, &key.public_key, &entry, &invalid).is_err(),
                "mutation {index}"
            );
        }
        let mut dual_stack = valid.clone();
        dual_stack.addresses.push("fd00:7::2/128".into());
        assert!(prepare(&key.path, &key.public_key, &entry, &dual_stack).is_ok());
        let other = generate(dir.path(), "gw-test").unwrap();
        assert!(prepare(&other.path, &key.public_key, &entry, &valid).is_err());
        assert!(prepare(&key.path, &other.public_key, &entry, &valid).is_err());
    }

    #[test]
    fn immutable_keys_and_cleanup_require_exact_path_and_public_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let first = generate(dir.path(), "gw-test").unwrap();
        let bytes = std::fs::read(&first.path).unwrap();
        let second = generate(dir.path(), "gw-test").unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), bytes);
        assert!(capture_owned(dir.path(), "gw-test", &first.path, &second.public_key).is_none());
        let manual = dir.path().join("manual.key");
        std::fs::copy(&first.path, &manual).unwrap();
        assert!(capture_owned(dir.path(), "gw-test", &manual, &first.public_key).is_none());
        remove_owned(dir.path(), "gw-other", &first).unwrap();
        assert!(first.path.exists());
        #[cfg(unix)]
        {
            let link = dir
                .path()
                .join("gw-test.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.key");
            std::os::unix::fs::symlink(&first.path, &link).unwrap();
            assert!(capture_owned(dir.path(), "gw-test", &link, &first.public_key).is_none());
            assert!(link.is_symlink());
        }
        // Identical key identity is insufficient after a byte change.
        let changed = [bytes.clone(), b"\n".to_vec()].concat();
        std::fs::write(&first.path, &changed).unwrap();
        remove_owned(dir.path(), "gw-test", &first).unwrap();
        assert_eq!(std::fs::read(&first.path).unwrap(), changed);
        std::fs::write(&first.path, bytes).unwrap();
        remove_owned(dir.path(), "gw-test", &first).unwrap();
        assert!(!first.path.exists());
        assert!(second.path.exists());
        assert!(manual.exists());
    }

    #[test]
    fn prepare_preserves_discovery_order_and_rejects_mismatched_peers_or_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let key = generate(dir.path(), "gw-order").unwrap();
        let p1 = WireguardIngress {
            id: "p1".into(),
            endpoint: "p1.example.test:51820".into(),
            public_key: encode(&[7; 32]),
            hosts: vec![WireguardHost {
                name: "*.p1.proxy.example.test".into(),
                addresses: vec!["10.7.0.1".parse().unwrap()],
            }],
        };
        let p2 = WireguardIngress {
            id: "p2".into(),
            endpoint: "p2.example.test:51821".into(),
            public_key: encode(&[9; 32]),
            hosts: vec![WireguardHost {
                name: "*.p2.proxy.example.test".into(),
                addresses: vec!["10.7.0.1".parse().unwrap()],
            }],
        };
        let entry = WireguardDiscovery {
            mobile_enrollment: true,
            endpoint: p1.endpoint.clone(),
            public_key: p1.public_key.clone(),
            allowed_ips: Some(vec!["10.7.0.0/24".into()]),
            persistent_keepalive: Some(25),
            ingresses: Some(vec![p1.clone(), p2.clone()]),
        };
        let reordered = EnrollmentParams {
            server_public_key: p2.public_key.clone(),
            endpoint: p2.endpoint.clone(),
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.0/24".into()],
            persistent_keepalive: Some(25),
            hosts: p2.hosts.clone(),
            ingresses: Some(vec![
                EnrollmentIngress {
                    id: p2.id.clone(),
                    server_public_key: p2.public_key.clone(),
                    endpoint: p2.endpoint.clone(),
                    hosts: p2.hosts.clone(),
                },
                EnrollmentIngress {
                    id: p1.id.clone(),
                    server_public_key: p1.public_key.clone(),
                    endpoint: p1.endpoint.clone(),
                    hosts: p1.hosts.clone(),
                },
            ]),
        };
        let enrollment = prepare(&key.path, &key.public_key, &entry, &reordered).unwrap();
        let ids: Vec<_> = enrollment
            .ingresses
            .iter()
            .map(|ingress| ingress.id.as_str())
            .collect();
        assert_eq!(ids, ["p1", "p2"]);
        assert_eq!(enrollment.config.peer.public_key.as_bytes(), &[7; 32]);

        let mut wrong_ingress_key = reordered.clone();
        wrong_ingress_key.ingresses.as_mut().unwrap()[1].server_public_key = encode(&[11; 32]);
        assert_eq!(
            prepare(&key.path, &key.public_key, &entry, &wrong_ingress_key)
                .err()
                .as_deref(),
            Some(PEER_CHANGED)
        );

        let legacy_entry = WireguardDiscovery {
            mobile_enrollment: true,
            endpoint: p1.endpoint.clone(),
            public_key: p1.public_key.clone(),
            allowed_ips: None,
            persistent_keepalive: None,
            ingresses: None,
        };
        let legacy_wrong_key = EnrollmentParams {
            server_public_key: encode(&[12; 32]),
            endpoint: p1.endpoint.clone(),
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.0/24".into()],
            persistent_keepalive: None,
            hosts: p1.hosts.clone(),
            ingresses: None,
        };
        assert_eq!(
            prepare(&key.path, &key.public_key, &legacy_entry, &legacy_wrong_key)
                .err()
                .as_deref(),
            Some(PEER_CHANGED)
        );

        let legacy_outside_allowed = EnrollmentParams {
            server_public_key: p1.public_key.clone(),
            endpoint: p1.endpoint.clone(),
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.0/24".into()],
            persistent_keepalive: None,
            hosts: vec![WireguardHost {
                name: "*.p1.proxy.example.test".into(),
                addresses: vec!["10.8.0.1".parse().unwrap()],
            }],
            ingresses: None,
        };
        assert!(prepare(
            &key.path,
            &key.public_key,
            &legacy_entry,
            &legacy_outside_allowed
        )
        .err()
        .unwrap()
        .contains("ingresses is invalid"));

        let mut enrolled_outside_allowed = entry.clone();
        enrolled_outside_allowed.ingresses.as_mut().unwrap()[0].hosts[0].addresses =
            vec!["10.8.0.1".parse().unwrap()];
        assert_eq!(
            prepare(
                &key.path,
                &key.public_key,
                &enrolled_outside_allowed,
                &reordered
            )
            .err()
            .as_deref(),
            Some(PEER_CHANGED)
        );
    }
}
