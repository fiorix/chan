# Make the terminal backend visible and switchable

Status: SHIPPED for v0.82.0.

## Shipped behavior

Every spawned PTY exports `CHAN_TERMINAL=xterm` or `CHAN_TERMINAL=ghostty`. The value records the configured backend at child spawn time. It is set after the inherited MCP and systemd environment scrub, so it is present for workspace and terminal-only tenants without allowing a parent value to leak through.

The value belongs to a PTY lifetime. An existing child keeps the value it started with. A newly created child and a restarted child sample the current preference.

Workspace tenants keep an atomic backend cell in the terminal registry. API preference writes and external config reloads refresh that cell before broadcasting `config_changed`.

Terminal-only tenants have no settings route or workspace config watcher. Their long-lived registry therefore installs a spawn-time resolver in `build_terminal_app`. The resolver reads the same `server.toml` path used by `ServerConfig::save`. A malformed or temporarily unreadable file does not block terminal creation; the registry keeps its last successfully resolved value until a later spawn can read the store again.

The terminal context menu starts with a non-interactive `Terminal engine xterm` or `Terminal engine ghostty` row and a separator. This row reads the component's post-load backend, so it reports xterm when ghostty was configured but its kit failed to load and the frontend fell back.

The Command Launcher exposes the workspace-only Terminal command `Terminal engine: <backend> (newly opened terminals only)`. It is searchable by either engine name and toggles the persisted `terminal.ghostty` preference. It does not imply that the renderer or environment of the running terminal changes.

`chan dump-skill` documents `CHAN_TERMINAL` alongside the other terminal discovery variables.

## Paste regression

The terminal clipboard chord handler now has a behavioral Cmd+V regression test which proves the browser's native paste default remains uncancelled.

The replay-origin filter was confirmed to discard complete bracketed-paste payloads because they begin with ESC. It now recognizes a complete `ESC [ 200 ~ ... ESC [ 201 ~` payload as user input while continuing to suppress terminal-generated ESC replies, including unknown replies. This fixes the demonstrated replay-origin loss without weakening the fail-closed generated-output filter. The reported macOS WKWebView Cmd+V regression was not reproducible on this Linux host and is not claimed resolved.

## Follow-up

`ghostty-web` registers a canvas `contextmenu` handler that calls neither `preventDefault()` nor `stopPropagation()`. It positions and focuses a hidden textarea at the click point to support native copy, then registers one-shot document `click` and `contextmenu` listeners to tear that textarea state down. The event still bubbles to chan's terminal container handler, but the interaction between the focus transfer and chan's context menu is unresolved. The context header is browser-verified only on the ordinary and forced-fallback xterm surfaces; the ghostty menu row is pinned at component level because the browser assertion could not be made to pass against the ghostty canvas in this environment. This product interaction remains a follow-up and is deliberately not fixed here.

## Verification

- PTY registry tests pin the public variable name, configured values, existing-child lifetime, direct create/restart refresh, and last-good fallback behavior.
- A server regression runs in an isolated child process with a temporary `CHAN_HOME`, calls `build_terminal_app` once, flips the real `server.toml`, and proves existing xterm, new ghostty, and restarted ghostty child environments without rebuilding the app.
- The server regression detects a missing builder resolver installation: the new child reports xterm instead of ghostty.
- Preference-route coverage proves the workspace registry is refreshed before a direct spawn after `broadcast_config_changed`.
- Frontend tests cover the live context-menu label and separator, launcher category/search/current value and surface scope, uncancelled Cmd+V, and bracketed-paste replay classification.
- Browser check 94 retains the workspace preference, in-terminal child environment, restart lifetime, launcher, ordinary and forced-fallback xterm context menus, real ghostty WASM, fit, key, OSC52, mouse, and xterm-restore assertions. The ghostty menu row is pinned at component level because the browser assertion could not be made to pass against the ghostty canvas in this environment. The terminal-only config-live-flip contract lives in the deterministic `build_terminal_app` Rust regression rather than a duplicate headless UI flow.
