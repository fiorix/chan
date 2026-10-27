# The Add devserver demo opens a dialog where the desktop flips the card

Status: accepted for v0.114.0 by the owner's word of 2026-10-27; decided, not built.

## What was asked

Found while widening the manual's live launcher mocks on 2026-10-27; the owner asked for it to be saved for later.

## Evidence

Read at `0119a1912`. On the desktop, the Computers screen's last card is Add devserver, and clicking it flips the card to the form (`web/packages/launcher/src/components/AddCard.svelte`, `DevserverForm.svelte`). The manual's devserver demo (`/manual/demo/devserver/`) mounts `LauncherDemo` with `variant: "devserver"`, which calls `openNewDialog("devserver")` and shows the form as a modal dialog over the deck (`web/packages/launcher/src/LauncherDemo.svelte`). The fields and the Add devserver button match, so the manual's steps read correctly, but the picture is not what the desktop shows.

## Owner decision (2026-10-27)

"dsdemo: the mock should match the card flip, of course".

## What to do

Make the devserver demo open with the Add devserver card in front and flipped to its form, the way the desktop does, instead of the dialog.

## Acceptance

- The demo at `/manual/devserver/` opens on the flipped Add devserver card; Cancel flips it back; adding a devserver brings its card to the front.
- Launcher vitest green; a headless Chrome screenshot of the page at 1280 and 390 px.

## Build findings and evidence (2026-10-27)

Change: the deck state gains `openForm` and `showAddForm(deck, key)` (`web/packages/launcher/src/state/deck.svelte.ts`), which brings the Add card to the front and asks it to turn over. `AddCard.svelte` watches the flag, clears it, and plays the same flip a press does, without moving focus (the demo opens inside a page the reader is scrolling, so taking focus could scroll the page). `LauncherDemo.svelte` calls `showAddForm("computers", "add-devserver")` for the `devserver` variant instead of `openNewDialog("devserver")`. Cancel, Escape and a save keep the card's own behaviour: Cancel turns it back to the Add devserver button, and a save turns it back and brings the new devserver's card to the front. `Library.svelte` and `CommandLauncher.svelte` are untouched. The page caption in `web/packages/marketing/src/pages/manual/devserver.html` now reads "The Add devserver card, turned over to its form."; the numbered steps already described the card and needed no change.

Tests: `LauncherDemo.test.ts` replaces the dialog-start test with one that checks the demo opens with `add-devserver` in front showing the form, no `[role=dialog]`, focus left on the reader's element, Cancel turning back and the button turning over again; a second test fills Name and Address, presses Add devserver and checks the front card becomes `demo-box`. The inert test now opens the New workspace dialog from This machine. Mutation check: with the demo calling `showCard` instead of `showAddForm`, three tests go red.

Commands and results:

- `npx vitest run` in `web/packages/launcher`: 65 files, 705 tests passed.
- `npx svelte-check --tsconfig ./tsconfig.json`: 0 errors, 0 warnings.
- `npm run check` in `web/packages/marketing`: exit 0 (built dist, smoked routes).
- Headless Chrome over CDP against `dist/` served on loopback, `/manual/devserver/` at 1280x1100, 1280x2400 and 390x2400: the front slot is `add-devserver` showing the form, inside the frame, the card's scrollHeight equals its clientHeight (596/596 at 1280, 620/620 at 390), and nothing in the iframe holds focus. After Cancel the front card shows the Add devserver button and focus is on it. Plain `google-chrome-stable --headless=new --screenshot` shots of the page at the same sizes were also taken.

Left open: the flip animation plays once on load, as on a press; it is not skipped for the first paint.
