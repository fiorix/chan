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
