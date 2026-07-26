# Tab rotation crosses Hybrid sides, and an empty-pane close flips

Status: IMPLEMENTED on `v079/integration` for v0.79.0.

## What

`app.tab.next` and `app.tab.prev` rotate through the active pane's whole tab set in a stable total order: side A in tab-strip order, then side B in tab-strip order. Next crosses from A's last tab to B's first and wraps from B's last tab to A's first. Previous follows the reverse order, including the reverse boundary wraps. Each selected tab makes its side visible.

The bindings are `Mod+Shift+]` and `Mod+Shift+[` natively, which is Cmd on macOS and Ctrl on Linux and Windows, and `Alt+Shift+]` / `Alt+Shift+[` on web. Both paths call `selectNextTabInActivePane` and `selectPrevTabInActivePane` in `web/packages/workspace-app/src/state/tabs.svelte.ts`.

A pane with tabs on only one side rotates and wraps within that side.

`closeActiveEmptyPane` in `web/packages/workspace-app/src/App.svelte` handles the close shortcut on a pane whose visible side has no tabs. When the opposite side holds tabs, it flashes the A/B toggle, flips to that populated side, keeps the pane open, and leaves the opposite side's active tab selected. A pane empty on both sides keeps the normal pane or window close path.

## Boundaries

`selectNextTabInActivePane` and `selectPrevTabInActivePane` remain the single funnel for every next and previous tab binding. Neither key handlers nor `shortcuts.ts` carry special cross-side logic.

The A/B side model, the side-toggle button, `requestPaneSideToggleFlash`, the side-flip animation, and the pane wobble remain the shared mechanisms.

## Source pins

- `web/packages/workspace-app/src/components/tabSwitchFocusFollow.test.ts` pins both selectors so the active tab id and visible side mutate before `bumpTabFocusPulse()` fires.
- `web/packages/workspace-app/src/components/paneModeKeymap.test.ts` pins `closeActiveEmptyPane` so the populated opposite-side path requests the flash, flips, and blocks close.
- `web/packages/workspace-app/src/components/Pane.test.ts` exercises the A/B flash directly.

## Verification surface

`web/packages/workspace-app/src/state/tabs.test.ts` covers complete next and previous cycles across two tabs per side and the one-sided cycle.

Browser-smoke check `99` creates a dedicated pane with two tabs on each side, exercises complete next and previous cycles, empties side A, and proves the close command both flashes and reveals side B. Checks `10` and `15` remain the neighboring close-pane and explicit side-flip regression surfaces.
