# chan-server design

The serving layer: turns a workspace (or a terminal) into a web app, hosts the MCP sandbox, and builds the devserver. Per tenant it builds `Router::new().merge(api).fallback(serve_static)`.

## What it provides

- **Per-tenant API**: files, search, graph, drafts, and the terminal PTY WebSocket: thin HTTP/WS over a `chan-workspace` handle.
- **`serve_static`**: serves the embedded workspace SPA per tenant with SPA fallback + `inject_chan_meta` (the `chan-prefix` / `chan-settings-disabled` / `chan-files` / `chan-drafts` / `chan-webgl-renderer` meta).
- **Launcher root**: embeds the launcher SPA and assembles the launcher bundle (the `/` SPA plus the `/api/library/{workspaces,windows}` data routes). `install_launcher_root_fallback` installs that bundle on the `chan-library` `WorkspaceHost` root fallback, so the library/devserver root serves the launcher instead of 404ing. The install is **per-surface**: the desktop loopback installs it bearer-`Some` (a minted loopback token) with full workspace mutation; the devserver installs it bearer-`Some` too (its rotatable devserver token), and tunnel-origin requests bypass the local bearer because they already passed the gateway edge. A grant is all-or-nothing on the devserver: a signed grantee assertion gets the same launcher as the owner's, the full surface meta and every `/api/library/*` mutation included, and the reverse-tunnel legs are the one launcher route it does not share. A tunnel request with a missing or unverifiable assertion is refused with 401 before it reaches the launcher.
- **MCP host**: hosts `chan-llm` in-process over a Unix socket (+ `chan __mcp-proxy`).
- **Graph adapter**: assembles the visualization graph while delegating authored link and mention/contact normalization to `chan-workspace`.
- **Workspace search adapter**: `POST /api/search/workspace` accepts the shared typed request and returns the core result unchanged. The legacy `/api/search/content` route is a projection over the same effective-mode policy. Control-socket `workspace_search` uses the same contract for `cs`.
- **Workspace readiness envelope**: `/api/index/status`, `/api/indexing/state`, `/api/preflight`, and `/api/search/content` each carry a `WorkspaceReadiness` ready/recovering envelope. A content query issued during recovery returns an explicit not-ready/recovering result rather than a fresh-looking empty one.
- **Live editor authority**: document and Excalidraw WebSockets share one server-side authority per path. Clean external edits fold into that authority; overlapping dirty edits retain a three-way conflict until an explicit reload or overwrite via `POST /api/session-conflicts/resolve`. Each authority writes a bounded recovery record under `.chan/editor-sessions/v1/` through the workspace atomic stream writer. On restart, dirty/conflicted authority, durable baseline, versions, and the current disk side rehydrate before any flush can run, so stale authority cannot silently replace a newer disk file.
- **Devserver builder**: `build_devserver_app` composes the `WorkspaceHost` + per-tenant apps into one merged router for `run_devserver`; `chan devserver` and the desktop loopback run the same app.
- **Local extension runtime**: one process-owned `ExtensionRuntime` scans `CHAN_HOME/extensions`, starts valid subprocess declarations, supervises their process groups, and injects one immutable ready catalog into every workspace tenant. `GET /api/extensions` exposes only capability-scoped tenant paths; `/_chan/extensions/<id>/<capability>/*` reverse-proxies HTTP to the process-private loopback URL with the extension token added upstream. The same path works through standalone, desktop, devserver, and gateway-tunnel serving modes without exposing a second port.
- **Reverse-tunnel legs**: two GET WebSocket routes on the launcher router (`/api/library/tunnel/{control,conn}`, bearer-gated with `?t=` accepted, and owner-only over the gateway: `require_tunnel_owner` 403s every other tunnel caller, a grantee included, because a reverse tunnel dials out through an addressed app window whose host can be the owner's own desktop, outside the devserver a grant covers). The control socket carries the long-lived `cs tunnel` conversation: validate the spec server-side, mint an unguessable tunnel id, register in the host's `chan_revtunnel::TunnelRegistry`, trigger the addressed window over `/ws` (`window_command: tunnel_open`), race the 10s ready report against client EOF, then hold until either side ends. A refused devserver-side dial closes one data socket without ending the tunnel. See [`crates/chan-revtunnel/design.md`](../chan-revtunnel/design.md).

```mermaid
flowchart TB
  subgraph chan-server["chan-server (one tenant)"]
    API["/api/* + /ws: files, search, graph, terminal PTY"]
    Static["serve_static: embedded workspace SPA + fallback"]
    Launcher["serve_launcher: web-launcher SPA + /api/library/*"]
    MCPsvc["MCP host (chan-llm over UDS)"]
  end
  Extensions["ExtensionRuntime: process-wide discovery + supervision"] --> Child["local extension subprocess"]
  Extensions --> API
  API --> WS["chan-workspace"]
  Launcher --> Host["chan-library WorkspaceHost (root_fallback)"]
  MCPsvc --> WS
  Static --> Bundle["workspace SPA bundle"]
  Launcher --> LBundle["launcher SPA bundle"]
  Client["browser / webview"] -->|HTTP/WS| API
  Client -->|"sandboxed loopback iframe"| Child
  Client -->|GET /| Static
  Client -->|"GET / (library root)"| Launcher
```

## Boundaries

- chan-server depends on `chan-library`, so the launcher assets + handlers live here (the higher layer) and are injected into chan-library's root fallback; chan-library never references a frontend bundle.
- Launcher builds are wired into the root web build so clean CI/release builds embed a real launcher, not an empty bundle.
- Search ranking, selector resolution, traversal, normalization, limits, and structured partial errors stay in `chan-workspace`; HTTP and control-socket handlers only deserialize, choose the active tenant, and serialize.
- `Identify` reports `workspace_root` and `metadata_key` for a workspace tenant and omits both for terminal-only processes. Multi-workspace CLI routing must match both fields (plus pid) and never fall back to another same-pid tenant.
- Extension discovery and child ownership stay above per-tenant `build_app`: standalone serve, devserver, and desktop each create exactly one runtime and pass only its immutable catalog into tenant route builders. Extension endpoints are independent loopback trust domains, never workspace filesystem authorities.
- **Route authority table**: `src/route_authority.rs` is a test-only ratchet, compiled only under `cfg(test)`; nothing in the built server reads it. It holds one table per route table chan-server assembles (`router_with_extensions`, `terminal_router`, `launcher_router`, `build_devserver_app`) with one row per mounted `(verb, path)`, recording what each kind of caller meets on that route in the code as it stands: `Public` (answered before any caller authority), `NonOwner` (every caller reaches the handler), `Grantee` (the owner, a grantee and a local caller reach it; an anonymous caller is refused with 403), `Owner` (a grantee and an anonymous caller are refused with 403), or `Local` (only the devserver's local bearer, so no tunnel caller). The caller model: a local caller carries no `TunnelOrigin`; the owner is a tunnel caller whose verified subject is the devserver's owner; a grantee is a tunnel caller with any other real subject, and because a grant is all-or-nothing (`gateway/migrations/0014_drop_devserver_grant_roles.sql`) it meets what the owner meets everywhere except the reverse-tunnel legs; an anonymous caller is a tunnel caller with the nil subject, which the gateway signs only on its extension capability lane and path-gates to `/_chan/extensions/...`, so in production it reaches the extension routes alone and may not POST, PUT or DELETE there (`TunnelOrigin::anonymous`, `refuse_anonymous_mutation`). One test walks each assembled router and fails on a mounted route with no row or a row with no route, so a new route cannot land unclassified; a second sends every row through its router as a local caller, the owner, a grantee and an anonymous caller (signed with the nil subject, and with no verified caller at all), and fails where the router's answer contradicts the row.
