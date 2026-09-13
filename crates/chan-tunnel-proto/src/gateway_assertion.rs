//! Signed caller assertion injected by chan-gateway's devserver proxy.
//!
//! The gateway proxy has already verified the public browser/session gate
//! before it forwards a request through the tunnel. This envelope lets the
//! proxied devserver bind a caller to the exact immutable devserver owner
//! without trusting any client-supplied header.
//!
//! Display identity is deliberately excluded: authorization credentials carry
//! immutable authority only. A separate lookup path can supply cosmetic data.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Header name carrying the assertion from devserver-proxy to chan-server.
pub const HEADER_NAME: &str = "x-chan-gateway-assertion";
const ASSERTION_LIFETIME_SECS: i64 = 60;
const CLOCK_SKEW_SECS: i64 = 5;

/// Per-tunnel HMAC key derived from the raw tunnel PAT on both sides.
pub type AssertionKey = [u8; 32];

/// Canonical `aud` value for gateway-bound tokens and assertions.
///
/// Public gateway isolation is origin-based. A port is stripped only when it
/// is the default for the actual request scheme (`http`/`ws`: 80,
/// `https`/`wss`: 443); cross-default ports remain authority-bearing.
pub fn canonical_audience(scheme: &str, host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return host;
    }

    if let Some(rest) = host.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let literal = &host[..=end + 1];
            let suffix = &host[end + 2..];
            if let Some(port) = suffix.strip_prefix(':') {
                return if is_default_port(scheme, port) {
                    literal.to_string()
                } else {
                    format!("{literal}:{port}")
                };
            }
        }
        return host;
    }

    match host.rsplit_once(':') {
        Some((name, port)) if !name.contains(':') => {
            if is_default_port(scheme, port) {
                name.to_string()
            } else {
                format!("{name}:{port}")
            }
        }
        _ => host,
    }
}

fn is_default_port(scheme: &str, port: &str) -> bool {
    matches!(
        (scheme.trim().to_ascii_lowercase().as_str(), port),
        ("http" | "ws", "80") | ("https" | "wss", "443")
    )
}

/// Which client a gateway session was minted for.
///
/// Identity states it on every entry credential it mints: the desktop entry
/// exchange, which takes a desktop PAT, mints for [`ClientType::Desktop`], and
/// the browser share landings mint for [`ClientType::Browser`]. devserver-proxy
/// records it on the session the credential opens and signs it into every
/// assertion made under that session.
///
/// A credential or assertion signed before the field existed has no value,
/// and a value this build does not recognise may come from a newer gateway;
/// both read as [`ClientType::Unknown`] rather than failing the whole token,
/// and neither is ever [`ClientType::Desktop`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientType {
    Desktop,
    Browser,
    #[default]
    Unknown,
}

impl ClientType {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Browser => "browser",
            Self::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for ClientType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ClientType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some("desktop") => Self::Desktop,
            Some("browser") => Self::Browser,
            _ => Self::Unknown,
        })
    }
}

/// Signed claims for one proxied request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// Caller user id as a string. UUID syntax is owned by gateway/profile.
    pub sub: String,
    /// Immutable owner user id of the exact devserver data plane.
    pub owner_user_id: String,
    /// Wildcard host the browser hit.
    pub aud: String,
    /// Token-resolved devserver id.
    pub drv: String,
    /// The client the caller's gateway session was minted for.
    #[serde(default)]
    pub client: ClientType,
    pub iat: i64,
    pub exp: i64,
}

impl Claims {
    /// True only for owner-level launcher access.
    pub fn is_owner(&self) -> bool {
        self.sub == self.owner_user_id
    }

    /// True only for the owner calling through a session minted for the
    /// desktop app.
    pub fn is_owner_desktop(&self) -> bool {
        self.is_owner() && self.client == ClientType::Desktop
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AssertionError {
    #[error("malformed gateway assertion")]
    Malformed,
    #[error("gateway assertion decode: {0}")]
    Decode(String),
    #[error("gateway assertion signature mismatch")]
    BadSignature,
    #[error("gateway assertion expired")]
    Expired,
    #[error("gateway assertion audience mismatch")]
    WrongAudience,
    #[error("gateway assertion devserver mismatch")]
    WrongDevserver,
    #[error("gateway assertion owner mismatch")]
    WrongOwner,
    #[error("gateway assertion issued in the future")]
    FutureIssued,
    #[error("gateway assertion lifetime invalid")]
    InvalidLifetime,
}

pub type AssertionResult<T> = Result<T, AssertionError>;

/// Derive the per-tunnel assertion key from the raw tunnel PAT.
pub fn derive_assertion_key(token: &str) -> AssertionKey {
    let mut h = Sha256::new();
    h.update(b"chan gateway assertion v1\0");
    h.update(token.as_bytes());
    h.finalize().into()
}

/// Token-resolved devserver identity used by identity-service and the
/// gateway proxy as the `drv` claim.
pub fn devserver_id_from_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Build claims with a short lifetime from the current wall clock.
pub fn claims(
    sub: impl Into<String>,
    owner_user_id: impl Into<String>,
    aud: &str,
    drv: &str,
    client: ClientType,
) -> Claims {
    let now = now_unix();
    Claims {
        sub: sub.into(),
        owner_user_id: owner_user_id.into(),
        aud: aud.to_string(),
        drv: drv.to_string(),
        client,
        iat: now,
        exp: now + ASSERTION_LIFETIME_SECS,
    }
}

/// Sign claims as `<base64url-json>.<base64url-hmac>`. Any serializable
/// claims shape signs, so a test can present what an older gateway sent;
/// [`verify`] is what decides which shapes a devserver accepts.
pub fn sign(key: &[u8], claims: &impl Serialize) -> AssertionResult<String> {
    let payload = serde_json::to_vec(claims).map_err(|e| AssertionError::Decode(e.to_string()))?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    let sig = hmac_sha256(key, payload.as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig);
    Ok(format!("{payload}.{sig}"))
}

/// Verify an assertion for a specific host and devserver id.
pub fn verify(
    key: &[u8],
    token: &str,
    expected_aud: &str,
    expected_drv: &str,
    expected_owner_user_id: &str,
) -> AssertionResult<Claims> {
    let (payload, sig) = token.split_once('.').ok_or(AssertionError::Malformed)?;
    if payload.is_empty() || sig.is_empty() || sig.contains('.') {
        return Err(AssertionError::Malformed);
    }
    let expected_sig = hmac_sha256(key, payload.as_bytes());
    let supplied_sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sig)
        .map_err(|_| AssertionError::Malformed)?;
    if !ct_eq(&expected_sig, &supplied_sig) {
        return Err(AssertionError::BadSignature);
    }
    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| AssertionError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&payload_bytes)
        .map_err(|e| AssertionError::Decode(e.to_string()))?;
    if claims.aud != expected_aud {
        return Err(AssertionError::WrongAudience);
    }
    if claims.drv != expected_drv {
        return Err(AssertionError::WrongDevserver);
    }
    if claims.owner_user_id != expected_owner_user_id {
        return Err(AssertionError::WrongOwner);
    }
    let now = now_unix();
    if claims.iat > now + CLOCK_SKEW_SECS {
        return Err(AssertionError::FutureIssued);
    }
    if claims.exp <= now {
        return Err(AssertionError::Expired);
    }
    if claims.exp <= claims.iat || claims.exp - claims.iat > ASSERTION_LIFETIME_SECS {
        return Err(AssertionError::InvalidLifetime);
    }
    Ok(claims)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digest: [u8; 32] = Sha256::digest(key).into();
        k[..digest.len()].copy_from_slice(&digest);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assertion_roundtrip() {
        let key = derive_assertion_key("chan_pat_secret");
        assert_eq!(devserver_id_from_token("abc").len(), 64);
        let owner = "11111111-1111-4111-8111-111111111111";
        let c = claims(owner, owner, "a.dev", "drv", ClientType::Desktop);
        let token = sign(&key, &c).unwrap();
        let got = verify(&key, &token, "a.dev", "drv", owner).unwrap();
        assert_eq!(got.sub, c.sub);
        assert!(got.is_owner());
        assert_eq!(got.client, ClientType::Desktop);
        assert!(got.is_owner_desktop());
    }

    /// Sign an arbitrary claims payload the way `sign` does, so a test can
    /// present a shape `Claims` itself never serializes.
    fn sign_raw(key: &[u8], payload: &serde_json::Value) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string());
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(hmac_sha256(key, payload.as_bytes()));
        format!("{payload}.{sig}")
    }

    #[test]
    fn each_client_type_round_trips_and_only_the_owner_on_the_desktop_is_the_owner_desktop() {
        let key = derive_assertion_key("chan_pat_secret");
        for (client, wire) in [
            (ClientType::Desktop, "desktop"),
            (ClientType::Browser, "browser"),
            (ClientType::Unknown, "unknown"),
        ] {
            let owner = claims("owner", "owner", "a.dev", "drv", client);
            assert_eq!(serde_json::to_value(&owner).unwrap()["client"], wire);
            assert_eq!(client.to_string(), wire);
            let got = verify(&key, &sign(&key, &owner).unwrap(), "a.dev", "drv", "owner").unwrap();
            assert_eq!(got.client, client);
            assert!(got.is_owner());
            assert_eq!(got.is_owner_desktop(), client == ClientType::Desktop);

            let grantee = claims("grantee", "owner", "a.dev", "drv", client);
            let got = verify(
                &key,
                &sign(&key, &grantee).unwrap(),
                "a.dev",
                "drv",
                "owner",
            )
            .unwrap();
            assert_eq!(got.client, client);
            assert!(!got.is_owner_desktop(), "{wire} grantee");
        }
    }

    /// An assertion from a gateway that predates the claim carries no client,
    /// and a newer gateway may send a value this build does not know. Both
    /// verify, so every other route keeps working, and neither is the desktop.
    #[test]
    fn a_missing_or_unrecognised_client_verifies_as_unknown_and_never_as_the_desktop() {
        let key = derive_assertion_key("chan_pat_secret");
        let base = serde_json::to_value(claims(
            "owner",
            "owner",
            "a.dev",
            "drv",
            ClientType::Desktop,
        ))
        .unwrap();
        let mut missing = base.clone();
        missing.as_object_mut().unwrap().remove("client");
        let mut shapes = vec![missing];
        for value in [
            serde_json::json!("cli"),
            serde_json::json!("Desktop"),
            serde_json::json!("DESKTOP"),
            serde_json::json!(" desktop"),
            serde_json::json!(""),
            serde_json::Value::Null,
            serde_json::json!(true),
            serde_json::json!(1),
            serde_json::json!(["desktop"]),
            serde_json::json!({"desktop": true}),
        ] {
            let mut shape = base.clone();
            shape["client"] = value;
            shapes.push(shape);
        }
        for shape in shapes {
            let got = verify(&key, &sign_raw(&key, &shape), "a.dev", "drv", "owner")
                .unwrap_or_else(|e| panic!("{shape}: {e}"));
            assert_eq!(got.client, ClientType::Unknown, "{shape}");
            assert!(got.is_owner(), "{shape}");
            assert!(!got.is_owner_desktop(), "{shape}");
        }
    }

    #[test]
    fn assertion_contains_no_display_identity() {
        let key = derive_assertion_key("chan_pat_secret");
        let c = claims("owner", "owner", "a.dev", "drv", ClientType::Desktop);
        let payload = serde_json::to_string(&c).unwrap();
        assert!(!payload.contains("\"name\""));
        assert!(!payload.contains("\"email\""));
        let got = verify(&key, &sign(&key, &c).unwrap(), "a.dev", "drv", "owner").unwrap();
        assert_eq!(got.sub, "owner");
    }

    #[test]
    fn assertion_ignores_unknown_claims() {
        let key = derive_assertion_key("chan_pat_secret");
        let c = claims("u", "owner", "a.dev", "drv", ClientType::Desktop);
        let mut value = serde_json::to_value(&c).unwrap();
        value["future_claim"] = serde_json::Value::String("x".to_string());
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string());
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(hmac_sha256(&key, payload.as_bytes()));
        let got = verify(&key, &format!("{payload}.{sig}"), "a.dev", "drv", "owner").unwrap();
        assert_eq!(got.sub, "u");
    }

    #[test]
    fn assertion_rejects_wrong_host() {
        let key = derive_assertion_key("chan_pat_secret");
        let c = claims("u", "owner", "a.dev", "drv", ClientType::Desktop);
        let token = sign(&key, &c).unwrap();
        assert_eq!(
            verify(&key, &token, "b.dev", "drv", "owner").unwrap_err(),
            AssertionError::WrongAudience
        );
    }

    #[test]
    fn assertion_rejects_tampering() {
        let key = derive_assertion_key("chan_pat_secret");
        let c = claims("u", "owner", "a.dev", "drv", ClientType::Desktop);
        let mut token = sign(&key, &c).unwrap();
        token.push('x');
        assert_eq!(
            verify(&key, &token, "a.dev", "drv", "owner").unwrap_err(),
            AssertionError::BadSignature
        );
    }

    #[test]
    fn assertion_rejects_wrong_owner() {
        let key = derive_assertion_key("chan_pat_secret");
        let c = claims("caller", "owner-a", "a.dev", "drv", ClientType::Desktop);
        let token = sign(&key, &c).unwrap();
        assert_eq!(
            verify(&key, &token, "a.dev", "drv", "owner-b").unwrap_err(),
            AssertionError::WrongOwner
        );
    }

    #[test]
    fn assertion_rejects_future_issue_and_overlong_lifetime() {
        let key = derive_assertion_key("chan_pat_secret");
        let mut future = claims("caller", "owner", "a.dev", "drv", ClientType::Desktop);
        future.iat = now_unix() + CLOCK_SKEW_SECS + 1;
        future.exp = future.iat + ASSERTION_LIFETIME_SECS;
        assert_eq!(
            verify(&key, &sign(&key, &future).unwrap(), "a.dev", "drv", "owner").unwrap_err(),
            AssertionError::FutureIssued
        );

        let mut overlong = claims("caller", "owner", "a.dev", "drv", ClientType::Desktop);
        overlong.exp = overlong.iat + ASSERTION_LIFETIME_SECS + 1;
        assert_eq!(
            verify(
                &key,
                &sign(&key, &overlong).unwrap(),
                "a.dev",
                "drv",
                "owner"
            )
            .unwrap_err(),
            AssertionError::InvalidLifetime
        );
    }

    #[test]
    fn canonical_audience_strips_only_the_schemes_actual_default_port() {
        assert_eq!(
            canonical_audience("https", "Alice--1a2b3c4d5e6f.P1.Proxy.Chan.App"),
            "alice--1a2b3c4d5e6f.p1.proxy.chan.app",
        );
        assert_eq!(
            canonical_audience("https", "alice--1a2b3c4d5e6f.p1.proxy.chan.app:443"),
            "alice--1a2b3c4d5e6f.p1.proxy.chan.app",
        );
        assert_eq!(
            canonical_audience("http", "alice--1a2b3c4d5e6f.p1.proxy.chan.app:80"),
            "alice--1a2b3c4d5e6f.p1.proxy.chan.app",
        );
        assert_eq!(
            canonical_audience("https", "alice--1a2b3c4d5e6f.p1.proxy.chan.app:80"),
            "alice--1a2b3c4d5e6f.p1.proxy.chan.app:80",
        );
        assert_eq!(
            canonical_audience("http", "alice--1a2b3c4d5e6f.p1.proxy.chan.app:443"),
            "alice--1a2b3c4d5e6f.p1.proxy.chan.app:443",
        );
        assert_eq!(
            canonical_audience("https", "alice--1a2b3c4d5e6f.p1.proxy.chan.app:7002"),
            "alice--1a2b3c4d5e6f.p1.proxy.chan.app:7002",
        );
        assert_eq!(canonical_audience("wss", "[::1]:443"), "[::1]");
        assert_eq!(canonical_audience("ws", "[::1]:443"), "[::1]:443");
    }
}
