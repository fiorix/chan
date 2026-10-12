# A click at the end of bold or italic text lands the caret inside the marks

Status: raised by the owner on 2026-10-12 while editing a Markdown file in the editor; written down, not reproduced by a team, not designed. Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the reproduction, search or probe named below) is accepted, and nothing past the decision it names.

## What was seen

The owner's words: "Clicking on a bold or italic markdown places the cursor *inside* the block, not outside... e.g. if I want to click the "**reply:**" my cursor currently lands "**reply<here>:**" instead of "**reply:**<here>"". The file was `dev/v0106-open-questions.md`, whose lines read `**Reply:**` with the colon inside the bold marks; typing after the click therefore went into the bold run, and by the owner's example the caret was a character short of the visible end as well.

Not read at source to a cause. The editor hides inline marks in its rendered mode (`web/packages/workspace-app/src/editor/decorations/marks.ts`), and click placement passes through CodeMirror's hit test plus `editor/click_caret.ts` (which by its header acts only when the precise hit test misses) and `editor/caret_mapping.ts`. Not established: which of the two the owner saw (the caret before the last visible character, or after it and before the hidden closing marks, which look the same on screen once the marks are hidden); whether it needs the bold run to end the line; the same for italic, code and link text; whether a click in the blank space right of the line behaves differently from a click on the last glyph.

## Desired contract

A click at or past the visible end of bold, italic or other marked text puts the caret after the closing marks, so the next typed character is outside the run. A click inside the run still edits inside it.

## What to do

Reproduce in a guest's Chrome with the owner's line (`**Reply:**` ending a line, and the same mid-line), clicking on the last glyph, just right of it and in the row's blank space, and read the selection's document offset each time. Find where the offset is chosen and which side of the hidden marks it associates with. Then the repair, design to the reviewer first if it changes caret association for every hidden mark.

## Boundaries

`web/packages/workspace-app/src/editor/decorations/marks.ts`, `editor/click_caret.ts`, `editor/caret_mapping.ts` and their tests; a browser check under `scripts/e2e/browser-smoke/checks/` for the click. Not changed: keyboard caret motion through marks unless the reproduction shows the same fault there.

## Acceptance

1. The fault reproduced with document offsets for each click position, per mark kind tried.
2. A click on or right of the last glyph of a marked run lands after its closing marks, pinned by a test that is red before the repair on its own assertion, for bold and italic at least, at a line end and mid-line.
3. A click inside the run still lands inside it, pinned.
4. `make web-check` and the browser check alone are green in the owning guest.
