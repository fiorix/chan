//! chan-tunnel server library.
//!
//! The entry point is `serve_tunnel_listener`, an h2c accept loop
//! that runs `h2::server` directly on the TCP socket to serve
//! `POST /v1/tunnel`; nginx (`grpc_pass`) forwards h2c from the
//! tunnel ingress (`usr.chan.app/v1/tunnel`) to devserver-proxy,
//! which runs this listener.
//! After the Hello/HelloAck handshake the duplex is handed to
//! yamux, the registered workspace is inserted into the shared
//! `Registry`, and the server side opens new substreams to forward
//! public requests.
//!
//! For the wire test the handshake is exposed as a free function
//! over any tokio duplex.

#![forbid(unsafe_code)]

use std::time::Duration;

use async_trait::async_trait;
use chan_tunnel_proto::{error_code, read_frame, write_frame, Hello, HelloAck, ProtocolVersion};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};
use yamux::{Config as YamuxConfig, Connection as YamuxConnection, Mode};

/// Hard cap on how long the server waits for a client's Hello after
/// sending 200. A peer that connects, gets the OK, then never sends
/// the framed Hello (slow loris) is bounded by this. 15s is plenty
/// for the trans-pacific case; tighter would risk false positives
/// on slow mobile uplinks.
const HELLO_READ_TIMEOUT: Duration = Duration::from_secs(15);

/// Cap on the HTTP/2 connection-level handshake (SETTINGS exchange).
/// A peer that opens TCP and never speaks h2 stays bounded by this.
pub(crate) const H2_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Cap on the wait for the peer's first stream (the POST /v1/tunnel)
/// after the h2 handshake completes. A peer that finishes SETTINGS
/// and then idles is bounded here.
pub(crate) const FIRST_STREAM_TIMEOUT: Duration = Duration::from_secs(10);

/// Cap on the validator round-trip. Independent of any timeout the
/// `Validator` impl might enforce internally so a hung identity
/// service cannot pin a tunnel handshake task indefinitely.
pub(crate) const VALIDATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Soft cap on how many tunnel connections can be in the
/// authenticate + handshake phase simultaneously. Above this, new
/// TCP accepts are rejected immediately (closing the socket) so the
/// listener cannot be exhausted with half-open / slow-loris peers
/// that have not yet reached the per-stage timeouts above. 1024 is
/// plenty for normal client churn; a real outage will recover within
/// one timeout cycle.
pub(crate) const MAX_INFLIGHT_HANDSHAKES: usize = 1024;

/// Base scope required for any tunnel dial. The validator must
/// return this in `Validated::scopes` for the handshake to proceed
/// past the 200 response.
pub const TUNNEL_SCOPE: &str = "tunnel";

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("invalid token")]
    InvalidToken,

    #[error("token does not have tunnel scope")]
    MissingScope,

    /// Upstream identity service failure. The wrapped string is
    /// logged at the listener (`tracing::warn!`) and may end up in
    /// operator-visible journals, so `Validator` implementations
    /// MUST NOT include the bearer token, any prefix of it, any URL
    /// that carries it as a query parameter, or any header value
    /// that echoes it. Treat the payload as user-visible.
    #[error("upstream identity service: {0}")]
    Identity(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("handshake: {0}")]
    Handshake(String),

    #[error("user {user} reached max concurrent workspaces ({max})")]
    TooManyWorkspaces { user: String, max: usize },

    #[error("user {user} reached the fleet-wide devserver limit")]
    AdmissionAtCapacity { user: String },

    #[error("devserver control is unavailable")]
    ControlUnavailable,
}

impl From<chan_tunnel_proto::FrameError> for ServerError {
    fn from(e: chan_tunnel_proto::FrameError) -> Self {
        ServerError::Handshake(e.to_string())
    }
}

impl From<chan_tunnel_proto::IoFrameError> for ServerError {
    fn from(e: chan_tunnel_proto::IoFrameError) -> Self {
        match e {
            chan_tunnel_proto::IoFrameError::Io(e) => ServerError::Io(e),
            chan_tunnel_proto::IoFrameError::Frame(e) => ServerError::Handshake(e.to_string()),
        }
    }
}

/// Result of validating a bearer token. Returned by `Validator`
/// and used to populate the HelloAck plus the registry key.
///
/// The registration identity is resolved from the TOKEN, not from the
/// client's `Hello`: `devserver_id` is the second registry key (one
/// devserver per user, keyed on `(username, devserver_id)`). The client's
/// `Hello.workspace` is an ignored placeholder label. The validator
/// derives `devserver_id` from the PAT (the gateway uses the PAT's
/// SHA-256), so token rotation yields a fresh devserver.
#[derive(Clone)]
pub struct Validated {
    pub user_id: uuid::Uuid,
    pub username: String,
    /// Token-resolved devserver identity; the registry's second key.
    pub devserver_id: String,
    pub scopes: Vec<String>,
    /// Per-tunnel key used by devserver-proxy to sign caller assertions
    /// for requests forwarded through this registration.
    pub gateway_assertion_key: Option<chan_tunnel_proto::gateway_assertion::AssertionKey>,
    /// Opaque identity-signed authority for this exact registration.
    /// Controller-backed deployments require it; local deployments do not.
    pub admission_lease: Option<String>,
    pub admission_lease_expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl std::fmt::Debug for Validated {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Validated")
            .field("user_id", &self.user_id)
            .field("username", &self.username)
            .field("devserver_id", &self.devserver_id)
            .field("scopes", &self.scopes)
            .field(
                "gateway_assertion_key",
                &self.gateway_assertion_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "admission_lease",
                &self.admission_lease.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "admission_lease_expires_at",
                &self.admission_lease_expires_at,
            )
            .finish()
    }
}

/// Token validation hook. Implemented by the consumer (e.g. an
/// identity-service client); tests use a stub.
///
/// **Token-handling contract.** The `token` argument is the bearer
/// secret. Implementations MUST NOT:
///
/// - log it (including at debug / trace levels),
/// - return it (or any prefix of it) inside `ServerError::Identity`,
///   `ServerError::Handshake`, or any other error variant,
/// - return any URL that carries it as a query parameter or path
///   segment,
/// - persist it beyond the call duration.
///
/// The chan-tunnel listener logs `ServerError` values via
/// `tracing::warn!`, so anything echoed back will land in operator
/// journals. The crate itself never logs the token; this boundary is
/// the only place the guarantee can be broken.
#[async_trait]
pub trait Validator: Send + Sync + 'static {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError>;

    /// Contextual validation for a specific registration. Production
    /// identity clients override this to mint a registration-bound lease;
    /// local validators inherit the ordinary validation behavior.
    async fn validate_registration(
        &self,
        token: &str,
        _registration_id: uuid::Uuid,
    ) -> Result<Validated, ServerError> {
        self.validate(token).await
    }

    /// Report the display name the client announced in its `Hello`,
    /// once the registration is accepted. The token is passed again
    /// because the name arrives one wire step after `validate` (the
    /// `Hello` is read only after the 200), so the implementation
    /// carries it into the same identity exchange as a follow-up.
    /// Best-effort and fire-and-forget: failures must be swallowed
    /// (logged) by the implementation, never fail the tunnel. The
    /// token-handling contract above applies unchanged. Default:
    /// drop the name (stub validators, deployments without a roster).
    async fn announce_devserver_name(&self, token: &str, name: &str) {
        let _ = (token, name);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RegistrationPermit {
    pub request_id: uuid::Uuid,
    pub registration_id: uuid::Uuid,
    pub admission_epoch: u64,
}

#[async_trait]
pub trait RegistrationAdmission: Send + Sync + 'static {
    async fn admit(
        &self,
        hello: &Hello,
        validated: &Validated,
    ) -> Result<RegistrationPermit, ServerError>;

    async fn admit_registration(
        &self,
        hello: &Hello,
        validated: &Validated,
        registration_id: uuid::Uuid,
    ) -> Result<RegistrationPermit, ServerError> {
        let mut permit = self.admit(hello, validated).await?;
        permit.registration_id = registration_id;
        Ok(permit)
    }

    /// Synchronous fence checked immediately before and after the registry
    /// insert. Controller-backed implementations invalidate an epoch when
    /// control is lost so an already-admitted but stalled handshake cannot
    /// register after fail-closed eviction has run.
    fn permit_is_current(&self, _permit: RegistrationPermit) -> bool {
        true
    }

    async fn cancel(&self, _permit: RegistrationPermit) {}
}

pub struct AllowAllAdmission;

#[async_trait]
impl RegistrationAdmission for AllowAllAdmission {
    async fn admit(
        &self,
        _hello: &Hello,
        _validated: &Validated,
    ) -> Result<RegistrationPermit, ServerError> {
        Ok(RegistrationPermit {
            request_id: uuid::Uuid::new_v4(),
            registration_id: uuid::Uuid::new_v4(),
            admission_epoch: 0,
        })
    }
}

/// Public path prefix shape: `/{key}`, where `key` is the registration's
/// second registry key (the token-resolved `devserver_id`). The fronting
/// proxy uses wildcard subdomains (`{user}.devserver.chan.app`), so the
/// username lives in the host header, not in the path. A devserver tenant
/// already self-prefixes at its own public slug and the proxy forwards the
/// full path, so the devserver client ignores this prefix; it is retained
/// for the registration round-trip shape. No trailing slash.
fn make_prefix(_username: &str, key: &str) -> String {
    format!("/{key}")
}

/// Workspace the Hello/HelloAck round-trip over `socket`. Validates
/// the bearer `token` via `validator` and uses the workspace name from
/// the client's Hello to build the public path. Returns the yamux
/// server connection ready to open outbound substreams.
///
/// `pre_ack` runs after the token is validated and before the
/// HelloAck is written. Returning an error from it aborts the
/// handshake without registering anything; the caller uses it for
/// post-validate policy checks (per-user workspace limits, etc.).
///
/// Order of operations: validator runs first, *then* the Hello is
/// read and the workspace name validated. The tunnel listener
/// (`handle_tunnel_conn`) needs that order to send 401 on bad
/// tokens before committing to the body, and consistency keeps the
/// two paths from diverging.
pub async fn handshake<S, V, F>(
    socket: S,
    token: &str,
    validator: &V,
    pre_ack: F,
) -> Result<(Hello, Validated, YamuxConnection<Compat<S>>), ServerError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    V: Validator + ?Sized,
    F: FnOnce(&Hello, &Validated) -> Result<(), ServerError>,
{
    let validated = validator.validate(token).await?;
    if !validated.scopes.iter().any(|s| s == TUNNEL_SCOPE) {
        return Err(ServerError::MissingScope);
    }
    handshake_validated(socket, validated, pre_ack).await
}

/// Like `handshake` but takes an already-validated identity. Used
/// by the tunnel listener to validate the token *before* sending
/// the 200 response so a 401 can come back when validation fails;
/// once we've replied 200, this finishes the wire dance (Hello in,
/// workspace-name check, pre_ack, HelloAck out, yamux wrap).
pub async fn handshake_validated<S, F>(
    mut socket: S,
    validated: Validated,
    pre_ack: F,
) -> Result<(Hello, Validated, YamuxConnection<Compat<S>>), ServerError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: FnOnce(&Hello, &Validated) -> Result<(), ServerError>,
{
    // Defense-in-depth: the validator has already authenticated the
    // token, but the username it returns flows into the public host
    // `{user}.devserver.chan.app`. If the upstream identity service ever
    // emits a username with `/`, `..`, whitespace, or other
    // host-affecting bytes, the fronting proxy would mis-route or
    // leak it. Refuse here so the rest of the pipeline can
    // assume the username is URL-safe.
    if !chan_tunnel_proto::is_valid_username(&validated.username) {
        return Err(ServerError::Handshake(format!(
            "validator returned an unsafe username for the public path: {:?}",
            validated.username
        )));
    }
    let hello: Hello = match tokio::time::timeout(HELLO_READ_TIMEOUT, read_frame(&mut socket)).await
    {
        Ok(r) => r?,
        Err(_) => {
            return Err(ServerError::Handshake(format!(
                "timed out waiting for Hello after {HELLO_READ_TIMEOUT:?}"
            )));
        }
    };
    if hello.protocol != ProtocolVersion::V1 {
        let msg = format!("client requested unsupported protocol {:?}", hello.protocol);
        write_refusal(&mut socket, error_code::UNSUPPORTED_PROTOCOL, &msg).await;
        return Err(ServerError::Handshake(msg));
    }
    if !chan_tunnel_proto::is_valid_workspace_name(&hello.workspace) {
        let msg = format!("invalid workspace name {:?}", hello.workspace);
        write_refusal(&mut socket, error_code::INVALID_WORKSPACE_NAME, &msg).await;
        return Err(ServerError::Handshake(msg));
    }

    if let Err(e) = pre_ack(&hello, &validated) {
        let (code, msg) = refusal_for(&e);
        write_refusal(&mut socket, code, &msg).await;
        return Err(e);
    }

    // Identity is token-resolved: the registration keys on `devserver_id`,
    // not the client's `Hello.workspace` placeholder. The ack echoes the
    // resolved id so the client + registry + admin view all agree.
    let ack = HelloAck::Ok(chan_tunnel_proto::HelloAckOk {
        protocol: ProtocolVersion::V1,
        prefix: make_prefix(&validated.username, &validated.devserver_id),
        user: validated.username.clone(),
        workspace: validated.devserver_id.clone(),
        owner_user_id: validated.user_id.to_string(),
    });
    write_frame(&mut socket, &ack).await?;

    let yamux = YamuxConnection::new(socket.compat(), tunnel_yamux_config(), Mode::Server);
    Ok((hello, validated, yamux))
}

async fn handshake_validated_with_admission<S>(
    mut socket: S,
    validated: Validated,
    admission: &dyn RegistrationAdmission,
    registration_id: uuid::Uuid,
) -> Result<
    (
        Hello,
        Validated,
        RegistrationPermit,
        YamuxConnection<Compat<S>>,
    ),
    ServerError,
>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if !chan_tunnel_proto::is_valid_username(&validated.username) {
        return Err(ServerError::Handshake(format!(
            "validator returned an unsafe username for the public path: {:?}",
            validated.username
        )));
    }
    let hello: Hello = match tokio::time::timeout(HELLO_READ_TIMEOUT, read_frame(&mut socket)).await
    {
        Ok(result) => result?,
        Err(_) => {
            return Err(ServerError::Handshake(format!(
                "timed out waiting for Hello after {HELLO_READ_TIMEOUT:?}"
            )))
        }
    };
    if hello.protocol != ProtocolVersion::V1 {
        let message = format!("client requested unsupported protocol {:?}", hello.protocol);
        write_refusal(&mut socket, error_code::UNSUPPORTED_PROTOCOL, &message).await;
        return Err(ServerError::Handshake(message));
    }
    if !chan_tunnel_proto::is_valid_workspace_name(&hello.workspace) {
        let message = format!("invalid workspace name {:?}", hello.workspace);
        write_refusal(&mut socket, error_code::INVALID_WORKSPACE_NAME, &message).await;
        return Err(ServerError::Handshake(message));
    }

    let permit = match tokio::time::timeout(
        VALIDATE_TIMEOUT,
        admission.admit_registration(&hello, &validated, registration_id),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        Ok(Err(error)) => {
            let (code, message) = refusal_for(&error);
            write_refusal(&mut socket, code, &message).await;
            return Err(error);
        }
        Err(_) => {
            let error = ServerError::ControlUnavailable;
            let (code, message) = refusal_for(&error);
            write_refusal(&mut socket, code, &message).await;
            return Err(error);
        }
    };

    if !admission.permit_is_current(permit) {
        let error = ServerError::ControlUnavailable;
        admission.cancel(permit).await;
        let (code, message) = refusal_for(&error);
        write_refusal(&mut socket, code, &message).await;
        return Err(error);
    }

    let ack = HelloAck::Ok(chan_tunnel_proto::HelloAckOk {
        protocol: ProtocolVersion::V1,
        prefix: make_prefix(&validated.username, &validated.devserver_id),
        user: validated.username.clone(),
        workspace: validated.devserver_id.clone(),
        owner_user_id: validated.user_id.to_string(),
    });
    if let Err(error) = write_frame(&mut socket, &ack).await {
        admission.cancel(permit).await;
        return Err(error.into());
    }

    let yamux = YamuxConnection::new(socket.compat(), tunnel_yamux_config(), Mode::Server);
    Ok((hello, validated, permit, yamux))
}

/// Map a protocol-level policy or admission error to a
/// `(code, message)` pair the client can match on. Codes are stable
/// strings defined in `chan_tunnel_proto::error_code`; messages are
/// user-visible.
fn refusal_for(e: &ServerError) -> (&'static str, String) {
    match e {
        ServerError::ControlUnavailable => (
            error_code::CONTROL_UNAVAILABLE,
            "devserver control is unavailable".to_string(),
        ),
        ServerError::TooManyWorkspaces { user, max } => (
            error_code::TOO_MANY_WORKSPACES,
            format!("user {user} reached max concurrent workspaces ({max})"),
        ),
        ServerError::AdmissionAtCapacity { user } => (
            error_code::TOO_MANY_WORKSPACES,
            format!("user {user} reached the fleet-wide devserver limit"),
        ),
        // Other variants (InvalidToken, MissingScope, Identity, Io,
        // Handshake) are handled at the listener layer before
        // handshake_validated is called or do not normally flow into
        // policy admission; surface them as INTERNAL so the wire shape stays
        // tight without silently swallowing the diagnostic.
        _ => (error_code::INTERNAL, e.to_string()),
    }
}

/// Write a `HelloAck::Refused` frame, swallowing the inner I/O
/// error so the caller's original error remains the primary
/// outcome. Refusals are best-effort: if the client has already
/// dropped the socket we still want the listener to report the
/// underlying reason rather than a generic write error.
async fn write_refusal<S>(socket: &mut S, code: &str, message: &str)
where
    S: AsyncWrite + Unpin,
{
    let frame = HelloAck::Refused(chan_tunnel_proto::HelloAckErr {
        protocol: ProtocolVersion::V1,
        code: code.to_string(),
        message: message.to_string(),
    });
    if let Err(e) = write_frame(socket, &frame).await {
        tracing::debug!(error = %e, code, "failed to write HelloAck::Refused");
    }
}

/// Yamux config with tighter caps than the upstream default. The
/// upstream `Config::default` allows 8192 concurrent substreams per
/// connection; that's a single tunnel's per-process budget, and a
/// public visitor that opens many slow requests can fill it. 256
/// is plenty for normal browser-shaped concurrency (a handful of
/// pipelined requests + a WebSocket or two) and bounds the worst
/// case to a manageable memory footprint.
fn tunnel_yamux_config() -> YamuxConfig {
    let mut cfg = YamuxConfig::default();
    cfg.set_max_num_streams(256);
    cfg
}

mod driver;
mod registry;
mod tunnel;

pub use registry::{OpenError, Registry, RegistryEvent, TunnelHandle, TunnelInfo, WorkspaceInfo};
pub use tunnel::{serve_tunnel_listener, serve_tunnel_listener_with_admission};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fleet_capacity_uses_the_stable_workspace_limit_refusal() {
        let (code, message) = refusal_for(&ServerError::AdmissionAtCapacity {
            user: "alice".into(),
        });
        assert_eq!(code, chan_tunnel_proto::error_code::TOO_MANY_WORKSPACES);
        assert_eq!(message, "user alice reached the fleet-wide devserver limit");
    }

    #[test]
    fn validated_debug_redacts_both_tunnel_authorities() {
        let lease = "lease-sentinel-must-never-appear";
        let validated = Validated {
            user_id: uuid::Uuid::new_v4(),
            username: "alice".into(),
            devserver_id: "devserver".into(),
            scopes: vec!["tunnel:connect".into()],
            gateway_assertion_key: Some(*b"assertion-key-sentinel-32-bytes!"),
            admission_lease: Some(lease.into()),
            admission_lease_expires_at: None,
        };
        let debug = format!("{validated:?}");
        assert!(debug.contains("REDACTED"));
        assert!(!debug.contains(lease));
        assert!(!debug.contains("assertion-key-sentinel"));
    }
}
