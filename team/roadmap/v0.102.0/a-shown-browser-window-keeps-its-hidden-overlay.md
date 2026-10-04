# A shown browser window keeps its hidden overlay

Status: raised on 2026-10-04 by a browser smoke check of the launcher's Show, read in the code and seen in the check's capture on the v0.102.0 integration branch; the owner's ruling is recorded below. On 2026-10-04 the owner accepted the targeted frame and same-record clear for a build in v0.102.0.

## Owner ruling

On 2026-10-04 the owner accepted shape (a) for a build in v0.102.0: the server sends a targeted frame to the held page when its record becomes visible, the page clears the hidden overlay for that record alone, and the launcher's design states what Show does for a held browser window. Check 66's Hide and Show leg is the browser proof.

## What was seen

A browser window hidden by the session leader and then shown again from the launcher stays covered. The page handles the `window_hidden` frame by marking itself hidden (`web/packages/workspace-app/src/state/store.svelte.ts:1814-1820`, `web/packages/workspace-app/src/state/windowLifecycle.svelte.ts:16-27`, which sets the ended state and has no live reset), and its overlay tells the user to reopen from the launcher (`web/packages/workspace-app/src/components/SessionEndedOverlay.svelte:26-33`). The launcher's Show does not reacquire a connected browser record, by the documented rule (`web/packages/launcher/src/state/computerActions.ts:139-146`), so the record becomes visible, the launcher opens no replacement page, and the page that still holds the record keeps the overlay. The check that found it recorded the overlay after Show while the popup, its URL, marker and holder survived.

## Desired contract

After Show, the page that holds the window's record shows the window again, without a reload and without a second page, and no overlay tells the user to reopen it.

## What to do

The server sends a targeted frame to the held page when its record becomes visible, and the page clears the hidden overlay only for that same record. Hide keeps the browser handle and Show keeps its rule for connected records. The other shapes considered were detaching the handle on Hide or reacquiring a connected record on Show.

## Boundaries

The page's window lifecycle and overlay, the server's window frames, the launcher's Show, by the shape chosen; no change to Open's rule.

## Acceptance

1. Hide then Show of a connected browser window leaves the same page showing the window with no overlay; pinned in the page's suite for the shape chosen and shown by browser smoke check 66's leg, which records the overlay today.
2. The launcher's design states what Show does for a held browser window.
