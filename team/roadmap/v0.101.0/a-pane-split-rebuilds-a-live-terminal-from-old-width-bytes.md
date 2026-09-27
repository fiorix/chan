# A pane split or tab move rebuilds a live terminal from bytes written at another width

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised the same day from the owner's own terminal (`.Drafts/untitled-11/draft.md` in the owner's workspace, a code-path diagnosis with a screenshot of the host terminal after a pane split, validated by the lead against `main` at `cdd266b09`). Not reproduced in a harness; the screenshot is the observation.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, in the clients lane after its ownership order and ahead of the comment pass, sequenced against the frontend lane's clipboard and keyboard order, which edits `Pane.svelte` too.

The server-side resize on reattach landed on 2026-09-26 as [a-reattach-replays-before-the-pty-takes-the-clients-size](a-reattach-replays-before-the-pty-takes-the-clients-size.md); the renderer's survival across a split or a move is still to build.

## What was seen

Terminals render inside each pane (`components/Pane.svelte:1864`, a keyed list per pane). When a leaf becomes a split, `Workspace.svelte` re-creates the subtree (its split children are keyed, `:82` and `:97`), and a tab moved between panes leaves one pane's list for another's; either way the `TerminalTab` component unmounts and its teardown disposes the renderer and the socket (`TerminalTab.svelte:1982`) while the PTY session survives. The replacement mounts a fresh renderer with no cursor, so it dials for the whole retained history, and the cached screen snapshot is accepted only when its geometry matches (`:1299`), which a split never gives. The history was written at the old width, so cursor-addressed output and hard wraps render wrong in the new width: the owner's host terminal showed its lines wrapped at the new width with the remainders stacked at the right edge. An ordinary tab switch keeps the terminal mounted and hidden, so only pane restructuring takes this path.

## Desired contract

A terminal keeps its renderer, its socket and its screen across same-window pane splits and tab moves; on relocation it is fitted to its new host and the PTY takes the new size, with no replay of retained history.

## What to do

Give terminals a stable owner keyed by tab id above the pane tree, with the pane supplying the host element and the geometry (the app already has a portal primitive), so a split or a move reattaches the existing rendered surface instead of building a new one; on relocation fit the renderer once the destination has a measurable size and send the resulting columns and rows, avoiding an intermediate zero-size fit. Keep the hidden-tab behaviour for ordinary tab switches. Acceptance: a mounted app test spawns an unpositioned team, then splits and moves tabs while the host terminal is active: the terminal instance survives, the session receives no full-replay dial, and the destination size is sent; a browser-level check with cursor-addressed output at a wide size that shrinks the pane while output arrives and confirms the screen and the input cursor recover after the resize redraw is for the round's browser-smoke pass. The draft's interim of a screen snapshot on pane teardown is not taken: once the renderer survives, that path is dead.

## Boundaries

`web/packages/workspace-app/src/components/Workspace.svelte`, `Pane.svelte`, `TerminalTab.svelte` and the state that owns terminal tabs; the existing keep-alive test grows a pane-restructuring case. The server-side resize on reattach is its own item.

## What shipped

Landed on 2026-09-27. A terminal is no longer drawn by its pane. One owner at the root of the pane tree (`components/Terminals.svelte`, which `Workspace.svelte` draws at the root only) draws every terminal tab of the layout once, keyed by tab id; each pane draws a terminal layer in its body; and a dock (`dockTerminal` in `state/terminalDock.svelte.ts`) moves each terminal's element into the layer of the pane that holds it. A split, a move, a swap or a collapse therefore moves the element and keeps the renderer, its screen and the one socket, with no second dial and no replay. A terminal mounts only once it is docked, so its first fit measures the pane it is drawn in, and each of its props is a value of its own, so a change to another pane's tabs re-runs none of its effects. After a move the terminal is fitted on the next frame and again at 50 and 250 ms, and a changed grid reaches the PTY as a `resize` frame on the socket it already has. A tab switch, a side flip and Hybrid Nav keep the terminal mounted and hidden, as before. Pinned through the real app with the terminal live on its session: a split, a move to another pane (which sends that pane's size), a collapse of the pane beside it, and a positioned team spawn that swaps it into the free cell each keep its element, its renderer and its one dial.

The dial and the socket's open declare a grid only once a fit has measured one: a fit that declines, throws or proposes no finite grid is not a measurement, and a dial without one declares no size, so the PTY keeps the size it has (`runTerminalFit` in `terminal/resize.ts`, `terminalWsPath` in `terminal/session.ts`). The first measured grid is sent even when the fit left the renderer's grid as it was, since an unchanged grid fires no resize event and the PTY would keep the size another client gave it. After a move the keyboard goes back to the find input, the Rich Prompt composer or the terminal, whichever last held it, when the terminal is still the focused one and nothing outside it has taken the keyboard since; the pins read which element is asked to take focus.

Not fixed, or not pinned:

- A survey card shown over the terminal is not given the keyboard back after a move: the return falls back to the terminal, which defers to an open survey.
- A tab id that two panes list is drawn in the first of them only, with a console warning; where it is the other pane's active tab, that pane's body shows nothing. Nothing is known to produce one.
- A pane whose body fails to render has no layer until its boundary retries, and its terminals stay mounted, socket open, in the detached layer they were in until "Try again" docks them again or their tabs close.
- Relocations with no pin of their own: a Hybrid Nav draft split followed by Escape, a co-view layout rebuild (`reconcileLayout`), the reset of the pane body's failure boundary, and the `placement` frame that carries the new pane id after a move.

The browser-level check was not run. How a DOM move of a focused element drops the keyboard in WebKitGTK, WKWebView and Chromium, whether the composer keeps its caret and selection and what becomes of an IME composition in flight across the move, and how cursor-addressed output renders while a pane shrinks are read from the code and the mounted tests, which run in jsdom with a stand-in renderer (`src/__tests__/xterm.ts`) that lays nothing out.
