# Terminal secret masking

Status: VALIDATED in the terminal-secret-masking worktree; grounded 2026-08-01 in a grill-with-docs design session.

## What

Presenting a demo from a chan terminal is unsafe today: `cat ~/.config/systemd/user/chan-devserver.service`, `env`, or `cat .env` prints live credentials to the screen, and whatever is on the screen is on the recording. The need is a terminal that visually obscures the *values* of secret-looking environment variables while keeping the variable name readable and the underlying text intact.

The threat model is **visual exposure only**: screen sharing, screenshots, recordings, shoulder surfing. Explicitly not at-rest protection, not in-transit protection, not protection from the user themselves. Every boundary below follows from that sentence.

## Evidence

- `CHAN_DEVSERVER_TOKEN` is printed to the devserver supervisor's stdout, which the control terminal displays (`crates/chan/src/lib.rs:4616`) -- the project's own demo flow leaks its own credential.
- The snapshot cache already drops any serialized scrollback containing `CHAN_DEVSERVER_TOKEN=` (`web/packages/workspace-app/src/terminal/snapshotCache.ts:67-75`) -- a pre-existing stance that this credential must not linger, today enforced only at rest and only for that one name.
- The CI workflows are a real corpus of secret-shaped names the matcher must cover: `GH_TOKEN`, `GITHUB_TOKEN`, `CACHIX_AUTH_TOKEN`, `DOCKERHUB_TOKEN`, `APPLE_PASSWORD`, `APPLE_CERTIFICATE_PASSWORD`, `ES_PASSWORD`, `ES_TOTP_SECRET`, `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`, `LAUNCHPAD_GPG_PRIVATE_KEY`, `LAUNCHPAD_SSH_PRIVATE_KEY`, `AUR_SSH_PRIVATE_KEY`, `HOMEBREW_TAP_DEPLOY_KEY_BASE64`, `POSTGRES_PASSWORD`. Notably `HOMEBREW_TAP_DEPLOY_KEY_BASE64` ends in `BASE64`, not `KEY` -- a stock suffix list written from imagination misses it. These names become the test fixtures.

## Shape

**Detection.** A `NAME=value` match anywhere in terminal output. The name is `[A-Za-z_][A-Za-z0-9_]*` immediately followed by `=`; the value runs to the next whitespace, except that a value opening with `'` or `"` extends to the closing quote. The name is compared case-insensitively against a suffix list; matching is suffix-anchored (`TOKENIZE=1` must not match `TOKEN`). YAML/JSON colon forms, spaces around `=`, and multi-line values are out. The bias is deliberate over-matching: a masked `COLOR_TOKEN=red` costs nothing, an unmasked secret is the only real failure.

**Matcher.** One compiled case-insensitive `RegExp` built once per config load from the suffix list -- alternation of validated literals, not user-supplied regex. Config entries accept only `[A-Za-z0-9_]+`, which removes ReDoS and escaping bugs by construction. The scan runs on post-parse buffer lines (`buffer.active.getLine(y).translateToString()`), never on raw PTY bytes, so ANSI sequences and UTF-8 are already resolved. Only rows dirtied by the current write batch are scanned, and wrapped-line groups (`isWrapped`) are joined before matching -- a token wrapped mid-value on a narrow terminal must not leak half-masked.

**Rendering.** A solid, opaque, theme-styled overlay chip over exactly the value's cells (quotes included; name and `=` stay visible), painted with `registerMarker`/`registerDecoration` -- the proposed APIs are already unlocked for the SearchAddon at `web/packages/workspace-app/src/components/TerminalTab.svelte:895`. The buffer is never modified: selection, `getSelection()`, every copy path (`TerminalTab.svelte:1902-1939`), SerializeAddon snapshots, and server ring replay all keep cleartext, which is what "copyable as text" requires. A literal CSS blur was rejected: `backdrop-filter` compositing over the WebGL canvas can silently degrade (context loss, webview updates), and a mask that silently stops masking is the worst failure mode this feature can have. There is no hover-to-reveal; copy is the deliberate escape hatch.

**Configuration.** Two fields in `[terminal]` in `~/.chan/server.toml`, shipped to the SPA through the existing `GET /api/config` aggregate, documented in `docs/config-reference.md` in the same commit (its lockstep rule):

- `terminal.secret_masking` -- bool, default `true`. Hand-edited TOML or `PATCH /api/config` (the field rides the preferences aggregate, so the API accepts it like every other terminal pref). No Settings editing; Terminal settings shows a display-only row (effective Enabled/Disabled plus the collapsed suffix list) so the state is discoverable without opening the TOML.
- `terminal.secret_mask_suffixes` -- `Vec<String>`, literal suffixes, capped at 100 entries with clamp-and-warn (the `scrollback_mb` clamping precedent), stock default seeded from the CI corpus: `TOKEN`, `SECRET`, `PASSWORD`, `PASSPHRASE`, `API_KEY`, `ACCESS_KEY`, `SECRET_KEY`, `PRIVATE_KEY`, `SSH_KEY`, `SIGNING_KEY`, `KEY_BASE64`, `CREDENTIALS`. Bare `KEY`, `AUTH`, and `CERT` are deliberately absent: `MONKEY`, `AUTHOR`, and public certificates are not secrets, and noisy over-masking trains users to switch the feature off.

**Control.** A per-tab, session-scoped toggle in the Command Launcher and the right-click context menu, modeled on the backend toggle (`web/packages/workspace-app/src/state/commands/terminal.ts:105-116`) and the context-menu engine row (`TerminalTab.svelte:2215-2218`). The toggle is ephemeral -- never persisted, so there is no sticky global off state to forget; toggling re-scans or clears decorations in place with no respawn. When the active backend is ghostty, the toggle reports "masking unavailable on ghostty backend" instead of failing silently (the `onWorkspaceTerminal` gating pattern).

**Scope.** xterm.js backend only. ghostty-web has no decoration API; its paint path would have to ride the private `renderCellText` wrap in `web/packages/workspace-app/src/terminal/ghosttyCompat.ts:161-202`, one of the pinned upstream's load-bearing workarounds. xterm-only has precedent: the find bar, styled snapshots, and external link routing are already xterm-only. Scrollback snapshots stay byte-for-byte as today and the `CHAN_DEVSERVER_TOKEN` sweep is untouched -- a restored snapshot re-enters through `term.write`, gets scanned, and displays masked, so the visual threat is covered without touching the cache.

## Sequencing

1. `TerminalConfig` gains the two fields with serde defaults, suffix validation, and the 100-entry clamp; `docs/config-reference.md` row lands in the same commit.
2. The matcher module with the corpus-derived unit tests, including wrapped-line, quoted-value, and suffix-boundary cases.
3. The scan-and-decorate pass wired into `writePtyOutput` (`TerminalTab.svelte:1613`), keyed off the `PtyWriteTracker` origin so replay is scanned exactly once.
4. The launcher command and context-menu toggle, including the ghostty unavailable state.

## Contract

- Masking is visual only. The PTY byte stream, the server ring, the xterm buffer, selection, all copy paths, and serialized snapshots carry cleartext at all times. Server-side masking is not offered on any path.
- A matched line renders as `NAME=<opaque cells>` with the name fully readable; the overlay is opaque and cannot be read through in either renderer (WebGL or DOM).
- Copy of a masked region yields the real value. This is a requirement, not a leak.
- The feature ships enabled by default; the only off switches are the persisted config flag (hand-edited TOML or `PATCH /api/config`) and the ephemeral per-tab toggle.
- If decoration registration fails, the masker disables itself and surfaces a visible status instead of throwing into the write callback; a mask that silently stops masking must be loud to the user, not just the console.
- A second attached window masks independently; an unattached or non-SPA consumer of the stream is unaffected.
- Ghostty terminals show no masking and say so when the toggle is used.

## Acceptance

- Demo scenario: in a terminal, `cat` the devserver unit file, `env | grep -i token`, and `cat` a `.env`; every matching value renders masked, names stay readable, and selecting a masked line copies the cleartext.
- Corpus fixtures: every secret-shaped assignment name from `.github/workflows/` is masked by the stock default list; `TOKENIZE=1`, `MONKEY=1`, `AUTHOR=...`, and a public certificate line are not.
- A quoted value with spaces (`TOKEN="a b c"`) masks to the closing quote; an unquoted value stops at whitespace.
- A `NAME=value` line wrapped across rows on a narrow terminal masks the whole value, not one row of it.
- Toggle off reveals values in place; toggle on re-masks; closing or re-creating the tab returns to the config default. Reattach (snapshot prime plus ring replay) displays masked values without double decorations.
- Config: a missing field uses the stock default; an entry with regex metacharacters is refused; 101 entries clamp to 100 with one warning.
- `GET /api/config` carries both fields; `docs/config-reference.md` lists them in the same commit.
- Terminal settings shows the effective masking state and suffix list read-only, with the hint pointing at `server.toml` and the per-tab toggle.
- On a ghostty terminal the toggle surfaces the unavailable message and no decoration code runs.

## Deferred

ghostty-backend masking via the `renderCellText` wrap; YAML/JSON colon-form matching; a deliberate click-to-reveal with auto re-mask; user-defined value-shape detection (JWT, `ghp_...`, `sk-...`); at-rest protection beyond the existing single-credential sweep (an encrypted snapshot cache is its own item, not a widening of the sweep).
