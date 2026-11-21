# Copy as HTML, the link preview, survey bodies and the table widget show wikilinks as typed

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); built in part and not merged: `v0132/wikiplaces` at `ccb9b1b8c`, stage 1 closed with `ci.yml` 44165859458 green and check 293's second round unread; the survey bodies' labels are the owner's question. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap").

Record before the move: accepted for v0.132.0 by the owner on 2026-11-17, by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"); not started.

Record: item 8 of `dev/v0131-team/reports/owner-candidates-1.md`, from the review of the export work (`dev/v0131-team/reviews/review-wikirender-1.md`, note 5) and the scope ruling that kept the other renderers out. [The export row](../done/slides-and-pdf-export-show-wikilinks-as-raw-text.md) made slides and PDF exports show a wikilink's label and recorded these four surfaces, and two seams, as candidates for the owner. Cosmetic.

## What is there now

Read at `b73773a93`, by reading; not run. Paths are under `web/packages/workspace-app/src/`.

- `renderMarkdown` (`api/markdown.ts:106-113`) rewrites `[[...]]` to the editor's label (the alias, or the target's name without `.md`) only with `{ wikilinks: true }`, through `renderWikiLabels` (`:37-58`), which parses the source with the editor's grammar so code and HTML keep their brackets. The slide preview (`editor/slide_dom.ts:144`) and the printable document (`editor/doc_dom.ts:127`) opt in.
- Copy as HTML (`editor/copy_html.ts:181`) calls `renderMarkdown(markdown)` with no option, so the text/html flavour it writes holds `[[note]]`; the text/plain flavour and the `data-chan-markdown` attribute hold the authored Markdown (`:1-20`). It engages only when the selection holds a workspace image (`:4-6`). Pinned by "Copy as HTML leaves wikilinks as authored" (`editor/copy_html.test.ts:33-38`).
- The link preview popover, shown for a wikilink or contact pill in a read-only context (`editor/overlays/preview_popover.ts:1-4`), renders the target file through `renderMarkdown(resp.content ?? "")` (`:153`), no option. Pinned at `editor/overlays/preview_popover.test.ts:135-144`.
- A survey body (`components/BubbleOverlay.svelte:157`) renders through `renderMarkdownWithBreaks` (`api/markdown.ts:120-127`), which has no wikilink pass.
- The editor's table widget renders each cell through `renderMarkdownInline` (`editor/widgets/table.ts:81`; `api/markdown.ts:134-137`, `marked.parseInline`), which has no wikilink pass; the editor's pill (`editor/widgets/wikilink.ts`) decorates the document, not the cells of the rendered grid.
- One test pins the three non-export renderers on the authored text: "requires an explicit export option and leaves sibling renderers alone" (`api/markdown.test.ts:11-18`). `editor/design.md:218` records it: "Other renderers, including Copy as HTML and link previews, retain authored wikilinks." The manual's previews page makes no claim; the editor page says `[[` writes `[[file]]` (`web/packages/marketing/src/pages/manual/editor.html:113`).
- One cause family: the label pass is opt-in per renderer. Two of the four places lack the option on a `renderMarkdown` call; the other two go through renderers that have no pass, where the same pre-pass over the source applies before `marked`. Outside the four places, the export work left a second seam: a wikilink inside an internal link's label, `[see [[note]]](other.md)`, exports as `see note` while the editor's pill shows `see [[note]]` (`editor/widgets/wikilink.ts:550` on, the Link branch).

## Desired contract

1. Copy as HTML's HTML body shows a wikilink as its label, as the exports do; the text/plain flavour and the `data-chan-markdown` attribute keep the authored Markdown, so a chan-to-chan paste stays lossless.
2. The link preview renders the target note's wikilinks as labels.
3. A survey body renders a wikilink as its label.
4. A cell of the editor's table widget shows a wikilink as its label, as text.
5. Everything else the four renderers draw stays as it is; inline code and fenced blocks keep their brackets, as in the exports; each output still passes through the one sanitizing chokepoint.

## Boundaries

- `api/markdown.ts` (the pass becomes the renderers' default, or each caller opts in) and the four callers, with their tests; the exports stay as they are.
- Not here unless the owner takes it: the Link-label seam in the editor's pill, and a pill, rather than text, in a table cell.

## Acceptance

1. Unit tests, red at the base: the pin at `api/markdown.test.ts:11-18` flips to labels for all three renderers; `copy_html.test.ts:33-38` flips and asserts the authored Markdown in text/plain and the attribute; `preview_popover.test.ts:135-144` flips; a `BubbleOverlay` case with `[[note|alias]]` in the body shows `alias`; a `table.test.ts` case with a `[[note]]` cell shows `note`.
2. Dropping one renderer's pass turns that place's case red and no other; restoring it turns the case green.
3. A browser check in a guest's Chrome: a note with a table cell holding `[[note]]` shows `note` in the rendered grid; a survey raised with `cs terminal survey` whose body holds `[[note|alias]]` shows `alias`; a Copy as HTML of a selection holding an image and a wikilink leaves the label in the clipboard's HTML and the brackets in its text. The table widget also in chan-desktop on WebKitGTK in the desktop guest.
4. `editor/design.md:218` says every renderer shows labels, and the manual's editor or previews page says so where it describes these surfaces.

## Accepted, 2026-11-17

The owner accepted this row by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"). The choice the draft left to him is taken as the draft recommended: labels in survey bodies (i), label text in table cells (ii); the Link-label seam (iii), for which the draft made no recommendation, stays recorded and is not built here. He may revisit it before the build. The options as drafted:

- (i) Survey bodies: labels (recommended, one rule everywhere) or as typed (an agent's prose with no file to resolve).
- (ii) Table cells: label text (recommended, small, matches the exports) or a clickable pill (needs resolution, click handling and the read-only grid's press rule; medium).
- (iii) The Link-label seam (`[see [[note]]](other.md)`): take here as a fifth contract (editor pill only) or leave recorded.
A split is not needed: one cause family, four one-place changes.
