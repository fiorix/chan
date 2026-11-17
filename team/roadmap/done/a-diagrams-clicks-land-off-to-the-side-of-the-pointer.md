# A diagram's clicks land off to the side of the pointer

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): a click, a drag and a hover in a diagram land under the pointer after the layout around its canvas moves it without resizing the window, as closing Details does, with the diagram's zoom, scroll, selection and saved file unchanged (`v0131/diagclick` at `9ff53bb2d`, merged as `5f11bbfd7`). Read by check 265 in a guest's Chrome, a 122-pixel error at the base and none at the tip, red again with the refresh removed, and on chan-desktop under WebKitGTK in the desktop guest, failing at the base and passing at the tip. The owner's Mac line (WKWebView), check 4 of his batch for `f453b0b2e`, had not been read when the cut began on 2026-11-16; a click during a pane's flip was not read, and the readings place the fault at v0.129.0 or earlier without finding where it began.

Record before the release: built and verified in Chrome and WebKitGTK on 2026-11-14; awaiting review and the owner's Mac check.

Record: the owner, 2026-11-14: "just found a bug on excalidraw: the mouse click is off - whenever i click, the on-screen position is off to the right by 1 inch or so". The build, the client and the layout he met it in are not yet recorded.

## What is there now

Read at `356bf1ac3`; not run. A diagram tab renders Excalidraw in `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte`, which has not changed since v0.129.0 and never calls the Excalidraw API's `refresh()`. Excalidraw maps a pointer to the scene through the container's offset it measured last; it measures again on a window resize and its own scroll handling, not when the container moves inside a window whose size is unchanged. By reading, anything that moves a mounted diagram's canvas without resizing the window (a dock or the sidebar opening or closing, a split, a pane resize, the strip appearing, a Details panel) leaves its clicks offset by the distance the canvas moved. v0.130.0 also changed where panes sit on the window's edges. None of this is established; the reading settles it.

## Desired contract

1. A click, a drag and a hover in a diagram land where the pointer is, after any change of layout around the canvas, on both engines (Chrome, WebKitGTK; WKWebView on the owner's Mac).
2. Nothing else of the diagram tab changes: its zoom, scroll, selection and saved state.

## Boundaries

- A reading first: the layouts that shift the canvas, and the offset each leaves, at the integration tip and at v0.130.0 and v0.129.0, in a guest's Chrome and in chan-desktop (WebKitGTK).
- Then the canvas component's handling of its own position (`ExcalidrawCanvas.svelte`); the shape (observing the container's position, calling the API's refresh on the layout changes the reading names) is the build's.

## Acceptance

1. The reading: for each layout change, the drawn position of a click at a known point against the pointer, at each version, both engines; where the offset first appears.
2. A browser check, red at the base and green at the tip: a diagram tab, a layout change that moves the canvas, a click that places an element at a known point, the element's scene coordinates read back.
3. The same on chan-desktop in the desktop guest; the owner's Mac line in his batch.

## Reading, 2026-11-14

The guest reading J83 reproduces the position error in Chrome at integration `941dda34ee25a81b332e39bd75524dbb7ecea122`, v0.130.0 `826adee911a6f93dbd34a8a80205dfb932f21c63`, and v0.129.0 `ed89b7f7f2d356529e447c683e1027c7a24f324a`. Closing Details translates the same mounted, capped board 122 CSS pixels right without changing its size. Excalidraw's cached left offset stays at the old origin; the trusted drag creates a rectangle 122 pixels right of the requested position, with the correct width and height. The defect is at least as old as v0.129.0; these three readings do not establish its first introduction.

At the native reading's 1200 by 800 viewport, closing Details also changes the board's width by 4 pixels at integration and v0.130.0, and 6 at v0.129.0. Excalidraw's own size observer then refreshes its origin, and the measured drags hold. This is a no-regression observation with changed geometry, not proof that WebKitGTK is immune to same-size translation. Other measured native arms hold; unsupported sidebar/window-strip arms and remounted splits remain separate. Chrome's pane-resize arm is incomplete and is not counted as a pass. Raw reports, pointer records and screenshots are in `dev/v0131-team/evidence/Ops131/J83/out/`; the three Chrome reports each record the offset under `details-close`.

## Built, 2026-11-14

The canvas observes ancestor sizes and shallow DOM changes, including equal-width dock swaps that resize no box, then refreshes Excalidraw's cached origin in a coalesced animation frame. Captured scroll events and completed ancestor animations also schedule a measurement. Hidden boards wait for visible geometry; API attachment schedules a measurement, and teardown disconnects the observers, removes listeners and cancels pending work. The observers do not follow the React subtree. Offset-only refresh preserves zoom, scroll, selection and serialized scene state without publishing an edit.

The corrected browser check 265 keeps the mounted board's dimensions constant with a 50 percent page cap. J100 records base exit 1 with a 122-pixel horizontal error after Details closes, tip exit 0 with zero error, and zero-error controls in both runs. The tip verifies trusted drawing, hover and selection, unchanged view and saved bytes, and no layout-only write. Removing only `api.refresh()` makes the check fail again at 122 pixels; restoring it passes. Raw JSON, logs and screenshots are under `dev/v0131-team/evidence/Ops131/J100/out/{base-265c,tip-265c,tip-e2e-mutant-265c,tip-e2e-restored-265c}/`. The mutant and restored checks use the rebuilt CLI recorded in that job, not the earlier joint CLI/desktop build.

J87's capped native layout holds the same WebKitGTK canvas size, instance, viewport and window while Details closing translates its origin by 122 pixels. The base retains the old cached origin and fails (driver 10, wrapper 1); the tip refreshes it and passes (both 0). View, scene and saved file stay unchanged. Summaries and screenshots are under `dev/v0131-team/evidence/Ops131/J87/out/{base-native-capped,tip-native-capped}/`. The corrected pane-resize reading 264 passes at both base and tip; the earlier incomplete 3000 ms arm remains an incomplete attempt, not evidence of a pass.

The mounted component suite passes all 55 tests before and after J100's twelve isolated mutations; every mutation fails an assertion, including idle teardown after removing the disposed guard. The earlier teardown test let that mutation survive because a cancelled frame id masked it; the idle-unmount test removes that condition. Earlier browser attempts failed because Escape finalized a rectangle without clearing selection; check 265 now verifies empty-canvas deselection. These instrument repairs and the interrupted local retry remain recorded in `dev/v0131-team/evidence/Edit131/diagclick/followup21/` and J100's `out/tip-unit-mutations-r2/`.

The committed source at `20d3f098d65e168ee17c463c6f877143fce69b49` passes `make web-check` and `make e2e-check`, both exit 0, in J104. Clean before/after states and the component, unit and browser-source hashes match; logs and statuses are under `dev/v0131-team/evidence/Ops131/J104/`. The final descendant changes only this row, under the lead's documentation-only gate ruling. The editor design document describes the observer lifetime and preserved state; no user-visible text or root architecture boundary changes.

The readings establish the defect at least as far back as v0.129.0, not its first introduction. Pointer mapping during the pane's in-flight 3D flip is not established by the settled-layout check. The owner's WKWebView/Mac line remains in the lead's batch; no Mac result is claimed.
