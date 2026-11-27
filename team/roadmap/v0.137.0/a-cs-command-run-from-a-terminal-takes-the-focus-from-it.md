# A cs command run from a terminal takes the focus from it

Status: Accepted for v0.134.0 by the owner on 2026-11-21 ("to make `cs pane split` and `cs terminal new` never move the pane focus to the new pane or tab unless --focus is used; in the current implementation we change the focus on pane splits and new terminal tabs, and i no longer want this to change focus"; "the intent with this one is to be able to script from a terminal without losing focus unless explicitly requested via --focus"). Not started. Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0. Moved to v0.137.0 by the owner on 2026-11-27 ("let's do 1-11 for v0.136, and then 12-15 to v0.137").

Record: raised by the owner on 2026-11-21, who asked for a read of the code first and for the other commands with the same side effect. The read below is of `042430e89`, by reading; nothing was run. His three answers to it are under "Decided".

## What is there now

No `cs` command has a `--focus`, `--no-focus` or `--background` flag (`crates/chan-shell/src/cli.rs`, `wire.rs`). Focus moves in the web client, in mutators the human's own actions share:

- `cs pane new` (alias `split`): `splitPane` sets `layout.activePaneId = newPane.id` (`web/packages/workspace-app/src/state/tabs.svelte.ts:5943`). The caller's terminal stops being `focused` and blurs (`components/TerminalTab.svelte:764-770`). In a window with no workspace the client also opens a terminal in the new pane, which takes the keyboard (`state/store.svelte.ts:1884`). The command prints the new pane's id.
- `cs terminal new`: `openTerminalInPane` makes the new tab its pane's active tab, sets the pane's visible side and makes that pane the focused one (`tabs.svelte.ts:1924-1926`). With no `--pane` it lands in the focused pane, so it covers the caller's terminal, and it takes the keyboard once started (`TerminalTab.svelte:1583`). It prints no id on stdout.
- `cs open` (file, directory, graph link), `cs graph` and `cs dashboard` do the same through `openInPane`, `openBrowserInPane`, `openGraphInPane` and `openDashboardInPane`. An editor pulls the keyboard with `bumpTabFocusPulse` (`tabs.svelte.ts:3832`).
- `cs terminal team new` and `load` open each member through `openTerminalInPane` and end on the lead's pane (`store.svelte.ts:2720-2750`). In tabs mode the last member hides the caller's terminal.
- `cs pane swap` makes the other pane the focused one, whichever pane held focus (`tabs.svelte.ts:5218`).
- `cs window new` raises the new terminal window (`desktop/src-tauri/src/window_ops.rs:42-53`, `raise_new_terminal_window` in `main.rs`).

These move focus because that is their purpose, or only when they close the focused thing, and stay as they are: `cs pane focus`, `cs window open`, `cs pane close`, `close-pane`, `close-tab` and `close-all`, `cs terminal close`, and the commands that ask the user and need the keyboard while they do (`cs terminal survey`, `cs session handover`, `cs upload`, `cs paste`, `cs session self`). `cs pane resize`, `equalize`, `cs terminal write`, `restart` and the read-only commands move nothing.

Every target-less placement resolves to the focused pane and its visible side when the client dequeues the frame (`cli.rs:182-196`, `tabs.svelte.ts:1287-1297`), never to the caller's own pane.

The human's actions call the same mutators, and some depend on the focus they set: `splitActive` opens its terminal in the pane the split made active (`tabs.svelte.ts:5879`), and `buildSplitGrid` learns each new pane's id from `layout.activePaneId` (`:5905`, `:5916`). The launcher's Open (`POST /api/open`, `crates/chan-server/src/routes/open.rs`) produces the same frames as `cs open`.

## Desired contract

1. A script of `cs` commands run from a focused terminal leaves keyboard focus, the focused pane, every pane's active tab and visible side, and the focused window as they were, unless a command passed `--focus`.
2. These commands take `--focus`, default off: `cs pane new` (and `split`), `cs terminal new`, `cs open`, `cs graph`, `cs dashboard`, `cs terminal team new`, `cs terminal team load`, `cs window new`.
3. Without `--focus`, a new tab joins its pane's strip behind the active tab and is not shown, in the caller's pane and in any other. A pane side with no active tab shows the new tab there, since nothing else can, without that pane taking focus: `right=$(cs pane new right); cs terminal new --pane "$right"` shows the terminal in the new pane while the keyboard stays in the caller's.
4. With `--focus`, each command does what it does today: the new tab is active, its pane is focused and it takes the keyboard. For a team, that is the lead's pane and tab.
5. `--focus` raises a window only on `cs window new`. Without it, `cs window new` does not raise the new window, as far as the platform's window manager allows. `cs window open` stays the verb that raises a window, and composes: `cs terminal new --window "$w" --focus; cs window open "$w"`. A `cs open` that has to mint a window for a path outside the workspace follows the `cs window new` rule.
6. `cs pane swap` takes no flag: focus follows the content that held it, so the caller's terminal keeps the keyboard wherever it lands.
7. The human's own actions keep focusing what they create: shortcuts, menus, the new-tab button, drag and drop, the launcher's Open and the Team Work dialog.
8. A terminal created in the background works before it is ever shown: it attaches, sizes, runs its command and takes `cs terminal write`, reports `focused: false` to its program, and paints correctly the first time the user switches to it.

## Boundaries

- Carry the flag as a top-level `focus` boolean on the frames (`OpenPath`, `OpenGraphLink`, `OpenGraph`, `OpenTermNew`, `OpenDashboard`, `TerminalTeam`, `PaneOp::Split` and their `WindowCommand` mirrors), not inside `TabDestination`, whose shape the client validates. `routes/open.rs` sets it for the launcher's Open.
- Tell the callers apart at the three client sites that apply `cs` frames (`handleWindowCommand`, `applyPaneExec`, `surfaceTeamSpawn` in `store.svelte.ts`) with an option into the mutators, whose default stays today's behaviour. Removing the focus writes from the mutators breaks `splitActive`, `buildSplitGrid` and the human Open.
- No compatibility flag or shim. The one pattern that changes meaning is a target-less command that relied on an earlier one moving focus, such as `cs pane new right` followed by `cs terminal new` with no `--pane`: its terminal now lands in the caller's pane. The help, the manual and the CHANGELOG name it, and the documented form already passes `--pane`.
- Out of this row: `cs terminal new` printing the id of what it created (it would need a round trip like `cs pane`), and changing what a target-less command resolves to.
- Related: [a survey over an unfocused pane takes Tab and its keys](../done/a-survey-over-an-unfocused-pane-takes-tab-and-its-keys.md). After this row a survey from a background agent is the common case. Whether a per-terminal survey anchored to a tab that is not its pane's visible tab can be seen before the user switches to it is not established, and this row reads it.

## Acceptance

1. A browser check on both terminal backends runs a script from a focused terminal (`pane new`, `terminal new` into the caller's pane, another pane and an empty pane, `open`, `graph`, `dashboard`, `terminal team new --tabs`, `pane swap`) and reads, after each command, `document.activeElement`, the focused pane, each pane's active tab and side. Red at the base, green at the tip.
2. The same check with `--focus` on each command reads today's result.
3. The human paths keep focusing: the split chord, the new-tab button, the launcher's Open and the Team Work dialog, by the existing checks or new legs.
4. A background terminal, on both backends: its command runs, `cs terminal write` reaches it, its program reads focus out, and its first paint is right when the user switches to it, on Chrome and in a WebKitGTK desktop driver.
5. `cs window new` with and without `--focus`, in a desktop driver on Linux, with the macOS and Windows readings named and kept distinct from it. The pending native reading of `cs window new` in [the second-launch row](../done/a-second-launch-from-a-terminal-gets-no-focus-where-the-window-manager-prevents-focus-stealing.md) is amended to this default.
6. The tests that assert today's default move to `--focus` or to the new default: `state/windowPlacement.test.ts:170` and `:301`, `state/store.test.ts:1049-1052`, check 120 (`120-cs-pane-layout.mjs:700-735`, `:975-1036`) and the premise in check 227's header.
7. Documents follow: `crates/chan-shell/src/help.rs` (`:97-111`, `:364`, `:460`, `:479-500`, `:1013-1016`, with the help width test), `manual/cs.html`, `manual/navigation.html`, `manual/terminal.html` and `.agents/orchestration/teams.md`.

## Decided

The owner's answers of 2026-11-21 to the read above:

1. A new tab in the pane the user is typing in, without `--focus`: "Open in background (Recommended)".
2. Which commands: "All creators and openers (Recommended)", with `cs pane swap` keeping focus with the caller's content, and the human's own actions, `cs pane focus`, `cs window open`, surveys and other prompts as they are.
3. `cs window new`: "No raise unless --focus (Recommended)", and on other commands `--focus` never raises a window.
