# WebView2 shows Edge's 504 page after 30 s on a dead WireGuard tunnel

Status: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the Linux `tunnel-page` arm and the Windows `page` and `wrong-key` arms read green in the release's guests; the mapped-name route is pinned by unit tests alone.

## What was seen

In the Windows 11 guest with a wrong peer key, a chan-desktop window loading a page inside the tunnel shows WebView2's own error page for a 504 after 30 s. The loopback proxy bounds resolution and the connect together at 30 s and answers `504 Gateway Timeout` with an empty body (`crates/chan-wireguard/src/proxy.rs`; the crate design's loopback proxy section), which is the only bound on a connect through a tunnel whose peer is silent. Every proxy refusal has that one shape on purpose, and CONNECT clients, the webviews among them, do not show a CONNECT error body, so a body would not reach the window for an `https://` origin. The desktop knows the tunnel's state the whole time.

## Desired contract

A decision for the owner, then the build:

1. What a window shows while its gateway's tunnel has no session: a page of chan's own with the gateway's WireGuard state and reason, rather than a browser error page.
2. How long a window waits on a tunnel that has never completed a handshake before it says so, against the 30 s the proxy waits for any connect.
3. Whether the same applies on Linux and macOS, whose webviews were not read on a dead tunnel.

## Acceptance

`scripts/e2e/desktop-wireguard-windows.sh`'s wrong-key arm reads chan's page with the tunnel's reason in the window, and a live tunnel's window is unchanged.

## Built

The existing bundled connecting page shows the gateway tunnel's reason on failed probes, including a mapped tenant host that the proxy routes without OS lookup. It keeps the last reason in the give-up message. A request's SYN starts the handshake immediately; when the tunnel has no session, the proxy waits up to three seconds for the connect to complete and answers 502 if the tunnel remains dark. A live session keeps the existing connect deadline.

The Linux `tunnel-page` arm observes a tenant window through loss and recovery with a devserver forwarded through the peer. The Windows `page` arm reads the live connecting page and its tenant handoff, while `wrong-key` reads the direct 502 control and chan's reason page. The mapped-name reason is pinned by unit tests; these guest arms use an address route because production adoption supplies no host routes yet. Guest runs are the remaining proof.

Commits `3f99f9248`, `6b42f32c0`, `e41efbda2`, `30ee30758`, `4a7bf3f90` and `e8019619d` on `feat/desktop-wireguard-tunnel-page`, merged as `58ac52075`, and the Windows wrong-key arm scoped to its observable paths, `e0020fc1a`, merged as `525cd5b74`. The guest runs since: the Linux `tunnel-page` arm green in the release's desktop guest, and the Windows `page` and `wrong-key` arms green against the integration tip's installer from a Desktop Package Dry Run, the 502 within 3 s with the no-handshake reason where the previous release's installer answered the 504.
