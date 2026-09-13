# chan-tunnel-proto

Wire types and control frames for chan-tunnel: the length-prefixed JSON `Hello` / `HelloAck` pair, the workspace-name validator, and an `H2Duplex` adapter that turns an h2 `(SendStream, RecvStream)` pair into one `tokio::io` duplex. Mostly data plus a minimal codec; the async pieces (the framed read and write helpers, `H2Duplex`, and the accept-failure policy the gateway's raw accept loops share) run on the caller's tokio runtime and never start one. Both `chan-tunnel-client` and `chan-tunnel-server` depend on it; bumping the on-the-wire shape is done here, not in the I/O crates.

```toml
[dependencies]
chan-tunnel-proto = "0.11"
```

## Public surface

```
control::    Hello, HelloAck, ProtocolVersion
lease_refresh:: LeaseRefreshRequest, LeaseRefreshResponse
workspace_name:: is_valid_workspace_name, is_valid_username,
             sanitize_workspace_name,
             MAX_WORKSPACE_NAME_LEN, MAX_USERNAME_LEN
frame::      encode_frame, decode_frame, FrameError
io::         read_frame, write_frame, IoFrameError
h2_duplex::  H2Duplex
accept::     AcceptFailure, accept_next, ACCEPT_RETRY_PAUSE
const TUNNEL_PATH: &str            = "/v1/tunnel"
const MAX_CONTROL_FRAME_BYTES: usize = 64 * 1024
```

## Build & test

From the workspace root:

```bash
cargo build -p chan-tunnel-proto
cargo test  -p chan-tunnel-proto
```

The full workspace gate (used by CI and the pre-push hook) is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Design

See [`design.md`](design.md) for the wire format, framing, workspace-name rules, the `MAX_CONTROL_FRAME_BYTES` rationale, the accept-failure policy, and the cross-crate context.

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
