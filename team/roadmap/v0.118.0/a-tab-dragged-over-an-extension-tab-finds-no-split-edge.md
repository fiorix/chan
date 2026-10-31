# A tab dragged over an extension tab finds no split edge

Status: carried into v0.118.0 after the v0.117.1 GA on 2026-10-31, built and not merged: v0.117.1 shipped without it, and the owner's word on rebasing `v01171/extension-tab-drag` onto the release was "Fold into v0.118.0"; the owner's reading in chan-desktop is pending.

Record before the release: raised by the owner on 2026-10-31 after the v0.117.0 publication, from chan-desktop with the strudel and doom extensions; accepted for v0.117.1 as a patch and built the same day on `v01171/extension-tab-drag` (the section Built); the owner's reading in chan-desktop is pending.

## What was asked

The owner's words of 2026-10-31: "the drag & drop is broken for tabs which are extensions.. if i open a tab of chan-ext-strudel or chan-ext-doom and try to drag and drop to the corners to split the pane, those tabs dont seem to work".

## Evidence

- An extension tab's body is an `<iframe sandbox="allow-forms allow-scripts">` filling the pane body (`ExtensionTab.svelte`). The pane's split drop zone is the `dragover`, `dragleave` and `drop` handlers on the pane body (`.editor-wrap` in `Pane.svelte`), which pick the edge nearest the cursor and preview it. A drag over the frame is hit-tested to the frame's document, where its `dragover` and `drop` are dispatched; they do not cross into the pane's document, so the body's handlers never run: no edge preview and no split, whether the dragged tab is the extension tab itself or a terminal dragged onto the pane showing it. The strip above the frame is the pane's own, so a drop on the strip still moves the tab. Terminal, editor, graph, dashboard and Files tabs paint in the pane's document and take the drop at an edge.
- Measured in headless Chrome 150 with a native drag driven through the DevTools drag interception (puppeteer-core): a page with a draggable tab, a body with `dragover` and `drop` listeners and, in the frame arms, a sandboxed `srcdoc` frame with the extension tab's sandbox filling the body; the drag ran from the tab to a point near the body's right edge with two `dragover` moves and a drop.

| Arm                                                     | dragover | drop |
| ------------------------------------------------------- | -------- | ---- |
| no frame                                                | 3        | 1    |
| the frame as the extension tab builds it                | 0        | 0    |
| the same frame, `pointer-events: none` during the drag  | 3        | 1    |

- A fourth arm removed the drag's source element from the document inside the drop handler, the shape of a source pane collapsing when its only tab leaves: Chrome delivered `dragend` to the removed source all the same.

## Desired contract

A pane showing an extension tab takes a tab drag as every other pane does: the edge preview follows the cursor over the extension's body, a drop at an edge splits the pane with the dragged tab, whichever kind the dragged tab is, and the extension takes pointer events again the moment the drag ends, by a drop anywhere or by a cancelled drag. Nothing else moves: a drop on the strip, the refusal of a cross-window body split, and the rule that a pane's only tab dropped on its own body is a no-op stay as they are.

## Boundaries

`web/packages/workspace-app/src/components/Pane.svelte` (the drag state and the body's stylesheet) and its test; `ExtensionTab.svelte` is read against it and unchanged; no server change.

## Acceptance

1. In vitest, a pane showing an extension tab carries the drag mark from another pane's tab `dragstart`, accepts `dragover` at its body's edge with the edge preview, splits on the drop, and drops the mark at the drop and at a `dragend` with no drop; the stylesheet rule the mark keys is pinned. The test is red on the tree without the fix.
2. The owner, in chan-desktop: with a terminal tab and a strudel or doom tab in one pane, drags the extension tab to each edge of the body and sees the preview and the split; drags the terminal tab onto the pane showing the extension and sees the same; and the extension takes the mouse again after each drag.

## Built, 2026-10-31

`Pane.svelte`'s module script holds `tabDragInFlight`, a `$state` shared by every pane of the window, set at a tab's `dragstart` and cleared at its `dragend` and at the top of both drop handlers (the body's and the strip's), since a drop ends the drag before the source's `dragend`, which a source pane collapsed by that drop may not deliver. The pane body carries `tab-dragging` while it is set, and the rule `.editor-wrap.tab-dragging :global(iframe) { pointer-events: none; }` lets hit-testing skip the extension's frame for the drag's duration, so the body's `dragover` and `drop` run as they do over every other tab kind. The only iframes under a pane body are extension tabs, and nothing else needs the frame's pointer events while a native drag is in flight.

Verification: the vitest in `Pane.test.ts` (acceptance 1) is red at the mark assertion with the class binding removed and the rule kept, red at the rule's pin with the whole fix removed, and green with it (51 tests in the file); svelte-check reports 0 errors; `make web-check` is green in the worktree (svelte-check 0 errors in all four packages; vitest 234, 720, 7,972 and 20 tests passing for web-shared, the launcher, the workspace app and the profile; the production build). Not read here: chan-desktop by hand (acceptance 2), where WKWebView's and WebKitGTK's delivery of `dragend` to a removed source is unmeasured, which is why the drop handlers clear the mark themselves.
