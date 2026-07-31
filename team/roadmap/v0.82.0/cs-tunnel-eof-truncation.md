# Fix `cs tunnel` EOF truncation

Status: COMPLETE. The connection lifecycle now drains bytes already read from either TCP endpoint before its data WebSocket closes.

## What

`cs tunnel` previously closed a forwarded TCP connection before bytes already read from the source socket crossed the data WebSocket. HTTP responses then arrived shorter than their declared `Content-Length`; Chromium reported `net::ERR_CONTENT_LENGTH_MISMATCH` despite a `200 OK` response.

This is a transport data-loss race, not a response-size limit. The reverse-tunnel contract leaves total transferred bytes unmetered. `MAX_DATA_FRAME_BYTES` remains a per-frame limit of 64 KiB, and the channel capacities remain implementation backpressure rather than body-size limits.

## Observed failure

The unfixed code failed below the eight-frame channel capacity. A 131,072-byte response failed 10/10 with zero bytes received, and a 65,537-byte response failed 1/10 with zero bytes received on one sequential run. The 512 KiB minus one byte case failed 5/10, with a worst result of 65,536 bytes. The race can discard a body wholesale; 512 KiB is only the point where the channel cannot hold the entire body, not a reliable failure threshold.

The owner-run 2 GiB proof failed all 3/3 unfixed iterations at commit `c7257443`: curl exited 18 with 131,072, 458,752, and 524,288 bytes missing. The missing counts are whole 64 KiB frames, consistent with queued-frame cancellation.

## Root cause

Three cancellation sites could discard bytes:

- `crates/chan-revtunnel/src/bridge.rs`: the inner `select!` canceled an in-flight `Sender::send` or `write_all` when the opposite direction ended.
- `crates/chan-server/src/routes/tunnel.rs`: `serve_tunnel_conn` selected among the splice, the uplink adapter, and the downlink adapter. Source EOF or a downlink close canceled the uplink before its queued frames drained. Both channels have capacity eight.
- `crates/chan-revtunnel/src/client.rs`: `serve_conn` aborted the WebSocket shuttle as soon as `splice` returned. Both channels have capacity sixteen.

The loss window can include the queued frames plus a frame whose send was canceled, so it is larger than eight frames. The measured 4 MiB loss was 469,081 bytes in the unfixed path.

## Fix contract

- `bridge::splice` cancels only at read/receive boundaries. An in-progress `send` or `write_all` completes before the other direction's stop signal takes effect.
- The pump still ends both directions together on TCP EOF, peer-channel close, or socket error. `to_peer` is dropped when `splice` returns.
- Under the no-half-close policy, local TCP EOF completes only an already-running downlink `write_all`; chunks still queued in `from_peer` are intentionally outside the drain guarantee because both directions end together.
- The server consumes the uplink concurrently with `splice`, then awaits it after `splice` returns to drain every queued frame. The downlink is aborted only after that drain.
- The desktop joins `splice` and its WebSocket shuttle as one cancellation unit. A normal EOF lets the shuttle observe the dropped outbound sender and close itself; tunnel teardown still aborts the owning connection through `JoinSet::shutdown`.
- No wire signal, deadline, capacity change, or total-byte limit is introduced.

## Coverage and placement

The always-on `crates/chan/tests/revtunnel_e2e.rs` suite uses a close-after-write origin and deterministic index-derived bytes. Every case runs at least 10 iterations and checks both length and content:

| size | sequential directions | concurrent connections |
| --- | --- | --- |
| 65,537 | devserver to desktop, desktop to devserver | six connections |
| 131,072 | devserver to desktop, desktop to devserver | six connections |
| 524,287 | devserver to desktop, desktop to devserver | six connections |
| 524,288 | devserver to desktop, desktop to devserver | six connections |
| 524,289 | devserver to desktop, desktop to devserver | six connections |
| 4,194,304 | devserver to desktop, desktop to devserver | six connections |

The pump unit tests pin both in-flight cancellation invariants. The always-on suite is run in serial and parallel modes. Anything at or above 1 GiB belongs in `scripts/e2e/`, never in `make pre-push` or CI, because the suite has a 12-second await bound and multi-GiB debug transfers take materially longer.

`scripts/e2e/revtunnel-large-transfer.sh` is the owner-run proof. It creates a sparse 2 GiB fixture outside `/tmp`, starts `python3 -m http.server` on origin port 18501, opens `cs tunnel` on desktop port 18500, pulls with curl for 3 iterations by default, and records curl status, byte count, SHA-256 values, and elapsed time. It preserves logs and artifacts on failure and tears down only the process it started.

The marketing-site browser smoke is owner-only and manual. It cannot run in this environment because the SPA refuses the tunnel-open call off Tauri and there is no display server. It is not automated or counted as coverage here.

## Verification

- `cargo test -p chan-revtunnel --all-targets`: 32 passed.
- `cargo test -p chan-server --lib`: 935 passed.
- `cargo test -p chan --test revtunnel_e2e`: 9 passed, 1 owner-only ignored. Five serial repetitions and five parallel repetitions are green.
- The post-fix boundary and concurrent cases report zero failures at every size in both directions.
- The pre-fix and post-fix owner-run 2 GiB results are recorded side by side in the tunnel journal. The post-fix run transferred all 3 iterations byte-identically with curl exit 0.
