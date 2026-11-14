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
