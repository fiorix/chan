# WebView2 shows Edge's 504 page after 30 s on a dead WireGuard tunnel

Status: raised at the v0.124.0 close from the Windows desktop WireGuard run, by the owner's word that its three findings become v0.125.0 rows; not started.

## What was seen

In the Windows 11 guest with a wrong peer key, a chan-desktop window loading a page inside the tunnel shows WebView2's own error page for a 504 after 30 s. The loopback proxy bounds resolution and the connect together at 30 s and answers `504 Gateway Timeout` with an empty body (`crates/chan-wireguard/src/proxy.rs`; the crate design's loopback proxy section), which is the only bound on a connect through a tunnel whose peer is silent. Every proxy refusal has that one shape on purpose, and CONNECT clients, the webviews among them, do not show a CONNECT error body, so a body would not reach the window for an `https://` origin. The desktop knows the tunnel's state the whole time.

## Desired contract

A decision for the owner, then the build:

1. What a window shows while its gateway's tunnel has no session: a page of chan's own with the gateway's WireGuard state and reason, rather than a browser error page.
2. How long a window waits on a tunnel that has never completed a handshake before it says so, against the 30 s the proxy waits for any connect.
3. Whether the same applies on Linux and macOS, whose webviews were not read on a dead tunnel.

## Acceptance

`scripts/e2e/desktop-wireguard-windows.sh`'s wrong-key arm reads chan's page with the tunnel's reason in the window, and a live tunnel's window is unchanged.
