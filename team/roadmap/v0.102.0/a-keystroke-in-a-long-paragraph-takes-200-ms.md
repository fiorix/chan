# A keystroke in a very long paragraph takes about 200 milliseconds

Status: raised for a decision on 2026-10-03 by the builder who measured [a-fence-in-view-decorates-every-row-of-its-block](a-fence-in-view-decorates-every-row-of-its-block.md), from that measurement's comparison arm; the owner has not ruled on it. Measured in headless Chrome on the v0.102.0 integration branch.

## What was seen

A document of 20,000 lines with no blank line between them is one paragraph. With the caret in it a keystroke takes about 200 milliseconds: the decoration walker spends its whole parse budget of 100 milliseconds at every recompute (`web/packages/workspace-app/src/editor/decorations/walker.ts:127`, `:153`), and about as much again is spent outside it. The same lines as 20,000 separate paragraphs cost nothing in the walker, and the same lines inside a fence cost 3.4 milliseconds. A pasted log with no fence around it is this document.

## Desired contract

Not written yet. A keystroke's cost should follow what is in view, not the length of the paragraph the caret is in.

## What to do

Rule whether it is built in this version. Nothing is planned: the cause is the parse of one very long block at each recompute, and where the time outside the walker goes was not traced.

## Boundaries

`web/packages/workspace-app/src/editor/decorations/walker.ts` and the editor's parse configuration, with their tests.

## Acceptance

1. The ruling is recorded.
2. If it is built: the measurement is taken again on the same document and recorded here, and the decorations of a document's visible lines are unchanged, pinned.
