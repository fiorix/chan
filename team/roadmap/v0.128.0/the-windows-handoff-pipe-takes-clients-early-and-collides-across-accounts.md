# The Windows handoff pipe takes clients before it is served and collides across like-named accounts

Status: raised on 2026-11-10 by the review of v0.127.0's single-instance guard before its GA, from reading; nothing here was run on Windows. Accepted for v0.128.0 by the owner the same day. Not started.

## What is there now

On Windows the desktop's single-instance claim is the first instance of the handoff named pipe (`claim_endpoint_at`, `crates/chan-server/src/handoff.rs`, `first_pipe_instance(true)`), taken at the start of a launch and served by the handoff listener only once the embedded server is up. Two readings of that code, neither yet run:

- A client can open a pipe instance as soon as it exists, so during the first desktop's boot every handoff client (`chan serve` through the shim, a bare launch's offer to open a terminal, the connect-only liveness probe) connects to a pipe nobody reads yet, where before v0.127.0 it met no pipe and answered "no desktop" at once. It then waits its whole reply budget (3 s for most requests, up to 75 s for a remote serve), and a request whose client gave up may be served when the listener starts, after the CLI already fell back to serving on its own.
- The pipe's name is `\\.\pipe\chan-desktop-<USERNAME>` with every character outside `[A-Za-z0-9_-]` removed, so `first.last` and `firstlast` share a name, as do a local and a domain account of the same name. The second account's claim is refused with access denied, which reads as held by a desktop (`ClaimError::Held`); its request to come forward cannot open the other account's pipe, so after 5 s the launch exits 1, and that account cannot start the desktop while the other runs. Before v0.127.0 that account lost only its handoff listener. A local user can hold the name on purpose with the same effect.
- The listener's accept loop ends when it cannot create the next pipe instance (`handoff re-arm`, `start_claimed_listener`), and the instance it then drops is the last one, which is the claim: the desktop keeps running with the endpoint free, and a second launch boots beside it. v0.127.0 keeps the claim when the listener fails to start; this is the same loss while it runs.

## Desired contract

1. A handoff client that reaches a desktop still booting gets an answer, or a prompt "not ready", instead of waiting out its budget, and no request is served after its client gave up.
2. One account's desktop never stops another account's desktop from starting: the endpoint's name is unique per account (the account's SID, not a filtered user name), or a holder whose pipe this account may not open is treated as no holder, with the desktop running without a handoff listener and saying so in its log.
3. One desktop per account still holds: two launches by one account end in one desktop, and a listener that stops serving does not free the endpoint while its desktop runs.

## Boundaries

- The Windows arms of the claim, the listener and the client in `crates/chan-server/src/handoff.rs`, and their callers in `desktop/src-tauri/src/single_instance.rs`. The unix arms are unchanged.
- A name change is a wire change between a desktop and a CLI of different releases on one machine; the item says what a v0.127.0 CLI meets beside a v0.128.0 desktop, and the reverse.

## Acceptance

1. First, a reading on the Windows VM that settles both claims: a handoff client started while the desktop boots (the time to its answer, and whether its request is served late), and a second account whose name collides after filtering.
2. Tests compiled and run on Windows for whichever contract the reading finds broken, red at the v0.127.0 code.
3. On the Windows VM: `chan serve` during a desktop's boot answers within a second or is served by the desktop, never both; two accounts each run their own desktop.
