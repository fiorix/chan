# The launcher carousel sits at the top of a tall window instead of its vertical center

Status: raised on 2026-10-26 by the owner after the v0.111.0 close; awaiting acceptance for v0.112.0.

## What was seen

The owner's words of 2026-10-26: "the carrousel in the launcher window must be vertically aligned to the center so tall windows would have the carrousel show in the centered on the window".

Read at `d42bf50d2`. Paths under `web/packages/launcher/src/`.

- `components/Carousel.svelte` sizes the deck with `--deck-height: clamp(22rem, calc(100vh - 11rem), 48rem)` and `height: var(--deck-height)`, so the deck grows with the window up to 48rem and then stops. In a window taller than about 59rem the deck keeps its 48rem and the space below it stays empty.
- `App.svelte` lays the content out as `main.content.deck` with `padding: 0.75rem 0 1rem` and no vertical centering; `components/ScreenFlip.svelte` is a flex column whose panes take `flex: 1`, so the deck is placed from the top of the content area.
- Since v0.111.0 the launcher is a panel over the whole content area of every chan-desktop window, so a tall workspace window shows the deck in its upper half with the lower half empty.

## Desired contract

In every window taller than the deck's maximum, the Computers and Gateways decks sit at the vertical center of the launcher's content area, the space above and below them equal; windows the deck fills behave as today. The centering holds in both decks, through the screen flip between them, with the bulk bar shown or hidden, and under the window's own resize and scale changes; the deck's horizontal layout, its card sizes and its keyboard and drag behaviour are unchanged.

## What to do

1. `App.svelte` or `ScreenFlip.svelte`: the deck pane centers its content vertically (a flex column with `justify-content: center` on the pane the deck fills, or `margin: auto` on the deck), without changing the deck's clamp.
2. A layout test (`Carousel`'s or the deck tests' jsdom cannot measure, so a check in the browser suite or a rect stub per the existing layout tests) that a tall viewport places the deck's rect centered within the content rect.
3. The launcher design document's deck paragraph says the deck is centered in a tall window.

## Boundaries

`web/packages/launcher/src/App.svelte`, `components/ScreenFlip.svelte`, `components/Carousel.svelte` (its clamp unchanged unless centering needs a wrapper), a layout test, `web/packages/launcher/design.md`. Not changed: the desktop's panel sizing (`launcher_panel.rs` fits the panel to the window's content area already), the deck's card components.

## Acceptance

1. A chan-desktop window about 1200 px tall shows the Computers deck centered vertically, with equal space above and below; the same for Gateways after the flip.
2. A window the deck fills (about 900 px or less) is unchanged.
3. `make web-check` green with the new layout test.

## Closing

The owner's launcher work centers the deck (`7be191f7c`, `feat(launcher): center the carousel and add zoom and shift navigation`); the owner chose it on 2026-10-26 over the lane built from this row, whose code does not ship. On the desktop surface `.launcher-surface.deck` in `App.svelte` is a grid one viewport tall with the rows `minmax(4rem, 1fr) minmax(0, auto) minmax(4rem, 1fr)`: the top bar sits at the start of the first row and the content fills the middle one, so a tall window has equal space above and below the deck, with the bulk bar in the lower space. `Carousel.svelte` lowers the floor of `--deck-height` from 22rem to 12rem, so a short window keeps the deck's forms and previews scrolling inside the card. Two points differ from the contract above, by the owner's choice: the deck is centered in the whole window rather than in the content area below the toolbar, and a window the deck fills centers it as well instead of keeping the content's top inset.

The commit carries the deck navigation tests (`Library.deck.test.ts`, `Gateways.deck.test.ts`) and names the owner's WebKit layout checks and macOS build; `make web-check` at that commit is green. No browser measurement of the deck's rectangle was run against this layout; the owner read it in chan-desktop and accepted it.
