# A click beside a graph node clears the selection

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-25 from the second source-text test lane (its mounted GraphCanvas tests) and confirmed by the independent review of that lane at `main` `a83900a29`.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in the editor and graph lane with [a-sent-prompt-stays-editable-while-pending](a-sent-prompt-stays-editable-while-pending.md) and [a-mirrored-value-focuses-an-unfocused-editor](a-mirrored-value-focuses-an-unfocused-editor.md); [mounted-components-mutate-props-they-do-not-own](mounted-components-mutate-props-they-do-not-own.md) comes last in that lane.

## What was seen

The graph canvas picks a node on press with a 4 px slack (`components/GraphCanvas.svelte:935`, `:1428`) but hovers and taps with a 10 px slack (`:936`, `:1497`). A press more than 4 px and at most 10 px from a node's disc starts a pan instead of a drag, and the release of a pan that did not move clears the selection (`:1538-1541`), although the hover cursor over that same ring says the node is clickable. A double-click in the ring clears the selection on both presses, so a folder does not expand. Small nodes make the ring a large share of the target.

## Desired contract

Anywhere the cursor shows a node as clickable, a click selects it and a double-click acts on it.

## What to do

On a pan release that did not move, pick again with the click slack and select the hit; pin a press in the ring (click and double-click) through `nodeScreenCircle` in the mounted GraphCanvas tests.

## Boundaries

`web/packages/workspace-app/src/components/GraphCanvas.svelte` and its tests.
