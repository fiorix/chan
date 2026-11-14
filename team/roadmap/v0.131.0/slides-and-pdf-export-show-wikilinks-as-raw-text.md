# Slides and PDF export show wikilinks as raw text

Status: accepted for v0.131.0 by the owner on 2026-11-14; not started.

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

Copy as HTML, link previews, the survey body renderer and inline/table rendering retain their authored wikilinks. Extending labels to those surfaces is a candidate for the owner; it is outside this row.

The initial regression run on the base failed 11 assertions, including `[[note]]` and `[[note|alias]]`; the final focused suite passes 109 tests across Markdown, the editor link parser, slide/document DOM, Copy as HTML and link preview. The final base red, 20 assertion-failing mutations, restoration hashes and restored green are under `dev/v0131-team/evidence/Edit131/wikirender/opt-in-mutations/`, with their command ledger in `host-mutations-v2.log` one directory above. The host's Node-spawn refusal was resolved with the lead-directed shell copy/restore runner. The committed-tip frontend gate and browser/PDF proof are pending; acceptance 2 is not yet established.
