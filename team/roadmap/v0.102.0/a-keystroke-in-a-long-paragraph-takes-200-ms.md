# A keystroke in a very long paragraph takes about 200 milliseconds

Status: raised for a decision on 2026-10-03 by the builder who measured [a-fence-in-view-decorates-every-row-of-its-block](a-fence-in-view-decorates-every-row-of-its-block.md), from that measurement's comparison arm; the owner has not ruled on it. Measured in headless Chrome on the v0.102.0 integration branch. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: a trace first. The measurement attributes about half of the keystroke's 200 ms to the decoration walker's parse budget and leaves the other half untraced, so a build cannot be sized yet; a build is ruled after the trace. The item is accepted for the trace alone.

Later on 2026-10-03, with the trace below in hand, the owner ruled as the lead recommended: the one-line cause is built. The walker skips its forced parse when the tree in hand already reaches past the viewport, with a pin that an edit which changes a block's kind is still decorated at once. The other two parses stay: what the parser takes as a paragraph does not change.

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

## Trace of 2026-10-03

Traced by a builder on the v0.102.0 integration branch, with nothing committed: headless Chrome 154, the editor component alone, a 1600 by 1000 viewport, 40 typed keys after 5, two passes.

A key in the 20,000-line paragraph takes 191.54 to 200.48 ms from the keydown to the frame after it (p95 205.72 to 230.15), and the rows of the trace sum to that within 0.3 ms. 90.09 to 92.83 ms is the language's parse inside the transaction, and 87.95 to 93.62 ms the walker's forced parse of the same paragraph (`web/packages/workspace-app/src/editor/decorations/walker.ts`); a third parse of about 90 ms runs in idle time after the frame. Each is one step of the markdown parser, which takes a paragraph whole, so no time budget bounds it: the walker's budget at 0 and at 10 ms leaves all three as they are, and the earlier reading that the walker spends its whole budget was a coincidence of size. The rest of the key is 14 to 15 ms: the application's inline parsers inside those parses, the change listener's whole-document string, the page-break command, garbage collection, and under 1 ms of style, layout and paint. The same lines as 20,000 paragraphs take 25 ms a key with no such parse.

One cause is a line: the walker forces its parse although the tree in hand already reaches past the viewport, and skipping it there takes about 90 ms off, if an edit that changes a block's kind is still decorated at once. The other two parses need the paragraph to stop being one leaf. Not measured: the app's shell, WebKit, a slower machine.

## What shipped

The one-line cause was built later on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review. The walker forces no parse when the tree in hand already reaches past the viewport (`web/packages/workspace-app/src/editor/decorations/walker.ts`), with pins that an edit which changes a block's kind is still decorated at once. Measured again on the same document, two passes in headless Chrome: a key took 194.82 and 197.14 ms before and 109.60 and 102.87 ms after (median). The forced parse is gone, the parse in the transaction stays at about 92 ms, and the idle worker runs up to two parses after the frame where it ran one, so the main thread's busy time for a key fell from about 293 ms to about 228 ms. The other two parses stay, as ruled.
