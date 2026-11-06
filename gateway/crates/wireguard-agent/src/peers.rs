//! Peer sets as the agent holds them: public key to allowed IPs. The agent
//! parses nothing of WireGuard beyond a peer's base64 public key and its
//! CIDR strings; both are checked here before they reach a `wg` argument.

use std::collections::BTreeMap;
use std::net::IpAddr;

use base64::Engine;

/// Public key (canonical base64 of 32 bytes) to its allowed IPs (canonical
/// CIDRs, sorted and without duplicates).
pub type PeerSet = BTreeMap<String, Vec<String>>;

/// A WireGuard public key: standard base64 of exactly 32 bytes, in the
/// canonical spelling `wg` itself prints. Any other spelling is refused, so
/// a key compares equal to the one `wg show` reports.
pub fn valid_public_key(key: &str) -> bool {
    match base64::engine::general_purpose::STANDARD.decode(key) {
        Ok(bytes) => {
            bytes.len() == 32 && base64::engine::general_purpose::STANDARD.encode(&bytes) == key
        }
        Err(_) => false,
    }
}

/// An address and prefix length (`10.7.0.23/32`, `fd00:7::23/128`) in the
/// canonical text form, or `None` when it is not one.
pub fn canonical_cidr(raw: &str) -> Option<String> {
    let (address, prefix) = raw.split_once('/')?;
    let address: IpAddr = address.parse().ok()?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let prefix: u8 = prefix.parse().ok()?;
    let max = if address.is_ipv4() { 32 } else { 128 };
    (prefix <= max).then(|| format!("{address}/{prefix}"))
}

/// Check one peer and return its allowed IPs in canonical, sorted form.
pub fn canonical_peer(key: &str, allowed_ips: &[String]) -> Result<Vec<String>, String> {
    if !valid_public_key(key) {
        return Err(format!("{key:?} is not a WireGuard public key"));
    }
    if allowed_ips.is_empty() {
        return Err(format!("peer {key} has no allowed IPs"));
    }
    let mut canonical = Vec::with_capacity(allowed_ips.len());
    for ip in allowed_ips {
        canonical
            .push(canonical_cidr(ip).ok_or_else(|| format!("peer {key}: {ip:?} is not a CIDR"))?);
    }
    canonical.sort();
    canonical.dedup();
    Ok(canonical)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A valid public key derived from one byte, for fixtures.
    pub(crate) fn key(n: u8) -> String {
        base64::engine::general_purpose::STANDARD.encode([n; 32])
    }

    #[test]
    fn public_keys_are_canonical_base64_of_32_bytes() {
        assert!(valid_public_key(&key(1)));
        assert!(!valid_public_key(&key(1)[..43]));
        assert!(!valid_public_key(
            &base64::engine::general_purpose::STANDARD.encode([1u8; 31])
        ));
        assert!(!valid_public_key("not base64!"));
        assert!(!valid_public_key(""));
        // Non-zero trailing bits decode to the same bytes elsewhere; refuse
        // them so a key always matches `wg show`'s spelling.
        let mut odd = key(1);
        odd.replace_range(42..43, "B");
        assert!(!valid_public_key(&odd));
        assert!(!valid_public_key(&format!("-{}", &key(1)[1..])));
    }

    #[test]
    fn cidrs_are_checked_and_canonicalized() {
        assert_eq!(
            canonical_cidr("10.7.0.23/32").as_deref(),
            Some("10.7.0.23/32")
        );
        assert_eq!(
            canonical_cidr("fd00:0007:0000::0023/128").as_deref(),
            Some("fd00:7::23/128")
        );
        for bad in [
            "10.7.0.23",
            "10.7.0.23/33",
            "fd00::1/129",
            "10.7.0.256/32",
            "10.7.0.1/",
            "10.7.0.1/+8",
            "host/32",
            "-10.0.0.1/32",
        ] {
            assert_eq!(canonical_cidr(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_peer_sorts_and_dedups_its_allowed_ips() {
        assert_eq!(
            canonical_peer(
                &key(2),
                &[
                    "fd00:7::2/128".into(),
                    "10.7.0.2/32".into(),
                    "10.7.0.2/32".into()
                ]
            )
            .unwrap(),
            ["10.7.0.2/32", "fd00:7::2/128"]
        );
        assert!(canonical_peer(&key(2), &[]).is_err());
        assert!(canonical_peer("bad", &["10.7.0.2/32".into()]).is_err());
        assert!(canonical_peer(&key(2), &["10.7.0.2".into()]).is_err());
    }
}
