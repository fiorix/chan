use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use devserver_control_proto::SessionRevocation;
use futures_util::stream::{self, Stream};
use serde::{Deserialize, Serialize};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::config::{AdminCredentials, AdminScope};
use crate::{
    ActorError, BrowserSessionView, CommandOutcome, ControllerHandle, KillPlan, ProxyStatus,
    ProxyView, TunnelView,
};

#[derive(Clone)]
struct AppState {
    controller: ControllerHandle,
    admin_credentials: Arc<AdminCredentials>,
    watchers: Arc<Semaphore>,
}

const MAX_SSE_WATCHERS: usize = 128;

pub fn router(
    controller: ControllerHandle,
    admin_credentials: impl Into<AdminCredentials>,
) -> Router {
    let state = AppState {
        controller,
        admin_credentials: Arc::new(admin_credentials.into()),
        watchers: Arc::new(Semaphore::new(MAX_SSE_WATCHERS)),
    };
    let admin = Router::new()
        .route("/admin/v1/tunnels", get(list_tunnels))
        .route("/admin/v1/tunnels/watch", get(watch_tunnels))
        .route("/admin/v1/tunnels/kill-all", post(kill_all_tunnels))
        .route(
            "/admin/v1/tunnels/{owner_user_id}/{devserver_id}/kill",
            post(kill_tunnel),
        )
        .route(
            "/admin/v1/owners/{owner_user_id}/tunnels",
            get(list_owner_tunnels),
        )
        .route(
            "/admin/v1/owners/{owner_user_id}/tunnels/kill",
            post(kill_owner_tunnels),
        )
        .route("/admin/v1/proxies", get(list_proxies))
        .route("/admin/v1/proxies/watch", get(watch_proxies))
        .route("/admin/v1/browser-sessions", get(list_browser_sessions))
        .route(
            "/admin/v1/browser-sessions/watch",
            get(watch_browser_sessions),
        )
        .route(
            "/admin/v1/browser-sessions/{admin_session_id}/revoke",
            post(revoke_browser_session),
        )
        .route(
            "/admin/v1/browser-sessions/subjects/{user_id}/revoke",
            post(revoke_subject_sessions),
        )
        .route(
            "/admin/v1/browser-sessions/owners/{user_id}/revoke",
            post(revoke_owner_sessions),
        )
        .route(
            "/admin/v1/browser-sessions/revoke-all",
            post(revoke_all_sessions),
        )
        .route("/admin/v1/overview", get(overview))
        .route("/admin/v1/sessions/revoke", post(revoke_sessions))
        .route_layer(middleware::from_fn_with_state(state.clone(), admin_auth));

    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .merge(admin)
        .with_state(state)
}

async fn healthz() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok\n")
}

async fn readyz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match state.controller.is_ready().await {
        Ok(true) => (StatusCode::OK, "ready\n"),
        Ok(false) | Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "warming\n"),
    }
}

async fn list_tunnels(State(state): State<AppState>) -> Result<Json<Vec<TunnelView>>, StatusCode> {
    state
        .controller
        .tunnels()
        .await
        .map(|rows| Json(redact_fleet_peer_addresses(&rows)))
        .map_err(admin_error)
}

async fn list_proxies(State(state): State<AppState>) -> Result<Json<Vec<ProxyView>>, StatusCode> {
    state
        .controller
        .proxies()
        .await
        .map(Json)
        .map_err(admin_error)
}

#[derive(Clone, Default, Deserialize)]
struct BrowserSessionFilter {
    subject_user_id: Option<Uuid>,
    owner_user_id: Option<Uuid>,
    proxy_id: Option<String>,
}

impl BrowserSessionFilter {
    fn apply(&self, rows: &[BrowserSessionView]) -> Vec<BrowserSessionView> {
        rows.iter()
            .filter(|row| {
                self.subject_user_id
                    .is_none_or(|user_id| row.subject_user_id == user_id)
                    && self
                        .owner_user_id
                        .is_none_or(|user_id| row.owner_user_id == user_id)
                    && self
                        .proxy_id
                        .as_deref()
                        .is_none_or(|proxy_id| row.proxy_id == proxy_id)
            })
            .cloned()
            .collect()
    }
}

async fn list_browser_sessions(
    State(state): State<AppState>,
    Query(filter): Query<BrowserSessionFilter>,
) -> Result<Json<Vec<BrowserSessionView>>, StatusCode> {
    state
        .controller
        .browser_sessions()
        .await
        .map(|rows| Json(filter.apply(&rows)))
        .map_err(admin_error)
}

#[derive(Serialize)]
struct Overview {
    generated_at: chrono::DateTime<chrono::Utc>,
    proxies_connected: usize,
    proxies_ready: usize,
    devservers_connected: usize,
    tenant_sessions_active: usize,
}

async fn overview(State(state): State<AppState>) -> Result<Json<Overview>, StatusCode> {
    let (proxies, tunnels, sessions) = tokio::try_join!(
        state.controller.proxies(),
        state.controller.tunnels(),
        state.controller.browser_sessions(),
    )
    .map_err(admin_error)?;
    Ok(Json(Overview {
        generated_at: chrono::Utc::now(),
        proxies_connected: proxies.len(),
        proxies_ready: proxies
            .iter()
            .filter(|proxy| proxy.status == ProxyStatus::Active)
            .count(),
        devservers_connected: tunnels.len(),
        tenant_sessions_active: sessions.len(),
    }))
}

/// Per-user aggregate snapshot. A well-formed user with nothing live
/// returns an empty array, not a 404, so callers do not special-case the
/// steady state; a malformed username is a probe and gets the same 404
/// shape as any unknown target.
async fn list_owner_tunnels(
    State(state): State<AppState>,
    Path(owner_user_id): Path<String>,
) -> Result<Json<Vec<TunnelView>>, Response> {
    let owner_user_id = Uuid::parse_str(&owner_user_id).map_err(|_| not_found())?;
    let tunnels = state
        .controller
        .owner_tunnels(owner_user_id)
        .await
        .map_err(|error| admin_error(error).into_response())?;
    Ok(Json(tunnels))
}

/// Exact kill of one aggregate row. The state machine routes the command
/// by the registration UUID read at issue time, so a delayed command
/// cannot kill a successor registration for the same key.
async fn kill_tunnel(
    State(state): State<AppState>,
    Path((owner_user_id, devserver_id)): Path<(String, String)>,
) -> Result<StatusCode, Response> {
    let owner_user_id = Uuid::parse_str(&owner_user_id).map_err(|_| not_found())?;
    let plan = state
        .controller
        .plan_tunnel_kill(owner_user_id, &devserver_id)
        .await
        .map_err(|error| admin_error(error).into_response())?;
    let KillPlan::Issued(confirmations) = plan else {
        return Err(not_found());
    };
    let confirmation = confirmations
        .into_iter()
        .next()
        .expect("exact kill issues exactly one command");
    match confirmation.await {
        Ok(CommandOutcome::Confirmed { .. }) => Ok(StatusCode::NO_CONTENT),
        // A dropped sender means the command settled without a reachable
        // waiter (actor restart); the proxy may have executed the kill,
        // so the honest answer is partial rather than success.
        Ok(_) | Err(_) => Err(partial_kill(0)),
    }
}

/// User-wide kill, fanned out as one command per owning proxy. Await
/// every confirmation so a partial failure reports the count that is
/// actually gone; the operation stays idempotent and a retry kills any
/// surviving rows.
async fn kill_owner_tunnels(
    State(state): State<AppState>,
    Path(owner_user_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let owner_user_id = Uuid::parse_str(&owner_user_id).map_err(|_| not_found())?;
    let plan = state
        .controller
        .plan_owner_kill(owner_user_id)
        .await
        .map_err(|error| admin_error(error).into_response())?;
    let confirmations = match plan {
        KillPlan::Issued(confirmations) => confirmations,
        KillPlan::NotFound => Vec::new(),
    };
    let mut killed = 0;
    let mut partial = false;
    for outcome in futures_util::future::join_all(confirmations).await {
        match outcome {
            Ok(CommandOutcome::Confirmed {
                killed: gone,
                missing,
            }) => killed += gone + missing,
            Ok(_) | Err(_) => partial = true,
        }
    }
    if partial {
        return Err(partial_kill(killed));
    }
    Ok(Json(serde_json::json!({ "killed": killed })))
}

async fn kill_all_tunnels(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, Response> {
    let plan = state
        .controller
        .plan_all_kill()
        .await
        .map_err(|error| admin_error(error).into_response())?;
    settle_kill_plan(plan).await
}

async fn settle_kill_plan(plan: KillPlan) -> Result<Json<serde_json::Value>, Response> {
    let confirmations = match plan {
        KillPlan::Issued(confirmations) => confirmations,
        KillPlan::NotFound => Vec::new(),
    };
    let mut killed = 0;
    let mut partial = false;
    for outcome in futures_util::future::join_all(confirmations).await {
        match outcome {
            Ok(CommandOutcome::Confirmed {
                killed: gone,
                missing,
            }) => killed += gone + missing,
            Ok(_) | Err(_) => partial = true,
        }
    }
    let body = serde_json::json!({ "tunnels_evicted": killed });
    if partial {
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "partial kill",
                "tunnels_evicted": killed,
            })),
        )
            .into_response());
    }
    Ok(Json(body))
}

async fn revoke_browser_session(
    State(state): State<AppState>,
    Path(admin_session_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let admin_session_id = Uuid::parse_str(&admin_session_id).map_err(|_| not_found())?;
    execute_revocation(&state, SessionRevocation::SessionId { admin_session_id }).await
}

async fn revoke_subject_sessions(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let user_id = Uuid::parse_str(&user_id).map_err(|_| not_found())?;
    execute_revocation(
        &state,
        SessionRevocation::Subject {
            subject_user_id: user_id,
        },
    )
    .await
}

async fn revoke_owner_sessions(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> Result<Json<serde_json::Value>, Response> {
    let user_id = Uuid::parse_str(&user_id).map_err(|_| not_found())?;
    execute_revocation(
        &state,
        SessionRevocation::Owner {
            owner_user_id: user_id,
        },
    )
    .await
}

async fn revoke_all_sessions(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, Response> {
    execute_revocation(&state, SessionRevocation::All).await
}

async fn revoke_sessions(
    State(state): State<AppState>,
    Extension(scope): Extension<AdminScope>,
    Json(revocation): Json<SessionRevocation>,
) -> Result<Json<serde_json::Value>, Response> {
    revocation.validate().map_err(|_| not_found())?;
    if !scope_authorizes_revocation(scope, &revocation) {
        return Err(StatusCode::FORBIDDEN.into_response());
    }
    execute_revocation(&state, revocation).await
}

fn scope_authorizes_revocation(scope: AdminScope, revocation: &SessionRevocation) -> bool {
    match scope {
        AdminScope::Operator | AdminScope::Identity => true,
        AdminScope::Profile => matches!(
            revocation,
            SessionRevocation::Exact { .. } | SessionRevocation::Subject { .. }
        ),
    }
}

async fn execute_revocation(
    state: &AppState,
    revocation: SessionRevocation,
) -> Result<Json<serde_json::Value>, Response> {
    let plan = state
        .controller
        .plan_session_revocation(revocation)
        .await
        .map_err(|error| admin_error(error).into_response())?;
    let confirmations = plan.confirmations;
    let connected_expected = confirmations.len();
    let unreachable = plan.unreachable_proxies;
    let authority_ready = plan.authority_ready;
    let expected = connected_expected.saturating_add(unreachable);
    let mut revoked = 0_usize;
    let mut confirmed = 0_usize;
    for outcome in futures_util::future::join_all(confirmations).await {
        if let Ok(CommandOutcome::Confirmed { killed, .. }) = outcome {
            revoked = revoked.saturating_add(killed);
            confirmed += 1;
        }
    }
    if confirmed != connected_expected || unreachable != 0 || !authority_ready {
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "partial session revocation",
                "revoked": revoked,
                "tenant_sessions_revoked": revoked,
                "proxies_confirmed": confirmed,
                "proxies_expected": expected,
                "proxies_unreachable": unreachable,
                "fleet_authority_ready": authority_ready,
            })),
        )
            .into_response());
    }
    Ok(Json(serde_json::json!({
        "revoked": revoked,
        "tenant_sessions_revoked": revoked,
        "proxies_confirmed": confirmed,
        "proxies_expected": expected,
        "proxies_unreachable": unreachable,
        "fleet_authority_ready": authority_ready,
    })))
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "not found" })),
    )
        .into_response()
}

fn partial_kill(killed: usize) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({ "error": "partial kill", "killed": killed })),
    )
        .into_response()
}

async fn watch_tunnels(
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let readiness = state.controller.watch_readiness();
    if !*readiness.borrow() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let permit = state
        .watchers
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    Ok(Sse::new(snapshot_stream(
        state.controller.watch_tunnels(),
        readiness,
        permit,
        redact_fleet_peer_addresses,
    ))
    .keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

async fn watch_proxies(
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let readiness = state.controller.watch_readiness();
    if !*readiness.borrow() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let permit = state
        .watchers
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    Ok(Sse::new(snapshot_stream(
        state.controller.watch_proxies(),
        readiness,
        permit,
        clone_snapshot,
    ))
    .keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

async fn watch_browser_sessions(
    State(state): State<AppState>,
    Query(filter): Query<BrowserSessionFilter>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let readiness = state.controller.watch_readiness();
    if !*readiness.borrow() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let permit = state
        .watchers
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    Ok(Sse::new(snapshot_stream(
        state.controller.watch_browser_sessions(),
        readiness,
        permit,
        move |rows| filter.apply(rows),
    ))
    .keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

fn snapshot_stream<T, P>(
    values: watch::Receiver<Arc<Vec<T>>>,
    readiness: watch::Receiver<bool>,
    permit: OwnedSemaphorePermit,
    project: P,
) -> impl Stream<Item = Result<Event, Infallible>>
where
    T: Clone + Serialize + Send + Sync + 'static,
    P: Fn(&[T]) -> Vec<T> + Clone + Send + 'static,
{
    stream::unfold(
        (values, readiness, true, permit, project),
        |(mut values, mut readiness, first, permit, project)| async move {
            let mut first = first;
            loop {
                if !*readiness.borrow() {
                    return None;
                }
                if first {
                    first = false;
                    let snapshot = values.borrow_and_update().clone();
                    let projected = project(snapshot.as_ref());
                    let event = snapshot_event(&projected)?;
                    return Some((Ok(event), (values, readiness, first, permit, project)));
                }

                tokio::select! {
                    biased;
                    changed = readiness.changed() => {
                        if changed.is_err() || !*readiness.borrow_and_update() {
                            return None;
                        }
                    }
                    changed = values.changed() => {
                        if changed.is_err() {
                            return None;
                        }
                        let snapshot = values.borrow_and_update().clone();
                        let projected = project(snapshot.as_ref());
                        let event = snapshot_event(&projected)?;
                        return Some((Ok(event), (values, readiness, first, permit, project)));
                    }
                }
            }
        },
    )
}

fn clone_snapshot<T: Clone>(snapshot: &[T]) -> Vec<T> {
    snapshot.to_vec()
}

fn redact_fleet_peer_addresses(snapshot: &[TunnelView]) -> Vec<TunnelView> {
    snapshot
        .iter()
        .cloned()
        .map(|mut row| {
            row.peer_addr = None;
            row
        })
        .collect()
}

fn snapshot_event<T: Serialize>(snapshot: &T) -> Option<Event> {
    match Event::default().event("snapshot").json_data(snapshot) {
        Ok(event) => Some(event),
        Err(error) => {
            tracing::error!(error = ?error, "failed to serialize controller watch snapshot");
            None
        }
    }
}

async fn admin_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut request: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let Some(scope) =
        provided.and_then(|token| state.admin_credentials.authenticate(token.as_bytes()))
    else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    if !scope_authorizes(scope, request.method(), request.uri().path()) {
        return Err(StatusCode::FORBIDDEN);
    }
    request.extensions_mut().insert(scope);
    Ok(next.run(request).await)
}

fn scope_authorizes(scope: AdminScope, method: &axum::http::Method, path: &str) -> bool {
    if scope == AdminScope::Operator {
        return true;
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    match (method, segments.as_slice()) {
        (&axum::http::Method::GET, ["admin", "v1", "owners", _, "tunnels"]) => true,
        (&axum::http::Method::POST, ["admin", "v1", "owners", _, "tunnels", "kill"])
        | (&axum::http::Method::POST, ["admin", "v1", "tunnels", _, _, "kill"])
        | (&axum::http::Method::POST, ["admin", "v1", "sessions", "revoke"]) => true,
        (&axum::http::Method::POST, ["admin", "v1", "tunnels", "kill-all"])
        | (&axum::http::Method::POST, ["admin", "v1", "browser-sessions", _, "revoke"])
        | (
            &axum::http::Method::POST,
            ["admin", "v1", "browser-sessions", "subjects", _, "revoke"],
        )
        | (&axum::http::Method::POST, ["admin", "v1", "browser-sessions", "owners", _, "revoke"])
        | (&axum::http::Method::POST, ["admin", "v1", "browser-sessions", "revoke-all"]) => {
            scope == AdminScope::Identity
        }
        (&axum::http::Method::GET, ["admin", "v1", "tunnels"])
        | (&axum::http::Method::GET, ["admin", "v1", "proxies"]) => scope == AdminScope::Profile,
        _ => false,
    }
}

fn admin_error(error: ActorError) -> StatusCode {
    tracing::warn!(error = ?error, "controller admin read unavailable");
    StatusCode::SERVICE_UNAVAILABLE
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use devserver_control_proto::{CanonicalOrigin, ProxyId, ServerFrame, TunnelRow};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use uuid::Uuid;

    async fn request(app: Router, path: &str, token: Option<&str>) -> Response {
        request_with_method(app, "GET", path, token).await
    }

    async fn post(app: Router, path: &str, token: Option<&str>) -> Response {
        request_with_method(app, "POST", path, token).await
    }

    async fn post_json(
        app: Router,
        path: &str,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> Response {
        let mut request = axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        app.oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn request_with_method(
        app: Router,
        method: &str,
        path: &str,
        token: Option<&str>,
    ) -> Response {
        let mut request = axum::http::Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        app.oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn row(user: &str, devserver_id: &str, registration_id: Uuid) -> TunnelRow {
        TunnelRow {
            registration_id,
            owner_user_id: crate::state::legacy_owner_user_id(user),
            user: user.into(),
            devserver_id: devserver_id.into(),
            max_connected_devservers: devserver_control_proto::MAX_SIGNED_CONNECTED_DEVSERVERS,
            admission_lease: devserver_control_proto::AdmissionLease::parse("test").unwrap(),
            admission_lease_expires_at: chrono::Utc::now() + chrono::Duration::days(365),
            peer_addr: None,
            connected_at: chrono::Utc::now(),
        }
    }

    async fn begin_proxy(
        controller: &ControllerHandle,
        id: &str,
        rows: Vec<TunnelRow>,
    ) -> (ProxyId, crate::ProxyControlSession) {
        let proxy_id = ProxyId::parse(id).unwrap();
        let session = controller
            .begin_session(
                proxy_id.clone(),
                CanonicalOrigin::parse(&format!("https://{id}.proxy.example.test")).unwrap(),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        controller
            .accept_snapshot(proxy_id.clone(), session.incarnation, 0, rows, Vec::new())
            .await
            .unwrap();
        (proxy_id, session)
    }

    async fn keep_alive_until_ready(
        controller: &ControllerHandle,
        sessions: &mut [(ProxyId, crate::ProxyControlSession)],
    ) {
        for _ in 0..6 {
            tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
            for (proxy_id, session) in sessions.iter_mut() {
                let nonce = loop {
                    if let ServerFrame::Ping { nonce } = session.commands.recv().await.unwrap() {
                        break nonce;
                    }
                };
                controller
                    .pong(proxy_id.clone(), session.incarnation, nonce)
                    .await
                    .unwrap();
            }
        }
    }

    async fn ready_controller() -> ControllerHandle {
        ready_controller_with(Vec::new()).await.0
    }

    async fn ready_controller_with(
        rows: Vec<TunnelRow>,
    ) -> (ControllerHandle, crate::ProxyControlSession) {
        let controller = crate::spawn_controller(100);
        let (proxy_id, session) = begin_proxy(&controller, "p1", rows).await;
        let mut sessions = vec![(proxy_id, session)];
        keep_alive_until_ready(&controller, &mut sessions).await;
        assert!(controller.is_ready().await.unwrap());
        let (_, session) = sessions.pop().unwrap();
        (controller, session)
    }

    async fn recv_kill_command(session: &mut crate::ProxyControlSession) -> (Uuid, Vec<Uuid>) {
        loop {
            let frame = session.commands.recv().await.unwrap();
            if let ServerFrame::KillRegistrations {
                command_id,
                registration_ids,
            } = frame
            {
                return (command_id, registration_ids);
            }
        }
    }

    #[tokio::test]
    async fn health_is_live_while_ready_and_admin_reads_are_warming() {
        let app = router(crate::spawn_controller(100), "secret".to_string());
        assert_eq!(
            request(app.clone(), "/healthz", None).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            request(app.clone(), "/readyz", None).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            request(app.clone(), "/admin/v1/tunnels", None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(app.clone(), "/admin/v1/tunnels", Some("secret"))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            request(app, "/admin/v1/tunnels/watch", Some("secret"))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn fresh_warming_controller_reports_session_revocation_as_partial() {
        let app = router(crate::spawn_controller(100), "secret".to_string());
        let response = post_json(
            app,
            "/admin/v1/sessions/revoke",
            Some("secret"),
            serde_json::json!({
                "scope": "subject",
                "subject_user_id": Uuid::new_v4(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["fleet_authority_ready"], false);
        assert_eq!(body["proxies_confirmed"], 0);
        assert_eq!(body["proxies_expected"], 0);
    }

    #[tokio::test]
    async fn scoped_admin_credentials_reject_cross_scope_endpoints() {
        let credentials = crate::config::AdminCredentials::for_test(
            "operator-token",
            "identity-token",
            "profile-token",
        );
        let app = router(crate::spawn_controller(100), credentials);
        let owner = "616c6963-6500-0000-0000-000000000001";

        assert_eq!(
            request(app.clone(), "/admin/v1/tunnels", Some("identity-token"))
                .await
                .status(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            request(
                app.clone(),
                &format!("/admin/v1/owners/{owner}/tunnels"),
                Some("identity-token"),
            )
            .await
            .status(),
            StatusCode::SERVICE_UNAVAILABLE,
        );
        assert_eq!(
            request(
                app.clone(),
                "/admin/v1/tunnels/watch",
                Some("profile-token"),
            )
            .await
            .status(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            request(app.clone(), "/admin/v1/tunnels", Some("profile-token"))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE,
        );
        assert_eq!(
            request(app, "/admin/v1/tunnels/watch", Some("operator-token"),)
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE,
        );
    }

    #[tokio::test]
    async fn profile_scope_cannot_expand_legacy_revocation_to_identity_actions() {
        let credentials = crate::config::AdminCredentials::for_test(
            "operator-token",
            "identity-token",
            "profile-token",
        );
        let app = router(crate::spawn_controller(100), credentials);

        for body in [
            serde_json::json!({"scope": "all"}),
            serde_json::json!({
                "scope": "owner",
                "owner_user_id": Uuid::new_v4(),
            }),
            serde_json::json!({
                "scope": "session_id",
                "admin_session_id": Uuid::new_v4(),
            }),
        ] {
            assert_eq!(
                post_json(
                    app.clone(),
                    "/admin/v1/sessions/revoke",
                    Some("profile-token"),
                    body,
                )
                .await
                .status(),
                StatusCode::FORBIDDEN,
            );
        }

        assert_eq!(
            post_json(
                app,
                "/admin/v1/sessions/revoke",
                Some("profile-token"),
                serde_json::json!({
                    "scope": "subject",
                    "subject_user_id": Uuid::new_v4(),
                }),
            )
            .await
            .status(),
            StatusCode::BAD_GATEWAY,
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ready_admin_returns_aggregate_snapshots() {
        let app = router(ready_controller().await, "secret".to_string());
        assert_eq!(
            request(app.clone(), "/readyz", None).await.status(),
            StatusCode::OK
        );

        let tunnels = request(app.clone(), "/admin/v1/tunnels", Some("secret")).await;
        assert_eq!(tunnels.status(), StatusCode::OK);
        assert_eq!(
            tunnels.into_body().collect().await.unwrap().to_bytes(),
            "[]"
        );

        let proxies = request(app, "/admin/v1/proxies", Some("secret")).await;
        assert_eq!(proxies.status(), StatusCode::OK);
        let body = proxies.into_body().collect().await.unwrap().to_bytes();
        let rows: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["proxy_id"], "p1");
    }

    #[tokio::test(start_paused = true)]
    async fn fleet_tunnel_list_redacts_peer_pii_but_owner_detail_preserves_it() {
        let mut tunnel = row("alice", "one", Uuid::new_v4());
        tunnel.peer_addr = Some("203.0.113.7:4321".parse().unwrap());
        let (controller, _session) = ready_controller_with(vec![tunnel]).await;
        let app = router(controller, "secret".to_string());

        let fleet = request(app.clone(), "/admin/v1/tunnels", Some("secret")).await;
        let fleet: serde_json::Value =
            serde_json::from_slice(&fleet.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert!(fleet[0]["peer_addr"].is_null());

        let owner = request(
            app,
            "/admin/v1/owners/616c6963-6500-0000-0000-000000000001/tunnels",
            Some("secret"),
        )
        .await;
        let owner: serde_json::Value =
            serde_json::from_slice(&owner.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(owner[0]["peer_addr"], "203.0.113.7:4321");
    }

    #[tokio::test(start_paused = true)]
    async fn sse_watcher_budget_is_shared_bounded_and_released_on_drop() {
        let app = router(ready_controller().await, "secret".to_string());
        let mut held = Vec::with_capacity(MAX_SSE_WATCHERS);
        for index in 0..MAX_SSE_WATCHERS {
            let path = if index % 2 == 0 {
                "/admin/v1/tunnels/watch"
            } else {
                "/admin/v1/proxies/watch"
            };
            let response = request(app.clone(), path, Some("secret")).await;
            assert_eq!(response.status(), StatusCode::OK, "watcher {index}");
            held.push(response);
        }

        let refused = request(app.clone(), "/admin/v1/tunnels/watch", Some("secret")).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);

        drop(held.pop());
        let reopened = request(app, "/admin/v1/proxies/watch", Some("secret")).await;
        assert_eq!(reopened.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn kill_routes_and_owner_read_are_warming_until_ready() {
        let app = router(crate::spawn_controller(100), "secret".to_string());
        assert_eq!(
            request(
                app.clone(),
                "/admin/v1/owners/616c6963-6500-0000-0000-000000000001/tunnels",
                Some("secret"),
            )
            .await
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            post(
                app.clone(),
                "/admin/v1/tunnels/616c6963-6500-0000-0000-000000000001/one/kill",
                Some("secret")
            )
            .await
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            post(
                app,
                "/admin/v1/owners/616c6963-6500-0000-0000-000000000001/tunnels/kill",
                Some("secret"),
            )
            .await
            .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test(start_paused = true)]
    async fn admin_404_matrix() {
        let (controller, _session) =
            ready_controller_with(vec![row("alice", "one", Uuid::new_v4())]).await;
        let app = router(controller, "secret".to_string());

        let invalid = request(
            app.clone(),
            "/admin/v1/owners/invalid/tunnels",
            Some("secret"),
        )
        .await;
        assert_eq!(invalid.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            invalid.into_body().collect().await.unwrap().to_bytes(),
            r#"{"error":"not found"}"#
        );

        let empty = request(
            app.clone(),
            "/admin/v1/owners/626f6200-0000-0000-0000-000000000001/tunnels",
            Some("secret"),
        )
        .await;
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(empty.into_body().collect().await.unwrap().to_bytes(), "[]");

        let unknown_user = post(
            app.clone(),
            "/admin/v1/tunnels/626f6200-0000-0000-0000-000000000001/one/kill",
            Some("secret"),
        )
        .await;
        assert_eq!(unknown_user.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            unknown_user.into_body().collect().await.unwrap().to_bytes(),
            r#"{"error":"not found"}"#
        );

        let unknown_devserver = post(
            app.clone(),
            "/admin/v1/tunnels/616c6963-6500-0000-0000-000000000001/two/kill",
            Some("secret"),
        )
        .await;
        assert_eq!(unknown_devserver.status(), StatusCode::NOT_FOUND);

        let invalid_kill = post(app, "/admin/v1/owners/invalid/tunnels/kill", Some("secret")).await;
        assert_eq!(invalid_kill.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            invalid_kill.into_body().collect().await.unwrap().to_bytes(),
            r#"{"error":"not found"}"#
        );
    }

    #[tokio::test(start_paused = true)]
    async fn exact_kill_returns_204_when_the_proxy_confirms() {
        let registration_id = Uuid::new_v4();
        let (controller, mut session) =
            ready_controller_with(vec![row("alice", "one", registration_id)]).await;
        let proxy_id = ProxyId::parse("p1").unwrap();
        let app = router(controller.clone(), "secret".to_string());

        let pending = tokio::spawn(post(
            app,
            "/admin/v1/tunnels/616c6963-6500-0000-0000-000000000001/one/kill",
            Some("secret"),
        ));
        let (command_id, registration_ids) = recv_kill_command(&mut session).await;
        assert_eq!(registration_ids, vec![registration_id]);
        controller
            .command_result(
                proxy_id,
                session.incarnation,
                command_id,
                registration_ids,
                Vec::new(),
                Vec::new(),
            )
            .await
            .unwrap();
        let response = pending.await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(controller.tunnels().await.unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn owner_kill_counts_killed_and_missing_and_retries_empty() {
        let killed = Uuid::new_v4();
        let missing = Uuid::new_v4();
        let bob_registration = Uuid::new_v4();
        let (controller, mut session) = ready_controller_with(vec![
            row("alice", "one", killed),
            row("alice", "two", missing),
            row("bob", "one", bob_registration),
        ])
        .await;
        let proxy_id = ProxyId::parse("p1").unwrap();
        let app = router(controller.clone(), "secret".to_string());

        let pending = tokio::spawn(post(
            app.clone(),
            "/admin/v1/owners/616c6963-6500-0000-0000-000000000001/tunnels/kill",
            Some("secret"),
        ));
        let (command_id, registration_ids) = recv_kill_command(&mut session).await;
        assert_eq!(registration_ids.len(), 2);
        assert!(!registration_ids.contains(&bob_registration));
        controller
            .command_result(
                proxy_id,
                session.incarnation,
                command_id,
                vec![killed],
                vec![missing],
                Vec::new(),
            )
            .await
            .unwrap();
        let response = pending.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            r#"{"killed":2}"#
        );

        // A retry has nothing left to kill and is a success, not an error.
        let retry = post(
            app,
            "/admin/v1/owners/616c6963-6500-0000-0000-000000000001/tunnels/kill",
            Some("secret"),
        )
        .await;
        assert_eq!(retry.status(), StatusCode::OK);
        assert_eq!(
            retry.into_body().collect().await.unwrap().to_bytes(),
            r#"{"killed":0}"#
        );
    }

    #[tokio::test(start_paused = true)]
    async fn owner_kill_reports_partial_when_a_proxy_disconnects() {
        let controller = crate::spawn_controller(100);
        let (p1, s1) =
            begin_proxy(&controller, "p1", vec![row("alice", "one", Uuid::new_v4())]).await;
        let (p2, s2) =
            begin_proxy(&controller, "p2", vec![row("alice", "two", Uuid::new_v4())]).await;
        let mut sessions = vec![(p1.clone(), s1), (p2.clone(), s2)];
        keep_alive_until_ready(&controller, &mut sessions).await;
        assert!(controller.is_ready().await.unwrap());
        let mut sessions: std::collections::HashMap<_, _> = sessions.into_iter().collect();
        let app = router(controller.clone(), "secret".to_string());

        let pending = tokio::spawn(post(
            app,
            "/admin/v1/owners/616c6963-6500-0000-0000-000000000001/tunnels/kill",
            Some("secret"),
        ));
        let s1 = sessions.get_mut(&p1).unwrap();
        let (command_id, registration_ids) = recv_kill_command(s1).await;
        controller
            .command_result(
                p1.clone(),
                s1.incarnation,
                command_id,
                registration_ids,
                Vec::new(),
                Vec::new(),
            )
            .await
            .unwrap();
        let p2_incarnation = sessions.get(&p2).unwrap().incarnation;
        controller.disconnect(p2, p2_incarnation).await.unwrap();

        let response = pending.await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            r#"{"error":"partial kill","killed":1}"#
        );
    }
}
