# Gateway security review

Status: SHIPPED in [v0.83.0](../release/release-v0.83.0.md). Entry-path failures are registry-independent, the identity SPA policy admits the provider avatar it renders, and audit-IP parsing is strict.

## What

The gateway security review owns four externally visible contracts: tunnel authentication failures do not disclose token scope, entry-exchange failures do not disclose live-devserver count in their response tuples, the identity SPA security policy permits the provider-hosted avatar it renders, and audit IP values contain only canonical IP addresses.

The implementation and its documentation land together. A security property described in a design document must have a falsifiable check against the same behavior.

## What is already known (grounding, verified 2026-08-02)

- Tunnel authentication runs before the HTTP 200 in `crates/chan-tunnel-server/src/tunnel.rs:264-299`. Invalid tokens and validated tokens without `tunnel` scope both receive an empty 401, while the listener retains distinct typed errors. `crates/chan-tunnel-client/src/dial.rs:139-147` maps only that 401 to one generic diagnostic. `stub_validator_auth_failures_match_status_and_body` (`crates/chan-tunnel-server/tests/listener_e2e.rs:292`) pins the status and body visible through the synchronous validator stub.
- Entry method, Origin, Content-Type, bounded body read, and form parsing all run before registry lookup in `proxy::handle` and `read_entry_credential` (`gateway/crates/devserver-proxy/src/proxy.rs:240,510`). Every entry-specific 404 comes from `entry_not_found_response` (`:1276`) and ignores `Accept`. `entry_preflight_is_independent_of_live_devserver_count` (`gateway/crates/devserver-proxy/tests/api.rs:808`) compares full response tuples for zero, one, and two live devservers, including `Accept: text/html`, malformed form data, and an oversized body.
- Identity SPA HTML receives its policy in `gateway/crates/identity/src/static_files.rs:24-45`. The exact CSP is test-pinned independently at `:55`; `img-src 'self' data: https:` admits the provider-hosted avatar URL rendered directly by the profile SPA while refusing cleartext images. The application adds CSP and XFO. Production nginx supplies `nosniff` and `strict-origin-when-cross-origin`; the static shell contains no embedded authorization state and sets no cache policy.
- `client_ip` (`gateway/crates/identity/src/http.rs:2875`) parses only the leftmost XFF value as `IpAddr` and stores its canonical string. `client_ip_accepts_only_a_well_formed_leftmost_address` (`:2924`) covers IPv4, IPv6 normalization, and non-address refusal. The value remains audit-only and is not an authorization input.
- Proxy fixtures use shared `gw.chan.app` identity-origin and dashboard constants (`gateway/crates/devserver-proxy/tests/api.rs:46-47`; `proxy.rs:1382`).

## Contract

- Invalid and scopeless tunnel PATs receive the same empty 401 status and body. The client diagnostic does not distinguish them. Other HTTP statuses remain unexpected.
- Every entry-exchange 404 is the same JSON response regardless of `Accept` or live-devserver count. Method, Origin, Content-Type, 8 KiB body limit, and exact one-field form checks run before registry lookup, so their complete responses depend only on request shape.
- Identity SPA HTML carries the exact CSP pinned in its test and `X-Frame-Options: DENY`. Provider avatars may load over HTTPS. Non-HTML assets do not inherit document headers.
- XFF contributes to audit metadata only when its leftmost element is a valid IPv4 or IPv6 address; invalid input records no client IP.
- Design documents state only these implemented guarantees. They do not claim latency equalization or application-layer parity with the production edge.

## Rough size

Small to moderate. The item touches three request boundaries, focused tests, and their design references across the root and nested gateway Cargo workspaces. It adds no dependency, database migration, route, or wire version.

## Open

- Whether identity should duplicate the production edge's `nosniff` and referrer policy at the application layer for non-production deployments. This is defense in depth and is not required for the production contract.
- Whether entry failures need latency equalization in addition to byte-identical response tuples. This item makes no timing guarantee.

## Acceptance

- `entry_preflight_is_independent_of_live_devserver_count` sends `Accept: text/html` with an invalid credential and pins identical complete responses across zero, one, and two live devservers; malformed and oversized forms likewise pin 400 and 413 across every count.
- `stub_validator_auth_failures_match_status_and_body`, `invalid_token_returns_401`, and `missing_base_scope_returns_401` pass; no server tunnel path emits 403 for missing scope.
- `html_responses_carry_spa_security_headers` asserts the literal CSP containing `img-src 'self' data: https:` and passes against a built identity SPA bundle.
- `client_ip_accepts_only_a_well_formed_leftmost_address` passes for canonical IPv4 and IPv6 and rejects non-address prose.
- Every proxy fixture and unit test changed by this item uses the shared current identity-origin constant.
- `make gateway-spa`; then gateway `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `TEST_DATABASE_URL=postgres://chan:chan@127.0.0.1/chan_gateway_test cargo test` are green.
- Root `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test -p chan-tunnel-server -p chan-tunnel-client` are green.
