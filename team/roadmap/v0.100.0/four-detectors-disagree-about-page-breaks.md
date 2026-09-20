# Four detectors disagree about what a page break is

Status: carried to v0.100.0. Raised for v0.99.0 by the owner, from a finding in the v0.98.0 round; v0.99.0 was the review fix loop and did not touch it. The behavior is measured against the live modules, not inferred from reading them.

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
4. `expandPageBreakMacro`, the authoring command, which accepts `@pagebreak` and `@break` and rewrites either to the canonical marker. It is caret-position sensitive, and nothing reads `@break` out of a written file.

## Why that matters

Two of the rows are user-visible defects rather than curiosities.

**A multi-class marker splits a document but not a deck.** `<hr class="chan-page-break extra">` is a page break to the browser, to the CSS, and to document PDF export, and is not a page break to slide preview, present mode, or deck PDF. The same file paginates one way as a document and another way as a deck.

**An uppercase class splits a deck but renders no page break.** `<HR CLASS="CHAN-PAGE-BREAK">` cuts in the slide surfaces because the regex is case-insensitive, while `classList.contains` and the CSS selector are case-sensitive and do not match it, so nothing about the rendered output agrees that a break is there.

This is the same shape as the empty-table-cell defect v0.98.0 fixed: several parsers for one concept, disagreeing about one source, with the editor and the export reaching different answers. That item's lesson was that the fix is to make the parsers reproduce one another, and the pin that keeps them honest is an assertion across surfaces rather than within one.

`@break` is a smaller, separate observation: it is an authoring alias that works while typing, is reserved so it does not open the contact bubble (`bubbles/triggers.ts`), and means nothing in a written file, which is a reasonable design as long as nothing writes it into a file expecting a break.

**The detectors are also blind to code fences**, a dimension the matrix above does not cover (frontend review findings ECS-01 and the page-break half of ECS-03, re-verified at `d3de0180b`). `splitSlidePages` tests every body line against `PAGE_BREAK_RE` without tracking fences, so a markdown file that documents the macro inside a fenced block splits into two slides in preview, present mode and deck PDF, with orphaned fence markers rendering as empty code blocks at the seam, and `normalizeDocPageBreaks` substitutes the marker inside the code block for document PDF. `expandPageBreakMacro` has the same hole while typing: `@pagebreak` then Space inside a fence rewrites the literal code line. `enclosingFence` in `editor/commands/fence.ts` already answers the question and neither path asks it.

## Desired contract

One definition of a page break, expressed once, that every surface consults: the source editor's divider, `splitSlidePages`, document PDF, deck PDF, present mode, and the CSS. A line is a page break if and only if every surface says it is.

Which set that definition admits was the open decision, to be made deliberately rather than inherited from whichever regex happens to be consulted:

- The narrow reading is that the canonical marker is the only page break, and everything else is a near miss that gets normalized on write. It is simple and it makes the source unambiguous, at the cost of silently ignoring an `hr` a user hand-wrote with an extra class.
- The broad reading is that any `hr` carrying the class in the DOM sense is a page break, matching what the browser and CSS already do, which requires the source-side detectors to stop being regexes over a line and start agreeing with a parsed element.

Owner ruling, 2026-09-20: the narrow reading. `<hr class="chan-page-break">` is the page break, a near miss is normalized to it on write, and `@pagebreak` stays an authoring macro that expands to it. The paragraph in `crates/chan-shell/src/help.rs` that says a literal `@pagebreak` line still splits decks and PDF export moves with the code.

Two refinements of that ruling, 2026-09-20. The marker is an `hr` whose only attribute is `class` with exactly the value `chan-page-break`, written once as one function: quote style, whitespace inside the tag and the self-closing slash are spelling HTML does not distinguish, so `<hr class='chan-page-break'/>` is the marker, while an extra class or any other attribute (`data-x="1"`) makes a near miss. And the owner ruled what happens to a near miss a user typed by hand: it is left alone and inert. chan never rewrites a line the user wrote, the near miss stays an ordinary `hr` and is a page break on no surface, which means the DOM side narrows as well (class-list membership and the `hr.chan-page-break` selector both answer yes to a multi-class element today), and "normalized on write" covers only what chan writes itself: the macro and the authoring command always write the marker.

A third refinement, 2026-09-20. A page break is a top-level block, so the marker counts only as a direct child of the document content and only on a line indented fewer than four columns: four columns of indentation is a code block whatever encloses it, and a nested `hr` carrying the class is styled and measured by nobody. The mark the document PDF measures cannot be authored either. Any `data-page-break` attribute present in the source is cleared from every element before either reader runs, so that mark is only ever placed by the walk that reads the canonical marker.

## Boundaries

`slides.ts`, `commands/page_break.ts`, `pdf_pages.ts`, and `doc_dom.ts`, plus their tests. `normalizeDocPageBreaks` already canonicalizes regex matches before document PDF measures the DOM, so it is the closest thing to a reconciliation point that exists today and is the natural place to look first.

No change to `renderMarkdown`. `web/packages/workspace-app/src/editor/pdf_export.ts` and `src/state/slidePreview.ts` are the call sites that decide which detector each surface consults, so a single shared definition is wired in there. The authoring corpus in `crates/chan-shell/src/help.rs` stays correct under the broad reading, but under the narrow one its paragraph about a literal `@pagebreak` still splitting decks and PDF export becomes false and has to move with the code. `pdf_pages.ts` is shared with [document-pdf-export-measures-before-images-load](document-pdf-export-measures-before-images-load.md), so the two are sequenced in one lane.

## Acceptance

1. Every row of the matrix above resolves to one answer per source line, consistent across all four detectors and both PDF paths.
2. Whichever reading is chosen, `<hr class="chan-page-break extra">` behaves the same in deck and document export, and `<HR CLASS="CHAN-PAGE-BREAK">` behaves the same in export as it does in the rendered document. The first currently splits a document and not a deck; the second currently splits both exports while nothing in the render agrees a break is there. Either one is enough to demonstrate a fix.
3. The v0.98.0 deck seed still opens as one slide with its instructional bullet inert, and typing `@pagebreak` on an empty line below it still produces two slides.
4. A test asserts the agreement across surfaces for the whole corpus, rather than asserting each detector separately against its own expectation, because per-detector tests are what let these four drift apart. The corpus includes a `@pagebreak` line and a canonical marker line inside a fenced code block, and no surface cuts on either.
5. Typing `@pagebreak` then Space inside a fenced code block leaves the line literal.

## Measured residuals

These inputs are measured on all four surfaces rather than predicted, and they are accepted as residuals of the narrow reading. The source scan reads a line; the renderer parses a document. Where the two disagree, closing the gap means either parsing a line's HTML instead of matching it, or tracking block containers, which is the work the markdown renderer already does, and the contract forbids changing `renderMarkdown`.

| input | deck | divider | DOM marker | document PDF |
| --- | --- | --- | --- | --- |
| `<hr` newline `class="chan-page-break">` | no | no | yes | yes |
| `<hr class="chan-page-break"> tail` | no | no | yes | yes |
| `text <hr class="chan-page-break">` | no | no | yes | yes |
| `<hr class="chan-page-break"><hr class="chan-page-break">` | no | no | yes | yes |
| `<hr class="chan-page-break" class="x">` | no | no | yes | yes |
| `<hr class="chan-page-break" onclick="x">` | no | no | yes | yes |
| `<!--` / marker / `-->` | yes | yes | no | no |
| `<div>` / marker / `</div>` | yes | yes | no | no |
| fence opener / nested fence opener / marker / fence closer | yes | yes | no | no |
| `- step`, blank line, two spaces then marker | yes | yes | no | no |

Four shapes account for all of them. Five are line shape: the source scan wants the tag alone on its line and the renderer does not care. Three are containers the source scan cannot see, an HTML comment, a raw HTML block, and a fence whose info string closes the tracker where the renderer keeps it open. One is the sanitizer: it strips an attribute it does not allow, so a near miss carrying `onclick` reaches the DOM as the canonical marker while the source says no. One is list nesting: two spaces keeps the line top-level for the source scan while the renderer takes it into the list item.

Two cases that look like they belong above do not. A marker indented two spaces under an ordered list item whose content column is four agrees on all four surfaces, because two spaces do not reach that column. A fence indented four spaces inside a list item splits nothing, because the marker line is itself indented four columns and is not a marker whatever encloses it.
