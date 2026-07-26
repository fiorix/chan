#![forbid(unsafe_code)]

use std::fmt;
use std::net::SocketAddr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use url::Url;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 2;
pub const CONNECT_PATH: &str = "/v1/proxies/connect";
pub const CONTENT_TYPE: &str = "application/x-chan-devserver-control+json; version=2";
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_SNAPSHOT_CHUNK_ROWS: usize = 128;
pub const MAX_SNAPSHOT_ROWS: usize = 2_048;
pub const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_USERNAME_BYTES: usize = 64;
pub const MAX_DEVSERVER_ID_BYTES: usize = 128;
pub const MAX_PACKAGE_VERSION_BYTES: usize = 128;
pub const MAX_ADMISSION_LEASE_BYTES: usize = 4096;
pub const MAX_ORIGIN_BYTES: usize = 256;
pub const MAX_COMMAND_REGISTRATIONS: usize = 4096;
pub const MAX_SESSION_REVOCATION_COUNT: usize = 100_000;
pub const MAX_BROWSER_SESSION_SNAPSHOT_ROWS: usize = 100_000;
pub const MAX_BROWSER_SESSION_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SIGNED_CONNECTED_DEVSERVERS: u32 = 1_000_000;
/// Normal proxy-side retention after a healthy control session is lost.
pub const PROXY_CONTROL_LOSS_GRACE_SECONDS: u64 = 30;
/// Hard proxy-side retention after a reconnect snapshot is accepted but the
/// controller has not yet sent `FleetReady`.
pub const PROXY_CONVERGENCE_GRACE_SECONDS: u64 = 45;
/// Controller-side disconnected-authority marker. This must exceed every
/// proxy-side authority-retention path so revocation cannot confirm while a
/// disconnected process can still serve an old browser session.
pub const CONTROLLER_DISCONNECTED_AUTHORITY_RETENTION_SECONDS: u64 = 60;
const _: () =
    assert!(CONTROLLER_DISCONNECTED_AUTHORITY_RETENTION_SECONDS > PROXY_CONVERGENCE_GRACE_SECONDS);
pub const ADMISSION_LEASE_PURPOSE: &str = "chan.devserver.admission";
pub const MAX_ADMISSION_LEASE_TTL_SECONDS: i64 = 300;
pub const ADMISSION_LEASE_CLOCK_SKEW_SECONDS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdmissionLeaseBinding {
    pub owner_user_id: Uuid,
    pub user: String,
    pub devserver_id: String,
    pub registration_id: Uuid,
    pub proxy_id: ProxyId,
}

impl AdmissionLeaseBinding {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_text(&self.user, MAX_USERNAME_BYTES, ValidationError::Username)?;
        validate_text(
            &self.devserver_id,
            MAX_DEVSERVER_ID_BYTES,
            ValidationError::DevserverId,
        )?;
        if self.owner_user_id.is_nil() || self.registration_id.is_nil() {
            return Err(ValidationError::Uuid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdmissionLeaseClaims {
    pub purpose: String,
    pub protocol_version: u16,
    #[serde(flatten)]
    pub binding: AdmissionLeaseBinding,
    pub max_connected_devservers: u32,
    pub issued_at: i64,
    pub expires_at: i64,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct AdmissionLease(String);

impl fmt::Debug for AdmissionLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AdmissionLease")
            .field(&"[REDACTED]")
            .finish()
    }
}

impl AdmissionLease {
    pub fn parse(raw: impl Into<String>) -> Result<Self, LeaseError> {
        let raw = raw.into();
        if raw.is_empty() || raw.len() > MAX_ADMISSION_LEASE_BYTES {
            return Err(LeaseError::Length);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for AdmissionLease {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone)]
pub struct AdmissionLeaseSigner(SigningKey);

impl AdmissionLeaseSigner {
    pub fn from_base64(raw: &str) -> Result<Self, LeaseError> {
        let bytes = decode_canonical_key(raw)?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| LeaseError::KeyLength)?;
        Ok(Self(SigningKey::from_bytes(&bytes)))
    }

    pub fn verifying_key_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.verifying_key().as_bytes())
    }

    pub fn sign(
        &self,
        binding: AdmissionLeaseBinding,
        max_connected_devservers: u32,
        now: DateTime<Utc>,
        ttl_seconds: i64,
    ) -> Result<AdmissionLease, LeaseError> {
        binding.validate()?;
        validate_signed_limit(max_connected_devservers)?;
        if !(1..=MAX_ADMISSION_LEASE_TTL_SECONDS).contains(&ttl_seconds) {
            return Err(LeaseError::Ttl);
        }
        let claims = AdmissionLeaseClaims {
            purpose: ADMISSION_LEASE_PURPOSE.into(),
            protocol_version: PROTOCOL_VERSION,
            binding,
            max_connected_devservers,
            issued_at: now.timestamp(),
            expires_at: now.timestamp() + ttl_seconds,
        };
        let payload = serde_json::to_vec(&claims).map_err(LeaseError::Json)?;
        let signed = format!("v1.{}", URL_SAFE_NO_PAD.encode(payload));
        let signature = self.0.sign(signed.as_bytes());
        AdmissionLease::parse(format!(
            "{signed}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
    }
}

#[derive(Clone)]
pub struct AdmissionLeaseVerifier(Vec<VerifyingKey>);

impl AdmissionLeaseVerifier {
    pub fn from_base64(raw: &str) -> Result<Self, LeaseError> {
        let bytes = decode_canonical_key(raw)?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| LeaseError::KeyLength)?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| LeaseError::Key)?;
        Ok(Self(vec![key]))
    }

    pub fn from_base64_rotation(raw: &str) -> Result<Self, LeaseError> {
        let encoded: Vec<_> = raw.split(';').map(str::trim).collect();
        if encoded.is_empty() || encoded.len() > 2 || encoded.iter().any(|key| key.is_empty()) {
            return Err(LeaseError::KeyCount);
        }
        let mut seen = std::collections::HashSet::new();
        let mut keys = Vec::with_capacity(encoded.len());
        for encoded in encoded {
            let bytes = decode_canonical_key(encoded)?;
            let bytes: [u8; 32] = bytes.try_into().map_err(|_| LeaseError::KeyLength)?;
            if !seen.insert(bytes) {
                return Err(LeaseError::KeyCount);
            }
            keys.push(VerifyingKey::from_bytes(&bytes).map_err(|_| LeaseError::Key)?);
        }
        Ok(Self(keys))
    }

    pub fn verify(
        &self,
        lease: &AdmissionLease,
        now: DateTime<Utc>,
    ) -> Result<AdmissionLeaseClaims, LeaseError> {
        let mut parts = lease.as_str().split('.');
        let (Some(version), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(LeaseError::Format);
        };
        if version != "v1" {
            return Err(LeaseError::Format);
        }
        let payload_bytes = decode_canonical(payload).map_err(|_| LeaseError::Encoding)?;
        let signature_bytes = decode_canonical(signature).map_err(|_| LeaseError::Encoding)?;
        let signature =
            Signature::from_slice(&signature_bytes).map_err(|_| LeaseError::Signature)?;
        let signed = format!("v1.{payload}");
        if !self
            .0
            .iter()
            .any(|key| key.verify(signed.as_bytes(), &signature).is_ok())
        {
            return Err(LeaseError::Signature);
        }
        let claims: AdmissionLeaseClaims =
            serde_json::from_slice(&payload_bytes).map_err(LeaseError::Json)?;
        claims.binding.validate()?;
        if claims.purpose != ADMISSION_LEASE_PURPOSE || claims.protocol_version != PROTOCOL_VERSION
        {
            return Err(LeaseError::Claims);
        }
        validate_signed_limit(claims.max_connected_devservers)?;
        let timestamp = now.timestamp();
        if claims.issued_at > timestamp + ADMISSION_LEASE_CLOCK_SKEW_SECONDS
            || claims.expires_at <= timestamp
            || claims.expires_at <= claims.issued_at
            || claims.expires_at - claims.issued_at > MAX_ADMISSION_LEASE_TTL_SECONDS
        {
            return Err(LeaseError::Time);
        }
        Ok(claims)
    }
}

fn decode_canonical_key(raw: &str) -> Result<Vec<u8>, LeaseError> {
    decode_canonical(raw).map_err(|_| LeaseError::Key)
}

fn decode_canonical(raw: &str) -> Result<Vec<u8>, base64::DecodeError> {
    let bytes = URL_SAFE_NO_PAD.decode(raw)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err(base64::DecodeError::InvalidPadding);
    }
    Ok(bytes)
}

fn validate_text(value: &str, max: usize, error: ValidationError) -> Result<(), ValidationError> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(error);
    }
    Ok(())
}

fn validate_signed_limit(limit: u32) -> Result<(), LeaseError> {
    if !(1..=MAX_SIGNED_CONNECTED_DEVSERVERS).contains(&limit) {
        return Err(LeaseError::Limit);
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum LeaseError {
    #[error("admission lease has invalid length")]
    Length,
    #[error("admission lease has invalid format")]
    Format,
    #[error("admission lease has non-canonical encoding")]
    Encoding,
    #[error("admission lease key must be exactly 32 bytes")]
    KeyLength,
    #[error("admission lease verification rotation must contain one or two distinct keys")]
    KeyCount,
    #[error("admission lease key is invalid")]
    Key,
    #[error("admission lease signature is invalid")]
    Signature,
    #[error("admission lease claims are invalid")]
    Claims,
    #[error("admission lease time bounds are invalid")]
    Time,
    #[error("admission lease TTL is invalid")]
    Ttl,
    #[error("admission lease devserver limit is invalid")]
    Limit,
    #[error("admission lease JSON: {0}")]
    Json(serde_json::Error),
    #[error(transparent)]
    Validation(#[from] ValidationError),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ProxyId(String);

impl ProxyId {
    pub fn parse(raw: impl Into<String>) -> Result<Self, ValidationError> {
        let raw = raw.into();
        if raw.is_empty()
            || raw.len() > 63
            || !raw
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || raw.starts_with('-')
            || raw.ends_with('-')
        {
            return Err(ValidationError::ProxyId);
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ProxyId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct CanonicalOrigin(String);

impl CanonicalOrigin {
    pub fn parse(raw: &str) -> Result<Self, ValidationError> {
        if raw.is_empty() || raw.len() > MAX_ORIGIN_BYTES {
            return Err(ValidationError::Origin);
        }
        let url: Url = raw.parse().map_err(|_| ValidationError::Origin)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ValidationError::Origin);
        }
        Ok(Self(url.origin().ascii_serialization()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for CanonicalOrigin {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone)]
pub struct ProxyOriginTemplate {
    raw: String,
}

impl ProxyOriginTemplate {
    pub fn parse(raw: &str) -> Result<Self, ValidationError> {
        if raw.is_empty() || raw.len() > MAX_ORIGIN_BYTES || raw.matches("{proxy_id}").count() != 1
        {
            return Err(ValidationError::OriginTemplate);
        }
        let probe = raw.replace("{proxy_id}", "proxy");
        CanonicalOrigin::parse(&probe).map_err(|_| ValidationError::OriginTemplate)?;
        Ok(Self {
            raw: raw.to_string(),
        })
    }

    pub fn expand(&self, proxy_id: &ProxyId) -> Result<CanonicalOrigin, ValidationError> {
        CanonicalOrigin::parse(&self.raw.replace("{proxy_id}", proxy_id.as_str()))
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("proxy id must be one lowercase DNS label")]
    ProxyId,
    #[error("proxy URL must be a canonical http(s) origin")]
    Origin,
    #[error("proxy URL template must be a canonical origin with one {{proxy_id}} placeholder")]
    OriginTemplate,
    #[error("username is empty, too long, or contains control characters")]
    Username,
    #[error("devserver id is empty, too long, or contains control characters")]
    DevserverId,
    #[error("devserver limit is outside the accepted range")]
    DevserverLimit,
    #[error("owner and registration ids must be non-nil UUIDs")]
    Uuid,
    #[error("browser session expiry must be after creation")]
    SessionTime,
    #[error("package version is empty, too long, or contains control characters")]
    PackageVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelRow {
    pub registration_id: Uuid,
    pub owner_user_id: Uuid,
    pub user: String,
    pub devserver_id: String,
    pub max_connected_devservers: u32,
    pub admission_lease: AdmissionLease,
    pub admission_lease_expires_at: DateTime<Utc>,
    pub peer_addr: Option<SocketAddr>,
    pub connected_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserSessionRow {
    pub admin_session_id: Uuid,
    pub subject_user_id: Uuid,
    pub owner_user_id: Uuid,
    pub devserver_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl BrowserSessionRow {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.admin_session_id.is_nil()
            || self.subject_user_id.is_nil()
            || self.owner_user_id.is_nil()
        {
            return Err(ValidationError::Uuid);
        }
        validate_text(
            &self.devserver_id,
            MAX_DEVSERVER_ID_BYTES,
            ValidationError::DevserverId,
        )?;
        if self.expires_at <= self.created_at {
            return Err(ValidationError::SessionTime);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    ClientHello {
        protocol_version: u16,
        package_version: String,
        proxy_id: ProxyId,
        proxy_base_url: CanonicalOrigin,
        boot_id: Uuid,
    },
    SnapshotStart {
        base_generation: u64,
    },
    SnapshotChunk {
        rows: Vec<TunnelRow>,
    },
    BrowserSessionSnapshotChunk {
        rows: Vec<BrowserSessionRow>,
    },
    SnapshotEnd {
        base_generation: u64,
    },
    TunnelUp {
        generation: u64,
        row: TunnelRow,
    },
    TunnelDown {
        generation: u64,
        registration_id: Uuid,
    },
    BrowserSessionUp {
        generation: u64,
        row: BrowserSessionRow,
    },
    BrowserSessionDown {
        generation: u64,
        admin_session_id: Uuid,
    },
    AdmissionRequest {
        request_id: Uuid,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        admission_lease: AdmissionLease,
    },
    AdmissionCancel {
        request_id: Uuid,
        registration_id: Uuid,
    },
    CommandResult {
        command_id: Uuid,
        killed: Vec<Uuid>,
        missing: Vec<Uuid>,
        failed: Vec<Uuid>,
    },
    SessionRevocationResult {
        command_id: Uuid,
        revoked: usize,
    },
    LeaseRefresh {
        registration_id: Uuid,
        admission_lease: AdmissionLease,
    },
    Pong {
        nonce: u64,
    },
}

impl ClientFrame {
    pub fn validate(&self) -> Result<(), FrameError> {
        match self {
            Self::ClientHello {
                package_version, ..
            } => validate_text(
                package_version,
                MAX_PACKAGE_VERSION_BYTES,
                ValidationError::PackageVersion,
            )?,
            Self::SnapshotChunk { rows } => {
                if rows.len() > MAX_SNAPSHOT_CHUNK_ROWS {
                    return Err(FrameError::SnapshotChunkTooLarge(rows.len()));
                }
                for row in rows {
                    row.validate_fields()?;
                }
            }
            Self::BrowserSessionSnapshotChunk { rows } => {
                if rows.len() > MAX_SNAPSHOT_CHUNK_ROWS {
                    return Err(FrameError::SnapshotChunkTooLarge(rows.len()));
                }
                for row in rows {
                    row.validate()?;
                }
            }
            Self::TunnelUp { row, .. } => row.validate_fields()?,
            Self::BrowserSessionUp { row, .. } => row.validate()?,
            Self::BrowserSessionDown {
                admin_session_id, ..
            } if admin_session_id.is_nil() => return Err(ValidationError::Uuid.into()),
            Self::AdmissionRequest {
                registration_id,
                owner_user_id,
                user,
                devserver_id,
                ..
            } => AdmissionLeaseBinding {
                owner_user_id: *owner_user_id,
                user: user.clone(),
                devserver_id: devserver_id.clone(),
                registration_id: *registration_id,
                proxy_id: ProxyId::parse("placeholder").expect("constant proxy id"),
            }
            .validate()?,
            Self::CommandResult {
                killed,
                missing,
                failed,
                ..
            } if killed.len() + missing.len() + failed.len() > MAX_COMMAND_REGISTRATIONS => {
                return Err(FrameError::CommandResultTooLarge);
            }
            Self::SessionRevocationResult {
                command_id,
                revoked,
            } => {
                if command_id.is_nil() {
                    return Err(ValidationError::Uuid.into());
                }
                if *revoked > MAX_SESSION_REVOCATION_COUNT {
                    return Err(FrameError::SessionRevocationResultTooLarge);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

impl TunnelRow {
    pub fn binding_for(&self, proxy_id: ProxyId) -> AdmissionLeaseBinding {
        AdmissionLeaseBinding {
            owner_user_id: self.owner_user_id,
            user: self.user.clone(),
            devserver_id: self.devserver_id.clone(),
            registration_id: self.registration_id,
            proxy_id,
        }
    }

    fn validate_fields(&self) -> Result<(), ValidationError> {
        self.binding_for(ProxyId::parse("placeholder").expect("constant proxy id"))
            .validate()?;
        if !(1..=MAX_SIGNED_CONNECTED_DEVSERVERS).contains(&self.max_connected_devservers) {
            return Err(ValidationError::DevserverLimit);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionDecision {
    Admit,
    AtCapacity,
    ControlWarming,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "snake_case")]
pub enum SessionRevocation {
    Exact {
        subject_user_id: Uuid,
        owner_user_id: Uuid,
        devserver_id: String,
    },
    Subject {
        subject_user_id: Uuid,
    },
    SessionId {
        admin_session_id: Uuid,
    },
    Owner {
        owner_user_id: Uuid,
    },
    All,
}

impl SessionRevocation {
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Exact {
                subject_user_id,
                owner_user_id,
                devserver_id,
            } => {
                if subject_user_id.is_nil() || owner_user_id.is_nil() {
                    return Err(ValidationError::Uuid);
                }
                validate_text(
                    devserver_id,
                    MAX_DEVSERVER_ID_BYTES,
                    ValidationError::DevserverId,
                )
            }
            Self::Subject { subject_user_id } => {
                if subject_user_id.is_nil() {
                    return Err(ValidationError::Uuid);
                }
                Ok(())
            }
            Self::SessionId { admin_session_id } => {
                if admin_session_id.is_nil() {
                    return Err(ValidationError::Uuid);
                }
                Ok(())
            }
            Self::Owner { owner_user_id } => {
                if owner_user_id.is_nil() {
                    return Err(ValidationError::Uuid);
                }
                Ok(())
            }
            Self::All => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    ServerHello {
        protocol_version: u16,
        package_version: String,
        heartbeat_seconds: u64,
        dead_seconds: u64,
        grace_seconds: u64,
    },
    SnapshotAccepted {
        base_generation: u64,
    },
    FleetReady,
    AdmissionDecision {
        request_id: Uuid,
        registration_id: Uuid,
        decision: AdmissionDecision,
    },
    KillRegistrations {
        command_id: Uuid,
        registration_ids: Vec<Uuid>,
    },
    RevokeSessions {
        command_id: Uuid,
        revocation: SessionRevocation,
    },
    ResyncRequired {
        expected_generation: u64,
    },
    Ping {
        nonce: u64,
    },
    Shutdown {
        reason: String,
        retryable: bool,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("control frame length is zero")]
    ZeroLength,
    #[error("control frame is too large: {0} bytes")]
    TooLarge(usize),
    #[error("snapshot chunk exceeds {MAX_SNAPSHOT_CHUNK_ROWS} rows: {0}")]
    SnapshotChunkTooLarge(usize),
    #[error("command result exceeds the registration bound")]
    CommandResultTooLarge,
    #[error("session revocation result exceeds the configured bound")]
    SessionRevocationResultTooLarge,
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error("control frame I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("control frame JSON: {0}")]
    Json(#[from] serde_json::Error),
}

pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let len = reader.read_u32().await? as usize;
    if len == 0 {
        return Err(FrameError::ZeroLength);
    }
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(len));
    }
    let mut payload = vec![0; len];
    reader.read_exact(&mut payload).await?;
    Ok(serde_json::from_slice(&payload)?)
}

pub async fn write_frame<W, T>(writer: &mut W, frame: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(frame)?;
    if payload.is_empty() {
        return Err(FrameError::ZeroLength);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(payload.len()));
    }
    writer.write_u32(payload.len() as u32).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease_fixture(
        owner_user_id: Uuid,
        registration_id: Uuid,
    ) -> (AdmissionLeaseSigner, AdmissionLease) {
        let signer =
            AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                .unwrap();
        let lease = signer
            .sign(
                AdmissionLeaseBinding {
                    owner_user_id,
                    user: "alice".into(),
                    devserver_id: "devserver".into(),
                    registration_id,
                    proxy_id: ProxyId::parse("p1").unwrap(),
                },
                3,
                Utc::now(),
                120,
            )
            .unwrap();
        (signer, lease)
    }

    #[test]
    fn admission_lease_refuses_wrong_key_tamper_expiry_and_noncanonical_key() {
        let owner_user_id = Uuid::new_v4();
        let registration_id = Uuid::new_v4();
        let (signer, lease) = lease_fixture(owner_user_id, registration_id);
        let verifier = AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap();
        let now = Utc::now();
        let claims = verifier.verify(&lease, now).unwrap();
        assert_eq!(claims.binding.owner_user_id, owner_user_id);
        assert_eq!(claims.binding.registration_id, registration_id);
        assert_eq!(claims.max_connected_devservers, 3);

        let other =
            AdmissionLeaseSigner::from_base64("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")
                .unwrap();
        let wrong = AdmissionLeaseVerifier::from_base64(&other.verifying_key_base64()).unwrap();
        assert!(matches!(
            wrong.verify(&lease, now),
            Err(LeaseError::Signature)
        ));

        let mut tampered = lease.as_str().as_bytes().to_vec();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        let tampered = AdmissionLease::parse(String::from_utf8(tampered).unwrap()).unwrap();
        assert!(verifier.verify(&tampered, now).is_err());
        assert!(matches!(
            verifier.verify(&lease, now + chrono::Duration::seconds(121)),
            Err(LeaseError::Time)
        ));
        assert!(
            AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
                .is_err()
        );
    }

    #[test]
    fn admission_lease_limit_is_required_positive_and_finite() {
        let owner_user_id = Uuid::new_v4();
        let registration_id = Uuid::new_v4();
        let (signer, lease) = lease_fixture(owner_user_id, registration_id);
        let binding = AdmissionLeaseBinding {
            owner_user_id,
            user: "alice".into(),
            devserver_id: "devserver".into(),
            registration_id,
            proxy_id: ProxyId::parse("p1").unwrap(),
        };
        let now = Utc::now();
        assert!(matches!(
            signer.sign(binding.clone(), 0, now, 120),
            Err(LeaseError::Limit)
        ));
        assert!(matches!(
            signer.sign(
                binding,
                MAX_SIGNED_CONNECTED_DEVSERVERS.saturating_add(1),
                now,
                120,
            ),
            Err(LeaseError::Limit)
        ));

        // Sign an otherwise-valid legacy payload with the claim removed. The
        // verifier must reject it after crypto rather than supplying a default.
        let payload = lease.as_str().split('.').nth(1).unwrap();
        let mut claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        claims
            .as_object_mut()
            .unwrap()
            .remove("max_connected_devservers");
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signed = format!("v1.{payload}");
        let signature = signer.0.sign(signed.as_bytes());
        let missing = AdmissionLease::parse(format!(
            "{signed}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
        .unwrap();
        let verifier = AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap();
        assert!(matches!(
            verifier.verify(&missing, now),
            Err(LeaseError::Json(_))
        ));
    }

    #[test]
    fn admission_verifier_rotation_accepts_two_distinct_keys_only() {
        let first =
            AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                .unwrap();
        let second =
            AdmissionLeaseSigner::from_base64("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE")
                .unwrap();
        let binding = AdmissionLeaseBinding {
            owner_user_id: Uuid::new_v4(),
            user: "alice".into(),
            devserver_id: "devserver".into(),
            registration_id: Uuid::new_v4(),
            proxy_id: ProxyId::parse("p1").unwrap(),
        };
        let now = Utc::now();
        let first_lease = first.sign(binding.clone(), 3, now, 120).unwrap();
        let second_lease = second.sign(binding, 3, now, 120).unwrap();
        let first_key = first.verifying_key_base64();
        let second_key = second.verifying_key_base64();
        let ring =
            AdmissionLeaseVerifier::from_base64_rotation(&format!("{first_key};{second_key}"))
                .unwrap();
        assert!(ring.verify(&first_lease, now).is_ok());
        assert!(ring.verify(&second_lease, now).is_ok());
        assert!(
            AdmissionLeaseVerifier::from_base64_rotation(&format!("{first_key};{first_key}"))
                .is_err()
        );
        assert!(AdmissionLeaseVerifier::from_base64_rotation(&format!(
            "{first_key};{second_key};{first_key}"
        ))
        .is_err());
    }

    #[test]
    fn admission_lease_deserialization_enforces_wire_length_before_crypto() {
        assert!(serde_json::from_str::<AdmissionLease>(r#"""#).is_err());
        let exact = "x".repeat(MAX_ADMISSION_LEASE_BYTES);
        assert!(AdmissionLease::parse(exact).is_ok());
        let oversized = serde_json::to_string(&"x".repeat(MAX_ADMISSION_LEASE_BYTES + 1)).unwrap();
        assert!(serde_json::from_str::<AdmissionLease>(&oversized).is_err());
        assert!(serde_json::from_str::<AdmissionLease>(r#""x""#).is_ok());
    }

    #[test]
    fn admission_lease_debug_never_discloses_the_opaque_credential() {
        let sentinel = "v1.secret-payload.secret-signature";
        let lease = AdmissionLease::parse(sentinel).unwrap();
        let debug = format!("{lease:?}");
        assert!(debug.contains("REDACTED"));
        assert!(!debug.contains(sentinel));
        assert!(!debug.contains("secret-payload"));
    }

    #[test]
    fn validates_ids_and_origins() {
        assert_eq!(ProxyId::parse("p1").unwrap().as_str(), "p1");
        for bad in ["", "P1", "-p1", "p1-", "p_1", "a.b"] {
            assert!(ProxyId::parse(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(
            CanonicalOrigin::parse("https://p1.example.test:443")
                .unwrap()
                .as_str(),
            "https://p1.example.test"
        );
        for bad in [
            "ftp://p1.example.test",
            "https://user@p1.example.test",
            "https://p1.example.test/path",
            "https://p1.example.test/?query=1",
        ] {
            assert!(CanonicalOrigin::parse(bad).is_err(), "accepted {bad:?}");
        }
        let template = ProxyOriginTemplate::parse("https://{proxy_id}.proxy.example.test").unwrap();
        assert_eq!(
            template
                .expand(&ProxyId::parse("p1").unwrap())
                .unwrap()
                .as_str(),
            "https://p1.proxy.example.test"
        );
        for bad in [
            "https://proxy.example.test",
            "https://{proxy_id}.{proxy_id}.example.test",
            "https://example.test/{proxy_id}",
        ] {
            assert!(ProxyOriginTemplate::parse(bad).is_err(), "accepted {bad:?}");
        }

        let invalid_id = r#"{"type":"client_hello","protocol_version":1,"package_version":"0.73.0","proxy_id":"P1","proxy_base_url":"https://p1.example.test","boot_id":"00000000-0000-0000-0000-000000000000"}"#;
        assert!(serde_json::from_str::<ClientFrame>(invalid_id).is_err());
        let invalid_origin = r#"{"type":"client_hello","protocol_version":1,"package_version":"0.73.0","proxy_id":"p1","proxy_base_url":"ftp://p1.example.test","boot_id":"00000000-0000-0000-0000-000000000000"}"#;
        assert!(serde_json::from_str::<ClientFrame>(invalid_origin).is_err());
    }

    #[test]
    fn origin_and_template_parsers_enforce_exact_wire_length_bounds() {
        let label = "a".repeat(63);
        let final_label = "b".repeat(56);
        let exact_origin = format!("https://{label}.{label}.{label}.{final_label}");
        assert_eq!(exact_origin.len(), MAX_ORIGIN_BYTES);
        assert!(CanonicalOrigin::parse(&exact_origin).is_ok());
        assert!(CanonicalOrigin::parse(&(exact_origin.clone() + "x")).is_err());
        let encoded = serde_json::to_string(&(exact_origin + "x")).unwrap();
        assert!(serde_json::from_str::<CanonicalOrigin>(&encoded).is_err());

        let template_tail = "b".repeat(45);
        let exact_template =
            format!("https://{{proxy_id}}.{label}.{label}.{label}.{template_tail}");
        assert_eq!(exact_template.len(), MAX_ORIGIN_BYTES);
        assert!(ProxyOriginTemplate::parse(&exact_template).is_ok());
        assert!(ProxyOriginTemplate::parse(&(exact_template + "x")).is_err());
    }

    #[test]
    fn textual_protocol_fields_accept_exact_limits_and_reject_one_above() {
        let binding = AdmissionLeaseBinding {
            owner_user_id: Uuid::new_v4(),
            user: "u".repeat(MAX_USERNAME_BYTES),
            devserver_id: "d".repeat(MAX_DEVSERVER_ID_BYTES),
            registration_id: Uuid::new_v4(),
            proxy_id: ProxyId::parse("p1").unwrap(),
        };
        assert!(binding.validate().is_ok());
        let mut oversized_user = binding.clone();
        oversized_user.user.push('u');
        assert_eq!(oversized_user.validate(), Err(ValidationError::Username));
        let mut oversized_devserver = binding;
        oversized_devserver.devserver_id.push('d');
        assert_eq!(
            oversized_devserver.validate(),
            Err(ValidationError::DevserverId)
        );

        let mut hello = ClientFrame::ClientHello {
            protocol_version: PROTOCOL_VERSION,
            package_version: "v".repeat(MAX_PACKAGE_VERSION_BYTES),
            proxy_id: ProxyId::parse("p1").unwrap(),
            proxy_base_url: CanonicalOrigin::parse("https://p1.example.test").unwrap(),
            boot_id: Uuid::new_v4(),
        };
        assert!(hello.validate().is_ok());
        let ClientFrame::ClientHello {
            package_version, ..
        } = &mut hello
        else {
            unreachable!()
        };
        package_version.push('v');
        assert!(matches!(
            hello.validate(),
            Err(FrameError::Validation(ValidationError::PackageVersion))
        ));
    }

    #[tokio::test]
    async fn every_frame_round_trips() {
        let registration_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let command_id = Uuid::new_v4();
        let boot_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let (_, admission_lease) = lease_fixture(owner_user_id, registration_id);
        let row = TunnelRow {
            registration_id,
            owner_user_id,
            user: "alice".into(),
            devserver_id: "devserver".into(),
            max_connected_devservers: 3,
            admission_lease: admission_lease.clone(),
            admission_lease_expires_at: Utc::now() + chrono::Duration::seconds(120),
            peer_addr: Some("127.0.0.1:7001".parse().unwrap()),
            connected_at: Utc::now(),
        };
        let browser_session = BrowserSessionRow {
            admin_session_id: Uuid::new_v4(),
            subject_user_id: Uuid::new_v4(),
            owner_user_id,
            devserver_id: "devserver".into(),
            created_at: Utc::now(),
            expires_at: Utc::now() + chrono::Duration::minutes(30),
        };
        let clients = vec![
            ClientFrame::ClientHello {
                protocol_version: PROTOCOL_VERSION,
                package_version: "0.73.0".into(),
                proxy_id: ProxyId::parse("p1").unwrap(),
                proxy_base_url: CanonicalOrigin::parse("https://p1.example.test").unwrap(),
                boot_id,
            },
            ClientFrame::SnapshotStart { base_generation: 7 },
            ClientFrame::SnapshotChunk {
                rows: vec![row.clone()],
            },
            ClientFrame::BrowserSessionSnapshotChunk {
                rows: vec![browser_session.clone()],
            },
            ClientFrame::SnapshotEnd { base_generation: 7 },
            ClientFrame::TunnelUp {
                generation: 8,
                row: row.clone(),
            },
            ClientFrame::TunnelDown {
                generation: 9,
                registration_id,
            },
            ClientFrame::BrowserSessionUp {
                generation: 10,
                row: browser_session.clone(),
            },
            ClientFrame::BrowserSessionDown {
                generation: 11,
                admin_session_id: browser_session.admin_session_id,
            },
            ClientFrame::AdmissionRequest {
                request_id,
                registration_id,
                owner_user_id,
                user: "alice".into(),
                devserver_id: "devserver".into(),
                admission_lease: admission_lease.clone(),
            },
            ClientFrame::AdmissionCancel {
                request_id,
                registration_id,
            },
            ClientFrame::CommandResult {
                command_id,
                killed: vec![registration_id],
                missing: Vec::new(),
                failed: Vec::new(),
            },
            ClientFrame::SessionRevocationResult {
                command_id,
                revoked: 1,
            },
            ClientFrame::LeaseRefresh {
                registration_id,
                admission_lease,
            },
            ClientFrame::Pong { nonce: 42 },
        ];
        for frame in clients {
            let (mut client, mut server) = tokio::io::duplex(4096);
            write_frame(&mut client, &frame).await.unwrap();
            let decoded: ClientFrame = read_frame(&mut server).await.unwrap();
            assert_eq!(decoded, frame);
        }

        let servers = vec![
            ServerFrame::ServerHello {
                protocol_version: PROTOCOL_VERSION,
                package_version: "0.73.0".into(),
                heartbeat_seconds: 5,
                dead_seconds: 15,
                grace_seconds: 30,
            },
            ServerFrame::SnapshotAccepted { base_generation: 7 },
            ServerFrame::FleetReady,
            ServerFrame::AdmissionDecision {
                request_id,
                registration_id,
                decision: AdmissionDecision::Admit,
            },
            ServerFrame::KillRegistrations {
                command_id,
                registration_ids: vec![registration_id],
            },
            ServerFrame::RevokeSessions {
                command_id,
                revocation: SessionRevocation::SessionId {
                    admin_session_id: browser_session.admin_session_id,
                },
            },
            ServerFrame::ResyncRequired {
                expected_generation: 8,
            },
            ServerFrame::Ping { nonce: 42 },
            ServerFrame::Shutdown {
                reason: "test".into(),
                retryable: true,
            },
        ];
        for frame in servers {
            let (mut client, mut server) = tokio::io::duplex(4096);
            write_frame(&mut client, &frame).await.unwrap();
            let decoded: ServerFrame = read_frame(&mut server).await.unwrap();
            assert_eq!(decoded, frame);
        }
    }

    #[tokio::test]
    async fn rejects_bad_lengths_truncation_and_malformed_json() {
        let (mut client, mut server) = tokio::io::duplex(16);
        client.write_u32(0).await.unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(&mut server).await,
            Err(FrameError::ZeroLength)
        ));

        let (mut client, mut server) = tokio::io::duplex(16);
        client
            .write_u32((MAX_FRAME_BYTES + 1) as u32)
            .await
            .unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(&mut server).await,
            Err(FrameError::TooLarge(_))
        ));

        let (mut client, mut server) = tokio::io::duplex(16);
        client.write_u32(4).await.unwrap();
        client.write_all(b"{}").await.unwrap();
        drop(client);
        assert!(matches!(
            read_frame::<_, ServerFrame>(&mut server).await,
            Err(FrameError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
        ));

        let (mut client, mut server) = tokio::io::duplex(16);
        client.write_u32(1).await.unwrap();
        client.write_all(b"{").await.unwrap();
        assert!(matches!(
            read_frame::<_, ServerFrame>(&mut server).await,
            Err(FrameError::Json(_))
        ));
    }

    #[test]
    fn snapshot_chunks_are_bounded() {
        let owner_user_id = Uuid::new_v4();
        let registration_id = Uuid::new_v4();
        let (_, admission_lease) = lease_fixture(owner_user_id, registration_id);
        let row = TunnelRow {
            registration_id,
            owner_user_id,
            user: "alice".into(),
            devserver_id: "devserver".into(),
            max_connected_devservers: 3,
            admission_lease,
            admission_lease_expires_at: Utc::now() + chrono::Duration::seconds(120),
            peer_addr: None,
            connected_at: Utc::now(),
        };
        let frame = ClientFrame::SnapshotChunk {
            rows: vec![row.clone(); MAX_SNAPSHOT_CHUNK_ROWS],
        };
        assert!(frame.validate().is_ok());
        let frame = ClientFrame::SnapshotChunk {
            rows: vec![row; MAX_SNAPSHOT_CHUNK_ROWS + 1],
        };
        assert!(matches!(
            frame.validate(),
            Err(FrameError::SnapshotChunkTooLarge(_))
        ));
    }
}
