//! Schema-isolated Postgres fixtures shared by gateway integration tests.

#[path = "pg_reaper.rs"]
mod pg_reaper;

use sqlx::postgres::{PgPool, PgPoolOptions};
use uuid::Uuid;

/// Limit admin connections during parallel fixture setup and cleanup; the
/// default of ten per pool can exhaust Postgres's connection cap.
async fn admin_pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await
        .expect("connect admin")
}

pub(crate) async fn schema_pool(url: &str, schema: &str, max_connections: u32) -> PgPool {
    let schema = schema.to_string();
    PgPoolOptions::new()
        .max_connections(max_connections)
        .after_connect(move |conn, _meta| {
            let schema = schema.clone();
            Box::pin(async move {
                sqlx::query(&format!("SET search_path TO \"{schema}\", public"))
                    .execute(&mut *conn)
                    .await?;
                // Refuse a misdirected fixture before it can migrate or write public tables.
                let actual: String = sqlx::query_scalar("SELECT current_schema()")
                    .fetch_one(conn)
                    .await?;
                assert_eq!(actual, schema, "test connection must use its own schema");
                Ok(())
            })
        })
        .connect(url)
        .await
        .expect("connect schema pool")
}

pub(crate) async fn create_schema() -> (String, String, PgPool) {
    let url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must be set; e.g. postgres://localhost/chan_gateway_test");
    pg_reaper::reap_idle(&url).await;
    let schema = format!("t_{}", Uuid::new_v4().simple());
    let admin = admin_pool(&url).await;
    sqlx::query(&format!("CREATE SCHEMA \"{schema}\""))
        .execute(&admin)
        .await
        .expect("create schema");
    admin.close().await;
    let pool = schema_pool(&url, &schema, 4).await;
    (url, schema, pool)
}

pub(crate) async fn migrate(pool: &PgPool) {
    sqlx::migrate!("../../migrations")
        .run(pool)
        .await
        .expect("migrate gateway tables");
}

pub(crate) async fn drop_schema(url: &str, schema: &str) {
    let admin = admin_pool(url).await;
    sqlx::query(&format!("DROP SCHEMA \"{schema}\" CASCADE"))
        .execute(&admin)
        .await
        .expect("drop test schema");
    admin.close().await;
}
