//! Identity's database fixture, including the session store migration.

#[path = "pg.rs"]
pub(crate) mod pg;

use sqlx::PgPool;
use tower_sessions_sqlx_store::PostgresStore;

#[allow(
    dead_code,
    reason = "each integration test binary selects one migration order"
)]
pub(crate) enum MigrationOrder {
    SessionsFirst,
    GatewayFirst,
}

pub(crate) async fn create_schema(
    order: MigrationOrder,
) -> (String, String, PgPool, PostgresStore) {
    let (url, schema, pool) = pg::create_schema().await;
    let store = PostgresStore::new(pool.clone());
    match order {
        MigrationOrder::SessionsFirst => {
            store.migrate().await.expect("migrate sessions");
            pg::migrate(&pool).await;
        }
        MigrationOrder::GatewayFirst => {
            pg::migrate(&pool).await;
            store.migrate().await.expect("migrate sessions");
        }
    }
    (url, schema, pool, store)
}
