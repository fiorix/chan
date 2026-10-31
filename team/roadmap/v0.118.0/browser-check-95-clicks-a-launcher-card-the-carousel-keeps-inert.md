# Browser check 95 clicks a launcher card the carousel keeps inert

Status: carried into v0.118.0 at the v0.117.0 GA on 2026-10-31 by the owner's word ("Carry all three to v0.118.0 unbuilt"), not started: the check is still red alone at the GA's base and tip.

Record before the release: carried into v0.117.0 at the v0.116.0 GA on 2026-10-30, not started: the check is still red alone at the GA's base and tip (the launcher's carousel keeps the card inert), and no one took the row in the v0.116.0 round.

Record before the release: carried into v0.116.0 at the v0.115.0 GA on 2026-10-29, not started: the owner asked for the GA before it was built, and by the roadmap lifecycle an unbuilt row moves to the next version.

Record before the release: accepted for v0.115.0 by the owner's word of 2026-10-28; not started.

## What was asked

The owner's words of 2026-10-28, after the v0.114.0 GA: "let's add a roadmap item to fix browser check 95".

## Evidence

Read at `3931bf610`. Browser check 95 (`scripts/e2e/browser-smoke/checks/95-launcher-native-trust.mjs`, `launcher-native-trust`) serves the launcher bundle (`web-launcher/dist`) behind a fake backend holding one shared, trust-required devserver `shared-lab`, waits for `[aria-label="Connect shared-lab"]`, clicks it and waits for the "Grant native access?" dialog. It fails before the dialog: "native trust dialog name missing; saw []". Its first screenshot shows the launcher's carousel with All windows in front and the machine cards beside it; the carousel makes side cards inert (`web/packages/launcher/src/components/Carousel.svelte`), so the button the check finds receives no click.

It fails the same way at the GA commit `1d8434419` and at the base `0604056a2` with the launcher bundle built from that commit, so it predates the v0.114.0 launcher changes; the records are in the v0.114.0 archive (`check95-ga/`, `check95-base/`). The v0.114.0 GA ran it alone because the window counter cleanup removed a route stub from its fake backend; it is not a release gate step.

## Desired contract

The check proves what it was written for: Cancel on the native trust dialog mutates nothing, Grant puts trust before connect, and Revoke tears both down, on the launcher as it renders today.

## What to do

- Bring the `shared-lab` card to the front before each click (as a user does with the deck's arrows, the Left and Right keys or `showCard`), or select it by the deck's own controls, then press Connect; keep the request-order assertions as they are.
- Read the rest of the launcher checks for the same shape (a click on a control inside a card that is not in front) and fix any that share it.

## Acceptance

- Check 95 alone green at the fix, and red at the base with the identical failure, so the fix is what turned it green.
- The whole browser suite run at the fix, with any other launcher check the search found green.
