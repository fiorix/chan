# A shown browser window keeps its hidden overlay

Status: raised on 2026-10-04 by a browser smoke check of the launcher's Show, read in the code and seen in the check's capture on the v0.102.0 integration branch; the owner's ruling is recorded below. On 2026-10-04 the owner accepted the targeted frame and same-record clear for a build in v0.102.0. On 2026-10-04 the page's half was built; the row stays at build for the server's frame, the launcher's design line and browser check 66's leg.

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

## The page's half built, 2026-10-04

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in two ranges the lead accepted on their reports, their status files (every red at its own assertion at a committed sha, every mutation restored by hash, the type check green at each sha and the web gate green at each tip) and an independent review of each whole diff, the first finding one medium, which the second range repaired, and the second nothing above low, its four lows sent to the next range as repairs. The contract, written once for the three halves: the server sends a `window_command` with the command `window_shown` and the record's window id, on the page's own event socket and to the pump serving that id alone, from the host's visibility setter when a hidden record becomes visible and for a change alone; the page clears its hidden cover when the frame names its own window id and its state is hidden; Hide keeps the browser handle, Show keeps its rule for a connected record, Open's rule stays. The page's half: the workspace app accepts the command behind the same own-id check as the other window commands, takes down a hidden cover alone, leaves a discarded page and a visible page as they are, and ignores the command in a native desktop window (`web/packages/workspace-app/src/state/store.svelte.ts`, `state/windowLifecycle.svelte.ts`), pinned red first with three mutations; a cleared page runs the server-instance check it skipped while hidden, so a page hidden across a server restart reloads when it is shown. Cost, recorded: a page whose socket is down when the frame goes out keeps its cover until it is reloaded or reopened, since the server parks nothing for this frame and the page reads nothing of its record on reconnect. Left: the server's frame, the launcher's design line and browser check 66's leg; the changelog entry goes in with the server's frame, since the page's half changes nothing a user sees alone.
