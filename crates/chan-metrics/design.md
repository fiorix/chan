# chan-metrics design

chan-metrics holds the counters behind chan's process metrics: a fixed set of process-wide statics that the serving and transport code feed, and a stream wrapper that counts bytes as they pass. It samples nothing and serves nothing. `chan-server` snapshots the statics once a second, turns the totals into rates and answers `/api/metrics` with them, which the Dashboard, `chan metrics` and the Varlink adapter read. What each reading means to a user is in [docs/metrics.md](../../docs/metrics.md); this note is what a contributor needs before adding a counter or wrapping a stream.

## Where it sits

The crate depends on `serde` and `tokio` and on no other chan crate, because the code that feeds it sits at every level: `chan-server` (the serving listener and the transfer routes), `chan-tunnel-client` (the gateway dial, the yamux session and its substreams), `chan-tunnel-proto` (the HTTP/2 stream a tunnel rides) and `chan-revtunnel` (reverse-forward listeners and connections). The gateway workspace compiles it as well, through `chan-tunnel-proto`. The counters are statics, not a handle passed down, so those crates share no context: a transport counts where the bytes are, and the one reader finds every counter by name. `chan-server`'s transfer lane keeps the occupancy and outcome counts only it produces as statics of its own, built from the same two types.

## What a counter holds

A `Counter` is four atomics: an `active` gauge, an `opened` total, and received and sent byte totals, all since process start, with directions as this process sees them. The gauge follows ownership. `enter` returns a `Guard` whose drop takes the count back, so a connection that ends by cancellation is uncounted the same way as one that closes; `enter_many` holds several counts under one guard, for capacity a session owns in bulk. A `Total` is one event count that only grows. `snapshot` copies a counter into an `Activity`, the shape the sampler serializes.

The set is fixed and carries no labels: one counter per layer, never one per peer, tunnel or request, so the memory and the response stay the same size however many connections a server carries.

## Layers are not summed

Each counter names one layer and counts payload bytes at that layer:

- `NETWORK`: the bytes of chan's own sockets: the streams the serving listener accepts, the transport stream of the gateway dial, counted beneath TLS, and reverse-forward connections. Each connection is counted once per leg.
- `HTTP2`: the HTTP/2 stream that carries a gateway tunnel.
- `YAMUX`: the yamux substreams of a tunnel, upgraded WebSockets included. `TUNNELS` counts connected sessions, and `YAMUX_WAITING`, `YAMUX_SERVING` and `YAMUX_SERVICE_CAPACITY` count the substreams waiting for a handler permit, the handlers holding one, and the permits the live sessions have.
- `REVERSE` and `REVERSE_LISTENERS`: reverse-forward connections with their bytes, and ready listeners.
- `TRANSFERS`: upload and download requests and the file bytes they move.
- `TUNNEL_DIAL_FAILURES`: failed gateway dial attempts, timed-out ones included.

The layers nest. A request through the gateway is the same bytes at `YAMUX`, inside `HTTP2`, inside `NETWORK`, and a reverse-forward connection is counted at `REVERSE` and at `NETWORK` on purpose. Adding layers together counts those bytes two or three times, so the sampler reports each layer by itself and no reading is a sum of layers. A new counter is a new layer with a name of its own.

## Metered I/O

`MeteredIo` wraps an `AsyncRead` and `AsyncWrite` stream and adds what each call moved to a counter: the bytes a read filled and the bytes a write reported as written. A failed or pending call adds nothing, and a write cancelled part way counts what the transport had accepted. `MeteredIo::new` also holds the counter's active count for the stream's life. `MeteredIo::half` counts bytes only, for the two halves of a split stream, whose owner holds one guard, so a connection is counted once however it is split.

The wrapper must not change how the stream is written. It forwards `poll_write_vectored` and `is_write_vectored` to the inner stream instead of taking tokio's defaults, which report a stream as not vectored and write only the first buffer of a vectored call. hyper and rustls batch their writes through the vectored path, and under the defaults a socket wrapped to be counted would take each batch as one copy or one record per call. Flush and shutdown pass through untouched.

## Boundaries

- The counts are userspace bytes at chan's own transports. They are not a host-interface total and include nothing a child process sends.
- Updates are relaxed atomics with no lock, and a snapshot reads its four fields one after another, so the fields of one snapshot can be a few operations apart.
- Nothing here samples, keeps history or computes a rate; that is `chan-server`'s `metrics` module.
