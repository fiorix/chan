# Retire the legacy devserver window endpoint

Status: REGISTERED for v0.82.0; one release of compatibility-adapter life is expected.

## What

`GET /api/devserver/windows` exists only for pre-0.81.0 desktops. Its handler adapts the authoritative `WorkspaceHost::assemble_window_records()` feed to the frozen six-field wire (`label`, `prefix`, `token`, `title`, `connected`, `saved`) and excludes transient control rows. Current desktops read `GET /api/library/windows` directly, including through the gateway-aware client path.

Once pre-0.81.0 desktops are out of circulation, the compatibility surface has no in-tree consumer and should be removed rather than maintained as a second window-list contract.

## Contract

- Remove the `/api/devserver/windows` route and `handle_list_windows` adapter from `crates/chan-server/src/devserver.rs`.
- Remove `DevserverWindow` from `crates/chan-server/src/devserver_api.rs`.
- Remove the frozen-wire serialization test and the adapter behavior test that exist solely for the compatibility endpoint.
- Keep `GET /api/library/windows` and its `WindowRecord` contract unchanged; it remains the single desktop, launcher, and control-client feed.
- Do not add a redirect or alternate legacy response. Retirement is a hard removal after the compatibility window.

## Acceptance

- No shipped code in `crates/chan-server` references `/api/devserver/windows`, `handle_list_windows`, or the `DevserverWindow` wire type. The unrelated desktop type of the same name is untouched.
- The server route answers 404, asserted against a running devserver rather than only in a unit test, so the retirement is proven on the real surface a client would reach.
- `GET /api/library/windows` continues to answer on the same running devserver, proving the retirement removed only the compatibility adapter.
- `cargo test -p chan-server --lib` and the chan-desktop test target stay green.
- The roadmap item closes with the v0.82.0 release report after the endpoint is removed.

## Rough size

Small. One route, one adapter, one response type, and their focused tests.
