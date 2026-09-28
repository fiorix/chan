# A save that fails replaces the file tab's editor with its message

Status: raised for a decision on 2026-09-28 by the plan for the drawing's refused save (`dev/v0101-team/followups/followup-Frontend-Lead-13.md` in the development tree, section 1's table of the tab's error and section 5), which the lead's answer keeps out of that order and raises as one item (`dev/v0101-team/followups/followup-Lead-Frontend-16.md`, ruling 3). Read in code at `7957bccef` and not run. Recommendation: accept for v0.101.0.

## What was seen

A file tab shows its `error` in place of its editor, its board, its tree and its table, in every mode, under a red line on its toolbar (`web/packages/workspace-app/src/components/FileEditorTab.svelte:1280-1284`, `:1320-1321`). Beside a load that failed, which has nothing to show, these set it when a save did not happen:

- a save that threw at a close (`confirmCloseTabs`, `src/state/tabs.svelte.ts:2890`), which also refuses the close;
- a save that threw at the autosave (`:5905`);
- a save that threw at a move to another window (`:6905`), which leaves the tab in this window;
- a draft's close flow or its save that threw (`:3690`, `:3797`), the draft's inspect, discard and promote calls among what can throw there;
- a live document session's or scene session's report that the server's write failed (`src/state/docSync.svelte.ts:1141`; `src/state/sceneSync.svelte.ts:831`).

In each, the text the user was typing leaves the screen and cannot be edited until a load or a later write clears the error (the plan's table, read at `eb732d774`, whose writers hold at `7957bccef` at the lines above). What the user loses is the editor and the sight of the buffer while the server does not answer, and any close; a failed write over the network is the likely cause (inferred). [a-drawing-that-does-not-parse-loses-its-editor](a-drawing-that-does-not-parse-loses-its-editor.md) covers a refused save alone: its order, in hand and not landed, gives a drawing's refusal a field of its own and leaves these writers as they are, by the lead's ruling.

## Desired contract

A save that fails keeps the editor with the buffer as typed and says, beside the editor, that the file was not saved and why; the tab's `error`, which replaces the editor, is set only when there is nothing to show.

## What to do

Move each writer above to the field that the drawing's refused save gives a save that did not happen, one line each, as that plan proposes (`followup-Frontend-Lead-13.md`, section 5), with the clears that field has; and decide what a close says when its save threw. Red first, mounted: a tab whose autosave's write fails keeps its editor and says that it was not saved.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (the save writers), `src/state/docSync.svelte.ts` and `src/state/sceneSync.svelte.ts` (their reports of a failed write), `src/components/FileEditorTab.svelte`, and their tests; after the drawing's refused save has landed, on its field.

## Acceptance

1. A save that throws at a close, at the autosave, at a move or in a draft's flow keeps the editor and says that the file was not saved, pinned for each.
2. A live session's report of a failed write keeps the editor, pinned.
3. A load that fails still shows its error in place of the editor.
