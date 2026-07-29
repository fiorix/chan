use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use tokio::sync::watch;
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::entry_replay::EntryReplayCache;
use crate::registry::Registry;
use crate::session_store::SessionStore;

/// Application state passed to every handler. Holds no cookie or
/// session machinery; devserver-proxy reads no cookie other than the
/// `__Host-devserver_gate` issued by the proxy gate itself.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub registry: Registry,
    pub readiness: watch::Receiver<bool>,
    pub sessions: SessionStore,
    pub entry_replays: EntryReplayCache,
}

pub fn router(
    cfg: Arc<Config>,
    registry: Registry,
    readiness: watch::Receiver<bool>,
    sessions: SessionStore,
) -> Router {
    let state = AppState {
        entry_replays: EntryReplayCache::new(cfg.entry_replay_max_active),
        cfg,
        registry,
        readiness,
        sessions,
    };
    Router::new()
        // Liveness and control readiness exist only on the configured
        // apex. The handlers enforce Host because axum routes are not
        // host-specific and wildcard tenant traffic shares this listener.
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        // Single fallback that dispatches on the Host header. The node
        // apex (p1.usr.chan.app) only carries health/readiness; everything
        // else 404s. The node wildcard ({user}--{disc}.p1.usr.chan.app)
        // hands off to the proxy module.
        .fallback(dispatch)
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

async fn healthz(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if request_is_apex(&state, &headers) {
        (StatusCode::OK, "ok").into_response()
    } else {
        (StatusCode::NOT_FOUND, "not found").into_response()
    }
}

async fn readyz(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    if !request_is_apex(&state, &headers) {
        StatusCode::NOT_FOUND
    } else if *state.readiness.borrow() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

fn request_is_apex(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| state.cfg.is_apex(host))
}

/// Host-keyed dispatch. The router has no static routes for the
/// wildcard surface (`/`, `/{workspace}`, `/{workspace}/*`) because every
/// request to a wildcard host must first parse `{user}` out of the
/// header. axum's per-host routing requires the same layer stack on
/// each route, so we resolve at the request level instead.
///
/// We deliberately do NOT use axum's `Host` extractor: it consults
/// `Forwarded` and `X-Forwarded-Host` before the actual `Host`
/// header. Both are client-controllable on this listener (nginx may
/// scrub them, but the gateway must not assume so), and that
/// extractor would let a hostile client route their request to a
/// different tenant's wildcard surface by spoofing XFH. We read the
/// raw `Host` header directly here.
async fn dispatch(State(state): State<AppState>, req: Request) -> Response {
    let cfg = &state.cfg;
    let host = match req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
    {
        Some(h) => h.to_string(),
        None => return (StatusCode::BAD_REQUEST, "missing host").into_response(),
    };
    // Apex: only health/readiness routes are wired explicitly; this
    // fallback says everything else on the apex is 404.
    if cfg.is_apex(&host) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let Some((user, disc)) = cfg.parse_wildcard_host(&host) else {
        // Host header that is neither the apex nor a recognized
        // wildcard subdomain (a malformed `--` disc form included).
        // Reject so a misrouted public listener doesn't expose the
        // proxy by accident.
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };

    // Wildcard root `/`: an UNAUTHENTICATED bare-domain hit bounces to the
    // dashboard front door (id.chan.app/workspaces in prod, configurable
    // via DASHBOARD_URL) -- devserver-proxy renders no UI of its own, and an
    // unauthenticated launcher can't call `/api/library/*` (it needs the
    // session cookie), so the dashboard is where you sign in and Open.
    //
    // A root request that DOES carry a `__Host-devserver_gate` session cookie is a
    // whole-devserver open: fall
    // through to the gate, which forwards `/` to the devserver root where
    // the launcher SPA is served. `proxy::handle` is segment-preserving, so
    // `/` forwards unchanged.
    let path = req.uri().path();
    if (path == "/" || path.is_empty())
        && !crate::proxy::has_gate_credential(req.uri(), req.headers())
    {
        return Redirect::to(&cfg.dashboard_url).into_response();
    }

    // Otherwise hand off to the proxy module. It resolves the
    // devserver (disc prefix or gate credential) and applies the gate.
    crate::proxy::handle(state.clone(), user, disc, req).await
}

// dashboard_url derivation lives in Config::from_env; the
// dispatcher just reads cfg.dashboard_url here.
