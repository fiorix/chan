# chan-tunnel-client

The dial side of the gateway tunnel. Dials a gateway's tunnel terminator over h2 and TLS at the tunnel path, runs the Hello / HelloAck round-trip, hands the post-handshake byte stream to yamux, and serves every inbound substream with a caller-supplied `axum::Router` through hyper's h1 server (with upgrades, so WebSockets stay attached). Embedded in `chan-server` and driven by `chan devserver`, which registers with the gateway and receives forwarded HTTP requests over one long-lived h2 connection.

```toml
[dependencies]
chan-tunnel-client = { workspace = true }
```

## Public surface

```
ClientConfig                  url, token, workspace label, display name,
                              backoff, dial timeout, events tx, proxy,
                              substream concurrency cap
Registration                  HelloAck contents (prefix, user, devserver id,
                              owner id); attached to each request as an
                              axum Extension
TunnelEvent                   Connected / Disconnected / DialFailed
ClientError                   URL, TLS, I/O, handshake, refusal and
                              closed-transport errors

dial(cfg)                     one TLS+h2 attempt; returns the registration
                              and the yamux connection
dial_with_tls(cfg, tls)       same, with a caller-cached TLS config
build_tls_config()            chan-tls's trust decision, ALPN h2

handshake(cfg, socket)        Hello/HelloAck over any tokio duplex; used
                              by wire tests
serve_substreams(conn,
                 router)      run the router on every inbound substream
serve_substreams_with_limit   same, with an explicit concurrency cap

run(cfg, router)              long-lived: dial, register, serve, refresh
                              the admission lease, reconnect with backoff
```

## Build and test

From the repository root:

```bash
cargo build -p chan-tunnel-client
cargo test  -p chan-tunnel-client
```

The full workspace gate (CI and the pre-push hook) is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Design

[`design.md`](design.md) covers the dial, the handshake, substream serving and its permit ordering, the lease refresh, the reconnect loop and the trust rules (loopback-only cleartext, proxy credentials). The wire format is in [`chan-tunnel-proto/design.md`](../chan-tunnel-proto/design.md).

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
