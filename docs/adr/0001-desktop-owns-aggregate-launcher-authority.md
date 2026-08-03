# ADR 0001: Desktop owns aggregate command-launcher authority

Status: Accepted (amended)

## Context

Chan needs one command launcher from workspace windows, standalone terminals, the launcher window, and remote devserver content. The visual and keyboard UX is identical, but those webviews do not have equal authority. In particular, a remote devserver page must not receive Chan Desktop's root launcher bearer, tenant tokens, or any transport that would let it query or mutate the aggregate Computers inventory on its own.

The command deck renders inline inside the page that invoked it, on every surface. A deck hosted in a separate native window shared across sources moves draft ownership, revision, and synchronization outside the invoking page; that ownership split is the defect class this ADR excludes, so no native launcher window exists.

## Decision

Chan uses one shared command-deck component with two authority hosts.

On Chan Desktop, a stateless broker inside the desktop process holds the aggregate Computers authority. Any desktop window's inline deck calls two narrowly permissioned Tauri commands: a catalog snapshot and a named action. The desktop builds the snapshot from its embedded chan-server, the same aggregate the Computers window renders, and trims it to display fields: machine, window, workspace, and gateway rows with their health and state. Actions name an operation and an opaque target id; the desktop revalidates the target against live registry state at execution time and runs the same desktop-bridge implementations the `/api/library/*` routes use. Pages never receive the launcher bearer, tenant tokens, or launch paths. The broker keeps no per-window state: each page owns its deck draft in session storage, so no revision cursors, sessions, or cross-window draft ownership exist process-side.

Outside Chan Desktop, the deck stays inline with the shipped capability model. A tenant bearer may mint a five-minute sliding capability only when the requested window is live in that same tenant. The capability exposes a token-redacted snapshot and approved actions only for the host's own library. It inherits the verified tunnel role, is revoked when the invoking window disconnects, and cannot enumerate an aggregate remote feed. Reload remints authority; only the serializable draft survives.

The launcher has contextual and Computers entry modes, not separate launcher products. Search may jump across menu levels, but confirmations and authority checks remain mandatory. On desktop the launcher chords dispatch to the inline deck of the focused window.

## Consequences

- Remote devserver pages render the full Computers scope (machine names, window titles, workspace paths, health) and act on it only through desktop-revalidated named actions. Inventory visibility crosses the boundary; credentials and unmediated mutation do not.
- Every desktop window class gets the identical Computers scope regardless of the origin that served its page. A remote window running an older SPA bundle never calls the broker and keeps its own-library capability scope.
- Browser windows can control only their invoking library; readonly tunnel viewers may inspect and focus but may not mutate.
- Drafts are keyed by invoking window and entry mode in the page's session storage. Hide, focus loss, and reload preserve them; successful execution, true window close, and app exit clear them.
- The command launcher no longer requires a transparent window or `macOSPrivateApi`.
