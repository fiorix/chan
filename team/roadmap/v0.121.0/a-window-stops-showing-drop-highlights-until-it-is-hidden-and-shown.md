# A window stops showing drop highlights until it is hidden and shown

Status: raised by the owner on 2026-11-01 from daily use of chan-desktop 0.120.1 on macOS; read live in a broken window's Web Inspector and in the code at v0.120.1, drafted for v0.121.0. The trigger is not known.

## What is there now

Every now and then one chan window stops showing the drop highlights of a tab drag (the tab strip's insertion indicator and the pane body's split edge) while other windows keep them. Hiding the window and showing it again restores them. The owner has not identified what puts a window in that state.

A reading of one broken window (served bundle `index-Dc34uT5o.js`):

- The console held no uncaught exception: only WebSocket reconnect failures to the window's devserver and one `[chan-desktop] gateway_csrf_token refused`.
- Opening the Web Inspector and typing into its console restored drags in that window before any drag was probed. Moving the focus into the inspector blurs the page, as hiding the window does, so a focus loss is enough to recover. The page state a window `blur` resets is `pendingTerminalPress` in `Pane.svelte` (`clearPendingTerminalPress`), but in the code read nothing in the dragover or drop handlers reads it, so that reading does not explain the symptom. WebKit-side drag state is the other candidate.

The first drag probed after the recovery found a separate defect, which may or may not be the trigger. Dragging a terminal tab onto an edge of a window's only pane splits it, then throws in `dragend`:

- `detachTabToPaneEdge` (`state/tabs.svelte.ts`) inserts a split above the pane, so `layout.rootId` moves from the pane to the split. The root `Workspace.svelte` derives `node` from `rootId`, switches branches and destroys that `Pane`.
- Svelte 5 removes element listeners at teardown only for `window`, `document`, `body` and media elements, so the detached tab element keeps its `ondragend` and the source's `dragend` runs in the destroyed component. The handler reads `visibleSide` (console: `https://svelte.dev/e/derived_inert`), and the `pane` prop now resolves through the root's `node` to the split node.
- `onDragEnd` (`Pane.svelte`) passes `pane.id`, the split's id, to `shouldCloseTabAfterDragEnd`, which leaves the `markLocalTabDrop` entry recorded under the old pane id in `localTabDrops`. With `draggedTerminalPress` set (a terminal tab pressed before the drag), it then calls `allPaneTabs(pane)` on the split node and throws `TypeError: Spread syntax requires ...iterable not be null or undefined`.
- A split of a pane that already sits inside a split re-keys its `Workspace` child by id, so the destroyed `Pane` still resolves to its leaf and nothing throws. A file tab skips the throwing branch (no `draggedTerminalPress`).

Every drag variable the handler resets (`localTabDrag`, `tabDragInFlight`, `pendingTerminalPress`, `draggedTerminalPress`) is reset before the throw, so on its face the throw does not explain later drags losing their highlights. Because `cloneTab` keeps the tab id, the stale `localTabDrops` entry can later make `shouldCloseTabAfterDragEnd` keep a tab that a cross-window drop accepted, leaving it in both windows.

The probe used for the reading, pasted into the window's console (`__dndProbe()` removes it). A `dragend` on a source already removed from the page never reaches `window`, so its absence from the log is itself a reading:

```js
(() => {
  const SCOPE = "application/x-chan-tab-scope+";
  const unhex = (h) => new TextDecoder().decode(new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16))));
  const at = (el) => (el instanceof Element ? `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")}` : String(el));
  const seen = {};
  const log = (e) => {
    const where = at(e.target);
    if (e.type === "dragover" && performance.now() - (seen[where] ?? 0) < 400) return;
    seen[where] = performance.now();
    const types = [...(e.dataTransfer?.types ?? [])];
    const scopes = types.filter((t) => t.startsWith(SCOPE)).map((t) => unhex(t.slice(SCOPE.length)));
    // Read after dispatch, so `prevented` says whether a drop zone accepted it.
    setTimeout(() => console.log("[dnd]", e.type, where, { types: types.filter((t) => !t.startsWith(SCOPE)), scopes, prevented: e.defaultPrevented, dropEffect: e.dataTransfer?.dropEffect }), 0);
  };
  const events = ["dragstart", "dragenter", "dragover", "dragleave", "drop", "dragend"];
  for (const t of events) window.addEventListener(t, log, true);
  window.__dndProbe = () => { for (const t of events) window.removeEventListener(t, log, true); delete window.__dndProbe; };
  console.log("[dnd] probe on", { focus: document.hasFocus(), stuck: [...document.querySelectorAll('.tab-dragging, .tabs.drop-active, [class*="body-drop-"]')].map(at) });
})();
```

## Desired contract

1. A window shows the drop highlights of every accepted tab drag, whatever drags came before it, without a hide and show.
2. Dragging a terminal tab onto an edge of a window's only pane splits it with no console warning or error. The source's `dragend` resolves the source pane by the id recorded at `dragstart`, not through the live `pane` prop, and consumes the `localTabDrops` entry under the id it was recorded with.
3. A test: one pane with two terminal tabs, press one, drag it to the pane body's right edge, drop, then dispatch `dragend` on the now-detached tab element; expect no throw, two panes, and `localTabDrops` empty.

## Next

The owner's reading of the next broken window: install the probe before hiding the window, drag a tab across a pane body and its tab strip, and record whether `dragover` arrives, which types it carries and whether it is prevented. That decides whether the fix is in the page or in the WebView. The `dragend` defect can be fixed first, test red first.

## Closing

The `dragend` defect (contracts 2 and 3) is fixed, built from `762f95240`. `Pane.svelte` records where each tab drag started, the pane id and the side, at `dragstart`, and the source's `dragend` settles the drag by that record instead of the live `pane` prop: `shouldCloseTabAfterDragEnd` consumes the `localTabDrops` entry under the pane id it was recorded with, and the pressed-tab selection and the cross-window close look the source pane up in the layout by that id, stopping when it is no longer a pane. The tab's `ondragend` no longer reads `visibleSide`, so a `dragend` on the tab element of a destroyed `Pane` reads no derived.

`components/Pane.dragEnd.test.ts` is the item's test over the mounted App: one pane with two terminal tabs, the second pressed, dragged to the pane body's right edge and dropped, then `dragend` dispatched on the tab element the split detached. Against the base code it read red on three counts: `TypeError: p.tabs is not iterable` from the listener (jsdom's wording of the spread error), a `[svelte] derived_inert` console warning, and `localTabDrops` still holding `pane-test:a:second`; the two-pane layout was already right. With the fix all four expectations hold. Putting back the live prop in the consume, the `visibleSide` read in the template and the live prop in the selection branch each turns its own expectation red again. The Pane, cross-window terminal move and tabs state suites pass, and `make web-check` gates the commit.

Open: contract 1, the lost drop highlights. Its trigger is still unknown, and no broken window has been read since the fix; whether this `dragend` throw was the trigger is not established, since every drag variable the handler resets was already reset before the throw. The probe above, installed in the next broken window before it is hidden, decides whether a fix belongs in the page or in the WebView.
