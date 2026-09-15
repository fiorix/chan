//! Process-wide reaper for leaked Postgres connections in test runs.
//!
//! Test binaries that open many per-test pools against the same
//! database role can run pg out of non-superuser connection slots:
//! sqlx pools don't always drop cleanly on cargo-test panic / abort,
//! so a flaky run leaves N idle connections behind under the same
//! role. Subsequent runs hit `PoolTimedOut` (sqlx's surfacing of
//! "remaining connection slots are reserved for roles with the
//! SUPERUSER attribute").
//!
//! Mitigation: hold one durable connection for the lifetime of the
//! test process. PG 13+ lets a non-superuser `pg_terminate_backend`
//! peer sessions owned by the same role, so the held connection can
//! reap idle leftovers from previous runs the first time it is
//! created. Once held, the connection is never dropped, so the role
//! never goes idle for this process either.
//!
//! Included by `pg.rs` through `#[path]` for each integration-test entry.
//! The shared files live outside any cargo-discovered tests directory so
//! cargo never tries to compile them on their own.
//!
//! Hard exhaustion is the one case this cannot recover. If even one
//! `chan` slot is unavailable at startup we cannot open the durable
//! connection and the reap query never runs; the caller will see a
//! clean panic and `docs/dev-setup.md` documents the manual reap.

use std::time::Duration;

use sqlx::{Connection, PgConnection};
use tokio::sync::OnceCell;

/// Held durable connection, lazily initialised on the first
/// `reap_idle` call. Wrapped in `OnceCell` so init is async-safe
/// across parallel test tasks; the inner `Option` is `None` while
/// init is in flight and `Some(_)` once a connection lands.
static HELD: OnceCell<HeldConn> = OnceCell::const_new();

struct HeldConn {
    // We never read from `_conn` -- its job is to keep the underlying
    // TCP session alive (and therefore one PG backend pinned) for
    // the lifetime of the test process. Naming with a leading
    // underscore so rustc / clippy don't flag the unused-field.
    _conn: tokio::sync::Mutex<PgConnection>,
}

/// Open one durable connection (if not already held) and terminate
/// every other peer session for `current_user` that is idle. Cheap
/// no-op on every subsequent call.
///
/// Panics on hard exhaustion (cannot get any connection within the
/// retry budget). The panic message points operators at the manual
/// reap recipe in `docs/dev-setup.md`.
pub async fn reap_idle(database_url: &str) {
    HELD.get_or_init(|| async {
        let url = database_url.to_string();
        let conn = open_with_retries(&url).await;
        // Best-effort reap. Failure here is non-fatal: even if the
        // reap query errors, the held connection still raises the
        // floor by one slot for the rest of the process.
        let mut held = conn;
        if let Err(e) = sqlx::query(
            "SELECT pg_terminate_backend(pid) \
             FROM pg_stat_activity \
             WHERE usename = current_user \
               AND pid <> pg_backend_pid() \
               AND state IN ('idle', 'idle in transaction')",
        )
        .execute(&mut held)
        .await
        {
            eprintln!("pg_reaper: best-effort reap query failed: {e}");
        }
        HeldConn {
            _conn: tokio::sync::Mutex::new(held),
        }
    })
    .await;
}

/// Bounded retry loop. PG slot pressure can clear briefly when a
/// dying socket gets RST'd; three attempts at 500ms intervals cover
/// that without making the happy path measurably slower.
async fn open_with_retries(database_url: &str) -> PgConnection {
    let mut last_err: Option<String> = None;
    for attempt in 0..3 {
        let connect = PgConnection::connect(database_url);
        match tokio::time::timeout(Duration::from_secs(2), connect).await {
            Ok(Ok(conn)) => return conn,
            Ok(Err(e)) => last_err = Some(format!("{e}")),
            Err(_) => last_err = Some("connect timed out after 2s".to_string()),
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    panic!(
        "pg_reaper: could not open a connection after 3 attempts: {}\n\
         postgres looks fully exhausted; manual reap recipe in \
         docs/dev-setup.md (Troubleshooting -> connection refused).",
        last_err.unwrap_or_else(|| "no error captured".to_string())
    );
}
