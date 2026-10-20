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

The Details panel: one floating card style used by every surface. The editor reserves document space beside Outline and Details, including the heading controls, following the owner's later margin decision below. The graph and file-list placement decisions remain open. Questions for the design read, each with a recommendation to be written before code:

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
2. Each surface opens the floating panel from its existing affordances. In the editor, document margins follow the open cards and their widths so text and heading controls cannot sit behind them; browser geometry checks cover both sides and editor modes. The other surfaces retain their separate layout review.
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

The remaining choices and final visual verdict are pending; subsequent owner feedback is recorded below.

## Owner feedback: floating outline resizing

The owner said: "id like the floating card outline to be able to be resizable like the details floating card".

The floating outline preview now has a resize handle on its right edge, with drag and left/right arrow-key support. The card stays within its surface, and its width is retained while switching outline modes or closing and reopening it during the preview. This records the requested resizing behavior; the remaining design choices and final visual verdict are still open.

## Owner review: slide-deck outline

The owner said: "this lgtm; now i want to see what a slide deck looks like.. produce a .md file (learn from `chan dump-skill` the chan.kind slides) and let's preview the current outline for slide decks.. i will want a few features there too".

The resizable floating-outline preview has the owner's visual approval. The next review uses a ten-slide Markdown deck in the existing application, with nested headings, a long title, a heading-free slide and repeated titles. The file follows `chan dump-skill --topic cs-export`: `chan.kind: slides`, a 16:9 aspect ratio, zoom factor 2, and explicit `<hr class="chan-page-break">` slide boundaries. Slide-outline feature requests are pending that review.

## Owner direction: floating slide thumbnails

The owner said: "i expected this one to follow the editor's one and be floating as well; where i wanted to evolve it is to include preview of each slide like google docs do", then clarified: "google slides i mean".

The slide outline follows the editor's floating, resizable card and includes a preview of every slide, in the Google Slides manner. The shared design preview now has a Slides tab with ten numbered thumbnails captured from the sample deck's actual chan renderer, selected-slide emphasis, expandable heading lists, and Preview/Present actions. A heading-free slide still has a selectable thumbnail. Clicking a thumbnail selects the corresponding slide; keyboard navigation keeps the selected thumbnail in view. This remains a design mock pending owner review and implementation in the shared application frame.

## Owner direction: one outline frame

The owner said: "and how come the outline window isn't floating like the outline on regular .md? we should use the same".

Both document types use the same floating outline frame and controls. The preview's slide-only reserved left gutter is removed, so the slide remains centred on the full surface beneath the card. The docked-outline alternative is removed from the mock; regular Markdown and slide decks now both float by default. Only the body's heading list or slide thumbnails differs.

## Owner direction: previews without captions

The owner said: "the preview lgtm, we dont need the text above/below the preview, just the deck's preview".

The slide-outline preview has visual approval with this simplification: each entry shows only its slide number and rendered preview. Removed the separate title, heading list and heading-free label. Accessible slide names and hover titles remain, along with selection, keyboard navigation, resizing and Preview/Present actions. The eight slide-preview browser checks pass.

## Owner review: scrollbar clearance and the live editor

The owner said: "need more marging on the right hand side because of potentil scrollbar showing there.. also what does the actual editor look like with this change".

The thumbnail list now reserves scrollbar space plus a 16px right inset, in both the mock and the live editor. The editor mounts Outline and Details as floating, resizable instances of the shared Inspector frame. Regular Markdown keeps its heading list; slide decks show numbered live previews from the current buffer, using the shared slide renderer, without separate captions. Selecting a slide moves to its source line; the outline follows caret and scroll and keeps the active entry visible. Preview and Present retain their existing actions.

The test server now opens the actual slide editor and the regular Markdown sample in separate tabs through `/editor-review.html`. This is the editor migration only; the five other surfaces remain docked while their design decisions and migration are pending. The frontend gate passed (8,122 tests), with 101 focused editor/outline tests and browser check 173 covering the editor behavior. The live editor's visual verdict is pending.

## Owner direction: document margins beside the floating cards

The owner said: "although the outline and details windows are now floating, the document should not use the space behind them... the marging of the document must be at the edge with the floating windows, e.g. the chevrons for the document's headers should be at the margin of the outline when the outline is present; same with the right hand side and the details window".

This supersedes the editor's earlier no-reflow behavior. Outline and Details retain floating-card styling while reserving space on their respective sides. The document and heading gutter begin after Outline and end before Details, separated by 12px. Opening, closing and resizing either card changes the available document area. Narrow panes scroll horizontally when necessary to keep the cards and the document's 200px minimum width separate. Browser check 173 now checks this contract, including source mode, both cards together and resizing; it first failed against the overlapping layout.

## Owner direction: more space between outline headings

The owner said: "gdocs has more vertical space between headings in the outline" and supplied a Google Docs screenshot. The regular Markdown outline now uses 36px heading rows, with 8px of padding above and below a 20px line box. This gives headings the looser spacing shown in the reference while retaining their indentation and active marker. Slide thumbnails keep their existing spacing.
