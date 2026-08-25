# Four detectors disagree about what a page break is

Status: raised for v0.99.0 by the owner, from a finding in the v0.98.0 round. The behavior is measured against the live modules, not inferred from reading them.

## What was seen

chan has no single answer to "is this line a page break". It has four, and they accept different sets of the same source.

The v0.98.0 deck-seed item asserted that `PAGE_BREAK_RE` "matches only a line that is entirely `<hr class="chan-page-break">` or entirely `@pagebreak`". That is narrower than the regex, which allows surrounding whitespace, either quote style, other attributes on the tag, an optional self-closing slash, and matches case-insensitively. Checking that claim is what exposed the wider problem: the regex is only one of four detectors, and the others do not agree with it.

## What was verified

Measured by loading the real modules through Vite, using the real `renderMarkdown` output in jsdom for the DOM checks, mounting a real CodeMirror view for the authoring command, and running the document PDF path through the real `normalizeDocPageBreaks`, `measureDocBlocks` and `paginateDocBlocks`. `split pages` is the count returned for a document of `before`, the fixture line, and `after`, so 2 means the fixture cut.

| Source line | `PAGE_BREAK_RE` | `isPageBreakLine` | split pages | DOM class / CSS | Document PDF cut |
| --- | --- | --- | ---: | --- | --- |
| `<hr class="chan-page-break">` | yes | yes | 2 | yes / yes | yes |
| `<hr class="chan-page-break extra">` | no | no | 1 | yes / yes | yes |
| `<hr class="extra chan-page-break">` | no | no | 1 | yes / yes | yes |
| `<HR CLASS="CHAN-PAGE-BREAK">` | yes | yes | 2 | no / no | yes |
| `<hr class="chan-page-break" data-x="1">` | yes | no | 2 | yes / yes | yes |
| `<hr class='chan-page-break'/>` | yes | yes | 2 | yes / yes | yes |
| `  @pagebreak  ` | yes | no | 2 | no / no | yes |
| `@break` | no | no | 1 | no / no | no |

The four detectors, and what each one is:

1. `PAGE_BREAK_RE` in `web/packages/workspace-app/src/editor/slides.ts`, which drives `splitSlidePages` and therefore slide preview, present mode, and deck PDF export. Its class test is quote-anchored, so the attribute value must be exactly the class, while other attributes on the tag are allowed and the whole match is case-insensitive.
2. `isPageBreakLine` in `web/packages/workspace-app/src/editor/commands/page_break.ts`, which draws the source editor's page-break divider. Stricter: it refuses any additional attribute.
3. DOM class-list membership, `classList.contains("chan-page-break")` in `pdf_pages.ts` and the `hr.chan-page-break` selector in `doc_dom.ts`. This is HTML semantics, so a multi-class element matches and the class value's case is significant.
4. `expandPageBreakMacro`, the authoring command, which accepts `@pagebreak` and `@break` and rewrites either to the canonical marker. It is caret-position sensitive and `@break` exists nowhere else.

## Why that matters

Two of the rows are user-visible defects rather than curiosities.

**A multi-class marker splits a document but not a deck.** `<hr class="chan-page-break extra">` is a page break to the browser, to the CSS, and to document PDF export, and is not a page break to slide preview, present mode, or deck PDF. The same file paginates one way as a document and another way as a deck.

**An uppercase class splits a deck but renders no page break.** `<HR CLASS="CHAN-PAGE-BREAK">` cuts in the slide surfaces because the regex is case-insensitive, while `classList.contains` and the CSS selector are case-sensitive and do not match it, so nothing about the rendered output agrees that a break is there.

This is the same shape as the empty-table-cell defect v0.98.0 fixed: several parsers for one concept, disagreeing about one source, with the editor and the export reaching different answers. That item's lesson was that the fix is to make the parsers reproduce one another, and the pin that keeps them honest is an assertion across surfaces rather than within one.

`@break` is a smaller, separate observation: it is an authoring alias that works while typing and means nothing in a written file, which is a reasonable design as long as nothing writes it into a file expecting a break.

## Desired contract

One definition of a page break, expressed once, that every surface consults: the source editor's divider, `splitSlidePages`, document PDF, deck PDF, present mode, and the CSS. A line is a page break if and only if every surface says it is.

Which set that definition admits is the open decision, and it should be made deliberately rather than inherited from whichever regex happens to be consulted:

- The narrow reading is that the canonical marker is the only page break, and everything else is a near miss that gets normalized on write. It is simple and it makes the source unambiguous, at the cost of silently ignoring an `hr` a user hand-wrote with an extra class.
- The broad reading is that any `hr` carrying the class in the DOM sense is a page break, matching what the browser and CSS already do, which requires the source-side detectors to stop being regexes over a line and start agreeing with a parsed element.

## Boundaries

`slides.ts`, `commands/page_break.ts`, `pdf_pages.ts`, and `doc_dom.ts`, plus their tests. `normalizeDocPageBreaks` already canonicalizes regex matches before document PDF measures the DOM, so it is the closest thing to a reconciliation point that exists today and is the natural place to look first.

No change to `renderMarkdown`, and none to the authoring corpus in `crates/chan-shell/src/help.rs`, which tells an agent to write the canonical `<hr>` form and remains correct under either reading.

## Acceptance

1. Every row of the matrix above resolves to one answer per source line, consistent across all four detectors and both PDF paths.
2. Whichever reading is chosen, `<hr class="chan-page-break extra">` and `<HR CLASS="CHAN-PAGE-BREAK">` behave identically in deck and document export. They currently differ in opposite directions, and either one is enough to demonstrate a fix.
3. The v0.98.0 deck seed still opens as one slide with its instructional bullet inert, and typing `@pagebreak` on an empty line below it still produces two slides.
4. A test asserts the agreement across surfaces for the whole corpus, rather than asserting each detector separately against its own expectation, because per-detector tests are what let these four drift apart.
