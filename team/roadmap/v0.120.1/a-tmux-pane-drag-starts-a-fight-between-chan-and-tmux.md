# A tmux pane drag starts a fight between chan and tmux

Status: raised by the owner on 2026-11-01 for the v0.120.1 patch, on the v0.120.0 tmuxresize row's behaviour ("I move the pane size, tmux moves it back, and from there the two seem disagreeing and keep moving back and forth").

## What is there now

- The drag sends tmux one `resize-pane` at release (`web/packages/workspace-app/src/state/tmuxResize.ts`), and chan then adopts the layout tmux returns (`tmuxLayoutToSer` in `state/tmuxLayout.ts` derives each split's ratio from tmux's pane sizes).
- Independently, `App.svelte`'s window-size effect sends tmux a `window-size` request whenever `tmuxWindowGrid()` changes (`state/tmuxWindowSize.svelte.ts`): the grid is the fold of every pane's *host grid* (the cells its own element shows at its current size) over the layout tree, a cell per divider, debounced to shortly after the last change. The host grids change with every split ratio, so the drag's preview, the `resize-pane`'s layout and each adopted layout all move the folded window grid by a cell or two (the v0.120.0 review's reading saw the grid go 173, 174, 176 across two drags). Each `window-size` makes tmux resize the whole window and redistribute the panes proportionally, which undoes part of the pane resize; chan adopts that layout, the host grids move again, another `window-size` follows, and the two keep correcting each other.

## Desired contract

1. The window grid chan asks tmux for depends on the window's own area, never on the split ratios: the tmux tab area's size in cells (the shared cell size of its terminals), sent when that area changes (a browser or pane-set resize), not in reaction to a layout tmux returned or a drag in progress.
2. A drag sends `resize-pane` only; no `window-size` is sent between the press and the layout that answers the release, and an adopted layout never triggers one by itself.
3. Tests pin: a drag with a stable window area sends exactly one request; an adopted layout sends none; a real window resize sends one `window-size` with the area's cells. A real-tmux reading (the v0.120.0 driver under a private `tmux -L` server) shows the grid stable across three drags and the panes resting where the drag left them.
