# A ghostty terminal comes back blank after its window sits off-screen

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: raised by the owner on 2026-11-04 from chan v0.122.0, in a window connected through a gateway; `main` at `720b543c0` carried the same code. Built in another of the owner's sessions on `fix/ghostty-repaint-after-offscreen` off `main` at `720b543c0`, merged into `v0124/int` as `e9c70cef3`, with its browser check renumbered there (`a4b4b0427`).

## What was seen

A terminal tab on the ghostty engine, left in a window on another virtual desktop for a while, comes back blank. Resizing the terminal repaints it.

## Evidence

Read at `720b543c0` with ghostty-web `0.4.0-next.20.g1858a59` (canvas 2D). ghostty-web's frame loop repaints only the rows its core marks dirty, and forces a full pass only in `Terminal.resize` with changed columns or rows, on a font change, or on a core screen switch; it listens to no visibility or context-lost event. chan's host-resume recovery (`recoverTerminalRendererAfterHostResume` in `TerminalTab.svelte`, run on focus, pageshow, visibilitychange, the wake-gap detector and the active and focus flips) queues a fit and calls `refreshTerminalRows(term)`, which called `term.refresh?.()`: xterm.js has it, ghostty-web's `Terminal` does not. chan's ghostty fit returns early when the grid is unchanged. So no resume path repainted anything on ghostty. The ghostty backend test fake defined `refresh() {}`, which hid the gap.

When the host drops a hidden page's canvas pixels (a purged 2D backing store: same size, blank, the page not told), the cell state survives but no row is dirty, so nothing repaints until a grid change. Headless Chrome 150 on the build host never dropped a hidden page's canvas on its own (hibernation, CDP memory pressure and a frozen lifecycle all kept the pixels), so the discard is emulated by a same-size `canvas.width = canvas.width` while hidden. Against `web/node_modules/ghostty-web`, a scratch probe read 30,495 painted pixels, 0 after the discard, 135 (the cursor block) after 30 frames, 2,567 on 3 rows after new output, and every row after a resize or a forced `renderer.render(wasmTerm, true, getViewportY(), term, 0)`.

## Desired contract

1. On every host-resume path, a ghostty terminal repaints every visible row from its current viewport offset, with no resize and no grid change.
2. The xterm.js path is unchanged: `refresh(0, rows - 1)`.
3. A ghostty terminal that has not opened has nothing to repaint and the call is a no-op.

## Boundaries

`terminal/renderer.ts` (`refreshTerminalRows` and `RefreshableTerminal` take the ghostty shape: `renderer.render`, `wasmTerm`, `getViewportY`), one comment in `TerminalTab.svelte`, the ghostty backend test fake (no `refresh()`, a core and a recording renderer), and browser check 204. The forced pass uses the terminal as its own scrollback provider and a scrollbar opacity of 0, so the overlay scrollbar stays with ghostty-web's frame loop. No change to the fit, the resume listeners, xterm.js or ghostty-web.

## Acceptance

1. `renderer.test.ts` pins the call shape (`forces a full ghostty render pass from the viewport offset`, `a ghostty terminal that has not opened has nothing to repaint`).
2. `TerminalTab.ghosttyBackend.test.ts` pins a forced pass on resume without a resize (`the resume forces a full render pass of the ghostty renderer`).
3. Browser check `204-terminal-ghostty-offscreen-repaint` paints a baseline, hides the page behind a front page, drops the canvas backing store while hidden, brings the page back and waits for the painted pixels to return to the baseline's band: red at the base, green with the fix.
4. The owner's case on a real host: a ghostty terminal left on another desktop comes back painted with no resize.

## Built

`3018f76cb`, fix(web): a ghostty terminal repaints every row on a host resume. The check was written as `201-terminal-ghostty-offscreen-repaint` and renumbered to 204 by `a4b4b0427` on `v0124/int`, since `feat/auto-hide-pane-strip` holds 200 to 202 and `fix/launcher-run-returns-focus` holds 203, and the runner names a check's window `smoke-check-<number>`, so two checks with one number would share a window and its saved session. The renumber changes the file name, its tab name, its marker and its page global.

Verification recorded in the commit and the branch's notes: the check as 201 red at the base (37,065 to 168 painted pixels) and green with the fix (3.8 s), alone and in a pack with checks 199, 20 and 21, against `target/debug/chan` with google-chrome-stable on the build host; vitest on the two test files and the whole workspace-app suite; svelte-check clean. As 204 it passed in the whole browser suite at `038d82f42` and at `b2665def0` and in the guest pack of checks 90, 125, 134, 176 and 200 to 206 on the tree merged as `0226903d7`.

Open: acceptance 4 was not read before the GA commit, and the fix is proven against an emulated discard, not a host that dropped the pixels itself; which hosts purge an occluded canvas, and when, is not established. The resume paths can fire together (focus, visibility, the wake gap), and each now costs one full render of the visible rows; not measured.
