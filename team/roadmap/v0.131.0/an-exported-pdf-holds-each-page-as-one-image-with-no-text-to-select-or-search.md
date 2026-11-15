# An exported PDF holds each page as one image, with no text to select or search

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: seen on 2026-11-13 on the owner's Mac (macOS 27.0.1, chan-desktop built from `8a44e110e`) by the agent that ran his checks, after the launcher's `Export to PDF` of a workspace draft: "the exported PDF is one page holding one raster image (1338x1996, no text layer), dark-themed" (`dev/v0129/owner/reports/parts-abc-at-8a44e110e.md`, Part C, files-5). Listed for him as a candidate (`dev/v0129/row-notes.md`, the Mac report for Parts A, B and C) and among v0.129.0's known limits (the [release record](../../release/release-v0.129.0.md)); the export has been raster since it shipped ("PDF export is raster (text not selectable)", [v0.68.0's known limitations](../../release/release-v0.68.0.md)). At v0.130.0's planning he placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`. The report names a draft; by reading, every PDF export is drawn this way.

- Every PDF export runs `exportMarkdownToPdf` (`web/packages/workspace-app/src/editor/pdf_export.ts`): the launcher's `Export to PDF` for an editor and for a file browser selection, the tree's row and the Details panel (each through `exportPathToPdf`, `state/fileActionExecutors.ts`), and `cs export` (`respondExportJob`, run in a workspace window's page). It composes each page as DOM, rasterizes it through an SVG `foreignObject` onto a canvas at `RASTER_SCALE` 2 (`editor/pdf_snapshot.ts`), and draws the PNG through pdf-lib as the page's only content, over a rectangle of the page's background for a document. A document page's image is twice the 669 px content width, the report's 1338. `editor/design.md` describes the pipeline.
- So a PDF reader finds no text in an export: nothing to search, select or copy, nothing for a screen reader, and no link opens. The comment on `RASTER_SCALE` holds the text legible at normal zoom; past that it is pixels.
- The page takes the editor's body theme (`effectiveHybridSurfaceTheme("editor")`, in `exportPathToPdf` and the `cs export` job), so a dark editor gives dark pages: the report's "dark-themed".
- The browser suite's PDF assertion (`assertPdf`, `scripts/e2e/browser-smoke/lib/pdf.mjs`), which check 30 uses, requires a raster image on every page and measures its ink. The unit tests stub the raster through the export's `rasterize` seam (`editor/pdf_export.test.ts`).

## Desired contract

1. The text of an exported page, a document's or a slide's, is text in the PDF: a PDF reader finds a word, and selects and copies a line in reading order, at the place it shows on the page, characters outside the standard PDF fonts' Latin set included.
2. Every export path gives it: the launcher, the row menu, the Details panel and `cs export`.
3. The pages look as they do today: page size, margins, pagination, images, diagrams and theme. Whether the text is drawn as text or laid invisibly over today's image is the build's choice, measured against today's export for size and time.

## Boundaries

- The PDF export engine (`editor/pdf_export.ts`, `editor/pdf_snapshot.ts`, `editor/pdf_pages.ts`) and its tests, `assertPdf` if the page image goes, `editor/design.md`, and the manual's Export to PDF section (`web/packages/marketing/src/pages/manual/editor.html`).
- Not here: links in the PDF, an outline from the headings, a tagged PDF beyond the text itself, and which theme an export takes.

## Acceptance

1. A unit test over `exportMarkdownToPdf` with its raster seam stubbed: each page of a document and of a deck carries its words as text, read back from the PDF by a text extractor; red on today's export, which draws images alone.
2. A browser check reads back, with a PDF text extractor, the text of a `cs export` of a document and of a deck: a known paragraph in order, a heading and a word with accents, each on the page that shows it; red on today's export.
3. In an sdme guest on chan-desktop for Linux, and on the owner's Mac on chan-desktop: the launcher's `Export to PDF` of a draft and of a workspace file, opened in a PDF reader (Preview on the Mac), finds a word, copies a line that pastes as typed, and looks as today's export of the same file.
4. The size and the time of an export of a long document with images, at the base and at the tip in one guest, are in the row's record.

## Rulings for v0.131.0, 2026-11-14

Withdrawn by the owner on 2026-11-14, answering the decisions document for v0.131.0 (`dev/v0131/decisions.md`, point 1): "leave just the raster, no need to add text to our generated PDFs; what I care about is that we can render our documents and slide decks as PDFs and things like images and diagrams fit well in the translation between our "pageless" editor plus the virtual page from our slide decks to a PDF with pages. Retaining the dark/light theme is also important. Having text, searcheable text, not really important. Plus Preview can already search our rastered PDFs anyway with OCR."

- Nothing of this row is built. It moves to `done/` at the release's close as withdrawn, linking the release record.
- In its place the round reads today's export once against his words: a document and a deck holding images and diagrams, exported in the light and the dark theme, in a guest, looking at how images and diagrams fit across pages and whether the theme holds. What the reading shows goes to the owner as a report; a defect it finds is a candidate for him, not scope.
- From point 13.3, for the record: the manual's export section is `manual/previews.html#export`, not the editor page.

## Pagination diagnosis and correction, 2026-11-15

The owner authorized "Diagnose, fix now if small" for the reading's nearly blank document page 5. J216 captured the real export geometry in Chrome in both themes: the explicit break ends at 2083.640625 CSS pixels, the following 1250-pixel block starts at 2105.078125, and the paginator emits that 21.4375-pixel gap as an entire PDF page. No non-break block intersects its window. The captured rectangles and unchanged production paginator reproduce all eleven original windows (`dev/v0131-team/evidence/Edit131/pdfpagination/j216-paginator-replay.json`, SHA256 `08897cafa0beec122b07852716ee834e0e87de4286c242892b73384763606e0b`). The light page is blank; the dark page has one subtle raster line. The gap's cause does not depend on that line's paint origin.

The correction keeps a break's trailing space with the next oversized block when it begins within the new page and no earlier content extends into that space. It cuts at page height, preserving a contiguous, complete partition. It does not discard pages by height or ink. Fitting blocks, real content before a tall image, ordinary rules and spacers, consecutive breaks and trailing breaks retain their behavior. The real captured fixture now yields ten windows with no gap-only window in either theme; its regression fails on the original paginator and when the new guard is disabled.

Host evidence is under `dev/v0131-team/evidence/Edit131/pdfpage5/`: the initial red isolates the actual gap in both themes; the guard mutation reproduces both failures; five PDF editor test files pass 210 tests; svelte-check reports zero errors and warnings; check 260 passes syntax checking. Check 260 consumes the document and deck fixtures in both themes, records the document's actual export windows and rejects the gap alone. Replaying that assertion against both original J216 captures rejects page 5; this replay is not a browser run. Chrome and WebKitGTK verification of the correction remains outstanding at this checkpoint.

## Automatic heading cuts, 2026-11-15

Review found the same empty-window shape when pagination pulls a heading before an oversized image: break 604.61, heading 626..676, image 698..1930. The automatic-cut rule now checks the candidate window itself for non-break content. If it holds none and a full page can reach content, the cut lands at page height from the same start; the heading stays above the image's first slice. The rule also keeps a fitting block's leading space with its first slice. Per the lead's scope ruling, explicit author breaks, their consecutive blank windows, full-page authored whitespace and the empty-document fallback retain their meaning. A pre-existing limit remains: a window can exceed the page by one inter-block gap, and the rasterizer clips only margin whitespace.

The image-marker checks distinguish the tall image's blue from the boundary image's blue with tolerance 2 for both colours. The heading input is red on the first correction, and disabling the automatic-cut invariant makes it red again. The spacer control uses a 710-pixel block. Evidence for this review fix is under `dev/v0131-team/evidence/Edit131/pdfpage5/review1/`; the guest acceptance batch is held for the corrected commit, with the earlier inputs retained.
