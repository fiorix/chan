# ghostty is not the default terminal backend

Status: raised by the owner on 2026-10-30, after the terminal opacity item was built, with the decision made in the same words; accepted for v0.117.0; built on `v0117/terminal-opacity` the same day (the section Built); the owner's reading is pending.

## What was asked

The owner, reading the built terminal opacity on this machine: "i want to make ghostty the default terminal now, in all platforms - including for control terminals, since both ghostty and xterm.js now support the secret masking". The ghostty-web backend shipped as an opt-in (`terminal.ghostty`, false on every platform) while its secret masking was missing; v0.116.0 gave it masking (the item [secret-masking-does-nothing-under-the-ghostty-backend](../done/secret-masking-does-nothing-under-the-ghostty-backend.md)), which was the last reason to keep a window kind on xterm.js.

## Evidence

Read at `8f22c2a38`.

- `crates/chan-library/src/config.rs`: `default_terminal_ghostty` answers `false`; the field's doc comment calls ghostty an opt-in for Linux desktops whose xterm.js DOM renderer leaves a scanline unpainted at cell boundaries; two tests pin the default and the absent field to xterm.js.
- The backend is chosen once per terminal spawn from the stored preference alone: `terminalBackendFromPrefs` (`web/packages/workspace-app/src/terminal/backend.ts`) answers ghostty when the field is true and xterm.js when it is false or absent, and says itself that the window's kind plays no part since both backends mask secrets; the registry stamps `CHAN_TERMINAL` from the same value (`crates/chan-library/src/terminal_sessions.rs`). A control terminal spawns on the desktop's local terminal tenant with the same config, so no rule keeps it on xterm.js; the default alone does.
- The Settings row (`TerminalSection.svelte`) and the config reference say "off by default on every platform"; the browser checks that need xterm.js write `ghostty: false` before they spawn (93, 97, 170, 178), and the attach helper follows the stored preference.

## Desired contract

- `terminal.ghostty` defaults to true on every platform: a `server.toml` without the key, and a fresh install, spawn every new terminal on ghostty-web, standalone, workspace, devserver and control terminals alike. A stored `false` keeps xterm.js, new terminals at once and open ones when their window reloads, as before.
- A server older than the key omits it from its preferences, and the page then uses xterm.js, which such a server can still drive.
- Nothing else moves: the secret masking defaults, the fail-open fallback to xterm.js when the engine cannot load, the Settings toggle's reload note.

## Boundaries

`crates/chan-library/src/config.rs` (the default, its doc and tests), `docs/config-reference.md`, the Settings hint, the comments that named the old default (`TerminalTab.svelte`, `backend.ts`, `api/types.ts`, browser check 94). Not changed: the backend rule, the engines, the browser checks' explicit xterm.js legs, the CHANGELOG, which the release writes.

## Acceptance

1. Unit: `TerminalConfig::default().ghostty` and an absent field read true, an explicit false survives; clippy and rustdoc with warnings denied; chan-library, the chan-server config and preferences tests and the chan CLI tests green; `make web-check` green.
2. In the built desktop with a fresh `CHAN_HOME`, a control terminal's shell carries `CHAN_TERMINAL=ghostty`.
3. The whole browser suite on the host against the built binary, with the four reds known at the base and nothing new.

## Built, 2026-10-30

`default_terminal_ghostty` answers true and the field's doc says so; the tests pin the default and the absent field to ghostty and an explicit false to xterm.js. The config reference row, the Settings hint and the comments in `TerminalTab.svelte`, `backend.ts`, `api/types.ts` and browser check 94 say ghostty is the default; the backend rule itself is unchanged, so an absent field (a server older than the key) still reads as xterm.js.

Checks, 2026-10-30, Linux: `cargo fmt --check`; clippy with warnings denied for chan-library, chan-server, chan and chan-desktop; rustdoc for chan-library; chan-library 763 tests, the chan-server config, preferences and terminal tests (344) and the chan CLI tests green. In the debug desktop built from the change (`git-8f22c2a3814e-dirty`, the committed tree plus this change) launched in a fresh isolated `CHAN_HOME` with no `server.toml`, with a devserver registered with a connect script and connected: the shell of the first standalone terminal window and the control terminal's own command process both carry `CHAN_TERMINAL=ghostty`, the value the registry stamps from the stored backend at every spawn.

`make web-check` green (workspace app 610 files and 7913 tests, launcher 696, shared 234, profile 20, both production builds). The whole browser suite on the host against that debug binary and bundle (102 checks, 30 minutes): 97 passed under the new default, 90-launcher-gateways skipped, and the four reds are the four known at the base with the same lines (125-mini-window-drafts, 131-drafts-image-promote, 60-launcher-collapse and 95-launcher-native-trust), so no check that spawns a terminal without naming its backend minds ghostty. Not read: the owner's eye on macOS, FreeBSD and Windows.
