# The extension proxy forwards to an exited extension's port with the extension's token

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the code map written for the extension catalog's liveness field (`dev/v0101-team/int24-docs/codemaps/runtime-next.md` in the development tree, section B), which read the code at `4809d8d4d` and marked the risk as inferred, not shown reachable; read again in code at `b1ef073ae`, where the mechanism holds, and not reproduced. The catalog's `running` flag, which landed the same day with [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md), is what the proxy would read.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, with no shape of the fix named.

## What was seen

An extension's catalog entry holds its loopback upstream, on 127.0.0.1 or `localhost` pinned to 127.0.0.1 at the port its handshake declared, and the token its handshake gave (`crates/chan-server/src/extensions.rs:85-96`, the checks and the pin at `:584-625`). The proxy finds the entry by its id and capability and sends the request to that upstream with the token added as the `t` query parameter and the tenant's scope in a header (`proxy_extension_request`, `crates/chan-server/src/routes/extensions.rs:101-162`; `upstream_url`, `extensions.rs:134-159`); a WebSocket upgrade takes the same upstream (`routes/extensions.rs:125-133`, `proxy_extension_websocket` at `:187`).

An extension whose process exits stays in the catalog. Its supervisor logs the exit, clears the entry's `running` flag and cleans up its process group, and nothing restarts it (`supervise_extension`, `extensions.rs:685-711`). The proxy never reads the flag (`routes/extensions.rs:110`), and the extension tab loads the proxy's entry path into its frame on every open (`web/packages/workspace-app/src/components/ExtensionTab.svelte:50`). So after an extension exits, each request to its path is still sent to its old port with its token. While nothing listens there the connection fails and the proxy answers its 502 `extension_unavailable` (`routes/extensions.rs:151-161`). If another local process has taken the port by then, that process receives the request, its body, the tenant's scope and the exited extension's token, and its answer is passed back as the extension's. That a port is taken this way was not shown, and nothing was run.

## Desired contract

The proxy sends nothing, and hands no token, to an extension whose process its supervisor saw exit or stopped: such a request is refused with the proxy's 502 `extension_unavailable` without a connection to the port.

## What to do

Read the entry's `running` flag in `proxy_extension_request` before the upstream URL is built, for a plain request and a WebSocket upgrade alike, and answer the existing 502 when it is false. Pin it with an entry whose flag is false and a listener on its port that must receive nothing. The flag is cleared only once the supervisor sees the exit, so a port taken in the moment between the exit and that observation is not covered; say so where the proxy reads it.

## Boundaries

`crates/chan-server/src/routes/extensions.rs` (the proxy's two arms) and `crates/chan-server/src/extensions.rs` (a reader of the flag), with their tests. The catalog's wire and the extension tab are unchanged.

## Acceptance

1. With an entry's flag false, a request and a WebSocket upgrade to its path answer 502 `extension_unavailable`, and a listener on its port receives nothing.
2. A running extension is proxied as it is now.
