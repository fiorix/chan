# The Rust TLS clients ignore the system's CA store

Status: raised on 2026-11-07 from the v0.125.0 release's enrollment proof; accepted by the owner for v0.126.0 at the v0.125.0 cut; moved to v0.127.0 by the owner on 2026-11-08; moved to v0.128.0 by the owner on 2026-11-09; not started.

## What is there now

The root workspace selects reqwest with `rustls-tls` alone (`Cargo.toml`), which is `rustls-tls-webpki-roots`: the bundled Mozilla roots and nothing else. The desktop's reqwest clients (`desktop/src-tauri/src/wireguard.rs`, `client_builder`, which every gateway call shares) and its WebSocket feed (`tokio-tungstenite` with `rustls-tls-webpki-roots`) therefore verify a gateway against the bundled roots only, and so does the peer agent (`gateway/crates/wireguard-agent`, on the gateway workspace's reqwest with `rustls-tls`). A CA installed in the operating system's trust store, the shape of a corporate or self-signed gateway, is honoured by the system webviews and by `curl` and refused by chan's Rust clients with a certificate error; the release's enrollment proof ran without TLS for this reason. One client is the exception: the tunnel dial in `crates/chan-tunnel-client/src/dial.rs` (`build_tls_config`) loads the native certificates with `rustls-native-certs` beside the bundled roots, so the same gateway is trusted by the tunnel and refused by the sign-in that precedes it.

## Desired contract

1. Every Rust TLS client of the desktop and the peer agent trusts the platform's own store beside the bundled roots: the platform verifier on macOS and Windows and the system bundle on Linux, with the bundled WebPKI roots kept as the floor, so a gateway behind a public CA verifies as today and a corporate or self-signed one verifies once its CA is in the store.
2. Verification is never weakened: no option disables it, no certificate is pinned by hand, and a CA absent from both stores still fails with the certificate error.
3. The tunnel dial and the HTTP and WebSocket clients agree: one trust decision per platform, built in one place, so a gateway trusted by one is trusted by all.

## Boundaries

- The clients' TLS configuration (reqwest's features or a shared rustls `ClientConfig`, tokio-tungstenite's connector, the agent's client); no change to what the clients send or to the gateway's certificates.
- The verifier is a dependency decision made with the owner, `rustls-platform-verifier` against `rustls-native-certs`, read on each platform before it is chosen.

## Acceptance

1. A throwaway CA installed in the system store and a gateway served under a leaf it signed: the desktop's sign-in, discovery and WebSocket feed and the peer agent's calls succeed on Linux, macOS and Windows, each read on that platform; with the CA absent from the store every client fails with the certificate error, and the same install at the base changes nothing (the red).
2. A gateway behind a public CA verifies unchanged on each platform with the bundled roots alone, read with an empty system store on Linux.
3. `cargo tree` at the tip shows one TLS backend for every client; `make pre-push` and the desktop package green.
