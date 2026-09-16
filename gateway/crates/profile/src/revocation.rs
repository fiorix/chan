//! Durable second-cut settlement for authorization mutations.
//!
//! Postgres is the source of truth. The in-process worker only accelerates due
//! rows; a crash during the entry-credential quiet period leaves a resumable
//! outbox row for the next profile-service process.

use std::time::Duration;

use gateway_common::devserver_control_client::DevserverControlClient;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const MAX_CONCURRENCY: i64 = 8;
const CLAIM_LEASE_SECONDS: i64 = 15;
const RETRY_WINDOW_SECONDS: i64 = 5 * 60;
pub const SETTLEMENT_SECONDS: i64 = gateway_common::devserver_gate::ENTRY_LIFETIME_SECONDS
    + 2 * gateway_common::devserver_gate::ENTRY_CLOCK_SKEW_SECONDS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevocationJob {
    Subject(Uuid),
    Exact {
        subject_user_id: Uuid,
        owner_user_id: Uuid,
        devserver_id: String,
    },
    AccountDelete(Uuid),
}

impl RevocationJob {
    fn subject_user_id(&self) -> Uuid {
        match self {
            Self::Subject(id) | Self::AccountDelete(id) => *id,
            Self::Exact {
                subject_user_id, ..
            } => *subject_user_id,
        }
    }

    fn key(&self) -> String {
        match self {
            Self::Subject(id) | Self::AccountDelete(id) => format!("subject:{id}"),
            Self::Exact {
                subject_user_id,
                owner_user_id,
                devserver_id,
            } => format!("exact:{subject_user_id}:{owner_user_id}:{devserver_id}"),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Subject(_) => "subject",
            Self::Exact { .. } => "exact",
            Self::AccountDelete(_) => "account_delete",
        }
    }

    fn owner_and_devserver(&self) -> (Option<Uuid>, Option<&str>) {
        match self {
            Self::Exact {
                owner_user_id,
                devserver_id,
                ..
            } => (Some(*owner_user_id), Some(devserver_id)),
            _ => (None, None),
        }
    }
}

/// Start the durable revocation worker: one `process_once` pass per second
/// that claims due outbox rows and drives their cuts through `client`. The
/// loop runs detached for the life of the process; process shutdown is its
/// cancellation path, and a row it was mid-way through is resumed by the
/// next process from the outbox.
pub fn spawn_worker(pool: PgPool, client: DevserverControlClient) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(pool, client))
}

/// Reserve a durable job in the caller's denial transaction. Every generation
/// starts in `pending_first_cut`; no pre-commit timestamp can count toward the
/// quiet window. The worker records the first confirmed post-commit cut and
/// only then starts settlement timing.
pub async fn reserve_tx(
    tx: &mut Transaction<'_, Postgres>,
    job: &RevocationJob,
) -> sqlx::Result<()> {
    let subject = job.subject_user_id();
    if !matches!(job, RevocationJob::Exact { .. }) {
        sqlx::query(
            "DELETE FROM control_revocation_jobs \
             WHERE subject_user_id = $1 AND kind = 'exact'",
        )
        .bind(subject)
        .execute(&mut **tx)
        .await?;
    } else {
        let subject_key = format!("subject:{subject}");
        let broader = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM control_revocation_jobs WHERE job_key = $1)",
        )
        .bind(&subject_key)
        .fetch_one(&mut **tx)
        .await?;
        if broader {
            extend_existing(tx, &subject_key).await?;
            return Ok(());
        }
    }

    let (owner, devserver) = job.owner_and_devserver();
    sqlx::query(
        "INSERT INTO control_revocation_jobs \
         (job_key, kind, subject_user_id, owner_user_id, devserver_id, next_attempt_at) \
         VALUES ($1, $2, $3, $4, $5, now()) \
         ON CONFLICT (job_key) DO UPDATE SET \
           kind = CASE \
             WHEN control_revocation_jobs.kind = 'account_delete' OR EXCLUDED.kind = 'account_delete' \
             THEN 'account_delete' ELSE EXCLUDED.kind END, \
           phase = 'pending_first_cut', first_cut_confirmed_at = NULL, \
           settle_not_before = NULL, deadline = NULL, \
           next_attempt_at = now(), attempts = 0, \
           generation = control_revocation_jobs.generation + 1, \
           updated_at = now()",
    )
    .bind(job.key())
    .bind(job.kind())
    .bind(subject)
    .bind(owner)
    .bind(devserver)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn extend_existing(tx: &mut Transaction<'_, Postgres>, key: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE control_revocation_jobs SET \
           phase = 'pending_first_cut', first_cut_confirmed_at = NULL, \
           settle_not_before = NULL, deadline = NULL, next_attempt_at = now(), \
           attempts = 0, generation = generation + 1, updated_at = now() \
         WHERE job_key = $1",
    )
    .bind(key)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn reserve(pool: &PgPool, job: &RevocationJob) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    reserve_tx(&mut tx, job).await?;
    tx.commit().await
}

#[derive(Debug, sqlx::FromRow)]
struct JobRow {
    job_key: String,
    kind: String,
    subject_user_id: Uuid,
    owner_user_id: Option<Uuid>,
    devserver_id: Option<String>,
    phase: String,
    attempts: i32,
    generation: i64,
    settlement_due: bool,
    deadline_elapsed: bool,
}

impl JobRow {
    fn job(&self) -> anyhow::Result<RevocationJob> {
        match self.kind.as_str() {
            "subject" => Ok(RevocationJob::Subject(self.subject_user_id)),
            "account_delete" => Ok(RevocationJob::AccountDelete(self.subject_user_id)),
            "exact" => Ok(RevocationJob::Exact {
                subject_user_id: self.subject_user_id,
                owner_user_id: self
                    .owner_user_id
                    .ok_or_else(|| anyhow::anyhow!("exact job missing owner"))?,
                devserver_id: self
                    .devserver_id
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("exact job missing devserver"))?,
            }),
            kind => anyhow::bail!("unknown revocation job kind {kind}"),
        }
    }
}

async fn run(pool: PgPool, client: DevserverControlClient) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if let Err(error) = process_once(&pool, &client).await {
            tracing::error!(?error, "durable revocation worker tick failed");
        }
    }
}

pub async fn process_once(pool: &PgPool, client: &DevserverControlClient) -> sqlx::Result<usize> {
    let jobs = sqlx::query_as::<_, JobRow>(
        "WITH due AS ( \
           SELECT job_key FROM control_revocation_jobs \
           WHERE next_attempt_at <= now() \
           ORDER BY next_attempt_at, job_key \
           LIMIT $1 FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE control_revocation_jobs j SET \
           deadline = COALESCE(deadline, now() + make_interval(secs => $3)), \
           next_attempt_at = now() + make_interval(secs => $2), updated_at = now() \
         FROM due WHERE j.job_key = due.job_key \
         RETURNING j.job_key, j.kind, j.subject_user_id, j.owner_user_id, \
                   j.devserver_id, j.phase, j.attempts, j.generation, \
                   (j.phase = 'settling' AND j.settle_not_before <= now()) AS settlement_due, \
                   (j.deadline <= now()) AS deadline_elapsed",
    )
    .bind(MAX_CONCURRENCY)
    .bind(CLAIM_LEASE_SECONDS as f64)
    .bind(RETRY_WINDOW_SECONDS as f64)
    .fetch_all(pool)
    .await?;
    let count = jobs.len();
    let mut tasks = tokio::task::JoinSet::new();
    for row in jobs {
        let pool = pool.clone();
        let client = client.clone();
        tasks.spawn(async move { process_job(&pool, &client, row).await });
    }
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::error!(?error, "durable revocation job update failed"),
            Err(error) => tracing::error!(?error, "durable revocation task failed"),
        }
    }
    Ok(count)
}

async fn attempt(client: &DevserverControlClient, job: &RevocationJob) -> anyhow::Result<()> {
    let result = match job {
        RevocationJob::Subject(id) | RevocationJob::AccountDelete(id) => {
            let (kill, revoke) = tokio::join!(
                client.kill_owner_tunnels(*id),
                client.revoke_subject_sessions(*id),
            );
            kill?;
            revoke?
        }
        RevocationJob::Exact {
            subject_user_id,
            owner_user_id,
            devserver_id,
        } => {
            client
                .revoke_sessions_exact(*subject_user_id, *owner_user_id, devserver_id)
                .await?
        }
    };
    anyhow::ensure!(
        result.proxies_confirmed == result.proxies_expected,
        "session revocation confirmed by {}/{} proxies",
        result.proxies_confirmed,
        result.proxies_expected,
    );
    Ok(())
}

async fn process_job(
    pool: &PgPool,
    client: &DevserverControlClient,
    row: JobRow,
) -> sqlx::Result<()> {
    let job = match row.job() {
        Ok(job) => job,
        Err(error) => {
            tracing::error!(?error, key = %row.job_key, "invalid durable revocation job");
            return exhaust(pool, &row, "invalid durable job").await;
        }
    };
    match attempt(client, &job).await {
        Ok(()) if row.phase == "pending_first_cut" => {
            sqlx::query(
                "UPDATE control_revocation_jobs SET phase = 'settling', \
                 first_cut_confirmed_at = now(), \
                 settle_not_before = now() + make_interval(secs => $3), \
                 next_attempt_at = now() + make_interval(secs => $3), \
                 deadline = now() + make_interval(secs => $4), \
                 attempts = 0, updated_at = now() \
                 WHERE job_key = $1 AND generation = $2",
            )
            .bind(&row.job_key)
            .bind(row.generation)
            .bind(SETTLEMENT_SECONDS as f64)
            .bind((SETTLEMENT_SECONDS + RETRY_WINDOW_SECONDS) as f64)
            .execute(pool)
            .await?;
            Ok(())
        }
        Ok(()) if row.settlement_due => complete(pool, &row).await,
        Ok(()) => {
            sqlx::query(
                "UPDATE control_revocation_jobs SET next_attempt_at = settle_not_before, \
                 attempts = 0, updated_at = now() \
                 WHERE job_key = $1 AND generation = $2",
            )
            .bind(&row.job_key)
            .bind(row.generation)
            .execute(pool)
            .await?;
            Ok(())
        }
        Err(error) if row.deadline_elapsed => {
            tracing::error!(?error, key = %row.job_key, "durable revocation retry exhausted");
            exhaust(
                pool,
                &row,
                "data-plane revocation was not confirmed within five minutes",
            )
            .await
        }
        Err(error) => {
            tracing::warn!(?error, key = %row.job_key, "durable revocation attempt failed");
            let attempts = row.attempts.saturating_add(1);
            let delay = retry_delay(attempts);
            sqlx::query(
                "UPDATE control_revocation_jobs SET attempts = $2, \
                 next_attempt_at = LEAST(now() + make_interval(secs => $3), deadline), \
                 updated_at = now() WHERE job_key = $1 AND generation = $4",
            )
            .bind(&row.job_key)
            .bind(attempts)
            .bind(delay.as_secs_f64())
            .bind(row.generation)
            .execute(pool)
            .await?;
            Ok(())
        }
    }
}

async fn complete(pool: &PgPool, row: &JobRow) -> sqlx::Result<()> {
    if row.kind == "account_delete" {
        let mut tx = pool.begin().await?;
        let current = sqlx::query_scalar::<_, String>(
            "SELECT job_key FROM control_revocation_jobs \
             WHERE job_key = $1 AND generation = $2 AND settle_not_before <= now() \
             FOR UPDATE",
        )
        .bind(&row.job_key)
        .bind(row.generation)
        .fetch_optional(&mut *tx)
        .await?;
        if current.is_none() {
            tx.rollback().await?;
            return Ok(());
        }
        // Ordering only: this account-owned row is removed by the user cascade
        // and is not represented as a durable post-delete audit claim.
        sqlx::query(
            "INSERT INTO auth_audit (user_id, action, note) \
             VALUES ($1, 'account_delete_confirmed', 'data-plane settlement confirmed')",
        )
        .bind(row.subject_user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(row.subject_user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    } else {
        sqlx::query("DELETE FROM control_revocation_jobs WHERE job_key = $1 AND generation = $2")
            .bind(&row.job_key)
            .bind(row.generation)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn exhaust(pool: &PgPool, row: &JobRow, note: &str) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let current = sqlx::query_scalar::<_, String>(
        "SELECT job_key FROM control_revocation_jobs \
         WHERE job_key = $1 AND generation = $2 FOR UPDATE",
    )
    .bind(&row.job_key)
    .bind(row.generation)
    .fetch_optional(&mut *tx)
    .await?;
    if current.is_none() {
        tx.rollback().await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO auth_audit (user_id, action, note) \
         VALUES ($1, 'session_revoke_failed', $2)",
    )
    .bind(row.subject_user_id)
    .bind(note)
    .execute(&mut *tx)
    .await?;
    if row.kind == "account_delete" {
        // Retain the deletion intent and unblock guard across control outages.
        // A new generation fences out workers holding the exhausted claim.
        sqlx::query(
            "UPDATE control_revocation_jobs SET phase = 'pending_first_cut', \
             first_cut_confirmed_at = NULL, settle_not_before = NULL, deadline = NULL, \
             attempts = 0, next_attempt_at = now() + make_interval(secs => $3), \
             generation = generation + 1, updated_at = now() \
             WHERE job_key = $1 AND generation = $2",
        )
        .bind(&row.job_key)
        .bind(row.generation)
        .bind(retry_delay(row.attempts.saturating_add(1)).as_secs_f64())
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("DELETE FROM control_revocation_jobs WHERE job_key = $1 AND generation = $2")
            .bind(&row.job_key)
            .bind(row.generation)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

fn retry_delay(attempt: i32) -> Duration {
    const BACKOFF: [u64; 8] = [1, 2, 5, 10, 20, 30, 60, 60];
    Duration::from_secs(BACKOFF[(attempt as usize).saturating_sub(1).min(BACKOFF.len() - 1)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_window_covers_lifetime_and_symmetric_skew() {
        assert_eq!(SETTLEMENT_SECONDS, 40);
    }
}
