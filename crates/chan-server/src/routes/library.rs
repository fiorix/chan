//! The launcher SPA root surface + the `/api/library/*` serve handlers.
//!
//! `web/packages/launcher` is a pure `/api/library/*` HTTP client served at the
//! devserver/library root `/`. chan-library's `host_dispatch` 404s the root
//! (it only matches workspace-tenant prefixes); this module builds the router
//! the embedder installs as the host's root fallback
//! (`WorkspaceHost::install_root_fallback`) so `/` serves the launcher and
//! `/api/library/*` reaches the library handles. It lives in chan-server, not
//! chan-library, because it serves a frontend bundle and the crate dependency
//! only flows chan-server -> chan-library.
//!
//! ONE bundle, installed on BOTH surfaces -- the headless devserver
//! (`build_devserver_app`) and the desktop loopback (`embedded.rs`) -- over the
//! shared [`WorkspaceHost`].

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use chan_library::{allocate_workspace_prefix, ServeConfig};
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Notify};

use crate::devserver::bytes_eq;
use crate::static_assets::{serve_launcher, LauncherSurface};
use crate::{
    CreateWindow, DesktopWindowOp, DevserverEntry, DevserverInput, GatewayEntry, GatewayInput,
    LauncherWorkspace, SetWorkspaceOnOutcome, WindowKind, WindowOrigin, WindowRecord, WindowSet,
    WorkspaceHost, WorkspaceLifecycleOutcome, WorkspaceStatus,
};

/// State shared by the `/api/library/workspaces` handlers: the library host plus
/// the surface's serve address. `serve_addr` is the read-only/full discriminator
/// AND the mount enabler:
///   - `Some(cell)` -- the desktop loopback (single-user, token-gated). Workspace
///     MUTATION (add/on/off/rm) is served; mounting needs the listen address,
///     which the embedder fills into the `OnceLock` after it binds (the install
///     happens before the bind, so the cell is read at request time).
///   - `None` -- the tunnel-trust devserver/gateway surface. Workspaces are
///     READ-ONLY: a grantee holding a `__Host-devserver_gate` cookie must not mutate the
///     owner's library, and `bearer=None` can't enforce role. The mutation
///     handlers answer 403 there.
struct LauncherState {
    host: Arc<WorkspaceHost>,
    serve_addr: Option<Arc<OnceLock<SocketAddr>>>,
}

const COMMAND_CAPABILITY_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CommandCapabilityRole {
    Owner,
    Readonly,
}

#[derive(Clone)]
struct LibraryCommandCapability {
    token: String,
    window_id: String,
    tenant_prefix: String,
    role: CommandCapabilityRole,
    expires_at: Instant,
}

struct LibraryCommandState {
    host: Arc<WorkspaceHost>,
    bearer_required: bool,
    capabilities: std::sync::Mutex<HashMap<String, LibraryCommandCapability>>,
}

/// The `windows/watch` WS path: the one `/api/library/*` route that accepts the
/// bearer as a `?t=` query param, because a browser WebSocket cannot set an
/// `Authorization` header. Every other route requires the header (a query token
/// leaks through URL logs and the SPA `fetch` can set the header).
const WATCH_WS_PATH: &str = "/api/library/windows/watch";

/// The local-colour watch WS path -- the other `/api/library/*` route that
/// accepts the bearer as `?t=` (a browser WebSocket can't set a header), same
/// rationale as [`WATCH_WS_PATH`].
const LOCAL_COLOR_WATCH_WS_PATH: &str = "/api/library/local-color/watch";

/// The local-theme watch WS path; accepts the bearer as `?t=` for the same
/// reason as [`LOCAL_COLOR_WATCH_WS_PATH`].
const LOCAL_THEME_WATCH_WS_PATH: &str = "/api/library/local-theme/watch";

/// The launcher bearer, shared as a cell rather than a `String`: the
/// devserver's rotate verb swaps the value in place, and every gate that
/// holds a clone of the `Arc` (the launcher-management gate, the surface
/// gate, and the management router's own `require_bearer`) reads the
/// current value per request, so one write retires the old bearer on
/// every surface at once.
pub type LauncherBearer = Arc<std::sync::RwLock<String>>;

/// Build the launcher router installed as the [`WorkspaceHost`] root fallback:
/// the static launcher SPA ([`serve_launcher`]) plus the host-backed
/// `/api/library/*` data surface (windows today; workspaces next). One bundle,
/// installed on both surfaces so the launcher is functional everywhere.
///
/// `bearer` is the per-surface launcher token: `Some` gates `/api/library/*` on
/// `Authorization: Bearer <token>` (the watch WS additionally accepts
/// `?t=<token>`); `None` leaves the data surface public (tests / the
/// tunnel-trust install). The static SPA shell is ALWAYS public so it can
/// load before it holds the token -- the SPA then reads `?t=` from its URL and
/// presents it on every data call.
pub fn launcher_router(
    host: Arc<WorkspaceHost>,
    bearer: Option<LauncherBearer>,
    serve_addr: Option<Arc<OnceLock<SocketAddr>>>,
) -> Router {
    // The launcher surface descriptor the injected meta advertises: no serve
    // address is the tunnel-trust read-only surface; a serve address plus a
    // desktop bridge is the desktop loopback; a serve address without one is a
    // local devserver loopback (browser-managed windows). The mutation handlers
    // still gate on `serve_addr` via `require_mutable`; this only shapes the meta.
    let surface = if serve_addr.is_none() {
        LauncherSurface::ReadOnly
    } else if host.has_desktop_bridge() {
        LauncherSurface::Desktop
    } else {
        LauncherSurface::Devserver
    };
    let command_state = Arc::new(LibraryCommandState {
        host: host.clone(),
        bearer_required: bearer.is_some(),
        capabilities: std::sync::Mutex::new(HashMap::new()),
    });
    // Windows: list/mint/discard on BOTH surfaces (per-view state, low-risk).
    let windows = Router::new()
        .route(
            "/api/library/windows",
            get(handle_list_library_windows).post(handle_create_library_window),
        )
        .route(
            "/api/library/windows/watch",
            get(handle_watch_library_windows),
        )
        .route(
            "/api/library/windows/{window_id}",
            delete(handle_discard_library_window),
        )
        .route(
            "/api/library/windows/{window_id}/open",
            post(handle_open_library_window),
        )
        .route(
            "/api/library/windows/{window_id}/hide",
            post(handle_hide_library_window),
        )
        .route(
            "/api/library/windows/{window_id}/close",
            post(handle_close_library_window),
        )
        .route(
            "/api/library/windows/{window_id}/label",
            put(handle_set_library_window_label),
        )
        // SET the server-persisted visibility (the durable source of
        // truth the desktop mirrors on connect). Distinct from /open + /hide
        // above, which dispatch a desktop-bridge op on the NATIVE window and do
        // NOT persist.
        .route(
            "/api/library/windows/{window_id}/visibility",
            post(handle_set_library_window_visibility),
        )
        // Devserver connect is a desktop-bridge dispatch (like window open/hide),
        // not registry CRUD, so it lives here on the host-stated router rather
        // than the `LauncherState` devservers block. No `require_mutable` gate:
        // a surface with no desktop bridge answers `NO_DESKTOP`/409 on its own.
        .route(
            "/api/library/devservers/{id}/connect",
            post(handle_connect_devserver),
        )
        // The connected-devserver bridge ops mirror connect: a desktop drains
        // them, a desktop-less surface answers NO_DESKTOP/409. Only the slash-free
        // devserver `{id}` is in the path; the workspace `prefix`/`path` ride the
        // JSON body (a structured prefix in a path segment is proxy-fragile).
        .route(
            "/api/library/devservers/{id}/disconnect",
            post(handle_disconnect_devserver),
        )
        .route(
            "/api/library/devservers/{id}/native-trust",
            put(handle_grant_devserver_native_trust).delete(handle_revoke_devserver_native_trust),
        )
        .route(
            "/api/library/devservers/{id}/terminal",
            post(handle_devserver_terminal),
        )
        .route(
            "/api/library/devservers/{id}/workspaces/open",
            post(handle_open_devserver_workspace),
        )
        .route(
            "/api/library/devservers/{id}/workspaces/on",
            post(handle_devserver_workspace_on),
        )
        .route(
            "/api/library/devservers/{id}/workspaces/off",
            post(handle_devserver_workspace_off),
        )
        .route(
            "/api/library/devservers/{id}/workspaces/forget",
            post(handle_forget_devserver_workspace),
        )
        // Gateway connect/disconnect are desktop-bridge dispatches like the
        // devserver ops above -- they operate live connection state, not
        // registry CRUD -- so a desktop-less surface answers NO_DESKTOP/409
        // on its own.
        .route(
            "/api/library/gateways/{id}/connect",
            post(handle_connect_gateway),
        )
        .route(
            "/api/library/gateways/{id}/disconnect",
            post(handle_disconnect_gateway),
        )
        // Native folder picker -- another desktop-bridge dispatch (the launcher's
        // New-Workspace "Browse…"), so it sits with the other bridge ops.
        .route("/api/library/fs/pick-folder", post(handle_pick_folder))
        .merge(tunnel_legs())
        .route_layer(middleware::from_fn(require_local_mutation))
        .with_state(host.clone());
    // Workspaces: list always; the mutation routes are always present but
    // refuse with 403 on the read-only surface (gated by `serve_addr` inside the
    // handlers), so a direct call can never escalate to mutation.
    let workspaces = Router::new()
        .route(
            "/api/library/workspaces",
            get(handle_list_workspaces).post(handle_add_workspace),
        )
        .route("/api/library/workspaces/{id}/on", post(handle_workspace_on))
        .route(
            "/api/library/workspaces/{id}/off",
            post(handle_workspace_off),
        )
        .route(
            "/api/library/workspaces/{id}",
            delete(handle_remove_workspace),
        )
        .route_layer(middleware::from_fn(require_local_mutation))
        .with_state(Arc::new(LauncherState {
            host: host.clone(),
            serve_addr: serve_addr.clone(),
        }));
    // Library config: this library's own pane-highlight colour. GET + PUT on
    // EVERY surface (a no-store surface reports `null` = default accent / 404s the
    // PUT): a library's colour belongs to that library, set from a pane's
    // focus-border menu on its own serving host -- a devserver window sets ITS
    // devserver's colour. The bearer gate is the auth (no `require_mutable`: it
    // mutates the surface's own library, not someone else's).
    let config = Router::new()
        .route(
            "/api/library/local-color",
            get(handle_get_local_color).put(handle_set_local_color),
        )
        .route(
            "/api/library/local-color/watch",
            get(handle_watch_local_color),
        )
        .route(
            "/api/library/local-theme",
            get(handle_get_local_theme).put(handle_set_local_theme),
        )
        .route(
            "/api/library/local-theme/watch",
            get(handle_watch_local_theme),
        )
        .route(
            "/api/library/collapsed-machines",
            get(handle_get_collapsed_machines).put(handle_set_collapsed_machines),
        )
        .route_layer(middleware::from_fn(require_local_mutation))
        .with_state(Arc::new(LauncherState {
            host: host.clone(),
            serve_addr: serve_addr.clone(),
        }));
    // Captured before `host` is moved into the devservers state below: the
    // surface-bearer gate needs the host to validate a window's per-tenant
    // token against the live tenants.
    let host_for_surface = host.clone();
    // A workspace mints one short-lived, live-window-bound capability with its
    // own tenant token. Uses are authenticated by the opaque capability itself,
    // so the browser can navigate a popup through the launch redirect without
    // putting a full tenant or launcher bearer in the source page.
    let command_mint = Router::new()
        .route(
            "/api/library/command-capabilities",
            post(handle_mint_library_command_capability),
        )
        .route_layer(middleware::from_fn(command_capability_response_headers))
        .with_state(command_state.clone());
    let command_mint = if let Some(surface_token) = bearer.clone() {
        let host = host_for_surface.clone();
        command_mint.route_layer(middleware::from_fn(move |req, next| {
            let token = surface_token.clone();
            let host = host.clone();
            async move { require_surface_bearer(token, host, req, next).await }
        }))
    } else {
        command_mint
    };
    let command_uses = Router::new()
        .route(
            "/api/library/command-capabilities/{capability}",
            get(handle_library_command_snapshot),
        )
        .route(
            "/api/library/command-capabilities/{capability}/actions",
            post(handle_library_command_action),
        )
        .route(
            "/api/library/command-capabilities/{capability}/windows/{window_id}/launch",
            get(handle_library_command_launch),
        )
        .route_layer(middleware::from_fn(command_capability_response_headers))
        .with_state(command_state);
    // Gateways: list on BOTH surfaces (a registry-less surface returns
    // empty); add/update/remove gated mutable (403 read-only, 404 no
    // registry) inside the handlers, same as the devserver block below.
    let gateways = Router::new()
        .route(
            "/api/library/gateways",
            get(handle_list_gateways).post(handle_add_gateway),
        )
        .route(
            "/api/library/gateways/{id}",
            put(handle_update_gateway).delete(handle_remove_gateway),
        )
        .route_layer(middleware::from_fn(require_local_mutation))
        .with_state(Arc::new(LauncherState {
            host: host.clone(),
            serve_addr: serve_addr.clone(),
        }));
    // Devservers: list on BOTH surfaces (a registry-less surface returns empty);
    // add/update/remove gated mutable (403 read-only, 404 no registry) inside the
    // handlers, same as workspaces.
    let devservers = Router::new()
        .route(
            "/api/library/devservers",
            get(handle_list_devservers).post(handle_add_devserver),
        )
        .route(
            "/api/library/devservers/{id}",
            put(handle_update_devserver).delete(handle_remove_devserver),
        )
        .route_layer(middleware::from_fn(require_local_mutation))
        .with_state(Arc::new(LauncherState { host, serve_addr }));
    // The launcher-management routes (windows / workspaces / devservers) stay
    // gated on the launcher token. The local-color (`config`) routes set the
    // surface's OWN cosmetic colour from a pane menu, called by whatever window
    // is open -- which carries a per-TENANT token, not the launcher token -- so
    // they get a relaxed SURFACE gate (launcher OR any valid tenant token). A
    // launcher-only gate 401'd every window's colour GET/PUT/watch.
    let launcher_api = windows.merge(workspaces).merge(gateways).merge(devservers);
    let (launcher_api, config) = match bearer {
        Some(token) => {
            let launcher_token = token.clone();
            let surface_token = token;
            let launcher_api = launcher_api.route_layer(middleware::from_fn(move |req, next| {
                let token = launcher_token.clone();
                async move { require_launcher_bearer(token, req, next).await }
            }));
            let config = config.route_layer(middleware::from_fn(move |req, next| {
                let token = surface_token.clone();
                let host = host_for_surface.clone();
                async move { require_surface_bearer(token, host, req, next).await }
            }));
            (launcher_api, config)
        }
        None => (launcher_api, config),
    };
    let api = launcher_api
        .merge(config)
        .merge(command_mint)
        .merge(command_uses);
    // The static SPA shell is ALWAYS public (loads before it holds the token) and
    // carries the surface hint so the SPA hides mutation controls on a read-only
    // surface rather than showing buttons that 403. A tunnel-origin owner keeps
    // the router's native surface (the full devserver launcher); a tunnel-origin
    // non-owner is downgraded to `readonly`. The `require_local_mutation` gate
    // enforces the same role split on the data routes.
    Router::new()
        .merge(api)
        .fallback(move |req: Request<Body>| {
            let effective = if tunnel_owner(&req) {
                surface
            } else if req.extensions().get::<crate::TunnelOrigin>().is_some() {
                LauncherSurface::ReadOnly
            } else {
                surface
            };
            serve_launcher(req.uri().clone(), effective)
        })
}

/// Gate `/api/library/*` on the surface's launcher token. Tunnel-origin
/// requests already passed the gateway's `__Host-devserver_gate` check and arrive with
/// client credentials stripped, so they bypass this local bearer; owner vs
/// non-owner mutation is enforced separately by [`require_local_mutation`].
/// Other requests accept the token in the `Authorization: Bearer` header on
/// every route, and additionally as the `?t=` query param on watch WebSockets
/// (a browser WS can't header). The comparison is constant-time so a wrong token
/// leaks no position info.
async fn require_launcher_bearer(
    token: LauncherBearer,
    req: Request<Body>,
    next: Next,
) -> Response {
    if req.extensions().get::<crate::TunnelOrigin>().is_some() {
        return next.run(req).await;
    }
    let header_token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let path = req.uri().path();
    let query_token = (path == WATCH_WS_PATH
        || path == LOCAL_COLOR_WATCH_WS_PATH
        || path == LOCAL_THEME_WATCH_WS_PATH
        // The tunnel WS legs are desktop-dialed; a WebSocket client cannot
        // always set the header, so they get the same `?t=` allowance.
        || path == chan_revtunnel::wire::CONTROL_PATH
        || path == chan_revtunnel::wire::CONN_PATH)
        .then(|| req.uri().query().and_then(query_bearer))
        .flatten();
    // Read the shared cell in a block so the guard drops before the await.
    let authorized = {
        let expected = token.read().unwrap_or_else(|e| e.into_inner());
        let expected = expected.as_bytes();
        header_token.is_some_and(|t| bytes_eq(t.as_bytes(), expected))
            || query_token.is_some_and(|t| bytes_eq(t.as_bytes(), expected))
    };
    if authorized {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            "missing or invalid launcher bearer token",
        )
            .into_response()
    }
}

/// Gate the local-color (`config`) sub-router on ANY valid SURFACE token: the
/// launcher token OR a live per-tenant/window token this host serves. Unlike
/// [`require_launcher_bearer`] (launcher-MANAGEMENT routes), the local-color
/// routes set the surface's OWN cosmetic library colour from a pane's
/// focus-border menu -- and a window is served with its per-TENANT token, not the
/// launcher token (`desktop/src-tauri/src/serve.rs` `?t={record.token}`). A
/// launcher-only gate therefore hard-401s every real window's GET/PUT/watch, so
/// the colour never persists and a fresh window seeds blue. Tunnel-origin
/// requests already passed the gateway auth boundary and carry no client
/// credentials, so they are admitted here too. Accepts the same `Bearer` header
/// and watch-WS `?t=` forms; comparisons are constant-time. A shared
/// chan-server route, so this admits BOTH local and devserver windows in one
/// place.
async fn require_surface_bearer(
    launcher_token: LauncherBearer,
    host: Arc<WorkspaceHost>,
    req: Request<Body>,
    next: Next,
) -> Response {
    if req.extensions().get::<crate::TunnelOrigin>().is_some() {
        return next.run(req).await;
    }
    let header_token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let path = req.uri().path();
    let query_token = (path == WATCH_WS_PATH
        || path == LOCAL_COLOR_WATCH_WS_PATH
        || path == LOCAL_THEME_WATCH_WS_PATH)
        .then(|| req.uri().query().and_then(query_bearer))
        .flatten();
    // A token is valid for this surface if it is the launcher token OR any live
    // tenant token this host serves (the window's own `?t=`/Bearer token).
    // The launcher cell is read in a block so the guard drops before the await.
    let authorized = {
        let launcher = launcher_token.read().unwrap_or_else(|e| e.into_inner());
        let valid = |t: &str| {
            bytes_eq(t.as_bytes(), launcher.as_bytes())
                || host.any_tenant_token(|tok| bytes_eq(tok.as_bytes(), t.as_bytes()))
        };
        header_token.is_some_and(valid) || query_token.is_some_and(valid)
    };
    if authorized {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            "missing or invalid surface bearer token",
        )
            .into_response()
    }
}

// ---------------------------------------------------------------------------
// Scoped command capability (workspace/terminal -> invoking library only).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MintLibraryCommandCapability {
    window_id: String,
    tenant_prefix: String,
}

#[derive(Serialize)]
struct MintedLibraryCommandCapability {
    token: String,
    role: CommandCapabilityRole,
    expires_in_seconds: u64,
}

#[derive(Serialize)]
struct ScopedLibraryWindow {
    window_id: String,
    kind: WindowKind,
    title: String,
    ordinal: u32,
    label: String,
    workspace_path: Option<String>,
    connected: bool,
    hidden: bool,
    control: bool,
    can_act: bool,
    launch_path: String,
}

#[derive(Serialize)]
struct ScopedLibraryWorkspace {
    #[serde(flatten)]
    workspace: LauncherWorkspace,
    can_act: bool,
}

#[derive(Serialize)]
struct ScopedLibrarySnapshot {
    library_id: String,
    role: CommandCapabilityRole,
    windows: Vec<ScopedLibraryWindow>,
    workspaces: Vec<ScopedLibraryWorkspace>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ScopedLibraryAction {
    NewTerminal,
    NewWorkspaceWindow { workspace_id: String },
    SetWindowVisibility { window_id: String, hidden: bool },
    CloseWindow { window_id: String },
}

#[derive(Serialize)]
struct ScopedLibraryActionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<ScopedLibraryWindow>,
}

fn command_capability_error(status: StatusCode, message: &'static str) -> Response {
    (status, message).into_response()
}

async fn command_capability_response_headers(req: Request<Body>, next: Next) -> Response {
    let mut response = next.run(req).await;
    // Capability paths are bearer credentials. Keep them out of caches and out
    // of the Referer header when the launch redirect enters a tenant URL.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

fn resolve_command_capability(
    state: &LibraryCommandState,
    token: &str,
) -> Result<LibraryCommandCapability, (StatusCode, &'static str)> {
    let now = Instant::now();
    let mut capabilities = state
        .capabilities
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    capabilities.retain(|_, capability| capability.expires_at > now);
    let Some(capability) = capabilities.get(token).cloned() else {
        return Err((
            StatusCode::UNAUTHORIZED,
            "invalid or expired library command capability",
        ));
    };
    if !state
        .host
        .tenant_has_live_window(&capability.tenant_prefix, &capability.window_id)
    {
        capabilities.remove(token);
        return Err((StatusCode::GONE, "the invoking window is no longer live"));
    }
    if let Some(live) = capabilities.get_mut(token) {
        live.expires_at = now + COMMAND_CAPABILITY_TTL;
    }
    Ok(capability)
}

fn scoped_launch_path(capability: &str, window_id: &str) -> String {
    format!(
        "/api/library/command-capabilities/{}/windows/{}/launch",
        url::form_urlencoded::byte_serialize(capability.as_bytes()).collect::<String>(),
        url::form_urlencoded::byte_serialize(window_id.as_bytes()).collect::<String>(),
    )
}

fn scoped_window(
    capability: &LibraryCommandCapability,
    record: WindowRecord,
) -> ScopedLibraryWindow {
    ScopedLibraryWindow {
        launch_path: scoped_launch_path(&capability.token, &record.window_id),
        window_id: record.window_id,
        kind: record.kind,
        title: record.title,
        ordinal: record.ordinal,
        label: record.label,
        workspace_path: record.workspace_path,
        connected: record.connected,
        hidden: record.hidden,
        control: record.control,
        can_act: capability.role == CommandCapabilityRole::Owner,
    }
}

fn scoped_local_windows(
    host: &WorkspaceHost,
    capability: &LibraryCommandCapability,
) -> Vec<ScopedLibraryWindow> {
    let library_id = host.library_id();
    let mut rows: Vec<_> = host
        .assemble_window_records()
        .into_iter()
        .filter(|record| record.library_id == library_id)
        .map(|record| scoped_window(capability, record))
        .collect();
    rows.sort_by(|a, b| {
        // The registry's display order (control first, then Terminal before
        // Workspace), re-derived from the wire fields because the scoped row
        // forces the capability's own window ahead of it.
        let kind_rank = |row: &ScopedLibraryWindow| {
            if row.control {
                return 0;
            }
            match row.kind {
                WindowKind::Terminal => 1,
                WindowKind::Workspace => 2,
            }
        };
        (a.window_id != capability.window_id)
            .cmp(&(b.window_id != capability.window_id))
            .then_with(|| kind_rank(a).cmp(&kind_rank(b)))
            .then_with(|| a.ordinal.cmp(&b.ordinal))
            .then_with(|| a.window_id.cmp(&b.window_id))
    });
    rows
}

fn scoped_local_workspaces(
    host: &WorkspaceHost,
    role: CommandCapabilityRole,
) -> Vec<ScopedLibraryWorkspace> {
    let library_id = host.library_id().to_string();
    let mut rows: Vec<_> = host
        .library()
        .list_workspaces()
        .into_iter()
        .filter_map(|workspace| {
            let workspace_id = allocate_workspace_prefix(&workspace.root_path)
                .ok()?
                .trim_start_matches('/')
                .to_string();
            let (status, error) = host.workspace_status(&workspace.root_path);
            Some(ScopedLibraryWorkspace {
                workspace: LauncherWorkspace {
                    path: workspace.root_path.to_string_lossy().into_owned(),
                    label: workspace
                        .display_name
                        .clone()
                        .unwrap_or_else(|| workspace_label(&workspace.root_path)),
                    on: status == WorkspaceStatus::Running,
                    status,
                    error,
                    library_id: Some(library_id.clone()),
                    devserver_id: None,
                    prefix: workspace_id.clone(),
                    workspace_id,
                },
                can_act: role == CommandCapabilityRole::Owner,
            })
        })
        .collect();
    rows.sort_by(|a, b| a.workspace.workspace_id.cmp(&b.workspace.workspace_id));
    rows
}

async fn handle_mint_library_command_capability(
    State(state): State<Arc<LibraryCommandState>>,
    origin: Option<Extension<crate::TunnelOrigin>>,
    headers: HeaderMap,
    Json(request): Json<MintLibraryCommandCapability>,
) -> Response {
    if request.window_id.is_empty()
        || request.window_id.len() > 256
        || request.tenant_prefix.len() > 512
    {
        return command_capability_error(StatusCode::BAD_REQUEST, "invalid invoking window");
    }
    let role = origin
        .as_ref()
        .map(|origin| {
            if origin.owner() {
                CommandCapabilityRole::Owner
            } else {
                CommandCapabilityRole::Readonly
            }
        })
        .unwrap_or(CommandCapabilityRole::Owner);
    let authorized = if origin.is_some() {
        state
            .host
            .tenant_has_live_window(&request.tenant_prefix, &request.window_id)
    } else if state.bearer_required {
        let presented = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        presented.is_some_and(|presented| {
            state.host.tenant_token_has_live_window(
                &request.tenant_prefix,
                &request.window_id,
                |expected| bytes_eq(expected.as_bytes(), presented.as_bytes()),
            )
        })
    } else {
        state
            .host
            .tenant_has_live_window(&request.tenant_prefix, &request.window_id)
    };
    if !authorized {
        return command_capability_error(
            StatusCode::FORBIDDEN,
            "the tenant token does not own that live window",
        );
    }

    let token = crate::auth::random_token();
    let capability = LibraryCommandCapability {
        token: token.clone(),
        window_id: request.window_id,
        tenant_prefix: request.tenant_prefix,
        role,
        expires_at: Instant::now() + COMMAND_CAPABILITY_TTL,
    };
    let mut capabilities = state
        .capabilities
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    capabilities.retain(|_, live| {
        live.expires_at > Instant::now()
            && !(live.window_id == capability.window_id
                && live.tenant_prefix == capability.tenant_prefix)
    });
    capabilities.insert(token.clone(), capability);
    Json(MintedLibraryCommandCapability {
        token,
        role,
        expires_in_seconds: COMMAND_CAPABILITY_TTL.as_secs(),
    })
    .into_response()
}

async fn handle_library_command_snapshot(
    State(state): State<Arc<LibraryCommandState>>,
    AxumPath(capability): AxumPath<String>,
) -> Response {
    let capability = match resolve_command_capability(&state, &capability) {
        Ok(capability) => capability,
        Err(error) => return error.into_response(),
    };
    Json(ScopedLibrarySnapshot {
        library_id: state.host.library_id().to_string(),
        role: capability.role,
        windows: scoped_local_windows(&state.host, &capability),
        workspaces: scoped_local_workspaces(&state.host, capability.role),
    })
    .into_response()
}

async fn handle_library_command_action(
    State(state): State<Arc<LibraryCommandState>>,
    AxumPath(capability): AxumPath<String>,
    Json(action): Json<ScopedLibraryAction>,
) -> Response {
    let capability = match resolve_command_capability(&state, &capability) {
        Ok(capability) => capability,
        Err(error) => return error.into_response(),
    };
    if capability.role != CommandCapabilityRole::Owner {
        return command_capability_error(
            StatusCode::FORBIDDEN,
            "this gateway role may inspect but not control the library",
        );
    }
    let record = match action {
        ScopedLibraryAction::NewTerminal => {
            state
                .host
                .mint_window_with_origin(WindowKind::Terminal, None, WindowOrigin::Browser)
        }
        ScopedLibraryAction::NewWorkspaceWindow { workspace_id } => {
            let Some((_, root)) = resolve_workspace(&state.host, &workspace_id) else {
                return StatusCode::NOT_FOUND.into_response();
            };
            if state.host.workspace_status(&root).0 != WorkspaceStatus::Running {
                return command_capability_error(StatusCode::CONFLICT, "workspace is not running");
            }
            state.host.mint_window_with_origin(
                WindowKind::Workspace,
                Some(root.to_string_lossy().into_owned()),
                WindowOrigin::Browser,
            )
        }
        ScopedLibraryAction::SetWindowVisibility { window_id, hidden } => {
            let Some(record) = state
                .host
                .assemble_window_records()
                .into_iter()
                .find(|record| {
                    record.library_id == state.host.library_id() && record.window_id == window_id
                })
            else {
                return StatusCode::NOT_FOUND.into_response();
            };
            if record.control {
                return command_capability_error(
                    StatusCode::FORBIDDEN,
                    "control terminals are not managed by a browser capability",
                );
            }
            return match state.host.set_window_hidden(&window_id, hidden) {
                Ok(true) => StatusCode::NO_CONTENT.into_response(),
                Ok(false) => StatusCode::NOT_FOUND.into_response(),
                Err(error) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
                }
            };
        }
        ScopedLibraryAction::CloseWindow { window_id } => {
            let local = state
                .host
                .assemble_window_records()
                .into_iter()
                .any(|record| {
                    record.library_id == state.host.library_id()
                        && record.window_id == window_id
                        && !record.control
                });
            if !local {
                return StatusCode::NOT_FOUND.into_response();
            }
            return match state.host.discard_window(&window_id) {
                Ok(true) => StatusCode::NO_CONTENT.into_response(),
                Ok(false) => StatusCode::NOT_FOUND.into_response(),
                Err(error) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
                }
            };
        }
    };
    match record {
        Ok(record) => Json(ScopedLibraryActionResult {
            window: Some(scoped_window(&capability, record)),
        })
        .into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

async fn handle_library_command_launch(
    State(state): State<Arc<LibraryCommandState>>,
    AxumPath((capability, window_id)): AxumPath<(String, String)>,
) -> Response {
    let capability = match resolve_command_capability(&state, &capability) {
        Ok(capability) => capability,
        Err(error) => return error.into_response(),
    };
    let Some(record) = state
        .host
        .assemble_window_records()
        .into_iter()
        .find(|record| {
            record.library_id == state.host.library_id() && record.window_id == window_id
        })
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if record.token.is_empty() {
        return command_capability_error(StatusCode::CONFLICT, "window tenant is not running");
    }
    let prefix = record.prefix.trim_end_matches('/');
    let path = if prefix.is_empty() {
        "/index.html".to_string()
    } else {
        format!("{prefix}/index.html")
    };
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("t", &record.token);
    query.append_pair("w", &record.window_id);
    query.append_pair("lib", state.host.library_id());
    if record.kind == WindowKind::Terminal {
        query.append_pair("kind", "terminal");
    }
    let target = format!("{path}?{}", query.finish());
    // The capability was checked above; retaining the binding through this
    // response ensures a source that closes between snapshot and Enter cannot
    // use a stale launch URL.
    let _ = capability;
    Redirect::temporary(&target).into_response()
}

/// Gate tunnel-origin mutations by the gateway caller role. The headless
/// devserver serves ONE app on both its loopback bind (a mutable `devserver`
/// surface) and the gateway tunnel. The proxy strips client credentials and
/// forwards a verified gateway assertion; owner assertions get the full launcher,
/// while missing/non-owner assertions may read but not mutate. Non-tunnel
/// requests keep the existing local bearer/bridge behavior.
/// The desktop-dialed reverse-tunnel legs (`cs tunnel`), behind their own
/// owner gate. They live under `/api/library/*` because `/api/devserver/*` is
/// 404'd on the gateway's public wildcard; handlers and the three-leg contract
/// are documented in `routes::tunnel`.
fn tunnel_legs() -> Router<Arc<WorkspaceHost>> {
    Router::new()
        .route(
            chan_revtunnel::wire::CONTROL_PATH,
            get(super::tunnel::handle_tunnel_control),
        )
        .route(
            chan_revtunnel::wire::CONN_PATH,
            get(super::tunnel::handle_tunnel_conn),
        )
        .route_layer(middleware::from_fn(require_tunnel_owner))
}

/// Restrict the tunnel legs to the devserver's owner.
///
/// Both legs are GET, so neither [`require_local_mutation`] nor the launcher
/// bearer covers them over the gateway: a tunnel-origin request bypasses the
/// bearer entirely, which would leave the unguessable tunnel id as the only
/// thing standing between any session holder and a listener on the owner's
/// desktop. A grantee holds a valid session, so "valid session" is not the
/// authority to open sockets on someone else's machine. Local (non-tunnel)
/// requests are unaffected: the launcher bearer already gates those.
///
/// TODO: tighten this from owner to the owner's DESKTOP. Gateway assertion
/// claims carry only sub / owner_user_id / aud / drv / iat / exp, so the
/// owner's desktop app and the owner's browser tab are indistinguishable here;
/// the desktop authenticates through the same entry exchange a browser does.
/// Carrying a client-type claim (and the desktop version, so a devserver can
/// refuse a build too old to speak this protocol) means threading it from the
/// identity service through the gateway session into the assertion.
async fn require_tunnel_owner(req: Request<Body>, next: Next) -> Response {
    let tunnel_origin = req.extensions().get::<crate::TunnelOrigin>();
    if tunnel_origin.is_some_and(|origin| !origin.owner()) {
        return (
            StatusCode::FORBIDDEN,
            "reverse tunnels are not available for this gateway role",
        )
            .into_response();
    }
    next.run(req).await
}

/// Tunnel guests (a `TunnelOrigin` whose `owner()` is false) may read but
/// not mutate. Mounted on the launcher mutation lanes here and on the
/// extension capability proxy routes in `lib.rs`.
pub(crate) async fn require_local_mutation(req: Request<Body>, next: Next) -> Response {
    let is_mutation = matches!(*req.method(), Method::POST | Method::PUT | Method::DELETE);
    if is_mutation
        && req
            .extensions()
            .get::<crate::TunnelOrigin>()
            .is_some_and(|origin| !origin.owner())
    {
        return (
            StatusCode::FORBIDDEN,
            "launcher mutation is not available for this gateway role",
        )
            .into_response();
    }
    next.run(req).await
}

fn tunnel_owner(req: &Request<Body>) -> bool {
    req.extensions()
        .get::<crate::TunnelOrigin>()
        .is_some_and(crate::TunnelOrigin::owner)
}

/// The `t` bearer from a URL query string (`...?t=<token>`), for the watch WS
/// where the browser cannot set the `Authorization` header.
fn query_bearer(query: &str) -> Option<&str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "t").then_some(value)
    })
}

/// `GET /api/library/windows`: the full library window set every client
/// reconciles to. A thin wrapper over the host's shared `assemble_window_records`,
/// which the desktop watcher and `cs window list` also call in-process, so every
/// client reads one assembly with no divergence.
async fn handle_list_library_windows(
    State(host): State<Arc<WorkspaceHost>>,
) -> Json<Vec<WindowRecord>> {
    Json(host.assemble_window_records())
}

/// `GET /api/library/windows/watch`: a WebSocket that pushes the full window set
/// on connect and again on every change, so a client reconciles its surface to
/// the live library state without polling. Bearer-gated by
/// [`require_launcher_bearer`]; a browser WebSocket cannot send the
/// `Authorization` header, so it presents the bearer in the `?t=` query param,
/// while `cs` and the desktop use the header.
async fn handle_watch_library_windows(
    State(host): State<Arc<WorkspaceHost>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| watch_library_windows(socket, host))
}

/// Push a fresh window-set snapshot on connect and on every change. Sending the
/// whole set rather than a delta keeps the client's reconcile idempotent: a
/// dropped frame self-heals on the next push. The change waiter is armed
/// (`enable`d) BEFORE each snapshot so a change that lands between the snapshot
/// and the await is never missed. The loop ends when the client disconnects.
async fn watch_library_windows(mut socket: WebSocket, host: Arc<WorkspaceHost>) {
    let notify: Arc<Notify> = host.library_change_notify();
    let changed = notify.notified();
    tokio::pin!(changed);
    loop {
        // Arm the change waiter BEFORE the snapshot. A `Notified` records the
        // `notify_waiters` count when it is created, so creating and `enable`-ing
        // it before the snapshot guarantees a change during the snapshot or the
        // `send().await` advances that count and wakes the `select!` below,
        // rather than being read into a snapshot the waiter was armed after. The
        // explicit `enable` also keeps this consumer's ordering identical to the
        // desktop's local watcher.
        changed.as_mut().enable();
        let set = WindowSet {
            windows: host.assemble_window_records(),
            // Per-tenant leaders so a launcher gates leader-only affordances; the
            // registry change bridge nudges this same feed on a leader change.
            leaders: host.tenant_leaders(),
        };
        let frame = match serde_json::to_string(&set) {
            Ok(frame) => frame,
            Err(_) => break,
        };
        if socket.send(Message::text(frame)).await.is_err() {
            break; // the client is gone
        }
        tokio::select! {
            _ = changed.as_mut() => {
                // A window-set change woke us: drop the consumed waiter and
                // re-arm a fresh one, which the next loop turn enables before
                // it reads the snapshot.
                changed.set(notify.notified());
            }
            msg = socket.recv() => match msg {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {} // ignore any other client frame
            },
        }
    }
}

/// The leader gate shared by mint / discard / visibility. Honest-client
/// enforcement, NOT a security boundary: the acting `window_id` is a
/// client-claimed value behind the SHARED launcher bearer (every window of a
/// tenant presents the one tenant token), so any client that can read the roster
/// can present the leader's id. It double-enforces a UI affordance, nothing more.
/// 403 ONLY when a live leader governs the target AND the caller presents a
/// DIFFERENT acting id; a leaderless target and a legacy caller (no acting id,
/// e.g. the desktop launcher) are both allowed.
fn leader_gate(target_leader: Option<String>, acting: Option<&str>) -> Result<(), Box<Response>> {
    match (target_leader, acting) {
        (Some(leader), Some(claim)) if claim != leader => Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                "not the session leader for this window",
            )
                .into_response(),
        )),
        _ => Ok(()),
    }
}

/// Query params carrying the caller's acting window id for the leader gate on a
/// bodyless route (DELETE): `?acting_window_id=<id>`.
#[derive(Deserialize)]
struct ActingWindow {
    #[serde(default)]
    acting_window_id: Option<String>,
}

/// `POST /api/library/windows` `{kind, workspace_path?, origin?, acting_window_id?}`:
/// mint a window. The library assigns the id and persists the record; the
/// registry change bridge fires the watch. Returns the assembled record in the
/// feed shape. Leader-gated (honest-client, see [`leader_gate`]).
async fn handle_create_library_window(
    State(host): State<Arc<WorkspaceHost>>,
    Json(req): Json<CreateWindow>,
) -> Response {
    if req.kind == WindowKind::Workspace {
        let Some(path) = req.workspace_path.as_deref() else {
            return (StatusCode::BAD_REQUEST, "workspace_path is required").into_response();
        };
        let (status, _) = host.workspace_status(Path::new(path));
        if status != WorkspaceStatus::Running {
            return (
                StatusCode::CONFLICT,
                "workspace is not running; turn it on before opening a window",
            )
                .into_response();
        }
    }
    // Leader gate on the TARGET tenant of the mint (workspace path, or the shared
    // terminal tenant for a terminal mint); leaderless establishes leadership at
    // the later /ws connect, so it is allowed.
    if let Err(resp) = leader_gate(
        host.tenant_leader(req.kind, req.workspace_path.as_deref()),
        req.acting_window_id.as_deref(),
    ) {
        return *resp;
    }
    // Stamp the client-claimed affinity at mint so chan-desktop never opens a
    // native twin for a browser-minted window (honest-client input, D4).
    match host.mint_window_with_origin(req.kind, req.workspace_path, req.origin) {
        Ok(record) => Json(record).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `DELETE /api/library/windows/{window_id}?acting_window_id=<id>`: discard a
/// window by dropping its record; the change bridge fires the watch, and each
/// client's reconcile then closes the window. `discard_window` reaps the window's
/// own session state (its shared-terminal-tenant session, a workspace tenant's
/// layout blob), so a single registry discard is the authoritative cleanup.
/// Leader-gated on the window's governing tenant (honest-client, see
/// [`leader_gate`]). 404 when no window has that id.
async fn handle_discard_library_window(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(window_id): AxumPath<String>,
    Query(q): Query<ActingWindow>,
) -> Response {
    if let Err(resp) = leader_gate(
        host.window_tenant_leader(&window_id),
        q.acting_window_id.as_deref(),
    ) {
        return *resp;
    }
    match host.discard_window(&window_id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Body of `POST /api/library/windows/{window_id}/visibility`.
#[derive(Deserialize)]
struct SetVisibility {
    hidden: bool,
    /// The caller's claimed acting window id for the leader gate; absent on a
    /// legacy / desktop-launcher caller, which the gate allows.
    #[serde(default)]
    acting_window_id: Option<String>,
}

/// `POST /api/library/windows/{window_id}/visibility` `{hidden, acting_window_id?}`:
/// set the window's server-persisted visibility, the source of truth the
/// desktop mirrors on connect. The registry change bridge fires the watch, so
/// every client's feed reflects the new visibility. Leader-gated on the window's
/// governing tenant (honest-client, see [`leader_gate`]). 204 on success; 404
/// when no window has that id. Distinct from `/open` + `/hide`, which dispatch a
/// desktop-bridge op on the native window and do not persist.
async fn handle_set_library_window_visibility(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(window_id): AxumPath<String>,
    Json(req): Json<SetVisibility>,
) -> Response {
    if let Err(resp) = leader_gate(
        host.window_tenant_leader(&window_id),
        req.acting_window_id.as_deref(),
    ) {
        return *resp;
    }
    match host.set_window_hidden(&window_id, req.hidden) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Body of `PUT /api/library/windows/{window_id}/label`.
#[derive(Deserialize)]
struct SetWindowLabel {
    label: String,
    /// Same honest-client leader claim as visibility/discard. Desktop callers
    /// omit it; a self-managed launcher supplies its tenant leader.
    #[serde(default)]
    acting_window_id: Option<String>,
}

fn normalize_window_label(raw: &str) -> Result<String, &'static str> {
    let label = raw.trim();
    if label.chars().count() > chan_library::windows::MAX_WINDOW_LABEL_CHARS {
        return Err("window label must be 64 characters or fewer");
    }
    if label.chars().any(char::is_control) {
        return Err("window label cannot contain control characters");
    }
    Ok(label.to_string())
}

/// Persist the optional user caption of one ordinary terminal or workspace
/// window. Local rows write straight to this host's registry; an aggregated
/// remote row crosses the desktop bridge so the owning devserver persists it.
/// The generated ordinal and title remain untouched.
async fn handle_set_library_window_label(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(window_id): AxumPath<String>,
    Json(req): Json<SetWindowLabel>,
) -> Response {
    let label = match normalize_window_label(&req.label) {
        Ok(label) => label,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let Some(record) = host
        .assemble_window_records()
        .into_iter()
        .find(|record| record.window_id == window_id)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if record.control {
        return (
            StatusCode::BAD_REQUEST,
            "control terminals cannot have a label",
        )
            .into_response();
    }
    if let Err(resp) = leader_gate(
        host.window_tenant_leader(&window_id),
        req.acting_window_id.as_deref(),
    ) {
        return *resp;
    }
    match host.set_window_label(&window_id, label.clone()) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => {
            dispatch_window_op(&host, |reply| DesktopWindowOp::SetWindowLabel {
                id: window_id,
                label,
                reply,
            })
            .await
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `POST /api/library/windows/{window_id}/open`: focus a live window or un-hide a
/// buried one through the desktop window bridge, so the launcher can
/// open a window directly. 204 on success; 409 when no desktop is attached (the
/// standalone serve / devserver surface can't drive a native window).
async fn handle_open_library_window(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(window_id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::Open {
        id: window_id,
        reply,
    })
    .await
}

/// `POST /api/library/windows/{window_id}/hide`: bury (hide) a window through the
/// desktop window bridge. Notification-free by construction: the bury notice
/// fires only in the desktop's OS-close (`CloseRequested`) handler, not the
/// generic window ops, so a launcher-driven hide skips it. 204 on success; 409
/// when no desktop is attached.
async fn handle_hide_library_window(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(window_id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::Hide {
        id: window_id,
        reply,
    })
    .await
}

/// `POST /api/library/windows/{window_id}/close`: close a native window through
/// the desktop manager, then discard any local durable row. Remote close is
/// routed by the desktop op to the owning devserver. A live-terminal native
/// window keeps the desktop's existing confirmation dialog.
async fn handle_close_library_window(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(window_id): AxumPath<String>,
) -> Response {
    let destroyed = match host
        .desktop_bridge()
        .dispatch(|reply| DesktopWindowOp::Close {
            id: window_id.clone(),
            force: false,
            reply,
        })
        .await
    {
        Ok(destroyed) => destroyed,
        Err(msg) => return (StatusCode::CONFLICT, msg).into_response(),
    };
    match host.discard_window(&window_id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) if destroyed => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `POST /api/library/devservers/{id}/connect`: connect a registered devserver
/// through the desktop bridge -- run its connect command in a control terminal,
/// scrape the token, dial the URL, and open its window. The launcher's Connect
/// button drives this; the desktop handles the `ConnectDevserver` op. 204 on
/// success; 409 (`NO_DESKTOP`) on a surface with no desktop attached, so the
/// action is inert in a plain browser even if the button were shown.
async fn handle_connect_devserver(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::ConnectDevserver {
        id,
        reply,
    })
    .await
}

/// `POST /api/library/devservers/{id}/disconnect`: disconnect a connected
/// devserver through the desktop bridge -- drop its live connection and windows,
/// back to registered-but-offline. 204 on success; 409 (`NO_DESKTOP`) with no
/// desktop attached.
async fn handle_disconnect_devserver(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::DisconnectDevserver {
        id,
        reply,
    })
    .await
}

/// `PUT /api/library/devservers/{id}/native-trust`: persist native-IPC consent
/// for one current shared gateway roster row. The desktop bridge validates the
/// authenticated roster target and rejects plain or owned rows.
async fn handle_grant_devserver_native_trust(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::GrantDevserverNativeTrust {
        id,
        reply,
    })
    .await
}

/// `DELETE /api/library/devservers/{id}/native-trust`: remove persisted consent
/// and wait for the desktop to tear down that row's connection and windows.
async fn handle_revoke_devserver_native_trust(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::RevokeDevserverNativeTrust {
        id,
        reply,
    })
    .await
}

/// `POST /api/library/devservers/{id}/terminal`: open a standalone-terminal
/// window on a connected devserver through the desktop bridge. 204/409.
async fn handle_devserver_terminal(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::OpenDevserverTerminal {
        id,
        reply,
    })
    .await
}

/// Body of `POST /api/library/devservers/{id}/workspaces/open`: the remote
/// workspace root to open a window for.
#[derive(Deserialize)]
struct OpenDevserverWorkspace {
    path: String,
}

/// `POST /api/library/devservers/{id}/workspaces/open` `{path}`: open (or focus)
/// a workspace window rooted at the remote `path` on a connected devserver
/// through the desktop bridge. 204/409.
async fn handle_open_devserver_workspace(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<OpenDevserverWorkspace>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::OpenDevserverWorkspace {
        id,
        path: body.path,
        reply,
    })
    .await
}

/// Body of the workspace on/off/forget routes: the remote mount `prefix` to
/// target. It rides the JSON body, not a path segment -- a mount prefix can carry
/// characters axum's `Path` extractor and intervening proxies mangle (`%2F`), and
/// the gateway-proxied path makes it worse. `force` is read only by `/off` (a
/// destructive off of a workspace with live terminals); `on`/`forget` ignore it.
#[derive(Deserialize)]
struct DevserverWorkspaceRef {
    prefix: String,
    #[serde(default)]
    force: bool,
}

/// Body of `POST /api/library/workspaces/{id}/off`: `force` overrides the
/// live-terminal guard (a destructive off kills the workspace's terminals). The
/// body is OPTIONAL -- an absent/empty body reads `force: false` -- so the field is
/// purely additive; the launcher sends `force: true` on the confirm-retry.
#[derive(Deserialize, Default)]
struct WorkspaceOff {
    #[serde(default)]
    force: bool,
}

/// The `409 Conflict` body the `/off` route returns when an UNforced off is
/// refused because the workspace still has live terminal sessions. The launcher
/// matches `error == "live_terminals"` (distinguishing it from a plain
/// `NO_DESKTOP` 409), shows `active_terminals` in a confirm prompt, then retries
/// the off with `force: true`. The `active_terminals` field name mirrors the
/// devserver's internal `ActiveTerminalsRejection`, so the confirm flow is parity
/// with the workspace-off the desktop already drives over the devserver API.
#[derive(Serialize)]
struct LiveTerminalsRejection {
    /// Discriminator the launcher matches on -- always `"live_terminals"`.
    error: &'static str,
    /// Live terminal sessions the off would kill.
    active_terminals: usize,
}

fn live_terminals_response(active_terminals: usize) -> Response {
    (
        StatusCode::CONFLICT,
        Json(LiveTerminalsRejection {
            error: "live_terminals",
            active_terminals,
        }),
    )
        .into_response()
}

/// `POST /api/library/devservers/{id}/workspaces/on` `{prefix}`: turn a connected
/// devserver's workspace (the remote mount `prefix`) on through the desktop
/// bridge. 204/409 (`on` never blocks on terminals, so `force` is irrelevant).
async fn handle_devserver_workspace_on(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DevserverWorkspaceRef>,
) -> Response {
    set_devserver_workspace_on(&host, id, body.prefix, true, false).await
}

/// `POST /api/library/devservers/{id}/workspaces/off` `{prefix, force}`: turn it
/// off through the desktop bridge. An unforced off of a workspace with live
/// terminals answers 409 + [`LiveTerminalsRejection`] so the launcher can confirm
/// and retry with `force: true` (which force-offs → 204).
async fn handle_devserver_workspace_off(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DevserverWorkspaceRef>,
) -> Response {
    set_devserver_workspace_on(&host, id, body.prefix, false, body.force).await
}

/// Shared on/off dispatch for a connected devserver's workspace. Maps the bridge
/// outcome: `Done` → 204; `NeedsForce` → 409 + [`LiveTerminalsRejection`] (the
/// distinguishable confirm signal); a bridge error → 409 with the message (no
/// desktop attached / devserver not connected).
async fn set_devserver_workspace_on(
    host: &WorkspaceHost,
    id: String,
    prefix: String,
    on: bool,
    force: bool,
) -> Response {
    match host
        .desktop_bridge()
        .dispatch(|reply| DesktopWindowOp::SetDevserverWorkspaceOn {
            id,
            prefix,
            on,
            force,
            reply,
        })
        .await
    {
        Ok(SetWorkspaceOnOutcome::Done) => StatusCode::NO_CONTENT.into_response(),
        Ok(SetWorkspaceOnOutcome::NeedsForce { active_terminals }) => {
            live_terminals_response(active_terminals)
        }
        Err(msg) => (StatusCode::CONFLICT, msg).into_response(),
    }
}

/// `POST /api/library/devservers/{id}/workspaces/forget` `{prefix}`: forget
/// (unregister) a connected devserver's workspace (the remote mount `prefix`)
/// through the desktop bridge. POST-with-body rather than DELETE -- a DELETE body
/// is poorly supported across clients/proxies. 204/409.
async fn handle_forget_devserver_workspace(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<DevserverWorkspaceRef>,
) -> Response {
    match host
        .desktop_bridge()
        .dispatch(|reply| DesktopWindowOp::ForgetDevserverWorkspace {
            id,
            prefix: body.prefix,
            force: body.force,
            reply,
        })
        .await
    {
        Ok(SetWorkspaceOnOutcome::Done) => StatusCode::NO_CONTENT.into_response(),
        Ok(SetWorkspaceOnOutcome::NeedsForce { active_terminals }) => {
            live_terminals_response(active_terminals)
        }
        Err(msg) => (StatusCode::CONFLICT, msg).into_response(),
    }
}

/// `POST /api/library/fs/pick-folder`: open the OS native folder dialog through
/// the desktop bridge and return the chosen directory as a JSON string, or
/// `null` when the user cancels. The launcher's New-Workspace "Browse…" calls
/// this. Not a unit op (it returns a value), so it dials the bridge directly
/// rather than via [`dispatch_window_op`]. 200 with the path/`null` on success;
/// 409 (`NO_DESKTOP`) on a surface with no desktop attached, where the dialog
/// can't run and the launcher keeps its plain text-entry fallback.
async fn handle_pick_folder(State(host): State<Arc<WorkspaceHost>>) -> Response {
    match host
        .desktop_bridge()
        .dispatch(|reply| DesktopWindowOp::PickFolder { reply })
        .await
    {
        Ok(path) => Json(path).into_response(),
        Err(msg) => (StatusCode::CONFLICT, msg).into_response(),
    }
}

/// Dispatch a unit-reply desktop window op and map it to HTTP: `Ok(())` → 204,
/// `Err(msg)` → 409 with the message (no desktop attached, or the manager is
/// gone). 409 keeps these idempotent-ish view ops distinct from a 5xx -- the
/// caller can't drive a native window here, which the body explains.
async fn dispatch_window_op(
    host: &WorkspaceHost,
    make_op: impl FnOnce(oneshot::Sender<Result<(), String>>) -> DesktopWindowOp,
) -> Response {
    match host.desktop_bridge().dispatch(make_op).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(msg) => (StatusCode::CONFLICT, msg).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Workspaces (`/api/library/workspaces`). List today; add/on/off/rm next.
// ---------------------------------------------------------------------------

/// `GET /api/library/workspaces`: one row per registered library workspace (the
/// set `chan list` shows, read live from the host library -- the source of
/// truth), each stamped with whether it is currently served. The on-state is
/// resolved by canonical ROOT (`is_root_mounted`), not by a slug-prefix
/// membership test, so it reads correctly on the desktop -- which mounts tenants
/// at `workspace-<hash>`, a prefix the slug check would never match. Sorted by
/// id for a stable list.
async fn handle_list_workspaces(State(state): State<Arc<LauncherState>>) -> Response {
    let host = &state.host;
    let local_library_id = host.library_id().to_string();
    let mut rows: Vec<LauncherWorkspace> = host
        .library()
        .list_workspaces()
        .into_iter()
        .filter_map(|ws| {
            let workspace_id = allocate_workspace_prefix(&ws.root_path)
                .ok()?
                .trim_start_matches('/')
                .to_string();
            // Live lifecycle state the launcher drives spinners off. `on` stays
            // the live mounted bool (== status `running`); `status` carries the
            // richer `starting`/`error` the bool can't express.
            let (status, error) = host.workspace_status(&ws.root_path);
            Some(LauncherWorkspace {
                path: ws.root_path.to_string_lossy().into_owned(),
                label: ws
                    .display_name
                    .clone()
                    .unwrap_or_else(|| workspace_label(&ws.root_path)),
                on: status == WorkspaceStatus::Running,
                status,
                error,
                // Local rows: no devserver, prefix == workspace_id (the slash-free
                // slug); on/off/remove route by workspace_id. Carry this host's
                // library id so the launcher groups a headless devserver's own
                // windows (`lib-<hex>`) under Local machine, not the orphan bucket.
                library_id: Some(local_library_id.clone()),
                devserver_id: None,
                prefix: workspace_id.clone(),
                workspace_id,
            })
        })
        .collect();
    rows.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
    // Append connected devservers' workspaces after the sorted local rows. The
    // feed already tags each with its `devserver_id` + remote `library_id`, and
    // the SPA groups them by `devserver_id`, so local rows stay first.
    if let Some(feed) = host.devserver_feed() {
        rows.extend(feed.workspaces());
    }
    Json(rows).into_response()
}

/// A workspace's display label: its directory basename. The launcher falls back
/// to the path basename when the label is empty, so the two agree.
fn workspace_label(root: &Path) -> String {
    root.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// The serve address for a mutating workspace handler, or the error response to
/// return instead. Mutation is loopback-only: `serve_addr=None` is the
/// read-only devserver/gateway surface → 403. A present-but-unfilled cell
/// means a request landed before the embedder finished binding → 503 (momentary).
/// The `Response` is boxed to keep the `Err` variant small (`clippy::result_large_err`).
fn require_mutable(state: &LauncherState) -> Result<SocketAddr, Box<Response>> {
    match state.serve_addr.as_ref() {
        None => Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                "workspace mutation is available only on the desktop loopback; manage a devserver's \
                 workspaces from the desktop app or the CLI",
            )
                .into_response(),
        )),
        Some(cell) => match cell.get() {
            Some(addr) => Ok(*addr),
            None => Err(Box::new(
                (StatusCode::SERVICE_UNAVAILABLE, "launcher not ready").into_response(),
            )),
        },
    }
}

/// Resolve a launcher `workspace_id` (the route prefix without its leading slash)
/// to `(prefix, root)` against the live host library, or `None` when no
/// registered workspace maps to it. Mirrors the devserver's stable
/// `allocate_workspace_prefix` mapping.
fn resolve_workspace(host: &WorkspaceHost, id: &str) -> Option<(String, PathBuf)> {
    let prefix = format!("/{id}");
    host.library()
        .list_workspaces()
        .into_iter()
        .map(|ws| ws.root_path)
        .find(|root| allocate_workspace_prefix(root).ok().as_deref() == Some(prefix.as_str()))
        .map(|root| (prefix, root))
}

/// The per-tenant serve config the launcher mounts a workspace with. Mirrors the
/// devserver's `tenant_config`: a tokened tenant (`no_token:false`) at its stable
/// public slug, served in-process under the host's listener.
fn tenant_config(addr: SocketAddr, prefix: &str) -> ServeConfig {
    ServeConfig {
        addr,
        no_token: false,
        prefix: prefix.to_string(),
        idle_timeout: None,
        open_browser: false,
        search_aggression: None,
        settings_disabled: false,
        verbose: false,
    }
}

/// Record a workspace's on-state in the library-owned overlay (keyed by the
/// canonical root path the boot/restore path reads). No-op when no overlay is
/// installed (then on/off does not survive a restart, the host's existing
/// behavior).
fn set_overlay(host: &WorkspaceHost, root: &Path, on: bool) {
    if let Some(overlay) = host.workspace_overlay() {
        overlay.set(&root.to_string_lossy(), on);
    }
}

#[derive(Deserialize)]
struct AddWorkspace {
    path: String,
    /// Optional display name; empty/absent keeps the directory basename.
    #[serde(default)]
    label: Option<String>,
}

/// `POST /api/library/workspaces` `{path}`: register the local folder in the host
/// library and mount it (on), persisting its on-state. Returns the new row.
/// Loopback-only.
async fn handle_add_workspace(
    State(state): State<Arc<LauncherState>>,
    Json(req): Json<AddWorkspace>,
) -> Response {
    let addr = match require_mutable(&state) {
        Ok(addr) => addr,
        Err(resp) => return *resp,
    };
    let root = Path::new(&req.path);
    let prefix = match allocate_workspace_prefix(root) {
        Ok(prefix) => prefix,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let registered = match state
        .host
        .library()
        .register_workspace_with_name(root, req.label.clone())
    {
        Ok(ws) => ws,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    match state
        .host
        .open_or_get_registered_workspace(root, tenant_config(addr, &prefix))
        .await
    {
        Ok(hosted) => {
            set_overlay(&state.host, &hosted.root, true);
            let workspace_id = hosted.prefix.trim_start_matches('/').to_string();
            Json(LauncherWorkspace {
                path: hosted.root.to_string_lossy().into_owned(),
                label: registered
                    .display_name
                    .clone()
                    .unwrap_or_else(|| workspace_label(&hosted.root)),
                on: true,
                // Just mounted: live state is running, no error.
                status: WorkspaceStatus::Running,
                error: None,
                // A freshly added workspace is always local (no devserver).
                library_id: Some(state.host.library_id().to_string()),
                devserver_id: None,
                prefix: workspace_id.clone(),
                workspace_id,
            })
            .into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

/// `POST /api/library/workspaces/{id}/on`: mount the registered workspace at its
/// SAME stable prefix (minting a fresh tenant token), persisting on. Loopback-only.
async fn handle_workspace_on(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let addr = match require_mutable(&state) {
        Ok(addr) => addr,
        Err(resp) => return *resp,
    };
    let Some((prefix, root)) = resolve_workspace(&state.host, &id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match state
        .host
        .open_or_get_registered_workspace(&root, tenant_config(addr, &prefix))
        .await
    {
        Ok(_) => {
            set_overlay(&state.host, &root, true);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(crate::Error::Core(chan_workspace::ChanError::WorkspaceLocked)) => (
            StatusCode::CONFLICT,
            "workspace is open in another Chan process",
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `POST /api/library/workspaces/{id}/off`: unmount (release the per-workspace
/// flock), keep the registration, persist off. Plain unmount -- the
/// confirm-before-off is a launcher-UI concern, not a wire 409. Loopback-only.
async fn handle_workspace_off(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    // Optional `{ force }` body (additive -- absent/empty reads `force: false`).
    let force = serde_json::from_slice::<WorkspaceOff>(&body)
        .unwrap_or_default()
        .force;
    let Some((_allocated, root)) = resolve_workspace(&state.host, &id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match state.host.close_workspace_for_root(&root, force).await {
        Ok(WorkspaceLifecycleOutcome::Completed | WorkspaceLifecycleOutcome::NotFound) => {
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(WorkspaceLifecycleOutcome::Refused { active_terminals }) => {
            live_terminals_response(active_terminals)
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `DELETE /api/library/workspaces/{id}`: unmount if mounted, then UNREGISTER the
/// workspace from the host library (the single registry) so it disappears
/// everywhere. Loopback-only. 404 when no workspace maps to the id.
async fn handle_remove_workspace(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some((_allocated, root)) = resolve_workspace(&state.host, &id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match state.host.remove_workspace_for_root(&root, false).await {
        Ok(WorkspaceLifecycleOutcome::Completed) => StatusCode::NO_CONTENT.into_response(),
        Ok(WorkspaceLifecycleOutcome::NotFound) => StatusCode::NOT_FOUND.into_response(),
        Ok(WorkspaceLifecycleOutcome::Refused { active_terminals }) => {
            live_terminals_response(active_terminals)
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Devservers (`/api/library/devservers`). The set lives in chan-desktop's config,
// reached through an installed `DevserverRegistry` (see `devserver_registry.rs`).
// The desktop loopback installs one; the headless devserver/gateway leaves it
// `None`, where the routes serve an empty list and 404 every mutation.
// ---------------------------------------------------------------------------

/// `GET /api/library/devservers`: every configured devserver (tokens elided).
/// Served on ALL surfaces with NO `serve_addr` gate: a surface with no registry
/// installed (the headless devserver/gateway) returns an empty list, which is
/// exactly the spec -- a devserver-served launcher has no other devservers to
/// list. Infallible, mirroring the window feed.
async fn handle_list_devservers(
    State(state): State<Arc<LauncherState>>,
) -> Json<Vec<DevserverEntry>> {
    Json(
        state
            .host
            .devserver_registry()
            .map(|reg| reg.list())
            .unwrap_or_default(),
    )
}

/// `POST /api/library/devservers` `{url, label?, script?, token?}`: register a
/// devserver, returning the stored row with its assigned id (token elided).
/// Loopback-only ([`require_mutable`] → 403 on the read-only surface). A registry
/// rejection (a bad URL) maps to 400; no registry installed maps to 404
/// (defensive -- the desktop loopback always installs one).
async fn handle_add_devserver(
    State(state): State<Arc<LauncherState>>,
    Json(input): Json<DevserverInput>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some(reg) = state.host.devserver_registry() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match reg.add(input) {
        Ok(entry) => Json(entry).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `PUT /api/library/devservers/{id}` `{url, label?, script?, token?, clear_token?}`:
/// edit a devserver in place; a blank/absent `token` keeps the stored one unless
/// `clear_token` is true. Loopback-only. 404 when no devserver has the id (or no
/// registry is installed); 400 on a registry rejection.
async fn handle_update_devserver(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<DevserverInput>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some(reg) = state.host.devserver_registry() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match reg.update(&id, input) {
        Ok(Some(entry)) => Json(entry).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `DELETE /api/library/devservers/{id}`: remove a devserver. Loopback-only.
/// 404 when no devserver has the id (or no registry is installed); 400 on a
/// registry rejection.
async fn handle_remove_devserver(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some(reg) = state.host.devserver_registry() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match reg.remove(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Gateways (`/api/library/gateways`). The persisted set lives in the desktop
// config, reached through an installed `GatewayRegistry` (mirror of the
// devserver block above); connect/disconnect are desktop-bridge ops on the
// host-stated router.
// ---------------------------------------------------------------------------

/// `GET /api/library/gateways`: every configured gateway with its live
/// connection state. A registry-less surface (headless devserver, plain
/// `chan serve`) returns the empty list.
async fn handle_list_gateways(State(state): State<Arc<LauncherState>>) -> Json<Vec<GatewayEntry>> {
    Json(
        state
            .host
            .gateway_registry()
            .map(|reg| reg.list())
            .unwrap_or_default(),
    )
}

/// `POST /api/library/gateways` `{url, label?}`: configure a gateway,
/// returning the stored row. Save just adds -- no probe; a wrong URL
/// surfaces on the first connect. Loopback-only ([`require_mutable`] → 403
/// on the read-only surface). A registry rejection (bad or duplicate URL)
/// maps to 400; no registry installed maps to 404 (defensive -- the desktop
/// loopback always installs one).
async fn handle_add_gateway(
    State(state): State<Arc<LauncherState>>,
    Json(input): Json<GatewayInput>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some(reg) = state.host.gateway_registry() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match reg.add(input) {
        Ok(entry) => Json(entry).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `PUT /api/library/gateways/{id}` `{url, label?}`: rename a gateway in
/// place. `label` is full-replace (empty derives the badge from the URL
/// host); the URL is the gateway's identity and must match the stored
/// origin when present (changing it is a remove + re-add). Loopback-only.
/// 404 when no gateway has the id (or no registry is installed); 400 on a
/// registry rejection (a URL change).
async fn handle_update_gateway(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<GatewayInput>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some(reg) = state.host.gateway_registry() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match reg.update(&id, input) {
        Ok(Some(entry)) => Json(entry).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `DELETE /api/library/gateways/{id}`: remove a gateway; the desktop side
/// cascades (roster poll stopped, rostered connections torn down,
/// synthesized rows dropped). Loopback-only. 404 when no gateway has the id
/// (or no registry is installed); 400 on a registry rejection.
async fn handle_remove_gateway(
    State(state): State<Arc<LauncherState>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(resp) = require_mutable(&state) {
        return *resp;
    }
    let Some(reg) = state.host.gateway_registry() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match reg.remove(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `POST /api/library/gateways/{id}/connect`: connect a configured gateway
/// through the desktop bridge -- discovery, browser sign-in hand-off when no
/// credential is stored, roster fetch, poll spawn. 204 on success; 409
/// (`NO_DESKTOP`) on a surface with no desktop attached.
async fn handle_connect_gateway(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::ConnectGateway { id, reply }).await
}

/// `POST /api/library/gateways/{id}/disconnect`: disconnect a connected
/// gateway through the desktop bridge -- poll stopped, rostered connections
/// torn down, disabled intent persisted. 204 on success; 409 (`NO_DESKTOP`)
/// with no desktop attached.
async fn handle_disconnect_gateway(
    State(host): State<Arc<WorkspaceHost>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    dispatch_window_op(&host, |reply| DesktopWindowOp::DisconnectGateway {
        id,
        reply,
    })
    .await
}

// ---------------------------------------------------------------------------
// Local-library colour (`/api/library/local-color`). The value lives in the
// desktop config, reached through an installed `LocalColorStore`. GET is served
// on every surface (no store → `null`); PUT is loopback-only.
// ---------------------------------------------------------------------------

/// The local-library pane-highlight colour as the launcher reads/writes it:
/// `color` is a hex string (`#rrggbb`) or `null` for the default accent.
#[derive(Serialize, Deserialize)]
struct LocalColor {
    color: Option<String>,
}

/// `GET /api/library/local-color`: the local library's pane-highlight colour
/// (`{ color }`), or `{ color: null }` on a surface with no store installed (the
/// default accent). Served on all surfaces, infallible.
async fn handle_get_local_color(State(state): State<Arc<LauncherState>>) -> Json<LocalColor> {
    let color = state.host.local_color_store().and_then(|store| store.get());
    Json(LocalColor { color })
}

/// `PUT /api/library/local-color` `{ color }`: set the library's own
/// pane-highlight colour (`null` clears it to the default). Available on EVERY
/// surface, NOT loopback-only: a library's colour belongs to that library and is
/// set from a pane's focus-border menu on its OWN serving host -- local windows
/// hit the desktop loopback, a devserver window hits that devserver. The bearer
/// gate (the per-surface launcher token) is the auth; there is no `require_mutable`
/// because this mutates the surface's OWN library, not someone else's. 204 on
/// success; 404 when no store is installed; 400 on a persist failure.
async fn handle_set_local_color(
    State(state): State<Arc<LauncherState>>,
    Json(body): Json<LocalColor>,
) -> Response {
    let Some(store) = state.host.local_color_store() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match store.set(body.color) {
        Ok(()) => {
            // Broadcast the change so every open window of this library
            // live-updates its `--pane-highlight-color` (and new windows read
            // fresh), replacing the desktop's old per-library colour poll.
            state.host.notify_local_color_change();
            StatusCode::NO_CONTENT.into_response()
        }
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `GET /api/library/local-color/watch`: a WebSocket that pushes the library's
/// pane-highlight colour (`{ color }`) on connect and on every change, so a pane
/// live-updates `--pane-highlight-color` without polling. Bearer-gated via the
/// `?t=` query token (a browser WS can't set a header), like the window watch.
/// One endpoint serves both surfaces: a local window hits the desktop loopback,
/// a devserver window hits that devserver.
async fn handle_watch_local_color(
    State(state): State<Arc<LauncherState>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| watch_local_color(socket, state))
}

/// Push a `{ color }` snapshot on connect and on every colour change. Mirrors
/// [`watch_library_windows`]: arm the change waiter BEFORE the snapshot so a
/// change between snapshot and await is never missed; the loop ends when the
/// client disconnects. Driven by the dedicated `local_color_notify` (fired by
/// [`handle_set_local_color`]), so it does not wake on unrelated window changes.
async fn watch_local_color(mut socket: WebSocket, state: Arc<LauncherState>) {
    let notify = state.host.local_color_notify();
    let changed = notify.notified();
    tokio::pin!(changed);
    loop {
        changed.as_mut().enable();
        let color = state.host.local_color_store().and_then(|store| store.get());
        let frame = match serde_json::to_string(&LocalColor { color }) {
            Ok(frame) => frame,
            Err(_) => break,
        };
        if socket.send(Message::text(frame)).await.is_err() {
            break; // the client is gone
        }
        tokio::select! {
            _ = changed.as_mut() => {
                changed.set(notify.notified());
            }
            msg = socket.recv() => match msg {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
struct LocalTheme {
    theme: Option<String>,
}

/// `GET /api/library/local-theme`: the launcher's light/dark choice
/// (`{ theme }`), or `{ theme: null }` on a surface with no store installed
/// (follow the OS). Served on all surfaces, infallible. A headless devserver
/// installs none, so a devserver or remote terminal window reads `null` here.
async fn handle_get_local_theme(State(state): State<Arc<LauncherState>>) -> Json<LocalTheme> {
    let theme = state.host.local_theme_store().and_then(|store| store.get());
    Json(LocalTheme { theme })
}

/// `PUT /api/library/local-theme` `{ theme }`: set the launcher's light/dark
/// choice (`null` clears it back to OS-follow). Surface-bearer gated like
/// local-color, with no `require_mutable`: it writes the surface's OWN machine
/// theme, not someone else's. 204 on success; 404 when no store is installed
/// (so a store-less surface answers 404, never 403); 400 on a persist failure.
async fn handle_set_local_theme(
    State(state): State<Arc<LauncherState>>,
    Json(body): Json<LocalTheme>,
) -> Response {
    let Some(store) = state.host.local_theme_store() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match store.set(body.theme) {
        Ok(()) => {
            // Broadcast so every open local standalone terminal window
            // live-retitles, and a newly opened one reads the fresh value.
            state.host.notify_local_theme_change();
            StatusCode::NO_CONTENT.into_response()
        }
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

/// `GET /api/library/local-theme/watch`: a WebSocket that pushes the launcher
/// theme (`{ theme }`) on connect and on every change, so a local standalone
/// terminal window re-themes without polling. Bearer-gated via the `?t=` query
/// token, like the local-colour watch.
async fn handle_watch_local_theme(
    State(state): State<Arc<LauncherState>>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| watch_local_theme(socket, state))
}

/// Push a `{ theme }` snapshot on connect and on every theme change. Mirrors
/// [`watch_local_color`], driven by the dedicated `local_theme_notify`.
async fn watch_local_theme(mut socket: WebSocket, state: Arc<LauncherState>) {
    let notify = state.host.local_theme_notify();
    let changed = notify.notified();
    tokio::pin!(changed);
    loop {
        changed.as_mut().enable();
        let theme = state.host.local_theme_store().and_then(|store| store.get());
        let frame = match serde_json::to_string(&LocalTheme { theme }) {
            Ok(frame) => frame,
            Err(_) => break,
        };
        if socket.send(Message::text(frame)).await.is_err() {
            break; // the client is gone
        }
        tokio::select! {
            _ = changed.as_mut() => {
                changed.set(notify.notified());
            }
            msg = socket.recv() => match msg {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            },
        }
    }
}

// Collapsed launcher machine cards (`/api/library/collapsed-machines`). The set
// lives in chan-desktop's config (invisible from chan-library), so the launcher
// reads/writes it through the host's `CollapsedMachinesStore`. No watch: the
// launcher owns the live collapse state and only reconciles on boot.

#[derive(Serialize)]
struct CollapsedMachines {
    /// The persisted collapsed keys, or `null` on a surface with no store.
    collapsed: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct SetCollapsedMachines {
    collapsed: Vec<String>,
}

/// `GET /api/library/collapsed-machines`: the persisted collapsed machine cards
/// (`{ collapsed: [...] }`), or `{ collapsed: null }` on a surface with no store
/// installed. Served on all surfaces, infallible. A headless devserver installs
/// none, so its launcher keeps a localStorage-only collapse.
async fn handle_get_collapsed_machines(
    State(state): State<Arc<LauncherState>>,
) -> Json<CollapsedMachines> {
    let collapsed = state
        .host
        .collapsed_machines_store()
        .map(|store| store.get());
    Json(CollapsedMachines { collapsed })
}

/// `PUT /api/library/collapsed-machines` `{ collapsed }`: persist the collapsed
/// machine cards. Surface-bearer gated like local-theme, with no
/// `require_mutable`: it writes the surface's OWN machine collapse. 204 on
/// success; 404 when no store is installed (so a store-less surface answers 404,
/// never 403); 400 on a persist failure.
async fn handle_set_collapsed_machines(
    State(state): State<Arc<LauncherState>>,
    Json(body): Json<SetCollapsedMachines>,
) -> Response {
    let Some(store) = state.host.collapsed_machines_store() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match store.set(body.collapsed) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
    }
}

#[cfg(test)]
#[path = "library_command_capability_tests.rs"]
mod command_capability_tests;

#[cfg(test)]
mod devserver_route_tests {
    //! The devserver route gate semantics, exercised over a fake registry: list
    //! is uniform (empty without a registry, no `serve_addr` gate); mutations are
    //! `require_mutable` first (403 read-only) then registry-keyed (404 absent /
    //! missing id, 400 on rejection); the token is never echoed back.
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex, OnceLock};

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use chan_library::allocate_workspace_prefix;
    use chan_library::windows::WindowRegistry;
    use chan_workspace::Library;
    use tower::ServiceExt;

    use super::launcher_router;
    use crate::{
        CollapsedMachinesStore, DevserverEntry, DevserverInput, DevserverRegistry, DevserverStatus,
        LocalColorStore, LocalThemeStore, WorkspaceHost,
    };

    /// An in-memory `DevserverRegistry` standing in for the desktop config so the
    /// route gates are exercised without a desktop. `add` echoes the input back as
    /// a stored row (rejecting the sentinel url `"bad"` to drive the 400 path);
    /// `update`/`remove` 404 (`Ok(None)`/`Ok(false)`) unless the id is present.
    #[derive(Default)]
    struct FakeRegistry {
        rows: Mutex<Vec<DevserverEntry>>,
    }

    impl FakeRegistry {
        fn seeded() -> Self {
            FakeRegistry {
                rows: Mutex::new(vec![DevserverEntry {
                    id: "ds1".into(),
                    url: "http://box.example.com:8787".into(),
                    host: "box.example.com".into(),
                    port: 8787,
                    label: "box".into(),
                    script: String::new(),
                    has_token: true,
                    library_id: None,
                    status: DevserverStatus::Disconnected,
                    pending_signin: false,
                    auto_hide_control: false,
                    os: "linux".into(),
                    pretty_name: Some("Debian GNU/Linux 12".into()),
                    gateway_id: None,
                    gateway_url: String::new(),
                    shared: false,
                    native_trust_required: false,
                }]),
            }
        }
    }

    impl DevserverRegistry for FakeRegistry {
        fn list(&self) -> Vec<DevserverEntry> {
            self.rows.lock().unwrap().clone()
        }
        fn add(&self, input: DevserverInput) -> Result<DevserverEntry, String> {
            if input.host == "bad" {
                return Err("rejected host".into());
            }
            let entry = DevserverEntry {
                id: "ds-new".into(),
                url: input
                    .url
                    .clone()
                    .unwrap_or_else(|| format!("http://{}:{}", input.host, input.port)),
                host: input.host,
                port: input.port,
                label: input.label.unwrap_or_default(),
                script: input.script.unwrap_or_default(),
                has_token: input.token.is_some(),
                library_id: None,
                status: DevserverStatus::Disconnected,
                pending_signin: false,
                auto_hide_control: input.auto_hide_control,
                os: String::new(),
                pretty_name: None,
                gateway_id: None,
                gateway_url: String::new(),
                shared: false,
                native_trust_required: false,
            };
            self.rows.lock().unwrap().push(entry.clone());
            Ok(entry)
        }
        fn update(
            &self,
            id: &str,
            input: DevserverInput,
        ) -> Result<Option<DevserverEntry>, String> {
            let mut rows = self.rows.lock().unwrap();
            let Some(row) = rows.iter_mut().find(|r| r.id == id) else {
                return Ok(None);
            };
            row.host = input.host;
            row.port = input.port;
            row.url = input
                .url
                .clone()
                .unwrap_or_else(|| format!("http://{}:{}", row.host, row.port));
            row.auto_hide_control = input.auto_hide_control;
            if let Some(label) = input.label {
                row.label = label;
            }
            if input.token.as_deref().is_some_and(|t| !t.trim().is_empty()) {
                row.has_token = true;
            } else if input.clear_token {
                row.has_token = false;
            }
            Ok(Some(row.clone()))
        }
        fn remove(&self, id: &str) -> Result<bool, String> {
            let mut rows = self.rows.lock().unwrap();
            let before = rows.len();
            rows.retain(|r| r.id != id);
            Ok(rows.len() != before)
        }
    }

    /// A launcher router over an empty host with the given registry installed (or
    /// none). `mutable` Some → a loopback surface with a bound `serve_addr` (the
    /// mutation gate opens); None → the read-only devserver/gateway surface. The
    /// bearer is `None`, leaving the data surface public so tests need no header.
    fn router_with(registry: Option<Arc<dyn DevserverRegistry>>, mutable: bool) -> axum::Router {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_at(dir.path().join("config.toml")).unwrap();
        // The router never reads the config file again; leak the dir so the path
        // the Library holds stays valid for the (short) test body.
        std::mem::forget(dir);
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        if let Some(reg) = registry {
            host.install_devserver_registry(reg);
        }
        let serve_addr = mutable.then(|| {
            let cell = OnceLock::new();
            let _ = cell.set("127.0.0.1:8080".parse::<SocketAddr>().unwrap());
            Arc::new(cell)
        });
        launcher_router(host, None, serve_addr)
    }

    async fn request(
        router: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method(method).uri(uri);
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[cfg(unix)]
    fn hold_foreign_lock(
        lib: &Library,
        root: &std::path::Path,
    ) -> chan_workspace::lock::WorkspaceLock {
        let paths = lib.workspace_paths_for(root).expect("workspace paths");
        let lock = chan_workspace::lock::WorkspaceLock::acquire(&paths.lock, root).expect("lock");
        let record = chan_workspace::lock::LockRecord {
            pid: 1,
            path: root
                .canonicalize()
                .unwrap_or_else(|_| root.to_path_buf())
                .to_string_lossy()
                .into_owned(),
            started_at: "2000-01-01T00:00:00Z".to_string(),
        };
        std::fs::write(
            paths.lock.join("writer.lock"),
            serde_json::to_vec(&record).expect("record json"),
        )
        .expect("write foreign lock record");
        lock
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_list_reports_foreign_locked_rows() {
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let host = Arc::new(WorkspaceHost::new(lib.clone(), crate::route_builder()));
        let _foreign = hold_foreign_lock(&lib, root.path());
        let router = launcher_router(host.clone(), None, None);

        let (status, body) = request(&router, "GET", "/api/library/workspaces", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["status"], "locked");
        assert_eq!(body[0]["on"], false);
        assert_eq!(
            body[0]["library_id"],
            serde_json::json!(host.library_id().to_string())
        );
    }

    #[tokio::test]
    async fn workspace_window_mint_requires_running_workspace() {
        let cfg = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(ws.path()).unwrap();
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        host.install_window_registry(
            Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
            "local".to_string(),
        );
        let app = launcher_router(host.clone(), None, None);
        let body = serde_json::json!({
            "kind": "workspace",
            "workspace_path": ws.path().to_string_lossy(),
        })
        .to_string();

        let stopped = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/library/windows")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stopped.status(), StatusCode::CONFLICT);
        assert!(
            host.assemble_window_records().is_empty(),
            "rejected mints must not persist queued workspace windows"
        );

        let prefix = allocate_workspace_prefix(ws.path()).unwrap();
        host.open_or_get_registered_workspace(
            ws.path(),
            super::tenant_config("127.0.0.1:0".parse().unwrap(), &prefix),
        )
        .await
        .expect("mount workspace");

        let running = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/library/windows")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(running.status(), StatusCode::OK);
        assert_eq!(host.assemble_window_records().len(), 1);
    }

    #[tokio::test]
    async fn workspace_window_label_route_persists_trimmed_text_and_clears_it() {
        let cfg = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace.path()).unwrap();
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        host.install_window_registry(
            Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
            "local".to_string(),
        );
        let prefix = allocate_workspace_prefix(workspace.path()).unwrap();
        host.open_or_get_registered_workspace(
            workspace.path(),
            super::tenant_config("127.0.0.1:0".parse().unwrap(), &prefix),
        )
        .await
        .expect("mount workspace");
        let record = host
            .mint_window(
                chan_library::windows::WindowKind::Workspace,
                Some(workspace.path().to_string_lossy().into_owned()),
            )
            .expect("mint workspace window");
        let router = launcher_router(host.clone(), None, None);
        let uri = format!("/api/library/windows/{}/label", record.window_id);

        let (status, _) = request(
            &router,
            "PUT",
            &uri,
            Some(r#"{"label":"  release checks  "}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, feed) = request(&router, "GET", "/api/library/windows", None).await;
        let row = feed
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["window_id"] == record.window_id)
            .expect("window in feed");
        assert_eq!(row["label"], "release checks");

        let (status, _) = request(&router, "PUT", &uri, Some(r#"{"label":"   "}"#)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, feed) = request(&router, "GET", "/api/library/windows", None).await;
        let row = feed
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["window_id"] == record.window_id)
            .unwrap();
        assert!(row.get("label").is_none(), "an empty label is omitted");

        let too_long = "x".repeat(chan_library::windows::MAX_WINDOW_LABEL_CHARS + 1);
        let body = serde_json::json!({ "label": too_long }).to_string();
        let (status, _) = request(&router, "PUT", &uri, Some(&body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn terminal_window_label_route_accepts_64_characters_and_rejects_65() {
        let cfg = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        let registry_path = store.path().join("windows.json");
        host.install_window_registry(
            Arc::new(WindowRegistry::open(registry_path.clone())),
            "local".to_string(),
        );
        let record = host
            .mint_window(chan_library::windows::WindowKind::Terminal, None)
            .expect("mint terminal window");
        let router = launcher_router(host, None, None);
        let uri = format!("/api/library/windows/{}/label", record.window_id);

        let exactly_max = "x".repeat(chan_library::windows::MAX_WINDOW_LABEL_CHARS);
        let body = serde_json::json!({ "label": exactly_max }).to_string();
        let (status, _) = request(&router, "PUT", &uri, Some(&body)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let persisted = WindowRegistry::open(registry_path)
            .snapshot()
            .into_iter()
            .find(|row| row.window_id == record.window_id)
            .expect("terminal persisted");
        assert_eq!(persisted.label, exactly_max);

        let too_long = "x".repeat(chan_library::windows::MAX_WINDOW_LABEL_CHARS + 1);
        let body = serde_json::json!({ "label": too_long }).to_string();
        let (status, _) = request(&router, "PUT", &uri, Some(&body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn list_without_registry_is_empty() {
        // The headless devserver/gateway installs no registry: GET returns `[]`
        // (200) on every surface -- no `serve_addr` gate.
        for mutable in [false, true] {
            let router = router_with(None, mutable);
            let (status, body) = request(&router, "GET", "/api/library/devservers", None).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, serde_json::json!([]));
        }
    }

    #[tokio::test]
    async fn list_returns_seeded_rows_without_token() {
        let reg = Arc::new(FakeRegistry::seeded());
        let router = router_with(Some(reg), false);
        let (status, body) = request(&router, "GET", "/api/library/devservers", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["id"], "ds1");
        assert_eq!(body[0]["host"], "box.example.com");
        assert_eq!(body[0]["port"], 8787);
        assert_eq!(body[0]["has_token"], true);
        // The token value is never serialized back, only its presence.
        assert!(body[0].get("token").is_none());
    }

    #[tokio::test]
    async fn add_on_loopback_returns_row_token_elided() {
        let reg = Arc::new(FakeRegistry::default());
        let router = router_with(Some(reg), true);
        let (status, body) = request(
            &router,
            "POST",
            "/api/library/devservers",
            Some(r#"{"host":"box","port":9000,"token":"secret"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["host"], "box");
        assert_eq!(body["port"], 9000);
        assert_eq!(body["has_token"], true);
        assert!(body.get("token").is_none(), "token must not echo back");
    }

    #[tokio::test]
    async fn add_rejected_by_registry_is_400() {
        let reg = Arc::new(FakeRegistry::default());
        let router = router_with(Some(reg), true);
        let (status, _) = request(
            &router,
            "POST",
            "/api/library/devservers",
            Some(r#"{"host":"bad","port":1}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn mutation_on_read_only_surface_is_403() {
        // require_mutable runs FIRST: even with a registry installed, the
        // read-only devserver/gateway surface refuses every mutation with 403.
        let reg = Arc::new(FakeRegistry::seeded());
        let router = router_with(Some(reg), false);
        for (method, uri, body) in [
            (
                "POST",
                "/api/library/devservers",
                Some(r#"{"host":"x","port":1}"#),
            ),
            (
                "PUT",
                "/api/library/devservers/ds1",
                Some(r#"{"host":"x","port":1}"#),
            ),
            ("DELETE", "/api/library/devservers/ds1", None),
        ] {
            let (status, _) = request(&router, method, uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn mutation_without_registry_is_404() {
        // Loopback (mutable) but no registry installed -- defensive 404 (the
        // desktop loopback always installs one).
        let router = router_with(None, true);
        let (status, _) = request(
            &router,
            "POST",
            "/api/library/devservers",
            Some(r#"{"host":"x","port":1}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn update_and_remove_missing_id_is_404() {
        let reg = Arc::new(FakeRegistry::default());
        let router = router_with(Some(reg), true);
        // A synthesized gateway row id rides the same missing-id path: it is
        // never in the persisted registry, so mutations on it answer 404.
        let synth = format!("gw:1a2b3c4d:alice:{}", "a".repeat(64));
        for id in ["nope", synth.as_str()] {
            let (put_status, _) = request(
                &router,
                "PUT",
                &format!("/api/library/devservers/{id}"),
                Some(r#"{"host":"x","port":1}"#),
            )
            .await;
            assert_eq!(put_status, StatusCode::NOT_FOUND, "PUT {id}");
            let (del_status, _) = request(
                &router,
                "DELETE",
                &format!("/api/library/devservers/{id}"),
                None,
            )
            .await;
            assert_eq!(del_status, StatusCode::NOT_FOUND, "DELETE {id}");
        }
    }

    #[tokio::test]
    async fn remove_existing_is_204() {
        let reg = Arc::new(FakeRegistry::seeded());
        let router = router_with(Some(reg), true);
        let (status, _) = request(&router, "DELETE", "/api/library/devservers/ds1", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn add_devserver_carries_no_color_but_round_trips_auto_hide_control() {
        // The add/edit form carries no `color` (that is set from the
        // focus-border flow), but it DOES carry `auto_hide_control`,
        // echoed back.
        let reg = Arc::new(FakeRegistry::default());
        let router = router_with(Some(reg), true);
        let (status, body) = request(
            &router,
            "POST",
            "/api/library/devservers",
            Some(r#"{"host":"box","port":9000,"auto_hide_control":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["color"], serde_json::Value::Null);
        assert_eq!(body["auto_hide_control"], true);
    }

    /// An in-memory [`LocalColorStore`] so the local-color routes are exercised
    /// without a desktop: `get` reads the current value, `set` overwrites it.
    #[derive(Default)]
    struct FakeColorStore {
        color: Mutex<Option<String>>,
    }

    impl LocalColorStore for FakeColorStore {
        fn get(&self) -> Option<String> {
            self.color.lock().unwrap().clone()
        }
        fn set(&self, color: Option<String>) -> Result<(), String> {
            *self.color.lock().unwrap() = color;
            Ok(())
        }
    }

    /// A launcher router with an optional local-color store installed (the colour
    /// routes need no devserver registry). `mutable` opens the PUT gate.
    fn color_router(store: Option<Arc<dyn LocalColorStore>>, mutable: bool) -> axum::Router {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_at(dir.path().join("config.toml")).unwrap();
        std::mem::forget(dir);
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        if let Some(store) = store {
            host.install_local_color_store(store);
        }
        let serve_addr = mutable.then(|| {
            let cell = OnceLock::new();
            let _ = cell.set("127.0.0.1:8080".parse::<SocketAddr>().unwrap());
            Arc::new(cell)
        });
        launcher_router(host, None, serve_addr)
    }

    #[tokio::test]
    async fn local_color_get_default_is_null_without_store() {
        // No store installed (headless): GET reports the default accent as null.
        let router = color_router(None, true);
        let (status, body) = request(&router, "GET", "/api/library/local-color", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["color"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn local_color_set_then_get_round_trips() {
        let store = Arc::new(FakeColorStore::default());
        let router = color_router(Some(store), true);
        let (set_status, _) = request(
            &router,
            "PUT",
            "/api/library/local-color",
            Some(r##"{"color":"#0af"}"##),
        )
        .await;
        assert_eq!(set_status, StatusCode::NO_CONTENT);
        let (get_status, body) = request(&router, "GET", "/api/library/local-color", None).await;
        assert_eq!(get_status, StatusCode::OK);
        assert_eq!(body["color"], "#0af");
    }

    #[tokio::test]
    async fn local_color_set_works_on_the_devserver_surface_not_loopback_only() {
        // A library's colour is settable on its OWN serving host, including the
        // read-only/devserver surface (`mutable=false`): no `require_mutable`, so
        // a devserver window can set its devserver's colour. 204 with a store.
        let devserver_surface = color_router(Some(Arc::new(FakeColorStore::default())), false);
        let (status, _) = request(
            &devserver_surface,
            "PUT",
            "/api/library/local-color",
            Some(r##"{"color":"#0af"}"##),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        // No store installed: 404 (defensive) on any surface.
        let no_store = color_router(None, false);
        let (status, _) = request(
            &no_store,
            "PUT",
            "/api/library/local-color",
            Some(r##"{"color":"#0af"}"##),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// An in-memory [`LocalThemeStore`] so the local-theme routes are exercised
    /// without a desktop.
    #[derive(Default)]
    struct FakeThemeStore {
        theme: Mutex<Option<String>>,
    }

    impl LocalThemeStore for FakeThemeStore {
        fn get(&self) -> Option<String> {
            self.theme.lock().unwrap().clone()
        }
        fn set(&self, theme: Option<String>) -> Result<(), String> {
            *self.theme.lock().unwrap() = theme;
            Ok(())
        }
    }

    /// A launcher router with an optional local-theme store installed.
    fn theme_router(store: Option<Arc<dyn LocalThemeStore>>) -> axum::Router {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_at(dir.path().join("config.toml")).unwrap();
        std::mem::forget(dir);
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        if let Some(store) = store {
            host.install_local_theme_store(store);
        }
        launcher_router(host, None, None)
    }

    #[tokio::test]
    async fn local_theme_get_default_is_null_without_store() {
        // No store installed (headless devserver): GET reports OS-follow as null.
        let router = theme_router(None);
        let (status, body) = request(&router, "GET", "/api/library/local-theme", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["theme"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn local_theme_set_then_get_round_trips() {
        let store = Arc::new(FakeThemeStore::default());
        let router = theme_router(Some(store));
        let (set_status, _) = request(
            &router,
            "PUT",
            "/api/library/local-theme",
            Some(r#"{"theme":"light"}"#),
        )
        .await;
        assert_eq!(set_status, StatusCode::NO_CONTENT);
        let (get_status, body) = request(&router, "GET", "/api/library/local-theme", None).await;
        assert_eq!(get_status, StatusCode::OK);
        assert_eq!(body["theme"], "light");
    }

    #[tokio::test]
    async fn local_theme_set_404s_without_store_never_403() {
        // The config sub-router carries no `require_mutable`, so a store-less
        // surface answers 404 (not 403). The launcher PUT is best-effort and
        // swallows this rather than keying on a status code.
        let router = theme_router(None);
        let (status, _) = request(
            &router,
            "PUT",
            "/api/library/local-theme",
            Some(r#"{"theme":"light"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// An in-memory [`CollapsedMachinesStore`] so the collapsed-machines routes
    /// are exercised without a desktop.
    #[derive(Default)]
    struct FakeCollapsedStore {
        collapsed: Mutex<Vec<String>>,
    }

    impl CollapsedMachinesStore for FakeCollapsedStore {
        fn get(&self) -> Vec<String> {
            self.collapsed.lock().unwrap().clone()
        }
        fn set(&self, collapsed: Vec<String>) -> Result<(), String> {
            *self.collapsed.lock().unwrap() = collapsed;
            Ok(())
        }
    }

    /// A launcher router with an optional collapsed-machines store installed.
    fn collapsed_router(store: Option<Arc<dyn CollapsedMachinesStore>>) -> axum::Router {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_at(dir.path().join("config.toml")).unwrap();
        std::mem::forget(dir);
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        if let Some(store) = store {
            host.install_collapsed_machines_store(store);
        }
        launcher_router(host, None, None)
    }

    #[tokio::test]
    async fn collapsed_machines_get_is_null_without_store() {
        // No store installed (headless devserver): GET reports "no store" as
        // null, distinct from an installed-but-empty store's `[]`.
        let router = collapsed_router(None);
        let (status, body) = request(&router, "GET", "/api/library/collapsed-machines", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["collapsed"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn collapsed_machines_set_then_get_round_trips() {
        let store = Arc::new(FakeCollapsedStore::default());
        let router = collapsed_router(Some(store));
        let (set_status, _) = request(
            &router,
            "PUT",
            "/api/library/collapsed-machines",
            Some(r#"{"collapsed":["local","ds-1"]}"#),
        )
        .await;
        assert_eq!(set_status, StatusCode::NO_CONTENT);
        let (get_status, body) =
            request(&router, "GET", "/api/library/collapsed-machines", None).await;
        assert_eq!(get_status, StatusCode::OK);
        assert_eq!(body["collapsed"], serde_json::json!(["local", "ds-1"]));
    }

    #[tokio::test]
    async fn collapsed_machines_set_404s_without_store_never_403() {
        // Like local-theme: the config sub-router carries no `require_mutable`,
        // so a store-less surface answers 404 (not 403). The launcher PUT is
        // best-effort and swallows this rather than keying on a status code.
        let router = collapsed_router(None);
        let (status, _) = request(
            &router,
            "PUT",
            "/api/library/collapsed-machines",
            Some(r#"{"collapsed":["local"]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn local_workspace_off_confirms_on_live_terminals_then_force_offs() {
        // Parity with the devserver off: an unforced local off of a workspace
        // with live terminals → 409 `live_terminals` (the shared shape the
        // launcher already parses); retry with force:true → 204.
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        std::mem::forget(cfg);
        lib.register_workspace(root.path()).unwrap();
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));

        let prefix = chan_library::allocate_workspace_prefix(root.path()).unwrap();
        let id = prefix.trim_start_matches('/').to_string();
        host.open_registered_workspace(
            root.path(),
            chan_library::ServeConfig {
                addr: "127.0.0.1:0".parse().unwrap(),
                no_token: true,
                prefix: prefix.clone(),
                idle_timeout: None,
                open_browser: false,
                search_aggression: None,
                settings_disabled: false,
                verbose: false,
            },
        )
        .await
        .expect("mount workspace");

        // Spawn a live terminal in the workspace tenant via its HTTP create
        // endpoint (no-token tenant → no auth needed).
        let create = Request::builder()
            .method("POST")
            .uri(format!("{prefix}/api/terminals"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"name":"t","command":"sleep 60"}"#))
            .unwrap();
        let created = host.clone().router().oneshot(create).await.unwrap();
        assert_eq!(created.status(), StatusCode::CREATED, "terminal spawned");
        assert_eq!(host.tenant_terminal_session_count(&prefix), 1);

        let serve_addr = {
            let cell = OnceLock::new();
            let _ = cell.set("127.0.0.1:8080".parse::<SocketAddr>().unwrap());
            Arc::new(cell)
        };
        let launcher = launcher_router(host.clone(), None, Some(serve_addr));
        let off_uri = format!("/api/library/workspaces/{id}/off");
        let remove_uri = format!("/api/library/workspaces/{id}");

        // Unforced off → 409 + the shared live_terminals body with the count.
        let (status, body) = request(&launcher, "POST", &off_uri, None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "live_terminals");
        assert_eq!(body["active_terminals"], 1);
        assert_eq!(host.tenant_terminal_session_count(&prefix), 1);

        // Unforced remove uses the same owner-side guard and body, and leaves
        // the running workspace intact.
        let (status, body) = request(&launcher, "DELETE", &remove_uri, None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"], "live_terminals");
        assert_eq!(body["active_terminals"], 1);
        assert_eq!(host.tenant_terminal_session_count(&prefix), 1);

        // Retry with force → the off goes through (204).
        let (status, _) = request(&launcher, "POST", &off_uri, Some(r#"{"force":true}"#)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
}

#[cfg(test)]
mod gateway_route_tests {
    //! The gateway CRUD guard stack, mirroring the devserver trio:
    //! `require_mutable` first (403 read-only) then registry-keyed (404
    //! absent / 400 rejected). Connect/disconnect are bridge ops covered in
    //! `window_op_route_tests`.
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex, OnceLock};

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use chan_workspace::Library;
    use tower::ServiceExt;

    use super::launcher_router;
    use crate::{GatewayEntry, GatewayInput, GatewayRegistry, GatewayStatus, WorkspaceHost};

    /// An in-memory `GatewayRegistry` standing in for the desktop config so
    /// the route gates are exercised without a desktop. `add` echoes the
    /// input back as a stored row; `add`/`update` reject the sentinel url
    /// `"bad"` to drive the 400 path; `update`/`remove` answer
    /// `Ok(None)`/`Ok(false)` unless the id is present.
    #[derive(Default)]
    struct FakeGatewayRegistry {
        rows: Mutex<Vec<GatewayEntry>>,
    }

    impl FakeGatewayRegistry {
        fn seeded() -> Self {
            FakeGatewayRegistry {
                rows: Mutex::new(vec![GatewayEntry {
                    id: "gw-1a2b3c4d".into(),
                    url: "https://gw.chan.app".into(),
                    label: "work".into(),
                    enabled: true,
                    status: GatewayStatus::Disconnected,
                    pending_signin: false,
                    devserver_count: 0,
                    last_error: None,
                }]),
            }
        }
    }

    impl GatewayRegistry for FakeGatewayRegistry {
        fn list(&self) -> Vec<GatewayEntry> {
            self.rows.lock().unwrap().clone()
        }
        fn add(&self, input: GatewayInput) -> Result<GatewayEntry, String> {
            if input.url == "bad" {
                return Err("rejected url".into());
            }
            let entry = GatewayEntry {
                id: "gw-feedface".into(),
                url: input.url,
                label: input.label.unwrap_or_default(),
                enabled: true,
                status: GatewayStatus::Disconnected,
                pending_signin: false,
                devserver_count: 0,
                last_error: None,
            };
            self.rows.lock().unwrap().push(entry.clone());
            Ok(entry)
        }
        fn update(&self, id: &str, input: GatewayInput) -> Result<Option<GatewayEntry>, String> {
            if input.url == "bad" {
                return Err("rejected url".into());
            }
            let mut rows = self.rows.lock().unwrap();
            let Some(row) = rows.iter_mut().find(|r| r.id == id) else {
                return Ok(None);
            };
            row.label = input.label.unwrap_or_default();
            Ok(Some(row.clone()))
        }
        fn remove(&self, id: &str) -> Result<bool, String> {
            let mut rows = self.rows.lock().unwrap();
            let before = rows.len();
            rows.retain(|r| r.id != id);
            Ok(rows.len() != before)
        }
    }

    /// A launcher router over an empty host with the given gateway registry
    /// installed (or none). `mutable` true → a loopback surface with a bound
    /// `serve_addr`; false → the read-only devserver/gateway surface.
    fn router_with(registry: Option<Arc<dyn GatewayRegistry>>, mutable: bool) -> axum::Router {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_at(dir.path().join("config.toml")).unwrap();
        // The router never reads the config file again; leak the dir so the
        // path the Library holds stays valid for the (short) test body.
        std::mem::forget(dir);
        let host = Arc::new(WorkspaceHost::new(lib, crate::route_builder()));
        if let Some(reg) = registry {
            host.install_gateway_registry(reg);
        }
        let serve_addr = mutable.then(|| {
            let cell = OnceLock::new();
            let _ = cell.set("127.0.0.1:8080".parse::<SocketAddr>().unwrap());
            Arc::new(cell)
        });
        launcher_router(host, None, serve_addr)
    }

    async fn request(
        router: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method(method).uri(uri);
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn list_serves_empty_without_registry_on_both_surfaces() {
        for mutable in [true, false] {
            let router = router_with(None, mutable);
            let (status, body) = request(&router, "GET", "/api/library/gateways", None).await;
            assert_eq!(status, StatusCode::OK, "mutable={mutable}");
            assert_eq!(body, serde_json::json!([]), "mutable={mutable}");
        }
    }

    #[tokio::test]
    async fn list_returns_seeded_rows() {
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::seeded())), false);
        let (status, body) = request(&router, "GET", "/api/library/gateways", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["id"], "gw-1a2b3c4d");
        assert_eq!(body[0]["url"], "https://gw.chan.app");
        assert_eq!(body[0]["status"], "disconnected");
        assert_eq!(body[0]["devserver_count"], 0);
        assert_eq!(body[0]["last_error"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn add_on_loopback_returns_row_and_label_is_optional() {
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::default())), true);
        let (status, body) = request(
            &router,
            "POST",
            "/api/library/gateways",
            Some(r#"{"url":"https://gw.chan.app"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], "gw-feedface");
        assert_eq!(body["label"], "");
        assert_eq!(body["enabled"], true);
    }

    #[tokio::test]
    async fn add_rejected_by_registry_is_400() {
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::default())), true);
        let (status, _) = request(
            &router,
            "POST",
            "/api/library/gateways",
            Some(r#"{"url":"bad"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_renames_and_missing_id_is_404() {
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::seeded())), true);
        let (status, body) = request(
            &router,
            "PUT",
            "/api/library/gateways/gw-1a2b3c4d",
            Some(r#"{"url":"https://gw.chan.app","label":"prod"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], "gw-1a2b3c4d");
        assert_eq!(body["label"], "prod");
        let (status, _) = request(
            &router,
            "PUT",
            "/api/library/gateways/gw-ghost",
            Some(r#"{"url":"https://gw.chan.app","label":"prod"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn update_rejected_by_registry_is_400() {
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::seeded())), true);
        let (status, _) = request(
            &router,
            "PUT",
            "/api/library/gateways/gw-1a2b3c4d",
            Some(r#"{"url":"bad"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn mutation_on_read_only_surface_is_403() {
        // require_mutable runs FIRST: even with a registry installed, the
        // read-only devserver/gateway surface refuses every mutation.
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::seeded())), false);
        for (method, uri, body) in [
            (
                "POST",
                "/api/library/gateways",
                Some(r#"{"url":"https://x.example"}"#),
            ),
            (
                "PUT",
                "/api/library/gateways/gw-1a2b3c4d",
                Some(r#"{"url":"https://gw.chan.app","label":"x"}"#),
            ),
            ("DELETE", "/api/library/gateways/gw-1a2b3c4d", None),
        ] {
            let (status, _) = request(&router, method, uri, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn mutation_without_registry_is_404() {
        // Loopback (mutable) but no registry installed -- defensive 404 (the
        // desktop loopback always installs one).
        let router = router_with(None, true);
        let (status, _) = request(
            &router,
            "POST",
            "/api/library/gateways",
            Some(r#"{"url":"https://x.example"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = request(
            &router,
            "PUT",
            "/api/library/gateways/gw-x",
            Some(r#"{"url":"https://x.example"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = request(&router, "DELETE", "/api/library/gateways/gw-x", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn remove_existing_is_204_and_missing_is_404() {
        let router = router_with(Some(Arc::new(FakeGatewayRegistry::seeded())), true);
        let (status, _) =
            request(&router, "DELETE", "/api/library/gateways/gw-1a2b3c4d", None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) =
            request(&router, "DELETE", "/api/library/gateways/gw-1a2b3c4d", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}

#[cfg(test)]
mod window_op_route_tests {
    //! The launcher window open/hide routes: with a desktop bridge attached they
    //! dispatch and answer 204; with none (the standalone serve / devserver
    //! surface) they answer 409 carrying `NO_DESKTOP`.
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use chan_library::windows::WindowRegistry;
    use chan_workspace::Library;
    use tower::ServiceExt;

    use super::{launcher_router, leader_gate};
    use crate::{
        DesktopBridge, DesktopWindowOp, DevserverFeedSource, LauncherWorkspace,
        SetWorkspaceOnOutcome, WindowKind, WindowOrigin, WindowRecord, WorkspaceHost, NO_DESKTOP,
    };

    struct RemoteWindowFeed(WindowRecord);

    impl DevserverFeedSource for RemoteWindowFeed {
        fn windows(&self) -> Vec<WindowRecord> {
            vec![self.0.clone()]
        }

        fn workspaces(&self) -> Vec<LauncherWorkspace> {
            Vec::new()
        }

        fn pane_color(&self, _library_id: &str) -> Option<String> {
            None
        }
    }

    fn library() -> Library {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open_at(dir.path().join("config.toml")).unwrap();
        // The router never reads the config file again; leak the dir so the path
        // the Library holds stays valid for the (short) test body.
        std::mem::forget(dir);
        lib
    }

    async fn post(router: &axum::Router, uri: &str) -> (StatusCode, String) {
        send(router, "POST", uri, None).await
    }

    /// Drive any method, optionally with a JSON body (sets the content-type so the
    /// `Json` extractor accepts it -- needed for `workspaces/open`).
    async fn send(
        router: &axum::Router,
        method: &str,
        uri: &str,
        json: Option<&str>,
    ) -> (StatusCode, String) {
        let mut builder = Request::builder().method(method).uri(uri);
        let body = match json {
            Some(j) => {
                builder = builder.header("content-type", "application/json");
                Body::from(j.to_string())
            }
            None => Body::empty(),
        };
        let response = router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[test]
    fn leader_gate_is_honest_client_policy() {
        // Leaderless: allowed regardless of any claim.
        assert!(leader_gate(None, None).is_ok());
        assert!(leader_gate(None, Some("w-x")).is_ok());
        // A live leader: a matching claim passes.
        assert!(leader_gate(Some("w-leader".into()), Some("w-leader")).is_ok());
        // A live leader: a legacy caller with NO claim passes (the desktop path).
        assert!(leader_gate(Some("w-leader".into()), None).is_ok());
        // A live leader plus a PRESENT, mismatching claim is the only rejection.
        let err = leader_gate(Some("w-leader".into()), Some("w-other")).unwrap_err();
        assert_eq!(err.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn mint_is_allowed_when_leaderless_and_for_legacy_callers() {
        let host = Arc::new(WorkspaceHost::new(library(), crate::route_builder()));
        let store = tempfile::tempdir().unwrap();
        host.install_window_registry(
            Arc::new(chan_library::windows::WindowRegistry::open(
                store.path().join("windows.json"),
            )),
            "local".into(),
        );
        std::mem::forget(store);
        let router = launcher_router(host, None, None);

        // No tenant is mounted, so the target terminal tenant has no live leader:
        // a mint is allowed even with a claimed acting id (leaderless establishes
        // leadership later at the /ws connect).
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/windows",
            Some(r#"{"kind":"terminal","acting_window_id":"w-claims-lead"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "leaderless mint with a claim");

        // A legacy caller with no acting id is allowed too.
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/windows",
            Some(r#"{"kind":"terminal"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "legacy mint");
    }

    #[tokio::test]
    async fn open_and_hide_with_a_desktop_are_204() {
        // A fake desktop drains the op channel and replies Ok(()) to the unit-reply
        // ops, so the route maps the dispatch success to 204.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<DesktopWindowOp>(4);
        let bridge = DesktopBridge {
            window_ops: Some(tx),
            window_titles: Default::default(),
        };
        let host = Arc::new(WorkspaceHost::with_desktop_bridge(
            library(),
            bridge,
            crate::route_builder(),
        ));
        tokio::spawn(async move {
            while let Some(op) = rx.recv().await {
                match op {
                    DesktopWindowOp::Open { reply, .. }
                    | DesktopWindowOp::Hide { reply, .. }
                    | DesktopWindowOp::ConnectDevserver { reply, .. }
                    | DesktopWindowOp::DisconnectDevserver { reply, .. }
                    | DesktopWindowOp::GrantDevserverNativeTrust { reply, .. }
                    | DesktopWindowOp::RevokeDevserverNativeTrust { reply, .. }
                    | DesktopWindowOp::OpenDevserverTerminal { reply, .. }
                    | DesktopWindowOp::OpenDevserverWorkspace { reply, .. }
                    | DesktopWindowOp::ConnectGateway { reply, .. }
                    | DesktopWindowOp::DisconnectGateway { reply, .. } => {
                        let _ = reply.send(Ok(()));
                    }
                    DesktopWindowOp::SetDevserverWorkspaceOn { reply, .. }
                    | DesktopWindowOp::ForgetDevserverWorkspace { reply, .. } => {
                        let _ = reply.send(Ok(SetWorkspaceOnOutcome::Done));
                    }
                    DesktopWindowOp::PickFolder { reply } => {
                        let _ = reply.send(Ok(Some("/picked/dir".to_string())));
                    }
                    _ => {}
                }
            }
        });
        let router = launcher_router(host, None, None);
        for verb in ["open", "hide"] {
            let (status, _) = post(&router, &format!("/api/library/windows/w-1/{verb}")).await;
            assert_eq!(status, StatusCode::NO_CONTENT, "{verb}");
        }
        // Devserver connect rides the same bridge: a desktop drains it and the
        // route maps the dispatch success to 204.
        let (status, _) = post(&router, "/api/library/devservers/ds1/connect").await;
        assert_eq!(status, StatusCode::NO_CONTENT, "connect");
        for method in ["PUT", "DELETE"] {
            let (status, _) = send(
                &router,
                method,
                "/api/library/devservers/gw%3A1%3Aalice%3Adev/native-trust",
                None,
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT, "native trust {method}");
        }
        // The 5 new devserver bridge ops ride the same bridge → 204. disconnect +
        // terminal take no body; open carries {path}; on/off/forget carry {prefix}.
        for uri in [
            "/api/library/devservers/ds1/disconnect",
            "/api/library/devservers/ds1/terminal",
        ] {
            let (status, _) = post(&router, uri).await;
            assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        }
        // Gateway connect/disconnect ride the same bridge → 204.
        for uri in [
            "/api/library/gateways/gw-1/connect",
            "/api/library/gateways/gw-1/disconnect",
        ] {
            let (status, _) = post(&router, uri).await;
            assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        }
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/open",
            Some(r#"{"path":"/remote/ws"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "workspaces/open");
        for uri in [
            "/api/library/devservers/ds1/workspaces/on",
            "/api/library/devservers/ds1/workspaces/off",
            "/api/library/devservers/ds1/workspaces/forget",
        ] {
            let (status, _) = send(&router, "POST", uri, Some(r#"{"prefix":"myws"}"#)).await;
            assert_eq!(status, StatusCode::NO_CONTENT, "{uri}");
        }
        // Pick-folder returns the chosen path as a JSON string (200).
        let (status, body) = post(&router, "/api/library/fs/pick-folder").await;
        assert_eq!(status, StatusCode::OK, "pick-folder");
        assert_eq!(body, "\"/picked/dir\"", "pick-folder path json");
    }

    #[tokio::test]
    async fn close_discards_a_saved_local_row_even_without_a_live_native_window() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<DesktopWindowOp>(2);
        let bridge = DesktopBridge {
            window_ops: Some(tx),
            window_titles: Default::default(),
        };
        let host = Arc::new(WorkspaceHost::with_desktop_bridge(
            library(),
            bridge,
            crate::route_builder(),
        ));
        let store = tempfile::tempdir().unwrap();
        host.install_window_registry(
            Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
            "local".into(),
        );
        let id = host
            .mint_window(chan_library::windows::WindowKind::Terminal, None)
            .expect("mint")
            .window_id;
        tokio::spawn(async move {
            while let Some(op) = rx.recv().await {
                if let DesktopWindowOp::Close { reply, .. } = op {
                    // Hidden/offline row: no native webview was destroyed. The
                    // route must still discard the durable library record.
                    let _ = reply.send(Ok(false));
                }
            }
        });
        let router = launcher_router(host.clone(), None, None);
        let (status, _) = post(&router, &format!("/api/library/windows/{id}/close")).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(host
            .assemble_window_records()
            .iter()
            .all(|record| record.window_id != id));

        let (status, _) = post(&router, "/api/library/windows/nope/close").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn label_for_an_aggregated_remote_window_crosses_the_desktop_bridge() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<DesktopWindowOp>(1);
        let bridge = DesktopBridge {
            window_ops: Some(tx),
            window_titles: Default::default(),
        };
        let host = Arc::new(WorkspaceHost::with_desktop_bridge(
            library(),
            bridge,
            crate::route_builder(),
        ));
        let store = tempfile::tempdir().unwrap();
        host.install_window_registry(
            Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
            "local".into(),
        );
        host.install_devserver_feed(Arc::new(RemoteWindowFeed(WindowRecord {
            window_id: "w-remote".into(),
            library_id: "lib-remote".into(),
            kind: WindowKind::Workspace,
            title: "⌂ /srv/project Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: Some("/srv/project".into()),
            prefix: "/workspace-project".into(),
            token: "token".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: WindowOrigin::Native,
        })));
        let received = tokio::spawn(async move {
            let Some(DesktopWindowOp::SetWindowLabel { id, label, reply }) = rx.recv().await else {
                panic!("expected SetWindowLabel");
            };
            assert_eq!(id, "w-remote");
            assert_eq!(label, "remote caption");
            let _ = reply.send(Ok(()));
        });
        let router = launcher_router(host, None, None);
        let (status, _) = send(
            &router,
            "PUT",
            "/api/library/windows/w-remote/label",
            Some(r#"{"label":" remote caption "}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        received.await.unwrap();
    }

    #[tokio::test]
    async fn visibility_route_sets_persisted_hidden() {
        // The /visibility route persists the field directly (no desktop
        // bridge) and the feed reflects it. Install a registry + mint a window.
        let host = Arc::new(WorkspaceHost::new(library(), crate::route_builder()));
        let store = tempfile::tempdir().unwrap();
        host.install_window_registry(
            Arc::new(chan_library::windows::WindowRegistry::open(
                store.path().join("windows.json"),
            )),
            "local".into(),
        );
        let id = host
            .mint_window(chan_library::windows::WindowKind::Terminal, None)
            .expect("mint")
            .window_id;
        let router = launcher_router(host, None, None);
        let vis = format!("/api/library/windows/{id}/visibility");

        // Bury → 204; the feed surfaces hidden=true.
        let (status, _) = send(&router, "POST", &vis, Some(r#"{"hidden":true}"#)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "bury");
        let (status, body) = send(&router, "GET", "/api/library/windows", None).await;
        assert_eq!(status, StatusCode::OK);
        let feed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let row = feed
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["window_id"] == id)
            .expect("window in feed");
        assert_eq!(row["hidden"], true, "hidden surfaced on the wire");

        // Unbury → 204; hidden omitted from the wire (skip-if-default).
        let (status, _) = send(&router, "POST", &vis, Some(r#"{"hidden":false}"#)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "unbury");
        let (_, body) = send(&router, "GET", "/api/library/windows", None).await;
        let feed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let row = feed
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["window_id"] == id)
            .unwrap();
        assert!(row.get("hidden").is_none(), "visible window omits hidden");

        // Unknown id → 404.
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/windows/nope/visibility",
            Some(r#"{"hidden":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "unknown id");
    }

    /// Setting the colour fires the dedicated `local_color_notify` (the
    /// signal `local-color/watch` awaits) AND the new value is immediately
    /// readable. The WS push loop (`watch_local_color`) is a line-for-line mirror
    /// of the window watch; this covers the new wiring (set ⇒ broadcast signal ⇒
    /// fresh read) without a WS-client dep the chan-server test harness lacks.
    #[tokio::test]
    async fn set_local_color_fires_notify_and_is_readable() {
        struct MemColor(std::sync::Mutex<Option<String>>);
        impl chan_library::LocalColorStore for MemColor {
            fn get(&self) -> Option<String> {
                self.0.lock().unwrap().clone()
            }
            fn set(&self, color: Option<String>) -> Result<(), String> {
                *self.0.lock().unwrap() = color;
                Ok(())
            }
        }
        let host = Arc::new(WorkspaceHost::new(library(), crate::route_builder()));
        host.install_local_color_store(Arc::new(MemColor(std::sync::Mutex::new(None))));
        let router = launcher_router(host.clone(), None, None);

        // Arm the colour-change waiter BEFORE the set (notify_waiters has no
        // permit, so the waiter must exist first -- same ordering the watch uses).
        let notify = host.local_color_notify();
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        let (status, _) = send(
            &router,
            "PUT",
            "/api/library/local-color",
            Some(r##"{"color":"#ff00ff"}"##),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "set colour");

        // The dedicated notify fired (so a watcher would re-push).
        tokio::time::timeout(std::time::Duration::from_millis(500), notified)
            .await
            .expect("local_color_notify fired on set");

        // The new colour is immediately readable (what the watch re-sends).
        let (status, body) = send(&router, "GET", "/api/library/local-color", None).await;
        assert_eq!(status, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["color"], "#ff00ff");
    }

    #[tokio::test]
    async fn open_and_hide_without_a_desktop_are_409_no_desktop() {
        // The default host has no `window_ops` sender (standalone / devserver):
        // dispatch refuses with NO_DESKTOP, which the route maps to 409.
        let host = Arc::new(WorkspaceHost::new(library(), crate::route_builder()));
        let router = launcher_router(host, None, None);
        for verb in ["open", "hide"] {
            let (status, body) = post(&router, &format!("/api/library/windows/w-1/{verb}")).await;
            assert_eq!(status, StatusCode::CONFLICT, "{verb}");
            assert_eq!(body, NO_DESKTOP, "{verb}");
        }
        // Connect is inert without a desktop too -- 409 NO_DESKTOP, so the
        // launcher button is safe to show even where it can't act.
        let (status, body) = post(&router, "/api/library/devservers/ds1/connect").await;
        assert_eq!(status, StatusCode::CONFLICT, "connect");
        assert_eq!(body, NO_DESKTOP, "connect");
        for method in ["PUT", "DELETE"] {
            let (status, body) = send(
                &router,
                method,
                "/api/library/devservers/gw%3A1%3Aalice%3Adev/native-trust",
                None,
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "native trust {method}");
            assert_eq!(body, NO_DESKTOP, "native trust {method}");
        }
        // The new devserver bridge ops are inert without a desktop too -- 409
        // NO_DESKTOP, so the launcher's row buttons are safe to show everywhere.
        for uri in [
            "/api/library/devservers/ds1/disconnect",
            "/api/library/devservers/ds1/terminal",
        ] {
            let (status, body) = post(&router, uri).await;
            assert_eq!(status, StatusCode::CONFLICT, "{uri}");
            assert_eq!(body, NO_DESKTOP, "{uri}");
        }
        // Gateway connect/disconnect are inert without a desktop -- 409
        // NO_DESKTOP with the pinned body, distinguishable from the
        // live_terminals JSON 409.
        for uri in [
            "/api/library/gateways/gw-1/connect",
            "/api/library/gateways/gw-1/disconnect",
        ] {
            let (status, body) = post(&router, uri).await;
            assert_eq!(status, StatusCode::CONFLICT, "{uri}");
            assert_eq!(body, NO_DESKTOP, "{uri}");
        }
        let (status, body) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/open",
            Some(r#"{"path":"/remote/ws"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "workspaces/open");
        assert_eq!(body, NO_DESKTOP, "workspaces/open");
        for uri in [
            "/api/library/devservers/ds1/workspaces/on",
            "/api/library/devservers/ds1/workspaces/off",
            "/api/library/devservers/ds1/workspaces/forget",
        ] {
            let (status, body) = send(&router, "POST", uri, Some(r#"{"prefix":"myws"}"#)).await;
            assert_eq!(status, StatusCode::CONFLICT, "{uri}");
            assert_eq!(body, NO_DESKTOP, "{uri}");
        }
        // Pick-folder is inert without a desktop too -- 409 NO_DESKTOP, so the
        // launcher falls back to plain text entry.
        let (status, body) = post(&router, "/api/library/fs/pick-folder").await;
        assert_eq!(status, StatusCode::CONFLICT, "pick-folder");
        assert_eq!(body, NO_DESKTOP, "pick-folder");
    }

    #[tokio::test]
    async fn native_trust_mutation_is_forbidden_from_non_owner_tunnel() {
        let host = Arc::new(WorkspaceHost::new(library(), crate::route_builder()));
        let router = launcher_router(host, None, None);

        for method in ["PUT", "DELETE"] {
            let request = Request::builder()
                .method(method)
                .uri("/api/library/devservers/gw%3A1%3Aalice%3Adev/native-trust")
                .extension(crate::TunnelOrigin { caller: None })
                .body(Body::empty())
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method}");
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&body),
                "launcher mutation is not available for this gateway role",
                "{method}"
            );
        }
    }

    #[tokio::test]
    async fn tunnel_legs_are_refused_for_a_non_owner_gateway_role() {
        // Both legs are GET, so the mutation gate does not cover them and a
        // tunnel-origin request bypasses the launcher bearer. Without the owner
        // gate a grantee who learned a tunnel id could open a listener on the
        // owner's desktop.
        let host = Arc::new(WorkspaceHost::new(library(), crate::route_builder()));
        let router = launcher_router(host, None, None);

        for uri in [
            "/api/library/tunnel/control?tunnel=tun-1",
            "/api/library/tunnel/conn?tunnel=tun-1&conn=c0",
        ] {
            let request = Request::builder()
                .method("GET")
                .uri(uri)
                .extension(crate::TunnelOrigin { caller: None })
                .body(Body::empty())
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&body),
                "reverse tunnels are not available for this gateway role",
                "{uri}"
            );

            // A local request carries no tunnel origin, so the gate must pass
            // it through. It lands on the `WebSocketUpgrade` extractor, which
            // rejects this plain GET as a bad request: not the gate's 403, and
            // proof the gate does not over-block the loopback surface.
            let request = Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[tokio::test]
    async fn devserver_workspace_off_force_confirm_round_trip() {
        // A fake desktop that mirrors the live-terminals guard: an UNforced off
        // replies NeedsForce(count); an on, or a forced off, replies Done.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<DesktopWindowOp>(4);
        let bridge = DesktopBridge {
            window_ops: Some(tx),
            window_titles: Default::default(),
        };
        let host = Arc::new(WorkspaceHost::with_desktop_bridge(
            library(),
            bridge,
            crate::route_builder(),
        ));
        tokio::spawn(async move {
            while let Some(op) = rx.recv().await {
                match op {
                    DesktopWindowOp::SetDevserverWorkspaceOn {
                        on, force, reply, ..
                    } => {
                        let outcome = if !on && !force {
                            SetWorkspaceOnOutcome::NeedsForce {
                                active_terminals: 2,
                            }
                        } else {
                            SetWorkspaceOnOutcome::Done
                        };
                        let _ = reply.send(Ok(outcome));
                    }
                    DesktopWindowOp::ForgetDevserverWorkspace { force, reply, .. } => {
                        let outcome = if !force {
                            SetWorkspaceOnOutcome::NeedsForce {
                                active_terminals: 2,
                            }
                        } else {
                            SetWorkspaceOnOutcome::Done
                        };
                        let _ = reply.send(Ok(outcome));
                    }
                    _ => {}
                }
            }
        });
        let router = launcher_router(host, None, None);
        // Unforced off with live terminals → 409 + the distinguishable
        // live-terminals body the launcher confirms against.
        let (status, body) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/off",
            Some(r#"{"prefix":"myws"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "unforced off");
        assert_eq!(
            body, r#"{"error":"live_terminals","active_terminals":2}"#,
            "needs-force body"
        );
        // Retried with force:true → force-off → 204.
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/off",
            Some(r#"{"prefix":"myws","force":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "forced off");
        // On never blocks on terminals → 204 (force irrelevant).
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/on",
            Some(r#"{"prefix":"myws"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "on");
        // Forget shares the same refusal body and force retry contract.
        let (status, body) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/forget",
            Some(r#"{"prefix":"myws"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "unforced forget");
        assert_eq!(
            body, r#"{"error":"live_terminals","active_terminals":2}"#,
            "needs-force body"
        );
        let (status, _) = send(
            &router,
            "POST",
            "/api/library/devservers/ds1/workspaces/forget",
            Some(r#"{"prefix":"myws","force":true}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "forced forget");
    }
}
