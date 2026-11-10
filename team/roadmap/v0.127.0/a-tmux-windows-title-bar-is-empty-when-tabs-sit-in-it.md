# A tmux window's title bar is empty when tabs sit in it

Status: raised by the owner on 2026-11-09 and accepted for v0.128.0 the same day; built on `feat/tmux-window-title-bar` (`7339f9640`) and moved to v0.127.0 by the owner on 2026-11-10, when it was merged into the integration branch as `9875806c1` with its review's fixes on top (`2628c9be2`: the design notes, "Empty pane" for a pane with no active tab outside Hybrid Nav, the badge's margin, a tooltip on the name and a title on the badge). The name is the pane tree's label for the active pane and follows a pane switch, a Hybrid Nav focus move and a tmux rename; a pane Hybrid Nav stages reads "New tmux pane"; name and badge are display only and drag the window. Acceptance 1 holds by mounted tests, each shown red before the code; for acceptance 2 the badge is black with white text (21:1), and in the dark theme its edge against the bar is about 1.3:1, which the review accepted since the badge's meaning is its text; acceptance 3, chan-desktop on macOS and Windows, is the owner's.

## What is there now

A `tmux -CC` window is one chan window per tmux window, one chan pane per tmux pane, each pane holding exactly one terminal tab marked with its tmux pane (`tmuxPane` on the tab, `web/packages/workspace-app/src/state/tabs.svelte.ts:509-513`, applied from the server's `tmux_layout` command through `reconcileLayout`, `state/store.svelte.ts:2292-2297`). tmux has no tabs, so each tmux pane's tab strip is hidden (`tmuxPaneHere` adds `control-hidden`, `components/Pane.svelte:206-213`, `:1506`, `:2443-2445`), and a tmux window has no A and B sides (`panesHaveSides()` is false, `tabs.svelte.ts:2635-2640`).

With tabs in the title bar (Settings, Global, "Title bar tabs", v0.126.0; macOS and Windows only, `state/windowTabBar.svelte.ts:48-52`), the bar (`components/WindowTabBar.svelte`) draws no tabs of its own: the active pane's strip is moved into its slot (`Pane.svelte:647-651`, `:1512`). In a tmux window that strip is hidden, so the bar shows only the pane-tree button and empty drag space; a test asserts exactly that ("a tmux pane leaves the bar with no strip to show", `components/Pane.windowTabBar.test.ts:240-248`). Nothing in the bar says which tmux window this is, or that it is tmux at all.

The name the pane tree (Cmd+Shift+A, "Show panes and tabs", `state/shortcuts.ts:241-255`) shows for a tmux pane is the tab's title (`terminalTabName`, `tabs.svelte.ts:971-973`), which the server sets to the tmux window's name (`#{window_name}`, `crates/chan-tmux/src/command.rs:25`), updated on a tmux rename and made unique across the session registry (`name-2`; `Terminal-N` for an unnamed window, `crates/chan-library/src/terminal_sessions.rs:2517-2526`). In the other windows the A/B toggle (`.side-toggle`, `Pane.svelte:1794-1806`) sits at the right end of the strip, before the pane menu.

## Desired contract

1. With tabs in the title bar, a tmux window's bar shows the active tmux pane's name, the same text the pane tree shows for it, where the tab strip would be. It follows the active pane and a tmux rename at once.
2. The bar's right end carries a `TMUX` badge, black with "tmux" in white, in both themes, where the A/B toggle sits in a window that has sides (a tmux window has none), and before the pane menu if one shows.
3. The name and the badge are display only: the bar's empty space stays a drag region, and nothing in it reopens a hidden strip or offers tab actions tmux cannot do.
4. Windows without tmux, and tmux windows with tabs below the title bar, are unchanged.

## Boundaries

- macOS and Windows, where title bar tabs exist; Linux keeps its plain bar.
- No tmux pane titles (`#{pane_title}`) or session names; the name is the one the pane tree already shows.

## Acceptance

1. Mounted tests over `WindowTabBar` and a tmux window: the bar shows the active pane's name and the badge, follows a change of active pane and a rename, and the existing "no strip to show" test is updated to the new contract; a non-tmux window's bar is unchanged.
2. The badge's colours checked in both themes (black background, white text, its contrast stated).
3. On chan-desktop on macOS and on Windows (owner): a `tmux -CC` window with tabs in the title bar shows the window name and the badge, and the window still drags from the bar.
