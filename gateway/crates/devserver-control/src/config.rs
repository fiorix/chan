use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;

use anyhow::Context;
use devserver_control_proto::{AdmissionLeaseVerifier, ProxyId, ProxyOriginTemplate};
use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct ProxyCredentials(HashMap<ProxyId, Vec<Vec<u8>>>);

impl ProxyCredentials {
    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        let mut credentials: HashMap<ProxyId, Vec<Vec<u8>>> = HashMap::new();
        let mut all_tokens = std::collections::HashSet::new();
        for entry in raw.split(';') {
            let (id, token) = entry
                .split_once('=')
                .context("DEVSERVER_PROXY_CREDENTIALS entries must be proxy_id=token")?;
            let id = ProxyId::parse(id.trim()).context("invalid proxy id in credentials")?;
            if !valid_credential(token) {
                anyhow::bail!("proxy credential tokens must be 32..=256 printable bytes");
            }
            if !all_tokens.insert(token.as_bytes().to_vec()) {
                anyhow::bail!("a proxy credential token may belong to only one proxy id");
            }
            let tokens = credentials.entry(id).or_default();
            if tokens.len() >= 2 {
                anyhow::bail!("at most two rotation credentials are allowed per proxy id");
            }
            tokens.push(token.as_bytes().to_vec());
        }
        if credentials.is_empty() {
            anyhow::bail!("DEVSERVER_PROXY_CREDENTIALS must allowlist at least one proxy");
        }
        Ok(Self(credentials))
    }

    pub(crate) fn authenticate(&self, proxy_id: &ProxyId, provided: &[u8]) -> bool {
        self.0.get(proxy_id).is_some_and(|tokens| {
            tokens.iter().fold(false, |matched, expected| {
                matched | bool::from(expected.as_slice().ct_eq(provided))
            })
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminScope {
    Operator,
    Identity,
    Profile,
}

/// Validated, scope-separated controller credentials.
///
/// Raw strings cannot construct production credentials:
/// ```compile_fail
/// let credentials: devserver_control::AdminCredentials = String::new().into();
/// ```
#[derive(Clone)]
pub struct AdminCredentials {
    operator: Vec<Vec<u8>>,
    identity: Vec<Vec<u8>>,
    profile: Vec<Vec<u8>>,
}

impl AdminCredentials {
    fn from_env() -> anyhow::Result<Self> {
        let operator = parse_rotation("DEVSERVER_OPERATOR_ADMIN_TOKENS")?;
        let identity = parse_rotation("DEVSERVER_IDENTITY_ADMIN_TOKENS")?;
        let profile = parse_rotation("DEVSERVER_PROFILE_ADMIN_TOKENS")?;
        Self::from_rotations(operator, identity, profile)
    }

    fn from_rotations(
        operator: Vec<Vec<u8>>,
        identity: Vec<Vec<u8>>,
        profile: Vec<Vec<u8>>,
    ) -> anyhow::Result<Self> {
        let mut all = HashSet::new();
        for token in operator.iter().chain(&identity).chain(&profile) {
            if !all.insert(token.clone()) {
                anyhow::bail!("controller admin credentials may not be reused across scopes");
            }
        }
        Ok(Self {
            operator,
            identity,
            profile,
        })
    }

    pub(crate) fn authenticate(&self, provided: &[u8]) -> Option<AdminScope> {
        for (scope, tokens) in [
            (AdminScope::Operator, &self.operator),
            (AdminScope::Identity, &self.identity),
            (AdminScope::Profile, &self.profile),
        ] {
            if tokens.iter().fold(false, |matched, expected| {
                matched | bool::from(expected.as_slice().ct_eq(provided))
            }) {
                return Some(scope);
            }
        }
        None
    }

    #[cfg(test)]
    pub(crate) fn for_test(operator: &str, identity: &str, profile: &str) -> Self {
        Self {
            operator: vec![operator.as_bytes().to_vec()],
            identity: vec![identity.as_bytes().to_vec()],
            profile: vec![profile.as_bytes().to_vec()],
        }
    }
}

#[cfg(test)]
impl From<String> for AdminCredentials {
    fn from(token: String) -> Self {
        Self {
            operator: vec![token.into_bytes()],
            identity: Vec::new(),
            profile: Vec::new(),
        }
    }
}

fn parse_rotation(name: &str) -> anyhow::Result<Vec<Vec<u8>>> {
    let raw = required_secret(name)?;
    let tokens: Vec<_> = raw.split(';').collect();
    if tokens.is_empty() || tokens.len() > 2 {
        anyhow::bail!("{name} must contain one or two rotation credentials");
    }
    let mut unique = HashSet::new();
    for token in &tokens {
        if !valid_credential(token) {
            anyhow::bail!("{name} credentials must be 32..=256 printable bytes");
        }
        if !unique.insert(token.as_bytes()) {
            anyhow::bail!("{name} contains a duplicate rotation credential");
        }
    }
    Ok(tokens
        .into_iter()
        .map(|token| token.as_bytes().to_vec())
        .collect())
}

fn valid_credential(token: &str) -> bool {
    (32..=256).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_graphic())
}

#[derive(Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub proxy_bind_addr: SocketAddr,
    pub admin_credentials: AdminCredentials,
    pub proxy_credentials: ProxyCredentials,
    pub admission_lease_verifier: AdmissionLeaseVerifier,
    pub proxy_base_url_template: ProxyOriginTemplate,
    pub max_devservers_per_user: usize,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr = std::env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7003".into())
            .parse()
            .context("BIND_ADDR must be host:port")?;
        let proxy_bind_addr = std::env::var("PROXY_BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7101".into())
            .parse()
            .context("PROXY_BIND_ADDR must be host:port")?;
        let transport_mode = std::env::var("CHAN_GATEWAY_INTERNAL_TRANSPORT").ok();
        validate_listener_transport(bind_addr, proxy_bind_addr, transport_mode.as_deref())?;
        let admin_credentials = AdminCredentials::from_env()?;
        let proxy_credentials_raw = required_secret("DEVSERVER_PROXY_CREDENTIALS")?;
        let proxy_credentials = ProxyCredentials::parse(&proxy_credentials_raw)?;
        let verifying_keys = required_secret("DEVSERVER_ADMISSION_VERIFYING_KEYS")?;
        let admission_lease_verifier =
            AdmissionLeaseVerifier::from_base64_rotation(verifying_keys.trim()).context(
                "DEVSERVER_ADMISSION_VERIFYING_KEYS must contain one or two distinct canonical base64url 32-byte keys",
            )?;
        let template = std::env::var("DEVSERVER_PROXY_BASE_URL_TEMPLATE")
            .context("DEVSERVER_PROXY_BASE_URL_TEMPLATE is required")?;
        let proxy_base_url_template = ProxyOriginTemplate::parse(template.trim())
            .context("DEVSERVER_PROXY_BASE_URL_TEMPLATE is invalid")?;
        let max_devservers_per_user = parse_max_devservers_per_user(
            &std::env::var("MAX_DEVSERVERS_PER_USER").unwrap_or_else(|_| "100".into()),
        )?;
        Ok(Self {
            bind_addr,
            proxy_bind_addr,
            admin_credentials,
            proxy_credentials,
            admission_lease_verifier,
            proxy_base_url_template,
            max_devservers_per_user,
        })
    }
}

fn parse_max_devservers_per_user(raw: &str) -> anyhow::Result<usize> {
    let value = raw
        .trim()
        .parse()
        .context("MAX_DEVSERVERS_PER_USER must be a positive integer")?;
    if value == 0 {
        anyhow::bail!("MAX_DEVSERVERS_PER_USER must be greater than zero");
    }
    Ok(value)
}

fn validate_listener_transport(
    bind_addr: SocketAddr,
    proxy_bind_addr: SocketAddr,
    mode: Option<&str>,
) -> anyhow::Result<()> {
    gateway_common::internal_transport::require_protected_listener_with_mode(
        "BIND_ADDR",
        bind_addr,
        mode,
    )?;
    gateway_common::internal_transport::require_protected_listener_with_mode(
        "PROXY_BIND_ADDR",
        proxy_bind_addr,
        mode,
    )
}

fn required_secret(name: &str) -> anyhow::Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.is_empty() {
        anyhow::bail!("{name} must not be empty");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccc";

    #[test]
    fn proxy_credentials_are_long_scoped_and_rotation_bounded() {
        assert!(ProxyCredentials::parse("p1=short").is_err());
        let parsed = ProxyCredentials::parse(&format!("p1={A};p1={B};p2={C}")).unwrap();
        let p1 = ProxyId::parse("p1").unwrap();
        let p2 = ProxyId::parse("p2").unwrap();
        assert!(parsed.authenticate(&p1, A.as_bytes()));
        assert!(parsed.authenticate(&p1, B.as_bytes()));
        assert!(!parsed.authenticate(&p2, A.as_bytes()));
        assert!(parsed.authenticate(&p2, C.as_bytes()));
        assert!(ProxyCredentials::parse(&format!("p1={A};p1={B};p1={C}")).is_err());
        assert!(ProxyCredentials::parse(&format!("p1={A};p2={A}")).is_err());
        assert!(ProxyCredentials::parse(&format!("p1={A} ")).is_err());
        assert!(ProxyCredentials::parse(&format!("p1={} {}", &A[..16], &A[16..])).is_err());
    }

    #[test]
    fn admin_credentials_are_scope_isolated_and_rotation_bounded() {
        assert!(parse_rotation("THIS_ENV_DOES_NOT_EXIST_FOR_CHAN_TESTS").is_err());
        let credentials = AdminCredentials::from_rotations(
            vec![A.as_bytes().to_vec(), B.as_bytes().to_vec()],
            vec![C.as_bytes().to_vec()],
            vec![vec![b'd'; 32]],
        )
        .unwrap();
        assert_eq!(
            credentials.authenticate(A.as_bytes()),
            Some(AdminScope::Operator)
        );
        assert_eq!(
            credentials.authenticate(B.as_bytes()),
            Some(AdminScope::Operator)
        );
        assert_eq!(
            credentials.authenticate(C.as_bytes()),
            Some(AdminScope::Identity)
        );
        assert_eq!(
            credentials.authenticate(&[b'd'; 32]),
            Some(AdminScope::Profile)
        );
        assert!(AdminCredentials::from_rotations(
            vec![A.as_bytes().to_vec()],
            vec![A.as_bytes().to_vec()],
            vec![B.as_bytes().to_vec()],
        )
        .is_err());
    }

    #[test]
    fn controller_listeners_require_loopback_or_the_exact_protected_overlay() {
        let admin_loopback = "127.0.0.1:7003".parse().unwrap();
        let proxy_loopback = "[::1]:7101".parse().unwrap();
        let admin_public = "0.0.0.0:7003".parse().unwrap();
        let proxy_public = "10.0.0.5:7101".parse().unwrap();

        assert!(validate_listener_transport(admin_loopback, proxy_loopback, None).is_ok());
        assert!(validate_listener_transport(admin_public, proxy_loopback, None).is_err());
        assert!(validate_listener_transport(admin_loopback, proxy_public, None).is_err());
        assert!(validate_listener_transport(
            admin_public,
            proxy_public,
            Some(gateway_common::internal_transport::PROTECTED_OVERLAY),
        )
        .is_ok());
        assert!(
            validate_listener_transport(admin_public, proxy_public, Some("protected_overlay"),)
                .is_err()
        );
    }

    #[test]
    fn credentials_reject_ascii_whitespace_and_user_capacity_is_finite() {
        assert!(!valid_credential(&format!("{} {}", &A[..16], &A[16..])));
        assert!(!valid_credential(&format!("{}\t{}", &A[..16], &A[16..])));
        assert!(!valid_credential(&format!("{}💥{}", &A[..16], &A[16..])));
        assert_eq!(parse_max_devservers_per_user("100").unwrap(), 100);
        assert!(parse_max_devservers_per_user("0").is_err());
    }
}
