# Chan extensions

How Chan uses extensions, and how to build one. The field-level contract for the declaration file lives in the [configuration reference](config-reference.md); this document is the design and the authoring guide. Source of the mechanism: `crates/chan-server/src/extensions.rs` (discovery, spawn, handshake, supervision) and `crates/chan-server/src/routes/extensions.rs` (catalog and reverse proxy).

An extension is a local program the operator declares in `<chan-home>/extensions/<id>.toml` (`~/.chan/extensions/` by default). Chan spawns it when serving starts, the program serves an ordinary loopback HTTP app, and Chan reverse-proxies that app into a sandboxed iframe tab with a launcher entry under Apps. Chan itself stays one binary with no plugin ABI: an extension is a separate process behind a narrow web contract, so it can be written in any language, crash without taking Chan down, and never inherits Chan's API authority. Declaring one is an explicit local-code-execution grant; treat every file in that directory accordingly.

## The model

Four pieces carry the whole design:

- **A declaration.** One `.toml` per extension; the lowercase file stem is the stable ID. `name` titles the tab and launcher row, `command` and `args` say what to spawn (bare names resolve through `PATH`, `./name` resolves from the config directory, installers write absolute paths), and `capabilities` lists the host grants the extension wants. Malformed or oversized declarations, spawn failures, and failed handshakes warn and are skipped without failing Chan startup.
- **A handshake.** The child inherits Chan's environment, starts in the config directory, gets null stdin and inherited stderr, and must print one newline-terminated line on stdout within five seconds and 32 bounded lines: `CHAN_EXTENSION_V1={"url":"http://127.0.0.1:<port>/","token":"<unguessable>", ...}`. The URL must be plain HTTP on `127.0.0.1` or `localhost` (pinned to `127.0.0.1` after validation, so a mutable hosts file cannot re-target the proxy), with a usable port, no userinfo, and no pre-existing `t` query parameter. Optional fields: `singleton` and up to 32 static `commands`.
- **A capability-path proxy.** Each ready extension gets a random 256-bit path under `/_chan/extensions/<id>/<capability>/...` inside the workspace tenant. The browser only ever sees that path: the loopback address and token stay process-private, and the proxy adds the token on the private upstream leg only. Because everything rides Chan's existing port, one route serves every deployment shape unchanged: standalone server, chan-desktop, a devserver, an SSH port forward, and the gateway tunnel.
- **A sandboxed tab.** The iframe runs with `allow-forms allow-scripts` and without `allow-same-origin`, so extension scripts execute at an opaque origin: they cannot touch Chan's DOM, storage, or APIs even though their network requests share Chan's port. The only host channel is `postMessage`, and Chan accepts bridge messages only from that tab's exact `contentWindow`.

The proxy is also the trust boundary in the other direction: it strips browser credential headers and upstream cookies, applies no-store and no-referrer response policy, stamps every upstream request with `X-Chan-Extension-Scope`, and keeps non-owner gateway-tunnel participants read-only. The full header, redirect, and timeout hygiene is in the [configuration reference](config-reference.md).

One word of warning about vocabulary: "capability" means three unrelated things in Chan. An extension's manifest `capabilities` are host grants (`session-context`, `presentation`); the proxy path capability is the unguessable URL segment above; and window capabilities (`windowCaps`) are an unrelated mechanism deciding which surfaces a window family may mount. This document only uses the first two.

## Lifecycle

Chan discovers and starts extensions once per serving process, not once per workspace tenant. Successful children live until Chan shuts down, when each child's process group receives TERM and then KILL after a grace period. A child that exits is not respawned; fix it and restart the serving Chan process. Extension stderr is inherited, so an extension's own logs land in Chan's stderr stream, which is what you watch while developing one.

## The host bridge

All host communication is `postMessage` between the iframe and its parent. Messages from the host arrive on `window.parent`; messages to the host are posted to `window.parent`. The types:

| Message                          | Direction | Meaning                            |
|----------------------------------|-----------|------------------------------------|
| `chan:extension-host-keymap:v1`  | host->ext | The shell chords Chan currently    |
|                                  |           | claims, as physical-key            |
|                                  |           | descriptors with modifier booleans |
| `chan:extension-keydown:v1`      | ext->host | A matched chord relayed back;      |
|                                  |           | honored only if it was advertised  |
| `chan:extension-ready:v1`        | ext->host | The iframe is ready; unblocks      |
|                                  |           | queued singleton command delivery  |
| `chan:extension-command:v1`      | host->ext | A declared command was invoked     |
| `chan:extension-command-result:v1` | ext->host | The command's outcome            |
| `chan:extension-session-context:v1` | host->ext | Participant snapshots           |
|                                  |           | (`session-context` grant only)     |
| `chan:extension-view-state:v1`   | host->ext | The tab's visibility state         |
| `chan:extension-presentation:v1` | ext->host | Enter, exit, or toggle request     |
|                                  |           | (`presentation` grant only)        |

Keyboard events inside an iframe never bubble to the parent document, which is why the keymap relay exists: Chan advertises the chords its shell owns, the extension matches only those, calls `preventDefault()`, and posts the keydown back. An extension that skips the relay works fine but swallows shell shortcuts while focused.

The two grants are deliberately narrow. `session-context` streams reactive participant snapshots with opaque IDs, display names, Chan roles, statuses, and the receiving window ID; the labels are informational, not authenticated identities. `presentation` lets the extension request promotion of its iframe wrapper into the browser top layer without reparenting, so the browsing context (and any WebGL or WASM state) survives entering and leaving full-surface mode; Chan supplies Restore and Close controls and leaves Escape to the extension. No grant exposes workspace files, native APIs, or a general host message bus.

## Creating an extension

The in-tree fixture is the smallest complete example: `crates/chan-server/examples/echo-extension.rs`. The walkthrough below is the same shape in any language.

1. **Serve a loopback app.** Bind `127.0.0.1` on an ephemeral port, mint an unguessable token, and serve your UI and API from one HTTP server. Reject requests whose `t` query parameter does not match the token: the proxy appends it on every upstream request, and checking it means a stray local process cannot drive your extension.
2. **Print the handshake.** Emit `CHAN_EXTENSION_V1={json}` on stdout, newline-terminated, before anything else you might print there, and within five seconds of spawn. Everything after the handshake can go to stderr.
3. **Declare it.** Write `<chan-home>/extensions/<id>.toml` with `name`, `command`, and any `args` and `capabilities`, then restart the serving Chan process. Your launcher entry appears under Apps; opening it loads the iframe tab through the capability path.
4. **Write the frontend against relative URLs.** The app is served under the capability path, so an origin-rooted `/asset.js` targets Chan's tenant root, not your extension; every asset and API URL must be relative. Implement the keymap relay if you want shell shortcuts to keep working while your extension has focus, and post `chan:extension-ready:v1` when your UI can accept commands.
5. **Drive Chan through `cs`.** An extension backend that wants to act on Chan (open terminals, write to them, run surveys) shells out to the `cs` control client rather than speaking any private API; Chan's own command semantics and typed exit codes are the contract. This is the pattern both published extensions use, and it keeps the extension honest about what the operator could do themselves.
6. **Prove the contract in your own tests.** Assert that your handshake line parses under Chan's validation rules (marker prefix, URL shape, token bounds, command ID grammar), so a contract drift fails your suite instead of your users' startup.

To exercise the in-tree fixture end to end: `cargo build -p chan-server --example echo-extension`, point a declaration's `command` at the built binary's absolute path, and restart Chan. Chan releases ship no extension binaries or declarations; the example compiles only when a developer builds it explicitly.

## Packaging and distribution

Chan has no marketplace or installer, so distribution is the extension repo's job. The published extensions converged on one convention, and new extensions should follow it:

- The repo is named `chan-ext-<name>` and carries its extension ID as the file stem it installs.
- `packaging/chan-extension/<id>.toml` is the declaration template. Its `command` is a placeholder: Chan spawns extensions with the config directory as the working directory, so the installed declaration wants the real absolute path, and only the installer knows it.
- An `install.sh` detects OS and architecture, verifies the release archive against `SHA256SUMS` before extracting, installs under `~/.local/lib/<name>`, writes `<chan-home>/extensions/<id>.toml` with the path it just installed (honoring `CHAN_HOME`), and leaves the Chan restart to the operator.
- The repo carries its own gate (fmt, lints, tests) and the contract tests from the walkthrough above.

## Reference extensions

- [chan-ext-doom](https://github.com/fiorix/chan-ext-doom): DOOM, embeddable; a merged-lineage engine fork with browser and native targets and a Rust server role. The only extension exercising both grants, and the worked example for `presentation`: full-surface play with engine state surviving enter and restore.
- [chan-ext-mobile-chat](https://github.com/fiorix/chan-ext-mobile-chat): a chat surface for driving agents from a phone through the desktop's Chan. A single Rust binary serving hand-written assets, `session-context` for the roster, and every action on Chan delegated to `cs`.

## Boundaries

There is no marketplace, installer, remote fetch, lazy start, or `cs` opener for extensions. Extensions are per-machine operator declarations: Chan starts what the directory declares, contains it behind the proxy and the sandbox, and nothing else. A crashed extension stays down until the operator restarts Chan, and an extension's authority over Chan is exactly the authority of a local process run by the same user, which is why the declaration itself is the security decision.
