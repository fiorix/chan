use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use devserver_control_proto::{AdmissionLeaseSigner, AdmissionLeaseVerifier};
use url::Url;

use crate::devserver_control_client::DevserverControlClient;
use crate::profile_client::ProfileClient;
use crate::providers::{
    github::GitHubProvider, gitlab::GitLabProvider, google::GoogleProvider, Provider,
};

/// Runtime config sourced from environment variables.
#[derive(Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub internal_bind_addr: SocketAddr,
    pub base_url: Url,
    /// Canonical proxy namespace origin (`DEVSERVER_PROXY_ORIGIN`),
    /// e.g. `https://usr.chan.app`. Every controller-reported node
    /// base must sit exactly one DNS label below this apex with the
    /// same scheme and effective port before identity mints tenant
    /// origins from it.
    pub devserver_proxy_origin: Url,
    pub devserver_tunnel_origin: Url,
    pub database_url: String,
    pub cookie_secure: bool,
    pub profile_client: ProfileClient,
    /// Bearer devserver-proxy presents on /internal/v1/tokens/validate.
    /// Required and distinct from PROFILE_AUTH_TOKEN; rotating one
    /// does not rotate the other.
    pub internal_auth_token: String,
    /// Bearer gating only /internal/v1/sessions/whoami. Empty disables
    /// the route with the same not-found posture as a disabled admin scope.
    pub session_internal_auth_token: String,
    /// Bearer gating the operator surface under /admin/v1/*. Empty
    /// (the default) disables the surface outright: the routes answer
    /// 404 as if they did not exist. chan-gateway-admin presents this
    /// via CHAN_ADMIN_IDENTITY_TOKEN.
    pub identity_admin_token: String,
    /// Bearer accepted only by account access-revoke, profile-delete, and
    /// per-user devserver-policy routes. Empty disables this caller scope.
    pub account_admin_token: String,
    /// Scope-specific controller client. Runtime startup fails closed when the
    /// URL or identity-scoped bearer is absent.
    pub workspace_admin: DevserverControlClient,
    /// Public-key verifier for controller tunnel rows. Identity verifies every
    /// row before it can authorize an entry or appear in the Desktop roster.
    pub admission_lease_verifier: AdmissionLeaseVerifier,
    /// Identity-only Ed25519 signer for short-lived entry credentials. Proxies
    /// receive only the matching public verifier (with at most one old key
    /// during rotation overlap).
    pub entry_signer: gateway_common::devserver_gate::EntrySigner,
    pub providers: Vec<Arc<dyn Provider>>,
}

impl Config {
    pub fn admission_lease_signer_from_env() -> anyhow::Result<AdmissionLeaseSigner> {
        let key = std::env::var("DEVSERVER_ADMISSION_SIGNING_KEY")
            .context("DEVSERVER_ADMISSION_SIGNING_KEY is required")?;
        AdmissionLeaseSigner::from_base64(key.trim())
            .context("DEVSERVER_ADMISSION_SIGNING_KEY must be canonical base64url for 32 bytes")
    }

    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr: SocketAddr = std::env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7000".to_string())
            .parse()
            .context("BIND_ADDR must be host:port")?;
        gateway_common::internal_transport::require_protected_listener("BIND_ADDR", bind_addr)?;
        let internal_bind_addr: SocketAddr = std::env::var("INTERNAL_BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7001".to_string())
            .parse()
            .context("INTERNAL_BIND_ADDR must be host:port")?;
        gateway_common::internal_transport::require_protected_listener(
            "INTERNAL_BIND_ADDR",
            internal_bind_addr,
        )?;

        let base_url = required_origin("BASE_URL")?;
        let devserver_proxy_origin = required_origin("DEVSERVER_PROXY_ORIGIN")?;
        let devserver_tunnel_origin = required_origin("DEVSERVER_TUNNEL_ORIGIN")?;

        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;

        let cookie_secure = parse_bool_env("COOKIE_SECURE", false)?;

        let profile_url: Url = std::env::var("PROFILE_SERVICE_URL")
            .context("PROFILE_SERVICE_URL is required")?
            .parse()
            .context("PROFILE_SERVICE_URL must be a URL")?;
        gateway_common::internal_transport::require_protected_http_url(
            "PROFILE_SERVICE_URL",
            &profile_url,
        )?;
        let profile_token =
            std::env::var("PROFILE_AUTH_TOKEN").context("PROFILE_AUTH_TOKEN is required")?;
        let profile_admin_token =
            std::env::var("PROFILE_ADMIN_TOKEN").context("PROFILE_ADMIN_TOKEN is required")?;
        let profile_client = ProfileClient::new(profile_url, profile_token)?
            .with_admin_token(profile_admin_token)?;

        // Required, no fallback. devserver-proxy holds the matching
        // value via the same env var. Rotating PROFILE_AUTH_TOKEN
        // must never accidentally rotate the internal validate bearer.
        let internal_auth_token = std::env::var("IDENTITY_INTERNAL_TOKEN")
            .context("IDENTITY_INTERNAL_TOKEN is required")?;
        if internal_auth_token.is_empty() {
            anyhow::bail!("IDENTITY_INTERNAL_TOKEN must not be empty");
        }

        let session_internal_auth_token =
            std::env::var("IDENTITY_SESSION_INTERNAL_TOKEN").unwrap_or_default();

        // Optional on purpose: most deployments never mint PATs from
        // the CLI, and an unset/empty token keeps the admin surface
        // disabled rather than guarded by an empty string.
        let identity_admin_token = std::env::var("IDENTITY_ADMIN_TOKEN").unwrap_or_default();
        let account_admin_token = std::env::var("IDENTITY_ACCOUNT_ADMIN_TOKEN").unwrap_or_default();
        validate_distinct_auth_tokens(&[
            ("IDENTITY_INTERNAL_TOKEN", &internal_auth_token),
            (
                "IDENTITY_SESSION_INTERNAL_TOKEN",
                &session_internal_auth_token,
            ),
            ("IDENTITY_ADMIN_TOKEN", &identity_admin_token),
            ("IDENTITY_ACCOUNT_ADMIN_TOKEN", &account_admin_token),
        ])?;

        let admin_url: Url = std::env::var("DEVSERVER_ADMIN_URL")
            .context("DEVSERVER_ADMIN_URL is required")?
            .parse()
            .context("DEVSERVER_ADMIN_URL must be a URL")?;
        gateway_common::internal_transport::require_protected_http_url(
            "DEVSERVER_ADMIN_URL",
            &admin_url,
        )?;
        let devserver_identity_admin_token = std::env::var("DEVSERVER_IDENTITY_ADMIN_TOKEN")
            .context("DEVSERVER_IDENTITY_ADMIN_TOKEN is required")?;
        if devserver_identity_admin_token.is_empty() {
            anyhow::bail!("DEVSERVER_IDENTITY_ADMIN_TOKEN must not be empty");
        }
        let workspace_admin =
            DevserverControlClient::new(admin_url, devserver_identity_admin_token)?;

        let verifying_keys = std::env::var("DEVSERVER_ADMISSION_VERIFYING_KEYS")
            .context("DEVSERVER_ADMISSION_VERIFYING_KEYS is required")?;
        let admission_lease_verifier =
            AdmissionLeaseVerifier::from_base64_rotation(verifying_keys.trim()).context(
                "DEVSERVER_ADMISSION_VERIFYING_KEYS must contain one or two distinct canonical Ed25519 public keys",
            )?;

        let entry_signing_key = std::env::var("DEVSERVER_ENTRY_SIGNING_KEY")
            .context("DEVSERVER_ENTRY_SIGNING_KEY is required")?;
        let entry_signer =
            gateway_common::devserver_gate::EntrySigner::from_base64(entry_signing_key.trim())
                .context("DEVSERVER_ENTRY_SIGNING_KEY must be canonical base64url for 32 bytes")?;

        // IDENTITY_OAUTH_ENDPOINTS_BASE points the GitHub provider's
        // OAuth + API endpoints at an alternate origin so a local
        // test harness can stub the sign-in flow end to end
        // (scripts/e2e/gateway-zone.sh). Absent = the stock
        // github.com / api.github.com endpoints; nothing but the
        // endpoint URLs changes. Never set this in production.
        let oauth_endpoints_base = std::env::var("IDENTITY_OAUTH_ENDPOINTS_BASE")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());

        let mut providers: Vec<Arc<dyn Provider>> = Vec::new();
        if let (Ok(id), Ok(secret)) = (
            std::env::var("GITHUB_CLIENT_ID"),
            std::env::var("GITHUB_CLIENT_SECRET"),
        ) {
            let github = match &oauth_endpoints_base {
                Some(base) => GitHubProvider::with_endpoints(
                    id,
                    secret,
                    crate::providers::github::GitHubEndpoints {
                        auth: format!("{base}/login/oauth/authorize"),
                        token: format!("{base}/login/oauth/access_token"),
                        user: format!("{base}/user"),
                        emails: format!("{base}/user/emails"),
                    },
                )?,
                None => GitHubProvider::new(id, secret)?,
            };
            providers.push(Arc::new(github));
        }
        if let (Ok(id), Ok(secret)) = (
            std::env::var("GOOGLE_CLIENT_ID"),
            std::env::var("GOOGLE_CLIENT_SECRET"),
        ) {
            providers.push(Arc::new(GoogleProvider::new(id, secret)?));
        }
        if let (Ok(id), Ok(secret)) = (
            std::env::var("GITLAB_CLIENT_ID"),
            std::env::var("GITLAB_CLIENT_SECRET"),
        ) {
            providers.push(Arc::new(GitLabProvider::new(id, secret)?));
        }
        if providers.is_empty() {
            anyhow::bail!(
                "no providers configured (set at least one of GITHUB / GOOGLE / GITLAB CLIENT_ID + CLIENT_SECRET)"
            );
        }

        Ok(Self {
            bind_addr,
            internal_bind_addr,
            base_url,
            devserver_proxy_origin,
            devserver_tunnel_origin,
            database_url,
            cookie_secure,
            profile_client,
            internal_auth_token,
            session_internal_auth_token,
            identity_admin_token,
            account_admin_token,
            workspace_admin,
            admission_lease_verifier,
            entry_signer,
            providers,
        })
    }

    pub fn provider(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.providers.iter().find(|p| p.name() == name).cloned()
    }

    /// Redirect URI registered with each provider's OAuth app.
    /// Same path for every provider keeps app registration uniform.
    pub fn redirect_uri(&self, provider: &str) -> Url {
        let mut u = self.base_url.clone();
        u.set_path(&format!("/auth/{provider}/callback"));
        u
    }

    /// Build the tenant origin for one live devserver from its
    /// controller-reported node base: `{owner}--{disc}.` prefixed to
    /// the node base host with scheme and explicit port preserved,
    /// e.g. `https://alice--0123456789ab.p1.usr.chan.app` out of
    /// `https://p1.usr.chan.app`. `disc` is the first 12 chars of the
    /// devserver id; owner and disc are lowercased explicitly because
    /// devserver-proxy lowercases the label on ingest and the minted
    /// host must equal the canonical `aud` the proxy verifies. Ids
    /// shorter than 12 chars (test fixtures) are used whole;
    /// production ids are 64 hex chars.
    ///
    /// The node base must validate against the configured proxy
    /// namespace; anything else is an [`InvalidNodeBase`], never a
    /// fallback to the shared apex.
    pub fn tenant_origin_for(
        &self,
        username: &str,
        devserver_id: &str,
        proxy_id: &str,
        proxy_base_url: &str,
    ) -> std::result::Result<TenantOrigin, InvalidNodeBase> {
        let node = self.validate_node_base(proxy_base_url, proxy_id)?;
        let disc: String = devserver_id.chars().take(12).collect();
        let host = format!(
            "{}--{}.{}",
            username.to_ascii_lowercase(),
            disc.to_ascii_lowercase(),
            node.host_str().expect("validate_node_base requires a host"),
        );
        let port = node.port().map(|p| format!(":{p}")).unwrap_or_default();
        Ok(TenantOrigin {
            origin: format!("{}://{host}{port}", node.scheme()),
            authority: format!("{host}{port}"),
        })
    }

    /// Validate a controller-reported node base against the configured
    /// proxy namespace (`DEVSERVER_PROXY_ORIGIN`): a canonical origin
    /// (scheme + host + optional port; no credentials, path, query, or
    /// fragment) whose host is exactly one DNS label below the apex
    /// with the same scheme and effective port. This is the structural
    /// rule the desktop applies to entry origins, one label up. The
    /// controller already checked the base against its template;
    /// identity re-checks because a fleet row it cannot place inside
    /// the configured namespace must fail closed, never mint.
    fn validate_node_base(
        &self,
        raw: &str,
        expected_proxy_id: &str,
    ) -> std::result::Result<Url, InvalidNodeBase> {
        let url: Url = raw
            .trim()
            .parse()
            .map_err(|_| InvalidNodeBase::new(raw, "not a URL"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(InvalidNodeBase::new(
                raw,
                "not a canonical origin (credentials, path, query, or fragment present)",
            ));
        }
        let apex = &self.devserver_proxy_origin;
        if url.scheme() != apex.scheme()
            || url.port_or_known_default() != apex.port_or_known_default()
        {
            return Err(InvalidNodeBase::new(
                raw,
                "scheme or effective port differs from the proxy apex",
            ));
        }
        let apex_host = apex
            .host_str()
            .expect("DEVSERVER_PROXY_ORIGIN requires a host");
        let node_host = url.host_str().expect("canonical origin requires a host");
        // The leading dot in the suffix keeps lookalikes like
        // `evilusr.chan.app` from matching the `usr.chan.app` apex.
        let suffix = format!(".{apex_host}");
        let child = node_host
            .strip_suffix(&suffix)
            .ok_or_else(|| InvalidNodeBase::new(raw, "host is outside the proxy apex namespace"))?;
        if child.is_empty() || child.contains('.') {
            return Err(InvalidNodeBase::new(
                raw,
                "host is not exactly one DNS label below the proxy apex",
            ));
        }
        if child != expected_proxy_id {
            return Err(InvalidNodeBase::new(
                raw,
                "node label does not match the signed proxy id",
            ));
        }
        Ok(url)
    }
}

/// One validated tenant origin: where entry URLs for one live
/// devserver point. Constructed only from a controller-reported node
/// base that passed the proxy-namespace check, so the entry `aud`,
/// `proxy_origin`, and the fixed exchange URL can never drift apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantOrigin {
    /// Full origin: `{scheme}://{owner}--{disc}.{node-host}[:port]`.
    pub origin: String,
    /// The same authority without the scheme (`host[:port]`): the
    /// input `canonical_audience` canonicalizes into the entry `aud`.
    pub authority: String,
}

/// A controller row whose node base cannot anchor a tenant origin.
/// Minting from it anyway would redirect browsers and desktops to a
/// host no proxy serves (or one outside the deployment), so the entry
/// and roster paths surface it as an upstream failure instead of
/// falling back to the shared apex.
#[derive(Debug, thiserror::Error)]
#[error("controller proxy_base_url {raw:?} rejected: {reason}")]
pub struct InvalidNodeBase {
    raw: String,
    reason: &'static str,
}

impl InvalidNodeBase {
    fn new(raw: &str, reason: &'static str) -> Self {
        Self {
            raw: raw.to_string(),
            reason,
        }
    }
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

fn parse_bool_env(name: &str, default: bool) -> anyhow::Result<bool> {
    match std::env::var(name) {
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" | "" => Ok(false),
            other => anyhow::bail!("{name} must be true/false, got {other:?}"),
        },
        Err(_) => Ok(default),
    }
}

fn validate_distinct_auth_tokens(tokens: &[(&str, &str)]) -> anyhow::Result<()> {
    for (index, (left_name, left)) in tokens.iter().enumerate() {
        if left.is_empty() {
            continue;
        }
        for (right_name, right) in &tokens[index + 1..] {
            if !right.is_empty() && left == right {
                anyhow::bail!("{left_name} and {right_name} must be distinct");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg(apex: &str) -> Config {
        Config {
            bind_addr: "127.0.0.1:7000".parse().unwrap(),
            internal_bind_addr: "127.0.0.1:7001".parse().unwrap(),
            base_url: "http://localhost:7000".parse().unwrap(),
            devserver_proxy_origin: apex.parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
            database_url: "x".into(),
            cookie_secure: true,
            profile_client: ProfileClient::new("http://x/".parse().unwrap(), "x".into()).unwrap(),
            internal_auth_token: "x".into(),
            session_internal_auth_token: String::new(),
            identity_admin_token: String::new(),
            account_admin_token: String::new(),
            workspace_admin: DevserverControlClient::new(
                "http://127.0.0.1:7002".parse().unwrap(),
                "test-identity-admin-token".into(),
            )
            .unwrap(),
            admission_lease_verifier: {
                let signer = AdmissionLeaseSigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap()
            },
            entry_signer: gateway_common::devserver_gate::EntrySigner::from_base64(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap(),
            providers: vec![],
        }
    }

    #[test]
    fn configured_identity_auth_tokens_must_be_pairwise_distinct() {
        let names = [
            "IDENTITY_INTERNAL_TOKEN",
            "IDENTITY_SESSION_INTERNAL_TOKEN",
            "IDENTITY_ADMIN_TOKEN",
            "IDENTITY_ACCOUNT_ADMIN_TOKEN",
        ];
        assert!(validate_distinct_auth_tokens(&[
            (names[0], "validation"),
            (names[1], "session"),
            (names[2], "operator"),
            (names[3], "account"),
        ])
        .is_ok());
        assert!(validate_distinct_auth_tokens(&[
            (names[0], "validation"),
            (names[1], ""),
            (names[2], ""),
            (names[3], ""),
        ])
        .is_ok());

        for left in 0..names.len() {
            for right in left + 1..names.len() {
                let mut values = ["validation", "session", "operator", "account"];
                values[right] = values[left];
                let error = validate_distinct_auth_tokens(&[
                    (names[0], values[0]),
                    (names[1], values[1]),
                    (names[2], values[2]),
                    (names[3], values[3]),
                ])
                .expect_err("duplicate configured identity bearer");
                let message = error.to_string();
                assert!(message.contains(names[left]), "{message}");
                assert!(message.contains(names[right]), "{message}");
            }
        }
    }

    #[test]
    fn tenant_origin_prefixes_owner_and_disc_to_the_node_host() {
        let cfg = test_cfg("https://usr.chan.app");
        let t = cfg
            .tenant_origin_for(
                "alice",
                "0123456789abcdef0123456789abcdef",
                "p1",
                "https://p1.usr.chan.app",
            )
            .expect("valid node base");
        assert_eq!(t.origin, "https://alice--0123456789ab.p1.usr.chan.app");
        assert_eq!(t.authority, "alice--0123456789ab.p1.usr.chan.app");

        // Lowercased explicitly on both parts: the proxy's host parse
        // and the canonical aud are lowercase.
        let t = cfg
            .tenant_origin_for(
                "USER-1",
                "ABCDEFABCDEFABCDEF",
                "p1",
                "https://p1.usr.chan.app",
            )
            .expect("valid node base");
        assert_eq!(t.origin, "https://user-1--abcdefabcdef.p1.usr.chan.app");

        // Short (test-fixture) ids are used whole.
        let t = cfg
            .tenant_origin_for("alice", "abc123", "p1", "https://p1.usr.chan.app")
            .expect("valid node base");
        assert_eq!(t.origin, "https://alice--abc123.p1.usr.chan.app");
    }

    #[test]
    fn tenant_origin_preserves_node_scheme_and_non_default_port() {
        // A non-default port survives only when the apex itself carries
        // it (the effective ports must match); the tenant origin keeps
        // the explicit suffix.
        let cfg = test_cfg("https://usr.chan.app:8443");
        let t = cfg
            .tenant_origin_for("alice", "abc123", "p1", "https://p1.usr.chan.app:8443")
            .expect("non-default port node base");
        assert_eq!(t.origin, "https://alice--abc123.p1.usr.chan.app:8443");
        assert_eq!(t.authority, "alice--abc123.p1.usr.chan.app:8443");

        let cfg = test_cfg("http://usr.localtest.me:7002");
        let t = cfg
            .tenant_origin_for("alice", "abc123", "p1", "http://p1.usr.localtest.me:7002")
            .expect("http dev node base");
        assert_eq!(t.origin, "http://alice--abc123.p1.usr.localtest.me:7002");
    }

    #[test]
    fn tenant_origin_rejects_node_bases_outside_the_namespace() {
        let cfg = test_cfg("https://usr.chan.app");
        let id = "abc123";
        for bad in [
            // The bare apex is the shared ingress, not a node.
            "https://usr.chan.app",
            // Two labels below the apex is not a node base.
            "https://deep.p1.usr.chan.app",
            // A different namespace entirely.
            "https://p1.evil.example.net",
            // A suffix lookalike must not strip to a child label.
            "https://p1.usr.chan.app.evil.net",
            // Scheme and effective port must match the apex.
            "http://p1.usr.chan.app",
            "https://p1.usr.chan.app:8443",
        ] {
            assert!(
                cfg.tenant_origin_for("alice", id, "p1", bad).is_err(),
                "{bad} must not mint"
            );
        }
    }

    #[test]
    fn tenant_origin_rejects_non_canonical_node_bases() {
        let cfg = test_cfg("https://usr.chan.app");
        let id = "abc123";
        for bad in [
            "not a url",
            "ftp://p1.usr.chan.app",
            "https://user@p1.usr.chan.app",
            "https://p1.usr.chan.app/path",
            "https://p1.usr.chan.app/?q=1",
            "https://p1.usr.chan.app/#frag",
        ] {
            assert!(
                cfg.tenant_origin_for("alice", id, "p1", bad).is_err(),
                "{bad} must not mint"
            );
        }
    }
}
