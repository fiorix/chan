//! Peer enrollment and per-host address allocation.

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use anyhow::Context;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use gateway_common::wireguard::{
    canonical_public_key, valid_host, ActivePeer, EnrolledPeer, PeerList,
};
use ipnet::{Ipv4Net, Ipv6Net};
use serde::Deserialize;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::http::AppState;
use crate::{Error, Result};

/// Allocation pools and explicit exclusions, shared by all ingress hosts.
#[derive(Clone, Debug)]
pub struct Pool {
    v4: Ipv4Net,
    v6: Option<Ipv6Net>,
    reserved: BTreeSet<IpAddr>,
}

/// Enrollment configuration and the delay before denied peers release addresses.
#[derive(Clone, Debug)]
pub struct Config {
    pub pool: Option<Pool>,
    pub release_grace: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pool: None,
            release_grace: Duration::from_secs(5 * 60),
        }
    }
}

impl Config {
    /// Parse the four `WIREGUARD_POOL_*` and release-grace environment values.
    pub fn parse(
        v4: Option<&str>,
        v6: Option<&str>,
        reserved: Option<&str>,
        grace: Option<&str>,
    ) -> anyhow::Result<Self> {
        fn nonempty(raw: Option<&str>) -> Option<&str> {
            raw.filter(|value| !value.trim().is_empty())
        }
        let v4 = nonempty(v4)
            .map(|value| value.trim().parse::<Ipv4Net>())
            .transpose()
            .context("WIREGUARD_POOL_V4 must be an IPv4 CIDR")?;
        let v6 = nonempty(v6)
            .map(|value| value.trim().parse::<Ipv6Net>())
            .transpose()
            .context("WIREGUARD_POOL_V6 must be an IPv6 CIDR")?;
        let reserved = nonempty(reserved)
            .map(|value| {
                value
                    .split(',')
                    .map(|address| address.trim().parse::<IpAddr>())
                    .collect::<std::result::Result<BTreeSet<_>, _>>()
            })
            .transpose()
            .context("WIREGUARD_POOL_RESERVED must contain comma-separated IP addresses")?
            .unwrap_or_default();
        if v4.is_none() && (v6.is_some() || !reserved.is_empty()) {
            anyhow::bail!("WIREGUARD_POOL_V4 is required when WIREGUARD_POOL_V6 or WIREGUARD_POOL_RESERVED is set");
        }
        let minutes: u64 = nonempty(grace)
            .unwrap_or("5")
            .trim()
            .parse()
            .context("WIREGUARD_RELEASE_GRACE_MINUTES must be a whole number of minutes")?;
        let seconds = minutes
            .checked_mul(60)
            .filter(|seconds| *seconds <= crate::sweeper::MAX_RETENTION.as_secs())
            .context("WIREGUARD_RELEASE_GRACE_MINUTES is out of range")?;
        Ok(Self {
            pool: v4.map(|v4| Pool { v4, v6, reserved }),
            release_grace: Duration::from_secs(seconds),
        })
    }
}

impl Pool {
    fn allocate(&self, occupied: &[(String, Option<String>)]) -> Result<(String, Option<String>)> {
        let mut used_v4 = BTreeSet::new();
        let mut used_v6 = BTreeSet::new();
        for address in &self.reserved {
            match address {
                IpAddr::V4(address) => {
                    used_v4.insert(u128::from(u32::from(*address)));
                }
                IpAddr::V6(address) => {
                    used_v6.insert(u128::from(*address));
                }
            }
        }
        for (v4, v6) in occupied {
            used_v4.insert(u128::from(u32::from(
                v4.parse::<Ipv4Addr>()
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
            )));
            if let Some(v6) = v6 {
                used_v6.insert(u128::from(
                    v6.parse::<Ipv6Addr>()
                        .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
                ));
            }
        }
        let exhausted = || Error::Conflict("wireguard pool exhausted");
        let start = u128::from(u32::from(self.v4.network())) + 2;
        let end = u128::from(u32::from(self.v4.broadcast()))
            .checked_sub(1)
            .ok_or_else(exhausted)?;
        let v4 = lowest_available(start, end, &used_v4).ok_or_else(exhausted)?;
        let v4 = Ipv4Addr::from(u32::try_from(v4).map_err(|_| exhausted())?).to_string();
        let v6 = self
            .v6
            .map(|network| {
                let start = u128::from(network.network())
                    .checked_add(2)
                    .ok_or_else(exhausted)?;
                let address = lowest_available(start, u128::from(network.broadcast()), &used_v6)
                    .ok_or_else(exhausted)?;
                Ok::<_, Error>(Ipv6Addr::from(address).to_string())
            })
            .transpose()?;
        Ok((v4, v6))
    }
}

fn lowest_available(start: u128, end: u128, used: &BTreeSet<u128>) -> Option<u128> {
    if start > end {
        return None;
    }
    let mut candidate = start;
    for occupied in used.range(start..=end) {
        if *occupied > candidate {
            break;
        }
        candidate = candidate.checked_add(1)?;
    }
    (candidate <= end).then_some(candidate)
}

#[derive(Deserialize)]
pub(crate) struct EnrollRequest {
    token_id: Uuid,
    public_key: String,
    host: String,
}

#[derive(FromRow)]
struct PeerRow {
    id: Uuid,
    user_id: Uuid,
    token_id: Uuid,
    host: String,
    public_key: String,
    address_v4: String,
    address_v6: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const PEER_COLUMNS: &str =
    "id, user_id, token_id, host, public_key, address_v4, address_v6, created_at, updated_at";

fn addresses(v4: String, v6: Option<String>) -> Vec<String> {
    let mut addresses = vec![format!("{v4}/32")];
    if let Some(v6) = v6 {
        addresses.push(format!("{v6}/128"));
    }
    addresses
}

impl From<PeerRow> for EnrolledPeer {
    fn from(row: PeerRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            token_id: row.token_id,
            host: row.host,
            public_key: row.public_key,
            addresses: addresses(row.address_v4, row.address_v6),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

pub(crate) async fn enroll(
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
    Json(body): Json<EnrollRequest>,
) -> Result<(StatusCode, Json<EnrolledPeer>)> {
    let key = canonical_public_key(&body.public_key)
        .ok_or_else(|| Error::BadRequest("invalid wireguard_public_key".into()))?;
    if !valid_host(&body.host) {
        return Err(Error::BadRequest("invalid wireguard host".into()));
    }
    let pool = state
        .wireguard
        .pool
        .as_ref()
        .ok_or(Error::Unavailable("wireguard pool not configured"))?;
    let mut tx = state.pool.begin().await?;
    // User-first locking matches block and token minting; the host lock then
    // serializes allocation across different users sharing the same pool.
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM api_tokens WHERE id = $1 AND user_id = $2 FOR SHARE",
    )
    .bind(body.token_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('wireguard_pool'), hashtext($1))")
        .bind(&body.host)
        .execute(&mut *tx)
        .await?;
    let existing = sqlx::query_as::<_, PeerRow>(&format!(
        "SELECT {PEER_COLUMNS} FROM wireguard_peers WHERE host = $1 AND public_key = $2 FOR UPDATE"
    ))
    .bind(&body.host)
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?;
    let (status, row) = if let Some(existing) = existing {
        if existing.user_id != user_id {
            return Err(Error::Conflict("wireguard key in use"));
        }
        let row = sqlx::query_as::<_, PeerRow>(&format!("UPDATE wireguard_peers SET token_id = $1, updated_at = now() WHERE id = $2 RETURNING {PEER_COLUMNS}"))
            .bind(body.token_id).bind(existing.id).fetch_one(&mut *tx).await?;
        (StatusCode::OK, row)
    } else {
        let occupied = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT address_v4, address_v6 FROM wireguard_peers WHERE host = $1",
        )
        .bind(&body.host)
        .fetch_all(&mut *tx)
        .await?;
        let (v4, v6) = pool.allocate(&occupied)?;
        let row = sqlx::query_as::<_, PeerRow>(&format!("INSERT INTO wireguard_peers (user_id, token_id, host, public_key, address_v4, address_v6) VALUES ($1, $2, $3, $4, $5, $6) RETURNING {PEER_COLUMNS}"))
            .bind(user_id).bind(body.token_id).bind(&body.host).bind(&key).bind(v4).bind(v6).fetch_one(&mut *tx).await?;
        (StatusCode::CREATED, row)
    };
    sqlx::query("INSERT INTO api_token_audit (token_id, action) VALUES ($1, 'wireguard_enrolled')")
        .bind(body.token_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((status, Json(row.into())))
}

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    host: String,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Response> {
    if !valid_host(&query.host) {
        return Err(Error::BadRequest("invalid wireguard host".into()));
    }
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT p.public_key, p.address_v4, p.address_v6 FROM wireguard_peers p \
         JOIN api_tokens t ON t.id = p.token_id JOIN users u ON u.id = p.user_id \
         WHERE p.host = $1 AND t.revoked_at IS NULL \
           AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.blocked_at IS NULL \
         ORDER BY p.public_key COLLATE \"C\"",
    )
    .bind(&query.host)
    .fetch_all(&state.pool)
    .await?;
    let body = serde_json::to_vec(&PeerList {
        host: query.host,
        peers: rows
            .into_iter()
            .map(|(public_key, v4, v6)| ActivePeer {
                public_key,
                allowed_ips: addresses(v4, v6),
            })
            .collect(),
    })
    .map_err(|error| sqlx::Error::Encode(Box::new(error)))?;
    // PostgreSQL supplies SHA-256 without a separate digest dependency in profile.
    let digest: String = sqlx::query_scalar("SELECT encode(sha256($1::bytea), 'hex')")
        .bind(&body)
        .fetch_one(&state.pool)
        .await?;
    let etag = format!("\"{digest}\"");
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(&etag)
    {
        Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response())
    } else {
        Ok((
            [
                (header::ETAG, etag),
                (header::CONTENT_TYPE, "application/json".to_string()),
            ],
            body,
        )
            .into_response())
    }
}

/// Release denied peers after their grace, auditing every deletion atomically.
pub async fn release_once(pool: &PgPool, grace: Duration) -> sqlx::Result<u64> {
    let mut tx = pool.begin().await?;
    let hosts: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT host FROM wireguard_peers ORDER BY host")
            .fetch_all(&mut *tx)
            .await?;
    let mut released = 0;
    for host in hosts {
        // Allocation and release agree on the host lock, so a concurrent
        // replacement cannot lose its row to an older token's denial.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('wireguard_pool'), hashtext($1))")
            .bind(&host)
            .execute(&mut *tx)
            .await?;
        released += sqlx::query(
            "WITH released AS (DELETE FROM wireguard_peers p USING api_tokens t, users u \
             WHERE p.token_id = t.id AND p.user_id = u.id AND p.host = $1 \
               AND (t.revoked_at IS NOT NULL OR t.expires_at <= now() OR u.blocked_at IS NOT NULL) \
               AND GREATEST(p.updated_at, LEAST(t.revoked_at, \
                   CASE WHEN t.expires_at <= now() THEN t.expires_at END, u.blocked_at)) \
                   < now() - make_interval(secs => $2) \
             RETURNING p.token_id) \
             INSERT INTO api_token_audit (token_id, action) SELECT token_id, 'wireguard_released' FROM released",
        ).bind(host).bind(grace.as_secs_f64()).execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    Ok(released)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_defaults_and_rejects_malformed_values() {
        let default = Config::parse(None, None, None, None).unwrap();
        assert!(default.pool.is_none());
        assert_eq!(default.release_grace, Duration::from_secs(300));
        assert_eq!(
            Config::parse(None, None, None, Some("0"))
                .unwrap()
                .release_grace,
            Duration::ZERO
        );
        for (v4, v6, reserved, grace, variable) in [
            (Some("garbage"), None, None, None, "WIREGUARD_POOL_V4"),
            (Some("::/64"), None, None, None, "WIREGUARD_POOL_V4"),
            (
                Some("10.7.0.0/24"),
                Some("10.8.0.0/24"),
                None,
                None,
                "WIREGUARD_POOL_V6",
            ),
            (None, Some("fd00::/64"), None, None, "WIREGUARD_POOL_V4"),
            (
                Some("10.7.0.0/24"),
                None,
                Some("10.7.0.2,no"),
                None,
                "WIREGUARD_POOL_RESERVED",
            ),
            (
                Some("10.7.0.0/24"),
                None,
                Some("10.7.0.2/32"),
                None,
                "WIREGUARD_POOL_RESERVED",
            ),
            (
                None,
                None,
                None,
                Some("-1"),
                "WIREGUARD_RELEASE_GRACE_MINUTES",
            ),
            (
                None,
                None,
                None,
                Some("18446744073709551615"),
                "WIREGUARD_RELEASE_GRACE_MINUTES",
            ),
        ] {
            assert!(Config::parse(v4, v6, reserved, grace)
                .unwrap_err()
                .to_string()
                .contains(variable));
        }
    }

    #[test]
    fn allocation_handles_small_pools_and_address_boundaries() {
        for network in ["0.0.0.0/32", "10.7.0.0/31", "255.255.255.255/32"] {
            let pool = Config::parse(Some(network), None, None, None)
                .unwrap()
                .pool
                .unwrap();
            assert!(matches!(
                pool.allocate(&[]),
                Err(Error::Conflict("wireguard pool exhausted"))
            ));
        }
        for network in [
            "::/128",
            "fd00::/127",
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
        ] {
            let pool = Config::parse(Some("10.7.0.0/24"), Some(network), None, None)
                .unwrap()
                .pool
                .unwrap();
            assert!(matches!(
                pool.allocate(&[]),
                Err(Error::Conflict("wireguard pool exhausted"))
            ));
        }
        let pool = Config::parse(
            Some("255.255.255.252/30"),
            Some("ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffc/126"),
            None,
            None,
        )
        .unwrap()
        .pool
        .unwrap();
        assert_eq!(
            pool.allocate(&[]).unwrap(),
            (
                "255.255.255.254".into(),
                Some("ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe".into())
            )
        );
        assert_eq!(
            lowest_available(u128::MAX, u128::MAX, &BTreeSet::new()),
            Some(u128::MAX)
        );
        assert_eq!(
            lowest_available(u128::MAX, u128::MAX, &BTreeSet::from([u128::MAX])),
            None
        );
    }
}
