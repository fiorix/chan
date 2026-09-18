use sqlx::postgres::{PgPool, PgPoolOptions};

/// Connect with a small pool; profile-service is low-QPS, called
/// only by identity-service and the operator CLI. Keep the cap low so
/// a shared Postgres (dev VM, lab cluster) doesn't run out of non-superuser
/// slots when several services are running side by side.
pub async fn connect(url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await?;
    Ok(pool)
}

/// Run embedded migrations from `migrations/` at the workspace root.
/// Path is resolved at compile time, so the binary carries the SQL.
pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("../../migrations").run(pool).await?;
    Ok(())
}
