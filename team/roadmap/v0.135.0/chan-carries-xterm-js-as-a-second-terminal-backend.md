# chan carries xterm.js as a second terminal backend

Status: in progress, on `v0134/ghostty-ng-int` at `518ac933d`, not merged into `v0134/int`. Contract items 2 to 6 are built and acceptance 1 is met (below). Items 1 and 7 are open: a failed load still falls back to an unlabelled xterm.js terminal, and `@xterm/*` is still a runtime dependency. Accepted for v0.134.0 by the owner on 2026-11-23 with the Ghostty-only plan (`dev/team-ghostty-web-ng-plan.md`, as amended by its review `dev/team-ghostty-web-ng-plan-review.md`). Split out of [the migration row](chan-drives-ghostty-web-from-outside-through-its-private-internals.md), whose boundary kept xterm.js as a second backend "a separate decision", so that this part can close while the migration's input modernization carries. Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

## What is there now

Read at `f5657caab`, by reading; not run.

- Ghostty is the default backend on every platform. A terminal is xterm.js when the preference `terminal.ghostty` is `false`, and also when the field is absent from what the page reads (`web/packages/workspace-app/src/terminal/backend.ts`).
- The setting has three spellings: `[terminal] ghostty = <bool>` in `server.toml`, `terminal.ghostty` in preferences, and `server.terminal.ghostty` in `chan config`. `save_toml` (`crates/chan-server/src/store.rs`) serializes the whole struct and the field has no `skip_serializing_if` (`crates/chan-library/src/config.rs`), so any install that ever saved a server-owned setting has `ghostty = true` in its file.
- The server tracks the choice to set `CHAN_TERMINAL` through `TerminalBackendResolver` and `terminal_ghostty`.
- Six `@xterm/*` packages at xterm.js 6.0.0, their Vite source aliases, CSS, the five addons, `secretMaskingXterm`, a snapshot capture/restore path, desktop renderer signaling and both Nix `npmDeps.hash` pins exist for the second backend. Two parity tests (`terminal/xtermKeyboard.test.ts`, `terminal/keyboardProtocolStream.test.ts`) load xterm.js's own evaluator and parser as the oracle of chan's ported keyboard code, which Ghostty uses in production (`terminal/ghosttyKeys.ts`).

## Desired contract

1. Every terminal, in every window type, new, restored or reconnected, is Ghostty. No runtime fallback constructs another terminal; a load failure shows a terminal-local error with retry or reload, leaving the app and any live PTY intact.
2. The setting is gone from Settings, its search index, help and default listings and the typed runtime configuration.
3. For one warning period: a stored `false` in `server.toml` warns once per process that the key is deprecated, has no effect, should be removed and will be rejected later; a stored `true`, the value chan wrote itself, is silent and is dropped at the next save, as the retired `attachments_dir` is (`crates/chan-server/src/config.rs`). Loading never rewrites the file; a normal save omits the key and keeps every unrelated setting. A non-boolean stays a type error.
4. The preferences API accepts a boolean `ghostty` in a terminal patch and ignores it, the type still checked, with no warning; no response field is added for an older page. A tab left open across the upgrade keeps the xterm.js in its own bundle until it reloads.
5. `chan config set server.terminal.ghostty true|false` succeeds as a deprecated no-op with a warning on stderr and no write; `get` returns `true` with the same warning; listings omit the key. This departs on purpose from the retired-key precedent, which rejects at once, because the owner asked for a warning period.
6. `CHAN_TERMINAL=ghostty` is set on every spawn path for new and restarted sessions; a live PTY keeps its environment until it restarts.
7. No `@xterm/*` package is a runtime dependency and none is emitted; the one exception is `@xterm/xterm` as a development dependency for the two parity tests, until the migration row's input modernization is accepted, when their reference is recorded and it is deleted. Protocol names (`TERM=xterm-256color`, modifyOtherKeys) and upstream notices stay.

## Boundaries

- The workspace app's terminal loader, `TerminalTab.svelte`, the xterm-only adapters and addons, the config and preferences boundaries in `crates/chan-library` and `crates/chan-server`, the CLI's `config` command, the spawn environment, desktop renderer signaling with no caller left, manifests, lock, Nix npm pins, docs and manuals.
- Not here: the later rejection of the key ([its row](the-retired-terminal-ghostty-key-is-accepted-with-a-warning.md)); new client snapshot persistence; ANSI-rich Ghostty copy; the nonterminal `components/webglRenderer.ts` and general WebKit compositor workarounds, which stay.

## Acceptance

1. File, API and CLI tests for absent, `true` and `false`: the warning only on a stored `false` and once per process, no file rewrite on load, unrelated fields kept on save, the key omitted on save, a malformed type refused, the API ignoring a typed boolean, the CLI's set and get as above.
2. Loader fault injections (fetch, compile, instantiate failures; close and restart while loading; retry after a transient error) leave the app usable, the PTY unduplicated and no leaked instance.
3. A production build emits one wasm and no xterm asset; no runtime import, alias or CSS of `@xterm/*` remains.
4. The terminal browser suite runs Ghostty only in a guest, with every check that asked for xterm converted or failing loudly; the scoped gate, the Nix hash check and CI on the tip are green.

## Built, 2026-11-23: the key retired, Ghostty unconditional

On `v0134/ghostty-ng-int` at `518ac933d`; by test, and by the browser suite in a guest.

- Every terminal opens on Ghostty; nothing reads the preference. Settings, help and listings no longer show the key.
- `server.toml`: a stored `false` warns once per process, `true` and absent are silent, loading never rewrites the file, a save omits the key. The preferences API accepts and ignores a boolean `ghostty`, a non-boolean refused with 422. `chan config set` is a no-op with a warning on stderr, `get` prints `true` with the warning, listings omit the key. Pinned by unit tests at each boundary with their mutants, and end to end by browser check 341 (set, get, listing and the warning count; red at `f5657caab`). Its refusal arm asserts the key in the response body, which the server keeps generic by design; the corrected arm (its own server with the extractor's debug log) is on `v0134/ghostty-ng-input-m3`, not merged here.
- `chan config` now returns a failed stdout write as an error, exit 1, where it panicked with 101: a line for the release notes.
- `CHAN_TERMINAL=ghostty` on every spawn path.
- Open: the load-failure error UI and its fault tests (acceptance 2); the runtime removal of `@xterm/*`, its addons, aliases, CSS and the fallback (acceptance 3); 40 app test files still on a test-only xterm stand-in route, which must reach 0 before the removal; the desktop drivers, read not run since their port.

