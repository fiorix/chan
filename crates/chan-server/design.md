# chan-server -- design

The serving layer: turns a workspace (or a terminal) into a web app, hosts the MCP sandbox, and builds the devserver. Per tenant it builds `Router::new().merge(api).fallback(serve_static)`.

## What it provides

- **Per-tenant API**: files, search, graph, drafts, and the terminal PTY WebSocket -- thin HTTP/WS over a `chan-workspace` handle.
- **`serve_static`**: serves the embedded workspace SPA per tenant with SPA fallback + `inject_chan_meta` (the `chan-prefix` / `settings-disabled` meta).
- **Launcher root**: embeds the launcher SPA and assembles the launcher bundle (the `/` SPA plus the `/api/library/{workspaces,windows}` data routes). `install_launcher_root_fallback` installs that bundle on the `chan-library` `WorkspaceHost` root fallback, so the library/devserver root serves the launcher instead of 404ing. The install is **per-surface**: the desktop loopback installs it bearer-`Some` (a minted loopback token) with full workspace mutation; the devserver installs it bearer-`None` because tunnel-origin requests have already passed the gateway edge. Missing or non-owner gateway assertions may read the launcher but cannot mutate `/api/library/*`; a signed owner assertion keeps full mutation.
- **MCP host**: hosts `chan-llm` in-process over a Unix socket (+ `chan __mcp-proxy`).
- **Graph adapter**: assembles the visualization graph while delegating authored link and mention/contact normalization to `chan-workspace`.
- **Workspace search adapter**: `POST /api/search/workspace` accepts the shared typed request and returns the core result unchanged. The legacy `/api/search/content` route is a projection over the same effective-mode policy. Control-socket `workspace_search` uses the same contract for `cs`.
- **Workspace readiness envelope**: `/api/index/status`, `/api/indexing/state`, `/api/preflight`, and `/api/search/content` each carry a `WorkspaceReadiness` ready/recovering envelope. A content query issued during recovery returns an explicit not-ready/recovering result rather than a fresh-looking empty one.
- **Live editor authority**: document and Excalidraw WebSockets share one server-side authority per path. Clean external edits fold into that authority; overlapping dirty edits retain a three-way conflict until an explicit reload or overwrite via `POST /api/session-conflicts/resolve`. Each authority writes a bounded recovery record under `.chan/editor-sessions/v1/` through the workspace atomic stream writer. On restart, dirty/conflicted authority, durable baseline, versions, and the current disk side rehydrate before any flush can run, so stale authority cannot silently replace a newer disk file.
- **Devserver builder**: `build_devserver_app` composes the `WorkspaceHost` + per-tenant apps into one merged router for `run_devserver`; `chan devserver` and the desktop loopback run the same app.

```mermaid
flowchart TB
  subgraph chan-server["chan-server (one tenant)"]
    API["/api/* + /ws -- files, search, graph, terminal PTY"]
    Static["serve_static -- embedded workspace SPA + fallback"]
    Launcher["serve_launcher -- web-launcher SPA + /api/library/*"]
    MCPsvc["MCP host (chan-llm over UDS)"]
  end
  API --> WS["chan-workspace"]
  Launcher --> Host["chan-library WorkspaceHost (root_fallback)"]
  MCPsvc --> WS
  Static --> Bundle["workspace SPA bundle"]
  Launcher --> LBundle["launcher SPA bundle"]
  Client["browser / webview"] -->|HTTP/WS| API
  Client -->|GET /| Static
  Client -->|"GET / (library root)"| Launcher
```

## Boundaries

- chan-server depends on `chan-library`, so the launcher assets + handlers live here (the higher layer) and are injected into chan-library's root fallback -- chan-library never references a frontend bundle.
- Launcher builds are wired into the root web build so clean CI/release builds embed a real launcher, not an empty bundle.
- Search ranking, selector resolution, traversal, normalization, limits, and structured partial errors stay in `chan-workspace`; HTTP and control-socket handlers only deserialize, choose the active tenant, and serialize.
- `Identify` reports `workspace_root` and `metadata_key` for a workspace tenant and omits both for terminal-only processes. Multi-workspace CLI routing must match both fields (plus pid) and never fall back to another same-pid tenant.
