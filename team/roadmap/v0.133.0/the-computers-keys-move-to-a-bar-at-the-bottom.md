# The Computers keys move to a bar at the bottom

Status: Accepted for v0.133.0 by the owner on 2026-11-21 ("there's more changes i'd like to make in the computers screen, before we can proceed.. the change is: 1. we currently have navigation legend "↑ ↓ rows · ← → controls · Enter focuses · h show/hide" in the "All Windows" card, and we shouldn't 2. we also have navigation legend "g screens · o on/off · t terminal · w workspace window · h show/hide" between the cards and carrousel 3. i want to move these 2 legends to its own "status bar" at the very bottom, like we did with the command launcher (cmd+k on mac)").

Record: the owner's words above, on the Computers window of Chan Desktop: the launcher's desktop surface, where both screens deal their cards as a carousel. The command launcher he names is the shared command deck, whose footer sets its keys as keycaps, each followed by what it does.

## What is there now

Read at `042430e89`, by reading; nothing run. Paths are under `web/packages/launcher/src/`.

- The All windows card (`components/AllWindows.svelte:17`) carries `↑ ↓ rows · ← → controls · Enter focuses · h show/hide` as a line under its header, inside the card. The card is the first card of the Computers deck, which `components/Library.svelte:874-895` renders only on the desktop surface (`hasDesktopBridge`); the devserver and read-only surfaces list the machine cards one under another with no All windows card.
- The carousel (`components/Carousel.svelte:285`) carries `g screens · o on/off · t terminal · w workspace window · h show/hide` between the deck's stage and its dots. Both the Computers deck (`Library.svelte`) and the Gateways deck (`components/Gateways.svelte:280-300`) are this carousel, again only on the desktop surface, so the line shows on both screens there and on no other surface. On the Gateways screen only `g` and `o` act: a gateway card's connect button declares `o` (`Gateways.svelte:223`), no gateway control declares `t`, `w` or `h`, and `g` flips the screens (`App.svelte:65-76`, desktop surface only).
- The deck's height is `--deck-height: clamp(12rem, calc(100vh - 11rem), 48rem)` (`Carousel.svelte:310`). The desktop surface is a three-row grid (`App.svelte:295-300`): the top bar in a band of at least 4rem, the deck, and an empty band of at least 4rem under it, the two bands sharing the rest equally so the deck sits in the middle of the window.
- The command deck's footer (`web/packages/web-shared/src/components/CommandDeck.svelte:1223-1245`, styles at `:1580-1622`) is one 30 px line with a top rule: each key a `<kbd>` keycap in a 10.5 px monospace face, followed by a short word, the hints 14 px apart in the secondary text colour at 11 px, clipped at the end when the panel is too narrow. It has no role or label, and nothing in its hints takes focus.
- The marketing site's demo of this window (`LauncherDemo.svelte`) reserves an extra rem under a phone-width deck because the line under the deck wraps there. The manual's Computers page (`web/packages/marketing/src/pages/manual/computers.html`) says the keys are listed by "the line under the cards".

## Desired contract

1. Neither legend renders where it is now: not inside the All windows card, not between the cards and the dots.
2. One key bar sits at the very bottom of the Computers window, the same kind of bar as the command deck's footer: each key as `<kbd>` keycaps followed by what it does, in the footer's type size, colour and spacing.
3. On the Computers screen the bar lists, once each and in the legends' words: `↑ ↓` rows, `← →` controls, `Enter` focuses, `g` screens, `o` on/off, `t` terminal, `w` workspace window, `h` show/hide.
4. On the Gateways screen the bar lists `g` screens and `o` on/off, the two keys of the old line that act there.
5. The bar shows where the legends showed: on the desktop surface only. The devserver and read-only surfaces show no bar.
6. The bar is a passive legend: nothing in it is focusable and it takes no Tab stop, and it carries no role or label, as the deck's footer carries none.
7. The bar covers neither the front card nor the dots at any window height the deck supports, and the page does not scroll. A window too narrow for one line clips the bar's end, as the deck's footer does, and the page does not scroll sideways.
8. Nothing else changes: the cards, the deck and its dots, the arrows, the keys, focus and the accessibility tree of the cards.

## Boundaries

- `AllWindows.svelte`, `Carousel.svelte`, `App.svelte`, a new launcher component for the bar, the demo's phone-width rule in `LauncherDemo.svelte`, the launcher's design notes, and the manual's Computers page.
- Not the command deck. Its footer's keycap rule also sets the keycaps of its row shortcuts and its keys sheet, and the width of its shortcut column is counted in that face, so the launcher sets the same values in its own bar rather than splitting the deck's rule.
- Not the keys themselves, which card declares which letter, or the select mode's bulk bar, which docks over the bottom of the window while select mode is on.

## Acceptance

1. A browser check, `scripts/e2e/browser-smoke/checks/317-computers-key-bar.mjs`, over a devserver page whose surface is rewritten to the desktop's, reads the rendered page: no legend inside the All windows card and no text in the carousel outside its stage; one bar holding the Computers keys once each as `kbd` keycaps with their words; the bar's top edge at or below the dots' and the front card's bottom edges and its bottom edge at the window's; nothing in the bar focusable; no page scroll at three window heights and none sideways at a phone width. It flips to the Gateways screen and reads the bar's two keys there, and reads no bar on the devserver surface.
2. The check is red at `042430e89` on the moved legends and the missing bar, and green at the tip. A page that never loads its deck fails as a precondition, in words distinct from the red.
3. No unit test: the browser check reaches every behaviour the row changes.
