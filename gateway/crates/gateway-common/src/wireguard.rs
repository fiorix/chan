//! WireGuard enrollment shapes shared by identity and profile.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A canonical, padded base64 public key, or `None` for invalid input.
pub fn canonical_public_key(raw: &str) -> Option<String> {
    if raw.len() != 44 {
        return None;
    }
    let bytes = STANDARD.decode(raw).ok()?;
    (bytes.len() == 32).then(|| STANDARD.encode(bytes))
}

/// A host identifier uses the same lowercase DNS-label grammar as a proxy id.
pub fn valid_host(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 63
        && !raw.starts_with('-')
        && !raw.ends_with('-')
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// One WireGuard ingress: the kernel interface of one proxy node, as a
/// desktop reaches it. A gateway offers one per node that terminates
/// WireGuard, and every ingress lists every enrolled peer.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Ingress {
    /// The node's proxy id, which is also the host its peer agent reads.
    pub id: String,
    /// `host:port` of the interface, an IPv6 literal in brackets.
    pub endpoint: String,
    /// The interface's public key, canonical padded base64.
    pub public_key: String,
}

#[cfg(test)]
mod ingress_tests {
    use super::*;

    #[test]
    fn ingress_wire_shape_is_id_endpoint_and_public_key() {
        let ingress = Ingress {
            id: "p1".into(),
            endpoint: "p1.proxy.example.test:51820".into(),
            public_key: STANDARD.encode([7; 32]),
        };
        let wire = serde_json::json!({
            "id": "p1",
            "endpoint": "p1.proxy.example.test:51820",
            "public_key": ingress.public_key,
        });
        assert_eq!(serde_json::to_value(&ingress).unwrap(), wire);
        assert_eq!(serde_json::from_value::<Ingress>(wire).unwrap(), ingress);
    }
}

/// The persisted peer returned by profile after enrollment or token replacement.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EnrolledPeer {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_id: Uuid,
    pub host: String,
    pub public_key: String,
    pub addresses: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One active peer and the host prefixes the kernel interface may accept from it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActivePeer {
    pub public_key: String,
    pub allowed_ips: Vec<String>,
}

/// The complete active set for one WireGuard ingress host.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PeerList {
    pub host: String,
    pub peers: Vec<ActivePeer>,
}

/// Profile's conditional response, retained as bytes to preserve its ETag.
#[derive(Debug)]
pub enum PeerListResponse {
    Modified { body: Vec<u8>, etag: String },
    NotModified { etag: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_keys_require_32_bytes_of_padded_standard_base64() {
        let key = STANDARD.encode([7; 32]);
        assert_eq!(canonical_public_key(&key), Some(key.clone()));
        for invalid in [
            key[..43].to_string(),
            format!("{key}="),
            "!".repeat(44),
            STANDARD.encode([7; 31]),
            STANDARD.encode([7; 33]),
        ] {
            assert_eq!(canonical_public_key(&invalid), None);
        }
    }

    #[test]
    fn hosts_are_single_lowercase_dns_labels() {
        for valid in ["p1", "a", "1", "proxy-1"] {
            assert!(valid_host(valid), "{valid}");
        }
        for invalid in ["", "P1", "p1.example", "-p1", "p1-", "p_1", " p1"] {
            assert!(!valid_host(invalid), "{invalid}");
        }
        assert!(valid_host(&"a".repeat(63)));
        assert!(!valid_host(&"a".repeat(64)));
    }
}
