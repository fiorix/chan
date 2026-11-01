# The Computers card does not scroll with the mouse and cuts its last workspace

Status: raised by the owner on 2026-11-01 for the v0.120.1 patch (two screenshots of a devserver card with twelve workspaces on chan-desktop for macOS, title `[v119]`: the last row is cut at the card's bottom edge; the wheel does not scroll the card; keyboard navigation scrolls it and shows the scrollbar; when scrolled to the end the last row touches the card's bottom border with no margin).

## What is there now

- The launcher's carousel (`web/packages/launcher/src/components/Carousel.svelte`) clips its stage (`overflow: hidden`, `perspective: 2000px`, slots in `transform-style: preserve-3d`) and makes the active slot's card the scroller: `.slot-body > :global(.card) { height: 100%; overflow-y: auto; }`. Keyboard selection calls `scrollIntoView({ block: "nearest" })` on the row, which is why the keyboard reaches every row and the scrollbar appears.
- No wheel, `touch-action` or `overscroll-behavior` handling exists anywhere in the launcher or web-shared, so nothing in chan's code consumes the wheel. The candidate cause to read first: the card scrolls inside a `preserve-3d` layer with a perspective, which WebKit (the desktop app's WebView on macOS) is known to leave unscrollable by wheel or trackpad in some versions while Chrome scrolls it; the reading is the same card in Chrome at `/launcher` and in the desktop app, wheel over the list, before any fix.
- The card scroller has no bottom padding and the slot's `0.75rem` bottom inset is outside the scroller, so the last row sits flush against the card's border at the end of the scroll range; `scrollIntoView` with `block: "nearest"` stops exactly at the row's edge.

## Desired contract

1. The wheel and the trackpad scroll the active card's list in Chrome and in the desktop WebView on macOS, Linux and Windows; the carousel's turn stays on the arrows, the dots, the keys and a click on a side card.
2. The scroller carries a bottom padding so the last row ends a row's gap above the card's border, and keyboard selection of the last row shows it whole with that margin (`scroll-padding-block-end` on the scroller or `scroll-margin-bottom` on the rows).
3. A browser check with a card of more rows than the deck height holds: wheel scrolls to the last row, which is fully visible with its margin.
