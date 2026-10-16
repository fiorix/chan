# The exit flush skips a change whose save was sent and not answered

Status: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15; the owner decided on 2026-10-16 (see "Owner's decision 2026-10-16"): the snapshot is recorded as saved only when its write is answered, so the exit flush re-sends an unanswered save. Design read before code, not yet built; owner the frontend seat.

Record before the release: raised by the review seat on 2026-10-13 from its read of check 150's release (P2 of `reviews/review-Review106-chk150-release-1.md` in the round's bus); written down the same day by the lead as a row of its own; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

`commitSessionSave` (`web/packages/workspace-app/src/state/store.svelte.ts` 3465 to 3487; the line numbers of this row are the file's at `710527543`, and at the candidate `commitSessionSave` is at 3540, `flushPendingSessionSave` at 3566, `applyRemoteSessionBlob` at 3643 and the exit flush at 3823) records the snapshot as the last one saved before its request is answered (3476 and 3477; the request an ordinary one with no keepalive, `api/client.ts` 1295), and the exit flush (3753 to 3794) compares against that record and sends its keepalive PUT only when they differ. A change saved and the page gone before the answer, a close or a reload within the write's flight (about 20 ms on the team's guest's server), rides on a request the browser cancels with the page: stored and, until the announcement repair landed as `9cd3e7011`, unannounced where the server had started the write (the row `sessann`, 11 legs of 11 in the review's marked runs of check 150 before it; at the candidate that case is stored and announced), or not stored at all where it was cut earlier, and then lost at a reload, which the exit flush exists to prevent (read from the server probe's 0 ms arm, not seen in a browser). Beside a co-viewer the window is easier to meet than the 750 ms debounce suggests: the sync refetch flushes a pending save at once (3568 to 3580).

## Desired contract

A change the page has made reaches the server, by its own save or by the exit flush, whether or not the page is gone before the save's answer.

## What to do

A design choice of the store's owner: record the snapshot as saved when the write is answered, or keep the unanswered write and let the exit flush send again with keepalive while it is open. Design read before code; the pin a store row with the write held and the page unloaded.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` and its tests. Not changed: the server's announcement (the row `sessann`).

## Acceptance

1. The decision recorded here with its reason.
2. If built: the pin red first on its own assertion; `make web-check` green at the commit in the owning guest.

## Owner's decision 2026-10-16

Put to the owner by survey on 2026-10-16 ("Exit flush: a save sent and not answered when the page goes") with four options: record the snapshot as saved only when the write is answered so the exit flush re-sends an unanswered save with keepalive (recommended); keep the unanswered write and let the exit flush send it again; leave it as is and close the row as a recorded cost; delegate the design choice to the frontend seat. The owner's answer, in the survey's words: "Mark saved only when answered; the exit flush re-sends (recommended)". Applied as: `commitSessionSave` records the last saved snapshot when its request is answered, not when it is sent, and the exit flush's comparison therefore sends a keepalive PUT for a change whose save is still in flight; a repeated PUT of the same blob is the accepted cost. Acceptance 1 is met by this section; acceptance 2 stands for the build, with the pin the row names (a store row with the write held and the page unloaded, red first).
