# A tmux divider between nested splits cannot be resized from chan

Status: raised at the v0.120.0 close from the limit the tmux pane resize row recorded; not started.

## What was seen

v0.120.0 resizes a tmux window's panes from chan with one `resize-pane` per divider drag, naming a pane whose nearest same-axis ancestor in tmux's layout tree is the dragged divider's node (tmux's `layout_resize_pane` moves the border after that ancestor cell). A divider whose first side holds only perpendicular subtrees that themselves hold same-axis splits offers no such pane, and the second side offers one only when it is the node's last cell; chan refuses that drag and the divider snaps back to tmux's layout.

## Desired contract

1. Every divider of a tmux window is resizable from chan: chan serializes its layout tree with the dragged sizes into tmux's layout string (the form `list-windows -F '#{window_layout}'` prints, with its checksum) and applies it with `select-layout`, so tmux lays the window out exactly as dragged within its own bounds and answers with the layout change chan already reconciles.
2. The one-command path stays for the dividers it reaches, or goes, as the measurement of the two prefers.

## Acceptance

1. chan-tmux tests pin the layout string and its checksum against tmux's own for a set of trees (a plain client's `#{window_layout}` as the oracle), and the `select-layout` command's text.
2. Web tests pin a drag of a nested divider sending the layout and taking the sizes from the layout change.
3. By hand with a real tmux: a nested divider moves in tmux and in chan alike.
