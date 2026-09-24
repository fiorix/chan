# Page-break line scan and renderer still differ on some inputs

Status: withdrawn by the owner on 2026-09-24, and it does not ship: the nine measured inputs stay accepted residuals, as the item itself says, because closing them means parsing HTML in the scan, which the contract kept out on purpose; revisit only if an author hits one. Raised during v0.100.0 on 2026-09-23. From the release report's residuals, recorded as measured residuals by the v0.100.0 item `four-detectors-disagree-about-page-breaks` under the owner's narrow reading. A source reading against `main` at `6237c2677`.

## What was seen

The deck and divider surfaces decide a page break by scanning a line (`isPageBreakMarkerLine`, `web/packages/workspace-app/src/editor/page_break.ts:52`), while the DOM marker and the document PDF follow the rendered document. The item's measured table lists nine inputs where they disagree: the marker split across lines, followed or preceded by text, doubled, or carrying extra attributes (renderer yes, scan no), and the marker inside an HTML comment, a `<div>` or a nested fence (scan yes, renderer no).

## What to do

Accepted as residuals under the narrow reading. Closing them means parsing a line's HTML or tracking block containers in the scan, which the contract kept out of `renderMarkdown`; revisit only if an author hits one of the nine.
