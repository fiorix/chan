# A tmux window's panes cannot be resized from chan

Status: shipped in [v0.120.0](../../release/release-v0.120.0.md).

Record before the release: raised by the owner on 2026-11-01, accepted for v0.120.0 the same day, and implemented.

## What was asked

The owner's words, 2026-11-01: "our current tmux -CC support does not allow us to resize the panes from chan, because the authority for pane size is tmux - but then we have no means by resizing at all, unless we attach to tmux normally without -CC and resize from there; we should be able to resize panes from chan even if we do this by sending commands to tmux and reacting to them, according to tmux's rules / boundaries".

## What is there now

Read at `498cb8659` (the v0.120.0 base, code-identical to the v0.119.0 GA):

- A tmux window's pane tree is tmux's layout (`web/packages/workspace-app/src/design.md`, the tmux paragraph): the `tmux_layout` command carries the connection's tree with sizes in cells, `reconcileLayout` applies it onto the live pane tree, and tmux sizes the panes: a tmux pane's `TerminalTab` never fits its renderer to its host and adopts the grid the server says from every layout change.
- The only size chan sends tmux is the window's: `App.svelte` folds the hosts' grids over the last layout (`state/tmuxWindowSize.svelte.ts`) and asks for that window size through a `window-size` request on a pane's session (`state/tmux.ts`; `crates/chan-tmux/src/command.rs` turns it into `refresh-client -C <window>:<cols>x<rows>`), once per change and 150 ms after the last, so tmux lays the panes out inside it.
- A divider drag in a tmux window is accepted by the pane tree and stays local; the next layout tmux sends resyncs the divider to tmux's sizes (the design paragraph says so, and `Pane.svelte` only refuses tab drags out of a tmux window, lines 979 and 1123). So a drag appears to work and is undone.
- `crates/chan-tmux/src/command.rs` has no `resize-pane` or `select-layout` command; the request family the terminal route takes (`crates/chan-server/src/routes/terminal.rs:254`) is `split`, `focus`, `window-size` and `open-window`.
- tmux's rules, from its manual: pane sizes are whole cells inside the window's size, which the control client sets; `resize-pane -t <pane> -x <cols> -y <rows>` sets a pane's size and `-L`, `-R`, `-U`, `-D` with a count move its borders; a pane cannot shrink below one cell plus its borders and a resize clamps to the window; every applied change comes back as a `%layout-change` with the new layout string, which is what chan already reconciles.

## Desired contract

1. Dragging a reachable divider in a tmux window resizes the panes in tmux: the drag's end sends one `resize-pane` for a pane on one side with the requested size in cells, and chan shows the layout tmux answers with, so the divider lands where tmux put it, inside tmux's bounds. A divider unreachable by one pane command refuses the drag.
2. A drag past a bound lands at the bound tmux applies (a pane never smaller than tmux allows, the window's size unchanged); no local size survives a layout change, as today.
3. The same path serves a keyboard resize if the pane tree has one for plain windows (Hybrid Nav's `[` and `]` or its equivalents), with the same clamping.
4. Plain windows are unchanged; a window whose tmux connection is gone refuses the drag the way it refuses tab drags.

## Decisions

- The divider follows the pointer locally during the drag and sends one `resize-pane` at release. The next tmux layout sets the final ratio.
- The request names a pane on the divider's first side whose nearest same-axis tmux ancestor is the dragged border, using `resize-pane -t <pane> -x <cols>` or `-y <rows>`. If the first side cannot reach it, a pane in the last cell on the second side may name the border before it; the requested size then uses that side's share. If neither side can reach the border, the drag is refused and no command is sent. Serializing the whole layout and applying `select-layout` for arbitrary borders is deferred to a separate row.

## Acceptance

1. chan-tmux tests pin the `resize-pane` command's text for absolute width and height, and chan-library tests pin request parsing and dispatch. Web tests pin the first-side and second-side border walk, an unreachable divider refusing the drag, a tmux divider sending the size in cells and taking its final ratio from the next layout, the keyboard path, the unchanged plain-window drag and refusal after a connection ends.
2. By hand with a real tmux over `tmux -CC`: dragging a divider moves the pane border in tmux (read with `tmux list-panes -F '#{pane_width}x#{pane_height}'` from a plain client) and the chan window shows the same sizes; a drag past the minimum lands at tmux's minimum.

## Closing

`chan-tmux` renders absolute `resize-pane` commands, `chan-library` accepts the pane request on its existing tmux gate, and the web workspace sends one request when a reachable tmux divider drag ends or Hybrid Nav commits a resize. The next tmux layout sets the displayed ratio. Plain-window resizing and the terminal route's authority remain unchanged; this extends its existing request family, so `route_authority.rs` does not change.

Tests pin the command text, request parsing and dispatch, first-side and second-side border selection, refusal when no pane reaches the border, cell arithmetic, the drag and keyboard paths, and plain-window behavior. A private `tmux -L chan-v0120-editor` server with one horizontal and one vertical split was attached through `tmux -L chan-v0120-editor -CC attach-session -t resize` in chan. From a separate plain tmux client, the left subtree's two panes read 100 columns and the right pane 72 before the drag; after one chan drag they read 112 and 60, and chan showed the returned 112/172 ratio. A drag past the edge sent one more absolute resize and read 173 and 2 columns, with chan showing 173/175. The host grid changed by a few cells during this check through the existing `window-size` requests, so the edge reading is the observed bound for that run.

A divider whose first side has no pane with that border as its nearest same-axis ancestor, and whose last second-side cell also has none, cannot be moved with one `resize-pane` command and refuses the drag. Arbitrary borders require serializing the full tmux layout with its checksum and applying `select-layout`, deferred to a later row.
