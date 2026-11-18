//! The WireGuard key pairs the app generates for its gateways.
//!
//! A gateway whose discovery offers enrollment gets a key pair of its
//! own: the private half in `<gateway id>.key` under the app's
//! `wireguard` directory (base64 and a newline), the public half on
//! the gateway row, where the launcher shows it and a sign-in sends
//! it. The directory is owner-only (0700) and so is each file (0600)
//! on Unix. The private key never reaches the config, a log, the
//! projection, or a request.
//!
//! This module covers key-file storage and ingress validation only: no
//! sign-in on iOS enrolls a tunnel because the app runs no WireGuard
//! fabric.

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use base64::Engine;
use chan_wireguard::config::{Cidr, Endpoint};
use chan_wireguard::x25519::{PublicKey, StaticSecret};
use serde::Deserialize;

use crate::config::{WireguardHost, WireguardIngress};

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
