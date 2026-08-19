# chan-tunnel-server

Server-side library for chan-tunnel: terminates the long-lived h2c POSTs from `chan devserver` clients, runs Hello / HelloAck, registers each tunnel in a shared `Registry`, and opens fresh yamux substreams to forward requests (including WebSocket upgrades) into the registered peer. Designed to be embedded into a host process (the gateway's `devserver-proxy`) which provides the `Validator` impl, routes `{owner}--{disc}.{proxy}.proxy.{domain}/{workspace}/...` to the registered peer, and lets nginx terminate TLS in front.

```toml
[dependencies]
chan-tunnel-server = "0.11"
```

## Public surface

```
Validator (trait)             implemented by host: token -> Validated
Validated                     user_id, username, scopes
                              assertion key, admission lease + expiry
ServerError                   uniffi-friendly error variants
RegistrationAdmission        controller-backed pre-insert permit + fence

handshake(socket, token,
          validator, pre_ack) free function: validate + Hello/HelloAck
                              over any tokio duplex
handshake_validated(...)      same, with already-validated identity

serve_tunnel_listener(
    listener, validator,
    registry, max_workspaces_per_user)
                              accept loop on a TCP listener; runs h2
                              server, validates, registers, workspaces
serve_tunnel_listener_with_admission
                              production path with fleet admission authority

Registry                      live (user, devserver_id) -> TunnelHandle
TunnelHandle                  open() -> yamux::Stream
WorkspaceInfo / TunnelInfo        admin snapshots
OpenError                     Disconnected
```

## Build & test

From the workspace root:

```bash
cargo build -p chan-tunnel-server
cargo test  -p chan-tunnel-server
```

The full workspace gate (used by CI and the pre-push hook) is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Design

See [`design.md`](design.md) for the listener / driver / registry shape, controller admission fence, PAT-backed expiring lease refresh, eviction policy, and public substream lifecycle. The wire format itself is in [`chan-tunnel-proto/design.md`](../chan-tunnel-proto/design.md).

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
