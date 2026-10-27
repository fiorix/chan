# The Command launcher opens on five commands of the active tab and hides the rest until a scope is picked

Status: shipped in [v0.113.0](../../release/release-v0.113.0.md); the sections from Decision and build evidence on hold the evidence, the owner's acceptance last.

Record before the release: accepted for v0.113.0 by the owner's word of 2026-10-27; implemented on `v0113/b-keys` and verified by the owner on 2026-10-27.

## What was seen

The owner's words of 2026-10-27: "when i first use cmd+k to open the *command launcher* on a terminal or workspace window with a terminal, it only shows a limited set of options", "only if I navigate to the pane or other section of the launcher", "then go back to the first section, tab, then i get all options for the current application (terminal, editor, graph...)", and "here's an example for the editor".

The owner's screenshots, in chan-desktop on macOS:

- Over a terminal tab, Cmd+K opens the deck on "Search" with no scope orb picked and five rows, each under the breadcrumb Tab, Terminal (the deck draws a chevron between them): Copy path to $CWD, New file or directory ($CWD), Restart terminal, Set terminal group, Set terminal name. The list ends there with nothing below it.
- With the Tab orb picked, the same five lead and the list goes on: Show/Hide Rich Prompt, Terminal engine, Terminal theme: dark, Terminal theme: light and more, scrolling.
- Over an editor tab on a draft, the root deck shows Copy path to file, Duplicate file, Editor theme: dark, Editor theme: light, New file; the Tab orb adds Present slide deck fullscreen, Preview slide deck, Reload from disk and more.

Read at `0473720de`, paths under `web/packages/workspace-app/src/`:

- `components/CommandLauncher.svelte`, `visibleEntries` (line 665): the root deck, with no scope picked and outside the Computers branch, returns `ranked.slice(0, launcherDraft.query.trim() ? 9 : 5)`. Its comment calls the root deck a teaser and says a scope orb or a Computers branch "is an explicit 'show me everything here'". A scope orb lists every entry of its scope.
- `contextualOrder` (line 276) puts Tab commands first, the active application's category ahead of the generic Tabs commands, then sorts by category and title. So the five rows are the active application's first five commands alphabetically, not a choice by use or relevance, and the deck shows no sign that more exist.
- A typed search at the root stops at nine rows across every scope, so a query that matches more commands than that hides the rest even though they are ranked.
- `components/CommandLauncher.test.ts`, "the Tab scope lists every command for the active application" (line 455), pins the root deck at five rows, with the comment "The root deck stays a teaser, so the surface's own actions were only ever reachable by guessing a search string."
- The cap has stood since the launcher landed (`b0817c61f`, 2026-08-03).

## Desired contract

Opening the Command launcher over any tab, in a workspace window or a terminal window, lists every command of the active application without picking a scope first: the terminal's, the editor's, the graph's and so on, the same commands the Tab orb lists, ahead of the pane and window commands. The deck scrolls and follows the selection as the scoped views do. A typed search lists every matching command, ranked, rather than the first nine. The scope orbs keep filtering to their scope, and the Computers branch is unchanged.

## What to do

1. Decide the root view's shape and record it here: the full contextual list in its current order (Tab, then Pane, then Window), or the launcher opening on the Tab scope. The owner's words fit either; the first keeps one list and drops nothing.
2. `components/CommandLauncher.svelte`: remove the root deck's five- and nine-row slices, or open on the Tab scope, keeping the ranking and the scope filters.
3. Tests first, red: the root deck over a terminal tab and over an editor tab lists every command of the active application (the pinned five becomes the full set), and a typed search returns every match; one mutant per guard.
4. The workspace app's design document and the manual, where they describe what the Command launcher shows on open, say what it shows now.

## Boundaries

`components/CommandLauncher.svelte` and its tests, the design document's and the manual's sentences on the launcher's first view. Not changed: the commands themselves, their ranking, the scope orbs, the Computers branch, the shortcuts.

## Acceptance

1. In chan-desktop, Cmd+K over a terminal tab lists Show/Hide Rich Prompt, Terminal engine and the terminal themes on first open, and over an editor tab lists Preview slide deck and Reload from disk, with no scope orb picked.
2. A typed search that matches more than nine commands lists them all.
3. The tests above red first and green after; `make web-check` green.

## Decision and build evidence (2026-10-27)

- Owner selected "Full contextual list (recommended)" when asked about the opening view. The root keeps the existing Tab, Pane, Window order with no scope selected, and lists all ranked search matches.
- Four tests failed before removing the slices: the full browser Tab set, terminal and editor opening lists larger than five, and twenty matching root search results. Evidence: `/tmp/lane-b-cmdtsr-red.log`.
- The implementation derives the full ranked list directly. Scope filtering, contextual ordering and Computers entries keep their existing code paths.
- The design reference and navigation and terminal manual pages describe the complete opening list and uncapped search.
- Manual screenshots `command-launcher-terminal.png` and `command-launcher-workspace.png` were left for owner review; regeneration was not requested.
- All 52 Command launcher tests pass (`/tmp/lane-b-cmdtsr-green2.log`). Restoring only the five-row cap fails the browser, terminal and editor opening-list tests; restoring only the nine-result cap fails the twenty-match search test (`/tmp/lane-b-cmdtsr-mutant-list.log`, `/tmp/lane-b-cmdtsr-mutant-search.log`). Exact source restored afterwards.

## Final verification

At code commit `2c76066b7`, `make web-check` passed. A real Chrome walk on an isolated `chan serve --standalone` server at port 19201 found 64 terminal commands and 69 editor commands on the unscoped opening view, including the requested actions, and 14 matches for `theme`. Settled screenshots were inspected, and the browser and server were torn down. Both desktop and aarch64 Linux musl builds passed; every current workspace JavaScript asset is embedded byte-for-byte. Native owner acceptance and any requested manual screenshot regeneration remain pending.

## Owner acceptance (2026-10-27)

The owner tested the isolated native preview running build `git-2c76066b747b` on macOS with the matching Linux devserver and confirmed: "i tested, it works! i tested, you can commit and push to the branch, and clean up the local use here, we need to free up space". Native acceptance is complete; the owner authorized the branch push and removal of the isolated preview and generated build artifacts.
