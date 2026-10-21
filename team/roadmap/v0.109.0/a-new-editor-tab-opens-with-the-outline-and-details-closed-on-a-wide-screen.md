# A new editor tab opens with the Outline and Details closed on a wide screen

Status: raised for v0.109.0 by the owner's word of 2026-10-21 ("one thing i asked in the previous roadmap and i think slipped and didnt get done: on non-mobile screens, new editor should always open with outline and details toggled on"); owner the frontend seat.

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
