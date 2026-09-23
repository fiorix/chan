use std::net::SocketAddr;

use anyhow::Context;
use gateway_common::devserver_control_client::DevserverControlClient;
use url::Url;

/// Runtime config sourced from environment variables.
///
/// Keep the surface tiny: anything not in here is either a
/// compile-time choice or belongs in a future config file. Env-only
/// so deploys can override per-environment without baking secrets
/// into images.
#[derive(Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub auth_token: String,
    /// Bearer for the /v1/admin/* tree. Distinct from `auth_token`
    /// so admin access can be rotated without touching identity /
    /// devserver-proxy. Optional: when unset, the admin tree returns
    /// 401 for every request, which is the safe default.
    pub admin_token: Option<String>,
    /// Scope-specific controller client. Runtime startup fails closed when the
    /// URL or profile-scoped bearer is absent.
    pub workspace_admin: DevserverControlClient,
    /// Devserver registry sweeper retention, from
    /// `DEVSERVER_RETENTION_MINUTES`: rows offline longer than this are
    /// deleted. Absent or empty = 15 minutes; `0` = sweeping disabled
    /// (`None`); anything unparseable fails startup -- a typo must not
    /// silently pick a policy that deletes rows.
    pub devserver_retention: Option<std::time::Duration>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind_addr", &self.bind_addr)
            .field("database_url", &"[REDACTED]")
            .field("auth_token", &"[REDACTED]")
            .field(
                "admin_token",
                &self.admin_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("workspace_admin", &self.workspace_admin)
            .field("devserver_retention", &self.devserver_retention)
            .finish()
    }
}

/// Parse `DEVSERVER_RETENTION_MINUTES` (pre-filtered so empty is
/// `None` input, matching how the other optional envs treat empty).
fn parse_retention_minutes(raw: Option<&str>) -> anyhow::Result<Option<std::time::Duration>> {
    let Some(raw) = raw else {
        return Ok(Some(std::time::Duration::from_secs(15 * 60)));
    };
    let minutes: u64 = raw.trim().parse().with_context(|| {
        format!("DEVSERVER_RETENTION_MINUTES must be a whole number of minutes (0 disables), got {raw:?}")
    })?;
    let seconds = minutes
        .checked_mul(60)
        .context("DEVSERVER_RETENTION_MINUTES is out of range")?;
    Ok((seconds > 0).then(|| std::time::Duration::from_secs(seconds)))
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind_addr: SocketAddr = std::env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:7001".to_string())
            .parse()
            .context("BIND_ADDR must be host:port")?;
        gateway_common::internal_transport::require_protected_listener("BIND_ADDR", bind_addr)?;

        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        let auth_token =
            std::env::var("PROFILE_AUTH_TOKEN").context("PROFILE_AUTH_TOKEN is required")?;
        if auth_token.is_empty() {
            anyhow::bail!("PROFILE_AUTH_TOKEN must not be empty");
        }

        let admin_token = std::env::var("PROFILE_ADMIN_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());

        let admin_url: Url = std::env::var("DEVSERVER_ADMIN_URL")
            .context("DEVSERVER_ADMIN_URL is required")?
            .parse()
            .context("DEVSERVER_ADMIN_URL must be a URL")?;
        gateway_common::internal_transport::require_protected_http_url(
            "DEVSERVER_ADMIN_URL",
            &admin_url,
        )?;
        let profile_admin_token = std::env::var("DEVSERVER_PROFILE_ADMIN_TOKEN")
            .context("DEVSERVER_PROFILE_ADMIN_TOKEN is required")?;
        if profile_admin_token.is_empty() {
            anyhow::bail!("DEVSERVER_PROFILE_ADMIN_TOKEN must not be empty");
        }
        let workspace_admin = DevserverControlClient::new(admin_url, profile_admin_token)?;

        let devserver_retention = parse_retention_minutes(
            std::env::var("DEVSERVER_RETENTION_MINUTES")
                .ok()
                .filter(|s| !s.is_empty())
                .as_deref(),
        )?;

        Ok(Self {
            bind_addr,
            database_url,
            auth_token,
            admin_token,
            workspace_admin,
            devserver_retention,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_defaults_to_fifteen_minutes_when_absent() {
        let parsed = parse_retention_minutes(None).expect("absent parses");
        assert_eq!(parsed, Some(std::time::Duration::from_secs(15 * 60)));
    }

    #[test]
    fn retention_zero_disables_sweeping() {
        let parsed = parse_retention_minutes(Some("0")).expect("zero parses");
        assert_eq!(parsed, None);
        // Whitespace tolerated, value honored.
        let parsed = parse_retention_minutes(Some(" 45 ")).expect("45 parses");
        assert_eq!(parsed, Some(std::time::Duration::from_secs(45 * 60)));
    }

    #[test]
    fn retention_rejects_overflow_and_accepts_the_largest_duration() {
        let max_minutes = u64::MAX / 60;
        assert_eq!(
            parse_retention_minutes(Some(&max_minutes.to_string())).unwrap(),
            Some(std::time::Duration::from_secs(max_minutes * 60))
        );
        assert!(parse_retention_minutes(Some(&(max_minutes + 1).to_string())).is_err());
        assert!(parse_retention_minutes(Some(&u64::MAX.to_string())).is_err());
    }

    #[test]
    fn retention_garbage_fails_startup() {
        for garbage in ["abc", "-5", "1.5", "15m"] {
            assert!(
                parse_retention_minutes(Some(garbage)).is_err(),
                "{garbage:?} must bail rather than pick a deletion policy",
            );
        }
    }

    #[test]
    fn config_debug_redacts_database_and_bearers() {
        let cfg = Config {
            bind_addr: "127.0.0.1:7001".parse().unwrap(),
            database_url: "postgres://sentinel-db-secret".into(),
            auth_token: "sentinel-profile-auth".into(),
            admin_token: Some("sentinel-profile-admin".into()),
            workspace_admin: DevserverControlClient::new(
                "http://127.0.0.1:7003".parse().unwrap(),
                "sentinel-controller-token".into(),
            )
            .unwrap(),
            devserver_retention: None,
        };
        let debug = format!("{cfg:?}");
        for secret in [
            "sentinel-db-secret",
            "sentinel-profile-auth",
            "sentinel-profile-admin",
            "sentinel-controller-token",
        ] {
            assert!(!debug.contains(secret), "Debug leaked {secret}");
        }
        assert!(debug.contains("[REDACTED]"));
    }
}
