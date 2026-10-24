# A new editor tab opens with the Outline and Details closed on a wide screen

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 by the owner's word of 2026-10-21 ("one thing i asked in the previous roadmap and i think slipped and didnt get done: on non-mobile screens, new editor should always open with outline and details toggled on"); owner the frontend seat.

## What was seen

Read on 2026-10-21 at `b5b94c0dd`; paths under `web/packages/workspace-app/src/`.

A new editor tab is built with `outlineOpen: false` and `inspectorOpen: opts.inspectorOpen ?? false` (`state/tabs.svelte.ts`), so it opens with both floating cards closed on every screen. The file browser tab already opens its Details by default on a wide screen: `defaultBrowserInspectorOpen()` in the same file returns `window.innerWidth >= 768` (true with no window). The owner's ask is not recorded in the shipped floating Outline and Details item (`team/roadmap/done/the-editor-outline-and-the-details-panel-take-a-floating-design.md`) or in its seat's records, so it did not reach the build.

## Desired contract

On a screen that is not a phone's, a newly opened editor tab shows its Outline and its Details. On a phone, both stay closed. A tab restored from a saved session or a URL keeps the visibility it was saved with, and a person's toggle on a tab sticks for that tab.

## What to do

1. One width rule for "not a phone", shared with the file browser's default (`defaultBrowserInspectorOpen`'s 768px), named once rather than repeated.
2. The editor tab constructor opens both cards by that rule when the caller does not say; Details only where the window can show it (the workspace capability the tab menu already checks).
3. Read every path that creates an editor tab (open from the tree, search, the launcher, a wikilink, `cs open`, a drag across windows, a slides file, which already opens its outline once) and confirm each new tab takes the default and each restored tab keeps its saved state.
4. A component test per path that matters, red first: a new tab at 1280px opens both, at 390px neither, a restored tab keeps its saved closed state.

## Boundaries

`state/tabs.svelte.ts` (the editor tab constructor and the shared width rule), `components/FileEditorTab.svelte` only if the capability check moves, their tests. Not changed: the floating cards' layout, the reload persistence of their visibility, the file browser's own default.

## Acceptance

1. At a desktop width, a file opened from each path in step 3 shows Outline and Details; at 390px, neither.
2. A tab saved closed reopens closed after a reload.
3. The tests above red first, green after.

## Built 2026-10-21

One width rule, `wideScreen()` in `state/tabs.svelte.ts` (`WIDE_SCREEN_MIN_PX`, 768), says whether a screen is not a phone's; `defaultBrowserInspectorOpen()` returns it, so the file browser's default and the editor's are one rule. The editor tab constructor in `openInPane` opens the Outline by that rule and the Details by that rule in a workspace window (`windowCaps.workspace`, the tab menu's condition for its Details toggle) when the caller does not say; a caller that names `inspectorOpen` or `outlineOpen` keeps it. The Outline opens on a wide screen beside every file, by the owner's literal words ("always open with outline and details toggled on"), a file with no headings included, where the card reads "No headings yet".

Every path that creates an editor tab, read at the base and what each takes:

- The tree's double-click, a File Browser open, search, the launcher's Open, a wikilink or a Markdown link, a backlink, and a file dropped from the machine onto a pane: `openInActivePane` or `openInPane` with no card options, so the default.
- `cs open`: the window command `open_file` (`state/store.svelte.ts`) calls `openInPane` with `landAtTop`, so the default.
- A tab dragged in from another window: the drag payload in `components/Pane.svelte` carries the tab's `inspectorOpen` and `outlineOpen` and the receiver passes both, so the moved tab keeps the Details and the Outline it had there.
- A closed draft reopened as a fresh draft and the editors Hybrid Nav stages: new tabs through `openInPane`, so the default.
- A slide deck: the default, and a first open that names no Outline still opens it at any width (`maybeAutoOpenSlidesOutline`), since the Outline holds its Preview and Present controls; a deck moved from another window names its Outline, so one closed there stays closed.
- A tab restored from a saved session, a URL hash or the reload snapshot is rebuilt from its saved `o` and `ol` bits, not by the constructor, and a closed tab reopened from the history is the saved tab itself: each keeps the cards it was saved with.

Tests: `state/tabs.editorCards.test.ts` drives the shared open helper, `cs open`'s window command, a moved tab, a moved slide deck, a deck opened at a phone's width and a restored layout, at a desktop width, the 768px boundary and a phone's width; `components/Pane.test.ts` drags a file tab from one window's pane and drops it on another's, at a wide screen with the Outline closed and at a phone's width with it open; `state/tabs.test.ts`'s slides cases run at a phone's width, where the slides rule is the only one that opens the Outline.

Evidence paths below are under `dev/v0109-team/evidence/Frontend109/edopen/` in the round's bus; every run's blobs of the changed files equal this commit's but `Pane.test.ts` (`redgreen-2` and `gate-1` ran over the focus-colour item's earlier tip, `gate-2` over the combined tree), in the frontend seat's guest (2 CPUs).

- The pins (`redgreen-2.log`, rc 0; blobs `tabs.editorCards.test.ts` `90c9c5dca`, `Pane.test.ts` `73ffbb8cc`, `tabs.test.ts` `7b996c35e`, `tabs.svelte.ts` `4b43dbaa9`, `Pane.svelte` `5d65f2da0`, this commit's): with the three test files alone over the parent, 9 of 338 red: the opens at 1280px and 768px, `cs open` at 1280px, the Outline-only window, a moved tab at 390px, a moved slide deck, the saved layout with both cards and both cross-window drops; green with the change, 338 of 338; thirteen mutants, each red: the Outline default closed, always open, or ignoring the caller; Details without the window capability, without the width rule, or ignoring the caller; the boundary at 769px; a moved deck reopened by the slides rule; the slides rule never run; a restored tab taking the Outline default; the drag payload without `outlineOpen`; the receiver dropping it; the thirteenth, the receiver dropping the payload's Details, red at both cross-window cases once those cases hold the Details value the receiving width does not default to. `Pane.test.ts`'s two cross-window cases take the Details value the receiving width does not default to (blob `2a80282be`; the runs above had `73ffbb8cc`); with them the three test files are 9 of 338 red over the parent and 338 of 338 green at this commit, the same nine cases, and the receiver dropping the payload's Details, the payload dropping it and the receiver dropping the Outline are each red at both cases (`dev/v0109-team/evidence/Review109/hb4/run-2.log`, `run-3.log`).
- `make web-check`: exit 0 at `32c2919f7`, which holds this commit's code and tests over the focus-colour item with its pin's first seventeen cases and without the transfer id change (`gate-1.log`: svelte-check 0 errors in every package, the workspace app's 7386 tests in 581 files, the lock unchanged); exit 0 at `81e5a9cb7`, this commit's tree but this section (`gate-2.log`: svelte-check 0 errors in every package, the workspace app's 7388 tests in 582 files, the lock unchanged).
- The whole browser suite: green at `2af4cab73`, this commit's tree but this section, 93 of 93 (`browser-whole-3.log`). The run before it, at `81e5a9cb7`, was red in 20, 21, 40 and 50, each green alone (`four-tip-1.log`, `four-parent-1.log`): the focus-colour item's check 176 had left the left dock open, a defect of that check repaired in its own item (`browser-whole-2.log`, `whole-2-shots/`).

## Lead's rulings 2026-10-21

From the lead's ledger, 13:13Z: "E4 (the Outline opens beside files with no headings, "No headings yet" in a 240px card): kept as built by the owner's literal words ("always open with outline and details toggled on"), stated in the row, and put to Alex in the next batched survey as a default cheap to change; E5 (a tab dragged to another window takes the Outline default): edopen carries the Outline bit in the drag payload with a pin and a mutant, since its contract names the cross-window drag and xwmove rebases on it."

## Owner's word 2026-10-21 on the Outline beside a file with no headings

Surveyed as a default cheap to change: on a wide screen a file with no headings (a plain text file, a fresh Markdown file, most code files) opens its Outline too, as a 240px card reading "No headings yet". The answer: "A: keep as built (recommended): your words, \"always open with outline and details toggled on\"; a file with no headings shows \"No headings yet\" in the 240px card". Nothing changes.
