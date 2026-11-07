# A WireGuard file set after start waits for a restart

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the macOS reading of WKWebView's loopback routing is the owner's, from the candidate.

## What is there now

chan-desktop decides its WireGuard set once per process. At start it reads every enabled gateway row's wg-quick file, starts one in-process tunnel per readable file and, only when at least one tunnel started, binds one loopback HTTP CONNECT proxy over them (`desktop/src-tauri/src/wireguard.rs`); the proxy's route table is the list of tunnels it was bound with (`crates/chan-wireguard/src/proxy.rs`). The webviews take the proxy's address once per process, WebView2 as a browser argument shared by every webview, WebKitGTK on its shared web context and WKWebView on its data store, so the address cannot move after the first window. A file added, changed, removed or refused after the start therefore takes effect at the next launch: the Gateways projection says so (`wireguard_restart_required`), the badge shows "Restart chan-desktop to apply the WireGuard change", the form hint says a change takes effect when chan-desktop restarts, and a connect of such a row is refused with that message. Enrollment (the sign-in that writes a wg-quick file from the gateway's parameters) would end in the same notice, so the first tunnel to a newly enrolled gateway would wait for a restart of the desktop.

Only the address is pinned by the webviews, not what the proxy does with a connection. Nothing in the fabric needs the proxy's contents fixed.

## Desired contract

1. The proxy is bound always, at the desktop's start, with zero tunnels, before any HTTP client or webview exists, and its address is the one decision the process makes once. A bind failure degrades to the no-proxy path: the app starts, every gateway row with a WireGuard file reads the reason as its error and refuses to connect, and the rest works as before.
2. The tunnels are a live registry behind the proxy. A gateway row with a readable file is adopted: its tunnel starts and is routed in the running proxy; a row whose file is cleared, or which is removed or disconnected, is retired: its route and tunnel go, and the connections through it end with it. A row whose stored path changes has its old tunnel replaced after the new one is routed. A file the reader refuses disables that row alone, with the reader's message on it, until the next adopt.
3. The Gateways form's add, update and remove paths, the connect and disconnect buttons, and the enrollment redeem call adopt and retire, so an enrolled file and a hand-written file both take effect at once, in the running process, with no restart. The badge reads the tunnel's live status within one refresh.
4. The restart notice, the projection flag and the connect refusal for a changed setting no longer exist. A file edited in place at the same path is re-read by clearing and setting the field.
5. The proxy's route table takes a caller-chosen id per route, holds each route's tunnel with an optional map of host names to tunnel addresses, routes a mapped name through its tunnel without a lookup on the host, and keeps today's path for everything else; it can be changed at any time by the process that bound it.
6. On Linux, where WebKitGTK sends loopback through the proxy too, the proxy's plain-HTTP forwarding and `ws://` bridging are the path of every local window for everyone, with or without a gateway row. On Windows loopback stays off the proxy by Chromium's bypass; on macOS the local windows load whichever way WKWebView routes loopback.

## Boundaries

- The webview proxy address stays decided once per process; no second proxy, no rebind, no change to how the webviews take it.
- The private key handling, the direct path, the hop-by-hop handling and the proxy's statuses are unchanged; no change to the tunnel driver.
- No new dependency; the root `Cargo.lock` does not move.
- Devserver WireGuard (`chan devserver run --tunnel-wireguard`) is unchanged.

## Acceptance

- Unit: the proxy's live table (a route added, replaced and removed after bind carries, moves and stops carrying connections), routing by name, the fabric's adopt and retire with a replaced row's old tunnel dropped after the new one is routed, a refused file disabling its row alone, a bind failure degrading every row with the reason, the registry's add, update and remove adopting and retiring, the connect adopting a row whose file is not running, and the launcher rendering no restart notice.
- `scripts/e2e/desktop-wireguard.sh` in a guest under Xvfb: a desktop started with a gateway row and no file binds its proxy with zero tunnels, takes the file through the library's gateway update route, reaches the peer through the tunnel from the same process (the discovery GET and a fetch from the launcher page), and returns to the direct path when the file is cleared; a desktop with no gateway row at all loads a local window and the launcher through the always-bound proxy.
- `scripts/e2e/desktop-wireguard-windows.sh`'s `loopback` and `webview-args` arms stay green with the proxy always bound; the existing suites stay green with a hand-written file still working.

## Built

Seven commits on `feat/desktop-wireguard-live-fabric`: `207b7569c` (the loopback proxy's route table is live: routes added, replaced and removed after the bind carry, move and stop carrying connections), `3c8827fe6` (a mapped host name is routed through its tunnel without a lookup on the host), `8162a5d7e` (chan-desktop binds the proxy at start with zero tunnels and adopts and retires tunnels in the running process; a refused file disables its row alone; a bind failure degrades every row with the reason), `30443da8f` (the launcher shows a gateway's live WireGuard state and no restart notice), `0a92321e8` (the suite's `--live-adopt` and `--no-wireguard` modes), and `cd44b53cb` with `2d0e39508` (the live-adopt tenant arm reads the discovery 404 from the connect's own answer, since a row that has never discovered keeps no `last_error`). The branch merged wgexpiry's `36fdffa81` for the suite's one-argument mode.

Verification: the unit tests of the acceptance list red before each change and green after it; `scripts/e2e/desktop-wireguard.sh` in a guest under Xvfb passes its default, `--wrong-key`, `--unresolved-endpoint`, `--live-adopt` and `--no-wireguard` modes at the tip; the `--live-adopt` tenant arm's constructed harness reds each of 24 single breaks on exactly one arm. The macOS reading of WKWebView's loopback routing is the owner's, recorded with the release.
