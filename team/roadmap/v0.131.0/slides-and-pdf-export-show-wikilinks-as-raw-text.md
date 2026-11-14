# Slides and PDF export show wikilinks as raw text

Status: accepted for v0.131.0 by the owner on 2026-11-14; built on 2026-11-14 on the branch `v0131/wikirender` (`846d48cf1`), merged into the integration branch `v0131/int` (`a39237831`), not yet in a release; the section "Built, 2026-11-14" holds the evidence.

Record: found on 2026-11-14 while the manual's captures were scripted against the product (`dev/manual-refresh/handoff-int-2.md`, "A row for the next version"). The owner said it can wait for the next version.

## What is there now

Read at `e50271361`; not run.

- The slide preview (`web/packages/workspace-app/src/editor/slide_dom.ts`) and the printable document the PDF export renders (`editor/doc_dom.ts`, `content.innerHTML = renderMarkdown(opts.markdown)`) both go through `renderMarkdown` (`web/packages/workspace-app/src/api/markdown.ts`): `marked` with GFM and an image renderer for embeds, then DOMPurify. No extension there knows `[[wikilinks]]`.
- Only the editor parses wikilinks (its decorations and the wiki bubble under `editor/bubbles/wiki.ts`). So a deck or an exported note that links another note shows the brackets and the target as typed.

## Desired contract

1. A wikilink in a slide or an exported document renders as the link text the editor shows for it (the alias when one is given, else the target's name), without the brackets.
2. Everything else the two renderers draw stays as it is, and their output still goes through the one sanitizing chokepoint.

## Boundaries

- `renderMarkdown` and the two callers (`slide_dom.ts`, `doc_dom.ts`).
- Not here: whether an exported link is clickable or resolves to a file, which depends on where the PDF is read.

## Acceptance

1. Tests over `renderMarkdown` (or the slide and document DOM builders): `[[note]]` and `[[note|alias]]` render as `note` and `alias`, no brackets; red on today's code.
2. In a guest's browser: a deck and a PDF export of a note holding both forms show the link text the editor shows.

## Built, 2026-11-14

Slides and printable documents opt into the editor's literal wikilink labels in the shared Markdown renderer. The editor's Lezer grammar identifies links in the original source, and its existing body parser lives in `editor/links.ts` so the editor and exports use the same alias, basename, suffix and anchor rules. Character references in attribute-free inline spans keep aliases literal even inside surrounding Markdown emphasis. Code spans, fenced blocks, image alt text and non-wikilink syntax keep their authored text; the rendered result still passes through DOMPurify. The editor design describes the rendering contract; the manual's previews page makes no claim that wikilinks render raw.

Copy as HTML, link previews, the survey body renderer and inline/table rendering retain their authored wikilinks. Two seams remain: a GFM table cell containing `[[note]]` exports as `note`, while the editor's table widget shows `[[note]]`; an internal link label `[see [[note]]](other.md)` exports as `see note`, while the editor's pill shows `see [[note]]`. Extending labels to those surfaces and aligning these seams are candidates for the owner; they are outside this row.

The initial regression run on the base failed 11 assertions, including `[[note]]` and `[[note|alias]]`; the final focused suite passes 109 tests across Markdown, the editor link parser, slide/document DOM, Copy as HTML and link preview. The final base red, 20 assertion-failing mutations, restoration hashes and restored green are under `dev/v0131-team/evidence/Edit131/wikirender/opt-in-mutations/`, with their command ledger in `host-mutations-v2.log` one directory above. Browser check `scripts/e2e/browser-smoke/checks/260-wikirender.mjs` retains the slide and PDF assertions in the smoke suite.

The frontend own-gate (`make web-check`) passed at committed code tip `4f5138b83a02d94e7e699a235e1cc67223ce9288`: all type checks, five package suites and production builds; the workspace suite passed 10,100 tests. Its log and exit status are `dev/v0131-team/evidence/Edit131/wikirender/web-check-2.log` and `web-check-2.exit`. That gate covers the implementation; the retained browser check, image-alt comment and removal of the unused parser re-export are later changes.

Guest browser check 260 ran against base `23ee2e97b3b5d1eb50ccc78a3a4cc90cf2bda660` and the code tip, with both bundles and the binary rebuilt for each. The base returned 1: the deck kept brackets, and the note and deck PDF rasters differed from plain-label references. The tip returned 0 with no skips: editor labels and slide paragraphs were `note` and `alias`, and both PDF rasters matched their plain-label references exactly. The slide screenshots and exported note/deck page rasters were read visually at both revisions. Evidence, all four PDFs per revision, screenshots and extracted rasters are under `dev/v0131-team/evidence/Ops131/J12/`; commands and provenance are in `dev/v0131-team/followups/followup-Ops131-Edit131-1.md`. The raw PDF raster helper omits the soft alpha mask, so transparent padding appears black in its extracted note PNG; that image is evidence of label pixels, not a PDF viewer's background. No desktop, macOS, dark-theme or broader PDF-layout reading was run for this row.
