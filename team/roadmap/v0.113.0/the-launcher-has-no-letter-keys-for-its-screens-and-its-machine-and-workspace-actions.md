# The launcher has no letter keys for its screens and its machine and workspace actions

Status: raised on 2026-10-27 by the owner after the v0.112.0 GA; awaiting acceptance for v0.113.0.

## What was asked

The owner's words of 2026-10-27: "new feature: the ability to use certain keys in the computers window to drive navigation: 1. while navigating anywhere, except from editing a form or window's title: pressing c or g should toggle between computers and gateways 2. while on a local machine or devserver badge: c toggles the connect / disconnect, t opens a new terminal, w opens a workspace window but only when the selected item is a workspace", and in a second message the same day: "the 'all windows' items should not respond to t, or w, or c".

Read at `f3e93e190`, paths under `web/packages/launcher/src/`:

- No letter key is bound anywhere in the launcher. The screens flip through `showScreen` and `toggleScreen` in `state/screen.svelte.ts` (lines 19 and 26), reached today from the top bar's toggle.
- On chan-desktop the decks' keys live in `components/Carousel.svelte`'s `onKey` (line 137): Up and Down select `[data-deck-row]` rows, Left and Right walk a row's enabled controls and turn the deck at its edges, Enter runs a row's default control, Shift+Left and Shift+Right turn the deck, and `ownsArrows` (line 85) leaves text fields, selects and editable content their own keys. Escape returns to the host pane from `App.svelte`'s `onEscape` (line 51) unless a form, dialog, inline editor or the command launcher takes it first.
- The actions the letters name already exist as buttons in `components/Library.svelte`: This machine's header has New local terminal (line 508) and New local workspace, and no connection to toggle; a devserver's header has New terminal while connected (line 561), and Disconnect (line 599) or Connect (line 626), the latter disabled while a dead control terminal is still open, and a spinner while an operation runs; a workspace row has "New window of" (line 334), disabled until the workspace is ready and when the session leader manages its windows.

Reading of the two rules, for the owner to confirm or change: `c` is both "toggle between computers and gateways" and, on a devserver header, "toggles the connect / disconnect". The lead's proposal keeps both without a conflict: `c` shows Computers and `g` shows Gateways from anywhere, and on Computers, where `c` would change nothing, `c` on a devserver header toggles that devserver's connection. The other reading, either key swapping the screens, would make `c` on a devserver header ambiguous.

## Desired contract

On the launcher's Computers and Gateways screens, outside text entry (a form's field, a window's title being edited, the command launcher's search, any other input, select or editable content), with no modifier and no dialog or command launcher open:

- `c` shows Computers and `g` shows Gateways, through the same flip the top bar's toggle plays.
- With a This machine or devserver header row selected, `t` opens a new terminal on that machine, and `c` on a devserver header connects it when disconnected and disconnects it when connected. A key whose button is absent or disabled does nothing (no terminal on a disconnected devserver, no connect while its control terminal is open or an operation runs).
- With a workspace row selected, `w` opens a new window of that workspace, under the same conditions as its button.
- A row of the All windows card does not respond to `t`, `w` or `c`, whatever window it lists; `g` still shows Gateways from it, as from anywhere else.
- Each letter presses the same button a click would, so the action's states, errors and confirmations are the button's own. Shift and the letter's case do not change its meaning; Cmd, Ctrl and Alt combinations stay with the system and the page.
- The keys are discoverable: the deck's hint line and the buttons' titles name them, and the launcher's design document and the manual's launcher page list them.

## What to do

1. Settle the reading of `c` above with the owner and record it here.
2. Tests first, red: in the deck tests (`components/Library.deck.test.ts`, `components/Gateways.deck.test.ts`), `c` and `g` flip the screens from the page and from a row, and not from a form field, the window-title editor or with a modifier; `t` on This machine's and a connected devserver's header runs New terminal; `c` on a devserver header runs Connect or Disconnect and nothing while its button is disabled; `w` on a ready workspace row runs New window and nothing on a disabled one or another row; `t`, `w` and `c` on an All windows row do nothing; one mutant per guard.
3. One mechanism rather than a key per button: each row's button declares its letter (a data attribute beside `data-deck-default`), and the carousel's key handler presses the enabled button of the selected row that declares the key, after the same text-entry and modifier checks `ownsArrows` and the Shift-turn path use. The screen keys sit in the same handler, or in `App.svelte` beside `onEscape` if the browser launcher, which has no carousel, should take them too.
4. The hint line, the buttons' titles, the design document's "The decks" section and the manual's launcher page.

## Boundaries

`components/Carousel.svelte`, `components/Library.svelte` (the header and workspace-row buttons), `components/AllWindows.svelte` for its hint line, `App.svelte` if the screen keys sit there, `state/screen.svelte.ts` only if the flip needs a new entry point, their tests, the launcher's `design.md` and the manual's launcher page. Not changed: what the buttons do, the arrow and Enter navigation, the Gateways cards' own actions.

## Acceptance

1. In chan-desktop, pressing `g` on Computers shows Gateways and `c` there shows Computers again, and neither does anything while typing in a form or editing a window's title.
2. With This machine's header selected, `t` opens a local terminal; with a devserver's header selected, `c` connects or disconnects it and `t` opens a terminal on it when connected; with a ready workspace row selected, `w` opens a new window of it; with an All windows row selected, `t`, `w` and `c` do nothing.
3. The tests above red first and green after; `make web-check` green.
