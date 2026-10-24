# The launcher's Open refuses a path outside the workspace that cs open routes

Status: raised for v0.110.0 on 2026-10-24 by the owner; not started.

## What was seen

The owner read on 2026-10-24: `cs open /path/to/file.md` from a terminal in a workspace window, with the path outside the workspace, opens a standalone window with the file in its editor. The launcher's "Open" with the same path, typed as `open /path/to/file.md`, reports that the file is not in the workspace. The owner's word: "i want the command launcher's 'open {path}' to work just like it does form the 'cs open {path}'".

Read at `840c4f594`.

- `cs open` reaches the server over the control socket. Its handler in `crates/chan-server/src/control_socket.rs` probes the path against the workspace root before anything else, and a path that escapes is treated as a routing fact: `route_open_outside_workspace` hands it to the host (`open_outside_workspace` in `crates/chan-library/src/host.rs`), which reuses a live standalone window or mints one and parks the open for its first attach, and the ack names the window ("open request queued for ... in standalone window ..."). Without a host (a standalone `chan serve`, or a host whose terminal tenant mounted no filesystem) the refusal names `chan serve PATH`.
- The launcher's "Open" (`app.open.path` and `executeOpen` in `web/packages/workspace-app/src/state/commands/global.ts`) posts to `POST /api/open` (`crates/chan-server/src/routes/open.rs`). That route resolves a relative target against the workspace root, passes an absolute one verbatim, and calls `open_path` directly, whose `abs_to_workspace_rel` answers "path escapes workspace root" for a path outside the workspace; the test `escaping_targets_refuse_with_400` pins that answer for `/etc/hosts`. The route never consults the host: the `UnserveScope` that carries the host handle is given to the control socket's context in `crates/chan-server/src/lib.rs` and not to the HTTP `AppState`.
- The route's module comment says the semantics "live in those two control-socket fns and are never reimplemented here, so cs open and the launcher command cannot drift". The routing step sits in the socket handler above those two functions, so the two callers drifted at exactly that step.
- The `cs open` long help in `crates/chan-shell/src/help.rs` still opens with "Workspace windows only, and the path must resolve inside the workspace root" and "The command launcher's Open entry runs the same path", while its CAVEATS say an outside path is routed; the head is stale.

## Desired contract

Typing a path into the launcher's Open does what `cs open` does with it from a terminal in the same window: a path inside the workspace opens in this window, a path outside it opens in the host's standalone window with the same reuse, mint and ack rules, and the status bar names the window the open landed in. Without a host, the refusal is the one `cs open` gives. A relative path still resolves against the workspace root, since the launcher has no working directory.

## What to do

1. Move the escape probe and `route_open_outside_workspace` out of the socket handler into one function both callers share, taking the `UnserveScope`, so the HTTP route and the socket cannot drift at this step again.
2. Give `AppState` the `UnserveScope` (or the host handle it carries) at construction in `crates/chan-server/src/lib.rs`; a standalone tenant keeps `Unsupported`.
3. `api_open` probes the absolutized target first and routes an escape through the shared function; the 200 body carries the ack so `executeOpen` shows "open request queued for ... in standalone window ..." in the status bar, as the socket's caller sees it.
4. Tests, red first: in `routes/open.rs`, the two escaping targets of `escaping_targets_refuse_with_400` route and answer the ack when a host is present, and refuse with the `chan serve` guidance when none is; the control socket's `route_escape` tests keep passing through the shared function. In the SPA, `state/commands/global.open.test.ts` shows the ack for a routed open.
5. The `cs open` help head says what its CAVEATS say.

## Boundaries

`crates/chan-server/src/control_socket.rs` (the shared routing function), `crates/chan-server/src/routes/open.rs`, `crates/chan-server/src/state.rs` and `lib.rs` (the scope on the state), `crates/chan-shell/src/help.rs`, `web/packages/workspace-app/src/state/commands/global.ts` (the ack in the status bar), their tests. Not changed: `open_path`'s semantics, the host's `open_outside_workspace`, and the standalone window's own Open, which resolves client-side.

## Acceptance

1. From a workspace window, Cmd+K, `open /path/outside/file.md` opens the file in the host's standalone window and the status bar names that window; a second open lands in the same window.
2. The same path from `cs open` in a terminal of that window lands in the same window with the same ack.
3. `open notes/plan.md` and `open .` are unchanged.
4. On a standalone `chan serve` the launcher's refusal names `chan serve PATH`.
5. The tests above red first, green after.
