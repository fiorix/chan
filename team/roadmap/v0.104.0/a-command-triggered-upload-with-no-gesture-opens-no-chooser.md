# A command-triggered upload with no gesture opens no chooser and says so only in the console

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; a product answer to design against the paste request card before it is built, reviewed as a design first.

## What was seen

Review-born at the v0.103.0 cut ([check-62-asks-for-a-file-chooser-without-a-user-gesture](../done/check-62-asks-for-a-file-chooser-without-a-user-gesture.md): a command-driven upload with no recent gesture exposes a separate product question): an upload asked for by a command when the page has no recent user activation opens no file chooser, and the page says so only in its console (`File chooser dialog can only be shown with a user activation`); the terminal tab's user and the transfer panel's user see nothing. The browser check that met it (check 62) was repaired to supply the gesture; the product's answer to a command without one is undesigned. The paste path already has a request card whose click carries the activation: `web/packages/workspace-app/src/components/RequestCard.svelte` and `src/state/pasteRequest.svelte.ts`, the nearest existing pattern.

## Desired contract

An upload requested by a command with no recent gesture is shown to the user as a request they can act on with one click that carries the activation, in the terminal tab and in the transfer panel, and the console line is no longer the only sign; a command issued within a gesture still opens the chooser at once.

## What to do

Design first: read the paste request card as the pattern and write what the terminal tab's and the transfer panel's users see, how the click carries the activation to the chooser, what happens to a request that is never clicked, and the tests; the reviewer reads the design before any code. Then build it red first: a unit pin that a command without activation produces a visible request and no chooser attempt, and a browser check that clicks the request and sees the chooser.

## Boundaries

`web/packages/workspace-app/src/state/transfers.svelte.ts`, `src/state/pasteRequest.svelte.ts`, `src/components/RequestCard.svelte`, the transfer panel and `TerminalTab.svelte` where the request is shown, and `scripts/e2e/browser-smoke/` for the check. The check 62 repair stays; the upload, streaming and coalescing paths are unchanged.

## Acceptance

1. The design reviewed before code, naming the two surfaces, the click's activation path and the unclicked request's end.
2. A command without a recent gesture shows the request in the terminal tab and the transfer panel and attempts no chooser; pinned red first.
3. Clicking the request opens the chooser, and the upload proceeds as a gesture-driven one would; shown in a browser check.
4. A command within a gesture opens the chooser at once, unchanged; pinned.
5. `make web-check` green at the commit in the owning guest.
