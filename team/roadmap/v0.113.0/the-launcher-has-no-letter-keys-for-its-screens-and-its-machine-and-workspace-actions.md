# The launcher has no letter keys for its screens and its machine and workspace actions

Status: raised on 2026-10-27 by the owner after the v0.112.0 GA; awaiting acceptance for v0.113.0.

## What was asked

The owner's words of 2026-10-27, in four messages: "new feature: the ability to use certain keys in the computers window to drive navigation: 1. while navigating anywhere, except from editing a form or window's title: pressing c or g should toggle between computers and gateways 2. while on a local machine or devserver badge: c toggles the connect / disconnect, t opens a new terminal, w opens a workspace window but only when the selected item is a workspace"; "the 'all windows' items should not respond to t, or w, or c"; and, settling the two meanings of `c`: "i think c to show computers wont work, i want c to connect/disconnect devservers and gateways.. we stick to g for toggling computers and gateways"; and "lets use h to toggle show/hide of the selected terminal or workspace window".

Read at `3a65b21cc`, paths under `web/packages/launcher/src/`:

- No letter key is bound anywhere in the launcher. The screens flip through `showScreen` and `toggleScreen` in `state/screen.svelte.ts` (lines 19 and 26), reached today from the top bar's toggle.
- On chan-desktop the decks' keys live in `components/Carousel.svelte`'s `onKey` (line 137): Up and Down select `[data-deck-row]` rows, Left and Right walk a row's enabled controls and turn the deck at its edges, Enter runs a row's default control, Shift+Left and Shift+Right turn the deck, and `ownsArrows` (line 85) leaves text fields, selects and editable content their own keys. Escape returns to the host pane from `App.svelte`'s `onEscape` (line 51) unless a form, dialog, inline editor or the command launcher takes it first.
- The actions the letters name already exist as buttons. In `components/Library.svelte`: This machine's header has New local terminal (line 508) and New local workspace, and no connection to toggle; a devserver's header has New terminal while connected (line 561), and Disconnect (line 599) or Connect (line 626), the latter disabled while a dead control terminal is still open, and a spinner while an operation runs; a workspace row has "New window of" (line 334), disabled until the workspace is ready and when the session leader manages its windows. In `components/Gateways.svelte`, a gateway's header has one connection control on chan-desktop (line 148): Connect, Disconnect, Cancel connection while a connection is under way, or Disconnect lost connection, with a guard against a held Enter pressing it again. In `components/WindowRow.svelte`, every window row on chan-desktop, a terminal, a workspace window or a control terminal, in a machine card or in the All windows card, has Focus window (its default) and a Show window or Hide window toggle (line 182), which the All windows card wraps in its own row.

## Desired contract

On the launcher's Computers and Gateways screens, outside text entry (a form's field, a window's title being edited, the command launcher's search, any other input, select or editable content), with no modifier and no dialog or command launcher open:

- `g` toggles between Computers and Gateways, through the same flip the top bar's toggle plays. No other letter changes the screen.
- `c` with a devserver's header or a gateway's header selected presses that row's connection control: it connects when disconnected and disconnects when connected, and while a gateway connection is under way it cancels it, as the button does. With any other row selected, This machine's header included, `c` does nothing.
- `t` with This machine's or a devserver's header selected opens a new terminal on that machine.
- `w` with a workspace row selected opens a new window of that workspace.
- `h` with a window row selected, a terminal, a workspace window or a control terminal, in a machine card or in the All windows card, shows the window when hidden and hides it when shown, pressing the row's own Show window or Hide window toggle. With any other row selected, `h` does nothing.
- A row of the All windows card does not respond to `t`, `w` or `c`, whatever window it lists; `g` still toggles the screens from it, as from anywhere else, and `h` shows or hides its window, as on the window's row in its machine card.
- Each letter presses the same button a click would, so the action's conditions, states, errors and confirmations are the button's own, and a key whose button is absent or disabled does nothing. A held key acts once. Shift and the letter's case do not change its meaning; Cmd, Ctrl and Alt combinations stay with the system and the page.
- The keys are discoverable: the deck's hint line and the buttons' titles name them, and the launcher's design document and the manual's launcher page list them.

## What to do

1. Tests first, red: in the deck tests (`components/Library.deck.test.ts`, `components/Gateways.deck.test.ts`), `g` toggles the screens both ways from the page and from a row, and not from a form field, the window-title editor or with a modifier; `c` on a devserver header runs Connect or Disconnect, on a gateway header runs Connect, Disconnect or Cancel, and nothing while the button is disabled or on This machine, a workspace row or an All windows row; `t` on This machine's and a connected devserver's header runs New terminal; `w` on a ready workspace row runs New window and nothing on a disabled one or another row; `t`, `w` and `c` on an All windows row do nothing; `h` on a window row in a machine card and on an All windows row runs its Show or Hide toggle, and on a workspace row or a header does nothing; a repeated keydown acts once; one mutant per guard.
2. One mechanism rather than a key per button: each row's button declares its letter (a data attribute beside `data-deck-default`), and the carousel's key handler presses the enabled button of the selected row that declares the key, after the same text-entry and modifier checks `ownsArrows` and the Shift-turn path use. The window row's Show or Hide toggle declares `h`; the All windows card's rows declare no other letter. `g` sits in the same handler, or in `App.svelte` beside `onEscape` if the browser launcher, which has no carousel, should take it too.
3. The hint line, the buttons' titles, the design document's "The decks" section and the manual's launcher page.

## Boundaries

`components/Carousel.svelte`, `components/Library.svelte` (the header and workspace-row buttons), `components/Gateways.svelte` (the header's connection control), `components/WindowRow.svelte` (the Show or Hide toggle), `components/AllWindows.svelte` for its hint line, `App.svelte` if `g` sits there, their tests, the launcher's `design.md` and the manual's launcher page. Not changed: what the buttons do, the arrow and Enter navigation, the gateway control's held-Enter guard.

## Acceptance

1. In chan-desktop, `g` on Computers shows Gateways and `g` there shows Computers again, and `g` does nothing while typing in a form or editing a window's title.
2. With a devserver's header selected, `c` connects or disconnects it and `t` opens a terminal on it when connected; with a gateway's header selected, `c` connects or disconnects the gateway; with This machine's header selected, `t` opens a local terminal; with a ready workspace row selected, `w` opens a new window of it; with a window row selected, in a machine card or in the All windows card, `h` hides the window when shown and shows it when hidden; with an All windows row selected, `t`, `w` and `c` do nothing.
3. The tests above red first and green after; `make web-check` green.
