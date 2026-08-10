# Extension proxy errors reach a sandboxed iframe CORS-masked

Status: SHIPPED in [v0.86.0](../../release/release-v0.86.0.md). Every response leaving the extension namespace on both binaries carries the response policy, so a sandboxed iframe reads true statuses.

## What

The extension iframe is deliberately opaque-origin (`sandbox="allow-forms allow-scripts"`, `ExtensionTab.svelte:264-271`), so every response it fetches needs CORS headers for the browser to reveal the status. `f2ae73f5` added them to exactly one branch, the capability-miss 404 (`routes/extensions.rs:95-97`). Every other error path in the same handler still answers bare: the dead-subprocess 502 at `:134`, the WS rejection at `:109`, and the paths at `:166`, `:173`, `:177`, `:180`, `:198`, `:202`. The gateway's own `not_found_response`, `entry_not_found_response`, and cancellation paths (`devserver-proxy/src/proxy.rs:1432-1442`, `:963`, `:978`, `:1025`) are bare too.

Each of those produces the exact misleading console shape `f2ae73f5`'s message argues against: "Origin null is not allowed by Access-Control-Allow-Origin" masking the real status. The 2026-08-08 incident burned a debugging cycle on a masked 404 from a pre-fix binary; the masked 502 is the next incident of the same shape, unfixed on any binary.

## Contract

- Every response leaving the extension proxy namespace, success or error, server-side or gateway-side, carries the extension response policy. The fix wraps the namespace rather than patching branches per incident.
- A sandboxed extension iframe observing any proxy failure can read the true status code from the console.

## Acceptance

- A capability miss, a dead subprocess, a WS rejection, and a gateway tenant miss each produce a console line naming the real status against a null-origin requester, proven with a sandboxed-iframe fetch per case.
- Red-proof: strip the policy wrapper once, observe the CORS mask return, restore.

## Rough size

Small. The policy function exists; the work is applying it structurally and testing the four representative paths.
