use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use devserver_control_proto::{AdmissionLeaseSigner, AdmissionLeaseVerifier, ProxyId};
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
    /// e.g. `https://proxy.chan.app`. Every controller-reported node
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
    /// Desktop peer enrollment; absent keeps key enrollment disabled.
    pub wireguard: Option<crate::wireguard::WireguardEnrollment>,
    /// Bearer accepted only by the internal WireGuard peer-list route.
    pub wireguard_agent_token: String,
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

        let origins = Origins::read(required_origin)?;
        let wireguard = wireguard_from_vars(|name| std::env::var(name).ok(), &origins)?;
        let Origins {
            base_url,
            devserver_proxy_origin,
            devserver_tunnel_origin,
        } = origins;

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
        let wireguard_agent_token = std::env::var("WIREGUARD_AGENT_TOKEN").unwrap_or_default();
        validate_distinct_auth_tokens(&[
            ("IDENTITY_INTERNAL_TOKEN", &internal_auth_token),
            (
                "IDENTITY_SESSION_INTERNAL_TOKEN",
                &session_internal_auth_token,
            ),
            ("IDENTITY_ADMIN_TOKEN", &identity_admin_token),
            ("IDENTITY_ACCOUNT_ADMIN_TOKEN", &account_admin_token),
            ("WIREGUARD_AGENT_TOKEN", &wireguard_agent_token),
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

        let providers = providers_from_vars(
            |name| std::env::var(name).ok(),
            oauth_endpoints_base.as_deref(),
        )?;

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
            wireguard,
            wireguard_agent_token,
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
    /// e.g. `https://alice--0123456789ab.p1.proxy.chan.app` out of
    /// `https://p1.proxy.chan.app`. `disc` is the first 12 chars of the
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
        // `evilproxy.chan.app` from matching the `proxy.chan.app` apex.
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

/// What one OAuth provider's client id and client secret values amount
/// to. Not `Debug`: `Complete` holds the client secret.
enum OAuthClientPair {
    /// Neither half is set: the provider is off.
    Absent,
    /// Both halves are set: the provider registers with them, trimmed.
    Complete { id: String, secret: String },
    /// Only the client secret is set.
    MissingId,
    /// Only the client id is set.
    MissingSecret,
}

impl OAuthClientPair {
    /// Classify one provider's raw values. A value that is empty or only
    /// whitespace counts as unset: a deployment that lists every key, as
    /// an `EnvironmentFile` template or an orchestrator secret does, sets
    /// the ones it does not use to the empty string.
    fn from_raw(id: Option<String>, secret: Option<String>) -> Self {
        let set = |raw: Option<String>| {
            raw.map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        match (set(id), set(secret)) {
            (Some(id), Some(secret)) => Self::Complete { id, secret },
            (None, Some(_)) => Self::MissingId,
            (Some(_), None) => Self::MissingSecret,
            (None, None) => Self::Absent,
        }
    }
}

/// Register every OAuth provider whose client pair `var` configures, and
/// refuse a pair with only one half set. `var` is the environment lookup,
/// a parameter so the registration rules are testable without touching
/// the process environment.
fn providers_from_vars(
    var: impl Fn(&str) -> Option<String>,
    oauth_endpoints_base: Option<&str>,
) -> anyhow::Result<Vec<Arc<dyn Provider>>> {
    // A half pair is a lost secret or a typo, never a way to turn a
    // provider off. The refusal names the variables and not the values,
    // since either half may hold the secret.
    let pair = |id_var: &str, secret_var: &str| match OAuthClientPair::from_raw(
        var(id_var),
        var(secret_var),
    ) {
        OAuthClientPair::Absent => Ok(None),
        OAuthClientPair::Complete { id, secret } => Ok(Some((id, secret))),
        OAuthClientPair::MissingId => Err(anyhow::anyhow!(
            "{id_var} is unset or empty but {secret_var} is set; set both or neither"
        )),
        OAuthClientPair::MissingSecret => Err(anyhow::anyhow!(
            "{secret_var} is unset or empty but {id_var} is set; set both or neither"
        )),
    };
    let mut providers: Vec<Arc<dyn Provider>> = Vec::new();
    if let Some((id, secret)) = pair("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")? {
        let github = match oauth_endpoints_base {
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
    if let Some((id, secret)) = pair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")? {
        providers.push(Arc::new(GoogleProvider::new(id, secret)?));
    }
    if let Some((id, secret)) = pair("GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET")? {
        providers.push(Arc::new(GitLabProvider::new(id, secret)?));
    }
    if providers.is_empty() {
        anyhow::bail!(
            "no providers configured (set at least one of GITHUB / GOOGLE / GITLAB CLIENT_ID + CLIENT_SECRET)"
        );
    }
    Ok(providers)
}

/// The public origins identity is configured with. All three are `Url`s,
/// so code that needs more than one takes this value and reads each by
/// name: no call passes two of them side by side, where they could change
/// places unnoticed.
struct Origins {
    /// `BASE_URL`, identity's own origin.
    base_url: Url,
    /// `DEVSERVER_PROXY_ORIGIN`, the proxy namespace apex.
    devserver_proxy_origin: Url,
    /// `DEVSERVER_TUNNEL_ORIGIN`, the tunnel ingress.
    devserver_tunnel_origin: Url,
}

impl Origins {
    /// Read each origin from the variable it is named after. `origin`
    /// reads one required origin by its variable's name, a parameter so
    /// the pairing of variables and fields is testable without touching
    /// the process environment.
    fn read(origin: impl Fn(&str) -> anyhow::Result<Url>) -> anyhow::Result<Self> {
        Ok(Self {
            base_url: origin("BASE_URL")?,
            devserver_proxy_origin: origin("DEVSERVER_PROXY_ORIGIN")?,
            devserver_tunnel_origin: origin("DEVSERVER_TUNNEL_ORIGIN")?,
        })
    }
}

/// The variables of the single-ingress configuration, which a list of
/// ingresses cannot be read from. A value in one is refused instead of
/// ignored, so a deployment that still sets them does not start with
/// enrollment silently off.
const SINGLE_INGRESS_VARS: [&str; 4] = [
    "WIREGUARD_HOST_ID",
    "WIREGUARD_ENDPOINT",
    "WIREGUARD_PUBLIC_KEY",
    "WIREGUARD_HOSTS",
];

/// What an operator sets instead of the single-ingress variables.
const SINGLE_INGRESS_REPLACEMENT: &str =
    "WIREGUARD_INGRESSES holds one id=public_key@endpoint entry per proxy node \
     (id: the node's DEVSERVER_PROXY_ID), WIREGUARD_INGRESS_ADDRESSES holds the tunnel \
     address WIREGUARD_HOSTS mapped, and each ingress's host map is derived from its id and \
     DEVSERVER_PROXY_ORIGIN's host";

/// Read the WireGuard enrollment offer: `None` when no enrollment variable
/// is set, and a refusal for a partial or invalid set. `var` is the
/// environment lookup, a parameter so the rules are testable without
/// touching the process environment; a value that is empty or only
/// whitespace counts as unset.
///
/// `WIREGUARD_INGRESSES` lists one `id=public_key@endpoint` entry per proxy
/// node, separated by `;`. An entry splits once on its first `=` and then
/// once on `@`, so the `=` that pads a base64 key is part of the key. The
/// order is kept: the first entry fills the single-ingress wire fields.
///
/// Node names are derived under `origins`' proxy apex, and identity's own
/// origin is checked against them.
///
/// A refusal names the variable at fault and never a value, since a key,
/// an endpoint or a pasted secret may be what is wrong. A refusal about one
/// entry of the list names the entry by its position, counted from 1.
fn wireguard_from_vars(
    var: impl Fn(&str) -> Option<String>,
    origins: &Origins,
) -> anyhow::Result<Option<crate::wireguard::WireguardEnrollment>> {
    use crate::wireguard::WireguardEnrollment;
    use gateway_common::wireguard::{canonical_public_key, valid_host, Ingress};

    let read = |name| {
        var(name)
            .map(|raw| raw.trim().to_owned())
            .filter(|raw| !raw.is_empty())
    };
    // Every one that is set is named in the one refusal: naming the first
    // alone costs a failed start for each of the others.
    let single: Vec<&str> = SINGLE_INGRESS_VARS
        .into_iter()
        .filter(|&name| read(name).is_some())
        .collect();
    if !single.is_empty() {
        anyhow::bail!(
            "{} must be unset: {SINGLE_INGRESS_REPLACEMENT}",
            single.join(", ")
        );
    }
    let names = [
        "WIREGUARD_INGRESSES",
        "WIREGUARD_INGRESS_ADDRESSES",
        "WIREGUARD_ALLOWED_IPS",
    ];
    let values = names.map(read);
    let keepalive = read("WIREGUARD_PERSISTENT_KEEPALIVE");
    if values.iter().all(Option::is_none) && keepalive.is_none() {
        return Ok(None);
    }
    for (name, value) in names.iter().zip(&values) {
        if value.is_none() {
            anyhow::bail!("{name} is required when WireGuard enrollment is configured");
        }
    }
    let [ingresses, addresses, allowed_ips] =
        values.map(|value| value.expect("all required values checked"));
    let networks = allowed_ips
        .split(',')
        .map(|value| value.trim().parse::<ipnet::IpNet>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("WIREGUARD_ALLOWED_IPS must contain comma-separated CIDRs")?;
    let persistent_keepalive: u16 = keepalive
        .as_deref()
        .unwrap_or("25")
        .parse()
        .context("WIREGUARD_PERSISTENT_KEEPALIVE must be seconds in 0..=65535")?;
    let addresses = addresses
        .split(',')
        .map(|address| address.trim().parse::<std::net::IpAddr>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("WIREGUARD_INGRESS_ADDRESSES must contain comma-separated IP addresses")?;
    let of_family = |v4: bool| addresses.iter().filter(|a| a.is_ipv4() == v4).count();
    if of_family(true) > 1 || of_family(false) > 1 {
        anyhow::bail!(
            "WIREGUARD_INGRESS_ADDRESSES must hold at most one IPv4 and one IPv6 address"
        );
    }
    if addresses
        .iter()
        .any(|address| !networks.iter().any(|network| network.contains(address)))
    {
        anyhow::bail!("WIREGUARD_INGRESS_ADDRESSES address is outside WIREGUARD_ALLOWED_IPS");
    }
    // Node names are built under the proxy apex's host, without its port:
    // a host map routes by name, and an address literal has no names
    // below it.
    let Some(url::Host::Domain(proxy_host)) = origins.devserver_proxy_origin.host() else {
        anyhow::bail!(
            "DEVSERVER_PROXY_ORIGIN must have a DNS host when WireGuard enrollment is configured"
        );
    };
    // Checked once, before any entry: a host no node name can be built
    // under is a fault of this variable, not of an ingress id.
    if !proxy_host.split('.').all(valid_host) {
        anyhow::bail!(
            "DEVSERVER_PROXY_ORIGIN's host must be a DNS name of plain labels (letters, digits \
             and inner hyphens, at most 63 bytes each, no trailing dot) when WireGuard \
             enrollment is configured"
        );
    }
    let identity_host = origins
        .base_url
        .host_str()
        .context("BASE_URL must have a host")?;
    let mut list: Vec<Ingress> = Vec::new();
    for (index, entry) in ingresses.split(';').enumerate() {
        let position = index + 1;
        let malformed =
            || format!("WIREGUARD_INGRESSES entry {position} must be id=public_key@endpoint");
        let (id, peer) = entry.split_once('=').with_context(malformed)?;
        let (public_key, endpoint) = peer.split_once('@').with_context(malformed)?;
        let (id, endpoint) = (id.trim(), endpoint.trim());
        if ProxyId::parse(id).is_err() {
            anyhow::bail!(
                "WIREGUARD_INGRESSES entry {position} id must be a proxy id, one lowercase DNS label"
            );
        }
        let public_key = canonical_public_key(public_key.trim()).with_context(|| {
            format!(
                "WIREGUARD_INGRESSES entry {position} public key must be padded base64 for 32 bytes"
            )
        })?;
        validate_wireguard_endpoint(endpoint, position)?;
        if let Some(first) = list.iter().position(|ingress| ingress.id == id) {
            anyhow::bail!(
                "WIREGUARD_INGRESSES entry {position} repeats the id of entry {}",
                first + 1
            );
        }
        let node = crate::wireguard::node_name(id, proxy_host);
        if node.len() > 253 {
            anyhow::bail!(
                "WIREGUARD_INGRESSES entry {position} id and DEVSERVER_PROXY_ORIGIN's host must \
                 form a node name of at most 253 bytes"
            );
        }
        // Identity is where a desktop enrolls and reads discovery, before
        // and without any tunnel, so no ingress may carry its name.
        if identity_host == node || identity_host.ends_with(&format!(".{node}")) {
            anyhow::bail!(
                "BASE_URL's host must not be the node name of WIREGUARD_INGRESSES entry \
                 {position} or a name below it"
            );
        }
        list.push(Ingress {
            id: id.to_owned(),
            endpoint: endpoint.to_owned(),
            public_key,
        });
    }
    let enrollment = WireguardEnrollment::new(
        list,
        proxy_host,
        &addresses,
        networks.iter().map(ToString::to_string).collect(),
        (persistent_keepalive != 0).then_some(persistent_keepalive),
    )
    .context("WIREGUARD_INGRESSES must name at least one ingress")?;
    Ok(Some(enrollment))
}

/// Check the endpoint of the ingress at `position` in the list: `host:port`
/// with a DNS host, or an IPv6 literal in brackets and a port.
fn validate_wireguard_endpoint(raw: &str, position: usize) -> anyhow::Result<()> {
    let refusal = |reason: &str| format!("WIREGUARD_INGRESSES entry {position} endpoint {reason}");
    let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
        let (host, tail) = rest
            .split_once(']')
            .with_context(|| refusal("has an unterminated IPv6 literal"))?;
        host.parse::<std::net::Ipv6Addr>()
            .with_context(|| refusal("has an invalid IPv6 address"))?;
        (
            host,
            tail.strip_prefix(':')
                .with_context(|| refusal("must have a port"))?,
        )
    } else {
        let (host, port) = raw
            .rsplit_once(':')
            .with_context(|| refusal("must be host:port"))?;
        if host.len() > 253
            || !host
                .to_ascii_lowercase()
                .split('.')
                .all(gateway_common::wireguard::valid_host)
        {
            anyhow::bail!(refusal("must have a DNS host or bracketed IPv6 address"));
        }
        (host, port)
    };
    let port = port
        .parse::<u16>()
        .with_context(|| refusal("must have a numeric port"))?;
    if host.is_empty() || port == 0 {
        anyhow::bail!(refusal("must have a host and a nonzero port"));
    }
    Ok(())
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
pub(crate) fn test_config(apex: &str) -> Config {
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
            let signer =
                AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                    .unwrap();
            AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap()
        },
        entry_signer: gateway_common::devserver_gate::EntrySigner::from_base64(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .unwrap(),
        providers: vec![],
        wireguard: None,
        wireguard_agent_token: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_identity_auth_tokens_must_be_pairwise_distinct() {
        let names = [
            "IDENTITY_INTERNAL_TOKEN",
            "IDENTITY_SESSION_INTERNAL_TOKEN",
            "IDENTITY_ADMIN_TOKEN",
            "IDENTITY_ACCOUNT_ADMIN_TOKEN",
            "WIREGUARD_AGENT_TOKEN",
        ];
        assert!(validate_distinct_auth_tokens(&[
            (names[0], "validation"),
            (names[1], "session"),
            (names[2], "operator"),
            (names[3], "account"),
            (names[4], "wireguard"),
        ])
        .is_ok());
        assert!(validate_distinct_auth_tokens(&[
            (names[0], "validation"),
            (names[1], ""),
            (names[2], ""),
            (names[3], ""),
            (names[4], ""),
        ])
        .is_ok());

        for left in 0..names.len() {
            for right in left + 1..names.len() {
                let mut values = ["validation", "session", "operator", "account", "wireguard"];
                values[right] = values[left];
                let error = validate_distinct_auth_tokens(&[
                    (names[0], values[0]),
                    (names[1], values[1]),
                    (names[2], values[2]),
                    (names[3], values[3]),
                    (names[4], values[4]),
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
        let cfg = test_config("https://proxy.chan.app");
        let t = cfg
            .tenant_origin_for(
                "alice",
                "0123456789abcdef0123456789abcdef",
                "p1",
                "https://p1.proxy.chan.app",
            )
            .expect("valid node base");
        assert_eq!(t.origin, "https://alice--0123456789ab.p1.proxy.chan.app");
        assert_eq!(t.authority, "alice--0123456789ab.p1.proxy.chan.app");

        // Lowercased explicitly on both parts: the proxy's host parse
        // and the canonical aud are lowercase.
        let t = cfg
            .tenant_origin_for(
                "USER-1",
                "ABCDEFABCDEFABCDEF",
                "p1",
                "https://p1.proxy.chan.app",
            )
            .expect("valid node base");
        assert_eq!(t.origin, "https://user-1--abcdefabcdef.p1.proxy.chan.app");

        // Short (test-fixture) ids are used whole.
        let t = cfg
            .tenant_origin_for("alice", "abc123", "p1", "https://p1.proxy.chan.app")
            .expect("valid node base");
        assert_eq!(t.origin, "https://alice--abc123.p1.proxy.chan.app");
    }

    #[test]
    fn tenant_origin_preserves_node_scheme_and_non_default_port() {
        // A non-default port survives only when the apex itself carries
        // it (the effective ports must match); the tenant origin keeps
        // the explicit suffix.
        let cfg = test_config("https://proxy.chan.app:8443");
        let t = cfg
            .tenant_origin_for("alice", "abc123", "p1", "https://p1.proxy.chan.app:8443")
            .expect("non-default port node base");
        assert_eq!(t.origin, "https://alice--abc123.p1.proxy.chan.app:8443");
        assert_eq!(t.authority, "alice--abc123.p1.proxy.chan.app:8443");

        let cfg = test_config("http://proxy.localtest.me:7002");
        let t = cfg
            .tenant_origin_for("alice", "abc123", "p1", "http://p1.proxy.localtest.me:7002")
            .expect("http dev node base");
        assert_eq!(t.origin, "http://alice--abc123.p1.proxy.localtest.me:7002");
    }

    #[test]
    fn tenant_origin_rejects_node_bases_outside_the_namespace() {
        let cfg = test_config("https://proxy.chan.app");
        let id = "abc123";
        for bad in [
            // The bare apex is the shared ingress, not a node.
            "https://proxy.chan.app",
            // Two labels below the apex is not a node base.
            "https://deep.p1.proxy.chan.app",
            // A different namespace entirely.
            "https://p1.evil.example.net",
            // A suffix lookalike must not strip to a child label.
            "https://p1.proxy.chan.app.evil.net",
            // Scheme and effective port must match the apex.
            "http://p1.proxy.chan.app",
            "https://p1.proxy.chan.app:8443",
        ] {
            assert!(
                cfg.tenant_origin_for("alice", id, "p1", bad).is_err(),
                "{bad} must not mint"
            );
        }
    }

    #[test]
    fn tenant_origin_rejects_non_canonical_node_bases() {
        let cfg = test_config("https://proxy.chan.app");
        let id = "abc123";
        for bad in [
            "not a url",
            "ftp://p1.proxy.chan.app",
            "https://user@p1.proxy.chan.app",
            "https://p1.proxy.chan.app/path",
            "https://p1.proxy.chan.app/?q=1",
            "https://p1.proxy.chan.app/#frag",
        ] {
            assert!(
                cfg.tenant_origin_for("alice", id, "p1", bad).is_err(),
                "{bad} must not mint"
            );
        }
    }

    // Sentinel values a refusal must never print: either half of an OAuth
    // pair may be a secret.
    const ID_SENTINEL: &str = "id-sentinel-5d1f";
    const SECRET_SENTINEL: &str = "secret-sentinel-8a2c";
    const OTHER_ID_SENTINEL: &str = "other-id-sentinel-3b7e";
    const OTHER_SECRET_SENTINEL: &str = "other-secret-sentinel-9c4a";

    const OAUTH_VARS: [(&str, &str); 3] = [
        ("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
        ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
        ("GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET"),
    ];

    fn classify(id: Option<&str>, secret: Option<&str>) -> OAuthClientPair {
        OAuthClientPair::from_raw(id.map(str::to_owned), secret.map(str::to_owned))
    }

    /// A variable lookup over fixed assignments where the last one wins,
    /// as with a later systemd `EnvironmentFile`.
    fn lookup<K: Into<String>, V: Into<String>>(
        vars: impl IntoIterator<Item = (K, V)>,
    ) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        move |name| {
            vars.iter()
                .rev()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    /// The packaged `/etc/chan-gateway/identity.env` as systemd loads it:
    /// each `KEY=VALUE` line, with comments and blank lines skipped.
    fn packaged_identity_env() -> Vec<(String, String)> {
        let vars: Vec<(String, String)> = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/packaging/identity.env"
        ))
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with(['#', ';']))
        .map(|line| {
            // systemd also unquotes values and joins continuation lines;
            // refuse a file that needs either rather than misread it.
            assert!(!line.ends_with('\\'), "continuation line: {line}");
            let (key, value) = line.split_once('=').expect("KEY=VALUE line");
            assert!(!value.starts_with(['"', '\'']), "quoted value: {line}");
            (key.trim().to_owned(), value.trim().to_owned())
        })
        .collect();
        // A parse that found nothing would make every absence check pass.
        assert!(
            vars.contains(&("CHAN_GATEWAY_MIGRATIONS".into(), "external".into())),
            "the packaged identity.env did not parse"
        );
        vars
    }

    fn provider_names(providers: &[Arc<dyn Provider>]) -> Vec<&'static str> {
        providers.iter().map(|provider| provider.name()).collect()
    }

    /// The refusal `providers_from_vars` gives, in the `{:?}` form the
    /// binary logs it with, or a panic naming what it registered instead.
    fn refusal(result: anyhow::Result<Vec<Arc<dyn Provider>>>) -> String {
        match result {
            Ok(providers) => panic!(
                "expected a startup refusal, registered {:?}",
                provider_names(&providers)
            ),
            Err(error) => format!("{error:?}"),
        }
    }

    #[test]
    fn oauth_pair_with_both_halves_unset_is_absent() {
        assert!(matches!(classify(None, None), OAuthClientPair::Absent));
    }

    #[test]
    fn oauth_pair_with_empty_or_blank_halves_is_absent() {
        for (id, secret) in [
            (Some(""), Some("")),
            (Some("  "), Some("\t\n")),
            (Some(""), None),
            (None, Some(" ")),
        ] {
            assert!(
                matches!(classify(id, secret), OAuthClientPair::Absent),
                "{id:?} / {secret:?} must not configure a provider"
            );
        }
    }

    #[test]
    fn oauth_pair_with_both_halves_set_is_complete() {
        match classify(Some(ID_SENTINEL), Some(SECRET_SENTINEL)) {
            OAuthClientPair::Complete { id, secret } => {
                assert_eq!(id, ID_SENTINEL);
                assert_eq!(secret, SECRET_SENTINEL);
            }
            _ => panic!("a pair with both halves set must be complete"),
        }
    }

    #[test]
    fn oauth_pair_trims_both_halves() {
        match classify(Some(" id \n"), Some("\tsecret ")) {
            OAuthClientPair::Complete { id, secret } => {
                assert_eq!(id, "id");
                assert_eq!(secret, "secret");
            }
            _ => panic!("a padded pair must be complete"),
        }
    }

    #[test]
    fn oauth_pair_with_one_half_set_names_the_missing_half() {
        for secret in [Some(""), Some(" "), None] {
            assert!(
                matches!(
                    classify(Some(ID_SENTINEL), secret),
                    OAuthClientPair::MissingSecret
                ),
                "id set, secret {secret:?}"
            );
        }
        for id in [Some(""), Some(" "), None] {
            assert!(
                matches!(
                    classify(id, Some(SECRET_SENTINEL)),
                    OAuthClientPair::MissingId
                ),
                "secret set, id {id:?}"
            );
        }
    }

    #[test]
    fn half_configured_provider_refuses_naming_the_empty_variable() {
        // Both names appear in the refusal, so pin which one it calls empty.
        let assert_refusal = |message: String, empty_var: &str| {
            let names_empty = format!("{empty_var} is unset or empty");
            assert!(message.contains(&names_empty), "{message}");
            for value in [
                ID_SENTINEL,
                SECRET_SENTINEL,
                OTHER_ID_SENTINEL,
                OTHER_SECRET_SENTINEL,
            ] {
                assert!(!message.contains(value), "{message}");
            }
        };
        for (index, &(id_var, secret_var)) in OAUTH_VARS.iter().enumerate() {
            // Another provider is complete, so the refusal cannot be the
            // "no providers configured" one.
            let (other_id_var, other_secret_var) = OAUTH_VARS[(index + 1) % OAUTH_VARS.len()];
            let other = [
                (other_id_var, OTHER_ID_SENTINEL),
                (other_secret_var, OTHER_SECRET_SENTINEL),
            ];
            for (half, empty_var) in [
                ([(id_var, ID_SENTINEL), (secret_var, "")], secret_var),
                ([(id_var, ID_SENTINEL), (secret_var, " ")], secret_var),
                ([(id_var, ""), (secret_var, SECRET_SENTINEL)], id_var),
                ([(id_var, " "), (secret_var, SECRET_SENTINEL)], id_var),
            ] {
                let message = refusal(providers_from_vars(
                    lookup(other.iter().chain(&half).copied()),
                    None,
                ));
                assert_refusal(message, empty_var);
            }
            for (half, empty_var) in [
                ((id_var, ID_SENTINEL), secret_var),
                ((secret_var, SECRET_SENTINEL), id_var),
            ] {
                let message = refusal(providers_from_vars(
                    lookup(other.iter().copied().chain([half])),
                    None,
                ));
                assert_refusal(message, empty_var);
            }
        }
    }

    #[test]
    fn only_empty_oauth_pairs_refuse_with_no_providers_configured() {
        let names = OAUTH_VARS.iter().flat_map(|&(id, secret)| [id, secret]);
        for value in [None, Some(""), Some(" \t")] {
            let vars: Vec<(&str, &str)> = match value {
                None => Vec::new(),
                Some(value) => names.clone().map(|name| (name, value)).collect(),
            };
            let message = refusal(providers_from_vars(lookup(vars), None));
            assert!(
                message.contains("no providers configured"),
                "{value:?}: {message}"
            );
        }
    }

    #[test]
    fn stock_packaged_env_configures_no_provider() {
        let message = refusal(providers_from_vars(lookup(packaged_identity_env()), None));
        assert!(message.contains("no providers configured"), "{message}");
    }

    #[test]
    fn stock_packaged_env_configures_no_wireguard_enrollment() {
        let origins = Origins {
            base_url: "https://gw.example.test".parse().unwrap(),
            devserver_proxy_origin: "https://proxy.example.test".parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
        };
        let enrollment = wireguard_from_vars(lookup(packaged_identity_env()), &origins)
            .expect("the packaged identity.env must start identity");
        assert!(enrollment.is_none());
    }

    /// `GET /api/providers` on the public router, built on a closed pool
    /// so any database access fails instead of connecting.
    async fn api_providers(providers: Vec<Arc<dyn Provider>>) -> serde_json::Value {
        use tower::ServiceExt;

        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@localhost/unused")
            .unwrap();
        pool.close().await;
        let cfg = Config {
            providers,
            ..test_config("https://proxy.chan.app")
        };
        let (public, _internal) = crate::http::routers(
            Arc::new(cfg),
            tower_sessions_sqlx_store::PostgresStore::new(pool.clone()),
            crate::api_tokens::ApiTokenService::new(pool),
            crate::token_throttle::TokenThrottle::new(),
        );
        let request = axum::http::Request::get("/api/providers")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = public.oneshot(request).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn github_only_deployment_lists_only_github() {
        let github = [
            ("GITHUB_CLIENT_ID".to_owned(), ID_SENTINEL.to_owned()),
            (
                "GITHUB_CLIENT_SECRET".to_owned(),
                SECRET_SENTINEL.to_owned(),
            ),
        ];
        let others_empty = OAUTH_VARS[1..].iter().flat_map(|&(id, secret)| {
            [
                (id.to_owned(), String::new()),
                (secret.to_owned(), String::new()),
            ]
        });
        for (shape, vars) in [
            // The packaged file with an operator file setting the GitHub pair.
            (
                "stock file plus GitHub",
                packaged_identity_env()
                    .into_iter()
                    .chain(github.clone())
                    .collect::<Vec<_>>(),
            ),
            (
                "other pairs empty",
                others_empty.chain(github.clone()).collect(),
            ),
            ("other pairs unset", github.to_vec()),
        ] {
            let providers = providers_from_vars(lookup(vars), None).expect(shape);
            assert_eq!(
                api_providers(providers).await,
                serde_json::json!({ "providers": ["github"] }),
                "{shape}"
            );
        }
    }
}

#[cfg(test)]
mod wireguard_tests {
    use super::*;
    use crate::wireguard::{HostRoute, WireguardEnrollment};
    use base64::Engine;
    use gateway_common::wireguard::Ingress;
    use std::collections::BTreeMap;

    /// A canonical public key. Every one ends in the `=` base64 pads a
    /// 32-byte value with, so each entry below also carries a `=` that is
    /// not its id separator.
    fn key(byte: u8) -> String {
        base64::engine::general_purpose::STANDARD.encode([byte; 32])
    }

    fn vars() -> BTreeMap<String, String> {
        [
            (
                "WIREGUARD_INGRESSES",
                format!(
                    "p1={}@p1.proxy.example.test:51820;p2={}@[2001:db8::2]:51821",
                    key(7),
                    key(8)
                ),
            ),
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.7.0.1,fd00:7::1".to_owned(),
            ),
            (
                "WIREGUARD_ALLOWED_IPS",
                "10.7.0.0/24,fd00:7::/64".to_owned(),
            ),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
    }

    fn parse_at(
        vars: &BTreeMap<String, String>,
        identity: &str,
        proxy: &str,
    ) -> anyhow::Result<Option<WireguardEnrollment>> {
        let origins = Origins {
            base_url: identity.parse().unwrap(),
            devserver_proxy_origin: proxy.parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
        };
        wireguard_from_vars(|name| vars.get(name).cloned(), &origins)
    }

    fn parse(vars: &BTreeMap<String, String>) -> anyhow::Result<Option<WireguardEnrollment>> {
        parse_at(
            vars,
            "https://gw.example.test",
            "https://proxy.example.test",
        )
    }

    /// The refusal for `vars` with `name` set to `value`.
    fn refusal(name: &str, value: &str) -> String {
        let mut values = vars();
        values.insert(name.into(), value.into());
        match parse(&values) {
            Ok(_) => panic!("{name}={value:?} must refuse"),
            Err(error) => error.to_string(),
        }
    }

    fn ids(cfg: &WireguardEnrollment) -> Vec<&str> {
        cfg.ingresses()
            .iter()
            .map(|route| route.ingress.id.as_str())
            .collect()
    }

    fn host(name: &str, addresses: &[&str]) -> HostRoute {
        HostRoute {
            name: name.into(),
            addresses: addresses.iter().map(|a| a.parse().unwrap()).collect(),
        }
    }

    #[test]
    fn wireguard_config_is_off_when_no_value_is_set() {
        assert!(parse(&BTreeMap::new()).unwrap().is_none());
        // A deployment that lists every key sets the ones it does not use
        // to the empty string, the single-ingress ones among them.
        let blank: BTreeMap<String, String> = vars()
            .into_keys()
            .chain(["WIREGUARD_PERSISTENT_KEEPALIVE".to_owned()])
            .chain(SINGLE_INGRESS_VARS.iter().map(|name| (*name).to_owned()))
            .zip(["", " ", "\t", "", " ", "", "\n", ""].map(str::to_owned))
            .collect();
        assert_eq!(blank.len(), 8);
        assert!(parse(&blank).unwrap().is_none());
    }

    #[test]
    fn wireguard_config_reads_two_ingresses_in_order_with_derived_host_maps() {
        let cfg = parse(&vars()).unwrap().unwrap();
        let addresses = ["10.7.0.1", "fd00:7::1"];
        assert_eq!(
            cfg.ingresses()
                .iter()
                .map(|route| route.ingress.clone())
                .collect::<Vec<_>>(),
            [
                Ingress {
                    id: "p1".into(),
                    endpoint: "p1.proxy.example.test:51820".into(),
                    public_key: key(7),
                },
                Ingress {
                    id: "p2".into(),
                    endpoint: "[2001:db8::2]:51821".into(),
                    public_key: key(8),
                },
            ]
        );
        for route in cfg.ingresses() {
            let node = format!("{}.proxy.example.test", route.ingress.id);
            assert_eq!(
                route.hosts,
                [
                    host(&node, &addresses),
                    host(&format!("*.{node}"), &addresses)
                ]
            );
        }
        assert_eq!(cfg.allowed_ips(), ["10.7.0.0/24", "fd00:7::/64"]);
        assert_eq!(cfg.persistent_keepalive(), Some(25));

        // The operator's order is kept, whatever the ids sort to: the
        // first entry is the one the single-ingress wire fields describe.
        let mut values = vars();
        values.insert(
            "WIREGUARD_INGRESSES".into(),
            format!(
                "p2={}@b.example.test:2;p1={}@a.example.test:1",
                key(8),
                key(7)
            ),
        );
        let cfg = parse(&values).unwrap().unwrap();
        assert_eq!(ids(&cfg), ["p2", "p1"]);
        assert_eq!(cfg.first().ingress.endpoint, "b.example.test:2");
    }

    #[test]
    fn wireguard_config_accepts_repeats_spacing_one_family_and_keepalive_values() {
        // Keys and endpoints may repeat across ids, and spaces around an
        // entry's parts are not part of them.
        let mut values = vars();
        values.insert(
            "WIREGUARD_INGRESSES".into(),
            format!(
                " p1 = {key} @ wg.example.test:51820 ; p2={key}@wg.example.test:51820",
                key = key(7)
            ),
        );
        values.insert("WIREGUARD_INGRESS_ADDRESSES".into(), " 10.7.0.1 ".into());
        values.insert("WIREGUARD_ALLOWED_IPS".into(), "10.7.0.1/32".into());
        values.insert("WIREGUARD_PERSISTENT_KEEPALIVE".into(), "0".into());
        let cfg = parse(&values).unwrap().unwrap();
        assert_eq!(ids(&cfg), ["p1", "p2"]);
        for route in cfg.ingresses() {
            assert_eq!(route.ingress.endpoint, "wg.example.test:51820");
            assert_eq!(route.ingress.public_key, key(7));
            assert_eq!(
                route.hosts[0].addresses,
                ["10.7.0.1".parse::<std::net::IpAddr>().unwrap()]
            );
        }
        assert_eq!(cfg.allowed_ips(), ["10.7.0.1/32"]);
        assert_eq!(cfg.persistent_keepalive(), None);
        values.insert("WIREGUARD_PERSISTENT_KEEPALIVE".into(), "40".into());
        values.insert("WIREGUARD_INGRESS_ADDRESSES".into(), "fd00:7::1".into());
        values.insert("WIREGUARD_ALLOWED_IPS".into(), "fd00:7::/64".into());
        let cfg = parse(&values).unwrap().unwrap();
        assert_eq!(cfg.persistent_keepalive(), Some(40));
    }

    #[test]
    fn wireguard_config_accepts_an_ipv4_endpoint_and_the_longest_id_and_node_name() {
        let k = key(7);
        // An IPv4 literal is the commonest endpoint. It passes as a host
        // whose labels are digits, which a DNS label may be.
        let mut values = vars();
        values.insert(
            "WIREGUARD_INGRESSES".into(),
            format!("p1={k}@198.51.100.7:51820"),
        );
        let cfg = parse(&values).unwrap().unwrap();
        assert_eq!(cfg.first().ingress.endpoint, "198.51.100.7:51820");

        // An id is one DNS label: 63 bytes are accepted and 64 are the
        // first refused.
        let id = "a".repeat(63);
        values.insert(
            "WIREGUARD_INGRESSES".into(),
            format!("{id}={k}@a.example.test:1"),
        );
        let cfg = parse(&values).unwrap().unwrap();
        assert_eq!(ids(&cfg), [id.as_str()]);
        assert_eq!(
            cfg.first().hosts[0].name,
            format!("{id}.proxy.example.test")
        );
        assert_eq!(
            refusal(
                "WIREGUARD_INGRESSES",
                &format!("a{id}={k}@a.example.test:1")
            ),
            "WIREGUARD_INGRESSES entry 1 id must be a proxy id, one lowercase DNS label"
        );

        // A node name is a DNS name: 253 bytes are accepted and 254 are
        // the first refused. The ids are two bytes, so an apex host of 250
        // makes names of exactly 253, a bound the id and the host share.
        let apex = |last_label: usize| {
            let labels = ["a".repeat(63), "a".repeat(63), "a".repeat(63)];
            format!("https://{}.{}", labels.join("."), "a".repeat(last_label))
        };
        let cfg = parse_at(&vars(), "https://gw.example.test", &apex(58))
            .unwrap()
            .unwrap();
        for route in cfg.ingresses() {
            assert_eq!(route.hosts[0].name.len(), 253);
        }
        let error = parse_at(&vars(), "https://gw.example.test", &apex(59))
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "WIREGUARD_INGRESSES entry 1 id and DEVSERVER_PROXY_ORIGIN's host must form a node \
             name of at most 253 bytes"
        );
    }

    #[test]
    fn wireguard_config_refuses_a_partial_set() {
        for name in vars().keys() {
            let mut values = vars();
            values.remove(name);
            let error = parse(&values).unwrap_err().to_string();
            assert!(error.contains(&format!("{name} is required")), "{error}");
            // One value alone is as partial as two.
            let alone: BTreeMap<String, String> = [(name.clone(), vars()[name].clone())].into();
            let error = parse(&alone).unwrap_err().to_string();
            assert!(error.contains("is required"), "{name}: {error}");
            assert!(!error.contains(&format!("{name} is required")), "{error}");
            // An empty value is an unset one.
            assert!(refusal(name, " ").contains(&format!("{name} is required")));
        }
        let error = parse(&[("WIREGUARD_PERSISTENT_KEEPALIVE".into(), "25".into())].into())
            .unwrap_err()
            .to_string();
        assert!(error.contains("WIREGUARD_INGRESSES is required"), "{error}");
    }

    #[test]
    fn wireguard_config_refuses_an_invalid_ingress_list() {
        let (k, other) = (key(7), key(8));
        let good = format!("p1={k}@a.example.test:1");
        // Each refusal is the whole message: the entry's position, counted
        // from 1, what is wrong with it, and no part of its value.
        let malformed =
            |n: u8| format!("WIREGUARD_INGRESSES entry {n} must be id=public_key@endpoint");
        let id = "WIREGUARD_INGRESSES entry 1 id must be a proxy id, one lowercase DNS label";
        let public_key = |n: u8| {
            format!("WIREGUARD_INGRESSES entry {n} public key must be padded base64 for 32 bytes")
        };
        let endpoint =
            |n: u8, reason: &str| format!("WIREGUARD_INGRESSES entry {n} endpoint {reason}");
        let no_dns_host = "must have a DNS host or bracketed IPv6 address";
        for (invalid, refused) in [
            // Ids are unique; nothing else has to be.
            (
                format!("{good};p1={other}@b.example.test:2"),
                "WIREGUARD_INGRESSES entry 2 repeats the id of entry 1".to_owned(),
            ),
            (
                format!("{good};p2={k}@a.example.test:1;p2={k}@a.example.test:1"),
                "WIREGUARD_INGRESSES entry 3 repeats the id of entry 2".to_owned(),
            ),
            // An empty list, and a trailing or doubled separator.
            (";".to_owned(), malformed(1)),
            (format!("{good};"), malformed(2)),
            (format!(";{good}"), malformed(1)),
            (format!("{good};;p2={k}@a.example.test:1"), malformed(2)),
            // An entry without its `=` or its `@`.
            ("p1".to_owned(), malformed(1)),
            (format!("p1={k}"), malformed(1)),
            (format!("p1@{}a.example.test:1", &k[..43]), malformed(1)),
            // The id is one proxy id.
            (format!("={k}@a.example.test:1"), id.to_owned()),
            (format!("P1={k}@a.example.test:1"), id.to_owned()),
            (format!("p1.example={k}@a.example.test:1"), id.to_owned()),
            (format!("-p1={k}@a.example.test:1"), id.to_owned()),
            (
                format!("{}={k}@a.example.test:1", "a".repeat(64)),
                id.to_owned(),
            ),
            // The key is canonical padded base64 for 32 bytes.
            ("p1=bad@a.example.test:1".to_owned(), public_key(1)),
            (format!("p1={}@a.example.test:1", &k[..43]), public_key(1)),
            (format!("p1={k}=@a.example.test:1"), public_key(1)),
            (
                format!(
                    "p1={}@a.example.test:1",
                    base64::engine::general_purpose::STANDARD.encode([7; 31])
                ),
                public_key(1),
            ),
            (
                format!("p1=@a.example.test:1;p2={k}@a.example.test:1"),
                public_key(1),
            ),
            // One bad key among good entries is found by its position.
            (
                format!("{good};p2={k}@a.example.test:1;p3=bad@a.example.test:1"),
                public_key(3),
            ),
            // The endpoint is host:port, an IPv6 literal in brackets. Each
            // way of being wrong has its own message.
            (
                format!("p1={k}@wg.example.test:0"),
                endpoint(1, "must have a host and a nonzero port"),
            ),
            (
                format!("p1={k}@[not-v6]:51820"),
                endpoint(1, "has an invalid IPv6 address"),
            ),
            (
                format!("p1={k}@[2001:db8::1:51820"),
                endpoint(1, "has an unterminated IPv6 literal"),
            ),
            (
                format!("p1={k}@[2001:db8::1]"),
                endpoint(1, "must have a port"),
            ),
            (
                format!("p1={k}@example.test:65536"),
                endpoint(1, "must have a numeric port"),
            ),
            (
                format!("p1={k}@example.test"),
                endpoint(1, "must be host:port"),
            ),
            (format!("p1={k}@"), endpoint(1, "must be host:port")),
            (
                format!("p1={k}@2001:db8::1:51820"),
                endpoint(1, no_dns_host),
            ),
            (
                format!("p1={k}@user@example.test:51820"),
                endpoint(1, no_dns_host),
            ),
            (format!("p1={k}@:51820"), endpoint(1, no_dns_host)),
            (
                format!("p1={k}@wg.example.test.:51820"),
                endpoint(1, no_dns_host),
            ),
            // The second entry is checked like the first.
            (
                format!("{good};p2={k}@b.example.test"),
                endpoint(2, "must be host:port"),
            ),
        ] {
            assert_eq!(
                refusal("WIREGUARD_INGRESSES", &invalid),
                refused,
                "{invalid}"
            );
        }
    }

    #[test]
    fn wireguard_config_refuses_invalid_addresses_and_routing_policy() {
        for (name, invalid, reason) in [
            // Every ingress address is inside the allowed CIDRs.
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.8.0.1",
                "outside WIREGUARD_ALLOWED_IPS",
            ),
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.7.0.1,fd00:8::1",
                "outside WIREGUARD_ALLOWED_IPS",
            ),
            (
                "WIREGUARD_ALLOWED_IPS",
                "10.7.0.0/24",
                "outside WIREGUARD_ALLOWED_IPS",
            ),
            // At most one address per family.
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.7.0.1,10.7.0.2",
                "at most one IPv4 and one IPv6",
            ),
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "fd00:7::1,10.7.0.1,fd00:7::2",
                "at most one IPv4 and one IPv6",
            ),
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.7.0.1,10.7.0.1",
                "at most one IPv4 and one IPv6",
            ),
            // Addresses, not names or prefixes, and no empty item.
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "not-an-ip",
                "comma-separated IP addresses",
            ),
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.7.0.1/32",
                "comma-separated IP addresses",
            ),
            (
                "WIREGUARD_INGRESS_ADDRESSES",
                "10.7.0.1,",
                "comma-separated IP addresses",
            ),
            (
                "WIREGUARD_ALLOWED_IPS",
                "10.7.0.0/33",
                "comma-separated CIDRs",
            ),
            ("WIREGUARD_ALLOWED_IPS", "10.7.0.1", "comma-separated CIDRs"),
            (
                "WIREGUARD_PERSISTENT_KEEPALIVE",
                "65536",
                "seconds in 0..=65535",
            ),
            (
                "WIREGUARD_PERSISTENT_KEEPALIVE",
                "on",
                "seconds in 0..=65535",
            ),
        ] {
            let error = refusal(name, invalid);
            assert!(error.contains(name), "{name}={invalid}: {error}");
            assert!(error.contains(reason), "{name}={invalid}: {error}");
        }
    }

    #[test]
    fn wireguard_config_refuses_the_single_ingress_names_in_one_message() {
        let refused = |names: &str| format!("{names} must be unset: {SINGLE_INGRESS_REPLACEMENT}");
        for name in SINGLE_INGRESS_VARS {
            // Refused beside a complete list, and alone: a deployment that
            // sets only these must not start with enrollment off.
            for mut values in [vars(), BTreeMap::new()] {
                values.insert(name.into(), "p1".into());
                let error = parse(&values).unwrap_err().to_string();
                assert_eq!(error, refused(name));
            }
        }
        // Every one that is set is named at once, so one failed start
        // tells the operator all of them, and no value is printed.
        let set = |names: &[&str]| -> BTreeMap<String, String> {
            names
                .iter()
                .map(|name| ((*name).to_owned(), "a-value".to_owned()))
                .collect()
        };
        let error = parse(&set(&SINGLE_INGRESS_VARS)).unwrap_err().to_string();
        assert_eq!(
            error,
            refused("WIREGUARD_HOST_ID, WIREGUARD_ENDPOINT, WIREGUARD_PUBLIC_KEY, WIREGUARD_HOSTS")
        );
        // A blank one is unset, and is not named.
        let mut values = set(&["WIREGUARD_HOSTS", "WIREGUARD_ENDPOINT"]);
        values.insert("WIREGUARD_HOST_ID".into(), " ".into());
        let error = parse(&values).unwrap_err().to_string();
        assert_eq!(error, refused("WIREGUARD_ENDPOINT, WIREGUARD_HOSTS"));
        // The message says what to write instead.
        for name in [
            "WIREGUARD_INGRESSES",
            "id=public_key@endpoint",
            "DEVSERVER_PROXY_ID",
            "WIREGUARD_INGRESS_ADDRESSES",
        ] {
            assert!(SINGLE_INGRESS_REPLACEMENT.contains(name), "{name}");
        }
    }

    #[test]
    fn derived_host_names_are_the_node_base_and_tenant_names_identity_mints() {
        for apex in [
            "https://proxy.example.test",
            "https://proxy.example.test:8443",
            "http://proxy.localtest.me:7002",
        ] {
            let cfg = test_config(apex);
            let enrollment = parse_at(&vars(), "https://gw.example.test", apex)
                .unwrap()
                .unwrap();
            // The base origin a node reports: the apex's scheme and port
            // around a host one label below the apex's.
            let base_at = |host: &str| {
                let mut base = cfg.devserver_proxy_origin.clone();
                base.set_host(Some(host)).unwrap();
                base.to_string()
            };
            for route in enrollment.ingresses() {
                let id = &route.ingress.id;
                let [node, wildcard] = &route.hosts[..] else {
                    panic!("{id}: {:?}", route.hosts);
                };
                // The derived node name is the host of the one base origin
                // identity accepts for this proxy id, and the map holds no
                // name but it and the names below it.
                let base = base_at(&node.name);
                let accepted = cfg
                    .validate_node_base(&base, id)
                    .unwrap_or_else(|error| panic!("{apex} {id}: {error}"));
                assert_eq!(accepted.host_str(), Some(node.name.as_str()));
                // A tenant origin minted from that base is one label below
                // it, which is the name the wildcard entry carries.
                let tenant = cfg
                    .tenant_origin_for("Alice", "0123456789ABCDEF", id, &base)
                    .unwrap();
                let tenant_host = tenant.authority.split(':').next().unwrap();
                assert_eq!(
                    tenant_host.split_once('.'),
                    Some(("alice--0123456789ab", node.name.as_str()))
                );
                assert_eq!(wildcard.name, format!("*.{}", node.name));
            }
        }
    }

    #[test]
    fn origins_are_read_from_the_variables_they_are_named_after() {
        // Each variable answers an origin that spells its own name.
        let named = |name: &str| -> anyhow::Result<Url> {
            let host = name.to_ascii_lowercase().replace('_', "-");
            Ok(format!("https://{host}.example.test").parse()?)
        };
        let origins = Origins::read(named).unwrap();
        assert_eq!(origins.base_url.as_str(), "https://base-url.example.test/");
        assert_eq!(
            origins.devserver_proxy_origin.as_str(),
            "https://devserver-proxy-origin.example.test/"
        );
        assert_eq!(
            origins.devserver_tunnel_origin.as_str(),
            "https://devserver-tunnel-origin.example.test/"
        );

        // The enrollment read with them builds its node names under the
        // origin of DEVSERVER_PROXY_ORIGIN, not under identity's.
        let vars = vars();
        let cfg = wireguard_from_vars(|name| vars.get(name).cloned(), &origins)
            .unwrap()
            .unwrap();
        assert_eq!(
            cfg.ingresses()[0].hosts[0].name,
            "p1.devserver-proxy-origin.example.test"
        );

        // A variable that cannot be read fails the whole read, naming it.
        for missing in [
            "BASE_URL",
            "DEVSERVER_PROXY_ORIGIN",
            "DEVSERVER_TUNNEL_ORIGIN",
        ] {
            let error = Origins::read(|name| {
                anyhow::ensure!(name != missing, "{name} is required");
                named(name)
            })
            .err()
            .map(|error| error.to_string());
            assert_eq!(error, Some(format!("{missing} is required")));
        }
    }

    #[test]
    fn wireguard_config_derives_node_names_from_the_proxy_origin_host() {
        // The apex's port is no part of a name.
        let cfg = parse_at(
            &vars(),
            "https://gw.example.test",
            "https://proxy.example.test:8443",
        )
        .unwrap()
        .unwrap();
        assert_eq!(cfg.ingresses()[1].hosts[0].name, "p2.proxy.example.test");
        assert_eq!(cfg.ingresses()[1].hosts[1].name, "*.p2.proxy.example.test");

        // An address literal has no names below it.
        for proxy in ["http://127.0.0.1:7002", "http://[::1]:7002"] {
            let error = parse_at(&vars(), "https://gw.example.test", proxy)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("DEVSERVER_PROXY_ORIGIN must have a DNS host"),
                "{error}"
            );
        }
        // A host no node name can be built under is refused once, as a
        // fault of the apex and not of an id: each label is a plain one.
        for proxy in [
            "https://proxy_apex.example.test".to_owned(),
            "https://proxy.example.test.".to_owned(),
            format!("https://{}.example.test", "a".repeat(64)),
        ] {
            let error = parse_at(&vars(), "https://gw.example.test", &proxy)
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                "DEVSERVER_PROXY_ORIGIN's host must be a DNS name of plain labels (letters, \
                 digits and inner hyphens, at most 63 bytes each, no trailing dot) when \
                 WireGuard enrollment is configured",
                "{proxy}"
            );
        }
        // Identity's own name is never one an ingress carries, and the
        // refusal says which entry's node it is at or below.
        for (identity, entry) in [
            ("https://p1.proxy.example.test", 1),
            ("https://gw.p2.proxy.example.test", 2),
            ("https://a.b.p1.proxy.example.test", 1),
        ] {
            let error = parse_at(&vars(), identity, "https://proxy.example.test")
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                format!(
                    "BASE_URL's host must not be the node name of WIREGUARD_INGRESSES entry \
                     {entry} or a name below it"
                ),
                "{identity}"
            );
        }
        // Beside the nodes, at the apex, or under a node that is no
        // ingress, it is outside every host map.
        for identity in [
            "https://gw.proxy.example.test",
            "https://proxy.example.test",
            "https://gw.p3.proxy.example.test",
            "https://xp1.proxy.example.test",
        ] {
            parse_at(&vars(), identity, "https://proxy.example.test")
                .unwrap_or_else(|error| panic!("{identity}: {error}"))
                .unwrap();
        }
    }
}
