# One turn-on route still answers 204 where the others answer 200

Status: accepted for v0.100.0 by the owner. Found by the independent review of the v0.99.0 turn-on change; the owner ruled "200 everywhere" during that release and then, asked about this remaining route, answered yes.

## What was seen

v0.99.0 made turning a workspace on answer with the truth. Local `POST /api/library/workspaces/{id}/on` answers 200 with the workspace's row on every success, healthy or degraded; local add already answered 200 with the row; the devserver's own `POST /api/devserver/workspaces{prefix}/on` already answered 200 with its entry.

One surface was outside that change. `POST /api/library/devservers/{id}/workspaces/on`, the launcher's route for a workspace on a connected devserver (`handle_devserver_workspace_on` in `crates/chan-server/src/routes/library.rs`), still documents and answers "204/409", and a test pins the 204. The route goes through the desktop bridge to the devserver, whose own answer already carries the entry; the launcher route drops it.

Nothing is known to break today; the cost is a second request and a success that says nothing about the workspace's state.

## Desired contract

The connected-devserver turn-on answers 200 with the entry the devserver returned, so every turn-on verb in the product has one success shape and a caller never has to refetch to learn whether the workspace it turned on is healthy. Refusals keep their current status codes and bodies.

## Boundaries

`crates/chan-server/src/routes/library.rs` (the route, `set_devserver_workspace_on` and its pinned test), the desktop bridge's turn-on call in `desktop/src-tauri/src/devserver.rs` (it must hand the entry back instead of `Ok(())`), and the launcher's caller in `web/packages/launcher/src/api/library.ts`. The off route is not part of this item.

## Acceptance

1. A test drives the route against a connected devserver double and asserts 200 with the entry, for a healthy workspace and for one the devserver reports `unavailable`.
2. The refusals that exist today are pinned unchanged.
3. The launcher shows a degraded connected-devserver workspace after turn-on without a second request being required for correctness.
4. The route's doc comment and the design documents that enumerate the launcher routes say 200 with the entry.
