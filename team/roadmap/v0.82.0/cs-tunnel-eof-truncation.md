# Fix `cs tunnel` EOF truncation

Status: REGISTERED for v0.82.0; reproduced and grounded 2026-07-31.

## What

`cs tunnel` can close a forwarded TCP connection before bytes already read from the source socket have crossed the data WebSocket. HTTP responses then arrive shorter than their declared `Content-Length`; Chromium reports `net::ERR_CONTENT_LENGTH_MISMATCH` despite the response status being `200 OK`.

This is a transport data-loss bug, not an intentional response-size cap. The reverse-tunnel design explicitly leaves transferred bytes unmetered, and there is no CLI, environment, or config setting for a total-byte limit.

## Reproduction

A generated `@chan/marketing` site was served by `python3 -m http.server` on the devserver at `127.0.0.1:37845` and opened from the desktop through `cs tunnel`.

- HTML, CSS, and JavaScript loaded.
- PNG requests reached the origin and were logged as `200`, but Chromium rejected them with `net::ERR_CONTENT_LENGTH_MISMATCH`.
- The origin files were valid PNGs, and direct HTTP fetches returned byte-identical copies.
- The same site and files loaded correctly through an SSH tunnel, isolating the failure to the `cs tunnel` path.
- The smallest large failing image was 524,405 bytes, 117 bytes above 512 KiB. A 168,868-byte favicon also failed during a concurrent page load, so 512 KiB is the reliable pressure point rather than a clean configured cutoff.

## Root cause

The devserver-to-desktop path combines a hard-coded 64 KiB data-frame size with a hard-coded eight-entry server-side channel:

- `MAX_DATA_FRAME_BYTES` is `64 * 1024` in `crates/chan-revtunnel/src/wire.rs`.
- `serve_tunnel_conn` creates `mpsc::channel::<Vec<u8>>(8)` in `crates/chan-server/src/routes/tunnel.rs`, giving the WebSocket uplink 512 KiB of queued frame capacity.
- `bridge::splice` returns as soon as either the local TCP reader reaches EOF or the opposite direction ends.
- `serve_tunnel_conn` selects between `splice`, the WebSocket uplink, and the WebSocket downlink. When `splice` wins on source EOF, the other futures are cancelled and the WebSocket is closed without first draining `uplink_rx`.

An HTTP/1.0-style origin writes the complete response and closes. Once the TCP reader observes that close, up to eight already-read frames can still be queued for the WebSocket. The outer `select!` may discard that tail. Responses above 512 KiB reliably put pressure on this queue, while scheduling can expose the same race on smaller responses.

The desktop client has the symmetric lifecycle hazard in `crates/chan-revtunnel/src/client.rs`: it uses a 16-entry channel, awaits `splice`, and then aborts the WebSocket shuttle. Both directions need an explicit drain contract rather than relying on task cancellation at EOF.

## Contract

- Every byte successfully read from one TCP endpoint must be written to the peer before the data WebSocket closes.
- TCP EOF may end both directions, preserving the current no-half-close policy, but only after the already-read outbound queue drains.
- A WebSocket error, peer disappearance, tunnel teardown, or failed devserver dial may still terminate immediately.
- `MAX_DATA_FRAME_BYTES` remains a per-frame protocol bound, not a total connection or response limit.
- Channel capacity remains a backpressure implementation detail and must not affect the maximum transferable body size.

## Acceptance

- Add a full reverse-tunnel regression in which the devserver endpoint writes a payload and immediately closes; the desktop endpoint must receive byte-identical bodies at 512 KiB minus one byte, exactly 512 KiB, 512 KiB plus one byte, and several MiB.
- Exercise the opposite direction with the same close-after-write shape so the desktop-side `shuttle.abort()` path cannot discard queued frames.
- Include multiple concurrent connections to cover the page-load pattern that exposed the bug.
- Keep the existing refused-dial, Ctrl-C teardown, desktop-disconnect, and tunnel-lifetime tests green.
- Re-run the marketing-site browser smoke through `cs tunnel`; Chromium must load every image without `ERR_CONTENT_LENGTH_MISMATCH`.

## Rough size

Small to medium. The code change is a focused connection-lifecycle fix on both WebSocket adapters; the important weight is the exact-boundary and concurrent end-to-end regression coverage.
