# chan-tunnel-proto

The wire contract of the gateway tunnel: the length-prefixed JSON `Hello` / `HelloAck` pair and the lease-refresh frames, the workspace-name and username validators, `H2Duplex` (an h2 `(SendStream, RecvStream)` pair as one tokio duplex), the signed gateway assertion, and the accept-failure policy the gateway's raw accept loops share. Mostly data plus a small codec; the async helpers run on the caller's tokio runtime and never start one. Both `chan-tunnel-client` and `chan-tunnel-server` depend on it, and a change to the bytes is made here, not in the I/O crates.

```toml
[dependencies]
chan-tunnel-proto = { workspace = true }
```

## Public surface

```
Hello, HelloAck, HelloAckOk, HelloAckErr, ProtocolVersion, error_code::*
LeaseRefreshRequest, LeaseRefreshResponse
is_valid_workspace_name, is_valid_username, MAX_WORKSPACE_NAME_LEN, MAX_USERNAME_LEN
encode_frame, decode_frame, FrameError
read_frame, write_frame, IoFrameError
H2Duplex
accept_next, AcceptFailure, ACCEPT_RETRY_PAUSE
gateway_assertion::{derive_assertion_key, devserver_id_from_token, claims, sign,
                    verify, canonical_audience, Claims, ClientType, AssertionError,
                    HEADER_NAME}
TUNNEL_PATH, MAX_CONTROL_FRAME_BYTES, and the shared h2 and yamux transport constants
```

## Build and test

From the repository root:

```bash
cargo build -p chan-tunnel-proto
cargo test  -p chan-tunnel-proto
```

The full workspace gate (CI and the pre-push hook) is `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Design

[`design.md`](design.md) covers the end-to-end tunnel flow, the control frames and why they are a framed body, the identity rules, `H2Duplex`, the gateway assertion and the accept-failure policy.

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
