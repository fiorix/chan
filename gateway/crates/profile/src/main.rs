use std::process::ExitCode;

use profile::{config::Config, db, http};
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
        tracing::error!(error = ?e, "profile-service exited with error");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

async fn run() -> anyhow::Result<()> {
    if MigrationMode::from_env()? == MigrationMode::Only {
        return run_migrations().await;
    }

    let cfg = Config::from_env()?;
    tracing::info!(bind = %cfg.bind_addr, "starting profile-service");

    let pool = db::connect(&cfg.database_url).await?;

    if let Some(retention) = cfg.devserver_retention {
        tracing::info!(
            retention_secs = retention.as_secs(),
            "devserver registry sweeper enabled"
        );
    } else {
        tracing::info!("devserver registry sweeper disabled by DEVSERVER_RETENTION_MINUTES=0");
    }

    let listener = tokio::net::TcpListener::bind(cfg.bind_addr).await?;
    http::serve(
        listener,
        http::AppState {
            pool,
            auth_token: cfg.auth_token.clone(),
            admin_token: cfg.admin_token.clone(),
        },
        cfg.workspace_admin.clone(),
        cfg.devserver_retention,
        gateway_common::shutdown_signal(),
    )
    .await?;
    tracing::info!("profile-service stopped");
    Ok(())
}

async fn run_migrations() -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("DATABASE_URL is required in migration-only mode"))?;
    tracing::info!("running profile database migrations");
    let pool = db::connect(&database_url).await?;
    db::migrate(&pool).await?;
    tracing::info!("profile database migrations complete");
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
            Some("external "),
            Some("ONLY"),
        ] {
            assert!(MigrationMode::parse(value).is_err(), "accepted {value:?}");
        }
    }
}
