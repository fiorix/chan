use std::net::SocketAddr;

use anyhow::Context;
use devserver_control_proto::{AdmissionLeaseVerifier, CanonicalOrigin, ProxyId};
use url::Url;

/// Both-directions idle window after which a bridged WebSocket is cut.
/// Long enough that any heartbeat-carrying socket (the SPA pings every
/// 20s) never trips it; short enough that abandoned bridges do not pin
/// yamux substreams for hours.
pub const DEFAULT_WS_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const MAX_SESSION_LIFETIME_SECS: usize = 60 * 60;

/// Transfer-route body allowance in each direction (100 GiB). The
/// general `MAX_REQUEST_BYTES` / `MAX_RESPONSE_BYTES` caps (default
/// 100 MiB) exist to stop a public visitor from streaming unbounded
/// bytes through the tunnel; the file-transfer surface is the
/// sanctioned bulk path and gets an explicit, much larger allowance
/// instead of inheriting the abuse caps.
pub const TRANSFER_ROUTE_MAX_BYTES: usize = 100 * 1024 * 1024 * 1024;

/// Transfer-route deadline covering headers and streaming body
/// (24 hours). A multi-gigabyte transfer over a slow link legitimately
/// outlives the general 60-second request timeout.
pub const TRANSFER_ROUTE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// Runtime config sourced from environment variables.
#[derive(Clone)]
pub struct Config {
    /// Public listener (node apex + node wildcard, e.g.
    /// `p1.usr.chan.app` + `*.p1.usr.chan.app`). Behind nginx + TLS.
    pub bind_addr: SocketAddr,
    /// Tunnel listener (apex `/v1/tunnel`). h2c behind nginx
    /// `grpc_pass`; `chan devserver` instances dial the tunnel ingress
    /// (e.g. `https://usr.chan.app/v1/tunnel`) over h2/TLS, terminated
    /// at nginx and forwarded here cleartext.
    pub tunnel_bind_addr: SocketAddr,
    /// Apex hostname (e.g. `p1.usr.chan.app`). Used to distinguish
    /// the health/readiness surface from the wildcard reverse-proxy
    /// surface in the Host-keyed router.
    pub apex_host: String,
    /// Wildcard suffix including the leading dot (e.g.
    /// `.p1.usr.chan.app`). The proxy router parses `{user}` out of
    /// every Host that ends with this suffix.
    pub wildcard_suffix: String,
    /// Base URL of identity-service. devserver-proxy POSTs to
    /// `{identity_url}/internal/v1/tokens/validate` to validate the
    /// PAT every `chan devserver` presents in its tunnel handshake.
    pub identity_url: Url,
    /// Bearer devserver-proxy presents on identity-service's
    /// `/internal/v1/tokens/validate`. Sourced from
    /// `IDENTITY_INTERNAL_TOKEN`; required, no fallback.
    pub identity_auth_token: String,
    /// Absolute URL the wildcard root (`{user}--{disc}.p1.usr.chan.app/`)
    /// 302s to: the gateway dashboard on the identity origin
    /// (e.g. `https://gw.chan.app/workspaces`; dev sets
    /// `http://id.localtest.me:17000/workspaces`). Required
    /// (`DASHBOARD_URL`), no derived default.
    pub dashboard_url: String,
    /// Exact public identity origin allowed to POST an entry credential.
    pub identity_origin: CanonicalOrigin,
    /// One or two identity Ed25519 public keys accepted for entry exchange.
    /// A second key is rotation overlap only and should be removed after the
    /// 30-second entry lifetime plus clock skew.
    pub entry_verifiers: gateway_common::devserver_gate::EntryVerifierRing,
    /// Public-key ring used to retain the verified signed per-user cap in
    /// tunnel snapshot rows. No signing authority is present on a proxy.
    pub admission_lease_verifier: AdmissionLeaseVerifier,
    /// h2c origin of the singleton fleet controller proxy listener.
    pub control_url: Url,
    /// Bearer presented only to the controller proxy listener.
    pub proxy_token: String,
    /// Stable provisioned node id used for controller ownership.
    pub proxy_id: ProxyId,
    /// Exact public origin for this node's wildcard listener.
    pub proxy_base_url: CanonicalOrigin,
    /// Cap on response bytes streamed back from an upstream `chan
    /// devserver` per request. `None` (env unset or `0`) disables the
    /// cap.
    pub max_response_bytes: Option<usize>,
    /// Cap on inbound request body bytes forwarded to the upstream.
    /// `None` disables.
    pub max_request_bytes: Option<usize>,
    /// Hard cap on total time a single proxied HTTP request may
    /// consume. `None` disables; default 60s. WebSocket bridges use
    /// the shared `ws_idle_timeout` window instead.
    pub request_timeout: Option<std::time::Duration>,
    /// Idle window for bridged WebSockets. The bridge is cut (with a
    /// proper Close frame to both halves) only after BOTH directions
    /// have been quiet this long; a frame either way resets the
    /// window, so a socket streaming one way never dies mid-stream.
    /// Always [`DEFAULT_WS_IDLE_TIMEOUT`] in production (not
    /// env-sourced); tests inject sub-second values via the struct.
    pub ws_idle_timeout: std::time::Duration,
    /// Maximum number of proxy-local opaque browser sessions.
    pub session_max_active: usize,
    /// Absolute opaque-session lifetime. Activity cannot extend it.
    pub session_lifetime: std::time::Duration,
    /// Maximum number of unexpired, consumed entry credential ids retained
    /// for replay rejection.
    pub entry_replay_max_active: usize,
    /// Value to set on the outbound `X-Forwarded-Proto` header before
    /// forwarding to the upstream `chan devserver`. devserver-proxy itself
    /// does not see TLS (nginx terminates), so we cannot derive this
    /// from the inbound connection; the inbound `X-Forwarded-Proto`
    /// is client-controlled and must not be trusted. Defaults to
    /// `https`; override with `FORWARDED_PROTO=http` for local dev.
    pub forwarded_proto: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr: SocketAddr = std::env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7002".to_string())
            .parse()
            .context("BIND_ADDR must be host:port")?;
        gateway_common::internal_transport::require_protected_listener("BIND_ADDR", bind_addr)?;

        let tunnel_bind_addr: SocketAddr = std::env::var("TUNNEL_BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7100".to_string())
            .parse()
            .context("TUNNEL_BIND_ADDR must be host:port")?;
        gateway_common::internal_transport::require_protected_listener(
            "TUNNEL_BIND_ADDR",
            tunnel_bind_addr,
        )?;

        let tunnel_origin = required_origin("DEVSERVER_TUNNEL_ORIGIN")?;
        require_secure_public_url("DEVSERVER_TUNNEL_ORIGIN", &tunnel_origin, bind_addr)?;
        let proxy_base_url_raw = std::env::var("DEVSERVER_PROXY_BASE_URL")
            .context("DEVSERVER_PROXY_BASE_URL is required")?;
        let proxy_base_url = CanonicalOrigin::parse(proxy_base_url_raw.trim())
            .context("DEVSERVER_PROXY_BASE_URL must be a canonical http(s) origin")?;
        let proxy_base_url_parsed: Url = proxy_base_url
            .as_str()
            .parse()
            .context("DEVSERVER_PROXY_BASE_URL must be a URL origin")?;
        require_secure_public_url(
            "DEVSERVER_PROXY_BASE_URL",
            &proxy_base_url_parsed,
            bind_addr,
        )?;
        let apex_host = tunnel_origin
            .host_str()
            .context("DEVSERVER_TUNNEL_ORIGIN must contain a host")?
            .to_string();
        let wildcard_suffix = format!(
            ".{}",
            proxy_base_url_parsed
                .host_str()
                .context("DEVSERVER_PROXY_BASE_URL must contain a host")?
        );

        let identity_url: Url = std::env::var("IDENTITY_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:7000".to_string())
            .parse()
            .context("IDENTITY_URL must be a URL")?;
        gateway_common::internal_transport::require_protected_http_url(
            "IDENTITY_URL",
            &identity_url,
        )?;

        // Bearer devserver-proxy presents on identity-service's
        // /internal/v1/tokens/validate. Required; the same value is
        // configured on identity as IDENTITY_INTERNAL_TOKEN. No
        // fallback to PROFILE_AUTH_TOKEN: rotating the profile bearer
        // must never silently rotate this one (matches identity's
        // side, which also requires IDENTITY_INTERNAL_TOKEN outright).
        let identity_auth_token = std::env::var("IDENTITY_INTERNAL_TOKEN")
            .context("IDENTITY_INTERNAL_TOKEN is required")?;
        if identity_auth_token.is_empty() {
            anyhow::bail!("IDENTITY_INTERNAL_TOKEN must not be empty");
        }
        validate_bearer_secret("IDENTITY_INTERNAL_TOKEN", &identity_auth_token)?;

        let entry_verifying_keys = std::env::var("DEVSERVER_ENTRY_VERIFYING_KEYS")
            .context("DEVSERVER_ENTRY_VERIFYING_KEYS is required")?;
        let entry_verifiers = gateway_common::devserver_gate::EntryVerifierRing::from_base64_list(
            entry_verifying_keys.trim(),
        )
        .context(
            "DEVSERVER_ENTRY_VERIFYING_KEYS must contain one or two canonical Ed25519 public keys",
        )?;
        let admission_verifying_keys = std::env::var("DEVSERVER_ADMISSION_VERIFYING_KEYS")
            .context("DEVSERVER_ADMISSION_VERIFYING_KEYS is required")?;
        let admission_lease_verifier =
            AdmissionLeaseVerifier::from_base64_rotation(admission_verifying_keys.trim()).context(
                "DEVSERVER_ADMISSION_VERIFYING_KEYS must contain one or two canonical Ed25519 public keys",
            )?;

        let dashboard_url = std::env::var("DASHBOARD_URL")
            .context("DASHBOARD_URL is required")?
            .trim()
            .to_string();
        if dashboard_url.is_empty() {
            anyhow::bail!("DASHBOARD_URL must not be empty");
        }
        let dashboard_parsed: Url = dashboard_url
            .parse()
            .context("DASHBOARD_URL must be an http(s) URL")?;
        require_secure_public_url("DASHBOARD_URL", &dashboard_parsed, bind_addr)?;
        let identity_origin_raw = std::env::var("IDENTITY_PUBLIC_ORIGIN")
            .context("IDENTITY_PUBLIC_ORIGIN is required")?;
        let identity_origin = CanonicalOrigin::parse(identity_origin_raw.trim())
            .context("IDENTITY_PUBLIC_ORIGIN must be a canonical http(s) origin")?;
        let identity_origin_url: Url = identity_origin.as_str().parse().unwrap();
        require_secure_public_url("IDENTITY_PUBLIC_ORIGIN", &identity_origin_url, bind_addr)?;

        let control_url = required_origin("DEVSERVER_CONTROL_URL")?;
        if control_url.scheme() != "http" {
            anyhow::bail!("DEVSERVER_CONTROL_URL must use http for the h2c proxy listener");
        }
        gateway_common::internal_transport::require_protected_http_url(
            "DEVSERVER_CONTROL_URL",
            &control_url,
        )?;
        let proxy_token = required_secret("DEVSERVER_PROXY_TOKEN")?;
        validate_bearer_secret("DEVSERVER_PROXY_TOKEN", &proxy_token)?;
        let proxy_id_raw =
            std::env::var("DEVSERVER_PROXY_ID").context("DEVSERVER_PROXY_ID is required")?;
        let proxy_id = ProxyId::parse(proxy_id_raw.trim())
            .context("DEVSERVER_PROXY_ID must be one lowercase DNS label")?;

        let max_response_bytes = parse_byte_cap("MAX_RESPONSE_BYTES", Some(100 * 1024 * 1024))?;
        let max_request_bytes = parse_byte_cap("MAX_REQUEST_BYTES", Some(100 * 1024 * 1024))?;
        let forwarded_proto = std::env::var("FORWARDED_PROTO")
            .unwrap_or_else(|_| "https".to_string())
            .trim()
            .to_string();
        if forwarded_proto != "http" && forwarded_proto != "https" {
            anyhow::bail!(
                "FORWARDED_PROTO must be \"http\" or \"https\" (got {forwarded_proto:?})"
            );
        }
        if forwarded_proto != "https" && !bind_addr.ip().is_loopback() {
            anyhow::bail!("FORWARDED_PROTO must be https on a non-loopback public listener");
        }

        let request_timeout = match std::env::var("REQUEST_TIMEOUT_SECS") {
            Ok(v) => {
                let n: u64 = v
                    .trim()
                    .parse()
                    .context("REQUEST_TIMEOUT_SECS must be a non-negative integer")?;
                if n == 0 {
                    None
                } else {
                    Some(std::time::Duration::from_secs(n))
                }
            }
            Err(_) => Some(std::time::Duration::from_secs(60)),
        };
        let session_max_active = parse_nonzero_usize("SESSION_MAX_ACTIVE", 10_000)?;
        if session_max_active > devserver_control_proto::MAX_BROWSER_SESSION_SNAPSHOT_ROWS {
            anyhow::bail!(
                "SESSION_MAX_ACTIVE must be at most {}",
                devserver_control_proto::MAX_BROWSER_SESSION_SNAPSHOT_ROWS
            );
        }
        let session_lifetime_secs = validate_session_lifetime_secs(parse_nonzero_usize(
            "SESSION_LIFETIME_SECS",
            MAX_SESSION_LIFETIME_SECS,
        )?)?;
        let entry_replay_max_active = parse_nonzero_usize("ENTRY_REPLAY_MAX_ACTIVE", 10_000)?;

        Ok(Self {
            bind_addr,
            tunnel_bind_addr,
            apex_host,
            wildcard_suffix,
            identity_url,
            identity_auth_token,
            dashboard_url,
            identity_origin,
            entry_verifiers,
            admission_lease_verifier,
            control_url,
            proxy_token,
            proxy_id,
            proxy_base_url,
            max_response_bytes,
            max_request_bytes,
            request_timeout,
            ws_idle_timeout: DEFAULT_WS_IDLE_TIMEOUT,
            session_max_active,
            session_lifetime: std::time::Duration::from_secs(session_lifetime_secs as u64),
            entry_replay_max_active,
            forwarded_proto,
        })
    }

    /// Parse `(user, disc)` out of a Host header, or `None` if the
    /// Host is the apex (no user prefix) or doesn't match this
    /// gateway's hostnames. The strip trims any optional `:port`
    /// suffix so dev lookups against `127.0.0.1:7002` still work.
    ///
    /// Two wildcard forms share one DNS label:
    ///
    ///   * `{user}.<base>` -> `(user, None)`. Bare host; the proxy
    ///     resolves the devserver from the user's live set.
    ///   * `{user}--{disc}.<base>` -> `(user, Some(disc))`.
    ///     `disc` is the first 12 hex chars of the devserver id. The
    ///     double hyphen is unambiguous because `valid_username`
    ///     rejects usernames containing `--`.
    ///
    /// The label is lowercased on ingest (DNS names are case-
    /// insensitive; devserver ids are stored lowercase). A label with
    /// more than one `--`, a disc tail that is not exactly 12
    /// lowercase hex chars, a multi-label prefix (e.g. `evil.alice`
    /// against `*.p1.usr.chan.app`), and non-label characters are
    /// all rejected so the resulting username matches the shape the
    /// downstream validators accept.
    pub fn parse_wildcard_host(&self, host: &str) -> Option<(String, Option<String>)> {
        let host = host.split(':').next()?;
        if host.eq_ignore_ascii_case(&self.apex_host) {
            return None;
        }
        let suffix = self.wildcard_suffix.as_str();
        if host.len() <= suffix.len() {
            return None;
        }
        let (prefix, tail) = host.split_at(host.len() - suffix.len());
        if !tail.eq_ignore_ascii_case(suffix) {
            return None;
        }
        if prefix.is_empty() {
            return None;
        }
        if !prefix
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return None;
        }
        let label = prefix.to_ascii_lowercase();
        match label.match_indices("--").count() {
            0 => Some((label, None)),
            1 => {
                let (user, disc) = label.split_once("--").expect("counted one occurrence");
                if user.is_empty() {
                    return None;
                }
                let is_lower_hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
                if disc.len() != 12 || !disc.bytes().all(is_lower_hex) {
                    return None;
                }
                Some((user.to_string(), Some(disc.to_string())))
            }
            _ => None,
        }
    }

    /// True when the Host header names this gateway's apex.
    pub fn is_apex(&self, host: &str) -> bool {
        host.split(':')
            .next()
            .map(|h| h.eq_ignore_ascii_case(&self.apex_host))
            .unwrap_or(false)
    }
}

fn parse_nonzero_usize(name: &str, default: usize) -> anyhow::Result<usize> {
    let value = std::env::var(name).unwrap_or_else(|_| default.to_string());
    let value: usize = value
        .trim()
        .parse()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        anyhow::bail!("{name} must be greater than zero");
    }
    Ok(value)
}

fn require_secure_public_url(
    name: &str,
    url: &Url,
    public_bind_addr: SocketAddr,
) -> anyhow::Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        anyhow::bail!("{name} must use http or https");
    }
    if url.scheme() == "https" {
        return Ok(());
    }
    let host = url.host_str().context("public URL must have a host")?;
    let loopback_host = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if public_bind_addr.ip().is_loopback() && loopback_host {
        return Ok(());
    }
    anyhow::bail!("{name} must use https unless both its host and the public listener are loopback")
}

fn required_origin(name: &str) -> anyhow::Result<Url> {
    let raw = std::env::var(name).with_context(|| format!("{name} is required"))?;
    let url: Url = raw
        .trim()
        .parse()
        .with_context(|| format!("{name} must be a URL origin"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        anyhow::bail!(
            "{name} must be an http(s) origin with no credentials, path, query, or fragment"
        );
    }
    Ok(url)
}

fn required_secret(name: &str) -> anyhow::Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.is_empty() {
        anyhow::bail!("{name} must not be empty");
    }
    Ok(value)
}

fn validate_bearer_secret(name: &str, value: &str) -> anyhow::Result<()> {
    if !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        anyhow::bail!("{name} must contain only visible ASCII bytes");
    }
    Ok(())
}

fn parse_byte_cap(name: &str, default: Option<usize>) -> anyhow::Result<Option<usize>> {
    match std::env::var(name) {
        Ok(v) => {
            let n: usize = v
                .trim()
                .parse()
                .with_context(|| format!("{name} must be a non-negative integer"))?;
            Ok((n != 0).then_some(n))
        }
        Err(_) => Ok(default),
    }
}

fn validate_session_lifetime_secs(value: usize) -> anyhow::Result<usize> {
    if value > MAX_SESSION_LIFETIME_SECS {
        anyhow::bail!("SESSION_LIFETIME_SECS must be at most {MAX_SESSION_LIFETIME_SECS}");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            bind_addr: "127.0.0.1:7002".parse().unwrap(),
            tunnel_bind_addr: "127.0.0.1:7100".parse().unwrap(),
            apex_host: "p1.usr.chan.app".into(),
            wildcard_suffix: ".p1.usr.chan.app".into(),
            identity_url: "http://127.0.0.1:7000/".parse().unwrap(),
            identity_auth_token: "x".into(),
            dashboard_url: "https://gw.chan.app/workspaces".into(),
            identity_origin: CanonicalOrigin::parse("https://gw.chan.app").unwrap(),
            entry_verifiers: {
                let signer = gateway_common::devserver_gate::EntrySigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                gateway_common::devserver_gate::EntryVerifierRing::from_base64_list(
                    &signer.verifying_key_base64(),
                )
                .unwrap()
            },
            admission_lease_verifier: {
                let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap()
            },
            control_url: "http://127.0.0.1:7101/".parse().unwrap(),
            proxy_token: "x".into(),
            proxy_id: ProxyId::parse("p1").unwrap(),
            proxy_base_url: CanonicalOrigin::parse("https://p1.usr.chan.app").unwrap(),
            max_response_bytes: None,
            max_request_bytes: None,
            request_timeout: None,
            ws_idle_timeout: DEFAULT_WS_IDLE_TIMEOUT,
            session_max_active: 10_000,
            session_lifetime: std::time::Duration::from_secs(3600),
            entry_replay_max_active: 10_000,
            forwarded_proto: "https".into(),
        }
    }

    #[test]
    fn apex_returns_none() {
        let c = cfg();
        assert_eq!(c.parse_wildcard_host("p1.usr.chan.app"), None);
        assert_eq!(c.parse_wildcard_host("P1.USR.chan.app"), None);
        assert_eq!(c.parse_wildcard_host("p1.usr.chan.app:7002"), None);
    }

    #[test]
    fn public_cleartext_requires_a_loopback_origin_and_listener() {
        let loopback: SocketAddr = "127.0.0.1:7002".parse().unwrap();
        let public: SocketAddr = "0.0.0.0:7002".parse().unwrap();
        assert!(require_secure_public_url(
            "TEST_URL",
            &Url::parse("http://localhost:7002").unwrap(),
            loopback,
        )
        .is_ok());
        assert!(require_secure_public_url(
            "TEST_URL",
            &Url::parse("http://localhost:7002").unwrap(),
            public,
        )
        .is_err());
        assert!(require_secure_public_url(
            "TEST_URL",
            &Url::parse("http://127.example.com:7002").unwrap(),
            loopback,
        )
        .is_err());
        assert!(require_secure_public_url(
            "TEST_URL",
            &Url::parse("https://proxy.example.test").unwrap(),
            public,
        )
        .is_ok());
    }

    #[test]
    fn bearer_secrets_reject_ascii_whitespace() {
        assert!(validate_bearer_secret("TEST", "opaque-token").is_ok());
        assert!(validate_bearer_secret("TEST", "opaque token").is_err());
        assert!(validate_bearer_secret("TEST", "opaque\ttoken").is_err());
        assert!(validate_bearer_secret("TEST", "opaque\ntoken").is_err());
        assert!(validate_bearer_secret("TEST", "opaque💥token").is_err());
    }

    #[test]
    fn opaque_session_lifetime_cannot_exceed_the_one_hour_revocation_backstop() {
        assert_eq!(
            validate_session_lifetime_secs(MAX_SESSION_LIFETIME_SECS).unwrap(),
            MAX_SESSION_LIFETIME_SECS
        );
        assert!(validate_session_lifetime_secs(MAX_SESSION_LIFETIME_SECS + 1).is_err());
    }

    #[test]
    fn bare_wildcard_extracts_user_without_disc() {
        let c = cfg();
        assert_eq!(
            c.parse_wildcard_host("alice.p1.usr.chan.app"),
            Some(("alice".into(), None)),
        );
        assert_eq!(
            c.parse_wildcard_host("Alice.P1.Usr.Chan.App"),
            Some(("alice".into(), None)),
        );
        assert_eq!(
            c.parse_wildcard_host("alice.p1.usr.chan.app:7002"),
            Some(("alice".into(), None)),
        );
        // Single interior hyphens stay part of the username.
        assert_eq!(
            c.parse_wildcard_host("a-b-c.p1.usr.chan.app"),
            Some(("a-b-c".into(), None)),
        );
    }

    #[test]
    fn disc_wildcard_extracts_user_and_disc() {
        let c = cfg();
        assert_eq!(
            c.parse_wildcard_host("alice--0123456789ab.p1.usr.chan.app"),
            Some(("alice".into(), Some("0123456789ab".into()))),
        );
        // The whole label is lowercased on ingest, disc included.
        assert_eq!(
            c.parse_wildcard_host("Alice--0123456789AB.p1.usr.chan.app"),
            Some(("alice".into(), Some("0123456789ab".into()))),
        );
        assert_eq!(
            c.parse_wildcard_host("a-b--abcdefabcdef.p1.usr.chan.app:7002"),
            Some(("a-b".into(), Some("abcdefabcdef".into()))),
        );
    }

    #[test]
    fn malformed_disc_rejected() {
        let c = cfg();
        // Tail must be exactly 12 hex chars.
        assert_eq!(
            c.parse_wildcard_host("alice--0123456789a.p1.usr.chan.app"),
            None
        );
        assert_eq!(
            c.parse_wildcard_host("alice--0123456789abc.p1.usr.chan.app"),
            None
        );
        assert_eq!(
            c.parse_wildcard_host("alice--0123456789xy.p1.usr.chan.app"),
            None
        );
        // More than one `--` cannot come from a valid username.
        assert_eq!(
            c.parse_wildcard_host("a--b--0123456789ab.p1.usr.chan.app"),
            None
        );
        assert_eq!(
            c.parse_wildcard_host("a----0123456789ab.p1.usr.chan.app"),
            None
        );
        // A triple hyphen leaves a `-` in the disc tail.
        assert_eq!(
            c.parse_wildcard_host("a---0123456789ab.p1.usr.chan.app"),
            None
        );
        // Empty user before the separator.
        assert_eq!(
            c.parse_wildcard_host("--0123456789ab.p1.usr.chan.app"),
            None
        );
    }

    #[test]
    fn unknown_host_returns_none() {
        let c = cfg();
        assert_eq!(c.parse_wildcard_host("example.com"), None);
        assert_eq!(c.parse_wildcard_host(""), None);
        assert_eq!(c.parse_wildcard_host(".p1.usr.chan.app"), None);
    }

    #[test]
    fn multi_label_prefix_rejected() {
        // `evil.alice.p1.usr.chan.app` matches the wildcard suffix
        // but must NOT resolve to username "evil.alice": the prefix
        // is required to be a single DNS label.
        let c = cfg();
        assert_eq!(c.parse_wildcard_host("evil.alice.p1.usr.chan.app"), None);
        // Leading dot was already excluded by the substring length
        // check + emptiness guard, but tighten the boundary explicitly.
        assert_eq!(c.parse_wildcard_host("..p1.usr.chan.app"), None);
        // Underscores aren't legal DNS hostname chars and are not in
        // the username alphabet either.
        assert_eq!(c.parse_wildcard_host("a_b.p1.usr.chan.app"), None);
    }
}
