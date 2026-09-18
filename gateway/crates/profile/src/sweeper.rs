//! Devserver registry sweeper.
//!
//! Identity registers one `devservers` row per tunnel-scope PAT (the
//! devserver id is the SHA-256 of the raw token), and revoking or
//! rotating a PAT deletes no `devservers` row, so without a sweep the dashboard
//! would list every devserver ever registered. The sweeper keeps the
//! registry honest: each tick stamps `last_seen_at` on the rows that
//! are live right now (devserver-control's aggregate tunnel snapshot)
//! and deletes rows offline longer than the configured retention,
//! where offline age is `now() - COALESCE(last_seen_at, created_at)`.
//!
//! Fail-safe rule (load-bearing, test-pinned): a tick that cannot
//! fetch the live-tunnel snapshot marks and deletes NOTHING. Marking
//! runs strictly before deletion inside a tick, so rows only age
//! toward deletion while ticks are succeeding -- a devserver-control
//! outage longer than the retention cannot wipe a live registry.
//!
//! Authorization invariant: rows carrying grants are never swept. Each grant
//! must be removed through the exact session-revocation settlement path before
//! its parent becomes eligible. A swept devserver that redials announces its display name in the
//! tunnel `Hello`, and identity's validate exchange recreates the row
//! with that label on the spot. A client that announces no name shows up live-unlabeled on the owner's dashboard (the live list comes from devserver-control's aggregate); a grant create recreates its row but leaves it unlabeled, and only a later dial that announces a name labels it. The owner's own entry and open flow never break: owner-side access checks never read the `devservers` table.
//!
//! Fleet coverage: the snapshot is devserver-control's cluster-wide
//! aggregate, so registrations on every connected proxy count as live.
//!
//! The loop runs detached for the life of the process (spawned from
//! `run()` in main before serve); process shutdown is its cancellation
//! path.

use std::time::Duration;

use gateway_common::devserver_control_client::DevserverControlClient;
use sqlx::postgres::PgPool;
use uuid::Uuid;

/// What one sweep did: live rows stamped and stale, unshared rows deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweepStats {
    pub marked: u64,
    pub deleted: u64,
}

/// One mark-then-delete pass. `live` is the full live-tunnel snapshot
/// as `(owner_user_id, devserver_id)` pairs. The caller owns the fail-safe
/// rule: only call this with a snapshot that fetched successfully.
pub async fn sweep_once(
    pool: &PgPool,
    live: &[(Uuid, String)],
    retention: Duration,
) -> sqlx::Result<SweepStats> {
    let owner_user_ids: Vec<Uuid> = live.iter().map(|(owner, _)| *owner).collect();
    let devserver_ids: Vec<String> = live.iter().map(|(_, d)| d.clone()).collect();

    // Mark strictly before delete: a row live in this snapshot must not
    // be deletable by this same tick. The controller reports owners by
    // immutable owner id, matching the registry primary authority directly.
    let marked = sqlx::query(
        "UPDATE devservers AS d SET last_seen_at = now() \
         FROM UNNEST($1::uuid[], $2::text[]) AS live(owner_user_id, devserver_id) \
         WHERE d.owner_user_id = live.owner_user_id AND d.devserver_id = live.devserver_id",
    )
    .bind(&owner_user_ids)
    .bind(&devserver_ids)
    .execute(pool)
    .await?
    .rows_affected();

    let deleted: Vec<String> = sqlx::query_scalar(
        "DELETE FROM devservers d \
         WHERE COALESCE(last_seen_at, created_at) < now() - make_interval(secs => $1) \
           AND NOT EXISTS (SELECT 1 FROM devserver_grants g \
                           WHERE g.owner_user_id = d.owner_user_id \
                             AND g.devserver_id = d.devserver_id) \
         RETURNING devserver_id",
    )
    .bind(retention.as_secs_f64())
    .fetch_all(pool)
    .await?;

    if !deleted.is_empty() {
        tracing::info!(
            marked,
            deleted = deleted.len(),
            ids = ?deleted,
            "devserver registry sweep deleted stale unshared rows",
        );
    }
    Ok(SweepStats {
        marked,
        deleted: deleted.len() as u64,
    })
}

/// Sweep loop: one tick per minute, each tick gated on a SUCCESSFUL
/// `list_all_tunnels` fetch; any fetch error skips the whole tick.
pub async fn run(pool: PgPool, admin: DevserverControlClient, retention: Duration) {
    const TICK: Duration = Duration::from_secs(60);
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let snapshot = match admin.list_all_tunnels().await {
            Ok(tunnels) => tunnels,
            Err(err) => {
                tracing::warn!(error = %err, "sweeper: live-tunnel fetch failed; skipping tick");
                continue;
            }
        };
        let live: Vec<(Uuid, String)> = snapshot
            .into_iter()
            .map(|t| (t.owner_user_id, t.devserver_id))
            .collect();
        if let Err(err) = sweep_once(&pool, &live, retention).await {
            tracing::warn!(error = %err, "sweeper: sweep failed");
        }
    }
}
