//! Token validator backed by identity-service's
//! `/internal/v1/tokens/validate`.
//!
//! The endpoint shape:
//!
//!   POST /internal/v1/tokens/validate
//!   Authorization: Bearer <shared internal bearer>
//!   Content-Type: application/json
//!   { "token": "<chan_pat_*>" }
//!
//!   200 { "user_id": "...", "username": "...", "token_id": "...",
//!         "expires_at": "<iso8601|null>",
//!         "scopes": ["tunnel", ...] }
//!   401 if the token is unknown / revoked / expired
//!
//! Scopes are per-token: identity stores them in `api_tokens.scopes`
//! and emits them in the validate response. devserver-proxy forwards
//! them verbatim into `Validated::scopes`; chan-tunnel-server gates the
//! `tunnel` (base dial) scope against the validated list.

use async_trait::async_trait;
use chan_tunnel_server::{ServerError, Validated, Validator};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::registry::Registry;
use devserver_control_proto::ProxyId;

#[derive(Clone)]
pub struct IdentityValidator {
    client: Client,
    endpoint: Url,
    auth_header: String,
    proxy_id: ProxyId,
}

/// Pass-through wrapper for call sites that take a username-capturing
/// validator. Owner authority comes exclusively from the signed
/// registration stored on `TunnelHandle`, so this wrapper delegates
/// without recording identity state.
pub struct CapturingValidator<V: Validator> {
    inner: V,
    _registry: Registry,
}

impl<V: Validator> CapturingValidator<V> {
    pub fn new(inner: V, registry: Registry) -> Self {
        Self {
            inner,
            _registry: registry,
        }
    }
}

#[async_trait]
impl<V: Validator> Validator for CapturingValidator<V> {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        self.inner.validate(token).await
    }

    async fn validate_registration(
        &self,
        token: &str,
        registration_id: Uuid,
    ) -> Result<Validated, ServerError> {
        self.inner
            .validate_registration(token, registration_id)
            .await
    }

    async fn announce_devserver_name(&self, token: &str, name: &str) {
        self.inner.announce_devserver_name(token, name).await;
    }
}

impl IdentityValidator {
    pub fn new(identity_url: Url, auth_token: String, proxy_id: ProxyId) -> anyhow::Result<Self> {
        let endpoint = identity_url.join("/internal/v1/tokens/validate")?;
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .connect_timeout(std::time::Duration::from_secs(2))
            .build()?;
        Ok(Self {
            client,
            endpoint,
            auth_header: format!("Bearer {auth_token}"),
            proxy_id,
        })
    }
}

#[derive(Serialize)]
struct ValidateRequest<'a> {
    token: &'a str,
    /// Display name announced in the tunnel `Hello`, forwarded on the
    /// post-registration follow-up call only; identity refreshes the
    /// devserver row's label from it. Omitted from the auth-stage
    /// validate so that wire stays byte-identical to pre-name clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_id: Option<&'a ProxyId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registration_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct ValidateResponse {
    user_id: Uuid,
    username: String,
    /// Token-resolved devserver identity (lowercase hex SHA-256 of the
    /// PAT). identity computes and pins it; the tunnel-server keys the
    /// registration on this value, so the registry's second key is the
    /// devserver id.
    devserver_id: String,
    #[serde(default)]
    scopes: Vec<String>,
    admission_lease: String,
    admission_lease_expires_at: chrono::DateTime<chrono::Utc>,
}

#[async_trait]
impl Validator for IdentityValidator {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        self.validate_registration(token, Uuid::new_v4()).await
    }

    async fn validate_registration(
        &self,
        token: &str,
        registration_id: Uuid,
    ) -> Result<Validated, ServerError> {
        let resp = self
            .client
            .post(self.endpoint.clone())
            .header(reqwest::header::AUTHORIZATION, &self.auth_header)
            .json(&ValidateRequest {
                token,
                name: None,
                proxy_id: Some(&self.proxy_id),
                registration_id: Some(registration_id),
            })
            .send()
            .await
            .map_err(|e| ServerError::Identity(format!("request: {e}")))?;

        match resp.status() {
            StatusCode::OK => {
                let body: ValidateResponse = resp
                    .json()
                    .await
                    .map_err(|e| ServerError::Identity(format!("decode: {e}")))?;
                Ok(Validated {
                    user_id: body.user_id,
                    username: body.username,
                    devserver_id: body.devserver_id,
                    scopes: body.scopes,
                    gateway_assertion_key: Some(
                        chan_tunnel_proto::gateway_assertion::derive_assertion_key(token),
                    ),
                    admission_lease: Some(body.admission_lease),
                    admission_lease_expires_at: Some(body.admission_lease_expires_at),
                })
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(ServerError::InvalidToken),
            other => Err(ServerError::Identity(format!("unexpected status {other}"))),
        }
    }

    /// Forward the Hello-announced display name to identity as a
    /// follow-up call on the same validate exchange, now carrying
    /// `name`; identity refreshes the devserver row's label from it.
    /// The follow-up lands moments after the auth-stage validate, and
    /// identity's per-fingerprint throttle seeds a FRESH fingerprint
    /// with a single token (refill 4/s), so the first dial of a new
    /// identity process would 401 the immediate retry -- hence the
    /// spaced attempts. Best-effort: exhausting them only logs; the
    /// tunnel is already registered.
    async fn announce_devserver_name(&self, token: &str, name: &str) {
        const RETRY_DELAYS: [std::time::Duration; 3] = [
            std::time::Duration::ZERO,
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(3),
        ];
        let mut last = String::new();
        for delay in RETRY_DELAYS {
            tokio::time::sleep(delay).await;
            let resp = self
                .client
                .post(self.endpoint.clone())
                .header(reqwest::header::AUTHORIZATION, &self.auth_header)
                .json(&ValidateRequest {
                    token,
                    name: Some(name),
                    proxy_id: None,
                    registration_id: None,
                })
                .send()
                .await;
            // The token was valid moments ago, so any 2xx means identity
            // accepted the exchange (the label refresh is identity-side
            // best-effort from there).
            match resp {
                Ok(resp) if resp.status().is_success() => return,
                Ok(resp) => last = format!("status {}", resp.status()),
                Err(e) => last = format!("request: {e}"),
            }
        }
        tracing::warn!(name, error = %last, "devserver name announce failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Consumer byte-pin: the validate-response field identity produces
    // is `devserver_id`, and the registry keys on it. A one-sided rename of
    // this wire field must fail here, not silently key the registry on an
    // empty string.
    #[test]
    fn validate_response_reads_devserver_id() {
        let json = r#"{
            "user_id": "11111111-1111-4111-8111-111111111111",
            "username": "alice",
            "devserver_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "scopes": ["tunnel"]
            ,"admission_lease": "lease"
            ,"admission_lease_expires_at": "2030-01-01T00:00:00Z"
        }"#;
        let parsed: ValidateResponse = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed.devserver_id,
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );
        assert_eq!(parsed.username, "alice");
        assert_eq!(parsed.admission_lease, "lease");
    }

    #[test]
    fn validate_response_without_devserver_id_is_rejected() {
        // devserver_id is required (not defaulted): a response missing it is
        // a contract break, not a silent empty key.
        let json = r#"{"user_id":"11111111-1111-4111-8111-111111111111","username":"a"}"#;
        assert!(serde_json::from_str::<ValidateResponse>(json).is_err());
    }
}
