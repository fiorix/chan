# A diagram's clicks land off to the side of the pointer

Status: reported by the owner on 2026-11-14 during the v0.131.0 round and taken into it by the lead (the owner can move it); not started. Its first step is a reading.

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

The implementation observes ancestor size and shallow DOM changes, including equal-width dock swaps that resize no box, and refreshes the board's cached origin after layout, scrolling and completed animations. The observers do not follow the React subtree. Unit tests drive these signals, hidden/reactivated geometry, API attachment and teardown; the serialization and live-session checks verify that offset-only refresh publishes no scene edit. The committed browser check uses a 50 percent page cap and measures trusted drawing, hover and selection plus unchanged view and saved bytes across Details closing. Base/tip, refresh-mutation and native capped-width evidence is pending; the row remains open until those checks return. Pointer mapping during the pane's in-flight 3D flip is not established by the settled-layout check.
