# A heading the editor's parse reaches late has no fold chevron until an edit

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found on 2026-11-13 by the v0.129.0 worker that fixed the fold tests' flake under load, from reading and a jsdom probe, and left open for the owner (`dev/v0129/row-notes.md`, "Editor: fold chevrons missing where the tree has not reached"; `dev/v0129/status.md`, 2026-11-13; probe `dev/v0129/evidence/foldflake/09-views-probe-tip-4/`). Listed among v0.129.0's follow-ups (the [release record](../../release/release-v0.129.0.md)). Not seen in a browser. At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, with `@codemirror/view` 6.43.15 and `@codemirror/language` 6.13.1 as locked; by reading and in jsdom only.

- The fold gutter (`headingFoldGutter`, `web/packages/workspace-app/src/editor/fold.ts:172`) paints a chevron from `lineMarker` (174-183), which with `hasSection` (166-170) asks `headingLevelAt` (59): a read of `syntaxTree(state)`, the tree the state holds, with no forced parse. CodeMirror re-reads a gutter's markers only on a document, height or viewport change, a change of its marker facets, or when the gutter's `lineMarkerChange` says so; `lineMarkerChange` (188-195) says so for fold and unfold effects alone.
- The state's tree grows on a transaction, or when the parse worker publishes with an effects-only dispatch (`Language.setState`), which the gutter does not count. At creation the parse covers at most 3,000 characters, under a 20 ms budget that can end it after the first block.
- The heading styles come from the decoration walker (`web/packages/workspace-app/src/editor/decorations/walker.ts`), which forces the parse through the viewport before it walks (`ensureSyntaxTree`, 100 ms) and recomputes when the tree changes. `ensureSyntaxTree` does not put its tree in the state, so a line can be drawn as a heading, at its larger size, with no chevron beside it.
- A click in the gutter beside such a heading does nothing: the click handler (198-212) asks the same `headingLevelAt` and returns.
- In jsdom (probe P10), a plain view of `chanMarkdown()`, `chanDecorations()` and `headingFold()` with the creation parse cut: three headings styled and one chevron painted; still one after the worker published the whole tree and after a selection change; three after an edit. The probes of the mounted `Wysiwyg` editor (P9, P11) found its tree whole at mount and counted no chevrons, so whether the mounted editor shows the gap is not established. In a browser a measure that changes a line's height re-reads the markers, which may repair the first screen. By reading, a jump far down a long note (Ctrl+End, an outline entry) meets the same order: the walker parses the new viewport, the gutter re-reads on the viewport change against the older tree, and the worker's publish repaints nothing.
- v0.129.0 changed only test files under `src/editor/` (`git diff --stat v0.128.0 v0.129.0`), and nothing there has changed since; the gutter's behaviour is older.

## Desired contract

1. A heading the editor draws as a heading has its fold chevron once the parse reaches it, with no input: the gutter re-reads its markers when the state's syntax tree changes, as the heading styles do.
2. A click in the gutter beside a heading drawn as one folds its section, as a click on its chevron does, whether or not the chevron is painted yet.
3. Unchanged: which lines are headings, the fold ranges, and the refusal to fold to the document's end before the parse is complete (`headingFoldRange`'s `"incomplete"`).

## Boundaries

- `web/packages/workspace-app/src/editor/fold.ts`: the gutter's `lineMarkerChange` and its click handler. The walker and the language setup are not changed.
- Not here: the fold tests' initial parse under load, fixed in v0.129.0 by the `parsedState` helper.

## Acceptance

1. First, the reading, in a guest: the workspace app in a browser opens a long note and counts the painted chevrons against the lines drawn as headings on the first screen before any input, with headings on that screen past the first 3,000 characters; then the same after a jump to the note's end. Run on the code without the change. If every count matches, the row goes back to the owner with that reading, to close it or keep contract 2 alone.
2. Workspace app tests over a view with the creation parse cut (probe P10's shape; `withShortCreationParse` in `editor/fold.test.ts`): after the worker's publish, with no input, every heading has its chevron; a click beside a heading the creation parse did not reach folds its section. Each red on the code without the change.
3. The reading of step 1 as a browser check under `scripts/e2e/browser-smoke/checks/`, green on the change in a guest.
