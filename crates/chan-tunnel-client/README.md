# chan-tunnel-client

Client library for chan-tunnel. Dials a public tunnel terminator over h2/TLS at `/v1/tunnel`, runs the Hello / HelloAck round-trip, hands the post-handshake byte stream to yamux, and serves every inbound substream with a user-supplied `axum::Router` via hyper h1 (`with_upgrades()` so WebSockets stay attached). Embedded into `chan-server` and driven by `chan devserver`, which registers at the public host and receives forwarded HTTP requests over a single long-lived h2 connection.

```toml
[dependencies]
chan-tunnel-client = "0.11"
```

## Public surface

```
ClientConfig                  url, token, workspace, backoff,
                              dial timeout, events tx,
                              substream concurrency cap
Registration                  HelloAck contents (prefix/user/workspace)
TunnelEvent                   Connected / Disconnected / DialFailed
ClientError                   URL, TLS, I/O, handshake, refusal,
                              and closed-transport errors

dial(cfg)                     one TLS+h2 attempt; returns yamux conn
dial_with_tls(cfg, tls)       same, with caller-cached TLS config
build_tls_config()            rustls + native roots, ALPN h2

handshake(cfg, socket)        free function: Hello/HelloAck over any
                              tokio duplex; used by wire tests
serve_substreams(yconn,
                 router)      run the axum router on every inbound
                              yamux substream (h1 + upgrades)
serve_substreams_with_limit   same, with explicit concurrency cap

run(cfg, router)              long-lived: dial, register, serve,
                              refresh admission authority, reconnect
                              with exponential backoff
```

## Build & test

From the workspace root:

```bash
cargo build -p chan-tunnel-client
cargo test  -p chan-tunnel-client
```

The full workspace gate (used by CI and the pre-push hook) is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Design

See [`design.md`](design.md) for the dial / handshake / yamux flow, permit-before-poll substream bound, PAT-backed admission-lease refresh, reconnect loop, loopback-only h2c policy, and cross-crate context. The wire format itself is in [`chan-tunnel-proto/design.md`](../chan-tunnel-proto/design.md).

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
