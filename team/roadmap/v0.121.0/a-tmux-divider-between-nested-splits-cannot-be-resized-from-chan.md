# A tmux divider between nested splits cannot be resized from chan

Status: raised at the v0.120.0 close from the limit the tmux pane resize row recorded; the nested divider accepted as a limitation and the item retargeted to the manual by the owner on 2026-11-02 (the section Decisions); landed, closes at the GA.

## What was seen

v0.120.0 resizes a tmux window's panes from chan with one `resize-pane` per divider drag, naming a pane whose nearest same-axis ancestor in tmux's layout tree is the dragged divider's node (tmux's `layout_resize_pane` moves the border after that ancestor cell). A divider whose first side holds only perpendicular subtrees that themselves hold same-axis splits offers no such pane, and the second side offers one only when it is the node's last cell; chan refuses that drag and the divider snaps back to tmux's layout.

## Desired contract

1. The nested divider stays a limitation: a divider that no single pane's `resize-pane` reaches does not drag (`startResize` in `Workspace.svelte` returns before the drag starts), as v0.120.0 shipped it.
2. The manual's tmux paragraph (`web/packages/marketing/src/pages/manual/terminal.html`) states what v0.120.0 shipped instead of "dragging a divider moves nothing in tmux yet": a divider drag resizes tmux's panes and settles where tmux lays them out, and a divider between nested splits that no single pane's resize reaches does not drag.

## Acceptance

1. The manual paragraph reads as contract 2, checked against `startResize` and its release handler in `Workspace.svelte`.

## Decisions

The owner's word of 2026-11-02 on the lead's recommendation to build the layout-string resize through `select-layout`: "accept it as limitation". Then "yes" to the lead's question whether the item should become the fix for the stale manual sentence, which v0.120.0's resize left describing a drag that moves nothing in tmux, instead of being withdrawn. The layout-string resize is not built.
