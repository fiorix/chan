# A command-triggered upload with no gesture opens no chooser and says so only in the console

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; the owner chose the picker-first form on 2026-10-08 after the design and its review, and the design's next revision is reviewed before code.

## What was seen

Review-born at the v0.103.0 cut ([check-62-asks-for-a-file-chooser-without-a-user-gesture](../done/check-62-asks-for-a-file-chooser-without-a-user-gesture.md): a command-driven upload with no recent gesture exposes a separate product question): an upload asked for by a command when the page has no recent user activation opens no file chooser, and the page says so only in its console (`File chooser dialog can only be shown with a user activation`); the terminal tab's user and the transfer panel's user see nothing. The browser check that met it (check 62) was repaired to supply the gesture; the product's answer to a command without one is undesigned. The paste path already has a request card whose click carries the activation: `web/packages/workspace-app/src/components/RequestCard.svelte` and `src/state/pasteRequest.svelte.ts`, the nearest existing pattern. The reviewer measured the one question the design turned on, in headless Chrome for Testing 155 in its guest (`dev/v0104-team/evidence/Review104/activation-probe-01`): `navigator.userActivation.isActive`, read in the same task as a programmatic file-input click, agreed with the chooser in three arms (no gesture: false and no chooser; a key press 1.0 s before: true and the chooser opened; a key press 6.5 s before: false and no chooser). A refusal cannot be detected after the click, but the page can know before it, so a picker-first form is sound beside the unconditional request; the reading is Chrome's alone.

## Owner decision, 2026-10-08

Picker-first: the chooser opens at once when the page reports a live user activation, and a Choose-files request card otherwise. Chosen by survey from three options (picker-first, recommended by the reviewer and the lead; an unconditional request card for every browser `cs upload`; no change this version); the text and answer are `dev/v0104-team/evidence/Lead104/surveys/item5-click.*`.

## Desired contract

An upload requested by a command opens the chooser at once when the page reports a live user activation; otherwise it is shown as a request in the window (a card, as the paste request has) and in the Transfers panel, which opens the chooser on one click that carries the activation, and the console line is no longer the only sign. The request has an end: a newer command replaces it, or it expires, or requests queue, and a refused or replaced command is told persistently, not in a fading status. The native desktop and the Files app's own Upload keep their immediate pickers.

## What to do

Design first: read the paste request card as the pattern and write what the terminal tab's and the transfer panel's users see, how the click carries the activation to the chooser, what happens to a request that is never clicked, and the tests; the reviewer reads the design before any code. Then build it red first: a unit pin that a command without activation produces a visible request and no chooser attempt, and a browser check that clicks the request and sees the chooser.

## Boundaries

In `web/packages/workspace-app/src/`: `state/store.svelte.ts` and its test, `App.svelte`, `components/AppStatusBar.svelte`, `components/TransferBubble.svelte` and its test, `components/RequestCard.svelte` and its test (an optional focus-management prop, default unchanged), the new `state/uploadRequest.svelte.ts` and `components/UploadRequestBubble.svelte` with their tests, and the transfer section of `design.md`; `scripts/e2e/browser-smoke/checks/62-binary-transfer-streaming.mjs` and one new focused check; the two `cs upload` help constants in `crates/chan-shell/src/help.rs`, prose only. `TerminalTab.svelte` is not touched: the request is window-scoped, as the paste request is. The check 62 gesture repair stays; the upload, streaming and coalescing paths are unchanged.

## Acceptance

1. The design's next revision, reviewed before code, answers the reviewer's four findings: the unclicked request's end and what a later command meets; where the upload card sits beside a paste or handover card and which one the keys act on; which surface takes the keyboard with the Transfers panel shown and hidden at the moment the command arrives; the `cs upload` help corrected in the same change, with the `chan-shell` crate's fmt, clippy and whole suite beside `make web-check`.
2. A command without a live activation shows the request in the window and in the Transfers panel and attempts no chooser; pinned red first.
3. Clicking the request opens the chooser, and the upload proceeds as a gesture-driven one would; shown in a browser check with the activation's absence established from the browser, not from a guessed sleep.
4. A command within a live activation opens the chooser at once, unchanged; pinned, and shown in the browser check beside point 3.
5. Two requests live (an upload request beside a paste card) are both reachable and the keys act on the one that shows focus; pinned in a mounted test.
6. `make web-check` and the `chan-shell` suite green at the commit in the owning guest; the affected browser checks green alone.
