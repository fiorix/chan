# Backspace at an item's text start removes its indent with the marker

Status: raised on 2026-10-15 from the owner's decision by survey on an open point of [typing-beside-a-bullets-marker-can-run-right-to-left](typing-beside-a-bullets-marker-can-run-right-to-left.md); the contract is the owner's (see "Owner's decision 2026-10-15"); not designed, not accepted for build; owner the frontend seat.

## What was seen

Since the list prefix repair (`2bc8a2f38`) an item's indent, marker and gap are one atomic span, and `deleteCharBackward` removes an atomic span whole: Backspace at the start of an item's text turns `* two` into the paragraph `two` in one press, and turns a nested `  * two` into `two` at column 0, which markdown reads as a lazy continuation of the item above. Before the repair one press removed one hidden character, leaving a raw `*two` on screen. `web/packages/workspace-app/src/editor/commands/list.ts` has no Backspace handling of its own; the pin in `editor/decorations/blocks.test.ts` records the one-press contract for a top-level item, a hidden non-breaking space included.

## Owner's decision 2026-10-15

Put to the owner by survey on 2026-10-15 ("Editor: Backspace at the start of a list item's text") with three options, outdent-first recommended. The owner's answer, in the survey's words: "Outdent first on a nested item; a top-level item becomes a paragraph (recommended, follow-up row)". Applied as this row.

## Desired contract

Backspace with an empty selection at the start of a nested item's text moves the item one level out, marker and text kept and an ordered item renumbered as the outdent command renumbers it; at a top-level item it removes the marker and the gap and leaves the text as a paragraph, in one press, as now. Delete at the line start and Backspace anywhere else are unchanged.

## What to do

A Backspace binding in `commands/list.ts` ahead of the default, taking its branch only with an empty selection at the text start of a parsed item (the prefix geometry the caret filter reads, `listPrefixSpans`): a nested item runs the outdent transformation the Shift+Tab command applies to that item; a top-level item falls through to the default, which removes the atomic prefix. Decide in the design what a task item does at its box (the box goes with the marker, or Backspace stops at the box first) and what an item nested under an ordered parent renumbers. Pins red first for the nested bullet, the nested ordered and the task cases; the top-level pin in `blocks.test.ts` stays as it is.

## Boundaries

`web/packages/workspace-app/src/editor/commands/list.ts` and its tests, `editor/decorations/blocks.test.ts` if the task case changes it, `editor/design.md`. Not changed: the atomic prefix and the caret filter; Delete at the line start; Enter, Tab and Shift+Tab; the document's text outside the item Backspace acts on.

## Acceptance

1. Backspace at the text start of a nested bullet item outdents it one level, marker and text kept, pinned red first.
2. The same on a nested ordered item renumbers as Shift+Tab does, pinned red first.
3. Backspace at the text start of a top-level item leaves the text as a paragraph in one press, the existing pin.
4. The task item case is decided in the design and pinned.
5. The list command and decoration suites, svelte-check and the whole workspace-app suite green; `make web-check` green in the owning guest.
