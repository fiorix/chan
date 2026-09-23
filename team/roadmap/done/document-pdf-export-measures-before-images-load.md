# Document PDF export paginates before its images have loaded

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): Document PDF export measures only after every image has loaded or failed, inlines images once per export, and exports an embed as a printable link.

## What was seen

**Pagination measures zero-height images.** The render completion in `web/packages/workspace-app/src/editor/slide_dom.ts` collects a promise only for Excalidraw image sources, so for an ordinary image the completion resolves before the image has a size. `pdf_export.ts` awaits that completion and then measures block heights, so a document with images paginates as if each were zero-height: the painted page overflows the window it was cut for, content is clipped mid-image, and later blocks land on the wrong page. Nothing tells the user the PDF is wrong, and the defect is masked whenever the document also has a mermaid or Excalidraw fence, because that branch does wait. The comments in `doc_dom.ts` and `pdf_pages.ts` that describe the completion as covering images are false.

**One embed fails the whole export.** `api/markdown.ts` deliberately renders an embeddable image source (YouTube, Google Maps) as an iframe, and the disallowed-element sweep in `pdf_snapshot.ts` rejects any iframe, so one embed anywhere in a document or deck makes the export throw and the user gets no PDF at all.

**Every page re-fetches every image.** `buildDocPageElements` clones the whole document root per page and `snapshotPage` inlines resources per clone, so an N-page document with M images fetches and base64-encodes N times M, sequentially and uncached.

## Desired contract

The export measures a document only after every image in it has settled, loaded or failed, and never stalls the live preview waiting for one. An embed exports as a printable stand-in, a link with its title, and the snapshot audit stays as strict as it is. Images are inlined once per export, on the composition side and before the pages are cloned, so every clone already carries `data:` URIs and `snapshotPage` in `pdf_snapshot.ts`, which this item uses and does not change, finds nothing to fetch.

## Boundaries

`web/packages/workspace-app/src/editor/slide_dom.ts`, `doc_dom.ts`, `pdf_pages.ts`, `pdf_export.ts`, and `pdf_snapshot.ts` for usage only, plus their tests. The embed substitution belongs on the composition side, before the audit; relaxing the audit is out of scope. `pdf_pages.ts` is shared with [four-detectors-disagree-about-page-breaks](four-detectors-disagree-about-page-breaks.md), so the two are sequenced in one lane, not run in parallel.

## Acceptance

1. A test paginates a document whose images report their size late and asserts the page cuts match the cuts taken after load; an image that errors does not hang the export.
2. A document containing a YouTube embed exports, and the page carries a link where the embed was.
3. An export of an N-page document with M images performs M image fetches, asserted on a counting stub.
4. The comments in `doc_dom.ts` and `pdf_pages.ts` describe what the completion waits for.
