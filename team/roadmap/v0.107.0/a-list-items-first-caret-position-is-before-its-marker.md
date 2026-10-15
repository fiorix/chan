# A list item's first caret position is before its marker

Status: raised on 2026-10-15 from the owner's decision by survey on an open point of [typing-beside-a-bullets-marker-can-run-right-to-left](typing-beside-a-bullets-marker-can-run-right-to-left.md); the contract is the owner's (see "Owner's decision 2026-10-15"); not designed, not accepted for build; owner the frontend seat.

## What was seen

Since the list prefix repair (`2bc8a2f38`) an item's indent, marker and gap are one atomic span, so ArrowLeft from the start of the item's text lands at the line start, before the glyph, in one press, and the caret can rest there. What is typed there goes into the source in front of the marker: a Space indents the item (the owner's own sequence of ArrowLeft, ArrowLeft, ArrowRight, Space and a word now yields ` * hellotwo`, rendered as before with the source line carrying a leading space), and a letter turns the item into a paragraph (`h* two`, the raw marker shown). A click left of the glyph lands at the nearer edge of the prefix, which is the line start. The repair's row records these under "What changes" and "Open"; that row's caret filter (`web/packages/workspace-app/src/editor/decorations/list_prefix.ts`) keeps the caret off the inside of the prefix and treats both edges as resting places.

## Owner's decision 2026-10-15

Put to the owner by survey on 2026-10-15 ("Editor: can the caret rest before a list item's glyph?") with two options, the Google Docs model recommended. The owner's answer, in the survey's words: "Google Docs model: the text start is the item's first position (recommended, follow-up row)". Applied as this row.

## Desired contract

The start of an item's text is the item's first caret position. ArrowLeft from it leaves the line for the end of the line above, and on the document's first line it stays; Home goes to the text start; a click or a drag that starts left of the glyph lands at the text start; a selection reaching the item from above ends at the text start or takes the whole line, never a part of the prefix; nothing can be typed in front of a marker. The source keeps whatever indent it has: no whitespace is rewritten. The atomic prefix, Enter, Tab and Shift+Tab stay as they are; Backspace at the text start is [backspace-at-an-items-text-start-removes-its-indent-with-the-marker](backspace-at-an-items-text-start-removes-its-indent-with-the-marker.md).

## What to do

Design first, in the caret filter: the line start of a parsed item becomes a position the caret passes through and does not rest on, with the direction read as the filter reads it now (a caret arriving from the text goes on to the end of the line above; one arriving from above or from a click goes to the text start). List every path that can land there and what each does: ArrowLeft and ArrowRight, Home and End, Shift with each, a click and a drag on and left of the glyph, Ctrl+Home and a selection of the whole document, ArrowUp and ArrowDown from a longer line above or below, a restored selection, a search match at the line start, and the first line of the document where there is no line above. Name which of those keep the line start as a selection anchor (selecting whole lines must still work) and which move. Then the repair, with a state-level pin per path red first, and the owner's sequence re-read in the browser with the repair's driver (`* one` then `* two`: the two ArrowLefts now leave the item for the one above, and the word lands at its end, `* one hello`).

## Boundaries

`web/packages/workspace-app/src/editor/decorations/list_prefix.ts` and `blocks.listPrefix.test.ts`, `editor/design.md`; `editor/commands/list.ts` only if a command places the caret at the line start. Not changed: the atomic prefix and the walker; the document's text; Enter, Tab and Shift+Tab; Backspace, which has its own row.

## Acceptance

1. ArrowLeft from the text start of an item below another line lands at the end of the line above; on the document's first line it stays at the text start; pinned red first.
2. Home from inside an item's text lands at the text start, and Shift+Home selects back to the text start, pinned.
3. A click or a drag start left of the glyph lands at the text start, pinned at the state level and read once in the browser.
4. Every path the design lists is pinned with what it does, and no path leaves an empty selection at an item's line start.
5. The owner's sequence in the browser, with the repair's driver, types the word in order at the end of the item above.
6. The existing editor suites, svelte-check and the whole workspace-app suite green; `make web-check` green in the owning guest.
