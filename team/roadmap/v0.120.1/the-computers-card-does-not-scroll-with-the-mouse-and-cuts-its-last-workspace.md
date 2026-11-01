# The Computers card does not scroll with the mouse and cuts its last workspace

Status: raised by the owner on 2026-11-01, accepted for v0.120.1 the same day, built; the patch cut closes it.

## What was asked

The owner's observation, 2026-11-01, in chan-desktop on macOS (WKWebView): a devserver card on the Computers screen holding more workspaces than the deck's height shows cannot be scrolled with the mouse wheel or the trackpad. Keyboard navigation (Up and Down) scrolls it, a scrollbar appears and it reaches the last row, but at the end of the range the last row touches the card's bottom border with no margin, and before any scrolling it is cut at the card's edge.

## What is there

Read at `c43b29433` (the v0.120.0 GA):

- `web/packages/launcher/src/components/Carousel.svelte`: the stage clips (`overflow: hidden; overflow: clip; perspective: 2000px`); the `.ring` is `transform-style: preserve-3d` and carries the turn, `translateZ(-radius) rotateY(-position * step)`, with the 600ms transition; each `.slot` carries `rotateY(index * step) translateZ(radius)`; the card in the front slot is the scroller (`.slot-body > :global(.card) { height: 100%; overflow-y: auto }`); keyboard selection calls `scrollIntoView({ block: "nearest" })` on the row (`focusRowTarget`).
- No wheel, `touch-action` or `overscroll-behavior` handling anywhere in `web/packages/launcher` or `web/packages/web-shared`; nothing in chan consumes the wheel.
- The scroller's only bottom padding is the generic `.content .card` rule's `0.7rem` (`web/packages/launcher/src/styles.css`); under the last workspace row sit `.ws-card`'s `0.4rem` margin and 1px border (`Library.svelte`). No `scroll-padding` or `scroll-margin` anywhere, so `scrollIntoView` parks a selected row's bottom edge on the scrollport's padding edge, which is the border.
- The deck exists only on the desktop surface (`hasDesktopBridge` in `state/capabilities.ts`, read from the `chan-launcher-surface` meta): a `chan devserver run` page lists the machine cards flat, and only chan-desktop's embedded server installs a bridge (`desktop/src-tauri/src/embedded.rs`), so a browser reading of the deck has to answer the launcher document with its surface meta rewritten to `desktop`.
- The machine card is `section.card.machine` in `Library.svelte`; its rows are `[data-deck-row]`, the workspace rows `.ws-head`.
- `scripts/e2e/browser-smoke/lib/carousel.mjs` waited for a turn to finish by reading the ring's animations.

## What changed

- Each slot carries the whole turn itself, `translateZ(-radius) rotateY((index - position) * step) translateZ(radius)`, with the 600ms transition on the slot; the ring keeps `preserve-3d` and no transform. The slot in front therefore stands on the identity transform, and its card renders where it did, at its natural size, on a flat layer. WebKit takes no wheel scrolling in an overflow box inside a layer pushed out along Z (the reading below), though it takes clicks and keys there; the ring's own 3D transform and the stage's perspective do not block it.
- The scroller rule gains `padding-bottom: var(--card-end-gap)` and `scroll-padding-block-end: var(--card-end-gap)`, with `--card-end-gap: 0.75rem` on the carousel: the wheel's end of range leaves the last row that padding, plus the row's own margin, above the border, and `scrollIntoView` parks a row the keys select above the padding instead of on the border.
- `lib/carousel.mjs` settles on the ring's and its slots' animations, since the turn runs on the slots; `spawnDevserver` in `lib/launcher-devserver.mjs` takes extra devserver arguments, so a check can pass `--no-tunnel`.
- Tests: `Carousel.scroll.test.ts` pins that the scroller's bottom padding and its end scroll padding are one length (a source pin, since jsdom lays out nothing; listed in `.agents/skills/webdev/SKILL.md`); `Library.deck.test.ts` gains a mounted geometry test (the front slot on the identity transform, the ring untransformed, the neighbours one step either side on the same radius); the `lib/carousel.test.mjs` fixture runs the turn on the slots; the browser check `197-launcher-card-scroll.mjs` wheels and keys a twelve-workspace card.
- The carousel paragraph of `web/packages/launcher/design.md` describes the new shape.

## How it was read

Setup: a debug `chan` from this tree, a private `CHAN_HOME` with twelve throwaway workspaces registered through `chan workspace add`, `chan devserver run --port 0 --no-tunnel`, and the launcher document's surface meta rewritten to `desktop` (Chrome through request interception, WebKit through a document-start user script). Viewport 1600x1000, so the deck's stage is 48rem and the card's scroller 742px tall (`clientHeight`) over 14 rows: the machine header, the launcher's own window row and twelve workspace rows.

Chrome 126 (puppeteer, real `mouse.wheel` over the list) at `c43b29433`: `scrollHeight` 880; three wheel notches took `scrollTop` from 0 to 138, the end of the range, and the deck stayed on This machine; at rest the last row's bottom lay 119.6px below the card's inner bottom (cut); at the wheel's end it lay 18.4px above it; after ArrowDown down to the last row, `scrollTop` 119.5 and the row's bottom 0.14px below the inner bottom, flush on the border.

WebKit (a Swift AppKit harness: one `WKWebView` in a borderless window, `CGEvent` scroll wheels built at the list's position and delivered through `webView.scrollWheel(with:)`; a control page's plain overflow box scrolled 0 to 600 under five three-line notches and 0 to 385 under a phased trackpad gesture with momentum, so the delivery does move a scroller) at `c43b29433`: `scrollHeight` 886; five mouse notches left `scrollTop` at 0, the trackpad gesture left it at 0; ArrowDown to the last row gave `scrollTop` 125 with the row's bottom 0.43px below the inner bottom. Bisection with injected stylesheets: `.ring { transform-style: flat }` and `.stage { perspective: none }` changed nothing; `.slot.active { transform: none }`, `translateZ(0)`, `translateX(0)` and `rotateY(0deg)` each let the wheel scroll to the end of the range; `translateZ(600px)` blocked it again; `.ring { transform: none } .slot.active { transform: none }` scrolled 0 to 144 at the same box as the base, 18.6px under the last row. The Z push on the slot is the trigger. `CGEvent.post` through the window server was not needed, since the direct delivery hit-tests the list.

At the tip, Chrome: three notches 0 to 139 (the range), the deck unturned, 19.4px under the last row at the end; ArrowDown to the last row parks it 11.9px above the inner bottom. WebKit: five notches 0 to 145 (the range), the trackpad gesture 145, 19.6px under the last row; ArrowDown parks it 11.6px above.

Tests red at the base: `the scroller has a bottom padding: expected undefined to be defined`; `expected 'translateZ(-308px) rotateY(-60deg)' to be ''` (the ring carried the turn); the helper test `the pointer cannot act while the ring moves`, with the fixture's turn on the slots. Green at the tip: the two launcher files' 27 tests and the helper's 7.

Mutations, each restored and the restore verified by hash: `padding-bottom` removed, red (`the scroller has a bottom padding`); `scroll-padding-block-end` removed, red (`the scroller has an end scroll padding`); the scroll padding set to `0.5rem`, red (`expected '0.5rem' to be 'var(--card-end-gap)'`); the turn put back on the ring and the push on the slot, the geometry test red (`expected 'translateZ(-308px) rotateY(-60deg)' to be ''`) and the WebKit reading showed the fault again: five notches and the trackpad gesture both left `scrollTop` at 0 while the keys, with the padding half still in place, parked the last row 11.6px above the border; restored and rebuilt, the reading scrolled 0 to 145 again. The Chrome check cannot see that last mutation, which Chrome scrolls either way; the WebKit harness is its only reading.

Browser check `197-launcher-card-scroll` (its own devserver over a seeded `CHAN_HOME`): at the base it failed on the keyboard leg, `the last row ends 0.15px below the card's inner bottom ... (scrollTop 119.5 of 138)`, while its wheel leg passed, since Chrome scrolls the base card; at the tip it passed twice alone (`SMOKE_ONLY=197`, `SMOKE_SKIP_BUILD=1`), both runs reading a 139px range, the wheel ending at 139 with 19.35px under the last row and the keys at 131.5 with 11.85px.

Pending: the owner's reading in chan-desktop on macOS, Computers screen, a card with more workspaces than the deck shows: the wheel and the trackpad over the list scroll it and leave the deck in place; the arrows, the dots, the keys and a click on a side card still turn it; the last row ends clear of the border at the end of the range and after Down selects it.
