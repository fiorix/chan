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
