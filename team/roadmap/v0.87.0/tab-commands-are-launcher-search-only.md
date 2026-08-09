# A tab's own commands are reachable only by guessing a search string

Status: REGISTERED 2026-08-09 for v0.87.0, from a walk-through of the four surface right-click menus against the command catalog. IMPLEMENTED 2026-08-09 in `979d20d5`, owner-tested on the round build.

## What

The command launcher landed on 2026-07-04 and the surface right-click menus were trimmed against it a day later: `0110184f` for editor, terminal, graph, and pane, `41cca0c1` for the file browser. Every trimmed row was meant to survive as a launcher command, and almost all of them did. What did not survive is the ability to find them.

The contextual deck shows five rows when nothing is typed, and that cap applies inside a chosen scope too, so the Tab orb also renders five. Ordering makes it worse: entries sort by category name, and `Tabs` precedes `Editor`, `Terminal`, `Graph`, and `File Browser` alphabetically, so the generic close/next/previous rows take the visible slots and the tab's own application contributes at most one. On a markdown file, `Toggle outline`, `Toggle details`, and `Toggle style toolbar` are below the fold with nothing indicating they exist; none of the three carries a chord, and the outline and details panels each close from a button that is their only other affordance. The same holds for the terminal's `Copy path to $CWD` and `Restart terminal`, the graph's `Copy link to graph`, and roughly forty more.

Four actions did not survive the trim at all:

- `Enable/Disable Syntax Highlight` (editor). `setTabSyntaxHighlight` has no callers and is dead code, while the flag is still persisted and still honoured by Source mode, so a tab switched off in an older build can never be switched back on.
- `Reload` (graph). `GraphPanel` still holds a working reload behind the watcher path only. `app.window.reload` reloads the SPA, which is a different action.
- `Reload from Disk` (editor). The menu row returned in `bfec3b12`; the command never existed.
- `Copy path to $CWD` in a standalone terminal window, where the command is gated on a workspace root the copy does not actually need.

## Contract

- Choosing a scope in the launcher lists that scope completely. Only the root deck is a teaser.
- The Tab scope holds the tab-specific options of the current application, ordered ahead of the generic tab commands, plus those generic commands.
- An extension tab's Tab scope holds that extension's declared commands, not every other extension and every app-spawn entry.
- Every action removed from a right-click menu is reachable from somewhere. Where the equivalent command was never registered, it is registered.

## Acceptance

- With a terminal, editor, graph, file browser, or dashboard tab focused, the Tab orb renders every command that surface registers, scrolling rather than truncating, with the surface's own commands above the generic tab commands.
- An extension tab's Tab scope excludes other extensions' commands.
- A markdown file can toggle its outline, details panel, style toolbar, and syntax highlighting from the launcher, and a tab whose syntax highlighting was persisted off can turn it back on.
- A graph reloads without reloading the window.
- A standalone terminal window can copy its `$CWD`.

## Rough size

Small. Three expressions in the workspace-app launcher component, one field on `CommandContext`, four command registrations, and one `chan:command` listener in `GraphPanel`. No change to the shared command deck.

## Implemented 2026-08-09 (`979d20d5`)

Choosing a scope lists it completely; only the root deck keeps the five-row teaser, and the deck body already scrolled. Inside Tab, the active application's commands sort ahead of the generic `Tabs` commands, which plain category order buried because `Tabs` precedes `Editor`, `Terminal`, `Graph`, and `File Browser` alphabetically. An extension tab's Tab scope holds the commands that extension declares rather than every `Apps` entry, which the uncapped list would otherwise fill with other extensions and app-spawn rows.

All four unreachable actions are registered: `app.editor.syntaxHighlight` (reviving a setter that had zero callers while its flag stayed persisted and honoured), `app.graph.reload` (over the `chan:command` bridge, since the fetch lives in `GraphPanel`), `app.editor.reloadFromDisk`, and `app.terminal.copyCwd` relaxed off its workspace gate because the copy prefers the absolute cwd the PTY reports. `app.terminal.restart` drops its confirm when no live session remains to stop, since it doubles as the old `Start New Session`.

The same five-row cap in the desktop launcher SPA was hiding `Close`, the sixth owner entry in its Computers root; that deck is always inside a scope, so the teaser form never applied there.

Validation: svelte-check clean on both packages, vitest green, production build clean (+1.17 kB; the chunk-size advisory is pre-existing at 1,856 kB on the base). Four mutation probes, each failing exactly the test that claims it. One ordering test did not probe clean on the first attempt and was rewritten onto a terminal fixture, where `Tabs` sorts before `Terminal` and the rank is load-bearing.
