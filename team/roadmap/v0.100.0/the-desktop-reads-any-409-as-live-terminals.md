# The desktop reads every 409 from turn-on as live terminals

Status: raised for v0.100.0 from the independent review of the v0.99.0 turn-on change, carried over from that release's follow-ups. A source reading of code that is the same at v0.98.0 and v0.99.0.

## What was seen

The desktop's turn-on and turn-off calls in `desktop/src-tauri/src/devserver.rs` treat any `409 Conflict` as the live-terminals refusal: they parse the body as `ActiveTerminalsRejection`, fall back to `unwrap_or(0)` when it does not parse, and return `SetWorkspaceOnError::ActiveTerminals`. Four call sites share the shape.

Turn-on has a different 409. `handle_workspace_on` answers a workspace that another Chan process holds with a plain-text 409, "workspace is open in another Chan process". That body is not JSON, so the desktop returns `ActiveTerminals` with a count of 0, the error that stands for "stopping this would kill live terminals", for a workspace that cannot be turned on at all. What the launcher then shows the user was not traced.

v0.99.0 nearly added a second such 409 for a degraded root; the owner's "200 everywhere" ruling removed it before it landed, which is how this was found.

## Desired contract

The desktop distinguishes the refusals a route can answer. A live-terminals 409 is recognized by its `error: "live_terminals"` discriminator; any other 409 surfaces its own message. Turn-on never raises the live-terminals confirm, because turn-on never blocks on terminals.

## Boundaries

`desktop/src-tauri/src/devserver.rs` (the four call sites and `SetWorkspaceOnError`) and whatever in the launcher renders that error. Making the server's locked refusal JSON as well is a possible companion change in `crates/chan-server/src/routes/library.rs`, and it moves a wire contract, so it is a decision rather than a cleanup.

## Acceptance

1. A test gives the desktop's turn-on a plain-text 409 and asserts the user sees the server's message and no terminal-count confirm.
2. A test keeps the live-terminals path: a JSON 409 with the discriminator and a count still asks for confirmation with that count.
3. A 409 whose body is neither never reports a count of 0 as if it had been measured.
