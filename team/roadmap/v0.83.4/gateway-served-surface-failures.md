# Gateway-served surface failures

Status: REGISTERED for v0.83.4, grounded 2026-08-04, specified 2026-08-04. Retargeted from v0.84.0: the grounding run closed the question the v0.84.0 registration left open, and the fix is patch-sized.

## What

Reaching a devserver through the gateway from chan-desktop breaks every mutating surface while read-only surfaces keep working: the launcher's Computers scope reports "This window was not granted library access", the Rich Prompt opens with chrome but no composer, `cs paste` waits forever, and session/config persistence silently fails. Paste also had a second, independent desktop defect on HTTPS pages. All of it was reproduced live on 2026-08-04 against a v0.83.3 gateway, devserver, and desktop.

## Verified current state

Grounded against the live gateway (DevTools on the failing window), not inferred:

- The desktop installs `__Host-devserver_gate` and `__Host-devserver_csrf` into the WebView cookie store natively (`desktop/src-tauri/src/devserver.rs`, `install_gateway_webview_session`), with a `Domain` attribute on a `__Host-` prefixed name. WebKit stores the pair and attaches both to requests, but never surfaces the csrf cookie to JavaScript: in the failing window `document.cookie` evaluates to `""` while the request's `Cookie` header carries `__Host-devserver_csrf`. The state survives a reload.
- The SPA's CSRF mirror reads `document.cookie` per request (`web/packages/workspace-app/src/api/transport.ts`, `cookieValue` / `gatewayCsrfHeaderPairs`). With the cookie invisible it emits no `x-chan-csrf` header, and the gateway's double-submit check (`gateway/crates/devserver-proxy/src/proxy.rs`, `csrf_header_matches_cookie`) answers every unsafe method with `403 forbidden`. Observed failing: `POST /api/drafts/new`, `POST /api/library/command-capabilities`, `POST /api/window/reply`, `PUT /api/session`, `PUT /api/config`.
- GETs and established WebSockets carry no CSRF requirement, so browsing, terminal I/O, and `/ws` presence keep working and the window looks healthy. `cs window list` showed the window `connected` while every mutation 403'd.
- The Rich Prompt's empty composer is an unhandled rejection, not a render bug: `onMount` awaits `ensureDraft()` with no catch (`web/packages/workspace-app/src/components/RichPrompt.svelte`), so a failed `POST /api/drafts/new` leaves `draftPath` empty and the `{#if draftPath}` composer never mounts. Observed as `Unhandled Promise Rejection: Error: forbidden`. The guard itself is a separate fix in `bug-fixes.md`.
- `cs paste` hangs because its command does arrive over `/ws` but the reply `POST /api/window/reply` 403s (`clipboard reply POST failed` in the console), so the CLI never settles. The clipboard read itself is not the blocker.
- Browsers are unaffected: they receive the csrf cookie via the spec-compliant `Set-Cookie` leg at `/_chan/entry`, which is JS-visible by design. Loopback is unaffected: no gateway, no CSRF check. Only desktop windows on gateway origins hit the native-injection path.
- Second, independent defect on the same windows: WKWebView mixed-content-blocks Tauri's `ipc://localhost` custom protocol on HTTPS pages ("requested insecure content", "IPC custom protocol failed, Tauri will now use the postMessage interface instead"). Every invoke on a gateway window degrades to postMessage after a failed first attempt; the clipboard image read hit this directly. Whether every affected IPC completes through the fallback is not fully verified.
- Third, latent defect: the native session refresh paths (`refresh_gateway_session_after` call sites in `devserver.rs`) re-mint the gate session without updating any WebView cookie jar; only window (re)navigation installs cookies (`window_watcher_wiring.rs` `navigate_remote`, `main.rs` retarget). Past the one-hour proxy session cap, an open window's jar goes stale and its GETs start failing too. Not yet observed live; proven by code reading.

## Contract

### CSRF delivery to desktop gateway windows

- A desktop window on a gateway origin must always present the connection's current csrf token on every unsafe request, through all session refreshes, without depending on `document.cookie` visibility.
- Expected shape: a desktop IPC read, not cookie injection. A new Tauri command returns the live csrf token for the calling window's gateway connection; the SPA mirror prefers it when running under Tauri on a gateway origin and falls back to `document.cookie` otherwise. The browser path and the loopback path must not change behavior.
- The command is origin-scoped: it resolves the caller's window to its connection and returns the token only for the session whose tenant origin the window is on. It rides the minted `gateway-window` runtime capability (`desktop/src-tauri/src/runtime_capability.rs`) so a `lib-*` window on the exact minted origin holds it and nothing else does. This confers no new authority: the desktop's native calls already send the same token as a header today, and a same-origin page could already read the cookie in any browser.
- Rotation is self-healing: when a request fails with the gateway's 403, the SPA transport re-reads the token and retries the request exactly once. A mid-session re-mint therefore heals on the next mutation instead of wedging the window.
- The mirror's source order and the retry are covered by vitest; the command's origin scoping and capability placement are covered by Rust tests through the existing runtime-capability test harness.

### Session refresh reaches open windows

- After every gateway session re-mint (the connect path, `navigate_remote`, and every `refresh_gateway_session_after` call site), the fresh gate and csrf cookies are installed into the shared cookie store without requiring a window navigation, so open windows never drift past the proxy's one-hour session cap.
- Installation must not depend on a specific window existing; if no window is open the install is a no-op and the next navigation installs as today.

### IPC on HTTPS-served windows

- No user-visible feature on a gateway-served window may depend on the `ipc://localhost` custom protocol. Clipboard text and image reads, native transfers, and downloads must all complete through the postMessage fallback or be re-routed so they do.
- The audit outcome (which invokes were verified over postMessage, which were re-routed) is recorded in implementation evidence.

## Acceptance checks

- New vitest coverage: mirror source order (desktop token, then cookie, then absent), the single 403 retry with token re-read, and the unchanged browser/loopback behavior.
- New Rust coverage: the command returns the token for the minted origin's `lib-*` window, refuses a foreign origin and a non-`lib-*` label, and reflects a re-mint without navigation; the refresh paths install fresh cookies.
- Focused `cargo test -p <crate> <filter>`, `cargo clippy -p <crate> --all-targets -- -D warnings`, `cargo fmt`, and `npm run check` plus the touched vitest files are green.
- Owner hand-smoke on the live gateway (the environment this was grounded in), on a window open past a session refresh: right-click Paste in terminal and editor, `cs paste` of text and of an image, Rich Prompt edit and submit, the Computers scope, and a file save.

## Implementation evidence

Implemented on 2026-08-04 in `17576cbb` (`fix(web): mirror gateway CSRF through desktop IPC`) and `51b392e6` (`fix(desktop): keep gateway sessions in sync`).

- `gateway_csrf_token` is registered with no JavaScript arguments. The handler resolves the calling `lib-*` label through the live feed, requires a connected gateway connection, compares the WebView's current origin with the pinned proxy origin, and repeats those checks after an awaited refresh. `allow-gateway-csrf-token` is a direct permission only on the runtime-minted exact-origin `gateway-window` capability.
- Every exchanged gateway session goes through one publisher on `GatewayConn`. The rostered connect path attaches the shared WebView-cookie-store installer before the first authenticated fetch, later native HTTP and navigation re-mints reuse it, and a missing WebView returns `Ok(())`. The concurrency/refresh test records `csrf-1` and then `csrf-2` through that same publisher and reads the second token without navigation.
- The SPA resolves unsafe-request mirrors in desktop-token, readable-cookie, absent order. Only a request whose first mirror came from desktop retries a 403, and it re-reads the mirror before that single retry. `chanFetch` covers Fetch consumers and the two multipart upload methods share the same behavior through a fresh XHR per attempt. Browser cookie and loopback requests remain single-attempt paths.
- The desktop bridge eagerly hydrates one module-level token cache when it registers the reader. Once hydrated, desktop-token, cookie, and absent paths issue Fetch and XHR synchronously; only a first request racing cold hydration may wait. A desktop-token 403 re-invokes the reader, updates that cache, and performs the sole retry. Browser and loopback paths return the original request promise without an added response microtask.
- HTTPS IPC audit: `Cargo.lock` pins Tauri 2.11.2. Its injected `invoke` sends one message through the IPC dispatcher; when the custom-protocol fetch fails, `ipc-protocol.js` marks that frame blocked, recursively submits the same message through `window.ipc.postMessage`, and keeps later messages on postMessage. `protocol.rs` receives the blocked marker and resolves the original callback without a custom-protocol response channel. Clipboard text/image, native upload/download plus progress/cancel, and generated-download begin/append/finish/cancel all use the SPA's centralized injected `invoke`; none was rerouted. This verifies the code path, while actual WKWebView delivery remains part of the owner live smoke.

Focused checks, rerun on the integrated team branch:

- `cargo fmt --all -- --check`: passed.
- `cargo test -p chan-desktop origin_aware_acl_grants_spa_invoke_vocabulary_per_window_class -- --nocapture`: 1 passed. The two loopback classes deliberately exclude the gateway-only command; both exact-origin gateway classes remain granted.
- `cargo test -p chan-desktop runtime_capability::tests -- --nocapture`: 6 passed.
- `cargo test -p chan-desktop gateway_csrf_token -- --nocapture`: 1 passed.
- `cargo test -p chan-desktop concurrent_session_miss_and_auth_refresh_each_exchange_once -- --nocapture`: 1 passed.
- `cargo clippy -p chan-desktop --all-targets -- -D warnings`: passed.
- `cd web/packages/workspace-app && npm exec vitest run src/api/desktop.test.ts src/api/transport.test.ts src/api/uploadCsrf.test.ts src/tauri_invoke_centralization.test.ts`: 4 files passed, 38 tests passed.
- `cd web/packages/workspace-app && npm run check`: 0 errors and 0 warnings.
- `cd web/packages/workspace-app && npm exec vitest run src/state/store.test.ts src/components/SettingsOverlay.render.test.ts src/api/transport.test.ts src/api/uploadCsrf.test.ts src/api/desktop.test.ts`: 5 files passed, 103 tests passed. This includes the synchronous keepalive DELETE and settings PATCH regressions plus cache timing coverage.
- `cd web && npm run check`: passed for every workspace; all Svelte checks reported 0 errors and 0 warnings, and the marketing build and smoke checks passed.

Live regression follow-up on 2026-08-04:

- Fresh-session cookie convergence now runs in a helper that clones the current session inside a dedicated mutex-guard scope, installs it after that guard drops, and re-locks only for the current-session check. This removes the edition-2021 `while let` scrutinee lifetime that deadlocked every gateway connect with a live session.
- `cargo test -p chan-desktop gateway_session_install_returns_with_a_fresh_session -- --nocapture`: 1 passed. The focused test enters the production convergence helper with a fresh session and records one completed install; the deadlocking loop never returned from this case.
- `cargo test -p chan-desktop gateway_csrf_token -- --nocapture`: 1 passed.
- `cargo test -p chan-desktop runtime_capability::tests -- --nocapture`: 6 passed.
- `cargo test -p chan-desktop concurrent_session_miss_and_auth_refresh_each_exchange_once -- --nocapture`: 1 passed.
- `cargo clippy -p chan-desktop --all-targets -- -D warnings`: passed.
- `cargo fmt --check`: passed.

Owner live gateway hand-smoke: requested from the acting lead on 2026-08-04; result pending.

## Boundaries

- No gateway changes: the proxy's double-submit check, the entry exchange, and the cookie contract stay exactly as they are.
- No change to what browsers or loopback clients do.
- No change to the `__Host-devserver_gate` cookie's HttpOnly property; the gate token must never become JS-readable.
- No new IPC permissions beyond the one command on the existing minted capability; no scoped permissions and no deny entries in the runtime capability (its module doc explains why both are absolute).
- The Rich Prompt error-surface hardening is `bug-fixes.md`, not this item.
- No desktop UI changes.
