//! The declared caller authority of every route chan-server mounts.
//!
//! A devserver serves the same app on its loopback bind and, through the
//! gateway tunnel, to callers the gateway authenticated. `auth_middleware`
//! admits every tunnel request past the tenant bearer because the gateway is
//! the trust boundary, and the gateway in turn leaves the decision between
//! owner and non-owner to the devserver. A non-owner here is a `TunnelOrigin`
//! whose `owner()` is false, and who that caller is depends on the route:
//!
//! - On a tenant `/api` route, and on the tenant `/ws` bus, a non-owner is an
//!   invited grantee. The gateway admits only the owner and a grantee to a
//!   devserver session, and a grant is one binary, shell-equivalent authority
//!   over the devserver, not a viewer or editor role
//!   (`gateway/migrations/0014_drop_devserver_grant_roles.sql`).
//! - The one caller with a nil subject, the extension capability lane, is
//!   path-gated by the gateway proxy to `/_chan/extensions/...` and never
//!   reaches a tenant `/api` route. On those extension routes a non-owner is
//!   either that caller or a grantee.
//! - On the launcher, `require_local_mutation` and `require_tunnel_owner` are
//!   what separate a grantee from the owner: a grantee cannot mutate the
//!   owner's library or open reverse tunnels.
//!
//! What a non-owner may do with a route cannot be read off the HTTP verb:
//! some reads are POSTs (workspace search, the team-config read, draft
//! inspection) and some GETs confer shell or write access (the terminal and
//! document WebSocket upgrades).
//!
//! So each route's authority is written down, one row per `(verb, path)` a
//! router mounts, in the table for that router. The tables describe the
//! routers; nothing at runtime consults them. A test walks each assembled
//! router and fails on a mounted route with no row and on a row with no route,
//! so a route cannot be added without somebody classifying it. A second test
//! sends every row through its router as a non-owner and fails where the
//! router's gates disagree with the row.

/// An HTTP verb a route answers. HEAD is served by the GET handler unless a
/// route registers its own, so a GET row covers it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Verb {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Trace,
    Connect,
    /// Only on the [`FALLBACK`] row: a router's fallback answers every verb
    /// on every path no route matched.
    Any,
}

/// What a non-owner tunnel caller may do with a route. On a tenant `/api`
/// route that caller is an invited grantee holding shell-equivalent authority;
/// the module docs give the whole caller model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Authority {
    /// Answered before any caller authority is consulted: static assets, the
    /// devserver's liveness and identity probes, and the fallback that
    /// dispatches into the tenants (whose own tables then apply).
    Public,
    /// A non-owner reaches the handler: no gate on the route consults the
    /// caller's role. A handler that refuses one request shape by role says
    /// so in a comment on its row.
    NonOwner,
    /// A non-owner is refused with 403; the owner and a local caller reach the
    /// handler.
    Owner,
    /// Only a caller holding the devserver's local bearer reaches the
    /// handler. The gateway strips client credentials, so no tunnel caller
    /// does, the owner included.
    Local,
}

/// One route table: `(verb, path, authority)` rows, paths spelled exactly as
/// the router registers them.
pub(crate) type RouteTable = &'static [(Verb, &'static str, Authority)];

/// The path of a router's fallback row. Never a routable path: every axum
/// route path starts with `/`.
pub(crate) const FALLBACK: &str = "{fallback}";

use Authority::{Local, NonOwner, Owner, Public};
use Verb::{Any, Connect, Delete, Get, Options, Patch, Post, Put, Trace};

/// The workspace tenant: `router_with_extensions` in `lib.rs`.
pub(crate) static WORKSPACE_TENANT: RouteTable = &[
    // The settings-write lane. `settings_guard` refuses it on a
    // `--no-settings` serve for every caller alike; it never consults the
    // caller's role.
    (Patch, "/api/config", NonOwner),
    (Post, "/api/storage/reset", NonOwner),
    (Post, "/api/index/rebuild", NonOwner),
    #[cfg(feature = "embeddings")]
    (Post, "/api/index/semantic/enable", NonOwner),
    #[cfg(feature = "embeddings")]
    (Post, "/api/index/semantic/disable", NonOwner),
    #[cfg(feature = "embeddings")]
    (Post, "/api/index/semantic/download", NonOwner),
    #[cfg(feature = "embeddings")]
    (Patch, "/api/index/semantic/model", NonOwner),
    (Post, "/api/index/reports/enable", NonOwner),
    (Post, "/api/index/reports/disable", NonOwner),
    (Patch, "/api/screensaver/state", NonOwner),
    (Post, "/api/screensaver/pin", NonOwner),
    (Delete, "/api/screensaver/pin", NonOwner),
    (Post, "/api/metadata/export", NonOwner),
    (Post, "/api/metadata/import", NonOwner),
    // The open lane: no route layer consults the caller's role.
    (Get, "/api/workspace", NonOwner),
    (Get, "/api/workspace/bootstrap", NonOwner),
    (Get, "/api/cloud-workspaces", NonOwner),
    (Get, "/api/fs", NonOwner),
    (Post, "/api/fs", NonOwner),
    // `api_upload_file` refuses a non-owner's `?root=filesystem` upload
    // itself; the route is open.
    (Post, "/api/fs/upload", NonOwner),
    (Post, "/api/drafts/new", NonOwner),
    (Post, "/api/diagrams/new", NonOwner),
    (Post, "/api/drafts/inspect", NonOwner),
    (Post, "/api/drafts/discard", NonOwner),
    (Post, "/api/drafts/promote", NonOwner),
    (Post, "/api/session-conflicts/resolve", NonOwner),
    (Post, "/api/team-config/read", NonOwner),
    (Post, "/api/team-config/write", NonOwner),
    (Post, "/api/survey/reply", NonOwner),
    (Post, "/api/window/reply", NonOwner),
    (Post, "/api/open", NonOwner),
    (Post, "/api/session/handover/reply", NonOwner),
    // `api_read_file` refuses a non-owner's `?root=filesystem` read itself;
    // the route is open.
    (Get, "/api/fs/{*path}", NonOwner),
    (Delete, "/api/fs/{*path}", NonOwner),
    (Put, "/api/fs/{*path}", NonOwner),
    (Post, "/api/move", NonOwner),
    (Post, "/api/fs/transfer", NonOwner),
    (Get, "/api/search/files", NonOwner),
    (Get, "/api/search/content", NonOwner),
    (Post, "/api/search/workspace", NonOwner),
    (Get, "/api/index/status", NonOwner),
    (Get, "/api/indexing/state", NonOwner),
    (Get, "/api/index/excluded-dirs", NonOwner),
    (Put, "/api/index/excluded-dirs", NonOwner),
    (Get, "/api/preflight", NonOwner),
    (Post, "/api/preflight/decision", NonOwner),
    (Get, "/api/link-targets", NonOwner),
    (Get, "/api/resolve-link", NonOwner),
    (Get, "/api/headings/{*path}", NonOwner),
    (Get, "/api/links", NonOwner),
    (Get, "/api/graph", NonOwner),
    (Get, "/api/graph/languages", NonOwner),
    (Get, "/api/fs-graph", NonOwner),
    (Get, "/api/inspector", NonOwner),
    (Get, "/api/mentions", NonOwner),
    (Get, "/api/backlinks/{*path}", NonOwner),
    (Get, "/api/report/file", NonOwner),
    (Get, "/api/report/prefix", NonOwner),
    (Get, "/api/report/dir", NonOwner),
    (Get, "/api/config", NonOwner),
    (Get, "/api/build-info", NonOwner),
    (Get, "/api/extensions", NonOwner),
    (Get, "/api/session", NonOwner),
    (Put, "/api/session", NonOwner),
    (Delete, "/api/session", NonOwner),
    (Get, "/api/sessions", NonOwner),
    (Get, "/api/windows", NonOwner),
    (Post, "/api/attachments", NonOwner),
    (Get, "/api/contacts", NonOwner),
    (Post, "/api/contacts/import", NonOwner),
    (Get, "/api/health", NonOwner),
    (Get, "/api/terminal/ws", NonOwner),
    (Get, "/api/doc/ws", NonOwner),
    (Get, "/api/scene/ws", NonOwner),
    (Get, "/api/terminal/next-name", NonOwner),
    (Get, "/api/terminal/shells", NonOwner),
    (Get, "/api/terminals/roster", NonOwner),
    (Post, "/api/terminals", NonOwner),
    (Delete, "/api/terminals/{session}", NonOwner),
    (Post, "/api/terminals/{session}/restart", NonOwner),
    (Post, "/api/terminals/{session}/broadcast", NonOwner),
    (Get, "/ws", NonOwner),
    #[cfg(feature = "embeddings")]
    (Get, "/api/index/semantic/state", NonOwner),
    #[cfg(feature = "embeddings")]
    (Get, "/api/index/semantic/models", NonOwner),
    (Get, "/api/index/reports/state", NonOwner),
    (Get, "/api/screensaver/state", NonOwner),
    (Post, "/api/screensaver/verify", NonOwner),
    // The extension capability proxy answers every verb. Its
    // `require_local_mutation` layer refuses a non-owner's POST, PUT and
    // DELETE and passes the rest.
    (Get, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Post, "/_chan/extensions/{id}/{capability}/", Owner),
    (Put, "/_chan/extensions/{id}/{capability}/", Owner),
    (Patch, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Delete, "/_chan/extensions/{id}/{capability}/", Owner),
    (Options, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Trace, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Connect, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Get, "/_chan/extensions/{id}/{capability}/{*path}", NonOwner),
    (Post, "/_chan/extensions/{id}/{capability}/{*path}", Owner),
    (Put, "/_chan/extensions/{id}/{capability}/{*path}", Owner),
    (
        Patch,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
    (Delete, "/_chan/extensions/{id}/{capability}/{*path}", Owner),
    (
        Options,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
    (
        Trace,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
    (
        Connect,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
    // `serve_static`: the SPA shell and its assets.
    (Any, FALLBACK, Public),
];

/// The standalone terminal tenant: `terminal_router` in `lib.rs`. No gate on
/// it consults the caller's role, so a non-owner reaches every route it
/// mounts, the PTY spawn and the transfer lane re-rooted at `/` included.
pub(crate) static TERMINAL_TENANT: RouteTable = &[
    (Get, "/api/terminal/ws", NonOwner),
    (Get, "/api/terminal/next-name", NonOwner),
    (Get, "/api/terminal/shells", NonOwner),
    (Get, "/api/terminals/roster", NonOwner),
    (Post, "/api/terminals", NonOwner),
    (Delete, "/api/terminals/{session}", NonOwner),
    (Post, "/api/terminals/{session}/restart", NonOwner),
    (Post, "/api/terminals/{session}/broadcast", NonOwner),
    (Post, "/api/fs/upload", NonOwner),
    (Get, "/api/fs/{*path}", NonOwner),
    (Get, "/api/fs/context", NonOwner),
    (Get, "/api/fs", NonOwner),
    (Post, "/api/fs", NonOwner),
    (Put, "/api/fs/{*path}", NonOwner),
    (Delete, "/api/fs/{*path}", NonOwner),
    (Post, "/api/move", NonOwner),
    (Post, "/api/fs/transfer", NonOwner),
    (Post, "/api/attachments", NonOwner),
    (Post, "/api/drafts/new", NonOwner),
    (Post, "/api/diagrams/new", NonOwner),
    (Post, "/api/drafts/inspect", NonOwner),
    (Post, "/api/drafts/discard", NonOwner),
    (Post, "/api/drafts/promote", NonOwner),
    (Get, "/api/build-info", NonOwner),
    (Get, "/api/health", NonOwner),
    (Get, "/api/config", NonOwner),
    (Patch, "/api/config", NonOwner),
    (Get, "/api/session", NonOwner),
    (Put, "/api/session", NonOwner),
    (Delete, "/api/session", NonOwner),
    (Get, "/api/sessions", NonOwner),
    (Get, "/api/windows", NonOwner),
    (Post, "/api/window/reply", NonOwner),
    (Post, "/api/survey/reply", NonOwner),
    (Post, "/api/session/handover/reply", NonOwner),
    (Get, "/ws", NonOwner),
    // `serve_static`: the SPA shell and its assets.
    (Any, FALLBACK, Public),
];

/// The launcher root: `routes::library::launcher_router`. Its mutation lanes
/// carry `require_local_mutation`, which refuses a non-owner's POST, PUT and
/// DELETE, and the reverse-tunnel legs carry `require_tunnel_owner`.
pub(crate) static LAUNCHER: RouteTable = &[
    (Get, "/api/library/windows", NonOwner),
    (Post, "/api/library/windows", Owner),
    (Get, "/api/library/windows/watch", NonOwner),
    (Delete, "/api/library/windows/{window_id}", Owner),
    (Post, "/api/library/windows/{window_id}/open", Owner),
    (Post, "/api/library/windows/{window_id}/hide", Owner),
    (Post, "/api/library/windows/{window_id}/close", Owner),
    (Put, "/api/library/windows/{window_id}/label", Owner),
    (Post, "/api/library/windows/{window_id}/visibility", Owner),
    (Post, "/api/library/devservers/{id}/connect", Owner),
    (Post, "/api/library/devservers/{id}/disconnect", Owner),
    (Put, "/api/library/devservers/{id}/native-trust", Owner),
    (Delete, "/api/library/devservers/{id}/native-trust", Owner),
    (Post, "/api/library/devservers/{id}/terminal", Owner),
    (Post, "/api/library/devservers/{id}/workspaces/open", Owner),
    (Post, "/api/library/devservers/{id}/workspaces/on", Owner),
    (Post, "/api/library/devservers/{id}/workspaces/off", Owner),
    (
        Post,
        "/api/library/devservers/{id}/workspaces/forget",
        Owner,
    ),
    (Post, "/api/library/gateways/{id}/connect", Owner),
    (Post, "/api/library/gateways/{id}/disconnect", Owner),
    (Post, "/api/library/fs/pick-folder", Owner),
    // The reverse-tunnel legs are GETs, so the owner gate is theirs alone.
    (Get, "/api/library/tunnel/control", Owner),
    (Get, "/api/library/tunnel/conn", Owner),
    (Get, "/api/library/workspaces", NonOwner),
    (Post, "/api/library/workspaces", Owner),
    (Post, "/api/library/workspaces/{id}/on", Owner),
    (Post, "/api/library/workspaces/{id}/off", Owner),
    (Delete, "/api/library/workspaces/{id}", Owner),
    (Get, "/api/library/local-color", NonOwner),
    (Put, "/api/library/local-color", Owner),
    (Get, "/api/library/local-color/watch", NonOwner),
    (Get, "/api/library/local-theme", NonOwner),
    (Put, "/api/library/local-theme", Owner),
    (Get, "/api/library/local-theme/watch", NonOwner),
    (Get, "/api/library/collapsed-machines", NonOwner),
    (Put, "/api/library/collapsed-machines", Owner),
    // Command capabilities carry their own role: a non-owner's mint yields a
    // read-only capability, and every use is authorized by the capability.
    (Post, "/api/library/command-capabilities", NonOwner),
    (
        Get,
        "/api/library/command-capabilities/{capability}",
        NonOwner,
    ),
    (
        Post,
        "/api/library/command-capabilities/{capability}/actions",
        NonOwner,
    ),
    (
        Get,
        "/api/library/command-capabilities/{capability}/windows/{window_id}/launch",
        NonOwner,
    ),
    (Get, "/api/library/gateways", NonOwner),
    (Post, "/api/library/gateways", Owner),
    (Put, "/api/library/gateways/{id}", Owner),
    (Delete, "/api/library/gateways/{id}", Owner),
    (Get, "/api/library/devservers", NonOwner),
    (Post, "/api/library/devservers", Owner),
    (Put, "/api/library/devservers/{id}", Owner),
    (Delete, "/api/library/devservers/{id}", Owner),
    // `serve_launcher`: the launcher SPA shell, downgraded to its read-only
    // surface for a non-owner.
    (Any, FALLBACK, Public),
];

/// The devserver root: `build_devserver_app` in `devserver.rs`.
pub(crate) static DEVSERVER: RouteTable = &[
    (Get, "/api/devserver/info", Public),
    (Get, "/api/health", Public),
    (Get, "/api/devserver/workspaces", Local),
    (Post, "/api/devserver/workspaces", Local),
    (Delete, "/api/devserver/workspaces/{*prefix}", Local),
    (Post, "/api/devserver/workspaces/{*prefix}", Local),
    (Post, "/api/devserver/rotate-token", Local),
    (Post, "/api/devserver/terminal-sessions/drain", Local),
    // `host_dispatch`: routes a request to the mounted tenant that owns its
    // prefix, or to the launcher root, each of which has its own table.
    (Any, FALLBACK, Public),
];

#[cfg(test)]
pub(crate) mod test_support {
    //! Walk an assembled axum `Router` and hold it to a [`RouteTable`].

    use std::collections::BTreeSet;

    use super::{RouteTable, Verb, FALLBACK};

    /// The concrete verbs a route reaches when it answers every method (an
    /// `any()` handler, a method fallback, or a mounted service). HEAD is
    /// folded into GET, as for a plain GET route.
    const EVERY_VERB: [Verb; 8] = [
        Verb::Get,
        Verb::Post,
        Verb::Put,
        Verb::Patch,
        Verb::Delete,
        Verb::Options,
        Verb::Trace,
        Verb::Connect,
    ];

    const FORMAT: &str = "axum's Router Debug output no longer has the shape this walker reads; \
                          the enumeration must be rewritten against the new axum version, not skipped";

    /// Every `(verb, path)` the router mounts, plus `(Any, FALLBACK)` when it
    /// carries a fallback of its own.
    ///
    /// axum 0.8 exposes no public route listing, so this reads the router's
    /// `Debug` output: the path router's `RouteId -> endpoint` map, whose
    /// method endpoints print each verb as set or `None`, and its
    /// `RouteId -> path` map. The format is not a stability promise, so any
    /// deviation panics rather than yielding a partial set.
    pub(crate) fn mounted_routes<S>(router: &axum::Router<S>) -> BTreeSet<(Verb, String)> {
        let text = format!("{router:?}");
        let body = text
            .strip_prefix("Router { path_router: PathRouter { routes: {")
            .unwrap_or_else(|| panic!("{FORMAT}: {text:.200}"));
        let (routes, rest) = body
            .split_once("}, node: Node { paths: {")
            .unwrap_or_else(|| panic!("{FORMAT}: no node paths"));

        let mut verbs_by_id = std::collections::BTreeMap::new();
        for entry in routes.split("RouteId(").skip(1) {
            let (id, endpoint) = entry
                .split_once("): ")
                .unwrap_or_else(|| panic!("{FORMAT}: route entry {entry:.80}"));
            let id: u32 = id.parse().unwrap_or_else(|_| panic!("{FORMAT}: id {id}"));
            verbs_by_id.insert(id, endpoint_verbs(endpoint));
        }
        if !routes.trim().is_empty() && verbs_by_id.is_empty() {
            panic!("{FORMAT}: routes present but none parsed");
        }

        let (paths_by_id, rest) = parse_paths(rest);
        let fallback = match rest.rsplit_once(", default_fallback: ") {
            Some((_, tail)) if tail.starts_with("false") => true,
            Some((_, tail)) if tail.starts_with("true") => false,
            _ => panic!("{FORMAT}: no default_fallback flag"),
        };

        let ids: BTreeSet<_> = verbs_by_id.keys().copied().collect();
        let path_ids: BTreeSet<_> = paths_by_id.keys().copied().collect();
        assert_eq!(ids, path_ids, "{FORMAT}: route ids and path ids differ");

        let mut mounted = BTreeSet::new();
        for (id, verbs) in verbs_by_id {
            for verb in verbs {
                mounted.insert((verb, paths_by_id[&id].clone()));
            }
        }
        if fallback {
            mounted.insert((Verb::Any, FALLBACK.to_string()));
        }
        mounted
    }

    fn endpoint_verbs(endpoint: &str) -> Vec<Verb> {
        if endpoint.starts_with("Route(") {
            return EVERY_VERB.to_vec();
        }
        let fields = endpoint
            .strip_prefix("MethodRouter(MethodRouter { ")
            .unwrap_or_else(|| panic!("{FORMAT}: endpoint {endpoint:.80}"));
        let field = |name: &str| -> &str {
            let (_, tail) = fields
                .split_once(&format!("{name}: "))
                .unwrap_or_else(|| panic!("{FORMAT}: no `{name}` in {fields:.120}"));
            tail.split([',', ' ']).next().unwrap_or_default()
        };
        if !field("fallback").starts_with("Default(") {
            return EVERY_VERB.to_vec();
        }
        let named = [
            ("get", Verb::Get),
            ("head", Verb::Head),
            ("delete", Verb::Delete),
            ("options", Verb::Options),
            ("patch", Verb::Patch),
            ("post", Verb::Post),
            ("put", Verb::Put),
            ("trace", Verb::Trace),
            ("connect", Verb::Connect),
        ];
        let verbs: Vec<Verb> = named
            .into_iter()
            .filter(|(name, _)| match field(name) {
                "None" => false,
                "Route" | "BoxedHandler" => true,
                other => panic!("{FORMAT}: `{name}: {other}`"),
            })
            .map(|(_, verb)| verb)
            .collect();
        assert!(!verbs.is_empty(), "{FORMAT}: a method router with no verb");
        verbs
    }

    /// Parse `RouteId(N): "path", ...}` up to the map's closing brace,
    /// honoring string escapes, and return the text after it.
    fn parse_paths(text: &str) -> (std::collections::BTreeMap<u32, String>, &str) {
        let mut paths = std::collections::BTreeMap::new();
        let mut rest = text;
        loop {
            if let Some(tail) = rest.strip_prefix('}') {
                return (paths, tail);
            }
            let tail = rest.strip_prefix(", ").unwrap_or(rest);
            let tail = tail
                .strip_prefix("RouteId(")
                .unwrap_or_else(|| panic!("{FORMAT}: path entry {tail:.80}"));
            let (id, tail) = tail
                .split_once("): \"")
                .unwrap_or_else(|| panic!("{FORMAT}: path id {tail:.80}"));
            let id: u32 = id.parse().unwrap_or_else(|_| panic!("{FORMAT}: id {id}"));
            let mut path = String::new();
            let mut chars = tail.char_indices();
            let end = loop {
                match chars.next() {
                    Some((i, '"')) => break i,
                    Some((_, '\\')) => match chars.next() {
                        Some((_, escaped)) => path.push(escaped),
                        None => panic!("{FORMAT}: dangling escape"),
                    },
                    Some((_, c)) => path.push(c),
                    None => panic!("{FORMAT}: unterminated path"),
                }
            };
            paths.insert(id, path);
            rest = &tail[end + 1..];
        }
    }

    /// Fail unless `table` has exactly one row for every route `router`
    /// mounts and no row for a route it does not.
    pub(crate) fn assert_table_matches<S>(name: &str, router: &axum::Router<S>, table: RouteTable) {
        let mounted = mounted_routes(router);
        let mut declared = BTreeSet::new();
        let mut duplicated = Vec::new();
        for &(verb, path, _) in table {
            if !declared.insert((verb, path.to_string())) {
                duplicated.push(format!("{verb:?} {path}"));
            }
        }
        let unclassified: Vec<String> = mounted
            .difference(&declared)
            .map(|(verb, path)| format!("{verb:?} {path}"))
            .collect();
        let stale: Vec<String> = declared
            .difference(&mounted)
            .map(|(verb, path)| format!("{verb:?} {path}"))
            .collect();
        assert!(
            unclassified.is_empty() && stale.is_empty() && duplicated.is_empty(),
            "the {name} route table does not match the router it describes\n\
             mounted but unclassified (add a row declaring what a non-owner may do): {unclassified:#?}\n\
             declared but not mounted (drop the row): {stale:#?}\n\
             declared twice: {duplicated:#?}"
        );
    }

    /// The tail every gateway-role refusal in chan-server shares.
    const ROLE_REFUSAL: &str = "for this gateway role";

    /// The head every bearer refusal in chan-server shares: the tenant's
    /// `auth_middleware`, the launcher and surface bearers, and the devserver
    /// management bearer.
    const BEARER_REFUSAL: &str = "missing or invalid";

    /// Send every row of `table` through `router` as a non-owner tunnel caller
    /// and fail on each row whose outcome contradicts its authority. An
    /// `Owner` row must answer 403 with a gateway-role refusal, a `NonOwner` or
    /// `Public` row must get past every bearer and role gate to a routed
    /// handler, and a `Local` row must answer 401 for want of the devserver
    /// bearer.
    ///
    /// The tenant states the tests pass carry a bearer, so a tunnel caller the
    /// bearer lane stopped admitting would answer a bearer refusal here rather
    /// than slip past a tokenless no-op.
    ///
    /// Captures are filled with a placeholder and every body is malformed
    /// JSON, so a request that reaches a handler stops at the handler's own
    /// validation or at a missing workspace rather than acting. What is under
    /// test is only whether a role gate answered first.
    pub(crate) async fn assert_non_owner_meets_table(
        name: &str,
        router: axum::Router,
        table: RouteTable,
    ) {
        use axum::http::StatusCode;
        use tower::ServiceExt;

        let mut contradictions = Vec::new();
        for &(verb, path, authority) in table {
            if verb == Verb::Any {
                continue;
            }
            let request = axum::http::Request::builder()
                .method(method(verb))
                .uri(fill_captures(path))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .extension(crate::TunnelOrigin { caller: None })
                .body(axum::body::Body::from("{"))
                .expect("probe request");
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                router.clone().oneshot(request),
            )
            .await
            .unwrap_or_else(|_| panic!("{verb:?} {path} did not answer"))
            .expect("infallible router");
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            let refused = status == StatusCode::FORBIDDEN && body.ends_with(ROLE_REFUSAL);
            let bearer_refused =
                status == StatusCode::UNAUTHORIZED && body.starts_with(BEARER_REFUSAL);
            let holds = match authority {
                super::Authority::Owner => refused,
                super::Authority::NonOwner | super::Authority::Public => {
                    !refused && !bearer_refused && status != StatusCode::METHOD_NOT_ALLOWED
                }
                super::Authority::Local => status == StatusCode::UNAUTHORIZED,
            };
            if !holds {
                contradictions.push(format!(
                    "{verb:?} {path} is declared {authority:?}; a non-owner got {status} {body:.120}"
                ));
            }
        }
        assert!(
            contradictions.is_empty(),
            "the {name} router does not enforce its route table: {contradictions:#?}"
        );
    }

    fn method(verb: Verb) -> axum::http::Method {
        use axum::http::Method;
        match verb {
            Verb::Get => Method::GET,
            Verb::Head => Method::HEAD,
            Verb::Post => Method::POST,
            Verb::Put => Method::PUT,
            Verb::Patch => Method::PATCH,
            Verb::Delete => Method::DELETE,
            Verb::Options => Method::OPTIONS,
            Verb::Trace => Method::TRACE,
            Verb::Connect => Method::CONNECT,
            Verb::Any => unreachable!("a fallback row is not a request"),
        }
    }

    /// Replace every `{capture}` and `{*capture}` segment with a placeholder.
    fn fill_captures(path: &str) -> String {
        let mut filled = String::new();
        let mut in_capture = false;
        for c in path.chars() {
            match c {
                '{' => {
                    in_capture = true;
                    filled.push_str("probe");
                }
                '}' => in_capture = false,
                c if !in_capture => filled.push(c),
                _ => {}
            }
        }
        filled
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::convert::Infallible;
    use std::sync::{Arc, OnceLock};

    use axum::body::Body;
    use axum::http::{Request, Response};
    use axum::routing::{any, get, put};
    use axum::Router;

    use super::test_support::{assert_non_owner_meets_table, assert_table_matches, mounted_routes};
    use super::{Verb, FALLBACK, LAUNCHER, TERMINAL_TENANT, WORKSPACE_TENANT};

    /// The ratchet is only as good as the walk, so pin the walk against a
    /// router whose routes are known: two verbs on one path, a wildcard, an
    /// `any()` handler, a mounted service, a route layer, a nested router,
    /// and the fallback, and the absence of a fallback where none is set.
    #[test]
    fn the_walker_reads_every_verb_path_and_fallback_a_router_mounts() {
        async fn ok() {}
        let service = tower::service_fn(|_: Request<Body>| async {
            Ok::<_, Infallible>(Response::new(Body::empty()))
        });
        let nested: Router = Router::new().route("/inner", get(ok));
        let router: Router = Router::new()
            .route("/a", get(ok).post(ok))
            .route("/b/{*rest}", put(ok))
            .route("/c/{id}", any(ok))
            .route_service("/d", service)
            .route_layer(axum::middleware::from_fn(
                |req, next: axum::middleware::Next| next.run(req),
            ))
            .nest("/n", nested)
            .fallback(ok);

        let every_verb = [
            Verb::Get,
            Verb::Post,
            Verb::Put,
            Verb::Patch,
            Verb::Delete,
            Verb::Options,
            Verb::Trace,
            Verb::Connect,
        ];
        let mut expected: BTreeSet<(Verb, String)> = [
            (Verb::Get, "/a"),
            (Verb::Post, "/a"),
            (Verb::Put, "/b/{*rest}"),
            (Verb::Get, "/n/inner"),
            (Verb::Any, FALLBACK),
        ]
        .into_iter()
        .map(|(verb, path)| (verb, path.to_string()))
        .collect();
        for verb in every_verb {
            expected.insert((verb, "/c/{id}".to_string()));
            expected.insert((verb, "/d".to_string()));
        }
        assert_eq!(mounted_routes(&router), expected);

        let without_fallback: Router = Router::new().route("/only", get(ok));
        assert_eq!(
            mounted_routes(&without_fallback),
            BTreeSet::from([(Verb::Get, "/only".to_string())])
        );
        assert!(mounted_routes(&Router::<()>::new()).is_empty());
    }

    fn launcher_host() -> Arc<chan_library::WorkspaceHost> {
        let dir = tempfile::tempdir().expect("tempdir");
        let library =
            chan_workspace::Library::open_at(dir.path().join("config.toml")).expect("library");
        // The host keeps the config path; the directory must outlive the test.
        std::mem::forget(dir);
        Arc::new(chan_library::WorkspaceHost::new(
            library,
            crate::route_builder(),
        ))
    }

    /// Every surface the launcher bundle is installed on: bearer-gated or not,
    /// with or without a bound serve address. They mount one route set.
    fn launcher_surfaces() -> Vec<(&'static str, Router)> {
        let bearer = || {
            Some(Arc::new(std::sync::RwLock::new(
                "launcher-bearer".to_string(),
            )))
        };
        let bound = || {
            let cell = OnceLock::new();
            let _ = cell.set("127.0.0.1:8080".parse().expect("addr"));
            Some(Arc::new(cell))
        };
        vec![
            (
                "bearer, bound",
                crate::routes::launcher_router(launcher_host(), bearer(), bound()),
            ),
            (
                "bearer, unbound",
                crate::routes::launcher_router(launcher_host(), bearer(), None),
            ),
            (
                "public, bound",
                crate::routes::launcher_router(launcher_host(), None, bound()),
            ),
            (
                "public, unbound",
                crate::routes::launcher_router(launcher_host(), None, None),
            ),
        ]
    }

    #[test]
    fn every_workspace_tenant_route_declares_its_authority() {
        let router = crate::router(crate::state::test_support::make_test_state(false));
        assert_table_matches("workspace tenant", &router, WORKSPACE_TENANT);
    }

    #[test]
    fn every_terminal_tenant_route_declares_its_authority() {
        let router = crate::terminal_router(crate::state::test_support::make_test_state(false));
        assert_table_matches("terminal tenant", &router, TERMINAL_TENANT);
    }

    #[test]
    fn every_launcher_route_declares_its_authority() {
        for (surface, router) in launcher_surfaces() {
            assert_table_matches(&format!("launcher ({surface})"), &router, LAUNCHER);
        }
    }

    #[tokio::test]
    async fn a_non_owner_meets_the_declared_authority_on_every_workspace_tenant_route() {
        let state = crate::state::test_support::make_test_state_with_token("workspace-bearer");
        assert_non_owner_meets_table("workspace tenant", crate::router(state), WORKSPACE_TENANT)
            .await;
    }

    #[tokio::test]
    async fn a_non_owner_meets_the_declared_authority_on_every_terminal_tenant_route() {
        let state = crate::state::test_support::make_test_state_with_token("terminal-bearer");
        assert_non_owner_meets_table(
            "terminal tenant",
            crate::terminal_router(state),
            TERMINAL_TENANT,
        )
        .await;
    }

    #[tokio::test]
    async fn a_non_owner_meets_the_declared_authority_on_every_launcher_route() {
        for (surface, router) in launcher_surfaces() {
            assert_non_owner_meets_table(&format!("launcher ({surface})"), router, LAUNCHER).await;
        }
    }
}
