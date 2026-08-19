//! Short-lived, identity-signed credentials used to establish opaque
//! proxy-local browser sessions.
//!
//! Token shapes:
//!
//! Entry credentials are carried only in a bounded POST body to the fixed
//! exchange path and expire after 30 seconds. The proxy verifies Ed25519,
//! consumes the random `jti` once, then returns a host-only opaque session
//! cookie. `aud` binds the token to the tenant
//! host (`alice--0123456789ab.p1.proxy.chan.app`) so a token minted for one user is
//! not accepted on another user's subdomain. `drv` binds it to one
//! live devserver registration for the same reason.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ENTRY_PURPOSE: &str = "chan.devserver.entry";
pub const ENTRY_EXCHANGE_PATH: &str = "/_chan/entry";
pub const ENTRY_VERSION: u16 = 1;
pub const ENTRY_LIFETIME_SECONDS: i64 = 30;
pub const ENTRY_CLOCK_SKEW_SECONDS: i64 = 5;
const MAX_ENTRY_TOKEN_BYTES: usize = 4096;
const MAX_ENTRY_VERIFYING_KEYS: usize = 2;

#[derive(Clone)]
pub struct EntrySigner(SigningKey);

impl std::fmt::Debug for EntrySigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EntrySigner").finish_non_exhaustive()
    }
}

impl EntrySigner {
    pub fn from_base64(raw: &str) -> DevserverGateResult<Self> {
        let bytes = decode_canonical_key(raw, "entry signing key")?;
        Ok(Self(SigningKey::from_bytes(&bytes)))
    }

    pub fn verifying_key_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.verifying_key().as_bytes())
    }
}

#[derive(Clone)]
pub struct EntryVerifierRing(Vec<VerifyingKey>);

impl std::fmt::Debug for EntryVerifierRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EntryVerifierRing")
            .field("key_count", &self.0.len())
            .finish()
    }
}

impl EntryVerifierRing {
    /// Parse one or two semicolon-delimited Ed25519 public keys. Two keys allow
    /// a bounded rotation overlap; duplicates and empty members are rejected.
    pub fn from_base64_list(raw: &str) -> DevserverGateResult<Self> {
        let parts: Vec<&str> = raw.split(';').collect();
        if parts.is_empty()
            || parts.len() > MAX_ENTRY_VERIFYING_KEYS
            || parts
                .iter()
                .any(|part| part.is_empty() || part.trim() != *part)
        {
            return Err(DevserverGateError::Key(
                "entry verifier ring must contain one or two canonical keys".into(),
            ));
        }
        let mut keys = Vec::with_capacity(parts.len());
        for part in parts {
            let bytes = decode_canonical_key(part, "entry verifying key")?;
            let key = VerifyingKey::from_bytes(&bytes)
                .map_err(|_| DevserverGateError::Key("invalid entry verifying key".into()))?;
            if keys.contains(&key) {
                return Err(DevserverGateError::Key(
                    "entry verifier ring contains a duplicate key".into(),
                ));
            }
            keys.push(key);
        }
        Ok(Self(keys))
    }
}

fn decode_canonical_key(raw: &str, label: &str) -> DevserverGateResult<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| DevserverGateError::Key(format!("{label} is not canonical base64url")))?;
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err(DevserverGateError::Key(format!(
            "{label} must be canonical base64url for exactly 32 bytes"
        )));
    }
    bytes
        .try_into()
        .map_err(|_| DevserverGateError::Key(format!("{label} has the wrong length")))
}

/// Signed entry credential claims.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Purpose and protocol version make this credential unusable in another
    /// signed-token context even if the same key is accidentally configured.
    pub purpose: String,
    pub version: u16,
    /// Stable logical token issuer. Decode verifies this exact service role;
    /// it deliberately does not depend on a deployment hostname.
    pub iss: String,
    /// Immutable caller user id.
    pub sub: Uuid,
    /// Immutable owner of the exact devserver data plane.
    pub owner_user_id: Uuid,
    /// Devserver id resolved from the live tunnel registration.
    pub drv: String,
    /// Exact tenant host the token is bound to.
    pub aud: String,
    /// Fixed credential type (`"entry"`).
    pub typ: String,
    /// Provisioned proxy node that alone may exchange this entry credential.
    pub proxy_id: String,
    /// Random single-use credential id retained by the target proxy until exp.
    pub jti: Uuid,
    /// Relative target path the proxy redirects to after successful POST
    /// exchange. Signed so the browser cannot turn the exchange into an open
    /// redirect or choose a different tenant path.
    pub next_path: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum DevserverGateError {
    #[error("invalid devserver-gate key: {0}")]
    Key(String),
    /// Signature verification failed, or the wire shape is bad.
    /// Library-level decode errors collapse here; the only thing we
    /// surface upstream is "token bad."
    #[error("invalid devserver-gate token: {0}")]
    Decode(String),

    /// `exp` is in the past.
    #[error("devserver-gate token expired")]
    Expired,

    /// `aud` claim does not match the expected host.
    #[error("devserver-gate token audience mismatch")]
    WrongAudience,

    /// `drv` claim does not match the requested workspace slug.
    #[error("devserver-gate token devserver mismatch")]
    WrongWorkspace,

    /// Immutable owner does not match the tunnel registration.
    #[error("devserver-gate token owner mismatch")]
    WrongOwner,

    #[error("devserver-gate token proxy mismatch")]
    WrongProxy,

    #[error("devserver-gate token purpose or version mismatch")]
    WrongContext,
}

pub type DevserverGateResult<T> = Result<T, DevserverGateError>;

/// Mint an entry token (30s exp).
pub fn encode_entry(
    signer: &EntrySigner,
    sub: Uuid,
    owner_user_id: Uuid,
    drv: &str,
    aud: &str,
    proxy_id: &str,
    next_path: &str,
) -> DevserverGateResult<String> {
    validate_entry_next_path(next_path)?;
    let now = Utc::now();
    let claims = Claims {
        purpose: ENTRY_PURPOSE.to_string(),
        version: ENTRY_VERSION,
        iss: "chan-gateway-identity".to_string(),
        sub,
        owner_user_id,
        drv: drv.to_string(),
        aud: aud.to_string(),
        typ: "entry".to_string(),
        proxy_id: proxy_id.to_string(),
        jti: Uuid::new_v4(),
        next_path: next_path.to_string(),
        iat: now.timestamp(),
        exp: (now + Duration::seconds(ENTRY_LIFETIME_SECONDS)).timestamp(),
    };
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&claims)
            .map_err(|error| DevserverGateError::Decode(format!("encode: {error}")))?,
    );
    let signed = format!("{header}.{payload}");
    let signature = signer.0.sign(signed.as_bytes());
    Ok(format!(
        "{signed}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

/// Verify an identity-signed entry credential under a bounded public-key ring
/// and bind it to the exact receiving proxy and tenant authority.
pub fn decode_entry(
    verifiers: &EntryVerifierRing,
    token: &str,
    expected_proxy_id: &str,
    expected_aud: &str,
    expected_drv: &str,
    expected_owner_user_id: Uuid,
) -> DevserverGateResult<Claims> {
    if token.is_empty() || token.len() > MAX_ENTRY_TOKEN_BYTES {
        return Err(DevserverGateError::Decode(
            "invalid entry token length".into(),
        ));
    }
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(DevserverGateError::Decode("malformed entry token".into()));
    };
    let decoded_header = URL_SAFE_NO_PAD
        .decode(header)
        .map_err(|_| DevserverGateError::Decode("invalid entry header".into()))?;
    if decoded_header != br#"{"alg":"EdDSA","typ":"JWT"}"# {
        return Err(DevserverGateError::Decode(
            "unexpected entry signature algorithm".into(),
        ));
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| DevserverGateError::Decode("invalid entry signature".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| DevserverGateError::Decode("invalid entry signature".into()))?;
    let signed = format!("{header}.{payload}");
    if !verifiers
        .0
        .iter()
        .any(|key| key.verify(signed.as_bytes(), &signature).is_ok())
    {
        return Err(DevserverGateError::Decode(
            "entry signature verification failed".into(),
        ));
    }
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| DevserverGateError::Decode("invalid entry payload".into()))?;
    let claims: Claims = serde_json::from_slice(&payload)
        .map_err(|_| DevserverGateError::Decode("invalid entry claims".into()))?;
    let now = Utc::now().timestamp();
    if claims.exp < now - ENTRY_CLOCK_SKEW_SECONDS {
        return Err(DevserverGateError::Expired);
    }
    if claims.iat > now + ENTRY_CLOCK_SKEW_SECONDS
        || claims.exp - claims.iat != ENTRY_LIFETIME_SECONDS
    {
        return Err(DevserverGateError::WrongContext);
    }
    if claims.purpose != ENTRY_PURPOSE
        || claims.version != ENTRY_VERSION
        || claims.iss != "chan-gateway-identity"
        || claims.typ != "entry"
    {
        return Err(DevserverGateError::WrongContext);
    }
    if claims.proxy_id != expected_proxy_id {
        return Err(DevserverGateError::WrongProxy);
    }
    if claims.jti.is_nil() {
        return Err(DevserverGateError::WrongContext);
    }
    validate_entry_next_path(&claims.next_path)?;
    validate_bindings(&claims, expected_aud, expected_drv, expected_owner_user_id)?;
    Ok(claims)
}

pub fn validate_entry_next_path(path: &str) -> DevserverGateResult<()> {
    if path.is_empty()
        || path.len() > 2048
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return Err(DevserverGateError::WrongContext);
    }
    let uri: axum::http::Uri = path.parse().map_err(|_| DevserverGateError::WrongContext)?;
    if uri.scheme().is_some() || uri.authority().is_some() {
        return Err(DevserverGateError::WrongContext);
    }
    Ok(())
}

fn validate_bindings(
    claims: &Claims,
    expected_aud: &str,
    expected_drv: &str,
    expected_owner_user_id: Uuid,
) -> DevserverGateResult<()> {
    if claims.aud != expected_aud {
        return Err(DevserverGateError::WrongAudience);
    }
    if claims.drv != expected_drv {
        return Err(DevserverGateError::WrongWorkspace);
    }
    if claims.owner_user_id != expected_owner_user_id {
        return Err(DevserverGateError::WrongOwner);
    }
    Ok(())
}

/// Convenience: when did this token issue?
pub fn issued_at(claims: &Claims) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp(claims.iat, 0).unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNING_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn sample_uuid() -> Uuid {
        Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap()
    }

    fn entry_keys() -> (EntrySigner, EntryVerifierRing) {
        let signer = EntrySigner::from_base64(SIGNING_KEY).unwrap();
        let ring = EntryVerifierRing::from_base64_list(&signer.verifying_key_base64()).unwrap();
        (signer, ring)
    }

    #[test]
    fn entry_roundtrip_ok() {
        let (signer, ring) = entry_keys();
        let t = encode_entry(
            &signer,
            sample_uuid(),
            sample_uuid(),
            "blog",
            "alice--0123456789ab.p1.proxy.chan.app",
            "p1",
            "/blog/",
        )
        .unwrap();
        let c = decode_entry(
            &ring,
            &t,
            "p1",
            "alice--0123456789ab.p1.proxy.chan.app",
            "blog",
            sample_uuid(),
        )
        .unwrap();
        assert_eq!(c.sub, sample_uuid());
        assert_eq!(c.drv, "blog");
        assert_eq!(c.aud, "alice--0123456789ab.p1.proxy.chan.app");
        assert_eq!(c.typ, "entry");
        assert_eq!(c.iss, "chan-gateway-identity");
        assert_eq!(c.owner_user_id, sample_uuid());
        assert_eq!(c.proxy_id, "p1");
        assert_eq!(c.purpose, ENTRY_PURPOSE);
        assert_eq!(c.version, ENTRY_VERSION);
    }

    #[test]
    fn aud_mismatch_rejected() {
        let (signer, ring) = entry_keys();
        let t = encode_entry(
            &signer,
            sample_uuid(),
            sample_uuid(),
            "blog",
            "alice--0123456789ab.p1.proxy.chan.app",
            "p1",
            "/blog/",
        )
        .unwrap();
        let err = decode_entry(
            &ring,
            &t,
            "p1",
            "bob--0123456789ab.p1.proxy.chan.app",
            "blog",
            sample_uuid(),
        )
        .unwrap_err();
        assert!(matches!(err, DevserverGateError::WrongAudience));
    }

    #[test]
    fn wrong_verifying_key_rejected() {
        let (signer, _) = entry_keys();
        let t = encode_entry(
            &signer,
            sample_uuid(),
            sample_uuid(),
            "blog",
            "alice--0123456789ab.p1.proxy.chan.app",
            "p1",
            "/blog/",
        )
        .unwrap();
        let other =
            EntrySigner::from_base64("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE").unwrap();
        let ring = EntryVerifierRing::from_base64_list(&other.verifying_key_base64()).unwrap();
        let err = decode_entry(
            &ring,
            &t,
            "p1",
            "alice--0123456789ab.p1.proxy.chan.app",
            "blog",
            sample_uuid(),
        )
        .unwrap_err();
        assert!(matches!(err, DevserverGateError::Decode(_)));
    }

    #[test]
    fn unexpected_signature_algorithm_header_is_rejected() {
        // The verifier accepts only the exact canonical EdDSA header. An
        // unsigned or algorithm-substitution envelope is rejected before
        // claims decoding.
        //
        // Construction: header `{"alg":"none","typ":"JWT"}` + claims
        // with no signature trailing.
        let header = base64_url(r#"{"alg":"none","typ":"JWT"}"#);
        let payload = base64_url(
            r#"{"iss":"gw.chan.app","sub":"11111111-1111-4111-8111-111111111111",
                "owner_user_id":"11111111-1111-4111-8111-111111111111",
                "drv":"blog","aud":"alice--0123456789ab.p1.proxy.chan.app","typ":"entry",
                "iat":0,"exp":9999999999}"#,
        );
        let token = format!("{header}.{payload}.");
        let (_, ring) = entry_keys();
        let err = decode_entry(
            &ring,
            &token,
            "p1",
            "alice--0123456789ab.p1.proxy.chan.app",
            "blog",
            sample_uuid(),
        )
        .unwrap_err();
        assert!(matches!(err, DevserverGateError::Decode(_)));
    }

    fn base64_url(s: &str) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        URL_SAFE_NO_PAD.encode(s.as_bytes())
    }

    #[test]
    fn verifier_ring_is_bounded_canonical_and_duplicate_free() {
        let (signer, _) = entry_keys();
        let key = signer.verifying_key_base64();
        assert!(EntryVerifierRing::from_base64_list("").is_err());
        assert!(EntryVerifierRing::from_base64_list(&format!("{key};{key}")).is_err());
        assert!(EntryVerifierRing::from_base64_list(&format!(" {key}")).is_err());
        assert!(EntryVerifierRing::from_base64_list(&format!("{key};{key};{key}")).is_err());
    }

    #[test]
    fn entry_next_path_rejects_redirect_and_header_injection_shapes() {
        for bad in [
            "",
            "relative",
            "//evil.example/x",
            "https://evil.example/x",
            "/\\evil",
            "/ok\r\nlocation: https://evil.example",
        ] {
            assert!(validate_entry_next_path(bad).is_err(), "accepted {bad:?}");
        }
        assert!(validate_entry_next_path("/notes/index.html?mode=edit").is_ok());
    }
}
