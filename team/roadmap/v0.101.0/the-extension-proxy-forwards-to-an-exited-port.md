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

## What shipped

Landed on 2026-09-28; lines at `b39274a1a`, in `crates/chan-server/src/` where no other path is named. The builder's report is `dev/v0101-team/reports/report-Services-31.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Services-30.md`; the lead read the production diff whole and verified it at the blob, with no independent review (`dev/v0101-team/journals/journal-Lead.md`, the entry of 2026-09-28 12:03Z, "the three small fixes in and ready").

- **One reader of the flag.** `ExtensionEntry::running` reads the flag the supervisor clears when it sees the process exit or stops it at shutdown, and the catalog's `running` field reads it through the same function (`extensions.rs:100-117`; `supervise_extension`, `:698-724`).
- **The proxy sends nothing to an extension that is not running.** After the catalog's lookup and a preflight's answer, and before the upstream URL is built, a request whose entry is not running is answered the 502 `extension_unavailable` that a failed forward answers, with no connection made; a WebSocket upgrade takes the same path, since its branch comes after the check (`proxy_extension_request`, `routes/extensions.rs:111-147`; the failed forward's answer, `:165-174`). A running extension is proxied as before.
- The design document says so (`design.md:29`, the "Local extension runtime" entry), and the changelog records it (`CHANGELOG.md:33`).

Pinned, both red first at the base in the report: a plain request and a WebSocket upgrade to an entry whose flag is false, each answered 502 with its code, while a listener that stays bound on the entry's port for the whole test must accept nothing, raced against the answer and read once more after it (`an_exited_extension_is_sent_no_request`, `routes/extensions.rs:967`; `an_exited_extension_is_sent_no_websocket_upgrade`, `:997`; the entry made by a test-only builder, `extensions.rs:188-193`). The two pins that proxy a running entry pass with their bodies unchanged (`routes/extensions.rs:837`, `:885`). A mutation of each arm reds its own pin alone, both pins passed 200 runs as they are and 200 on one CPU, and the own gate was green.

**What it does not cover, as ruled and written where the flag is read** (`routes/extensions.rs:126-129`): the supervisor clears the flag only once it sees the exit, so a port another process takes between the exit and that moment is still sent the request, its body, the tenant's scope and the extension's token. A CORS preflight for an exited entry, an `OPTIONS` from the frame's opaque origin, is still answered 204 by the proxy itself before the flag is read, and sends nothing upstream (`cors_preflight`, `:460-490`, called at `:122-124`); the request that follows it is answered the 502.
