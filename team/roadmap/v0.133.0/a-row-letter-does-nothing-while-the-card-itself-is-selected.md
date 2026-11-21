# A row letter does nothing while the card itself is selected

Status: Accepted for v0.133.0 by the owner on 2026-11-21: "the other change id like to make is that from the card selection i want to be able to press o (on/off) to connect/disconnect a devserver, and also press t (terminal) to open a terminal; i'd like to do it from the card selection [screenshot 1] not only from the item selection [screenshot 2]". The first screenshot shows the Computers deck with a connected devserver's card in front and the focus ring around the whole card; the second shows the same card with the focus ring around its header row alone: the devserver's name and address, its windows badge, its New terminal button and its connect and disconnect button.

Record: reported by the owner on 2026-11-21 from his installed release build. Not reproduced by a run before this row; the reading below is from the source.

## What is there now

Read at `042430e89`. Paths are under `web/packages/launcher/src/`.

- `components/Carousel.svelte` handles the deck's keys in `onKey` (`:156-197`). A row letter (`o`, `t`, `w`, `h`) finds its row with `target.closest("[data-deck-row]")` (`:177-178`) and clicks that row's enabled button whose `data-deck-key` is the letter. With the card itself focused (the slot, `:251`, or the page body), no row holds the target, so the letter does nothing.
- `navigateRows` (`:122-154`) lets Enter act from the card: with the slot, the body or the document element as the target (`atCard`, `:130`), Enter activates the first row's default or first enabled control (`:139-147`). The first row is the first `[data-deck-row]` that is not nested in another and has an enabled control (`:125-126`). Up and Down from the card select the first or the last row. Left and Right from the card turn the deck.
- The rows that carry letters: a machine card's header (`components/Library.svelte:623`, `:668`, `:722`), a workspace row (`:383`), a window row (`components/WindowRow.svelte:171`), a tmux connection's hidden-window row (`Library.svelte:323`), a gateway card's header (`components/Gateways.svelte:116`), and the Add card's front (`components/AddCard.svelte:75`). All windows has no header row: its header is plain text, and its rows are its windows (`components/AllWindows.svelte:23-26`).
- A row letter's click leaves focus where it was.

## Desired contract

1. With the card in front selected, the slot itself holding focus, a row letter acts on the row Enter acts on from the card, exactly as it does when that row is focused: the row's enabled button with that `data-deck-key` is clicked. On a machine or gateway card that row is the header, so `o` connects or disconnects a devserver and `t` opens a terminal on it; on All windows it is the first window, and a header with no enabled control gives way to the card's first row that has one. A letter the row has no enabled button for does nothing, even when another row of the card has one.
2. A card is selected while its slot holds focus, whether a click on the card, a turn of the deck with the mouse (a side card, the side buttons, the dots) or the keyboard put it there, and its ring is drawn whenever it does. Decided by the owner on 2026-11-21, asked what a mouse click on a card should do: "Click selects, shows ring (Recommended)", offered as a click on the card selecting it and drawing the green ring, so `o` and `t` always act on something you can see, with the ring also appearing after turning the deck with the mouse. Before this ruling a mouse-focused slot drew no ring, because the ring was `:focus-visible`, and both Blink and WebKit set that state before they dispatch a keydown, so a letter could not tell a card with no ring from one with it.
3. With nothing selected (focus on `body` or the document element, at boot or after a focused row or button leaves the document) a letter does nothing: no ring is drawn there, so it would act on a card the user has not selected, and `o` would disconnect a devserver with nothing on the screen saying which.
4. Enter and the letters share one definition of the row the card stands for. Enter and the arrows keep their behaviour from the page, and Enter or Space on a side button keeps focus on the button.
5. Unchanged: a letter with a row focused acts on that row; the guards (a repeat, an open dialog or confirmation, the command deck's draft, a modifier, a form or text field, a card that is not in front or is inert); a letter with focus in another card or outside the deck does nothing; the click leaves focus where it was, on the card.

## Boundaries

- The key handling, the side buttons and the card's ring in `Carousel.svelte`, its mounted test, the launcher's `design.md` and the manual's Computers and connect pages.
- The key legends under the deck and on the All windows card are not changed here.
- No new letter, no new button.

## Acceptance

1. Browser check 318, over the built launcher served by the check's own backend on the desktop surface: with a connected devserver's card focused itself, `t` asks for a terminal on that devserver, `o` disconnects it and `o` connects it again, and focus stays on the card; `w` and `h` at the card ask for nothing although a workspace row of the card has a `w`; a real mouse click on the card's empty body selects it and paints its ring before `t` and `o` act; the side buttons pressed with the mouse select the new front card, and a letter acts on that card; with nothing focused, no dialog and the surface not inert, no card shows a ring and `t` and `o` ask for nothing. Controls: the same letters with the header row focused; `t` and `o` with a workspace row focused act on that workspace and not on the devserver; a letter with a dialog open, or with focus outside the deck, asks for nothing. Red at `042430e89` on the card legs alone, green at the tip.
2. The desktop driver `scripts/e2e/desktop-observations/card-letters-native.sh` on WebKitGTK, with a real connected devserver and real input through XTEST: a click on the card's empty body selects it and paints its ring, `o` disconnects and connects it, `t` opens a terminal on it, and with nothing focused `o` does nothing. Red at `042430e89` on all but the last, green at the tip.
3. Mounted tests for the card types check 318 does not drive (This machine and All windows), dying to the named mutation that takes the card fallback out, and for a letter with focus on the page or on the deck's Next card button, dying to the mutations that count the page as the card and that send any target in the deck to the card row.
4. `make web-check`, `make web-marketing-check`, `make e2e-check` and `make shell-check` green.
