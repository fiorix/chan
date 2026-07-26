use std::process::ExitCode;
use std::sync::Arc;

use identity::{api_tokens::ApiTokenService, config::Config, http, token_throttle::TokenThrottle};
use sqlx::postgres::PgPoolOptions;
use tower_sessions_sqlx_store::PostgresStore;
use tracing_subscriber::EnvFilter;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MigrationMode {
    Only,
    External,
}

impl MigrationMode {
    fn parse(raw: Option<&str>) -> anyhow::Result<Self> {
        match raw {
            Some("only") => Ok(Self::Only),
            Some("external") => Ok(Self::External),
            Some(value) => anyhow::bail!(
                "CHAN_GATEWAY_MIGRATIONS must be exactly `only` or `external`, got {value:?}"
            ),
            None => anyhow::bail!(
                "CHAN_GATEWAY_MIGRATIONS is required and must be `only` or `external`"
            ),
        }
    }

    fn from_env() -> anyhow::Result<Self> {
        match std::env::var("CHAN_GATEWAY_MIGRATIONS") {
            Ok(value) => Self::parse(Some(&value)),
            Err(std::env::VarError::NotPresent) => Self::parse(None),
            Err(std::env::VarError::NotUnicode(_)) => {
                anyhow::bail!("CHAN_GATEWAY_MIGRATIONS must be valid UTF-8")
            }
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    if let Err(e) = run().await {
        tracing::error!(error = ?e, "identity-service exited with error");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

async fn run() -> anyhow::Result<()> {
    if MigrationMode::from_env()? == MigrationMode::Only {
        return run_migrations().await;
    }

    let cfg = Config::from_env()?;
    let admission_signer = Config::admission_lease_signer_from_env()?;
    tracing::info!(
        public_bind = %cfg.bind_addr,
        internal_bind = %cfg.internal_bind_addr,
        base = %cfg.base_url,
        "starting identity-service"
    );

    // Keep the cap low so a shared Postgres (dev VM, lab cluster)
    // doesn't run out of non-superuser slots when several services
    // are running side by side.
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&cfg.database_url)
        .await?;

    let store = PostgresStore::new(pool.clone());

    let policy_required = match std::env::var("DEVSERVER_POLICY_REQUIRED")
        .unwrap_or_else(|_| "false".into())
        .as_str()
    {
        "true" => true,
        "false" => false,
        _ => anyhow::bail!("DEVSERVER_POLICY_REQUIRED must be true or false"),
    };
    let api_tokens = ApiTokenService::with_admission_signer(pool, admission_signer)
        .with_policy_required(policy_required);
    let token_throttle = TokenThrottle::new();

    let (public, internal) =
        http::routers(Arc::new(cfg.clone()), store, api_tokens, token_throttle);
    let public_listener = tokio::net::TcpListener::bind(cfg.bind_addr).await?;
    let internal_listener = tokio::net::TcpListener::bind(cfg.internal_bind_addr).await?;
    let shutdown = tokio_util::sync::CancellationToken::new();
    let shutdown_signal = shutdown.clone();
    tokio::spawn(async move {
        gateway_common::shutdown_signal().await;
        shutdown_signal.cancel();
    });

    let public_server = axum::serve(
        public_listener,
        public.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.clone().cancelled_owned());
    let internal_server = axum::serve(
        internal_listener,
        internal.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.cancelled_owned());
    tokio::try_join!(public_server, internal_server)?;
    Ok(())
}

async fn run_migrations() -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL is required in migration-only mode"))?;
    tracing::info!("running identity database migrations");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&database_url)
        .await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;
    PostgresStore::new(pool).migrate().await?;
    tracing::info!("identity database migrations complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MigrationMode, MigrationMode::*};

    #[test]
    fn migration_mode_accepts_only_exact_supported_values() {
        assert_eq!(MigrationMode::parse(Some("only")).unwrap(), Only);
        assert_eq!(MigrationMode::parse(Some("external")).unwrap(), External);
    }

    #[test]
    fn migration_mode_fails_closed() {
        for value in [
            None,
            Some(""),
            Some("auto"),
            Some(" external"),
            Some("ONLY"),
        ] {
            assert!(MigrationMode::parse(value).is_err(), "accepted {value:?}");
        }
    }
}
