# Typing beside a bullet's marker can run right to left

Status: an observation with no repair: not reproduced in two bounded searches, and it did not ship a product change; closed at [v0.106.0](../../release/release-v0.106.0.md), which records the decision.

Record before the release: raised by the owner on 2026-10-12 from the editor; written down, not reproduced, not designed. The owner gave no exact steps. Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the search named below) is accepted, and nothing past the decision it names. A first bounded search on 2026-10-12 did not reproduce it (see "Search"); a second, on the typed-marker path, follows.

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

## Search 2026-10-12

By the frontend seat in its guest, Chrome for Testing 155 against a debug `chan` and the web bundle at `549bf15cb`, with real key events and the expected document text and caret offset after every key written before the run (`evidence/Frontend106/bulrtl-plan.py`, `bulrtl-plan.json`): eighteen sequences, 216 keys, six templates applied to `*`, `-` and ordered markers, each starting from a three-item list with the caret at the last item's end and a new item made by Enter: `Enter hello`; `Enter abc Backspace x3 hello`; `Enter abc ArrowLeft x3 hello`; `Enter abc ArrowLeft x4 ArrowRight hello`; `Enter abc Backspace x2 ArrowLeft ArrowRight hello`; `Enter abc Backspace x3 ArrowLeft Backspace ArrowRight hello` (the last deleting into the marker's replaced range). Every reading equalled its expectation; every letter left the caret one past itself; no document held `olleh` or any out-of-order text (`evidence/Frontend106/bulrtl-search-1.readings.json`, `bulrtl-search-1.log`). Read at source: `blocks.ts` replaces the marker with a widget whose `ignoreEvent` returns false and supplies no cursor mapping at the boundary, so CodeMirror decides arrow and insertion mapping there; `continueListOnEnter` places the caret after the new prefix by code. The item stays open as unreproduced after this list. The lead's ruling: one more bounded list before the item is left, on the path the first did not cover, a marker typed by hand and converted by the list trigger (the owner's own words: "use '*' then space, start typing, delete, move cursor next to '*' and type"), with the caret crossing the boundary of the replaced range by arrows and by deletion.

## Second bounded search 2026-10-12

On the typed-marker path, the owner's own words: eight templates for `*`, `-` and `1.`, below an existing list and at the top of an empty document, 48 cases and 886 keys with the expected document and caret written first (`evidence/Frontend106/bulrtl-second-plan.{py,json}`), every key sent through the browser's keyboard, in Chrome 155 at `549bf15cb`'s bundle (`tasks/task-Frontend106-Lead106-7.md`): no reversal, every letter at its direct-insertion position, 48 `hello` controls and zero `olleh` with a constructed reversal found by the same query. Six caret readings differed from the plain model on ArrowUp and ArrowDown in the three top-line adjacent-item cases (CodeMirror moves to the document's start and the next line's start), with the document text and the final caret equal. Two driver attempts failed before their keys on the key chords the driver sends (`Shift+8`, `Shift+Home`), kept; the third ran whole. The item stays unreproduced after two bounded searches; a state-level test would assert an invented failure, so none is written. The next step is the owner's: a reading on his own machine and engine, raised with the survey at the cut.
