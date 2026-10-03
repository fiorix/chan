# A fence in view decorates every row of its block at each recompute

Status: raised for a decision on 2026-10-03 by the builder of the open rows of [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md), whose row "a viewport-bounded fence handler" ended as a plan and not a build; the owner has not ruled on it. Read in the code on the v0.102.0 integration branch; nothing was measured.

## What was seen

The decoration walker iterates the syntax tree over the editor's viewport, but for a fenced code block that touches the viewport its handler works on the whole block (`handleFencedCode`, `web/packages/workspace-app/src/editor/decorations/blocks.ts:173`): it pushes one line decoration for every row of the block (`:270-277`), and it slices the block's whole body into a string for the copy badge (`:253-267`), which the badge's `eq` then compares with the last one (`:60-62`). That runs at every recompute, which is every keystroke, caret move and scroll. So the work for a fence in view grows with the block's length and not with what is shown.

The page shows the same rows either way: CodeMirror draws only the viewport's lines, so no mounted test reads a difference, and the builder found no red without exposing the walker's decoration set. What a long fence costs per keystroke was not measured.

## Desired contract

Not written yet. If the measurement shows a cost a user meets: the work a fence in view takes at a recompute is bounded by the viewport, not by the block's length, and Copy still copies the whole block.

## What to do

Measure first: the decorations pushed and the time taken per recompute with the caret inside a fence of 20,000 lines, against the same document without the fence. If the number is one a user meets, the builder's plan is the fix: clamp the row loop to the lines that intersect the viewport (the walker already recomputes on a viewport change), and give the badge the block's position instead of its text, reading the text at the click, so `eq` compares the language alone. Its costs: Copy reads the body a second way, which `blocks.copyButton.test.ts` must hold, and the clamped loop must agree with the viewport after a measure corrects it (`walker.ts:100-107`). If the number is small the row closes as the measurement.

## Boundaries

`web/packages/workspace-app/src/editor/decorations/blocks.ts`, `walker.ts` beside it, and their tests.

## Acceptance

1. The measurement is recorded in this item with how it was taken.
2. If it is built: a recompute with a long fence in view pushes row decorations for the viewport's lines alone, pinned red first through a seam that reads the pushed set; Copy copies the whole block, pinned.
