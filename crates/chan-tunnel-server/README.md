# chan-tunnel-server

The terminating side of the gateway tunnel: a library that accepts the long-lived h2c POSTs `chan devserver` dials, validates the bearer through a host-supplied `Validator`, runs Hello / HelloAck, registers each devserver in a shared `Registry`, and opens yamux substreams into the registered peer for the host to forward public requests over (WebSocket upgrades included). Embedded by the gateway's `devserver-proxy`, which routes `{owner}--{disc}.{proxy}.proxy.{domain}/{workspace}/...` to the registered peer behind a TLS-terminating edge.

```toml
[dependencies]
chan-tunnel-server = { workspace = true }
```

## Public surface

```
Validator (trait)             host-implemented: token -> Validated, plus an
                              optional display-name announcement
Validated                     user id, username, devserver id, scopes,
                              assertion key, admission lease and expiry
RegistrationAdmission (trait) controller-backed pre-insert permit and fence
AllowAllAdmission             the no-op admission for local embeddings
ServerError                   token, scope, identity, I/O, handshake,
                              capacity and control-plane errors

serve_tunnel_listener(listener, validator, registry, max_per_user)
                              accept loop with local admission
serve_tunnel_listener_with_admission(..., admission, ...)
                              the gateway path with fleet admission

Registry                      live (user, devserver id) -> TunnelHandle;
                              snapshots, events, eviction
TunnelHandle                  open() -> TunnelStream (a substream plus its
                              budget permit)
RegistryEvent, TunnelInfo, WorkspaceInfo
                              controller feed and admin snapshots
OpenError                     Disconnected
```

## Build and test

From the repository root:

```bash
cargo build -p chan-tunnel-server
cargo test  -p chan-tunnel-server
```

The full workspace gate (CI and the pre-push hook) is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Design

[`design.md`](design.md) covers the listener's ordering guarantees, the per-tunnel driver, admission and the lease refresh, the registry, the substream budget and the trust boundaries. The wire format is in [`chan-tunnel-proto/design.md`](../chan-tunnel-proto/design.md).

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
