# Typing beside a bullet's marker can run right to left

Status: raised again by the owner on 2026-10-15, the day v0.106.0 shipped, with the steps that reproduce it; the record of the two bounded searches that did not find it is the closed item [typing-beside-a-bullets-marker-can-run-right-to-left](../done/typing-beside-a-bullets-marker-can-run-right-to-left.md), withdrawn at [v0.106.0](../../release/release-v0.106.0.md). Written down and read at the editor's state level (see "What was seen"); not reproduced by a seat in a browser, not designed, not accepted for build; owner the frontend seat.

Record before the release: raised by the owner on 2026-10-12 from the editor without exact steps. Two bounded searches that day, eighteen sequences and 216 keys on an item made by Enter and 48 cases and 886 keys on the typed-marker path, every key sent through Chrome's keyboard, found no reversal; closed at the v0.106.0 GA as not reproduced, the next step the owner's.

## What was seen

The owner's steps of 2026-10-15, in the owner's words:

> I figured out how to reproduce the bug with the bullet lists.
>
> When I open the editor, if I create a list with at least 2 bullet points, one on each line, I can trigger the bug by doing the following:
>
> 1. Placing the cursor on the beginning of the word in the second line
> 2. There has to be content on the line
> 3. Pressing arrow back twice, which moves the cursor to the beginning of the line
> 4. Pressing arrow forward once, to move past the bullet character, then pressing space
> 5. This will place the cursor again at the beginning of the word, but whatever you type will be from right to left, e.g. hello -> olleh
>
> We have the exact same bug on hyphenated lists, and similar bug on numbered lists except that on numbered lists the number gets separated from the dot and the characters are placed in between, which makes it a bit worse

As a key sequence, from two bullet items with text on both lines (`* one`, `* two`) and the caret at the start of `two`: ArrowLeft, ArrowLeft, ArrowRight, Space, then the letters of a word. The owner reads the caret at the start of the line after the two ArrowLefts, past the marker after the ArrowRight, and at the start of the word again after the Space; the letters then come out in reverse order, `hello` as `olleh`. The same on `-` items. On an ordered item the number and the dot come apart and the letters land between them.

What this sequence has that neither search sent: text already on the item, and a Space typed after the ArrowRight. The nearest sequences tried were `across-gap` of the first search (a new item with `abc` typed, ArrowLeft four times, ArrowRight, `hello`) and `owner-arrows` of the second (a fourth item typed and emptied by Backspace, ArrowLeft twice, ArrowRight, `hello`): no Space after the ArrowRight in either, and the second's item held no text (`evidence/Frontend106/bulrtl-plan.py` and `bulrtl-second-plan.py` in the v0.106.0 round's archive).

Read at source and run at the editor's state level on 2026-10-15, by a throwaway jsdom probe of `chanMarkdown()` with `chanDecorations()`, the arrows as `cursorCharLeft` and `cursorCharRight`, the Space and the letters as direct insertions at the selection, not kept. The editor replaces an item's marker with a widget and hides the whitespace between the marker and the text with a zero-length replace decoration (`bulletMarkerDecoration` and `decorateListHang` in `web/packages/workspace-app/src/editor/decorations/blocks.ts`), and neither range is atomic: `EditorView.atomicRanges` is registered for the wikilink, image, date, table, diagram and page-break widgets (`editor/widgets/*.ts`, `editor/commands/page_break.ts`) and not for list markers, as the editor design records for the task checkbox too (`editor/design.md`, "Atomic widgets"). So an arrow stops at every document position across the replaced ranges, and the owner's count of two is the bullet line's. On `* two` with the caret before `t` (offset 2 of the line), ArrowLeft lands at 1, between the marker and its gap, and again at 0, the line start; ArrowRight returns to 1; a Space typed there makes the line `*  two` with the caret at 2, strictly inside the hidden gap, which now covers both spaces. That position has no rendered place of its own: the view answers it with a position in the line element between its child nodes, not an offset in a text node (`view.domAtPos`), which is why the caret is drawn at the start of the word. On `2. two` the marker is two characters wide, so three ArrowLefts reach the line start and the ArrowRight after them lands between `2` and `.`; a Space there makes `2 . two`, the line stops parsing as a list item, the widget goes, and the letters land between the number and the dot (`2 hel. two` in the probe): the owner's ordered-list reading, reproduced in full at the state level. The reversal is not: with the caret inside the hidden gap, letters inserted at the selection land between the two spaces in the order typed (`* h two`, `* he two`, `* hel two`), the caret after each. What keeps the order there and loses it under the owner's hands is the browser's path for typed input, Chrome inserting the character at a caret placed in the line element beside a non-editable span and CodeMirror reading the change and the new selection back from the DOM; that path was not run for this record.

## Desired contract

Typed text goes where the caret is drawn: a caret shown at the start of an item's text puts the letters at the start of the item's text, in the order typed, with the caret after the last one. No arrow or space takes a list marker apart; an ordered item's number and dot stay together.

## What to do

Reproduce the owner's sequence first, in a guest's Chrome with real key events (the v0.106.0 searches' driver, `evidence/Frontend106/bulrtl-second-search.mjs` in the round's archive, sends keys through the browser's keyboard and reads the document and the caret after each): two items with text, the caret at the start of the second item's text, ArrowLeft twice, ArrowRight, Space, `hello`, on `*`, `-` and `1.` items, and the ordered variant with three ArrowLefts. Record the document text, the caret offset and the caret's DOM position after every key. With the reversal reproduced, read the browser path at source (the DOM change reader and the selection read-back of `@codemirror/view` beside the hidden gap) and reduce the sequence to its shortest form. Then the repair. The first candidate to weigh is registering the marker and gap replacements as atomic ranges, as the other replace widgets are, so an arrow crosses a marker in one press and the caret cannot stop inside it; it changes what a click on the glyph does (`ignoreEvent` is false so the caret lands at the boundary natively) and touches the Enter, indent and Backspace list commands that place the caret by offset, so each is read before the choice. A test at the editor's state level pins the ordered-list case and the positions the arrows reach; the reversal needs a browser check unless its cause reproduces in jsdom.

## Boundaries

`web/packages/workspace-app/src/editor/decorations/blocks.ts` and the list trigger, marker widget and list command code beside it, their tests; one browser check for the key sequence. Not changed: what a list marker looks like; the text of a list the user does not edit (no whitespace rewritten on load or on save).

## Acceptance

1. The owner's sequence run in a guest's Chrome with real key events on `*`, `-` and `1.` items, recorded with the document text and the caret offset after each key, reproducing the reversal; or, if it does not reproduce there, the same record taken on the owner's machine, where it reproduces at will.
2. A test that types a word at that position and reads it in order, red before the repair on its own assertion; a browser check if the reversal does not reproduce in jsdom.
3. The caret is after the last typed character in the same test.
4. An ordered item's number and dot stay together under the same sequence, pinned red first at the state level, where it reproduces today.
5. A click on a marker glyph, Enter at an item's end, the indent chords and Backspace at the start of an item's text behave as before: the existing tests green and one reading in the browser.
6. `make web-check` and the browser check alone are green in the owning guest.
