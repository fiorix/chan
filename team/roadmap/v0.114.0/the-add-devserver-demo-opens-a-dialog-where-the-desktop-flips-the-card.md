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
