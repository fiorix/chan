# Typing beside a bullet's marker can run right to left

Status: raised by the owner on 2026-10-12 from the editor; written down, not reproduced, not designed. The owner gave no exact steps. Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the reproduction, search or probe named below) is accepted, and nothing past the decision it names.

## What was seen

The owner's words: "Some times when I am typing bullet points on the editor, and use '\*' then space, start typing, delete, move cursor next to '\*' and type, the typing starts going backwards.. from right to left, like '* olleh' for typing '* hello'; i dont know exactly how to repro but try to have a few bullet points and pressing enter to start a new bullet, pressing arrows to move the cursor next to the star and space then type; you should catch it by editing like a human would".

Typed text that comes out reversed means the caret stays where it was after each insertion instead of moving past the inserted character. Not read at source to a cause. The editor replaces a list item's marker with a widget (`web/packages/workspace-app/src/editor/decorations/blocks.ts`; its tests include `blocks.markerWidget.test.ts`, `blocks.list_trigger.test.ts` and `blocks.typing.test.ts`). Hypothesis, not confirmed: with the caret at the boundary between the marker's replaced range and the item's text, an insertion maps the caret to the wrong side of the inserted character. Not established: the exact sequence; whether the list must be several items long; whether the deletion empties the item first; whether it happens with `-` markers and numbered items.

## Desired contract

Text typed anywhere on a list item's line appears in the order typed, with the caret after the last typed character.

## What to do

Find the sequence first. Drive the editor in a guest's Chrome with real key events (not `page.evaluate`, which behaves differently for input), following the owner's description: a few bullets, Enter for a new one, type, delete back, arrow to the position beside the marker and its space, type a word; read the document text and the caret offset after every key. Vary the marker character and the emptiness of the item. When a sequence reverses the text, reduce it to the shortest one and make it a test at the editor's state level if the fault reproduces without a browser. Then the repair.

## Boundaries

`web/packages/workspace-app/src/editor/decorations/blocks.ts` and the list trigger and marker widget code beside it, their tests; one browser check for the key sequence. Not changed: what a list marker looks like.

## Acceptance

1. A key sequence that reverses typed text, recorded with the document text and caret offset after each key; or a statement that a bounded search did not find one, with the sequences tried and their count, in which case the item stays open as unreproduced.
2. With a sequence found: a test that types a word at that position and reads it in order, red before the repair on its own assertion.
3. The caret is after the last typed character in the same test.
4. `make web-check` and the browser check alone are green in the owning guest.
