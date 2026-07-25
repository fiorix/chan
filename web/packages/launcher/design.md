# web-launcher: the launcher SPA and its three-surface serving

How the launcher is built and reached. The [`README`](README.md) covers the stack and the dev loop; this file is the design of record for *where* the launcher is served and *how* its `/api/library/*` surface is authorized. Ground every change here against the launcher client wire, the server library API, the static bundle embed, and the `WorkspaceHost` root-fallback hook. Those four boundaries are the contract; individual source-file ownership belongs in code review, not in this design doc.

## Diagram

```mermaid
flowchart TB
    subgraph spa["web-launcher SPA (one bundle, ~29 KB)"]
        LIB["launcher API client -- pure /api/library/* HTTP<br/>workspaces · windows · devservers (deferred)<br/>bearer via ?t= (Authorization header; ?t= query for the watch WS)"]
        UI["TopBar · WorkspaceList · WindowFeed · NewWorkspaceDialog<br/>reads &lt;meta chan-launcher-surface&gt; → gates capabilities"]
    end

    subgraph cs["chan-server"]
        SL["static asset layer<br/>embedded launcher bundle<br/>serve_launcher(uri, read_only)"]
        LR["library router<br/>windows: list/mint/watch/discard (both surfaces)<br/>workspaces: list (both) · add/on/off/rm (loopback only → 403 on read-only)"]
        IRF["install_launcher_root_fallback(host, bearer, serve_addr)"]
    end

    subgraph lib["chan-library (lower layer -- no frontend bundle)"]
        HOST["WorkspaceHost · host_dispatch<br/>root_fallback: OnceLock&lt;Router&gt; -- served when no tenant prefix matches /"]
        REG["Library registry · WorkspaceOverlay (on/off) · WindowRegistry"]
    end

    UI --> LIB
    LIB -->|"/api/library/*"| LR
    IRF -->|installs the bundle into| HOST
    LR -.->|serve_launcher static fallback| SL
    LR -->|host pub API| REG
    HOST -->|"/ + /api/library/* (no tenant match)"| LR

    subgraph surfaces["3 serving surfaces -- same bundle, per-surface install"]
        direction LR
        DEV["devserver (build_devserver_app)<br/>bearer=None tunnel-trust · serve_addr=None read-only"]
        GW["gateway-proxied = the devserver reached via<br/>devserver-proxy at {owner}.devserver.chan.app/<br/>(proxy strips browser credentials and gates at edge)"]
        LOOP["desktop loopback<br/>bearer=Some(per-launch token) · serve_addr=Some(addr) full mutation"]
    end
    DEV --- GW
    IRF --- DEV
    IRF --- LOOP
```

## What the launcher is

The launcher is a pure `/api/library/*` HTTP client: it never opens native windows, never dials a devserver, and never parses an opaque window or workspace id. Every type mirrors a struct the library serializes -- the field names *are* the wire, pinned by server byte-tests. It is served at the devserver/library root `/`, and the bundle uses a relative asset base so assets resolve under any mount. It renders three registries: workspaces, windows, and devservers (deferred -- see below).

## The `/api/library/*` surface

- **workspaces** -- `GET` list (`{workspace_id, path, label, on}`, where `workspace_id` is the route prefix without its leading slash: a single legible segment the client treats as opaque), `POST {path}` add, `POST /{id}/{on|off}` toggle, `DELETE /{id}` remove.
- **windows** -- `GET` list, `POST {kind, workspace_path?}` mint, `GET …/windows/watch` (a WebSocket that pushes the full window set on every change), `DELETE /{id}` discard.
- **devservers** -- CRUD, deferred. The registry is desktop-side config; a devserver-served launcher correctly shows an empty list.

The SPA reads its bearer from `?t=` in its own URL and presents it as `Authorization: Bearer` on fetch and as `?t=` on the watch WebSocket (a browser WebSocket cannot set headers).

## Three-surface serving via the `WorkspaceHost` root fallback

`host_dispatch` matches only workspace-tenant prefixes, so the root `/` returned 404. `WorkspaceHost` carries an install-once `root_fallback: OnceLock<Router>` that `host_dispatch` serves when no tenant prefix matches a request. chan-library defines the slot; chan-server fills it with the launcher bundle (`serve_launcher` plus the `/api/library/*` routes) through `install_launcher_root_fallback`. The direction matters: chan-server depends on chan-library, so the launcher bundle -- a frontend artifact -- lives in chan-server and is injected down into the host, never the reverse. The same bundle is installed on each surface:

1. **devserver** (`build_devserver_app`) -- served over the tunnel to the gateway proxy and on the box's `127.0.0.1` bind;
2. **desktop loopback** through the embedded `WorkspaceHost`;
3. **gateway-proxied** -- the devserver reached through `devserver-proxy` at `{owner}.devserver.chan.app/`.

## Per-surface auth and the read-only / mutation split

```mermaid
flowchart TB
    INST["install_launcher_root_fallback<br/>sets the policy per surface"]
    RTR["launcher_router(host, bearer, serve_addr)<br/>auth-agnostic handlers"]
    INST --> RTR

    subgraph authx["bearer -- who may call /api/library/*"]
        BTOK["Some(token): require Authorization: Bearer<br/>watch WS also accepts ?t= (constant-time)"]
        BNONE["None: tunnel-trust, data surface public<br/>(proxy gates at the edge)"]
        SHELL["static SPA shell ALWAYS public<br/>(loads before it holds the token)"]
    end

    subgraph mutx["serve_addr -- read-only vs full mutation"]
        AFULL["Some(cell): full workspace mutation<br/>addr read from the cell at request time"]
        ARO["None: read-only<br/>mutation handlers answer 403<br/>&lt;meta chan-launcher-surface=readonly&gt; hides controls"]
    end

    RTR --> BTOK
    RTR --> BNONE
    RTR -.->|exempt| SHELL
    RTR --> AFULL
    RTR --> ARO

    subgraph surfx["serving surfaces (same bundle)"]
        LOOP["desktop loopback<br/>bearer=Some · serve_addr=Some"]
        DEV["devserver / gateway (build_devserver_app)<br/>bearer=None · serve_addr=None"]
    end

    BTOK --> LOOP
    AFULL --> LOOP
    BNONE --> DEV
    ARO --> DEV
```

*The two policy knobs the installer sets per surface: `bearer` (who may call `/api/library/*`) and `serve_addr` (read-only vs full mutation).*

`launcher_router(host, bearer, serve_addr)` is auth-agnostic in its handlers; the installer sets the policy per surface:

- **`bearer`** gates `/api/library/*`. `Some(token)` requires `Authorization: Bearer` (the watch WebSocket also accepts `?t=`), constant-time compared; `None` is tunnel-trust. The static SPA shell is always public so it loads before it holds the token.
- **`serve_addr`** (`Option<Arc<OnceLock<SocketAddr>>>`) is both the read-only/full discriminator and the mount enabler. `Some(cell)` is the loopback: workspace mutation is served, and the mount path reads the listen address from the cell, which the embedder fills *after* it binds, so it is read at request time rather than install time. `None` is the tunnel-trust surface: workspaces are read-only -- the mutation handlers answer `403`, and the shell is served with `<meta name="chan-launcher-surface" content="readonly">` so the SPA hides those controls (the New-workspace button, the row checkboxes and bulk bar, and the on/off toggle, which becomes a static state badge) and shows a "manage from the desktop app or the CLI" hint instead of buttons that fail.

Mutation is loopback-only because on the gateway surface the proxy strips
browser `Cookie` and `Authorization` credentials and is the sole gate, so
`bearer=None` cannot distinguish a grantee from the owner. Query parameters are
ordinary tenant application data; proxy entry credentials are accepted only at
the fixed body-only exchange endpoint. A collaborator holding a
`__Host-devserver_gate` cookie must not unmount or remove the owner's workspaces.
Window mint/discard stay on both surfaces (per-view state, low-risk). Owners
manage a headless devserver's workspaces over the bearer-gated
`/api/devserver/*` management API and `cs`/CLI.

Off is a plain unmount: the launcher's `setWorkspaceOn` sends no `force`, so the devserver's confirm-before-off (a `409` carrying the live-terminal count) stays a `/api/devserver/*` and UI concern rather than a wire status on this surface.

## Build integration

The launcher bundle is embedded beside the main workspace bundle and follows the same rebuild contract: fresh checkouts and isolated gate worktrees compile before the frontend artifact exists, while a rebuilt launcher forces the embedding server crate to relink. The top-level web targets build the launcher before any CLI, desktop, packaging, or release consumer embeds the server bundle, so every distribution path ships the same launcher without per-consumer wiring.

## Deferred

- **Devservers CRUD bridge** (`/api/library/devservers*`). The devserver registry is desktop-side config, so the mutating surface pairs with the desktop bridge; a devserver-served launcher shows an empty devservers list until then.
- **Proxy-injected signed role header.** The path to owner-only mutation over the gateway (and to gating the devserver's `127.0.0.1` bind) is a signed caller/role header the proxy injects after its gate, which the devserver validates -- a new gateway↔devserver shared secret, not yet built.
