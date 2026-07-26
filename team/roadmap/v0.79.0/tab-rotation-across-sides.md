# Tab rotation crosses Hybrid sides, and an empty-pane close flips

Status: REGISTERED for v0.79.0. Owner-requested behavior change, not yet implemented.

## What

Two related changes to how tab navigation and the empty-pane close treat a pane's two Hybrid sides. Today both stop at the visible side; both should reach the other side when it holds tabs.

### Rotation crosses sides

`app.tab.next` and `app.tab.prev` rotate only the tabs on the pane's visible side. They should rotate the pane's whole ordered tab set across both sides, flipping the visible side when rotation passes the boundary and the other side has tabs.

The bindings are `Mod+Shift+]` and `Mod+Shift+[` natively, which is Cmd on macOS and Ctrl on Linux and Windows, and `Alt+Shift+]` / `Alt+Shift+[` on web. Both paths call `selectNextTabInActivePane` and `selectPrevTabInActivePane` in `web/packages/workspace-app/src/state/tabs.svelte.ts`, so the behavior lives in those two functions and not in the key handlers.

A pane whose other side is empty keeps rotating within one side, wrapping as it does now.

### Empty-pane close flips instead of only flashing

`closeActiveEmptyPane` in `web/packages/workspace-app/src/App.svelte` handles the close shortcut on a pane whose visible side has no tabs. When the opposite side still has tabs it calls `requestPaneSideToggleFlash` and returns, so the pane stays open and the side-toggle button flashes.

It should also flip the pane to the side that has the tabs. The flash stays: it explains why the pane did not close.

## Boundaries

`selectNextTabInActivePane` and `selectPrevTabInActivePane` are the single funnel for every next and previous tab binding, so neither key handler nor `shortcuts.ts` needs a new entry. The labels stay accurate because the command identity does not change.

The A/B side model, the side-toggle button, `requestPaneSideToggleFlash`, and the pane wobble are unchanged as mechanisms.

## Source pins that constrain the change

Three tests regex the module source rather than the behavior, so they fail by construction when these functions change shape and must be updated deliberately:

- `web/packages/workspace-app/src/components/tabSwitchFocusFollow.test.ts` pins the bodies of both selectors, requiring `paneSide(p)`, then `paneTabs(p, side)`, then `setPaneActiveTabId(p, tabs[next].id, side)`, then `bumpTabFocusPulse()`. The pin exists to keep the focus pulse firing after the active tab id mutates, so preserve that ordering guarantee while rewriting the pin.
- `web/packages/workspace-app/src/components/paneModeKeymap.test.ts` pins `closeActiveEmptyPane`, requiring the empty-visible-side check, then the opposite-side check, then `requestPaneSideToggleFlash(p.id)`, then `return true`.
- `web/packages/workspace-app/src/components/Pane.test.ts` exercises the flash directly.

## Acceptance

- Next and previous rotate through every tab in the pane across both sides, in a stable order, and the visible side follows the selected tab.
- Rotation wraps across the full two-sided set exactly once per cycle, with no tab visited twice and none skipped.
- A pane with an empty opposite side behaves exactly as it does now.
- The focus pulse still fires after the active tab id mutates, on every rotation including one that flips sides.
- The close shortcut on an empty visible side with tabs opposite flips the pane to that side and still flashes the side toggle, and still does not close the pane.
- The close shortcut on a pane empty on both sides is unchanged, including the last-pane window-close path on desktop.
- A browser-smoke check covers rotation across sides and the flip-on-close.
