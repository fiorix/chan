# The editor outline and the Details panel take a floating design

Status: raised for v0.108.0 by the owner's word of 2026-10-20 ("we'll need a test server to review the editor UI: i want to improve the looks of the outline to look more like google docs, i want the details menu to become a floating menu - this will impact all surfaces where we have the details menu, which is many: dashboard, file browser, graph to name a few off the top of my head"); owner the frontend seat.

## What is asked

1. The editor outline looks more like Google Docs' document outline.
2. The Details panel becomes a floating panel on every surface that has one.
3. A test server on which the owner reviews both before they ship.

## What is there

Read 2026-10-20 at `4e9a68c8c`; paths under `web/packages/workspace-app/src/`.

The outline is `components/OutlineBody.svelte` inside the shared frame `components/Inspector.svelte` (`side="left"`, title "Outline"), docked left in the editor's flex row (`components/FileEditorTab.svelte`). It lists ATX headings with one 1px guide line on the left, depth shown by indent only, the active heading (the last at or above the caret) marked by a 2px link-coloured bar and weight 500. It follows the caret only: no scroll-spy, and the active row is not scrolled into view. Width per tab, 140 to 600, default 220. Opened by the launcher command "Toggle outline" (no chord, no menu entry) and once automatically for a slides file. Tests cover parsing only; no browser check covers it.

"Details" is the screen name; the code calls it the inspector (`Inspector.svelte` frame, `InspectorBody.svelte` dispatcher, `FileInfoBody`, `TagInfoBody`, `LanguageInfoBody`, `WorkspaceInfoBody`, `DraftInfoBody`). Every surface docks it as a resizable flex sibling, not an overlay, each with its own open flag and width slot:

| Surface | Component | Side, width | Opens |
| --- | --- | --- | --- |
| Editor | `FileEditorTab` | right, 220 | "Toggle details" |
| File browser | `FileBrowserSurface` | right, 240 | default; selection |
| Search | `SearchPanel` | right, 280 | selection; menu |
| Graph | `GraphPanel` | right, 260 | node or scope |
| Terminal | `TerminalTab` | right, 280 | tab menu |
| Dashboard | `EmptyPaneCarousel` | own, 320 | indexing view |

Widths are per tab in the editor, file browser and graph, shared in search, and not persisted in the terminal (the program status inspector). The file browser tab opens it by default at 768px and wider. The dashboard hand-rolls its own chrome with no resize for the indexing inspector, and its Workspace slot inlines a body.

"Open Inspector" also names the webview developer tools (`Pane.svelte`, `state/commands/global.ts`); the rework is a moment to settle the name. Layout pins today: per-tab width tests (`FileEditorTab.test.ts`, `FileBrowserSurface.inspectorWidth.test.ts`, `GraphPanel.inspector.test.ts`, `state/cloneTabFields.test.ts`) and browser checks `22-cs-open-audio.mjs` and `111-graph-palette.mjs` that read `.inspector.right`.

## Desired contract (to settle in the design read)

The outline: a quiet list in the Google Docs manner (headings in the body face, depth by indent and size or weight, the current section marked, the list kept in view as the document scrolls), with the active heading following the scroll as well as the caret. The owner judges the look on the test server.

The Details panel: one floating panel used by every surface, over the content rather than beside it, so opening it does not reflow the editor, the graph or the file list. Questions for the design read, each with a recommendation to be written before code:

1. Anchor: floating at the surface's right edge with a margin and a shadow (recommended), or anchored to the selection it describes.
2. Size: keep per-surface width and add a height bound with its own scroll, or one fixed width.
3. Dismissal: close button and Escape; does a click outside close it (not for the file browser, where a click selects).
4. Whether the outline floats too, or stays docked left and only changes its look.
5. The dashboard: move its indexing inspector onto the shared frame.
6. The name: "Details" in code as well as on screen, leaving "Inspector" to the developer tools.

## Test server

Per `.agents/skills/test-server/SKILL.md`, a server from the build's branch over a workspace with a long heading-rich document, a slides file, a populated graph and a file tree, where the owner opens the outline and Details on each surface in the table, in light and dark themes and at a narrow width. A first server can serve design mocks of the outline and the floating panel before the build, so the look is chosen before the six surfaces move.

## Boundaries

`components/Inspector.svelte`, `OutlineBody.svelte`, the surfaces in the table as far as how they mount the panel, `state/` for any changed open or width state, their tests and browser checks, `src/design.md` (which has no section on the panel's layout today; add one). Not changed: the bodies' content and actions.

## Acceptance

1. The design recorded here with the owner's choices on the questions above, from mocks on the test server.
2. Each surface opens the floating panel from its existing affordances; opening it does not change the content's width (a test per surface, red first against the docked layout).
3. The outline's active heading follows scroll and caret, pinned in a test; the row stays in view.
4. A browser check opening Details on each surface and the outline in the editor.
5. The owner's verdict from the test server recorded here.

## Proposed choices for the first design preview

These are recommendations for the owner to compare in the preview, not accepted decisions. The preview uses representative content; the application and its body actions remain unchanged until the owner chooses the contract.

1. Anchor: recommend the surface right edge with a 12px inset and a restrained shadow. Selection anchoring puts context closer to its subject but moves the panel as selection changes and needs collision handling.
2. Size: recommend retaining each surface's current resizable width, bounded by the surface, with the panel scrolling internally. One fixed 280px width is more uniform but discards the user's per-tab sizing.
3. Dismissal: recommend the close button and Escape while the panel has focus, without click-away dismissal. Click-away can be offered outside the file browser, but makes editor selection and graph navigation close useful context. Escape must respect nested menus and preserve the editor's existing Escape behavior.
4. Outline: recommend a quiet docked list with no separator, document typography, indentation and a rounded active marker. A floating outline saves content width but covers text in narrow panes. Both are available in the preview.
5. Dashboard: recommend moving the indexing Details panel onto the shared frame, so all six surfaces have the same placement, dismissal and sizing. Keeping custom chrome avoids that migration but leaves a separate behavior to maintain.
6. Name: recommend retaining Inspector as the internal component name for this layout change, with Details everywhere on screen. Renaming code to Details improves terminology but widens the change; any developer-tools wording change in Pane.svelte must be handed to the merge agent under the coordination map.

The owner has not yet selected these choices or reviewed the preview.
