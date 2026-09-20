# One turn-on route still answers 204 where the others answer 200

Status: accepted for v0.100.0 by the owner. Found by the independent review of the v0.99.0 turn-on change; the owner ruled "200 everywhere" during that release and then, asked about this remaining route, answered yes.

## What was seen

v0.99.0 made turning a workspace on answer with the truth. Local `POST /api/library/workspaces/{id}/on` answers 200 with the workspace's row on every success, healthy or degraded; local add already answered 200 with the row; the devserver's own `POST /api/devserver/workspaces{prefix}/on` already answered 200 with its entry.

One surface was outside that change. `POST /api/library/devservers/{id}/workspaces/on`, the launcher's route for a workspace on a connected devserver (`handle_devserver_workspace_on` in `crates/chan-server/src/routes/library.rs`), still documents and answers "204/409", and two tests pin the 204: `open_and_hide_with_a_desktop_are_204` and `devserver_workspace_off_force_confirm_round_trip`. The route goes through the desktop bridge to the devserver, whose own answer already carries the entry; the launcher route drops it.

Nothing is known to break today; the cost is a second request and a success that says nothing about the workspace's state.

## Desired contract

The connected-devserver turn-on answers 200 with the entry the devserver returned, so every turn-on verb in the product has one success shape and a caller never has to refetch to learn whether the workspace it turned on is healthy. Refusals keep their current status codes and bodies.

## Boundaries

`crates/chan-server/src/routes/library.rs` (the route, the shared `set_devserver_workspace_on` dispatcher and the two tests that pin the 204), `crates/chan-library/src/desktop_window_ops.rs` (`SetWorkspaceOnOutcome`, whose `Done` variant has to carry the entry across the bridge), `desktop/src-tauri/src/devserver.rs` (the turn-on call, which must hand the entry back instead of `Ok(())`), `desktop/src-tauri/src/main.rs` (`set_devserver_workspace_on_impl`, including its local-devserver arm that turns a transport failure into `Done` and therefore has no entry to return), and the launcher's caller in `web/packages/launcher/src/api/library.ts`. The off and forget routes share the dispatcher and the outcome enum, so keeping their 204 is part of the work even though their contract does not change. The route's row in `crates/chan-server/src/route_authority.rs` records caller authority, not the status code, and does not move.

Sequence this item before [the-desktop-reads-any-409-as-live-terminals](the-desktop-reads-any-409-as-live-terminals.md): both need a richer bridge outcome, and doing this one first gives that one a variant to extend instead of a second pass over the same enum.

## Acceptance

1. A test drives the route against a connected devserver double and asserts 200 with the entry, for a healthy workspace and for one the devserver reports `unavailable`.
2. The refusals that exist today are pinned unchanged.
3. The launcher shows a degraded connected-devserver workspace after turn-on without a second request being required for correctness.
4. The route's doc comment says 200 with the entry, and so do the two design documents that enumerate these routes: the launcher-routes bullet in `crates/chan-server/design.md` and the route inventory in `web/packages/launcher/design.md`.
