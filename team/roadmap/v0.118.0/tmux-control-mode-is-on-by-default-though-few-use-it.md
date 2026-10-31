# tmux control mode is on by default though few use it

Status: landed in `0.118.0-ga` on 2026-10-31 (merge `89f2cb007`; the section Built), accepted for v0.118.0 by the owner's words of 2026-10-31 and built the same day on `v0118/tmux-default-off`; the row closes at the GA.

## What was asked

The owner's words of 2026-10-31, after the tmux feed and extension drag rows landed in `0.118.0-ga`: "one thing id like to make is to turn off the tmux CC support by default, because not many people actually use it.. if users want, they can turn it on, the default in chan's terminal should be off".

## Evidence

Read at `a0501366f` (`0.118.0-ga`). The switch is `terminal.tmux.enabled` (`TerminalTmuxConfig` in `crates/chan-library/src/config.rs`), serde-defaulted through `default_terminal_tmux_enabled`, which returns true, so a `server.toml` with no `[terminal.tmux]` table, or a table with no `enabled` key, honors the marker. Every terminal session's gate is armed from it (`tmux_gate.rs`, `client.arm(policy.enabled)`), so a `tmux -CC` run under any foreground program raises the consent banner over the terminal, and a local `tmux` enters at once. The default is stated in six places: the field's doc comment, the config reference (`docs/config-reference.md`), the manual's terminal and settings pages, the workspace app's design note on the Settings switch, the chan-library design note on the gate, and the Settings switch itself, which reads an absent table as on (`TerminalSection.svelte`, `?? true`). Tests pin it in the library's `config.rs`, the `chan config` key reads (`crates/chan/src/config.rs`), the preferences route (`preferences.rs`) and the Settings switch test (`TerminalSection.tmux.test.ts`); the library's test session constructor builds its gate from the default, so the gate and connection tests ride on it too. Browser check 195 and the desktop-observation tmux scenarios (`tmux-feed.sh`, `tmux-feed.mjs`, `gateway-zone.sh tmuxfeed`) rely on the default: none of their disposable homes sets the switch.

## Desired contract

`terminal.tmux.enabled` defaults to false. With no stored value a terminal treats the marker `tmux -CC` prints as ordinary bytes and asks nothing, in every window kind and on every platform; the Settings switch reads off, and turning it on (Settings → Terminal → tmux control mode, or `chan config set terminal.tmux.enabled true`) arms the gate for new markers in every live terminal as today. A stored `enabled = true` or `false` is honored as before, and `terminal.tmux.trust` is unchanged. The manual, the config reference and the design notes say off by default. The tmux checks and scenarios turn the switch on in their own homes, so they test the feature and not the default.

## Boundaries

The default function and its tests in chan-library, with the test session constructor made explicit; the `chan config` and preferences tests that read the default; the Settings switch's absent-table reading and its test; the six documents; the e2e fixtures that need the switch on. No change to the gate, the connection, the card or the wire.

## Acceptance

1. `TerminalConfig::default().tmux.enabled` is false; a `server.toml` without the table or without the key reads off; `enabled = true` reads on; `chan config get terminal.tmux.enabled` prints false on a fresh home.
2. The Settings switch shows off for a server without the table and writes `enabled: true` when toggled.
3. The library, chan, chan-server and workspace-app suites that pin the switch are green with the flipped expectations, and the tmux gate and connection tests still run with the marker honored.
4. Browser check 195 and the tmux desktop-observation scenarios set the switch in their homes. Check 195 belongs to the `tmuxbrw` row and is not run here; the scenarios are owner-run and not run here either, so their change is read, not run.

## Built, 2026-10-31

Built on `v0118/tmux-default-off` off `0.118.0-ga` at `a0501366f`. `default_terminal_tmux_enabled` returns false, with the why beside it; the field's doc comment, the config reference, the manual's terminal and settings pages, the chan-library design note and the workspace app's design note say off by default; the Settings switch reads an absent table as off (`TerminalSection.svelte`) and its test expects off for a server without the table and a write of `enabled: true` on the first toggle. The flipped pins: the library's `tmux_is_off_with_no_trust_unless_the_config_says_otherwise`, the `chan config` key test, the preferences route's write test and the server config round-trip fixture (now `enabled: true`, so it stays a non-default value). The library's test session constructor builds its gate with `enabled: true` in so many words, so the gate, connection and pane tests keep running with the marker honored. Browser check 195 writes the switch into its devserver's home with `chan config set` before the spawn; `tmux-feed.mjs` does the same for its direct devserver, `tmux-feed.sh` for the desktop's own home, and `gateway-zone.sh tmuxfeed` for the `home-tmux` devserver before `spawn_devserver`.

Evidence, in the branch's worktree (`dev/tmux-default/checks/`): `cargo fmt`; `cargo clippy --all-targets -D warnings` on chan-library, chan-server and chan; the whole chan-library suite, 841 passed; `cargo test -p chan --lib -- config_tmux` and `cargo test -p chan-server --lib -- tmux config`, 106 passed, the preferences write test among them; `make shell-check` over the 96 tracked scripts; `node --check` on the two drivers; `make web-check` in the worktree (`make -C`, so the run is the worktree's and not the main checkout's): svelte-check clean, vitest 234, 721, 7,972 and 20 passed across web-shared, the launcher, the workspace app and profile, the production build green, the flipped Settings switch test among them. Acceptance 1 and 2 are pinned by those tests; acceptance 3 is the runs above; acceptance 4 is read, not run: check 195 belongs to the `tmuxbrw` row, and the desktop-observation scenarios are owner-run. A first `make web-check` ran in the main checkout by a dropped `cd` and reported main's counts (720 and 7,971); it is not evidence for this change and the run named above replaced it.
