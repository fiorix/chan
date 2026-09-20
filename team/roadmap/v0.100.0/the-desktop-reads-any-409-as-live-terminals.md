# The desktop reads every 409 from turn-on as live terminals

Status: raised for v0.100.0 from the independent review of the v0.99.0 turn-on change, carried over from that release's follow-ups. A source reading of code that is the same at v0.98.0 and v0.99.0.

## What was seen

The desktop's workspace calls in `desktop/src-tauri/src/devserver.rs` treat any `409 Conflict` as the live-terminals refusal: they parse the body as `ActiveTerminalsRejection`, fall back to `unwrap_or(0)` when it does not parse, and return `SetWorkspaceOnError::ActiveTerminals`. Four call sites share the shape: the gateway and direct arms of `set_workspace_on`, and the gateway and direct arms of `forget_workspace`.

Turn-on has a different 409. Over a gateway the desktop reaches the devserver's launcher route, and `handle_workspace_on` answers a workspace that another Chan process holds with a plain-text 409, "workspace is open in another Chan process". That body is not JSON, so the desktop returns `ActiveTerminals` with a count of 0, and the launcher route re-serializes it as `{"error":"live_terminals","active_terminals":0}`. The launcher raises the terminal confirm on the off path only, so turn-on falls through to the generic error banner, which reads `live_terminals` because `ApiError` takes the `error` field as the message. The server's sentence never reaches the user. The direct arm posts to the devserver's own on route, whose only 409 is the JSON one, so this path is the gateway's. The launcher disables the power toggle on a row that already reads locked, so reaching it needs a row whose status has not caught up, which narrows the window without closing it.

v0.99.0 nearly added a second such 409 for a degraded root; the owner's "200 everywhere" ruling removed it before it landed, which is how this was found.

## Desired contract

The desktop distinguishes the refusals a route can answer. A live-terminals 409 is recognized by its `error: "live_terminals"` discriminator; any other 409 surfaces its own message. Turn-on never raises the live-terminals confirm, because turn-on never blocks on terminals.

## Boundaries

`desktop/src-tauri/src/devserver.rs` (the four call sites and `SetWorkspaceOnError`), `desktop/src-tauri/src/main.rs` and `crates/chan-library/src/desktop_window_ops.rs` (the outcome the bridge carries, which has no variant for a refusal that is neither done nor a terminal count), and the launcher's rendering: `web/packages/launcher/src/state/computerActions.ts` (the confirm is on the off path only), `components/Library.svelte` (the `run` and `reportError` wrapper) and `api/library.ts` (`ApiError`, `refusalReason` and `liveTerminalsCount`, which already tells the two 409s apart and is the model to match). The desktop test module already binds a loopback axum router, so a 409 double needs no new harness. Sequence this item after [one-on-route-still-answers-204](one-on-route-still-answers-204.md), which reshapes the same bridge outcome. Making the server's locked refusal JSON as well is a possible companion change in `crates/chan-server/src/routes/library.rs`, and it moves a wire contract, so it is a decision rather than a cleanup.

## Acceptance

1. A test gives the desktop's turn-on a plain-text 409 and asserts the user sees the server's message and no terminal-count confirm.
2. A test keeps the live-terminals path: a JSON 409 with the discriminator and a count still asks for confirmation with that count.
3. A 409 whose body is neither never reports a count of 0 as if it had been measured.
