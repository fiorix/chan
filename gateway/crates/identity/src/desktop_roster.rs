//! Account-scoped devserver roster for chan-desktop.
//!
//! `GET /desktop/v1/devservers` -- one authenticated read answering
//! everything the desktop needs to render a gateway's devservers: the
//! caller's own devservers (registry rows unioned with live-but-
//! unrostered tunnels), the devservers shared with them (claimed
//! grants only; the profile endpoint returns nothing else), and a
//! real per-row `online` flag derived from bounded, identity-scoped
//! per-owner tunnel reads. Auth is a PAT bearer carrying the
//! `desktop.account` scope, validated via
//! [`crate::api_tokens::ApiTokenService::validate_no_audit`] so the
//! poll loop does not write an audit row per tick (the `last_used_at`
//! bump stays).
//!
//! The failure semantics are load-bearing: the desktop keys its whole
//! per-gateway connection state machine on them.
//!
//!   * 200 + `ETag: "<sha256-hex-of-body>"` -- the roster.
//!     `If-None-Match` on an unchanged body answers 304 with an empty
//!     body, which is what makes the poll cheap.
//!   * 401 `{"error":"unauthorized"}` -- the PAT is dead (revoked,
//!     expired, owner blocked) or does not carry `desktop.account`.
//!     Terminal for the desktop: it disconnects the gateway, tears
//!     down its windows, and clears the stored PAT.
//!   * 502 `{"error":"upstream error"}` -- a dependency (profile or
//!     the devserver-control admin API) failed, or a live tunnel row
//!     carried a node base outside the configured proxy namespace.
//!     The desktop KEEPS its
//!     last-known roster and retries. Serving a degraded all-offline
//!     200 instead is forbidden: every row would read offline and the
//!     desktop would tear down every window on this gateway.

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::config::{Config, InvalidNodeBase};
use crate::devserver_control_client::TunnelView;
use crate::error::{Error, Result};
use crate::http::{bearer_token, AppState, DESKTOP_ACCOUNT_SCOPE};
use crate::profile_client::{IncomingShare, OwnedDevserverSummary};

const MAX_ROSTER_OWNERS: usize = 64;
const OWNER_READ_CONCURRENCY: usize = 8;

/// One devserver the caller can reach. Access is binary and shell-equivalent;
/// the desktop derives "shared" from `owner != username`.
#[derive(Debug, Serialize)]
struct RosterDevserver {
    owner_user_id: uuid::Uuid,
    owner: String,
    devserver_id: String,
    label: String,
    online: bool,
    /// Exact tenant origin of the node holding the registration while
    /// online (`{owner}--{disc}.{proxy}.<apex>`), `null` while
    /// offline. The desktop compares it against its pinned entry
    /// origin to detect a move between nodes; it never mints
    /// authority from this field (the entry response stays the sole
    /// exact-origin authorization source).
    proxy_origin: Option<String>,
}

#[derive(Debug, Serialize)]
struct RosterResponse {
    user_id: uuid::Uuid,
    username: String,
    devservers: Vec<RosterDevserver>,
}

/// `GET /desktop/v1/devservers` -- see the module doc for the wire
/// contract and failure semantics.
pub async fn roster(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let token = bearer_token(&headers).ok_or(Error::Unauthorized)?;
    let validated = state.api_tokens.validate_no_audit(token).await?;
    if !validated
        .scopes
        .iter()
        .any(|scope| scope == DESKTOP_ACCOUNT_SCOPE)
    {
        tracing::warn!(
            user = %validated.username,
            "roster denied: missing desktop.account scope",
        );
        return Err(Error::Unauthorized);
    }

    let owned = match state
        .cfg
        .profile_client
        .list_owned_devservers(validated.user_id)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return Ok(upstream_502("owned list", &validated.username, &e)),
    };
    let shared = match state
        .cfg
        .profile_client
        .list_incoming_shares(validated.user_id)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return Ok(upstream_502("incoming list", &validated.username, &e)),
    };
    // Identity's controller bearer is deliberately owner-read-only. Fetch the
    // caller plus distinct share owners in bounded batches; never broaden the
    // token to profile's fleet-wide snapshot scope.
    let mut owners: Vec<uuid::Uuid> = shared.iter().map(|share| share.owner_user_id).collect();
    owners.push(validated.user_id);
    owners.sort_unstable();
    owners.dedup();
    if owners.len() > MAX_ROSTER_OWNERS {
        return Ok(upstream_502(
            "tunnel snapshot",
            &validated.username,
            &"too many distinct roster owners",
        ));
    }
    let mut tunnels = Vec::new();
    for chunk in owners.chunks(OWNER_READ_CONCURRENCY) {
        let mut reads = tokio::task::JoinSet::new();
        for owner_id in chunk.iter().copied() {
            let client = state.cfg.workspace_admin.clone();
            reads.spawn(async move { (owner_id, client.list_owner_tunnels(owner_id).await) });
        }
        while let Some(read) = reads.join_next().await {
            let (owner_id, rows) = match read {
                Ok((owner_id, Ok(rows))) => (owner_id, rows),
                Ok((_, Err(error))) => {
                    return Ok(upstream_502("tunnel snapshot", &validated.username, &error));
                }
                Err(error) => {
                    return Ok(upstream_502("tunnel snapshot", &validated.username, &error));
                }
            };
            if rows.iter().any(|row| row.owner_user_id != owner_id) {
                return Ok(upstream_502(
                    "tunnel snapshot",
                    &validated.username,
                    &"controller returned a row for the wrong owner",
                ));
            }
            tunnels.extend(rows);
        }
    }
    for tunnel in &tunnels {
        if let Err(error) =
            crate::devserver_authority::verify_tunnel(&state.cfg.admission_lease_verifier, tunnel)
        {
            return Ok(upstream_502(
                "tunnel authority",
                &validated.username,
                &error,
            ));
        }
    }

    let body = match build_roster(
        &state.cfg,
        validated.user_id,
        &validated.username,
        owned,
        shared,
        tunnels,
    ) {
        Ok(body) => body,
        // A live row whose node base fails the namespace check is the
        // same failure class as an unreachable controller: the roster
        // cannot answer honestly, so it 502s rather than guessing an
        // origin.
        Err(e) => return Ok(upstream_502("tunnel snapshot", &validated.username, &e)),
    };
    let bytes = serde_json::to_vec(&body)
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("serialize roster: {e}")))?;
    let etag = format!("\"{}\"", hex_sha256(&bytes));

    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        == Some(etag.as_str())
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &etag)
            .body(Body::empty())
            .map_err(|e| Error::Anyhow(anyhow::anyhow!("build roster 304: {e}")));
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ETAG, &etag)
        .body(Body::from(bytes))
        .map_err(|e| Error::Anyhow(anyhow::anyhow!("build roster 200: {e}")))
}

/// The pinned 502. Detail stays in the server log; the desktop keys
/// on the status plus this fixed body and keeps its last-known
/// roster, so the body must never grow upstream specifics.
fn upstream_502(what: &str, user: &str, err: &dyn std::fmt::Debug) -> Response {
    tracing::warn!(error = ?err, user = %user, "roster upstream failure: {what}");
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({"error": "upstream error"})),
    )
        .into_response()
}

/// Merge the three source lists into the wire shape. Pure so the
/// merge semantics (liveness filter, live-unrostered union, label
/// fallback, sort) are unit-testable without a stack. Fallible
/// because every online row carries its owning node's tenant origin:
/// a live tunnel whose controller-reported node base fails the
/// namespace check is an error, never an origin guessed from the
/// shared apex.
#[derive(Debug, thiserror::Error)]
enum RosterBuildError {
    #[error(transparent)]
    InvalidNodeBase(#[from] InvalidNodeBase),
    #[error("profile returned a devserver for the wrong owner")]
    WrongOwner,
}

fn build_roster(
    cfg: &Config,
    user_id: uuid::Uuid,
    username: &str,
    owned: Vec<OwnedDevserverSummary>,
    shared: Vec<IncomingShare>,
    tunnels: Vec<TunnelView>,
) -> std::result::Result<RosterResponse, RosterBuildError> {
    // Bounded per-owner reads feed every `online` flag and proxy origin.
    let mut expected_owners: HashMap<uuid::Uuid, &str> = shared
        .iter()
        .map(|share| (share.owner_user_id, share.owner_username.as_str()))
        .collect();
    expected_owners.insert(user_id, username);
    let mut live: HashMap<(uuid::Uuid, String), String> = HashMap::new();
    for t in tunnels {
        if let Some(expected_username) = expected_owners.get(&t.owner_user_id) {
            if t.user != *expected_username {
                return Err(RosterBuildError::WrongOwner);
            }
            let origin = cfg
                .tenant_origin_for(&t.user, &t.devserver_id, &t.proxy_id, &t.proxy_base_url)?
                .origin;
            live.insert((t.owner_user_id, t.devserver_id), origin);
        }
    }

    let mut own_rows: Vec<RosterDevserver> = owned
        .into_iter()
        .map(|o| {
            if o.owner_user_id != user_id {
                return Err(RosterBuildError::WrongOwner);
            }
            let proxy_origin = live.get(&(user_id, o.devserver_id.clone())).cloned();
            Ok(RosterDevserver {
                owner_user_id: o.owner_user_id,
                owner: username.to_string(),
                label: display_label(&o.label, &o.devserver_id),
                online: proxy_origin.is_some(),
                proxy_origin,
                devserver_id: o.devserver_id,
            })
        })
        .collect::<std::result::Result<Vec<_>, RosterBuildError>>()?;
    // A live tunnel with no registry row (dialed in before the row
    // existed, or the row was swept) still belongs to the caller:
    // append it so nothing the user can reach is hidden.
    for ((owner_user_id, devserver_id), origin) in &live {
        if *owner_user_id == user_id && !own_rows.iter().any(|r| &r.devserver_id == devserver_id) {
            own_rows.push(RosterDevserver {
                owner_user_id: user_id,
                owner: username.to_string(),
                devserver_id: devserver_id.clone(),
                label: disc_label(devserver_id),
                online: true,
                proxy_origin: Some(origin.clone()),
            });
        }
    }

    let mut shared_rows: Vec<RosterDevserver> = shared
        .into_iter()
        .map(|s| {
            let proxy_origin = live
                .get(&(s.owner_user_id, s.devserver_id.clone()))
                .cloned();
            RosterDevserver {
                owner_user_id: s.owner_user_id,
                online: proxy_origin.is_some(),
                proxy_origin,
                label: display_label(&s.label, &s.devserver_id),
                owner: s.owner_username,
                devserver_id: s.devserver_id,
            }
        })
        .collect();

    // Own-then-shared, label ascending inside each group. The id
    // tie-break keeps equal labels deterministic across polls so the
    // ETag cannot churn on a stable roster.
    let by_label = |a: &RosterDevserver, b: &RosterDevserver| {
        a.label
            .cmp(&b.label)
            .then_with(|| a.devserver_id.cmp(&b.devserver_id))
    };
    own_rows.sort_by(by_label);
    shared_rows.sort_by(by_label);
    own_rows.extend(shared_rows);

    Ok(RosterResponse {
        user_id,
        username: username.to_string(),
        devservers: own_rows,
    })
}

/// Display label fallback: the id's 12-hex disc (the same string the
/// wildcard host carries).
fn display_label(label: &str, devserver_id: &str) -> String {
    if label.is_empty() {
        disc_label(devserver_id)
    } else {
        label.to_string()
    }
}

fn disc_label(devserver_id: &str) -> String {
    devserver_id.chars().take(12).collect()
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn owner_id() -> Uuid {
        user_id("alice")
    }

    fn user_id(username: &str) -> Uuid {
        match username {
            "alice" => Uuid::from_u128(1),
            "bob" => Uuid::from_u128(2),
            "carol" => Uuid::from_u128(3),
            _ => Uuid::from_u128(4),
        }
    }

    fn test_cfg() -> Config {
        Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            internal_bind_addr: "127.0.0.1:0".parse().unwrap(),
            base_url: "http://localhost:7000".parse().unwrap(),
            devserver_proxy_origin: "https://usr.chan.app".parse().unwrap(),
            devserver_tunnel_origin: "https://tunnel.example.test".parse().unwrap(),
            database_url: "x".into(),
            cookie_secure: true,
            profile_client: crate::profile_client::ProfileClient::new(
                "http://x/".parse().unwrap(),
                "x".into(),
            )
            .unwrap(),
            internal_auth_token: "x".into(),
            session_internal_auth_token: String::new(),
            identity_admin_token: String::new(),
            account_admin_token: String::new(),
            workspace_admin: gateway_common::devserver_control_client::DevserverControlClient::new(
                "http://127.0.0.1:7002".parse().unwrap(),
                "test-identity-admin-token".into(),
            )
            .unwrap(),
            admission_lease_verifier: {
                let signer = devserver_control_proto::AdmissionLeaseSigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                devserver_control_proto::AdmissionLeaseVerifier::from_base64(
                    &signer.verifying_key_base64(),
                )
                .unwrap()
            },
            entry_signer: gateway_common::devserver_gate::EntrySigner::from_base64(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap(),
            providers: vec![],
        }
    }

    fn owned(id: &str, label: &str) -> OwnedDevserverSummary {
        OwnedDevserverSummary {
            owner_user_id: owner_id(),
            devserver_id: id.into(),
            label: label.into(),
            grant_count: 0,
        }
    }

    fn share(owner: &str, id: &str, label: &str) -> IncomingShare {
        IncomingShare {
            grant_id: Uuid::new_v4(),
            owner_user_id: user_id(owner),
            owner_username: owner.into(),
            owner_display_name: None,
            owner_avatar_url: None,
            devserver_id: id.into(),
            label: label.into(),
            accepted_at: Utc::now(),
        }
    }

    fn tunnel(user: &str, id: &str) -> TunnelView {
        tunnel_on(user, id, "p1", "https://p1.usr.chan.app")
    }

    fn tunnel_on(user: &str, id: &str, proxy_id: &str, proxy_base_url: &str) -> TunnelView {
        serde_json::from_value(serde_json::json!({
            "registration_id": Uuid::new_v4(),
            "owner_user_id": user_id(user),
            "user": user,
            "devserver_id": id,
            "peer_addr": null,
            "connected_at": Utc::now().to_rfc3339(),
            "proxy_id": proxy_id,
            "proxy_base_url": proxy_base_url,
            "max_connected_devservers": 3,
            "admission_lease": "test",
            "admission_lease_expires_at": (Utc::now() + chrono::Duration::minutes(2)).to_rfc3339(),
        }))
        .expect("tunnel view")
    }

    /// The tenant origin identity builds for `(owner, id)` on `proxy`.
    fn tenant_origin(owner: &str, id: &str, proxy: &str) -> String {
        format!("https://{owner}--{}.{proxy}.usr.chan.app", &id[..12])
    }

    #[test]
    fn merges_owned_shared_and_liveness() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&a, "laptop"), owned(&b, "office")],
            vec![share("bob", &c, "bob-box")],
            vec![tunnel("alice", &a), tunnel("bob", &c)],
        )
        .expect("roster");
        assert_eq!(r.username, "alice");
        assert_eq!(r.user_id, owner_id());
        let flags: Vec<(&str, bool)> = r
            .devservers
            .iter()
            .map(|d| (d.label.as_str(), d.online))
            .collect();
        assert_eq!(
            flags,
            vec![("laptop", true), ("office", false), ("bob-box", true),]
        );
        assert!(r.devservers.iter().take(2).all(|d| d.owner == "alice"));
        assert_eq!(r.devservers[2].owner, "bob");
    }

    #[test]
    fn online_rows_carry_the_owning_nodes_origin() {
        // Two owners on different nodes: each online row maps to its
        // own node's tenant origin; the offline row stays null.
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&a, "laptop"), owned(&b, "office")],
            vec![share("bob", &c, "bob-box")],
            vec![
                tunnel_on("alice", &a, "p1", "https://p1.usr.chan.app"),
                tunnel_on("bob", &c, "p2", "https://p2.usr.chan.app"),
            ],
        )
        .expect("roster");
        let origins: Vec<Option<String>> = r
            .devservers
            .iter()
            .map(|d| d.proxy_origin.clone())
            .collect();
        assert_eq!(
            origins,
            vec![
                Some(tenant_origin("alice", &a, "p1")),
                None,
                Some(tenant_origin("bob", &c, "p2")),
            ]
        );
    }

    #[test]
    fn live_row_with_an_unplaceable_node_base_is_an_error() {
        // Fail-closed: a live row outside the configured namespace
        // must not degrade to a guessed origin or an offline row.
        let a = "a".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&a, "laptop")],
            vec![],
            vec![tunnel_on("alice", &a, "p1", "https://p1.evil.example.net")],
        );
        assert!(r.is_err(), "invalid node base must fail the build");
    }

    #[test]
    fn foreign_rows_never_reach_node_base_validation() {
        // A tunnel owned by neither the caller nor a share owner is
        // filtered before validation: its junk base cannot 502 a
        // roster it would never appear on.
        let f = "f".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![],
            vec![],
            vec![tunnel_on("mallory", &f, "p9", "not a url")],
        )
        .expect("foreign rows are filtered first");
        assert!(r.devservers.is_empty(), "{:?}", r.devservers);
    }

    #[test]
    fn appends_live_unrostered_own_tunnel() {
        let a = "a".repeat(64);
        let e = "e".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&a, "laptop")],
            vec![],
            vec![tunnel("alice", &e)],
        )
        .expect("roster");
        let extra = r
            .devservers
            .iter()
            .find(|d| d.devserver_id == e)
            .expect("live-unrostered row present");
        assert!(extra.online);
        assert_eq!(extra.label, "e".repeat(12));
        assert_eq!(
            extra.proxy_origin.as_deref(),
            Some(tenant_origin("alice", &e, "p1").as_str())
        );
    }

    #[test]
    fn filters_foreign_tunnels() {
        // A tunnel owned by neither the caller nor a share owner must
        // not leak into the roster (the snapshot is cluster-wide).
        let f = "f".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![],
            vec![],
            vec![tunnel("mallory", &f)],
        )
        .expect("roster");
        assert!(r.devservers.is_empty(), "{:?}", r.devservers);
    }

    #[test]
    fn label_falls_back_to_disc_prefix() {
        let a = "a".repeat(64);
        let c = "c".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&a, "")],
            vec![share("bob", &c, "")],
            vec![],
        )
        .expect("roster");
        assert_eq!(r.devservers[0].label, "a".repeat(12));
        assert_eq!(r.devservers[1].label, "c".repeat(12));
    }

    #[test]
    fn sorts_own_then_shared_label_ascending() {
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![
                owned(&"a".repeat(64), "zulu"),
                owned(&"b".repeat(64), "alfa"),
            ],
            vec![
                share("bob", &"c".repeat(64), "mike"),
                share("carol", &"d".repeat(64), "bravo"),
            ],
            vec![],
        )
        .expect("roster");
        let labels: Vec<&str> = r.devservers.iter().map(|d| d.label.as_str()).collect();
        assert_eq!(labels, vec!["alfa", "zulu", "bravo", "mike"]);
    }

    #[test]
    fn wire_shape_pins_field_names() {
        // Contract B: the desktop poller deserializes these exact
        // keys; a rename is a compile-green silent break, so pin them.
        let a = "a".repeat(64);
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&a, "laptop")],
            vec![],
            vec![tunnel("alice", &a)],
        )
        .expect("roster");
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["username"], "alice");
        assert_eq!(j["user_id"], owner_id().to_string());
        let row = &j["devservers"][0];
        assert_eq!(row["owner"], "alice");
        assert_eq!(row["owner_user_id"], owner_id().to_string());
        assert_eq!(row["devserver_id"], a);
        assert_eq!(row["label"], "laptop");
        assert_eq!(row["online"], true);
        assert!(row.get("role").is_none());
        assert_eq!(row["proxy_origin"], tenant_origin("alice", &a, "p1"));
    }

    #[test]
    fn offline_row_serializes_proxy_origin_as_null() {
        // The desktop reads `proxy_origin` as Option<String>: offline
        // must be an explicit null, not a missing key.
        let r = build_roster(
            &test_cfg(),
            owner_id(),
            "alice",
            vec![owned(&"a".repeat(64), "laptop")],
            vec![],
            vec![],
        )
        .expect("roster");
        let j = serde_json::to_value(&r).unwrap();
        assert!(j["devservers"][0]["proxy_origin"].is_null(), "{j}");
    }

    #[test]
    fn etag_hex_is_stable_sha256() {
        // Known vector so the ETag encoding cannot drift silently.
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
