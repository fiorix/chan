//! The declared caller authority of every route chan-server mounts.
//!
//! A devserver serves the same app on its loopback bind and, through the
//! gateway tunnel, to callers the gateway authenticated. `auth_middleware`
//! admits every tunnel request past the tenant bearer because the gateway is
//! the trust boundary, and the gateway in turn leaves the decision between
//! the kinds of tunnel caller to the devserver. [`Authority`] names those
//! kinds and what each meets.
//!
//! What a caller may do with a route cannot be read off the HTTP verb: some
//! reads are POSTs (workspace search, the team-config read, draft
//! inspection) and some GETs confer shell or write access (the terminal and
//! document WebSocket upgrades).
//!
//! So each route's authority is written down, one row per `(verb, path)` a
//! router mounts, in the table for that router. The tables describe the
//! routers; nothing at runtime consults them. A test walks each assembled
//! router and fails on a mounted route with no row and on a row with no route,
//! so a route cannot be added without somebody classifying it. A second test
//! sends every row through its router as each kind of caller and fails where
//! the router's gates disagree with the row.

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

/// What each kind of caller meets on a route. There are three kinds:
///
/// - A **local** caller carries no `TunnelOrigin`: it came in on the loopback
///   bind, holding whatever bearer the router asks for.
/// - The **owner** is a tunnel caller whose verified subject is the
///   devserver's owner.
/// - A **grantee** is a tunnel caller with any other verified subject. The
///   gateway admits only the owner and a grantee to a devserver session, and a
///   grant is all-or-nothing: one binary, shell-equivalent authority over the
///   devserver (`gateway/migrations/0014_drop_devserver_grant_roles.sql`). A
///   grantee meets what the owner meets everywhere except the reverse-tunnel
///   legs, which dial out through an addressed app window whose host can be
///   the owner's own desktop, outside the devserver a grant covers.
///
/// There is no anonymous tunnel caller. The gateway forwards nothing without a
/// signed-in principal, extension frames included (it binds their links to the
/// user who opened them), and the devserver's tunnel layer refuses an
/// assertion whose subject names no user with 401 before any of these routers
/// runs (`mark_tunnel_origin` in `devserver.rs`).
///
/// A row records what the router does with each caller, not what the gateway
/// forwards.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Authority {
    /// Answered before any caller authority is consulted: static assets, the
    /// devserver's liveness and identity probes, and the fallback that
    /// dispatches into the tenants (whose own tables then apply).
    Public,
    /// Every caller reaches the handler: no gate on the route tells the owner
    /// and a grantee apart.
    NonOwner,
    /// The owner and a local caller reach the handler; a grantee is refused
    /// with 403.
    Owner,
    /// Only a local caller holding the devserver's bearer reaches the
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
    // `--no-settings` serve for every caller alike; it never consults who the
    // caller is.
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
    // The open lane: no route layer consults who the caller is.
    (Get, "/api/workspace", NonOwner),
    (Get, "/api/workspace/bootstrap", NonOwner),
    (Get, "/api/cloud-workspaces", NonOwner),
    (Get, "/api/fs", NonOwner),
    (Post, "/api/fs", NonOwner),
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
    // The extension capability proxy answers every verb, and like the rest of
    // a grant no gate on it tells the owner and a grantee apart.
    (Get, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Post, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Put, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Patch, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Delete, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Options, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Trace, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Connect, "/_chan/extensions/{id}/{capability}/", NonOwner),
    (Get, "/_chan/extensions/{id}/{capability}/{*path}", NonOwner),
    (
        Post,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
    (Put, "/_chan/extensions/{id}/{capability}/{*path}", NonOwner),
    (
        Patch,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
    (
        Delete,
        "/_chan/extensions/{id}/{capability}/{*path}",
        NonOwner,
    ),
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
/// it consults who the caller is, so every caller reaches every route it
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

/// The launcher root: `routes::library::launcher_router`. No gate on it
/// consults the caller except `require_tunnel_owner` on the reverse-tunnel
/// legs, so a grantee reaches every other route the owner does.
pub(crate) static LAUNCHER: RouteTable = &[
    (Get, "/api/library/windows", NonOwner),
    (Post, "/api/library/windows", NonOwner),
    (Get, "/api/library/windows/watch", NonOwner),
    (Delete, "/api/library/windows/{window_id}", NonOwner),
    (Post, "/api/library/windows/{window_id}/open", NonOwner),
    (Post, "/api/library/windows/{window_id}/hide", NonOwner),
    (Post, "/api/library/windows/{window_id}/close", NonOwner),
    (Put, "/api/library/windows/{window_id}/label", NonOwner),
    (
        Post,
        "/api/library/windows/{window_id}/visibility",
        NonOwner,
    ),
    (Post, "/api/library/devservers/{id}/connect", NonOwner),
    (Post, "/api/library/devservers/{id}/disconnect", NonOwner),
    (Put, "/api/library/devservers/{id}/native-trust", NonOwner),
    (
        Delete,
        "/api/library/devservers/{id}/native-trust",
        NonOwner,
    ),
    (Post, "/api/library/devservers/{id}/terminal", NonOwner),
    (
        Post,
        "/api/library/devservers/{id}/workspaces/open",
        NonOwner,
    ),
    (Post, "/api/library/devservers/{id}/workspaces/on", NonOwner),
    (
        Post,
        "/api/library/devservers/{id}/workspaces/off",
        NonOwner,
    ),
    (
        Post,
        "/api/library/devservers/{id}/workspaces/forget",
        NonOwner,
    ),
    (Post, "/api/library/gateways/{id}/connect", NonOwner),
    (Post, "/api/library/gateways/{id}/disconnect", NonOwner),
    (Post, "/api/library/fs/pick-folder", NonOwner),
    // The reverse-tunnel legs dial out through an addressed app window whose
    // host can be the owner's own desktop, outside the devserver a grant
    // covers, so they stay the owner's.
    (Get, "/api/library/tunnel/control", Owner),
    (Get, "/api/library/tunnel/conn", Owner),
    (Get, "/api/library/workspaces", NonOwner),
    (Post, "/api/library/workspaces", NonOwner),
    (Post, "/api/library/workspaces/{id}/on", NonOwner),
    (Post, "/api/library/workspaces/{id}/off", NonOwner),
    (Delete, "/api/library/workspaces/{id}", NonOwner),
    (Get, "/api/library/local-color", NonOwner),
    (Put, "/api/library/local-color", NonOwner),
    (Get, "/api/library/local-color/watch", NonOwner),
    (Get, "/api/library/local-theme", NonOwner),
    (Put, "/api/library/local-theme", NonOwner),
    (Get, "/api/library/local-theme/watch", NonOwner),
    (Get, "/api/library/collapsed-machines", NonOwner),
    (Put, "/api/library/collapsed-machines", NonOwner),
    // Every use of a command capability is authorized by the capability, and
    // a grantee's mint yields the same capability the owner's does.
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
    (Post, "/api/library/gateways", NonOwner),
    (Put, "/api/library/gateways/{id}", NonOwner),
    (Delete, "/api/library/gateways/{id}", NonOwner),
    (Get, "/api/library/devservers", NonOwner),
    (Post, "/api/library/devservers", NonOwner),
    (Put, "/api/library/devservers/{id}", NonOwner),
    (Delete, "/api/library/devservers/{id}", NonOwner),
    // `serve_launcher`: the launcher SPA shell, with the router's own surface
    // for every caller.
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

    use super::{Authority, RouteTable, Verb, FALLBACK};

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
             mounted but unclassified (add a row declaring what each caller may do): {unclassified:#?}\n\
             declared but not mounted (drop the row): {stale:#?}\n\
             declared twice: {duplicated:#?}"
        );
    }

    /// The kinds of caller [`Authority`] is written against, as the probe
    /// and the grant tests drive them.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Caller {
        /// No `TunnelOrigin`: the loopback bind.
        Local,
        /// A verified assertion whose subject is the devserver's owner.
        Owner,
        /// A verified assertion with a subject that is not the owner's.
        Grantee,
    }

    impl Caller {
        pub(crate) const ALL: [Caller; 3] = [Caller::Local, Caller::Owner, Caller::Grantee];

        /// The owner's user id, shared with the devserver tests' signed
        /// assertions.
        pub(crate) const OWNER_ID: &str = "11111111-1111-4111-8111-111111111111";
        /// A grantee's user id: a real subject that is not the owner's.
        pub(crate) const GRANTEE_ID: &str = "22222222-2222-4222-8222-222222222222";

        /// The `TunnelOrigin` a request from this caller carries.
        pub(crate) fn origin(self) -> Option<crate::TunnelOrigin> {
            let verified = |sub: &str| crate::TunnelOrigin {
                caller: chan_tunnel_proto::gateway_assertion::Claims {
                    sub: sub.to_string(),
                    owner_user_id: Self::OWNER_ID.to_string(),
                    aud: "owner--probe.p1.proxy.example".to_string(),
                    drv: "probe".to_string(),
                    client: chan_tunnel_proto::gateway_assertion::ClientType::Desktop,
                    iat: 0,
                    exp: 0,
                },
            };
            match self {
                Caller::Local => None,
                Caller::Owner => Some(verified(Self::OWNER_ID)),
                Caller::Grantee => Some(verified(Self::GRANTEE_ID)),
            }
        }

        /// Stamp this caller on a request. A tunnel caller carries its
        /// `TunnelOrigin` and never a bearer, because the gateway strips
        /// client credentials; a local caller carries `bearer` when the
        /// router asks for one.
        pub(crate) fn stamp(
            self,
            builder: axum::http::request::Builder,
            bearer: Option<&str>,
        ) -> axum::http::request::Builder {
            match (self.origin(), bearer) {
                (Some(origin), _) => builder.extension(origin),
                (None, Some(bearer)) => builder.header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bearer}"),
                ),
                (None, None) => builder,
            }
        }
    }

    /// The tail every caller refusal in chan-server shares.
    const ROLE_REFUSAL: &str = "for this gateway role";

    /// The head every bearer refusal in chan-server shares: the tenant's
    /// `auth_middleware`, the launcher and surface bearers, and the devserver
    /// management bearer.
    const BEARER_REFUSAL: &str = "missing or invalid";

    /// What a probe request must meet.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Outcome {
        /// Past every bearer and caller gate to a routed handler.
        Reach,
        /// A 403 whose body ends in [`ROLE_REFUSAL`].
        Refused,
        /// A 401 whose body starts with [`BEARER_REFUSAL`].
        NoBearer,
    }

    fn expected(authority: Authority, caller: Caller) -> Outcome {
        match authority {
            Authority::Public | Authority::NonOwner => Outcome::Reach,
            Authority::Owner if matches!(caller, Caller::Local | Caller::Owner) => Outcome::Reach,
            Authority::Owner => Outcome::Refused,
            Authority::Local if caller == Caller::Local => Outcome::Reach,
            Authority::Local => Outcome::NoBearer,
        }
    }

    /// Send every row of `table` through `router` once as each [`Caller`] and
    /// fail on each answer that contradicts the row's authority.
    ///
    /// `local_bearer` is what the router asks of a local caller, read per
    /// request because a `Local` row may rotate it. The tenant states the
    /// tests pass carry a bearer too, so a tunnel caller the bearer lane
    /// stopped admitting would answer a bearer refusal here rather than slip
    /// past a tokenless no-op.
    ///
    /// Captures are filled with a placeholder and every body is malformed
    /// JSON, so a request that reaches a handler stops at the handler's own
    /// validation or at a missing workspace rather than acting. What is under
    /// test is only whether a bearer or caller gate answered first.
    pub(crate) async fn assert_callers_meet_table(
        name: &str,
        router: axum::Router,
        table: RouteTable,
        local_bearer: Option<crate::routes::LauncherBearer>,
    ) {
        use axum::http::StatusCode;
        use tower::ServiceExt;

        let mut contradictions = Vec::new();
        for &(verb, path, authority) in table {
            if verb == Verb::Any {
                continue;
            }
            for caller in Caller::ALL {
                let bearer = local_bearer
                    .as_ref()
                    .map(|cell| cell.read().unwrap_or_else(|e| e.into_inner()).clone());
                let request = caller
                    .stamp(
                        axum::http::Request::builder()
                            .method(method(verb))
                            .uri(fill_captures(path))
                            .header(axum::http::header::CONTENT_TYPE, "application/json"),
                        bearer.as_deref(),
                    )
                    .body(axum::body::Body::from("{"))
                    .expect("probe request");
                let response = tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    router.clone().oneshot(request),
                )
                .await
                .unwrap_or_else(|_| panic!("{verb:?} {path} did not answer {caller:?}"))
                .expect("infallible router");
                let status = response.status();
                let body = axum::body::to_bytes(response.into_body(), 1 << 20)
                    .await
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default();
                let refused = status == StatusCode::FORBIDDEN && body.ends_with(ROLE_REFUSAL);
                let no_bearer =
                    status == StatusCode::UNAUTHORIZED && body.starts_with(BEARER_REFUSAL);
                let met = match expected(authority, caller) {
                    Outcome::Reach => {
                        !refused && !no_bearer && status != StatusCode::METHOD_NOT_ALLOWED
                    }
                    Outcome::Refused => refused,
                    Outcome::NoBearer => no_bearer,
                };
                if !met {
                    contradictions.push(format!(
                        "{verb:?} {path} is declared {authority:?}; {caller:?} got {status} {body:.120}"
                    ));
                }
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

    use super::test_support::{assert_callers_meet_table, assert_table_matches, mounted_routes};
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

    const LAUNCHER_BEARER: &str = "launcher-bearer";

    fn bearer_cell(token: &str) -> crate::routes::LauncherBearer {
        Arc::new(std::sync::RwLock::new(token.to_string()))
    }

    /// Every surface the launcher bundle is installed on: bearer-gated or not,
    /// with or without a bound serve address, each with the bearer a local
    /// caller presents to it. They mount one route set.
    fn launcher_surfaces() -> Vec<(&'static str, Router, Option<crate::routes::LauncherBearer>)> {
        let bound = || {
            let cell = OnceLock::new();
            let _ = cell.set("127.0.0.1:8080".parse().expect("addr"));
            Some(Arc::new(cell))
        };
        let bearer = || Some(bearer_cell(LAUNCHER_BEARER));
        vec![
            (
                "bearer, bound",
                crate::routes::launcher_router(launcher_host(), bearer(), bound()),
                bearer(),
            ),
            (
                "bearer, unbound",
                crate::routes::launcher_router(launcher_host(), bearer(), None),
                bearer(),
            ),
            (
                "public, bound",
                crate::routes::launcher_router(launcher_host(), None, bound()),
                None,
            ),
            (
                "public, unbound",
                crate::routes::launcher_router(launcher_host(), None, None),
                None,
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
        for (surface, router, _) in launcher_surfaces() {
            assert_table_matches(&format!("launcher ({surface})"), &router, LAUNCHER);
        }
    }

    #[tokio::test]
    async fn every_caller_meets_the_declared_authority_on_every_workspace_tenant_route() {
        let state = crate::state::test_support::make_test_state_with_token("workspace-bearer");
        assert_callers_meet_table(
            "workspace tenant",
            crate::router(state),
            WORKSPACE_TENANT,
            Some(bearer_cell("workspace-bearer")),
        )
        .await;
    }

    #[tokio::test]
    async fn every_caller_meets_the_declared_authority_on_every_terminal_tenant_route() {
        let state = crate::state::test_support::make_test_state_with_token("terminal-bearer");
        assert_callers_meet_table(
            "terminal tenant",
            crate::terminal_router(state),
            TERMINAL_TENANT,
            Some(bearer_cell("terminal-bearer")),
        )
        .await;
    }

    #[tokio::test]
    async fn every_caller_meets_the_declared_authority_on_every_launcher_route() {
        for (surface, router, bearer) in launcher_surfaces() {
            assert_callers_meet_table(&format!("launcher ({surface})"), router, LAUNCHER, bearer)
                .await;
        }
    }
}
