# Retire the legacy devserver window endpoint

> Status: shipped in [v0.82.0](../../release/release-v0.82.0.md): the route, adapter, frozen wire type, and its two tests are removed, scoped to chan-server. Removal proceeded on the no-back-compat rule because the stated precondition cannot be satisfied off macOS.
Status: DONE.

## Ruling

chan is pre-release, so legacy fields, formats, and identifiers are removed without compatibility or migration paths (`.agents/playbook.md:77`). The legacy `GET /api/devserver/windows` route, its adapter, its frozen six-field wire type, and the two tests that existed only for that surface are removed. `GET /api/library/windows` and `WindowRecord` remain unchanged as the single window feed.

The desktop switched to the library feed in `eb1c29e1` at `2026-07-30T23:28:22Z`. The v0.81.0 release commit `ab618db5` is dated `2026-07-30T23:57:11Z`, and the annotated `v0.81.0` tag was created at `2026-07-31T06:04:33Z`. These timestamps establish ordering only; they do not support a duration of compatibility life.

Waiting until pre-0.81.0 desktops leave circulation is not a satisfiable precondition. The updater manifest has exactly one hardcoded platform key, `darwin-aarch64` (`web/packages/marketing/scripts/collect-release-assets.mjs:30-33`). On non-macOS targets the launch update check is an empty function (`desktop/src-tauri/src/main.rs:3626-3629`), and a manual upgrade returns a typed not-supported error (`desktop/src-tauri/src/main.rs:3480-3491`). Linux AppImage and Windows NSIS installations therefore do not retire themselves through the desktop updater.

The accepted consequence is that a pre-0.81.0 desktop on Linux or Windows silently loses its Window-menu reopen entries.

## Delivered contract

- `GET /api/library/windows` is the only window feed. Its `WindowRecord` exposes every field represented by the removed frozen wire and additional current state, including whether a row is a control window.
- No redirect, deprecation response, stub 410, or alternate legacy response replaces `GET /api/devserver/windows`.
- `DEVSERVER_API_PROTOCOL` is deliberately unchanged. The retired path disappears without protocol negotiation.
- The public gateway already returns 404 for the entire `/api/devserver/*` management namespace (`gateway/crates/devserver-proxy/src/proxy.rs:265-269`, `:565-571`; `gateway/crates/devserver-proxy/tests/api.rs:1055-1078`). Removal affects only a loopback-attached legacy desktop.
- The unrelated desktop `DevserverWindow` and `DevserverWindowFeed` types remain intact.

## Observed routing consequence

An unauthenticated request to `GET /api/devserver/windows` returns 404 after removal instead of the prior 401. The bearer gate is a route layer and runs only for matched routes (`crates/chan-server/src/devserver.rs:2066-2069`). With no matching route, the launcher root fallback dispatches the `/api` miss to `serve_launcher`, which returns 404 (`crates/chan-server/src/static_assets.rs:172-176`). This is an observed consequence of generic fallback routing, not a separate acceptance assertion and not behavior implemented for the retired path.
