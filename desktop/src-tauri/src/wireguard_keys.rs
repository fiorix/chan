//! The WireGuard key pairs the desktop generates for its gateways.
//!
//! A gateway whose discovery offers enrollment gets a key pair of its own:
//! the private half in `<gateway id>.key` under the desktop's `wireguard`
//! directory (base64 and a newline), the public half on the gateway row,
//! where the launcher shows it and a sign-in sends it. The client file a
//! sign-in writes from the key sits beside it as `<gateway id>.conf`. The
//! directory is owner-only (0700) and so is each file (0600) on Unix; on
//! Windows the profile directory's ACL applies, as the file reader accepts.
//! The private key is read back only to write the client file, so it never
//! reaches the config, a log, the projection or a request.

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use base64::Engine;
use chan_wireguard::config::{parse_public_key, Cidr, Config, Endpoint, Peer};
use chan_wireguard::x25519::{PublicKey, StaticSecret};
use serde::Deserialize;

use crate::config::{WireguardHost, WireguardIngress};
use crate::devserver::WireguardDiscovery;

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
}

/// A client file ready to write for an enrollment, with the key it enrolled
/// and the host map it routes. Built and checked before the sign-in stores
/// anything, so a refused enrollment writes nothing.
pub struct Enrollment {
    /// The enrolled public key, base64 as it was sent.
    pub public_key: String,
    pub config: Config,
    pub hosts: Vec<WireguardHost>,
}

impl std::fmt::Debug for Enrollment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Enrollment")
            .field("public_key", &self.public_key)
            .field("config", &self.config)
            .field("hosts", &self.hosts)
            .finish()
    }
}

/// The refusal of a redeem whose peer is not the one discovery named.
pub const PEER_CHANGED: &str =
    "sign-in failed: the gateway's WireGuard peer changed during sign-in";

/// Check a redeem's parameters against what the sign-in sent and build the
/// client file for `gateway_id` from its key file under `dir`. The peer's
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
    let peer_key = parse_public_key(&params.server_public_key).map_err(|_| PEER_CHANGED)?;
    let entry_key = parse_public_key(&entry.public_key).map_err(|_| PEER_CHANGED)?;
    let endpoint = Endpoint::parse(&params.endpoint).map_err(|_| PEER_CHANGED)?;
    if peer_key.as_bytes() != entry_key.as_bytes()
        || Endpoint::parse(&entry.endpoint).ok().as_ref() != Some(&endpoint)
    {
        return Err(PEER_CHANGED.to_string());
    }
    let private_key = read_key(dir, gateway_id)?;
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
        hosts: params.hosts.clone(),
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

/// Write an enrollment's client file for `gateway_id` under `dir`, owner-only
/// like the key beside it, and answer its path.
pub fn write_client_file(
    dir: &Path,
    gateway_id: &str,
    enrollment: &Enrollment,
) -> Result<PathBuf, String> {
    let path = conf_path(dir, gateway_id);
    chan_wireguard::config::write_file(&path, &enrollment.config)
        .map_err(|e| format!("WireGuard: {e}"))?;
    Ok(path)
}

/// The bytes of the client file at `path`, `None` when there is none. They
/// hold a private key: they are kept only to put the file back, never shown.
pub fn read_client_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("WireGuard: reading {}: {e}", path.display())),
    }
}

/// Put the client file at `path` inside `dir` back to `bytes`, owner-only
/// like the key beside it, or delete it when `bytes` is `None` (a file that
/// is not there is not an error).
pub fn put_back_client_file(dir: &Path, path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    let result = match bytes {
        Some(bytes) => write_owner_only(dir, path, bytes),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    };
    result.map_err(|e| format!("WireGuard: putting back {}: {e}", path.display()))
}

/// The private key in `gateway_id`'s key file under `dir`.
fn read_key(dir: &Path, gateway_id: &str) -> Result<StaticSecret, String> {
    let path = key_path(dir, gateway_id);
    let unreadable = || {
        format!(
            "sign-in failed: WireGuard: {} does not hold a key; generate one again",
            path.display()
        )
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("sign-in failed: WireGuard: reading {}: {e}", path.display()))?;
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
    fn enrolled_file_parses_with_read_file() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("wireguard");
        let sent = generate(&dir, "gw-1a2b3c4d").unwrap();
        let enrollment = prepare(&dir, "gw-1a2b3c4d", &sent, &entry(), &params()).unwrap();
        assert_eq!(enrollment.public_key, sent);
        assert_eq!(enrollment.hosts, params().hosts);
        let conf = write_client_file(&dir, "gw-1a2b3c4d", &enrollment).unwrap();
        assert_eq!(conf, conf_path(&dir, "gw-1a2b3c4d"));
        let read = chan_wireguard::config::read_file(&conf).unwrap();
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
        write_client_file(&dir, "gw-1a2b3c4d", &enrollment).unwrap();
        let read = chan_wireguard::config::read_file(&conf).unwrap();
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
