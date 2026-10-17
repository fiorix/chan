# Backspace at an item's text start removes its indent with the marker

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16 on the seat's branch; the section Build 2026-10-16 holds the evidence; it closes at the GA as shipped.

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

## Lead's ruling 2026-10-16

On the frontend seat's reading that the outdent command renumbers nothing, the lead ruled on 2026-10-16, in its words: "the item's "renumbered as the outdent command renumbers it" is satisfied by what the outdent command does at the base, which is nothing (`shiftListLines` strips indent and renumbers no line). bksout introduces no renumbering; its acceptance 2 is pinned as Shift+Tab's result on the same document."

## Owner's decision 2026-10-16

Put to the owner by survey on 2026-10-16 ("Backspace on a later top-level list item") with three options: keep the default deletion, the text joining the item above as markdown reads it (recommended); break out with a blank line into its own paragraph between two lists; join onto the end of the item above as one line. The owner's answer, in the survey's words: "Keep: joins the item above as markdown reads it (recommended)". Applied as: the default deletion stands, and the texts say what markdown reads: at a top-level item Backspace removes the marker (a task's box and gap with it) in one press, and the text then reads as markdown reads a line with no marker in that place: under another item it continues that item's paragraph, and after a blank line it is a paragraph of its own.

## Build 2026-10-16

Built in `web/packages/workspace-app/src/editor/commands/list.ts` and bound in the WYSIWYG editor's high-precedence keymap after Shift-Tab (`editor/Wysiwyg.svelte`). `outdentListItemOnBackspace` takes its branch only with one empty selection exactly at the text start of a parsed item, read by `parsedListItemAt`: the prefix regex confirmed by a `ListMark` in the syntax tree. That helper is the one rule for "a parsed item"; the caret filter's `listPrefixSpans` (`editor/decorations/list_prefix.ts`) reads it too, its spans unchanged. Whether an item is nested is the tree's answer (its list sits inside another `ListItem`), not the indent's: an indented item with no parent is top-level and loses its marker, and an item below its parent's continuation line is nested and moves out. A nested item runs `shiftListLines(view, -1)`, the Shift-Tab transformation, on its one line, so it lands at its parent's own indent, keeps its marker and text, renumbers nothing (the lead's ruling above), and the caret stays at its text start. The task case, decided here: a nested task outdents with its box; a top-level task loses its marker, box and gap together in one press, because the default deletion removes only the atomic gap after the box and leaves `- [ ]two`, which is no longer a task. Any other top-level item falls through to the default, which removes the atomic prefix whole, as before. At a top-level item the text then reads as markdown reads a line with no marker in that place: under another item it continues that item's paragraph, and after a blank line it is a paragraph of its own (the owner's decision above). Delete, Backspace inside the text, the atomic prefix, the caret filter, Enter, Tab and Shift-Tab are unchanged. `editor/design.md` says so in "Atomic widgets" and in the implementation notes.

The pins are `web/packages/workspace-app/src/editor/Wysiwyg.listBackspace.test.ts`: a mounted `Wysiwyg` and real `keydown` events, so the binding's place ahead of the default deletion is under test. Twelve cases: a nested bullet; a nested ordered item, equal to Shift-Tab's result on the same document and `1. one\n1. sub\n2. two`; a bullet nested under an ordered item; a nested item after its parent's continuation line; a nested task keeping its box; a top-level bullet under another item, its text continuing that item's paragraph; an indented item with nothing above it, its text a paragraph; a top-level task under another, marker, box and gap together, its text continuing the item above; Backspace inside a nested item's text; a selection that ends at a nested item's text start, deleted rather than outdented; a list-shaped line in a fence; and one in a fence inside an item. The top-level pin in `editor/decorations/blocks.test.ts` stays as it is.

Evidence, in the frontend guest, logs under `dev/v0107-team/evidence/Frontend107/` in the round's bus:

- Red first (`bksout-red.{log,status}`, rc 1): the ten cases written before the code (all but the fenced line inside an item and the selection case, which came after it) against the editor without the binding, 6 red, each on its document and caret: `* one\ntwo` for the nested bullet, `1. one\nsub\n2. two` for the nested ordered item, `1. one\nsub`, `* one\n  more\ntwo`, `- [ ] one\n  - [ ]two` for the nested task, and `- [ ] one\n- [ ]two` with the caret at 15 for the top-level task. The four default cases green there. The eleventh case was added after the code, as the pin for the tree check on this path.
- Green (`bksout-green.{log,status}`, rc 0): `vitest run src/editor` with the change, 110 files and 1201 tests, among them `commands/list.test.ts` (55) and `decorations/blocks.listPrefix.test.ts` (19) untouched and green.
- One mutation per guard (`bksout-mutants.{sh,log,status}`, rc 0; the unmutated run 11 of 11): nesting never true turns the five nested cases red; nesting by indent turns the parentless indented item red; nesting by a parent scan of the lines above turns the continuation case red; no task branch turns the top-level task red; the branch taken at any caret on the line turns the mid-text case red; no tree check in `parsedListItemAt` turns the fenced line inside an item red.
- The twelve cases and seven mutants (`bksout-mutants-2.{sh,log,status}`, rc 0; each mutant replaces one unique piece of `list.ts`): unmutated, 12 of 12 green; the six mutants above, each red on the same cases; and the empty-selection guard voided (`if (!sel.empty) return false;` matched with its next line, since its text occurs more than once in `list.ts`) turns the selection case red, the binding outdenting the item instead of deleting `two`.
- `make web-check` at the code's commit `a7d56b948` (`bksout-web-check-3.{log,status}`, rc 0, 12:33Z to 12:48Z, on two CPUs, the guest checkout clean before and after): svelte-check 0 errors and 0 warnings in web-shared, the launcher, the workspace app and profile; vitest web-shared 7 files and 218 tests, the launcher 57 and 619, the workspace app 560 and 7087, profile 5 and 20; the workspace app's production build. Earlier forms of the change were gated the same way at `5896da185` and `04b71234e` (`bksout-web-check{,-2}.{log,status}`, rc 0).
- The commit that lands differs from `a7d56b948` in comments and test names, this row and the message: `commands/list.ts` in its doc comment alone, `Wysiwyg.svelte` and the caret filter byte-identical (`bksout-w1-diff.txt`). At the code's commit `dbf0cbcc3` (`bksout-comment-gate.{log,status}`, `comment-gate.sh`, rc 0): the workspace app's svelte-check, 0 errors and 0 warnings, and its editor suites, 110 files and 1203 tests; the commit that lands differs from that one in this row's text only.

Acceptance: 1 (nested bullet) and 2 (nested ordered, as Shift-Tab) pinned red first; 3 the existing top-level pin, green, and the mounted top-level bullet case; 4 the task case decided above and pinned (nested task red first, top-level task red first); 5 the list command and decoration suites green, and `make web-check` green at the commit in the owning guest, as recorded above.
