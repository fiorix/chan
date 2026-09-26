# A pane split or tab move rebuilds a live terminal from bytes written at another width

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised the same day from the owner's own terminal (`.Drafts/untitled-11/draft.md` in the owner's workspace, a code-path diagnosis with a screenshot of the host terminal after a pane split, validated by the lead against `main` at `cdd266b09`). Not reproduced in a harness; the screenshot is the observation.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, in the clients lane after its ownership order and ahead of the comment pass, sequenced against the frontend lane's clipboard and keyboard order, which edits `Pane.svelte` too.

## What was seen

Terminals render inside each pane (`components/Pane.svelte:1864`, a keyed list per pane). When a leaf becomes a split, `Workspace.svelte` re-creates the subtree (its split children are keyed, `:82` and `:97`), and a tab moved between panes leaves one pane's list for another's; either way the `TerminalTab` component unmounts and its teardown disposes the renderer and the socket (`TerminalTab.svelte:1982`) while the PTY session survives. The replacement mounts a fresh renderer with no cursor, so it dials for the whole retained history, and the cached screen snapshot is accepted only when its geometry matches (`:1299`), which a split never gives. The history was written at the old width, so cursor-addressed output and hard wraps render wrong in the new width: the owner's host terminal showed its lines wrapped at the new width with the remainders stacked at the right edge. An ordinary tab switch keeps the terminal mounted and hidden, so only pane restructuring takes this path.

## Desired contract

A terminal keeps its renderer, its socket and its screen across same-window pane splits and tab moves; on relocation it is fitted to its new host and the PTY takes the new size, with no replay of retained history.

## What to do

Give terminals a stable owner keyed by tab id above the pane tree, with the pane supplying the host element and the geometry (the app already has a portal primitive), so a split or a move reattaches the existing rendered surface instead of building a new one; on relocation fit the renderer once the destination has a measurable size and send the resulting columns and rows, avoiding an intermediate zero-size fit. Keep the hidden-tab behaviour for ordinary tab switches. Acceptance: a mounted app test spawns an unpositioned team, then splits and moves tabs while the host terminal is active: the terminal instance survives, the session receives no full-replay dial, and the destination size is sent; a browser-level check with cursor-addressed output at a wide size that shrinks the pane while output arrives and confirms the screen and the input cursor recover after the resize redraw is for the round's browser-smoke pass. The draft's interim of a screen snapshot on pane teardown is not taken: once the renderer survives, that path is dead.

## Boundaries

`web/packages/workspace-app/src/components/Workspace.svelte`, `Pane.svelte`, `TerminalTab.svelte` and the state that owns terminal tabs; the existing keep-alive test grows a pane-restructuring case. The server-side resize on reattach is its own item.
