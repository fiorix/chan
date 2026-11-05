# A pane's tab strip shows over a lone tab with nothing to switch to

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: asked by the owner on 2026-11-04 and built that day in another of the owner's sessions on `feat/auto-hide-pane-strip` off `main` at `720b543c0`, with browser validation in an isolated guest and new browser checks; merged into `v0124/int` as `20899ac78`, and again as `02b140d7a` for two repairs of its browser checks' cleanup. The owner's words are not on record in this item. The drop target the hidden strip takes with it is restored by [a-pane-under-a-hidden-strip-has-nowhere-to-drop-a-tab-or-a-file](a-pane-under-a-hidden-strip-has-nowhere-to-drop-a-tab-or-a-file.md), and a way to the command launcher from a pane with no strip by [the-pane-and-terminal-menus-offer-no-way-to-the-command-launcher](the-pane-and-terminal-menus-offer-no-way-to-the-command-launcher.md).

## What was there

Every pane drew its tab strip whatever it held: an empty pane showed its welcome under an empty strip, and a lone terminal sat under a strip with one tab, a hamburger and a side toggle, as no plain terminal does. Only a tmux pane and the control terminal hid their strips, each for its own reason (`.tabs.control-hidden`).

## Desired contract

1. A global preference, `pane_strip_auto_hide`, off by default. Off is the behaviour before this item.
2. On, a pane's strip is drawn only while the side it shows holds two or more tabs: an empty pane shows its welcome with no strip, a lone tab fills the pane, and the strip returns with the second tab. The rule is judged per visible side, so with one tab on A and two on B the strip shows on B only, and a flip moves it.
3. The hidden strip takes its hamburger and side toggle with it; the keyboard and the command launcher still reach every command.
4. A side holding a Hybrid Nav staged row (the ghost tab an app-spawn chord adds, or the New draft and New diagram rows) keeps its strip while the mode is active, since the strip is the only view of what Enter will commit.
5. A standalone terminal window follows the same preference; a tmux pane and the control terminal are unaffected; a live change through Settings or `PATCH /api/config` applies without a reload.
6. The preference is reachable as `editor.pane_strip_auto_hide` (bool) through `chan config`, through `PATCH /api/config` (editor-owned), and in Settings as a Pane strip row under Global with an Auto-hide toggle.

## Boundaries

The preference plumbing mirrors `empty_pane_carousel_cycling`: `EditorPrefs`, the preferences view and patch in chan-server, the `chan config` key, the configuration reference row, the TS type and the demo data; the rule and its style in `Pane.svelte`; the Settings row in `GlobalSection.svelte`; the workspace app's design note; browser checks 200 to 202 and `lib/pane-strip.mjs`. Not changed: the tmux and control terminal strip rules, the tab model, the command catalog, chan-desktop.

## Acceptance

1. The preference defaults off and round-trips in the preferences file (`pane_strip_auto_hide_defaults_off_and_round_trips`); the route patch is editor-owned and round-trips (`pane_strip_auto_hide_patch_is_editor_owned_and_round_trips`).
2. `Pane.stripAutoHide.test.ts`: with the preference off an empty pane and a lone tab keep their strip, as does a window with no preference payload; on, the strip arrives with the second tab and leaves with it, each side is judged on its own, a tmux pane hides its strip either way, a live change reaches a mounted pane, a standalone terminal window reads the machine preference, and a staged draft row or ghost tab keeps the strip; the rule was replayed red on a mutated rule, and the two staged-row cases red without the hold.
3. Browser check 200 turns the preference on live in a workspace window and walks empty, one, two, one and off; 201 walks the per-side rule through the flip helper; 202 boots its own devserver with the preference set through the CLI and drives the minted standalone terminal window. Each restores what it changed and closes its terminals.
4. Regressions green with the preference on and off where it applies: checks 10, 15, 123, 178, 182, 195, 196, 197, 198, 199.

## Built

Four commits: `8682ef861` (the server preference and CLI key), `d6134752c` (the pane rule, the Settings row and the unit tests), `ceef3ebd1` (checks 200, 201, 202 and the shared helper), `be917f444` (a staged row keeps the strip; check 202 tears down inside its try; the configuration reference names what goes with the strip). Two more after the whole browser suite at `038d82f42` found check 203 red after 201 and green alone: 201's cleanup closed the visible side's tabs until the pane mounted no terminal, but once side B's last tab closed the next close met an empty side, which turns the pane over and closes nothing; the error was swallowed and a terminal stayed live in window `smoke-check-201`. `5d045a0a8` closes both sides' terminals and waits for the server's roster to list none of the page's window, and `bc44c56cd` fails 201 when its cleanup fails (red with the old helper on the terminal it left behind). The terminal 201 left behind also exposed [group-broadcast-cannot-be-turned-off-while-a-member-sits-in-a-window-no-page-holds](group-broadcast-cannot-be-turned-off-while-a-member-sits-in-a-window-no-page-holds.md).

Verification recorded in the commits and the branch's notes: cargo fmt, clippy for chan-server and chan, the chan-server suite and the `chan config` tests; svelte-check and vitest on the listed files; `make web-check` at the tip; checks 200, 201 and 202 green alone in an isolated guest with the regressions of acceptance 4 (195 and 198 with the preference on and off). An independent review's findings were fixed as separate commits. Checks 201 then 203 green in order with the repaired helper; checks 200 to 202 passed in the whole browser suite at `b2665def0` and in the guest packs run on the trees merged as `0226903d7` and `4a7b0bacb`.

Open: the workspace app's design note states the two-tab rule without the Hybrid Nav staged-row exception, which the configuration reference does state; the manual does not mention the preference; chan-desktop was not read with the preference on before the GA commit.
